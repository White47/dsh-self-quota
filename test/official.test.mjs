/**
 * 官方节奏源（M4）· 单测
 *
 * fixture 是从 codex-reset.com 真实抓下来的响应（test/fixtures/），
 * 所以解析器面对的是真数据结构，而不是我猜的形状。
 * Data: codex-reset.com
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  normalizeTimeline,
  pickGrantEvents,
  pickResetEvents,
  planOfficial,
  applyOfficial,
  renderOfficialLines,
  normalizeOfficialState,
  ATTRIBUTION,
} from '../lib/official.js'
import { createState, addUsage, overflowOf } from '../lib/windows.js'

const load = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

const credits = load('timeline-credits.json')
const reset = load('timeline-reset.json')
const forecast = load('forecast.json')

const T_FIRST_RUN = Date.parse('2026-10-01T00:00:00.000Z')
const T_NOW = Date.parse('2026-10-14T12:00:00.000Z')

function cfg (official = {}, voucher = {}) {
  return {
    fiveHourLimit: 1_000_000,
    weeklyLimit: 10_000_000,
    fiveHourWindowMinutes: 300,
    weeklyWindowDays: 7,
    weekAnchor: 'first-use',
    voucher: { initial: 0, maxHeld: 3, expiryDays: 30, ...voucher },
    official: {
      source: 'codex-reset.com',
      backfillSince: 'last-30d',
      grantPerOfficialGrant: 1,
      grantOnOfficialReset: 1,
      ...official,
    },
  }
}

function freshState (firstRunAt = T_FIRST_RUN) {
  const s = createState()
  s.official.firstRunAt = firstRunAt
  return s
}

test('真实 fixture：识别出发券标识字段，并挑出 8 条真实发放', () => {
  const t = normalizeTimeline(credits)
  assert.equal(t.events.length, 13, 'fixture 应有 13 条 credits 事件')
  assert.equal(t.grantFlagPresent, true, '真实响应里存在 banked_grant 字段')

  const grants = pickGrantEvents(t)
  assert.equal(grants.length, 8, '其中 8 条是真实发放（其余是生命周期更新，绝不能当发券）')
  for (const g of grants) {
    assert.equal(g.group, 'credits')
    assert.equal(g.bankedGrant, true)
    assert.ok(g.id, '必须有 id 以便去重')
  }
})

test('真实 fixture：重置按 UTC 日去重（同一次重置常有多条公告）', () => {
  const t = normalizeTimeline(reset)
  const announced = t.events.filter(e => e.group === 'reset' && e.announcementState === 'announced')
  const deduped = pickResetEvents(t)

  assert.ok(announced.length > 0, 'fixture 里应有已宣布的重置')
  assert.ok(deduped.length <= announced.length, '去重后不可能变多')
  const days = deduped.map(e => e.day)
  assert.equal(new Set(days).size, days.length, '去重后每一天只应出现一次')
  // fixture 里 2026-10-13 有多条 announced，必然被折叠
  assert.ok(deduped.length < announced.length, '应确实发生了折叠')
})

test('真实 fixture：forecast 摘要标出 experimental，且不做成倒计时', () => {
  const s = freshState()
  const plan = planOfficial(s, { credits, reset, forecast }, T_NOW, cfg())
  const f = plan.forecast
  assert.equal(typeof f.p24, 'number')
  assert.equal(typeof f.p48, 'number')
  assert.equal(f.experimental, true, '上游 confidence_note 自标 experimental，必须照实呈现')
  assert.ok(f.lastResetAt)
  assert.equal(typeof f.medianDays, 'number')
})

test('首次启用：按 backfillSince=last-30d 回溯补发，且受 maxHeld 封顶', () => {
  const s = freshState()
  const c = cfg({}, { maxHeld: 3 })
  const plan = planOfficial(s, { credits, reset, forecast }, T_NOW, c)

  assert.equal(plan.firstFetch, true)
  assert.equal(plan.grantEvents.length, 3, '近 30 天内的真实发放是 3 次（10-07 / 09-29 / 09-22）')

  const report = applyOfficial(s, plan, T_NOW, c)
  assert.equal(report.granted, 3)
  assert.equal(s.vouchers.length, 3)
  assert.ok(s.vouchers.every(v => v.reason === 'official-backfill'), '回溯补发的来源要标清楚')
  assert.equal(s.official.backfilled, true)
})

test('幂等：同一批事件再拉一次，不再重复发券', () => {
  const s = freshState()
  const c = cfg()
  applyOfficial(s, planOfficial(s, { credits, reset, forecast }, T_NOW, c), T_NOW, c)
  const held = s.vouchers.length
  assert.ok(held > 0)

  const plan2 = planOfficial(s, { credits, reset, forecast }, T_NOW + 60_000, c)
  assert.equal(plan2.firstFetch, false)
  assert.equal(plan2.grantEvents.length, 0, '已见过的事件不能再发')
  assert.equal(plan2.markSeenGrantIds.length, 0)

  const report2 = applyOfficial(s, plan2, T_NOW + 60_000, c)
  assert.equal(report2.granted, 0)
  assert.equal(s.vouchers.length, held, '持有量不变')
})

test('全局重置：只认首次运行之后发生的，按日去重，并同时清零两窗 + 按配置加发券', () => {
  const resetPayload = {
    updated_at: 'x',
    events: [
      { id: 'r1', group: 'reset', type: 'reset', announcement_state: 'announced', announced_at: '2026-10-13T05:00:00.000Z', summary: 'day8' },
      { id: 'r2', group: 'reset', type: 'reset', announcement_state: 'announced', announced_at: '2026-10-13T09:00:00.000Z', summary: 'same day, same reset' },
      { id: 'r3', group: 'reset', type: 'reset', announcement_state: 'none', announced_at: '2026-10-13T10:00:00.000Z', summary: 'chatter' },
      { id: 'r4', group: 'reset', type: 'reset', announcement_state: 'announced', announced_at: '2026-09-01T00:00:00.000Z', summary: 'before first run' },
    ],
  }
  const c = cfg({ grantOnOfficialReset: 2 }, { maxHeld: 5 })
  const s = freshState(T_FIRST_RUN)

  // 先消耗掉一些额度，确认重置真的会清零
  addUsage(s, 500_000, T_NOW - 3_600_000, c)
  assert.ok(s.primary.used > 0)

  const plan = planOfficial(s, { credits: { events: [] }, reset: resetPayload }, T_NOW, c)
  assert.equal(plan.resetEvents.length, 1, '同一天的两条公告折叠成一次；早于首次运行的不算；非 announced 不算')

  const report = applyOfficial(s, plan, T_NOW, c)
  assert.equal(report.resets, 1)
  assert.equal(s.primary.used, 0, '跟随官方重置：5h 窗清零')
  assert.equal(s.secondary.used, 0, '跟随官方重置：周窗清零')
  assert.equal(report.grantedByReset, 2, 'grantOnOfficialReset=2 应加发 2 张')
  assert.equal(s.official.lastResetAt, '2026-10-13T05:00:00.000Z')
})

test('降级：上游若不提供发券标识字段，则一张都不发（绝不靠猜）', () => {
  const noFlag = {
    events: [
      { id: 'a', group: 'credits', type: 'credits', announced_at: '2026-10-07T19:19:17.000Z', summary: '某种更新' },
      { id: 'b', group: 'credits', type: 'credits', announced_at: '2026-10-07T23:24:55.000Z', summary: '另一种更新' },
    ],
  }
  const c = cfg()
  const s = freshState()
  const plan = planOfficial(s, { credits: noFlag, reset: { events: [] } }, T_NOW, c)

  assert.equal(plan.grantFlagPresent, false)
  assert.equal(plan.degradeReason, 'grant-flag-absent')
  assert.equal(plan.grantEvents.length, 0, '字段缺失时不能猜着发券')

  const report = applyOfficial(s, plan, T_NOW, c)
  assert.equal(report.granted, 0)
  assert.equal(s.vouchers.length, 0)
  assert.equal(s.official.grantFlagPresent, false, '要落账这个降级事实，供界面提示')
})

test('结构性保证：锁定判定完全不读官方状态（远程不可能导致误锁）', () => {
  const c = cfg()
  const s = createState()
  addUsage(s, 1_000_000, T_NOW, c)
  assert.equal(overflowOf(s, T_NOW, c).over, true, '先确认已超线')

  // 把 official 灌成垃圾、并把 lastError 设成吓人的内容，超线结论不应受任何影响
  s.official = { garbage: true, lastError: 'network down', source: 'codex-reset.com' }
  const after = overflowOf(s, T_NOW, c)
  assert.equal(after.over, true, '官方状态与锁定判定必须完全解耦')

  s.official = normalizeOfficialState(undefined)
  assert.equal(overflowOf(s, T_NOW, c).over, true)
})

test('展示：官方节奏行必须带署名，且失败/降级要如实提示', () => {
  const s = freshState()
  const c = cfg()
  applyOfficial(s, planOfficial(s, { credits, reset, forecast }, T_NOW, c), T_NOW, c)

  let lines = renderOfficialLines(s, T_NOW).join('\n')
  assert.match(lines, /官方节奏源：codex-reset\.com/)
  assert.match(lines, new RegExp(ATTRIBUTION.replace('.', '\\.')), '展示处必须就地署名')
  assert.match(lines, /experimental/, '概率必须标注 experimental')

  // 未启用时不出现署名（没有数据就没有署名义务）
  const idle = createState()
  assert.doesNotMatch(renderOfficialLines(idle, T_NOW).join('\n'), /Data: codex-reset\.com/)

  // 失败要如实说，并说明已 fail-open
  s.official.lastError = 'HTTP 503'
  lines = renderOfficialLines(s, T_NOW).join('\n')
  assert.match(lines, /HTTP 503/)
  assert.match(lines, /fail-open/)
})
