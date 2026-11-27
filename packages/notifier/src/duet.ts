// duet-send を呼んで Claude Duet のコーディネーターに知らせる。
// 送信は重い（claude -p --cloud を1回起動する）ので、最短間隔を空け、その間に溜まった通知は1通にまとめる。
import { dirname } from "node:path";

// duet-send の上限は8000文字（タグ込み）。余裕を見てこの長さで区切る
export const MAX_MESSAGE_CHARS = 7000;
const SEPARATOR = "\n\n----------\n\n";

const OPEN_TAG = "<untrusted_discord>";
const CLOSE_TAG = "</untrusted_discord>";

// 上限を超えた通知を切る。区切りの途中で切れたら閉じタグを付け直す（閉じないと、後ろの通知まで区切りの中に見える）
export function truncateNotice(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  const tail = `\n…（長いので省略）\n${CLOSE_TAG}`;
  let cut = text.slice(0, MAX_MESSAGE_CHARS - tail.length);
  // サロゲートペアの途中で切らない
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  const open = cut.lastIndexOf(OPEN_TAG);
  const inside = open >= 0 && cut.indexOf(CLOSE_TAG, open) < 0;
  return inside ? cut + tail : `${cut}\n…（長いので省略）`;
}

export type SendFn = (text: string) => Promise<void>;

export interface DuetQueueOptions {
  send: SendFn;
  minIntervalMs: number;
  log?: (msg: string) => void;
  // 送信が連続して失敗しはじめたとき（FAILURE_STREAK 回目）に1回だけ呼ぶ。成功すると数え直す
  onFailureStreak?: (err: Error) => void;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
}

// 連続して何回失敗したら知らせるか
export const FAILURE_STREAK = 3;

// 未送信として溜めておく件数の上限。超えたら古いものから捨てる
export const MAX_PENDING = 50;

export class DuetQueue {
  private pending: string[] = [];
  private lastSentAt = -Infinity;
  private timer: unknown = null;
  private sending = false;
  // 送信中の通知の件数（先頭から数える）。送信が終わるまで捨てない
  private inflight = 0;
  // 上限で捨てた件数（送信のたびに1行にまとめてログに出す）
  private dropped = 0;
  private failures = 0;
  private readonly log: (m: string) => void;
  private readonly now: () => number;
  private readonly setT: (fn: () => void, ms: number) => unknown;

  constructor(private readonly o: DuetQueueOptions) {
    this.log = o.log ?? ((m) => console.log(m));
    this.now = o.now ?? Date.now;
    this.setT = o.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  }

  get size(): number {
    return this.pending.length;
  }

  // 送信中か（終了時に、送り終わるのを待つため）
  get busy(): boolean {
    return this.sending;
  }

  push(text: string): void {
    this.pending.push(truncateNotice(text));
    this.trim();
    this.schedule();
  }

  // 送信中の分を除いて上限を超えた分を、古いものから捨てる
  private trim(): void {
    const over = this.pending.length - this.inflight - MAX_PENDING;
    if (over <= 0) return;
    this.pending.splice(this.inflight, over);
    this.dropped += over;
  }

  private schedule(): void {
    if (this.timer !== null || this.sending || this.pending.length === 0) return;
    // 失敗が続いたら間隔を倍々に延ばす（最大で32倍）
    const interval = this.o.minIntervalMs * 2 ** Math.min(this.failures, 5);
    const wait = Math.max(0, this.lastSentAt + interval - this.now());
    this.timer = this.setT(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  // 溜まった通知を、上限に収まるだけまとめて1通送る
  async flush(): Promise<void> {
    if (this.sending || this.pending.length === 0) return;
    this.sending = true;
    let text = this.pending[0]!;
    let taken = 1;
    while (taken < this.pending.length && text.length + SEPARATOR.length + this.pending[taken]!.length <= MAX_MESSAGE_CHARS) {
      text += SEPARATOR + this.pending[taken]!;
      taken += 1;
    }
    this.inflight = taken;
    if (taken > 1) text = `（Discord の通知 ${taken} 件をまとめて送ります）${SEPARATOR}${text}`;
    try {
      await this.o.send(text);
      this.pending.splice(0, taken);
      this.inflight = 0;
      this.failures = 0;
      this.log(`duet: ${taken} 件を送信`);
    } catch (err) {
      // 失敗した分は残して、間隔を空けてもう一度試す。溜まりすぎたら古いものから捨てる
      this.inflight = 0;
      this.failures += 1;
      this.log(`duet: 送信に失敗（${(err as Error).message}）`);
      if (this.failures === FAILURE_STREAK) {
        try {
          this.o.onFailureStreak?.(err as Error);
        } catch {
          // 知らせる側の失敗で、再送を止めない
        }
      }
      this.trim();
    } finally {
      if (this.dropped > 0) {
        this.log(`duet: 未送信が多すぎるので ${this.dropped} 件を捨てた`);
        this.dropped = 0;
      }
      this.lastSentAt = this.now();
      this.sending = false;
      this.schedule();
    }
  }
}

// 宛先ごとに DuetQueue を持つ（宛先が違う通知は1通にまとめない）。キューは使うときに作る。route 無しは既定の宛先
export class DuetRouter {
  private readonly queues = new Map<string | undefined, DuetQueue>();

  constructor(private readonly make: (route: string | undefined) => DuetQueue) {}

  push(text: string, route?: string): void {
    let q = this.queues.get(route);
    if (!q) {
      q = this.make(route);
      this.queues.set(route, q);
    }
    q.push(text);
  }

  // 全キューの未送信の合計
  get size(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.size;
    return n;
  }

  // どれかが送信中か
  get busy(): boolean {
    for (const q of this.queues.values()) if (q.busy) return true;
    return false;
  }

  // 送信中でないキューの溜まった通知を、それぞれ送る
  async flush(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.flush()));
  }
}

// duet-send と、その先の claude に渡さない環境変数（この Bot のシークレット）
const PRIVATE_ENV = new Set(["DISCORD_BOT_TOKEN", "ANTHROPIC_API_KEY", "DECISION_API_KEY", "CLOUDFLARE_AI_TOKEN"]);

export function childEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !PRIVATE_ENV.has(k)) out[k] = v;
  return out;
}

export interface DuetSendOptions {
  scriptPath: string;
  tag: string;
  // duet-send の宛先の名前（--to）。無ければ duet-send の既定の宛先
  route?: string;
  dryRun: boolean;
  bunPath?: string;
  timeoutMs?: number;
}

// 子プロセスごと止める（duet-send は claude を子として起動する）。
// Windows 以外は duet-send を専用のプロセスグループで起動してあるので、グループごと SIGKILL する（孫まで届き、SIGTERM を握る子も止まる）
function killTree(proc: { pid: number; kill: (sig?: number | NodeJS.Signals) => void }): void {
  try {
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
    } else {
      process.kill(-proc.pid, "SIGKILL");
    }
  } catch {
    // taskkill がなくても、グループがもう無くても、本体は止める
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    // もう終わっている
  }
}

// 実行中の duet-send。終了の待ち時間が過ぎても送信が終わらないとき、main.ts が子プロセスごと止めるために覚えておく
const inflightSends = new Set<{ pid: number; kill: (sig?: number | NodeJS.Signals) => void }>();

// 実行中の duet-send を、すべて子プロセスごと止める。止めた数を返す
export function killInflightSends(): number {
  const procs = [...inflightSends];
  for (const proc of procs) killTree(proc);
  inflightSends.clear();
  return procs.length;
}

// 出力を読む。子が出力を開いたまま残っても待ち続けないよう、少しだけ待つ
async function readWithin(stream: ReadableStream<Uint8Array>, ms: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), ms);
  });
  try {
    return await Promise.race([new Response(stream).text().catch(() => ""), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// duet-send をサブプロセスで起動し、本文は標準入力で渡す（引数の長さや Windows のクォートの問題を避ける）。
// 止まったままにならないよう、全体に時間の上限を付ける（超えたら子プロセスごと止めて失敗にする）
export function duetSender(o: DuetSendOptions): SendFn {
  return async (text: string) => {
    if (o.dryRun) {
      console.log(`---- DUET_DRY_RUN（送らない） ${o.tag}${o.route !== undefined ? ` 宛先 ${o.route}` : ""} ----\n${text}\n----`);
      return;
    }
    const proc = Bun.spawn([o.bunPath ?? process.execPath, o.scriptPath, "--tag", o.tag, ...(o.route !== undefined ? ["--to", o.route] : [])], {
      // duet-send のフォルダで動かす（duet-send 側の .env が読まれる）
      cwd: dirname(o.scriptPath),
      env: childEnv(process.env),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // Windows 以外は専用のプロセスグループで起動する（時間切れで孫ごと止めるため）
      detached: process.platform !== "win32",
    });
    inflightSends.add(proc);
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(proc);
        resolve(null);
      }, o.timeoutMs ?? 120_000);
    });
    try {
      try {
        proc.stdin.write(text);
        await proc.stdin.end();
      } catch {
        // 子がすぐ終わると書き込みに失敗する。終了コードと出力で判断する
      }
      const code = await Promise.race([proc.exited, timeout]);
      if (timedOut || code === null) throw new Error("duet-send が時間内に終わらなかった");
      const [stdout, stderr] = await Promise.all([readWithin(proc.stdout, 2000), readWithin(proc.stderr, 2000)]);
      if (code !== 0) throw new Error(`duet-send が終了コード ${code}: ${(stderr || stdout).trim().slice(0, 300)}`);
    } finally {
      inflightSends.delete(proc);
      clearTimeout(timer);
    }
  };
}
