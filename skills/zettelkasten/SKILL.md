---
name: zettelkasten
description: >
  Create, find, and link atomic notes in your Zettelkasten. Distill insights into
  permanent notes with backlinks. Use when user says "add to zettelkasten", "atomic note",
  "permanent note", "note on X", "link this idea", "what atoms do I have on",
  "write a zettel", "capture this insight".
argument-hint: "[new TITLE | find QUERY | link SOURCE TARGET | inbox | review]"
allowed-tools: Bash(python3:*), Bash(node:*), Bash(obsidian:*)
---

# Zettelkasten Skill

Manages atomic notes in `Zettelkasten/`. One idea per note, densely linked.

## Commands

```bash
# Create a new atomic note
python3 {baseDir}/scripts/zettel.py new "Title of the idea"

# Find atoms related to a topic
python3 {baseDir}/scripts/zettel.py find "QUERY"

# Process inbox captures into atomic notes
python3 {baseDir}/scripts/zettel.py inbox

# Review atoms that have no outbound links yet (orphans)
python3 {baseDir}/scripts/zettel.py review
```

## Atomic Note Format

```markdown
---
type: atom
id: YYYYMMDD-HHMMSS
tags: [concept, domain]
links: []
created: YYYY-MM-DD
---

# Note Title

One focused idea. 3-5 sentences max. No fluff.

## Links

- [[Related Atom 1]] — why it connects
- [[Related Atom 2]] — why it connects

## Source

Where the idea came from (book, session, conversation, project).
```

## Zettelkasten Principles

- **One idea per note** — if you're using "and", split it
- **Link generously** — connections between atoms are where value lives
- **Write in your own words** — don't copy-paste, synthesize
- **Evergreen titles** — state the idea as a claim: "Systems thinking reveals unintended consequences"
- **Source everything** — where did this come from?

## Location

All atoms live in `Zettelkasten/` at the vault root. Named by ID, not topic — the title
is inside the note.
