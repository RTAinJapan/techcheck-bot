# techcheck bot (配信テストの Discord bot)

イベント前の配信テストを Discord で進める bot。配信者が好きな時間に `/techcheck start` で始め、bot がスレッドで案内する。運営はその場にいなくてよい。

配信の受信には [denpachan](https://github.com/RTAinJapan/denpachan) を使う。

## できること

- 配信者が配信テストのチャンネルで `/techcheck start` を実行すると、SRT の枠が空いていればプライベートスレッドを作って案内する。空いていなければ待ちの列に入れ、順番が来たらメンションと DM で知らせる。枠は既定で 1 つ (テストは 1 人ずつ) で、増やせば同時に進められる。
- 配信の開始を denpachan と CloudWatch で検出し、2 分ほど配信させて映像を判定する。乱れていれば latency の値を決めて OBS を直してもらい、直らなければ RTMP サーバに案内する。
- 音声とその他のチェック (ゲーム音、静か、マイク、PC の音、画面、繋ぎ直し) を順にさせ、録画の区間と参考の判定を記録する。
- 終わったらシートに 1 行書き、Discord webhook で結果を通知し、スレッドをアーカイブする。
- 配信者への案内は日本語と英語。

## 要るもの

| 要るもの | 内容 |
| --- | --- |
| Node.js | 22.13 以上 |
| Discord | bot (トークン)、配信テストのチャンネル、運営のロール、運営への通知のチャンネル。結果の通知を使うなら webhook も |
| AWS | 配信者が SRT で送る先の MediaConnect のフローと、bot 用の許可セット (IAM Identity Center)。bot を動かす PC に AWS CLI v2 |
| RTMP サーバ | SRT で安定しない配信者を案内する先 |
| denpachan | フローの出力と RTMP サーバの配信を受ける。メトリクスの受信口を有効にする |
| Google スプレッドシート | 結果を書くシートと、サービスアカウントのキー (JSON ファイル) |

## 準備

### bot

```sh
npm ci
npm run build
cp config.example.yaml config.yaml
```

`config.yaml` を書き換える。項目の説明は [docs/design.md の「設定値の一覧」](docs/design.md#設定値の一覧)。

- 秘密 (トークン、パスフレーズ、キー、webhook の URL) は、`${環境変数名}` と書くと環境変数から読める。
- ファイルの場所 (`sheet.credentialsFile`、`db.path`、`i18n.dir`) を相対パスで書くと、`config.yaml` のあるフォルダから探す。

### トークンと権限

トークンを用意する手順は [docs/createToken.md](docs/createToken.md)。AWS のアカウントは、IAM Identity Center で管理している前提。

| サービス | 設定 | 要る権限 | 備考 |
| --- | --- | --- | --- |
| Discord (bot の招待) | `discord.token` | OAuth2 スコープ `bot`、`applications.commands` | bot をサーバに招待するときに付ける。Privileged Gateway Intents は、どれも有効にしなくてよい |
| Discord (配信テストのチャンネル) | `discord.techcheckChannelId` | チャンネルを表示、メッセージを送る、プライベートスレッドを作成、Threadsでメッセージを送る、スレッドを管理、ファイルを添付、メッセージ履歴を読む | 権限の整数は 360777354240 |
| Discord (運営への通知のチャンネル) | `discord.opsChannelId` | チャンネルを表示、メッセージを送る | |
| Discord (webhook) | `notify.webhookUrl` | 無い (URL そのものが秘密) | 未設定なら結果の通知を送らない |
| AWS MediaConnect | IAM Identity Center の許可セットを割り当てたプロファイル (環境変数 `AWS_PROFILE`)。リージョンは `aws.region` | 許可セットのポリシーに `mediaconnect:DescribeFlow`、`mediaconnect:StartFlow`、`mediaconnect:StopFlow`、`mediaconnect:DescribeFlowSourceMetadata`、`mediaconnect:DescribeFlowSourceThumbnail` | Resource は `flows` に書いたフローの ARN に絞る |
| AWS CloudWatch | 同上 | 同じ許可セットのポリシーに `cloudwatch:GetMetricData` | Resource は `*` (リソースで絞れないアクション) |
| Google スプレッドシート | `sheet.credentialsFile`、`sheet.spreadsheetId`、`sheet.tabName` | シートを、サービスアカウントのメールアドレスに「編集者」で共有する | Google Cloud のプロジェクトで Google Sheets API を有効にしておく。IAM ロールは要らない。`sheet.tabName` の名前のシート (タブ) を作っておく |
| denpachan | `denpachan.host`、`denpachan.port`、`denpachan.token` | 下の「denpachan」のとおり | トークンは、loopback (同じ PC) に繋ぐなら無くてよい。それ以外では必須 |

- Discord の権限の名前は、Developer Portal の日本語の表示のもの。
- `flows[].passphrase` と `rtmp.key` は、配信者に案内する URL に入れる値で、配信者のスレッドに表示される。
- `flows[].passphrase` は、フローの source に SRT の暗号化 (パスワード) を設定しているときだけ書き、そのパスワードと同じ値にする。設定していなければ書かない (書くと、配信者が接続できない)。

### MediaConnect のフロー

- source は SRT listener にする (配信者が caller)。
- source の `MinLatency` は、`latency.initialMs` (既定 120 ms) 以下にする。これより大きいと、配信者が OBS で設定した latency が効かない。
- denpachan 向けの SRT の出力を足しておく。
- スレッドに配信の静止画を貼るには、フローのサムネイル (`SourceMonitoringConfig` の `ThumbnailState`) を有効にする。
- source に SRT の暗号化を設定しているなら、そのパスワードを `flows[].passphrase` に書く。設定していなければ書かない。
- フローと配信用のドメインを組にして `flows` に書く。bot が開始・停止・監視するのは、ここに書いたフローだけ。

### denpachan

- 全体設定で、メトリクスの受信口を有効にし、操作の許可 (`allowControl`) も on にする。
- 枠に使うチャンネルに「配信テスト用」の印を付ける。bot が操作できるのは、印のあるチャンネルだけ。
- SRT の枠のチャンネルはフローの出力を、RTMP の枠のチャンネルは RTMP サーバの配信を受けるようにしておく。

### 同時に複数人をテストする

既定では SRT の枠は 1 つで、テストは 1 人ずつ進む。同時に進めるやり方は 2 つあり、組み合わせてもよい。詳しくは [docs/design.md の §5.7](docs/design.md#57-同時に複数人をテストする)。

**A. 1 つの bot で、SRT の枠を増やす。** `slots.srt` に、同時に進めたい人数だけ枠を並べる。

```yaml
slots:
  srt:
    - { flow: flow-a, channel: 7 }
    - { flow: flow-b, channel: 6 }
    - { flow: flow-c, channel: 5, enabled: false }   # 予備。/techcheck slot on srt slot:3 で使い始める
  rtmp: { channel: 8 }
```

- 枠ごとに、別のフローと、denpachan の別のチャンネル (「配信テスト用」の印を付ける) を使う。
- 待ちの列は 1 本のままで、空いた枠に前から順に入る。
- 同じ PC と回線で、テストの数だけ同時に受けることになる。RTMP の枠は 1 つのまま。

**B. bot を別々に動かす (PC ごとに 1 つ)。** PC ごとに、bot と denpachan を 1 組ずつ動かす。

- bot ごとに、別の Discord のアプリケーション (別のトークン)、別の配信テストのチャンネル、重ならないフロー、別の `db.path` を使う。シートと webhook は同じでよい。
- 待ちの列は bot ごとに別で、配信者は空いている方のチャンネルで `/techcheck start` を実行する。
- 同じトークンの bot を 2 つ動かしてはいけない (返事が衝突し、状態も別々になる)。

## 動かす

```sh
aws sso login --profile techcheck   # AWS にサインインする (プロファイルの作り方は docs/createToken.md)
npm start
```

- AWS のプロファイルは、環境変数 `AWS_PROFILE` で選ぶ。サインインの期限が切れると AWS の呼び出しが失敗するので、`aws sso login` でサインインし直す。
- 設定ファイルは、今いるフォルダの `config.yaml`。別のファイルを使うには `node dist/src/index.js path/to/config.yaml` か、環境変数 `TECHCHECK_CONFIG`。
- 起動すると、設定したサーバに `/techcheck` を登録する (すぐ反映される)。
- 止めるには Ctrl+C。進行中のテスト、待ちの列、枠の設定は `db.path` のファイルに残り、起動し直すと続きから進む。
- シートの 1 行目が空なら、bot が見出しを書く。

## 使い方

配信者が使うのは `/techcheck start` だけで、あとはスレッドの中のボタンで進める。運営のコマンドは、運営のロール (`discord.staffRoleId`) を持つ人だけが使える。

| コマンド | 誰が | すること |
| --- | --- | --- |
| `/techcheck start [language]` | 配信者 | テストを始める (配信テストのチャンネルでだけ)。枠が使われていれば待ちの列に入る。`language` を省くと、Discord の言語設定で案内の言語を決める |
| `/techcheck leave` | 配信者 | 待ちの列から抜ける |
| `/techcheck slot show` | 運営 | 枠の設定と状態、待ちの列を見る |
| `/techcheck slot srt <flow> <channel> [slot]` | 運営 | SRT の枠に使うフローと denpachan のチャンネルを設定し直す。`slot` は枠の番号 (省けば 1 番) |
| `/techcheck slot rtmp <channel>` | 運営 | RTMP の枠に使う denpachan のチャンネルを設定し直す |
| `/techcheck slot off <kind> [slot]` / `/techcheck slot on <kind> [slot]` | 運営 | 枠の受付を止める / 再開する。止めている間も待ちの列は残る。`slot` を省くと、`off` は SRT の枠すべてを止め、`on` は枠が複数なら番号を求める |
| `/techcheck status [user]` | 運営 | 進行中のテストの段階と数字を見る |
| `/techcheck shot <user>` | 運営 | 配信の静止画を貼る (SRT のときだけ) |
| `/techcheck latency <user> <ms>` | 運営 | 配信者に案内する latency を手で決める |
| `/techcheck latency-receiver <channel> <ms>` | 運営 | denpachan の側の latency を変える |
| `/techcheck rtmp <user>` | 運営 | RTMP の案内に切り替える |
| `/techcheck cancel <user>` | 運営 | テストを中止して枠を空ける |
| `/techcheck review <user> <audio> [memo]` | 運営 | 後日、録画を聞いた音声の判定 (OK / NG) をシートに書く |

`slots` の値は初期値で、`/techcheck slot` で設定し直した値の方が優先する。SRT の枠の数は、設定ファイルの `slots.srt` に並べた数で決まる (変えたら bot を起動し直す)。

## ドキュメント

- トークンの払い出し (Discord、AWS、Google): [docs/createToken.md](docs/createToken.md)
- 設計 (テストの流れ、判定の規則、設定値の一覧): [docs/design.md](docs/design.md)
- 開発 (ファイルの構成、試験、README とコードの対応): [docs/development.md](docs/development.md)
