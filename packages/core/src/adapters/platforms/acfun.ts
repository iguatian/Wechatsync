/**
 * AcFun 适配器
 *
 * 发布流程（基于 https://member.acfun.cn/post-article 抓包）:
 * 1. 图片上传:
 *    POST /common/api/getQiniuToken        {fileName} -> {token, httpEndpointList}
 *    GET  upload.kuaishouzt.com/api/upload/resume?upload_token=xxx
 *    POST upload.kuaishouzt.com/api/upload/fragment?upload_token=xxx&fragment_id=0
 *         (二进制 body, 需 Content-Type: application/octet-stream + Content-Range)
 *    POST upload.kuaishouzt.com/api/upload/complete?fragment_count=1&upload_token=xxx
 *    POST /common/api/getUrlAfterUpload    {token, bizFlag} -> {url}
 * 2. 发布:
 *    POST /article/api/postArticle (form-urlencoded)
 *      title / description / detail(JSON, bodyList[].txt 为 encodeURIComponent 后的 HTML)
 *      / tagNames(JSON 数组) / creationType / cover / channelId / realmId / supportZtEmot
 *    返回 {result: 0, articleId}
 *    文章地址: https://www.acfun.cn/a/ac{articleId}
 *    编辑地址: https://member.acfun.cn/edit-article/{articleId}
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('AcFun')

/** 默认频道参数（抓包实测值）: channelId=110, realmId=4 */
const DEFAULT_CHANNEL_ID = '110'
const DEFAULT_REALM_ID = '4'
/** 抓包中的创作类型取值 */
const CREATION_TYPE = '3'
/** getUrlAfterUpload 的 bizFlag（抓包实测值） */
const BIZ_FLAG = 'web-article-cover'

interface AcfunTokenInfo {
  token: string
  httpEndpointList?: string[]
}

interface AcfunUrlAfterUpload {
  result: number
  url?: string
}

interface AcfunPostArticleResult {
  result: number
  articleId?: number
  error?: { code?: number; msg?: string }
  info?: unknown
}

interface AcfunPersonalInfoResult {
  result: number
  info?: {
    id?: number
    name?: string
    avatar?: string
  }
}

function extFromMime(mime: string, src: string): string {
  const extMatch = /\.(jpe?g|png|gif|webp|bmp)(?:[?#]|$)/i.exec(src)
  if (extMatch) return '.' + extMatch[1].toLowerCase().replace('jpg', 'jpeg')
  if (mime.includes('png')) return '.png'
  if (mime.includes('gif')) return '.gif'
  if (mime.includes('webp')) return '.webp'
  if (mime.includes('bmp')) return '.bmp'
  return '.jpeg'
}

export class AcfunAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'acfun',
    name: 'AcFun',
    icon: 'https://www.acfun.cn/favicon.ico',
    homepage: 'https://member.acfun.cn/post-article',
    capabilities: ['article', 'image_upload', 'cover'],
  }

  /** 预处理配置: AcFun 文章编辑器使用 HTML */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  /** AcFun API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://member.acfun.cn/*',
      headers: {
        'Origin': 'https://member.acfun.cn',
        'Referer': 'https://member.acfun.cn/post-article',
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://upload.kuaishouzt.com/*',
      headers: {
        'Origin': 'https://member.acfun.cn',
        'Referer': 'https://member.acfun.cn/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      const res = await this.get<AcfunPersonalInfoResult>(
        'https://www.acfun.cn/rest/pc-direct/user/personalInfo'
      )
      logger.debug('checkAuth response:', res)

      const info = res.info
      if (res.result === 0 && info && info.id) {
        return {
          isAuthenticated: true,
          userId: String(info.id),
          username: info.name,
          avatar: info.avatar,
        }
      }

      // personalInfo 结构不符合预期时，回退到登录 Cookie 检测
      if (this.runtime.getCookie) {
        const passtoken = await this.runtime.getCookie('.acfun.cn', 'acPasstoken')
        if (passtoken) {
          return { isAuthenticated: true }
        }
      }
      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      const auth = await this.checkAuth()
      if (!auth.isAuthenticated) {
        throw new Error('请先登录AcFun')
      }

      let content = article.html || ''
      if (!content.trim()) {
        throw new Error('文章内容为空')
      }

      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['acfun.cn', 'ndcyx.com'],
          onProgress: options?.onImageProgress,
        }
      )

      // 封面图
      let coverUrl = ''
      let coverError: string | undefined
      if (article.cover) {
        try {
          const uploaded = await this.uploadImageByUrl(article.cover)
          coverUrl = uploaded.url
        } catch (error) {
          coverError = (error as Error).message
          logger.warn('Cover upload failed:', error)
        }
      }

      const detail = {
        bodyList: [
          {
            orderId: 1,
            title: '',
            txt: encodeURIComponent(content),
          },
        ],
      }

      const res = await this.postForm<AcfunPostArticleResult>(
        'https://member.acfun.cn/article/api/postArticle',
        {
          title: article.title,
          description: article.summary || '',
          detail: JSON.stringify(detail),
          tagNames: JSON.stringify(Array.isArray(article.tags) ? article.tags.slice(0, 10) : []),
          creationType: CREATION_TYPE,
          cover: coverUrl,
          channelId: DEFAULT_CHANNEL_ID,
          realmId: DEFAULT_REALM_ID,
          supportZtEmot: 'true',
        }
      )

      logger.debug('postArticle response:', res)

      if (res.result !== 0 || !res.articleId) {
        const msg = res.error?.msg || `错误码 ${res.result}`
        throw new Error('AcFun 发布失败: ' + msg)
      }

      return this.createResult(true, {
        postId: String(res.articleId),
        postUrl: `https://www.acfun.cn/a/ac${res.articleId}`,
        message: `编辑地址: https://member.acfun.cn/edit-article/${res.articleId}`,
        draftOnly: false,
        coverUploaded: coverUrl ? true : undefined,
        coverUrl: coverUrl || undefined,
        coverError,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * 上传图片到 AcFun（快手 KCE 上传通道）
   * 流程: getQiniuToken -> resume -> fragment -> complete -> getUrlAfterUpload
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()
    if (imageBlob.size === 0) {
      throw new Error('图片内容为空: ' + src)
    }

    // 1. 获取上传凭证
    const ext = extFromMime(imageBlob.type || '', src)
    const fileName = `o_${Date.now()}${Math.floor(Math.random() * 10000)}${ext}`
    const tokenRes = await this.postJson<{ result: number; info?: AcfunTokenInfo }>(
      'https://member.acfun.cn/common/api/getQiniuToken',
      { fileName }
    )
    if (tokenRes.result !== 0 || !tokenRes.info?.token) {
      throw new Error('获取上传凭证失败 (可能未登录)')
    }
    const token = tokenRes.info.token
    const host = tokenRes.info.httpEndpointList?.[0] || 'upload.kuaishouzt.com'
    const tokenParam = encodeURIComponent(token)

    // 2. resume（初始化上传会话）
    const resumeRes = await this.runtime.fetch(
      `https://${host}/api/upload/resume?upload_token=${tokenParam}`,
      { method: 'GET' }
    )
    const resumeJson = await resumeRes.json() as { result: number }
    if (resumeJson.result !== 1) {
      throw new Error('初始化图片上传失败')
    }

    // 3. 分片上传（图片较小，单分片上传整个文件）
    const buffer = await imageBlob.arrayBuffer()
    const fragmentRes = await this.runtime.fetch(
      `https://${host}/api/upload/fragment?upload_token=${tokenParam}&fragment_id=0`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes 0-${buffer.byteLength - 1}/${buffer.byteLength}`,
        },
        body: buffer,
      }
    )
    const fragmentJson = await fragmentRes.json() as { result: number; size?: number }
    if (fragmentJson.result !== 1) {
      throw new Error('图片分片上传失败')
    }

    // 4. 完成上传
    const completeRes = await this.runtime.fetch(
      `https://${host}/api/upload/complete?fragment_count=1&upload_token=${tokenParam}`,
      { method: 'POST' }
    )
    const completeJson = await completeRes.json() as { result: number }
    if (completeJson.result !== 1) {
      throw new Error('图片上传完成确认失败')
    }

    // 5. 换取最终图片 URL
    const urlRes = await this.postJson<AcfunUrlAfterUpload>(
      'https://member.acfun.cn/common/api/getUrlAfterUpload',
      { token, bizFlag: BIZ_FLAG }
    )
    if (urlRes.result !== 0 || !urlRes.url) {
      throw new Error('获取图片地址失败')
    }

    logger.debug('Image uploaded:', urlRes.url)
    return { url: urlRes.url }
  }
}
