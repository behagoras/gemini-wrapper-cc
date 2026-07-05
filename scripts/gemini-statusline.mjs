#!/usr/bin/env node
// gemini-statusline.mjs — zero-token live Gemini status for Claude Code's statusline.
//
// Shows the most recent Gemini run from $GEMINI_RUNS_DIR (default ~/.gemini-runs):
//   ✦ gemini ▶ 34s · google_web_search {"query":"node 24"}     (running)
//   ✦ gemini ✔ 27s                                             (finished <60s ago)
//   ✦ gemini ✖ trust-error                                     (failed <60s ago)
// Prints nothing when there's no recent activity, so it stays out of the way.
//
// Install (statusline is a user-level setting, ~/.claude/settings.json):
//   "statusLine": { "type": "command", "command": "node /ABSOLUTE/PATH/to/scripts/gemini-statusline.mjs" }
// No model is ever invoked — this reads meta.json + the tail of run.log. Costs zero tokens.

import { readFileSync, readdirSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Claude Code pipes session JSON on stdin; consume and ignore it.
try {
  readFileSync(0, "utf8");
} catch {}

const RECENT_DONE_SECS = 60; // show finished/failed runs for this long
const STALE_RUN_SECS = 35 * 60; // ignore "running" metas older than this (crashed runs)

function lastLogLine(dir) {
  // Read the last 4 KB of run.log and return the most recent interesting line.
  try {
    const p = join(dir, "run.log");
    const size = statSync(p).size;
    const len = Math.min(4096, size);
    if (len === 0) return "";
    const fd = openSync(p, "r");
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    const lines = buf.toString("utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^\[(tool_use|tool_result|init|error|result)\]/.test(lines[i])) return lines[i];
    }
    return lines[lines.length - 1] || "";
  } catch {
    return "";
  }
}

function fmt(secs) {
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s`;
}

try {
  const base = process.env.GEMINI_RUNS_DIR || join(homedir(), ".gemini-runs");
  if (!existsSync(base)) process.exit(0);
  const names = readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse()
    .slice(0, 5);
  const now = Date.now();
  for (const name of names) {
    const dir = join(base, name);
    let meta;
    try {
      meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    } catch {
      continue;
    }
    const started = Date.parse(meta.startedAt || 0);
    if (meta.status === "running") {
      const elapsed = Math.round((now - started) / 1000);
      if (elapsed > STALE_RUN_SECS) continue; // crashed/stale
      const tail = lastLogLine(dir).slice(0, 70);
      process.stdout.write(`✦ gemini ▶ ${fmt(elapsed)}${tail ? ` · ${tail}` : ""}`);
      process.exit(0);
    }
    const ended = Date.parse(meta.endedAt || 0);
    if (ended && (now - ended) / 1000 < RECENT_DONE_SECS) {
      const dur = fmt(Math.round((meta.durationMs || 0) / 1000));
      const icon = meta.status === "success" ? "✔" : "✖";
      const label = meta.status === "success" ? dur : `${meta.status} ${dur}`;
      process.stdout.write(`✦ gemini ${icon} ${label}`);
      process.exit(0);
    }
    break; // most recent run is neither running nor freshly finished — show nothing
  }
} catch {}
process.exit(0);
