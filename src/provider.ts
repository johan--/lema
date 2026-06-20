import type { LemaConfig } from "./config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatOptions {
  model?: string;
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatResult {
  message: ChatMessage;
  usage?: Usage;
}

/** Thin OpenAI-compatible client. Zero deps, native fetch. */
export class Provider {
  constructor(private cfg: LemaConfig) {}

  private async post(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${path} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    return res.json();
  }

  /** List model ids exposed by the server. */
  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.cfg.baseUrl}/models`);
    if (!res.ok) throw new Error(`/models -> HTTP ${res.status}`);
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    return (json.data ?? []).map((m) => m.id);
  }

  /** Resolve the model to use: configured one, or first loaded. */
  async resolveModel(): Promise<string> {
    if (this.cfg.model) return this.cfg.model;
    const models = await this.listModels();
    const chat = models.find((m) => !/embed/i.test(m));
    if (!chat) throw new Error("No chat model available from the server.");
    return chat;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const model = opts.model ?? await this.resolveModel();
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: opts.temperature ?? this.cfg.temperature,
      max_tokens: opts.maxTokens ?? this.cfg.maxTokens,
    };
    if (opts.tools?.length) {
      body.tools = opts.tools;
      body.tool_choice = "auto";
    }
    const json = await this.post("/chat/completions", body);
    return { message: json.choices[0].message as ChatMessage, usage: json.usage as Usage | undefined };
  }

  /** Embed texts for skill retrieval. */
  async embed(texts: string[]): Promise<number[][]> {
    const json = await this.post("/embeddings", {
      model: this.cfg.embedModel,
      input: texts,
    });
    return (json.data as Array<{ embedding: number[] }>).map((d) => d.embedding);
  }
}
