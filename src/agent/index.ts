import type { ModelProvider, ChatMessage } from "../provider.js";
import { ALL_TOOLS, toolMap, type Tool } from "../tools/index.js";
import { SkillStore } from "../skills/index.js";
import { ContextManager } from "../context/index.js";
const SYSTEM = `You are lema, a focused local coding agent running on a small local model.
You operate inside the user's working directory through tools.

Rules, tuned for small models — follow them strictly:
- Work in small, concrete steps. Take ONE action at a time, then look at the result.
- Prefer reading files and running commands over guessing.
- After writing code, ALWAYS verify it: run it or run the tests with the bash tool.
- If verification fails, read the error, fix, and try again. Do not claim success unverified.
- Keep responses short. When the task is done and verified, reply with a final summary and no tool call.`;

export interface AgentStats {
  /** Total prompt (input) tokens across all model calls. */
  prompt: number;
  /** Total completion (output) tokens. */
  completion: number;
  /** Generation throughput, completion tokens per second. */
  tokps: number;
  /** Wall-clock seconds spent in model calls. */
  seconds: number;
  /** Context occupied by the last call (a proxy for "how full" the window is). */
  ctx: number;
}

export interface AgentEvent {
  type: "step" | "tool" | "assistant" | "thinking" | "thinking-stop" | "done";
  text?: string;
  tool?: string;
  detail?: string;
  stats?: AgentStats;
}

export interface AgentResult {
  answer: string;
  steps: number;
  transcript: ChatMessage[];
}

export interface RunOptions {
  maxSteps: number;
  provider: ModelProvider;
  cwd: string;
  tools?: Tool[];
  skills?: SkillStore;
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
  /** Persistent context for cross-turn memory. Created once per session in repl. */
  context?: ContextManager;
}

/** Tools with no side effects — repeating one with identical args is wasted work. */
const READ_ONLY = new Set(["read_file", "list_dir", "grep", "glob", "web_search", "web_fetch"]);
/** After this many repeated identical calls, the model is spinning — wrap up. */
const REPEAT_BUDGET = 3;

/** A stable signature for a tool call, used to detect exact repeats. */
function callSig(name: string, args: Record<string, any>): string {
  return `${name}:${JSON.stringify(args)}`;
}

/**
 * Ask the model for a final answer with NO tools available, so it must respond
 * from what it has already gathered instead of looping. Salvages a run that hit
 * the step budget or started spinning, rather than discarding all the work.
 */
async function forceFinish(
  provider: ModelProvider,
  ctx: ContextManager,
  model: string,
  note: string,
  signal?: AbortSignal,
): Promise<string> {
  ctx.push({
    role: "system",
    content: `${note} Give your best final answer now using what you've already gathered. Do not call any tools.`,
  });
  try {
    const { message } = await provider.chat(ctx.render(), { model, signal });
    ctx.push(message);
    return message.content ?? "";
  } catch {
    return "Stopped before reaching a conclusion.";
  }
}

/** Run the agent loop on a single task until it stops calling tools or hits maxSteps. */
export async function runAgent(task: string, opts: RunOptions): Promise<AgentResult> {
  const { maxSteps, provider, cwd } = opts;
  const tools = opts.tools ?? ALL_TOOLS;
  const tmap = toolMap(tools);
  const emit = opts.onEvent ?? (() => {});
  const ctx = opts.context ?? new ContextManager();

  const model = await provider.resolveModel();

  // The system prompt is pushed once per session; subsequent tasks reuse the
  // existing conversation so it persists across turns (cross-turn memory).
  if (!ctx.isInitialized()) {
    ctx.push({ role: "system", content: SYSTEM });
  }

  // Skill recall depends on the current task, so it runs on every turn.
  if (opts.skills) {
    const relevant = await opts.skills.search(task, 3).catch(() => []);
    if (relevant.length) {
      const block = relevant
        .map((s) => `### ${s.name} (${s.kind})\n${s.description}\n${s.body}`)
        .join("\n\n");
      ctx.push({
        role: "system",
        content: `You have these previously-verified skills. Reuse them when relevant:\n\n${block}`,
      });
      emit({ type: "step", text: `recalled ${relevant.length} skill(s)` });
    }
  }

  ctx.push({ role: "user", content: task });

  const schemas = tools.map((t) => t.schema);
  const seen = new Map<string, string>(); // call signature -> result (dedupe cache)
  let repeats = 0;
  let steps = 0;
  let promptTok = 0;
  let completionTok = 0;
  let ctxTok = 0;
  const t0 = Date.now();

  const stats = (): AgentStats => {
    const seconds = (Date.now() - t0) / 1000;
    return {
      prompt: promptTok,
      completion: completionTok,
      tokps: seconds > 0 ? completionTok / seconds : 0,
      seconds,
      ctx: ctxTok,
    };
  };

  while (steps < maxSteps) {
    if (opts.signal?.aborted) break;
    steps++;
    emit({ type: "thinking" });
    const { message: reply, usage } = await provider.chat(ctx.render(), { model, tools: schemas, signal: opts.signal });
    emit({ type: "thinking-stop" });
    if (usage) {
      promptTok += usage.prompt_tokens ?? 0;
      completionTok += usage.completion_tokens ?? 0;
      ctxTok = usage.total_tokens ?? ctxTok;
      ctx.updateUsage(ctxTok);
    }
    ctx.push(reply);

    if (!reply.tool_calls?.length) {
      const answer = reply.content ?? "";
      emit({ type: "done", text: answer, stats: stats() });
      return { answer, steps, transcript: ctx.render() };
    }

    if (reply.content) emit({ type: "assistant", text: reply.content });

    for (const call of reply.tool_calls) {
      const tool = tmap.get(call.function.name);
      let result: string;
      let args: Record<string, any> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        result = `ERROR: arguments were not valid JSON: ${call.function.arguments}`;
        ctx.push({ role: "tool", tool_call_id: call.id, content: result });
        continue;
      }
      const sig = callSig(call.function.name, args);
      // Exact repeat of a read-only call: don't re-run it. Return the prior
      // result with a nudge so the model uses what it has instead of spinning.
      if (READ_ONLY.has(call.function.name) && seen.has(sig)) {
        repeats++;
        emit({ type: "tool", tool: call.function.name, detail: "(repeat — cached)" });
        ctx.push({
          role: "tool",
          tool_call_id: call.id,
          content: `${seen.get(sig)}\n\n(You already ran this exact call — result repeated above. Stop repeating; use it or give your final answer.)`,
        });
        continue;
      }
      emit({ type: "tool", tool: call.function.name, detail: summarizeArgs(args) });
      if (!tool) {
        result = `ERROR: unknown tool ${call.function.name}`;
      } else {
        try {
          result = await tool.run(args, { cwd });
        } catch (e) {
          result = `ERROR: ${(e as Error).message}`;
        }
      }
      if (READ_ONLY.has(call.function.name)) seen.set(sig, result);
      ctx.push({ role: "tool", tool_call_id: call.id, content: result });
    }

    // Too many repeated calls means the model is stuck — finish gracefully.
    if (repeats >= REPEAT_BUDGET) {
      const answer = await forceFinish(provider, ctx, model, "You are repeating tool calls.", opts.signal);
      emit({ type: "done", text: answer, stats: stats() });
      return { answer, steps, transcript: ctx.render() };
    }
  }

  // Hit the step budget: don't throw the work away — force a final answer with
  // no tools so the model concludes from everything it has gathered.
  const answer = await forceFinish(provider, ctx, model, "You have reached the step limit.", opts.signal);
  emit({ type: "done", text: answer, stats: stats() });
  return { answer, steps, transcript: ctx.render() };
}

function summarizeArgs(args: Record<string, any>): string {
  if (args.command) return String(args.command).slice(0, 80);
  if (args.path) return String(args.path);
  return Object.keys(args).join(", ");
}

/** Compact one-line stats for the pinned footer. Plain text; the caller styles it. */
export function formatStats(s: AgentStats): string {
  const parts = [`↑ ${s.prompt}`, `↓ ${s.completion}`, `${s.tokps.toFixed(1)} tok/s`];
  if (s.ctx) parts.push(`ctx ${s.ctx}`);
  return parts.join("  ·  ");
}
