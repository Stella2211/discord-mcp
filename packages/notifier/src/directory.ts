// サーバー・チャンネル・ロールと、通知対象の人のメンバー情報のキャッシュ。
// 名前と権限の設定は Gateway の GUILD_CREATE などで埋め、知らないチャンネル（古いスレッドなど）だけ REST で引く。
// 「通知対象の人がそのチャンネルを見られるか」もここで判断する（Bot だけが見られるチャンネルの投稿を知らせないため）。
import type { APIChannel, APIGuild, APIGuildMember, APIMessage, APIOverwrite, APIRole, Rest } from "@discord-mcp/discord";
import { ChannelType, channelPermissions, has, Permission, THREAD_TYPES } from "@discord-mcp/discord";

export interface ChannelInfo {
  id: string;
  name: string;
  guildId: string | null;
  parentId: string | null;
  isThread: boolean;
  isPrivateThread: boolean;
  overwrites: APIOverwrite[] | undefined;
}

interface GuildInfo {
  name: string | null;
  ownerId: string | null;
  roles: Map<string, APIRole>;
}

// メンバー情報のキャッシュ時間。見つからない（404）や取得の失敗は短くして、参加・復旧にすぐ追いつく
const MEMBER_TTL_MS = 60 * 60 * 1000;
const ABSENT_TTL_MS = 5 * 60 * 1000;
const ERROR_TTL_MS = 60 * 1000;

// roles = メンバーのロール、"absent" = サーバーにいない、null = 分からない
type MemberState = string[] | "absent" | null;

export class Directory {
  private guilds = new Map<string, GuildInfo>();
  private channels = new Map<string, ChannelInfo>();
  private members = new Map<string, { state: MemberState; until: number }>();
  // 非公開スレッドに通知対象の人が参加しているか。true / false / null = 分からない
  private threadMembers = new Map<string, { state: boolean | null; until: number }>();

  constructor(
    private readonly rest: Pick<Rest, "get">,
    private readonly targetUserId: string,
    private readonly now: () => number = Date.now,
  ) {}

  private guild(id: string): GuildInfo {
    let g = this.guilds.get(id);
    if (!g) {
      g = { name: null, ownerId: null, roles: new Map() };
      this.guilds.set(id, g);
    }
    return g;
  }

  onDispatch(event: string, data: unknown): void {
    switch (event) {
      case "GUILD_CREATE":
      case "GUILD_UPDATE": {
        const d = data as Partial<APIGuild> & { id: string; unavailable?: boolean; channels?: APIChannel[]; threads?: APIChannel[] };
        if (d.unavailable) return;
        const g = this.guild(d.id);
        if (d.name) g.name = d.name;
        if (d.owner_id) g.ownerId = d.owner_id;
        if (d.roles) g.roles = new Map(d.roles.map((r) => [r.id, r]));
        for (const c of [...(d.channels ?? []), ...(d.threads ?? [])]) this.putChannel({ ...c, guild_id: d.id });
        return;
      }
      case "GUILD_DELETE": {
        const id = (data as { id: string }).id;
        this.guilds.delete(id);
        this.members.delete(id);
        return;
      }
      case "GUILD_ROLE_CREATE":
      case "GUILD_ROLE_UPDATE": {
        const d = data as { guild_id: string; role: APIRole };
        this.guild(d.guild_id).roles.set(d.role.id, d.role);
        return;
      }
      case "GUILD_ROLE_DELETE": {
        const d = data as { guild_id: string; role_id: string };
        this.guilds.get(d.guild_id)?.roles.delete(d.role_id);
        return;
      }
      case "CHANNEL_CREATE":
      case "CHANNEL_UPDATE":
      case "THREAD_CREATE":
      case "THREAD_UPDATE":
        this.putChannel(data as APIChannel);
        return;
      case "CHANNEL_DELETE":
      case "THREAD_DELETE": {
        const id = (data as { id: string }).id;
        this.channels.delete(id);
        this.threadMembers.delete(id);
        return;
      }
      case "MESSAGE_CREATE":
        this.noteThreadMembership(data as APIMessage);
        return;
      case "GUILD_MEMBER_UPDATE": {
        // GUILD_MEMBERS intent がなくても届くことがある。対象の人なら更新
        const m = data as { guild_id: string; user?: { id: string }; roles?: string[] };
        if (m.user?.id === this.targetUserId && m.roles) this.members.set(m.guild_id, { state: m.roles, until: this.now() + MEMBER_TTL_MS });
        return;
      }
    }
  }

  private putChannel(c: APIChannel): void {
    this.channels.set(c.id, {
      id: c.id,
      name: c.name ?? "(名前なし)",
      guildId: c.guild_id ?? null,
      parentId: c.parent_id ?? null,
      isThread: THREAD_TYPES.has(c.type),
      isPrivateThread: c.type === ChannelType.PrivateThread,
      overwrites: c.permission_overwrites,
    });
  }

  // 非公開スレッドの投稿から、通知対象の人の参加を控えに書く（GUILD_MEMBERS intent が無いので THREAD_MEMBERS_UPDATE は届かない）。
  // 加えられた（RECIPIENT_ADD、種別1）か本人が投稿したら参加している、外された（RECIPIENT_REMOVE、種別2）なら参加していない
  private noteThreadMembership(m: APIMessage): void {
    if (!this.channels.get(m.channel_id)?.isPrivateThread && !this.threadMembers.has(m.channel_id)) return;
    const named = m.mentions?.some((u) => u.id === this.targetUserId) ?? false;
    if (m.type === 2 && named) this.threadMembers.set(m.channel_id, { state: false, until: this.now() + ABSENT_TTL_MS });
    else if ((m.type === 1 && named) || m.author?.id === this.targetUserId)
      this.threadMembers.set(m.channel_id, { state: true, until: this.now() + MEMBER_TTL_MS });
  }

  guildName(id: string): string {
    return this.guilds.get(id)?.name ?? id;
  }

  async channel(id: string): Promise<ChannelInfo> {
    const known = this.channels.get(id);
    if (known) return known;
    try {
      const c = await this.rest.get<APIChannel>(`/channels/${id}`);
      this.putChannel(c);
      return this.channels.get(id)!;
    } catch {
      return { id, name: id, guildId: null, parentId: null, isThread: false, isPrivateThread: false, overwrites: undefined };
    }
  }

  // 通知対象の人のメンバー情報。404 なら "absent"、ほかの失敗は null（分からない）
  async targetMember(guildId: string): Promise<MemberState> {
    const cached = this.members.get(guildId);
    if (cached && this.now() < cached.until) return cached.state;
    try {
      const m = await this.rest.get<APIGuildMember>(`/guilds/${guildId}/members/${this.targetUserId}`);
      this.members.set(guildId, { state: m.roles, until: this.now() + MEMBER_TTL_MS });
      return m.roles;
    } catch (err) {
      if ((err as { status?: number }).status === 404) {
        this.members.set(guildId, { state: "absent", until: this.now() + ABSENT_TTL_MS });
        return "absent";
      }
      // 一時的な失敗。前に分かっていたロールがあればそれを使う
      const state = Array.isArray(cached?.state) ? cached.state : null;
      this.members.set(guildId, { state, until: this.now() + ERROR_TTL_MS });
      return state;
    }
  }

  // 通知対象の人が非公開スレッドに参加しているか。404 なら false、ほかの失敗は null（分からない）
  async targetInThread(threadId: string): Promise<boolean | null> {
    const cached = this.threadMembers.get(threadId);
    if (cached && this.now() < cached.until) return cached.state;
    try {
      await this.rest.get(`/channels/${threadId}/thread-members/${this.targetUserId}`);
      this.threadMembers.set(threadId, { state: true, until: this.now() + MEMBER_TTL_MS });
      return true;
    } catch (err) {
      if ((err as { status?: number }).status === 404) {
        this.threadMembers.set(threadId, { state: false, until: this.now() + ABSENT_TTL_MS });
        return false;
      }
      // 一時的な失敗。前に参加していると分かっていればそれを使い、ほかは分からない（知らせる側に倒す）とする
      const state = cached?.state === true ? true : null;
      this.threadMembers.set(threadId, { state, until: this.now() + ERROR_TTL_MS });
      return state;
    }
  }

  // 通知対象の人がそのサーバーで持つロール。分からなければ空
  async targetRoles(guildId: string): Promise<string[]> {
    const m = await this.targetMember(guildId);
    return Array.isArray(m) ? m : [];
  }

  // 通知対象の人がこのチャンネルを見られるか。スレッドは親チャンネルの権限で見る。
  // 非公開スレッドは、親チャンネルを見られて、さらにスレッドに参加している（またはスレッドの管理の権限がある）ときだけ見られる。
  // ただし本人へのメンション（mentioned）はスレッドに本人を加えるので、親チャンネルを見られれば見られるとみなす。
  // サーバーにいなければ false。権限の材料が揃わない（サーバーの情報がまだ無い、取得に失敗した）ときは true にして、通知を落とさない
  async targetCanView(guildId: string, channel: ChannelInfo, opts: { mentioned?: boolean } = {}): Promise<boolean> {
    const member = await this.targetMember(guildId);
    if (member === "absent") return false;
    const g = this.guilds.get(guildId);
    if (member === null || !g || g.ownerId === null || !g.roles.has(guildId)) return true;
    const target = channel.isThread && channel.parentId ? await this.channel(channel.parentId) : channel;
    if (target.guildId !== guildId) return true;
    const guild: APIGuild = { id: guildId, name: g.name ?? guildId, owner_id: g.ownerId, roles: [...g.roles.values()] };
    const perms = channelPermissions(guild, this.targetUserId, member, { permission_overwrites: target.overwrites });
    if (!has(perms, Permission.ViewChannel)) return false;
    if (!channel.isPrivateThread || has(perms, Permission.ManageThreads)) return true;
    if (opts.mentioned) {
      // 「参加していない」の控えはもう古いので捨て、次の投稿で問い合わせ直す
      if (this.threadMembers.get(channel.id)?.state === false) this.threadMembers.delete(channel.id);
      return true;
    }
    // 参加しているかが分からない（取得に失敗した）ときは、ほかの材料と同じく知らせる側に倒す
    return (await this.targetInThread(channel.id)) !== false;
  }
}
