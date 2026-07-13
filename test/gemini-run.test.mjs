import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const runner = join(root, "scripts/gemini-run.mjs");
const statusline = join(root, "scripts/gemini-statusline.mjs");
const stub = join(here, "fixtures/gemini-stub.mjs");

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "gemini-run-test-"));
  const bin = join(dir, "bin");
  const runs = join(dir, "runs");
  await mkdir(bin);
  await chmod(stub, 0o755);
  await symlink(stub, join(bin, "gemini"));
  return { dir, runs, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GEMINI_RUNS_DIR: runs } };
}

function execute(script, args, env, { umask } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, umask });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
    child.stdin.end();
  });
}

async function runDirs(runs) {
  return (await readdir(runs)).sort();
}

test("parses options strictly and falls back from malformed JSON to text", async () => {
  const fx = await fixture();
  const unknown = await execute(runner, ["run", "--wat", "--", "prompt"], fx.env);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown option/);
  const missing = await execute(runner, ["run", "--model"], fx.env);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /requires a value/);
  const fallback = await execute(runner, ["run", "--", "prompt"], { ...fx.env, GEMINI_STUB_MODE: "fallback" });
  assert.equal(fallback.code, 0);
  assert.match(fallback.stdout, /fallback response/);
});

test("streams fragmented JSON, flushes the partial final event, and leaves atomic files", async () => {
  const fx = await fixture();
  const result = await execute(runner, ["run", "--stream", "--quiet", "--", "private prompt"], {
    ...fx.env,
    GEMINI_STUB_MODE: "stream",
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /hello world/);
  const [name] = await runDirs(fx.runs);
  const files = await readdir(join(fx.runs, name));
  assert.deepEqual(files.sort(), ["meta.json", "response.txt", "run.log", "stream.jsonl"]);
  assert.ok(files.every((file) => !file.includes(".tmp-")));
  assert.match(await readFile(join(fx.runs, name, "stream.jsonl"), "utf8"), /"type":"result"/);
});

test("translates timeout, authentication, and folder-trust failures", async () => {
  const timeoutFx = await fixture();
  const timeout = await execute(runner, ["run", "--timeout", "1", "--", "prompt"], {
    ...timeoutFx.env,
    GEMINI_STUB_MODE: "timeout",
  });
  assert.equal(timeout.code, 124);
  assert.match(timeout.stdout, /timed out/);

  const authFx = await fixture();
  const auth = await execute(runner, ["run", "--text", "--", "prompt"], { ...authFx.env, GEMINI_STUB_MODE: "auth" });
  assert.equal(auth.code, 4);
  assert.match(auth.stdout, /authentication failed/i);

  const trustFx = await fixture();
  const trust = await execute(runner, ["run", "--text", "--", "prompt"], { ...trustFx.env, GEMINI_STUB_MODE: "trust" });
  assert.equal(trust.code, 5);
  assert.match(trust.stdout, /does not trust this directory/i);
});

test("creates collision-resistant concurrent IDs", async () => {
  const fx = await fixture();
  const results = await Promise.all(Array.from({ length: 16 }, () => execute(runner, ["run", "--", "same prompt"], fx.env)));
  assert.ok(results.every(({ code }) => code === 0));
  const names = await runDirs(fx.runs);
  assert.equal(names.length, 16);
  assert.equal(new Set(names).size, 16);
  assert.ok(names.every((name) => /-run-[a-f0-9]{12}$/.test(name)));
});

test("enforces private permissions independently of umask and omits prompt diagnostics by default", async () => {
  const fx = await fixture();
  const secret = "do-not-persist-this-prompt";
  const result = await execute(runner, ["run", "--", secret], fx.env, { umask: 0 });
  assert.equal(result.code, 0);
  const [name] = await runDirs(fx.runs);
  const runDir = join(fx.runs, name);
  assert.equal((await stat(fx.runs)).mode & 0o777, 0o700);
  assert.equal((await stat(runDir)).mode & 0o777, 0o700);
  for (const file of await readdir(runDir)) assert.equal((await stat(join(runDir, file))).mode & 0o777, 0o600);
  const metaText = await readFile(join(runDir, "meta.json"), "utf8");
  assert.ok(!metaText.includes(secret));
  const meta = JSON.parse(metaText);
  assert.ok(!("promptPreview" in meta));
  assert.ok(!("argv" in meta));
  assert.ok(!("diagnostics" in meta));
});

test("records only explicitly requested redacted diagnostics", async () => {
  const fx = await fixture();
  const promptWords = ["diagnostic", "--fake-secret=hunter2"];
  const prompt = promptWords.join(" ");
  const result = await execute(runner, ["run", "--diagnostics", "--model", "sensitive-model", "--", ...promptWords], fx.env);
  assert.equal(result.code, 0);
  const [name] = await runDirs(fx.runs);
  const metaText = await readFile(join(fx.runs, name, "meta.json"), "utf8");
  assert.ok(!metaText.includes("hunter2"));
  const meta = JSON.parse(metaText);
  assert.equal(meta.diagnostics.prompt, `<redacted:${prompt.length} chars>`);
  assert.ok(!JSON.stringify(meta.diagnostics).includes("sensitive-model"));
  const separator = meta.diagnostics.argv.indexOf("--");
  assert.ok(separator >= 0);
  assert.deepEqual(meta.diagnostics.argv.slice(separator + 1), ["<redacted>", "<redacted>"]);
});

test("retention is bounded to recognized run directories inside the configured root", async () => {
  const fx = await fixture();
  await mkdir(fx.runs, { mode: 0o700 });
  const old = join(fx.runs, "20200101-000000000-run-aaaaaaaaaaaa");
  const active = join(fx.runs, "20230101-000000000-run-cccccccccccc");
  const recent = join(fx.runs, "20240101-000000000-run-bbbbbbbbbbbb");
  const unrelated = join(fx.runs, "keep-me");
  await mkdir(old);
  await mkdir(active);
  await mkdir(recent);
  await mkdir(unrelated);
  const ancient = new Date("2020-01-01T00:00:00Z");
  await utimes(old, ancient, ancient);
  await writeFile(join(active, "meta.json"), JSON.stringify({
    status: "running",
    startedAt: new Date().toISOString(),
    timeoutSecs: 1800,
  }));
  const result = await execute(runner, ["run", "--", "prompt"], {
    ...fx.env,
    GEMINI_RUN_MAX_ENTRIES: "2",
    GEMINI_RUN_MAX_AGE_DAYS: "36500",
  });
  assert.equal(result.code, 0);
  const names = await runDirs(fx.runs);
  assert.ok(!names.includes("20200101-000000000-run-aaaaaaaaaaaa"));
  assert.ok(names.includes("20230101-000000000-run-cccccccccccc"));
  assert.ok(names.includes("20240101-000000000-run-bbbbbbbbbbbb"));
  assert.ok(names.includes("keep-me"));
  assert.equal(names.filter((name) => /^\d{8}-/.test(name)).length, 3);
});

test("statusline reports a fresh successful run without invoking Gemini", async () => {
  const fx = await fixture();
  const run = await execute(runner, ["run", "--", "prompt"], fx.env);
  assert.equal(run.code, 0);
  const status = await execute(statusline, [], fx.env);
  assert.equal(status.code, 0);
  assert.match(status.stdout, /gemini ✔/);
});

test("statusline honors a running job's custom timeout", async () => {
  const fx = await fixture();
  const runDir = join(fx.runs, "20260712-120000000-run-aaaaaaaaaaaa");
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "meta.json"), JSON.stringify({
    status: "running",
    startedAt: new Date(Date.now() - 36 * 60 * 1000).toISOString(),
    timeoutSecs: 2 * 60 * 60,
  }));
  const status = await execute(statusline, [], fx.env);
  assert.equal(status.code, 0);
  assert.match(status.stdout, /gemini ▶ 36m/);
});
