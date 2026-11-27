# 実装：Discord MCP

| ファイル | 役割 |
| --- | --- |
| `packages/mcp/src/index.ts` | Worker の入口。ホストとパスの確認、Access の検査、`createMcpHandler`（agents）への受け渡し |
| `packages/mcp/src/access.ts` | Access の JWT 検査（jose）。署名・発行者・audience・メールアドレスを確認する |
| `packages/mcp/src/server.ts` | `McpServer` を作り、8つのツールを登録する。リクエストごとに REST クライアントを作る |
| `packages/mcp/src/tools/common.ts` | 実行の文脈（REST、許可するサーバー、Bot 自身の情報のキャッシュ）、入力の部品、結果の組み立て、エラーの文言、サーバー・チャンネルの確認、メッセージの整形、メンションの組み立て |
| `packages/mcp/src/tools/list-guilds.ts` | `GET /users/@me/guilds`（200件ずつ、最大5ページ） |
| `packages/mcp/src/tools/list-channels.ts` | サーバー・Bot のメンバー情報・チャンネル・進行中のスレッドを並行して取り、`channelPermissions` で権限を計算する |
| `packages/mcp/src/tools/read-messages.ts` | `GET /channels/{id}/messages`。古い順に並べ、収まらなければ新しい側を残す |
| `packages/mcp/src/tools/search-messages.ts` | `GET /guilds/{id}/messages/search`。日付（日本時間）を Snowflake の `min_id` / `max_id` に変える。202 は待ち時間を伝える |
| `packages/mcp/src/tools/send.ts` | `send_message` と `reply_to_message`（`POST /channels/{id}/messages`）、`edit_message`（`PATCH /channels/{id}/messages/{id}`） |
| `packages/mcp/src/tools/add-reaction.ts` | `PUT /channels/{id}/messages/{id}/reactions/{emoji}/@me`。`<a:name:id>` などを `name:id` に変換し、URL エンコードする |
| `packages/mcp/scripts/deploy-config.ts` | `bun run deploy` の前半。ホスト名と Access の値を入れた `wrangler.deploy.jsonc` を作る（CI も手元も同じ） |
| `packages/mcp/scripts/setup-fork.ts` | フォークのセットアップ（`bun run setup`）。詳細は [fork-setup/](../fork-setup/implementations.md) |
| `packages/mcp/scripts/smoke.ts` | デプロイ後の疎通確認（認証なしで 401 と保護リソースのメタデータ）。例のホスト名のままなら止まる |

## 注意すべき実装

- スレッドの権限は親チャンネルの権限で判断する（`list_channels`）。非公開スレッドは、Bot が参加している（List Active Guild Threads の `members` にある）か、親チャンネルでスレッドの管理の権限があるときだけ見えるものとする。スレッドへの投稿は Send Messages in Threads を見る。
- 検索の結果 `messages` は配列の配列。今の API では各組にヒットしたメッセージだけが入るが、前後の文脈が付く古い形でも正しく選べるよう、`hit: true` のものを優先し、無ければ先頭を使う。
- 検索の日付は2015年以降だけ受け付ける（Snowflake は2015年からの経過時間なので）。ただし 2015-01-01 は日本時間の 0:00 が Discord の起点より前になるため、`since` が起点より前になるときは `min_id` を付けない。
- 検索の結果に `total_results` が無いときは、返ってきた件数を総数とみなす。1 ページ分が埋まっていれば続きの `offset` を案内する。
- 送信・返信の結果も、区切りの外は ID とリンクだけにし、チャンネル名は区切りの内側に置く。メッセージを読む結果も同じ。
- リアクションの絵文字は16文字（コードポイント）まで。家族の絵文字や旗のように、1つでも複数の文字でできているものがあるため。
- `:thumbsup:` のような短縮名は Discord の API では使えないので、入力の段階で断って理由を返す。
- `@discord-mcp/discord` は Workers でも動くよう `fetch` だけを使う。`packages/mcp` と `packages/discord` では Bun 固有の API を使わない。

## テスト

`packages/mcp/test/`：Access とルーティング（自前の鍵で署名した JWT）、8つのツール（`globalThis.fetch` を差し替えた偽の Discord API）、デプロイ用の設定の生成と `deploy` スクリプトの形（`deploy-config.test.ts`）。
