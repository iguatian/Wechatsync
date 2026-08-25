/**
 * mcp-server 构建脚本（带重试）
 *
 * 背景：Windows 平台下 tsup/esbuild 偶发崩溃（退出码 3221226356 = 0xC000001C
 * STATUS_INVALID_USER_BUFFER），崩溃时已生成的产物可能不完整（DTS 中途丢失）。
 *
 * 策略：直接调用 tsup，失败时自动重试 3 次（间隔递增）。
 */

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const MAX_RETRIES = 3
const tsupBin = path.resolve(__dirname, '..', 'node_modules', '.bin', 'tsup.cmd')

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  console.log(`[mcp-server build] attempt ${attempt}/${MAX_RETRIES}`)

  const result = spawnSync(tsupBin, [], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
    shell: true,
  })

  if (result.status === 0) {
    console.log(`[mcp-server build] ✅ success on attempt ${attempt}`)
    process.exit(0)
  }

  const isWindowsFlakyCrash =
    result.status === 3221226356 || // 0xC000001C STATUS_INVALID_USER_BUFFER
    result.status === 3221225477 || // 0xC0000005 STATUS_ACCESS_VIOLATION
    result.status === 3221225506 || // 0xC0000022 STATUS_ACCESS_DENIED
    result.signal === 'SIGSEGV' ||
    result.signal === 'SIGABRT'

  console.error(
    `[mcp-server build] attempt ${attempt} failed (status=${result.status}, signal=${result.signal})`
  )

  // 仅对 Windows 平台下的偶发崩溃进行重试；明确错误（如语法错误）直接失败
  if (!isWindowsFlakyCrash && process.platform !== 'win32') {
    console.error('[mcp-server build] 非偶发崩溃，直接退出')
    process.exit(result.status ?? 1)
  }

  if (attempt < MAX_RETRIES) {
    const delay = 1000 * attempt
    console.log(`[mcp-server build] 等待 ${delay}ms 后重试…`)
    // 同步 sleep（spawnSync 不支持 async/await）
    const until = Date.now() + delay
    while (Date.now() < until) {
      // busy-wait（仅几秒，影响可忽略）
    }
  }
}

console.error(`[mcp-server build] ❌ 重试 ${MAX_RETRIES} 次后仍然失败`)
process.exit(1)