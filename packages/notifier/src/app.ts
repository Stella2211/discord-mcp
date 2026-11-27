// 受け取ったメッセージを振り分けて、Duet への通知を組み立てる本体。外部との出入りは引数で受け取る（テストで差し替える）。
import type { APIMessage, Rest } from "@discord-mcp/discord";
import type { Config } from "./config";
import { judge, type DecisionModel } from "./decision";
import type { Directory } from "./directory";
import { resolveRoute } from "./routing";
import { classify, WHY_LABEL } from "./filter";
import { authorName, directNotice, messageText, passthroughNotice, relevantNotice, unjudgedNotice, type Place } from "./format";
import { jst, messageImages } from "@discord-mcp/discord";
import { loadImages } from "./decision/images";

export interface NotifierDeps {
  config: Config;
  rest: Pick<Rest, "get">;
  directory: Directory;
  model: DecisionModel | null;
  // route は duet-send の宛先。無ければ既定の宛先
  queue: { push(text: string, route?: string): void };
  // 画像のダウンロードに使う（テストで差し替える）
  fetchImage?: typeof fetch;
  log?: (msg: string) => void;
  // LOG_LEVEL=debug のときだけ渡す。無視した理由などを出す（本文は出さない）
  debug?: (msg: string) => void;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
}

interface PendingChannel {
  guildId: string;
  messages: APIMessage[];
  firstAt: number;
  timer: unknown;
}

// 判定モデルが続けて失敗したら Duet に知らせる。知らせるのは6時間に1回まで
const FAILURE_THRESHOLD = 3;
const FAILURE_NOTICE_INTERVAL_MS = 6 * 3600_000;

export class Notifier {
  botUserId: string | null = null;
  private pending = new Map<string, PendingChannel>();
  private chain: Promise<void> = Promise.resolve();
  private failures = 0;
  private lastFailureNoticeAt = -Infinity;
  private readonly log: (m: string) => void;
  private readonly now: () => number;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (h: unknown) => void;

  constructor(private readonly d: NotifierDeps) {
    this.log = d.log ?? ((m) => console.log(m));
    this.now = d.now ?? Date.now;
    this.setT = d.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = d.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  // Gateway のイベント。メッセージ処理は待たずに走らせる（Gateway の受信を止めない）
  onDispatch(event: string, data: unknown): void {
    this.d.directory.onDispatch(event, data);
    if (event === "READY") {
      this.botUserId = (data as { user?: { id: string } }).user?.id ?? null;
      if (this.botUserId && this.botUserId === this.d.config.TARGET_USER_ID) {
        this.log(
          "notifier: TARGET_USER_ID が Bot 自身のユーザーIDになっている。あなた自身のユーザーIDにする" +
            "（そのままだと、あなたの投稿が他人の投稿として判定され、Bot へのメンションが「あなたへのメンション」として届く）",
        );
      }
    } else if (event === "MESSAGE_CREATE") {
      void this.handleMessage(data as APIMessage).catch((err) => this.log(`notifier: 処理に失敗（${(err as Error).message}）`));
    }
  }

  async handleMessage(msg: APIMessage): Promise<void> {
    const c = this.d.config;
    if (!msg.guild_id) {
      this.d.debug?.(`notifier: 無視（dm、channel ${msg.channel_id}, message ${msg.id}）`);
      return;
    }
    const channel = await this.d.directory.channel(msg.channel_id);
    const targetRoleIds = msg.mention_roles.length > 0 ? await this.d.directory.targetRoles(msg.guild_id) : [];
    const verdict = classify(
      msg,
      {
        targetUserId: c.TARGET_USER_ID,
        botUserId: this.botUserId,
        allowedGuildIds: c.ALLOWED_GUILD_IDS,
        ignoreChannelIds: c.IGNORE_CHANNEL_IDS,
        keywords: c.KEYWORDS,
        includeBotMessages: c.INCLUDE_BOT_MESSAGES,
        notifyBotMentions: c.NOTIFY_BOT_MENTIONS,
        notifyEveryone: c.NOTIFY_EVERYONE,
        includeSelf: !this.d.model,
      },
      { targetRoleIds, parentChannelId: channel.parentId },
    );
    if (verdict.kind === "ignore") {
      this.d.debug?.(`notifier: 無視（${verdict.why}、channel ${msg.channel_id}, message ${msg.id}）`);
      return;
    }
    // Bot は見られても本人が見られないチャンネル（管理者用など）の投稿は知らせない
    // 本人へのメンションは非公開スレッドに本人を加えるので、参加の控えに関わらず見られるとみなす
    const mentioned = verdict.kind === "notify" && verdict.why === "mention";
    if (!(await this.d.directory.targetCanView(msg.guild_id, channel, { mentioned }))) {
      this.log(`notifier: 本人が見られないチャンネルなので通知しない（channel ${msg.channel_id}）`);
      return;
    }

    const place = this.place(msg.guild_id, msg.channel_id, channel.name);
    const route = this.route(msg.guild_id, msg.channel_id, channel);
    if (verdict.kind === "notify") {
      const context = await this.recent(msg.channel_id, c.MENTION_CONTEXT_MESSAGES, msg.id);
      this.log(`notifier: ${verdict.why} を通知（channel ${msg.channel_id}, message ${msg.id}）`);
      this.d.queue.push(directNotice(WHY_LABEL[verdict.why], place, msg, context), route);
      // 同じチャンネルで判定待ちの投稿のうち、この通知の文脈に入ったものは判定を取りやめる
      this.dropPending(msg.channel_id, new Set([msg.id, ...context.map((m) => m.id)]));
      return;
    }
    // 判定モデルが無いときも、判定待ちと同じようにまとめて（デバウンスして）そのまま知らせる
    this.addCandidate(msg);
  }

  private place(guildId: string, channelId: string, channelName: string): Place {
    return { guildId, guildName: this.d.directory.guildName(guildId), channelId, channelName };
  }

  // スレッドなら親チャンネルも見る
  private route(guildId: string, channelId: string, channel: { parentId: string | null; isThread: boolean }): string | undefined {
    return resolveRoute(this.d.config.DUET_ROUTES, {
      channelId,
      parentChannelId: channel.isThread ? channel.parentId : null,
      guildId,
    });
  }

  // 直前の投稿（古い順）。取れなければ空
  private async recent(channelId: string, limit: number, before?: string): Promise<APIMessage[]> {
    if (limit <= 0) return [];
    try {
      const list = await this.d.rest.get<APIMessage[]>(`/channels/${channelId}/messages`, { limit, before });
      return [...list].reverse();
    } catch (err) {
      this.log(`notifier: 履歴の取得に失敗（${(err as Error).message}）`);
      return [];
    }
  }

  private addCandidate(msg: APIMessage): void {
    const c = this.d.config;
    let p = this.pending.get(msg.channel_id);
    if (!p) {
      p = { guildId: msg.guild_id!, messages: [], firstAt: this.now(), timer: null };
      this.pending.set(msg.channel_id, p);
    }
    p.messages.push(msg);
    this.clearT(p.timer);
    const sinceFirst = this.now() - p.firstAt;
    const wait = Math.max(0, Math.min(c.DECISION_DEBOUNCE_SECONDS * 1000, c.DECISION_MAX_WAIT_SECONDS * 1000 - sinceFirst));
    const channelId = msg.channel_id;
    p.timer = this.setT(() => this.flushChannel(channelId), wait);
  }

  private dropPending(channelId: string, ids: Set<string>): void {
    const p = this.pending.get(channelId);
    if (!p) return;
    p.messages = p.messages.filter((m) => !ids.has(m.id));
    if (p.messages.length > 0) return;
    this.clearT(p.timer);
    this.pending.delete(channelId);
  }

  get pendingChannels(): number {
    return this.pending.size;
  }

  // 判定は1件ずつ順番に行う（ローカルのモデルに負荷をかけすぎない）
  flushChannel(channelId: string): Promise<void> {
    const p = this.pending.get(channelId);
    if (!p) return this.chain;
    this.pending.delete(channelId);
    this.chain = this.chain.then(() => this.evaluate(channelId, p)).catch((err) => this.log(`notifier: 判定に失敗（${(err as Error).message}）`));
    return this.chain;
  }

  private async evaluate(channelId: string, p: PendingChannel): Promise<void> {
    const model = this.d.model;
    const c = this.d.config;
    const channel = await this.d.directory.channel(channelId);
    const route = this.route(p.guildId, channelId, channel);
    if (!model) {
      this.log(`notifier: 判定なしで通知（channel ${channelId}, ${p.messages.length} 件）`);
      this.d.queue.push(passthroughNotice(this.place(p.guildId, channelId, channel.name), p.messages), route);
      return;
    }
    const history = await this.recent(channelId, c.DECISION_HISTORY_MESSAGES);
    const newIds = new Set(p.messages.map((m) => m.id));
    // 混んでいるチャンネルでは、判定対象が取得した履歴より古いことがある。足して時系列に並べ直す
    const byId = new Map(history.map((m) => [m.id, m]));
    for (const m of p.messages) if (!byId.has(m.id)) byId.set(m.id, m);
    const all = [...byId.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    // 本人がすでに後から発言していれば、本人は話題を見ている。判定せずに終える
    const lastNew = p.messages[p.messages.length - 1]!;
    if (all.some((m) => m.author.id === c.TARGET_USER_ID && BigInt(m.id) > BigInt(lastNew.id))) return;

    const input = {
      guildName: this.d.directory.guildName(p.guildId),
      channelName: channel.name,
      messages: all.map((m) => ({
        author: authorName(m),
        isTarget: m.author.id === c.TARGET_USER_ID,
        at: jst(m.timestamp),
        content: messageText(m, 600),
        isNew: newIds.has(m.id),
        images: messageImages(m).map((r) => ({ url: r.url, filename: r.filename })),
      })),
      attachedImages: undefined as Awaited<ReturnType<typeof loadImages>> | undefined,
    };
    if (c.DECISION_IMAGES) {
      // 判定する新しい投稿の画像を新しい方から、足りなければ文脈の画像を、4枚までモデルに渡す
      const order = [...all].reverse().sort((a, b) => Number(newIds.has(b.id)) - Number(newIds.has(a.id)));
      const loaded = await loadImages(order.flatMap((m) => messageImages(m)), { fetch: this.d.fetchImage });
      if (loaded.length > 0) input.attachedImages = loaded;
    }
    const place = this.place(p.guildId, channelId, channel.name);
    const j = await judge(model, input);
    if (j.error !== undefined) {
      // 見逃さないため、判定できなかった投稿は未判定のまま知らせる（fail-open）
      this.failures += 1;
      this.log(`notifier: 判定モデルの呼び出しに失敗、未判定で通知（${j.error}）`);
      this.d.queue.push(unjudgedNotice(j.error, place, p.messages, model.name), route);
      if (this.failures >= FAILURE_THRESHOLD && this.now() - this.lastFailureNoticeAt > FAILURE_NOTICE_INTERVAL_MS) {
        this.lastFailureNoticeAt = this.now();
        this.d.queue.push(
          `Discord 通知Botのお知らせ: 判定モデル（${model.name}）の呼び出しが ${this.failures} 回続けて失敗しています。` +
            "その間の投稿は判定せずにすべて知らせています。モデルのサーバー、API トークン、使用量の上限を確認してください。",
        );
      }
      return;
    }
    this.failures = 0;
    const decision = j.decision;
    // 確率と重要度だけを足す（理由の文には投稿の中身が入ることがあるので出さない）
    const score =
      decision.probability !== undefined
        ? `, 確率 ${decision.probability.toFixed(2)}${decision.priority !== undefined ? `, 重要度 ${decision.priority.toFixed(1)}/3` : ""}`
        : "";
    this.log(`notifier: 判定 ${decision.relevant ? "関係あり" : "関係なし"}（channel ${channelId}, ${p.messages.length} 件${score}）`);
    if (decision.relevant) {
      this.d.queue.push(relevantNotice(decision.reason, place, p.messages, model.name), route);
    }
  }
}
