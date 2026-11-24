工单 T-W8a：收获的关联、星标、复习、图片——数据层
tier：hard   risk：low   执行：Codex high   依赖：T-W3 已提交
先读：tasks/ROUND-2026-11-24.md、architecture/migrations/004_harvests.sql、workbench.d.ts 的 Harvest、app/lib/db.js 收获部分

用户原话：「收获卡片不够完善」（用户确认四项：卡片样式简陋、不能关联项目/任务、缺少复习、编辑不便）

可改文件：architecture/migrations/005_harvest_review.sql（新）、architecture/workbench.d.ts、app/lib/db.js（收获相关函数、SCHEMA_VERSION=5）、app/server.js（收获路由与命令分派）、app/lib/digest.js（只在回顾素材里加「今日复习」计数，可选）、app/test/harvest.test.js 及新测试、受版本号影响的旧断言（user_version 4→5，回执说明）
不许动：前端文件（T-W8b 做）、tokens.css

接口约定：
- 迁移 005：harvests 加 `task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL`、`starred INTEGER NOT NULL DEFAULT 0 CHECK(starred IN (0,1))`、`review_count INTEGER NOT NULL DEFAULT 0`、`last_reviewed_at INTEGER`、`next_review_day TEXT`（StudyDay，NULL=不在复习中）、`images TEXT NOT NULL DEFAULT '[]'`（附件 id 的 JSON 数组）。迁移前沿用现有自动备份。
- Harvest 类型加：`taskId: string|null; starred: boolean; review: { count:number; lastAt:number|null; nextDay:StudyDay|null }; images: string[]`（images 每项须匹配附件 id 正则）。
- 命令（POST /api/command）：`setHarvestStar {id, starred}`；`setHarvestReview {id, enabled}`（开启 → nextDay=今天+1，count 不变；关闭 → nextDay=null）；`reviewHarvest {id, result:'remember'|'forgot'}`（remember：count+1，nextDay=今天+间隔[count]，间隔天数 [1,2,4,7,15,30,60]，超出取 60；forgot：count=0，nextDay=今天+1；都写 lastAt）；`updateHarvest` 允许更新 projectId、taskId、images、points、todos 的顺序与文本（已生成任务的 todo 保留 taskId）。
- `GET /api/harvests` 加筛选 `project=<id>`、`task=<id>`、`starred=1`、`due=1`（nextDay ≤ 今天）；`GET /api/harvests/random` → 一张（优先到期的）或 `null`。
- 视图：WorkbenchView 加 `harvestDue:number`；ProjectView 加 `harvestCount:number`。
完成标准：新测试覆盖迁移（v4 库升级保留数据）、各命令、间隔计算、筛选与随机；`verify\run_all.cmd` 通过（full 中只有 T-W8b 尚未适配的界面失败可写明不阻塞）。
