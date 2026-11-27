// Discord Gateway（WebSocket）の最小クライアント。
// 公式の接続手順（https://docs.discord.com/developers/events/gateway）どおりに、
// Hello → Identify / Resume、ハートビート（初回はジッター付き）、ACK が来なければ接続を捨てて Resume、
// Reconnect(7) と Invalid Session(9) の処理、再接続の指数バックオフを行う。
import type { APIGatewayBotInfo, Rest } from "@discord-mcp/discord";

export const Intents = {
  Guilds: 1 << 0,
  GuildMessages: 1 << 9,
  MessageContent: 1 << 15,
} as const;

export const DEFAULT_INTENTS = Intents.Guilds | Intents.GuildMessages | Intents.MessageContent;

const Op = {
  Dispatch: 0,
  Heartbeat: 1,
  Identify: 2,
  Resume: 6,
  Reconnect: 7,
  InvalidSession: 9,
  Hello: 10,
  HeartbeatAck: 11,
} as const;

// 再接続しても直らない（設定を直す必要がある）クローズコード
export const FATAL_CLOSE_CODES = new Map<number, string>([
  [4004, "Botトークンが正しくない（Authentication failed）"],
  [4010, "シャードの指定が正しくない"],
  [4011, "シャーディングが必要"],
  [4012, "Gateway のバージョンが正しくない"],
  [4013, "intents の値が正しくない"],
  [4014, "許可されていない intents（Developer Portal で Message Content Intent をオンにする）"],
]);
// 再接続はするが、セッションは作り直す（Resume できない）コード
const REIDENTIFY_CLOSE_CODES = new Set([4007, 4009]);
// 自分から閉じるときのコード。1000/1001 以外ならセッションは Resume できる状態で残る
const RESUMABLE_CLOSE = 4900;
// Resume を続けて何回失敗したら Identify からやり直すか
const MAX_RESUME_ATTEMPTS = 3;
// この時間つながっていたら安定とみなして、再接続のバックオフを戻す
const STABLE_MS = 60_000;

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface GatewayOptions {
  token: string;
  intents?: number;
  rest: Pick<Rest, "get">;
  createSocket?: (url: string) => SocketLike;
  onDispatch: (event: string, data: unknown) => void;
  onFatal: (reason: string) => void;
  log?: (msg: string) => void;
  random?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  now?: () => number;
}

type Payload = { op: number; d: unknown; s: number | null; t: string | null };

export class Gateway {
  private socket: SocketLike | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private gatewayUrl: string | null = null;
  private heartbeatTimer: unknown = null;
  private heartbeatInterval = 0;
  private acked = true;
  private reconnectTimer: unknown = null;
  private helloTimer: unknown = null;
  private failures = 0;
  private resumeAttempts = 0;
  private stableTimer: unknown = null;
  private stopped = false;
  private readonly log: (msg: string) => void;
  private readonly random: () => number;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (handle: unknown) => void;
  private readonly intents: number;

  constructor(private readonly opts: GatewayOptions) {
    this.log = opts.log ?? ((m) => console.log(m));
    this.random = opts.random ?? Math.random;
    this.setT = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.intents = opts.intents ?? DEFAULT_INTENTS;
  }

  get connected(): boolean {
    return this.socket !== null;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  // 終了時。1000 で閉じてセッションを捨てる（Bot はオフライン表示になる）
  stop(): void {
    this.stopped = true;
    this.clearT(this.reconnectTimer);
    this.clearT(this.helloTimer);
    this.clearT(this.stableTimer);
    this.stopHeartbeat();
    const s = this.socket;
    this.socket = null;
    s?.close(1000, "shutdown");
  }

  private canResume(): boolean {
    return this.sessionId !== null && this.seq !== null && this.resumeUrl !== null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    // Resume が続けて失敗するなら、セッションを捨てて Identify からやり直す
    if (this.canResume() && this.resumeAttempts >= MAX_RESUME_ATTEMPTS) {
      this.log(`gateway: Resume が ${this.resumeAttempts} 回続けて失敗。新しいセッションで入り直す`);
      this.clearSession();
    }
    let base: string;
    if (this.canResume()) {
      base = this.resumeUrl!;
      this.resumeAttempts += 1;
    } else {
      try {
        const info = await this.opts.rest.get<APIGatewayBotInfo>("/gateway/bot");
        // 待っている間に stop() されていたら何もしない
        if (this.stopped) return;
        // 1日の Identify 上限（既定1000回）を使い切っていたら、回復するまで待つ
        if (info.session_start_limit.remaining <= 0) {
          const wait = info.session_start_limit.reset_after + 1000;
          this.log(`gateway: Identify の残り回数が0。${Math.ceil(wait / 1000)} 秒待つ`);
          this.reconnectTimer = this.setT(() => void this.connect(), wait);
          return;
        }
        this.gatewayUrl = info.url;
      } catch (err) {
        if (this.stopped) return;
        const status = (err as { status?: number }).status;
        if (status === 401) {
          this.fatal("Botトークンが正しくない（/gateway/bot が 401）");
          return;
        }
        this.log(`gateway: /gateway/bot の取得に失敗（${(err as Error).message}）`);
        this.scheduleReconnect();
        return;
      }
      base = this.gatewayUrl!;
    }
    const url = `${base.replace(/\/+$/, "")}/?v=10&encoding=json`;
    const create = this.opts.createSocket ?? ((u: string) => new WebSocket(u) as unknown as SocketLike);
    let socket: SocketLike;
    try {
      socket = create(url);
    } catch (err) {
      this.log(`gateway: 接続を開けない（${(err as Error).message}）`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.acked = true;
    // 接続が途中で止まって Hello が来ないときに備える
    this.clearT(this.helloTimer);
    this.helloTimer = this.setT(() => {
      if (this.socket === socket) {
        this.log("gateway: Hello が来ない。つなぎ直す");
        this.closeSocket("hello timeout");
        this.scheduleReconnect();
      }
    }, 30_000);
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      let p: Payload;
      try {
        p = JSON.parse(String(ev.data)) as Payload;
      } catch {
        return;
      }
      try {
        this.handle(p);
      } catch (err) {
        // 想定外の形のペイロードで受信が止まらないように
        this.log(`gateway: 受信の処理で例外（${(err as Error).message}）`);
      }
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearT(this.stableTimer);
      this.stopHeartbeat();
      this.handleClose(ev.code, ev.reason);
    };
    socket.onerror = () => {
      // close も続けて来るので、ここではログだけ
      if (this.socket === socket) this.log("gateway: WebSocket エラー");
    };
  }

  private send(op: number, d: unknown): void {
    this.socket?.send(JSON.stringify({ op, d }));
  }

  private handle(p: Payload): void {
    if (typeof p.s === "number") this.seq = p.s;
    switch (p.op) {
      case Op.Hello: {
        this.clearT(this.helloTimer);
        const interval = (p.d as { heartbeat_interval: number }).heartbeat_interval;
        this.startHeartbeat(interval);
        if (this.canResume()) {
          this.send(Op.Resume, { token: this.opts.token, session_id: this.sessionId, seq: this.seq });
        } else {
          this.send(Op.Identify, {
            token: this.opts.token,
            intents: this.intents,
            properties: { os: process.platform, browser: "discord-mcp", device: "discord-mcp" },
          });
        }
        return;
      }
      case Op.HeartbeatAck:
        this.acked = true;
        return;
      case Op.Heartbeat:
        this.send(Op.Heartbeat, this.seq);
        return;
      case Op.Reconnect:
        this.log("gateway: Reconnect を受信。Resume する");
        this.dropSocket();
        return;
      case Op.InvalidSession: {
        const resumable = p.d === true;
        this.log(`gateway: Invalid Session（resumable=${resumable}）`);
        if (!resumable) this.clearSession();
        // 公式の推奨どおり1〜5秒待ってからつなぎ直す。繰り返すならバックオフでさらに延ばす
        this.closeSocket("invalid session");
        this.scheduleReconnect(1000 + Math.floor(this.random() * 4000));
        return;
      }
      case Op.Dispatch: {
        if (p.t === "READY") {
          const d = p.d as { session_id: string; resume_gateway_url: string; user?: { id: string } };
          this.sessionId = d.session_id;
          this.resumeUrl = d.resume_gateway_url;
          this.resumeAttempts = 0;
          this.markStable();
          this.log("gateway: READY");
        } else if (p.t === "RESUMED") {
          this.resumeAttempts = 0;
          this.markStable();
          this.log("gateway: RESUMED");
        }
        if (p.t) {
          try {
            this.opts.onDispatch(p.t, p.d);
          } catch (err) {
            this.log(`gateway: イベント処理で例外（${(err as Error).message}）`);
          }
        }
        return;
      }
    }
  }

  private startHeartbeat(interval: number): void {
    this.stopHeartbeat();
    this.heartbeatInterval = interval;
    this.acked = true;
    const beat = () => {
      if (!this.socket) return;
      if (!this.acked) {
        // 前回の ACK が来ていない＝ゾンビ接続。捨てて Resume する
        this.log("gateway: ハートビートの ACK が来ない。つなぎ直す");
        this.dropSocket();
        return;
      }
      this.acked = false;
      this.send(Op.Heartbeat, this.seq);
      this.heartbeatTimer = this.setT(beat, this.heartbeatInterval);
    };
    this.heartbeatTimer = this.setT(beat, Math.floor(interval * this.random()));
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) this.clearT(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  // つながってから STABLE_MS 続いたら、バックオフの回数を戻す（すぐ切れる接続でバックオフが戻らないように）
  private markStable(): void {
    this.clearT(this.stableTimer);
    this.stableTimer = this.setT(() => {
      this.stableTimer = null;
      this.failures = 0;
    }, STABLE_MS);
  }

  private closeSocket(reason: string): void {
    const s = this.socket;
    this.socket = null;
    this.clearT(this.stableTimer);
    this.stopHeartbeat();
    s?.close(RESUMABLE_CLOSE, reason);
  }

  // 自分から閉じて、Resume で入り直す（バックオフに従う）
  private dropSocket(): void {
    this.closeSocket("reconnect");
    this.scheduleReconnect();
  }

  private clearSession(): void {
    this.sessionId = null;
    this.seq = null;
    this.resumeUrl = null;
  }

  private handleClose(code: number, reason: string): void {
    if (this.stopped) return;
    const fatal = FATAL_CLOSE_CODES.get(code);
    if (fatal) {
      this.fatal(`${fatal}（close ${code}）`);
      return;
    }
    if (REIDENTIFY_CLOSE_CODES.has(code)) this.clearSession();
    this.log(`gateway: 切断（close ${code}${reason ? ` ${reason.slice(0, 80)}` : ""}）。つなぎ直す`);
    this.scheduleReconnect();
  }

  private scheduleReconnect(atLeastMs = 0): void {
    if (this.stopped) return;
    this.failures += 1;
    // 1秒から倍々で最大60秒。ジッターで ±20%
    const base = Math.min(60_000, 1000 * 2 ** Math.min(this.failures - 1, 6));
    const delay = Math.max(atLeastMs, Math.floor(base * (0.8 + this.random() * 0.4)));
    this.clearT(this.reconnectTimer);
    this.reconnectTimer = this.setT(() => void this.connect(), delay);
  }

  private fatal(reason: string): void {
    this.stopped = true;
    this.clearSession();
    this.log(`gateway: 停止（${reason}）`);
    this.opts.onFatal(reason);
  }
}
