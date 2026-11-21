# 契约与行为验收（只读）

`verify/` 是独立于 `app/` 的验收层：**不修改任何项目文件**，只读取它们并运行检查。
`app/` 正在被别人改动时也能随时跑，不会冲突。

## 跑

```powershell
python verify\check_contract.py     # 契约：schema / 路由 / 命令 / 静态资源
node verify\check_behavior.mjs      # 行为：真起服务 + 临时库跑一遍用户路径
verify\run_all.cmd                  # 两套一起跑
verify\watch.cmd                    # 盯着 app/ 的变化，每次改动自动跑契约检查
```

## 两套各管什么

`check_contract.py`（11 项，纯只读）

| 检查 | 内容 |
| --- | --- |
| `schema.files` | `architecture/*.sql` 都能被 SQLite 执行 |
| `schema.tables` | 表与必需列齐全 |
| `schema.foreign_keys` | 关键外键存在 |
| `schema.focus_single_open` | 全库最多一条 running/paused（行为验证） |
| `schema.block_kinds` | 五种块类型可写入，未知类型被拒 |
| `api.routes` | `server.js` 注册了全部必需路由 |
| `api.commands` | `execute()` 覆盖全部必需命令 |
| `db.methods` | `db.js` 实现了对应方法 |
| `ui.assets` | 前端文件存在，`index.html` 引用有效 |
| `ui.module_wiring` | `app.js` 里 import 的模块都存在，导出的名字对得上 |
| `security.no_secret` | 仓库里没有明文密钥 |

`check_behavior.mjs`（17 项，用系统临时目录里的库）

任务创建与幂等重试、改期不改任务数、外键拒绝、专注完整生命周期、
自由专注、版本冲突、完成与撤销、手记保存与换序、任务引用校验、
**任务正文（从版本 0 首存 / 经 `GET /api/task-note` 读回 / 过期版本冲突）**、月份汇总、导出、非法输入。

## 任务笔记的修复经过（2026-11-20）

`verify` 曾抓到 3 项失败，最终由维护 `app/` 的一方修好，方案是：

- 前端首次保存传 `revision: 0`（不是 `null`），`db.saveTaskNote` 保持严格校验不放松
- 新增独立接口 `GET /api/task-note?task=<id>` 读取任务正文，不塞进 `readDay` 视图

这套方案比"把 null 当 0 + 塞进视图"更干净，因此**没有采用** `verify/fix_tasknote.py`
里的备选补丁。该脚本现在会先检测，已修则直接退出，不会覆盖对方实现。

`verify/.backup/` 保留了当时的文件快照，可作历史参考。

## 设计取舍

- **不测内部实现**：只断言对外行为（HTTP 状态码、读回的数据），
  所以重构 `db.js` 内部不会误报。
- **不改项目**：临时库建在 `os.tmpdir()`，跑完就删。
- **失败时非零退出**，可以直接接进 CI 或提交前检查。
