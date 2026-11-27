// デプロイ後の疎通確認（bun run smoke）。認証情報は使わず、外から見える振る舞いだけを確かめる。
// 対象のホストは環境変数 SMOKE_HOST（例: discord-mcp.example.com）。無ければ bun run deploy が作った wrangler.deploy.jsonc の MCP_HOST を読む
const HOST = process.env.SMOKE_HOST?.trim() || (await readHost());
// プレースホルダーのままなら、例のドメインに問い合わせずに止める
if (/(^|\.)example\.com$/i.test(HOST)) {
  throw new Error(`対象が例のホスト名（${HOST}）のまま。SMOKE_HOST に実際のホスト名を指定する`);
}
const ORIGIN = `https://${HOST}`;

async function readHost(): Promise<string> {
  const file = Bun.file(new URL("../wrangler.deploy.jsonc", import.meta.url));
  if (!(await file.exists())) throw new Error("wrangler.deploy.jsonc が無い。先に bun run deploy をするか、SMOKE_HOST を指定する");
  const m = /"MCP_HOST"\s*:\s*"([^"]+)"/.exec(await file.text());
  if (!m) throw new Error("MCP_HOST が wrangler.deploy.jsonc に無い。SMOKE_HOST を指定する");
  return m[1]!;
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const checks: { name: string; run: () => Promise<void> }[] = [
  {
    name: "トークンなしの /mcp は 401 と resource_metadata を返す（Access の Managed OAuth が前にいる）",
    run: async () => {
      const res = await fetch(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", redirect: "manual" });
      assert(res.status === 401, `status ${res.status}`);
      assert(res.headers.get("www-authenticate")?.includes("resource_metadata="), "WWW-Authenticate に resource_metadata がない");
    },
  },
  {
    name: "保護リソースのメタデータが /mcp を指す",
    run: async () => {
      const res = await fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
      assert(res.ok, `status ${res.status}`);
      const body = (await res.json()) as { resource?: string };
      assert(body.resource === `${ORIGIN}/mcp`, `resource ${body.resource}`);
    },
  },
];

let failed = 0;
for (const check of checks) {
  try {
    await check.run();
    console.log(`ok   ${check.name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${check.name}: ${(err as Error).message}`);
  }
}
if (failed > 0) process.exit(1);
