/**
 * 少数派（sspai.com / Matrix）适配器
 *
 * 平台资料：
 * - 创建文章：https://sspai.com/write
 * - 编辑文章：https://sspai.com/write/{id}
 * - 草稿箱：https://sspai.com/my/post/draft
 *
 * 鉴权（HAR 验证）：
 *   与少数派前端约定一致：所有 /api/v1 请求携带 `Authorization: Bearer <ssToken>`。
 *   token 由前端登录后写入 localStorage 的 `ssToken`，同时通过 js-cookie 写入
 *   cookie `sspai_jwt_token`（path=/，360 天）与 `sspai_cross_token`（domain=sspai.com）。
 *   所以 token 获取顺序为：
 *     1. sspai.com 页面上下文 localStorage.ssToken（最可靠，实时值）
 *     2. chrome.cookies 读 `sspai_jwt_token` / `sspai_cross_token` 兜底（无需开 tab）
 *   注意：服务端只认 Authorization 头，单靠 cookie 不鉴权
 *   （无 token → `{ error: 3004, msg: "请登录" }`；token 无效 → HTTP 401 invalid jwt）。
 *
 * 图片上传（HAR 验证，两步）：
 *   1. GET /api/v1/matrix/editor/attachment/upload/token/get?cname=<uuid>.<ext>
 *      → { data: { file_path, id, key, token }, error: 0 }
 *        - key      ：七牛对象名（形如 2026/09/20/<md5>.png）
 *        - file_path：上传后的 CDN 地址（https://cdnfile.sspai.com/<key>）
 *        - id       ：附件 ID，作为题图 banner_id / 文中图片 id
 *        - token    ：七牛上传凭证（内含 deadline、fsizeLimit 5MB、
 *                     mimeLimit = "!text/html;image/svg+xml;image/webp" 黑名单）
 *   2. POST https://upload.qiniup.com/（multipart：file / token / key）
 *      → { hash, key }
 *   七牛 mime 黑名单包含 image/webp，webp 会被拒收，故这里统一转 PNG 后再上传。
 *
 * 保存草稿（HAR 验证）：
 *   1. POST /api/v1/matrix/editor/article/add
 *      body: { type:4, title, title_last, body, body_last, banner, banner_id,
 *              allow_comment, tags, custom_tags, delete_status }
 *      → { data: { id, token, ... }, error: 0 }（新建即草稿，无需额外“存草稿”动作）
 *   2. POST /api/v1/matrix/editor/article/update
 *      body: add 返回的完整对象 + 最新 title / body / banner
 *      → { data: { id, type: "draft" }, error: 0 }
 *      （update 响应里的 type:"draft" 即表示当前文章处于草稿态）
 *
 * 字段语义：
 *   - title / body            正式字段（服务端保存的最终值）
 *   - title_last / body_last  编辑器「用户最后编辑」快照，用于本地缓存与云端脏数据比对，
 *                             必须与 title / body 成对写入，否则编辑器下次打开会提示本地覆盖
 *   - banner / banner_id      题图（封面）。banner 是七牛 key，banner_id 是
 *                             upload/token/get 返回的附件 id
 *   - type                    编辑器默认值 4（图文文章），HAR 与编辑器工厂函数一致
 *   - tags / custom_tags      tags 是平台已有标签对象数组（编辑器按 s.title 渲染），
 *                             custom_tags 才是纯字符串数组；同步来源的标签无法保证
 *                             命中平台已有标签，故 Article.tags 统一写入 custom_tags
 *                             （少数派编辑器对用户手输标签也是这么处理的）
 *
 * 请求模式：
 * - 少数派 API 响应头为 `Access-Control-Allow-Origin: *`，扩展 SW 直连可用；
 *   为与 HAR 完全对齐，这里通过 headerRules 注入 Origin/Referer（仅扩展环境生效）。
 * - 获取 token 需要读页面 localStorage，因此扩展环境会复用/按需新建一个
 *   sspai.com tab 执行 executeScript（MAIN world）。
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Sspai')

/** 站点 origin */
const SITE_ORIGIN = 'https://sspai.com'

/** API 基础地址 */
const API_BASE = `${SITE_ORIGIN}/api/v1`

/** 创建文章页（HAR 抓包的 Referer） */
const EDITOR_PAGE = `${SITE_ORIGIN}/write`

/** 草稿箱（保存成功后的落点） */
const DRAFT_LIST = `${SITE_ORIGIN}/my/post/draft`

/** 用户信息接口（checkAuth 用） */
const USER_INFO_URL = `${API_BASE}/user/info/get`

/** 图片上传凭证接口 */
const UPLOAD_TOKEN_URL = `${API_BASE}/matrix/editor/attachment/upload/token/get`

/** 七牛上传地址（少数派前端固定使用该 host） */
const QINIU_UPLOAD_URL = 'https://upload.qiniup.com/'

/** 新建文章接口（返回 id + token） */
const ARTICLE_ADD_URL = `${API_BASE}/matrix/editor/article/add`

/** 更新文章接口（落库最终正文） */
const ARTICLE_UPDATE_URL = `${API_BASE}/matrix/editor/article/update`

/** 附件 CDN 前缀（file_path 已含完整域名，这里仅用于兜底拼接） */
const CDN_PREFIX = 'https://cdnfile.sspai.com/'

/** 文章类型：4 = 图文文章（编辑器默认值） */
const ARTICLE_TYPE = 4

/** 少数派编辑器在 localStorage 中存放登录 token 的键名 */
const SS_TOKEN_KEY = 'ssToken'

/** token 兜底 cookie（前端 setToken 时一并写入） */
const SS_TOKEN_COOKIES = ['sspai_jwt_token', 'sspai_cross_token']

/** 图片上传凭证响应 */
interface SspaiUploadTokenResp {
  data?: {
    /** CDN 访问地址（完整 URL） */
    file_path?: string
    /** 附件 ID */
    id?: number
    /** 七牛对象名 */
    key?: string
    /** 七牛上传凭证 */
    token?: string
  }
  error?: number
  msg?: string
  [key: string]: unknown
}

/** 七牛上传响应 */
interface QiniuUploadResp {
  hash?: string
  key?: string
  error?: string
}

/** 用户信息响应 */
interface SspaiUserInfoResp {
  data?: {
    id?: number | string
    nickname?: string
    name?: string
    username?: string
    slug?: string
    avatar?: string
    member?: { is_pay?: boolean; is_expire?: boolean }
    [key: string]: unknown
  }
  error?: number
  msg?: string
  message?: string
}

/** 新建文章响应 */
interface SspaiArticleAddResp {
  data?: SspaiArticleData
  error?: number
  msg?: string
  message?: string
}

/** 文章数据对象（对齐少数派编辑器内部结构） */
interface SspaiArticleData {
  id?: number
  token?: string
  type?: number
  title?: string
  title_last?: string
  body?: string
  body_last?: string
  banner?: string
  banner_id?: number
  /** 平台已有标签：`{ title, id }`（少数派前端按 s.title 渲染） */
  tags?: Array<string | { title?: string; id?: number | string }>
  /** 自定义标签：纯字符串数组 */
  custom_tags?: string[]
  allow_comment?: boolean
  delete_status?: boolean
  [key: string]: unknown
}

/** 更新文章响应 */
interface SspaiArticleUpdateResp {
  data?: { id?: number; type?: string }
  error?: number
  msg?: string
  message?: string
}

/** 单张图片上传结果 */
interface SspaiImageUploadResult {
  /** CDN 访问地址 */
  url: string
  /** 七牛对象名（题图 banner 用） */
  key: string
  /** 附件 ID（题图 banner_id 用） */
  id: number
}

/** 保存草稿入参 */
interface SaveDraftParams {
  title: string
  content: string
  /** 题图七牛 key（无封面上传时为空串） */
  banner: string
  /** 题图附件 ID（无封面上传时为 0） */
  bannerId: number
  /**
   * 自定义标签（纯字符串数组）。
   *
   * 少数派文章的 `tags` 是平台已有标签对象 `{ title, id }`，`custom_tags` 才是
   * 用户自定义的纯字符串数组（编辑器里 tags 渲染 `s.title`，custom_tags 渲染字符串本身）。
   * 同步来源的标签无法保证是平台已有标签，统一放进 custom_tags 更安全。
   */
  customTags: string[]
  /** update 阶段需要带上的 add 响应对象 */
  created: SspaiArticleData
}

export class SspaiAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'sspai',
    name: '少数派',
    icon: 'https://cdn-static.sspai.com/favicon/sspai.ico',
    homepage: EDITOR_PAGE,
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  /** 预处理配置：少数派编辑器正文为 HTML */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  /**
   * 当前 publish 会话内已解析的 token。
   * 正文图片逐张上传时复用，避免每次都去页面 / cookie 里再取一遍。
   */
  private activeToken: string | null = null

  /**
   * Header 规则：对齐 HAR 抓包（Origin / Referer）。
   * 少数派 API 的 ACAO 为 *，SW 直连本身可用，这里仅做进一步对齐，
   * 避免服务端未来收紧校验。
   */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://sspai.com/*',
      headers: {
        Origin: SITE_ORIGIN,
        Referer: EDITOR_PAGE,
      },
    },
    {
      urlFilter: '*://upload.qiniup.com/*',
      headers: {
        Origin: SITE_ORIGIN,
        Referer: EDITOR_PAGE,
      },
    },
  ]

  // ============ checkAuth ============

  /**
   * 鉴权：拿到 token 后调用 /user/info/get
   * - error === 0 且 data 存在 → 已登录
   * - error === 3004 / HTTP 401 → 未登录（或登录态过期）
   * 不主动新建 tab（批量检查登录态时逐个开 tab 太重），仅在已有 sspai tab 时读 localStorage。
   */
  async checkAuth(): Promise<AuthResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      try {
        const token = await this.resolveToken(false)
        if (!token) {
          return {
            isAuthenticated: false,
            error: '请先登录少数派（https://sspai.com/write）',
          }
        }

        const resp = await this.runtime.fetch(USER_INFO_URL, {
          headers: this.authHeaders(token),
        })
        const text = await resp.text()

        let data: SspaiUserInfoResp | null = null
        try {
          data = JSON.parse(text) as SspaiUserInfoResp
        } catch {
          return { isAuthenticated: false, error: `user/info/get 响应解析失败（HTTP ${resp.status}）` }
        }

        if (data?.error === 0 && data.data) {
          const user = data.data
          return {
            isAuthenticated: true,
            userId: user.id !== undefined ? String(user.id) : undefined,
            username: user.nickname || user.name || user.username || user.slug,
            avatar: user.avatar,
          }
        }

        if (resp.status === 401 || data?.error === 3004) {
          return { isAuthenticated: false, error: '登录态已失效，请重新登录少数派' }
        }

        return {
          isAuthenticated: false,
          error: data?.msg || data?.message || `鉴权失败：error=${data?.error}`,
        }
      } catch (error) {
        logger.debug('checkAuth error:', error)
        return {
          isAuthenticated: false,
          error: (error as Error).message || '鉴权失败',
        }
      }
    })
  }

  // ============ publish ============

  /**
   * 发布文章（保存草稿）。
   *
   * 流程（HAR 验证）：
   *   1. 解析 token（页面 localStorage → cookie 兜底）
   *   2. 处理正文图片（上传到少数派图床，替换 src）
   *   3. 上传封面 → banner(key) + banner_id
   *   4. POST article/add  → 拿 id + token
   *   5. POST article/update 带上完整对象，落库最终正文
   */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish to Sspai...')

      // 1. 鉴权 + 取 token
      const token = await this.resolveToken(true)
      if (!token) {
        throw new Error('请先登录少数派（https://sspai.com/write）')
      }
      this.activeToken = token

      // 2. 处理正文图片
      let content = article.html || ''
      try {
        content = await this.processImages(
          content,
          (src) => this.uploadImageByUrl(src),
          {
            skipPatterns: ['sspai.com', 'cdnfile.sspai.com'],
            onProgress: options?.onImageProgress,
          },
        )
      } catch (e) {
        logger.warn('[Sspai] processImages 中途失败，继续发布：', (e as Error).message)
      }

      // 3. 封面上传（少数派题图 banner / banner_id）
      let banner = ''
      let bannerId = 0
      let coverError: string | undefined
      if (article.cover) {
        try {
          const cover = await this.uploadImageToCdn(article.cover, token)
          banner = cover.key
          bannerId = cover.id
          logger.info(`[Sspai] 封面上传成功：${cover.url}`)
        } catch (e) {
          coverError = (e as Error).message
          logger.warn('[Sspai] 封面上传失败：', coverError)
        }
      } else {
        logger.warn('[Sspai] 未提供封面（article.cover），banner 为空')
      }

      // 4. 新建文章（即草稿）
      const created = await this.createArticle({
        title: article.title,
        content,
        banner,
        bannerId,
        customTags: article.tags ?? [],
        token,
      })

      // 5. 更新文章，落库最终正文
      await this.updateArticle({
        title: article.title,
        content,
        banner,
        bannerId,
        customTags: article.tags ?? [],
        created,
        token,
      })

      const postId = created.id !== undefined ? String(created.id) : undefined
      logger.info(`[Sspai] 草稿已保存：${postId ?? '(未知 id)'}`)

      return this.createResult(true, {
        postId,
        postUrl: postId ? `${SITE_ORIGIN}/write/${postId}` : DRAFT_LIST,
        draftOnly: options?.draftOnly ?? true,
        coverUploaded: !!banner,
        coverUrl: banner ? `${CDN_PREFIX}${banner}` : undefined,
        ...(coverError ? { coverError } : {}),
        message: '已保存到少数派草稿箱（https://sspai.com/my/post/draft）',
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    })).finally(() => {
      this.activeToken = null
    })
  }

  // ============ 图片上传 ============

  /**
   * 正文图片上传（被 processImages 调用）。
   * 与封面上传共用 `uploadImageToCdn`，失败时保留原 URL 不阻断整体同步。
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    try {
      const token = this.activeToken || (await this.resolveToken(false))
      if (!token) {
        throw new Error('未登录少数派，无法上传图片')
      }
      const result = await this.uploadImageToCdn(src, token)
      return { url: result.url }
    } catch (error) {
      logger.warn('[Sspai] 正文图片上传失败，保留原 URL:', src, error)
      return { url: src }
    }
  }

  /**
   * 上传单张图片（正文 / 封面共用）。
   *
   * @param src 图片 URL 或 data URI
   * @param token 少数派登录 token（Authorization: Bearer）
   */
  private async uploadImageToCdn(src: string, token: string): Promise<SspaiImageUploadResult> {
    // 1. 取图片二进制
    let blob: Blob
    if (src.startsWith('data:')) {
      blob = await this.dataUriToBlob(src)
    } else {
      const encodedSrc = this.encodeUrlPath(src)
      const imageResponse = await fetch(encodedSrc, { credentials: 'omit' })
      if (!imageResponse.ok) {
        throw new Error(`图片下载失败 (${imageResponse.status}): ${src}`)
      }
      blob = await imageResponse.blob()
    }

    // 2. webp 会被七牛 mime 黑名单拒绝，统一转 PNG
    blob = await this.ensureUploadableImage(blob)

    // 3. 取上传凭证（cname = <uuid>.<ext>，对齐编辑器 `${uuid()}.${ext}`）
    const cname = `${this.uuid()}.${this.extensionFor(blob.type)}`
    const credential = await this.requestUploadToken(cname, token)

    // 4. 上传到七牛（multipart：file / token / key）
    const formData = new FormData()
    formData.append('file', blob, 'blob')
    formData.append('token', credential.token)
    formData.append('key', credential.key)

    const uploadResp = await this.runtime.fetch(QINIU_UPLOAD_URL, {
      method: 'POST',
      credentials: 'omit',
      headers: { Accept: 'application/json, text/plain, */*' },
      body: formData,
    })
    const uploadText = await uploadResp.text()
    let uploadData: QiniuUploadResp
    try {
      uploadData = JSON.parse(uploadText) as QiniuUploadResp
    } catch {
      throw new Error(`图片上传失败：七牛响应非 JSON (HTTP ${uploadResp.status}): ${uploadText.substring(0, 200)}`)
    }
    if (!uploadResp.ok || uploadData.error || !uploadData.key) {
      throw new Error(`图片上传失败：${uploadData.error || `HTTP ${uploadResp.status}`}`)
    }

    // file_path 即 CDN 访问地址；缺失时用 key 兜底拼接
    const url = credential.filePath || `${CDN_PREFIX}${uploadData.key}`
    return { url, key: uploadData.key, id: credential.id }
  }

  /**
   * 申请图片上传凭证。
   * 响应：`{ data: { file_path, id, key, token }, error: 0 }`
   */
  private async requestUploadToken(
    cname: string,
    token: string,
  ): Promise<{ filePath: string; id: number; key: string; token: string }> {
    const url = `${UPLOAD_TOKEN_URL}?cname=${encodeURIComponent(cname)}`
    const resp = await this.runtime.fetch(url, {
      headers: this.authHeaders(token),
    })
    const text = await resp.text()

    let data: SspaiUploadTokenResp
    try {
      data = JSON.parse(text) as SspaiUploadTokenResp
    } catch {
      throw new Error(`获取上传凭证失败：响应非 JSON (HTTP ${resp.status}): ${text.substring(0, 200)}`)
    }

    if (data.error !== 0 || !data.data) {
      throw new Error(data.msg || `获取上传凭证失败：error=${data.error}`)
    }

    const { file_path: filePath, id, key, token: qiniuToken } = data.data
    if (!key || !qiniuToken) {
      throw new Error('获取上传凭证失败：响应缺少 key / token')
    }

    return {
      filePath: filePath || '',
      id: typeof id === 'number' ? id : 0,
      key,
      token: qiniuToken,
    }
  }

  /**
   * 把七牛 mime 黑名单里的 webp 转成 PNG。
   * 其它类型原样返回；转换失败（环境不支持 OffscreenCanvas 等）也原样返回，
   * 由服务端拒绝并走「保留原 URL」的降级路径。
   *
   * 注：黑名单还含 text/html 与 image/svg+xml，但这两种在 Service Worker 里
   * 无法可靠解码转码（createImageBitmap 不保证支持 SVG），故不在此处理。
   */
  private async ensureUploadableImage(blob: Blob): Promise<Blob> {
    const mime = (blob.type || '').toLowerCase()
    if (!mime.includes('webp')) return blob

    try {
      const bitmap = await createImageBitmap(blob)
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        bitmap.close()
        return blob
      }
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
      return await canvas.convertToBlob({ type: 'image/png' })
    } catch (error) {
      logger.warn('[Sspai] webp 转 PNG 失败，按原格式上传：', (error as Error).message)
      return blob
    }
  }

  // ============ 文章创建 / 更新 ============

  /**
   * 新建文章（少数派新建即草稿）。
   * 字段对齐 HAR 抓包的最小集合；`title_last` / `body_last` 必须一并写入。
   */
  private async createArticle(params: {
    title: string
    content: string
    banner: string
    bannerId: number
    /** 自定义标签（纯字符串数组，见 SaveDraftParams.customTags 说明） */
    customTags: string[]
    token: string
  }): Promise<SspaiArticleData> {
    const payload = {
      type: ARTICLE_TYPE,
      banner: params.banner,
      banner_id: params.bannerId,
      title: params.title,
      title_last: params.title,
      body: params.content,
      body_last: params.content,
      allow_comment: true,
      // 平台已有标签需要 { title, id }，同步来源无法保证，统一放入 custom_tags
      tags: [] as string[],
      custom_tags: params.customTags,
      delete_status: false,
    }

    const resp = await this.runtime.fetch(ARTICLE_ADD_URL, {
      method: 'POST',
      headers: this.authHeaders(params.token),
      body: JSON.stringify(payload),
    })
    const text = await resp.text()

    let data: SspaiArticleAddResp
    try {
      data = JSON.parse(text) as SspaiArticleAddResp
    } catch {
      throw new Error(`新建文章失败：响应非 JSON (HTTP ${resp.status}): ${text.substring(0, 200)}`)
    }

    if (data.error !== 0 || !data.data || data.data.id === undefined) {
      throw new Error(data.msg || data.message || `新建文章失败：error=${data.error}`)
    }

    return data.data
  }

  /**
   * 更新文章，落库最终正文。
   *
   * 沿用 add 返回的完整对象（含 id / token / created_at 等），
   * 只覆盖 title / body / banner / tags 等业务字段 —— 与 HAR 抓包的 update
   * 请求体结构一致。响应 `data.type === 'draft'` 表示当前为草稿态。
   */
  private async updateArticle(params: SaveDraftParams & { token: string }): Promise<void> {
    const { created, title, content, banner, bannerId, customTags, token } = params

    const payload: SspaiArticleData = {
      ...created,
      title,
      title_last: title,
      body: content,
      body_last: content,
      banner,
      banner_id: bannerId,
      type: ARTICLE_TYPE,
      // tags 沿用 add 返回的平台标签结构，同步来源的标签统一进 custom_tags
      custom_tags: customTags,
      allow_comment: true,
    }

    const resp = await this.runtime.fetch(ARTICLE_UPDATE_URL, {
      method: 'POST',
      headers: this.authHeaders(token),
      body: JSON.stringify(payload),
    })
    const text = await resp.text()

    let data: SspaiArticleUpdateResp
    try {
      data = JSON.parse(text) as SspaiArticleUpdateResp
    } catch {
      throw new Error(`更新文章失败：响应非 JSON (HTTP ${resp.status}): ${text.substring(0, 200)}`)
    }

    if (data.error !== 0 || !data.data) {
      throw new Error(data.msg || data.message || `更新文章失败：error=${data.error}`)
    }
  }

  // ============ Token 获取 ============

  /** 统一的鉴权请求头 */
  private authHeaders(token: string): Record<string, string> {
    return {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    }
  }

  /**
   * 解析登录 token。
   *
   * 顺序（越靠前越可靠，且尽量不做多余动作）：
   *   1. 已有 sspai.com tab → 读页面 localStorage.ssToken
   *   2. cookie `sspai_jwt_token` / `sspai_cross_token`（无需开 tab）
   *   3. allowCreateTab 时才新建 tab 再读一次 localStorage（publish 场景兜底）
   *
   * @param allowCreateTab 是否允许新建后台 tab。checkAuth 批量跑时为 false，
   *                       避免一次登录态检查弹出一堆后台 tab。
   */
  private async resolveToken(allowCreateTab: boolean): Promise<string | null> {
    // 1. 复用已有 tab
    const existingTabId = await this.findSspaiTab()
    if (existingTabId !== null) {
      const fromTab = await this.readSsTokenFromTab(existingTabId)
      if (fromTab) return fromTab
    }

    // 2. cookie 兜底
    const fromCookie = await this.readTokenFromCookie()
    if (fromCookie) return fromCookie

    // 3. 按需新建 tab 再试一次
    if (allowCreateTab) {
      const tabId = await this.createSspaiTab()
      if (tabId !== null) {
        const fromTab = await this.readSsTokenFromTab(tabId)
        if (fromTab) return fromTab
      }
    }

    return null
  }

  /** 查找已打开的 sspai.com tab（不做任何副作用操作） */
  private async findSspaiTab(): Promise<number | null> {
    const runtimeTabs = this.runtime.tabs
    if (!runtimeTabs) return null
    try {
      const tabs = await runtimeTabs.query('*://sspai.com/*')
      const first = tabs[0]
      return first && first.id !== undefined ? first.id : null
    } catch (error) {
      logger.debug('[Sspai] 查询 sspai.com tab 失败：', error)
      return null
    }
  }

  /** 后台打开创作页（用于读取页面 localStorage 中的登录 token） */
  private async createSspaiTab(): Promise<number | null> {
    const runtimeTabs = this.runtime.tabs
    if (!runtimeTabs) return null
    try {
      logger.info('[Sspai] 后台打开 https://sspai.com/write 以读取登录态...')
      const tab = await runtimeTabs.create(EDITOR_PAGE, false)
      if (tab.id === undefined) return null
      await runtimeTabs.waitForLoad(tab.id, 30000)
      return tab.id
    } catch (error) {
      logger.debug('[Sspai] 创建 sspai.com tab 失败：', error)
      return null
    }
  }

  /** 在指定 tab 的页面上下文读 localStorage.ssToken */
  private async readSsTokenFromTab(tabId: number): Promise<string | null> {
    const runtimeTabs = this.runtime.tabs
    if (!runtimeTabs) return null
    try {
      // executeScript 在 MAIN world 执行，函数不得引用模块级变量
      const token = await runtimeTabs.executeScript<string | null, [string]>(
        tabId,
        readSsTokenInPageScript,
        [SS_TOKEN_KEY],
      )
      return token || null
    } catch (error) {
      logger.debug('[Sspai] 读取页面 ssToken 失败，改用 cookie 兜底：', error)
      return null
    }
  }

  /** 读 cookie（sspai_jwt_token / sspai_cross_token） */
  private async readTokenFromCookie(): Promise<string | null> {
    try {
      const cookies = await this.runtime.cookies.get('sspai.com')
      for (const name of SS_TOKEN_COOKIES) {
        const hit = cookies.find((c) => c.name === name)
        if (hit?.value) return hit.value
      }
    } catch (error) {
      logger.debug('[Sspai] 读取 token cookie 失败：', error)
    }
    return null
  }

  // ============ 工具方法 ============

  /** 生成 UUID（对齐编辑器上传时的 cname 前缀） */
  private uuid(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      const v = c === 'x' ? r : (r & 0x3) | 0x8
      return v.toString(16)
    })
  }

  /** 由 mime 推断文件扩展名（少数派前端用原文件后缀，这里等价处理） */
  private extensionFor(mime: string): string {
    const normalized = (mime || '').toLowerCase()
    if (normalized.includes('png')) return 'png'
    if (normalized.includes('gif')) return 'gif'
    if (normalized.includes('webp')) return 'webp'
    if (normalized.includes('bmp')) return 'bmp'
    if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg'
    return 'png'
  }
}

// ============ executeScript 函数（必须是无闭包引用的纯函数） ============

/**
 * 在 sspai.com 页面 MAIN world 读取登录 token。
 *
 * ⚠️ 纯函数约束（MV3 executeScript 闭包序列化陷阱）：本函数会被序列化后在页面
 * 上下文执行，禁止引用模块级函数/常量（生产构建会被混淆，页面报 "xx is not
 * defined" 导致 executeScript 返回 null）。key 名通过参数传入。
 */
function readSsTokenInPageScript(key: string): string | null {
  try {
    const token = window.localStorage.getItem(key)
    return token || null
  } catch {
    return null
  }
}
