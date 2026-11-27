// デプロイ用の設定 wrangler.deploy.jsonc を作る（bun run deploy の前半。CI も手元も同じ）。
// wrangler.jsonc のプレースホルダーを、環境変数 MCP_HOST・ACCESS_TEAM_DOMAIN・ACCESS_AUD の値に置き換えて書き出す。
// wrangler.jsonc は書き換えない。生成物は git に入らない（.gitignore）。wrangler は main などの相対パスを
// 設定ファイルの場所から解決するので、wrangler.jsonc と同じフォルダに置く。

// 生成するファイルの名前。package.json の deploy スクリプトの --config と揃える
export const DEPLOY_CONFIG = "wrangler.deploy.jsonc";

export type DeployValues = { MCP_HOST: string; ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string };

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i;

// 値を検査する。JSON の文字列に埋め込むので、ホスト名と英数字以外は受け付けない
export function validate(values: Record<string, string | undefined>): DeployValues {
  const host = values.MCP_HOST?.trim() ?? "";
  const team = values.ACCESS_TEAM_DOMAIN?.trim() ?? "";
  const aud = values.ACCESS_AUD?.trim() ?? "";
  const missing = (["MCP_HOST", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD"] as const).filter((k) => !values[k]?.trim());
  if (missing.length > 0) throw new Error(`値がない: ${missing.join(", ")}`);
  if (!HOSTNAME.test(host) || /(^|\.)example\.com$/i.test(host)) throw new Error("MCP_HOST がホスト名ではない（例のままになっていないか）");
  if (!HOSTNAME.test(team)) throw new Error("ACCESS_TEAM_DOMAIN がホスト名ではない");
  if (!/^[a-z0-9]+$/i.test(aud)) throw new Error("ACCESS_AUD は英数字だけ（Access アプリの AUD タグ）");
  return { MCP_HOST: host, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud };
}

// "key": "…" の値を1か所だけ置き換える。見つからない・複数あるときは失敗させる
function replaceOne(text: string, key: string, value: string): string {
  const re = new RegExp(`("${key}"\\s*:\\s*")[^"]*(")`, "g");
  const count = text.match(re)?.length ?? 0;
  if (count !== 1) throw new Error(`wrangler.jsonc の "${key}" が ${count} か所ある（1か所のはず）`);
  return text.replace(re, (_m, head: string, tail: string) => `${head}${value}${tail}`);
}

export function applyDeployValues(text: string, values: DeployValues): string {
  let out = replaceOne(text, "pattern", values.MCP_HOST);
  out = replaceOne(out, "MCP_HOST", values.MCP_HOST);
  out = replaceOne(out, "ACCESS_TEAM_DOMAIN", values.ACCESS_TEAM_DOMAIN);
  out = replaceOne(out, "ACCESS_AUD", values.ACCESS_AUD);
  return out;
}

if (import.meta.main) {
  const values = validate(process.env);
  const base = await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).text();
  await Bun.write(new URL(`../${DEPLOY_CONFIG}`, import.meta.url), applyDeployValues(base, values));
  console.log(`${DEPLOY_CONFIG} を作った（ホスト: ${values.MCP_HOST}）`);
}
