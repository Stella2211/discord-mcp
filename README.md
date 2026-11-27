[English](README.en.md)

# discord-mcp

1つの Discord Bot（トークン1つ）を、通知Botと MCP の2か所から使う仕組みです。

- **通知Bot**（`packages/notifier`）：常駐PCで動く。新しい投稿のうち、自分へのメンションなどはすぐに、それ以外は判定モデルが「関係ありそう」としたものだけ（判定モデルを使わない設定では、見られるチャンネルのすべての投稿）を、[duet-send](https://github.com/Stella2211/duet-send) で Claude Duet に知らせる。
- **Discord MCP**（`packages/mcp`）：Cloudflare Workers + Cloudflare Access で動くリモートMCPサーバー。claude.ai から、サーバー・チャンネルの一覧、過去の投稿の読み取り、検索、投稿、返信、リアクション、Bot 自身の投稿の編集ができる。
- **共通部品**（`packages/discord`）：REST クライアント、型、権限の計算、Snowflake、文字列の整形。Bun と Workers の両方で動く。

設計と詳細は [docs/README.md](./docs/README.md) にあります。

## 前提

- [Bun](https://bun.sh)
- Discord の Developer Portal で作った Bot（[docs/discord-app/](./docs/discord-app/README.md)）
- 通知Bot：常駐PC（macOS・Linux・Windows）、duet-send と Claude Code（`claude`）
- MCP：Cloudflare アカウント、カスタムドメイン、Cloudflare Zero Trust（無料プランで可）

## はじめ方

```bash
bun install
```

1. **Bot を作る。** Message Content Intent をオンにし、招待URLで自分のサーバーに追加する（[docs/discord-app/](./docs/discord-app/README.md)）。
2. **通知Botを動かす。**

   ```bash
   cd packages/notifier
   cp .env.example .env              # トークン・自分のユーザーID・duet-send のパス・判定モデルを書く
   bun run check                     # 設定を確認する
   DUET_DRY_RUN=true bun run start   # 試運転（Duet に送らずログに出す）
   bun run service:install           # 自動起動を入れる
   ```

   詳しくは [docs/notifier/](./docs/notifier/README.md)。
3. **MCP をデプロイする。** Access アプリを作り、シークレットを入れ、ホスト名と Access の値を環境変数で渡してデプロイする。`wrangler.jsonc` はプレースホルダーのままにする（手順と CI からのデプロイは [docs/mcp/ の「デプロイ」](./docs/mcp/README.md#デプロイ)）。

   ```bash
   cd packages/mcp
   bunx wrangler secret put DISCORD_BOT_TOKEN
   bunx wrangler secret put ALLOWED_EMAIL
   MCP_HOST=… ACCESS_TEAM_DOMAIN=… ACCESS_AUD=… bun run deploy
   bun run smoke
   ```

4. **claude.ai に追加する。** カスタムコネクタの URL に `https://<ホスト名>/mcp` を指定する。

フォークして Claude Code に任せるなら、人がやるのは API トークンの作成など外部の画面の作業だけで、3 の変数・シークレットの登録とデプロイは Claude Code が進められる（[docs/fork-setup/](./docs/fork-setup/README.md)）。

## 開発

```bash
bun run typecheck    # 3つのパッケージの型検査
bun test             # 全テスト（外部には繋がない）
cd packages/mcp && cp .dev.vars.example .dev.vars && bun run dev   # wrangler dev（ポート 8788）
```

- `packages/mcp` と `packages/discord` は Workers でも動くので、Bun 固有の API（`Bun.file` など）を使わない。
- シークレット・メールアドレス・ID はリポジトリに書かない。

## ドキュメント

- [docs/README.md](./docs/README.md)：索引
- [docs/architecture.md](./docs/architecture.md)：構成
- [docs/operations/](./docs/operations/README.md)：CI・シークレット・依存関係
- [SECURITY.md](./SECURITY.md)：セキュリティポリシー（脆弱性の報告方法）

## ライセンス

[MIT](LICENSE)
