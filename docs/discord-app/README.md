# Discord アプリ（Bot）の準備

通知Botと MCP は同じ Bot を使う。ここでは Developer Portal での作り方と、サーバーへの追加方法をまとめる。

## 作り方

1. <https://discord.com/developers/applications> で New Application を作る（名前は自由。Bot の表示名になる）。
2. **Bot** ページで Reset Token を押してトークンを発行し、パスワード管理ツールに保存する。トークンは通知Botの `.env` と、MCP の `wrangler secret put DISCORD_BOT_TOKEN` だけに入れる。
3. 同じ **Bot** ページの Privileged Gateway Intents で **Message Content Intent** をオンにする。
   - オフのままだと、メンション以外の投稿の本文が空で届く（REST で読んだときも同じ）。通知Botは close code 4014 で止まる。
   - Bot が入るサーバーが100未満なら審査は要らない。
   - Server Members Intent と Presence Intent は要らない。
4. **Installation** ページで、Install Link を「None」にしておくと、下の招待URLだけで追加を管理できる。
5. **Bot** ページの Public Bot：オンのままにしておく。オフにすると、アプリの所有者以外（所属先のサーバーの管理者など）は Bot を追加できない。管理者に追加してもらったあとでオフにしてもよい（追加済みのサーバーからは外れない）。

## 権限（最小）

| 権限 | ビット | 使うところ |
| --- | --- | --- |
| View Channels | `1 << 10` | チャンネルを見る（全部） |
| Send Messages | `1 << 11` | `send_message`・`reply_to_message`。自分の投稿を直す `edit_message` も、追加の権限は要らない |
| Send Messages in Threads | `1 << 38` | スレッドへの投稿 |
| Read Message History | `1 << 16` | 過去の投稿を読む・検索・通知に添える直前の会話 |
| Add Reactions | `1 << 6` | `add_reaction` |

合計は **`274877975616`**。管理者権限（Administrator）は付けない。読むだけのチャンネルでは、チャンネルの設定で Send Messages を外せばよい。

## 招待URL

```
https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=274877975616
```

- `<APPLICATION_ID>` は General Information ページの Application ID。
- まず自分のプライベートサーバーで開いて追加し、動作を確かめてから、同じ URL をほかのサーバーの管理者に送る。
- 追加の画面で、管理者が権限を外すこともできる。外された権限を使うツールは「権限がない」と返す。

## 注意

- トークンが漏れたら、Bot ページで Reset Token を押して作り直し、`.env` とシークレットを入れ替える。古いトークンはすぐ使えなくなる。
- 管理者に追加してもらったサーバーで Bot が見えるチャンネルは、サーバーのロールとチャンネルの上書きで決まる。`list_channels` で、Bot から見えるか・送れるかを確かめられる。
- 詳しい要件は [requirements.md](./requirements.md)、実装との対応は [implementations.md](./implementations.md)。
