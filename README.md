# lema

Run local LLMs as a real coding agent — on your machine, with your code, no cloud.

lema wraps your local model (LM Studio, Ollama, llama.cpp) in an agent loop that actually works: it reads files, writes code, runs commands, searches the web, checks its own output, and remembers what it's already solved. Designed for small models — **4–14B runs well**.

```bash
npm install -g @iivgll4/lema
lema "fix the failing tests in this repo"
```

---

## The idea

Small local models aren't dumb — they just have no harness. They don't verify their own output. They forget what worked last time. They lose track on anything longer than a single file.

lema is the harness:

- **Verification loop** — after every change, it runs your tests. If they fail, it keeps going.
- **Skill memory** — when a task completes cleanly, lema stores the solution. Next time it searches its own library before starting from scratch.
- **Auto-compaction** — when context fills up mid-task, it summarizes and continues instead of crashing or hallucinating.
- **Effort dial** — `low / medium / high / ultra`. Tell it how hard to think.

---

## Quick start

You need [LM Studio](https://lmstudio.ai) running with a model loaded.

```bash
npm install -g @iivgll4/lema
lema ping              # check connection
lema models            # see what's loaded
lema "add a /health endpoint and write a test for it"
```

Or drop into the TUI for an interactive session:

```bash
lema
```

---

## Project rules

Put an `AGENTS.md` (or `CLAUDE.md`, or `.lema/rules.md`) in your project root and lema will read it automatically before every task — coding style, architecture decisions, what to avoid, anything you want the model to always know.

```markdown
# AGENTS.md

- All code must pass `npm test` before finishing
- Use TypeScript strict mode, no `any` in public signatures
- Commit messages follow Conventional Commits
```

lema injects the rules at the start of context and re-injects a condensed version every few turns so they don't get lost on long tasks.

---

## What it can do

**Agent tasks** — give it a goal, it figures out the steps:
```bash
lema "refactor auth.ts to use the new UserService interface"
lema "find what's causing the memory leak and fix it"
lema "write tests for every exported function in utils/"
```

**Web search** — built in, no setup:
```bash
lema "what changed in React 19 and do we need to update anything"
```

**Effort control** — faster or deeper depending on the task:
```bash
lema --effort low   "summarize this file"
lema --effort high  "find the race condition in the session handler"
```

**MCP server** — Claude Code and other MCP clients can control lema programmatically:
```bash
lema-mcp  # starts the MCP server
```

---

## TUI commands

Type `/` in the interactive session to see all commands:

| Command | What it does |
|---|---|
| `/compact [hint]` | Summarize and compress the conversation to free up context window |
| `/effort <level>` | Switch reasoning depth: `low` `medium` `high` `ultra` |
| `/remember <text>` | Save anything to memory — lema will recall it on relevant future tasks |
| `/memory [query]` | Search memory, or list everything if no query given |
| `/clear` | Clear the screen |
| `/models` | List loaded models, pick one interactively |
| `/skills` | Browse the skill library |
| `/skill new "<prompt>"` | Author a new reusable skill |
| `/settings web on\|off` | Toggle built-in web search |
| `/ping` | Check LM Studio connection |
| `/help` | Show all commands |
| `/exit` | Quit |

---

## Works best with

**LM Studio + `qwen/qwen3.5-9b` (8-bit)** — this is the primary tested setup. Fast, handles multi-step tasks, good at tool use.

Any OpenAI-compatible server works. The agent loop compensates a lot for model quality — a well-prompted 9B with verification often beats a raw 30B without it.

---

## Config

`lema.config.json` in your project root — all optional:

```json
{
  "model": "qwen/qwen3.5-9b",
  "effort": "medium",
  "baseUrl": "http://localhost:1234/v1"
}
```

Environment: `LEMA_BASE_URL`, `LEMA_MODEL`, `LEMA_EMBED_MODEL`.

---

## Skills

lema builds a skill library as it works. After a verified task it stores what it did:

```bash
lema skills          # browse the library
```

On future tasks it retrieves relevant skills before starting — so it doesn't reinvent the same solution twice.

---

## Development

```bash
git clone https://github.com/iivgll/lema
npm install
npm run dev -- "your task here"
npm run build
```

---

Open source · MIT · made for local models
