## 2026-11-21 09:45 · DSH

修跨午夜不翻页：`app/public/js/app.js` 加 `checkDayRollover()`，tick 每 5 秒按 Asia/Shanghai 检查是否跨日，
停在"上次的今天"时自动翻页；`userPinnedDate` 与未保存手记时不抢视图。
验收：`verify\run_all.cmd` PASS；`verify\run_all.cmd full` PASS（UI 36/36）。提交 4a65bfe。
遗留：无。

2026-11-22｜Codex｜新增 desktop/、桌面发布 workflow、README 与五张演示图库。三平台构建与启动检查通过，full 68+58 全过。Mac 未公证，Windows 未商业签名；后续版本在 desktop/build.py 更新版本号，再从已验收提交打标签。

2026-11-23｜Claude｜桌面版自动更新（参考贾维喵管家的签名更新流程）：/api/update、左下角版本号与「软件更新」对话框、Ed25519 签名清单、Windows 换文件夹重启、Mac 打开 DMG；顺带修了带参数启动桌面版崩溃。full PASS（17、83、61），本机 1.1.0→1.1.1 真实升级演练通过。待用户：生成签名密钥并设 secret、打 v1.1.0 标签。下一位从 NEXT_TASKS.md 末条「待用户」继续。
2026-11-23｜Claude｜生成更新签名密钥（公钥入源码，私钥在本机用户目录，secret UPDATE_SIGNING_KEY 已设）。签名自检与快速验收通过。下一步：推送并打 v1.1.0 标签。

2026-11-23｜Claude｜推送 main 至 1d27510，发布 v1.1.0（Actions 45141447534：三平台打包与 release 全部 success）。公开 latest.json 验签通过，三平台包大小与 SHA-256 和 GitHub digest 一致；7321 源码版实际检查结果为 latest。NEXT_TASKS.md 正由 T-H1 会话修改，本条未写入，待其提交后补记。

2026-11-23｜Claude（/team）｜收获速记三单完成：T-H1 数据层与提炼接口（Claude，4d02751、bbc2bb0）、T-H2 收获页（Codex，7f85c05）、T-H3 回顾与快照（Codex，9a5fb77）。full PASS（17×2、11、17、97/97、UI 71/71）。7321 已重启，真实库迁到 v4 并自动备份。DSH 未登记本工作区，改派 Codex。遗留：T-H4 书签按钮待用户用一周后决定；用户其余问题未给出。下一位从 NEXT_TASKS.md「问题 1：对话收获速记」段继续。

2026-11-23｜Codex｜桌面「数据源」菜单支持本机库和 SSH 隧道到 VPS 的共享库，记住选择并可离线打开本机库。Mac 已更新原应用并备份本地库，实测本机库 0 条、共享库 81 条。Windows/macOS 桌面 smoke 与 full（97/71）通过。

2026-11-23｜Claude（/team，自做未派单）｜灵动岛番茄钟跟随当前日计划（新增 app/public/js/plan-now.js 共用口径，/api/view 加 plan，桌面岛/顶栏岛/专注页/小窗统一），每日总结补全（专注时间线、块结束时刻、新建任务、待办、六节回顾含【时间线】，看板明细加当天记录与收获）。改动见 NEXT_TASKS.md 同日「完成｜Claude」条。验证：verify\run_all.cmd full PASS（服务 102/102、UI 71/71），plan-now.test.js 5/5，临时库实机点开桌面灵动岛核对任务与时长。用量：外部代理 0，主模型用量未知。遗留：旧回顾会显示「记录有更新」，需用户点「重新生成」；新版回顾的真实模型效果未验证。下一位从 app/public/js/plan-now.js 与 app/test/plan-now.test.js 继续。
2026-11-23｜Codex｜desktop/main.mjs 新增整页缩放和原生菜单，desktop/build.py 保留 Windows 自动更新所需的磁盘版本文件，README 与 DATA_FOR_AI 补充用法，版本升至 1.2.1。full PASS（102/102、71/71）；Windows 桌面 smoke PASS。后续检查 v1.2.1 的 Desktop packages 工作流与已发布更新清单。
2026-11-24｜Claude（/team 规划）｜九个体验问题拆成 11 单（tasks/ROUND-2026-11-24.md、tasks/T-W*.md，提交 13091ab）；用户确认：实时更新=数据同步、Obsidian 单向导出、收获四项全做、时间块上下沿可拖。已派 T-W1（Codex xhigh）与 T-W2（DSH，消息 m-c3edd28d73ce）。未验收、未改业务代码。Claude 主模型用量未知。
2026-11-24｜Claude（/team 验收）｜T-W1 退回 Codex 1 次（SSE 让 server.close 挂起）后验收通过并提交 c4f0be3：只含本单改动的临时工作树 full PASS（113/113、71/71），桌面冒烟需打包未跑。T-W1 遗留的看板/收获页实时刷新并入 T-W8b。已用 HUD 派 T-W3 给 Codex（m-41de584f4406）；T-W2（DSH）进行中。
2026-11-24｜DSH｜T-W2 时间块上下沿拖动与时间轴密度：planner.js 新增上沿手柄 data-resize-plan-start（改开始时间、结束不变，最早 06:00，时长不少于 15 分钟或原时长）、两端手柄 10px（<28px 缩 6px、<12px 各占上下 40%）、拖动标签「09:10–10:00 · 50 分钟」、键盘 ↑↓ 与 Shift 15 分钟、密度 32/48/64 默认 48（localStorage workbench.plannerScale，标题区三档按钮 + Ctrl+滚轮）；planner.css 加抓手线与密度按钮样式（只用令牌）；ui.test.mjs 仅做像素换算（96→144px、drag(32)→drag(hourHeight)、末尾块先滚到底避开自动滚动区），新增 ui-planner.test.mjs 11 个用例。验证：ui-planner 11/11、ui.test.mjs 37/37、其余 7 个浏览器文件 34/34（逐文件跑）、快速验收 PASS 113/113；full 被 T-W1 的 SSE server.close 已知问题卡住，与本单无关。未推送。
2026-11-24｜完成｜Codex｜T-W3｜任务正文粘贴、拖入、选择图片，缩略图与 Markdown 预览；附件按 SHA-256 去重，单张上限 10 MiB｜专项 5/5；full PASS，服务 117/117、浏览器 83/83｜7321 正式服务待重启，孤儿附件保留。 未调用外部代理，用量 0。主模型会话截至验收时最近记录，输入 2267167、输出 12038、合计 2279205。
2026-11-24｜完成｜Codex｜T-W8a｜迁移 005、收获关联/星标/复习/图片、筛选与视图计数｜专项 13/13，full PASS（仓储/服务 120/120，浏览器 91/91）｜7321 正式服务待安排重启，未推送。 未调用外部代理，外部代理用量 0。
2026-11-24｜完成｜DSH｜T-W4｜右栏长期项目拖进左栏日计划（复制）：项目卡标题区加拖动柄 data-drag-project，planner.js 在 document 级接住跨栏拖动，进时间轴复用现有预览块与 5 分钟吸附，松手走 onDrop 建块；时长 dailyMinutes*60（无则 30 分钟）夹在 15 分钟与当天剩余之间；Esc 取消、轴外松手不建块、同一天可拖多次，项目卡不动。新增 planner.nextFreeStart(seconds)，项目卡「排进今天」用它找第一个空档，无空档提示「今天排满了」；已完成/归档项目无拖动柄与按钮。样式只用令牌（projects.css 拖动柄、planner.css 跟随指针小卡片）。验证：ui-projects 17/17（新增 9 个 T-W4 用例）、ui-planner 11/11（T-W2 未退化）、全部浏览器文件 91/91、verify\run_all.cmd full PASS（服务 120/120、浏览器 91/91，连跑两次）。旧断言未删改。未推送。未调用外部代理，用量 0。
2026-11-24｜完成｜Codex｜T-W6｜签名清单、Git 前置检查、SQLite 备份后仅快进、源码和桌面重启、SSE 提示点、共享稍后/跳过、网页更新遮罩和版本变更后刷新｜verify\run_all.cmd full PASS，仓储/服务 123/123，浏览器 92/92。临时 Git 仓库、假发布及临时端口验证，正式 7321 待安排重启，未推送。外部代理用量 0，主模型用量未知。
2026-11-24｜补充｜DSH｜T-W4 提交拆分说明：全部实现改动被 Claude 的并行提交 edab865 一并带走（Claude 同时 git add，暂存区被一起提交）；按 AGENTS §4 不改写已有提交，故本单另提交 35bb217 只含 ui-projects.test.mjs 的钟点无关修复（把页面 Date.now 钉在当天 08:00，避免半夜跑时「排进今天」无空档而误报）。复核：full PASS，服务 123/123、浏览器 92/92；ui-projects 连跑 3 次均 17/17。未推送。
验收复核｜2026-11-24｜DSH｜T-W4：在 HEAD（含 Codex T-W6 9793ad5、Claude browser.mjs 修复 1c8ffe6）上重跑 verify\run_all.cmd full，PASS（服务 123/123、浏览器 92/92）。首跑 ui-harvest「空库步骤、复制口令和分页」偶发超时（等待 [data-harvest-card] 数量，属 T-H2 收获页，与本单无关），单独重跑 10/10、full 复跑全过，判为偶发。本单提交：edab865（Claude 并行提交误带走本单全部实现改动，未回退）＋35bb217＋88a937a。未推送。
2026-11-24｜完成｜Codex｜T-W5｜新增 obsidian.js、obsidian-section.js、obsidian.css 与后端/浏览器测试，接上 server.js、workbench.d.ts，更新 app/README.md、docs/DATA_FOR_AI.md、NEXT_TASKS.md。专项 7/7 + 1/1；隔离 full PASS（服务 130/130、浏览器 93/93，仅临时副本浏览器并发 2）。默认并发见收获分页、每日看板间歇超时；共享工作区 T-W1b 数据页两条超时。下一步 T-W1b 挂载 mountObsidianSection，正式 7321 服务待安排重启。假 vault、假 APPDATA、临时数据库验收。外部代理用量 0，主模型用量未知。
2026-11-24｜完成｜DSH｜T-W1b｜「数据」设置页（页面 key 'storage'）：顶部大字完整路径 + 复制路径/打开文件夹 + 来源徽标（默认位置/自定义/开发环境变量，env 时更换禁用并说明）；用量卡（数据库大小、图片附件数量与大小、备份份数）；shared=false 时提示条列出网页版与桌面版两处默认路径并说明不互通、设为同一文件夹即可实时同步；备份列表（时间/文件名/大小）+ 立即备份 + 打开备份文件夹；更换位置（桌面版「选择文件夹…」、网页端输入框；单选复制过去/使用已有数据；确认框逐条写明旧文件夹不会删除、需要重启、重启前先自动备份，实际先调 backup 再调 relocate，409 时复用刚生成的那份）；成功后显示「立即重启」（走 POST /api/restart，无此接口时提示重新运行启动脚本）并强调旧文件夹一个文件都没删；桌面连服务器库时整页只读；错误 409/400/403/501/415 一律翻译成人话，不显示堆栈；Obsidian 小节按 T-W5 已提交的接口挂载 mountObsidianSection。入口：齿轮页「数据与备份」按钮 + window 的 workbench:open 事件（桌面菜单「数据位置…」）。样式只用 tokens.css 令牌，390px 与六套皮肤不横向溢出。验证：ui-storage 5/5（连跑 3 次稳定）；verify\run_all.cmd 快速 130/130 PASS；full 服务 130/130、浏览器 105/106，唯一失败是 Codex 进行中的 T-W8b 「直接编辑」用例，与本单无关。旧断言未删改（新增 ui-storage.test.mjs 一个文件）。未推送。
