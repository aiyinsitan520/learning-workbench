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

完成｜Claude｜app/server.js、app/public/js/app.js、app/test/server.test.js｜2026-11-21 10:50
根因：用户的 Chrome 窗口在多次改版前就打开，一直跑旧前端代码（停在 20 日、钟点按旧时区偏 8 小时）。
      点 10 点实际存成 20 日 18:45；DSH 的跨日翻页也要刷新后才生效。
修法：/api/health 增加 build（public/ 最新修改时间，加性字段）；app.js 每 30 秒及窗口回到前台时检查，
      build 变化且无对话框、无拖动、手记已保存时整页重载。以后改前端，开着的窗口会自动换新代码。
数据：经用户本意，「刷视频看手机」时间块改到 2026-11-21 10:00–10:30 北京时间（同 block id）。
      20 日另有两条重复的「准备科研论文」块（17:15、14:00）未动，待用户决定是否删除。
验收：verify\run_all.cmd full PASS（UI 36/36）；内置浏览器实测改前端文件后约 30 秒自动重载。

完成｜Claude｜app/public/js/dom.js、views.js、app.js、app/test/ui.test.mjs｜2026-11-21 11:30
根因：用户 Chrome 装了「Change Timezone for Google Chrome」扩展，篡改 Intl 的时区结果；
      页面用 Intl 把时间换成北京钟点，时间轴整体错开 8 小时，9:00/10:00 的块落在可见范围外，
      新加的块也存错日子（无痕窗口不加载扩展时显示正常，已截图核实）。
修法：dom.js 新增 learnZone/zoneWall：从服务视图（day + range.start）推出工作台时区偏移，
      clockOf、localToday 改用 UTC 运算，不再依赖浏览器 Intl；未取得视图前才回退 Intl。
验收：verify\run_all.cmd full PASS（仓储/服务 55/55，UI 37/37，新增「扩展篡改 Intl」用例）；
      用户真实 Chrome 窗口截图：9:00 准备科研论文、刷视频看手机均显示在左侧计划栏。
