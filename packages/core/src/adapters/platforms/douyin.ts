/**
 * 抖音图文适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'
import { signAWS4, crc32 } from '../../lib/aws4'

const logger = createLogger('Douyin')

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
  ExpiredTime: string
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
    capabilities: ['article', 'draft', 'image_upload'],
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

      const creationId = generateCreationId()
      const initTimestamp = Math.floor(Date.now() / 1000)

      const payload = {
        item: {
          common: {
            draft: {
              title: article.title,
              description: '',
              long_article: content,
              image_info: imageInfos,
              head_poster: '',
              text_extra: '[]',
              visibility_type: 0,
              timing: 0,
              creation_id: creationId,
              init_timestamp: initTimestamp,
              req_type: 0,
            },
          },
          cover: {},
        },
      }

      const res = await this.executeInDouyinTab<{
        status_code?: number
        status_msg?: string
      }>(
        `https://creator.douyin.com/web/api/media/aweme/draft?aid=${DOUYIN_AID}`,
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
   */
  private async executeInDouyinTab<T = Record<string, unknown>>(
    url: string,
    method: 'GET' | 'POST',
    body?: unknown
  ): Promise<T> {
    if (!this.runtime.tabs) {
      throw new Error('抖音发布需要浏览器 tabs API 支持')
    }
    const tabId = await this.ensureDouyinTab()
    logger.debug('Using tab:', tabId, 'for', method, url.substring(0, 80))

    const result = await this.runtime.tabs.executeScript(
      tabId,
      async (requestUrl: string, requestMethod: string, requestBody: string | null) => {
        try {
          const options: RequestInit = {
            method: requestMethod,
            credentials: 'include',
          }
          if (requestBody) {
            options.headers = { 'Content-Type': 'application/json' }
            options.body = requestBody
          }
          const response = await fetch(requestUrl, options)
          return { success: true, data: await response.json() }
        } catch (error) {
          return { success: false, error: (error as Error).message }
        }
      },
      [url, method, body ? JSON.stringify(body) : null]
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

    this.cachedSTS = sts
    this.stsExpiry = new Date(sts.ExpiredTime).getTime()
    logger.debug('Got STS credentials, expires:', sts.ExpiredTime)
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
    const url = `https://imagex.bytedanceapi.com/?Action=ApplyImageUpload&Version=2018-08-01&ServiceId=${IMAGEX_SERVICE_ID}`
    const signResult = await signAWS4({
      method: 'GET',
      url,
      accessKeyId: sts.AccessKeyID,
      secretAccessKey: sts.SecretAccessKey,
      securityToken: sts.SessionToken,
      region: 'cn-north-1',
      service: 'imagex',
    })

    const response = await this.runtime.fetch(url, {
      method: 'GET',
      headers: { ...signResult.headers },
    })
    const data = await response.json() as {
      Result?: UploadAddressResult
    }

    if (!data.Result) {
      throw new Error('Failed to apply image upload')
    }

    return data.Result
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
    const url = `https://imagex.bytedanceapi.com/?Action=CommitImageUpload&Version=2018-08-01&ServiceId=${IMAGEX_SERVICE_ID}`
    const body = JSON.stringify({ SessionKey: sessionKey })

    const signResult = await signAWS4({
      method: 'POST',
      url,
      accessKeyId: sts.AccessKeyID,
      secretAccessKey: sts.SecretAccessKey,
      securityToken: sts.SessionToken,
      region: 'cn-north-1',
      service: 'imagex',
      body,
    })

    const response = await this.runtime.fetch(url, {
      method: 'POST',
      headers: {
        ...signResult.headers,
        'Content-Type': 'application/json',
      },
      body,
    })
    const data = await response.json() as {
      Result?: {
        PluginResult?: Array<{
          ImageWidth?: number
          ImageHeight?: number
        }>
      }
    }

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