import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkill, renderSkill, slugify, SkillLibrary, authorSkill } from "../src/skills/index.js";
import type { ModelProvider } from "../src/provider.js";

// ---------------------------------------------------------------------------
// parseSkill / renderSkill / slugify
// ---------------------------------------------------------------------------

describe("parseSkill", () => {
  test("parses frontmatter + body", () => {
    const p = parseSkill("---\nname: pr-review\ndescription: Review a diff.\n---\n\n1. do it");
    assert.equal(p?.name, "pr-review");
    assert.equal(p?.description, "Review a diff.");
    assert.match(p!.body, /do it/);
  });

  test("strips surrounding quotes on values", () => {
    const p = parseSkill('---\nname: "x"\ndescription: \'y\'\n---\nbody');
    assert.equal(p?.name, "x");
    assert.equal(p?.description, "y");
  });

  test("returns null without frontmatter", () => {
    assert.equal(parseSkill("just text"), null);
  });

  test("returns null when name or description missing", () => {
    assert.equal(parseSkill("---\nname: x\n---\nbody"), null);
  });
});

describe("slugify", () => {
  test("kebab-cases free text", () => {
    assert.equal(slugify("Review a PR Diff!"), "review-a-pr-diff");
  });
  test("never empty", () => {
    assert.equal(slugify("!!!"), "skill");
  });
});

describe("renderSkill round-trips", () => {
  test("render then parse yields the same fields", () => {
    const out = renderSkill({ name: "n", description: "d", body: "b" });
    const p = parseSkill(out);
    assert.equal(p?.name, "n");
    assert.equal(p?.description, "d");
    assert.equal(p?.body, "b");
  });
});

// ---------------------------------------------------------------------------
// SkillLibrary — discovery, precedence, lazy load
// ---------------------------------------------------------------------------

function writeSkill(base: string, name: string, desc: string, body = "steps") {
  const dir = join(base, ".lema", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n${body}`);
}

describe("SkillLibrary", () => {
  let proj: string;
  let home: string;
  before(() => {
    proj = mkdtempSync(join(tmpdir(), "lema-proj-"));
    home = mkdtempSync(join(tmpdir(), "lema-home-"));
  });
  after(() => {
    rmSync(proj, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("lists project + global skills", () => {
    writeSkill(proj, "a", "project a");
    writeSkill(home, "b", "global b");
    const lib = new SkillLibrary(proj, home);
    const names = lib.list().map((s) => s.name);
    assert.deepEqual(names, ["a", "b"]);
    assert.equal(lib.list().find((s) => s.name === "b")?.scope, "global");
  });

  test("project overrides global on a name clash", () => {
    writeSkill(home, "dup", "global version");
    writeSkill(proj, "dup", "project version");
    const lib = new SkillLibrary(proj, home);
    const dup = lib.list().filter((s) => s.name === "dup");
    assert.equal(dup.length, 1);
    assert.equal(dup[0].scope, "project");
    assert.equal(dup[0].description, "project version");
  });

  test("load() reads the body lazily; metadataBlock has no bodies", () => {
    const lib = new SkillLibrary(proj, home);
    assert.match(lib.load("a")!.body, /steps/);
    const block = lib.metadataBlock()!;
    assert.match(block, /\/a — project a/);
    assert.doesNotMatch(block, /steps/); // L1 = metadata only
  });

  test("malformed SKILL.md is skipped, not fatal", () => {
    const dir = join(proj, ".lema", "skills", "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "no frontmatter here");
    const lib = new SkillLibrary(proj, home);
    assert.ok(!lib.list().some((s) => s.name === "broken"));
  });
});

// ---------------------------------------------------------------------------
// authorSkill — the AI skill-creator
// ---------------------------------------------------------------------------

describe("authorSkill", () => {
  test("parses a well-formed model response", async () => {
    const provider = {
      listModels: async () => ["m"],
      resolveModel: async () => "m",
      embed: async (t: string[]) => t.map(() => []),
      chat: async () => ({ message: { role: "assistant" as const, content: "---\nname: pr-review\ndescription: Review a PR.\n---\n1. diff" } }),
    } as ModelProvider;
    const s = await authorSkill(provider, "m", "make a pr review skill");
    assert.equal(s.name, "pr-review");
    assert.match(s.description, /Review a PR/);
  });

  test("falls back to a minimal skill when the model output is unusable", async () => {
    const provider = {
      listModels: async () => ["m"],
      resolveModel: async () => "m",
      embed: async (t: string[]) => t.map(() => []),
      chat: async () => ({ message: { role: "assistant" as const, content: "sorry I cannot" } }),
    } as ModelProvider;
    const s = await authorSkill(provider, "m", "review a pr diff carefully");
    assert.ok(s.name.length > 0);          // still valid
    assert.match(s.description, /review a pr/i);
  });
});
