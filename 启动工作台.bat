@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 Node.js 22 或更新版本后重新双击打开。
  echo 下载地址：https://nodejs.org/
  pause
  exit /b 1
)
node _system\scripts\control.mjs start
if errorlevel 1 (
  echo.
  echo 启动失败，请查看上方提示信息。
  pause
  exit /b 1
)
endlocal
