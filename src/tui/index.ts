import { stdin, stdout } from "node:process";
import * as ui from "../ui.js";
import { type ParsedKey, extractSequences, parseSeq } from "./input.js";
import { vlen, wrap } from "./text.js";

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

const MAX_POPUP = 6;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const PASTE_LINE_LIMIT = 1;
const PASTE_CHAR_LIMIT = 200;

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
  private scroll = 0;
  private lastBodyH = 10;
  private inbuf = "";
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private pasting = false;
  private pasteBuf = "";
  private pastes = new Map<number, string>();
  private pasteCounter = 0;
  private overlay: { title: string; items: string[]; selected: number; resolve: (v: string | null) => void } | null = null;
  private wrapCache: { w: number; len: number; lines: string[] } | null = null;
  private resolveDone: () => void = () => {};

  constructor(private opts: TuiOptions) {}

  // ---- public API ----------------------------------------------------------

  print(s: string): void {
    for (const line of s.split("\n")) this.transcript.push(line);
    this.schedule();
  }

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

  select(title: string, items: string[]): Promise<string | null> {
    if (!items.length) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.overlay = { title, items, selected: 0, resolve };
      this.render();
    });
  }

  private closeOverlay(value: string | null): void {
    const ov = this.overlay;
    this.overlay = null;
    if (ov) ov.resolve(value);
    this.render();
  }

  async run(): Promise<void> {
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdout.write("\x1b[?1049h\x1b[2J\x1b[?1000h\x1b[?1006h\x1b[?2004h");
    stdin.on("data", this.onData);
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
    if (this.overlay) {
      lines.push("  " + ui.dim(this.overlay.title));
      const items = this.overlay.items;
      const max = 8;
      const top = Math.max(0, Math.min(this.overlay.selected - (max >> 1), items.length - max));
      for (let i = top; i < Math.min(items.length, top + max); i++) {
        const sel = i === this.overlay.selected;
        const label = items[i].length > w - 6 ? items[i].slice(0, w - 7) + "…" : items[i];
        lines.push("  " + (sel ? ui.magenta("❯ ") + ui.bold(label) : "  " + ui.dim(label)));
      }
    }
    const dash = Math.max(0, w - 2);
    const { line: mid, col } = this.inputLine(w);
    const inputOffset = lines.length + 1;
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
    const left = this.scroll > 0 ? " ↓ scroll down / PageDown for latest" : " ? for shortcuts · /exit to quit";
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

    if (!this.wrapCache || this.wrapCache.w !== w || this.wrapCache.len !== this.transcript.length) {
      this.wrapCache = { w, len: this.transcript.length, lines: this.transcript.flatMap((l) => wrap(l, w)) };
    }
    const all = [...this.opts.header().flatMap((l) => wrap(l, w)), ...this.wrapCache.lines];
    const maxScroll = Math.max(0, all.length - bodyH);
    if (this.scroll > maxScroll) this.scroll = maxScroll;
    this.lastBodyH = bodyH;
    const end = all.length - this.scroll;
    const view = all.slice(Math.max(0, end - bodyH), end);
    const padCount = Math.max(0, bodyH - view.length);
    const screen = [...view, ...Array(padCount).fill(""), ...region.lines];

    let out = "\x1b[?2026h\x1b[?7l\x1b[H";
    for (let r = 0; r < screen.length; r++) {
      out += screen[r] + "\x1b[K";
      if (r < screen.length - 1) out += "\n";
    }
    out += "\x1b[J";
    const inputRow = bodyH + region.inputOffset + 1;
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

  private scrollBy(delta: number): void {
    const next = Math.max(0, this.scroll + delta);
    if (next === this.scroll) return;
    this.scroll = next;
    this.render();
  }

  private onData = (chunk: string): void => {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.inbuf += chunk;
    this.drain();
  };

  private drain(): void {
    for (;;) {
      if (this.pasting) {
        const end = this.inbuf.indexOf(PASTE_END);
        if (end === -1) {
          this.pasteBuf += this.inbuf;
          this.inbuf = "";
          return;
        }
        this.pasteBuf += this.inbuf.slice(0, end);
        this.inbuf = this.inbuf.slice(end + PASTE_END.length);
        this.pasting = false;
        const content = this.pasteBuf;
        this.pasteBuf = "";
        this.handlePaste(content);
        continue;
      }
      const start = this.inbuf.indexOf(PASTE_START);
      if (start === -1) break;
      this.feedKeys(this.inbuf.slice(0, start));
      this.inbuf = this.inbuf.slice(start + PASTE_START.length);
      this.pasting = true;
    }

    const { sequences, remainder } = extractSequences(this.inbuf);
    this.inbuf = remainder;
    for (const seq of sequences) this.handleKey(parseSeq(seq));
    if (remainder === "\x1b") {
      this.flushTimer = setTimeout(() => {
        if (this.inbuf === "\x1b") {
          this.inbuf = "";
          this.handleKey({ name: "escape" });
        }
      }, 20);
    }
  }

  private feedKeys(segment: string): void {
    const { sequences } = extractSequences(segment);
    for (const seq of sequences) this.handleKey(parseSeq(seq));
  }

  private insertText(s: string): void {
    this.buf = this.buf.slice(0, this.cursor) + s + this.buf.slice(this.cursor);
    this.cursor += s.length;
  }

  private handlePaste(raw: string): void {
    if (this.busy) return;
    const text = raw
      .replace(/\r\n?/g, "\n")
      .replace(/\t/g, "  ")
      .split("")
      .filter((c) => c === "\n" || c.charCodeAt(0) >= 32)
      .join("");
    const lines = text.split("\n");
    if (lines.length > PASTE_LINE_LIMIT || text.length > PASTE_CHAR_LIMIT) {
      const id = ++this.pasteCounter;
      this.pastes.set(id, text);
      const marker =
        lines.length > 1 ? `[paste #${id} +${lines.length} lines]` : `[paste #${id} ${text.length} chars]`;
      this.insertText(marker);
    } else {
      this.insertText(text);
    }
    this.render();
  }

  private expandPastes(line: string): string {
    return line.replace(/\[paste #(\d+) (?:\+\d+ lines|\d+ chars)\]/g, (m, id) => {
      const content = this.pastes.get(Number(id));
      return content !== undefined ? content : m;
    });
  }

  private handleKey(key: ParsedKey): void {
    if (key.mouse !== undefined) {
      if (key.mouse & 64) this.scrollBy(key.mouse & 1 ? -3 : 3);
      return;
    }
    if (key.name === "pageup") return this.scrollBy(Math.max(1, this.lastBodyH - 2));
    if (key.name === "pagedown") return this.scrollBy(-Math.max(1, this.lastBodyH - 2));

    if (this.overlay) {
      const n = this.overlay.items.length;
      if (key.name === "up") this.overlay.selected = (this.overlay.selected - 1 + n) % n;
      else if (key.name === "down") this.overlay.selected = (this.overlay.selected + 1) % n;
      else if (key.name === "return") return this.closeOverlay(this.overlay.items[this.overlay.selected]);
      else if (key.name === "escape" || (key.ctrl && key.name === "c")) return this.closeOverlay(null);
      else return;
      return this.render();
    }

    if (this.busy) return;
    const ms = this.matches();
    const str = key.str;

    if (key.name === "return") {
      if (ms.length) {
        this.buf = "/" + ms[this.selected].name;
        this.cursor = this.buf.length;
      }
      return void this.submit();
    }
    if (key.ctrl && key.name === "c") {
      if (this.buf) { this.buf = ""; this.cursor = 0; }
      else return this.teardown();
    } else if (key.ctrl && key.name === "d") {
      if (!this.buf) return this.teardown();
    } else if (key.name === "backspace") {
      if (this.cursor > 0) { this.buf = this.buf.slice(0, this.cursor - 1) + this.buf.slice(this.cursor); this.cursor--; }
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
      if (ms.length) { this.buf = "/" + ms[this.selected].name + " "; this.cursor = this.buf.length; this.selected = 0; }
    } else if (str && !key.ctrl && !key.meta && str.length === 1 && str >= " ") {
      this.buf = this.buf.slice(0, this.cursor) + str + this.buf.slice(this.cursor);
      this.cursor++;
    } else {
      return;
    }
    this.render();
  }

  private async submit(): Promise<void> {
    const shown = this.buf.trim();
    const line = this.expandPastes(shown).trim();
    this.buf = "";
    this.cursor = 0;
    this.selected = 0;
    this.histIdx = null;
    this.scroll = 0;
    this.pastes.clear();
    if (shown) {
      this.history.push(shown);
      this.print(ui.magenta("› ") + (shown.startsWith("/") ? ui.cyan(shown) : shown));
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
    if (this.flushTimer) clearTimeout(this.flushTimer);
    stdin.off("data", this.onData);
    stdout.off("resize", this.onResize);
    stdout.write("\x1b[?2004l\x1b[?1000l\x1b[?1006l\x1b[?2026l\x1b[?7h\x1b[?1049l");
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    this.resolveDone();
  }
}
