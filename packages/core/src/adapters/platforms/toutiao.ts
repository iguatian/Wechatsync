/**
 * 头条号适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Toutiao')

export class ToutiaoAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'toutiao',
    name: '头条',
    icon: 'https://sf1-ttcdn-tos.pstatp.com/obj/ttfe/pgcfe/sz/mp_logo.png',
    homepage: 'https://mp.toutiao.com/profile_v4/graphic/publish',
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  /** 预处理配置: 头条使用 HTML 格式 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    removeLinks: true,
    removeEmptyImages: true,
    removeDataAttributes: true,
    flattenNestedBold: true,
    unwrapSingleChildSpans: true,
  }

  /** 头条号 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://mp.toutiao.com/*',
      headers: {
        'Origin': 'https://mp.toutiao.com',
        'Referer': 'https://mp.toutiao.com/profile_v4/graphic/publish',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      const res = await this.get<{
        data?: {
          user?: {
            id: string | number
            screen_name?: string
            https_avatar_url?: string
          }
        }
      }>('https://mp.toutiao.com/mp/agw/media/get_media_info')

      logger.debug('checkAuth response:', res)
      if (res.data?.user?.id) {
        return {
          isAuthenticated: true,
          userId: String(res.data.user.id),
          username: res.data.user.screen_name,
          avatar: res.data.user.https_avatar_url,
        }
      }
      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  /**
   * 获取 CSRF Token
   */
  private async getCsrfToken(): Promise<string> {
    const response = await this.runtime.fetch('https://mp.toutiao.com/ttwid/check/', {
      method: 'HEAD',
      credentials: 'include',
      headers: {
        'x-secsdk-csrf-request': '1',
        'x-secsdk-csrf-version': '1.2.22',
      },
    })
    return response.headers.get('x-ware-csrf-token') || ''
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      let content = article.html || ''

      // 移除空的 figure 标签
      content = content.replace(/<figure[^>]*>\s*<\/figure>/gi, '')
      // 压缩多余空行
      content = content.replace(/\n{3,}/g, '\n\n')

      // 处理图片
      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['pstatp.com', 'toutiao.com', 'byteimg.com'],
          onProgress: options?.onImageProgress,
        }
      )

      // 包装图片为 pgc-img 结构
      content = content.replace(
        /<img\s+([^>]+)>/gi,
        '<div class="pgc-img"><img $1><p class="pgc-img-caption"></p></div>'
      )

      // 构建发布请求
      const covers = '[]'
      const extra = JSON.stringify({
        content_source: 100000000402,
        content_word_cnt: content.length,
        is_multi_title: 0,
        sub_titles: [],
        gd_ext: {
          entrance: '',
          from_page: 'publisher_mp',
          enter_from: 'PC',
          device_platform: 'mp',
          is_message: 0,
        },
      })
      const titleId = `${Date.now()}_${Math.random().toString().slice(2, 18)}`

      const formData = new URLSearchParams()
      formData.append('pgc_id', '0')
      formData.append('source', '29')
      formData.append('extra', extra)
      formData.append('content', content)
      formData.append('title', article.title)
      formData.append('search_creation_info', JSON.stringify({
        searchTopOne: 0,
        abstract: '',
        clue_id: '',
      }))
      formData.append('title_id', titleId)
      formData.append('mp_editor_stat', '{}')
      formData.append('is_refute_rumor', '0')
      formData.append('save', '0')
      formData.append('timer_status', '0')
      formData.append('timer_time', '')
      formData.append('educluecard', '')
      formData.append('draft_form_data', JSON.stringify({ coverType: 3 }))
      formData.append('pgc_feed_covers', covers)
      formData.append('article_ad_type', '3')
      formData.append('is_fans_article', '0')
      formData.append('govern_forward', '0')
      formData.append('praise', '0')
      formData.append('disable_praise', '0')
      formData.append('tree_plan_article', '0')
      formData.append('activity_tag', '0')
      formData.append('trends_writing_tag', '0')
      formData.append('claim_exclusive', '0')

      // 头条发布接口需要页面上下文执行 (MAIN world)
      const res = await this.publishViaContentScript(
        'https://mp.toutiao.com/mp/agw/article/publish?source=mp&type=article&aid=1231',
        formData.toString()
      )

      logger.debug('publish response:', res)

      if (res.err_no !== 0 || !res.data?.pgc_id) {
        throw new Error(res.message || '发布失败')
      }

      const postId = res.data.pgc_id
      const postUrl = `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${postId}`

      return this.createResult(true, {
        postId,
        postUrl,
        draftOnly: options?.draftOnly ?? true,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * 确保存在头条号 tab
   */
  private async ensureToutiaoTab(): Promise<number> {
    if (!this.runtime.tabs) {
      throw new Error('头条发布需要浏览器 tabs API 支持')
    }
    const tabs = await this.runtime.tabs.query('https://mp.toutiao.com/*')
    if (tabs.length > 0 && tabs[0].id) {
      return tabs[0].id
    }
    logger.info('No existing tab found, creating new one...')
    const tab = await this.runtime.tabs.create(
      'https://mp.toutiao.com/profile_v4/graphic/publish',
      false
    )
    await this.runtime.tabs.waitForLoad(tab.id, 30000)
    logger.info('New tab created and loaded:', tab.id)
    return tab.id
  }

  /**
   * 在页面上下文中执行发布请求（头条接口需要 MAIN world fetch）
   */
  private async publishViaContentScript(
    url: string,
    body: string
  ): Promise<{ err_no: number; message?: string; data?: { pgc_id: string } }> {
    if (!this.runtime.tabs) {
      throw new Error('头条发布需要浏览器 tabs API 支持')
    }
    const tabId = await this.ensureToutiaoTab()
    logger.debug('Using tab:', tabId, 'to execute fetch in MAIN world')
    const result = await this.runtime.tabs.executeScript(
      tabId,
      async (requestUrl: string, requestBody: string) => {
        try {
          const response = await fetch(requestUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: requestBody,
            credentials: 'include',
          })
          return { success: true, data: await response.json() }
        } catch (error) {
          return { success: false, error: (error as Error).message }
        }
      },
      [url, body]
    )

    if (!result || !result.success) {
      throw new Error((result as { error?: string })?.error || '发布请求失败')
    }
    return (result as { data: { err_no: number; message?: string; data?: { pgc_id: string } } }).data
  }

  /**
   * 通过 URL 上传图片
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    const csrfToken = await this.getCsrfToken()
    const formData = new FormData()
    formData.append('image', imageBlob, 'image.jpg')

    const uploadResponse = await this.runtime.fetch(
      'https://mp.toutiao.com/spice/image?upload_source=20020002&aid=1231&device_platform=web',
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'x-secsdk-csrf-token': csrfToken,
        },
        body: formData,
      }
    )

    const uploadText = await uploadResponse.text()
    let res: {
      code?: number
      message?: string
      data?: {
        image_url?: string
        image_uri?: string
        image_width?: number
        image_height?: number
      }
    }
    try {
      res = JSON.parse(uploadText)
    } catch {
      throw new Error('图片上传响应解析失败')
    }

    logger.debug('Image upload response:', res)

    if (res.code !== 0 || !res.data) {
      throw new Error(res.message || '图片上传失败')
    }
    if (!res.data.image_url || !res.data.image_uri) {
      logger.error('Upload response missing URL:', res)
      throw new Error('图片上传返回数据不完整')
    }

    return {
      url: res.data.image_url,
      attrs: {
        class: '',
        'ic-uri': '',
        image_type: 'image/png',
        mime_type: '',
        web_uri: res.data.image_uri,
        img_width: String(res.data.image_width || 0),
        img_height: String(res.data.image_height || 0),
      },
    }
  }
}