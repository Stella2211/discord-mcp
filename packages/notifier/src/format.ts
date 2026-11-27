// 投稿を、判定モデル用の1行と、Duet への通知文に整形する
import { cleanBody, clean, displayName, imageLine, jst, messageImages, wrapUntrusted, type APIMessage } from "@discord-mcp/discord";

// <@123> を @表示名 に置き換える（メンション一覧にある人だけ）。ほかの <...> は cleanBody が ‹...› にする
export function resolveMentions(msg: Pick<APIMessage, "content" | "mentions">): string {
  return msg.content.replace(/<@!?(\d{15,21})>/g, (m, id: string) => {
    const u = msg.mentions.find((x) => x.id === id) as (APIMessage["mentions"][number] & { member?: { nick?: string | null } }) | undefined;
    return u ? `@${displayName(u, u.member?.nick)}` : m;
  });
}

export function authorName(msg: Pick<APIMessage, "author" | "member">): string {
  return displayName(msg.author, msg.member?.nick);
}

export function messageText(msg: APIMessage, max = 1000): string {
  let text = cleanBody(resolveMentions(msg), max);
  if (msg.attachments.length > 0) {
    const names = msg.attachments.slice(0, 3).map((a) => clean(a.filename, 60));
    text += `${text ? " " : ""}[添付: ${names.join(", ")}${msg.attachments.length > 3 ? ` ほか${msg.attachments.length - 3}件` : ""}]`;
  }
  if (!text && msg.embeds.length > 0) text = `[埋め込み ${msg.embeds.length}件]`;
  return text || "(本文なし)";
}

export function messageLine(msg: APIMessage, max = 1000): string {
  const reply = msg.referenced_message ? `（${authorName(msg.referenced_message)} への返信）` : "";
  return `${jst(msg.timestamp)} ${authorName(msg)}${reply}: ${messageText(msg, max)}${imageLines(msg)}`;
}

// 画像の URL（Duet が開いて見られるように）。長い署名付き URL なので、1投稿あたり4枚まで
export function imageLines(msg: APIMessage): string {
  const images = messageImages(msg);
  if (images.length === 0) return "";
  const lines = images.slice(0, 4).map((ref, i) => `\n  [${imageLine(ref, i)}]`);
  if (images.length > 4) lines.push(`\n  [画像は ほか${images.length - 4}件]`);
  return lines.join("");
}

export function jumpLink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

export interface Place {
  guildId: string;
  guildName: string;
  channelId: string;
  channelName: string;
}

// 通知1件の上限（Duet へ送る1通は MAX_MESSAGE_CHARS 文字まで。まとめ送りの余裕を残す）
export const NOTICE_BUDGET = 5500;

// 区切りの外には ID とリンクだけを書く。サーバー名・チャンネル名・表示名は他人が付けたものなので、区切りの中に入れる
const placeIds = (p: Place) => `guild_id ${p.guildId} / channel_id ${p.channelId}`;
const placeNames = (p: Place) => `場所: ${clean(p.guildName, 60)} / #${clean(p.channelName, 60)}`;

// lines を、合計 budget 文字に収まるだけ新しい方（末尾）から残す。落とした数を返す
export function keepNewest(lines: string[], budget: number): { kept: string[]; dropped: number } {
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const len = lines[i]!.length + 1;
    if (used + len > budget) break;
    kept.unshift(lines[i]!);
    used += len;
  }
  return { kept, dropped: lines.length - kept.length };
}

function notice(header: string[], fixed: string[], rest: { title: string; lines: string[] } | null): string {
  const head = header.join("\n");
  const base = head.length + fixed.join("\n").length + 400; // 400 は wrapUntrusted の前置きと見出しのぶん
  const body = [...fixed];
  if (rest && rest.lines.length > 0) {
    const { kept, dropped } = keepNewest(rest.lines, Math.max(0, NOTICE_BUDGET - base));
    if (kept.length > 0 || dropped > 0) body.push("", rest.title);
    if (dropped > 0) body.push(`（古い ${dropped} 件は省略）`);
    body.push(...kept);
  }
  return `${head}\n\n${wrapUntrusted(body.join("\n"))}`;
}

// メンションなど、すぐ知らせる投稿。この投稿を先に書き、直前の会話は入るだけ新しい方から入れる
export function directNotice(kind: string, place: Place, msg: APIMessage, context: APIMessage[]): string {
  return notice(
    [
      `Discord: ${kind}`,
      placeIds(place),
      `投稿者の user_id: ${msg.author.id}`,
      `message_id: ${msg.id}`,
      `リンク: ${jumpLink(place.guildId, place.channelId, msg.id)}`,
    ],
    [placeNames(place), "", "（この投稿）", messageLine(msg, 1500)],
    { title: "（直前の会話）", lines: context.map((m) => messageLine(m, 300)) },
  );
}

function judgedHeader(title: string, place: Place, newMessages: APIMessage[], extra: string[]): string[] {
  const last = newMessages[newMessages.length - 1]!;
  const ids = newMessages.map((m) => m.id);
  return [
    title,
    ...extra,
    placeIds(place),
    `message_id: ${ids.length > 10 ? `${ids.slice(-10).join(", ")} ほか${ids.length - 10}件` : ids.join(", ")}`,
    `リンク: ${jumpLink(place.guildId, place.channelId, last.id)}`,
  ];
}

// 判定モデルが「関係ありそう」と判断した投稿。新しい投稿が多いときは新しい方から入るだけ入れる
export function relevantNotice(reason: string, place: Place, newMessages: APIMessage[], model: string): string {
  return notice(
    judgedHeader(`Discord: 関係がありそうな投稿（判定モデル ${clean(model, 60)}）`, place, newMessages, []),
    // 判定の理由は投稿を読んだモデルの出力なので、投稿と同じく区切りの中に入れる
    [placeNames(place), `判定の理由: ${clean(reason, 80) || "なし"}`],
    { title: "（新しい投稿）", lines: newMessages.map((m) => messageLine(m, 800)) },
  );
}

// 判定モデルの呼び出しに失敗したので、判定せずに知らせる投稿（見逃さないため）。
// 失敗の理由は通知Botと判定モデルのサーバーが書いた短い文なので、区切りの外に書く
export function unjudgedNotice(error: string, place: Place, newMessages: APIMessage[], model: string): string {
  return notice(
    judgedHeader(`Discord: 判定エラーのため未判定で通知（判定モデル ${clean(model, 60)}）`, place, newMessages, [
      `判定できなかった理由: ${clean(error, 120) || "不明"}`,
    ]),
    [placeNames(place)],
    { title: "（新しい投稿）", lines: newMessages.map((m) => messageLine(m, 800)) },
  );
}

// 判定モデルが無い（DECISION_PROVIDER=none）とき、すぐ知らせるもの以外の投稿をそのまま知らせる
export function passthroughNotice(place: Place, newMessages: APIMessage[]): string {
  return notice(judgedHeader("Discord: 判定なしで通知（判定モデルなし）", place, newMessages, []), [placeNames(place)], {
    title: "（新しい投稿）",
    lines: newMessages.map((m) => messageLine(m, 800)),
  });
}
