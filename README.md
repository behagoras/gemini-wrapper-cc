# gemini-plugin-cc

A Claude Code plugin that delegates work to **Google's Gemini CLI** (Gemini 3 Pro). It's the Gemini analog of OpenAI's [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc): from inside any Claude Code workflow you can hand off code reviews, adversarial second opinions, web-grounded research, and full task delegation to Gemini.

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
/plugin marketplace add davbelom/gemini-plugin-cc
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
- Append `--flash` where offered to use the faster/cheaper `gemini-2.5-flash` model instead of the default Gemini 3 Pro.

## How it works

Every command routes through `scripts/gemini-run.mjs`, which:
- checks `gemini` is on PATH and probes auth (`check` subcommand),
- builds the invocation (model, `--yolo`, `--include-directories`, prompt via stdin),
- prefers `-o json` and extracts `.response`, falling back to `-o text`,
- caps printed output so long responses don't flood Claude's context,
- detects auth/quota failures and prints actionable guidance.

## Credits & license

MIT. The bundled `gemini-cli` skill's reference material is adapted from [`forayconsulting/gemini_cli_skill`](https://github.com/forayconsulting/gemini_cli_skill) (MIT). Structure and UX are modeled on [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc).
