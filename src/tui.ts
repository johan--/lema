import { emitKeypressEvents, type Key } from "node:readline";
import { stdin, stdout } from "node:process";
import * as ui from "./ui.js";

export interface TuiCommand {
  name: string;
  desc: string;
}

export interface TuiOptions {
  commands: TuiCommand[];
  /** Right-aligned footer text, read on every repaint so it can change over time. */
  footerRight: () => string;
  /** Dim hint shown when the input is empty. */
  placeholder: string;
  /** Called on Enter. Output is printed normally (raw mode is off). Return true to quit. */
  onSubmit: (line: string) => Promise<boolean>;
}

const MAX_POPUP = 6;

/**
 * A zero-dependency raw-mode line editor with a bordered input, a pinned footer,
 * and a slash-command popup. The whole bottom region is redrawn on every keystroke;
 * during onSubmit we drop out of raw mode so agent output scrolls normally.
 */
export async function runTui(opts: TuiOptions): Promise<void> {
  let buf = "";
  let cursor = 0;
  let selected = 0;
  const history: string[] = [];
  let histIdx: number | null = null;
  let busy = false;
  let prevUp = -1; // lines from the input row up to the top of the rendered region

  const cols = () => Math.max(stdout.columns || 80, 24);

  // ---- view helpers -------------------------------------------------------

  const matches = (): TuiCommand[] => {
    if (!buf.startsWith("/") || buf.includes(" ")) return [];
    const frag = buf.slice(1).toLowerCase();
    return opts.commands.filter((c) => c.name.startsWith(frag)).slice(0, MAX_POPUP);
  };

  const popupRows = (ms: TuiCommand[]): string[] =>
    ms.map((c, i) => {
      const marker = i === selected ? ui.magenta("❯ ") : "  ";
      const name = ("/" + c.name).padEnd(12);
      return "  " + marker + (i === selected ? ui.bold(name) : name) + ui.dim(c.desc);
    });

  const boxTop = (w: number) => ui.magenta("╭" + "─".repeat(w - 2) + "╮");
  const boxBottom = (w: number) => ui.magenta("╰" + "─".repeat(w - 2) + "╯");

  const inputRow = (w: number): { line: string; col: number } => {
    const textArea = w - 6; // "│ › " + text + " │"
    let shown: string;
    let curOff: number;
    if (buf.length === 0) {
      shown = ui.dim(opts.placeholder.slice(0, textArea));
      curOff = 0;
    } else if (buf.length > textArea) {
      shown = "…" + buf.slice(buf.length - (textArea - 1));
      curOff = textArea;
    } else {
      shown = buf;
      curOff = cursor;
    }
    const rawLen = buf.length === 0 ? Math.min(opts.placeholder.length, textArea) : Math.min(buf.length, textArea);
    const pad = " ".repeat(Math.max(0, textArea - rawLen));
    const line = ui.magenta("│") + " " + ui.magenta("›") + " " + shown + pad + " " + ui.magenta("│");
    return { line, col: 5 + curOff };
  };

  const footer = (w: number): string => {
    const left = " ? for shortcuts · /exit to quit";
    let right = opts.footerRight() + " ";
    let pad = w - left.length - right.length;
    if (pad < 1) {
      right = right.slice(0, Math.max(0, w - left.length - 1)) + " ";
      pad = 1;
    }
    return ui.dim(left + " ".repeat(pad) + right);
  };

  const render = () => {
    const w = cols();
    const ms = matches();
    if (selected >= ms.length) selected = Math.max(0, ms.length - 1);
    const pop = popupRows(ms);
    const { line: mid, col } = inputRow(w);
    const lines = [...pop, boxTop(w), mid, boxBottom(w), footer(w)];

    // Disable line wrap (\x1b[?7l) around the repaint so full-width lines never
    // trigger a phantom wrap — that keeps one logical line == one screen row, so
    // the relative cursor math stays correct even across terminal resizes.
    const clear = prevUp >= 0 ? `\x1b[${prevUp}F\x1b[J` : "\r\x1b[J";
    const park = "\x1b[2A" + `\x1b[${col}G`; // back up to the input row, set column
    stdout.write("\x1b[?7l" + clear + lines.join("\n") + park + "\x1b[?7h");
    prevUp = pop.length + 1; // input row is this many lines below the region top
  };

  const clearRegion = () => {
    if (prevUp >= 0) stdout.write(`\x1b[${prevUp}F\x1b[J`);
    prevUp = -1;
  };

  // ---- key handling -------------------------------------------------------

  const submit = async () => {
    const line = buf.trim();
    clearRegion();
    buf = "";
    cursor = 0;
    selected = 0;
    histIdx = null;
    if (line) history.push(line);

    setRaw(false);
    busy = true;
    let quit = false;
    try {
      quit = await opts.onSubmit(line);
    } catch (e) {
      ui.err((e as Error).message);
    }
    busy = false;
    if (quit) return teardown();
    setRaw(true);
    render();
  };

  const onKey = (str: string | undefined, key: Key) => {
    if (busy) return;
    const ms = matches();

    if (key.name === "return" || key.name === "enter" || str === "\r" || str === "\n") {
      // If the popup is open, Enter runs the highlighted command (autocomplete-on-enter).
      if (ms.length) {
        buf = "/" + ms[selected].name;
        cursor = buf.length;
      }
      return void submit();
    }
    if (key.ctrl && key.name === "c") {
      if (buf) {
        buf = "";
        cursor = 0;
      } else return teardown();
    } else if (key.ctrl && key.name === "d") {
      if (!buf) return teardown();
    } else if (key.name === "backspace") {
      if (cursor > 0) {
        buf = buf.slice(0, cursor - 1) + buf.slice(cursor);
        cursor--;
      }
    } else if (key.name === "left") {
      if (cursor > 0) cursor--;
    } else if (key.name === "right") {
      if (cursor < buf.length) cursor++;
    } else if (key.name === "home" || (key.ctrl && key.name === "a")) {
      cursor = 0;
    } else if (key.name === "end" || (key.ctrl && key.name === "e")) {
      cursor = buf.length;
    } else if (key.name === "up") {
      if (ms.length) selected = (selected - 1 + ms.length) % ms.length;
      else recallHistory(-1);
    } else if (key.name === "down") {
      if (ms.length) selected = (selected + 1) % ms.length;
      else recallHistory(1);
    } else if (key.name === "tab") {
      if (ms.length) {
        buf = "/" + ms[selected].name + " ";
        cursor = buf.length;
        selected = 0;
      }
    } else if (str && !key.ctrl && !key.meta && str.length === 1 && str >= " ") {
      buf = buf.slice(0, cursor) + str + buf.slice(cursor);
      cursor++;
    } else {
      return; // unhandled key, no repaint
    }
    render();
  };

  const recallHistory = (dir: number) => {
    if (!history.length) return;
    if (histIdx === null) histIdx = dir < 0 ? history.length - 1 : history.length;
    else histIdx = Math.max(0, Math.min(history.length, histIdx + dir));
    if (histIdx >= history.length) {
      histIdx = null;
      buf = "";
    } else {
      buf = history[histIdx];
    }
    cursor = buf.length;
  };

  // ---- lifecycle ----------------------------------------------------------

  let resolveDone!: () => void;
  const done = new Promise<void>((res) => (resolveDone = res));

  const setRaw = (on: boolean) => {
    if (stdin.isTTY) stdin.setRawMode(on);
  };

  // Resize fires rapidly during a drag; debounce and repaint once it settles.
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const onResize = () => {
    if (busy) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => !busy && render(), 50);
  };

  const teardown = () => {
    clearTimeout(resizeTimer);
    clearRegion();
    stdin.off("keypress", onKey);
    stdout.off("resize", onResize);
    setRaw(false);
    stdin.pause();
    resolveDone();
  };

  emitKeypressEvents(stdin);
  setRaw(true);
  stdin.resume();
  stdin.on("keypress", onKey);
  stdout.on("resize", onResize);
  render();

  await done;
}
