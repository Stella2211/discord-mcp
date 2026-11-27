import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapUntrusted } from "@discord-mcp/discord";
import { DuetQueue, DuetRouter, duetSender, killInflightSends, MAX_MESSAGE_CHARS, MAX_PENDING, truncateNotice } from "../src/duet";
import { FakeClock, flushPromises } from "./support";

function setup(fail = false, logs: string[] = []) {
  const clock = new FakeClock();
  const sent: string[] = [];
  let failing = fail;
  const q = new DuetQueue({
    minIntervalMs: 30_000,
    now: clock.now,
    setTimeout: clock.setTimeout,
    log: (m) => logs.push(m),
    send: async (t) => {
      if (failing) throw new Error("boom");
      sent.push(t);
    },
  });
  return { clock, sent, q, setFailing: (v: boolean) => (failing = v) };
}

describe("DuetQueue", () => {
  test("caps the backlog while sending too: drops the oldest and logs one summary", async () => {
    const logs: string[] = [];
    const { clock, sent, q } = setup(false, logs);
    q.push("first");
    clock.advance(0);
    await flushPromises();
    expect(sent).toEqual(["first"]);
    for (let i = 0; i < MAX_PENDING + 5; i++) q.push(`n${i}`);
    expect(q.size).toBe(MAX_PENDING);
    clock.advance(30_000);
    await flushPromises();
    const drops = logs.filter((l) => l.includes("捨てた"));
    expect(drops).toEqual(["duet: 未送信が多すぎるので 5 件を捨てた"]);
    const parts = sent[1]!.split("\n\n----------\n\n").slice(1);
    expect(parts.length).toBe(MAX_PENDING);
    expect(parts[0]).toBe("n5");
    expect(parts.at(-1)).toBe(`n${MAX_PENDING + 4}`);
  });

  test("items being sent are not counted against the cap and are not dropped", async () => {
    let release: () => void = () => {};
    const sent: string[] = [];
    const clock = new FakeClock();
    const q = new DuetQueue({
      minIntervalMs: 30_000,
      now: clock.now,
      setTimeout: clock.setTimeout,
      log: () => {},
      send: (t) => new Promise<void>((r) => ((release = () => (sent.push(t), r())))),
    });
    q.push("a");
    clock.advance(0);
    await flushPromises();
    for (let i = 0; i < MAX_PENDING + 3; i++) q.push(`n${i}`);
    expect(q.size).toBe(MAX_PENDING + 1);
    release();
    await flushPromises();
    expect(sent).toEqual(["a"]);
    expect(q.size).toBe(MAX_PENDING);
  });

  test("a failed send keeps the newest MAX_PENDING and retries them", async () => {
    const logs: string[] = [];
    const clock = new FakeClock();
    const sent: string[] = [];
    let fail = true;
    let rejectSend: (e: Error) => void = () => {};
    let first = true;
    const q = new DuetQueue({
      minIntervalMs: 30_000,
      now: clock.now,
      setTimeout: clock.setTimeout,
      log: (m) => logs.push(m),
      send: (t) => {
        if (first) {
          first = false;
          return new Promise<void>((_, rej) => (rejectSend = rej));
        }
        if (fail) return Promise.reject(new Error("boom"));
        sent.push(t);
        return Promise.resolve();
      },
    });
    q.push("a");
    clock.advance(0);
    await flushPromises();
    for (let i = 0; i < MAX_PENDING + 3; i++) q.push(`n${i}`);
    rejectSend(new Error("boom"));
    await flushPromises();
    // 失敗した "a" も残るが、合計は上限まで。古いものから捨てる
    expect(q.size).toBe(MAX_PENDING);
    expect(logs.filter((l) => l.includes("捨てた")).length).toBe(1);
    fail = false;
    clock.advance(30_000 * 2);
    await flushPromises();
    expect(sent.length).toBe(1);
    const parts = sent[0]!.split("\n\n----------\n\n").slice(1);
    expect(parts.at(-1)).toBe(`n${MAX_PENDING + 2}`);
    expect(parts[0]).toBe("n3");
    expect(parts).not.toContain("a");
    expect(q.size).toBe(0);
  });

  test("sends the first at once and batches the rest within the interval", async () => {
    const { clock, sent, q } = setup();
    q.push("a");
    clock.advance(0);
    await flushPromises();
    expect(sent).toEqual(["a"]);
    q.push("b");
    q.push("c");
    clock.advance(29_000);
    await flushPromises();
    expect(sent.length).toBe(1);
    clock.advance(1_000);
    await flushPromises();
    expect(sent.length).toBe(2);
    expect(sent[1]).toContain("2 件をまとめて");
    expect(sent[1]).toContain("b");
    expect(sent[1]).toContain("c");
    expect(q.size).toBe(0);
  });

  test("never exceeds the size limit and keeps the remainder", async () => {
    const { clock, sent, q } = setup();
    const big = "x".repeat(4000);
    q.push(big);
    q.push(big);
    clock.advance(0);
    await flushPromises();
    expect(sent.length).toBe(1);
    expect(q.size).toBe(1);
    q.push("y".repeat(MAX_MESSAGE_CHARS * 2));
    clock.advance(30_000);
    await flushPromises();
    clock.advance(30_000);
    await flushPromises();
    expect(sent.every((t) => t.length <= MAX_MESSAGE_CHARS + 100)).toBe(true);
  });

  test("keeps items after a failure and retries", async () => {
    const { clock, sent, q, setFailing } = setup(true);
    q.push("a");
    clock.advance(0);
    await flushPromises();
    expect(sent).toEqual([]);
    expect(q.size).toBe(1);
    setFailing(false);
    clock.advance(30_000);
    await flushPromises();
    expect(sent).toEqual([]); // 失敗のあとは間隔が倍になる
    clock.advance(30_000);
    await flushPromises();
    expect(sent).toEqual(["a"]);
  });
});

test("childEnv drops this bot's secrets", async () => {
  const { childEnv } = await import("../src/duet");
  expect(childEnv({ PATH: "/bin", DISCORD_BOT_TOKEN: "t", ANTHROPIC_API_KEY: "k", DECISION_API_KEY: "d", CLOUDFLARE_AI_TOKEN: "c", DUET_ID_FILE: "/x" })).toEqual({
    PATH: "/bin",
    DUET_ID_FILE: "/x",
  });
});

test("truncateNotice re-closes the untrusted block", () => {
  const t = truncateNotice(`header\n\n${wrapUntrusted("z".repeat(MAX_MESSAGE_CHARS * 2))}`);
  expect(t.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
  expect(t.endsWith("</untrusted_discord>")).toBe(true);
  expect(truncateNotice("short")).toBe("short");
});

describe("duetSender", () => {
  const dir = mkdtempSync(join(tmpdir(), "duet-test-"));
  const script = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };

  test("passes the text on stdin and the tag as an argument", async () => {
    const out = join(dir, "out.txt");
    const p = script("ok.ts", `await Bun.write(${JSON.stringify(out)}, process.argv.slice(2).join(" ") + "|" + (await Bun.stdin.text()));`);
    await duetSender({ scriptPath: p, tag: "[t]", dryRun: false })("hello");
    expect(await Bun.file(out).text()).toBe("--tag [t]|hello");
  });

  test("passes --to when a route is set", async () => {
    const out = join(dir, "out-route.txt");
    const p = script("route.ts", `await Bun.write(${JSON.stringify(out)}, process.argv.slice(2).join(" "));`);
    await duetSender({ scriptPath: p, tag: "[t]", route: "仕事", dryRun: false })("hello");
    expect(await Bun.file(out).text()).toBe("--tag [t] --to 仕事");
  });

  test("a non-zero exit is an error with stderr", async () => {
    const p = script("fail.ts", `console.error("nope"); process.exit(3);`);
    await expect(duetSender({ scriptPath: p, tag: "t", dryRun: false })("x")).rejects.toThrow(/終了コード 3: nope/);
  });

  test("a hung duet-send is killed after the timeout", async () => {
    const p = script("hang.ts", `setInterval(() => {}, 1000);`);
    const started = Date.now();
    await expect(duetSender({ scriptPath: p, tag: "t", dryRun: false, timeoutMs: 500 })("x")).rejects.toThrow(/時間内に終わらなかった/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test.skipIf(process.platform === "win32")("a timeout also kills a grandchild that ignores SIGTERM", async () => {
    const pidFile = join(dir, "grandchild.pid");
    const child = script("gc.ts", `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`);
    const p = script(
      "mid.ts",
      `const c = Bun.spawn([process.execPath, ${JSON.stringify(child)}]); await Bun.write(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`,
    );
    await expect(duetSender({ scriptPath: p, tag: "t", dryRun: false, timeoutMs: 1500 })("x")).rejects.toThrow(/時間内に終わらなかった/);
    const pid = Number(await Bun.file(pidFile).text());
    await Bun.sleep(300);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) process.kill(pid, "SIGKILL");
    expect(alive).toBe(false);
  });

  test.skipIf(process.platform === "win32")("killInflightSends stops a running send and its grandchild; nothing is left to kill afterwards", async () => {
    const pidFile = join(dir, "inflight.pid");
    const child = script("gc2.ts", `setInterval(() => {}, 1000);`);
    const p = script(
      "mid2.ts",
      `const c = Bun.spawn([process.execPath, ${JSON.stringify(child)}]); await Bun.write(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`,
    );
    const sending = duetSender({ scriptPath: p, tag: "t", dryRun: false, timeoutMs: 60_000 })("x");
    const settled = sending.then(
      () => "ok",
      (e: Error) => e.message,
    );
    for (let i = 0; i < 50 && !(await Bun.file(pidFile).exists()); i++) await Bun.sleep(100);
    expect(killInflightSends()).toBe(1);
    expect(await settled).toMatch(/終了コード|時間内/);
    const pid = Number(await Bun.file(pidFile).text());
    await Bun.sleep(300);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) process.kill(pid, "SIGKILL");
    expect(alive).toBe(false);
    expect(killInflightSends()).toBe(0);
  });
});

describe("DuetQueue failure streak", () => {
  function streak() {
    const clock = new FakeClock();
    const alerts: string[] = [];
    let failing = true;
    const q = new DuetQueue({
      minIntervalMs: 1000,
      now: clock.now,
      setTimeout: clock.setTimeout,
      log: () => {},
      send: async () => {
        if (failing) throw new Error("boom");
      },
      onFailureStreak: (e) => void alerts.push(e.message),
    });
    const fail = async (n: number) => {
      // 再送のタイマーを進めて、n 回送らせる（間隔は失敗のたびに倍になるので、十分に進める）
      for (let i = 0; i < n; i++) {
        clock.advance(100_000);
        await flushPromises();
      }
    };
    return { q, alerts, fail, setFailing: (v: boolean) => (failing = v) };
  }

  test("alerts once at the third consecutive failure, not again at the fourth", async () => {
    const t = streak();
    t.q.push("a");
    await t.fail(2);
    expect(t.alerts).toEqual([]);
    await t.fail(1);
    expect(t.alerts).toEqual(["boom"]);
    await t.fail(2);
    expect(t.alerts.length).toBe(1);
  });

  test("a success resets the streak so a later streak alerts again", async () => {
    const t = streak();
    t.q.push("a");
    await t.fail(3);
    expect(t.alerts.length).toBe(1);
    t.setFailing(false);
    await t.fail(1);
    expect(t.q.size).toBe(0);
    t.setFailing(true);
    t.q.push("b");
    await t.fail(3);
    expect(t.alerts.length).toBe(2);
  });
});

describe("DuetRouter", () => {
  test("keeps a queue per route and never batches across routes", async () => {
    const clock = new FakeClock();
    const sent: { route: string | undefined; text: string }[] = [];
    const made: (string | undefined)[] = [];
    const r = new DuetRouter((route) => {
      made.push(route);
      return new DuetQueue({
        minIntervalMs: 30_000,
        now: clock.now,
        setTimeout: clock.setTimeout,
        log: () => {},
        send: async (text) => void sent.push({ route, text }),
      });
    });
    expect(made).toEqual([]);
    r.push("a", "work");
    r.push("b", "home");
    r.push("c");
    clock.advance(0);
    await flushPromises();
    expect(sent).toEqual([{ route: "work", text: "a" }, { route: "home", text: "b" }, { route: undefined, text: "c" }]);
    r.push("d", "work");
    r.push("e", "work");
    r.push("f");
    expect(r.size).toBe(3);
    clock.advance(30_000);
    await flushPromises();
    expect(sent.slice(3).map((s) => s.route)).toEqual(["work", undefined]);
    expect(sent[3]!.text).toContain("d");
    expect(sent[3]!.text).toContain("e");
    expect(sent[3]!.text).not.toContain("f");
    expect(made).toEqual(["work", "home", undefined]);
    expect(r.size).toBe(0);
    expect(r.busy).toBe(false);
  });
});
