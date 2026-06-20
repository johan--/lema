export const ESC_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Visible length of a string, ignoring ANSI escape sequences. */
export function vlen(s: string): number {
  return s.replace(ESC_RE, "").length;
}

/** Hard-wrap a (possibly ANSI-styled) line to `width` visible columns. */
export function wrap(line: string, width: number): string[] {
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
