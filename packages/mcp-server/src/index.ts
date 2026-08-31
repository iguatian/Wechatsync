/**
 * Sync Assistant MCP Server
 *
 * 支持两种模式：
 * 1. stdio 模式（推荐）: claude mcp add sync-assistant node dist/index.js
 * 2. SSE 模式: 先启动服务，再 claude mcp add --transport sse sync-assistant http://localhost:9528/sse
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import express, { type Request, type Response } from 'express'
import fs from 'fs'
import path from 'path'
import { ExtensionBridge } from './ws-bridge.js'
import { resolveLocalImages } from './local-images.js'
import type { PlatformInfo, SyncResult } from './types.js'

// 端口配置：
// - 旧配置 SYNC_WS_PORT=9527：单端口模式（兼容原版）
// - 新配置 SYNC_PORT_START / SYNC_PORT_END：多端口模式（一个进程监听多个端口对）
// - 默认：多端口模式 9527~9560
const WS_PORT = parseInt(process.env.SYNC_WS_PORT || '9527', 10)
const HTTP_PORT = parseInt(process.env.SYNC_HTTP_PORT || '9528', 10)
const WS_PORT_START = parseInt(process.env.SYNC_PORT_START || process.env.SYNC_WS_PORT || '9527', 10)
const WS_PORT_END = process.env.SYNC_PORT_END
  ? parseInt(process.env.SYNC_PORT_END, 10)
  : (process.env.SYNC_WS_PORT ? WS_PORT : 9560) // 设置了 SYNC_WS_PORT 则单端口，否则默认到 9560

// SSE 模式实际使用的端口：
// - 多端口模式：取端口范围之后的下一个端口（WS_PORT_END + 2），
//   避免与 ExtensionBridge 监听的任一端口对（WS + HTTP）冲突
// - 单端口模式（SYNC_WS_PORT）：沿用原配置 HTTP_PORT
// - 可用 SYNC_SSE_HTTP_PORT 环境变量显式指定（默认 9528）
const SSE_WS_PORT = process.env.SYNC_PORT_START ? WS_PORT_START : WS_PORT
const SSE_HTTP_PORT = process.env.SYNC_SSE_HTTP_PORT
  ? parseInt(process.env.SYNC_SSE_HTTP_PORT, 10)
  : (process.env.SYNC_PORT_START ? WS_PORT_END + 2 : HTTP_PORT)

// 检查是否是 SSE 模式
const isSSEMode = process.argv.includes('--sse')

// Extension WebSocket 桥接（多端口模式下监听所有奇数端口）
const bridge = new ExtensionBridge(WS_PORT_START, WS_PORT_END)

/**
 * 创建 MCP Server
 */
function createServer(): Server {
  const server = new Server(
    {
      name: 'sync-assistant',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  )

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'list_platforms',
          description: '列出所有支持的平台及其登录状态',
          inputSchema: {
            type: 'object',
            properties: {
              forceRefresh: {
                type: 'boolean',
                description: '是否强制刷新登录状态（默认使用缓存）',
              },
            },
          },
        },
        {
          name: 'check_auth',
          description: '检查指定平台的登录状态',
          inputSchema: {
            type: 'object',
            properties: {
              platform: {
                type: 'string',
                description: '平台 ID，如 zhihu, juejin, toutiao 等',
              },
            },
            required: ['platform'],
          },
        },
        {
          name: 'sync_article',
          description: '同步文章到指定平台（保存为草稿）。支持 Markdown 或 HTML 格式，优先使用 markdown 字段。重要：如果文章包含本地图片引用，必须先读取图片文件并转换为 base64 data URI 格式（如 ![img](data:image/png;base64,xxx)）。',
          inputSchema: {
            type: 'object',
            properties: {
              platforms: {
                type: 'array',
                items: { type: 'string' },
                description: '目标平台 ID 列表，如 ["zhihu", "juejin"]',
              },
              title: {
                type: 'string',
                description: '文章标题（纯文本，不含 # 号）',
              },
              markdown: {
                type: 'string',
                description: '文章正文内容（Markdown 格式，推荐）。注意：1) 不要包含标题行（# xxx），只传正文部分；2) 本地图片必须转换为 base64 data URI 格式，如 ![图片](data:image/png;base64,iVBORw0KGgo...)',
              },
              content: {
                type: 'string',
                description: '文章正文内容（HTML 格式，可选）。如果提供了 markdown 则此字段可忽略。',
              },
              cover: {
                type: 'string',
                description: '封面图 URL 或 base64 data URI（可选）',
              },
              basePath: {
                type: 'string',
                description: '文章所在目录的绝对路径（可选，强烈建议传入）。传入后，content/markdown 里的本地相对路径图片（如 ./cover-long.jpg）会被读取并转为 data URI 内嵌。不传则本地路径图片无法被扩展上传（Service Worker 无法 fetch 相对路径），会导致正文图片丢失。',
              },
            },
            required: ['platforms', 'title', 'markdown'],
          },
        },
        {
          name: 'extract_article',
          description: '从当前浏览器页面提取文章内容',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'upload_image_file',
          description: '从本地文件路径上传图片到图床平台，返回可公开访问的 URL。推荐使用此方法，无需手动转换 base64。',
          inputSchema: {
            type: 'object',
            properties: {
              filePath: {
                type: 'string',
                description: '本地图片文件的绝对路径，如 /Users/xxx/image.png',
              },
              platform: {
                type: 'string',
                description: '上传到哪个平台作为图床，默认 weibo。可选: weibo, zhihu, juejin, jianshu, woshipm',
              },
            },
            required: ['filePath'],
          },
        },
      ],
    }
  })

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    try {
      // 检查 Extension 是否连接
      if (!bridge.isConnected()) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Chrome Extension 未连接。请确保：\n1. 已安装同步助手扩展\n2. 扩展已启用 MCP 连接（点击设置图标开启）',
              }),
            },
          ],
          isError: true,
        }
      }

      let result: unknown

      switch (name) {
        case 'list_platforms':
          result = await bridge.request<PlatformInfo[]>('listPlatforms', {
            forceRefresh: (args as { forceRefresh?: boolean })?.forceRefresh,
          })
          break

        case 'check_auth':
          result = await bridge.request<PlatformInfo>('checkAuth', {
            platform: (args as { platform: string }).platform,
          })
          break

        case 'sync_article': {
          const syncArgs = args as {
            platforms: string[]
            title: string
            markdown: string
            content?: string
            cover?: string
            basePath?: string
          }

          let content = syncArgs.content
          let markdown = syncArgs.markdown

          // 本地相对路径图片必须在这里读取转 data URI：
          // 扩展端 Service Worker fetch('./cover-long.jpg') 会 TypeError: Failed to fetch，
          // 导致正文图片丢失 + 上传失败。和 SSE 入口 `server.ts` 走同一份共享实现
          // （见 ./local-images.ts），避免两处逻辑发散。
          if (syncArgs.basePath) {
            if (content) {
              const htmlResult = await resolveLocalImages(content, syncArgs.basePath)
              content = htmlResult.content
              if (htmlResult.converted > 0) {
                console.error(
                  `[MCP] 已将 ${htmlResult.converted} 张本地相对路径图片转为 data URI（content, basePath=${syncArgs.basePath}）`,
                )
              }
              if (htmlResult.failed.length > 0) {
                console.error(
                  `[MCP] 警告：以下本地图片读取失败（保持原路径，扩展端将无法上传）：${htmlResult.failed.join(', ')}`,
                )
              }
            }
            if (markdown) {
              const mdResult = await resolveLocalImages(markdown, syncArgs.basePath)
              markdown = mdResult.content
              if (mdResult.converted > 0) {
                console.error(
                  `[MCP] 已将 ${mdResult.converted} 张本地相对路径图片转为 data URI（markdown, basePath=${syncArgs.basePath}）`,
                )
              }
              if (mdResult.failed.length > 0) {
                console.error(
                  `[MCP] 警告：以下本地图片读取失败（保持原路径，扩展端将无法上传）：${mdResult.failed.join(', ')}`,
                )
              }
            }
          } else {
            // 没传 basePath 时检查一下本地相对路径，给出明确告警，
            // 避免用户默默地看到 “草稿创建成功但图片没传”
            const localImgHits = (markdown || '').match(/!\[([^\]]*)\]\(([^)]+\.(?:jpe?g|png|gif|webp|svg|bmp))/i)
            const localHtmlHits = (content || '').match(/<img\b[^>]*?\bsrc=["']\.{0,2}\/[^"']+["']/i)
            if (localImgHits || localHtmlHits) {
              console.error(
                '[MCP] 警告：sync_article 未传 basePath，但 content/markdown 含本地相对路径图片。' +
                '扩展端 Service Worker 无法 fetch 本地路径，图片将不会上传到平台图床。' +
                '请在调用时传入 basePath（文章所在目录的绝对路径）。',
              )
            }
          }

          result = await bridge.request<SyncResult[]>('syncArticle', {
            platforms: syncArgs.platforms,
            article: {
              title: syncArgs.title,
              content,
              markdown,
              cover: syncArgs.cover,
            },
          })
          break
        }

        case 'extract_article':
          result = await bridge.request('extractArticle')
          break

        case 'upload_image_file': {
          // 从文件路径读取图片并上传
          const filePath = (args as { filePath: string }).filePath
          const platform = (args as { platform?: string }).platform || 'weibo'

          // 检查文件是否存在
          if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`)
          }

          // 读取文件并转为 base64
          const fileBuffer = fs.readFileSync(filePath)
          const imageData = fileBuffer.toString('base64')

          // 根据扩展名确定 MIME 类型
          const ext = path.extname(filePath).toLowerCase()
          const mimeTypes: Record<string, string> = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.svg': 'image/svg+xml',
          }
          const mimeType = mimeTypes[ext] || 'image/png'

          // 使用分片上传
          result = await bridge.uploadImageChunked(imageData, mimeType, platform)
          break
        }

        default:
          return {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
          }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: (error as Error).message }),
          },
        ],
        isError: true,
      }
    }
  })

  return server
}

/**
 * stdio 模式启动
 */
async function startStdioMode() {
  // 启动 WebSocket 服务器（Extension 连接）
  await bridge.start()

  const server = createServer()
  const transport = new StdioServerTransport()

  await server.connect(transport)

  // 日志输出到 stderr（不影响 stdio 通信）
  console.error('[MCP] Sync Assistant started (stdio mode)')
  console.error(`[MCP] Extension WebSocket: ws://localhost:${WS_PORT}`)
}

/**
 * SSE 模式启动
 */
async function startSSEMode() {
  // 启动 WebSocket 服务器（Extension 连接）
  await bridge.start()

  const server = createServer()
  const app = express()
  let transport: SSEServerTransport | null = null

  // SSE 端点
  app.get('/sse', async (req: Request, res: Response) => {
    console.error('[MCP] New SSE connection from Claude Code')
    transport = new SSEServerTransport('/message', res)

    res.on('close', () => {
      console.error('[MCP] SSE connection closed')
      transport = null
    })

    await server.connect(transport)
  })

  // 消息端点
  app.post('/message', express.json(), async (req: Request, res: Response) => {
    if (transport) {
      await transport.handlePostMessage(req, res)
    } else {
      res.status(400).json({ error: 'No active SSE connection' })
    }
  })

  // 健康检查
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      extensionConnected: bridge.isConnected(),
    })
  })

  app.get('/', (_req: Request, res: Response) => {
    res.json({
      name: 'Sync Assistant MCP Server',
      version: '1.0.0',
      extensionConnected: bridge.isConnected(),
    })
  })

  app.listen(SSE_HTTP_PORT, () => {
    console.error('[MCP] Sync Assistant started (SSE mode)')
    console.error(`[MCP] HTTP Server: http://localhost:${SSE_HTTP_PORT}`)
    console.error(`[MCP] Claude Code: http://localhost:${SSE_HTTP_PORT}/sse`)
    console.error(`[MCP] Extension WebSocket: ws://localhost:${SSE_WS_PORT}`)
  })
}

// 启动
if (isSSEMode) {
  startSSEMode().catch((error) => {
    console.error('[MCP] Failed to start:', error)
    process.exit(1)
  })
} else {
  startStdioMode().catch((error) => {
    console.error('[MCP] Failed to start:', error)
    process.exit(1)
  })
}

// 处理退出信号
process.on('SIGINT', () => {
  console.error('[MCP] Shutting down...')
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.error('[MCP] Shutting down...')
  process.exit(0)
})
