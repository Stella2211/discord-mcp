import { describe, expect, test } from "bun:test";
import { assertSnowflake, buildQuery, createRest, DiscordApiError } from "../src";

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: (() => Response)[]) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next();
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("createRest", () => {
  test("sends the bot token and user agent, builds the query", async () => {
    const f = fakeFetch([json(200, [{ id: "1" }])]);
    const rest = createRest({ token: "TOKEN", fetch: f.fn });
    const out = await rest.get<{ id: string }[]>("/channels/1/messages", { limit: 5, before: undefined, has: ["a", "b"] });
    expect(out[0]!.id).toBe("1");
    expect(f.calls[0]!.url).toBe("https://discord.com/api/v10/channels/1/messages?limit=5&has=a&has=b");
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bot TOKEN");
    expect(headers["User-Agent"]).toStartWith("DiscordBot (");
  });

  test("waits once on a short 429 and retries", async () => {
    const f = fakeFetch([json(429, { retry_after: 0.2, global: false }), json(200, { ok: true })]);
    const waits: number[] = [];
    const rest = createRest({ token: "t", fetch: f.fn, sleep: async (ms) => void waits.push(ms) });
    expect(await rest.get<{ ok: boolean }>("/x")).toEqual({ ok: true });
    expect(waits).toEqual([200]);
  });

  test("gives up on a long 429", async () => {
    const f = fakeFetch([json(429, { retry_after: 30 })]);
    const rest = createRest({ token: "t", fetch: f.fn, sleep: async () => {} });
    const err = (await rest.get("/x").catch((e) => e)) as DiscordApiError;
    expect(err).toBeInstanceOf(DiscordApiError);
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(30);
  });

  test("turns Discord errors into DiscordApiError without the token", async () => {
    const f = fakeFetch([json(403, { code: 50013, message: "Missing Permissions" })]);
    const rest = createRest({ token: "SECRET", fetch: f.fn });
    const err = (await rest.post("/x", { a: 1 }).catch((e) => e)) as DiscordApiError;
    expect(err.code).toBe(50013);
    expect(err.message).toContain("Missing Permissions");
    expect(err.message).not.toContain("SECRET");
    expect((f.calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  test("patch sends a PATCH with a JSON body", async () => {
    const f = fakeFetch([json(200, { id: "1" })]);
    const body = await createRest({ token: "t", fetch: f.fn }).patch<{ id: string }>("/channels/1/messages/2", { content: "x" });
    expect(body.id).toBe("1");
    expect(f.calls[0]!.init.method).toBe("PATCH");
    expect(f.calls[0]!.init.body).toBe(JSON.stringify({ content: "x" }));
    expect((f.calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  test("204 resolves", async () => {
    const f = fakeFetch([() => new Response(null, { status: 204 })]);
    await createRest({ token: "t", fetch: f.fn }).put("/x");
  });

  test("returns 202 bodies to request()", async () => {
    const f = fakeFetch([json(202, { code: 110000, retry_after: 2 })]);
    const res = await createRest({ token: "t", fetch: f.fn }).request<{ code: number }>("GET", "/x");
    expect(res.status).toBe(202);
    expect(res.body.code).toBe(110000);
  });

  test("network failures do not leak details", async () => {
    const rest = createRest({ token: "t", fetch: (async () => { throw new TypeError("fetch failed at https://secret"); }) as unknown as typeof fetch });
    const err = (await rest.get("/x").catch((e) => e)) as DiscordApiError;
    expect(err.status).toBe(0);
    expect(err.message).not.toContain("secret");
  });
});

test("buildQuery skips undefined", () => {
  expect(buildQuery({ a: undefined })).toBe("");
  expect(buildQuery({ a: true, b: 0 })).toBe("?a=true&b=0");
});

test("assertSnowflake", () => {
  expect(assertSnowflake("123456789012345678")).toBe("123456789012345678");
  expect(() => assertSnowflake("../guilds")).toThrow();
  expect(() => assertSnowflake("12")).toThrow();
});
