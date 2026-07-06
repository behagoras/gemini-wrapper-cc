<objective>
Make the `gemini-plugin-cc` wrapper (this repo) fully interoperable with the `/orchestrate-work` skill, and ship a new native skill `/run-prompt-gemini` that mirrors `/run-prompt` but delegates prompt execution to Gemini instead of a Claude `general-purpose` sub-agent.

End goal: a Claude Code user on the work machine can save prompts in `./.prompts/` (the create-prompt / run-prompt convention) and run them through Gemini — the free, unlimited executor — with the same UX as `/run-prompt`, so `/orchestrate-work` has a first-class, verifiable route for delegating saved prompts to Gemini. This is the missing "run a saved spec on Gemini" primitive that makes the orchestrate-work savings loop complete.

Deliver everything on a new branch as a pull request.
</objective>

<context>
This repo is a Claude Code plugin that delegates work to Google's Gemini CLI. Read `CLAUDE.md` if present, then `README.md` for the plugin's design and conventions.

Key existing pieces (examine before changing anything):
- `scripts/gemini-run.mjs` — the single entry point every command/agent uses to talk to the Gemini CLI. `check` and `run` subcommands; handles `--model`, `--yolo`, `--include`, `--stdin`, `-o json`/`-o text` fallback, auth/quota detection, output capping. Exit codes matter: 0 ok, 2 usage, 3 not installed, 4 auth.
- `agents/gemini-executor.md` — the sub-agent that runs one Gemini task through `gemini-run.mjs` and returns a concise report (keeps large output out of main context). Delegation routes through it.
- `commands/` — existing slash commands: `setup.md`, `review.md`, `adversarial.md`, `search.md`, `delegate.md`. Study `delegate.md` closely — it is the closest analog (hand a task to Gemini, run it, review).
- `skills/gemini-cli/` — bundled reference skill (CLI reference, prompt templates).
- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` — plugin manifest / marketplace. Check whether skills need to be registered here for the plugin to expose them.

Two external skills this must interoperate with (READ ONLY — they live outside this repo, do NOT edit them):
- `~/.claude/skills/run-prompt/SKILL.md` — the skill `/run-prompt-gemini` is based on. It resolves prompt files from `./.prompts/**` (category subfolders, numbered), reads the file, delegates to a `general-purpose` Task sub-agent, archives to `completed/`, and commits. Supports single / `--parallel` / `--sequential`.
- `~/.claude/skills/orchestrate-work/SKILL.md` and its `references/routing-table.md` — routes work-machine tasks between free Gemini and metered Claude. Gemini prompts must be adapted per `references/gemini-adapter.md` before dispatch; runs are logged to `~/.orchestrator/memory-work.jsonl`; dispatch goes through `gemini-run.mjs` (direct background path by default, `gemini-executor` sub-agent only for huge output).

The gemini model names referenced in-repo are: `gemini-3.1-pro` (default), `gemini-3.5-flash` (`--flash`), `gemini-3.1-flash-lite`. Keep these consistent — do not invent new ones.
</context>

<requirements>
Do the work in three ordered parts.

**Part A — Audit and fix the existing wrapper so it actually runs.**
1. Verify `node scripts/gemini-run.mjs check` behaves correctly (installed/auth paths, exit codes). If the Gemini CLI is not installed/authenticated on this machine, that is EXPECTED — the script must degrade gracefully with actionable guidance, not crash. Confirm that behavior; do not treat "gemini not on PATH" as a bug to fix by installing it.
2. Trace each command in `commands/` and the `gemini-executor` agent end to end against `gemini-run.mjs`. Confirm the invocation strings, flags, `${CLAUDE_PLUGIN_ROOT}` references, and stdin handling are correct and mutually consistent. Fix any real breakage (wrong flag names, broken paths, stale model names, arg-parser bugs, exit-code mismatches).
3. Confirm the plugin manifest (`.claude-plugin/plugin.json`) correctly exposes the existing commands, agent, and skills. Note anything missing.
4. Keep fixes minimal and root-cause — fix shared logic in `gemini-run.mjs` once rather than patching each caller. Do not refactor or restructure working code for style.

**Part B — Build the `run-prompt-gemini` skill.**
Create a new skill at `skills/run-prompt-gemini/SKILL.md` (skill directory form, matching how `skills/gemini-cli` is packaged), that mirrors `/run-prompt` as closely as possible but swaps the executor:
- Same argument surface as `/run-prompt`: prompt number(s) or partial name, empty = most recent, plus `--parallel` / `--sequential` (default sequential for multiple), and add `--flash` and `--read-only` pass-through flags where they make sense for Gemini.
- Same file resolution: search `./.prompts/**/*.md` recursively across category subfolders (NOT the root), exclude `completed/` and `INDEX.md`.
- Same lifecycle: read the prompt file → dispatch to Gemini via `scripts/gemini-run.mjs` (using `${CLAUDE_PLUGIN_ROOT}` the way `agents/gemini-executor.md` does) → on success archive the prompt to its category's `completed/` subfolder → stage only the files changed and commit with a conventional-commit message. Skip git steps entirely if not in a git repo (mirror run-prompt's guard).
- Crucially, adapt the prompt for Gemini before dispatch. Saved prompts are Claude-flavored (XML tags, negatives, front-loaded instructions). Apply the same adaptation principles orchestrate-work uses (`gemini-adapter.md`: instructions at the end, labeled inputs, no broad negatives). Reference/embed those principles in the skill so it is self-contained and does not depend on orchestrate-work being installed.
- Use the direct background path (`gemini-run.mjs` in background Bash, follow the run log) by default; use the `gemini-executor` sub-agent only for huge-output runs. Prefer `--read-only` unless the prompt's intent is to write.
- Match run-prompt's output format (the ✓ Executed / ✓ Archived / results summary blocks), adapted to name Gemini as the executor.

**Part C — Wire it into orchestrate-work interop.**
`/run-prompt-gemini` must be reachable as a native route. Since orchestrate-work lives outside this repo, make the skill self-describing enough that orchestrate-work can route to it, and document the handshake in the repo:
- Ensure the skill's `description` frontmatter is written so it triggers naturally when a user (or orchestrate-work) wants to run a saved `./.prompts/` spec on Gemini.
- Add a short section to `README.md` documenting `/run-prompt-gemini` alongside the other commands, and explaining how it slots into an orchestrate-work flow (saved prompt → adapted → Gemini → verify → archive → log).
- Confirm the skill honors the safety floor: never pass `--yolo` for tasks touching secrets/env files or irreversible/side-effecting actions without explicit confirmation. State this in the skill.
</requirements>

<implementation>
- Prefer editing `gemini-run.mjs` for shared behavior over duplicating logic in the new skill — the skill should orchestrate, the script should execute. Reuse existing pieces (the executor agent, the run script, the gemini-cli skill) rather than reinventing them; that is the whole point of building on this wrapper.
- The new skill is a Markdown SKILL, not JS — do not write a parallel runner in Node. Delegation mechanics already live in `gemini-run.mjs` and `gemini-executor`; the skill drives them.
- Do NOT edit the external `run-prompt` or `orchestrate-work` skills. This PR ships only in this repo.
- Match the existing repo's voice and structure in commands/skills (compare against `commands/delegate.md` and `skills/gemini-cli`). Match comment density and idiom of the surrounding code for any `gemini-run.mjs` edits.
- Do not add dependencies. Node stdlib + the existing script are sufficient.
</implementation>

<output>
On a new branch (e.g. `feat/run-prompt-gemini`), create/modify:
- `skills/run-prompt-gemini/SKILL.md` — the new skill (primary deliverable).
- `scripts/gemini-run.mjs` — only if Part A found real bugs.
- `commands/*.md` / `agents/gemini-executor.md` — only if Part A found real breakage.
- `.claude-plugin/plugin.json` — if the skill must be registered to be exposed.
- `README.md` — document `/run-prompt-gemini` and the orchestrate-work handshake.
Then open a PR against `main` with a description covering: what audit found, what was fixed, the new skill, and how it interoperates with orchestrate-work.
</output>

<verification>
Before declaring complete, verify:
- `node scripts/gemini-run.mjs check` runs without crashing and prints correct guidance for the current machine state (installed+auth, or not-installed) with the right exit code.
- The new `skills/run-prompt-gemini/SKILL.md` has valid frontmatter (`name`, `description`) and its documented `gemini-run.mjs` invocations exactly match the script's real flags and subcommands (no invented flags).
- Dry-trace the skill against a sample `./.prompts/1xx-*/NNN-*.md`: file resolution, adaptation, dispatch command, archive path, and commit step are all internally consistent and match run-prompt's lifecycle.
- If the Gemini CLI is actually installed and authenticated on this machine, do one real end-to-end run of a small read-only saved prompt through the new skill's documented path and confirm output comes back. If not authenticated, state that the live run was skipped and why, and confirm the graceful-degradation path instead.
- Plugin manifest still valid JSON and exposes the new skill.
- The PR is open and its description is accurate to what actually changed (do not claim a live Gemini run happened if it did not).
</verification>

<success_criteria>
- `/run-prompt-gemini` exists as a native skill in this repo, mirrors `/run-prompt`'s UX, and delegates execution to Gemini through the existing `gemini-run.mjs` / `gemini-executor` machinery.
- Prompts are adapted for Gemini before dispatch; the skill is self-contained (no hard dependency on orchestrate-work being installed).
- Any real breakage found in the existing wrapper is fixed at root cause; graceful degradation when Gemini is absent is confirmed, not broken.
- README documents the command and its orchestrate-work interop.
- Everything ships as a single reviewable PR against `main` with an accurate description.
</success_criteria>
