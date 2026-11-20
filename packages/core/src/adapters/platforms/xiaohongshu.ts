/**
 * 小红书创作者平台适配器
 *
 * 平台资料：
 * - 创作者后台：https://creator.xiaohongshu.com/
 * - 长文编辑器：https://creator.xiaohongshu.com/publish/publish?from=menu&target=article
 *
 * 实现思路（基于浏览器抓包 + IndexedDB 扒包确认）：
 *
 * 鉴权：完全依赖浏览器 cookie 登录态，关键 cookie：a1 / webId / web_session / gid
 *
 * ⚠️ 草稿机制核心差异（与其他平台最大的不同）：
 * 小红书创作者平台的"保存草稿"按钮 = Dexie.js 写浏览器本地 IndexedDB，
 *   数据库：draft-database-v1 (version 10)
 *   对象库：article-draft（按 draftId 主键，uid 索引）
 * 不会发送任何 HTTP 请求。"草稿同步到云端"必须走"发布"动作才发生。
 * 因此本适配器采用"模拟用户操作写 IndexedDB"的方案。
 *
 * uid 获取：
 *   直接 GET /api/galaxy/user/info（无需 x-s/x-sign 签名头，仅需 cookie）。
 *   该接口返回 { data: { userId, userName, redId, ... } }。
 *   避免从 IndexedDB 推断（首次使用的浏览器 IndexedDB 为空）。
 *
 * 图片处理（彻底绕开 permit 流程）：
 *   permit / encryption 接口均要求 x-s/x-sign/x-t/f 签名头，裸 fetch 必 406。
 *   页面 fetch 包装（library-launcher.05fc1ff0.js）生成的签名算法在 bundler 闭包内，
 *   无法从扩展侧复用。
 *   新策略：图片以二进制 Blob 形式直接写入 IndexedDB 的 articleStore.blob2Map，
 *   image 节点的 url 字段填占位符（fileId），编辑器打开时会自动从 blob2Map
 *   加载并触发页面上传逻辑。配合 uploadImage() 返回 base64 data URI 的策略，
 *   CLI 不会触发 permit 调用，publish() 在 tab 上下文 fetch data URI 拿 blob。
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Xiaohongshu')

/** 创作者后台 origin（编辑器主页） */
const CREATOR_ORIGIN = 'https://creator.xiaohongshu.com'

/** 长文编辑器 URL（"写长文" tab 对应的入口） */
const EDITOR_URL = `${CREATOR_ORIGIN}/publish/publish?from=menu&target=article`

/** 鉴权用 cookie 列表（任一非空即视为已登录） */
const AUTH_COOKIE_NAMES = ['a1', 'webId', 'web_session', 'gid']

/**
 * richJson 节点（ProseMirror doc 树）
 */
interface RichJsonNode {
  type: 'doc' | 'paragraph' | 'text' | 'image' | string
  text?: string
  content?: RichJsonNode[]
  attrs?: Record<string, unknown>
  marks?: unknown[]
}

/**
 * 草稿 articleStore 类型（subagent 扒包确认：字段实际为数字/对象，不是字符串/null）
 */
interface DraftArticleStore {
  articleTitle: string
  articleContent: string
  richJson: RichJsonNode
  summeryContent: string
  /** 实测：字符串 '' */
  orderPattern: string
  /** 实测：数字 0 */
  articleEditorMode: number
  authorAndSummaryTemp: { author: string; summary: string; readingStats: string }
  /** 实测：数字 6（长文主题 ID） */
  selectedThemeId: number
  selectedColorIndexMap: Record<string, number>
  /** key: fileId 或 url, value: Blob */
  blob2Map: Record<string, Blob>
  coverSetting: {
    styleType: number
    showAuthor: boolean
    showReadingStats: boolean
    showSummery: boolean
  }
  editPageSource: string
  schemaCopy: Record<string, unknown>
  url2FileIdMap: Record<string, string>
  wordCount: number
}

/**
 * 草稿 draftStore 类型
 */
interface DraftDraftStore {
  title: string
  desc: string
  descInnerHTML: string
  descLength: number
  imgList: Array<{ fileId: string; previewUrl: string }>
  ats: unknown[]
  hashTag: unknown[]
  video: {
    width: number
    height: number
    fileid: string
    fsize: number
    duration: number
    videoId: string
    videoMarks: unknown[]
    timelines: unknown[]
    frame: { ts: number; isUserSelect: boolean; isUpload: boolean }
    transcodeVideoFileId: string
    coverInfo: unknown
  }
  audioInfo: unknown
  videoMeta: unknown
  audioMeta: unknown
  cover: {
    width: number
    height: number
    fileid: string
    frame: { ts: number; isUserSelect: boolean; isUpload: boolean }
    stickers: { neptune: string; version: number }
    fonts: unknown[]
    selectionSource: string
  }
  chapters: unknown[]
  markers: unknown[]
  videoMarksExtends: unknown[]
  needTranscode: number
  videoRotation: number
  themeId: string
  colorGroup: string
  audioFileId: string
  audioId: string
  audioDuration: number
  audioFileName: string
  needAudioTranscode: number
  pkCoverList: unknown[]
  smartChapterState: {
    status: number
    progress: number
    generatedChapters: unknown[]
    generatedSummary: string
    failReason: string
    videoId: string
    isAiApplied: boolean
    isRegenerate: boolean
  }
  summary: string
}

/**
 * 草稿 publishStore 类型（实测 uploadState/publishType/imageNoteOrigin 都是数字）
 */
interface DraftPublishStore {
  /** 实测：数字 0（不是字符串 'draft'） */
  publishType: number
  /** 实测：数字 0（不是字符串 'LongText'） */
  imageNoteOrigin: number
  systemId: 'web' | 'h5'
  step: number
  /** 实测：数字 2（长文编辑器） */
  uploadState: number
  /** 8 = 草稿（已暂存） */
  status: number
  codec: string
  pkCoverEnabled: boolean
  pkCoverAutoFill: boolean
  pkCoverFillAttempted: boolean
  pkCoverManuallyEdited: boolean
}

/**
 * 草稿 settingStore 默认值（扒包确认）
 */
const DEFAULT_SETTING_STORE = {
  postLoc: { province: '', city: '', district: '', poi: '' },
  postTime: { type: 0, ts: 0 },
  privacyInfo: { type: 0 },
  collectionId: '',
  orderId: '',
  brandAccountId: '',
  userDeclaration: '',
  groupBind: null,
  liveNoticeBind: null,
  liveReservationBind: null,
  noteSketch: null,
  original: false,
  originalDateStamp: '',
  coProduceBind: null,
  noteCopyBind: null,
  coOrderId: '',
  interactionPermissionBind: null,
  fileRelate: null,
  coCreators: [],
  thumbBind: null,
  videoAdBind: null,
  skillBind: null,
  quoteNote: null,
  quotePodcast: null,
  appBind: null,
  activityAssociationInfo: null,
}

/**
 * 草稿 contextStore 默认值（扒包确认）
 */
const DEFAULT_CONTEXT_STORE = {
  liveContext: null,
  previewAuditContext: null,
  coverContext: {
    coverUrl: '',
    cover: {
      fileid: '',
      fonts: [],
      frame: { ts: 0, isUserSelect: false, isUpload: false },
      height: 0,
      stickers: { neptune: '', version: 0 },
      width: 0,
      selectionSource: 'default',
    },
    templateBlob: null,
    rate: 0,
    recommendCoverIdx: 0,
  },
  goodsContext: null,
  bizRelationContext: null,
  recommendCovers: [],
  skillContext: null,
  appContext: null,
}

interface DraftRecordContent {
  articleStore: DraftArticleStore
  draftStore: DraftDraftStore
  publishStore: DraftPublishStore
  settingStore: typeof DEFAULT_SETTING_STORE
  contextStore: typeof DEFAULT_CONTEXT_STORE
  shortDraftStore: {
    isShort: boolean
    editStatus: number
    textCardList: unknown[]
    coverList: unknown[]
    currentCoverIdx: number
    cacheData: Record<string, unknown>
  }
}

interface DraftRecord {
  draftId: string
  uid: string
  timeStamp: number
  content: DraftRecordContent
}

export class XiaohongshuAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'xiaohongshu',
    name: '小红书',
    icon: 'https://www.xiaohongshu.com/favicon.ico',
    homepage: CREATOR_ORIGIN,
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  /** 预处理：小红书长文编辑器是 ProseMirror，需要从 Markdown 构造 doc 树 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  /** uid 缓存（避免每次都 fetch user/info） */
  private cachedUid: string | null = null

  // ============ checkAuth ============

  async checkAuth(): Promise<AuthResult> {
    try {
      const cookies = await this.runtime.cookies.get('.xiaohongshu.com')
      const hasAuth = AUTH_COOKIE_NAMES.some(
        (name) => !!cookies.find((c) => c.name === name && c.value)?.value,
      )
      if (!hasAuth) {
        return {
          isAuthenticated: false,
          error: '请先登录小红书创作者平台（https://creator.xiaohongshu.com/）',
        }
      }
      // 尝试从 IndexedDB 推断 uid（仅用于缓存，不强依赖）
      // ⚠️ 这里绝不能主动创建 tab：checkAuth 会在扩展启动/弹窗时被批量调用，
      //    否则每次加载扩展都会自动打开小红书创作页。
      try {
        const uid = await this.peekUidFromIndexedDB()
        if (uid) this.cachedUid = uid
      } catch {
        // 忽略
      }
      return {
        isAuthenticated: true,
        username: '小红书创作者',
        userId: this.cachedUid || undefined,
      }
    } catch (error) {
      return {
        isAuthenticated: false,
        error: (error as Error).message,
      }
    }
  }

  // ============ publish ============

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      logger.info('Starting publish to Xiaohongshu (write to local IndexedDB)...')

      // 0. 鉴权
      const auth = await this.checkAuth()
      if (!auth.isAuthenticated) {
        throw new Error(auth.error || '未登录小红书创作者平台')
      }

      // 1. 确保创作者平台 tab 已打开
      const tabId = await this.ensureCreatorTab()

      // 2. 在 tab 上下文获取 uid（/api/galaxy/user/info 无签名要求）
      const uid = await this.fetchUidFromUserInfo(tabId)
      if (!uid) {
        throw new Error('无法获取小红书 uid（/api/galaxy/user/info 返回异常）')
      }
      this.cachedUid = uid

      // 3. 标题
      const title = (article.title || '').trim().slice(0, 64)
      if (!title) throw new Error('小红书标题必填')

      // 4. 处理正文图片：在 tab 内把 data URI / 网络 URL 转换为 Blob 写入 blob2Map
      const markdown = article.markdown || ''
      const imageSrcs = extractMarkdownImages(markdown)
      const imageInfoMap = new Map<string, { fileId: string; blob: Blob }>()
      if (imageSrcs.length > 0) {
        logger.debug(`Processing ${imageSrcs.length} images into blob2Map...`)
        for (let i = 0; i < imageSrcs.length; i++) {
          const src = imageSrcs[i]
          try {
            const info = await this.fetchImageAsBlob(tabId, src)
            imageInfoMap.set(src, info)
            logger.debug(`Image ${i + 1}/${imageSrcs.length} ready: ${info.fileId}`)
          } catch (e) {
            logger.warn(`Image fetch failed: ${src}`, e)
          }
          options?.onImageProgress?.(i + 1, imageSrcs.length)
        }
      }

      // 5. Markdown → richJson 树
      const richJson = markdownToRichJson(markdown, imageInfoMap, title)

      // 6. 组装 DraftRecord（修正字段类型：uploadState=2, publishType=0, 等）
      const desc = stripMarkdown(markdown).slice(0, 1000)
      const wordCount = countWords(markdown)
      const draftId = generateUUID()
      const timeStamp = Date.now()

      const record: DraftRecord = {
        draftId,
        uid,
        timeStamp,
        content: {
          articleStore: {
            articleTitle: title,
            articleContent: desc,
            richJson,
            summeryContent: '',
            orderPattern: '',
            articleEditorMode: 0,
            authorAndSummaryTemp: { author: '', summary: '', readingStats: '' },
            selectedThemeId: 6,
            selectedColorIndexMap: {},
            blob2Map: Object.fromEntries(
              Array.from(imageInfoMap.entries()).map(([, info]) => [info.fileId, info.blob]),
            ),
            coverSetting: { styleType: 0, showAuthor: true, showReadingStats: true, showSummery: true },
            editPageSource: 'import',
            schemaCopy: {},
            url2FileIdMap: Object.fromEntries(
              Array.from(imageInfoMap.entries()).map(([src, info]) => [src, info.fileId]),
            ),
            wordCount,
          },
          draftStore: {
            title,
            desc,
            descInnerHTML: markdownToInnerHTML(markdown),
            descLength: desc.length,
            imgList: Array.from(imageInfoMap.values()).map((info) => ({
              fileId: info.fileId,
              previewUrl: info.fileId, // 草稿态下用 fileId 占位，编辑器打开后会替换
            })),
            ats: [],
            hashTag: [],
            video: {
              width: 0, height: 0, fileid: '', fsize: 0, duration: 0, videoId: '',
              videoMarks: [], timelines: [],
              frame: { ts: 0, isUserSelect: false, isUpload: false },
              transcodeVideoFileId: '', coverInfo: null,
            },
            audioInfo: null,
            videoMeta: null,
            audioMeta: null,
            cover: {
              width: 0, height: 0, fileid: '',
              frame: { ts: 0, isUserSelect: false, isUpload: false },
              stickers: { neptune: '', version: 0 },
              fonts: [],
              selectionSource: 'default',
            },
            chapters: [],
            markers: [],
            videoMarksExtends: [],
            needTranscode: 0,
            videoRotation: 0,
            themeId: '',
            colorGroup: '',
            audioFileId: '',
            audioId: '',
            audioDuration: 0,
            audioFileName: '',
            needAudioTranscode: 0,
            pkCoverList: [],
            smartChapterState: {
              status: 0, progress: 0, generatedChapters: [], generatedSummary: '',
              failReason: '', videoId: '', isAiApplied: false, isRegenerate: false,
            },
            summary: article.summary || '',
          },
          publishStore: {
            publishType: 0,
            imageNoteOrigin: 0,
            systemId: 'web',
            step: 0,
            uploadState: 2, // 长文编辑器
            status: 8, // 草稿
            codec: 'unknown',
            pkCoverEnabled: false,
            pkCoverAutoFill: false,
            pkCoverFillAttempted: false,
            pkCoverManuallyEdited: false,
          },
          settingStore: { ...DEFAULT_SETTING_STORE },
          contextStore: { ...DEFAULT_CONTEXT_STORE },
          shortDraftStore: {
            isShort: false,
            editStatus: 0,
            textCardList: [],
            coverList: [],
            currentCoverIdx: 0,
            cacheData: {},
          },
        },
      }

      // 7. 在 tab 内写入 IndexedDB
      await this.writeDraftInTab(tabId, record)

      const draftUrl = `${CREATOR_ORIGIN}/publish/publish?from=menu&target=article&draftId=${draftId}`
      logger.info(`Draft saved to IndexedDB: ${draftId}`)

      return this.createResult(true, {
        postId: draftId,
        postUrl: draftUrl,
        draftOnly: true,
        message: '已写入小红书创作者平台本地草稿（IndexedDB），请在草稿箱中找到该草稿继续编辑或发布',
      })
    } catch (error) {
      logger.error('Publish failed:', error)
      return this.createResult(false, {
        error: (error as Error).message,
      })
    }
  }

  // ============ 图片上传（CLI / processImages 链路） ============

  /**
   * CLI 图床链路调用入口。把 blob 直接转 base64 data URI 返回，
   * 不触发 permit 接口（permit 需要 x-s/x-sign/x-t/f 签名头，fetch 直接调用必 406）。
   * 后续 publish() 会从 markdown 中提取 data URI 并写入 IndexedDB.blob2Map。
   */
  async uploadImage(file: Blob, _filename?: string): Promise<string> {
    return this.blobToDataUri(file)
  }

  /**
   * 兜底实现（CodeAdapter 默认）：转 data URI
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    return { url: src }
  }

  // ============ Tab 操作 ============

  /**
   * 查找已存在的创作者平台 tab（无任何副作用，不会新建 tab）
   */
  private async findCreatorTab(): Promise<number | null> {
    if (!this.runtime.tabs) return null
    try {
      const tabs = await this.runtime.tabs.query('https://creator.xiaohongshu.com/*')
      const first = tabs[0]
      return first && first.id !== undefined ? first.id : null
    } catch {
      return null
    }
  }

  /**
   * 确保创作者平台 tab 已打开并加载完成
   *
   * ⚠️ 会创建新 tab，仅用于发布流程；鉴权检查请使用 findCreatorTab()。
   */
  private async ensureCreatorTab(): Promise<number> {
    if (!this.runtime.tabs) {
      throw new Error('小红书发布需要浏览器 tabs API 支持（仅扩展环境可用）')
    }
    const existing = await this.findCreatorTab()
    if (existing !== null) {
      return existing
    }
    logger.info('No existing creator tab, creating new one...')
    const tab = await this.runtime.tabs.create(EDITOR_URL, false)
    await this.runtime.tabs.waitForLoad(tab.id, 30000)
    logger.info('Creator tab ready:', tab.id)
    return tab.id
  }

  /**
   * 在创作者 tab 内执行脚本
   */
  private async runInTab<T, A extends unknown[]>(
    tabId: number,
    func: (...args: A) => T | Promise<T>,
    args: A,
  ): Promise<T> {
    if (!this.runtime.tabs) {
      throw new Error('需要浏览器 tabs API 支持')
    }
    return this.runtime.tabs.executeScript(tabId, func, args)
  }

  // ============ uid 获取 ============

  /**
   * 在 tab 上下文调用 /api/galaxy/user/info 获取 uid
   * 该接口无签名要求，仅需 cookie 即可 200
   */
  private async fetchUidFromUserInfo(tabId: number): Promise<string | null> {
    return this.runInTab<{ uid: string | null; error?: string }, []>(
      tabId,
      async () => {
        try {
          const r = await fetch(
            'https://creator.xiaohongshu.com/api/galaxy/user/info',
            { credentials: 'include' },
          )
          if (!r.ok) {
            return { uid: null, error: 'user/info HTTP ' + r.status }
          }
          const j = (await r.json()) as {
            success?: boolean
            data?: { userId?: string; userName?: string; redId?: string }
          }
          if (j.success && j.data?.userId) {
            return { uid: j.data.userId }
          }
          return { uid: null, error: 'user/info missing userId' }
        } catch (e) {
          return { uid: null, error: 'exception: ' + (e as Error).message }
        }
      },
      [],
    ).then((r) => {
      if (!r?.uid) logger.warn('fetchUidFromUserInfo:', r?.error)
      return r?.uid || null
    })
  }

  // ============ IndexedDB 操作 ============

  /**
   * 从 IndexedDB 任意一条草稿推断当前 uid（兜底，不强依赖）
   *
   * ⚠️ 仅在已存在创作者 tab 时读取，绝不新建 tab（供 checkAuth 调用）。
   */
  private async peekUidFromIndexedDB(): Promise<string | null> {
    if (!this.runtime.tabs) return null
    try {
      const tabId = await this.findCreatorTab()
      if (tabId === null) return null
      return this.runInTab<{ uid: string } | null, []>(
        tabId,
        () => {
          return new Promise((resolve) => {
            let req: IDBOpenDBRequest
            try {
              req = indexedDB.open('draft-database-v1')
            } catch {
              resolve(null)
              return
            }
            req.onsuccess = () => {
              const db = req.result
              if (!db.objectStoreNames.contains('article-draft')) {
                db.close()
                resolve(null)
                return
              }
              try {
                const tx = db.transaction('article-draft', 'readonly')
                const cur = tx.objectStore('article-draft').openCursor()
                cur.onsuccess = (e) => {
                  const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result
                  if (cursor) {
                    const v = cursor.value as { uid?: string }
                    db.close()
                    resolve(v.uid ? { uid: v.uid } : null)
                  } else {
                    db.close()
                    resolve(null)
                  }
                }
                cur.onerror = () => {
                  db.close()
                  resolve(null)
                }
              } catch {
                db.close()
                resolve(null)
              }
            }
            req.onerror = () => resolve(null)
          })
        },
        [],
      ).then((r) => r?.uid || null)
    } catch {
      return null
    }
  }

  /**
   * 在 tab 内写入一条草稿到 IndexedDB
   */
  private async writeDraftInTab(tabId: number, record: DraftRecord): Promise<void> {
    const ok = await this.runInTab<{ ok: boolean; error?: string }, [DraftRecord]>(
      tabId,
      async (rec) => {
        return new Promise((resolve) => {
          const req = indexedDB.open('draft-database-v1')
          req.onerror = () => resolve({ ok: false, error: 'open-failed: ' + req.error?.message })
          req.onsuccess = () => {
            const db = req.result
            if (!db.objectStoreNames.contains('article-draft')) {
              db.close()
              resolve({ ok: false, error: 'store-missing' })
              return
            }
            try {
              const tx = db.transaction('article-draft', 'readwrite')
              const store = tx.objectStore('article-draft')
              const putReq = store.put(rec)
              putReq.onsuccess = () => {
                db.close()
                resolve({ ok: true })
              }
              putReq.onerror = () => {
                db.close()
                resolve({ ok: false, error: 'put-failed: ' + putReq.error?.message })
              }
              tx.onerror = () => {
                db.close()
                resolve({ ok: false, error: 'tx-failed: ' + tx.error?.message })
              }
              tx.onabort = () => {
                db.close()
                resolve({ ok: false, error: 'tx-aborted: ' + tx.error?.message })
              }
            } catch (e) {
              db.close()
              resolve({ ok: false, error: 'exception: ' + (e as Error).message })
            }
          }
          req.onblocked = () => resolve({ ok: false, error: 'indexeddb-blocked' })
        })
      },
      [record],
    )
    if (!ok?.ok) {
      throw new Error('IndexedDB 写入失败：' + (ok?.error || 'unknown'))
    }
  }

  // ============ 图片转 Blob ============

  /**
   * 在 tab 上下文把图片（data URI 或网络 URL）转 Blob
   * 返回 { fileId, blob }
   * - fileId 用 src hash 前 16 位（编辑器打开时会从 blob2Map 用 fileId 找 blob）
   */
  private async fetchImageAsBlob(
    tabId: number,
    src: string,
  ): Promise<{ fileId: string; blob: Blob }> {
    const result = await this.runInTab<
      { ok: true; fileId: string; blob: Blob } | { ok: false; error: string },
      [string]
    >(
      tabId,
      async (s) => {
        try {
          // 在 tab 上下文 fetch，data URI 和同源 URL 都直接拿 blob
          const r = await fetch(s)
          if (!r.ok) {
            return { ok: false, error: 'fetch HTTP ' + r.status }
          }
          const blob = await r.blob()
          // 生成 fileId（hash 前 16 位）
          const buf = new TextEncoder().encode(s + ':' + blob.size)
          const hashBuf = await crypto.subtle.digest('SHA-1', buf)
          const hashArr = Array.from(new Uint8Array(hashBuf))
          const fileId = hashArr
            .slice(0, 16)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
          return { ok: true, fileId, blob }
        } catch (e) {
          return { ok: false, error: 'exception: ' + (e as Error).message }
        }
      },
      [src],
    )
    if (!result.ok) {
      throw new Error(result.error)
    }
    return { fileId: result.fileId, blob: result.blob }
  }
}

// ============ 辅助函数 ============

/**
 * 生成 UUID v4
 */
function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * 从 Markdown 中提取所有图片 URL
 */
function extractMarkdownImages(markdown: string): string[] {
  const urls: string[] = []
  const regex = /!\[[^\]]*\]\(([^)]+)\)/g
  let match
  while ((match = regex.exec(markdown)) !== null) {
    const url = match[1].trim()
    if (url && !urls.includes(url)) urls.push(url)
  }
  return urls
}

/**
 * Markdown → ProseMirror doc 树
 */
function markdownToRichJson(
  markdown: string,
  imageMap: Map<string, { fileId: string; blob: Blob }>,
  title?: string,
): RichJsonNode {
  const blocks = splitIntoBlocks(markdown)
  const content: RichJsonNode[] = []
  for (const block of blocks) {
    // 正文里与文章标题重复的 H1 不再写入编辑器
    if (title && /^#{1,6}\s+/.test(block) && cleanInlineMarkdown(block) === title.trim()) {
      continue
    }
    const para = blockToParagraph(block, imageMap)
    if (para) content.push(para)
  }
  // 空文档会让 ProseMirror 渲染空白，兜底放一个占位段落
  if (content.length === 0) {
    content.push({ type: 'paragraph', content: [{ type: 'text', text: ' ', marks: [] }] })
  }
  return { type: 'doc', content }
}

/**
 * 把 Markdown 按空行拆分为"块"
 */
function splitIntoBlocks(markdown: string): string[] {
  // ProseMirror 的 text 节点不允许换行，必须逐行生成段落
  return markdown
    .split(/\r?\n+/)
    .map((b) => b.trim())
    .filter(Boolean)
}

/**
 * 清理行内 Markdown 标记，保证 text 节点是纯文本且不含换行
 */
function cleanInlineMarkdown(text: string): string {
  return text
    .replace(/\r?\n/g, ' ')
    .replace(/\\/g, '')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^>\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .trim()
}

/**
 * 单个 Markdown 行 → paragraph 节点（含 text + image 子节点）
 */
function blockToParagraph(
  block: string,
  imageMap: Map<string, { fileId: string; blob: Blob }>,
): RichJsonNode | null {
  const children: RichJsonNode[] = []
  const parts = block.split(/(!\[[^\]]*\]\([^)]+\))/g)
  for (const part of parts) {
    if (!part) continue
    if (part.startsWith('![')) {
      const urlMatch = part.match(/!\[[^\]]*\]\(([^)]+)\)/)
      const url = urlMatch?.[1]?.trim() || ''
      const uploaded = imageMap.get(url)
      const fileId = uploaded?.fileId || ''
      children.push({
        type: 'image',
        attrs: {
          fileId,
          localId: fileId,
          blobUrl: fileId,
          previewUrl: url.startsWith('data:') ? fileId : url, // data URI 也用 fileId 让编辑器从 blob2Map 加载
          url: url.startsWith('data:') ? fileId : url,
          source: 'outside',
          timestamp: Date.now(),
          width: 0,
          height: 0,
        },
      })
    } else {
      const text = cleanInlineMarkdown(part)
      if (text) children.push({ type: 'text', text, marks: [] })
    }
  }
  if (children.length === 0) return null
  return { type: 'paragraph', content: children }
}

/**
 * Markdown → descInnerHTML
 */
function markdownToInnerHTML(markdown: string): string {
  const blocks = splitIntoBlocks(markdown)
  return blocks
    .map((b) => {
      const text = b
        .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
        .replace(/[#*_`>]/g, '')
        .trim()
      return text ? `<p>${escapeHtml(text)}</p>` : ''
    })
    .filter(Boolean)
    .join('')
}

/**
 * 移除 markdown 标记，保留纯文本
 */
function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/[`*_~#>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n+/g, ' ')
    .trim()
}

/**
 * 字数统计
 */
function countWords(text: string): number {
  const stripped = stripMarkdown(text)
  const chinese = (stripped.match(/[\u4e00-\u9fff]/g) || []).length
  const english = stripped
    .replace(/[\u4e00-\u9fff]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
  return chinese + english
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
