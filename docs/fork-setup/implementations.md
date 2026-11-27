# 実装：フォークのセットアップ

| ファイル | 役割 |
| --- | --- |
| `packages/mcp/scripts/setup-fork.ts` | `bun run setup`。引数の読み取り、Cloudflare API（アカウント・Zero Trust の組織・Access アプリ）、入れるものの計画、`gh`・`wrangler` の起動 |
| `packages/mcp/scripts/deploy-config.ts` | ホスト名の形（`HOSTNAME`）と `ALLOWED_GUILD_IDS` の形（`normalizeGuildIds`）をデプロイと共通にする |
| `packages/mcp/test/setup-fork.test.ts` | 引数、origin の解釈、Access の探索と作成（偽の Cloudflare API）、計画、表示に値が出ないこと、コマンドの形、伏せ字 |

## 流れ

1. `parseArgs`：引数（無ければ環境変数）を読み、ホスト名・メールアドレス・アカウントID・サーバーIDの形を確かめる。例のホスト名は断る。
2. `resolveAccess`：`CfApi`（`createCfApi` が作る、`result` を返す小さな関数）でアカウントID・チームドメインを取り、Access アプリを探す。無ければ `accessAppBody` で作る（`--dry-run` では作らない）。既存のアプリは `checkOAuth` で Managed OAuth の不足だけを調べる。
3. `buildPlan`：Actions の変数・シークレット、Worker のシークレット、人の手順（Bot のトークンが無いとき）を並べる。`formatPlan` は値を出さずに表示する。
4. `commandFor`：`gh variable set … --body`（秘密でない値）、`gh secret set …`（stdin）、`bun x wrangler secret put …`（stdin、`packages/mcp` で実行）。`Bun.spawn` に引数の配列で渡す。

## 注意すべき実装

- 環境変数は Bun が `packages/mcp/.env` から読む。wrangler には `CLOUDFLARE_API_TOKEN`（セットアップ用）と、見つけた `CLOUDFLARE_ACCOUNT_ID` を渡す。
- 子プロセスの出力は画面に流さず、失敗したときだけ `redact` で値を伏せて出す。
- Cloudflare API のエラーは、パスのクエリを落とし、Cloudflare のエラーコードと文言だけを出す。
