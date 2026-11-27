import type { McpServer } from "@modelcontextprotocol/server";
import { clean, type APIPartialGuild } from "@discord-mcp/discord";
import { result, runTool, type ToolContext } from "./common";

export function registerListGuilds(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_guilds",
    {
      title: "サーバー一覧",
      description: "Bot が入っている Discord サーバーの一覧（guild_id と名前）を返す。読み取りだけ。",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    () =>
      runTool(ctx, "list_guilds", async () => {
        const all: APIPartialGuild[] = [];
        let after: string | undefined;
        // 1回200件まで。Bot が入れるサーバー数は通常100以下なので、最大5回で打ち切る
        for (let page = 0; page < 5; page++) {
          const list = await ctx.rest.get<APIPartialGuild[]>("/users/@me/guilds", { limit: 200, after });
          all.push(...list);
          if (list.length < 200) break;
          after = list[list.length - 1]!.id;
        }
        const guilds = ctx.allowedGuilds ? all.filter((g) => ctx.allowedGuilds!.has(g.id)) : all;
        const outside = [`サーバー ${guilds.length} 件。`];
        if (ctx.allowedGuilds) outside.push("ALLOWED_GUILD_IDS に書かれたサーバーだけを返している。");
        const lines = guilds.map((g) => `- guild_id ${g.id} | ${clean(g.name, 100)}`);
        return { result: result(outside, lines.join("\n") || "(なし)"), count: guilds.length };
      }),
  );
}
