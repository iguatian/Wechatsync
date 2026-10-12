/**
 * 华人号（华人头条）创作者平台适配器
 *
 * 平台资料：
 * - 创作者后台 / 编辑器：https://www.52hrtt.com/w/pc/toutiao/dist/index.html#/Publish
 * - 草稿编辑地址：https://www.52hrtt.com/w/pc/toutiao/dist/index.html#/Publish?tiType=1&id={tiId}&name=1
 *
 * 鉴权（Cookie 会话，HAR + 实测验证）：
 * - 业务接口为同站 Cookie 鉴权，扩展 SW fetch 走 credentials: 'include' 即可。
 * - 响应统一为 HTTP 200 + `{code, msg}` 信封；code 为字符串。
 *   - 成功："200"（msg 为数据）
 *   - 未登录 / 登录过期："-401"（msg 为错误文案，如 "用户还未登录"）
 * - 前端 axios 拦截器同样以 data.code == -401 判定登录过期。
 *
 * 图片上传（HAR + 前端源码验证，三步流程）：
 *   1. POST /webapi/toutiao/toposs/signature_for_oss_upload.do（multipart，字段 filename）
 *      → msg: { host, hrttFileHost, policy, signature, x_oss_credential,
 *               x_oss_date, key, security_token }
 *   2. POST {host}（multipart PostObject，OSS4-HMAC-SHA256 表单签名）
 *      字段：success_action_status=200, policy, x-oss-signature,
 *            x-oss-signature-version, x-oss-credential, x-oss-date, key,
 *            x-oss-security-token, x-oss-forbid-overwrite=true, file
 *   3. POST /webapi/toutiao/topImg/uploadImgsByOssUrl.do?ossUrl={hrttFileHost+key}
 *      （前端 axios 以 query 传参、空 multipart body；服务端把 OSS 临时文件
 *       转存为正式图片，msg 即最终图片 URL，如
 *       https://picture01.52hrttpic.com/image/infoImage/...jpg?WxH）
 *
 * 提交文章：POST /webapi/toutiao/topinfo/addDraft.do（multipart）。
 *   HAR 样本（编辑器保存草稿）字段：
 *   tiId(新文章为空), tiType=1, tiTitle, imgType=0, tiTitleImg1/2/3,
 *   tiInfoContent(HTML), isTiming=0, isAllowReward=0, quoteFrom, quoteUrl,
 *   userDeclaration
 *   - HAR 样本未传封面（tiTitleImg1 为空），服务端会自动从正文取图生成封面
 *     （响应中 tiTitleImg1 有值）；本适配器在 article.cover 存在时上传并填入
 *     tiTitleImg1（字段名语义明确，未抓包验证，如异常请校准）。
 *   - 前端 API 路径会拼 `?ie={ts}` 后缀（仅 IE 分支），现代浏览器为空串，可忽略。
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Hrtt')

/** 站点 origin */
const SITE_ORIGIN = 'https://www.52hrtt.com'

/** 编辑器页 URL */
const EDITOR_PAGE = `${SITE_ORIGIN}/w/pc/toutiao/dist/index.html#/Publish`

/** 业务接口前缀 */
const API_BASE = `${SITE_ORIGIN}/webapi/toutiao`

/** 鉴权 / 草稿列表接口（queryPageModel 未登录时返回 code=-401，实测验证） */
const AUTH_CHECK_URL = `${API_BASE}/topinfo/queryPageModel.do`

/** 图片上传签名接口 */
const OSS_SIGNATURE_URL = `${API_BASE}/toposs/signature_for_oss_upload.do`

/** OSS 临时文件转存为正式图片接口 */
const UPLOAD_BY_OSS_URL = `${API_BASE}/topImg/uploadImgsByOssUrl.do`

/** 保存草稿接口 */
const ADD_DRAFT_URL = `${API_BASE}/topinfo/addDraft.do`

/** 平台统一响应包装（HTTP 200，业务码在 code，字符串） */
interface HrttEnvelope<T = unknown> {
  code?: string
  /** 成功时为数据，失败时为错误文案 */
  msg?: T
}

/** signature_for_oss_upload 响应的 msg */
interface HrttOssSignature {
  host: string
  /** 正式图片域（以 / 结尾），最终 URL = hrttFileHost + key */
  hrttFileHost: string
  policy: string
  signature: string
  x_oss_credential: string
  x_oss_date: string
  key: string
  security_token: string
}

/** addDraft 响应的 msg */
interface HrttDraftInfo {
  msg?: string
  info?: {
    tiId?: string
    [key: string]: unknown
  }
}

export class HrttAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'hrtt',
    name: '华人号',
    icon: `${SITE_ORIGIN}/favicon.ico`,
    homepage: SITE_ORIGIN,
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  /** 预处理配置：华人号编辑器接受 HTML 正文 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  /**
   * Header 规则：业务接口同站部署，扩展 SW fetch 的 Origin 是
   * chrome-extension://...，需注入站点 Origin/Referer（与 cqcb 等一致）。
   * OSS 域（host 来自签名响应）在 publish 中按需追加规则。
   */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://www.52hrtt.com/*',
      headers: {
        Origin: SITE_ORIGIN,
        Referer: `${SITE_ORIGIN}/`,
      },
    },
  ]

  // ============ checkAuth ============

  /**
   * 鉴权：调 queryPageModel.do（草稿列表第一页），
   * code=="200" 视为已登录；"-401"（"用户还未登录"）或其他视为未登录。
   */
  async checkAuth(): Promise<AuthResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      try {
        const formData = new FormData()
        formData.append('currentPage', '1')
        formData.append('pageSize', '6')
        formData.append('dateLimit', '0')
        formData.append('tiState', '')
        formData.append('ie', '')
        const data = await this.postMultipart<HrttEnvelope>(`${AUTH_CHECK_URL}?_t=${Date.now()}`, formData)
        if (data.code === '200') {
          return { isAuthenticated: true }
        }
        return {
          isAuthenticated: false,
          error: typeof data.msg === 'string' && data.msg
            ? data.msg
            : `请先登录华人号创作者平台（${EDITOR_PAGE}）`,
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
   * 发布文章（编辑器保存草稿）。
   *
   * 流程（HAR 验证）：
   *   1. checkAuth（确保已登录）
   *   2. processImages 处理正文图片（三步上传，替换 src 为 52hrttpic.com 正式地址）
   *   3. 上传封面（如有）→ tiTitleImg1；无封面留空由服务端自动取正文首图
   *   4. POST addDraft.do → code=="200" 即成功，msg.info.tiId 为草稿 ID
   */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish to Hrtt...')

      // 1. 鉴权
      const auth = await this.checkAuth()
      if (!auth.isAuthenticated) {
        throw new Error(auth.error || '未登录华人号创作者平台')
      }

      // 2. 正文图片
      let content = article.html || ''
      try {
        content = await this.processImages(
          content,
          (src) => this.uploadImageByUrl(src),
          {
            skipPatterns: ['52hrttpic.com'],
            onProgress: options?.onImageProgress,
          },
        )
      } catch (e) {
        logger.warn('[Hrtt] processImages 中途失败，继续发布：', (e as Error).message)
      }

      // 3. 封面（HAR 未覆盖传封面的场景，留空则服务端自动从正文取图）
      let coverUrl: string | null = null
      if (article.cover) {
        try {
          const result = await this.uploadImageByUrl(article.cover)
          coverUrl = result.url
          logger.info(`[Hrtt] 封面上传成功：${coverUrl}`)
        } catch (e) {
          logger.warn('[Hrtt] 封面上传失败：', (e as Error).message)
        }
      }

      // 4. 提交草稿（字段与 HAR 样本一致）
      const formData = new FormData()
      formData.append('tiId', '')
      formData.append('tiType', '1')
      formData.append('tiTitle', article.title)
      formData.append('imgType', '0')
      formData.append('tiTitleImg1', coverUrl || '')
      formData.append('tiTitleImg2', '')
      formData.append('tiTitleImg3', '')
      formData.append('tiInfoContent', content)
      formData.append('isTiming', '0')
      formData.append('isAllowReward', '0')
      formData.append('quoteFrom', '')
      formData.append('quoteUrl', '')
      formData.append('userDeclaration', '')

      const result = await this.postMultipart<HrttEnvelope<HrttDraftInfo>>(`${ADD_DRAFT_URL}?_t=${Date.now()}`, formData)

      if (result.code !== '200') {
        throw new Error(
          (typeof result.msg === 'string' && result.msg) ||
          `提交失败：code=${result.code}`,
        )
      }

      const tiId = result.msg?.info?.tiId
      logger.info(`[Hrtt] 草稿已保存：tiId=${tiId}`)

      // 草稿编辑地址（用户提供的格式：#/Publish?tiType=1&id={tiId}&name=1）
      const postUrl = tiId
        ? `${EDITOR_PAGE}?tiType=1&id=${tiId}&name=1`
        : EDITOR_PAGE

      return this.createResult(true, {
        draftOnly: options?.draftOnly ?? true,
        postUrl,
        coverUploaded: !!coverUrl,
        coverUrl: coverUrl || undefined,
        message: '已保存到华人号草稿箱（可在创作中心查看）',
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
      postUrl: EDITOR_PAGE,
    }))
  }

  // ============ 图片上传 ============

  /**
   * 通过 URL 上传图片（正文 / 封面共用）。
   *
   * 三步流程（前端源码验证）：
   *   1. signature_for_oss_upload.do 获取签名 + 对象键
   *   2. POST {host} PostObject 上传二进制
   *   3. uploadImgsByOssUrl.do?ossUrl=... 服务端转存，msg 即最终图片 URL
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
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

    // 2. 读尺寸（失败不影响上传）
    let width: number | undefined
    let height: number | undefined
    try {
      const bitmap = await createImageBitmap(blob)
      width = bitmap.width
      height = bitmap.height
      bitmap.close()
    } catch {
      logger.debug('[Hrtt] 读取图片尺寸失败，跳过 attrs')
    }

    // 3. 获取签名（filename 与 HAR 样本一致：32 位十六进制 + 扩展名）
    const ext = this.extFromMime(blob.type)
    const filename = `${this.randomHex(32)}.${ext}`
    const sigFd = new FormData()
    sigFd.append('filename', filename)
    const sigResp = await this.postMultipart<HrttEnvelope<HrttOssSignature>>(`${OSS_SIGNATURE_URL}?_t=${Date.now()}`, sigFd)
    if (sigResp.code !== '200' || !sigResp.msg?.host || !sigResp.msg.key) {
      throw new Error(
        (typeof sigResp.msg === 'string' && sigResp.msg) ||
        `获取上传签名失败：code=${sigResp.code}`,
      )
    }
    const sig = sigResp.msg

    // 4. OSS PostObject（表单签名，字段与前端一致）
    const ossFd = new FormData()
    ossFd.append('success_action_status', '200')
    ossFd.append('policy', sig.policy)
    ossFd.append('x-oss-signature', sig.signature)
    ossFd.append('x-oss-signature-version', 'OSS4-HMAC-SHA256')
    ossFd.append('x-oss-credential', sig.x_oss_credential)
    ossFd.append('x-oss-date', sig.x_oss_date)
    ossFd.append('key', sig.key)
    ossFd.append('x-oss-security-token', sig.security_token)
    ossFd.append('x-oss-forbid-overwrite', 'true')
    ossFd.append('file', blob, filename)

    // OSS 域 CORS 未必放行扩展 origin，动态注入 Origin/Referer
    const ossRule: Omit<HeaderRule, 'id'> = {
      urlFilter: `*://${new URL(sig.host).host}/*`,
      headers: {
        Origin: SITE_ORIGIN,
        Referer: `${SITE_ORIGIN}/`,
      },
    }
    await this.withHeaderRules([ossRule], async () => {
      const ossResp = await this.runtime.fetch(sig.host, {
        method: 'POST',
        credentials: 'omit',
        body: ossFd,
      })
      if (!ossResp.ok) {
        const text = await ossResp.text().catch(() => '')
        throw new Error(`图片上传到 OSS 失败 (HTTP ${ossResp.status}): ${text.substring(0, 200)}`)
      }
    })

    // 5. 转存：ossUrl = hrttFileHost + key（前端 axios 以 query 传参、空 body）
    const ossUrl = `${sig.hrttFileHost}${sig.key}`
    const transferFd = new FormData()
    const transferResp = await this.postMultipart<HrttEnvelope>(
      `${UPLOAD_BY_OSS_URL}?ossUrl=${encodeURIComponent(ossUrl)}&_t=${Date.now()}`,
      transferFd,
    )
    if (transferResp.code !== '200' || typeof transferResp.msg !== 'string' || !transferResp.msg) {
      throw new Error(
        (typeof transferResp.msg === 'string' && transferResp.msg) ||
        `图片转存失败：code=${transferResp.code}`,
      )
    }

    const attrs: Record<string, string> = {}
    if (width && height) {
      attrs.width = String(width)
      attrs.height = String(height)
    }
    return { url: transferResp.msg, attrs }
  }

  // ============ 工具方法 ============

  /** 由 MIME 推断扩展名 */
  private extFromMime(mime: string): string {
    if (mime.includes('png')) return 'png'
    if (mime.includes('gif')) return 'gif'
    if (mime.includes('webp')) return 'webp'
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
    return 'jpg'
  }

  /** 生成指定长度的随机十六进制串 */
  private randomHex(len: number): string {
    let s = ''
    while (s.length < len) {
      s += Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')
    }
    return s.slice(0, len)
  }
}
