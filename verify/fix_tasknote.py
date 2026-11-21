#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为 tasknote 的两个已知 bug 生成/应用补丁（默认只预览）。

用法：
    python verify/fix_tasknote.py            # 预览 diff，不写文件
    python verify/fix_tasknote.py --apply    # 实际应用
    python verify/fix_tasknote.py --revert   # 从备份恢复

背景：`app/` 由另一方维护。本脚本把改动集中在一处、可预览可回滚，
避免手改分散在多处。应用后请跑 `node verify/check_behavior.mjs` 验证。

注意：2026-11-20 17:37，`app/` 侧已自行用另一种方式修好了这两个 bug
（新增独立的任务正文接口，而不是塞进 readDay 视图）。脚本现在会先检测，
已修则直接退出，不会覆盖对方的实现。仅在确认对方未修时才用 --apply。
"""

from __future__ import annotations

import argparse
import difflib
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "app" / "lib" / "db.js"
BACKUP_DIR = ROOT / "verify" / ".backup"


def patch_expected_revision(text: str) -> tuple[str, bool]:
    """首次保存时 expectedRevision 允许为 null（视为 0）。"""
    old = "    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw invalid('正文版本不合法');"
    new = (
        "    // 首次保存时前端传 null：视为版本 0，与 readTaskNote 的空记录对齐。\n"
        "    const expected = expectedRevision == null ? 0 : expectedRevision;\n"
        "    if (!Number.isInteger(expected) || expected < 0) throw invalid('正文版本不合法');"
    )
    if old not in text:
        return text, False
    text = text.replace(old, new, 1)
    text = text.replace(
        "      if (current.revision !== expectedRevision) throw conflict('此任务的正文已在另一窗口更新');",
        "      if (current.revision !== expected) throw conflict('此任务的正文已在另一窗口更新');",
        1,
    )
    return text, True


def patch_view_task_note(text: str) -> tuple[str, bool]:
    """把 task_notes 拼进 readDay 的视图。"""
    marker = "      focusSummary: { finishedSessions: Number(summary.sessions), elapsedSeconds: Number(summary.seconds) },"
    if marker not in text:
        return text, False
    # 找到 readDay 的返回块起点，插入 taskNote 字段
    idx = text.find(marker)
    insert_at = text.rfind("    return {", 0, idx)
    if insert_at < 0:
        return text, False
    addition = (
        "      // 任务正文：前端用 preferredTaskId 回显当前任务的笔记\n"
        "      taskNote: preferredTaskId\n"
        "        ? { taskId: preferredTaskId, ...this.readTaskNote(preferredTaskId) }\n"
        "        : null,\n"
    )
    if "taskNote:" in text[insert_at:idx]:
        return text, False
    text = text[:idx] + addition + text[idx:]
    return text, True


def patch_readday_signature(text: str) -> tuple[str, bool]:
    """readDay 接受 preferredTaskId，用于回显当前任务笔记。"""
    old = "  readDay(day, timeZone = this.timeZone) {"
    new = "  readDay(day, timeZone = this.timeZone, preferredTaskId = null) {"
    if old not in text:
        return text, False
    return text.replace(old, new, 1), True


def patch_server_passthrough(text: str) -> tuple[str, bool]:
    """server.js 把 prefer 参数传给 readDay。"""
    old = "        const view = wb.readDay(day, tz);"
    new = "        const view = wb.readDay(day, tz, url.searchParams.get('prefer') || null);"
    path = ROOT / "app" / "server.js"
    src = path.read_text(encoding="utf-8")
    if old not in src:
        return text, False
    return text, True  # 由调用方处理 server.js


def already_fixed() -> bool:
    """app/ 侧是否已经自行修好（用独立的正文接口，不走 readDay）。"""
    db_src = (ROOT / "app" / "lib" / "db.js").read_text(encoding="utf-8")
    server_src = (ROOT / "app" / "server.js").read_text(encoding="utf-8")
    # 任一迹象成立就认为已修
    signs = [
        "expectedRevision == null" in db_src,
        "expectedRevision ?? 0" in db_src,
        "task-note" in server_src or "tasknote" in server_src.lower().replace("savetasknote", ""),
        "/api/task-note" in server_src,
    ]
    return any(signs)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="实际写入")
    parser.add_argument("--revert", action="store_true", help="从备份恢复")
    args = parser.parse_args()

    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass

    if not DB.is_file():
        print(f"[FAIL] 找不到 {DB}")
        return 2

    if already_fixed() and not args.revert:
        print("app/ 侧已经修好了，本脚本无需再改。")
        print("（如果仍要强制套用旧补丁，请先手动确认会覆盖什么。）")
        return 0

    if args.revert:
        stamps = sorted(BACKUP_DIR.glob("db.js.*")) if BACKUP_DIR.is_dir() else []
        if not stamps:
            print("[FAIL] 没有备份可恢复")
            return 2
        latest = stamps[-1]
        shutil.copy2(latest, DB)
        print(f"已从 {latest.name} 恢复 db.js")
        return 0

    original = DB.read_text(encoding="utf-8")
    patched = original
    applied = []

    patched, ok1 = patch_expected_revision(patched)
    if ok1:
        applied.append("saveTaskNote：null 视为版本 0")
    patched, ok2 = patch_readday_signature(patched)
    if ok2:
        applied.append("readDay：接受 preferredTaskId")
    patched, ok3 = patch_view_task_note(patched)
    if ok3:
        applied.append("readDay：视图返回 taskNote")

    server = ROOT / "app" / "server.js"
    server_src = server.read_text(encoding="utf-8")
    server_old = "        const view = wb.readDay(day, tz);"
    server_new = "        const view = wb.readDay(day, tz, url.searchParams.get('prefer') || null);"
    server_ok = server_old in server_src

    if not applied and not server_ok:
        print("没有需要应用的改动（可能已修好）。")
        return 0

    print("将应用以下改动：")
    for item in applied:
        print(f"  - {item}")
    if server_ok:
        print("  - server.js：把 prefer 参数传给 readDay")
    print()

    diff = difflib.unified_diff(
        original.splitlines(keepends=True),
        patched.splitlines(keepends=True),
        fromfile="app/lib/db.js (当前)",
        tofile="app/lib/db.js (修改后)",
    )
    sys.stdout.writelines(diff)
    if server_ok:
        print()
        sdiff = difflib.unified_diff(
            server_src.splitlines(keepends=True),
            server_src.replace(server_old, server_new, 1).splitlines(keepends=True),
            fromfile="app/server.js (当前)",
            tofile="app/server.js (修改后)",
        )
        sys.stdout.writelines(sdiff)

    if not args.apply:
        print()
        print("（预览模式，未写入。加 --apply 才会改文件。）")
        return 0

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    shutil.copy2(DB, BACKUP_DIR / f"db.js.{stamp}")
    DB.write_text(patched, encoding="utf-8")
    if server_ok:
        shutil.copy2(server, BACKUP_DIR / f"server.js.{stamp}")
        server.write_text(server_src.replace(server_old, server_new, 1), encoding="utf-8")
    print()
    print(f"已应用。备份在 {BACKUP_DIR}")
    print("下一步：node verify/check_behavior.mjs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
