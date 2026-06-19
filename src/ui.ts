const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const dim = c("2");
export const bold = c("1");
export const cyan = c("36");
export const green = c("32");
export const yellow = c("33");
export const red = c("31");
export const magenta = c("35");

export const log = (s = "") => process.stdout.write(s + "\n");
export const step = (label: string, detail = "") => log(`${cyan("●")} ${bold(label)} ${dim(detail)}`);
export const tool = (name: string, detail: string) => log(`  ${magenta("→")} ${name} ${dim(detail)}`);
export const ok = (s: string) => log(`${green("✓")} ${s}`);
export const warn = (s: string) => log(`${yellow("!")} ${s}`);
export const err = (s: string) => log(`${red("✗")} ${s}`);
