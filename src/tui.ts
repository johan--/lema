import { emitKeypressEvents, type Key } from "node:readline";
import { stdin, stdout } from "node:process";
import * as ui from "./ui.js";

export interface TuiCommand {
  name: string;
  desc: string;
  args?: string;
}

export interface TuiOptions {
  /** Header (banner) lines, recomputed each frame; scroll with the transcript. */
  header: () => string[];
  commands: TuiCommand[];
  /** Right-aligned footer text, read every frame so it can change. */
  footerRight: () => string;
  /** Dim hint shown when the input is empty. */
  placeholder: string;
  /** Called on Enter. Return true to quit. */
  onSubmit: (line: string) => Promise<boolean>;
}

const ESC_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const MAX_POPUP = 6;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Visible length, ignoring ANSI escape sequences. */
function vlen(s: string): number {
  return s.replace(ESC_RE, "").length;
}

/** Hard-wrap a (possibly ANSI-styled) line to `width` visible columns. */
function wrap(line: string, width: number): string[] {
  if (width < 1 || vlen(line) <= width) return [line];
  const out: string[] = [];
  let cur = "";
  let n = 0;
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      const m = line.slice(i).match(/^\x1b\[[0-9;?]*[A-Za-z]/);
      if (m) {
        cur += m[0];
        i += m[0].length;
        continue;
      }
    }
    cur += line[i];
    i++;
    n++;
    if (n >= width) {
      out.push(cur);
      cur = "";
      n = 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * A full-screen, alternate-buffer TUI compositor. It keeps the transcript in
 * memory and repaints the whole frame (header + scrollback + input box + footer)
 * on every change, wrapped to the current width. Because every frame is computed
 * from scratch for the current size, resizing can never corrupt the layout.
 */
export class Tui {
  private transcript: string[] = [];
  private buf = "";
  private cursor = 0;
  private selected = 0;
  private history: string[] = [];
  private histIdx: number | null = null;
  private busy = false;
  private status: string | null = null;
  private spinFrame = 0;
  private spinTimer: ReturnType<typeof setInterval> | undefined;
  private spinT0 = 0;
  private scheduled = false;
  private done = false;
  private resolveDone: () => void = () => {};

  constructor(private opts: TuiOptions) {}

  // ---- public API used by the host -----------------------------------------

  /** Append output to the transcript (splitting multi-line strings). */
  print(s: string): void {
    for (const line of s.split("\n")) this.transcript.push(line);
    this.schedule();
  }

  /** Show (or clear) an animated status line above the input box. */
  setStatus(text: string | null): void {
    if (text) {
      this.status = text;
      if (!this.spinTimer) {
        this.spinT0 = Date.now();
        this.spinTimer = setInterval(() => {
          this.spinFrame++;
          this.render();
        }, 80);
      }
    } else {
      this.status = null;
      if (this.spinTimer) {
        clearInterval(this.spinTimer);
        this.spinTimer = undefined;
      }
    }
    this.schedule();
  }

  async run(): Promise<void> {
    emitKeypressEvents(stdin);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdout.write("\x1b[?1049h\x1b[2J"); // enter alternate screen
    stdin.on("keypress", this.onKey);
    stdout.on("resize", this.onResize);
    this.render();
    await new Promise<void>((res) => (this.resolveDone = res));
  }

  // ---- frame composition ---------------------------------------------------

  private matches(): TuiCommand[] {
    if (!this.buf.startsWith("/") || this.buf.includes(" ")) return [];
    const frag = this.buf.slice(1).toLowerCase();
    return this.opts.commands.filter((c) => c.name.startsWith(frag)).slice(0, MAX_POPUP);
  }

  private inputRegion(w: number): { lines: string[]; inputOffset: number; col: number } {
    const lines: string[] = [];
    const ms = this.matches();
    if (this.selected >= ms.length) this.selected = Math.max(0, ms.length - 1);
    for (let i = 0; i < ms.length; i++) {
      const sel = i === this.selected;
      const name = ("/" + ms[i].name).padEnd(12);
      lines.push("  " + (sel ? ui.magenta("❯ ") : "  ") + (sel ? ui.bold(name) : name) + ui.dim(ms[i].desc));
    }
    if (this.status) {
      const s = ((Date.now() - this.spinT0) / 1000).toFixed(1);
      lines.push("  " + ui.magenta(SPIN[this.spinFrame % SPIN.length]) + " " + ui.dim(`${this.status} ${s}s`));
    }
    const dash = Math.max(0, w - 2);
    const { line: mid, col } = this.inputLine(w);
    const inputOffset = lines.length + 1; // mid sits right after the top border
    lines.push(ui.magenta("╭" + "─".repeat(dash) + "╮"), mid, ui.magenta("╰" + "─".repeat(dash) + "╯"), this.footer(w));
    return { lines, inputOffset, col };
  }

  private inputLine(w: number): { line: string; col: number } {
    const textArea = Math.max(1, w - 6);
    let shown: string;
    let curOff: number;
    if (this.buf.length === 0) {
      shown = ui.dim(this.opts.placeholder.slice(0, textArea));
      curOff = 0;
    } else if (this.buf.length > textArea) {
      shown = "…" + this.buf.slice(this.buf.length - (textArea - 1));
      curOff = textArea;
    } else {
      shown = this.buf;
      curOff = this.cursor;
    }
    const rawLen = this.buf.length === 0 ? Math.min(this.opts.placeholder.length, textArea) : Math.min(this.buf.length, textArea);
    const pad = " ".repeat(Math.max(0, textArea - rawLen));
    const line = ui.magenta("│") + " " + ui.magenta("›") + " " + shown + pad + " " + ui.magenta("│");
    return { line, col: 5 + curOff };
  }

  private footer(w: number): string {
    const left = " ? for shortcuts · /exit to quit";
    let right = this.opts.footerRight() + " ";
    let pad = w - left.length - vlen(right);
    if (pad < 1) {
      right = right.slice(0, Math.max(0, w - left.length - 1)) + " ";
      pad = 1;
    }
    return ui.dim(left + " ".repeat(pad) + right);
  }

  private render(): void {
    if (this.done) return;
    const w = Math.max(stdout.columns || 80, 24);
    const rows = Math.max(stdout.rows || 24, 8);
    const region = this.inputRegion(w);
    const bodyH = Math.max(0, rows - region.lines.length);

    const all = [...this.opts.header(), ...this.transcript].flatMap((l) => wrap(l, w));
    const view = all.slice(Math.max(0, all.length - bodyH));
    const padCount = bodyH - view.length;
    const screen = [...view, ...Array(padCount).fill(""), ...region.lines];

    // Begin synchronized update, disable wrap, repaint from home.
    let out = "\x1b[?2026h\x1b[?7l\x1b[H";
    for (let r = 0; r < screen.length; r++) {
      out += screen[r] + "\x1b[K";
      if (r < screen.length - 1) out += "\n";
    }
    out += "\x1b[J";
    const inputRow = bodyH + region.inputOffset + 1; // 1-indexed absolute row
    out += `\x1b[${inputRow};${region.col}H`;
    out += "\x1b[?7h\x1b[?2026l";
    stdout.write(out);
  }

  private schedule(): void {
    if (this.scheduled || this.done) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.render();
    });
  }

  // ---- input ---------------------------------------------------------------

  private onResize = (): void => this.render();

  private recallHistory(dir: number): void {
    if (!this.history.length) return;
    if (this.histIdx === null) this.histIdx = dir < 0 ? this.history.length - 1 : this.history.length;
    else this.histIdx = Math.max(0, Math.min(this.history.length, this.histIdx + dir));
    this.buf = this.histIdx >= this.history.length ? "" : this.history[this.histIdx];
    if (this.histIdx >= this.history.length) this.histIdx = null;
    this.cursor = this.buf.length;
  }

  private onKey = (str: string | undefined, key: Key): void => {
    if (this.busy) return;
    const ms = this.matches();

    if (key.name === "return" || key.name === "enter" || str === "\r" || str === "\n") {
      if (ms.length) {
        this.buf = "/" + ms[this.selected].name;
        this.cursor = this.buf.length;
      }
      return void this.submit();
    }
    if (key.ctrl && key.name === "c") {
      if (this.buf) {
        this.buf = "";
        this.cursor = 0;
      } else return this.teardown();
    } else if (key.ctrl && key.name === "d") {
      if (!this.buf) return this.teardown();
    } else if (key.name === "backspace") {
      if (this.cursor > 0) {
        this.buf = this.buf.slice(0, this.cursor - 1) + this.buf.slice(this.cursor);
        this.cursor--;
      }
    } else if (key.name === "left") {
      if (this.cursor > 0) this.cursor--;
    } else if (key.name === "right") {
      if (this.cursor < this.buf.length) this.cursor++;
    } else if (key.name === "home" || (key.ctrl && key.name === "a")) {
      this.cursor = 0;
    } else if (key.name === "end" || (key.ctrl && key.name === "e")) {
      this.cursor = this.buf.length;
    } else if (key.name === "up") {
      if (ms.length) this.selected = (this.selected - 1 + ms.length) % ms.length;
      else this.recallHistory(-1);
    } else if (key.name === "down") {
      if (ms.length) this.selected = (this.selected + 1) % ms.length;
      else this.recallHistory(1);
    } else if (key.name === "tab") {
      if (ms.length) {
        this.buf = "/" + ms[this.selected].name + " ";
        this.cursor = this.buf.length;
        this.selected = 0;
      }
    } else if (str && !key.ctrl && !key.meta && str.length === 1 && str >= " ") {
      this.buf = this.buf.slice(0, this.cursor) + str + this.buf.slice(this.cursor);
      this.cursor++;
    } else {
      return;
    }
    this.render();
  };

  private async submit(): Promise<void> {
    const line = this.buf.trim();
    this.buf = "";
    this.cursor = 0;
    this.selected = 0;
    this.histIdx = null;
    if (line) {
      this.history.push(line);
      this.print(ui.magenta("› ") + (line.startsWith("/") ? ui.cyan(line) : line));
    }
    this.busy = true;
    this.render();
    let quit = false;
    try {
      quit = await this.opts.onSubmit(line);
    } catch (e) {
      this.print(ui.red("✗ ") + (e as Error).message);
    }
    this.setStatus(null);
    this.busy = false;
    if (quit) return this.teardown();
    this.render();
  }

  private teardown(): void {
    if (this.done) return;
    this.done = true;
    if (this.spinTimer) clearInterval(this.spinTimer);
    stdin.off("keypress", this.onKey);
    stdout.off("resize", this.onResize);
    stdout.write("\x1b[?2026l\x1b[?7h\x1b[?1049l"); // leave alternate screen
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    this.resolveDone();
  }
}
