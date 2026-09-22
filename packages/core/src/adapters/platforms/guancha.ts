/**
 * 观察者网 · 风闻社区（user.guancha.cn）适配器
 *
 * 平台资料：
 * - 风闻首页：https://user.guancha.cn/
 * - 发帖编辑器：https://user.guancha.cn/post/publish.html
 * - 我的文章：https://user.guancha.cn/user/personal-homepage?uid=<uid>&click=my-article
 *
 * 鉴权（HAR + 前端 `mylib.js` 双向验证）：
 *   站点前端 `mylib.init()` / `checkLogin()` 的登录判据就是 **cookie `GCZWU`**：
 *     if (mylib.getCookie('GCZWU') != null) isLogin = true;
 *   且 `mylib.getUserDataByCookie()` 会把该 cookie 按 `-` 切开：
 *     `GCZWU = "<uid>-<encodeURI(用户名)>"` → user[0] = uid，user[1] = 用户名。
 *   所以本适配器同样以「能读到 `GCZWU`」作为已登录的第一判据，再调
 *   `GET /user/get-user-tips`（JSONP）补昵称头像信息。
 *   ⚠️ 注意 `get-user-tips` **未登录时也返回 `code:0`**（实测 `{"code":0,"avatar":"",...}`），
 *      因此它只能用来取头像，**不能**用来判定登录态 —— 未登录时 `avatar` 为空串。
 *   接口侧未登录统一返回 `code:203`（前端 `sendPostAjax` 收到 203 即跳登录弹窗）。
 *
 * 图片上传（HAR 验证）：
 *   POST /image-upload/upload   （multipart/form-data，字段名 `upfile[]`）
 *     → [ { code:0, data:{ error:"", downloadUrl:"https://i.guancha.cn/bbs/<日期>/<文件名>.jpg?imageView2/2/w/500/format/jpg" }, message:"SUCCESS" } ]
 *   响应是**数组**（接口支持多文件），取第一项即可；`data.downloadUrl` 即正文插图地址
 *   （编辑器插入正文用的就是这个带 `imageView2` 的地址）。
 *
 * 保存草稿 / 发布（HAR + 编辑器 `post.js` 双向验证）：
 *   POST /post/publish-post-v2   （application/x-www-form-urlencoded）
 *   body（字段顺序与 HAR 样本一致；`post_id` 为空串表示新建）：
 *     cover / title / content / topic[] / post_id / save_mode / original / access_device / vote_info
 *       - save_mode：`draft` = 存草稿，`publish` = 直接发布（编辑器 `btn-save` / `btn-publish` 两个按钮）
 *       - topic[]  ：**必须且只能带 1 个话题 id**（编辑器校验「请至少选择1个标签」「最多可添加1个相关话题」）
 *       - original ：是否声明原创，0 / 1（编辑器默认不勾选，这里也固定传 0）
 *       - access_device：访问设备，1 = PC
 *       - vote_info：投票信息，无投票时固定 `[]`
 *     ⚠️ HAR 请求体里**没有** `distribution_status` 字段：编辑器把它取成 `undefined`，
 *        jQuery 序列化时会直接跳过，故这里也不传。
 *   → { code:0, msg:"", data:{ return_url } } 即成功（`return_url` 为文章地址）；
 *     code:4 = 业务失败（如「发布失败，您的账号正在审核中，请耐心等待」）、
 *     code:5 = 境外手机号需实名认证、code:203 = 未登录。错误信息一律原样透传。
 *
 * 话题列表（发布页内联脚本验证）：
 *   GET /topic/get-select-topic → { code:0, msg:"成功", data:{ items:[{ topic_id, name, all_post_nums }] } }
 *   该接口**不需要登录**。适配器用 Article.tags 去匹配话题名，匹配不到回退到默认话题
 *   「广场」（HAR 样本选择的话题，topic_id=188，同时也是站内发帖量最大的通用话题）。
 *
 * 封面：
 *   编辑器里封面只能从**正文已上传的图片**中挑选，并经过 1.38 比例裁剪，
 *   最终提交形如 `<图床裸地址>?imageMogr2/cut/<w>x<h>x<x>x<y>/format/jpg`。
 *   本适配器不打开裁剪交互，策略是：article.cover（站外则先转存）→ 正文首图，
 *   统一取**裸地址**（去掉 query）提交 —— 与封面地址指向同一对象，列表页可正常展示。
 *
 * 请求模式：
 * - 全部接口都在 user.guancha.cn 同域，响应头 `Access-Control-Allow-Origin` 固定为
 *   `https://user.guancha.cn`（非通配），因此通过 headerRules 注入 Origin / Referer 与
 *   HAR 对齐（扩展 SW 本身有 host_permissions，但注入后更贴近真实请求）。
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Guancha')

/** 站点 origin（风闻社区所有接口都在这个域） */
const SITE_ORIGIN = 'https://user.guancha.cn'

/** 发帖编辑器页（HAR 抓包的 Referer） */
const PUBLISH_PAGE = `${SITE_ORIGIN}/post/publish.html`

/** 图片上传接口（multipart，字段名 `upfile[]`） */
const IMAGE_UPLOAD_URL = `${SITE_ORIGIN}/image-upload/upload`

/** 话题列表接口（无需登录） */
const TOPIC_LIST_URL = `${SITE_ORIGIN}/topic/get-select-topic`

/** 保存草稿 / 发布接口 */
const PUBLISH_POST_URL = `${SITE_ORIGIN}/post/publish-post-v2`

/** 用户提示信息接口（JSONP，取头像；未登录时 avatar 为空串） */
const USER_TIPS_URL = `${SITE_ORIGIN}/user/get-user-tips`

/** 登录 cookie 名（站点前端 `mylib` 的登录判据） */
const LOGIN_COOKIE = 'GCZWU'

/** 读取 cookie 用的域名（chrome.cookies.getAll 会连带子域） */
const COOKIE_DOMAIN = 'guancha.cn'

/** 图片上传字段名（HAR 验证；接口按数组解析，故带 `[]`） */
const UPLOAD_FIELD_NAME = 'upfile[]'

/** 保存模式：存草稿 */
const SAVE_MODE_DRAFT = 'draft'

/** 保存模式：直接发布 */
const SAVE_MODE_PUBLISH = 'publish'

/** 访问设备类型：1 = PC（编辑器固定值） */
const ACCESS_DEVICE_PC = '1'

/** 标题长度限制（编辑器校验：5-40 个字） */
const TITLE_MIN_LENGTH = 5
const TITLE_MAX_LENGTH = 40

/** 正文纯文本长度下限（编辑器校验：最少 10 个字） */
const CONTENT_MIN_LENGTH = 10

/** 默认话题：广场（HAR 样本所选，同时是站内发帖量最大的通用话题） */
const DEFAULT_TOPIC_NAME = '广场'
const DEFAULT_TOPIC_ID = '188'

/** 特殊话题名（与普通话题互斥，不能作为默认兜底） */
const SPECIAL_TOPIC_NAMES = ['风闻好问', '聊主编']

/** 已是观察者网图床的地址（无需重复转存） */
const SKIP_IMAGE_PATTERNS = ['i.guancha.cn', 'guancha.cn']

/** 请求头规则：与 HAR 抓包对齐 */
const HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
  {
    urlFilter: '*://user.guancha.cn/*',
    headers: {
      Origin: SITE_ORIGIN,
      Referer: PUBLISH_PAGE,
    },
  },
]

/** 话题项 */
interface GuanchaTopic {
  topic_id?: number | string
  name?: string
  all_post_nums?: number
}

/** 话题列表响应 */
interface GuanchaTopicResp {
  code?: number
  msg?: string
  data?: { items?: GuanchaTopic[] }
}

/** 图片上传响应项（接口返回数组） */
interface GuanchaUploadItem {
  code?: number
  message?: string
  data?: {
    error?: string
    downloadUrl?: string
    info?: unknown
  }
}

/** 保存草稿 / 发布响应 */
interface GuanchaPublishResp {
  code?: number
  msg?: string
  data?: { return_url?: string; [key: string]: unknown } | unknown[]
}

/** 用户提示信息响应（JSONP，取头像） */
interface GuanchaUserTips {
  code?: number
  avatar?: string
  sixin?: number
  xiaoxi?: number
}

/** cookie 里解析出的登录信息 */
interface GuanchaCredentials {
  uid: string
  username?: string
}

export class GuanchaAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'guancha',
    name: '观察者网风闻',
    icon: `${SITE_ORIGIN}/favicon.ico`,
    homepage: PUBLISH_PAGE,
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  /** 预处理配置：风闻编辑器（UMeditor）接受 HTML 正文 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  // ============ checkAuth ============

  /**
   * 鉴权：读 cookie `GCZWU`（与站点前端 `mylib.checkLogin()` 同一判据），
   * 再调 `get-user-tips` 补头像与昵称。
   *
   * ⚠️ `get-user-tips` 未登录也返回 `code:0`（avatar 为空串），所以登录态只认 cookie。
   * 不做任何副作用操作（不新建 tab），适合批量检查登录态。
   */
  async checkAuth(): Promise<AuthResult> {
    return this.withHeaderRules(HEADER_RULES, async () => {
      try {
        const creds = await this.resolveCredentials()
        if (!creds) {
          return {
            isAuthenticated: false,
            error: `请先登录观察者网风闻（${PUBLISH_PAGE}）`,
          }
        }

        const tips = await this.fetchUserTips()
        return {
          isAuthenticated: true,
          userId: creds.uid,
          username: creds.username,
          avatar: tips?.avatar || undefined,
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
   * 流程（HAR 验证）：
   *   1. 解析登录 cookie（不存在直接给出明确提示）
   *   2. processImages 上传正文图片（替换为观察者网图床地址）
   *   3. 封面：article.cover → 正文首图 → 空
   *   4. 拉话题列表，用 tags 匹配话题名（匹配不到回退「广场」）
   *   5. POST /post/publish-post-v2（save_mode=draft）→ 拿 return_url
   */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(HEADER_RULES, async () => {
      logger.info('Starting publish to Guancha...')

      // 1. 鉴权（风闻登录态只依赖 cookie，读不到直接提示重新登录）
      const creds = await this.resolveCredentials()
      if (!creds) {
        throw new Error(`请先登录观察者网风闻（${PUBLISH_PAGE}）`)
      }

      const draftOnly = options?.draftOnly ?? true

      // 2. 标题：编辑器要求 5-40 字，超长截断（与淘江湖等适配器一致的处理）
      const title = this.normalizeTitle(article.title)

      // 3. 正文图片转存到观察者网图床
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
        logger.warn('[Guancha] processImages 中途失败，继续发布：', (e as Error).message)
      }

      // 4. 正文长度校验（编辑器要求纯文本不少于 10 字；超长交给服务端裁决）
      const textLength = this.stripHtml(content).length
      if (textLength < CONTENT_MIN_LENGTH) {
        throw new Error(`正文纯文本不足 ${CONTENT_MIN_LENGTH} 字，观察者网风闻无法发布`)
      }

      // 5. 封面：article.cover → 正文首图 → 空
      let cover = ''
      let coverSource = '无'
      if (article.cover) {
        try {
          cover = await this.resolveCoverUrl(article.cover)
          coverSource = '同步来源封面'
          logger.info(`[Guancha] 封面处理成功：${cover}`)
        } catch (e) {
          logger.warn('[Guancha] 封面处理失败，尝试使用正文首图：', (e as Error).message)
        }
      }
      if (!cover) {
        cover = this.firstBodyImage(content) || ''
        if (cover) {
          coverSource = '正文首图'
          logger.info('[Guancha] 未提供可用封面，使用正文首图作为封面')
        } else {
          logger.warn('[Guancha] 无封面可用，cover 为空')
        }
      }

      // 6. 话题：tags 匹配 → 默认「广场」
      const topic = await this.resolveTopicId(article)

      // 7. 提交
      const result = await this.submitPost({
        title,
        content,
        cover,
        topicId: topic.id,
        saveMode: draftOnly ? SAVE_MODE_DRAFT : SAVE_MODE_PUBLISH,
      })

      const postUrl = result.returnUrl || PUBLISH_PAGE
      logger.info(`[Guancha] ${draftOnly ? '草稿' : '文章'}已保存：${postUrl}`)

      return this.createResult(true, {
        postUrl,
        draftOnly,
        coverUploaded: !!cover,
        coverUrl: cover || undefined,
        message: draftOnly
          ? `已保存到观察者网风闻草稿（我的文章：${this.myArticleUrl(creds.uid)}）；话题：${topic.name}；封面来源：${coverSource}`
          : `已提交到观察者网风闻（${postUrl}）；话题：${topic.name}；封面来源：${coverSource}`,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  // ============ 图片上传 ============

  /**
   * 正文图片上传（被 processImages 调用）。
   * 失败时保留原 URL 不阻断整体同步。
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    try {
      const url = await this.uploadImageToGuancha(src)
      return { url }
    } catch (error) {
      logger.warn('[Guancha] 正文图片上传失败，保留原 URL:', src, error)
      return { url: src }
    }
  }

  /**
   * 上传单张图片到观察者网图床（正文 / 封面共用）。
   * multipart 字段名 `upfile[]`，响应是数组（取第一项）。
   */
  private async uploadImageToGuancha(src: string): Promise<string> {
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

    // 2. multipart 上传（文件名保留原后缀，服务端按后缀产出对象名）
    const filename = `image-${this.uniqueName()}.${this.resolveExtension(blob.type, src)}`
    const formData = new FormData()
    formData.append(UPLOAD_FIELD_NAME, blob, filename)

    const resp = await this.runtime.fetch(IMAGE_UPLOAD_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: '*/*',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: formData,
    })

    const text = await resp.text()
    if (!resp.ok) {
      throw new Error(`图片上传失败：HTTP ${resp.status}: ${text.substring(0, 200)}`)
    }

    let data: GuanchaUploadItem | GuanchaUploadItem[]
    try {
      data = JSON.parse(text) as GuanchaUploadItem | GuanchaUploadItem[]
    } catch {
      throw new Error(`图片上传失败：响应非 JSON (HTTP ${resp.status}): ${text.substring(0, 200)}`)
    }

    const item = Array.isArray(data) ? data[0] : data
    const url = item?.data?.downloadUrl
    if (item?.code !== 0 || !url) {
      throw new Error(
        item?.data?.error ||
          item?.message ||
          `图片上传失败：code=${item?.code}`,
      )
    }
    return url
  }

  /**
   * 生成封面地址：站外图片先转存到观察者网图床，再统一取 **裸地址**（去掉 query）。
   *
   * 编辑器提交的封面是「裸地址 + `?imageMogr2/cut/...` 裁剪参数」，
   * 这里不做裁剪交互，直接用裸地址 —— 指向同一对象，列表页可正常展示。
   */
  private async resolveCoverUrl(src: string): Promise<string> {
    const uploaded = this.isGuanchaCdn(src) ? src : await this.uploadImageToGuancha(src)
    return this.stripQuery(uploaded)
  }

  // ============ 话题 ============

  /**
   * 选择话题：用 Article.tags 依次精确匹配话题名，匹配不到则回退默认话题「广场」。
   * 接口失败时用内置的默认话题 id 兜底。
   */
  private async resolveTopicId(article: Article): Promise<{ id: string; name: string }> {
    let items: GuanchaTopic[] = []
    try {
      items = await this.fetchTopics()
    } catch (error) {
      logger.warn('[Guancha] 获取话题列表失败，使用默认话题：', (error as Error).message)
      return { id: DEFAULT_TOPIC_ID, name: DEFAULT_TOPIC_NAME }
    }

    if (items.length === 0) {
      logger.warn('[Guancha] 话题列表为空，使用默认话题')
      return { id: DEFAULT_TOPIC_ID, name: DEFAULT_TOPIC_NAME }
    }

    const tags = (article.tags || [])
      .map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
      .filter(Boolean)

    for (const tag of tags) {
      const hit = items.find((item) => item.name === tag)
      if (hit?.topic_id !== undefined) {
        logger.info(`[Guancha] 标签「${tag}」命中话题：${hit.topic_id}`)
        return { id: String(hit.topic_id), name: tag }
      }
    }

    const fallback =
      items.find((item) => item.name === DEFAULT_TOPIC_NAME) ||
      items.find(
        (item) => !!item.name && !SPECIAL_TOPIC_NAMES.includes(item.name),
      ) ||
      items[0]

    if (fallback?.topic_id !== undefined) {
      logger.info(`[Guancha] 未匹配到标签，使用默认话题：${fallback.name}(${fallback.topic_id})`)
      return { id: String(fallback.topic_id), name: fallback.name || String(fallback.topic_id) }
    }
    return { id: DEFAULT_TOPIC_ID, name: DEFAULT_TOPIC_NAME }
  }

  /** 拉取可选话题列表 */
  private async fetchTopics(): Promise<GuanchaTopic[]> {
    const resp = await this.runtime.fetch(TOPIC_LIST_URL, {
      credentials: 'include',
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
      },
    })
    const text = await resp.text()
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${text.substring(0, 200)}`)
    }

    const data = this.parseJsonLike<GuanchaTopicResp>(text)
    if (data?.code !== 0 || !data.data?.items) {
      throw new Error(data?.msg || `话题列表响应异常：code=${data?.code}`)
    }
    return data.data.items
  }

  // ============ 提交 ============

  /**
   * 提交草稿 / 发布：POST /post/publish-post-v2（form-urlencoded）。
   * 字段顺序与 HAR 样本对齐（部分服务端会按 name 校验，空字段也保留 key）。
   */
  private async submitPost(params: {
    title: string
    content: string
    /** 封面裸地址（无封面为空串） */
    cover: string
    /** 话题 id */
    topicId: string
    saveMode: string
  }): Promise<{ returnUrl?: string }> {
    const body = new URLSearchParams()
    body.append('cover', params.cover)
    body.append('title', params.title)
    body.append('content', params.content)
    body.append('topic[]', params.topicId)
    body.append('post_id', '')
    body.append('save_mode', params.saveMode)
    body.append('original', '0')
    body.append('access_device', ACCESS_DEVICE_PC)
    body.append('vote_info', '[]')

    const resp = await this.runtime.fetch(PUBLISH_POST_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: PUBLISH_PAGE,
      },
      body: body.toString(),
    })

    const text = await resp.text()
    if (!resp.ok) {
      throw new Error(`提交失败：HTTP ${resp.status}: ${text.substring(0, 200)}`)
    }

    let data: GuanchaPublishResp
    try {
      data = JSON.parse(text) as GuanchaPublishResp
    } catch {
      throw new Error(`提交失败：响应非 JSON: ${text.substring(0, 200)}`)
    }

    if (data.code === 0) {
      const payload = data.data
      const returnUrl = Array.isArray(payload) ? undefined : payload?.return_url
      return { returnUrl }
    }

    if (data.code === 203) {
      throw new Error('登录态已失效，请重新登录观察者网风闻后重试')
    }
    if (data.code === 5) {
      throw new Error('根据相关法律法规，境外手机号需要实名认证后才能发帖')
    }
    throw new Error(data.msg || `提交失败：code=${data.code}`)
  }

  // ============ 登录态 ============

  /**
   * 解析登录凭证：读 cookie `GCZWU` 并拆成 uid / 用户名。
   * 读不到或格式不合法（uid 非数字）时返回 null。
   */
  private async resolveCredentials(): Promise<GuanchaCredentials | null> {
    const raw = await this.readLoginCookie()
    return parseLoginCookie(raw)
  }

  /** 读 cookie `GCZWU` */
  private async readLoginCookie(): Promise<string | null> {
    try {
      if (this.runtime.getCookie) {
        return await this.runtime.getCookie(COOKIE_DOMAIN, LOGIN_COOKIE)
      }
      const cookies = await this.runtime.cookies.get(COOKIE_DOMAIN)
      return cookies.find((c) => c.name === LOGIN_COOKIE)?.value || null
    } catch (error) {
      logger.debug(`[Guancha] 读取 cookie ${LOGIN_COOKIE} 失败：`, error)
      return null
    }
  }

  /**
   * 拉取用户提示信息（JSONP 接口，仅用于取头像）。
   * 失败时静默返回 null —— 登录态本身由 cookie 判定，不依赖该接口。
   */
  private async fetchUserTips(): Promise<GuanchaUserTips | null> {
    try {
      const resp = await this.runtime.fetch(USER_TIPS_URL, {
        credentials: 'include',
        headers: {
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
        },
      })
      if (!resp.ok) return null
      return this.parseJsonLike<GuanchaUserTips>(await resp.text())
    } catch (error) {
      logger.debug('[Guancha] 获取用户信息失败：', error)
      return null
    }
  }

  // ============ 工具方法 ============

  /** 标题规范化：超长截断到平台上限（不足下限由服务端裁决） */
  private normalizeTitle(title: string): string {
    const trimmed = (title || '').trim()
    if (trimmed.length > TITLE_MAX_LENGTH) {
      logger.warn(`[Guancha] 标题超过 ${TITLE_MAX_LENGTH} 字，已截断`)
      return trimmed.slice(0, TITLE_MAX_LENGTH)
    }
    if (trimmed.length < TITLE_MIN_LENGTH) {
      logger.warn(`[Guancha] 标题不足 ${TITLE_MIN_LENGTH} 字，平台可能拒绝发布`)
    }
    return trimmed
  }

  /** 去 HTML 标签后的纯文本（用于长度校验） */
  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  /** 取正文中第一张非 data URI 的图片地址（封面兜底） */
  private firstBodyImage(content: string): string | null {
    const re = /<img[^>]+src="([^"]+)"/gi
    let match: RegExpExecArray | null
    while ((match = re.exec(content)) !== null) {
      const src = match[1]
      if (src && !src.startsWith('data:')) return src
    }
    return null
  }

  /** 是否已是观察者网图床地址 */
  private isGuanchaCdn(url: string): boolean {
    return SKIP_IMAGE_PATTERNS.some((pattern) => url.includes(pattern))
  }

  /** 去掉 URL 的 query / fragment（封面用裸地址） */
  private stripQuery(url: string): string {
    if (url.startsWith('data:')) return url
    return url.split('#')[0].split('?')[0]
  }

  /** 我的文章页（结果提示用） */
  private myArticleUrl(uid: string): string {
    return `${SITE_ORIGIN}/user/personal-homepage?uid=${encodeURIComponent(uid)}&click=my-article`
  }

  /** 生成短随机名（上传文件名主体） */
  private uniqueName(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * 推断上传文件扩展名：优先用 blob 的 mime，其次取原 URL 后缀。
   * 服务端按上传文件名后缀产出图床对象名。
   */
  private resolveExtension(blobType: string, src: string): string {
    const mime = (blobType || '').toLowerCase()
    if (mime.includes('png')) return 'png'
    if (mime.includes('gif')) return 'gif'
    if (mime.includes('webp')) return 'webp'
    if (mime.includes('bmp')) return 'bmp'
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'

    const cleaned = src.split('?')[0].split('#')[0]
    const match = cleaned.match(/\.([a-zA-Z0-9]+)$/)
    return match ? match[1].toLowerCase() : 'jpg'
  }

  /**
   * 宽松解析响应：优先按 JSON 解析，失败则按 JSONP（`cb({...});` / `({...});`）剥壳。
   * 站点部分老接口（如 `get-user-tips`）默认返回 JSONP 包装。
   */
  private parseJsonLike<T>(text: string): T | null {
    const trimmed = (text || '').trim()
    if (!trimmed) return null

    try {
      return JSON.parse(trimmed) as T
    } catch {
      // 继续尝试 JSONP
    }

    const match = trimmed.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/)
    if (match) {
      try {
        return JSON.parse(match[1]) as T
      } catch {
        return null
      }
    }
    return null
  }
}

// ============ 模块级工具 ============

/**
 * 解析登录 cookie `GCZWU`。
 *
 * 站点 `mylib.getUserDataByCookie()` 的规则是 `value.split('-')`：
 * user[0] = uid，user[1] = 用户名（`encodeURI` 编码过，需要解码）。
 * uid 必须是纯数字，否则视为未登录（cookie 可能是脏数据）。
 */
function parseLoginCookie(raw: string | null): GuanchaCredentials | null {
  if (!raw) return null

  const separator = raw.indexOf('-')
  const uid = separator > 0 ? raw.slice(0, separator) : raw
  if (!/^\d+$/.test(uid)) return null

  let username: string | undefined
  if (separator > 0) {
    const encoded = raw.slice(separator + 1)
    try {
      username = decodeURIComponent(encoded) || undefined
    } catch {
      username = encoded || undefined
    }
  }
  return { uid, username }
}
