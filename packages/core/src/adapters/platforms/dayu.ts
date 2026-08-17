/**
 * 大鱼号适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('DaYu')

interface DaYuMeta {
  utoken: string
  uploadSign: string
  uid: string
  title: string
  avatar: string
}

export class DayuAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'dayu',
    name: '大鱼号',
    icon: 'https://image.uc.cn/s/uae/g/1v/images/index/favicon.ico',
    homepage: 'https://mp.dayu.com/dashboard/account/profile',
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  /** 预处理配置: 大鱼号使用 HTML 格式 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  /** 大鱼号 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://mp.dayu.com/*',
      headers: {
        'Origin': 'https://mp.dayu.com',
        'Referer': 'https://mp.dayu.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://ns.dayu.com/*',
      headers: {
        'Origin': 'https://mp.dayu.com',
        'Referer': 'https://mp.dayu.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  private cacheMeta: DaYuMeta | null = null
  private uploadedImages: Array<{ org_url: string; url: string }> = []

  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch(
        'https://mp.dayu.com/dashboard/index',
        {
          method: 'GET',
          credentials: 'include',
        }
      )

      const pageHtml = await response.text()
      const markStr = 'var globalConfig = '
      const authIndex = pageHtml.indexOf(markStr)

      if (authIndex === -1) {
        return { isAuthenticated: false }
      }

      const authTokenStr = pageHtml.substring(
        authIndex + markStr.length,
        pageHtml.indexOf('var G = {', authIndex)
      )

      // 使用 JSON 解析代替 eval
      const pageConfig = this.parseGlobalConfig(authTokenStr)

      if (!pageConfig || !pageConfig.utoken) {
        return { isAuthenticated: false }
      }

      this.cacheMeta = {
        utoken: pageConfig.utoken,
        uploadSign: pageConfig.nsImageUploadSign,
        uid: pageConfig.wmid,
        title: pageConfig.weMediaName,
        avatar: pageConfig.wmAvator?.indexOf('http') > -1
          ? pageConfig.wmAvator
          : pageConfig.wmAvator?.replace('//', 'https://') || '',
      }

      return {
        isAuthenticated: true,
        userId: this.cacheMeta.uid,
        username: this.cacheMeta.title,
        avatar: this.cacheMeta.avatar,
      }
    } catch (error) {
      logger.error('checkAuth error:', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  /**
   * 解析 globalConfig JavaScript 对象
   */
  private parseGlobalConfig(configStr: string): Record<string, string> | null {
    try {
      // 尝试清理并解析 JavaScript 对象字面量
      // 移除末尾的分号和空白
      let cleaned = configStr.trim()
      if (cleaned.endsWith(';')) {
        cleaned = cleaned.slice(0, -1)
      }

      // 尝试用 JSON 解析（如果格式兼容）
      // 将单引号替换为双引号，处理无引号的 key
      const jsonStr = cleaned
        .replace(/'/g, '"')
        .replace(/(\w+):/g, '"$1":')
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']')

      return JSON.parse(jsonStr)
    } catch {
      // 如果 JSON 解析失败，使用正则提取关键字段
      const result: Record<string, string> = {}

      const patterns: Record<string, RegExp> = {
        utoken: /utoken['":\s]+['"]([^'"]+)['"]/,
        nsImageUploadSign: /nsImageUploadSign['":\s]+['"]([^'"]+)['"]/,
        wmid: /wmid['":\s]+['"]([^'"]+)['"]/,
        weMediaName: /weMediaName['":\s]+['"]([^'"]+)['"]/,
        wmAvator: /wmAvator['":\s]+['"]([^'"]+)['"]/,
      }

      for (const [key, pattern] of Object.entries(patterns)) {
        const match = configStr.match(pattern)
        if (match) {
          result[key] = match[1]
        }
      }

      return Object.keys(result).length > 0 ? result : null
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      // 重置上传图片列表
      this.uploadedImages = []

      // 1. 确保已登录
      if (!this.cacheMeta) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('请先登录大鱼号')
        }
      }

      // 2. 使用预处理好的 HTML 内容
      let content = article.html || ''

      // 3. 处理图片
      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['dayu.com', 'uc.cn'],
          onProgress: options?.onImageProgress,
        }
      )

      // 4. 获取封面图（从已上传的文章图片中取第一张，官方行为）
      const coverImg = this.uploadedImages.length > 0
        ? this.uploadedImages[0].org_url
        : ''

      // 6. 保存草稿
      const formData = new URLSearchParams()
      formData.append('title', article.title)
      formData.append('content', content)
      formData.append('author', this.cacheMeta!.title)
      formData.append('coverImg', coverImg)
      formData.append('article_type', '1')
      formData.append('utoken', this.cacheMeta!.utoken)
      formData.append('cover_from', 'auto')

      const response = await this.runtime.fetch(
        'https://mp.dayu.com/dashboard/save-draft',
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'utoken': this.cacheMeta!.utoken,
          },
          body: formData,
        }
      )

      const res = await response.json() as {
        error?: string
        data?: { _id: string }
      }

      logger.debug('Save response:', res)

      if (res.error) {
        throw new Error(res.error)
      }

      if (!res.data?._id) {
        throw new Error('保存草稿失败')
      }

      const postId = res.data._id
      const draftUrl = `https://mp.dayu.com/dashboard/article/write?draft_id=${postId}`

      return this.createResult(true, {
        postId: postId,
        postUrl: draftUrl,
        draftOnly: options?.draftOnly ?? true,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * 通过 URL 上传图片
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.cacheMeta) {
      throw new Error('未登录')
    }

    // 对 URL 路径中的非 ASCII 字符进行百分号编码
    const encodedSrc = this.encodeUrlPath(src)

    // 1. 下载图片
    const imageResponse = await fetch(encodedSrc)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    // 2. 构建上传 URL
    const uploadUrl = `https://ns.dayu.com/article/imageUpload?appid=website&fromMaterial=0&wmid=${this.cacheMeta.uid}&wmname=${encodeURIComponent(this.cacheMeta.title)}&sign=${this.cacheMeta.uploadSign}`

    // 3. 上传图片
    const formData = new FormData()
    const fileName = `${Date.now()}.jpg`
    formData.append('upfile', imageBlob, fileName)
    formData.append('type', imageBlob.type || 'image/jpeg')
    formData.append('id', 'WU_FILE_1')
    formData.append('fileid', `uploadm-${Math.floor(Math.random() * 1000000)}`)
    formData.append('name', fileName)
    formData.append('lastModifiedDate', new Date().toString())
    formData.append('size', String(imageBlob.size))

    const uploadResponse = await this.runtime.fetch(uploadUrl, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    })

    const res = await uploadResponse.json() as {
      data?: {
        imgInfo?: {
          org_url: string
          url: string
        }
      }
    }

    logger.debug('Image upload response:', res)

    if (!res.data?.imgInfo?.url) {
      throw new Error('图片上传失败')
    }

    const image = {
      org_url: res.data.imgInfo.org_url,
      url: res.data.imgInfo.url,
    }

    // 保存上传的图片信息（用于封面）
    this.uploadedImages.push(image)

    return {
      url: image.url,
    }
  }
}