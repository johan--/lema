import type { ToolSchema } from "../provider.js";
import { resolve, sep } from "node:path";

export interface Tool {
  schema: ToolSchema;
  run(args: Record<string, any>, ctx: ToolContext): Promise<string>;
}

export interface ToolContext {
  cwd: string;
  /** Cancellation from the REPL (Esc). Long-running tools must honor it. */
  signal?: AbortSignal;
}

export function def(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  run: Tool["run"],
): Tool {
  return { schema: { type: "function", function: { name, description, parameters } }, run };
}

export function obj(props: Record<string, unknown>, required: string[]) {
  return { type: "object", properties: props, required };
}

/** Resolve a path inside cwd; throw if it escapes. */
export function safe(cwd: string, p: string): string {
  const root = resolve(cwd);
  const abs = resolve(cwd, p);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`Path escapes working directory: ${p}`);
  }
  return abs;
}
