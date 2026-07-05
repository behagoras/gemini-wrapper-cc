---
description: Run a Gemini code review against the current git diff (staged, working tree, or vs a base branch)
argument-hint: '[--base <ref>] [--staged] [focus text ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Get a second-opinion code review from Google's Gemini CLI on the current changes.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraints:
- This command is **review-only**. Do not fix issues, apply patches, or imply you are about to make changes. Your job is to gather the diff, send it to Gemini, and relay Gemini's findings.
- Do not paraphrase away Gemini's specific file:line references — preserve them.

Step 1 — Confirm Gemini is available:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-run.mjs" check
```
If this reports the CLI is missing or unauthenticated (exit 3 or 4), stop and show the user exactly what to run (or point them at `/gemini:setup`). Do not continue.

Step 2 — Determine the review scope from `$ARGUMENTS`:
- Default: the working-tree diff. Gather it with `git diff` (unstaged) plus `git diff --cached` (staged), and note untracked files via `git status --short --untracked-files=all`.
- `--staged`: use only `git diff --cached`.
- `--base <ref>`: use `git diff <ref>...HEAD`.
- Any remaining words are extra focus instructions for the reviewer (e.g. "focus on the auth flow").
If the relevant diff is empty and there are no untracked files, tell the user there's nothing to review and stop.

Step 3 — Build the review prompt. Capture the diff into a variable and pass it to Gemini via stdin so large diffs are handled cleanly:
```bash
DIFF=$(git diff HEAD 2>/dev/null; git diff --cached 2>/dev/null)
printf '%s' "You are a senior code reviewer. Review the following git diff. For each finding give: file:line, severity (blocker/major/minor/nit), the problem, and a concrete fix. Group by severity. Cover correctness bugs, security issues, error handling, edge cases, and API misuse. Be specific and skip praise. [EXTRA FOCUS: <insert focus text or 'none'>]

--- DIFF ---
$DIFF" | node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-run.mjs" run --stdin --text
```
Adjust the `git diff` command in the snippet to match the scope chosen in Step 2 (`--cached` only for `--staged`, `<ref>...HEAD` for `--base`).

Step 4 — Relay Gemini's output to the user as a structured review. Keep it concise; if the output is very long the wrapper will truncate it and tell you. Do not act on the findings yourself unless the user asks.
