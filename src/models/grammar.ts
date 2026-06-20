import type { ToolSchema } from "./message.js";

/**
 * Add strict:true to every tool's function definition.
 * When the server honours this, tool-call JSON is constrained to the schema
 * by construction — malformed calls become physically impossible.
 *
 * Server support varies. llama.cpp (GBNF) and vLLM (guided decoding) enforce it.
 * LM Studio currently ACCEPTS the field but does NOT enforce it for tool calls
 * (verified: an out-of-enum value still slips through), so on that backend this
 * is a safe no-op and we lean on its native tool-call parser instead. The field
 * costs nothing and buys real constraint on the servers that do honour it.
 */
export function applyStrict(schemas: ToolSchema[]): ToolSchema[] {
  return schemas.map((s) => ({
    ...s,
    function: { ...s.function, strict: true },
  }));
}

/**
 * True when an error from the server indicates it rejected the strict field
 * (HTTP 400 or a message mentioning "strict"/"grammar"/"unsupported").
 * Any other error should propagate normally.
 */
export function isStrictRejection(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  // HTTP 400 on a chat/completions call with tools almost always means a bad
  // request body — the most likely cause being an unsupported field like strict.
  if (msg.includes("http 400")) return true;
  // Explicit mentions in server error text.
  return msg.includes("strict") || msg.includes("grammar") || msg.includes("unsupported");
}
