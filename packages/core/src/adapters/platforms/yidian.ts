/**
 * 一点号适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Yidian')

export class YidianAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'yidian',
    name: '一点号',
    icon: 'https://www.yidianzixun.com/favicon.ico',
    homepage: 'https://mp.yidianzixun.com',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 一点号使用 HTML 格式 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    removeLinks: true,
  }

  private mpCode: string | null = null

  async checkAuth(): Promise<AuthResult> {
    try {
      const pageText = await (await this.runtime.fetch(
        'https://mp.yidianzixun.com',
        { credentials: 'include' }
      )).text()

      const scriptMatch = pageText.match(/<script id="__val_"[^>]*>([\s\S]*?)<\/script>/)
      if (!scriptMatch) {
        return { isAuthenticated: false, error: '未找到用户数据' }
      }

      const scriptContent = scriptMatch[1]

      // 提取 mpcode
      const codeMatch = scriptContent.match(/window\.mpcode\s*=\s*['"]([a-f0-9]+)['"]/)
      if (codeMatch) {
        this.mpCode = codeMatch[1]
        logger.debug('mpCode extracted:', this.mpCode)
      }

      // 提取用户信息
      const userMatch = scriptContent.match(/window\.mpuser\s*=\s*(\{[\s\S]*?\});/)
      if (!userMatch) {
        return { isAuthenticated: false, error: '未登录' }
      }

      try {
        const userData = JSON.parse(userMatch[1])
        return userData.id
          ? {
              isAuthenticated: true,
              userId: userData.id,
              username: userData.media_name,
              avatar: userData.media_pic,
            }
          : { isAuthenticated: false, error: '未登录' }
      } catch {
        return { isAuthenticated: false, error: '解析用户数据失败' }
      }
    } catch (error) {
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  /**
   * 构建请求头
   */
  private getHeaders(contentType?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
    }
    if (contentType) {
      headers['Content-Type'] = contentType
    }
    if (this.mpCode) {
      headers['x-mp-code'] = this.mpCode
    }
    return headers
  }

  /**
   * 确保已获取 mpCode
   */
  private async ensureMpCode(): Promise<void> {
    if (this.mpCode) return
    await this.checkAuth()
    if (!this.mpCode) {
      logger.warn('mpCode not found, requests may fail')
    }
  }

  /**
   * 通过 URL 上传图片（优先使用服务端抓取接口）
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    await this.ensureMpCode()

    try {
      // 方式一：让服务端从 URL 抓取图片
      const urlFetchUrl = `https://mp.yidianzixun.com/api/getImageFromUrl?src=${encodeURIComponent(src)}`
      const fetchRes = await (await this.runtime.fetch(urlFetchUrl, {
        credentials: 'include',
        headers: this.getHeaders(),
      })).json() as {
        status?: string
        inner_addr?: string
      }

      if (fetchRes.status === 'success' && fetchRes.inner_addr) {
        logger.debug(`Image uploaded via URL: ${fetchRes.inner_addr}`)
        return { url: fetchRes.inner_addr }
      }
    } catch (error) {
      logger.debug('URL upload failed, trying multipart upload:', error)
    }

    // 方式二：下载图片后 multipart 上传
    const imageResponse = await this.runtime.fetch(src)
    const imageBlob = await imageResponse.blob()

    const extMatch = src.match(/\.(png|jpg|jpeg|gif|webp)/i)
    const ext = extMatch?.[1] || 'png'
    const fileName = `image_${Date.now()}.${ext}`

    const formData = new FormData()
    formData.append('upfile', imageBlob, fileName)

    const uploadRes = await (await this.runtime.fetch(
      'https://mp.yidianzixun.com/upload?action=uploadimage&picType=wemedia_cnt',
      {
        method: 'POST',
        credentials: 'include',
        headers: this.getHeaders(),
        body: formData,
      }
    )).json() as {
      status?: string
      url?: string
    }

    if (uploadRes.status !== 'success' || !uploadRes.url) {
      throw new Error(`图片上传失败: ${JSON.stringify(uploadRes)}`)
    }

    logger.debug(`Image uploaded via multipart: ${uploadRes.url}`)
    return { url: uploadRes.url }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    const timestamp = Date.now()

    try {
      await this.ensureMpCode()

      let content = article.html || ''
      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        { onProgress: options?.onImageProgress }
      )

      const payload = {
        title: article.title,
        cate: '',
        cateB: '',
        coverType: 'default',
        covers: [],
        content,
        hasSubTitle: 0,
        subTitle: '',
        original: 0,
        reward: 0,
        videos: [],
        audios: [],
        votes: {
          vote_id: '',
          vote_options: [],
          vote_end_time: '',
          vote_title: '',
          vote_type: 1,
          isAdded: false,
        },
        images: [],
        goods: [],
        is_mobile: 0,
        status: 0,
        import_url: '',
        import_hash: '',
        image_urls: {},
        minTimingHour: 3,
        maxTimingDay: 7,
        tags: [],
        isPubed: false,
        lastSaveTime: '',
        dirty: false,
        editorType: 'articleEditor',
        activity_id: 0,
        join_activity: 0,
        wm_globallink: '',
        wm_globaltime: '',
        outsideImages: [],
        wm_content_source: { type: 1 },
        notSaveToStore: true,
      }

      const res = await (await this.runtime.fetch(
        'https://mp.yidianzixun.com/model/Article',
        {
          method: 'POST',
          credentials: 'include',
          headers: this.getHeaders('application/json;charset=UTF-8'),
          body: JSON.stringify(payload),
        }
      )).json() as {
        id?: string | number
      }

      if (!res.id) {
        throw new Error('同步错误: ' + JSON.stringify(res))
      }

      return {
        platform: this.meta.id,
        success: true,
        postId: String(res.id),
        postUrl: `https://mp.yidianzixun.com/#/Writing/${res.id}`,
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
    }
  }
}