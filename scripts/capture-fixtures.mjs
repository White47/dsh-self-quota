/**
 * 抓取 codex-reset.com 的公开数据，存成本地 fixture 供单测使用。
 *
 * 用途：让解析器面对"真实响应形状"，而不是我猜的结构。
 * 也顺带验证：本机 Node 能否直连该公开 API。
 *
 * 遵守其使用条款：
 *  - 带可识别的 User-Agent（要求"names the project and a way to reach it"）
 *  - 展示数据时需就地署名 "Data: codex-reset.com"（本脚本只在终端打印）
 */

import fs from 'node:fs'
import path from 'node:path'

const UA = process.env.CODEX_RESET_UA
  || 'dsh-self-quota/0.1.0 (+https://github.com/; fixture capture, contact via repo issues)'
const BASE = process.env.CODEX_RESET_BASE || 'https://codex-reset.com'

const targets = [
  ['timeline-credits.json', `${BASE}/api/timeline?group=credits&limit=12`],
  ['timeline-reset.json', `${BASE}/api/timeline?group=reset&limit=12`],
  ['forecast.json', `${BASE}/api/forecast`],
]

const outDir = path.join(process.cwd(), 'test', 'fixtures')
fs.mkdirSync(outDir, { recursive: true })

for (const [name, url] of targets) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    const text = await res.text()
    console.log(`${name}  HTTP ${res.status}  ${text.length} bytes  <- ${url}`)
    if (res.ok) fs.writeFileSync(path.join(outDir, name), text, 'utf8')
  } catch (error) {
    console.error(`${name}  FAILED: ${error?.message ?? error}`)
    process.exitCode = 1
  }
}
console.log('\nData: codex-reset.com')
