/**
 * 文章内容
 *
 * 内容格式说明：
 * - markdown: 主要内容格式，由 content script 使用 Turndown + 原生 DOM 转换
 * - html: 可选的原始 HTML，某些平台可能需要
 */
export interface Article {
  title: string
  markdown: string    // Markdown 格式内容（主要）
  html?: string       // 原始 HTML（可选，用于某些需要 HTML 的平台）
  summary?: string
  /** 通用单封面图 URL/路径：大多数平台使用。懂车帝等双封面平台会忽略本字段。 */
  cover?: string
  /**
   * 竖版封面 URL/路径（仅部分双封面平台需要，如懂车帝）。
   * 与 `coverHorizontal` 配套使用；缺失时适配器会明确报错，不会静默回退到 `cover`。
   */
  coverVertical?: string
  /**
   * 横版封面 URL/路径（仅部分双封面平台需要，如懂车帝）。
   * 与 `coverVertical` 配套使用；缺失时适配器会明确报错，不会静默回退到 `cover`。
   */
  coverHorizontal?: string
  tags?: string[]
  category?: string
  source?: {
    url: string
    platform: string
  }
}

/**
 * 同步结果
 */
export interface SyncResult {
  platform: string
  success: boolean
  postId?: string
  postUrl?: string
  draftOnly?: boolean  // 是否只保存了草稿
  error?: string
  message?: string  // 额外提示信息
  timestamp: number
  // ---- 封面图诊断字段（用于通过 MCP 全链路透传到上层发布方）----
  coverUploaded?: boolean   // 封面图是否上传成功（true=已拿到上传后 URL）
  coverUrl?: string         // 封面图上传后的最终 URL（失败时为 undefined）
  coverError?: string       // 封面图上传失败的具体原因
}

/**
 * 认证状态
 */
export interface AuthResult {
  isAuthenticated: boolean
  username?: string
  userId?: string
  avatar?: string
  error?: string
}

/**
 * 平台能力
 */
export type PlatformCapability =
  | 'article'      // 发布文章
  | 'draft'        // 草稿支持
  | 'image_upload' // 图片上传
  | 'categories'   // 分类
  | 'tags'         // 标签
  | 'cover'        // 封面图
  | 'schedule'     // 定时发布

/**
 * 平台元信息
 */
export interface PlatformMeta {
  id: string
  name: string
  icon: string
  homepage: string
  capabilities: PlatformCapability[]
}

/**
 * Cookie
 */
export interface Cookie {
  name: string
  value: string
  domain: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  expirationDate?: number
}

/**
 * Header 规则
 */
export interface HeaderRule {
  id?: string
  urlFilter: string
  headers: Record<string, string>
  resourceTypes?: string[]
}

/**
 * 请求选项
 */
export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: BodyInit | Record<string, unknown>
  timeout?: number
}
