import type { ModelProvider, ChatMessage } from "./provider.js";
import { ALL_TOOLS, toolMap, type Tool } from "./tools.js";
import { SkillStore } from "./skills.js";
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
}

/** Run the agent loop on a single task until it stops calling tools or hits maxSteps. */
export async function runAgent(task: string, opts: RunOptions): Promise<AgentResult> {
  const { maxSteps, provider, cwd } = opts;
  const tools = opts.tools ?? ALL_TOOLS;
  const tmap = toolMap(tools);
  const emit = opts.onEvent ?? (() => {});

  const model = await provider.resolveModel();
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM }];

  // Retrieve relevant skills and inject them as a hint block (the self-improvement payoff).
  if (opts.skills) {
    const relevant = await opts.skills.search(task, 3).catch(() => []);
    if (relevant.length) {
      const block = relevant
        .map((s) => `### ${s.name} (${s.kind})\n${s.description}\n${s.body}`)
        .join("\n\n");
      messages.push({
        role: "system",
        content: `You have these previously-verified skills. Reuse them when relevant:\n\n${block}`,
      });
      emit({ type: "step", text: `recalled ${relevant.length} skill(s)` });
    }
  }

  messages.push({ role: "user", content: task });

  const schemas = tools.map((t) => t.schema);
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
    steps++;
    emit({ type: "thinking" });
    const { message: reply, usage } = await provider.chat(messages, { model, tools: schemas });
    emit({ type: "thinking-stop" });
    if (usage) {
      promptTok += usage.prompt_tokens ?? 0;
      completionTok += usage.completion_tokens ?? 0;
      ctxTok = usage.total_tokens ?? ctxTok;
    }
    messages.push(reply);

    if (!reply.tool_calls?.length) {
      const answer = reply.content ?? "";
      emit({ type: "done", text: answer, stats: stats() });
      return { answer, steps, transcript: messages };
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
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
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
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  emit({ type: "done", text: "(stopped: hit maxSteps)", stats: stats() });
  return { answer: "Stopped after reaching the step limit.", steps, transcript: messages };
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
