## プロジェクト概要

discord-mcp は、1つの Discord Bot（1つのトークン）を2か所から使うモノレポ（Bun workspaces）。

- `packages/discord`：共通部品（REST クライアント、型、権限の計算、Snowflake、文字列の整形）。Bun と Workers の両方で動く。
- `packages/notifier`：常駐PCの通知Bot（Gateway → 振り分け → 判定モデル → duet-send で Claude Duet へ）。Bun で動く。
- `packages/mcp`：Cloudflare Workers + Cloudflare Access のリモートMCPサーバー（Discord REST だけを使う8ツール）。Cloudflare Access の JWT を Worker 側でも検査する。

- ドキュメントの索引：`docs/README.md`（構成は `docs/architecture.md`）
- 主要コマンド：`bun run typecheck`（3パッケージの型検査）、`bun test`、`cd packages/notifier && bun run check`、`cd packages/mcp && bun run dev` / `bun run smoke` / `bun run deploy`
- 注意：`packages/mcp` と `packages/discord` は Workers でも動く。Bun 固有の API（`Bun.file` など）を使わない。Bun は開発ツールと、通知Botの実行環境としてだけ使う。
- 注意：Discord の利用者が書いたもの（本文・名前）は、通知文でも MCP の結果でも `wrapUntrusted` の区切りの内側に置く。送信系は `allowed_mentions.parse` を空にし、通知は明示した人にだけ届ける。
- 注意：シークレット（Bot のトークン、API キー）・メールアドレス・Discord の ID をコードやドキュメントに書かない。例はプレースホルダーにする。
- 注意：Discord の仕様（エンドポイント、Gateway の手順、エラーコード）は、変える前に https://docs.discord.com/developers の最新の記述で確かめる。

## フォークのセットアップ

フォークしたリポジトリでデプロイまで進めるよう頼まれたら、[docs/fork-setup/README.md](docs/fork-setup/README.md) の「Claude Code がやること」に沿って進める（`cd packages/mcp && bun run setup -- --host … --email … --dry-run` で計画を確かめてから実行）。トークンはチャットで受け取らず、利用者に `packages/mcp/.env` か環境変数に入れてもらう。人にしかできない作業は、その文書の「人がやること」として頼む。

## 開発の決まり

- Bun を使う（`bun install`、`bun test`、`bun run <script>`、`bunx`）。Node.js・npm・jest は使わない。`.env` は Bun が自動で読むので dotenv は使わない。
- テストは `bun:test`。外部（Discord、判定モデル、duet-send、Cloudflare）には繋がず、偽物を差し込む。時計・タイマー・WebSocket は引数で差し替えられるように書く。
- 依存は少なく保つ。Discord のライブラリは入れない。

## 実装手順

以下はメインエージェント（ユーザーと直接対話しているエージェント）専用の手順。

1. ユーザーの指示に不明点がないか確認し、あれば確認する
2. 不明点がなくなれば、`update-docs`スキルを参考に要件を整理してドキュメントを更新する
3. 実装が完了したら `bun run typecheck` と `bun test` を通す
4. 実装が完璧か再確認し、不備があれば修正する
5. サブエージェントで`code-review`スキルを動かし、徹底的にバグチェックを行う。要件と対象範囲を共有するのを忘れずに
6. 発見された問題を修正する
7. `update-docs`スキルを参考に、要件を実装に合わせて更新する
8. 最後に変更をコミットする（コミットメッセージは既存の履歴の流儀に合わせる）
