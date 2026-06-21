import type { ChatMessage } from "../provider.js";
import {
  type ContextBudget,
  BUDGET_DEFAULTS,
  usableBudget,
  pressureStage,
  estimateTokens,
} from "./budget.js";
import { maskObservations } from "./mask.js";

/** Project-rules anchors injected at render time (never stored, never masked). */
export interface ContextRules {
  /** Full rules, injected right after the system prompt (start anchor). */
  full: string;
  /** Short reminder appended near the end when context grows (end anchor). */
  condensed: string;
  /** Whether to append the end-anchor reminder at all. */
  reinject: boolean;
  /** Re-inject the reminder every N renders (and whenever pressure is high). */
  reinjectEvery: number;
}

export interface ContextManagerOptions {
  budget?: Partial<ContextBudget>;
  rules?: ContextRules;
}

/**
 * Owns the live messages[] for a session. Applies the masking-first budget
 * policy transparently so the agent loop never reasons about context pressure.
 */
export class ContextManager {
  private readonly messages: ChatMessage[] = [];
  private readonly budget: ContextBudget;
  private readonly rules?: ContextRules;
  /** Last total_tokens reported by the server; 0 until first model call. */
  private lastCtxTokens = 0;
  /** True after the first call to push() — used to skip re-init on subsequent tasks. */
  private _initialized = false;
  /** Counts render() calls, to drive turn-based rule re-injection. */
  private renderCount = 0;

  constructor(opts: ContextManagerOptions = {}) {
    this.budget = { ...BUDGET_DEFAULTS, ...opts.budget };
    this.rules = opts.rules;
  }

  /** Append a message to the live conversation. */
  push(message: ChatMessage): void {
    this.messages.push(message);
    this._initialized = true;
  }

  /**
   * Update the token count from the server's usage report.
   * Called after each model response so pressure stays accurate.
   */
  updateUsage(totalTokens: number): void {
    this.lastCtxTokens = totalTokens;
  }

  /**
   * Returns the messages to send to the model this step,
   * after applying the active pressure stage.
   */
  render(): ChatMessage[] {
    this.renderCount++;
    const used = this.lastCtxTokens || estimateTokens(this.messages);
    const stage = pressureStage(used, this.budget);

    // Stage 1+: mask old observations (free + deterministic). Stage 2/3 (C1/C2)
    // not yet implemented — fall through to masked even under high pressure.
    const base = stage === 0 ? [...this.messages] : maskObservations(this.messages, this.budget.maskWindow);

    return this.rules ? this.withRules(base) : base;
  }

  /**
   * Inject the project rules: full text right after the system prompt (start
   * anchor), and a condensed reminder at the end when the conversation has grown
   * (end anchor). Injected at render time — never stored, so never masked/evicted.
   */
  private withRules(base: ChatMessage[]): ChatMessage[] {
    const rules = this.rules!;
    const anchor: ChatMessage = { role: "system", content: rules.full };
    const out =
      base[0]?.role === "system" ? [base[0], anchor, ...base.slice(1)] : [anchor, ...base];

    if (rules.reinject && this.shouldReinject(rules.reinjectEvery)) {
      out.push({ role: "system", content: `Reminder of the project rules:\n${rules.condensed}` });
    }
    return out;
  }

  /** End-anchor cadence: every N renders, or whenever the window is half full. */
  private shouldReinject(every: number): boolean {
    return this.pressure() >= 0.5 || (every > 0 && this.renderCount % every === 0);
  }

  /** Fraction of the usable window occupied (0..1+). */
  pressure(): number {
    const used = this.lastCtxTokens || estimateTokens(this.messages);
    return used / usableBudget(this.budget);
  }

  /** True once the first message has been pushed (system prompt already present). */
  isInitialized(): boolean {
    return this._initialized;
  }
}
