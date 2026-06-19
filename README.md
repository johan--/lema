# lema

A local, self-improving agentic CLI for local LLMs.

`lema` runs entirely against your own machine (LM Studio, Ollama, llama.cpp — anything
OpenAI-compatible). It works in your repo, it chats, and — the point — it **grows its own
verified skills**: when it solves something and the result checks out, it stores that as a
reusable skill and recalls it next time instead of reinventing it.

> The name nods to *lemma*: a small, proven result you reuse to prove bigger ones.

## Why

Small local models don't fail for lack of knowledge — they fail because they don't know when
they're wrong, they reinvent solved problems, and they drift on long tasks. `lema` puts that
intelligence in the **harness**: a verification loop, an evolving playbook, and a skill memory.
For a 4–12B model, that's worth more than the next model up.

## Status

Early. Working today:

- OpenAI-compatible provider with auto model detection
- Agent loop with tools: `read_file`, `write_file`, `list_dir`, `bash`
- Skill memory: file-backed store with embedding retrieval (`text-embedding-nomic-embed-text-v1.5`)
- `chat`, `models`, `skills`, `ping` commands

Next: automatic skill creation after verified tasks, an evolving playbook, and a bench/autotuner.

## Install (dev)

```bash
npm install
npm run build
node dist/cli.js --help
# or during development:
npm run dev -- "list the files here and summarize the project"
```

## Usage

```bash
lema "add a /health route and a test, then run the tests"
lema chat
lema models
lema skills
lema ping
```

## Config

`lema.config.json` in your project root (all optional):

```json
{
  "baseUrl": "http://localhost:1234/v1",
  "model": "qwen/qwen3.5-9b",
  "temperature": 0.2,
  "maxSteps": 12
}
```

Or via env: `LEMA_BASE_URL`, `LEMA_MODEL`, `LEMA_EMBED_MODEL`.

## License

MIT
