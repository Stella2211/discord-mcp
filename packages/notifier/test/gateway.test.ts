import { describe, expect, test } from "bun:test";
import { Gateway, type SocketLike } from "../src/gateway";
import { FakeClock, flushPromises } from "./support";

class FakeSocket implements SocketLike {
  sent: { op: number; d: any }[] = [];
  closed: number | null = null;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closed = code ?? 1000;
  }
  recv(op: number, d: unknown, s: number | null = null, t: string | null = null) {
    this.onmessage?.({ data: JSON.stringify({ op, d, s, t }) });
  }
  serverClose(code: number) {
    this.onclose?.({ code, reason: "" });
  }
}

function setup(gatewayBot: () => Promise<unknown> = async () => ({ url: "wss://gw.example", session_start_limit: { remaining: 1000, reset_after: 0 } })) {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const events: string[] = [];
  const fatal: string[] = [];
  const gw = new Gateway({
    token: "TOKEN",
    rest: { get: (async () => gatewayBot()) as any },
    createSocket: (u) => {
      const s = new FakeSocket(u);
      sockets.push(s);
      return s;
    },
    onDispatch: (e) => void events.push(e),
    onFatal: (r) => void fatal.push(r),
    log: () => {},
    random: () => 0.5,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { gw, clock, sockets, events, fatal };
}

async function ready(t: ReturnType<typeof setup>) {
  await t.gw.start();
  const s = t.sockets.at(-1)!;
  s.recv(10, { heartbeat_interval: 40_000 });
  s.recv(0, { session_id: "sess", resume_gateway_url: "wss://resume.example", user: { id: "1" } }, 1, "READY");
  return s;
}

describe("Gateway", () => {
  test("identifies with the intents, then heartbeats with the last sequence", async () => {
    const t = setup();
    const s = await ready(t);
    expect(s.url).toBe("wss://gw.example/?v=10&encoding=json");
    const identify = s.sent.find((p) => p.op === 2)!;
    expect(identify.d.token).toBe("TOKEN");
    expect(identify.d.intents).toBe((1 << 0) | (1 << 9) | (1 << 15));
    expect(t.events).toEqual(["READY"]);
    s.recv(0, { id: "m" }, 5, "MESSAGE_CREATE");
    t.clock.advance(20_000); // 初回は interval * jitter(0.5)
    expect(s.sent.at(-1)).toEqual({ op: 1, d: 5 });
  });

  test("a missing ACK drops the socket and resumes on the resume URL", async () => {
    const t = setup();
    const s = await ready(t);
    s.recv(0, {}, 7, "MESSAGE_CREATE");
    t.clock.advance(20_000); // beat, no ack
    t.clock.advance(40_000); // zombie detected
    expect(s.closed).toBe(4900);
    t.clock.advance(1_000);
    await flushPromises();
    const s2 = t.sockets.at(-1)!;
    expect(s2).not.toBe(s);
    expect(s2.url).toStartWith("wss://resume.example");
    s2.recv(10, { heartbeat_interval: 40_000 });
    expect(s2.sent[0]).toEqual({ op: 6, d: { token: "TOKEN", session_id: "sess", seq: 7 } });
  });

  test("server requested heartbeat is answered immediately", async () => {
    const t = setup();
    const s = await ready(t);
    s.recv(1, null);
    expect(s.sent.at(-1)).toEqual({ op: 1, d: 1 });
  });

  test("non-resumable invalid session re-identifies after a pause", async () => {
    const t = setup();
    const s = await ready(t);
    s.recv(9, false);
    expect(s.closed).toBe(4900);
    t.clock.advance(5_000);
    await flushPromises();
    const s2 = t.sockets.at(-1)!;
    expect(s2.url).toStartWith("wss://gw.example");
    s2.recv(10, { heartbeat_interval: 40_000 });
    expect(s2.sent[0]!.op).toBe(2);
  });

  test("ordinary close reconnects with backoff and resumes", async () => {
    const t = setup();
    const s = await ready(t);
    s.serverClose(1006);
    expect(t.sockets.length).toBe(1);
    t.clock.advance(1_000);
    await flushPromises();
    expect(t.sockets.length).toBe(2);
    t.sockets[1]!.recv(10, { heartbeat_interval: 40_000 });
    expect(t.sockets[1]!.sent[0]!.op).toBe(6);
  });

  test("4007 starts a new session", async () => {
    const t = setup();
    const s = await ready(t);
    s.serverClose(4007);
    t.clock.advance(1_000);
    await flushPromises();
    t.sockets[1]!.recv(10, { heartbeat_interval: 40_000 });
    expect(t.sockets[1]!.sent[0]!.op).toBe(2);
  });

  test("fatal close codes stop and report", async () => {
    const t = setup();
    const s = await ready(t);
    s.serverClose(4014);
    expect(t.fatal.length).toBe(1);
    expect(t.fatal[0]).toContain("Message Content");
    t.clock.advance(120_000);
    await flushPromises();
    expect(t.sockets.length).toBe(1);
  });

  test("a 401 on /gateway/bot is fatal", async () => {
    const t = setup(async () => {
      throw Object.assign(new Error("401"), { status: 401 });
    });
    await t.gw.start();
    expect(t.fatal.length).toBe(1);
    expect(t.sockets.length).toBe(0);
  });

  test("no Hello within 30s reconnects", async () => {
    const t = setup();
    await t.gw.start();
    t.clock.advance(30_000);
    expect(t.sockets[0]!.closed).toBe(4900);
    t.clock.advance(1_000);
    await flushPromises();
    expect(t.sockets.length).toBe(2);
  });

  test("repeated failed resumes fall back to a new session", async () => {
    const t = setup();
    await ready(t);
    for (let i = 0; i < 3; i++) {
      t.sockets.at(-1)!.serverClose(1006);
      t.clock.advance(10_000);
      await flushPromises();
      const s = t.sockets.at(-1)!;
      expect(s.url).toStartWith("wss://resume.example");
    }
    t.sockets.at(-1)!.serverClose(1006);
    t.clock.advance(10_000);
    await flushPromises();
    expect(t.sockets.at(-1)!.url).toStartWith("wss://gw.example");
  });

  test("backoff keeps growing when a connection dies right after READY", async () => {
    const t = setup();
    await ready(t);
    t.sockets.at(-1)!.serverClose(1006); // 1回目: 1秒
    t.clock.advance(1_000);
    await flushPromises();
    const s2 = t.sockets.at(-1)!;
    s2.recv(10, { heartbeat_interval: 40_000 });
    s2.recv(0, {}, 2, "RESUMED");
    s2.serverClose(1006); // 安定する前に切れた: 2回目は2秒
    const n = t.sockets.length;
    t.clock.advance(1_500);
    await flushPromises();
    expect(t.sockets.length).toBe(n);
    t.clock.advance(500);
    await flushPromises();
    expect(t.sockets.length).toBe(n + 1);
  });

  test("a malformed payload does not break the receive loop", async () => {
    const t = setup();
    const s = await ready(t);
    s.recv(10, null); // heartbeat_interval が無い Hello
    s.recv(0, { id: "m" }, 3, "MESSAGE_CREATE");
    expect(t.events).toContain("MESSAGE_CREATE");
  });

  test("stop closes with 1000 and does not reconnect", async () => {
    const t = setup();
    const s = await ready(t);
    t.gw.stop();
    expect(s.closed).toBe(1000);
    s.serverClose(1000);
    t.clock.advance(120_000);
    expect(t.sockets.length).toBe(1);
  });
});
