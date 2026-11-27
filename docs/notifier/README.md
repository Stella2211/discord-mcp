# 通知Bot（packages/notifier）

常駐PCで動き、Discord の新しい投稿のうち自分に関係があるものを Claude Duet に知らせる。

## 何を知らせるか

| 種類 | 条件 | 判定モデル |
| --- | --- | --- |
| すぐ知らせる | 自分へのメンション、自分の投稿への返信、自分のロールへのメンション、Bot へのメンション、キーワード、（設定で）@everyone / @here | 使わない |
| 判定して知らせる | それ以外の普通の投稿 | 使う。直近の会話と一緒に渡し、関係ありのときだけ知らせる |
| 知らせない | DM、自分の投稿（Bot へのメンションを含むものは除く。判定モデルが `none` のときは自分の投稿もそのまま通知する）、この Bot の投稿、（設定で）他の Bot・Webhook、システムメッセージ、対象外のサーバー・チャンネル、**自分が見られないチャンネル** | ― |

- Bot は見られても自分は見られないチャンネル（管理者用など）の投稿は、メンションでも知らせない。サーバーのロールとチャンネルの権限の上書きから、自分の「チャンネルを見る」権限を計算する（スレッドは親チャンネルで見る。非公開スレッドは、さらに自分がそのスレッドに参加しているか、スレッドの管理の権限があるときだけ見られるとみなす。自分へのメンションは自分をスレッドに加えるので、親チャンネルを見られれば知らせる。スレッドに加えられた・外されたことは、スレッドに出るお知らせと自分の投稿からすぐに反映する）。自分がサーバーにいなければ何も知らせない。権限の材料が揃わないとき（起動直後や取得の失敗）は、取りこぼさないよう知らせる側に倒す。

- 判定は、チャンネルごとに最後の投稿から `DECISION_DEBOUNCE_SECONDS`（既定20秒）静かになってからまとめて行う。投稿が続いても `DECISION_MAX_WAIT_SECONDS`（既定120秒）で必ず判定する。
- 判定の前に、自分がその投稿より後に発言していれば、話題を見ているとみなして判定しない。
- メンションを知らせたとき、同じチャンネルで判定待ちの投稿のうち、その通知の「直前の会話」に入ったものは判定を取りやめる。入らなかったものは判定する。
- `KEYWORDS` は2文字以上。真偽値の設定は `true`/`false`（`1`/`0`、`yes`/`no`、`on`/`off`）だけを受け付け、書き間違いは起動時のエラーにする。
- `TARGET_USER_ID` は自分のユーザーID（Bot の ID ではない）。Bot の ID を入れると、自分の投稿が他人の投稿として判定され、Bot へのメンションが「あなたへのメンション」として届く。起動時と `bun run check` で Bot と同じ ID なら知らせる。
- 自分の投稿は、Bot へのメンションを含むときだけ知らせる（`NOTIFY_BOT_MENTIONS=true` のとき）。それ以外の自分の投稿とこの Bot の投稿は知らせない。
- 知らせなかった理由は `LOG_LEVEL=debug` でログに出る（`無視（self、channel …, message …）`。本文は出さない）。判定だけなら `bun run eval` で試せる。
- 見逃しを避けるため、判定は「迷ったら知らせる」側に寄せてある。余計な通知は Duet が返事をしないことで流せるが、見逃しは取り戻せないため。
- 判定モデルの呼び出しに失敗したとき（エラー、時間切れ、使用量の上限、読めない応答、回答の拒否）は、投稿を捨てずに「判定エラーのため未判定で通知」として知らせる。通知の見出しの次の行に失敗の理由が入る。
- 判定モデルが3回続けて失敗したら、それとは別に Duet にその旨を1通知らせる（6時間に1回まで）。

## 判定モデル

`.env` の `DECISION_PROVIDER` で選ぶ。既定は `none`（判定モデルを使わない）。`clef`・`openrouter`・`openai-compatible`・`anthropic` から選べる。

| 値 | 内容 |
| --- | --- |
| `clef` | Cloudflare Workers AI の判定モデル [Clef](https://developers.cloudflare.com/workers-ai/models/clef)。文章を作らず、質問への答えを確率で返す。データを残さない（ZDR）。`CLOUDFLARE_ACCOUNT_ID` と `CLOUDFLARE_AI_TOKEN` を書く。`DECISION_MODEL` は `clef-flash`（既定）か `clef`。 |
| `openrouter` | [OpenRouter](https://openrouter.ai/) 経由のモデル（モデルやプロバイダーを替えやすい）。既定は `google/gemini-3.5-flash-lite`。`DECISION_API_KEY` を書く。 |
| `openai-compatible` | `/chat/completions` を話すサーバー（LM Studio、Ollama など）。`DECISION_BASE_URL` と `DECISION_MODEL` を書く。 |
| `anthropic` | Claude の API。`DECISION_MODEL`（例: `claude-haiku-5-5`）と `ANTHROPIC_API_KEY` を書く。 |
| `none`（既定） | 判定しない。すぐ知らせるもの以外の投稿（見られるチャンネルのもの）も、判定なしでそのまま送る。判定と同じ待ち時間でチャンネルごとにまとめ、「判定なし」の通知として送る。自分の投稿（この Bot の投稿を除く）も送る。通知が多くなる。プロフィールは要らない。 |

### clef

- 1回の判定で、`state` に直近の会話（区切りの内側）を、`questions` に3つの質問を渡す。`relevant`（yes/no）で「本人が後で知らないと困るか」の確率を、`kind`（4択）で「質問・依頼／担当に関わる決定・変更／本人の話題／その他」のどれかを、`priority`（4段階の score）でどれだけ急いで見るべきかを聞く。
- `relevant` の確率が `CLEF_THRESHOLD`（既定 0.3）以上か、`priority` の重要度（0〜3）が `CLEF_PRIORITY_THRESHOLD`（既定 1.0）以上なら知らせる。どちらか一方で知らせるのは、確率は低いが重要度は高い投稿（名前の出ない担当分野の不具合報告など）を見逃さないため。重要度で知らせたくなければ `CLEF_PRIORITY_THRESHOLD=4` にする。
- 確率と重要度は通知の「判定の理由」とログにも添える（ログに投稿の中身は出さない）。
- `relevant` の質問の文は「迷ったら yes」で終える。ほかの判定モデルのプロンプトも「迷ったら true」。
- 判定の良し悪しはプロフィール（`DECISION_PROFILE`）で大きく変わる。名前の呼ばれ方（表示名・あだ名・カタカナ）、担当、知りたいことと知らなくてよいことを書く。例は `packages/notifier/eval/profile.example.md`。
- 料金は入力のトークンだけ（2026年11月時点の料金表で、`clef-flash` は100万トークンあたり3,455 Neurons、`clef` は21,818 Neurons）。Workers AI には毎日 10,000 Neurons の無料枠があり、`clef-flash` なら1日およそ290万トークンまで無料。判定1回は直近20件の会話でおよそ2,000〜4,000トークンなので、1日700〜1,400回ほど。`clef` だと110〜230回ほど。
- API トークンは、ダッシュボードの Workers AI >「REST API を使う」>「Workers AI の API トークンを作成」で作る（Workers AI の権限だけを持つ）。アカウントIDも同じ画面に出る。
- AI Gateway は通さない（ログを残さないため）。

### openrouter

- モデルは `DECISION_MODEL` で替える（既定 `google/gemini-3.5-flash-lite`）。
- リクエストに `provider: { zdr: true }` を付ける。OpenRouter はこれで、ZDR のエンドポイントと、プライバシー設定で許していれば「安全のための保持（Safety Retention）」のエンドポイントだけに送る。どちらも学習には使わない。`OPENROUTER_ZDR=false` なら `data_collection: "deny"` だけにする（データを集めるプロバイダーには送らない）。
- Gemini 3.5 Flash Lite のエンドポイントは Google AI Studio と Google Vertex だけ。AI Studio は ZDR の指定で外れ、Vertex は Safety Retention（不正利用の監視のため、引っかかったプロンプトを最大90日残すことがある。Google が必須にしている）。この保持を許容できるなら、OpenRouter のプライバシー設定で、Google のモデルに「Allow Safety Retention」を選んでおく（個人のアカウントは最初からこれ。「ZDR only」だと Gemini を呼べない）。
- `data_collection: "deny"` は Safety Retention のエンドポイントまで外すおそれがあるので、`zdr` と一緒には付けない。
- OpenRouter には、プロバイダー自身の API キーを BYOK で登録することもできる。登録したプロバイダーは優先して使われ、ZDR の条件は OpenRouter の鍵と同じ扱いになる。
- 設定が合っているかは `bun run check` で確かめる（既定の Gemini に届かなければここで失敗する）。

### 共通の設定

- `DECISION_PROFILE`（または `DECISION_PROFILE_FILE`）に、自分の担当・関心・呼ばれ方を書く。判定モデルはこれを読んで判断する。
- openrouter / openai-compatible で、モデルが JSON スキーマ指定に対応していなければ、`DECISION_JSON_MODE` を `json_object` か `none` にする。`<think>` の出力やコードフェンスが付いていても読める。

### 判定の試験（Discord に投稿しない）

```bash
cd packages/notifier
bun run eval                                         # .env の設定とプロフィールで eval/cases.json を判定する
bun run eval -- --profile-file eval/my-profile.md    # 別のプロフィールでも判定して並べる（何度でも指定できる）
bun run eval -- --cases eval/my-cases.json           # 自分で用意した投稿で試す
```

- 投稿ごとに、期待（知らせる／知らせない）と判定が合っているかを ○× で出す。Clef なら確率と重要度に加えて、「確率か重要度のどちらかで知らせる」規則での見逃しと余計な通知の数を、確率のしきい値 0.1〜0.7 ごと（重要度のしきい値はそのまま）と、重要度のしきい値 0.5〜2.0 と「使わない」ごと（確率のしきい値はそのまま）に、どの投稿かも添えて出す。これを見て `CLEF_THRESHOLD` と `CLEF_PRIORITY_THRESHOLD` を決める。
- 通知Botと同じく、判定モデルの呼び出しに失敗した投稿は「未判定で知らせる」に数える。`fail` の付いた投稿（`eval/cases.json` の最後の2件）は判定モデルを呼ばずに失敗させ、未判定で知らせることを確かめる（料金はかからない）。
- 判定モデルの料金は本番と同じくかかる（`clef-flash` なら1回数百トークンで、無料枠で足りる）。Discord のトークンと duet-send は使わない。
- 投稿の例の名前はすべて架空。自分のチームの言い回しに合わせて足すとよい。
- `eval/` に自分で置いたファイル（`my-profile.md` など）は git に入らない（`.gitignore` で、同梱の `cases.json` と `profile.example.md` 以外を外している）。

## Duet への通知

- [duet-send](https://github.com/Stella2211/duet-send) を `DUET_SEND_PATH` で指定する。通知Botは `bun <send.ts> --tag "[Discord]"` を起動し、本文を標準入力で渡す。
- `DUET_ROUTES`（`<ID>=<宛先名>` をカンマで並べる）を書くと、サーバーIDかチャンネルIDごとに宛先を振り分ける。`bun <send.ts> --tag "[Discord]" --to <宛先名>` で起動する。チャンネル → スレッドの親チャンネル → サーバー の順に探し、載っていなければ `--to` を付けない（duet-send の既定の宛先）。宛先名は duet-send の routes 表にある名前で、duet-send が `--to` に対応し `DUET_ROUTES_FILE_ID` を設定してある必要がある。宛先が違う通知は1通にまとめない（宛先ごとに最短間隔と再送を持つ）。この Bot 自身のお知らせ（接続の停止、判定モデルの失敗）は既定の宛先に送る。
- duet-send は duet-send のフォルダで起動するので、duet-send 側の `.env` が読まれる。Bot のトークンと API キーは duet-send には渡さない。
- 1回の送信は `claude -p --cloud` を1回起動するので重い。最短 `NOTIFY_MIN_INTERVAL_SECONDS`（既定30秒）空け、その間に溜まった通知は1通にまとめる。送れなかった分は残して再送する（失敗が続くと間隔を倍々に延ばす。最大32倍）。1通は `MAX_MESSAGE_CHARS`（7000文字）までで、duet-send の上限（8000文字、タグ込み）に余裕を見た値。
- duet-send が2分で終わらなければ、子プロセスごと止めて失敗として扱う（固まった duet-send で通知が止まらないように）。
- 通知文の区切りの外には `guild_id`・`channel_id`・投稿者の `user_id`・`message_id`・リンクだけを書く。サーバー名・チャンネル名・表示名・本文・判定の理由は、他人が書いたものなので `<untrusted_discord>` の区切りの内側に入れる。Duet は ID を使って MCP で前後を読んだり返信したりできる。
- 1件の通知は約5500文字まで。メンションの通知は、その投稿を先に書き、直前の会話は入るだけ新しい方から入れる。判定の通知も、新しい投稿が多ければ新しい方から入れる。まとめ送りで上限を超えたときは区切りを閉じ直してから切る。

## セットアップ

```bash
cd packages/notifier
cp .env.example .env      # 値を入れる
bun run check             # トークン・intent・サーバー・duet-send（`DUET_ROUTES` の宛先ごと）・判定モデルを確かめる
DUET_DRY_RUN=true bun run start   # 試運転（Duet に送らず、ログに出す）
bun run service:install   # OS の起動（ログイン）時に自動で起動する
```

自動起動の詳細は [autostart.md](./autostart.md)。

## 環境変数

`packages/notifier/.env`（例は `.env.example`）。空の値は未設定として扱う。真偽値は `true`/`false`。

| 変数 | 既定 | 内容 |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | 必須 | Bot のトークン（50文字以上）。duet-send には渡さない |
| `TARGET_USER_ID` | 必須 | 通知の対象になる人（自分）のユーザーID |
| `ALLOWED_GUILD_IDS` | 空（全サーバー） | 見るサーバーを限る（カンマ区切り） |
| `IGNORE_CHANNEL_IDS` | 空 | 見ないチャンネル（カンマ区切り）。スレッドは親チャンネルの指定で外れる |
| `KEYWORDS` | 空 | 含まれていたらメンションと同じ扱いで知らせる語（2文字以上、カンマ区切り、大文字小文字は区別しない） |
| `INCLUDE_BOT_MESSAGES` | `false` | 他の Bot・Webhook の投稿も見る |
| `NOTIFY_BOT_MENTIONS` | `true` | この Bot へのメンションも知らせる |
| `NOTIFY_EVERYONE` | `false` | @everyone / @here をすぐ知らせる（`false` なら判定に回す） |
| `MENTION_CONTEXT_MESSAGES` | `5` | メンションの通知に添える直前の会話の件数（0〜20） |
| `DECISION_PROVIDER` | `none` | `none` / `clef` / `openrouter` / `openai-compatible` / `anthropic` |
| `DECISION_MODEL` | clef は `clef-flash`、openrouter は `google/gemini-3.5-flash-lite` | 判定モデル名。ほかのプロバイダーでは必須 |
| `DECISION_BASE_URL` | なし | `openai-compatible` の URL（必須） |
| `DECISION_API_KEY` | なし | `openrouter` の API キー（必須）。duet-send には渡さない |
| `ANTHROPIC_API_KEY` | なし | `anthropic` の API キー（必須）。duet-send には渡さない |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_AI_TOKEN` | なし | `clef` で必須。トークンは duet-send には渡さない |
| `CLEF_THRESHOLD` | `0.3` | 関係ありの確率のしきい値（0〜1） |
| `CLEF_PRIORITY_THRESHOLD` | `1.0` | 重要度のしきい値（0〜4。3を超えると重要度では知らせない） |
| `OPENROUTER_ZDR` | `true` | `openrouter` で ZDR などデータを残さないエンドポイントだけに送る |
| `DECISION_JSON_MODE` | `json_schema` | `json_schema` / `json_object` / `none`（openrouter・openai-compatible） |
| `DECISION_PROFILE` / `DECISION_PROFILE_FILE` | なし | 自分の担当・関心・呼ばれ方。`none` 以外では、どちらかが必須（ファイルが優先） |
| `DECISION_HISTORY_MESSAGES` | `20` | 判定に渡す直近の会話の件数（1〜100） |
| `DECISION_IMAGES` | `true` | 投稿の画像を判定モデルに渡す |
| `DECISION_DEBOUNCE_SECONDS` | `20` | チャンネルごとに、最後の投稿からこの秒数静かになってから判定（0〜600） |
| `DECISION_MAX_WAIT_SECONDS` | `120` | 投稿が続いても、最初の投稿からこの秒数で必ず判定（1〜3600） |
| `DECISION_TIMEOUT_SECONDS` | `60` | 判定モデルの呼び出しの時間切れ（5〜600秒） |
| `DUET_SEND_PATH` | 必須 | duet-send の `send.ts` のフルパス |
| `DUET_TAG` | `[Discord]` | Duet で通知を見分けるタグ |
| `DUET_ROUTES` | 空 | `<ID>=<宛先名>` をカンマで並べる |
| `NOTIFY_MIN_INTERVAL_SECONDS` | `30` | Duet への送信の最短間隔（0〜3600秒） |
| `DUET_DRY_RUN` | `false` | `true` なら Duet に送らずログに出す |
| `LOG_LEVEL` | `info` | `debug` で無視した理由もログに出す |

- 上の表にない環境変数（例: `DUET_CLAUDE_BIN`）は、Bot は読まず、そのまま duet-send に渡る。`DISCORD_BOT_TOKEN`・`DECISION_API_KEY`・`ANTHROPIC_API_KEY`・`CLOUDFLARE_AI_TOKEN` だけは渡さない。サービスとして動かすときは、`PATH` に `claude` が無くても動くよう `DUET_CLAUDE_BIN` に `claude` のフルパスを書く。

## 注意

- 同じPCで二重に起動しないよう、一時フォルダにロックファイルを排他で作る。書いた pid が動いていないか、PC の起動より前に書かれたロックは古いものとして捨てる。
- 終了時（SIGINT / SIGTERM）は、未送信の通知を最大60秒かけて送ってから終わる。それでも送信中の duet-send が残っていれば、子プロセスごと強制的に止めて終わる。
- トークンが無効・intent が許可されていないなど、再接続しても直らないエラーでは、Duet に知らせてから Gateway への接続をやめる（プロセスは残る。設定を直したら再起動する）。
- 要件は [requirements.md](./requirements.md)、実装は [implementations.md](./implementations.md)。

## 画像

- **Duet への通知**: 投稿に付いた画像（添付と埋め込み）の URL・ファイル名・サイズを、通知の本文（区切りの内側）に `[画像1: ファイル名 (サイズ) URL]` で入れる。1投稿あたり4枚まで。Discord の添付 URL は署名付きで、期限が切れることがある。
- **判定モデル**: `DECISION_IMAGES=true`（既定）なら、新しい投稿の画像を新しい方から4枚まで、モデルに画像として渡す。Discord の CDN（`*.discordapp.com` / `*.discordapp.net`）の https だけを取りに行き、PNG・JPEG・WebP の1枚4MiB・合計8MiBまで。渡せなかった画像（形式・大きさ・取得失敗）は、プロンプトに「画像あり: URL」と文字で書く。
  - Clef は画像入力に対応している（Cloudflare のドキュメントの Vision: Yes。`images` に data URL を最大4枚）。URL は受け付けないので、ダウンロードして data URL で渡す。
  - OpenAI 互換は `image_url`（data URL）、Anthropic は base64 の image ブロックで渡す。
  - モデルが画像つきの呼び出しを 400 / 413 / 415 / 422 で断ったときは、画像を文字（URL）にして1回やり直す。画像を読めないモデルを使うなら `DECISION_IMAGES=false` にする。
