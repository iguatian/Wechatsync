/**
 * 抖音图文适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'
import { crc32 } from '../../lib/aws4'

const logger = createLogger('Douyin')

/**
 * 计算 SHA-256 并以十六进制字符串返回（用于 x-amz-content-sha256 头）。
 */
async function sha256Hex(message: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(message),
  )
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * HMAC-SHA256（基于 Web Crypto，扩展 background 可用）
 */
async function hmacSha256(key: string | ArrayBuffer, message: string): Promise<ArrayBuffer> {
  const keyData = typeof key === 'string' ? new TextEncoder().encode(key) : key
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message))
}

/**
 * ArrayBuffer → 小写十六进制字符串
 */
function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// GET 请求（无 body）的 payload hash：SHA-256("")
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/**
 * 计算 imagex 请求的 AWS4-HMAC-SHA256 Authorization 头（与官方前端一致）。
 *
 * 官方请求的 SignedHeaders 仅含 x-amz-* 头（不含 host），签名密钥为 auth v5
 * 返回的 SecretAccessKey，Credential 为 AccessKeyID，区域/服务固定为
 * cn-north-1/imagex。缺失或无效的 Authorization 头会被服务端拒绝，
 * 返回 400 InvalidAuthorization (Code 100024)。
 */
async function signImageXV4(opts: {
  accessKeyId: string
  secretAccessKey: string
  method: string
  url: string
  headers: Record<string, string>
  payloadHash: string
}): Promise<string> {
  const region = 'cn-north-1'
  const service = 'imagex'
  const amzDate = opts.headers['x-amz-date']
  const date = amzDate.slice(0, 8)

  const parsed = new URL(opts.url)
  // AWS 规范：query 参数按 key 升序排列并做 URI 编码（与 URL 中的原始顺序无关）
  const canonicalQuery = [...parsed.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')

  // 仅签名 x-amz-* 头（与官方 SignedHeaders 一致），header 值需规范化
  const signedHeaderNames = Object.keys(opts.headers)
    .filter((h) => h.startsWith('x-amz-'))
    .sort()
  const canonicalHeaders = signedHeaderNames
    .map((h) => `${h}:${opts.headers[h].trim().replace(/\s+/g, ' ')}\n`)
    .join('')
  const signedHeaders = signedHeaderNames.join(';')

  const canonicalRequest = [
    opts.method,
    parsed.pathname || '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    opts.payloadHash,
  ].join('\n')

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    `${date}/${region}/${service}/aws4_request`,
    await sha256Hex(canonicalRequest),
  ].join('\n')

  const kDate = await hmacSha256('AWS4' + opts.secretAccessKey, date)
  const kRegion = await hmacSha256(kDate, region)
  const kService = await hmacSha256(kRegion, service)
  const kSigning = await hmacSha256(kService, 'aws4_request')
  const signature = toHex(await hmacSha256(kSigning, stringToSign))

  return `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${date}/${region}/${service}/aws4_request, SignedHeaders=${signedHeaders}, Signature=${signature}`
}

// 抖音 AI 辅助常量
const IMAGEX_SERVICE_ID = 'jm8ajry58r'
const DOUYIN_AID = '1128'

/**
 * 生成 creationId
 */
function generateCreationId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < 8; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result + Date.now().toString()
}

interface STSInfo {
  AccessKeyID: string
  SecretAccessKey: string
  SessionToken: string
  ExpiredTime: string | number
  /** 从 STS SessionToken 的 PolicyString 中提取的字节系 user_id */
  userId?: string
}

/**
 * 从 STS2 SessionToken 中解析 user_id。
 *
 * 字节系 STS2 token 是 STS2 + base64(JSON) 形式，payload 形如：
 * {
 *   PolicyString: '{"Statement":[{"Condition":"{\"UserId\":\"...\"}"}]}'
 * }
 * Condition 字段是双重字符串化的 JSON，可从中拿到当前登录用户的 user_id。
 * 该参数在 ApplyImageUpload / CommitImageUpload 中是必填（缺失时服务端会拒绝）。
 */
function parseUserIdFromSTS(sessionToken: string): string {
  if (!sessionToken || !sessionToken.startsWith('STS2')) return ''
  try {
    const b64 = sessionToken.slice(4).replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const decoded = atob(padded)
    const obj = JSON.parse(decoded) as { PolicyString?: string }
    if (!obj.PolicyString) return ''
    const policy = JSON.parse(obj.PolicyString) as {
      Statement?: Array<{ Condition?: string }>
    }
    const condStr = policy.Statement?.[0]?.Condition
    if (typeof condStr !== 'string') return ''
    const cond = JSON.parse(condStr) as { UserId?: string }
    return cond.UserId || ''
  } catch {
    return ''
  }
}

/** 字节系 imagex 的 app_id，HAR 抓取固定值 */
const IMAGEX_APP_ID = '2906'

/**
 * 生成官方前端同款的 11 位随机 s 参数（0-9a-z）。
 *
 * 抖音前端调用 ApplyImageUpload 时 URL 末尾必带 s 参数（HAR 抓包确认，
 * 每个请求随机生成，如 &s=qmfjm06kd0h）。缺失时服务端会回退按 AWS4
 * Authorization 头校验，返回 400 InvalidAuthorization (Code 100024)。
 */
function generateRandomS(): string {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz'
  let result = ''
  for (let i = 0; i < 11; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}

/**
 * 解析 STS 过期时间。服务端返回的 ExpiredTime 可能是 ISO 字符串，
 * 也可能是秒级 Unix 时间戳（如 1787817811），统一转为毫秒。
 */
function parseSTSExpiry(expiredTime: string | number): number {
  if (typeof expiredTime === 'number') {
    // 秒级时间戳转毫秒；毫秒级则原样使用
    return expiredTime < 1e12 ? expiredTime * 1000 : expiredTime
  }
  return new Date(expiredTime).getTime()
}

interface ImageInfo {
  key: string
  value: {
    url: string
    width: number
    height: number
  }
}

/**
 * 图片上传地址结果
 */
interface UploadAddressResult {
  StoreInfos?: Array<{ StoreUri: string; Auth?: string }>
  UploadHosts?: string[]
  SessionKey: string
}

export class DouyinAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'douyin',
    name: '抖音图文',
    icon: 'https://lf1-cdn-tos.bytegoofy.com/goofy/ies/douyin_web/public/favicon.ico',
    homepage: 'https://creator.douyin.com',
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  /** 预处理配置: 抖音使用 Markdown 格式 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  private cachedSTS: STSInfo | null = null
  private stsExpiry = 0

  /** 抖音 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://imagex.bytedanceapi.com/*',
      headers: {
        'Origin': 'https://creator.douyin.com',
        'Referer': 'https://creator.douyin.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://tos-hl-x.snssdk.com/*',
      headers: {
        'Origin': 'https://creator.douyin.com',
        'Referer': 'https://creator.douyin.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      const cookies = await this.runtime.cookies.get('.douyin.com')
      const passportCookie = cookies.find(c => c.name === 'passport_assist_user')
      return passportCookie?.value
        ? { isAuthenticated: true }
        : { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      let content = article.markdown || ''
      const imageInfos: ImageInfo[] = []

      // 处理图片
      content = await this.processImages(
        content,
        async (src) => {
          const result = await this.uploadImageFull(src)
          if (result.imageInfo) {
            imageInfos.push(result.imageInfo)
          }
          return { url: result.storeUri }
        },
        {
          skipPatterns: ['douyin.com', 'snssdk.com', 'byteimg.com', 'bytedanceapi.com', 'jm8ajry58r'],
          onProgress: options?.onImageProgress,
        }
      )

      // 抖音图文字数限制 8000
      let truncated = false
      if (content.length > 8000) {
        content = content.slice(0, 8000)
        truncated = true
        logger.warn('Content truncated to 8000 chars for Douyin limit')
      }

      // 处理封面图。新版抖音 draft 协议中封面识别依赖：
      //   - item.common.draft.head_poster  (兼容字段，HTTPS 预览 URL)
      //   - item.common.draft.poster        (StoreUri，tos-cn-i-xxx/yyy)
      //   - item.common.draft.temporary_data (封面编辑器状态，coverEditor JSON)
      //   - item.cover.{poster, custom_cover_image_{width,height}}
      // 抖音图床 URL（byteimg/snssdk/douyinpic）直接复用 StoreUri，避免重复上传。
      let coverInfo: {
        storeUri: string
        previewUrl: string
        width: number
        height: number
      } | null = null
      if (article.cover) {
        const isDouyinHosted =
          /(?:^|\.)snssdk\.com|(?:^|\.)byteimg\.com|jm8ajry58r|(?:^|\.)douyinpic\.com/i.test(article.cover)
        // 抖音图床 URL 通常形如 https://p3-sign.douyinpic.com/...~tplv-jm8ajry58r-image.jpeg
        // 或 https://p0-creator-media-private.douyin.com/tos-cn-i-jm8ajry58r/{key}~tplv-...
        const storeUriMatch = article.cover.match(/tos-cn-i-jm8ajry58r\/([0-9a-f]{20,})/i)
        if (isDouyinHosted && storeUriMatch) {
          coverInfo = {
            storeUri: `tos-cn-i-jm8ajry58r/${storeUriMatch[1]}`,
            previewUrl: article.cover,
            width: 0,
            height: 0,
          }
          logger.debug('Cover already on Douyin CDN, reuse:', coverInfo.storeUri)
        } else if (isDouyinHosted) {
          coverInfo = {
            storeUri: article.cover,
            previewUrl: article.cover,
            width: 0,
            height: 0,
          }
          logger.debug('Cover on Douyin CDN (no storeUri extracted), reuse URL:', coverInfo.storeUri)
        } else {
          try {
            const coverResult = await this.uploadImageFull(article.cover)
            coverInfo = {
              storeUri: coverResult.storeUri,
              previewUrl: coverResult.imageInfo?.value.url || coverResult.storeUri,
              width: coverResult.imageInfo?.value.width || 0,
              height: coverResult.imageInfo?.value.height || 0,
            }
            logger.debug('Cover uploaded:', coverInfo)
          } catch (e) {
            logger.warn('Failed to upload cover:', e)
          }
        }
      }

      const creationId = generateCreationId()
      const initTimestamp = Math.floor(Date.now() / 1000)

      // 抖音封面编辑器状态：paster (装饰/标题贴纸) + background (背景图)
      // 浏览器在选择封面后会上传一张背景图，这里把封面图同时作为 background，
      // 还原抖音前端保存草稿时的 minimal 状态。
      const buildCoverEditor = (
        uri: string,
        width: number,
        height: number,
      ): string => {
        return JSON.stringify({
          paster: {
            list: [
              {
                width: 0,
                height: 0,
                top: 100,
                left: 0,
                rotateAngle: 0,
                fontId: null,
                fontName: '经典字体',
                text: '',
                shadowOpacityIndex: 0,
                textAlignIndex: 0,
                color: {
                  color: '#ffffff',
                  transparent: { color: '#ffffff' },
                  deep: { color: '#000000', background: '#ffffff' },
                  light: { color: '#ffffff', background: 'rgba(255, 255, 255, .6)' },
                },
                coverTop: 0,
                coverLeft: 0,
                id: 'mt8dojbi2s',
                style: {},
              },
            ],
            currentId: 'mt8dojbi2s',
          },
          background: {
            uri,
            width,
            height,
          },
        })
      }

      const payload = {
        item: {
          common: {
            draft: {
              title: article.title,
              description: '',
              long_article: content,
              image_info: imageInfos,
              // 兼容字段：HTTPS 预览 URL（旧版抖音使用）
              head_poster: coverInfo?.previewUrl || '',
              // 新字段：抖音新版封面识别依赖 item.cover.poster
              poster: coverInfo?.storeUri || '',
              // 封面编辑器状态（包含 background 与 paster）
              temporary_data: coverInfo
                ? buildCoverEditor(coverInfo.storeUri, coverInfo.width, coverInfo.height)
                : '',
              text_extra: '[]',
              visibility_type: 0,
              timing: 0,
              creation_id: creationId,
              init_timestamp: initTimestamp,
              req_type: 0,
            },
          },
          // 新版封面识别的关键位置（item.cover.poster + 尺寸）
          cover: coverInfo
            ? {
                poster: coverInfo.storeUri,
                custom_cover_image_width: coverInfo.width,
                custom_cover_image_height: coverInfo.height,
              }
            : {},
        },
      }

      const res = await this.executeInDouyinTab<{
        status_code?: number
        status_msg?: string
      }>(
        `https://creator.douyin.com/web/api/media/aweme/draft/?read_aid=2906&aid=${DOUYIN_AID}`,
        'POST',
        payload
      )

      if (res.status_code !== 0) {
        throw new Error(res.status_msg || '保存草稿失败')
      }

      logger.info('Draft saved successfully')

      const draftUrl = `https://creator.douyin.com/creator-micro/content/post/article?enter_from=draft&creation_id=${creationId}&init_timestamp=${initTimestamp}`

      return this.createResult(true, {
        postUrl: draftUrl,
        draftOnly: options?.draftOnly ?? true,
        message: truncated ? '内容已截断至 8000 字（抖音图文字数限制）' : undefined,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * 确保存在抖音创作者 tab
   */
  private async ensureDouyinTab(): Promise<number> {
    if (!this.runtime.tabs) {
      throw new Error('抖音发布需要浏览器 tabs API 支持')
    }
    const tabs = await this.runtime.tabs.query('https://creator.douyin.com/*')
    if (tabs.length > 0 && tabs[0].id) {
      return tabs[0].id
    }
    logger.info('No existing tab found, creating new one...')
    const tab = await this.runtime.tabs.create(
      'https://creator.douyin.com/creator-micro/content/post/article',
      false
    )
    await this.runtime.tabs.waitForLoad(tab.id, 30000)
    logger.info('New tab created and loaded:', tab.id)
    return tab.id
  }

  /**
   * 在抖音页面上下文中执行请求
   * @param headers 额外请求头（如 imagex 的 x-amz-* 鉴权头）
   */
  private async executeInDouyinTab<T = Record<string, unknown>>(
    url: string,
    method: 'GET' | 'POST',
    body?: unknown,
    headers?: Record<string, string>
  ): Promise<T> {
    if (!this.runtime.tabs) {
      throw new Error('抖音发布需要浏览器 tabs API 支持')
    }
    const tabId = await this.ensureDouyinTab()
    logger.debug('Using tab:', tabId, 'for', method, url.substring(0, 80))

    const result = await this.runtime.tabs.executeScript(
      tabId,
      async (
        requestUrl: string,
        requestMethod: string,
        requestBody: string | null,
        requestHeaders: Record<string, string> | null
      ) => {
        try {
          const options: RequestInit = {
            method: requestMethod,
            // same-origin：同源请求（auth v5/草稿）自动带 cookie；
            // 跨域请求（imagex）不带 cookie，与官方页面行为一致
            credentials: 'same-origin',
          }
          if (requestHeaders) {
            options.headers = requestHeaders
          }
          if (requestBody) {
            options.headers = {
              ...(options.headers as Record<string, string>),
              'Content-Type': 'application/json',
            }
            options.body = requestBody
          }
          const response = await fetch(requestUrl, options)
          return { success: true, data: await response.json() }
        } catch (error) {
          return { success: false, error: (error as Error).message }
        }
      },
      [url, method, body ? JSON.stringify(body) : null, headers ?? null]
    )

    if (!result || !result.success) {
      throw new Error((result as { error?: string })?.error || '请求失败')
    }
    return (result as { data: T }).data
  }

  /**
   * 获取 STS 上传凭证
   */
  private async getSTSCredentials(): Promise<STSInfo> {
    if (this.cachedSTS && Date.now() < this.stsExpiry - 60000) {
      return this.cachedSTS
    }

    const res = await this.executeInDouyinTab<{
      status_code?: number
      status_msg?: string
      auth?: string
    }>(`https://creator.douyin.com/web/api/media/upload/auth/v5/?aid=${DOUYIN_AID}`, 'GET')

    if (res.status_code !== 0 || !res.auth) {
      throw new Error('获取上传凭证失败')
    }

    const sts = JSON.parse(res.auth) as STSInfo
    if (!sts.AccessKeyID || !sts.SecretAccessKey) {
      throw new Error('上传凭证无效')
    }

    // 从 STS SessionToken 提取 user_id（ApplyImageUpload 必填）
    sts.userId = parseUserIdFromSTS(sts.SessionToken)
    if (!sts.userId) {
      logger.warn('Failed to parse user_id from STS, image upload may fail')
    }

    this.cachedSTS = sts
    this.stsExpiry = parseSTSExpiry(sts.ExpiredTime)
    logger.debug('Got STS credentials, expires:', sts.ExpiredTime, 'user_id:', sts.userId)
    return this.cachedSTS
  }

  /**
   * 完整上传图片流程：STS 凭证 → ApplyImageUpload → TOS 上传 → CommitImageUpload → 预览 URL
   */
  private async uploadImageFull(src: string): Promise<{ storeUri: string; imageInfo?: ImageInfo }> {
    let blob: Blob
    if (src.startsWith('data:')) {
      blob = await fetch(src).then(r => r.blob())
    } else {
      const response = await this.runtime.fetch(src, { method: 'GET' })
      if (!response.ok) {
        logger.warn('Failed to download image:', response.status)
        return { storeUri: src }
      }
      blob = await response.blob()
    }

    const sts = await this.getSTSCredentials()
    const uploadAddress = await this.applyImageUpload(sts)
    const storeUri = uploadAddress.StoreInfos?.[0]?.StoreUri
    if (!storeUri) {
      throw new Error('No store URI in upload address')
    }
    logger.debug('Apply upload success, storeUri:', storeUri)

    await this.uploadToTOS(uploadAddress, blob)

    const commitResult = await this.commitImageUpload(sts, uploadAddress.SessionKey)
    const pluginResult = commitResult.PluginResult?.[0]
    const previewUrl = await this.getImagePreviewUrl(storeUri)

    const imageInfo: ImageInfo = {
      key: storeUri,
      value: {
        url: previewUrl,
        width: pluginResult?.ImageWidth || 0,
        height: pluginResult?.ImageHeight || 0,
      },
    }
    logger.debug('Image uploaded:', storeUri, `(${imageInfo.value.width}x${imageInfo.value.height})`)

    return { storeUri, imageInfo }
  }

  /**
   * 上传单张图片（公开方法）
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    try {
      return { url: (await this.uploadImageFull(src)).storeUri }
    } catch (error) {
      logger.warn('Failed to upload image:', src, error)
      return { url: src }
    }
  }

  /**
   * 申请图片上传地址
   */
  private async applyImageUpload(
    sts: STSInfo
  ): Promise<UploadAddressResult> {
    const params = new URLSearchParams({
      Action: 'ApplyImageUpload',
      Version: '2018-08-01',
      ServiceId: IMAGEX_SERVICE_ID,
      app_id: IMAGEX_APP_ID,
    })
    if (sts.userId) {
      params.set('user_id', sts.userId)
    }
    // 官方前端 URL 末尾必带 11 位随机 s 参数
    params.set('s', generateRandomS())
    const url = `https://imagex.bytedanceapi.com/?${params.toString()}`
    logger.debug('ApplyImageUpload URL:', url)
    // 官方请求带完整 AWS4-HMAC-SHA256 Authorization（SignedHeaders 仅含 x-amz-* 头），
    // 且必须由抖音页面上下文发起：页面 cross-site 请求才能通过 CORS 预检
    // （imagex 的 Access-Control-Allow-Headers 是精确列表，缺 authorization 会被拒）
    // 并通过服务端的来源校验；扩展 background / curl 会被要求 AWS4 头后仍被拒绝。
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
    const headers: Record<string, string> = {
      'x-amz-date': amzDate,
      'x-amz-security-token': sts.SessionToken,
    }
    headers.authorization = await signImageXV4({
      accessKeyId: sts.AccessKeyID,
      secretAccessKey: sts.SecretAccessKey,
      method: 'GET',
      url,
      headers,
      payloadHash: EMPTY_SHA256,
    })

    const data = await this.executeInDouyinTab<{
      Result?: { UploadAddress: UploadAddressResult }
      ResponseMetadata?: { Error?: { Code?: string; Message?: string } }
    }>(
      url,
      'GET',
      undefined,
      headers
    )

    if (!data.Result?.UploadAddress) {
      const err = data.ResponseMetadata?.Error
      logger.error('ApplyImageUpload failed:', JSON.stringify(data).substring(0, 500))
      throw new Error(
        `ApplyImageUpload 失败: ${err?.Message || err?.Code || 'unknown'} (user_id=${sts.userId || 'missing'})`,
      )
    }

    // 官方响应结构：StoreInfos/UploadHosts/SessionKey 都嵌在 Result.UploadAddress 下
    return data.Result.UploadAddress
  }

  /**
   * 上传图片到 TOS
   */
  private async uploadToTOS(
    uploadAddress: UploadAddressResult,
    blob: Blob
  ): Promise<void> {
    const storeInfo = uploadAddress.StoreInfos?.[0]
    const host = uploadAddress.UploadHosts?.[0]
    if (!storeInfo || !host) {
      throw new Error('Invalid upload address')
    }

    const url = `https://${host}/${storeInfo.StoreUri}`
    const arrayBuffer = await blob.arrayBuffer()
    const bytes = new Uint8Array(arrayBuffer)
    const checksum = crc32(bytes)

    logger.debug('Uploading to TOS:', url, 'size:', blob.size, 'crc32:', checksum)

    const response = await this.runtime.fetch(url, {
      method: 'PUT',
      credentials: 'omit',
      headers: {
        Authorization: storeInfo.Auth || '',
        'Content-Type': blob.type || 'application/octet-stream',
        'Content-CRC32': checksum,
      },
      body: blob,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`TOS upload failed: ${response.status} ${text}`)
    }
    logger.debug('TOS upload success')
  }

  /**
   * 提交图片上传
   */
  private async commitImageUpload(
    sts: STSInfo,
    sessionKey: string
  ): Promise<{
    PluginResult?: Array<{
      ImageWidth?: number
      ImageHeight?: number
    }>
  }> {
    const params = new URLSearchParams({
      Action: 'CommitImageUpload',
      Version: '2018-08-01',
      ServiceId: IMAGEX_SERVICE_ID,
      app_id: IMAGEX_APP_ID,
    })
    if (sts.userId) {
      params.set('user_id', sts.userId)
    }
    const url = `https://imagex.bytedanceapi.com/?${params.toString()}`
    const body = JSON.stringify({ SessionKey: sessionKey })

    // 同 applyImageUpload：带 AWS4 签名并在抖音页面上下文发起
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
    const payloadHash = await sha256Hex(body)
    const headers: Record<string, string> = {
      'x-amz-date': amzDate,
      'x-amz-security-token': sts.SessionToken,
      'x-amz-content-sha256': payloadHash,
    }
    headers.authorization = await signImageXV4({
      accessKeyId: sts.AccessKeyID,
      secretAccessKey: sts.SecretAccessKey,
      method: 'POST',
      url,
      headers,
      payloadHash,
    })

    const data = await this.executeInDouyinTab<{
      Result?: {
        PluginResult?: Array<{
          ImageWidth?: number
          ImageHeight?: number
        }>
      }
    }>(
      url,
      'POST',
      { SessionKey: sessionKey },
      headers
    )

    if (!data.Result) {
      throw new Error('Failed to commit image upload')
    }

    return data.Result
  }

  /**
   * 获取图片预览 URL
   */
  private async getImagePreviewUrl(storeUri: string): Promise<string> {
    const res = await this.executeInDouyinTab<{
      url?: { url_list?: string[] }
    }>(`https://creator.douyin.com/aweme/v1/creator/get/url/?uri=${encodeURIComponent(storeUri)}&aid=${DOUYIN_AID}`, 'GET')

    const previewUrl = res.url?.url_list?.[0]
    if (!previewUrl) {
      throw new Error('获取图片预览 URL 失败')
    }
    return previewUrl
  }
}