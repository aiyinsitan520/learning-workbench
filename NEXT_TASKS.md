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

完成｜Claude｜app/island/island.ps1（新）、app/lib/island.js（新）、server.js（/api/island）、js/app.js、js/views.js、index.html、app.css、app/test/island.test.js（新）、ui-pip.test.mjs、app/README.md｜2026-11-22 桌面灵动岛
原因：浏览器画中画小窗必带黑色标题栏，去不掉；改为 Windows 原生无边框置顶黑色胶囊（WPF，参考 Wisland/Apple）。
坑：Node spawn 的 PATH 里没有 PowerShell（用完整路径）；detached:true 让 PowerShell 无控制台约 80ms 退出（不用 detached）；被强杀后互斥量「被遗弃」需捕获。
验收：verify\run_all.cmd full PASS；真实服务上经 /api/island 打开，截图确认顶部居中、显示真实任务。
完成｜Codex｜桌面打包、实机图库、GitHub 下载与使用指南｜2026-11-22。Windows x64 与 macOS arm64/x64 首轮原生构建通过（Actions 45003911239），full 68+58 通过。发布版由 v1.0.0 标签触发。

完成｜Claude｜app/lib/updater.js、update-config.js、version.json、js/update.js（新）、server.js（/api/update、入口判断）、index.html、app.css、js/app.js、workbench.d.ts、desktop/main.mjs、update-install.mjs、update-helper.ps1、release-manifest.mjs、update-keys.mjs（新）、build.py、.github/workflows/desktop.yml、README.md、app/README.md、测试 update.test.js、ui-update.test.mjs（新）｜2026-11-23 桌面版自动更新（参考贾维喵管家）
做法：Release 附 latest.json + Ed25519 签名（零依赖，node:crypto）；客户端验签 → 核对仓库/标签/版本/下载地址 → 限 400 MiB、边下边算 SHA-256 → 安装前再算一次 → 用户确认 → 备份资料库、解压到旁边、助手脚本等程序退出后换文件夹并重启（旧版留 .previous）。Mac 校验后打开 DMG 由用户拖入。只检查不自动下载；源码运行只能检查（git pull）。
坑：Electron 退出会连带结束它启动的子进程，助手必须经 WMI Win32_Process.Create 启动；detached 会让隐藏 PowerShell 立刻退出。server.js 原入口判断拿 argv[1] 拼 URL，桌面版带参数启动即崩溃（v1.0.0 起就有），已修。
验收：verify\run_all.cmd full PASS（契约 17/17、服务 83/83、UI 61/61，新增 14 项）；本机真实演练：缓存 Electron 44.9.3 拼 1.1.0 与 1.1.1，本机模拟 Release，1.1.0 检查→下载→校验→安装→2 秒后以 1.1.1 重开，任务与正文保留、备份在、旧版在 .previous、下载包已清理，未碰真实 %APPDATA%。
待用户：① 生成签名密钥并设 GitHub secret UPDATE_SIGNING_KEY（node desktop/update-keys.mjs init，未做）；② 提交推送后打 v1.1.0 标签发布。没有公钥的版本只能提示到发布页手动下载；没有 secret 时发布任务会失败、不会发出无签名清单。
未验证：Mac 打开 DMG 路径（无真机）；GitHub 真实 Release 上的清单读回（首次发 v1.1.0 时由 workflow 的 cmp 步骤验证）。
完成｜Claude｜app/lib/update-config.js｜2026-11-23 用户同意后生成更新签名密钥：公钥写入源码，私钥在本机 %APPDATA%\learning-workbench-release\update-signing-key.pem（未入库），GitHub secret UPDATE_SIGNING_KEY 已设置。真实私钥签名自检通过，快速验收 PASS。剩余：推送后打 v1.1.0 标签发布；私钥需用户另外备份。

## 2026-11-23 · 问题 1：对话收获速记（用户已确认按推荐方案开工：单独收获库、暂不做书签按钮、不存原文）

用户原话：「记录计划和规划，以及总结还是比较繁琐，我一般在chatgpt网页端问完问题，有所收获，就想记录，但是内容较长，我只想记录精华，但是总结有点麻烦」

思路：让 ChatGPT 自己做总结，因为它看得到整段对话，而且不额外花钱。它按固定格式输出精华，用户一键复制，粘进工作台就自动拆好；格式不对或者粘的是原文，再用「模型接入」里的当前模型提炼。精华里的「待办」可以一键转成待办或日计划，顺带解决记计划麻烦的问题。

固定格式（ChatGPT 输出，工作台解析）：
    【收获】标题（≤20 字）
    结论：一句话
    要点：
    - …（3–5 条）
    待办：
    - …（没有写「无」）
    标签：#… #…

待用户拍板：① 收获单独存一个「收获」库（推荐），还是写进任务正文/项目日志；② 是否同时做 chatgpt.com 一键发送（书签按钮），推荐先不做，粘贴版用一周再定；③ 原文是否保存（推荐不存，只存精华和对话链接）。

工单 T-H1：收获的数据层与提炼接口
tier：hard  risk：low  执行：Claude（架构文件）
可改文件：architecture/migrations/004_harvests.sql（新）、architecture/workbench.d.ts、app/lib/db.js、app/lib/harvest.js（新，固定格式解析）、app/lib/ai-routes.js（POST /api/ai/distill）、app/server.js（GET /api/harvests）、app/public/index.html（「收获」页插槽）、app/test/harvest.test.js（新）
接口约定：表 harvests(id, day, title, conclusion, points, todos, tags, source, source_url, task_id?, project_id?, created_at, updated_at)；命令 createHarvest / updateHarvest / deleteHarvest 走 /api/command；parseHarvest(text) 返回 {ok, harvest} 或 {ok:false}，解析失败才调 AI；AI 未配置时回退为手动填写，不报错。
影响面：旧库自动迁移到 v4 并备份，旧页面不受影响。
完成标准：固定格式和三种变体（多空行、全角冒号、没有待办）都能解析；迁移和重开 PASS；verify\run_all.cmd 通过。

工单 T-H2：「收获」页面（粘贴 → 预览改 → 保存 → 列表/搜索）
tier：ui  risk：low  执行：Codex（2026-11-23 改派：DSH 只登记了 E:\电脑总管，未登记本工作区）  依赖：T-H1
可改文件：app/public/js/harvest.js（新）、app/public/harvest.css（新，只用令牌）、app/test/ui-harvest.test.mjs（新）
完成标准：任意页面按 Ctrl+Shift+V 或点顶栏「收获」打开粘贴框；粘贴固定格式即时出卡片，可改后保存；待办一行一键「加入待办」或「排进今天」；按标签、关键词筛选；390px 不溢出；六套皮肤通过；verify\run_all.cmd full 通过。

工单 T-H3：收获进入回顾与 AI 上下文，并配使用说明
tier：easy  risk：low  执行：Codex low  依赖：T-H1
可改文件：app/lib/digest.js、app/lib/context-md.js、docs/DATA_FOR_AI.md、docs/收获速记.md（新，含 ChatGPT 提炼口令）、对应测试
完成标准：当天的收获出现在每日维护的 AI 回顾素材和 /api/context 里；说明文档写清楚如何把口令设成 ChatGPT 自定义指令；verify\run_all.cmd 通过。

后续可选 T-H4：chatgpt.com 书签按钮一键发送（本机接口要加一次性令牌和来源检查），等 T-H2 用一周后再定。

完成｜Claude｜T-H1 收获数据层与提炼接口｜2026-11-23
改动：architecture/migrations/004_harvests.sql（新）、workbench.d.ts（v4 一节）、app/lib/db.js（readHarvests/readHarvestsOnDay/readHarvest/createHarvest/updateHarvest/deleteHarvest/promoteHarvestTodo，SCHEMA_VERSION=4）、app/lib/ai-routes.js（POST /api/ai/distill）、app/server.js（GET /api/harvests、四个命令、备份表加 harvests）、app/public/js/harvest-format.js（新，页面与服务端共用的解析器和 ChatGPT 口令）、harvest.js/harvest.css（占位，T-H2 替换）、index.html、js/app.js（第 6 页「收获」、Ctrl/⌘+Shift+V）、js/views.js、js/icons.js、app/test/harvest.test.js（新，10 项）。
改动旧断言（理由：版本和页面数按设计增加）：v2/review 测试的 user_version 3→4；server 导出表清单加 harvests；ui 顶栏工具 5→6 个、名称加「收获」。
验收：node --test app/test/harvest.test.js 10/10；verify\run_all.cmd full PASS（架构 17×2、契约 11、行为 17、仓储/服务 93/93、浏览器 UI 61/61）。
未做：7321 服务未重启（真实库仍是 v3，重启时自动迁移并备份），等 T-H2/T-H3 完成后统一重启。
完成｜Codex｜T-H2 收获页面（7f85c05）｜2026-11-23：粘贴框（固定格式即时解析、用 AI 提炼、手填）、收获页（口令复制、搜索、标签、加载更多、编辑/复制/删除）、待办「加入待办」「排进今天」。ui-harvest.test.mjs 10/10。Claude 验收补两处边界：凌晨从 06:00 起排、恰好到 24:00 允许。用量 Codex high 约 17.5 分钟，输入 292.6 万（缓存 257.6 万）、输出 2.2 万 token。
完成｜Codex｜T-H3 收获进入回顾与快照（9a5fb77）｜2026-11-23：reviewMaterial/reviewHash（无收获时指纹不变）、/api/context JSON 与 Markdown、AI 回顾提示词、docs/收获速记.md、DATA_FOR_AI.md、README。harvest-review.test.js 4/4。用量 Codex low 约 6 分钟，输入 74.7 万（缓存 68.3 万）、输出 0.58 万 token。
合并验收｜Claude｜2026-11-23：verify\run_all.cmd full PASS（架构 17×2、契约 11、行为 17、仓储/服务 97/97、浏览器 UI 71/71）；临时库演示服务实看收获页与粘贴框。7321 已用停止+启动脚本重启，真实库 v3→v4 自动迁移，备份 app/data/workbench.db.bak-v3-20261123T091726，/api/harvests 返回 0 条、health 正常。
本轮说明：DSH 只登记了 E:\电脑总管，T-H2 按升级顺序改派 Codex；两单执行者均未提交，由 Claude 验收后按工单分别提交。Codex 沙箱里没有 python，快速验收的 3 个 Python 检查须由调度方补跑。
待用户：在 ChatGPT 自定义指令里放口令（见 docs/收获速记.md 或收获页「复制 ChatGPT 口令」），真实用一周后决定是否做 T-H4 书签按钮；用户提到「还有几个问题」，目前只给了第 1 个。
下一位：从本段继续。若改收获页，从 app/public/js/harvest.js 与 app/test/ui-harvest.test.mjs 继续；改格式或解析，只改 app/public/js/harvest-format.js（页面与服务端共用）并跑 harvest.test.js。
（两单并行，执行者不提交，Claude 验收后统一提交；契约补充见 bbc2bb0）

工单：桌面版菜单可在本机库和现有服务器库间切换。
可改文件：desktop/main.mjs、NEXT_TASKS.md、docs/agent-handoff/SESSION_LOG.md
完成标准：保留两套数据并清楚标记活动数据源，离线可访问本机，原生桌面切换与 verify\run_all.cmd full 通过。
完成｜Codex｜桌面数据源切换及 Mac 安装。Windows/macOS 桌面 smoke PASS，full PASS（97 项服务、71 项浏览器）；Mac 共享库 81 条记录可读。
完成｜Claude（/team，未派单）｜app/public/js/plan-now.js（新）、app/public/js/app.js、focus.js、pip.js、views.js、board.js、review.js、app/server.js、app/lib/digest.js、app/lib/ai-routes.js、app/island/island.ps1、architecture/workbench.d.ts、app/test/plan-now.test.js（新）、yesterday.test.mjs｜2026-11-23 灵动岛番茄钟跟随当前计划 + 每日总结补全
用户原话：「每日总结不够全面，灵动岛的番茄钟和现在的计划时间不匹配，修复这个BUG」
根因：① 桌面灵动岛空闲时写死 25 分钟、开始时也是 1500 秒；任务取 recommend()，它返回「当天最早的未完成时间块」，早上的块过了也一直推荐它。网页顶栏灵动岛显示「开始 预计时长」，实际却按专注页下拉的 25 分钟开始，两边也对不上。② 回顾素材只有按任务汇总的专注，没有每轮起止时刻、时间块结束时刻、当天新建任务和待办清单；提示词 300–600 字、只要求五节，看板明细也看不到当天记录和收获。
做法：新增共用口径 plan-now.js（服务端与页面同用）：处在时间块里 → 番茄钟到块结束；块未开始 → 块的计划时长；没有计划 → 25 分钟；手动选过时长则用手选。/api/view 新增 plan（只在看今天时有），没有 prefer 时 recommended 跟 plan 走。桌面灵动岛、顶栏灵动岛、专注页（下拉新增「跟随计划」）、悬浮小窗都按它显示和开始。每日总结：DayDigest 加 focus.timeline、plan.blocks[].end、created；回顾素材加 pending；提示词改六节（新增【时间线】逐块对照计划与实际，完成项逐一点名、项目进展逐个说明），500–1000 字，max_tokens 2600、存储上限 3000 字；/api/review 附 notes（仅标题，不含正文）与 harvests；看板「当天明细」加专注时间线、当天记录、当天收获、新建任务；无模型时的本地摘要补全时长、执行率、记录与收获数。
验收：verify\run_all.cmd full PASS（架构/契约/行为通过、仓储/服务 102/102、浏览器 UI 71/71）；plan-now.test.js 5/5。首次 full 中「保存图片」PNG 等待超 9 秒失败（已知时序抖动，单跑 2/2 通过），等待放宽到约 22 秒，断言含义不变。实机：临时库 + 临时端口启动真实桌面灵动岛，展开态显示「线代第三章习题 · 日计划 20:00–21:30 · 68 分钟」、倒计时 67:45；经 UI 自动化点开始，生成的专注 startedAt+plannedSeconds 恰好等于时间块结束。未碰真实库。
影响：DayDigest 字段增加 → 已生成的旧回顾会显示「记录有更新」，点「重新生成」即得新版完整回顾（会调用一次模型）。
未验证：真实模型生成的新版回顾质量（需用户在看板点「重新生成」看效果）；Mac 无桌面灵动岛（仅 Windows）。

工单：让桌面版像浏览器一样调节页面缩放，并发布 v1.2.1。
可改文件：desktop/main.mjs、desktop/build.py、desktop/release-notes/v1.2.1.md、app/version.json、README.md、docs/DATA_FOR_AI.md、NEXT_TASKS.md、docs/agent-handoff/SESSION_LOG.md
完成标准：Ctrl/⌘ 和原生菜单可放大、缩小、还原；本机和服务器页面均可缩放；Windows 桌面 smoke、全量验收及三平台发布通过。
完成｜Codex｜新增桌面「视图」菜单和浏览器式页面缩放，补充 Claude Code 本机摘要说明，修复 Windows 更新器读取新包版本文件的兼容性。
验收：verify\run_all.cmd full PASS（服务 102/102、浏览器 71/71）；Windows 桌面 smoke PASS，覆盖两种数据源的菜单、快捷键映射和实际页面宽度。
发布：从此工单的提交打 v1.2.1 标签，由 Desktop packages 工作流产出三平台包和签名更新清单。

## 2026-11-24 · 九个体验问题（Claude 规划，Codex/DSH 实现）

总览、用户原话、用户确认和共同规则：tasks/ROUND-2026-11-24.md；每单详情 tasks/T-W*.md。
Codex 队列 W1 → W3 → W8a → W5 → W6；DSH 队列 W2 → W4 → W1b → W8b → W7 → W9。
第一批派发：T-W1（Codex xhigh，数据文件夹 + 实时同步）、T-W2（DSH，时间块上下沿拖动）。其余待前置提交后派。
下一位：新会话说「/team 继续 学习工作台」，先 git log 看 T-W1/T-W2 是否已提交、读回执，验收后按依赖派下一批。
派单记录｜2026-11-24｜T-W1 → Codex xhigh（codex-worker 后台运行，回执在 E:\多agent协作\runs\codex\<时间>-T-W1\last.md）；T-W2 → DSH 新会话 deepseek:session-56579db0-1825-42d1-87cf-06c5fb345a46，HUD 消息 m-c3edd28d73ce（用 get_message 查，不催）。
验收｜Claude｜T-W1｜2026-11-24：后端新测试 10/10、快速验收 PASS（Codex 跑）；沙箱外浏览器逐文件：ui-ai 1、board 7、pip 3、projects 9、update 3、harvest 10、yesterday 1 全过；ui.test.mjs「关掉服务再打开」超时——SSE 长连接让 server.close 不回调（full 卡死根因），退回 Codex 第 1 次（会话 01a20ca1-01b3-76d3-9a79-47796ac0209e，-Resume）。ui-planner 4 项、ui.test 日计划 2 项失败属 T-W2 进行中。Codex T-W1 用量：xhigh 38.7 分钟，输入 1012 万（缓存 994 万）、输出 5.9 万。待定：看板/收获页的实时刷新并入 T-W8b。
验收通过｜Claude｜T-W1｜2026-11-24：退回 1 次修复 SSE 关停后，在只含 T-W1 改动的临时工作树里 verify\run_all.cmd full PASS（仓储/服务 113/113、浏览器 71/71）。桌面冒烟需打包，未跑。修复轮 Codex 约 6 分钟、输入约 295 万（多为缓存）、输出约 0.6 万。
派单记录｜2026-11-24｜T-W3 → Codex（HUD，默认 high），会话 01a20ce6-9a3c-77f2-88f9-ebf9d8cc880d，消息 m-41de584f4406。DSH T-W2 补充说明消息 m-c00586892f80。
完成｜DSH｜T-W2｜2026-11-24｜app/public/js/planner.js、app/public/planner.css、app/test/ui.test.mjs、app/test/ui-planner.test.mjs｜上沿/下沿各 10px 手柄、拖动标签「09:20–10:00 · 40 分钟」、键盘 ↑↓ 与 Shift、时间轴密度 32/48/64（默认 48，localStorage workbench.plannerScale，Ctrl+滚轮）｜ui-planner 11/11、ui.test.mjs 37/37、其余 7 个浏览器文件 34/34、verify\run_all.cmd 快速 113/113 PASS；full 被 T-W1 的 SSE server.close 已知问题卡住（Claude 已确认与本单无关）｜待验收验收通过｜Claude｜T-W2｜2026-11-24：full PASS（113/113、浏览器 82/82），DSH 自行提交 fa3b4d2；旧断言仅像素换算随密度。派单记录：T-W4 → DSH 新会话 deepseek:session-4b409e18-e3e1-4770-b4f8-8d7f84eb0c53，消息 m-67fed535e5fb。T-W3（Codex HUD）读完文件后中断，续做消息 m-3dabf9a1edba 排队，需用户在 Codex 应用打开该对话。
完成｜Codex｜T-W3｜任务正文粘贴、拖入、选择图片，缩略图与 Markdown 预览；附件按 SHA-256 去重，单张上限 10 MiB｜专项 5/5；full PASS，服务 117/117、浏览器 83/83｜7321 正式服务待重启，孤儿附件保留。
验收通过｜Claude｜T-W3｜2026-11-24：Codex 提交 1f977c2，full PASS（服务 117/117、浏览器 83/83，Codex 跑）；Claude 抽查附件上传/读取（大小、魔数、id 正则、原子发布）并复跑专项 5/5。7321 正式服务需重启才有新接口（待用户同意）。派单记录：T-W8a → Codex（HUD，默认 high），会话 01a20deb-5c55-74f3-b7d3-86c80da22472，消息 m-ed5cc9341b43。
完成｜DSH｜T-W4｜2026-11-24｜app/public/js/planner.js、app/public/js/projects.js、app/public/planner.css、app/public/projects.css、app/test/ui-projects.test.mjs、app/public/js/app.js（只改 bindProjects 那一行）｜项目卡标题区加拖动柄 data-drag-project，拖进左栏时间轴时跟着指针显示小卡片、进轴换成现有预览块 + 5 分钟吸附，松手走 onDrop 建块（复制，卡片不动，同一天可拖多次）；时长 dailyMinutes*60（无则 30 分钟），夹在 15 分钟与当天剩余之间；Esc 取消、拖到轴外松手不建块；planner 导出 nextFreeStart(seconds) 供项目卡「排进今天」（无空档提示今天排满了）；已完成/归档项目无拖动柄也无按钮｜ui-projects 17/17（新增 9 个 T-W4 用例）、ui-planner 11/11（T-W2 未退化）、全部浏览器 91/91、verify\run_all.cmd full PASS（服务 120/120、浏览器 91/91，连跑两次）｜旧断言：ui-projects.test.mjs 未删改任何原有断言（只把「无控制台错误」用例原样保留在末尾），另加两个窄屏/排满用例｜未推送
完成｜Codex｜T-W8a｜迁移 005、收获关联/星标/复习/图片、筛选与视图计数｜专项 13/13，full PASS（仓储/服务 120/120，浏览器 91/91）｜7321 正式服务待安排重启，未推送。
验收通过｜Claude｜T-W8a｜2026-11-24：Codex 提交 4037649，full PASS（服务 120、浏览器 91，Codex 跑）；Claude 抽查迁移 005 与复习间隔，复跑 harvest/review/v2 21/21。真实库 v4→v5 需重启 7321（会先自动备份），待用户同意。T-W8b 已解锁（排在 DSH 的 T-W4、T-W1b 之后）。派单记录：T-W6 → Codex xhigh（codex-worker 后台，-AllowDirty）。
派单记录｜2026-11-24｜T-W6 脚本后台运行约 3 分钟（只读代码、无改动）按用户要求停止，改用 HUD 重派：会话 01a20e15-450c-7293-a891-b72009928014，消息 m-d401ea7487e4（默认 high）。
完成｜Codex｜T-W6｜网页一键更新、重启接口、共享提醒与更新进度｜verify\run_all.cmd full PASS，仓储/服务 123/123，浏览器 92/92｜7321 正式服务待安排重启，未推送。
验收通过｜Claude｜T-W6｜2026-11-24：Codex 提交 9793ad5，full PASS（服务 123、浏览器 92，Codex 跑）；Claude 抽查 git 调用（execFile 参数数组、--ff-only、无 reset/clean/checkout、测试只用临时仓库）并复跑 update 18/18。真实 GitHub 发布与桌面安装未实测。失误记录：Claude 的 edab865 误含 DSH 已暂存的 T-W4 前半改动，不回退，已通知 DSH；规则补「提交限定路径」。另：修复浏览器测试泄漏临时目录（1c8ffe6），清理 %TEMP% 204 个残留目录约 3GB。
派单记录｜2026-11-24｜T-W5 → Codex（HUD，项目「个人智能工作台」，默认 high），会话 01a20e2f-9965-7413-a1af-2a0ce4a0a6fd，消息 m-af29327ef33c。DSH T-W4 误提交说明 m-2d6eac3bbf35。
提交记录｜2026-11-24｜DSH｜T-W4 拆在两个提交：edab865（[Claude] 派单会话…，Claude 并行提交时把我的暂存区一并带走，含 planner.js/projects.js/app.js/planner.css/projects.css/ui-projects.test.mjs/NEXT_TASKS.md/SESSION_LOG.md 全部 T-W4 改动）＋35bb217（[DSH] T-W4 长期项目拖进日计划，只含 ui-projects.test.mjs 的钟点无关修复：把页面 Date.now 钉在当天 08:00，半夜跑也有空档）。未推送。
完成｜Codex｜T-W5｜Obsidian 单向导出、附件相对链接、冲突保护、导出锁和设置小节｜专项后端 7/7、浏览器 1/1；隔离 full PASS，服务 130/130、浏览器 93/93（临时副本浏览器并发 2）｜T-W1b 接入 #obsidianSection；7321 待安排重启。
验收通过｜Claude｜T-W4｜2026-11-24：DSH 实现随 edab865、测试稳定性修复 35bb217、登记 88a937a；Claude 复跑 ui-projects/ui-planner/ui 65/65。下一单 T-W1b（DSH）待派——本会话重启后 Agent HUD 工具断开，需用户恢复 HUD。
派单记录｜2026-11-24｜T-W1b → DSH 新会话 deepseek:session-6a6bebf9-2a4a-44dd-8240-caa8665eb600，消息 m-685845f5fee6。T-W5（Codex）首轮只回一句计划即结束、无改动；续做消息 m-bd208c0417a6 排队，需用户在 Codex 应用打开该对话。
进行中｜DSH｜T-W1b｜app/public/js/storage-page.js、app/public/storage.css、app/public/index.html、app/public/js/app.js、app/public/js/views.js、app/public/js/ai-settings.js、app/test/ui-storage.test.mjs｜2026-11-24T16:52:00-08:00
完成｜DSH｜T-W8b｜2026-11-25｜app/public/js/harvest.js、app/public/harvest.css、app/public/js/projects.js、app/public/js/views.js、app/public/js/board.js、app/public/js/app.js（只加实时刷新入口与顶栏红点）、app/test/ui-harvest.test.mjs｜卡片重做：结论加粗+左侧强调线、要点默认收前 3 条可展开、标签按名哈希到 6 个令牌色变体、来源只显示域名可点、右上角星标、底部关联项目/任务标签与日期、图片缩略图（点开原图）；关联「关联…」弹窗可按项目/任务搜索并清除，项目卡显示「收获 N」点了跳到按该项目筛选的收获页；复习：顶部「今天待复习 N 张 · 开始复习」、「随便看一张」、翻卡（先标题→显示答案→记住了/没记住）、卡片「加入复习」开关、顶栏「收获」小红点；直接编辑：要点/待办点一下原地改（contenteditable，不换节点）、Enter 提交并在其后新增空行、清空即删除、↑↓ 排序、× 删除，全走 updateHarvest；筛选栏加「★ 星标」「待复习」「按项目」；看板与收获页接 live change 实时刷新（board.js 新增 refreshBoard，harvest.js 新增 refreshHarvest，编辑中/弹窗打开时跳过）｜ui-harvest 18/18（新增 9 个 T-W8b 用例，连跑 2 次）、verify\run_all.cmd full PASS（服务 130/130、浏览器 106/106）｜旧断言：原有 10 个用例全部保留，只把「空库步骤」的分页段加了一次筛选归位与显式等待（原断言含义未变）；另加 resetHarvest/openHarvestToday/clickReal 三个测试辅助｜未推送
验收通过｜Claude｜T-W5｜2026-11-24：Codex 提交 704d88e，隔离副本 full PASS（服务 130、浏览器 93）；Claude 抽查导出安全（符号链接/联接点与 nlink 拒绝、路径穿越、改过与清单外文件不动、锁）并复跑 obsidian 8/8。真实 Obsidian 客户端未验证。DSH 同时认领 T-W1b 与 T-W8b（文件基本不相交，接受）。
审查｜Codex（只读）｜T-W2/T-W4｜2026-11-24：3 个挡合并（上沿 ↑ 对 06:00 前旧块反向推迟；项目拖入 23:40 被倒推成 23:13；排进今天找空档与提交时长不一致致跨日）+ 紧凑档起拖阈值建议。退回 DSH T-W4 会话（第 1 次），只改 planner.js 与两份 UI 测试。
完成｜DSH｜T-W1b｜「数据」设置页：完整路径+来源徽标、用量、共享提示、备份列表与立即备份、更换位置（输入框/选择文件夹、复制或使用已有数据、确认框写明旧文件夹不删除·需重启·先自动备份）、立即重启、Obsidian 小节挂载 T-W5｜app/public/js/storage-page.js、app/public/storage.css、app/public/index.html、app/public/js/app.js、app/public/js/views.js、app/public/js/ai-settings.js、app/test/ui-storage.test.mjs｜ui-storage 5/5（含 390px 六套皮肤、relocate copy/use、409/400 人话、只读与 workbench:open）；verify\run_all.cmd full：服务 130/130、浏览器 105/106（唯一失败是 Codex 进行中的 T-W8b 直接编辑用例，与本单无关）｜未推送
验收通过｜Claude｜T-W1b｜2026-11-24：DSH 提交 6deef13（私有索引只提交本单路径）；只含已提交内容的临时工作树复跑 ui-storage/ui-obsidian/ui 43/43；工作区 T-W8b 改动完整保留。真 Electron 选文件夹未点测。工作区根目录有 T-W8b 执行者的 .dbg*.mjs 临时文件，提交前须删除。
验收通过｜Claude｜T-W2/T-W4 审查修复｜2026-11-24：DSH 提交 24dfc7d（planner.js + 2 份 UI 测试，5 条回归）；只含已提交内容的临时工作树 ui-planner/ui-projects/ui 70/70。Codex 审查 1 轮，3 个挡合并均已修。
