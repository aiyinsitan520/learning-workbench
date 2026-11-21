-- Learning Space v1. Run on a new application-owned SQLite database.
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

CREATE TABLE tasks (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    course TEXT NOT NULL DEFAULT '',
    estimated_seconds INTEGER CHECK (estimated_seconds > 0),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    completed_at INTEGER
) STRICT;

CREATE TABLE schedule_blocks (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    starts_at INTEGER NOT NULL CHECK (starts_at >= 0),
    planned_seconds INTEGER NOT NULL CHECK (planned_seconds > 0)
) STRICT;
CREATE INDEX schedule_by_time ON schedule_blocks(starts_at);

CREATE TABLE focus_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK (state IN ('running', 'paused', 'finished')),
    planned_seconds INTEGER NOT NULL CHECK (planned_seconds > 0),
    elapsed_seconds INTEGER NOT NULL DEFAULT 0
        CHECK (elapsed_seconds BETWEEN 0 AND planned_seconds),
    started_at INTEGER NOT NULL DEFAULT (unixepoch()),
    state_changed_at INTEGER NOT NULL DEFAULT (unixepoch()),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
) STRICT;
CREATE UNIQUE INDEX one_open_focus ON focus_sessions((1))
    WHERE state IN ('running', 'paused');
CREATE INDEX focus_by_state_time ON focus_sessions(state, state_changed_at);

CREATE TABLE day_notes (
    id TEXT PRIMARY KEY NOT NULL,
    study_date TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
) STRICT;

CREATE TABLE note_blocks (
    id TEXT PRIMARY KEY NOT NULL,
    note_id TEXT NOT NULL REFERENCES day_notes(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    kind TEXT NOT NULL CHECK (kind IN ('text', 'question', 'thought', 'workflow', 'task_ref')),
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
    CHECK ((kind = 'task_ref') = (task_id IS NOT NULL)),
    UNIQUE(note_id, position)
) STRICT;

PRAGMA user_version = 1;
COMMIT;
