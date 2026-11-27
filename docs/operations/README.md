# 運用

## シークレットの置き場所

| 値 | 通知Bot | MCP |
| --- | --- | --- |
| Bot のトークン | `packages/notifier/.env` の `DISCORD_BOT_TOKEN` | `wrangler secret put DISCORD_BOT_TOKEN` |
| 判定モデルの API キー | `.env` の `CLOUDFLARE_AI_TOKEN`（Workers AI の権限だけ）/ `DECISION_API_KEY` / `ANTHROPIC_API_KEY` | ― |
| 許可するメールアドレス | ― | `wrangler secret put ALLOWED_EMAIL` |
| ホスト名・Access の設定値（秘密ではない） | ― | リポジトリ変数 `MCP_HOST`・`ACCESS_TEAM_DOMAIN`・`ACCESS_AUD`（`bun run deploy` が `wrangler.deploy.jsonc` に入れる。リポジトリの `wrangler.jsonc` はプレースホルダー） |

- `.env` と `.dev.vars` は git に入らない（`.gitignore`）。リポジトリにはプレースホルダーの `.env.example` と `.dev.vars.example` だけを置く。
- トークンを再発行したら、両方を入れ替えて、通知Botを再起動する。

## CI（GitHub Actions）

- `.github/workflows/ci.yml`：PR と `main` への push で、`bun install --frozen-lockfile`、`bun run typecheck`、`bun test`。
- MCP のデプロイは、リポジトリ変数 `DEPLOY_MCP` が `true` のときだけ `main` への push で走る（`production` 環境、シークレット `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` が要る）。
  - デプロイ先の値はリポジトリ変数 `MCP_HOST`・`ACCESS_TEAM_DOMAIN`・`ACCESS_AUD` から読み、`bun run deploy`（`packages/mcp/scripts/deploy-config.ts` が値を入れた `wrangler.deploy.jsonc` を作り、それでデプロイする）に渡す。スモークテストには `SMOKE_HOST` として `MCP_HOST` を渡す。
  - 3つのどれかが空なら、デプロイとスモークテストを飛ばし、足りない変数の名前を警告に出す。ジョブは成功のままで、本番は前の版のまま残る。
  - 手元からのデプロイは [docs/mcp/](../mcp/README.md) の「デプロイ」。
- アクションはコミットの SHA で固定し、checkout は `persist-credentials: false`。

## 依存関係

- Renovate（`renovate.json`）。公開から7日たった版だけを入れる（`bunfig.toml` の `minimumReleaseAge` も同じ）。
- 依存は少なく保つ。Discord のライブラリは使わず、REST と Gateway を自前の小さなクライアントで扱う。

## 確認のコマンド

```bash
bun run typecheck      # 3つのパッケージの型検査
bun test               # 全テスト（Discord・判定モデル・duet-send には繋がない）
cd packages/notifier && bun run check   # 実際のトークンで通知Botの設定を確認する
cd packages/mcp && bun run smoke        # デプロイ後の疎通確認
```
