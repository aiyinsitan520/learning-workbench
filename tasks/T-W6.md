工单 T-W6：网页端也能一键更新，更新体验人性化（两端统一）
tier：hard   risk：high（改用户的代码目录、重启服务）   执行：Codex xhigh   依赖：T-W1 已提交
先读：tasks/ROUND-2026-11-24.md、app/lib/updater.js、app/public/js/update.js、启动学习工作台.ps1、停止学习工作台.ps1

用户原话：「网页端也能直接一键更新，更新的时候你可以参考GitHub上面的项目，尽量做到人性化」

现状：updater.js 源码运行只能检查（「更新请 git pull」），桌面版可下载验签安装；GitHub 公开仓库 aiyinsitan520/learning-workbench，Release 带 Ed25519 签名清单。

可改文件：app/lib/updater.js、app/lib/source-update.js（新）、app/tools/restart-source.mjs（新）、app/server.js（/api/update 扩展、/api/restart）、app/public/js/update.js、app/public/app.css（更新对话框部分）、app/test/update.test.js、app/test/ui-update.test.mjs、app/README.md、README.md
不许动：update-config.js 的公钥、desktop/update-install.mjs 的安装流程（只可加性改提示）、启动/停止脚本（需要改就写「需要架构决定」）

参考做法（VS Code / GitHub Desktop / Obsidian 的共同点）：启动后与每 6 小时静默检查；有新版只在左下角版本号旁显示小圆点，不弹窗打断；对话框里显示版本号、发布日期、渲染后的更新说明；按钮「立即更新」「稍后提醒（明天）」「跳过此版本」；更新前自动备份数据；进度可见；失败可恢复并给出原因。

接口约定：
- 源码运行的一键更新（install.mode='source-git'）前置检查全部满足才可用，否则按钮禁用并逐条说明原因：仓库根是 git 仓库、当前分支 main、`git status --porcelain` 干净、origin 指向配置的仓库、目标标签 v<新版本> 存在且当前 HEAD 是它的祖先（只快进）。
- 步骤：T-W1 的数据备份 → `git fetch origin tag v<新版本>` → 校验标签对应提交的 app/version.json 等于新版本 → `git merge --ff-only v<新版本>` → 写结果文件 → 启动 `restart-source.mjs`（脱离进程：等旧服务退出、端口空出后按启动脚本同样方式拉起）→ 当前服务退出。全部用参数数组调用 git，不拼 shell 字符串。
- 页面显示「正在更新…」遮罩，轮询 /api/health 直到版本号变化后自动刷新；60 秒未恢复则显示手动恢复步骤（运行启动脚本；如需回到旧版 `git checkout v<旧版本>`）。**程序不自动执行任何破坏性 git 命令**（reset/clean/checkout -- . 都不许）。
- `POST /api/restart`：桌面版用 T-W1 注入的 restart；源码运行用 restart-source.mjs；返回 `{ restarting:true }`。T-W1b 的「立即重启」按钮依赖它。
- 实时：检查到新版后经 T-W1 的 /api/events 发 `event: update` `data:{"version":"x.y.z"}`，所有打开的页面都出小圆点。
- 「稍后提醒」「跳过此版本」记在 `<dataDir>/update-prefs.json`（两端共享），桌面版同样生效。
完成标准：用临时 git 仓库 + 本地假 Release 清单测试：前置检查每条失败原因、快进成功、非快进拒绝、脏工作区拒绝、跳过/稍后逻辑；UI 用例覆盖小圆点、对话框三按钮、更新遮罩；`verify\run_all.cmd full` 通过；不在真实仓库里跑更新。
