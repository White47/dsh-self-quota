/**
 * 鲸元额度 · 纯逻辑单测
 *
 * 全部用注入时钟 + 极短窗口，所以"5 小时翻窗""30 天过期"在毫秒内跑完 —— 不靠等。
 * 运行：node --test test/   （或 npm test）
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createState,
  normalizeState,
  addUsage,
  shouldAcceptEvent,
  readStatus,
  overflowOf,
  grantVoucher,
  redeemVoucher,
  sweepVouchers,
  remainingPercent,
  startOfWeekMonday,
  formatDuration,
  renderStatusText,
  MS,
} from '../lib/windows.js'

const T0 = 1_700_000_000_000 // 固定基准时刻，测试可复现

function cfg (over = {}) {
  return {
    fiveHourLimit: 1000,
    weeklyLimit: 5000,
    fiveHourWindowMinutes: 300,
    weeklyWindowDays: 7,
    weekAnchor: 'first-use',
    voucher: { initial: 1, maxHeld: 3, expiryDays: 30 },
    ...over,
  }
}

test('5h 窗：首次消耗才开窗，到点自动关窗，下次消耗开新窗', () => {
  const c = cfg({ fiveHourWindowMinutes: 1 })
  const s = createState()

  // 未消耗时不开窗
  let st = readStatus(s, T0, c)
  assert.equal(st.primary.open, false)
  assert.equal(st.primary.remaining, 1, '未开窗应显示 100% 剩余')

  // 首次消耗开窗
  addUsage(s, 200, T0, c)
  st = readStatus(s, T0, c)
  assert.equal(st.primary.open, true)
  assert.equal(st.primary.used, 200)
  assert.equal(st.primary.resetsAt, T0 + 1 * MS.MINUTE)

  // 同一窗内继续消耗，锚点不变
  addUsage(s, 300, T0 + 30_000, c)
  st = readStatus(s, T0 + 30_000, c)
  assert.equal(st.primary.used, 500)
  assert.equal(st.primary.resetsAt, T0 + 1 * MS.MINUTE, '锚点不应被后续消耗推迟')

  // 到点后关窗
  st = readStatus(s, T0 + 1 * MS.MINUTE, c)
  assert.equal(st.primary.open, false)
  assert.equal(st.primary.used, 0, '窗滚动后已用清零')

  // 下次消耗开新窗
  addUsage(s, 50, T0 + 1 * MS.MINUTE + 1, c)
  st = readStatus(s, T0 + 1 * MS.MINUTE + 1, c)
  assert.equal(st.primary.open, true)
  assert.equal(st.primary.used, 50)
  assert.equal(st.primary.resetsAt, T0 + 2 * MS.MINUTE + 1)
})

test('周窗（锚定）：独立滚动，且与 5h 窗互不影响', () => {
  const c = cfg({ fiveHourWindowMinutes: 1, weeklyWindowDays: 7 })
  const s = createState()
  addUsage(s, 1000, T0, c)
  assert.equal(s.secondary.endAt, T0 + 7 * MS.DAY)

  // 5h 窗已滚过好几轮，周窗仍应保留累计
  let st = readStatus(s, T0 + 3 * MS.HOUR, c)
  assert.equal(st.primary.used, 0)
  assert.equal(st.secondary.used, 1000, '周窗跨过 5h 翻窗不应清零')

  // 周窗到点才清零
  st = readStatus(s, T0 + 7 * MS.DAY, c)
  assert.equal(st.secondary.used, 0)
  assert.equal(st.secondary.open, false)
})

test('周窗（周一 00:00）：对齐到本周一零点，且整周内不再漂移', () => {
  const c = cfg({ weekAnchor: 'monday-00:00' })
  const s = createState()
  const wednesday = new Date(2026, 9, 14, 15, 30, 0, 0).getTime() // 2026-10-14 周三
  addUsage(s, 100, wednesday, c)

  const monday = startOfWeekMonday(wednesday)
  assert.equal(s.secondary.startAt, monday)
  assert.equal(s.secondary.endAt, monday + 7 * MS.DAY)
  assert.equal(new Date(monday).getDay(), 1, '周一')

  // 同周内多次消耗不改变锚点
  addUsage(s, 100, wednesday + MS.DAY, c)
  assert.equal(s.secondary.startAt, monday)

  // 跨到下周一则重排
  const nextMonday = monday + 7 * MS.DAY
  readStatus(s, nextMonday, c)
  assert.equal(s.secondary.startAt, nextMonday)
  assert.equal(s.secondary.used, 0)
})

test('幂等：(sessionId, seq) 重放不重复计数', () => {
  const s = createState()
  assert.equal(shouldAcceptEvent(s, 'sess-1', 10), true)
  assert.equal(shouldAcceptEvent(s, 'sess-1', 11), true)
  assert.equal(shouldAcceptEvent(s, 'sess-1', 11), false, '同一 seq 必须拒绝')
  assert.equal(shouldAcceptEvent(s, 'sess-1', 9), false, '更旧的 seq 必须拒绝')
  assert.equal(shouldAcceptEvent(s, 'sess-2', 1), true, '不同会话各自独立')
  // 缺少标识时不拦
  assert.equal(shouldAcceptEvent(s, null, null), true)
})

test('鲸元券：兑换 = 两窗清零 + 周窗锚点重设为约 7 天后 + 上限不变', () => {
  const c = cfg({ fiveHourWindowMinutes: 300, weeklyWindowDays: 7 })
  const s = createState()
  grantVoucher(s, T0, c, 'initial')
  addUsage(s, 900, T0, c) // 两窗都接近上限

  const tR = T0 + 10 * MS.MINUTE
  const before = { fiveHourLimit: c.fiveHourLimit, weeklyLimit: c.weeklyLimit }
  const r = redeemVoucher(s, tR, c)
  assert.equal(r.ok, true)

  const st = readStatus(s, tR, c)
  assert.equal(st.primary.used, 0, '5h 窗清零')
  assert.equal(st.secondary.used, 0, '周窗清零')
  assert.equal(st.primary.resetsAt, tR + 5 * MS.HOUR)
  assert.equal(st.secondary.resetsAt, tR + 7 * MS.DAY, '周窗重置日 = 兑换时刻 + 约 7 天')
  assert.equal(c.fiveHourLimit, before.fiveHourLimit, '上限不变')
  assert.equal(c.weeklyLimit, before.weeklyLimit, '上限不变')
  assert.equal(st.vouchers.redeemed, 1)
  assert.equal(st.vouchers.available, 0)

  // 兑换后的周窗是 pinned：即使配置是周一锚点，也不会立刻被拉回日历周
  const c2 = cfg({ weekAnchor: 'monday-00:00' })
  const s2 = createState()
  grantVoucher(s2, T0, c2, 'initial')
  const tR2 = startOfWeekMonday(T0) + 3 * MS.DAY // 周三兑换
  redeemVoucher(s2, tR2, c2)
  const st2 = readStatus(s2, tR2 + MS.HOUR, c2)
  assert.equal(st2.secondary.resetsAt, tR2 + 7 * MS.DAY, 'pinned 周窗不被日历锚点覆盖')
})

test('鲸元券：30 天整边界过期（注入时钟跳 30 天，不靠等）', () => {
  const c = cfg({ voucher: { initial: 0, maxHeld: 3, expiryDays: 30 } })
  const s = createState()
  const g = grantVoucher(s, T0, c, 'official-grant')
  assert.equal(g.ok, true)
  assert.equal(g.voucher.expiresAt, T0 + 30 * MS.DAY)

  assert.equal(sweepVouchers(s, T0 + 30 * MS.DAY - 1), 0, '差 1ms 不该过期')
  assert.equal(s.vouchers[0].status, 'available')

  assert.equal(sweepVouchers(s, T0 + 30 * MS.DAY), 1, '正好到点即过期')
  assert.equal(s.vouchers[0].status, 'expired')

  // 过期券不可兑换
  assert.equal(redeemVoucher(s, T0 + 31 * MS.DAY, c).ok, false)
})

test('鲸元券：maxHeld 上限，超额发放被拒', () => {
  const c = cfg({ voucher: { initial: 0, maxHeld: 2, expiryDays: 30 } })
  const s = createState()
  assert.equal(grantVoucher(s, T0, c, 'a').ok, true)
  assert.equal(grantVoucher(s, T0, c, 'b').ok, true)
  const third = grantVoucher(s, T0, c, 'c')
  assert.equal(third.ok, false)
  assert.equal(third.reason, 'at-cap')
  assert.equal(readStatus(s, T0, c).vouchers.available, 2)
})

test('剩余百分比：边界与超额不出现负数', () => {
  assert.equal(remainingPercent(1000, 0), 1)
  assert.equal(remainingPercent(1000, 500), 0.5)
  assert.equal(remainingPercent(1000, 1000), 0)
  assert.equal(remainingPercent(1000, 5000), 0, '超额不能是负数')
  assert.equal(remainingPercent(0, 10), 1, '上限为 0 时不应除零')
})

test('超线判定只看本地 state：5h 或 周 任一超线即算超', () => {
  const c = cfg({ fiveHourLimit: 100, weeklyLimit: 1000, fiveHourWindowMinutes: 1 })
  const s = createState()
  assert.equal(overflowOf(s, T0, c).over, false)

  addUsage(s, 100, T0, c)
  let w = overflowOf(s, T0, c)
  assert.equal(w.over, true)
  assert.equal(w.overPrimary, true)
  assert.equal(w.overWeekly, false)

  // 5h 窗滚动走后不再超线
  w = overflowOf(s, T0 + 1 * MS.MINUTE, c)
  assert.equal(w.over, false)

  // 只把周窗顶满（5h 窗反复滚动）
  const s2 = createState()
  for (let i = 0; i < 10; i += 1) addUsage(s2, 100, T0 + i * 2 * MS.MINUTE, c)
  w = overflowOf(s2, T0 + 19 * MS.MINUTE, c)
  assert.equal(w.overWeekly, true)
  assert.equal(w.over, true)
})

test('normalizeState：残缺/损坏的存档不会抛异常，且补齐形状', () => {
  assert.deepEqual(normalizeState(null), createState())
  assert.deepEqual(normalizeState('garbage'), createState())
  const s = normalizeState({ primary: { used: -5 }, vouchers: [null, { id: 'x' }], totals: { lifetimeTokens: 'NaN' } })
  assert.equal(s.primary.used, 0, '负数被夹到 0')
  assert.equal(s.vouchers.length, 1, '垃圾条目被过滤')
  assert.equal(s.totals.lifetimeTokens, 0)
  assert.equal(s.secondary.mode, 'auto')
})

test('formatDuration / renderStatusText：可读输出不抛异常', () => {
  assert.equal(formatDuration(0), '已到点')
  assert.equal(formatDuration(90 * MS.MINUTE), '1 小时 30 分')
  assert.equal(formatDuration(2 * MS.DAY + 3 * MS.HOUR), '2 天 3 小时')

  const c = cfg()
  const s = createState()
  addUsage(s, 500, T0, c)
  const text = renderStatusText(s, T0, c)
  assert.match(text, /鲸元额度 · 5h 剩余 50\.0%/)
  assert.match(text, /鲸元额度 · 周 剩余 90\.0%/)
  assert.match(text, /鲸元券：可用 0 张/)
})
