# 给 AI 读取学习工作台数据

| 方式 | 位置和用法 |
| --- | --- |
| 导出文件 | 在项目目录右键 `导出给AI.ps1`，选择「使用 PowerShell 运行」。默认生成最近 30 天的 JSON、Markdown 和本说明，保存在 `app/data/ai-export/` |
| 本机接口 | `GET http://127.0.0.1:7321/api/context?days=30&format=md`。`format=json` 返回结构化数据。可用 `end=YYYY-MM-DD` 指定最后一天，`days` 上限为 120 |
| SQLite 数据库 | `app/data/workbench.db`。服务未运行时，导出工具用只读连接生成临时副本并在副本上迁移。外部分析优先使用导出文件 |

命令行用法为 `node app/tools/export-ai.mjs --days 30`。可加 `--out <目录>` 自选输出目录，或用 `--db <库路径>` 明确指定离线数据源。相同截止日的导出会覆盖该目录中的同名快照。

## 数据库字段

| 表 | 主要字段及含义 |
| --- | --- |
| `tasks` | `id`、`title`、`course`，创建和完成时间 `created_at`、`completed_at`，v2 的 `project_id` 将关联任务归到长期项目 |
| `schedule_blocks` | `task_id`、`starts_at` 和 `planned_seconds` 分别表示计划任务、预定开始和计划时长 |
| `focus_sessions` | `task_id` 为空表示自由专注。以 `state = 'finished'` 及 `elapsed_seconds` 统计已结束专注 |
| `day_notes`、`note_blocks` | 旧版每日手记及有序内容块，按 `study_date` 归日；支持文字、任务引用等内容 |
| `task_notes` | 按 `task_id` 存储任务正文 `body`，`revision` 是保存版本 |
| `projects`（v2） | 项目标题、目标、开始日、截止日、每日目标分钟、主任务和完成或归档状态 |
| `project_logs`（v2） | 每个项目每天最多一条日志，含 `day`、`note`、可空的 `progress`（0–100） |
| `daily_reviews`（v2） | 按日期保存 AI 回顾正文、模型、生成时间与 `facts_hash`，事实变化后旧回顾标为过期 |
| `harvests`（v4） | 按 `day` 归档的对话精华卡片，含标题、结论、要点、待办、标签、来源链接与关联项目 |

## 快照口径

- 日期、星期与 HH:MM 使用 `timeZone`。默认时区为 `Asia/Shanghai`。
- SQLite 与 JSON 中的绝对时间使用 Unix 秒。统计用时先按秒累计，Markdown 展示时取整为分钟。
- 排期和专注按开始时间归日，任务完成按完成时间归日。排期不代表做了，进行中的专注不计入已结束专注。
- `plan.followRate` 按当天排期的不同任务计数，分子是当天专注过或当天完成的任务。没有计划时为 `null`。
- 同一任务分成多个计划块时，每行显示的是该任务当天的专注分钟。汇总请用 `focusedOnPlannedSeconds`。
- `planOnly=true` 表示仅日计划事项。项目 `dayIndex` 从 1 开始，`daysLeft` 为负表示逾期。
- JSON 包含 `guide`、`range`、`pendingTasks`、`projects`、按日排序的 `days` 与 `harvests`。
- `harvests` 按卡片归属日筛选，只包含 `range` 内的收获，旧的在前。对话原文不存，`todos` 只包含当时列出的待办文字。Markdown 有收获时会附上「收获」一节。

## 隐私

任务正文默认不导出。只有明确添加 `--notes` 或向接口传 `notes=1` 时才附带正文。任务标题、项目目标、进展日志和收获卡片可能含私人信息，发送给外部 AI 前请先检查。供应商 Key 只在本机模型配置中保存，数据库和数据快照不包含该配置。

## 提示词示例

- **学习节奏**「按周分析我的专注时长和任务分布，指出最稳定的学习时段。用日期和分钟支持结论，区分无记录与零投入。」
- **计划执行**「比较近两周的计划时长、计划内专注和执行率，找出最常未开始的计划，并给我一个下周可以试验的改动。」
- **长期项目风险**「结合截止日、项目日志和每日投入，列出最可能逾期的项目、你的依据以及今天能做的一个动作。将判断和已有事实分开。」
