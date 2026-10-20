# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## 0.4.0 — 2026-10-20

### 修复

- **配置保存彻底修好**：改用 `ctx.configEditor.edit(entry, change)` 写普通配置。
  之前用 `settings.update/mutate` 一律失败，根因是 `@deepseek-ai/dsh-settings` 的表单
  **只含 `.volatile()` 字段**，我们的额度属普通配置，永远不在 `settings.describe()` 里。
- 写配置成功后**回读校验**（`verified`），客户端在 400ms / 1500ms 各回读一次并与刚保存的值逐项比对；
  不一致时明确提示「磁盘已写入，但运行中的插件还是旧值」，不再假装成功。
- 写配置失败时把底层原因如实透出，并落盘 `last-write.json` 诊断（stage / error / candidate / observed）。

### 新增

- **5 小时上限自动派生**：`fiveHourMode='auto'`（默认）时 `5h 上限 = 周额度 ÷ fiveHourRatio`（默认 7.5）。
  表单里改总额度，下方「5h 生效上限」会实时跟着变；想固定就切 `manual`。

### 变更

- `enforcement` 默认值 `warn` → **`lock`**（开箱即硬锁，只有自己改才会变）。

## 0.3.0 — 2026-10-19

### 新增

- 左下角额度表盘的颜色：正常态由绿改为 **DSH 品牌蓝**，紧张/超额仍为黄/红。

### 修复

- 客户端对宿主回读缺字段免疫（回退默认值），不再因 `undefined.maxHeld` 抛错而卡在「读取中」。
- 任何 RPC 失败都会把真实原因显示出来，并提供「重试」。
- 面板底部显示 `build`，便于确认浏览器加载的是哪一版客户端。

## 0.2.0 — 2026-10-18

### 新增

- **两档模式**：`auto` 开箱即用 / `manual` 全部自己设。
- 插件列表里的配置页（`plugins.row.config`）：两档切换 + 全套额度表单 + 券操作 + 用量统计。
- **用量统计**：今日 / 近 7 天 / 近 30 天 / 累计 / 单日峰值 / 活跃天数 / 当前连续 / 最长连续 /
  最长任务用时 / 会话数 + 近 30 天柱状图（全部本地聚合）。
- 「给自己发一张」鲸元券（受 `voucher.maxHeld` 约束）。

### 变更

- 左下角面板收敛为**只显示额度**（进度、倒计时、券库存、「使用一张」），不再放配置项。

## 0.1.x — 2026-10-14

### 新增

- 5 小时窗 + 周窗计量与展示（tokens 总量）。
- 鲸元券：发放 / 兑换（两窗清零 + 周窗锚点重置）/ 过期。
- 硬锁：`agent/pre-step` → reject、`tools/pre-execute` → deny。
- 左下角进度环 + 百分比挂件，`shell.overlay` 浮层面板。
- `/quota`、`/quota-redeem` 斜杠命令。
- 官方节奏源（可选）：跟随 codex-reset.com 的重置与发券节奏。

### 修复

- 浏览器 RPC 通道：必须用 `connection.fetch.register`，`connection.rpc.intercept` 在 DSH 0.1.5+ 会静默失效。
- 移除顶层 `inject` 导出：cordis 把对象 key 当服务名，`{optional:[...]}` 会让插件永久 `pending`。
