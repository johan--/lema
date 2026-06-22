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
  // Editors, pagers, monitors, follows.
  { re: /^(?:sudo\s+)?(?:vi|vim|nvim|nano|emacs|pico)\b/, why: "a text editor" },
  { re: /^(?:sudo\s+)?(?:less|more|man)\b/, why: "a pager" },
  { re: /^(?:sudo\s+)?(?:top|htop|watch|journalctl)\b/, why: "a live monitor" },
  { re: /\btail\s+-[a-zA-Z]*f/, why: "a follow that never exits" },
  { re: /\bdocker\b.*\blogs\s+-[a-zA-Z]*f/, why: "a log follow that never exits" },
  // Interactive REPLs / shells (the bare interpreter, no script).
  { re: /^(?:python3?|node|deno|irb|pry|ghci|R|psql|mysql|sqlite3|mongosh|redis-cli|bash|sh|zsh|fish|iex|clj|scala|dart|php\s+-a)\s*$/, why: "an interactive REPL/shell" },
  // JS/TS dev servers and watchers.
  { re: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:start|dev|serve|watch)\b/, why: "a dev server or watcher" },
  { re: /\b(?:next|nuxt|remix|astro)\s+dev\b/, why: "a dev server" },
  { re: /\b(?:vite|nodemon|http-server|live-server|webpack-dev-server|ng\s+serve|gatsby\s+develop|expo\s+start|react-native\s+start|storybook\s+dev)\b/, why: "a dev server" },
  // Python web frameworks.
  { re: /\bflask\s+run\b/, why: "a dev server" },
  { re: /\bmanage\.py\s+runserver\b/, why: "a Django dev server" },
  { re: /\b(?:uvicorn|gunicorn|hypercorn|daphne|streamlit\s+run|jupyter\s+(?:notebook|lab))\b/, why: "a server/notebook" },
  // Ruby / PHP.
  { re: /\brails\s+(?:s|server)\b/, why: "a dev server" },
  { re: /\b(?:bundle\s+exec\s+)?(?:rackup|puma|unicorn|shotgun)\b/, why: "a dev server" },
  { re: /\bphp\s+-S\b/, why: "a dev server" },
  { re: /\bphp\s+artisan\s+serve\b/, why: "a Laravel dev server" },
  { re: /\bsymfony\s+(?:serve|server:start)\b/, why: "a dev server" },
  // Dart / Flutter.
  { re: /\bflutter\s+(?:run|daemon|attach|drive)\b/, why: "a Flutter run/watch that never exits" },
  { re: /\bwebdev\s+serve\b/, why: "a Dart dev server" },
  // Go / Rust / Java / .NET / Elixir / Hugo / Jekyll.
  { re: /\b(?:air|gin|realize|reflex)\b/, why: "a Go live-reload server" },
  { re: /\bcargo\s+watch\b/, why: "a Rust watcher" },
  { re: /\b(?:trunk\s+serve|dx\s+serve)\b/, why: "a Rust web dev server" },
  { re: /\bmvn\b.*\bspring-boot:run\b/, why: "a Spring Boot server" },
  { re: /\b(?:gradlew?|\.\/gradlew)\s+(?:bootRun|run)\b/, why: "a Gradle run that may not exit" },
  { re: /\bdotnet\s+(?:run|watch)\b/, why: "a .NET run/watch server" },
  { re: /\bmix\s+phx\.server\b/, why: "a Phoenix server" },
  { re: /\b(?:hugo\s+server|jekyll\s+serve)\b/, why: "a static-site dev server" },
  // Generic watch flag.
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
