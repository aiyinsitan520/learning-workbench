工单 T-W7：右键菜单——把常用操作放到鼠标右键
tier：ui   risk：low   执行：DSH   依赖：T-W1、T-W4、T-W8b 已提交
先读：tasks/ROUND-2026-11-24.md、app/public/js/app.js 事件代理部分

用户原话：「鼠标右键发挥不了优势，应该开发一点鼠标右键功能」

可改文件：app/public/js/context-menu.js（新）、app/public/menu.css（新）、app/public/index.html（样式链接）、app/public/js/app.js（注册与动作接线）、app/public/js/planner.js、projects.js、harvest.js（各自导出注册函数或在内部注册）、app/test/ui-context-menu.test.mjs（新）
不许动：server.js、db.js、tokens.css（只用已有命令完成动作；缺命令写「需要架构决定」）

接口约定：
- `context-menu.js` 导出 `registerContextMenu(selector, build)`，`build(target, event)` 返回 `[{ label, icon?, shortcut?, danger?, disabled?, children?, run }] | null`；菜单在指针处出现、贴边自动翻转、↑↓/Enter/Esc/→（子菜单）可用；点外面、滚动、窗口失焦关闭；触屏长按 500ms 触发；聚焦元素上 Shift+F10 / ContextMenu 键也能打开。
- 只在注册过的元素上拦截；输入框、textarea、正文编辑区保留浏览器原生菜单（复制粘贴、拼写检查）。
菜单内容：
- 时间块：打开正文、开始专注、完成/取消完成、改时长（15/30/45/60/90 分钟）、复制（Ctrl+C）、复制到明天同一时间、移到下一个空档、删除时间块（danger）。
- 时间轴空白处：在此添加时间块（按点击位置的 15 分钟格）、粘贴时间块（Ctrl+V，有复制内容时）。
- 左栏待办：排进下一个空档、打开正文、完成、编辑。
- 长期项目卡：排进今天、开始专注、写今天进展、完成/归档。
- 收获卡：复制为 Markdown、星标、加入/移出复习、关联项目…、编辑、删除（danger）。
- 删除类动作沿用现有确认方式。
完成标准：每类目标至少一条 UI 用例（含键盘打开、Esc 关闭、textarea 保留原生菜单）；390px 菜单不出界；六套皮肤通过；`verify\run_all.cmd full` 通过。
