import * as ui from "../ui.js";
import { vlen } from "./text.js";
import type { TuiCommand, TuiOptions } from "./index.js";

const MAX_POPUP = 6;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Overlay {
  title: string;
  items: string[];
  selected: number;
}

export interface RenderState {
  buf: string;
  cursor: number;
  selected: number;
  status: string | null;
  spinFrame: number;
  spinT0: number;
  overlay: Overlay | null;
}

export function matchCommands(commands: TuiCommand[], buf: string): TuiCommand[] {
  if (!buf.startsWith("/") || buf.includes(" ")) return [];
  const frag = buf.slice(1).toLowerCase();
  return commands.filter((c) => c.name.startsWith(frag)).slice(0, MAX_POPUP);
}

export function buildInputLines(
  opts: TuiOptions,
  buf: string,
  cursor: number,
  w: number,
): { lines: string[]; cursorRow: number; cursorCol: number } {
  // first line has "› " prefix (2 chars), continuation lines have "  " (2 chars)
  // box frame takes 4 chars total: "│ " left + " │" right
  const textArea = Math.max(1, w - 6);

  if (buf.length === 0) {
    const shown = ui.dim(opts.placeholder.slice(0, textArea));
    const pad = " ".repeat(Math.max(0, textArea - Math.min(opts.placeholder.length, textArea)));
    return {
      lines: [ui.magenta("│") + " " + ui.magenta("›") + " " + shown + pad + " " + ui.magenta("│")],
      cursorRow: 0,
      cursorCol: 5,
    };
  }

  const chunks: string[] = [];
  let i = 0;
  while (i < buf.length) {
    chunks.push(buf.slice(i, i + textArea));
    i += textArea;
  }
  if (chunks.length === 0) chunks.push("");

  const cursorChunk = Math.floor(cursor / textArea);
  const cursorInChunk = cursor % textArea;

  const lines = chunks.map((chunk, idx) => {
    const prefix = idx === 0 ? ui.magenta("›") + " " : "  ";
    const pad = " ".repeat(Math.max(0, textArea - chunk.length));
    return ui.magenta("│") + " " + prefix + chunk + pad + " " + ui.magenta("│");
  });

  return {
    lines,
    cursorRow: cursorChunk,
    cursorCol: 5 + cursorInChunk,
  };
}

function buildFooter(opts: TuiOptions, w: number): string {
  const left = " Ctrl+P/N history · /exit to quit";
  let right = opts.footerRight() + " ";
  let pad = w - left.length - vlen(right);
  if (pad < 1) { right = right.slice(0, Math.max(0, w - left.length - 1)) + " "; pad = 1; }
  return ui.dim(left + " ".repeat(pad) + right);
}

/**
 * Build the input box region (command popup + spinner + box + footer).
 * Returns the escape sequence to write and how many terminal lines it occupies,
 * so the caller can erase exactly those lines before the next render.
 */
export function buildInputBox(
  opts: TuiOptions,
  state: RenderState,
  w: number,
): { out: string; totalLines: number } {
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
  const { lines: midLines, cursorRow, cursorCol } = buildInputLines(opts, state.buf, state.cursor, w);
  // inputOffset: row within `lines` where the cursor sits (after top border)
  const inputOffset = lines.length + 1 + cursorRow;
  lines.push(ui.magenta("╭" + "─".repeat(dash) + "╮"), ...midLines, ui.magenta("╰" + "─".repeat(dash) + "╯"), buildFooter(opts, w));

  // Build escape sequence: erase each line, then position cursor on input row
  let out = "\x1b[?2026h";
  for (let r = 0; r < lines.length; r++) {
    out += lines[r] + "\x1b[K";
    if (r < lines.length - 1) out += "\n";
  }
  // Move cursor back up to the input row and to the correct column
  const rowsBelow = lines.length - 1 - inputOffset;
  if (rowsBelow > 0) out += `\x1b[${rowsBelow}A`;
  out += `\x1b[${cursorCol}G`;
  out += "\x1b[?2026l";

  return { out, totalLines: lines.length };
}
