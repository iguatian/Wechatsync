/**
 * 搜狐焦点适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'

export class SohuFocusAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'sohufocus',
    name: '搜狐焦点',
    icon: 'https://mp.focus.cn/favicon.ico',
    homepage: 'https://mp.focus.cn/fe/index.html#/info/draft',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 搜狐焦点使用 HTML 格式 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  async checkAuth(): Promise<AuthResult> {
    try {
      const res = await (await this.runtime.fetch(
        'https://mp-fe-pc.focus.cn/user/status',
        { credentials: 'include' }
      )).json() as {
        data?: {
          uid: string | number
          accountName?: string
        }
      }

      return res.data?.uid
        ? {
            isAuthenticated: true,
            userId: String(res.data.uid),
            username: res.data.accountName,
          }
        : { isAuthenticated: false, error: '未登录' }
    } catch (error) {
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  /**
   * 通过 URL 上传图片
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const imageResponse = await this.runtime.fetch(src)
    const imageBlob = await imageResponse.blob()

    const formData = new FormData()
    formData.append('image', imageBlob, `${Date.now()}.jpg`)

    const uploadResponse = await this.runtime.fetch(
      'https://mp-fe-pc.focus.cn/common/image/upload?type=2',
      {
        method: 'POST',
        credentials: 'include',
        body: formData,
      }
    )

    const res = await uploadResponse.json() as {
      code?: number
      data?: string
    }

    if (res.code !== 200 || !res.data) {
      throw new Error('图片上传失败')
    }

    return {
      url: `https://t-img.51f.com/sh740wsh${res.data}`,
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    const timestamp = Date.now()

    try {
      let content = article.html || article.markdown || ''
      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        { onProgress: options?.onImageProgress }
      )
      // 压缩 HTML 标签间空白
      content = content.replace(/>\s+</g, '><')

      const res = await (await this.runtime.fetch(
        'https://mp-fe-pc.focus.cn/news/info/publishNewsInfo',
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            projectIds: [],
            newsBasic: {
              id: '',
              cityId: 0,
              title: article.title,
              category: 1,
              headImg: '',
              newsAbstract: '',
              isGuide: 0,
              status: 4,
            },
            newsContent: {
              content,
            },
            videoIds: [],
          }),
        }
      )).json() as {
        data?: {
          id: string | number
        }
      }

      if (!res.data?.id) {
        throw new Error('发布失败')
      }

      return {
        platform: this.meta.id,
        success: true,
        postId: String(res.data.id),
        postUrl: `https://mp.focus.cn/fe/index.html#/info/subinfo/${res.data.id}`,
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