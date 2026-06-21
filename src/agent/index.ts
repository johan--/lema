import type { ModelProvider, ChatMessage } from "../provider.js";
import { ALL_TOOLS, toolMap, type Tool } from "../tools/index.js";
import { SkillStore } from "../skills/index.js";
import { ContextManager } from "../context/index.js";
import { parseTextToolCalls } from "./toolparse.js";
import { effortProfile, estimateEffort, type EffortSetting } from "../effort.js";
import type { Verifier, CheckResult } from "../verify/index.js";
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
  /** Base completion-token budget (medium effort). Scaled by effort. */
  maxTokens?: number;
  /** Reasoning dial; scales maxSteps/maxTokens and adds a prompt hint. "auto" picks per task. Default medium. */
  effort?: EffortSetting;
  /** Runs the project's check command. Absent ⇒ verification is a no-op. */
  verifier?: Verifier;
  /** Verification mode: "auto" follows effort, "on"/"off" force it. Default auto. */
  verify?: "auto" | "on" | "off";
}

/** Tools with no side effects — repeating one with identical args is wasted work. */
const READ_ONLY = new Set(["read_file", "list_dir", "grep", "glob", "web_search", "web_fetch"]);
/** Tools that change files — a successful one means there's something to verify. */
const WRITE_TOOLS = new Set(["write_file", "edit_file"]);
/** After this many repeated identical calls, the model is spinning — wrap up. */
const REPEAT_BUDGET = 3;
/** Cap on verify→fix rounds so a stubborn failure ends honestly, not in a loop. */
const MAX_VERIFY_ROUNDS = 3;
/** Char cap on a check's output fed back to the model, and on a recalled skill body. */
const OUTPUT_CAP = 2000;
const SKILL_BODY_CAP = 400;

/** Resolve the verification mode against the effort profile's default. */
function verifyEnabled(mode: "auto" | "on" | "off" | undefined, profileVerify: boolean): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return profileVerify; // "auto" / undefined follow effort
}

/** Record a red→green outcome as a lesson skill (V3). Best-effort; never throws. */
async function recordLesson(skills: SkillStore, task: string, command: string, failure: string): Promise<void> {
  try {
    await skills.save({
      name: `lesson: ${task.slice(0, 48)}`,
      description: `Working on "${task.slice(0, 80)}", \`${command}\` failed first; verify and fix before finishing.`,
      kind: "lesson",
      body: `Always run \`${command}\` to verify this kind of task. A prior run failed with:\n${failure.slice(0, 300)}`,
    });
  } catch {
    /* lesson capture is a bonus, never block the run */
  }
}

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
  maxTokens: number,
  reasoning: "low" | "medium" | "high" | undefined,
  lastCheck: CheckResult | null,
  signal?: AbortSignal,
): Promise<string> {
  const status = lastCheck && !lastCheck.ok ? " The verification command is still FAILING — say so honestly." : "";
  ctx.push({
    role: "system",
    content: `${note}${status} Give your best final answer now using what you've already gathered. Do not call any tools.`,
  });
  try {
    const { message } = await provider.chat(ctx.render(), { model, maxTokens, reasoningEffort: reasoning, signal });
    ctx.push(message);
    const answer = message.content ?? "";
    return lastCheck && !lastCheck.ok ? `${answer}\n\n⚠️ Verification still failing.` : answer;
  } catch {
    return "Stopped before reaching a conclusion.";
  }
}

/** Run the agent loop on a single task until it stops calling tools or hits maxSteps. */
export async function runAgent(task: string, opts: RunOptions): Promise<AgentResult> {
  const { provider, cwd } = opts;
  const tools = opts.tools ?? ALL_TOOLS;
  const tmap = toolMap(tools);
  const emit = opts.onEvent ?? (() => {});
  const ctx = opts.context ?? new ContextManager();

  // Resolve the effort dial. "auto" picks a level from the task (E2); a concrete
  // setting is used as-is. Then map to budgets + behavioural hint.
  const setting = opts.effort ?? "medium";
  const effort = setting === "auto" ? estimateEffort(task) : setting;
  if (setting === "auto") emit({ type: "step", text: `effort: ${effort} (auto)` });
  const profile = effortProfile(effort, {
    maxSteps: opts.maxSteps,
    maxTokens: opts.maxTokens ?? 2048,
  });
  const maxSteps = profile.maxSteps;
  const maxTokens = profile.maxTokens;

  const model = await provider.resolveModel();

  // The system prompt is pushed once per session; subsequent tasks reuse the
  // existing conversation so it persists across turns (cross-turn memory).
  if (!ctx.isInitialized()) {
    const system = profile.hint ? `${SYSTEM}\n\n${profile.hint}` : SYSTEM;
    ctx.push({ role: "system", content: system });
  }

  // Skill recall depends on the current task, so it runs on every turn.
  if (opts.skills) {
    const relevant = await opts.skills.search(task, 3).catch(() => []);
    if (relevant.length) {
      // Cap each body so recalled skills/lessons can't crowd a small window.
      const block = relevant
        .map((s) => `### ${s.name} (${s.kind})\n${s.description}\n${s.body.slice(0, SKILL_BODY_CAP)}`)
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
  const doVerify = verifyEnabled(opts.verify, profile.verify) && !!opts.verifier;
  let repeats = 0;
  let dirty = false; // have file-changing tools run since the last verification?
  let verifyRounds = 0;
  let sawRedCheck = false; // did a check fail this run (for red→green lessons)?
  let lastCheck: CheckResult | null = null;
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
    const { message: reply, usage } = await provider.chat(ctx.render(), { model, tools: schemas, maxTokens, reasoningEffort: profile.reasoning, signal: opts.signal });
    emit({ type: "thinking-stop" });
    if (usage) {
      promptTok += usage.prompt_tokens ?? 0;
      completionTok += usage.completion_tokens ?? 0;
      ctxTok = usage.total_tokens ?? ctxTok;
      ctx.updateUsage(ctxTok);
    }
    // Recover tool calls the model emitted as plain text (small models on
    // LM Studio often do this when the server fails to parse their tool syntax).
    if (!reply.tool_calls?.length && reply.content) {
      const recovered = parseTextToolCalls(reply.content);
      if (recovered.length) {
        reply.tool_calls = recovered;
        reply.content = null; // the text was a tool call, not a final answer
      }
    }

    ctx.push(reply);

    if (!reply.tool_calls?.length) {
      // Verification gate: before accepting a finish that changed files, lema runs
      // the project's check itself (small models verify poorly in-head, well with
      // tools). On failure, feed the output back and let the model fix — one
      // sequential refine round at a time, bounded.
      if (doVerify && dirty && verifyRounds < MAX_VERIFY_ROUNDS) {
        verifyRounds++;
        emit({ type: "tool", tool: "verify", detail: opts.verifier!.command });
        lastCheck = await opts.verifier!.run(cwd);
        dirty = false; // require a new edit before re-running the check
        if (lastCheck.ok) {
          emit({ type: "step", text: "verified ✓" });
          if (sawRedCheck && opts.skills) {
            await recordLesson(opts.skills, task, opts.verifier!.command, lastCheck.output);
          }
          const answer = reply.content ?? "";
          emit({ type: "done", text: answer, stats: stats() });
          return { answer, steps, transcript: ctx.render() };
        }
        sawRedCheck = true;
        emit({ type: "step", text: "check failed — fixing" });
        const out = lastCheck.output.slice(0, OUTPUT_CAP);
        ctx.push({
          role: "system",
          content: `The check \`${opts.verifier!.command}\` failed:\n\n${out}\n\nFix the cause, then it will be re-checked.`,
        });
        continue;
      }
      let answer = reply.content ?? "";
      if (lastCheck && !lastCheck.ok) answer += `\n\n⚠️ Verification still failing (\`${opts.verifier!.command}\`).`;
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
      // A successful file change means there's something to verify later.
      if (WRITE_TOOLS.has(call.function.name) && !result.startsWith("ERROR")) dirty = true;
      ctx.push({ role: "tool", tool_call_id: call.id, content: result });
    }

    // Too many repeated calls means the model is stuck — finish gracefully.
    if (repeats >= REPEAT_BUDGET) {
      const answer = await forceFinish(provider, ctx, model, "You are repeating tool calls.", maxTokens, profile.reasoning, lastCheck, opts.signal);
      emit({ type: "done", text: answer, stats: stats() });
      return { answer, steps, transcript: ctx.render() };
    }
  }

  // Hit the step budget: don't throw the work away — force a final answer with
  // no tools so the model concludes from everything it has gathered.
  const answer = await forceFinish(provider, ctx, model, "You have reached the step limit.", maxTokens, profile.reasoning, lastCheck, opts.signal);
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
