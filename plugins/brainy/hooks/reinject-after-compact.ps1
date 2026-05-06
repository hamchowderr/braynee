# reinject-after-compact.ps1
# Hook: Re-injects critical context after auto-compaction
# Runs on SessionStart with "compact" matcher
# Reads dynamic snapshot from pre-compact-snapshot.js if available
# Stdout is added to Claude's context
#
# v2 changes:
# - Reads active session note CONTENT and injects it (Goal, Decisions, Progress, Blockers)
# - This is the key fix: after compaction, Claude knows what it decided and where it left off

# Read and discard stdin
$null = [Console]::In.ReadToEnd()

# Static reminders that always apply
Write-Output @"
REMINDERS AFTER COMPACTION:
- Windows machine. No tar from Git Bash.
- NEVER push to main/master. Always feature branch + PR.
- Do ONLY what was explicitly asked. Don't expand scope.
- For API/CLI/SDK integration: check latest docs via WebFetch FIRST.
- Destructive commands (rm -rf, git reset --hard, DROP TABLE, etc.): explain and confirm before executing.
- curl requests: follow logical API order (auth -> parent resource -> child resource -> verify).
- Check for existing skills/plugins before building from scratch.
- Show diffs and wait for approval after each fix.
- When working on tasks: use tasknotes.mjs to track progress (list, create, complete).
- Keep updating the active session note (Decisions, Progress, Blockers) as you work.
"@

# Dynamic snapshot from PreCompact hook
$snapshotPath = Join-Path $env:USERPROFILE ".claude\compact-snapshot.json"
if (Test-Path $snapshotPath) {
    try {
        $snapshot = Get-Content $snapshotPath -Raw | ConvertFrom-Json -ErrorAction Stop
        $age = (Get-Date) - [DateTime]::Parse($snapshot.timestamp)

        # Only use snapshot if it's less than 30 minutes old (same session)
        if ($age.TotalMinutes -lt 30) {
            Write-Output ""
            Write-Output "=== SESSION STATE (restored after compaction) ==="

            if ($snapshot.projectName) {
                Write-Output "Project: $($snapshot.projectName)"
            }
            if ($snapshot.branch) {
                Write-Output "Branch: $($snapshot.branch)"
            }

            # ─── KEY FIX: Read and inject the active session note content ───
            if ($snapshot.sessionNotePath -and (Test-Path $snapshot.sessionNotePath)) {
                $noteContent = Get-Content $snapshot.sessionNotePath -Raw -ErrorAction Stop
                Write-Output ""
                Write-Output "── ACTIVE SESSION: $($snapshot.sessionNoteFilename) ──"

                # Extract each meaningful section from the session note
                $sections = @('Goal', 'Decisions', 'Progress', 'Blockers', 'Context')
                foreach ($section in $sections) {
                    # Match ## Section through to next ## or end of file
                    if ($noteContent -match "(?ms)## $section\s*\n(.*?)(?=\n## |\z)") {
                        $body = $matches[1].Trim()
                        # Skip placeholder content
                        if ($body -and $body -notmatch '^\(none|^\(waiting|^\(session just') {
                            Write-Output ""
                            Write-Output "[$section]"
                            # Cap at 15 lines per section
                            $bodyLines = $body -split "`n"
                            if ($bodyLines.Count -gt 15) {
                                $bodyLines[0..14] | ForEach-Object { Write-Output $_ }
                                Write-Output "  ... (truncated)"
                            } else {
                                $bodyLines | ForEach-Object { Write-Output $_ }
                            }
                        }
                    }
                }

                Write-Output ""
                Write-Output "Session file: 2. Areas/Sessions/$($snapshot.sessionNoteFilename)"
                Write-Output "── END SESSION NOTE ──"
            } elseif ($snapshot.sessionNoteFilename) {
                Write-Output "Active session: $($snapshot.sessionNoteFilename) (file not found)"
            }

            # Active timers
            if ($snapshot.activeTimers -and $snapshot.activeTimers.Count -gt 0) {
                Write-Output ""
                Write-Output "Active timers:"
                foreach ($timer in $snapshot.activeTimers) {
                    Write-Output "  - $($timer.taskTitle) (ID: $($timer.taskId), $($timer.elapsed)m elapsed)"
                }
            }

            # In-progress tasks
            if ($snapshot.inProgressTasks -and $snapshot.inProgressTasks.Count -gt 0) {
                Write-Output ""
                Write-Output "In-progress tasks:"
                foreach ($task in $snapshot.inProgressTasks) {
                    Write-Output "  - $($task.title) (ID: $($task.id))"
                }
            }

            # Vault project context (if primed at session start)
            if ($snapshot.vaultContext -and $snapshot.vaultContextProject) {
                Write-Output ""
                Write-Output "=== VAULT CONTEXT ($($snapshot.vaultContextProject)) ==="
                Write-Output $snapshot.vaultContext
                Write-Output "=== END VAULT CONTEXT ==="
            }

            Write-Output "=== END SESSION STATE ==="
        }
    }
    catch {
        # Snapshot parse failed, skip — static reminders still apply
    }
}

exit 0
