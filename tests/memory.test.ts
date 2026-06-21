import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory.js";
import type { ModelProvider } from "../src/provider.js";
import { DEFAULTS } from "../src/config.js";

const DIM = 8;

function mockProvider(): ModelProvider {
  return {
    listModels: async () => [],
    resolveModel: async () => "test",
    chat: async () => ({ message: { role: "assistant", content: "ok" } }),
    // Simple deterministic embedding: hash each char to a float in a DIM-length vector.
    embed: async (texts) =>
      texts.map((t) => {
        const v = Array(DIM).fill(0);
        for (let i = 0; i < t.length; i++) v[i % DIM] += t.charCodeAt(i) / 1000;
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
      }),
  };
}

let dir: string;
let store: MemoryStore;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "lema-skills-"));
  store = new MemoryStore({ ...DEFAULTS, stateDir: ".lema" }, mockProvider(), dir);
});
after(() => { rmSync(dir, { recursive: true, force: true }); });

describe("MemoryStore", () => {
  test("all() returns empty initially", () => {
    assert.deepEqual(store.all(), []);
  });

  test("save() persists a skill", async () => {
    await store.save({ name: "test skill", description: "a test skill", kind: "knowledge", body: "body text" });
    assert.equal(store.all().length, 1);
  });

  test("saved skill has correct fields", async () => {
    const skill = store.all()[0];
    assert.equal(skill.name, "test skill");
    assert.equal(skill.kind, "knowledge");
    assert.equal(skill.uses, 0);
    assert.equal(skill.wins, 0);
    assert.ok(skill.id);
    assert.ok(skill.createdAt);
  });

  test("search() returns relevant skills", async () => {
    await store.save({ name: "bash loops", description: "how to write bash for loops", kind: "procedure", body: "for i in *; do echo $i; done" });
    const results = await store.search("bash for loop", 1);
    assert.ok(results.length >= 1);
  });

  test("record() increments uses and wins", () => {
    const skill = store.all()[0];
    store.record(skill.id, true);
    store.record(skill.id, false);
    const updated = store.all().find((s) => s.id === skill.id)!;
    assert.equal(updated.uses, 2);
    assert.equal(updated.wins, 1);
  });

  test("record() with unknown id is a no-op", () => {
    assert.doesNotThrow(() => store.record("nonexistent-id", true));
  });

  test("search() with empty store returns []", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "lema-empty-"));
    try {
      const empty = new MemoryStore({ ...DEFAULTS, stateDir: ".lema" }, mockProvider(), emptyDir);
      const results = await empty.search("anything", 3);
      assert.deepEqual(results, []);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
