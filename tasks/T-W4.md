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

增补｜2026-11-25｜DSH（用户追加要求）
- 用户原话：「把那个块直接拖到计划里面，而不是点击按钮添加」。原设计只有左上角 18×22 的拖动柄，实际用起来像「按钮替代路径」。
- 做法：可排期的项目卡整卡带 `data-project-drag`（`projects.js`），`planner.js` 的 document 级 pointerdown 除拖动柄外也接住整卡；`projects.css` 加 `cursor:grab` 与拖动中的 `.proj-dragging` 压暗。
- 边界：触屏（`pointerType === 'touch'`）仍只认拖动柄，否则整卡起拖会和右栏滚动抢手势；卡内按钮/链接/输入框/菜单不参与整卡起拖。仍是复制语义，项目卡不动。
- 2026-11-25 用户定「不留」：卡片上的「排进今天」按钮已撤，只留右键菜单里那条（键盘 / 触屏 / Shift+F10 可达）；引导文案改成「按住卡片直接拖」。
- 回归：`app/test/ui-projects.test.mjs` 新增「整卡拖动」1 例；同文件既有「待办拖到落点」用例加 `scrollIntoView`（待办列表变长后坐标会落到列表外，断言含义未变）。
