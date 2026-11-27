// wrangler.jsonc の vars は `bun run cf-typegen` で生成される Cloudflare.Env に入る。
// シークレットは wrangler.jsonc に現れないので、ここで補う。
declare namespace Cloudflare {
  interface Env {
    DISCORD_BOT_TOKEN: string;
    ALLOWED_EMAIL: string;
    DEV_BYPASS_ACCESS?: string;
  }
}

// wrangler types は global の Env に Cloudflare.Env を継承させないので、ここで結ぶ
interface Env extends Cloudflare.Env {}
