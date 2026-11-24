@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，无法停止工作台。
  pause
  exit /b 1
)
node _system\scripts\control.mjs stop
if errorlevel 1 (
  echo.
  echo 停止失败，请查看上方提示信息。
  pause
  exit /b 1
)
timeout /t 2 >nul
endlocal
