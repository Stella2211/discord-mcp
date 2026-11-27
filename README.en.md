[日本語](README.md) | English

# discord-mcp

A single Discord bot (one bot token), used from two places: the notifier and the MCP server.

- **Notifier bot** (`packages/notifier`): runs on an always-on PC. It forwards new messages to Claude Duet through [duet-send](https://github.com/Stella2211/duet-send). Mentions of you are forwarded right away. Everything else is forwarded only if a judge model says it looks relevant to you. If you turn the judge model off, every message in the channels the bot can see is forwarded.
- **Discord MCP** (`packages/mcp`): a remote MCP server running on Cloudflare Workers behind Cloudflare Access. From claude.ai it can list servers and channels, read past messages, search, post, reply, add reactions, and edit the bot's own messages.
- **Shared code** (`packages/discord`): the REST client, types, permission calculation, snowflakes and string formatting. It runs on both Bun and Workers.

Design and details are in [docs/README.md](./docs/README.md) (in Japanese).

## Requirements

- [Bun](https://bun.sh)
- A bot created in the Discord Developer Portal ([docs/discord-app/](./docs/discord-app/README.md), in Japanese)
- Notifier: an always-on PC (macOS, Linux or Windows), duet-send, and Claude Code (`claude`)
- MCP: a Cloudflare account, a custom domain, and Cloudflare Zero Trust (the free plan is enough)

## Getting started

```bash
bun install
```

1. **Create the bot.** Turn on Message Content Intent and add the bot to your server with the invite URL ([docs/discord-app/](./docs/discord-app/README.md), in Japanese).
2. **Run the notifier.**

   ```bash
   cd packages/notifier
   cp .env.example .env              # fill in the token, your user ID, the duet-send path and the judge model
   bun run check                     # validate the configuration
   DUET_DRY_RUN=true bun run start   # dry run (logs notifications instead of sending them to Duet)
   bun run service:install           # install autostart
   ```

   See [docs/notifier/](./docs/notifier/README.md) (in Japanese) for details.
3. **Deploy the MCP server.** Create an Access app, set the secrets, and pass the hostname and the Access values as environment variables when you deploy. Leave `wrangler.jsonc` as it is, with its placeholders. The steps, including deploying from CI, are in the "デプロイ" (Deploy) section of [docs/mcp/](./docs/mcp/README.md#デプロイ) (in Japanese).

   ```bash
   cd packages/mcp
   bunx wrangler secret put DISCORD_BOT_TOKEN
   bunx wrangler secret put ALLOWED_EMAIL
   MCP_HOST=… ACCESS_TEAM_DOMAIN=… ACCESS_AUD=… bun run deploy
   bun run smoke
   ```

4. **Add it to claude.ai.** Add a custom connector with the URL `https://<hostname>/mcp`.

If you fork the repository and hand it to Claude Code, you only do the steps that live in third-party dashboards, such as creating the Cloudflare API token. Claude Code can register the variables and secrets for step 3 and get the deploy going ([docs/fork-setup/](./docs/fork-setup/README.md), in Japanese).

## Development

```bash
bun run typecheck    # type-check all three packages
bun test             # all tests (none of them connect to external services)
cd packages/mcp && cp .dev.vars.example .dev.vars && bun run dev   # wrangler dev (port 8788)
```

- `packages/mcp` and `packages/discord` also run on Workers, so don't use Bun-specific APIs (such as `Bun.file`) in them.
- Don't commit secrets, email addresses or IDs.

## Documentation

All of the documentation is in Japanese.

- [docs/README.md](./docs/README.md): index
- [docs/architecture.md](./docs/architecture.md): architecture
- [docs/operations/](./docs/operations/README.md): CI, secrets and dependencies
- [SECURITY.md](./SECURITY.md): security policy (how to report a vulnerability)

## License

[MIT](LICENSE)
