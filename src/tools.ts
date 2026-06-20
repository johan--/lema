import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { promisify } from "node:util";
import type { ToolSchema } from "./provider.js";

const pexec = promisify(execFile);

export interface Tool {
  schema: ToolSchema;
  run(args: Record<string, any>, ctx: ToolContext): Promise<string>;
}

export interface ToolContext {
  cwd: string;
}

function def(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  run: Tool["run"],
): Tool {
  return { schema: { type: "function", function: { name, description, parameters } }, run };
}

function obj(props: Record<string, unknown>, required: string[]) {
  return { type: "object", properties: props, required };
}

const safe = (cwd: string, p: string) => {
  const abs = resolve(cwd, p);
  if (!abs.startsWith(resolve(cwd))) throw new Error(`Path escapes working directory: ${p}`);
  return abs;
};

export const readFile = def(
  "read_file",
  "Read a UTF-8 text file relative to the working directory.",
  obj({ path: { type: "string", description: "Path relative to the working directory." } }, ["path"]),
  async ({ path }, ctx) => {
    const abs = safe(ctx.cwd, path);
    if (!existsSync(abs)) return `ERROR: file not found: ${path}`;
    const text = readFileSync(abs, "utf8");
    return text.length > 20000 ? text.slice(0, 20000) + "\n...[truncated]" : text;
  },
);

export const writeFile = def(
  "write_file",
  "Create or overwrite a text file relative to the working directory.",
  obj(
    {
      path: { type: "string", description: "Path relative to the working directory." },
      content: { type: "string", description: "Full file content to write." },
    },
    ["path", "content"],
  ),
  async ({ path, content }, ctx) => {
    const abs = safe(ctx.cwd, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    return `OK: wrote ${content.length} bytes to ${path}`;
  },
);

export const listDir = def(
  "list_dir",
  "List entries of a directory relative to the working directory.",
  obj({ path: { type: "string", description: "Directory path; '.' for the root." } }, ["path"]),
  async ({ path }, ctx) => {
    const abs = safe(ctx.cwd, path || ".");
    if (!existsSync(abs)) return `ERROR: directory not found: ${path}`;
    return readdirSync(abs, { withFileTypes: true })
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .join("\n");
  },
);

export const bash = def(
  "bash",
  "Run a shell command in the working directory and return combined stdout/stderr. Use for running tests, builds, git, etc.",
  obj({ command: { type: "string", description: "The shell command to execute." } }, ["command"]),
  async ({ command }, ctx) => {
    try {
      const { stdout, stderr } = await pexec("/bin/sh", ["-c", command], {
        cwd: ctx.cwd,
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const out = (stdout + (stderr ? `\n[stderr]\n${stderr}` : "")).trim();
      return out || "(no output)";
    } catch (err: any) {
      const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
      return `EXIT ${err.code ?? "?"}: ${out || err.message}`;
    }
  },
);

export const ALL_TOOLS: Tool[] = [readFile, writeFile, listDir, bash];

export function toolMap(tools: Tool[] = ALL_TOOLS): Map<string, Tool> {
  return new Map(tools.map((t) => [t.schema.function.name, t]));
}
