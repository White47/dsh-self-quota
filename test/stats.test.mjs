/**
 * 用量统计 · 单测
 *
 * 全部用注入时钟，所以"连续 12 天""跨月跨年""400 天上限"都在毫秒内测完。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  dayKey,
  shiftDay,
  recordUsage,
  computeStats,
  normalizeStatsState,
  createStatsState,
  LIMITS,
} from '../lib/stats.js'
import { createState } from '../lib/windows.js'

/** 造一个"某天某时"的时间戳（本地时区，和 dayKey 一致） */
function at (y, m, d, h = 12, min = 0) {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime()
}

test('dayKey：用本地日历日，跨时区不会串天', () => {
  assert.equal(dayKey(at(2026, 10, 14)), '2026-10-14')
  assert.equal(dayKey(at(2026, 1, 1, 0, 0)), '2026-01-01')
  // 当天 23:59 仍算当天
  assert.equal(dayKey(at(2026, 3, 9, 23, 59)), '2026-03-09')
})

test('shiftDay：跨月、跨年、闰年都不出错', () => {
  assert.equal(shiftDay('2026-10-14', -1), '2026-10-13')
  assert.equal(shiftDay('2026-11-01', -1), '2026-10-31')
  assert.equal(shiftDay('2027-01-01', -1), '2026-12-31')
  assert.equal(shiftDay('2028-03-01', -1), '2028-02-29', '2028 是闰年')
  assert.equal(shiftDay('2026-02-28', 1), '2026-03-01')
})

test('recordUsage：按天聚合，并维护会话首末时间', () => {
  const state = createState()
  const t1 = at(2026, 10, 14, 9)
  const t2 = at(2026, 10, 14, 11)
  const t3 = at(2026, 10, 15, 10)

  recordUsage(state, 100, t1, 'sess-A')
  recordUsage(state, 50, t2, 'sess-A')
  recordUsage(state, 30, t3, 'sess-B')
  recordUsage(state, 0, t3, 'sess-B') // 0 不记
  recordUsage(state, -5, t3, 'sess-B') // 负数不记

  assert.deepEqual(state.stats.daily['2026-10-14'], { tokens: 150, completions: 2 })
  assert.deepEqual(state.stats.daily['2026-10-15'], { tokens: 30, completions: 1 })
  assert.deepEqual(state.stats.sessions['sess-A'], { firstAt: t1, lastAt: t2, tokens: 150 })
  assert.deepEqual(state.stats.sessions['sess-B'], { firstAt: t3, lastAt: t3, tokens: 30 })

  // 乱序到达也要能收敛到正确跨度
  recordUsage(state, 10, at(2026, 10, 14, 8), 'sess-A')
  assert.equal(state.stats.sessions['sess-A'].firstAt, at(2026, 10, 14, 8), '更早的时间要顶上去')
})

test('computeStats：今日 / 近 7 天 / 近 30 天 / 峰值 / 活跃天数', () => {
  const state = createState()
  const today = at(2026, 10, 14)
  recordUsage(state, 100, today, 's1')
  recordUsage(state, 200, at(2026, 10, 13), 's1')
  recordUsage(state, 999, at(2026, 10, 1), 's2')  // 13 天前 → 进近 30 天，不进近 7 天
  recordUsage(state, 500, at(2026, 8, 1), 's3')   // 很久以前 → 都不进

  const s = computeStats(state, today, 60)
  assert.equal(s.today, 100)
  assert.equal(s.last7, 300, '今天 + 昨天（10-1 早于 7 天窗口）')
  assert.equal(s.last30, 300 + 999)
  assert.equal(s.peak, 999)
  assert.equal(s.peakDay, '2026-10-01')
  assert.equal(s.activeDays, 4)
  assert.equal(s.series.length, 60, '序列长度按请求返回')
  assert.equal(s.series[s.series.length - 1].day, '2026-10-14', '最后一个点必须是今天')
})

test('computeStats：连续天数（今天有记录 vs 今天空着）', () => {
  const state = createState()
  // 10-01 起，连续 4 天
  for (const d of [1, 2, 3, 4]) recordUsage(state, 10, at(2026, 10, d), `s${d}`)

  // 站在 10-04：当前连续 = 4，最长 = 4
  let s = computeStats(state, at(2026, 10, 4, 20), 30)
  assert.equal(s.currentStreak, 4)
  assert.equal(s.longestStreak, 4)

  // 站在 10-05（今天还没用）：从昨天起算，连续仍然是 4 —— 一睁眼不该归零
  s = computeStats(state, at(2026, 10, 5, 8), 30)
  assert.equal(s.currentStreak, 4, '今天还没用，应从昨天起算')

  // 站在 10-06（昨天也没用）：连续归零
  s = computeStats(state, at(2026, 10, 6, 8), 30)
  assert.equal(s.currentStreak, 0)
  assert.equal(s.longestStreak, 4, '最长连续不受影响')

  // 再造一段更长的：10-10 ~ 10-16 共 7 天
  for (let d = 10; d <= 16; d += 1) recordUsage(state, 10, at(2026, 10, d), `x${d}`)
  s = computeStats(state, at(2026, 10, 16, 20), 30)
  assert.equal(s.currentStreak, 7)
  assert.equal(s.longestStreak, 7)
})

test('computeStats：跨月连续性（10-31 → 11-01 必须算连续）', () => {
  const state = createState()
  recordUsage(state, 10, at(2026, 10, 30), 'a')
  recordUsage(state, 10, at(2026, 10, 31), 'b')
  recordUsage(state, 10, at(2026, 11, 1), 'c')
  const s = computeStats(state, at(2026, 11, 1, 20), 30)
  assert.equal(s.currentStreak, 3)
  assert.equal(s.longestStreak, 3)
})

test('computeStats：最长任务用时 = 会话首末跨度', () => {
  const state = createState()
  recordUsage(state, 10, at(2026, 10, 14, 9, 0), 'short')
  recordUsage(state, 10, at(2026, 10, 14, 9, 10), 'short')

  recordUsage(state, 10, at(2026, 10, 14, 8, 0), 'long')
  recordUsage(state, 10, at(2026, 10, 14, 9, 43), 'long') // 1 小时 43 分

  const s = computeStats(state, at(2026, 10, 14, 10), 30)
  assert.equal(s.longestTaskMs, 103 * 60_000, '1 小时 43 分')
  assert.equal(s.sessions, 2)
})

test('体积上限：天数与会话数都会被裁剪到上限内', () => {
  const state = createState()
  // 造 450 天
  let t = at(2026, 1, 1)
  for (let i = 0; i < 450; i += 1) {
    recordUsage(state, 1, t, `s-${i}`)
    t += 86_400_000
  }
  assert.ok(Object.keys(state.stats.daily).length <= LIMITS.days, `天数应 ≤ ${LIMITS.days}`)
  assert.ok(Object.keys(state.stats.sessions).length <= LIMITS.sessions, `会话数应 ≤ ${LIMITS.sessions}`)
  // 裁掉的是最旧的，最近的必须还在
  const keys = Object.keys(state.stats.daily).sort()
  assert.equal(keys[keys.length - 1], dayKey(t - 86_400_000))
})

test('normalizeStatsState：脏数据不抛异常，且形状补齐', () => {
  assert.deepEqual(normalizeStatsState(null), createStatsState())
  assert.deepEqual(normalizeStatsState('garbage'), createStatsState())
  assert.deepEqual(normalizeStatsState({ daily: { 'not-a-day': { tokens: 5 } } }).daily, {}, '非法日期键被丢弃')

  const s = normalizeStatsState({
    daily: { '2026-10-14': { tokens: -5, completions: 'x' }, '2026-10-15': { tokens: 12.7 } },
    sessions: { a: { firstAt: 100, lastAt: 50, tokens: 3 }, b: null, c: { firstAt: 'x' } },
  })
  assert.deepEqual(s.daily['2026-10-14'], { tokens: 0, completions: 0 }, '负数被夹到 0')
  assert.equal(s.daily['2026-10-15'].tokens, 13, '小数取整')
  assert.equal(s.sessions.a.lastAt, 100, 'lastAt 不得早于 firstAt')
  assert.equal(s.sessions.b, undefined, '空会话被丢弃')
  assert.equal(s.sessions.c, undefined, '时间非法的会话被丢弃')
})

test('向后兼容：老存档没有 stats 字段时，normalizeState 会补出来且不报错', () => {
  const state = createState()
  delete state.stats
  const s = computeStats(state, at(2026, 10, 14), 7)
  assert.equal(s.lifetime, 0)
  assert.equal(s.series.length, 7)
  assert.equal(s.currentStreak, 0)
})
