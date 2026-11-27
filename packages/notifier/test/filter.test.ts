import { describe, expect, test } from "bun:test";
import { classify, type FilterSettings } from "../src/filter";
import { BOT, GUILD, msg, OTHER, TARGET } from "./support";

const s: FilterSettings = {
  targetUserId: TARGET,
  botUserId: BOT,
  allowedGuildIds: [],
  ignoreChannelIds: [],
  keywords: [],
  includeBotMessages: false,
  notifyBotMentions: true,
  notifyEveryone: false,
};
const user = (id: string) => ({ id, username: id, global_name: null });

describe("classify", () => {
  test("ordinary posts go to the model", () => {
    expect(classify(msg(), s)).toEqual({ kind: "candidate" });
  });
  test("direct mentions, replies, roles, bot mentions", () => {
    expect(classify(msg({ mentions: [user(TARGET)] }), s)).toEqual({ kind: "notify", why: "mention" });
    expect(classify(msg({ referenced_message: msg({ author: user(TARGET) }) }), s)).toEqual({ kind: "notify", why: "reply" });
    expect(classify(msg({ mention_roles: ["400000000000000001"] }), s, { targetRoleIds: ["400000000000000001"] })).toEqual({
      kind: "notify",
      why: "role_mention",
    });
    expect(classify(msg({ mention_roles: ["400000000000000001"] }), s, { targetRoleIds: [] })).toEqual({ kind: "candidate" });
    expect(classify(msg({ mentions: [user(BOT)] }), s)).toEqual({ kind: "notify", why: "bot_mention" });
    expect(classify(msg({ mentions: [user(BOT)] }), { ...s, notifyBotMentions: false })).toEqual({ kind: "candidate" });
  });
  test("everyone and keywords follow settings", () => {
    expect(classify(msg({ mention_everyone: true }), s)).toEqual({ kind: "candidate" });
    expect(classify(msg({ mention_everyone: true }), { ...s, notifyEveryone: true })).toEqual({ kind: "notify", why: "everyone" });
    expect(classify(msg({ content: "Stella さん見てる?" }), { ...s, keywords: ["stella"] })).toEqual({ kind: "notify", why: "keyword" });
  });
  test("ignores what should never notify", () => {
    expect(classify(msg({ guild_id: undefined }), s).kind).toBe("ignore");
    expect(classify(msg({ author: user(TARGET), mentions: [user(TARGET)] }), s)).toEqual({ kind: "ignore", why: "self" });
    expect(classify(msg({ author: user(BOT) }), s)).toEqual({ kind: "ignore", why: "own_bot" });
    expect(classify(msg({ author: { ...user(OTHER), bot: true }, mentions: [user(TARGET)] }), s)).toEqual({ kind: "ignore", why: "bot" });
    expect(classify(msg({ author: { ...user(OTHER), bot: true }, mentions: [user(TARGET)] }), { ...s, includeBotMessages: true }).kind).toBe("notify");
    expect(classify(msg({ type: 7 }), s)).toEqual({ kind: "ignore", why: "system" });
    expect(classify(msg({ type: 19, mentions: [user(TARGET)] }), s).kind).toBe("notify");
  });
  test("own posts notify only when they mention the bot", () => {
    expect(classify(msg({ author: user(TARGET), mentions: [user(BOT)] }), s)).toEqual({ kind: "notify", why: "bot_mention" });
    expect(classify(msg({ author: user(TARGET), mentions: [user(BOT)] }), { ...s, notifyBotMentions: false })).toEqual({ kind: "ignore", why: "self" });
    expect(classify(msg({ author: user(TARGET), mentions: [user(BOT)] }), { ...s, botUserId: null })).toEqual({ kind: "ignore", why: "self" });
    expect(classify(msg({ author: user(TARGET), mentions: [user(OTHER)] }), s)).toEqual({ kind: "ignore", why: "self" });
    expect(classify(msg({ author: user(TARGET) }), s)).toEqual({ kind: "ignore", why: "self" });
  });
  test("includeSelf (no model): her own posts pass through, the bot's own posts do not", () => {
    const on = { ...s, includeSelf: true };
    expect(classify(msg({ author: user(TARGET) }), on)).toEqual({ kind: "candidate" });
    expect(classify(msg({ author: user(TARGET), mentions: [user(OTHER)] }), on)).toEqual({ kind: "candidate" });
    expect(classify(msg({ author: user(TARGET), mentions: [user(BOT)] }), on)).toEqual({ kind: "notify", why: "bot_mention" });
    expect(classify(msg({ author: user(BOT) }), on)).toEqual({ kind: "ignore", why: "own_bot" });
    expect(classify(msg({ author: user(TARGET) }), s)).toEqual({ kind: "ignore", why: "self" });
  });
  test("guild and channel filters, including the thread's parent", () => {
    expect(classify(msg(), { ...s, allowedGuildIds: ["100000000000000999"] })).toEqual({ kind: "ignore", why: "guild" });
    expect(classify(msg(), { ...s, allowedGuildIds: [GUILD] }).kind).toBe("candidate");
    const ignore = { ...s, ignoreChannelIds: ["110000000000000999"] };
    expect(classify(msg({ channel_id: "110000000000000999" }), ignore).kind).toBe("ignore");
    expect(classify(msg(), ignore, { parentChannelId: "110000000000000999" })).toEqual({ kind: "ignore", why: "channel" });
  });
});
