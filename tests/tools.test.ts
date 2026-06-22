import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, editFile, listDir, bash, grep, glob } from "../src/tools/index.js";
import { classifyBlocking } from "../src/tools/shell.js";

let cwd: string;
before(() => { cwd = mkdtempSync(join(tmpdir(), "lema-tools-")); });
after(() => { rmSync(cwd, { recursive: true, force: true }); });

const ctx = () => ({ cwd });

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

describe("readFile", () => {
  test("reads an existing file", async () => {
    writeFileSync(join(cwd, "hello.txt"), "world");
    assert.equal(await readFile.run({ path: "hello.txt" }, ctx()), "world");
  });

  test("returns teaching error for missing file", async () => {
    const r = await readFile.run({ path: "no-such.txt" }, ctx());
    assert.match(r, /ERROR/);
    assert.match(r, /grep|list_dir/); // actionable hint
  });

  test("rejects path escaping cwd", async () => {
    await assert.rejects(() => readFile.run({ path: "../../etc/passwd" }, ctx()));
  });

  test("offset skips lines", async () => {
    writeFileSync(join(cwd, "lines.txt"), "a\nb\nc\nd\ne");
    const r = await readFile.run({ path: "lines.txt", offset: 3 }, ctx());
    assert.match(r, /^c/);
    assert.doesNotMatch(r, /^a/);
  });

  test("limit caps returned lines", async () => {
    writeFileSync(join(cwd, "big.txt"), Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n"));
    const r = await readFile.run({ path: "big.txt", limit: 3 }, ctx());
    assert.match(r, /line1/);
    assert.doesNotMatch(r, /line4/);
    assert.match(r, /more lines/); // pagination hint
  });

  test("returns full file when within default limit", async () => {
    writeFileSync(join(cwd, "short.txt"), "x\ny\nz");
    const r = await readFile.run({ path: "short.txt" }, ctx());
    assert.equal(r, "x\ny\nz");
  });

  test("truncates a single huge line", async () => {
    writeFileSync(join(cwd, "minified.js"), "a".repeat(5000));
    const r = await readFile.run({ path: "minified.js" }, ctx());
    assert.match(r, /line truncated/);
    assert.ok(r.length < 5000);
  });

  test("rejects sibling-directory escape", async () => {
    // cwd is /tmp/lema-tools-xxx; ../lema-tools-yyy would start with the parent
    await assert.rejects(() => readFile.run({ path: "../lema-evil/x" }, ctx()));
  });

  test("pattern returns only matching windows with line numbers", async () => {
    writeFileSync(join(cwd, "pat.ts", ), Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n") + "\nTARGET here\nafter");
    const r = await readFile.run({ path: "pat.ts", pattern: "TARGET", context: 1 }, ctx());
    assert.match(r, /31:TARGET here/); // 1-based line number + content
    assert.match(r, /30:line30/);      // one line of context before
    assert.match(r, /32:after/);       // one line of context after
    assert.doesNotMatch(r, /line1\b/); // unrelated lines excluded
  });

  test("pattern merges adjacent matches into one window", async () => {
    writeFileSync(join(cwd, "merge.ts"), "hit\nhit\nx\ny");
    const r = await readFile.run({ path: "merge.ts", pattern: "hit", context: 0 }, ctx());
    assert.doesNotMatch(r, /--/); // adjacent hits collapse, no separator
  });

  test("pattern reports no matches gracefully", async () => {
    writeFileSync(join(cwd, "nomatch.ts"), "alpha\nbeta");
    const r = await readFile.run({ path: "nomatch.ts", pattern: "zzz" }, ctx());
    assert.match(r, /no lines match/);
  });

  test("pattern with invalid regex returns error", async () => {
    writeFileSync(join(cwd, "bad.ts"), "x");
    const r = await readFile.run({ path: "bad.ts", pattern: "[invalid" }, ctx());
    assert.match(r, /ERROR.*invalid regex/i);
  });
});

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

describe("writeFile", () => {
  test("creates a new file", async () => {
    assert.match(await writeFile.run({ path: "new.txt", content: "data" }, ctx()), /OK/);
    assert.equal(await readFile.run({ path: "new.txt" }, ctx()), "data");
  });

  test("overwrites existing file", async () => {
    await writeFile.run({ path: "over.txt", content: "v1" }, ctx());
    await writeFile.run({ path: "over.txt", content: "v2" }, ctx());
    assert.equal(await readFile.run({ path: "over.txt" }, ctx()), "v2");
  });

  test("creates nested directories", async () => {
    assert.match(await writeFile.run({ path: "a/b/c.txt", content: "deep" }, ctx()), /OK/);
    assert.equal(await readFile.run({ path: "a/b/c.txt" }, ctx()), "deep");
  });
});

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

describe("editFile", () => {
  test("replaces a unique string in a file", async () => {
    await writeFile.run({ path: "edit.ts", content: "const x = 1;\nconst y = 2;\n" }, ctx());
    const r = await editFile.run({ path: "edit.ts", old: "const x = 1;", new: "const x = 99;" }, ctx());
    assert.match(r, /OK/);
    const content = await readFile.run({ path: "edit.ts" }, ctx());
    assert.match(content, /x = 99/);
    assert.match(content, /y = 2/); // rest unchanged
  });

  test("teaching error when old string not found", async () => {
    await writeFile.run({ path: "nope.ts", content: "hello world" }, ctx());
    const r = await editFile.run({ path: "nope.ts", old: "missing", new: "x" }, ctx());
    assert.match(r, /ERROR/);
    assert.match(r, /re-read|not found/i);
  });

  test("teaching error when old string is ambiguous", async () => {
    await writeFile.run({ path: "dup.ts", content: "foo\nfoo\n" }, ctx());
    const r = await editFile.run({ path: "dup.ts", old: "foo", new: "bar" }, ctx());
    assert.match(r, /ERROR/);
    assert.match(r, /2 locations|matches 2/i);
  });

  test("teaching error when file not found", async () => {
    const r = await editFile.run({ path: "ghost.ts", old: "x", new: "y" }, ctx());
    assert.match(r, /ERROR/);
    assert.match(r, /not found/i);
  });

  test("path escape still throws", async () => {
    await assert.rejects(() => editFile.run({ path: "../../x", old: "a", new: "b" }, ctx()));
  });
});

// ---------------------------------------------------------------------------
// list_dir
// ---------------------------------------------------------------------------

describe("listDir", () => {
  test("lists files in directory", async () => {
    const dir = join(cwd, "mydir");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "file.txt"), "");
    assert.match(await listDir.run({ path: "mydir" }, ctx()), /file\.txt/);
  });

  test("marks subdirectories with /", async () => {
    assert.match(await listDir.run({ path: "." }, ctx()), /mydir\//);
  });

  test("returns teaching error for missing directory", async () => {
    const r = await listDir.run({ path: "nonexistent" }, ctx());
    assert.match(r, /ERROR/);
    assert.match(r, /list_dir/); // hint
  });
});

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

describe("grep", () => {
  before(() => {
    writeFileSync(join(cwd, "grep_a.ts"), "export function hello() {}\nexport function world() {}\n");
    writeFileSync(join(cwd, "grep_b.ts"), "import { hello } from './grep_a'\n");
  });

  test("finds matches across files", async () => {
    const r = await grep.run({ pattern: "hello" }, ctx());
    assert.match(r, /grep_a\.ts/);
    assert.match(r, /1:/); // line number
  });

  test("returns file:line:content format", async () => {
    const r = await grep.run({ pattern: "export function world" }, ctx());
    assert.match(r, /grep_a\.ts:2:/);
  });

  test("narrows search to a specific file", async () => {
    const r = await grep.run({ pattern: "hello", path: "grep_b.ts" }, ctx());
    assert.match(r, /grep_b\.ts/);
    assert.doesNotMatch(r, /grep_a\.ts/);
  });

  test("reports no matches gracefully", async () => {
    const r = await grep.run({ pattern: "zzz_no_match_zzz" }, ctx());
    assert.match(r, /no matches/);
  });

  test("returns error for invalid regex", async () => {
    const r = await grep.run({ pattern: "[invalid" }, ctx());
    assert.match(r, /ERROR.*invalid regex/i);
  });

  test("returns teaching error for missing path", async () => {
    const r = await grep.run({ pattern: "x", path: "missing_dir" }, ctx());
    assert.match(r, /ERROR/);
    assert.match(r, /list_dir/);
  });

  test("ignores node_modules", async () => {
    mkdirSync(join(cwd, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(cwd, "node_modules", "dep", "index.js"), "hello from a dependency\n");
    const r = await grep.run({ pattern: "hello" }, ctx());
    assert.doesNotMatch(r, /node_modules/);
  });
});

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

describe("glob", () => {
  before(() => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "main.ts"), "");
    writeFileSync(join(cwd, "src", "util.ts"), "");
    writeFileSync(join(cwd, "README.md"), "");
  });

  test("matches all .ts files with **/*.ts", async () => {
    const r = await glob.run({ pattern: "**/*.ts" }, ctx());
    assert.match(r, /main\.ts/);
    assert.match(r, /util\.ts/);
    assert.doesNotMatch(r, /README/);
  });

  test("matches files in specific dir with src/*.ts", async () => {
    const r = await glob.run({ pattern: "src/*.ts" }, ctx());
    assert.match(r, /main\.ts/);
  });

  test("reports no matches gracefully", async () => {
    const r = await glob.run({ pattern: "**/*.zzz" }, ctx());
    assert.match(r, /no files match/);
  });
});

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

describe("bash", () => {
  test("runs a command and returns stdout", async () => {
    assert.equal((await bash.run({ command: "echo hello" }, ctx())).trim(), "hello");
  });

  test("captures stderr in output", async () => {
    assert.match(await bash.run({ command: "echo err >&2" }, ctx()), /err/);
  });

  test("returns exit code on failure", async () => {
    assert.match(await bash.run({ command: "exit 1" }, ctx()), /EXIT 1/);
  });

  test("runs in the working directory", async () => {
    await writeFile.run({ path: "check.txt", content: "" }, ctx());
    assert.match(await bash.run({ command: "ls check.txt" }, ctx()), /check\.txt/);
  });

  test("closes stdin so a program reading input does not hang", async () => {
    // With stdin closed, `cat` gets EOF immediately and exits instead of blocking.
    const out = await bash.run({ command: "cat" }, ctx());
    assert.equal(out, "(no output)");
  });

  test("honors an abort signal and stops a long-running command", async () => {
    const ac = new AbortController();
    const c = { ...ctx(), signal: ac.signal };
    const p = bash.run({ command: "sleep 30" }, c);
    setTimeout(() => ac.abort(), 50);
    assert.match(await p, /aborted/);
  });

  test("returns immediately when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    assert.match(await bash.run({ command: "sleep 30" }, { ...ctx(), signal: ac.signal }), /aborted/);
  });

  test("blocks interactive/long-running commands before spawning", async () => {
    assert.match(await bash.run({ command: "npm start" }, ctx()), /EXIT blocked/);
    assert.match(await bash.run({ command: "cd app && npm run dev" }, ctx()), /EXIT blocked/);
  });
});

describe("classifyBlocking", () => {
  test("flags dev servers and watchers", () => {
    for (const c of ["npm start", "npm run dev", "yarn serve", "flask run", "vite", "nodemon app.js", "jest --watch"]) {
      assert.ok(classifyBlocking(c), `expected blocked: ${c}`);
    }
  });

  test("flags REPLs, pagers, editors, and follows", () => {
    for (const c of ["python3", "node", "psql", "less file.txt", "vim x.py", "top", "tail -f log"]) {
      assert.ok(classifyBlocking(c), `expected blocked: ${c}`);
    }
  });

  test("catches a blocker after cd in a chain", () => {
    assert.ok(classifyBlocking("cd web && npm run start"));
  });

  test("allows normal one-shot commands", () => {
    for (const c of ["python3 app.py", "node --check app.js", "npm test", "npm run build", "ls -la", "grep -w foo x", "git status"]) {
      assert.equal(classifyBlocking(c), null, `expected allowed: ${c}`);
    }
  });
});
