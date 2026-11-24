工单 T-W5：工作台数据单向导出到 Obsidian 仓库
tier：hard   risk：high（写用户的笔记仓库）   执行：Codex xhigh   依赖：T-W1、T-W3、T-W1b 已提交
先读：tasks/ROUND-2026-11-24.md、tasks/T-W1.md、tasks/T-W3.md、docs/DATA_FOR_AI.md、app/lib/context-md.js

用户原话：「我想数据和Obsidian仓库联动」（用户确认：单向导出到仓库，只写工作台自己生成的文件，不改原有笔记）

可改文件：app/lib/obsidian.js（新）、app/server.js（路由）、app/public/js/obsidian-section.js（新，挂到 T-W1b 的 #obsidianSection）、app/public/storage.css（只加本节样式）、architecture/workbench.d.ts、app/test/obsidian.test.js（新）、app/test/ui-obsidian.test.mjs（新）、docs/DATA_FOR_AI.md、app/README.md
不许动：tokens.css、db.js 命令签名

接口约定：
- 配置 `<dataDir>/obsidian.json`：`{ vaultPath, folder:'学习工作台', enabled, auto, include:{ days, notes, harvests, projects } }`。
- 输出（全部在 `<vault>/<folder>/` 内）：`日计划/YYYY-MM-DD.md`（时间块、专注时间线、手记、当天回顾）、`任务正文/<标题>-<id前6位>.md`、`收获/YYYY-MM-DD-<标题>.md`、`长期项目/<项目名>.md`（含每日进展）、`附件/<sha>.<ext>`（正文里 /api/attachments/ 链接改写成相对 Markdown 链接）。每篇带 YAML frontmatter（workbench_id、type、day、updated、tags），用 [[双链]] 连接 日↔任务↔项目↔收获。
- 安全：vaultPath 必须是含 `.obsidian` 目录的文件夹；逐级 lstat 拒绝符号链接/联接点；文件名清洗（Windows 保留字符与保留名、≤80 字）；原子写（tmp+rename）。清单 `<folder>/.workbench-export.json` 记录 id→相对路径→上次写入的哈希。覆盖前若文件当前哈希 ≠ 清单哈希（用户在 Obsidian 里改过）→ **不覆盖**，记入 conflicts。只删除清单里且哈希未变的旧文件（例如改名后）；清单外的任何文件永不删除、永不修改。
- 并发：`<folder>/.workbench-export.lock`（pid+时间，2 分钟过期），网页端和桌面端共用文件夹时只有一方在写。
- 触发：手动「立即导出」；`auto=true` 时收到 T-W1 的数据变更后防抖 60 秒增量导出（只写哈希变了的）。
- API：`GET /api/obsidian` → `{ config, status:{ lastExportAt, written, unchanged, conflicts:string[], error } }`；`POST /api/obsidian/config`；`POST /api/obsidian/export`；`GET /api/obsidian/detect` → 候选仓库（读 Obsidian 自己的 `%APPDATA%\obsidian\obsidian.json` / macOS 对应路径里的仓库列表，只取路径）。
- 页面小节：选仓库（候选下拉 + 手填路径）、子文件夹名、勾选导出内容、自动开关、立即导出、上次结果与冲突列表、「在 Obsidian 中打开」（obsidian://open?path=…）。
- 测试只用临时目录造的假仓库，**禁止**碰用户真实仓库。
完成标准：假仓库里生成上述结构并能被 Obsidian 识别双链；用户改过的文件不被覆盖并列为冲突；清单外文件不动；符号链接/路径穿越被拒；`verify\run_all.cmd full` 通过。
