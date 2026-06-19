# lema — roadmap

A local, self-improving agentic CLI for local LLMs. Runs against any OpenAI-compatible
server (LM Studio, Ollama, llama.cpp). Works in your repo, chats, and grows its own
verified skills.

## Thesis

For small local models (4–12B), most capability lives in the **harness**, not the weights.
They don't lack knowledge — they don't know when they're wrong, they reinvent solved
problems, and they drift on long tasks. lema fixes that with three things: a verification
loop, an evolving playbook, and a skill memory.

## Strategy

We follow the cheap, proven path — **evolving context + skill library** — not self-rewriting
code:

- **Level 1 — evolving context** (ACE-style): the harness refines its own playbook after each task.
- **Level 2 — skill library** (MemSkill-style): verified solutions become reusable, retrieved skills.
- **Level 3 — self-modifying code** (Darwin Gödel Machine): out of scope; too heavy and
  reward-hacking-prone for local 4–12B models.

## Phases

### Phase 0 — foundation ✅
- npm package skeleton (TypeScript + Node, zero runtime deps).
- OpenAI-compatible provider with model auto-detection and embeddings.
- Agent loop over native function-calling with a verify-first system prompt.
- Tools: `read_file`, `write_file`, `list_dir`, `bash` (path-sandboxed).
- Skill store: file-backed JSON with nomic-embedding retrieval (save / search / record).
- CLI: `run`, `chat`, `models`, `skills`, `ping`.
- Project rules (Conventional Commits + SOLID + DRY) in CLAUDE.md.

### Phase 1 — close the verification loop (next)
- Explicit generate → verify → reflect → retry cycle with structured outcomes.
- Reflection pass on failure (cheap model) before retrying.

### Phase 2 — self-creating skills (the core bet)
- After a verified task, the agent proposes a skill (name, description, kind, body).
- Store it, embed it, and recall it on similar future tasks.
- Track success rate; prune skills that stop working.

### Phase 3 — evolving playbook
- Per-project + global `playbook.md`, append-only with dedup (ACE-lite).
- Curation pass that refines and merges entries.

### Phase 4 — bench & autotuner
- `lema bench`: pass@1 and tok/s across local models.
- `lema tune <model>`: sweep temperature / top_p, write results to config.

## Backlog / later
- Chat mode with optional tool access.
- Plugins and hooks for custom tools and verifiers.
- Multi-provider polish (Ollama, llama.cpp quirks).
- `lms` model load/unload orchestration (only one model fits in 16 GB at a time).

## Target rig

Apple M5 / 16 GB, LM Studio. One model in memory at a time. Current models:
`gemma-4-12b-coder`, `qwen3.5-9b`, `gemma-4-e4b`, plus `nomic-embed` for skill retrieval.
