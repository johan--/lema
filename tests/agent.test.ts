import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatStats, runAgent, type AgentEvent } from "../src/agent/index.js";
import type { ModelProvider, ChatResult } from "../src/provider.js";

describe("formatStats", () => {
  test("formats all fields", () => {
    const s = { prompt: 100, completion: 50, tokps: 12.5, seconds: 4, ctx: 150 };
    const out = formatStats(s);
    assert.match(out, /↑ 100/);
    assert.match(out, /↓ 50/);
    assert.match(out, /12\.5 tok\/s/);
    assert.match(out, /ctx 150/);
  });

  test("omits ctx when zero", () => {
    const out = formatStats({ prompt: 10, completion: 5, tokps: 1, seconds: 1, ctx: 0 });
    assert.doesNotMatch(out, /ctx/);
  });
});

import type { ToolCall } from "../src/provider.js";

function makeProvider(replies: Array<{ content: string | null; toolCalls?: ToolCall[] }>): ModelProvider {
  let call = 0;
  return {
    listModels: async () => ["test-model"],
    resolveModel: async () => "test-model",
    embed: async (texts) => texts.map(() => []),
    chat: async (): Promise<ChatResult> => {
      const r = replies[Math.min(call++, replies.length - 1)];
      return {
        message: { role: "assistant", content: r.content, tool_calls: r.toolCalls },
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    },
  };
}

describe("runAgent", () => {
  test("returns answer when model replies without tools", async () => {
    const provider = makeProvider([{ content: "Done!" }]);
    const result = await runAgent("say done", { maxSteps: 5, provider, cwd: "/tmp", tools: [] });
    assert.equal(result.answer, "Done!");
    assert.equal(result.steps, 1);
  });

  test("emits thinking and done events", async () => {
    const provider = makeProvider([{ content: "ok" }]);
    const events: string[] = [];
    await runAgent("task", {
      maxSteps: 5, provider, cwd: "/tmp", tools: [],
      onEvent: (e: AgentEvent) => events.push(e.type),
    });
    assert.ok(events.includes("thinking"));
    assert.ok(events.includes("thinking-stop"));
    assert.ok(events.includes("done"));
  });

  test("done event carries stats", async () => {
    const provider = makeProvider([{ content: "ok" }]);
    let stats: AgentEvent["stats"];
    await runAgent("task", {
      maxSteps: 5, provider, cwd: "/tmp", tools: [],
      onEvent: (e: AgentEvent) => { if (e.type === "done") stats = e.stats; },
    });
    assert.ok(stats);
    assert.equal(typeof stats!.prompt, "number");
    assert.equal(typeof stats!.tokps, "number");
  });

  test("stops after maxSteps and forces a final answer", async () => {
    // First two calls keep requesting a tool; once the budget is hit the agent
    // makes one tool-less call (forceFinish), which returns this final answer.
    const toolCall = {
      content: null,
      toolCalls: [{ id: "1", type: "function" as const, function: { name: "unknown_tool", arguments: "{}" } }],
    };
    const provider = makeProvider([toolCall, toolCall, { content: "Best effort summary." }]);
    const result = await runAgent("loop", { maxSteps: 2, provider, cwd: "/tmp", tools: [] });
    assert.equal(result.steps, 2);
    assert.equal(result.answer, "Best effort summary."); // work salvaged, not discarded
  });

  test("dedupes repeated read-only calls and finishes", async () => {
    let runs = 0;
    const readTool = {
      schema: { type: "function" as const, function: { name: "read_file", description: "", parameters: {} } },
      run: async () => { runs++; return "file contents"; },
    };
    const tc = {
      content: null,
      toolCalls: [{ id: "1", type: "function" as const, function: { name: "read_file", arguments: "{}" } }],
    };
    const provider = makeProvider([tc, tc, tc, tc, { content: "answer from cache" }]);
    const result = await runAgent("loop", { maxSteps: 10, provider, cwd: "/tmp", tools: [readTool] });
    assert.equal(runs, 1); // executed once; repeats were short-circuited
    assert.equal(result.answer, "answer from cache");
  });

  test("recovers a tool call emitted as plain text", async () => {
    let runs = 0;
    const readTool = {
      schema: { type: "function" as const, function: { name: "read_file", description: "", parameters: {} } },
      run: async () => { runs++; return "contents"; },
    };
    // First reply has no structured tool_calls — the call is buried in content.
    const textCall = { content: "<tool_call><function=read_file><parameter=path>x.ts</parameter></function></tool_call>" };
    const provider = makeProvider([textCall, { content: "done" }]);
    const result = await runAgent("read x", { maxSteps: 5, provider, cwd: "/tmp", tools: [readTool] });
    assert.equal(runs, 1); // the text tool call was parsed and executed
    assert.equal(result.answer, "done");
  });

  test("ultra gates the first finish behind a verify pass", async () => {
    // The model would finish immediately, but ultra forces one more turn first.
    let calls = 0;
    const provider: ModelProvider = {
      listModels: async () => ["test-model"],
      resolveModel: async () => "test-model",
      embed: async (t) => t.map(() => []),
      chat: async () => {
        calls++;
        return {
          message: { role: "assistant", content: `answer ${calls}`, tool_calls: undefined },
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      },
    };
    const result = await runAgent("do it", { maxSteps: 5, provider, cwd: "/tmp", tools: [], effort: "ultra" });
    assert.equal(calls, 2); // first finish was gated, model asked to verify, then accepted
    assert.equal(result.answer, "answer 2");
  });

  test("medium accepts the first finish (no verify gate)", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      listModels: async () => ["test-model"],
      resolveModel: async () => "test-model",
      embed: async (t) => t.map(() => []),
      chat: async () => { calls++; return { message: { role: "assistant", content: "done" }, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }; },
    };
    await runAgent("do it", { maxSteps: 5, provider, cwd: "/tmp", tools: [], effort: "medium" });
    assert.equal(calls, 1);
  });

  test("transcript includes system + user messages", async () => {
    const provider = makeProvider([{ content: "hi" }]);
    const result = await runAgent("hello", { maxSteps: 5, provider, cwd: "/tmp", tools: [] });
    const roles = result.transcript.map((m) => m.role);
    assert.ok(roles.includes("system"));
    assert.ok(roles.includes("user"));
    assert.ok(roles.includes("assistant"));
  });
});
