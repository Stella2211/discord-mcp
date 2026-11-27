// 新しいメッセージを「すぐ通知」「判定モデルに回す」「無視」に振り分ける。
import type { APIMessage } from "@discord-mcp/discord";

export type Verdict =
  | { kind: "notify"; why: "mention" | "role_mention" | "reply" | "bot_mention" | "everyone" | "keyword" }
  | { kind: "candidate" }
  | { kind: "ignore"; why: string };

export interface FilterSettings {
  targetUserId: string;
  botUserId: string | null;
  allowedGuildIds: readonly string[];
  ignoreChannelIds: readonly string[];
  keywords: readonly string[];
  includeBotMessages: boolean;
  notifyBotMentions: boolean;
  notifyEveryone: boolean;
  // 判定モデルが無い（DECISION_PROVIDER=none）とき、本人の投稿もそのまま通知する。Bot 自身の投稿は除く
  includeSelf?: boolean;
}

// 通常の投稿と返信だけを扱う（参加・ピン留めなどのシステムメッセージは除く）
const USER_MESSAGE_TYPES = new Set([0, 19]);

export function classify(
  msg: APIMessage,
  s: FilterSettings,
  ctx: { targetRoleIds?: readonly string[]; parentChannelId?: string | null } = {},
): Verdict {
  if (!msg.guild_id) return { kind: "ignore", why: "dm" };
  if (s.allowedGuildIds.length > 0 && !s.allowedGuildIds.includes(msg.guild_id)) return { kind: "ignore", why: "guild" };
  if (s.ignoreChannelIds.includes(msg.channel_id) || (ctx.parentChannelId && s.ignoreChannelIds.includes(ctx.parentChannelId)))
    return { kind: "ignore", why: "channel" };
  if (!USER_MESSAGE_TYPES.has(msg.type)) return { kind: "ignore", why: "system" };
  if (msg.author.id === s.targetUserId) {
    // 本人の投稿は、Bot へのメンションがあるときだけ通知する（Bot に頼み事をする使い方）。それ以外は無視する
    if (s.notifyBotMentions && s.botUserId && msg.mentions.some((u) => u.id === s.botUserId)) return { kind: "notify", why: "bot_mention" };
    if (!s.includeSelf) return { kind: "ignore", why: "self" };
    // 本人の投稿を通すときは、本人あてのメンション・返信などの判定は飛ばして、判定に回る扱い（none ならそのまま通知）にする
    if (s.botUserId && msg.author.id === s.botUserId) return { kind: "ignore", why: "own_bot" };
    if (s.notifyEveryone && msg.mention_everyone) return { kind: "notify", why: "everyone" };
    return { kind: "candidate" };
  }
  if (s.botUserId && msg.author.id === s.botUserId) return { kind: "ignore", why: "own_bot" };
  if ((msg.author.bot || msg.webhook_id) && !s.includeBotMessages) return { kind: "ignore", why: "bot" };

  if (msg.mentions.some((u) => u.id === s.targetUserId)) return { kind: "notify", why: "mention" };
  if (msg.referenced_message?.author?.id === s.targetUserId) return { kind: "notify", why: "reply" };
  const roles = ctx.targetRoleIds ?? [];
  if (msg.mention_roles.some((r) => roles.includes(r))) return { kind: "notify", why: "role_mention" };
  if (s.notifyBotMentions && s.botUserId && msg.mentions.some((u) => u.id === s.botUserId)) return { kind: "notify", why: "bot_mention" };
  if (s.notifyEveryone && msg.mention_everyone) return { kind: "notify", why: "everyone" };
  if (s.keywords.length > 0) {
    const text = msg.content.toLowerCase();
    if (s.keywords.some((k) => text.includes(k.toLowerCase()))) return { kind: "notify", why: "keyword" };
  }
  return { kind: "candidate" };
}

export const WHY_LABEL: Record<Extract<Verdict, { kind: "notify" }>["why"], string> = {
  mention: "あなたへのメンション",
  role_mention: "あなたのロールへのメンション",
  reply: "あなたの投稿への返信",
  bot_mention: "Botへのメンション",
  everyone: "@everyone / @here",
  keyword: "キーワード",
};
