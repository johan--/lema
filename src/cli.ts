#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { Provider } from "./provider.js";
import { MemoryStore } from "./memory.js";
import { SkillLibrary } from "./skills/index.js";
import { runAgent } from "./agent/index.js";
import { startRepl, consoleRenderer } from "./repl/index.js";
import { getTools } from "./tools/index.js";
import { discoverCheck, makeVerifier } from "./verify/index.js";
import { loadRulesPreamble } from "./rules/index.js";
import { ContextManager } from "./context/index.js";
import * as ui from "./ui.js";

const HELP = `${ui.bold("lema")} — a local, self-improving agentic CLI

${ui.bold("Usage")}
  lema                     Open the interactive session (type, or / for commands)
  lema "<task>"            Run the agent on a single task, then exit
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

  if (argv[0] === "--help" || argv[0] === "-h") {
    ui.log(HELP);
    return;
  }

  // Bare `lema` opens the interactive session (Claude-style).
  if (argv.length === 0) {
    await startRepl(cfg, provider);
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
    const all = new SkillLibrary().list();
    if (!all.length) return ui.warn("no skills yet — add .lema/skills/<name>/SKILL.md or run: lema skill new \"…\"");
    for (const s of all) {
      ui.log(`${ui.bold("/" + s.name)} ${ui.dim(`[${s.scope}]`)}`);
      ui.log("  " + ui.dim(s.description));
    }
    return;
  }

  // Default: treat the whole argv as a task for the agent.
  const task = argv.join(" ");
  const model = await provider.resolveModel();
  ui.step("model", model);
  ui.step("task", task);
  ui.log();
  const memory = new MemoryStore(cfg, provider);
  const checkCmd = discoverCheck(process.cwd(), cfg.check);
  const verifier = checkCmd ? makeVerifier(checkCmd) : undefined;
  const loadedRules = loadRulesPreamble(process.cwd(), cfg.rules);
  const context = new ContextManager({ budget: cfg.context, rules: loadedRules?.preamble });
  const skillsMeta = new SkillLibrary().metadataBlock() ?? undefined;
  await runAgent(task, { maxSteps: cfg.maxSteps, maxTokens: cfg.maxTokens, effort: cfg.effort, provider, cwd: process.cwd(), memory, skillsMeta, tools: getTools(cfg), verifier, verify: cfg.reliability.verify, context, onEvent: consoleRenderer });
}


main().catch((e) => {
  ui.err((e as Error).message);
  process.exit(1);
});
