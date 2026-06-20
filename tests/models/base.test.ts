import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { BaseProvider } from "../../src/models/base.js";

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
