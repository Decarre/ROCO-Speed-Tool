@echo off
cd /d "%~dp0"
where node >nul 2>nul
if not %errorlevel%==0 (
  echo 未检测到 Node.js。请先安装 Node.js，或使用已有数据库。
  pause
  exit /b 1
)
node scripts\update-db.js
pause
