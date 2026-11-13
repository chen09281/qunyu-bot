@echo off
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel% equ 0 (
  py -3 kuro_token.py
) else (
  python kuro_token.py
)
pause
