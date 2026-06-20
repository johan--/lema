/** A normalized key/mouse event parsed from a raw stdin sequence. */
export interface ParsedKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  str?: string;
  /** SGR/X10 mouse button byte (Cb); present for mouse events. */
  mouse?: number;
}

/**
 * stdin arrives in partial chunks, so escape sequences (especially mouse) can be
 * split across data events. We buffer and only emit COMPLETE sequences — the same
 * approach pi/OpenTUI use. Using readline's keypress here would mangle mouse input.
 */
function isComplete(data: string): "complete" | "incomplete" | "not-escape" {
  if (data[0] !== "\x1b") return "not-escape";
  if (data.length === 1) return "incomplete";
  const a = data[1];
  if (a === "[") {
    if (data[2] === "M") return data.length >= 6 ? "complete" : "incomplete"; // X10 mouse
    if (data.length < 3) return "incomplete";
    const last = data.charCodeAt(data.length - 1);
    return last >= 0x40 && last <= 0x7e ? "complete" : "incomplete"; // CSI final byte
  }
  if (a === "O") return data.length >= 3 ? "complete" : "incomplete"; // SS3
  return "complete"; // ESC + single char (meta)
}

export function extractSequences(buffer: string): { sequences: string[]; remainder: string } {
  const sequences: string[] = [];
  let pos = 0;
  while (pos < buffer.length) {
    const rem = buffer.slice(pos);
    if (rem[0] !== "\x1b") {
      sequences.push(rem[0]);
      pos++;
      continue;
    }
    let end = 1;
    for (; end <= rem.length; end++) {
      if (isComplete(rem.slice(0, end)) === "complete") break;
    }
    if (end > rem.length) return { sequences, remainder: rem }; // wait for more bytes
    sequences.push(rem.slice(0, end));
    pos += end;
  }
  return { sequences, remainder: "" };
}

export function parseSeq(seq: string): ParsedKey {
  const sgr = seq.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
  if (sgr) return { mouse: parseInt(sgr[1], 10) };
  if (seq.startsWith("\x1b[M")) return { mouse: seq.charCodeAt(3) - 32 };

  if (seq.length === 1) {
    const code = seq.charCodeAt(0);
    if (seq === "\r" || seq === "\n") return { name: "return" };
    if (seq === "\x7f" || seq === "\b") return { name: "backspace" };
    if (seq === "\t") return { name: "tab" };
    if (seq === "\x1b") return { name: "escape" };
    if (code === 1) return { name: "a", ctrl: true };
    if (code === 3) return { name: "c", ctrl: true };
    if (code === 4) return { name: "d", ctrl: true };
    if (code === 5) return { name: "e", ctrl: true };
    if (code < 32) return {};
    return { str: seq };
  }

  if (seq.startsWith("\x1b[") || seq.startsWith("\x1bO")) {
    const body = seq.slice(2);
    const exact: Record<string, string> = {
      A: "up", B: "down", C: "right", D: "left", H: "home", F: "end",
      "1~": "home", "4~": "end", "5~": "pageup", "6~": "pagedown", "3~": "delete",
    };
    if (exact[body]) return { name: exact[body] };
    const fin = seq[seq.length - 1];
    const arrows: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
    if (arrows[fin]) return { name: arrows[fin] };
    return {};
  }
  if (seq.length === 2) return { meta: true, str: seq[1] };
  return {};
}
