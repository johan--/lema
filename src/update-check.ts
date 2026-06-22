import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PACKAGE = "@iivgll4/lema";
const CACHE_FILE = join(homedir(), ".lema-update-check");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

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

function notify(latest: string, current: string): void {
  const line1 = `  Update available  ${current} → \x1b[32m${latest}\x1b[0m`;
  const line2 = `  Run \x1b[36mlema update\x1b[0m to upgrade`;
  process.stdout.write(`\n${line1}\n${line2}\n\n`);
}

/**
 * Step 1 — call synchronously at startup.
 * Reads cache only (0ms). Prints notice immediately if update is known.
 */
export function checkForUpdateSync(): void {
  const cache = readCache();
  if (!cache) return;
  if (Date.now() - cache.checkedAt >= CHECK_INTERVAL_MS) return; // stale — background will refresh
  const current = currentVersion();
  if (isNewer(cache.latest, current)) notify(cache.latest, current);
}

/**
 * Step 2 — call fire-and-forget after startup.
 * Fetches from npm registry in background, writes cache for next run.
 * Never blocks, never throws.
 */
export function fetchUpdateInBackground(): void {
  const cache = readCache();
  if (cache && Date.now() - cache.checkedAt < CHECK_INTERVAL_MS) return; // still fresh

  fetch(`https://registry.npmjs.org/${PACKAGE}/latest`, { signal: AbortSignal.timeout(4000) })
    .then((r) => r.json())
    .then((json) => {
      const latest = String((json as { version?: string }).version ?? "");
      if (latest) writeCache(latest);
    })
    .catch(() => {});
}
