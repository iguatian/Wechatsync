/**
 * 彩龙社区（昆明信息港旗下社区，www.clzg.cn）适配器
 *
 * 平台资料：
 * - 图文编辑器：https://www.clzg.cn/iarticle
 * - 草稿/文章列表：https://www.clzg.cn/iarticle/list
 * - 草稿编辑：https://www.clzg.cn/iarticle?id=<tid>
 * - 文章详情：https://www.clzg.cn/article/<tid>.html
 *
 * ⚠️ 站点是 Nuxt（Vue2 + Apollo）SPA，所有业务请求都走 **同一个 GraphQL 端点**
 *    `POST https://bff.clzg.cn/graphql`，以 `operationName` 区分。
 *
 * 鉴权（HAR + 前端 bundle 双重确认）：
 *   - 登录态同时依赖 **Cookie**（`credentials: 'include'`）和 **`Authorization` 头**。
 *     站点 apollo 配置里：
 *       httpLinkOptions.headers = { appid, uuid, 'x-forwarded-for', 'user-agent', Referer }
 *       getAuth                = () => 'Bearer ' + $cookies.get('Authorization')
 *     vue-apollo 会把 getAuth 的结果包成 `Authorization: Bearer <token>` 塞进请求头。
 *   - ⚠️ 抓包 HAR 里**看不到** `Authorization` 头（以及任何 Cookie / Set-Cookie），
 *     是因为该 HAR 被脱敏过；只带 Cookie 不带该头会被服务端判定为「请先登录后再操作」。
 *     故这里用 `chrome.cookies` 读 `Authorization` cookie 并显式转成请求头
 *     （`chrome.cookies` 不受 SameSite 限制、也能读 httpOnly）。
 *   - 必需的三个自定义头：
 *       appid:         <应用 ID，公开常量 clzg6hg9j49zbtsqgdza>
 *       uuid:          <cookie `clzg_uuid` 的值>（缺失时生成一个并持久化，保持稳定）
 *       Authorization: Bearer <cookie `Authorization` 的值>
 *   - 登录态判定：`getUserInfo` 返回的 `user_info.uid` 非空即已登录。
 *
 * 图片上传（HAR + 前端 bundle 双重确认，阿里云 OSS 直传）：
 *   1. GraphQL `ossAuth`（fetchPolicy: network-only，每次都取新的）
 *      → { accessid, host, policy, signature, callback, dir }
 *   2. POST <host>（multipart/form-data，字段顺序 key/policy/OSSAccessKeyId/
 *      success_action_status/signature/callback/file）
 *      key = `<dir><随机10位>.<ext>`（policy 条件限制 starts-with $key <dir>、
 *      starts-with $ContentType image/，所以**文件 mime 必须是 image/***）
 *      → { Status:"OK", name, url }，`url` 即 CDN 最终地址
 *        （形如 https://statics.clzg.cn/upload/clzg/2026/09/22/xxxx.jpg?x-oss-process=style/clzg_content）
 *
 * 保存草稿 / 发布（HAR + 前端 bundle 双重确认）：
 *   GraphQL `mutation postThread` → `add_article(...)`
 *   variables（与编辑器 submit() 逐字段一致）：
 *     subject            标题
 *     cover_img          封面 URL（见下方「封面」）
 *     is_draft           1 = 存草稿，0 = 直接发布
 *     content            内容块数组的 **JSON 字符串**
 *     activity_ids/at_uids/tag_names  话题/@/标签，默认空
 *     comment_allow      1 = 允许评论
 *     gather_id          0
 *     post_type          1 = 图文文章
 *     location           "{}"
 *   → { data: { add_article: { error: 2003, message: "已保存草稿", data: <tid> } } }
 *     `error` 为 2xxx 视为成功（2003 = 已保存草稿），`data` 即文章 tid。
 *
 * 内容格式（关键，来自编辑器 `submitContent()`）：
 *   content 是数组，每个元素是一个「块」：
 *     { audio_id:"", content_img:"", content_text:"<HTML>", coordinate:null,
 *       is_show_menu:false, audit_need_comment:0, audit_need_login:0, post_id:null,
 *       reference:null, video_preview_img:"", video_id:"" }
 *   其中 `content_text` 就是 HTML —— 编辑器里插入的图片也是以内联 `<img>` 的形式
 *   存在 `content_text` 中（`editorBlur()` 把整个 CKEditor 的 `getData()` 塞进 pragraph
 *   块的 content_text），所以本适配器把整篇正文 HTML 放进**单个块**的 content_text 即可。
 *   注意：编辑器 `submitContent()` 会跳过 index 0（那是 `{type:"button"}` 的 UI 占位块），
 *   服务端只负责解析数组，我们直接提交 1 个块即可。
 *
 * 封面：
 *   `cover_img` 由编辑器封面上传得到（走同一套 OSS 直传）。本适配器策略：
 *   article.cover → 正文首图 → 空。已是彩龙 CDN 的地址则直接复用，不重复转存。
 *
 * 请求模式：
 * - bff.clzg.cn 响应带 `Access-Control-Allow-Origin: *`，但为与 HAR 对齐仍通过
 *   headerRules 注入 Origin / Referer。
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Cailong')

/** 站点 origin */
const SITE_ORIGIN = 'https://www.clzg.cn'

/** 图编辑器页（Referer / 首页） */
const EDITOR_PAGE = `${SITE_ORIGIN}/iarticle`

/** 文章 / 草稿列表 */
const DRAFT_LIST = `${SITE_ORIGIN}/iarticle/list`

/** GraphQL 端点（所有业务请求共用） */
const GRAPHQL_URL = 'https://bff.clzg.cn/graphql'

/** 应用 ID（前端 nuxt runtimeConfig 的公开常量，HAR 验证） */
const APP_ID = 'clzg6hg9j49zbtsqgdza'

/** 设备 UUID 所在 cookie 名（前端 `$cookies.get('clzg_uuid')`） */
const UUID_COOKIE = 'clzg_uuid'

/**
 * 登录 token 所在 cookie 名。
 *
 * ⚠️ 关键：站点 apollo 配置里 `getAuth: () => 'Bearer ' + $cookies.get('Authorization')`，
 *    也就是**除了 cookie 之外还要求显式带 `Authorization: Bearer <token>` 头**。
 *    抓包 HAR 里看不到这个头是因为该 HAR 被脱敏过（request.cookies 为空、
 *    全文件没有任何 Set-Cookie），只带 cookie 会被服务端判定为「请先登录后再操作」。
 */
const AUTH_COOKIE = 'Authorization'

/** 兜底 token cookie 名（vue-apollo 默认 tokenName，本站在 getAuth 里没用，仅作保险） */
const ALT_AUTH_COOKIE = 'apollo-token'

/** 读 cookie 用的域名（chrome.cookies.getAll 会连带子域） */
const COOKIE_DOMAIN = 'clzg.cn'

/** UUID 持久化 key（cookie 缺失时的兜底） */
const UUID_STORAGE_KEY = 'cailong_uuid'

/** 图文文章类型 */
const POST_TYPE_ARTICLE = 1

/** 封面 / 正文图片跳过的域名（已属于彩龙图床） */
const SKIP_IMAGE_PATTERNS = ['statics.clzg.cn', 'clzgstatic']

/** 请求头规则：与 HAR 抓包对齐 */
const HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
  {
    urlFilter: '*://bff.clzg.cn/*',
    headers: {
      Origin: SITE_ORIGIN,
      Referer: `${SITE_ORIGIN}/`,
    },
  },
]

/** getUserInfo 查询（取最小字段集，够判定登录态 + 展示昵称头像） */
const USER_INFO_QUERY = `query getUserInfo($mid: String, $uid: Int) {
  user_info(mid: $mid, uid: $uid) {
    uid
    nickname
    username
    avatar
    __typename
  }
}
`

/** ossAuth 查询（返回阿里云 OSS 直传凭证） */
const OSS_AUTH_QUERY = `query ossAuth {
  upload_oss_img_apply_of_web
}
`

/** postThread 变更（与前端 c.postThread 逐字段一致） */
const POST_THREAD_MUTATION = `mutation postThread($activity_ids: String, $at_uids: String, $comment_allow: Int, $content: String!, $cover_img: String, $is_draft: Int, $subject: String!, $tag_names: String, $post_type: Int, $location: String) {
  add_article(activity_ids: $activity_ids, at_uids: $at_uids, comment_allow: $comment_allow, content: $content, cover_img: $cover_img, is_draft: $is_draft, subject: $subject, tag_names: $tag_names, post_type: $post_type, location: $location)
}
`

/** GraphQL 响应包装 */
interface GqlResponse<T> {
  data?: T
  errors?: Array<{ message?: string; [key: string]: unknown }>
}

/** getUserInfo 返回 */
interface CailongUser {
  uid?: number | string
  nickname?: string
  username?: string
  avatar?: string
}

interface GetUserInfoData {
  user_info?: CailongUser | null
}

/** ossAuth 返回 */
interface CailongOssAuth {
  accessid?: string
  host?: string
  policy?: string
  signature?: string
  callback?: string
  dir?: string
  expire?: number
}

interface OssAuthData {
  upload_oss_img_apply_of_web?: CailongOssAuth
}

/** OSS 直传响应（阿里云回调后返回 JSON） */
interface OssUploadResp {
  Status?: string
  name?: string
  url?: string
  [key: string]: unknown
}

/** add_article 返回 */
interface ThreadResult {
  error?: number
  message?: string
  data?: number | string | null
}

interface PostThreadData {
  add_article?: ThreadResult | null
}

/** 内容块（content 数组元素） */
interface CailongContentBlock {
  audio_id: string
  content_img: string
  content_text: string
  coordinate: null
  is_show_menu: boolean
  audit_need_comment: number
  audit_need_login: number
  post_id: null
  reference: null
  video_preview_img: string
  video_id: string
}

export class CailongAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'cailong',
    name: '彩龙社区',
    icon: 'https://www.clzg.cn/favicon.ico',
    homepage: EDITOR_PAGE,
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  /** 预处理配置：彩龙社区编辑器接受 HTML 正文 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  /** 设备 UUID 缓存（避免每次请求都读 cookie / 存储） */
  private uuidCache: string | null = null

  // ============ checkAuth ============

  /**
   * 鉴权：调 `getUserInfo`，`user_info.uid` 非空即已登录。
   */
  async checkAuth(): Promise<AuthResult> {
    return this.withHeaderRules(HEADER_RULES, async () => {
      try {
        const data = await this.gql<GetUserInfoData>('getUserInfo', {}, USER_INFO_QUERY)
        const user = data.user_info
        if (!user?.uid) {
          return {
            isAuthenticated: false,
            error: `请先登录彩龙社区（${SITE_ORIGIN}/）`,
          }
        }
        return {
          isAuthenticated: true,
          userId: String(user.uid),
          username: user.nickname || user.username,
          avatar: user.avatar,
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
   * 发布文章（默认保存草稿）。
   *
   * 流程（HAR + 编辑器 submit() 复刻）：
   *   1. 处理正文图片（转存彩龙图床并替换 src）
   *   2. 确定封面：article.cover → 正文首图 → 空
   *   3. 组装内容块 JSON 字符串
   *   4. mutation postThread → add_article，返回 tid
   *
   * 注意：这里不用 withHeaderRules 包住整段 —— publish 内部会调 checkAuth，
   * 而 checkAuth 自己也加同一套规则，嵌套调用会导致内层 finally 提前清掉外层规则。
   */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    await this.addHeaderRules(HEADER_RULES)
    try {
      logger.info('Starting publish to Cailong...')

      // 1. 鉴权（拿不到 uid 直接给出明确提示，省得后面 GraphQL 报错难懂）
      const auth = await this.checkAuthDirect()
      if (!auth.isAuthenticated) {
        throw new Error(auth.error || '未登录彩龙社区')
      }

      const draftOnly = options?.draftOnly ?? true

      // 2. 正文图片：转存到彩龙图床（已是彩龙 CDN 的跳过）
      let content = article.html || ''
      try {
        content = await this.processImages(
          content,
          (src) => this.uploadImageByUrl(src),
          {
            skipPatterns: SKIP_IMAGE_PATTERNS,
            onProgress: options?.onImageProgress,
          },
        )
      } catch (e) {
        logger.warn('[Cailong] processImages 中途失败，继续发布：', (e as Error).message)
      }

      // 3. 封面：article.cover → 正文首图 → 空
      let coverUrl = ''
      let coverError: string | undefined
      let coverSource = '无'
      if (article.cover) {
        try {
          coverUrl = this.isCailongCdn(article.cover)
            ? article.cover
            : await this.uploadImageToCailong(article.cover)
          coverSource = '同步来源封面'
          logger.info(`[Cailong] 封面上传成功：${coverUrl}`)
        } catch (e) {
          coverError = (e as Error).message
          logger.warn('[Cailong] 封面上传失败：', coverError)
        }
      }
      if (!coverUrl) {
        coverUrl = this.firstBodyImage(content) || ''
        if (coverUrl) {
          coverSource = '正文首图（未提供封面时的回退）'
          logger.info('[Cailong] 未提供封面，使用正文首图作为封面')
        } else {
          logger.warn('[Cailong] 未提供封面且正文无图，cover_img 为空')
        }
      }

      // 4. 组装内容块（单个 pragraph 块，图片内联在 content_text 里）
      const blocks: CailongContentBlock[] = [this.buildParagraphBlock(content)]

      const tid = await this.submitThread({
        subject: article.title,
        coverImg: coverUrl,
        content: JSON.stringify(blocks),
        tagNames: (article.tags || []).join(','),
        isDraft: draftOnly ? 1 : 0,
      })

      logger.info(`[Cailong] ${draftOnly ? '草稿' : '文章'}已保存：${tid}`)
      return this.createResult(true, {
        postId: tid,
        postUrl: draftOnly
          ? `${EDITOR_PAGE}?id=${encodeURIComponent(tid)}`
          : `${SITE_ORIGIN}/article/${encodeURIComponent(tid)}.html`,
        draftOnly,
        coverUploaded: !!coverUrl,
        coverUrl: coverUrl || undefined,
        ...(coverError ? { coverError } : {}),
        // 封面来源写进 message，便于排查「草稿里没有封面」
        message: draftOnly
          ? `已保存到彩龙社区草稿箱（${DRAFT_LIST}）；封面来源：${coverSource}`
          : `已发布到彩龙社区；封面来源：${coverSource}`,
      })
    } catch (error) {
      return this.createResult(false, {
        error: (error as Error).message,
      })
    } finally {
      await this.clearHeaderRules()
    }
  }

  // ============ 图片上传 ============

  /**
   * 正文图片上传（被 processImages 调用）。
   * 失败时保留原 URL 不阻断整体同步。
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    try {
      const url = await this.uploadImageToCailong(src)
      return { url }
    } catch (error) {
      logger.warn('[Cailong] 正文图片上传失败，保留原 URL:', src, error)
      return { url: src }
    }
  }

  /**
   * 上传单张图片到彩龙图床（正文 / 封面共用）。
   * 三步：取二进制 → ossAuth 取凭证 → OSS 直传。
   */
  private async uploadImageToCailong(src: string): Promise<string> {
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

    // policy 条件要求 Content-Type 必须是 image/*，这里强制纠正（下载回来的 blob 可能没有 type）
    const mime = this.resolveImageMime(blob.type, src)
    const ext = this.extensionForMime(mime)

    // 2. 取 OSS 直传凭证
    const auth = await this.fetchOssAuth()
    const dir = auth.dir || ''
    const objectName = `${dir}${this.randomObjectName()}.${ext}`

    // 3. OSS 直传（字段顺序与 HAR / 编辑器一致）
    const form = new FormData()
    form.append('key', objectName)
    form.append('policy', auth.policy as string)
    form.append('OSSAccessKeyId', auth.accessid as string)
    form.append('success_action_status', '200')
    form.append('signature', auth.signature as string)
    form.append('callback', auth.callback || '')
    form.append('file', new Blob([blob], { type: mime }), objectName.split('/').pop())

    const resp = await this.runtime.fetch(auth.host as string, {
      method: 'POST',
      // 跨站上传，与页面行为一致：不带彩龙 cookie
      credentials: 'omit',
      headers: { Accept: 'application/json, text/plain, */*' },
      body: form,
    })

    const text = await resp.text()
    let data: OssUploadResp
    try {
      data = JSON.parse(text) as OssUploadResp
    } catch {
      throw new Error(
        `图片上传失败：响应非 JSON (HTTP ${resp.status}): ${text.substring(0, 200)}`,
      )
    }
    if (!data.url) {
      throw new Error(
        `图片上传失败 (HTTP ${resp.status}): ${text.substring(0, 200)}`,
      )
    }
    return data.url
  }

  // ============ GraphQL ============

  /**
   * 统一 GraphQL 请求。
   * 头部必须带 appid + uuid + Authorization（前端 apollo httpLinkOptions / getAuth 的行为）。
   */
  private async gql<T>(
    operationName: string,
    variables: Record<string, unknown>,
    query: string,
  ): Promise<T> {
    const uuid = await this.resolveUuid()
    const token = await this.resolveAuthToken()
    const body = JSON.stringify({ operationName, variables, query })

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: '*/*',
      appid: APP_ID,
      uuid,
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`
    } else {
      logger.debug(`[Cailong] 未读到 ${AUTH_COOKIE} 登录 cookie，将只依赖 Cookie 鉴权`)
    }

    const resp = await this.runtime.fetch(GRAPHQL_URL, {
      method: 'POST',
      credentials: 'include',
      headers,
      body,
    })

    const text = await resp.text()
    if (!resp.ok) {
      throw new Error(`彩龙社区接口失败：HTTP ${resp.status}: ${text.substring(0, 200)}`)
    }

    let json: GqlResponse<T>
    try {
      json = JSON.parse(text) as GqlResponse<T>
    } catch {
      throw new Error(`彩龙社区接口响应非 JSON：${text.substring(0, 200)}`)
    }

    if (json.errors?.length) {
      const msg = json.errors
        .map((e) => e.message)
        .filter(Boolean)
        .join('; ')
      // 「未登录」时补一句排查提示，避免用户反复重试
      const hint = !token && /登录/.test(msg)
        ? `（未在浏览器中读到 ${AUTH_COOKIE} 登录 Cookie，请确认已在同一浏览器登录 ${SITE_ORIGIN}/）`
        : ''
      throw new Error(`彩龙社区接口错误：${msg || '未知错误'}${hint}`)
    }
    if (!json.data) {
      throw new Error('彩龙社区接口返回空数据')
    }
    return json.data
  }

  /** 内部鉴权（不自行加 header 规则，供 publish 复用） */
  private async checkAuthDirect(): Promise<AuthResult> {
    try {
      const data = await this.gql<GetUserInfoData>('getUserInfo', {}, USER_INFO_QUERY)
      const user = data.user_info
      if (!user?.uid) {
        return {
          isAuthenticated: false,
          error: `请先登录彩龙社区（${SITE_ORIGIN}/）`,
        }
      }
      return {
        isAuthenticated: true,
        userId: String(user.uid),
        username: user.nickname || user.username,
        avatar: user.avatar,
      }
    } catch (error) {
      logger.debug('checkAuthDirect error:', error)
      return {
        isAuthenticated: false,
        error: (error as Error).message || '鉴权失败',
      }
    }
  }

  /** 取 OSS 直传凭证（每次上传前重新取，policy 有效期约 2 分钟） */
  private async fetchOssAuth(): Promise<CailongOssAuth> {
    const data = await this.gql<OssAuthData>('ossAuth', {}, OSS_AUTH_QUERY)
    const auth = data.upload_oss_img_apply_of_web
    if (!auth?.host || !auth.accessid || !auth.policy || !auth.signature) {
      throw new Error('获取彩龙社区图片上传凭证失败')
    }
    return auth
  }

  /** 提交文章 / 草稿，返回 tid */
  private async submitThread(params: {
    subject: string
    coverImg: string
    content: string
    tagNames: string
    isDraft: number
  }): Promise<string> {
    const data = await this.gql<PostThreadData>(
      'postThread',
      {
        subject: params.subject,
        cover_img: params.coverImg,
        is_draft: params.isDraft,
        content: params.content,
        activity_ids: '',
        at_uids: '',
        tag_names: params.tagNames,
        comment_allow: 1,
        gather_id: 0,
        post_type: POST_TYPE_ARTICLE,
        location: '{}',
      },
      POST_THREAD_MUTATION,
    )

    const result = data.add_article
    if (!result) {
      throw new Error('提交失败：响应缺少 add_article')
    }
    const tid = result.data
    if (tid === undefined || tid === null || tid === '') {
      throw new Error(result.message || `提交失败：error=${result.error}`)
    }
    return String(tid)
  }

  // ============ 工具方法 ============

  /**
   * 构造内容块（对应编辑器里的 pragraph 块：正文 HTML 全部塞进 content_text）。
   */
  private buildParagraphBlock(html: string): CailongContentBlock {
    return {
      audio_id: '',
      content_img: '',
      content_text: html,
      coordinate: null,
      is_show_menu: false,
      audit_need_comment: 0,
      audit_need_login: 0,
      post_id: null,
      reference: null,
      video_preview_img: '',
      video_id: '',
    }
  }

  /**
   * 解析设备 UUID：优先读 cookie `clzg_uuid`（与前端一致），
   * 其次读本地存储，最后生成一个并持久化，保证同一浏览器稳定。
   */
  private async resolveUuid(): Promise<string> {
    if (this.uuidCache) return this.uuidCache

    const fromCookie = await this.readCookie(UUID_COOKIE)
    if (fromCookie) {
      this.uuidCache = fromCookie
      return fromCookie
    }

    try {
      const stored = await this.runtime.storage.get<string>(UUID_STORAGE_KEY)
      if (stored) {
        this.uuidCache = stored
        return stored
      }
    } catch (error) {
      logger.debug('[Cailong] 读取本地 uuid 失败：', error)
    }

    const generated = this.randomUuid()
    this.uuidCache = generated
    try {
      await this.runtime.storage.set(UUID_STORAGE_KEY, generated)
    } catch (error) {
      logger.debug('[Cailong] 持久化 uuid 失败：', error)
    }
    return generated
  }

  /**
   * 读登录 token（`Authorization` cookie，其次 `apollo-token` 兜底）。
   *
   * 说明：`chrome.cookies` 能读到 httpOnly cookie，所以即使该 cookie 对页面 JS
   * 不可见，扩展侧也能取到。取不到时返回 null，不阻断请求（仍靠 cookie 鉴权）。
   */
  private async resolveAuthToken(): Promise<string | null> {
    return (await this.readCookie(AUTH_COOKIE)) || (await this.readCookie(ALT_AUTH_COOKIE))
  }

  /** 按名字读 clzg.cn 域下的 cookie（chrome.cookies.getAll 会连带子域） */
  private async readCookie(name: string): Promise<string | null> {
    try {
      const cookies = await this.runtime.cookies.get(COOKIE_DOMAIN)
      const hit = cookies.find((c) => c.name === name)
      return hit?.value || null
    } catch (error) {
      logger.debug(`[Cailong] 读取 cookie ${name} 失败：`, error)
      return null
    }
  }

  /** 生成 UUID v4（Service Worker 里的 crypto 可用） */
  private randomUuid(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
    // 兜底：手拼 UUID v4
    const hex = '0123456789abcdef'
    let out = ''
    for (let i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) out += '-'
      else if (i === 14) out += '4'
      else if (i === 19) out += hex[(Math.random() * 4 | 0) + 8]
      else out += hex[Math.random() * 16 | 0]
    }
    return out
  }

  /** OSS 对象名随机段（编辑器用 10 位小写字母 + 数字） */
  private randomObjectName(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    let out = ''
    for (let i = 0; i < 10; i++) {
      out += chars[Math.floor(Math.random() * chars.length)]
    }
    return out
  }

  /** 是否已是彩龙图床地址（无需重复转存） */
  private isCailongCdn(url: string): boolean {
    return SKIP_IMAGE_PATTERNS.some((p) => url.includes(p))
  }

  /** 取正文中第一张非 data URI 的图片地址 */
  private firstBodyImage(content: string): string | null {
    const re = /<img[^>]+src="([^"]+)"/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      const src = m[1]
      if (src && !src.startsWith('data:')) return src
    }
    return null
  }

  /**
   * 推断图片 mime：blob 自带 image/* 就用它，否则按 URL 后缀兜底。
   * OSS policy 有 `starts-with $ContentType image/` 条件，类型错会 403。
   */
  private resolveImageMime(blobType: string, src: string): string {
    if (blobType && blobType.startsWith('image/')) return blobType
    const ext = this.extensionFromUrl(src)
    switch (ext) {
      case 'png':
        return 'image/png'
      case 'gif':
        return 'image/gif'
      case 'webp':
        return 'image/webp'
      case 'bmp':
        return 'image/bmp'
      case 'svg':
        return 'image/svg+xml'
      case 'jpg':
      case 'jpeg':
      default:
        return 'image/jpeg'
    }
  }

  /** 由 mime 推断文件扩展名（OSS key 后缀） */
  private extensionForMime(mime: string): string {
    const normalized = (mime || '').toLowerCase()
    if (normalized.includes('png')) return 'png'
    if (normalized.includes('gif')) return 'gif'
    if (normalized.includes('webp')) return 'webp'
    if (normalized.includes('bmp')) return 'bmp'
    if (normalized.includes('svg')) return 'svg'
    return 'jpg'
  }

  /** 从 URL / data URI 里粗略取扩展名 */
  private extensionFromUrl(src: string): string {
    const cleaned = src.split('?')[0].split('#')[0]
    const m = cleaned.match(/\.([a-zA-Z0-9]+)$/)
    return m ? m[1].toLowerCase() : ''
  }
}
