/**
 * 读特新闻 · 深圳号（PUGC 投稿平台）适配器
 *
 * 平台资料：
 * - 平台主体：读特新闻客户端自媒体开放平台（深圳报业集团，"PUGC投稿平台"）
 * - 后台首页：https://batman-szby.szpgm.cn/login （短信 / 密码登录）
 * - 作品列表：https://batman-szby.szpgm.cn/service/mediacloud-reporter/compositionManage-weMedia
 *   （注意：不带任何 query 参数时可直接打开；带 query 而无 `akt` 会被前端路由守卫拦到 /error）
 * - 编辑器：  https://batman-szby.szpgm.cn/service/mediacloud-reporter/articleText?akt=<密文>
 *   `akt` = "04" + SM4-ECB(query串, key=(loginInfo.userCode + loginInfo.userID) 补齐到 32 位)，
 *   由前端跳转入口本地生成（SM4 密钥补位串见 AKT_KEY_PAD）。payload 就是明文 query 参数，
 *   已实测验证（round-trip 与站内生成的密文逐字节一致）：
 *     - 作品列表(自媒体)：identifyType=we_media
 *     - 新建图文编辑器：  actions=add&identifyType=we_media
 *   本适配器用同一算法构造 akt，发布结果的落点与站内链接同形态。
 *
 * 鉴权体系（对照 main SPA 产物 app.e8f5b6a8.js 的 vuex `batman` 模块逐一核实）：
 *
 *   1. localStorage `loginInfo`（登录后写入，JSON）：
 *        token / authToken（两者最终等价，authToken 优先）→ 请求头 `s-token`
 *        userID（数字，即 save 用的 memeberID）、userCode、userName 等
 *      丢失/过期时前端会跳 /login?siteId=<siteId>。
 *
 *   2. sessionStorage `PUGC.TOKEN_DATA`（JSON 字符串）：{ token, type, deltime, timeout }
 *      host SPA 每次启动时通过 FETCH_TOKEN 获取：
 *        GET /prebatman/batman/security/token
 *          ?type=SM2("app")&key=SM2("mediax-dev-app")&secret=SM2(SECRET)&publicKey=SM2(<本地新公钥>)
 *        （全部用服务器固定公钥加密，SM2 C1C2C3 模式，输出加 "04" 前缀）
 *        响应 data.data 是用上述 publicKey 加密的密文，用随请求的私钥解密得 {token,...}。
 *      页面没有可用 TOKEN_DATA 时，本适配器可以自己走一遍这条链路（见 fetchSecurityToken）。
 *
 *   3. 每个请求统一带三个头（axios 请求拦截器 + reporter 子应用手工指定）：
 *        s-token: <loginInfo.authToken || loginInfo.token>
 *        source:  batman
 *        Ticket:  SM2(JSON.stringify({ token: <TOKEN_DATA.token>, secret: <SECRET>,
 *                                       timestamp: Date.now() }), <服务器公钥>)
 *      另有浏览器 Cookie `SESSION=...`（网关会话），扩展 fetch 用 credentials: 'include' 自动携带。
 *
 *   固定常量（写死在前端产物里）：
 *        服务器 SM2 公钥 / secret / appKey 见下方常量。
 *
 * `dn` 参数（出现在几乎所有接口的 query / body / multipart 里）：
 *      生成规则 = crypto.randomUUID() 去掉 '-'（32 位）+ Date.now() 后 5 位 → 共 37 位随机串。
 *      纯前端生成、服务端不校验内容，本适配器按同样规则生成即可。
 *
 * 接口清单（前端 API 名是逐字符 +1 的凯撒混淆，如 "0qsfcbunbo0xfnfejb0tbwf" → "/prebatman/batman/wemedia/save"，
 * 以下均为解码后的真实路径，均已从 HAR 实测验证）：
 *   GET  /prebatman/batman/security/token                                   获取安全 token
 *   GET  /prebatman/member/spc/v1/backend/getSubmissionPlatformAccountByUserId   账号信息（checkAuth 用）
 *   POST /prebatman/batman/wemedia/init      建稿 → data.id = "<docLibID>,<docID>"
 *   POST /prebatman/batman/article/uploadImage   multipart(file, dn) → { url, path }
 *   GET  /prebatman/batman/article/getImageUrl?devicePath=<path>   path → 可访问 URL（预览用）
 *   POST /prebatman/batman/wemedia/save      保存草稿 → { docLibID, docID }
 *
 * 正文图片（HAR 验证）：
 *   上传后拿到 `path`（形如 `qBp-block;<密文>.png`，服务端私有存储的设备路径），
 *   正文里的 <img> 形如：
 *     <img src="<path>" mam="<path>" style="max-width:100%;height:auto;" id="<14位数字>"/>
 *   服务端保存时按 path 落库，读取时通过 getImageUrl 换回真实 URL，所以 src 必须写 path 而不是 url。
 *
 * 发布即存草稿（wemedia/save 后文章停在「作品管理」列表，与后台手动保存一致；
 * 真正提交给编辑的 publish 接口本适配器不调用，由用户在后台确认后自行提交）。
 */
/// <reference path="./sm-crypto.d.ts" />
import sm2lib from 'sm-crypto'
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'
import { parseMarkdownImages } from '../../lib/markdown-images'

const logger = createLogger('Dute')

/** 后台 origin（所有接口与页面同域） */
const SITE_ORIGIN = 'https://batman-szby.szpgm.cn'

/** 作品列表（发布成功后的落点；不带 query 可直接打开） */
const WORK_LIST_PAGE = `${SITE_ORIGIN}/service/mediacloud-reporter/compositionManage-weMedia`

/** 后台登录页 */
const LOGIN_PAGE = `${SITE_ORIGIN}/login`

/** 用于读取登录态的后台页面（不带 query，不会被 akt 守卫拦截） */
const AUTH_PAGE = WORK_LIST_PAGE

/** 服务器 SM2 公钥（前端常量 dt，SM2 加密统一走它） */
const SERVER_PUB_KEY =
  '04195D1F93F950DDCC8C8384DD47DEBBD19B2897753686DE6B2EC87B583578325DF9191865258EB22A08AEFE4AA5E0EAD59D0EFB0187B0649EEF9008222BD3DA22'

/** 前端常量 At：Ticket 里的 secret */
const APP_SECRET = '367bde41-4eae-4c59-b151-47fc1ce83153'

/** 前端常量 jt：security/token 接口的 key 参数明文 */
const APP_KEY = 'mediax-dev-app'

/** security/token 的 type 参数明文（前端写死 "app"） */
const APP_TYPE = 'app'

/** localStorage / sessionStorage 键名（与前端常量 I8 一致） */
const LOGIN_INFO_KEY = 'loginInfo'
const TOKEN_DATA_KEY = 'PUGC.TOKEN_DATA'

/** sm-crypto 的 sm2（cipherMode 0 = C1C2C3，与前端一致） */
const sm2 = sm2lib.sm2

/** sm-crypto 的 sm4（ECB，padding 传 0 与前端一致，见 buildAkt） */
const sm4 = sm2lib.sm4

/**
 * akt 的 SM4 密钥补位串（前端常量，module 58110）：
 * key = (loginInfo.userCode + loginInfo.userID)，不足 32 位用该串补齐/截断。
 */
const AKT_KEY_PAD = '7A9C98341EDB4E07A8AAFB7935D6CBCE'

/** 统一响应包装：{ status, message, data }，status=0 成功 */
interface DuteEnvelope<T = unknown> {
  status?: number
  message?: string
  data?: T
}

/** 页面里读到的原始登录态 */
interface DuteRawCredentials {
  loginInfo: string | null
  tokenData: string | null
}

/** 解析后的登录凭证 */
interface DuteCredentials {
  /** s-token 请求头 */
  authToken: string
  /** 用户 ID（save 的 memeberID / 账号信息接口的 userId） */
  userId: string
  /** akt 的 SM4 密钥（32 位，由 userCode+userID 派生；缺失时 postUrl 退回裸列表页） */
  aktKey?: string
  /** 昵称（来自账号信息接口，回填展示用） */
  nickname?: string
  /** 头像 */
  avatar?: string
  /** 安全 token（Ticket 的原料；缺失时按需自取） */
  securityToken?: string
  /** 用于读取 securityToken 的 tabId（fetchSecurityToken 后不需要） */
  tabId?: number
}

/** 投稿账号信息（getSubmissionPlatformAccountByUserId） */
interface DuteAccount {
  id?: number
  userId?: number
  accountName?: string
  description?: string
  accountType?: string
  classId?: number
  className?: string
  head?: string
  [key: string]: unknown
}

/** 单张图片上传结果 */
interface DuteImageUploadResult {
  /** 公开访问地址（nginx-szby.szpgm.cn/photolibrary/...） */
  url: string
  /** 设备路径（qBp-block;<密文>.png，正文/封面落库用它） */
  path: string
}

export class DuteAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'dute',
    name: '读特·深圳号',
    icon: `${SITE_ORIGIN}/company_logo.png`,
    homepage: LOGIN_PAGE,
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  /** 预处理配置：编辑器正文为 HTML */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  /**
   * Header 规则：对齐同源 POST 的 Origin（扩展 SW 发起的请求 Origin 是扩展协议，
   * 服务端网关可能校验，注入与 HAR 一致的 Origin）。
   */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://batman-szby.szpgm.cn/*',
      headers: {
        Origin: SITE_ORIGIN,
      },
    },
  ]

  /** 当前 publish 会话内的凭证（图片逐张上传复用） */
  private activeCredentials: DuteCredentials | null = null

  // ============ checkAuth ============

  /**
   * 鉴权：从已有后台 tab 读取 loginInfo（必要时自取安全 token），再调账号信息接口复验。
   *
   * - 没有 batman-szby.szpgm.cn 的 tab / 读不到 loginInfo → 未登录
   *   （不主动开 tab：批量检查登录态时逐个开 tab 太重；publish 场景才允许，见 resolveCredentials）
   * - 账号信息接口返回非 0 → 登录态失效
   */
  async checkAuth(): Promise<AuthResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      try {
        const creds = await this.readCredentialsFromExistingTab()
        if (!creds) {
          return {
            isAuthenticated: false,
            error: `请先登录读特·深圳号投稿平台（${LOGIN_PAGE}）`,
          }
        }
        return await this.verifyCredentials(creds)
      } catch (error) {
        logger.debug('checkAuth error:', error)
        return {
          isAuthenticated: false,
          error: (error as Error).message || '鉴权失败',
        }
      }
    })
  }

  /** 调账号信息接口复验凭证（顺带取昵称头像，status!=0 一律视为未登录） */
  private async verifyCredentials(creds: DuteCredentials): Promise<AuthResult> {
    const account = await this.fetchAccount(creds)
    return {
      isAuthenticated: true,
      userId: String(account.id ?? creds.userId),
      username: account.accountName || creds.nickname || creds.userId,
      avatar: account.head || creds.avatar,
    }
  }

  // ============ publish ============

  /**
   * 发布文章（保存到作品管理）。
   *
   * 流程（HAR 验证）：
   *   1. 解析登录凭证（复用已有后台 tab，必要时后台新开作品列表页）
   *   2. 调账号信息接口拿 accountID / columnId（wemedia/save 的必填字段）
   *   3. processBodyImages 上传正文图片（path 回填 <img src/mam>）
   *   4. 上传封面（如有）
   *   5. POST wemedia/init 建稿 → id
   *   6. POST wemedia/save 保存 → docID
   */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish to Dute...')

      // 1. 登录凭证（publish 场景允许新开后台 tab 读登录态）
      const creds = await this.resolveCredentials(true)
      if (!creds) {
        throw new Error(`请先登录读特·深圳号投稿平台（${LOGIN_PAGE}）`)
      }
      this.activeCredentials = creds

      try {
        // 2. 投稿账号信息（createrId / columnId 都从这来）
        const account = await this.fetchAccount(creds)
        const accountId = account.id
        const columnId = account.classId
        if (!accountId || !columnId) {
          throw new Error('获取投稿账号信息失败：响应缺少 id / classId（账号可能未完成入驻审核）')
        }

        // 3. 正文图片（path 回填 src/mam，服务端按 path 落库）
        let content = article.html || ''
        const contentImagePaths: string[] = []
        try {
          content = await this.processBodyImages(content, creds, contentImagePaths, options?.onImageProgress)
        } catch (e) {
          logger.warn('[Dute] 正文图片处理中途失败，继续发布：', (e as Error).message)
        }

        // 4. 封面（标题图，落 picTitle.picSmall）
        let coverPath = ''
        let coverError: string | undefined
        if (article.cover) {
          try {
            const uploaded = await this.uploadImageToDute(article.cover, creds)
            coverPath = uploaded.path
            logger.info(`[Dute] 封面上传成功：${uploaded.url}`)
          } catch (e) {
            coverError = (e as Error).message
            logger.warn('[Dute] 封面上传失败：', coverError)
          }
        } else {
          logger.warn('[Dute] 未提供封面（article.cover），标题图为空')
        }

        // 5. 建稿
        const articleId = await this.initArticle(creds, account)

        // 6. 保存草稿
        const result = await this.saveArticle({
          article,
          content,
          contentImagePaths,
          coverPath,
          articleId,
          accountId,
          columnId,
          creds,
          account,
        })

        logger.info(`[Dute] 草稿已保存：docLibID=${result.docLibID} docID=${result.docID}`)

        // 落点：带 akt 的作品列表深链（与站内跳转链接同形态）；akt 构造失败退回裸地址
        const akt = this.buildAkt('identifyType=we_media', creds)
        const postUrl = akt ? `${WORK_LIST_PAGE}?akt=${akt}` : WORK_LIST_PAGE

        return this.createResult(true, {
          postId: String(result.docID),
          postUrl,
          draftOnly: options?.draftOnly ?? true,
          coverUploaded: !!coverPath,
          ...(coverError ? { coverError } : {}),
          message: `已保存到读特·深圳号（${postUrl}）`,
        })
      } finally {
        this.activeCredentials = null
      }
    }).catch((error) =>
      this.createResult(false, {
        error: (error as Error).message,
      }),
    )
  }

  // ============ 图片上传 ============

  /**
   * 单张图片上传（基类 `uploadImage(blob)` 的实现依赖它）。
   * CLI/MCP 预上传「图床」也会走这里，此时允许按需开后台 tab 读登录态。
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    try {
      const creds = this.activeCredentials || (await this.resolveCredentials(true))
      if (!creds) {
        throw new Error(
          `未登录读特·深圳号，无法上传图片（请先在浏览器打开并登录 ${LOGIN_PAGE}）`,
        )
      }
      const uploaded = await this.uploadImageToDute(src, creds)
      // 平台正文用 path 而非 url；这里返回 url 以兼容通用图床语义，path 由正文处理流程单独取
      return { url: uploaded.url, attrs: { 'dute-path': uploaded.path } }
    } catch (error) {
      // CLI 预上传传进来的往往是 data URI，日志里只留前缀
      logger.warn(`[Dute] 图片上传失败：${displayUrl(src)}`, error)
      return { url: src }
    }
  }

  /**
   * 正文图片处理：把正文里的图片转存到平台素材库，并替换成与后台编辑器一致的
   * `<img src="<path>" mam="<path>" style="max-width:100%;height:auto;" id="<14位数字>"/>` 标签。
   *
   * 单张图片失败只记日志并保留原 src，不阻断整体同步。
   * 上传成功的 path 会 push 进 uploadedPaths（save 时填 pics 数组）。
   */
  private async processBodyImages(
    content: string,
    creds: DuteCredentials,
    uploadedPaths: string[],
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
    const uploadedMap = new Map<string, DuteImageUploadResult>()
    let processed = 0

    for (const { full, src } of matches) {
      if (!src) continue

      // 平台私有设备路径（qBp-block;...）已是站内素材，原样跳过
      if (src.startsWith('qBp-')) {
        uploadedPaths.push(src)
        continue
      }

      processed++
      onProgress?.(processed, matches.length)

      try {
        let uploaded = uploadedMap.get(src)
        if (!uploaded) {
          uploaded = await this.uploadImageToDute(src, creds)
          uploadedMap.set(src, uploaded)
        }
        uploadedPaths.push(uploaded.path)
        const tag = buildImageTag(uploaded.path)
        // 用函数替换，避免 URL 里的 `$` 被当成 replace 的替换模式
        result = result.replace(full, () => tag)
      } catch (error) {
        logger.warn(`[Dute] 正文图片上传失败，保留原 URL：${displayUrl(src)}`, error)
      }

      await this.delay(300)
    }

    return result
  }

  /**
   * 上传单张图片：POST /prebatman/batman/article/uploadImage（multipart：file + dn）。
   * 返回 { url, path }，正文/封面统一使用 path。
   */
  private async uploadImageToDute(src: string, creds: DuteCredentials): Promise<DuteImageUploadResult> {
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

    // 2. multipart 上传（字段名与 HAR 一致：file + dn）
    const filename = `image-${this.uniqueName()}.${this.extensionFor(blob.type)}`
    const formData = new FormData()
    formData.append('file', blob, filename)
    formData.append('dn', this.generateDn())

    const data = await this.requestJson<DuteEnvelope<DuteImageUploadResult>>(
      `${SITE_ORIGIN}/prebatman/batman/article/uploadImage`,
      {
        method: 'POST',
        headers: await this.apiHeaders(creds),
        body: formData,
      },
      '图片上传失败',
    )

    const { url, path } = data.data || ({} as DuteImageUploadResult)
    if (!path) {
      throw new Error('图片上传失败：响应缺少 path')
    }
    return { url: url || '', path }
  }

  // ============ 建稿 / 保存 ============

  /** 建稿：POST /prebatman/batman/wemedia/init → data.id = "<docLibID>,<docID>" */
  private async initArticle(creds: DuteCredentials, account: DuteAccount): Promise<string> {
    const payload = {
      createrId: account.id,
      createrName: account.accountName || '',
      memberId: account.userId ?? Number(creds.userId),
      column: account.classId,
      mod: 'batman-app',
      dn: this.generateDn(),
    }

    const data = await this.requestJson<DuteEnvelope<{ id?: string }>>(
      `${SITE_ORIGIN}/prebatman/batman/wemedia/init`,
      {
        method: 'POST',
        headers: await this.apiHeaders(creds, { 'Content-Type': 'application/json;charset=UTF-8' }),
        body: JSON.stringify(payload),
      },
      '建稿失败',
    )

    if (!data.data?.id) {
      throw new Error('建稿失败：响应未含文章 id')
    }
    return data.data.id
  }

  /**
   * 保存草稿：POST /prebatman/batman/wemedia/save。
   * 字段与 HAR 样本对齐；label 三项是后台编辑器的固定表单（摘要/关键词/原创），
   * 摘要与关键词平台要求必填，这里做 best-effort 派生。
   */
  private async saveArticle(params: {
    article: Article
    content: string
    contentImagePaths: string[]
    coverPath: string
    articleId: string
    accountId: number
    columnId: number
    creds: DuteCredentials
    account: DuteAccount
  }): Promise<{ docLibID: number; docID: number }> {
    const { article, content, coverPath, articleId, accountId, columnId, creds, account } = params
    const plainText = stripHtml(content).replace(/\s+/g, '').trim()
    const abstract = article.summary?.trim() || plainText.slice(0, 100) || article.title
    const keywords = article.tags?.length ? article.tags.join(',') : ''

    const payload = {
      siteID: 1,
      columnId,
      memeberID: account.userId ?? Number(creds.userId),
      accountID: accountId,
      accountName: account.accountName || '',
      accountType: account.accountType || 'we_media',
      id: articleId,
      type: 0,
      topic: article.title,
      content,
      wordCount: String(plainText.length),
      isNew: true,
      label: {
        a_abstract: abstract,
        a_keyword: keywords,
        a_copyright: '1',
      },
      picTitle: {
        picSmall: coverPath,
        picMiddle: '',
        picBig: '',
      },
      audios: [],
      files: [],
      commitment: {},
      // pics = 正文图片列表（HAR：[{ content: "", path: <正文图片 path> }]）
      pics: params.contentImagePaths.map((path) => ({ content: '', path })),
      videos: [],
      widgets: { attachments: [] },
      activity: {},
      planList: [],
      comments: '',
      linkID: '',
      url: '',
      dn: this.generateDn(),
    }

    const data = await this.requestJson<DuteEnvelope<{ docLibID?: number; docID?: number }>>(
      `${SITE_ORIGIN}/prebatman/batman/wemedia/save`,
      {
        method: 'POST',
        headers: await this.apiHeaders(creds, { 'Content-Type': 'application/json;charset=UTF-8' }),
        body: JSON.stringify(payload),
      },
      '保存草稿失败',
    )

    if (data.data?.docID === undefined) {
      throw new Error('保存草稿失败：响应未含 docID')
    }
    return { docLibID: data.data.docLibID ?? 0, docID: data.data.docID }
  }

  // ============ 账号信息 ============

  /** 账号信息：GET /prebatman/member/spc/v1/backend/getSubmissionPlatformAccountByUserId */
  private async fetchAccount(creds: DuteCredentials): Promise<DuteAccount> {
    const query = new URLSearchParams({
      userId: creds.userId,
      loginSource: 'batman',
    })
    const data = await this.requestJson<DuteEnvelope<DuteAccount>>(
      `${SITE_ORIGIN}/prebatman/member/spc/v1/backend/getSubmissionPlatformAccountByUserId?${query}`,
      {
        method: 'GET',
        headers: await this.apiHeaders(creds),
      },
      '获取投稿账号信息失败',
    )

    if (!data.data) {
      throw new Error('获取投稿账号信息失败：响应缺少 data')
    }
    return data.data
  }

  // ============ 凭证获取 ============

  /**
   * 解析登录凭证。
   *
   * 顺序：
   *   1. 已有 batman-szby.szpgm.cn tab → 读页面 localStorage / sessionStorage
   *   2. allowCreateTab 时后台新开作品列表页（SPA 启动会自取安全 token 写入 sessionStorage）再读
   *
   * 读取结果里如果没有安全 token（页面还没跑完 FETCH_TOKEN 等），publish 前调接口时
   * `apiHeaders()` 会自动走 `fetchSecurityToken()` 自取。
   *
   * @param allowCreateTab publish / 图床预上传传 true；checkAuth 传 false（批量检查不开 tab）
   */
  private async resolveCredentials(allowCreateTab: boolean): Promise<DuteCredentials | null> {
    const existing = await this.readCredentialsFromExistingTab()
    if (existing) return existing

    if (allowCreateTab) {
      const tabId = await this.createAuthTab()
      if (tabId !== null) {
        const creds = await this.readCredentialsFromTab(tabId)
        if (creds) return creds
      }
    }

    return null
  }

  /** 查找已打开的后台 tab（不做任何副作用操作） */
  private async readCredentialsFromExistingTab(): Promise<DuteCredentials | null> {
    const runtimeTabs = this.runtime.tabs
    if (!runtimeTabs) return null
    try {
      const tabs = await runtimeTabs.query('*://batman-szby.szpgm.cn/*')
      const first = tabs[0]
      if (!first || first.id === undefined) return null
      return await this.readCredentialsFromTab(first.id)
    } catch (error) {
      logger.debug('[Dute] 查询 batman-szby.szpgm.cn tab 失败：', error)
      return null
    }
  }

  /** 后台打开作品列表页（用于读取页面登录态；登录态仅在用户已登录时存在） */
  private async createAuthTab(): Promise<number | null> {
    const runtimeTabs = this.runtime.tabs
    if (!runtimeTabs) return null
    try {
      logger.info(`[Dute] 后台打开 ${AUTH_PAGE} 以读取登录态...`)
      const tab = await runtimeTabs.create(AUTH_PAGE, false)
      if (tab.id === undefined) return null
      await runtimeTabs.waitForLoad(tab.id, 30000)
      // SPA 启动后还会异步取安全 token，多等一拍
      await this.delay(2000)
      return tab.id
    } catch (error) {
      logger.debug('[Dute] 创建后台 tab 失败：', error)
      return null
    }
  }

  /** 在指定 tab 的页面上下文读取 localStorage / sessionStorage 里的登录态 */
  private async readCredentialsFromTab(tabId: number): Promise<DuteCredentials | null> {
    const runtimeTabs = this.runtime.tabs
    if (!runtimeTabs) return null
    try {
      // executeScript 在 MAIN world 执行，函数不得引用模块级变量
      const raw = await runtimeTabs.executeScript<DuteRawCredentials, [string, string]>(
        tabId,
        readCredentialsInPageScript,
        [LOGIN_INFO_KEY, TOKEN_DATA_KEY],
      )
      return this.buildCredentials(raw, tabId)
    } catch (error) {
      logger.debug('[Dute] 读取页面登录态失败：', error)
      return null
    }
  }

  /**
   * 组装凭证：loginInfo 必须存在（未登录判据与前端一致），安全 token 可缺省。
   */
  private buildCredentials(raw: DuteRawCredentials | null, tabId: number): DuteCredentials | null {
    if (!raw?.loginInfo) return null

    let login: Record<string, unknown>
    try {
      login = JSON.parse(raw.loginInfo) as Record<string, unknown>
    } catch {
      return null
    }

    const authToken = pickString(login, 'authToken', 'token')
    const userId = pickString(login, 'userID', 'userId', 'id')
    if (!authToken || !userId) return null

    let securityToken: string | undefined
    if (raw.tokenData) {
      try {
        const tokenData = JSON.parse(raw.tokenData) as Record<string, unknown>
        securityToken = pickString(tokenData, 'token')
      } catch {
        // TOKEN_DATA 解析失败按缺失处理，后续自动重取
      }
    }

    return {
      authToken,
      userId,
      aktKey: this.deriveAktKey(login),
      nickname: pickString(login, 'userName', 'nickName', 'nickname'),
      avatar: pickString(login, 'head', 'avatar', 'headUrl'),
      securityToken,
      tabId,
    }
  }

  /**
   * 派生 akt 的 SM4 密钥（与前端 module 58110 一致）：
   *   raw = (loginInfo.userCode || '') + loginInfo.userID
   *   不足 32 位用 AKT_KEY_PAD 补齐，超长截断。
   * 派生失败返回 undefined（postUrl 退回裸列表页，不影响发布本身）。
   */
  private deriveAktKey(login: Record<string, unknown>): string | undefined {
    const userCode = pickString(login, 'userCode') ?? ''
    const userId = pickString(login, 'userID', 'userId')
    if (!userId) return undefined
    const raw = userCode + userId
    return raw.length === 32 ? raw : (raw + AKT_KEY_PAD).slice(0, 32)
  }

  /**
   * 构造 akt 参数（round-trip 已与站内生成密文逐字节一致）：
   *   akt = "04" + SM4-ECB("<params>", aktKey, padding=0)
   * params 形如 "identifyType=we_media" / "actions=add&identifyType=we_media"。
   */
  private buildAkt(params: string, creds: DuteCredentials): string | null {
    if (!creds.aktKey) return null
    try {
      return '04' + sm4.encrypt(params, creds.aktKey, 0)
    } catch (e) {
      logger.warn('[Dute] akt 生成失败：', (e as Error).message)
      return null
    }
  }

  // ============ 安全 token / Ticket ============

  /**
   * 自取安全 token：完整复刻前端 FETCH_TOKEN 链路。
   *
   *   1. SW 内临时生成一对 SM2 密钥
   *   2. GET /prebatman/batman/security/token
   *        ?type=SM2("app")&key=SM2("mediax-dev-app")&secret=SM2(SECRET)&publicKey=SM2(<临时公钥>)
   *      （GET query 里的密文都带 "04" 前缀，与前端 Fe() 输出一致）
   *   3. 响应 data.data 为用临时公钥加密的密文（"04"+hex），用临时私钥解出
   *      { token, type, deltime, timeout }；若服务端直接给对象（老网关），token 按 "notoken" 处理
   */
  private async fetchSecurityToken(): Promise<string> {
    const keypair = sm2.generateKeyPairHex()

    const enc = (plain: string): string => smEncrypt(plain, SERVER_PUB_KEY)
    const query = new URLSearchParams({
      type: enc(APP_TYPE),
      key: enc(APP_KEY),
      secret: enc(APP_SECRET),
      publicKey: enc(keypair.publicKey),
    })

    const resp = await this.runtime.fetch(`${SITE_ORIGIN}/prebatman/batman/security/token?${query}`, {
      method: 'GET',
      credentials: 'include',
      headers: { source: 'batman' },
    })
    const text = await resp.text()

    let body: DuteEnvelope<string | Record<string, unknown>>
    try {
      body = JSON.parse(text) as DuteEnvelope<string | Record<string, unknown>>
    } catch {
      throw new Error(`获取安全 token 失败：响应非 JSON (HTTP ${resp.status})`)
    }
    if (body.status !== 0) {
      throw new Error(`获取安全 token 失败：${body.message || `status=${body.status}`}`)
    }

    const payload = body.data
    if (typeof payload === 'string' && payload.length > 2) {
      // SM2 C1C2C3，去 "04" 前缀后解密（密钥对随请求生成，一定能解开）
      const decrypted = smDecrypt(payload, keypair.privateKey)
      try {
        const parsed = JSON.parse(decrypted) as Record<string, unknown>
        const token = pickString(parsed, 'token')
        if (!token) throw new Error('token 为空')
        return token
      } catch (e) {
        throw new Error(`安全 token 解析失败：${(e as Error).message}`)
      }
    }

    if (payload && typeof payload === 'object') {
      // 与前端一致：响应已是对象时 token 置 "notoken"（老网关下不校验 Ticket 内容）
      logger.warn('[Dute] security/token 响应为对象，token 按 notoken 处理')
      return 'notoken'
    }

    throw new Error('获取安全 token 失败：响应缺少 data')
  }

  /**
   * 组装平台接口请求头（对齐前端 axios 拦截器 + reporter 子应用的手工指定）：
   *   s-token / source / Ticket（Ticket 需要安全 token，缺失时自动自取并缓存）
   *
   * @param creds 登录凭证
   * @param extra 额外头（如 Content-Type；FormData 请求不要传，交给浏览器带 boundary）
   */
  private async apiHeaders(
    creds: DuteCredentials,
    extra: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    if (!this.securityToken) {
      this.securityToken = creds.securityToken ?? null
    }
    if (!this.securityToken) {
      this.securityToken = await this.fetchSecurityToken()
      logger.info('[Dute] 已自动获取安全 token')
    }

    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      's-token': creds.authToken,
      source: 'batman',
      Ticket: smEncrypt(
        JSON.stringify({
          token: this.securityToken,
          secret: APP_SECRET,
          timestamp: Date.now(),
        }),
        SERVER_PUB_KEY,
      ),
      ...extra,
    }
    return headers
  }

  /** 会话级安全 token 缓存（超时由服务端裁决，401/鉴权失败时清空重取） */
  private securityToken: string | null = null

  // ============ 工具方法 ============

  /**
   * 发起平台接口请求并解析统一响应包装。
   * - 非 JSON 响应直接抛错
   * - status=401/403（登录态失效）→ 提示重新登录，并清空安全 token 缓存
   * - 其它非 0 status → 抛出「action：message」
   */
  private async requestJson<T extends DuteEnvelope<unknown>>(
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

    if (resp.status === 401 || resp.status === 403 || data.status === 401 || data.status === 403) {
      this.securityToken = null
      throw new Error(`${action}：登录态已失效，请重新登录读特·深圳号（${LOGIN_PAGE}）`)
    }
    if (data.status !== 0) {
      throw new Error(`${action}：${data.message || `status=${data.status}`}`)
    }
    return data
  }

  /**
   * `dn` 参数：与前端 OX() 一致 —— randomUUID 去 '-'（32 位）+ 时间戳后 5 位。
   * 出现在几乎所有接口的 query / body / multipart 里，服务端只要求存在即可。
   */
  private generateDn(): string {
    let uuid = ''
    try {
      uuid = crypto.randomUUID().replace(/-/g, '')
    } catch {
      // 兜底：伪随机 32 位十六进制
      for (let i = 0; i < 32; i++) {
        uuid += Math.floor(Math.random() * 16).toString(16)
      }
    }
    return uuid + String(Date.now()).slice(-5)
  }

  /** 由 mime 推断文件扩展名（multipart filename 用） */
  private extensionFor(mime: string): string {
    const normalized = (mime || '').toLowerCase()
    if (normalized.includes('png')) return 'png'
    if (normalized.includes('gif')) return 'gif'
    if (normalized.includes('webp')) return 'webp'
    if (normalized.includes('bmp')) return 'bmp'
    if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg'
    return 'png'
  }

  /** 生成 ASCII 文件名主体 */
  private uniqueName(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
}

// ============ 模块级工具 ============

/**
 * SM2 加密（对齐前端 Fe()）：明文 JSON 串 → C1C2C3 密文，输出加 "04" 前缀。
 */
function smEncrypt(plain: string, publicKey: string): string {
  return '04' + sm2.doEncrypt(plain, publicKey, 0)
}

/**
 * SM2 解密（对齐前端 YD()）：去 "04" 前缀后按 C1C2C3 解密。
 */
function smDecrypt(cipher: string, privateKey: string): string {
  return sm2.doDecrypt(cipher.substr(2), privateKey, 0)
}

/**
 * 拼出正文插图的 `<img>` 标签（形态与后台编辑器产物一致，HAR 验证）：
 *   <img src="<path>" mam="<path>" style="max-width:100%;height:auto;" id="<14位数字>"/>
 *
 * @param path 上传接口返回的设备路径（qBp-block;<密文>.png）
 */
function buildImageTag(path: string): string {
  const escaped = path.replace(/"/g, '&quot;')
  const id = String(Math.floor(1e13 + Math.random() * 9e13))
  return `<img src="${escaped}" mam="${escaped}" style="max-width:100%;height:auto;" id="${id}">`
}

/**
 * 日志展示用的 URL：data URI / 超长地址只留前缀，避免整段 base64 打进控制台。
 */
function displayUrl(url: string): string {
  return url.length > 120 ? `${url.slice(0, 80)}…（共 ${url.length} 字符）` : url
}

/** 从对象里按顺序取第一个非空字符串字段 */
function pickString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj?.[key]
    if (typeof value === 'string' && value) return value
    if (typeof value === 'number' && !Number.isNaN(value)) return String(value)
  }
  return undefined
}

/** 去掉 HTML 标签取纯文本（wordCount / 摘要派生用） */
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
}

/**
 * 在后台页面 MAIN world 读取登录态。
 *
 * ⚠️ 纯函数约束（MV3 executeScript 闭包序列化陷阱）：本函数会被序列化后在页面
 * 上下文执行，禁止引用模块级函数/常量。键名通过参数传入。
 *
 * loginInfo 在 localStorage；PUGC.TOKEN_DATA 在 sessionStorage（每个 tab 的 SPA
 * 启动时自行获取并写入，未登录的 tab 里不存在）。
 */
function readCredentialsInPageScript(loginInfoKey: string, tokenDataKey: string): DuteRawCredentials {
  const readLocal = (key: string): string | null => {
    try {
      return window.localStorage.getItem(key)
    } catch {
      return null
    }
  }
  const readSession = (key: string): string | null => {
    try {
      return window.sessionStorage.getItem(key)
    } catch {
      return null
    }
  }

  return {
    loginInfo: readLocal(loginInfoKey),
    tokenData: readSession(tokenDataKey),
  }
}
