#!/usr/bin/env node
// gemini-run.mjs — the single entry point every command/agent in this plugin uses
// to talk to Google's Gemini CLI. It exists so behaviour is consistent and so
// failures degrade gracefully instead of dumping a cryptic stack trace into Claude.
//
// Responsibilities:
//   1. Confirm `gemini` is on PATH; if not, print exact install/auth steps and exit.
//   2. Build the invocation (model, --yolo, --include-directories, prompt via stdin).
//   3. Prefer `-o json` and extract `.response`; fall back to `-o text` on parse issues.
//   4. Detect auth/quota failures and translate them into actionable guidance.
//   5. Keep Claude's context clean: optionally cap the printed response length.
//
// Usage:
//   node gemini-run.mjs check
//   node gemini-run.mjs run [--model <m>] [--yolo] [--text|--json]
//        [--include <dir> ...] [--max-chars <n>] [--stdin] -- <prompt words...>
//
// The prompt may be passed after `--` OR piped on stdin with `--stdin`.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const RAW = process.argv.slice(2);
const sub = RAW[0];

// ---------- tiny arg parser ----------
function parse(args) {
  const opts = {
    model: null,
    yolo: false,
    format: "auto", // auto | json | text
    include: [],
    maxChars: 24000,
    stdin: false,
    prompt: "",
  };
  const dashdash = args.indexOf("--");
  const flagArgs = dashdash === -1 ? args : args.slice(0, dashdash);
  const promptWords = dashdash === -1 ? [] : args.slice(dashdash + 1);
  for (let i = 0; i < flagArgs.length; i++) {
    const a = flagArgs[i];
    if (a === "--model" || a === "-m") opts.model = flagArgs[++i];
    else if (a === "--yolo" || a === "-y") opts.yolo = true;
    else if (a === "--json") opts.format = "json";
    else if (a === "--text") opts.format = "text";
    else if (a === "--include") opts.include.push(flagArgs[++i]);
    else if (a === "--max-chars") opts.maxChars = parseInt(flagArgs[++i], 10) || opts.maxChars;
    else if (a === "--stdin") opts.stdin = true;
  }
  opts.prompt = promptWords.join(" ").trim();
  return opts;
}

function geminiPath() {
  const r = spawnSync("bash", ["-lc", "command -v gemini"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

const UNAVAILABLE_MSG = `Gemini CLI is not available on this machine.

To use this plugin, install and authenticate the Gemini CLI:

  1. Install (Node 18+ required):
       npm install -g @google/gemini-cli

  2. Authenticate — run once, interactively, and follow the prompt:
       gemini
     (or set an API key:  export GEMINI_API_KEY=your_key )

  3. Verify:
       gemini --version

Then re-run this command. Nothing was sent to Gemini.`;

function looksLikeAuthError(text) {
  return /(GEMINI_API_KEY|not authenticated|authentication|auth error|login|oauth|401|403|Please set an Auth|API key not found)/i.test(
    text || ""
  );
}
function looksLikeQuota(text) {
  return /(quota|rate limit|429|RESOURCE_EXHAUSTED|will reset after)/i.test(text || "");
}

// ---------- check subcommand ----------
if (sub === "check") {
  const path = geminiPath();
  if (!path) {
    console.log(UNAVAILABLE_MSG);
    process.exit(3);
  }
  const v = spawnSync("gemini", ["--version"], { encoding: "utf8" });
  const version = (v.stdout || v.stderr || "").trim();
  console.log(`gemini found at: ${path}`);
  console.log(`version: ${version || "unknown"}`);
  // A --version that works does not prove auth; probe cheaply.
  const probe = spawnSync("gemini", ["-m", "gemini-2.5-flash", "-o", "text", "-p", "reply with the single word: ok"], {
    encoding: "utf8",
    timeout: 60000,
  });
  const out = (probe.stdout || "") + (probe.stderr || "");
  if (probe.status === 0 && /ok/i.test(probe.stdout || "")) {
    console.log("auth: OK (test prompt succeeded)");
    process.exit(0);
  }
  if (looksLikeAuthError(out)) {
    console.log("auth: NOT CONFIGURED — run `gemini` once interactively, or export GEMINI_API_KEY.");
    process.exit(4);
  }
  console.log("auth: could not confirm. Raw probe output follows:");
  console.log(out.slice(0, 1500));
  process.exit(0);
}

// ---------- run subcommand ----------
if (sub !== "run") {
  console.error("Usage: node gemini-run.mjs <check|run> [options] -- <prompt>");
  process.exit(2);
}

const opts = parse(RAW.slice(1));

// Resolve prompt source
let prompt = opts.prompt;
if (opts.stdin) {
  // read all of stdin synchronously (fd 0)
  let data = "";
  try {
    data = readFileSync(0, "utf8");
  } catch {}
  if (data.trim()) prompt = data.trim();
}
if (!prompt) {
  console.error("No prompt provided. Pass it after `--` or pipe it with `--stdin`.");
  process.exit(2);
}

if (!geminiPath()) {
  console.log(UNAVAILABLE_MSG);
  process.exit(3);
}

function buildArgs(format) {
  const args = [];
  if (opts.model) args.push("-m", opts.model);
  if (opts.yolo) args.push("--yolo");
  for (const dir of opts.include) args.push("--include-directories", dir);
  args.push("-o", format);
  args.push("-p", prompt);
  return args;
}

function runOnce(format) {
  return spawnSync("gemini", buildArgs(format), {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30 * 60 * 1000,
  });
}

function emit(text) {
  let out = (text || "").trim();
  if (out.length > opts.maxChars) {
    out =
      out.slice(0, opts.maxChars) +
      `\n\n[... truncated ${out.length - opts.maxChars} chars. Re-run with a larger --max-chars or a narrower prompt for the full output.]`;
  }
  console.log(out);
}

// Try JSON first (unless --text forced), extract .response, else fall back to text.
const preferJson = opts.format !== "text";
let res;
if (preferJson) {
  res = runOnce("json");
  const raw = (res.stdout || "").trim();
  if (res.status === 0 && raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.response === "string") {
        emit(parsed.response);
        process.exit(0);
      }
    } catch {
      // not JSON — fall through to text mode
    }
  }
  // JSON attempt failed; inspect for auth/quota before retrying as text
  const combined = (res.stdout || "") + (res.stderr || "");
  if (looksLikeAuthError(combined)) {
    console.log("Gemini authentication failed.\n");
    console.log(UNAVAILABLE_MSG);
    process.exit(4);
  }
  if (opts.format === "json") {
    // caller demanded json but we could not parse — surface raw
    emit(raw || combined);
    process.exit(res.status === 0 ? 0 : 1);
  }
}

// Text mode (either forced, or JSON fallback)
res = runOnce("text");
const combined = (res.stdout || "") + (res.stderr || "");
if (res.status !== 0) {
  if (looksLikeAuthError(combined)) {
    console.log("Gemini authentication failed.\n");
    console.log(UNAVAILABLE_MSG);
    process.exit(4);
  }
  if (looksLikeQuota(combined)) {
    console.log(
      "Gemini hit a rate/quota limit. The CLI auto-retries with backoff; try again shortly, or use `--model gemini-2.5-flash` for a lower-cost path.\n"
    );
  }
}
emit(res.stdout || combined);
process.exit(res.status === 0 ? 0 : 1);
