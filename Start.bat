@echo off
chcp 65001 >nul
title QuickLaunch - 快速启动
cd /d "%~dp0"
set "PYTHONIOENCODING=utf-8"
set "PY="

if exist "D:\Program Files\Python312\python.exe" set "PY=D:\Program Files\Python312\python.exe"
if not defined PY for /f "delims=" %%i in ('where python 2^>nul') do if not defined PY set "PY=%%i"
if not defined PY for /f "delims=" %%i in ('where python3 2^>nul') do if not defined PY set "PY=%%i"

if not defined PY (
  echo.
  echo   [x] 未找到 Python。请安装 Python 3.8+ 并勾选 Add to PATH。
  echo.
  pause
  exit /b 1
)

echo   解释器: %PY%
"%PY%" "%~dp0launcher.py" %*
echo.
pause
