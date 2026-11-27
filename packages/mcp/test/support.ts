// 偽の Discord API。globalThis.fetch を差し替えて、discord.com/api/v10 宛てだけを受ける
export type Route = (req: { method: string; path: string; query: URLSearchParams; body: any }) => Response | Promise<Response>;

export const calls: { method: string; path: string; query: URLSearchParams; body: any }[] = [];
let routes: Record<string, Route> = {};
const realFetch = globalThis.fetch;

export function installFakeDiscord(r: Record<string, Route>): void {
  routes = r;
  calls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin !== "https://discord.com" || !url.pathname.startsWith("/api/v10/")) return realFetch(input, init);
    const path = url.pathname.slice("/api/v10".length);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const req = { method, path, query: url.searchParams, body };
    calls.push(req);
    const route = routes[`${method} ${path}`];
    if (!route) return Response.json({ code: 10003, message: "Unknown Channel" }, { status: 404 });
    return route(req);
  }) as typeof fetch;
}

export function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

export const json = (body: unknown, status = 200) => () => Response.json(body, { status });
