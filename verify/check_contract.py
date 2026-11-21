#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""学习工作台 · 契约验收（只读）

只读检查，不改任何文件、不连真实数据库：
  1. architecture/*.sql 能否在内存库里执行，表与列是否符合预期
  2. app/server.js 暴露的 API 路由与命令是否齐全
  3. app/lib/db.js 是否实现了对应方法
  4. app/public 下的前端文件是否存在且被 index.html 引用

设计目标：Codex 正在改 app/ 时也能随时跑，不会与它冲突。

用法：
    python verify/check_contract.py
    python verify/check_contract.py -v

退出码：0 全部通过 / 1 有失败项 / 2 环境问题
"""

from __future__ import annotations

import json
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ARCH = ROOT / "architecture"
APP = ROOT / "app"

# ---------------------------------------------------------------- 期望契约

# 表 -> 必需列
EXPECTED_TABLES = {
    "tasks": {"id", "title", "course", "estimated_seconds", "created_at", "completed_at"},
    "schedule_blocks": {"id", "task_id", "starts_at", "planned_seconds"},
    "focus_sessions": {
        "id", "task_id", "state", "planned_seconds", "elapsed_seconds",
        "started_at", "state_changed_at", "revision",
    },
    "day_notes": {"id", "study_date", "title", "revision"},
    "note_blocks": {"id", "note_id", "position", "kind", "title", "body", "task_id"},
}

# 必需 API 路由（方法 + 路径）
EXPECTED_ROUTES = {
    ("GET", "/api/view"),
    ("GET", "/api/month"),
    ("GET", "/api/health"),
    ("POST", "/api/command"),
    ("GET", "/api/export"),
    ("POST", "/api/import"),
}

# 必需命令（workbench.d.ts 的 Command + 后续新增）
EXPECTED_COMMANDS = {
    "createTask", "setTaskCompleted", "saveSchedule", "removeSchedule",
    "startFocus", "changeFocus", "saveDayNote",
}

# 前端必需文件
EXPECTED_ASSETS = [
    "app/public/index.html",
    "app/public/tokens.css",
    "app/public/app.css",
    "app/public/js/app.js",
    "app/public/js/views.js",
    "app/public/js/api.js",
    "app/public/js/icons.js",
]

# 手记块种类（schema CHECK 约束）
EXPECTED_BLOCK_KINDS = {"text", "question", "thought", "workflow", "task_ref"}

# 专注状态
EXPECTED_FOCUS_STATES = {"running", "paused", "finished"}


class Failure(AssertionError):
    pass


# ---------------------------------------------------------------- 检查项

def check_schema_files():
    """architecture 下的建表脚本能被 SQLite 接受。"""
    files = sorted(ARCH.glob("*.sql"))
    if not files:
        raise Failure(f"{ARCH} 下没有 .sql 文件")
    names = []
    for path in files:
        sql = path.read_text(encoding="utf-8")
        if not sql.strip():
            raise Failure(f"{path.name} 是空的")
        conn = sqlite3.connect(":memory:")
        try:
            conn.executescript(sql)
        except sqlite3.Error as exc:
            raise Failure(f"{path.name} 执行失败：{exc}") from exc
        finally:
            conn.close()
        names.append(path.name)
    return f"{len(names)} 个脚本均可执行：{', '.join(names)}"


def check_tables_and_columns():
    """所有脚本叠加后，表与列齐全。"""
    conn = sqlite3.connect(":memory:")
    try:
        for path in sorted(ARCH.glob("*.sql")):
            conn.executescript(path.read_text(encoding="utf-8"))
        actual = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        }
        missing_tables = set(EXPECTED_TABLES) - actual
        if missing_tables:
            raise Failure(f"缺少表：{', '.join(sorted(missing_tables))}")

        problems = []
        for table, expected in EXPECTED_TABLES.items():
            cols = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
            missing = expected - cols
            if missing:
                problems.append(f"{table} 缺列 {', '.join(sorted(missing))}")
        if problems:
            raise Failure("；".join(problems))
        return f"{len(EXPECTED_TABLES)} 张表的必需列齐全"
    finally:
        conn.close()


def check_foreign_keys():
    """关键外键存在。"""
    conn = sqlite3.connect(":memory:")
    try:
        conn.executescript((ARCH / "schema.sql").read_text(encoding="utf-8"))
        conn.execute("PRAGMA foreign_keys = ON")
        expected = [
            ("schedule_blocks", "tasks"),
            ("focus_sessions", "tasks"),
            ("note_blocks", "day_notes"),
            ("note_blocks", "tasks"),
        ]
        problems = []
        for table, target in expected:
            fks = conn.execute(f"PRAGMA foreign_key_list({table})").fetchall()
            if not any(fk[2] == target for fk in fks):
                problems.append(f"{table} 没有指向 {target} 的外键")
        if problems:
            raise Failure("；".join(problems))
        return f"{len(expected)} 条外键都在"
    finally:
        conn.close()


def check_focus_single_open():
    """全库最多一条 running/paused —— 行为验证，不只看 DDL。"""
    conn = sqlite3.connect(":memory:", isolation_level=None)
    try:
        conn.executescript((ARCH / "schema.sql").read_text(encoding="utf-8"))
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("BEGIN")
        conn.execute(
            "INSERT INTO focus_sessions (id, task_id, state, planned_seconds)"
            " VALUES ('f1', NULL, 'running', 600)"
        )
        for state in ("running", "paused"):
            try:
                conn.execute(
                    "INSERT INTO focus_sessions (id, task_id, state, planned_seconds)"
                    " VALUES (?, NULL, ?, 600)",
                    (f"f-{state}", state),
                )
            except sqlite3.IntegrityError:
                continue
            raise Failure(f"已有 running 时插入 {state} 竟然成功")
        # finished 不受限
        conn.execute(
            "INSERT INTO focus_sessions (id, task_id, state, planned_seconds, elapsed_seconds)"
            " VALUES ('f-done', NULL, 'finished', 600, 600)"
        )
        open_count = conn.execute(
            "SELECT COUNT(*) FROM focus_sessions WHERE state IN ('running','paused')"
        ).fetchone()[0]
        if open_count != 1:
            raise Failure(f"开放专注数应为 1，实际 {open_count}")
        conn.execute("ROLLBACK")
        return "running/paused 唯一开放位生效，finished 可多条"
    finally:
        conn.close()


def check_block_kinds():
    """note_blocks.kind 只接受约定取值。"""
    conn = sqlite3.connect(":memory:")
    try:
        conn.executescript((ARCH / "schema.sql").read_text(encoding="utf-8"))
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute(
            "INSERT INTO day_notes (id, study_date, title) VALUES ('n1', '2026-11-20', 't')"
        )
        # task_ref 必须引用真实任务，单独准备
        conn.execute("INSERT INTO tasks (id, title) VALUES ('t-ref', '引用目标')")
        for position, kind in enumerate(sorted(EXPECTED_BLOCK_KINDS)):
            if kind == "task_ref":
                conn.execute(
                    "INSERT INTO note_blocks (id, note_id, position, kind, title, body, task_id)"
                    " VALUES (?, 'n1', ?, ?, '', '', 't-ref')",
                    (f"b-{kind}", position, kind),
                )
            else:
                conn.execute(
                    "INSERT INTO note_blocks (id, note_id, position, kind, title, body)"
                    " VALUES (?, 'n1', ?, ?, '', '')",
                    (f"b-{kind}", position, kind),
                )
        try:
            conn.execute(
                "INSERT INTO note_blocks (id, note_id, position, kind, title, body)"
                " VALUES ('b-bad', 'n1', 99, 'nonsense', '', '')"
            )
        except sqlite3.IntegrityError:
            return f"{len(EXPECTED_BLOCK_KINDS)} 种块类型可写入，未知类型被拒"
        raise Failure("未知块类型竟然写入成功")
    finally:
        conn.close()


def check_routes():
    """server.js 里注册了全部必需路由。"""
    src = (APP / "server.js").read_text(encoding="utf-8")
    found = set(re.findall(r"case '(GET|POST) (/api/[a-z]+)'", src))
    found = {(m, p) for m, p in found}
    missing = EXPECTED_ROUTES - found
    if missing:
        raise Failure("缺少路由：" + "、".join(f"{m} {p}" for m, p in sorted(missing)))
    return f"{len(EXPECTED_ROUTES)} 个必需路由都在（共发现 {len(found)} 个）"


def check_commands():
    """execute() 覆盖全部必需命令。"""
    src = (APP / "server.js").read_text(encoding="utf-8")
    block = src[src.find("export function execute"):]
    if not block:
        raise Failure("server.js 里找不到 execute()")
    found = set(re.findall(r"case '([a-zA-Z]+)':", block))
    missing = EXPECTED_COMMANDS - found
    if missing:
        raise Failure("缺少命令：" + "、".join(sorted(missing)))
    return f"{len(EXPECTED_COMMANDS)} 个必需命令都在（共发现 {len(found)} 个）"


def check_db_methods():
    """db.js 实现了与命令同名的方法。"""
    src = (APP / "lib" / "db.js").read_text(encoding="utf-8")
    missing = [name for name in EXPECTED_COMMANDS if not re.search(rf"\b{name}\s*\(", src)]
    if missing:
        raise Failure("db.js 缺少方法：" + "、".join(sorted(missing)))
    return f"db.js 实现了全部 {len(EXPECTED_COMMANDS)} 个命令对应方法"


def check_assets():
    """前端文件存在，且被 index.html 引用。"""
    missing = [rel for rel in EXPECTED_ASSETS if not (ROOT / rel).is_file()]
    if missing:
        raise Failure("缺少文件：" + "、".join(missing))

    index = (APP / "public/index.html").read_text(encoding="utf-8")
    referenced = set(re.findall(r'(?:href|src)="(/[^"]+)"', index))
    # server.js 允许访问 public/ 下的文件，以及项目根目录的图片素材
    root_assets = {"desk.png", "kitten.png"}
    problems = []
    for ref in sorted(referenced):
        name = ref.lstrip("/")
        in_public = (APP / "public" / name).is_file()
        in_root = name in root_assets and (ROOT / name).is_file()
        if not (in_public or in_root):
            problems.append(f"index.html 引用了不存在的 {ref}")
    if problems:
        raise Failure("；".join(problems))
    return f"{len(EXPECTED_ASSETS)} 个必需文件在，index.html 的 {len(referenced)} 个引用都有效"


def check_module_wiring():
    """app.js 里 import 的本地模块都存在，且导出的名字对得上。"""
    app_js = (APP / "public" / "js" / "app.js").read_text(encoding="utf-8")
    imports = re.findall(
        r"import\s*\{([^}]+)\}\s*from\s*'\./([a-zA-Z0-9_.-]+\.js)'",
        app_js,
    )
    if not imports:
        raise Failure("app.js 里没有找到本地模块 import")

    problems = []
    checked = 0
    for names, module in imports:
        path = APP / "public" / "js" / module
        if not path.is_file():
            problems.append(f"import 了不存在的 {module}")
            continue
        src = path.read_text(encoding="utf-8")
        for raw in names.split(","):
            name = raw.strip().split(" as ")[0].strip()
            if not name:
                continue
            checked += 1
            # 模块里要有 export function/const/class 该名字
            pattern = rf"export\s+(?:async\s+)?(?:function|const|let|class)\s+{re.escape(name)}(?![\w$])"
            if not re.search(pattern, src):
                problems.append(f"{module} 没有导出 {name}")
    if problems:
        raise Failure("；".join(problems))
    return f"{len(imports)} 个模块、{checked} 个导入名全部对得上"


def check_no_secret():
    """仓库里不应出现明文密钥。"""
    patterns = [
        re.compile(r"sk-[A-Za-z0-9]{20,}"),
        re.compile(r"(?i)api[_-]?key\s*[:=]\s*['\"][^'\"]{12,}['\"]"),
    ]
    hits = []
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(ROOT)
        if any(part in {".git", "node_modules", "data", "shots"} for part in rel.parts):
            continue
        if path.suffix.lower() not in {".js", ".mjs", ".py", ".json", ".md", ".sql", ".html", ".css", ".cmd"}:
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for pattern in patterns:
            if pattern.search(text):
                hits.append(str(rel))
                break
    if hits:
        raise Failure("疑似明文密钥：" + "、".join(hits[:5]))
    return "未发现明文密钥"


CHECKS = (
    ("schema.files", check_schema_files),
    ("schema.tables", check_tables_and_columns),
    ("schema.foreign_keys", check_foreign_keys),
    ("schema.focus_single_open", check_focus_single_open),
    ("schema.block_kinds", check_block_kinds),
    ("api.routes", check_routes),
    ("api.commands", check_commands),
    ("db.methods", check_db_methods),
    ("ui.assets", check_assets),
    ("ui.module_wiring", check_module_wiring),
    ("security.no_secret", check_no_secret),
)


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    verbose = any(a in ("-v", "--verbose") for a in args)
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass

    print("学习工作台 · 契约验收（只读）")
    print(f"项目：{ROOT}")
    print()

    results = []
    for name, fn in CHECKS:
        try:
            detail = fn()
        except Failure as exc:
            results.append((name, False, str(exc)))
            print(f"[FAIL] {name}: {exc}")
        except Exception as exc:  # noqa: BLE001
            results.append((name, False, f"{type(exc).__name__}: {exc}"))
            print(f"[FAIL] {name}: {type(exc).__name__}: {exc}")
            if verbose:
                import traceback
                traceback.print_exc()
        else:
            results.append((name, True, detail))
            print(f"[PASS] {name}: {detail}")

    total = len(results)
    passed = sum(1 for _, ok, _ in results if ok)
    print()
    print("== 汇总 ==")
    print(f"检查项: {total}  通过: {passed}  失败: {total - passed}")
    if passed != total:
        print("失败项:")
        for name, ok, detail in results:
            if not ok:
                print(f"  - {name}: {detail}")
    print(f"结果: {'PASS' if passed == total else 'FAIL'}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
