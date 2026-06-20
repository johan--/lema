import type { ChatMessage, Usage } from "./message.js";
import type { ChatOptions, ChatResult, EmbedOptions } from "./chat.js";
import type { ModelProvider } from "./provider.js";
import { applyStrict, isStrictRejection } from "./grammar.js";

export class BaseProvider implements ModelProvider {
  /**
   * Tri-state: undefined = not probed yet, true = strict supported,
   * false = server rejected strict (fall back to plain tool calling).
   */
  private strictSupported: boolean | undefined = undefined;

  constructor(
    private cfg: {
      baseUrl: string;
      model?: string;
      embedModel: string;
      temperature: number;
      maxTokens: number;
    },
  ) {}

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<any> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${path} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    return res.json();
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.cfg.baseUrl}/models`);
    if (!res.ok) throw new Error(`/models -> HTTP ${res.status}`);
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    return (json.data ?? []).map((m) => m.id);
  }

  async resolveModel(): Promise<string> {
    if (this.cfg.model) return this.cfg.model;
    const models = await this.listModels();
    const chat = models.find((m) => !/embed/i.test(m));
    if (!chat) throw new Error("No chat model available from the server.");
    return chat;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const model = opts.model ?? await this.resolveModel();
    const base: Record<string, unknown> = {
      model,
      messages,
      temperature: opts.temperature ?? this.cfg.temperature,
      max_tokens: opts.maxTokens ?? this.cfg.maxTokens,
    };

    if (!opts.tools?.length) {
      const json = await this.post("/chat/completions", base, opts.signal);
      return { message: json.choices[0].message as ChatMessage, usage: json.usage as Usage };
    }

    // With tools: try strict constrained decoding first (T3).
    // On first call strictSupported is undefined → attempt strict.
    // If the server rejects it (HTTP 400 / error mentioning "strict"), fall back
    // to plain tool calling and cache the result for the rest of the session.
    const useStrict = this.strictSupported !== false;
    const tools = useStrict ? applyStrict(opts.tools) : opts.tools;

    try {
      const json = await this.post(
        "/chat/completions",
        { ...base, tools, tool_choice: "auto" },
        opts.signal,
      );
      if (useStrict) this.strictSupported = true;
      return { message: json.choices[0].message as ChatMessage, usage: json.usage as Usage };
    } catch (err) {
      if (useStrict && isStrictRejection(err)) {
        // The error looks like a bad request — maybe strict was the cause. Retry
        // once without it. Only cache strictSupported=false if the retry actually
        // succeeds; if it fails too, strict wasn't the problem, so rethrow without
        // disabling strict for the rest of the session.
        const json = await this.post(
          "/chat/completions",
          { ...base, tools: opts.tools, tool_choice: "auto" },
          opts.signal,
        );
        this.strictSupported = false;
        return { message: json.choices[0].message as ChatMessage, usage: json.usage as Usage };
      }
      throw err;
    }
  }

  async embed(texts: string[], opts: EmbedOptions = {}): Promise<number[][]> {
    const json = await this.post("/embeddings", {
      model: opts.model ?? this.cfg.embedModel,
      input: texts,
    });
    return (json.data as Array<{ embedding: number[] }>).map((d) => d.embedding);
  }
}
