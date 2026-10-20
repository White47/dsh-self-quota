/**
 * client 半体 · 契约单测
 *
 * 不需要浏览器：用假的 window.__ModuleLoader__ / document / require("react")，
 * 验证客户端半体的结构与挂载行为是否符号宿主约定：
 *  - 以 { id, factory } 形式注册到 __ModuleLoader__
 *  - 导出 apply 与 inject（slots / connection / locale）
 *  - apply() 注入样式、注册 i18n 词典，并挂到两个 slot：
 *      sidebar.footer.action（左下角进度环）+ shell.overlay（展开面板）
 *  - 全程只 require("react")，不依赖任何打包器
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

/** 每个用例一套全新全局环境；query 参数用于绕过 ESM 缓存，让脚本重新执行 */
function makeEnv () {
  const loaded = []
  const appended = []
  const removed = []
  globalThis.window = {
    __ModuleLoader__: { load: def => loaded.push(def) },
    innerWidth: 1280,
    innerHeight: 800,
  }
  globalThis.document = {
    hidden: false,
    createElement: () => ({ dataset: {}, textContent: '', remove: () => removed.push(1) }),
    head: { append: el => appended.push(el) },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  return { loaded, appended, removed }
}

/** 极简 React 替身：apply() 期间只用 createElement；渲染回调里的 hooks 走空实现 */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
}

function fakeCtx (services = {}) {
  const disposers = []
  const slots = []
  const injected = []
  const dicts = {}
  const rpcCalls = []
  return {
    disposers, slots, injected, dicts, rpcCalls,
    ctx: {
      // 忠实于 cordis：effect 回调立即执行，返回值作为清理函数
      effect: (fn) => {
        const returned = fn()
        const dispose = typeof returned === 'function' ? returned : () => {}
        disposers.push(dispose)
        return dispose
      },
      locale: {
        register: (ns, dict) => { dicts[ns] = dict; return () => {} },
        bind: (ns) => (key, params) => {
          const raw = (dicts[ns]?.zh ?? {})[key] ?? key
          return params
            ? String(raw).replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m))
            : raw
        },
      },
      connection: services.connection || {
        rpc: {
          call: (channel, endpoint, payload) => {
            rpcCalls.push([channel, endpoint, payload])
            return Promise.resolve({ ok: true, value: null })
          },
        },
      },
      slots: {
        inject: (name, fn) => { injected.push(name); return fn() },
        register: (meta, render) => { slots.push({ meta, render }); return () => {} },
      },
    },
  }
}

/** 载入一份全新的 client 半体实例（query 变化 → 模块重新执行） */
async function loadClient (tag) {
  const env = makeEnv()
  const required = []
  globalThis.__require = (name) => { required.push(name); return fakeReact }
  await import(`../client.js?case=${tag}`)
  assert.equal(env.loaded.length, 1, `${tag}: 必须恰好调用一次 __ModuleLoader__.load`)
  return { env, required, def: env.loaded[0] }
}

/**
 * apply() 之后必须把 effect 交回的清理函数收干净 ——
 * client 半体会起一个轮询 setInterval，不清掉 Node 进程不会退出。
 */
const liveDisposers = []
function applyClient (mod) {
  const bundle = fakeCtx()
  mod.apply(bundle.ctx)
  liveDisposers.push(...bundle.disposers)
  return bundle
}
test.afterEach(() => {
  while (liveDisposers.length) {
    const dispose = liveDisposers.pop()
    try { dispose() } catch { /* 清理失败不影响断言结果 */ }
  }
})

test('client 半体：注册契约与导出形状', async () => {
  const { required, def } = await loadClient('shape')
  assert.equal(def.id, 'dsh-self-quota', 'id 必须与包名一致，否则宿主对不上')
  assert.equal(typeof def.factory, 'function')

  const mod = def.factory(globalThis.__require)
  assert.equal(typeof mod.apply, 'function', '必须导出 apply')
  assert.ok(Array.isArray(mod.inject), '必须导出 inject 数组')
  for (const svc of ['slots', 'connection', 'locale']) {
    assert.ok(mod.inject.includes(svc), `inject 必须声明 ${svc}`)
  }
  assert.deepEqual(required, ['react'], '只允许 require("react")：宿主提供，插件不可自带打包依赖')
})

test('client 半体：注入主题样式、注册中英词典、挂到三个 slot', async () => {
  const { env, def } = await loadClient('apply')
  const mod = def.factory(globalThis.__require)
  const { disposers, slots, injected, dicts } = applyClient(mod)

  // 1) 样式：注入时必须用宿主主题 token，卸载时必须能移除
  assert.ok(disposers.length >= 3, '至少应有 样式 / i18n / 轮询 三个 effect')
  assert.equal(env.appended.length, 1, '应注入一个 <style> 标签')
  assert.match(String(env.appended[0].textContent), /--dsw-alias|--dsw-static/, '必须使用宿主主题 token')
  assert.equal(typeof disposers[0], 'function')
  disposers[0]()
  assert.equal(env.removed.length, 1, '卸载时必须移除样式标签')

  // 2) i18n
  assert.ok(dicts['self-quota']?.zh && dicts['self-quota']?.en, '必须注册中英两套词条')

  // 3) 四个挂载点
  assert.deepEqual(
    injected,
    ['sidebar.footer.action', 'shell.overlay', 'settings.general.item', 'plugins.row.config'],
    '必须挂到 左下角 + 浮层 + 设置通用行 + 插件列表页',
  )
  assert.equal(slots.length, 4)
  assert.equal(slots[0].meta.name, 'sidebar.footer.action')
  assert.equal(slots[0].meta.id, 'self-quota')
  assert.equal(slots[1].meta.name, 'shell.overlay')
  assert.equal(slots[1].meta.id, 'self-quota-panel')
  assert.equal(slots[2].meta.name, 'settings.general.item')
  assert.equal(slots[2].meta.id, 'self-quota-weekly')
  assert.equal(slots[2].meta.order, 40, '插在 performance-usage(30) 与 session-log(90) 之间')
  assert.equal(slots[3].meta.name, 'plugins.row.config')
  assert.equal(slots[3].meta.key, 'dsh-self-quota#self-quota', 'keyed slot 的 key = 包名#row id')
  for (const s of slots) {
    assert.equal(typeof s.render, 'function', '每个 slot 都要有 render')
  }
  for (const s of [slots[0], slots[1]]) {
    assert.equal(typeof s.meta.label, 'function', 'label 用 thunk，便于跟随语言切换')
  }
})

test('client 半体：轮询走宿主 /api 通道，且清理函数可安全调用', async () => {
  const { def } = await loadClient('poll')
  const mod = def.factory(globalThis.__require)
  const { disposers, rpcCalls } = applyClient(mod)

  await new Promise(r => setTimeout(r, 20))
  assert.ok(rpcCalls.some(c => c[1] === 'dsh-self-quota/status'), 'apply 后应立即拉一次状态')
  assert.equal(rpcCalls[0][0], '/api', '必须走宿主的 /api 通道')

  const pollCleanup = disposers[2]
  assert.equal(typeof pollCleanup, 'function')
  pollCleanup()
})

test('client 半体：未展开时不留浮层，左下角图标宽/窄两态都可渲染', async () => {
  const { def } = await loadClient('render')
  const mod = def.factory(globalThis.__require)
  const { slots } = applyClient(mod)

  const [footer, panel] = slots

  // shell.overlay 这个 slot 始终渲染 PanelHost；未展开时由 PanelHost 自己返回 null（不残留浮层）
  const panelEl = panel.render({})
  assert.equal(typeof panelEl.type, 'function', 'slot 渲染的是 PanelHost 组件')
  assert.equal(panelEl.type(panelEl.props), null, '未展开时不应渲染任何内容')

  // 左下角图标：展开态 = 进度环 + 百分比；收起态（56px 轨道）= 只留进度环
  const wideHost = footer.render({ wide: true })
  assert.equal(typeof wideHost.type, 'function', 'slot 渲染的是 FooterAction 组件')
  const wideEl = wideHost.type(wideHost.props)
  assert.equal(wideEl.type, 'button', '左下角图标必须是按钮')
  assert.equal(wideEl.children[1].type, 'span', '展开态要带百分比文字')

  const railHost = footer.render({ wide: false })
  const railEl = railHost.type(railHost.props)
  assert.equal(railEl.type, 'button', '侧栏收起时也要能渲染')
  assert.equal(railEl.children[1], null, '收起态不显示百分比文字，只留环')
})

test('client 半体：设置通用行可渲染，且用的是 config / config-set 端点', async () => {
  const { def } = await loadClient('general')
  const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(src, /dsh-self-quota\/config'/, '读当前值必须走 config 端点')
  assert.match(src, /dsh-self-quota\/config-set/, '写值必须走 config-set 端点')

  const mod = def.factory(globalThis.__require)
  const { slots } = applyClient(mod)

  const host = slots[2].render()
  const el = host.type(host.props)
  assert.equal(el.type, 'div', '设置行必须有渲染输出')
  assert.equal(el.children.length, 2, '两行：周额度 + 执行档位')
  // 第一行含 label / 提示 / 输入框 / 保存按钮
  const firstRowCtl = el.children[0].children[1]
  assert.equal(firstRowCtl.children[0].type, 'input', '周额度是数字输入框')
  assert.equal(firstRowCtl.children[1].type, 'button', '带保存按钮')
  // 第二行是执行档位下拉
  const secondRowCtl = el.children[1].children[1]
  assert.equal(secondRowCtl.children[0].type, 'select')
})

test('client 半体：面板含两档切换、手动发券、全套额度编辑', async () => {
  const { def } = await loadClient('panel')
  const mod = def.factory(globalThis.__require)

  const snapshot = {
    now: Date.now(),
    primary: { label: '5h', limit: 1000, used: 100, remaining: 0.9, resetsAt: null, open: false },
    secondary: { label: '周', limit: 10000, used: 100, remaining: 0.99, resetsAt: null, open: false, mode: 'auto' },
    vouchers: { available: 1, expired: 0, redeemed: 0 },
    enforcement: 'warn',
    mode: 'manual',
    voucherRules: { maxHeld: 3, expiryDays: 30 },
    official: null,
  }
  const config = {
    mode: 'manual',
    weeklyLimit: 10000,
    fiveHourLimit: 1000,
    fiveHourWindowMinutes: 300,
    weeklyWindowDays: 7,
    weekAnchor: 'first-use',
    enforcement: 'warn',
    voucher: { maxHeld: 3, expiryDays: 30 },
    preset: {
      weeklyLimit: 15000000, fiveHourLimit: 2000000, fiveHourWindowMinutes: 300,
      weeklyWindowDays: 7, weekAnchor: 'first-use', enforcement: 'warn',
      voucherMaxHeld: 3, voucherExpiryDays: 30,
    },
  }

  const calls = []
  makeEnv()
  globalThis.__require = () => fakeReact
  const bundle = fakeCtx({
    connection: {
      rpc: {
        call: (channel, endpoint, payload) => {
          calls.push([channel, endpoint, payload])
          if (endpoint === 'dsh-self-quota/status') return Promise.resolve({ ok: true, value: snapshot })
          if (endpoint === 'dsh-self-quota/config') return Promise.resolve({ ok: true, value: config })
          return Promise.resolve({ ok: true, value: snapshot })
        },
      },
    },
  })
  mod.apply(bundle.ctx)
  liveDisposers.push(...bundle.disposers)
  await new Promise(resolve => setTimeout(resolve, 10)) // 等首轮 poll 把 store 填上

  const [footer, panel] = bundle.slots

  // 点左下角图标 → store.open = true
  const footerEl = footer.render({ wide: true })
  footerEl.type(footerEl.props).props.onClick()

  const panelHost = panel.render()          // element ← PanelHost
  const panelComp = panelHost.type(panelHost.props)   // element ← Panel
  const panelEl = panelComp.type(panelComp.props)     // element ← 'div'（真正的面板）
  assert.equal(panelEl.type, 'div')
  assert.equal(panelEl.props.id, 'dsq-panel')

  // 面板的 body 是作为一个数组传进 createElement 的，先摊平
  const kids = panelEl.children.flat(Infinity)

  // 左下角面板必须保持"只显示额度"：两条进度条 + 券操作，不放配置项
  const rows = kids.filter(c => c && typeof c.type === 'function' && c.type.name === 'Row')
  assert.equal(rows.length, 2, '面板应只有两条进度条（5h / 周）')
  assert.ok(!kids.some(c => c && c.props && c.props.className === 'dsq-seg'), '面板里不该有两档切换（那属于插件列表）')
  assert.ok(!kids.some(c => c && typeof c.type === 'function' && c.type.name === 'EditForm'), '面板里不该有额度编辑表单')

  const buttons = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'button') buttons.push(node)
    for (const child of (node.children || [])) walk(child)
  }
  kids.forEach(walk)
  const labels = buttons.map(b => (b.children || []).filter(x => typeof x === 'string').join(''))
  assert.ok(labels.some(l => l.includes('使用一张')), '左下角必须保留「使用一张」')
  assert.ok(!labels.some(l => l.includes('给自己发一张')), '左下角不该出现「给自己发一张」（配置行为，放插件页）')
})

/** 极简"有状态"React：让 useState/useEffect 真的生效，才能验证异步加载后的渲染 */
function makeMiniReact () {
  const holders = new Map()
  let order = 0
  let current = null
  const R = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => {
      const idx = order
      order += 1
      if (current[idx] === undefined) current[idx] = typeof init === 'function' ? init() : init
      return [current[idx], (v) => { current[idx] = typeof v === 'function' ? v(current[idx]) : v }]
    },
    useEffect: (fn) => { fn() },
    useRef: () => ({ current: null }),
    render: (Component, props) => {
      const key = Component.name || 'anon'
      if (!holders.has(key)) holders.set(key, [])
      current = holders.get(key)
      order = 0
      return Component(props)
    },
  }
  return R
}

/** 收集渲染树里的所有字符串 */
function collectText (node, out = []) {
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (!node || typeof node !== 'object') return out
  for (const child of (node.children || [])) collectText(child, out)
  return out
}

test('client 半体：旧版宿主回读缺字段时，不崩也不卡在「读取中」', async () => {
  const { def } = await loadClient('legacy')
  const mini = makeMiniReact()
  const mod = def.factory(() => mini)

  // 模拟"宿主半体还是旧版本"：configView 里没有 voucher / preset
  const legacyConfig = {
    weeklyLimit: 1000,
    fiveHourLimit: 100,
    fiveHourWindowMinutes: 300,
    weeklyWindowDays: 7,
    weekAnchor: 'first-use',
    enforcement: 'warn',
  }
  const snapshot = {
    now: Date.now(),
    primary: { label: '5h', limit: 100, used: 0, remaining: 1, resetsAt: null, open: false },
    secondary: { label: '周', limit: 1000, used: 0, remaining: 1, resetsAt: null, open: false, mode: 'auto' },
    vouchers: { available: 1, expired: 0, redeemed: 0 },
    enforcement: 'warn',
    mode: 'manual',
    voucherRules: { maxHeld: 3, expiryDays: 30 },
    official: null,
  }

  makeEnv()
  const bundle = fakeCtx({
    connection: {
      rpc: {
        call: (channel, endpoint) => Promise.resolve({
          ok: true,
          value: endpoint.endsWith('/config') ? legacyConfig : snapshot,
        }),
      },
    },
  })
  mod.apply(bundle.ctx)
  liveDisposers.push(...bundle.disposers)

  const pageHost = bundle.slots[3].render({ view: 'page' })
  const pageEl = mini.render(pageHost.type, pageHost.props)
  const formEl = (pageEl.children || []).flat(Infinity)
    .find(c => c && typeof c.type === 'function' && c.type.name === 'EditForm')
  assert.ok(formEl, '插件页应含额度编辑表单')

  // 第一次渲染：还在等 config
  mini.render(formEl.type, formEl.props)
  await new Promise(resolve => setTimeout(resolve, 20))
  // 再渲染一次：必须已经渲染出表单，而不是永远"读取中"
  const after = mini.render(formEl.type, formEl.props)
  const text = collectText(after).join('|')
  assert.ok(!text.includes('读取中'), `不该卡在读取中，实际：${text}`)
  assert.ok(text.includes('周额度'), `应当渲染出字段，实际：${text}`)
  assert.ok(text.includes('券上限'), '缺 voucher 字段时应回退到默认值而不是崩掉')
})

test('client 半体：插件列表那一页承载两档模式与全部额度编辑', async () => {
  const { def } = await loadClient('pluginpage')
  const mod = def.factory(globalThis.__require)

  const snapshot = {
    now: Date.now(),
    primary: { label: '5h', limit: 1000, used: 100, remaining: 0.9, resetsAt: null, open: false },
    secondary: { label: '周', limit: 10000, used: 100, remaining: 0.99, resetsAt: null, open: false, mode: 'auto' },
    vouchers: { available: 1, expired: 0, redeemed: 0 },
    enforcement: 'warn',
    mode: 'manual',
    voucherRules: { maxHeld: 3, expiryDays: 30 },
    official: null,
  }
  const config = {
    mode: 'manual',
    weeklyLimit: 10000,
    fiveHourLimit: 1000,
    fiveHourWindowMinutes: 300,
    weeklyWindowDays: 7,
    weekAnchor: 'first-use',
    enforcement: 'warn',
    voucher: { maxHeld: 3, expiryDays: 30 },
    preset: {
      weeklyLimit: 15000000, fiveHourLimit: 2000000, fiveHourWindowMinutes: 300,
      weeklyWindowDays: 7, weekAnchor: 'first-use', enforcement: 'warn',
      voucherMaxHeld: 3, voucherExpiryDays: 30,
    },
  }

  const calls = []
  makeEnv()
  globalThis.__require = () => fakeReact
  const bundle = fakeCtx({
    connection: {
      rpc: {
        call: (channel, endpoint, payload) => {
          calls.push([channel, endpoint, payload])
          if (endpoint === 'dsh-self-quota/status') return Promise.resolve({ ok: true, value: snapshot })
          if (endpoint === 'dsh-self-quota/config') return Promise.resolve({ ok: true, value: config })
          return Promise.resolve({ ok: true, value: snapshot })
        },
      },
    },
  })
  mod.apply(bundle.ctx)
  liveDisposers.push(...bundle.disposers)
  await new Promise(resolve => setTimeout(resolve, 10))

  const pageSlot = bundle.slots[3]
  assert.equal(pageSlot.meta.key, 'dsh-self-quota#self-quota')

  // view === 'summary' → 只回一行摘要
  const summary = pageSlot.render({ view: 'summary' })
  assert.equal(summary.type, 'span')
  assert.match(summary.children[0], /5h 90%/, `摘要应含两个窗口的百分比，实际：${summary.children[0]}`)

  // view === 'page' → 完整页面：两档切换 + 全部额度编辑
  const pageHost = pageSlot.render({ view: 'page' })
  const pageEl = pageHost.type(pageHost.props)
  assert.equal(pageEl.props.className, 'dsq-page')

  const pkids = (pageEl.children || []).flat(Infinity)
  const seg = pkids.find(c => c && c.props && c.props.className === 'dsq-seg')
  assert.ok(seg, '插件页必须有两档切换')
  assert.equal(seg.children.length, 2)
  assert.equal(seg.children[1].props.className, 'is-on', 'mode=manual 时第二档高亮')
  const form = pkids.find(c => c && typeof c.type === 'function' && c.type.name === 'EditForm')
  assert.ok(form, '插件页必须含额度编辑表单')
  const statsSection = pkids.find(c => c && typeof c.type === 'function' && c.type.name === 'StatsSection')
  assert.ok(statsSection, '插件页必须含用量统计区')

  // 字段覆盖与端点契约
  const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  for (const key of ['weeklyLimit', 'fiveHourLimit', 'fiveHourWindowMinutes', 'weeklyWindowDays', 'weekAnchor', 'enforcement', 'voucherMaxHeld', 'voucherExpiryDays']) {
    assert.ok(src.includes(key), `编辑表单必须覆盖字段 ${key}`)
  }
  assert.ok(src.includes("'dsh-self-quota/grant'"), '手动发券必须走 grant 端点')
  assert.ok(src.includes("'dsh-self-quota/stats'"), '用量统计必须走 stats 端点')
  assert.ok(src.includes("plugins.row.config"), '必须挂在插件列表的配置槽上')
  assert.ok(calls.some(c => c[1] === 'dsh-self-quota/status'), '应轮询 status')
})
