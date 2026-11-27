import { describe, expect, test } from "bun:test";
import type { APIMessage } from "@discord-mcp/discord";
import { Notifier } from "../src/app";
import type { Config } from "../src/config";
import type { DecisionInput, DecisionModel } from "../src/decision";
import { DecisionError } from "../src/decision/types";
import { Directory } from "../src/directory";
import { BOT, CHANNEL, FakeClock, flushPromises, GUILD, msg, OTHER, TARGET } from "./support";

const config = {
  TARGET_USER_ID: TARGET,
  ALLOWED_GUILD_IDS: [],
  IGNORE_CHANNEL_IDS: [],
  KEYWORDS: [],
  INCLUDE_BOT_MESSAGES: false,
  NOTIFY_BOT_MENTIONS: true,
  NOTIFY_EVERYONE: false,
  MENTION_CONTEXT_MESSAGES: 2,
  DECISION_HISTORY_MESSAGES: 20,
  DECISION_DEBOUNCE_SECONDS: 20,
  DECISION_MAX_WAIT_SECONDS: 60,
} as unknown as Config;

function setup(
  opts: { noModel?: boolean; images?: boolean; fetchImage?: typeof fetch; debug?: string[]; history?: APIMessage[]; absent?: boolean; routes?: Map<string, string>; decide?: (i: DecisionInput) => Promise<{ relevant: boolean; reason: string }> } = {},
) {
  const clock = new FakeClock();
  const pushed: string[] = [];
  const routes: (string | undefined)[] = [];
  const inputs: DecisionInput[] = [];
  const gets: { path: string; query: unknown }[] = [];
  const rest = {
    get: (async (path: string, query?: unknown) => {
      gets.push({ path, query });
      if (path.startsWith(`/channels/${CHANNEL}/messages`)) return [...(opts.history ?? [])].reverse();
      if (path === `/guilds/${GUILD}/members/${TARGET}` && !opts.absent) return { roles: [] };
      throw Object.assign(new Error("not found"), { status: 404 });
    }) as any,
  };
  const directory = new Directory(rest, TARGET, clock.now);
  directory.onDispatch("GUILD_CREATE", { id: GUILD, name: "社内", channels: [{ id: CHANNEL, type: 0, name: "dev" }] });
  const model: DecisionModel = {
    name: "test-model",
    decide: async (i) => {
      inputs.push(i);
      return (opts.decide ?? (async () => ({ relevant: true, reason: "質問されている" })))(i);
    },
  };
  const n = new Notifier({
    config: { ...config, ...(opts.images ? { DECISION_IMAGES: true } : {}), DUET_ROUTES: opts.routes } as Config,
    fetchImage: opts.fetchImage,
    rest,
    directory,
    model: opts.noModel ? null : model,
    queue: { push: (t, r) => void (pushed.push(t), routes.push(r)) },
    log: () => {},
    debug: opts.debug ? (m) => void opts.debug!.push(m) : undefined,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { n, clock, pushed, routes, inputs, gets, directory };
}

const user = (id: string, name = id) => ({ id, username: name, global_name: null });

describe("Notifier", () => {
  test("a mention is pushed at once with recent context", async () => {
    const before = msg({ content: "前の話" });
    const t = setup({ history: [before] });
    const m = msg({ content: `<@${TARGET}> レビューお願いします`, mentions: [user(TARGET, "stella")] });
    await t.n.handleMessage(m);
    expect(t.pushed.length).toBe(1);
    expect(t.pushed[0]).toContain("あなたへのメンション");
    expect(t.pushed[0]).toContain("社内 / #dev");
    expect(t.pushed[0]).toContain("@stella レビューお願いします");
    expect(t.pushed[0]).toContain("前の話");
    expect(t.pushed[0]).toContain(`https://discord.com/channels/${GUILD}/${CHANNEL}/${m.id}`);
    expect(t.gets.find((g) => g.path.includes("/messages"))!.query).toEqual({ limit: 2, before: m.id });
    expect(t.inputs.length).toBe(0);
  });

  test("other posts are debounced per channel and judged together", async () => {
    const a = msg({ content: "API の仕様変わった?" });
    const b = msg({ content: "誰か分かる?" });
    const t = setup({ history: [a] }); // 履歴にはまだ b がない
    await t.n.handleMessage(a);
    t.clock.advance(10_000);
    await t.n.handleMessage(b);
    t.clock.advance(19_000);
    expect(t.inputs.length).toBe(0);
    t.clock.advance(1_000);
    await flushPromises();
    await flushPromises();
    expect(t.inputs.length).toBe(1);
    expect(t.inputs[0]!.messages.map((m) => [m.content, m.isNew])).toEqual([
      ["API の仕様変わった?", true],
      ["誰か分かる?", true],
    ]);
    expect(t.pushed.length).toBe(1);
    expect(t.pushed[0]).toContain("関係がありそうな投稿");
    expect(t.pushed[0]).toContain("判定の理由: 質問されている");
  });

  test("a busy channel is judged by the max wait", async () => {
    const t = setup();
    for (let i = 0; i < 8; i++) {
      await t.n.handleMessage(msg({ content: `m${i}` }));
      t.clock.advance(10_000);
    }
    await flushPromises();
    await flushPromises();
    expect(t.inputs.length).toBe(1);
  });

  test("skips the model when she already replied after the posts", async () => {
    const a = msg({ content: "質問" });
    const mine = msg({ author: user(TARGET) });
    const t = setup({ history: [a, mine] });
    await t.n.handleMessage(a);
    t.clock.advance(20_000);
    await flushPromises();
    await flushPromises();
    expect(t.inputs.length).toBe(0);
    expect(t.pushed.length).toBe(0);
  });

  test("a mention cancels pending judgements that are in its context", async () => {
    const chat = msg({ content: "雑談" });
    const t = setup({ history: [chat] });
    await t.n.handleMessage(chat);
    await t.n.handleMessage(msg({ mentions: [user(TARGET)] }));
    t.clock.advance(60_000);
    await flushPromises();
    expect(t.inputs.length).toBe(0);
    expect(t.pushed.length).toBe(1);
    expect(t.n.pendingChannels).toBe(0);
  });

  test("a pending post outside the mention's context is still judged", async () => {
    const t = setup({ history: [] });
    await t.n.handleMessage(msg({ content: "別の話題" }));
    await t.n.handleMessage(msg({ mentions: [user(TARGET)] }));
    t.clock.advance(60_000);
    await flushPromises();
    await flushPromises();
    expect(t.inputs.length).toBe(1);
  });

  test("posts in a channel she cannot view are not notified", async () => {
    const SECRET = "110000000000000009";
    const t = setup();
    t.directory.onDispatch("GUILD_CREATE", {
      id: GUILD,
      name: "社内",
      owner_id: OTHER,
      roles: [{ id: GUILD, name: "@everyone", permissions: String((1 << 10) | (1 << 11)), position: 0 }],
      channels: [
        { id: CHANNEL, type: 0, name: "dev" },
        { id: SECRET, type: 0, name: "admin", permission_overwrites: [{ id: GUILD, type: 0, allow: "0", deny: String(1 << 10) }] },
      ],
    });
    await t.n.handleMessage(msg({ channel_id: SECRET, mentions: [user(TARGET)] }));
    expect(t.pushed.length).toBe(0);
    await t.n.handleMessage(msg({ mentions: [user(TARGET)] }));
    expect(t.pushed.length).toBe(1);
  });

  test("a private thread she has not joined is skipped, but a mention of her there is notified", async () => {
    const THREAD = "120000000000000001";
    const t = setup();
    t.directory.onDispatch("GUILD_CREATE", {
      id: GUILD,
      name: "社内",
      owner_id: OTHER,
      roles: [{ id: GUILD, name: "@everyone", permissions: String(1 << 10), position: 0 }],
      channels: [{ id: CHANNEL, type: 0, name: "dev" }],
      threads: [{ id: THREAD, type: 12, name: "非公開", parent_id: CHANNEL }],
    });
    // 参加していない（Get Thread Member が 404）ので、ふつうの投稿は判定にも回さない。この答えは控えられる
    await t.n.handleMessage(msg({ channel_id: THREAD, content: "相談" }));
    expect(t.gets.filter((g) => g.path === `/channels/${THREAD}/thread-members/${TARGET}`).length).toBe(1);
    t.clock.advance(60_000);
    await flushPromises();
    expect(t.inputs.length).toBe(0);
    expect(t.pushed.length).toBe(0);
    // メンションは本人をスレッドに加えるので、控えの「参加していない」に関わらず通知する
    await t.n.handleMessage(msg({ channel_id: THREAD, mentions: [user(TARGET)] }));
    expect(t.pushed.length).toBe(1);
    expect(t.pushed[0]).toContain("あなたへのメンション");
  });

  test("after she is added to a private thread, ordinary posts there are delivered again", async () => {
    const THREAD = "120000000000000001";
    const t = setup({ noModel: true });
    t.directory.onDispatch("GUILD_CREATE", {
      id: GUILD,
      name: "社内",
      owner_id: OTHER,
      roles: [{ id: GUILD, name: "@everyone", permissions: String(1 << 10), position: 0 }],
      channels: [{ id: CHANNEL, type: 0, name: "dev" }],
      threads: [{ id: THREAD, type: 12, name: "非公開", parent_id: CHANNEL }],
    });
    await t.n.handleMessage(msg({ channel_id: THREAD, content: "前の相談" }));
    t.clock.advance(20_000);
    await flushPromises();
    await flushPromises();
    expect(t.pushed.length).toBe(0);
    // 他の人が本人をスレッドに加えた（RECIPIENT_ADD）。この投稿そのものはシステムメッセージなので知らせない
    t.n.onDispatch("MESSAGE_CREATE", msg({ channel_id: THREAD, type: 1, mentions: [user(TARGET)] }));
    await flushPromises();
    await t.n.handleMessage(msg({ channel_id: THREAD, content: "続きの相談" }));
    t.clock.advance(20_000);
    await flushPromises();
    await flushPromises();
    expect(t.pushed.length).toBe(1);
    expect(t.pushed[0]).toContain("続きの相談");
    expect(t.gets.filter((g) => g.path === `/channels/${THREAD}/thread-members/${TARGET}`).length).toBe(1);
  });

  test("nothing is notified when she is not in the server", async () => {
    const t = setup({ absent: true });
    await t.n.handleMessage(msg({ mentions: [user(TARGET)] }));
    expect(t.pushed.length).toBe(0);
  });

  test("not relevant pushes nothing; failures notify unjudged, plus one warning", async () => {
    const t = setup({
      decide: async () => {
        throw new DecisionError("Clef が 429 を返した（使用量の上限）");
      },
    });
    for (let i = 0; i < 4; i++) {
      await t.n.handleMessage(msg({ content: `q${i}` }));
      t.clock.advance(20_000);
      await flushPromises();
      await flushPromises();
    }
    expect(t.inputs.length).toBe(4);
    // 判定できなかった投稿は捨てずに未判定で知らせる。3回続いたところで警告を1回だけ足す
    const unjudged = t.pushed.filter((s) => s.startsWith("Discord: 判定エラーのため未判定で通知"));
    expect(unjudged.length).toBe(4);
    expect(unjudged[0]).toContain("判定できなかった理由: Clef が 429 を返した（使用量の上限）");
    expect(unjudged[0]).toContain("test-model");
    expect(unjudged[3]).toContain("q3");
    const warnings = t.pushed.filter((s) => s.startsWith("Discord 通知Botのお知らせ"));
    expect(warnings.length).toBe(1);
    expect(t.pushed.length).toBe(5);

    const t2 = setup({ decide: async () => ({ relevant: false, reason: "雑談" }) });
    await t2.n.handleMessage(msg());
    t2.clock.advance(20_000);
    await flushPromises();
    await flushPromises();
    expect(t2.inputs.length).toBe(1);
    expect(t2.pushed.length).toBe(0);
  });

  test("her own posts are marked for the model", async () => {
    const mine = msg({ author: user(TARGET, "stella"), content: "あとで見ます" });
    const a = msg({ author: user(OTHER, "bob"), content: "ありがとう" });
    const t = setup({ history: [mine, a] });
    await t.n.handleMessage(a);
    t.clock.advance(20_000);
    await flushPromises();
    await flushPromises();
    expect(t.inputs[0]!.messages.map((m) => [m.author, m.isTarget])).toEqual([
      ["stella", true],
      ["bob", false],
    ]);
    expect(t.inputs[0]!.messages.map((m) => m.isNew)).toEqual([false, true]);
  });

  test("her own post mentioning the bot is notified; other own posts are ignored and logged without the body", async () => {
    const debug: string[] = [];
    const t = setup({ debug });
    t.n.onDispatch("READY", { user: { id: BOT } });
    const asked = msg({ author: user(TARGET, "stella"), content: `<@${BOT}> これ調べて`, mentions: [user(BOT, "discord-mcp")] });
    await t.n.handleMessage(asked);
    expect(t.pushed.length).toBe(1);
    expect(t.pushed[0]).toContain("Botへのメンション");
    expect(debug).toEqual([]);

    const plain = msg({ author: user(TARGET, "stella"), content: "ひみつの本文" });
    await t.n.handleMessage(plain);
    expect(t.pushed.length).toBe(1);
    expect(debug).toEqual([`notifier: 無視（self、channel ${CHANNEL}, message ${plain.id}）`]);
    expect(debug.join("")).not.toContain("ひみつの本文");
  });

  test("images of the new posts go to the model when DECISION_IMAGES is on; the url is in the text otherwise", async () => {
    const fetched: string[] = [];
    const fetchImage = (async (u: string | URL | Request) => (fetched.push(String(u)), new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }))) as typeof fetch;
    const att = (name: string) => [{ id: "9", filename: name, size: 3, content_type: "image/png", url: `https://cdn.discordapp.com/attachments/1/2/${name}` }];

    const on = setup({ images: true, fetchImage });
    await on.n.handleMessage(msg({ content: "エラー画面です", attachments: att("err.png") } as any));
    on.clock.advance(20_000);
    await flushPromises();
    await flushPromises();
    expect(fetched).toEqual(["https://cdn.discordapp.com/attachments/1/2/err.png"]);
    expect(on.inputs[0]!.attachedImages).toEqual([{ url: fetched[0]!, mediaType: "image/png", base64: "AQID" }]);
    expect(on.inputs[0]!.messages[0]!.images).toEqual([{ url: fetched[0]!, filename: "err.png" }]);

    const off = setup({ fetchImage });
    await off.n.handleMessage(msg({ content: "エラー画面です", attachments: att("err2.png") } as any));
    off.clock.advance(20_000);
    await flushPromises();
    await flushPromises();
    expect(off.inputs[0]!.attachedImages).toBeUndefined();
    expect(fetched.length).toBe(1);
    expect(off.inputs[0]!.messages[0]!.images![0]!.url).toContain("err2.png");
  });

  test("without a model, every post is passed through unjudged, batched per channel", async () => {
    const t = setup({ noModel: true });
    await t.n.handleMessage(msg({ content: "ただの雑談" }));
    await t.n.handleMessage(msg({ content: "もうひとつ" }));
    expect(t.pushed.length).toBe(0);
    t.clock.advance(20_000);
    await flushPromises();
    await flushPromises();
    expect(t.pushed.length).toBe(1);
    expect(t.pushed[0]).toContain("判定なしで通知");
    expect(t.pushed[0]).toContain("ただの雑談");
    expect(t.pushed[0]).toContain("もうひとつ");
    expect(t.inputs.length).toBe(0);
  });

  test("without a model, a mention is still pushed at once and not repeated", async () => {
    const t = setup({ noModel: true });
    await t.n.handleMessage(msg({ mentions: [user(TARGET)] }));
    expect(t.pushed.length).toBe(1);
    t.clock.advance(60_000);
    await flushPromises();
    expect(t.pushed.length).toBe(1);
  });

  test("without a model her own posts are passed through; with a model they are still ignored; the bot's own never", async () => {
    const none = setup({ noModel: true });
    none.n.onDispatch("READY", { user: { id: BOT } });
    await none.n.handleMessage(msg({ author: user(TARGET, "stella"), content: "自分の投稿" }));
    await none.n.handleMessage(msg({ author: user(BOT, "bot"), content: "Bot の投稿" }));
    none.clock.advance(20_000);
    await flushPromises();
    await flushPromises();
    expect(none.pushed.length).toBe(1);
    expect(none.pushed[0]).toContain("自分の投稿");
    expect(none.pushed[0]).not.toContain("Bot の投稿");

    const withModel = setup();
    await withModel.n.handleMessage(msg({ author: user(TARGET, "stella"), content: "自分の投稿" }));
    withModel.clock.advance(60_000);
    await flushPromises();
    expect(withModel.inputs.length).toBe(0);
    expect(withModel.pushed.length).toBe(0);
  });

  test("a mention goes to the route of its channel or server, others to the default", async () => {
    const t = setup({ routes: new Map([[GUILD, "work"]]) });
    await t.n.handleMessage(msg({ content: `<@${TARGET}> お願い`, mentions: [user(TARGET, "stella")] }));
    expect(t.routes).toEqual(["work"]);
    const d = setup({ routes: new Map([["100000000000000999", "work"]]) });
    await d.n.handleMessage(msg({ content: `<@${TARGET}> お願い`, mentions: [user(TARGET, "stella")] }));
    expect(d.routes).toEqual([undefined]);
  });
  test("judged notices use the route; the failure alert uses the default", async () => {
    const t = setup({ routes: new Map([[CHANNEL, "work"]]), decide: async () => { throw new DecisionError("x"); } });
    for (let i = 0; i < 3; i++) {
      await t.n.handleMessage(msg({ content: "質問です" }));
      await t.n.flushChannel(CHANNEL);
      t.clock.advance(1000);
    }
    expect(t.routes.length).toBeGreaterThan(3);
    expect(t.routes.slice(0, 3)).toEqual(["work", "work", "work"]);
    expect(t.routes[t.routes.length - 1]).toBeUndefined();
  });

  describe("route of a thread, passthrough and judged notices", () => {
    const THREAD = "110000000000000099";
    const inThread = (over: Partial<APIMessage> = {}) => msg({ channel_id: THREAD, ...over });
    const withThread = (t: ReturnType<typeof setup>) =>
      t.directory.onDispatch("THREAD_CREATE", { id: THREAD, type: 11, name: "相談", guild_id: GUILD, parent_id: CHANNEL });

    test("a mention in a thread takes the route of its parent channel", async () => {
      const t = setup({ routes: new Map([[CHANNEL, "work"]]) });
      withThread(t);
      await t.n.handleMessage(inThread({ content: `<@${TARGET}> お願い`, mentions: [user(TARGET, "stella")] }));
      expect(t.routes).toEqual(["work"]);
    });

    test("a passthrough notice (no decision model) carries the route", async () => {
      const t = setup({ noModel: true, routes: new Map([[CHANNEL, "work"]]) });
      withThread(t);
      await t.n.handleMessage(inThread({ content: "質問です" }));
      t.clock.advance(20_000);
      await flushPromises();
      await flushPromises();
      expect(t.pushed.length).toBe(1);
      expect(t.routes).toEqual(["work"]);
    });

    test("a relevant (judged) notice carries the route", async () => {
      const t = setup({ routes: new Map([[CHANNEL, "work"]]) });
      withThread(t);
      await t.n.handleMessage(inThread({ content: "質問です" }));
      t.clock.advance(20_000);
      await flushPromises();
      await flushPromises();
      expect(t.inputs.length).toBe(1);
      expect(t.pushed.length).toBe(1);
      expect(t.pushed[0]).toContain("関係がありそうな投稿");
      expect(t.routes).toEqual(["work"]);
    });
  });
});
