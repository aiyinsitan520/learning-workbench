# 工单与进度

## 2026-11-21

工单：修复跨午夜后日计划不翻页，导致新加的块看不到
可改文件：app/public/js/app.js
不许动：tokens.css、schema、db.js 签名、server.js 路由
完成标准：页面跨过北京时间午夜后自动切到新的一天，新加的块立即可见；verify\run_all.cmd 通过

完成｜DSH｜app/public/js/app.js｜2026-11-21 09:45
根因：页面从昨天一直开着，tick() 只处理计时器，从不检查日期是否跨日。
      用户在北京时间 20 日打开页面，21 日凌晨点 9:00 加了块，数据正确存进 21 日，
      但页面仍停在 20 日，所以看不到（数据没丢）。
修法：tick() 每 5 秒调 checkDayRollover()，用工作台时区（Asia/Shanghai）算今天；
      跨日且页面停在"上次的今天"时自动翻页。用户手动切到别的日期（userPinnedDate）
      或手记有未保存草稿时不抢视图，点「今天」恢复跟随。
验收：verify\run_all.cmd PASS；verify\run_all.cmd full PASS（UI 36/36，含跨时区分日用例）

完成｜Claude｜app/server.js、app/public/js/app.js、app/test/server.test.js｜2026-11-21 10:50
根因：用户的 Chrome 窗口在多次改版前就打开，一直跑旧前端代码（停在 20 日、钟点按旧时区偏 8 小时）。
      点 10 点实际存成 20 日 18:45；DSH 的跨日翻页也要刷新后才生效。
修法：/api/health 增加 build（public/ 最新修改时间，加性字段）；app.js 每 30 秒及窗口回到前台时检查，
      build 变化且无对话框、无拖动、手记已保存时整页重载。以后改前端，开着的窗口会自动换新代码。
数据：经用户本意，「刷视频看手机」时间块改到 2026-11-21 10:00–10:30 北京时间（同 block id）。
      20 日另有两条重复的「准备科研论文」块（17:15、14:00）未动，待用户决定是否删除。
验收：verify\run_all.cmd full PASS（UI 36/36）；内置浏览器实测改前端文件后约 30 秒自动重载。

完成｜Claude｜app/public/js/dom.js、views.js、app.js、app/test/ui.test.mjs｜2026-11-21 11:30
根因：用户 Chrome 装了「Change Timezone for Google Chrome」扩展，篡改 Intl 的时区结果；
      页面用 Intl 把时间换成北京钟点，时间轴整体错开 8 小时，9:00/10:00 的块落在可见范围外，
      新加的块也存错日子（无痕窗口不加载扩展时显示正常，已截图核实）。
修法：dom.js 新增 learnZone/zoneWall：从服务视图（day + range.start）推出工作台时区偏移，
      clockOf、localToday 改用 UTC 运算，不再依赖浏览器 Intl；未取得视图前才回退 Intl。
验收：verify\run_all.cmd full PASS（仓储/服务 55/55，UI 37/37，新增「扩展篡改 Intl」用例）；
      用户真实 Chrome 窗口截图：9:00 准备科研论文、刷视频看手机均显示在左侧计划栏。

完成｜Claude｜tokens.css、skins.css（新）、app.css、planner.css、review.css、index.html、js/skins.js（新）、js/app.js、app/public/skins/（新）、app/test/ui.test.mjs、AGENTS.md、app/README.md｜2026-11-21 多套皮肤与美术优化
内容：六套皮肤（薄荷默认、奶糖 Mac、拿铁、摩卡夜深色、极光、晨玫瑰），顶栏「皮肤」按钮切换并记在本机；
      三个样式表约 100 处写死颜色全部改为令牌，派生色用 color-mix 从基础色推出；每套皮肤配一个 Fluent Emoji 3D 吉祥物。
素材：E:/AI项目/软件UI素材库 新增 theme-001、illustration-002（均标明由 Claude 收录，MIT 许可），INDEX/DECISIONS/PREFERENCES 已更新（备份 .bak-20261121-cc-skins）。
验收：verify\run_all.cmd full PASS（55/55、UI 38/38，新增「皮肤」用例含「样式表无写死颜色」检查）；六套皮肤首页/日历页截图已人工检查。
遗留：默认皮肤是否改为「奶糖 Mac」待用户决定；yesterday.test 与 ui.test 并行时偶发 PNG 下载超时（单独跑通过，重跑通过）。

完成｜Claude｜app/public/js/skins.js、index.html、app/test/ui.test.mjs、app/README.md｜2026-11-21 默认皮肤改为奶糖 Mac
说明：按用户要求默认 candy。选择改存新键 workbench.skin-choice，只在用户点选时写入；旧键 workbench.skin 曾被每次启动自动写成 mint，已弃用。
验收：verify\run_all.cmd full PASS（55/55、UI 38/38）。


## 2026-11-21 v2 工单（Claude 派发；Codex：T1→T2→T3，DSH：T4→T5，两边并行）

框架已由 Claude 提交（caebe56、2619b2b）：数据库 v2（长期项目、项目日志、AI 回顾缓存，旧库自动迁移并备份）、
`app/lib/digest.js`（每日摘要 + AI 数据快照）、`GET /api/review`、`GET /api/context`、项目命令、前端模块插槽。
**接口契约以 `architecture/workbench.d.ts` 为准**（DayDigest、AiContext、AI 路由、ModuleContext），实现前先读它和 `app/lib/digest.js`。

### 并行规则（本轮覆盖 AGENTS.md 第 4 节「开工前 git status 必须干净」）
- 两个 Agent 同时在本目录工作。`git status` 里出现对方文件的改动是正常的：**不碰、不提交、不丢弃**。
- 只改自己工单「可改文件」里的文件；提交时 `git add` 逐个写出自己的文件，禁止 `git add -A` / `git add .`。
- 一张工单一个提交，前缀 `[Codex]` / `[DSH]`。
- 先跑自己的测试文件（`node --test app/test/xxx.test.js` 或单个 `.test.mjs`），再跑 `verify\run_all.cmd full`。
  失败若出在对方正在改的文件，回执里写明，不替对方修。
- 新测试文件放 `app/test/`：`*.test.js` 单元测试、`*.test.mjs` 浏览器测试，`run_all.cmd` 会自动收集，**不用改 verify/**。
- 不重启 7321 端口的服务（用户在用，由 Claude 收尾时统一重启），不读写 `app/data/workbench.db`，测试一律用临时库。
- 前端：新模块只通过 `ModuleContext` 访问外壳；按钮用自己的 `data-board-*` / `data-ai-*` / `data-project-*` 属性并在模块内监听，
  不要用外壳已占用的 `data-page` `data-task` `data-day` `data-month` `data-select` `data-complete` 等（唯一例外：开始专注可用
  `data-action="start" data-focus-task="<任务id>"`）。CSS 只引用 tokens.css 令牌，不写颜色值；六套皮肤都要能看（尤其深色「摩卡夜」）。
- 全部工单完成（或受阻）后，用 HUD `send_message(reply_to=派单消息ID, reply_hint=false)` 回一次，按 AGENTS.md 第 6 节格式逐张写，
  并在 `E:/个人智能工作台/docs/agent-handoff/SESSION_LOG.md` 追加一行。

---

工单 T1（Codex）：模型接入后端——CC Switch 式供应商管理 + AI 写每日回顾
可改文件：app/lib/ai-routes.js（替换占位）、可新建 app/lib/ai-providers.js / app/lib/ai-presets.js / app/lib/ai-client.js、app/test/ai.test.js（新）
不许动：server.js、db.js、digest.js、schema / migrations、workbench.d.ts（有需要先回执写「需要架构决定」）
要点：
- 严格实现 workbench.d.ts「模型接入」一节的全部路由与返回形状。配置存 ctx.ai.configPath（JSON；null 时用内存），原子写（临时文件 + rename）。
- 任何接口、日志、错误信息都不能出现完整 API Key；对外只给 hasKey / keyHint（前 3 位 + … + 后 4 位）。
- 两种协议：openai（POST {baseUrl}/chat/completions，Bearer；列模型 GET {baseUrl}/models）、
  anthropic（POST {baseUrl}/v1/messages，x-api-key + anthropic-version: 2023-06-01；列模型 GET {baseUrl}/v1/models）。
  baseUrl 只接受 http/https，去掉末尾斜杠；请求超时 45 秒；401/402/403/429/超时/网络错误给中文提示（参考 app/public/js/review-data.js）。
  所有网络请求用 ctx.ai.fetch（测试注入假 fetch，不许真联网）。
- 预设（GET /api/ai/presets）至少：DeepSeek、Kimi（Moonshot）、通义千问（DashScope 兼容模式）、智谱 GLM、硅基流动、OpenRouter、
  OpenAI、Anthropic、Ollama 本地（needsKey=false）、自定义。模型名会过时，以「获取模型列表」为准，预设里给 1–3 个常见名即可。
- 导入（POST /api/ai/import）按契约支持 5 种格式；同 baseUrl + model 的重复项更新而不是新增。导出不含 Key。
- POST /api/ai/review：digest = dayDigest(wb, day)，hash = factsHash(digest)；有缓存且 hash 相同且非 force → 直接返回；
  否则用当前供应商生成，wb.saveDailyReview 存库，返回 { review: {...saved, stale:false} }。没有当前供应商 → WorkbenchError('invalid','还没有设置模型，请先到「模型接入」添加')。
  提示词：中文、第二人称、不超过 220 字；依次写昨天做了什么、计划执行情况（plan.followRate、未完成块）、长期项目进展，最后给今天一条具体建议；
  只用给定事实，排期不等于完成，秒要换算成分钟/小时。只发 digest（去掉 startsAt 等无用字段即可），不发任务正文。
- 测试 app/test/ai.test.js：用 start({ dbPath: 临时库, aiConfigPath: 临时文件, fetchImpl: 假 fetch }) 覆盖：增删改查与激活、Key 不外泄
  （所有响应 JSON 里搜不到原 Key）、保存时空 Key 保留原 Key、列模型（两种协议）、测试连接写 lastTest、5 种导入格式、
  review 的缓存 / stale / force / 无供应商报错、错误码映射。
完成标准：node --test app/test/ai.test.js 全过 + verify\run_all.cmd 通过

工单 T2（Codex）：模型接入页面（齿轮按钮进入，页面 key 'ai'）
可改文件：app/public/js/ai-settings.js（替换占位）、app/public/ai.css、app/test/ui-ai.test.mjs（新）
不许动：app.js、index.html、views.js、api.js、tokens.css、skins.css
要点（参考 CC Switch 的使用感受，按本工作台的奶糖 Mac 风格做，圆润卡片）：
- 供应商卡片列表：名称、协议徽标、模型、Key 提示（•••• a1b2）、「当前使用」标记、上次测试结果与延迟；卡片上：设为当前、测试、编辑、删除（删除要二次确认）。
- 「添加供应商」→ 预设网格（名称 + 一句说明）→ 表单：名称、协议、Base URL、API Key（密码框，可显示/隐藏；编辑时留空 = 不改，
  提示文字写明）、「去申请 Key」链接（keyUrl）、模型（输入框 + datalist，旁边「获取模型列表」按钮）、测试连接、保存。
- 「导入」：弹窗贴 JSON / 环境变量文本 → /api/ai/import，显示导入了几个；「导出（不含 Key）」下载 JSON。
- 页面底部写清隐私：生成回顾时发给模型的内容（昨日完成的任务名、专注用时、计划块、长期项目进展；不发任务正文），Key 只存在本机 app/data/ai-providers.json。
- 空状态：没有供应商时显示大号预设网格，引导添加。
- 浏览器测试 ui-ai.test.mjs：服务用 start({..., fetchImpl: 假 fetch})（参考 ui.test.mjs 的 before/after），覆盖添加（选预设→填 Key→获取模型→保存）、
  设为当前、测试连接、编辑时 Key 留空不变、导入、删除确认、页面 DOM 里找不到完整 Key、窄窗口 440px 不横向溢出、无控制台错误。
完成标准：齿轮进入页面可完成「添加 DeepSeek → 测试 → 设为当前」；node --test app/test/ui-ai.test.mjs 全过 + verify\run_all.cmd full 通过

工单 T3（Codex）：让数据方便外部 AI 读取
可改文件：app/lib/context-md.js（替换占位）、app/tools/export-ai.mjs（新）、app/test/export.test.js（新）、docs/DATA_FOR_AI.md（新）、
          导出给AI.ps1（新，根目录，UTF-8 带 BOM + CRLF）、app/README.md（只加「给 AI 读取数据」一节）
不许动：digest.js、server.js、db.js
要点：
- contextMarkdown(snapshot)：给 AI 看的 Markdown：开头一段口径说明（来自 snapshot.guide）；「待办」「长期项目（含每日进展）」；
  每天一节（日期 周几：完成、专注合计与按任务、计划表 HH:MM 标题 分钟 是否完成/专注、项目进展），空白天合并成一行「x 天无记录」；
  有 taskNotes 时附在最后。分钟取整，不出现 Unix 秒。
- export-ai.mjs：`node app/tools/export-ai.mjs [--days 30] [--notes] [--out <目录>] [--db <库路径>]`。
  优先请求正在运行的服务 http://127.0.0.1:7321/api/context（json 与 md 各一份）；服务没开时，把库用只读连接 VACUUM INTO 复制到临时文件，
  再对副本 openDatabase + contextSnapshot（绝不直接打开或迁移用户的库）。输出默认 app/data/ai-export/：
  `工作台数据-<日期>.json`、`工作台数据-<日期>.md`、`README.md`（说明字段口径，可直接复制 docs/DATA_FOR_AI.md 内容）。打印输出路径。
- 导出给AI.ps1：双击运行上面的脚本（默认 30 天，不含正文），完成后用资源管理器打开输出目录；失败弹窗说明原因。
- docs/DATA_FOR_AI.md：给人和 AI 看的数据说明：数据在哪（库、导出、接口三种方式）、表结构与字段含义（含 v2 新表）、时间与时区口径、
  隐私提醒（正文默认不导出，Key 不在库里）、给其他 AI 的推荐提示词示例（分析学习节奏、计划执行、长期项目风险）。
- 测试 export.test.js：临时库造数据，验证 md 关键段落、空白天合并、--notes 开关、离线模式不改源库（导出前后源文件哈希一致）。
完成标准：双击「导出给AI.ps1」得到 json + md + README；node --test app/test/export.test.js 全过 + verify\run_all.cmd 通过

---

工单 T4（DSH）：每日维护看板（顶栏「维护」，快捷键 5，页面 key 'review'）
可改文件：app/public/js/board.js（替换占位）、app/public/board.css、app/public/js/review.js（可导出 paint / localText 复用）、app/test/ui-board.test.mjs（新）
不许动：app.js、index.html、views.js、api.js、digest.js、server.js、tokens.css、skins.css
数据：`ctx.api.get('/api/review?day=…')` → { digest: DayDigest, factsHash, review: DailyReview|null, today }（默认昨天）。
布局（自上而下，圆润卡片，奶糖 Mac 风格）：
1. 标题行：「每日维护」+「11 月 20 日 周五 · 昨天」；‹ › 切换日期（不能晚于 today）；右侧「保存图片」（沿用 review.js 的画布导出）。
2. 四个数字卡：完成任务数；专注（x 小时 y 分 · n 轮）；计划执行率（followRate 百分比，null 显示「无计划」）；计划 vs 实际（计划 x 分钟 / 计划内专注 y 分钟）。
3. AI 回顾卡：有 review 显示正文与「模型 · 生成时间」，stale 时显示小标签「记录有更新」+「重新生成」；没有则显示本地摘要（review.js 的 localText）+「生成 AI 回顾」。
   按钮 → `ctx.api.post('/api/ai/review', { day, force })`；报错含「还没有设置模型」时给出「去设置模型」按钮 → `ctx.gotoPage('ai')`；其他错误原样提示。（T1 未完成前接口会报「尚未实现」，照常显示错误即可。）
4. 「没做完的计划」：digest.unfinishedBlocks 每行：时间、标题、分钟、[顺延到今天] [标记完成]；有 2 条以上时显示「全部顺延到今天」。
   顺延 = `ctx.api.command({type:'saveSchedule', block:{ id:newId('block'), taskId, startsAt: 原 startsAt + (今天 range.start − 该日 range.start), plannedSeconds: 分钟*60 }})`
   （今天的 range 用 `ctx.api.get('/api/view?day='+today)` 取；newId 从 ./api.js 导入）；完成 = setTaskCompleted。操作后该行变「已顺延 / 已完成」，并 `ctx.reload()`。
5. 「长期项目」：digest.projects 每个一张小卡：名称、第 dayIndex/totalDays 天、剩 daysLeft 天（负数显示「逾期 n 天」用 --danger）、
   当天专注 vs dailyMinutes 的进度条；进展输入框（预填 log.note）+ 进度 0–100 滑块 + 保存 → saveProjectLog（day = 看板这一天）。
6. 「当天明细」折叠区：完成清单、按任务的专注用时、计划时间表。
空白天：吉祥物（var(--mascot)）+「这一天没有记录」，仍可切换日期。
浏览器测试 ui-board.test.mjs（参考 ui.test.mjs 的 before/after 自起临时服务；用 /api/command 造「昨天」的数据：可在建时间块时把 startsAt 设到昨天）：
覆盖数字卡、顺延到今天后今天的日计划出现该块、标记完成、项目进展保存后刷新仍在、切换日期、AI 按钮报错时出现提示、六套皮肤下无写死颜色（已有检查）、440px 不溢出、无控制台错误。
完成标准：按 5 进入看板能完成上述操作；node --test app/test/ui-board.test.mjs 全过 + verify\run_all.cmd full 通过

工单 T5（DSH）：长期项目（右栏「长期项目」区块，解决跨多天的任务）
可改文件：app/public/js/projects.js（替换占位）、app/public/projects.css、app/test/ui-projects.test.mjs（新）
不许动：同 T4
数据：view.projects（ProjectView[]）；命令 createProject / updateProject / setProjectState / saveProjectLog（见 workbench.d.ts）。
要点：
- 区块头「长期项目」+ 数量 + 「＋」按钮；没有项目时显示一行引导「连续多天的事，建成长期项目」+ 按钮（不要隐藏整个区块）。
- 新建弹窗（ctx.modal）：名称（必填）、目标（可选）、开始日期（默认今天 ctx.state.view.day）、截止（快捷：1 周 / 2 周 / 1 个月 / 无截止 + 日期输入）、
  每天投入（30 / 60 / 90 / 自定义分钟，可空）。id = newId('proj')，mainTaskId = id + '-main'。
- 项目卡：名称；「第 3/13 天 · 剩 10 天」（无截止显示「第 3 天」，逾期红色）；今天专注 / 每日目标 的细进度条；最近进展一行（log 或 lastLog）；
  按钮：开始专注（`data-action="start" data-focus-task=主任务id`）、写正文（ctx.openTask(mainTaskId)）、⋯ 菜单：编辑、完成项目、归档（完成/归档要确认）。
- 主任务会出现在左栏待办里（course='长期项目'），可以直接拖进日计划，这部分不用改。
- 浏览器测试 ui-projects.test.mjs：新建（含快捷截止）→ 卡片天数正确；开始专注后灵动岛/专注页是该主任务；编辑改名后左栏待办同步；完成后从卡片区消失；
  440px 不溢出；无控制台错误。
完成标准：右栏可建、看、专注、编辑、完成长期项目；node --test app/test/ui-projects.test.mjs 全过 + verify\run_all.cmd full 通过

### T4 结果

完成｜DSH｜app/public/js/board.js、app/public/board.css、app/public/js/review.js、app/test/ui-board.test.mjs、app/test/yesterday.test.mjs｜2026-11-21 22:50｜提交 e7aa0d3
看板：标题行（日期 + 昨天/今天 + ‹ › 不晚于 today + 保存图片）、四个数字卡、AI 回顾卡（有 review 显示正文与模型·生成时间，
stale 显示「记录有更新」+ 重新生成；无则本地摘要 + 生成按钮；报错原样提示，含「还没有设置模型」时给「去设置模型」）、
「没做完的计划」（顺延到今天 / 标记完成 / 全部顺延）、「长期项目」（天数、剩余、当天进度条、进展 + 进度保存）、
「当天明细」折叠区、空白天吉祥物。
review.js 的 localText / paint 改为导出并接受可选标题与落款，看板复用同一套画布导出。
验收：node --test app/test/ui-board.test.mjs 7/7；verify\run_all.cmd full PASS（66/66、UI 55/55）。
删改已有断言：app/test/yesterday.test.mjs 原断言的 .review-page DOM 已随「昨日总结」页撤下，改为覆盖仍然存在的
localText 口径、日期边界、页面不含任务正文、看板「保存图片」的 PNG 尺寸。
遗留：app/public/review.css 里 .review-page 那一批规则已无对应页面，因不在本工单可改文件里未动，留给架构决定是否删除。

### T5 结果

完成｜DSH｜app/public/js/projects.js、app/public/projects.css、app/test/ui-projects.test.mjs｜2026-11-21 22:52｜提交 fbbca47
右栏「长期项目」：区块头（数量 + ＋）、空态引导、新建弹窗（名称 / 目标 / 开始日期 / 快捷截止 1 周·2 周·1 个月·无截止 / 每天投入
30·60·90·自定义）、项目卡（第 n/total 天 · 剩 n 天，逾期用 --danger；今天专注 / 每日目标进度条；最近进展一行；
开始专注 / 写正文 / ⋯ 菜单：编辑·完成项目·归档，后两者二次确认）。弹窗改为 novalidate + 中文提示。
验收：node --test app/test/ui-projects.test.mjs 9/9；verify\run_all.cmd full PASS（66/66、UI 55/55）。

验收｜Claude｜v2 T1–T5 全部通过｜2026-11-21 23:00
提交：Codex ab31a31 / 42e18b9 / 9d396bb / 72ad8f4；DSH e7aa0d3 / fbbca47 / 8777e83；Claude 收尾 7e738dc（撤下 review-data.js 与 review.css）。
验收：verify\run_all.cmd full PASS（仓储/服务 66/66、UI 55/55）；真实库副本截图检查看板、模型接入、长期项目（奶糖 Mac、摩卡夜），无控制台错误、DOM 无 Key；代码审查 Key 脱敏、0600 写盘、禁重定向、Base URL 无凭据。
上线：7321 已重启，库 v1→v2 自动迁移，备份 app/data/workbench.db.bak-v1-20261121T150007。
遗留：真实供应商连通性待用户填 Key 实测；右栏项目卡标题过长时截断，可改两行显示（小优化）。

### T4 追加（架构决定：迁移旧昨日页用例）

完成｜DSH｜app/test/yesterday.test.mjs｜2026-11-21 23:05
Claude 追加：旧 yesterday.test.mjs 仍等 .review-page 画布，v2 看板上线后必失败，要求迁移到 board.js 的 DOM。
做法：start({ aiConfigPath: 临时文件, fetchImpl: 假 fetch })，先 POST /api/ai/providers/save 建供应商再生成，全程不联网。
保留的覆盖点（全部改为看板 DOM）：默认看昨天与 today 边界；AI 生成失败时 .board-ai .board-error 原样显示「API Key 无效」
且按钮恢复可点；生成成功后 .board-ai .board-text 是模型正文、.board-meta 显示「假模型 · fake-model」并落库；
刷新走缓存不再请求模型；记录变化后显示「记录有更新」+「重新生成」；「保存图片」下载 760 宽（1520px）PNG；
390px 不横向溢出；页面不含任务正文与 Key。
删除的旧断言：.review-page 的 h1/画布/宽高、.review-ai 折叠区与浏览器内 DeepSeek Key 输入框（含 value 清空）、
.window.reviewRequests 直接拦 https://api.deepseek.com/chat/completions 的那套、canvas ariaLabel、
.review-status 文案、旧 canvas 宽度 > 300 的等待条件。
验收：node --test app/test/yesterday.test.mjs 1/1；verify\run_all.cmd full PASS（架构 17×2、契约 11、行为 17、
仓储/服务 66/66、浏览器 UI 55/55）。
注：假 Key 故意取 8 个字符（testkey1），因为 verify 的 security.no_secret 会把 apiKey: '<12 字以上>' 判成明文密钥。

复盘｜Claude｜v2 一轮｜2026-11-21
用时：派单 06:09 → Codex 三张工单 06:42（约 33 分钟）→ DSH 两张工单 06:53（约 44 分钟）→ 验收上线 07:00。
用量（HUD）：Codex 99 次调用，输入约 19 万 + 缓存读 987 万（命中 98%），输出约 2.6 万；DSH 141 次调用，输入约 2482 万（缓存命中 0%，旧会话含此前历史），输出约 22 万。
问题：验收脚本改了三次（cmd 通配符 / 中文路径 / LF）；旧昨日测试的迁移在派单时遗漏；给 DSH 的追加消息多余，多了一轮和两个提交；Codex 因信任设置缺失需要用户逐步确认；Codex 把别人的失败当成阻塞。改进见 AGENTS.md 第 9 节。

完成｜Claude｜js/pip.js（新）、js/app.js、js/task-notes.js、js/views.js、index.html、app.css、app/test/ui-pip.test.mjs（新）、app/README.md｜2026-11-22 完成任务按钮 + 番茄钟悬浮小窗
验收：verify\run_all.cmd full PASS（66/66、UI 58/58，新增 3 项）；小窗预览截图（奶糖 Mac、摩卡夜）已检查。真实置顶小窗需用户在 Chrome 里亲手点开验证（内置浏览器拦截非用户点击的弹窗）。
