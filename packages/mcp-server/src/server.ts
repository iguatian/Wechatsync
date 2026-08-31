/**
 * MCP Server - HTTP/SSE 模式
 *
 * Claude Code 通过 HTTP 连接: http://localhost:9528/sse
 * Chrome Extension 通过 WebSocket 连接: ws://localhost:9527
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import express, { type Request, type Response } from 'express'
import { ExtensionBridge } from './ws-bridge.js'
import { resolveLocalImages } from './local-images.js'
import type { PlatformInfo, SyncResult } from './types.js'

export class SyncAssistantMcpServer {
  private server: Server
  private bridge: ExtensionBridge
  private app: express.Application
  private httpPort: number
  private transport: SSEServerTransport | null = null

  constructor(wsPort: number = 9527, httpPort: number = 9528) {
    this.httpPort = httpPort
    this.bridge = new ExtensionBridge(wsPort)
    this.app = express()

    this.server = new Server(
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

    this.setupHandlers()
    this.setupHttpRoutes()
  }

  /**
   * 设置 HTTP 路由
   */
  private setupHttpRoutes(): void {
    // SSE 端点 - Claude Code 连接这里
    this.app.get('/sse', async (req: Request, res: Response) => {
      console.error('[MCP] New SSE connection from Claude Code')

      this.transport = new SSEServerTransport('/message', res)

      res.on('close', () => {
        console.error('[MCP] SSE connection closed')
        this.transport = null
      })

      await this.server.connect(this.transport)
    })

    // 消息端点 - 接收 Claude Code 的请求
    this.app.post('/message', express.json(), async (req: Request, res: Response) => {
      if (this.transport) {
        await this.transport.handlePostMessage(req, res)
      } else {
        res.status(400).json({ error: 'No active SSE connection' })
      }
    })

    // 健康检查
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        extensionConnected: this.bridge.isConnected(),
      })
    })

    // 状态信息
    this.app.get('/', (_req: Request, res: Response) => {
      res.json({
        name: 'Sync Assistant MCP Server',
        version: '1.0.0',
        endpoints: {
          sse: '/sse',
          health: '/health',
        },
        extensionConnected: this.bridge.isConnected(),
      })
    })
  }

  /**
   * 设置 MCP handlers
   */
  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
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
            description: '同步文章到指定平台（保存为草稿）',
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
                  description: '文章标题',
                },
                content: {
                  type: 'string',
                  description: '文章内容（HTML 格式）',
                },
                markdown: {
                  type: 'string',
                  description: '文章内容（Markdown 格式，可选）',
                },
                cover: {
                  type: 'string',
                  description: '封面图 URL（可选）',
                },
                basePath: {
                  type: 'string',
                  description:
                    '文章所在目录的绝对路径（可选，强烈建议传入）。'
                    + '传入后，content/markdown 里的本地相对路径图片（如 ./cover-long.jpg）'
                    + '会被读取并转为 data URI 内嵌。'
                    + '不传则本地路径图片无法被扩展上传（Service Worker 无法 fetch 相对路径），'
                    + '会导致正文图片丢失且封面裁剪跳过。',
                },
              },
              required: ['platforms', 'title', 'content'],
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
        ],
      }
    })

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params

      try {
        // 检查 Extension 是否连接
        if (!this.bridge.isConnected()) {
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
            result = await this.bridge.request<PlatformInfo[]>('listPlatforms', {
              forceRefresh: (args as { forceRefresh?: boolean })?.forceRefresh,
            })
            break

          case 'check_auth':
            result = await this.bridge.request<PlatformInfo>('checkAuth', {
              platform: (args as { platform: string }).platform,
            })
            break

          case 'sync_article': {
            const syncArgs = args as {
              platforms: string[]
              title: string
              content: string
              markdown?: string
              cover?: string
              basePath?: string
            }

            let content = syncArgs.content
            let markdown = syncArgs.markdown

            // 本地相对路径图片必须在这里读取转 data URI：
            // 扩展端 Service Worker fetch('./cover-long.jpg') 会 TypeError: Failed to fetch，
            // 导致正文图片丢失 + uploadedImages 为空 + 封面裁剪流程不跑。
            // 不传 basePath 时行为与旧版完全一致（原样透传）。
            if (syncArgs.basePath) {
              const htmlResult = await resolveLocalImages(content, syncArgs.basePath)
              content = htmlResult.content
              if (markdown) {
                const mdResult = await resolveLocalImages(markdown, syncArgs.basePath)
                markdown = mdResult.content
              }
              if (htmlResult.converted > 0) {
                console.error(
                  `[MCP] 已将 ${htmlResult.converted} 张本地相对路径图片转为 data URI（basePath=${syncArgs.basePath}）`,
                )
              }
              if (htmlResult.failed.length > 0) {
                console.error(
                  `[MCP] 警告：以下本地图片读取失败（保持原路径，扩展端将无法上传）：${htmlResult.failed.join(', ')}`,
                )
              }
            }

            result = await this.bridge.request<SyncResult[]>('syncArticle', {
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
            result = await this.bridge.request('extractArticle')
            break

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
  }

  /**
   * 启动服务器
   */
  async start(): Promise<void> {
    // 启动 WebSocket 服务器（Chrome Extension 连接）
    await this.bridge.start()

    // 启动 HTTP 服务器（Claude Code 连接）
    this.app.listen(this.httpPort, () => {
      console.error(`[MCP] Sync Assistant MCP Server started`)
      console.error(`[MCP] HTTP Server: http://localhost:${this.httpPort}`)
      console.error(`[MCP] Claude Code: http://localhost:${this.httpPort}/sse`)
      console.error(`[MCP] Extension WS: ws://localhost:9527`)
    })
  }
}
