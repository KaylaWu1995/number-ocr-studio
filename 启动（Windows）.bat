@echo off
chcp 65001 >nul
title 号码整理工具 - 服务窗口（关闭本窗口即退出）
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没有检测到 Node.js。
  echo   请先到 https://nodejs.org/ 下载安装 LTS 版本，然后重新双击本文件。
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动号码整理工具，浏览器会自动打开……
echo   首次使用请点右上角「设置」，填入通义千问 API Key。
echo.
node server.js --open
pause
