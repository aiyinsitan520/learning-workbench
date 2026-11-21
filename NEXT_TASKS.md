# 工单与进度

## 2026-11-21

工单：修复跨午夜后日计划不翻页，导致新加的块看不到
可改文件：app/public/js/app.js
不许动：tokens.css、schema、db.js 签名、server.js 路由
完成标准：页面跨过北京时间午夜后自动切到新的一天，新加的块立即可见；verify\run_all.cmd 通过

完成｜DSH｜app/public/js/app.js｜2026-11-21 09:45
根因：页面从昨天一直开着，tick() 只处理计时器，从不检查日期是否跨日。
      用户在北京时间 20 日打开页面，21 日凌晨点 9:00 加了块，数据正确存进 21 日，
      但页面仍停在 20 日，所以看不到（数据没丢）。
修法：tick() 每 5 秒调 checkDayRollover()，用工作台时区（Asia/Shanghai）算今天；
      跨日且页面停在"上次的今天"时自动翻页。用户手动切到别的日期（userPinnedDate）
      或手记有未保存草稿时不抢视图，点「今天」恢复跟随。
验收：verify\run_all.cmd PASS；verify\run_all.cmd full PASS（UI 36/36，含跨时区分日用例）
