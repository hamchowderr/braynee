# foundation-first

Plain-language Claude Code skills for building on what already exists instead of starting from scratch. They work for anyone, technical or not: ask your AI a normal question and the right skill guides the answer.

| Skill | What it does |
|---|---|
| `find-the-foundation` | Finds open-source projects and official tools that already do most of the job, and checks who maintains them, how alive they are and what their licence allows. |
| `look-under-the-hood` | Explains what a product is built on, and what that means for free testing, lock-in and leaving later. |
| `read-every-source` | Answers from more than one source: official docs and their AI-readable version, the platform's own skills and MCP servers, the code itself, and the changelog and issues. |
| `build-on-it` | Picks the lightest way to build on a project: use it, configure it, extend it or fork it. Explains forking in plain words. |
| `test-free-locally` | Finds the free, local way to try a tool before paying: local stacks, test modes, emulators and in-browser versions. |
| `use-the-official-library` | Uses a service's official library instead of hand-written API calls, and explains the difference. |
| `write-your-rules` | Turns how you work into a short rules file your AI reads first, and adds a line or a check after every mistake. |
| `track-every-job` | Gives every piece of work a tracked issue, linked to its change and closed when it's live. |
| `research-again` | Looks back at what was built and checks whether something better exists now. |

## Install

```
/plugin marketplace add hamchowderr/braynee
/plugin install foundation-first@braynee
```

Skills run as `/foundation-first:<name>`, and Claude also picks them up on its own when your question matches. On claude.ai, add the `hamchowderr/braynee` marketplace under Customize → Plugins to use them in cloud sessions.
