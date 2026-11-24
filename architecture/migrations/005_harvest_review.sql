ALTER TABLE harvests ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE harvests ADD COLUMN starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0, 1));
ALTER TABLE harvests ADD COLUMN review_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE harvests ADD COLUMN last_reviewed_at INTEGER;
ALTER TABLE harvests ADD COLUMN next_review_day TEXT;
ALTER TABLE harvests ADD COLUMN images TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(images) AND json_type(images) = 'array');

CREATE INDEX harvests_by_project ON harvests(project_id);
CREATE INDEX harvests_by_task ON harvests(task_id);
CREATE INDEX harvests_by_review_day ON harvests(next_review_day) WHERE next_review_day IS NOT NULL;

PRAGMA user_version = 5;
