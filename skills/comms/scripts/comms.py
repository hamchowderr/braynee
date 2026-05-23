#!/usr/bin/env python3
"""
braynee comms — sync client communication history into Obsidian weekly rollups.

Reads the user's existing client + contact notes to discover channels (slack,
email), pulls messages for a given week, summarises each thread via `claude -p`,
and writes weekly + per-thread files to `2. Areas/Comms/<Client>/...`.

Nothing about specific clients, channel IDs, or email domains is hard-coded:
the skill discovers everything from frontmatter on existing vault notes.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys

# Force stdout/stderr to UTF-8 on Windows so emoji and accented names render
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Vault discovery
# ---------------------------------------------------------------------------

def find_vault() -> Path | None:
    """Resolve the Obsidian vault root.

    Priority: $BRAYNEE_VAULT > $OBSIDIAN_VAULT > common candidates that
    contain a `.obsidian` directory > fallback ~/Obsidian Vault. Mirrors
    scripts/lib/vault-root.js and skills/session-backfill so every entry
    point agrees on where the vault lives regardless of OS / sync provider.
    """
    for env_var in ("BRAYNEE_VAULT", "OBSIDIAN_VAULT"):
        val = os.environ.get(env_var)
        if val:
            p = Path(val).expanduser()
            if p.is_dir():
                return p

    home = Path.home()
    candidates = [
        home / "Obsidian Vault",
        home / "vault",
        home / "ObsidianVault",
        home / "Documents" / "Obsidian Vault",
        home / "Documents" / "vault",
        home / "OneDrive" / "Obsidian Vault",
        home / "iCloud Drive" / "Obsidian Vault",
    ]
    for c in candidates:
        if (c / ".obsidian").is_dir():
            return c
    fallback = home / "Obsidian Vault"
    return fallback if fallback.is_dir() else None


# ---------------------------------------------------------------------------
# YAML frontmatter parsing (good-enough; avoids pulling PyYAML)
# ---------------------------------------------------------------------------

def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Return (frontmatter_dict, body). Empty dict if no frontmatter."""
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---\n", 4)
    if end == -1:
        return {}, text
    raw = text[4:end]
    body = text[end + 5 :]
    return _parse_yaml_block(raw), body


def _parse_yaml_block(raw: str) -> dict[str, Any]:
    """Minimal YAML parser covering the shapes used in vault frontmatter:
    scalars, lists, nested dicts (one level), list-of-dicts (channels:)."""
    result: dict[str, Any] = {}
    lines = raw.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip() or line.lstrip().startswith("#"):
            i += 1
            continue
        # Top-level key:
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$", line)
        if not m:
            i += 1
            continue
        key, value = m.group(1), m.group(2).strip()
        if value:
            result[key] = _scalar(value)
            i += 1
            continue
        # Block value — peek ahead
        block_lines: list[str] = []
        i += 1
        while i < len(lines) and (lines[i].startswith("  ") or lines[i].startswith("\t") or not lines[i].strip()):
            block_lines.append(lines[i])
            i += 1
        # Inspect block: list-of-dicts (- key: ...), simple list (- value), nested dict (  key: value)
        non_blank = [b for b in block_lines if b.strip()]
        if not non_blank:
            result[key] = None
            continue
        first = non_blank[0].lstrip()
        if first.startswith("- "):
            # list — either of dicts or of scalars
            items: list[Any] = []
            current_dict: dict[str, Any] | None = None
            for b in block_lines:
                if not b.strip():
                    continue
                stripped = b.lstrip()
                indent = len(b) - len(stripped)
                if stripped.startswith("- "):
                    if current_dict is not None:
                        items.append(current_dict)
                        current_dict = None
                    rest = stripped[2:].strip()
                    if ":" in rest and not rest.endswith(":") and re.match(r"^[A-Za-z_]", rest):
                        # list-of-dicts row, first key:
                        k, v = rest.split(":", 1)
                        current_dict = {k.strip(): _scalar(v.strip())}
                    elif rest:
                        items.append(_scalar(rest))
                    else:
                        current_dict = {}
                elif current_dict is not None and ":" in stripped:
                    k, v = stripped.split(":", 1)
                    current_dict[k.strip()] = _scalar(v.strip())
            if current_dict is not None:
                items.append(current_dict)
            result[key] = items
        else:
            # nested dict
            nested: dict[str, Any] = {}
            for b in block_lines:
                if not b.strip():
                    continue
                stripped = b.lstrip()
                if ":" in stripped:
                    nk, nv = stripped.split(":", 1)
                    nv = nv.strip()
                    if nv:
                        nested[nk.strip()] = _scalar(nv)
                    else:
                        # nested list under the dict key (e.g. email_domains:)
                        # collect following indented lines
                        sub_indent = len(b) - len(stripped)
                        sub_items: list[Any] = []
                        idx = block_lines.index(b) + 1
                        while idx < len(block_lines):
                            sb = block_lines[idx]
                            if not sb.strip():
                                idx += 1
                                continue
                            sb_indent = len(sb) - len(sb.lstrip())
                            if sb_indent <= sub_indent:
                                break
                            sbs = sb.lstrip()
                            if sbs.startswith("- "):
                                sub_items.append(_scalar(sbs[2:].strip()))
                            idx += 1
                        nested[nk.strip()] = sub_items
            result[key] = nested
    return result


def _scalar(value: str) -> Any:
    """Coerce a YAML scalar string: quoted, unquoted, bool, number."""
    v = value.strip()
    if not v:
        return None
    if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
        return v[1:-1]
    if v.startswith("[") and v.endswith("]"):
        inner = v[1:-1].strip()
        if not inner:
            return []
        return [_scalar(x) for x in inner.split(",")]
    if v.lower() in {"true", "false"}:
        return v.lower() == "true"
    if v.lower() in {"null", "~"}:
        return None
    try:
        if "." in v:
            return float(v)
        return int(v)
    except ValueError:
        return v


# ---------------------------------------------------------------------------
# Wikilink helpers
# ---------------------------------------------------------------------------

WIKILINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]")


def parse_wikilink(value: Any) -> str | None:
    """Return the target portion of a [[Name]] or [[path/to/note]] wikilink, or None."""
    if not isinstance(value, str):
        return None
    m = WIKILINK_RE.search(value)
    if not m:
        return None
    return m.group(1).strip()


def wikilink_basename(value: Any) -> str | None:
    """Extract the basename (no extension, no folders) from a wikilink value."""
    target = parse_wikilink(value)
    if not target:
        return None
    # strip path
    tail = target.split("/")[-1]
    # strip .md extension
    if tail.endswith(".md"):
        tail = tail[:-3]
    return tail


# ---------------------------------------------------------------------------
# Client + contact discovery
# ---------------------------------------------------------------------------

@dataclass
class Client:
    folder: Path           # 2. Areas/Business/<Biz>/Clients/<ClientFolder>/
    file: Path             # the client note inside it
    name: str              # frontmatter `name:` or folder basename
    folder_name: str       # basename of folder (used as Comms folder)
    sources: dict[str, Any] = field(default_factory=dict)
    contact_links: list[str] = field(default_factory=list)


@dataclass
class Contact:
    file: Path
    name: str
    company_link: str | None
    role: str | None
    channels: list[dict[str, Any]]


def discover_clients(vault: Path) -> list[Client]:
    out: list[Client] = []
    biz_root = vault / "2. Areas" / "Business"
    if not biz_root.is_dir():
        return out
    for biz in sorted(biz_root.iterdir()):
        if not biz.is_dir():
            continue
        clients_dir = biz / "Clients"
        if not clients_dir.is_dir():
            continue
        for client_folder in sorted(clients_dir.iterdir()):
            if not client_folder.is_dir():
                continue
            client_file = _client_file_in(client_folder)
            if not client_file:
                continue
            text = client_file.read_text(encoding="utf-8", errors="ignore")
            fm, _body = parse_frontmatter(text)
            if fm.get("type") != "client":
                continue
            contact_links = []
            for entry in fm.get("contacts") or []:
                bn = wikilink_basename(entry)
                if bn:
                    contact_links.append(bn)
            out.append(
                Client(
                    folder=client_folder,
                    file=client_file,
                    name=str(fm.get("name") or client_folder.name),
                    folder_name=client_folder.name,
                    sources=fm.get("sources") or {},
                    contact_links=contact_links,
                )
            )
    return out


def _client_file_in(folder: Path) -> Path | None:
    """The canonical client note in a client folder: prefer <FolderName>.md, fallback to notes.md."""
    named = folder / f"{folder.name}.md"
    if named.is_file():
        return named
    notes = folder / "notes.md"
    if notes.is_file():
        return notes
    # last resort: first .md with `type: client`
    for f in sorted(folder.glob("*.md")):
        text = f.read_text(encoding="utf-8", errors="ignore")
        fm, _ = parse_frontmatter(text)
        if fm.get("type") == "client":
            return f
    return None


def discover_contacts(vault: Path) -> list[Contact]:
    out: list[Contact] = []
    contacts_dir = vault / "2. Areas" / "Contacts"
    if not contacts_dir.is_dir():
        return out
    for f in sorted(contacts_dir.glob("*.md")):
        text = f.read_text(encoding="utf-8", errors="ignore")
        fm, _ = parse_frontmatter(text)
        if fm.get("type") != "contact":
            continue
        channels = fm.get("channels") or []
        if not isinstance(channels, list):
            channels = []
        out.append(
            Contact(
                file=f,
                name=str(fm.get("name") or f.stem),
                company_link=fm.get("company") if isinstance(fm.get("company"), str) else None,
                role=fm.get("role") if isinstance(fm.get("role"), str) else None,
                channels=[c for c in channels if isinstance(c, dict)],
            )
        )
    return out


def contacts_for_client(client: Client, all_contacts: list[Contact]) -> list[Contact]:
    """A contact belongs to this client if:
       (a) the client's `contacts:` list names them by basename, OR
       (b) the contact's `company:` wikilink resolves to this client (by folder name or `name:`).
    """
    out: list[Contact] = []
    listed = {x.lower() for x in client.contact_links}
    folder = client.folder_name.lower()
    cname = client.name.lower()
    for c in all_contacts:
        if c.name.lower() in listed:
            out.append(c)
            continue
        if c.company_link:
            base = wikilink_basename(c.company_link)
            tgt = parse_wikilink(c.company_link)
            if base and base.lower() in {folder, cname}:
                out.append(c)
                continue
            if tgt and (f"clients/{folder}/" in tgt.lower() or tgt.lower().endswith(f"/{folder}/notes")):
                out.append(c)
                continue
    # dedupe
    seen = set()
    deduped = []
    for c in out:
        if c.file not in seen:
            seen.add(c.file)
            deduped.append(c)
    return deduped


def match_client(vault: Path, name_query: str) -> Client | None:
    q = name_query.lower().strip()
    clients = discover_clients(vault)
    # exact name match
    for c in clients:
        if c.name.lower() == q or c.folder_name.lower() == q:
            return c
    # substring
    for c in clients:
        if q in c.name.lower() or q in c.folder_name.lower():
            return c
    # slug match
    qs = re.sub(r"[^a-z0-9]+", "", q)
    for c in clients:
        cs = re.sub(r"[^a-z0-9]+", "", c.folder_name.lower())
        if cs == qs:
            return c
    return None


# ---------------------------------------------------------------------------
# Week math (Wn = ordinal Monday-of-month containing the week)
# ---------------------------------------------------------------------------

def monday_of(d: date) -> date:
    return d - timedelta(days=d.weekday())


def week_label(monday: date) -> tuple[str, str]:
    """Return (YYYY-MM_folder, Wn_label) for the Monday-anchored week."""
    folder = monday.strftime("%Y-%m")
    # count ordinal Monday in this Monday's month
    ordinal = 0
    cur = date(monday.year, monday.month, 1)
    while cur <= monday:
        if cur.weekday() == 0:
            ordinal += 1
        cur += timedelta(days=1)
    return folder, f"W{ordinal}"


def parse_week_arg(spec: str, fallback_today: date | None = None) -> date:
    """Parse 'YYYY-MM-Wn' or 'YYYY-Wn' (ISO) into the Monday of that week."""
    spec = spec.strip()
    m = re.match(r"^(\d{4})-(\d{2})-W(\d+)$", spec)
    if m:
        year, month, n = int(m.group(1)), int(m.group(2)), int(m.group(3))
        first = date(year, month, 1)
        # first Monday of that month
        offset = (7 - first.weekday()) % 7
        first_monday = first + timedelta(days=offset)
        return first_monday + timedelta(days=7 * (n - 1))
    raise ValueError(f"Unrecognised --week format: {spec!r} (expected YYYY-MM-Wn, e.g. 2026-04-W4)")


def iter_weeks(start_monday: date, end_monday: date):
    cur = start_monday
    while cur <= end_monday:
        yield cur
        cur = cur + timedelta(days=7)


# ---------------------------------------------------------------------------
# Channel adapters
# ---------------------------------------------------------------------------

PROTONMAIL_CLI = "C:/Users/HamCh/code/protonmail-cli/dist/cli.js"


def _run(cmd: list[str], *, input_text: str | None = None, allow_fail: bool = False) -> str:
    """Invoke a command. shell=False to avoid console-flash on Windows.

    On Windows, .cmd / .bat wrappers (e.g. npm-installed CLIs like slk) aren't
    discovered by CreateProcess without shell=True. shutil.which() respects
    PATHEXT and resolves to the full .cmd path so shell=False still works.
    """
    resolved = shutil.which(cmd[0]) or cmd[0]
    exec_cmd = [resolved] + cmd[1:]
    try:
        res = subprocess.run(
            exec_cmd,
            input=input_text,
            capture_output=True,
            text=True,
            shell=False,
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError as e:
        if allow_fail:
            sys.stderr.write(f"  [warn] {cmd[0]} not found on PATH\n")
            return ""
        raise SystemExit(f"command not found: {cmd[0]} ({e})")
    if res.returncode != 0 and not allow_fail:
        sys.stderr.write(f"\n[{cmd[0]}] exit {res.returncode}\n{res.stderr}\n")
    return res.stdout


# --- Email (protonmail-cli) ---

def email_search(domain: str, since: date, before: date) -> list[dict[str, Any]]:
    """List messages from/to a given domain in [since, before)."""
    cmd = [
        "node", PROTONMAIL_CLI, "mail", "search", domain,
        "-m", "All Mail",
        "--since", since.strftime("%Y-%m-%d"),
        "--before", before.strftime("%Y-%m-%d"),
        "--json",
    ]
    out = _run(cmd, allow_fail=True)
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return []


def email_read_html(uid: int) -> str:
    cmd = ["node", PROTONMAIL_CLI, "mail", "read", f"uid:{uid}", "-m", "All Mail", "--html"]
    return _run(cmd, allow_fail=True)


def _html_to_text(html: str) -> str:
    s = html
    s = re.sub(r"<style[\s\S]*?</style>", "", s, flags=re.I)
    s = re.sub(r"<script[\s\S]*?</script>", "", s, flags=re.I)
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"</(p|div|li|tr)>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = (
        s.replace("&nbsp;", " ").replace("&amp;", "&")
         .replace("&lt;", "<").replace("&gt;", ">")
         .replace("&quot;", '"').replace("&#39;", "'")
    )
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n[ \t]+", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


_QUOTE_CUT_PATTERNS = [
    re.compile(r"^On\s+\w{3,9},?\s+\w{3,9}\s+\d{1,2}.*wrote:?\s*$", re.I | re.M),
    re.compile(r"^On\s+\w{3,9}\s+\d{1,2},?\s+\d{4}.*wrote:?\s*$", re.I | re.M),
    re.compile(r"^On\s+\w{3,9}day,?\s+\d{2}/\d{2}/\d{2,4}.*wrote:?\s*$", re.I | re.M),
    re.compile(r"^-{4,}\s*Original Message\s*-{4,}", re.I | re.M),
    re.compile(r"^From:\s+.*$", re.I | re.M),
]


def _strip_quoted(text: str) -> str:
    cut = len(text)
    for pat in _QUOTE_CUT_PATTERNS:
        m = pat.search(text)
        if m and m.start() < cut:
            cut = m.start()
    return text[:cut].strip()


def extract_email_body(uid: int) -> tuple[str, str, str]:
    """Return (from_header, date_header, clean_body) for a single message."""
    raw = email_read_html(uid)
    if "---" not in raw:
        return ("", "", "")
    header_part, _, body_part = raw.partition("\n---\n")
    if not body_part:
        # fallback split — some outputs have just '---' without preceding newline
        header_part, _, body_part = raw.partition("---")
    from_m = re.search(r"^From:\s*(.+)$", header_part, re.M)
    date_m = re.search(r"^Date:\s*(.+)$", header_part, re.M)
    clean = _strip_quoted(_html_to_text(body_part))
    return (
        (from_m.group(1).strip() if from_m else ""),
        (date_m.group(1).strip() if date_m else ""),
        clean,
    )


def _norm_subject(subject: str) -> str:
    return re.sub(r"^(Re|Fwd|FW):\s*", "", subject, flags=re.I).strip()


def fetch_email_threads_for_week(
    domains: list[str], monday: date, sunday: date
) -> list[dict[str, Any]]:
    """Pull all messages in the [monday, sunday+1day) window across all domains,
    group by normalised subject. Each thread: {subject, msgs:[{uid,date_iso,from,subject,body}], emails:set}"""
    if not domains:
        return []
    since = monday
    before = sunday + timedelta(days=1)
    all_msgs: list[dict[str, Any]] = []
    seen_uids: set[int] = set()
    for d in domains:
        msgs = email_search(d, since, before)
        for m in msgs:
            uid = m.get("uid")
            if uid in seen_uids:
                continue
            seen_uids.add(uid)
            all_msgs.append(m)
    # group
    threads: dict[str, dict[str, Any]] = {}
    for m in sorted(all_msgs, key=lambda x: x.get("date_iso", "")):
        subj = _norm_subject(str(m.get("subject", "(no subject)")))
        t = threads.setdefault(subj, {"subject": subj, "msgs": [], "emails": set()})
        # body extraction
        body_from, body_date, body_text = extract_email_body(int(m["uid"]))
        sender_email = _extract_email_addr(m.get("from") or body_from)
        if sender_email:
            t["emails"].add(sender_email.lower())
        t["msgs"].append(
            {
                "uid": m["uid"],
                "date_iso": m.get("date_iso") or "",
                "from": m.get("from") or body_from,
                "from_email": sender_email,
                "subject": m.get("subject") or subj,
                "body": body_text,
            }
        )
    return list(threads.values())


def _extract_email_addr(raw: str | None) -> str | None:
    if not raw:
        return None
    m = re.search(r"<([^>]+@[^>]+)>", raw)
    if m:
        return m.group(1).strip()
    m = re.search(r"([\w.+\-]+@[\w.\-]+)", raw)
    return m.group(1).strip() if m else None


# --- Slack (slk) ---

def slk_read(channel_id: str, limit: int = 200) -> list[dict[str, Any]]:
    cmd = ["slk", "read", channel_id, "-l", str(limit), "--json"]
    out = _run(cmd, allow_fail=True)
    try:
        data = json.loads(out)
        return data if isinstance(data, list) else []
    except json.JSONDecodeError:
        return []


def fetch_slack_messages_for_week(
    channels: list[tuple[str, str]], monday: date, sunday: date
) -> list[dict[str, Any]]:
    """channels: list of (channel_id, channel_label).
    Returns flat list of {ts, dt, channel_id, channel_label, user_id, user_name, text, thread_ts}.
    """
    start_ts = datetime(monday.year, monday.month, monday.day, tzinfo=timezone.utc).timestamp()
    end_ts = datetime(
        (sunday + timedelta(days=1)).year,
        (sunday + timedelta(days=1)).month,
        (sunday + timedelta(days=1)).day,
        tzinfo=timezone.utc,
    ).timestamp()
    out: list[dict[str, Any]] = []
    for ch_id, ch_label in channels:
        msgs = slk_read(ch_id, limit=500)
        for m in msgs:
            if m.get("type") != "message":
                continue
            ts_raw = m.get("ts")
            if not ts_raw:
                continue
            try:
                ts = float(ts_raw)
            except (TypeError, ValueError):
                continue
            if ts < start_ts or ts >= end_ts:
                continue
            profile = m.get("user_profile") or {}
            out.append(
                {
                    "ts": ts,
                    "dt": datetime.fromtimestamp(ts, timezone.utc),
                    "channel_id": ch_id,
                    "channel_label": ch_label,
                    "user_id": m.get("user") or "",
                    "user_name": (
                        profile.get("real_name")
                        or profile.get("display_name")
                        or profile.get("name")
                        or m.get("user")
                        or "unknown"
                    ),
                    "text": _resolve_slack_mrkdwn(m.get("text") or "", out),
                    "thread_ts": m.get("thread_ts") or m.get("ts"),
                }
            )
    out.sort(key=lambda x: x["ts"])
    return out


_SLACK_USER_RE = re.compile(r"<@(U[A-Z0-9]+)>")
_SLACK_URL_RE = re.compile(r"<(https?://[^|>]+)(?:\|([^>]+))?>")


def _resolve_slack_mrkdwn(text: str, prior_msgs: list[dict[str, Any]]) -> str:
    """Replace <@Uxxx> and <https://...|label> with friendlier display forms."""
    # Build a quick user_id → name map from messages seen so far
    name_map: dict[str, str] = {}
    for m in prior_msgs:
        if m.get("user_id") and m.get("user_name"):
            name_map.setdefault(m["user_id"], m["user_name"])
    def user_sub(m: re.Match) -> str:
        uid = m.group(1)
        return "@" + name_map.get(uid, uid)
    text = _SLACK_USER_RE.sub(user_sub, text)
    def url_sub(m: re.Match) -> str:
        url, label = m.group(1), m.group(2)
        return f"[{label}]({url})" if label else url
    text = _SLACK_URL_RE.sub(url_sub, text)
    return text


def group_slack_into_threads(
    messages: list[dict[str, Any]], gap_hours: float = 12.0
) -> list[dict[str, Any]]:
    """Group sorted slack messages into threads:
       - per-channel
       - prefer Slack's thread_ts grouping
       - top-level messages with no replies → grouped into 'conversation bursts' (gap > N hours = new burst)
    """
    threads: dict[tuple[str, str], dict[str, Any]] = {}
    # First pass: bucket by (channel_id, thread_ts) for explicitly-threaded messages
    for m in messages:
        key = (m["channel_id"], m["thread_ts"])
        t = threads.setdefault(
            key,
            {
                "channel_id": m["channel_id"],
                "channel_label": m["channel_label"],
                "thread_ts": m["thread_ts"],
                "msgs": [],
                "user_ids": set(),
                "user_names": set(),
            },
        )
        t["msgs"].append(m)
        if m.get("user_id"):
            t["user_ids"].add(m["user_id"])
        if m.get("user_name"):
            t["user_names"].add(m["user_name"])
    # Second pass: split single-message threads in the same channel into bursts by time gap
    out: list[dict[str, Any]] = []
    by_channel: dict[str, list[dict[str, Any]]] = {}
    for t in threads.values():
        if len(t["msgs"]) > 1:
            out.append(t)
        else:
            by_channel.setdefault(t["channel_id"], []).append(t["msgs"][0])
    for ch_id, msgs in by_channel.items():
        msgs.sort(key=lambda m: m["ts"])
        cur: dict[str, Any] | None = None
        for m in msgs:
            if cur is None or m["ts"] - cur["msgs"][-1]["ts"] > gap_hours * 3600:
                if cur is not None:
                    out.append(cur)
                cur = {
                    "channel_id": ch_id,
                    "channel_label": m["channel_label"],
                    "thread_ts": m["ts"],
                    "msgs": [m],
                    "user_ids": {m.get("user_id")} if m.get("user_id") else set(),
                    "user_names": {m.get("user_name")} if m.get("user_name") else set(),
                }
            else:
                cur["msgs"].append(m)
                if m.get("user_id"):
                    cur["user_ids"].add(m["user_id"])
                if m.get("user_name"):
                    cur["user_names"].add(m["user_name"])
        if cur is not None:
            out.append(cur)
    out.sort(key=lambda t: t["msgs"][0]["ts"])
    return out


# ---------------------------------------------------------------------------
# Contact resolution
# ---------------------------------------------------------------------------

def resolve_email_sender(addr: str | None, contacts: list[Contact]) -> Contact | None:
    if not addr:
        return None
    addr_l = addr.lower()
    for c in contacts:
        for ch in c.channels:
            if ch.get("kind") == "email":
                if (ch.get("address") or "").lower() == addr_l:
                    return c
    return None


def resolve_slack_sender(user_id: str | None, contacts: list[Contact]) -> Contact | None:
    if not user_id:
        return None
    for c in contacts:
        for ch in c.channels:
            if ch.get("kind") == "slack" and ch.get("user_id") == user_id:
                return c
    return None


# ---------------------------------------------------------------------------
# Summarisation via `claude -p`
# ---------------------------------------------------------------------------

SUMMARISE_SYSTEM = """You produce concise, factual weekly communication digests for a project lead.
Output is markdown that will be pasted directly under a YAML frontmatter block.

Hard rules:
- Don't invent details, attendees, or actions not present in the input. If the input is sparse, the summary is sparse.
- Use the exact section headings, link targets, and emoji shown in the OUTPUT FORMAT.
- Use [[Wiki Link]] format when referring to a person if their name has [[brackets]] in the input.
- Keep the synopsis to one short paragraph (2-4 sentences). Sub-sections are optional and only when there is real content for them.
- Actions are verb-first ("Flip Stripe to LIVE"), Open items are unresolved questions or work.
- Skip a sub-section entirely if it has no items — do NOT print empty headers.
"""


SUMMARISE_TEMPLATE = """Client: {client_name}
Period: {period_start} to {period_end}
Channels used this week: {channel_kinds}

CONTACTS for this client (resolve any matching senders to their [[Wiki Link]]):
{contact_block}

THREADS this week (sorted chronologically). For each, produce a section.
Use ✉️ for email threads, 💬 for Slack threads.

{threads_block}

OUTPUT FORMAT — produce only the markdown body (no YAML frontmatter). Structure:

## YYYY-MM-DD — Day · [optional second date if thread spans]

### {{emoji}} "{{subject_or_topic}}" — {{contact_or_label}} ({{n}} msgs[, {{date_range}}])
{{1-paragraph synopsis. Mention concrete items: file paths, URLs, version numbers, dollar amounts, names.}}

{{Optional **Bold Sub-Section:** with bulleted items if the thread has structured findings — e.g. **Root cause found:**, **Fixes deployed:**, **Direct plugin edits:**, **Problem:**.}}

**Actions:**
- Verb-first action item …

**Open:**
- Unresolved question …

**Decisions:**
- Decision made by …

→ Full thread: [[Comms/{client_name}/threads/{{thread_slug}}]]

---

(Repeat per thread; group by day with ## headers; threads on the same day under the same ## header. End with:)

## Week roll-up

**Top open items going into next week:**
1. …
2. …
3. …

If a thread really has nothing actionable beyond chatter, still produce the section but omit the Actions/Open/Decisions sub-sections. Never skip a thread entirely.
"""


def summarise_week(
    client: Client,
    monday: date,
    sunday: date,
    channel_kinds: list[str],
    email_threads: list[dict[str, Any]],
    slack_threads: list[dict[str, Any]],
    contacts: list[Contact],
) -> str:
    """Return the markdown BODY for the weekly file (no frontmatter)."""
    if not email_threads and not slack_threads:
        return (
            f"## {monday.strftime('%Y-%m-%d')} — {monday.strftime('%a')}\n\n"
            "_No messages this week._\n\n"
            "## Week roll-up\n\n"
            "**Top open items going into next week:** _(none — quiet week)_\n"
        )

    contact_lines: list[str] = []
    for c in contacts:
        ch_summ = ", ".join(
            f"{ch.get('kind')}={(ch.get('user_id') or ch.get('address') or ch.get('handle') or '?')}"
            for ch in c.channels
        )
        contact_lines.append(f"- [[{c.name}]] ({c.role or 'role unknown'}) — channels: {ch_summ}")
    contact_block = "\n".join(contact_lines) if contact_lines else "(no contacts catalogued)"

    threads_block_parts: list[str] = []
    for t in email_threads:
        msgs = t["msgs"]
        first = msgs[0]["date_iso"][:10] if msgs else ""
        last = msgs[-1]["date_iso"][:10] if msgs else ""
        date_range = first if first == last else f"{first} → {last}"
        thread_slug = _slug(f"{first}-{t['subject']}")
        participants: list[str] = []
        for m in msgs:
            sender_contact = resolve_email_sender(m.get("from_email"), contacts)
            if sender_contact:
                participants.append(f"[[{sender_contact.name}]]")
            else:
                participants.append(m["from"].split("<")[0].strip() or "?")
        # dedupe preserving order
        seen = set()
        participants = [p for p in participants if not (p in seen or seen.add(p))]
        msg_lines = []
        for m in msgs:
            t_ = m["date_iso"][:16].replace("T", " ")
            sender = m["from"].split("<")[0].strip() or m.get("from_email", "?")
            body = (m.get("body") or "").strip()
            if not body:
                body = "(empty body — possibly inline image/attachment)"
            msg_lines.append(f"[{t_}] {sender}:\n{body}")
        threads_block_parts.append(
            f"--- EMAIL THREAD ---\n"
            f"subject: {t['subject']}\n"
            f"participants: {', '.join(participants) if participants else '?'}\n"
            f"messages ({len(msgs)}, {date_range}):\n"
            f"thread_slug: {thread_slug}\n\n"
            + "\n\n".join(msg_lines)
            + "\n"
        )
    for t in slack_threads:
        msgs = t["msgs"]
        first_dt = msgs[0]["dt"].strftime("%Y-%m-%d")
        last_dt = msgs[-1]["dt"].strftime("%Y-%m-%d")
        date_range = first_dt if first_dt == last_dt else f"{first_dt} → {last_dt}"
        thread_slug = _slug(f"{first_dt}-{t['channel_label']}-{msgs[0]['text'][:30]}")
        participants = []
        for m in msgs:
            sender_contact = resolve_slack_sender(m.get("user_id"), contacts)
            if sender_contact:
                participants.append(f"[[{sender_contact.name}]]")
            else:
                participants.append(m.get("user_name") or m.get("user_id") or "?")
        seen = set()
        participants = [p for p in participants if not (p in seen or seen.add(p))]
        msg_lines = []
        for m in msgs:
            ts_str = m["dt"].strftime("%Y-%m-%d %H:%M")
            sender = m.get("user_name") or m.get("user_id") or "?"
            text = (m.get("text") or "").strip() or "(empty)"
            msg_lines.append(f"[{ts_str}] {sender}: {text}")
        threads_block_parts.append(
            f"--- SLACK THREAD ---\n"
            f"channel: {t['channel_label']}\n"
            f"participants: {', '.join(participants) if participants else '?'}\n"
            f"messages ({len(msgs)}, {date_range}):\n"
            f"thread_slug: {thread_slug}\n\n"
            + "\n".join(msg_lines)
            + "\n"
        )
    threads_block = "\n\n".join(threads_block_parts)

    prompt = SUMMARISE_TEMPLATE.format(
        client_name=client.name,
        period_start=monday.strftime("%Y-%m-%d"),
        period_end=sunday.strftime("%Y-%m-%d"),
        channel_kinds=", ".join(channel_kinds) if channel_kinds else "(none)",
        contact_block=contact_block,
        threads_block=threads_block,
    )

    return _call_claude_p(prompt)


def _call_claude_p(prompt: str) -> str:
    """Invoke `claude -p` with the prompt via stdin to avoid arg-size limits."""
    full = SUMMARISE_SYSTEM + "\n\n" + prompt
    res = subprocess.run(
        ["claude", "-p"],
        input=full,
        capture_output=True,
        text=True,
        shell=False,
        encoding="utf-8",
        errors="replace",
    )
    if res.returncode != 0:
        sys.stderr.write(f"\n[claude -p] exit {res.returncode}\n{res.stderr}\n")
        return f"_(claude -p failed: {res.returncode})_\n"
    return res.stdout.strip()


# ---------------------------------------------------------------------------
# Vault writing
# ---------------------------------------------------------------------------

def _slug(s: str) -> str:
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")[:80]


def obsidian_eval(js: str) -> str:
    res = subprocess.run(
        ["obsidian", "eval", f"code={js}"],
        capture_output=True,
        text=True,
        shell=False,
        encoding="utf-8",
        errors="replace",
    )
    if res.returncode != 0:
        sys.stderr.write(f"\n[obsidian eval] exit {res.returncode}\n{res.stderr}\n")
        return ""
    return res.stdout.strip()


import tempfile


def vault_write(rel_path: str, content: str) -> None:
    """Create or overwrite a vault file. Ensures parent folders exist.

    Writes content to a temp file first, then obsidian eval reads it via
    fs.readFileSync — bulletproof for long content / special chars per
    feedback_obsidian_cli_eval_pattern.md.
    """
    parts = rel_path.split("/")
    js_parts = []
    cur = ""
    for p in parts[:-1]:
        cur = f"{cur}/{p}" if cur else p
        js_parts.append(
            f"if (!app.vault.getAbstractFileByPath({json.dumps(cur)})) "
            f"await app.vault.createFolder({json.dumps(cur)});"
        )
    folder_setup = "\n".join(js_parts)

    fd, tmp_path = tempfile.mkstemp(suffix=".comms.tmp", text=False)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(content)
        tmp_path_js = tmp_path.replace("\\", "/")
        js = (
            "(async () => {\n"
            f"{folder_setup}\n"
            "const fs = require('fs');\n"
            f"const path = {json.dumps(rel_path)};\n"
            f"const content = fs.readFileSync({json.dumps(tmp_path_js)}, 'utf8');\n"
            "const existing = app.vault.getFileByPath(path);\n"
            "if (existing) { await app.vault.modify(existing, content); return 'modified'; }\n"
            "await app.vault.create(path, content); return 'created';\n"
            "})()"
        )
        obsidian_eval(js)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# File renderers
# ---------------------------------------------------------------------------

def render_weekly_frontmatter(
    client: Client,
    monday: date,
    sunday: date,
    channel_kinds: list[str],
    thread_count: int,
    msg_count: int,
    contacts_involved: list[str],
    generated: date,
) -> str:
    contacts_yaml = ", ".join(f'"[[{c}]]"' for c in contacts_involved)
    channels_yaml = ", ".join(channel_kinds)
    return (
        "---\n"
        "type: comms-weekly\n"
        f'client: "[[{client.name}]]"\n'
        f"period: {monday.strftime('%Y-%m-%d')} to {sunday.strftime('%Y-%m-%d')}\n"
        f"channels: [{channels_yaml}]\n"
        f"threads: {thread_count}\n"
        f"messages: {msg_count}\n"
        f"contacts: [{contacts_yaml}]\n"
        f"generated: {generated.strftime('%Y-%m-%d')}\n"
        "---\n\n"
    )


def render_email_thread_file(
    client: Client,
    thread: dict[str, Any],
    contacts: list[Contact],
    week_folder: str,
    week_label_str: str,
) -> str:
    msgs = thread["msgs"]
    first = msgs[0]["date_iso"][:10] if msgs else ""
    last = msgs[-1]["date_iso"][:10] if msgs else ""
    participants: list[str] = []
    seen = set()
    for m in msgs:
        sc = resolve_email_sender(m.get("from_email"), contacts)
        label = f"[[{sc.name}]]" if sc else (m["from"].split("<")[0].strip() or "?")
        if label not in seen:
            seen.add(label)
            participants.append(label)
    fm = (
        "---\n"
        "type: comms-thread\n"
        f'client: "[[{client.name}]]"\n'
        f'subject: {thread["subject"]}\n'
        "channel: email\n"
        f'participants: [{", ".join(json.dumps(p) for p in participants)}]\n'
        f"started: {first}\n"
        f"ended: {last}\n"
        f"message_count: {len(msgs)}\n"
        f'week: "[[{week_folder}/{week_label_str}]]"\n'
        "---\n\n"
    )
    body_parts = []
    for m in msgs:
        dt = m["date_iso"][:16].replace("T", " ")
        sender = m["from"].split("<")[0].strip() or m.get("from_email", "?")
        body = (m.get("body") or "").strip()
        if not body:
            body = "_(empty body — likely inline image or attachment only)_"
        body_parts.append(f"## {dt} — {sender}\n\n{body}")
    return fm + "\n\n".join(body_parts) + "\n"


def render_slack_thread_file(
    client: Client,
    thread: dict[str, Any],
    contacts: list[Contact],
    week_folder: str,
    week_label_str: str,
) -> str:
    msgs = thread["msgs"]
    first = msgs[0]["dt"].strftime("%Y-%m-%d")
    last = msgs[-1]["dt"].strftime("%Y-%m-%d")
    participants: list[str] = []
    seen = set()
    for m in msgs:
        sc = resolve_slack_sender(m.get("user_id"), contacts)
        label = f"[[{sc.name}]]" if sc else (m.get("user_name") or m.get("user_id") or "?")
        if label not in seen:
            seen.add(label)
            participants.append(label)
    fm = (
        "---\n"
        "type: comms-thread\n"
        f'client: "[[{client.name}]]"\n'
        f'channel: slack\n'
        f'channel_label: {thread["channel_label"]}\n'
        f'channel_id: {thread["channel_id"]}\n'
        f'participants: [{", ".join(json.dumps(p) for p in participants)}]\n'
        f"started: {first}\n"
        f"ended: {last}\n"
        f"message_count: {len(msgs)}\n"
        f'week: "[[{week_folder}/{week_label_str}]]"\n'
        "---\n\n"
    )
    body_parts = []
    for m in msgs:
        dt = m["dt"].strftime("%Y-%m-%d %H:%M")
        sender = m.get("user_name") or m.get("user_id") or "?"
        text = (m.get("text") or "").strip() or "_(empty)_"
        body_parts.append(f"## {dt} — {sender}\n\n{text}")
    return fm + "\n\n".join(body_parts) + "\n"


# ---------------------------------------------------------------------------
# Slack channel resolution for a client
# ---------------------------------------------------------------------------

def slack_channels_for_client(client: Client, contacts: list[Contact]) -> list[tuple[str, str]]:
    """Return list of (channel_id, label) — shared channel + each contact's DM."""
    out: list[tuple[str, str]] = []
    shared = client.sources.get("slack_channel") if isinstance(client.sources, dict) else None
    if shared:
        out.append((str(shared), f"#{shared}"))
    for c in contacts:
        for ch in c.channels:
            if ch.get("kind") == "slack" and ch.get("dm"):
                out.append((str(ch["dm"]), f"@{c.name} DM"))
    # dedupe by channel_id
    seen = set()
    deduped = []
    for ch_id, lbl in out:
        if ch_id not in seen:
            seen.add(ch_id)
            deduped.append((ch_id, lbl))
    return deduped


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_sync(args, vault: Path) -> int:
    client = match_client(vault, args.client)
    if not client:
        print(f"client not found: {args.client!r}", file=sys.stderr)
        return 2

    all_contacts = discover_contacts(vault)
    client_contacts = contacts_for_client(client, all_contacts)

    monday = parse_week_arg(args.week) if args.week else monday_of(date.today())
    sunday = monday + timedelta(days=6)
    week_folder, week_label_str = week_label(monday)

    return _sync_one_week(vault, client, client_contacts, monday, sunday, week_folder, week_label_str)


def _sync_one_week(
    vault: Path,
    client: Client,
    client_contacts: list[Contact],
    monday: date,
    sunday: date,
    week_folder: str,
    week_label_str: str,
) -> int:
    sources = client.sources if isinstance(client.sources, dict) else {}
    email_domains_raw = sources.get("email_domains")
    if isinstance(email_domains_raw, list):
        email_domains = [str(d) for d in email_domains_raw if d]
    elif isinstance(email_domains_raw, str):
        email_domains = [email_domains_raw]
    else:
        email_domains = []

    channel_kinds: list[str] = []
    email_threads: list[dict[str, Any]] = []
    slack_threads: list[dict[str, Any]] = []

    if email_domains:
        channel_kinds.append("email")
        print(f"  fetching email for domains: {email_domains} …", file=sys.stderr)
        email_threads = fetch_email_threads_for_week(email_domains, monday, sunday)

    slack_channels = slack_channels_for_client(client, client_contacts)
    if slack_channels:
        channel_kinds.append("slack")
        print(f"  fetching slack for {len(slack_channels)} channel(s) …", file=sys.stderr)
        slack_msgs = fetch_slack_messages_for_week(slack_channels, monday, sunday)
        slack_threads = group_slack_into_threads(slack_msgs)

    msg_count = sum(len(t["msgs"]) for t in email_threads) + sum(len(t["msgs"]) for t in slack_threads)
    thread_count = len(email_threads) + len(slack_threads)
    contacts_involved: list[str] = []
    seen = set()
    for t in email_threads:
        for m in t["msgs"]:
            sc = resolve_email_sender(m.get("from_email"), client_contacts)
            if sc and sc.name not in seen:
                seen.add(sc.name)
                contacts_involved.append(sc.name)
    for t in slack_threads:
        for m in t["msgs"]:
            sc = resolve_slack_sender(m.get("user_id"), client_contacts)
            if sc and sc.name not in seen:
                seen.add(sc.name)
                contacts_involved.append(sc.name)

    print(
        f"  week {monday}..{sunday}: {thread_count} threads, {msg_count} msgs, "
        f"channels={channel_kinds}",
        file=sys.stderr,
    )

    if thread_count == 0:
        body = (
            f"## {monday.strftime('%Y-%m-%d')} — {monday.strftime('%a')}\n\n"
            "_No messages this week._\n\n"
            "## Week roll-up\n\n"
            "**Top open items going into next week:** _(none — quiet week)_\n"
        )
    else:
        body = summarise_week(
            client,
            monday,
            sunday,
            channel_kinds,
            email_threads,
            slack_threads,
            client_contacts,
        )

    fm = render_weekly_frontmatter(
        client=client,
        monday=monday,
        sunday=sunday,
        channel_kinds=channel_kinds,
        thread_count=thread_count,
        msg_count=msg_count,
        contacts_involved=contacts_involved,
        generated=date.today(),
    )
    rel_weekly = f"2. Areas/Comms/{client.folder_name}/{week_folder}/{week_label_str}.md"
    vault_write(rel_weekly, fm + body + "\n")
    print(f"  wrote {rel_weekly}", file=sys.stderr)

    # thread files
    for t in email_threads:
        first = t["msgs"][0]["date_iso"][:10] if t["msgs"] else monday.strftime("%Y-%m-%d")
        slug = _slug(f"{first}-{t['subject']}")
        rel = f"2. Areas/Comms/{client.folder_name}/threads/{slug}.md"
        vault_write(
            rel,
            render_email_thread_file(client, t, client_contacts, week_folder, week_label_str),
        )
    for t in slack_threads:
        first = t["msgs"][0]["dt"].strftime("%Y-%m-%d")
        first_text = (t["msgs"][0].get("text") or "")[:30]
        slug = _slug(f"{first}-{t['channel_label']}-{first_text}")
        rel = f"2. Areas/Comms/{client.folder_name}/threads/{slug}.md"
        vault_write(
            rel,
            render_slack_thread_file(client, t, client_contacts, week_folder, week_label_str),
        )

    return 0


def cmd_backfill(args, vault: Path) -> int:
    client = match_client(vault, args.client)
    if not client:
        print(f"client not found: {args.client!r}", file=sys.stderr)
        return 2
    all_contacts = discover_contacts(vault)
    client_contacts = contacts_for_client(client, all_contacts)
    try:
        since = datetime.strptime(args.since, "%Y-%m-%d").date()
    except ValueError:
        print("expected --since YYYY-MM-DD", file=sys.stderr)
        return 2
    start_monday = monday_of(since)
    end_monday = monday_of(date.today())
    for monday in iter_weeks(start_monday, end_monday):
        sunday = monday + timedelta(days=6)
        week_folder, week_label_str = week_label(monday)
        print(f"\n[{client.name}] week {week_folder}/{week_label_str} ({monday} → {sunday})", file=sys.stderr)
        try:
            _sync_one_week(vault, client, client_contacts, monday, sunday, week_folder, week_label_str)
        except Exception as e:
            sys.stderr.write(f"  ERROR: {e}\n")
            continue
    return 0


def cmd_list(args, vault: Path) -> int:
    clients = discover_clients(vault)
    all_contacts = discover_contacts(vault)
    if not clients:
        print("no clients found.")
        return 0
    print(f"\nClients ({len(clients)} total)\n")
    for c in clients:
        ccs = contacts_for_client(c, all_contacts)
        srcs: list[str] = []
        if isinstance(c.sources, dict):
            if c.sources.get("slack_channel"):
                srcs.append(f"slack:{c.sources.get('slack_channel')}")
            if c.sources.get("email_domains"):
                ed = c.sources["email_domains"]
                if isinstance(ed, list):
                    srcs.append("email:" + ",".join(ed))
                else:
                    srcs.append(f"email:{ed}")
        marker = "*" if (c.sources or ccs) else "-"
        sources_str = (" | " + " ; ".join(srcs)) if srcs else " | (no sources)"
        print(f"  {marker}  {c.name:<35}  contacts: {len(ccs):>2}{sources_str}")
    return 0


def cmd_contacts(args, vault: Path) -> int:
    client = match_client(vault, args.client)
    if not client:
        print(f"client not found: {args.client!r}", file=sys.stderr)
        return 2
    all_contacts = discover_contacts(vault)
    client_contacts = contacts_for_client(client, all_contacts)
    print(f"\n{client.name} — {len(client_contacts)} contact(s)\n")
    for c in client_contacts:
        print(f"  [[{c.name}]]  ({c.role or 'role unknown'})")
        for ch in c.channels:
            kind = ch.get("kind", "?")
            label = ch.get("address") or ch.get("user_id") or ch.get("handle") or ch.get("url") or "?"
            extra = []
            if ch.get("workspace_name"):
                extra.append(f"ws={ch['workspace_name']}")
            if ch.get("dm"):
                extra.append(f"dm={ch['dm']}")
            extra_str = f"  [{'; '.join(extra)}]" if extra else ""
            print(f"      - {kind}: {label}{extra_str}")
    if not client_contacts:
        print("  (none — add contact notes under 2. Areas/Contacts/ with this client as their `company:`)")
    return 0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    p = argparse.ArgumentParser(description="braynee comms — client communication sync")
    p.add_argument("--vault", help="vault path (auto-detected if omitted)")
    sub = p.add_subparsers(dest="cmd")

    s = sub.add_parser("sync", help="sync one week for a client")
    s.add_argument("client")
    s.add_argument("--week", help="YYYY-MM-Wn (default: current week)")

    b = sub.add_parser("backfill", help="sync every week from --since through current week")
    b.add_argument("client")
    b.add_argument("--since", required=True, help="YYYY-MM-DD")

    sub.add_parser("list", help="list clients with sources/contacts")

    cc = sub.add_parser("contacts", help="show a client's contacts and their channels")
    cc.add_argument("client")

    args = p.parse_args()

    vault = Path(args.vault).expanduser() if args.vault else find_vault()
    if not vault:
        print("vault not found. pass --vault to specify.", file=sys.stderr)
        return 2

    if args.cmd == "sync":
        return cmd_sync(args, vault)
    if args.cmd == "backfill":
        return cmd_backfill(args, vault)
    if args.cmd == "list":
        return cmd_list(args, vault)
    if args.cmd == "contacts":
        return cmd_contacts(args, vault)
    p.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
