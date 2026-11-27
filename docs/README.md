# ドキュメント索引

discord-mcp は、1つの Discord Bot（1つのトークン）を2か所から使うための仕組みです。

- 通知Bot（`packages/notifier`）：常駐PCで動き、Gateway で新しい投稿を受けて、自分に関係がある投稿を Claude Duet に知らせる。
- Discord MCP（`packages/mcp`）：Cloudflare Workers + Cloudflare Access で動くリモートMCPサーバー。claude.ai から Discord を読んだり投稿したりする。

全体の構成は [architecture.md](./architecture.md)。

## 機能フォルダ

| フォルダ | 内容 |
| --- | --- |
| [discord-app/](./discord-app/README.md) | Developer Portal での Bot の作り方、Message Content Intent、最小の権限、招待URL。 |
| [notifier/](./notifier/README.md) | 常駐PCの通知Bot。Gateway の接続、振り分け、判定モデル、Duet への通知、OS 起動時の自動起動。 |
| [mcp/](./mcp/README.md) | Workers 上の Discord MCP。Access による認証、8つのツールの入出力と制限。 |
| [operations/](./operations/README.md) | CI、Renovate、シークレットの置き場所、デプロイとスモークテスト。 |
| [fork-setup/](./fork-setup/README.md) | フォークしたリポジトリを Claude Code に渡してデプロイまで進める手順。人の作業と Claude Code の作業、API トークンの権限。 |

各機能フォルダは `README.md`（概要・注意点）、`requirements.md`（要件）、`implementations.md`（実装の概要と関連ファイル）で構成する。`notifier/autostart.md` は自動起動の詳細。
