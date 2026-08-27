/**
 * 懂车帝创作者平台适配器（mp.dcdapp.com）
 *
 * 平台资料：
 * - 创作者后台：https://mp.dcdapp.com/
 * - 文章编辑器：https://mp.dcdapp.com/profile_v2/publish/article
 * - 草稿管理：https://mp.dcdapp.com/profile_v2/manage/content/article
 * - 入口域名：`mp.dcdapp.com`（头条字节系，账号与头条互通）
 * - 封面要求：横版 (pgc_feed_covers, 4:3) + 竖版 (vertical_cover_image, 3:4)，双封面必传。
 * - 调色板：横版为信息流推荐位（feed 卡片），竖版为图文详情页背景。两者比例/尺寸不同，缺一不可。
 * - 横版 thumb_width/thumb_height = 600/450（编辑器 UI 默认值），竖版 width/height = 600/800。HAR 抓包固定这两个比例。
 *   原图按上传时实际尺寸记录，仅 thumbnail 字段固定为 600×450 / 600×800（与官方编辑器一致）。
 * - 用户信息接口：mp.dcdapp.com/motor/mp_index/api/notify/count? —— 已登录返回 {status:0,data:{total,unread}}，未登录返回非 0 或登录跳转页。HAR 验证。
 * - CSRF：头条系 sec sdk csrf 机制，HEAD /motor/content_publish/publish_mp_article/v1 带 `x-secsdk-csrf-request: 1` 头，响应头返回 `x-ware-csrf-token`（格式 "0,{token},86370000,success,{session_id}"），取逗号分隔第 2 段作为 token，后续 POST 必带 `x-secsdk-csrf-token` 头。HAR 验证。
 * - 图片上传（imagex）：三步式（ApplyImageUpload + TOS PUT + CommitImageUpload + get_url）。HAR 验证，ServiceId=f042mdwyw7，bucket=tos-cn-i-f042mdwyw7。STS 来源 mp.dcdapp.com/motor/car_page/v6/img/get_upload_auth。PUT 需带 Content-CRC32 / Content-Disposition / X-Storage-U 三头；提交后通过 mp.dcdapp.com/motor/car_page/v6/img/get_url 拿到最终 URL（p0-dcd-private.dcdapp.com 域）。
 * - 发布接口：POST mp.dcdapp.com/motor/content_publish/publish_mp_article/v1 —— 必传 extra.vertical_cover_image（JSON 字符串：{uri,height,width,is_ai_cover}）和 extra.pgc_feed_covers（数组：[{url,uri,thumb_width,thumb_height}]）；title/content/source/save/publisher_ai_info 等字段对齐抓包样本。响应 data.data.pgc_id 即文章 ID。HAR 验证。
 * - 关键响应字段：postUrl = `https://mp.dcdapp.com/profile_v2/publish/article?pgc_id={pgc_id}`（草稿编辑页地址，save=0 时发布接口实际保存为草稿，不会生成已发布文章链接）。HAR 验证。
 * - 完整流程必须走 `mp.dcdapp.com` 页面上下文（tabs.executeScript）：MV3 SW fetch 会被 Chrome 强制设 Origin 为 `chrome-extension://<id>`，服务端 CORS/Referer 校验直接拒绝。HAR 验证。CLI/mcp-server 等非扩展环境无 tabs API 需降级报错。
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Dongchedi')

/** 懂车帝创作者后台 origin */
const CREATOR_ORIGIN = 'https://mp.dcdapp.com'

/** 文章编辑器页（Referer 必填） */
const PUBLISH_PAGE = `${CREATOR_ORIGIN}/profile_v2/publish/article`

/** 鉴权接口：mp_index 通知数接口 */
const NOTIFY_COUNT_URL = `${CREATOR_ORIGIN}/motor/mp_index/api/notify/count`

/** 获取 STS 上传凭证 */
const STS_URL = `${CREATOR_ORIGIN}/motor/car_page/v6/img/get_upload_auth`

/** 图片最终 URL 转换接口 */
const IMG_GET_URL = `${CREATOR_ORIGIN}/motor/car_page/v6/img/get_url`

/** 发布接口（POST JSON） */
const PUBLISH_URL = `${CREATOR_ORIGIN}/motor/content_publish/publish_mp_article/v1`

/** imagex ServiceId（懂车帝固定） */
const IMAGEX_SERVICE_ID = 'f042mdwyw7'

/** 横版封面 thumb 尺寸（HAR 抓包样本固定值） */
const FEED_THUMB_WIDTH = 600
const FEED_THUMB_HEIGHT = 450

/** 竖版封面 thumb 尺寸（HAR 抓包样本固定值） */
const VERTICAL_WIDTH = 600
const VERTICAL_HEIGHT = 800

interface STSInfoInternal {
  AccessKeyId: string
  SecretAccessKey: string
  SessionToken: string
  /** ISO 字符串或秒级时间戳 */
  ExpiredTime: string | number
  /**
   * 字节系 STS2 token 中的 user_id（imagex 上传 headers X-Storage-U 用）。
   * 注意：懂车帝 STS 的 PolicyString 不含 UserId，此字段实际不会返回，
   * 上传时改从页面 cookie 兜底读取（见 uploadSingleImageScript）。
   */
  userId?: string
}

interface ImgUploadResult {
  storeUri: string
  url: string
  width: number
  height: number
}

/**
 * 封面信息（含横版 url + 竖版 uri 拼接结果）
 */
interface CoverInfo {
  /** 横版封面最终 URL（用于 pgc_feed_covers[].url） */
  landscapeUrl: string
  landscapeUri: string
  landscapeThumbWidth: number
  landscapeThumbHeight: number
  /** 竖版封面 uri 字段（用于 vertical_cover_image JSON 字符串） */
  portraitUri: string
  portraitWidth: number
  portraitHeight: number
  /** 真实上传的图片尺寸（用于诊断） */
  landscapeImageWidth: number
  landscapeImageHeight: number
  portraitImageWidth: number
  portraitImageHeight: number
}

/** executeScript 传入参数（必须可被结构化克隆） */
interface UploadAndPublishParams {
  publishUrl: string
  pageOrigin: string
  publishPage: string
  notifyCountUrl: string
  stsUrl: string
  imgGetUrl: string
  serviceId: string
  csrfToken: string
  payload: PublishPayload
}

interface PublishPayload {
  title: string
  contentHtml: string
  /** 横版封面最终 URL */
  landscapeUrl: string
  landscapeUri: string
  /** 竖版封面 uri（不含 tplv 后缀） */
  portraitUri: string
  portraitWidth: number
  portraitHeight: number
  /** 字数 */
  wordCount: number
}

interface PublishInTabResult {
  ok: boolean
  status?: number
  text?: string
  data?: {
    pgc_id: string
  }
  error?: string
}

/**
 * 懂车帝适配器
 */
export class DongchediAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'dongchedi',
    name: '懂车帝',
    icon: 'https://sf1-cdn-tos.douyinstatic.com/obj/eden-cn/uhbfnupkbps/a/favicon.ico',
    homepage: CREATOR_ORIGIN,
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  /** 预处理配置：懂车帝编辑器接受 HTML（与汽车之家一致） */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  /**
   * 鉴权：调用 notify/count 接口，已登录返回 {status:0, data:{total, unread}}
   */
  async checkAuth(): Promise<AuthResult> {
    try {
      const resp = await this.runtime.fetch(NOTIFY_COUNT_URL, {
        credentials: 'include',
        headers: { Accept: 'application/json, text/plain, */*' },
      })
      if (!resp.ok) {
        return { isAuthenticated: false, error: `HTTP ${resp.status}` }
      }
      const json = await resp.json() as { status?: number; message?: string }
      if (json.status !== 0) {
        return {
          isAuthenticated: false,
          error: json.message || '请先登录懂车帝创作者平台（https://mp.dcdapp.com/）',
        }
      }
      // 解析 cookie 中的 userid 用于展示（可选）
      let userId: string | undefined
      try {
        const cookies = await this.runtime.cookies.get('.dcdapp.com')
        const uidCookie = cookies.find((c) => c.name === 'userid' || c.name === 'uid')
        if (uidCookie?.value) userId = uidCookie.value
      } catch {
        // ignore
      }
      return { isAuthenticated: true, userId, username: '懂车帝创作者' }
    } catch (error) {
      logger.debug('checkAuth error:', error)
      return {
        isAuthenticated: false,
        error: (error as Error).message || '鉴权失败',
      }
    }
  }

  /**
   * 发布文章：先上传封面（横版+竖版）和正文图片，再 POST 发布。
   *
   * ⚠️ 与汽车之家不同，懂车帝所有网络请求（含上传、发布、CSRF 获取）都必须
   * 走 mp.dcdapp.com 页面上下文：MV3 SW fetch 会被 Chrome 强制设 Origin 为
   * `chrome-extension://<id>`，服务端 CORS 拒绝。CLI/mcp-server 等非扩展环境
   * 没有 tabs API，会直接报错。
   */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    const runtimeTabs = this.runtime.tabs
    if (!runtimeTabs) {
      return this.createResult(false, {
        error: '懂车帝发布需要 Chrome 扩展环境（依赖 tabs.executeScript 在 mp.dcdapp.com 页面上下文发起请求）。CLI/MCP 环境下暂不支持。',
      })
    }

    return this.withHeaderRules([], async () => {
      logger.info('Starting publish to Dongchedi...')

      // 0. 鉴权
      const auth = await this.checkAuth()
      if (!auth.isAuthenticated) {
        throw new Error(auth.error || '未登录懂车帝创作者平台')
      }

      // 1. 获取预处理后的 HTML
      let content = article.html || ''

      // 2. 处理正文图片：上传到懂车帝图床
      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['dcdapp.com', 'p0-dcd-private', 'tos-cn-i-f042mdwyw7'],
          onProgress: options?.onImageProgress,
        }
      )

      // 3. 封面处理：
      //    懂车帝是双封面必填：横版 (pgc_feed_covers) + 竖版 (vertical_cover_image)，两者必须
      //    分别上传，不能复用同一张图（横版 4:3、竖版 3:4 原生比例不同，强行复用会被裁切丢失内容）。
      //    - 横版来源：article.coverHorizontal（专用字段，不是通用 cover）
      //    - 竖版来源：article.coverVertical（专用字段，不是通用 cover）
      //    - 通用 cover 字段被忽略，其他单封面平台仍用 cover，互不干扰。
      let cover: CoverInfo | null = null
      const landscapeCover = article.coverHorizontal
      const portraitCover = article.coverVertical
      if (landscapeCover && portraitCover) {
        try {
          cover = await this.uploadCcover(landscapeCover, portraitCover)
          logger.info('Cover uploaded: landscape + portrait')
        } catch (e) {
          logger.warn('Cover upload failed:', e)
        }
      } else if (landscapeCover || portraitCover) {
        // 只提供了一个封面——明确报错，不能静默只用一张
        logger.warn(
          `懂车帝需要双封面（横版 + 竖版）：当前仅提供 ${landscapeCover ? '横版 cover-horizontal' : '竖版 cover-vertical'}` +
          `。请同时填写 cover-horizontal 和 cover-vertical 两个字段（通用的 cover 字段会被忽略）。`,
        )
      } else {
        logger.warn('未提供任何封面，懂车帝发布需要 cover-horizontal + cover-vertical 双封面（通用的 cover 字段会被忽略）')
      }

      // 4. 字数统计（纯文本，去除 HTML 标签）
      const wordCount = this.countWords(content)

      // 5. 获取 CSRF token（HEAD 请求）
      const csrfToken = await this.fetchCsrfToken()

      // 6. 构造发布 payload
      const payload: PublishPayload = {
        title: article.title,
        contentHtml: content,
        landscapeUrl: cover?.landscapeUrl || '',
        landscapeUri: cover?.landscapeUri || '',
        portraitUri: cover?.portraitUri || '',
        portraitWidth: cover?.portraitWidth || VERTICAL_WIDTH,
        portraitHeight: cover?.portraitHeight || VERTICAL_HEIGHT,
        wordCount,
      }

      // 7. 在懂车帝页面上下文中调用发布接口
      const tabId = await this.ensureDongchediTab()
      const result = await runtimeTabs.executeScript<
        PublishInTabResult,
        [UploadAndPublishParams]
      >(tabId, publishInTabScript, [{
        publishUrl: PUBLISH_URL,
        pageOrigin: CREATOR_ORIGIN,
        publishPage: PUBLISH_PAGE,
        notifyCountUrl: NOTIFY_COUNT_URL,
        stsUrl: STS_URL,
        imgGetUrl: IMG_GET_URL,
        serviceId: IMAGEX_SERVICE_ID,
        csrfToken,
        payload,
      }])

      if (!result.ok) {
        throw new Error(result.error || `发布失败 (HTTP ${result.status})`)
      }
      if (!result.data?.pgc_id) {
        throw new Error(`发布失败：响应未含 pgc_id: ${(result.text || '').substring(0, 200)}`)
      }

      const pgcId = result.data.pgc_id
      // save=0 时发布接口实际保存为草稿，返回的是草稿编辑页地址（不是已发布文章链接）
      const postUrl = `https://mp.dcdapp.com/profile_v2/publish/article?pgc_id=${pgcId}`

      return this.createResult(true, {
        postId: pgcId,
        postUrl,
        draftOnly: options?.draftOnly ?? true,
        message: '已保存到懂车帝创作者平台草稿箱',
        coverUploaded: !!cover,
        coverUrl: cover?.landscapeUrl || undefined,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  // ============ 图片上传（公开入口） ============

  /**
   * 上传单张图片（懂车帝 imagex 完整流程：STS → ApplyImageUpload → TOS PUT → CommitImageUpload → get_url）。
   *
   * 数据流：
   *   1. Service Worker 内通过 `tabs.executeScript` 把图片二进制（base64）传入懂车帝页面上下文
   *   2. 页面上下文里：
   *      a. `GET mp.dcdapp.com/motor/car_page/v6/img/get_upload_auth` 拿 STS（已自动带 cookie）
   *      b. AWS4 签名后 `GET imagex.bytedanceapi.com/?Action=ApplyImageUpload&...` 拿 storeUri/sessionKey
   *      c. `PUT tos-{lf|lq|hl}-x.snssdk.com/tos-cn-i-f042mdwyw7/{storeUri}` 上传二进制
   *      d. AWS4 签名后 `POST imagex.bytedanceapi.com/?Action=CommitImageUpload&...` 提交
   *      e. `POST mp.dcdapp.com/motor/car_page/v6/img/get_url` 拿最终可访问的 URL（p0-dcd-private.dcdapp.com）
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.runtime.tabs) {
      logger.warn('[Dongchedi] 非扩展环境（无 tabs API），跳过上传，返回原 URL:', src)
      return { url: src }
    }

    try {
      // 1. 转 base64（跨 executeScript 边界只能用可序列化数据）
      let base64: string
      let mime: string
      let filename: string

      if (src.startsWith('data:')) {
        const dm = src.match(/^data:([^;,]+);base64,(.*)$/s)
        if (!dm) {
          logger.warn('[Dongchedi] 无法解析的 data URI:', src.substring(0, 80))
          return { url: src }
        }
        mime = dm[1] || 'image/jpeg'
        base64 = dm[2]
        const ext = mime.split('/')[1] || 'jpg'
        filename = `${Date.now()}.${ext}`
      } else {
        const encodedSrc = this.encodeUrlPath(src)
        const imageResponse = await fetch(encodedSrc)
        if (!imageResponse.ok) {
          throw new Error(`图片下载失败 (${imageResponse.status}): ${src}`)
        }
        const blob = await imageResponse.blob()
        base64 = await this.blobToBase64(blob)
        mime = blob.type || 'image/jpeg'
        const extFromUrl = this.getFilenameFromUrl(src).split('.').pop() || 'jpg'
        filename = `${Date.now()}.${extFromUrl}`
      }

      // 2. 在懂车帝页面上下文发起上传（一次执行完成所有步骤）
      const tabId = await this.ensureDongchediTab()
      const result = await this.runtime.tabs.executeScript<
        | { ok: true; url: string; storeUri: string; width: number; height: number }
        | { ok: false; error: string; status?: number; text?: string },
        [UploadSingleParams]
      >(tabId, uploadSingleImageScript, [{
        stsUrl: STS_URL,
        imgGetUrl: IMG_GET_URL,
        serviceId: IMAGEX_SERVICE_ID,
        base64,
        mime,
        filename,
      }])

      if (!result.ok) {
        logger.warn('[Dongchedi] 图片上传失败:', result.error, result.text?.substring(0, 200))
        return { url: src }
      }

      const attrs: Record<string, string | number> = {}
      if (result.width) attrs['data-width'] = result.width
      if (result.height) attrs['data-height'] = result.height

      return { url: result.url, attrs }
    } catch (error) {
      logger.warn('[Dongchedi] 图片上传失败，保留原 URL:', src, error)
      return { url: src }
    }
  }

  // ============ 封面上传（私有） ============

  /**
   * 上传封面：横版 + 竖版分别上传（懂车帝是双封面必填，两张图独立）。
   *
   * - `landscapeUrl`：横版封面（信息流推荐位，4:3 容器）
   * - `portraitUrl`：竖版封面（图文详情页背景，3:4 容器）
   *
   * 两张图必须分别上传，每次都走完整的 imagex 流程（STS → ApplyImageUpload → TOS PUT →
   * CommitImageUpload → get_url），拿到独立的 storeUri/url。HAR 样本中横版/竖版
   * 也是两份不同的 storeUri；本适配器不做裁剪/缩放，仅透传服务端字段
   * （thumb_width/height = 600×450、width/height = 600×800 由服务端/CSS 控制显示）。
   */
  private async uploadCcover(landscapeUrl: string, portraitUrl: string): Promise<CoverInfo> {
    // 横版、竖版各自独立上传，不复用同一张图
    const landscape = await this.uploadImageFull(landscapeUrl)
    const portrait = await this.uploadImageFull(portraitUrl)
    return {
      landscapeUrl: landscape.url,
      landscapeUri: landscape.storeUri,
      landscapeThumbWidth: FEED_THUMB_WIDTH,
      landscapeThumbHeight: FEED_THUMB_HEIGHT,
      portraitUri: portrait.storeUri,
      portraitWidth: VERTICAL_WIDTH,
      portraitHeight: VERTICAL_HEIGHT,
      landscapeImageWidth: landscape.width,
      landscapeImageHeight: landscape.height,
      portraitImageWidth: portrait.width,
      portraitImageHeight: portrait.height,
    }
  }

  /**
   * 单张图片上传完整流程（封面与正文共用）：STS → ApplyImageUpload → TOS PUT → CommitImageUpload → get_url。
   * 与 uploadImageByUrl 不同的是，本方法直接返回结构化结果，且不抛错（失败时返回原 URL）。
   */
  private async uploadImageFull(src: string): Promise<ImgUploadResult> {
    if (!this.runtime.tabs) {
      throw new Error('懂车帝发布需要 Chrome 扩展环境')
    }

    let base64: string
    let mime: string
    let filename: string

    if (src.startsWith('data:')) {
      const dm = src.match(/^data:([^;,]+);base64,(.*)$/s)
      if (!dm) throw new Error('无法解析的 data URI')
      mime = dm[1] || 'image/jpeg'
      base64 = dm[2]
      const ext = mime.split('/')[1] || 'jpg'
      filename = `${Date.now()}.${ext}`
    } else {
      const encodedSrc = this.encodeUrlPath(src)
      const imageResponse = await fetch(encodedSrc)
      if (!imageResponse.ok) {
        throw new Error(`图片下载失败 (${imageResponse.status}): ${src}`)
      }
      const blob = await imageResponse.blob()
      base64 = await this.blobToBase64(blob)
      mime = blob.type || 'image/jpeg'
      const extFromUrl = this.getFilenameFromUrl(src).split('.').pop() || 'jpg'
      filename = `${Date.now()}.${extFromUrl}`
    }

    const tabId = await this.ensureDongchediTab()
    const result = await this.runtime.tabs.executeScript<
      | { ok: true; url: string; storeUri: string; width: number; height: number }
      | { ok: false; error: string; status?: number; text?: string },
      [UploadSingleParams]
    >(tabId, uploadSingleImageScript, [{
      stsUrl: STS_URL,
      imgGetUrl: IMG_GET_URL,
      serviceId: IMAGEX_SERVICE_ID,
      base64,
      mime,
      filename,
    }])

    if (!result.ok) {
      throw new Error(result.error + (result.text ? `: ${result.text.substring(0, 200)}` : ''))
    }
    return {
      storeUri: result.storeUri,
      url: result.url,
      width: result.width,
      height: result.height,
    }
  }

  // ============ CSRF Token ============

  /**
   * 获取 CSRF token：HEAD 请求 PUBLISH_URL，带 `x-secsdk-csrf-request: 1` 头。
   * 头条系 sec sdk 在响应头里返回 token，后续 POST 请求必带 `x-secsdk-csrf-token` 头。
   */
  private async fetchCsrfToken(): Promise<string> {
    if (!this.runtime.tabs) {
      throw new Error('懂车帝发布需要 Chrome 扩展环境')
    }
    const tabId = await this.ensureDongchediTab()
    const result = await this.runtime.tabs.executeScript<
      { ok: boolean; token?: string; error?: string; status?: number },
      [string]
    >(tabId, fetchCsrfTokenScript, [PUBLISH_URL])
    if (!result.ok || !result.token) {
      throw new Error(`获取 CSRF token 失败: ${result.error || `HTTP ${result.status}`}`)
    }
    return result.token
  }

  // ============ Tab 管理 ============

  /**
   * 确保存在 mp.dcdapp.com tab（用于在页面上下文发起请求）。
   */
  private async ensureDongchediTab(): Promise<number> {
    const runtimeTabs = this.runtime.tabs
    if (!runtimeTabs) {
      throw new Error('懂车帝发布需要扩展 tabs API 支持')
    }

    const tabs = await runtimeTabs.query('https://mp.dcdapp.com/*')
    const firstTab = tabs[0]
    if (firstTab && firstTab.id !== undefined) {
      logger.debug(`[Dongchedi] 复用已存在的 mp.dcdapp.com tab: ${firstTab.id}`)
      return firstTab.id
    }

    logger.info('[Dongchedi] 没有 mp.dcdapp.com tab，在后台打开编辑器页...')
    const tab = await runtimeTabs.create(PUBLISH_PAGE, false)
    const tabId = tab.id
    if (tabId === undefined) {
      throw new Error('创建懂车帝编辑器 tab 失败')
    }
    await runtimeTabs.waitForLoad(tabId, 30000)
    return tabId
  }

  // ============ 工具方法 ============

  /**
   * 纯文本字数统计（去除 HTML 标签，去首尾空白）
   */
  private countWords(html: string): number {
    const plain = html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
    return plain.length
  }

  /** Blob → base64 字符串（用于跨 executeScript 边界传递图像数据） */
  private async blobToBase64(blob: Blob): Promise<string> {
    const buffer = await blob.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    const chunkSize = 0x8000
    let binary = ''
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize)
      binary += String.fromCodePoint.apply(null, chunk as unknown as number[])
    }
    return btoa(binary)
  }

  /** 从 URL 提取文件名（用于 multipart filename） */
  private getFilenameFromUrl(url: string): string {
    try {
      const pathname = new URL(url).pathname
      const filename = decodeURIComponent(pathname.split('/').pop() || '')
      return filename || 'image.jpg'
    } catch {
      return 'image.jpg'
    }
  }
}

// ============ executeScript 函数（必须是无闭包引用的纯函数） ============

/** executeScript 传入参数：单图上传 */
interface UploadSingleParams {
  stsUrl: string
  imgGetUrl: string
  serviceId: string
  base64: string
  mime: string
  filename: string
}

/**
 * 在 mp.dcdapp.com tab 的 MAIN world 里：
 *   1. GET stsUrl 拿 STS
 *   2. AWS4 签名后 GET imagex ApplyImageUpload
 *   3. PUT 到 tos snssdk 域（带 CRC32、Content-Disposition、X-Storage-U 头）
 *   4. AWS4 签名后 POST imagex CommitImageUpload
 *   5. POST imgGetUrl 拿最终 URL
 *
 * 该函数会被 chrome.scripting.executeScript 序列化/反序列化到页面 MAIN world。
 * 页面 MAIN world 中没有 SW bundle 里定义的辅助函数，且 structured clone
 * 无法序列化闭包引用，因此本函数必须完全自包含：
 * - SHA256 / HMAC-SHA256 / 16 进制转换 / AWS4 签名 / CRC32 / STS user_id 解析
 *   / 随机 s 参数生成 全部内联到函数体内部。
 * - 不允许引用任何模块顶层函数或常量。
 * - 仅依赖页面 MAIN world 原生的全局：fetch / crypto.subtle / TextEncoder /
 *   URL / URLSearchParams / Uint8Array / Array / JSON / Math / Date / atob /
 *   String / Object / Promise。
 */
async function uploadSingleImageScript(params: UploadSingleParams): Promise<
  | { ok: true; url: string; storeUri: string; width: number; height: number }
  | { ok: false; error: string; status?: number; text?: string }
> {
  // ===== 内联辅助函数开始 =====
  const sha256Hex = async (message: string): Promise<string> => {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message))
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }

  const hmacSha256 = async (key: string | ArrayBuffer, message: string): Promise<ArrayBuffer> => {
    const keyData = typeof key === 'string' ? new TextEncoder().encode(key) : key
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message))
  }

  const toHex = (buffer: ArrayBuffer): string => {
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }

  // GET 请求（无 body）的 payload hash：SHA-256("")
  const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

  const crc32Hex = (data: Uint8Array): string => {
    let crc = 0xffffffff
    for (let i = 0; i < data.length; i++) {
      crc = crc ^ data[i]
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
      }
    }
    return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
  }

  const signImageXV4 = async (opts: {
    accessKeyId: string
    secretAccessKey: string
    method: string
    url: string
    headers: Record<string, string>
    payloadHash: string
  }): Promise<string> => {
    const region = 'cn-north-1'
    const service = 'imagex'
    const amzDate = opts.headers['x-amz-date']
    const date = amzDate.slice(0, 8)

    const parsed = new URL(opts.url)
    const canonicalQuery = [...parsed.searchParams.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')

    const signedHeaderNames = Object.keys(opts.headers)
      .filter((h) => h.startsWith('x-amz-'))
      .sort()
    const canonicalHeaders = signedHeaderNames
      .map((h) => `${h}:${opts.headers[h].trim().replace(/\s+/g, ' ')}\n`)
      .join('')
    const signedHeaders = signedHeaderNames.join(';')

    const canonicalRequest = [
      opts.method,
      parsed.pathname || '/',
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      opts.payloadHash,
    ].join('\n')

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      `${date}/${region}/${service}/aws4_request`,
      await sha256Hex(canonicalRequest),
    ].join('\n')

    const kDate = await hmacSha256('AWS4' + opts.secretAccessKey, date)
    const kRegion = await hmacSha256(kDate, region)
    const kService = await hmacSha256(kRegion, service)
    const kSigning = await hmacSha256(kService, 'aws4_request')
    const signature = toHex(await hmacSha256(kSigning, stringToSign))

    return `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${date}/${region}/${service}/aws4_request, SignedHeaders=${signedHeaders}, Signature=${signature}`
  }

  const parseUserIdFromSTSForPage = (sessionToken: string): string => {
    if (!sessionToken || !sessionToken.startsWith('STS2')) return ''
    try {
      const b64 = sessionToken.slice(4).replace(/-/g, '+').replace(/_/g, '/')
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
      const decoded = atob(padded)
      const obj = JSON.parse(decoded) as { PolicyString?: string }
      if (!obj.PolicyString) return ''
      const policy = JSON.parse(obj.PolicyString) as {
        Statement?: Array<{ Condition?: string }>
      }
      const condStr = policy.Statement?.[0]?.Condition
      if (typeof condStr !== 'string') return ''
      const cond = JSON.parse(condStr) as { UserId?: string }
      return cond.UserId || ''
    } catch {
      return ''
    }
  }

  /**
   * 从懂车帝页面 cookie 中读取当前登录用户的 userid，作为 TOS PUT 时
   * `X-Storage-U` 头的兜底值（懂车帝 STS 的 PolicyString 不含 UserId）。
   *
   * 字节系 slardar SDK 上报的 `common.user_id` 与此 cookie 一致。
   * 尝试常见名：`userid` / `uid` / `tt_userid`。
   */
  const readUserIdFromCookie = (): string => {
    try {
      if (typeof document === 'undefined') return ''
      const m = document.cookie.match(/(?:^|;\s*)(?:userid|uid|tt_userid)=([^;]+)/i)
      if (!m) return ''
      const raw = m[1]
      try { return decodeURIComponent(raw) } catch { return raw }
    } catch {
      return ''
    }
  }

  const generateRandomSForPage = (): string => {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyz'
    let result = ''
    for (let i = 0; i < 11; i++) {
      result += chars[Math.floor(Math.random() * chars.length)]
    }
    return result
  }
  // ===== 内联辅助函数结束 =====

  const { stsUrl, imgGetUrl, serviceId, base64, mime, filename } = params

  try {
    // Step 1: 获取 STS
    const stsResp = await fetch(stsUrl, {
      method: 'GET',
      credentials: 'include',
    })
    if (!stsResp.ok) {
      const text = await stsResp.text()
      return { ok: false, error: `获取 STS 失败`, status: stsResp.status, text: text.substring(0, 200) }
    }
    const stsJson = await stsResp.json() as { status?: number; data?: { token?: STSInfoInternal } }
    if (stsJson.status !== 0 || !stsJson.data?.token) {
      return { ok: false, error: '获取 STS 失败：响应异常', text: JSON.stringify(stsJson).substring(0, 200) }
    }
    const sts = stsJson.data.token
    // 优先从 STS SessionToken 解析 user_id；懂车帝 STS 的 PolicyString 中
    // 没有 Condition/UserId 字段（与抖音 / 头条创作平台不同），这里通常返回空。
    // 拿不到时改为从页面 cookie 兜底读取，最后才退回不携带 X-Storage-U。
    let userId = parseUserIdFromSTSForPage(sts.SessionToken)
    if (!userId) {
      userId = readUserIdFromCookie()
    }
    if (userId) {
      console.debug('[Dongchedi] imagex user_id resolved, length:', userId.length)
    } else {
      console.warn('[Dongchedi] imagex user_id 未解析到且 cookie 中也无 userid/uid，TOS PUT 将不发送 X-Storage-U 头')
    }

    // Step 2: 构造图片字节
    const byteString = atob(base64)
    const bytes = new Uint8Array(byteString.length)
    for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i)
    const crc32 = crc32Hex(bytes)

    // Step 3: ApplyImageUpload
    const applyParams = new URLSearchParams({
      Action: 'ApplyImageUpload',
      Version: '2018-08-01',
      ServiceId: serviceId,
      s: generateRandomSForPage(),
    })
    const applyUrl = `https://imagex.bytedanceapi.com/?${applyParams.toString()}`
    const applyDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
    const applyHeaders: Record<string, string> = {
      'x-amz-date': applyDate,
      'x-amz-security-token': sts.SessionToken,
    }
    applyHeaders.authorization = await signImageXV4({
      accessKeyId: sts.AccessKeyId,
      secretAccessKey: sts.SecretAccessKey,
      method: 'GET',
      url: applyUrl,
      headers: applyHeaders,
      payloadHash: EMPTY_SHA256,
    })

    const applyResp = await fetch(applyUrl, {
      method: 'GET',
      credentials: 'omit',
      headers: applyHeaders,
    })
    const applyText = await applyResp.text()
    if (!applyResp.ok) {
      return { ok: false, error: `ApplyImageUpload 失败`, status: applyResp.status, text: applyText.substring(0, 200) }
    }
    const applyData = JSON.parse(applyText) as {
      Result?: { UploadAddress: { StoreInfos: Array<{ StoreUri: string; Auth: string }>; UploadHosts: string[]; SessionKey: string } }
      ResponseMetadata?: { Error?: { Code?: string; Message?: string } }
    }
    const uploadAddress = applyData.Result?.UploadAddress
    if (!uploadAddress) {
      const err = applyData.ResponseMetadata?.Error
      return { ok: false, error: `ApplyImageUpload 返回空: ${err?.Code}: ${err?.Message}` }
    }

    const storeUri = uploadAddress.StoreInfos[0]?.StoreUri
    const uploadHost = uploadAddress.UploadHosts[0]
    const tosAuth = uploadAddress.StoreInfos[0]?.Auth || ''
    const sessionKey = uploadAddress.SessionKey
    if (!storeUri || !uploadHost) {
      return { ok: false, error: 'ApplyImageUpload 响应缺 StoreUri/UploadHost' }
    }

    // Step 4: PUT 到 TOS
    const tosUrl = `https://${uploadHost}/${storeUri}`
    const tosHeaders: Record<string, string> = {
      Authorization: tosAuth,
      'Content-Type': mime || 'application/octet-stream',
      'Content-CRC32': crc32,
      'Content-Disposition': `attachment; filename="${filename}"`,
    }
    // X-Storage-U 仅在能拿到 user_id 时携带（抓包确认懂车帝 PUT 必带；
    // 拿不到时省略以容错，避免空值头反而被服务端拒绝）
    if (userId) {
      tosHeaders['X-Storage-U'] = userId
    }
    const putResp = await fetch(tosUrl, {
      method: 'PUT',
      credentials: 'omit',
      headers: tosHeaders,
      body: bytes,
    })
    const putText = await putResp.text()
    if (!putResp.ok) {
      return { ok: false, error: `TOS PUT 失败`, status: putResp.status, text: putText.substring(0, 200) }
    }

    // Step 5: CommitImageUpload
    const commitParams = new URLSearchParams({
      Action: 'CommitImageUpload',
      Version: '2018-08-01',
      SessionKey: sessionKey,
    })
    const commitUrl = `https://imagex.bytedanceapi.com/?${commitParams.toString()}`
    const commitDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
    const commitBody = JSON.stringify({ SessionKey: sessionKey })
    const commitPayloadHash = await sha256Hex(commitBody)
    const commitHeaders: Record<string, string> = {
      'x-amz-date': commitDate,
      'x-amz-security-token': sts.SessionToken,
      'x-amz-content-sha256': commitPayloadHash,
    }
    commitHeaders.authorization = await signImageXV4({
      accessKeyId: sts.AccessKeyId,
      secretAccessKey: sts.SecretAccessKey,
      method: 'POST',
      url: commitUrl,
      headers: commitHeaders,
      payloadHash: commitPayloadHash,
    })
    commitHeaders['Content-Type'] = 'application/json'

    const commitResp = await fetch(commitUrl, {
      method: 'POST',
      credentials: 'omit',
      headers: commitHeaders,
      body: commitBody,
    })
    const commitText = await commitResp.text()
    if (!commitResp.ok) {
      return { ok: false, error: `CommitImageUpload 失败`, status: commitResp.status, text: commitText.substring(0, 200) }
    }
    const commitData = JSON.parse(commitText) as {
      Result?: { PluginResult?: Array<{ ImageWidth?: number; ImageHeight?: number }> }
    }
    const width = commitData.Result?.PluginResult?.[0]?.ImageWidth || 0
    const height = commitData.Result?.PluginResult?.[0]?.ImageHeight || 0

    // Step 6: get_url（拿到最终可访问 URL）
    const getUrlBody = new URLSearchParams({
      img_uris: storeUri,
      img_url_type: '2',
      img_param: 'noop',
      img_format: 'image',
    })
    const getUrlResp = await fetch(imgGetUrl, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      body: getUrlBody,
    })
    const getUrlText = await getUrlResp.text()
    if (!getUrlResp.ok) {
      return { ok: false, error: `get_url 失败`, status: getUrlResp.status, text: getUrlText.substring(0, 200) }
    }
    const getUrlData = JSON.parse(getUrlText) as {
      status?: number
      data?: { img_url_map?: Record<string, { main_url: string; backup_url: string }> }
    }
    if (getUrlData.status !== 0) {
      return { ok: false, error: 'get_url 返回 status !== 0', text: getUrlText.substring(0, 200) }
    }
    const finalUrl = getUrlData.data?.img_url_map?.[storeUri]?.main_url
    if (!finalUrl) {
      return { ok: false, error: 'get_url 未返回 main_url', text: getUrlText.substring(0, 200) }
    }

    return { ok: true, url: finalUrl, storeUri, width, height }
  } catch (e) {
    return { ok: false, error: (e as Error).message || '未知错误' }
  }
}

/**
 * 在懂车帝页面上下文调用发布接口（POST publish_mp_article/v1）。
 *
 * 该函数会被 chrome.scripting.executeScript 序列化/反序列化，必须是纯函数。
 */
async function publishInTabScript(params: UploadAndPublishParams): Promise<PublishInTabResult> {
  const { publishUrl, pageOrigin, publishPage, csrfToken, payload } = params

  try {
    const body = {
      extra: {
        timer_status: 0,
        timer_time: '',
        article_ad_type: 3,
        vertical_cover_image: payload.portraitUri
          ? JSON.stringify({
              uri: payload.portraitUri,
              width: payload.portraitWidth,
              height: payload.portraitHeight,
              is_ai_cover: false,
            })
          : '',
        pgc_feed_covers: payload.landscapeUrl
          ? [{
              url: payload.landscapeUrl,
              uri: payload.landscapeUri,
              thumb_width: 600,
              thumb_height: 450,
            }]
          : [],
        content_word_cnt: payload.wordCount,
        title_id: '',
      },
      save: 0,
      publisher_ai_info: '{"use_ai_img":0,"ai_img_list":[]}',
      title: payload.title,
      content: payload.contentHtml,
      source: 20,
    }

    const resp = await fetch(publishUrl, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-secsdk-csrf-token': csrfToken,
        Origin: pageOrigin,
        Referer: publishPage,
      },
      body: JSON.stringify(body),
    })

    const text = await resp.text()
    if (!resp.ok) {
      return { ok: false, status: resp.status, text: text.substring(0, 500), error: `HTTP ${resp.status}` }
    }

    let json: {
      status?: number
      message?: string
      data?: {
        code?: number
        data?: { pgc_id?: string; content?: string; pgc_feed_covers?: Array<unknown> }
      }
    }
    try {
      json = JSON.parse(text)
    } catch {
      return { ok: false, status: resp.status, text: text.substring(0, 500), error: '响应非 JSON' }
    }

    // 成功响应：{status:0, data:{code:0, data:{pgc_id}}}。code 为 0 表示成功，
    // 不能用真值判断（0 是 falsy），必须显式比较 !== 0。
    if (json.status !== 0 || json.data?.code !== 0) {
      return {
        ok: false,
        status: resp.status,
        text: text.substring(0, 500),
        error: json.message || `发布失败：status=${json.status}, data.code=${json.data?.code}`,
      }
    }
    const pgcId = json.data?.data?.pgc_id
    if (!pgcId) {
      return { ok: false, status: resp.status, text: text.substring(0, 500), error: '响应未含 pgc_id' }
    }

    return { ok: true, data: { pgc_id: pgcId }, text }
  } catch (e) {
    return { ok: false, error: (e as Error).message || '未知错误' }
  }
}

/**
 * HEAD 请求发布接口，从响应头取 CSRF token。
 * 该函数会被 chrome.scripting.executeScript 序列化/反序列化，必须是纯函数。
 */
async function fetchCsrfTokenScript(publishUrl: string): Promise<{ ok: boolean; token?: string; error?: string; status?: number }> {
  try {
    const resp = await fetch(publishUrl, {
      method: 'HEAD',
      credentials: 'include',
      headers: {
        'x-secsdk-csrf-request': '1',
        'x-secsdk-csrf-version': '1.2.22',
      },
    })
    if (!resp.ok) {
      return { ok: false, status: resp.status, error: `HTTP ${resp.status}` }
    }
    // 抓包验证：响应头实际为 `x-ware-csrf-token`，格式 "0,{token},86370000,success,{session_id}"，
    // 实际 token 是逗号分隔的第 2 段；POST 时将其放入 `x-secsdk-csrf-token` 请求头。
    // 部分环境可能直接返回 x-secsdk-csrf-token，两种头都兼容读取。
    let token = resp.headers.get('x-secsdk-csrf-token') || ''
    if (!token) {
      const wareToken = resp.headers.get('x-ware-csrf-token') || ''
      const parts = wareToken.split(',')
      if (parts.length >= 2) {
        token = parts[1]
      }
    }
    if (!token) {
      return { ok: false, status: resp.status, error: '响应头未含 x-ware-csrf-token / x-secsdk-csrf-token' }
    }
    return { ok: true, token }
  } catch (e) {
    return { ok: false, error: (e as Error).message || '未知错误' }
  }
}
