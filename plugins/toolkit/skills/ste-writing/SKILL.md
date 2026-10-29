---
name: ste-writing
description: >
  Rewrite prose into ASD-STE100 Simplified Technical English to strip "AI slop",
  then verify the rewrite with a linter instead of trusting it. Use when user says
  "this sounds like AI", "unslop this", "make it plain", "remove the slop",
  "rewrite this clearly", "make the docs readable", "lint my writing",
  "score this draft", or asks for docs/READMEs/PR text/error messages that do not
  read like a model wrote them. Not for marketing copy or anything needing voice.
argument-hint: "[lint FILE | rewrite FILE | check FILE] [--strict]"
allowed-tools: Bash(python3:*), Read, Edit, Write, Glob
---

# STE Writing Skill

Write and repair prose using the machine-checkable subset of **ASD-STE100
Simplified Technical English** — a 1986 aerospace documentation standard built so
a non-native-speaking mechanic could never misread a repair manual.

The reason it works on AI output is not aesthetic. Slop is ambiguity, and STE is
forty years of engineering aimed at ambiguity. The rules that matter are
**mechanically checkable**, so the model can verify its own output instead of
guessing whether it "sounds human".

**Scope:** documentation, READMEs, PR descriptions, API docs, error messages,
release notes, runbooks, code comments, agent output, vault notes.
**Never:** code, identifiers, command syntax, marketing copy, essays, client-facing
persuasion, or anything that needs a voice. STE strips voice on purpose.

## Workflow — always lint, rewrite, lint

Never rewrite and declare victory. The delta between two scores is the signal.
A single absolute score means little.

```bash
# 1. Score the draft
python3 {baseDir}/scripts/ste-lint.py draft.md

# 2. Rewrite it using the rules below

# 3. Score again and report BOTH numbers plus the delta
python3 {baseDir}/scripts/ste-lint.py draft.md

# Full JSON breakdown by violation category
cat draft.md | python3 {baseDir}/scripts/ste-lint.py

# Ignore quoted mentions (for docs that quote the words they ban)
python3 {baseDir}/scripts/ste-lint.py --strip-quotes draft.md
```

Score is **violations per 100 words**. Lower is cleaner. Report the before/after
honestly — including when the score barely moved.

## Modes

| Mode | Use for | Applies |
|---|---|---|
| **strict** (`--strict`) | procedures, runbooks, safety text, error messages, anything where a misreading has a cost | every rule, both length caps, one-meaning vocabulary |
| **flavored** (default) | READMEs, PR text, docs, vault notes | sentence, paragraph, active-voice and no-phrasal-verb discipline. Relaxes the vocabulary lockdown so prose keeps enough range to read naturally |

Default to flavored. Full strict mode on ordinary prose produces text that is
correct and lifeless.

## Rules

**Words**
- One name for one thing. Never call the same item two things.
- Prefer the short common word: `start` not begin/commence/initiate · `use` not
  utilize/leverage · `help` not facilitate · `make sure` not ensure · `before`
  not prior to · `after` not subsequent to · `about` not regarding · `get` not
  obtain/acquire · `show` not demonstrate · `also` not additionally/furthermore/moreover.
- One meaning per word. `fall` means move down, never decrease.
- No marketing adjectives: seamless, robust, powerful, cutting-edge, effortless,
  world-class, next-generation, revolutionary, battle-tested, blazing.

**Verbs**
- Active voice. "the parser reads the file", not "the file is read by the parser".
- A verb for an action. `analyze the log`, not `perform an analysis of the log`.
- No stacked auxiliaries. Not "it is important to note that this may help to
  improve X". Write "this improves X".
- No phrasal verbs: spin up, reach out, dive into, kick off, circle back.

**Sentences**
- One instruction per sentence. Max 20 words for instructions, 25 for descriptive.
- No contractions in strict mode. Keep articles: a, an, the, this, these.

**Punctuation**
- No semicolons. Write two sentences.
- Note: **STE does not ban the em dash** — only the semicolon. If you want em
  dashes gone that is a separate house-style choice, not an STE rule.

**Structure**
- One topic per paragraph, max six sentences.
- For steps use a numbered vertical list, one action per item, imperative form.
- Put a condition before its command: "If the build fails, check the log."

Write only the requested text. No preamble, no summary, no closing remarks.

## Self-lint before returning text

Run this checklist on your own output **before** you hand it back, whether or not
you can execute the linter. This is the portable half of the skill.

1. Any sentence over 20 words? Split it.
2. Any semicolon? Make it a period.
3. Any contraction, in strict mode? Expand it.
4. Any passive voice with a known actor? Make it active.
5. Any `-ing` main verb, nominalization ("perform an analysis"), or phrasal verb
   ("spin up")? Replace with a plain verb.
6. Same thing named two ways? Pick one name.
7. Any adjective that claims quality instead of showing it? Cut it.

## What this cannot do

STE fixes the **form** of slop, not the substance. A linter turns a hollow
paragraph into a clean, well-punctuated hollow paragraph. It cannot make it true.
Slop is two problems wearing one coat — bad writing, and nothing to say. This
addresses the first only.

The linter is heuristic, not a certified STE checker. The judgment rules of
ASD-STE100 need a human. Three known limits. Passive-voice detection over-counts
adjectival participles such as "is complicated". Colons split sentences, which
hides some over-length ones. The linter does not strip markdown tables or URLs,
so structured notes score high for reasons unrelated to prose. Treat the score as
a signal, not a grade.

## Attribution

Rules distilled from **ASD-STE100 Issue 9**, free at <https://asd-ste100.org>.
Do not paste the standard in full — it is copyrighted and 434 pages.

`scripts/ste-lint.py` is a corrected fork of `ste-lint.py` from
[woosal1337/blog](https://github.com/woosal1337/blog) @ `b912d5f`, MIT,
© 2026 Ege Çelebi. See the header in that file for the fixes applied.
