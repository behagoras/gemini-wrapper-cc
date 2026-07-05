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
//   6. OBSERVABILITY: stream every run live to a per-run log dir so anyone can
//      `tail -f` while Gemini works. `--stream` uses `-o stream-json` so tool
//      calls and per-chunk assistant output show up in the log in real time.
//
// Usage:
//   node gemini-run.mjs check
//   node gemini-run.mjs run [--model <m>] [--yolo] [--trust] [--text|--json]
//        [--stream] [--debug] [--include <dir> ...] [--max-chars <n>]
//        [--timeout <secs>] [--stdin] -- <prompt words...>
//   node gemini-run.mjs logs [--last <n>]
//
// The prompt may be passed after `--` OR piped on stdin with `--stdin`.
//
// Per-run artifacts (base dir: $GEMINI_RUNS_DIR, default ~/.gemini-runs):
//   <base>/<timestamp>-<slug>/run.log       combined live stream (stdout+stderr), uncapped
//   <base>/<timestamp>-<slug>/stream.jsonl  raw stream-json events (only with --stream)
//   <base>/<timestamp>-<slug>/meta.json     args, model, timing, exit code, status
//   <base>/<timestamp>-<slug>/response.txt  final extracted response, uncapped
//
// The path of run.log is printed to stdout IMMEDIATELY at launch (before Gemini
// finishes) so the caller can hand it to the user for `tail -f`.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, createWriteStream, writeFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RAW = process.argv.slice(2);
const sub = RAW[0];

const TIMEOUT_DEFAULT_SECS = 30 * 60; // 30 min
const MEM_CAP = 32 * 1024 * 1024; // max child output kept in memory; log file is never capped

// ---------- tiny arg parser ----------
function parse(args) {
  const opts = {
    model: null,
    yolo: false,
    trust: false,
    format: "auto", // auto | json | text
    include: [],
    maxChars: 24000,
    stdin: false,
    stream: false,
    debug: false,
    timeoutSecs: TIMEOUT_DEFAULT_SECS,
    prompt: "",
  };
  const dashdash = args.indexOf("--");
  const flagArgs = dashdash === -1 ? args : args.slice(0, dashdash);
  const promptWords = dashdash === -1 ? [] : args.slice(dashdash + 1);
  for (let i = 0; i < flagArgs.length; i++) {
    const a = flagArgs[i];
    if (a === "--model" || a === "-m") opts.model = flagArgs[++i];
    else if (a === "--yolo" || a === "-y") opts.yolo = true;
    else if (a === "--trust") opts.trust = true;
    else if (a === "--json") opts.format = "json";
    else if (a === "--text") opts.format = "text";
    else if (a === "--stream" || a === "--verbose") opts.stream = true;
    else if (a === "--debug") opts.debug = true;
    else if (a === "--include") opts.include.push(flagArgs[++i]);
    else if (a === "--max-chars") opts.maxChars = parseInt(flagArgs[++i], 10) || opts.maxChars;
    else if (a === "--timeout") opts.timeoutSecs = parseInt(flagArgs[++i], 10) || opts.timeoutSecs;
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
function looksLikeTrustError(text) {
  return /(folder trust|not trusted|untrusted (folder|workspace|directory)|trust dialog|trusted folders)/i.test(text || "");
}

const TRUST_MSG = `Gemini CLI does not trust this directory (folder trust check).

Fix one of these ways and re-run:
  - add --trust to this command (passes the CLI's --skip-trust for this session), or
  - export GEMINI_CLI_TRUST_WORKSPACE=true, or
  - trust the folder permanently: open \`gemini\` interactively there and accept, or see
    the CLI's trusted-folders docs (GEMINI_CLI_TRUSTED_FOLDERS_PATH).`;

// ---------- run directory helpers ----------
function runsBaseDir() {
  return process.env.GEMINI_RUNS_DIR || join(homedir(), ".gemini-runs");
}

function slugify(text) {
  return (text || "run")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "run";
}

function timestamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Create the per-run dir. Never let logging problems break the run: on failure
// return null and the runner degrades to the old (log-less) behaviour.
function createRunDir(slug) {
  try {
    const dir = join(runsBaseDir(), `${timestamp()}-${slug}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch (e) {
    console.error(`[gemini-run] warning: cannot create log dir under ${runsBaseDir()} (${e.message}); running without logs`);
    return null;
  }
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
  const probe = spawnSync("gemini", ["-m", "gemini-3.1-flash-lite", "-o", "text", "-p", "reply with the single word: ok"], {
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

// ---------- logs subcommand ----------
if (sub === "logs") {
  const args = RAW.slice(1);
  let last = 10;
  const li = args.indexOf("--last");
  if (li !== -1) last = parseInt(args[li + 1], 10) || last;
  const base = runsBaseDir();
  if (!existsSync(base)) {
    console.log(`No runs yet (looked in ${base}).`);
    process.exit(0);
  }
  const entries = readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse()
    .slice(0, last);
  if (entries.length === 0) {
    console.log(`No runs yet (looked in ${base}).`);
    process.exit(0);
  }
  console.log(`Recent Gemini runs in ${base} (newest first):\n`);
  for (const name of entries) {
    const dir = join(base, name);
    let meta = {};
    try {
      meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    } catch {}
    const status = meta.status || "running?";
    const dur = meta.durationMs != null ? `${Math.round(meta.durationMs / 1000)}s` : "-";
    const model = meta.model || "default";
    console.log(`  ${name}`);
    console.log(`    status: ${status}   duration: ${dur}   model: ${model}   exit: ${meta.exitCode ?? "-"}`);
    console.log(`    log: ${join(dir, "run.log")}`);
  }
  process.exit(0);
}

// ---------- run subcommand ----------
if (sub !== "run") {
  console.error("Usage: node gemini-run.mjs <check|run|logs> [options] -- <prompt>");
  process.exit(2);
}

const opts = parse(RAW.slice(1));

// Resolve prompt source
let prompt = opts.prompt;
if (opts.stdin) {
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

// ---------- set up per-run observability ----------
const runDir = createRunDir(slugify(prompt));
let logStream = null;
let eventStream = null;
if (runDir) {
  try {
    logStream = createWriteStream(join(runDir, "run.log"), { flags: "a" });
    if (opts.stream) eventStream = createWriteStream(join(runDir, "stream.jsonl"), { flags: "a" });
  } catch (e) {
    console.error(`[gemini-run] warning: cannot open log files (${e.message}); running without logs`);
    logStream = null;
    eventStream = null;
  }
  // Announce the log path IMMEDIATELY so the caller can tail -f while Gemini works.
  if (logStream) {
    console.log(`[gemini-run] live log: ${join(runDir, "run.log")}`);
    console.log(`[gemini-run] watch with: tail -f "${join(runDir, "run.log")}"`);
  }
}

function log(line) {
  if (logStream) {
    try {
      logStream.write(line.endsWith("\n") ? line : line + "\n");
    } catch {}
  }
}

const meta = {
  startedAt: new Date().toISOString(),
  endedAt: null,
  durationMs: null,
  status: "running",
  exitCode: null,
  model: opts.model,
  stream: opts.stream,
  debug: opts.debug,
  yolo: opts.yolo,
  trust: opts.trust,
  include: opts.include,
  format: opts.format,
  timeoutSecs: opts.timeoutSecs,
  promptChars: prompt.length,
  promptPreview: prompt.slice(0, 200),
  argv: RAW.slice(0, 40),
};

function writeMeta() {
  if (!runDir) return;
  try {
    writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2));
  } catch {}
}
writeMeta();

function finalize(status, exitCode, responseText) {
  meta.status = status;
  meta.exitCode = exitCode;
  meta.endedAt = new Date().toISOString();
  meta.durationMs = Date.parse(meta.endedAt) - Date.parse(meta.startedAt);
  writeMeta();
  if (runDir && responseText != null) {
    try {
      writeFileSync(join(runDir, "response.txt"), responseText);
    } catch {}
  }
  log(`\n[gemini-run] finished: status=${status} exit=${exitCode} duration=${meta.durationMs}ms`);
  if (logStream) logStream.end();
  if (eventStream) eventStream.end();
}

function buildArgs(format) {
  const args = [];
  if (opts.model) args.push("-m", opts.model);
  if (opts.yolo) args.push("--yolo");
  if (opts.trust) args.push("--skip-trust");
  if (opts.debug) args.push("--debug");
  for (const dir of opts.include) args.push("--include-directories", dir);
  args.push("-o", format);
  args.push("-p", prompt);
  return args;
}

// Spawn gemini, streaming both pipes to run.log AS CHUNKS ARRIVE.
// Keeps at most MEM_CAP of stdout in memory (the log file gets everything).
// onStdoutChunk (optional) sees every stdout chunk live — used for stream-json.
function runStreaming(format, onStdoutChunk) {
  return new Promise((resolve) => {
    const args = buildArgs(format);
    log(`[gemini-run] launching: gemini ${args.map((a) => (a === prompt ? "<prompt>" : a)).join(" ")}`);
    log(`[gemini-run] started at ${new Date().toISOString()}\n`);
    const child = spawn("gemini", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      log(`\n[gemini-run] TIMEOUT after ${opts.timeoutSecs}s — killing gemini`);
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 5000).unref();
    }, opts.timeoutSecs * 1000);

    child.stdout.on("data", (buf) => {
      const chunk = buf.toString("utf8");
      if (logStream && !onStdoutChunk) logStream.write(chunk); // raw passthrough for text/json modes
      if (onStdoutChunk) onStdoutChunk(chunk);
      if (stdout.length < MEM_CAP) stdout += chunk;
      else truncated = true;
    });
    child.stderr.on("data", (buf) => {
      const chunk = buf.toString("utf8");
      if (logStream) logStream.write(chunk);
      if (stderr.length < MEM_CAP) stderr += chunk;
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: null, error: err, stdout, stderr, timedOut, truncated });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr, timedOut, truncated });
    });
  });
}

function emit(text) {
  let out = (text || "").trim();
  if (out.length > opts.maxChars) {
    out =
      out.slice(0, opts.maxChars) +
      `\n\n[... truncated ${out.length - opts.maxChars} chars. Full response in ${runDir ? join(runDir, "response.txt") : "the run log"}; re-run with a larger --max-chars for more inline.]`;
  }
  console.log(out);
}

function failAuth(responseText) {
  console.log("Gemini authentication failed.\n");
  console.log(UNAVAILABLE_MSG);
  finalize("auth-error", 4, responseText);
  process.exit(4);
}

function failTrust(responseText) {
  console.log(TRUST_MSG);
  finalize("trust-error", 5, responseText);
  process.exit(5);
}

// ---------- stream mode (-o stream-json): live tool calls + assistant deltas ----------
async function runStreamMode() {
  let assistantText = "";
  let resultEvent = null;
  let lineBuf = "";

  const handleEvent = (ev) => {
    if (eventStream) {
      try {
        eventStream.write(JSON.stringify(ev) + "\n");
      } catch {}
    }
    switch (ev.type) {
      case "init":
        log(`[init] session started${ev.model ? ` (model: ${ev.model})` : ""}`);
        break;
      case "message":
        if (ev.role === "assistant") {
          assistantText += ev.content || "";
          if (logStream && ev.content) logStream.write(ev.content); // live model output
        } else {
          log(`[user] ${String(ev.content || "").slice(0, 300)}`);
        }
        break;
      case "tool_use":
        log(`\n[tool_use] ${ev.tool_name} ${JSON.stringify(ev.parameters || {}).slice(0, 500)}`);
        break;
      case "tool_result":
        log(`[tool_result] ${ev.tool_name || ""} ${String(ev.status || "")} ${String(ev.output ?? ev.result ?? "").slice(0, 500)}`);
        break;
      case "error":
        log(`\n[error] ${JSON.stringify(ev).slice(0, 1000)}`);
        break;
      case "result":
        resultEvent = ev;
        log(`\n[result] status=${ev.status}${ev.error ? ` error=${ev.error.message}` : ""}`);
        break;
      default:
        log(`[event] ${JSON.stringify(ev).slice(0, 500)}`);
    }
  };

  const onChunk = (chunk) => {
    lineBuf += chunk;
    let nl;
    while ((nl = lineBuf.indexOf("\n")) !== -1) {
      const line = lineBuf.slice(0, nl).trim();
      lineBuf = lineBuf.slice(nl + 1);
      if (!line) continue;
      try {
        handleEvent(JSON.parse(line));
      } catch {
        log(line); // not JSON — log verbatim
      }
    }
  };

  const res = await runStreaming("stream-json", onChunk);
  if (lineBuf.trim()) onChunk("\n"); // flush trailing partial line

  const combined = res.stdout + res.stderr;
  if (res.error) {
    console.error(`[gemini-run] failed to launch gemini: ${res.error.message}`);
    finalize("launch-error", 1, null);
    process.exit(1);
  }
  if (res.timedOut) {
    console.log(`Gemini run timed out after ${opts.timeoutSecs}s. Partial output is in the run log.`);
    if (assistantText) emit(assistantText);
    finalize("timeout", 124, assistantText || null);
    process.exit(124);
  }
  if (looksLikeAuthError(combined) || (resultEvent?.error && looksLikeAuthError(resultEvent.error.message))) {
    failAuth(assistantText || null);
  }
  if (res.status !== 0 && (looksLikeTrustError(combined) || (resultEvent?.error && looksLikeTrustError(resultEvent.error.message)))) {
    failTrust(assistantText || null);
  }
  if (looksLikeQuota(combined)) {
    console.log(
      "Gemini hit a rate/quota limit. The CLI auto-retries with backoff; try again shortly, or use `--model gemini-3.5-flash` for a lower-cost path.\n"
    );
  }
  const ok = res.status === 0 && (!resultEvent || resultEvent.status === "success");
  emit(assistantText || combined);
  finalize(ok ? "success" : "error", res.status ?? 1, assistantText || combined);
  process.exit(ok ? 0 : 1);
}

// ---------- classic mode: -o json preferred, -o text fallback ----------
async function runClassicMode() {
  const preferJson = opts.format !== "text";
  if (preferJson) {
    const res = await runStreaming("json");
    const raw = (res.stdout || "").trim();
    if (res.timedOut) {
      console.log(`Gemini run timed out after ${opts.timeoutSecs}s. Partial output is in the run log.`);
      finalize("timeout", 124, null);
      process.exit(124);
    }
    if (res.error) {
      console.error(`[gemini-run] failed to launch gemini: ${res.error.message}`);
      finalize("launch-error", 1, null);
      process.exit(1);
    }
    if (res.status === 0 && raw && !res.truncated) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.response === "string") {
          emit(parsed.response);
          finalize("success", 0, parsed.response);
          process.exit(0);
        }
      } catch {
        // not JSON — fall through to text mode
      }
    }
    const combined = (res.stdout || "") + (res.stderr || "");
    if (looksLikeAuthError(combined)) failAuth(null);
    if (res.status !== 0 && looksLikeTrustError(combined)) failTrust(null);
    if (opts.format === "json") {
      // caller demanded json but we could not parse — surface raw
      emit(raw || combined);
      const ok = res.status === 0;
      finalize(ok ? "success" : "error", res.status ?? 1, raw || combined);
      process.exit(ok ? 0 : 1);
    }
    log(`\n[gemini-run] json parse failed — retrying with -o text\n`);
  }

  const res = await runStreaming("text");
  const combined = (res.stdout || "") + (res.stderr || "");
  if (res.timedOut) {
    console.log(`Gemini run timed out after ${opts.timeoutSecs}s. Partial output is in the run log.`);
    if (res.stdout) emit(res.stdout);
    finalize("timeout", 124, res.stdout || null);
    process.exit(124);
  }
  if (res.error) {
    console.error(`[gemini-run] failed to launch gemini: ${res.error.message}`);
    finalize("launch-error", 1, null);
    process.exit(1);
  }
  if (res.status !== 0) {
    if (looksLikeAuthError(combined)) failAuth(null);
    if (looksLikeTrustError(combined)) failTrust(null);
    if (looksLikeQuota(combined)) {
      console.log(
        "Gemini hit a rate/quota limit. The CLI auto-retries with backoff; try again shortly, or use `--model gemini-3.5-flash` for a lower-cost path.\n"
      );
    }
  }
  emit(res.stdout || combined);
  finalize(res.status === 0 ? "success" : "error", res.status ?? 1, res.stdout || combined);
  process.exit(res.status === 0 ? 0 : 1);
}

if (opts.stream) {
  runStreamMode();
} else {
  runClassicMode();
}
