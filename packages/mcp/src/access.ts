// Cloudflare Access の JWT（Cf-Access-Jwt-Assertion）の検査。
// Access の前段（Managed OAuth）を通ったリクエストだけが来る前提でも、Worker 側で署名・発行者・audience・メールを確かめる。
import { createRemoteJWKSet, errors, jwtVerify } from "jose";

// JWKS はモジュールスコープでキャッシュする（jose が鍵の更新も面倒を見る）
const jwksByDomain = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(teamDomain: string) {
  let jwks = jwksByDomain.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksByDomain.set(teamDomain, jwks);
  }
  return jwks;
}

// JWKS の取得・解釈に失敗したときの jose のエラー。JOSEError 以外（fetch 自体の失敗）も含める
const JWKS_FETCH_CODES = new Set(["ERR_JWKS_TIMEOUT", "ERR_JWKS_INVALID", "ERR_JOSE_GENERIC"]);

function isJwksFetchError(err: unknown): boolean {
  if (!(err instanceof errors.JOSEError)) return true;
  return JWKS_FETCH_CODES.has(err.code);
}

const plain = (status: number, body: string) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

// 通れば null、拒否するなら Response を返す。エラー本文に詳細は出さない
export async function checkAccess(request: Request, env: Env): Promise<Response | null> {
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  // 未設定・不正値は fail closed
  if (!teamDomain || !aud || !env.ALLOWED_EMAIL || !/^[a-z0-9.-]+$/i.test(teamDomain)) {
    console.log(JSON.stringify({ access: "misconfigured" }));
    return plain(500, "Server misconfigured");
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return plain(403, "Forbidden");

  try {
    const { payload } = await jwtVerify(token, getJwks(teamDomain), {
      issuer: `https://${teamDomain}`,
      audience: aud,
      algorithms: ["RS256"],
    });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    if (!email || email !== env.ALLOWED_EMAIL.toLowerCase()) {
      console.log(JSON.stringify({ access: "email_mismatch" }));
      return plain(403, "Forbidden");
    }
    return null;
  } catch (err) {
    // 鍵の取得に失敗したのか、トークン自体が不正なのかをログで区別する（レスポンスはどちらも403）
    console.log(JSON.stringify({ access: isJwksFetchError(err) ? "jwks_unavailable" : "jwt_invalid" }));
    return plain(403, "Forbidden");
  }
}
