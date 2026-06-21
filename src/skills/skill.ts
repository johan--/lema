/**
 * An authored skill: a SKILL.md package the user (or the model) writes.
 * Distinct from learned memory (src/memory.ts) — these are explicit, invocable
 * capabilities, loaded on demand (progressive disclosure).
 */
export interface SkillMeta {
  name: string;
  description: string;
  scope: "project" | "global";
  /** Absolute path to the skill's SKILL.md. */
  file: string;
}

export interface Skill extends SkillMeta {
  /** The instruction body (Markdown after the frontmatter). */
  body: string;
}

export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
}

/**
 * Parse a SKILL.md: a YAML-ish frontmatter block (--- … ---) with at least
 * `name` and `description`, followed by the Markdown body. Returns null when the
 * frontmatter or required fields are missing, so callers skip malformed files.
 */
export function parseSkill(md: string): ParsedSkill | null {
  const m = md.match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const [, front, body] = m;

  const fields: Record<string, string> = {};
  for (const line of front.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kv) fields[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }

  const name = fields.name?.trim();
  const description = fields.description?.trim();
  if (!name || !description) return null;
  return { name, description, body: body.trim() };
}

/** Serialise a skill back to SKILL.md text (used by the AI skill-creator). */
export function renderSkill(s: ParsedSkill): string {
  const desc = s.description.replace(/\n+/g, " ").trim();
  return `---\nname: ${s.name}\ndescription: ${desc}\n---\n\n${s.body.trim()}\n`;
}

/** Normalise a free-form name into a kebab-case skill handle. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "skill";
}
