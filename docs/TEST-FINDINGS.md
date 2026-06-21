# lema — live test findings (qwen3.5-9b, notes-api sandbox)

> **Status: all tickets fixed and re-validated live** (commits `faef9f1`, `f08f32d`).
> - F1 ✅ verify now runs on the maxSteps/repeat paths — the previously-broken 2-file
>   `auto` run now completes green (8/8) with `verified ✓`, no false success.
> - F2 ✅ (reworked) the "don't run tests" hint was ignored by the small model and was
>   wrong for diagnosis, so it was dropped; the double run is harmless (check is fast).
> - F3 ✅ lessons now fire by detecting red from the model's *own* bash test runs —
>   re-run of red→green recorded 1 lesson.
> - F4 ✅ tool-call markup stripped from final answers (validated: none leaked).
> - F5 ✅ plan wording tightened (still prompt-level; pinned checklist is future work).
> - F6 ✅ step labels (`● effort`, `● verify`) instead of always `skills`.
> - F7 ✅ blank-line spam removed.
> Also surfaced (infra, not lema): running two agents at once made LM Studio cancel a
> model load (HTTP 400) — validate sequentially, one agent per local model.

---


Ran the real model across all effort modes against `sandbox/notes-api` (isolated copies,
`npm test` as the check, `AGENTS.md` present). Six parallel runs. This is the punch list
of what to fix — ordered by severity.

## Results at a glance

| Mode | Task | Final state | Verify ran? | Notes |
|------|------|-------------|-------------|-------|
| low | "what routes does this API expose?" | ✅ correct answer | n/a (read-only) | fast, clean |
| medium | add `countNotes` + test | ✅ 7/7 green | no (model self-ran) | correct |
| high | add `removeNote` + tests | ✅ 9/9 green | ✅ `verified ✓` | correct |
| ultra | add `priority` + validation + tests | ✅ 9/9 green | ✅ `verified ✓` | correct; no visible plan |
| auto | `removeNote` + DELETE route + tests | ❌ **0/9, SyntaxError** | ❌ **never ran** | **false success** |
| redgreen | "make the failing tests pass" | ✅ 6/6 green | ✅ (saw green) | no lesson recorded |

The happy path (low/medium/high/ultra/redgreen) works well and produces correct, tested
code. The auto/2-file run exposed the important bugs.

## Issues (severity-ranked)

### F1 — Verify gate is bypassed on the maxSteps path ⛔ critical
`auto` (→high) thrashed on the 2-file task, duplicated `removeNote` (SyntaxError), hit the
step budget, and exited via `forceFinish` — which **does not run the verification gate**.
Result: lema reported "All tests pass" while `npm test` is red (0/9). A budget-exhausting
run can ship broken code with confident false success.
- Repro: `logs/auto.log` ends at maxSteps with a leaked tool-call and a success message;
  `t-auto` has `removeNote` declared twice.
- Fix: on the exhaustion path, if `dirty` and a verifier exists, **run the check** and
  fold the real status into the final answer (ideally allow one fix round). At minimum
  `forceFinish` must report red honestly — today `lastCheck` is null there because the
  gate never ran this session.

### F2 — Model and lema both run the tests (redundant) 🟠
On high/ultra/redgreen the model ran `bash npm test` itself, then lema ran `npm run test`
again via the gate — two full test runs per finish. Wasteful on a ~12 tok/s box.
- Repro: `logs/high.log` lines 29–31 (`→ bash npm test` then `→ verify npm run test`).
- Fix: when verification is enabled, add a system hint — "Do not run the tests yourself;
  lema runs them automatically before finishing." Removes the double run.

### F3 — Lessons (V3) almost never fire 🟠
Because the model self-runs and fixes tests *before* lema's gate sees red, lema always
observes green → `sawRedCheck` stays false → no lesson recorded. `redgreen` went red→green
but captured **0 lessons** (`t-redgreen/.lema/skills` empty).
- Root cause: same as F2 (model pre-fixes). Fixing F2 (lema owns the test run) makes lema
  the first to see red, so red→green lessons start firing.

### F4 — forceFinish can emit raw `<tool_call>` markup 🟠
`auto`'s final answer is a literal `<tool_call><function=bash>…` block. `forceFinish`
doesn't strip/parse tool-call text, so when the model tries to "call a tool" in its
tool-less final turn, the markup leaks into the answer.
- Fix: strip tool-call markup from `forceFinish` output (or run `parseTextToolCalls` and,
  if any are found, replace with an honest "couldn't finish cleanly" note).

### F5 — Plan (V2) has little visible effect 🟡
`ultra` produced no subgoal list; `auto` did (1/2 runs). The prompt-level plan is ignored
by this small model often. As-is it's near-noise.
- Fix options: make the plan a real first step (ask for subgoals, pin them as a checklist
  via the RULES.md machinery), or drop it until that lands. Currently over-promising.

### F6 — Step events mislabeled "skills" 🟡 cosmetic
Every `step` event renders as `● skills …` (e.g. `● skills effort: high (auto)`,
`● skills verified ✓`). The label is hard-coded.
- Repro: `consoleRenderer`/`tuiRenderer` map `step` → `ui.step("skills", …)`.
- Fix: carry a label on the event, or drop the fixed "skills" tag.

### F7 — Excessive blank lines in output 🟡 cosmetic
`consoleRenderer`'s `done` handler prints `"\n\n\n"`; transcripts have large vertical gaps.
- Fix: trim to a single separator.

## Suggested fix order
1. **F1** (correctness — false success on budget exhaustion) — must fix.
2. **F2 + F3** (one hint fixes both: lema owns the test run, lessons start firing).
3. **F4** (clean final answers).
4. **F5** (decide: real plan or drop).
5. **F6 / F7** (cosmetic).

## Notes that worked well (keep)
- `auto` correctly resolved heavy tasks to `high` (E2). ✅
- Verify gate correctly gated + reported `verified ✓` on clean finishes (high/ultra/redgreen). ✅
- Repeat guard fired on `auto` (`read_file (repeat — cached)`). ✅
- `redgreen` reasoned correctly that the *test* was wrong, not the code. ✅
- Rules (`AGENTS.md`) loaded; code respected the "pure logic in notes.js" convention. ✅
