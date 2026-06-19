import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Provider } from "./provider.js";
import { ensureStateDir } from "./tools.js";
import type { LemaConfig } from "./config.js";

export type SkillKind = "knowledge" | "procedure";

export interface Skill {
  id: string;
  name: string;
  /** One line; used for embedding-based retrieval. Keep it descriptive. */
  description: string;
  kind: SkillKind;
  /** For knowledge: the lesson. For procedure: the code/command to reuse. */
  body: string;
  createdAt: string;
  uses: number;
  wins: number;
  embedding?: number[];
}

function cosine(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * File-backed skill library. Each skill is one JSON file under <stateDir>/skills/.
 * Retrieval is by cosine similarity over embeddings of `name + description`.
 * This is the heart of lema's self-improvement: verified solutions become reusable.
 */
export class SkillStore {
  private dir: string;
  constructor(private cfg: LemaConfig, private provider: Provider, cwd = process.cwd()) {
    this.dir = resolve(ensureStateDir(cwd, cfg.stateDir), "skills");
    ensureStateDir(cwd, `${cfg.stateDir}/skills`);
  }

  all(): Skill[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(resolve(this.dir, f), "utf8")) as Skill);
  }

  private path(id: string) {
    return resolve(this.dir, `${id}.json`);
  }

  /** Persist a new skill, computing its retrieval embedding. */
  async save(input: { name: string; description: string; kind: SkillKind; body: string }): Promise<Skill> {
    const [embedding] = await this.provider.embed([`${input.name}. ${input.description}`]);
    const skill: Skill = {
      id: randomUUID().slice(0, 8),
      ...input,
      createdAt: new Date().toISOString(),
      uses: 0,
      wins: 0,
      embedding,
    };
    writeFileSync(this.path(skill.id), JSON.stringify(skill, null, 2));
    return skill;
  }

  /** Return the topK skills most relevant to the query. */
  async search(query: string, topK = 3): Promise<Skill[]> {
    const skills = this.all();
    if (skills.length === 0) return [];
    const [q] = await this.provider.embed([query]);
    return skills
      .map((s) => ({ s, score: s.embedding ? cosine(q, s.embedding) : 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((x) => x.s);
  }

  /** Record an outcome so weak skills can be pruned later. */
  record(id: string, win: boolean): void {
    const p = this.path(id);
    if (!existsSync(p)) return;
    const s = JSON.parse(readFileSync(p, "utf8")) as Skill;
    s.uses += 1;
    if (win) s.wins += 1;
    writeFileSync(p, JSON.stringify(s, null, 2));
  }
}
