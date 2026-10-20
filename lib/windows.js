/**
 * 鲸元额度 · 纯逻辑层
 *
 * 设计要点：
 *  1. 零 DSH 依赖 —— 这个文件不 import 任何框架代码，因此可以用 node 直接跑测试。
 *  2. 时钟可注入 —— 所有函数都接收 now（毫秒），绝不内部调用 Date.now()。
 *     所以"5 小时翻窗""30 天过期"能在毫秒内测完，不需要真的等。
 *
 * 语义对齐 Codex 真实机制：
 *  - primary（5h 窗）：锚定窗 —— 窗内首次消耗时开窗，时长到点后关窗，下次消耗开新窗。
 *  - secondary（周窗）：默认同样锚定；也可固定为「周一 00:00」。
 *  - 鲸元券兑换：两窗已用清零 + 周窗锚点重设为「兑换时刻 + 约 7 天」（官方语义），上限不变。
 */

export const MS = { MINUTE: 60_000, HOUR: 3_600_000, DAY: 86_400_000 }

import { createOfficialState, normalizeOfficialState } from './official.js'
import { createStatsState, normalizeStatsState } from './stats.js'

/** 周窗模式：auto = 锚定（首次消耗开窗）；calendar = 周一 00:00；pinned = 兑换鲸元券后从兑换时刻起算 */
const WEEK_MODE = { AUTO: 'auto', CALENDAR: 'calendar', PINNED: 'pinned' }

export function createState () {
  return {
    version: 1,
    primary: { startAt: null, endAt: null, used: 0 },
    secondary: { startAt: null, endAt: null, used: 0, mode: WEEK_MODE.AUTO },
    vouchers: [],
    lastSeq: {},
    totals: { lifetimeTokens: 0, completions: 0 },
    lastTickAt: null,
    official: createOfficialState(),
    stats: createStatsState(),
  }
}

/** 把任意来源（旧版本文件、手工编辑）的 state 补成完整形状，缺字段不报错 */
export function normalizeState (raw) {
  const base = createState()
  if (!raw || typeof raw !== 'object') return base
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const win = (w, d) => ({
    startAt: typeof w?.startAt === 'number' ? w.startAt : null,
    endAt: typeof w?.endAt === 'number' ? w.endAt : null,
    used: Math.max(0, num(w?.used, 0)),
    ...(d === 'secondary' ? { mode: Object.values(WEEK_MODE).includes(w?.mode) ? w.mode : WEEK_MODE.AUTO } : {}),
  })
  return {
    version: 1,
    primary: win(raw.primary, 'primary'),
    secondary: win(raw.secondary, 'secondary'),
    vouchers: Array.isArray(raw.vouchers) ? raw.vouchers.filter(v => v && typeof v === 'object') : [],
    lastSeq: raw.lastSeq && typeof raw.lastSeq === 'object' ? { ...raw.lastSeq } : {},
    totals: {
      lifetimeTokens: Math.max(0, num(raw.totals?.lifetimeTokens, 0)),
      completions: Math.max(0, num(raw.totals?.completions, 0)),
    },
    lastTickAt: typeof raw.lastTickAt === 'number' ? raw.lastTickAt : null,
    official: normalizeOfficialState(raw.official),
    stats: normalizeStatsState(raw.stats),
  }
}

/** 本周一 00:00（本地时区） */
export function startOfWeekMonday (now) {
  const d = new Date(now)
  const dow = (d.getDay() + 6) % 7 // 周一 = 0
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow, 0, 0, 0, 0).getTime()
}

function rollAnchoredIfExpired (w, now) {
  if (w.endAt !== null && now >= w.endAt) {
    w.startAt = null
    w.endAt = null
    w.used = 0
    return true
  }
  return false
}

function openAnchored (w, now, durationMs) {
  w.startAt = now
  w.endAt = now + durationMs
  w.used = 0
}

/**
 * 推进到 now：关掉已过期的窗、按配置重排周窗锚点。
 * 纯读取式调用（面板/命令查询）也走这里，所以"没消耗时窗也会按时滚动"。
 */
export function ensureWindows (state, now, cfg) {
  rollAnchoredIfExpired(state.primary, now)

  const s = state.secondary
  if (s.mode === WEEK_MODE.CALENDAR) {
    const start = startOfWeekMonday(now)
    const end = start + cfg.weeklyWindowDays * MS.DAY
    if (s.startAt !== start) {
      s.startAt = start
      s.endAt = end
      s.used = 0
    }
  } else {
    if (rollAnchoredIfExpired(s, now)) {
      // 窗滚动后回到配置的锚点模式（PINNED 只维持一轮）
      s.mode = cfg.weekAnchor === 'monday-00:00' ? WEEK_MODE.CALENDAR : WEEK_MODE.AUTO
    }
    if (s.mode === WEEK_MODE.AUTO && cfg.weekAnchor === 'monday-00:00') {
      s.mode = WEEK_MODE.CALENDAR
      s.startAt = null
      s.endAt = null
      s.used = 0
    }
  }

  state.lastTickAt = now
  return state
}

/**
 * 幂等闸门：同一 (sessionId, seq) 只接受一次。
 * session 事件在 resume/replay 时会重放，没有这道闸门会重复计数。
 */
export function shouldAcceptEvent (state, sessionId, seq) {
  if (sessionId == null || seq == null) return true
  const key = String(sessionId)
  const last = state.lastSeq[key]
  if (typeof last === 'number' && Number(seq) <= last) return false
  state.lastSeq[key] = Number(seq)
  return true
}

/** 记一笔消耗：同时作用于 5h 窗与周窗（Codex 里两者是独立计数器，但同一笔消耗同时计入） */
export function addUsage (state, tokens, now, cfg) {
  if (!(tokens > 0)) return state
  ensureWindows(state, now, cfg)

  const p = state.primary
  if (p.endAt === null) openAnchored(p, now, cfg.fiveHourWindowMinutes * MS.MINUTE)

  const s = state.secondary
  if (s.endAt === null) {
    if (s.mode === WEEK_MODE.CALENDAR) {
      const start = startOfWeekMonday(now)
      s.startAt = start
      s.endAt = start + cfg.weeklyWindowDays * MS.DAY
      s.used = 0
    } else {
      openAnchored(s, now, cfg.weeklyWindowDays * MS.DAY)
    }
  }

  p.used += tokens
  s.used += tokens
  state.totals.lifetimeTokens += tokens
  state.totals.completions += 1
  return state
}

export function remainingPercent (limit, used) {
  if (!(limit > 0)) return 1
  return Math.max(0, Math.min(1, 1 - used / limit))
}

export function readStatus (state, now, cfg) {
  ensureWindows(state, now, cfg)
  sweepVouchers(state, now)
  const p = state.primary
  const s = state.secondary
  return {
    primary: {
      label: '5h',
      limit: cfg.fiveHourLimit,
      used: p.used,
      remaining: remainingPercent(cfg.fiveHourLimit, p.used),
      resetsAt: p.endAt,
      open: p.endAt !== null,
    },
    secondary: {
      label: '周',
      limit: cfg.weeklyLimit,
      used: s.used,
      remaining: remainingPercent(cfg.weeklyLimit, s.used),
      resetsAt: s.endAt,
      open: s.endAt !== null,
      mode: s.mode,
    },
    vouchers: {
      available: state.vouchers.filter(v => v.status === 'available').length,
      expired: state.vouchers.filter(v => v.status === 'expired').length,
      redeemed: state.vouchers.filter(v => v.status === 'redeemed').length,
    },
    totals: { ...state.totals },
  }
}

/** 是否超线。注意：只依赖本地 state + cfg，绝不依赖任何远程数据。 */
export function overflowOf (state, now, cfg) {
  const st = readStatus(state, now, cfg)
  const overPrimary = st.primary.used >= cfg.fiveHourLimit
  const overWeekly = st.secondary.used >= cfg.weeklyLimit
  return { over: overPrimary || overWeekly, overPrimary, overWeekly, status: st }
}

/** 过期清扫：到期未用的券标记 expired（30 天这类规则靠注入时钟测，不靠等） */
export function sweepVouchers (state, now) {
  let changed = 0
  for (const v of state.vouchers) {
    if (v.status === 'available' && typeof v.expiresAt === 'number' && now >= v.expiresAt) {
      v.status = 'expired'
      changed += 1
    }
  }
  return changed
}

/** 发一张鲸元券（受 maxHeld 上限约束） */
export function grantVoucher (state, now, cfg, reason = 'manual') {
  sweepVouchers(state, now)
  const held = state.vouchers.filter(v => v.status === 'available').length
  if (held >= cfg.voucher.maxHeld) return { ok: false, reason: 'at-cap', held }
  const voucher = {
    id: `v${now.toString(36)}-${(state.vouchers.length + 1).toString(36)}`,
    grantedAt: now,
    expiresAt: now + cfg.voucher.expiryDays * MS.DAY,
    status: 'available',
    redeemedAt: null,
    reason,
  }
  state.vouchers.push(voucher)
  return { ok: true, voucher, held: held + 1 }
}

/**
 * 兑换一张鲸元券。照抄官方语义：
 *  - 5h 窗与周窗已用一起清零
 *  - 周窗重置日重设为「兑换时刻 + 约 7 天」
 *  - 上限不变（只重置同一个计数器，不提高上限）
 */
export function redeemVoucher (state, now, cfg) {
  sweepVouchers(state, now)
  const v = state.vouchers.find(x => x.status === 'available')
  if (!v) return { ok: false, reason: 'no-voucher' }
  v.status = 'redeemed'
  v.redeemedAt = now

  openAnchored(state.primary, now, cfg.fiveHourWindowMinutes * MS.MINUTE)
  state.secondary.startAt = now
  state.secondary.endAt = now + cfg.weeklyWindowDays * MS.DAY
  state.secondary.used = 0
  state.secondary.mode = WEEK_MODE.PINNED

  return { ok: true, voucher: v }
}

export function formatDuration (ms) {
  if (!(ms > 0)) return '已到点'
  const d = Math.floor(ms / MS.DAY)
  const h = Math.floor((ms % MS.DAY) / MS.HOUR)
  const m = Math.floor((ms % MS.HOUR) / MS.MINUTE)
  if (d > 0) return `${d} 天 ${h} 小时`
  if (h > 0) return `${h} 小时 ${m} 分`
  if (m > 0) return `${m} 分`
  return `${Math.max(1, Math.floor(ms / 1000))} 秒`
}

const pct = n => `${(n * 100).toFixed(1)}%`

/** /quota 命令与日志共用的纯文本渲染 */
export function renderStatusText (state, now, cfg) {
  const st = readStatus(state, now, cfg)
  const lines = []
  const head = st.primary.open ? '' : '（未开窗，下次消耗时起算）'
  lines.push(`鲸元额度 · 5h 剩余 ${pct(st.primary.remaining)}（已用 ${st.primary.used.toLocaleString()} / ${st.primary.limit.toLocaleString()}）`)
  if (st.primary.resetsAt) lines.push(`  重置倒计时：${formatDuration(st.primary.resetsAt - now)}${head}`)
  else lines.push(`  ${head || '等待首次消耗'}`)
  lines.push(`鲸元额度 · 周 剩余 ${pct(st.secondary.remaining)}（已用 ${st.secondary.used.toLocaleString()} / ${st.secondary.limit.toLocaleString()}）`)
  if (st.secondary.resetsAt) lines.push(`  重置倒计时：${formatDuration(st.secondary.resetsAt - now)}（${st.secondary.mode}）`)
  lines.push(`鲸元券：可用 ${st.vouchers.available} 张 · 已兑换 ${st.vouchers.redeemed} · 已过期 ${st.vouchers.expired}`)
  lines.push(`累计：${st.totals.lifetimeTokens.toLocaleString()} tokens / ${st.totals.completions} 笔`)
  lines.push(`执行档位：${cfg.enforcement}｜数据目录：本地`)
  return lines.join('\n')
}
