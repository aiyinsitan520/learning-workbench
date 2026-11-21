## 2026-11-21 09:45 · DSH

修跨午夜不翻页：`app/public/js/app.js` 加 `checkDayRollover()`，tick 每 5 秒按 Asia/Shanghai 检查是否跨日，
停在"上次的今天"时自动翻页；`userPinnedDate` 与未保存手记时不抢视图。
验收：`verify\run_all.cmd` PASS；`verify\run_all.cmd full` PASS（UI 36/36）。提交 4a65bfe。
遗留：无。
