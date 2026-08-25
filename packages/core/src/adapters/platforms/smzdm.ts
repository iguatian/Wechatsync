/**
 * 什么值得买适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'
import md5Lib from 'js-md5'

const logger = createLogger('Smzdm')

// js-md5 导出的是函数本身（与 zhihu.ts 一致）
const jsMd5 = md5Lib as unknown as (message: string | ArrayBuffer | Uint8Array) => string

/**
 * AES-ECB-PKCS7 加密（用于 smzdm awne 签名）
 * 使用 Web Crypto API 实现
 */
async function encryptAesEcb(plaintext: string, md5Hex: string): Promise<string> {
  // AES key = UTF8 完整 MD5 hex 字符串（32 字符 → 32 字节）
  // 前端: n = Vve.parse(r)，r 是 RZe(t).toString()（MD5 hex），Vve = enc.Utf8
  const keyBytes = new TextEncoder().encode(md5Hex)
  // 前端 key 长度 32 字节（对应 AES-256）
  const cryptoObj = globalThis.crypto
  if (cryptoObj?.subtle) {
    const key = await cryptoObj.subtle.importKey(
      'raw',
      keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength),
      { name: 'AES-CBC' },
      false,
      ['encrypt']
    )

    // 明文: 前端 o = Uve.stringify(Vve.parse(e)) → Base64(UTF8(明文))
    // 再 MZe.encrypt(o, n) 即用 Base64 字符串的 UTF8 字节作为加密明文
    const innerBase64 = btoa(plaintext)
    const plainBytes = new TextEncoder().encode(innerBase64)

    // PKCS7 padding 到 16 字节倍数
    const padLen = 16 - (plainBytes.length % 16)
    const padded = new Uint8Array(plainBytes.length + padLen)
    padded.set(plainBytes)
    for (let i = plainBytes.length; i < padded.length; i++) {
      padded[i] = padLen
    }

    // 用 AES-CBC 零 IV 模拟 ECB（Web Crypto 无原生 ECB，单块结果与 ECB 一致）
    const encrypted = await cryptoObj.subtle.encrypt(
      { name: 'AES-CBC', iv: new Uint8Array(16) },
      key,
      padded
    )

    // 转 Base64
    const bytes = new Uint8Array(encrypted)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
  }

  throw new Error('Web Crypto API not available')
}

/**
 * 计算 smzdm awne 签名
 * 前端公式: awne = AES_ECB(MD5(key), wordCount), key = `${smzdm_id}-${wordCount}-smzdm.com`
 */
async function computeAwne(smzdmId: string, wordCount: number): Promise<string> {
  const key = `${smzdmId}-${wordCount}-smzdm.com`
  const md5Hex = jsMd5(key.trim())
  return encryptAesEcb(String(wordCount), md5Hex)
}

/**
 * 判断响应是否为 WAF 挑战页面
 */
function isWafChallenge(text: string): boolean {
  return text.includes('probe.js') || text.includes('var buid')
}

/**
 * 带随机抖动的延迟（避免 WAF 检测）
 */
function delayWithJitter(base: number): Promise<void> {
  const jitter = Math.floor(Math.random() * 500)
  return new Promise(resolve => setTimeout(resolve, base + jitter))
}

/**
 * 读取 Blob 图片尺寸（Service Worker 中没有 Image 对象，
 * 使用 createImageBitmap 读宽高）。
 */
async function getImageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(blob)
  const { width, height } = bitmap
  bitmap.close()
  return { width, height }
}

/**
 * 什么值得买请求默认 Headers
 */
const REQUEST_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
}

export class SmzdmAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'smzdm',
    name: '什么值得买',
    icon: 'https://www.smzdm.com/favicon.ico',
    homepage: 'https://post.smzdm.com/tougao/',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 什么值得买使用 HTML 格式 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    removeLinks: true,
  }

  /** 什么值得买 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://post.smzdm.com/*',
      headers: {
        'Origin': 'https://post.smzdm.com',
        'Referer': 'https://post.smzdm.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  private _currentArticleId: string | null = null
  private _csrfToken: string | null = null

  /**
   * 从 cookie 读取 smzdm_id（用于 awne 签名）
   * 前端从 document.cookie 读取 `smzdm_id`
   */
  private async getSmzdmIdFromCookie(): Promise<string | null> {
    try {
      const domains = ['.smzdm.com', 'smzdm.com', '.post.smzdm.com', 'post.smzdm.com']
      for (const domain of domains) {
        const cookies = await this.runtime.cookies.get(domain)
        const found = cookies.find(c => c.name === 'smzdm_id')
        if (found?.value) {
          logger.debug(`Got smzdm_id from cookie (${domain})`)
          return found.value
        }
      }
    } catch (error) {
      logger.debug('Failed to get smzdm_id from cookie:', error)
    }
    return null
  }

  /**
   * 精确模拟前端 getTextCount() 字数算法
   * 1. getText() 取得纯文本（无 HTML 标签）
   * 2. replace(/\s/g, '') 去掉所有空白字符（空格/换行/Tab）
   * 3. replace(/　/g, '') 去掉全角空格
   * 4. us(): 中文字符 +1、全角字符 +1、emoji ×2、ASCII 0.5/字符向上取整
   */
  private countWordLength(html: string): number {
    // 模拟 ProseMirror getText(): 去标签后取纯文本
    let text = html.replace(/<[^>]*>/g, '')
    // getTextCount: 去全部空白 + 全角空格
    text = text.replace(/\s/g, '').replace(/　/g, '').replace(/&nbsp;/g, '')

    // 统计中文字符（+1）
    const cnCount = (text.match(/[\u4e00-\u9fa5]/g) || []).length
    text = text.replace(/[\u4e00-\u9fa5]/g, '')
    // 统计全角字符（+1）
    const fullCount = (text.match(/[\u3000-\u303F\uFF00-\uFFEF\u201c\u201d\u2018\u2019\u2014\u2026\u2013\u3000\xa5]/g) || []).length
    text = text.replace(/[\u3000-\u303F\uFF00-\uFFEF\u201c\u201d\u2018\u2019\u2014\u2026\u2013\u3000\xa5]/g, '')
    // 统计 emoji（×2）
    const emojiCount = (text.match(/[\u2600-\u27BF\u2B50\u2705\u2728\u274C\u274E\u2753-\u2755\u2795-\u2797\u2764]|\uD83C[\uDF00-\uDFFF]|\uD83D[\uDC00-\uDE4F\uDE80-\uDEFF]|\uD83E[\uDD00-\uDDFF]/g) || []).length
    text = text.replace(/[\u2600-\u27BF\u2B50\u2705\u2728\u274C\u274E\u2753-\u2755\u2795-\u2797\u2764]|\uD83C[\uDF00-\uDFFF]|\uD83D[\uDC00-\uDE4F\uDE80-\uDEFF]|\uD83E[\uDD00-\uDDFF]/g, '')
    // ASCII: 0.5/字符 向上取整
    const asciiCount = Math.ceil(0.5 * text.length)

    return cnCount + fullCount + 2 * emojiCount + asciiCount
  }

  /**
   * 从 `get_token` API 获取 CSRF token（smzdm 编辑器真实机制）
   *
   * smzdm 编辑页是 SPA（页面 HTML 中不含 token），
   * 前端通过 `GET /api/editor/get_token` 动态获取，
   * 提交时放在请求头 `_csrf_token` 中。
   */
  private async getCsrfTokenFromApi(): Promise<string | null> {
    try {
      // 裸请求（useDefaultHeaders=false）：不携带伪造的 sec-ch-ua 系列头。
      // 此前带 fake sec-ch-ua（platform=macOS 与真实 Windows 环境矛盾）时
      // WAF 可能干扰 get_token 返回，导致 token 无效，进而 crop 报 error_code=7。
      const res = await (await this.fetchWithRetry(
        'https://post.smzdm.com/api/editor/get_token',
        {
          method: 'GET',
          credentials: 'include',
          headers: {
            'Accept': 'application/json, text/plain, */*',
          },
        },
        5,
        false
      )).json() as {
        error_code?: number | string
        error_msg?: string
        data?: { token?: string } | string
      }

      if (res.error_code === 0) {
        // 兼容两种返回结构：data: { token: 'xxx' } 或 data: 'xxx'（字符串 token）
        const token = typeof res.data === 'string' ? res.data : res.data?.token
        if (token) {
          logger.debug('Got CSRF token from get_token API')
          return token
        }
      }
      // 完整响应打印，便于诊断 token 获取失败的具体原因
      logger.warn('get_token API returned no token:', JSON.stringify(res).slice(0, 300))
    } catch (error) {
      logger.warn('Failed to get CSRF token from API:', (error as Error).message)
    }
    return null
  }

  /**
   * 从页面 HTML 提取 CSRF token
   * 支持多种常见格式:
   * - <meta name="csrf-token" content="xxx">
   * - window.csrfToken / window.csrf_token = 'xxx'
   * - {"csrf":"xxx"} / "csrf_token":"xxx" 等 JSON 字段
   * - csrfToken: 'xxx' 配置对象
   */
  private extractCsrfToken(pageText: string): string | null {
    // 常见格式：<meta name="csrf-token" content="xxx">
    const metaMatch = pageText.match(/<meta[^>]+name=["'](?:csrf-token|_token|csrf)["'][^>]+content=["']([^"']+)["']/i)
      || pageText.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["'](?:csrf-token|_token|csrf)["']/i)
    if (metaMatch) return metaMatch[1]

    // window.csrfToken / window.csrf_token = 'xxx'
    const varMatch = pageText.match(/window\.(?:csrfToken|csrf_token|_token|csrf)\s*=\s*["']([^"']+)["']/i)
    if (varMatch) return varMatch[1]

    // 配置对象: csrfToken: 'xxx' / csrf: 'xxx' / csrf_token: "xxx"
    const objMatch = pageText.match(/(?:csrfToken|csrf_token|csrf)\s*:\s*["']([^"']+)["']/i)
    if (objMatch && objMatch[1].length < 200) return objMatch[1]

    // JSON 深层字段: "csrf":"xxx" / "csrf_token":"xxx" / "csrfToken":"xxx"
    const deepMatch = pageText.match(/["']csrf(?:Token|_token)?["']\s*:\s*["']([^"']+)["']/i)
    if (deepMatch && deepMatch[1].length < 200) return deepMatch[1]

    return null
  }

  /**
   * 从 cookie 读取 CSRF token（smzdm 常存于 cookie）
   * 同时尝试多个域名格式和常见 cookie 名称
   */
  private async getCsrfTokenFromCookie(): Promise<string | null> {
    try {
      // 尝试多个域名格式（Chrome cookies.getAll 对前导点号的处理不一致）
      const domains = ['.smzdm.com', 'smzdm.com', '.post.smzdm.com', 'post.smzdm.com']
      const names = [
        'csrf_token', 'csrftoken', '_csrf', 'smzdm_csrf',
        'csrfToken', 'XSRF-TOKEN', 'token',
      ]

      for (const domain of domains) {
        const cookies = await this.runtime.cookies.get(domain)
        for (const name of names) {
          const found = cookies.find(c => c.name.toLowerCase() === name.toLowerCase())
          if (found?.value) {
            logger.debug(`Got CSRF token from cookie: ${name} (${domain})`)
            return found.value
          }
        }
      }
    } catch (error) {
      logger.debug('Failed to get CSRF from cookie:', error)
    }
    return null
  }

  /**
   * 带 WAF 挑战检测的请求（最多重试 5 次）
   */
  private async fetchWithRetry(
    url: string,
    options: RequestInit = {},
    maxRetries = 5,
    /**
     * 为 false 时不应用 REQUEST_HEADERS（例如调用方完全控制 headers）。
     * 默认为 true，保持原有行为。
     */
    useDefaultHeaders = true
  ): Promise<Response> {
    // useDefaultHeaders=false：仅使用 options.headers，适合需要“裸请求”
    // 的场景（如 smzdm /api/image/crop 会被 WAF 拦住任何 fake sec-ch-ua-*）
    const headers = useDefaultHeaders
      ? { ...REQUEST_HEADERS, ...(options.headers || {}) }
      : { ...(options.headers || {}) }
    const requestOptions: RequestInit = { ...options, headers }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const response = await this.runtime.fetch(url, requestOptions)
      const text = await response.clone().text()

      if (!isWafChallenge(text)) {
        return new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }

      logger.warn(`WAF challenge on attempt ${attempt}/${maxRetries}: ${url}`)
      if (attempt < maxRetries) {
        await delayWithJitter(1500 * attempt)
      }
    }

    throw new Error('请求被 WAF 拦截，请稍后重试')
  }

  async checkAuth(): Promise<AuthResult> {
    try {
      const pageText = await (await this.fetchWithRetry(
        'https://post.smzdm.com/tougao/',
        { credentials: 'include' }
      )).text()

      // 有效页面应包含 "release-new"（新建文章按钮）
      if (!pageText.includes('release-new')) {
        return { isAuthenticated: false, error: '未登录' }
      }

      // 提取用户名和头像
      const usernameMatch = pageText.match(/class="user-name[^"]*"[^>]*>([^<]+)</)
        || pageText.match(/nickname['"]\s*:\s*['"]([^'"]+)/)
      const username = usernameMatch ? usernameMatch[1].trim() : undefined

      const avatarMatch = pageText.match(/class="user-avatar[^"]*"[^>]*src="([^"]+)"/)
        || pageText.match(/avatar['"]\s*:\s*['"]([^'"]+)/)
      const avatar = avatarMatch ? avatarMatch[1] : undefined

      return { isAuthenticated: true, username, avatar }
    } catch (error) {
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  /**
   * 创建新文章（获取文章 ID，并从编辑页提取 CSRF token）
   */
  private async createNewArticle(): Promise<string> {
    const response = await this.fetchWithRetry(
      'https://post.smzdm.com/tougao/',
      { credentials: 'include' }
    )
    const pageText = await response.text()

    const articleMatch = pageText.match(/href="\/edit\/([^"]+)"\s+class="release-new"/)
      || pageText.match(/class="release-new"[^>]*href="\/edit\/([^"]+)"/)

    if (!articleMatch) {
      throw new Error('无法创建新文章，请确认已登录什么值得买')
    }

    const articleId = articleMatch[1]
    logger.debug('Created new article:', articleId)

    // CSRF token 获取（按优先级）:
    // 1. get_token API（smzdm 编辑器真实机制，SPA 页面无 HTML token）
    // 2. 编辑页 HTML 提取（兜底）
    // 3. cookie 提取（兜底）
    this._csrfToken = await this.getCsrfTokenFromApi()

    if (!this._csrfToken) {
      try {
        const editResponse = await this.fetchWithRetry(
          `https://post.smzdm.com/edit/${articleId}`,
          { credentials: 'include' }
        )
        const editHtml = await editResponse.text()
        this._csrfToken = this.extractCsrfToken(editHtml)
      } catch (error) {
        logger.warn('Failed to fetch edit page for CSRF:', error)
      }
    }

    if (!this._csrfToken) {
      this._csrfToken = await this.getCsrfTokenFromCookie()
    }

    if (this._csrfToken) {
      logger.debug('Extracted CSRF token')
    } else {
      logger.warn('CSRF token not found, submit may fail')
    }

    return articleId
  }

  /**
   * 确保存在 smzdm 文章编辑页 tab
   *
   * 背景：smzdm 的 `POST /api/image/crop` 接口对请求的 `Origin` 头极其严格，
   * 只接受 `https://post.smzdm.com`。但 MV3 Service Worker 的 fetch 会被 Chrome
   * 强制把 Origin 设为 `chrome-extension://<id>`，无法用 JS 覆盖，导致 WAF 拦截。
   *
   * 绕过思路：在 `https://post.smzdm.com/edit/<article_id>` 的 MAIN world 里 fetch，
   * origin 自动是 smzdm 域名，与用户手动在浏览器里点“确认此图”完全一致。
   */
  private async ensureSmzdmEditTab(articleId: string): Promise<number> {
    if (!this.runtime.tabs) {
      throw new Error('smzdm 封面裁剪需要浏览器 tabs API 支持（CLI 环境不支持封面裁剪）')
    }
    const urlPattern = `*://post.smzdm.com/edit/${articleId}*`
    const tabs = await this.runtime.tabs.query(urlPattern)
    if (tabs.length > 0 && tabs[0].id) {
      logger.debug(`Reusing smzdm edit tab: ${tabs[0].id}`)
      return tabs[0].id
    }
    logger.info(`No smzdm edit tab, creating one for article ${articleId}...`)
    const tab = await this.runtime.tabs.create(
      `https://post.smzdm.com/edit/${articleId}`,
      false
    )
    await this.runtime.tabs.waitForLoad(tab.id, 30000)
    // smzdm 是 SPA，等待 ProseMirror/编辑器初始化
    await delayWithJitter(1500)
    logger.info(`Smzdm edit tab created and loaded: ${tab.id}`)
    return tab.id
  }

  /**
   * 在 smzdm 编辑页 MAIN world 里调用 `/api/image/crop`
   *
   * 重要：
   * 1. FormData 不能跨 executeScript 边界传输，必须把 entry 转成 `[key, value][]`
   *    字符串对。crop 接口所有字段都是字符串（cutUrl/article_id/src_x/.../is_head），
   *    所以可以这么做。
   * 2. 在 MAIN world 调用 fetch，浏览器自动带上同源 cookie 和正确的 Origin/Referer。
   * 3. declarativeNetRequest 的 HEADER_RULES 作用域是 `initiatorDomains=[extension_id]`，
   *    只影响扩展自身（包括 Service Worker）发起的请求，**不会影响页面本身的 fetch**，
   *    所以无需 clearHeaderRules。
   * 4. 必须同时携带 `_csrf_token` 请求头：smzdm 后端依赖该 token
   *    识别“是否 smzdm 自己的 ProseMirror 上传”，未携带或 token 过期会返回
   *    `error_code=7, error_msg="上传成功", msg="网络不稳定，请稍后重试"`。
   */
  private async cropInEditTab<T = Record<string, unknown>>(
    articleId: string,
    formEntries: Array<[string, string]>,
    uploadId?: string | number
  ): Promise<T> {
    if (!this.runtime.tabs) {
      throw new Error('smzdm 封面裁剪需要浏览器 tabs API 支持')
    }
    const tabId = await this.ensureSmzdmEditTab(articleId)
    const url = 'https://post.smzdm.com/api/image/crop'

    logger.debug(`Executing crop in smzdm edit tab ${tabId}, ${formEntries.length} form fields, uploadId=${uploadId ?? 'none'}`)

    const result = await this.runtime.tabs.executeScript<
      {
        success: boolean
        data?: T
        error?: string
        // 诊断信息
        httpStatus?: number
        finalUrl?: string
        setCookie?: string
        fetchType?: string
        variantUsed?: string
        variantResults?: Array<{
          name: string
          httpStatus?: number
          ok: boolean
          response?: string
          error?: string
        }>
        pageContext?: Record<string, unknown> | null
        logs?: Array<{ event: string; payload: Record<string, unknown> }>
      },
      [string, Array<[string, string]>, boolean, string]
    >(
      tabId,
      async (requestUrl: string, entries: Array<[string, string]>, diag: boolean, uploadIdStr: string) => {
        // 注意：MAIN world 中 chrome.runtime 不可用（sendMessage 实际无效），
        // 诊断日志同时收集到 logs 数组，随 executeScript 返回值回传给扩展侧打印。
        const logs: Array<{ event: string; payload: Record<string, unknown> }> = []
        const log = (event: string, extra: Record<string, unknown> = {}): void => {
          if (!diag) return
          logs.push({ event, payload: { ...extra } })
          try {
            const g: any = globalThis
            g.chrome?.runtime?.sendMessage?.({
              type: 'SMZDM_CROP_DIAG',
              event,
              payload: { ...extra },
            })
          } catch {
            // MAIN world 无 chrome.runtime，忽略
          }
        }

        log('crop_script_started', { entriesCount: entries.length })

        // 探测页面上下文（结果随返回值回传，供核对 token/前端对象）
        let pageContext: Record<string, unknown> | null = null
        try {
          const g: any = globalThis
          // 探测前端暴露的全局 editor 对象（ProseMirror/Vue 封装实例），
          // 尝试从中找到前端自身的上传/裁剪函数入口
          const editorInfo: Record<string, unknown> = {}
          const ed = g.editor
          if (ed) {
            editorInfo.type = typeof ed
            try {
              editorInfo.keys = Object.keys(ed).slice(0, 100)
            } catch {
              editorInfo.keys = 'n/a'
            }
            try {
              const proto = Object.getPrototypeOf(ed)
              editorInfo.protoKeys = proto ? Object.getOwnPropertyNames(proto).slice(0, 100) : []
            } catch {
              editorInfo.protoKeys = 'n/a'
            }
            const children: Record<string, string[]> = {}
            if (typeof ed === 'object' && ed !== null) {
              for (const k of Object.keys(ed).slice(0, 30)) {
                try {
                  const child = ed[k]
                  if (child && typeof child === 'object') {
                    children[k] = Object.keys(child).slice(0, 30)
                  }
                } catch {
                  // 忽略无法枚举的子对象
                }
              }
            }
            editorInfo.children = children
            // 深挖 Vue 组件实例暴露的方法（exposed/exposeProxy 是组件对外接口）
            try {
              const cc = ed?.contentComponent
              const exposed = cc?.exposed
              const exposeProxy = cc?.exposeProxy
              if (exposed) editorInfo.exposedKeys = Object.keys(exposed).slice(0, 60)
              if (exposeProxy) editorInfo.exposeProxyKeys = Object.keys(exposeProxy).slice(0, 60)
            } catch {
              // 无 Vue 组件实例则跳过
            }
            try {
              const cm = ed?.commandManager
              if (cm?.rawCommands) editorInfo.rawCommandKeys = Object.keys(cm.rawCommands).slice(0, 80)
              if (cm?.customState) editorInfo.customStateKeys = Object.keys(cm.customState).slice(0, 80)
            } catch {
              // 无 commandManager 则跳过
            }
            try {
              const cb = ed?.callbacks
              if (cb) editorInfo.callbackKeys = Object.keys(cb).slice(0, 80)
            } catch {
              // 无 callbacks 则跳过
            }
          }
          pageContext = {
            cookies: document.cookie
              .split(';')
              .map((c) => c.split('=')[0].trim())
              .filter((n) => /csrf|token/i.test(n)),
            globals: Object.keys(g).filter((k) => /csrf|token|editor|upload|smzdm|crop/i.test(k)).slice(0, 40),
            hasInitialState: !!g.__INITIAL_STATE__,
            hasVue: !!g.Vue,
            editorInfo,
          }
        } catch (ctxError) {
          pageContext = { error: (ctxError as Error).message }
        }

        // 变体结果收集（try/catch 均需要引用，声明在外部）
        const variantResults: Array<{
          name: string
          httpStatus?: number
          ok: boolean
          response?: string
          error?: string
        }> = []

        try {
          // 基准请求头（对齐前端真实请求，见手动抓包）：
          // 前端 crop 请求不带 _csrf_token 和 x-requested-with，带 cache-control/pragma
          const baseFetchHeaders: Record<string, string> = {
            accept: 'application/json, text/plain, */*',
            'accept-language': 'zh-CN,zh;q=0.9',
            'cache-control': 'no-cache',
            pragma: 'no-cache',
          }

          // cutUrl 已是 SW 侧经 /api/image/original 换取的 tmpf 原始图 URL，直接使用
          const entriesObj: Record<string, string> = {}
          for (const [k, v] of entries) entriesObj[k] = v

          const clone = (patch: Record<string, string>): Record<string, string> => ({ ...entriesObj, ...patch })
          const entriesVariants: Array<{
            name: string
            obj: Record<string, string>
          }> = [
            { name: 'original-url', obj: clone({}) },
          ]

          let lastData: unknown = null
          let lastStatus = 0
          let variantUsed = 'none'

          for (let i = 0; i < entriesVariants.length; i++) {
            const v = entriesVariants[i]
            log('crop_variant_start', { index: i, name: v.name })
            // 变体间留出间隔，避免连续请求触发 WAF 限流
            if (i > 0) await new Promise((r) => setTimeout(r, 600))

            const body: BodyInit = (() => {
              const f = new FormData()
              for (const [k, val] of Object.entries(v.obj)) f.append(k, val)
              return f
            })()
            const headers: Record<string, string> = { ...baseFetchHeaders }

            let response: Response
            try {
              response = await fetch(requestUrl, {
                method: 'POST',
                credentials: 'include',
                headers,
                body,
              })
            } catch (fetchError) {
              variantResults.push({ name: v.name, ok: false, error: (fetchError as Error).message })
              continue
            }
            let data: unknown
            try {
              data = await response.json()
            } catch (parseError) {
              data = {
                error_code: -1,
                error_msg: `HTTP ${response.status}`,
                raw: (await response.text()).slice(0, 300),
              }
            }
            lastData = data
            lastStatus = response.status
            const d = data as { error_code?: number | string; data?: Array<{ pic_url?: string }> }
            const ok = d.error_code === 0 && Array.isArray(d.data) && !!d.data[0]?.pic_url
            const responseText = JSON.stringify(data).slice(0, 400)
            variantResults.push({ name: v.name, httpStatus: response.status, ok, response: responseText })
            log('crop_variant_done', {
              index: i,
              name: v.name,
              httpStatus: response.status,
              ok,
              response: responseText,
            })

            if (ok) {
              variantUsed = v.name
              return {
                success: true,
                data: data as T,
                httpStatus: response.status,
                finalUrl: response.url,
                setCookie: response.headers.get('set-cookie') || undefined,
                fetchType: response.type,
                variantUsed,
                variantResults,
                pageContext,
                logs,
              }
            }
          }

          // 所有变体均未成功：返回最后一个响应供上层报错/诊断
          return {
            success: true,
            data: lastData as T,
            httpStatus: lastStatus,
            variantUsed,
            variantResults,
            pageContext,
            logs,
          }
        } catch (error) {
          log('crop_outer_threw', { error: (error as Error).message })
          return {
            success: false,
            error: (error as Error).message,
            variantResults,
            pageContext,
            logs,
          }
        }
      },
      [url, formEntries, true, uploadId ? String(uploadId) : '']
    )

    if (!result || !result.success) {
      throw new Error((result as { error?: string })?.error || '封面裁剪请求失败')
    }

    // 诊断：打印 crop 接口返回的所有信息
    if (result.httpStatus !== undefined) {
      logger.debug(`Crop HTTP ${result.httpStatus}, finalUrl=${result.finalUrl}, setCookie=${result.setCookie || 'none'}, type=${result.fetchType}`)
    }
    logger.debug(`Crop response: ${JSON.stringify(result.data)}`)

    // 打印变体对比结果（MAIN world 的 sendMessage 通道在页面上下文不可用，
    // 诊断信息必须通过 executeScript 返回值回传）
    if (result.variantResults?.length) {
      for (const v of result.variantResults) {
        logger.debug(
          `Crop variant [${v.name}]: http=${v.httpStatus ?? '-'} ok=${v.ok} ${v.response ? v.response : v.error || ''}`
        )
      }
    }
    if (result.variantUsed) {
      logger.debug(`Crop variant used: ${result.variantUsed}`)
    }
    if (result.pageContext) {
      logger.debug(`Crop page context: ${JSON.stringify(result.pageContext).slice(0, 500)}`)
    }
    if (result.logs?.length) {
      for (const l of result.logs) {
        logger.debug(`CropDiag [${l.event}] ${JSON.stringify(l.payload).slice(0, 400)}`)
      }
    }

    return (result as { data: T }).data
  }

  /**
   * 通过 URL 上传图片
   * 支持 data URI：避免对 data: URI 调用 fetch（Chrome MV3 Service Worker 中
   * fetch(data:) 也能工作，但绕过 fetch 可以节省一次额外的 base64 编解码开销）
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    // data URI 直接转换，跳过 fetch
    let imageBlob: Blob
    if (src.startsWith('data:')) {
      const match = src.match(/^data:([^;]+);base64,(.+)$/)
      if (!match) {
        throw new Error('Invalid data URI format')
      }
      const mimeType = match[1]
      const base64 = match[2]
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
      }
      imageBlob = new Blob([bytes], { type: mimeType })
    } else {
      const imageResponse = await this.runtime.fetch(src)
      imageBlob = await imageResponse.blob()
    }

    if (!this._currentArticleId) {
      throw new Error('上传图片需要先创建文章')
    }

    const formData = new FormData()
    formData.append('imgFile', imageBlob, 'WU_FILE_0')
    formData.append('type', imageBlob.type || 'image/png')
    formData.append('article_id', this._currentArticleId)
    formData.append('insert', '1')
    formData.append('storage', '1')
    formData.append('size', String(imageBlob.size))

    const uploadRes = await (await this.fetchWithRetry(
      'https://post.smzdm.com/api/images/upload/local',
      {
        method: 'POST',
        credentials: 'include',
        body: formData,
      }
    )).json() as {
      error_code?: number | string
      error_msg?: string
      data?: { url?: string }
    }

    if (uploadRes.error_code !== 0 || !uploadRes.data?.url) {
      throw new Error(`图片上传失败: ${uploadRes.error_msg || JSON.stringify(uploadRes)}`)
    }

    logger.debug(`Image uploaded: ${uploadRes.data.url}`)
    return { url: uploadRes.data.url }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    const timestamp = Date.now()

    return this.withHeaderRules(this.HEADER_RULES, async () => {
      try {
        // 1. 创建新文章
        const articleId = await this.createNewArticle()
        this._currentArticleId = articleId

        // 等待页面处理
        await delayWithJitter(800)

        // 2. 处理图片（上传到当前文章）
        let content = article.html || ''
        content = await this.processImages(
          content,
          (src) => this.uploadImageByUrl(src),
          {
            skipPatterns: ['zdmimg.com', 'smzdm.com'],
            onProgress: options?.onImageProgress,
          }
        )

        // 2.5 处理封面图
        // smzdm 封面分为两种：
        //  - 长图（cover_image_rectangle）：文章详情页用，建议 1484×628（比例 2.36:1）
        //  - 方图（cover_image_square / focus_image）：首页列表、社区列表用
        // smzdm 服务端会裁剪出两种尺寸，所以先调 /api/images/upload/local 拿到原始
        // tmpf URL，再调 /api/image/crop 让服务端裁剪。返回的 pic_url 为长图，
        // square_pic_url 为方图。
        // CLI 在同步时把本地图转为 data URI 传入 article.cover（见 packages/cli/src/index.ts），
        // 这里的逻辑统一处理 data URI、http URL 以及 smzdm 域名 URL：
        //  - data URI / 其他 URL：先上传再裁剪
        //  - 已是 smzdm 图床 URL：直接复用，但尺寸裁剪仍需重新走一次 crop（未知原图尺寸
        //    时跳过裁剪，只填原 URL，方图仍可显示，长图会被平台拒绝
        //    ——这种情况下提示用户手动上传封面）
        let focusImage = ''
        let coverImageRect = ''
        let coverImageSquare = ''
        if (article.cover) {
          if (/(?:^|\.)zdmimg\.com|(?:^|\.)smzdm\.com|(?:^|\.)tmpf\.smzdm\.com/.test(article.cover)) {
            // 已是 smzdm 图床 URL，无法读取原图尺寸 → 只能填方图位置
            focusImage = article.cover
            coverImageSquare = article.cover
            logger.debug(`Cover already on smzdm CDN (skip crop): ${focusImage}`)
            logger.warn('Cover is a smzdm URL with unknown dimensions; long cover will be empty')
          } else {
            try {
              // 1. 转 Blob
              let coverBlob: Blob
              if (article.cover.startsWith('data:')) {
                const match = article.cover.match(/^data:([^;]+);base64,(.+)$/)
                if (!match) {
                  throw new Error('Invalid data URI format')
                }
                const mimeType = match[1]
                const base64 = match[2]
                const binary = atob(base64)
                const bytes = new Uint8Array(binary.length)
                for (let i = 0; i < binary.length; i++) {
                  bytes[i] = binary.charCodeAt(i)
                }
                coverBlob = new Blob([bytes], { type: mimeType })
              } else {
                const imgRes = await this.runtime.fetch(article.cover)
                coverBlob = await imgRes.blob()
              }

              // 2. 上传原图 + 换取 tmpf 原始图 URL。
              // 前端完整流程（见手动抓包）：
              //   upload/local（imgFile+id=WU_FILE_0+type+article_id，无 insert/storage/size）
              //   → /api/image/original（article_id + am URL 换 tmpf 原始图 URL）
              //   → /api/image/crop（cutUrl 必须用 tmpf 域名 URL，am 域名会报 error_code=7）
              const dimensions = await getImageDimensions(coverBlob)

              const uploadForm = new FormData()
              uploadForm.append('imgFile', coverBlob, 'cover.jpg')
              uploadForm.append('id', 'WU_FILE_0')
              uploadForm.append('type', coverBlob.type || 'image/png')
              uploadForm.append('article_id', articleId)

              const uploadRes = await (await this.fetchWithRetry(
                'https://post.smzdm.com/api/images/upload/local',
                { method: 'POST', credentials: 'include', body: uploadForm }
              )).json() as {
                error_code?: number | string
                error_msg?: string
                data?: { url?: string; small_pic?: string; id?: number | string }
              }
              if (uploadRes.error_code !== 0 || !uploadRes.data?.url) {
                throw new Error(`封面原图上传失败: ${uploadRes.error_msg || JSON.stringify(uploadRes)}`)
              }
              logger.debug(`Cover upload response: ${JSON.stringify(uploadRes).slice(0, 400)}`)

              // 前端随后调 /api/image/original：用 article_id + am URL 换取 tmpf 原始图 URL
              type OriginalResp = {
                error_code?: number | string
                error_msg?: string
                data?: { original_url?: string; width?: number; height?: number }
              }
              const originalBody = `article_id=${encodeURIComponent(articleId)}&pic_url=${encodeURIComponent(uploadRes.data.url)}`
              const originalRes = await (await this.fetchWithRetry(
                'https://post.smzdm.com/api/image/original',
                {
                  method: 'POST',
                  credentials: 'include',
                  headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                  body: originalBody,
                }
              )).json() as OriginalResp
              logger.debug(`Image original response: ${JSON.stringify(originalRes).slice(0, 400)}`)
              const originalUrl = originalRes.data?.original_url || uploadRes.data.url
              if (!originalRes.data?.original_url) {
                logger.warn('image/original did not return original_url, crop may fail with error_code=7')
              }
              logger.debug(`Cover original uploaded: ${originalUrl} (${dimensions.width}x${dimensions.height})`)

              // 3. 调用 crop 接口生成两种尺寸
              // 长图比例 1484:628 ≈ 2.36:1（smzdm 建议尺寸）
              const targetRatio = 1484 / 628
              const originalRatio = dimensions.width / dimensions.height

              let srcX = 0
              let srcY = 0
              let srcW = dimensions.width
              let srcH = dimensions.height

              if (originalRatio > targetRatio) {
                // 原图更宽，裁剪左右两侧保留中间
                srcW = dimensions.height * targetRatio
                srcX = (dimensions.width - srcW) / 2
              } else if (originalRatio < targetRatio) {
                // 原图更高，裁剪上下两侧保留中间
                srcH = dimensions.width / targetRatio
                srcY = (dimensions.height - srcH) / 2
              }
              // 比例正好则不裁剪

              // 输出尺寸：前端真实请求的 size_w/h 是“显示尺寸”（裁剪弹窗中图片显示
              // 宽度 416px），而非输出尺寸；后端按 src_w/h 与 size_w/h 比例校验。
              const displayW = 416
              const displayH = (displayW * srcH) / srcW

              const cropperData = {
                x: srcX,
                y: srcY,
                width: srcW,
                height: srcH,
                rotate: 0,
                scaleX: 1,
                scaleY: 1,
              }

              const cropForm = new FormData()
              cropForm.append('cut_pic_list[0][src_x]', String(srcX))
              cropForm.append('cut_pic_list[0][src_y]', String(srcY))
              cropForm.append('cut_pic_list[0][src_w]', String(srcW))
              cropForm.append('cut_pic_list[0][src_h]', String(srcH))
              cropForm.append('cut_pic_list[0][article_id]', articleId)
              cropForm.append('cut_pic_list[0][size_w]', String(displayW))
              cropForm.append('cut_pic_list[0][size_h]', String(displayH))
              cropForm.append('cut_pic_list[0][cropperData]', JSON.stringify(cropperData))
              cropForm.append('cut_pic_list[0][original_pic_height]', String(dimensions.height))
              cropForm.append('cut_pic_list[0][original_pic_width]', String(dimensions.width))
              cropForm.append('cut_pic_list[0][cutUrl]', originalUrl)
              cropForm.append('cut_pic_list[0][is_head]', '1')

              // 把 FormData 转成可序列化 entries（executeScript 跨 context 不能传 FormData）
              const cropEntries: Array<[string, string]> = []
              cropForm.forEach((value, key) => {
                if (typeof value === 'string') {
                  cropEntries.push([key, value])
                }
              })
              logger.debug(`Crop entries: ${JSON.stringify(cropEntries).slice(0, 600)}`)

              // crop 接口 WAF 极严格：URL=https://post.smzdm.com/api/image/crop。
              // MV3 Service Worker 的 fetch 会被 Chrome 强制设 Origin=chrome-extension://...，
              // smzdm WAF 检测到 origin 非浏览器域名直接返回 error_code=7。
              // 解决：在编辑页 https://post.smzdm.com/edit/<article_id> 的 MAIN world
              // 执行 fetch，此时 origin 自动是 https://post.smzdm.com，可绕过 WAF。
              type CropResponse = {
                error_code?: number | string
                error_msg?: string
                data?: Array<{
                  pic_url?: string
                  square_pic_url?: string
                }>
              }
              let cropRes: CropResponse
              try {
                // 前端真实 crop 请求不带 _csrf_token 头（见手动抓包），无需获取 token
                cropRes = await this.cropInEditTab<CropResponse>(articleId, cropEntries, uploadRes.data.id)
              } catch (cropError) {
                logger.warn(`Crop via MAIN world failed: ${(cropError as Error).message}`)
                throw cropError
              }

              if (cropRes.error_code !== 0 || !cropRes.data?.[0]?.pic_url) {
                throw new Error(`封面裁剪失败: ${cropRes.error_msg || JSON.stringify(cropRes)}`)
              }
              const picUrl = cropRes.data[0].pic_url
              const squarePicUrl = cropRes.data[0].square_pic_url || picUrl
              focusImage = squarePicUrl
              coverImageRect = picUrl
              coverImageSquare = squarePicUrl
              logger.debug(`Cover cropped: long=${picUrl} square=${squarePicUrl}`)
            } catch (error) {
              logger.warn(`Failed to upload cover: ${(error as Error).message}`)
              // 降级：不阻断草稿保存，草稿仍可在 smzdm 编辑器里手动选择封面
            }
          }
        }

        // 3. 保存草稿（前端实际用 form-urlencoded 提交，awne/wne 为 form 字段，
        //    已用官方真实请求校准签名算法）
        const formData = new URLSearchParams()
        formData.append('article_id', articleId)
        formData.append('submit_type', 'auto_save')
        formData.append('title', article.title)
        formData.append('editorValue', content)
        formData.append('series_title', '')
        formData.append('focus_image', focusImage)
        formData.append('series_order_id', '0')
        formData.append('series_id', '0')
        formData.append('anonymous', '0')
        formData.append('first_publish', '0')
        formData.append('remark', '')
        formData.append('create_state_type', '3')
        formData.append('ai_state_type', '3')
        formData.append('square_pic_url', focusImage)
        formData.append('cover_image_rectangle', coverImageRect)
        formData.append('cover_image_square', coverImageSquare)
        formData.append('custom_topics', '')
        formData.append('group_id', '')

        // CSRF token 在提交前重新获取（前端 JS 每次提交都调用 get_token，
        // token 为一次性/短时效，创建文章时获取的 token 在上传图片后可能已失效）
        const csrfToken = await this.getCsrfTokenFromApi() || this._csrfToken

        // 缺失时直接报错（避免携带空 token 提交导致服务端返回模糊的 "CSRF token缺失"）
        if (!csrfToken) {
          throw new Error('CSRF token 获取失败，请确认已登录什么值得买并稍后重试')
        }

        // 计算 awne/wne 风控签名（前端缺失时服务端返回"网络不稳定"）
        // 需要先获取 smzdm_id，再根据正文字数生成签名
        const smzdmId = await this.getSmzdmIdFromCookie()
        if (smzdmId) {
          const wne = this.countWordLength(content)
          try {
            const awne = await computeAwne(smzdmId, wne)
            formData.append('awne', awne)
            formData.append('wne', String(wne))
            logger.debug(`awne signature: ${awne.substring(0, 12)}... (wne=${wne})`)
          } catch (error) {
            logger.warn('Failed to compute awne signature:', (error as Error).message)
          }
        } else {
          logger.warn('smzdm_id cookie not found, awne signature will be empty')
        }

        // 前端编辑器使用 `_csrf_token` 请求头传递 token（非 X-CSRF-Token）
        const saveHeaders: Record<string, string> = {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          '_csrf_token': csrfToken,
          'X-Requested-With': 'XMLHttpRequest',
        }

        const saveRes = await (await this.fetchWithRetry(
          'https://post.smzdm.com/api/editor/article/submit',
          {
            method: 'POST',
            credentials: 'include',
            headers: saveHeaders,
            body: formData.toString(),
          }
        )).json() as {
          error_code?: number | string
          error_msg?: string
          data?: unknown
        }

        if (saveRes.error_code !== 0) {
          throw new Error(`保存草稿失败: ${saveRes.error_msg || JSON.stringify(saveRes)}`)
        }

        logger.debug('Draft saved:', saveRes.data)

        return {
          platform: this.meta.id,
          success: true,
          postId: articleId,
          postUrl: `https://post.smzdm.com/edit/${articleId}`,
          draftOnly: true,
          timestamp,
        }
      } catch (error) {
        return {
          platform: this.meta.id,
          success: false,
          error: (error as Error).message,
          timestamp,
        }
      } finally {
        this._currentArticleId = null
      }
    })
  }
}