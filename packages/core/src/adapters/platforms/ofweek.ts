/**
 * 维科号（OFweek）创作者平台适配器
 *
 * 平台资料：
 * - 发布页：https://mp.ofweek.com/article/publish.html
 * - 草稿编辑页：https://mp.ofweek.com/article/edit/id/{id}.html
 *
 * 鉴权（Cookie 会话）：HAR 中所有请求均在 mp.ofweek.com 同域、无 Authorization 头，
 * 属同站 Cookie 鉴权；扩展 SW fetch 走 credentials: 'include' 即可。
 * 登录探测用 POST /home/user/ajax_message_count（status===1 即已登录，-1 未登录）。
 * ⚠️ 不能用 /index/token 判登录：实测未登录也返回 {"status":100,"data":"..."}，
 * 它是 CSRF token 发放接口，任何会话都会发放。
 *
 * 图片上传（HAR 验证，UEditor）：
 *   POST /Upload/ueditor?action=uploadimage&encode=utf-8（multipart/form-data），
 *   响应 text/html 包 JSON：{"state":"SUCCESS","url":"/Upload/News/Img/...","title":...}。
 *   返回的是站点相对路径（HAR 中正文 <img src="/Upload/News/Img/memberXXX/202610/xxx.jpg">），
 *   正文直接引用相对路径即可，无需拼绝对域名。
 *
 * 提交文章：POST /home/news/ajax_add（form-urlencoded; charset=UTF-8, X-Requested-With: XMLHttpRequest）。
 *   HAR 样本（编辑器保存草稿）字段顺序：
 *   title, fromtype=1, new=, keywords, trade_id=, content, image_type=3,
 *   images=, id=, inner_account=2, is_draf=1
 *   - id 为空即新建，有值为更新对应草稿（编辑页 /article/edit/id/{id}.html）。
 *   - is_draf=1 为草稿；image_type=3 且 images 空（HAR 中未传封面，平台自动取正文图）。
 *   - 实测成功响应 {"data":"","info":"操作成功","status":1}，不携带草稿 id；
 *     草稿 id 通过提交后查 ajax_articles.html（id desc 第一条）反查。
 *
 * ⚠️ HAR 未记录响应体：ajax_add 响应按平台统一约定 {"status":100} 判定成功
 * （ueditor 响应按 UEditor 标准格式解析，multipart 字段名沿用 UEditor 默认的 upfile，
 * 文件名必须带扩展名 —— UEditor 按扩展名校验，裸文件名会报"文件类型不允许"）。
 * 首用时如遇解析问题请抓包校准。
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Ofweek')

/** 创作者后台 origin（所有接口同域） */
const SITE_ORIGIN = 'https://mp.ofweek.com'

/** 发布页 URL（Referer） */
const PUBLISH_PAGE = `${SITE_ORIGIN}/article/publish.html`

/** 草稿列表 / 文章管理（HAR 中编辑器页面的来源 Referer） */
const ARTICLE_LIST = `${SITE_ORIGIN}/article/manager.html`

/** 登录探测接口（消息数，需登录） */
const MESSAGE_COUNT_URL = `${SITE_ORIGIN}/home/user/ajax_message_count`

/** 文章/草稿列表接口（反查新草稿 id，ORDER BY id desc） */
const ARTICLES_URL = `${SITE_ORIGIN}/article/ajax_articles.html`

/** UEditor 图片上传接口 */
const UEDITOR_UPLOAD_URL = `${SITE_ORIGIN}/Upload/ueditor?action=uploadimage&encode=utf-8`

/** 提交文章接口 */
const NEWS_ADD_URL = `${SITE_ORIGIN}/home/news/ajax_add`

/** UEditor multipart 文件字段名（UEditor 默认；HAR 未记录 body，按标准复刻） */
const UPLOAD_FIELD_NAME = 'upfile'

/** UEditor 上传响应 */
interface OfweekUeditorResp {
  state?: string
  url?: string
  title?: string
  original?: string
  [key: string]: unknown
}

/** 平台统一响应包装 */
interface OfweekEnvelope<T = unknown> {
  status?: number
  info?: string
  data?: T
  [key: string]: unknown
}

export class OfweekAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'ofweek',
    name: '维科号',
    icon: `${SITE_ORIGIN}/favicon.ico`,
    homepage: `${SITE_ORIGIN}/article/publish.html`,
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  /** 预处理配置：维科号编辑器接受 HTML 正文 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  /**
   * Header 规则：全部同域请求，SW fetch 会自动带正确 Origin/Referer，
   * 无需注入，保留钩子供未来调整。
   */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = []

  // ============ checkAuth ============

  /**
   * 鉴权：POST /home/user/ajax_message_count，status===1 即已登录。
   *
   * 实测（2026-10-10）：
   * - 未登录：{"data":"","info":"请登录!","status":-1}
   * - 已登录：{"data":"1","info":"操作成功","status":1}（HAR）
   *
   * ⚠️ 不能用 /index/token 判登录：实测未登录也返回
   * {"data":"5283...","status":100} —— 它是 CSRF token 发放接口，
   * 任何会话都会发放，不反映登录态。
   */
  async checkAuth(): Promise<AuthResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      try {
        const resp = await this.runtime.fetch(MESSAGE_COUNT_URL, {
          method: 'POST',
          credentials: 'include',
          headers: {
            Accept: 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
            Referer: PUBLISH_PAGE,
          },
          body: '',
        })
        if (!resp.ok) {
          return { isAuthenticated: false, error: `HTTP ${resp.status}` }
        }
        const data = (await resp.json()) as OfweekEnvelope
        if (data.status === 1) {
          return { isAuthenticated: true }
        }
        return {
          isAuthenticated: false,
          error: data.info || `请先登录维科号（${PUBLISH_PAGE}）`,
        }
      } catch (error) {
        logger.debug('checkAuth error:', error)
        return {
          isAuthenticated: false,
          error: (error as Error).message || '鉴权失败',
        }
      }
    })
  }

  // ============ publish ============

  /**
   * 发布文章（保存草稿）。
   *
   * 流程（HAR 验证）：
   *   1. checkAuth（确保已登录）
   *   2. processImages 处理正文图片（替换为 /Upload/News/... 相对路径）
   *   3. POST ajax_add（is_draf=1）→ 实测成功返回 {"info":"操作成功","status":1}
   *
   * 说明：
   * - 封面不单独传：HAR 中 image_type=3 且 images 为空（平台自动取正文首图），
   *   与编辑器默认行为一致。
   * - 前端提交前会调 ajax_check_word 做字数校验，属纯前端提示，这里跳过，
   *   由服务端在 ajax_add 时裁决。
   */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish to Ofweek...')

      // 1. 鉴权
      const auth = await this.checkAuth()
      if (!auth.isAuthenticated) {
        throw new Error(auth.error || '未登录维科号创作者平台')
      }

      // 2. 正文图片
      let content = article.html || ''
      try {
        content = await this.processImages(
          content,
          (src) => this.uploadImageByUrl(src),
          {
            skipPatterns: ['ofweek.com', '/Upload/News/'],
            onProgress: options?.onImageProgress,
          },
        )
      } catch (e) {
        logger.warn('[Ofweek] processImages 中途失败，继续发布：', (e as Error).message)
      }

      // 3. 提交草稿（字段顺序与 HAR 对齐）
      const body = new URLSearchParams()
      body.append('title', article.title)
      body.append('fromtype', '1')
      body.append('new', '')
      body.append('keywords', (article.tags || []).join(','))
      body.append('trade_id', '')
      body.append('content', content)
      body.append('image_type', '3')
      body.append('images', '')
      body.append('id', '')
      body.append('inner_account', '2')
      body.append('is_draf', '1') // 1 = 草稿

      const resp = await this.runtime.fetch(NEWS_ADD_URL, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: PUBLISH_PAGE,
        },
        body: body.toString(),
      })

      const text = await resp.text()
      if (!resp.ok) {
        throw new Error(`提交文章失败：HTTP ${resp.status}: ${text.substring(0, 200)}`)
      }

      let data: OfweekEnvelope
      try {
        data = JSON.parse(text) as OfweekEnvelope
      } catch {
        throw new Error(`提交文章失败：响应非 JSON: ${text.substring(0, 200)}`)
      }

      // 实测（2026-10-10）：成功响应 {"info":"操作成功","status":1}（与 message_count
      // 同款平台约定，status 1=成功）；HAR 之前推断的 100 不对（HAR 未记录响应体）。
      if (data.status !== 1 && data.status !== 100) {
        throw new Error(data.info || `提交失败：status=${data.status}`)
      }

      // 草稿 id：ajax_add 实测响应 {"data":"","info":"操作成功","status":1}，
      // 不携带 id。改为提交后查草稿列表（ORDER BY id desc，HAR 已验证创建后
      // 第一条即新草稿）反查最新草稿 id。
      let draftId = this.extractDraftId(data.data)
      if (!draftId) {
        try {
          await this.delay(500)
          const listResp = await this.runtime.fetch(`${ARTICLES_URL}?_t=${Date.now()}`, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
              'X-Requested-With': 'XMLHttpRequest',
              Referer: PUBLISH_PAGE,
            },
            body: 'status=0&keyword=&page=1&pagesize=1',
          })
          if (listResp.ok) {
            const listData = JSON.parse(await listResp.text()) as OfweekEnvelope<{ list?: Array<{ id?: string | number }> }>
            const first = listData.data?.list?.[0]
            if (listData.status === 100 && first?.id != null) {
              draftId = String(first.id)
            }
          }
        } catch (e) {
          logger.debug('[Ofweek] 查询草稿 id 失败：', (e as Error).message)
        }
      }
      const postUrl = draftId
        ? `${SITE_ORIGIN}/article/edit/id/${draftId}.html`
        : ARTICLE_LIST

      logger.info(`[Ofweek] 草稿已保存${draftId ? `（id=${draftId}）` : ''}`)
      return this.createResult(true, {
        draftOnly: options?.draftOnly ?? true,
        postUrl,
        postId: draftId || undefined,
        message: '已保存到维科号草稿箱',
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  // ============ 图片上传 ============

  /**
   * 通过 URL 上传正文图片（UEditor multipart）。
   * 响应为 text/html 包 JSON（UEditor 格式），返回站点相对路径。
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    try {
      // 1. 取图片二进制
      let blob: Blob
      if (src.startsWith('data:')) {
        blob = await this.dataUriToBlob(src)
      } else {
        const encodedSrc = this.encodeUrlPath(src)
        const imageResponse = await fetch(encodedSrc, { credentials: 'omit' })
        if (!imageResponse.ok) {
          throw new Error(`图片下载失败 (${imageResponse.status}): ${src}`)
        }
        blob = await imageResponse.blob()
      }

      // 2. multipart 上传（文件名必须带扩展名：UEditor 按扩展名校验文件类型，
      //    之前传裸文件名 "image" 会报 state=文件类型不允许）
      const formData = new FormData()
      formData.append(UPLOAD_FIELD_NAME, blob, `image${this.extFromMime(blob.type)}`)

      const resp = await this.runtime.fetch(UEDITOR_UPLOAD_URL, {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json, text/javascript, */*; q=0.01',
          Referer: PUBLISH_PAGE,
        },
        body: formData,
      })

      const text = await resp.text()
      let data: OfweekUeditorResp
      try {
        data = JSON.parse(text) as OfweekUeditorResp
      } catch {
        throw new Error(`图片上传失败：响应非 JSON (HTTP ${resp.status}): ${text.substring(0, 200)}`)
      }

      if (data.state !== 'SUCCESS' || !data.url) {
        throw new Error(`图片上传失败：state=${data.state}`)
      }

      // 相对路径直接返回（与编辑器产物一致）
      return { url: data.url }
    } catch (error) {
      logger.warn('[Ofweek] 图片上传失败，保留原 URL:', src, error)
      return { url: src }
    }
  }

  // ============ 工具方法 ============

  /** 由 MIME 推断文件扩展名（UEditor 按扩展名校验文件类型） */
  private extFromMime(mime: string): string {
    if (mime.includes('png')) return '.png'
    if (mime.includes('gif')) return '.gif'
    if (mime.includes('webp')) return '.webp'
    if (mime.includes('bmp')) return '.bmp'
    return '.jpg'
  }

  /** 从提交响应中提取草稿 id（数字字符串） */
  private extractDraftId(data: unknown): string | null {
    if (data == null) return null
    // data 可能是 id 数字/字符串，也可能是 {id: xxx} / {news_id: xxx} 对象
    const candidates: unknown[] = [data]
    if (typeof data === 'object') {
      const obj = data as Record<string, unknown>
      candidates.push(obj.id, obj.news_id, obj.nid)
    }
    for (const v of candidates) {
      if (typeof v === 'number' || typeof v === 'string') {
        const m = String(v).match(/^\d+$/)
        if (m) return String(v)
      }
    }
    return null
  }
}
