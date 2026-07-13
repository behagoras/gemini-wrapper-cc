# gemini-plugin-cc

A Claude Code plugin that delegates work to **Google's Gemini CLI** (Gemini 3.1 Pro). It's the Gemini analog of OpenAI's [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc): from inside any Claude Code workflow you can hand off code reviews, adversarial second opinions, web-grounded research, and full task delegation to Gemini.

## Why

Claude and Gemini have different strengths. Gemini brings **live Google Search grounding** (`google_web_search`), a dedicated **`codebase_investigator`**, and a genuinely different perspective for catching bugs. This plugin makes reaching for that a single slash command, and keeps Gemini's (sometimes huge) output out of your main Claude context by routing heavy work through a dedicated subagent.

## Commands

| Command | What it does |
|---|---|
| `/gemini:setup` | Check whether the Gemini CLI is installed and authenticated; offer to install it. |
| `/gemini:review` | Send the current git diff (working tree, `--staged`, or `--base <ref>`) to Gemini for a structured code review. |
| `/gemini:adversarial` | Red-team review — Gemini assumes the code is broken and hunts for concrete bugs, security holes, and design flaws (file:line). |
| `/gemini:delegate` | Hand a described task to Gemini, run it in your repo, then have Claude review Gemini's output before you apply it. |
| `/gemini:search` | Ask a web-grounded question via Gemini's `google_web_search`, with cited sources. |

A `gemini-executor` subagent does the actual CLI runs for delegation so large output stays out of the main conversation, and a bundled `gemini-cli` skill carries the CLI reference, prompt templates, and integration patterns.

## Skills

| Skill | What it does |
|---|---|
| `gemini-cli` | Reference material (CLI flags, prompt templates, integration patterns) backing the commands above. |
| `run-prompt-gemini` | Runs a saved `./.prompts/**/*.md` spec (the `create-prompt`/`run-prompt` convention) through Gemini instead of a Claude sub-agent. |

### `run-prompt-gemini`

If you use the `run-prompt` convention (prompts saved under `./.prompts/<category>/NNN-name.md`, archived to `completed/` on success), `run-prompt-gemini` is the Gemini-executor twin of `/run-prompt`: same file resolution, same numbering/partial-name matching, same `--parallel`/`--sequential` semantics, same archive-and-commit lifecycle — but the actual work runs on Gemini via `scripts/gemini-run.mjs` instead of a Claude `general-purpose` sub-agent. It also adapts the (Claude-flavored) saved prompt for Gemini before dispatch — instructions moved to the end, inputs labeled, broad negatives turned positive — and never grants `--yolo` for secrets/env or irreversible/side-effecting work without explicit confirmation.

This is the piece that lets a task-routing skill like `orchestrate-work` (free Gemini vs. metered Claude) treat "run this saved spec" as a first-class Gemini route instead of always spending a Claude sub-agent on it: saved prompt → adapted for Gemini → dispatched through this plugin's helper → verified → archived → (if the caller logs savings, e.g. `orchestrate-work`'s `~/.orchestrator/memory-work.jsonl`) logged. This plugin has no dependency on `orchestrate-work` — the skill works standalone — but its `description` frontmatter and lifecycle are written so an orchestration skill can route to it deterministically.

## Prerequisites

1. **Node 18+**
2. **Gemini CLI** installed:
   ```bash
   npm install -g @google/gemini-cli
   ```
3. **Authentication** (one-time, manual — the plugin can't do this for you):
   ```bash
   gemini              # run once, complete the interactive sign-in
   # — or —
   export GEMINI_API_KEY=your_key
   ```
4. Verify:
   ```bash
   gemini --version
   ```

Run `/gemini:setup` any time to confirm the CLI is ready. Every command degrades gracefully: if `gemini` isn't on PATH or auth fails, you get the exact steps to fix it instead of a cryptic error — nothing is sent to Gemini.

## Install

This repo doubles as its own Claude Code marketplace (`.claude-plugin/marketplace.json` at the root).

**From GitHub:**
```
/plugin marketplace add behagoras/gemini-plugin-cc
/plugin install gemini@gemini-plugin-cc
```

**From a local clone** (works without pushing anywhere):
```
/plugin marketplace add /path/to/gemini-plugin-cc
/plugin install gemini@gemini-plugin-cc
```

Then restart Claude Code if prompted, and run `/gemini:setup`.

## Usage examples

```
/gemini:review
/gemini:review --base main focus on the new auth middleware
/gemini:adversarial --staged
/gemini:search what changed in the Vite 7 config format? --flash
/gemini:delegate write pytest tests for src/parser.py covering malformed input --dir .
/gemini:delegate audit this repo for hardcoded secrets --read-only
```

Notes:
- `/gemini:delegate` gives Gemini write access (`--yolo`) by default; Claude reviews the resulting `git diff` before you keep it. Use `--read-only` for analysis-only runs.
- Append `--flash` where offered to use the faster/cheaper `gemini-3.5-flash` model instead of the default Gemini 3.1 Pro.

## How it works

Every command routes through `scripts/gemini-run.mjs`, which:
- checks `gemini` is on PATH and probes auth (`check` subcommand),
- builds the invocation (model, `--yolo`, `--include-directories`, prompt via stdin),
- prefers `-o json` and extracts `.response`, falling back to `-o text`,
- caps printed output so long responses don't flood Claude's context,
- detects auth/quota failures and prints actionable guidance,
- **streams every run live to a per-run log dir** so you can watch Gemini work.

## Observability: watch Gemini work

Gemini used to be a black box — nothing visible until the final response. Now every `run` creates a directory under `~/.gemini-runs/` (override with `GEMINI_RUNS_DIR`):

```
~/.gemini-runs/20260705-143012123-run-a1b2c3d4e5f6/
├── run.log        # combined stdout+stderr, streamed live as chunks arrive (uncapped)
├── meta.json      # model, timing, exit code, status; no prompt or argv by default
├── response.txt   # final extracted response (uncapped)
└── stream.jsonl   # raw stream-json events (only with --stream)
```

The `run.log` path is printed **immediately at launch**, so you can follow along:

```bash
tail -f ~/.gemini-runs/<run-dir>/run.log
```

**`--stream`** switches Gemini to its `-o stream-json` output, so the log shows tool calls and assistant output the moment they happen (`[tool_use] google_web_search {...}`, then the response text as it streams). This is the recommended way to run anything you want to watch. **`--debug`** additionally passes the CLI's `-d` flag. **`--timeout <secs>`** overrides the 30-minute cap.

Run storage is private even under a permissive umask: the root and run directories are forced to `0700`, and artifacts to `0600`. Names use millisecond time plus a random suffix and never derive from prompt text. Prompt previews and process arguments are not persisted. `--diagnostics` is an explicit opt-in that records only redacted prompt length and arguments. Because `run.log`, `response.txt`, and opt-in `stream.jsonl` contain model/tool output, treat the run root as sensitive.

Retention is bounded to the newest 100 recognized runs and 30 days by default. Override with positive integer `GEMINI_RUN_MAX_ENTRIES` and `GEMINI_RUN_MAX_AGE_DAYS` values. Cleanup only considers runner-owned directory names inside `GEMINI_RUNS_DIR`; unrelated entries are untouched.

> Honest caveat: in plain `-o text`/`-o json` modes the Gemini CLI buffers most of its stdout until the end when not attached to a TTY, so `run.log` mainly grows at completion; stderr (and `--debug` output) still flows live. For true live output, use `--stream`.

List recent runs without opening files:

```bash
node scripts/gemini-run.mjs logs --last 10
# status, duration, model, exit code, and log path per run
```

### Statusline: zero-token live indicator

`scripts/gemini-statusline.mjs` shows the active Gemini run in Claude Code's statusline — elapsed time plus the last tool call (`✦ gemini ▶ 34s · [tool_use] google_web_search {...}`), then `✔/✖` for a minute after it finishes. It reads `meta.json` + the log tail; no model involved, zero tokens. Statusline is a user-level setting, so add to `~/.claude/settings.json` (absolute path — `${CLAUDE_PLUGIN_ROOT}` doesn't resolve there):

```json
"statusLine": { "type": "command", "command": "node /path/to/gemini-plugin-cc/scripts/gemini-statusline.mjs" }
```

### Direct vs executor: pick the cheap path

Two ways to run a delegation:

- **Direct (default):** Claude launches `gemini-run.mjs` in a background Bash and hands you the `tail -f` line. Costs zero extra Anthropic tokens.
- **`gemini-executor` subagent:** a Sonnet wrapper that launches Gemini and summarizes its output. Launching it costs ~15–30k input tokens, so it's reserved for runs whose output is huge and must be summarized away from the main context.

The bundled skill and commands teach Claude to default to the direct path.

## Updating an installed plugin

Merging a PR does **not** update machines that already have the plugin installed — Claude Code runs the copy in its plugin cache. After a release:

```
/plugin marketplace update gemini-plugin-cc
/plugin update gemini@gemini-plugin-cc
```

(or uninstall/reinstall), then restart Claude Code if prompted. Verify with `/gemini:setup` or by checking that `gemini-run.mjs logs` exists in the installed copy.

## Credits & license

MIT. The bundled `gemini-cli` skill's reference material is adapted from [`forayconsulting/gemini_cli_skill`](https://github.com/forayconsulting/gemini_cli_skill) (MIT). Structure and UX are modeled on [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc).
