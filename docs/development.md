# 開発

bot を直す人に向けた文書。準備と動かし方、使い方は [README](../README.md)、設計は [design.md](design.md)。

## 構成

コードのコメントの「設計書 §x」は、[design.md](design.md) の節を指す。

| ファイル | 内容 |
| --- | --- |
| `src/service.ts` | テストの進行 (受付、待ちの列、枠、案内、映像の判定、latency の調整、RTMP、チェック、終わり)。1 秒ごとの `tick()` で進める |
| `src/advisor.ts` | latency の推奨値と判定 (denpachan の `src/worker/srt_advisor.h` と同じ規則) |
| `src/checks.ts` | チェックの既定の手順と、音声のレベルによる参考の判定 |
| `src/record.ts` | シートの 1 行と webhook の本文 |
| `src/config.ts` | 設定ファイルの読み込みと検証 |
| `src/i18n.ts` | 日本語 / 英語の文言 |
| `src/ports.ts` | 外とのやりとりの口 (本物は `src/adapters/` と `src/discord/`、試験では `test/helpers.ts` の偽物) |
| `src/adapters/` | MediaConnect / CloudWatch、denpachan の受信口、シート、webhook、DNS、静止画 (`still.ts`)、ボイスチャンネルの録音 (`voice.ts`。Ogg の書き出しは `ogg.ts`) |
| `src/discord/` | `/techcheck` の定義と、コマンド・ボタン・モーダル・スレッド |

## 試験

```sh
npm test          # 外 (Discord、AWS、denpachan、シート) を偽物にして、テストの流れを 1 秒ずつ進めて確かめる
npm run typecheck
```

CI (`.github/workflows/ci.yml`) でも、型の確認・試験・ビルドを回す。CI が使うのは、自動で発行される `GITHUB_TOKEN` の `contents: read` だけで、リポジトリのシークレットは要らない。

## ログ

bot の動きは、すべてコンソール (標準出力) に 1 行ずつ出る。行の頭は時刻 (UTC)。

| 出るもの | 行の形 | 出している所 |
| --- | --- | --- |
| 起動したときの設定と状態 (秘密は出さない) | `設定ファイル: …`、`Discord: …`、`AWS: …`、`denpachan: …`、枠、進行中のテスト、待ちの列 | `src/index.ts`、`TechcheckService.startupSummary` |
| 受け付けた操作と、その返事 | `コマンド (名前): /techcheck …`、`ボタン (名前): …`、`入力 (名前): …`、次の行に `  → 返事` | `src/discord/bot.ts` の `InteractionHandler` |
| 準備の進み具合 | `準備 (名前): フロー … は ACTIVE …` | `TechcheckService.prepare` |
| テストの段階の移り変わり | `名前: measuring → confirming` | `TechcheckService.setPhase` |
| スレッドに書いたこと (ボタンも) | `スレッド (名前): …` | `TechcheckService.post` |
| 運営への通知 | `運営への通知: …` | `TechcheckService.ops` |
| 待ちの列 | `待ちの列: …` | `TechcheckService.tickQueue` |
| テストの終わり | `テスト終了: 名前 / 完了 / 映像 OK / シート …` | `TechcheckService.finish` |
| denpachan の受信口 | `denpachan: 受信口に繋がりました` など。繋がらない間は最初の 1 回だけ | `src/adapters/receiver.ts` |
| エラー | `操作の処理でエラー …` (スタック付き)、`tick …`、`CloudWatch: …`、`シート: …`、`webhook: …` | それぞれの所 |

運営への通知は、送れなくてもテストを止めない (コンソールに `運営への通知を送れませんでした` と出す)。

## 設定の反映

設定ファイルを読むのは起動のときだけ (動いている間に書き換えても効かない)。起動し直せば、設定ファイルの値がすべて効くようにしてある。保存してある状態 (`db.path` の SQLite) が設定ファイルより優先されるのは、運営が `/techcheck slot` で変えた枠だけで、それも設定ファイルのその枠を書き換えれば設定ファイルが勝つ。

| 設定 | 起動し直したとき | 保存してある状態との関係 |
| --- | --- | --- |
| `discord.*`、`notify.webhookUrl`、`aws.region`、`rtmp.*`、`denpachan.*`、`sheet.*`、`guide.*`、`judge.*`、`timeouts.*`、`i18n.*`、`ffmpeg.path`、`voice.*` | そのまま効く | 保存していない (`voice.enabled` を変えると既定の手順の数が変わるので、進行中のテストは下の `checks` と同じ) |
| `flows` (ARN、ドメイン、パスフレーズ) | そのまま効く。`/techcheck` の選択肢も登録し直す | 進行中のテストは、フローを名前で覚えている。ARN とドメインは今の設定ファイルの値に合わせ直す。名前ごと無くなっていたら、そのテストは中断する (`abortOrphans`) |
| `slots` | 書き換えた枠は、設定ファイルの値になる | 書き換えていない枠は、`/techcheck slot` で変えた値が残る。比べるために、保存したときの設定ファイルの値も保存している (`loadSlots`、`slotConfigSnapshot`) |
| 枠の「止めている」 | bot が問題を見つけて止めた枠は、受付を再開する | 運営が `/techcheck slot off` で止めた枠は、止めたまま (`stoppedByProblem`) |
| `latency.initialMs`、`latency.maxMs`、`latency.maxRaises` | 次に始まるテストから効く | 進行中のテストは、案内済みの latency と上げた回数を覚えている |
| `checks` | そのまま効く | 進行中のテストは、何番目の手順かを番号で覚えている。途中で手順を足したり減らしたりすると、ずれる |
| `db.path` | 別のファイルにすると、進行中のテスト・待ちの列・枠の設定は引き継がれない | |
| 環境変数 (`${名前}` で読むもの、`AWS_PROFILE`、`TECHCHECK_CONFIG`) | bot を起動したシェルの値を使う。`.env` のファイルは読まない | |

起動のとき、保存してあった状態を設定ファイルに合わせて変えたら、そのことをコンソールに出す (`startupSummary`)。

通知は 2 種類あり、設定も別。途中の経過と問題は bot が `discord.opsChannelId` のチャンネルに書き (`TechcheckService.ops`)、テストが終わったときの結果だけ `notify.webhookUrl` の webhook で送る (`TechcheckService.finish`)。どちらも、設定が空なら送らない。運営への通知は、送らないときもコンソールには出る。

## README とコードの対応

README の次の箇所は、コードが実際にしていることを写したもの。コードを変えたら README も直す。コードの側にも、同じことをコメントで書いてある。
Discord と AWS の権限を変えたら、[createToken.md](createToken.md) の招待の URL (権限の整数) と許可セットのポリシーも直す。ボイスチャンネルの「接続」は招待には入れず、チャンネルごとに付ける (createToken.md の「3. チャンネルの権限を確かめる」)。

Discord の権限の名前は、README と createToken.md では Developer Portal の日本語の表示、コードのコメントではそれに API の名前を添えて書いてある。

| README の箇所 | コード |
| --- | --- |
| 「トークンと権限」の Discord の招待 (OAuth2 スコープ、Gateway Intent) | `src/index.ts` (ログイン、`/techcheck` の登録、`intents`) |
| 「トークンと権限」の Discord のチャンネルごとの権限 | `src/discord/bot.ts` の `DiscordChat` (メソッドごとに、要る権限をコメントに書いてある) |
| 「トークンと権限」の Discord の webhook | `src/adapters/webhook.ts` |
| 「トークンと権限」の AWS (許可セットのポリシーのアクション) | `src/adapters/aws.ts` (送っているコマンドが、そのままアクションの名前。認証は AWS SDK の既定の探し方で、プロファイルは `AWS_PROFILE` で選ぶ) |
| 「トークンと権限」の Google スプレッドシート | `src/adapters/sheet.ts` (OAuth スコープは `https://www.googleapis.com/auth/spreadsheets`) |
| 「トークンと権限」の denpachan と、「denpachan」の準備 | `src/adapters/receiver.ts` (繋ぎ方とトークン)、`src/service.ts` (呼ぶメソッド: `startChannel`、`stopChannel`、`setRecording`、`patchChannel`)、`src/config.ts` (loopback 以外ではトークンが必須) |
| 「準備」の設定ファイル (`${環境変数名}`、相対パス)、「動かす」の設定ファイルの場所 | `src/config.ts` の `expandEnv`、`src/index.ts` の `main` |
| 「使い方」のコマンドの表 | `src/discord/commands.ts` (定義)、`src/discord/bot.ts` の `InteractionHandler` (運営のロールの確認) |
| 「denpachan」の、受信の設定を bot に入れさせる (`denpachan.configure`、`flows[].output`) | `src/service.ts` (`srtSourceFor`、`prepare`、`goRtmp`、`slotMismatches`)、`src/adapters/receiver.ts` (`hello` の `allowConfigure`)、`src/adapters/aws.ts` (フローの出力) |
| 「マイクの声を録音する」と、「トークンと権限」の Discord のボイスチャンネル | `src/adapters/voice.ts` (ボイスチャンネルに入る、声を受ける、音量を測る)、`src/adapters/ogg.ts`、`src/service.ts` (`promptVoice` が空いているボイスチャンネルを選んで案内する。`recordVoice`、`onButton` の `step-start` と `voice-skip`)、`src/checks.ts` (`voiceStep`)、`src/index.ts` (`GuildVoiceStates`) |
| 「同時に複数人をテストする」の A (SRT の枠を並べる) | `src/config.ts` (`slots.srt`)、`src/service.ts` (`loadSlots`、`freeSrtSlots`、`tickQueue`) |

設定の項目を足したり変えたりしたら、`src/config.ts`、`config.example.yaml`、[design.md の「設定値の一覧」](design.md#設定値の一覧) をそろえる。

## 実物で確かめていないこと

- CloudWatch のメトリクスのディメンション名 (`FlowARN`) と 1 秒の粒度で取れること。AWS のドキュメントの記述どおりにしてあるが、実際のアカウントで一度確かめる (`src/adapters/aws.ts`)。
- `DescribeFlowSourceMetadata` の `StreamType` と `FrameRate` の実際の値の形。
- README の「[トークンと権限](../README.md#トークンと権限)」と [createToken.md](createToken.md) のうち、次の 3 つ。
  - `/techcheck shot` の返事 (実行した人だけに見える返事) にファイルを付けるのに、「ファイルを添付」が要るかどうか。
  - IAM Identity Center のプロファイルで bot を動かしたときの動作。とくに、サインインの期限が切れたあと、`aws sso login` をし直せば bot を起動し直さなくても AWS の呼び出しが戻るかどうか。
  - createToken.md の画面の手順 (Developer Portal、IAM Identity Center のコンソール、`aws configure sso` の聞かれること、Google Cloud のコンソール)。公式の文書から書いたもので、実際の画面で通してはいない。
  - `sheet.tabName` の名前のシート (タブ) が無いときの動作。Sheets API がエラーを返すはずなので、先に作っておく手順にしてある。
- 同時に複数人をテストする動作 ([design.md の §5.7](design.md#57-同時に複数人をテストする))。
  - A (SRT の枠を増やす) は、偽物の外の口での試験だけ。実際に 2 件以上を同時に受けたときの回線と PC の負荷は見ていない。
  - B (bot を別々に動かす) は、コードを変えずにできるはずだが、実際に 2 つ動かしてはいない。サーバの設定でコマンドを使えるチャンネルを bot ごとに絞る手順も、Discord の機能の説明から書いたもの。
- 受信の設定を bot が入れる動作 ([design.md の §5.8](design.md#58-枠のチャンネルの受信の設定を-bot-が入れる)) のうち、出力が SRT caller の場合 (denpachan が listener で待つ) と、RTMP の枠。出力が SRT listener の場合は、実機で、bot が入れた設定で denpachan が受けてテストが最後まで進むことを確かめた。
- 録画から静止画を取る動作のうち、RTMP の枠の録画と、bot を別の PC で動かしたときの予備 (フローのサムネイル)。SRT の枠の録画中のファイルから ffmpeg で取り出せることは、実機で確かめた。
- マイクの声の録音 ([design.md の §7.3](design.md#73-マイクの声の録音-discord-のボイスチャンネル))。
  - 実際のサーバのボイスチャンネルで、1 人の声を受けて .ogg に書き、ffmpeg で音量を測れることは確かめた (`@discordjs/voice` 0.19.2)。
  - 同じボイスチャンネルに複数人がいるときに、その配信者の声だけが録れることは、見ていない。
  - 空いているボイスチャンネルを選ぶ動作 (候補の一覧、待たせて空いたら案内する) は、偽物の外の口での試験だけ。チャンネルごとの権限の設定 (ロールとチャンネルの上書きの組み合わせ) で、候補が意図どおりになるかは、起動のときのコンソールの一覧で確かめる。
  - Discord は bot の音声の受信を文書にしていないので、Discord や `@discordjs/voice` の更新のあとは、一度録って確かめる。
