#!/usr/bin/env node
/**
 * 修复 tsup DTS bundling 跳过新增适配器的问题。
 *
 * tsup 8.5.1 + rollup-plugin-dts 6.1.1 在 DTS bundling 时会错误地跳过"最新新增的
 * 那个适配器文件"（原因不明 —— ESM/CJS bundle 正常包含该 adapter 类，但 DTS 不包含；
 * 历史现象：新增 jiemian.ts 时丢 JiemianAdapter，新增 sspai.ts 后改丢 SspaiAdapter）。
 *
 * 本脚本在 tsup 构建完成后，对 ADAPTERS 列表里的每个适配器：
 *
 *   1. 用 TypeScript Compiler API 单独为对应源文件生成 d.ts
 *   2. 抽离 declare class 块，去掉 imports/exports
 *   3. 插入到 dist/adapters/index.d.ts 和 dist/adapters/index.d.mts 中
 *      （在最后一个 declare class 之后，export 列表之前）
 *   4. 在所有 export 列表中加入该 adapter 类名（按字母序插入）
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

/**
 * 需要兜底补进 d.ts 的适配器列表。
 * 新增适配器时，把源文件与类名加到这里即可（doc 为写入 d.ts 的注释块）。
 */
const ADAPTERS = [
  {
    className: 'JiemianAdapter',
    srcFile: path.join(SRC_DIR, 'adapters', 'platforms', 'jiemian.ts'),
    doc: [
      '/**',
      ' * 界面新闻（a.jiemian.com）创作者平台适配器',
      ' *',
      ' * @see ./jiemian 源文件查看完整实现与 API 说明',
      ' */',
    ],
  },
  {
    className: 'SspaiAdapter',
    srcFile: path.join(SRC_DIR, 'adapters', 'platforms', 'sspai.ts'),
    doc: [
      '/**',
      ' * 少数派（sspai.com / Matrix）适配器',
      ' *',
      ' * @see ./sspai 源文件查看完整实现与 API 说明',
      ' */',
    ],
  },
]

/**
 * Step 1: 用 TS Compiler API 同步生成指定源文件的 d.ts（通过自定义 writeFile
 * 回调收集到内存，避免任何磁盘 I/O 副作用）。
 */
function compileAdapterDts(srcFile) {
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

  const program = ts.createProgram([srcFile], writeOptions)

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

  // 找到生成的 d.ts（源文件名去掉 .ts 换成 .d.ts）
  const expected = path.basename(srcFile).replace(/\.ts$/, '.d.ts')
  for (const [name, text] of collected.entries()) {
    if (name.endsWith(expected)) return text
  }
  throw new Error('[fix-dts] generated d.ts not found in compiler output: ' + expected)
}

/**
 * Step 2: 从生成的 d.ts 中抽取指定类的 declare class 块（去掉 imports/export）。
 */
function extractDeclareClass(dtsText, className) {
  const lines = dtsText.split(/\r?\n/)
  const out = []
  let inDeclare = false
  const startRe = new RegExp('^export declare class\\s+' + className + '\\b')
  for (const line of lines) {
    const trimmed = line.trim()
    // 跳过 import
    if (/^import\s/.test(trimmed)) continue
    // 跳过顶层 export declare class 关键字
    if (inDeclare || startRe.test(trimmed)) {
      inDeclare = true
      out.push(line.replace(/^export declare class/, 'declare class'))
      if (trimmed === '}') break
    }
  }

  if (out.length === 0) {
    throw new Error('[fix-dts] declare class not found in generated d.ts: ' + className)
  }
  return out.join('\n') + '\n'
}

/** 组装写入 d.ts 的完整块（注释 + declare class） */
function buildDeclareBlock(adapter) {
  return adapter.doc.concat(extractDeclareClass(compileAdapterDts(adapter.srcFile), adapter.className)).join('\n') + '\n'
}

/**
 * 在 export 列表中按字母序插入类名（所有导出适配器都形如 `XxxAdapter,`）。
 * 找不到合适位置时退化为插到 `adapterRegistry,` 之前。
 */
function insertIntoExportList(exportLine, className) {
  if (new RegExp('\\b' + className + '\\b').test(exportLine)) return exportLine

  const names = [...exportLine.matchAll(/([A-Za-z_$][\w$]*Adapter),/g)]
  for (const match of names) {
    if (match[1] > className) {
      const at = match.index
      return exportLine.slice(0, at) + className + ', ' + exportLine.slice(at)
    }
  }

  // 没有比它大的适配器：插到 adapterRegistry 之前
  const anchor = exportLine.indexOf('adapterRegistry,')
  if (anchor >= 0) {
    return exportLine.slice(0, anchor) + className + ', ' + exportLine.slice(anchor)
  }
  return exportLine
}

/**
 * Step 3: 把 declare block 与类名加入到目标 dts 文件。
 *
 * 处理三种状态：
 *   A. export 列表已含该类名，且 declare class 已存在 → 无需修补
 *   B. export 列表缺该类名 → patch export（declare class 缺则一并补上）
 *   C. 目标文件不存在 / 没有 export 列表 → 返回 false（让 build 报错）
 */
function patchDts(dtsFile, adapter, declareBlock) {
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

  // 3a. 在所有 export 列表里补上类名（已存在则视为已就绪）
  let exportPatched = false
  for (const match of exportMatches) {
    const exportLine = match[0]
    if (new RegExp('\\b' + adapter.className + '\\b').test(exportLine)) {
      exportPatched = true
      continue
    }
    const replaced = insertIntoExportList(exportLine, adapter.className)
    if (replaced !== exportLine) {
      content = content.replace(exportLine, replaced)
      exportPatched = true
    }
  }

  const hasDeclare = new RegExp('^declare\\s+class\\s+' + adapter.className + '\\b', 'm').test(content)

  // 状态 A：都已有 → 无需任何修补
  if (exportPatched && hasDeclare) {
    console.log('[fix-dts] already complete, skipping:', dtsFile)
    return true
  }

  // 状态 C：export 列表里既没有、也插不进去 → 失败（让 build 报错）
  if (!exportPatched) {
    console.error('[fix-dts] WARN: cannot patch ' + adapter.className + ' into', dtsFile)
    return false
  }

  // 3b. declare class 缺失时补上（在最后一个 declare class 之后、export 之前）
  if (!hasDeclare) {
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
  console.log(
    '[fix-dts] patched:',
    dtsFile,
    '(' + adapter.className + ', +' + (content.length - original.length) + ' bytes)',
  )
  return true
}

function main() {
  console.log('[fix-dts] starting post-processing...')

  // 所有适配器的 declare block 一次性生成（顺序与 ADAPTERS 一致，插入时同类幂等）
  const blocks = ADAPTERS.map(adapter => ({ adapter, declareBlock: buildDeclareBlock(adapter) }))

  const targets = [
    path.join(DIST_DIR, 'adapters', 'index.d.ts'),
    path.join(DIST_DIR, 'adapters', 'index.d.mts'),
    path.join(DIST_DIR, 'index.d.ts'),
    path.join(DIST_DIR, 'index.d.mts'),
  ]

  const patchedFiles = new Set()
  for (const file of targets) {
    for (const { adapter, declareBlock } of blocks) {
      if (patchDts(file, adapter, declareBlock)) patchedFiles.add(file)
    }
  }

  console.log('[fix-dts] done, ' + patchedFiles.size + '/' + targets.length + ' files touched')
  return patchedFiles.size
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

module.exports = { main, compileAdapterDts, extractDeclareClass, buildDeclareBlock, patchDts, ADAPTERS }
