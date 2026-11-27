# フォークのセットアップ

このリポジトリをフォークして Claude Code に渡すと、Claude Code が GitHub Actions の変数・シークレットと Worker のシークレットを入れ、MCP のデプロイまで進められる。人がやるのは、Cloudflare の API トークンを作ることと、外部の画面にしか無い作業だけ。

中心は `packages/mcp/scripts/setup-fork.ts`（`cd packages/mcp && bun run setup`）。手元の PC で動かす（CI からは使わない）。

## 分担

### 人がやること

1. **Discord の Bot を作る。** トークンの発行、Message Content Intent、招待（[discord-app/](../discord-app/README.md)）。Developer Portal の画面でしかできない。
2. **ドメインを決める。** Cloudflare にあるゾーンのサブドメインを MCP のホスト名にする（例: `discord-mcp.<自分のドメイン>`）。
3. **Zero Trust を初めて使うなら、ダッシュボードで組織を作る**（チーム名を決める。無料プランで可）。ログインの方法（IdP）は既定のワンタイムPINのままでもよい。
4. **API トークンを2つ作る**（下の「API トークンの権限」）：Access の権限を持つセットアップ用と、デプロイだけのCI用。My Profile → API Tokens、またはアカウントの API Tokens から。
5. **値を渡す。**
   - トークンはチャットに貼らず、`packages/mcp/.env`（git に入らない）に書くか、シェルの環境変数にする：

     ```bash
     CLOUDFLARE_API_TOKEN=…      # セットアップ用トークン（Access の権限つき。手元だけで使う）
     CLOUDFLARE_DEPLOY_TOKEN=…   # 既定で推奨。デプロイの権限だけのトークン。Actions の CLOUDFLARE_API_TOKEN に入る
     DISCORD_BOT_TOKEN=…         # 任意。無ければ最後に自分で wrangler secret put する
     ```

   - ホスト名と、Access で許可する自分のメールアドレスを Claude Code に伝える（秘密ではない）。
6. **最後に claude.ai でコネクタを追加する。** URL `https://<ホスト名>/mcp` のカスタムコネクタを追加し、ブラウザでログインする（[mcp/](../mcp/README.md) のセットアップの 7・8）。

### Claude Code がやること

1. Actions を有効にする（フォークは無効で始まる）：

   ```bash
   gh api -X PUT repos/<owner>/<repo>/actions/permissions -F enabled=true
   ```

   それでも Actions のタブに「Workflows aren't being run on this forked repository」が出ていれば、人がそのタブのボタンで有効にする。
2. `bun install`
3. 計画を確かめてから実行する：

   ```bash
   cd packages/mcp
   bun run setup -- --host <ホスト名> --email <メールアドレス> --dry-run
   bun run setup -- --host <ホスト名> --email <メールアドレス>
   ```

   スクリプトがやること：
   - アカウントID（`GET /accounts`。複数あれば `--account-id`）と、Zero Trust のチームドメイン（`GET /accounts/{id}/access/organizations` の `auth_domain`）を取る。
   - ホスト名を守る Access アプリを探し（`GET /accounts/{id}/access/apps?domain=…&exact=true`）、無ければ作る（`POST /accounts/{id}/access/apps`）。作るときは、メールアドレス1件だけを Allow するポリシーと、Managed OAuth（DCR オン、redirect URI は claude.ai と claude.com のコールバック）を付ける。結果の `aud` を `ACCESS_AUD` にする。
   - 既存のアプリは書き換えない。Managed OAuth・DCR・redirect URI が足りなければ警告を出すので、人にダッシュボードで直してもらう。
   - Actions の変数 `MCP_HOST`・`ACCESS_TEAM_DOMAIN`・`ACCESS_AUD`・`DEPLOY_MCP=true`（`--guild-ids` があれば `ALLOWED_GUILD_IDS` も）と、シークレット `CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID` を `gh` で入れる。
   - Worker のシークレット `ALLOWED_EMAIL`（と、環境変数にあれば `DISCORD_BOT_TOKEN`）を `wrangler secret put` で入れる。Worker がまだ無ければ wrangler が空の Worker を作ってから入れる。
4. デプロイを走らせる。CI の `workflow_dispatch` で `main` を手で動かせるので、空のコミットは要らない。ジョブを見る：

   ```bash
   gh workflow run ci --ref main
   gh run watch
   ```

   （`gh run watch` は実行を選ぶ画面が出る。直近の `ci` の実行を選ぶ。）

5. `DISCORD_BOT_TOKEN` を入れていなければ、人に `cd packages/mcp && bunx wrangler secret put DISCORD_BOT_TOKEN` を頼む。

### 確かめること

- `gh variable list` と `gh secret list` に上の名前が揃っている。`cd packages/mcp && bunx wrangler secret list` に `ALLOWED_EMAIL` と `DISCORD_BOT_TOKEN` がある。
- Actions の `deploy-mcp` ジョブが成功し、「MCP のデプロイを飛ばした」の警告が出ていない。続くスモークテスト（`bun run smoke`）も成功している。
- claude.ai でコネクタを追加してログインでき、`list_guilds` が Bot の入っているサーバーを返す。

## スクリプトの入力

| 引数 | 環境変数 | 中身 |
| --- | --- | --- |
| `--host` | `MCP_HOST` | MCP を置くホスト名（必須） |
| `--email` | `ALLOWED_EMAIL` | Access で許可するメールアドレス（必須） |
| `--repo` | ― | 変数・シークレットを入れるリポジトリ（`owner/name`）。無ければ git の `origin` から決める |
| `--account-id` | `CLOUDFLARE_ACCOUNT_ID` | トークンから使えるアカウントが複数あるとき |
| `--guild-ids` | `ALLOWED_GUILD_IDS` | 扱うサーバーを限る（任意。カンマ区切り） |
| `--dry-run` | ― | Cloudflare を読むだけで、計画を出して終わる（何も作らない・入れない） |
| ― | `CLOUDFLARE_API_TOKEN` | セットアップ用の Cloudflare API トークン（必須。`wrangler secret put` にも使う） |
| ― | ― | `CLOUDFLARE_DEPLOY_TOKEN` | Actions のシークレット `CLOUDFLARE_API_TOKEN` に入れる、デプロイ権限だけのトークン（推奨。無ければ `CLOUDFLARE_API_TOKEN` を使う） |
| ― | `DISCORD_BOT_TOKEN` | Worker のシークレットに入れる Bot のトークン（任意） |

- シークレットの値（トークン・メールアドレス・アカウントID）は画面に出さない。`gh` と `wrangler` には引数ではなく stdin で渡す。シェルは通さない。
- 何度実行してもよい。同じ値で上書きされるだけで、Access アプリは2つ目を作らない。

## API トークンの権限

| 種類 | 権限 | 使うところ | CI に要るか |
| --- | --- | --- | --- |
| アカウント | Workers Scripts：Edit | `wrangler deploy`、`wrangler secret put` | 要る |
| ゾーン（ホスト名のゾーン） | Workers Routes：Edit | カスタムドメインの割り当て | 要る |
| アカウント | Access: Apps and Policies：Edit | Access アプリの検索と作成（`bun run setup` だけ） | 要らない |
| アカウント | Access: Organizations, Identity Providers, and Groups：Read | チームドメインの取得（`bun run setup` だけ） | 要らない |

- **既定は2つのトークン。** セットアップ用（上の4行すべて。`CLOUDFLARE_API_TOKEN`）は手元のスクリプトだけが使い、デプロイ用（上の2行だけ。`CLOUDFLARE_DEPLOY_TOKEN`）をスクリプトが Actions のシークレット `CLOUDFLARE_API_TOKEN` に入れる。CI のトークンに Access の権限が付かないので、CI が漏れても Access を書き換えられない（[運用の要件](../operations/requirements.md)の「CI に渡すのはデプロイ用トークンだけ」に合う）。
- **1つのトークンでもよい（簡単な代わり）。** `CLOUDFLARE_DEPLOY_TOKEN` を省くと、`CLOUDFLARE_API_TOKEN` がそのまま Actions に入る。手間は減るが、CI のトークンに Access の権限（アプリの作成・変更）も付き、運用の要件から外れる。作ったあとで Access の権限を外すか、トークンを差し替えるとよい。
- 権限を役割（Admin・Editor など）で選ぶ画面では、Workers は Worker を新しく作れる Admin を選ぶ（更新だけなら Editor で足りる）。
- カスタムドメインの DNS レコードと証明書は Cloudflare が作るので、DNS の権限は Cloudflare の文書には挙がっていない。

## ダッシュボードに残る作業

- Zero Trust の組織を初めて作るとき（チーム名とプランの選択）。
- ログインの方法（IdP）を足すとき。IdP が1つなら、アプリの Instant authentication をオンにしてもよい。
- スクリプトが警告を出した既存の Access アプリの直し（スクリプトは既存のアプリを書き換えない）。
- API トークンを作ること。

## 参考（Cloudflare の文書）

- Managed OAuth（`oauth_configuration`、DCR、redirect URI を API で設定できる）：<https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/>
- Access アプリの作成：<https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create>
- Workers の権限（カスタムドメインには Workers Routes の Write が要る）：<https://developers.cloudflare.com/workers/authorization/>
- カスタムドメイン（DNS レコードと証明書は Cloudflare が作る）：<https://developers.cloudflare.com/workers/configuration/routing/custom-domains/>

要件は [requirements.md](./requirements.md)、実装は [implementations.md](./implementations.md)。
