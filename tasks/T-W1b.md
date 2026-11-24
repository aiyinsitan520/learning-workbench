工单 T-W1b：「数据」设置页——位置清楚、可换、可备份，提示网页端与桌面端是否共用
tier：ui   risk：high（误操作会让用户以为数据丢了）   执行：DSH   依赖：T-W1 已提交
先读：tasks/ROUND-2026-11-24.md、tasks/T-W1.md（接口约定 4–8、11）、AGENTS.md

用户原话：「数据存放在哪个文件夹不够明确，用户不方便选择和管理数据，DIY控制能力不强」

可改文件：app/public/js/storage-page.js（新）、app/public/storage.css（新）、app/public/index.html（只加样式链接/入口）、app/public/js/app.js 与 views.js（只加页面注册、`workbench:open` 事件响应、齿轮页入口）、app/public/js/ai-settings.js（只加切到「数据」的入口）、app/test/ui-storage.test.mjs（新）
不许动：server.js、lib/*、tokens.css

页面（页面 key 'storage'，从齿轮页「数据」和桌面菜单「数据位置…」进入）：
1. 顶部大字显示当前数据文件夹完整路径 + 「复制路径」「打开文件夹」；来源徽标：默认位置 / 自定义 / 开发环境变量（env 时更换按钮禁用并说明）；桌面连服务器库时整页只读并说明「当前用的是服务器数据库」。
2. 用量：数据库大小、图片附件数量与大小。
3. 共享提示：`shared=false` 时显示提示条「网页版和桌面版现在各用各的文件夹（列出两处默认路径），数据不会互通。把两边设为同一个文件夹即可实时同步。」
4. 备份：列表（时间、大小）、「立即备份」、「打开备份文件夹」。
5. 更换位置：桌面版「选择文件夹…」（pick-folder），网页端是路径输入框；单选「把当前数据复制过去（推荐）」/「使用那里已有的数据」；确认对话框写明：旧文件夹不会删除、需要重启、重启前先自动备份一次（先调 backup 再 relocate）。成功后显示「立即重启」（有 /api/restart 时）或「请关闭并重新运行启动脚本」。
6. `<section id="obsidianSection"></section>`：若 T-W5 已提交，import `./obsidian-section.js` 并调用 `mountObsidianSection(那个 section)`，index.html 加 `obsidian.css` 链接；若未提交，只放标题「Obsidian 联动（即将推出）」。
7. 所有错误码（409/400/403）显示人话，不显示原始堆栈。

完成标准：临时库服务下能看到路径/用量/备份，能备份，能用输入框改到临时文件夹（copy 与 use 两种）并看到需重启提示；390px 与六套皮肤通过；`verify\run_all.cmd full` 通过。
