/**
 * 豆瓣适配器
 *
 * 基于新版「话题/笔记编辑器」(topic-editor) 的抓包实现：
 * - 草稿保存: POST https://m.douban.com/rexxar/api/v2/dwarf/drafts
 *   body: { draft_props: JSON.stringify({ title, content, image_ids, topic_tag_ids, subtype: 'note' }) }
 *   header: x-csrf-token = ck cookie 的值
 * - 图片上传: POST https://upload.douban.com/j/group/topic/add_photo
 *   (ck + image_file + upload_auth_token, token 来自 topic/create 页面的 __INIT_STATE__)
 * - 草稿地址: https://www.douban.com/topic/create?draft_id=<id>
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { DoubanImageData } from '../../lib'
import type { PublishOptions } from '../types'
import { markdownToDraft } from '../../lib'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Douban')

const CREATE_PAGE = 'https://www.douban.com/topic/create?subtype=note'
const DRAFT_API = 'https://m.douban.com/rexxar/api/v2/dwarf/drafts'
const UPLOAD_API = 'https://upload.douban.com/j/group/topic/add_photo'

interface DoubanUploadPhotoResponse {
  r?: number
  err?: string
  msg?: string
  photo?: {
    id?: number | string
    url?: string
    large?: string
    normal?: string
    thumb?: string
    icon?: string
    width?: number
    height?: number
    file_name?: string
    file_size?: number
    is_animated?: boolean
    primary_color?: string
  }
}

interface DoubanDraftResponse {
  id?: number | string
  localized_message?: string
  msg?: string
}

export class DoubanAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'douban',
    name: '豆瓣',
    icon: 'https://www.douban.com/favicon.ico',
    homepage: CREATE_PAGE,
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 豆瓣使用 Markdown 格式 (转换为 Draft.js) */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  /** CSRF token，即浏览器 cookie `ck` 的值 */
  private ck: string = ''
  /** 图片上传凭证，来自 topic/create 页面的 __INIT_STATE__.upload_auth_token */
  private uploadAuthToken: string = ''
  private username: string = ''
  private avatar: string = ''

  /** 豆瓣 API 需要的 Header 规则（扩展发起的跨域请求需伪装来源） */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://m.douban.com/*',
      headers: {
        'Origin': 'https://www.douban.com',
        'Referer': CREATE_PAGE,
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://upload.douban.com/*',
      headers: {
        'Origin': 'https://www.douban.com',
        'Referer': CREATE_PAGE,
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /**
   * 从浏览器 cookie 中读取豆瓣登录凭证
   * - dbcl2: 登录会话凭证（登录后必存在）
   * - ck: CSRF token（登录后存在，页面表单/x-csrf-token 使用的都是它）
   */
  private async readLoginCookies(): Promise<{ dbcl2: string | null; ck: string | null }> {
    try {
      const cookies = await this.runtime.cookies.get('.douban.com')
      return {
        dbcl2: cookies.find(c => c.name === 'dbcl2')?.value ?? null,
        ck: cookies.find(c => c.name === 'ck')?.value ?? null,
      }
    } catch (e) {
      logger.debug('readLoginCookies failed (runtime may not support cookies):', e)
      return { dbcl2: null, ck: null }
    }
  }

  /**
   * 从 topic/create 页面提取 upload_auth_token 等信息（best-effort）
   */
  private async fetchCreatePageInfo(): Promise<void> {
    try {
      const response = await this.runtime.fetch(CREATE_PAGE, {
        method: 'GET',
        credentials: 'include',
      })
      const html = await response.text()

      logger.debug('create page response:', { status: response.status, length: html.length })

      const tokenMatch = html.match(/upload_auth_token["']?\s*[:=]\s*["']([^"']+)["']/)
      if (tokenMatch) {
        this.uploadAuthToken = tokenMatch[1]
      }

      const userNameMatch = html.match(/_USER_NAME\s*=\s*['"]([^'"]+)['"]/)
      if (userNameMatch) {
        this.username = userNameMatch[1]
      }
      const userAvatarMatch = html.match(/_USER_AVATAR\s*=\s*['"]([^'"]+)['"]/)
      if (userAvatarMatch) {
        this.avatar = userAvatarMatch[1]
      }

      logger.debug('create page info:', {
        hasUploadToken: !!this.uploadAuthToken,
        username: this.username,
      })
    } catch (e) {
      logger.warn('fetchCreatePageInfo failed:', e)
    }
  }

  async checkAuth(): Promise<AuthResult> {
    try {
      // 以登录 cookie 为准（新版编辑器为 JS 应用，页面解析不可靠）
      const { dbcl2, ck } = await this.readLoginCookies()
      if (!dbcl2) {
        logger.debug('checkAuth: no dbcl2 cookie')
        return { isAuthenticated: false }
      }

      this.ck = ck ?? ''

      // best-effort 获取用户名与上传凭证
      await this.fetchCreatePageInfo()

      logger.debug('Auth info:', { username: this.username, hasCk: !!this.ck })

      return {
        isAuthenticated: true,
        userId: this.username,
        username: this.username,
        avatar: this.avatar,
      }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      // 1. 确保已登录（ck 是豆瓣的 CSRF 凭证，缺失时请求必然失败）
      if (!this.ck) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('请先登录豆瓣')
        }
      }
      if (!this.ck) {
        throw new Error('豆瓣登录凭证(ck)缺失，请重新登录豆瓣后重试')
      }

      // 2. 图片上传凭证
      if (!this.uploadAuthToken) {
        await this.fetchCreatePageInfo()
      }

      // 3. 处理图片
      let content = article.markdown || ''
      const imageDataMap = new Map<string, DoubanImageData>()
      const imageIds: string[] = []

      content = await this.processImages(
        content,
        async (src) => {
          const result = await this.uploadImageWithFullData(src)
          imageIds.push(result.imageData.id)
          // 保存完整图片数据，用新 URL 作为 key
          imageDataMap.set(result.url, result.imageData)
          return result
        },
        {
          skipPatterns: ['doubanio.com', 'douban.com'],
          onProgress: options?.onImageProgress,
        }
      )

      // 4. Markdown 转 Draft.js，并按编辑器格式规整图片实体
      //    （豆瓣要求 IMAGE 实体必须有上传后的 id，且 data 需为编辑器结构）
      const draftContent = this.sanitizeImageEntities(
        JSON.parse(markdownToDraft(content, imageDataMap))
      )

      // 5. 创建草稿
      const draftProps: Record<string, unknown> = {
        title: article.title,
        content: draftContent,
        image_ids: imageIds,
        topic_tag_ids: [],
        subtype: 'note',
      }
      // 有图时需要指定图文布局（编辑器默认 vertical）
      if (imageIds.length > 0) {
        draftProps.image_layout = 'vertical'
      }

      const response = await this.runtime.fetch(DRAFT_API, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'x-csrf-token': this.ck,
        },
        body: JSON.stringify({ draft_props: JSON.stringify(draftProps) }),
      })

      const res = await response.json() as DoubanDraftResponse
      logger.debug('Create draft response:', res)

      if (!res.id) {
        throw new Error(res.localized_message || res.msg || '创建豆瓣草稿失败')
      }

      return this.createResult(true, {
        postId: String(res.id),
        postUrl: `https://www.douban.com/topic/create?draft_id=${res.id}`,
        draftOnly: options?.draftOnly ?? true,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * 规整 draft.js 中的图片实体：
   * 1. data 结构对齐编辑器抓包格式:
   *    { file:{}, src, status:'fullfilled', message:'', progress:100, width, height, id, primary_color }
   * 2. 移除缺少 id 的 IMAGE 实体及其 atomic block（豆瓣校验图片必须携带上传后的 id）
   */
  private sanitizeImageEntities(draft: { blocks?: any[]; entityMap?: Record<string, any> }): typeof draft {
    const entityMap = draft.entityMap || {}
    const removedKeys = new Set<string>()

    for (const [key, entity] of Object.entries(entityMap)) {
      if (entity?.type !== 'IMAGE') continue

      const data = entity.data || {}
      if (!data.id) {
        removedKeys.add(key)
        delete entityMap[key]
        continue
      }

      entity.data = {
        file: {},
        src: data.src || data.url,
        status: 'fullfilled',
        message: '',
        progress: 100,
        width: data.width,
        height: data.height,
        id: data.id,
        primary_color: data.primary_color ?? '',
      }
    }

    if (Array.isArray(draft.blocks)) {
      if (removedKeys.size > 0) {
        draft.blocks = draft.blocks.filter(block => {
          if (block.type !== 'atomic') return true
          const ranges: Array<{ key: number }> = block.entityRanges || []
          return !ranges.some(r => removedKeys.has(String(r.key)))
        })
        logger.warn(`Removed ${removedKeys.size} image(s) without upload id`)
      }
      // atomic block 补齐 data 字段（编辑器格式为 data: {}）
      for (const block of draft.blocks) {
        if (block.type === 'atomic' && !block.data) {
          block.data = {}
        }
      }
    }

    return draft
  }

  /**
   * 上传图片并返回完整数据
   */
  private async uploadImageWithFullData(src: string): Promise<ImageUploadResult & { imageData: DoubanImageData }> {
    if (!this.ck || !this.uploadAuthToken) {
      throw new Error('未获取上传凭证')
    }

    // 1. 下载图片
    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    // 2. 计算图片主色调（编辑器会附带 primary_color，压缩到 32px 内取平均色）
    const primaryColor = await this.computePrimaryColor(imageBlob)

    // 3. 上传到豆瓣
    const extMap: Record<string, string> = {
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/bmp': 'bmp',
    }
    const ext = extMap[imageBlob.type] || 'jpg'
    const formData = new FormData()
    formData.append('ck', this.ck)
    formData.append('image_file', imageBlob, `image.${ext}`)
    formData.append('primary_color', primaryColor)
    formData.append('upload_auth_token', this.uploadAuthToken)

    const uploadResponse = await this.runtime.fetch(UPLOAD_API, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    })

    const res = await uploadResponse.json() as DoubanUploadPhotoResponse
    logger.debug('Image upload response:', res)

    if (res.r !== 0 || !res.photo) {
      throw new Error(res.err || res.msg || '图片上传失败')
    }

    const photo = res.photo
    const url = photo.url || photo.large || photo.normal
    if (!url) {
      throw new Error('图片上传失败')
    }

    return {
      url,
      imageData: {
        id: String(photo.id ?? ''),
        url,
        thumb: photo.thumb || photo.icon || url,
        width: photo.width,
        height: photo.height,
        file_name: photo.file_name,
        file_size: photo.file_size,
        primary_color: photo.primary_color || primaryColor,
      },
    }
  }

  /**
   * 计算图片平均主色调（hex，不含 #）
   * 使用 OffscreenCanvas，兼容 MV3 Service Worker 环境（无 DOM）
   */
  private async computePrimaryColor(blob: Blob): Promise<string> {
    try {
      if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
        return ''
      }
      const bitmap = await createImageBitmap(blob)
      // 与编辑器一致：最长边压缩到 32px 内再取色
      const scale = Math.min(1, 32 / Math.max(bitmap.width, bitmap.height))
      const w = Math.max(1, Math.round(bitmap.width * scale))
      const h = Math.max(1, Math.round(bitmap.height * scale))
      const canvas = new OffscreenCanvas(w, h)
      const ctx = canvas.getContext('2d')
      if (!ctx) return ''
      ctx.drawImage(bitmap, 0, 0, w, h)
      const { data } = ctx.getImageData(0, 0, w, h)
      let r = 0, g = 0, b = 0, n = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue // 跳过透明像素
        r += data[i]
        g += data[i + 1]
        b += data[i + 2]
        n++
      }
      if (n === 0) return ''
      const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, '0')
      return hex(r) + hex(g) + hex(b)
    } catch (e) {
      logger.debug('computePrimaryColor failed:', e)
      return ''
    }
  }
}
