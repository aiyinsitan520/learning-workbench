工单 T-W2：左栏日计划时间块上下沿都能拖，调节更灵敏
tier：ui   risk：low   执行：DSH   依赖：无
先读：tasks/ROUND-2026-11-24.md（共同规则）、AGENTS.md

用户原话：「左侧任务栏的任务上限（上边）调节还是不太灵敏」（用户确认：上下沿都能拖；上沿改开始时间、结束不变；下沿改时长；手柄加大、拖动时显示时刻）

现状（已核实）：app/public/js/planner.js 只有下沿手柄 `.planner-resize`（planner.css 第 47 行，高 6px）；HOUR_HEIGHT=32px，5 分钟吸附只有约 2.7px，所以很难拖准；上沿完全不能拖。app.js 的 `onChange(block, startsAt, plannedSeconds)` 已支持同时改开始时间和时长（startsAt 变了会提示「已改期」）。

可改文件：app/public/js/planner.js、app/public/planner.css、app/test/ui.test.mjs 中日计划相关用例（或新建 app/test/ui-planner.test.mjs）
不许动：app.js、projects.js、server.js、db.js、tokens.css（Codex 在并行改 server.js/app.js）

要做：
1. 上沿手柄 `data-resize-plan-start="<blockId>"`：拖动改 startsAt，结束时刻不变；吸附 5 分钟；不能早于 06:00（时间轴起点），时长不得少于 15 分钟（原本就短于 15 分钟的块，以原时长为下限）。松手调 `onChange(block, newStart, newSeconds)`。
2. 两个手柄命中区各约 10px（块高度 < 28px 时各缩到 6px，并保证中间仍能按住标题拖动改期）；悬停/聚焦时显示一条细抓手线（令牌色），光标 ns-resize。
3. 拖动时浮动标签显示「09:10–10:00 · 50 分钟」，上沿与下沿都显示。
4. 键盘：上沿手柄 ↑ 提前 5 分钟、↓ 推后 5 分钟；两个手柄 Shift+方向键 = 15 分钟；保留 role=slider 与 aria 值（上沿的 aria-valuetext 写开始时刻）。
5. 时间轴密度：日计划标题区加一个小切换（紧凑 32 / 舒适 48 / 宽松 64 px 每小时），记在 localStorage `workbench.plannerScale`，**默认 48**；也支持在时间轴上 Ctrl+滚轮切换。HOUR_HEIGHT 改为读取当前密度（--hour-height 已是 CSS 变量）。
6. 现有拖动改期、从待办拖入、自动滚动、触控 pointer capture 不能退化。

影响面：默认密度从 32 改 48，旧 UI 用例里按像素算位置的断言需要随之换算（只改像素换算，不改断言含义），回执逐条列出改了哪些断言。

完成标准：
- 用户在左栏能用鼠标拖上沿把 9:00–10:00 改成 9:20–10:00，拖下沿改成 9:20–10:30，刷新后保持；标签实时显示时刻。
- 新增 UI 用例覆盖：上沿拖动、上沿下限 06:00、最短 15 分钟、键盘 ↑↓ 与 Shift、密度切换后拖动仍对齐 5 分钟、390px 宽与六套皮肤下手柄可见可用。
- `verify\run_all.cmd full` 通过（贴通过数/失败数）。
