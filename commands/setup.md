---
description: Check whether the local Gemini CLI is installed and authenticated, and offer to install it
argument-hint: ''
allowed-tools: Bash(node:*), Bash(npm:*), Bash(command:*), AskUserQuestion
---

Verify the Gemini CLI is ready to use with this plugin.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-run.mjs" check
```

Interpret the exit code and output:

- **Exit 0, "auth: OK"** — Gemini is installed and authenticated. Tell the user they're ready and list the available commands: `/gemini:review`, `/gemini:adversarial`, `/gemini:delegate`, `/gemini:search`.
- **Exit 3 (not installed)** — the CLI is missing. If `npm` is available, use `AskUserQuestion` exactly once with two options (install option first, suffixed `(Recommended)`):
  - `Install Gemini CLI (Recommended)`
  - `Skip for now`
  If the user chooses install, run `npm install -g @google/gemini-cli`, then re-run the check command above. Remind them that authentication (`gemini` run once interactively, or `export GEMINI_API_KEY=...`) is a manual one-time step Claude cannot do for them.
- **Exit 4 (installed but not authenticated)** — do NOT try to install. Tell the user to run `gemini` once in their terminal and complete the sign-in, or to set `GEMINI_API_KEY`, then re-run `/gemini:setup`.

Present the final check output to the user. Do not fabricate a success state — only report what the check command actually returned.
