#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""学习工作台 schema 行为验收脚本。

只使用 Python 标准库：把与本文件同目录的 schema.sql 载入内存 SQLite，
打开外键约束，然后在彼此隔离的事务里做可重复的行为断言。
脚本本身不创建、不修改 schema.sql，也不读写任何项目数据。

用法（任意工作目录均可执行）：

    python "E:/个人智能工作台/学习工作台初稿/architecture/check_schema.py"
    python check_schema.py -v        # 出现未预期异常时打印堆栈

退出码：0 = 全部通过；1 = 有检查项失败；2 = 环境/装载失败（缺 schema.sql 等）。
"""

from __future__ import annotations

import sqlite3
import sys
import traceback
from contextlib import contextmanager
from pathlib import Path

SCHEMA_PATH = Path(__file__).resolve().parent / "schema.sql"

# 整套检查跑两轮，用两个独立的内存库，验证断言可重复、结果一致。
ROUNDS = 2

# 2023-11-14T22:13:20Z，非负整数 epoch 秒。
EPOCH = 1_700_000_000

REQUIRED_TABLES = ("tasks", "schedule_blocks", "focus_sessions")

# 期望被拒绝时，错误信息里应出现的约束类型关键字。
_WANT_TEXT = {"fk": "FOREIGN KEY", "check": "CHECK", "unique": "UNIQUE"}


class SetupError(Exception):
    """环境或 schema 装载失败，无法进入检查项。"""


class CheckFailure(AssertionError):
    """单项断言失败。"""


# ---------------------------------------------------------------- 基础设施


@contextmanager
def isolated(conn: sqlite3.Connection):
    """在一个事务里跑检查项，结束一律回滚，测试数据不落地。"""
    conn.execute("BEGIN")
    try:
        yield conn
    finally:
        if conn.in_transaction:
            conn.execute("ROLLBACK")


def count(conn: sqlite3.Connection, table: str) -> int:
    return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


def expect_rejected(conn, sql, params=(), want="any", note=""):
    """断言语句被约束拒绝，返回错误信息。"""
    label = note or " ".join(sql.split())
    try:
        conn.execute(sql, params)
    except sqlite3.IntegrityError as exc:
        message = str(exc)
        expected = _WANT_TEXT.get(want)
        if expected and expected not in message.upper():
            raise CheckFailure(
                f"{label}：被拒绝，但错误不是 {want} 约束（实际：{message}）"
            ) from exc
        return message
    except sqlite3.Error as exc:
        raise CheckFailure(
            f"{label}：被拒绝，但抛出 {type(exc).__name__}（{exc}），应为约束错误"
        ) from exc
    raise CheckFailure(f"{label}：本应被拒绝，实际写入成功")


def insert_task(conn, task_id, title="线性代数复习"):
    conn.execute("INSERT INTO tasks (id, title) VALUES (?, ?)", (task_id, title))


def insert_block(conn, block_id, task_id, starts_at=EPOCH, planned_seconds=1500):
    conn.execute(
        "INSERT INTO schedule_blocks (id, task_id, starts_at, planned_seconds)"
        " VALUES (?, ?, ?, ?)",
        (block_id, task_id, starts_at, planned_seconds),
    )


def insert_focus(conn, focus_id, task_id, state, planned_seconds=1500, elapsed=0):
    conn.execute(
        "INSERT INTO focus_sessions"
        " (id, task_id, state, planned_seconds, elapsed_seconds)"
        " VALUES (?, ?, ?, ?, ?)",
        (focus_id, task_id, state, planned_seconds, elapsed),
    )


def open_focus_count(conn) -> int:
    return conn.execute(
        "SELECT COUNT(*) FROM focus_sessions WHERE state IN ('running', 'paused')"
    ).fetchone()[0]


# ---------------------------------------------------------------- 检查项


def check_tasks_insert(conn):
    """tasks(id,title) 可插入，字符串 id 原样保存。"""
    insert_task(conn, "task-1", "线性代数复习")
    row = conn.execute(
        "SELECT id, title FROM tasks WHERE id = ?", ("task-1",)
    ).fetchone()
    if row != ("task-1", "线性代数复习"):
        raise CheckFailure(f"tasks 读回不一致：{row!r}")
    return "字符串 id + title 插入并读回一致"


def check_tasks_duplicate_id(conn):
    """字符串 id 是主键，重复写入被拒绝。"""
    insert_task(conn, "task-dup", "第一次")
    expect_rejected(
        conn,
        "INSERT INTO tasks (id, title) VALUES (?, ?)",
        ("task-dup", "第二次"),
        want="unique",
        note="重复 tasks.id",
    )
    if count(conn, "tasks") != 1:
        raise CheckFailure("重复 id 被拒后任务数不为 1")
    return "重复字符串 id 被主键拒绝，任务数仍为 1"


def check_schedule_insert(conn):
    """schedule_blocks(id,task_id,starts_at,planned_seconds) 可插入。"""
    insert_task(conn, "task-s", "概率论")
    insert_block(conn, "block-1", "task-s", EPOCH, 1500)
    row = conn.execute(
        "SELECT id, task_id, starts_at, planned_seconds"
        " FROM schedule_blocks WHERE id = ?",
        ("block-1",),
    ).fetchone()
    if row != ("block-1", "task-s", EPOCH, 1500):
        raise CheckFailure(f"schedule_blocks 读回不一致：{row!r}")
    return f"排期插入成功，starts_at={EPOCH}（epoch 秒）"


def check_schedule_reschedule_keeps_task_count(conn):
    """用同一任务改期，不会改变任务数。"""
    insert_task(conn, "task-r", "概率论")
    insert_block(conn, "block-r1", "task-r", EPOCH, 1500)
    tasks_before = count(conn, "tasks")
    if tasks_before != 1:
        raise CheckFailure(f"准备阶段任务数应为 1，实际 {tasks_before}")

    # 改期：同一条排期挪到一小时后。
    conn.execute(
        "UPDATE schedule_blocks SET starts_at = ? WHERE id = ?",
        (EPOCH + 3600, "block-r1"),
    )
    row = conn.execute(
        "SELECT task_id, starts_at, planned_seconds"
        " FROM schedule_blocks WHERE id = ?",
        ("block-r1",),
    ).fetchone()
    if row is None:
        raise CheckFailure("改期后排期记录消失")
    task_id, starts_at, planned_seconds = row
    if starts_at != EPOCH + 3600:
        raise CheckFailure(f"改期未生效：starts_at={starts_at}")
    if (task_id, planned_seconds) != ("task-r", 1500):
        raise CheckFailure("改期改动了同一排期的其它字段")
    if count(conn, "tasks") != tasks_before:
        raise CheckFailure("改期改变了任务数")
    if count(conn, "schedule_blocks") != 1:
        raise CheckFailure("改期复制或删除了排期行")

    # 同一任务再排第二段，仍然只有一个任务。
    insert_block(conn, "block-r2", "task-r", EPOCH + 7200, 900)
    if count(conn, "tasks") != 1:
        raise CheckFailure("同一任务排两段后任务数不为 1")
    if count(conn, "schedule_blocks") != 2:
        raise CheckFailure("同一任务排两段后排期数不为 2")
    title = conn.execute(
        "SELECT title FROM tasks WHERE id = ?", ("task-r",)
    ).fetchone()[0]
    if title != "概率论":
        raise CheckFailure(f"任务标题被改期影响：{title!r}")
    return "改期 + 同任务加段后 tasks 仍为 1 条、排期为 2 条"


def check_schedule_foreign_key(conn):
    """错误 task_id 被外键拒绝。"""
    message = expect_rejected(
        conn,
        "INSERT INTO schedule_blocks (id, task_id, starts_at, planned_seconds)"
        " VALUES (?, ?, ?, ?)",
        ("block-orphan", "task-missing", EPOCH, 600),
        want="fk",
        note="schedule_blocks.task_id 指向不存在的任务",
    )
    if count(conn, "schedule_blocks") != 0:
        raise CheckFailure("外键拒绝后仍写入了排期")
    return f"外键拒绝：{message}"


def check_schedule_starts_at_non_negative(conn):
    """starts_at 必须是非负整数 epoch 秒。"""
    insert_task(conn, "task-n", "错题整理")
    message = expect_rejected(
        conn,
        "INSERT INTO schedule_blocks (id, task_id, starts_at, planned_seconds)"
        " VALUES (?, ?, ?, ?)",
        ("block-neg", "task-n", -1, 600),
        want="check",
        note="starts_at=-1",
    )
    if count(conn, "schedule_blocks") != 0:
        raise CheckFailure("负数 starts_at 被拒后仍写入了排期")
    return f"负数 starts_at 被拒绝：{message}"


def check_focus_states_accepted(conn):
    """focus_sessions 接受 running / paused / finished 三种状态。"""
    insert_task(conn, "task-f", "英语听力")
    insert_focus(conn, "focus-1", "task-f", "running", 1500, 0)
    for state in ("paused", "finished"):
        conn.execute(
            "UPDATE focus_sessions SET state = ? WHERE id = ?", (state, "focus-1")
        )
        got = conn.execute(
            "SELECT state FROM focus_sessions WHERE id = ?", ("focus-1",)
        ).fetchone()[0]
        if got != state:
            raise CheckFailure(f"状态切换失败：期望 {state}，实际 {got}")
    return "running → paused → finished 三种状态均可写入"


def check_focus_state_unknown_rejected(conn):
    """状态机只允许三种取值。"""
    insert_task(conn, "task-f2", "政治背诵")
    message = expect_rejected(
        conn,
        "INSERT INTO focus_sessions"
        " (id, task_id, state, planned_seconds, elapsed_seconds)"
        " VALUES (?, ?, ?, ?, ?)",
        ("focus-bad", "task-f2", "idle", 600, 0),
        want="check",
        note="state='idle'",
    )
    if count(conn, "focus_sessions") != 0:
        raise CheckFailure("未知状态被拒后仍写入了专注记录")
    return f"未知状态被拒绝：{message}"


def check_focus_single_open_running(conn):
    """已有 running 时，再开 running 或 paused 都被拒绝。"""
    insert_task(conn, "task-o1", "数据结构")
    insert_focus(conn, "focus-run", "task-o1", "running", 1500, 0)

    first = expect_rejected(
        conn,
        "INSERT INTO focus_sessions"
        " (id, task_id, state, planned_seconds, elapsed_seconds)"
        " VALUES (?, ?, ?, ?, ?)",
        ("focus-p", "task-o1", "paused", 600, 0),
        want="any",
        note="已有 running 时插入 paused",
    )
    second = expect_rejected(
        conn,
        "INSERT INTO focus_sessions"
        " (id, task_id, state, planned_seconds, elapsed_seconds)"
        " VALUES (?, ?, ?, ?, ?)",
        ("focus-run2", "task-o1", "running", 600, 0),
        want="any",
        note="已有 running 时插入 running",
    )
    # 对照组：finished 不受开放位限制，说明拒绝确实来自"最多一条开放专注"。
    insert_focus(conn, "focus-done", "task-o1", "finished", 600, 600)
    if count(conn, "focus_sessions") != 2:
        raise CheckFailure("拒绝后专注记录数不为 2（running + finished）")
    if open_focus_count(conn) != 1:
        raise CheckFailure("开放专注数不为 1")
    return f"running 占用唯一开放位；paused 被拒（{first}）；running 被拒（{second}）"


def check_focus_single_open_paused(conn):
    """已有 paused 时，再开 running 或 paused 都被拒绝。"""
    insert_task(conn, "task-o2", "操作系统")
    insert_focus(conn, "focus-pause", "task-o2", "paused", 1500, 300)

    first = expect_rejected(
        conn,
        "INSERT INTO focus_sessions"
        " (id, task_id, state, planned_seconds, elapsed_seconds)"
        " VALUES (?, ?, ?, ?, ?)",
        ("focus-run", "task-o2", "running", 600, 0),
        want="any",
        note="已有 paused 时插入 running",
    )
    second = expect_rejected(
        conn,
        "INSERT INTO focus_sessions"
        " (id, task_id, state, planned_seconds, elapsed_seconds)"
        " VALUES (?, ?, ?, ?, ?)",
        ("focus-pause2", "task-o2", "paused", 600, 0),
        want="any",
        note="已有 paused 时插入 paused",
    )
    insert_focus(conn, "focus-done", "task-o2", "finished", 600, 600)
    if count(conn, "focus_sessions") != 2:
        raise CheckFailure("拒绝后专注记录数不为 2（paused + finished）")
    if open_focus_count(conn) != 1:
        raise CheckFailure("开放专注数不为 1")
    return f"paused 占用唯一开放位；running 被拒（{first}）；paused 被拒（{second}）"


def check_focus_open_slot_released(conn):
    """结束当前专注后，开放位可以被下一条占用。"""
    insert_task(conn, "task-o3", "计算机网络")
    insert_focus(conn, "focus-a", "task-o3", "running", 1500, 0)
    conn.execute(
        "UPDATE focus_sessions SET state = 'finished' WHERE id = ?", ("focus-a",)
    )
    insert_focus(conn, "focus-b", "task-o3", "running", 1500, 0)
    if count(conn, "focus_sessions") != 2:
        raise CheckFailure("结束后新开专注失败")
    if open_focus_count(conn) != 1:
        raise CheckFailure("开放专注数不为 1")
    return "finished 释放开放位，可开始下一条 running"


def check_focus_free_null_task(conn):
    """task_id 可为空，用于自由专注。"""
    insert_focus(conn, "focus-free", None, "running", 600, 0)
    row = conn.execute(
        "SELECT task_id, state FROM focus_sessions WHERE id = ?", ("focus-free",)
    ).fetchone()
    if row is None:
        raise CheckFailure("自由专注未写入")
    if row[0] is not None:
        raise CheckFailure(f"task_id 应为 NULL，实际 {row[0]!r}")
    return "task_id 为 NULL 的自由专注可插入"


def check_focus_free_counts_as_open(conn):
    """自由专注同样占用唯一开放位。"""
    insert_focus(conn, "focus-free", None, "running", 600, 0)
    insert_task(conn, "task-o4", "编译原理")
    message = expect_rejected(
        conn,
        "INSERT INTO focus_sessions"
        " (id, task_id, state, planned_seconds, elapsed_seconds)"
        " VALUES (?, ?, ?, ?, ?)",
        ("focus-bound", "task-o4", "paused", 600, 0),
        want="any",
        note="自由专注 running 存在时插入任务专注 paused",
    )
    insert_focus(conn, "focus-free-done", None, "finished", 600, 600)
    if count(conn, "focus_sessions") != 2:
        raise CheckFailure("拒绝后专注记录数不为 2")
    return f"自由专注也占用开放位：{message}"


def check_focus_many_finished(conn):
    """finished 记录可以有多条（约束只作用于开放状态）。"""
    insert_task(conn, "task-o5", "线性代数")
    insert_focus(conn, "focus-d1", "task-o5", "finished", 900, 900)
    insert_focus(conn, "focus-d2", None, "finished", 600, 600)
    insert_focus(conn, "focus-d3", None, "finished", 300, 120)
    if count(conn, "focus_sessions") != 3:
        raise CheckFailure("多条 finished 记录写入失败")
    if open_focus_count(conn) != 0:
        raise CheckFailure("finished 记录被算成了开放专注")
    return "3 条 finished 记录并存，开放专注数为 0"


def check_focus_elapsed(conn):
    """elapsed_seconds 有默认值，也可显式写入。"""
    conn.execute(
        "INSERT INTO focus_sessions (id, task_id, state, planned_seconds)"
        " VALUES (?, ?, ?, ?)",
        ("focus-default", None, "finished", 900),
    )
    got = conn.execute(
        "SELECT elapsed_seconds FROM focus_sessions WHERE id = ?",
        ("focus-default",),
    ).fetchone()[0]
    if got != 0:
        raise CheckFailure(f"elapsed_seconds 默认值应为 0，实际 {got}")
    insert_focus(conn, "focus-elapsed", None, "finished", 900, 300)
    got = conn.execute(
        "SELECT elapsed_seconds FROM focus_sessions WHERE id = ?",
        ("focus-elapsed",),
    ).fetchone()[0]
    if got != 300:
        raise CheckFailure(f"显式 elapsed_seconds 未保存，实际 {got}")
    return "elapsed_seconds 默认 0，显式写入 300 正常"


def check_focus_foreign_key(conn):
    """focus_sessions 的错误 task_id 也被外键拒绝。"""
    message = expect_rejected(
        conn,
        "INSERT INTO focus_sessions"
        " (id, task_id, state, planned_seconds, elapsed_seconds)"
        " VALUES (?, ?, ?, ?, ?)",
        ("focus-orphan", "task-missing", "running", 600, 0),
        want="fk",
        note="focus_sessions.task_id 指向不存在的任务",
    )
    if count(conn, "focus_sessions") != 0:
        raise CheckFailure("外键拒绝后仍写入了专注记录")
    return f"外键拒绝：{message}"


def check_isolation_clean(conn):
    """每个检查项的事务都已回滚，测试数据互不污染。"""
    leftovers = {table: count(conn, table) for table in REQUIRED_TABLES}
    dirty = {table: n for table, n in leftovers.items() if n}
    if dirty:
        raise CheckFailure(f"事务回滚后仍有残留数据：{dirty}")
    return "三项表均为 0 行，测试数据未落库"


CHECKS = (
    ("tasks.insert", check_tasks_insert),
    ("tasks.duplicate_id_rejected", check_tasks_duplicate_id),
    ("schedule.insert", check_schedule_insert),
    ("schedule.reschedule_keeps_task_count", check_schedule_reschedule_keeps_task_count),
    ("schedule.foreign_key_rejected", check_schedule_foreign_key),
    ("schedule.starts_at_non_negative", check_schedule_starts_at_non_negative),
    ("focus.states_accepted", check_focus_states_accepted),
    ("focus.state_unknown_rejected", check_focus_state_unknown_rejected),
    ("focus.single_open_running", check_focus_single_open_running),
    ("focus.single_open_paused", check_focus_single_open_paused),
    ("focus.open_slot_released_after_finish", check_focus_open_slot_released),
    ("focus.free_task_null", check_focus_free_null_task),
    ("focus.free_counts_as_open", check_focus_free_counts_as_open),
    ("focus.many_finished_allowed", check_focus_many_finished),
    ("focus.elapsed_default", check_focus_elapsed),
    ("focus.foreign_key_rejected", check_focus_foreign_key),
    ("isolation.rollback_clean", check_isolation_clean),
)


# ---------------------------------------------------------------- 执行


def reconfigure_stdout():
    """尽量用 UTF-8 输出，避免旧控制台编码把中文打成异常。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def read_schema() -> str:
    if not SCHEMA_PATH.is_file():
        raise SetupError(f"找不到 schema.sql：{SCHEMA_PATH}")
    text = SCHEMA_PATH.read_text(encoding="utf-8")
    if not text.strip():
        raise SetupError(f"schema.sql 为空：{SCHEMA_PATH}")
    return text


def open_database(schema_sql: str) -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:", isolation_level=None)
    conn.execute("PRAGMA foreign_keys = ON")
    if conn.execute("PRAGMA foreign_keys").fetchone()[0] != 1:
        conn.close()
        raise SetupError("无法打开 PRAGMA foreign_keys")
    try:
        conn.executescript(schema_sql)
    except sqlite3.Error as exc:
        conn.close()
        raise SetupError(f"执行 schema.sql 失败：{exc}") from exc
    if conn.in_transaction:
        conn.execute("ROLLBACK")
    missing = [
        table
        for table in REQUIRED_TABLES
        if conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table,),
        ).fetchone()
        is None
    ]
    if missing:
        conn.close()
        raise SetupError(f"schema.sql 缺少表：{', '.join(missing)}")
    return conn


def run_round(conn: sqlite3.Connection, verbose: bool):
    results = []
    for name, check in CHECKS:
        try:
            with isolated(conn):
                detail = check(conn)
        except CheckFailure as exc:
            results.append((name, False, str(exc)))
            print(f"[FAIL] {name}: {exc}")
        except sqlite3.Error as exc:
            results.append((name, False, f"SQLite 错误：{exc}"))
            print(f"[FAIL] {name}: SQLite 错误：{exc}")
            if verbose:
                traceback.print_exc()
        except Exception as exc:  # noqa: BLE001 - 任何异常都算失败，但要报清楚
            results.append((name, False, f"未预期异常 {type(exc).__name__}: {exc}"))
            print(f"[FAIL] {name}: 未预期异常 {type(exc).__name__}: {exc}")
            if verbose:
                traceback.print_exc()
        else:
            results.append((name, True, detail))
            print(f"[PASS] {name}: {detail}")
    return results


def report_setup_failure(exc):
    print(f"[FAIL] schema.load: {exc}")
    print()
    print("== 汇总 ==")
    print("检查项: 0  通过: 0  失败: 1")
    print("结果: FAIL")


def main(argv=None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    verbose = any(a in ("-v", "--verbose") for a in args)

    reconfigure_stdout()
    print("学习工作台 schema 行为验收")
    print(f"schema: {SCHEMA_PATH}")
    print(f"python: {sys.version.split()[0]}  sqlite: {sqlite3.sqlite_version}")

    try:
        schema_sql = read_schema()
    except SetupError as exc:
        report_setup_failure(exc)
        return 2

    rounds = []
    for round_no in range(1, ROUNDS + 1):
        print()
        print(f"-- 第 {round_no} 轮 --")
        try:
            conn = open_database(schema_sql)
        except SetupError as exc:
            report_setup_failure(exc)
            return 2
        try:
            rounds.append(run_round(conn, verbose))
        finally:
            conn.close()

    first = rounds[0]
    total = len(first)
    passed = sum(1 for _, ok, _ in first if ok)
    failed = total - passed
    signature = [(name, ok) for name, ok, _ in first]
    repeatable = all(
        [(name, ok) for name, ok, _ in other] == signature for other in rounds[1:]
    )

    print()
    print("== 汇总 ==")
    for index, results in enumerate(rounds, 1):
        ok_count = sum(1 for _, ok, _ in results if ok)
        print(f"第 {index} 轮: {ok_count}/{len(results)} 通过")
    print(f"检查项: {total}  通过: {passed}  失败: {failed}")
    print(f"重复执行一致性: {'一致' if repeatable else '不一致'}")
    if failed:
        print("失败项:")
        for name, ok, detail in first:
            if not ok:
                print(f"  - {name}: {detail}")
    ok_all = failed == 0 and repeatable
    print(f"结果: {'PASS' if ok_all else 'FAIL'}")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
