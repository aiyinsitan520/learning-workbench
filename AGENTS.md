# 学习工作台协作规则

本项目由三个 Agent 协作：**Claude Code** 负责顶层设计与架构，**Codex** 和 **DSH** 负责具体实现、修 bug 与机械整理。用户决定做什么、验收结果。三方读同一份规则（本文件），按同一套命令验收，在同一处登记进度。

## 1. 分工

| 角色 | 负责 | 不做 |
| --- | --- | --- |
| 用户 | 提需求、选方案、最终验收 | — |
| Claude Code（架构） | 模块划分与目录结构；数据契约（`architecture/schema.sql`、`task_notes.sql`、`workbench.d.ts`、`/api/*` 接口形状）；设计系统（`app/public/tokens.css`、素材库选型）；大改版与重构；把需求拆成工单；审查实现是否守住边界 | 不和实现方抢同一批文件 |
| Codex / DSH（实现） | 按工单修 bug、加小功能、调样式细节、补测试；在工单列出的文件内工作 | 不改「架构文件」（见第 2 节）；不为了让测试通过而改断言的含义 |

简单 bug 可以由用户直接交给 Codex 或 DSH，不必经过 Claude Code。

## 2. 架构文件（改动需先找 Claude Code 或用户确认）

- 数据：`architecture/*.sql`、`architecture/workbench.d.ts`、`app/lib/db.js` 的命令与视图签名、`app/server.js` 的路由与返回结构。
- 外壳与模块边界：`app/public/index.html` 的三栏骨架、`app/public/js/app.js` 的状态结构与事件分派、模块之间的导入关系（新增或拆分模块）。
- 设计系统：`app/public/tokens.css`（颜色、字体、圆角、阴影、动效）和 `app/public/skins.css`（六套皮肤，只覆盖基础色、字体、圆角）。组件样式在 `app.css`、`planner.css`、`board.css`、`projects.css`、`ai.css` 里可直接改，但只引用令牌，不写颜色值（`#xxxxxx`、`rgb()`）——UI 测试「皮肤」用例会拦下来。需要新颜色时先在 `tokens.css` 加令牌，并确认六套皮肤下都好看（深色的「摩卡夜」最容易出问题）。
- 验收脚本：`verify/`、`architecture/check_*.py`。测试用例可以新增；删改已有断言要在回执里写明理由。
- 启动与时区：`启动学习工作台.ps1`、`停止学习工作台.ps1`；工作台固定按北京时间（Asia/Shanghai）分日，不随本机时区变化。

实现中发现必须动这些文件，先停下来，在回执里写「需要架构决定：……」，由 Claude Code 或用户处理。

## 3. 工单格式

任何一方派单或接单都用这个格式，写进根目录 `NEXT_TASKS.md` 的对应日期段落，或直接贴给执行方：

```text
工单：<一句话目标>
可改文件：<路径列表，不在列表里的不改>
不许动：<可选，例如 tokens.css、schema>
完成标准：<用户能看到的结果>＋ verify\run_all.cmd 通过（涉及界面加 full）
```

## 4. Git 与文件认领

本目录是本地 Git 仓库（分支 `main`，无远端，2026-11-21 建立）。三个 Agent 在同一个工作目录里改，所以：

- **开工前**：`git status` 必须是干净的。不干净说明别人还在改或忘了提交，先问清楚，不要替别人提交或丢弃。
- **认领**：在根目录 `NEXT_TASKS.md` 末尾写一行 `进行中｜<Agent>｜<文件列表>｜<开始时间>`，完成后改成结果。同一文件同一时间只有一个人改。
- **提交**：一张工单一个提交，验收通过后再提交，只 `git add` 自己改的文件。提交信息第一行写 `[Claude]`、`[Codex]` 或 `[DSH]` 加一句话说明，正文写验收结果。
- **回退**：用 `git revert <提交>` 撤销某次改动。**禁止** `git reset --hard`、`git clean`、`git checkout -- .`、`git push --force`、改写已有提交；也不新增远端、不推送，除非用户明确要求。
- **不入库**：`app/data/`（用户真实数据与日志）、`app/shots/`（测试截图）、`设计备份/`、`verify/.backup/`，见 `.gitignore`。不要用 `git add -f` 把它们加进来。

## 5. 统一验收

```powershell
verify\run_all.cmd          # 快速：架构、契约、行为、仓储/服务，约 10 秒
verify\run_all.cmd full     # 完整：再加真浏览器 UI 测试，约 1–2 分钟
```

- 交付前必须跑，回执里贴真实结果（通过数 / 失败数）。没跑或失败就写明，不写「应该没问题」。
- 所有测试只用临时库或内存库。**禁止**对 `app/data/workbench.db`（用户真实数据）运行 seed、导入或测试写入；需要改用户数据时，先得到用户同意，并只走 `/api/command`。
- UI 测试会在当前目录写 `app/shots/`，`run_all.cmd full` 已自动在临时目录运行。
- 正在使用的服务在 7321 端口。改了 `app/public/` 的文件，用户刷新即可；改了 `server.js` 或 `app/lib/`，用停止脚本加启动脚本重启，不要按历史 PID 杀进程。

## 6. 回执

完成或受阻时回一条，只写必要信息：

```text
完成｜阻塞  ｜ 改动文件 ｜ 命令与结果 ｜ 遗留问题或需要的决定
```

并在根目录 `docs/agent-handoff/SESSION_LOG.md` 末尾追加一行摘要。

## 7. DSH 的 HUD 回执（沿用）

Codex 通过 Agent HUD 派单给 DSH 时：每单只发目标、可改文件和验收条件，用 `reply_hint:true` 并保存消息 ID。DSH 完成或受阻时用 `send_message(reply_to=收到的消息ID, reply_hint=false)` 回一次，正文按第 6 节格式。派单方用 `get_message` 查同一编号，不发消息催进度；同一结果只验收一次，末单归档后停止往返。

## 8. 目录速查

- `app/` 是可运行实现（Node 22+ 内置 sqlite，零第三方依赖），说明见 `app/README.md` 的「结构」一节。
- 根目录的 `index.html`、`studio.js`、`studio.css`、`Mac工作台.html` 是早期交互样稿，只作对照，不当实现改。
- 架构与阶段说明在 `工作台架构.md`；视觉改版先读 `E:/AI项目/软件UI素材库/AGENTS.md`，选型由用户确认后记入素材库 `DECISIONS.md`。

## 9. 派单与复盘要点（2026-11-21 v2 一轮的经验）

派单前（Claude）：
- **会话**：Codex 和 DSH 每轮开新会话，不复用长会话。DSH 经 Magpie 网关时缓存命中为 0%，旧会话每次调用都要重发全部上下文（v2 一轮约 2500 万输入 token）。
- **权限**：确认 Codex 已信任本项目（`~/.codex/config.toml` 里有 `[projects.'E:\个人智能工作台']`），否则每一步都要用户点确认。这一项由用户自己改。
- **影响面**：工单写明「会被替换的旧页面 / 旧测试」并指定由谁迁移，不要等全量测试失败了再临时派。
- **验收脚本**：改 `verify/` 后先在本机完整跑一遍再提交；`.cmd` 必须是 CRLF；中文路径不要交给 cmd 的通配符。

执行中（Codex / DSH）：
- **完成定义**：自己的测试文件全过 + `verify\run_all.cmd` 快速版通过，就提交。`full` 里出现的失败若属于对方正在做的工单，写进提交正文和回执，**不因此阻塞自己的提交**。
- **回执**附本轮用量（HUD 里的调用次数、输入/输出 token），方便比较成本。

派单后（Claude）：
- 追加消息前先查 `git log` 和 `get_message` 的状态，确认对方还没做这件事，避免多余的一轮往返。
- 分工按长处：安全敏感、接口严格、需要省 token 的后端给 Codex；页面多、交互细、需要大量浏览器测试的前端给 DSH。