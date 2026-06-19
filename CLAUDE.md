# lema — contributor & agent rules

`lema` is a local, self-improving agentic CLI for local LLMs. TypeScript + Node, zero runtime
deps. These rules are binding for every change (human or agent).

## Commits — Conventional Commits (required)

Every commit message MUST follow [Conventional Commits 1.0](https://www.conventionalcommits.org):

```
<type>(<optional scope>): <short imperative summary>

<optional body explaining the why>
<optional footer: BREAKING CHANGE:, Refs #123>
```

Allowed `type` values:

| type | when |
|------|------|
| `feat` | a new capability |
| `fix` | a bug fix |
| `refactor` | code change that neither fixes a bug nor adds a feature |
| `perf` | performance improvement |
| `docs` | documentation only |
| `test` | adding or fixing tests |
| `build` | build system, deps, tsconfig |
| `chore` | tooling/meta, no src behavior change |
| `style` | formatting only, no logic change |

Rules:
- Summary in the imperative mood, lower-case, no trailing period, ≤ 72 chars.
- One logical change per commit. Don't mix a refactor with a feature.
- Use a scope when it clarifies (`feat(skills):`, `fix(provider):`).
- Breaking changes: add `!` after type/scope **and** a `BREAKING CHANGE:` footer.

## Code — SOLID

- **S**ingle responsibility: one module = one job. `provider` talks to the API, `tools` execute
  side effects, `agent` orchestrates, `skills` persists memory. Don't blur these.
- **O**pen/closed: extend via new `Tool`s and new skill kinds, not by editing the loop. Adding a
  tool must not require changing `agent.ts`.
- **L**iskov: any `Tool` must be usable wherever a `Tool` is expected — same `run(args, ctx)`
  contract, returns a string, never throws past its own handler.
- **I**nterface segregation: keep interfaces small (`Tool`, `ChatMessage`). No god-objects.
- **D**ependency inversion: depend on abstractions. The agent takes a `Provider` and `Tool[]`;
  it never reaches for `fetch` or `fs` directly.

## Code — DRY

- No copy-pasted logic. Extract a helper the second time you'd duplicate something.
- Single source of truth for config (`config.ts`), tool schemas (defined with the tool), and the
  system prompt (one place in `agent.ts`).
- Reuse the provider/tool abstractions; don't re-implement HTTP or file IO inline.

## Conventions

- TypeScript strict. No `any` in public signatures (local casts in tool bodies are fine).
- Zero runtime dependencies — prefer the Node stdlib and native `fetch`.
- Small files, named exports, explicit return types on exported functions.
- Every change must pass `npm run build` (tsc) before commit.

## Build & check

```bash
npm run build        # tsc, must be clean
npm run dev -- ...    # run from source
```
