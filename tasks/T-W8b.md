工单 T-W8b：收获卡片界面重做——好看、能关联、能复习、能直接改
tier：ui   risk：low   执行：DSH   依赖：T-W8a 已提交
先读：tasks/ROUND-2026-11-24.md、tasks/T-W8a.md（接口约定）、app/public/js/harvest.js、harvest.css、docs/收获速记.md

用户原话：「收获卡片不够完善」（四项：样式简陋、不能关联项目/任务、缺少复习、编辑不便）

可改文件：app/public/js/harvest.js、app/public/harvest.css、app/public/js/projects.js 与 projects.css（只加项目卡上的「收获 N」入口）、app/test/ui-harvest.test.mjs（新增用例；改旧断言要说明理由）
不许动：harvest-format.js（解析格式不变）、server.js、db.js、tokens.css

要做：
1. 卡片层次：标题 + 一句话结论（强调）+ 要点（默认收起前 3 条，可展开）+ 待办；标签做成彩色小标签（颜色由标签名哈希到现有令牌色里选，不写颜色值）；来源显示域名可点；右上角星标；底部显示关联的项目/任务小标签与日期。
2. 关联：卡片上「关联…」选择项目或任务（下拉搜索），可清除；项目卡显示「收获 N」，点了跳到按项目筛选的收获页。
3. 复习：收获页顶部「今天待复习 N 张 · 开始复习」「随便看一张」；复习模式为翻卡：先看标题 → 点「显示答案」看结论与要点 → 「记住了」/「没记住」；卡片上「加入复习」开关。顶栏「收获」按钮在 harvestDue>0 时显示小红点。
4. 直接编辑：点要点/待办文字原地编辑，Enter 新增一条、空行删除、上下移动按钮（或拖动柄）排序；保存走 updateHarvest；可在卡片上添加图片（复用 /api/attachments，最多 6 张，缩略图点开大图）。
5. 筛选栏加「星标」「待复习」「按项目」。
6. （T-W1 遗留，并入本单）每日维护看板与收获页接上实时刷新：收到 T-W1 的 live change 后刷新当前列表/看板（有编辑中的卡片或对话框时延后，复用 app.js 的 refreshBlocked()）。为此本单可改 app/public/js/board.js 的刷新入口。
完成标准：上述每项有 UI 用例；390px 与六套皮肤通过；`verify\run_all.cmd full` 通过。
