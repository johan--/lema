import { spawn } from "node:child_process";
import { def, obj } from "./types.js";

const TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 10 * 1024 * 1024;

/**
 * Known command shapes that block on input or never exit (REPLs, dev servers,
 * watchers, pagers, editors). Running them to "verify" code makes no progress —
 * an interactive program waits for a keystroke, a server runs until killed. We
 * refuse them before spawning and point the model at a non-interactive check.
 * Patterns are conservative (anchored, word-bounded) to avoid false positives.
 */
const BLOCKERS: Array<{ re: RegExp; why: string }> = [
  { re: /^(?:sudo\s+)?(?:vi|vim|nvim|nano|emacs|pico)\b/, why: "a text editor" },
  { re: /^(?:sudo\s+)?(?:less|more|man)\b/, why: "a pager" },
  { re: /^(?:sudo\s+)?(?:top|htop|watch)\b/, why: "a live monitor" },
  { re: /\btail\s+-[a-zA-Z]*f/, why: "a follow that never exits" },
  { re: /^(?:python3?|node|deno|irb|ghci|R|psql|mysql|sqlite3|bash|sh|zsh|fish)\s*$/, why: "an interactive REPL/shell" },
  { re: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:start|dev|serve|watch)\b/, why: "a dev server or watcher" },
  { re: /\b(?:flask\s+run|php\s+-S|next\s+dev|nuxt\s+dev|vite|nodemon|http-server|live-server)\b/, why: "a dev server" },
  { re: /\brails\s+(?:s|server)\b/, why: "a dev server" },
  { re: /\bmanage\.py\s+runserver\b/, why: "a dev server" },
  { re: /\s--watch\b/, why: "a watch mode that never exits" },
];

/** If a command is a known interactive/long-running blocker, return why; else null. */
export function classifyBlocking(command: string): string | null {
  // Check each &&/||/;/| segment so `cd x && npm start` is still caught.
  for (const seg of command.split(/&&|\|\||[;|]/)) {
    const s = seg.trim();
    for (const { re, why } of BLOCKERS) if (re.test(s)) return why;
  }
  return null;
}

export const bash = def(
  "bash",
  "Run a shell command for execution tasks: tests, builds, git, package managers. Not for reading or searching — use read_file, grep, glob for that. Runs non-interactively (stdin is closed); do not start interactive or long-running programs.",
  obj({ command: { type: "string", description: "The shell command to execute." } }, ["command"]),
  ({ command }, ctx) =>
    new Promise<string>((resolve) => {
      // Refuse known interactive/long-running commands before spawning: they
      // can't verify code and only waste a step (or stall up to the timeout).
      const why = classifyBlocking(command);
      if (why) {
        resolve(
          `EXIT blocked: this looks like ${why} — it waits for input or never exits, so it can't verify code. ` +
            `Run the tests or a syntax/compile check (e.g. \`node --check\`, \`python3 -m py_compile\`) instead.`,
        );
        return;
      }
      // stdin is closed ("ignore") so a program that reads input gets EOF and
      // exits instead of hanging forever waiting for a keystroke.
      const child = spawn("/bin/sh", ["-c", command], { cwd: ctx.cwd, stdio: ["ignore", "pipe", "pipe"] });

      let out = "";
      let truncated = false;
      let done = false;
      const collect = (b: Buffer) => {
        if (out.length < MAX_OUTPUT) out += b.toString();
        else truncated = true;
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);

      const finish = (prefix: string): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        const text = (out.trim() + (truncated ? "\n…(output truncated)" : "")).trim();
        if (prefix) resolve(text ? `${prefix}\n${text}` : prefix);
        else resolve(text || "(no output)");
      };

      const onAbort = (): void => { child.kill("SIGKILL"); finish("EXIT aborted: command cancelled"); };
      const timer = setTimeout(() => { child.kill("SIGKILL"); finish("EXIT timeout: exceeded 120s"); }, TIMEOUT_MS);

      if (ctx.signal) {
        if (ctx.signal.aborted) return onAbort();
        ctx.signal.addEventListener("abort", onAbort, { once: true });
      }

      child.on("error", (e) => finish(`EXIT ?: ${e.message}`));
      child.on("close", (code) => finish(code === 0 ? "" : `EXIT ${code ?? "?"}:`));
    }),
);
