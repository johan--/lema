#!/usr/bin/env node
// Usage: lema-call.mjs <tool> [json-args]
// Example: lema-call.mjs lema_stats
// Example: lema-call.mjs lema_run '{"task":"list files","effort":"low"}'

import { spawn } from "node:child_process";

const [, , tool, argsRaw] = process.argv;
if (!tool) { console.error("Usage: lema-call.mjs <tool> [json-args]"); process.exit(1); }

const args = argsRaw ? JSON.parse(argsRaw) : {};
const cwd = process.env.LEMA_CWD ?? "/Users/ivan/dev/my/test";
const bin = new URL("../dist/mcp/index.js", import.meta.url).pathname;

const messages = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude", version: "1" } } },
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } },
];

const proc = spawn("node", [bin], { env: { ...process.env, LEMA_CWD: cwd }, stdio: ["pipe", "pipe", "inherit"] });

let buf = "";
proc.stdout.on("data", (d) => { buf += d; });
proc.stdout.on("end", () => {
  const lines = buf.trim().split("\n");
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.id === 2) {
        if (msg.error) { console.error("Error:", msg.error.message); process.exit(1); }
        console.log(msg.result?.content?.[0]?.text ?? JSON.stringify(msg.result, null, 2));
        return;
      }
    } catch {}
  }
});

proc.stdin.write(messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
proc.stdin.end();
