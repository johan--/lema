import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { BaseProvider } from "../../src/models/base.js";
import { applyStrict, isStrictRejection } from "../../src/models/grammar.js";
import type { ToolSchema } from "../../src/models/message.js";

const CFG = { baseUrl: "http://localhost:9999/v1", model: "test-model", embedModel: "embed-model", temperature: 0.2, maxTokens: 512 };

type FetchFn = typeof globalThis.fetch;
let originalFetch: FetchFn;

function mockFetch(response: unknown, ok = true) {
  globalThis.fetch = async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => response,
    text: async () => JSON.stringify(response),
  }) as Response;
}

beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

describe("BaseProvider.listModels", () => {
  test("returns model ids", async () => {
    mockFetch({ data: [{ id: "model-a" }, { id: "model-b" }] });
    const p = new BaseProvider(CFG);
    assert.deepEqual(await p.listModels(), ["model-a", "model-b"]);
  });

  test("returns [] when data is missing", async () => {
    mockFetch({});
    assert.deepEqual(await new BaseProvider(CFG).listModels(), []);
  });

  test("throws on HTTP error", async () => {
    mockFetch({}, false);
    await assert.rejects(() => new BaseProvider(CFG).listModels(), /HTTP 500/);
  });
});

describe("BaseProvider.resolveModel", () => {
  test("returns configured model without hitting /models", async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({ data: [] }), text: async () => "" } as Response; };
    const result = await new BaseProvider(CFG).resolveModel();
    assert.equal(result, "test-model");
    assert.equal(called, false);
  });

  test("fetches first non-embed model when no model configured", async () => {
    mockFetch({ data: [{ id: "embed-model" }, { id: "chat-model" }] });
    const p = new BaseProvider({ ...CFG, model: undefined });
    assert.equal(await p.resolveModel(), "chat-model");
  });

  test("throws when no chat model available", async () => {
    mockFetch({ data: [{ id: "text-embedding-model" }] });
    const p = new BaseProvider({ ...CFG, model: undefined });
    await assert.rejects(() => p.resolveModel(), /No chat model/);
  });
});

describe("BaseProvider.chat", () => {
  test("sends messages and returns assistant message", async () => {
    const reply = { role: "assistant", content: "hello" };
    mockFetch({ choices: [{ message: reply }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    const p = new BaseProvider(CFG);
    const { message, usage } = await p.chat([{ role: "user", content: "hi" }]);
    assert.equal(message.content, "hello");
    assert.equal(usage?.prompt_tokens, 10);
  });

  test("throws on HTTP error", async () => {
    mockFetch({}, false);
    await assert.rejects(() => new BaseProvider(CFG).chat([{ role: "user", content: "hi" }]), /HTTP 500/);
  });
});

describe("BaseProvider.embed", () => {
  test("returns embedding vectors", async () => {
    mockFetch({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] });
    const result = await new BaseProvider(CFG).embed(["a", "b"]);
    assert.deepEqual(result, [[0.1, 0.2], [0.3, 0.4]]);
  });

  test("throws on HTTP error", async () => {
    mockFetch({}, false);
    await assert.rejects(() => new BaseProvider(CFG).embed(["text"]), /HTTP 500/);
  });
});

// ---------------------------------------------------------------------------
// T3: grammar / strict constrained decoding
// ---------------------------------------------------------------------------

const TOOL: ToolSchema = {
  type: "function",
  function: { name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
};

describe("applyStrict", () => {
  test("adds strict:true to each tool's function", () => {
    const enriched = applyStrict([TOOL]);
    assert.equal(enriched[0].function.strict, true);
  });

  test("does not mutate the original schema", () => {
    applyStrict([TOOL]);
    assert.equal(TOOL.function.strict, undefined);
  });

  test("preserves all other function fields", () => {
    const [e] = applyStrict([TOOL]);
    assert.equal(e.function.name, TOOL.function.name);
    assert.equal(e.function.description, TOOL.function.description);
  });
});

describe("isStrictRejection", () => {
  test("true for HTTP 400 error", () => {
    assert.equal(isStrictRejection(new Error("/chat/completions -> HTTP 400: bad request")), true);
  });

  test("true when message contains 'strict'", () => {
    assert.equal(isStrictRejection(new Error("field strict is not supported")), true);
  });

  test("true when message contains 'unsupported'", () => {
    assert.equal(isStrictRejection(new Error("unsupported parameter")), true);
  });

  test("false for HTTP 500 (server error, not a rejection)", () => {
    assert.equal(isStrictRejection(new Error("/chat/completions -> HTTP 500: internal")), false);
  });

  test("false for non-Error values", () => {
    assert.equal(isStrictRejection("some string"), false);
    assert.equal(isStrictRejection(null), false);
  });
});

describe("BaseProvider.chat — strict tool calling (T3)", () => {
  const reply = { role: "assistant", content: null, tool_calls: [] };
  const ok = { choices: [{ message: reply }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } };

  test("sends strict:true on first tool call", async () => {
    let captured: any;
    globalThis.fetch = async (_url: any, init: any) => {
      captured = JSON.parse(init.body);
      return { ok: true, json: async () => ok, text: async () => "" } as Response;
    };
    await new BaseProvider(CFG).chat([{ role: "user", content: "hi" }], { tools: [TOOL] });
    assert.equal(captured.tools[0].function.strict, true);
  });

  test("falls back to plain tool call on HTTP 400, caches result", async () => {
    let calls = 0;
    let lastBody: any;
    globalThis.fetch = async (_url: any, init: any) => {
      calls++;
      lastBody = JSON.parse(init.body);
      const firstCall = calls === 1;
      return {
        ok: !firstCall,
        status: firstCall ? 400 : 200,
        json: async () => ok,
        text: async () => "strict not supported",
      } as Response;
    };
    const p = new BaseProvider(CFG);
    await p.chat([{ role: "user", content: "hi" }], { tools: [TOOL] });
    assert.equal(calls, 2); // tried strict, retried without
    assert.equal(lastBody.tools[0].function.strict, undefined);

    // second call on same provider instance: no retry, goes straight to plain
    calls = 0;
    globalThis.fetch = async (_url: any, init: any) => {
      calls++;
      lastBody = JSON.parse(init.body);
      return { ok: true, json: async () => ok, text: async () => "" } as Response;
    };
    await p.chat([{ role: "user", content: "hi" }], { tools: [TOOL] });
    assert.equal(calls, 1);
    assert.equal(lastBody.tools[0].function.strict, undefined);
  });

  test("does not add strict when no tools provided", async () => {
    let captured: any;
    globalThis.fetch = async (_url: any, init: any) => {
      captured = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { role: "assistant", content: "hi" } }] }), text: async () => "" } as Response;
    };
    await new BaseProvider(CFG).chat([{ role: "user", content: "hi" }]);
    assert.equal(captured.tools, undefined);
  });
});
