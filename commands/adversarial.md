---
description: Red-team review — Gemini assumes the code is broken and hunts for concrete bugs, security holes, and design flaws
argument-hint: '[--base <ref>] [--staged] [focus text ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Get an adversarial, skeptical review from Gemini. Unlike `/gemini:review`, this framing tells Gemini to *assume the code is wrong* and to challenge the approach, not just polish it.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraints:
- **Review-only.** Do not fix, patch, or imply upcoming changes. Gather the diff, send it to Gemini, relay findings.
- Report only **concrete findings with file:line**. Suppress vague "consider maybe" hand-waving — if Gemini returns fluff, say so.

Step 1 — Confirm availability:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-run.mjs" check
```
If missing/unauthenticated, stop and direct the user to `/gemini:setup`.

Step 2 — Determine scope exactly as in `/gemini:review`: default working tree; `--staged` for staged-only; `--base <ref>` for branch diff; trailing words are extra focus.

Step 3 — Send an adversarial prompt with the diff on stdin:
```bash
DIFF=$(git diff HEAD 2>/dev/null; git diff --cached 2>/dev/null)
printf '%s' "You are a hostile senior engineer doing a red-team review. ASSUME this code is broken and unsafe until proven otherwise. Your goal is to break it. Find: real bugs, race conditions, security vulnerabilities (injection, XSS, auth bypass, unsafe deserialization, secrets), unhandled errors, broken edge cases, incorrect assumptions, and design choices that will fail under real-world load or malicious input. Also challenge whether this is even the right approach. For EACH finding: file:line, severity, a concrete exploit/failure scenario, and the fix. No praise. No generic advice. Only concrete, defensible findings. [EXTRA FOCUS: <insert focus text or 'none'>]

--- DIFF ---
$DIFF" | node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-run.mjs" run --stdin --text
```
Match the `git diff` command to the chosen scope.

Step 4 — Relay Gemini's findings. Do not soften them and do not fix them unless asked. If the user wants to act on a finding, offer to do so as a separate follow-up.
