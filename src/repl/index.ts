import { stdin, stdout } from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { LemaConfig } from "../config.js";
import type { ModelProvider } from "../provider.js";
import { MemoryStore } from "../memory.js";
import { SkillLibrary, authorSkill } from "../skills/index.js";
import { runAgent, formatStats, type AgentStats, type AgentEvent } from "../agent/index.js";
import { ContextManager, makeSummarizer } from "../context/index.js";
import { getTools, type Tool } from "../tools/index.js";
import { EFFORT_SETTINGS, type EffortSetting } from "../effort.js";
import { discoverCheck, makeVerifier, type Verifier } from "../verify/index.js";
import { loadRulesPreamble } from "../rules/index.js";
import { Tui, type TuiCommand } from "../tui/index.js";
import { renderMarkdown } from "../tui/markdown.js";

/**
 * Format an assistant response with a leading blank line, ⏺ on the first line,
 * and two-space indent on continuation lines — matches Claude Code's visual style.
 */
function formatResponse(text: string): string {
  const rendered = renderMarkdown(text.trim());
  const lines = rendered.split("\n");
  const prefixed = lines
    .map((l, i) => (i === 0 ? ui.magenta("⏺") + " " + l : "  " + l))
    .join("\n");
  // Leading \n produces the blank separator line before the response.
  return "\n" + prefixed;
}
import * as ui from "../ui.js";

interface Session {
  baseUrl: string;
  maxSteps: number;
  maxTokens: number;
  effort: EffortSetting;
  verify: "auto" | "on" | "off";
  verifier?: Verifier;
  /** The project rules file in effect this session, if any (for /settings). */
  rulesPath?: string;
  provider: ModelProvider;
  memory: MemoryStore;
  skills: SkillLibrary;
  context: ContextManager;
  tools: Tool[];
  /** Called with the stats of each completed run (the TUI shows them in the footer). */
  onStats?: (s: AgentStats) => void;
  /** Renderer for agent events (the TUI swaps in its own; batch uses the console). */
  render?: (e: AgentEvent) => void;
  /** Open a modal picker (TUI only); resolves to the chosen item or null. */
  select?: (title: string, items: string[]) => Promise<string | null>;
  /** Switch the active model and update the footer. */
  setModel?: (id: string) => void;
  /** Enable/disable the built-in web tools for this session. */
  setWeb?: (on: boolean) => void;
  /** Change the reasoning effort for this session. */
  setEffort?: (e: EffortSetting) => void;
  /** Change the verification mode for this session. */
  setVerify?: (m: "auto" | "on" | "off") => void;
}

/** A slash command. Adding one must not require touching the REPL loop (open/closed). */
interface SlashCommand {
  name: string;
  aliases?: string[];
  desc: string;
  /** Return true to end the session. */
  run(session: Session, arg: string): Promise<boolean | void> | boolean | void;
}

const COMMANDS: SlashCommand[] = [
  { name: "help", aliases: ["?"], desc: "show available commands", run: () => printMenu() },
  {
    name: "models",
    desc: "list or switch the model",
    run: async (s) => {
      const models = (await s.provider.listModels()).filter((m) => !/embed/i.test(m));
      if (!models.length) return ui.warn("no chat models on the server");
      if (s.select) {
        const pick = await s.select("Select a model  (↑/↓ · Enter · Esc)", models);
        if (pick) {
          s.setModel?.(pick);
          ui.ok(`model → ${pick}`);
        }
      } else {
        models.forEach((m) => ui.log("  " + m));
      }
    },
  },
  {
    name: "skills",
    desc: "list authored skills (invoke one with /<name>)",
    run: (s) => {
      const all = s.skills.list();
      if (!all.length) return ui.warn('no skills yet — add .lema/skills/<name>/SKILL.md or run /skill new "…"');
      all.forEach((k) => {
        ui.log(`  ${ui.bold("/" + k.name)} ${ui.dim("[" + k.scope + "]")}`);
        ui.log("    " + ui.dim(k.description));
      });
    },
  },
  {
    name: "skill",
    desc: 'author a skill: /skill new "<prompt>" [--global]',
    run: (s, arg) => runSkillNew(s, arg),
  },
  {
    name: "ping",
    desc: "check the server is reachable",
    run: async (s) => {
      const models = await s.provider.listModels();
      ui.ok(`server up at ${s.baseUrl} — ${models.length} model(s)`);
    },
  },
  {
    name: "effort",
    desc: "set reasoning effort: low, medium, high",
    run: (s, arg) => runEffort(s, arg),
  },
  {
    name: "settings",
    aliases: ["set"],
    desc: "view settings or change one: web, cwd, ping",
    run: (s, arg) => runSettings(s, arg),
  },
  {
    name: "compact",
    desc: "summarize and compress the conversation to free context",
    run: (s, arg) => runCompact(s, arg),
  },
  {
    name: "clear",
    desc: "clear the screen",
    run: () => {
      stdout.write("\x1b[2J\x1b[H");
    },
  },
  {
    name: "remember",
    desc: 'save something to memory: /remember <text>',
    run: async (s, arg) => {
      const text = arg.trim();
      if (!text) return ui.warn("usage: /remember <text to save>");
      await s.memory.save({
        name: `note: ${text.slice(0, 48)}`,
        description: text.slice(0, 120),
        kind: "lesson",
        body: text,
      });
      ui.ok("saved to memory");
    },
  },
  {
    name: "memory",
    aliases: ["mem"],
    desc: "search memory: /memory <query>",
    run: async (s, arg) => {
      const query = arg.trim();
      if (!query) {
        const all = s.memory.all();
        if (!all.length) return ui.warn("memory is empty");
        all.forEach((m) => {
          ui.log(`  ${ui.bold(m.name)} ${ui.dim("[" + m.kind + "]")}`);
          ui.log("    " + ui.dim(m.description));
        });
        return;
      }
      const results = await s.memory.search(query, 5);
      if (!results.length) return ui.warn("nothing found");
      results.forEach((m, i) => {
        ui.log(`  ${ui.dim(String(i + 1) + ".")} ${ui.bold(m.name)}`);
        ui.log("    " + ui.dim(m.description));
        ui.log("    " + m.body.slice(0, 200));
      });
    },
  },
  { name: "exit", aliases: ["quit", "q"], desc: "quit lema", run: () => true },
];

/** Sub-commands under /settings. Adding one needs no change to the dispatcher. */
const SETTINGS: SlashCommand[] = [
  {
    name: "web",
    desc: "toggle built-in web search (on/off)",
    run: (s, arg) => {
      if (!s.setWeb) return ui.warn("web toggle is unavailable here");
      const on = s.tools.some((t) => t.schema.function.name === "web_search");
      const want = arg.trim() ? /^(on|true|1|yes)$/i.test(arg.trim()) : !on;
      s.setWeb(want);
      ui.ok(`web search ${want ? "on" : "off"}`);
    },
  },
  { name: "cwd", desc: "print the working directory", run: () => ui.log("  " + process.cwd()) },
  {
    name: "ping",
    desc: "check the server is reachable",
    run: async (s) => {
      const models = await s.provider.listModels();
      ui.ok(`server up at ${s.baseUrl} — ${models.length} model(s)`);
    },
  },
];

const SETTINGS_INDEX = new Map<string, SlashCommand>(
  SETTINGS.flatMap((c) => [c.name, ...(c.aliases ?? [])].map((n) => [n, c] as const)),
);

const webOn = (s: Session) => s.tools.some((t) => t.schema.function.name === "web_search");

/** Set reasoning effort directly (`/effort high`) or via an interactive picker. */
async function runEffort(s: Session, arg: string): Promise<void> {
  const apply = (e: EffortSetting) => { s.setEffort?.(e); ui.ok(`effort → ${e}`); };
  const want = arg.trim().toLowerCase();
  if (want) {
    if (!EFFORT_SETTINGS.includes(want as EffortSetting)) return ui.warn(`unknown effort: ${want} — use auto, low, medium, high or ultra`);
    return apply(want as EffortSetting);
  }
  if (s.select) {
    const items = EFFORT_SETTINGS.map((e) => (e === s.effort ? `${e}  ●` : `${e}`));
    const pick = await s.select("Effort  (↑/↓ · Enter · Esc)", items);
    if (pick) apply(EFFORT_SETTINGS[items.indexOf(pick)]);
    return;
  }
  ui.log(`  effort: ${s.effort}  ${ui.dim("(auto · low · medium · high · ultra)")}`);
}

/** Author a skill from a prompt: /skill new "<prompt>" [--global]. */
async function runSkillNew(s: Session, arg: string): Promise<void> {
  const m = arg.trim().match(/^new\s+([\s\S]+)$/i);
  if (!m) return ui.warn('usage: /skill new "<what the skill should do>" [--global]');
  const global = /(^|\s)--global(\s|$)/.test(m[1]);
  const prompt = m[1].replace(/(^|\s)--global(\s|$)/, " ").trim().replace(/^["']|["']$/g, "");
  if (!prompt) return ui.warn('describe the skill, e.g. /skill new "review a PR diff"');

  const model = await s.provider.resolveModel();
  ui.step("skill", "authoring…");
  const skill = await authorSkill(s.provider, model, prompt);
  const file = s.skills.write(skill, global ? "global" : "project");
  ui.ok(`created /${skill.name} [${global ? "global" : "project"}]`);
  ui.log("  " + ui.dim(skill.description));
  ui.log("  " + ui.dim(file));
}

/** Manually compress the conversation: /compact [what to keep]. */
async function runCompact(s: Session, arg: string): Promise<void> {
  const model = await s.provider.resolveModel();
  const before = s.context.tokens();
  ui.step("compact", "summarizing the conversation…");
  const ok = await s.context
    .compact(makeSummarizer(s.provider, model), arg.trim() || undefined)
    .catch(() => false);
  if (!ok) return ui.warn("nothing to compact yet — the conversation is still short");
  ui.ok(`context compacted  ~${before} → ~${s.context.tokens()} tokens`);
}

/** Show the settings panel, or run a settings sub-command like `web on`. */
async function runSettings(s: Session, arg: string): Promise<void> {
  const [name, ...rest] = arg.trim().split(/\s+/);
  if (name) {
    const cmd = SETTINGS_INDEX.get(name.toLowerCase());
    if (!cmd) return ui.warn(`unknown setting: ${name} — try /settings`);
    return void (await cmd.run(s, rest.join(" ")));
  }
  // Interactive radio-style menu in the TUI; plain panel everywhere else.
  if (s.select) return settingsMenu(s);

  const check = s.verifier ? s.verifier.command : "none found";
  ui.log(ui.dim("  settings:"));
  ui.log(`    ${"web".padEnd(8)} ${webOn(s) ? ui.green("on") : ui.dim("off")}`);
  ui.log(`    ${"verify".padEnd(8)} ${s.verify}  ${ui.dim("· " + check)}`);
  ui.log(`    ${"rules".padEnd(8)} ${s.rulesPath ? ui.green(s.rulesPath) : ui.dim("none found")}`);
  ui.log(`    ${"effort".padEnd(8)} ${s.effort}`);
  ui.log(`    ${"cwd".padEnd(8)} ${ui.dim(process.cwd())}`);
  ui.log(`    ${"server".padEnd(8)} ${ui.dim(s.baseUrl)}`);
  ui.log(ui.dim("  change one:  /settings web on|off · /settings ping · /effort"));
}

/** Modal settings menu: Enter on a row toggles/cycles it; the menu re-opens with fresh state. */
async function settingsMenu(s: Session): Promise<void> {
  const cycle = { auto: "on", on: "off", off: "auto" } as const;
  for (;;) {
    const items = [
      `web search   ${webOn(s) ? "● on" : "○ off"}`,
      `verify       ${s.verify}${s.verifier ? "" : " (no check)"}`,
      "ping server",
      "close",
    ];
    const pick = await s.select!("Settings  (↑/↓ · Enter · Esc)", items);
    if (pick === null || pick.startsWith("close")) return;
    if (pick.startsWith("web")) { s.setWeb?.(!webOn(s)); continue; }
    if (pick.startsWith("verify")) { s.setVerify?.(cycle[s.verify]); continue; }
    if (pick.startsWith("ping")) { await SETTINGS_INDEX.get("ping")!.run(s, ""); return; }
  }
}

const COMMAND_INDEX = new Map<string, SlashCommand>(
  COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])].map((n) => [n, c] as const)),
);

function printMenu(): void {
  ui.log(ui.dim("  commands:"));
  for (const c of COMMANDS) {
    ui.log(`    ${ui.cyan("/" + c.name).padEnd(20)} ${ui.dim(c.desc)}`);
  }
}

function version(): string {
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "../package.json");
    return JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function bannerLines(model: string): string[] {
  const v = ui.dim("v" + version());
  return [
    "",
    "  " + ui.magenta("╭─────╮"),
    "  " + ui.magenta("│     │") + "   " + ui.bold("lema") + "  " + v,
    "  " + ui.magenta("│  ") + ui.bold(ui.magenta("λ")) + ui.magenta("  │") + "   " + model + ui.dim(" · local"),
    "  " + ui.magenta("│     │") + "   " + ui.dim(process.cwd()),
    "  " + ui.magenta("╰─────╯"),
    "",
  ];
}

let activeSpinner: ui.SpinHandle | null = null;

/** Default renderer for non-TTY and single-task runs: spinner + console output. */
export function consoleRenderer(e: AgentEvent): void {
  if (e.type !== "thinking" && activeSpinner) {
    activeSpinner.stop();
    activeSpinner = null;
  }
  if (e.type === "thinking") {
    activeSpinner = ui.spinner("thinking…");
  } else if (e.type === "step") {
    ui.step(e.label ?? "step", e.text ?? "");
  } else if (e.type === "tool") {
    ui.tool(e.tool ?? "?", e.detail ?? "");
  } else if (e.type === "tool-result") {
    ui.toolResult(e.text ?? "");
  } else if (e.type === "assistant" && e.text) {
    ui.log(renderMarkdown(e.text));
  } else if (e.type === "done") {
    ui.log();
    ui.log(renderMarkdown(e.text ?? ""));
  }
}

/** Renders agent events into the TUI: status spinner + transcript output. */
function tuiRenderer(tui: Tui): (e: AgentEvent) => void {
  return (e) => {
    if (e.type === "thinking") tui.setStatus("thinking…");
    else if (e.type === "thinking-stop") tui.setStatus(null);
    else if (e.type === "step") ui.step(e.label ?? "step", e.text ?? "");
    else if (e.type === "tool") ui.tool(e.tool ?? "?", e.detail ?? "");
    else if (e.type === "tool-result") ui.toolResult(e.text ?? "");
    else if (e.type === "assistant" && e.text?.trim()) ui.log(formatResponse(e.text));
    else if (e.type === "done" && e.text?.trim()) ui.log(formatResponse(e.text));
  };
}

async function dispatch(session: Session, raw: string, signal?: AbortSignal): Promise<boolean> {
  const [name, ...rest] = raw.split(/\s+/);
  const cmd = COMMAND_INDEX.get(name.toLowerCase());
  if (cmd) return (await cmd.run(session, rest.join(" "))) === true;

  // Not a built-in command — maybe it's an authored skill: /<name> [task].
  const skill = session.skills.load(name);
  if (skill) {
    session.context.push({
      role: "system",
      content: `The user invoked the "${skill.name}" skill. Follow it:\n\n${skill.body}`,
    });
    ui.step("skill", `${skill.name} [${skill.scope}]`);
    const task = rest.join(" ").trim();
    if (task) await runTask(session, task, signal);
    else ui.log(ui.dim("  skill loaded — now describe what to do with it"));
    return false;
  }

  ui.warn(`unknown command: /${name} — type /help, or /skills`);
  return false;
}

async function runTask(session: Session, task: string, signal?: AbortSignal): Promise<void> {
  const render = session.render ?? consoleRenderer;
  await runAgent(task, {
    maxSteps: session.maxSteps,
    maxTokens: session.maxTokens,
    effort: session.effort,
    verify: session.verify,
    verifier: session.verifier,
    provider: session.provider,
    cwd: process.cwd(),
    memory: session.memory,
    skillsMeta: session.skills.metadataBlock() ?? undefined,
    context: session.context,
    tools: session.tools,
    signal,
    onEvent: (e) => {
      render(e);
      // "stats" fires every step for a live footer; "done" carries the final tally.
      if ((e.type === "stats" || e.type === "done") && e.stats) session.onStats?.(e.stats);
    },
  });
  ui.log();
}

/** Process one input line. Returns true when the session should end. */
async function handle(session: Session, raw: string, signal?: AbortSignal): Promise<boolean> {
  const input = raw.trim();
  if (!input) return false;
  try {
    if (input === "/") printMenu();
    else if (input.startsWith("/")) return await dispatch(session, input.slice(1), signal);
    else await runTask(session, input, signal);
  } catch (e) {
    if ((e as Error).name === "AbortError") return false;
    ui.err((e as Error).message);
  }
  return false;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let data = "";
  for await (const chunk of stream) data += chunk;
  return data;
}

/** Non-TTY (piped/scripted) input: read it all, run line by line, no races. */
async function runBatch(session: Session): Promise<void> {
  const text = await readAll(stdin);
  for (const line of text.split(/\r?\n/)) {
    if (await handle(session, line)) break;
  }
}

/** Start the interactive session. Bare `lema` lands here. */
export async function startRepl(cfg: LemaConfig, provider: ModelProvider): Promise<void> {
  const checkCmd = discoverCheck(process.cwd(), cfg.check);
  const loadedRules = loadRulesPreamble(process.cwd(), cfg.rules);
  const session: Session = {
    baseUrl: cfg.baseUrl,
    maxSteps: cfg.maxSteps,
    maxTokens: cfg.maxTokens,
    effort: cfg.effort,
    verify: cfg.reliability.verify,
    verifier: checkCmd ? makeVerifier(checkCmd) : undefined,
    rulesPath: loadedRules?.path,
    provider,
    memory: new MemoryStore(cfg, provider),
    skills: new SkillLibrary(),
    context: new ContextManager({ budget: cfg.context, rules: loadedRules?.preamble }),
    tools: getTools(cfg),
  };
  const model = await provider.resolveModel().catch(() => "(no model loaded)");

  if (!stdin.isTTY) {
    bannerLines(model).forEach((l) => ui.log(l));
    await runBatch(session);
    ui.log(ui.dim("bye"));
    return;
  }

  // The footer starts with the model, then switches to live token stats after each run.
  let footerRight = `${model} · local`;
  session.onStats = (s) => {
    footerRight = formatStats(s);
  };

  const tuiCommands: TuiCommand[] = COMMANDS.map((c) => ({ name: c.name, desc: c.desc }));
  const tui = new Tui({
    header: () => bannerLines(model),
    commands: tuiCommands,
    footerRight: () => footerRight,
    placeholder: 'Try "add a /health route and a test"  ·  / for commands',
    onSubmit: (line, signal) => handle(session, line, signal),
  });

  // Capture all transcript output into the TUI, and route agent events to it.
  session.render = tuiRenderer(tui);
  session.select = (title, items) => tui.select(title, items);
  session.setModel = (id) => {
    cfg.model = id;
    footerRight = `${id} · local`;
  };
  session.setWeb = (on) => {
    cfg.tools = { ...cfg.tools, web: on };
    session.tools = getTools(cfg);
  };
  session.setEffort = (e) => {
    cfg.effort = e;
    session.effort = e;
  };
  session.setVerify = (m) => {
    cfg.reliability = { ...cfg.reliability, verify: m };
    session.verify = m;
  };
  ui.setSink((s) => tui.print(s));
  try {
    await tui.run();
  } finally {
    ui.setSink(null);
  }
  ui.log(ui.dim("bye"));
}
