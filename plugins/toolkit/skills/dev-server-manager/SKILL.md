---
name: dev-server-manager
description: >-
  Manage local dev servers and clean up zombie (orphaned) Node processes. Use
  when a dev server won't start, a port is already in use (EADDRINUSE), Mastra
  Studio or an agent errors on click, Postgres reports too_many_connections
  (SQLSTATE 53300), MASTRA_STORAGE_PG_CREATE_TABLE_FAILED, mastra dev hangs at
  "Starting Mastra dev server...", or after several restarts things get flaky.
  Lists the FULL process tree for a project (not just the port listener), kills
  strays cleanly, frees ports, checks DB connections, and does a clean
  single-server restart. Windows-first (PowerShell); bash equivalents at the end.
---

# Dev Server Manager

Zombie dev-server processes are the #1 cause of "it won't start", "port in use",
"agents error in Studio", and "too_many_connections". `npm run dev` does not
start one process — it starts a **tree**: `concurrently` → `next dev` (which
spawns worker processes) + `mastra dev`, etc. Killing only the process that
*listens on the port* leaves the **children alive**, still holding ports and
**database connection pools**. After a few restarts they pile up (each Mastra
runtime can hold 10–60+ Postgres connections) and exhaust limits → everything
breaks.

## Golden rule

**Never kill by port alone.** Kill the whole project process tree by
command-line match, verify it's gone, *then* start exactly ONE server.

`$Project` below = a unique substring of the project's path (e.g. `my-app`).

## 1. See what's actually running (the real picture)

```powershell
$Project = 'my-app'   # substring of the repo path
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match $Project } |
  Select-Object ProcessId,
    @{n='start';e={$_.CreationDate}},
    @{n='cmd';e={ $_.CommandLine.Substring(0,[Math]::Min(80,$_.CommandLine.Length)) }} |
  Sort-Object start | Format-Table -AutoSize
```

Multiple "generations" (different start times) = zombies from past restarts.

## 2. Kill the project's stray dev processes (parent + children)

```powershell
$Project = 'my-app'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match $Project -and
    ($_.CommandLine -match 'next|mastra|concurrently|cross-env|vite|\.output') } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; "killed $($_.ProcessId)" }
Start-Sleep -Seconds 2
"remaining: $((Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match $Project } | Measure-Object).Count)"
```

Want a full reset? Drop the `next|mastra|...` clause to kill EVERY node process
for the project. Do NOT kill all `node.exe` globally — that takes down Claude
Code, MCP servers, and other projects.

## 3. Check / free ports

```powershell
foreach ($p in 3000,4111,54321,54322) {
  $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { $proc = (Get-Process -Id $c.OwningProcess -EA SilentlyContinue).ProcessName
            "port $p : PID $($c.OwningProcess) ($proc)" } else { "port $p : free" }
}
```

To free one port: `Stop-Process -Id <PID> -Force`.

## 4. Check Postgres connections (Supabase local / any pg)

`too_many_connections` (53300) means orphaned pools haven't released. Healthy
baseline for an idle Supabase local stack is ~30/100.

```powershell
# uses the project's SUPABASE_DB_URL (or pass any pg connection string)
@'
const { Client } = require("pg");
(async () => { const c = new Client({ connectionString: process.env.SUPABASE_DB_URL }); await c.connect();
  const r = await c.query("select count(*)::int n,(select setting::int from pg_settings where name='max_connections') m from pg_stat_activity");
  console.log("connections:", r.rows[0].n, "/", r.rows[0].m);
  await c.end(); })().catch(e => console.log("ERR", e.message));
'@ | Set-Content -Encoding utf8 _conn.cjs
node --env-file-if-exists=.env --env-file-if-exists=.env.local _conn.cjs; Remove-Item _conn.cjs
```

If it stays high after killing project node, restart the DB stack:
`npx supabase stop; npx supabase start` (does NOT re-run migrations).

## 5. Clean restart (the safe sequence)

1. Kill the project process tree (step 2).
2. Confirm 0 remaining + ports free (steps 2–3).
3. Confirm connections near baseline (step 4) — if not, `supabase stop/start`.
4. Start ONE server: `npm run dev` (run it backgrounded so you keep the shell).
5. Wait for BOTH lines before testing: `Ready in …` (Next) and
   `Studio: http://localhost:4111` (Mastra). Mastra inits its Postgres store at
   boot, so it lands a few seconds after Next.

## Diagnosing specific errors

- **EADDRINUSE :::3000** — a previous server still holds the port. Step 2, then restart.
- **PG 53300 / too_many_connections / MASTRA_STORAGE_PG_CREATE_TABLE_FAILED** —
  orphaned connection pools. Step 2 (kill ALL project node), step 4 to confirm
  it dropped, then restart. Consider capping pool size (`max: N`) in the store config.
- **mastra dev hangs at "Starting Mastra dev server…"** — almost always
  connection pressure (above). It is not a Mastra/Windows bug; clean up and
  restart and it boots in seconds.
- **Agent errors only in Mastra Studio (not via API)** — Studio resolves each
  agent's dynamic `instructions` with placeholder context (e.g. `"<stage>"`).
  If an instructions function throws on an unexpected value, guard it (fall back
  to a default) — don't let it throw.

## Bash equivalents (Git Bash / WSL)

```bash
# list project node procs
wmic process where "name='node.exe'" get processid,commandline | grep my-app   # or: ps aux | grep my-app
# kill by port (single)
npx kill-port 3000 4111
# postgres connections
psql "$SUPABASE_DB_URL" -c "select count(*) from pg_stat_activity;"
```

Note: on Windows prefer PowerShell — Git Bash `Stop-Process` isn't available and
`taskkill` by PID works but doesn't match command lines as cleanly.
