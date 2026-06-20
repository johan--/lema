import { stdin, stdout } from "node:process";
import * as ui from "../ui.js";
import { type ParsedKey, extractSequences, parseSeq } from "./input.js";
import { PasteBuffer, PASTE_START } from "./paste.js";
import { buildInputBox, matchCommands, type RenderState, type Overlay } from "./renderer.js";

export interface TuiCommand {
  name: string;
  desc: string;
  args?: string;
}

export interface TuiOptions {
  header: () => string[];
  commands: TuiCommand[];
  footerRight: () => string;
  placeholder: string;
  onSubmit: (line: string) => Promise<boolean>;
}

export class Tui {
  private state: RenderState = {
    buf: "", cursor: 0, selected: 0,
    status: null, spinFrame: 0, spinT0: 0, overlay: null,
  };
  private history: string[] = [];
  private histIdx: number | null = null;
  private busy = false;
  private spinTimer: ReturnType<typeof setInterval> | undefined;
  private scheduled = false;
  private done = false;
  private inbuf = "";
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private paste = new PasteBuffer();
  private resolveDone: () => void = () => {};
  /** How many terminal lines the input box currently occupies. */
  private lastInputH = 0;

  constructor(private opts: TuiOptions) {}

  // ---- public API ----------------------------------------------------------

  print(s: string): void {
    this.eraseInputBox();
    for (const line of s.split("\n")) stdout.write(line + "\n");
    this.drawInputBox();
  }

  setStatus(text: string | null): void {
    this.state.status = text;
    if (text && !this.spinTimer) {
      this.state.spinT0 = Date.now();
      this.spinTimer = setInterval(() => { this.state.spinFrame++; this.render(); }, 80);
    } else if (!text && this.spinTimer) {
      clearInterval(this.spinTimer);
      this.spinTimer = undefined;
    }
    this.schedule();
  }

  select(title: string, items: string[]): Promise<string | null> {
    if (!items.length) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.state.overlay = { title, items, selected: 0, resolve } as Overlay & { resolve(v: string | null): void };
      this.render();
    });
  }

  async run(): Promise<void> {
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    // Bracketed paste only; no alternate screen so terminal scrollback works normally.
    stdout.write("\x1b[?2004h");
    // Print header into the normal buffer.
    for (const line of this.opts.header()) stdout.write(line + "\n");
    stdin.on("data", this.onData);
    stdout.on("resize", this.onResize);
    this.drawInputBox();
    await new Promise<void>((res) => (this.resolveDone = res));
  }

  // ---- rendering -----------------------------------------------------------

  private eraseInputBox(): void {
    if (this.lastInputH === 0) return;
    // Move up to the first line of the input box and erase from there down.
    stdout.write(`\x1b[${this.lastInputH}A\x1b[J`);
    this.lastInputH = 0;
  }

  private drawInputBox(): void {
    const w = Math.max(stdout.columns || 80, 24);
    const { out, totalLines } = buildInputBox(this.opts, this.state, w);
    this.lastInputH = totalLines;
    stdout.write(out);
  }

  private render(): void {
    if (this.done) return;
    this.eraseInputBox();
    this.drawInputBox();
  }

  private schedule(): void {
    if (this.scheduled || this.done) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.render(); });
  }

  // ---- input ---------------------------------------------------------------

  private onResize = (): void => this.render();

  private onData = (chunk: string): void => {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    this.inbuf += chunk;
    this.drain();
  };

  private drain(): void {
    for (;;) {
      if (this.paste.active) {
        const content = this.paste.feed(this.inbuf);
        if (content === null) { this.inbuf = ""; return; }
        this.inbuf = "";
        if (!this.busy) { this.insert(this.paste.process(content)); this.render(); }
        continue;
      }
      const start = this.inbuf.indexOf(PASTE_START);
      if (start === -1) break;
      this.feedKeys(this.inbuf.slice(0, start));
      this.inbuf = this.inbuf.slice(start + PASTE_START.length);
      this.paste.startPaste();
    }
    const { sequences, remainder } = extractSequences(this.inbuf);
    this.inbuf = remainder;
    for (const seq of sequences) this.handleKey(parseSeq(seq));
    if (remainder === "\x1b") {
      this.flushTimer = setTimeout(() => {
        if (this.inbuf === "\x1b") { this.inbuf = ""; this.handleKey({ name: "escape" }); }
      }, 20);
    }
  }

  private feedKeys(segment: string): void {
    const { sequences } = extractSequences(segment);
    for (const seq of sequences) this.handleKey(parseSeq(seq));
  }

  private insert(s: string): void {
    const st = this.state;
    st.buf = st.buf.slice(0, st.cursor) + s + st.buf.slice(st.cursor);
    st.cursor += s.length;
  }

  private recallHistory(dir: number): void {
    if (!this.history.length) return;
    if (this.histIdx === null) this.histIdx = dir < 0 ? this.history.length - 1 : this.history.length;
    else this.histIdx = Math.max(0, Math.min(this.history.length, this.histIdx + dir));
    this.state.buf = this.histIdx >= this.history.length ? "" : this.history[this.histIdx];
    if (this.histIdx >= this.history.length) this.histIdx = null;
    this.state.cursor = this.state.buf.length;
  }

  private handleKey(key: ParsedKey): void {
    const st = this.state;

    if (st.overlay) {
      const ov = st.overlay as Overlay & { resolve(v: string | null): void };
      const n = ov.items.length;
      if (key.name === "up") ov.selected = (ov.selected - 1 + n) % n;
      else if (key.name === "down") ov.selected = (ov.selected + 1) % n;
      else if (key.name === "return") { st.overlay = null; ov.resolve(ov.items[ov.selected]); }
      else if (key.name === "escape" || (key.ctrl && key.name === "c")) { st.overlay = null; ov.resolve(null); }
      else return;
      return this.render();
    }

    if (this.busy) return;
    const ms = matchCommands(this.opts.commands, st.buf);

    if (key.name === "return") {
      if (ms.length) { st.buf = "/" + ms[st.selected].name; st.cursor = st.buf.length; }
      return void this.submit();
    }
    if (key.ctrl && key.name === "c") {
      if (st.buf) { st.buf = ""; st.cursor = 0; } else return this.teardown();
    } else if (key.ctrl && key.name === "d") {
      if (!st.buf) return this.teardown();
    } else if (key.name === "backspace") {
      if (st.cursor > 0) { st.buf = st.buf.slice(0, st.cursor - 1) + st.buf.slice(st.cursor); st.cursor--; }
    } else if (key.name === "left")  { if (st.cursor > 0) st.cursor--; }
    else if (key.name === "right")   { if (st.cursor < st.buf.length) st.cursor++; }
    else if (key.name === "home" || (key.ctrl && key.name === "a")) { st.cursor = 0; }
    else if (key.name === "end"  || (key.ctrl && key.name === "e")) { st.cursor = st.buf.length; }
    // up/down navigate command popup; without popup they scroll terminal natively (no interception needed)
    else if (key.name === "up")   { if (ms.length) st.selected = (st.selected - 1 + ms.length) % ms.length; else return; }
    else if (key.name === "down") { if (ms.length) st.selected = (st.selected + 1) % ms.length; else return; }
    // history via Ctrl+P / Ctrl+N
    else if (key.ctrl && key.name === "p") { this.recallHistory(-1); }
    else if (key.ctrl && key.name === "n") { this.recallHistory(1); }
    else if (key.name === "tab") {
      if (ms.length) { st.buf = "/" + ms[st.selected].name + " "; st.cursor = st.buf.length; st.selected = 0; }
    } else if (key.str && !key.ctrl && !key.meta && key.str >= " ") {
      this.insert(key.str);
    } else return;
    this.render();
  }

  private async submit(): Promise<void> {
    const st = this.state;
    const shown = st.buf.trim();
    const line = this.paste.expand(shown).trim();
    st.buf = ""; st.cursor = 0; st.selected = 0;
    this.histIdx = null;
    this.paste.clear();
    if (shown) {
      this.history.push(shown);
      this.print(ui.magenta("› ") + (shown.startsWith("/") ? ui.cyan(shown) : shown));
    }
    this.busy = true;
    this.render();
    let quit = false;
    try { quit = await this.opts.onSubmit(line); }
    catch (e) { this.print(ui.red("✗ ") + (e as Error).message); }
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
    this.eraseInputBox();
    stdout.write("\x1b[?2004l");
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    this.resolveDone();
  }
}
