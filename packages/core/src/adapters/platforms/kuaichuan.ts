/**
 * 快传号（360 自媒体平台，kuaichuan.360kuai.com）适配器
 *
 * 平台资料：
 * - 创作后台首页：https://kuaichuan.360kuai.com/
 * - 草稿编辑页：https://kuaichuan.360kuai.com/#/console/publish/article?edit=<草稿id>
 * - 图文管理（含草稿列表）：https://kuaichuan.360kuai.com/#/console/manage/content/article
 *
 * ⚠️ 该站用 `new VueRouter({ routes })` 未传 mode → Vue Router 3 默认 **hash 模式**，
 *    所以所有前端 URL 都带 `#`（HAR 里 Referer 只有 `https://kuaichuan.360kuai.com/`
 *    也印证了这点：hash 不会进入 Referer）。路由表见 main.app.js：
 *    `{path:"publish", redirect:"/console/publish/article", children:[{name:"ConsolePublishArticle", path:"article"}]}`
 *    草稿列表点「编辑」是 `$router.push({ query: { edit: id, create_time } })`
 *    （只改 query，路径不变），即复用发文页 + `?edit=` 参数。
 *
 * 鉴权（HAR + 站点探测验证）：
 *   **纯 Cookie 鉴权**，不依赖任何 Authorization 头（HAR 中所有请求均无鉴权头）。
 *   未登录时所有业务接口统一返回 `{ errno: 12, errmsg: "未登录360账号" }`。
 *   - 主路径：GET https://kuaichuan.360kuai.com/ 由服务端注入 `window.user = {...}`，
 *     其中 `qid` 非空即已登录（前端自身也是用 `window.user.qid` 判断的：
 *     `getCurrentUserData = () => window.user?.qid ? true : false`），
 *     一次请求同时拿到昵称（name）与头像（img）。
 *   - 兜底：GET /ugcCityData/getTcType（errno === 12 即未登录）。
 *
 * 图片上传（HAR 验证）：
 *   POST /upload/img?source=post   （multipart/form-data）
 *     fields: img = <binary>（文件名字段需带正确后缀，服务端按后缀产出 CDN 对象名）
 *   响应: { errno: 0, errmsg: "ok",
 *           data: { url: "https://p0.ssl.img.360kuai.com/t1....png?size=1200x630",
 *                   type: "image/png", file_md5: "..." } }
 *
 * 保存草稿（HAR 验证）：
 *   1. GET /token/gettoken
 *      → { errno: 0, errmsg: "", data: "<32位hex>" }（CSRF token，每次提交前重新取）
 *   2. POST /articleManage/doDraft   （application/x-www-form-urlencoded）
 *      body（字段顺序与 HAR 样本一致）：
 *        exclusive=0           是否独家
 *        ai_type=              AI 标签
 *        status_fixed_time=0   定时发布开关（0 = 不定时）
 *        fixed_time=0          定时发布时间
 *        title=<标题>
 *        content=<正文 HTML>
 *        image_list[0]=<封面图 URL>      封面图列表（URL 数组）
 *        image_style=<封面样式>           1 = 单张，4 = 多图（封面组件单选的 label 只有这两个值，
 *                                        且编辑器 mounted 里无条件 `article.cover = 1`）
 *        token=<gettoken 返回值>
 *        topic_id= / c_topic= / cate=     话题/分类，HAR 样本为空
 *      → { errno: 0, errmsg: "ok", data: { id: 7737129 } }
 *
 * 封面（编辑器封面组件 ConsolePublishArticleCover 逻辑）：
 *   单张(1) / 多图(4) 两种模式；图片可来自正文图片或本地上传，
 *   尺寸要求 **宽、高均 ≥ 100px**（不满足会提示「宽和高得大于100像素」），无强制宽高比。
 *   `image_list` 里的 URL 走的是同一个 `/upload/img?source=post`（编辑器里会先过一遍裁剪器
 *   再上传，裁剪只是 UI 行为，不是服务端硬性校验）。
 *   本适配器策略：article.cover → 正文首图 → 无（并在 message 里注明封面来源，便于排查）。
 *
 * 请求模式：
 * - 快传号接口响应不带 CORS 头，扩展 SW 依赖 host_permissions 直连
 *   （manifest 的 host_permissions 已放开 https://任意域名/*）。
 * - 为与 HAR 对齐，通过 headerRules 注入 Origin / Referer。
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Kuaichuan')

/** 站点 origin */
const SITE_ORIGIN = 'https://kuaichuan.360kuai.com'

/** 首页（服务端注入 window.user，用于鉴权 + 昵称头像；同时是 SPA 入口） */
const HOME_PAGE = `${SITE_ORIGIN}/`

/** 图文管理 / 草稿箱（保存成功后的落点，hash 路由） */
const DRAFT_LIST = `${SITE_ORIGIN}/#/console/manage/content/article`

/** 用户状态探测接口（checkAuth 兜底） */
const USER_TYPE_URL = `${SITE_ORIGIN}/ugcCityData/getTcType`

/** 图片上传接口（source=post 为图文发文场景） */
const UPLOAD_URL = `${SITE_ORIGIN}/upload/img?source=post`

/** CSRF token 接口 */
const TOKEN_URL = `${SITE_ORIGIN}/token/gettoken`

/** 保存草稿接口 */
const DRAFT_URL = `${SITE_ORIGIN}/articleManage/doDraft`

/**
 * 草稿列表接口（`getDraftList = params => GET /article/draft`，图文草稿传 `type=0`）。
 * 草稿编辑链接需要 `create_time`，而 doDraft 只返回 id，所以保存后回查一次列表补全。
 */
const DRAFT_LIST_URL = `${SITE_ORIGIN}/article/draft`

/** 未登录错误码（HAR 之外由站点探测确认） */
const ERR_NOT_LOGIN = 12

/** 业务成功错误码 */
const ERR_OK = 0

/** 图片上传 multipart 字段名（HAR 验证） */
const UPLOAD_FIELD_NAME = 'img'

/** 跳过重传的图床域名（已属于快传号 / 360 CDN） */
const SKIP_IMAGE_PATTERNS = ['360kuai.com', 'qhimg.com', 'qhmsg.com', 'qhres2.com']

/** 快传号统一响应包装 */
interface KcEnvelope<T> {
  errno?: number
  errmsg?: string
  data?: T
}

/** /user 解析结果 */
interface KcWindowUser {
  qid: string
  name: string
  img: string
}

/** 图片上传响应 data */
interface KcUploadData {
  url?: string
  type?: string
  file_md5?: string
}

/** 保存草稿响应 data */
interface KcDraftData {
  id?: number
}

/** 草稿列表响应 data */
interface KcDraftListData {
  draft_list?: Array<{ id?: number; create_time?: string; title?: string; [key: string]: unknown }>
  [key: string]: unknown
}

/** doDraft 请求参数 */
interface KcDraftParams {
  title: string
  content: string
  /** 封面图 URL（可为空） */
  coverUrl: string
  /** CSRF token */
  token: string
}

/**
 * 草稿编辑页 URL（hash 路由）。
 *
 * 官方链接形态（草稿列表点「编辑」时 push 的 query）：
 *   `#/console/publish/article?edit=<id>&create_time=<yyyy-MM-dd HH:mm:ss>`
 * 其中 create_time 会被 URL 编码成 `2026-09-21%2014%3A45%3A29`（注意是 %20 不是 +，
 * Vue Router 的 query 解析不会把 + 还原成空格，所以用 encodeURIComponent 拼）。
 *
 * create_time 缺失时仍然给 `?edit=<id>`，编辑器会用
 * `GET /article/edit?id=<id>`（axios 丢弃 undefined 的 create_time）尝试加载。
 */
function buildDraftUrl(draftId: string, createTime?: string | null): string {
  const base = `${SITE_ORIGIN}/#/console/publish/article?edit=${encodeURIComponent(draftId)}`
  return createTime ? `${base}&create_time=${encodeURIComponent(createTime)}` : base
}

export class KuaichuanAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'kuaichuan',
    name: '快传号',
    icon: 'https://p0.ssl.qhimg.com/t0144491522ec4696d3.png',
    homepage: HOME_PAGE,
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  /** 预处理配置：快传号编辑器正文为 HTML */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  /**
   * Header 规则：对齐 HAR 抓包（Origin / Referer）。
   * 快传号接口无 CORS 头，SW 靠 host_permissions 直连；注入头仅为进一步对齐浏览器行为。
   */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://kuaichuan.360kuai.com/*',
      headers: {
        Origin: SITE_ORIGIN,
        Referer: HOME_PAGE,
      },
    },
  ]

  // ============ checkAuth ============

  /**
   * 鉴权：优先解析首页服务端注入的 `window.user`，失败时退化到 /ugcCityData/getTcType。
   * 与快传号前端一致：`window.user.qid` 非空即已登录。
   */
  async checkAuth(): Promise<AuthResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      try {
        // 1. 首页 HTML（一次请求同时拿到登录态 + 昵称 + 头像）
        const html = await this.fetchHomePage()
        if (html) {
          const user = this.parseWindowUser(html)
          if (user) {
            if (!user.qid) {
              return {
                isAuthenticated: false,
                error: '请先登录快传号（https://kuaichuan.360kuai.com/）',
              }
            }
            return {
              isAuthenticated: true,
              userId: user.qid,
              username: user.name || undefined,
              avatar: user.img || undefined,
            }
          }
          logger.debug('[Kuaichuan] 首页未找到 window.user，改用 getTcType 兜底')
        }

        // 2. 兜底接口
        const resp = await this.get<KcEnvelope<unknown>>(USER_TYPE_URL, {
          Accept: 'application/json, text/plain, */*',
        })
        if (resp.errno === ERR_OK) {
          return { isAuthenticated: true }
        }
        if (resp.errno === ERR_NOT_LOGIN) {
          return {
            isAuthenticated: false,
            error: '请先登录快传号（https://kuaichuan.360kuai.com/）',
          }
        }
        return {
          isAuthenticated: false,
          error: resp.errmsg || `鉴权失败：errno=${resp.errno}`,
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
   *   1. 处理正文图片（上传到 360 图床并替换 src）
   *   2. 确定封面：article.cover → 正文首图 → 无
   *   3. GET /token/gettoken 取 CSRF token
   *   4. POST /articleManage/doDraft 保存草稿，响应 data.id 即草稿 ID
   */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish to Kuaichuan...')

      // 1. 正文图片
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
        logger.warn('[Kuaichuan] processImages 中途失败，继续发布：', (e as Error).message)
      }

      // 2. 封面：优先显式封面，其次退回正文首图
      let coverUrl = ''
      let coverError: string | undefined
      let coverSource = '无'
      if (article.cover) {
        try {
          const cover = await this.uploadImageToKc(article.cover)
          coverUrl = cover.url
          coverSource = '同步来源封面'
          logger.info(`[Kuaichuan] 封面上传成功：${coverUrl}`)
        } catch (e) {
          coverError = (e as Error).message
          logger.warn('[Kuaichuan] 封面上传失败：', coverError)
        }
      }
      if (!coverUrl) {
        coverUrl = this.firstBodyImage(content) || ''
        if (coverUrl) {
          coverSource = '正文首图（未提供封面时的回退）'
          logger.info('[Kuaichuan] 未提供封面，使用正文首图作为封面')
        } else {
          logger.warn('[Kuaichuan] 未提供封面且正文无图，image_list 为空')
        }
      }

      // 3. CSRF token
      const token = await this.fetchToken()

      // 4. 保存草稿
      const draftId = await this.saveDraft({
        title: article.title,
        content,
        coverUrl,
        token,
      })

      // 5. 回查 create_time，拼出与编辑器一致的草稿编辑链接
      const createTime = await this.fetchDraftCreateTime(draftId)

      logger.info(`[Kuaichuan] 草稿已保存：${draftId}（create_time=${createTime || '未知'}）`)
      return this.createResult(true, {
        postId: draftId,
        postUrl: buildDraftUrl(draftId, createTime),
        draftOnly: options?.draftOnly ?? true,
        coverUploaded: !!coverUrl,
        coverUrl: coverUrl || undefined,
        ...(coverError ? { coverError } : {}),
        // 封面来源写进 message，便于排查「草稿里没有封面」时快速定位是上传失败还是没传
        message: `已保存到快传号草稿箱（${DRAFT_LIST}）；封面来源：${coverSource}`,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  // ============ 图片上传 ============

  /**
   * 正文图片上传（被 processImages 调用）。
   * 失败时保留原 URL 不阻断整体同步。
   *
   * 说明：HAR 样本里编辑器会给已转存的正文图补上 `data-replaced="true"` 标记，
   * 这里通过 attrs 一并写入，保持与编辑器自身产物一致。
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    try {
      const result = await this.uploadImageToKc(src)
      return { url: result.url, attrs: { 'data-replaced': 'true' } }
    } catch (error) {
      logger.warn('[Kuaichuan] 正文图片上传失败，保留原 URL:', src, error)
      return { url: src }
    }
  }

  /**
   * 上传单张图片（正文 / 封面共用）。
   * POST /upload/img?source=post（multipart，字段名 `img`）
   */
  private async uploadImageToKc(src: string): Promise<{ url: string }> {
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

    // 2. multipart 上传（文件后缀决定 CDN 对象名后缀，需带正确扩展名）
    const filename = `image.${this.extensionFor(blob.type)}`
    const formData = new FormData()
    formData.append(UPLOAD_FIELD_NAME, blob, filename)

    const resp = await this.runtime.fetch(UPLOAD_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json, text/plain, */*' },
      body: formData,
    })
    const data = await this.parseEnvelope<KcUploadData>(resp, '图片上传失败')

    if (!data?.url) {
      throw new Error('图片上传失败：响应缺少 url')
    }
    return { url: data.url }
  }

  // ============ 草稿保存 ============

  /** 取 CSRF token（GET /token/gettoken，data 为字符串） */
  private async fetchToken(): Promise<string> {
    const resp = await this.runtime.fetch(TOKEN_URL, {
      headers: { Accept: 'application/json, text/plain, */*' },
    })
    const text = await resp.text()

    let data: KcEnvelope<unknown>
    try {
      data = JSON.parse(text) as KcEnvelope<unknown>
    } catch {
      throw new Error(`获取 token 失败：响应非 JSON (HTTP ${resp.status}): ${text.substring(0, 200)}`)
    }
    if (data.errno !== ERR_OK || typeof data.data !== 'string' || !data.data) {
      throw new Error(this.describeError(data, '获取 token 失败'))
    }
    return data.data
  }

  /**
   * 保存草稿：POST /articleManage/doDraft（form-urlencoded）。
   * 字段顺序对齐 HAR 抓包样本（服务端按 name 取值，顺序影响不大，但保持一致便于排查）。
   */
  private async saveDraft(params: KcDraftParams): Promise<string> {
    const body = new URLSearchParams()
    body.append('exclusive', '0')
    body.append('ai_type', '')
    body.append('status_fixed_time', '0')
    body.append('fixed_time', '0')
    body.append('title', params.title)
    body.append('content', params.content)
    if (params.coverUrl) {
      // image_list 是 URL 数组，单封面 → image_list[0]
      body.append('image_list[0]', params.coverUrl)
    }
    // image_style 对应封面组件的单选：1 = 单张，4 = 多图（label 只有这两个值），
    // 且编辑器 mounted 里无条件把 article.cover 置为 1，所以这里固定发 1。
    body.append('image_style', '1')
    body.append('token', params.token)
    body.append('topic_id', '')
    body.append('c_topic', '')
    body.append('cate', '')

    const resp = await this.runtime.fetch(DRAFT_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json, text/plain, */*',
        Referer: HOME_PAGE,
      },
      body: body.toString(),
    })
    const data = await this.parseEnvelope<KcDraftData>(resp, '保存草稿失败')

    if (data?.id === undefined || data.id === null) {
      throw new Error('保存草稿失败：响应未含草稿 id')
    }
    return String(data.id)
  }

  // ============ 工具方法 ============

  /** 拉取首页 HTML（鉴权信息由服务端注入其中） */
  private async fetchHomePage(): Promise<string | null> {
    try {
      const resp = await this.runtime.fetch(HOME_PAGE, {
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      })
      if (!resp.ok) return null
      return await resp.text()
    } catch (error) {
      logger.debug('[Kuaichuan] 获取首页失败：', error)
      return null
    }
  }

  /**
   * 回查草稿的 create_time。
   *
   * doDraft 只返回 `{id}`，而草稿编辑链接需要 `create_time`（形如 `2026-09-21 14:45:29`），
   * 官方入口（草稿列表点「编辑」）就是从 `GET /article/draft?type=0` 的列表项里取这个字段。
   * 这里保存后回查一次同一接口并按 id 匹配。
   *
   * 属于「锦上添花」步骤：任何异常都只记日志、返回 null，不影响草稿已保存的事实。
   */
  private async fetchDraftCreateTime(draftId: string): Promise<string | null> {
    try {
      const resp = await this.runtime.fetch(`${DRAFT_LIST_URL}?type=0`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          Accept: 'application/json, text/plain, */*',
          Referer: HOME_PAGE,
        },
      })
      const text = await resp.text()

      let parsed: KcEnvelope<KcDraftListData>
      try {
        parsed = JSON.parse(text) as KcEnvelope<KcDraftListData>
      } catch {
        logger.debug('[Kuaichuan] 草稿列表响应非 JSON：', text.substring(0, 200))
        return null
      }
      if (parsed.errno !== ERR_OK || !parsed.data?.draft_list) {
        logger.debug('[Kuaichuan] 草稿列表返回异常：', parsed.errno, parsed.errmsg)
        return null
      }

      const hit = parsed.data.draft_list.find((item) => String(item.id) === draftId)
      return hit?.create_time || null
    } catch (error) {
      logger.debug('[Kuaichuan] 回查 create_time 失败：', error)
      return null
    }
  }

  /**
   * 解析页面注入的 `window.user = { ... }`。
   * 解析不到对象时返回 null（调用方会走接口兜底）；对象存在但 qid 为空 → 未登录。
   */
  private parseWindowUser(html: string): KcWindowUser | null {
    const blockMatch = html.match(/window\.user\s*=\s*\{([^}]*)\}/)
    if (!blockMatch) return null

    const block = blockMatch[1]
    const pick = (key: string): string => {
      const m = block.match(new RegExp(key + '\\s*:\\s*"([^"]*)"'))
      return m ? m[1] : ''
    }
    return {
      qid: pick('qid'),
      name: pick('name'),
      img: pick('img'),
    }
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

  /** 统一解析 `{errno, errmsg, data}` 包装，errno !== 0 时抛错 */
  private async parseEnvelope<T>(resp: Response, action: string): Promise<T | undefined> {
    const text = await resp.text()
    let data: KcEnvelope<T>
    try {
      data = JSON.parse(text) as KcEnvelope<T>
    } catch {
      throw new Error(`${action}：响应非 JSON (HTTP ${resp.status}): ${text.substring(0, 200)}`)
    }
    if (data.errno !== ERR_OK) {
      throw new Error(this.describeError(data, action))
    }
    return data.data
  }

  /** 业务错误 → 可读提示（errno 12 单独给出登录引导） */
  private describeError(data: KcEnvelope<unknown>, action: string): string {
    if (data.errno === ERR_NOT_LOGIN) {
      return `${action}：请先登录快传号（https://kuaichuan.360kuai.com/）`
    }
    return `${action}：${data.errmsg || `errno=${data.errno}`}`
  }

  /** 由 mime 推断文件扩展名（服务端按上传文件名后缀产出 CDN 对象名） */
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
