/**
 * 腾讯内容开放平台（企鹅号）适配器
 *
 * 平台资料：
 * - 创作者后台：https://om.qq.com/
 * - 文章编辑器：https://om.qq.com/main/creation/article
 *
 * 实现思路（基于浏览器抓包真实接口）：
 *
 * 鉴权：完全依赖浏览器 cookie 登录态，关键 cookie：
 *   - userid          → mediaId（媒体 ID，所有请求必传）
 *   - omaccesstoken   → OM 内部 access token（等同于 omtoken）
 *   - omtoken         → 同 omaccesstoken
 *   - csrfToken       → CSRF token，跨域请求图床需作为 x-csrf-token header
 * 鉴权流程：GET https://om.qq.com/main/creation/article，
 *   从返回 HTML 中提取昵称/头像（与微信公众号的 checkAuth 同思路）。
 *
 * 图床上传（multipart/form-data）：
 *   POST https://image.om.qq.com/cpom_pimage/ArchacaleUploadViaFile
 *     FormData:
 *       appid=LA6zXi1lWzAioIzdiAD6iM10aHarlHF6   (固定)
 *       isUpOrg=1
 *       endpoint=1
 *       isRetImgAttr=1
 *       opCode=151
 *       file=<二进制>
 *     Headers:
 *       x-csrf-token: <csrfToken cookie>
 *     Response:
 *       { code:0, message:"success", data:{ url:{ url, size:{640,641,1000,...} } } }
 *       主图 URL → data.url.url
 *
 * 文章保存（application/json）：
 *   POST https://om.qq.com/marticlepublish/omSave
 *     Headers:
 *       Content-Type: application/json
 *       X-Requested-With: XMLHttpRequest
 *       x-csrf-token: <cookie csrfToken>
 *       Origin: https://om.qq.com
 *       Referer: https://om.qq.com/main/creation/article
 *     Body（JSON，与浏览器保存草稿请求一致）：
 *       title, title2, tag, video, cover_type,
 *       imgurl_ext（字符串化的多尺寸字典数组）,
 *       imgurlsrc ("custom"),
 *       category_id, content（含末尾 <div powered-by="ex-editor"></div>）,
 *       orignal, user_original, music, activity,
 *       apply_olympic_flag, apply_push_flag, apply_reward_flag, reward_flag,
 *       survey_id, survey_name, om_activity_id, om_activity_name,
 *       activityInfo, commercialization_source, caimaiInfo,
 *       isHowto, howtoInfo, daihuoInfo, novel,
 *       needpub, articleId（首次保存为空字符串，后端自动生成）,
 *       event_id, event_name, activity_scene_id, hotBreak,
 *       self_declare（必填，固定 {"id":7,"desc":"作者声明：无需标注"}）,
 *       resource_aigc_mark_info, parent_article_id,
 *       conclusion, summary, failedImage, adContentImgs,
 *       mediaId, type, relogin
 *     Response: { response: { code: "0", msg: "success" }, data: { articleId: "..." } }
 *     ⚠️ response.code 是字符串 "0"，不是数字 0
 *
 * 实时缓存（每次输入时触发，可选调用）：
 *   POST https://om.qq.com/editorCache/update  (form-encoded + cache JSON)
 *   本适配器不调用，仅说明企鹅号编辑器会自动调用。
 *
 * 头规则：需为 om.qq.com / image.om.qq.com / oms.qq.com 系列请求注入
 *   Origin: https://om.qq.com
 *   Referer: https://om.qq.com/main/creation/article
 *   才能通过 CORS/Cookie 校验。
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('QQContent')

/** OM 内部编辑器主域 */
const EDITOR_ORIGIN = 'https://om.qq.com'

/** 图床子域 */
const IMAGE_UPLOAD_ORIGIN = 'https://image.om.qq.com'

/** 文章保存接口（基于真实抓包确认，POST JSON） */
const ARTICLE_SAVE_URL = `${EDITOR_ORIGIN}/marticlepublish/omSave`

/** 图片上传接口（浏览器抓包确认） */
const IMAGE_UPLOAD_URL = `${IMAGE_UPLOAD_ORIGIN}/cpom_pimage/ArchacaleUploadViaFile`

/** self_declare 默认值：作者声明-无需标注 */
const SELF_DECLARE_DEFAULT = '{"id":7,"desc":"作者声明：无需标注"}'

/** 图片上传固定 appid（浏览器抓包确认） */
const UPLOAD_APPID = 'LA6zXi1lWzAioIzdiAD6iM10aHarlHF6'

/** 用户登录态相关 cookie 名 */
const COOKIE_NAMES = {
  userId: 'userid',
  accessToken: ['omaccesstoken', 'omtoken'],
  csrfToken: 'csrfToken',
}

/**
 * 编辑器页面抓取到的用户信息（昵称 / 头像 / mediaId）
 */
interface OmUserInfo {
  mediaId: string
  nickname: string
  avatar: string
  /** 同一份 CSRF token 跨域请求图床时也要带 */
  csrfToken: string
}

/**
 * 图片上传响应 data.url 节点
 * 真实接口返回（参考用户提供的 cURL）：
 *   url: <原图URL，"om_bt" 域>
 *   size: {
 *     "0":   { imageUrl, width, height, ... },  // 原图
 *     "640": { imageUrl, width, height, ... },
 *     "641": { imageUrl, width, height, ... },  // 封面缩略图（编辑器默认使用）
 *     "1000":{ imageUrl, width, height, ... }
 *   }
 */
interface OmImageUploadSizeItem {
  imageUrl?: string
  width?: string | number
  height?: string | number
  faceSize?: unknown
  cropWidth?: string | number
  cropHeight?: string | number
}

interface OmImageUploadUrl {
  url: string
  title?: string
  /** 多尺寸 URL 映射：key 为尺寸编号（"0"/"640"/"641"/"1000"），value 包含 imageUrl */
  size?: Record<string, OmImageUploadSizeItem>
  isqrcode?: number
  face?: string
  copyright?: number
  srcurl?: string
  resource_id?: string
  type?: number
  msg?: string
  count?: number
  errCode?: number
  islong?: number
  length?: string
}

interface OmImageUploadData {
  url: OmImageUploadUrl
}

interface OmImageUploadResp {
  /** 后端 code 可能是数字 0 或字符串 "0" */
  code?: number | string
  message?: string
  msg?: string
  data?: OmImageUploadData
}

/**
 * omSave 响应（兼容多层包装）
 * 真实接口返回: { response: { code: "0", msg: "success" }, data: { articleId: "..." } }
 * 某些情况下可能未包装：    { code: "0", msg: "success", data: { articleId: "..." } }
 * ⚠️ code 可能是字符串 "0"（不要当数字比较）
 */
interface OmEditorCacheResp {
  code?: number | string
  msg?: string
  message?: string
  data?: unknown
  /** 部分接口会用 response 包一层 */
  response?: {
    code?: number | string
    msg?: string
    message?: string
    data?: unknown
  }
}

interface OmSaveData {
  articleId?: string
  article_id?: string
  url?: string
  id?: string
}

/**
 * 把任意 editorCache/update 响应规整成统一形态
 */
interface NormalizedModify {
  /** code 原值（字符串 "0" 或数字 0 均视为成功） */
  code: string | number
  msg: string
  articleId?: string
  url?: string
}

function normalizeModifyResp(raw: OmEditorCacheResp | null | undefined): NormalizedModify {
  if (!raw || typeof raw !== 'object') {
    return { code: -1, msg: '空响应' }
  }
  // 真实接口常见结构：
  //   { response: { code, msg, ... }, data: [] }
  //   { response: { code, msg, ... }, data: { articleId: "..." } }
  //   { response: { code, msg, data: { articleId: "..." } }, data: [] }   ← 嵌套双层
  //   { response: { code, msg, data: { data: { articleId: "..." } } }, data: [] }   ← 三层
  const inner = raw.response || raw
  const code = inner.code !== undefined ? inner.code : -1
  const msg = inner.msg || inner.message || ''

  // 递归查找 articleId（最多 3 层）
  function extractArticleId(node: unknown, depth = 0): string | undefined {
    if (!node || typeof node !== 'object' || depth > 3) return undefined
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = extractArticleId(item, depth + 1)
        if (found) return found
      }
      return undefined
    }
    const obj = node as Record<string, unknown>
    const direct =
      (typeof obj.articleId === 'string' && obj.articleId) ||
      (typeof obj.article_id === 'string' && obj.article_id) ||
      (typeof obj.id === 'string' && obj.id) ||
      undefined
    if (direct) return direct
    // 递归查子对象
    for (const key of Object.keys(obj)) {
      if (key === 'code' || key === 'msg' || key === 'message') continue
      const found = extractArticleId(obj[key], depth + 1)
      if (found) return found
    }
    return undefined
  }

  // 先读顶层 data，再读 response.data，再读嵌套双层
  const candidates = [
    raw.data,                              // 顶层 data：{ articleId: "..." }
    raw.response?.data as unknown,         // 嵌套 data：{ response: { data: { articleId } } }
    (raw.response as any)?.data?.data,      // 三层：{ response: { data: { data: { articleId } } } }
  ]
  let articleId: string | undefined
  for (const cand of candidates) {
    articleId = extractArticleId(cand)
    if (articleId) break
  }

  // url 同样递归提取
  let url: string | undefined
  function extractUrl(node: unknown, depth = 0): string | undefined {
    if (!node || typeof node !== 'object' || depth > 3) return undefined
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = extractUrl(item, depth + 1)
        if (found) return found
      }
      return undefined
    }
    const obj = node as Record<string, unknown>
    if (typeof obj.url === 'string' && obj.url) return obj.url
    for (const key of Object.keys(obj)) {
      if (key === 'code' || key === 'msg' || key === 'message' || key === 'articleId') continue
      const found = extractUrl(obj[key], depth + 1)
      if (found) return found
    }
    return undefined
  }
  for (const cand of candidates) {
    url = extractUrl(cand)
    if (url) break
  }

  return { code, msg, articleId, url }
}

/**
 * 判断响应是否成功：code 为 "0" 或 0 均视为成功
 */
function isSuccessCode(code: string | number | undefined | null): boolean {
  return code === 0 || code === '0'
}

export class QQContentAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'qq-content',
    name: '腾讯内容开放平台',
    icon: 'https://om.gtimg.cn/om/om_building/dist/images/favicon.ico',
    homepage: 'https://om.qq.com/main/creation/article',
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  /**
   * 预处理配置：
   * - 输出 HTML（适配 ProseMirror 编辑器）
   * - 移除微信特殊标签 / SVG 占位 / 空 div
   * - 处理懒加载图片
   */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    removeSpecialTags: true,
    removeSvgImages: true,
    removeEmptyDivs: true,
    processCodeBlocks: true,
    processLazyImages: true,
  }

  /** 当前用户信息（从编辑器页面抓取） */
  private userInfo: OmUserInfo | null = null

  /** 最新上传的封面图多尺寸 URL 映射（用于填充 editorCache/update 的 imgurl_ext） */
  private lastUploadedCoverSizeMap: Record<string, string> | null = null

  /** 注入 CORS / Referer / CSRF 等请求头 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://om.qq.com/*',
      headers: {
        'Origin': EDITOR_ORIGIN,
        'Referer': `${EDITOR_ORIGIN}/main/creation/article`,
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://image.om.qq.com/*',
      headers: {
        'Origin': EDITOR_ORIGIN,
        'Referer': `${EDITOR_ORIGIN}/main/creation/article`,
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://oms.qq.com/*',
      headers: {
        'Origin': EDITOR_ORIGIN,
        'Referer': `${EDITOR_ORIGIN}/main/creation/article`,
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  // ============ Cookie 读取 ============

  /**
   * 读取指定域名的所有 cookie
   */
  private async readCookies(domain: string) {
    return this.runtime.cookies.get(domain).catch(() => [])
  }

  /**
   * 一次性读取 om.qq.com 上需要的所有 cookie
   */
  private async readOmCookies(): Promise<{
    userId: string
    accessToken: string
    csrfToken: string
  }> {
    const allCookies = [
      ...(await this.readCookies('.om.qq.com')),
      ...(await this.readCookies('om.qq.com')),
      ...(await this.readCookies('.image.om.qq.com')),
      ...(await this.readCookies('image.om.qq.com')),
    ]

    const findValue = (name: string) =>
      allCookies.find((c) => c.name === name && c.value)?.value || ''

    const userId = findValue(COOKIE_NAMES.userId)
    let accessToken = ''
    for (const name of COOKIE_NAMES.accessToken) {
      accessToken = findValue(name)
      if (accessToken) break
    }
    const csrfToken = findValue(COOKIE_NAMES.csrfToken)

    return { userId, accessToken, csrfToken }
  }

  // ============ checkAuth ============

  async checkAuth(): Promise<AuthResult> {
    try {
      // 1. 先从 cookie 拿基础信息（mediaId / csrfToken）
      const cookies = await this.readOmCookies()
      if (!cookies.userId) {
        return {
          isAuthenticated: false,
          error: '请先登录腾讯内容开放平台（https://om.qq.com/）',
        }
      }

      // 2. 拉取编辑器页面，从 HTML 提取昵称/头像（与微信 checkAuth 同思路）
      const html = await this.fetchEditorHtml()

      const nickname = this.extractNickname(html) || `企鹅号 ${cookies.userId}`
      const avatar = this.extractAvatar(html)

      this.userInfo = {
        mediaId: cookies.userId,
        nickname,
        avatar,
        csrfToken: cookies.csrfToken,
      }

      logger.debug('checkAuth OK:', {
        mediaId: cookies.userId,
        nickname,
        hasAvatar: !!avatar,
      })

      return {
        isAuthenticated: true,
        userId: cookies.userId,
        username: nickname,
        avatar,
      }
    } catch (error) {
      logger.debug('checkAuth failed:', error)
      // 即便拉取编辑器页面失败，只要 userid cookie 存在也算登录态有效
      // （可能是编辑器页面改版或临时网络问题），让用户能继续操作
      const cookies = await this.readOmCookies()
      if (cookies.userId) {
        this.userInfo = {
          mediaId: cookies.userId,
          nickname: `企鹅号 ${cookies.userId}`,
          avatar: '',
          csrfToken: cookies.csrfToken,
        }
        return {
          isAuthenticated: true,
          userId: cookies.userId,
          username: this.userInfo.nickname,
          error: '已登录，但未拿到完整用户信息：' + (error as Error).message,
        }
      }
      return {
        isAuthenticated: false,
        error: (error as Error).message,
      }
    }
  }

  /**
   * 拉取编辑器首页 HTML（带 cookie 登录态）
   */
  private async fetchEditorHtml(): Promise<string> {
    const response = await this.runtime.fetch(
      `${EDITOR_ORIGIN}/main/creation/article`,
      {
        method: 'GET',
        credentials: 'include',
        headers: {
          Accept: 'text/html,application/xhtml+xml',
        },
      }
    )
    if (!response.ok) {
      throw new Error(`编辑器页面返回 HTTP ${response.status}`)
    }
    return response.text()
  }

  /**
   * 从编辑器页面提取昵称（参考微信适配器的正则思路，匹配 JSON 配置块）
   */
  private extractNickname(html: string): string {
    // 1) 常见 JSON 配置块：nick:"xxx" / nickName:"xxx" / nick_name:"xxx"
    const patterns = [
      /\bnick\s*[:=]\s*["']([^"']+)["']/i,
      /\bnickName\s*[:=]\s*["']([^"']+)["']/i,
      /\bnick_name\s*[:=]\s*["']([^"']+)["']/i,
      /\bwriterName\s*[:=]\s*["']([^"']+)["']/i,
      /\bwriter_name\s*[:=]\s*["']([^"']+)["']/i,
      /\bmediaName\s*[:=]\s*["']([^"']+)["']/i,
    ]
    for (const re of patterns) {
      const m = html.match(re)
      if (m && m[1]) return m[1]
    }
    // 2) meta / title 兜底
    const titleMatch = html.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i)
    if (titleMatch) return titleMatch[1]
    return ''
  }

  /**
   * 从编辑器页面提取头像
   */
  private extractAvatar(html: string): string {
    const patterns = [
      /\bheader\s*[:=]\s*["']([^"']+)["']/i,
      /\bavatar\s*[:=]\s*["']([^"']+)["']/i,
      /\bhead_img\s*[:=]\s*["']([^"']+)["']/i,
      /\bheadImg\s*[:=]\s*["']([^"']+)["']/i,
    ]
    for (const re of patterns) {
      const m = html.match(re)
      if (m && m[1]) {
        return m[1].replace(/^http:\/\//i, 'https://')
      }
    }
    // 兜底：class 含 avatar/header 的 img 标签
    const imgMatch = html.match(/<img[^>]+class=["'][^"']*(?:avatar|header|head)[^"']*["'][^>]+src=["']([^"']+)["']/i)
    if (imgMatch) return imgMatch[1].replace(/^http:\/\//i, 'https://')
    return ''
  }

  // ============ publish ============

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish to Tencent Content Open Platform...')

      // 1. 鉴权
      if (!this.userInfo) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated || !this.userInfo) {
          throw new Error(auth.error || '未登录企鹅号')
        }
      }
      const userInfo = this.userInfo!

      // 2. 标题校验（6-30 字，去首尾空白）
      const title = this.normalizeTitle(article.title)
      if (title.length < 6) {
        throw new Error('标题太短（企鹅号要求 6-30 字）')
      }
      if (title.length > 30) {
        throw new Error('标题太长（企鹅号要求 6-30 字）')
      }

      // 3. 上传封面图（必有，否则无法保存）
      let coverUrl = ''
      let coverError = ''
      if (article.cover) {
        try {
          const r = await this.uploadImageByUrl(article.cover)
          coverUrl = r.url
          // 缓存多尺寸 map（供 editorCache/update 的 imgurl_ext 使用）
          const sizesAttr = r.attrs?.['data-om-sizes']
          if (typeof sizesAttr === 'string') {
            try {
              this.lastUploadedCoverSizeMap = JSON.parse(sizesAttr)
            } catch {
              /* 忽略 */
            }
          }
          logger.debug('Cover uploaded:', coverUrl)

          // 4. 调 ListImageUploadViaUrl 确认封面
          //    用 size["641"].imageUrl（缩略图）让后端生成 om_ls 域多尺寸 URL
          //    返回的 sizeMap 含 { "1": "...", "150120": "...", ..., "580300": "..." }
          const sizeMap = this.lastUploadedCoverSizeMap || {}
          const confirmUrl =
            sizeMap['src'] || // 上传响应里的 641 缩略图
            coverUrl
          if (confirmUrl) {
            const omSizeMap = await this.confirmCover(confirmUrl, userInfo)
            if (omSizeMap) {
              // 合并：om_ls 域尺寸 + 上传的 src (om_bt 域 641 缩略图)
              const merged: Record<string, string> = { ...omSizeMap }
              if (!merged['src'] && sizeMap['src']) merged['src'] = sizeMap['src']
              if (!merged['src']) merged['src'] = coverUrl
              this.lastUploadedCoverSizeMap = merged
              logger.debug('Cover confirmed, sizes:', Object.keys(merged).join(','))
            }
          }
        } catch (e) {
          coverError = (e as Error).message
          logger.warn('Failed to upload cover:', e)
        }
      }

      // 4. 处理正文图片：扫描并上传替换
      // 企鹅号编辑器基于 ProseMirror，使用 HTML 输出更稳妥
      const htmlContent = article.html || ''
      const processedHtml = await this.processImages(
        htmlContent,
        async (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: [
            // 企鹅号自有图床
            'inews.gtimg.com',
            'inews.gtimg.cn',
            'om.gtimg.com',
            'om.gtimg.cn',
            'pnewsapp.gtimg.com',
            // 腾讯系其他 CDN
            'qpic.cn',
            'mmecimage.cn',
            'qq.com',
            'gtimg.com',
            'gtimg.cn',
          ],
          onProgress: options?.onImageProgress,
        }
      )

      // 5. 兜底封面：若正文有图且 cover 上传失败，使用正文首张图
      if (!coverUrl) {
        const firstImg = this.extractFirstImageUrl(processedHtml)
        if (firstImg) coverUrl = firstImg
      }
      if (!coverUrl) {
        throw new Error(
          '企鹅号封面图必填：请提供 article.cover 或确保正文包含至少一张图片'
        )
      }

      // 6. 组装 omSave 请求体（JSON，与浏览器抓包一致）
      // imgurl_ext 必须是 7 个 key 的对象：6 个 om_ls 尺寸 + src
      // 这 7 个 key 都已在上面封面上传 + confirmCover 阶段填充到 lastUploadedCoverSizeMap 里，
      // 这里直接复制即可（不能再只传 src，否则后端不会绑定封面）
      // （真实接口捕获见 腾讯-封面相关接口.txt 第 128 行）
      const coverSizeMap: Record<string, string> = {
        ...(this.lastUploadedCoverSizeMap || {}),
      }
      // src 兜底：上传接口返回的 coverUrl（om_bt 域原图 URL）+ 641 后缀
      if (!coverSizeMap['src'] && coverUrl) {
        coverSizeMap['src'] = coverUrl
      }
      const imgurlExt = JSON.stringify([coverSizeMap])

      // 验证 imgurl_ext 是否齐全，缺失则警告（后端可能拒绝绑定封面）
      const REQUIRED_COVER_KEYS = [
        '1',
        '150120',
        '196130',
        '240180',
        '294195',
        '580300',
        'src',
      ] as const
      const missingKeys = REQUIRED_COVER_KEYS.filter((k) => !coverSizeMap[k])
      if (missingKeys.length > 0) {
        logger.warn(
          `[QQContent] Cover imgurl_ext missing keys: [${missingKeys.join(',')}], ` +
            `have=[${Object.keys(coverSizeMap).join(',')}]`
        )
      }

      // 补充企鹅号编辑器要求的尾巴标记：<div powered-by="ex-editor"></div>
      // （浏览器抓包确认编辑器会自动追加这个 div，我们手工加上避免后端识别不出原文结束位置）
      const contentWithTail = processedHtml.includes('powered-by="ex-editor"')
        ? processedHtml
        : `${processedHtml}<div powered-by="ex-editor"></div>`

      // omSave 请求体 JSON（与浏览器保存草稿请求完全一致）
      const saveBody = {
        title,
        title2: '',
        tag: this.joinTags(article.tags),
        video: '',
        cover_type: '1',
        imgurl_ext: imgurlExt,
        imgurlsrc: 'custom',
        category_id: '',
        content: contentWithTail,
        orignal: 0,
        user_original: 0,
        music: '',
        activity: '',
        apply_olympic_flag: 0,
        apply_push_flag: 0,
        apply_reward_flag: 0,
        reward_flag: 0,
        survey_id: '',
        survey_name: '',
        om_activity_id: '',
        om_activity_name: '',
        activityInfo: '',
        commercialization_source: '',
        caimaiInfo: '',
        isHowto: '0',
        howtoInfo: '',
        daihuoInfo: '',
        novel: '',
        needpub: 1, // 1 = 草稿
        articleId: '', // 每次都让后端生成新草稿 ID（不要跨任务缓存，否则用户手动删除过的 articleId 会撞 -5013）
        event_id: '',
        event_name: '',
        activity_scene_id: 0,
        hotBreak: '',
        // 必填，不传会导致保存失败。固定默认 = 作者声明·无需标注。
        self_declare: SELF_DECLARE_DEFAULT,
        resource_aigc_mark_info: '{}',
        parent_article_id: '',
        conclusion: '',
        summary: '',
        failedImage: [],
        adContentImgs: [],
        mediaId: userInfo.mediaId,
        type: 0,
        relogin: 1,
      }

      logger.debug('omSave request:', {
        url: ARTICLE_SAVE_URL,
        mediaId: userInfo.mediaId,
        title,
        contentLength: processedHtml.length,
        articleId: '(新建，后端生成)',
        imgurl_ext_keys: Object.keys(coverSizeMap).join(','),
        imgurl_ext_missing: missingKeys.join(',') || '(none)',
        imgurl_ext_value: imgurlExt,
      })

      const response = await this.runtime.fetch(ARTICLE_SAVE_URL, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'x-csrf-token': userInfo.csrfToken || '',
        },
        body: JSON.stringify(saveBody),
      })

      const json = await this.parseJsonResponse<OmEditorCacheResp>(response)
      logger.debug('omSave raw:', JSON.stringify(json))
      const norm = normalizeModifyResp(json)
      logger.debug('omSave normalized:', norm)

      if (!isSuccessCode(norm.code)) {
        throw new Error(
          `企鹅号保存草稿失败：code=${norm.code} msg=${norm.msg || '(空)'}`
        )
      }

      // articleId 从响应里拿（omSave 在 articleId 字段为 '' 时由后端生成新草稿）
      if (!norm.articleId) {
        throw new Error(
          '企鹅号保存草稿成功但响应未返回 articleId，请查看 omSave raw 日志'
        )
      }
      const articleId = norm.articleId
      // 草稿编辑入口 URL（重新打开草稿的链接）
      const draftUrl =
        norm.url ||
        `https://om.qq.com/main/creation/article?articleId=${articleId}`

      const baseResult: Partial<SyncResult> = {
        postId: articleId,
        postUrl: draftUrl,
        draftOnly: options?.draftOnly ?? true,
        coverUploaded: !!coverUrl,
        coverUrl,
      }
      if (article.cover && coverError && !coverUrl) {
        baseResult.coverError = coverError
        baseResult.message = '草稿已保存，但封面未生效，请手动到企鹅号后台补传封面'
      }

      return this.createResult(true, baseResult)
    }).catch((error) => {
      logger.error('Publish failed:', error)
      return this.createResult(false, {
        error: (error as Error).message,
      })
    })
  }

  // ============ 图片上传 ============

  /**
   * 上传图片到 image.om.qq.com 图床
   *
   * 接口（基于浏览器抓包）：
   *   POST https://image.om.qq.com/cpom_pimage/ArchacaleUploadViaFile
   *     multipart/form-data 字段：
   *       appid=LA6zXi1lWzAioIzdiAD6iM10aHarlHF6 (固定)
   *       isUpOrg=1
   *       endpoint=1
   *       isRetImgAttr=1
   *       opCode=151
   *       file=<二进制文件>
   *     Headers:
   *       x-csrf-token: <csrfToken cookie> (跨域必带)
   *
   * 响应：{ code:0, message:"success", data:{ url:{ url:"..." } } }
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    // 1. 先确认已登录（拿到 csrfToken）
    if (!this.userInfo) {
      const auth = await this.checkAuth()
      if (!auth.isAuthenticated || !this.userInfo) {
        throw new Error(auth.error || '未登录企鹅号')
      }
    }
    const csrfToken = this.userInfo!.csrfToken

    // 2. 读取图片二进制
    let blob: Blob
    let filename = `${Date.now()}.jpg`

    if (src.startsWith('data:')) {
      const m = src.match(/^data:([^;]+);base64,(.+)$/)
      if (!m) throw new Error('非法 data URI')
      const mime = m[1]
      const binary = atob(m[2])
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      blob = new Blob([bytes], { type: mime })
      const ext = mime.split('/')[1]?.toLowerCase() || 'jpg'
      filename = `${Date.now()}.${ext}`
    } else {
      const encodedSrc = this.encodeUrlPath(src)
      const r = await fetch(encodedSrc)
      if (!r.ok) throw new Error('图片下载失败: ' + src)
      blob = await r.blob()
      const ext = (src.split('.').pop() || 'jpg').split('?')[0].toLowerCase()
      if (/^(jpe?g|png|gif|webp)$/.test(ext)) {
        filename = `${Date.now()}.${ext}`
      }
    }

    // 3. 构造 multipart form-data
    const formData = new FormData()
    formData.append('appid', UPLOAD_APPID)
    formData.append('isUpOrg', '1')
    formData.append('endpoint', '1')
    formData.append('isRetImgAttr', '1')
    formData.append('opCode', '151')
    formData.append('file', blob, filename)

    // 4. POST 到 image.om.qq.com，带 CSRF header
    const headers: Record<string, string> = {}
    if (csrfToken) {
      headers['x-csrf-token'] = csrfToken
    }

    const resp = await this.runtime.fetch(IMAGE_UPLOAD_URL, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: formData,
    })

    if (!resp.ok) {
      throw new Error(`图片上传失败 HTTP ${resp.status}`)
    }

    const json = await this.parseJsonResponse<OmImageUploadResp>(resp)
    if (!isSuccessCode(json.code)) {
      throw new Error(json.message || json.msg || `图床返回 code=${json.code}`)
    }
    const url = json.data?.url?.url
    if (!url) {
      logger.warn('uploadImageByUrl response without url:', json)
      throw new Error('图片上传返回数据不完整')
    }
    // 多尺寸 URL 映射提取：上传响应 size 是 { "0"|"640"|"641"|"1000": { imageUrl, ... } }
    // 提取出 imgurl_ext 用的 { src: <缩略图URL> } 形式
    //   - src 使用 size["641"].imageUrl（如果存在），否则 fallback 到原图
    const sizeMap = json.data?.url?.size || {}
    const sizeUrl641 = sizeMap['641']?.imageUrl
    const sizeUrl1000 = sizeMap['1000']?.imageUrl
    // 返回给 publish 阶段使用的扁平 size 映射（key = imgurl_ext 用的 key）
    const omSizeMap: Record<string, string> = {}
    if (sizeUrl641) omSizeMap['src'] = sizeUrl641
    if (sizeUrl1000) omSizeMap['1000'] = sizeUrl1000
    if (url) omSizeMap['1'] = url
    // src 兜底
    if (!omSizeMap['src']) omSizeMap['src'] = url

    return {
      url,
      attrs: {
        // 企鹅号专有：将 sizes 映射序列化供 publish 阶段取出
        'data-om-sizes': JSON.stringify(omSizeMap),
      },
    }
  }

  /**
   * 从 HTML 中抽取已上传的图片 attr，提取企鹅号多尺寸映射。
   * （用于封面之外的正文图片——但正文图不需要填 imgurl_ext，只留接口以便将来扩展）
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private extractOmSizes(html: string): Record<string, string> | null {
    const m = html.match(/data-om-sizes="([^"]+)"/)
    if (!m) return null
    try {
      return JSON.parse(decodeURIComponent(m[1]))
    } catch {
      return null
    }
  }

  /**
   * 上传图片（公开入口，供 extension bridge 与 CLI 统一调用）
   * 覆盖 CodeAdapter 默认实现：上传后缓存封面多尺寸映射
   */
  async uploadImage(file: Blob, _filename?: string): Promise<string> {
    const dataUri = await this.blobToDataUri(file)
    const result = await this.uploadImageByUrl(dataUri)
    // 提取 size map 缓存起来，供后续 publish 使用
    const sizesAttr = result.attrs?.['data-om-sizes']
    if (typeof sizesAttr === 'string') {
      try {
        this.lastUploadedCoverSizeMap = JSON.parse(sizesAttr)
      } catch {
        // 忽略
      }
    }
    return result.url
  }

  // ============ 辅助方法 ============

  /**
   * 标题规整：去首尾空白、长度裁剪
   * 企鹅号：6-30 字；禁止以 `、` `|` `,` `,` 开头
   */
  private normalizeTitle(title: string): string {
    return String(title || '')
      .trim()
      .replace(/^[、\|,，]+/, '')
      .slice(0, 30)
  }

  /**
   * 拼接标签（逗号分隔，长度不超过 60）
   */
  private joinTags(tags?: string[] | null): string {
    if (!tags || !tags.length) return ''
    return tags
      .map((t) => String(t).trim())
      .filter(Boolean)
      .slice(0, 5)
      .join(',')
      .slice(0, 60)
  }

  /**
   * 从 HTML 中提取第一张图片 URL（用于封面兜底）
   */
  private extractFirstImageUrl(html: string): string {
    const m = html.match(/<img[^>]+src=["']([^"']+)["']/i)
    return m ? m[1] : ''
  }

  /**
   * 确认封面：调用 ListImageUploadViaUrl 让后端生成 om_ls 域多尺寸 URL
   * 响应里 data.url 是 { "1": "...", "150120": "...", "196130": "...", "240180": "...", "294195": "...", "580300": "..." }
   * 这是 imgurl_ext 里要的完整尺寸映射。
   */
  private async confirmCover(imageUrl: string, userInfo: OmUserInfo): Promise<Record<string, string> | null> {
    const url = `${IMAGE_UPLOAD_ORIGIN}/cpom_pimage/ListImageUploadViaUrl`
    try {
      const resp = await this.runtime.fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'x-csrf-token': userInfo.csrfToken || '',
        },
        body: JSON.stringify({
          auth: {
            appid: UPLOAD_APPID,
            endpoint: 1,
          },
          reqData: {
            appid: UPLOAD_APPID,
            isUpOrg: 1,
            endpoint: 1,
            isRetImgAttr: 1,
            opCode: 151,
            imageUrl, // 带 /641 后缀的缩略图 URL
          },
          relogin: 1,
        }),
      })
      if (!resp.ok) {
        logger.warn(`ListImageUploadViaUrl HTTP ${resp.status}`)
        return null
      }
      const json = await this.parseJsonResponse<{
        code?: number | string
        message?: string
        msg?: string
        data?: {
          url?: Record<string, string>
          length?: string
          width?: string | number
          height?: string | number
          type?: number
        }
      }>(resp)
      logger.debug('ListImageUploadViaUrl raw:', JSON.stringify(json))
      if (!isSuccessCode(json.code)) {
        logger.warn('ListImageUploadViaUrl failed:', json.message || json.msg)
        return null
      }
      const sizeMap = json.data?.url
      if (!sizeMap || Object.keys(sizeMap).length === 0) {
        logger.warn('ListImageUploadViaUrl returned empty url map')
        return null
      }
      return sizeMap
    } catch (e) {
      logger.warn('ListImageUploadViaUrl failed (non-fatal):', e)
      return null
    }
  }

  /**
   * 解析 JSON 响应，容错处理空响应或非 JSON
   */
  private async parseJsonResponse<T>(resp: Response): Promise<T> {
    const text = await resp.text()
    if (!text) {
      throw new Error('空响应')
    }
    try {
      return JSON.parse(text) as T
    } catch {
      logger.warn('Non-JSON response:', text.slice(0, 200))
      throw new Error('响应非 JSON: ' + text.slice(0, 80))
    }
  }
}
