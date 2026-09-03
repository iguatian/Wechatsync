# 文章同步助手 (Wechatsync)

![](https://img.shields.io/github/v/release/wechatsync/Wechatsync.svg)
![](https://img.shields.io/github/last-commit/wechatsync/Wechatsync)
![](https://img.shields.io/github/issues/wechatsync/Wechatsync)

**开源免费**的跨平台文章同步工具 | Chrome 浏览器扩展 | 自媒体内容分发神器

一键同步微信公众号文章到知乎、头条、掘金、小红书、CSDN、腾讯内容开放平台、汽车之家、懂车帝、中关村在线、界面新闻 等 34+ 平台，支持 WordPress 等自建博客，告别重复复制粘贴。

> 🔥 支持 **Anthropic MCP 协议**，可在 Claude Desktop / Claude Code 中通过 AI 一键发布文章

## 工作原理

**文章同步助手不是爬虫，不模拟登录，不经过任何第三方服务器。**

它是一个 Chrome 浏览器扩展，工作方式与浏览器本身一致：

1. **使用你自己的登录态**：你在浏览器里正常登录各平台账号，扩展直接使用浏览器中已有的 Cookie，无需额外授权，无需输入密码
2. **调用平台官方接口**：发布文章时，扩展调用的是各平台 Web 编辑器使用的同一套官方 API，与你手动在网页上发布完全等价
3. **数据不离开你的设备**：所有请求直接从你的浏览器发往各平台，没有中间服务器，没有数据上传，源代码完全开源可审计
4. **草稿优先**：默认将文章同步为草稿，发布前由你人工确认，不会自动发布

```
你的浏览器（已登录各平台）
    ↓  扩展读取 Cookie
    ↓  调用平台官方 Web API
各平台（知乎 / 掘金 / 头条 / ...）
```

## 功能特性

- **一键批量发布**: 微信公众号文章同步到知乎、掘金、头条、CSDN、简书、微博、小红书、抖音、汽车之家、懂车帝、中关村在线、界面新闻等 28+ 自媒体平台
- **网页转 Markdown**: 任意网页智能提取正文，自动过滤广告噪音，图片本地化，打包为 Markdown + 图片 ZIP 压缩包
- **自建站支持**: WordPress、Typecho、博客园 (MetaWeblog API)
- **智能提取**: 自动从网页提取文章标题、内容、封面图（基于 Safari 阅读模式）
- **图片自动上传**: 自动转存文章图片到目标平台，无需手动处理
- **草稿模式**: 同步后保存为草稿，方便二次编辑后发布
- **AI 集成**: 支持 Anthropic MCP / Claude Code Skill / OpenClaw，多种方式接入 AI 工作流

## 安装方式

### Chrome 浏览器扩展安装

**推荐**: [Chrome 网上应用店](https://chrome.google.com/webstore/detail/%E5%BE%AE%E4%BF%A1%E5%90%8C%E6%AD%A5%E5%8A%A9%E6%89%8B/hchobocdmclopcbnibdnoafilagadion) (自动更新)

**手动安装**: 下载 [最新 Release](https://wpics.oss-cn-shanghai.aliyuncs.com/wechatsync-2.0.9.zip?date=20260274) 解压后加载到 Chrome 扩展

支持 Chrome / Edge / 360 / QQ 等 Chromium 内核浏览器


## 支持 28+ 主流平台

| 平台 | ID | 类型 | 状态 |
|-----|-----|-----|-----|
| 微信公众号 | weixin | 主流自媒体 | ✅ |
| 知乎 | zhihu | 主流自媒体 | ✅ |
| 微博 | weibo | 主流自媒体 | ✅ |
| 小红书 | xiaohongshu | 主流自媒体 | ✅ 🆕 |
| 掘金 | juejin | 技术社区 | ✅ |
| CSDN | csdn | 技术社区 | ✅ |
| 简书 | jianshu | 通用 | ✅ |
| 头条号 | toutiao | 通用 | ✅ |
| 抖音图文 | douyin | 主流自媒体 | ✅ 🆕 |
| 腾讯内容开放平台 | qq-content | 通用 | ✅ 🆕 |
| B站专栏 | bilibili | 通用 | ✅ |
| 百家号 | baijiahao | 通用 | ✅ |
| 语雀 | yuque | 技术社区 | ✅ |
| 人人都是产品经理 | woshipm | 产品 | ✅ |
| 大鱼号 | dayu | 通用 | ✅ |
| 一点号 | yidian | 通用 | ✅ |
| 51CTO | 51cto | 技术社区 | ✅ |
| 慕课网 | imooc | 技术社区 | ✅ |
| 开源中国 | oschina | 技术社区 | ✅ |
| SegmentFault | segmentfault | 技术社区 | ✅ |
| 博客园 | cnblogs | 技术社区 | ✅ |
| 汽车之家 | autohome | 汽车 | ✅ 🆕 |
| 懂车帝 | dongchedi | 汽车 | ✅ 🆕 |
| 中关村在线 | zol | 数码科技 | ✅ 🆕 |
| 界面新闻 | jiemian | 通用 | ✅ 🆕 |
| 什么值得买 | smzdm | 通用 | ✅ |
| 网易号 | netease | 通用 | ✅ |
| 搜狐号 | sohu | 通用 | ✅ |

<!-- 暂时不用支持 -->
| 搜狐焦点 | sohufocus | 房产 | ✅ |
| 雪球 | xueqiu | 财经 | ✅ |
| 东方财富 | eastmoney | 财经 | ✅ |
<!-- 不用支持 -->
<!-- | 豆瓣 | douban | 通用 | ✅ |
| X (Twitter) | x | 海外 | ✅ |
| WordPress | wordpress | 建站/CMS | ✅ |
| Typecho | typecho | 建站/CMS | ✅ |
| Hexo | zip-download | 建站/CMS | ✅ 通过 Markdown 下载 |
| Hugo | zip-download | 建站/CMS | ✅ 通过 Markdown 下载 | -->

- [提交新平台请求](https://airtable.com/shrLSJMnTC2BlmP29)
## weixin,zhihu,weibo,xiaohongshu,juejin,csdn,jianshu,toutiao,douyin,qq-content,bilibili,baijiahao,yuque,douban,sohu,xueqiu,woshipm,dayu,yidian,51cto,imooc,oschina,segmentfault,cnblogs,sohufocus,autohome,dongchedi,zol,jiemian,x,eastmoney,smzdm,netease,wordpress,typecho,zip-download,zip-download
### 双封面平台（懂车帝）

懂车帝是典型的双封面平台：信息流推荐位用 **横版**（4:3），图文详情页用 **竖版**（3:4），两者必须分别上传，不能复用同一张图。**懂车帝会忽略通用的 `cover` 字段**，必须用专门的 `cover-horizontal` + `cover-vertical`。

```yaml
---
title: 我的文章
cover: ./cover.png                   # 通用单封面（多数平台使用，懂车帝忽略）
cover-horizontal: ./cover-horizontal.jpg  # 懂车帝横版
cover-vertical: ./cover-vertical.jpg      # 懂车帝竖版
---
```

CLI 也可以覆盖：

```bash
wechatsync sync article.md -p dongchedi \
  --cover-horizontal ./cover-horizontal.jpg \
  --cover-vertical ./cover-vertical.jpg
```

仅提供一个封面时，发布会报错并明确提示补齐；不会静默用同一张图当两张。

## CLI 命令行工具

最简单的使用方式，无需配置 MCP，复制粘贴即可上手。

### 安装 CLI（二选一）

#### 方式 A：全局安装（推荐）

```bash
npm install -g @wechatsync/cli
```

安装后 `wechatsync` 会在 `PATH` 中可用，全局生效。

#### 方式 B：本地构建直接调用（适合二次开发 / 离线）

如果你不想全局安装，可以 clone 仓库本地构建后用 `node` 直接调用。

**1. 克隆并构建**

```bash
git clone https://github.com/wechatsync/Wechatsync.git
cd Wechatsync
pnpm install
pnpm --filter @wechatsync/cli build
```

**2. 直接调用（Windows PowerShell 示例）**

```powershell
# 把 ./test/mechanical-keyboard-review-2026.md 同步到微博和什么值得买
# 也可以使用仓库自带的模板：./test/mechanical-keyboard-review-2026.md
node .\packages\cli\dist\index.js sync .\test\mechanical-keyboard-review-2026.md -p "weibo,smzdm"
```

> 更多参数（`-t` 自定义标题、`--cover` 通用封面图、`--cover-horizontal` 横版封面图（懂车帝等双封面平台）、`--cover-vertical` 竖版封面图（懂车帝等双封面平台）、`--timeout` 超时等）见 [packages/cli/README.md](packages/cli/README.md)。

### 设置 Token

在 Chrome 扩展的「MCP 连接」设置里拿到 Token 后，设置到环境变量。三种写法按平台选其一即可：

```bash
# macOS / Linux（bash / zsh）
export WECHATSYNC_TOKEN="你的token"
```

```cmd
:: Windows CMD（仅当前窗口生效）
set WECHATSYNC_TOKEN=你的token
```

```powershell
# Windows PowerShell（仅当前会话生效）
$env:WECHATSYNC_TOKEN = "你的token"
```

> 永久生效：
> - macOS / Linux：写入 `~/.zshrc` 或 `~/.bashrc`。
> - Windows CMD：`setx WECHATSYNC_TOKEN "你的token"`（写用户环境变量，新开窗口生效）。
> - Windows PowerShell：`setx WECHATSYNC_TOKEN "你的token"` 或 `[Environment]::SetEnvironmentVariable("WECHATSYNC_TOKEN","你的token","User")`。

### 同步文章

```bash
# 同步文章到多个平台（全局安装时）
wechatsync sync article.md -p zhihu,juejin,csdn

# 查看平台登录状态
wechatsync platforms --auth

# 从浏览器当前页面提取文章
wechatsync extract -o article.md
```

> 更多参数（`-t` 自定义标题、`--cover` 通用封面图、`--cover-horizontal` 横版封面图（懂车帝等双封面平台）、`--cover-vertical` 竖版封面图（懂车帝等双封面平台）、`--timeout` 连接超时等）见 [packages/cli/README.md](packages/cli/README.md)。

### Claude Code Skill 集成

安装后可在 Claude Code 中直接用自然语言操作：

```bash
/plugin marketplace add wechatsync
/plugin install wechatsync
```

然后直接说"把这篇文章同步到掘金和知乎"即可。

### OpenClaw 集成

通过 [ClawHub](https://clawhub.ai/lljxx1/wechatsync) 技能市场一键安装：

```bash
clawhub install lljxx1/wechatsync
```

详细文档见 [packages/cli/README.md](packages/cli/README.md)

## MCP Server 直接调用（无 AI 客户端）

如果你不想用任何 AI 客户端（Claude Desktop / Claude Code），希望直接在 **Windows CMD / PowerShell / 脚本** 中通过 MCP 协议同步文章，可以直接启动 MCP Server 并通过 HTTP API 调用 —— 这就是 WechatSync 的「无头（headless）」用法。

> 如果你只是想在命令行同步文章，不需要暴露 HTTP API，请直接看上一节 [CLI 命令行工具](#cli-命令行工具)。

### 架构

```
┌─────────────┐     HTTP / stdio     ┌────────────────┐    WebSocket    ┌──────────────┐
│  CMD 脚本    │ ◄─────────────────► │  MCP Server    │ ◄─────────────► │ Chrome 扩展   │
│  PowerShell │   http://:9528/sse   │ (Node.js)      │    ws://:9527   │  (登录态)    │
└─────────────┘                      └────────────────┘                 └──────────────┘
```

CLI 与 MCP Server 都基于同一套 `ExtensionBridge`（MCP 桥接）与扩展通信，区别只是 CLI 内置命令解析、MCP Server 暴露 HTTP API。

### 方式一：直接启动 MCP Server（SSE 模式）

适合用 `curl` / PowerShell / Python / 批处理 自己调度 MCP 调用。

**第一步：构建 MCP Server**

```bash
git clone https://github.com/wechatsync/Wechatsync.git
cd Wechatsync
pnpm install
pnpm build
```

**第二步：启动 MCP Server**

新开一个 CMD / PowerShell 窗口（保持运行）：

```cmd
cd /d E:\git\Wechatsync

:: 设置与 Chrome 扩展一致的 Token
set MCP_TOKEN=your-secret-token-here

:: 启动 MCP Server，监听 http://localhost:9528
node packages\mcp-server\dist\index.js --sse
```

启动成功会看到：

```
[MCP] Sync Assistant started (SSE mode)
[MCP] HTTP Server: http://localhost:9528
[MCP] Claude Code: http://localhost:9528/sse
[MCP] Extension WebSocket: ws://localhost:9527
```

`--sse` 不加时默认是 **stdio 模式**，专门用于被 Claude Code / Claude Desktop 这种 stdio 客户端拉起；SSE 模式则暴露 HTTP API，供 CMD / 脚本调用。

**第三步：在另一个 CMD 窗口调用 HTTP API**

健康检查：

```cmd
curl http://localhost:9528/health
```

列出平台与登录状态：

```cmd
curl -X POST http://localhost:9528/request ^
  -H "Content-Type: application/json" ^
  -d "{\"method\":\"listPlatforms\",\"params\":{\"forceRefresh\":true}}"
```

同步文章到知乎 + 掘金（`syncArticle`）：

```cmd
curl -X POST http://localhost:9528/request ^
  -H "Content-Type: application/json" ^
  -d "{\"method\":\"syncArticle\",\"params\":{\"platforms\":[\"zhihu\",\"juejin\"],\"article\":{\"title\":\"我的文章\",\"markdown\":\"## 标题\\n\\n这是正文内容\"}}}"
```

从浏览器当前页提取文章（`extractArticle`）：

```cmd
curl -X POST http://localhost:9528/request ^
  -H "Content-Type: application/json" ^
  -d "{\"method\":\"extractArticle\",\"params\":{}}"
```

> **Windows CMD 注意事项**
> - 多行续行使用 `^`（不是 Linux 的 `\`）。
> - JSON 里的 `"` 需要用 `\"` 转义；`\n` 需要写成 `\\n`。
> - 如果没有 `curl`，Windows 10 1607+ 自带；更老系统可改用 PowerShell 的 `Invoke-RestMethod`。

### 方式二：PowerShell 一键脚本

保存为 `sync.ps1`，在 CMD 下 `powershell -ExecutionPolicy Bypass -File sync.ps1` 即可：

```powershell
$ErrorActionPreference = "Stop"
$env:MCP_TOKEN = "your-secret-token-here"

# 1. 后台启动 MCP Server
$proc = Start-Process -FilePath "node" `
    -ArgumentList "packages\mcp-server\dist\index.js","--sse" `
    -WorkingDirectory "E:\git\Wechatsync" `
    -PassThru -NoNewWindow

try {
    # 2. 等扩展连上
    Start-Sleep -Seconds 5

    # 3. 调用 HTTP API 同步
    $body = @{
        method = "syncArticle"
        params = @{
            platforms = @("zhihu","juejin")
            article   = @{
                title    = "我的文章"
                markdown = "## 标题`n`n这是正文..."
            }
        }
    } | ConvertTo-Json -Depth 10

    Invoke-RestMethod -Method Post `
        -Uri "http://localhost:9528/request" `
        -ContentType "application/json" `
        -Body $body
}
finally {
    # 4. 清理
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id }
}
```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `MCP_TOKEN` / `WECHATSYNC_TOKEN` | 安全 Token（任选一个），必须与 Chrome 扩展中设置的一致 | - |
| `SYNC_WS_PORT` | Extension WebSocket 端口 | 9527 |
| `SYNC_HTTP_PORT` | MCP Server HTTP 端口（SSE 模式） | 9528 |
| `SYNC_PORT_START` / `SYNC_PORT_END` | 多端口模式端口范围 | 9527~9560 |
| `SYNC_SSE_HTTP_PORT` | SSE 监听端口（多端口模式下默认 = WS_PORT_END + 2） | 9528 |

> CMD 中 `set` 只对当前窗口有效；要永久生效用 `setx MCP_TOKEN "your-token"`（需新开 CMD 窗口）。

### 常见错误

- **「Token mismatch」** — CMD 里的 `MCP_TOKEN` 与 Chrome 扩展中的 Token 不完全一致（大小写、空格都会算）。
- **「Extension not connected」** — Chrome 浏览器需要打开，扩展已启用「MCP 连接」开关。
- **「Port 9527 in use」** — 已有进程占用，使用 `set SYNC_WS_PORT=9600` 换一个端口，同时到扩展设置里把「服务器地址」改成 `ws://localhost:9600`。
- **curl 报 `'{"method"...}' 不是有效 JSON`** — 大概率是 `\"` 没写对，CMD 下 JSON 字符串必须把每个 `"` 转义为 `\"`，把 `\n` 写成 `\\n`。

## Claude Code / Claude Desktop 集成 (Anthropic MCP)

通过 Anthropic MCP 协议，可以在 Claude Code 或 Claude Desktop 中使用 AI 同步公众号文章到多个平台。

### 配置步骤

1. 构建项目: `pnpm build`
2. 在 Chrome 扩展设置中启用「MCP 连接」，并设置 Token
3. 在 `~/.claude/claude_desktop_config.json` 中添加配置：

```json
{
  "mcpServers": {
    "sync-assistant": {
      "command": "node",
      "args": ["/path/to/Wechatsync/packages/mcp-server/dist/index.js"],
      "env": {
        "MCP_TOKEN": "your-secret-token-here"
      }
    }
  }
}
```

**重要**: `MCP_TOKEN` 必须与 Chrome 扩展中设置的 Token 一致。

### 使用示例

```
"帮我把这篇文章同步到知乎和掘金"
"检查下哪些平台已登录"
```

### 可用工具

| 工具 | 说明 |
|-----|------|
| `list_platforms` | 列出所有平台及登录状态 |
| `check_auth` | 检查指定平台登录状态 |
| `sync_article` | 同步文章到指定平台（草稿） |
| `extract_article` | 从当前浏览器页面提取文章 |
| `upload_image_file` | 上传本地图片到平台 |

详细文档见 [packages/mcp-server/README.md](packages/mcp-server/README.md)

## 网页发起同步

如果你是文章编辑器开发者，或有内容库需要同步多个渠道，可以使用 JS SDK：

- [article-syncjs](https://github.com/wechatsync/article-syncjs) - 网页端 SDK
- [API 文档](API.md)

```javascript
// 拉起同步任务框
window.syncPost(article)
```

## 开发

### 项目结构

```
Wechatsync/
├── packages/
│   ├── extension/     # Chrome 扩展 (MV3)
│   ├── mcp-server/    # MCP Server (stdio/SSE)
│   ├── cli/           # 命令行工具
│   └── core/          # 核心逻辑 (共享)
```

### 本地开发

```bash
# 安装依赖
pnpm install

# 开发模式
pnpm dev

# 构建
pnpm build
```

然后在 Chrome 中加载 `packages/extension/dist` 目录。

## 更新日志

### v2.1.3 (2026-09-02)

- 🆕 新增界面新闻（a.jiemian.com）创作者平台适配器，支持文章同步为草稿。鉴权走 JSONP `getlogin` 接口，封面走 multipart 上传（固定尺寸 840×480），提交流程在投稿前会重新拉取会话级 `verifycode`（CSRF）并 `sendtype=2` 写入草稿箱。投稿资格要求账号 `level >= 2`，不足时服务端通常以 `code:3` 拒绝保存。

### v2.1.2 (2026-08-28)

- 🆕 新增中关村在线创作者平台适配器，支持图文文章同步为草稿。**双封面平台**（与懂车帝一致）：需要同时提供 `cover-horizontal`（横版 4:3）+ `cover-vertical`（竖版 3:4）两个封面字段，可在 CLI 用 `--cover-horizontal` / `--cover-vertical` 覆盖。读者看到的导读图是后台 `guideImg` 列表的上传结果。

### v2.1.1 (2026-08-27)

- 🆕 新增懂车帝创作者平台适配器，要求 **横版 + 竖版双封面**（分别上传）。懂车帝忽略通用 `cover`，必须用专属字段 `cover-horizontal`（横版）+ `cover-vertical`（竖版），可在 CLI 用 `--cover-horizontal` / `--cover-vertical` 覆盖。少任一封面会发布失败，不会静默复用同一张图。

### v2.1.0 (2026-08-27)

- 🆕 新增汽车之家（创作者中心）平台适配器，支持 BBS 发文同步为草稿（基于 Lexical 编辑器状态）

### v2.0.9 (2026-03-24)

- 🆕 文章识别和提取更准确，支持更多网页
- 🆕 CLI/MCP 同步 HTML 文件时自动保留排版样式
- 🆕 同步对话框增加使用提示
- 🔧 修复部分网页悬浮按钮显示异常

### v2.0.8 (2026-03-17)

- 🆕 新增抖音图文
- 🆕 统一同步对话框和悬浮按钮
- 🔧 修复 CLI 同步格式异常
- 🔧 改善 CLI/MCP 桥接重连稳定性

### v2.0.7 (2026-03-10)

- 🆕 新增什么值得买、网易号平台
- 🆕 简书支持 Markdown 格式发布
- 🔧 重新适配简书、一点号、搜狐号

### v2.0.6 (2026-02-25)

- 🆕 新增东方财富
- 🆕 新增悬浮同步按钮

### v2.0.5 (2025-02-05)

- 🔧 代码块提取兼容性提升
- 🆕 新增 Markdown 压缩包下载

完整日志见 [更新日志页面](https://www.wechatsync.com/changelog)

## 贡献代码

欢迎参与项目开发！

- [待支持的平台列表](https://airtable.com/shrLSJMnTC2BlmP29)
- [如何开发一个适配器](docs/adapter-spec.md)
- [API 文档](API.md)

## 使用场景

- **自媒体运营者**: 公众号文章一键同步到知乎、头条、百家号等多平台，提升内容分发效率
- **技术博主**: 技术博客同步到掘金、CSDN、SegmentFault、开源中国等技术社区
- **内容创作者**: 告别重复复制粘贴，一次编写多处发布，多平台发文不再繁琐
- **AI 写作用户**: 配合 Claude / GPT 等 AI 写作工具，AIGC 内容一键发布到多平台
- **独立博主**: WordPress、Typecho 博客文章同步到各大自媒体平台引流

## 常见问题

**Q: 这是什么工具？**

文章同步助手是一款开源免费的 Chrome 浏览器扩展，帮助自媒体作者、博主、内容创作者将文章一键同步到多个平台，避免重复复制粘贴，是自媒体运营必备的多平台发文工具。

**Q: Token 从哪里获取？怎么设置？**

在 Chrome 扩展的「设置 / MCP 连接」面板里自定义一个 Token（如 `my-secret-123`），然后按你的系统设到环境变量里，变量名用 `WECHATSYNC_TOKEN` 或 `MCP_TOKEN` 任选一个都行；最终要和 Chrome 扩展里填的完全一致。详细三种平台写法看 [设置 Token](#设置-token)。

**Q: 「Extension not connected」怎么办？**

依次检查：① Chrome 浏览器是否开着；② 扩展是否启用了「MCP 连接」开关；③ Token 两边是否完全一致；④ 端口是否被占用（可调 `SYNC_WS_PORT`）。

**Q: 支持同步微信公众号文章吗？**

支持。可以直接从微信公众号编辑器提取文章，一键同步到知乎、头条、掘金等 34+ 平台。支持公众号文章同步到头条号、公众号同步到知乎、微信文章同步到掘金等各种场景。

**Q: 支持 AI 写作工具吗？**

支持 Anthropic MCP 协议，可配合 Claude Desktop、Claude Code 等 AI 工具使用，实现 AI 写作、AIGC 内容一键发布。也可以配合 ChatGPT、GPT-4 等工具生成的文章使用。

**Q: 数据安全吗？会上传我的账号信息吗？**

不会。所有操作在本地浏览器内完成，你的 Cookie、文章内容、账号信息不经过任何第三方服务器。代码完全开源，可自行审计：[查看源码](https://github.com/wechatsync/Wechatsync)

**Q: 和微小宝、新媒体管家、简媒、蚁小二有什么区别？**

文章同步助手是**开源免费**的，代码完全公开透明，无需付费订阅。作为浏览器扩展运行，数据本地存储，账号信息不上传，支持 MCP 协议可与 AI 工具集成。

**Q: 如何同步文章到多个平台？**

1. 安装 Chrome 浏览器扩展
2. 登录各平台账号（知乎、掘金、头条等）
3. 打开要同步的文章页面
4. 点击扩展图标，选择目标平台，一键同步

## Author

**fun** · 独立开发者 · [GitHub](https://github.com/lljxx1) · [主页](https://fun0.netlify.app/about/)

## License

GPL-3.0
