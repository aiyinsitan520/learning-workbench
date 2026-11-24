工单 T-W4：右栏长期项目直接拖进左栏日计划（复制，不移走项目）
tier：ui   risk：low   执行：DSH   依赖：T-W2 已提交（同改 planner.js）
先读：tasks/ROUND-2026-11-24.md、AGENTS.md、architecture/workbench.d.ts 的 Project/ProjectView

用户原话：「右侧长期项目可以直接复制拖入左侧计划栏，使得效率更高」

现状：每个项目有 `mainTaskId`（自动建的主任务，日计划/专注/正文都用它）和 `dailyMinutes`。planner.js 的 pointerdown 只监听左栏 sidebar，只认左栏待办 `[data-drag-task]`；app.js 已有 `onDrop(taskId, startsAt, plannedSeconds)` 建时间块。

可改文件：app/public/js/planner.js、app/public/js/projects.js、app/public/projects.css、app/public/planner.css、app/test/ui-projects.test.mjs、（必要时）app/public/js/app.js 中给 projects 传回调的那几行——仅当 T-W1 已提交后才可动 app.js，否则写「需要架构决定」
不许动：server.js、db.js、schema、tokens.css

接口约定：
- 项目卡（未完成、未归档）标题区加拖动柄 `data-drag-project="<projectId>"`；如果卡片里列出子任务，每条子任务加 `data-drag-project-task="<taskId>"`。
- planner.js 在 document 级监听这两类 pointerdown，跨栏拖动时显示跟随指针的小卡片；进入时间轴后复用现有预览块与 5 分钟吸附；松手调用 `onDrop(taskId, startsAt, seconds)`。taskId = 项目用 mainTaskId、子任务用自身 id；seconds = `dailyMinutes*60`（无则 1800），夹在 15 分钟和当天剩余之间。
- 项目卡保持不动（这是「复制」）；同一项目当天可以拖多次形成多个块。
- planner.js 导出 `nextFreeStart(seconds): number|null`（今天从当前时刻起第一个放得下的空档），项目卡新增按钮「排进今天」用它；没有空档提示「今天排满了」。这是不用鼠标的替代方式。
- 拖动中按 Esc 取消；拖到时间轴外松手不建块。

完成标准：
- 从右栏把一个每天 45 分钟的项目拖到 14:00，左栏出现 14:00–14:45 的块，标题是项目名；刷新保持；项目卡仍在。
- 「排进今天」按钮可用；已完成/归档项目不可拖。
- UI 用例覆盖：拖入成功、拖到外面取消、Esc 取消、排进今天、排满提示、390px 下按钮可用（窄屏可只保留按钮）。
- `verify\run_all.cmd full` 通过。
