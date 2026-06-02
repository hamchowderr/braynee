# Docker — full reference

Long-tail commands and troubleshooting. The common 80% lives in `SKILL.md`; load this for the rest.

## Inspect & observe
```bash
docker stats                       # live CPU/mem/net per container
docker inspect NAME                # full JSON (config, mounts, network, state)
docker inspect -f '{{.State.Status}}' NAME   # one field via Go template
docker top NAME                    # processes in a container
docker port NAME                   # published port mappings
docker events                      # live daemon event stream
docker version && docker info      # client/daemon versions + daemon config
```

## Networks
```bash
docker network ls
docker network create NET
docker network connect NET NAME
docker network inspect NET
docker run --network NET ...
docker network prune               # remove unused networks
```

## Volumes & data
```bash
docker volume ls
docker volume create VOL
docker volume inspect VOL
docker run -v VOL:/data ...        # named volume
docker run -v "$PWD":/app ...      # bind mount (host dir)
docker volume prune                # remove unused volumes (data loss — confirm)
docker cp NAME:/path ./local       # copy out of a container
docker cp ./local NAME:/path       # copy into a container
```

## Compose — advanced
```bash
docker compose up -d --scale SERVICE=3
docker compose exec SERVICE sh
docker compose run --rm SERVICE CMD     # one-off task container
docker compose restart SERVICE
docker compose config                   # render the merged, resolved config
docker compose -f compose.yaml -f compose.override.yaml up -d
docker compose pull                     # update images
docker compose stop / start             # without removing
```

## Build (buildx / BuildKit)
```bash
docker build -t NAME:TAG --build-arg KEY=VAL .
docker build --no-cache -t NAME:TAG .
docker buildx build --platform linux/amd64,linux/arm64 -t NAME:TAG --push .
docker buildx ls                        # builders
```

## Contexts (talk to remote/other daemons)
```bash
docker context ls
docker context use NAME
docker context create NAME --docker "host=ssh://user@host"
```

## Registry
```bash
docker login [REGISTRY]
docker tag LOCAL:TAG registry/repo:TAG
docker push registry/repo:TAG
```

## Troubleshooting

**Daemon not running / "cannot connect to the Docker daemon":**
```bash
docker desktop status
docker desktop start        # then wait until `docker info` succeeds
```

**Port already in use (bind: address already in use):**
```bash
docker ps --filter "publish=PORT"     # which container holds it
# or find the host process (Windows): netstat -ano | findstr :PORT
```
Stop the holder or change the host port mapping (`-p NEWHOST:CONTAINER`).

**Container won't start / exits immediately:**
```bash
docker logs NAME                 # last output
docker inspect -f '{{.State.ExitCode}} {{.State.Error}}' NAME
docker run --entrypoint sh -it IMAGE   # poke inside the image
```

**Out of disk / "no space left on device":**
```bash
docker system df                 # see usage by images/containers/volumes/cache
docker builder prune             # build cache is often the biggest offender
docker system prune -a           # remove all unused images (confirm)
```
> If `docker system df` itself errors with `failed to calculate image disk usage: lstat .../snapshots/<n>/fs: no such file or directory`, a containerd snapshot is dangling (common after an unclean shutdown). `docker builder prune` clears it; the engine is otherwise fine.

**Docker Desktop stuck on "starting" (Windows/WSL2) — the deep wedge:**
A tray **Quit + restart only cycles the UI**; the backend and WSL VM stay wedged, so it never recovers. Symptoms in `docker desktop logs`: `still waiting for init control API to respond`, `/ping ... context deadline exceeded`, `socketforwarder-receive-fds.sock: does not exist yet`. Recover in this exact order (PowerShell):
```powershell
# 1. Kill ALL Docker processes (not just the UI). LEAVE com.docker.service if it's running.
Get-Process "Docker Desktop","com.docker.backend","com.docker.build","docker","docker-sandbox" -EA SilentlyContinue | Stop-Process -Force
# 2. com.docker.service (the privileged Windows service) MUST be Running — it bootstraps dockerd
#    inside the VM. Starting it needs ELEVATION (admin); a non-elevated relaunch can't.
Get-Service com.docker.service            # if Stopped: Start-Service com.docker.service  (in an ADMIN shell)
# 3. Fully recycle the WSL2 VM. `wsl --terminate docker-desktop` only resets the distro init,
#    NOT the shared utility VM — use a full shutdown.
wsl --shutdown
# 4. Relaunch the backend LAST, so the engine injects with the service already up.
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
```
Confirm recovery: `wsl -d docker-desktop --exec /bin/sh -c "ls /run/guest-services/; ps -ef | grep dockerd"` should now show the sockets + a running `dockerd`, and `docker info` succeeds. **Ordering matters** — the engine only injects into the VM when `com.docker.service` is Running *before* the backend starts.

**Wedged container (won't stop):**
```bash
docker kill NAME                 # SIGKILL
docker rm -f NAME                # force remove
```

**Reset Docker Desktop (last resort):** stop Desktop, or use its UI "Troubleshoot → Clean / Purge data". Warn the user — this wipes all local images/containers/volumes.

## Sandboxes — run an agent in an isolated VM (`docker sandbox`)
`docker sandbox` spins up a throwaway Linux VM (separate kernel, not a container) and runs a coding agent inside it, mounting a host workspace. Agent templates: `claude`, `codex`, `copilot`, `gemini`, `docker-agent` (cagent), `shell`.
```bash
docker sandbox run claude .            # create + run claude in an isolated VM, cwd as workspace
docker sandbox run claude . /docs:ro   # extra workspace, read-only
docker sandbox create --name NAME shell WORKSPACE   # create without running (shell = no agent)
docker sandbox ls                      # list sandboxes
docker sandbox exec NAME -- CMD        # run a command inside a created sandbox
docker sandbox save NAME               # snapshot as a reusable template
docker sandbox stop NAME / rm NAME / reset   # stop / remove one / wipe all VM state
```
**Gotchas (verified against the installed plugin, v0.12.0):**
- **Flag order:** global flags like `--name` go *before* the agent subcommand — `create --name X shell .`, not `create shell --name X`.
- **`--` replaces, not appends:** args after `--` replace the agent's default command. The claude default is `claude --dangerously-skip-permissions`; to keep it, repeat it: `docker sandbox run claude -- --dangerously-skip-permissions -c`.
- **Config scope:** the sandbox reads only *project-level* config in the workspace; it ignores host `~/.claude` user settings.
- **Credentials = env vars.** This version has **no `secret` subcommand** and **no `--clone` flag** — those belong to the standalone **`sbx`** CLI in Docker's docs (https://docs.docker.com/ai/sandboxes/agents/), which is a *different* distribution. Don't promise them here.
- **OAuth-only for claude:** if **no** `ANTHROPIC_API_KEY` is in the environment, sandboxed `claude` falls back to interactive **OAuth** (uses your subscription, not API credits). Launch from a shell with the key unset to force this.

## Notes
- On Windows, run these in Git Bash or PowerShell; `docker`/`docker compose`/`docker desktop` are the same cross-platform.
- `docker-compose` (hyphen, v1) is legacy — use `docker compose` (v2 plugin).
- For programmatic control from code, use a language SDK (Node: `dockerode`; Python: `docker`; Go: Engine SDK / Compose SDK), not this skill.
