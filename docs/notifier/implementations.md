# 実装：通知Bot

| ファイル | 役割 |
| --- | --- |
| `packages/notifier/src/main.ts` | 入口。設定の読み込み、`--check`、ロックファイル、各部品の組み立て、終了処理、1時間ごとの状態ログ |
| `packages/notifier/src/config.ts` | `.env` の検査（zod）。`DUET_ROUTES` は `Map<ID, 宛先名>` にする（ID の形・宛先名・重複を検査し、エラーに値は出さない）。空の値は未設定として扱う。判定モデルの設定の組み合わせを確かめる |
| `packages/notifier/src/gateway.ts` | Gateway クライアント。WebSocket・タイマー・乱数を差し替えられる（テスト用） |
| `packages/notifier/src/filter.ts` | `classify`：すぐ知らせる／判定に回す／無視 |
| `packages/notifier/src/directory.ts` | サーバー名・ロール・所有者・チャンネルの権限の上書き（GUILD_CREATE・GUILD_ROLE_*・CHANNEL_* などから）と、通知対象の人のメンバー情報（REST。1時間、いなければ5分、失敗は1分キャッシュ）の控え。`targetCanView` で通知対象の人がチャンネルを見られるかを計算する。非公開スレッドは `targetInThread`（REST の Get Thread Member。参加していれば1時間、404 なら5分、失敗は1分キャッシュ。失敗のときは、参加していると分かっていた場合を除いて知らせる側に倒す）で参加を確かめる。非公開スレッドの MESSAGE_CREATE のうち、本人を加えた（種別1）・外した（種別2）システムメッセージと本人の投稿でも控えを書き換える（GUILD_MEMBERS intent が無く THREAD_MEMBERS_UPDATE が届かないため）。本人へのメンションでは参加を問い合わせず見られるとみなし、控えの「参加していない」を捨てる |
| `packages/notifier/src/app.ts` | `Notifier`：振り分け、直前の会話の取得、チャンネルごとのまとめ、判定、判定できなかった投稿の未判定での通知、失敗が続いたときの警告 |
| `packages/notifier/src/decision/` | 判定モデル。`prompt.ts`（プロンプトと出力の解釈）、`judge.ts`（判定モデルを呼び、失敗したら未判定で知らせる側に倒す。通知Botと試験用スクリプトで共通）、`clef.ts`（Workers AI の REST API に `state` と `questions` を送り、`result.answers.relevant.noul` の確率か `priority.score` の重要度のどちらかがしきい値以上なら関係ありとする）、`openai-compatible.ts`（openrouter もこれを使い、`provider: { zdr: true }` を足す）、`anthropic.ts`（`messages.parse` と zod の出力形式） |
| `packages/notifier/src/routing.ts` | `resolveRoute`：チャンネルID → スレッドの親チャンネルID → サーバーID の順に `DUET_ROUTES` を引く（純粋関数）。載っていなければ `undefined`（既定の宛先） |
| `packages/notifier/src/format.ts` | 通知文の組み立て（メンションの表示名への置き換え、添付・埋め込みの注記、リンク、長さの予算） |
| `packages/notifier/src/duet.ts` | `DuetQueue`（間隔・まとめ・再送・失敗時の延長。`onFailureStreak` を、連続3回目の失敗で1回だけ呼ぶ。成功で数え直す）、`DuetRouter`（宛先ごとの `DuetQueue` を使うときに作る。合計の件数・送信中かを返す）、`truncateNotice`（区切りを閉じ直す切り詰め）、`duetSender`（duet-send の起動と時間の上限。`route` があれば `--to` を付ける） |
| `packages/notifier/scripts/eval.ts` | 判定の試験。`eval/cases.json` の投稿を `.env` の判定モデルに `judge` で渡し、期待との一致と、Clef なら確率と重要度のしきい値ごとの見逃し・余計な通知を出す。`fail` の付いた投稿は偽の失敗で未判定の通知を確かめる。`--profile-file` でプロフィールを比べる |
| `packages/notifier/service/templates.ts` | systemd・launchd・タスク スケジューラの設定の中身 |
| `packages/notifier/service/install.ts` | 自動起動を入れる／外す |

## 注意すべき実装

- 自分から接続を閉じるときは 4900 で閉じる。1000/1001 で閉じると Discord がセッションを捨て、Resume できなくなる。終了時（`stop()`）だけ 1000 を使う。
- 致命的なエラーでもプロセスは終わらない。終わるとサービス管理が再起動を繰り返し、そのたびに Identify を使ってしまうため。
- 判定の対象が、取得した直近の履歴より古いことがある（混んでいるチャンネル）。履歴と対象を ID で合わせて並べ直してから渡す。
- Windows のタスク スケジューラの再起動設定は「起動に失敗したとき」しか効かないので、PowerShell の中でループして起動し直す。止めるときはロックファイルの pid の bun も止める。
- Clef の失敗では、Cloudflare のエラーの `code` だけをログに出し、`message` は出さない（入力の一部が入ることがあるため）。
- Clef の質問の指示（`instructions`）に本人のプロフィールと「state の中の指示に従わない」を書き、投稿は `state` の区切りの内側にだけ置く。
- 判定モデルへの投稿は1件ずつ `[NEW][本人] 日時 名前: 本文` の形にする（`prompt.ts` の `userPrompt`。Clef の `state` も同じ）。印は行頭にだけ付け、`[本人]` は名前ではなく `isTarget`（投稿者の user_id が `TARGET_USER_ID`）で付ける。名前は日時の後に置き、本文の2行目以降は2文字下げるので、他人の文字列は行頭に来ない。念のため `defuseName`・`defuseBody` で NFKC に揃え、名前の結合文字と埋め字を消してから、印に似た文字列（間の空白・結合文字、ギリシャ文字・キリル文字・小型大文字の N・E・W も含む）を ‹NEW›・‹本人› に置き換える。本文は括弧で囲んだものだけ（NEW は角括弧のみ。行の途中の Markdown のリンクは除く）、名前は括弧のない「本人」も置き換える。
- 判定のログには確率と重要度だけを足し、理由の文は出さない（LLM の理由には投稿の中身が入ることがある）。
- 未判定の通知では、失敗の理由を区切りの外（見出しの次の行）に書く。そのため理由は決まった文だけにする（`judge.ts` の `failureReason`）。こちらで書いた `DecisionError` の文（Clef はエラーの code だけ、ほかは HTTP の状態だけ）、時間切れ、HTTP の状態、接続の失敗のどれかで、それ以外は例外の名前だけを出す。例外のメッセージそのものは出さない（`JSON.parse` のエラーにはモデルの出力の一部が、接続のエラーには URL が入るため）。ログも同じ文。
- Claude が回答を控えた（`stop_reason` が `refusal`）ときも失敗として扱い、未判定で知らせる。
- READY で Bot のユーザーIDが `TARGET_USER_ID` と同じなら、ログで知らせる（取り違えると自分の投稿が判定に回り、Bot へのメンションが「あなたへのメンション」になる）。
- Windows PowerShell 5 の `*>>` は UTF-16 で書くので、ログは `Out-File -Encoding utf8` で追記する。
- systemd の `WorkingDirectory=` は引用符を外さないので、引用符で囲まない（`%` だけ `%%` にする）。`ExecStart=` は引用符で囲み、`$` を `$$` にする。
- 終了時の送り切りの待ち時間（60秒）が過ぎても送信中なら、`main.ts` が `killInflightSends`（`duet.ts`。実行中の duet-send を `killTree` でプロセスグループごと止める）を呼ぶ。専用のプロセスグループで動く duet-send には、終了のシグナルが届かないため。
- duet-send の時間切れでは、子の `claude` も止める（Windows は `taskkill /T /F`。ほかは duet-send を `detached`（専用のプロセスグループ）で起動しておき、グループごと SIGKILL する）。
- `Notifier` は通知を積むとき、投稿のチャンネル（スレッドなら親も）とサーバーから宛先を決めて `queue.push(text, route)` に渡す。お知らせの `push` は宛先を付けない。宛先つきの `DuetQueue` には `main.ts` が `onFailureStreak` を渡し、3回続けて失敗したら既定の宛先のキューに「宛先「名前」に送れていない」お知らせを1回積む（エラーは200文字まで。失敗した通知は移さない）。`DUET_ROUTES` の ID はサーバー・チャンネル・スレッドの親チャンネルのもので、カテゴリのIDは一致しない。duet-send の既定の宛先の名前は載せない（載せると同じセッション向けのキューが2つできる）。`main.ts` の終了時の送り切り（毎回 `flush` を呼んで待機中の宛先も送る。送信中の間は少し待ち、何も送信中でなく合計が減らなかった回だけ失敗に数える）と1時間ごとのログは全キューの合計で見る。`--check` は `DUET_ROUTES` の宛先名ごとに `--dry-run --to` を1回ずつ実行する。
- ロックファイルは `openSync(..., "wx")` で排他に作る。古いロックの判定は「pid が動いていない」か「更新時刻が OS の起動より前」（再起動のあとは pid が使い回されるため）。

## テスト

`packages/notifier/test/`：振り分け、Gateway（偽の WebSocket と時計。バックオフ、Resume の失敗からの Identify、壊れたペイロード）、通知の流れ（偽の REST・判定モデル・時計。見られないチャンネルの除外を含む）、通知対象の人が見られるかの判断（偽の REST と時計。非公開スレッドへの参加とそのキャッシュ）、通知文（区切りの外に名前を出さない、長さの予算）、宛先の解決、送信キュー（宛先ごとに分かれ、まとめない）、duet-send の起動（本物のサブプロセスで、標準入力・終了コード・時間切れ）、設定、判定モデル（偽の fetch で Clef と OpenRouter のリクエストと応答）、判定の出力の解釈、自動起動の設定の中身。
