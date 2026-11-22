## 2026-11-21 09:45 · DSH

修跨午夜不翻页：`app/public/js/app.js` 加 `checkDayRollover()`，tick 每 5 秒按 Asia/Shanghai 检查是否跨日，
停在"上次的今天"时自动翻页；`userPinnedDate` 与未保存手记时不抢视图。
验收：`verify\run_all.cmd` PASS；`verify\run_all.cmd full` PASS（UI 36/36）。提交 4a65bfe。
遗留：无。

2026-11-22｜Codex｜新增 desktop/、桌面发布 workflow、README 与五张演示图库。三平台构建与启动检查通过，full 68+58 全过。Mac 未公证，Windows 未商业签名；后续版本在 desktop/build.py 更新版本号，再从已验收提交打标签。
