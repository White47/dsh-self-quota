/**
 * M4 端到端探针：拉真实的 codex-reset.com 数据 → 解析 → 计划 → 执行（在临时 state 上）
 *
 * 用途：不开 app、不改动真实存档，就验证"跟随官方节奏发券"这条链路对真实数据是否成立。
 *
 * Data: codex-reset.com
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import { createState } from '../lib/windows.js'
import { planOfficial, applyOfficial, pickGrantEvents, pickResetEvents, normalizeTimeline } from '../lib/official.js'

const BASE = process.env.CODEX_RESET_BASE || 'https://codex-reset.com'
const UA = process.env.CODEX_RESET_UA
  || 'dsh-self-quota/0.2.0 (+https://github.com/; probe, contact via repo issues)'

const cfg = {
  fiveHourLimit: 2_000_000,
  weeklyLimit: 15_000_000,
  fiveHourWindowMinutes: 300,
  weeklyWindowDays: 7,
  weekAnchor: 'first-use',
  voucher: { initial: 0, maxHeld: 3, expiryDays: 30 },
  official: {
    source: 'codex-reset.com',
    backfillSince: process.env.BACKFILL || 'last-30d',
    grantPerOfficialGrant: 1,
    grantOnOfficialReset: 1,
  },
}

async function get (pathAndQuery) {
  const res = await fetch(`${BASE}${pathAndQuery}`, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${pathAndQuery}`)
  return res.json()
}

console.log(`拉取 ${BASE} …`)
const [credits, reset, forecast] = await Promise.all([
  get('/api/timeline?group=credits&limit=12'),
  get('/api/timeline?group=reset&limit=24'),
  get('/api/forecast'),
])

const tCredits = normalizeTimeline(credits)
const tReset = normalizeTimeline(reset)
console.log(`\n[解析] credits 事件 ${tCredits.events.length} 条，其中真实发放 ${pickGrantEvents(tCredits).length} 条`)
console.log(`       发券标识字段存在: ${tCredits.grantFlagPresent}`)
console.log(`       reset 事件 ${tReset.events.length} 条，去重后已宣布重置 ${pickResetEvents(tReset).length} 次`)

const now = Date.now()
const state = createState()
state.official.firstRunAt = now - 7 * 86_400_000 // 模拟"插件已运行 7 天"
const plan = planOfficial(state, { credits, reset, forecast }, now, cfg)

console.log(`\n[计划] 首次拉取=${plan.firstFetch}（模拟已运行 7 天 → 只应补发这期间的）`)
console.log(`       本应发券 ${plan.grantEvents.length} 张，清零窗 ${plan.resetEvents.length} 次`)
for (const e of plan.grantEvents) console.log(`         · ${e.announcedAt?.slice(0, 10)}  ${e.summary.slice(0, 70)}`)
for (const e of plan.resetEvents) console.log(`         ↺ ${e.announcedAt?.slice(0, 10)}  ${e.summary.slice(0, 70)}`)

const report = applyOfficial(state, plan, now, cfg)
console.log(`\n[执行] 实际发券 ${report.granted} 张（回溯 ${report.grantedByBackfill} / 重置 ${report.grantedByReset}），`
  + `受上限拦下 ${report.capped}，清窗 ${report.resets} 次${report.degraded ? `，降级：${report.degraded}` : ''}`)
console.log(`       持有鲸元券 ${state.vouchers.filter(v => v.status === 'available').length} 张（maxHeld=${cfg.voucher.maxHeld}）`)

const f = state.official.forecast
console.log(`\n[官方节奏] 最近重置 ${String(state.official.lastResetAt).slice(0, 16)}`)
console.log(`           24h 概率 ${f?.p24}% / 48h ${f?.p48}%${f?.experimental ? '（experimental，不是倒计时）' : ''}`)
console.log(`           近期典型间隔 约 ${f?.medianDays} 天；常见窗口 ${f?.windowLabel} UTC`)

// 幂等复核：立刻再拉一次，必须 0 新增
const plan2 = planOfficial(state, { credits, reset, forecast }, now + 1000, cfg)
console.log(`\n[幂等] 再拉一次 → 新增发券 ${plan2.grantEvents.length} 张（必须为 0）`)

const tmp = path.join(os.tmpdir(), 'dsh-self-quota-probe.json')
fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
console.log(`\n样例存档（临时）: ${tmp}`)
console.log('\nData: codex-reset.com')
