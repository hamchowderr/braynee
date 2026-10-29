---
name: resume-review
description: "Grade a résumé against an evidence-based 100-point rubric built from university career-center and recruiter research (MIT, CMU, Harvard, Stanford, Berkeley, CareerOneStop, Laszlo Bock, the Ladders eye-tracking studies, Workday and Greenhouse ATS docs). Use when the user asks to \"grade my resume\", \"audit my resume\", \"review my résumé\", \"score this CV\", \"is my resume good\", \"what grade would this resume get\", or wants a résumé checked before applying to a job."
---

# Résumé Review

Grades a résumé on 9 categories worth 100 points total. Returns the grade, the evidence behind each score, and fixes in priority order. The full rubric, with a sourced quote behind every check, is in `references/rubric.md`. Read it before scoring.

## Inputs

- **The résumé file:** PDF, HTML, DOCX or Markdown.
- **The target job posting**, if there is one. Without one, score Target fit against the role named in the headline, and say so.
- **The user's standing résumé rules**, if they recorded any (memory, CLAUDE.md or a note they point to). These are fixed decisions. Note a tradeoff once, but never score against them or recommend reversing them.

## Steps

1. Read `references/rubric.md`.
2. Extract what an applicant tracking system sees: `pdftotext -layout <file>.pdf -` (from Poppler). Count the pages, and check that symbols and bullets survive extraction.
3. Read the posting and list its must-have keywords.
4. Score every check:
   - 1 means pass, 0.5 means one minor defect, 0 means fail.
   - Countable checks score the proportion (for example, 13 of 16 bullets open with a verb).
   - Category score = weight × points ÷ number of checks.
5. **Apply the gate.** If a skimming recruiter would read any claim as materially different from the facts (most often a years-of-experience figure), cap the grade at C until it is fixed.
6. Before calling a claim wrong, check it against a source. When only the user can know, ask.

## Output

- **Grade and total**, and whether the gate tripped. Bands: A 90–100, B 80–89, C 70–79, D 60–69, F under 60.
- **A table** with columns category, weight, score and evidence. Quote the résumé's own text as the evidence.
- **Fixes in priority order.** Each fix uses facts already on the page. Mark anything only the user can confirm.
- **Plain words.** Put any questions at the end as a short numbered list. Each question must stand on its own: quote the résumé line it is about, and say what changes depending on the answer.

## Rules

- Never invent numbers, clients, dates or tools. When there are no outcome metrics, a scope count or a stated purpose still counts as valid evidence (CareerOneStop, Stanford).
- Never recommend what the rules file excludes, such as customer counts, revenue or an education section.
- A projected score after fixes is an estimate. Label it that way.
