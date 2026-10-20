/**
 * 鲸元额度 · DSH host 半体
 *
 * 形态：纯本地、零凭据、不接触任何第三方账号。
 * 数据：$DSH_HOME/storages/dsh-self-quota/state.json（只有 token 计数与时间戳，不含任何对话内容）
 *
 * 采集：session/event 里 assistant/message 的 usage（TokenUsage）
 * 拦截：agent/pre-step → reject，tools/pre-execute → deny（仅在 enforcement='lock' 时生效）
 *
 * 安全铁律（全部硬编码，不开放为配置项）：
 *  1. 锁定判定只看本地 state + 本地时钟，绝不依赖任何远程数据。
 *  2. 状态不可判定（读盘失败/校验异常）时一律放行 —— 宁可漏锁，不可误锁。
 *  3. 不注册任何反禁用逻辑：用户在「设置 → 插件」里关掉本插件即可立刻恢复。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Schema from '@deepseek-ai/schemastery'

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
  renderStatusText,
  formatDuration,
  MS,
} from './lib/windows.js'

import {
  planOfficial,
  applyOfficial,
  renderOfficialLines,
} from './lib/official.js'

import { recordUsage, computeStats } from './lib/stats.js'

export const name = 'dsh-self-quota'

/**
 * ⚠️ 这里**故意不导出** `inject`，原因是一个实测踩到的坑：
 *
 * cordis 的 `Inject` 类型写着 `(keyof M)[] | { required?, optional? }`，
 * 但**运行时只认数组或"服务名 → 配置"字典**。看它的实现：
 *
 *   function resolve(inject, result = Object.create(null)) {
 *     if (!inject) return result
 *     if (Array.isArray(inject)) for (const name of inject) result[name] = null
 *     else for (const name of Object.keys(inject)) result[name] = inject[name] ?? null
 *     return result
 *   }
 *
 * 对象的 key 会被当成**服务名**。写 `{ optional: ['connection', ...] }` 等于声明
 * "我要注入一个名叫 optional 的服务"——它永远不存在，于是插件永久停在
 * `fiberPhase: 'pending'`，`apply()` 一次都不执行：没有计量、没有路由、没有诊断文件，
 * 客户端只看到 HTTP 404。类型对、启动不报错、静默失效。
 *
 * 所以：**不声明顶层 inject**（插件在任何宿主都能立即加载，计量与硬锁不依赖服务），
 * 需要服务的注册改用下面的 `whenService()`，等服务就绪后再挂。
 *
 * （备查：宿主侧的 `fiberPhase` 是最快的诊断入口 —— `pending` 就说明插件根本没跑起来。）
 */

// ── Connection Fetch 路由：插件对浏览器暴露 RPC 的唯一正确姿势 ────────────────
// ⚠️ 不要用 connection.rpc.handle / rpc.intercept。参考实现实测：DSH 0.1.5+ 里
//    那条通道的 disposer 会在 *Connection 自己的 fiber* 上解析 owner.webServer，
//    而该 fiber 从不持有 webServer → 在子 fiber 内抛错、通道静默消失，
//    启动时不报错，客户端只看到 HTTP 404（我们就是这样撞上的）。
//    Fetch 注册表只需要 owner.effect，而 /api 路由本身已经带可信来源 + 会话校验。
const RPC_METHOD_PREFIX = 'dsh-self-quota'
const RPC_ENDPOINTS = ['status', 'config', 'config-set', 'redeem', 'grant', 'stats']
const rpcMethod = endpoint => `${RPC_METHOD_PREFIX}/${endpoint}`
const rpcRoutePath = endpoint => `/api/${rpcMethod(endpoint)}`

const RPC_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' }
const rpcEnvelope = (rpcId, result, status = 200) =>
  new Response(JSON.stringify({ type: 'server-response', rpcId, result }), { status, headers: RPC_HEADERS })
const rpcFailure = (code, message, details = {}) => ({ ok: false, error: { code, message, details } })

/** 解析 client-request 信封，再交给本插件自己的 endpoint 处理函数 */
async function rpcResponse (endpoint, request, handle) {
  const contentType = (request.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
  if (contentType !== 'application/json') {
    return rpcEnvelope('invalid-request', rpcFailure('gateway/bad-request', 'content type must be application/json'), 415)
  }
  let message
  try {
    message = await request.json()
  } catch {
    return rpcEnvelope('invalid-request', rpcFailure('gateway/bad-request', 'body is not JSON'))
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || message.type !== 'client-request' || typeof message.rpcId !== 'string') {
    return rpcEnvelope('invalid-request', rpcFailure('gateway/bad-request', 'invalid client-request message'))
  }
  const expected = rpcMethod(endpoint)
  if (message.method !== expected) {
    return rpcEnvelope(message.rpcId, rpcFailure(
      'gateway/bad-request',
      `method ${JSON.stringify(String(message.method))} does not match endpoint ${JSON.stringify(expected)}`,
    ))
  }
  try {
    return rpcEnvelope(message.rpcId, await handle(endpoint, message.payload, request.signal))
  } catch (error) {
    return rpcEnvelope(message.rpcId, rpcFailure('internal', String(error?.message ?? error)))
  }
}

export const Config = Schema.object({
  mode: Schema.union(['auto', 'manual']).default('auto')
    .description('auto=开箱即用（额度用推荐默认值，什么都不用填）｜manual=全部额度自己设（面板里可直接编辑）'),
  fiveHourLimit: Schema.number().default(2_000_000).description('5 小时窗上限（tokens）—— 仅 fiveHourMode=manual 时生效'),
  weeklyLimit: Schema.number().default(15_000_000).description('周窗上限（tokens）—— 这里填你的「周用量」/「总额度」'),
  fiveHourMode: Schema.union(['auto', 'manual']).default('auto')
    .description('auto=5 小时上限自动 = 周额度 ÷ 比例（只填总额度，5h 会跟着变）｜manual=自己填死'),
  fiveHourRatio: Schema.number().default(7.5)
    .description('auto 模式的比例：5 小时上限 = 周额度 ÷ 该值'),
  fiveHourWindowMinutes: Schema.number().default(300).description('5 小时窗时长（分钟）；自测时设 1 即可秒级验证翻窗'),
  weeklyWindowDays: Schema.number().default(7).description('周窗时长（天）；自测时设 0.002'),
  weekAnchor: Schema.union(['first-use', 'monday-00:00']).default('first-use').description('周窗锚点'),
  enforcement: Schema.union(['off', 'warn', 'lock']).default('lock')
    .description('off=只记录｜warn=只提示｜lock=额度用尽锁死对话（默认；唯一出路是关闭本插件）'),
  lockMessage: Schema.string().default('鲸元额度已用尽'),
  countSubagents: Schema.boolean().default(true).description('子代理的消耗是否计入'),
  countBackground: Schema.boolean().default(false)
    .description('是否把后台调用（上下文压缩 / 会话标题这类非回合请求）也计入额度'),
  allowReadOnlyWhileLocked: Schema.boolean().default(false)
    .description('锁定期间是否仍放行只读工具（默认 false：一律拒绝）'),
  readOnlyAllowlist: Schema.array(Schema.string()).default([
    'read', 'read_image', 'glob', 'grep', 'session_search', 'session_event_read',
    'session_event_search', 'web_search', 'web_fetch',
  ]).description('allowReadOnlyWhileLocked 生效时，允许放行的工具名'),
  notifyOnGrant: Schema.boolean().default(true),
  voucher: Schema.object({
    initial: Schema.number().default(1).description('首次安装赠几张鲸元券'),
    maxHeld: Schema.number().default(3).description('最多同时持有几张'),
    expiryDays: Schema.number().default(30).description('有效期（天）—— 本地规则，非官方规则'),
  }),
  official: Schema.object({
    source: Schema.union(['off', 'codex-reset.com']).default('off')
      .description('官方节奏源：off=不联网（默认）｜codex-reset.com=跟随真实的全局重置与发券节奏'),
    baseUrl: Schema.string().default('https://codex-reset.com'),
    pollMinutes: Schema.number().default(15).description('轮询间隔（分钟），实际下限 1 分钟（遵守其条款）'),
    timeoutMs: Schema.number().default(8_000),
    userAgent: Schema.string().default('dsh-self-quota/0.4.0')
      .description('该站要求带可识别 UA，建议补上你的仓库地址或联系方式'),
    backfillSince: Schema.union(['last-30d', 'install', 'off']).default('last-30d')
      .description('首次启用时回溯补发鲸元券的范围'),
    grantPerOfficialGrant: Schema.number().default(1).description('官方每发一次券，本地跟发几张'),
    grantOnOfficialReset: Schema.number().default(1).description('官方全局重置时本地加发几张（0=只清窗不发券）'),
  }),
  stateDir: Schema.string().default('').description('留空则用 $DSH_HOME/storages/dsh-self-quota'),
})

function resolveStateDir (cfg) {
  if (cfg.stateDir) return cfg.stateDir
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages', 'dsh-self-quota')
}

function loadState (file) {
  try {
    if (!fs.existsSync(file)) return { state: createState(), ok: true }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { state: normalizeState(raw), ok: true }
  } catch (error) {
    // 读不出来就当作"不可判定"：不锁、不崩，从新状态开始并保留坏文件
    return { state: createState(), ok: false, error }
  }
}

function saveState (file, state) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

export function apply (ctx, rawConfig) {
  /** 用户写进配置里的原始值（表单要显示的是它，不是派生后的值） */
  const rawCfg = {
    ...rawConfig,
    voucher: {
      initial: rawConfig?.voucher?.initial ?? 1,
      maxHeld: rawConfig?.voucher?.maxHeld ?? 3,
      expiryDays: rawConfig?.voucher?.expiryDays ?? 30,
    },
  }

  /**
   * 5 小时上限的派生：
   *  - `fiveHourMode === 'auto'`：上限 = 周额度 ÷ 比例（默认 7.5）。
   *    这样"只填一个总额度"时，5 小时窗会跟着自动变 —— 不会出现改完总额度、5h 还是老数字的情况。
   *  - `manual`：用用户自己填死的 fiveHourLimit。
   */
  const fiveHourCapOf = (c) => {
    if (c.fiveHourMode === 'auto') {
      const ratio = Number(c.fiveHourRatio) > 0 ? Number(c.fiveHourRatio) : 7.5
      return Math.max(1, Math.round(Number(c.weeklyLimit) / ratio))
    }
    return Number(c.fiveHourLimit)
  }

  /** 运行时一律用这个"生效配置"（fiveHourLimit 已按 auto/manual 解析） */
  const cfg = { ...rawCfg, fiveHourLimit: fiveHourCapOf(rawCfg) }

  const dir = resolveStateDir(cfg)
  const file = path.join(dir, 'state.json')
  const loaded = loadState(file)
  const state = loaded.state
  let stateOk = loaded.ok

  const log = (level, message) => {
    try {
      const logger = ctx.logger?.[level] ?? ctx.logger?.info
      if (typeof logger === 'function') logger.call(ctx.logger, `[self-quota] ${message}`)
    } catch { /* 日志失败绝不影响主流程 */ }
  }

  if (!stateOk) log('warn', `状态文件不可读，已临时放行并重建：${file}（${loaded.error?.message ?? 'unknown'}）`)

  // 诊断：读不到运行日志时，靠这个文件判断"插件到底挂上了什么"
  const diag = { rpc: 'pending', rpcDetail: '' }
  /** 写配置的诊断（落盘到 last-write.json，跨热替换也能留证） */
  const settingsDiag = { lastEntry: null, lastWrite: null }
  const registeredCommands = []
  const writeStatus = () => {
    try {
      const statusFile = path.join(dir, 'status.json')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(statusFile, JSON.stringify({
        loadedAt: new Date().toISOString(),
        plugin: 'dsh-self-quota',
        version: '0.4.0',
        stateFile: file,
        stateOk,
        enforcement: cfg.enforcement,
        windows: {
          fiveHourMinutes: cfg.fiveHourWindowMinutes,
          weeklyDays: cfg.weeklyWindowDays,
          weekAnchor: cfg.weekAnchor,
        },
        limits: { fiveHourLimit: cfg.fiveHourLimit, weeklyLimit: cfg.weeklyLimit },
        commands: registeredCommands.slice(),
        rpc: diag.rpc,
        rpcDetail: diag.rpcDetail,
        settingsEntry: settingsDiag.lastEntry,
        lastConfigWrite: settingsDiag.lastWrite,
        vouchers: state.vouchers.length,
      }, null, 2), 'utf8')
    } catch (error) {
      log('warn', `诊断文件写入失败：${error?.message ?? error}`)
    }
  }

  /**
   * 等某个服务就绪再执行注册。
   *
   * 优先用 cordis 的 scoped `ctx.inject([name], cb)`（依赖就绪时执行）；
   * 若该方法不可用或抛错，退化为轮询 `ctx.get(name)`。
   * 这样既不依赖顶层 `inject` 的（坑人的）语义，也不会因为服务晚到而静默丢功能。
   */
  const whenService = (name, callback) => {
    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject([name], scope => callback((scope && scope[name]) ?? ctx.get(name)))
        return
      } catch (error) {
        log('warn', `scoped inject(${name}) 失败，退化为轮询：${error?.message ?? error}`)
      }
    }
    let tries = 0
    const timer = setInterval(() => {
      tries += 1
      const svc = ctx.get(name)
      if (svc || tries >= 40) {
        clearInterval(timer)
        if (svc) callback(svc)
        else {
          diag[`${name}Unavailable`] = true
          log('warn', `${name} 服务始终不可用，相关功能未注册`)
          writeStatus()
        }
      }
    }, 500)
    timer.unref?.()
  }

  let dirty = false
  let flushTimer = null
  const flush = () => {
    if (!dirty) return
    try {
      saveState(file, state)
      dirty = false
      stateOk = true
    } catch (error) {
      stateOk = false
      log('warn', `写盘失败，已临时放行：${error?.message ?? error}`)
    }
  }
  const scheduleFlush = () => {
    dirty = true
    if (flushTimer !== null) return
    flushTimer = setTimeout(() => { flushTimer = null; flush() }, 1000)
    flushTimer.unref?.()
  }

  // 首次安装赠券
  if (state.vouchers.length === 0 && state.totals.lifetimeTokens === 0 && cfg.voucher.initial > 0) {
    for (let i = 0; i < cfg.voucher.initial; i += 1) grantVoucher(state, Date.now(), cfg, 'initial')
    scheduleFlush()
  }

  // 记录首次运行时刻：官方"全局重置"只对此刻之后发生的才生效（否则装上就把陈年重置套用一遍）
  if (state.official.firstRunAt === null) {
    state.official.firstRunAt = Date.now()
    scheduleFlush()
  }

  // ── 官方节奏源（默认关闭）──────────────────────────────────────────────────
  // 三条纪律：默认关闭 / 失败 fail-open / 展示处署名 Data: codex-reset.com
  const officialEnabled = () => cfg.official.source === 'codex-reset.com'
  let fetching = false

  const fetchJson = async (pathAndQuery) => {
    const res = await fetch(`${cfg.official.baseUrl}${pathAndQuery}`, {
      headers: { 'user-agent': cfg.official.userAgent, accept: 'application/json' },
      signal: AbortSignal.timeout(cfg.official.timeoutMs),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  }

  const pollOfficial = async () => {
    if (!officialEnabled() || fetching) return
    fetching = true
    try {
      const [credits, reset, forecast] = await Promise.all([
        fetchJson('/api/timeline?group=credits&limit=12'),
        fetchJson('/api/timeline?group=reset&limit=24'),
        fetchJson('/api/forecast'),
      ])
      const now = Date.now()
      const plan = planOfficial(state, { credits, reset, forecast }, now, cfg)
      const report = applyOfficial(state, plan, now, cfg)
      scheduleFlush()
      log('info', `官方节奏：重置 ${report.resets} 次 · 发券 ${report.granted} 张`
        + `${report.degraded ? ` · 降级(${report.degraded})` : ''}${report.capped ? ` · 受上限限制 ${report.capped}` : ''}`)
    } catch (error) {
      // fail-open：只记录错误，绝不影响本地额度判定与锁定
      state.official.lastError = String(error?.message ?? error)
      scheduleFlush()
      log('warn', `官方节奏源拉取失败（已忽略，不影响本地额度）：${state.official.lastError}`)
    } finally {
      fetching = false
    }
  }

  if (officialEnabled()) {
    ctx.effect(() => {
      const kick = setTimeout(pollOfficial, 5_000)
      const intervalMs = Math.max(60_000, cfg.official.pollMinutes * MS.MINUTE)
      const timer = setInterval(pollOfficial, intervalMs)
      kick.unref?.()
      timer.unref?.()
      return () => { clearTimeout(kick); clearInterval(timer) }
    })
  }

  // ── 采集：session/event → assistant/message.usage ──────────────────────────
  ctx.on('session/event', (session, event) => {
    try {
      if (!event || event.type !== 'assistant/message') return
      const usage = event?.data?.usage
      if (!usage) return
      if (!cfg.countSubagents && session?.header?.origin === 'subagent') return
      if (!shouldAcceptEvent(state, session?.id, event.seq)) return

      const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
      if (!(tokens > 0)) return
      const now = Date.now()
      addUsage(state, tokens, now, cfg)
      recordUsage(state, tokens, now, session?.id) // 按天聚合 + 会话首末时间（供用量统计）
      scheduleFlush()

      const st = readStatus(state, Date.now(), cfg)
      log('info', `+${tokens} tokens · 5h 剩 ${(st.primary.remaining * 100).toFixed(1)}% · 周剩 ${(st.secondary.remaining * 100).toFixed(1)}%`)
    } catch (error) {
      log('warn', `计量失败（已忽略这一笔）：${error?.message ?? error}`)
    }
  })

  // ── 采集（可选）：后台调用 —— 压缩 / 会话标题这类非回合请求 ────────────────
  // 只在 countBackground 打开时统计，且只认带 purpose 的请求；
  // 关键：**必须原样把流透传下去**，绝不能因为计量而吞掉或改写 chunk。
  if (cfg.countBackground) {
    ctx.on('llm/stream', (options, next) => {
      const inner = next()
      if (!options || !options.purpose) return inner
      return (async function * counted () {
        for await (const chunk of inner) {
          try {
            if (chunk && chunk.type === 'usage' && chunk.usage) {
              const tokens = (chunk.usage.inputTokens ?? 0) + (chunk.usage.outputTokens ?? 0)
              if (tokens > 0) {
                addUsage(state, tokens, Date.now(), cfg)
                scheduleFlush()
                log('info', `后台调用（${options.purpose}）+${tokens} tokens`)
              }
            }
          } catch (error) {
            log('warn', `后台调用计量失败（不影响流）：${error?.message ?? error}`)
          }
          yield chunk
        }
      })()
    })
  }

  // ── /quota 命令：最直接的"看得见"入口 ─────────────────────────────────────
  // 放进 ctx.inject：等 commands 服务就绪再注册（首版直接 ctx.get 拿到 undefined，
  // 命令就静默消失了 —— 诊断文件里 commands 为空数组即是证据）。
  whenService('commands', (commands) => {
    if (registeredCommands.length > 0) return
    const register = commands?.register
    if (typeof register !== 'function') {
      log('warn', 'commands.register 不可用，/quota 未注册（计量与硬锁不受影响）')
      writeStatus()
      return
    }
    try {
      register.call(commands, {
        name: 'quota',
        description: '查看鲸元额度（5h 窗 / 周窗 / 鲸元券）剩余情况',
        handler: () => {
          try {
            const now = Date.now()
            const text = [
              renderStatusText(state, now, cfg),
              '',
              ...renderOfficialLines(state, now),
            ].join('\n')
            return { kind: 'success', text }
          } catch (error) {
            return { kind: 'error', text: `额度状态读取失败：${error?.message ?? error}` }
          }
        },
      })
      registeredCommands.push('quota')
      register.call(commands, {
        name: 'quota-redeem',
        description: '兑换一张鲸元券：5h 窗与周窗已用清零，周窗重置日重设为约 7 天后',
        handler: () => {
          try {
            const r = redeemVoucher(state, Date.now(), cfg)
            if (!r.ok) return { kind: 'error', text: '没有可用的鲸元券。' }
            scheduleFlush()
            return { kind: 'success', text: `已兑换 1 张鲸元券，两窗已清零。\n\n${renderStatusText(state, Date.now(), cfg)}` }
          } catch (error) {
            return { kind: 'error', text: `兑换失败：${error?.message ?? error}` }
          }
        },
      })
      registeredCommands.push('quota-redeem')
      log('info', `命令已注册：${registeredCommands.join(', ')}`)
      writeStatus()
    } catch (error) {
      log('warn', `命令注册失败（不影响计量）：${error?.message ?? error}`)
      writeStatus()
    }
  })

  // ── 快照 + 配置读写（给左下角挂件与设置行用）────────────────────────────────
  const snapshot = () => {
    const now = Date.now()
    const st = readStatus(state, now, cfg)
    const f = state.official ? state.official.forecast : null
    const officialOn = cfg.official.source === 'codex-reset.com'
    return {
      now,
      primary: st.primary,
      secondary: st.secondary,
      vouchers: st.vouchers,
      enforcement: cfg.enforcement,
      mode: cfg.mode,
      voucherRules: { maxHeld: cfg.voucher.maxHeld, expiryDays: cfg.voucher.expiryDays },
      official: officialOn
        ? {
            source: state.official.source,
            lastResetAt: state.official.lastResetAt,
            p24: f ? f.p24 : null,
            p48: f ? f.p48 : null,
            experimental: f ? f.experimental : true,
            lastError: state.official.lastError,
          }
        : null,
    }
  }

  // ── 配置读写：面板 / 设置行共用的白名单写路径 ──────────────────────────────
  // 只允许这些字段落盘，避免把插件写成"加载失败"。
  const FLAT_FIELDS = ['weeklyLimit', 'fiveHourLimit', 'fiveHourWindowMinutes', 'weeklyWindowDays', 'weekAnchor', 'enforcement', 'mode', 'fiveHourMode', 'fiveHourRatio']
  const VOUCHER_FIELDS = ['maxHeld', 'expiryDays']
  const POSITIVE_FIELDS = ['weeklyLimit', 'fiveHourLimit', 'fiveHourWindowMinutes', 'weeklyWindowDays', 'fiveHourRatio']
  const ENUMS = {
    weekAnchor: ['first-use', 'monday-00:00'],
    enforcement: ['off', 'warn', 'lock'],
    mode: ['auto', 'manual'],
    fiveHourMode: ['auto', 'manual'],
  }
  /** 「开箱即用」档的推荐值：面板上的「恢复默认」直接用它，也是 auto 档的语义 */
  const PRESET = {
    weeklyLimit: 15_000_000,
    fiveHourLimit: 2_000_000,
    fiveHourMode: 'auto',
    fiveHourRatio: 7.5,
    fiveHourWindowMinutes: 300,
    weeklyWindowDays: 7,
    weekAnchor: 'first-use',
    enforcement: 'lock',
    voucherMaxHeld: 3,
    voucherExpiryDays: 30,
  }

  const configView = () => ({
    mode: cfg.mode,
    weeklyLimit: cfg.weeklyLimit,
    // 表单要显示"你填的值"，另外单独告诉它派生后的生效值
    fiveHourLimit: rawCfg.fiveHourLimit,
    fiveHourLimitEffective: cfg.fiveHourLimit,
    fiveHourMode: cfg.fiveHourMode,
    fiveHourRatio: cfg.fiveHourRatio,
    fiveHourWindowMinutes: cfg.fiveHourWindowMinutes,
    weeklyWindowDays: cfg.weeklyWindowDays,
    weekAnchor: cfg.weekAnchor,
    enforcement: cfg.enforcement,
    voucher: {
      maxHeld: cfg.voucher.maxHeld,
      expiryDays: cfg.voucher.expiryDays,
    },
    preset: PRESET,
  })

  /** 安全取服务：ctx.get 在少数自定义上下文里可能不存在，取不到就返回 undefined 而不是抛错 */
  const getService = (name) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 找能写的 Loader 条目。
   *
   * ⚠️ 这里踩过一个坑：`settings.describe()` **只含 `.volatile()` 字段**（见 @deepseek-ai/dsh-settings 文档），
   * 我们的额度是"普通配置"，所以永远不在 describe() 里 → 之前每次都报 locate-entry 失败。
   * 普通配置的正确写入口是 **`configEditor.edit(entry, change)`**（@deepseek-ai/dsh-config-editor），
   * 它把完整 config 写进 profile patch 并立即通过 Loader 应用。
   */
  const findConfigEntry = () => {
    const editor = getService('configEditor')
    if (!editor) { settingsDiag.lastEntry = 'no-config-editor'; return null }
    if (typeof editor.entries !== 'function') { settingsDiag.lastEntry = 'no-entries()'; return null }
    let list
    try {
      list = editor.entries()
    } catch (error) {
      settingsDiag.lastEntry = `entries-threw: ${error?.message ?? error}`
      return null
    }
    if (!Array.isArray(list)) { settingsDiag.lastEntry = `entries-not-array:${typeof list}`; return null }

    const label = e => `${e?.options?.id ?? '?'}(${e?.options?.name ?? '?'})`
    const hit = list.find(e => {
      const name = String(e?.options?.name ?? '')
      const id = String(e?.options?.id ?? '')
      return name === 'dsh-self-quota' || name.includes('self-quota') || id === 'self-quota' || id.includes('self-quota')
    })
    if (!hit) {
      settingsDiag.lastEntry = `missing(${list.length}): ` + list.slice(0, 10).map(label).join(' | ')
      return null
    }
    settingsDiag.lastEntry = label(hit)
    return hit
  }

  /** 退化路径用：settings.describe() 找条目（只有 volatile 字段才会出现在里面） */
  const findSettingsEntry = () => {
    const svc = getService('settings')
    if (!svc || typeof svc.describe !== 'function') return null
    try {
      const list = svc.describe()
      if (!Array.isArray(list)) return null
      return list.find(d => String(d && d.ns).includes('self-quota')) ?? null
    } catch {
      return null
    }
  }

  /** 把候选值转成 settings.mutate 的 path ops —— 嵌套字段用路径表达，避免整体替换 voucher */
  const toOps = (candidate) => {
    const ops = []
    for (const key of Object.keys(candidate)) {
      if (key === 'voucher') continue
      ops.push({ op: 'set', path: [key], value: candidate[key] })
    }
    if (candidate.voucher) {
      for (const key of VOUCHER_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(candidate.voucher, key)) {
          ops.push({ op: 'set', path: ['voucher', key], value: candidate.voucher[key] })
        }
      }
    }
    return ops
  }

  const readBackEntry = (entry) => {
    try {
      const svc = getService('settings')
      if (!svc || typeof svc.describe !== 'function') return null
      const list = svc.describe()
      const fresh = list.find(d => String(d && d.ns) === String(entry.ns))
      return fresh ? fresh.value : null
    } catch { return null }
  }

  /** 回读校验：确认配置真的生效了，而不是只回了一个 ok */
  const verifyPatch = (observed, candidate) => {
    if (!observed || typeof observed !== 'object') return false
    for (const key of Object.keys(candidate)) {
      const want = candidate[key]
      const got = observed[key]
      if (key === 'voucher') {
        if (!got || typeof got !== 'object') return false
        for (const k of Object.keys(want)) if (Number(got[k]) !== Number(want[k])) return false
      } else if (POSITIVE_FIELDS.includes(key)) {
        if (Number(got) !== Number(want)) return false
      } else if (got !== want) {
        return false
      }
    }
    return true
  }

  /** 从 configEditor 的 configuration() 里回读我们这条的生效配置 */
  const readBackConfig = (entryId) => {
    try {
      const editor = getService('configEditor')
      if (!editor || typeof editor.configuration !== 'function') return null
      const row = editor.configuration().find(r => String(r?.entry?.options?.id) === String(entryId))
      if (!row) return null
      return { ...(row.inherited || {}), ...(row.override || {}) }
    } catch { return null }
  }

  const recordWriteDiag = (info) => {
    settingsDiag.lastWrite = { at: new Date().toISOString(), ...info }
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'last-write.json'), JSON.stringify(settingsDiag, null, 2), 'utf8')
    } catch (error) {
      log('warn', `写入诊断失败：${error?.message ?? error}`)
    }
  }

  const writeConfig = async (payload) => {
    const invalid = message => {
      recordWriteDiag({ ok: false, stage: 'validate', error: message })
      return { ok: false, error: { code: 'invalid', message, details: {} } }
    }
    if (!payload || typeof payload !== 'object') {
      return { ok: false, error: { code: 'empty-patch', message: '没有可写入的字段', details: {} } }
    }
    const candidate = {}

    for (const key of FLAT_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(payload, key)) continue
      const value = payload[key]
      if (POSITIVE_FIELDS.includes(key) && !(Number.isFinite(value) && value > 0)) {
        return invalid(`${key} 必须是正数`)
      }
      if (ENUMS[key] && !ENUMS[key].includes(value)) {
        return invalid(`${key} 只能是 ${ENUMS[key].join(' / ')}`)
      }
      candidate[key] = value
    }

    let voucherPatch = null
    if (payload.voucher && typeof payload.voucher === 'object' && !Array.isArray(payload.voucher)) {
      for (const key of VOUCHER_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(payload.voucher, key)) continue
        const value = payload.voucher[key]
        if (!(Number.isFinite(value) && value > 0)) return invalid(`voucher.${key} 必须是正数`)
        voucherPatch = voucherPatch || {}
        voucherPatch[key] = value
      }
    }
    if (voucherPatch) candidate.voucher = { ...cfg.voucher, ...voucherPatch }

    if (Object.keys(candidate).length === 0) {
      return { ok: false, error: { code: 'empty-patch', message: '没有可写入的字段', details: {} } }
    }

    const editor = getService('configEditor')
    const entry = editor ? findConfigEntry() : null

    if (editor && entry) {
      // ── 首选路径：configEditor.edit —— 普通配置的官方写入口 ──
      // change(current, inherited) 必须返回"完整的下一份 config"；
      // 它会整份写进 profile patch，然后通过 Loader 立即应用（我们这边会热替换）。
      const applyChange = (current) => {
        const next = { ...(current || {}) }
        for (const key of Object.keys(candidate)) {
          if (key === 'voucher') next.voucher = { ...(next.voucher || {}), ...candidate.voucher }
          else next[key] = candidate[key]
        }
        return next
      }
      try {
        await editor.edit(entry, applyChange)
      } catch (error) {
        const message = String(error?.message ?? error)
        recordWriteDiag({ ok: false, stage: 'configEditor.edit', error: message, candidate, entry: settingsDiag.lastEntry })
        log('warn', `写配置失败（configEditor.edit）：${message}`)
        return { ok: false, error: { code: 'config-write-failed', message, details: { method: 'configEditor.edit' } } }
      }

      const observed = readBackConfig(entry.options.id)
      const verified = verifyPatch(observed, candidate)
      recordWriteDiag({
        ok: true,
        stage: 'configEditor.edit',
        verified,
        candidate,
        observed,
        entry: settingsDiag.lastEntry,
      })
      log('info', `写配置成功（configEditor.edit）· 回读确认：${verified ? '一致' : '暂不一致'}`)
      return { ok: true, value: { applied: candidate, method: 'configEditor.edit', verified, observed } }
    }

    // ── 退化路径：没有 configEditor 时试 settings（只有 volatile 字段才会成功） ──
    const svc = getService('settings')
    const settingsEntry = svc ? findSettingsEntry() : null
    if (!svc || !settingsEntry) {
      const parts = []
      parts.push(editor
        ? `configEditor 里找不到本插件条目（${settingsDiag.lastEntry || 'unknown'}）`
        : 'configEditor 服务不可用')
      if (svc) {
        let namespaces = []
        try { namespaces = (svc.describe() || []).map(d => String(d && d.ns)) } catch { /* 忽略 */ }
        parts.push(namespaces.length
          ? `settings 里的命名空间：${namespaces.slice(0, 8).join(' | ')}`
          : 'settings 里也没有条目')
      } else {
        parts.push('settings 服务也不可用')
      }
      const why = parts.join('；')
      recordWriteDiag({ ok: false, stage: 'locate-entry', error: why, candidate })
      return { ok: false, error: { code: 'config-write-unavailable', message: why, details: {} } }
    }

    let method = null
    try {
      if (typeof svc.mutate === 'function') {
        method = 'settings.mutate'
        await svc.mutate(settingsEntry.ns, toOps(candidate), settingsEntry.revision)
      } else if (typeof svc.update === 'function') {
        method = 'settings.update'
        await svc.update(settingsEntry.ns, candidate, settingsEntry.revision)
      } else {
        throw new Error('settings 服务既没有 mutate 也没有 update')
      }
    } catch (error) {
      const message = String(error?.message ?? error)
      recordWriteDiag({ ok: false, stage: method || 'write', error: message, candidate, ns: settingsEntry.ns })
      log('warn', `写配置失败（${method || 'n/a'}）：${message}`)
      return { ok: false, error: { code: 'config-write-failed', message, details: { method } } }
    }

    const observed = readBackEntry(settingsEntry)
    const verified = verifyPatch(observed, candidate)
    recordWriteDiag({ ok: true, stage: method, verified, candidate, observed, ns: settingsEntry.ns })
    log('info', `写配置成功（${method}）· 回读确认：${verified ? '一致' : '暂不一致'}`)
    return { ok: true, value: { applied: candidate, method, verified, observed } }
  }

  // ── 浏览器 RPC：挂 Connection 的 Fetch 注册表（不是 rpc.intercept！见文件头说明）──
  const handleRpc = async (endpoint, payload) => {
    try {
      if (endpoint === 'status') return { ok: true, value: snapshot() }
      if (endpoint === 'stats') return { ok: true, value: computeStats(state, Date.now(), 60) }
      if (endpoint === 'config') return { ok: true, value: configView() }
      if (endpoint === 'config-set') return await writeConfig(payload)
      if (endpoint === 'redeem') {
        const r = redeemVoucher(state, Date.now(), cfg)
        if (!r.ok) return rpcFailure('no-voucher', '没有可用的鲸元券')
        scheduleFlush()
        return { ok: true, value: snapshot() }
      }
      if (endpoint === 'grant') {
        // 自己给自己发一张：受 maxHeld 上限约束，不绕过任何规则
        const r = grantVoucher(state, Date.now(), cfg, 'manual')
        if (!r.ok) {
          return rpcFailure('at-cap', `鲸元券已达上限（${cfg.voucher.maxHeld} 张）—— 先用掉一张，或把上限调大`)
        }
        scheduleFlush()
        log('info', `手动发放 1 张鲸元券（持有 ${r.held} 张）`)
        return { ok: true, value: snapshot() }
      }
      return rpcFailure('unknown-endpoint', String(endpoint))
    } catch (error) {
      return rpcFailure('internal', String(error?.message ?? error))
    }
  }

  let rpcRegistered = false
  whenService('connection', (connection) => {
    if (rpcRegistered) return
    const fetchRegistry = connection?.fetch
    if (!fetchRegistry || typeof fetchRegistry.register !== 'function') {
      diag.rpc = 'no-fetch-registry'
      log('warn', 'connection.fetch 不可用，左下角挂件与设置行拿不到数据（计量与硬锁不受影响）')
      writeStatus()
      return
    }
    rpcRegistered = true
    let registered = 0
    for (const endpoint of RPC_ENDPOINTS) {
      ctx.effect(() => {
        const dispose = fetchRegistry.register({
          path: rpcRoutePath(endpoint),
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: request => rpcResponse(endpoint, request, handleRpc),
        })
        return () => {
          try {
            const p = dispose()
            if (p && typeof p.catch === 'function') p.catch(() => {})
          } catch { /* 卸载期失败不影响其它清理 */ }
        }
      })
      registered += 1
    }
    diag.rpc = 'registered'
    diag.rpcDetail = `${registered} 条 Fetch 路由：${RPC_ENDPOINTS.map(rpcRoutePath).join(', ')}`
    log('info', `RPC 路由已注册（${registered} 条）`)
    writeStatus()
  })

  // ── 硬锁：agent/pre-step → reject ─────────────────────────────────────────
  // 三重保险：enforcement 必须是 lock；state 必须可判定；任何异常一律放行。
  const lockReason = () => {
    const st = readStatus(state, Date.now(), cfg)
    return `${cfg.lockMessage}（5h 剩 ${(st.primary.remaining * 100).toFixed(1)}%，周剩 ${(st.secondary.remaining * 100).toFixed(1)}%）。`
      + '解除方法：设置 → 插件 → 关闭「dsh-self-quota」。'
  }

  const shouldLock = () => {
    if (cfg.enforcement !== 'lock') return false
    if (!stateOk) return false
    try {
      return overflowOf(state, Date.now(), cfg).over
    } catch (error) {
      log('warn', `锁定判定异常，已放行：${error?.message ?? error}`)
      return false
    }
  }

  ctx.on('agent/pre-step', (payload, next) => {
    if (!shouldLock()) return next()
    log('info', lockReason())
    return { kind: 'reject' }
  })

  // 例外（默认关闭）：allowReadOnlyWhileLocked 打开时，放行白名单内的只读工具，
  // 让"锁定恰好发生在回合中途"时这个回合能干净收尾，而不是每个工具调用都报错。
  const isReadOnlyTool = (toolName) => {
    if (typeof toolName !== 'string') return false
    const list = Array.isArray(cfg.readOnlyAllowlist) ? cfg.readOnlyAllowlist : []
    return list.includes(toolName)
  }

  ctx.on('tools/pre-execute', (exec, next) => {
    if (!shouldLock()) return next()
    if (cfg.allowReadOnlyWhileLocked && isReadOnlyTool(exec && exec.name)) return next()
    return { kind: 'deny', reason: lockReason() }
  })

  // ── 定期推进窗口 / 清扫过期券 / 落盘 ──────────────────────────────────────
  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        const now = Date.now()
        const expired = sweepVouchers(state, now)
        readStatus(state, now, cfg) // 内部会 ensureWindows，让"没消耗时窗也按时滚动"
        if (expired > 0) log('info', `${expired} 张鲸元券已过期`)
        if (expired > 0) scheduleFlush()
      } catch (error) {
        log('warn', `定时推进失败：${error?.message ?? error}`)
      }
    }, 30_000)
    timer.unref?.()

    return () => {
      clearInterval(timer)
      if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null }
      flush()
    }
  })

  // 诊断文件（apply 末尾先写一次；命令/RPC 挂上后各自再写一次，便于定位"挂没挂上"）
  writeStatus()

  log('info', `已加载 · 5h ${cfg.fiveHourLimit.toLocaleString()} / 周 ${cfg.weeklyLimit.toLocaleString()} tokens · 档位 ${cfg.enforcement} · 命令 ${registeredCommands.join(',') || '待注册'} · ${file}`)
}
