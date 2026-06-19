#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { loadConfig } from "./config.js";
import { Provider, type ChatMessage } from "./provider.js";
import { SkillStore } from "./skills.js";
import { runAgent, consoleRenderer } from "./agent.js";
import * as ui from "./ui.js";

const HELP = `${ui.bold("lema")} — a local, self-improving agentic CLI

${ui.bold("Usage")}
  lema "<task>"            Run the agent on a task in the current directory
  lema chat                Start an interactive chat (no tools)
  lema models              List models exposed by the local server
  lema skills              List stored skills
  lema ping                Check the local server is reachable
  lema --help              Show this help

${ui.bold("Config")} (lema.config.json or env)
  baseUrl   default http://localhost:1234/v1   (LEMA_BASE_URL)
  model     default = first loaded model        (LEMA_MODEL)
`;

async function main() {
  const argv = process.argv.slice(2);
  const cfg = loadConfig();
  const provider = new Provider(cfg);

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    ui.log(HELP);
    return;
  }

  const cmd = argv[0];

  if (cmd === "ping") {
    const models = await provider.listModels();
    ui.ok(`server up at ${cfg.baseUrl} — ${models.length} model(s)`);
    models.forEach((m) => ui.log("  " + ui.dim(m)));
    return;
  }

  if (cmd === "models") {
    const models = await provider.listModels();
    models.forEach((m) => ui.log(m));
    return;
  }

  if (cmd === "skills") {
    const store = new SkillStore(cfg, provider);
    const all = store.all();
    if (!all.length) return ui.warn("no skills yet — they appear as lema solves verified tasks");
    for (const s of all) {
      ui.log(`${ui.bold(s.name)} ${ui.dim(`[${s.kind}] ${s.wins}/${s.uses}`)}`);
      ui.log("  " + ui.dim(s.description));
    }
    return;
  }

  if (cmd === "chat") {
    await chat(provider);
    return;
  }

  // Default: treat the whole argv as a task for the agent.
  const task = argv.join(" ");
  const model = await provider.resolveModel();
  ui.step("model", model);
  ui.step("task", task);
  ui.log();
  const store = new SkillStore(cfg, provider);
  await runAgent(task, { cfg, provider, cwd: process.cwd(), skills: store, onEvent: consoleRenderer });
}

async function chat(provider: Provider) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const messages: ChatMessage[] = [
    { role: "system", content: "You are lema, a concise, friendly local assistant." },
  ];
  ui.log(ui.dim("chat mode — Ctrl+C to exit"));
  for (;;) {
    const input = await rl.question(ui.cyan("you ▸ "));
    if (!input.trim()) continue;
    messages.push({ role: "user", content: input });
    const reply = await provider.chat(messages);
    messages.push(reply);
    ui.log(ui.bold("lema ▸ ") + (reply.content ?? ""));
  }
}

main().catch((e) => {
  ui.err((e as Error).message);
  process.exit(1);
});
