/**
 * 汽车之家创作者平台适配器
 *
 * 平台资料：
 * - 创作者后台：https://creator.autohome.com.cn/
 * - BBS 发布页：https://creator.autohome.com.cn/web/publish/bbs
 *
 * 实现思路（基于完整抓包 creator.autohome-all.com.cn.har 真实接口）：
 *
 * 鉴权：
 *   GET https://creator.autohome.com.cn/openapi/ypttd/yjc/csc/creator/creatorinfo
 *   - returncode === 0 视为已登录
 *   - result.userid / result.nickname 直接返回给 UI 展示
 *   - 完全依赖浏览器 cookie，无 token / csrf / Authorization 头
 *
 * 图片上传（multipart/form-data）：
 *   POST https://club-open-api.autohome.com.cn/upload/uploadMultiClubImg?_appid=club&t={ts}
 *     Headers:
 *       Origin: https://creator.autohome.com.cn
 *       Referer: https://creator.autohome.com.cn/
 *       x-requested-with: XMLHttpRequest
 *     Fields:
 *       biztype: 1
 *       file: <binary image>
 *     Response: { returncode, message, result: [{ code, fileName, url, width, height }] }
 *
 * 发布接口（application/json）：
 *   POST https://creator.autohome.com.cn/openapi/content-api/gc/article/publish?t={ts}
 *     Headers:
 *       Origin: https://creator.autohome.com.cn
 *       Referer: https://creator.autohome.com.cn/web/publish/bbs
 *     Body（基于抓包样本）：
 *       ⚠️ 首次创建时不传 draftId 字段（或为 0），后端自动创建并返回 draftId
 *       ⚠️ 后续保存同一草稿时传 draftId，后端视为更新
 *       title: 标题
 *       suggestTitle: ""                      // AI 纠错提示 HTML，本适配器留空
 *       content: <完整 HTML，编辑器实际渲染>
 *       contentJson: "<JSON 字符串>"          // Lexical 编辑器状态（双层 JSON.stringify）
 *       contentLength: <纯文本字符数>
 *       contentImagesLength: <图片数量>
 *       club: {}
 *       multibbs: ""
 *       statementCheck: false                 // 抓包样本为 false
 *       publishType: 0                        // 0=草稿
 *       declarationLabel: ""                  // 原 markdown 不含「作品声明」时填 "1"（勾选默认声明）；含则留空
 *       extJson: "<JSON 字符串>"              // 模板相关，可填默认值
 *       role: 1
 *       infoType: 8                           // 抓包样本对应 BBS 类型
 *       source: "pc"
 *     Response: { returncode, message, result: { draftId, previewId, ... } }
 *     ⚠️ returncode === 0 才视为成功；previewId 是 base64 预览 token
 *
 * Lexical contentJson 结构（对齐抓包样本）：
 *   root
 *     children: [
 *       { type: "paragraph", children: [{ type: "text", text, ... }] }
 *       // 或空段落：{ type: "paragraph", children: [] }
 *       // 或图片节点：{ type: "image", src, width, height, caption, attributes, colorid, specid, serid, typeid }
 *       // 或二级标题：{ type: "post-heading", tag: "h2", id, isTmpl: "1", children: [text] }
 *     ]
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Autohome')

/** 创作者后台 origin */
const CREATOR_ORIGIN = 'https://creator.autohome.com.cn'

/** BBS 发布页 URL（从抓包 referer 提取） */
const BBS_PUBLISH_PAGE = `${CREATOR_ORIGIN}/web/publish/bbs`

/** 发布接口（POST JSON） */
const PUBLISH_URL = `${CREATOR_ORIGIN}/openapi/content-api/gc/article/publish`

/** 创作者信息接口（GET，用于 checkAuth） */
const CREATORINFO_URL = `${CREATOR_ORIGIN}/openapi/ypttd/yjc/csc/creator/creatorinfo`

/** 图片上传接口（multipart/form-data） */
const IMAGE_UPLOAD_URL = 'https://club-open-api.autohome.com.cn/upload/uploadMultiClubImg'

/** 解析 HTML 时提取图片的正则（兼容单/双引号） */
const IMG_TAG_REGEX = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi

/** 解析 <p> / <h2> / <div class="editor-image"> 等顶层块元素的正则（更精准的逐块遍历） */
const TOP_BLOCK_REGEX = /<(p|h2|h3)\b([^>]*)>([\s\S]*?)<\/\1>|<div\b[^>]*class=["'][^'"]*editor-image[^'"]*["'][^>]*>([\s\S]*?)<\/div>/gi

/** Lexical 编辑器 text 节点 */
interface LexicalTextNode {
  detail: number
  format: number
  mode: string
  style: string
  text: string
  type: 'text'
  version: number
}

/** Lexical 编辑器 image 节点（对齐抓包样本） */
interface LexicalImageNode {
  type: 'image'
  src: string
  width: number
  height: number
  caption: string
  attributes: never[]
  colorid: string
  specid: number
  serid: number
  typeid: number
  version: number
}

/** Lexical 编辑器 paragraph 节点 */
interface LexicalParagraphNode {
  type: 'paragraph'
  children: Array<LexicalTextNode | LexicalImageNode>
  direction: 'ltr' | null
  format: string
  indent: number
  version: number
}

/** Lexical 编辑器 post-heading 节点（二级 / 三级标题） */
interface LexicalPostHeadingNode {
  type: 'post-heading'
  children: LexicalTextNode[]
  direction: 'ltr' | null
  format: string
  indent: number
  version: number
  tag: 'h2' | 'h3'
  id: string
  isTmpl: '1'
}

/** Lexical 编辑器根的 children 节点 */
type LexicalChild = LexicalParagraphNode | LexicalImageNode | LexicalPostHeadingNode

/** Lexical 编辑器根状态 */
interface LexicalRootState {
  root: {
    children: LexicalChild[]
    direction: 'ltr'
    format: string
    indent: number
    type: 'root'
    version: number
  }
}

/** 发布接口响应 */
interface AutohomePublishResp {
  returncode?: number
  message?: string
  result?: {
    draftId?: number
    previewId?: string
    [key: string]: unknown
  }
}

/** 创作者信息接口响应 */
interface AutohomeCreatorInfoResp {
  returncode?: number
  message?: string
  result?: {
    userid?: number
    nickname?: string
    role?: number
    [key: string]: unknown
  }
}

/** 图片上传接口响应 */
interface AutohomeImageUploadResp {
  returncode?: number
  message?: string
  result?: Array<{
    code?: number
    fileName?: string
    url?: string
    width?: number
    height?: number
  }>
}

export class AutohomeAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'autohome',
    name: '汽车之家',
    icon: 'https://www.autohome.com.cn/favicon.ico',
    homepage: CREATOR_ORIGIN,
    capabilities: ['article', 'draft'],
  }

  /**
   * 预处理配置：
   * - 输出 HTML（编辑器接受 <p class="editor-paragraph"><span>...</span></p> 结构）
   * - 其余使用 code-adapter 默认配置（懒加载图、SVG 占位、空元素、代码块等）
   */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  /** 注入 Origin / Referer 绕过 CORS / Referer 校验
   *
   * ⚠️ 只覆盖 creator.autohome.com.cn（发布/鉴权/编辑器 API）
   * ⚠️ club-open-api.autohome.com.cn（图片上传）不放这里——
   *    MV3 Service Worker 的 fetch 会被 Chrome 强制把 Origin 设为
   *    `chrome-extension://<id>`，declarativeNetRequest 的 SET 也无法完全覆盖，
   *    服务端 CORS 校验会直接 403 "Invalid CORS request"。
   *    图片上传改用 `tabs.executeScript` 在创作者编辑页 MAIN world 里发起，
   *    此时 Origin 自动是 creator.autohome.com.cn，可绕过服务端校验。
   */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://creator.autohome.com.cn/*',
      headers: {
        'Origin': CREATOR_ORIGIN,
        'Referer': BBS_PUBLISH_PAGE,
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  // ============ checkAuth ============

  /**
   * 鉴权：调用 creatorinfo 接口
   * - returncode === 0 即视为已登录
   * - 顺便从响应中取出 userid / nickname 供 UI 展示
   */
  async checkAuth(): Promise<AuthResult> {
    try {
      const resp = await this.get<AutohomeCreatorInfoResp>(CREATORINFO_URL, {
        Accept: 'application/json, text/plain, */*',
      })
      if (resp.returncode !== 0 || !resp.result) {
        return {
          isAuthenticated: false,
          error: resp.message || '请先登录汽车之家创作者平台（https://creator.autohome.com.cn/）',
        }
      }
      return {
        isAuthenticated: true,
        userId: resp.result.userid ? String(resp.result.userid) : undefined,
        username: resp.result.nickname || undefined,
      }
    } catch (error) {
      logger.debug('checkAuth error:', error)
      return {
        isAuthenticated: false,
        error: (error as Error).message || '鉴权失败',
      }
    }
  }

  // ============ publish ============

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish to Autohome...')

      // 0. 鉴权
      const auth = await this.checkAuth()
      if (!auth.isAuthenticated) {
        throw new Error(auth.error || '未登录汽车之家创作者平台')
      }

      // 1. 取预处理后的 HTML
      let content = article.html || ''

      // 2. ⭐ 把 <p><img>...</p> 提升为顶层 <div class="editor-image"><img>...</div>
      //    否则 buildContentJson 找不到 image 节点，编辑器渲染不出图片。
      content = this.normalizeImageBlocks(content)

      // 3. 处理图片（真实上传到 autohome 图床，替换 src 保留 data-width/data-height/style）
      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['autohome.com.cn', 'autoimg.cn'],
          onProgress: options?.onImageProgress,
        },
      )

      // 3. 构造 Lexical contentJson（对齐抓包样本结构）
      const { contentJson, contentLength, contentImagesLength } = this.buildContentJson(content)

      // ⚠️ declarationLabel：原 markdown 中不含「作品声明」时填 "1"（勾选默认声明），
      //    含「作品声明」时留空（说明用户自行撰写了声明文案，无需默认勾选）
      const hasDeclaration = (article.markdown || '').includes('作品声明')
      const declarationLabel = hasDeclaration ? '' : '1'

      // 4. 调用发布接口（首次创建不传 draftId；后续更新会由调用方传入 draftId，本适配器暂未使用）
      const payload: Record<string, unknown> = {
        title: article.title,
        suggestTitle: '',
        content,
        contentJson,
        contentLength,
        contentImagesLength,
        club: {},
        multibbs: '',
        statementCheck: false,
        publishType: 0,
        declarationLabel,
        extJson: '{"template":"{\\"type\\":2,\\"value\\":\\"474,车主实拍\\"}","templateCar":{"seriesId":0,"seriesName":"","specId":0,"specName":""}}',
        role: 1,
        infoType: 8,
        source: 'pc',
      }

      const response = await this.runtime.fetch(`${PUBLISH_URL}?t=${Date.now()}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/plain, */*',
        },
        body: JSON.stringify(payload),
      })

      const text = await response.text()
      let data: AutohomePublishResp
      try {
        data = JSON.parse(text) as AutohomePublishResp
      } catch {
        throw new Error(`发布失败：响应非 JSON (HTTP ${response.status}): ${text.substring(0, 200)}`)
      }

      logger.debug('publish response:', data)

      if (data.returncode !== 0 || !data.result?.draftId) {
        throw new Error(data.message || `发布失败：returncode=${data.returncode}`)
      }

      const draftId = String(data.result.draftId)
      // ⚠️ URL 参数是全小写 `draftid`，不是接口返回的 `draftId`（首字母大写）
      const postUrl = `${BBS_PUBLISH_PAGE}?draftid=${draftId}`

      return this.createResult(true, {
        postId: draftId,
        postUrl,
        draftOnly: options?.draftOnly ?? true,
        message: '已保存到汽车之家创作者平台草稿箱',
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  // ============ Lexical contentJson 构造 ============

  /**
   * 将 markdown / preprocess 后可能残留的 <p><img>...</p> 结构提升为顶层 image 块。
   *
   * 背景：
   * - markdown 的 `![alt](url)` 经 marked 转出来默认是 `<p><img ...></p>`（图片被 <p> 包着）
   * - autohome 编辑器只接受顶层 `<div class="editor-image"><img ...></div>` 作为 image 节点
   * - 如果不提升，buildContentJson 里 TOP_BLOCK_REGEX 匹配不到 image，
   *   contentJson 里没有 {type:"image"} 节点，编辑器渲染不出图片。
   *
   * 抓包样本里 image 块的结构：
   *   <div class="editor-image"><img src="..." style="max-width:100%;" data-width="1484" data-height="628"></div>
   */
  private normalizeImageBlocks(html: string): string {
    return html.replace(
      /<p\b[^>]*>\s*(<img\b[^>]*\/?>)\s*<\/p>/gi,
      '<div class="editor-image">$1</div>'
    )
  }

  /**
   * 将预处理后的 HTML 内容转换为 Lexical 编辑器状态 JSON。
   *
   * 结构（对齐抓包样本）：
   *   root
   *     children: [
   *       {
   *         type: "paragraph",
   *         children: [
   *           { type: "text", text: "...", detail:0, format:0, mode:"normal", style:"", version:1 }
   *         ]
   *       }
   *       // 或空段落：{ type: "paragraph", children: [], direction: null }
   *       // 或图片节点（顶层，editor-image div 解析得出）：
   *       { type: "image", src: "...", width, height, caption: "", attributes: [], colorid: "x", specid: 0, serid: 0, typeid: 0 }
   *       // 或二级标题：
   *       { type: "post-heading", tag: "h2", id: "...", isTmpl: "1", children: [text] }
   *     ]
   *
   * 顺带计算：
   * - contentLength：纯文本字符数
   * - contentImagesLength：图片数量
   */
  private buildContentJson(html: string): {
    contentJson: string
    contentLength: number
    contentImagesLength: number
  } {
    const children: LexicalChild[] = []
    let plainTextLength = 0
    let imageCount = 0

    // 逐块扫描顶层元素（<p> / <h2> / <h3> / <div class="editor-image">）
    for (const blockMatch of html.matchAll(TOP_BLOCK_REGEX)) {
      const tag = (blockMatch[1] || '').toLowerCase()
      const tagAttrs = blockMatch[2] || ''
      const innerHtml = blockMatch[3] || ''
      const imageDivInner = blockMatch[4]

      if (imageDivInner !== undefined) {
        // 处理 <div class="editor-image">：提取其中的 <img>
        const imgMatch = imageDivInner.match(IMG_TAG_REGEX)
        if (imgMatch) {
          const srcMatch = imgMatch[0].match(/src=["']([^"']+)["']/)
          const widthMatch = imgMatch[0].match(/data-width=["']?(\d+)["']?/)
          const heightMatch = imgMatch[0].match(/data-height=["']?(\d+)["']?/)
          if (srcMatch) {
            const width = widthMatch ? parseInt(widthMatch[1], 10) : 0
            const height = heightMatch ? parseInt(heightMatch[1], 10) : 0
            children.push(this.createImageNode(srcMatch[1], width, height))
            imageCount++
          }
        }
        continue
      }

      if (tag === 'p') {
        const text = this.stripTags(innerHtml)
        plainTextLength += text.length
        // 空段落（如 <p><br></p>）保留为 children: []，方向为 null
        if (text.length === 0) {
          children.push({
            type: 'paragraph',
            children: [],
            direction: null,
            format: '',
            indent: 0,
            version: 1,
          })
        } else {
          children.push({
            type: 'paragraph',
            children: [this.createTextNode(text)],
            direction: null,
            format: '',
            indent: 0,
            version: 1,
          })
        }
        continue
      }

      if (tag === 'h2' || tag === 'h3') {
        const text = this.stripTags(innerHtml)
        const idMatch = tagAttrs.match(/id=["']([^"']+)["']/)
        children.push({
          type: 'post-heading',
          children: text ? [this.createTextNode(text)] : [],
          direction: 'ltr',
          format: '',
          indent: 0,
          version: 1,
          tag,
          id: idMatch ? idMatch[1] : this.generateHeadingId(),
          isTmpl: '1',
        })
        if (text) plainTextLength += text.length
        continue
      }

      // 其他标签：尝试当作段落处理
      const text = this.stripTags(innerHtml)
      if (text) {
        plainTextLength += text.length
        children.push({
          type: 'paragraph',
          children: [this.createTextNode(text)],
          direction: null,
          format: '',
          indent: 0,
          version: 1,
        })
      }
    }

    const root: LexicalRootState = {
      root: {
        children,
        direction: 'ltr',
        format: '',
        indent: 0,
        type: 'root',
        version: 1,
      },
    }

    return {
      contentJson: JSON.stringify(root),
      contentLength: plainTextLength,
      contentImagesLength: imageCount,
    }
  }

  private createTextNode(text: string): LexicalTextNode {
    return {
      detail: 0,
      format: 0,
      mode: 'normal',
      style: '',
      text,
      type: 'text',
      version: 1,
    }
  }

  private createImageNode(src: string, width = 0, height = 0): LexicalImageNode {
    return {
      type: 'image',
      src,
      width,
      height,
      caption: '',
      attributes: [],
      colorid: 'x',
      specid: 0,
      serid: 0,
      typeid: 0,
      version: 1,
    }
  }

  /** 去除 HTML 标签，仅保留文本内容（用于统计 contentLength） */
  private stripTags(html: string): string {
    return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
  }

  /** 为 h2/h3 生成 6 位 hex id（对齐抓包样本 '000003' 格式） */
  private generateHeadingId(): string {
    return Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')
  }

  // ============ 图片上传 ============

  /**
   * 通过 URL 上传图片到汽车之家图床
   *
   * ⚠️ 必须走创作者编辑页 MAIN world，不能走 Service Worker：
   * MV3 SW 的 fetch 会被 Chrome 强制设 Origin 为 `chrome-extension://<id>`，
   * 即使加 declarativeNetRequest 规则也仍会被服务端 CORS 拒绝（403 "Invalid CORS request"）。
   *
   * 绕过方案：找到/打开一个 `creator.autohome.com.cn` 的 tab，
   * 通过 `tabs.executeScript` 在该 tab 的 MAIN world 里 fetch 上传，
   * 此时 Origin/Referer 都是页面域名，与用户手动点上传完全一致。
   *
   * 抓包样本（creator.autohome-all.com.cn.har Entry #20）：
   *   POST https://club-open-api.autohome.com.cn/upload/uploadMultiClubImg?_appid=club&t={ts}
   *     Origin: https://creator.autohome.com.cn
   *     Referer: https://creator.autohome.com.cn/
   *     Content-Type: multipart/form-data; boundary=...
   *   Fields:
   *     biztype: 1
   *     file: <binary>
   *   Response:
   *     { returncode: 0, message: "", result: [{ code: 0, url: "...", width, height }] }
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    // CLI/mcp-server 等非扩展环境没有 tabs API，直接降级返回原 URL
    if (!this.runtime.tabs) {
      logger.warn('[Autohome] 非扩展环境（无 tabs API），跳过上传，返回原 URL:', src)
      return { url: src }
    }

    try {
      let base64: string
      let mime: string
      let filename: string

      if (src.startsWith('data:')) {
        // data URI: data:<mime>;base64,<base64-data>
        // CLI 模式下本地图片被 convertImagesToDataUri 转成 base64 内联，
        // 这里解析后上传到 autohome 图床，让 HTML 里最终的 <img src> 始终是
        // http://club2.autoimg.cn/... 图床 URL（与抓包样本一致），
        // 避免编辑器无法渲染 data URI 内联图的问题。
        const m = src.match(/^data:([^;,]+);base64,(.*)$/s)
        if (!m) {
          logger.warn('[Autohome] 无法解析的 data URI:', src.substring(0, 80))
          return { url: src }
        }
        mime = m[1] || 'image/jpeg'
        base64 = m[2]
        const ext = mime.split('/')[1] || 'png'
        // 抓包样本中 fileName 是带时间戳的 “2026-07-28-14-18-45-1152x645.jpg”，
        // 保留时间戳形式，便于后端反盗图/去重
        const now = new Date()
        const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`
        filename = `${ts}.${ext}`
      } else {
        // 远程 URL: 先 fetch 下载 → base64（Blob 跨 executeScript 边界无法传输）
        const encodedSrc = this.encodeUrlPath(src)
        const imageResponse = await fetch(encodedSrc)
        if (!imageResponse.ok) {
          throw new Error(`图片下载失败 (${imageResponse.status}): ${src}`)
        }
        const blob = await imageResponse.blob()
        base64 = await this.blobToBase64(blob)
        filename = this.getFilenameFromUrl(src) || 'image.png'
        mime = blob.type || 'image/jpeg'
      }

      // 找到/打开 creator.autohome.com.cn 编辑页（用于在页面上下文发起上传）
      const tabId = await this.ensureCreatorTab()

      // 在该 tab 的 MAIN world 里 fetch 上传
      const result = await this.runtime.tabs.executeScript<
        { ok: boolean; status: number; text: string },
        [UploadInTabParams]
      >(tabId, uploadImageInTabScript, [{
        url: IMAGE_UPLOAD_URL,
        base64Data: base64,
        mime,
        filename,
        biztype: '1',
        appId: 'club',
        timestamp: Date.now(),
      }])

      if (!result.ok) {
        throw new Error(`上传图片失败 (HTTP ${result.status}): ${result.text.substring(0, 200)}`)
      }

      let data: AutohomeImageUploadResp
      try {
        data = JSON.parse(result.text) as AutohomeImageUploadResp
      } catch {
        throw new Error(`上传图片失败：响应非 JSON: ${result.text.substring(0, 200)}`)
      }

      logger.debug('image upload response:', data)

      if (data.returncode !== 0 || !data.result || data.result.length === 0) {
        throw new Error(data.message || '上传图片失败')
      }
      const item = data.result[0]
      if (item.code !== 0 || !item.url) {
        throw new Error(item.fileName ? `${item.fileName} 上传失败` : '上传图片失败')
      }

      // 构造 attrs 携带宽高，让 processImages 替换后的 <img> 标签含 data-width/data-height
      // 便于 buildContentJson 把图片节点还原为顶层 image 节点
      const attrs: Record<string, string | number> = { style: 'max-width:100%;' }
      if (item.width) attrs['data-width'] = item.width
      if (item.height) attrs['data-height'] = item.height

      return { url: item.url, attrs }
    } catch (error) {
      logger.warn('[Autohome] 图片上传失败，保留原 URL:', src, error)
      return { url: src }
    }
  }

  /**
   * 确保存在一个 `creator.autohome.com.cn` 的 tab，用于在页面上下文发起图片上传。
   * - 优先复用已打开的任意 creator.autohome.com.cn tab
   * - 否则在后台打开 BBS 发布页（需要已登录创作者平台）
   */
  private async ensureCreatorTab(): Promise<number> {
    // 运行时 tabs API 可能不可用（非扩展环境），窄化到非空类型
    const runtimeTabs = this.runtime.tabs
    if (!runtimeTabs) {
      throw new Error('创作者平台图片上传需要扩展 tabs API 支持')
    }

    const urlPattern = '*://creator.autohome.com.cn/*'
    const tabs = await runtimeTabs.query(urlPattern)
    const firstTab = tabs[0]
    if (firstTab && firstTab.id !== undefined) {
      logger.debug(`[Autohome] 复用已存在的 creator tab: ${firstTab.id}`)
      return firstTab.id
    }

    logger.info('[Autohome] 没有 creator tab，在后台打开发布页...')
    const tab = await runtimeTabs.create(BBS_PUBLISH_PAGE, false)
    const tabId = tab.id
    if (tabId === undefined) {
      throw new Error('创建创作者平台 tab 失败')
    }
    await runtimeTabs.waitForLoad(tabId, 30000)
    return tabId
  }

  /** Blob → base64 字符串（用于跨 executeScript 边界传递图像数据） */
  private async blobToBase64(blob: Blob): Promise<string> {
    const buffer = await blob.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    // 分块拼接，避免 String.fromCharCode 一次性传入超长数组报 RangeError
    const chunkSize = 0x8000
    let binary = ''
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize)
      binary += String.fromCharCode.apply(null, chunk as unknown as number[])
    }
    return btoa(binary)
  }

  /** 从 URL 提取文件名（用于 multipart filename） */
  private getFilenameFromUrl(url: string): string {
    try {
      const pathname = new URL(url).pathname
      const filename = decodeURIComponent(pathname.split('/').pop() || '')
      return filename || 'image.png'
    } catch {
      return 'image.png'
    }
  }
}

/** executeScript 传入参数（必须可被结构化克隆） */
interface UploadInTabParams {
  url: string
  base64Data: string
  mime: string
  filename: string
  biztype: string
  appId: string
  timestamp: number
}

/**
 * 在 creator.autohome.com.cn tab 的 MAIN world 里发起 multipart/form-data 上传。
 *
 * 重要：
 * 1. fetch 在页面上下文发起，Origin/Referer 自动是 creator.autohome.com.cn，
 *    浏览器自动携带同站 cookie。
 * 2. declarativeNetRequest 的 HEADER_RULES 作用域是
 *    initiatorDomains=[extension_id]，只影响扩展自身请求，
 *    不会影响页面本身的 fetch。
 * 3. 该函数会被 chrome.scripting.executeScript 序列化/反序列化，
 *    必须是纯函数（无闭包引用外部变量）。
 */
async function uploadImageInTabScript(params: UploadInTabParams): Promise<{ ok: boolean; status: number; text: string }> {
  const { url, base64Data, mime, filename, biztype, appId, timestamp } = params

  try {
    // base64 → Uint8Array → Blob（File 构造可指定文件名）
    const byteString = atob(base64Data)
    const bytes = new Uint8Array(byteString.length)
    for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i)
    const file = new File([bytes], filename, { type: mime })

    const formData = new FormData()
    formData.append('biztype', biztype)
    formData.append('file', file)

    const fullUrl = `${url}?_appid=${appId}&t=${timestamp}`
    const response = await fetch(fullUrl, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    })

    const text = await response.text()
    return { ok: response.ok, status: response.status, text }
  } catch (e) {
    return { ok: false, status: 0, text: (e as Error).message }
  }
}