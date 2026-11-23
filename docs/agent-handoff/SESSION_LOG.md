## 2026-11-21 09:45 · DSH

修跨午夜不翻页：`app/public/js/app.js` 加 `checkDayRollover()`，tick 每 5 秒按 Asia/Shanghai 检查是否跨日，
停在"上次的今天"时自动翻页；`userPinnedDate` 与未保存手记时不抢视图。
验收：`verify\run_all.cmd` PASS；`verify\run_all.cmd full` PASS（UI 36/36）。提交 4a65bfe。
遗留：无。

2026-11-22｜Codex｜新增 desktop/、桌面发布 workflow、README 与五张演示图库。三平台构建与启动检查通过，full 68+58 全过。Mac 未公证，Windows 未商业签名；后续版本在 desktop/build.py 更新版本号，再从已验收提交打标签。

2026-11-23｜Claude｜桌面版自动更新（参考贾维喵管家的签名更新流程）：/api/update、左下角版本号与「软件更新」对话框、Ed25519 签名清单、Windows 换文件夹重启、Mac 打开 DMG；顺带修了带参数启动桌面版崩溃。full PASS（17、83、61），本机 1.1.0→1.1.1 真实升级演练通过。待用户：生成签名密钥并设 secret、打 v1.1.0 标签。下一位从 NEXT_TASKS.md 末条「待用户」继续。
2026-11-23｜Claude｜生成更新签名密钥（公钥入源码，私钥在本机用户目录，secret UPDATE_SIGNING_KEY 已设）。签名自检与快速验收通过。下一步：推送并打 v1.1.0 标签。

2026-11-23｜Claude｜推送 main 至 1d27510，发布 v1.1.0（Actions 45141447534：三平台打包与 release 全部 success）。公开 latest.json 验签通过，三平台包大小与 SHA-256 和 GitHub digest 一致；7321 源码版实际检查结果为 latest。NEXT_TASKS.md 正由 T-H1 会话修改，本条未写入，待其提交后补记。
