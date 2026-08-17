/**
 * 简书适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Jianshu')

interface JianshuNotebook {
  id: number
  name: string
}

export class JianshuAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'jianshu',
    name: '简书',
    icon: 'https://www.jianshu.com/favicon.ico',
    homepage: 'https://www.jianshu.com',
    capabilities: ['article', 'draft', 'image_upload', 'categories', 'cover'],
  }

  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  private readonly HEADER_RULES = [
    {
      urlFilter: '*://www.jianshu.com/*',
      headers: { 'Origin': 'https://www.jianshu.com', 'Referer': 'https://www.jianshu.com/writer' },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  private defaultNotebookId: number | null = null
  private preferredNoteType: 'markdown' | 'plain' = 'plain'

  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch('https://www.jianshu.com/settings/basic.json', {
        method: 'GET',
        credentials: 'include',
      })
      const data = await response.json() as { data?: { nickname?: string; avatar?: string; preferred_note_type?: string } }
      if (data.data?.nickname) {
        // 根据用户偏好决定编辑器类型
        this.preferredNoteType = data.data.preferred_note_type === 'markdown' ? 'markdown' : 'plain'
        logger.debug('preferred_note_type:', this.preferredNoteType)
        return { isAuthenticated: true, username: data.data.nickname, avatar: data.data.avatar }
      }
      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async getNotebooks(): Promise<JianshuNotebook[]> {
    const response = await this.runtime.fetch('https://www.jianshu.com/author/notebooks', {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    })
    return response.json() as Promise<JianshuNotebook[]>
  }

  private async getDefaultNotebookId(): Promise<number> {
    if (this.defaultNotebookId) return this.defaultNotebookId
    const notebooks = await this.getNotebooks()
    if (notebooks.length === 0) throw new Error('没有可用的文集')
    this.defaultNotebookId = notebooks[0].id
    return this.defaultNotebookId
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      // 先检查登录状态，获取用户编辑器偏好
      await this.checkAuth()

      const notebookId = await this.getDefaultNotebookId()

      // 创建草稿
      const createResponse = await this.runtime.fetch('https://www.jianshu.com/author/notes', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ at_bottom: false, notebook_id: notebookId, title: article.title }),
      })
      const createData = await createResponse.json() as { id?: number }
      if (!createData.id) throw new Error('创建草稿失败')
      const draftId = createData.id
      logger.debug('Draft created:', draftId)

      // 根据编辑器偏好选择内容格式
      let content = this.preferredNoteType === 'markdown'
        ? article.markdown || ''
        : article.html || ''
      content = content.replace(/<p>\s*<\/p>/gi, '')
      content = await this.processImages(content, (src) => this.uploadImageByUrl(src), {
        skipPatterns: ['jianshu.com', 'jianshuapi.com', 'upload-images.jianshu.io'],
        onProgress: options?.onImageProgress,
      })

      // 更新草稿内容（官方参数：id、autosave_control）
      const updateBody: Record<string, unknown> = {
        id: String(draftId),
        autosave_control: 1,
        title: article.title,
        content,
      }
      if (article.cover) {
        try {
          const coverResult = await this.uploadImageByUrl(article.cover)
          updateBody.cover = coverResult.url
        } catch (e) {
          logger.warn('Failed to upload cover:', e)
        }
      }

      const updateResponse = await this.runtime.fetch(`https://www.jianshu.com/author/notes/${draftId}`, {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'Accept': 'application/json',
        },
        body: JSON.stringify(updateBody),
      })
      const updateData = await updateResponse.json() as { id?: number }
      if (!updateData.id) throw new Error('更新草稿失败')
      logger.debug('Draft updated')

      const draftUrl = `https://www.jianshu.com/writer#/notebooks/${notebookId}/notes/${draftId}`
      return this.createResult(true, {
        postId: String(draftId),
        postUrl: draftUrl,
        draftOnly: options?.draftOnly ?? true,
      })
    }).catch((error) => this.createResult(false, { error: (error as Error).message }))
  }

  /**
   * 获取七牛云上传凭证（新官方实现）
   */
  private async getUploadToken(filename: string): Promise<{ token: string; key: string }> {
    const response = await this.runtime.fetch(
      `https://www.jianshu.com/upload_images/token.json?filename=${encodeURIComponent(filename)}`,
      {
        method: 'GET',
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
      }
    )
    return response.json() as Promise<{ token: string; key: string }>
  }

  async uploadImage(file: Blob, _filename?: string): Promise<string> {
    return this.uploadImageBinaryInternal(file)
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    try {
      const encodedSrc = this.encodeUrlPath(src)
      const imageResponse = await fetch(encodedSrc)
      if (!imageResponse.ok) throw new Error('图片下载失败')
      const imageBlob = await imageResponse.blob()

      // 获取扩展名
      const mimeExt = (imageBlob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg')
      let filename = `image_${Date.now()}.${mimeExt}`
      // 尝试用原始文件名（对非 data URI 的 URL）
      try {
        if (!src.startsWith('data:')) {
          const pathName = new URL(src).pathname.split('/').pop() || ''
          if (/\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(pathName)) {
            filename = pathName
          }
        }
      } catch {
        // 忽略 URL 解析失败
      }

      // 获取上传 token + key，上传到七牛云
      const { token, key } = await this.getUploadToken(filename)
      const formData = new FormData()
      formData.append('token', token)
      formData.append('key', key)
      formData.append('file', imageBlob, filename)
      formData.append('x:protocol', 'https')

      const uploadResponse = await fetch('https://upload.qiniup.com/', {
        method: 'POST',
        body: formData,
      })
      const uploadData = await uploadResponse.json() as { url?: string }

      logger.debug('Image upload response:', uploadData)
      if (uploadData.url) return { url: uploadData.url }
      throw new Error('图片上传失败')
    } catch (error) {
      logger.warn('Failed to upload image:', src, error)
      return { url: src } // 失败时返回原 URL
    }
  }

  private async uploadImageBinaryInternal(file: Blob): Promise<string> {
    const ext = file.type.split('/')[1] || 'png'
    const filename = `${Date.now()}.${ext}`
    const { token, key } = await this.getUploadToken(filename)

    const formData = new FormData()
    formData.append('token', token)
    formData.append('key', key)
    formData.append('file', file, filename)
    formData.append('x:protocol', 'https')

    const response = await fetch('https://upload.qiniup.com/', {
      method: 'POST',
      body: formData,
    })
    const data = await response.json() as { url?: string; key?: string }

    if (data.url) return data.url
    if (data.key) return `https://upload-images.jianshu.io/upload_images/${data.key}`
    throw new Error('图片上传失败')
  }
}