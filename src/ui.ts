const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const dim = c("2");
export const bold = c("1");
export const italic = c("3");
export const cyan = c("36");
export const green = c("32");
export const yellow = c("33");
export const red = c("31");
export const magenta = c("35");

let sink: ((s: string) => void) | null = null;

/** Redirect log output into a sink (the TUI captures the transcript this way). */
export function setSink(fn: ((s: string) => void) | null): void {
  sink = fn;
}

export const log = (s = ""): void => {
  if (sink) sink(s);
  else process.stdout.write(s + "\n");
};
export const step = (label: string, detail = "") => log(`${cyan("●")} ${bold(label)} ${dim(detail)}`);
export const tool = (name: string, detail: string) =>
  log(`  ${magenta("⏺")} ${bold(name)}${detail ? dim("(" + detail + ")") : ""}`);
/** The result line shown under a tool call (Claude-style ⎿ branch). */
export const toolResult = (text: string) => log(`  ${dim("⎿  " + text)}`);
export const ok = (s: string) => log(`${green("✓")} ${s}`);
export const warn = (s: string) => log(`${yellow("!")} ${s}`);
export const err = (s: string) => log(`${red("✗")} ${s}`);

export interface SpinHandle {
  stop(): void;
}

const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** A braille spinner with elapsed time, drawn in-place on the current line. */
export function spinner(label: string): SpinHandle {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return { stop() {} };
  let i = 0;
  const t0 = Date.now();
  const tick = () => {
    const s = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`\r${magenta(SPIN_FRAMES[i++ % SPIN_FRAMES.length])} ${dim(`${label} ${s}s`)}\x1b[K`);
  };
  tick();
  const timer = setInterval(tick, 80);
  return {
    stop() {
      clearInterval(timer);
      process.stdout.write("\r\x1b[K");
    },
  };
}
