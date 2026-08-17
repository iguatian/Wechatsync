/**
 * 网易号适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Netease')

interface NeteaseAccountInfo {
  tid: string | number
  tname?: string
  icon?: string
  realUserId?: string
}

export class NeteaseAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'netease',
    name: '网易号',
    icon: 'https://static.ws.126.net/163/f2e/news/yxybd_pc/resource/static/share-icon.png',
    homepage: 'https://mp.163.com/#/article-publish',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 网易号使用 HTML 格式，表格需转为文本 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    convertTablesToText: true,
  }

  /** 网易号 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://mp.163.com/*',
      headers: {
        'Origin': 'https://mp.163.com',
        'Referer': 'https://mp.163.com/subscribe_v4/index.html',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  private accountInfo: NeteaseAccountInfo | null = null

  async checkAuth(): Promise<AuthResult> {
    try {
      const res = await this.get<{
        code?: number
        data?: NeteaseAccountInfo & { tid?: string | number }
      }>(`https://mp.163.com/wemedia/navinfo.do?_=${Date.now()}`)

      logger.debug('checkAuth response:', res)

      if (res.code !== 1 || !res.data?.tid) {
        return { isAuthenticated: false }
      }

      this.accountInfo = res.data as NeteaseAccountInfo
      return {
        isAuthenticated: true,
        userId: String(this.accountInfo.tid),
        username: this.accountInfo.tname,
        avatar: this.accountInfo.icon,
      }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      // 1. 确保已登录
      if (!this.accountInfo) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('请先登录网易号')
        }
      }

      // 2. 获取 ursToken（需要页面上下文）
      const ursToken = await this.fetchUrsToken()

      // 3. 处理图片
      let content = article.html || ''
      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['126.net', '163.com', 'netease.com'],
          onProgress: options?.onImageProgress,
        }
      )

      // 4. 保存草稿 (publishV2.do)
      // 前面 if 已确认登录并 throw，这里 accountInfo 一定非空
      const accountInfo = this.accountInfo!
      const wemediaId = String(accountInfo.tid)
      const realUserId = accountInfo.realUserId || ''
      const timestamp = Date.now()

      const formData = new URLSearchParams()
      formData.append('wemediaId', wemediaId)
      formData.append('articleId', '-1')
      formData.append('title', article.title)
      formData.append('content', content)
      formData.append('cover', 'threeImg')
      formData.append('operation', 'saveDraft')
      formData.append('scheduled', '0')
      formData.append('ursToken', ursToken)
      formData.append('onlineState', '1')
      formData.append('picUrl', '')
      formData.append('original', '0')
      formData.append('subjectId', '')

      const publishUrl = `https://mp.163.com/wemedia/article/status/api/publishV2.do?_=${timestamp}&wemediaId=${wemediaId}&realUserId=${encodeURIComponent(realUserId)}`

      const publishRes = await (await this.runtime.fetch(publishUrl, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: formData.toString(),
      })).json() as {
        code?: number
        msg?: string
        data?: string | Record<string, string | number>
      }

      logger.debug('Publish response:', publishRes)

      if (publishRes.code !== 1) {
        throw new Error(publishRes.msg || '保存草稿失败')
      }

      // 解析 docId
      let docId = ''
      if (publishRes.data) {
        if (typeof publishRes.data === 'string') {
          docId = new URLSearchParams(publishRes.data).get('docId') || publishRes.data
        } else {
          docId = String(publishRes.data.docId || '')
        }
      }

      const draftUrl = `https://mp.163.com/subscribe_v4/index.html#/article-publish/${docId}?option=editDraft`

      return this.createResult(true, {
        postId: docId,
        postUrl: draftUrl,
        draftOnly: options?.draftOnly ?? true,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * 确保存在网易号 tab
   */
  private async ensureNeteaseTab(): Promise<number> {
    if (!this.runtime.tabs) {
      throw new Error('网易号发布需要浏览器 tabs API 支持')
    }
    const tabs = await this.runtime.tabs.query('https://mp.163.com/*')
    if (tabs.length > 0 && tabs[0].id) {
      return tabs[0].id
    }
    logger.info('No existing tab found, creating new one...')
    const tab = await this.runtime.tabs.create(
      'https://mp.163.com/subscribe_v4/index.html#/article-publish',
      false
    )
    await this.runtime.tabs.waitForLoad(tab.id, 30000)
    logger.info('New tab created and loaded:', tab.id)
    return tab.id
  }

  /**
   * 从页面上下文获取 ursToken（window.neg.getToken()）
   */
  private async fetchUrsToken(): Promise<string> {
    if (!this.runtime.tabs) {
      logger.warn('No tabs API, cannot get ursToken')
      return ''
    }

    const tabId = await this.ensureNeteaseTab()
    logger.debug('Using tab:', tabId, 'to get ursToken')

    const result = await this.runtime.tabs.executeScript<
      { success: boolean; token?: string; error?: string },
      []
    >(tabId, async () => {
      try {
        const neg = (window as unknown as {
          neg?: { getToken: () => Promise<{ code: number; token?: string }> }
        }).neg

        if (!neg?.getToken) {
          return { success: false, error: 'neg.getToken not available' }
        }

        const tokenResult = await neg.getToken()
        if (tokenResult.code === 200 && tokenResult.token) {
          return { success: true, token: tokenResult.token }
        }
        return { success: false, error: `getToken returned code ${tokenResult.code}` }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }, [])

    return result?.success && result.token
      ? result.token
      : ''
  }

  /**
   * 通过 URL 上传图片
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.accountInfo) {
      throw new Error('未登录')
    }

    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    const formData = new FormData()
    formData.append('file', imageBlob, 'image.jpg')

    const uploadRes = await (await this.runtime.fetch(
      `https://mp.163.com/wemedia/article/api/uploadCoverImage.do?wemediaId=${this.accountInfo.tid}`,
      {
        method: 'POST',
        credentials: 'include',
        body: formData,
      }
    )).json() as {
      code?: number
      msg?: string
      data?: { url?: string; picUrl?: string }
    }

    logger.debug('Image upload response:', uploadRes)

    if (uploadRes.code !== 1 || !uploadRes.data) {
      throw new Error('图片上传失败: ' + (uploadRes.msg || '未知错误'))
    }

    const url = uploadRes.data.url || uploadRes.data.picUrl
    if (!url) {
      throw new Error('图片上传返回数据不完整')
    }

    return { url }
  }
}