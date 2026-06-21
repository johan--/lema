/**
 * Effort: a session-level reasoning dial for small local models.
 *
 * It is a deterministic preset over concrete knobs (step budget, token budget,
 * a short behavioural hint), not a "think more" switch. For SLMs the dominant
 * failure is overthinking, so `low` is a first-class setting and `medium` (the
 * default) reproduces the configured budgets exactly.
 */
/** Concrete reasoning levels. `auto` (below) resolves to one of these per task. */
export type Effort = "low" | "medium" | "high" | "ultra";

/** Settable values, including `auto` which picks a level from the task. */
export type EffortSetting = Effort | "auto";

export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "ultra"];
export const EFFORT_SETTINGS: readonly EffortSetting[] = ["auto", "low", "medium", "high", "ultra"];

/**
 * Pick an effort level from the task text — cheap, no model call (E2). Heavy
 * build/fix work or long asks get `high`; short factual questions get `low`;
 * everything else `medium`. Never auto-selects `ultra` — that stays opt-in
 * because its verify gate is expensive.
 */
export function estimateEffort(task: string): Effort {
  const t = task.toLowerCase().trim();
  const words = t.split(/\s+/).filter(Boolean).length;
  const heavy = /\b(implement|refactor|build|create|add|fix|debug|migrat|optimi[sz]e|rewrite|design|test|deploy|integrat|generate)\b/.test(t);
  const trivial = words <= 8 && /\b(what|which|who|where|when|show|list|explain|describe|print|tell)\b/.test(t);
  if (heavy || words > 40) return "high";
  if (trivial) return "low";
  return "medium";
}

export interface EffortBase {
  maxSteps: number;
  maxTokens: number;
}

export interface EffortProfile {
  maxSteps: number;
  maxTokens: number;
  /** Appended to the system prompt to steer thoroughness. Empty for medium. */
  hint: string;
  /**
   * Default whether to run the tool-grounded verification loop (run the project's
   * check and gate success on green). Overridable by `reliability.verify` config.
   * Research: small models self-verify poorly but verify well with tools.
   */
  verify: boolean;
  /** Ask the model to plan subgoals up front before acting (high/ultra). */
  plan: boolean;
  /** Native reasoning hint to pass through when the server supports it (E1). */
  reasoning?: "low" | "medium" | "high";
}

const MIN_STEPS = 4;
const MIN_TOKENS = 512;

const PLAN_HINT =
  "Start by briefly listing the concrete subgoals, then work through them in order, " +
  "using tools to check your work as you go.";

/** Resolve an effort level into concrete budgets + a prompt hint. Pure. */
export function effortProfile(effort: Effort, base: EffortBase): EffortProfile {
  switch (effort) {
    case "low":
      return {
        maxSteps: Math.max(MIN_STEPS, Math.ceil(base.maxSteps / 2)),
        maxTokens: Math.max(MIN_TOKENS, Math.floor(base.maxTokens / 2)),
        hint: "Answer concisely. Take the most direct path and avoid unnecessary reasoning or extra tool calls.",
        verify: false,
        plan: false,
      };
    case "high":
      return {
        maxSteps: base.maxSteps * 2,
        maxTokens: base.maxTokens * 2,
        hint: `Work carefully and double-check before finishing. ${PLAN_HINT}`,
        verify: true,
        plan: true,
        reasoning: "high",
      };
    case "ultra":
      // Scale STEPS (room for verify-and-fix rounds), not the monologue — for a
      // small model more tool actions help, more thinking tokens invite overthinking.
      return {
        maxSteps: base.maxSteps * 3,
        maxTokens: base.maxTokens * 2,
        hint: `Be thorough; correctness matters more than speed. ${PLAN_HINT}`,
        verify: true,
        plan: true,
        reasoning: "high",
      };
    default: // medium and any unknown value
      return { maxSteps: base.maxSteps, maxTokens: base.maxTokens, hint: "", verify: false, plan: false };
  }
}
