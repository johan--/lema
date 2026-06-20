const PASTE_LINE_LIMIT = 1;
const PASTE_CHAR_LIMIT = 200;

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

/** Manages bracketed-paste accumulation and placeholder expansion. */
export class PasteBuffer {
  private pasting = false;
  private buf = "";
  private store = new Map<number, string>();
  private counter = 0;

  get active(): boolean {
    return this.pasting;
  }

  /** Feed raw input; returns paste content when a block closes, null while accumulating. */
  feed(chunk: string): string | null {
    this.buf += chunk;
    const end = this.buf.indexOf(PASTE_END);
    if (end === -1) return null;
    const content = this.buf.slice(0, end);
    this.buf = this.buf.slice(end + PASTE_END.length);
    this.pasting = false;
    return content;
  }

  startPaste(): void {
    this.pasting = true;
    this.buf = "";
  }

  /** Clean paste content and return inline text or a placeholder marker. */
  process(raw: string): string {
    const text = raw
      .replace(/\r\n?/g, "\n")
      .replace(/\t/g, "  ")
      .split("")
      .filter((c) => c === "\n" || c.charCodeAt(0) >= 32)
      .join("");
    const lines = text.split("\n");
    if (lines.length > PASTE_LINE_LIMIT || text.length > PASTE_CHAR_LIMIT) {
      const id = ++this.counter;
      this.store.set(id, text);
      return lines.length > 1
        ? `[paste #${id} +${lines.length} lines]`
        : `[paste #${id} ${text.length} chars]`;
    }
    return text;
  }

  /** Expand `[paste #N …]` placeholders back to their original content. */
  expand(line: string): string {
    return line.replace(/\[paste #(\d+) (?:\+\d+ lines|\d+ chars)\]/g, (m, id) => {
      return this.store.get(Number(id)) ?? m;
    });
  }

  clear(): void {
    this.store.clear();
  }
}
