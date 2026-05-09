@echo off
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel%==0 (
  echo 正在自动更新精灵数据库...
  node scripts\update-db.js
) else (
  echo 未检测到 Node.js，跳过自动更新。
)
start "" "%~dp0index.html"
