import { describe, expect, test } from "bun:test";
import {
  accessAppBody,
  buildPlan,
  checkOAuth,
  commandFor,
  formatPlan,
  parseArgs,
  parseGithubRepo,
  REDIRECT_URIS,
  redact,
  resolveAccess,
  type CfApi,
  type Options,
} from "../scripts/setup-fork";

const HOST = "mcp.my-domain.test";
const EMAIL = "me@my-domain.test";
const ACCOUNT = "0123456789abcdef0123456789abcdef";

describe("parseArgs", () => {
  test("引数と環境変数を読み、引数を優先する", () => {
    const o = parseArgs(["--host", "MCP.My-Domain.test", "--email=me@my-domain.test", "--guild-ids", " 123456789012345678 , 223456789012345678 ", "--dry-run"], {
      MCP_HOST: "other.my-domain.test",
    });
    expect(o).toEqual({ host: HOST, email: EMAIL, repo: undefined, accountId: undefined, guildIds: "123456789012345678,223456789012345678", dryRun: true });
    const fromEnv = parseArgs([], { MCP_HOST: HOST, ALLOWED_EMAIL: EMAIL, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, ALLOWED_GUILD_IDS: "" });
    expect(fromEnv.accountId).toBe(ACCOUNT);
    expect(fromEnv.guildIds).toBeUndefined();
    expect(fromEnv.dryRun).toBe(false);
  });

  test("足りない・形が違う・例のままの値を断る", () => {
    expect(() => parseArgs(["--email", EMAIL])).toThrow("MCP_HOST");
    expect(() => parseArgs(["--host", HOST])).toThrow("メールアドレス");
    expect(() => parseArgs(["--host", "discord-mcp.example.com", "--email", EMAIL])).toThrow("例のまま");
    expect(() => parseArgs(["--host", HOST, "--email", "nope"])).toThrow("--email");
    expect(() => parseArgs(["--host", HOST, "--email", EMAIL, "--repo", "a/b/c"])).toThrow("--repo");
    expect(() => parseArgs(["--host", HOST, "--email", EMAIL, "--account-id", "xyz"])).toThrow("アカウントID");
    expect(() => parseArgs(["--host", HOST, "--email", EMAIL, "--guild-ids", "abc"])).toThrow("ALLOWED_GUILD_IDS");
    expect(() => parseArgs(["--host", "--email", EMAIL])).toThrow("--host の値がない");
    expect(() => parseArgs(["--hots", HOST])).toThrow("知らない引数");
  });
});

test("parseGithubRepo は https と ssh の origin から owner/name を取る", () => {
  expect(parseGithubRepo("https://github.com/someone/discord-mcp.git\n")).toBe("someone/discord-mcp");
  expect(parseGithubRepo("git@github.com:someone/discord-mcp.git")).toBe("someone/discord-mcp");
  expect(parseGithubRepo("https://github.com/someone/discord-mcp")).toBe("someone/discord-mcp");
  expect(parseGithubRepo("https://gitlab.com/someone/discord-mcp.git")).toBeUndefined();
});

describe("resolveAccess", () => {
  // 呼ばれた順に記録する偽の Cloudflare API
  function fakeApi(apps: unknown[], opts: { accounts?: unknown[]; org?: unknown } = {}) {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const api: CfApi = async (method, path, body) => {
      calls.push({ method, path, body });
      if (path.startsWith("/accounts?")) return opts.accounts ?? [{ id: ACCOUNT, name: "mine" }];
      if (path.endsWith("/access/organizations")) return opts.org ?? { auth_domain: "team.cloudflareaccess.com" };
      if (method === "GET" && path.includes("/access/apps?")) return apps;
      if (method === "POST" && path.endsWith("/access/apps")) return { id: "new", aud: "newaud123", domain: HOST };
      throw new Error(`想定外: ${method} ${path}`);
    };
    return { api, calls };
  }
  const base: Pick<Options, "host" | "email" | "accountId" | "dryRun"> = { host: HOST, email: EMAIL, dryRun: false };

  test("アプリが無ければ、メールアドレス1件の Allow と Managed OAuth・DCR を付けて作る", async () => {
    const { api, calls } = fakeApi([]);
    const state = await resolveAccess(api, base);
    expect(state).toEqual({ accountId: ACCOUNT, teamDomain: "team.cloudflareaccess.com", aud: "newaud123", created: true, warnings: [] });
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "GET", "POST"]);
    expect(calls[2]!.path).toBe(`/accounts/${ACCOUNT}/access/apps?domain=${HOST}&exact=true`);
    expect(calls[3]!.body).toEqual(accessAppBody(HOST, EMAIL));
  });

  test("--dry-run では作らない", async () => {
    const { api, calls } = fakeApi([]);
    const state = await resolveAccess(api, { ...base, dryRun: true });
    expect(state.aud).toBeUndefined();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("既存のアプリは書き換えず、AUD を読み、足りない設定を知らせる", async () => {
    const { api, calls } = fakeApi([
      { id: "x", aud: "other", domain: "other.my-domain.test" },
      { id: "y", aud: "existingaud", domain: HOST, oauth_configuration: { enabled: true, dynamic_client_registration: { enabled: true, allowed_uris: [REDIRECT_URIS[0]] } } },
    ]);
    const state = await resolveAccess(api, { ...base, accountId: ACCOUNT });
    expect(state.aud).toBe("existingaud");
    expect(state.created).toBe(false);
    expect(state.warnings).toEqual([`Allowed redirect URIs に ${REDIRECT_URIS[1]} がない`]);
    expect(calls.some((c) => c.path.startsWith("/accounts?") || c.method === "POST")).toBe(false);
  });

  test("アカウントが1つに決まらない・組織が無い・アプリが複数あるときは止まる", async () => {
    await expect(resolveAccess(fakeApi([], { accounts: [{ id: "a" }, { id: "b" }] }).api, base)).rejects.toThrow("--account-id");
    await expect(resolveAccess(fakeApi([], { org: {} }).api, base)).rejects.toThrow("Zero Trust");
    await expect(resolveAccess(fakeApi([{ aud: "a", domain: HOST }, { aud: "b", domain: HOST }]).api, base)).rejects.toThrow("2 個");
  });
});

test("checkOAuth は Managed OAuth・DCR・リダイレクト先の不足を並べる", () => {
  expect(checkOAuth({})).toHaveLength(3);
  expect(checkOAuth({ oauth_configuration: { enabled: true, dynamic_client_registration: { enabled: true, allowed_uris: REDIRECT_URIS } } })).toEqual([]);
});

describe("plan", () => {
  const opts: Options = { host: HOST, email: EMAIL, guildIds: "123456789012345678", dryRun: false };
  const access = { accountId: ACCOUNT, teamDomain: "team.cloudflareaccess.com", aud: "abc123", created: true, warnings: [] };

  test("変数・シークレット・Worker のシークレットを並べ、Bot のトークンが無ければ人の手順にする", () => {
    const steps = buildPlan({ opts, access, apiToken: "cf-setup-token" });
    expect(steps.map((s) => `${s.kind}:${s.name}`)).toEqual([
      "variable:MCP_HOST",
      "variable:ACCESS_TEAM_DOMAIN",
      "variable:ACCESS_AUD",
      "variable:ALLOWED_GUILD_IDS",
      "variable:DEPLOY_MCP",
      "secret:CLOUDFLARE_API_TOKEN",
      "secret:CLOUDFLARE_ACCOUNT_ID",
      "worker-secret:ALLOWED_EMAIL",
      "manual:DISCORD_BOT_TOKEN",
    ]);
    const cfToken = steps.find((s) => s.name === "CLOUDFLARE_API_TOKEN");
    expect(cfToken).toMatchObject({ value: "cf-setup-token" });
  });

  test("CLOUDFLARE_DEPLOY_TOKEN があれば CI にはそれを入れる。ALLOWED_GUILD_IDS は無ければ入れない", () => {
    const steps = buildPlan({ opts: { ...opts, guildIds: undefined }, access, apiToken: "cf-setup-token", deployToken: "cf-deploy-token", botToken: "bot-token-value" });
    expect(steps.find((s) => s.name === "CLOUDFLARE_API_TOKEN")).toMatchObject({ value: "cf-deploy-token" });
    expect(steps.find((s) => s.name === "DISCORD_BOT_TOKEN")).toMatchObject({ kind: "worker-secret" });
    expect(steps.some((s) => s.name === "ALLOWED_GUILD_IDS")).toBe(false);
  });

  test("計画の表示にシークレットの値（トークン・メールアドレス・アカウントID）を出さない", () => {
    const text = formatPlan(buildPlan({ opts, access, apiToken: "cf-setup-token", botToken: "bot-token-value" }), "someone/discord-mcp");
    for (const secret of ["cf-setup-token", "bot-token-value", EMAIL, ACCOUNT]) expect(text).not.toContain(secret);
    expect(text).toContain("MCP_HOST = mcp.my-domain.test");
    expect(text).toContain("ACCESS_AUD = abc123");
  });

  test("シークレットは引数ではなく stdin で渡し、シェルを通さない", () => {
    const [secret, worker, variable] = [
      commandFor({ kind: "secret", name: "CLOUDFLARE_API_TOKEN", value: "cf-setup-token" }, "someone/discord-mcp", "/bin/bun"),
      commandFor({ kind: "worker-secret", name: "ALLOWED_EMAIL", value: EMAIL }, "someone/discord-mcp", "/bin/bun"),
      commandFor({ kind: "variable", name: "MCP_HOST", value: HOST }, "someone/discord-mcp", "/bin/bun"),
    ];
    expect(secret).toEqual({ cmd: ["gh", "secret", "set", "CLOUDFLARE_API_TOKEN", "--repo", "someone/discord-mcp"], stdin: "cf-setup-token" });
    expect(worker).toEqual({ cmd: ["/bin/bun", "x", "wrangler", "secret", "put", "ALLOWED_EMAIL"], stdin: EMAIL });
    expect(variable.cmd).toEqual(["gh", "variable", "set", "MCP_HOST", "--repo", "someone/discord-mcp", "--body", HOST]);
    expect(variable.stdin).toBeUndefined();
  });
});

test("redact は値を伏せ、短すぎる値や undefined は無視する", () => {
  expect(redact("token cf-setup-token failed for cf-setup-token", ["cf-setup-token", undefined, "ab"])).toBe("token *** failed for ***");
});
