import type { APIMessage } from "@discord-mcp/discord";

export const GUILD = "100000000000000001";
export const CHANNEL = "110000000000000001";
export const TARGET = "200000000000000001";
export const BOT = "200000000000000002";
export const OTHER = "200000000000000003";

let seq = 1000n;
export function msg(over: Partial<APIMessage> = {}): APIMessage {
  seq += 1n;
  return {
    id: (300000000000000000n + seq).toString(),
    channel_id: CHANNEL,
    guild_id: GUILD,
    author: { id: OTHER, username: "other", global_name: "Other" },
    content: "hello",
    timestamp: "2026-11-18T03:00:00.000Z",
    type: 0,
    mentions: [],
    mention_roles: [],
    mention_everyone: false,
    attachments: [],
    embeds: [],
    ...over,
  };
}

// 手で進める時計とタイマー
export class FakeClock {
  t = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private next = 1;
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimeout = (h: unknown) => {
    this.timers.delete(h as number);
  };
  get pending(): number {
    return this.timers.size;
  }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let first: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= end && (!first || e[1].at < first[1].at)) first = e;
      if (!first) break;
      this.timers.delete(first[0]);
      this.t = first[1].at;
      first[1].fn();
    }
    this.t = end;
  }
}

export const flushPromises = () => new Promise((r) => setTimeout(r, 0));
