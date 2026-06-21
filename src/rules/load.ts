import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface ProjectRules {
  /** The relative path that was loaded (for display). */
  path: string;
  /** The rules text (capped). */
  text: string;
}

/** Resolution order: the open standard first, then aliases. */
const CANDIDATES = ["AGENTS.md", "CLAUDE.md", ".lema/rules.md"];
/** Cap so a huge rules file can't dominate a small context window. */
const MAX_CHARS = 4000;

/**
 * Load the project's rules file from cwd (AGENTS.md → CLAUDE.md → .lema/rules.md).
 * Best-effort: a missing or unreadable file returns null, never throws.
 */
export function loadRules(cwd: string): ProjectRules | null {
  for (const rel of CANDIDATES) {
    const p = resolve(cwd, rel);
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, "utf8").trim();
      if (!raw) continue;
      const text = raw.length > MAX_CHARS ? `${raw.slice(0, MAX_CHARS)}\n…[rules truncated]` : raw;
      return { path: rel, text };
    } catch {
      /* unreadable — try the next candidate */
    }
  }
  return null;
}

/**
 * Condense rules to a short reminder for the end-anchor (fights lost-in-the-middle
 * cheaply): markdown headings if there are enough, else the first few lines.
 */
export function condenseRules(text: string): string {
  const headings = text
    .split("\n")
    .filter((l) => /^#{1,6}\s/.test(l))
    .map((l) => `• ${l.replace(/^#{1,6}\s+/, "").trim()}`);
  if (headings.length >= 2) return headings.slice(0, 12).join("\n");
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join("\n");
}

/** Build the preamble object the ContextManager injects (start + end anchors). */
export function rulesPreamble(rules: ProjectRules, reinject: boolean, reinjectEvery: number) {
  return {
    full: `Project rules (${rules.path}). Follow them throughout:\n\n${rules.text}`,
    condensed: condenseRules(rules.text),
    reinject,
    reinjectEvery,
  };
}

export type RulesPreamble = ReturnType<typeof rulesPreamble>;

export interface RulesConfig {
  enabled: boolean;
  reinject: boolean;
  reinjectEvery: number;
}

/** Load + build the preamble for a cwd, honouring config. Returns null when off/absent. */
export function loadRulesPreamble(cwd: string, cfg: RulesConfig): { preamble: RulesPreamble; path: string } | null {
  if (!cfg.enabled) return null;
  const rules = loadRules(cwd);
  if (!rules) return null;
  return { preamble: rulesPreamble(rules, cfg.reinject, cfg.reinjectEvery), path: rules.path };
}
