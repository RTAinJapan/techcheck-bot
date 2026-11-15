# techcheck bot (配信テストの Discord bot)

イベント前の配信テストを Discord で進める bot。

- **設計書**: [docs/design.md](docs/design.md)。コードのコメントの「設計書 §x」は、この文書の節を指す。
- 受信には [denpachan](https://github.com/RTAinJapan/denpachan) を使う。bot と denpachan は、denpachan のメトリクスの受信口 (WebSocket) だけでやりとりする。
- はじめは denpachan のリポジトリの `bot/techcheck/` で作った。そのときのコミットの履歴を引き継いでいる。

## できること

- 配信者が配信テストのチャンネルで `/techcheck start` を実行すると、枠 (SRT 1 つ) が空いていればプライベートスレッドを作って案内する。空いていなければ待ちの列に入れ、順番が来たらメンションと DM で知らせる。
- 配信の開始を denpachan と CloudWatch で検出し、2 分ほど配信させて映像を判定する。乱れていれば latency の値を決めて OBS を直してもらい、直らなければ ECS の RTMP サーバに案内する。
- 音声とその他のチェック (ゲーム音、静か、マイク、PC の音、画面、繋ぎ直し) を順にさせ、録画の区間と参考の判定を記録する。
- 終わったらシートに 1 行書き、Discord webhook で結果を通知し (URL が未設定なら送らない)、スレッドをアーカイブする。
- 配信者向けの文言は日本語と英語 (`messages/ja.yaml`、`messages/en.yaml`)。

## 動かす

Node.js 22.13 以上 (SQLite は Node 付属の `node:sqlite` を使う)。

```sh
npm ci
cp config.example.yaml config.yaml   # 書き換える (項目は設計書 §4.1 の表)
npm run build
npm start                            # または node dist/src/index.js path/to/config.yaml
```

- 起動すると、設定したサーバに `/techcheck` を登録する (サーバのコマンドなので、すぐ反映される)。
- 各サービスのトークンと、それに要る権限は、下の「トークンと権限」の表のとおり。
- シートは、1 行目が空なら見出しを書く。
- denpachan の側では、全体設定でメトリクスの受信口を有効にし (`allowControl` も on)、枠に使うチャンネルに「配信テスト用」の印を付ける。

## トークンと権限

bot が実際に呼んでいる操作に要る、最小の権限。操作を足したら、この表も直す。

| サービス | トークンの種類 | 設定名 | 要る権限 | 何のために要るか | 備考 |
| --- | --- | --- | --- | --- | --- |
| Discord (bot) | Bot トークン | `discord.token` (`${DISCORD_TOKEN}`) | OAuth2 スコープ: `bot`、`applications.commands` | Gateway へのログイン、サーバのコマンド `/techcheck` の登録 (`src/index.ts`) | bot をサーバに招待するときに付ける |
| Discord (bot) | 同上 | 同上 | Gateway Intent: `Guilds` だけ。Privileged Intent は要らない | サーバとチャンネルの情報、interaction の受け取り (`src/index.ts`) | 運営のロールは interaction の member から見るので、Server Members Intent は要らない |
| Discord (bot) | 同上 | チャンネルは `discord.techcheckChannelId` | 配信テストのチャンネルで View Channel、Send Messages、Create Private Threads、Send Messages in Threads、Manage Threads、Attach Files、Read Message History | プライベートスレッドの作成と配信者の追加、スレッドへの投稿と静止画の添付、押したあとのボタンを外すためのメッセージの取得、ロックとアーカイブ、順番の知らせのメンション (`src/discord/bot.ts` の `DiscordChat`) | 権限の整数は 360777354240。Read Message History が無いと、ボタンが残る (エラーにはならない) |
| Discord (bot) | 同上 | チャンネルは `discord.opsChannelId` | 運営への通知のチャンネルで View Channel、Send Messages | 運営への通知 (`DiscordChat.ops`) | |
| Discord (webhook) | Webhook の URL | `notify.webhookUrl` (`${TECHCHECK_WEBHOOK_URL}`) | 権限は無い (URL そのものが秘密) | 結果の通知 (`src/adapters/webhook.ts`) | 未設定なら送らない。URL を作る人に Manage Webhooks が要る |
| AWS MediaConnect | IAM のアクセスキー | 環境変数 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` か AWS のプロファイル。リージョンは `aws.region` | `mediaconnect:DescribeFlow`、`mediaconnect:StartFlow`、`mediaconnect:StopFlow`、`mediaconnect:DescribeFlowSourceMetadata`、`mediaconnect:DescribeFlowSourceThumbnail` | フローの状態と受け口、開始と停止、映像の形式、静止画 (`src/adapters/aws.ts`) | Resource は `flows` に書いたフローの ARN に絞る |
| AWS CloudWatch | 同上 | 同上 | `cloudwatch:GetMetricData` | 名前空間 `AWS/MediaConnect` のメトリクスを 1 秒の粒度で取る (`src/adapters/aws.ts`) | Resource は `*` (リソースで絞れないアクション) |
| Google Sheets API v4 | サービスアカウントのキー (JSON ファイル) | `sheet.credentialsFile`、`sheet.spreadsheetId`、`sheet.tabName` | OAuth スコープ `https://www.googleapis.com/auth/spreadsheets`。シートをサービスアカウントのメールアドレスに「編集者」で共有する | 1 行目の読み取り、行の追加、後日の音声の判定の書き換え (`src/adapters/sheet.ts`) | GCP の IAM ロールは要らない。プロジェクトで Sheets API を有効にしておく |
| denpachan (メトリクスの受信口) | 受信口のトークン | `denpachan.token` (`${DENPACHAN_TOKEN}`) | トークンに権限の区別は無い。denpachan の側で `metrics.enabled` と `metrics.allowControl` を on にし、枠のチャンネルに「配信テスト用」の印 (`testSlot`) を付ける | `channels` の受信、`startChannel`、`stopChannel`、`setRecording`、`patchChannel` (`src/adapters/receiver.ts`、`src/service.ts`) | loopback に繋ぐならトークンは無くてよい。それ以外では必須 |

- `flows[].passphrase` と `rtmp.key` は、配信者に案内する URL に入れるだけで、API の認証には使わない。
- CI (GitHub Actions) は、自動で発行される `GITHUB_TOKEN` の `contents: read` だけを使う。リポジトリのシークレットは要らない。

## 試験

```sh
npm test          # 外 (Discord、AWS、denpachan、シート) を偽物にして、テストの流れを 1 秒ずつ進めて確かめる
npm run typecheck
```

CI (`.github/workflows/ci.yml`) でも、型の確認・試験・ビルドを回す。

## 実物で確かめていないこと

- CloudWatch のメトリクスのディメンション名 (`FlowARN`) と 1 秒の粒度で取れること。AWS のドキュメントの記述どおりにしてあるが、実際のアカウントで一度確かめる (`src/adapters/aws.ts`)。
- `DescribeFlowSourceMetadata` の `StreamType` と `FrameRate` の実際の値の形。
- 「トークンと権限」の表のうち、次の 3 つ。
  - `applications.commands` スコープが要ること (招待の URL はコードに無いので、Discord の仕様から割り出した)。
  - `/techcheck shot` の返事 (実行した人だけに見える返事) にファイルを付けるのに、Attach Files が要るかどうか。
  - `mediaconnect:DescribeFlowSourceMetadata` と `mediaconnect:DescribeFlowSourceThumbnail` を、IAM ポリシーでフローの ARN に絞れるかどうか。
- denpachan のメトリクスの受信口と実際に繋いだ動作。`channels` メッセージの形は denpachan の `src/engine/metrics_view.cpp` に合わせて試験している。

## 構成

| ファイル | 内容 |
| --- | --- |
| `src/service.ts` | テストの進行 (受付、待ちの列、枠、案内、映像の判定、latency の調整、RTMP、チェック、終わり)。1 秒ごとの `tick()` で進める |
| `src/advisor.ts` | latency の推奨値と判定 (denpachan の `src/worker/srt_advisor.h` と同じ規則) |
| `src/checks.ts` | チェックの既定の手順と、音声のレベルによる参考の判定 |
| `src/record.ts` | シートの 1 行と webhook の本文 |
| `src/config.ts` | 設定ファイルの読み込みと検証 |
| `src/i18n.ts` | 日本語 / 英語の文言 |
| `src/ports.ts` | 外とのやりとりの口 (本物は `src/adapters/` と `src/discord/`、試験では `test/helpers.ts` の偽物) |
| `src/adapters/` | MediaConnect / CloudWatch、denpachan の受信口、シート、webhook、DNS |
| `src/discord/` | `/techcheck` の定義と、コマンド・ボタン・モーダル・スレッド |
