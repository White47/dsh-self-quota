/**
 * 开发工具：打印 fixture 里每条事件的关键字段，确认解析器面对的真实形状。
 * Data: codex-reset.com
 */

import fs from 'node:fs'
import path from 'node:path'

const dir = path.join(process.cwd(), 'test', 'fixtures')

for (const name of ['timeline-credits.json', 'timeline-reset.json']) {
  const file = path.join(dir, name)
  if (!fs.existsSync(file)) { console.log(`${name}: 缺失`); continue }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const events = data.events ?? []
  console.log(`\n=== ${name} — ${events.length} 条 ===`)
  console.log(`顶层字段: ${Object.keys(data).join(', ')}`)
  const keys = new Set()
  for (const e of events) Object.keys(e).forEach(k => keys.add(k))
  console.log(`事件字段: ${[...keys].sort().join(', ')}`)
  for (const e of events.slice(0, 12)) {
    console.log(
      `  ${String(e.date ?? '?')} | group=${e.group} | state=${e.announcement_state} `
      + `| banked_grant=${e.banked_grant} | banked_state=${e.banked_state} `
      + `| id=${e.id} | ${String(e.summary ?? '').slice(0, 56)}`,
    )
  }
  if (data.rhythm) console.log(`  rhythm: ${JSON.stringify(data.rhythm).slice(0, 160)}`)
}

const fc = path.join(dir, 'forecast.json')
if (fs.existsSync(fc)) {
  const f = JSON.parse(fs.readFileSync(fc, 'utf8'))
  console.log('\n=== forecast.json ===')
  console.log(`  keys: ${Object.keys(f).join(', ')}`)
  console.log(`  probabilities: ${JSON.stringify(f.probabilities)}`)
  console.log(`  confidence=${f.confidence} last_reset_at=${f.last_reset_at} age_days=${f.age_days}`)
  console.log(`  official_signal=${JSON.stringify(f.official_signal)} cadence=${JSON.stringify(f.cadence)}`)
  console.log(`  time_window=${JSON.stringify(f.time_window)}`)
}
