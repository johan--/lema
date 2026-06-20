# lema — tool design (SLM-first)

How lema gives a small local model a toolset it can actually wield. The goal is
**maximum reliable capability from an SLM**, not the highest possible ceiling. We
optimise for the way 4–12B models fail, not the way frontier models succeed.

## Thesis

A small model is a child with sharp tools. You don't hand it thirty implements and a
twenty-blade knife — you hand it **a few simple, conventionally-named, hard-to-misuse
ones**. Three SLM failure modes drive every decision below:

- **Schema misalignment.** SLMs hallucinate a *plausible* tool/param name they saw in
  pretraining instead of the one in the schema. This is the #1 failure mode. Fix: name
  tools and arguments the way the model already expects (`grep`, `glob`, `edit`, `bash`).
  PA-Tool reports **+up to 17% accuracy, −80% misalignment errors** from renaming alone.
- **Tool-count degradation.** Selection accuracy collapses past ~5–10 tools. Keep the
  exposed set at **7±2**; cover the common needs so the model never *has* to improvise.
- **Weak multi-step planning + small context.** Verbose tool output is noise that breaks
  the next step. Every tool returns **little, high-signal** output by default.

So lema ships few tools, names them the boring/obvious way, keeps them quiet, and uses
constrained decoding to make malformed calls impossible.

## Where we start

Today there are four tools in [tools/index.ts](../src/tools/index.ts): `read_file`,
`write_file`, `list_dir`, `bash`. Four is *good* (the model doesn't drown), but coverage
gaps force the model into `bash` for navigation — which hides the problem and is a safety
hole. This is greenfield refinement, not a rewrite: same `Tool` interface, same `def()`
helper, same path-safety guard.

| Today | Problem under an SLM |
|-------|----------------------|
| `read_file` (whole file, 20k cap) | no range → whole file into context, fights masking |
| `write_file` (overwrite only) | edits force a full-file rewrite — costly and error-prone |
| *(no search)* | model uses `bash` grep/find for navigation |
| `bash` (unconstrained) | escape-hatch: model leaves structured tools, and it's unsafe |

## Decision

**JSON tools + LM Studio constrained decoding.** Not CodeAct — code-actions are stronger
on multi-step tasks (and especially for open models) but need a sandbox and a model that
writes decent code. Reliability beats ceiling here. We keep CodeAct in mind as a *later,
separate mode* for code-heavy tasks once a sandbox exists.

The target set is **seven tools**, named to match pretraining conventions:

| Tool | Job | SLM-specific design |
|------|-----|---------------------|
| `read_file(path, offset?, limit?, pattern?, context?)` | read | range or grep -C style match-windows — protects the context budget |
| `write_file(path, content)` | create / overwrite | `whole` format: the most reliable for weak models (Aider) |
| `edit_file(path, old, new)` | targeted change | search/replace for large files; cheaper than a rewrite |
| `grep(pattern, path?)` | find by content | takes navigation off `bash` |
| `glob(pattern)` | find by name | takes navigation off `bash` |
| `list_dir(path)` | look around | unchanged |
| `bash(command)` | run tests / build / git | **narrowed** to "execute", not "search/read" |

### Edit strategy (Aider's empirical policy)

`write_file` (whole) is the floor — always works for weak models. `edit_file`
(search/replace) is the efficient path for large files. Pick by file size: small files
get a whole rewrite, large files get search/replace. We do **not** ship `udiff` — it only
works for top-tier models.

## Cross-cutting principles (build into every tool)

1. **Conventional names** — the free PA-Tool win. Names and params are the obvious ones
   (`pattern`, `path`, `command`), never clever.
2. **Quiet, high-signal output** — sane default limits, truncation, and pagination so a
   result never floods the window. Stacks directly on the [context manager](CONTEXT.md).
3. **Errors that teach** — `ERROR: file not found: x → try grep 'x'`, not bare codes. The
   error tells the model its next move (SLMs self-correct poorly).
4. **`bash` is not a junk drawer** — with first-class `grep`/`glob`/`read`, the model has
   no reason to drop into the shell to read or search. Less escape-hatch = steadier
   structured tool-use.
5. **Grammar-enforced schemas** — LM Studio structured output / GBNF so a malformed tool
   call is physically impossible. This is our edge: cloud providers can't do it.

## What we are NOT doing now

- **CodeAct.** Later, as a separate mode for code tasks, once a sandbox exists.
- **Daily-use tools** (web, notes, scheduling). They bloat the set and tank SLM accuracy.
  When we add them, it's via **dynamic tool retrieval** (a large catalog, few tools in the
  model's view per task — the pattern this very CLI uses for deferred tools), not by
  dumping them into the always-on set.

## Implementation phases

### T0 — naming + read range (the 80/20, cheap)
- Rename existing tools/params to conventional forms; add `offset`/`limit` to `read_file`.
- Teaching error messages across all four tools.
- Tests: range read returns the requested span; errors carry an actionable hint.

### T1 — navigation tools
- `grep(pattern, path?)` and `glob(pattern)` with default result caps + pagination.
- Tests: results are capped and deterministic; no shell-out.

### T2 — targeted edits
- `edit_file(path, old, new)` (search/replace), with normalized/fuzzy whitespace matching.
- Size-based policy: whole vs search/replace.
- Tests: unique-match required; ambiguous match returns a teaching error, not a wrong edit.

### T3 — grammar-enforced schemas  ✅ (portability-only)
- Provider adds `strict:true` to tool schemas, probes once, and falls back + caches if
  the server rejects it ([grammar.ts](../src/models/grammar.ts), [base.ts](../src/models/base.ts)).
- **Verified on LM Studio: accepted but NOT enforced** for tool calls (an out-of-enum
  value slips through). It *is* enforced on llama.cpp (GBNF) and vLLM (guided decoding),
  so we keep it as free portability and lean on LM Studio's native parser there.
- **T3b (deferred): real constraint on LM Studio** would mean wrapping tool calls in
  `response_format: json_schema` (which *is* enforced) plus handling the reasoning-model
  `reasoning_content` quirk. Near-zero ROI today — our tool params are free-form strings
  (paths, regexes, shell, code) with no enums to constrain. Revisit only when a tool
  gains an enum or fixed-format param.

### T4 — dynamic retrieval + daily tools (= the breadth path)
- Tool catalog with top-k retrieval per task; daily-use tools land here, behind it.

## Invariants (must hold; cover with tests)

- Exposed tool count stays within 7±2; adding a tool means justifying the budget.
- Every tool's default output is bounded (cap/pagination); none can flood the window.
- Tool names/params use conventional, pretraining-aligned wording.
- Path safety holds: no tool escapes the working directory (`safe()` guard).
- `bash` is for execution only; reading/searching has first-class tools.
- Zero runtime deps; tool schemas remain the single source of truth (defined with the tool).

## Open decisions

- **Fuzzy matching for `edit_file`.** Exact match is brittle (SLMs flub whitespace);
  how much normalization before we risk a wrong edit? Start strict, loosen with evidence.
- **Size threshold** for whole-vs-search/replace — pick a default (e.g. ~100 lines),
  tune empirically.
- **Grammar availability.** Depends on the server; degrade gracefully to plain JSON
  tool-calling when GBNF isn't offered.

## References

- PA-Tool — *Don't Adapt Small Language Models for Tools; Adapt Tool Schemas to the
  Models* (arXiv 2510.07248). Schema misalignment; rename-for-pretraining wins.
- *Small Language Models for Efficient Agentic Tool Calling* (arXiv 2512.15943).
- Anthropic — *Writing tools for agents* (consolidation, namespacing, high-signal
  returns, response_format, token budget, teaching errors).
- Aider — *Code editing leaderboard* & *Edit formats* (whole vs diff vs udiff by model).
- CodeAct — *Executable Code Actions Elicit Better LLM Agents* (arXiv 2402.01030).
