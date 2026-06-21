import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCheck, makeVerifier } from "../src/verify/index.js";

let cwd: string;
before(() => { cwd = mkdtempSync(join(tmpdir(), "lema-verify-")); });
after(() => { rmSync(cwd, { recursive: true, force: true }); });

describe("discoverCheck", () => {
  test("explicit command wins over discovery", () => {
    assert.equal(discoverCheck(cwd, "make check"), "make check");
  });

  test("prefers package.json test script", () => {
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { build: "tsc", test: "node --test" } }));
    assert.equal(discoverCheck(cwd), "npm run test");
  });

  test("falls back to build when no test", () => {
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { build: "tsc", lint: "eslint" } }));
    assert.equal(discoverCheck(cwd), "npm run build");
  });

  test("returns null when nothing is discoverable", () => {
    const empty = mkdtempSync(join(tmpdir(), "lema-verify-empty-"));
    assert.equal(discoverCheck(empty), null);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("makeVerifier", () => {
  test("ok:true on a passing command", async () => {
    const v = makeVerifier("exit 0");
    const r = await v.run(cwd);
    assert.equal(r.ok, true);
  });

  test("ok:false with output on a failing command", async () => {
    const v = makeVerifier("echo boom && exit 1");
    const r = await v.run(cwd);
    assert.equal(r.ok, false);
    assert.match(r.output, /boom/);
  });

  test("exposes the command", () => {
    assert.equal(makeVerifier("npm test").command, "npm test");
  });
});
