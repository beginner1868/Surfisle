@echo off
setlocal

set "PROVIDER=%~1"
if /I "%PROVIDER%"=="codex" (
  set "MARKER=agent-codex-running.flag"
  set "HOLD=agent-codex-running-hold.flag"
) else if /I "%PROVIDER%"=="claudeCode" (
  set "MARKER=agent-claudeCode-running.flag"
  set "HOLD=agent-claudeCode-running-hold.flag"
) else if /I "%PROVIDER%"=="opencode" (
  set "MARKER=agent-opencode-running.flag"
  set "HOLD=agent-opencode-running-hold.flag"
) else (
  exit /b 2
)

if defined SURFISLE_AGENT_STATUS_DIR (
  set "STATUS_DIR=%SURFISLE_AGENT_STATUS_DIR%"
) else (
  if defined APPDATA (
    set "STATUS_DIR=%APPDATA%\com.ryancy.surfisle"
  ) else (
    set "STATUS_DIR=%LOCALAPPDATA%\com.ryancy.surfisle"
  )
)

if not exist "%STATUS_DIR%" mkdir "%STATUS_DIR%" >nul 2>nul
break > "%STATUS_DIR%\%MARKER%"
del "%STATUS_DIR%\%HOLD%" >nul 2>nul

exit /b 0
