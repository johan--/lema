import { spawn } from "node:child_process";
import { def, obj } from "./types.js";

const TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 10 * 1024 * 1024;

export const bash = def(
  "bash",
  "Run a shell command for execution tasks: tests, builds, git, package managers. Not for reading or searching — use read_file, grep, glob for that. Runs non-interactively (stdin is closed); do not start interactive or long-running programs.",
  obj({ command: { type: "string", description: "The shell command to execute." } }, ["command"]),
  ({ command }, ctx) =>
    new Promise<string>((resolve) => {
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
