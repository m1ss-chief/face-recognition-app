@echo off
REM Start the app. Works fully offline. Opens http://127.0.0.1:8000 in your browser.
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo Please run setup.bat first.
  pause
  exit /b 1
)
.venv\Scripts\python -m app.main %*
pause
