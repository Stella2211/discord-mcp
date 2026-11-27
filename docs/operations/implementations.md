# 実装：運用

| ファイル | 役割 |
| --- | --- |
| `.github/workflows/ci.yml` | 検査（typecheck・test）と、条件付きの MCP のデプロイ・スモークテスト（デプロイ先の値はリポジトリ変数から） |
| `renovate.json` | 依存の更新の設定 |
| `bunfig.toml` | `minimumReleaseAge`（7日） |
| `.gitignore` | `.env*`・`.dev.vars*`（例のファイルを除く）、`node_modules`、`.wrangler`、`packages/mcp/wrangler.deploy.jsonc` |
| `packages/mcp/scripts/deploy-config.ts` | `bun run deploy` の前半。`wrangler.jsonc` のプレースホルダーを環境変数の値に置き換えた `wrangler.deploy.jsonc` を作る（値の形と、各キーが1か所だけあることを確認する） |
| `packages/mcp/scripts/smoke.ts` | デプロイ後の疎通確認 |
