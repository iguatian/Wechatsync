/**
 * 中关村在线创作者平台适配器（post.zol.com.cn）
 *
 * 平台资料：
 * - 创作者后台：https://post.zol.com.cn/
 * - 文章编辑器：https://post.zol.com.cn/v2/create/article（HAR 抓包 referer）
 * - 开放 API：open-api.zol.com.cn（跨域，Origin 校验严格：错误 Origin → 403 Forbidden，
 *   仅放行 Origin: https://post.zol.com.cn，并返回 Access-Control-Allow-Origin 响应头）
 *
 * 鉴权：
 *   GET https://open-api.zol.com.cn/api/v1/creator.user.getinfo
 *   - errcode === 0 视为已登录（data.userId 即用户 ID，形如 w9sx4m90）
 *   - errcode === 100045 视为未登录（"Not logged in."）
 *   - 前端页面还会把 userId 写进 cookie `zol_userid`（js-cookie 读取）与
 *     localStorage `zol_userInfo`（JSON），页面上下文脚本按 cookie → localStorage 兜底读取
 *
 * 图片上传（multipart/form-data）：
 *   POST https://open-api.zol.com.cn/api/v1/creator.content.image.upload
 *     Fields:
 *       file: <binary image>（filename 固定 "blob"，对齐抓包样本）
 *     Response: { errcode, errmsg, data: { fileUrl: "https://private.zol-img.com.cn/..." } }
 *
 * 保存草稿（multipart/form-data）：
 *   POST https://open-api.zol.com.cn/api/v1/creator.content.draft.save.orther
 *     Fields（对齐抓包样本）：
 *       businessType: "1"
 *       scontent: <正文 HTML>
 *       title: <标题>
 *       stitle: ""（副标题）
 *       userId: <用户 ID>
 *       guideImg: <图片 JSON 数组 [{"url","width","height"}]>
 *       saveType: "2"（2 = 保存草稿）
 *       ...其余字段与抓包样本一致，均填空/0/false
 *     首次保存 draftId 为空，响应 data.draftId 返回新草稿 ID；
 *     更新同一草稿时 draftId 与 draftUpdateId 都填。
 *     Response: { errcode, errmsg, data: { draftId } }
 *
 * 请求模式（与懂车帝一致）：
 * - open-api.zol.com.cn 校验 Origin（错误 Origin → 403），而 MV3 Service Worker 的
 *   fetch 会被 Chrome 强制设 Origin 为 chrome-extension://<id>，declarativeNetRequest
 *   注入也不一定可靠，因此扩展环境所有请求（鉴权/上传/保存草稿）走 post.zol.com.cn
 *   页面上下文（tabs.executeScript），Origin/Referer 自动正确。
 * - CLI/mcp-server 等 Node 环境无 CORS 限制，直接 fetch 并显式携带 Origin/Referer 头。
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Zol')

/** 创作者后台 origin */
const POST_ORIGIN = 'https://post.zol.com.cn'

/** 文章创建/编辑页（HAR 抓包 referer） */
const CREATE_PAGE = `${POST_ORIGIN}/v2/create/article`

/** 开放 API 基础地址 */
const OPEN_API_BASE = 'https://open-api.zol.com.cn/api/v1'

/** 用户信息接口（checkAuth 用） */
const USER_INFO_URL = `${OPEN_API_BASE}/creator.user.getinfo`

/** 图片上传接口（multipart/form-data） */
const IMAGE_UPLOAD_URL = `${OPEN_API_BASE}/creator.content.image.upload`

/** 保存草稿接口（multipart/form-data） */
const DRAFT_SAVE_URL = `${OPEN_API_BASE}/creator.content.draft.save.orther`

/** 解析 HTML 中 <img> 标签的正则 */
const IMG_TAG_REGEX = /<img\b[^>]*>/gi

/** 用户信息接口响应 */
interface ZolUserInfoResp {
  errcode?: number
  errmsg?: string
  data?: {
    userId?: string
    username?: string
    nickname?: string
    [key: string]: unknown
  }
}

/** 图片上传接口响应 */
interface ZolImageUploadResp {
  errcode?: number
  errmsg?: string
  data?: {
    fileUrl?: string
    [key: string]: unknown
  }
}

/** 保存草稿接口响应 */
interface ZolDraftSaveResp {
  errcode?: number
  errmsg?: string
  data?: {
    draftId?: number | string
    [key: string]: unknown
  }
}

/** 页面上下文保存草稿的执行结果 */
interface SaveDraftInTabResult {
  ok: boolean
  draftId?: string
  errcode?: number
  errmsg?: string
  error?: string
}

export class ZolAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'zol',
    name: '中关村在线',
    icon: 'https://www.zol.com.cn/favicon.ico',
    homepage: POST_ORIGIN,
    capabilities: ['article', 'draft'],
  }

  /** 预处理配置：编辑器接受 HTML 正文（与汽车之家/懂车帝一致） */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  /**
   * Header 规则（仅 SW fetch 兜底路径使用）：
   * 扩展环境默认走页面上下文，DNR 注入仅用于没有 post.zol.com.cn tab 时的
   * checkAuth 轻量探测（zhihu OSS 上传已验证 DNR 可注入 Origin）。
   */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://open-api.zol.com.cn/*',
      headers: {
        Origin: POST_ORIGIN,
        Referer: CREATE_PAGE,
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  // ============ checkAuth ============

  /**
   * 鉴权：调用 creator.user.getinfo
   * - errcode === 0 即已登录，data.userId 作为 userId 返回
   * - errcode === 100045 即未登录
   *
   * 路径：
   * 1. 扩展环境优先走 post.zol.com.cn 页面上下文（Origin 自动正确）
   * 2. SW fetch + headerRules（DNR 注入 Origin）兜底，供无 tab 场景（popup 批量检查）使用
   * 3. Node 环境直接 fetch（显式 Origin/Referer 头）
   */
  async checkAuth(): Promise<AuthResult> {
    const runtimeTabs = this.runtime.tabs

    // 扩展环境：优先页面上下文
    if (runtimeTabs) {
      try {
        const tabId = await this.ensureZolTab()
        const result = await runtimeTabs.executeScript<
          { ok: boolean; notLoggedIn?: boolean; userId?: string; username?: string; error?: string },
          [string]
        >(tabId, fetchUserInfoInTabScript, [USER_INFO_URL])

        if (result.ok) {
          return {
            isAuthenticated: true,
            userId: result.userId,
            username: result.username || undefined,
          }
        }
        if (result.notLoggedIn) {
          return { isAuthenticated: false, error: '请先登录中关村在线创作者平台（https://post.zol.com.cn/）' }
        }
        // 其他错误（网络/页面异常）降级到 SW fetch 再试一次
        logger.debug('checkAuth page-context failed, fallback to SW fetch:', result.error)
      } catch (error) {
        logger.debug('checkAuth page-context error, fallback to SW fetch:', error)
      }
    }

    // SW / Node fetch 兜底
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      try {
        const resp = await this.get<ZolUserInfoResp>(USER_INFO_URL, {
          Accept: 'application/json, text/plain, */*',
        })
        if (resp.errcode !== 0 || !resp.data?.userId) {
          return {
            isAuthenticated: false,
            error: resp.errcode === 100045
              ? '请先登录中关村在线创作者平台（https://post.zol.com.cn/）'
              : (resp.errmsg || `鉴权失败：errcode=${resp.errcode}`),
          }
        }
        return {
          isAuthenticated: true,
          userId: resp.data.userId,
          username: resp.data.username || resp.data.nickname || undefined,
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
   * 发布文章（保存草稿）：
   * 1. 上传正文图片到 zol 图床（fileUrl）
   * 2. 构造 guideImg JSON（含宽高，编辑器据此渲染文内图片）
   * 3. 调用 draft.save.orther 保存草稿（saveType=2），响应 data.draftId
   */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    const runtimeTabs = this.runtime.tabs

    // 非扩展环境：Node fetch 直接调用（可自由设置 Origin/Referer 头）
    if (!runtimeTabs) {
      return this.publishViaFetch(article, options)
    }

    return this.withHeaderRules([], async () => {
      logger.info('Starting publish to Zol...')

      // 0. 确保 post.zol.com.cn tab 存在
      const tabId = await this.ensureZolTab()

      // 1. 页面上下文鉴权 + 获取 userId
      const auth = await runtimeTabs.executeScript<
        { ok: boolean; notLoggedIn?: boolean; userId?: string; username?: string; error?: string },
        [string]
      >(tabId, fetchUserInfoInTabScript, [USER_INFO_URL])
      if (!auth.ok || auth.notLoggedIn) {
        throw new Error(auth.error || '未登录中关村在线创作者平台')
      }
      const userId = auth.userId
      if (!userId) {
        throw new Error('获取用户 ID 失败（页面 cookie/localStorage 中无 zol_userid）')
      }

      // 2. 处理正文图片：上传到 zol 图床，替换 src 并保留 data-width/data-height
      let content = article.html || ''
      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['zol-img.com.cn', 'zol.com.cn'],
          onProgress: options?.onImageProgress,
        },
      )

      // 3. 构造 guideImg JSON（文内图片列表，含宽高）
      const guideImg = this.buildGuideImg(content)

      // 4. 页面上下文保存草稿
      const result = await runtimeTabs.executeScript<SaveDraftInTabResult, [SaveDraftInTabParams]>(
        tabId,
        saveDraftInTabScript,
        [{
          saveUrl: DRAFT_SAVE_URL,
          title: article.title,
          scontent: content,
          userId,
          guideImg: JSON.stringify(guideImg),
        }],
      )

      if (!result.ok) {
        throw new Error(result.error || `保存草稿失败 (errcode=${result.errcode})`)
      }

      const draftId = result.draftId
      if (!draftId) {
        throw new Error('保存草稿失败：响应未含 draftId')
      }

      logger.info(`Draft saved: ${draftId}`)
      return this.createResult(true, {
        postId: draftId,
        postUrl: CREATE_PAGE,
        draftOnly: options?.draftOnly ?? true,
        message: '已保存到中关村在线创作者平台草稿箱',
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * Node 环境发布：直接 fetch（无 CORS 限制，显式携带 Origin/Referer 头）。
   * 与页面上下文路径共用 HEADER_RULES 的思路，但 Node fetch 可直接设置请求头。
   */
  private async publishViaFetch(article: Article, options?: PublishOptions): Promise<SyncResult> {
    const baseHeaders: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      Origin: POST_ORIGIN,
      Referer: CREATE_PAGE,
    }

    try {
      logger.info('Starting publish to Zol (node runtime)...')

      // 0. 鉴权 + 获取 userId
      const authResp = await this.get<ZolUserInfoResp>(USER_INFO_URL, baseHeaders)
      if (authResp.errcode !== 0 || !authResp.data?.userId) {
        throw new Error(authResp.errcode === 100045
          ? '请先登录中关村在线创作者平台（https://post.zol.com.cn/）'
          : (authResp.errmsg || '鉴权失败'))
      }
      const userId = authResp.data.userId

      // 1. 处理正文图片
      let content = article.html || ''
      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['zol-img.com.cn', 'zol.com.cn'],
          onProgress: options?.onImageProgress,
        },
      )

      // 2. 构造 guideImg JSON
      const guideImg = this.buildGuideImg(content)

      // 3. 保存草稿（multipart/form-data）
      const formData = this.buildDraftFormData({
        title: article.title,
        scontent: content,
        userId,
        guideImg: JSON.stringify(guideImg),
      })
      const response = await this.runtime.fetch(DRAFT_SAVE_URL, {
        method: 'POST',
        credentials: 'include',
        headers: baseHeaders,
        body: formData,
      })
      const text = await response.text()
      let data: ZolDraftSaveResp
      try {
        data = JSON.parse(text) as ZolDraftSaveResp
      } catch {
        throw new Error(`保存草稿失败：响应非 JSON (HTTP ${response.status}): ${text.substring(0, 200)}`)
      }
      if (data.errcode !== 0 || !data.data?.draftId) {
        throw new Error(data.errmsg || `保存草稿失败：errcode=${data.errcode}`)
      }

      const draftId = String(data.data.draftId)
      logger.info(`Draft saved: ${draftId}`)
      return this.createResult(true, {
        postId: draftId,
        postUrl: CREATE_PAGE,
        draftOnly: options?.draftOnly ?? true,
        message: '已保存到中关村在线创作者平台草稿箱',
      })
    } catch (error) {
      return this.createResult(false, { error: (error as Error).message })
    }
  }

  // ============ 图片上传 ============

  /**
   * 通过 URL 上传图片到 zol 图床。
   *
   * 扩展环境：必须走 post.zol.com.cn 页面上下文（tabs.executeScript）——
   * MV3 SW fetch 会被 Chrome 强制设 Origin 为 chrome-extension://<id>，
   * open-api.zol.com.cn 校验 Origin，错误 Origin 直接 403。
   * 页面上下文里顺便用 createImageBitmap 读取图片宽高（guideImg 需要）。
   *
   * Node 环境：直接 fetch（Origin/Referer 头可自由设置）。
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    // CLI/mcp-server 等非扩展环境：Node fetch 直接上传
    if (!this.runtime.tabs) {
      return this.uploadViaFetch(src)
    }

    try {
      // 1. 转 base64（跨 executeScript 边界只能用可序列化数据）
      let base64: string
      let mime: string

      if (src.startsWith('data:')) {
        const dm = src.match(/^data:([^;,]+);base64,(.*)$/s)
        if (!dm) {
          logger.warn('[Zol] 无法解析的 data URI:', src.substring(0, 80))
          return { url: src }
        }
        mime = dm[1] || 'image/jpeg'
        base64 = dm[2]
      } else {
        const encodedSrc = this.encodeUrlPath(src)
        const imageResponse = await fetch(encodedSrc)
        if (!imageResponse.ok) {
          throw new Error(`图片下载失败 (${imageResponse.status}): ${src}`)
        }
        const blob = await imageResponse.blob()
        base64 = await this.blobToBase64(blob)
        mime = blob.type || 'image/jpeg'
      }

      // 2. 在页面上下文发起上传（Origin/Referer 自动正确）
      const tabId = await this.ensureZolTab()
      const result = await this.runtime.tabs.executeScript<
        { ok: boolean; url?: string; width?: number; height?: number; error?: string },
        [UploadInTabParams]
      >(tabId, uploadImageInTabScript, [{
        uploadUrl: IMAGE_UPLOAD_URL,
        base64Data: base64,
        mime,
      }])

      if (!result.ok || !result.url) {
        logger.warn('[Zol] 图片上传失败:', result.error)
        return { url: src }
      }

      // 携带宽高，processImages 会写入 data-width/data-height，供 buildGuideImg 使用
      const attrs: Record<string, string | number> = {}
      if (result.width) attrs['data-width'] = result.width
      if (result.height) attrs['data-height'] = result.height

      return { url: result.url, attrs }
    } catch (error) {
      logger.warn('[Zol] 图片上传失败，保留原 URL:', src, error)
      return { url: src }
    }
  }

  /** Node 环境图片上传（直接 fetch，显式 Origin/Referer 头） */
  private async uploadViaFetch(src: string): Promise<ImageUploadResult> {
    try {
      let blob: Blob

      if (src.startsWith('data:')) {
        blob = await this.dataUriToBlob(src)
      } else {
        const encodedSrc = this.encodeUrlPath(src)
        const imageResponse = await fetch(encodedSrc)
        if (!imageResponse.ok) {
          throw new Error(`图片下载失败 (${imageResponse.status}): ${src}`)
        }
        blob = await imageResponse.blob()
      }

      const formData = new FormData()
      // 抓包样本 filename 固定为 "blob"
      formData.append('file', blob, 'blob')

      const response = await this.runtime.fetch(IMAGE_UPLOAD_URL, {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json, text/plain, */*',
          Origin: POST_ORIGIN,
          Referer: CREATE_PAGE,
        },
        body: formData,
      })
      const text = await response.text()
      let data: ZolImageUploadResp
      try {
        data = JSON.parse(text) as ZolImageUploadResp
      } catch {
        throw new Error(`上传图片失败：响应非 JSON (HTTP ${response.status}): ${text.substring(0, 200)}`)
      }
      if (data.errcode !== 0 || !data.data?.fileUrl) {
        throw new Error(data.errmsg || `上传图片失败：errcode=${data.errcode}`)
      }

      // 尝试读取宽高（Node 环境 createImageBitmap 可能不可用，拿不到则省略）
      const attrs: Record<string, string | number> = {}
      try {
        const bitmap = await createImageBitmap(blob)
        attrs['data-width'] = bitmap.width
        attrs['data-height'] = bitmap.height
        bitmap.close()
      } catch {
        // 忽略：宽高非必需
      }

      return { url: data.data.fileUrl, attrs }
    } catch (error) {
      logger.warn('[Zol] 图片上传失败，保留原 URL:', src, error)
      return { url: src }
    }
  }

  // ============ 表单构造 ============

  /** 保存草稿表单字段（对齐抓包样本） */
  private buildDraftFormData(payload: {
    title: string
    scontent: string
    userId: string
    guideImg: string
  }): FormData {
    const formData = new FormData()
    const fields: Record<string, string> = {
      businessType: '1',
      scontent: payload.scontent,
      title: payload.title,
      stitle: '',
      userId: payload.userId,
      docType: '',
      isOriginal: '',
      isContribution: '0',
      dutyEditor: '',
      publishDate: '',
      subjectList: '',
      subjectIdStr: '',
      guideImg: payload.guideImg,
      draftId: '',
      contentId: '',
      tryId: '',
      goodsList: '',
      subjectNameStr: '',
      eosXuanti: '0',
      eosDawen: '0',
      eosUser: '0',
      eosTeyue: '0',
      firstEc: '0',
      isTouTiao: '0',
      noComment: '0',
      firstEcForm: 'false',
      isToutiaoForm: 'false',
      noCommentForm: 'false',
      geoList: '',
      eosSyXuanti: '0',
      eosGEO: '0',
      eosZiZhu: '0',
      saveType: '2',
    }
    for (const [key, value] of Object.entries(fields)) {
      formData.append(key, value)
    }
    return formData
  }

  /** 从正文 HTML 提取图片列表，构造 guideImg JSON 数组（含宽高） */
  private buildGuideImg(content: string): Array<{ url: string; width: number; height: number }> {
    const result: Array<{ url: string; width: number; height: number }> = []
    for (const match of content.matchAll(IMG_TAG_REGEX)) {
      const tag = match[0]
      const srcMatch = tag.match(/src=["']([^"']+)["']/)
      if (!srcMatch) continue
      const widthMatch = tag.match(/data-width=["']?(\d+)["']?/)
      const heightMatch = tag.match(/data-height=["']?(\d+)["']?/)
      result.push({
        url: srcMatch[1],
        width: widthMatch ? parseInt(widthMatch[1], 10) : 0,
        height: heightMatch ? parseInt(heightMatch[1], 10) : 0,
      })
    }
    return result
  }

  // ============ Tab 管理 ============

  /** 确保存在 post.zol.com.cn tab（用于在页面上下文发起请求） */
  private async ensureZolTab(): Promise<number> {
    const runtimeTabs = this.runtime.tabs
    if (!runtimeTabs) {
      throw new Error('中关村在线需要扩展 tabs API 支持')
    }

    const urlPattern = '*://post.zol.com.cn/*'
    const tabs = await runtimeTabs.query(urlPattern)
    const firstTab = tabs[0]
    if (firstTab && firstTab.id !== undefined) {
      logger.debug(`[Zol] 复用已存在的 post.zol.com.cn tab: ${firstTab.id}`)
      return firstTab.id
    }

    logger.info('[Zol] 没有 post.zol.com.cn tab，在后台打开创建页...')
    const tab = await runtimeTabs.create(CREATE_PAGE, false)
    const tabId = tab.id
    if (tabId === undefined) {
      throw new Error('创建中关村在线创建页 tab 失败')
    }
    await runtimeTabs.waitForLoad(tabId, 30000)
    return tabId
  }

  // ============ 工具方法 ============

  /** Blob → base64 字符串（用于跨 executeScript 边界传递图像数据） */
  private async blobToBase64(blob: Blob): Promise<string> {
    const buffer = await blob.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    const chunkSize = 0x8000
    let binary = ''
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize)
      binary += String.fromCharCode.apply(null, chunk as unknown as number[])
    }
    return btoa(binary)
  }
}

// ============ executeScript 函数（必须是无闭包引用的纯函数） ============

/** executeScript 传入参数：图片上传 */
interface UploadInTabParams {
  uploadUrl: string
  base64Data: string
  mime: string
}

/**
 * 在 post.zol.com.cn tab 的 MAIN world 里发起 multipart/form-data 图片上传。
 * - fetch 在页面上下文发起，Origin/Referer 自动是 post.zol.com.cn
 * - 用 createImageBitmap 读取图片宽高（guideImg 字段需要）
 * 该函数会被 chrome.scripting.executeScript 序列化/反序列化，必须是纯函数。
 */
async function uploadImageInTabScript(params: UploadInTabParams): Promise<
  { ok: boolean; url?: string; width?: number; height?: number; error?: string }
> {
  const { uploadUrl, base64Data, mime } = params

  try {
    // base64 → Uint8Array → File（filename 固定 "blob"，对齐抓包样本）
    const byteString = atob(base64Data)
    const bytes = new Uint8Array(byteString.length)
    for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i)
    const file = new File([bytes], 'blob', { type: mime })

    const formData = new FormData()
    formData.append('file', file)

    const response = await fetch(uploadUrl, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    })
    const text = await response.text()
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}: ${text.substring(0, 200)}` }
    }

    let json: { errcode?: number; errmsg?: string; data?: { fileUrl?: string } }
    try {
      json = JSON.parse(text)
    } catch {
      return { ok: false, error: `响应非 JSON: ${text.substring(0, 200)}` }
    }
    if (json.errcode !== 0 || !json.data?.fileUrl) {
      return { ok: false, error: json.errmsg || `errcode=${json.errcode}` }
    }

    // 读取图片宽高（供 guideImg 使用）
    let width = 0
    let height = 0
    try {
      const bitmap = await createImageBitmap(file)
      width = bitmap.width
      height = bitmap.height
      bitmap.close()
    } catch {
      // 忽略：宽高非必需
    }

    return { ok: true, url: json.data.fileUrl, width, height }
  } catch (e) {
    return { ok: false, error: (e as Error).message || '未知错误' }
  }
}

/** executeScript 传入参数：保存草稿 */
interface SaveDraftInTabParams {
  saveUrl: string
  title: string
  scontent: string
  userId: string
  guideImg: string
}

/**
 * 在 post.zol.com.cn tab 的 MAIN world 里保存草稿。
 * 表单字段对齐 HAR 抓包样本（businessType=1 / saveType=2 / 全量字段）。
 * 该函数会被 chrome.scripting.executeScript 序列化/反序列化，必须是纯函数。
 */
async function saveDraftInTabScript(params: SaveDraftInTabParams): Promise<SaveDraftInTabResult> {
  const { saveUrl, title, scontent, userId, guideImg } = params

  try {
    const formData = new FormData()
    const fields: Record<string, string> = {
      businessType: '1',
      scontent,
      title,
      stitle: '',
      userId,
      docType: '',
      isOriginal: '',
      isContribution: '0',
      dutyEditor: '',
      publishDate: '',
      subjectList: '',
      subjectIdStr: '',
      guideImg,
      draftId: '',
      contentId: '',
      tryId: '',
      goodsList: '',
      subjectNameStr: '',
      eosXuanti: '0',
      eosDawen: '0',
      eosUser: '0',
      eosTeyue: '0',
      firstEc: '0',
      isTouTiao: '0',
      noComment: '0',
      firstEcForm: 'false',
      isToutiaoForm: 'false',
      noCommentForm: 'false',
      geoList: '',
      eosSyXuanti: '0',
      eosGEO: '0',
      eosZiZhu: '0',
      saveType: '2',
    }
    for (const [key, value] of Object.entries(fields)) {
      formData.append(key, value)
    }

    const response = await fetch(saveUrl, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    })
    const text = await response.text()
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}: ${text.substring(0, 200)}` }
    }

    let json: { errcode?: number; errmsg?: string; data?: { draftId?: number | string } }
    try {
      json = JSON.parse(text)
    } catch {
      return { ok: false, error: `响应非 JSON: ${text.substring(0, 200)}` }
    }
    if (json.errcode !== 0) {
      return { ok: false, errcode: json.errcode, errmsg: json.errmsg, error: json.errmsg || `errcode=${json.errcode}` }
    }
    if (!json.data?.draftId) {
      return { ok: false, error: '响应未含 draftId' }
    }

    return { ok: true, draftId: String(json.data.draftId) }
  } catch (e) {
    return { ok: false, error: (e as Error).message || '未知错误' }
  }
}

/**
 * 在 post.zol.com.cn tab 的 MAIN world 里获取用户信息。
 * 优先级：接口响应 → cookie zol_userid → localStorage zol_userInfo（JSON.userId）。
 * 该函数会被 chrome.scripting.executeScript 序列化/反序列化，必须是纯函数。
 */
async function fetchUserInfoInTabScript(userInfoUrl: string): Promise<
  { ok: boolean; notLoggedIn?: boolean; userId?: string; username?: string; error?: string }
> {
  try {
    const response = await fetch(userInfoUrl, {
      method: 'GET',
      credentials: 'include',
    })
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` }
    }
    const text = await response.text()
    let json: { errcode?: number; errmsg?: string; data?: { userId?: string; username?: string; nickname?: string } }
    try {
      json = JSON.parse(text)
    } catch {
      return { ok: false, error: `响应非 JSON: ${text.substring(0, 200)}` }
    }

    // 未登录
    if (json.errcode !== 0 || !json.data?.userId) {
      if (json.errcode === 100045) {
        return { ok: false, notLoggedIn: true }
      }
      // 接口异常（如维护中）：尝试从 cookie / localStorage 兜底
      const cookieUserId = readUserIdFromCookie()
      if (cookieUserId) {
        return { ok: true, userId: cookieUserId }
      }
      return { ok: false, error: json.errmsg || `errcode=${json.errcode}` }
    }

    return {
      ok: true,
      userId: json.data.userId,
      username: json.data.username || json.data.nickname || undefined,
    }
  } catch (e) {
    // 网络异常时兜底读 cookie / localStorage
    const cookieUserId = readUserIdFromCookie()
    if (cookieUserId) {
      return { ok: true, userId: cookieUserId }
    }
    return { ok: false, error: (e as Error).message || '未知错误' }
  }
}

/** 从 cookie zol_userid / localStorage zol_userInfo 读取 userId（前端代码验证的存储位置） */
function readUserIdFromCookie(): string {
  try {
    // 1. cookie zol_userid（前端 CreatorAgreement 用 js-cookie 读此值）
    if (typeof document !== 'undefined') {
      const m = document.cookie.match(/(?:^|;\s*)zol_userid=([^;]+)/)
      if (m && m[1]) {
        try { return decodeURIComponent(m[1]) } catch { return m[1] }
      }
    }
    // 2. localStorage zol_userInfo（Vuex 持久化的用户对象 JSON）
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem('zol_userInfo')
      if (raw) {
        const info = JSON.parse(raw) as { userId?: string }
        if (info.userId) return info.userId
      }
    }
    return ''
  } catch {
    return ''
  }
}
