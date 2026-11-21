-- v1 → v2：长期项目（跨多天）与每日维护的 AI 回顾缓存。
-- 由 app/lib/db.js 在一个事务里执行；执行前会把旧库另存一份 .bak-v1-*。
-- 日期一律是工作台时区（北京时间）的 YYYY-MM-DD 文本；时间戳是 Unix 秒。
-- 注意：AI 模型的 API Key 不进数据库，存在 app/data/ai-providers.json，
-- 这样把数据库交给别的 AI 分析时不会带出密钥。

-- 长期项目：跨多天的目标。每个项目自带一个「主任务」（tasks.project_id 指回项目，
-- course = '长期项目'），日计划、专注、任务正文都直接复用这个任务，不另造一套。
CREATE TABLE projects (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    goal TEXT NOT NULL DEFAULT '',
    start_day TEXT NOT NULL CHECK (start_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    due_day TEXT CHECK (due_day IS NULL OR due_day >= start_day),
    daily_minutes INTEGER CHECK (daily_minutes > 0),
    main_task_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    completed_at INTEGER,
    archived_at INTEGER
) STRICT;

-- 任务归属项目（可空）。主任务和项目里的子任务都填这一列。
ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT;
CREATE INDEX tasks_by_project ON tasks(project_id);

-- 项目每日进展：一天一条，在每日维护看板里写。
CREATE TABLE project_logs (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    note TEXT NOT NULL DEFAULT '',
    progress INTEGER CHECK (progress BETWEEN 0 AND 100),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (project_id, day)
) STRICT;

-- 每日维护的 AI 回顾：按「被回顾的那一天」存一份。facts_hash 变了说明当天记录改过，可重新生成。
CREATE TABLE daily_reviews (
    day TEXT PRIMARY KEY NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    facts_hash TEXT NOT NULL,
    text TEXT NOT NULL CHECK (length(trim(text)) > 0),
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

PRAGMA user_version = 2;
