---
name: gemini-cli
description: Orchestrate Google's Gemini CLI from Claude Code — for second-opinion code review, web-grounded research via google_web_search, codebase_investigator analysis, and delegated code generation. Use when a task benefits from a different AI's perspective, current internet information, or offloaded parallel work. Backs this plugin's /gemini:* commands and the gemini-executor agent.
allowed-tools:
  - Bash
  - Read
  - Write
  - Grep
  - Glob
---

# Gemini CLI Integration

This skill teaches Claude how to drive Google's Gemini CLI (`@google/gemini-cli`, v0.16+; default model Gemini 3.1 Pro) as an auxiliary tool. It backs the `/gemini:*` commands and the `gemini-executor` agent in this plugin.

## Current models (verified July 2026)

Model names change often; confirm what's live with `gemini --list-models` (or the model picker) before hardcoding one. As of this writing:

| Role in this plugin | Model | Notes |
|---|---|---|
| **Heavy / default** | `gemini-3.1-pro` | Complex reasoning, reviews, multi-file work. Leave `-m` unset to use the CLI default (currently this). |
| **Fast / cheap** (`--flash`) | `gemini-3.5-flash` | Good default for quick or lower-priority tasks. |
| **Lite / trivial** | `gemini-3.1-flash-lite` | Cheapest; one-liners, formatting, cheap auth probes. |
| Also available | `gemini-3-flash-preview`, `gemini-2.5-pro`, `gemma-4-31b-it`, `gemma-4-26b-a4b-it` | Use explicitly if a task calls for them. |

> **Credit:** the reference material in this skill (`references/reference.md`, `references/templates.md`, `references/patterns.md`, `references/tools.md`) is adapted from the excellent [`forayconsulting/gemini_cli_skill`](https://github.com/forayconsulting/gemini_cli_skill) (MIT). This plugin repackages it as an installable plugin and wraps the raw CLI in a helper script for reliability.

## Prefer the plugin helper

Inside this plugin, do not hand-roll raw `gemini` command strings. Use the helper, which checks availability, prefers `-o json` with a `-o text` fallback, caps output size, and turns auth/quota failures into actionable guidance. If `${CLAUDE_PLUGIN_ROOT}` is not set in the session (it only exists inside plugin command context), resolve the script's absolute path instead — the installed plugin cache (`~/.claude/plugins/cache/gemini-plugin-cc/gemini/<version>/scripts/gemini-run.mjs`) or the local checkout:

```bash
# availability + auth probe
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-run.mjs" check

# a run (prompt after --, or piped with --stdin)
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-run.mjs" run [--model <m>] [--yolo] [--include <dir>] [--stream] --stdin

# list recent runs (status, duration, log path)
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-run.mjs" logs [--last <n>]
```

Raw `gemini` invocations (below) are documented so you understand what the helper does and can fall back if needed.

## Observability: every run has a live log

Every `run` writes a per-run directory under `$GEMINI_RUNS_DIR` (default `~/.gemini-runs/`):

- `run.log` — combined stdout+stderr, streamed **live** as chunks arrive (uncapped)
- `meta.json` — model, start/end time, duration, exit code, and status; no prompt or argv by default
- `response.txt` — the final extracted response (uncapped)
- `stream.jsonl` — raw `stream-json` events (only with `--stream`)

The helper prints the `run.log` path on stdout **immediately at launch**, before Gemini finishes. Always relay that path to the user so they can `tail -f` it. Add `--stream` for real runs the user wants to watch: it switches Gemini to `-o stream-json` (available in CLI v0.46+; confirmed live on 0.46.0 and 0.49.0), so tool calls (`[tool_use] google_web_search {...}`) and assistant output land in the log the moment they happen. `--debug` additionally passes the CLI's `-d` flag for its internal debug output. `--timeout <secs>` overrides the 30-minute cap.

The run root and per-run directories are forced to `0700`; artifact files are `0600`, independent of umask. Run IDs combine millisecond time with a random suffix and do not contain prompt text. `--diagnostics` is opt-in and records only redacted prompt length/arguments. The runner retains at most 100 recognized runs for 30 days by default (`GEMINI_RUN_MAX_ENTRIES`, `GEMINI_RUN_MAX_AGE_DAYS`). Treat output logs as sensitive because model and tool output may reproduce input content.

## Direct path vs the gemini-executor agent

**Default to the DIRECT path** for simple or observable runs — it costs zero Anthropic subagent tokens:

1. Launch via Bash with `run_in_background: true`:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-run.mjs" run --stream --include <dir> --stdin
   ```
2. Immediately tell the user the log path the helper printed, formatted as a `tail -f` command they can paste.
3. **Narrate progress like a native subagent:** in `--stream` mode the helper mirrors tool calls and assistant text to its stderr, so the background shell's output pane shows the run live and every `BashOutput` poll returns the new events. Poll every ~10–15s and relay briefly what Gemini is doing ("corriendo google_web_search…", "escribiendo la respuesta…"). If `BashOutput` isn't available in the session, poll with `Read` on the background task's output file (same information) — this fallback is proven to work. Pass `--quiet` to disable the mirror if the caller only wants the log file.
4. When the background task completes, read the printed response (already capped by `--max-chars`), or `response.txt` for the full text.

**Use the `gemini-executor` subagent only when it earns its ~15–30k-token launch cost**: when Gemini's output is expected to be huge and must be *summarized away* from the main context (e.g. a full-repo analysis dump), or when several Gemini runs need orchestrating with their own scratch context. For a single bounded run, the direct path is strictly better: cheaper, and the user can watch it live.

## When to use Gemini

Good fits:
- **Second opinion / cross-validation** — review code Claude (or the user) wrote; catch bugs from a different vantage point.
- **Google Search grounding** — current library versions, recent releases, API changes, anything past Claude's knowledge cutoff. Gemini's `google_web_search` is its standout capability.
- **Codebase architecture analysis** — Gemini's `codebase_investigator` maps unfamiliar repos and cross-file dependencies.
- **Parallel / offloaded generation** — test suites, docs, boilerplate, while Claude keeps working.

Skip Gemini for: trivial tasks (overhead not worth it), work needing tight interactive refinement, or anything where Claude already holds the full context.

## Core invocation

```bash
gemini -p "<prompt>" -o text            # human-readable
gemini -p "<prompt>" -o json            # structured; parse .response and .stats
gemini -p "<prompt>" --yolo -o text     # auto-approve tool calls (needed to actually write files)
gemini -p "<prompt>" -m gemini-3.5-flash -o text   # faster/cheaper model
gemini -p "<prompt>" --include-directories <dir> -o text  # add context
```

Key flags: `--yolo`/`-y` (auto-approve), `-o text|json`, `-m <model>`, `--include-directories <dir>`, `-p` (non-interactive prompt). You can also pipe the prompt: `printf '%s' "$BIG_PROMPT" | gemini -o text`.

**YOLO still plans.** `--yolo` auto-approves tool calls but Gemini may still present a plan and ask "look good?". End delegated prompts with forceful language: "Apply the changes now. Do not ask for confirmation."

## Model selection (Pro vs Flash)

```
Is the task complex (architecture, multi-file, deep reasoning, security review)?
├── Yes → default model (Gemini 3.1 Pro) — leave -m unset
└── No  → speed/cost matters?
         ├── Yes → -m gemini-3.5-flash
         └── Trivial (formatting, one-liners) → -m gemini-3.1-flash-lite
```

## Rate limits

Free tier ≈ 60 req/min, 1000 req/day. The CLI auto-retries with backoff ("quota will reset after Xs"). Mitigations: use Flash for lower-priority work (separate quota), batch related asks into one prompt, and run long tasks in the background. The helper detects quota messages and tells you to retry or switch to Flash.

## Graceful degradation

If `gemini` is not on PATH or auth fails, the helper prints exact install/auth steps and exits non-zero (3 = not installed, 4 = not authenticated, 5 = untrusted folder). **Folder trust:** in a directory Gemini hasn't seen before (fresh clones, new worktrees), the CLI's folder-trust check blocks non-interactive runs — add `--trust` to the helper invocation (passes `--skip-trust`), or set `GEMINI_CLI_TRUST_WORKSPACE=true` in the environment. Never let a raw failure leak — route through the helper, or run `/gemini:setup`. Auth (`gemini` run once interactively, or `GEMINI_API_KEY`) is a one-time manual step the user must do themselves.

## Output handling

Prefer JSON and extract `.response`; fall back to text if parsing fails (the helper does this automatically). Never paste multi-thousand-line Gemini output into the main context — the helper caps what it prints (`--max-chars`) and keeps the full text in `response.txt`; reserve the `gemini-executor` agent for output that must be summarized away entirely.

## Reference files

- `references/reference.md` — full CLI flag, output-format, session, and config reference.
- `references/templates.md` — ready-to-use prompt templates (review, tests, docs, research, refactor).
- `references/patterns.md` — integration patterns (generate-review-fix, background execution, cross-validation).
- `references/tools.md` — Gemini's built-in tools, especially `google_web_search`, `codebase_investigator`, `save_memory`.
