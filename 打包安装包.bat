@echo off
cd /d "%~dp0"
where npm >nul 2>nul
if not %errorlevel%==0 (
  echo 未检测到 npm。请先安装 Node.js LTS，然后重新运行本脚本。
  pause
  exit /b 1
)
if not exist node_modules (
  echo 正在安装打包依赖...
  npm install
  if not %errorlevel%==0 (
    pause
    exit /b %errorlevel%
  )
)
echo 正在生成 Windows 安装包...
npm run dist
pause
