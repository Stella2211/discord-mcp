import { createMcpHandler } from "agents/mcp/server";
import { checkAccess } from "./access";
import { createServer } from "./server";

const notFound = () => new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });

// ローカル開発専用。DEV_BYPASS_ACCESS=1 かつ localhost / 127.0.0.1 宛のときだけ真になる。
// 本番のカスタムドメイン宛では hostname が一致しないので、変数を誤って設定しても効かない。
function isLocalDev(url: URL, env: Env): boolean {
  return env.DEV_BYPASS_ACCESS === "1" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const dev = isLocalDev(url, env);
    if (!dev && (!env.MCP_HOST || url.hostname !== env.MCP_HOST)) return notFound();
    if (url.pathname !== "/mcp") return notFound();
    if (!dev) {
      const denied = await checkAccess(request, env);
      if (denied) return denied;
    }
    const handler = createMcpHandler(() => createServer(env), {
      route: "/mcp",
      corsOptions: false,
      allowedHostnames: dev ? ["localhost", "127.0.0.1"] : [env.MCP_HOST],
    });
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
