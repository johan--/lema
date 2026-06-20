export type { Tool, ToolContext } from "./types.js";
export { def, obj, safe } from "./types.js";
export { readFile, writeFile, editFile } from "./files.js";
export { grep, glob, listDir } from "./search.js";
export { bash } from "./shell.js";
export { webSearch, webFetch, parseDDG, stripTags } from "./web.js";

import { readFile, writeFile, editFile } from "./files.js";
import { grep, glob, listDir } from "./search.js";
import { bash } from "./shell.js";
import { webSearch, webFetch } from "./web.js";
import type { Tool } from "./types.js";

/** Core 7 tools always available. Stays within the 7±2 SLM accuracy budget. */
export const ALL_TOOLS: Tool[] = [readFile, writeFile, editFile, grep, glob, listDir, bash];

/**
 * Return the active tool set for a session.
 * Web tools are off by default; enable with `{ tools: { web: true } }` in config.
 */
export function getTools(cfg?: { tools?: { web?: boolean } }): Tool[] {
  const base = [...ALL_TOOLS];
  if (cfg?.tools?.web) base.push(webSearch, webFetch);
  return base;
}

export function toolMap(tools: Tool[] = ALL_TOOLS): Map<string, Tool> {
  return new Map(tools.map((t) => [t.schema.function.name, t]));
}
