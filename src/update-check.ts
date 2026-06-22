import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PACKAGE = "@iivgll4/lema";
const CACHE_FILE = join(homedir(), ".lema-update-check");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day

function currentVersion(): string {
  try {
    const pkg = new URL("../package.json", import.meta.url).pathname;
    return JSON.parse(readFileSync(pkg, "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
}

function readCache(): { checkedAt: number; latest: string } | null {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(latest: string): void {
  try {
    writeFileSync(CACHE_FILE, JSON.stringify({ checkedAt: Date.now(), latest }));
  } catch {}
}

function isNewer(latest: string, current: string): boolean {
  const p = (v: string) => v.split(".").map(Number);
  const [la, lb, lc] = p(latest);
  const [ca, cb, cc] = p(current);
  return la > ca || (la === ca && lb > cb) || (la === ca && lb === cb && lc > cc);
}

/** Fire-and-forget — never throws, never blocks startup. */
export function checkForUpdate(): void {
  const current = currentVersion();
  const cache = readCache();

  // If cached result is fresh enough, use it immediately
  if (cache && Date.now() - cache.checkedAt < CHECK_INTERVAL_MS) {
    if (isNewer(cache.latest, current)) notify(cache.latest, current);
    return;
  }

  // Otherwise fetch in background — don't await
  fetch(`https://registry.npmjs.org/${PACKAGE}/latest`, { signal: AbortSignal.timeout(4000) })
    .then((r) => r.json())
    .then((json) => {
      const latest = String((json as { version: string }).version ?? "");
      if (!latest) return;
      writeCache(latest);
      if (isNewer(latest, current)) notify(latest, current);
    })
    .catch(() => {});
}

function notify(latest: string, current: string): void {
  process.stderr.write(
    `\n  Update available: ${current} → \x1b[32m${latest}\x1b[0m\n` +
    `  Run \x1b[36mnpm install -g ${PACKAGE}\x1b[0m to upgrade\n\n`
  );
}
