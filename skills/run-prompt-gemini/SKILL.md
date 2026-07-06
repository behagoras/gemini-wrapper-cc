---
name: run-prompt-gemini
description: Run one or more saved ./.prompts/ specs (the create-prompt / run-prompt convention) through Google's Gemini CLI instead of a Claude sub-agent — the free, unlimited executor route. Use when a user wants to run, execute, or delegate a saved prompt file to Gemini, or when an orchestration flow (e.g. orchestrate-work) needs a verifiable "run this saved spec on Gemini" primitive instead of spending metered Claude tokens. Mirrors /run-prompt's argument surface and lifecycle (resolve → adapt → dispatch → archive → commit) but swaps the general-purpose sub-agent for scripts/gemini-run.mjs.
argument-hint: '<prompt-number(s)-or-name> [--parallel|--sequential] [--flash] [--read-only]'
allowed-tools:
  - Read
  - Glob
  - Bash
  - Task
  - AskUserQuestion
---

# run-prompt-gemini

The Gemini analog of the `run-prompt` skill: same `./.prompts/` convention, same lifecycle, but the actual work runs on Google's Gemini CLI (free/unlimited on most setups) through this plugin's `scripts/gemini-run.mjs`, instead of a Claude `general-purpose` sub-agent. Use it to keep saved specs off the Claude meter when Gemini can do the job — the missing primitive `/orchestrate-work` needs to route a saved prompt to Gemini and prove it happened.

## Step 0 — Confirm Gemini is available

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-run.mjs" check
```

(If `${CLAUDE_PLUGIN_ROOT}` is unset — e.g. this skill is invoked outside a loaded plugin context — resolve the absolute path to this plugin's `scripts/gemini-run.mjs` yourself before calling it.)

- **Exit 0** → proceed.
- **Exit 3** (not installed) or **4** (not authenticated) → stop and print the check output verbatim. Do not fall back to a Claude sub-agent silently — that would defeat the point of this skill. Tell the user to run `/gemini:setup` or use plain `/run-prompt` instead.

## Argument surface

Same as `run-prompt`, plus two Gemini-specific pass-through flags:

- Empty → run the most recently modified prompt.
- A number (`"101"`, `"5"`) → search all category subfolders for a file starting with that number.
- Partial text (`"gemini-orchestration"`) → match on filename substring across subfolders.
- Multiple tokens (`"101 102 103"`) → multiple prompts; default **sequential**, add `--parallel` to fan out.
- `--flash` → dispatch on `gemini-3.5-flash` (`--model gemini-3.5-flash`) instead of the default `gemini-3.1-pro`. Use for bulk/simple prompts.
- `--read-only` → force read-only regardless of inferred intent (never add `--yolo`). Omitting it does **not** mean "always write" — see Step 3 for how write-capability is decided.

## Step 1 — Resolve the prompt file(s)

Identical resolution rules to `run-prompt`:

```bash
find ./.prompts -name '*.md' -not -path '*/completed/*' -not -name 'INDEX.md' | sort -t/ -k4 -rn
```

- Search recursively across `./.prompts/**/` category subfolders — never the root, never `completed/`, never `INDEX.md`.
- One match → use it. Multiple matches → list them and ask the user to pick. No matches → report the miss and list what's available (from `./.prompts/index.json` if present).
- Empty argument → the most recently modified match.

Read the full contents of each resolved file with `Read` before doing anything else.

## Step 2 — Adapt the prompt for Gemini

Saved specs are Claude-flavored: XML-tagged, front-loaded instructions, broad negative constraints ("do not X"). Gemini reads that shape worse than Claude does. Rewrite each prompt before dispatch — this is the same checklist `orchestrate-work`'s `gemini-adapter.md` applies, embedded here so this skill has no hard dependency on that skill being installed:

- **Direct and concise.** Strip politeness, persuasion, and Claude-style XML scaffolding. Keep the substance.
- **Instructions at the END**, after context/data, anchored with something like "Based on the entire spec above, do the following now."
- **Label every input explicitly** — "Spec (prompt 101): ...", "File 2 (schema): ..." — never "look at this."
- **No broad negatives.** Convert every "do not infer / do not touch X" into a positive statement of what source or scope to use instead.
- **Leave temperature/tuning alone** — Gemini's default is fine.
- **Terse by default** — if the task needs verbose/structured output, ask for it explicitly in the final instruction.
- **Hallucination-prone asks** (facts, version numbers, "does X exist") → two-step: verify it exists, then answer.

Produce one adapted prompt string per file. This is the string you will pipe to Gemini in Step 3 — do not send the raw, un-adapted spec.

## Step 3 — Decide write-capability (safety floor)

Default posture is **read-only** (the plugin helper's own default — `--yolo` is opt-in, never assumed).

Promote a run to write-capable (add `--yolo --include <target dir>`) only when:
1. The adapted prompt's own intent is clearly to create/modify/fix files in the repo, AND
2. `--read-only` was not passed on this invocation, AND
3. The task does **not** touch secrets/env files and is not irreversible or side-effecting (no pushes, no external API calls that leave the machine, no deletions of unrecoverable state).

If (3) fails — the task looks like it touches `.env`/credentials or does something irreversible — do not silently downgrade or silently proceed with `--yolo`. Use `AskUserQuestion` to get explicit confirmation before adding `--yolo`; if declined, run read-only and report that a human needs to apply the write.

This mirrors `orchestrate-work`'s safety floor and this plugin's own `/gemini:delegate` convention (`--yolo` by default is a proposal to be reviewed, not a rubber stamp).

## Step 4 — Dispatch

Direct path by default — no sub-agent, no extra Claude tokens spent launching one. Pipe the adapted prompt on stdin (handles embedded newlines/quotes cleanly) and launch with `Bash(run_in_background: true)`:

```bash
printf '%s' "$ADAPTED_PROMPT" | node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-run.mjs" run --stdin \
  [--model gemini-3.5-flash] \
  [--yolo] \
  --include "$(pwd)" \
  --text
```

Only the flags actually documented by `gemini-run.mjs` are used here: `run`, `--stdin`, `--model`/`-m`, `--yolo`/`-y`, `--include <dir>` (repeatable), `--text`/`--json` (default is JSON-with-text-fallback; force `--text` for simpler parsing in a script context), `--max-chars <n>`. Do not invent flags like `--stream` or `--timeout` — this script doesn't have them yet.

- Include `--model gemini-3.5-flash` only if `--flash` was passed.
- Include `--yolo` and `--include <dir>` only per the Step 3 decision; for read-only runs, omit both `--yolo` and (usually) `--include`, since Gemini can read the repo it's invoked in without it.
- Poll the backgrounded run (via `BashOutput` / the harness's background-task surface) instead of blocking the turn. Don't tail a run-log file — this script prints directly to stdout/stderr, it does not write `~/.gemini-runs/` session artifacts.
- **Huge-output exception:** if the prompt is likely to produce a very large response (e.g. "generate a full test suite", "audit the whole repo") and that output must be kept out of the main conversation, launch the `gemini-executor` sub-agent via `Task` instead of the raw Bash path, passing it the adapted prompt, target directory, write-capability decision, and model choice. It runs the identical `gemini-run.mjs` invocation and returns a summary.
- Multiple prompts in `--parallel` mode: launch one backgrounded Bash call per prompt, all in the same message (mirrors `run-prompt`'s "all Task calls in one message" rule, but with Bash calls since there's no sub-agent to spawn). `--sequential` (default for 2+ prompts): wait for each to finish before starting the next.

If the run exits non-zero, inspect the reason before deciding what to do:
- **3** (not installed) / **4** (auth) → infra problem, not a prompt problem. Surface the guidance from `gemini-run.mjs` verbatim and stop — do not archive, do not commit.
- **2** (usage) → this skill built a bad invocation; fix the command and retry once.
- Any other non-zero with real output → treat it as a failed run: do not archive that prompt, report the failure, and stop (mirrors `run-prompt`'s "if any prompt fails, stop sequential execution and report error").

## Step 5 — Archive on success

Only after a successful (exit 0) run:

```bash
mkdir -p "$(dirname "$PROMPT_FILE")/completed"
git mv "$PROMPT_FILE" "$(dirname "$PROMPT_FILE")/completed/$(basename "$PROMPT_FILE")"
```

Archive into the **category's own** `completed/` subfolder (e.g. `./.prompts/1xx-gemini-orchestration/completed/101-name.md`), never a root-level `./.prompts/completed/`. Use `git mv` when in a git repo (stages the move in one step); plain `mkdir -p` + `mv` if not.

## Step 6 — Commit (skip if not a git repo)

Check once with `git status --short 2>/dev/null || echo "not a git repo"`. If not a git repo, skip this step entirely and say so in the output — do not fail.

Otherwise:
- Stage only what you actually touched: the archived prompt move(s), and any repo files Gemini itself modified (`git status --short` in the target dir tells you which, if this was a write-capable run). Never `git add -A` / `git add .`.
- Commit message format: `[type]: [description]` (lowercase, specific, concise; `feat|fix|refactor|docs|chore|test` as appropriate).
- If Gemini's write run touched files, mention in the commit body (or the returned summary) that this was executed via Gemini, not Claude, so history stays honest about who wrote what.

## Output format

Match `run-prompt`'s blocks, naming Gemini as the executor:

**Single prompt:**
```
✓ Executed via Gemini (gemini-3.1-pro): ./.prompts/1xx-gemini-orchestration/101-name.md
✓ Archived to: ./.prompts/1xx-gemini-orchestration/completed/101-name.md

<results>
[Summary of what Gemini produced/concluded]
</results>
```

**Parallel:**
```
✓ Executed via Gemini in PARALLEL:
- ./.prompts/1xx-.../101-a.md
- ./.prompts/1xx-.../102-b.md

✓ All archived to their category's completed/ subfolder

<results>
[Consolidated summary per prompt]
</results>
```

**Sequential** (multiple prompts, no `--parallel`):
```
✓ Executed via Gemini SEQUENTIALLY:
1. ./.prompts/.../101-a.md → Success
2. ./.prompts/.../102-b.md → Success

✓ All archived

<results>
[Consolidated summary, in order]
</results>
```

If Gemini was unavailable (Step 0 failed), skip straight to reporting that — no execution, no archive, no commit block at all.

## Notes

- This skill never falls back to a Claude sub-agent on Gemini failure — that's a job for plain `/run-prompt`, or for `orchestrate-work`'s escalation policy (one corrected `--flash` retry, then escalate to Claude with a summary, never the raw transcript).
- Safety floor is non-negotiable: secrets/env files, irreversible ops, and side-effecting external actions never get `--yolo` without explicit human confirmation via `AskUserQuestion`, no matter how routine the saved prompt looks.
- Keep model names in sync with what's actually live (`gemini --list-models` or the CLI's own error messages) — as of this writing the plugin uses `gemini-3.1-pro` (default), `gemini-3.5-flash` (`--flash`), `gemini-3.1-flash-lite` (trivial probes only, not for real work).
