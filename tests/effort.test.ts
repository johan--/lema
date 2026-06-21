import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { effortProfile, estimateEffort, EFFORTS } from "../src/effort.js";

const base = { maxSteps: 12, maxTokens: 2048 };

describe("effortProfile", () => {
  test("medium reproduces the base budgets exactly", () => {
    const p = effortProfile("medium", base);
    assert.equal(p.maxSteps, 12);
    assert.equal(p.maxTokens, 2048);
    assert.equal(p.hint, "");
  });

  test("low halves and floors the budgets, adds a concise hint", () => {
    const p = effortProfile("low", base);
    assert.equal(p.maxSteps, 6);
    assert.equal(p.maxTokens, 1024);
    assert.match(p.hint, /concise/i);
  });

  test("high doubles the budgets, adds a careful hint", () => {
    const p = effortProfile("high", base);
    assert.equal(p.maxSteps, 24);
    assert.equal(p.maxTokens, 4096);
    assert.match(p.hint, /verify|careful|double-check/i);
  });

  test("low respects the floors on small base budgets", () => {
    const p = effortProfile("low", { maxSteps: 4, maxTokens: 600 });
    assert.equal(p.maxSteps, 4);   // min 4, not 2
    assert.equal(p.maxTokens, 512); // min 512, not 300
  });

  test("ultra triples steps, doubles tokens, verifies and plans", () => {
    const p = effortProfile("ultra", base);
    assert.equal(p.maxSteps, 36);   // steps scale most (room for verify-fix rounds)
    assert.equal(p.maxTokens, 4096); // tokens only 2x — not a thinking blowout
    assert.equal(p.verify, true);
    assert.equal(p.plan, true);
    assert.match(p.hint, /subgoals/i);
  });

  test("high and ultra verify+plan; low and medium do neither", () => {
    for (const e of ["high", "ultra"] as const) {
      assert.equal(effortProfile(e, base).verify, true);
      assert.equal(effortProfile(e, base).plan, true);
    }
    for (const e of ["low", "medium"] as const) {
      assert.equal(effortProfile(e, base).verify, false);
      assert.equal(effortProfile(e, base).plan, false);
    }
  });

  test("unknown effort falls back to medium", () => {
    const p = effortProfile("turbo" as never, base);
    assert.equal(p.maxSteps, 12);
    assert.equal(p.maxTokens, 2048);
    assert.equal(p.hint, "");
    assert.equal(p.verify, false);
  });

  test("high and ultra carry a native reasoning hint; low/medium do not", () => {
    assert.equal(effortProfile("high", base).reasoning, "high");
    assert.equal(effortProfile("ultra", base).reasoning, "high");
    assert.equal(effortProfile("low", base).reasoning, undefined);
    assert.equal(effortProfile("medium", base).reasoning, undefined);
  });

  test("EFFORTS lists the four levels", () => {
    assert.deepEqual([...EFFORTS], ["low", "medium", "high", "ultra"]);
  });
});

describe("estimateEffort", () => {
  test("heavy build/fix tasks → high", () => {
    assert.equal(estimateEffort("implement a /health route and a test"), "high");
    assert.equal(estimateEffort("fix the failing build"), "high");
    assert.equal(estimateEffort("refactor the provider module"), "high");
  });

  test("short factual questions → low", () => {
    assert.equal(estimateEffort("what is this project?"), "low");
    assert.equal(estimateEffort("list the tools"), "low");
  });

  test("everything else → medium", () => {
    assert.equal(estimateEffort("summarize the readme in two sentences"), "medium");
  });

  test("very long asks → high", () => {
    assert.equal(estimateEffort("please " + "word ".repeat(50)), "high");
  });

  test("never auto-selects ultra", () => {
    const samples = ["implement everything", "what is x", "do the thing", "fix all bugs and rewrite"];
    for (const s of samples) assert.notEqual(estimateEffort(s), "ultra");
  });
});
