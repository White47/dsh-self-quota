/**
 * 从 app.asar 里直接读取/列出文件（只读，不落盘解包）。
 *
 * 用途：DSH 把 `@deepseek-ai/*` 全部打包进 app.asar，想读某个包的 README 或实现
 * （例如确认 `settings.describe()` 只含 volatile 字段、`configEditor.edit()` 的契约）时，
 * 普通文件工具看不到，这个脚本能直接按路径取出来。
 *
 * 用法：
 *   node scripts/asar-peek.mjs list [关键词]
 *   node scripts/asar-peek.mjs cat <asar 内路径>
 *
 * asar 路径来源（按优先级）：--asar <路径> → 环境变量 DSH_ASAR → 自动探测常见安装位置。
 */
import fs from 'node:fs'
import path from 'node:path'

const CANDIDATES = [
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
  path.join(process.env.PROGRAMFILES || '', 'DeepSeek Harness', 'resources', 'app.asar'),
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
  '/opt/DeepSeek Harness/resources/app.asar',
  '/usr/lib/deepseek-harness/resources/app.asar',
].filter(Boolean)

function parseArgs (argv) {
  const i = argv.indexOf('--asar')
  if (i >= 0 && argv[i + 1]) {
    const rest = argv.slice()
    rest.splice(i, 2)
    return { asarPath: argv[i + 1], rest }
  }
  if (process.env.DSH_ASAR) return { asarPath: process.env.DSH_ASAR, rest: argv }
  const found = CANDIDATES.find(candidate => fs.existsSync(candidate))
  if (!found) {
    console.error('找不到 app.asar。请用 --asar <路径> 或设置环境变量 DSH_ASAR。')
    console.error('尝试过：\n  ' + CANDIDATES.join('\n  '))
    process.exit(1)
  }
  return { asarPath: found, rest: argv }
}

/** asar 结构：8 字节 pickle 头 → JSON 文件表 → 紧跟文件数据 */
function openAsar (asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const headerPickleSize = head.readUInt32LE(4)
  const headerStringLength = head.readUInt32LE(12)
  const buffer = Buffer.alloc(headerStringLength)
  fs.readSync(fd, buffer, 0, headerStringLength, 16)
  return { fd, header: JSON.parse(buffer.toString('utf8')), base: 8 + headerPickleSize }
}

function walk (node, prefix, out) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (child.files) walk(child, p, out)
    else out.push({ path: p, size: Number(child.size), offset: Number(child.offset) })
  }
  return out
}

const { asarPath, rest } = parseArgs(process.argv.slice(2))
const [cmd, arg] = rest
const { fd, header, base } = openAsar(asarPath)
const files = walk(header, '', [])

if (cmd === 'list') {
  const keyword = (arg || '').toLowerCase()
  let shown = 0
  for (const file of files) {
    if (keyword && !file.path.toLowerCase().includes(keyword)) continue
    console.log(`${String(file.size).padStart(9)}  ${file.path}`)
    shown += 1
  }
  console.error(`\n匹配 ${shown} / 共 ${files.length} 个文件（asar: ${asarPath}）`)
} else if (cmd === 'cat') {
  const wanted = String(arg || '').replace(/\\/g, '/')
  const entry = files.find(file => file.path === wanted)
  if (!entry) {
    console.error(`找不到：${wanted}`)
    process.exit(1)
  }
  const buffer = Buffer.alloc(entry.size)
  fs.readSync(fd, buffer, 0, entry.size, base + entry.offset)
  process.stdout.write(buffer.toString('utf8'))
} else {
  console.error('用法：')
  console.error('  node scripts/asar-peek.mjs [--asar <路径>] list [关键词]')
  console.error('  node scripts/asar-peek.mjs [--asar <路径>] cat <asar 内路径>')
  process.exit(1)
}
