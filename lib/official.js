/**
 * 官方节奏源（codex-reset.com）· 纯逻辑层
 *
 * 目的：把「官方什么时候做了全局重置」「官方什么时候发了重置券」的真实节奏，
 *       映射成本地的「清空两窗」与「发放鲸元券」。不接触任何账号、不带任何凭据。
 *
 * 合规与稳定性（照其 /developers 条款）：
 *  - 只把文档化字段当作稳定契约：id / announced_at / announcement_state / group / type / summary / url
 *  - ⚠️ 唯一带"这是一次真实发券"语义的字段是 `banked_grant`，而它**没有被文档化**。
 *    因此这里做成"优雅降级"：一旦整个响应里都找不到该字段，就**一张都不发**并上报
 *    （grantFlagPresent=false），绝不靠日期或条数去猜 —— 猜就会把生命周期更新当发券，造成券通胀。
 *  - `banked_state` 只用于展示，绝不参与任何时间/次数/节奏的计算（其条款明文要求）。
 *  - 展示这些数据的任何界面都必须就地署名 "Data: codex-reset.com"。
 */

export const ATTRIBUTION = 'Data: codex-reset.com'

export function createOfficialState () {
  return {
    source: null,
    firstRunAt: null,
    lastFetchedAt: 0,
    lastError: null,
    grantFlagPresent: null,
    seenGrantIds: [],
    seenResetDays: [],
    grantsObserved: 0,
    resetsObserved: 0,
    lastResetAt: null,
    lastGrantAt: null,
    lastGrantSummary: null,
    forecast: null,
    events: [],
    backfilled: false,
  }
}

export function normalizeOfficialState (raw) {
  const base = createOfficialState()
  if (!raw || typeof raw !== 'object') return base
  const arr = v => (Array.isArray(v) ? v : [])
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  return {
    ...base,
    source: typeof raw.source === 'string' ? raw.source : null,
    firstRunAt: typeof raw.firstRunAt === 'number' ? raw.firstRunAt : null,
    lastFetchedAt: num(raw.lastFetchedAt, 0),
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
    grantFlagPresent: typeof raw.grantFlagPresent === 'boolean' ? raw.grantFlagPresent : null,
    seenGrantIds: arr(raw.seenGrantIds).filter(x => typeof x === 'string').slice(-500),
    seenResetDays: arr(raw.seenResetDays).filter(x => typeof x === 'string').slice(-200),
    grantsObserved: Math.max(0, num(raw.grantsObserved, 0)),
    resetsObserved: Math.max(0, num(raw.resetsObserved, 0)),
    lastResetAt: typeof raw.lastResetAt === 'string' ? raw.lastResetAt : null,
    lastGrantAt: typeof raw.lastGrantAt === 'string' ? raw.lastGrantAt : null,
    lastGrantSummary: typeof raw.lastGrantSummary === 'string' ? raw.lastGrantSummary : null,
    forecast: raw.forecast && typeof raw.forecast === 'object' ? raw.forecast : null,
    events: arr(raw.events).filter(e => e && typeof e === 'object').slice(0, 40),
    backfilled: raw.backfilled === true,
  }
}

/**
 * 规范化 timeline 响应。
 * 只读文档化字段 + 一个被显式标注为"未文档化"的 banked_grant。
 */
export function normalizeTimeline (payload) {
  const events = Array.isArray(payload?.events) ? payload.events : []
  let grantFlagPresent = false
  const normalized = []
  for (const e of events) {
    if (!e || typeof e !== 'object') continue
    if (typeof e.banked_grant === 'boolean') grantFlagPresent = true
    const announcedAt = typeof e.announced_at === 'string' ? e.announced_at : null
    normalized.push({
      id: typeof e.id === 'string' ? e.id : (typeof e.id === 'number' ? String(e.id) : null),
      group: typeof e.group === 'string' ? e.group : null,
      type: typeof e.type === 'string' ? e.type : null,
      announcedAt,
      day: announcedAt ? announcedAt.slice(0, 10) : null,
      announcementState: typeof e.announcement_state === 'string' ? e.announcement_state : null,
      bankedGrant: e.banked_grant === true,
      bankedState: typeof e.banked_state === 'string' ? e.banked_state : null,
      summary: typeof e.summary === 'string' ? e.summary : '',
      url: typeof e.url === 'string' ? e.url : null,
    })
  }
  return { updatedAt: typeof payload?.updated_at === 'string' ? payload.updated_at : null, events: normalized, grantFlagPresent }
}

/**
 * 挑出"真实发放"的券事件。
 * 判据只有一个：banked_grant === true（未文档化字段，故由调用方决定是否启用）。
 */
export function pickGrantEvents (timeline) {
  return timeline.events.filter(e => e.group === 'credits' && e.bankedGrant === true && e.id)
}

/**
 * 挑出"已宣布的全局重置"。
 * 判据（文档化）：group === 'reset' && announcement_state === 'announced'。
 * 另外按 UTC 日去重 —— 同一次重置常有多条公告，若各算一次会把发券次数放大。
 */
export function pickResetEvents (timeline) {
  const seen = new Set()
  const out = []
  for (const e of timeline.events) {
    if (e.group !== 'reset') continue
    if (e.announcementState !== 'announced') continue
    const key = e.day ?? e.id
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(e)
  }
  return out
}

function summarizeForecast (payload) {
  if (!payload || typeof payload !== 'object') return null
  const p = payload.probabilities ?? {}
  return {
    p24: typeof p.rounded_24h === 'number' ? p.rounded_24h : null,
    p48: typeof p.rounded_48h === 'number' ? p.rounded_48h : null,
    confidence: typeof payload.confidence === 'string' ? payload.confidence : null,
    // 该站自标 experimental，界面必须照实呈现、不得当作倒计时
    experimental: typeof payload.confidence_note === 'string'
      ? /experimental/i.test(payload.confidence_note)
      : true,
    lastResetAt: typeof payload.last_reset_at === 'string' ? payload.last_reset_at : null,
    ageDays: typeof payload.age_days === 'number' ? payload.age_days : null,
    officialSignal: payload.official_signal ?? null,
    medianDays: typeof payload.cadence?.recent_median_days === 'number' ? payload.cadence.recent_median_days : null,
    windowLabel: typeof payload.time_window?.label === 'string' ? payload.time_window.label : null,
    updatedAt: typeof payload.updated_at === 'string' ? payload.updated_at : null,
  }
}

/**
 * 纯计划：这次拉取应该做什么。不改动 state。
 *
 * 返回
 *   grantEvents  需要发券的事件（已按 id 去重、已过滤已知）
 *   resetEvents  需要清窗的重置（已按日去重、已过滤已知、且只认"插件首次运行之后"发生的）
 *   markSeen*    需要落账的 id 集合
 *   degradeReason 降级原因（例如发券字段消失）
 */
export function planOfficial (state, payloads, now, cfg) {
  const off = state.official
  const timelineCredits = normalizeTimeline(payloads.credits)
  const timelineReset = normalizeTimeline(payloads.reset)
  const forecast = summarizeForecast(payloads.forecast)

  const grantFlagPresent = timelineCredits.grantFlagPresent || timelineReset.grantFlagPresent
  const allEvents = [...timelineCredits.events, ...timelineReset.events]

  const observedGrants = pickGrantEvents(timelineCredits)
  const observedResets = pickResetEvents(timelineReset)

  const seenGrants = new Set(off.seenGrantIds)
  const seenResetDays = new Set(off.seenResetDays)

  // ── 发券：降级处理 ──────────────────────────────────────────────────────
  // 找不到 banked_grant 字段 → 一张都不发（不靠猜），只把事件记账并上报降级
  const firstFetch = off.lastFetchedAt === 0 && !off.backfilled
  let degradeReason = null
  let grantCandidates = []
  if (!grantFlagPresent) {
    degradeReason = 'grant-flag-absent'
  } else if (!firstFetch) {
    grantCandidates = observedGrants.filter(e => !seenGrants.has(e.id))
  } else {
    // 首次启用：按 backfillSince 回溯补发
    const policy = cfg.official.backfillSince
    grantCandidates = observedGrants.filter(e => {
      if (policy === 'off') return false
      if (policy === 'install') return off.firstRunAt !== null && Date.parse(e.announcedAt) >= off.firstRunAt
      const cutoff = now - 30 * 86_400_000
      return e.announcedAt ? Date.parse(e.announcedAt) >= cutoff : false
    })
  }

  // 兜底：无论发不发，都把观察到的发放事件记为已见，避免下次重复判断
  const markSeenGrantIds = observedGrants.map(e => e.id).filter(id => !seenGrants.has(id))

  // ── 重置：只认插件首次运行之后发生的（否则装上就把很久以前的重置套用一遍，没有意义）──
  const resetCandidates = observedResets.filter(e => {
    if (seenResetDays.has(e.day ?? e.id)) return false
    if (off.firstRunAt === null) return false
    return e.announcedAt ? Date.parse(e.announcedAt) > off.firstRunAt : false
  })
  const markSeenResetDays = observedResets
    .map(e => e.day ?? e.id)
    .filter(k => k && !seenResetDays.has(k))

  return {
    firstFetch,
    degradeReason,
    grantFlagPresent,
    forecast,
    grantEvents: grantCandidates,
    resetEvents: resetCandidates,
    markSeenGrantIds,
    markSeenResetDays,
    observedGrants,
    observedResets,
    allEvents,
    updatedAt: timelineCredits.updatedAt,
  }
}

/**
 * 执行计划：发券 + 清窗 + 落账。改动 state。
 *
 * 注意：这里所有动作都只可能**降低**锁定概率（发券给人出路、清窗减少用量），
 * 因此远程数据在结构上不可能导致误锁。
 */
export function applyOfficial (state, plan, now, cfg) {
  const off = state.official
  const report = { granted: 0, grantedByReset: 0, grantedByBackfill: 0, capped: 0, resets: 0, degraded: plan.degradeReason }

  const grantOne = (reason) => {
    const base = cfg.voucher ?? { maxHeld: 3, expiryDays: 30, initial: 0 }
    const r = grantVoucherLocal(state, now, base, reason)
    if (r.ok) report.granted += 1
    else report.capped += 1
    return r
  }

  for (const event of plan.grantEvents) {
    const reason = plan.firstFetch ? 'official-backfill' : 'official-grant'
    const r = grantOne(reason)
    if (r.ok && plan.firstFetch) report.grantedByBackfill += 1
    if (r.ok && !plan.firstFetch) {
      off.lastGrantAt = event.announcedAt
      off.lastGrantSummary = event.summary
    }
  }

  for (const event of plan.resetEvents) {
    // 1) 跟随真实重置：两窗清零（等价于官方"全局重置"）
    state.primary.startAt = null
    state.primary.endAt = null
    state.primary.used = 0
    state.secondary.startAt = null
    state.secondary.endAt = null
    state.secondary.used = 0
    state.secondary.mode = cfg.weekAnchor === 'monday-00:00' ? 'calendar' : 'auto'
    report.resets += 1
    off.lastResetAt = event.announcedAt

    // 2) 官方重置同时按配置加发鲸元券
    const perReset = Math.max(0, cfg.official.grantOnOfficialReset)
    for (let i = 0; i < perReset; i += 1) {
      const r = grantOne('official-reset')
      if (r.ok) report.grantedByReset += 1
    }
  }

  off.source = 'codex-reset.com'
  off.lastFetchedAt = now
  off.lastError = null
  off.grantFlagPresent = plan.grantFlagPresent
  off.grantsObserved = plan.observedGrants.length
  off.resetsObserved = plan.observedResets.length
  off.backfilled = true
  if (plan.forecast) {
    off.forecast = plan.forecast
    if (plan.forecast.lastResetAt) off.lastResetAt = plan.forecast.lastResetAt
  }
  for (const id of plan.markSeenGrantIds) if (!off.seenGrantIds.includes(id)) off.seenGrantIds.push(id)
  for (const id of plan.markSeenResetDays) if (!off.seenResetDays.includes(id)) off.seenResetDays.push(id)
  off.seenGrantIds = off.seenGrantIds.slice(-500)
  off.seenResetDays = off.seenResetDays.slice(-200)
  off.events = plan.allEvents.slice(0, 40)

  return report
}

/** 本地发券（与 windows.grantVoucher 同语义，单独放这里以免循环依赖） */
function grantVoucherLocal (state, now, voucherCfg, reason) {
  const MS_DAY = 86_400_000
  const held = state.vouchers.filter(v => v.status === 'available').length
  const maxHeld = voucherCfg.maxHeld ?? 3
  if (held >= maxHeld) return { ok: false, reason: 'at-cap', held }
  const voucher = {
    id: `o${now.toString(36)}-${(state.vouchers.length + 1).toString(36)}`,
    grantedAt: now,
    expiresAt: now + (voucherCfg.expiryDays ?? 30) * MS_DAY,
    status: 'available',
    redeemedAt: null,
    reason,
  }
  state.vouchers.push(voucher)
  return { ok: true, voucher, held: held + 1 }
}

/** 供 /quota 展示：一行官方节奏摘要（含必需的署名） */
export function renderOfficialLines (state, now) {
  const off = state.official
  if (!off.source) {
    return [`官方节奏源：未启用（在插件设置里把 official.source 设为 codex-reset.com 即可跟随真实重置与发券节奏）`]
  }
  const lines = []
  const f = off.forecast
  lines.push(`官方节奏源：${off.source}｜最近拉取 ${off.lastFetchedAt ? ago(now, off.lastFetchedAt) : '从未'}`)
  if (off.lastError) lines.push(`  ⚠️ 上次拉取失败（已 fail-open，不影响本地额度与锁定）：${off.lastError}`)
  if (off.grantFlagPresent === false) {
    lines.push('  ⚠️ 上游未提供发券标识字段，已降级为「一张都不发」（绝不靠猜）')
  }
  lines.push(`  官方发券：近一批观察到 ${off.grantsObserved} 次${off.lastGrantAt ? `，最近 ${off.lastGrantAt.slice(0, 10)}` : ''}`)
  lines.push(`  官方全局重置：观察到 ${off.resetsObserved} 次${off.lastResetAt ? `，最近 ${String(off.lastResetAt).slice(0, 10)}` : ''}`)
  if (f && f.p24 !== null) {
    lines.push(`  未来重置概率：24h ${f.p24}% / 48h ${f.p48}%${f.experimental ? '（上游标注 experimental，不是倒计时）' : ''}`)
    if (f.medianDays) lines.push(`  近期典型发券间隔：约 ${f.medianDays} 天`)
  }
  lines.push(`  ${ATTRIBUTION}`)
  return lines
}

function ago (now, then) {
  const s = Math.max(0, Math.floor((now - then) / 1000))
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}
