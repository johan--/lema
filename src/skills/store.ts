import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { parseSkill, renderSkill, type Skill, type SkillMeta, type ParsedSkill } from "./skill.js";

/**
 * Discovers and loads authored skills from two scopes:
 *   project: <cwd>/.lema/skills/<name>/SKILL.md
 *   global:  ~/.lema/skills/<name>/SKILL.md
 * On a name clash the project skill wins. Loading is lazy (progressive
 * disclosure): list() returns metadata only; load() reads a body on demand.
 */
export class SkillLibrary {
  private readonly projectDir: string;
  private readonly globalDir: string;

  constructor(cwd: string = process.cwd(), home: string = homedir()) {
    this.projectDir = resolve(cwd, ".lema", "skills");
    this.globalDir = resolve(home, ".lema", "skills");
  }

  /** All skills' metadata (project overrides global by name). Bodies not loaded. */
  list(): SkillMeta[] {
    const byName = new Map<string, SkillMeta>();
    // Global first, then project, so project entries overwrite on clash.
    for (const meta of this.scan(this.globalDir, "global")) byName.set(meta.name, meta);
    for (const meta of this.scan(this.projectDir, "project")) byName.set(meta.name, meta);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Load a single skill (with body) by name, or null if absent/malformed. */
  load(name: string): Skill | null {
    const meta = this.list().find((m) => m.name === name);
    if (!meta) return null;
    const parsed = parseSkill(readFileSync(meta.file, "utf8"));
    return parsed ? { ...meta, body: parsed.body } : null;
  }

  /** One-line-per-skill metadata block for the system preamble (L1 disclosure). */
  metadataBlock(): string | null {
    const all = this.list();
    if (!all.length) return null;
    const lines = all.map((m) => `- /${m.name} — ${m.description}`);
    return `Available skills (the user can invoke one with /<name>):\n${lines.join("\n")}`;
  }

  /** Write a new skill to the chosen scope; returns its SKILL.md path. */
  write(skill: ParsedSkill, scope: "project" | "global"): string {
    const base = scope === "global" ? this.globalDir : this.projectDir;
    const dir = join(base, skill.name);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "SKILL.md");
    writeFileSync(file, renderSkill(skill), "utf8");
    return file;
  }

  /** Read <dir>/<name>/SKILL.md entries, skipping anything malformed. */
  private scan(dir: string, scope: "project" | "global"): SkillMeta[] {
    if (!existsSync(dir)) return [];
    const out: SkillMeta[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(dir, entry.name, "SKILL.md");
      if (!existsSync(file)) continue;
      try {
        const parsed = parseSkill(readFileSync(file, "utf8"));
        if (parsed) out.push({ name: parsed.name, description: parsed.description, scope, file });
      } catch {
        /* unreadable — skip */
      }
    }
    return out;
  }
}
