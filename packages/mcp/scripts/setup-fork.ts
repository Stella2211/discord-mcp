// フォークのセットアップ（bun run setup）。手元の PC で動かす。CI からは使わない。
// 1. Cloudflare API でアカウントID・Zero Trust のチームドメインを取り、MCP_HOST の Access アプリを探す（無ければ作る）
// 2. GitHub Actions の変数・シークレットを gh で入れる
// 3. Worker のシークレットを wrangler secret put で入れる
// シークレットの値は引数にもログにも出さず、子プロセスの stdin で渡す。--dry-run は計画だけを出し、何も書き込まない。
// 手順と、人がやること・ダッシュボードに残ることは docs/fork-setup/README.md。

import { HOSTNAME, normalizeGuildIds } from "./deploy-config";

// claude.ai のコネクタが使うリダイレクト先（docs/mcp/README.md のセットアップと同じ）
export const REDIRECT_URIS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];
export const APP_NAME = "discord-mcp";

export type Options = {
  host: string;
  email: string;
  repo?: string;
  accountId?: string;
  guildIds?: string;
  dryRun: boolean;
};

const USAGE = "使い方: bun run setup -- --host <MCP_HOST> --email <許可するメールアドレス> [--repo <owner/name>] [--account-id <id>] [--guild-ids <id,id>] [--dry-run]";

// 引数を読む。値は環境変数（MCP_HOST・ALLOWED_EMAIL・CLOUDFLARE_ACCOUNT_ID・ALLOWED_GUILD_IDS）でも渡せる。引数が優先
export function parseArgs(argv: string[], env: Record<string, string | undefined> = {}): Options {
  const flags: Record<string, string> = {};
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    const m = /^--(host|email|repo|account-id|guild-ids)(?:=(.*))?$/.exec(arg);
    if (!m) throw new Error(`知らない引数: ${arg}\n${USAGE}`);
    const value = m[2] ?? argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${m[1]} の値がない\n${USAGE}`);
    flags[m[1]!] = value.trim();
  }
  const host = flags.host ?? env.MCP_HOST?.trim() ?? "";
  const email = flags.email ?? env.ALLOWED_EMAIL?.trim() ?? "";
  if (!host) throw new Error(`MCP_HOST がない（--host）\n${USAGE}`);
  if (!email) throw new Error(`許可するメールアドレスがない（--email）\n${USAGE}`);
  if (!HOSTNAME.test(host) || /(^|\.)example\.com$/i.test(host)) throw new Error("--host がホスト名ではない（例のままになっていないか）");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("--email がメールアドレスではない");
  const repo = flags.repo;
  if (repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("--repo は owner/name の形");
  const accountId = flags["account-id"] ?? (env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined);
  if (accountId !== undefined && !/^[a-f0-9]{32}$/i.test(accountId)) throw new Error("アカウントIDは32桁の16進数");
  const guildIds = normalizeGuildIds(flags["guild-ids"] ?? env.ALLOWED_GUILD_IDS);
  return { host: host.toLowerCase(), email, repo, accountId, guildIds, dryRun };
}

// git の origin の URL から owner/name を取る（https と ssh の両方）
export function parseGithubRepo(url: string): string | undefined {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

// ---- Cloudflare ----

// Cloudflare API を1回呼び、result を返す。失敗なら errors を並べて投げる
export type CfApi = (method: "GET" | "POST", path: string, body?: unknown) => Promise<unknown>;

export function createCfApi(token: string, fetchFn: typeof fetch = fetch): CfApi {
  return async (method, path, body) => {
    const res = await fetchFn(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; result?: unknown; errors?: { code?: number; message?: string }[] };
    if (!res.ok || json.success === false) {
      const detail = (json.errors ?? []).map((e) => `${e.code ?? "?"}: ${e.message ?? ""}`).join("; ");
      throw new Error(`Cloudflare API ${method} ${path.split("?")[0]} が失敗した（HTTP ${res.status}${detail ? `、${detail}` : ""}）`);
    }
    return json.result;
  };
}

type AccessApp = {
  id?: string;
  aud?: string;
  domain?: string;
  oauth_configuration?: { enabled?: boolean; dynamic_client_registration?: { enabled?: boolean; allowed_uris?: string[] } };
};

export type AccessState = {
  accountId: string;
  teamDomain: string;
  aud?: string; // 作る前（--dry-run で未作成）は無い
  created: boolean;
  warnings: string[];
};

// Access アプリの作成の本文。ポリシーはアプリの中に書く（許可するメールアドレス1件だけを Allow）
export function accessAppBody(host: string, email: string) {
  return {
    name: APP_NAME,
    type: "self_hosted",
    domain: host,
    policies: [{ name: `${APP_NAME}-allow-owner`, decision: "allow", include: [{ email: { email } }], precedence: 1 }],
    oauth_configuration: { enabled: true, dynamic_client_registration: { enabled: true, allowed_uris: REDIRECT_URIS } },
  };
}

// 既存のアプリの Managed OAuth の設定が足りているか。足りなければダッシュボードで直す内容を返す（既存のアプリは書き換えない）
export function checkOAuth(app: AccessApp): string[] {
  const oauth = app.oauth_configuration;
  const dcr = oauth?.dynamic_client_registration;
  const out: string[] = [];
  if (!oauth || oauth.enabled === false) out.push("Managed OAuth が有効になっていない");
  if (!dcr?.enabled) out.push("Dynamic Client Registration（DCR）がオンになっていない");
  const missing = REDIRECT_URIS.filter((u) => !(dcr?.allowed_uris ?? []).includes(u));
  if (missing.length > 0) out.push(`Allowed redirect URIs に ${missing.join(" と ")} がない`);
  return out;
}

export async function resolveAccess(api: CfApi, opts: Pick<Options, "host" | "email" | "accountId" | "dryRun">): Promise<AccessState> {
  let accountId = opts.accountId;
  if (!accountId) {
    const accounts = ((await api("GET", "/accounts?per_page=50")) ?? []) as { id: string; name?: string }[];
    if (accounts.length !== 1) {
      const list = accounts.map((a) => `  ${a.id} ${a.name ?? ""}`).join("\n");
      throw new Error(`トークンから使えるアカウントが ${accounts.length} 件ある。--account-id で指定する${list ? `\n${list}` : ""}`);
    }
    accountId = accounts[0]!.id;
  }
  let teamDomain: string | undefined;
  try {
    const org = (await api("GET", `/accounts/${accountId}/access/organizations`)) as { auth_domain?: string } | null;
    teamDomain = org?.auth_domain;
  } catch (err) {
    throw new Error(`Zero Trust の組織を読めなかった。ダッシュボードで Zero Trust を始めたか、トークンに Access: Organizations, Identity Providers, and Groups の Read があるか確かめる（${(err as Error).message}）`);
  }
  if (!teamDomain || !HOSTNAME.test(teamDomain)) throw new Error("Zero Trust のチームドメインが無い。ダッシュボードで Zero Trust の組織を作る");

  const query = new URLSearchParams({ domain: opts.host, exact: "true" });
  const found = (((await api("GET", `/accounts/${accountId}/access/apps?${query}`)) ?? []) as AccessApp[]).filter(
    (a) => a.domain?.toLowerCase() === opts.host,
  );
  if (found.length > 1) throw new Error(`${opts.host} を守る Access アプリが ${found.length} 個ある。ダッシュボードで1つにする`);
  if (found.length === 1) {
    const app = found[0]!;
    if (!app.aud) throw new Error("既存の Access アプリの AUD を読めなかった");
    return { accountId, teamDomain, aud: app.aud, created: false, warnings: checkOAuth(app) };
  }
  if (opts.dryRun) return { accountId, teamDomain, created: false, warnings: [] };
  const app = (await api("POST", `/accounts/${accountId}/access/apps`, accessAppBody(opts.host, opts.email))) as AccessApp;
  if (!app?.aud) throw new Error("作った Access アプリの AUD を読めなかった");
  return { accountId, teamDomain, aud: app.aud, created: true, warnings: [] };
}

// ---- 計画 ----

export type Step =
  | { kind: "variable"; name: string; value: string }
  | { kind: "secret"; name: string; value: string }
  | { kind: "worker-secret"; name: string; value: string }
  | { kind: "manual"; name: string; note: string };

// 入れるものの一覧を作る。deployToken が無ければ CLOUDFLARE_API_TOKEN を CI にも使う
export function buildPlan(input: {
  opts: Options;
  access: AccessState;
  apiToken: string;
  deployToken?: string;
  botToken?: string;
}): Step[] {
  const { opts, access } = input;
  const steps: Step[] = [
    { kind: "variable", name: "MCP_HOST", value: opts.host },
    { kind: "variable", name: "ACCESS_TEAM_DOMAIN", value: access.teamDomain },
    { kind: "variable", name: "ACCESS_AUD", value: access.aud ?? "（Access アプリを作ったあとに決まる）" },
  ];
  if (opts.guildIds) steps.push({ kind: "variable", name: "ALLOWED_GUILD_IDS", value: opts.guildIds });
  steps.push(
    { kind: "variable", name: "DEPLOY_MCP", value: "true" },
    { kind: "secret", name: "CLOUDFLARE_API_TOKEN", value: input.deployToken || input.apiToken },
    { kind: "secret", name: "CLOUDFLARE_ACCOUNT_ID", value: access.accountId },
    { kind: "worker-secret", name: "ALLOWED_EMAIL", value: opts.email },
  );
  if (input.botToken) steps.push({ kind: "worker-secret", name: "DISCORD_BOT_TOKEN", value: input.botToken });
  else steps.push({ kind: "manual", name: "DISCORD_BOT_TOKEN", note: "人が入れる: cd packages/mcp && bunx wrangler secret put DISCORD_BOT_TOKEN" });
  return steps;
}

// 計画を文字にする。シークレットの値は出さない
export function formatPlan(steps: Step[], repo: string): string {
  return steps
    .map((s) => {
      if (s.kind === "variable") return `  Actions の変数    ${s.name} = ${s.value}（${repo}）`;
      if (s.kind === "secret") return `  Actions のシークレット ${s.name}（値は表示しない）（${repo}）`;
      if (s.kind === "worker-secret") return `  Worker のシークレット ${s.name}（値は表示しない）`;
      return `  未設定 ${s.name}: ${s.note}`;
    })
    .join("\n");
}

// 文字列からシークレットの値を伏せる（子プロセスのエラー出力を見せるとき用）
export function redact(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("***");
  return out;
}

// gh・wrangler に渡すコマンド。シェルは通さず、値はシークレットなら stdin で渡す
export function commandFor(step: Exclude<Step, { kind: "manual" }>, repo: string, bun: string): { cmd: string[]; stdin?: string } {
  if (step.kind === "variable") return { cmd: ["gh", "variable", "set", step.name, "--repo", repo, "--body", step.value] };
  if (step.kind === "secret") return { cmd: ["gh", "secret", "set", step.name, "--repo", repo], stdin: step.value };
  return { cmd: [bun, "x", "wrangler", "secret", "put", step.name], stdin: step.value };
}

// ---- 実行 ----

async function run(cmd: string[], opts: { stdin?: string; cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdin: opts.stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (opts.stdin !== undefined && proc.stdin) {
    proc.stdin.write(opts.stdin);
    await proc.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

async function detectRepo(cwd: string): Promise<string> {
  const { code, stdout } = await run(["git", "remote", "get-url", "origin"], { cwd });
  const repo = code === 0 ? parseGithubRepo(stdout) : undefined;
  if (!repo) throw new Error("git の origin から GitHub のリポジトリが分からない。--repo owner/name で指定する");
  return repo;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2), process.env);
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!apiToken) throw new Error("環境変数 CLOUDFLARE_API_TOKEN がない（packages/mcp/.env に書くか、シェルで渡す）");
  const deployToken = process.env.CLOUDFLARE_DEPLOY_TOKEN?.trim() || undefined;
  const botToken = process.env.DISCORD_BOT_TOKEN?.trim() || undefined;
  const mcpDir = `${import.meta.dir}/..`;
  const repo = opts.repo ?? (await detectRepo(mcpDir));
  const secrets = [apiToken, deployToken, botToken, opts.email];

  console.log(`対象: ${repo} / ${opts.host}${opts.dryRun ? "（--dry-run: 読むだけで、何も書き込まない）" : ""}`);
  let access: AccessState;
  try {
    access = await resolveAccess(createCfApi(apiToken), opts);
  } catch (err) {
    throw new Error(redact((err as Error).message, secrets));
  }
  if (access.created) console.log(`Access アプリ「${APP_NAME}」を作った（許可するメールアドレス1件の Allow、Managed OAuth・DCR オン）`);
  else if (access.aud) console.log("既存の Access アプリを使う（設定は書き換えない）");
  else console.log(`Access アプリ「${APP_NAME}」を作る予定（許可するメールアドレス1件の Allow、Managed OAuth・DCR オン）`);
  for (const w of access.warnings) console.log(`  ⚠ ダッシュボードで直す: ${w}`);

  const steps = buildPlan({ opts, access, apiToken, deployToken, botToken });
  console.log(`\n入れるもの:\n${formatPlan(steps, repo)}`);
  if (opts.dryRun) return;

  secrets.push(access.accountId);
  const env = { ...process.env, CLOUDFLARE_API_TOKEN: apiToken, CLOUDFLARE_ACCOUNT_ID: access.accountId };
  let failed = 0;
  for (const step of steps) {
    if (step.kind === "manual") continue;
    const { cmd, stdin } = commandFor(step, repo, process.execPath);
    const result = await run(cmd, { stdin, cwd: mcpDir, env });
    if (result.code === 0) console.log(`  ✓ ${step.name}`);
    else {
      failed++;
      console.error(`  ✗ ${step.name}: ${redact(result.stderr.trim() || result.stdout.trim(), secrets)}`);
    }
  }
  if (failed > 0) throw new Error(`${failed} 件失敗した。直してからもう一度実行する（同じ値で上書きされるだけ）`);
  console.log("\n次: Actions を有効にし、gh workflow run ci --ref main でデプロイを走らせる（docs/fork-setup/README.md）");
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
