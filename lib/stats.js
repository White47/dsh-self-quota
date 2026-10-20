/**
 * 鲸元额度 · 用量统计（纯逻辑层）
 *
 * 我们只在本地存两类事实：
 *  - daily   ：按「本地日历日」聚合的 tokens / 笔数
 *  - sessions：每个会话的首末消耗时间与总量（用来算"最长任务用时"）
 * 其余指标（峰值、连续天数、近 7/30 天）都由这两类事实现算，避免存冗余状态。
 *
 * 零 DSH 依赖、时钟可注入 —— 所以"连续 12 天""跨月跨年"这类边界都能秒级测完。
 */

const DAY = 86_400_000

/** 本地日历日的 key：YYYY-MM-DD（用本地时区，和用户看到的"今天"一致） */
export function dayKey (ts) {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** dayKey ± n 天（用日期分量做减法，自动跨月跨年） */
export function shiftDay (key, delta) {
  const [y, m, d] = key.split('-').map(Number)
  return dayKey(new Date(y, m - 1, d + delta, 12, 0, 0, 0).getTime())
}

export const LIMITS = { days: 400, sessions: 200 }

export function createStatsState () {
  return { daily: {}, sessions: {} }
}

export function normalizeStatsState (raw) {
  const out = createStatsState()
  if (!raw || typeof raw !== 'object') return out

  const daily = raw.daily && typeof raw.daily === 'object' ? raw.daily : {}
  for (const [key, value] of Object.entries(daily)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue
    const tokens = Number(value && value.tokens)
    const completions = Number(value && value.completions)
    out.daily[key] = {
      tokens: Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : 0,
      completions: Number.isFinite(completions) && completions > 0 ? Math.round(completions) : 0,
    }
  }

  const sessions = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {}
  for (const [id, value] of Object.entries(sessions)) {
    if (!id || !value || typeof value !== 'object') continue
    const firstAt = Number(value.firstAt)
    const lastAt = Number(value.lastAt)
    const tokens = Number(value.tokens)
    if (!Number.isFinite(firstAt) || !Number.isFinite(lastAt)) continue
    out.sessions[id] = {
      firstAt,
      lastAt: Math.max(firstAt, lastAt),
      tokens: Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : 0,
    }
  }

  return trimStats(out)
}

/** 控制体积：天数与会话数都留最近的一批，避免存档无限膨胀 */
export function trimStats (stats) {
  const dayKeys = Object.keys(stats.daily).sort()
  if (dayKeys.length > LIMITS.days) {
    for (const key of dayKeys.slice(0, dayKeys.length - LIMITS.days)) delete stats.daily[key]
  }
  const sessionIds = Object.keys(stats.sessions)
  if (sessionIds.length > LIMITS.sessions) {
    sessionIds
      .sort((a, b) => stats.sessions[a].lastAt - stats.sessions[b].lastAt)
      .slice(0, sessionIds.length - LIMITS.sessions)
      .forEach(id => { delete stats.sessions[id] })
  }
  return stats
}

/** 记一笔消耗：同时更新当日聚合与该会话的首末时间 */
export function recordUsage (state, tokens, now, sessionId) {
  if (!(tokens > 0)) return state
  const stats = state.stats || (state.stats = createStatsState())

  const key = dayKey(now)
  const cell = stats.daily[key] || (stats.daily[key] = { tokens: 0, completions: 0 })
  cell.tokens += tokens
  cell.completions += 1

  if (sessionId != null) {
    const id = String(sessionId)
    const session = stats.sessions[id] || (stats.sessions[id] = { firstAt: now, lastAt: now, tokens: 0 })
    if (now < session.firstAt) session.firstAt = now
    if (now > session.lastAt) session.lastAt = now
    session.tokens += tokens
  }

  return trimStats(stats)
}

/**
 * 现算统计。
 * @param days 返回的每日序列长度（默认 60，客户端只用其中近 30 天）
 */
export function computeStats (state, now, days = 60) {
  const stats = state.stats || createStatsState()
  const daily = stats.daily

  let peak = 0
  let peakDay = null
  let activeDays = 0
  for (const key of Object.keys(daily)) {
    const tokens = daily[key].tokens
    if (tokens <= 0) continue
    activeDays += 1
    if (tokens > peak) { peak = tokens; peakDay = key }
  }

  // 连续天数：从"今天"往回数；今天还没有记录就从昨天起算（否则一睁眼连续天数就归零，很反直觉）
  const today = dayKey(now)
  const has = key => (daily[key] ? daily[key].tokens > 0 : false)
  let cursor = has(today) ? today : shiftDay(today, -1)
  let currentStreak = 0
  while (has(cursor)) {
    currentStreak += 1
    cursor = shiftDay(cursor, -1)
  }

  // 最长连续：按日期排序后扫一遍连续段
  const sorted = Object.keys(daily).filter(has).sort()
  let longestStreak = 0
  let run = 0
  let prev = null
  for (const key of sorted) {
    run = prev !== null && shiftDay(prev, 1) === key ? run + 1 : 1
    if (run > longestStreak) longestStreak = run
    prev = key
  }

  const series = []
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = shiftDay(today, -i)
    series.push({ day: key, tokens: daily[key] ? daily[key].tokens : 0 })
  }
  const sum = list => list.reduce((acc, item) => acc + item.tokens, 0)

  // 最长任务用时：一个会话从首次到末次消耗的跨度
  let longestTaskMs = 0
  let longestTaskTokens = 0
  for (const session of Object.values(stats.sessions)) {
    const span = Math.max(0, session.lastAt - session.firstAt)
    if (span > longestTaskMs) { longestTaskMs = span; longestTaskTokens = session.tokens }
  }

  return {
    today: daily[today] ? daily[today].tokens : 0,
    todayCompletions: daily[today] ? daily[today].completions : 0,
    last7: sum(series.slice(-7)),
    last30: sum(series.slice(-30)),
    lifetime: state.totals ? state.totals.lifetimeTokens : 0,
    completions: state.totals ? state.totals.completions : 0,
    peak,
    peakDay,
    activeDays,
    currentStreak,
    longestStreak,
    longestTaskMs,
    longestTaskTokens,
    sessions: Object.keys(stats.sessions).length,
    series,
  }
}
