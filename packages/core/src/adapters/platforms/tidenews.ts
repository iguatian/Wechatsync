/**
 * 潮新闻 · 潮鸣号 适配器
 *
 * 平台资料：
 * - 潮新闻主站（App / H5）：https://tidenews.com.cn/
 * - 创作者后台（潮鸣号）：https://cmh.8531.cn/creatorPlatform/
 * - 长文章编辑器：https://cmh.8531.cn/creatorPlatform/#/create/image-text
 * - 草稿箱：https://cmh.8531.cn/creatorPlatform/#/composition/drafts
 *
 * ⚠️ 后台是 Vue SPA + **Hash 路由**（`createWebHashHistory('/creatorPlatform')`，见
 *    main-*.js `V3({history:A3("/creatorPlatform"),routes:[...]})`），所以站点自身 URL
 *    都带 `#`：服务端对 `/creatorPlatform/xxx` 这类深链一律 301 回根路径，只有
 *    `#/xxx` 形式的地址才是后台真实可用的页面地址。
 *    页面 `<meta name="referrer" content="no-referrer">`，浏览器**不发 Referer**。
 *
 * 鉴权（HAR + 前端产物双向验证）：
 *   后台 axios 请求拦截器给所有**非上传**请求统一加 4 个头：
 *     Authorization: Bearer <localStorage["creator-authenticate"].data>
 *     X-tmy-username: <localStorage["creator-tmy3-username"].data>
 *     X-tmy-media-source: 1001
 *     X-Source: creator
 *   （上传类请求只加 `Accept` + `X-Source`，见下方图片上传说明。）
 *
 *   凭证存在 localStorage（统一由后台的 storage 工具写入，key 前缀 `creator-`，
 *   值为 `{"data": <值>, "expire"?: <毫秒时间戳>}` JSON）：
 *     creator-authenticate   → 登录 token（`Bearer ` 后面的部分）
 *     creator-tmy3-username  → 账号 ID（形如 220708647040）
 *     creator-userInfo       → 登录接口返回的用户对象（JSON 字符串，含 nick_name / image_url）
 *   后台自己的路由守卫就是用 `authenticate && tmy3-username` 两个 key 判断登录态的，
 *   所以本适配器也以「两个 key 都能读到」作为「已登录」的第一判据，再调接口复验。
 *   ⚠️ 该站鉴权**不依赖 Cookie**（HAR 全程无 Cookie），因此没有 cookie 兜底路径，
 *      必须从 cmh.8531.cn 页面的 localStorage 里取——这也是本适配器复用/新建后台
 *      tab 的原因（与 sspai 适配器同一套做法）。
 *
 *   网关（authcenter + 阿里云 WAF）对未带 / 无效 token 的请求统一返回 **HTTP 401**：
 *     缺 Authorization  → { code: "NO_VALIDATION_TOKEN", message: "token无效" }
 *     无效 Authorization → { code: "VALIDATION_FAILED",    message: "认证失败" }
 *   （HAR 导出时 Authorization 头被裁掉了，但同一拦截器注入的 X-tmy-* 还在；实测不带
 *     该头必然 401，故这里照前端原样发送。）
 *
 * 图片上传（HAR 验证，与后台编辑器 `useFileUpload` 完全一致的三步）：
 *   1. POST /api/sharingalliance/creator/img/uploadToken   （form-urlencoded）
 *        fileName=<encodeURIComponent(名主体)>.<ext>&file_name=<同上>&libType=3002&bigFile=0
 *      → { code:0, data:{ uploadToken:{ id, key, token, callback,
 *                                      policy, accessid, uploadUrl, coverUrl, ... } } }
 *      - id      ：图片 ID，正文 img 的 `creator-media-id`、封面的 `coverId` 都用它
 *      - 命名规则：`<encodeURIComponent(名字主体)>.<原后缀>`（服务端按后缀产出 OSS 对象名）
 *      - libType 固定 3002（图片库），响应里回传的 libType 固定为 300
 *   2. POST <uploadUrl>   （阿里云 OSS，multipart/form-data）
 *        key / signature(=token) / callback / OSSAccessKeyId(=accessid) / policy / name / file
 *      → { code: 0 }（OSS 侧按 callback 回调 gxlmmz.8531.cn 落库，故第 3 步必须调用）
 *   3. POST /api/sharingalliance/creator/img/complete?id=<id>   （body 固定 `{}`）
 *      → { code:0, data:{ imgId, imgUrl, downloadUrl, mimg:{...} } }
 *   正文与封面都使用 **`data.imgUrl`**（带 `&width=&height=&size=` 的签名地址）。
 *   签名地址 1 小时后过期，但后台读取时会由服务端重新签名（素材列表接口返回的正文只剩
 *   `creator-media-id`），所以照编辑器原样提交即可，不要自作主张去掉 query。
 *
 * 保存草稿（HAR 验证）：
 *   POST /api/sharingalliance/creator/createOrUpdate   （application/json）
 *   body（字段与 HAR 样本一致；新建草稿不带 sharingallianceId）：
 *     title / fileName(=title) / groupIds / content / fileDesc(=content)
 *     cover / coverId / circleId / boardId
 *     draftsStatus=1（1 = 存草稿，0 = 提交发布）/ fileType=-4（长文章）
 *     watermark=1 / aiGenerate=false / markTime / markCity / originalDeclare=false
 *     subMedias=[] / mediaArticleId / mediaItemArticleId / chatGroupId
 *   → { code:"OK", data:{ sharingallianceId: 5204562 } }，该 id 即草稿 ID
 *     （草稿箱列表 `material/manage/list` 里同一篇文章的 `id` 就是它）。
 *
 * 正文 HTML 结构（与编辑器 `getFormattingContent` 产物**逐字节一致**）：
 *   <div class="creator-platform-content">
 *     <p>段落</p>
 *     <p><img src="<imgUrl>" creator-media-id="<id>"></p>
 *   </div>
 *
 * ⚠️ 正文插图的两条硬性要求（踩过坑，改动前务必读完）：
 *
 *   1）**标签形态必须与后台编辑器完全一致**，不能沿用基类 `processImages` 产出的
 *      `<img src="..." creator-media-id="..." />`：
 *        a. 属性值里的 `&` 必须是 HTML 转义后的 `&amp;`（编辑器通过 DOM `innerHTML`
 *           序列化天然会转义；HAR 抓包正文里也是 `&amp;OSSAccessKeyId=`）；
 *        b. 结尾是 `>`，**不能**写成 XHTML 风格的 ` />`。
 *
 *   2）**每张落在潮鸣号私有桶的图片都必须带 `creator-media-id`**（见 `PRIVATE_MEDIA_HOST`）。
 *      服务端保存正文时会把 `src` 的 query 抹掉（只留 path），读取时再按
 *      `creator-media-id` 重新签名；标签里没有 id 时这一步无法完成，草稿里剩下的就是
 *      去掉 query 的裸地址 —— 而私有桶不带签名必然 `403 AccessDenied`（实测确认：
 *      裸地址 403、带签名的地址 200；公开桶 `meizi-chao-pub.8531.cn` 里此时还没有对象）。
 *
 *   背景：`img/complete` 给出的签名地址只有 1 小时有效期（`Expires` = uploadToken
 *   时刻 + 3600s），所以正文里的地址**过期与否并不重要，能不能被服务端重签才重要**。
 *   封面能长期正常显示，正是因为服务端读取时按 `coverId` 重新签名（响应里的
 *   `coverUrl` 每次读取都是新的 `Expires`）。
 *
 * 请求模式：
 * - 后台接口响应带 `Access-Control-Allow-Origin: *`，扩展 SW 依赖 host_permissions
 *   直连（manifest 已放开 https://任意域名/*）；这里再通过 headerRules 注入
 *   `Origin`，与 HAR 中 POST 请求对齐（Referer 不注入 —— 站点设了 no-referrer）。
 * - OSS 上传域是动态的（`meizi-gxlm-prod.oss-cn-hangzhou.aliyuncs.com` 由 uploadToken
 *   返回），其 CORS 为 `*` 且 `Access-Control-Allow-Headers` 已放行 `x-source`，
 *   扩展直连即可，无需额外 header 规则。
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'
import { parseMarkdownImages } from '../../lib/markdown-images'

const logger = createLogger('Tidenews')

/** 创作者后台 origin（潮鸣号所有接口都在这个域） */
const SITE_ORIGIN = 'https://cmh.8531.cn'

/** 创作者后台首页（未登录会被前端路由守卫重定向到 `#/login`） */
const CREATOR_PAGE = `${SITE_ORIGIN}/creatorPlatform/`

/** 草稿箱（保存成功后的落点） */
const DRAFT_LIST = `${SITE_ORIGIN}/creatorPlatform/#/composition/drafts`

/** 接口前缀（HAR 中所有业务接口均为 /api/...） */
const API_BASE = `${SITE_ORIGIN}/api`

/** 账号信息接口（checkAuth 复验 + 取昵称头像，后台页头也是用它） */
const ACCOUNT_DETAIL_URL = `${API_BASE}/authcenter/tide/proxy/api/account/account_detail`

/** 图片上传凭证接口 */
const IMG_UPLOAD_TOKEN_URL = `${API_BASE}/sharingalliance/creator/img/uploadToken`

/** 图片上传完成（落库）接口，id 走 query */
const IMG_COMPLETE_URL = `${API_BASE}/sharingalliance/creator/img/complete`

/** 新建 / 更新作品接口（draftsStatus=1 即存草稿） */
const CREATE_OR_UPDATE_URL = `${API_BASE}/sharingalliance/creator/createOrUpdate`

/** 图片库类型（编辑器 `useFileUpload` 的默认值） */
const IMG_LIB_TYPE = '3002'

/** 图文「长文章」类型（后台 consts：imageText = -4） */
const FILE_TYPE_IMAGE_TEXT = -4

/** 草稿状态（1 = 草稿，0 = 提交发布/审核） */
const DRAFT_STATUS = 1

/** 上传接口用的 multipart 文件字段名（编辑器 `uploadConfig.name = "file"`） */
const UPLOAD_FIELD_NAME = 'file'

/** 正文内容外壳 class（后台读取正文时按该 class 做首尾裁剪） */
const CONTENT_WRAPPER_CLASS = 'creator-platform-content'

/** localStorage 键名（后台 storage 工具统一加 `creator-` 前缀） */
const AUTH_TOKEN_KEY = 'creator-authenticate'
const USERNAME_KEY = 'creator-tmy3-username'
const USER_INFO_KEY = 'creator-userInfo'

/**
 * 潮鸣号素材私有桶。
 *
 * ⚠️ 这个域下的图片**不能跳过、也不能只留地址**：对象是私有的（不带签名必 403），
 * 而服务端保存正文时会把 query 抹掉，只在读取时按 `creator-media-id` 重新签名。
 * 所以对这类地址要「复用它的素材 id」——素材 key 就是 `<id>.<ext>`（`mimg.qiniuKey`
 * 同款），从路径里就能直接取到 id，无需重复上传。
 *
 * 典型来源：CLI 同步本地 Markdown 时会把本地图片预上传到「图床」（默认取第一个同步
 * 平台，见 `packages/cli/src/index.ts` 的 `resolveImageHost`），预上传走的就是本适配器
 * 的 `uploadImage()`，回填给正文的正是这里的签名地址。
 */
const PRIVATE_MEDIA_HOST = 'mc-gxlmmz-private.8531.cn'

/**
 * 跳过转存的图床（地址长期有效的公开 CDN / 站点自身）。
 * 注意**不能**把整个 `8531.cn` 放进来——私有桶要走 `PRIVATE_MEDIA_HOST` 分支。
 */
const SKIP_IMAGE_PATTERNS = ['meizi-chao-pub.8531.cn', 'tidenews.com.cn']

/** OSS 上传后正文/封面统一使用的签名地址字段 */
interface CmhUploadToken {
  id?: number
  key?: string
  token?: string
  callback?: string
  policy?: string
  accessid?: string
  uploadUrl?: string
}

/** 后台统一响应包装：业务码可能是数字 0，也可能是字符串 "OK" */
interface CmhEnvelope<T> {
  code?: number | string
  msg?: string
  message?: string
  data?: T
}

/** 网关鉴权失败时返回的业务码（均伴随 HTTP 401） */
const AUTH_ERROR_CODES = ['NO_VALIDATION_TOKEN', 'VALIDATION_FAILED', '50101']

/** 读取 localStorage 得到的原始凭证 */
interface CmhRawCredentials {
  token: string | null
  username: string | null
  userInfo: string | null
}

/** 解析后的登录凭证 */
interface CmhCredentials {
  /** Authorization 的 token 主体 */
  token: string
  /** 账号 ID（X-tmy-username） */
  username: string
  /** 昵称（来自本地缓存的 userInfo，接口复验后会覆盖） */
  nickname?: string
  /** 头像（来自本地缓存的 userInfo，接口复验后会覆盖） */
  avatar?: string
}

/** 单张图片上传结果 */
interface CmhImageUploadResult {
  /** 落库后的签名访问地址（imgUrl） */
  url: string
  /** 图片 ID（creator-media-id / coverId） */
  id: number
}

/** 账号详情里的账号对象（后台页头读取的字段） */
interface CmhAccount {
  nick_name?: string
  image_url?: string
  [key: string]: unknown
}

export class TidenewsAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'tidenews',
    name: '潮新闻',
    icon: `${SITE_ORIGIN}/creatorPlatform/favourite.ico`,
    homepage: CREATOR_PAGE,
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  /** 预处理配置：潮鸣号编辑器正文为 HTML */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  /**
   * Header 规则：后台页面设了 `no-referrer`，浏览器只发 Origin 不发 Referer，
   * 这里只对齐 Origin。（后台接口自带 `Access-Control-Allow-Origin: *`，
   * 扩展 SW 靠 host_permissions 直连本身可用，注入 Origin 仅为与 HAR 一致。）
   */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://cmh.8531.cn/*',
      headers: {
        Origin: SITE_ORIGIN,
      },
    },
  ]

  /** 当前 publish 会话内的凭证，正文图片逐张上传时复用，避免反复读页面 */
  private activeCredentials: CmhCredentials | null = null

  // ============ checkAuth ============

  /**
   * 鉴权：从后台页面 localStorage 取 token / 账号 ID，再调 account_detail 复验。
   *
   * - 读不到 `creator-authenticate` / `creator-tmy3-username` → 未登录
   * - HTTP 401（NO_VALIDATION_TOKEN / VALIDATION_FAILED）→ 未登录或登录态已失效
   *
   * 不主动新建 tab（批量检查登录态时逐个开 tab 太重），只在已有 cmh.8531.cn tab 时读取；
   * publish 场景会按需新建（见 `resolveCredentials`）。
   */
  async checkAuth(): Promise<AuthResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      try {
        const stored = await this.readCredentialsFromExistingTab()
        if (!stored) {
          return {
            isAuthenticated: false,
            error: `请先登录潮新闻·潮鸣号（${CREATOR_PAGE}）`,
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

  /** 调 account_detail 复验凭证（401 / 鉴权业务码一律视为未登录） */
  private async verifyCredentials(creds: CmhCredentials): Promise<AuthResult> {
    const resp = await this.runtime.fetch(ACCOUNT_DETAIL_URL, {
      headers: this.apiHeaders(creds),
    })
    const text = await resp.text()

    let data: CmhEnvelope<{ account?: CmhAccount }>
    try {
      data = JSON.parse(text) as CmhEnvelope<{ account?: CmhAccount }>
    } catch {
      return {
        isAuthenticated: false,
        error: `account_detail 响应解析失败（HTTP ${resp.status}）`,
      }
    }

    if (resp.status === 401 || this.isAuthError(data.code)) {
      return {
        isAuthenticated: false,
        error: '登录态已失效，请重新登录潮新闻·潮鸣号',
      }
    }

    if (!this.isSuccessCode(data.code)) {
      return {
        isAuthenticated: false,
        error: data.message || data.msg || `鉴权失败：code=${data.code}`,
      }
    }

    const account = data.data?.account
    return {
      isAuthenticated: true,
      userId: creds.username,
      username: account?.nick_name || creds.nickname || creds.username,
      avatar: account?.image_url || creds.avatar,
    }
  }

  // ============ publish ============

  /**
   * 发布文章（保存草稿）。
   *
   * 流程（HAR 验证）：
   *   1. 读取登录凭证（复用已有后台 tab，必要时新建）
   *   2. processImages 上传正文图片（替换 src 并写入 creator-media-id）
   *   3. 上传封面（如有）
   *   4. 正文套上 `<div class="creator-platform-content">` 外壳
   *   5. POST createOrUpdate（draftsStatus=1）→ 拿 sharingallianceId
   *
   * 说明：
   * - 潮鸣号这里只实现「存草稿」（与快传号/少数派/界面新闻一致）：draftsStatus 固定 1。
   * - 后台编辑器会校验正文链接是否在 `linkWhiteList` 内，本适配器绕过了前端校验，
   *   由服务端裁决；若服务端因此拒绝，错误信息会原样透传。
   */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish to Tidenews...')

      // 1. 登录凭证（publish 场景允许新建后台 tab 读 localStorage）
      const creds = await this.resolveCredentials(true)
      if (!creds) {
        throw new Error(`请先登录潮新闻·潮鸣号（${CREATOR_PAGE}）`)
      }
      this.activeCredentials = creds

      try {
        // 2. 正文图片（自带实现，产出与后台编辑器一致的 <img> 标签，见文件头说明）
        let content = article.html || ''
        try {
          content = await this.processBodyImages(content, creds, options?.onImageProgress)
        } catch (e) {
          logger.warn('[Tidenews] 正文图片处理中途失败，继续发布：', (e as Error).message)
        }

        // 3. 封面
        let cover = ''
        let coverId = 0
        let coverError: string | undefined
        if (article.cover) {
          try {
            const uploaded = await this.uploadImageToCmh(article.cover, creds)
            cover = uploaded.url
            coverId = uploaded.id
            logger.info(`[Tidenews] 封面上传成功：${cover}`)
          } catch (e) {
            coverError = (e as Error).message
            logger.warn('[Tidenews] 封面上传失败：', coverError)
          }
        } else {
          logger.warn('[Tidenews] 未提供封面（article.cover），cover / coverId 为空')
        }

        // 4. 保存草稿
        const draftId = await this.saveDraft({
          title: article.title,
          content: this.wrapContent(content),
          cover,
          coverId,
          credentials: creds,
        })

        logger.info(`[Tidenews] 草稿已保存：${draftId}`)
        return this.createResult(true, {
          postId: draftId,
          postUrl: buildDraftUrl(draftId),
          draftOnly: options?.draftOnly ?? true,
          coverUploaded: !!cover,
          coverUrl: cover || undefined,
          ...(coverError ? { coverError } : {}),
          message: `已保存到潮新闻·潮鸣号草稿箱（${DRAFT_LIST}）`,
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
   * 单张图片上传（基类 `uploadImage(blob)` 的实现依赖它）。
   *
   * 注意：正文图片走的是 `processBodyImages`（要控制 `<img>` 标签形态），不是这里；
   * 本方法仅供外部按 Blob 上传时使用（`attrs` 里的 `creator-media-id` 由基类
   * `processImages` 消费，本适配器不使用）。
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    try {
      // 这里**允许按需打开后台 tab**：CLI/MCP 会在 publish 之前先把本地图片预上传到
      // 「图床」（`resolveImageHost` 默认取第一个同步平台），走到本方法时浏览器里往往
      // 还没有 cmh.8531.cn 标签页 —— 该站登录态只存在页面 localStorage、没有 Cookie
      // 兜底，不让开 tab 就只能失败（失败后 CLI 退回内嵌 data URI/本地相对路径）。
      // 不会造成 tab 泛滥：首次成功后 tab 会一直存在，后续调用走「读已有 tab」分支。
      const creds = this.activeCredentials || (await this.resolveCredentials(true))
      if (!creds) {
        throw new Error(
          `未登录潮新闻·潮鸣号，无法上传图片（请先在浏览器打开并登录 ${CREATOR_PAGE}）`,
        )
      }
      const uploaded = await this.uploadImageToCmh(src, creds)
      return { url: uploaded.url, attrs: { 'creator-media-id': uploaded.id } }
    } catch (error) {
      // 注意：CLI 预上传（图床）传进来的往往是 data URI，日志里只留前缀，别打整段 base64
      logger.warn(`[Tidenews] 图片上传失败：${displayUrl(src)}`, error)
      return { url: src }
    }
  }

  /**
   * 正文图片处理：把正文里的图片转存到潮鸣号素材库，并替换成与后台编辑器
   * `getFormattingContent()` 产物一致的 `<img>` 标签。
   *
   * 与基类 `processImages` 的差异（**不能改用基类实现**，见文件头说明）：
   *   - 属性值中的 `&` 转义为 `&amp;`（对齐 DOM 序列化 / HAR）
   *   - 标签以 `>` 收尾，不写成 ` />`
   *   - 只保留 `src` 与 `creator-media-id` 两个属性（编辑器 blot 的 value 只有
   *     `{ id, path }`，其它属性本来就会被丢掉）
   *
   * 三类处理：
   *   1. 已是潮鸣号私有桶（`PRIVATE_MEDIA_HOST`）的地址 → **只补 `creator-media-id`**，
   *      不重复转存（id 直接从路径取；CLI 预上传后回填正文的就是这种地址）
   *   2. 公开图床 / 站点自有域名 → 原样跳过（地址长期有效，无需 id）
   *   3. 其它外链 → 走 uploadToken → OSS → complete 转存到素材库
   *
   * 单张图片失败只记日志并保留原 src，不阻断整体同步。
   * 关键点：**任何写入正文的潮鸣号图片都必须带 `creator-media-id`**，否则服务端
   * 抹掉 query 后无法重签，草稿里就是 403 的裸地址。
   *
   * @param content 正文 HTML（preprocessConfig 已保证 outputFormat=html）
   * @param creds 登录凭证
   * @param onProgress 图片进度回调
   */
  private async processBodyImages(
    content: string,
    creds: CmhCredentials,
    onProgress?: (current: number, total: number) => void,
  ): Promise<string> {
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

    if (matches.length === 0) return content

    let result = content
    const uploadedMap = new Map<string, CmhImageUploadResult>()
    let processed = 0

    for (const { full, src } of matches) {
      if (!src) continue

      // 1. 已在潮鸣号素材库（私有桶）：只补 creator-media-id，不重复转存
      const existingId = parsePrivateMediaId(src)
      if (existingId !== null) {
        logger.debug(`[Tidenews] 复用素材库图片 id=${existingId}: ${src}`)
        const tag = buildImageTag(src, existingId)
        result = result.replace(full, () => tag)
        continue
      }

      // 2. 公开图床 / 站点自有域名（地址长期有效）不转存（data URI 除外）
      if (!src.startsWith('data:') && SKIP_IMAGE_PATTERNS.some((p) => src.includes(p))) {
        logger.debug(`[Tidenews] 跳过平台公开图床图片: ${src}`)
        continue
      }

      processed++
      onProgress?.(processed, matches.length)

      try {
        let uploaded = uploadedMap.get(src)
        if (!uploaded) {
          uploaded = await this.uploadImageToCmh(src, creds)
          uploadedMap.set(src, uploaded)
        }
        const tag = buildImageTag(uploaded.url, uploaded.id)
        // 用函数替换，避免 URL 里的 `$` 被当成 replace 的替换模式
        result = result.replace(full, () => tag)
      } catch (error) {
        logger.warn(`[Tidenews] 正文图片上传失败，保留原 URL：${displayUrl(src)}`, error)
      }

      await this.delay(300)
    }

    return result
  }

  /**
   * 上传单张图片（正文 / 封面共用），三步走：
   *   uploadToken → OSS POST → img/complete
   *
   * @param src 图片 URL 或 data URI
   * @param creds 登录凭证（uploadToken / complete 需要鉴权头）
   */
  private async uploadImageToCmh(src: string, creds: CmhCredentials): Promise<CmhImageUploadResult> {
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

    // 2. 上传凭证（文件名规则与编辑器一致：encodeURIComponent(名主体).后缀）
    const filename = `image-${this.uniqueName()}.${this.extensionFor(blob.type)}`
    const tokenData = await this.requestUploadToken(filename, creds)

    const { id, key, token, callback, policy, accessid, uploadUrl } = tokenData
    if (id === undefined || !key || !token || !policy || !accessid || !uploadUrl) {
      throw new Error('图片上传失败：uploadToken 响应缺少必要字段')
    }

    // 3. OSS 直传（multipart，字段顺序与 HAR 一致）
    const formData = new FormData()
    formData.append('key', key)
    formData.append('signature', token)
    formData.append('callback', callback || '')
    formData.append('OSSAccessKeyId', accessid)
    formData.append('policy', policy)
    formData.append('name', filename)
    formData.append(UPLOAD_FIELD_NAME, blob, filename)

    const ossResp = await this.runtime.fetch(uploadUrl, {
      method: 'POST',
      credentials: 'omit',
      headers: {
        Accept: '*/*',
        'X-Source': 'creator',
      },
      body: formData,
    })
    const ossText = await ossResp.text()
    if (!ossResp.ok) {
      throw new Error(`图片上传失败：OSS HTTP ${ossResp.status}${this.ossErrorMessage(ossText)}`)
    }

    // 4. complete 落库（id 走 query，body 固定 `{}`）
    const completed = await this.completeUpload(id, creds)
    if (!completed.url) {
      throw new Error('图片上传失败：complete 响应缺少 imgUrl')
    }

    return { url: completed.url, id: completed.id ?? id }
  }

  /** 申请图片上传凭证：POST /img/uploadToken（form-urlencoded） */
  private async requestUploadToken(filename: string, creds: CmhCredentials): Promise<CmhUploadToken> {
    const body = new URLSearchParams()
    // 编辑器会把「文件名主体」做一次 encodeURIComponent 再拼后缀，这里文件名是自造的
    // ASCII 串，encodeURIComponent 为等值操作，仍照原样写以对齐行为。
    body.append('fileName', filename)
    body.append('file_name', filename)
    body.append('libType', IMG_LIB_TYPE)
    body.append('bigFile', '0')

    const data = await this.requestJson<CmhEnvelope<{ uploadToken?: CmhUploadToken }>>(
      IMG_UPLOAD_TOKEN_URL,
      {
        method: 'POST',
        headers: {
          ...this.apiHeaders(creds),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      },
      '获取图片上传凭证失败',
    )

    const uploadToken = data.data?.uploadToken
    if (!uploadToken) {
      throw new Error('获取图片上传凭证失败：响应缺少 uploadToken')
    }
    return uploadToken
  }

  /**
   * 图片上传完成落库：POST /img/complete?id=<id>，body 固定 `{}`。
   *
   * 返回的 `imgUrl` / `mimg.url` 都是私有桶 `mc-gxlmmz-private.8531.cn` 的**签名地址**
   * （`?Expires=&OSSAccessKeyId=&Signature=`）。极端情况下（落库尚未完成）可能只拿到
   * 不带签名的裸地址，写进正文必然 403，因此这里优先挑带签名的那个，都没有就报错。
   */
  private async completeUpload(
    id: number,
    creds: CmhCredentials,
  ): Promise<{ url: string; id?: number }> {
    const data = await this.requestJson<
      CmhEnvelope<{ imgUrl?: string; imgId?: number; mimg?: { url?: string } }>
    >(
      `${IMG_COMPLETE_URL}?id=${id}`,
      {
        method: 'POST',
        headers: {
          ...this.apiHeaders(creds),
          'Content-Type': 'application/json;charset=UTF-8',
        },
        body: '{}',
      },
      '图片落库失败',
    )

    const candidates = [data.data?.imgUrl, data.data?.mimg?.url].filter(
      (url): url is string => !!url,
    )
    const signed = candidates.find((url) => url.includes('Signature='))
    if (!signed) {
      throw new Error(
        `图片落库失败：未取得图片签名地址（imgId=${data.data?.imgId ?? id}` +
          `${candidates.length ? `，返回=${candidates[0].substring(0, 120)}` : ''}）`,
      )
    }

    return {
      url: signed,
      id: data.data?.imgId,
    }
  }

  // ============ 草稿保存 ============

  /**
   * 保存草稿：POST /sharingalliance/creator/createOrUpdate（application/json）。
   * 字段与 HAR 样本对齐（新建草稿不带 sharingallianceId）。
   */
  private async saveDraft(params: {
    title: string
    /** 已套 `<div class="creator-platform-content">` 外壳的正文 HTML */
    content: string
    /** 封面签名地址（无封面为空串） */
    cover: string
    /** 封面图片 ID（无封面为 0） */
    coverId: number
    credentials: CmhCredentials
  }): Promise<string> {
    const payload = {
      title: params.title,
      fileName: params.title,
      groupIds: '',
      content: params.content,
      // fileDesc 与 content 同源，后台列表/检索用的是这个字段
      fileDesc: params.content,
      cover: params.cover,
      coverId: params.coverId,
      circleId: '',
      boardId: '',
      draftsStatus: DRAFT_STATUS,
      fileType: FILE_TYPE_IMAGE_TEXT,
      watermark: 1,
      aiGenerate: false,
      markTime: '',
      markCity: '',
      originalDeclare: false,
      subMedias: [] as unknown[],
      mediaArticleId: '',
      mediaItemArticleId: '',
      chatGroupId: '',
    }

    const data = await this.requestJson<CmhEnvelope<{ sharingallianceId?: number }>>(
      CREATE_OR_UPDATE_URL,
      {
        method: 'POST',
        headers: {
          ...this.apiHeaders(params.credentials),
          'Content-Type': 'application/json;charset=UTF-8',
        },
        body: JSON.stringify(payload),
      },
      '保存草稿失败',
    )

    const draftId = data.data?.sharingallianceId
    if (draftId === undefined || draftId === null) {
      throw new Error('保存草稿失败：响应未含 sharingallianceId')
    }
    return String(draftId)
  }

  // ============ 凭证获取 ============

  /**
   * 解析登录凭证。
   *
   * 顺序（越靠前越不做多余动作）：
   *   1. 已有 cmh.8531.cn tab → 读页面 localStorage
   *   2. allowCreateTab 时才后台新建后台首页 tab 再读一次
   *
   * 该站鉴权不依赖 Cookie（HAR 全程无 Cookie），所以没有 cookie 兜底路径。
   *
   * @param allowCreateTab 是否允许新建后台 tab。
   *   - publish / `uploadImage`（CLI 预上传图床）传 true：这两条路本来就是用户主动
   *     发起的同步，开一次后台 tab 读登录态是合理成本；首次成功后 tab 会保留，
   *     后续调用走「读已有 tab」分支，不会反复开。
   *   - checkAuth 传 false：批量检查登录态时（弹窗一次查十几个平台）逐个开 tab 太重。
   */
  private async resolveCredentials(allowCreateTab: boolean): Promise<CmhCredentials | null> {
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
  private async readCredentialsFromExistingTab(): Promise<CmhCredentials | null> {
    const runtimeTabs = this.runtime.tabs
    if (!runtimeTabs) return null
    try {
      const tabs = await runtimeTabs.query('*://cmh.8531.cn/*')
      const first = tabs[0]
      if (!first || first.id === undefined) return null
      return await this.readCredentialsFromTab(first.id)
    } catch (error) {
      logger.debug('[Tidenews] 查询 cmh.8531.cn tab 失败：', error)
      return null
    }
  }

  /** 后台打开创作者平台（用于读取页面 localStorage 中的登录态） */
  private async createCreatorTab(): Promise<number | null> {
    const runtimeTabs = this.runtime.tabs
    if (!runtimeTabs) return null
    try {
      logger.info(`[Tidenews] 后台打开 ${CREATOR_PAGE} 以读取登录态...`)
      const tab = await runtimeTabs.create(CREATOR_PAGE, false)
      if (tab.id === undefined) return null
      await runtimeTabs.waitForLoad(tab.id, 30000)
      return tab.id
    } catch (error) {
      logger.debug('[Tidenews] 创建后台 tab 失败：', error)
      return null
    }
  }

  /** 在指定 tab 的页面上下文读取 localStorage 里的登录态 */
  private async readCredentialsFromTab(tabId: number): Promise<CmhCredentials | null> {
    const runtimeTabs = this.runtime.tabs
    if (!runtimeTabs) return null
    try {
      // executeScript 在 MAIN world 执行，函数不得引用模块级变量
      const raw = await runtimeTabs.executeScript<
        CmhRawCredentials,
        [string, string, string]
      >(tabId, readCredentialsInPageScript, [AUTH_TOKEN_KEY, USERNAME_KEY, USER_INFO_KEY])
      return this.buildCredentials(raw)
    } catch (error) {
      logger.debug('[Tidenews] 读取页面登录态失败：', error)
      return null
    }
  }

  /**
   * 把 localStorage 原始值组装成凭证。
   * 后台登录态判据与前端路由守卫一致：token 与账号 ID 同时存在才算已登录。
   */
  private buildCredentials(raw: CmhRawCredentials | null): CmhCredentials | null {
    if (!raw?.token || !raw.username) return null

    const profile = this.parseUserInfo(raw.userInfo)
    return {
      token: raw.token,
      username: raw.username,
      nickname: profile.nickname,
      avatar: profile.avatar,
    }
  }

  /**
   * 解析 localStorage 里缓存的 userInfo（`creator-userInfo`）。
   * 结构是「登录接口返回的用户对象」的 JSON 字符串，取昵称与头像用于展示。
   */
  private parseUserInfo(raw: string | null): { nickname?: string; avatar?: string } {
    if (!raw) return {}
    try {
      const user = JSON.parse(raw) as Record<string, unknown>
      const pick = (...keys: string[]): string | undefined => {
        for (const key of keys) {
          const value = user[key]
          if (typeof value === 'string' && value) return value
        }
        return undefined
      }
      return {
        nickname: pick('nick_name', 'nickName', 'nickname', 'username'),
        avatar: pick('image_url', 'imageUrl', 'avatar'),
      }
    } catch {
      return {}
    }
  }

  // ============ 工具方法 ============

  /** 后台接口统一请求头（对齐 axios 请求拦截器） */
  private apiHeaders(creds: CmhCredentials): Record<string, string> {
    return {
      Accept: 'application/json, text/plain, */*',
      Authorization: `Bearer ${creds.token}`,
      'X-tmy-username': creds.username,
      'X-tmy-media-source': '1001',
      'X-Source': 'creator',
    }
  }

  /**
   * 发起后台接口请求并解析统一响应包装。
   * - 非 JSON 响应（含网关 401 空响应）直接抛错
   * - HTTP 401 / 鉴权业务码 → 抛出「登录态已失效」提示
   * - 其它业务失败（code 既不是 0 也不是 "OK"）→ 抛出「action：message」
   */
  private async requestJson<T extends CmhEnvelope<unknown>>(
    url: string,
    init: RequestInit,
    action: string,
  ): Promise<T> {
    const resp = await this.runtime.fetch(url, { credentials: 'include', ...init })
    const text = await resp.text()

    let data: T
    try {
      data = JSON.parse(text) as T
    } catch {
      throw new Error(`${action}：响应非 JSON (HTTP ${resp.status}): ${text.substring(0, 200)}`)
    }

    if (resp.status === 401 || this.isAuthError(data.code)) {
      throw new Error(`${action}：登录态已失效，请重新登录潮新闻·潮鸣号（${CREATOR_PAGE}）`)
    }
    if (!this.isSuccessCode(data.code)) {
      throw new Error(`${action}：${data.message || data.msg || `code=${data.code}`}`)
    }
    return data
  }

  /** 成功码：数字 0 或字符串 "OK" */
  private isSuccessCode(code: number | string | undefined): boolean {
    return code === 0 || code === '0' || code === 'OK'
  }

  /** 鉴权失败码（网关 401 场景） */
  private isAuthError(code: number | string | undefined): boolean {
    return code !== undefined && AUTH_ERROR_CODES.includes(String(code))
  }

  /** 给正文套上后台编辑器的内容外壳 */
  private wrapContent(content: string): string {
    const inner = content && content !== '<p><br></p>' ? content : ''
    return `<div class="${CONTENT_WRAPPER_CLASS}">${inner}</div>`
  }

  /** 从 OSS 的 XML 错误响应里提取 <Message>，便于排查（如回调失败、签名过期） */
  private ossErrorMessage(text: string): string {
    const match = text.match(/<Message>([\s\S]*?)<\/Message>/i)
    return match ? `：${match[1]}` : text ? `：${text.substring(0, 200)}` : ''
  }

  /** 由 mime 推断文件扩展名（服务端按上传文件名后缀产出 OSS 对象名） */
  private extensionFor(mime: string): string {
    const normalized = (mime || '').toLowerCase()
    if (normalized.includes('png')) return 'png'
    if (normalized.includes('gif')) return 'gif'
    if (normalized.includes('webp')) return 'webp'
    if (normalized.includes('bmp')) return 'bmp'
    if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg'
    return 'png'
  }

  /** 生成 ASCII 文件名主体（避免中文文件名在 encodeURIComponent 后与服务端期望不一致） */
  private uniqueName(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
}

// ============ 模块级工具 ============

/**
 * 拼出正文插图的 `<img>` 标签。
 *
 * 形态与后台编辑器 `getFormattingContent()` 的产物保持一致：
 *   - 属性值做 HTML 转义（`&` → `&amp;`），对齐 DOM `innerHTML` 序列化与 HAR 抓包
 *   - 以 `>` 收尾（不写 XHTML 的 ` />`）
 *   - 只保留 `src` 与 `creator-media-id`
 *
 * @param url `img/complete` 返回的签名地址（`data.imgUrl`）
 * @param id 图片 ID（`creator-media-id`，服务端按它重签地址）
 */
function buildImageTag(url: string, id: number): string {
  const escaped = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  return `<img src="${escaped}" creator-media-id="${id}">`
}

/**
 * 日志展示用的 URL：data URI / 超长地址只留前缀，避免整段 base64 打进控制台。
 */
function displayUrl(url: string): string {
  return url.length > 120 ? `${url.slice(0, 80)}…（共 ${url.length} 字符）` : url
}

/**
 * 从潮鸣号私有桶地址里取出素材 id。
 *
 * 素材 key 规则就是 `<id>.<ext>`（`uploadToken` 响应里的 `coverUrl`、`mimg.qiniuKey`
 * 都是这个形态），所以 `https://mc-gxlmmz-private.8531.cn/17787000095300.jpg?Expires=…`
 * 直接能读回 id —— 这样 CLI 预上传过的图片不必再传一次，只需把 id 补回标签。
 *
 * 非该域名 / 解析不出 id 时返回 null（调用方按普通外链处理）。
 */
function parsePrivateMediaId(url: string): number | null {
  if (!url.includes(PRIVATE_MEDIA_HOST)) return null
  const match = url.match(/\/(\d+)\.([A-Za-z0-9]+)(?:\?|#|$)/)
  if (!match) return null
  const id = Number(match[1])
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/**
 * 拼出草稿编辑页 URL（后台是 hash 路由）。
 *
 * 官方入口（草稿箱点「编辑」）push 的 query 为：
 *   `{ id, fileType, draftId, editType: 'continue', initialPage: <来源页路由名> }`
 * 其中 id / draftId 都是 createOrUpdate 返回的 sharingallianceId。
 */
function buildDraftUrl(draftId: string): string {
  const query = new URLSearchParams({
    id: draftId,
    fileType: String(FILE_TYPE_IMAGE_TEXT),
    draftId,
    editType: 'continue',
    initialPage: 'drafts',
  })
  return `${SITE_ORIGIN}/creatorPlatform/#/create/image-text?${query.toString()}`
}

/**
 * 在后台页面 MAIN world 读取登录态。
 *
 * ⚠️ 纯函数约束（MV3 executeScript 闭包序列化陷阱）：本函数会被序列化后在页面
 * 上下文执行，禁止引用模块级函数/常量（生产构建会被混淆，页面报 "xx is not
 * defined" 导致 executeScript 返回 null）。键名通过参数传入。
 *
 * 后台的 storage 工具把值包成 `{"data": <值>, "expire"?: <毫秒>}`，这里统一剥壳；
 * expire 不在此判断（登录态是否有效由接口复验决定）。
 */
function readCredentialsInPageScript(
  tokenKey: string,
  usernameKey: string,
  userInfoKey: string,
): CmhRawCredentials {
  const read = (key: string): string | null => {
    try {
      const raw = window.localStorage.getItem(key)
      if (!raw) return null
      let value: unknown = raw
      try {
        const parsed = JSON.parse(raw) as unknown
        if (parsed && typeof parsed === 'object' && 'data' in (parsed as object)) {
          value = (parsed as { data?: unknown }).data
        } else {
          value = parsed
        }
      } catch {
        // 非 JSON 时按原字符串处理
      }
      return typeof value === 'string' ? value : value == null ? null : String(value)
    } catch {
      return null
    }
  }

  return {
    token: read(tokenKey),
    username: read(usernameKey),
    userInfo: read(userInfoKey),
  }
}
