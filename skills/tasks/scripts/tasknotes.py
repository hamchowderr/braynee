#!/usr/bin/env python3
"""
TaskNotes API wrapper — create, complete, list, and query tasks.
API runs at http://127.0.0.1:8090 (Obsidian TaskNotes plugin).
"""

import sys
import json
import argparse
import urllib.request
import urllib.error
from datetime import date


BASE = "http://127.0.0.1:8090"


def api(method: str, path: str, body: dict | None = None) -> dict:
    url = f"{BASE}{path}"
    data = json.dumps(body).encode() if body else None
    headers = {"Content-Type": "application/json"}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read())
    except urllib.error.URLError as e:
        print(f"TaskNotes API not reachable at {BASE}", file=sys.stderr)
        print("Make sure Obsidian is running with the TaskNotes plugin enabled.", file=sys.stderr)
        sys.exit(1)


def cmd_list(args):
    params = []
    if getattr(args, "status", None):
        params.append(f"status={args.status}")
    if getattr(args, "project", None):
        params.append(f"project={args.project}")
    query = "?" + "&".join(params) if params else ""
    tasks = api("GET", f"/api/tasks{query}")

    if not tasks:
        print("No tasks found.")
        return

    print(f"\nTasks ({len(tasks)} found)\n")
    for task in tasks:
        status = task.get("status", "open")
        marker = "✓" if status == "done" else "○"
        title = task.get("title", "")
        project = task.get("project", "")
        due = task.get("due", "")
        proj_str = f"  [{project}]" if project else ""
        due_str = f"  due: {due}" if due else ""
        print(f"  {marker}  {title}{proj_str}{due_str}")
        print(f"     id: {task.get('id', '')}")
        print()


def cmd_create(args):
    body = {"title": args.title}
    if getattr(args, "project", None):
        body["project"] = args.project
    if getattr(args, "due", None):
        body["due"] = args.due
    if getattr(args, "priority", None):
        body["priority"] = args.priority

    task = api("POST", "/api/tasks", body)
    print(f"Created: {task.get('title', args.title)}")
    print(f"ID: {task.get('id', '')}")


def cmd_complete(args):
    task_id = args.id
    result = api("PATCH", f"/api/tasks/{task_id}", {"status": "done"})
    print(f"Completed: {result.get('title', task_id)}")


def cmd_get(args):
    task = api("GET", f"/api/tasks/{args.id}")
    print(json.dumps(task, indent=2))


def cmd_update(args):
    body = {}
    if getattr(args, "title", None):
        body["title"] = args.title
    if getattr(args, "status", None):
        body["status"] = args.status
    if getattr(args, "due", None):
        body["due"] = args.due
    if getattr(args, "project", None):
        body["project"] = args.project
    if not body:
        print("No fields to update.", file=sys.stderr)
        sys.exit(1)

    result = api("PATCH", f"/api/tasks/{args.id}", body)
    print(f"Updated: {result.get('title', args.id)}")


def cmd_search(args):
    results = api("GET", f"/api/tasks/search?q={urllib.parse.quote(args.query)}")
    if not results:
        print("No matching tasks.")
        return
    print(f"\nSearch: {args.query}  ({len(results)} found)\n")
    for task in results:
        status = "✓" if task.get("status") == "done" else "○"
        print(f"  {status}  {task.get('title', '')}  [{task.get('id', '')}]")


def main():
    parser = argparse.ArgumentParser(description="TaskNotes task management")
    sub = parser.add_subparsers(dest="cmd")

    p_list = sub.add_parser("list")
    p_list.add_argument("--status", default="open", choices=["open", "done", "all"])
    p_list.add_argument("--project")

    p_create = sub.add_parser("create")
    p_create.add_argument("title")
    p_create.add_argument("--project")
    p_create.add_argument("--due")
    p_create.add_argument("--priority", choices=["low", "medium", "high"])

    p_complete = sub.add_parser("complete")
    p_complete.add_argument("id")

    p_get = sub.add_parser("get")
    p_get.add_argument("id")

    p_update = sub.add_parser("update")
    p_update.add_argument("id")
    p_update.add_argument("--title")
    p_update.add_argument("--status")
    p_update.add_argument("--due")
    p_update.add_argument("--project")

    p_search = sub.add_parser("search")
    p_search.add_argument("query")

    args = parser.parse_args()

    if args.cmd == "list":
        cmd_list(args)
    elif args.cmd == "create":
        cmd_create(args)
    elif args.cmd == "complete":
        cmd_complete(args)
    elif args.cmd == "get":
        cmd_get(args)
    elif args.cmd == "update":
        cmd_update(args)
    elif args.cmd == "search":
        cmd_search(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    import urllib.parse
    main()
