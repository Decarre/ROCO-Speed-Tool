@echo off
cd /d "%~dp0"
where npm >nul 2>nul
if %errorlevel%==0 (
  npm start
) else (
  echo 未检测到 npm，改为用默认浏览器打开开发版页面。
  start "" "%~dp0index.html"
)
