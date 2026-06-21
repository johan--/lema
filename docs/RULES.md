# lema — project rules (AGENTS.md, kept in context)

How lema loads a project's rules file at session start and keeps a small local model
from forgetting it mid-conversation. Two jobs: **adopt the open standard** for the file,
and **fight lost-in-the-middle** so the rules actually stay in force.

## Thesis

- **Use the open standard, not a bespoke name.** `AGENTS.md` is the tool-agnostic format
  (OpenAI/Google, supported by Cursor, Aider, Codex, Gemini CLI, Zed, …). Adopting it
  means lema reads files projects already have. `CLAUDE.md` and `.lema/rules.md` are
  accepted as aliases so nothing is lost.
- **Loading once is not enough.** LLMs attend to the **start and end** of context and go
  blind in the middle. On a small window with masking, rules injected once at the top
  drift into that blind spot as the conversation grows. The fix is **re-injection**: keep
  the rules at the start *and* drop a condensed reminder near the end.
- **Rules must be SLM-shaped.** Short, imperative, positive. "Run tests with `npm test`"
  not "the project has tests"; "prefer X over Y" not "don't X" — weak models follow
  positive, concrete commands far more reliably than prohibitions.

## Distinction

The repo's own [CLAUDE.md](../CLAUDE.md) is rules for people *building lema*. This feature
is different: lema-the-tool reading a rules file in **whatever project a user runs it in**.

## Where we start

The system prompt is a single constant pushed once per session in
[agent/index.ts](../src/agent/index.ts); [ContextManager](../src/context/index.ts) owns the
live `messages[]`. There is no notion of project rules today. We add a loader and a
pinned-injection path; we don't rewrite the loop.

## File resolution

At session start, from the working directory, load the first that exists:

1. `AGENTS.md`  (the standard)
2. `CLAUDE.md`  (alias)
3. `.lema/rules.md`  (lema-local alias)

Root file only to start — nested/monorepo `AGENTS.md` (closest-file-wins) is a later phase.
An explicit user message always overrides the rules (standard precedence).

## Architecture

A new tiny module owns *finding and reading* the file; `ContextManager` owns *placing and
keeping* it. Single responsibility, and the agent loop stays unaware of the policy (DIP).

```
src/rules/
  load.ts   — locate + read the rules file (pure-ish: cwd -> {path, text} | null)
  index.ts  — barrel
```

```ts
// load.ts
export interface ProjectRules { path: string; text: string }
export function loadRules(cwd: string): ProjectRules | null;
```

### Pinned injection

`ContextManager` gains the idea of a **pinned** system message that masking and (future)
summarization must never evict:

```ts
class ContextManager {
  /** Add a system message that always survives compaction (rules, persona). */
  pushPinned(message: ChatMessage): void;
}
```

At session init the agent pushes `SYSTEM` (pinned), then the rules block (pinned) right
after it — the **start anchor**. Masking already only touches tool observations, so rules
are safe today; pinning guarantees they survive C1 summarization too.

### Re-injection (the anti-forgetting bit)

Before a model call, when the conversation has grown past a threshold, `render()` appends a
**condensed** rules reminder as the last system message — the **end anchor**. Cheap,
deterministic, no model call. Condense by taking the rules' headings / first line of each
bullet when the full text is long; use the full text when it's short.

Trigger (start simple): re-inject when `pressure() ≥ 0.5` **or** every N turns since the
last injection. Tunable in config.

## SLM-specific shaping

- The start anchor carries the **full** rules (within reason); the end anchor carries a
  **short** reminder (headings / critical lines) to spend few tokens on a small window.
- Cap the rules we inject (e.g. ~2k tokens) and warn if the file is larger — a 2,000-word
  dump degrades prioritisation for small models.

## Config

```jsonc
// lema.config.json
{
  "rules": {
    "enabled": true,        // default true
    "reinject": true,       // end-anchor reminder; default true
    "reinjectEvery": 6      // turns between reminders
  }
}
```

## Implementation phases

### R0 — load + start anchor (the 80/20)
- `src/rules/load.ts`: resolve `AGENTS.md` → `CLAUDE.md` → `.lema/rules.md`, read text.
- `ContextManager.pushPinned`; agent pushes `SYSTEM` then rules at init.
- A `/settings rules` line showing which file (if any) is active.
- Tests: resolution order; missing file → null; pinned message survives masking.

### R1 — re-injection (anti lost-in-the-middle)
- Condenser (headings / first bullet lines) + end-anchor append in `render()`.
- Config `rules.reinject` / `reinjectEvery`; threshold on `pressure()`.
- Tests: reminder appears after the threshold; condensed form for long files; the start
  anchor is never duplicated verbatim at the end.

### R2 — robustness & ergonomics
- Size cap + warning for oversized files.
- `/settings rules reload` to re-read without restarting.

### (later) R3 — nested AGENTS.md
- Closest-file-wins for monorepos; merge root + nearest.

## Invariants (must hold; cover with tests)

- Pinned messages (system + rules) survive every compaction stage.
- Rules load is best-effort: a missing/unreadable file never throws — lema runs without.
- `AGENTS.md` wins over `CLAUDE.md` wins over `.lema/rules.md`.
- Re-injection adds a *condensed* reminder, never a second full copy.
- Zero runtime deps; rules config merges like the other nested blocks in `config.ts`.

## Open decisions

- **Condensing strategy.** Headings-only is crude; may keep the first sentence of each
  top-level bullet. Start crude, refine on real files.
- **Re-inject cadence.** Pressure-based vs fixed turn count vs both. Begin with both,
  measure, simplify.
- **Token budget split.** How much of a small window rules may occupy before they crowd
  out the task — start at a soft ~2k cap, make it configurable.

## References

- [agents.md](https://agents.md/) — open standard; Markdown, no required fields,
  closest-file-wins, explicit prompt overrides.
- [Claude Code memory](https://code.claude.com/docs/en/memory) — rules layer + auto memory,
  load-at-start, periodic review.
- Lost-in-the-middle: LLMs attend to start/end, blind in the middle; mitigate by
  re-injecting instruction reminders (reprompting, arXiv 2403.05004).
- CLAUDE.md best practices (2026): short, stable, imperative; "prefer X over Y" beats
  "don't X" for reliable instruction following.
