-- v3 → v4：收获库。用户在 ChatGPT 等处问完问题后，把对话精华（不是原文）存成一张卡片。
-- 原文不入库，只存提炼后的标题、结论、要点、待办、标签和对话链接。
-- points / tags 是字符串 JSON 数组；todos 是 [{ "text": "...", "taskId": "..." | null }]，
-- taskId 指向由这条待办生成的任务（promoteHarvestTodo），任务删除不影响卡片，读取时按 id 现查。

CREATE TABLE harvests (
    id TEXT PRIMARY KEY NOT NULL,
    day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    conclusion TEXT NOT NULL DEFAULT '',
    points TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(points) AND json_type(points) = 'array'),
    todos TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(todos) AND json_type(todos) = 'array'),
    tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array'),
    source TEXT NOT NULL DEFAULT '',          -- 'chatgpt' | 'ai' | 'manual' 等，只作展示
    source_url TEXT NOT NULL DEFAULT '',      -- 对话链接，空串 = 没有
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE INDEX harvests_by_day ON harvests(day, created_at);

PRAGMA user_version = 4;
