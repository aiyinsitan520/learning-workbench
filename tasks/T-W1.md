工单 T-W1：数据文件夹看得见、可选、可管理，网页端和桌面端共用同一文件夹并实时同步
tier：hard   risk：high   执行：Codex xhigh   依赖：无
先读：tasks/ROUND-2026-11-24.md（共同规则）、AGENTS.md、app/README.md「结构」、architecture/workbench.d.ts

用户原话：「数据存放在哪个文件夹不够明确，用户不方便选择和管理数据，DIY控制能力不强」「网页端和桌面应用端实时更新」（用户确认 = 数据实时同步：两端用同一数据文件夹，一端改了另一端几秒内自动刷新）

现状（已核实）：网页端 server.js 用 `WORKBENCH_DB ?? app/data/workbench.db`；桌面版本机库用 `app.getPath('userData')/workbench.db`；桌面还可切到经 SSH 隧道的服务器库（desktop/main.mjs sourceLabels）。两端数据互不相通。db.js 已开 WAL + busy_timeout 5000，迁移在 BEGIN IMMEDIATE 内。server.js 的 POST 目前没有 Origin 检查。

可改文件：
- app/lib/storage.js（新）、app/lib/live.js（新，服务端变更广播）
- app/server.js（启动时解析数据位置、新路由、POST 同源守卫）
- app/lib/db.js（只加：读 PRAGMA data_version 的函数、命令提交后的回调钩子；不改已有命令签名）
- desktop/main.mjs（本机库路径改为按数据位置解析；「数据」菜单）
- app/public/js/live.js（新，前端订阅）、app/public/js/app.js（只加订阅与刷新接线，尽量 ≤40 行）
- architecture/workbench.d.ts（加 StorageInfo、LiveEvent 一节）
- app/test/storage.test.js（新）、app/test/live.test.js（新）、app/README.md、docs/DATA_FOR_AI.md
不许动：tokens.css、skins.css、schema.sql 与已有迁移、已有命令名/返回结构、planner.js、projects.js（DSH 并行在改）

接口约定（Claude 定，不改）：
1. 位置配置文件 `<configRoot>/location.json`：Windows `%APPDATA%\learning-workbench\`，macOS `~/Library/Application Support/learning-workbench/`，其他 `~/.config/learning-workbench/`。内容 `{"version":1,"dataDir":"<绝对路径>"}`，原子写（tmp+rename）。
2. 解析顺序：环境变量 `WORKBENCH_DB`（source='env'，测试/开发用，最高）＞ location.json（source='config'）＞ 默认（source='default'：网页端 `app/data`，桌面端 userData）。桌面选「服务器数据库」时不受影响，存储接口返回 `remote:true` 且只读。
3. 数据文件夹布局：`workbench.db`、`attachments/`（T-W3 用）、`backups/`、首次使用时写一份 `关于这个文件夹.txt`（说明各子目录、不要在程序运行时手动改 db）。
4. `GET /api/storage` → `StorageInfo { dataDir, dbPath, source:'env'|'config'|'default', configPath, edition:'source'|'desktop', remote:boolean, dbBytes, attachmentsBytes, attachmentCount, backups:{name,bytes,createdAt}[], defaults:{ web:string, desktop:string|null }, shared:boolean }`。shared = 网页端与桌面端会解析到同一文件夹（两者都读同一 location.json 即为 true）。
5. `POST /api/storage/backup` → `{ name }`：用 `VACUUM INTO` 写 `backups/workbench-YYYYMMDDTHHmmss.db`；只保留最新 20 份，且只删除匹配这个文件名模式的文件。
6. `POST /api/storage/reveal {target:'data'|'backups'|'attachments'}` → 在资源管理器/Finder 打开对应目录（只允许这三个，不接受任意路径；用 spawn 参数数组，不拼 shell 字符串）。
7. `POST /api/storage/pick-folder` → 桌面版弹原生选文件夹对话框返回 `{dataDir}|{cancelled:true}`；网页端返回 501 `{code:'not-supported'}`（页面据此隐藏按钮，改用输入框）。桌面版用注入的 picker 实现，server.js 不直接 import electron。
8. `POST /api/storage/relocate {dataDir, mode:'copy'|'use'}`：
   - 校验：绝对路径；不在程序安装目录/仓库 app/ 之内；可创建且可写；不是当前文件夹；source='env' 时 409。
   - copy：目标不得已有 workbench.db；`VACUUM INTO` 复制库 + 复制 attachments；校验新库能打开且 user_version 相同。
   - use：目标必须已有 workbench.db，只读打开检查 user_version ≤ 当前程序支持版本。
   - 成功后才写 location.json，返回 `{ restartRequired:true, dataDir }`。**永不删除旧文件夹**。桌面版注入 restart（app.relaunch + exit）后由页面调用 `POST /api/restart`；网页端本单返回 `{restartRequired:true, how:'script'}`（T-W6 再做网页自重启）。
9. 实时同步 `GET /api/events`（text/event-stream）：连接即发 `event: hello` `data:{"rev":N}`；数据变化发 `event: change` `data:{"rev":N,"origin":"self"|"external"}`；每 25 秒发注释心跳。有订阅者时每 1000ms 读一次 `PRAGMA data_version` 发现其他进程的写入（external）；本进程命令提交后立即发（self）。rev 是进程内单调计数。`GET /api/health` 加性字段 `dataRev`。
10. 前端 `public/js/live.js` 导出 `startLive({ onChange })`：EventSource 自动重连；SSE 连续失败 3 次退回每 5 秒轮询 `/api/health.dataRev`。app.js 收到 change（300ms 防抖）后重新读当前视图；**有对话框打开、正在拖动、正文有未保存草稿时延后**，复用现有「build 变化自动重载」的那套守卫。打开中的任务正文：本地无草稿 → 重新读取；有草稿 → 走现有冲突流程，不覆盖。
11. 桌面菜单「数据」：打开数据文件夹、立即备份、数据位置…（向页面派发 `window.dispatchEvent(new CustomEvent('workbench:open',{detail:'storage'}))`，T-W1b 负责响应）。
12. 同源守卫：所有 POST/PUT/DELETE 若带 Origin 头，必须等于本服务自身 origin（127.0.0.1/localhost + 当前端口），否则 403；Host 头必须是 127.0.0.1/localhost:端口（防 DNS 重绑定）。新加的 JSON 接口要求 `Content-Type: application/json`。不带 Origin 的本机脚本调用照常可用（已有测试不应因此失败）。

影响面：桌面「本机数据库」路径解析改变——无 location.json 时行为必须与现在完全一致（仍是 userData），不能让用户打开后看到空库。旧测试若断言默认路径，保持通过。

完成标准：
- 两个进程（临时端口，WORKBENCH_DB 不设、用临时 configRoot 指向同一临时文件夹）同开，A 端命令写入后 B 端 SSE 2 秒内收到 external change；测试覆盖。
- relocate copy/use 成功与各类拒绝（env、已存在库、不可写、相对路径、程序目录内）都有测试；旧文件夹仍在。
- 备份数量上限、reveal 白名单、外域 Origin 403 有测试。
- `node --test app/test/storage.test.js app/test/live.test.js` 全过；`verify\run_all.cmd full` 通过；桌面 smoke（desktop 已有 smoke 入口）通过。
- 回执写明：live.js 的守卫复用了哪个函数；给 T-W1b 的页面挂载点约定（如果你加了 helper）。
