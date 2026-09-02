#!/usr/bin/env node
/**
 * 修复 tsup DTS bundling 跳过 jiemian.ts 的问题。
 *
 * tsup 8.5.1 + rollup-plugin-dts 6.1.1 在 DTS bundling 时会错误地跳过
 * packages/core/src/adapters/platforms/jiemian.ts（原因不明 —— ESM bundle
 * 正常包含 JiemianAdapter，但 DTS 不包含）。本脚本在 tsup 构建完成后：
 *
 *   1. 用 TypeScript Compiler API 单独为 jiemian.ts 生成 d.ts
 *   2. 抽离 declare class 块，去掉 imports/exports
 *   3. 插入到 dist/adapters/index.d.ts 和 dist/adapters/index.d.mts 中
 *      （在最后一个 declare class 之后，export 列表之前）
 *   4. 在所有 export 列表中加入 JiemianAdapter
 *
 * 设计为完全同步、零 spawn，可在 build.js 内被直接 require 调用，
 * 避免 PowerShell 沙箱环境对子进程的访问限制。
 *
 * 用法: require('./fix-dts')()  或  node scripts/fix-dts.js
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const PACKAGE_ROOT = path.resolve(__dirname, '..')
const SRC_DIR = path.join(PACKAGE_ROOT, 'src')
const DIST_DIR = path.join(PACKAGE_ROOT, 'dist')

const JIEMIAN_SRC = path.join(SRC_DIR, 'adapters', 'platforms', 'jiemian.ts')
const ADAPTERS_REL = 'src/adapters/platforms/jiemian.ts'

/**
 * Step 1: 用 TS Compiler API 同步生成 jiemian.d.ts（通过自定义 writeFile
 * 回调收集到内存，避免任何磁盘 I/O 副作用）。
 */
function compileJiemianDts() {
  const tsconfig = path.join(PACKAGE_ROOT, 'tsconfig.json')
  const parsed = ts.parseConfigFileTextToJson(tsconfig, fs.readFileSync(tsconfig, 'utf8'))
  if (parsed.error) {
    throw new Error('[fix-dts] tsconfig parse error: ' + parsed.error.messageText)
  }

  const writeOptions = {
    ...parsed.config.compilerOptions,
    declaration: true,
    emitDeclarationOnly: true,
    noEmit: false,
    rootDir: SRC_DIR,
    skipLibCheck: true,
  }

  const program = ts.createProgram([JIEMIAN_SRC], writeOptions)

  const collected = new Map()
  const writeFile = (fileName, text) => {
    collected.set(fileName, text)
  }

  const result = program.emit(undefined, writeFile, undefined, true)

  // 报告编译错误
  const allDiag = ts.getPreEmitDiagnostics(program).concat(result.diagnostics || [])
  const errors = allDiag.filter(d => d.category === ts.DiagnosticCategory.Error)
  if (errors.length > 0) {
    const msgs = errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    throw new Error('[fix-dts] TS emit errors:\n' + msgs.join('\n'))
  }

  // 找到 jiemian.d.ts
  for (const [name, text] of collected.entries()) {
    if (name.endsWith('jiemian.d.ts')) return text
  }
  throw new Error('[fix-dts] generated d.ts not found in compiler output')
}

/**
 * Step 2: 从生成的 d.ts 中抽取 declare class 块（去掉 imports/export）。
 */
function extractDeclareClass(dtsText) {
  const lines = dtsText.split(/\r?\n/)
  const out = []
  let inDeclare = false
  for (const line of lines) {
    const trimmed = line.trim()
    // 跳过 import
    if (/^import\s/.test(trimmed)) continue
    // 跳过顶层 export declare class 关键字
    if (inDeclare || /^export declare class\s+JiemianAdapter/.test(trimmed)) {
      inDeclare = true
      out.push(line.replace(/^export declare class/, 'declare class'))
      if (trimmed === '}') break
    }
  }

  const header = [
    '/**',
    ' * 界面新闻（a.jiemian.com）创作者平台适配器',
    ' *',
    ' * @see ./jiemian 源文件查看完整实现与 API 说明',
    ' */',
  ]
  return header.concat(out).join('\n') + '\n'
}

/**
 * Step 3: 把 declare block 与 JiemianAdapter 加入到目标 dts 文件。
 *
 * 处理三种状态：
 *   A. export 列表已含 JiemianAdapter，且 declare class 已存在 → 无需修补
 *   B. export 列表缺 JiemianAdapter 但有 ZolAdapter 锚点 → patch export + declare
 *   C. export 列表缺 JiemianAdapter 且无锚点 → 返回 false（让 build 报错）
 */
function patchDts(dtsFile, declareBlock) {
  if (!fs.existsSync(dtsFile)) {
    console.warn('[fix-dts] skip (not found):', dtsFile)
    return false
  }
  const original = fs.readFileSync(dtsFile, 'utf8')
  let content = original

  const exportLineRegex = /^export \{[^}]*\}(?:\s+from\s+['"][^'"]+['"])?;?\s*$/gm
  const exportMatches = [...content.matchAll(exportLineRegex)]
  if (exportMatches.length === 0) {
    throw new Error('[fix-dts] export list not found in ' + dtsFile)
  }

  // 3a. 检查 export 是否已含 JiemianAdapter；否则在 ZolAdapter 锚点后插入
  let exportPatched = false
  for (const match of exportMatches) {
    const exportLine = match[0]
    if (exportLine.includes('JiemianAdapter')) {
      exportPatched = true
      continue
    }
    const replaced = exportLine.replace(
      /(\bZolAdapter,)(\s+adapterRegistry,)/,
      '$1 JiemianAdapter,$2',
    )
    if (replaced !== exportLine) {
      content = content.replace(exportLine, replaced)
      exportPatched = true
    }
  }

  const hasJiemianDeclare = /^declare\s+class\s+JiemianAdapter/m.test(content)

  // 状态 A：都已有 → 无需任何修补
  if (exportPatched && hasJiemianDeclare) {
    console.log('[fix-dts] already complete, skipping:', dtsFile)
    return true
  }

  // 状态 C：export 没有 JiemianAdapter 且无锚点 → 失败
  if (!exportPatched) {
    console.error(
      '[fix-dts] WARN: JiemianAdapter missing from export list and no ZolAdapter anchor found in',
      dtsFile,
    )
    return false
  }

  // 状态 B：export 已 patch，但 declare class 可能还缺，补上它
  if (!hasJiemianDeclare) {
    const hasOtherDeclare = /^declare\s+(class|abstract\s+class|namespace|module)/m.test(content)
    if (hasOtherDeclare) {
      const lastDeclareEndMatch = content.match(/\n}\s*\n(?=[^]*?^export\s*\{)/m)
      if (lastDeclareEndMatch) {
        const insertAt = lastDeclareEndMatch.index + lastDeclareEndMatch[0].length - 2
        content =
          content.slice(0, insertAt) +
          '\n\n' +
          declareBlock +
          '\n' +
          content.slice(insertAt)
      } else {
        // 兜底：在第一个 export 前插入
        const firstExportIdx = content.search(/^export\s*\{/m)
        content =
          content.slice(0, firstExportIdx) +
          declareBlock +
          '\n\n' +
          content.slice(firstExportIdx)
      }
    } else {
      // 文件本身没有 declare class（纯 re-export），但 export 已修复 → 仅补 export 即可
      console.log('[fix-dts] no declare class in file, export-only patch:', dtsFile)
    }
  }

  fs.writeFileSync(dtsFile, content, 'utf8')
  console.log('[fix-dts] patched:', dtsFile, '(+' + (content.length - original.length) + ' bytes)')
  return true
}

function main() {
  console.log('[fix-dts] starting post-processing...')
  const dtsText = compileJiemianDts()
  const declareBlock = extractDeclareClass(dtsText)

  const targets = [
    path.join(DIST_DIR, 'adapters', 'index.d.ts'),
    path.join(DIST_DIR, 'adapters', 'index.d.mts'),
    path.join(DIST_DIR, 'index.d.ts'),
    path.join(DIST_DIR, 'index.d.mts'),
  ]
  let patchedCount = 0
  for (const f of targets) {
    if (patchDts(f, declareBlock)) patchedCount++
  }
  console.log('[fix-dts] done, patched ' + patchedCount + '/' + targets.length + ' files')
  return patchedCount
}

if (require.main === module) {
  try {
    const n = main()
    process.exit(n > 0 ? 0 : 1)
  } catch (e) {
    console.error('[fix-dts] failed:', e && e.stack ? e.stack : e)
    process.exit(1)
  }
}

module.exports = { main, compileJiemianDts, extractDeclareClass, patchDts }
