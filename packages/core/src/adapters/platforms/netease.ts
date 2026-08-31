/**
 * 网易号（mp.163.com）适配器
 *
 * 平台资料：
 * - 创作者后台：https://mp.163.com/
 * - 文章编辑器：https://mp.163.com/subscribe_v4/index.html
 * - 鉴权接口：`/wemedia/navinfo.do` —— 已登录返回 {code:1, data:{tid, tname, icon, realUserId}}
 * - 内容图上传（HAR 验证）：`POST /api/v3/upload/picupload`，multipart/form-data
 *   字段 `file`(binary) + `from=neteasecode_mp` + `logotext=<作者名>`
 *   响应：`{code:200, msg:"succ", data:{url, pid, width, height}}`
 * - 封面图入库（HAR 验证）：`GET /wemedia/material/picture/addPic.do?picUrl=<url>&watermarkUrl=<url>&title=上传图片&state=1&source=publish`
 *   响应：`{code:1, data:{picId, picUrl, watermarkUrl, ...}}`
 * - 易盾反爬：`POST https://ir-sdk.dun.163.com/v4/j/up` —— 服务端在每次发布前会主动调用，
 *   客户端 SW fetch 必须 `credentials: include` 让 cookie 透传给网易域；这里仍按
 *   真实编辑器逻辑使用 withHeaderRules 在 fetch 链路上注入 Origin/Referer。
 * - 文章保存：`POST /wemedia/article/status/api/publishV2.do?_=<ts>&wemediaId=<tid>&realUserId=<realUserId>`
 *   form-urlencoded：`wemediaId`/`articleId`(-1 新建 / docId 更新)/`title`/`content`/`cover=custom`/
 *   `operation=saveDraft`/`scheduled=0`/`onlineState=1`/`ursToken`/`original=0`/`subjectId=''`/`picUrl=<封面URL>`
 *   响应：`{code:1, data:"docId=<id>&pkId=null"}`
 * - 关键真实流程（mp.163.com.har + mp.163-select-img.com.har 双重验证）：
 *   ① publishV2(articleId=-1) 拿到 docId（空内容，封面 picUrl=''）
 *   ② picupload 上传封面图，拿到 http://dingyue.ws.126.net/... URL
 *   ③ 把封面图作为 content 第一段插入（HTML 形式：<img src=... alt _src=... contenteditable=false />）
 *   ④ publishV2(articleId=docId, cover='custom', picUrl=<封面URL>) 完整保存
 *
 * 与其他平台的差异：
 * - 网易号的「封面图」不是 publishV2 的独立字段，而是 content 里第一段的 <img>，因此必须
 *   把封面插到正文最前面。
 * - 上传封面必须走 /api/v3/upload/picupload（不是 /wemedia/article/api/uploadCoverImage.do），
 *   后者的响应结构和 picupload 完全不一样。
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Netease')

interface NeteaseAccountInfo {
  tid: string | number
  tname?: string
  icon?: string
  realUserId?: string
}

interface NeteaseUploadResult {
  url: string
  pid?: string
  width?: number
  height?: number
}

export class NeteaseAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'netease',
    name: '网易号',
    icon: 'https://static.ws.126.net/163/f2e/news/yxybd_pc/resource/static/share-icon.png',
    homepage: 'https://mp.163.com/#/article-publish',
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  /** 预处理配置: 网易号使用 HTML 格式，表格需转为文本 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    convertTablesToText: true,
  }

  /**
   * Header 规则：覆盖 mp.163.com 主域全部接口以及 /api/v3/upload/picupload。
   * Origin/Referer 与 HAR 中真实抓包保持一致；不带 Origin 时后端会有 CORS 校验提示。
   */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://mp.163.com/*',
      headers: {
        'Origin': 'https://mp.163.com',
        'Referer': 'https://mp.163.com/subscribe_v4/index.html',
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://mp.163.com/*',
      headers: {
        'Origin': 'https://mp.163.com',
        'Referer': 'https://mp.163.com/subscribe_v4/index.html',
      },
      resourceTypes: ['other'],
    },
  ]

  private accountInfo: NeteaseAccountInfo | null = null

  async checkAuth(): Promise<AuthResult> {
    try {
      const res = await this.get<{
        code?: number
        data?: NeteaseAccountInfo & { tid?: string | number }
      }>(`https://mp.163.com/wemedia/navinfo.do?_=${Date.now()}`)

      logger.debug('checkAuth response:', res)

      if (res.code !== 1 || !res.data?.tid) {
        return { isAuthenticated: false }
      }

      this.accountInfo = res.data as NeteaseAccountInfo
      return {
        isAuthenticated: true,
        userId: String(this.accountInfo.tid),
        username: this.accountInfo.tname,
        avatar: this.accountInfo.icon,
      }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('[Netease] Starting publish...')

      // 1. 确保已登录
      if (!this.accountInfo) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('请先登录网易号')
        }
      }
      // 后面 publishV2 / picupload 都依赖 accountInfo；上面已经抛错，下面非空断言安全
      const accountInfo = this.accountInfo!
      const wemediaId = String(accountInfo.tid)
      const realUserId = accountInfo.realUserId || ''

      // 2. 获取 ursToken（需要 mp.163.com 页面上下文）
      let ursToken = ''
      try {
        ursToken = await this.fetchUrsToken()
      } catch (e) {
        logger.warn('[Netease] fetchUrsToken 失败，使用空 token：', (e as Error).message)
      }

      // 3. 处理正文图片（替换为网易号图床 URL）。
      //    关键设计：网易号的「封面」不是 publishV2 的独立传图，而是从正文里取一张图
      //    —— HAR mp.163-select-img.com.har（用户在编辑器手动设封面）走的是
      //    “从正文选图”路径，publish 链路中没有独立 picupload 调用。
      //    所以我们这里是：先 processImages 把正文图片都上传到 dingyue.ws.126.net，
      //    然后从处理后的 content 里提取第一张 <img> 作为封面。
      let content = article.html || ''
      try {
        content = await this.processImages(
          content,
          (src) => this.uploadImageByUrl(src),
          {
            skipPatterns: ['126.net', '163.com', 'netease.com'],
            onProgress: options?.onImageProgress,
          },
        )
      } catch (e) {
        logger.warn('[Netease] processImages 中途失败，继续发布：', (e as Error).message)
      }

      // 4. 从处理后的 content 里提取首图 URL（= 封面）。
      //    <img 标签现在由 processImages 产出为
      //    <img src="<url>" alt="" _src="<url>" contenteditable="false" />
      //    （与 HAR mp.163-select-img.com.har 中的结构一致）
      let coverUrl = this.extractFirstImageUrl(content)
      let coverError = ''

      // 5. 兑底：如果正文里没有图，且 article.cover 有值，则把 article.cover 上传
      //    并在 content 前面插入一个网易号风格的封面段。
      //    （仅在用户额外传了 article.cover 但正文未含图时才走，主流路径中
      //    article.cover 是空，正文含图，走上面的“首图 = 封面”路径。）
      if (!coverUrl && article.cover) {
        try {
          const r = await this.uploadImageByUrl(article.cover)
          coverUrl = r.url
          content = this.buildCoverParagraph(coverUrl) + content
          logger.info(`[Netease] 正文无图，兑底从 article.cover 上传：${coverUrl}`)
        } catch (e) {
          coverError = (e as Error).message
          logger.warn('[Netease] article.cover 兑底上传失败，封面留空：', coverError)
        }
      }

      // 6. 第一次 publishV2（articleId=-1）建立空草稿拿到 docId
      const docId = await this.firstPublish(wemediaId, realUserId, article.title, ursToken)
      logger.info(`[Netease] 草稿 docId=${docId}`)

      // 7. 第二次 publishV2（articleId=docId）写入封面 + 正文
      const finalUrl = await this.finalPublish(
        wemediaId,
        realUserId,
        docId,
        article.title,
        content,
        ursToken,
        coverUrl, // ★ 封面 URL = content 首图 URL（HAR 验证）
      )

      // 8. 构造结果（封面诊断字段同 csdn 适配器约定）
      const coverDiagnostics: {
        coverUploaded?: boolean
        coverUrl?: string
        coverError?: string
      } = {}
      if (coverUrl) {
        coverDiagnostics.coverUploaded = true
        coverDiagnostics.coverUrl = coverUrl
      } else if (article.cover) {
        // article.cover 有但上传失败：诊断给上层
        coverDiagnostics.coverError = coverError || '正文无图且 article.cover 上传失败'
      }
      const baseResult: Partial<SyncResult> = {
        postId: docId,
        postUrl: finalUrl,
        draftOnly: options?.draftOnly ?? true,
        ...coverDiagnostics,
      }
      if (article.cover && coverError && !coverUrl) {
        baseResult.error = `封面图上传失败: ${coverError}`
        baseResult.message = '草稿已保存，但网易号封面未生效（正文也无图可当封面）'
      }
      return this.createResult(true, baseResult)
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * 第一次 publishV2：用 articleId=-1 在网易号后台建立空草稿，返回 docId。
   * HAR 验证：第一次请求的 wemediaId/articleId/title 都被服务端记录用于后续更新。
   */
  private async firstPublish(
    wemediaId: string,
    realUserId: string,
    title: string,
    ursToken: string,
  ): Promise<string> {
    const timestamp = Date.now()
    const url = `https://mp.163.com/wemedia/article/status/api/publishV2.do?_=${timestamp}&wemediaId=${wemediaId}&realUserId=${encodeURIComponent(realUserId)}`

    const formData = new URLSearchParams()
    formData.append('wemediaId', wemediaId)
    formData.append('articleId', '-1')
    formData.append('title', title || '未命名草稿')
    formData.append('content', '<p><br></p>')
    // 第一次 publishV2 同样需要 cover/picUrl（HAR 验证，第一次也会带上，
    // 与最终状态对齐避免返回默认值不一致）。但此时封面还没上传，所以传空。
    formData.append('cover', 'custom')
    formData.append('operation', 'saveDraft')
    formData.append('scheduled', '0')
    if (ursToken) formData.append('ursToken', ursToken)
    formData.append('onlineState', '1')
    formData.append('picUrl', '')
    formData.append('original', '0')
    formData.append('subjectId', '')

    const res = await (await this.runtime.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: formData.toString(),
    })).json() as {
      code?: number
      msg?: string
      data?: string | Record<string, string | number>
    }

    if (res.code !== 1) {
      throw new Error(`建立网易号草稿失败: ${res.msg || '未知错误'}`)
    }

    let docId = ''
    if (typeof res.data === 'string') {
      docId = new URLSearchParams(res.data).get('docId') || res.data
    } else if (res.data && typeof res.data === 'object') {
      docId = String(res.data.docId || '')
    }
    if (!docId) {
      throw new Error('网易号草稿响应未含 docId')
    }
    return docId
  }

  /**
   * 第二次 publishV2：用拿到的 docId 写入完整 content（含封面图）。
   * HAR 验证：articleId 字段在第二次请求里是 docId（例如 L5EHJR6A0556P4AV）。
   */
  private async finalPublish(
    wemediaId: string,
    realUserId: string,
    docId: string,
    title: string,
    content: string,
    ursToken: string,
    coverUrlForPicUrl: string,
  ): Promise<string> {
    const timestamp = Date.now()
    const url = `https://mp.163.com/wemedia/article/status/api/publishV2.do?_=${timestamp}&wemediaId=${wemediaId}&realUserId=${encodeURIComponent(realUserId)}`

    const formData = new URLSearchParams()
    formData.append('wemediaId', wemediaId)
    formData.append('articleId', docId)
    formData.append('title', title)
    formData.append('content', content)
    // 关键：cover=custom + picUrl=<上传后的封面 URL>
    // （此前传 cover=threeImg + picUrl='' 是真实错误原因，
    // 三个空的 "<p><br></p>" 占位导致网易号编辑器看不到封面）
    // 验证：mp.163-select-img.com.har publishV2[2].body
    formData.append('cover', 'custom')
    formData.append('operation', 'saveDraft')
    formData.append('scheduled', '0')
    if (ursToken) formData.append('ursToken', ursToken)
    formData.append('onlineState', '1')
    formData.append('picUrl', coverUrlForPicUrl)
    formData.append('original', '0')
    formData.append('subjectId', '')

    const res = await (await this.runtime.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: formData.toString(),
    })).json() as {
      code?: number
      msg?: string
    }

    if (res.code !== 1) {
      throw new Error(`保存网易号草稿内容失败: ${res.msg || '未知错误'}`)
    }

    // 拼装草稿编辑页 URL（与 HAR 编辑器定位一致）
    return `https://mp.163.com/subscribe_v4/index.html#/article-publish/${docId}?option=editDraft`
  }

  /**
   * 确保存在网易号 tab
   */
  private async ensureNeteaseTab(): Promise<number> {
    if (!this.runtime.tabs) {
      throw new Error('网易号发布需要浏览器 tabs API 支持')
    }
    const tabs = await this.runtime.tabs.query('https://mp.163.com/*')
    if (tabs.length > 0 && tabs[0].id) {
      return tabs[0].id
    }
    logger.info('[Netease] No existing tab found, creating new one...')
    const tab = await this.runtime.tabs.create(
      'https://mp.163.com/subscribe_v4/index.html#/article-publish',
      false,
    )
    await this.runtime.tabs.waitForLoad(tab.id, 30000)
    logger.info('[Netease] New tab created and loaded:', tab.id)
    return tab.id
  }

  /**
   * 从页面上下文获取 ursToken（window.neg.getToken()）。
   * 取不到时返回空字符串，publishV2 仍然能走通（HAR 验证：服务端兼容空 token，
   * 只是部分高敏操作会要求 token；本次我们只调用 publishV2/picupload 等基础 API）。
   */
  private async fetchUrsToken(): Promise<string> {
    if (!this.runtime.tabs) {
      logger.warn('[Netease] No tabs API, cannot get ursToken')
      return ''
    }

    const tabId = await this.ensureNeteaseTab()
    logger.debug('[Netease] Using tab:', tabId, 'to get ursToken')

    const result = await this.runtime.tabs.executeScript<
      { success: boolean; token?: string; error?: string },
      []
    >(tabId, async () => {
      try {
        const neg = (window as unknown as {
          neg?: { getToken: () => Promise<{ code: number; token?: string }> }
        }).neg

        if (!neg?.getToken) {
          return { success: false, error: 'neg.getToken not available' }
        }

        const tokenResult = await neg.getToken()
        if (tokenResult.code === 200 && tokenResult.token) {
          return { success: true, token: tokenResult.token }
        }
        return { success: false, error: `getToken returned code ${tokenResult.code}` }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }, [])

    return result?.success && result.token ? result.token : ''
  }

  /**
   * 通过 URL 上传图片
   *
   * src 支持三种形式：
   *   1. data URI（CLI 模式 / convertImagesToDataUri 处理后的结果）
   *   2. http(s):// 远程 URL（base class processImages 上游提取的图）
   *   3. 不支持：相对路径 `./xxx`（MV3 Service Worker 里 fetch 相对路径会
   *      "TypeError: Failed to fetch"，必须由上层传 data URI 或 HTTPS URL）
   *
   * 上传走 /api/v3/upload/picupload（HAR 验证），multipart 参数：
   *   file (binary), from=neteasecode_mp, logotext=<作者昵称/品牌名>
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.accountInfo) {
      throw new Error('未登录网易号')
    }

    // 1) 把 src 转成 Blob
    let imageBlob: Blob
    let mimeType = ''
    if (src.startsWith('data:')) {
      const match = src.match(/^data:([^;]+);base64,(.+)$/)
      if (!match) {
        throw new Error('非法的 data URI: ' + src.slice(0, 60))
      }
      mimeType = match[1]
      const binary = atob(match[2])
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      imageBlob = new Blob([bytes], { type: mimeType })
    } else if (src.startsWith('http://') || src.startsWith('https://')) {
      // 远程 URL：直接 fetch 拿 blob。注意不要在 MV3 SW 里直接 fetch 相对路径，
      // 这次走 catch 兜住，避免对外层抛错升级。
      const encoded = this.encodeUrlPath(src)
      const resp = await fetch(encoded)
      if (!resp.ok) {
        throw new Error(`远程图片下载失败 (${resp.status}): ${src}`)
      }
      imageBlob = await resp.blob()
      mimeType = imageBlob.type
    } else if (src.startsWith('blob:')) {
      // blob URL（createObjectURL）
      const resp = await fetch(src)
      if (!resp.ok) {
        throw new Error(`blob 图片读取失败 (${resp.status}): ${src}`)
      }
      imageBlob = await resp.blob()
      mimeType = imageBlob.type
    } else {
      // 相对路径或其他：MV3 SW 里 fetch 会直接 Failed to fetch，
      // 因此显式给出可读错误，避免上游静默失败
      throw new Error(
        `网易号适配器不支持的图片源: ${src.slice(0, 60)}（请使用 data URI / http(s) URL）`,
      )
    }

    // 2) 把 Blob 上传到 /api/v3/upload/picupload
    const queryTs = Date.now()
    const url = `https://mp.163.com/api/v3/upload/picupload?_=${queryTs}&wemediaId=${this.accountInfo.tid}&realUserId=${encodeURIComponent(this.accountInfo.realUserId || '')}`

    const formData = new FormData()
    // HAR 显示 filename 是 "blob"（HAR 中可见 filename="blob"），
    // 但服务端不在乎 filename 字段，传 image.<ext> 也可以。我们优先用 MIME 推得的扩展名。
    const ext = this.mimeToExt(mimeType)
    formData.append('file', imageBlob, `image.${ext}`)
    formData.append('from', 'neteasecode_mp')
    // logotext 是网易号图床登记的「上传方标识」。HAR 抓到的值是作者相关的中文。
    // 这里用作者昵称回填；若没有昵称则退回 wechatsync 字符串占位，避免空值被服务端拒绝。
    formData.append(
      'logotext',
      this.accountInfo.tname ? String(this.accountInfo.tname) : 'wechatsync',
    )

    const resp = await this.runtime.fetch(url, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    })

    // picupload 响应是 text/plain，但 body 是 JSON。手动 parse 避免依赖 runtime
    const text = await resp.text()
    let parsed: {
      code?: number
      msg?: string
      data?: { url?: string; picUrl?: string; pid?: string; width?: number; height?: number }
    }
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`picupload 响应非 JSON（HTTP ${resp.status}）: ${text.slice(0, 200)}`)
    }
    // 兼容两种响应格式：
    //   成功：{code:200, msg:"succ", data:{url, pid, width, height}}
    //   失败：{code:0, msg:"..."} —— 某些版本只返回 code=0 不带 data
    if ((parsed.code !== undefined && parsed.code !== 200 && parsed.code !== 1) || !parsed.data) {
      throw new Error(
        `[Netease] picupload 失败 (HTTP ${resp.status}, code=${parsed.code}): ${parsed.msg || text.slice(0, 200)}`,
      )
    }

    const result: NeteaseUploadResult = {
      url: parsed.data.url || parsed.data.picUrl || '',
      pid: parsed.data.pid,
      width: parsed.data.width,
      height: parsed.data.height,
    }
    if (!result.url) {
      throw new Error('picupload 响应未含 url 字段')
    }
    logger.debug('[Netease] picupload response:', parsed)
    // ★ 关键：返回 attrs 让 processImages 替换出的 <img> 带上网易号编辑器需要的属性。
    //   HAR mp.163.com.har / mp.163-select-img.com.har 中正文里的 <img> 都被编辑器
    //   打包成 <img src="<url>" alt _src="<url>" contenteditable="false" /> 的结构。
    //   _src 是网易号编辑器用来保存「源 URL」、供“设置封面”从正文选图时反查的引用。
    //   contenteditable="false" 锁住这块不可编辑，是网易号为“封面 / 内部资源”插图做的防误改标记。
    //   alt 加空值是为了与编辑器生成的 HTML 结构对齐。
    return {
      url: result.url,
      attrs: {
        alt: '',
        _src: result.url,
        contenteditable: 'false',
      },
    }
  }

  /** MIME → 扩展名映射（兜底用） */
  private mimeToExt(mime: string): string {
    const map: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
    }
    return map[mime.toLowerCase()] || 'jpg'
  }

  /**
   * 从 content 中提取第一张 <img> 的 src。
   * 这里只关心正文里第一张作为封面的图：严格取 <img src="..."> 的属性（其他属性如 alt / data-* 不需提取）。
   * 返回空字符串表示 content 里没有图。
   */
  private extractFirstImageUrl(content: string): string {
    const m = content.match(/<img[^>]+src="([^"]+)"/i)
    if (!m) return ''
    // HTML 属性里的 &amp; / &lt; / &gt; / &quot; / &#39; 需解码（与 dayu 适配器一致的兜底）
    return m[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
  }

  /**
   * 构造一个网易号编辑器风格的封面 <p> 段。
   * 用于"正文无图 + article.cover 兜底上传"路径。
   * HAR mp.163-select-img.com.har 参考：
   *   <p style="text-align:center; font-size:16px; color:#666;">
   *     <img src="<url>" alt _src="<url>" contenteditable="false" /><br />
   *   </p>
   */
  private buildCoverParagraph(coverUrl: string): string {
    return `<p style="text-align:center; font-size:16px; color:#666;"><img src="${coverUrl}" alt _src="${coverUrl}" contenteditable="false" /><br /></p>`
  }
}
