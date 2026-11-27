import { McpServer } from "@modelcontextprotocol/server";
import { createRest, type Rest } from "@discord-mcp/discord";
import { registerAddReaction } from "./tools/add-reaction";
import { createContext, type ToolContext } from "./tools/common";
import { registerListChannels } from "./tools/list-channels";
import { registerListGuilds } from "./tools/list-guilds";
import { registerReadMessages } from "./tools/read-messages";
import { registerEditMessage, registerReplyToMessage, registerSendMessage } from "./tools/send";
import { registerSearchMessages } from "./tools/search-messages";

// 8ツールを登録する。読み取り4つ（list_guilds, list_channels, read_messages, search_messages）と、
// 書き込み4つ（send_message, reply_to_message, edit_message, add_reaction）。スコープによる出し分けはしない
export function createServer(env: Env, rest?: Rest): McpServer {
  const ctx: ToolContext = createContext(env, rest ?? createRest({ token: env.DISCORD_BOT_TOKEN }));
  const server = new McpServer({ name: "discord-mcp", version: "0.1.0" });
  registerListGuilds(server, ctx);
  registerListChannels(server, ctx);
  registerReadMessages(server, ctx);
  registerSearchMessages(server, ctx);
  registerSendMessage(server, ctx);
  registerReplyToMessage(server, ctx);
  registerEditMessage(server, ctx);
  registerAddReaction(server, ctx);
  return server;
}
