import { stdin, stdout } from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { LemaConfig } from "./config.js";
import type { ModelProvider } from "./provider.js";
import { SkillStore } from "./skills.js";
import { runAgent, formatStats, type AgentStats, type AgentEvent } from "./agent.js";
import { Tui, type TuiCommand } from "./tui.js";
import { renderMarkdown } from "./markdown.js";
import * as ui from "./ui.js";

interface Session {
  baseUrl: string;
  maxSteps: number;
  provider: ModelProvider;
  skills: SkillStore;
  /** Called with the stats of each completed run (the TUI shows them in the footer). */
  onStats?: (s: AgentStats) => void;
  /** Renderer for agent events (the TUI swaps in its own; batch uses the console). */
  render?: (e: AgentEvent) => void;
  /** Open a modal picker (TUI only); resolves to the chosen item or null. */
  select?: (title: string, items: string[]) => Promise<string | null>;
  /** Switch the active model and update the footer. */
  setModel?: (id: string) => void;
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
    desc: "list stored skills",
    run: (s) => {
      const all = s.skills.all();
      if (!all.length) return ui.warn("no skills yet — they appear as lema solves verified tasks");
      all.forEach((k) => ui.log(`  ${ui.bold(k.name)} ${ui.dim(`[${k.kind}] ${k.wins}/${k.uses}`)}`));
    },
  },
  {
    name: "ping",
    desc: "check the server is reachable",
    run: async (s) => {
      const models = await s.provider.listModels();
      ui.ok(`server up at ${s.baseUrl} — ${models.length} model(s)`);
    },
  },
  { name: "cwd", desc: "print the working directory", run: () => ui.log("  " + process.cwd()) },
  {
    name: "clear",
    desc: "clear the screen",
    run: () => {
      stdout.write("\x1b[2J\x1b[H");
    },
  },
  { name: "exit", aliases: ["quit", "q"], desc: "quit lema", run: () => true },
];

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
    ui.step("skills", e.text ?? "");
  } else if (e.type === "tool") {
    ui.tool(e.tool ?? "?", e.detail ?? "");
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
    else if (e.type === "step") ui.step("skills", e.text ?? "");
    else if (e.type === "tool") ui.tool(e.tool ?? "?", e.detail ?? "");
    else if (e.type === "assistant" && e.text) ui.log(renderMarkdown(e.text));
    else if (e.type === "done") {
      ui.log();
      ui.log(renderMarkdown(e.text ?? ""));
    }
  };
}

async function dispatch(session: Session, raw: string): Promise<boolean> {
  const [name, ...rest] = raw.split(/\s+/);
  const cmd = COMMAND_INDEX.get(name.toLowerCase());
  if (!cmd) {
    ui.warn(`unknown command: /${name} — type /help`);
    return false;
  }
  return (await cmd.run(session, rest.join(" "))) === true;
}

async function runTask(session: Session, task: string): Promise<void> {
  const render = session.render ?? consoleRenderer;
  await runAgent(task, {
    maxSteps: session.maxSteps,
    provider: session.provider,
    cwd: process.cwd(),
    skills: session.skills,
    onEvent: (e) => {
      render(e);
      if (e.type === "done" && e.stats) session.onStats?.(e.stats);
    },
  });
  ui.log();
}

/** Process one input line. Returns true when the session should end. */
async function handle(session: Session, raw: string): Promise<boolean> {
  const input = raw.trim();
  if (!input) return false;
  try {
    if (input === "/") printMenu();
    else if (input.startsWith("/")) return await dispatch(session, input.slice(1));
    else await runTask(session, input);
  } catch (e) {
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
  const session: Session = {
    baseUrl: cfg.baseUrl,
    maxSteps: cfg.maxSteps,
    provider,
    skills: new SkillStore(cfg, provider),
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
    onSubmit: (line) => handle(session, line),
  });

  // Capture all transcript output into the TUI, and route agent events to it.
  session.render = tuiRenderer(tui);
  session.select = (title, items) => tui.select(title, items);
  session.setModel = (id) => {
    cfg.model = id;
    footerRight = `${id} · local`;
  };
  ui.setSink((s) => tui.print(s));
  try {
    await tui.run();
  } finally {
    ui.setSink(null);
  }
  ui.log(ui.dim("bye"));
}
