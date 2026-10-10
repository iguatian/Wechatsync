/**
 * 上游新闻-上游号（重庆）创作者平台适配器
 *
 * 平台资料：
 * - 创作者后台：https://mp.cqcb.com/home
 * - 编辑地址：https://mp.cqcb.com/home#/create/article
 *
 * 鉴权（Cookie 会话）：HAR 中所有 /creator/v1 请求均无可见的 Authorization 头，
 * 响应带 `access-control-allow-credentials: true`，属同站 Cookie 鉴权；
 * 扩展 SW fetch 走 credentials: 'include' 即可自动携带。
 * - 未登录 / 未认证：业务包 HTTP 200 + `statusCode: 426`（"请先认证平台" /
 *   "媒体号不存在,请先注册"），无独立 401，无法进一步区分，统一视为未登录。
 *
 * 图片上传（HAR 验证，阿里云 OSS + 回调）：
 *   1. GET /creator/v1/oss/sts_token → STS 临时凭证 + uploadPath/publicPath/domain/callbackParams
 *   2. PUT https://{bucket}.oss-{region}.aliyuncs.com/{uploadPath}/{yyyy-MM-dd}/{filename}
 *      带 x-oss-callback（sts_token 响应的 callbackParams，base64），
 *      OSS 回调站点后把结果 JSON 原样返回给客户端：data.url 即最终访问地址。
 *      签名为 OSS V1：Authorization: OSS {ak}:{hmac-sha1(base64)}（与 zhihu 同款实现）。
 *   3. 文件名格式：`{毫秒时间戳}{17 位随机数字}.{ext}`（与 HAR 样本一致）。
 *
 * 提交文章：POST /creator/v1/news/add（JSON）。
 *   HAR 样本（编辑器点保存）字段：
 *   { introdution, title, content(HTML), showImgs[], showType, keyword, newsType: 0, status: 2 }
 *   - `introdution` 为平台原生拼写（就是没有 c）。
 *   - showImgs 的 URL 带 `?aspectRatio={w/h}`（保留两位小数）。
 *   - 有封面时 showType = "newsOneImg1"；无图时的取值 HAR 未覆盖，
 *     按 "newsText1" 处理（推测值，如服务端拒绝请抓包校准）。
 *   - status: 2 与 HAR 抓包一致（编辑器保存动作的取值）。
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Cqcb')

/** 创作者后台 origin（业务接口在 t8-api-proxy 子域） */
const SITE_ORIGIN = 'https://mp.cqcb.com'

/** 编辑器页 URL（保存成功后的落点之一） */
const EDITOR_PAGE = `${SITE_ORIGIN}/home#/create/article`

/** 内容管理列表（草稿保存后可在此查看） */
const DRAFT_LIST = `${SITE_ORIGIN}/home#/news/list`

/** 业务接口前缀 */
const API_BASE = 'https://t8-api-proxy.cqcb.com/creator/v1'

/** 鉴权 / 媒体号信息接口 */
const PLATFORM_CONTENT_URL = `${API_BASE}/platform/content`

/** 图片上传凭证接口 */
const STS_TOKEN_URL = `${API_BASE}/oss/sts_token`

/** 提交文章接口 */
const NEWS_ADD_URL = `${API_BASE}/news/add`

/** 有封面时的 showType（HAR 样本值） */
const SHOW_TYPE_ONE_IMG = 'newsOneImg1'

/** 无封面时的 showType（HAR 未覆盖，推测值，待实测校准） */
const SHOW_TYPE_TEXT = 'newsText1'

/** STS 凭证有效期（服务端签发 1 小时，这里保守取 50 分钟） */
const STS_CACHE_TTL = 50 * 60 * 1000

/** OSS 上传 UA（与 HAR 中 aliyun-sdk-js 版本一致） */
const OSS_USER_AGENT = 'aliyun-sdk-js/6.23.0'

/** sts_token 响应 */
interface CqcbStsData {
  accessKeyId: string
  accessKeySecret: string
  securityToken: string
  expiration?: string
  region: string
  bucket: string
  /** base64 的 OSS callback 配置，直接塞进 x-oss-callback 头 */
  callbackParams: string
  uploadPath: string
  publicPath?: string
  domain?: string
}

/** 平台统一响应包装（HTTP 200，业务码在 statusCode） */
interface CqcbEnvelope<T = unknown> {
  statusCode?: number
  message?: string
  data?: T
}

/** OSS PUT + callback 的响应（回调结果原样返回） */
interface CqcbOssUploadResp {
  statusCode?: number
  message?: string
  data?: {
    url?: string
    pendingTaskId?: number
    [key: string]: unknown
  }
}

/** news/add 请求体 */
interface CqcbNewsAddBody {
  introdution: string
  title: string
  content: string
  showImgs: string[]
  showType: string
  keyword: string
  newsType: number
  status: number
}

export class CqcbAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'cqcb',
    name: '上游新闻',
    icon: `${SITE_ORIGIN}/favicon.ico`,
    homepage: `${SITE_ORIGIN}/home`,
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  /** 预处理配置：上游号编辑器接受 HTML 正文 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  /**
   * Header 规则：业务网关的 CORS 仅放行 `https://mp.cqcb.com`，
   * 扩展 SW fetch 的 Origin 是 chrome-extension://...，必须注入；
   * OSS 域（bucket/region 动态）在 publish 中按需追加规则。
   */
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://t8-api-proxy.cqcb.com/*',
      headers: {
        Origin: SITE_ORIGIN,
        Referer: `${SITE_ORIGIN}/`,
      },
    },
  ]

  /** 本次 publish 会话内的 STS 凭证缓存 */
  private stsCache: { data: CqcbStsData; fetchedAt: number } | null = null

  // ============ checkAuth ============

  /**
   * 鉴权：调 platform/content，statusCode==200 视为已登录已认证；
   * 426（"请先认证平台" / "媒体号不存在,请先注册"）或其他一律视为未登录。
   */
  async checkAuth(): Promise<AuthResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      try {
        const resp = await this.runtime.fetch(`${PLATFORM_CONTENT_URL}?_t=${Date.now()}`, {
          credentials: 'include',
          headers: { Accept: 'application/json, text/plain, */*' },
        })
        if (!resp.ok) {
          return { isAuthenticated: false, error: `HTTP ${resp.status}` }
        }
        const data = (await resp.json()) as CqcbEnvelope
        if (data.statusCode === 200) {
          return { isAuthenticated: true }
        }
        return {
          isAuthenticated: false,
          error: data.message || `请先登录上游号（${SITE_ORIGIN}/home）`,
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
   * 发布文章（编辑器保存）。
   *
   * 流程（HAR 验证）：
   *   1. checkAuth（确保已登录）
   *   2. processImages 处理正文图片（替换 src 为 image1.cqcb.com 地址）
   *   3. 上传封面（如有）→ showImgs + showType
   *   4. POST news/add → statusCode==200 即成功
   */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish to Cqcb...')

      // 1. 鉴权
      const auth = await this.checkAuth()
      if (!auth.isAuthenticated) {
        throw new Error(auth.error || '未登录上游号创作者平台')
      }

      // 2. 正文图片
      let content = article.html || ''
      try {
        content = await this.processImages(
          content,
          (src) => this.uploadImageByUrl(src),
          {
            skipPatterns: ['cqcb.com'],
            onProgress: options?.onImageProgress,
          },
        )
      } catch (e) {
        logger.warn('[Cqcb] processImages 中途失败，继续发布：', (e as Error).message)
      }

      // 3. 封面
      let coverUrl: string | null = null
      let coverRatio: string | undefined
      if (article.cover) {
        try {
          const result = await this.uploadImageByUrl(article.cover)
          coverUrl = result.url
          coverRatio = result.attrs?.aspectRatio as string | undefined
          logger.info(`[Cqcb] 封面上传成功：${coverUrl}`)
        } catch (e) {
          logger.warn('[Cqcb] 封面上传失败：', (e as Error).message)
        }
      }

      // 4. showImgs / showType（URL 带 aspectRatio，与 HAR 一致）
      const showImgs = coverUrl
        ? [coverRatio ? `${coverUrl}?aspectRatio=${coverRatio}` : coverUrl]
        : []

      // 5. 摘要 / 关键字
      const introdution = this.extractSummary(content, article.summary, 120)
      const keyword = (article.tags || []).join(',')

      // 6. 提交
      const body: CqcbNewsAddBody = {
        introdution,
        title: article.title,
        content,
        showImgs,
        showType: coverUrl ? SHOW_TYPE_ONE_IMG : SHOW_TYPE_TEXT,
        keyword,
        newsType: 0,
        status: 2,
      }
      const result = await this.postJson<CqcbEnvelope>(`${NEWS_ADD_URL}?_t=${Date.now()}`, body as unknown as Record<string, unknown>)

      if (result.statusCode !== 200) {
        throw new Error(
          result.message || `提交失败：statusCode=${result.statusCode}` +
          (result.statusCode === 426 ? '（请先在上游号平台完成认证）' : ''),
        )
      }

      logger.info('[Cqcb] 文章已提交')
      return this.createResult(true, {
        draftOnly: options?.draftOnly ?? true,
        postUrl: DRAFT_LIST,
        coverUploaded: !!coverUrl,
        coverUrl: coverUrl || undefined,
        message: '已保存到上游新闻·上游号（可在内容管理中查看）',
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
   * OSS PUT 带 x-oss-callback（sts_token 响应的 callbackParams），
   * 响应体就是回调结果 JSON：data.url 即最终访问地址。
   * attrs 中带回 width/height/aspectRatio（读不到尺寸时缺省）。
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
      logger.debug('[Cqcb] 读取图片尺寸失败，跳过 aspectRatio')
    }

    // 3. STS 凭证
    const sts = await this.ensureSts()

    // 4. 对象键：{uploadPath}/{yyyy-MM-dd}/{时间戳+17位随机}.{ext}
    const ext = this.extFromMime(blob.type)
    const filename = `${Date.now()}${this.randomDigits(17)}.${ext}`
    const objectKey = `${sts.uploadPath}/${this.localDateString()}/${filename}`

    // 5. OSS PUT（V1 签名 + callback）
    const url = await this.ossPutWithCallback(sts, objectKey, blob)

    const attrs: Record<string, string> = {}
    if (width && height) {
      attrs.width = String(width)
      attrs.height = String(height)
      attrs.aspectRatio = (width / height).toFixed(2)
    }
    return { url, attrs }
  }

  /** 获取（带缓存的）STS 凭证 */
  private async ensureSts(): Promise<CqcbStsData> {
    if (this.stsCache && Date.now() - this.stsCache.fetchedAt < STS_CACHE_TTL) {
      return this.stsCache.data
    }
    const resp = await this.runtime.fetch(`${STS_TOKEN_URL}?_t=${Date.now()}`, {
      credentials: 'include',
      headers: { Accept: 'application/json, text/plain, */*' },
    })
    if (!resp.ok) {
      throw new Error(`获取上传凭证失败：HTTP ${resp.status}`)
    }
    const data = (await resp.json()) as CqcbEnvelope<CqcbStsData>
    if (data.statusCode !== 200 || !data.data?.accessKeyId || !data.data.uploadPath) {
      throw new Error(data.message || `获取上传凭证失败：statusCode=${data.statusCode}`)
    }
    this.stsCache = { data: data.data, fetchedAt: Date.now() }
    return data.data
  }

  /**
   * OSS PUT + callback（V1 签名，与 zhihu 适配器同款实现）。
   *
   * 签名细节：
   * - CanonicalizedOSSHeaders 含 x-oss-callback / x-oss-date / x-oss-security-token /
   *   x-oss-user-agent（按字母排序，每行以 \n 结尾）。
   * - stringToSign 的 Date 位置与 x-oss-date 相同。
   */
  private async ossPutWithCallback(
    sts: CqcbStsData,
    objectKey: string,
    blob: Blob,
  ): Promise<string> {
    const contentType = blob.type || 'application/octet-stream'
    const endpoint = `https://${sts.bucket}.oss-${sts.region}.aliyuncs.com`
    const url = `${endpoint}/${objectKey}`

    // OSS 日期格式 (GMT)
    const ossDate = new Date().toUTCString()

    // CanonicalizedOSSHeaders（按字母顺序排列，每行以 \n 结尾）
    const ossHeaders: Record<string, string> = {
      'x-oss-callback': sts.callbackParams,
      'x-oss-date': ossDate,
      'x-oss-security-token': sts.securityToken,
      'x-oss-user-agent': OSS_USER_AGENT,
    }
    const canonicalizedOSSHeaders = Object.keys(ossHeaders)
      .sort()
      .map(key => `${key}:${ossHeaders[key]}`)
      .join('\n')

    // CanonicalizedResource: /{bucket}/{objectKey}
    const canonicalizedResource = `/${sts.bucket}/${objectKey}`

    // stringToSign: VERB + Content-MD5 + Content-Type + Date + CanonicalizedOSSHeaders + CanonicalizedResource
    const stringToSign =
      'PUT\n' +
      '\n' + // Content-MD5（空）
      contentType + '\n' +
      ossDate + '\n' +
      canonicalizedOSSHeaders + '\n' +
      canonicalizedResource

    const signature = await this.hmacSha1Base64(sts.accessKeySecret, stringToSign)
    const authorization = `OSS ${sts.accessKeyId}:${signature}`

    // OSS 域 CORS 未必放行扩展 origin，动态注入 Origin/Referer（与 HAR 一致）
    const ossRule: Omit<HeaderRule, 'id'> = {
      urlFilter: `*://${sts.bucket}.oss-${sts.region}.aliyuncs.com/*`,
      headers: {
        Origin: SITE_ORIGIN,
        Referer: `${SITE_ORIGIN}/`,
      },
    }
    return this.withHeaderRules([ossRule], async () => {
      const resp = await this.runtime.fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'Authorization': authorization,
          'x-oss-callback': sts.callbackParams,
          'x-oss-date': ossDate,
          'x-oss-security-token': sts.securityToken,
          'x-oss-user-agent': OSS_USER_AGENT,
        },
        body: blob,
      })

      const text = await resp.text()
      let data: CqcbOssUploadResp
      try {
        data = JSON.parse(text) as CqcbOssUploadResp
      } catch {
        throw new Error(`图片上传失败：响应非 JSON (HTTP ${resp.status}): ${text.substring(0, 200)}`)
      }
      if (data.statusCode !== 200 || !data.data?.url) {
        throw new Error(data.message || `图片上传失败：statusCode=${data.statusCode}`)
      }
      return data.data.url
    })
  }

  // ============ 工具方法 ============

  /**
   * HMAC-SHA1 签名并返回 Base64 (使用 Web Crypto API)
   */
  private async hmacSha1Base64(key: string, message: string): Promise<string> {
    const encoder = new TextEncoder()
    const keyData = encoder.encode(key)
    const messageData = encoder.encode(message)

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign'],
    )

    const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData)
    return btoa(String.fromCharCode(...new Uint8Array(signature)))
  }

  /** 由 MIME 推断扩展名（HAR 样本为 jpg/png） */
  private extFromMime(mime: string): string {
    if (mime.includes('png')) return 'png'
    if (mime.includes('gif')) return 'gif'
    if (mime.includes('webp')) return 'webp'
    return 'jpg'
  }

  /** 生成长度为 len 的随机数字串（允许前导零） */
  private randomDigits(len: number): string {
    let s = ''
    for (let i = 0; i < len; i++) {
      s += Math.floor(Math.random() * 10)
    }
    return s
  }

  /** 本地日期 yyyy-MM-dd（与编辑器生成上传目录的方式一致） */
  private localDateString(): string {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  /**
   * 提取摘要：优先 article.summary，否则取正文前 N 字纯文本（去 HTML 标签）。
   */
  private extractSummary(html: string, fallback: string | undefined, maxLen: number): string {
    if (fallback && fallback.trim()) return fallback.trim().slice(0, maxLen)
    const plain = html
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return plain.slice(0, maxLen)
  }
}
