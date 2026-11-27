# 要件：Discord アプリ

- Bot は1つ。通知Botと MCP で同じトークンを使う。
- Gateway の intents は GUILDS（`1 << 0`）、GUILD_MESSAGES（`1 << 9`）、MESSAGE_CONTENT（`1 << 15`）だけ。特権 intent は Message Content だけをオンにする。
- 権限は View Channels、Send Messages、Send Messages in Threads、Read Message History、Add Reactions の5つ（合計 `274877975616`）。Administrator は使わない。
- 自分が管理していないサーバーへは、管理者に招待URLを送って追加してもらう。Bot から勝手にサーバーへ参加することはない。
- 扱うサーバーを限るときは、通知Botは `.env` の `ALLOWED_GUILD_IDS`、MCP は `wrangler.jsonc` の `vars.ALLOWED_GUILD_IDS` に書く。
- トークン・ID・メールアドレスはリポジトリに書かない（プレースホルダーだけ）。
