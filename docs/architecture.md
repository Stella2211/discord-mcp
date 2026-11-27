# 構成

## 全体

```
                ┌──────────────────────────── Discord ────────────────────────────┐
                │  Gateway（WebSocket）                    REST API v10            │
                └──────┬───────────────────────────────────────▲──────────────────┘
                       │ MESSAGE_CREATE など                    │ 読む・送る（REST だけ）
        ┌──────────────▼──────────────┐           ┌────────────┴─────────────┐
        │ 常駐PC: packages/notifier    │           │ Workers: packages/mcp     │
        │  振り分け → 判定モデル         │           │  Access の JWT 検査       │
        │  → duet-send（claude -p）     │           │  → MCP（8ツール）          │
        └──────────────┬──────────────┘           └────────────▲─────────────┘
                       ▼                                        │ Managed OAuth
                Claude Duet（コーディネーター）  ───────────▶  claude.ai のカスタムコネクタ
```

- 同じ Bot トークンを両方で使う。Gateway に接続するのは通知Botだけ（Workers は REST だけを使う）。
- 通知Botが Duet に知らせ、Duet は必要なら MCP のツールで前後を読んだり返信したりする。

## パッケージ

| パス | 役割 | 動く場所 |
| --- | --- | --- |
| `packages/discord` | REST クライアント、型、権限の計算、Snowflake、文字列の整形（区切り・制御文字の除去）。両方から使う共通部品。 | Bun と Workers の両方（`fetch` だけを使う） |
| `packages/notifier` | 通知Bot。Gateway クライアント、振り分け、判定モデル、Duet への送信キュー、自動起動の設定。 | 常駐PC（Bun） |
| `packages/mcp` | Discord MCP。Access の検査、MCP サーバーとツール。 | Cloudflare Workers |

## 通知の流れ（notifier）

1. Gateway の `MESSAGE_CREATE` を受ける（intents: GUILDS、GUILD_MESSAGES、MESSAGE_CONTENT）。
2. `filter.ts` が「すぐ知らせる」「判定モデルに回す」「無視」に振り分ける。
3. すぐ知らせるもの（メンション・返信・ロールのメンション・キーワードなど）は、直前の会話を添えて送信キューへ。
4. それ以外は、チャンネルごとに少し待ってまとめ、直近の会話と一緒に判定モデルへ。関係ありなら送信キューへ。
5. 送信キューは最短間隔を空けて、溜まった通知を1通にまとめ、duet-send を起動して Duet に送る。

## MCP の流れ（mcp）

1. Cloudflare Access（Managed OAuth）が claude.ai からの接続を認証する。
2. Worker が `Cf-Access-Jwt-Assertion` の署名・発行者・audience・メールアドレスを確かめる。
3. ツールが Discord の REST API を呼ぶ。チャンネルを使うツールは、先にチャンネルを取り、サーバーのチャンネルか・扱ってよいサーバーかを確かめる。

## 信頼の境界

- Discord の投稿・名前は他人が書いたもの。通知文と MCP の結果では `<untrusted_discord>` の区切りの内側に置き、中の `<` `>` を `‹` `›` に置き換える。
- 判定モデルの出力（理由）も投稿から作られるので、区切りの内側に置く。
- MCP の送信系ツールは、通知を `mention_user_ids` に書いた人だけに絞る（ロール・@everyone・@here は通知しない）。
