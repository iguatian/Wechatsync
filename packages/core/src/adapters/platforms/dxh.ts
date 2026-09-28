/**
 * 大象新闻 · 大象号 适配器
 *
 * 平台资料：
 * - 创作者后台（大象号）：https://mp.hntv.tv/
 * - 内容管理（草稿箱 / 已发布列表）：https://mp.hntv.tv/manage/content
 * - 草稿详情（编辑器）：https://mp.hntv.tv/publish/0?articleId=<articleId>&articleStatus=0
 *   （路径段是 articleType，0 = 图文；articleStatus=0 表示草稿）
 * - 业务接口域：https://dxnum.hntv.tv（后台 axios 实例 baseURL，见 app-*.js 的
 *   `i.a.create({ baseURL: "https://dxnum.hntv.tv" })`，业务路径统一 `/dxnum/...`）
 * - 素材库接口域：https://ggw.hntv.tv/cmedia/...
 * - 文件上传域：https://new-file-upload.hntv.tv（tus 协议），上传后 CDN 域为
 *   https://new-file.hntv.tv
 *
 * 鉴权（HAR + 前端产物双向验证）：
 *   后台 axios 请求拦截器（app-*.js 的模块 `b775`）对每个请求注入：
 *     Authorization: Bearer <localStorage["hngd_cloud_dxh_platform_token"].access_token>
 *     dxnumId:       <localStorage["hngd_cloud_dxh_platform_info"].dxnumId>
 *   （`token` / `fusion_id` 两个 getter：`"Bearer " + tokenInfo.access_token`、
 *     `dxnumInfo.dxnumId`；该站 axios 没有开 withCredentials，HAR 全程也没有 Cookie，
 *     所以请求**不依赖 Cookie**，只有这两个头。）
 *
 *   登录态存在 localStorage（store.js 写入，值是可 JSON.parse 的对象）：
 *     hngd_cloud_dxh_platform_token → { access_token, expires_in, ... }（access_token 即 JWT）
 *     hngd_cloud_dxh_platform_info  → { dxnumId, channelId, nickname, ... }
 *     hngd_cloud_dxh_platform_user  → { id, nickname, iconUrl, dxnumName, ... }
 *   这三个 key 是前端自己的存储（`window.localStorage.getItem("hngd_cloud_dxh_platform_user")`
 *   在读用户信息组件里被直接使用），因此本适配器复用「读/建 mp.hntv.tv tab」的方式取凭证
 *   （与 tidenews / sspai 同一套做法），并用 `GET /dxnum/c/getUserInfo` 复验。
 *
 * 接口（均需 Authorization + dxnumId 头）：
 *   GET  /dxnum/c/getUserInfo               → result:[{ id, dxnumId, nickname, iconUrl, ... }]
 *   POST /dxnum/c/article/recommend          → { articleTitle, content } ⇒
 *                                               result:{ keywords:"标题,正文", labelList:[{id,labelName}] }
 *   POST /dxnum/c/article/draft/add          → 存草稿（HAR 样本见下）
 *
 * 图片上传（HAR 验证，与编辑器 `handleUploadTusd` + 素材弹窗 `mediaUpload` 完全一致）：
 *   1. POST https://new-file-upload.hntv.tv/files/   （tus 1.0.0，creation-with-upload）
 *        Tus-Resumable: 1.0.0
 *        Upload-Length: <size>
 *        Upload-Metadata: filename <b64>,filetype <b64>,filesize <b64>,payload <b64>,xtoken <b64>
 *        Content-Type: application/offset+octet-stream
 *      body = 图片二进制
 *      → 201 Created，关键响应头：
 *        Link    : https://new-file.hntv.tv/attachment/dxnum/<userId>/<年>/<uuid>.<ext>（最终地址）
 *        Width / Height / Thumb：图片宽高与缩略图
 *      ⚠️ `xtoken` 是 access_token（**去掉 `Bearer ` 前缀**，编辑器里就是
 *         `$store.getters.token.slice(7)`），不是带 Bearer 的完整头值。
 *   2. POST https://ggw.hntv.tv/cmedia/t/upload    （素材库登记，application/json）
 *        { url: <Link 地址>, file_name, file_desc: <mime>, parent_id: "" }
 *      → data:{ file_id, file, thumb, file_resolution, ... }
 *    正文插图与封面都使用登记后的 `data.file`（与 Link 相同），`data-mediaid` 用 `file_id`。
 *
 * 正文 HTML 结构（与编辑器插入图片的模板逐字段一致）：
 *   <img src="<url>" data-link="<url>" data-width="<w>" data-height="<h>" data-mediaid="<file_id>" />
 *   （编辑器源码模板通过 TinyMCE 落成 `<img ... />`，HAR 抓包正文同款。）
 *
 * 保存草稿（HAR 样本，POST /dxnum/c/article/draft/add）：
 *   {
 *     coverType: 0, articleType: 0, articleTitle, content,
 *     coverImageList: [{ category:"0", url, width, height }],
 *     articleLabel: "105,105014",          // recommend 的 labelList 拼成
 *     keywords: "标题,正文",                // recommend 返回
 *     isDxquan: 0/1, dxquanId, dxquanName, // 是否同时发到大象圈
 *     summary, originalFlag: 0, isFirstTimePublish: 0, publishTime: "",
 *     publicFlag: 1, timingPublishFlag: 0, streamList: [],
 *     articleAuthorDeclarationDTO: null, dxnumId
 *   }
 *   → result:{ articleId, articleContentId, ... }
 *
 * 说明：
 * - 本适配器只做「存草稿」（与潮新闻/快传号/少数派/界面新闻一致），不直接提交发布，
 *   用户可到 https://mp.hntv.tv/manage/content 复核后自行发布。
 * - 后台是 qiankun 主应用，页面 `<meta name="referrer" content="no-referrer">`，
 *   浏览器不发 Referer；接口响应带 `Access-Control-Allow-Origin: https://mp.hntv.tv`，
 *   这里通过 headerRules 注入 `Origin`，与 HAR 中请求头对齐。
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'
import { parseMarkdownImages } from '../../lib/markdown-images'

const logger = createLogger('Dxh')

/** 创作者后台 origin（页面与原始素材都在这个域） */
const SITE_ORIGIN = 'https://mp.hntv.tv'

/** 创作者后台首页（未登录会被前端路由守卫重定向到 /login） */
const CREATOR_PAGE = `${SITE_ORIGIN}/`

/** 内容管理页（草稿箱 / 已发布列表，编辑器保存成功后跳这里） */
const CONTENT_PAGE = `${SITE_ORIGIN}/manage/content`

/** 图文编辑器路由前缀（草稿详情地址为 `/publish/<articleType>?articleId=...&articleStatus=0`） */
const PUBLISH_PATH = `${SITE_ORIGIN}/publish`

/** 业务接口前缀（后台 axios baseURL + /dxnum 路径前缀） */
const API_BASE = 'https://dxnum.hntv.tv/dxnum'

/** 账号信息接口（checkAuth 复验 + 取昵称头像） */
const USER_INFO_URL = `${API_BASE}/c/getUserInfo`

/** 标签 / 关键词推荐接口（编辑器在标题、正文变化时调用） */
const RECOMMEND_URL = `${API_BASE}/c/article/recommend`

/** 存草稿接口 */
const DRAFT_ADD_URL = `${API_BASE}/c/article/draft/add`

/** tus 上传端点（uploadDataDuringCreation，一次性 POST 完成） */
const TUS_ENDPOINT = 'https://new-file-upload.hntv.tv/files/'

/** 素材库登记接口（把 tus 上传后的地址登记为素材，拿到 file_id） */
const MEDIA_UPLOAD_URL = 'https://ggw.hntv.tv/cmedia/t/upload'

/** 上传完成后图片的公开 CDN 域（地址长期有效，无需转存） */
const MEDIA_CDN_HOST = 'new-file.hntv.tv'

/** tus 上传元数据里的来源标识（编辑器上传弹窗固定 `source: "dxh"`） */
const UPLOAD_SOURCE = 'dxh'

/** 图文文章类型（后台 consts：0 = 图文） */
const ARTICLE_TYPE_IMAGE_TEXT = 0

/** 封面类型（HAR 样本为 0） */
const COVER_TYPE_DEFAULT = 0

/** 公开可见（HAR 样本 publicFlag=1） */
const PUBLIC_FLAG_PUBLIC = 1

/** 草稿的 articleStatus（编辑器详情地址里的 `articleStatus=0`） */
const ARTICLE_STATUS_DRAFT = 0

/** localStorage 键名（store.js 写入，前端页面直接读取这三个） */
const TOKEN_KEY = 'hngd_cloud_dxh_platform_token'
const INFO_KEY = 'hngd_cloud_dxh_platform_info'
const USER_KEY = 'hngd_cloud_dxh_platform_user'

/** 后台统一响应包装：业务码为数字 0 表示成功 */
interface DxhEnvelope<T> {
  code?: number
  msg?: string
  result?: T
  data?: T
  success?: boolean
}

/** 账号信息（getUserInfo 的 result[0]） */
interface DxhUserInfo {
  id?: string
  dxnumId?: string
  nickname?: string
  dxnumName?: string
  iconUrl?: string
  [key: string]: unknown
}

/** 读取 localStorage 得到的原始凭证 */
interface DxhRawCredentials {
  token: string | null
  info: string | null
  user: string | null
}

/** 解析后的登录凭证 */
interface DxhCredentials {
  /** access_token（Authorization 的 Bearer 主体，也是 tus 的 xtoken） */
  token: string
  /** 大象号 ID（dxnumId 请求头） */
  dxnumId: string
  /** 昵称（来自本地缓存 / 接口复验） */
  nickname?: string
  /** 头像（来自本地缓存 / 接口复验） */
  avatar?: string
}

/** 素材库登记结果（正文插图 / 封面共用） */
interface DxhMedia {
  /** 图片公开地址（new-file.hntv.tv） */
  url: string
  /** 素材 ID（正文 data-mediaid） */
  mediaId?: string
  /** 宽 */
  width?: string
  /** 高 */
  height?: string
}

/** recommend 接口结果 */
interface DxhRecommendResult {
  keywords?: string
  labelList?: Array<{ id?: string; labelName?: string }>
}

export class DxhAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'dxh',
    name: '大象号',
    icon: `${SITE_ORIGIN}/favicon.ico`,
    homepage: CREATOR_PAGE,
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  /** 预处理配置：大象号编辑器正文为 HTML（TinyMCE） */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  /**
   * Header 规则：三个接口域（业务 / 素材 / 上传）都按 `mp.hntv.tv` 校验 Origin，
   * 扩展 SW 直连时统一注入 `Origin: https://mp.hntv.tv` 与 HAR 对齐
   * （页面设了 no-referrer，浏览器不发 Referer，这里也不注入）。
   */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://dxnum.hntv.tv/*',
      headers: { Origin: SITE_ORIGIN },
    },
    {
      urlFilter: '*://ggw.hntv.tv/*',
      headers: { Origin: SITE_ORIGIN },
    },
    {
      urlFilter: '*://new-file-upload.hntv.tv/*',
      headers: { Origin: SITE_ORIGIN },
    },
  ]

  /** 当前 publish 会话内的凭证，正文图片逐张上传时复用，避免反复读页面 */
  private activeCredentials: DxhCredentials | null = null

  // ============ checkAuth ============

  /**
   * 鉴权：从 mp.hntv.tv 页面 localStorage 取 token / dxnumId，再调 getUserInfo 复验。
   *
   * 不主动新建 tab（批量检查登录态时逐个开 tab 太重），只在已有 mp.hntv.tv tab 时读取；
   * publish 场景会按需新建（见 `resolveCredentials`）。
   */
  async checkAuth(): Promise<AuthResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      try {
        const stored = await this.readCredentialsFromExistingTab()
        if (!stored) {
          return {
            isAuthenticated: false,
            error: `请先登录大象号（${CREATOR_PAGE}）`,
          }
        }
        return await this.verifyCredentials(stored)
      } catch (error) {
        logger.debug('checkAuth error:', error)
        return {
          isAuthenticated: false,
          error: (error as Error).message || '鉴权失败',
        }
      }
    })
  }

  /** 调 getUserInfo 复验凭证（401/403 或非 0 业务码一律视为未登录） */
  private async verifyCredentials(creds: DxhCredentials): Promise<AuthResult> {
    const { info, status } = await this.fetchUserInfo(creds)

    if (status === 401 || status === 403) {
      return {
        isAuthenticated: false,
        error: '登录态已失效，请重新登录大象号',
      }
    }

    const first = Array.isArray(info) ? info[0] : (info as DxhUserInfo | undefined)
    if (!first) {
      return {
        isAuthenticated: false,
        error: '登录态已失效，请重新登录大象号',
      }
    }

    return {
      isAuthenticated: true,
      userId: first.id || first.dxnumId || creds.dxnumId,
      username: first.nickname || first.dxnumName || creds.nickname || creds.dxnumId,
      avatar: first.iconUrl || creds.avatar,
    }
  }

  /**
   * 请求 GET /dxnum/c/getUserInfo。
   *
   * 响应 `result` 是数组（一个登录账号可能对应多个大象号，第一个即当前账号）；
   * `code` 非 0 时按失败处理，调用方据此判定是否已登录。
   */
  private async fetchUserInfo(
    creds: DxhCredentials,
  ): Promise<{ info?: DxhUserInfo | DxhUserInfo[]; status: number; message?: string }> {
    const resp = await this.runtime.fetch(USER_INFO_URL, {
      headers: this.apiHeaders(creds),
    })
    const text = await resp.text()

    let data: DxhEnvelope<DxhUserInfo[] | DxhUserInfo>
    try {
      data = JSON.parse(text) as DxhEnvelope<DxhUserInfo[] | DxhUserInfo>
    } catch {
      throw new Error(`getUserInfo 响应解析失败（HTTP ${resp.status}）`)
    }

    if (resp.status === 401 || resp.status === 403) {
      return { status: resp.status }
    }
    if (!resp.ok) {
      return { status: resp.status, message: `HTTP ${resp.status}` }
    }
    if (data.code !== 0) {
      return { status: resp.status, message: data.msg || `code=${data.code}` }
    }
    return { info: data.result, status: resp.status }
  }

  // ============ publish ============

  /**
   * 发布文章（保存草稿）。
   *
   * 流程（HAR 验证）：
   *   1. 读取登录凭证（复用已有后台 tab，必要时新建）
   *   2. 上传正文图片（tus 上传 + 素材登记，替换 src 并补 data-* 属性）
   *   3. 上传封面（article.cover，缺省时用正文第一张图，与编辑器行为一致）
   *   4. POST article/recommend 取推荐标签与关键词
   *   5. POST article/draft/add → 拿 articleId
   */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish to Dxh...')

      const creds = await this.resolveCredentials(true)
      if (!creds) {
        throw new Error(`请先登录大象号（${CREATOR_PAGE}）`)
      }

      // localStorage 里没有 dxnumInfo 时（例如刚登录还没进过编辑器），
      // 用 getUserInfo 补 dxnumId —— 后续所有接口都要带这个头。
      if (!creds.dxnumId) {
        const { info } = await this.fetchUserInfo(creds)
        const first = Array.isArray(info) ? info[0] : (info as DxhUserInfo | undefined)
        if (first?.dxnumId) creds.dxnumId = first.dxnumId
      }
      if (!creds.dxnumId) {
        throw new Error('未取到大象号 ID（dxnumId），请先在浏览器打开并登录创作者后台')
      }
      this.activeCredentials = creds

      try {
        // 2. 正文图片（自带实现，产出与后台编辑器一致的 <img> 标签）
        let content = article.html || ''
        let firstBodyImage: DxhMedia | undefined
        try {
          const processed = await this.processBodyImages(content, creds, options?.onImageProgress)
          content = processed.content
          firstBodyImage = processed.firstImage
        } catch (e) {
          logger.warn('[Dxh] 正文图片处理中途失败，继续发布：', (e as Error).message)
        }

        // 3. 封面：优先 article.cover，否则复用正文首图（编辑器同款兜底逻辑）
        let cover: DxhMedia | undefined
        let coverError: string | undefined
        if (article.cover) {
          try {
            cover = await this.uploadImageToDxh(article.cover, creds)
            logger.info(`[Dxh] 封面上传成功：${cover.url}`)
          } catch (e) {
            coverError = (e as Error).message
            logger.warn('[Dxh] 封面上传失败：', coverError)
          }
        } else if (firstBodyImage) {
          cover = firstBodyImage
          logger.info('[Dxh] 未提供封面，复用正文首图作为封面')
        } else {
          logger.warn('[Dxh] 未提供封面（article.cover），coverImageList 为空')
        }

        // 4. 标签 / 关键词推荐（对齐编辑器 getNewTag 的取法，失败不阻断）
        const recommend = await this.fetchRecommend(article.title, content, creds)

        // 5. 保存草稿
        const draftId = await this.saveDraft({
          title: article.title,
          content,
          cover,
          articleLabel: buildArticleLabel(recommend?.labelList),
          keywords: normalizeKeywords(recommend?.keywords),
          summary: article.summary || '',
          credentials: creds,
        })

        const draftUrl = buildDraftUrl(draftId)
        logger.info(`[Dxh] 草稿已保存：${draftId}`)
        return this.createResult(true, {
          postId: draftId,
          postUrl: draftUrl,
          draftOnly: true,
          coverUploaded: !!cover,
          coverUrl: cover?.url,
          ...(coverError ? { coverError } : {}),
          message: `已保存到大象号草稿（${draftUrl}），草稿箱列表：${CONTENT_PAGE}`,
        })
      } finally {
        this.activeCredentials = null
      }
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  // ============ 图片上传 ============

  /**
   * 单张图片上传（基类 `uploadImage(blob)` 依赖它）。
   *
   * 说明：正文图片走 `processBodyImages`（要控制 `<img>` 标签形态），
   * 本方法主要供 CLI 预上传图床（`resolveImageHost`）使用。
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    try {
      // CLI/MCP 会在 publish 之前先把本地图片预上传到「图床」，此时浏览器里往往还没有
      // mp.hntv.tv 标签页 —— 该站登录态只在页面 localStorage、没有 Cookie 兜底，
      // 不让开 tab 就只能失败（失败后 CLI 退回内嵌 data URI / 本地相对路径）。
      const creds = this.activeCredentials || (await this.resolveCredentials(true))
      if (!creds) {
        throw new Error(
          `未登录大象号，无法上传图片（请先在浏览器打开并登录 ${CREATOR_PAGE}）`,
        )
      }
      if (!creds.dxnumId) {
        const { info } = await this.fetchUserInfo(creds)
        const first = Array.isArray(info) ? info[0] : (info as DxhUserInfo | undefined)
        if (first?.dxnumId) creds.dxnumId = first.dxnumId
      }
      const media = await this.uploadImageToDxh(src, creds)
      return { url: media.url, attrs: this.buildImageAttrs(media) }
    } catch (error) {
      // 注意：CLI 预上传（图床）传进来的往往是 data URI，日志里只留前缀，别打整段 base64
      logger.warn(`[Dxh] 图片上传失败：${displayUrl(src)}`, error)
      return { url: src }
    }
  }

  /**
   * 正文图片处理：把正文里的图片转存到大象号素材库，并替换成与后台编辑器
   * 插入模板一致的 `<img>` 标签（见文件头说明）。
   *
   * 两类处理：
   *   1. 已是平台 CDN（`new-file.hntv.tv`）的地址 → 跳过转存（公开且长期有效），
   *      但会被记录为「正文首图」候选（封面兜底用）
   *   2. 其它外链 / data URI → tus 上传 + 素材登记后替换
   *
   * 单张图片失败只记日志并保留原 src，不阻断整体同步。
   *
   * @param content 正文 HTML（preprocessConfig 已保证 outputFormat=html）
   * @param creds 登录凭证
   * @param onProgress 图片进度回调
   */
  private async processBodyImages(
    content: string,
    creds: DxhCredentials,
    onProgress?: (current: number, total: number) => void,
  ): Promise<{ content: string; firstImage?: DxhMedia }> {
    const matches: Array<{ full: string; src: string }> = []

    // HTML: <img ... src="url" ...>
    const htmlImgRegex = /<img[^>]+src="([^"]+)"[^>]*>/gi
    let match: RegExpExecArray | null
    while ((match = htmlImgRegex.exec(content)) !== null) {
      matches.push({ full: match[0], src: match[1] })
    }

    // Markdown: ![alt](url) —— 编辑器只吃 HTML，这里统一转成 <img>
    for (const md of parseMarkdownImages(content)) {
      matches.push({ full: md.full, src: md.src })
    }

    if (matches.length === 0) return { content }

    let result = content
    let firstImage: DxhMedia | undefined
    const uploadedMap = new Map<string, DxhMedia>()
    let processed = 0

    for (const { full, src } of matches) {
      if (!src) continue

      // 1. 平台自家 CDN：地址公开且长期有效，只补 data-* 属性，不重复转存
      if (src.includes(MEDIA_CDN_HOST)) {
        const media: DxhMedia = {
          url: src,
          width: extractAttr(full, 'data-width'),
          height: extractAttr(full, 'data-height'),
          mediaId: extractAttr(full, 'data-mediaid'),
        }
        firstImage = firstImage || media
        const tag = buildImageTag(media)
        result = result.replace(full, () => tag)
        continue
      }

      processed++
      onProgress?.(processed, matches.length)

      try {
        let media = uploadedMap.get(src)
        if (!media) {
          media = await this.uploadImageToDxh(src, creds)
          uploadedMap.set(src, media)
        }
        firstImage = firstImage || media
        const tag = buildImageTag(media)
        // 用函数替换，避免 URL 里的 `$` 被当成 replace 的替换模式
        result = result.replace(full, () => tag)
      } catch (error) {
        logger.warn(`[Dxh] 正文图片上传失败，保留原 URL：${displayUrl(src)}`, error)
      }

      await this.delay(300)
    }

    return { content: result, firstImage }
  }

  /**
   * 上传单张图片（正文 / 封面共用）：
   *   tus 一次性上传（new-file-upload）→ 素材库登记（ggw.hntv.tv/cmedia/t/upload）
   *
   * @param src 图片 URL 或 data URI
   * @param creds 登录凭证（登记接口需要鉴权头；tus 只需要 xtoken 元数据）
   */
  private async uploadImageToDxh(src: string, creds: DxhCredentials): Promise<DxhMedia> {
    // 1. 取图片二进制
    let blob: Blob
    if (src.startsWith('data:')) {
      blob = await this.dataUriToBlob(src)
    } else {
      const encodedSrc = this.encodeUrlPath(src)
      const imageResponse = await this.runtime.fetch(encodedSrc, { credentials: 'omit' })
      if (!imageResponse.ok) {
        throw new Error(`图片下载失败 (${imageResponse.status}): ${src}`)
      }
      blob = await imageResponse.blob()
    }

    // 2. tus 一次性上传
    const filename = `image-${this.uniqueName()}.${extensionFor(blob.type)}`
    const tus = await this.tusUpload(blob, filename, creds)
    if (!tus.url) {
      throw new Error('图片上传失败：tus 响应缺少 Link 头')
    }

    // 3. 素材库登记（拿到 file_id 作为正文 data-mediaid）
    const registered = await this.registerMedia(tus.url, filename, blob.type, creds)

    return {
      url: registered.url || tus.url,
      mediaId: registered.mediaId,
      width: tus.width,
      height: tus.height,
    }
  }

  /**
   * tus 1.0.0 一次性上传（`uploadDataDuringCreation`）。
   *
   * 编辑器用 tus-js-client，但该场景下只有一个请求：
   *   POST /files/  + Upload-Length / Upload-Metadata / Content-Type: application/offset+octet-stream
   * 因此这里直接手写这一个请求，不引入 tus 客户端依赖。
   * 成功响应（201）头：Link（最终地址）、Width、Height、Thumb。
   */
  private async tusUpload(
    blob: Blob,
    filename: string,
    creds: DxhCredentials,
  ): Promise<{ url: string; width?: string; height?: string }> {
    const metadata = [
      `filename ${base64(filename)}`,
      `filetype ${base64(blob.type || 'application/octet-stream')}`,
      `filesize ${base64(String(blob.size))}`,
      // payload 是上传方的自定义元数据（后端只透传），与 HAR 抓包保持一致
      `payload ${base64(JSON.stringify({ source: UPLOAD_SOURCE, pt: '', dxnum_id: '' }))}`,
      `xtoken ${base64(creds.token)}`,
    ].join(',')

    const resp = await this.runtime.fetch(TUS_ENDPOINT, {
      method: 'POST',
      credentials: 'omit',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(blob.size),
        'Upload-Metadata': metadata,
        'Content-Type': 'application/offset+octet-stream',
      },
      body: blob,
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(
        `图片上传失败：tus HTTP ${resp.status}${text ? `：${text.substring(0, 200)}` : ''}`,
      )
    }

    const url = resp.headers.get('Link') || ''
    return {
      url,
      width: resp.headers.get('Width') || undefined,
      height: resp.headers.get('Height') || undefined,
    }
  }

  /**
   * 素材库登记：POST https://ggw.hntv.tv/cmedia/t/upload
   * body 与 HAR 一致：`{ url, file_name, file_desc, parent_id }`。
   * 返回的 `data.file_id` 即正文插图 `data-mediaid`、封面 `coverId` 等场景复用的素材 ID。
   */
  private async registerMedia(
    url: string,
    filename: string,
    mime: string,
    creds: DxhCredentials,
  ): Promise<{ url?: string; mediaId?: string }> {
    const resp = await this.runtime.fetch(MEDIA_UPLOAD_URL, {
      method: 'POST',
      credentials: 'omit',
      headers: {
        ...this.apiHeaders(creds),
        'Content-Type': 'application/json;charset=UTF-8',
      },
      body: JSON.stringify({
        url,
        file_name: filename,
        file_desc: mime || 'application/octet-stream',
        parent_id: '',
      }),
    })
    const text = await resp.text()

    let data: DxhEnvelope<{ file_id?: string; file?: string }>
    try {
      data = JSON.parse(text) as DxhEnvelope<{ file_id?: string; file?: string }>
    } catch {
      throw new Error(`素材登记失败：响应非 JSON (HTTP ${resp.status})`)
    }

    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`素材登记失败：登录态已失效，请重新登录大象号（${CREATOR_PAGE}）`)
    }
    if (data.code !== 0) {
      throw new Error(`素材登记失败：${data.msg || `code=${data.code}`}`)
    }

    return { url: data.data?.file, mediaId: data.data?.file_id }
  }

  // ============ 草稿保存 ============

  /**
   * 标签 / 关键词推荐：POST /dxnum/c/article/recommend
   * 响应 `result.labelList` 是推荐标签，`result.keywords` 是逗号分隔的关键词。
   * 失败时返回 null（不阻断草稿保存）。
   */
  private async fetchRecommend(
    title: string,
    content: string,
    creds: DxhCredentials,
  ): Promise<DxhRecommendResult | null> {
    try {
      const resp = await this.runtime.fetch(RECOMMEND_URL, {
        method: 'POST',
        credentials: 'omit',
        headers: {
          ...this.apiHeaders(creds),
          'Content-Type': 'application/json;charset=UTF-8',
        },
        body: JSON.stringify({ articleTitle: title, content }),
      })
      const data = (await resp.json()) as DxhEnvelope<DxhRecommendResult>
      if (data.code !== 0) {
        logger.debug('[Dxh] recommend 返回非 0：', data.code, data.msg)
        return null
      }
      return data.result || null
    } catch (error) {
      logger.debug('[Dxh] recommend 请求失败：', error)
      return null
    }
  }

  /**
   * 保存草稿：POST /dxnum/c/article/draft/add（application/json）。
   * 字段与 HAR 样本对齐；`isDxquan` 固定 0（不同时发到大象圈，避免依赖圈子权限）。
   */
  private async saveDraft(params: {
    title: string
    /** 已替换图片地址的正文 HTML */
    content: string
    /** 封面（无封面时为 undefined） */
    cover?: DxhMedia
    /** 标签（recommend 结果拼成，无则空串） */
    articleLabel: string
    /** 关键词（逗号分隔，无则空串） */
    keywords: string
    /** 摘要 */
    summary: string
    credentials: DxhCredentials
  }): Promise<string> {
    const coverImageList = params.cover
      ? [
          {
            category: '0',
            url: params.cover.url,
            width: params.cover.width ?? '',
            height: params.cover.height ?? '',
          },
        ]
      : []

    const payload = {
      coverType: COVER_TYPE_DEFAULT,
      articleType: ARTICLE_TYPE_IMAGE_TEXT,
      articleTitle: params.title,
      content: params.content || '',
      coverImageList,
      articleLabel: params.articleLabel,
      keywords: params.keywords,
      isDxquan: 0,
      dxquanId: '',
      dxquanName: '',
      summary: params.summary,
      originalFlag: 0,
      isFirstTimePublish: 0,
      publishTime: '',
      publicFlag: PUBLIC_FLAG_PUBLIC,
      timingPublishFlag: 0,
      streamList: [] as unknown[],
      articleAuthorDeclarationDTO: null,
      dxnumId: params.credentials.dxnumId,
    }

    const resp = await this.runtime.fetch(DRAFT_ADD_URL, {
      method: 'POST',
      credentials: 'omit',
      headers: {
        ...this.apiHeaders(params.credentials),
        'Content-Type': 'application/json;charset=UTF-8',
      },
      body: JSON.stringify(payload),
    })
    const text = await resp.text()

    let data: DxhEnvelope<{ articleId?: string }>
    try {
      data = JSON.parse(text) as DxhEnvelope<{ articleId?: string }>
    } catch {
      throw new Error(`保存草稿失败：响应非 JSON (HTTP ${resp.status}): ${text.substring(0, 200)}`)
    }

    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`保存草稿失败：登录态已失效，请重新登录大象号（${CREATOR_PAGE}）`)
    }
    if (data.code !== 0) {
      throw new Error(`保存草稿失败：${data.msg || `code=${data.code}`}`)
    }

    const draftId = data.result?.articleId
    if (!draftId) {
      throw new Error('保存草稿失败：响应未含 articleId')
    }
    return String(draftId)
  }

  // ============ 凭证获取 ============

  /**
   * 解析登录凭证。
   *
   * 顺序（越靠前越不做多余动作）：
   *   1. 已有 mp.hntv.tv tab → 读页面 localStorage
   *   2. allowCreateTab 时才后台新建后台首页 tab 再读一次
   *
   * @param allowCreateTab 是否允许新建 tab。
   *   - publish / `uploadImage`（CLI 预上传图床）传 true：这两条路本来就是用户主动
   *     发起的同步，开一次后台 tab 读登录态是合理成本；首次成功后 tab 会保留。
   *   - checkAuth 传 false：批量检查登录态时（弹窗一次查十几个平台）逐个开 tab 太重。
   */
  private async resolveCredentials(allowCreateTab: boolean): Promise<DxhCredentials | null> {
    const existing = await this.readCredentialsFromExistingTab()
    if (existing) return existing

    if (allowCreateTab) {
      const tabId = await this.createCreatorTab()
      if (tabId !== null) {
        const creds = await this.readCredentialsFromTab(tabId)
        if (creds) return creds
      }
    }

    return null
  }

  /** 查找已打开的后台 tab（不做任何副作用操作） */
  private async readCredentialsFromExistingTab(): Promise<DxhCredentials | null> {
    const runtimeTabs = this.runtime.tabs
    if (!runtimeTabs) return null
    try {
      const tabs = await runtimeTabs.query('*://mp.hntv.tv/*')
      const first = tabs[0]
      if (!first || first.id === undefined) return null
      return await this.readCredentialsFromTab(first.id)
    } catch (error) {
      logger.debug('[Dxh] 查询 mp.hntv.tv tab 失败：', error)
      return null
    }
  }

  /** 后台打开创作者平台（用于读取页面 localStorage 中的登录态） */
  private async createCreatorTab(): Promise<number | null> {
    const runtimeTabs = this.runtime.tabs
    if (!runtimeTabs) return null
    try {
      logger.info(`[Dxh] 后台打开 ${CREATOR_PAGE} 以读取登录态...`)
      const tab = await runtimeTabs.create(CREATOR_PAGE, false)
      if (tab.id === undefined) return null
      await runtimeTabs.waitForLoad(tab.id, 30000)
      return tab.id
    } catch (error) {
      logger.debug('[Dxh] 创建后台 tab 失败：', error)
      return null
    }
  }

  /** 在指定 tab 的页面上下文读取 localStorage 里的登录态 */
  private async readCredentialsFromTab(tabId: number): Promise<DxhCredentials | null> {
    const runtimeTabs = this.runtime.tabs
    if (!runtimeTabs) return null
    try {
      // executeScript 在 MAIN world 执行，函数不得引用模块级变量
      const raw = await runtimeTabs.executeScript<DxhRawCredentials, [string, string, string]>(
        tabId,
        readCredentialsInPageScript,
        [TOKEN_KEY, INFO_KEY, USER_KEY],
      )
      return buildCredentials(raw)
    } catch (error) {
      logger.debug('[Dxh] 读取页面登录态失败：', error)
      return null
    }
  }

  // ============ 工具方法 ============

  /** 后台接口统一请求头（对齐 axios 请求拦截器） */
  private apiHeaders(creds: DxhCredentials): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      Authorization: `Bearer ${creds.token}`,
    }
    if (creds.dxnumId) headers.dxnumId = creds.dxnumId
    return headers
  }

  /** 正文插图 / 封面共用：素材地址 → `<img>` 属性 */
  private buildImageAttrs(media: DxhMedia): Record<string, string> {
    const attrs: Record<string, string> = {
      'data-link': media.url,
    }
    if (media.width) attrs['data-width'] = media.width
    if (media.height) attrs['data-height'] = media.height
    if (media.mediaId) attrs['data-mediaid'] = media.mediaId
    return attrs
  }

  /** 生成 ASCII 文件名主体（避免中文文件名在服务端出现编码差异） */
  private uniqueName(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
}

// ============ 模块级工具 ============

/**
 * 拼出草稿详情地址（编辑器路由）。
 *
 * 形如 `https://mp.hntv.tv/publish/0?articleId=2104494976887357441&articleStatus=0`：
 * 路径段是 articleType（图文 = 0），query 里的 articleId 即 draft/add 返回的
 * `result.articleId`，articleStatus=0 表示草稿。
 */
function buildDraftUrl(draftId: string): string {
  const query = new URLSearchParams({
    articleId: draftId,
    articleStatus: String(ARTICLE_STATUS_DRAFT),
  })
  return `${PUBLISH_PATH}/${ARTICLE_TYPE_IMAGE_TEXT}?${query.toString()}`
}

/**
 * 拼出正文插图的 `<img>` 标签。
 *
 * 形态与后台编辑器插入图片的模板一致（TinyMCE 序列化后即 HAR 抓包里的样子）：
 * `<img src="..." data-link="..." data-width="..." data-height="..." data-mediaid="..." />`
 *
 * 缺少的属性（如未拿到宽高）直接省略，不做多余转义 —— 平台地址里不含 `&`/`"`
 * （编辑器同样是模板字符串直接拼接）。
 */
function buildImageTag(media: DxhMedia): string {
  const parts = [`src="${media.url}"`, `data-link="${media.url}"`]
  if (media.width) parts.push(`data-width="${media.width}"`)
  if (media.height) parts.push(`data-height="${media.height}"`)
  if (media.mediaId) parts.push(`data-mediaid="${media.mediaId}"`)
  return `<img ${parts.join(' ')} />`
}

/** 从原始 `<img>` 标签里取属性值（仅用于复用平台 CDN 图片的场景） */
function extractAttr(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`, 'i'))
  return match ? match[1] : undefined
}

/**
 * 把 recommend 返回的标签列表拼成后台要求的 `articleLabel`。
 *
 * 编辑器的取法（`getNewTag`）：取 `labelList` 里 `id.length > 3` 的第一个作为子标签，
 * 父标签取其前 3 位，最终以逗号连接，例如 `153,153001`。
 * 没有可用的子标签时返回空串。
 */
function buildArticleLabel(labelList?: Array<{ id?: string }>): string {
  if (!labelList || labelList.length === 0) return ''
  const child = labelList.find((item) => typeof item.id === 'string' && item.id.length > 3)
  if (!child?.id) return ''
  return `${child.id.substring(0, 3)},${child.id}`
}

/** 编辑器 `rtKeywords`：接口返回的逗号分隔关键词就是最终提交格式 */
function normalizeKeywords(keywords?: string): string {
  return keywords ? keywords.trim() : ''
}

/**
 * tus 元数据值必须是 UTF-8 文本的 base64 编码。
 *
 * 用下标循环而不是 `for...of`：本函数所在的文件会被 `scripts/fix-dts.js` 用
 * TS Compiler API 单独编译（只读 tsconfig 文本、不解析 extends，因此拿不到
 * ES2022 target），迭代 Uint8Array 会报 downlevelIteration 错误。
 */
function base64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/** 由 mime 推断文件扩展名（服务端按上传文件名后缀产出对象名） */
function extensionFor(mime: string): string {
  const normalized = (mime || '').toLowerCase()
  if (normalized.includes('png')) return 'png'
  if (normalized.includes('gif')) return 'gif'
  if (normalized.includes('webp')) return 'webp'
  if (normalized.includes('bmp')) return 'bmp'
  if (normalized.includes('svg')) return 'svg'
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg'
  return 'png'
}

/**
 * 日志展示用的 URL：data URI / 超长地址只留前缀，避免整段 base64 打进控制台。
 */
function displayUrl(url: string): string {
  return url.length > 120 ? `${url.slice(0, 80)}…（共 ${url.length} 字符）` : url
}

/**
 * 把页面 localStorage 原始值组装成凭证。
 *
 * 登录态判据：`hngd_cloud_dxh_platform_token` 里能解析出 access_token。
 * dxnumId / 昵称 / 头像取自另外两个 key，缺了也不影响（会由接口复验补全）。
 */
function buildCredentials(raw: DxhRawCredentials | null): DxhCredentials | null {
  if (!raw) return null

  const tokenInfo = parseJsonObject(raw.token)
  const token = pickString(tokenInfo, ['access_token', 'accessToken', 'token'])
  if (!token) return null

  const dxnumInfo = parseJsonObject(raw.info)
  const userInfo = parseJsonObject(raw.user)

  return {
    token,
    dxnumId: pickString(dxnumInfo, ['dxnumId', 'dxnum_id']) || '',
    nickname:
      pickString(dxnumInfo, ['nickname', 'dxnumName']) ||
      pickString(userInfo, ['nickname', 'dxnumName']),
    avatar: pickString(userInfo, ['iconUrl', 'avatar']),
  }
}

/** 宽松解析 JSON 对象（store.js 写入的是 JSON 字符串；解析失败返回 null） */
function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

/** 按候选键名取第一个非空字符串值 */
function pickString(
  source: Record<string, unknown> | null,
  keys: string[],
): string | undefined {
  if (!source) return undefined
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

/**
 * 在后台页面 MAIN world 读取登录态。
 *
 * ⚠️ 纯函数约束（MV3 executeScript 闭包序列化陷阱）：本函数会被序列化后在页面
 * 上下文执行，禁止引用模块级函数/常量（生产构建会被混淆，页面报 "xx is not
 * defined" 导致 executeScript 返回 null）。键名通过参数传入。
 */
function readCredentialsInPageScript(
  tokenKey: string,
  infoKey: string,
  userKey: string,
): DxhRawCredentials {
  const read = (key: string): string | null => {
    try {
      return window.localStorage.getItem(key) || window.sessionStorage.getItem(key)
    } catch {
      return null
    }
  }

  return {
    token: read(tokenKey),
    info: read(infoKey),
    user: read(userKey),
  }
}
