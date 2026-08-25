/**
 * CSDN 适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('CSDN')

interface CSDNUserInfo {
  csdnid: string
  username: string
  avatarurl: string
}

export class CSDNAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'csdn',
    name: 'CSDN',
    icon: 'https://g.csdnimg.cn/static/logo/favicon32.ico',
    homepage: 'https://editor.csdn.net/md/',
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  /** 预处理配置: CSDN 使用 Markdown 格式 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  private userInfo: CSDNUserInfo | null = null

  // CSDN API 签名密钥
  // API_KEY / API_SECRET 用于 saveArticle / getBaseInfo 等通用接口；
  // COVER_API_KEY / COVER_API_SECRET 用于封面专属上传签名接口（direct_blog_coverimage）。
  // CSDN 网关为不同接口分配独立的密钥对：从用户抓包上看，封面签名的
  //   x-ca-key 是 260196572（与通用 203803574 不同），并且签名需要带上 x-ca-timestamp
  //   （x-ca-signature-headers 为 x-ca-key,x-ca-nonce,x-ca-timestamp）。
  // 封面的 secret 无法从抓包反推（HMAC-SHA256 是单向哈希）。
  // 如出现 "[CSDN] 获取封面上传签名失败: HMAC signature does not match"，
  // 需要从 CSDN 编辑器 JS bundle（editor.csdn.net 的 chunk）里搜索字符串 260196572，
  //   同一对象里的另一个字段就是 secret，请把它填到下面的 COVER_API_SECRET。
  private readonly API_KEY = '203803574'
  private readonly API_SECRET = '9znpamsyl2c7cdrr9sas0le9vbc3r6ba'
  private readonly COVER_API_KEY = '260196572'
  // 默认复用通用 secret 以保证代码可运行，但因密钥对不匹配会导致签名报错。
  // 在生产环境填入从 CSDN 编辑器 JS bundle 中找到的正确值即可生效。
  // https://g.csdnimg.cn/csdn-upload/2.0.1/csdn-upload.js可以查到   appKey: "260196572",appSecret: "t5PaqxVQpWoHgLGt7XPIvd5ipJcwJTU7",
  private readonly COVER_API_SECRET = 't5PaqxVQpWoHgLGt7XPIvd5ipJcwJTU7'


  /** CSDN API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://bizapi.csdn.net/*',
      headers: {
        'Origin': 'https://editor.csdn.net',
        'Referer': 'https://editor.csdn.net/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://imgservice.csdn.net/*',
      headers: {
        'Origin': 'https://editor.csdn.net',
        'Referer': 'https://editor.csdn.net/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://csdn-img-blog.obs.cn-north-4.myhuaweicloud.com/*',
      headers: {
        'Origin': 'https://editor.csdn.net',
        'Referer': 'https://editor.csdn.net/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      // 使用带签名的 API
      const apiPath = '/blog-console-api/v3/editor/getBaseInfo'
      const headers = await this.signRequest(apiPath, 'GET')

      const response = await this.runtime.fetch(
        `https://bizapi.csdn.net${apiPath}`,
        {
          method: 'GET',
          credentials: 'include',
          headers,
        }
      )

      const res = await response.json() as {
        code: number
        data?: {
          name: string
          nickname: string
          avatar: string
          blog_url: string
        }
      }

      logger.debug('checkAuth response:', res)

      if (res.code === 200 && res.data?.name) {
        this.userInfo = {
          csdnid: res.data.name,
          username: res.data.nickname || res.data.name,
          avatarurl: res.data.avatar,
        }
        return {
          isAuthenticated: true,
          userId: res.data.name,
          username: res.data.nickname || res.data.name,
          avatar: res.data.avatar,
        }
      }

      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  /**
   * 生成 UUID
   */
  private createUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0
      const v = c === 'x' ? r : (r & 0x3 | 0x8)
      return v.toString(16)
    })
  }

  /**
   * HMAC-SHA256 签名 (使用 Web Crypto API)
   */
  private async hmacSha256(message: string, secret: string): Promise<string> {
    const encoder = new TextEncoder()
    const keyData = encoder.encode(secret)
    const messageData = encoder.encode(message)

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )

    const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData)

    // 转换为 Base64
    const bytes = new Uint8Array(signature)
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
  }

  /**
   * 生成 CSDN API 签名。
   * 签名格式：METHOD / Accept / Content-MD5 / Content-Type / 空行 / Headers / Path。
   *
   * - options.includeTimestamp=true 时，额外把 x-ca-timestamp 加入签名串和
   *   x-ca-signature-headers（CSDN 封面上传签名接口要求带上 timestamp，
   *   saveArticle 不带）。
   * - options.apiKey / options.apiSecret 用于切换签名密钥；不传则使用通用
   *   API_KEY / API_SECRET。
   */
  private async signRequest(
    apiPath: string,
    method: 'GET' | 'POST' = 'POST',
    options?: { apiKey?: string; apiSecret?: string; includeTimestamp?: boolean }
  ): Promise<Record<string, string>> {
    const apiKey = options?.apiKey || this.API_KEY
    const apiSecret = options?.apiSecret || this.API_SECRET
    const includeTimestamp = options?.includeTimestamp ?? false
    const nonce = this.createUuid()
    const timestamp = Date.now()

    // 按 CSDN 网关要求顺序拼接：x-ca-key、x-ca-nonce、可选 x-ca-timestamp
    const headerLines: string[] = [`x-ca-key:${apiKey}`, `x-ca-nonce:${nonce}`]
    const headerKeys: string[] = ['x-ca-key', 'x-ca-nonce']
    if (includeTimestamp) {
      headerLines.push(`x-ca-timestamp:${timestamp}`)
      headerKeys.push('x-ca-timestamp')
    }

    // GET: 没有 Content-Type，所以那一行为空
    // POST: Content-Type 为 application/json
    const signStr = method === 'GET'
      ? `GET\n*/*\n\n\n\n${headerLines.join('\n')}\n${apiPath}`
      : `POST\n*/*\n\napplication/json\n\n${headerLines.join('\n')}\n${apiPath}`

    logger.debug('Sign string:', JSON.stringify(signStr))

    const signature = await this.hmacSha256(signStr, apiSecret)

    const headers: Record<string, string> = {
      'accept': '*/*',
      'x-ca-key': apiKey,
      'x-ca-nonce': nonce,
      'x-ca-signature': signature,
      'x-ca-signature-headers': headerKeys.join(','),
    }

    if (includeTimestamp) {
      headers['x-ca-timestamp'] = String(timestamp)
    }

    if (method === 'POST') {
      headers['content-type'] = 'application/json'
    }

    return headers
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      // 1. 确保已登录
      if (!this.userInfo) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('请先登录 CSDN')
        }
      }

      // 2. 上传封面图（article.cover 为远程 URL 或 data URI）。
      //    CSDN 封面必须走专用接口 direct_blog_coverimage，拿到 CSDN CDN URL 后
      //    才能在 saveArticle 里被识别；失败时继续保存草稿，但透出原因。
      let coverUrl = ''
      let coverError = ''
      if (article.cover) {
        try {
          const coverResult = await this.uploadImageByUrl(article.cover, 'cover')
          coverUrl = coverResult.url
          logger.debug('Cover uploaded:', coverUrl)
        } catch (e) {
          coverError = (e as Error).message
          logger.warn('Failed to upload CSDN cover:', e)
        }
      }

      // Use pre-processed markdown content directly
      let markdown = article.markdown || ''

      // Process images in markdown
      markdown = await this.processImages(
        markdown,
        (src) => this.uploadImageByUrl(src, 'body'),
        {
          skipPatterns: ['csdnimg.cn', 'csdn.net'],
          onProgress: options?.onImageProgress,
        }
      )

      // Get HTML content (CSDN API needs both markdown and HTML)
      const htmlContent = article.html || ''

      // Generate signature and save article
      const apiPath = '/blog-console-api/v3/mdeditor/saveArticle'
      const headers = await this.signRequest(apiPath)

      const response = await this.runtime.fetch(
        `https://bizapi.csdn.net${apiPath}`,
        {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify({
            title: article.title,
            markdowncontent: markdown,
            content: htmlContent,
            readType: 'public',
            level: 0,
            tags: '',
            status: 2, // 草稿
            categories: '',
            type: 'original',
            original_link: '',
            authorized_status: false,
            not_auto_saved: '1',
            source: 'pc_mdeditor',
            // 封面图：上传成功才填入 CSDN CDN URL；失败或无封面则保持空数组。
            // CSDN 后端靠 cover_images 识别封面，传错（传其他图床的 URL）不会生效。
            cover_images: coverUrl ? [coverUrl] : [],
            cover_type: 1,
            is_new: 1,
            vote_id: 0,
            resource_id: '',
            pubStatus: 'draft',
            creator_activity_id: '',
          }),
        }
      )

      const res = await response.json() as {
        code: number
        message?: string
        msg?: string
        data?: { id: string }
      }

      logger.debug('Save response:', res)

      if (res.code !== 200 || !res.data?.id) {
        throw new Error(res.msg || res.message || '保存草稿失败')
      }

      const postId = res.data.id
      const draftUrl = `https://editor.csdn.net/md?articleId=${postId}`

      // 封面诊断信息：有封面但上传失败时，把错误附到 error 便于上层发布方一眼看到。
      const coverDiagnostics: { coverUploaded?: boolean; coverUrl?: string; coverError?: string } = {}
      if (article.cover) {
        if (coverUrl) {
          coverDiagnostics.coverUploaded = true
          coverDiagnostics.coverUrl = coverUrl
        }
        if (coverError) {
          coverDiagnostics.coverError = coverError
        }
      }

      const baseResult: Partial<SyncResult> = {
        postId: postId,
        postUrl: draftUrl,
        draftOnly: options?.draftOnly ?? true,
        ...coverDiagnostics,
      }

      // 若提供了封面但上传失败，将错误追加到 result.error 让上层能直接看到。
      if (article.cover && coverError && !coverUrl) {
        baseResult.error = `封面图上传失败: ${coverError}`
        baseResult.message = '草稿已保存，但封面未生效，请手动到 CSDN 编辑器补传封面'
      }

      return this.createResult(true, baseResult)
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * 通过 Blob 上传图片（覆盖基类方法）
   * 需要设置动态请求头规则以支持 MCP 调用
   */
  async uploadImage(file: Blob, _filename?: string): Promise<string> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      // 转为 data URI 然后调用 uploadImageByUrl
      const dataUri = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const result = await this.uploadImageByUrl(dataUri)
      return result.url
    })
  }

  /**
   * 通过 URL 上传图片到 CSDN 图床。
   *
   * @param src 远程 URL 或 data URI（CLI 会把本地图片转成 data URI）
   * @param purpose 'body' 表示正文中使用的图片（appName=direct_blog_markdown）；
   *               'cover' 表示封面图（appName=direct_blog_coverimage，使用独立签名 key 并需要 x-ca-timestamp）
   *
   * 区别来自 CSDN 编辑器真实抓包：封面与正文走的是不同的 appName，封面在 CSDN
   * 网关侧分配独立 x-ca-key（COVER_API_KEY），且签名要带上 x-ca-timestamp。
   *
   * 失败时抛出错误（封面场景下不应掩盖失败，伪装成功会导致 CSDN 不识别封面）。
   */
  protected async uploadImageByUrl(
    src: string,
    purpose: 'body' | 'cover' = 'body'
  ): Promise<ImageUploadResult> {
    // 1. 获取图片二进制与 MIME。
    //    优先识别 data URI 的 mime，避免对 data:image/png;base64,... 按 URL 取扩展名
    //    而误判为 jpg；同时支持远程 URL 下载。
    let imageBlob: Blob
    let mimeType = ''
    if (src.startsWith('data:')) {
      const match = src.match(/^data:([^;]+);base64,(.+)$/)
      if (!match) {
        throw new Error('非法 data URI: ' + src.slice(0, 32))
      }
      mimeType = match[1]
      const base64 = match[2]
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      imageBlob = new Blob([bytes], { type: mimeType })
    } else {
      const encodedSrc = this.encodeUrlPath(src)
      const imageResponse = await fetch(encodedSrc)
      if (!imageResponse.ok) {
        throw new Error('图片下载失败: ' + src)
      }
      imageBlob = await imageResponse.blob()
      mimeType = imageBlob.type
    }

    // 2. 推文件后缀名。优先用 Blob.type / data URI mime；兜底才从 URL 尾部取。
    const mimeToExt: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
    }
    let validExt: string
    if (mimeType && mimeToExt[mimeType.toLowerCase()]) {
      validExt = mimeToExt[mimeType.toLowerCase()]
    } else {
      const ext = src.split('.').pop()?.toLowerCase()?.split('?')[0] || 'jpg'
      validExt = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext) ? ext : 'jpg'
    }

    // 3. 获取上传签名。封面场景需要使用 COVER_API_KEY / COVER_API_SECRET
    //    并带上 x-ca-timestamp（见 COVER_API_SECRET 注释）。
    const apiPath = '/resource-api/v1/image/direct/upload/signature'
    const appName = purpose === 'cover' ? 'direct_blog_coverimage' : 'direct_blog_markdown'
    const signOptions = purpose === 'cover'
      ? {
          apiKey: this.COVER_API_KEY,
          apiSecret: this.COVER_API_SECRET,
          includeTimestamp: true as const,
        }
      : undefined
    const headers = await this.signRequest(apiPath, 'POST', signOptions)

    const signatureRes = await this.runtime.fetch(
      `https://bizapi.csdn.net${apiPath}`,
      {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({
          imageTemplate: '',
          appName,
          imageSuffix: validExt,
        }),
      }
    )

    const signatureData = await signatureRes.json() as {
      code: number
      msg?: string
      message?: string
      data?: {
        filePath: string
        host: string
        accessId: string
        policy: string
        signature: string
        callbackUrl: string
        callbackBody: string
        callbackBodyType: string
        customParam: {
          rtype: string
          filePath: string
          isAudit: number
          'x-image-app': string
          type: string
          'x-image-suffix': string
          username: string
        }
      }
    }

    logger.debug('Upload signature response:', signatureData)

    if (signatureData.code !== 200 || !signatureData.data) {
      // 失败时不再返回原始 URL（避免后续 saveArticle 提交一个非 CSDN 图床的 URL，
      // 这是之前封面上传不生效的根本原因之一）。
      throw new Error(
        `[CSDN] 获取${purpose === 'cover' ? '封面' : '正文'}上传签名失败: ` +
        (signatureData.msg || signatureData.message || `code=${signatureData.code}`)
      )
    }

    const uploadData = signatureData.data
    const customParam = uploadData.customParam

    // 4. 上传到华为云 OBS（FormData）
    const formData = new FormData()
    formData.append('key', uploadData.filePath)
    formData.append('policy', uploadData.policy)
    formData.append('signature', uploadData.signature)
    formData.append('callbackBody', uploadData.callbackBody)
    formData.append('callbackBodyType', uploadData.callbackBodyType)
    formData.append('callbackUrl', uploadData.callbackUrl)
    formData.append('AccessKeyId', uploadData.accessId)
    formData.append('x:rtype', customParam.rtype)
    formData.append('x:filePath', customParam.filePath)
    formData.append('x:isAudit', String(customParam.isAudit))
    formData.append('x:x-image-app', customParam['x-image-app'])
    formData.append('x:type', customParam.type)
    formData.append('x:x-image-suffix', customParam['x-image-suffix'])
    formData.append('x:username', customParam.username)
    formData.append('file', imageBlob, `image.${validExt}`)

    const obsResponse = await this.runtime.fetch(uploadData.host, {
      method: 'POST',
      body: formData,
    })

    const obsRes = await obsResponse.json() as {
      code: number
      msg?: string
      message?: string
      data?: { imageUrl: string }
    }

    logger.debug('OBS upload response:', obsRes)

    if (obsRes.code !== 200 || !obsRes.data?.imageUrl) {
      throw new Error(
        `[CSDN] ${purpose === 'cover' ? '封面' : '正文'}图片 OBS 上传失败: ` +
        (obsRes.msg || obsRes.message || `code=${obsRes.code}`)
      )
    }

    return {
      url: obsRes.data.imageUrl,
    }
  }
}
