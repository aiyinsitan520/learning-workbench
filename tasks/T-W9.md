工单 T-W9：新手引导 + 帮助面板
tier：ui   risk：low   执行：DSH   依赖：本轮其余工单全部提交（引导要讲到它们）
先读：tasks/ROUND-2026-11-24.md、app/README.md、docs/收获速记.md

用户原话：「新手操作指引不够完善」

可改文件：app/public/js/tour.js（新）、app/public/tour.css（新）、app/public/index.html（帮助按钮与样式链接）、app/public/js/app.js（初始化）、views.js / planner.js / projects.js / harvest.js（只加 data-tour 属性与空状态提示文字）、app/test/ui-tour.test.mjs（新）
不许动：server.js、lib/*、tokens.css

要做：
1. 首次打开（localStorage 键 workbench.tour.v1 不存在）出现欢迎卡：「开始 1 分钟引导」/「以后再说」。
2. 引导 8 步左右，聚光圈高亮 + 气泡说明，「上一步/下一步/跳过」+ 进度点：顶栏页面切换 → 左栏日计划（点空白加块、拖动改期、拖上下沿改时间）→ 待办拖进计划 → 专注与灵动岛 → 任务正文（可粘贴图片）→ 右栏长期项目（拖进计划）→ 收获（Ctrl+Shift+V、复习）→ 右键菜单 → 数据位置与 Obsidian。锚点缺失（例如窄屏隐藏）时自动跳过该步。
3. 顶栏「?」按钮打开帮助面板：快捷键表、功能速查（每项一句话 + 「带我去」）、「重新开始引导」。
4. 空状态提示：空日计划、空项目区、空收获页各一句「试试……」。
5. Esc 退出引导；引导期间不触发实时刷新重载（复用对话框守卫）。

完成标准：首次进入出现引导、完成后不再出现、帮助面板可重开；390px 与六套皮肤通过；verify\run_all.cmd full 通过。
