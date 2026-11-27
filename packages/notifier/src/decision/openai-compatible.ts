// OpenAI 互換の Chat Completions API（LM Studio、Ollama、OpenRouter、vLLM など）
import { DECISION_JSON_SCHEMA, parseDecision, systemPrompt, userPrompt } from "./prompt";
import { dataUrl, DecisionError } from "./types";
import type { Decision, DecisionInput, DecisionModel } from "./types";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  jsonMode: "json_schema" | "json_object" | "none";
  profile: string;
  timeoutMs: number;
  // リクエストに足す項目（OpenRouter の provider など）
  extraBody?: Record<string, unknown>;
  // ログと通知に出す名前の前置き
  label?: string;
  fetch?: typeof fetch;
}

// 画像があれば、文字と画像を並べた配列にする（data URL なので、モデルのサーバーが Discord に取りに行く必要はない）
function userContent(input: DecisionInput) {
  const text = userPrompt(input);
  const images = input.attachedImages ?? [];
  if (images.length === 0) return text;
  return [{ type: "text", text }, ...images.map((img) => ({ type: "image_url", image_url: { url: dataUrl(img) } }))];
}

export class OpenAICompatibleModel implements DecisionModel {
  readonly name: string;
  constructor(private readonly o: OpenAICompatibleOptions) {
    this.name = `${o.label ?? "openai-compatible"}:${o.model}`;
  }

  async decide(input: DecisionInput): Promise<Decision> {
    const body: Record<string, unknown> = {
      ...this.o.extraBody,
      model: this.o.model,
      temperature: 0,
      max_tokens: 2048,
      messages: [
        { role: "system", content: systemPrompt(this.o.profile) },
        { role: "user", content: userContent(input) },
      ],
    };
    if (this.o.jsonMode === "json_schema") {
      body.response_format = { type: "json_schema", json_schema: { name: "decision", strict: true, schema: DECISION_JSON_SCHEMA } };
    } else if (this.o.jsonMode === "json_object") {
      body.response_format = { type: "json_object" };
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.o.apiKey) headers.Authorization = `Bearer ${this.o.apiKey}`;
    const res = await (this.o.fetch ?? fetch)(`${this.o.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.o.timeoutMs),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new DecisionError(`判定モデルが ${res.status} を返した`, res.status);
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new DecisionError("判定モデルの応答に本文がない");
    return parseDecision(content);
  }
}
