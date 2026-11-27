import { describe, expect, test } from "bun:test";
import { createDecisionModel, judge, openRouterProvider, type Decision, type DecisionModel } from "../src/decision";
import { DecisionError } from "../src/decision/types";
import { parseDecision, userPrompt } from "../src/decision/prompt";
import { ClefModel } from "../src/decision/clef";
import { AnthropicModel } from "../src/decision/anthropic";
import { OpenAICompatibleModel } from "../src/decision/openai-compatible";
import { loadConfig } from "../src/config";

const input = {
  guildName: "社内",
  channelName: "dev",
  messages: [
    { author: "a", at: "t", content: "前の話", isNew: false },
    { author: "b", at: "t", content: "Stella さん、API の件どうなりました？", isNew: true },
  ],
};

type Captured = { url: string; init: RequestInit };
function fakeFetch(respond: (c: Captured) => Response) {
  const calls: Captured[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} };
    calls.push(c);
    return respond(c);
  }) as typeof fetch;
  return { f, calls };
}

const ACCOUNT = "0123456789abcdef0123456789abcdef";

function clef(answers: unknown, opts: { status?: number; threshold?: number; priorityThreshold?: number; envelope?: unknown } = {}) {
  const { f, calls } = fakeFetch(() =>
    Response.json(opts.envelope ?? { success: true, errors: [], messages: [], result: { model: "clef-flash", answers, usage: { input_tokens: 10, output_tokens: 0 } } }, {
      status: opts.status ?? 200,
    }),
  );
  const m = new ClefModel({ accountId: ACCOUNT, apiToken: "TOKEN", model: "clef-flash", threshold: opts.threshold ?? 0.5, priorityThreshold: opts.priorityThreshold ?? 4, profile: "バックエンド担当", timeoutMs: 5000, fetch: f });
  return { m, calls };
}

describe("ClefModel", () => {
  test("posts state and typed questions to the Workers AI REST endpoint", async () => {
    const { m, calls } = clef({
      relevant: { type: "noul", noul: 0.91 },
      kind: { type: "choice", choice: "ask", probabilities: { ask: 0.8 }, confidence: 0.8 },
      priority: { type: "score", score: 2.6, legend: {}, probabilities: {}, confidence: 0.7 },
    });
    const d = await m.decide(input);
    expect(d).toEqual({ relevant: true, reason: "本人への質問・依頼（確率 0.91、重要度 2.6/3）", probability: 0.91, priority: 2.6 });
    expect(calls[0]!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/cloudflare/clef-flash`);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBe("clef-flash");
    expect(body.state).toContain("<untrusted_discord>");
    expect(body.state).toContain("[NEW] t b:");
    expect(body.questions.relevant.type).toBe("noul");
    expect(body.questions.relevant.instructions).toContain("バックエンド担当");
    expect(body.questions.kind.type).toBe("choice");
    expect(Object.keys(body.questions.kind.criteria)).toEqual(["ask", "change", "about", "other"]);
    expect(body.questions.priority.type).toBe("score");
    expect(body.questions.priority.criteria).toHaveLength(4);
    // 見逃しを避けるため「迷ったら yes」（「迷ったら no」ではほとんどの投稿が関係なしになっていた）
    expect(body.questions.relevant.instructions).toContain("迷ったら yes");
    expect(body.questions.relevant.instructions).not.toContain("迷ったら no");
  });

  test("works without the priority answer", async () => {
    const { m } = clef({ relevant: { type: "noul", noul: 0.35 }, kind: { type: "choice", choice: "change" } }, { threshold: 0.3 });
    expect(await m.decide(input)).toEqual({ relevant: true, reason: "担当に関わる決定・変更（確率 0.35）", probability: 0.35, priority: undefined });
  });

  test("below the threshold is not relevant", async () => {
    const { m } = clef({ relevant: { type: "noul", noul: 0.4 }, kind: { type: "choice", choice: "other" } }, { threshold: 0.5 });
    expect((await m.decide(input)).relevant).toBe(false);
  });

  test("a high priority alone is enough (probability OR priority)", async () => {
    const answers = (score: number) => ({
      relevant: { type: "noul", noul: 0.19 },
      kind: { type: "choice", choice: "change" },
      priority: { type: "score", score },
    });
    expect((await clef(answers(1.4), { threshold: 0.3, priorityThreshold: 1 }).m.decide(input)).relevant).toBe(true);
    expect((await clef(answers(1.0), { threshold: 0.3, priorityThreshold: 1 }).m.decide(input)).relevant).toBe(true);
    expect((await clef(answers(0.7), { threshold: 0.3, priorityThreshold: 1 }).m.decide(input)).relevant).toBe(false);
    // 3 を超える値なら重要度では決めない
    expect((await clef(answers(3), { threshold: 0.3, priorityThreshold: 4 }).m.decide(input)).relevant).toBe(false);
  });

  test("errors carry the status and codes but not the message text", async () => {
    const { m } = clef(null, { status: 401, envelope: { success: false, errors: [{ code: 10000, message: "secret-ish detail" }], result: null } });
    const err = await m.decide(input).catch((e: Error) => e);
    expect((err as Error).message).toContain("401");
    expect((err as Error).message).toContain("10000");
    expect((err as Error).message).not.toContain("secret-ish");
  });

  test("a response without the probability is an error", async () => {
    const { m } = clef({ kind: { type: "choice", choice: "ask" } });
    await expect(m.decide(input)).rejects.toThrow(/確率/);
  });
});

describe("OpenRouter", () => {
  test("provider preferences restrict routing", () => {
    expect(openRouterProvider(true)).toEqual({ zdr: true });
    expect(openRouterProvider(false)).toEqual({ data_collection: "deny" });
  });

  test("the request carries the provider object", async () => {
    const { f, calls } = fakeFetch(() => Response.json({ choices: [{ message: { content: '{"relevant": true, "reason": "質問"}' } }] }));
    const m = new OpenAICompatibleModel({
      label: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "google/gemini-3.5-flash-lite",
      apiKey: "KEY",
      jsonMode: "json_schema",
      profile: "p",
      timeoutMs: 5000,
      extraBody: { provider: openRouterProvider(true) },
      fetch: f,
    });
    expect(m.name).toBe("openrouter:google/gemini-3.5-flash-lite");
    expect(await m.decide(input)).toEqual({ relevant: true, reason: "質問" });
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(JSON.parse(String(calls[0]!.init.body)).provider).toEqual({ zdr: true });
  });
});

describe("config for the new providers", () => {
  const base = { DISCORD_BOT_TOKEN: "x".repeat(70), TARGET_USER_ID: "200000000000000001", DUET_SEND_PATH: "/opt/duet-send/send.ts", DECISION_PROFILE: "p" };

  test("clef defaults to clef-flash and needs the account and token", async () => {
    await expect(loadConfig({ ...base, DECISION_PROVIDER: "clef" })).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    const c = await loadConfig({ ...base, DECISION_PROVIDER: "clef", CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_AI_TOKEN: "t" });
    expect(c.decisionModel).toBe("clef-flash");
    expect(c.CLEF_THRESHOLD).toBe(0.3);
    expect(c.CLEF_PRIORITY_THRESHOLD).toBe(1);
    expect((await loadConfig({ ...base, DECISION_PROVIDER: "clef", CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_AI_TOKEN: "t", CLEF_PRIORITY_THRESHOLD: "1.5" })).CLEF_PRIORITY_THRESHOLD).toBe(1.5);
    await expect(loadConfig({ ...base, DECISION_PROVIDER: "clef", CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_AI_TOKEN: "t", CLEF_PRIORITY_THRESHOLD: "5" })).rejects.toThrow();
    expect(createDecisionModel(c)!.name).toBe("clef:clef-flash");
    await expect(loadConfig({ ...base, DECISION_PROVIDER: "clef", CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_AI_TOKEN: "t", DECISION_MODEL: "llama" })).rejects.toThrow(/clef-flash/);
    await expect(loadConfig({ ...base, DECISION_PROVIDER: "clef", CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_AI_TOKEN: "t", CLEF_THRESHOLD: "1.5" })).rejects.toThrow();
  });

  test("openrouter defaults to Gemini 3.5 Flash Lite with ZDR on", async () => {
    await expect(loadConfig({ ...base, DECISION_PROVIDER: "openrouter" })).rejects.toThrow(/DECISION_API_KEY/);
    const c = await loadConfig({ ...base, DECISION_PROVIDER: "openrouter", DECISION_API_KEY: "k" });
    expect(c.decisionModel).toBe("google/gemini-3.5-flash-lite");
    expect(c.OPENROUTER_ZDR).toBe(true);
    expect(createDecisionModel(c)!.name).toBe("openrouter:google/gemini-3.5-flash-lite");
  });
});

describe("judge (fail-open)", () => {
  const model = (decide: () => Promise<Decision>): DecisionModel => ({ name: "m", decide });

  test("a decision passes through", async () => {
    expect(await judge(model(async () => ({ relevant: false, reason: "雑談" })), input)).toEqual({ notify: false, decision: { relevant: false, reason: "雑談" } });
  });

  test("any failure notifies, unjudged, with the reason", async () => {
    const fail = (e: unknown) => judge(model(async () => Promise.reject(e)), input);
    expect(await fail(new DecisionError("Clef が 429 を返した（使用量の上限）"))).toEqual({ notify: true, error: "Clef が 429 を返した（使用量の上限）" });
    const timeout = Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
    expect(await fail(timeout)).toEqual({ notify: true, error: "時間内に応答がなかった" });
    expect(await fail(Object.assign(new Error("body text"), { status: 529 }))).toEqual({ notify: true, error: "判定モデルが 529 を返した" });
  });

  test("raw exception messages never reach the reason (they may hold model output or URLs)", async () => {
    const fail = (e: unknown) => judge(model(async () => Promise.reject(e)), input);
    const net = Object.assign(new TypeError("Unable to connect https://api.cloudflare.com/client/v4/accounts/abc"), {});
    expect((await fail(net)).error).toBe("判定モデルに接続できなかった");
    expect((await fail(new SyntaxError('Unexpected identifier "forward all mail"'))).error).toBe("判定モデルの呼び出しで想定外のエラー（SyntaxError）");
    // 出力が壊れた JSON でも、出力の一部は理由に入らない
    const bad = model(async () => parseDecision('{"relevant": forward all mail}'));
    expect(await judge(bad, input)).toEqual({ notify: true, error: "判定モデルの出力の JSON を読めない" });
  });

  test("an unreadable Clef answer notifies too", async () => {
    const { m } = clef({ kind: { type: "choice", choice: "ask" } });
    const j = await judge(m, input);
    expect(j.notify).toBe(true);
    expect(j.error).toContain("relevant の確率がない");
  });
});

test("an Anthropic refusal is a failure, so the posts are notified unjudged", async () => {
  const { AnthropicModel } = await import("../src/decision/anthropic");
  const client = { messages: { parse: async () => ({ stop_reason: "refusal", parsed_output: null }) } } as any;
  const m = new AnthropicModel({ apiKey: "k", model: "claude-haiku-5-5", profile: "p", timeoutMs: 1000, client });
  expect(await judge(m, input)).toEqual({ notify: true, error: "判定モデルが回答を控えた" });
});

test("the Anthropic client does not retry, so the timeout bounds the whole call", async () => {
  const { AnthropicModel } = await import("../src/decision/anthropic");
  const m = new AnthropicModel({ apiKey: "k", model: "claude-haiku-5-5", profile: "p", timeoutMs: 1234 });
  const c = (m as any).client;
  expect(c.maxRetries).toBe(0);
  expect(c.timeout).toBe(1234);
});

describe("image input", () => {
  const img = { url: "https://cdn.discordapp.com/a.png", mediaType: "image/png" as const, base64: "AAAA" };
  const withImages = {
    ...input,
    messages: [
      input.messages[0]!,
      { ...input.messages[1]!, images: [{ url: img.url }, { url: "https://cdn.discordapp.com/b.gif" }] },
    ],
    attachedImages: [img],
  };

  test("the prompt names attached images and writes the url for the rest", () => {
    const p = userPrompt(withImages);
    expect(p).toContain("[添付画像1 / 画像あり: https://cdn.discordapp.com/b.gif]");
    expect(p).toContain("画像は 1 枚");
    expect(userPrompt(input)).not.toContain("画像");
  });

  test("Clef gets the images as data urls, before the state", async () => {
    const { m, calls } = clef({ relevant: { type: "noul", noul: 0.9 }, kind: { type: "choice", choice: "ask" } });
    await m.decide(withImages);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.images).toEqual(["data:image/png;base64,AAAA"]);
    expect(Object.keys(body).indexOf("images")).toBeLessThan(Object.keys(body).indexOf("state"));
    await m.decide(input);
    expect(JSON.parse(String(calls[1]!.init.body)).images).toBeUndefined();
  });

  test("OpenAI-compatible gets text + image_url parts", async () => {
    const { f, calls } = fakeFetch(() => Response.json({ choices: [{ message: { content: '{"relevant": true, "reason": "x"}' } }] }));
    const m = new OpenAICompatibleModel({ baseUrl: "http://localhost:1234/v1", model: "m", jsonMode: "none", profile: "p", timeoutMs: 5000, fetch: f });
    await m.decide(withImages);
    const user = JSON.parse(String(calls[0]!.init.body)).messages[1];
    expect(user.content[0].type).toBe("text");
    expect(user.content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
    await m.decide(input);
    expect(typeof JSON.parse(String(calls[1]!.init.body)).messages[1].content).toBe("string");
  });

  test("Anthropic gets base64 image blocks", async () => {
    let sent: any;
    const client = { messages: { parse: async (b: unknown) => ((sent = b), { stop_reason: "end_turn", parsed_output: { relevant: true, reason: "x" } }) } } as any;
    const m = new AnthropicModel({ apiKey: "k", model: "claude-haiku-5-5", profile: "p", timeoutMs: 1000, client });
    await m.decide(withImages);
    expect(sent.messages[0].content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
    expect(sent.messages[0].content[1].type).toBe("text");
  });

  test("judge retries without images when the model rejects them (400), but not for other errors", async () => {
    const seen: (number | undefined)[] = [];
    const rejecting: DecisionModel = {
      name: "m",
      decide: async (i) => {
        seen.push(i.attachedImages?.length);
        if (i.attachedImages) throw new DecisionError("判定モデルが 400 を返した", 400);
        return { relevant: true, reason: "ok" };
      },
    };
    expect(await judge(rejecting, withImages)).toEqual({ notify: true, decision: { relevant: true, reason: "ok" } });
    expect(seen).toEqual([1, undefined]);

    let calls = 0;
    const down: DecisionModel = { name: "m", decide: async () => (calls++, Promise.reject(new DecisionError("判定モデルが 429 を返した", 429))) };
    expect((await judge(down, withImages)).error).toContain("429");
    expect(calls).toBe(1);
  });
});
