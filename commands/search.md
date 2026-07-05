---
description: Ask Gemini a web-grounded question using its built-in google_web_search tool
argument-hint: '<question> [--flash]'
allowed-tools: Bash(node:*)
---

Answer a question that needs current, web-grounded information by delegating to Gemini's `google_web_search` tool — something Claude's own knowledge cutoff can't cover as freshly.

Raw slash-command arguments:
`$ARGUMENTS`

Step 1 — Confirm availability:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-run.mjs" check
```
If missing/unauthenticated, stop and point the user at `/gemini:setup`.

Step 2 — Run the grounded query. Strip any `--flash` token from the question and, if present, add `--model gemini-3.5-flash` for a faster/cheaper answer:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-run.mjs" run --text -- "Use google_web_search to answer with current information. Cite the sources (URLs) you used. Question: <QUESTION HERE>"
```
Replace `<QUESTION HERE>` with the user's question (minus routing flags). Keep the instruction to use `google_web_search` and to cite URLs — that is the whole point of routing this to Gemini.

The helper prints a live log path (`[gemini-run] live log: ...`) at launch. For slow searches, add `--stream` and run in the background so the user can `tail -f` the log and watch the `google_web_search` tool calls happen.

Step 3 — Relay Gemini's answer, preserving the cited source URLs so the user can verify. If Gemini returns no sources, note that the answer is ungrounded.
