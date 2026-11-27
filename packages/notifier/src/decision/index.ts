import type { Config } from "../config";
import { AnthropicModel } from "./anthropic";
import { ClefModel } from "./clef";
import { OpenAICompatibleModel } from "./openai-compatible";
import type { DecisionModel } from "./types";

export type { Decision, DecisionInput, DecisionModel } from "./types";
export { judge, type Judgment } from "./judge";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// OpenRouter の振り分け設定（https://openrouter.ai/docs/guides/routing/provider-selection）。
// zdr: ZDR のエンドポイントと、OpenRouter のプライバシー設定で許していれば「安全のための保持（Safety Retention）」の
// エンドポイントだけに送る。どちらも学習には使わない。Google Vertex は Safety Retention なので、
// Gemini を使うには OpenRouter の設定で Google のモデルに Safety Retention を許しておく（BYOK の鍵も同じ扱い）。
// data_collection: "deny" は Safety Retention のエンドポイントまで外すおそれがあるので、zdr と一緒には付けない。
// zdr を切ったときは、データを集める（学習に使うことがある）プロバイダーにだけは送らない
export function openRouterProvider(zdr: boolean): Record<string, unknown> {
  return zdr ? { zdr: true } : { data_collection: "deny" };
}

export function createDecisionModel(c: Config): DecisionModel | null {
  const timeoutMs = c.DECISION_TIMEOUT_SECONDS * 1000;
  switch (c.DECISION_PROVIDER) {
    case "none":
      return null;
    case "openai-compatible":
      return new OpenAICompatibleModel({
        baseUrl: c.DECISION_BASE_URL!,
        model: c.decisionModel,
        apiKey: c.DECISION_API_KEY,
        jsonMode: c.DECISION_JSON_MODE,
        profile: c.decisionProfile,
        timeoutMs,
      });
    case "clef":
      return new ClefModel({
        accountId: c.CLOUDFLARE_ACCOUNT_ID!,
        apiToken: c.CLOUDFLARE_AI_TOKEN!,
        model: c.decisionModel as "clef" | "clef-flash",
        threshold: c.CLEF_THRESHOLD,
        priorityThreshold: c.CLEF_PRIORITY_THRESHOLD,
        profile: c.decisionProfile,
        timeoutMs,
      });
    case "openrouter":
      return new OpenAICompatibleModel({
        label: "openrouter",
        baseUrl: c.DECISION_BASE_URL ?? OPENROUTER_BASE_URL,
        model: c.decisionModel,
        apiKey: c.DECISION_API_KEY,
        jsonMode: c.DECISION_JSON_MODE,
        profile: c.decisionProfile,
        timeoutMs,
        extraBody: { provider: openRouterProvider(c.OPENROUTER_ZDR) },
      });
    case "anthropic":
      return new AnthropicModel({ apiKey: c.ANTHROPIC_API_KEY!, model: c.decisionModel, profile: c.decisionProfile, timeoutMs });
  }
}
