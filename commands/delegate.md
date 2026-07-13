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
- **Choose the cheapest execution path that fits** (see the gemini-cli skill's "Direct path" section):
  - **Direct (default for bounded tasks):** launch `gemini-run.mjs run --stream ...` yourself via `Bash(run_in_background: true)`. The helper prints a live log path immediately — relay it to the user as a `tail -f` command so they can watch Gemini work. Read the printed response (or `response.txt`) when it finishes. Zero subagent cost.
  - **Executor subagent (only for huge output):** route through the `gemini-executor` subagent via `Task` when Gemini's output is expected to be multi-thousand-line and must be summarized away from this context. The subagent itself costs a Sonnet launch, so don't use it for trivial runs.

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

Step 3 — Execute via the path chosen above.

**Direct path** (default): launch in the background and surface the log immediately:
```bash
printf '%s' "$BRIEF" | node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-run.mjs" run --stream [--yolo] [--include <dir>] [--model gemini-3.5-flash] --stdin
```
(`--yolo --include <dir>` for write tasks; `--model gemini-3.5-flash` if `--flash`, else leave default = Gemini 3.1 Pro.) Tell the user the `tail -f` line the helper printed, then poll the background task.

**Executor path** (huge output only): launch the `gemini-executor` subagent with the `Task` tool. Pass it a single instruction containing the assembled brief, the target directory, write-capable vs `--read-only`, and the model choice. The executor constructs and runs the `gemini-run.mjs` invocation and returns a concise report including the run's log path.

Step 4 — When the subagent returns, **review Gemini's work before endorsing it**:
- If Gemini wrote files, run `git diff` (or `git status`) to see exactly what changed and summarize it for the user.
- Sanity-check for correctness, security, and scope creep. Flag anything suspicious.
- Present the user a clear choice: keep, adjust, or revert (`git checkout -- <files>`). Do not silently accept Gemini's changes as final.
