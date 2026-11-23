-- v2 → v3：任务正文按天留底，AI 回顾据此知道「当天新写了什么」，并能和之前对比成长。
-- 每次保存任务正文时，把「保存后的全文」写进当天那一行（一天一行，覆盖写）。
-- 当天新增内容 = 当天这一份 与 之前最近一份 的差异（app/lib/db.js readNoteChanges）。
-- 已有的正文在迁移时记成 1970-01-01 的基线，之后每天的新增都能和它比。

CREATE TABLE task_note_days (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    body TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, day)
) STRICT;

INSERT INTO task_note_days (task_id, day, body, updated_at)
SELECT task_id, '1970-01-01', body, unixepoch() FROM task_notes WHERE length(trim(body)) > 0;

PRAGMA user_version = 3;
