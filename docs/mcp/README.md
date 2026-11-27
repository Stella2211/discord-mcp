# Discord MCP（packages/mcp）

Cloudflare Workers で動くリモートMCPサーバー。claude.ai のカスタムコネクタとして使い、Bot の権限の範囲で Discord を読み書きする。認証は Cloudflare Access の Managed OAuth と、Worker 側の JWT 検査。

## ツール

| ツール | 内容 | 種類 |
| --- | --- | --- |
| `list_guilds` | Bot が入っているサーバー（guild_id と名前） | 読み取り |
| `list_channels` | チャンネルと進行中のスレッド。Bot が読めるか・送れるか・リアクションできるか。既定では Bot から見えないチャンネルを出さない（`include_hidden: true` で出す） | 読み取り |
| `read_messages` | チャンネル／スレッドのメッセージ（古い順、1〜100件、before/after/around。添付・埋め込みの画像は URL・ファイル名・サイズも返す） | 読み取り |
| `search_messages` | サーバー内の検索（語・投稿者・チャンネル・メンション・添付の種類・日付、25件ずつ。結果には画像の URL も付く） | 読み取り |
| `send_message` | チャンネル／スレッドに投稿 | 書き込み |
| `reply_to_message` | 特定のメッセージに返信（返信先の投稿者への通知はオン・オフできる） | 書き込み |
| `edit_message` | Bot 自身の投稿の本文を丸ごと置き換える（他人の投稿は編集できない） | 書き込み |
| `add_reaction` | リアクションを1つ付ける（Unicode の絵文字かカスタム絵文字） | 書き込み |

- 送信系で通知（メンション）が届くのは `mention_user_ids` に書いた人と、返信先の投稿者（`mention_author`）だけ。本文に `@everyone` やロールを書いても通知されない。
- 検索で 202（code 110000、索引を作っている途中）が返ったときは、何秒待てばよいかを伝える結果を返す。
- Discord の利用者が書いたもの（本文・名前）は `<untrusted_discord>` の区切りの内側に置く。

## セットアップ

リポジトリの `wrangler.jsonc` は、ホスト名（`discord-mcp.example.com`）と Access の値（空）がプレースホルダーになっている。実際の値はコミットせず、デプロイのときに入れる。

| 環境変数 | 中身 | 置き換える場所（wrangler.jsonc のキー） |
| --- | --- | --- |
| `MCP_HOST` | MCP を置くホスト名（例: `discord-mcp.<自分のドメイン>`）。Cloudflare にあるゾーンのサブドメイン | `routes[0].pattern` と `vars.MCP_HOST` |
| `ACCESS_TEAM_DOMAIN` | Zero Trust のチームドメイン（`<チーム名>.cloudflareaccess.com`） | `vars.ACCESS_TEAM_DOMAIN` |
| `ACCESS_AUD` | Access アプリの AUD タグ | `vars.ACCESS_AUD` |

Access の値が空のままだと `/mcp` は 500 を返す（fail closed）。

Worker が読む値は次のとおり。

| 名前 | 種類 | 中身 |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | シークレット | Bot のトークン |
| `ALLOWED_EMAIL` | シークレット | Access で許可した自分のメールアドレス |
| `MCP_HOST` / `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` | `vars`（上の表） | ホスト名と Access の値 |
| `ALLOWED_GUILD_IDS` | `vars`（任意）。CI ではリポジトリ変数でも渡せる | 扱うサーバーを限る（カンマ区切り。空なら Bot が入っている全サーバー） |
| `DEV_BYPASS_ACCESS` | `.dev.vars` | `1` で localhost / 127.0.0.1 宛てだけ Access の検査を飛ばす（`wrangler dev` 用。既定は無効） |
| `SMOKE_HOST` | `bun run smoke` の環境変数 | 疎通確認の対象のホスト名。無ければ `wrangler.deploy.jsonc` の `MCP_HOST` |

1. 使うホスト名を決める。
2. Cloudflare Zero Trust で self-hosted の Access アプリを作り、そのホスト名（パスなし）を保護する：
   - ポリシーは自分のメールアドレス1件だけを Allow。IdP は好きなもの（GitHub など）を使い、IdP が1つなら Instant authentication をオンにする。
   - Managed OAuth を有効にして DCR をオン。Allowed redirect URIs に `https://claude.ai/api/mcp/auth_callback` と `https://claude.com/api/mcp/auth_callback`。
3. チームドメインと、Access アプリの AUD タグを控える。
4. 扱うサーバーを限るなら `vars.ALLOWED_GUILD_IDS` にサーバーIDをカンマ区切りで書く。ID をコミットしたくないときは、環境変数（CI ならリポジトリ変数）`ALLOWED_GUILD_IDS` で渡す。空なら `wrangler.jsonc` の値のまま。
5. シークレットを入れる（値はプロンプトに入力する）：

   ```bash
   cd packages/mcp
   bunx wrangler secret put DISCORD_BOT_TOKEN   # 通知Botと同じトークン
   bunx wrangler secret put ALLOWED_EMAIL       # Access で許可した自分のメールアドレス
   ```

6. 下の「デプロイ」のとおりにデプロイし、続けて `bun run smoke`。
7. claude.ai のコネクタで、URL `https://<ホスト名>/mcp` のカスタムコネクタを追加し、ブラウザでログインする。
8. ツールの権限：読み取りの4つは Always allow、書き込みの4つは Needs approval にするのがおすすめ（Bot の名前で投稿されるため）。

## デプロイ

デプロイは必ず `bun run deploy` で行う。`scripts/deploy-config.ts` が環境変数 `MCP_HOST`・`ACCESS_TEAM_DOMAIN`・`ACCESS_AUD` の値を確認し、それを入れた `wrangler.deploy.jsonc`（`wrangler.jsonc` と同じフォルダ、git には入らない）を作って `wrangler deploy --config wrangler.deploy.jsonc` する。値が欠けているか例のままなら、何もデプロイせずに止まる。`bunx wrangler deploy` を直接使うと、プレースホルダーの `wrangler.jsonc` がそのまま本番に上がるので使わない。

- **手元から**：

  ```bash
  cd packages/mcp
  MCP_HOST=… ACCESS_TEAM_DOMAIN=… ACCESS_AUD=… bun run deploy
  bun run smoke
  ```

- **CI から**：GitHub のリポジトリ変数（Settings → Secrets and variables → Actions → Variables）に `MCP_HOST`・`ACCESS_TEAM_DOMAIN`・`ACCESS_AUD` を入れ、`DEPLOY_MCP` を `true` にする。`main` への push で同じ `bun run deploy` が走り、続けて `SMOKE_HOST` に `MCP_HOST` を渡してスモークテストを走らせる。3つのどれかが空なら、デプロイとスモークテストを飛ばして警告を出す（ジョブは成功のまま、本番は前の版のまま）。シークレットなどは [運用](../operations/README.md)。
- `bun run smoke` は `SMOKE_HOST` が無ければ `wrangler.deploy.jsonc` の `vars.MCP_HOST` を見る。例のホスト名のままなら問い合わせずに止まる。

## 注意

- Workers からは REST だけを使う（Gateway には繋がない）。Durable Object も使わない。重い処理はないので Workers の無料プランで足りる見込みだが、CPU 時間はデプロイ後にダッシュボードで確認する。
- `*.workers.dev` とプレビューURLは無効。カスタムドメインだけで受ける。
- 要件は [requirements.md](./requirements.md)、実装は [implementations.md](./implementations.md)。
