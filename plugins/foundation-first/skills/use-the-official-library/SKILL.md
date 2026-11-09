---
name: use-the-official-library
description: >
  Before writing code that talks to an outside service (payments, email,
  storage, CRM, AI, auth), find and use the service's official library or SDK
  instead of hand-written API calls, and read its options first. Explains the
  difference in plain words. Use when the user asks to "connect to", "call the
  API", "integrate with", "send data to" a service, or when you are about to
  write fetch/axios/curl requests to a vendor's API.
---

# Use the official library

Almost every platform publishes at least one official library (SDK) for common
languages. Use it.

**A raw API call** means writing every request by hand: the address, the sign-in
details, what to send and how to read the answer. You also own the hard parts:
retrying when the service is busy, paging through long lists, checking a webhook
really came from the service, and noticing when they change something.

**The official library** does that for you, written by the people who run the
service. It's updated when the service changes, so you bump one version number
instead of rewriting code. Examples: Stripe's library verifies webhook
signatures in one call; Supabase's client keeps users signed in and refreshes
sessions.

## Steps

1. **Find the official library** for the user's language on the vendor's docs or
   their GitHub organisation. Check the package is published by the vendor
   (not a look-alike name).
2. **Read its options before writing code:** base URL, auth, retries, timeouts,
   custom storage, test or local mode. Most "it doesn't fit" problems are an
   option you haven't read yet.
3. **Point it at the free local or test version** for development (see
   `test-free-locally`).
4. **Only if no official library exists**, write the calls yourself, and say so
   plainly in the code comment or pull request.

## Rules

- Don't claim a library "doesn't support" something until you've read its
  options and types.
- Pin a version, and note where its changelog is.
- Never put keys in code; read them from environment variables or a secrets store.
