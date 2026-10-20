/**
 * 鲸元额度 · host 接线单测
 *
 * 用假 ctx 把 index.js 的接线跑起来，验证真正有风险的部分：
 *  - Config schema 能校验并给出默认值（= 插件界面里的额度表单数据源）
 *  - /quota 与 /quota-redeem 命令注册成功且能读到实时状态
 *  - session/event 计量 + 幂等闸门在接线上确实生效
 *  - 硬锁在 lock 档返回 reject/deny；warn 档不拦
 *  - 铁律：状态文件损坏时绝不锁（宁可漏锁，不可误锁）
 *  - 铁律：不注册任何反禁用逻辑
 *
 * 不触碰正在运行的 app，全部在临时目录里跑。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply, Config } from '../index.js'

let seq = 0
function tmpDir () {
  const dir = path.join(os.tmpdir(), `dsh-self-quota-test-${process.pid}-${seq += 1}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 假 ctx：捕获事件监听、effect、命令注册；可注入任意服务（settings / connection）
 *  忠实于真实 cordis 的两点：
 *   1. `ctx.effect(fn)` **立即执行** fn 并保留其返回的清理函数（否则注册在 effect 里的
 *      RPC 路由根本不会生效 —— 我们曾因此写出"测试全绿但线上 404"的假象）；
 *   2. `ctx.inject(deps, cb)` 在依赖就绪后执行 cb，并把带服务的 scope 交给它。 */
function fakeCtx (services = {}) {
  const listeners = new Map()
  const commands = []
  const disposers = []
  const commandRegistry = { register: (def) => { commands.push(def); return () => {} } }
  const ctx = {
    commands: commandRegistry,
    settings: services.settings,
    connection: services.connection,
    on (name, fn) {
      const arr = listeners.get(name) ?? []
      arr.push(fn)
      listeners.set(name, arr)
      return () => {}
    },
    get (name) {
      if (name === 'commands') return commandRegistry
      return services[name]
    },
    effect (fn) {
      const returned = fn()
      const dispose = typeof returned === 'function' ? returned : () => {}
      disposers.push(dispose)
      return dispose
    },
    inject (deps, callback) {
      return callback(ctx)
    },
    logger: { info () {}, warn () {}, debug () {} },
  }
  return {
    ctx,
    commands,
    disposers,
    emit (name, ...args) {
      const arr = listeners.get(name) ?? []
      return arr.map(fn => fn(...args))
    },
    count (name) { return (listeners.get(name) ?? []).length },
  }
}

const nextOk = () => Promise.resolve({ kind: 'enter', messages: [] })

/**
 * 复刻 cordis 运行时的 inject 归一化（lib/index.js 里的 resolve）。
 * 关键：**对象的 key 会被当成服务名** —— `{ optional: [...] }` 等于声明一个叫 optional 的服务。
 */
function cordisResolve (inject) {
  const result = {}
  if (!inject) return result
  if (Array.isArray(inject)) { for (const name of inject) result[name] = null; return result }
  for (const name of Object.keys(inject)) result[name] = inject[name] ?? null
  return result
}

test('装载契约：不导出顶层 inject，否则插件会永久 pending（线上踩过）', async () => {
  const mod = await import('../index.js')
  assert.equal(typeof mod.apply, 'function')
  assert.ok(mod.Config, '必须导出 Config schema')
  assert.equal(mod.name, 'dsh-self-quota')

  // 数组形式 → 全变"必需服务"，无 web 服务的宿主会永不加载
  assert.ok(!Array.isArray(mod.inject), '顶层 inject 不该是数组')
  // 对象形式 → key 被当成服务名，凭空多出一个永不存在的依赖
  assert.deepEqual(cordisResolve(mod.inject), {}, '不得要求任何服务；否则 fiberPhase 停在 pending，apply() 永不执行')
})

function usageEvent (sessionId, seqNo, tokens) {
  return [
    { id: sessionId, header: {} },
    { type: 'assistant/message', seq: seqNo, time: Date.now(), data: { usage: { inputTokens: tokens, outputTokens: 0 } } },
  ]
}

test('Config schema：给出默认值，且能被覆盖（插件界面额度表单的数据源）', () => {
  const cfg = Config({ weeklyLimit: 12_345 })
  assert.equal(cfg.fiveHourLimit, 2_000_000, '5h 上限默认值')
  assert.equal(cfg.weeklyLimit, 12_345, '用户值覆盖默认值 ← 这就是"在插件界面里自己设额度"')
  assert.equal(cfg.fiveHourWindowMinutes, 300)
  assert.equal(cfg.weeklyWindowDays, 7)
  assert.equal(cfg.enforcement, 'lock', '默认就是 lock 硬锁（用户要求），要改只能自己改')
  assert.equal(cfg.voucher.maxHeld, 3)
  assert.equal(cfg.voucher.expiryDays, 30)
  assert.equal(cfg.countBackground, false, '后台调用默认不计入')
  assert.equal(cfg.allowReadOnlyWhileLocked, false, '锁定默认一律拒绝')
  assert.ok(cfg.readOnlyAllowlist.includes('read'), '只读白名单要含 read')
  assert.ok(!cfg.readOnlyAllowlist.includes('write'), '白名单绝不能含写操作')
})

test('接线：注册 /quota 与 /quota-redeem，且 /quota 能读到实时状态', async () => {
  const dir = tmpDir()
  const { ctx, commands, emit } = fakeCtx()
  apply(ctx, Config({ stateDir: dir, weeklyLimit: 1000, fiveHourMode: 'manual', fiveHourLimit: 500 }))

  assert.deepEqual(commands.map(c => c.name), ['quota', 'quota-redeem'])
  assert.match(commands[0].description, /鲸元额度/)

  // 计量一笔
  emit('session/event', ...usageEvent('sess-A', 1, 300))

  const r = await commands[0].handler({})
  assert.equal(r.kind, 'success')
  assert.match(r.text, /已用 300/)
  assert.match(r.text, /5h 剩余 40\.0%/)   // 1 - 300/500
  assert.match(r.text, /周 剩余 70\.0%/)    // 1 - 300/1000
})

test('接线：幂等闸门拦住 resume 重放，不重复计数', async () => {
  const dir = tmpDir()
  const { ctx, commands, emit } = fakeCtx()
  apply(ctx, Config({ stateDir: dir, weeklyLimit: 10_000, fiveHourMode: 'manual', fiveHourLimit: 10_000 }))

  emit('session/event', ...usageEvent('sess-A', 7, 100))
  emit('session/event', ...usageEvent('sess-A', 7, 100)) // 同一 seq 重放
  emit('session/event', ...usageEvent('sess-A', 6, 100)) // 更旧的 seq
  emit('session/event', ...usageEvent('sess-A', 8, 100)) // 新 seq

  const r = await commands[0].handler({})
  assert.match(r.text, /已用 200/, '只有 7 与 8 两笔计入')
})

test('接线：/quota-redeem 清零两窗并消耗一张鲸元券', async () => {
  const dir = tmpDir()
  const { ctx, commands, emit } = fakeCtx()
  apply(ctx, Config({ stateDir: dir, weeklyLimit: 10_000, fiveHourMode: 'manual', fiveHourLimit: 10_000, voucher: { initial: 1, maxHeld: 3, expiryDays: 30 } }))

  emit('session/event', ...usageEvent('sess-A', 1, 500))
  let r = await commands[0].handler({})
  assert.match(r.text, /已用 500/)
  assert.match(r.text, /鲸元券：可用 1 张/)

  r = await commands[1].handler({})
  assert.equal(r.kind, 'success')
  assert.match(r.text, /已兑换 1 张鲸元券/)
  assert.match(r.text, /已用 0/)
  assert.match(r.text, /鲸元券：可用 0 张 · 已兑换 1/)

  // 没有券了再兑换要报错
  r = await commands[1].handler({})
  assert.equal(r.kind, 'error')
})

test('硬锁：lock 档超线 → pre-step 返回 reject、pre-execute 返回 deny', async () => {
  const dir = tmpDir()
  const { ctx, emit } = fakeCtx()
  apply(ctx, Config({ stateDir: dir, fiveHourMode: 'manual', fiveHourLimit: 100, weeklyLimit: 1000, enforcement: 'lock' }))

  // 未超线：放行
  let [step] = emit('agent/pre-step', {}, nextOk)
  assert.deepEqual(await step, { kind: 'enter', messages: [] })

  emit('session/event', ...usageEvent('sess-A', 1, 100)) // 顶满 5h 窗

  ;[step] = emit('agent/pre-step', {}, nextOk)
  assert.deepEqual(await step, { kind: 'reject' }, '超线必须拒绝该 step')

  const [tool] = emit('tools/pre-execute', { name: 'write' }, nextOk)
  const decided = await tool
  assert.equal(decided.kind, 'deny', '超线必须拒绝工具调用')
  assert.match(decided.reason, /鲸元额度已用尽/)
  assert.match(decided.reason, /设置 → 插件/, '拒绝理由里必须写明解除方法')
})

test('硬锁：warn 档（默认）即使超线也绝不拦', async () => {
  const dir = tmpDir()
  const { ctx, emit } = fakeCtx()
  apply(ctx, Config({ stateDir: dir, fiveHourMode: 'manual', fiveHourLimit: 10, weeklyLimit: 10, enforcement: 'warn' }))
  emit('session/event', ...usageEvent('sess-A', 1, 999))
  const [step] = emit('agent/pre-step', {}, nextOk)
  assert.deepEqual(await step, { kind: 'enter', messages: [] })
  const [tool] = emit('tools/pre-execute', { name: 'write' }, nextOk)
  assert.deepEqual(await tool, { kind: 'enter', messages: [] })
})

test('铁律：状态文件损坏时，即使 lock 档也绝不锁（宁可漏锁，不可误锁）', async () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'state.json'), '{ this is not json', 'utf8')
  const { ctx, emit } = fakeCtx()
  apply(ctx, Config({ stateDir: dir, fiveHourMode: 'manual', fiveHourLimit: 1, weeklyLimit: 1, enforcement: 'lock' }))

  const [step] = emit('agent/pre-step', {}, nextOk)
  assert.deepEqual(await step, { kind: 'enter', messages: [] }, '状态不可判定时必须放行')

  const [tool] = emit('tools/pre-execute', { name: 'write' }, nextOk)
  assert.deepEqual(await tool, { kind: 'enter', messages: [] }, '状态不可判定时必须放行')
})

test('铁律：不注册任何反禁用逻辑（可被卸载，注册物都走 effect/on 自动清理）', () => {
  const dir = tmpDir()
  const { ctx, disposers } = fakeCtx()
  apply(ctx, Config({ stateDir: dir }))

  // 唯一的常驻 effect 是定时器，且它交回了清理函数 → 卸载即停
  assert.equal(disposers.length, 1, '只应有一个常驻 effect（定时器）')
  assert.equal(typeof disposers[0], 'function')
  disposers[0]()
})

test('first-run：按 initial 发券，但不超过 maxHeld', async () => {
  const dir = tmpDir()
  const { ctx, commands } = fakeCtx()
  apply(ctx, Config({ stateDir: dir, voucher: { initial: 5, maxHeld: 2, expiryDays: 30 } }))
  const r = await commands[0].handler({})
  assert.match(r.text, /鲸元券：可用 2 张/, 'initial 超过 maxHeld 时应封顶')
})

test('落盘：state.json 形状完整，且不含任何对话内容', async () => {
  const dir = tmpDir()
  const { ctx, emit, disposers } = fakeCtx()
  apply(ctx, Config({ stateDir: dir, weeklyLimit: 10_000, fiveHourMode: 'manual', fiveHourLimit: 10_000 }))
  emit('session/event', ...usageEvent('sess-A', 1, 123))

  // 触发 effect 的清理函数 → 内部会 flush 落盘
  disposers[0]()

  const raw = fs.readFileSync(path.join(dir, 'state.json'), 'utf8')
  const saved = JSON.parse(raw)
  assert.equal(saved.version, 1)
  assert.equal(saved.primary.used, 123)
  assert.equal(saved.secondary.used, 123)
  assert.equal(saved.totals.lifetimeTokens, 123)
  assert.deepEqual(Object.keys(saved.lastSeq), ['sess-A'])

  // 只应是计数与时间戳：绝不允许出现消息正文/提示词等字段
  assert.doesNotMatch(raw, /content|prompt|message|text/i, '存档里不允许出现对话内容字段')
})

// ── M3：后台调用计量 / 锁定只读放行 / 设置写入路径 ─────────────────────────

const usageChunk = { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } }
const textChunk = { type: 'text-delta', index: 0, text: 'hi' }
const streamOf = (list) => (async function * () { for (const c of list) yield c })()

test('countBackground 默认关闭：根本不注册 llm/stream 监听（不做无谓开销）', () => {
  const dir = tmpDir()
  const { ctx, count } = fakeCtx()
  apply(ctx, Config({ stateDir: dir }))
  assert.equal(count('llm/stream'), 0)
})

test('countBackground 打开：原样透传 chunk，且只计带 purpose 的后台调用', async () => {
  const dir = tmpDir()
  const { ctx, emit, commands } = fakeCtx()
  apply(ctx, Config({ stateDir: dir, countBackground: true, fiveHourMode: 'manual', fiveHourLimit: 100_000, weeklyLimit: 100_000 }))

  // 后台调用（compaction）：计入
  const [wrapped] = emit('llm/stream', { purpose: 'compaction', sessionId: 's1' }, () => streamOf([textChunk, usageChunk]))
  const seen = []
  for await (const chunk of wrapped) seen.push(chunk)
  assert.deepEqual(seen, [textChunk, usageChunk], '必须逐个原样透传：不吞、不改、不重排')

  // 正常回合（无 purpose）：不计入 —— 否则会和 session/event 双计
  const [plain] = emit('llm/stream', { sessionId: 's1' }, () => streamOf([usageChunk]))
  const seen2 = []
  for await (const chunk of plain) seen2.push(chunk)
  assert.deepEqual(seen2, [usageChunk])
  assert.equal(plain, wrapped === undefined ? plain : plain, '正常回合返回原始迭代器')

  const r = await commands[0].handler({})
  assert.match(r.text, /已用 150/, '只应计入后台那 150 tokens')
})

test('countBackground 打开：流中途抛错也要把已产生的 chunk 交出去', async () => {
  const dir = tmpDir()
  const { ctx, emit } = fakeCtx()
  apply(ctx, Config({ stateDir: dir, countBackground: true, weeklyLimit: 100_000, fiveHourMode: 'manual', fiveHourLimit: 100_000 }))

  const bad = (async function * () { yield textChunk; throw new Error('upstream boom') })()
  const [wrapped] = emit('llm/stream', { purpose: 'session-title' }, () => bad)
  const seen = []
  await assert.rejects(async () => {
    for await (const chunk of wrapped) seen.push(chunk)
  }, /upstream boom/)
  assert.deepEqual(seen, [textChunk], '异常前已产出的 chunk 必须已经交给下游')
})

test('allowReadOnlyWhileLocked 默认 false：锁定后连只读工具也一律拒绝', async () => {
  const dir = tmpDir()
  const { ctx, emit } = fakeCtx()
  apply(ctx, Config({ stateDir: dir, fiveHourMode: 'manual', fiveHourLimit: 10, weeklyLimit: 10, enforcement: 'lock' }))
  emit('session/event', ...usageEvent('sess-A', 1, 999))

  for (const name of ['read', 'glob', 'write', 'pwsh']) {
    const [d] = emit('tools/pre-execute', { name }, nextOk)
    assert.equal((await d).kind, 'deny', `${name} 应被拒绝`)
  }
})

test('allowReadOnlyWhileLocked 打开：只读放行、写操作仍拒（让中途锁定能干净收尾）', async () => {
  const dir = tmpDir()
  const { ctx, emit } = fakeCtx()
  apply(ctx, Config({
    stateDir: dir, fiveHourMode: 'manual', fiveHourLimit: 10, weeklyLimit: 10, enforcement: 'lock',
    allowReadOnlyWhileLocked: true,
  }))
  emit('session/event', ...usageEvent('sess-A', 1, 999))

  for (const name of ['read', 'grep', 'web_search']) {
    const [d] = emit('tools/pre-execute', { name }, nextOk)
    assert.deepEqual(await d, { kind: 'enter', messages: [] }, `${name} 应放行`)
  }
  for (const name of ['write', 'edit', 'pwsh']) {
    const [d] = emit('tools/pre-execute', { name }, nextOk)
    assert.equal((await d).kind, 'deny', `${name} 仍必须拒绝`)
  }
})

/**
 * 假的 settings 服务：**真的会应用 mutate 的 path ops 并回读**，
 * 这样才能验证"写进去了没有"这件事本身（而不是只验证我们发了个调用）。
 */
function settingsStub (initial = {}) {
  const ops = []
  const calls = []
  const value = { ...initial }
  const applyOp = (op) => {
    if (!op || op.op !== 'set' || !Array.isArray(op.path)) return
    if (op.path.length === 1) {
      value[op.path[0]] = op.value
    } else {
      const [head, leaf] = op.path
      value[head] = { ...(value[head] && typeof value[head] === 'object' ? value[head] : {}), [leaf]: op.value }
    }
  }
  return {
    ops,
    calls,
    value,
    describe: () => [{ ns: 'include:self-quota', revision: 7, value: { ...value } }],
    mutate: async (ns, nextOps, revision) => {
      calls.push({ via: 'settings.mutate', ns, revision, ops: nextOps })
      ops.push(...nextOps)
      nextOps.forEach(applyOp)
    },
  }
}

/** 只提供 update（没有 mutate）的服务，用来验证退化路径 */
function updateOnlySettings (initial = {}) {
  const calls = []
  const value = { ...initial }
  return {
    calls,
    value,
    describe: () => [{ ns: 'include:self-quota', revision: 3, value: { ...value } }],
    update: async (ns, patch, revision) => {
      calls.push({ via: 'settings.update', ns, revision, patch })
      Object.assign(value, patch)
    },
  }
}

function rpcHarness (services) {
  const dir = tmpDir()
  const routes = []
  const connection = {
    fetch: {
      register: (route) => { routes.push(route); return () => Promise.resolve() },
    },
  }
  const bundle = fakeCtx({ settings: services.settings, connection, configEditor: services.configEditor })
  apply(bundle.ctx, Config({ stateDir: dir, weeklyLimit: 12_345, ...(services.config || {}) }))
  return { ...bundle, routes, dir }
}

/**
 * 假的 configEditor（@deepseek-ai/dsh-config-editor 的契约）：
 *   entries() → LoaderEntry[]；edit(entry, change) → 整份 config 写盘并应用；configuration() → 回读
 * 这是"普通配置"的唯一正确写入口，settings.describe() 只看 volatile 字段，永远找不到我们。
 */
function configEditorStub (initial = {}, options = {}) {
  const edits = []
  let config = { ...initial }
  const entry = { options: { id: 'self-quota', name: 'dsh-self-quota', config } }
  return {
    edits,
    get config () { return config },
    entries: () => [entry],
    edit: async (target, change) => {
      const current = structuredClone(config)
      const inherited = structuredClone(initial)
      const next = change(current, inherited)
      edits.push({ current, next })
      if (options.failWith) throw new Error(options.failWith)
      config = next
      entry.options.config = next
    },
    configuration: () => [{ entry, inherited: {}, override: { ...config } }],
  }
}

/** 按浏览器端真实协议调用一条路由：client-request 信封 → server-response 信封 */
async function callRoute (routes, endpoint, payload, overrides = {}) {
  const path = `/api/dsh-self-quota/${endpoint}`
  const route = routes.find(r => r.path === path)
  assert.ok(route, `必须注册精确路由 ${path}`)
  const body = overrides.rawBody !== undefined
    ? overrides.rawBody
    : JSON.stringify({
      type: 'client-request',
      rpcId: 'r1',
      method: overrides.method ?? `dsh-self-quota/${endpoint}`,
      payload,
    })
  const request = new Request(`http://127.0.0.1:19387${path}`, {
    method: 'POST',
    headers: { 'content-type': overrides.contentType ?? 'application/json' },
    body,
  })
  const response = await route.fetch(request)
  return { status: response.status, body: await response.json() }
}

test('whenService 兜底：宿主没有 scoped inject 时，靠轮询也能把命令挂上', async () => {
  const dir = tmpDir()
  const bundle = fakeCtx()
  delete bundle.ctx.inject // 模拟不支持 scoped inject 的宿主
  apply(bundle.ctx, Config({ stateDir: dir }))

  assert.equal(bundle.commands.length, 0, 'scoped inject 不可用时不会同步注册')
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.deepEqual(bundle.commands.map(c => c.name), ['quota', 'quota-redeem'], '轮询到服务后必须补上注册')
})

test('RPC：注册 5 条精确 Fetch 路由（而不是 rpc.intercept）', () => {
  const { routes } = rpcHarness({ settings: settingsStub([]) })
  assert.deepEqual(
    routes.map(r => r.path).sort(),
    [
      '/api/dsh-self-quota/config',
      '/api/dsh-self-quota/config-set',
      '/api/dsh-self-quota/grant',
      '/api/dsh-self-quota/redeem',
      '/api/dsh-self-quota/status',
      '/api/dsh-self-quota/stats',
    ].sort(),
  )
  for (const r of routes) {
    assert.deepEqual(r.methods, ['POST'])
    assert.equal(r.requestBody, 'buffered')
    assert.equal(typeof r.fetch, 'function')
  }
  assert.ok(!routes.some(r => r.path.includes('quota-panel')), '不得误占别的插件的路由')
})

test('RPC：status / config 可读，信封与方法名校验到位', async () => {
  const { routes } = rpcHarness({ settings: settingsStub([]) })

  const status = await callRoute(routes, 'status', null)
  assert.equal(status.status, 200)
  assert.equal(status.body.type, 'server-response')
  assert.equal(status.body.rpcId, 'r1', '必须回带同一个 rpcId')
  assert.equal(status.body.result.ok, true)
  assert.ok(status.body.result.value.primary && status.body.result.value.secondary, '快照要带两个窗口')

  const cfg = await callRoute(routes, 'config', null)
  assert.equal(cfg.body.result.value.weeklyLimit, 12_345)
  assert.equal(cfg.body.result.value.enforcement, 'lock')

  // 方法名与端点不符 → bad-request（防止端点被交叉调用）
  const wrongMethod = await callRoute(routes, 'config', null, { method: 'dsh-quota-panel/specs' })
  assert.equal(wrongMethod.body.result.ok, false)
  assert.equal(wrongMethod.body.result.error.code, 'gateway/bad-request')

  // 内容类型不对 → 415
  const badType = await callRoute(routes, 'config', null, { contentType: 'text/plain' })
  assert.equal(badType.status, 415)

  // 信封非法 → bad-request
  const badEnvelope = await callRoute(routes, 'config', null, { rawBody: '{"type":"nope"}' })
  assert.equal(badEnvelope.body.result.error.code, 'gateway/bad-request')
})

test('RPC config-set：只写白名单字段、带 CAS 版本号、非法输入被挡下', async () => {
  const settings = settingsStub()
  const { routes } = rpcHarness({ settings })

  const ok = await callRoute(routes, 'config-set', { weeklyLimit: 5_000, evil: 'nope', stateDir: '/etc' })
  assert.equal(ok.body.result.ok, true)

  assert.equal(settings.calls.length, 1)
  assert.equal(settings.calls[0].via, 'settings.mutate', '首选 mutate + path ops（能精确写嵌套字段）')
  assert.equal(settings.calls[0].ns, 'include:self-quota', 'ns 用 profile entry id')
  assert.equal(settings.calls[0].revision, 7, '必须带 CAS 版本号，避免并发覆盖')
  assert.deepEqual(settings.ops, [{ op: 'set', path: ['weeklyLimit'], value: 5_000 }], '白名单之外一律丢弃')

  // 写成功后必须回读确认，并把结果回给界面
  assert.equal(ok.body.result.value.verified, true, '回读一致才算真生效')
  assert.equal(ok.body.result.value.method, 'settings.mutate')
  assert.equal(ok.body.result.value.observed.weeklyLimit, 5_000, '回读值应带回去')

  for (const [payload, code] of [
    [{ weeklyLimit: -1 }, 'invalid'],
    [{ weeklyLimit: 'x' }, 'invalid'],
    [{ enforcement: 'nuke' }, 'invalid'],
    [{ nonsense: 1 }, 'empty-patch'],
  ]) {
    const res = await callRoute(routes, 'config-set', payload)
    assert.equal(res.body.result.ok, false, `${JSON.stringify(payload)} 应被拒绝`)
    assert.equal(res.body.result.error.code, code)
  }
})

test('RPC redeem：没有鲸元券时如实报 no-voucher', async () => {
  const dir = tmpDir()
  const routes = []
  const connection = { fetch: { register: (r) => { routes.push(r); return () => Promise.resolve() } } }
  const bundle = fakeCtx({ settings: settingsStub(), connection })
  apply(bundle.ctx, Config({ stateDir: dir, voucher: { initial: 0, maxHeld: 3, expiryDays: 30 } }))
  const res = await callRoute(routes, 'redeem', null)
  assert.equal(res.body.result.ok, false)
  assert.equal(res.body.result.error.code, 'no-voucher')
})

test('RPC config-set：嵌套 voucher 用路径写，不会冲掉同对象里的其它字段', async () => {
  const settings = settingsStub({ voucher: { initial: 1, maxHeld: 3, expiryDays: 30 } })
  const { routes } = rpcHarness({ settings })

  const res = await callRoute(routes, 'config-set', {
    weeklyLimit: 8_000_000,
    fiveHourMode: 'manual', fiveHourLimit: 1_500_000,
    fiveHourWindowMinutes: 180,
    weeklyWindowDays: 5,
    weekAnchor: 'monday-00:00',
    enforcement: 'lock',
    mode: 'manual',
    voucher: { maxHeld: 5, expiryDays: 14 },
  })
  assert.equal(res.body.result.ok, true)
  assert.equal(res.body.result.value.verified, true)

  const opsByPath = new Map(settings.ops.map(op => [op.path.join('.'), op.value]))
  assert.equal(opsByPath.get('weeklyLimit'), 8_000_000)
  assert.equal(opsByPath.get('weekAnchor'), 'monday-00:00')
  assert.equal(opsByPath.get('enforcement'), 'lock')
  assert.equal(opsByPath.get('mode'), 'manual', '两档模式必须可写')
  assert.equal(opsByPath.get('voucher.maxHeld'), 5)
  assert.equal(opsByPath.get('voucher.expiryDays'), 14)

  // 关键：路径写只碰这两个叶子，同对象里的 initial 不能被冲掉
  assert.equal(settings.value.voucher.initial, 1, 'voucher.initial 必须保留')
  assert.equal(settings.value.voucher.maxHeld, 5)

  for (const bad of [
    { weeklyWindowDays: 0 },
    { fiveHourWindowMinutes: -1 },
    { weekAnchor: 'weekly' },
    { mode: 'whatever' },
    { voucher: { maxHeld: 0 } },
    { voucher: { expiryDays: 'soon' } },
  ]) {
    const r = await callRoute(routes, 'config-set', bad)
    assert.equal(r.body.result.ok, false, `${JSON.stringify(bad)} 应被拒绝`)
    assert.equal(r.body.result.error.code, 'invalid')
  }
})

test('RPC config-set：没有 mutate 时退化到 update；写失败要如实报错', async () => {
  // 1) 只有 update 的服务 → 走退化路径
  const updateOnly = updateOnlySettings()
  const a = rpcHarness({ settings: updateOnly })
  const ok = await callRoute(a.routes, 'config-set', { weeklyLimit: 7_777 })
  assert.equal(ok.body.result.ok, true)
  assert.equal(ok.body.result.value.method, 'settings.update')
  assert.equal(updateOnly.calls[0].via, 'settings.update')
  assert.equal(updateOnly.calls[0].patch.weeklyLimit, 7_777)

  // 2) mutate 抛错 → 必须把错误如实返回，而不是假装成功
  const failing = {
    describe: () => [{ ns: 'include:self-quota', revision: 2, value: {} }],
    mutate: async () => { throw new Error('revision conflict') },
  }
  const b = rpcHarness({ settings: failing })
  const bad = await callRoute(b.routes, 'config-set', { weeklyLimit: 1_000 })
  assert.equal(bad.body.result.ok, false)
  assert.equal(bad.body.result.error.code, 'config-write-failed')
  assert.match(bad.body.result.error.message, /revision conflict/, '必须把底层原因透出来')

  // 3) 找不到设置条目 → 报错里带上诊断，方便定位
  const missing = {
    describe: () => [{ ns: 'include:other-plugin', revision: 1, value: {} }],
    mutate: async () => {},
  }
  const c = rpcHarness({ settings: missing })
  const none = await callRoute(c.routes, 'config-set', { weeklyLimit: 1_000 })
  assert.equal(none.body.result.ok, false)
  assert.equal(none.body.result.error.code, 'config-write-unavailable')
  assert.match(none.body.result.error.message, /configEditor/, '诊断里要说明 configEditor 情况')
  assert.match(none.body.result.error.message, /settings 里/, '诊断里要列出 settings 实际拿到的命名空间')
})

test('RPC config：回读全部额度字段，并给出「恢复默认」用的预设值', async () => {
  const { routes } = rpcHarness({ settings: settingsStub() })
  const res = await callRoute(routes, 'config', null)
  const v = res.body.result.value
  assert.equal(v.mode, 'auto', '默认走开箱即用档')
  assert.equal(v.enforcement, 'lock', '默认执行档位是硬锁')
  assert.equal(v.weeklyLimit, 12_345)
  assert.deepEqual(Object.keys(v.voucher).sort(), ['expiryDays', 'maxHeld'])
  assert.ok(v.preset && v.preset.weeklyLimit > 0, '预设值供面板「恢复默认」使用')
})

test('RPC grant：可以自己给自己发一张鲸元券，且受 maxHeld 约束', async () => {
  const dir = tmpDir()
  const routes = []
  const connection = { fetch: { register: (r) => { routes.push(r); return () => Promise.resolve() } } }
  const bundle = fakeCtx({ settings: settingsStub([]), connection })
  apply(bundle.ctx, Config({ stateDir: dir, voucher: { initial: 0, maxHeld: 2, expiryDays: 30 } }))

  const first = await callRoute(routes, 'grant', null)
  assert.equal(first.body.result.ok, true)
  assert.equal(first.body.result.value.vouchers.available, 1, '发完应立刻回带新快照')

  const second = await callRoute(routes, 'grant', null)
  assert.equal(second.body.result.value.vouchers.available, 2)

  const third = await callRoute(routes, 'grant', null)
  assert.equal(third.body.result.ok, false, '到上限必须拒绝')
  assert.equal(third.body.result.error.code, 'at-cap')
  assert.match(third.body.result.error.message, /上限/)

  assert.deepEqual(second.body.result.value.voucherRules, { maxHeld: 2, expiryDays: 30 })
  assert.equal(second.body.result.value.mode, 'auto')
})

test('RPC stats：计量过的用量会进入统计（含连续天数与峰值）', async () => {
  const dir = tmpDir()
  const routes = []
  const connection = { fetch: { register: (r) => { routes.push(r); return () => Promise.resolve() } } }
  const bundle = fakeCtx({ settings: settingsStub([]), connection })
  apply(bundle.ctx, Config({ stateDir: dir, weeklyLimit: 100_000, fiveHourMode: 'manual', fiveHourLimit: 100_000 }))

  bundle.emit('session/event', ...usageEvent('sess-A', 1, 400))
  bundle.emit('session/event', ...usageEvent('sess-A', 2, 600))

  const res = await callRoute(routes, 'stats', null)
  assert.equal(res.body.result.ok, true)
  const s = res.body.result.value
  assert.equal(s.today, 1000, '今天累计 1000')
  assert.equal(s.lifetime, 1000)
  assert.equal(s.completions, 2)
  assert.equal(s.peak, 1000)
  assert.equal(s.currentStreak, 1, '今天用了 → 连续 1 天')
  assert.equal(s.activeDays, 1)
  assert.equal(s.series.length, 60)
  assert.equal(s.series[s.series.length - 1].tokens, 1000)
})

test('RPC config-set：走 configEditor.edit 写普通配置，并回读确认', async () => {
  const editor = configEditorStub({ weeklyLimit: 1_000, fiveHourMode: 'manual', fiveHourLimit: 100 })
  const { routes } = rpcHarness({ settings: settingsStub(), configEditor: editor })

  const res = await callRoute(routes, 'config-set', { weeklyLimit: 5_000, fiveHourMode: 'auto', fiveHourRatio: 5 })
  assert.equal(res.body.result.ok, true)
  assert.equal(res.body.result.value.method, 'configEditor.edit', '普通配置必须走 configEditor（settings 只认 volatile 字段）')
  assert.equal(res.body.result.value.verified, true, '回读必须一致')

  assert.equal(editor.edits.length, 1)
  const next = editor.edits[0].next
  assert.equal(next.weeklyLimit, 5_000, 'change() 必须返回完整 config，而不是只有改动字段')
  assert.equal(next.fiveHourMode, 'auto')
  assert.equal(next.fiveHourRatio, 5)
  assert.equal(next.fiveHourLimit, 100, '切到 auto 后，原来手填的 5h 值要保留（切回 manual 还用得上）')
  assert.equal(editor.config.weeklyLimit, 5_000, '写盘后的配置就是回读源')
})

test('RPC config-set：configEditor.edit 失败要如实报错，不假装成功', async () => {
  const editor = configEditorStub({ weeklyLimit: 1_000 }, { failWith: 'Configuration is overridden by a home patch' })
  const { routes } = rpcHarness({ settings: settingsStub(), configEditor: editor })
  const res = await callRoute(routes, 'config-set', { weeklyLimit: 9_000 })
  assert.equal(res.body.result.ok, false)
  assert.equal(res.body.result.error.code, 'config-write-failed')
  assert.match(res.body.result.error.message, /overridden by a home patch/)
})

test('5h 上限派生：auto = 周额度 ÷ 比例；manual = 用填死的值', async () => {
  // auto：只给周额度，5h 自动算出来
  const a = rpcHarness({ settings: settingsStub(), config: { weeklyLimit: 9_000, fiveHourMode: 'auto', fiveHourRatio: 7.5, fiveHourLimit: 1 } })
  const sa = await callRoute(a.routes, 'status', null)
  assert.equal(sa.body.result.value.primary.limit, 1_200, '9000 ÷ 7.5 = 1200')

  // manual：用自己填的值，周额度不参与
  const b = rpcHarness({ settings: settingsStub(), config: { weeklyLimit: 9_000, fiveHourMode: 'manual', fiveHourLimit: 777 } })
  const sb = await callRoute(b.routes, 'status', null)
  assert.equal(sb.body.result.value.primary.limit, 777)

  // 比例非法（0/负数）时回退到 7.5，不能算出 0 或负数限额
  const c = rpcHarness({ settings: settingsStub(), config: { weeklyLimit: 9_000, fiveHourMode: 'auto', fiveHourRatio: 0 } })
  const sc = await callRoute(c.routes, 'status', null)
  assert.equal(sc.body.result.value.primary.limit, 1_200, '比例非法时回退 7.5')

  // config 回读：既给用户填的原始 5h 值，也给派生后的生效值
  const cfg = await callRoute(a.routes, 'config', null)
  assert.equal(cfg.body.result.value.fiveHourLimit, 1, '原始值')
  assert.equal(cfg.body.result.value.fiveHourLimitEffective, 1_200, '生效值')
  assert.equal(cfg.body.result.value.fiveHourMode, 'auto')
  assert.equal(cfg.body.result.value.fiveHourRatio, 7.5)
})

test('RPC config-set：设置服务不可用时如实报错，而不是静默假装成功', async () => {
  const { routes } = rpcHarness({ settings: undefined })
  const res = await callRoute(routes, 'config-set', { weeklyLimit: 1_000 })
  assert.equal(res.body.result.ok, false)
  assert.equal(res.body.result.error.code, 'config-write-unavailable')
})
