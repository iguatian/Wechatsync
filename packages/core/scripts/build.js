#!/usr/bin/env node
/**
 * @wechatsync/core 构建入口
 *
 * tsup 生成 DTS 时使用 worker 线程, 默认堆内存上限较低,
 * 在大型项目上容易触发 ERR_WORKER_OUT_OF_MEMORY。
 * 这里在启动 tsup 前设置 NODE_OPTIONS 提高堆内存上限,
 * 子进程 (含 DTS worker) 会自动继承该配置。
 *
 * 用法: node scripts/build.js [tsup 参数...]
 */

'use strict'

// 仅在未显式设置更大的堆内存时才覆盖, 避免与用户自定义配置冲突
const HEAP_SIZE = '--max-old-space-size=4096'
const env = process.env.NODE_OPTIONS || ''
if (!env.includes('max-old-space-size')) {
  process.env.NODE_OPTIONS = env ? `${env} ${HEAP_SIZE}` : HEAP_SIZE
}

const { spawnSync } = require('node:child_process')

const result = spawnSync('tsup', process.argv.slice(2), {
  stdio: 'inherit',
  shell: true,
})

if (result.error) {
  console.error('[build] 无法启动 tsup:', result.error.message)
  process.exit(1)
}

process.exit(result.status ?? 1)