---
description: Hand a described task off to Gemini (Gemini 3.1 Pro), then review its output before anything is applied
argument-hint: '<task description> [--dir <path>] [--read-only] [--flash]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Task, Bash(node:*), Bash(git:*), AskUserQuestion
---

Delegate a self-contained coding or analysis task to Google's Gemini CLI, then have Claude review what Gemini produced before it is trusted or applied.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraints:
- Gemini runs **in the user's repo** (or a directory they name). By default Gemini may write files (`--yolo`), so treat its output as a proposal to be reviewed, not as automatically correct.
- If `--read-only` is present, do NOT give Gemini write permission — frame the task as analysis/plan only and omit `--yolo`.
- Keep the heavy lifting out of the main conversation: **route the actual Gemini run through the `gemini-executor` subagent** via the `Task` tool so multi-thousand-line output does not flood this context.

Step 1 — Confirm availability:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-run.mjs" check
```
If missing/unauthenticated, stop and direct the user to `/gemini:setup`.

Step 2 — Assemble a **self-contained** task brief. Gemini does not share Claude's conversation, so gather what it needs:
- The task description from `$ARGUMENTS` (strip routing flags `--dir`, `--read-only`, `--flash`).
- The relevant directory: `--dir <path>` if given, else the repo root.
- Enough context: name the key files Gemini should read (use `@path/to/file` references in the prompt, which Gemini expands), the acceptance criteria, and any constraints (language, style, "do not touch X").
- Forceful execution language so YOLO mode actually acts: end the brief with "Apply the changes now. Do not ask for confirmation."

Step 3 — Launch the `gemini-executor` subagent with the `Task` tool. Pass it a single instruction containing:
- the assembled brief,
- the target directory,
- whether this is write-capable (default) or `--read-only`,
- model choice (`gemini-3.5-flash` if `--flash`, otherwise leave default = Gemini 3.1 Pro).

The executor is responsible for constructing and running the `gemini-run.mjs` invocation (with `--yolo` and `--include-directories <dir>` for write tasks) and returning a concise report of what Gemini did or proposed.

Step 4 — When the subagent returns, **review Gemini's work before endorsing it**:
- If Gemini wrote files, run `git diff` (or `git status`) to see exactly what changed and summarize it for the user.
- Sanity-check for correctness, security, and scope creep. Flag anything suspicious.
- Present the user a clear choice: keep, adjust, or revert (`git checkout -- <files>`). Do not silently accept Gemini's changes as final.
