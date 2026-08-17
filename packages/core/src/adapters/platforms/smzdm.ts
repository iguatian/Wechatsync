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
      const res = await (await this.fetchWithRetry(
        'https://post.smzdm.com/api/editor/get_token',
        {
          method: 'GET',
          credentials: 'include',
          headers: {
            'Accept': 'application/json, text/plain, */*',
          },
        }
      )).json() as {
        error_code?: number | string
        error_msg?: string
        data?: { token?: string }
      }

      if (res.error_code === 0 && res.data?.token) {
        logger.debug('Got CSRF token from get_token API')
        return res.data.token
      }
      logger.warn('get_token API returned no token:', res.error_msg || JSON.stringify(res))
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
    maxRetries = 5
  ): Promise<Response> {
    const headers = { ...REQUEST_HEADERS, ...(options.headers || {}) }
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
   * 通过 URL 上传图片
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const imageResponse = await this.runtime.fetch(src)
    const imageBlob = await imageResponse.blob()

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

        // 3. 保存草稿（前端实际用 form-urlencoded 提交，awne/wne 为 form 字段，
        //    已用官方真实请求校准签名算法）
        const formData = new URLSearchParams()
        formData.append('article_id', articleId)
        formData.append('submit_type', 'auto_save')
        formData.append('title', article.title)
        formData.append('editorValue', content)
        formData.append('series_title', '')
        formData.append('focus_image', '')
        formData.append('series_order_id', '0')
        formData.append('series_id', '0')
        formData.append('anonymous', '0')
        formData.append('first_publish', '0')
        formData.append('remark', '')
        formData.append('create_state_type', '3')
        formData.append('ai_state_type', '3')
        formData.append('square_pic_url', '')
        formData.append('cover_image_rectangle', '')
        formData.append('cover_image_square', '')
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