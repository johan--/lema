import type { LemaConfig } from "./config.js";
import { Provider, type ChatMessage } from "./provider.js";
import { ALL_TOOLS, toolMap, type Tool } from "./tools.js";
import { SkillStore } from "./skills.js";
import * as ui from "./ui.js";

const SYSTEM = `You are lema, a focused local coding agent running on a small local model.
You operate inside the user's working directory through tools.

Rules, tuned for small models — follow them strictly:
- Work in small, concrete steps. Take ONE action at a time, then look at the result.
- Prefer reading files and running commands over guessing.
- After writing code, ALWAYS verify it: run it or run the tests with the bash tool.
- If verification fails, read the error, fix, and try again. Do not claim success unverified.
- Keep responses short. When the task is done and verified, reply with a final summary and no tool call.`;

export interface AgentEvent {
  type: "step" | "tool" | "assistant" | "done";
  text?: string;
  tool?: string;
  detail?: string;
}

export interface AgentResult {
  answer: string;
  steps: number;
  transcript: ChatMessage[];
}

export interface RunOptions {
  cfg: LemaConfig;
  provider: Provider;
  cwd: string;
  tools?: Tool[];
  skills?: SkillStore;
  onEvent?: (e: AgentEvent) => void;
}

/** Run the agent loop on a single task until it stops calling tools or hits maxSteps. */
export async function runAgent(task: string, opts: RunOptions): Promise<AgentResult> {
  const { cfg, provider, cwd } = opts;
  const tools = opts.tools ?? ALL_TOOLS;
  const tmap = toolMap(tools);
  const emit = opts.onEvent ?? (() => {});

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

  while (steps < cfg.maxSteps) {
    steps++;
    const reply = await provider.chat(messages, { tools: schemas });
    messages.push(reply);

    if (!reply.tool_calls?.length) {
      const answer = reply.content ?? "";
      emit({ type: "done", text: answer });
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

  emit({ type: "done", text: "(stopped: hit maxSteps)" });
  return { answer: "Stopped after reaching the step limit.", steps, transcript: messages };
}

function summarizeArgs(args: Record<string, any>): string {
  if (args.command) return String(args.command).slice(0, 80);
  if (args.path) return String(args.path);
  return Object.keys(args).join(", ");
}

/** Wire the default console renderer for agent events. */
export function consoleRenderer(e: AgentEvent): void {
  if (e.type === "step") ui.step("skills", e.text ?? "");
  else if (e.type === "tool") ui.tool(e.tool ?? "?", e.detail ?? "");
  else if (e.type === "assistant" && e.text) ui.log(ui.dim(e.text));
  else if (e.type === "done") {
    ui.log();
    ui.ok(e.text ?? "done");
  }
}
