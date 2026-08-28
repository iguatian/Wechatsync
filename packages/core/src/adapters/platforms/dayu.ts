/**
 * 大鱼号适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('DaYu')

interface DaYuMeta {
  utoken: string
  /** 用于 imageUpload（图床上传）的 sign */
  uploadSign: string
  /** 用于 imagecut（封面裁剪）的 sign（与 uploadSign 不同，缺失时降级用 uploadSign） */
  imageCutSign?: string
  uid: string
  title: string
  avatar: string
}

/** 正文已上传图片的元数据，封面裁剪时复用 */
interface UploadedImage {
  /** 大鱼号代理 URL：mp.dayu.com/dayu/image?t=...&s=...&p=... */
  org_url: string
  /** image.uc.cn CDN URL：image.uc.cn/s/wemedia/s/upload/... */
  url: string
  /** 原图宽度（imageUpload 响应或 createImageBitmap 探测，HAR 显示为 1484） */
  width?: number
  /** 原图高度（HAR 显示为 628） */
  height?: number
  /**
   * 原图 MD5，与正文里 <img data-md5=""> 一致；
   * 用于 save-draft 的 origin_cover_img 字段。
   *
   * 来源：1) imageUpload 响应（优先） 2) 本地计算（服务端不返回时）
   *
   * Web Crypto 的 SubtleCrypto 不支持 MD5，所以我们用本地纯 JS 计算。
   */
  md5?: string
}

/**
 * 把时间戳格式化成大鱼号 assistantStat 需要的本地时间串
 * （HAR 样本：2026-08-28 14:28:25，本地时区，空格分隔）
 */
function formatStatTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

/** 跑完横竖裁剪后拿到的最终 cover URL */
interface CoverCropResult {
  /** 横屏（16:9）裁剪后封面（image.uc.cn/s/wemedia/...），赋给 save-draft 的 coverImg */
  horizontalUrl: string
  /** 竖屏（3:4）裁剪后封面，赋给 save-draft 的 verticalCoverImg */
  verticalUrl: string
  /**
   * 裁剪前原图的 URL（imagecut 响应里的 oriUrl）。
   * HAR 验证：save-draft 的 origin_cover_url 就是这个值，
   * 不是 imageUpload 返回的 url（两者可能不同：服务端可能转存过原图）。
   */
  originCoverUrl: string
}

/** 大鱼号横屏比例 16:9（HAR ratio=1.7777777777777777） */
const HORIZONTAL_RATIO = 16 / 9
/** 大鱼号竖屏比例 3:4（HAR ratio=0.75） */
const VERTICAL_RATIO = 3 / 4

export class DayuAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'dayu',
    name: '大鱼号',
    icon: 'https://image.uc.cn/s/uae/g/1v/images/index/favicon.ico',
    homepage: 'https://mp.dayu.com/dashboard/account/profile',
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  /** 预处理配置: 大鱼号使用 HTML 格式 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  /** 大鱼号 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://mp.dayu.com/*',
      headers: {
        'Origin': 'https://mp.dayu.com',
        // HAR 验证：编辑器发起的请求 referer 是编辑器页完整路径，
        // 用根路径 'https://mp.dayu.com/' 会被 getCoverSelection 拒绝（HTTP 500）
        'Referer': 'https://mp.dayu.com/dashboard/article/write',
      },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://ns.dayu.com/*',
      headers: {
        'Origin': 'https://mp.dayu.com',
        'Referer': 'https://mp.dayu.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  private cacheMeta: DaYuMeta | null = null
  private uploadedImages: UploadedImage[] = []

  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch(
        'https://mp.dayu.com/dashboard/index',
        {
          method: 'GET',
          credentials: 'include',
        }
      )

      const pageHtml = await response.text()
      const markStr = 'var globalConfig = '
      const authIndex = pageHtml.indexOf(markStr)

      if (authIndex === -1) {
        return { isAuthenticated: false }
      }

      const authTokenStr = pageHtml.substring(
        authIndex + markStr.length,
        pageHtml.indexOf('var G = {', authIndex)
      )

      // 使用 JSON 解析代替 eval
      const pageConfig = this.parseGlobalConfig(authTokenStr)

      if (!pageConfig || !pageConfig.utoken) {
        return { isAuthenticated: false }
      }

      this.cacheMeta = {
        utoken: pageConfig.utoken,
        uploadSign: pageConfig.nsImageUploadSign,
        imageCutSign: pageConfig.nsImgCutSign,
        uid: pageConfig.wmid,
        title: pageConfig.weMediaName,
        avatar: pageConfig.wmAvator?.indexOf('http') > -1
          ? pageConfig.wmAvator
          : pageConfig.wmAvator?.replace('//', 'https://') || '',
      }

      // 服务端有时不给 nsImgCutSign，降级复用 uploadSign；两个签名都拿不到时
      // imagecut 调用会失败，封面降级路径仍然能跑（用第一张正文图的 org_url）
      if (!this.cacheMeta.imageCutSign) {
        this.cacheMeta.imageCutSign = this.cacheMeta.uploadSign
        logger.warn('[Dayu] globalConfig 缺 nsImgCutSign，imagecut 临时复用 nsImageUploadSign')
      }

      return {
        isAuthenticated: true,
        userId: this.cacheMeta.uid,
        username: this.cacheMeta.title,
        avatar: this.cacheMeta.avatar,
      }
    } catch (error) {
      logger.error('checkAuth error:', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  /**
   * 解析 globalConfig JavaScript 对象
   */
  private parseGlobalConfig(configStr: string): Record<string, string> | null {
    try {
      // 尝试清理并解析 JavaScript 对象字面量
      // 移除末尾的分号和空白
      let cleaned = configStr.trim()
      if (cleaned.endsWith(';')) {
        cleaned = cleaned.slice(0, -1)
      }

      // 尝试用 JSON 解析（如果格式兼容）
      // 将单引号替换为双引号，处理无引号的 key
      const jsonStr = cleaned
        .replace(/'/g, '"')
        .replace(/(\w+):/g, '"$1":')
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']')

      return JSON.parse(jsonStr)
    } catch {
      // 如果 JSON 解析失败，使用正则提取关键字段
      const result: Record<string, string> = {}

      const patterns: Record<string, RegExp> = {
        utoken: /utoken['":\s]+['"]([^'"]+)['"]/,
        nsImageUploadSign: /nsImageUploadSign['":\s]+['"]([^'"]+)['"]/,
        nsImgCutSign: /nsImgCutSign['":\s]+['"]([^'"]+)['"]/,
        wmid: /wmid['":\s]+['"]([^'"]+)['"]/,
        weMediaName: /weMediaName['":\s]+['"]([^'"]+)['"]/,
        wmAvator: /wmAvator['":\s]+['"]([^'"]+)['"]/,
      }

      for (const [key, pattern] of Object.entries(patterns)) {
        const match = configStr.match(pattern)
        if (match) {
          result[key] = match[1]
        }
      }

      return Object.keys(result).length > 0 ? result : null
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      // 重置上传图片列表
      this.uploadedImages = []

      // 1. 确保已登录
      if (!this.cacheMeta) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('请先登录大鱼号')
        }
      }

      // 2. 使用预处理好的 HTML 内容
      let content = article.html || ''

      // 3. 处理图片
      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['dayu.com', 'uc.cn'],
          onProgress: options?.onImageProgress,
        }
      )

      // 4. 封面裁剪（HAR 验证）
      //    大鱼号封面不是直接传原图 URL，而是通过 getCoverSelection + imagecut
      //    两步生成 image.uc.cn 图床上的裁剪后 URL。
      //
      //    关键：不要依赖 processImages 的 uploadedImages——因为正文里的图
      //    可能是 mp.dayu.com 代理 URL（已经在前次发布中上传过），会被
      //    skipPatterns ['dayu.com', 'uc.cn'] 跳过，导致 uploadedImages 为空。
      //    封面裁剪必须能从正文任意位置拿到一张图（不限域名，HAR 验证
      //    imagecut 的 imgSrc 可以是 mp.dayu.com 代理 URL，服务端接受）。
      let coverImg = ''
      let verticalCoverImg = ''
      let originCoverUrl = ''
      let coverFrom = 'auto'
      const coverSource = await this.pickCoverSource(content, this.uploadedImages)
      if (coverSource) {
        try {
          const cropped = await this.runCoverCropping(coverSource)
          if (cropped.horizontalUrl) {
            coverImg = cropped.horizontalUrl
            coverFrom = 'manual'
          }
          verticalCoverImg = cropped.verticalUrl || ''
          originCoverUrl = cropped.originCoverUrl || ''
          logger.info(
            `[Dayu] 封面裁剪完成：横屏=${coverImg.slice(0, 120)} 竖屏=${verticalCoverImg.slice(0, 120)} origin=${originCoverUrl.slice(0, 120)}（源 ${coverSource.from}）`,
          )
        } catch (e) {
          // 裁剪失败不阻断发布。降级值必须过校验：
          //  - HAR 验证服务端只认 image.uc.cn 的封面 URL，传其他值（代理 URL、
          //    空串、未知格式）会报 "封面图地址非法"，宁可空着走 auto。
          //  - org_url = mp.dayu.com/dayu/image?t=...&s=...&p=... 是代理 URL，
          //    其 &p= 参数有过期时间，服务端拿这个 URL 二次取图可能 403/404。
          logger.warn('[Dayu] 封面裁剪失败，封面走服务端 auto：', (e as Error).message)
          const cdnUrl = coverSource.url || ''
          coverImg = /^https?:\/\/[^\s]*uc\.cn\//i.test(cdnUrl) ? cdnUrl : ''
          coverFrom = 'auto'
          verticalCoverImg = ''
          originCoverUrl = ''
        }
      }

      // 5. 保存草稿
      //    HAR mp.dayu-save.com.har 验证字段名（重点）：
      //      - coverImg             = 横屏封面阫裁后的 URL（imagecut 返回的 image.uc.cn URL）
      //      - vertical_cover_url   = 竖屏封面阫裁后的 URL（注意 snake_case）
      //      - origin_cover_url     = 原始封面阫裁前的 URL（原图 imageUpload 返回的 image.uc.cn URL）
      //      - origin_cover_img     = 原图的 MD5（与正文 <img data-md5=> 一致，用于咘定）
      //      - cover_from           = 'auto_replaced'，表示"原 auto 已被覆盖"
      //      - covers[0..2]         = 三元素数组（本期请求体里都是空，发过去服务熢不报错）
      //
      //    裁剪成功时：横屏用裁剪后 URL，竖屏用裁剪后 URL，origin_* 指向原图，
      //                cover_from='auto_replaced'；
      //    裁剪失败时：横屏退回 .org_url，竖屏不传，cover_from='auto'。
      //
      //    字段顺序严格对齐 HAR（mp.dayu-save.com.har 中 Post params 顺序），
      //    后端可能严格按位置/顺序校验。
      const pageOpenTime = Date.now()
      const rid = this.generateRid()
      const formData = new URLSearchParams()

      // 会话 ID（编辑器 HAR 实测：32 位 hex；同一次 publish 的
      // getCoverSelection / imagecut / save-draft 全部用同一 _rid）
      formData.append('_rid', rid)

      // 活动相关（HAR 写死，不传可能后端验证不过）
      formData.append('labor_activity_mode', '1')
      formData.append('labor_activity_id', '')
      formData.append('is_join_labor', 'false')
      formData.append('is_fans_show', 'false')

      // 编辑器状态
      formData.append('isPaste', '0')

      // 草稿 ID（新建留空，后续走 article.draftId / articleId / contentId）
      formData.append('draft_id', '')
      formData.append('article_id', '')
      formData.append('content_id', '')

      // 标题与正文
      formData.append('title', article.title)
      formData.append('sub_title', '')
      formData.append('content', content)

      // 作者与来源
      // HAR 实测：author 是空字符串（服务端自己填），传登录名反而可能触发校验差异
      formData.append('author', '')
      formData.append('source_remark', '')
      // HAR source_remark_detail[type]=无需标注（'无需标注' 表示不声明来源）
      formData.append('source_remark_detail[type]', '无需标注')

      // 封面（空值不传，实测日志：传空 coverImg 服务端报"封面图地址非法"；
      // 不传该字段让服务端走 auto 逻辑）
      if (coverImg) {
        formData.append('coverImg', coverImg)
      }
      if (verticalCoverImg) {
        // HAR 实测：大鱼号竖屏封面字段名是 snake_case 的 vertical_cover_url
        formData.append('vertical_cover_url', verticalCoverImg)
      }
      // HAR 验证：origin_cover_url = imagecut 响应里的 oriUrl（裁剪前原图 URL），
      // 不是 imageUpload 的 url（服务端可能转存过原图，两者不同）。
      // 兑底顺序：imagecut oriUrl > imageUpload url，都无则不传。
      const originUrl = originCoverUrl || this.uploadedImages[0]?.url || ''
      if (originUrl) {
        formData.append('origin_cover_url', originUrl)
      }
      // origin_cover_img 是原图 MD5（与正文里 data-md5 一致）；
      // uploadImageByUrl 会尽量从 imageUpload 响应里取，取不到就留空。
      const originMd5 = this.uploadedImages[0]?.md5
      if (originMd5) {
        formData.append('origin_cover_img', originMd5)
      }
      // covers[0..2] 三元数组（HAR 都是空字符串，在这里也跟 Harborv 一致）
      for (let i = 0; i < 3; i++) {
        formData.append(`covers[${i}][url]`, '')
        formData.append(`covers[${i}][srcUrl]`, '')
        formData.append(`covers[${i}][from]`, '')
      }
      // cover_from：取到裁剪后封面时用 'auto_replaced'（跟 HAR 一致），
      // 裁剪失败时退回 'auto'，保证草稿至少能存。
      formData.append('cover_from', coverFrom === 'manual' ? 'auto_replaced' : coverFrom)

      // 文章类型 / 微信推广 / 原创
      formData.append('article_type', '1')
      formData.append('weixin_promote', 'false')
      formData.append('is_original', '0')

      // 活动标题/ID（HAR 为空，不发后端不会报错）
      formData.append('article_activity_title', '')
      formData.append('article_activity_id', '')

      // 各项 flag（HAR 实测：默认全 false/0）
      formData.append('open_award', '0')
      formData.append('open_reproduce', '0')
      formData.append('is_show_ad', 'false')
      formData.append('defaultAuthor', 'false')
      formData.append('curDaySubmit', 'false')
      // 简单模式：HAR 为 true（大鱼号新版编辑器的默认状态）
      formData.append('simpleMode', 'true')

      // 定时发布（HAR 为 false；time_for_release 仍发一个未来时间戳）
      formData.append('is_timed_release', 'false')
      formData.append('time_for_release', String(Date.now() + 24 * 3600 * 1000))

      // 关键字 / 独家 / 副标题相关
      formData.append('keyword', '')
      formData.append('is_exclusive', 'false')
      formData.append('second_title', '')
      formData.append('use_second_title', 'false')
      formData.append('use_multi_cover', 'false')
      formData.append('isCloseAdManual', 'false')

      // 客户端统计（编辑器从打开到保存的耗时）
      formData.append('pageOpenTime', String(pageOpenTime))
      // HAR 实测 useTime 是真实编辑耗时（64633ms）；传 0 可能被服务端当异常客户端
      formData.append('useTime', '60000')

      // assistantStat 全套（HAR 实测，写作助手统计，全 0 + 时间戳；
      // 完全不传的话与真实编辑器请求差异过大，可能导致服务端拒绝部分字段落地）
      const statEntries: Array<[string, string]> = [
        ['assistantStat[titleTyposCount]', '0'],
        ['assistantStat[totalTitleTyposCount]', '0'],
        ['assistantStat[titleWarningCount]', '0'],
        ['assistantStat[totalTitleWarningCount]', '0'],
        ['assistantStat[contentTyposCount]', '0'],
        ['assistantStat[totalContentTyposCount]', '0'],
        ['assistantStat[contentDiversionsCount]', '0'],
        ['assistantStat[imageDiversionItemsCount]', '0'],
        ['assistantStat[totalImageDiversionItemsCount]', '0'],
        ['assistantStat[textDiversionItemsCount]', '0'],
        ['assistantStat[totalTextDiversionItemsCount]', '0'],
        ['assistantStat[totalContentDiversionsCount]', '0'],
        ['assistantStat[totalCorrectContentTypoCount]', '0'],
        ['assistantStat[previousTitle]', ''],
        ['assistantStat[titleUpdateStartAt]', formatStatTime(pageOpenTime)],
        ['assistantStat[contentUpdateStartAt]', formatStatTime(pageOpenTime + 30_000)],
        ['assistantStat[contentUpdateEndAt]', formatStatTime(pageOpenTime + 33_000)],
      ]
      for (const [k, v] of statEntries) {
        formData.append(k, v)
      }
      // HAR 实测：这个数组字段重复 append 7 次
      for (let i = 0; i < 7; i++) {
        formData.append('assistantStat[totalTitleTypoTypeCounts][]', '0')
      }

      formData.append('utoken', this.cacheMeta!.utoken)

      const response = await this.runtime.fetch(
        'https://mp.dayu.com/dashboard/save-draft',
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'utoken': this.cacheMeta!.utoken,
          },
          body: formData,
        }
      )

      const res = await response.json() as {
        code?: number
        error?: string
        message?: string
        errmsg?: string
        data?: { _id: string }
      }

      logger.debug('Save response:', res)
      // 完整响应打成单行 JSON：排查“草稿保存成功但某封面字段未落地”时
      // 需要看服务端回显的 coverImg / vertical_cover_url / covers 实际值
      logger.info('[Dayu] save-draft 完整响应：', JSON.stringify(res).slice(0, 800))

      // 大鱼号后端标准响应格式：code:0 表示成功。必须显式判 !== 0，
      // 不能用 truthy（0 是 falsy 会误报失败）。HAR save-draft 是 HTTP 200，
      // 但响应 body 里可能带 code:1/message 表示业务失败。
      if (res.code !== undefined && res.code !== 0) {
        throw new Error(
          res.message || res.errmsg || `save-draft 业务失败 (code=${res.code})`,
        )
      }

      if (res.error) {
        throw new Error(res.error)
      }

      if (!res.data?._id) {
        throw new Error('保存草稿失败：响应未含 _id')
      }

      const postId = res.data._id
      const draftUrl = `https://mp.dayu.com/dashboard/article/write?draft_id=${postId}`

      // 6. 回读验证（诊断"save-draft 成功但横屏封面在草稿详情页不显示"）
      //    a) getDraftInfo：编辑器打开草稿详情用的接口（dao.js 确认），响应结构
      //       未知（可能嵌套/data 是字符串），直接打完整响应。
      //    b) getDraftList：草稿列表接口（HAR 实测：响应 draftData.data[]，
      //       存储层字段名 cover_url / vertical_cover_url / covers；编辑器那篇
      //       cover_url 有值且横屏显示正常）——直接对照我们刚存的这篇。
      try {
        const commonHeaders = {
          'utoken': this.cacheMeta!.utoken,
          'x-requested-with': 'XMLHttpRequest',
        }
        const checkResp = await this.runtime.fetch(
          `https://mp.dayu.com/dashboard/getDraftInfo?draft_id=${postId}&article_id=&content_id=&article_category=`,
          { method: 'GET', credentials: 'include', headers: commonHeaders },
        )
        const checkText = await checkResp.text()
        // 响应是平铺结构但 content 全文在里面（很大），只提取封面相关字段：
        // 上次截断 1200 字符时 cover 字段在 content 之后没露出来；
        // 编辑器渲染封面区读的就是这个接口，字段全貌（含 cover_from 等状态位）
        // 能解释前端为什么会清横屏封面
        try {
          const infoData =
            (JSON.parse(checkText) as { data?: Record<string, unknown> }).data ?? {}
          const coverFields: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(infoData)) {
            if (k.toLowerCase().includes('cover')) {
              coverFields[k] =
                typeof v === 'string' && v.length > 140 ? `${v.slice(0, 140)}...` : v
            }
          }
          logger.info(
            `[Dayu] getDraftInfo 封面字段：`,
            JSON.stringify(coverFields),
          )
        } catch {
          logger.info(
            `[Dayu] getDraftInfo HTTP ${checkResp.status}（解析失败，原文）：`,
            checkText.slice(0, 600),
          )
        }
      
        const listResp = await this.runtime.fetch(
          `https://mp.dayu.com/dashboard/getDraftList?_rid=${this.generateRid()}&page=1&_=${Date.now()}`,
          { method: 'GET', credentials: 'include', headers: commonHeaders },
        )
        const listJson = (await listResp.json()) as {
          draftData?: { data?: Array<Record<string, unknown>> }
        }
        const items = listJson?.draftData?.data ?? []
        // 全列表摘要：能看到历史草稿（如横屏"过会儿消失"的那篇）的 cover_url
        // 是否被服务端清掉 —— 判定"存储被清"还是"前端展示被清"的关键证据
        const summary = items
          .slice(0, 8)
          .map(
            (it) =>
              `${String(it._id).slice(0, 8)}:cover=${it.cover_url ? 'Y' : 'N'}/vert=${it.vertical_cover_url ? 'Y' : 'N'}`,
          )
          .join(' | ')
        const ours = items.find((it) => it._id === postId)
        if (ours) {
          logger.info(
            `[Dayu] 草稿存储值：cover_url=${ours.cover_url} vertical_cover_url=${ours.vertical_cover_url} covers=${JSON.stringify(ours.covers)}`,
          )
        }
        logger.info(
          `[Dayu] 草稿列表（${items.length} 条）：${summary || '空'}${ours ? '' : `（未含本篇 ${postId}）`}`,
        )
      } catch (e) {
        logger.warn('[Dayu] 草稿回读失败（不影响发布）：', (e as Error).message)
      }

      return this.createResult(true, {
        postId: postId,
        postUrl: draftUrl,
        draftOnly: options?.draftOnly ?? true,
        coverUploaded: !!coverImg,
        coverUrl: coverImg || undefined,
        message: verticalCoverImg
          ? '已保存大鱼号草稿（横屏+竖屏封面已设置）'
          : coverImg
            ? '已保存大鱼号草稿（横屏封面已设置）'
            : '已保存大鱼号草稿',
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  // ================== 封面裁剪（HAR 验证的大鱼号真实接口） ==================

  /**
   * 跑封面裁剪完整流程：
   *   1. 拿原图尺寸（优先 imageUpload 响应，其次 createImageBitmap 探测）
   *   2. 横屏 16:9 裁剪（一次 getCoverSelection + 一次 imagecut）
   *   3. 竖屏 3:4 裁剪（同上，复用同一张 _rid）
   *
   * 任意一步出错都抛出，由 publish() 降级（不传输竖屏、横屏用 org_url）。
   */
  private async runCoverCropping(source: UploadedImage): Promise<CoverCropResult> {
    if (!this.cacheMeta) throw new Error('未登录')

    // 原图尺寸：uploadedImages 里已优先于探测，缺少再 fallback
    let { width, height } = source
    if (!width || !height) {
      const probed = await this.fetchImageDimensions(source.url)
      width = probed.width
      height = probed.height
    }
    if (!width || !height) {
      throw new Error(
        `封面图无法获取尺寸（src=${source.url.slice(0, 120)}...）`
      )
    }

    // _rid 同时用于横竖 getCoverSelection/imagecut，编辑器中的行为也是这样
    // （HAR：6 个请求全部用同一个 _rid=5192cd9591034a029fde0464035cbcde）
    const rid = this.generateRid()

    // 裁剪接口的 src 必须是大鱼号代理 URL（服务端靠它定位原图，见 pickCropSrc）
    const cropSrc = this.pickCropSrc(source)

    const horizontal = await this.cropCoverOne(
      cropSrc,
      width,
      height,
      HORIZONTAL_RATIO,
      rid,
    )
    const vertical = await this.cropCoverOne(
      cropSrc,
      width,
      height,
      VERTICAL_RATIO,
      rid,
    )

    return {
      horizontalUrl: horizontal.url,
      verticalUrl: vertical.url,
      // HAR 验证：origin_cover_url = imagecut 返回的 oriUrl（裁剪前原图）
      originCoverUrl: horizontal.oriUrl,
    }
  }

  /**
   * 裁剪接口（getCoverSelection/imagecut）的 src 必须是大鱼号代理 URL
   * （mp.dayu.com/dayu/image?...&p=...）：服务端内部靠 URL 里的 p 参数
   * 定位原图（HAR 验证，编辑器传的就是这种形式）。传其他形式
   * （如 image.uc.cn CDN URL）服务端解析不了，会返回
   * code 50000 "网络异常，请稍后再试"（实测）。
   */
  private pickCropSrc(source: UploadedImage): string {
    const candidates = [source.org_url, source.url].filter(Boolean) as string[]
    for (const c of candidates) {
      if (c.includes('mp.dayu.com/dayu/image')) return c
    }
    logger.warn(
      `[Dayu] imageUpload 未返回代理 URL，尝试用 org_url 兑底：` +
      `org_url=${source.org_url?.slice(0, 120)} url=${source.url?.slice(0, 120)}`,
    )
    return source.org_url || source.url || ''
  }

  /**
   * 选择封面裁剪源图：
   *   1. 优先用 processImages 已上传的图（uploadedImages[0]）——这是正常路径
   *   2. 否则从 article.html 里手动提取第一张图，主动调用 uploadImageByUrl 上传
   *
   * 为什么需要兑底：用户传入的 HTML 里图片可能已是 mp.dayu.com 代理 URL
   * （其他账号发布的文章被复制过来、或者上次发布后改文案重用），
   * 会被 processImages 的 skipPatterns ['dayu.com', 'uc.cn'] 跳过，
   * uploadedImages 为空 → 之前的代码 if (this.uploadedImages.length > 0)
   * 不走裁剪流程 → coverImg 是空字符串 → 服务熢走 auto 模式，
   // 导致“草稿存了但封面不是手动选的”这类静默失败。
   *
   * 返回 null 时上层会跳过裁剪，让服务端走 auto 逻辑。
   */
  private async pickCoverSource(
    content: string,
    uploaded: UploadedImage[],
  ): Promise<(UploadedImage & { from: string }) | null> {
    if (uploaded.length > 0) {
      return { ...uploaded[0], from: 'uploaded' }
    }

    // 从 article.html 里提取第一张图 src（不限域名）
    const imgMatch = content.match(/<img[^>]+src="([^"]+)"/i)
    if (!imgMatch) {
      logger.warn('[Dayu] 封面裁剪跳过：article.html 中没有 <img>')
      return null
    }
    // HTML 属性值里的 & 会被编码为 &amp;（实测日志：
    // "https://mp.dayu.com/dayu/image?t=...&amp;s=...&amp;p=..."）
    // 不解码的话 fetch/imageUpload 会把 "amp;" 当参数名，服务端解析异常
    const src = imgMatch[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
    if (src.startsWith('data:')) {
      logger.warn('[Dayu] 封面裁剪跳过：data URI 不适合作为裁剪源')
      return null
    }

    // 主动上传这张图到图床（uploadImageByUrl 内部会 push 到 uploadedImages）
    const beforeCount = this.uploadedImages.length
    try {
      logger.info(`[Dayu] 封面裁剪：从 article.html 主动上传图源 ${src.slice(0, 80)}...`)
      await this.uploadImageByUrl(src)
    } catch (e) {
      logger.warn(`[Dayu] 封面裁剪：主动上传图源失败：`, (e as Error).message)
      return null
    }

    if (this.uploadedImages.length > beforeCount) {
      const last = this.uploadedImages[this.uploadedImages.length - 1]
      return { ...last, from: 'html-upload' }
    }
    return null
  }

  /**
   * 单比例裁剪（1 次 getCoverSelection + 1 次 imagecut）。
   * HAR 样本：
   *   - getCoverSelection 入参 {src, ratio, width, height}，出参 {data:{x,y,width,height}}
   *   - imagecut 入参 cutX/cutY/oriWidth/oriHeight/saveWidth/saveHeight/utoken/_rid/imgSrc
   *   - 实际样本：horizontal 返回 (0,0,1116.44,628) -> imagecut (0,0,1117,628,1117,629)
   *             vertical   返回 (0,0,471,628)    -> imagecut (0,0,472,629,472,630)
   *   - 服务器会上下取整，我们以 getCoverSelection 返参为准向上 ceil，
   *     saveHeight 比 oriHeight 多 1 以贴近 HAR 样本。
   */
  private async cropCoverOne(
    src: string,
    width: number,
    height: number,
    ratio: number,
    rid: string,
  ): Promise<{ url: string; oriUrl: string }> {
    if (!this.cacheMeta) throw new Error('未登录')

    // Step 1: getCoverSelection (POST JSON to mp.dayu.com)
    // 编辑器的 o.ajax 封装会在 header 里自动带 utoken，缺了会报
    // "getCoverSelection 响应异常：utoken error"（实测报错）。
    const selResp = await this.runtime.fetch(
      `https://mp.dayu.com/dashboard/article/getCoverSelection?_rid=${rid}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'utoken': this.cacheMeta.utoken,
          // HAR 验证：编辑器请求带了这两个头，缺 x-requested-with 时
          // 服务端反爬校验会拒绝（HTTP 500）
          'x-requested-with': 'XMLHttpRequest',
        },
        body: JSON.stringify({ src, ratio, width, height }),
      },
    )

    if (!selResp.ok) {
      throw new Error(`getCoverSelection HTTP ${selResp.status}`)
    }
    const selJson = (await selResp.json()) as {
      data?: { x: number; y: number; width: number; height: number }
      error?: unknown
      errmsg?: unknown
      message?: unknown
    }
    if (!selJson.data || typeof selJson.data.width !== 'number') {
      // 服务端业务错误对象的 error/errmsg 可能是嵌套对象（实测打出 [object Object]），
      // 必须统一 JSON 序列化才能看到真实错误内容
      const detail =
        (typeof selJson.errmsg === 'string' && selJson.errmsg) ||
        (typeof selJson.error === 'string' && selJson.error) ||
        (typeof selJson.message === 'string' && selJson.message) ||
        JSON.stringify(selJson).slice(0, 400)
      logger.error('[Dayu] getCoverSelection 被拒，完整响应：', JSON.stringify(selJson))
      throw new Error(`getCoverSelection 被拒：${detail}`)
    }
    const crop = selJson.data

    // Step 2: imagecut (POST form-urlencoded to ns.dayu.com)
    // 注意 oriWidth/oriHeight 是 getCoverSelection 返回的 width/height 向上取整
    const oriWidth = Math.ceil(crop.width)
    const oriHeight = Math.ceil(crop.height)
    const saveWidth = oriWidth
    const saveHeight = oriHeight + 1 // 贴合 HAR 样本（horizontal 628->629, vertical 629->630）

    const cutForm = new URLSearchParams()
    cutForm.append('_rid', rid)
    cutForm.append('imgSrc', src)
    cutForm.append('cutX', String(Math.round(crop.x)))
    cutForm.append('cutY', String(Math.round(crop.y)))
    cutForm.append('oriWidth', String(oriWidth))
    cutForm.append('oriHeight', String(oriHeight))
    cutForm.append('saveWidth', String(saveWidth))
    cutForm.append('saveHeight', String(saveHeight))
    cutForm.append('utoken', this.cacheMeta.utoken)

    const cutResp = await this.runtime.fetch(
      `https://ns.dayu.com/article/imagecut?appid=website&wmid=${this.cacheMeta.uid}&sign=${this.cacheMeta.imageCutSign}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: cutForm,
      },
    )

    if (!cutResp.ok) {
      throw new Error(`imagecut HTTP ${cutResp.status}`)
    }
    const cutJson = (await cutResp.json()) as {
      code?: number
      message?: string
      errmsg?: string
      data?: { status?: number; url?: string; oriUrl?: string }
    }
    if (cutJson.code !== 0 || !cutJson.data?.url) {
      throw new Error(
        `imagecut 失败 (ratio=${ratio}, code=${cutJson.code})：${cutJson.message || cutJson.errmsg || JSON.stringify(cutJson).slice(0, 200)}`,
      )
    }
    // imagecut 返回 http:// URL；HTTPS 编辑页里 http 图会触发 Mixed Content
    // （实测草稿详情页控制台告警；Chrome 自动升级 https，但部分环境/服务端巡检
    // 走 http 可能失败）。编辑器存储值会被服务端标准化为协议相对 //，
    // 说明服务端对协议敏感 —— 这里统一升级 https 减少变量
    // （image.uc.cn 支持 HTTPS，Mixed Content 升级后能正常显示已验证）。
    const httpsify = (u: string) => u.replace(/^http:\/\//i, 'https://')
    return {
      url: httpsify(cutJson.data.url),
      oriUrl: httpsify(cutJson.data.oriUrl || cutJson.data.url),
    }
  }

  /**
   * 生成大鱼号 _rid，与编辑器 HAR 抓包样本格式一致（32 位 16 进制字符串）：
   *   样本：5192cd9591034a029fde0464035cbcde
   * 服务端使用其作为一次会话关联 ID，同一会话的 getCoverSelection/imagecut 复用同一 _rid。
   */
  private generateRid(): string {
    let s = ''
    while (s.length < 32) {
      s += Math.floor(Math.random() * 0x100000000)
        .toString(16)
        .padStart(8, '0')
    }
    return s.slice(0, 32)
  }

  /**
   * 通过 URL 上传图片
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.cacheMeta) {
      throw new Error('未登录')
    }

    // 对 URL 路径中的非 ASCII 字符进行百分号编码
    const encodedSrc = this.encodeUrlPath(src)

    // 1. 下载图片
    const imageResponse = await fetch(encodedSrc)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    // 2. 构建上传 URL
    const uploadUrl = `https://ns.dayu.com/article/imageUpload?appid=website&fromMaterial=0&wmid=${this.cacheMeta.uid}&wmname=${encodeURIComponent(this.cacheMeta.title)}&sign=${this.cacheMeta.uploadSign}`

    // 3. 上传图片
    const formData = new FormData()
    const fileName = `${Date.now()}.jpg`
    formData.append('upfile', imageBlob, fileName)
    formData.append('type', imageBlob.type || 'image/jpeg')
    formData.append('id', 'WU_FILE_1')
    formData.append('fileid', `uploadm-${Math.floor(Math.random() * 1000000)}`)
    formData.append('name', fileName)
    formData.append('lastModifiedDate', new Date().toString())
    formData.append('size', String(imageBlob.size))

    const uploadResponse = await this.runtime.fetch(uploadUrl, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    })

    const res = await uploadResponse.json() as {
      data?: {
        imgInfo?: {
          org_url: string
          url: string
          /** 大鱼号图床会返回原图宽高（部分版本），部分老账号则无 */
          width?: number
          height?: number
          /**
           * imageUpload 服务带过来几种可能的 MD5 字段名：
           *   md5 / img_md5 / file_md5 / hash / fileMd5
           * 任一存在即可。（实测多数版本会用 'imgMd5' 或 'fileMd5'）
           */
          md5?: string
          imgMd5?: string
          fileMd5?: string
          hash?: string
        }
      }
    }

    logger.debug('Image upload response:', res)

    if (!res.data?.imgInfo?.url) {
      throw new Error('图片上传失败')
    }

    const imgInfo = res.data.imgInfo

    // 优先使用 imageUpload 响应里的 width/height；缺失则用 imageBlob 直接解码拿尺寸。
    // blob 已在手上，createImageBitmap(blob) 无需网络请求、无 CORS 风险，
    // 必定能拿到（拿不到说明不是合法图片，上传本身也会失败）。
    // 千万不能把 width/height = 0 传给 getCoverSelection，
    // 服务端拿 0 尺寸算裁剪框会直接 HTTP 500。
    let width = imgInfo.width ?? 0
    let height = imgInfo.height ?? 0
    if (!width || !height) {
      try {
        const bitmap = await createImageBitmap(imageBlob)
        width = bitmap.width
        height = bitmap.height
        bitmap.close()
      } catch {
        // 老兖底：二次 fetch 探测（需要 CDN CORS 头）
        const probed = await this.fetchImageDimensions(imgInfo.url)
        if (probed.width && probed.height) {
          width = probed.width
          height = probed.height
        }
      }
    }
    if (!width || !height) {
      logger.warn(
        `[Dayu] 图片尺寸探测失败（${src.slice(0, 80)}...），封面裁剪将不可用`,
      )
    }

    // MD5：优先取 imageUpload 服务端返回的，缺失则本地计算
    // （Web Crypto 不支持 MD5，本地计算走 fetchImageDimensions 后的同一 blob）
    let md5 = imgInfo.md5 ?? imgInfo.imgMd5 ?? imgInfo.fileMd5 ?? imgInfo.hash
    if (!md5) {
      md5 = await this.computeMd5OfBlob(imageBlob)
    }

    const image: UploadedImage = {
      org_url: imgInfo.org_url,
      url: imgInfo.url,
      width: width || undefined,
      height: height || undefined,
      md5,
    }

    // 把 org_url/url 实际形式打进日志：裁剪接口需要 mp.dayu.com 代理 URL，
    // 如果服务端返回的字段不是这个形式（code 50000 的排查关键证据）
    logger.info(
      `[Dayu] imgInfo: org_url=${imgInfo.org_url?.slice(0, 130)} url=${imgInfo.url?.slice(0, 130)} md5=${md5?.slice(0, 16)} size=${imageBlob.size}`,
    )

    // 保存上传的图片信息（用于封面裁剪）
    this.uploadedImages.push(image)

    // 把宽高写到 attrs 里，供 processImages 覆盖到正文 <img data-width data-height>
    // 这样 body 里也能拿到原始尺寸，方便后续需要重缩略图时使用
    const attrs: Record<string, string | number> = {}
    if (image.width) attrs['data-width'] = image.width
    if (image.height) attrs['data-height'] = image.height

    return {
      url: image.url,
      attrs: Object.keys(attrs).length > 0 ? attrs : undefined,
    }
  }

  /**
   * 通过 createImageBitmap 探测图片尺寸。
   * - 跨域图会被 CORS 拦截，需要图床服务器发送 Access-Control-Allow-Origin 头
   * - 拿不到时返回 {0, 0}，由调用方走降级路径
   */
  private async fetchImageDimensions(url: string): Promise<{ width: number; height: number }> {
    try {
      const resp = await fetch(url)
      if (!resp.ok) return { width: 0, height: 0 }
      const blob = await resp.blob()
      const bitmap = await createImageBitmap(blob)
      const result = { width: bitmap.width, height: bitmap.height }
      bitmap.close()
      return result
    } catch (e) {
      logger.debug(`fetchImageDimensions(${url.slice(0, 80)}...) 失败:`, e)
      return { width: 0, height: 0 }
    }
  }

  /**
   * 计算 Blob 的 MD5（hex）。
   *
   * Web Crypto SubtleCrypto 不支持 MD5（只支持 SHA 系列），所以这里用纯 JS 实现
   * 一个内存安全、可在 MV3 Service Worker 里跑的 MD5。文件图片通常几百 KB~几 MB，
   * 逐字节完全可接受。
   *
   * 算法来源：经典 MD5 参考实现，基于 RFC 1321。返回 32 位 hex 字符串。
   * 异常时返回空串（让上层原样不填 origin_cover_img）。
   */
  private async computeMd5OfBlob(blob: Blob): Promise<string> {
    try {
      const buffer = await blob.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      return this.md5Hex(bytes)
    } catch (e) {
      logger.debug('computeMd5OfBlob 失败:', e)
      return ''
    }
  }

  private md5Hex(bytes: Uint8Array): string {
    // MD5 constants
    const K = [
      0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
      0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
      0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
      0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
      0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
      0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
      0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
      0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
      0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
      0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
      0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
    ]
    const S = [
      7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ]

    let a0 = 0x67452301
    let b0 = 0xefcdab89
    let c0 = 0x98badcfe
    let d0 = 0x10325476

    const origLen = bytes.length
    // 补位：先补 1 个 0x80，再补 0 直到 (length % 64) == 56，最后 8 字节写长度（little-endian 位数）
    const padLen = (((origLen + 8) >> 6) + 1) << 6  // align to 64
    const padded = new Uint8Array(padLen)
    padded.set(bytes)
    padded[origLen] = 0x80
    // 64-bit length in bits, little-endian
    const bitLen = BigInt(origLen) * 8n
    const view = new DataView(padded.buffer)
    // 高位放在 [56..63]，低位放在 [48..55]
    view.setUint32(padLen - 8, Number(bitLen & 0xffffffffn), true)
    view.setUint32(padLen - 4, Number((bitLen >> 32n) & 0xffffffffn), true)

    const M = new Uint32Array(padded.buffer)

    for (let chunk = 0; chunk < M.length; chunk += 16) {
      let A = a0, B = b0, C = c0, D = d0
      for (let i = 0; i < 64; i++) {
        let F: number
        const g = i
        if (i < 16) {
          F = (B & C) | (~B & D)
        } else if (i < 32) {
          F = (D & B) | (~D & C)
        } else if (i < 48) {
          F = B ^ C ^ D
        } else {
          F = C ^ (B | ~D)
        }
        F = (F + A + K[i] + M[chunk + g]) | 0
        A = D
        D = C
        C = B
        B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0
      }
      a0 = (a0 + A) | 0
      b0 = (b0 + B) | 0
      c0 = (c0 + C) | 0
      d0 = (d0 + D) | 0
    }

    const toHex = (n: number) => {
      const s = (n >>> 0).toString(16)
      return s.length === 8 ? s : '0'.repeat(8 - s.length) + s
    }
    return toHex(a0) + toHex(b0) + toHex(c0) + toHex(d0)
  }
}