import { stdin, stdout } from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { LemaConfig } from "./config.js";
import { Provider } from "./provider.js";
import { SkillStore } from "./skills.js";
import { runAgent, consoleRenderer } from "./agent.js";
import { runTui, type TuiCommand } from "./tui.js";
import * as ui from "./ui.js";

interface Session {
  cfg: LemaConfig;
  provider: Provider;
  skills: SkillStore;
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
    desc: "list models on the server",
    run: async (s) => {
      const models = await s.provider.listModels();
      models.forEach((m) => ui.log("  " + m));
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
      ui.ok(`server up at ${s.cfg.baseUrl} — ${models.length} model(s)`);
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

function banner(model: string): void {
  const v = ui.dim("v" + version());
  ui.log();
  ui.log("  " + ui.magenta("╭─────╮"));
  ui.log("  " + ui.magenta("│     │") + "   " + ui.bold("lema") + "  " + v);
  ui.log("  " + ui.magenta("│  ") + ui.bold(ui.magenta("λ")) + ui.magenta("  │") + "   " + model + ui.dim(" · local"));
  ui.log("  " + ui.magenta("│     │") + "   " + ui.dim(process.cwd()));
  ui.log("  " + ui.magenta("╰─────╯"));
  ui.log();
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
  ui.log();
  await runAgent(task, {
    cfg: session.cfg,
    provider: session.provider,
    cwd: process.cwd(),
    skills: session.skills,
    onEvent: consoleRenderer,
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
export async function startRepl(cfg: LemaConfig, provider: Provider): Promise<void> {
  const session: Session = { cfg, provider, skills: new SkillStore(cfg, provider) };
  const model = await provider.resolveModel().catch(() => "(no model loaded)");
  banner(model);

  if (!stdin.isTTY) {
    await runBatch(session);
    ui.log(ui.dim("bye"));
    return;
  }

  const tuiCommands: TuiCommand[] = COMMANDS.map((c) => ({ name: c.name, desc: c.desc }));
  await runTui({
    commands: tuiCommands,
    footerRight: `${model} · local`,
    placeholder: 'Try "add a /health route and a test"  ·  / for commands',
    onSubmit: (line) => {
      // Echo the submitted line into the transcript so the user sees what they sent.
      if (line) ui.log(ui.magenta("› ") + (line.startsWith("/") ? ui.cyan(line) : line));
      return handle(session, line);
    },
  });

  ui.log(ui.dim("bye"));
}
