/**
 * 界面新闻（a.jiemian.com）创作者平台适配器
 *
 * 平台资料：
 * - 创作者后台：https://a.jiemian.com/index.php?m=writer&a=submission
 * - 草稿列表：https://a.jiemian.com/index.php?m=writer&a=draft
 *
 * 鉴权（JSONP）：GET /index.php?m=public&a=getlogin，剥掉 callback 包装后判断 uid。
 * Verifycode（CSRF）：GET /index.php?m=broke&a=verifycode，每次提交前重新拿。
 * 封面上传：POST /index.php?m=writer&a=upload（multipart，width=840, height=480, must=1, size=307200）。
 * 正文图片：POST /index.php?m=writer&a=upload&dir=image（multipart，imgFile）。
 * 提交文章：POST /index.php?m=writer&a=submissionDo（form-urlencoded，sendtype=2 保存草稿）。
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Jiemian')

/** 创作者后台 origin */
const SITE_ORIGIN = 'https://a.jiemian.com'

/** 编辑器页 URL（Referer） */
const EDITOR_PAGE = `${SITE_ORIGIN}/index.php?m=writer&a=submission`

/** 草稿列表 URL（草稿编辑完成后的可访问地址） */
const DRAFT_LIST = `${SITE_ORIGIN}/index.php?m=writer&a=draft`

/** 鉴权接口：JSONP getlogin */
const GETLOGIN_URL = `${SITE_ORIGIN}/index.php?m=public&a=getlogin`

/** Verifycode 接口 */
const VERIFYCODE_URL = `${SITE_ORIGIN}/index.php?m=broke&a=verifycode`

/** 图片上传接口（封面 / 正文共用，靠 dir 参数区分） */
const UPLOAD_URL = `${SITE_ORIGIN}/index.php?m=writer&a=upload`

/** 提交文章接口 */
const SUBMISSION_URL = `${SITE_ORIGIN}/index.php?m=writer&a=submissionDo`

/** 封面要求尺寸（HAR 验证：width=840, height=480） */
const COVER_WIDTH = 840
const COVER_HEIGHT = 480

/** 封面上传字段名（与正文图片的 imgFile 区分） */
const COVER_FIELD_NAME = 'Filedata'

/** 正文图片上传字段名 */
const BODY_IMAGE_FIELD_NAME = 'imgFile'

/** 默认栏目 ID：21（HAR 样本 + 编辑器默认勾选栏目） */
const DEFAULT_CID = '21'

/** 鉴权接口响应（JSONP 包装剥掉后） */
interface JiemianGetLoginResp {
  uid?: number | string
  nikename?: string
  headimg?: string
  is_show_v?: number
  is_pro?: number
  is_v?: string
  is_gcvauth?: string
  [key: string]: unknown
}

/** Verifycode 接口响应 */
interface JiemianVerifycodeResp {
  code?: string
  [key: string]: unknown
}

/** 封面上传响应 */
interface JiemianCoverUploadResp {
  code?: number
  message?: {
    original?: string
    thumb?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

/** 正文图片上传响应 */
interface JiemianBodyImageUploadResp {
  code?: number
  url?: string
  message?: string
  [key: string]: unknown
}

/** 提交文章响应 */
interface JiemianSubmissionResp {
  code?: number
  message?: string
  data?: unknown
  [key: string]: unknown
}

/**
 * 封面上传结果
 */
interface CoverUploadResult {
  /** 原图相对路径，赋给 submissionDo 的 o_image 字段 */
  original: string
  /** 缩略图相对路径，赋给 z_image 字段 */
  thumb: string
}

export class JiemianAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'jiemian',
    name: '界面新闻',
    icon: 'https://www.jiemian.com/favicon.ico',
    homepage: SITE_ORIGIN,
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  /** 预处理配置：界面新闻编辑器接受 HTML 正文（与汽车之家/懂车帝/中关村在线一致） */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  /**
   * Header 规则：a.jiemian.com 同域，**理论上** SW fetch 会自动带正确的 Origin，
   * 因此这里规则为空列表；保留钩子供未来调整（如某些接口额外要求 X-Requested-With）。
   */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = []

  // ============ checkAuth ============

  /**
   * 鉴权：调用 getlogin（JSONP），剥掉 callback 包装后判断 uid 字段
   * - 存在 uid 即视为已登录
   * - 响应非 JSONP 或不含 uid 即视为未登录
   */
  async checkAuth(): Promise<AuthResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      try {
        const resp = await this.runtime.fetch(
          `${GETLOGIN_URL}&callback=jQuery_cb&_=${Date.now()}`,
          {
            headers: { Accept: 'application/json, text/javascript, */*; q=0.01' },
          },
        )
        if (!resp.ok) {
          return { isAuthenticated: false, error: `HTTP ${resp.status}` }
        }
        const text = await resp.text()
        const data = this.parseJsonp<JiemianGetLoginResp>(text)
        if (!data) {
          return { isAuthenticated: false, error: 'getlogin 响应解析失败' }
        }
        if (!data.uid) {
          return {
            isAuthenticated: false,
            error: '请先登录界面新闻创作者平台（https://a.jiemian.com/）',
          }
        }
        return {
          isAuthenticated: true,
          userId: String(data.uid),
          username: data.nikename,
          avatar: data.headimg,
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
   *   1. checkAuth（确保已登录 + 拿到 uid）
   *   2. 上传封面（如有）→ 拿 o_image / z_image
   *   3. processImages 处理正文图片（替换 src）
   *   4. fetch verifycode → 拿 verify_code（CSRF token）
   *   5. POST submissionDo → 响应 code==1 即成功
   *
   * 注意事项：
   - 界面新闻要求用户 level >= 2 才能投稿（编辑器前端校验），不足时草稿箱能建但
   *   服务端通常会返回 code:3 拒绝保存。错误信息会原样透传。
   - 封面图尺寸固定 840×480（must=1），服务端会校验；尺寸不匹配会返回错误。
   - 上传正文图片大小限制 307200 字节（300KB）。超过会被 413 拒绝。
   */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish to Jiemian...')

      // 1. 鉴权
      const auth = await this.checkAuth()
      if (!auth.isAuthenticated) {
        throw new Error(auth.error || '未登录界面新闻创作者平台')
      }

      // 2. 处理正文图片（先于封面上传，避免失败时已上传浪费带宽）
      let content = article.html || ''
      try {
        content = await this.processImages(
          content,
          (src) => this.uploadImageByUrl(src),
          {
            skipPatterns: ['jiemian.com', 'img.jiemian.com'],
            onProgress: options?.onImageProgress,
          },
        )
      } catch (e) {
        logger.warn('[Jiemian] processImages 中途失败，继续发布：', (e as Error).message)
      }

      // 3. 封面上传
      let coverResult: CoverUploadResult | null = null
      let coverError: string | undefined
      if (article.cover) {
        logger.info(`[Jiemian][DIAG] article.cover = ${article.cover}`)
        try {
          coverResult = await this.uploadCoverByUrl(article.cover)
          logger.info(`[Jiemian] 封面上传成功：${coverResult.original}`)
          logger.info(`[Jiemian][DIAG] coverResult = ${JSON.stringify(coverResult)}`)
        } catch (e) {
          coverError = (e as Error).message
          logger.warn('[Jiemian] 封面上传失败：', coverError)
        }
      } else {
        logger.warn('[Jiemian] 未提供封面，提交时 o_image 为空')
      }

      // 4. 提取摘要（取正文前 200 字纯文本，去 HTML 标签）
      const summary = this.extractSummary(content, 200)

      // 5. 获取 verifycode（CSRF token，每次提交前必须重新拿）
      const verifyCode = await this.fetchVerifyCode()
      logger.debug('[Jiemian] verify_code:', verifyCode)

      // 6. 提交草稿
      logger.info(`[Jiemian][DIAG] submitDraft params: oImage=${coverResult?.original || ''} zImage=${coverResult?.thumb || ''}`)
      const result = await this.submitDraft({
        title: article.title,
        summary,
        content,
        oImage: coverResult?.original || '',
        zImage: coverResult?.thumb || '',
        cid: DEFAULT_CID,
        verifyCode,
      })
      logger.info(`[Jiemian][DIAG] submitDraft response = ${JSON.stringify(result)}`)

      if (result.code !== 1) {
        // 业务错误：透传 message
        throw new Error(
          result.message ||
            `提交失败：code=${result.code}` +
            (result.code === 3 ? '（界面新闻通常意味着投稿资格不足 / 标题为空 / 内容不合规）' : ''),
        )
      }

      logger.info('[Jiemian] 草稿已保存')
      return this.createResult(true, {
        draftOnly: options?.draftOnly ?? true,
        postUrl: DRAFT_LIST,
        coverUploaded: !!coverResult,
        coverUrl: coverResult?.original ? `${SITE_ORIGIN}/${coverResult.original}` : undefined,
        ...(coverError ? { coverError } : {}),
        message: '已保存到界面新闻创作者平台草稿箱',
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  // ============ 图片上传 ============

  /**
   * 通过 URL 上传正文图片（被 processImages 调用）。
   *
   * 与封面上传的区别：
   *   - URL 加 `&dir=image`
   *   - 字段名是 `imgFile`（不是 `Filedata`）
   *   - 响应字段是 `url`（不是 `message.original`）
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

      // 2. multipart 上传（dir=image）
      const formData = new FormData()
      formData.append(BODY_IMAGE_FIELD_NAME, blob, 'image')

      const resp = await this.runtime.fetch(`${UPLOAD_URL}&dir=image`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json, text/javascript, */*; q=0.01',
          // 必须加 XHR header，否则服务端按 iframe 表单提交返回 text/html <html></html>
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: formData,
      })

      const text = await resp.text()
      logger.info(`[Jiemian][DIAG] uploadImage status=${resp.status} content-type=${resp.headers.get('content-type')} body[0:500]=${text.substring(0, 500)}`)
      let data: JiemianBodyImageUploadResp
      try {
        data = JSON.parse(text) as JiemianBodyImageUploadResp
      } catch {
        throw new Error(`正文图片上传失败：响应非 JSON (HTTP ${resp.status}): ${text.substring(0, 200)}`)
      }

      if (data.code !== 1 || !data.url) {
        throw new Error(data.message || `正文图片上传失败：code=${data.code}`)
      }

      return { url: data.url }
    } catch (error) {
      logger.warn('[Jiemian] 正文图片上传失败，保留原 URL:', src, error)
      return { url: src }
    }
  }

  /**
   * 上传封面（multipart，固定字段 width=840/height=480/must=1/size=307200）。
   *
   * 与正文图片不同：
   *   - URL 不带 dir
   *   - 字段名是 `Filedata`
   *   - 响应字段是 `message.original` / `message.thumb`
   *
   * 服务端会校验尺寸（must=1 时严格匹配 840×480），尺寸不符会返回错误；
   * 这里不裁剪图片，仅透传错误给上层。
   */
  private async uploadCoverByUrl(src: string): Promise<CoverUploadResult> {
    let blob: Blob
    if (src.startsWith('data:')) {
      blob = await this.dataUriToBlob(src)
    } else {
      const encodedSrc = this.encodeUrlPath(src)
      const imageResponse = await fetch(encodedSrc, { credentials: 'omit' })
      if (!imageResponse.ok) {
        throw new Error(`封面下载失败 (${imageResponse.status}): ${src}`)
      }
      blob = await imageResponse.blob()
    }

    const formData = new FormData()
    formData.append(COVER_FIELD_NAME, blob, 'cover')
    formData.append('width', String(COVER_WIDTH))
    formData.append('height', String(COVER_HEIGHT))
    formData.append('must', '1')
    formData.append('size', '307200')

    const resp = await this.runtime.fetch(UPLOAD_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        // 必须加 XHR header，否则服务端按 iframe 表单提交返回 text/html 空页
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: formData,
    })

    const text = await resp.text()
    logger.info(`[Jiemian][DIAG] uploadCover status=${resp.status} content-type=${resp.headers.get('content-type')} body[0:500]=${text.substring(0, 500)}`)
    let data: JiemianCoverUploadResp
    try {
      data = JSON.parse(text) as JiemianCoverUploadResp
    } catch {
      throw new Error(`封面上传失败：响应非 JSON (HTTP ${resp.status}): ${text.substring(0, 200)}`)
    }

    if (data.code !== 1 || !data.message?.original) {
      throw new Error(
        (typeof data.message === 'string' ? data.message : null) ||
          `封面上传失败：code=${data.code}`,
      )
    }

    return {
      original: data.message.original,
      thumb: data.message.thumb || data.message.original,
    }
  }

  // ============ Verifycode ============

  /**
   * 获取 verifycode（CSRF token，会话级，每次提交前重新拿）。
   *
   * 响应是 JSONP：`jsonpReturn({"code": "1odi3jjhl7Wy3QV"});`
   * 浏览器扩展 fetch 会自动带 cookie，但 verifycode 是会话级 CSRF，必须与后续
   * submissionDo 在同一会话内连续调用（间隔过长可能失效）。
   */
  private async fetchVerifyCode(): Promise<string> {
    const resp = await this.runtime.fetch(`${VERIFYCODE_URL}&r=${Math.random()}`, {
      headers: { Accept: 'application/json, text/javascript, */*; q=0.01' },
    })
    if (!resp.ok) {
      throw new Error(`获取 verifycode 失败：HTTP ${resp.status}`)
    }
    const text = await resp.text()
    const data = this.parseJsonp<JiemianVerifycodeResp>(text)
    if (!data) {
      throw new Error(`verifycode 响应解析失败: ${text.substring(0, 200)}`)
    }
    if (!data.code) {
      throw new Error('verifycode 响应未含 code 字段')
    }
    return data.code
  }

  // ============ 提交文章 ============

  /**
   * 提交草稿到 submissionDo（form-urlencoded）。
   * 字段顺序与 HAR 抓包样本对齐（部分服务端会按 name 校验，留空字段也保留 key）。
   */
  private async submitDraft(params: {
    title: string
    summary: string
    content: string
    oImage: string
    zImage: string
    cid: string
    verifyCode: string
  }): Promise<JiemianSubmissionResp> {
    const body = new URLSearchParams()
    body.append('cid[]', params.cid)
    body.append('o_image', params.oImage)
    body.append('z_image', params.zImage)
    body.append('img_size[]', '')
    body.append('smalltitle', '')
    body.append('uuid', '')
    body.append('hainaimg', '')
    body.append('title', params.title)
    body.append('summary', params.summary)
    body.append('content', params.content)
    body.append('info[from_name]', '')
    body.append('info[from_title]', '')
    body.append('info[from_url]', '')
    body.append('leave_msg', '')
    body.append('reprint', '0')
    body.append('sendtype', '2') // 2 = 保存草稿
    body.append('lockcomment', '2')
    body.append('verify_code', params.verifyCode)

    const resp = await this.runtime.fetch(SUBMISSION_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: EDITOR_PAGE,
      },
      body: body.toString(),
    })

    const text = await resp.text()
    logger.info(`[Jiemian][DIAG] submitDraft raw status=${resp.status} content-type=${resp.headers.get('content-type')} body[0:500]=${text.substring(0, 500)}`)
    if (!resp.ok) {
      throw new Error(`提交文章失败：HTTP ${resp.status}: ${text.substring(0, 200)}`)
    }

    try {
      return JSON.parse(text) as JiemianSubmissionResp
    } catch {
      throw new Error(`提交文章失败：响应非 JSON: ${text.substring(0, 200)}`)
    }
  }

  // ============ 工具方法 ============

  /**
   * 解析 JSONP 响应：去掉 callback(...) 包装，返回内部 JSON 对象。
   * 兼容 `jQueryNNN({...})`、`cb({...})`、`({...})` 三种格式。
   * 若响应本身就是纯 JSON（非 JSONP），也直接解析。
   */
  private parseJsonp<T>(text: string): T | null {
    // 截掉前后空白
    const trimmed = text.trim()
    if (!trimmed) return null

    // 直接是 JSON：以 { 或 [ 开头
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed) as T
      } catch {
        return null
      }
    }

    // JSONP 形式：callback(...); 抓括号最外层
    // 形如 jQuery371047433947615348115_1788255782963({...});
    const match = trimmed.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/)
    if (match) {
      try {
        return JSON.parse(match[1]) as T
      } catch {
        return null
      }
    }
    return null
  }

  /**
   * 提取摘要：去除 HTML 标签后取前 N 字符。
   * 摘要留空时，界面新闻会用正文前部分做默认摘要，故尽量填充简化版本。
   */
  private extractSummary(html: string, maxLen: number): string {
    const plain = html
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return plain.slice(0, maxLen)
  }
}