# 実装：Discord アプリとの対応

| 設定 | コード |
| --- | --- |
| intents の値 | `packages/notifier/src/gateway.ts` の `Intents` / `DEFAULT_INTENTS` |
| Message Content Intent の確認 | `packages/notifier/src/main.ts` の `--check`（`GET /applications/@me` の `flags` の `1 << 18`（GATEWAY_MESSAGE_CONTENT）か `1 << 19`（LIMITED）を見る） |
| 権限のビット | `packages/discord/src/permissions.ts` の `Permission` |
| チャンネルごとの実効権限 | `packages/discord/src/permissions.ts` の `channelPermissions`（@everyone → ロール → メンバーの上書き） |
| 4014（許可されていない intents）で止める | `packages/notifier/src/gateway.ts` の `FATAL_CLOSE_CODES` |
| User-Agent | `packages/discord/src/rest.ts`（`DiscordBot (<リポジトリURL>, <版>)` の形式） |

- `bun run check`（`packages/notifier`）で、トークン・intent・参加サーバー・通知対象の人がサーバーにいるかを一度に確かめられる。
