# 鲸元额度 · dsh-self-quota

> 给 DeepSeek Harness 用的**本地额度表盘**：5 小时窗 + 周窗 + 「鲸元券」。
> 额度自己设，数据全在本地，**不读任何第三方凭据、不调任何第三方账号**。

**免责声明**：本插件独立开发，与 OpenAI、DeepSeek 均无任何关联，未获其背书或赞助。
「鲸元额度」「鲸元券」是本项目的自造词。其它产品名称与商标归各自所有者所有。

---

## 当前状态

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| M0 | 组合包骨架 + Config schema（**额度在插件界面里自己设**）+ 装载进 profile | ✅ 已完成并验证 |
| M1 | 用量采集（`session/event`）+ 幂等去重 + 双窗状态机 + 本地落盘 + 鲸元券账本 | ✅ 已完成并验证 |
| **M4** | **跟随官方真实节奏：全局重置 → 清窗；官方发券 → 本地发「鲸元券」+ 历史回溯补发** | ✅ 已完成并验证（默认关闭） |
| M5 | 硬锁（`agent/pre-step` → reject、`tools/pre-execute` → deny） | ✅ 已实现并验证，**默认就是 `lock`** |
| M2 | 左下角进度环挂件 + 展开面板（client 半体，零构建手写 JS） | ✅ 已实现并验证 |
| M3 | 插件列表里的配置页 + 用量统计（真实写入路径 `configEditor.edit`） | ✅ 已实现并验证 |

**默认执行档位是 `lock`**：额度用尽即锁死对话，只有你自己改配置才会变。
想先只观察一段时间，把 `enforcement` 改成 `warn`（只提示不拦）或 `off`（只记录）。

> 仓库地址：<https://github.com/White47/dsh-self-quota>

---

## 装 / 卸

```sh
# 从 GitHub 克隆
git clone https://github.com/White47/dsh-self-quota.git

# 安装（本地目录）
dsh plugin --profile desktop add /path/to/dsh-self-quota

# 卸载
dsh plugin --profile desktop remove dsh-self-quota
```

桌面版也可以走「设置 → 插件」界面启用/停用。

---

## 在插件界面里设额度

**设置 → 插件 → 本插件 → 配置**。表单由 Config schema 自动生成，改完**立即生效，不需要重启**。

另外 **设置 → 通用** 里还有一行「**周额度**」快捷输入 + 执行档位下拉（挂在 `settings.general.item`），不用翻到插件页。
这一行由插件自己绘制（该槽不给任何 props），读写走插件自己的 RPC，写入由宿主调用 `settings` 服务（**带 CAS 版本号、只允许白名单字段**）。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `auto` | `auto`=开箱即用（额度用推荐默认值，什么都不用填）｜`manual`=全部自己设（面板里直接编辑全部额度） |
| `fiveHourLimit` | `2000000` | 5 小时窗上限（tokens）—— **仅 `fiveHourMode=manual` 时生效** |
| `fiveHourMode` | `auto` | `auto`=5h 上限**自动 = 周额度 ÷ 比例**（只填总额度，5h 跟着变）｜`manual`=自己填死 |
| `fiveHourRatio` | `7.5` | auto 模式的比例：`5h 上限 = 周额度 ÷ 该值` |
| `weeklyLimit` | `15000000` | **周窗上限（tokens）—— 你想设的"周用量"就是这里** |
| `fiveHourWindowMinutes` | `300` | 5h 窗时长；**自测时设 `1` 即可秒级验证翻窗** |
| `weeklyWindowDays` | `7` | 周窗时长；自测时设 `0.002` |
| `weekAnchor` | `first-use` | `first-use`（首次消耗开窗）或 `monday-00:00` |
| `enforcement` | `lock` | `off` 只记录｜`warn` 只提示｜`lock` **额度用尽锁死对话（默认）** —— 只有你自己改它才会变 |
| `countSubagents` | `true` | 子代理消耗是否计入 |
| `countBackground` | `false` | 是否把**后台调用**（上下文压缩／会话标题这类非回合请求）也计入（走 `llm/stream`，只认带 `purpose` 的请求，避免与回合计量双计） |
| `allowReadOnlyWhileLocked` | `false` | 锁定期间是否仍放行**只读工具**。默认 false＝一律拒绝；打开后可让"恰好中途超线"的回合干净收尾 |
| `readOnlyAllowlist` | `read/read_image/glob/grep/...` | 上面开关生效时允许放行的工具名 |
| `voucher.initial` | `1` | 首次安装赠几张鲸元券 |
| `voucher.maxHeld` | `3` | 最多同时持有几张 |
| `voucher.expiryDays` | `30` | 有效期（**本地规则，不是官方规则**） |
| `official.source` | `off` | `off` 不联网（默认）｜`codex-reset.com` **跟随官方真实节奏**（见下节） |
| `official.backfillSince` | `last-30d` | 首次启用时回溯补发范围：`last-30d` / `install` / `off` |
| `official.pollMinutes` | `15` | 轮询间隔；实际下限 1 分钟（遵守上游条款） |
| `official.userAgent` | `dsh-self-quota/0.1.0` | 上游要求带可识别 UA，**建议补上你的仓库地址** |
| `stateDir` | 空 | 留空则用 `$DSH_HOME/storages/dsh-self-quota` |

也可以用 `cordis.patch.yml` 直接写（注意 patch 是**整体替换** config，不是深度合并）：

```yaml
- insert:
    - id: self-quota
      name: dsh-self-quota
      config:
        weeklyLimit: 8000000
        enforcement: lock
```

---

## 命令

| 命令 | 作用 |
| --- | --- |
| `/quota` | 查看 5h 窗 / 周窗剩余百分比、重置倒计时、鲸元券库存 |
| `/quota-redeem` | 兑换一张鲸元券：**两窗已用清零 + 周窗重置日重设为约 7 天后**，上限不变 |

---

## 跟随官方真实节奏（M4 · 默认关闭）

把 `official.source` 设为 `codex-reset.com` 后，插件会（**只读、无 key、无凭据**）拉取该站公开数据：

| 官方发生什么 | 本地跟着做什么 |
| --- | --- |
| **全局重置**（`group=reset` 且 `announcement_state=announced`） | **两窗已用清零**（等价于官方那次"所有人额度重置"），并按 `grantOnOfficialReset` 加发鲸元券 |
| **发放重置券**（`group=credits` 且 `banked_grant === true`） | 按 `grantPerOfficialGrant` 在本地发「鲸元券」 |
| 首次启用 | 按 `backfillSince` **回溯补发**（默认近 30 天）——回答"如果我一直跟着节奏，现在该攒了几张" |

**三条纪律（都已在代码里硬保证）**：

1. **默认关闭**：不设成 `codex-reset.com` 就完全不联网。
2. **失败 fail-open**：拉取失败只记一行错误，**绝不影响本地额度判定与锁定** —— 远程挂了不会把你锁死。
3. **就地署名**：展示该数据的地方（`/quota`）都带 `Data: codex-reset.com`。

**关于"只依赖文档化字段"的一个诚实说明**：

该站承诺稳定的字段是 `id / announced_at / announcement_state / group / type / summary / url`。
但**区分"真实发券"与"生命周期更新"的唯一字段是 `banked_grant`，而它没有被文档化**：

- `type` 完全等于 `group`，没有区分能力；
- 按日去重会把 08-21/08-22 这类"同一笔券的多条更新"算成两次；
- 只认 `banked_state === 'announced'` 会漏掉状态为 `unknown / available / arriving` 的真实发放。

所以本插件用 `banked_grant`，但做成**优雅降级**：一旦整个响应里找不到这个字段，就**一张都不发**，并在 `/quota` 与 `status.json` 里如实报告 —— **绝不靠日期或条数去猜**，因为猜就会把更新当发券，造成券通胀。

上游自己也长期提醒这点：*"Several rollout updates can describe one banked grant; never count the cards as inventory."*

---

## 左下角挂件（M2）

- **图标挂哪**：`sidebar.footer.action` —— 官方定义就是"sidebar foot 里设置按钮旁的操作位"。它渲染 **进度环 + 剩余百分比**；**侧栏收起成 56px 轨道时只留环**（宿主通过 `{ wide: false }` 告知，不用自己探测宽度）。
- **点开在哪**：面板挂 `shell.overlay`（frame-wide 浮层）—— **不能挂在侧栏内部，否则会被滚动容器裁剪**。
- **颜色**：按更紧张的那个窗口分三档 —— **蓝（>30%，跟 DSH 品牌色一致）**/ 黄（10~30%）/ 红（≤10% 或已用尽）。
- **面板内容**：5h 窗与周窗各一条进度条 + 重置倒计时、鲸元券库存与「使用一张」、官方节奏（含 `Data: codex-reset.com` 就地署名）、本地模拟额度免责小字。
  **这里一进来就是「只显示额度」的简洁样子：不放任何配置项，也不放「给自己发一张」**（发券属于配置行为，只在插件页）。

### 两种使用方式（配置在「插件列表」里，不在左下角）

左下角点开 = 简洁的额度显示。**配置都在插件页**：

> **设置 → 插件 → `dsh-self-quota`** → 点那一行的「配置」→ 打开本插件自己的页面。

页面里有两档切换与完整表单：

| 档位 | 行为 |
| --- | --- |
| **开箱即用**（默认） | 额度用推荐默认值（周 1500 万 / 5h 200 万 tokens），**什么都不用填** |
| **全部自己设** | 手动填全部额度：周额度、5h 上限、5h 窗时长、周窗时长、周窗锚点、执行档位、券上限、券有效期 |

- **周用量自动按你设的周额度折算**：`剩余% = 1 − 已用 / 周额度`；改完**立即生效**（配置变更触发插件热替换，不用重启）。
- **5 小时上限也会跟着总额度走**：`fiveHourMode=auto`（默认）时 `5h 上限 = 周额度 ÷ fiveHourRatio`（默认 7.5）。
  所以在表单里改「周额度（总额度）」，下面的「5h 生效上限」会**实时跟着变**；
  想自己填死就把「5h 上限来源」切到 `手动指定`，那时才用 `fiveHourLimit` 的值。
- 插件页底部还有「使用一张 / 给自己发一张」券操作与当前库存。
- 「**恢复默认**」把表单填回推荐值，再点「保存」。
- 三处入口写的是**同一份配置**：插件页（可编辑）、左下角面板（只读展示）、设置 → 通用里的「周额度」快捷行。
- 插件页还向插件列表提供一行摘要（`view: 'summary'`）：`5h 90% · 周 99% · 券 1/3`。

### 用量统计

插件页底部有「**用量统计**」，全部由**本地聚合**得出（不联网、不上传）：

| 指标 | 口径 |
| --- | --- |
| 今日 / 近 7 天 / 近 30 天 | 按**本地日历日**聚合的 tokens |
| 累计 Token / 累计笔数 | 自安装以来的总量 |
| 单日峰值 | 历史最高的单日用量 |
| 活跃天数 | 有消耗的天数 |
| 当前连续 / 最长连续 | 连续有消耗的天数（**今天还没用时从昨天起算**，不会一睁眼就归零） |
| 最长任务用时 | 单个会话从首次到末次消耗的跨度 |
| 会话数 | 记录到的会话数 |
| 近 30 天柱状图 | 每天用量，悬停可看具体日期与数值 |

- 只存两类事实：**按天聚合**与**每会话首末时间**；其余指标现算，不存冗余状态。
- 体积有上限：最多 **400 天 / 200 个会话**，超出自动裁掉最旧的。
- 边界都有单测：跨月 / 跨年 / 闰年的日期推进、连续段计算、脏数据免疫、老存档无 `stats` 字段时自动补出。
- **数据通路**：客户端 `ctx.connection.rpc.call('/api', 'dsh-self-quota/status')` → 宿主用 **`connection.fetch.register`** 在 `/api/dsh-self-quota/*` 上挂 6 条精确 POST 路由（`status` / `stats` / `config` / `config-set` / `redeem` / `grant`），信封是 `client-request` → `server-response`。
  ⚠️ **不要用 `connection.rpc.handle` / `rpc.intercept`**：DSH 0.1.5+ 里那条通道的 disposer 会在 Connection 自己的 fiber 上解析 `owner.webServer`，而该 fiber 从不持有它 → 子 fiber 内抛错、通道**静默消失**，启动不报错，客户端只看到 `HTTP 404`。我们真撞过这个坑。
- **零构建**：参考插件的构建也只是 `tsc` —— 客户端半体本质是"一段调用 `window.__ModuleLoader__.load` 的普通 JS"，React 由宿主 `require("react")` 提供。所以本插件直接手写 [client.js](client.js)，**没有打包器、没有构建步骤**。

---

## 硬锁与解除

`enforcement: 'lock'` 且额度用尽时：

- `agent/pre-step` 返回 `reject` → **模型不会被调用**，不烧 token、不产出回答；
- `tools/pre-execute` 返回 `deny` → **任何工具调用都被拒绝**。

**唯一解除方法：设置 → 插件 → 关闭「dsh-self-quota」**（或 `dsh plugin --profile desktop remove dsh-self-quota`）。
关闭后拦截立即失效。本插件**不包含任何反禁用逻辑**，锁屏提示里也会写明这条出路。

**三条安全铁律（硬编码，不可配置）**：

1. **锁定只看本地状态与本地时钟**，绝不依赖任何远程数据（远程挂了也不会把人锁死）。
2. **状态不可判定时一律放行**（存档损坏/写盘失败 → 提示并放行）。**宁可漏锁，不可误锁。**
3. **绝不阻挠被关闭。**

**已知局限**：这是自律工具，不是安全边界。改系统时钟可以提前翻窗；有磁盘权限的人改一行配置也能解除。不做重度防篡改。

---

## 数据与隐私

- 落盘位置：`$DSH_HOME/storages/dsh-self-quota/state.json`（诊断信息在同目录 `status.json`）。
- **只存 token 计数与时间戳**，不存任何对话内容、提示词或模型输出。
- **不联网、无遥测、不上传、不读任何凭据**（`state.json` 里有断言守着这一点）。
- 删除方式：删掉该目录，或在插件界面把 `voucher.initial` 设 0 后重置。

---

## 开发与验证

```sh
npm test          # 68 个单测，约 1 秒跑完
```

除此之外还有几个开发脚本：

```sh
node scripts/selfcheck.mjs          # 清单自检：能否被 DSH 正确识别与装载
node scripts/capture-fixtures.mjs   # 抓真实响应存成 fixture（单测用的就是真数据）
node scripts/inspect-fixtures.mjs   # 打印真实事件字段，确认解析器没写歪
node scripts/probe-official.mjs     # 端到端探针：拉真实数据 → 解析 → 计划 → 执行 → 幂等复核
```

测试全部用**注入时钟 + 极短窗口**，所以"5 小时翻窗""30 天过期"在毫秒内跑完，不需要等：

- 窗口锚定与滚动（5h / 周 / 周一零点锚点）
- `(sessionId, seq)` 幂等 —— resume 重放不重复计数
- 鲸元券兑换语义（两窗清零 + 周窗锚点 +7 天 + 上限不变）
- 30 天整边界过期、`maxHeld` 封顶
- 硬锁：`lock` 档返回 reject/deny，`warn` 档不拦
- **状态损坏时绝不锁**（保险栏）
- **官方节奏**（用真实 fixture）：解析出 8 条真实发放、重置按日去重、回溯补发、二次拉取幂等、字段消失时降级为"一张不发"
- **结构性保证：锁定判定完全不读官方状态** —— 远程数据在结构上不可能导致误锁
- **client 半体契约**（假 DOM / 假 React，无需浏览器）：`__ModuleLoader__.load({id, factory})` 形状、只 `require("react")`、注入主题 token 的样式、注册中英词典、挂到 `sidebar.footer.action` + `shell.overlay` + `settings.general.item`、轮询走 `/api`、未展开时不留浮层、宽/窄两态都能渲染
- **后台调用计量**：默认根本不注册 `llm/stream`；打开后**原样透传每个 chunk**、只计带 `purpose` 的请求、流中途抛错也要把已产出的 chunk 交出去
- **锁定只读例外**：默认连只读工具也拒；打开后只读放行、写操作仍拒
- **设置写入路径**：只写白名单字段（`stateDir` 之类一律丢弃）、带 CAS 版本号、非法值被挡下、服务不可用时**如实报错而不是假装成功**
- 存档里不含对话内容

---

## 故障排查

**症状：插件页一直停在「读取中…」**

**根因通常是"宿主半体与客户端半体版本不一致"** —— 这两个半体的更新方式不同：

| 半体 | 怎么更新 |
| --- | --- |
| **client 半体**（[client.js](client.js)） | DSH 把文件直接喂给浏览器，**刷新页面**就换新代码 |
| **host 半体**（[index.js](index.js)） | 外部 link 的 bundle **不走 HMR**，必须**重启应用** |

所以"改了代码 → 只刷新页面"会出现**新客户端配旧宿主**。典型表现：客户端期望 `config` 回读里有 `voucher` 字段，
旧宿主没有 → 读 `undefined.maxHeld` 抛 TypeError → 错误若被静默吞掉，界面就永远停在"读取中"。

**处置**：**重启应用 + 刷新页面，两件都做**。现在客户端对缺字段已**免疫**（回退默认值），
且**任何失败都会把真实错误显示出来**（例如 `读取失败：HTTP 404`），不再静默。

---

**症状：插件页「保存」不生效 / 报保存失败**

**先看 `%DSH_HOME%\storages\dsh-self-quota\last-write.json`** —— 每次写配置都会落盘一条诊断：

```json
{
  "lastEntry": "self-quota(dsh-self-quota)",
  "lastWrite": {
    "ok": true,
    "stage": "configEditor.edit",
    "verified": true,
    "candidate": { "weeklyLimit": 8000000 },
    "observed": { "weeklyLimit": 8000000, "fiveHourMode": "auto" }
  }
}
```

- `stage: "configEditor.edit"` → 正常路径（写 profile patch 并经 Loader 应用）。
- `stage: "locate-entry"` → 没找到可写条目，`error` 里会列出 `configEditor.entries()` 和 `settings.describe()` 实际返回的东西。
- `ok: false` + `stage: "configEditor.edit"` → 写失败，`error` 是底层原因（例如被 home patch 覆盖）。
- `ok: true` + `verified: false` → 写盘成功但回读对不上，`observed` 是回读到的东西。

#### 为什么必须用 `configEditor` 而不是 `settings`

**这是一个花了很久才定位到的坑**：`@deepseek-ai/dsh-settings` 的文档写得很明确 ——

> 表单只展示活动且可唯一定位的 profile 条目中的 **`volatile` 字段**。
> **普通配置仍通过 Cordis 配置文件编辑。**

我们的额度是**普通配置**，schema 里没有 `.volatile()`，所以它**永远不在 `settings.describe()` 里**。
之前用 `settings.update/mutate` 写，每次都在 `locate-entry` 阶段失败（`describe()` 返回 22 个命名空间，没有一个是我们）。

正确做法是 **`ctx.configEditor.edit(entry, change)`**（`@deepseek-ai/dsh-config-editor`）：

```js
const entry = ctx.configEditor.entries().find(e => e.options.id === 'self-quota')
await ctx.configEditor.edit(entry, (current) => ({ ...current, ...patch }))
```

- `change(current, inherited)` 必须返回**完整的下一份 config**（不是只有改动字段）；
- 它把整份 config 写进当前 profile 的 patch，然后**通过 Loader 立即应用**（所以我们会热替换）；
- 写入前验证候选值，保留 YAML 注释与 `!!js` 表达式，失败会回滚。

`settings.mutate/update` 只作为**退化路径**保留（万一某个环境没有 configEditor）。

**写完必须回读确认**：`config-set` 的返回里有 `verified`（持久化配置与写入值是否一致）；
界面在 400ms / 1500ms 各再回读一次，把「运行中插件实际在用的值」和刚保存的值逐项比对，
不一致就明确提示 *磁盘已写入，但运行中的插件还是旧值（多半需要重启应用）*——不会假装成功。

---

**症状：什么都挂了 —— 没有 `status.json`、`/quota` 没有、挂件报 404**

**先看 `plugin_manager` 里这条的 `fiberPhase`。如果是 `pending`，说明 `apply()` 从来没执行过**，后面所有排查都是白费。

`pending` 的头号原因是**导出了顶层 `inject`**：

- cordis 运行时的 `resolve()` 把**对象的 key 当成服务名**（不是 `required`/`optional` 这两个关键字）。
  所以 `export const inject = { optional: ['connection'] }` 等于声明"我要注入一个叫 `optional` 的服务"——
  它永远不存在 → 插件永久 `pending` → 静默失效：类型检查通过、启动也不报错。
- 数组形式 `['connection']` 则把服务变成**必需**，在没有该服务的宿主里永不加载。

**结论：本插件不导出顶层 `inject`**，需要服务的注册走 `whenService()`（scoped `ctx.inject` + 轮询兜底）。
回归测试里有 `cordisResolve()` 复刻运行时行为，专门守住这条。

---

**症状：`transport failure for /api/dsh-self-quota/status: HTTP 404`**

宿主侧的 Fetch 路由没挂上。按顺序看：

1. **看 `status.json`**（`$DSH_HOME/storages/dsh-self-quota/status.json`）：
   - `"rpc": "registered"` + `rpcDetail` 列出 4 条路径 → 路由已挂，问题多半是**没重启应用**（见下）。
   - `"rpc": "pending"` → 宿主半体还没跑到注册那一步。
   - `"rpc": "no-fetch-registry"` → `connection.fetch` 不可用（宿主无 web 服务，或服务名变了）。
2. **确认依赖声明**：`index.js` 必须导出 `inject`（`{ optional: ['connection','commands','settings'] }`），
   且注册写在 `ctx.inject([...], scope => ...)` 里。**不声明 inject 时 `ctx.get(...)` 会拿到 `undefined`**，
   表现为命令与路由一起静默消失（`status.json` 里 `commands` 是空数组）。
3. **改完代码必须重启应用**（见下）。

**症状：`/quota` 不在斜杠菜单** —— 同上第 1、2 条，看 `status.json` 的 `commands` 数组。

**症状：左下角没有图标** —— 属 client 半体，与宿主无关：检查 `dsh.client` 声明、`exports["./client"]`，以及浏览器控制台。

---

## 路线图

M0–M5 均已落地。剩余可选项：

- 面板定位从固定左下角改为可拖拽 / 跟随图标；
- 接入 `https://codex-reset.com/mcp`，让 Agent 能直接回答"今天重置了吗"；
- `readOnlyAllowlist` 按工具能力自动判定，而不是靠名字白名单。

## License

MIT

---

## 开发者注意：改代码后必须重启应用

本插件的 host 半体是**外部 link 的 bundle**，实测结论：

- 改 `index.js` → 应用**不会**自动热重载；
- 用 `plugin_manager set_plugin <entryId> enabled=false/true` 禁用再启用后，**新代码才写的 `status.json` 并未出现、新增的 state 字段也未落盘** —— 也就是说这个开关**不能**用来加载新代码（进程内 ESM 模块缓存）；
- **所以改完代码要重启应用才生效。**

反过来，这个开关本身是有效的：实测关闭插件后 18 秒内跨多个步骤，`state.json` 的 `lifetimeTokens` 完全不变；重新启用后立即恢复。**这说明「关掉插件 = 拦截立即失效」确实成立**。

---

## ⚠️ 千万不要用 PowerShell 改这些源文件

本项目是 UTF-8 无 BOM + 大量中文。实测教训：`Get-Content -Raw file | Set-Content -Encoding utf8` 会
**用 ANSI/GBK 解码 UTF-8 字节**，把全部中文变成乱码，并且**吃掉字符串的收尾引号**（`Set-Content -Encoding utf8` 还会加 BOM），
导致 `package.json` / `index.js` 直接不可解析 —— 我是这么把三个文件写坏的，只能按内容重建。

规则：**改文件只用编辑器工具（read/edit/write），不要走 PowerShell 管道。** 必须用命令行时，用
`[System.IO.File]::WriteAllText($p, $s, (New-Object System.Text.UTF8Encoding($false)))` 显式无 BOM 写入。

自检：`node scripts/selfcheck.mjs`（清单）+ `npm test`（68 个单测）。只要单测全绿，就说明源码结构与行为都还在。
