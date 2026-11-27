import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const TEAM = "team.cloudflareaccess.com";
const AUD = "aud";
const HOST = "mcp.example.com";
const env = {
  DISCORD_BOT_TOKEN: "TOKEN",
  ALLOWED_EMAIL: "me@example.com",
  MCP_HOST: HOST,
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  ALLOWED_GUILD_IDS: "",
} as Env;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

let worker: ExportedHandler<Env>;
let privateKey: CryptoKey;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/cdn-cgi/access/certs")) return Response.json({ keys: [jwk] });
    return realFetch(input, init);
  }) as typeof fetch;
  worker = (await import("../src/index")).default;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const token = (email = "me@example.com", aud = AUD) =>
  new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(`https://${TEAM}`).setAudience(aud).setExpirationTime("5m").sign(privateKey);

const initialize = (url: string, headers: Record<string, string> = {}, e: Partial<Env> = {}) =>
  worker.fetch!(
    new Request(url, {
      method: "POST",
      headers: { Host: new URL(url).host, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
    }) as never,
    { ...env, ...e },
    ctx,
  );

describe("routing and Access", () => {
  test("valid JWT reaches MCP", async () => {
    expect((await initialize(`https://${HOST}/mcp`, { "Cf-Access-Jwt-Assertion": await token() })).status).toBe(200);
  });
  test("email is case-insensitive; other emails and audiences are 403", async () => {
    expect((await initialize(`https://${HOST}/mcp`, { "Cf-Access-Jwt-Assertion": await token("ME@example.com") })).status).toBe(200);
    expect((await initialize(`https://${HOST}/mcp`, { "Cf-Access-Jwt-Assertion": await token("x@example.com") })).status).toBe(403);
    expect((await initialize(`https://${HOST}/mcp`, { "Cf-Access-Jwt-Assertion": await token(undefined, "other") })).status).toBe(403);
  });
  test("missing JWT is 403, unset Access settings fail closed", async () => {
    expect((await initialize(`https://${HOST}/mcp`)).status).toBe(403);
    expect((await initialize(`https://${HOST}/mcp`, { "Cf-Access-Jwt-Assertion": await token() }, { ACCESS_AUD: "" })).status).toBe(500);
  });
  test("other hosts and paths are 404", async () => {
    expect((await initialize(`https://other.example.com/mcp`, { "Cf-Access-Jwt-Assertion": await token() })).status).toBe(404);
    expect((await initialize(`https://${HOST}/`, { "Cf-Access-Jwt-Assertion": await token() })).status).toBe(404);
    expect((await initialize(`https://${HOST}/mcp`, { "Cf-Access-Jwt-Assertion": await token() }, { MCP_HOST: "" })).status).toBe(404);
  });
  test("DEV_BYPASS_ACCESS works only on localhost", async () => {
    expect((await initialize("http://localhost:8788/mcp", {}, { DEV_BYPASS_ACCESS: "1" })).status).toBe(200);
    expect((await initialize(`https://${HOST}/mcp`, {}, { DEV_BYPASS_ACCESS: "1" })).status).toBe(403);
    expect((await initialize("http://localhost:8788/mcp")).status).toBe(404);
  });
});
