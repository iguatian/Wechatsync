/**
 * 淘江湖（淘宝社区，jianghu.taobao.com）适配器
 *
 * 平台资料：
 * - 社区首页：https://jianghu.taobao.com/
 * - 发帖编辑器：https://jianghu.taobao.com/editor.html
 * - 帖子详情：https://jianghu.taobao.com/detail/<appId>_<postId>
 *
 * ⚠️ 三个与常规适配器不同的关键点，改动前务必读完：
 *
 * 1）**没有服务端草稿**。整站只有一套 mtop 接口（见下方清单），不存在 createDraft 之类
 *    的接口；编辑器里的「草稿」只是 `localStorage["bbs_publish"]` 的本地缓存
 *    （HAR + 前端产物双向确认）。因此本适配器是**直接发布**，`draftOnly` 恒为 false ——
 *    文章提交后会进入平台审核（见下方 status 说明），审核通过即公开展示。
 *
 * 2）**接口是淘宝 mtop（h5api.m.taobao.com）**，请求必须带 `sign = md5(token & t & appKey & data)`，
 *    token 来自 cookie `_m_h5_tk` 的前半段。为了不做重复实现、也为了对齐页面的
 *    Origin / 安全 SDK 行为，本适配器**不自己拼 mtop 请求**，而是在一个
 *    `jianghu.taobao.com` 标签页的 MAIN world 里调用页面自带的 `window.lib.mtop.request()`
 *    （该组件由页面 `<script src=".../mtb/lib-mtop/2.5.1/mtop.js">` 注入，首页与编辑器页都有），
 *    由它负责 token 获取、签名与 TOKEN_EXPIRED 重试，与用户手动发帖完全等价。
 *    做法与 autohome / douyin 适配器一致（`tabs.executeScript` + MAIN world）。
 *
 *    ⚠️ 这一点不是「可选的优雅实现」，而是必要条件：HAR 抓到的发布请求 body 里除 `data` 外
 *    还带 `bx-ua` / `bx-umidtoken` / `bx_et` 三个**风控字段**（合计 2.4KB），它们由页面上的
 *    安全 SDK（`baxiaCommon.js` + `securitySDK.umd.js`，靠 hook `XMLHttpRequest.prototype`
 *    动态追加）生成。只有把 XHR 发在页面 MAIN world 里才会被 SDK 拦截并补齐；从扩展
 *    Service Worker 直接 fetch 必然缺少风控字段，大概率被 mtop 风控拒绝。
 *
 * 3）**必须指定板块分类（topicId）**。`editor.html` 直接打开时前端会强制用户在下拉框里
 *    「选择发布板块 / 选择板块分类」，不选不允许发布。本适配器先拉板块列表
 *    （`mtop.taobao.bbs.topic.list.get`），用 `article.category` / `article.tags`
 *    去匹配板块名或子分类名，匹配不到则退回「第一个带子分类的板块的第一个子分类」。
 *    前端逻辑（jinghu editor bundle `p_editorIndex`）：
 *      - 板块有 subTopics → 提交 subTopics[n].topicId
 *      - 板块无 subTopics → 提交板块自身的 topicId
 *    板块结构（首页 SSR 可直接读到，层级为「板块 → 子分类」）：
 *      茶馆(121402) → 闲唠八卦(122401) / 热点聚焦(123101) / 生活游记(122501) / AI工具(123001) …
 *      黑板报(121401) / 淘宝教育(121403) / 种草笔记(123402) / 实用经验(122601) / 美食分享(123801) …
 *    实测样本 `topicId=123101` 即「茶馆 → 热点聚焦」。
 *
 * 鉴权：
 *   **淘宝账号 SSO（Cookie）**。登录态体现在 `.taobao.com` 的用户号 cookie `unb`
 *   （登录后由淘宝统一登录域种下），页面本身不额外维护登录态。
 *   checkAuth 以 `unb` 是否存在为判据（批量检测时不额外开标签页）；若浏览器里
 *   已有淘江湖标签页，则顺带调 `mtop.taobao.bbs.user.getinfouser` 取昵称/头像
 *   （字段路径 `data.data.snsNick` / `data.data.avatar`，见 UserInfoData）。
 *   未登录时 mtop 统一返回 `ret: ["FAIL_SYS_SESSION_EXPIRED::Session过期"]`。
 *   注：HAR 里该接口带 `ecode=1`（需要登录）；本适配器仍用 `ecode=0` 调用 —— 一样能
 *   通过 `FAIL_SYS_SESSION_EXPIRED` 判定未登录，但不会触发 mtop 的自动跳登录页。
 *
 * 图片上传（HAR 验证，`jianghu.taobao.com.har` Entry #1~#3）：
 *   1. GET  /api/getConfig.api?appkey=taojianghu_pic_upload
 *      → { object: { uaToken, ncAppKey, bizConfigMap: { fileMaxSize: "10485760" } } }
 *      （上传前的配置探测，回传单文件大小上限 10MB；upload.api 本身不依赖它，可选）
 *   2. POST /api/upload.api?appkey=taojianghu_pic_upload&folderId=0&_input_charset=utf-8&useGtrSessionFilter=false
 *      （multipart/form-data）
 *        name = <文件名>          （与 file 同名的普通字段）
 *        file = <二进制，filename 要带正确后缀>
 *      → { object: { fileId, url: "https://img.alicdn.com/imgextra/i4/....jpg",
 *                    fileName, size, pix: "600x450", quality }, success: true, status: 0 }
 *      正文用 `object.url`。
 *   3. POST /api/collect_client_upload_rt.api （file_Id + rt + appkey，纯打点，可省）
 *
 *   该接口 CORS 只允许 `Origin: https://jianghu.taobao.com`，因此上传同样放在
 *   jianghu 标签页 MAIN world 里 fetch（Origin/Referer/Cookie 全部天然正确）。
 *
 * 发布（HAR + 前端产物双向验证，接口 `mtop.taobao.bbs.edit.content.post`）：
 *   `jianghu.taobao2.com.har` Entry #0 实测（POST，querystring `type=originaljson`），
 *   body 只有 `data=<encodeURIComponent(JSON.stringify(payload))>`（baxia 另行追加风控字段）。
 *   payload 字段与编辑器 `St()` 提交时逐字段一致：
 *     title          = encodeURI(标题)                （注意做了 encodeURI，标题上限 50 字）
 *     topicId        = <板块分类 id>                   （样本：123101）
 *     userInputTags  = JSON.stringify(tags.map(encodeURI))   （无标签传 "[]"）
 *     content        = encodeURI(JSON.stringify({ title, content: <正文 HTML> }))
 *     pattern        = 5                              （图文帖固定值）
 *     host           = "jianghu.taobao.com"
 *   其中 content 解出来的内层样本：
 *     {"title":"标题…","content":"<p>内容…<img src=\"https://img.alicdn.com/...jpg\" width=\"700\" alt=\"标题…\">…</p>"}
 *   （即内层 title 与 content 都是**原始未编码**的，靠外层两次 encodeURI 传递。）
 *   → { ret: ["SUCCESS::调用成功"],
 *       data: { code: 200, data: { status, appId, postId } } }
 *     status: 2 = 发布成功；3 = 内容违规发布失败；其它 = 提交成功、进入审核
 *     帖子地址：https://jianghu.taobao.com/detail/<appId>_<postId>
 *   ⚠️ 该 HAR 的响应体未导出（`response.content.text` 为 undefined，只留 size=215），
 *      所以响应结构来自编辑器产物（`I.data` → `{code, data:{status, appId, postId}}`），
 *      尚未用真实响应复验。
 *
 * 其它相关接口（本适配器用到 / 备用）：
 *   mtop.taobao.bbs.topic.list.get   { host }           板块列表（含子分类）
 *   mtop.taobao.bbs.user.getinfouser { host }           当前登录用户（昵称字段 snsNick）
 *   mtop.taobao.bbs.allow.publish    {}                 发帖权限（allowPubLive/Video/Item）
 *   mtop.taobao.bbs.edit.content.get { postId, host }   编辑已有帖子时回填
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Jianghu')

/** 站点 origin */
const SITE_ORIGIN = 'https://jianghu.taobao.com'

/** 社区首页（SPA 入口） */
const HOME_PAGE = `${SITE_ORIGIN}/`

/** 发帖编辑器（mtop 组件与安全 SDK 都在这里加载） */
const EDITOR_PAGE = `${SITE_ORIGIN}/editor.html`

/** 帖子接口统一使用的 host 参数（前端取 window.location.host） */
const SITE_HOST = 'jianghu.taobao.com'

/** mtop 业务接口 */
const API_TOPIC_LIST = 'mtop.taobao.bbs.topic.list.get'
const API_USER_INFO = 'mtop.taobao.bbs.user.getinfouser'
const API_CONTENT_POST = 'mtop.taobao.bbs.edit.content.post'

/** 图片上传（HAR 验证） */
const UPLOAD_APP_KEY = 'taojianghu_pic_upload'
const UPLOAD_URL =
  `https://stream-upload.taobao.com/api/upload.api` +
  `?appkey=${UPLOAD_APP_KEY}&folderId=0&_input_charset=utf-8&useGtrSessionFilter=false`

/** 图文帖固定 pattern（编辑器 `S={...,pattern:5}`） */
const PUBLISH_PATTERN = 5

/** 标题长度上限（编辑器校验：超过 50 字直接拦截发布） */
const TITLE_MAX_LENGTH = 50

/**
 * 兜底板块的优先顺序（当 `article.category` / `article.tags` 都没匹配上时使用）。
 *
 * 站点板块层级（首页 SSR 实测）：茶馆(121402) → 闲唠八卦(122401) / 热点聚焦(123101) / …
 * 其中「闲唠八卦」是最通用的闲聊板，作为任意文章的默认落点比列表首个板块更稳妥。
 */
const PREFERRED_TOPIC_NAMES = ['闲唠八卦', '茶馆']

/** 登录 cookie（淘宝 SSO 用户号） */
const LOGIN_COOKIE_NAME = 'unb'
const LOGIN_COOKIE_DOMAIN = 'taobao.com'

/**
 * 跳过转存的图床（阿里系 CDN，地址长期有效，无需再上传一遍）。
 * 注意不能加太宽的 `taobao.com`，否则会把 `stream-upload.taobao.com` 自身也匹配掉。
 */
const SKIP_IMAGE_PATTERNS = ['alicdn.com', 'tbcdn.cn', 'img.alicdn.com']

/** 页面 mtop 组件未就绪的错误前缀（用于给出更友好的提示） */
const MTOP_NOT_FOUND = 'MTOP_NOT_FOUND'

/** mtop 统一响应包装 */
interface MtopResponse<T> {
  api?: string
  data?: T
  ret?: string[]
  v?: string
  traceId?: string
}

/** 在页面 MAIN world 执行 mtop 请求的返回（必须可结构化克隆） */
interface MtopPageResult {
  ok: boolean
  data?: MtopResponse<unknown>
  error?: string
}

/** 在页面 MAIN world 执行图片上传的返回 */
interface UploadPageResult {
  ok: boolean
  status: number
  text: string
}

/** 板块节点（topic.list.get 返回结构） */
interface JianghuTopic {
  topicId?: number | string
  topicName?: string
  subTopics?: JianghuTopic[]
  [key: string]: unknown
}

/** 发帖接口响应里的 data.data */
interface ContentPostResult {
  status?: number
  appId?: number | string
  postId?: number | string
  [key: string]: unknown
}

/** 发帖接口响应 data */
interface ContentPostData {
  code?: number
  message?: string
  msg?: string
  data?: ContentPostResult
}

/**
 * `mtop.taobao.bbs.user.getinfouser` 响应 data（外层）。
 *
 * HAR 实测样本（`jianghu.taobao2.com.har` Entry #5）：
 *   { code: 200, message: "OK",
 *     data: { avatar: "https://img.alicdn.com/sns_logo/...jpg",
 *             snsNick: "布拉格", clientIpRegion: "北京市", userLevelModel: {...} } }
 * 注意昵称字段名是 **`snsNick`**（不是 nick/nickName），用户号要另取 `unb` cookie。
 */
interface UserInfoData {
  code?: number
  message?: string
  data?: {
    avatar?: string
    snsNick?: string
    [key: string]: unknown
  }
}

/** 选中的发布板块分类 */
interface ResolvedTopic {
  topicId: number | string
  /** 用于日志 / 结果提示的可读名字（板块/子分类） */
  name: string
}

export class JianghuAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'jianghu',
    name: '淘江湖',
    icon: 'https://www.taobao.com/favicon.ico',
    homepage: EDITOR_PAGE,
    // 平台无服务端草稿，故不声明 draft 能力
    capabilities: ['article', 'image_upload', 'tags', 'categories'],
  }

  /** 预处理配置：淘江湖编辑器（TinyMCE）正文为 HTML */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  /** 复用的 jianghu 标签页 id（首次 ensure 后缓存，避免每张图开一次 tab） */
  private cachedTabId: number | null = null

  // ============ checkAuth ============

  /**
   * 鉴权：以 `.taobao.com` 的用户号 cookie `unb` 为判据（淘江湖走淘宝 SSO，无独立登录态）。
   *
   * - 批量检测（一次十几个平台）时**不新建标签页**，只查现有 tab；
   * - 已有淘江湖 tab 时顺带调 `user.getinfouser` 取昵称/头像。
   */
  async checkAuth(): Promise<AuthResult> {
    try {
      const unb = this.runtime.getCookie
        ? await this.runtime.getCookie(LOGIN_COOKIE_DOMAIN, LOGIN_COOKIE_NAME)
        : null

      const existingTabId = await this.findExistingTabId()
      if (existingTabId !== null) {
        try {
          const info = await this.requestMtopInTab<UserInfoData>(
            existingTabId,
            API_USER_INFO,
            { host: SITE_HOST },
          )
          // 实际字段在 info.data.data 里（见 UserInfoData 注释）
          const user = info.data?.data || {}
          const username = this.firstString(user, 'snsNick', 'nick', 'nickName', 'nickname')
          if (!unb && !username) {
            return {
              isAuthenticated: false,
              error: `请先登录淘宝账号后打开 ${EDITOR_PAGE}`,
            }
          }
          return {
            isAuthenticated: true,
            // 该接口不回传用户号，用 `unb` cookie（HAR 中 s_tag 里的 taoMainUser 也是它）
            userId: unb || undefined,
            username,
            avatar: this.firstString(user, 'avatar', 'headImg', 'headPic'),
          }
        } catch (error) {
          logger.debug('[Jianghu] 现有 tab 校验登录态失败，回退 cookie 判据：', error)
        }
      }

      if (!unb) {
        return {
          isAuthenticated: false,
          error: `请先登录淘宝账号（打开 ${EDITOR_PAGE} 后会自动跳转登录）`,
        }
      }
      return { isAuthenticated: true, userId: unb }
    } catch (error) {
      logger.debug('checkAuth error:', error)
      return {
        isAuthenticated: false,
        error: (error as Error).message || '鉴权失败',
      }
    }
  }

  // ============ publish ============

  /**
   * 发布文章（**直接发布，平台无草稿**）。
   *
   * 流程：
   *   1. 拉板块列表 → 解析出 topicId（板块分类）
   *   2. processImages 转存正文图片（走 stream-upload）
   *   3. mtop.taobao.bbs.edit.content.post 提交
   */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    logger.info('Starting publish to Jianghu...')

    try {
      // 1. 发布板块
      const topic = await this.resolveTopic(article)
      logger.info(`[Jianghu] 目标板块：${topic.name}（topicId=${topic.topicId}）`)

      // 2. 正文图片
      let content = article.html || ''
      if (content && !/<img|!\[[^\]]*\]\(/.test(content)) {
        logger.debug('[Jianghu] 正文无图片，跳过图片转存')
      }
      try {
        content = await this.processImages(content, (src) => this.uploadImageByUrl(src), {
          skipPatterns: SKIP_IMAGE_PATTERNS,
          onProgress: options?.onImageProgress,
        })
      } catch (e) {
        logger.warn('[Jianghu] 正文图片处理中途失败，继续发布：', (e as Error).message)
      }

      // 3. 组装提交数据（字段与编辑器 St() 完全一致）
      const rawTitle = (article.title || '').trim()
      const title = this.truncateTitle(rawTitle)
      const tags = (article.tags || []).filter((t) => !!t)
      const payload = {
        title: encodeURI(title),
        topicId: topic.topicId,
        userInputTags: JSON.stringify(tags.map((t) => encodeURI(t))),
        content: encodeURI(JSON.stringify({ title, content })),
        pattern: PUBLISH_PATTERN,
        host: SITE_HOST,
      }

      const resp = await this.requestMtop<ContentPostData>(API_CONTENT_POST, payload, 'POST')
      const body = resp.data || {}
      if (body.code !== 200) {
        throw new Error(`发布失败：${body.message || body.msg || `code=${body.code}`}`)
      }

      const result = body.data || {}
      const postId = result.postId === undefined || result.postId === null ? '' : String(result.postId)
      const appId = result.appId === undefined || result.appId === null ? '' : String(result.appId)
      const status = result.status
      const postUrl = postId ? `${SITE_ORIGIN}/detail/${appId}_${postId}` : HOME_PAGE

      const titleNote =
        rawTitle.length > TITLE_MAX_LENGTH
          ? `；标题超过 ${TITLE_MAX_LENGTH} 字已截断`
          : ''

      logger.info(`[Jianghu] 发布完成：status=${status} postId=${postId}`)
      return this.createResult(true, {
        postId: postId || undefined,
        postUrl,
        // 平台无草稿，提交即进入审核
        draftOnly: false,
        message:
          (status === 2
            ? '已发布到淘江湖'
            : status === 3
              ? '淘江湖判定内容违规，发布未通过'
              : '已提交到淘江湖，正在审核中') +
          `（板块：${topic.name}）${titleNote}`,
      })
    } catch (error) {
      return this.createResult(false, {
        error: (error as Error).message,
      })
    }
  }

  // ============ 图片上传 ============

  /**
   * 正文图片上传（被基类 `processImages` 调用）。
   * 失败时保留原 URL，不阻断整体同步。
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    try {
      const url = await this.uploadImageToJianghu(src)
      return { url }
    } catch (error) {
      logger.warn('[Jianghu] 图片上传失败，保留原 URL:', this.displayUrl(src), error)
      return { url: src }
    }
  }

  /**
   * 上传单张图片到淘江湖图床（在 jianghu tab 的 MAIN world 里 fetch）。
   * POST /api/upload.api（multipart：name + file）
   */
  private async uploadImageToJianghu(src: string): Promise<string> {
    // 1. 取图片二进制
    let blob: Blob
    if (src.startsWith('data:')) {
      blob = await this.dataUriToBlob(src)
    } else {
      const encodedSrc = this.encodeUrlPath(src)
      const imageResponse = await fetch(encodedSrc, { credentials: 'omit' })
      if (!imageResponse.ok) {
        throw new Error(`图片下载失败 (${imageResponse.status}): ${this.displayUrl(src)}`)
      }
      blob = await imageResponse.blob()
    }

    // 2. Blob → base64（跨 executeScript 边界只能传字符串）
    const dataUri = await this.blobToDataUri(blob)
    const base64 = dataUri.substring(dataUri.indexOf(',') + 1)
    const filename = `${Date.now()}.${this.extensionFor(blob.type)}`

    // 3. 在页面上下文上传
    const tabId = await this.ensureTab()
    const result = await this.runtime.tabs!.executeScript<
      UploadPageResult,
      [UploadImageParams]
    >(tabId, uploadImageInPageScript, [
      { url: UPLOAD_URL, base64, mime: blob.type || 'image/jpeg', filename },
    ])

    if (!result || !result.ok) {
      throw new Error(
        `图片上传失败 (HTTP ${result?.status ?? 0}): ${(result?.text || '').substring(0, 200)}`,
      )
    }

    let parsed: { object?: { url?: string } }
    try {
      parsed = JSON.parse(result.text) as { object?: { url?: string } }
    } catch {
      throw new Error(`图片上传失败：响应非 JSON: ${result.text.substring(0, 200)}`)
    }

    const url = parsed.object?.url
    if (!url) {
      throw new Error(`图片上传失败：响应缺少 object.url: ${result.text.substring(0, 200)}`)
    }
    logger.debug(`[Jianghu] 图片上传成功：${url}`)
    return url
  }

  // ============ 板块解析 ============

  /** 拉取可发布板块列表 */
  private async fetchTopics(): Promise<JianghuTopic[]> {
    const resp = await this.requestMtop<{ code?: number; data?: JianghuTopic[] }>(
      API_TOPIC_LIST,
      { host: SITE_HOST },
    )
    const body = resp.data || {}
    const list = Array.isArray(body.data) ? body.data : []
    return list.filter((t) => t && t.topicId !== undefined && t.topicId !== null)
  }

  /**
   * 解析发布板块分类。
   *
   * 优先级：
   *   1. `article.category` → `article.tags` 依次匹配子分类名 / 板块名；
   *   2. 都匹配不到时，按 `PREFERRED_TOPIC_NAMES` 选站点通用板块（避免落到
   *      「平台规则」「黑板报」这类公告板）；
   *   3. 再兜底「第一个带子分类的板块的第一个子分类」，最后退回该板块自身。
   *
   * 说明：与编辑器一致 —— 板块有子分类时提交子分类 id，没有时才提交板块 id。
   */
  private async resolveTopic(article: Article): Promise<ResolvedTopic> {
    const topics = await this.fetchTopics()
    if (topics.length === 0) {
      throw new Error(
        `未能获取淘江湖发布板块，请先在浏览器登录并打开 ${EDITOR_PAGE} 后重试`,
      )
    }

    logger.debug(
      `[Jianghu] 可发布板块：${topics
        .map((b) => `${b.topicName || ''}(${b.topicId})`)
        .join('、')}`,
    )

    const userKeywords = [article.category, ...(article.tags || [])]
      .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
      .map((k) => k.trim())

    for (const keyword of userKeywords) {
      const matched = this.matchTopic(topics, keyword)
      if (matched) {
        logger.info(`[Jianghu] 板块按关键词「${keyword}」命中：${matched.name}`)
        return matched
      }
      logger.debug(`[Jianghu] 板块匹配未命中关键词「${keyword}」，继续尝试下一个`)
    }

    for (const preferred of PREFERRED_TOPIC_NAMES) {
      const matched = this.matchTopic(topics, preferred)
      if (matched) {
        logger.warn(`[Jianghu] 未匹配到指定板块，回退为站点通用板块：${matched.name}`)
        return matched
      }
    }

    const fallback = topics.find((b) => (b.subTopics || []).length > 0) || topics[0]
    const resolved = this.pickFromBoard(fallback)
    logger.warn(`[Jianghu] 未匹配到指定板块，回退为列表首个板块：${resolved.name}`)
    return resolved
  }

  /** 用关键词匹配板块（先子分类后板块本身），未命中返回 null */
  private matchTopic(topics: JianghuTopic[], keyword: string): ResolvedTopic | null {
    // 先匹配子分类
    for (const board of topics) {
      for (const sub of board.subTopics || []) {
        if (sub.topicId !== undefined && sub.topicId !== null && this.nameMatches(sub.topicName, keyword)) {
          return {
            topicId: sub.topicId,
            name: `${board.topicName || ''}/${sub.topicName || ''}`,
          }
        }
      }
    }
    // 再匹配板块本身
    for (const board of topics) {
      if (this.nameMatches(board.topicName, keyword)) {
        return this.pickFromBoard(board)
      }
    }
    return null
  }

  /** 板块有子分类则取第一个子分类，否则取板块自身 */
  private pickFromBoard(board: JianghuTopic): ResolvedTopic {
    const sub = (board.subTopics || [])[0]
    if (sub && sub.topicId !== undefined && sub.topicId !== null) {
      return {
        topicId: sub.topicId,
        name: `${board.topicName || ''}/${sub.topicName || ''}`,
      }
    }
    return { topicId: board.topicId as number | string, name: board.topicName || String(board.topicId) }
  }

  /** 板块/分类名匹配（双向包含，忽略大小写与空白） */
  private nameMatches(topicName: string | undefined, keyword: string): boolean {
    if (!topicName) return false
    const a = topicName.trim().toLowerCase()
    const b = keyword.trim().toLowerCase()
    return a === b || a.includes(b) || b.includes(a)
  }

  // ============ 标签页 & mtop ============

  /**
   * 找一个可用的 jianghu 标签页；没有则打开编辑器页。
   * 结果缓存在实例上，避免每张图片都重新查询 / 开 tab。
   */
  private async ensureTab(): Promise<number> {
    if (!this.runtime.tabs) {
      throw new Error('当前环境不支持标签页操作（淘江湖适配器仅支持扩展环境）')
    }

    if (this.cachedTabId !== null) {
      try {
        // 探活：tab 被关掉时 executeScript 会抛错
        await this.runtime.tabs.executeScript<number, []>(this.cachedTabId, () => 1, [])
        return this.cachedTabId
      } catch {
        this.cachedTabId = null
      }
    }

    const existing = await this.findExistingTabId()
    if (existing !== null) {
      this.cachedTabId = existing
      return existing
    }

    logger.info(`[Jianghu] 后台打开 ${EDITOR_PAGE} 以发起接口请求...`)
    const tab = await this.runtime.tabs.create(EDITOR_PAGE, false)
    await this.runtime.tabs.waitForLoad(tab.id, 45000)
    this.cachedTabId = tab.id
    return tab.id
  }

  /** 查找已存在的 jianghu 标签页（无副作用） */
  private async findExistingTabId(): Promise<number | null> {
    if (!this.runtime.tabs) return null
    try {
      const tabs = await this.runtime.tabs.query('*://jianghu.taobao.com/*')
      const first = tabs[0]
      return first && first.id !== undefined ? first.id : null
    } catch (error) {
      logger.debug('[Jianghu] 查询 jianghu 标签页失败：', error)
      return null
    }
  }

  /** 发起 mtop 请求（自动 ensure 标签页） */
  private async requestMtop<T>(
    api: string,
    data: Record<string, unknown>,
    method: 'GET' | 'POST' = 'GET',
  ): Promise<MtopResponse<T>> {
    const tabId = await this.ensureTab()
    return this.requestMtopInTab<T>(tabId, api, data, method)
  }

  /** 在指定标签页里发起 mtop 请求，并把 ret 失败转成异常 */
  private async requestMtopInTab<T>(
    tabId: number,
    api: string,
    data: Record<string, unknown>,
    method: 'GET' | 'POST' = 'GET',
  ): Promise<MtopResponse<T>> {
    const res = await this.runtime.tabs!.executeScript<MtopPageResult, [MtopRequestParams]>(
      tabId,
      requestMtopInPageScript,
      [{ api, data, method }],
    )

    if (!res || !res.ok) {
      const err = res?.error || ''
      if (err.startsWith(MTOP_NOT_FOUND)) {
        throw new Error(`淘江湖页面组件未就绪，请刷新 ${EDITOR_PAGE} 后重试`)
      }
      if (err.includes('FAIL_SYS_SESSION_EXPIRED')) {
        throw new Error(`淘江湖登录态已失效，请重新登录淘宝账号（${EDITOR_PAGE}）`)
      }
      throw new Error(`淘江湖接口 ${api} 调用失败：${err || '未知错误'}`)
    }

    const payload = (res.data || {}) as MtopResponse<T>
    const ret = payload.ret?.[0] || ''
    if (ret && !ret.startsWith('SUCCESS')) {
      if (ret.includes('FAIL_SYS_SESSION_EXPIRED')) {
        throw new Error(`淘江湖登录态已失效，请重新登录淘宝账号（${EDITOR_PAGE}）`)
      }
      throw new Error(`淘江湖接口 ${api} 返回失败：${ret}`)
    }
    return payload
  }

  // ============ 工具方法 ============

  /** 标题截断（编辑器硬限制 50 字） */
  private truncateTitle(title: string): string {
    if (title.length <= TITLE_MAX_LENGTH) return title
    return title.substring(0, TITLE_MAX_LENGTH)
  }

  /** 按候选键名依次取第一个非空字符串（应对接口字段名在不同版本间漂移） */
  private firstString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
    for (const key of keys) {
      const value = obj[key]
      if (typeof value === 'string' && value) return value
    }
    return undefined
  }

  /** 由 mime 推断文件扩展名（服务端按上传文件名后缀产出 CDN 对象名） */
  private extensionFor(mime: string): string {
    const normalized = (mime || '').toLowerCase()
    if (normalized.includes('png')) return 'png'
    if (normalized.includes('gif')) return 'gif'
    if (normalized.includes('webp')) return 'webp'
    if (normalized.includes('bmp')) return 'bmp'
    if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg'
    return 'jpg'
  }

  /** 日志展示用的 URL：data URI / 超长地址只留前缀 */
  private displayUrl(url: string): string {
    return url.length > 120 ? `${url.slice(0, 80)}…（共 ${url.length} 字符）` : url
  }
}

// ============ 页面 MAIN world 脚本（必须是纯函数，禁止引用模块级变量）============

/** mtop 请求参数（必须可结构化克隆） */
interface MtopRequestParams {
  api: string
  data: Record<string, unknown>
  method: 'GET' | 'POST'
}

/** 图片上传参数 */
interface UploadImageParams {
  url: string
  base64: string
  mime: string
  filename: string
}

/**
 * 在页面上下文调用页面自带的 mtop 组件发请求。
 *
 * ⚠️ 纯函数约束（MV3 executeScript 闭包序列化陷阱）：本函数会被序列化后在页面
 * MAIN world 执行，禁止引用模块级函数/常量（生产构建会被混淆，页面报
 * "xx is not defined"）。参数全部通过入参传递。
 *
 * 参数与编辑器自身的包装函数保持一致：
 *   v=1.0 / ecode=0 / dataType=jsonp / valueType=original / jsonpIncPrefix=tbbe
 *   type=POST 时组件走 XHR POST（否则走 JSONP GET）——与本适配器一致。
 */
async function requestMtopInPageScript(params: MtopRequestParams): Promise<MtopPageResult> {
  const w = window as unknown as {
    lib?: { mtop?: { request: (options: Record<string, unknown>) => Promise<unknown> } }
  }
  const mtop = w.lib && w.lib.mtop
  if (!mtop || typeof mtop.request !== 'function') {
    return { ok: false, error: 'MTOP_NOT_FOUND::页面未加载 mtop 组件' }
  }

  try {
    const res = await mtop.request({
      api: params.api,
      v: '1.0',
      ecode: 0,
      timeout: 15000,
      dataType: 'jsonp',
      valueType: 'original',
      jsonpIncPrefix: 'tbbe',
      H5Request: true,
      type: params.method || 'GET',
      data: params.data || {},
      needLogin: false,
    })
    return { ok: true, data: res as MtopResponse<unknown> }
  } catch (e) {
    const err = e as { ret?: string[] | string; message?: string }
    let message: string
    if (err && err.ret) {
      message = Array.isArray(err.ret) ? err.ret.join(',') : String(err.ret)
    } else if (err && err.message) {
      message = err.message
    } else {
      message = String(e)
    }
    return { ok: false, error: message }
  }
}

/**
 * 在页面上下文上传图片（Origin/Referer/Cookie 天然与用户手动上传一致）。
 *
 * multipart 字段与 HAR 一致：普通字段 `name` + 文件字段 `file`（filename 带后缀）。
 */
async function uploadImageInPageScript(
  params: UploadImageParams,
): Promise<UploadPageResult> {
  try {
    const binary = atob(params.base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    const file = new File([bytes], params.filename, { type: params.mime })

    const form = new FormData()
    form.append('name', params.filename)
    form.append('file', file, params.filename)

    const resp = await fetch(params.url, {
      method: 'POST',
      credentials: 'include',
      body: form,
    })
    const text = await resp.text()
    return { ok: resp.ok, status: resp.status, text }
  } catch (e) {
    return { ok: false, status: 0, text: (e as Error).message || String(e) }
  }
}
