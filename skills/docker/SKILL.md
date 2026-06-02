---
name: docker
description: >
  Operate Docker locally for dev work — containers, images, Compose stacks, and
  Docker Desktop lifecycle. Use when the user says "docker", "spin up a container",
  "what's running", "docker compose up/down", "build an image", "view logs",
  "exec into", "stop/remove a container", "free up docker space", "prune",
  "restart docker desktop", "is docker running", or any local Docker task.
argument-hint: "[ps | up | down | logs SERVICE | build | prune | desktop start|stop|status]"
allowed-tools: Bash(docker:*)
---

# Docker — local dev ops

Drive Docker from the terminal for everyday dev work: containers, images, Compose
stacks, Docker Desktop lifecycle, and cleanup. Everything is `docker …` (Compose is
`docker compose`, Desktop is `docker desktop`).

> **Scope:** local CLI ops only. This does **not** wire up Docker's MCP servers —
> Docker ships its own Claude Code plugin for that (`docker/claude-plugins` →
> `docker-mcp-toolkit`, or `docker mcp client connect claude-code`). Full command
> catalog, networks/volumes, and troubleshooting are in `reference.md`.

## First — is the daemon up?
```bash
docker info >/dev/null 2>&1 && echo "Docker running" || echo "Docker NOT running"
docker desktop status            # Docker Desktop state
docker desktop start             # start Desktop if it's down
```

## Containers
```bash
docker ps                        # running
docker ps -a                     # include stopped
docker run --rm -it IMAGE        # throwaway interactive container
docker logs -f NAME              # follow logs
docker exec -it NAME sh          # shell in (try bash if sh missing)
docker stop NAME && docker rm NAME
docker inspect NAME              # full config/state JSON
```

## Images
```bash
docker images                    # list
docker build -t NAME:TAG .       # build from ./Dockerfile
docker pull IMAGE:TAG
docker rmi IMAGE                 # remove
```

## Compose (multi-container stacks)
```bash
docker compose up -d             # start detached
docker compose ps                # stack status
docker compose logs -f SERVICE   # follow one service
docker compose down              # stop + remove (add -v to also drop volumes)
docker compose up -d --build SERVICE   # rebuild + restart one service
```

## Docker Desktop lifecycle (`docker desktop`)
```bash
docker desktop status | start | stop | restart
docker desktop update            # apply updates
docker desktop engine ls         # (Windows) list container engines
```

## Free up space (safe → aggressive)
```bash
docker system df                 # what's using space
docker container prune           # remove stopped containers
docker image prune               # remove dangling images
docker system prune              # stopped containers + dangling images + unused nets
docker system prune -a --volumes # AGGRESSIVE: also unused images + volumes
```
> Always warn before `prune -a --volumes` — it deletes unused images **and volumes** (data loss). Confirm with the user first.

## Common asks → command
| User says | Run |
|---|---|
| "what's running?" | `docker ps` |
| "bring up the stack" | `docker compose up -d` |
| "tear it down" | `docker compose down` |
| "show me X's logs" | `docker logs -f X` (or `docker compose logs -f X`) |
| "get me a shell in X" | `docker exec -it X sh` |
| "rebuild X" | `docker compose up -d --build X` |
| "docker's eating my disk" | `docker system df` → `docker system prune` |
| "is docker on?" | `docker info` / `docker desktop status` |

## Safety
- Confirm before anything destructive: `rm`, `rmi`, `down -v`, `system prune -a --volumes`. Name exactly what will be deleted.
- `docker desktop stop` halts all containers — confirm if the user has running work.
- Prefer `--rm` for one-off runs so they don't pile up.

## Sandboxes (run an agent in an isolated VM)
```bash
docker sandbox run claude .       # run claude in a throwaway VM, cwd as workspace
docker sandbox ls                 # list sandboxes
docker sandbox rm NAME            # remove one
```
`docker sandbox` runs a coding agent (claude/codex/copilot/gemini/cagent/shell) inside an isolated Linux VM. With no `ANTHROPIC_API_KEY` set, sandboxed `claude` uses OAuth (your subscription). Full lifecycle + gotchas in `reference.md`.

For the full reference (networks, volumes, buildx, contexts, exec/stats/inspect, sandboxes, and troubleshooting like port conflicts, a wedged daemon, and the Windows/WSL2 stuck-on-starting recovery), see `reference.md`.
