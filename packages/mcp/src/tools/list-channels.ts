import type { McpServer } from "@modelcontextprotocol/server";
import { ChannelType, channelPermissions, clean, has, Permission, type APIChannel, type APIGuild, type APIGuildMember } from "@discord-mcp/discord";
import * as z from "zod";
import { assertGuildAllowed, fitBlocks, guildIdSchema, isThread, result, runTool, type ToolContext } from "./common";

// 一覧に出すチャンネル種別（メッセージを持つもの、またはスレッドの入れ物）
const LISTED = new Set([0, 2, 5, 10, 11, 12, 13, 15, 16]);
const TYPE_LABEL: Record<number, string> = {
  0: "テキスト",
  2: "ボイス",
  5: "アナウンス",
  10: "スレッド(アナウンス)",
  11: "スレッド",
  12: "スレッド(非公開)",
  13: "ステージ",
  15: "フォーラム",
  16: "メディア",
};

export const listChannelsInput = z.object({
  guild_id: guildIdSchema,
  include_hidden: z.boolean().optional().describe("true なら Bot から見えないチャンネルも出す（既定は見えるものだけ）"),
});

export function registerListChannels(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_channels",
    {
      title: "チャンネル一覧",
      description:
        "サーバーのチャンネルと進行中のスレッドを、Bot の権限（読める・送れる・リアクションできる）付きで返す。読み取りだけ。" +
        "フォーラムには直接メッセージがないので、中のスレッドの channel_id を使う。",
      inputSchema: listChannelsInput,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (input) =>
      runTool(ctx, "list_channels", async () => {
        assertGuildAllowed(ctx, input.guild_id);
        const me = await ctx.botUser();
        const [guild, member, channels, active] = await Promise.all([
          ctx.rest.get<APIGuild>(`/guilds/${input.guild_id}`),
          ctx.rest.get<APIGuildMember>(`/guilds/${input.guild_id}/members/${me.id}`),
          ctx.rest.get<APIChannel[]>(`/guilds/${input.guild_id}/channels`),
          ctx.rest.get<{ threads: APIChannel[]; members?: { id?: string }[] }>(`/guilds/${input.guild_id}/threads/active`),
        ]);
        const byId = new Map(channels.map((c) => [c.id, c]));
        const perms = (c: APIChannel) => channelPermissions(guild, me.id, member.roles, c);
        // Bot が参加している進行中のスレッド（members は Bot が参加しているスレッドの分だけ返る）
        const joined = new Set((active.members ?? []).map((m) => m.id).filter((id): id is string => id !== undefined));

        const rows: { sortKey: string; line: string }[] = [];
        let hidden = 0;
        const add = (c: APIChannel) => {
          if (!LISTED.has(c.type)) return;
          // スレッドの権限は親チャンネルのもの。非公開スレッドは、Bot が参加しているかスレッドの管理の権限があるときだけ見える
          const parent = c.parent_id ? byId.get(c.parent_id) : undefined;
          const p = isThread(c) ? (parent ? perms(parent) : 0n) : perms(c);
          const privateHidden = c.type === ChannelType.PrivateThread && !joined.has(c.id) && !has(p, Permission.ManageThreads);
          const canView = has(p, Permission.ViewChannel) && !privateHidden;
          if (!canView) hidden += 1;
          if (!canView && !input.include_hidden) return;
          const canRead = canView && has(p, Permission.ReadMessageHistory);
          const canSend = canView && has(p, isThread(c) ? Permission.SendMessagesInThreads : Permission.SendMessages);
          const canReact = canView && has(p, Permission.AddReactions);
          const flags = [canRead ? "読める" : "読めない", canSend ? "送れる" : "送れない", canReact ? "リアクション可" : "リアクション不可"];
          const category = isThread(c) ? (parent?.parent_id ? byId.get(parent.parent_id) : undefined) : c.parent_id ? byId.get(c.parent_id) : undefined;
          const where = isThread(c) ? `#${clean(parent?.name ?? "?", 60)} の中` : category ? `カテゴリ ${clean(category.name, 60)}` : "カテゴリなし";
          const line = `- channel_id ${c.id} | ${TYPE_LABEL[c.type] ?? c.type} | #${clean(c.name, 80)} | ${where} | ${flags.join("・")}${c.nsfw ? " | NSFW" : ""}`;
          // カテゴリの位置 → チャンネルの位置 → スレッドは親の後ろ、の順に並べる
          const home = isThread(c) ? parent : c;
          const cat = home?.parent_id ? byId.get(home.parent_id) : undefined;
          const pad = (n: number | undefined) => String(n ?? 0).padStart(5, "0");
          rows.push({ sortKey: `${pad(cat?.position)}-${pad(home?.position)}-${home?.id ?? c.id}-${isThread(c) ? `1-${c.id}` : "0"}`, line });
        };
        for (const c of channels) add(c);
        for (const t of active.threads ?? []) if (t.guild_id === undefined || t.guild_id === input.guild_id) add(t);
        rows.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

        const { text, shown } = fitBlocks(rows.map((r) => r.line));
        const outside = [`チャンネルとスレッド ${rows.length} 件（進行中のスレッドだけ。アーカイブ済みは含まない）。`];
        if (!input.include_hidden && hidden > 0) outside.push(`Bot から見えないチャンネルが ${hidden} 件ある（include_hidden で表示）。`);
        if (shown < rows.length) outside.push(`長いので先頭の ${shown} 件だけを返す。`);
        return { result: result(outside, text || "(なし)"), count: rows.length };
      }),
  );
}
