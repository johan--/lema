import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { matchCommands, buildFrame, type RenderState } from "../../src/tui/renderer.js";
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
    transcript: [],
    buf: "",
    cursor: 0,
    scroll: 0,
    selected: 0,
    status: null,
    spinFrame: 0,
    spinT0: 0,
    overlay: null,
    wrapCache: null,
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

describe("buildFrame", () => {
  test("returns a non-empty string", () => {
    const { out } = buildFrame(makeOpts(), makeState(), 80, 24);
    assert.ok(out.length > 0);
  });

  test("contains synchronized update escape", () => {
    const { out } = buildFrame(makeOpts(), makeState(), 80, 24);
    assert.match(out, /\x1b\[\?2026h/);
  });

  test("bodyH is non-negative", () => {
    const { bodyH } = buildFrame(makeOpts(), makeState(), 80, 24);
    assert.ok(bodyH >= 0);
  });

  test("transcript lines appear in output", () => {
    const state = makeState({ transcript: ["hello from transcript"] });
    const { out } = buildFrame(makeOpts(), state, 80, 24);
    assert.match(out, /hello from transcript/);
  });

  test("populates wrapCache on state", () => {
    const state = makeState({ transcript: ["line"] });
    assert.equal(state.wrapCache, null);
    buildFrame(makeOpts(), state, 80, 24);
    assert.ok(state.wrapCache !== null);
  });

  test("reuses wrapCache when width and length unchanged", () => {
    const state = makeState({ transcript: ["line"] });
    buildFrame(makeOpts(), state, 80, 24);
    const cache = state.wrapCache;
    buildFrame(makeOpts(), state, 80, 24);
    assert.equal(state.wrapCache, cache); // same object reference
  });

  test("rebuilds wrapCache on width change", () => {
    const state = makeState({ transcript: ["line"] });
    buildFrame(makeOpts(), state, 80, 24);
    const cache = state.wrapCache;
    buildFrame(makeOpts(), state, 100, 24);
    assert.notEqual(state.wrapCache, cache);
  });
});
