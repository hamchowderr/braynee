---
name: look-under-the-hood
description: >
  Explain what a tool, platform or product is built on underneath (for example
  Supabase is Postgres, Coolify runs Docker, many site builders are WordPress),
  and what that means for testing, cost, lock-in and leaving later. Use when the
  user asks "what is this built on", "what's under the hood", "can I leave this
  later", "am I locked in", "is there an open-source version", or is frustrated
  with a product and wants options.
---

# Look under the hood

Many products people pay for, and get frustrated with, are a layer on top of
something free and open. Knowing what is underneath tells the user how to test
it for free, how to leave later, and which skills they already have.

## Steps

1. **Name the layers.** What does the product add, and what does it run on
   (database, runtime, framework, CMS, open-source engine)? Check the product's
   own docs, its open-source repositories and its status or architecture pages.
2. **Say what that foundation is** in one plain sentence, and whether it is open
   source and under which licence.
3. **Answer the four questions:**
   - Can I test it for free on my own computer because of what it runs on?
   - If I stopped paying tomorrow, what would I need to run the same thing myself?
   - What could I take with me (data, code, content) and in what format?
   - What do I already know that transfers (for example: "it's just Postgres,
     so any Postgres skill applies")?
4. **Be fair to the product.** Say what it adds that is worth paying for
   (hosting, support, security, convenience). The goal is options, not
   talking the user out of a good tool.

## What to give the user

A short "layers" list (top to bottom), then the four answers in plain words,
then: keep using it, build on the foundation directly, or a mix, with the reason.

## Rules

- Only state what is underneath if you can point to where it says so.
- If the product is closed and doesn't say, say "not published" rather than guess.
- Use only what the company or project has published (docs, open repositories,
  official posts). Never reverse engineer, decompile or probe a closed product
  to find out what's inside.
