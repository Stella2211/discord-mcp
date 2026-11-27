import {
  assertSnowflake,
  clean,
  cleanBody,
  DiscordApiError,
  displayName,
  imageLine,
  jst,
  messageImages,
  THREAD_TYPES,
  wrapUntrusted,
  type APIChannel,
  type APIMessage,
  type APIUser,
  type Rest,
} from "@discord-mcp/discord";
import * as z from "zod";

// ---- 実行時の文脈 ----

export interface ToolContext {
  rest: Rest;
  configured: boolean;
  // null なら Bot が入っている全サーバー
  allowedGuilds: ReadonlySet<string> | null;
  botUser(): Promise<APIUser>;
}

export function parseGuildList(value: string | undefined): ReadonlySet<string> | null {
  const ids = (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return null;
  // 書き間違いで全サーバーに開いてしまわないよう、形式が正しくない値があれば何も許さない
  if (!ids.every((id) => /^\d{15,21}$/.test(id))) return new Set();
  return new Set(ids);
}

export function createContext(env: Env, rest: Rest): ToolContext {
  let me: Promise<APIUser> | null = null;
  return {
    rest,
    configured: Boolean(env.DISCORD_BOT_TOKEN),
    allowedGuilds: parseGuildList(env.ALLOWED_GUILD_IDS),
    botUser: () => {
      me ??= rest.get<APIUser>("/users/@me").catch((err) => {
        me = null;
        throw err;
      });
      return me;
    },
  };
}

// ---- 入力スキーマの部品 ----

export const snowflakeSchema = z.string().regex(/^\d{15,21}$/, "Discord の ID（15〜21桁の数字の文字列）");
export const guildIdSchema = snowflakeSchema.describe("サーバー（guild）の ID。list_guilds が返す guild_id");
export const channelIdSchema = snowflakeSchema.describe("チャンネルまたはスレッドの ID。list_channels が返す channel_id");
export const messageIdSchema = snowflakeSchema.describe("メッセージの ID。read_messages / search_messages が返す message_id");
export const mentionUserIdsSchema = z
  .array(snowflakeSchema)
  .max(20)
  .optional()
  .describe("通知（メンション）するユーザーの ID。本文に <@ID> が無ければ先頭に付ける。ここに無い人・ロール・@everyone には通知しない");
export const contentSchema = z.string().min(1).max(2000).describe("本文（Markdown 可、2000文字まで）");

// ---- 結果 ----

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

// 区切りの外（このサーバー自身が生成した事実）と、区切りの内側（Discord の利用者が書いたもの）を1組だけ並べる
export function result(outside: string[], inside?: string): ToolResult {
  const text = inside === undefined ? outside.join("\n") : `${outside.join("\n")}\n\n${wrapUntrusted(inside)}`;
  return { content: [{ type: "text", text }] };
}

export function failure(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

// 入力や設定の問題。メッセージはそのまま返してよい
export class ToolError extends Error {}

// 失敗時に返す文言は固定。Discord の本文は返さない
const CODE_HINT: Record<number, string> = {
  10003: "チャンネルが見つからない（消えたか、Bot から見えない）。",
  10004: "サーバーが見つからない（Bot が入っていない）。",
  10008: "メッセージが見つからない（消えたか、ID が違う）。",
  10014: "絵文字が見つからない。Unicode の絵文字そのものか、サーバーのカスタム絵文字（name:id）を使う。",
  50001: "Bot にこのチャンネルを見る権限がない。",
  50013: "Bot に必要な権限がない（送信・リアクション・履歴の閲覧など）。",
  50005: "Bot 以外が投稿したメッセージは編集できない。",
  50035: "入力が Discord に受け付けられなかった（長さや形式）。",
  160002: "返信先のメッセージにはもう返信できない。",
};

export function describeError(err: unknown): string {
  if (err instanceof ToolError) return err.message;
  if (err instanceof DiscordApiError) {
    if (err.status === 0) return "Discord に接続できなかった（タイムアウトか通信エラー）。少し待って再試行する。";
    if (err.status === 401) return "Bot のトークンが無効（DISCORD_BOT_TOKEN を確認）。";
    if (err.status === 429) return `Discord のレート制限に当たった。${Math.ceil(err.retryAfter ?? 1)} 秒ほど待って再試行する。`;
    const hint = err.code !== undefined ? CODE_HINT[err.code] : undefined;
    if (hint) return `${hint}（HTTP ${err.status}, code ${err.code}）`;
    if (err.status === 403) return `Bot に権限がない（HTTP 403${err.code !== undefined ? `, code ${err.code}` : ""}）。`;
    if (err.status === 404) return `見つからない（HTTP 404${err.code !== undefined ? `, code ${err.code}` : ""}）。`;
    if (err.status >= 500) return `Discord 側のエラー（HTTP ${err.status}）。少し待って再試行する。`;
    return `Discord がリクエストを拒否した（HTTP ${err.status}${err.code !== undefined ? `, code ${err.code}` : ""}）。`;
  }
  return "原因不明のエラー。";
}

// ツール本体を包む。ログはツール名・件数・所要時間・失敗の種類だけ
export async function runTool(
  ctx: ToolContext,
  tool: string,
  fn: () => Promise<{ result: ToolResult; count: number }>,
): Promise<ToolResult> {
  const started = Date.now();
  if (!ctx.configured) {
    console.log(JSON.stringify({ tool, error: "misconfigured" }));
    return failure("DISCORD_BOT_TOKEN が設定されていないため使えない。");
  }
  try {
    const { result: out, count } = await fn();
    console.log(JSON.stringify({ tool, count, ms: Date.now() - started }));
    return out;
  } catch (err) {
    const kind = err instanceof DiscordApiError ? `discord_${err.status}${err.code !== undefined ? `_${err.code}` : ""}` : err instanceof ToolError ? "input" : "unknown";
    console.log(JSON.stringify({ tool, error: kind, ms: Date.now() - started }));
    return failure(`失敗しました: ${describeError(err)}`);
  }
}

// ---- サーバーとチャンネルの確認 ----

export function assertGuildAllowed(ctx: ToolContext, guildId: string): void {
  assertSnowflake(guildId, "guild_id");
  if (ctx.allowedGuilds && !ctx.allowedGuilds.has(guildId)) throw new ToolError("このサーバーは扱わない設定になっている（ALLOWED_GUILD_IDS）。");
}

// チャンネルを取り、サーバーのチャンネルで、扱ってよいサーバーのものかを確かめる（DM やグループDMは扱わない）
export async function guildChannel(ctx: ToolContext, channelId: string): Promise<APIChannel & { guild_id: string }> {
  assertSnowflake(channelId, "channel_id");
  const channel = await ctx.rest.get<APIChannel>(`/channels/${channelId}`);
  if (!channel.guild_id) throw new ToolError("サーバーのチャンネルではない（DM は扱わない）。");
  assertGuildAllowed(ctx, channel.guild_id);
  return channel as APIChannel & { guild_id: string };
}

// メッセージを持てるチャンネルか（フォーラム・メディア・カテゴリは投稿の入れ物で、メッセージはその中のスレッドにある）
export function assertMessageChannel(channel: APIChannel): void {
  if (channel.type === 15 || channel.type === 16) throw new ToolError("フォーラム／メディアチャンネルには直接メッセージがない。中のスレッドの channel_id を使う。");
  if (channel.type === 4) throw new ToolError("カテゴリにはメッセージがない。");
}

export const isThread = (c: APIChannel) => THREAD_TYPES.has(c.type);

// ---- メッセージの整形（区切りの内側に置く） ----

export function jumpLink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

export function authorLabel(m: Pick<APIMessage, "author" | "member">): string {
  const bot = m.author.bot ? "・Bot" : "";
  return `${clean(displayName(m.author, m.member?.nick), 60)}（user_id ${m.author.id}${bot}）`;
}

// <@id> を @表示名(id) に置き換える。メンションされた人の一覧にある人だけ
export function resolveMentions(m: Pick<APIMessage, "content" | "mentions">): string {
  return m.content.replace(/<@!?(\d{15,21})>/g, (raw, id: string) => {
    const u = m.mentions.find((x) => x.id === id);
    return u ? `@${displayName(u)}(${id})` : raw;
  });
}

export function messageBlock(m: APIMessage, maxChars: number): string {
  const head = [`- message_id ${m.id} | ${jst(m.timestamp)} | ${authorLabel(m)}`];
  if (m.referenced_message) head.push(`| 返信先 ${m.referenced_message.id}（${clean(displayName(m.referenced_message.author), 40)}）`);
  else if (m.message_reference?.message_id) head.push(`| 返信先 ${m.message_reference.message_id}`);
  if (m.edited_timestamp) head.push("| 編集済み");
  const lines = [head.join(" ")];
  const body = cleanBody(resolveMentions(m), maxChars);
  if (body) lines.push(...body.split("\n").map((l) => `  ${l}`));
  if (m.attachments.length > 0) {
    const names = m.attachments.slice(0, 5).map((a) => clean(a.filename, 80));
    lines.push(`  [添付 ${m.attachments.length}件: ${names.join(", ")}]`);
  }
  const images = messageImages(m);
  for (const [i, ref] of images.slice(0, 10).entries()) lines.push(`  [${imageLine(ref, i)}]`);
  if (images.length > 10) lines.push(`  [画像は ほか${images.length - 10}件]`);
  if (!body && m.embeds.length > 0) lines.push(`  [埋め込み ${m.embeds.length}件]`);
  if (!body && m.attachments.length === 0 && m.embeds.length === 0) lines.push("  (本文なし。Message Content Intent が無効だと本文が空になる)");
  if (m.reactions && m.reactions.length > 0) {
    const r = m.reactions.slice(0, 10).map((x) => `${x.emoji.id ? `${clean(x.emoji.name, 32)}:${x.emoji.id}` : clean(x.emoji.name, 16)}×${x.count}${x.me ? "(Bot済)" : ""}`);
    lines.push(`  [リアクション: ${r.join(" ")}]`);
  }
  return lines.join("\n");
}

// 結果の大きさの上限（文字数）。claude.ai のツール結果の上限に余裕を持って収める
export const OUTPUT_CHAR_BUDGET = 40_000;

// 予算に収まるだけ並べる。収まらなかった件数を返す
export function fitBlocks(blocks: string[], budget = OUTPUT_CHAR_BUDGET): { text: string; shown: number } {
  const out: string[] = [];
  let used = 0;
  for (const b of blocks) {
    if (used + b.length + 1 > budget) break;
    out.push(b);
    used += b.length + 1;
  }
  return { text: out.join("\n"), shown: out.length };
}

// 送信系の入力：mention_user_ids を本文の先頭に足し、通知してよい相手を allowed_mentions で絞る
export function buildMentions(content: string, mentionUserIds: readonly string[] | undefined): { content: string; users: string[] } {
  const users = [...new Set(mentionUserIds ?? [])];
  const missing = users.filter((id) => !new RegExp(`<@!?${id}>`).test(content));
  const prefixed = missing.length > 0 ? `${missing.map((id) => `<@${id}>`).join(" ")} ${content}` : content;
  if (prefixed.length > 2000) throw new ToolError("メンションを足すと2000文字を超える。本文を短くする。");
  return { content: prefixed, users };
}
