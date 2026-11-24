工单 T-W3：任务正文里插入图片（粘贴、拖入、按钮），可预览
tier：hard   risk：high（文件写入/读取接口）   执行：Codex high   依赖：T-W1 已提交（附件放在数据文件夹）
先读：tasks/ROUND-2026-11-24.md、tasks/T-W1.md、app/public/js/task-notes.js

用户原话：「正文记录无法输入图片，我想在正文里添加图片」

现状：task-notes.js 是纯 textarea（maxlength 32000），自动保存 + revision 冲突处理；task_notes 表只有 body 文本。

可改文件：app/lib/attachments.js（新）、app/server.js（两条路由）、app/public/js/task-notes.js、app/public/app.css（正文图片条与预览，只用令牌）、architecture/workbench.d.ts（Attachment 一节）、app/test/attachments.test.js（新）、app/test/ui-note-images.test.mjs（新）、app/README.md、docs/DATA_FOR_AI.md
不许动：schema/迁移（本单不建表）、tokens.css、planner.js、projects.js

接口约定：
- 存储：`<dataDir>/attachments/<sha256前2位>/<sha256>.<ext>`，按内容去重；ext ∈ png|jpg|webp|gif。
- `POST /api/attachments`：请求体为原始字节，Content-Type ∈ image/png|image/jpeg|image/webp|image/gif，≤10 MiB；按文件头魔数核对类型，不符 415；返回 `{ id:'<sha256>.<ext>', url:'/api/attachments/<id>', bytes, type }`。受 T-W1 同源守卫保护。
- `GET /api/attachments/:id`：id 必须匹配 `^[0-9a-f]{64}\.(png|jpg|webp|gif)$`，否则 400；响应头 Content-Type、`X-Content-Type-Options: nosniff`、`Cache-Control: private, max-age=31536000, immutable`、`Content-Security-Policy: sandbox`。不支持 SVG。
- 正文语法：Markdown `![图片说明](/api/attachments/<id>)` 插在光标处；上传中先插 `![上传中…]()` 占位，成功替换，失败移除并提示。
- 编辑器：粘贴剪贴板图片、把图片文件拖到正文、工具栏「插入图片」按钮（文件选择）三种入口；正文下方显示图片缩略图条，点开大图；加「预览」切换，把正文按简单 Markdown 渲染（标题/列表/粗体/链接/图片，全部转义，只允许 /api/attachments/ 图片地址）。
- 不做孤儿文件清理（写进 README「已知限制」）。服务器数据库模式下附件随服务端数据文件夹走。
- 32000 字上限不变；图片只占一行链接文本。

完成标准：在正文里 Ctrl+V 一张截图，几秒内看到图片缩略图，刷新后还在；拖入、按钮也可用；类型伪装/超限/非法 id/外域 Origin 都被拒；`verify\run_all.cmd full` 通过。
