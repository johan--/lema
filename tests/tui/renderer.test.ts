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

// Strip all ANSI escape sequences from a string to get plain text.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[^[]/g, "");
}

// Count how many times a substring appears in a string.
function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) { n++; pos += needle.length; }
  return n;
}

describe("buildInputBox — escape sequence invariants", () => {
  // WHY: In raw mode \n is LF only (no carriage return). Every line must be
  // preceded by \r so the cursor returns to column 0 before writing content.
  // Without \r the second render starts mid-line and the box accumulates on screen.
  test("uses \\r\\n between lines, not bare \\n", () => {
    const { out } = buildInputBox(makeOpts(), makeState(), 80);
    // No bare \n (without leading \r) should exist in the payload
    const hasBareNewline = /(?<!\r)\n/.test(out);
    assert.ok(!hasBareNewline, "bare \\n found — would draw at wrong column in raw mode");
  });

  test("output starts with \\r after synchronize-start to reset column", () => {
    // WHY: Even on the very first line the cursor might be at column > 0 (e.g.
    // after the header or a previous erase). \r guarantees we start at col 0.
    const { out } = buildInputBox(makeOpts(), makeState(), 80);
    assert.ok(out.startsWith("\x1b[?2026h\r"), "first bytes must be sync-start then \\r");
  });

  test("cursor repositioning uses \\r before column-move escape", () => {
    // WHY: After writing the last line, cursor is at col W (end of last char).
    // Moving up N rows leaves cursor at the same column on the target row.
    // \r resets it to col 0 so the subsequent \x1b[CG lands at the right column.
    const { out } = buildInputBox(makeOpts(), makeState(), 80);
    // The reposition sequence must be \r\x1b[<N>G (not just \x1b[<N>G alone)
    assert.match(out, /\r\x1b\[\d+G/, "cursor reposition must include \\r before \\x1b[NG");
  });

  test("wrapped in synchronized-update (BSU/ESU) escapes", () => {
    // WHY: ?2026h/?2026l (begin/end synchronized update) tells the terminal to
    // buffer the entire frame before painting — prevents visible tearing.
    const { out } = buildInputBox(makeOpts(), makeState(), 80);
    assert.match(out, /\x1b\[\?2026h/);
    assert.match(out, /\x1b\[\?2026l/);
  });
});

describe("buildInputBox — cursorRowInBox (erase-logic invariant)", () => {
  // WHY: eraseInputBox does `\x1b[${cursorRowInBox}A \r \x1b[J` to erase exactly
  // the input box and nothing above it. cursorRowInBox must equal the number of
  // rows between the TOP of the box and the cursor position, so moving up by that
  // many rows always lands on the very first line of the box.

  test("empty buf: cursor is on row 1 (after top border)", () => {
    // Box layout: [0] ╭──╮  [1] │ › │  [2] ╰──╯  [3] footer
    // Cursor sits at row 1, so cursorRowInBox = 1 → eraseInputBox moves up 1 row.
    const { cursorRowInBox } = buildInputBox(makeOpts(), makeState(), 80);
    assert.equal(cursorRowInBox, 1);
  });

  test("with one status line: cursor is on row 2", () => {
    // Box layout: [0] spinner  [1] ╭──╮  [2] │ › │  [3] ╰──╯  [4] footer
    // cursorRowInBox = 2 → eraseInputBox must move up 2 rows.
    const { cursorRowInBox } = buildInputBox(makeOpts(), makeState({ status: "working" }), 80);
    assert.equal(cursorRowInBox, 2);
  });

  test("with N popup lines: cursorRowInBox = N + 1", () => {
    // Box layout: [0..N-1] popup  [N] ╭──╮  [N+1] │ › │  ...
    // Each matched command adds one popup row above the box.
    const buf = "/";  // matches all 4 commands
    const ms = matchCommands(COMMANDS, buf);
    const { cursorRowInBox } = buildInputBox(makeOpts(), makeState({ buf, cursor: 1 }), 80);
    assert.equal(cursorRowInBox, ms.length + 1);
  });

  test("multi-line input: cursor on the correct wrapped row", () => {
    // w=20 → textArea=14. buf of 15 chars wraps to 2 lines: row 0 and row 1.
    // Cursor at end (pos 15) is on row 1 inside text → cursorRowInBox = 0 (popup) + 1 (top border) + 1 = 2.
    const buf = "a".repeat(15);
    const { cursorRowInBox } = buildInputBox(makeOpts(), makeState({ buf, cursor: buf.length }), 20);
    assert.equal(cursorRowInBox, 2); // 0 popup + 1 border + 1 text row
  });

  test("cursorRowInBox is always strictly less than totalLines", () => {
    // WHY: If cursorRowInBox >= totalLines, eraseInputBox would move the cursor
    // above the top of the box and erase content that belongs to the chat transcript.
    for (const buf of ["", "hello", "a".repeat(100)]) {
      const { cursorRowInBox, totalLines } = buildInputBox(makeOpts(), makeState({ buf, cursor: buf.length }), 40);
      assert.ok(
        cursorRowInBox < totalLines,
        `cursorRowInBox(${cursorRowInBox}) must be < totalLines(${totalLines}) for buf.length=${buf.length}`,
      );
    }
  });

  test("totalLines grows with popup and status but cursorRowInBox stays consistent", () => {
    const base = buildInputBox(makeOpts(), makeState(), 80);
    const withStatus = buildInputBox(makeOpts(), makeState({ status: "x" }), 80);
    const withPopup = buildInputBox(makeOpts(), makeState({ buf: "/", cursor: 1 }), 80);

    // totalLines grows by exactly 1 for status, by matchCount for popup
    assert.equal(withStatus.totalLines, base.totalLines + 1);
    assert.equal(withPopup.totalLines, base.totalLines + matchCommands(COMMANDS, "/").length);

    // cursorRowInBox grows in lockstep with the rows added above the box
    assert.equal(withStatus.cursorRowInBox, base.cursorRowInBox + 1);
    assert.equal(withPopup.cursorRowInBox, base.cursorRowInBox + matchCommands(COMMANDS, "/").length);
  });
});

describe("buildInputBox — content", () => {
  test("totalLines is positive", () => {
    const { totalLines } = buildInputBox(makeOpts(), makeState(), 80);
    assert.ok(totalLines > 0);
  });

  test("more input text → more totalLines (box grows vertically)", () => {
    const stateShort = makeState({ buf: "hi", cursor: 2 });
    const stateLong = makeState({ buf: "a".repeat(200), cursor: 200 });
    const { totalLines: short } = buildInputBox(makeOpts(), stateShort, 40);
    const { totalLines: long } = buildInputBox(makeOpts(), stateLong, 40);
    assert.ok(long > short);
  });

  test("status spinner text appears in output", () => {
    const state = makeState({ status: "thinking" });
    const { out, totalLines } = buildInputBox(makeOpts(), state, 80);
    assert.match(out, /thinking/);
    assert.equal(totalLines, buildInputBox(makeOpts(), makeState(), 80).totalLines + 1);
  });

  test("command popup entries appear above the box border", () => {
    // Popup lines come before ╭──╮ so the user sees completions above the input.
    const state = makeState({ buf: "/h", cursor: 2 });
    const { out } = buildInputBox(makeOpts(), state, 80);
    const plain = stripAnsi(out);
    const popupIdx = plain.indexOf("help");
    const borderIdx = plain.indexOf("╭");
    assert.ok(popupIdx !== -1, "popup entry 'help' not found");
    assert.ok(popupIdx < borderIdx, "popup must appear before the box border");
  });

  test("each line is followed by \\x1b[K to erase any remnant from the previous render", () => {
    // WHY: Without \x1b[K (erase to end of line), leftover characters from a
    // wider previous render would bleed through into the current frame.
    const { out, totalLines } = buildInputBox(makeOpts(), makeState(), 80);
    const eraseCount = countOccurrences(out, "\x1b[K");
    assert.equal(eraseCount, totalLines, "every line must have exactly one \\x1b[K");
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
