/**
 * 博客园 (cnblogs.com) 适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Cnblogs')

export class CnblogsAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'cnblogs',
    name: '博客园',
    icon: 'https://www.cnblogs.com/favicon.ico',
    homepage: 'https://www.cnblogs.com',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 博客园使用 Markdown 格式 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  private xsrfToken: string | null = null

  /**
   * 本次发布过程中上传失败的图片 src 列表。
   *
   * 背景：base class `processImages` 会对每张图片 `try/catch` 调用 `uploadFn`，
   * 单张失败会被静默吞掉（保留原 markdown src），但 publish() 调用方拿不到失败原因。
   * 这里在 uploadImageByUrl 抛错前记录失败的 src，publish 末尾汇总到 SyncResult.message，
   * 让 MCP/CLI 上层能感知“草稿虽然创建成功，但有图片未上传”。
   */
  private failedImages: Array<{ src: string; error: string }> = []

  /** 博客园 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://i.cnblogs.com/*',
      headers: {
        'Origin': 'https://i.cnblogs.com',
        'Referer': 'https://i.cnblogs.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://upload.cnblogs.com/*',
      headers: {
        'Origin': 'https://i.cnblogs.com',
        'Referer': 'https://i.cnblogs.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /**
   * 从 cookie 中获取 XSRF-TOKEN
   */
  private async getXsrfToken(): Promise<string | null> {
    if (this.xsrfToken) {
      return this.xsrfToken
    }

    try {
      // 先访问页面以触发 cookie 设置
      await this.runtime.fetch('https://i.cnblogs.com/posts/edit', {
        method: 'GET',
        credentials: 'include',
      })

      // 使用 cookies API 获取 XSRF-TOKEN
      if (this.runtime.getCookie) {
        logger.debug('Trying to get XSRF-TOKEN via getCookie API...')

        // 尝试不同的域名格式
        const domains = ['i.cnblogs.com', '.cnblogs.com', 'cnblogs.com']
        for (const domain of domains) {
          const value = await this.runtime.getCookie(domain, 'XSRF-TOKEN')
          logger.debug(`getCookie ${domain} result:`, value ? `${value.substring(0, 30)}...` : 'null')
          if (value) {
            this.xsrfToken = value
            logger.debug('Got XSRF-TOKEN from cookies API')
            return this.xsrfToken
          }
        }
      } else {
        logger.warn('getCookie API not available')
      }

      logger.warn('Could not find XSRF-TOKEN')
      return null
    } catch (error) {
      logger.error('Failed to get XSRF-TOKEN:', error)
      return null
    }
  }

  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch('https://home.cnblogs.com/user/CurrentUserInfo', {
        method: 'GET',
        credentials: 'include',
      })

      const text = await response.text()

      // 解析 HTML 响应获取用户信息
      // 页面结构: <a href="/u/xxx/"><img class="pfs" src="..."></a>
      const avatarMatch = text.match(/<img[^>]+class="pfs"[^>]+src="([^"]+)"/)
      const linkMatch = text.match(/href="\/u\/([^/]+)\/"/)

      if (!linkMatch) {
        return { isAuthenticated: false }
      }

      const uid = linkMatch[1]
      const avatar = avatarMatch ? avatarMatch[1] : undefined

      return {
        isAuthenticated: true,
        userId: uid,
        username: uid,
        avatar,
      }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish to cnblogs...')

      // 1. Get XSRF-TOKEN
      const xsrfToken = await this.getXsrfToken()
      logger.info('XSRF-TOKEN:', xsrfToken ? `${xsrfToken.substring(0, 20)}...` : 'null')
      if (!xsrfToken) {
        throw new Error('获取 XSRF-TOKEN 失败，请刷新页面后重试')
      }

      // 保存 xsrfToken 供 uploadImageByUrl 使用
      this.xsrfToken = xsrfToken

      // 2. 处理图片上传
      let markdown = article.markdown || ''
      logger.debug('Markdown before processImages:', markdown.substring(0, 200))

      markdown = await this.processImages(
        markdown,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['cnblogs.com', 'img2024.cnblogs.com', 'img2023.cnblogs.com'],
          onProgress: options?.onImageProgress,
        }
      )

      logger.debug('Markdown after processImages:', markdown.substring(0, 200))

      // 3. Build request headers
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-xsrf-token': xsrfToken,
      }

      logger.debug('Request headers:', JSON.stringify(headers))
      logger.debug('Markdown content length:', markdown.length)

      // 4. 创建草稿
      const response = await this.runtime.fetch('https://i.cnblogs.com/api/posts', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({
          id: null,
          postType: 2, // 2 = 文章, 1 = 随笔
          accessPermission: 0,
          title: article.title,
          url: null,
          postBody: markdown,
          categoryIds: null,
          categories: null,
          collectionIds: [],
          inSiteCandidate: false,
          inSiteHome: false,
          siteCategoryId: null,
          blogTeamIds: null,
          isPublished: false,
          displayOnHomePage: false,
          isAllowComments: true,
          includeInMainSyndication: false,
          isPinned: false,
          showBodyWhenPinned: false,
          isOnlyForRegisterUser: false,
          isUpdateDateAdded: false,
          entryName: null,
          description: null,
          featuredImage: null,
          tags: null,
          password: null,
          publishAt: null,
          datePublished: new Date().toISOString(),
          dateUpdated: null,
          isMarkdown: true,
          isDraft: true,
          autoDesc: null,
          changePostType: false,
          blogId: 0,
          author: null,
          removeScript: false,
          clientInfo: null,
          changeCreatedTime: false,
          canChangeCreatedTime: false,
          isContributeToImpressiveBugActivity: false,
          usingEditorId: 5,
          sourceUrl: null,
        }),
      })

      // 检查响应
      const responseText = await response.text()
      logger.debug('Create post response:', response.status, responseText.substring(0, 300))

      if (!response.ok) {
        // 检查是否是认证错误
        if (response.status === 401 || response.status === 403) {
          throw new Error('未登录或登录已过期，请重新登录博客园')
        }
        throw new Error(`创建草稿失败: ${response.status} - ${responseText}`)
      }

      let responseData: { id?: number; blogId?: number; error?: string }
      try {
        responseData = JSON.parse(responseText)
      } catch {
        throw new Error(`创建草稿失败: 响应不是有效 JSON - ${responseText.substring(0, 100)}`)
      }

      if (!responseData.id) {
        throw new Error(responseData.error || '创建草稿失败: 无效响应')
      }

      const postId = String(responseData.id)
      const draftUrl = `https://i.cnblogs.com/articles/edit;postId=${postId}`

      logger.debug('Draft created:', postId)

      // 汇总上传失败的图片给上层（MCP/CLI 透传到 UI）
      let extraMessage = ''
      if (this.failedImages.length > 0) {
        const lines = this.failedImages
          .map(f => `  - ${f.src.slice(0, 80)}: ${f.error}`)
          .join('\n')
        extraMessage =
          `草稿已保存，但有 ${this.failedImages.length} 张图片未上传到博客园图床：\n${lines}\n` +
          '提示：本地相对路径（如 ./cover.jpg）在 MV3 Service Worker 中 fetch 会失败，' +
          '请用 read_file 读取后转为 base64 data URI 再传 markdown。'
        logger.warn('[Cnblogs] 图片上传失败汇总：\n' + lines)
      }

      return this.createResult(true, {
        postId,
        postUrl: draftUrl,
        draftOnly: options?.draftOnly ?? true,
        ...(extraMessage ? { message: extraMessage } : {}),
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * 上传图片到博客园
   * 使用新版 CORS 上传接口
   *
   * src 支持的形式：
   *   1. data URI（CLI/MCP 模式，由上游 convertImagesToDataUri / resolveLocalImages 转好）
   *   2. http(s):// 远程 URL（base class processImages 上游提取的图）
   *   3. blob: URL（页面 createObjectURL，极少见）
   *
   * 不支持的：
   *   - 相对路径 `./xxx`、`../xxx`（MV3 Service Worker 里 fetch 相对路径会
   *     "TypeError: Failed to fetch"，因为没有 base URL）。这种情况抛错并
   *     push 到 failedImages，让 publish 末尾汇总到 SyncResult.message 提示用户。
   *
   * 上传接口：POST https://upload.cnblogs.com/v2/images/cors-upload
   * multipart 字段：image(blob)、app=blog、uploadType=Select（HAR 验证）
   * 响应取 imageUrl（HAR 验证）
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.xsrfToken) {
      throw new Error('XSRF-TOKEN 未获取')
    }

    // 1) 把 src 转成 Blob + 推断文件名
    const { blob: imageBlob, filename } = await this.srcToImageBlob(src)

    // 2) 构建 FormData 上传到博客园图床
    const formData = new FormData()
    formData.append('image', imageBlob, filename)
    formData.append('app', 'blog')
    formData.append('uploadType', 'Select')

    const uploadResponse = await this.runtime.fetch(
      'https://upload.cnblogs.com/v2/images/cors-upload',
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'x-xsrf-token': this.xsrfToken,
        },
        body: formData,
      }
    )

    const responseText = await uploadResponse.text()
    logger.debug('Image upload raw response:', responseText)

    if (!uploadResponse.ok) {
      throw new Error(`图片上传失败: ${uploadResponse.status} - ${responseText}`)
    }

    let res: Record<string, unknown>
    try {
      res = JSON.parse(responseText)
    } catch {
      throw new Error(`图片上传失败: 响应不是 JSON - ${responseText.substring(0, 100)}`)
    }

    logger.debug('Image upload parsed response:', JSON.stringify(res))

    // 尝试不同的响应字段名（HAR 验证用 imageUrl，少数场景可能换字段）
    const imageUrl = res.imageUrl || res.data || res.url || res.src
    if (!imageUrl || typeof imageUrl !== 'string') {
      throw new Error(`图片上传失败: 无法获取图片 URL - ${JSON.stringify(res)}`)
    }

    logger.info('Image uploaded:', imageUrl)
    return {
      url: imageUrl,
    }
  }

  /**
   * 把 src 转成 Blob + 推断文件名
   *
   * 单独拆出来便于：
   *   1. 集中处理 data URI / http(s) / blob: / 相对路径四种 src 形式
   *   2. 失败时统一 push 到 failedImages 供 publish 末尾汇总
   *   3. 文件名推断（博客园图床靠 filename 后缀识别图片类型，参考 HAR：
   *      filename="3be807ff220e01f4d8c9c9c43e33c05c.jpg" → image/jpeg）
   */
  private async srcToImageBlob(src: string): Promise<{ blob: Blob; filename: string }> {
    const mimeToExt = (m: string): string => {
      const x = m.toLowerCase().split(';')[0]
      if (x.includes('jpeg') || x.includes('jpg')) return 'jpg'
      if (x.includes('png')) return 'png'
      if (x.includes('gif')) return 'gif'
      if (x.includes('webp')) return 'webp'
      if (x.includes('bmp')) return 'bmp'
      return 'jpg'
    }
    const extFromUrl = (u: string): string => {
      try {
        const last = new URL(u).pathname.split('.').pop()?.toLowerCase().split('?')[0] || ''
        return /^(jpe?g|png|gif|webp|bmp)$/.test(last) ? last : ''
      } catch {
        return ''
      }
    }

    try {
      if (src.startsWith('data:')) {
        // data URI: data:image/jpeg;base64,...
        const match = src.match(/^data:([^;]+);base64,(.+)$/)
        if (!match) {
          throw new Error('非法的 data URI: ' + src.slice(0, 60))
        }
        const mimeType = match[1]
        const binary = atob(match[2])
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        return {
          blob: new Blob([bytes], { type: mimeType }),
          filename: `image.${mimeToExt(mimeType)}`,
        }
      }

      if (src.startsWith('http://') || src.startsWith('https://')) {
        // 远程 URL：encodeUrlPath 处理中文路径段，避免服务端下载失败
        const encoded = this.encodeUrlPath(src)
        const resp = await fetch(encoded)
        if (!resp.ok) {
          throw new Error(`远程图片下载失败 (${resp.status}): ${src}`)
        }
        const blob = await resp.blob()
        const mimeType = blob.type || 'image/jpeg'
        const ext = extFromUrl(src) || mimeToExt(mimeType)
        return { blob, filename: `image.${ext}` }
      }

      if (src.startsWith('blob:')) {
        // blob URL（页面 createObjectURL）
        const resp = await fetch(src)
        if (!resp.ok) {
          throw new Error(`blob 图片读取失败 (${resp.status}): ${src}`)
        }
        const blob = await resp.blob()
        const mimeType = blob.type || 'image/jpeg'
        return { blob, filename: `image.${mimeToExt(mimeType)}` }
      }

      // 相对路径 / 其他不支持的形式
      // MV3 Service Worker 里 fetch('./xxx') 会直接 Failed to fetch（无 base URL），
      // 显式抛错让上层感知，并在 failedImages 记录，方便 publish 末尾汇总提示。
      throw new Error(
        `博客园适配器不支持的图片来源（MV3 Service Worker 无法 fetch 相对路径）：${src.slice(0, 80)}`,
      )
    } catch (error) {
      const message = (error as Error).message || String(error)
      this.failedImages.push({ src, error: message })
      throw error
    }
  }
}
