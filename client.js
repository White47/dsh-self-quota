/**
 * 鲸元额度 · client 半体（浏览器 bundle）
 *
 * 由 `dsh.client` manifest 声明，DSH 会把本文件作为脚本直接喂给浏览器。
 * 注意：**这不是打包产物** —— 参考插件的构建也只是 tsc，客户端半体本质就是
 * "一段调用 window.__ModuleLoader__.load 的普通 JS"，React 由宿主 require 提供。
 * 所以本文件零构建、零依赖，直接手写。
 *
 * 挂载点：
 *  - `sidebar.footer.action` → 左下角（设置按钮旁）的进度环
 *  - `shell.overlay`         → 点开后展开的面板（frame-wide 浮层，不会被侧栏裁剪）
 *
 * 数据：走宿主 RPC —— `dsh-self-quota/status` 与 `dsh-self-quota/redeem`。
 *
 * 免责声明：本插件独立开发，与 OpenAI、DeepSeek 均无关联。
 * 数据来源若显示官方节奏，则就地署名 "Data: codex-reset.com"。
 */
window.__ModuleLoader__.load({
  id: 'dsh-self-quota',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')

    var NS = 'self-quota'
    /** 手工递增：面板上会显示它，用来确认浏览器加载的到底是哪一版客户端 */
    var CLIENT_BUILD = '0.4.0'
    var DICT = {
      zh: {
        title: '鲸元额度',
        expand: '展开鲸元额度',
        collapse: '收起',
        fiveHour: '5 小时窗',
        weekly: '周窗',
        remaining: '剩余',
        resetIn: '重置倒计时',
        notStarted: '下次消耗时起算',
        vouchers: '鲸元券',
        available: '{n} 张可用',
        none: '暂无',
        redeem: '使用一张',
        redeeming: '兑换中…',
        redeemDone: '已兑换，两窗清零',
        redeemFailed: '兑换失败',
        empty: '暂无数据',
        loading: '读取中…',
        locked: '额度已用尽（当前档位：lock）',
        attribution: 'Data: codex-reset.com',
        officialReset: '官方全局重置',
        officialForecast: '未来 24h 重置概率 {p}%',
        experimental: 'experimental',
        offline: '上一张',
        disclaimer: '本地模拟额度，非 DeepSeek / OpenAI 官方额度',
        weeklyQuotaLabel: '周额度',
        weeklyQuotaUnit: 'tokens',
        weeklyQuotaHint: '当前 {cur} tokens（约 {wan} 万）',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        savedPending: '已保存，正在回读确认…',
        savedVerified: '已保存 · 运行中已生效',
        savedUnverified: '已写入，但回读暂未确认——请再刷新看看',
        savedNotLive: '磁盘已写入，但运行中的插件还是旧值（多半需要重启应用）',
        invalidNumber: '请填一个大于 0 的数字',
        saveFailed: '保存失败',
        enforcementLabel: '执行档位',
        enforcementHint: 'off 只记录 / warn 只提示 / lock 用尽即锁死对话',
        modeLabel: '使用方式',
        modeAuto: '开箱即用',
        modeManual: '全部自己设',
        modeAutoHint: '额度用推荐默认值，什么都不用填',
        modeManualHint: '下面的额度全由你自己填，改完立即生效',
        editToggle: '额度设置',
        weeklyQuotaShort: '周额度',
        fiveHourQuota: '5h 上限',
        fiveHourWindow: '5h 窗时长',
        weeklyWindow: '周窗时长',
        unitTokens: 'tokens',
        unitMinutes: '分钟',
        unitDays: '天',
        weekAnchor: '周窗锚点',
        anchorFirstUse: '首次消耗起算',
        anchorMonday: '周一 00:00',
        voucherMax: '券上限',
        voucherExpiry: '券有效期',
        unitCount: '张',
        restoreDefaults: '恢复默认',
        grantSelf: '给自己发一张',
        grantAtCap: '已达上限，先用掉一张',
        grantDone: '已发放 1 张',
        summaryLine: '5h {a}% · 周 {b}% · 券 {n}/{c}',
        loadFailed: '读取失败',
        connUnavailable: '宿主连接不可用',
        retry: '重试',
        diagNoConnection: '客户端没拿到 connection 服务（宿主版本可能不匹配）',
        diagNoRpc: 'connection 服务上没有 rpc 通道',
        diagNoCall: 'connection.rpc.call 不是函数',
        diagNoChannel: '没找到可用的 rpc 通道（试过 ctx.connection.rpc 与 ctx.get(\'connection\').rpc）',
        pageTitle: '鲸元额度设置',
        pageSub: '两档模式：开箱即用 / 全部自己设。改完点保存立即生效。',
        secQuota: '窗口额度',
        fiveHourSource: '5h 上限来源',
        fiveHourModeAuto: '自动（周额度 ÷ 比例）',
        fiveHourModeManual: '手动指定',
        ratioLabel: '比例',
        derivedLabel: '5h 生效上限',
        derivedNote: '（改周额度或比例会实时跟着变）',
        derivedFixed: '（手动固定）',
        secWindow: '窗口与节奏',
        secEnforce: '超额行为',
        secVoucher: '鲸元券规则',
        statsTitle: '用量统计',
        statToday: '今日',
        statLast7: '近 7 天',
        statLast30: '近 30 天',
        statLifetime: '累计 Token',
        statPeak: '单日峰值',
        statActiveDays: '活跃天数',
        statCurrentStreak: '当前连续',
        statLongestStreak: '最长连续',
        statLongestTask: '最长任务用时',
        statCompletions: '累计笔数',
        statSessions: '会话数',
        statChart: '近 30 天每日用量',
        unitDay: '天',
      },
      en: {
        title: 'Local quota',
        expand: 'Expand local quota',
        collapse: 'Collapse',
        fiveHour: '5-hour window',
        weekly: 'Weekly window',
        remaining: 'left',
        resetIn: 'resets in',
        notStarted: 'starts on next use',
        vouchers: 'Vouchers',
        available: '{n} available',
        none: 'none',
        redeem: 'Use one',
        redeeming: 'Redeeming…',
        redeemDone: 'Redeemed — both windows cleared',
        redeemFailed: 'Redeem failed',
        empty: 'No data',
        loading: 'Loading…',
        locked: 'Quota exhausted (mode: lock)',
        attribution: 'Data: codex-reset.com',
        officialReset: 'Official global reset',
        officialForecast: 'Reset chance in 24h: {p}%',
        experimental: 'experimental',
        offline: 'prev',
        disclaimer: 'Locally simulated quota — not an official DeepSeek / OpenAI quota',
        weeklyQuotaLabel: 'Weekly quota',
        weeklyQuotaUnit: 'tokens',
        weeklyQuotaHint: 'Now {cur} tokens (~{wan}0k)',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        savedPending: 'Saved — confirming read-back…',
        savedVerified: 'Saved · live and in effect',
        savedUnverified: 'Written, but read-back not confirmed yet — refresh to check',
        savedNotLive: 'Written to disk, but the running plugin still has old values (app restart likely needed)',
        invalidNumber: 'Enter a number greater than 0',
        saveFailed: 'Save failed',
        enforcementLabel: 'Enforcement',
        enforcementHint: 'off = record only / warn = notify only / lock = block chat when exhausted',
        modeLabel: 'Usage mode',
        modeAuto: 'Out of the box',
        modeManual: 'Set everything myself',
        modeAutoHint: 'Recommended defaults — nothing to fill in',
        modeManualHint: 'Fill in every quota below; applies immediately',
        editToggle: 'Quota settings',
        weeklyQuotaShort: 'Weekly quota',
        fiveHourQuota: '5-hour limit',
        fiveHourWindow: '5-hour window',
        weeklyWindow: 'Weekly window',
        unitTokens: 'tokens',
        unitMinutes: 'min',
        unitDays: 'days',
        weekAnchor: 'Weekly anchor',
        anchorFirstUse: 'from first use',
        anchorMonday: 'Monday 00:00',
        voucherMax: 'Voucher cap',
        voucherExpiry: 'Voucher expiry',
        unitCount: '',
        restoreDefaults: 'Restore defaults',
        grantSelf: 'Grant myself one',
        grantAtCap: 'At the cap — use one first',
        grantDone: 'Granted 1',
        summaryLine: '5h {a}% · wk {b}% · vouchers {n}/{c}',
        loadFailed: 'Load failed',
        connUnavailable: 'Host connection unavailable',
        retry: 'Retry',
        diagNoConnection: 'Client has no `connection` service (host version mismatch?)',
        diagNoRpc: '`connection` service has no rpc channel',
        diagNoCall: '`connection.rpc.call` is not a function',
        diagNoChannel: 'No usable rpc channel (tried ctx.connection.rpc and ctx.get(\'connection\').rpc)',
        pageTitle: 'Local quota settings',
        pageSub: 'Two modes: out of the box / set everything myself. Save applies immediately.',
        secQuota: 'Window quotas',
        fiveHourSource: '5h limit source',
        fiveHourModeAuto: 'Auto (weekly ÷ ratio)',
        fiveHourModeManual: 'Manual',
        ratioLabel: 'Ratio',
        derivedLabel: '5h effective limit',
        derivedNote: '(updates live as you change weekly quota or ratio)',
        derivedFixed: '(fixed manually)',
        secWindow: 'Windows & cadence',
        secEnforce: 'Over-limit behaviour',
        secVoucher: 'Voucher rules',
        statsTitle: 'Usage stats',
        statToday: 'Today',
        statLast7: 'Last 7 days',
        statLast30: 'Last 30 days',
        statLifetime: 'Lifetime tokens',
        statPeak: 'Peak day',
        statActiveDays: 'Active days',
        statCurrentStreak: 'Current streak',
        statLongestStreak: 'Longest streak',
        statLongestTask: 'Longest task',
        statCompletions: 'Total turns',
        statSessions: 'Sessions',
        statChart: 'Daily usage · last 30 days',
        unitDay: 'd',
      },
    }

    var CSS = [
      '.dsq-icon{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font:inherit;font-size:12px;cursor:pointer;transition:background-color 120ms ease,color 120ms ease}',
      '.dsq-icon:hover{color:var(--dsw-alias-label-primary,#1b1b1c);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dsq-icon.is-locked{color:var(--dsw-static-red-500,#ef4444)}',
      '.dsq-icon.is-ok{color:var(--dsw-static-deepseek-500,#4176e6)}',
      '.dsq-pct{font-variant-numeric:tabular-nums;min-width:3.1em;text-align:right}',
      '.dsq-ring circle{transition:stroke-dashoffset 300ms ease}',
      '#dsq-panel{position:fixed;left:14px;bottom:64px;z-index:900;width:296px;max-width:calc(100vw - 28px);padding:12px 14px 13px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:14px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:var(--dsw-shadow-lv3,0 8px 26px rgba(15,17,21,.12),0 2px 6px rgba(15,17,21,.06));color:var(--dsw-alias-label-primary,#1b1b1c);font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);font-size:13px;line-height:1.5;box-sizing:border-box}',
      '#dsq-panel .dsq-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}',
      '#dsq-panel .dsq-title{font-size:14px;font-weight:600}',
      '#dsq-panel .dsq-x{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font-size:14px;cursor:pointer;padding:2px 6px;border-radius:6px}',
      '#dsq-panel .dsq-row{margin-bottom:11px}',
      '#dsq-panel .dsq-row-top{display:flex;align-items:baseline;justify-content:space-between;gap:10px}',
      '#dsq-panel .dsq-label{color:var(--dsw-alias-label-secondary,#61666b);font-size:12px}',
      '#dsq-panel .dsq-val{font-weight:600;font-variant-numeric:tabular-nums}',
      '#dsq-panel .dsq-sub{margin-top:2px;color:var(--dsw-alias-label-tertiary,#818590);font-size:11px}',
      '#dsq-panel .dsq-bar{position:relative;height:5px;margin-top:7px;border-radius:999px;background:var(--dsw-alias-bg-overlay,#ebeef2);overflow:hidden}',
      '#dsq-panel .dsq-fill{height:100%;border-radius:inherit;transition:width 300ms ease}',
      '#dsq-panel .tone-ok{color:var(--dsw-static-deepseek-500,#4176e6)}',
      '#dsq-panel .tone-ok .dsq-fill,.dsq-fill.tone-ok{background:var(--dsw-static-deepseek-500,#4176e6)}',
      '#dsq-panel .tone-warn{color:var(--dsw-static-amber-500,#f59e0b)}',
      '#dsq-panel .tone-warn .dsq-fill,.dsq-fill.tone-warn{background:var(--dsw-static-amber-500,#f59e0b)}',
      '#dsq-panel .tone-error{color:var(--dsw-static-red-500,#ef4444)}',
      '#dsq-panel .tone-error .dsq-fill,.dsq-fill.tone-error{background:var(--dsw-static-red-500,#ef4444)}',
      '#dsq-panel .dsq-vouchers{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:10px;margin-top:2px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}',
      '#dsq-panel .dsq-redeem{height:28px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#1b1b1c);font:inherit;font-size:12px;cursor:pointer}',
      '#dsq-panel .dsq-redeem:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '#dsq-panel .dsq-redeem:disabled{cursor:default;opacity:.5}',
      '#dsq-panel .dsq-official{margin-top:9px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));color:var(--dsw-alias-label-tertiary,#818590);font-size:11px;line-height:1.6}',
      '#dsq-panel .dsq-note{margin-top:8px;color:var(--dsw-alias-label-tertiary,#818590);font-size:10.5px;line-height:1.5}',
      '#dsq-panel .dsq-err{color:var(--dsw-static-red-500,#ef4444);font-size:12px}',
      // 设置 →「通用」里的偏好行（该槽不投影任何 props，标签与内部布局全由我们自绘）
      '.dsq-grow{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:7px 0}',
      '.dsq-grow-main{min-width:0}',
      '.dsq-grow-label{color:var(--dsw-alias-label-primary,#1b1b1c);font-size:13px;line-height:20px}',
      '.dsq-grow-sub{margin-top:2px;color:var(--dsw-alias-label-tertiary,#818590);font-size:11px;line-height:16px}',
      '.dsq-grow-ctl{display:flex;align-items:center;gap:6px;flex:none}',
      '.dsq-grow-input{width:132px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1b1b1c);font:inherit;font-size:12px;line-height:18px;box-sizing:border-box;font-variant-numeric:tabular-nums}',
      '.dsq-grow-select{padding:4px 6px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1b1b1c);font:inherit;font-size:12px;line-height:18px;box-sizing:border-box}',
      '.dsq-grow-input:focus,.dsq-grow-select:focus{outline:none;border-color:var(--dsw-static-deepseek-500,#4176e6)}',
      '.dsq-grow-btn{height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#1b1b1c);font:inherit;font-size:12px;cursor:pointer}',
      '.dsq-grow-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dsq-grow-btn:disabled{cursor:default;opacity:.5}',
      '.dsq-grow-msg{color:var(--dsw-static-green-500,#22c55e);font-size:11px}',
      '.dsq-grow-msg.is-err{color:var(--dsw-static-red-500,#ef4444)}',
      // 面板内的两档切换 / 折叠编辑区 / 动作按钮
      '#dsq-panel .dsq-seg{display:flex;margin:10px 0 4px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:9px;overflow:hidden}',
      '#dsq-panel .dsq-seg button{flex:1;height:28px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font:inherit;font-size:12px;cursor:pointer}',
      '#dsq-panel .dsq-seg button.is-on{background:var(--dsw-static-deepseek-500,#4176e6);color:#fff}',
      '#dsq-panel .dsq-mode-hint{color:var(--dsw-alias-label-tertiary,#818590);font-size:11px;line-height:1.5}',
      '#dsq-panel .dsq-edit-head{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;margin:10px 0 2px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary,#1b1b1c);font:inherit;font-size:12px;font-weight:600;cursor:pointer}',
      '#dsq-panel .dsq-form{padding-top:4px}',
      '#dsq-panel .dsq-form .dsq-grow{padding:4px 0}',
      '#dsq-panel .dsq-form .dsq-grow-label{font-size:12px}',
      '#dsq-panel .dsq-form .dsq-grow-input{width:118px}',
      '#dsq-panel .dsq-actions{display:flex;gap:6px;align-items:center}',
      '#dsq-panel .dsq-actions .dsq-redeem{flex:1}',
      '#dsq-panel .dsq-form-foot{display:flex;align-items:center;gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}',
      // 「插件列表」里那一页（settings/plugins 页的配置区）
      '.dsq-page{max-width:560px;padding:8px 2px 6px;color:var(--dsw-alias-label-primary,#1b1b1c);font-size:13px;line-height:1.6}',
      '.dsq-page-title{font-size:14px;font-weight:600;line-height:22px}',
      '.dsq-page-sub{margin:2px 0 14px;color:var(--dsw-alias-label-tertiary,#818590);font-size:12px;line-height:18px}',
      '.dsq-section{margin-top:16px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}',
      '.dsq-section-title{margin-bottom:8px;color:var(--dsw-alias-label-secondary,#61666b);font-size:12px;font-weight:600;letter-spacing:.02em}',
      '.dsq-page .dsq-grow{padding:7px 0}',
      '.dsq-page .dsq-grow-label{font-size:12.5px}',
      '.dsq-page .dsq-grow-input{width:150px;padding:5px 9px}',
      '.dsq-page .dsq-grow-select{min-width:150px;padding:5px 8px}',
      '.dsq-page .dsq-seg{margin:0 0 6px}',
      '.dsq-page .dsq-seg button{height:32px}',
      '.dsq-page .dsq-mode-hint{margin-bottom:2px}',
      '.dsq-page .dsq-grow-btn{height:30px;padding:0 14px}',
      '.dsq-page .dsq-form-foot{margin-top:14px;padding-top:12px;gap:10px}',
      '.dsq-page .dsq-err{color:var(--dsw-static-red-500,#ef4444);font-size:12px;line-height:18px}',
      // 用量统计：数字网格 + 近 30 天柱状图
      '.dsq-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 8px;margin-top:4px}',
      '.dsq-stat{min-width:0}',
      '.dsq-stat-v{font-size:15px;font-weight:600;line-height:22px;font-variant-numeric:tabular-nums}',
      '.dsq-stat-k{margin-top:1px;color:var(--dsw-alias-label-tertiary,#818590);font-size:11px;line-height:16px}',
      '.dsq-bars{display:flex;align-items:flex-end;gap:2px;height:56px;margin-top:8px}',
      '.dsq-bar{flex:1 1 0;min-width:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-bg-overlay,#ebeef2)}',
      '.dsq-bar.has{background:var(--dsw-static-deepseek-500,#4176e6)}',
      '.dsq-bars-range{margin-top:6px;color:var(--dsw-alias-label-tertiary,#818590);font-size:11px}',
      '.dsq-derived{margin-top:8px;padding:7px 10px;border-radius:8px;background:var(--dsw-alias-bg-overlay,#f2f4f7);color:var(--dsw-alias-label-secondary,#61666b);font-size:12px;font-variant-numeric:tabular-nums}',
    ].join('\n')

    // ── 极简共享 store：两个 slot 分别挂载，必须能共享同一份快照 ────────────
    var store = {
      snapshot: null,
      error: null,
      diag: null,
      open: false,
      busy: false,
      listeners: new Set(),
      emit: function () { store.listeners.forEach(function (fn) { try { fn() } catch (e) {} }) },
      subscribe: function (fn) { store.listeners.add(fn); return function () { store.listeners.delete(fn) } },
      set: function (patch) { Object.assign(store, patch); store.emit() },
    }

    function useStore () {
      var s = React.useState(0)
      var bump = s[1]
      React.useEffect(function () {
        return store.subscribe(function () { bump(function (n) { return n + 1 }) })
      }, [])
      return store
    }

    function fmt (ms) {
      if (!(ms > 0)) return '0s'
      var d = Math.floor(ms / 86400000)
      var h = Math.floor((ms % 86400000) / 3600000)
      var m = Math.floor((ms % 3600000) / 60000)
      if (d > 0) return d + 'd ' + h + 'h'
      if (h > 0) return h + 'h ' + m + 'm'
      if (m > 0) return m + 'm'
      return Math.max(1, Math.floor(ms / 1000)) + 's'
    }

    function toneOf (remaining, enforcement) {
      if (remaining <= 0) return 'error'
      if (remaining <= 0.1) return 'error'
      if (remaining <= 0.3) return 'warn'
      return 'ok'
    }

    var TONE_COLOR = { ok: 'var(--dsw-static-deepseek-500,#4176e6)', warn: 'var(--dsw-static-amber-500,#f59e0b)', error: 'var(--dsw-static-red-500,#ef4444)' }

    function Ring (props) {
      var r = 7
      var c = 2 * Math.PI * r
      var pct = Math.max(0, Math.min(1, props.remaining))
      return React.createElement('svg', { className: 'dsq-ring', width: 18, height: 18, viewBox: '0 0 18 18', 'aria-hidden': 'true' },
        React.createElement('circle', { cx: 9, cy: 9, r: r, fill: 'none', stroke: 'var(--dsw-alias-bg-overlay,#ebeef2)', strokeWidth: 2.6 }),
        React.createElement('circle', {
          cx: 9, cy: 9, r: r, fill: 'none',
          stroke: TONE_COLOR[props.tone], strokeWidth: 2.6, strokeLinecap: 'round',
          strokeDasharray: c, strokeDashoffset: c * (1 - pct), transform: 'rotate(-90 9 9)',
        }))
    }

    function toneFor (win, cfg) {
      return toneOf(win ? win.remaining : 1, cfg && cfg.enforcement)
    }

    /** 收起态：进度环 + 更紧张的那个窗口的剩余百分比 */
    function FooterAction (props) {
      var s = useStore()
      var t = props.t
      var snap = s.snapshot
      var wide = props.wide !== false

      var p = snap && snap.primary
      var w = snap && snap.secondary
      var worst = 1
      var tone = 'ok'
      if (p && w) {
        worst = Math.min(p.remaining, w.remaining)
        tone = worst <= 0.1 ? 'error' : worst <= 0.3 ? 'warn' : 'ok'
      }
      var state = s.error && !snap ? 'error' : (snap ? tone : '')

      return React.createElement('button', {
        className: 'dsq-icon' + (state === 'error' ? ' is-locked' : (state === 'ok' ? ' is-ok' : '')),
        type: 'button',
        title: t('title'),
        'aria-label': t('expand'),
        'aria-expanded': s.open ? 'true' : 'false',
        onClick: function () { store.set({ open: !store.open }) },
      },
      React.createElement(Ring, { remaining: snap ? worst : 0, tone: state === 'error' ? 'error' : tone }),
      wide ? React.createElement('span', { className: 'dsq-pct' }, snap ? Math.round(worst * 100) + '%' : '—') : null)
    }

    function Row (props) {
      var t = props.t
      var win = props.win
      var now = props.now
      var tone = toneFor(win, props.cfg)
      var pct = win ? Math.round(win.remaining * 1000) / 10 : 0
      var sub = win && win.resetsAt
        ? t('resetIn') + ' ' + fmt(win.resetsAt - now)
        : t('notStarted')
      return React.createElement('div', { className: 'dsq-row ' + (tone === 'ok' ? '' : 'tone-' + tone) },
        React.createElement('div', { className: 'dsq-row-top' },
          React.createElement('span', { className: 'dsq-label' }, props.label),
          React.createElement('span', { className: 'dsq-val' }, win ? pct + '% ' + t('remaining') : '—')),
        React.createElement('div', { className: 'dsq-sub' }, sub),
        React.createElement('div', { className: 'dsq-bar' },
          React.createElement('div', { className: 'dsq-fill tone-' + tone, style: { width: Math.max(0, Math.min(100, pct)) + '%' } })))
    }

    /**
     * 额度编辑表单：「全部自己设」这一档的核心 —— 所有额度都手动填。
     * 读写走我们自己的 RPC（config / config-set），宿主用 settings 服务落盘，
     * 因此**改完立即生效**（配置变更会触发插件热替换）。
     */
    function EditForm (props) {
      var t = props.t
      var call = props.call
      var cfgState = React.useState(null)
      var cfg = cfgState[0], setCfg = cfgState[1]
      var draftState = React.useState(null)
      var draft = draftState[0], setDraft = draftState[1]
      var msgState = React.useState(null)
      var msg = msgState[0], setMsg = msgState[1]
      var busyState = React.useState(false)
      var busy = busyState[0], setBusy = busyState[1]

      /**
       * 把宿主回读的配置转成表单草稿。
       * **必须对缺字段免疫**：宿主半体是重启才更新的，客户端是刷新页面就更新，
       * 两者版本可能不一致（旧宿主的 configView 里没有 voucher 字段）。
       * 之前这里直接读 view.voucher.maxHeld，拿到 undefined 就抛 TypeError，
       * 又被 catch 吞掉 → 界面永远停在"读取中"。
       */
      function toDraft (view) {
        var v = view || {}
        var vc = v.voucher || {}
        var p = v.preset || {}
        function pick () {
          for (var i = 0; i < arguments.length; i += 1) {
            if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i]
          }
          return undefined
        }
        return {
          weeklyLimit: String(pick(v.weeklyLimit, p.weeklyLimit, 15_000_000)),
          fiveHourLimit: String(pick(v.fiveHourLimit, p.fiveHourLimit, 2_000_000)),
          fiveHourMode: pick(v.fiveHourMode, p.fiveHourMode, 'auto'),
          fiveHourRatio: String(pick(v.fiveHourRatio, p.fiveHourRatio, 7.5)),
          fiveHourWindowMinutes: String(pick(v.fiveHourWindowMinutes, p.fiveHourWindowMinutes, 300)),
          weeklyWindowDays: String(pick(v.weeklyWindowDays, p.weeklyWindowDays, 7)),
          weekAnchor: pick(v.weekAnchor, p.weekAnchor, 'first-use'),
          enforcement: pick(v.enforcement, p.enforcement, 'lock'),
          voucherMaxHeld: String(pick(vc.maxHeld, p.voucherMaxHeld, 3)),
          voucherExpiryDays: String(pick(vc.expiryDays, p.voucherExpiryDays, 30)),
        }
      }

      /**
       * 5 小时上限的派生（和宿主 `fiveHourCapOf` 必须完全一致）：
       * auto → 周额度 ÷ 比例；manual → 用手里那个数。
       * 表单里改周额度时，这一行会**立刻**跟着变。
       */
      function derivedFiveHour (d) {
        if (!d) return 0
        if ((d.fiveHourMode || 'auto') !== 'auto') return Number(d.fiveHourLimit) || 0
        var ratio = Number(d.fiveHourRatio) > 0 ? Number(d.fiveHourRatio) : 7.5
        return Math.max(1, Math.round((Number(d.weeklyLimit) || 0) / ratio))
      }

      var attempts = 0
      function load () {
        attempts += 1
        return Promise.resolve()
          .then(function () { return call('dsh-self-quota/config', null) })
          .then(function (res) {
            if (res && res.ok && res.value) {
              setCfg(res.value)
              setDraft(toDraft(res.value))
              setMsg(null)
              return true
            }
            var why = (res && res.error && res.error.message) || t('loadFailed')
            setMsg({ text: t('loadFailed') + '：' + why, err: true })
            return false
          })
          .catch(function (e) {
            setMsg({ text: t('loadFailed') + '：' + String((e && e.message) || e), err: true })
            return false
          })
          .then(function (ok) {
            // 宿主半体可能比页面晚就绪：失败就退避重试几次，别把用户晾在"读取中"
            if (!ok && attempts < 4) setTimeout(load, 1200 * attempts)
          })
      }
      React.useEffect(function () { load() }, [])

      function setField (key, value) {
        setDraft(function (prev) {
          var next = Object.assign({}, prev)
          next[key] = value
          return next
        })
        setMsg(null)
      }

      function current () {
        if (!draft) return null
        // auto 模式下 fiveHourLimit 由派生值决定，但原始值仍要保留（切回 manual 时还要用）
        var keys = ['weeklyLimit', 'fiveHourWindowMinutes', 'weeklyWindowDays', 'voucherMaxHeld', 'voucherExpiryDays']
        if ((draft.fiveHourMode || 'auto') === 'manual') keys.push('fiveHourLimit')
        else keys.push('fiveHourRatio')
        for (var i = 0; i < keys.length; i += 1) {
          var n = Number(draft[keys[i]])
          if (!Number.isFinite(n) || n <= 0) return null
        }
        return {
          weeklyLimit: Number(draft.weeklyLimit),
          fiveHourLimit: Number(draft.fiveHourLimit),
          fiveHourMode: draft.fiveHourMode || 'auto',
          fiveHourRatio: Number(draft.fiveHourRatio),
          fiveHourWindowMinutes: Number(draft.fiveHourWindowMinutes),
          weeklyWindowDays: Number(draft.weeklyWindowDays),
          weekAnchor: draft.weekAnchor,
          enforcement: draft.enforcement,
          voucher: { maxHeld: Number(draft.voucherMaxHeld), expiryDays: Number(draft.voucherExpiryDays) },
        }
      }

      /** 比对"刚保存的值"和"运行中插件实际在用的值"，列出不一致的字段 */
      function diffPatch (live, patch) {
        var diff = []
        if (!live || !patch) return diff
        // auto 模式下 5h 上限是派生值，应比对"生效值"而不是"填的值"
        var expect = {}
        for (var k in patch) expect[k] = patch[k]
        if (expect.fiveHourMode === 'auto') expect.fiveHourLimit = live.fiveHourLimitEffective
        for (var key in expect) {
          var want = expect[key]
          if (key === 'voucher') {
            var lv = live.voucher || {}
            var pv = want || {}
            if (Number(lv.maxHeld) !== Number(pv.maxHeld)) diff.push('voucher.maxHeld')
            if (Number(lv.expiryDays) !== Number(pv.expiryDays)) diff.push('voucher.expiryDays')
          } else if (typeof want === 'number') {
            if (Number(live[key]) !== Number(want)) diff.push(key)
          } else if (live[key] !== want) {
            diff.push(key)
          }
        }
        return diff
      }

      function save () {
        var patch = current()
        if (!patch) { setMsg({ text: t('invalidNumber'), err: true }); return }
        setBusy(true)
        setMsg(null)

        // 回读确认：写盘成功 ≠ 运行中的插件已经用上新值，必须再比一次
        function reaffirm () {
          load()
          if (props.afterSave) props.afterSave()
          Promise.resolve()
            .then(function () { return call('dsh-self-quota/config', null) })
            .then(function (res) {
              if (!res || !res.ok || !res.value) return
              var diff = diffPatch(res.value, patch)
              if (diff.length === 0) setMsg({ text: t('savedVerified') })
              else setMsg({ text: t('savedNotLive') + '（' + diff.join('、') + '）', err: true })
            })
            .catch(function () { /* 热替换瞬间可能取不到，忽略 */ })
        }

        Promise.resolve(call('dsh-self-quota/config-set', patch)).then(function (res) {
          if (res && res.ok) {
            // 宿主已回读持久化配置并确认写入；此处再等运行中的插件重新加载
            var unverified = res.value && res.value.verified === false
            setMsg({ text: unverified ? t('savedUnverified') : t('savedPending'), err: unverified })
          } else {
            setMsg({ text: (res && res.error && res.error.message) || t('saveFailed'), err: true })
          }
        }).catch(function (e) {
          setMsg({ text: String((e && e.message) || e), err: true })
        }).then(function () {
          setBusy(false)
          // 写配置会触发插件热替换：分两次回读确认，确保界面与运行中的实例一致
          setTimeout(reaffirm, 400)
          setTimeout(reaffirm, 1500)
        })
      }

      function restore () {
        if (!cfg || !cfg.preset) return
        var preset = cfg.preset
        setDraft({
          weeklyLimit: String(preset.weeklyLimit),
          fiveHourLimit: String(preset.fiveHourLimit),
          fiveHourMode: preset.fiveHourMode || 'auto',
          fiveHourRatio: String(preset.fiveHourRatio || 7.5),
          fiveHourWindowMinutes: String(preset.fiveHourWindowMinutes),
          weeklyWindowDays: String(preset.weeklyWindowDays),
          weekAnchor: preset.weekAnchor,
          enforcement: preset.enforcement,
          voucherMaxHeld: String(preset.voucherMaxHeld),
          voucherExpiryDays: String(preset.voucherExpiryDays),
        })
        setMsg(null)
      }

      if (!draft) {
        return React.createElement('div', { className: 'dsq-form' },
          msg
            ? React.createElement('div', { className: 'dsq-err' }, msg.text)
            : React.createElement('div', { className: 'dsq-grow-sub' }, t('loading')))
      }

      function numberRow (key, label, unit, step) {
        return React.createElement('div', { className: 'dsq-grow', key: key },
          React.createElement('div', { className: 'dsq-grow-main' },
            React.createElement('div', { className: 'dsq-grow-label' }, label + (unit ? '（' + unit + '）' : ''))),
          React.createElement('div', { className: 'dsq-grow-ctl' },
            React.createElement('input', {
              className: 'dsq-grow-input',
              type: 'number',
              min: '1',
              step: step,
              value: draft[key],
              'aria-label': label,
              onChange: function (e) { setField(key, e.target.value) },
            })))
      }

      function selectRow (key, label, options) {
        return React.createElement('div', { className: 'dsq-grow', key: key },
          React.createElement('div', { className: 'dsq-grow-main' },
            React.createElement('div', { className: 'dsq-grow-label' }, label)),
          React.createElement('div', { className: 'dsq-grow-ctl' },
            React.createElement('select', {
              className: 'dsq-grow-select',
              value: draft[key],
              'aria-label': label,
              onChange: function (e) { setField(key, e.target.value) },
            }, options.map(function (o) {
              return React.createElement('option', { key: o.value, value: o.value }, o.label)
            }))))
      }

      var autoFiveHour = (draft.fiveHourMode || 'auto') === 'auto'
      var derived = derivedFiveHour(draft)

      return React.createElement('div', { className: 'dsq-form' },
        React.createElement('div', { className: 'dsq-section' },
          React.createElement('div', { className: 'dsq-section-title' }, t('secQuota')),
          numberRow('weeklyLimit', t('weeklyQuotaShort'), t('unitTokens'), '1000'),
          selectRow('fiveHourMode', t('fiveHourSource'), [
            { value: 'auto', label: t('fiveHourModeAuto') },
            { value: 'manual', label: t('fiveHourModeManual') },
          ]),
          autoFiveHour
            ? numberRow('fiveHourRatio', t('ratioLabel'), '', '0.1')
            : numberRow('fiveHourLimit', t('fiveHourQuota'), t('unitTokens'), '1000'),
          // 关键提示：改上面的总额度/比例，这一行会立刻跟着变
          React.createElement('div', { className: 'dsq-derived', key: 'derived' },
            t('derivedLabel') + '：' + derived.toLocaleString(),
            autoFiveHour ? '　' + t('derivedNote') : '　' + t('derivedFixed'))),
        React.createElement('div', { className: 'dsq-section' },
          React.createElement('div', { className: 'dsq-section-title' }, t('secWindow')),
          numberRow('fiveHourWindowMinutes', t('fiveHourWindow'), t('unitMinutes'), '1'),
          numberRow('weeklyWindowDays', t('weeklyWindow'), t('unitDays'), '0.5'),
          selectRow('weekAnchor', t('weekAnchor'), [
            { value: 'first-use', label: t('anchorFirstUse') },
            { value: 'monday-00:00', label: t('anchorMonday') },
          ])),
        React.createElement('div', { className: 'dsq-section' },
          React.createElement('div', { className: 'dsq-section-title' }, t('secEnforce')),
          selectRow('enforcement', t('enforcementLabel'), ['off', 'warn', 'lock'].map(function (v) {
            return { value: v, label: v }
          }))),
        React.createElement('div', { className: 'dsq-section' },
          React.createElement('div', { className: 'dsq-section-title' }, t('secVoucher')),
          numberRow('voucherMaxHeld', t('voucherMax'), t('unitCount'), '1'),
          numberRow('voucherExpiryDays', t('voucherExpiry'), t('unitDays'), '1')),
        React.createElement('div', { className: 'dsq-form-foot' },
          React.createElement('button', {
            className: 'dsq-grow-btn', type: 'button', disabled: busy, onClick: save,
          }, busy ? t('saving') : t('save')),
          React.createElement('button', {
            className: 'dsq-grow-btn', type: 'button', disabled: busy, onClick: restore,
          }, t('restoreDefaults')),
          msg ? React.createElement('span', {
            className: 'dsq-grow-msg' + (msg.err ? ' is-err' : ''),
          }, msg.text) : null))
    }

    /** token 数量按中文习惯缩写：23.6亿 / 2.8万 / 1234 */
    function fmtTokens (n) {
      var v = Number(n) || 0
      if (v >= 1e8) return (v / 1e8).toFixed(1) + '亿'
      if (v >= 1e4) return (v / 1e4).toFixed(1) + '万'
      return String(Math.round(v))
    }

    /**
     * 用量统计区：数字网格 + 近 30 天柱状图。
     * 数据全部来自宿主本地聚合（按天 + 按会话），不联网、不上传。
     */
    function StatsSection (props) {
      var t = props.t
      var call = props.call
      var stState = React.useState(null)
      var stats = stState[0], setStats = stState[1]
      var msgState = React.useState(null)
      var msg = msgState[0], setMsg = msgState[1]

      function load () {
        return Promise.resolve()
          .then(function () { return call('dsh-self-quota/stats', null) })
          .then(function (res) {
            if (res && res.ok && res.value) { setStats(res.value); setMsg(null) }
            else setMsg((res && res.error && res.error.message) || t('loadFailed'))
          })
          .catch(function (e) { setMsg(String((e && e.message) || e)) })
      }
      React.useEffect(function () { load() }, [])

      if (!stats) {
        return React.createElement('div', { className: 'dsq-section' },
          React.createElement('div', { className: 'dsq-section-title' }, t('statsTitle')),
          msg
            ? React.createElement('div', { className: 'dsq-err' }, msg)
            : React.createElement('div', { className: 'dsq-grow-sub' }, t('loading')))
      }

      var cells = [
        [t('statToday'), fmtTokens(stats.today)],
        [t('statLast7'), fmtTokens(stats.last7)],
        [t('statLast30'), fmtTokens(stats.last30)],
        [t('statLifetime'), fmtTokens(stats.lifetime)],
        [t('statPeak'), fmtTokens(stats.peak)],
        [t('statActiveDays'), String(stats.activeDays)],
        [t('statCurrentStreak'), stats.currentStreak + ' ' + t('unitDay')],
        [t('statLongestStreak'), stats.longestStreak + ' ' + t('unitDay')],
        [t('statLongestTask'), fmt(stats.longestTaskMs)],
        [t('statCompletions'), String(stats.completions)],
        [t('statSessions'), String(stats.sessions)],
      ]

      var series = (stats.series || []).slice(-30)
      var max = series.reduce(function (acc, x) { return Math.max(acc, x.tokens) }, 0) || 1

      return React.createElement('div', { className: 'dsq-section' },
        React.createElement('div', { className: 'dsq-section-title' }, t('statsTitle')),
        React.createElement('div', { className: 'dsq-stats' }, cells.map(function (cell, i) {
          return React.createElement('div', { className: 'dsq-stat', key: 'c' + i },
            React.createElement('div', { className: 'dsq-stat-v' }, cell[1]),
            React.createElement('div', { className: 'dsq-stat-k' }, cell[0]))
        })),
        React.createElement('div', { className: 'dsq-section-title', style: { marginTop: '16px' } }, t('statChart')),
        React.createElement('div', { className: 'dsq-bars' }, series.map(function (x) {
          return React.createElement('div', {
            key: x.day,
            className: 'dsq-bar' + (x.tokens > 0 ? ' has' : ''),
            style: { height: Math.max(3, Math.round((x.tokens / max) * 100)) + '%' },
            title: x.day + ' · ' + fmtTokens(x.tokens),
          })
        })),
        React.createElement('div', { className: 'dsq-bars-range' },
          series.length ? series[0].day + ' → ' + series[series.length - 1].day : ''))
    }

    /**
     * 左下角面板：**只显示额度**（进度、倒计时、券库存与券操作）。
     * 额度的编辑与两档模式放在「插件列表」的插件页里（见 PluginPage），
     * 保持这里一进来就是最开始那个干净的样子。
     */
    function Panel (props) {
      var s = useStore()
      var t = props.t
      var snap = s.snapshot

      function redeem () {
        if (store.busy) return
        store.set({ busy: true })
        Promise.resolve(props.call('dsh-self-quota/redeem', null)).then(function (res) {
          if (res && res.ok) store.set({ snapshot: res.value, busy: false, error: null })
          else store.set({ busy: false, error: (res && res.error && res.error.message) || t('redeemFailed') })
        }).catch(function (e) {
          store.set({ busy: false, error: String((e && e.message) || e) })
        })
      }

      var body = []
      if (!snap) {
        // 拿不到数据时，把真实原因说出来（连接诊断 / 具体错误 / 加载中），并提供重试
        var why = s.diag || s.error
        body.push(React.createElement('div', {
          key: 'loading', className: why ? 'dsq-err' : 'dsq-sub',
        }, String(why || t('loading'))))
        body.push(React.createElement('div', { key: 'retry', className: 'dsq-actions', style: { marginTop: '10px' } },
          React.createElement('button', {
            className: 'dsq-redeem', type: 'button', onClick: function () { if (props.refresh) props.refresh() },
          }, t('retry'))))
      } else {
        body.push(React.createElement(Row, { key: 'p', t: t, label: t('fiveHour'), win: snap.primary, now: snap.now, cfg: snap }))
        body.push(React.createElement(Row, { key: 's', t: t, label: t('weekly'), win: snap.secondary, now: snap.now, cfg: snap }))

        var n = snap.vouchers ? snap.vouchers.available : 0
        var cap = snap.voucherRules ? snap.voucherRules.maxHeld : 0
        // 左下角只放「使用一张」：发券属于配置行为，放插件页（PluginPage），不放在这里
        body.push(React.createElement('div', { key: 'v', className: 'dsq-vouchers' },
          React.createElement('span', { className: 'dsq-label' },
            t('vouchers') + '：' + (n > 0 ? t('available', { n: n }) : t('none')) + (cap ? ' / ' + cap : '')),
          React.createElement('div', { className: 'dsq-actions' },
            React.createElement('button', {
              className: 'dsq-redeem', type: 'button', disabled: s.busy || n <= 0, onClick: redeem,
            }, s.busy ? t('redeeming') : t('redeem')))))

        if (snap.official) {
          var lines = []
          if (snap.official.lastResetAt) lines.push(t('officialReset') + '：' + String(snap.official.lastResetAt).slice(0, 10))
          if (typeof snap.official.p24 === 'number') {
            lines.push(t('officialForecast', { p: snap.official.p24 }) + (snap.official.experimental ? '（' + t('experimental') + '）' : ''))
          }
          if (lines.length) {
            body.push(React.createElement('div', { key: 'o', className: 'dsq-official' }, lines.join('  ·  ')))
            // 使用条款要求：展示该数据必须就地署名
            body.push(React.createElement('div', { key: 'oa', className: 'dsq-official' }, t('attribution')))
          }
        }
        if (snap.enforcement === 'lock') body.push(React.createElement('div', { key: 'l', className: 'dsq-sub' }, t('locked')))
        if (s.error) body.push(React.createElement('div', { key: 'e', className: 'dsq-err' }, String(s.error)))
        body.push(React.createElement('div', { key: 'd', className: 'dsq-note' }, t('disclaimer') + ' · build ' + CLIENT_BUILD))
      }

      return React.createElement('div', { id: 'dsq-panel', role: 'dialog', 'aria-label': t('title') },
        React.createElement('div', { className: 'dsq-head' },
          React.createElement('span', { className: 'dsq-title' }, t('title')),
          React.createElement('button', {
            className: 'dsq-x', type: 'button', 'aria-label': t('collapse'),
            onClick: function () { store.set({ open: false }) },
          }, '✕')),
        body)
    }

    /**
     * 「插件列表」里本插件那一页：两档模式 + 手动填写全部额度 + 券操作。
     * 挂在 keyed slot `plugins.row.config`（key = `<包名>#<row id>`），
     * `view: 'summary'` 时只回一行摘要，`view: 'page'` 时渲染完整页面。
     */
    function PluginPage (props) {
      var t = props.t
      var call = props.call
      var s = useStore()
      var snap = s.snapshot
      var modeState = React.useState(null)
      var override = modeState[0], setOverride = modeState[1]
      var mode = override || (snap && snap.mode) || 'auto'

      function refresh () {
        return Promise.resolve()
          .then(function () { return call('dsh-self-quota/status', null) })
          .then(function (res) {
            if (res && res.ok && res.value) store.set({ snapshot: res.value, error: null })
            else store.set({ error: (res && res.error && res.error.message) || t('loadFailed') })
          })
          .catch(function (e) { store.set({ error: String((e && e.message) || e) }) })
      }
      React.useEffect(function () { refresh() }, [])

      function switchMode (next) {
        if (next === mode) return
        setOverride(next)
        Promise.resolve()
          .then(function () { return call('dsh-self-quota/config-set', { mode: next }) })
          .then(function (res) {
            if (res && res.ok === false) {
              store.set({ error: (res.error && res.error.message) || t('saveFailed') })
              setOverride(null)
            }
          })
          .catch(function (e) { store.set({ error: String((e && e.message) || e) }) })
          .then(function () { setTimeout(refresh, 900) })
      }

      function grantSelf () {
        Promise.resolve()
          .then(function () { return call('dsh-self-quota/grant', null) })
          .then(function (res) {
            if (res && res.ok && res.value) store.set({ snapshot: res.value, error: null })
            else store.set({ error: (res && res.error && res.error.message) || t('grantAtCap') })
          })
          .catch(function (e) { store.set({ error: String((e && e.message) || e) }) })
      }

      function redeem () {
        Promise.resolve()
          .then(function () { return call('dsh-self-quota/redeem', null) })
          .then(function (res) {
            if (res && res.ok && res.value) store.set({ snapshot: res.value, error: null })
            else store.set({ error: (res && res.error && res.error.message) || t('redeemFailed') })
          })
          .catch(function (e) { store.set({ error: String((e && e.message) || e) }) })
      }

      var n = snap && snap.vouchers ? snap.vouchers.available : 0
      var cap = snap && snap.voucherRules ? snap.voucherRules.maxHeld : 0

      return React.createElement('div', { className: 'dsq-page' },
        React.createElement('div', { className: 'dsq-page-title' }, t('pageTitle')),
        React.createElement('div', { className: 'dsq-page-sub' }, t('pageSub')),
        !snap
          ? React.createElement('div', { className: 'dsq-err', style: { margin: '0 0 12px' } },
            String(s.diag || s.error || t('loading')),
            React.createElement('button', {
              className: 'dsq-grow-btn', type: 'button', style: { marginLeft: '10px' }, onClick: refresh,
            }, t('retry')))
          : null,
        React.createElement('div', { className: 'dsq-mode-hint' },
          mode === 'manual' ? t('modeManualHint') : t('modeAutoHint')),
        React.createElement('div', { className: 'dsq-seg' },
          React.createElement('button', {
            type: 'button', className: mode === 'auto' ? 'is-on' : '', onClick: function () { switchMode('auto') },
          }, t('modeAuto')),
          React.createElement('button', {
            type: 'button', className: mode === 'manual' ? 'is-on' : '', onClick: function () { switchMode('manual') },
          }, t('modeManual'))),
        React.createElement(EditForm, { t: t, call: call, afterSave: refresh }),
        s.error ? React.createElement('div', { className: 'dsq-err', style: { marginTop: '10px' } }, String(s.error)) : null,
        React.createElement('div', { className: 'dsq-form-foot' },
          React.createElement('span', { className: 'dsq-grow-sub' },
            t('vouchers') + '：' + (n > 0 ? t('available', { n: n }) : t('none')) + (cap ? ' / ' + cap : '')),
          React.createElement('button', { className: 'dsq-grow-btn', type: 'button', disabled: n <= 0, onClick: redeem }, t('redeem')),
          React.createElement('button', {
            className: 'dsq-grow-btn', type: 'button', disabled: !cap || n >= cap, onClick: grantSelf,
          }, t('grantSelf'))),
        React.createElement(StatsSection, { t: t, call: call }))
    }

    /** 面板宿主：只在展开时挂载，避免常驻浮层 */
    function PanelHost (props) {
      var s = useStore()
      if (!s.open) return null
      return React.createElement(Panel, { t: props.t, call: props.call, refresh: props.refresh })
    }

    /**
     * 设置 →「通用」里的偏好行：周额度 + 执行档位。
     * 该槽不投影任何 props（连 label 都要自绘），当前值与写入路径全走我们自己的 RPC：
     * 读 `dsh-self-quota/config`，写 `dsh-self-quota/config-set`（宿主用 settings 服务落配置）。
     */
    function GeneralRow (props) {
      var t = props.t
      var call = props.call
      var cfgState = React.useState(null)
      var cfg = cfgState[0], setCfg = cfgState[1]
      var inputState = React.useState('')
      var input = inputState[0], setInput = inputState[1]
      var msgState = React.useState(null)
      var msg = msgState[0], setMsg = msgState[1]
      var busyState = React.useState(false)
      var busy = busyState[0], setBusy = busyState[1]

      var load = function () {
        return call('dsh-self-quota/config', null).then(function (res) {
          if (res && res.ok && res.value) {
            setCfg(res.value)
            setInput(String(res.value.weeklyLimit))
          }
        }).catch(function () { /* 宿主可能还在加载 */ })
      }
      React.useEffect(function () { load() }, [])

      var write = function (patch) {
        setBusy(true)
        setMsg(null)
        return call('dsh-self-quota/config-set', patch).then(function (res) {
          if (res && res.ok) {
            setMsg({ text: t('saved') })
            // 写配置会触发插件热替换：稍后回读，确保界面显示的是真正生效的值
            setTimeout(load, 900)
          } else {
            setMsg({ text: (res && res.error && res.error.message) || t('saveFailed'), err: true })
          }
        }).catch(function (e) {
          setMsg({ text: String((e && e.message) || e), err: true })
        }).finally(function () { setBusy(false) })
      }

      var saveWeekly = function () {
        var n = Number(input)
        if (!Number.isFinite(n) || n <= 0) { setMsg({ text: t('invalidNumber'), err: true }); return }
        write({ weeklyLimit: n })
      }

      var cur = cfg ? cfg.weeklyLimit : null
      var hint = cur === null
        ? t('loading')
        : t('weeklyQuotaHint', { cur: cur.toLocaleString(), wan: Math.round(cur / 10000) })

      return React.createElement('div', null,
        React.createElement('div', { className: 'dsq-grow' },
          React.createElement('div', { className: 'dsq-grow-main' },
            React.createElement('div', { className: 'dsq-grow-label' }, t('weeklyQuotaLabel') + '（' + t('weeklyQuotaUnit') + '）'),
            React.createElement('div', { className: 'dsq-grow-sub' }, hint)),
          React.createElement('div', { className: 'dsq-grow-ctl' },
            React.createElement('input', {
              className: 'dsq-grow-input',
              type: 'number',
              min: '1',
              step: '1000',
              value: input,
              'aria-label': t('weeklyQuotaLabel'),
              onChange: function (e) { setInput(e.target.value); setMsg(null) },
              onKeyDown: function (e) { if (e.key === 'Enter') saveWeekly() },
            }),
            React.createElement('button', {
              className: 'dsq-grow-btn', type: 'button', disabled: busy, onClick: saveWeekly,
            }, busy ? t('saving') : t('save')),
            msg ? React.createElement('span', {
              className: 'dsq-grow-msg' + (msg.err ? ' is-err' : ''),
            }, msg.text) : null)),
        React.createElement('div', { className: 'dsq-grow' },
          React.createElement('div', { className: 'dsq-grow-main' },
            React.createElement('div', { className: 'dsq-grow-label' }, t('enforcementLabel')),
            React.createElement('div', { className: 'dsq-grow-sub' }, t('enforcementHint'))),
          React.createElement('div', { className: 'dsq-grow-ctl' },
            React.createElement('select', {
              className: 'dsq-grow-select',
              value: cfg ? cfg.enforcement : 'warn',
              disabled: busy || !cfg,
              'aria-label': t('enforcementLabel'),
              onChange: function (e) { write({ enforcement: e.target.value }) },
            }, ['off', 'warn', 'lock'].map(function (v) {
              return React.createElement('option', { key: v, value: v }, v)
            })))))
    }

    var inject = ['slots', 'connection', 'locale']

    function apply (ctx) {
      ctx.effect(function () {
        var tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-self-quota'
        tag.textContent = CSS
        document.head.append(tag)
        return function () { tag.remove() }
      })

      ctx.effect(function () {
        return ctx.locale.register(NS, DICT)
      })

      var t = ctx.locale.bind(NS)

      /**
       * 诊断：把"为什么拿不到数据"直接算出来，让界面能显示，
       * 而不是静默地永远停在"读取中"/按钮全灰。
       */
      function resolveRpc () {
        var probes = [
          ['ctx.connection.rpc', function () { return ctx.connection && ctx.connection.rpc }],
          ["ctx.get('connection').rpc", function () {
            return ctx.get && ctx.get('connection') && ctx.get('connection').rpc
          }],
        ]
        for (var i = 0; i < probes.length; i += 1) {
          try {
            var rpc = probes[i][1]()
            if (rpc && typeof rpc.call === 'function') return { rpc: rpc, via: probes[i][0] }
          } catch (e) { /* 试下一条 */ }
        }
        return null
      }

      var resolved = resolveRpc()
      var connectionDiag = function () {
        if (resolved) return null
        if (!ctx.connection) return t('diagNoConnection')
        if (!ctx.connection.rpc) return t('diagNoRpc')
        if (typeof ctx.connection.rpc.call !== 'function') return t('diagNoCall')
        return t('diagNoChannel')
      }

      var call = function (endpoint, payload) {
        // 绝不裸调：宿主半体可能还没起来（或版本较旧），同步抛错会毁掉整个 effect
        try {
          if (!resolved) return Promise.reject(new Error(connectionDiag() || t('connUnavailable')))
          return resolved.rpc.call('/api', endpoint, payload)
        } catch (e) {
          return Promise.reject(e)
        }
      }

      var poll = function () {
        return call('dsh-self-quota/status', null).then(function (res) {
          if (res && res.ok) store.set({ snapshot: res.value, error: null })
          else store.set({ error: (res && res.error && res.error.message) || 'status failed' })
        }).catch(function (e) {
          // 宿主半体可能还没加载好；保持静默，下一轮再试
          if (!store.snapshot) store.set({ error: String((e && e.message) || e) })
        })
      }

      ctx.effect(function () {
        // 先把连接诊断写进 store：拿不到数据时界面能直接说出原因
        store.set({ diag: connectionDiag() })
        poll()
        var timer = setInterval(function () { if (!document.hidden) poll() }, 30_000)
        var onVisible = function () { if (!document.hidden) poll() }
        document.addEventListener('visibilitychange', onVisible)
        return function () {
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      })

      ctx.slots.inject('sidebar.footer.action', function () {
        return ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'self-quota', order: 50, label: function () { return t('title') }, locale: NS },
          function (props) { return React.createElement(FooterAction, { wide: props && props.wide, t: t }) },
        )
      })

      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register(
          { name: 'shell.overlay', id: 'self-quota-panel', order: 120, label: function () { return t('title') }, locale: NS },
          function () { return React.createElement(PanelHost, { t: t, call: call, refresh: poll }) },
        )
      })

      // 设置 →「通用」里的一行：不用翻到插件页就能改周额度
      ctx.slots.inject('settings.general.item', function () {
        return ctx.slots.register(
          { name: 'settings.general.item', id: 'self-quota-weekly', order: 40 },
          function () { return React.createElement(GeneralRow, { t: t, call: call }) },
        )
      })

      // 「插件列表」里本插件那一页：两档模式 + 手动填写全部额度 + 券操作。
      // key = `<包名>#<row id>`，row id 由包内 cordis.patch.yml 声明（self-quota）。
      // view==='summary' 时只回一行摘要，view==='page' 才是完整页面。
      ctx.slots.inject('plugins.row.config', function () {
        return ctx.slots.register(
          { name: 'plugins.row.config', key: 'dsh-self-quota#self-quota' },
          function (props) {
            if (props && props.view === 'summary') {
              var snap = store.snapshot
              if (!snap) return React.createElement('span', null, t('loading'))
              return React.createElement('span', null, t('summaryLine', {
                a: Math.round(snap.primary.remaining * 100),
                b: Math.round(snap.secondary.remaining * 100),
                n: snap.vouchers ? snap.vouchers.available : 0,
                c: snap.voucherRules ? snap.voucherRules.maxHeld : 0,
              }))
            }
            return React.createElement(PluginPage, { t: t, call: call })
          },
        )
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
