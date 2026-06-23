# 9B at 8-bit beat 30B at iq2_xxs on every task. Quant quality matters more than parameters when the harness is right.

**r/LocalLLaMA**

---

Ran the same coding tasks on qwen3.5-9B (8-bit) and qwen3-coder-30B (iq2_xxs) using a local agent harness I've been building. Results were not what I expected:

- 30B: 20-26 steps, loses track mid-task, repeats tool calls, confident wrong answer
- 9B: 2-4 steps, reads → edits → verifies → done

The 30B has more parameters. The aggressive quant wrecks its reasoning quality to the point where a well-quantized 9B just runs circles around it when the harness is actually doing its job.

The harness is **lema** — open source agent CLI for local LLMs. The three things it adds that made the difference:

**Verification loop** — after every code change, it runs your test suite. If tests fail, the output goes back to the model with "fix this." It loops until they pass. Model doesn't decide if it's done — the tests do.

**Memory** — when a task goes red→green (fails tests then fixes them), lema stores the lesson. Next similar task, it retrieves relevant lessons via embedding search before starting. Stops reinventing solutions.

**Auto-compaction** — when the context fills up mid-task, it summarizes old turns and keeps going instead of degrading or crashing.

---

**The 9B vs 30B thing:**

Testing on the same codebase:
- `qwen3-coder-30B` at `iq2_xxs` quant: 20-26 steps, medium accuracy, loses track, repeats tool calls
- `qwen3.5-9B` at `8-bit` quant: 2-4 steps, high accuracy, reads → edits → verifies → done

The 30B has more parameters but the aggressive quantization wrecks reasoning quality. The 9B with a normal quant and a decent harness just... works. Quant quality matters more than model size when the scaffolding is doing its job.

---

**A few things I learned building this:**

- Naming tools to match pretraining conventions (grep, glob, bash, read_file) gives +17% accuracy with no model changes. Schema misalignment — the model hallucinating a plausible tool name — is the #1 SLM failure mode. PA-Tool paper documents this.
- Masking old tool outputs (replacing them with a one-line placeholder) is 52% cheaper than summarizing and actually more accurate. lema masks first, summarizes only when context hits ~85%.
- Small models have inverse scaling for thinking time — more reasoning budget past a point makes them *worse*. The effort dial in lema controls step count and verification rounds, not token budget for thinking.
- Re-inject your project rules at the end of context, not just the start. Models go blind in the middle of long conversations.

---

**Quick start:**

```bash
npm install -g @iivgll4/lema
# needs LM Studio running with a model loaded
lema "fix the failing tests in this project"
```

Works with any OpenAI-compatible server. Zero cloud, zero API keys, zero cost per token.

There's also a `/remember` command in the TUI to manually save things to memory, and `AGENTS.md` support if you want to give it persistent project-level instructions.

GitHub: https://github.com/iivgll/lema — MIT, TypeScript, zero runtime deps.

Happy to answer questions. The verification loop and memory retrieval are the most interesting parts technically — ask if you want to dig in.

---

**edit:** yes it works with Ollama, just set `LEMA_BASE_URL=http://localhost:11434/v1`

**edit 2:** the `reasoning_content` thing trips people up — LM Studio with thinking models returns `content: ""` and puts everything in `reasoning_content`. lema handles it but it was a fun bug to find via direct curl.
