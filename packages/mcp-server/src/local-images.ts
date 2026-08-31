/**
 * 本地相对路径图片 → data URI 解析器
 *
 * 被 mcp-server 的两个入口（stdio `index.ts` 和 SSE `server.ts`）共用。
 *
 * 为什么需要这个模块：
 *   扩展端发布链路跑在 Chrome MV3 Service Worker 里，`fetch('./cover-long.jpg')`
 *   解析不出有效绝对 URL 直接 `TypeError: Failed to fetch`，`file://` 协议
 *   也会被浏览器拦截。data URI 是唯一能被 SW fetch 并转给平台图床的形式。
 *
 * 因此 MCP server 必须在收到 markdown/content 时就把本地相对路径图片读取为
 * base64 data URI 再转发给扩展，避免扩展 SW 重复踩同样的坑。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

/** 本地图片后缀 → MIME 类型 */
const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
}

/** 判定是否为需要读取的本地图片路径（相对/绝对本地路径） */
function isLocalImagePath(p: string): boolean {
  const trimmed = p.trim()
  if (/^(https?|data|file|blob|chrome|moz|about):/i.test(trimmed)) return false
  if (/^\/{2}/.test(trimmed)) return false // protocol-relative url //host/img
  return /\.(jpe?g|png|gif|webp|svg|bmp)$/i.test(trimmed)
}

export interface ResolveLocalImagesResult {
  /** 替换后的内容（本地路径被替换为 data URI） */
  content: string
  /** 成功转 data URI 的图片数 */
  converted: number
  /** 读取失败的本地图片路径列表 */
  failed: string[]
}

/**
 * 把 content 中引用的本地相对路径图片读取为 data URI 并替换引用。
 *
 * 覆盖两种引用形式：
 *   - HTML:  <img src="./cover-long.jpg">
 *   - Markdown: ![alt](./cover-long.jpg)
 *
 * @param content 原始 markdown 或 html 字符串
 * @param basePath 文章所在目录的绝对路径（用于解析相对路径）。绝对路径直接使用。
 * @returns 替换后的内容 + 转换/失败计数
 */
export async function resolveLocalImages(
  content: string,
  basePath: string,
): Promise<ResolveLocalImagesResult> {
  const cache = new Map<string, string | null>()
  const failed: string[] = []

  const toDataUri = async (raw: string): Promise<string | null> => {
    if (!isLocalImagePath(raw)) return null
    if (cache.has(raw)) return cache.get(raw) ?? null
    // HTML 属性值里的 & 可能被编码为 &amp;
    const decoded = raw.trim().replace(/&amp;/g, '&')
    try {
      const abs = path.isAbsolute(decoded) ? decoded : path.resolve(basePath, decoded)
      const buf = await readFile(abs)
      const ext = path.extname(abs).toLowerCase()
      const mime = MIME_TYPES[ext] || 'application/octet-stream'
      const dataUri = `data:${mime};base64,${buf.toString('base64')}`
      cache.set(raw, dataUri)
      return dataUri
    } catch {
      cache.set(raw, null)
      failed.push(decoded)
      return null
    }
  }

  let result = content
  let converted = 0

  // HTML <img src="...">
  const htmlRe = /<img\b[^>]*?\bsrc=["']([^"']+)["']/gi
  const htmlHits: Array<{ full: string; src: string }> = []
  let m: RegExpExecArray | null
  while ((m = htmlRe.exec(content)) !== null) {
    htmlHits.push({ full: m[0], src: m[1] })
  }
  for (const { full, src } of htmlHits) {
    const dataUri = await toDataUri(src)
    if (dataUri) {
      result = result.replace(full, full.replace(src, dataUri))
      converted++
    }
  }

  // Markdown ![alt](path)
  const mdRe = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  const mdHits: Array<{ full: string; src: string }> = []
  while ((m = mdRe.exec(content)) !== null) {
    mdHits.push({ full: m[0], src: m[2] })
  }
  for (const { full, src } of mdHits) {
    const dataUri = await toDataUri(src)
    if (dataUri) {
      result = result.replace(full, full.replace(src, dataUri))
      converted++
    }
  }

  return { content: result, converted, failed }
}