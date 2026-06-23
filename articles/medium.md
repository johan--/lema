# Your local LLM isn't dumb. Your harness is.

A 9B model just fixed a bug that a 30B model couldn't finish. Same codebase, same prompt, same machine. The 30B had more parameters and worse results.

That result forced me to rethink what I'd been optimizing.

I'd spent months upgrading weights, tweaking quants, and shopping for bigger models — and the actual bottleneck was something I'd barely touched: the harness. The loop around the model. The thing that decides what the model sees, whether it checks its own output, and what it remembers from last time.

---

## The pattern I kept seeing

A 9B model tasked with "fix the failing tests in this repo" would typically:

1. Read the test file ✓
2. Read the source file ✓
3. Generate a fix that looked plausible ✓
4. Move on without running the tests ✗
5. Return an answer that was confidently wrong ✗

The model had the knowledge. It knew how to fix the issue. It just had no way to verify its own output. No feedback loop. No memory of what worked last time. No mechanism to stay on track across more than a few steps.

This isn't a model problem. It's a harness problem.

---

## What a harness actually does

When you run `claude` or `cursor` or any coding agent, there's a lot happening that isn't the model:

- Deciding which files to show the model
- Running the tests and feeding back the output
- Managing context so old turns don't crowd out recent ones
- Storing what worked before so the model doesn't reinvent it

None of that is intelligence. All of it determines whether the model's intelligence is useful.

A bad harness makes a smart model dumb. A good harness makes a small model punch above its weight.

---

## What I built

I built **lema** — an open source agentic CLI for local LLMs. The core loop is straightforward:

```
give model a task
→ model calls tools (read, write, bash, search)
→ if model touches files: run your test suite
→ if tests fail: feed output back, let model fix
→ repeat until passing or step budget exhausted
→ if red→green happened: record what worked as a memory
```

The verification loop is the main thing. The model stops guessing and starts knowing.

---

## The results are surprising

Testing against the same codebase with two models:

- `qwen3-coder-30B` (iq2_xxs quant, aggressive compression)
- `qwen3.5-9B` (8-bit quant, much higher quality)

The 30B is technically "smarter" by parameter count. But in practice the 9B with a good harness consistently outperformed it. The 30B would loop, repeat tool calls, lose track of what it had already done. The 9B would read, edit, verify, done.

Quantization quality matters more than raw size when the harness is doing the heavy lifting.

---

## The things that actually matter

**Verification.** Not "does the answer look right" but "does it pass the tests." Small models verify poorly in their head but well with actual output. So lema runs the check, not the model.

**Memory.** When a task completes after a test failure, lema stores a lesson — what the task was, what the check was, what the failure said. On similar future tasks it retrieves relevant lessons via embedding search before starting. The model reads them. It doesn't start from scratch.

**Context compaction.** Long tasks fill the context window. Most agents either crash or start hallucinating. lema auto-summarizes older turns and continues. 20-step tasks on a 9B model, no degradation.

**Project rules that stick.** Put an `AGENTS.md` in your repo root — coding conventions, architecture decisions, what to avoid. lema injects it at the start of context and re-injects a condensed version near the end, every few turns. Small models go blind to the middle of a long conversation; re-injection keeps the rules in the attention window where they actually matter.

**Effort dial.** Not every task needs deep reasoning. `--effort low` for quick lookups, `--effort high` for architecture decisions. This isn't just a prompt change — it scales the reasoning budget, step limits, and verification aggressiveness.

---

## The counterintuitive part about "thinking more"

My instinct when building this was: if the model is struggling, give it more reasoning budget. More tokens to think. Let it work through the problem.

That was wrong.

2026 research on small models documents **inverse scaling in test-time compute**: past a certain point, giving a small model more thinking budget makes it *worse*. It starts second-guessing correct answers, over-complicating simple tasks, spiraling on things it already knew.

So lema's effort dial is not "think more" — it's a preset of concrete parameters:

- `low` — half the step budget, "answer directly, minimize tool calls"
- `medium` — default, no steering
- `high` — double budget, "plan steps, verify with tools"
- `ultra` — triple the *steps*, not the tokens. More tool actions, not more thinking.

The distinction matters. For small models, running more tool-grounded verification rounds consistently outperforms giving the model more space to reason in its head. A model that runs the tests three times beats a model that thinks about the tests for three times as long.

---

## The things that actually matter

This doesn't make a 9B model into GPT-4. Complex multi-file refactors on large codebases still hit context limits. Web search quality depends on the model's synthesis ability. And some tasks just need a bigger model.

But for a substantial class of everyday coding tasks — fixing a bug, writing tests, adding a feature — a well-harnessed small local model works. No API key. No cloud. No cost per token.

---

## Try it

```bash
npm install -g @iivgll4/lema
lema "fix the failing tests in this repo"
```

Needs LM Studio running with a model loaded. Works with any OpenAI-compatible server.

The code is on GitHub, MIT licensed. If you try it and something doesn't work, open an issue.
