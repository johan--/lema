# lema — reliability engine: integration plan

How the verify/plan/learn engine ([RELIABILITY.md](RELIABILITY.md)) fits the features we
already shipped — what changes, what is removed, how it activates, and how it stays stable
in a real project. This is the "think first, remove objections" pass before any code.

## Goals & constraints

- **No feature fights another.** The new loop must subsume overlapping behaviour, not run
  beside it.
- **Adaptive, not a pile of switches.** Activation rides one knob the user already has.
- **Stable in a real repo.** Never runs a guessed command; bounded; degrades to today's
  behaviour when nothing is configured/discoverable.
- **SLM-first.** Each piece converts a known small-model weakness into a tool/memory-backed
  strength, and never crowds a small context window.

## Conflict map (existing ↔ new) and resolutions

| # | Existing feature | New feature | Conflict | Resolution |
|---|------------------|-------------|----------|------------|
| C1 | ultra `verify` gate (prompt nudge, model self-verifies) | V1 verification loop | Both "verify": redundant + contradictory | **Replace** the nudge gate with V1. `EffortProfile.verify` now means "run the real check," not "ask the model." |
| C2 | graceful finish (`forceFinish` on budget/repeat) | V1 gate | Could report "done" while tests are red | `forceFinish` takes the **last check status**; on exhaustion it reports honestly ("tests still failing: …"), never a false success |
| C3 | repeat guard (dedupe read-only calls) | V1 re-runs `npm test` each round | lema's check isn't a model tool-call → not deduped (fine). Risk: model *also* runs `bash test` | Hint: "lema runs the tests after you finish — don't run them yourself." No dedupe change |
| C4 | RULES.md pinned + re-inject (planned) | V2 plan checklist, V3 lessons | 4 preamble sources (rules/plan/lessons/skills) crowd a small window | One **preamble budget** in `ContextManager`, priority rules > plan > lessons > skills, truncate to fit |
| C5 | skills recall (top-k, kind=skill) | V3 lessons (kind=lesson) | Lessons compete with skills for recall slots | Unify: recall ranks all kinds; reserve ≤1 slot for a lesson so skills aren't starved |
| C6 | effort dial (low/med/high/ultra/auto) | all three | When do they turn on? | Activation is **derived from effort** (below), not separate toggles |

### What gets changed / removed
- **Removed:** the prompt-only ultra verify nudge in the agent loop (folded into V1).
- **Changed:** `forceFinish` signature gains last-check status; `EffortProfile.verify`
  semantics shift from "nudge" to "run check"; `ContextManager` gains a preamble budget;
  `SkillStore` recall becomes kind-aware (reserve a lesson slot).
- **Kept as-is:** graceful finish, repeat guard, text-tool-call recovery, masking,
  web flag, the effort dial itself. They are orthogonal safety/plumbing.

## Activation model — the key decision

Options, scored by the criteria that matter here:

| Option | Predictability | SLM benefit | Simplicity | Stability | Config burden |
|--------|---------------|-------------|-----------|-----------|---------------|
| **O1 Always on** | low (surprise test runs) | high | high | low | none |
| **O2 Three independent toggles** | med | high | low (2³ combos) | med | high |
| **O3 Derived from effort (+ escape hatch)** ✅ | high | high | high | high | low |
| **O4 Fully autonomous per-task** | low | high | med | low | none |

**Chosen: O3 — activation is a function of the effort level**, with a single config escape
hatch for power users. Effort already means "how hard should I work," so reliability riding
it is intuitive, and `auto` effort makes it per-task adaptive for free. No 2³ toggle matrix.

Default activation by level:

| effort | verify (V1) | plan (V2) | learn (V3) |
|--------|-------------|-----------|------------|
| low | off | off | off |
| medium | **off** (configurable on) | off | on if a verify ran |
| high | on | on | on |
| ultra | on (bounded, more rounds) | on | on |
| auto | per task → maps to the row it picks | " | " |

Escape hatch (rare overrides), merged like other nested config:

```jsonc
// lema.config.json
{
  "check": "npm test",                  // explicit check command (else auto-discovered)
  "reliability": { "verify": "auto" }   // "auto" (follow effort) | "on" | "off"
}
```

Learn (V3) is not a user toggle — it's a cheap byproduct that only fires on a real
red→green, so it has nothing to "turn on."

## Unified loop (how it all runs in order)

Per task, inside `runAgent`:

1. **Resolve effort → profile**, including `verify`/`plan` flags (O3 mapping).
2. **Plan (V2)** if `plan`: model emits 2–5 subgoals → pinned checklist (preamble budget).
3. **Act loop** (unchanged): tools run; `write_file`/`edit_file` set a `dirty` flag.
4. **Finish attempt** (model returns no tool calls):
   - if `verify` **and** `dirty` **and** a check command exists →
     **run the check** (V1):
     - green → accept; if this run went red→green, **record a lesson (V3)**.
     - red → push failure output as a tool result, continue the loop (bounded rounds).
   - else → accept (nothing to verify, e.g. a Q&A task).
5. **Exhaustion** (maxSteps / repeat budget / verify rounds): `forceFinish` reports the
   **honest last status** (incl. red tests), never a false "done."

This makes the ultra gate a special case of step 4 — one consistent path, not two.

## Stability in a real project (objections removed)

- **Never guesses commands.** V1 only runs a command from `lema.config.json` `check`, or a
  discovered `package.json` script / Makefile target. No command found → behaves exactly
  like today (the new path is a no-op).
- **Only verifies real changes.** Gated on the `dirty` flag, so Q&A and read-only tasks
  never trigger a test run.
- **Bounded.** Verify-fix rounds capped (e.g. 3); shares the overall `maxSteps` budget so
  it can't run forever; honest failure on exhaustion.
- **Time/again safety.** The check runs through the existing `bash` plumbing (timeout,
  buffer cap). A hanging test suite is bounded by that timeout.
- **Context safety.** Preamble budget guarantees rules+plan+lessons+skills can't evict the
  task on a small window.
- **Reversible & off-able.** `reliability.verify: "off"` returns lema to current behaviour
  entirely.

## Phasing (re-scoped around integration)

- **P1 — refactor groundwork** ✅ — `EffortProfile.verify` now means "run the check";
  `forceFinish` carries honest check status; `dirty` flag added; ultra prompt-nudge retired.
- **P2 — V1 verification loop** ✅ — `src/verify/check.ts` (discover + run), gate wired into
  the finish branch, config `check` + `reliability.verify`, bounded rounds, honest exhaustion.
- **P3 — preamble cap** ✅ (pragmatic) — recalled skills/lessons bodies are char-capped so
  they can't crowd a small window. A fuller `ContextManager` preamble budget lands with
  RULES.md.
- **P4 — V2 plan** ✅ (prompt-level) — high/ultra prompt the model to list subgoals up
  front. The pinned re-injected checklist arrives with RULES.md's pinned machinery.
- **P5 — V3 lessons** ✅ — a red→green outcome is saved as a `lesson` skill and recalled
  like any skill on similar tasks.

Shipped together. P3/P4 are in their pragmatic form now; their heavier versions (a real
context preamble budget, a pinned re-injected checklist) ride the RULES.md work when it lands.

## Invariants (must hold; cover with tests)

- Exactly one verification path: the ultra prompt-nudge no longer exists.
- Success is reported only on green **or** nothing-to-verify; exhaustion is honest.
- Verification only runs a configured/discovered command, only when `dirty`.
- Preamble (rules+plan+lessons+skills) is budget-capped; the task is never evicted by it.
- `reliability.verify: "off"` ⇒ byte-for-byte today's behaviour.
- Zero runtime deps; reliability config deep-merges like `context`/`tools`.

## Open decisions

- **Discovery precedence** when several scripts exist (test vs build vs lint): start with
  `test`, let `check` config widen.
- **Round cap vs maxSteps**: a dedicated `verifyRounds` (default 3) vs sharing maxSteps —
  start with a small dedicated cap inside the shared budget.
- **Medium default**: verify off (speed) vs on (safety). Start off; revisit once V1 is
  proven cheap on real repos.
