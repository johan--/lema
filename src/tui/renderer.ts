import * as ui from "../ui.js";
import { vlen, wrap } from "./text.js";
import type { TuiCommand, TuiOptions } from "./index.js";

const MAX_POPUP = 6;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Overlay {
  title: string;
  items: string[];
  selected: number;
}

export interface RenderState {
  transcript: string[];
  buf: string;
  cursor: number;
  scroll: number;
  selected: number;
  status: string | null;
  spinFrame: number;
  spinT0: number;
  overlay: Overlay | null;
  wrapCache: { w: number; len: number; lines: string[] } | null;
}

export function matchCommands(commands: TuiCommand[], buf: string): TuiCommand[] {
  if (!buf.startsWith("/") || buf.includes(" ")) return [];
  const frag = buf.slice(1).toLowerCase();
  return commands.filter((c) => c.name.startsWith(frag)).slice(0, MAX_POPUP);
}

function buildInputLine(opts: TuiOptions, buf: string, cursor: number, w: number): { line: string; col: number } {
  const textArea = Math.max(1, w - 6);
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
  return { line: ui.magenta("│") + " " + ui.magenta("›") + " " + shown + pad + " " + ui.magenta("│"), col: 5 + curOff };
}

function buildFooter(opts: TuiOptions, scroll: number, w: number): string {
  const left = scroll > 0 ? " ↓ scroll down / PageDown for latest" : " ? for shortcuts · /exit to quit";
  let right = opts.footerRight() + " ";
  let pad = w - left.length - vlen(right);
  if (pad < 1) { right = right.slice(0, Math.max(0, w - left.length - 1)) + " "; pad = 1; }
  return ui.dim(left + " ".repeat(pad) + right);
}

function buildInputRegion(opts: TuiOptions, state: RenderState, w: number): { lines: string[]; inputOffset: number; col: number } {
  const lines: string[] = [];
  const ms = matchCommands(opts.commands, state.buf);
  const sel = Math.min(state.selected, Math.max(0, ms.length - 1));
  for (let i = 0; i < ms.length; i++) {
    const active = i === sel;
    const name = ("/" + ms[i].name).padEnd(12);
    lines.push("  " + (active ? ui.magenta("❯ ") : "  ") + (active ? ui.bold(name) : name) + ui.dim(ms[i].desc));
  }
  if (state.status) {
    const s = ((Date.now() - state.spinT0) / 1000).toFixed(1);
    lines.push("  " + ui.magenta(SPIN[state.spinFrame % SPIN.length]) + " " + ui.dim(`${state.status} ${s}s`));
  }
  if (state.overlay) {
    lines.push("  " + ui.dim(state.overlay.title));
    const items = state.overlay.items;
    const max = 8;
    const top = Math.max(0, Math.min(state.overlay.selected - (max >> 1), items.length - max));
    for (let i = top; i < Math.min(items.length, top + max); i++) {
      const active = i === state.overlay.selected;
      const label = items[i].length > w - 6 ? items[i].slice(0, w - 7) + "…" : items[i];
      lines.push("  " + (active ? ui.magenta("❯ ") + ui.bold(label) : "  " + ui.dim(label)));
    }
  }
  const dash = Math.max(0, w - 2);
  const { line: mid, col } = buildInputLine(opts, state.buf, state.cursor, w);
  const inputOffset = lines.length + 1;
  lines.push(ui.magenta("╭" + "─".repeat(dash) + "╮"), mid, ui.magenta("╰" + "─".repeat(dash) + "╯"), buildFooter(opts, state.scroll, w));
  return { lines, inputOffset, col };
}

/** Build a full frame and return the terminal escape sequence string to write. */
export function buildFrame(opts: TuiOptions, state: RenderState, w: number, rows: number): { out: string; bodyH: number } {
  const region = buildInputRegion(opts, state, w);
  const bodyH = Math.max(0, rows - region.lines.length);

  if (!state.wrapCache || state.wrapCache.w !== w || state.wrapCache.len !== state.transcript.length) {
    state.wrapCache = { w, len: state.transcript.length, lines: state.transcript.flatMap((l) => wrap(l, w)) };
  }
  const all = [...opts.header().flatMap((l) => wrap(l, w)), ...state.wrapCache.lines];
  const maxScroll = Math.max(0, all.length - bodyH);
  if (state.scroll > maxScroll) state.scroll = maxScroll;
  const end = all.length - state.scroll;
  const view = all.slice(Math.max(0, end - bodyH), end);
  const screen = [...view, ...Array(Math.max(0, bodyH - view.length)).fill(""), ...region.lines];

  let out = "\x1b[?2026h\x1b[?7l\x1b[H";
  for (let r = 0; r < screen.length; r++) {
    out += screen[r] + "\x1b[K";
    if (r < screen.length - 1) out += "\n";
  }
  out += "\x1b[J";
  out += `\x1b[${bodyH + region.inputOffset + 1};${region.col}H`;
  out += "\x1b[?7h\x1b[?2026l";
  return { out, bodyH };
}
