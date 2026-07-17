# AI Agent Status Hooks

Surfisle can mirror Codex, Claude Code, and OpenCode task activity on the collapsed island status light:

- running task: red
- completed, idle, or no task: green
- failed task, or a running marker older than 10 minutes without a stop event: yellow

Do not use process or CPU detection for this integration. Agent processes can stay alive while idle. The reliable path is to wire into lifecycle hooks and OpenCode session events.

## User Setup

For release users and source builds, use the in-app installer:

1. Open Surfisle.
2. Expand the island and open Settings.
3. In **AI Agent 状态灯**, click **安装/修复**.
4. Restart Codex, OpenCode, and any VSCode terminal running Claude Code.
5. For Codex, review and trust the new hooks when Codex prompts you, or use `/hooks`.

The installer writes the hook scripts to the current user's app data directory:

```text
%APPDATA%\com.ryancy.surfisle\
```

It then updates:

```text
%USERPROFILE%\.codex\config.toml
%USERPROFILE%\.claude\settings.json
%USERPROFILE%\.config\opencode\plugins\surfisle-status.js
```

The operation is repeatable. Running **安装/修复** again rewrites Surfisle's managed hooks to the current app-data script path and removes older managed hook entries.

## Runtime Contract

Prompt submission uses a fast marker file instead of PowerShell JSON work:

```text
agent-codex-running.flag
agent-claudeCode-running.flag
agent-opencode-running.flag
```

Surfisle polls these marker files every 200ms. If either marker exists and is fresh, the island turns red. If a marker is still present after 10 minutes, Surfisle treats it as stale and turns the island yellow instead of leaving the user waiting on a permanent red light.

When the turn finishes, `surfisle-agent-status.ps1` removes the marker, writes `agent-status.json`, and keeps a short hold marker when the task completed too quickly. This makes very short prompts still visibly flash red for about 800ms.

`agent-status.json` uses this shape:

```json
{
  "codex": {
    "phase": "running",
    "taskId": "optional-id",
    "updatedAt": 1783584000000
  },
  "claudeCode": {
    "phase": "completed",
    "taskId": "optional-id",
    "updatedAt": 1783584000000
  },
  "opencode": {
    "phase": "completed",
    "taskId": "optional-id",
    "updatedAt": 1783584000000
  },
  "updatedAt": 1783584000000
}
```

`phase === "running"` turns the light red. `phase === "failed"` turns the light yellow. Missing files, invalid JSON, missing fields, unknown phases, `idle`, and `completed` are treated as green states. A derived `stale` phase is returned by the app when a running marker remains for more than 10 minutes without a later status update.

## Manual Smoke Test

After using the in-app installer, run these commands with the app-data scripts:

```powershell
$dir = Join-Path $env:APPDATA 'com.ryancy.surfisle'
& "$dir\surfisle-agent-running.cmd" codex
powershell -NoProfile -ExecutionPolicy Bypass -File "$dir\surfisle-agent-status.ps1" codex completed

& "$dir\surfisle-agent-running.cmd" claudeCode
powershell -NoProfile -ExecutionPolicy Bypass -File "$dir\surfisle-agent-status.ps1" claudeCode completed

powershell -NoProfile -ExecutionPolicy Bypass -File "$dir\surfisle-agent-status.ps1" claudeCode failed

& "$dir\surfisle-agent-running.cmd" opencode
powershell -NoProfile -ExecutionPolicy Bypass -File "$dir\surfisle-agent-status.ps1" opencode completed
```

Expected behavior:

- The island turns red after the `surfisle-agent-running.cmd` command.
- The island returns green after the `surfisle-agent-status.ps1 ... completed` command.
- The island turns yellow after the `surfisle-agent-status.ps1 ... failed` command and returns green after clearing that status from the app.

## Notes For Manual Configuration

Manual configuration is usually unnecessary. Prefer the in-app installer because it uses the user's actual app-data path and handles Claude Code's Windows command behavior.

If you do edit Claude Code hooks manually on Windows, prefer Claude Code's exec form: put `cmd.exe` or `powershell.exe` in `command` and pass every argument through `args`. This avoids shell-selection differences between VSCode, Git Bash, PowerShell, and `cmd.exe`.
