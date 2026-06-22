# lema

**Agentic CLI for local LLMs.** Runs entirely on your machine — no cloud, no API keys.

Built for small models (4–14B). The harness does what the model can't: verifies output, remembers solved problems, and keeps long tasks on track.

```bash
npm install -g @iivgll4/lema
lema "refactor this module and run the tests"
```

> Works best with **LM Studio** + **Qwen3.5 9B (8-bit)** out of the box.

---

## Why lema

Small local models fail not because they lack knowledge — they fail because they:
- Don't know when they're wrong
- Reinvent what they've already solved
- Drift on long multi-step tasks

lema fixes this in the **harness**, not the model:

| Problem | lema's answer |
|---|---|
| Wrong output | Verification loop — runs your tests after every change |
| Repeating work | Skill memory — stores and recalls proven solutions |
| Context overflow | Auto-compaction — summarizes and continues instead of crashing |
| Slow reasoning | Effort dial — tune compute vs speed per task |

---

## Features

- **Real agent loop** — reads files, writes code, runs bash, searches the web, verifies
- **Web search** — built-in, no extra setup
- **Skill memory** — learns from completed tasks, retrieves by semantic similarity
- **Auto-compaction** — keeps long tasks alive when context fills up
- **Effort levels** — `low / medium / high / ultra` — controls reasoning depth per task
- **MCP server** — programmatic control via Model Context Protocol (`lema-mcp`)
- **TUI** — interactive alt-screen interface with live tool output
- **Zero runtime deps** — Node stdlib only
- **Open source** — MIT

---

## Requirements

- Node.js ≥ 20
- [LM Studio](https://lmstudio.ai) (or any OpenAI-compatible server)
- A loaded chat model + `text-embedding-nomic-embed-text-v1.5` for skill memory

**Tested models:**

| Model | Notes |
|---|---|
| `qwen/qwen3.5-9b` (8-bit) | Best overall — fast, accurate, handles long tasks |
| `qwen3-coder-30b` (iq2_xxs) | Slower, context-hungry; 9B 8-bit is better in practice |
| `qwen/qwen2.5-coder-14b` | Good fallback |

---

## Install

```bash
# Global install
npm install -g @iivgll4/lema

# One-off
npx @iivgll4/lema "explain this codebase"
```

---

## Usage

```bash
# One-shot task (agent loop)
lema "add input validation to the signup endpoint and run tests"

# Interactive chat (no tools)
lema chat

# TUI mode (full alt-screen interface)
lema

# Utilities
lema models       # list loaded models
lema skills       # show learned skill library
lema ping         # check LM Studio connection
```

### Effort levels

Control reasoning depth with `--effort` or set it in config:

```bash
lema --effort low   "summarize this file"          # fast, minimal reasoning
lema --effort high  "find and fix the race condition"  # slow, deep analysis
```

| Level | Best for |
|---|---|
| `low` | Quick lookups, summaries, simple edits |
| `medium` | Default — most coding tasks |
| `high` | Complex bugs, architecture decisions |
| `ultra` | Max reasoning, long multi-file refactors |

---

## Config

`lema.config.json` in your project root (all fields optional):

```json
{
  "baseUrl": "http://localhost:1234/v1",
  "model": "qwen/qwen3.5-9b",
  "effort": "medium",
  "maxSteps": 12,
  "temperature": 0.2
}
```

| Env var | Description |
|---|---|
| `LEMA_BASE_URL` | LM Studio URL (default: `http://localhost:1234/v1`) |
| `LEMA_MODEL` | Model to use |
| `LEMA_EMBED_MODEL` | Embedding model for skill memory |

---

## MCP Server

lema ships with an MCP server so tools like Claude Code can control it programmatically:

```bash
# Add to ~/.claude/settings.json or Claude Desktop config:
{
  "mcpServers": {
    "lema": {
      "command": "node",
      "args": ["/path/to/dist/mcp/index.js"],
      "env": { "LEMA_CWD": "/your/project" }
    }
  }
}
```

Available MCP tools: `lema_run`, `lema_abort`, `lema_stats`, `lema_context`, `lema_models`, `lema_set_model`, `lema_set_effort`, `lema_compact`, `lema_memory_search`.

---

## What works well right now

- **LM Studio + qwen3.5-9b (8-bit)** — the primary tested setup
- Single-repo coding tasks: refactor, bugfix, add feature, write tests
- Tasks with a clear verification command (`npm test`, `pytest`, `cargo test`)
- Multi-step tasks up to ~20 steps before context pressure

**Known limits:**
- Very large codebases (500+ files) hit context limits even with compaction
- Web search quality depends on the model's ability to synthesize results

---

## Development

```bash
git clone https://github.com/iivgll4/lema
npm install
npm run build
npm run dev -- "your task here"
```

---

## License

MIT — [iivgll4](https://github.com/iivgll4)
