/**
 * 海报新闻 · 海报号（山东）适配器
 *
 * 平台资料：
 * - 创作者后台（海报号）：http://mp.dzwww.com/
 * - 发文章编辑器：http://mp.dzwww.com/article/edit
 * - 草稿详情（编辑器带 id）：http://mp.dzwww.com/article/edit?id=<id>
 * - 文章管理（草稿箱）：http://mp.dzwww.com/article/lists?status=draft
 *
 * ⚠️ 本站是**传统服务端渲染站点（SSR）+ 原生表单提交**，不是 SPA：
 *   编辑器页面 `article/edit` 里的 `<form method="post" action="/article/edit">` 直接
 *   提交，服务端处理完 302 跳回 `/article/lists`，**响应里不带文章 id**，
 *   所以草稿地址只能提交成功后回到草稿列表页里解析（见 `findLatestDraftId`）。
 *
 * 鉴权（CDP 实测）：
 *   登录态是 Cookie（可见的 `userinfo` / `cookieid` / `wdcid`），站点前端所有接口都是
 *   同源请求。未登录访问 `/article/edit` 会被 302 重定向到首页 `http://mp.dzwww.com/`，
 *   页面里**没有**发文章表单；已登录则返回带 `name="content"` 表单的完整编辑页
 *   （约 36KB HTML，页头含 `<img ...><span>昵称</span></a>` 与 `/user/logout` 链接）。
 *   本适配器就以此作为 checkAuth 判据（不额外依赖某个具体 cookie 名）。
 *
 * 图片上传（UEditor，实测成功响应）：
 *   POST /ueditor?action=uploadimage&encode=utf-8   （multipart/form-data）
 *     字段名 `upfile`（UEditor 后端配置 `/ueditor?action=config` 的 `imageFieldName`）
 *     → { "state":"SUCCESS", "url":"http://mp.dzwww.com/mpfiles/202609/29/738650699882.png",
 *         "title":"", "original":"", "type":"", "size":"" }
 *     失败时 `state` 为错误文案（如 "error"），`url` 为空。
 *   URL 前缀（imageUrlPrefix）为空串，返回的 url 已是完整地址，正文直接使用。
 *   允许格式 .png/.jpg/.jpeg/.gif/.bmp，单文件 ≤ 10MB（imageMaxSize）。
 *
 * 保存草稿（CDP 实测抓到的真实提交体，application/x-www-form-urlencoded）：
 *   POST /article/edit
 *     status=draft                 // draft=存草稿、pass=发布（编辑器的 set_form(status)）
 *     title=<标题>                 // 编辑器校验 5~60 字
 *     content=<UEditor 的 HTML>    // 编辑器校验非空且 ≥10 字符
 *     upload=&thumb=<封面地址>&thumb_file=&vurl=&copyfrom=<创作来源>
 *   → 302 跳转 /article/lists（成功即列表里出现该草稿）
 *   ⚠️ `copyfrom`（创作来源）是必填项，可选值就是选项文本：
 *      「内容由AI生成 / 素材来源官方媒体/网络新闻 / 内容剧情演绎，仅供娱乐 /
 *        个人观点，仅供参考 / 不声明」；本适配器默认提交「不声明」。
 *   封面 `thumb` 是**已上传图片的地址**（`thumb_file` 只是上传用的 file 输入框），
 *   所以封面复用同一个 UEditor 上传接口拿地址即可。
 *
 * 草稿地址解析（实测列表 HTML）：
 *   GET /article/lists?status=draft 是服务端渲染的 HTML，每条形如：
 *     <li class="sty3" id="sc3"><div class="text">
 *       <h3><a href="http://mp.dzwww.com/article/preview?id=XXX" title="标题">标题</a></h3>
 *       ...
 *       <a href="http://mp.dzwww.com/article/edit?id=XXX">修改</a>
 *   取 `<h3><a ... title="…">` 与同一块里的 `article/edit?id=…` 即可拿到草稿 id
 *   （新草稿排在最前，标题匹配优先，匹配不到退化为第一条）。
 *
 * 请求模式：
 * - 全部接口同域（http://mp.dzwww.com），扩展 SW 依赖 host_permissions 直连并带 Cookie；
 *   这里再用 headerRules 注入 `Origin` / `Referer`，与浏览器发起表单/上传时保持一致。
 * - ⚠️ 站点是 **http（非 https）**，manifest 的 host_permissions 已全量放开 http(s)，无需加域。
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Haibao')

/** 站点 origin（普通 http，全部接口同域） */
const SITE_ORIGIN = 'http://mp.dzwww.com'

/** 发文章 / 存草稿接口（同一个 action；更新已有草稿时 id 走 query） */
const EDIT_URL = `${SITE_ORIGIN}/article/edit`

/** 文章管理页（存草稿成功后服务端 302 的落点） */
const LISTS_URL = `${SITE_ORIGIN}/article/lists`

/** 草稿箱列表（草稿地址解析用） */
const DRAFT_LIST_URL = `${LISTS_URL}?status=draft`

/** UEditor 图片上传接口（后端配置 imageActionName=uploadimage） */
const UEDITOR_UPLOAD_URL = `${SITE_ORIGIN}/ueditor?action=uploadimage&encode=utf-8`

/** UEditor 上传字段名（后端配置 imageFieldName=upfile） */
const UPLOAD_FIELD_NAME = 'upfile'

/** 表单状态值：存草稿（编辑器 `set_form('draft')`） */
const STATUS_DRAFT = 'draft'

/** 表单状态值：发布（编辑器 `set_form('pass')`，本适配器不使用） */
const STATUS_PUBLISH = 'pass'

/** 创作来源默认值（`copyfrom` 必填，可选值即选项文本） */
const DEFAULT_COPY_FROM = '不声明'

/** 标题长度限制（编辑器校验：5~60 字） */
const TITLE_MIN_LENGTH = 5
const TITLE_MAX_LENGTH = 60

/** 正文长度限制（编辑器校验：非空且 ≥10 字符） */
const CONTENT_MIN_LENGTH = 10

/** 已是平台图床的地址（无需重复转存） */
const SKIP_IMAGE_PATTERNS = ['mp.dzwww.com/mpfiles']

/** 请求头规则：与浏览器发起表单 / UEditor 上传时对齐 */
const HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
  {
    urlFilter: '*://mp.dzwww.com/*',
    headers: {
      Origin: SITE_ORIGIN,
      Referer: EDIT_URL,
    },
  },
]

/** UEditor 上传响应 */
interface UeditorUploadResp {
  state?: string
  url?: string
  title?: string
  original?: string
  error?: string
}

/** 草稿列表项 */
interface HaibaoDraftItem {
  id: string
  title: string
}

export class HaibaoAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'haibao',
    name: '海报号',
    icon: `${SITE_ORIGIN}/favicon.ico`,
    homepage: EDIT_URL,
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  /** 预处理配置：海报号编辑器（UEditor）接受 HTML 正文 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  // ============ checkAuth ============

  /**
   * 鉴权：请求发文章编辑器页，能拿到表单即已登录。
   *
   * 判据（实测）：未登录会被 302 到首页，最终 HTML 里没有 `name="content"`；
   * 已登录的编辑页含完整表单，并可从中提取昵称与头像。
   * 不做任何副作用操作（不新建 tab），适合批量检查登录态。
   */
  async checkAuth(): Promise<AuthResult> {
    return this.withHeaderRules(HEADER_RULES, async () => {
      try {
        const resp = await this.runtime.fetch(EDIT_URL, {
          credentials: 'include',
          headers: { Accept: 'text/html,application/xhtml+xml,*/*' },
        })
        const html = await resp.text()

        if (!resp.ok || !isEditorHtml(html)) {
          return {
            isAuthenticated: false,
            error: `请先登录海报号（${SITE_ORIGIN}/）`,
          }
        }

        const profile = parseProfile(html)
        return {
          isAuthenticated: true,
          username: profile.nickname,
          avatar: profile.avatar,
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
   * 流程（CDP 实测）：
   *   1. 登录校验（未登录直接给明确提示）
   *   2. 正文图片转存到站点图床（UEditor 上传接口）
   *   3. 封面：article.cover → 上传拿地址（无则留空）
   *   4. POST /article/edit（status=draft）→ 302 到文章管理页
   *   5. 从 /article/lists?status=draft 解析出草稿 id，拼出草稿地址
   */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(HEADER_RULES, async () => {
      logger.info('Starting publish to Haibao...')

      const auth = await this.checkAuth()
      if (!auth.isAuthenticated) {
        throw new Error(auth.error || `请先登录海报号（${SITE_ORIGIN}/）`)
      }

      const draftOnly = options?.draftOnly ?? true

      // 1. 标题：编辑器要求 5~60 字，超长截断
      const title = this.normalizeTitle(article.title)

      // 2. 正文图片转存
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
        logger.warn('[Haibao] processImages 中途失败，继续提交：', (e as Error).message)
      }

      // 3. 正文长度校验（编辑器要求非空且 ≥10 字符）
      const textLength = this.stripHtml(content).length
      if (textLength < CONTENT_MIN_LENGTH) {
        throw new Error(`正文纯文本不足 ${CONTENT_MIN_LENGTH} 字，海报号无法提交`)
      }

      // 4. 封面：article.cover 上传后拿地址（编辑器里 thumb 就是图片地址）
      let cover = ''
      let coverError: string | undefined
      if (article.cover) {
        try {
          cover = await this.resolveCoverUrl(article.cover)
          logger.info(`[Haibao] 封面处理成功：${cover}`)
        } catch (e) {
          coverError = (e as Error).message
          logger.warn('[Haibao] 封面处理失败，留空提交：', coverError)
        }
      } else {
        logger.warn('[Haibao] 未提供封面（article.cover），thumb 留空')
      }

      // 5. 提交表单（status=draft 即存草稿）
      await this.submitPost({
        title,
        content,
        cover,
        status: draftOnly ? STATUS_DRAFT : STATUS_PUBLISH,
      })

      // 6. 解析草稿地址
      const draftId = await this.findLatestDraftId(title)
      const postUrl = draftId ? `${EDIT_URL}?id=${draftId}` : DRAFT_LIST_URL
      logger.info(`[Haibao] ${draftOnly ? '草稿' : '文章'}已提交：${postUrl}`)

      return this.createResult(true, {
        postId: draftId || undefined,
        postUrl,
        draftOnly,
        coverUploaded: !!cover,
        coverUrl: cover || undefined,
        ...(coverError ? { coverError } : {}),
        message: draftOnly
          ? `已保存到海报号草稿（${postUrl}），草稿箱：${DRAFT_LIST_URL}`
          : `已提交到海报号（文章管理：${LISTS_URL}）`,
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
      const url = await this.uploadImageToHaibao(src)
      return { url }
    } catch (error) {
      logger.warn('[Haibao] 正文图片上传失败，保留原 URL:', src, error)
      return { url: src }
    }
  }

  /**
   * 上传单张图片到海报号图床（正文 / 封面共用）。
   * UEditor 接口，multipart 字段名 `upfile`，响应 `state === 'SUCCESS'` 时取 `url`。
   */
  private async uploadImageToHaibao(src: string): Promise<string> {
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

    const resp = await this.runtime.fetch(UEDITOR_UPLOAD_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: '*/*',
        Referer: EDIT_URL,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: formData,
    })

    const text = await resp.text()
    if (!resp.ok) {
      throw new Error(`图片上传失败：HTTP ${resp.status}: ${text.substring(0, 200)}`)
    }

    let data: UeditorUploadResp
    try {
      data = JSON.parse(text) as UeditorUploadResp
    } catch {
      throw new Error(`图片上传失败：响应非 JSON (HTTP ${resp.status}): ${text.substring(0, 200)}`)
    }

    if (data.state !== 'SUCCESS' || !data.url) {
      throw new Error(
        `图片上传失败：${data.error || data.state || '未知错误'}${
          data.state === 'ERROR' ? '（登录态可能已失效）' : ''
        }`,
      )
    }
    return data.url
  }

  /**
   * 封面地址：站外图片先转存到站点图床；已是平台图床的地址直接用。
   * 编辑器里 `thumb` 就是图片地址（`thumb_file` 只是上传框），故不需要额外裁剪。
   */
  private async resolveCoverUrl(src: string): Promise<string> {
    if (this.isPlatformCdn(src)) return src
    return await this.uploadImageToHaibao(src)
  }

  // ============ 提交 ============

  /**
   * 提交表单：POST /article/edit（application/x-www-form-urlencoded）。
   *
   * 字段与顺序对齐浏览器真实提交体（见文件头说明）；
   * `upload` / `thumb_file` 是文件输入框，表单提交时为空字符串，这里同样带上。
   */
  private async submitPost(params: {
    title: string
    content: string
    /** 封面地址（无封面为空串） */
    cover: string
    /** `draft` 存草稿 / `pass` 发布 */
    status: string
  }): Promise<void> {
    const body = new URLSearchParams()
    body.append('status', params.status)
    body.append('title', params.title)
    body.append('content', params.content)
    body.append('upload', '')
    body.append('thumb', params.cover)
    body.append('thumb_file', '')
    body.append('vurl', '')
    body.append('copyfrom', DEFAULT_COPY_FROM)

    const resp = await this.runtime.fetch(EDIT_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html,application/xhtml+xml,*/*',
        Referer: EDIT_URL,
      },
      body: body.toString(),
    })

    // 成功时会 302 到 /article/lists（fetch 默认跟随），最终落到文章管理页；
    // 未登录会被踢回首页，此时 final url 不含 /article/lists。
    const finalUrl = resp.url || ''
    const html = await resp.text()

    if (isLoginPage(html) || !finalUrl.includes('/article/lists')) {
      throw new Error(
        `提交失败：未登录或登录态已失效（final=${finalUrl || 'unknown'}），请先登录海报号后重试`,
      )
    }
    logger.debug('[Haibao] 表单提交成功，最终页面：', finalUrl)
  }

  /**
   * 从草稿列表解析刚保存的草稿 id（提交响应不带 id）。
   *
   * 列表按时间倒序，优先按标题精确匹配，匹配不到退化为第一条；
   * 解析失败返回 null（调用方回退到草稿箱列表地址）。
   */
  private async findLatestDraftId(title: string): Promise<string | null> {
    try {
      const resp = await this.runtime.fetch(DRAFT_LIST_URL, {
        credentials: 'include',
        headers: { Accept: 'text/html,application/xhtml+xml,*/*', Referer: LISTS_URL },
      })
      if (!resp.ok) return null

      const items = parseDraftItems(await resp.text())
      if (items.length === 0) {
        logger.warn('[Haibao] 草稿列表为空，无法解析草稿地址')
        return null
      }

      const hit = items.find((item) => item.title === title) || items[0]
      if (hit.title !== title) {
        logger.warn(`[Haibao] 未按标题匹配到草稿，回退取最新一条：${hit.title}`)
      }
      return hit.id
    } catch (error) {
      logger.warn('[Haibao] 解析草稿地址失败：', (error as Error).message)
      return null
    }
  }

  // ============ 工具方法 ============

  /** 标题规范化：超长截断到平台上限（不足下限由服务端裁决） */
  private normalizeTitle(title: string): string {
    const trimmed = (title || '').trim()
    if (trimmed.length > TITLE_MAX_LENGTH) {
      logger.warn(`[Haibao] 标题超过 ${TITLE_MAX_LENGTH} 字，已截断`)
      return trimmed.slice(0, TITLE_MAX_LENGTH)
    }
    if (trimmed.length < TITLE_MIN_LENGTH) {
      logger.warn(`[Haibao] 标题不足 ${TITLE_MIN_LENGTH} 字，平台可能拒绝提交`)
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

  /** 是否已是站点图床地址 */
  private isPlatformCdn(url: string): boolean {
    return SKIP_IMAGE_PATTERNS.some((pattern) => url.includes(pattern))
  }

  /** 生成短随机名（上传文件名主体） */
  private uniqueName(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * 推断上传文件扩展名：优先用 blob 的 mime，其次取原 URL 后缀。
   * 站点图床按上传文件名后缀产出对象名。
   */
  private resolveExtension(blobType: string, src: string): string {
    const mime = (blobType || '').toLowerCase()
    if (mime.includes('png')) return 'png'
    if (mime.includes('gif')) return 'gif'
    if (mime.includes('bmp')) return 'bmp'
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'

    const cleaned = src.split('?')[0].split('#')[0]
    const match = cleaned.match(/\.([a-zA-Z0-9]+)$/)
    const ext = match ? match[1].toLowerCase() : ''
    if (['png', 'jpg', 'jpeg', 'gif', 'bmp'].includes(ext)) return ext
    return 'jpg'
  }
}

// ============ 模块级工具 ============

/**
 * 是否为已登录的发文章编辑器页。
 *
 * ⚠️ 判据只用稳定的特征（正文域 + 表单 action），**不要**依赖属性引号形式：
 * 该页标题输入框是 `<input type='text' name='title' id='title' …/>`（**单引号**），
 * 最初写成 `includes('id="title"')` 导致永远判为未登录（实测踩过）。
 */
function isEditorHtml(html: string): boolean {
  return /name=["']?content["']?/.test(html) && html.includes('/article/edit')
}

/** 是否被踢回登录相关页面（首页无表单，另做一次显式判断便于给出准确提示） */
function isLoginPage(html: string): boolean {
  return !html.includes('name="content"') && /\/user\/login|name="userpass"|用户登录/.test(html)
}

/**
 * 从编辑页 HTML 里取昵称与头像。
 *
 * 页头结构（实测，用户区在 `/user/logout` 之前）：
 *   `<a href="http://mp.dzwww.com/mp/profile" class="name">
 *      <img src="http://mp.dzwww.com/mpfiles/…/xxx.jpeg" /><span>瓜田</span></a>`
 * 昵称取 `<img …><span>昵称</span>` 配对；取不到时退化为页面第一个
 * `<span>昵称</span></a>`（页面第一个 span 就是用户名）。
 */
function parseProfile(html: string): { nickname?: string; avatar?: string } {
  const logoutIdx = html.indexOf('/user/logout')
  // 用户区在退出链接之前，截一段范围缩小误匹配
  const scope = logoutIdx > 0 ? html.slice(Math.max(0, logoutIdx - 3000), logoutIdx) : html

  const pair = scope.match(/<img[^>]+src="([^"]+)"\s*\/?>\s*<span>([^<]{1,30})<\/span>/)
  if (pair) {
    return { nickname: pair[2].trim() || undefined, avatar: pair[1] }
  }

  const span = scope.match(/<span>([^<]{1,30})<\/span>\s*<\/a>/)
  return { nickname: span ? span[1].trim() || undefined : undefined }
}

/**
 * 解析草稿列表 HTML。
 *
 * 每条记录形如：
 *   <li class="sty3" id="sc3"><div class="text">
 *     <h3><a href="…/article/preview?id=XXX" title="标题">标题</a></h3>
 *     … <a href="http://mp.dzwww.com/article/edit?id=XXX">修改</a>
 * 这里以 `<h3><a ... title="…">` 为起点，向后找同一块的 `article/edit?id=…`。
 */
function parseDraftItems(html: string): HaibaoDraftItem[] {
  const items: HaibaoDraftItem[] = []
  const re = /<h3>\s*<a[^>]*title="([^"]*)"[^>]*>[\s\S]{0,2000}?article\/edit\?id=([A-Za-z0-9]+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null) {
    items.push({ title: decodeEntities(match[1]), id: match[2] })
  }
  return items
}

/** 反转义 HTML 实体（标题里常见 &amp; / &#39;） */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}
