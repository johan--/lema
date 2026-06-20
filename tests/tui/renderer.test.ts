import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { matchCommands, buildInputBox, buildInputLines, type RenderState } from "../../src/tui/renderer.js";
import type { TuiOptions } from "../../src/tui/index.js";

const COMMANDS = [
  { name: "help", desc: "show help" },
  { name: "models", desc: "list models" },
  { name: "skills", desc: "list skills" },
  { name: "exit", desc: "quit" },
];

describe("matchCommands", () => {
  test("no match when buf is empty", () => {
    assert.deepEqual(matchCommands(COMMANDS, ""), []);
  });

  test("no match for plain text", () => {
    assert.deepEqual(matchCommands(COMMANDS, "hello"), []);
  });

  test("/ alone matches all commands", () => {
    assert.equal(matchCommands(COMMANDS, "/").length, COMMANDS.length);
  });

  test("prefix filter works", () => {
    const result = matchCommands(COMMANDS, "/mo");
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "models");
  });

  test("case-insensitive", () => {
    const result = matchCommands(COMMANDS, "/HE");
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "help");
  });

  test("no match after space (arg mode)", () => {
    assert.deepEqual(matchCommands(COMMANDS, "/help "), []);
  });

  test("caps at MAX_POPUP (6)", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ name: `cmd${i}`, desc: "" }));
    assert.ok(matchCommands(many, "/").length <= 6);
  });
});

function makeState(overrides: Partial<RenderState> = {}): RenderState {
  return {
    buf: "",
    cursor: 0,
    selected: 0,
    status: null,
    spinFrame: 0,
    spinT0: 0,
    overlay: null,
    ...overrides,
  };
}

function makeOpts(overrides: Partial<TuiOptions> = {}): TuiOptions {
  return {
    header: () => [],
    commands: COMMANDS,
    footerRight: () => "model",
    placeholder: "type here",
    onSubmit: async () => false,
    ...overrides,
  };
}

describe("buildInputBox", () => {
  test("returns a non-empty string", () => {
    const { out } = buildInputBox(makeOpts(), makeState(), 80);
    assert.ok(out.length > 0);
  });

  test("contains synchronized update escape", () => {
    const { out } = buildInputBox(makeOpts(), makeState(), 80);
    assert.match(out, /\x1b\[\?2026h/);
  });

  test("totalLines is positive", () => {
    const { totalLines } = buildInputBox(makeOpts(), makeState(), 80);
    assert.ok(totalLines > 0);
  });

  test("more input lines → larger totalLines", () => {
    const stateShort = makeState({ buf: "hi", cursor: 2 });
    const stateLong = makeState({ buf: "a".repeat(200), cursor: 200 });
    const { totalLines: short } = buildInputBox(makeOpts(), stateShort, 40);
    const { totalLines: long } = buildInputBox(makeOpts(), stateLong, 40);
    assert.ok(long > short);
  });

  test("status line appears when status is set", () => {
    const state = makeState({ status: "thinking" });
    const { out, totalLines } = buildInputBox(makeOpts(), state, 80);
    assert.match(out, /thinking/);
    const baseLines = buildInputBox(makeOpts(), makeState(), 80).totalLines;
    assert.ok(totalLines > baseLines);
  });

  test("command popup lines appear in output", () => {
    const state = makeState({ buf: "/h", cursor: 2 });
    const { out } = buildInputBox(makeOpts(), state, 80);
    assert.match(out, /help/);
  });
});

describe("buildInputLines", () => {
  const opts = makeOpts();

  test("empty buf renders one placeholder line, cursor at col 5", () => {
    const { lines, cursorRow, cursorCol } = buildInputLines(opts, "", 0, 30);
    assert.equal(lines.length, 1);
    assert.equal(cursorRow, 0);
    assert.equal(cursorCol, 5);
  });

  test("short text renders one line", () => {
    const buf = "hello";
    const { lines, cursorRow, cursorCol } = buildInputLines(opts, buf, buf.length, 30);
    assert.equal(lines.length, 1);
    assert.equal(cursorRow, 0);
    assert.equal(cursorCol, 5 + buf.length);
  });

  test("text longer than textArea wraps to second line", () => {
    // w=20 → textArea = 20 - 6 = 14
    const buf = "a".repeat(15);
    const { lines, cursorRow, cursorCol } = buildInputLines(opts, buf, buf.length, 20);
    assert.equal(lines.length, 2);
    assert.equal(cursorRow, 1);
    assert.equal(cursorCol, 5 + 1); // 15 % 14 = 1
  });

  test("text exactly 2× textArea produces two lines", () => {
    // w=20 → textArea=14; buf length=28 fills two chunks exactly
    const buf = "a".repeat(28);
    const { lines } = buildInputLines(opts, buf, 0, 20);
    assert.equal(lines.length, 2);
  });

  test("cursor in the middle of first line", () => {
    const buf = "a".repeat(20);
    const { cursorRow, cursorCol } = buildInputLines(opts, buf, 5, 20);
    assert.equal(cursorRow, 0);
    assert.equal(cursorCol, 5 + 5);
  });

  test("cursor at start of second chunk", () => {
    // w=20 → textArea=14; cursor=14 → row 1, col 5+0
    const buf = "a".repeat(20);
    const { cursorRow, cursorCol } = buildInputLines(opts, buf, 14, 20);
    assert.equal(cursorRow, 1);
    assert.equal(cursorCol, 5);
  });
});
