"""Verify the v1 on-disk contract on a disposable database, including reopen."""
import sqlite3
from contextlib import closing
from pathlib import Path
from tempfile import TemporaryDirectory


def check(path):
    with closing(sqlite3.connect(path)) as db:
        db.executescript(Path(__file__).with_name("schema.sql").read_text("utf-8"))
        with db:
            db.execute("INSERT INTO tasks(id,title) VALUES ('task','采样')")
            db.execute("INSERT INTO schedule_blocks VALUES ('slot','task',1000,1500)")
            db.execute("""INSERT INTO focus_sessions(id,task_id,state,planned_seconds,elapsed_seconds)
                          VALUES ('focus','task','finished',1500,80)""")
            db.execute("INSERT INTO day_notes(id,study_date) VALUES ('note','2026-11-20')")
            db.executemany("""INSERT INTO note_blocks(id,note_id,position,kind,body,task_id)
                              VALUES (?,'note',?,?,?,?)""",
                           [('a', 0, 'text', '今日思考', None), ('b', 1, 'task_ref', '', 'task')])
        try:
            with db:
                db.execute("""INSERT INTO note_blocks(id,note_id,position,kind)
                              VALUES ('broken','note',2,'task_ref')""")
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("task reference without a task ID was accepted")
        with db:
            db.execute("UPDATE note_blocks SET position=position+2")
            db.execute("UPDATE note_blocks SET position=CASE id WHEN 'a' THEN 1 ELSE 0 END")
            revision_update = "UPDATE day_notes SET revision=revision+1 WHERE id='note' AND revision=0"
            assert db.execute(revision_update).rowcount == 1
            assert db.execute(revision_update).rowcount == 0
            db.execute("UPDATE tasks SET completed_at=1500 WHERE id='task'")
            db.execute("UPDATE tasks SET completed_at=NULL WHERE id='task'")
    with closing(sqlite3.connect(path)) as reopened:
        assert reopened.execute("PRAGMA user_version").fetchone() == (1,)
        assert reopened.execute("SELECT id FROM note_blocks ORDER BY position").fetchall() == [('b',), ('a',)]
        assert reopened.execute("""SELECT completed_at,starts_at,elapsed_seconds FROM tasks
                                   JOIN schedule_blocks ON tasks.id=schedule_blocks.task_id
                                   JOIN focus_sessions ON tasks.id=focus_sessions.task_id""").fetchall() == [(None, 1000, 80)]
        assert reopened.execute("PRAGMA integrity_check").fetchone() == ("ok",)


if __name__ == "__main__":
    with TemporaryDirectory() as folder:
        check(Path(folder) / "workbench.sqlite3")
    print("schema_version=1 | task/undo/history=PASS | note order/revision/reference=PASS | file reopen=PASS | integrity=ok")
