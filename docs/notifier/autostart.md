# 自動起動（OS の起動・ログイン時）

`packages/notifier` で `bun run service:install` を実行すると、OS に合わせて次を設定する。外すときは `bun run service:uninstall`。書く内容だけ見るときは `bun service/install.ts install --dry-run`。

先に `.env` を作っておく（無いと止まる）。`claude` が PATH に無いと警告するので、そのときは `.env` に `DUET_CLAUDE_BIN`（claude のフルパス）を書く。

| OS | 仕組み | いつ起動するか | 落ちたとき |
| --- | --- | --- | --- |
| Linux | systemd のユーザーサービス `~/.config/systemd/user/pulsar-bot-notifier.service` | ログイン時。ログインしなくても起動時に動かすには `sudo loginctl enable-linger $USER` を一度実行する | 10秒後に再起動（`Restart=always`） |
| macOS | LaunchAgent `~/Library/LaunchAgents/local.pulsar-bot.notifier.plist` | ログイン時（`RunAtLoad`） | 再起動（`KeepAlive`、30秒以上空ける） |
| Windows | タスク スケジューラ「pulsar-bot-notifier」 | ログオン時。`--at-startup` を付けると起動時（管理者の PowerShell から実行する） | PowerShell の中のループで30秒後に起動し直す |

## ログ

| OS | 場所 |
| --- | --- |
| Linux | `journalctl --user -u pulsar-bot-notifier -f` |
| macOS | `~/Library/Logs/pulsar-bot-notifier.log` |
| Windows | `%LOCALAPPDATA%\pulsar-bot-notifier\pulsar-bot-notifier.log` |

ログには、通知した種類・チャンネルID・メッセージID・判定の結果が出る。`LOG_LEVEL=debug` なら、無視した投稿の理由（dm / guild / channel / self など）も出る。投稿の本文とトークンは出さない。

## 注意

- 自動起動は、そのとき使っている bun のフルパスと `packages/notifier` のフォルダを書き込む。フォルダを移したら入れ直す。
- macOS で `~/Documents` などの下に置くと、bun にフルディスクアクセスが要ることがある。ホームの直下などに置くと楽。
- Windows の `--at-startup` はパスワードを保存しない方式（S4U）で登録する。この方式ではネットワーク上の共有フォルダは使えず、ログオンしていない間はユーザーの資格情報も使えない。duet-send が呼ぶ `claude` のログイン情報を読めないことがあるので、まず `--at-startup` なし（ログオン時）で試し、起動時にしたいときはログで送信が成功しているか確認する。
- Windows のログは UTF-8 で追記する。
- プロセスの中でも、Discord との切断からは自動で再接続する（Resume できれば取りこぼしなし）。
