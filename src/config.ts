import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface LemaConfig {
  /** OpenAI-compatible base URL (LM Studio, Ollama, llama.cpp, ...). */
  baseUrl: string;
  /** Model id to use. If omitted, the first loaded model from /models is used. */
  model?: string;
  /** Embedding model id, used by the skill memory. */
  embedModel: string;
  /** Sampling temperature. Local code models like it low. */
  temperature: number;
  /** Max tokens per completion. */
  maxTokens: number;
  /** Max tool-calling steps before the agent gives up. */
  maxSteps: number;
  /** Directory (relative to cwd) where lema keeps skills + playbook. */
  stateDir: string;
}

export const DEFAULTS: LemaConfig = {
  baseUrl: process.env.LEMA_BASE_URL ?? "http://localhost:1234/v1",
  embedModel: process.env.LEMA_EMBED_MODEL ?? "text-embedding-nomic-embed-text-v1.5",
  temperature: 0.2,
  maxTokens: 2048,
  maxSteps: 12,
  stateDir: ".lema",
};

/** Load lema.config.json from cwd (if present) merged over defaults + env. */
export function loadConfig(cwd = process.cwd()): LemaConfig {
  const cfg: LemaConfig = { ...DEFAULTS };

  const path = resolve(cwd, "lema.config.json");
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<LemaConfig>;
      Object.assign(cfg, raw);
    } catch (err) {
      throw new Error(`Failed to parse lema.config.json: ${(err as Error).message}`);
    }
  }

  // Env wins over the file; only set `model` when actually provided.
  if (process.env.LEMA_MODEL) cfg.model = process.env.LEMA_MODEL;

  return cfg;
}
