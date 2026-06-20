# lema — web search (DDG out of the box)

How lema gives a local model web access with **zero setup and zero API keys**. The scope
is deliberately narrow: one built-in backend (DuckDuckGo), designed for the way SLMs fail.
Anything fancier (Tavily, Brave, SerpAPI, …) is **not our job** — users add those later
through MCP. We own the default; MCP owns the upgrades.

## Thesis

- **Out of the box, no keys.** `lema` should search the web the moment it's installed. The
  only backend that needs no account and no key is DuckDuckGo's no-JS HTML endpoint, so
  that is the built-in.
- **SLMs are hurt by raw context.** Research (arXiv 2603.11513) shows sub-7B models fail
  extractive QA 85–100% of the time even with oracle retrieval, and dumping retrieved text
  *reverses* 42–64% of previously correct answers. So the tool returns **little, distilled**
  output — a handful of snippets — never raw HTML or full pages by default.
- **MCP is the extension point.** Keyed/commercial providers are a config + account burden
  we don't want to carry. lema already plans MCP support; that's where Tavily/Brave/etc.
  belong. We do not build provider adapters for them.

## Scope

In scope (this task):
- `web_search(query)` — DuckDuckGo HTML scrape via native `fetch`, returns 3–5 snippets.
- `web_fetch(url)` — read one page, extract main text, truncate. The two-step pattern.
- A feature flag so web tools don't bloat the always-on toolset (the 7±2 rule).
- Output discipline + caching + teaching errors.

Out of scope (explicitly):
- Tavily / Brave / SerpAPI / SearXNG adapters → users wire these via MCP later.
- A `SearchProvider` abstraction with multiple backends. **YAGNI** — there is exactly one
  backend (DDG). If MCP later needs an interface, we add it then, not now.

## How it actually works

No index of our own. `web_search` is one HTTP request to DuckDuckGo's no-JS results page,
then we parse the returned HTML:

```
GET https://html.duckduckgo.com/html/?q=<query>
```

1. `fetch` the URL with the query.
2. Response is an HTML results page.
3. Parse out the result blocks (`result__a` for title+href, `result__snippet` for text)
   with string/regex extraction — no DOM library (zero deps).
4. Return the top 3–5 as `title · url · snippet`.

This is scraping a public page, which is why no key is needed — and also why it's
**fragile**: DDG can change markup or serve a bot-challenge. The parser must degrade to a
teaching error, never crash.

`web_fetch` is the same idea for one URL: `fetch`, strip tags to readable text, cap length.

## Tool contracts

```ts
// web_search — find, return snippets (small, high-signal)
web_search(query: string): string
// → up to 5 lines:  "1. <title>\n   <url>\n   <snippet>"
// → "no results for <query>" | "ERROR: search blocked — retry later or give a URL to web_fetch"

// web_fetch — read ONE page, extracted + truncated
web_fetch(url: string): string
// → main text, capped (~2000 chars / configurable)
// → "ERROR: could not fetch <url> (HTTP nnn)"
```

Both follow the existing `Tool` contract ([tools/types.ts](../src/tools/types.ts)): return a
string, never throw past their own handler, teaching errors on failure.

## SLM-specific design (the point of the two-step split)

- `web_search` returns **only snippets**, never page bodies — the model first sees a cheap,
  small overview.
- The model decides if it needs more, then calls `web_fetch` on **one** chosen URL. Full
  text enters context only on demand, for a single page — this is the guard against the
  42–64% context-reversal finding.
- Hard caps on both (snippet count, fetch length) like `grep`/`read_file` already do.

## Placement & config

Web tools are **off by default** behind a flag, so they don't crowd the code toolset and
drop tool-selection accuracy on coding tasks (the 7±2 rule from [TOOLS.md](TOOLS.md)):

```jsonc
// lema.config.json
{ "tools": { "web": true } }   // default false
```

When off, `web_search`/`web_fetch` are not registered in `ALL_TOOLS`. When on, they join
the set. A small per-query cache (a few minutes) avoids re-hitting DDG — local models
re-ask, and DDG rate-limits scrapers.

## Implementation phases

### W0 — `web_search` (DDG)
- `src/tools/web.ts`: `fetch` the DDG HTML endpoint, parse result blocks, return top-5
  snippets. Zero deps, native `fetch`, string/regex parsing.
- Teaching errors for empty results and bot-challenge/blocked responses.
- Config flag `tools.web`; register conditionally in `ALL_TOOLS`.
- Tests: parser extracts title/url/snippet from a saved DDG HTML fixture; blocked/empty
  pages yield the teaching error (no network in tests — feed fixed HTML to the parser).

### W1 — `web_fetch`
- `fetch` one URL, strip to readable text, truncate to a configurable cap.
- Tests: tag-stripping + truncation against a fixed HTML string.

### W2 — caching + caps
- Short per-query in-memory cache; configurable result count and fetch length.

### (later, not this task) MCP backends
- Tavily/Brave/etc. arrive as MCP servers the user adds. No code here.

## Invariants (must hold; cover with tests)

- Zero runtime deps — `fetch` + string parsing only, no DOM/scrape library.
- `web_search` default output is bounded (≤5 snippets); `web_fetch` is length-capped.
- The HTML parser **never throws** — malformed/blocked pages return a teaching error.
- Web tools are absent from `ALL_TOOLS` unless `tools.web` is enabled.
- Parser tests run **offline** against fixed HTML; no live network in the suite.

## Open decisions

- **DDG endpoint drift.** `html.duckduckgo.com/html/` is unofficial; if it breaks we adjust
  the parser. Keep the parser isolated so a markup change is a one-file fix.
- **`web_fetch` extraction depth.** Naive tag-strip first; consider a readability-style
  main-content heuristic only if snippets+naive fetch prove insufficient.
- **Cache scope.** In-memory per session is enough to start; persist later only if needed.

## References

- Can Small Language Models Use What They Retrieve? (arXiv 2603.11513) — raw retrieved
  context reverses 42–64% of correct SLM answers; distill, don't dump.
- Claude Code has no built-in search — web access is MCP; mirrors our "default + MCP" split.
