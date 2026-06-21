import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatStats, runAgent, type AgentEvent } from "../src/agent/index.js";
import type { ModelProvider, ChatResult, ChatOptions } from "../src/provider.js";

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

  // --- verification loop (V1) ---
  const writeTool = {
    schema: { type: "function" as const, function: { name: "write_file", description: "", parameters: {} } },
    run: async () => "OK: wrote",
  };
  const writeCall = { content: null, toolCalls: [{ id: "1", type: "function" as const, function: { name: "write_file", arguments: "{}" } }] };

  test("runs the check after edits and accepts on green", async () => {
    let runs = 0;
    const verifier = { command: "npm test", run: async () => { runs++; return { ok: true, output: "pass" }; } };
    const provider = makeProvider([writeCall, { content: "done" }]);
    const result = await runAgent("change a file", { maxSteps: 5, provider, cwd: "/tmp", tools: [writeTool], effort: "high", verifier, verify: "auto" });
    assert.equal(runs, 1);
    assert.equal(result.answer, "done");
  });

  test("red→green: failed check feeds back, fix re-verifies, lesson recorded", async () => {
    let runs = 0;
    const verifier = { command: "npm test", run: async () => { runs++; return runs === 1 ? { ok: false, output: "1 failing" } : { ok: true, output: "pass" }; } };
    let saved = 0;
    const skills = { search: async () => [], save: async () => { saved++; return {} as never; }, all: () => [], record: () => {} } as never;
    const provider = makeProvider([writeCall, { content: "first" }, writeCall, { content: "fixed" }]);
    const result = await runAgent("fix it", { maxSteps: 8, provider, cwd: "/tmp", tools: [writeTool], effort: "high", verifier, verify: "auto", skills });
    assert.equal(runs, 2);          // failed, then passed
    assert.equal(result.answer, "fixed");
    assert.equal(saved, 1);          // red→green captured as a lesson
  });

  test("no verifier ⇒ accepts the first finish even on high", async () => {
    let runs = 0;
    const provider = makeProvider([writeCall, { content: "done" }]);
    await runAgent("change a file", { maxSteps: 5, provider, cwd: "/tmp", tools: [writeTool], effort: "high" });
    assert.equal(runs, 0); // nothing ran; no verifier present
  });

  test("no edits ⇒ no verification (read-only task)", async () => {
    let runs = 0;
    const verifier = { command: "npm test", run: async () => { runs++; return { ok: true, output: "" }; } };
    const provider = makeProvider([{ content: "just an answer" }]);
    await runAgent("what is this?", { maxSteps: 5, provider, cwd: "/tmp", tools: [], effort: "high", verifier, verify: "auto" });
    assert.equal(runs, 0); // dirty was never set
  });

  test("verify:off disables the loop even with a verifier", async () => {
    let runs = 0;
    const verifier = { command: "npm test", run: async () => { runs++; return { ok: true, output: "" }; } };
    const provider = makeProvider([writeCall, { content: "done" }]);
    await runAgent("change a file", { maxSteps: 5, provider, cwd: "/tmp", tools: [writeTool], effort: "high", verifier, verify: "off" });
    assert.equal(runs, 0);
  });

  test("auto effort resolves per task and high passes reasoning_effort", async () => {
    // A heavy task should resolve to high under auto, which sets reasoning_effort.
    let captured: ChatOptions | undefined;
    const provider: ModelProvider = {
      listModels: async () => ["m"],
      resolveModel: async () => "m",
      embed: async (t) => t.map(() => []),
      chat: async (_msgs, opts) => { captured = opts; return { message: { role: "assistant", content: "ok" }, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }; },
    };
    await runAgent("implement a /health route and a test", { maxSteps: 5, provider, cwd: "/tmp", tools: [], effort: "auto" });
    assert.equal(captured?.reasoningEffort, "high");
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
