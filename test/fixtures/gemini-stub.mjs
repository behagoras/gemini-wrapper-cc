#!/usr/bin/env node

const args = process.argv.slice(2);
const format = args[args.indexOf("-o") + 1];
const mode = process.env.GEMINI_STUB_MODE || "success";

if (args.includes("--version")) {
  process.stdout.write("0.0.0-test\n");
  process.exit(0);
}

if (mode === "timeout") {
  setTimeout(() => process.stdout.write("too late\n"), 10_000);
} else if (mode === "auth") {
  process.stderr.write("401 not authenticated\n");
  process.exit(1);
} else if (mode === "trust") {
  process.stderr.write("Gemini CLI is not running in a trusted directory. To proceed, use --skip-trust.\n");
  process.exit(55);
} else if (mode === "fallback" && format === "json") {
  process.stdout.write("not-json\n");
} else if (mode === "stream") {
  const pieces = [
    '{"type":"init","model":"stub"}\n{"type":"message","role":"assistant","content":"hello',
    ' "}\n{"type":"message","role":"assistant","content":"world"}\n',
    '{"type":"result","status":"success"}',
  ];
  let index = 0;
  const timer = setInterval(() => {
    process.stdout.write(pieces[index++]);
    if (index === pieces.length) {
      clearInterval(timer);
      process.exit(0);
    }
  }, 10);
} else if (format === "json") {
  process.stdout.write(JSON.stringify({ response: "stub response" }));
} else {
  process.stdout.write("fallback response\n");
}
