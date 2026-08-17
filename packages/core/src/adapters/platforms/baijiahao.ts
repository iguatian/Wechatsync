/**
 * 百家号适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Baijiahao')

interface BaijiahaoUserInfo {
  userid: string
  name: string
  avatar: string
}

export class BaijiahaoAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'baijiahao',
    name: '百家号',
    icon: 'https://www.baidu.com/favicon.ico',
    homepage: 'https://baijiahao.baidu.com/',
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  /** 预处理配置: 百家号使用 HTML 格式 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  private userInfo: BaijiahaoUserInfo | null = null
  private authToken: string = ''

  /** 百家号 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://baijiahao.baidu.com/*',
      headers: {
        'Origin': 'https://baijiahao.baidu.com',
        'Referer': 'https://baijiahao.baidu.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      const res = await this.get<{
        errno: number
        errmsg: string
        data?: { user: BaijiahaoUserInfo }
      }>(`https://baijiahao.baidu.com/builder/app/appinfo?_=${Date.now()}`)

      logger.debug('checkAuth response:', res)

      if (res.errmsg === 'success' && res.data?.user) {
        this.userInfo = res.data.user
        return {
          isAuthenticated: true,
          userId: res.data.user.userid,
          username: res.data.user.name,
          avatar: res.data.user.avatar,
        }
      }

      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  private async fetchAuthToken(): Promise<string> {
    const response = await this.runtime.fetch('https://baijiahao.baidu.com/builder/rc/edit', {
      credentials: 'include',
    })
    const html = await response.text()

    const match = html.match(/window\.__BJH__INIT__AUTH__\s*=\s*['"]([^'"]+)['"]/)
    if (!match) {
      throw new Error('登录失效，请重新登录百家号')
    }

    const token = match[1]
    logger.debug('Auth token obtained')
    return token
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      if (!this.userInfo) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('请先登录百家号')
        }
      }

      this.authToken = await this.fetchAuthToken()

      // Use pre-processed HTML content directly
      let content = article.html || ''

      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['baijiahao.baidu.com', 'bdstatic.com', 'bcebos.com'],
          onProgress: options?.onImageProgress,
        }
      )

      // 上传封面图（仅当有 cover 时）
      let coverUrl = ''
      let coverError = ''
      if (article.cover) {
        try {
          const coverResult = await this.uploadImageByUrl(article.cover)
          coverUrl = coverResult.url
          logger.debug('Cover uploaded:', coverUrl)
        } catch (e) {
          coverError = (e as Error).message
          logger.warn('Failed to upload cover:', e)
        }
      }

      // 构造保存草稿请求体（对齐百家号编辑器真实保存接口）
      // 核心：封面用 cover_images JSON 数组（不再是旧的 pic 字段），
      //       source=upload & cover_source=upload & cover_layout=one
      const saveParams = new URLSearchParams()
      saveParams.set('type', 'news')
      saveParams.set('title', article.title)
      saveParams.set('content', content)
      saveParams.set('news_mount', '')
      saveParams.set('len', String(content.length))

      // activity_list：新版用下标数组形式（用户抓包所得）
      saveParams.set('activity_list[0][id]', 'ai_tts')
      saveParams.set('activity_list[0][is_checked]', '1')
      saveParams.set('activity_list[1][id]', 'telphone')
      saveParams.set('activity_list[1][is_checked]', '0')
      saveParams.set('activity_list[2][id]', 'aigc_bjh_status')
      saveParams.set('activity_list[2][is_checked]', '0')

      // 封面图相关（仅当封面图上传成功时填写；未上传成功则不带这些字段）
      if (coverUrl) {
        const coverImage = {
          src: coverUrl,
          cropData: {},
          machine_chooseimg: 0,
          isLegal: 0,
          cover_source_tag: 'local',
        }
        const coverImageMap = {
          src: coverUrl,
          origin_src: coverUrl,
        }
        saveParams.set('cover_image_source[wide_cover_image_source]', 'local')
        saveParams.set('cover_layout', 'one')
        saveParams.set('cover_images', JSON.stringify([coverImage]))
        saveParams.set('_cover_images_map', JSON.stringify([coverImageMap]))
        saveParams.set('source', 'upload')
        saveParams.set('cover_source', 'upload')
      } else {
        saveParams.set('cover_image_source[wide_cover_image_source]', '')
        saveParams.set('cover_layout', 'one')
        saveParams.set('cover_images', '[]')
        saveParams.set('_cover_images_map', '[]')
        saveParams.set('source', 'upload')
        saveParams.set('cover_source', 'upload')
      }

      saveParams.set('abstract_from', '1')
      saveParams.set('isBeautify', 'false')
      saveParams.set('usingImgFilter', 'false')
      saveParams.set('first_exclusive_publish_v2', '3')
      saveParams.set('subtitle', '')
      saveParams.set('bjhtopic_id', '')
      saveParams.set('bjhtopic_info', '')
      // 编辑已有草稿时带上 article_id（首次创建可为空）
      saveParams.set('article_id', '')

      const response = await this.runtime.fetch(
        'https://baijiahao.baidu.com/pcui/article/save?callback=bjhdraft',
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'token': this.authToken,
          },
          body: saveParams,
        }
      )

      const text = await response.text()
      const jsonStr = text.replace(/^bjhdraft\(/, '').replace(/\)$/, '')
      const res = JSON.parse(jsonStr) as {
        errno: number
        errmsg: string
        ret?: { article_id: string }
      }

      logger.debug('Save response:', res)

      if (res.errmsg !== 'success' || !res.ret?.article_id) {
        throw new Error(res.errmsg || '保存草稿失败')
      }

      const postId = res.ret.article_id
      const draftUrl = `https://baijiahao.baidu.com/builder/rc/edit?type=news&article_id=${postId}`

      // 封面图诊断信息：通过 MCP 全链路透传到上层发布方（publisher.py），
      // 便于直接看到封面图上传成功与否及其原因，无需再查扩展控制台。
      const coverDiagnostics = {
        coverUploaded: !!coverUrl,
        coverUrl: coverUrl || undefined,
        coverError: coverError || undefined,
      }
      // 若封面上传失败，同时把失败原因附到 error 上便于直接展示
      const extra = coverError
        ? { error: `封面图上传失败: ${coverError}`, ...coverDiagnostics }
        : coverDiagnostics

      return this.createResult(true, {
        postId: postId,
        postUrl: draftUrl,
        draftOnly: options?.draftOnly ?? true,
        ...extra,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    // 对 URL 路径中的非 ASCII 字符（如中文）进行百分号编码，确保扩展能正确下载图片
    const encodedSrc = this.encodeUrlPath(src)
    const imageResponse = await fetch(encodedSrc)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    // 转 base64。百家号 processproxy 接口要求：action[0]=save&base64=<图片base64>
    // （base64 值为形如 ",/9j/..." —— 即 data URI 中逗号之后的全部内容）
    const dataUri = await this.blobToDataUri(imageBlob)
    // dataUri 形如 "data:image/jpeg;base64,/9j/4AAQSk..."，截取逗号及之后部分
    const commaIndex = dataUri.indexOf(',')
    const base64Body = commaIndex >= 0 ? dataUri.substring(commaIndex) : (',' + dataUri)

    // 百家号真实上传接口：pcui/picture/processproxy（form-urlencoded + base64 + token）
    // 注意：不是旧的 pcui/picture/uploadproxy（multipart），那个接口已不适用于封面上传。
    const uploadUrl = 'https://baijiahao.baidu.com/pcui/picture/processproxy'
    const uploadResponse = await this.runtime.fetch(uploadUrl, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'token': this.authToken,
      },
      body: new URLSearchParams({
        'action[0]': 'save',
        'base64': base64Body,
      }),
    })

    const res = await uploadResponse.json() as {
      errno: number
      errmsg: string
      ret?: { url?: string; original_url?: string }
    }

    logger.debug('Image upload response:', res)

    // 成功返回 { errno:0, errmsg:'success', ret:{ url:'...' } }
    if (res.errno !== 0 || res.errmsg !== 'success' || !res.ret?.url) {
      throw new Error(res.errmsg || res.ret?.url ? (res.errmsg || '图片上传失败') : '图片上传失败')
    }

    return {
      url: res.ret.url,
    }
  }
}
