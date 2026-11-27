// Discord API v10 のうち、このリポジトリが使う項目だけの型。
// 公式の全項目は https://docs.discord.com/developers/resources を参照。

export type Snowflake = string;

export interface APIUser {
  id: Snowflake;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}

export interface APIGuildMember {
  user?: APIUser;
  nick?: string | null;
  roles: Snowflake[];
}

export interface APIRole {
  id: Snowflake;
  name: string;
  permissions: string;
  position: number;
}

export interface APIPartialGuild {
  id: Snowflake;
  name: string;
  owner?: boolean;
  permissions?: string;
}

export interface APIGuild extends APIPartialGuild {
  owner_id: Snowflake;
  roles: APIRole[];
}

export interface APIOverwrite {
  id: Snowflake;
  // 0 = ロール、1 = メンバー
  type: 0 | 1;
  allow: string;
  deny: string;
}

export interface APIChannel {
  id: Snowflake;
  type: number;
  guild_id?: Snowflake;
  name?: string | null;
  topic?: string | null;
  position?: number;
  parent_id?: Snowflake | null;
  permission_overwrites?: APIOverwrite[];
  nsfw?: boolean;
  flags?: number;
  thread_metadata?: { archived: boolean; locked?: boolean };
}

export interface APIAttachment {
  id: Snowflake;
  filename: string;
  size: number;
  content_type?: string;
  url?: string;
  proxy_url?: string;
  width?: number | null;
  height?: number | null;
}

interface APIEmbedMedia {
  url?: string;
  proxy_url?: string;
  width?: number;
  height?: number;
}

export interface APIEmbed {
  type?: string;
  title?: string;
  url?: string;
  image?: APIEmbedMedia;
  thumbnail?: APIEmbedMedia;
}

export interface APIReaction {
  count: number;
  me: boolean;
  emoji: { id: Snowflake | null; name: string | null };
}

export interface APIMessageReference {
  message_id?: Snowflake;
  channel_id?: Snowflake;
  guild_id?: Snowflake;
}

export interface APIMessage {
  id: Snowflake;
  channel_id: Snowflake;
  guild_id?: Snowflake;
  author: APIUser;
  member?: { nick?: string | null; roles?: Snowflake[] };
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  type: number;
  mentions: APIUser[];
  mention_roles: Snowflake[];
  mention_everyone: boolean;
  attachments: APIAttachment[];
  embeds: APIEmbed[];
  reactions?: APIReaction[];
  message_reference?: APIMessageReference;
  referenced_message?: APIMessage | null;
  webhook_id?: Snowflake;
  flags?: number;
}

export interface APIGatewayBotInfo {
  url: string;
  shards: number;
  session_start_limit: { total: number; remaining: number; reset_after: number; max_concurrency: number };
}

// GET /guilds/{guild.id}/messages/search
export interface APIMessageSearchResult {
  doing_deep_historical_index?: boolean;
  documents_indexed?: number;
  total_results: number;
  messages: APIMessage[][];
  threads?: APIChannel[];
}

// 索引が未作成のとき 202 で返る本文
export interface APIIndexNotReady {
  code: number;
  message: string;
  documents_indexed?: number;
  retry_after?: number;
}

// チャンネル種別（https://docs.discord.com/developers/resources/channel#channel-object-channel-types）
export const ChannelType = {
  GuildText: 0,
  DM: 1,
  GuildVoice: 2,
  GroupDM: 3,
  GuildCategory: 4,
  GuildAnnouncement: 5,
  AnnouncementThread: 10,
  PublicThread: 11,
  PrivateThread: 12,
  GuildStageVoice: 13,
  GuildDirectory: 14,
  GuildForum: 15,
  GuildMedia: 16,
} as const;

export const THREAD_TYPES: ReadonlySet<number> = new Set([10, 11, 12]);
