/**
 * WebSocket Bridge - 与 Chrome Extension 通讯
 *
 * 支持多端口模式（一个进程监听多个端口对）：
 * - 每个 WebSocket 端口 +1 = 对应 HTTP API 端口
 * - HTTP 请求到达哪个 HTTP 端口，就路由到对应的扩展连接
 * - 例如：扩展连 ws://host:9527，Python 调 http://host:9528/request
 * - 多个扩展各自连接不同的奇数端口（9527/9529/9531...），互不干扰
 */
import { WebSocketServer, WebSocket } from 'ws'
import http from 'http'
import type { RequestMessage, ResponseMessage } from './types.js'

// WebSocket 状态常量 (readyState: 1 = OPEN)
const WS_OPEN = WebSocket.OPEN

export class ExtensionBridge {
  private wsServers: Map<number, WebSocketServer> = new Map()
  private httpServers: Map<number, http.Server> = new Map()
  private clients: Map<number, any> = new Map()
  private clientIps: Map<number, string> = new Map()
  private isServerMode = false
  private pendingRequests = new Map<string, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timeout: NodeJS.Timeout
  }>()
  private requestTimeout = 360000 // 6 minutes (图片多时需要更长时间)
  private connectionResolvers = new Map<number, Array<() => void>>()
  private portEnd: number

  // 安全验证 token（从环境变量读取，优先使用 WECHATSYNC_TOKEN）
  private token: string = process.env.WECHATSYNC_TOKEN || process.env.MCP_TOKEN || ''

  // 是否静默模式（CLI 使用时不输出日志）
  private silent: boolean = false

  /**
   * @param portStart 起始 WebSocket 端口（自动调整为奇数）
   * @param portEnd   结束 WebSocket 端口（可省略，省略则为单端口模式）
   * @param options   可选参数
   */
  constructor(private portStart: number = 9527, portEnd?: number, options?: { silent?: boolean }) {
    // 兼容旧调用：new ExtensionBridge(9527, { silent: true })
    if (typeof portEnd === 'object' && portEnd !== null) {
      options = portEnd as { silent?: boolean }
      portEnd = undefined
    }
    this.silent = options?.silent ?? false

    this.portEnd = (portEnd === undefined || portEnd < portStart) ? portStart : portEnd

    // 确保从奇数端口开始（HTTP = WS + 1，偶数 WS 会与其它实例的 HTTP 冲突）
    if (this.portStart % 2 === 0) {
      this.portStart += 1
    }
    this.portEnd = (this.portEnd % 2 === 0) ? this.portEnd - 1 : this.portEnd

    if (!this.silent) {
      if (this.token) {
        console.error('[Bridge] Token authentication enabled')
      } else {
        console.error('[Bridge] Warning: MCP_TOKEN not set, requests may be rejected by extension')
      }
    }
  }

  /**
   * 获取要监听的 WebSocket 端口列表（奇数端口）
   */
  getWsPorts(): number[] {
    const ports: number[] = []
    for (let p = this.portStart; p <= this.portEnd; p += 2) {
      ports.push(p)
    }
    return ports
  }

  /**
   * 启动服务 - 单端口走主/从切换逻辑，多端口全部监听
   */
  async start(): Promise<void> {
    const wsPorts = this.getWsPorts()

    if (wsPorts.length <= 1) {
      // 单端口模式：保留原有主/从切换逻辑
      try {
        await this.listenPort(this.portStart)
        this.isServerMode = true
        if (!this.silent) console.error(`[Bridge] Running as PRIMARY (WebSocket: ${this.portStart}, HTTP: ${this.portStart + 1})`)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          this.isServerMode = false
          if (!this.silent) console.error(`[Bridge] Running as SECONDARY (forwarding to localhost:${this.portStart + 1})`)
        } else {
          throw error
        }
      }
      return
    }

    // 多端口模式：遍历监听所有奇数端口
    for (const wsPort of wsPorts) {
      try {
        await this.listenPort(wsPort)
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EADDRINUSE') {
          this.closePort(wsPort)
          if (!this.silent) console.error(`[Bridge] Port ${wsPort} in use, skipping`)
        } else {
          throw error
        }
      }
    }

    if (this.httpServers.size > 0) {
      this.isServerMode = true
      if (!this.silent) {
        console.error(`[Bridge] Running as PRIMARY with ${this.httpServers.size} port pairs (${this.getWsPorts().join(', ')})`)
      }
    } else {
      this.isServerMode = false
      if (!this.silent) console.error(`[Bridge] All ports in use, running as SECONDARY`)
    }
  }

  /**
   * 监听单个端口对（WebSocket 端口 + HTTP 端口）
   */
  private listenPort(wsPort: number): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const wss = new WebSocketServer({ port: wsPort })
        this.wsServers.set(wsPort, wss)

        wss.on('listening', () => {
          if (!this.silent) console.error(`[Bridge] WebSocket server listening on port ${wsPort}`)
          this.startHttpApi(wsPort).then(resolve).catch(reject)
        })

        wss.on('connection', (ws: any) => {
          this.onConnection(wsPort, ws)
        })

        wss.on('error', (error: Error) => {
          reject(error)
        })
      } catch (error) {
        reject(error)
      }
    })
  }

  /**
   * 处理扩展连接（记录 IP，按端口维护 client）
   */
  private onConnection(wsPort: number, ws: any): void {
    const ip = (ws._socket && ws._socket.remoteAddress) || 'unknown'
    this.clients.set(wsPort, ws)
    this.clientIps.set(wsPort, ip)
    if (!this.silent) console.error(`[Bridge] Extension connected on port ${wsPort} (IP: ${ip})`)

    // 通知等待连接的 Promise（按端口分组）
    const resolvers = this.connectionResolvers.get(wsPort) || []
    for (const resolver of resolvers) {
      resolver()
    }
    this.connectionResolvers.delete(wsPort)

    ws.on('message', (data: any) => {
      this.handleMessage(data.toString())
    })

    ws.on('close', () => {
      if (!this.silent) console.error(`[Bridge] Extension disconnected from port ${wsPort}`)
      this.clients.delete(wsPort)
      this.clientIps.delete(wsPort)
    })

    ws.on('error', (error: Error) => {
      if (!this.silent) console.error(`[Bridge] WebSocket error on port ${wsPort}:`, error)
    })
  }

  /**
   * 启动该端口对的 HTTP API 服务器（HTTP 端口 = WS 端口 + 1）
   * 请求到达哪个 HTTP 端口，就路由到对应的扩展连接
   */
  private startHttpApi(wsPortToTrack: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const httpPort = wsPortToTrack + 1

      const server = http.createServer(async (req, res) => {
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

        if (req.method === 'OPTIONS') {
          res.writeHead(200)
          res.end()
          return
        }

        if (req.method === 'GET' && req.url === '/status') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            connected: this.isConnected(wsPortToTrack),
            mode: 'primary',
            wsPort: wsPortToTrack,
            httpPort,
            clientIp: this.clientIps.get(wsPortToTrack) || null,
          }))
          return
        }

        if (req.method === 'POST' && req.url === '/request') {
          let body = ''
          req.on('data', chunk => body += chunk)
          req.on('end', async () => {
            try {
              const { method, params } = JSON.parse(body)
              const result = await this.requestInternal(wsPortToTrack, method, params)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ result }))
            } catch (error) {
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: (error as Error).message }))
            }
          })
          return
        }

        res.writeHead(404)
        res.end('Not found')
      })

      this.httpServers.set(httpPort, server)
      server.on('error', reject)
      server.listen(httpPort, () => {
        if (!this.silent) console.error(`[Bridge] HTTP API listening on port ${httpPort}`)
        resolve()
      })
    })
  }

  /**
   * 关闭指定端口对
   */
  closePort(wsPort: number): void {
    const wss = this.wsServers.get(wsPort)
    if (wss) {
      wss.close()
      this.wsServers.delete(wsPort)
    }
    const httpServer = this.httpServers.get(wsPort + 1)
    if (httpServer) {
      httpServer.close()
      this.httpServers.delete(wsPort + 1)
    }
    this.clients.delete(wsPort)
    this.clientIps.delete(wsPort)
  }

  /**
   * 停止所有服务器
   */
  stop(): void {
    for (const wsPort of [...this.wsServers.keys()]) {
      this.closePort(wsPort)
    }
    this.wsServers.clear()
    this.httpServers.clear()
    this.pendingRequests.clear()
    this.connectionResolvers.clear()
  }

  /**
   * 获取当前运行模式
   */
  getMode(): 'primary' | 'secondary' {
    return this.isServerMode ? 'primary' : 'secondary'
  }

  /**
   * 检查 Extension 是否已连接（指定端口或任一端口）
   */
  isConnected(wsPort?: number): boolean {
    if (!this.isServerMode) return false
    if (wsPort !== undefined) {
      const client = this.clients.get(wsPort)
      return !!client && client.readyState === WS_OPEN
    }
    for (const client of this.clients.values()) {
      if (client && client.readyState === WS_OPEN) return true
    }
    return false
  }

  /**
   * 获取第一个有扩展连接的端口
   */
  getActiveWsPort(): number | null {
    for (const [port, client] of this.clients) {
      if (client && client.readyState === WS_OPEN) return port
    }
    return null
  }

  /**
   * 获取所有有扩展连接的端口
   */
  getActiveWsPorts(): number[] {
    const ports: number[] = []
    for (const [port, client] of this.clients) {
      if (client && client.readyState === WS_OPEN) ports.push(port)
    }
    return ports.sort((a, b) => a - b)
  }

  /**
   * 获取指定端口扩展的 IP
   */
  getClientIp(wsPort: number): string | null {
    return this.clientIps.get(wsPort) || null
  }

  /**
   * 等待 Extension 连接（可指定端口，默认任一）
   */
  waitForConnection(timeoutMs: number = 60000, wsPort?: number): Promise<void> {
    if (this.isServerMode) {
      // PRIMARY 模式：等待扩展 WebSocket 连接
      const targetPort = wsPort ?? this.portStart
      if (this.isConnected(targetPort)) {
        return Promise.resolve()
      }

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          const resolvers = this.connectionResolvers.get(targetPort) || []
          const index = resolvers.indexOf(resolve)
          if (index > -1) {
            resolvers.splice(index, 1)
            this.connectionResolvers.set(targetPort, resolvers)
          }
          reject(new Error('timeout'))
        }, timeoutMs)

        const resolvers = this.connectionResolvers.get(targetPort) || []
        resolvers.push(() => {
          clearTimeout(timeout)
          resolve()
        })
        this.connectionResolvers.set(targetPort, resolvers)
      })
    } else {
      // SECONDARY 模式：轮询 PRIMARY 健康状态，PRIMARY 消失则尝试接管
      return new Promise((resolve, reject) => {
        const startTime = Date.now()
        const pollInterval = 2000
        let primaryReachable = false
        let promoting = false

        const poll = async () => {
          if (Date.now() - startTime > timeoutMs) {
            if (!primaryReachable) {
              reject(new Error('timeout:unreachable'))
            } else {
              reject(new Error('timeout:no_extension'))
            }
            return
          }

          const health = await this.checkPrimaryHealth()
          if (health.connected) {
            resolve()
            return
          }

          if (health.error?.includes('not reachable') && !promoting) {
            // PRIMARY 不可达 — 尝试接管端口
            promoting = true
            const promoted = await this.tryPromote()
            if (promoted) {
              // 成功接管，等待 Extension 直连
              const remaining = timeoutMs - (Date.now() - startTime)
              if (remaining <= 0) {
                reject(new Error('timeout:no_extension'))
                return
              }

              if (this.isConnected(this.portStart)) {
                resolve()
                return
              }

              const promoteTimeout = setTimeout(() => {
                const resolvers = this.connectionResolvers.get(this.portStart) || []
                const index = resolvers.indexOf(resolve)
                if (index > -1) {
                  resolvers.splice(index, 1)
                  this.connectionResolvers.set(this.portStart, resolvers)
                }
                reject(new Error('timeout:no_extension'))
              }, remaining)

              const resolvers = this.connectionResolvers.get(this.portStart) || []
              resolvers.push(() => {
                clearTimeout(promoteTimeout)
                resolve()
              })
              this.connectionResolvers.set(this.portStart, resolvers)
              return
            }
            // 接管失败，继续轮询
            promoting = false
          } else if (!health.error?.includes('not reachable')) {
            primaryReachable = true
          }

          setTimeout(poll, pollInterval)
        }

        poll()
      })
    }
  }

  /**
   * 检查 Primary 实例健康状态（Secondary 模式用）
   */
  private async checkPrimaryHealth(): Promise<{ connected: boolean; error?: string }> {
    return new Promise((resolve) => {
      const options = {
        hostname: 'localhost',
        port: this.portStart + 1,
        path: '/status',
        method: 'GET',
        timeout: 3000,
      }

      const req = http.request(options, (res) => {
        let body = ''
        res.on('data', chunk => body += chunk)
        res.on('end', () => {
          try {
            const status = JSON.parse(body)
            resolve({ connected: status.connected })
          } catch {
            resolve({ connected: false, error: 'Invalid response from primary' })
          }
        })
      })

      req.on('error', (error) => {
        resolve({ connected: false, error: `Primary not reachable: ${error.message}` })
      })

      req.on('timeout', () => {
        req.destroy()
        resolve({ connected: false, error: 'Primary health check timeout' })
      })

      req.end()
    })
  }

  /**
   * 发送请求到 Extension 并等待响应
   * @param wsPort 指定端口（可省略，省略时用第一个活跃端口）
   */
  async request<T = unknown>(method: string, params?: Record<string, unknown>, wsPort?: number): Promise<T> {
    if (this.isServerMode) {
      const port = wsPort ?? this.getActiveWsPort() ?? this.portStart
      return this.requestInternal<T>(port, method, params)
    } else {
      return this.requestViaSecondary<T>(method, params)
    }
  }

  /**
   * SECONDARY 模式请求（带重试 + 自动接管）
   */
  private async requestViaSecondary<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    maxRetries: number = 3
  ): Promise<T> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // 如果已经升级为 PRIMARY，直接走 internal
      if (this.isServerMode) {
        return this.requestInternal<T>(this.portStart, method, params)
      }

      // 重试前等待（首次不等）
      if (attempt > 0) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000)
        if (!this.silent) console.error(`[Bridge] SECONDARY retry ${attempt}/${maxRetries} in ${delay}ms...`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }

      // 检查 PRIMARY 健康状态
      const health = await this.checkPrimaryHealth()
      if (!health.connected) {
        if (health.error?.includes('not reachable')) {
          // PRIMARY 已退出，尝试接管
          if (!this.silent) console.error('[Bridge] PRIMARY gone during request, attempting takeover...')
          const promoted = await this.tryPromote()
          if (promoted) {
            // 等 Extension 重新连接（温热重连应该很快）
            if (!this.isConnected(this.portStart)) {
              if (!this.silent) console.error('[Bridge] Waiting for Extension to reconnect...')
              await this.waitForConnection(30000, this.portStart)
            }
            return this.requestInternal<T>(this.portStart, method, params)
          }
        }
        lastError = new Error(health.error || 'Primary instance not available.')
        continue
      }

      // 转发请求
      try {
        return await this.requestViaHttp<T>(method, params)
      } catch (error) {
        lastError = error as Error
      }
    }

    throw lastError!
  }

  /**
   * 尝试接管端口，升级为 PRIMARY
   */
  private async tryPromote(): Promise<boolean> {
    for (let i = 0; i < 5; i++) {
      try {
        await this.listenPort(this.portStart)
        this.isServerMode = true
        if (!this.silent) console.error(`[Bridge] Promoted to PRIMARY (WebSocket: ${this.portStart}, HTTP: ${this.portStart + 1})`)
        return true
      } catch {
        await new Promise(r => setTimeout(r, 1000))
      }
    }
    return false
  }

  /**
   * 直接通过 WebSocket 发送请求（服务器模式，指定端口）
   */
  private async requestInternal<T = unknown>(wsPort: number, method: string, params?: Record<string, unknown>): Promise<T> {
    const client = this.clients.get(wsPort)
    if (!client || client.readyState !== WS_OPEN) {
      throw new Error(`Extension not connected on port ${wsPort}. Please ensure the Chrome extension is running.`)
    }

    const id = this.generateId()
    const message: RequestMessage = {
      id,
      method,
      token: this.token,  // 发送 token 供插件端验证
      params
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Request timeout: ${method}`))
      }, this.requestTimeout)

      this.pendingRequests.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout })

      client.send(JSON.stringify(message))
    })
  }

  /**
   * 通过 HTTP API 转发请求（客户端模式）
   */
  private requestViaHttp<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({ method, params })
      const options = {
        hostname: 'localhost',
        port: this.portStart + 1,
        path: '/request',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      }

      const req = http.request(options, (res) => {
        let body = ''
        res.on('data', chunk => body += chunk)
        res.on('end', () => {
          try {
            const response = JSON.parse(body)
            if (response.error) {
              reject(new Error(response.error))
            } else {
              resolve(response.result)
            }
          } catch (error) {
            reject(new Error('Failed to parse response'))
          }
        })
      })

      req.on('error', (error) => {
        const hint = error.message.includes('ECONNREFUSED')
          ? ' (Is the primary MCP server running?)'
          : ''
        reject(new Error(`Failed to connect to primary MCP instance: ${error.message}${hint}`))
      })

      req.setTimeout(this.requestTimeout, () => {
        req.destroy()
        reject(new Error(`Request timeout: ${method}`))
      })

      req.write(data)
      req.end()
    })
  }

  /**
   * 处理来自 Extension 的消息
   */
  private handleMessage(data: string): void {
    try {
      const message: ResponseMessage = JSON.parse(data)

      const pending = this.pendingRequests.get(message.id)
      if (!pending) {
        console.error('[Bridge] Unknown response id:', message.id)
        return
      }

      clearTimeout(pending.timeout)
      this.pendingRequests.delete(message.id)

      if (message.error) {
        pending.reject(new Error(message.error.message))
      } else {
        pending.resolve(message.result)
      }
    } catch (error) {
      console.error('[Bridge] Failed to parse message:', error)
    }
  }

  /**
   * 生成唯一 ID
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
  }

  // 分片上传配置
  private readonly CHUNK_SIZE = 512 * 1024  // 512KB per chunk
  private readonly CHUNK_THRESHOLD = 1024 * 1024  // 1MB threshold for chunking

  /**
   * 分片上传图片
   * 大于 1MB 的图片会自动分片上传
   */
  async uploadImageChunked(
    imageData: string,
    mimeType: string,
    platform: string = 'weibo'
  ): Promise<{ url: string; platform: string }> {
    // 小于阈值，直接上传
    if (imageData.length < this.CHUNK_THRESHOLD) {
      return this.request('uploadImage', { imageData, mimeType, platform })
    }

    // 大图片，分片上传
    const uploadId = this.generateId()
    const chunks: string[] = []

    // 分割 base64 数据
    for (let i = 0; i < imageData.length; i += this.CHUNK_SIZE) {
      chunks.push(imageData.slice(i, i + this.CHUNK_SIZE))
    }

    console.error(`[Bridge] Chunked upload: ${chunks.length} chunks, total size: ${imageData.length}`)

    // 1. 发送开始消息
    await this.request('uploadImage:start', {
      uploadId,
      totalChunks: chunks.length,
      mimeType,
      platform,
    })

    // 2. 逐个发送分片
    for (let i = 0; i < chunks.length; i++) {
      await this.request('uploadImage:chunk', {
        uploadId,
        chunkIndex: i,
        data: chunks[i],
      })
    }

    // 3. 发送完成消息并获取结果
    const result = await this.request<{ url: string; platform: string }>('uploadImage:complete', {
      uploadId,
    })

    return result
  }
}
