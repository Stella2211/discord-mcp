// Claude（Anthropic API）。構造化出力で { relevant, reason } を受け取る
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod";
import { systemPrompt, userPrompt } from "./prompt";
import { DecisionError, type Decision, type DecisionInput, type DecisionModel } from "./types";

const DecisionSchema = z.object({ relevant: z.boolean(), reason: z.string() });

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  profile: string;
  timeoutMs: number;
  client?: Pick<Anthropic, "messages">;
}

export class AnthropicModel implements DecisionModel {
  readonly name: string;
  private readonly client: Pick<Anthropic, "messages">;

  constructor(private readonly o: AnthropicOptions) {
    this.name = `anthropic:${o.model}`;
    // SDK の timeout は1回の試行ごとなので、再試行すると DECISION_TIMEOUT_SECONDS の何倍にもなる。
    // 失敗は judge が「未判定で通知」に倒すので再試行せず、Clef・OpenAI 互換と同じく全体で timeoutMs にする
    this.client = o.client ?? new Anthropic({ apiKey: o.apiKey, timeout: o.timeoutMs, maxRetries: 0 });
  }

  async decide(input: DecisionInput): Promise<Decision> {
    const response = await this.client.messages.parse({
      model: this.o.model,
      max_tokens: 2048,
      system: systemPrompt(this.o.profile),
      messages: [
        {
          role: "user",
          content: [
            ...(input.attachedImages ?? []).map((img) => ({
              type: "image" as const,
              source: { type: "base64" as const, media_type: img.mediaType, data: img.base64 },
            })),
            { type: "text" as const, text: userPrompt(input) },
          ],
        },
      ],
      // effort はモデルによっては受け付けないので指定しない（仕分けは短い出力で足りる）
      output_config: { format: zodOutputFormat(DecisionSchema) },
    });
    // 回答を控えたときも、見逃さないよう失敗として扱う（未判定で知らせる）
    if (response.stop_reason === "refusal") throw new DecisionError("判定モデルが回答を控えた");
    const parsed = response.parsed_output;
    if (!parsed) throw new DecisionError("判定モデルの出力を読めない");
    return { relevant: parsed.relevant, reason: parsed.reason.slice(0, 200) };
  }
}
