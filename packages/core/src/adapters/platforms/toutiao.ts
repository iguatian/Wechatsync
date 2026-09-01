/**
 * 头条号适配器
 *
 * 封面协议（HAR 抓包验证，样本：temporary/mp.toutiao.com.har）
 * - 官方编辑器流程：设置封面 → 弹窗 → 从正文选一张图 → 确定 → 发布。
 * - 选中正文图片后，前端会调用 `POST /mp/agw/article_material/photo/info?app_id=1231`
 *   传入 `{"uris":[...]}` 换取原图 `width/height`（用于封面裁剪框）。
 * - 发布时封面通过 `pgc_feed_covers` 表单字段提交，元素结构：
 *   `{ id, url, uri, ic_uri, thumb_width, thumb_height, extra: { from_content_uri, from_content, from_content_idx } }`
 *   其中 **`uri` 是唯一权威字段**：服务端会忽略/重算 `url`，在响应里按 uri 重新生成封面地址
 *   （回显形如 `https://p0-private.toutiao.com/{uri}~tplv-tt-cs0:540:960.webp`）。
 *   因此只要 uri 正确，封面即可生效，url 只需给出可访问的原图地址。
 * - `thumb_width/thumb_height` 填**原图真实宽高**（不是缩略图尺寸）。
 * - `draft_form_data` 需同步为 `{"coverType":2}`（单图封面）；无封面时为 `{"coverType":3}`。
 * - 封面选取顺序：正文第一张可用图片 > `article.cover`（仅在正文无图时兜底）。
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Toutiao')

/**
 * 正文图片信息（从最终 HTML 中解析得到）
 */
interface ContentImage {
  /** img src */
  src: string
  /** 字节系图片 uri（形如 tos-cn-i-xxxx/<object>），封面核心字段 */
  uri: string
  width: number
  height: number
}

/**
 * 封面信息（对应 pgc_feed_covers 的一个元素）
 */
interface CoverInfo {
  url: string
  uri: string
  width: number
  height: number
  /** 取自正文时的图片序号（0 开始）；-1 表示来自 article.cover */
  index: number
}

export class ToutiaoAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'toutiao',
    name: '头条',
    icon: 'https://sf1-ttcdn-tos.pstatp.com/obj/ttfe/pgcfe/sz/mp_logo.png',
    homepage: 'https://mp.toutiao.com/profile_v4/graphic/publish',
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  /**
   * processImages 静默吞错，本适配器自己把上传失败的图片（主要是 Service Worker
   * fetch 不到的本地图）压到这个数组，publish 末尾汇总到 SyncResult.message 提示用户。
   * 借鉴博客园适配器的失败汇总模式（见 cnblogs.ts:251-267）。
   */
  private failedImages: Array<{ src: string; error: string }> = []

  /** 预处理配置: 头条使用 HTML 格式 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    removeLinks: true,
    removeEmptyImages: true,
    removeDataAttributes: true,
    flattenNestedBold: true,
    unwrapSingleChildSpans: true,
  }

  /** 头条号 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://mp.toutiao.com/*',
      headers: {
        'Origin': 'https://mp.toutiao.com',
        'Referer': 'https://mp.toutiao.com/profile_v4/graphic/publish',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      const res = await this.get<{
        data?: {
          user?: {
            id: string | number
            screen_name?: string
            https_avatar_url?: string
          }
        }
      }>('https://mp.toutiao.com/mp/agw/media/get_media_info')

      logger.debug('checkAuth response:', res)
      if (res.data?.user?.id) {
        return {
          isAuthenticated: true,
          userId: String(res.data.user.id),
          username: res.data.user.screen_name,
          avatar: res.data.user.https_avatar_url,
        }
      }
      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  /**
   * 获取 CSRF Token
   */
  private async getCsrfToken(): Promise<string> {
    const response = await this.runtime.fetch('https://mp.toutiao.com/ttwid/check/', {
      method: 'HEAD',
      credentials: 'include',
      headers: {
        'x-secsdk-csrf-request': '1',
        'x-secsdk-csrf-version': '1.2.22',
      },
    })
    return response.headers.get('x-ware-csrf-token') || ''
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      let content = article.html || ''

      // 移除空的 figure 标签
      content = content.replace(/<figure[^>]*>\s*<\/figure>/gi, '')
      // 压缩多余空行
      content = content.replace(/\n{3,}/g, '\n\n')

      // 处理图片
      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['pstatp.com', 'toutiao.com', 'byteimg.com'],
          onProgress: options?.onImageProgress,
        }
      )

      // 头条发布服务端会校验正文里每一个图片 URL，碰到无法访问的本地图（./xxx、file://、C:/xxx）
      // 会返回 7115 "图片 uri 非法"。借鉴博客园适配器经验：
      //   1. processImages 已经静默吞掉上传错误（base class 设计如此），失败的图仍残留在正文里；
      //   2. 这里先把仍然引用本地路径的 <img> 标签和 ![...](...) 全部剥掉，避免服务端 7115；
      //   3. 失败明细汇总到 SyncResult.message，让用户看到哪些图被丢了以及怎么补。
      content = this.stripLocalImageReferences(content)

      // 包装图片为 pgc-img 结构
      content = content.replace(
        /<img\s+([^>]+)>/gi,
        '<div class="pgc-img"><img $1><p class="pgc-img-caption"></p></div>'
      )

      // 封面：优先取正文第一张可用图片，正文无图时回退 article.cover
      const contentImages = this.parseContentImages(content)
      let { cover, error: coverError } = await this.resolveCover(contentImages, article.cover)

      // 官方抓包（temporary/mp.toutiao.com.har）显示：无论是从正文选封面，还是临时上传一张做封面，
      // 头条发布服务端都要求封面 URI 同时出现在正文 HTML 里，并在 pgc_feed_covers 里带上
      // `extra.from_content=1` 与 `extra.from_content_uri` 。
      // 临时走 article.cover 兜底 + spice/image 上传拿到的 URI 不会同时在正文里出现，
      // 服务端会以 7115 "图片 uri 非法" 拒收。
      // 这里检测到 cover.index === -1 （即刚上传未注入正文）时，补一道插入。
      let coverForFeed = cover
      if (cover && cover.index === -1) {
        const coverAsBodyImage = await this.injectCoverIntoContent(content, cover)
        if (coverAsBodyImage.injected) {
          content = coverAsBodyImage.content
          coverForFeed = { ...cover, index: 0 }
          logger.info(
            'Re-injected fresh-uploaded cover into content so it qualifies as from_content cover:',
            cover.uri,
          )
        } else if (coverAsBodyImage.error) {
          // 注入失败的话还是把原 cover 发出去，错误信息附上
          coverError = coverAsBodyImage.error
        }
      }

      if (coverForFeed) {
        logger.info('Cover resolved:', coverForFeed.uri, `${coverForFeed.width}x${coverForFeed.height}`)
      } else {
        logger.warn('Cover not set:', coverError)
      }
      const covers = this.buildFeedCovers(coverForFeed)

      // 构建发布请求
      const extra = JSON.stringify({
        content_source: 100000000402,
        content_word_cnt: content.length,
        is_multi_title: 0,
        sub_titles: [],
        gd_ext: {
          entrance: '',
          from_page: 'publisher_mp',
          enter_from: 'PC',
          device_platform: 'mp',
          is_message: 0,
        },
      })
      const titleId = `${Date.now()}_${Math.random().toString().slice(2, 18)}`

      const formData = new URLSearchParams()
      formData.append('pgc_id', '0')
      formData.append('source', '29')
      formData.append('extra', extra)
      formData.append('content', content)
      formData.append('title', article.title)
      formData.append('search_creation_info', JSON.stringify({
        searchTopOne: 0,
        abstract: '',
        clue_id: '',
      }))
      formData.append('title_id', titleId)
      formData.append('mp_editor_stat', '{}')
      formData.append('is_refute_rumor', '0')
      formData.append('save', '0')
      formData.append('timer_status', '0')
      formData.append('timer_time', '')
      formData.append('educluecard', '')
      formData.append('draft_form_data', JSON.stringify({ coverType: cover ? 2 : 3 }))
      formData.append('pgc_feed_covers', covers)
      formData.append('article_ad_type', '3')
      formData.append('is_fans_article', '0')
      formData.append('govern_forward', '0')
      formData.append('praise', '0')
      formData.append('disable_praise', '0')
      formData.append('tree_plan_article', '0')
      formData.append('activity_tag', '0')
      formData.append('trends_writing_tag', '0')
      formData.append('claim_exclusive', '0')

      // 头条发布接口需要页面上下文执行 (MAIN world)
      const res = await this.publishViaContentScript(
        'https://mp.toutiao.com/mp/agw/article/publish?source=mp&type=article&aid=1231',
        formData.toString()
      )

      logger.debug('publish response:', res)

      if (res.err_no !== 0 || !res.data?.pgc_id) {
        throw new Error(res.message || '发布失败')
      }

      const postId = res.data.pgc_id
      const postUrl = `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${postId}`

      // 借鉴博客园适配器的失败汇总思路（cnblogs.ts:251-267）：
      // 被本适配器自动从正文剔除的本地图汇总到 message，避免用户看不到原因。
      let extraMessage = ''
      if (this.failedImages.length > 0) {
        const lines = this.failedImages
          .map(f => `  - ${f.src.slice(0, 80)}: ${f.error}`)
          .join('\n')
        extraMessage =
          `草稿已保存，但有 ${this.failedImages.length} 张图片未上传到头条图床：\n${lines}`
        logger.warn(`[Toutiao] 本地图片上传失败汇总：\n${lines}`)
      }

      return this.createResult(true, {
        postId,
        postUrl,
        draftOnly: options?.draftOnly ?? true,
        coverUploaded: !!cover,
        coverUrl: cover?.url || undefined,
        coverError,
        ...(extraMessage ? { message: extraMessage } : {}),
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * 确保存在头条号 tab
   */
  private async ensureToutiaoTab(): Promise<number> {
    if (!this.runtime.tabs) {
      throw new Error('头条发布需要浏览器 tabs API 支持')
    }
    const tabs = await this.runtime.tabs.query('https://mp.toutiao.com/*')
    if (tabs.length > 0 && tabs[0].id) {
      return tabs[0].id
    }
    logger.info('No existing tab found, creating new one...')
    const tab = await this.runtime.tabs.create(
      'https://mp.toutiao.com/profile_v4/graphic/publish',
      false
    )
    await this.runtime.tabs.waitForLoad(tab.id, 30000)
    logger.info('New tab created and loaded:', tab.id)
    return tab.id
  }

  /**
   * 在页面上下文中执行发布请求（头条接口需要 MAIN world fetch）
   */
  private async publishViaContentScript(
    url: string,
    body: string
  ): Promise<{ err_no: number; message?: string; data?: { pgc_id: string } }> {
    if (!this.runtime.tabs) {
      throw new Error('头条发布需要浏览器 tabs API 支持')
    }
    const tabId = await this.ensureToutiaoTab()
    logger.debug('Using tab:', tabId, 'to execute fetch in MAIN world')
    const result = await this.runtime.tabs.executeScript(
      tabId,
      async (requestUrl: string, requestBody: string) => {
        try {
          const response = await fetch(requestUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: requestBody,
            credentials: 'include',
          })
          return { success: true, data: await response.json() }
        } catch (error) {
          return { success: false, error: (error as Error).message }
        }
      },
      [url, body]
    )

    if (!result || !result.success) {
      throw new Error((result as { error?: string })?.error || '发布请求失败')
    }
    return (result as { data: { err_no: number; message?: string; data?: { pgc_id: string } } }).data
  }

  // ============ 发布前完整性检查 ============

  /**
   * 把正文里仍残留的本地相对路径图片剥掉（HTML <img> + Markdown ![](...两种语法）
   *
   * 头条服务端会校验正文里每一个图片 URL，碰到无法访问的本地图（./xxx、file://、C:/xxx）
   * 会返回 7115 "图片 uri 非法"。base class 的 processImages 会静默吞掉上传错误，
   * 失败的图仍残留。借鉴博客园适配器的 `failedImages` 思路：
   *   1. 这里把仍然引用本地路径的 <img> 标签和 ![...](...) 全部剥掉，
   *      让头条服务端至少能完成发布（草稿可以先存下来）；
   *   2. 失败明细压到 `failedImages` 数组，publish 末尾汇总到 SyncResult.message
   *      给用户提示根因 + 怎么修（传 basePath / 上传图床拿 URL）。
   *
   * 注意：传入的 content 可能已经被外层包装过 `<div class="pgc-img">…</div>`，
   * 所以 HTML 分支必须能跨越空白吃完整段。
   */
  private stripLocalImageReferences(html: string): string {
    // HTML <img src="./xxx" …> / file://… / C:\… 或 C:/…
    const localImgRe =
      /<img\b[^>]*?\bsrc=["'](\.\.?\/[^"']+|file:\/\/[^"']+|[A-Za-z]:[\\/][^"']+)["'][^>]*>/gi
    // Markdown ![alt](./xxx) / ![alt](file://…) / ![alt](C:\…)
    const localMdRe =
      /!\[[^\]]*\]\((\.\.?\/[^)\s]+|file:\/\/[^)\s]+|[A-Za-z]:[\\/][^)\s]+)(?:\s+["'][^"']*["'])?\)/g

    let stripped = html

    stripped = stripped.replace(localImgRe, (_full, src) => {
      this.failedImages.push({
        src,
        error:
          '本地相对路径 / file:// / 盘符路径在 Chrome MV3 Service Worker 中 fetch 会失败，' +
          '头条适配器已自动从正文移除此图。请通过 CLI 同步时传入 basePath ' +
          '把本地图转为 data URI，或先把图片上传到公网图床再用 http(s) URL 引用。',
      })
      return ''
    })

    stripped = stripped.replace(localMdRe, (_full, src) => {
      this.failedImages.push({
        src,
        error:
          '本地相对路径 / file:// / 盘符路径在 Chrome MV3 Service Worker 中 fetch 会失败，' +
          '头条适配器已自动从正文移除此图。请通过 CLI 同步时传入 basePath ' +
          '把本地图转为 data URI，或先把图片上传到公网图床再用 http(s) URL 引用。',
      })
      return ''
    })

    // 移除剥离后可能留下的空 <div class="pgc-img">…</div> 与空 <figure>
    stripped = stripped.replace(
      /<div\s+class="pgc-img"\s*>\s*<\/div>/gi,
      '',
    )
    stripped = stripped.replace(/<figure[^>]*>\s*<\/figure>/gi, '')

    // 压缩剥离后残留的多余空行（连续 3+ 换行 → 2）
    stripped = stripped.replace(/\n{3,}/g, '\n\n')

    return stripped
  }
  
  /**
   * 把刚刚通过 spice/image 上传的封面注入正文头部
   *
   * 头条服务端要求 pgc_feed_covers 里的 extra.from_content=1 必须对应正文里真实出现过的
   * 一张图片 URI。通过 spice/image 临时上传拿到的 URI 不在正文里，必须人为补一张。
   * 这里把封面 URI 包成 `<div class="pgc-img"><img ...></div>` 插到正文最前面，
   * 后续 parseContentImages 会把它识别为正文第一张图（index = 0）。
   */
  private injectCoverIntoContent(
    content: string,
    cover: CoverInfo,
  ): { content: string; injected: boolean; error?: string } {
    if (!cover.url) {
      return { content, injected: false, error: '封面 URL 为空，无法注入正文' }
    }

    const imgAttrs = [
      `src="${cover.url}"`,
      `web_uri="${cover.uri}"`,
      cover.width ? `img_width="${cover.width}"` : '',
      cover.height ? `img_height="${cover.height}"` : '',
    ]
      .filter(Boolean)
      .join(' ')

    const injected = `<div class="pgc-img"><img ${imgAttrs}><p class="pgc-img-caption"></p></div>`

    return {
      content: `${injected}\n${content}`,
      injected: true,
    }
  }

  // ============ 图片上传 ============

  /**
   * 从最终 HTML 中按文档顺序解析出所有图片（含 web_uri / 宽高）
   *
   * processImages 会跳过已托管在字节 CDN 上的图片（skipPatterns），这类图片不会走
   * uploadImageByUrl，拿不到 `web_uri`，因此统一从成品 HTML 里反解，保证两种来源都覆盖。
   */
  private parseContentImages(html: string): ContentImage[] {
    const images: ContentImage[] = []
    const imgRegex = /<img\b([^>]*)>/gi
    let match: RegExpExecArray | null

    while ((match = imgRegex.exec(html)) !== null) {
      const attrs = match[1]
      const src = this.getAttr(attrs, 'src')
      if (!src) continue

      // web_uri 由上传接口返回；缺失时尝试从字节系图片 URL 反推 uri
      const uri = this.getAttr(attrs, 'web_uri') || this.extractUriFromUrl(src)

      images.push({
        src,
        uri,
        width: Number(this.getAttr(attrs, 'img_width')) || 0,
        height: Number(this.getAttr(attrs, 'img_height')) || 0,
      })
    }

    return images
  }

  /**
   * 读取 img 标签上的属性值
   */
  private getAttr(attrs: string, name: string): string {
    const match = attrs.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'))
    return match ? match[1] : ''
  }

  /**
   * 从字节系图片 URL 反推 uri（`tos-<region>-<bucket>/<object>`）
   *
   * 例：`https://p3.toutiaoimg.com/tos-cn-i-6w9my0ksvp/abc123~tplv-obj.jpg?x=y`
   *  → `tos-cn-i-6w9my0ksvp/abc123`
   */
  private extractUriFromUrl(url: string): string {
    if (!url || url.startsWith('data:')) return ''
    const match = url.match(/\/\/[^/]+\/(tos-[^/]+\/[^~?#]+)/i)
    return match ? match[1] : ''
  }

  /**
   * 确定封面：正文第一张可用图片优先，正文无图时用 article.cover 兜底
   */
  private async resolveCover(
    contentImages: ContentImage[],
    fallbackCover?: string
  ): Promise<{ cover: CoverInfo | null; error?: string }> {
    // 1. 正文取图（与官方编辑器「从正文选择」一致）
    const index = contentImages.findIndex(img => !!img.uri)
    if (index >= 0) {
      const picked = contentImages[index]
      const dims = (picked.width && picked.height)
        ? { width: picked.width, height: picked.height }
        : await this.fetchPhotoInfo(picked.uri)
      return {
        cover: {
          url: picked.src,
          uri: picked.uri,
          width: dims?.width || 0,
          height: dims?.height || 0,
          index,
        },
      }
    }

    if (!fallbackCover) {
      return { cover: null, error: '正文与 article.cover 均无可用图片，跳过封面设置' }
    }

    // 2. 兜底：article.cover。若已是字节系图片则直接复用 uri，否则先上传
    const existingUri = this.extractUriFromUrl(fallbackCover)
    if (existingUri) {
      const dims = await this.fetchPhotoInfo(existingUri)
      return {
        cover: {
          url: fallbackCover,
          uri: existingUri,
          width: dims?.width || 0,
          height: dims?.height || 0,
          index: -1,
        },
      }
    }

    try {
      const uploaded = await this.uploadImageByUrl(fallbackCover)
      const uri = uploaded.attrs?.web_uri
        ? String(uploaded.attrs.web_uri)
        : this.extractUriFromUrl(uploaded.url)
      if (!uri) {
        return { cover: null, error: '封面图上传成功但未返回 uri' }
      }
      return {
        cover: {
          url: uploaded.url,
          uri,
          width: Number(uploaded.attrs?.img_width) || 0,
          height: Number(uploaded.attrs?.img_height) || 0,
          index: -1,
        },
      }
    } catch (error) {
      return { cover: null, error: `封面图上传失败: ${(error as Error).message}` }
    }
  }

  /**
   * 查询图片素材信息（原图宽高）
   *
   * 官方编辑器在选中正文图片后会调用该接口取宽高用于封面裁剪框，
   * 这里用于补齐 `thumb_width/thumb_height`。失败时降级为 0，不影响主流程。
   */
  private async fetchPhotoInfo(uri: string): Promise<{ width: number; height: number } | null> {
    try {
      const csrfToken = await this.getCsrfToken()
      const res = await this.postJson<{
        code?: number
        infos?: Record<string, { width?: number; height?: number }>
      }>(
        'https://mp.toutiao.com/mp/agw/article_material/photo/info?app_id=1231',
        { uris: [uri] },
        { 'x-secsdk-csrf-token': csrfToken }
      )

      const info = res?.infos?.[uri]
      if (info?.width && info?.height) {
        return { width: info.width, height: info.height }
      }
      logger.warn('photo/info 未返回有效尺寸:', uri, res)
    } catch (error) {
      logger.warn('photo/info 请求失败，封面尺寸降级为 0:', error)
    }
    return null
  }

  /**
   * 构造 pgc_feed_covers 表单值
   *
   * `uri` 是服务端唯一认的字段（响应会按 uri 重新生成 url），
   * `extra.from_content*` 用于标记封面来自正文，与官方抓包保持一致。
   */
  private buildFeedCovers(cover: CoverInfo | null): string {
    if (!cover) return '[]'

    const fromContent = cover.index >= 0
    return JSON.stringify([
      {
        id: Date.now() + Math.random(),
        url: cover.url,
        uri: cover.uri,
        ic_uri: '',
        thumb_width: cover.width,
        thumb_height: cover.height,
        extra: fromContent
          ? {
              from_content_uri: cover.uri,
              from_content: '1',
              from_content_idx: String(cover.index + 1),
            }
          : {},
      },
    ])
  }

  /**
   * 通过 URL 上传图片
   *
   * 支持的入参：
   *   - http(s) URL：原样 fetch 后上传（同样受 Service Worker fetch 限制，仅能取 CORS 友好的源）
   *   - data URI：手动解码为 Blob 后上传（避开 `fetch(data:...)` 在 SW 中的不一致行为）
   *
   * 不支持的入参：
   *   - 本地相对路径（./cover-long.jpg、../assets/x.png 等）
   *   - file:// URL
   *   - Windows 盘符路径（C:\... 或 C:/...）
   *
   * 上面这几类无法在 Chrome MV3 Service Worker 中 fetch，会得到笼统的
   * `TypeError: Failed to fetch`，让上游（CLI / MCP）误以为服务端异常。
   * 这里把它们在适配器层就拦下来，抛出可执行的错误并提示调用方提前处理。
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const isHttp = /^https?:\/\//i.test(src)
    const isData = src.startsWith('data:')

    if (!isHttp && !isData) {
      // 本地相对路径 / file:// / 盘符路径 —— SW 拿不到，跳过 fetch 直接报错
      throw new Error(
        `头条适配器无法处理本地图 "${src}"：Chrome MV3 Service Worker 不允许 fetch ` +
          `相对路径或 file:// URL。请通过 CLI 同步时传入 basePath 把本地图内嵌为 ` +
          `data URI，或直接提供完整 http(s) URL。`,
      )
    }

    // 取图片二进制
    let imageBlob: Blob
    if (isData) {
      imageBlob = await this.dataUriToBlob(src)
    } else {
      const imageResponse = await this.runtime.fetch(src, {
        // 头条图床代理读取外站图片，不应携带用户头条 cookie，避免把会话带到第三方
        credentials: 'omit',
      })
      if (!imageResponse.ok) {
        throw new Error(`图片下载失败 HTTP ${imageResponse.status}: ${src}`)
      }
      imageBlob = await imageResponse.blob()
    }

    const csrfToken = await this.getCsrfToken()
    const formData = new FormData()
    formData.append('image', imageBlob, 'image.jpg')

    const uploadResponse = await this.runtime.fetch(
      'https://mp.toutiao.com/spice/image?upload_source=20020002&aid=1231&device_platform=web',
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'x-secsdk-csrf-token': csrfToken,
        },
        body: formData,
      }
    )

    const uploadText = await uploadResponse.text()
    let res: {
      code?: number
      message?: string
      data?: {
        image_url?: string
        image_uri?: string
        image_width?: number
        image_height?: number
      }
    }
    try {
      res = JSON.parse(uploadText)
    } catch {
      throw new Error('图片上传响应解析失败')
    }

    logger.debug('Image upload response:', res)

    if (res.code !== 0 || !res.data) {
      throw new Error(res.message || '图片上传失败')
    }
    if (!res.data.image_url || !res.data.image_uri) {
      logger.error('Upload response missing URL:', res)
      throw new Error('图片上传返回数据不完整')
    }

    return {
      url: res.data.image_url,
      attrs: {
        class: '',
        'ic-uri': '',
        image_type: 'image/png',
        mime_type: '',
        web_uri: res.data.image_uri,
        img_width: String(res.data.image_width || 0),
        img_height: String(res.data.image_height || 0),
      },
    }
  }
}