// チャンネルごとの実効権限の計算。
// 手順は公式の「Permission Overwrites」に従う：
//   基本 = @everyone ロール | 自分のロール。ADMINISTRATOR かサーバーの所有者なら全権限。
//   次に @everyone の上書き → ロールの上書き（deny をまとめて外し allow をまとめて足す）→ メンバー個別の上書き。
// https://docs.discord.com/developers/topics/permissions#permission-overwrites
import type { APIChannel, APIGuild, APIOverwrite, Snowflake } from "./types";

export const Permission = {
  CreateInstantInvite: 1n << 0n,
  Administrator: 1n << 3n,
  AddReactions: 1n << 6n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  EmbedLinks: 1n << 14n,
  AttachFiles: 1n << 15n,
  ReadMessageHistory: 1n << 16n,
  MentionEveryone: 1n << 17n,
  UseExternalEmojis: 1n << 18n,
  ManageThreads: 1n << 34n,
  SendMessagesInThreads: 1n << 38n,
} as const;

const ALL = (1n << 64n) - 1n;

export function computeBasePermissions(guild: APIGuild, memberId: Snowflake, memberRoles: Snowflake[]): bigint {
  if (guild.owner_id === memberId) return ALL;
  const everyone = guild.roles.find((r) => r.id === guild.id);
  let perms = everyone ? BigInt(everyone.permissions) : 0n;
  for (const roleId of memberRoles) {
    const role = guild.roles.find((r) => r.id === roleId);
    if (role) perms |= BigInt(role.permissions);
  }
  if ((perms & Permission.Administrator) === Permission.Administrator) return ALL;
  return perms;
}

export function applyOverwrites(
  base: bigint,
  guildId: Snowflake,
  memberId: Snowflake,
  memberRoles: Snowflake[],
  overwrites: APIOverwrite[] | undefined,
): bigint {
  if ((base & Permission.Administrator) === Permission.Administrator) return ALL;
  let perms = base;
  const list = overwrites ?? [];
  const everyone = list.find((o) => o.type === 0 && o.id === guildId);
  if (everyone) {
    perms &= ~BigInt(everyone.deny);
    perms |= BigInt(everyone.allow);
  }
  let allow = 0n;
  let deny = 0n;
  for (const o of list) {
    if (o.type === 0 && o.id !== guildId && memberRoles.includes(o.id)) {
      allow |= BigInt(o.allow);
      deny |= BigInt(o.deny);
    }
  }
  perms &= ~deny;
  perms |= allow;
  const member = list.find((o) => o.type === 1 && o.id === memberId);
  if (member) {
    perms &= ~BigInt(member.deny);
    perms |= BigInt(member.allow);
  }
  return perms;
}

// チャンネル（スレッドなら親チャンネル）の実効権限。VIEW_CHANNEL が無ければ他の権限も無いものとして 0 を返す
export function channelPermissions(
  guild: APIGuild,
  memberId: Snowflake,
  memberRoles: Snowflake[],
  channel: Pick<APIChannel, "permission_overwrites">,
): bigint {
  const base = computeBasePermissions(guild, memberId, memberRoles);
  const perms = applyOverwrites(base, guild.id, memberId, memberRoles, channel.permission_overwrites);
  if ((perms & Permission.ViewChannel) === 0n) return 0n;
  return perms;
}

export const has = (perms: bigint, flag: bigint) => (perms & flag) === flag;
