import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const pexec = promisify(execFile);

export interface CheckResult {
  ok: boolean;
  output: string;
}

/** Runs a project check command and reports pass/fail. The agent depends on this. */
export interface Verifier {
  command: string;
  run(cwd: string): Promise<CheckResult>;
}

/**
 * Discover the project's check command — never guessing anything destructive.
 * An explicit config value wins; else a package.json script (test > build > lint);
 * else a Makefile `test` target. Returns null when nothing is found, so the agent
 * simply behaves as if verification were off.
 */
export function discoverCheck(cwd: string, explicit?: string): string | null {
  if (explicit && explicit.trim()) return explicit.trim();

  const pkgPath = resolve(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const scripts = (JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {}) as Record<string, string>;
      for (const name of ["test", "build", "lint"]) {
        if (typeof scripts[name] === "string" && scripts[name].trim()) return `npm run ${name}`;
      }
    } catch {
      /* unreadable package.json — fall through */
    }
  }

  const mk = resolve(cwd, "Makefile");
  if (existsSync(mk)) {
    try {
      if (/^test:/m.test(readFileSync(mk, "utf8"))) return "make test";
    } catch {
      /* ignore */
    }
  }

  return null;
}

/** Build a Verifier that runs `command` through the shell with a bounded timeout/buffer. */
export function makeVerifier(command: string): Verifier {
  return {
    command,
    async run(cwd: string): Promise<CheckResult> {
      try {
        const { stdout, stderr } = await pexec("/bin/sh", ["-c", command], {
          cwd,
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        const output = (stdout + (stderr ? `\n${stderr}` : "")).trim();
        return { ok: true, output };
      } catch (err: any) {
        const output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || err.message || "command failed";
        return { ok: false, output };
      }
    },
  };
}
