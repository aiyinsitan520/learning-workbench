@echo off
rem 学习工作台统一验收：任何 Agent 交付前都跑这一条。
rem   verify\run_all.cmd        快速：架构 + 契约 + 行为 + 仓储/服务（约 10 秒）
rem   verify\run_all.cmd full   完整：再加真浏览器 UI 测试（约 1–2 分钟，在临时目录运行，不覆盖 app\shots）
rem 所有检查只用临时库或内存库，不碰 app\data\workbench.db。
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
set "ROOT=%CD%"
set FAILED=

echo.
echo ===== Architecture (schema + reopen) =====
python architecture\check_schema.py || set FAILED=1
python architecture\check_reopen.py || set FAILED=1
echo.
echo ===== Contract check (read-only) =====
python verify\check_contract.py || set FAILED=1
echo.
echo ===== Behavior regression (temp db) =====
node verify\check_behavior.mjs || set FAILED=1
echo.
echo ===== Repository + server tests =====
node --test app\test\workbench.test.js app\test\server.test.js || set FAILED=1

if /i "%~1"=="full" (
  echo.
  echo ===== Browser UI tests ^(temp dir^) =====
  mkdir "%TEMP%\learning-space-ui-run" 2>nul
  pushd "%TEMP%\learning-space-ui-run"
  node --test "%ROOT%\app\test\ui.test.mjs" "%ROOT%\app\test\yesterday.test.mjs" || set FAILED=1
  popd
)

echo.
if defined FAILED (
  echo ===== RESULT: FAIL =====
  exit /b 1
)
echo ===== RESULT: PASS =====
exit /b 0
