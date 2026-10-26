/**
 * 数英网（digitaling.com）适配器
 *
 * 平台资料：
 * - 发布页：https://www.digitaling.com/articles/publish
 * - 草稿箱：https://www.digitaling.com/creator/draft
 * - 草稿编辑页：https://www.digitaling.com/articles/edit/{id}
 * - 文章详情页：https://www.digitaling.com/articles/{id}.html
 *
 * 鉴权（实测 2026-10-26）：
 *   发布页是**服务端渲染**页面，登录态直接体现在 HTML 里：
 *     <input type="hidden" name="loginUserId" value="12549893" id="loginUserId">
 *   未登录访问 /articles/publish 会被 302 到首页（最终 HTML 里没有 loginUserId）。
 *   因此 checkAuth 只需 GET 一次发布页，解析 loginUserId 即可，无副作用。
 *
 * 发布页令牌（服务端下发，每次打开页面都会变）：
 *   <input type="hidden" name="openKey"   id="openKey"   value="<32 位 hex>">
 *   <input type="hidden" name="signature" id="signature" value="<128 字符 base64>">
 *   两者在 `publish.articlesPub()` 里被原样放进提交体，缺任意一个服务端直接回
 *   `{"isSuccess":40,"content":"fuck"}`（实测）。所以适配器**每次发布前都重新抓一次发布页**，
 *   不缓存、不复用旧令牌。
 *   ⚠️ 注意标签属性顺序：openKey 是 `name` → `id` → `value`，loginUserId 是 `name` → `value` → `id`，
 *   正则必须"先定位整个 input 标签、再取 value"，不能假设顺序。
 *
 * 图片上传（实测）：
 *   1. 正文图（UEditor 通道）：POST /datas/ueupload?action=uploadimage
 *        multipart 字段名 `upfile`（UEditor 默认），响应：
 *        {"state":"SUCCESS","url":"https://file.digitaling.com/eImg/uimages/<日期>/<id>.png", ...}
 *        失败时 state 为中文错误串（如"文件类型不允许"），需原样透传。
 *   2. 封面图（站点自有通道）：POST /datas/eupload?dir=cover
 *        multipart 字段名 `imgFile`，响应：
 *        {"error":0,"url":"https://file.digitaling.com/eImg/cover/<日期>/<时间>_<随机>.png","w":640,"h":400}
 *        封面建议尺寸 640×400（发布页提示），但不强制。
 *
 * 保存草稿 / 发布（实测，`publish.js` 的 `articlesPub()` 逐字段复刻）：
 *   POST /datasv2/articlePub （application/x-www-form-urlencoded，jQuery 深度序列化）
 *   body 结构：`datas[title]=...&datas[content]=...&...&openKey=...&signature=...`
 *     - datas[source]：1 = 原创（默认选中项）、2 = 转载（需先上传授权证明）、3 = 译文（需原文链接）
 *       → 适配器固定用 1（原创），转载/译文需要用户在站内补齐额外材料，不适合自动同步。
 *     - datas[reprint]：授权转载选项，编辑器默认 2，原样带上。
 *     - datas[postType]：**0 = 保存草稿**，1 = 提交发布（发布后内容会被锁定且进审核）。
 *     - datas[tags] / hideWords / akIds：关键词三者同源。`art_kws_hidden` 存逗号串，
 *       `hideWords` 也是逗号串，`akIds` 是**每个关键词一个 akid**（站内联想词才有 akid，
 *       手输关键词 akid 为 0）。适配器统一用 0，交给服务端按词面入库。
 *     - datas[describe]：文章摘要，发布页限制 60 个"计数字符"（ASCII 记 0.5，非 ASCII 记 1，向上取整，
 *       与站点 `countHtmlChars()` 一致）；留空服务端会自动截正文首句填充。
 *     - datas[cover]：封面地址，留空则草稿无封面（实测允许）。
 *     - 其余 dm* / class* / collectType / review / lock 等均为编辑器默认值，逐字段保留
 *       （HAR 里 `featureType=NaN` 是编辑器 `parseInt(undefined)` 的产物，PHP 侧等价于 0，这里直接省略）。
 *   响应：
 *     {"isSuccess":1,"content":"1610188"}              → 成功，content 为文章 id
 *     {"isSuccess":0}                                   → 发布失败
 *     {"isSuccess":3,"userType":1}                       → 可发布文章数已用完
 *     {"isSuccess":100,"content":{"KeywordResult":[...]}} → 命中敏感词（列表里是上下文片段）
 *     {"isSuccess":101,"content":"<提示文案>"}            → 业务提示，原样透传
 *     {"isSuccess":40,"content":"fuck"}                  → openKey / signature 校验失败
 *   注意：数英是**审核制**，postType=1 提交后仍需人工审核，不代表立刻公开。
 *
 * 标题长度（站点 `handleTitle()`）：
 *   上限 30 个"计数字符"（ASCII 0.5 / 非 ASCII 1，向上取整，统计时忽略空格）。
 *   服务端实测**不**校验（37 字也接受），但站内编辑器会标红，适配器按 30 截断以保持与网页操作一致。
 *
 * 请求模式：
 *   所有接口同域 www.digitaling.com，通过 headerRules 注入 Origin / Referer 与浏览器内请求对齐
 *   （扩展 SW 直接 fetch 时 Origin 是 chrome-extension://，站点对部分接口有来源校验）。
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Digitaling')

/** 站点 origin（所有接口同域） */
const SITE_ORIGIN = 'https://www.digitaling.com'

/** 文章发布页（服务端渲染，含登录态与 openKey / signature） */
const PUBLISH_PAGE = `${SITE_ORIGIN}/articles/publish`

/** 草稿箱（结果提示用） */
const DRAFT_BOX_URL = `${SITE_ORIGIN}/creator/draft`

/** 正文图片上传（UEditor 通道，字段名 upfile） */
const CONTENT_UPLOAD_URL = `${SITE_ORIGIN}/datas/ueupload?action=uploadimage`

/** 封面图片上传（站点自有通道，字段名 imgFile） */
const COVER_UPLOAD_URL = `${SITE_ORIGIN}/datas/eupload?dir=cover`

/** 保存草稿 / 发布接口 */
const PUBLISH_URL = `${SITE_ORIGIN}/datasv2/articlePub`

/** 正文上传字段名（UEditor 默认值） */
const CONTENT_UPLOAD_FIELD = 'upfile'

/** 封面上传字段名 */
const COVER_UPLOAD_FIELD = 'imgFile'

/** 已是数英图床的地址（无需重复转存） */
const SKIP_IMAGE_PATTERNS = ['file.digitaling.com']

/** 标题上限（站点 countHtmlChars 口径：ASCII 0.5 / 非 ASCII 1，向上取整） */
const TITLE_MAX_UNITS = 30

/** 摘要上限（同上口径） */
const SUMMARY_MAX_UNITS = 60

/** 关键词上限（发布页 `maxLen = 8`） */
const TAGS_MAX_COUNT = 8

/** postType：保存草稿 */
const POST_TYPE_DRAFT = 0

/** postType：提交发布（进审核） */
const POST_TYPE_PUBLISH = 1

/** 文章来源：原创（编辑器默认选中项） */
const SOURCE_ORIGINAL = 1

/** 授权转载选项（编辑器默认值，原样带上） */
const REPRINT_DEFAULT = 2

/** 请求头规则：与站内请求对齐 */
const HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
  {
    urlFilter: '*://www.digitaling.com/*',
    headers: {
      Origin: SITE_ORIGIN,
      Referer: PUBLISH_PAGE,
    },
  },
]

/** 发布页里解析出的上下文（登录态 + 一次性令牌） */
interface DigitalingPageContext {
  /** 登录用户 id；为空表示未登录 */
  loginUserId: string | null
  /** 昵称（发布页头像下拉里的 <b>） */
  userName?: string
  /** 头像地址 */
  avatar?: string
  /** 发布页令牌（每次打开页面都会变） */
  openKey: string
  /** 发布页签名（128 字符 base64） */
  signature: string
}

/** 正文图片上传响应（UEditor 标准格式） */
interface DigitalingUeditorResp {
  state?: string
  url?: string
  title?: string
  original?: string
  [key: string]: unknown
}

/** 封面上传响应 */
interface DigitalingCoverResp {
  error?: number
  url?: string
  w?: number
  h?: number
}

/** 发布响应 */
interface DigitalingPublishResp {
  isSuccess?: number | string
  content?: unknown
  userType?: number
}

export class DigitalingAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'digitaling',
    name: '数英网',
    icon: `${SITE_ORIGIN}/file/images/favicon.ico`,
    homepage: PUBLISH_PAGE,
    capabilities: ['article', 'draft', 'image_upload', 'cover', 'tags'],
  }

  /** 预处理配置：数英编辑器（UEditor）接受 HTML 正文 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  // ============ checkAuth ============

  /**
   * 鉴权：GET 发布页，解析 `loginUserId`。
   *
   * 未登录时发布页会 302 到首页，最终 HTML 里没有 loginUserId；
   * 该检查只读页面、不产生任何副作用，适合批量探测登录态。
   */
  async checkAuth(): Promise<AuthResult> {
    return this.withHeaderRules(HEADER_RULES, async () => {
      try {
        const ctx = await this.fetchPageContext()
        if (!ctx.loginUserId) {
          return {
            isAuthenticated: false,
            error: `请先登录数英网（${PUBLISH_PAGE}）`,
          }
        }
        return {
          isAuthenticated: true,
          userId: ctx.loginUserId,
          username: ctx.userName,
          avatar: ctx.avatar,
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
   * 流程：
   *   1. 抓发布页 → 校验登录态，拿 openKey / signature
   *   2. processImages 上传正文图片（替换为数英图床地址）
   *   3. 封面：article.cover（站外先转存）→ 正文首图 → 留空
   *   4. 摘要：article.summary → 正文纯文本兜底，按 60 计数字符截断
   *   5. 关键词：article.tags（去重、最多 8 个）
   *   6. POST /datasv2/articlePub（postType=0 草稿 / 1 发布）
   */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(HEADER_RULES, async () => {
      logger.info('Starting publish to Digitaling...')

      // 1. 发布页上下文（同时完成登录校验）
      const ctx = await this.fetchPageContext()
      if (!ctx.loginUserId) {
        throw new Error(`请先登录数英网（${PUBLISH_PAGE}）`)
      }
      if (!ctx.openKey || !ctx.signature) {
        throw new Error('未能从数英发布页获取 openKey / signature，请刷新发布页后重试')
      }

      const draftOnly = options?.draftOnly ?? true

      // 2. 标题 / 正文基础校验
      const title = this.truncateByUnits((article.title || '').trim(), TITLE_MAX_UNITS)
      if (!title) {
        throw new Error('标题不能为空，数英网无法保存')
      }

      let content = article.html || ''
      if (!content.trim()) {
        throw new Error('正文内容为空，数英网无法保存')
      }

      // 3. 正文图片转存到数英图床
      try {
        content = await this.processImages(content, src => this.uploadImageByUrl(src), {
          skipPatterns: SKIP_IMAGE_PATTERNS,
          onProgress: options?.onImageProgress,
        })
      } catch (e) {
        logger.warn('[Digitaling] processImages 中途失败，继续发布：', (e as Error).message)
      }

      // 4. 封面：article.cover → 正文首图 → 留空
      let cover = ''
      let coverSource = '无'
      if (article.cover) {
        try {
          cover = await this.uploadCover(article.cover)
          coverSource = '同步来源封面'
          logger.info(`[Digitaling] 封面上传成功：${cover}`)
        } catch (e) {
          logger.warn('[Digitaling] 封面上传失败，尝试使用正文首图：', (e as Error).message)
        }
      }
      if (!cover) {
        const firstImage = this.firstBodyImage(content)
        if (firstImage) {
          cover = firstImage
          coverSource = '正文首图'
          logger.info('[Digitaling] 未提供可用封面，使用正文首图作为封面')
        } else {
          logger.warn('[Digitaling] 无封面可用，cover 为空')
        }
      }

      // 5. 摘要（服务端留空会自动截正文，这里显式给出更可控）
      const summary = this.truncateByUnits(
        (article.summary || '').trim() || this.firstText(content),
        SUMMARY_MAX_UNITS,
      )

      // 6. 关键词
      const tags = this.normalizeTags(article.tags)

      // 7. 提交
      const articleId = await this.submitArticle({
        title,
        content,
        summary,
        cover,
        tags,
        postType: draftOnly ? POST_TYPE_DRAFT : POST_TYPE_PUBLISH,
        openKey: ctx.openKey,
        signature: ctx.signature,
      })

      // 极端情况下服务端成功但没回文章 id：退回草稿箱 / 个人主页，不拼出坏链接
      const postUrl = !articleId
        ? DRAFT_BOX_URL
        : draftOnly
          ? `${SITE_ORIGIN}/articles/edit/${articleId}`
          : `${SITE_ORIGIN}/articles/${articleId}.html`

      logger.info(`[Digitaling] ${draftOnly ? '草稿' : '文章'}已保存：${postUrl}`)

      return this.createResult(true, {
        postId: articleId || undefined,
        postUrl,
        draftOnly,
        coverUploaded: !!cover,
        coverUrl: cover || undefined,
        message: draftOnly
          ? `已保存到数英网草稿箱（${DRAFT_BOX_URL}）；封面来源：${coverSource}；关键词：${
              tags.length > 0 ? tags.join('、') : '无'
            }`
          : `已提交到数英网（${postUrl}），内容需经平台审核后公开；封面来源：${coverSource}`,
      })
    }).catch(error => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  // ============ 图片上传 ============

  /**
   * 图片上传（被 processImages / 图床预上传调用）。
   * 走 UEditor 通道，失败时保留原 URL 不阻断整体同步。
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    try {
      const url = await this.uploadContentImage(src)
      return { url }
    } catch (error) {
      logger.warn('[Digitaling] 正文图片上传失败，保留原 URL:', src, error)
      return { url: src }
    }
  }

  /** 正文图上传：POST /datas/ueupload?action=uploadimage（字段 upfile） */
  private async uploadContentImage(src: string): Promise<string> {
    const blob = await this.loadBlob(src)
    const filename = `image-${this.uniqueName()}.${this.resolveExtension(blob.type, src)}`

    const formData = new FormData()
    formData.append(CONTENT_UPLOAD_FIELD, blob, filename)

    const data = await this.postMultipart<DigitalingUeditorResp>(CONTENT_UPLOAD_URL, formData, {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
    })

    if (data?.state !== 'SUCCESS' || !data.url) {
      throw new Error(`图片上传失败：${data?.state || '响应异常'}`)
    }
    return data.url
  }

  /** 封面上传：POST /datas/eupload?dir=cover（字段 imgFile）→ 返回图床地址 */
  private async uploadCover(src: string): Promise<string> {
    if (this.isSiteCdn(src)) return this.stripQuery(src)

    const blob = await this.loadBlob(src)
    const filename = `cover-${this.uniqueName()}.${this.resolveExtension(blob.type, src)}`

    const formData = new FormData()
    formData.append(COVER_UPLOAD_FIELD, blob, filename)

    const data = await this.postMultipart<DigitalingCoverResp>(COVER_UPLOAD_URL, formData, {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
    })

    if (data?.error !== 0 || !data.url) {
      throw new Error(`封面上传失败：error=${data?.error}`)
    }
    return data.url
  }

  /** 读取图片二进制（支持 data URI 与远程 URL） */
  private async loadBlob(src: string): Promise<Blob> {
    if (src.startsWith('data:')) {
      return this.dataUriToBlob(src)
    }
    const encodedSrc = this.encodeUrlPath(src)
    const response = await fetch(encodedSrc, { credentials: 'omit' })
    if (!response.ok) {
      throw new Error(`图片下载失败 (${response.status}): ${src}`)
    }
    return response.blob()
  }

  // ============ 发布页上下文 ============

  /**
   * 抓发布页并解析登录态与令牌。
   *
   * 未登录时站点会 302 到首页，HTML 里没有 loginUserId —— 此时返回 loginUserId=null，
   * 由调用方决定是提示登录还是直接失败。
   */
  private async fetchPageContext(): Promise<DigitalingPageContext> {
    const resp = await this.runtime.fetch(PUBLISH_PAGE, {
      credentials: 'include',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    })
    if (!resp.ok) {
      throw new Error(`获取数英发布页失败：HTTP ${resp.status}`)
    }
    const html = await resp.text()

    return {
      loginUserId: extractHiddenValue(html, 'loginUserId'),
      userName: extractUserName(html),
      avatar: extractAvatar(html),
      openKey: extractHiddenValue(html, 'openKey') || '',
      signature: extractHiddenValue(html, 'signature') || '',
    }
  }

  // ============ 提交 ============

  /**
   * 提交草稿 / 发布：POST /datasv2/articlePub（form-urlencoded，jQuery 深度序列化格式）。
   * 字段与序列化顺序对齐站点 `publish.articlesPub()`，空值字段也保留 key。
   */
  private async submitArticle(params: {
    title: string
    content: string
    summary: string
    cover: string
    tags: string[]
    postType: number
    openKey: string
    signature: string
  }): Promise<string> {
    const hideWords = params.tags.join(',')
    const akIds = params.tags.map(() => '0').join(',')

    const body = new URLSearchParams()
    const set = (key: string, value: string | number | boolean) => {
      body.append(key, String(value))
    }

    set('datas[title]', params.title)
    set('datas[category]', '')
    set('datas[source]', SOURCE_ORIGINAL)
    set('datas[reprint]', REPRINT_DEFAULT)
    set('datas[describe]', params.summary)
    set('datas[content]', params.content)
    set('datas[tags]', hideWords)
    set('datas[dmTop]', 'false')
    set('datas[publishTime]', '')
    set('datas[cover]', params.cover)
    set('datas[originalUrl]', '')
    set('datas[wechatUrl]', '')
    set('datas[hasVideo]', 'false')
    set('datas[hasCode]', 'false')
    set('datas[dmHome]', 'false')
    set('datas[dmCollect]', 'false')
    set('datas[dmHighlight]', 'false')
    set('datas[dmWriter]', 'false')
    set('datas[dmFeature]', 'false')
    set('datas[dmHeadline]', 'false')
    set('datas[isRank]', 0)
    set('datas[collectType]', 0)
    set('datas[lock]', 0)
    set('datas[review]', 0)
    set('datas[closeComment]', 0)
    set('datas[recComment]', 1)
    set('datas[postType]', params.postType)
    // 课堂（class）相关字段：文章不涉及课堂，全部按编辑器默认 0 / 空串
    set('datas[dmClass]', 0)
    set('datas[classTypeOnline]', 0)
    set('datas[classTypeOffline]', 0)
    set('datas[classTypeNews]', 0)
    set('datas[classArea]', '')
    set('datas[classTime]', '')
    set('datas[classPrice]', '')
    set('datas[classCourseOne]', 0)
    set('datas[classCourseTwo]', 0)
    set('datas[classCityShanghai]', 0)
    set('datas[classCityBeijing]', 0)
    set('datas[classCityGuangzhou]', 0)
    set('datas[classCityShenzhen]', 0)
    set('datas[classCityOther]', 0)
    set('datas[classProgress]', '')
    set('datas[classUrl]', '')
    set('datas[classStatus]', 0)
    set('openKey', params.openKey)
    set('hideWords', hideWords)
    set('akIds', akIds)
    set('signature', params.signature)

    const resp = await this.runtime.fetch(PUBLISH_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body.toString(),
    })

    const text = await resp.text()
    if (!resp.ok) {
      throw new Error(`提交失败：HTTP ${resp.status}: ${text.substring(0, 200)}`)
    }

    let data: DigitalingPublishResp
    try {
      data = JSON.parse(text) as DigitalingPublishResp
    } catch {
      throw new Error(`提交失败：响应非 JSON: ${text.substring(0, 200)}`)
    }

    const code = Number(data.isSuccess)

    if (code === 1) {
      const articleId = String(data.content ?? '')
      if (!articleId || articleId === 'undefined') {
        // 成功但没拿到 id：仍算成功，后续提示用户去草稿箱查看
        logger.warn('[Digitaling] 提交成功但未解析到文章 id')
        return ''
      }
      return articleId
    }

    if (code === 3) {
      throw new Error('数英网账号的可发布文章数已用完，请次日或提升账号权限后重试')
    }
    if (code === 100) {
      throw new Error(`正文命中数英网敏感词，请修改后重试：${this.sensitiveWords(data.content)}`)
    }
    if (code === 40) {
      throw new Error('数英网发布令牌校验失败（openKey / signature 无效），请重试')
    }
    if (code === 101) {
      throw new Error(typeof data.content === 'string' ? data.content : '数英网返回业务提示，提交失败')
    }
    throw new Error(`发布失败：isSuccess=${data.isSuccess ?? '未知'}`)
  }

  /** 敏感词响应里提取命中的上下文片段 */
  private sensitiveWords(content: unknown): string {
    const result = (content as { KeywordResult?: Array<{ KeywordCtx?: string }> } | undefined)?.KeywordResult
    if (!Array.isArray(result) || result.length === 0) return '（未返回具体词）'
    const words = result
      .map(item => (item?.KeywordCtx || '').trim())
      .filter(Boolean)
      .slice(0, 5)
    return words.length > 0 ? words.join(' / ') : '（未返回具体词）'
  }

  // ============ 工具方法 ============

  /** 标题 / 摘要截断：按站点 countHtmlChars 口径（ASCII 0.5、非 ASCII 1，向上取整） */
  private truncateByUnits(text: string, maxUnits: number): string {
    if (!text) return ''
    let units = 0
    let result = ''
    for (const char of text) {
      // 站点统计标题时会先剔除空白，这里同样不计入空白，避免空白挤占配额
      const cost = /\s/.test(char) ? 0 : char.charCodeAt(0) <= 127 ? 0.5 : 1
      if (units + cost > maxUnits) {
        logger.warn(`[Digitaling] 文本超过 ${maxUnits} 个计数字符，已截断`)
        break
      }
      units += cost
      result += char
    }
    return result.trim()
  }

  /** 关键词规范化：去重、去空、最多 8 个 */
  private normalizeTags(tags?: string[]): string[] {
    if (!Array.isArray(tags)) return []
    const result: string[] = []
    for (const raw of tags) {
      if (typeof raw !== 'string') continue
      // 关键词本身不含逗号（逗号是隐藏域的串分隔符）
      for (const piece of raw.split(/[,，]/)) {
        const tag = piece.trim()
        if (!tag) continue
        if (result.includes(tag)) continue
        if (result.length >= TAGS_MAX_COUNT) break
        result.push(tag)
      }
    }
    return result
  }

  /** 去 HTML 标签后的纯文本（摘要兜底） */
  private stripHtml(html: string): string {
    return html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  /** 正文首段文字（摘要兜底） */
  private firstText(content: string): string {
    return this.stripHtml(content)
  }

  /** 取正文中第一张非 data URI 的图片地址（封面兜底） */
  private firstBodyImage(content: string): string | null {
    const re = /<img[^>]+src=["']([^"']+)["']/gi
    let match: RegExpExecArray | null
    while ((match = re.exec(content)) !== null) {
      const src = match[1]
      if (src && !src.startsWith('data:')) return this.stripQuery(src)
    }
    return null
  }

  /** 是否已是数英图床地址 */
  private isSiteCdn(url: string): boolean {
    return SKIP_IMAGE_PATTERNS.some(pattern => url.includes(pattern))
  }

  /** 去掉 URL 的 query / fragment（封面用裸地址） */
  private stripQuery(url: string): string {
    if (url.startsWith('data:')) return url
    return url.split('#')[0].split('?')[0]
  }

  /** 生成短随机名（上传文件名主体） */
  private uniqueName(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  /** 推断上传文件扩展名：优先 blob mime，其次 data URI 的 mime，最后取 URL 后缀 */
  private resolveExtension(blobType: string, src: string): string {
    let mime = (blobType || '').toLowerCase()
    if (!mime && src.startsWith('data:')) {
      mime = src.slice(5, src.indexOf(';')).toLowerCase()
    }
    if (mime.includes('png')) return 'png'
    if (mime.includes('gif')) return 'gif'
    if (mime.includes('webp')) return 'webp'
    if (mime.includes('bmp')) return 'bmp'
    if (mime.includes('svg')) return 'svg'
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'

    const cleaned = src.split('?')[0].split('#')[0]
    const match = cleaned.match(/\.([a-zA-Z0-9]+)$/)
    return match ? match[1].toLowerCase() : 'jpg'
  }
}

// ============ 模块级工具 ============

/**
 * 抽取发布页隐藏域的值。
 *
 * 站点对同一批隐藏域的属性顺序并不统一：
 *   <input type="hidden" name="openKey"   id="openKey"   value="...">
 *   <input type="hidden" name="loginUserId" value="..." id="loginUserId">
 * 所以先按 name/id 定位**整个 input 标签**，再从标签里取 value。
 */
function extractHiddenValue(html: string, field: string): string | null {
  const tagRe = new RegExp(`<input[^>]*(?:name|id)=["']${field}["'][^>]*>`, 'i')
  const tag = html.match(tagRe)?.[0]
  if (!tag) return null
  const value = tag.match(/value=["']([^"']*)["']/i)?.[1]
  return value ?? null
}

/** 昵称：发布页头像下拉里的 `<b class="substr_one">昵称</b>` */
function extractUserName(html: string): string | undefined {
  const match = html.match(/log_info_drop[\s\S]{0,800}?<b class="substr_one">([^<]*)<\/b>/)
  const name = match?.[1]?.trim()
  return name || undefined
}

/** 头像：`<img id="userAvatar" src="...">`（同样先定位标签再取 src，规避属性顺序差异） */
function extractAvatar(html: string): string | undefined {
  const tag = html.match(/<img[^>]*id=["']userAvatar["'][^>]*>/i)?.[0]
  if (!tag) return undefined
  return tag.match(/src=["']([^"']+)["']/i)?.[1] || undefined
}
