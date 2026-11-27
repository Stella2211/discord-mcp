// Discord REST API v10 の小さなクライアント。Bun と Cloudflare Workers の両方で動く（fetch だけを使う）。
// - 429 は retry_after が短いときだけ1回待って再試行する（長く待たせない）
// - 失敗は DiscordApiError にする。メッセージには HTTP ステータスと Discord のエラーコードだけを入れ、トークンは出さない

export const API_BASE = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://github.com/Stella2211/discord-mcp, 0.1.0)";

export class DiscordApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    readonly detail: string,
    readonly retryAfter?: number,
  ) {
    super(`Discord API ${status}${code !== undefined ? ` (code ${code})` : ""}: ${detail}`);
    this.name = "DiscordApiError";
  }
}

export interface RestOptions {
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  // 429 のとき、この時間以内なら1回だけ待って再試行する
  maxRateLimitWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type Query = Record<string, string | number | boolean | readonly (string | number)[] | undefined>;

export interface RestResponse<T> {
  status: number;
  body: T;
}

export interface Rest {
  request<T>(method: string, path: string, init?: { query?: Query; body?: unknown }): Promise<RestResponse<T>>;
  get<T>(path: string, query?: Query): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  put(path: string): Promise<void>;
}

export function buildQuery(query: Query | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) params.append(key, String(v));
    else params.append(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createRest(options: RestOptions): Rest {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxWait = options.maxRateLimitWaitMs ?? 5_000;
  const sleep = options.sleep ?? defaultSleep;

  async function request<T>(method: string, path: string, init: { query?: Query; body?: unknown } = {}): Promise<RestResponse<T>> {
    if (!path.startsWith("/")) throw new Error("path must start with /");
    const url = `${API_BASE}${path}${buildQuery(init.query)}`;
    const headers: Record<string, string> = {
      Authorization: `Bot ${options.token}`,
      "User-Agent": USER_AGENT,
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method,
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const name = (err as Error)?.name;
        throw new DiscordApiError(0, undefined, name === "TimeoutError" ? "timeout" : "network error");
      }

      if (res.status === 204) return { status: 204, body: undefined as T };
      const text = await res.text();
      let body: unknown = undefined;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = undefined;
        }
      }

      if (res.status === 429) {
        const retryAfter = Number((body as { retry_after?: number } | undefined)?.retry_after ?? res.headers.get("retry-after") ?? 0);
        const waitMs = Math.ceil(retryAfter * 1000);
        if (attempt === 0 && Number.isFinite(waitMs) && waitMs <= maxWait) {
          await sleep(Math.max(waitMs, 50));
          continue;
        }
        throw new DiscordApiError(429, (body as { code?: number } | undefined)?.code, "rate limited", retryAfter);
      }

      if (!res.ok) {
        const b = body as { code?: number; message?: string } | undefined;
        throw new DiscordApiError(res.status, typeof b?.code === "number" ? b.code : undefined, String(b?.message ?? res.statusText ?? "error").slice(0, 200));
      }
      return { status: res.status, body: body as T };
    }
  }

  return {
    request,
    get: async <T>(path: string, query?: Query) => (await request<T>("GET", path, { query })).body,
    post: async <T>(path: string, body: unknown) => (await request<T>("POST", path, { body })).body,
    patch: async <T>(path: string, body: unknown) => (await request<T>("PATCH", path, { body })).body,
    put: async (path: string) => {
      await request<void>("PUT", path, { body: undefined });
    },
  };
}

// URL のパスに埋める ID の検査（パスの改ざんを防ぐ）
export function assertSnowflake(id: string, label = "id"): string {
  if (!/^\d{15,21}$/.test(id)) throw new Error(`${label} は Discord の ID（15〜21桁の数字）で指定する`);
  return id;
}
