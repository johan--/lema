import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRules, condenseRules, loadRulesPreamble } from "../src/rules/index.js";

let cwd: string;
before(() => { cwd = mkdtempSync(join(tmpdir(), "lema-rules-")); });
after(() => { rmSync(cwd, { recursive: true, force: true }); });

describe("loadRules", () => {
  test("returns null when no rules file exists", () => {
    assert.equal(loadRules(cwd), null);
  });

  test("loads CLAUDE.md when present", () => {
    writeFileSync(join(cwd, "CLAUDE.md"), "# Rules\nDo the thing.");
    const r = loadRules(cwd);
    assert.equal(r?.path, "CLAUDE.md");
    assert.match(r!.text, /Do the thing/);
  });

  test("AGENTS.md wins over CLAUDE.md", () => {
    writeFileSync(join(cwd, "AGENTS.md"), "# Agents\nPrefer this.");
    const r = loadRules(cwd);
    assert.equal(r?.path, "AGENTS.md");
  });

  test(".lema/rules.md is the last fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "lema-rules-only-"));
    mkdirSync(join(dir, ".lema"), { recursive: true });
    writeFileSync(join(dir, ".lema", "rules.md"), "local rules");
    assert.equal(loadRules(dir)?.path, ".lema/rules.md");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("condenseRules", () => {
  test("condenses to headings when there are several", () => {
    const text = "# Commits\nstuff\n## Code\nmore\n### Tests\neven more";
    const c = condenseRules(text);
    assert.match(c, /• Commits/);
    assert.match(c, /• Code/);
    assert.doesNotMatch(c, /even more/); // body dropped
  });

  test("falls back to first lines when few headings", () => {
    const c = condenseRules("just a line\nanother line");
    assert.match(c, /just a line/);
  });
});

describe("loadRulesPreamble", () => {
  const cfg = { enabled: true, reinject: true, reinjectEvery: 6 };

  test("returns null when disabled", () => {
    writeFileSync(join(cwd, "AGENTS.md"), "# X\nbody");
    assert.equal(loadRulesPreamble(cwd, { ...cfg, enabled: false }), null);
  });

  test("builds a preamble with full + condensed", () => {
    writeFileSync(join(cwd, "AGENTS.md"), "# Title\nrule body\n## Commits\nuse conventional");
    const loaded = loadRulesPreamble(cwd, cfg);
    assert.equal(loaded?.path, "AGENTS.md");
    assert.match(loaded!.preamble.full, /rule body/);
    assert.match(loaded!.preamble.condensed, /• Title/);
    assert.match(loaded!.preamble.condensed, /• Commits/);
    assert.equal(loaded!.preamble.reinjectEvery, 6);
  });
});
