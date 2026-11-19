@echo off
REM One-time setup: virtual environment, Python packages, face models.
REM This is the only step that needs internet.
cd /d "%~dp0"
where py >nul 2>nul && (set PY=py -3.11) || (set PY=python)
if not exist .venv (
  echo Creating virtual environment...
  %PY% -m venv .venv || goto :fail
)
echo Installing packages...
.venv\Scripts\python -m pip install --disable-pip-version-check -q -r requirements.txt || goto :fail
echo Downloading face models (one time, about 275 MB)...
.venv\Scripts\python scripts\download_models.py || goto :fail
echo.
echo Setup complete. Double-click run.bat to start the app.
pause
exit /b 0
:fail
echo.
echo Setup failed. See the message above.
pause
exit /b 1
