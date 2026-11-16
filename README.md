# techcheck bot (配信テストの Discord bot)

イベント前の配信テストを Discord で進める bot。配信者が好きな時間に `/techcheck start` で始め、bot がスレッドで案内する。運営はその場にいなくてよい。

配信の受信には [denpachan](https://github.com/RTAinJapan/denpachan) を使う。

## できること

- 配信者が配信テストのチャンネルで `/techcheck start` を実行すると、SRT の枠が空いていればプライベートスレッドを作って案内する。空いていなければ待ちの列に入れ、順番が来たら配信テストのチャンネルでメンションして「始める」のボタンを出す (DM でも知らせるが、押すのはチャンネルのボタン)。枠は既定で 1 つ (テストは 1 人ずつ) で、増やせば同時に進められる。
- 配信の開始を denpachan と CloudWatch で検出し、2 分ほど配信させて映像を判定する。乱れていれば latency の値を決めて OBS を直してもらい、直らなければ RTMP サーバに案内する。
- (使うときだけ) 配信が届いたあと、web カメラの映像を VDO.ninja で送ってもらい、bot が受信用のページを開いて映っているかを確かめる。映像の判定は、OBS の配信と web カメラの両方を送っている状態でする。
- 音声とその他のチェック (ゲーム音、静か、マイク、PC の音、画面) を順にさせ、録画の区間と参考の判定を記録する。
- (使うときだけ) Discord のボイスチャンネルで届くマイクの声を録音し、ファイルに残す。運営があとで聞いて音質を確かめる。
- 終わったらシートに 1 行書き、Discord webhook で結果を通知し、スレッドをアーカイブする。
- 配信者への案内は日本語と英語。

## 要るもの

| 要るもの | 内容 |
| --- | --- |
| Node.js | 22.13 以上 |
| ffmpeg | 配信の静止画を、denpachan の録画から取り出すのに使う。マイクの声の録音を使うなら、録った声の音量を測るのにも使う。PATH に無ければ `ffmpeg.path` に場所を書く。無くても動くが、スレッドに静止画が付かず、録音の音量も出ない |
| Discord | bot (トークン)、配信テストのチャンネル、運営のロール。運営への通知を使うならそのチャンネル、結果の通知を使うなら webhook、マイクの声の録音を使うならボイスチャンネルも |
| AWS | 配信者が SRT で送る先の MediaConnect のフローと、bot 専用の IAM ユーザーのアクセスキー |
| RTMP サーバ | SRT で安定しない配信者を案内する先 |
| denpachan | フローの出力と RTMP サーバの配信を受ける。メトリクスの受信口を有効にする。bot と同じ PC で動かす (別の PC でも動くが、録画から静止画を取れない) |
| Chrome か Edge (使うときだけ) | web カメラの確認を使うとき、bot が VDO.ninja の受信用のページを開くのに使う。bot を動かす PC に入れておく |
| Google スプレッドシート | 結果を書くシートと、サービスアカウントのキー (JSON ファイル) |
| Google ドライブ (使うときだけ) | 録画と録音を上げる先の、Google Workspace の共有ドライブ |

## 準備

### bot

```sh
npm ci
npm run build
cp config.example.yaml config.yaml
```

`config.yaml` を書き換える。項目の説明は [docs/design.md の「設定値の一覧」](docs/design.md#設定値の一覧)。

- 秘密 (トークン、パスフレーズ、キー、webhook の URL) は、`${環境変数名}` と書くと環境変数から読める。
- ファイルの場所 (`google.credentialsFile`、`db.path`、`i18n.dir`、`voice.dir`) を相対パスで書くと、`config.yaml` のあるフォルダから探す。

### トークンと権限

トークンを用意する手順は [docs/createToken.md](docs/createToken.md)。

| サービス | 設定 | 要る権限 | 備考 |
| --- | --- | --- | --- |
| Discord (bot の招待) | `discord.token` | OAuth2 スコープ `bot`、`applications.commands` | bot をサーバに招待するときに付ける。Privileged Gateway Intents は、どれも有効にしなくてよい |
| Discord (配信テストのチャンネル) | `discord.techcheckChannelId` | チャンネルを表示、メッセージを送る、プライベートスレッドを作成、Threadsでメッセージを送る、スレッドを管理、ファイルを添付、メッセージ履歴を読む | 権限の整数は 360777354240 |
| Discord (運営への通知のチャンネル) | `discord.opsChannelId` | チャンネルを表示、メッセージを送る | 未設定なら運営への通知 (途中の経過と問題) を送らない |
| Discord (ボイスチャンネル) | `voice.enabled` | チャンネルを表示、接続 | マイクの声の録音を使うときだけ。配信テストに使うボイスチャンネルに、チャンネルの権限の設定で付ける。**この 2 つの権限が bot にあるボイスチャンネルが、配信者に案内する候補になる。**Gateway Intent の `GuildVoiceStates` も使う (Privileged ではないので、Developer Portal での設定は要らない) |
| Discord (webhook) | `notify.webhookUrl` | 無い (URL そのものが秘密) | 未設定なら結果の通知を送らない |
| AWS MediaConnect | `aws.accessKeyId`、`aws.secretAccessKey` (bot 専用の IAM ユーザーのアクセスキー)。リージョンは `aws.region` | IAM ユーザーのポリシーに `mediaconnect:DescribeFlow`、`mediaconnect:StartFlow`、`mediaconnect:StopFlow`、`mediaconnect:DescribeFlowSourceMetadata`、`mediaconnect:DescribeFlowSourceThumbnail` | Resource は `flows` に書いたフローの ARN に絞る。IAM ユーザーには、このポリシーだけを付ける |
| AWS CloudWatch | 同上 | 同じポリシーに `cloudwatch:GetMetricData` | Resource は `*` (リソースで絞れないアクション) |
| AWS IAM (起動時の権限の確認) | 同上 | 同じポリシーに `iam:SimulatePrincipalPolicy` | Resource は bot の IAM ユーザー自身。上の権限がそろっているかを、何も実行せずに確かめるのに使う。無くても動くが、確認は「フローを読めるか」だけになる |
| Google スプレッドシート | `google.credentialsFile`、`google.sheet.spreadsheetId`、`google.sheet.tabName` | シートを、サービスアカウントのメールアドレスに「編集者」で共有する | Google Cloud のプロジェクトで Google Sheets API を有効にしておく。IAM ロールは要らない。`google.sheet.tabName` の名前のシート (タブ) を作っておく |
| Google ドライブ | `google.drive.folderId` (キーは、シートと同じ `google.credentialsFile`) | サービスアカウントを、上げる先の共有ドライブのメンバー (投稿者以上) にする | 録画と録音を上げるときだけ。Google Cloud のプロジェクトで Google Drive API を有効にしておく。未設定なら上げない |
| denpachan | `denpachan.host`、`denpachan.port`、`denpachan.token` | 下の「denpachan」のとおり | トークンは、loopback (同じ PC) に繋ぐなら無くてよい。それ以外では必須 |

- Discord の権限の名前は、Developer Portal の日本語の表示のもの。
- `flows[].passphrase` と `rtmp.key` は、配信者に案内する URL に入れる値で、配信者のスレッドに表示される。
- `flows[].passphrase` は、フローの source に SRT の暗号化 (パスワード) を設定しているときだけ書き、そのパスワードと同じ値にする。設定していなければ書かない (書くと、配信者が接続できない)。

### MediaConnect のフロー

- source は SRT listener にする (配信者が caller)。
- source の `MinLatency` は、`latency.initialUs` (既定 120000 μs = 120 ms。`MinLatency` は AWS の画面では ms) 以下にする。これより大きいと、配信者が OBS で設定した latency が効かない。
- denpachan 向けの SRT の出力を足しておく (ほかの受け手とは別の出力にする)。
- フローのサムネイル (`SourceMonitoringConfig` の `ThumbnailState`) は、有効にしなくてよい。配信の静止画は denpachan の録画から取る。bot を denpachan と別の PC で動かす (録画のファイルを開けない) ときだけ、予備として有効にする。
- source に SRT の暗号化を設定しているなら、そのパスワードを `flows[].passphrase` に書く。設定していなければ書かない。
- フローと配信用のドメインを組にして `flows` に書く。bot が開始・停止・監視するのは、ここに書いたフローだけ。

### denpachan

- 全体設定で、メトリクスの受信口を有効にし、操作の許可 (`allowControl`) も on にする。
- 枠に使うチャンネルに「配信テスト用」の印を付ける。bot が操作できるのは、印のあるチャンネルだけ。
- 枠のチャンネルの受信の設定 (SRT の枠はフローの出力を受ける、RTMP の枠は RTMP サーバから pull する) は、bot に入れさせるか、画面で合わせるかを選ぶ。

**bot に入れさせる (おすすめ)。** SRT と RTMP、caller と listener の取り違えが起きない。

```yaml
flows:
  - name: flow-a
    arn: arn:aws:mediaconnect:...
    domain: srt-a.example.jp
    output: flow-a-denpachan      # denpachan が受ける、フローの出力の名前
denpachan:
  configure: true
```

- denpachan の全体設定で「受信の設定の変更も許す」(`allowConfigure`) も on にする。この項目のある版の denpachan が要る。
- bot は、テストを始めるたびに、フローの出力の接続先を読んで、枠のチャンネルに入れる。出力が SRT listener なら denpachan は caller で繋ぎに行き、SRT caller なら listener で待つ。RTMP の枠には、RTMP サーバから pull する URL を入れる。
- 出力は、ほかの受け手 (vMix など) と分ける。SRT listener の出力に繋げるのは、同時に 1 つだけ。
- 出力に SRT の暗号化を設定しているなら、そのパスワードを `flows[].outputPassphrase` に書く。

**画面で合わせる。** `denpachan.configure` を書かなければ (既定)、bot は受信の設定に触らない。SRT の枠のチャンネルはフローの出力を、RTMP の枠のチャンネルは RTMP サーバの配信を受けるように、denpachan の画面で設定しておく。合っていなければ、bot は起動のときとテストを始める前に知らせる。

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

### マイクの声を録音する (ボイスチャンネル)

本番のマイクの声を、配信とは別に Discord のボイスチャンネルで受けるイベント向け。既定では使わない。マイクの声を VDO.ninja で受けるイベントでは、こちらではなく「web カメラを確かめる」の録音を使う。

```yaml
voice:
  enabled: true
  # dir: ./voice                        # 録音の置き場所 (既定)
```

- 配信テストに使うボイスチャンネルを用意し、チャンネルの権限の設定で、bot に「チャンネルを表示」と「接続」を付ける。この 2 つの権限が bot にあるボイスチャンネルが、案内の候補になる。起動すると、候補の一覧がコンソールに出る。
- チェックの最後に、マイクの声の録音の手順が足される。bot は、候補のうち空いている (だれもいない) ボイスチャンネルを選んで、スレッドで案内する。配信者がそこに入って「始める」を押すと、bot も入り、その人の声だけを 15 秒録って出る。マイクを使わない配信者は「マイクは使わない」で飛ばす。
- 空いているボイスチャンネルが無いときは、配信者に待ってもらい、空いたらメンションして案内する (運営にも知らせる)。案内したボイスチャンネルは、その人の録音の手順が終わるまで、ほかの配信者には案内しない。
- 録音は `voice.dir` に `日時 表示名 ユーザーID.ogg` で残る (Discord から届いた Opus のまま)。ファイルの場所と、声の長さ・音量はシートの「マイクの録音 (VC)」の列に書く。音質の判定は、運営がファイルを聞いて行う。
- bot がその場で見るのは、声が届いたかどうか (届かなければ直し方を伝えてやり直してもらう) と、音が割れていないか・小さすぎないか (伝えるだけ) まで。配信者には、届いた声の音量 (最大と平均の dB) と波形の画像を返し、「録り直す」「これでよい」のボタンを出す。配信者は、音量を見てマイクの入力を直し、録り直せる (残るのは最後の録音)。
- 録音は同時に 1 人だけ。SRT の枠を増やして同時にテストしていても、録音そのものは順番になる (bot は同時に 1 つのボイスチャンネルにしか入れない)。同時にテストする人数だけ、ボイスチャンネルを用意しておくと待たせずに済む。
- bot が入れるボイスチャンネルが 1 つも無いと、録音の手順は飛ばされる (運営に知らせる)。
- Discord は bot が音声を受け取る機能を文書にしておらず、動作を保証していない。録音できなかったときは運営に知らせ、テストはそのまま進む。

### web カメラを確かめる (VDO.ninja)

本番で web カメラの映像を [VDO.ninja](https://vdo.ninja/) で受けるイベント向け。既定では確かめない。

```yaml
webcam:
  links:
    - push: https://vdo.ninja/?push=AbCdEfG1     # 配信者に渡す、送信用の URL
      view: https://vdo.ninja/?view=AbCdEfG1     # bot が開く、受信用の URL
    - push: https://vdo.ninja/?push=AbCdEfG2
      view: https://vdo.ninja/?view=AbCdEfG2
```

- 送信用と受信用の URL の組を、同時にテストする人数 (SRT の枠の数) 以上、並べる。同時にテストしている人には、別々の組を渡す。ストリーム ID は、ほかで使っていない、推測されにくいものにする。画質などの VDO.ninja のパラメータ (`&quality=`、`&bitrate=` など) は、URL にそのまま書く。
- 送信用の URL が部屋を使う形 (`?room=<部屋>&push=<ID>&…`) なら、受信用は `https://vdo.ninja/?view=<ID>&solo&room=<部屋>` にする。部屋を付けない `?view=<ID>` では届かない。`&scene&room=<部屋>` は部屋の全員が映るので、使わない (だれの映像か分からない)。ID や部屋が組の中で食い違っていると、起動時にエラーになる。
- bot を動かす PC に、Google Chrome を入れておく。Edge を使うなら `webcam.browser.channel: msedge`、実行ファイルを直に指すなら `webcam.browser.path`。ブラウザは画面を出さずに動き、テストの間だけ起動する。
- 配信が届くと、bot はスレッドで送信用の URL を案内し、受信用の URL を開いて待つ。映像が届いたら (3 秒続けて)、届いた絵をスレッドに貼り、映像の判定を始める。web カメラを使わない配信者は「web カメラは使わない」で飛ばす。
- VDO.ninja は、見る側がいる間だけ送る。bot が受信用のページを開いている間、配信者の PC は OBS の配信と web カメラの両方を送る。映像の判定と latency の調整は、その状態でする。
- 判定の間に web カメラが 10 秒届かなくなったら、案内し直し、届いてから判定をやり直す。
- 判定の間の web カメラの受信の状態 (解像度、fps、ロス率、固まった回数、途切れた回数) を、シートの「web カメラ」の列に書く。ロスが 2 % 以上、固まった、途切れた、のどれかなら、運営にも知らせる (テストは進める)。
- 受信用のページは、テストが終わったら閉じる。配信者にも、終わりのまとめで、カメラのページを閉じるように伝える (開いたままだと、同じ URL を使う次の人のテストに、前の人の映像が届く)。
- bot がページを開けなかったとき (ブラウザが無い、VDO.ninja に繋がらない) は、運営に知らせ、web カメラなしでテストを進める。
- 受信用の URL は、本番で OBS のブラウザソースに入れるものと同じ形でよい (bot は映像と音声を受けるだけで、切り抜きは見ない)。

**マイクの声も VDO.ninja で録る。** 本番のマイクの声は web カメラと同じ VDO.ninja のページから届くので、マイクの確認もその経路でする (既定)。

- チェックの最後に、マイクの声の録音の手順が足される。配信者が「始める」を押すと、bot は受信用のページに届いている音声を 15 秒録る。マイクを使わない配信者は「マイクは使わない」で飛ばす。web カメラを使わない配信者も、この手順では送信用の URL を開いてもらう (案内に URL を添える)。
- 録音は `voice.dir` (既定 `./voice`) に `日時 表示名 ユーザーID.webm` で残り、シートの「マイクの録音 (VC)」の列と、Google ドライブへのアップロードは、ボイスチャンネルの録音と同じ扱い。配信者には、届いた声の音量 (最大と平均の dB) と波形の画像を返し、「録り直す」「これでよい」のボタンを出す。音量と波形には ffmpeg を使う。
- 音声が届いていない (ページを開いていない、マイクを許可していない) と、「始める」を押しても録らずに、そのことを伝える。届いていても無音 (最大 -50 dB 未満) なら、直し方を伝えてやり直してもらう。
- Discord のボイスチャンネルの録音 (`voice.enabled`) とは、どちらか一方にする。VDO.ninja ではマイクを録らないなら `webcam.mic: false`。

### 録画と録音を Google ドライブに上げる

録画と録音は、bot と denpachan を動かしている PC に残る。後日聞く人がその PC を触れないときは、Google ドライブに上げる。既定では上げない。

```yaml
google:
  credentialsFile: ./google-service-account.json
  sheet:
    spreadsheetId: 1AbCdEfGhIjKlMnOpQrStUvWxYz
  drive:
    folderId: 0AbCdEfGhIjKlMnOpQ    # 共有ドライブ (またはその中のフォルダ) の ID
```

- 上げる先は、Google Workspace の共有ドライブにする。サービスアカウント (シートと同じキー) のメールアドレスを、その共有ドライブのメンバー (投稿者以上) にする。手順は [docs/createToken.md](docs/createToken.md)。
- テストが終わると、テストごとのフォルダ (`配信テスト 2026-11-15 20:08 pasta`) を作り、そのテストの録画ファイルすべてと録音を入れる。シートの「Google ドライブ」の列に、フォルダのリンクを書く。
- アップロードは、テストの進行とは別に裏で進む。録画は 15 分のテストで 300 MB ほどあるので、回線の上りによっては数分かかる。それまで、シートには「アップロード待ち」と出る。
- 上げられなかったときは、間を空けて 3 回まで試し、だめならシートと運営への通知に理由を出す。PC の上のファイルは、上げたあとも消さない。
- bot を止めても、上げ残したテストは次に起動したときに上げる。

## 動かす

```sh
npm start
```

- 起動のとき、AWS のアクセスキーで `flows` の各フローを読めるかと、bot の使う操作 (フローの開始・停止を含む) が許可されているかを確かめて、コンソールに出す (`AWS: フロー flow-a を読めました (STANDBY)`、`AWS: 権限: bot の使う操作は、すべて許可されています`)。「読めません」「権限が足りません」と出たら、そのフローのテストは失敗するので、キーとポリシーを確かめる。
- 設定ファイルは、今いるフォルダの `config.yaml`。別のファイルを使うには `node dist/src/index.js path/to/config.yaml` か、環境変数 `TECHCHECK_CONFIG`。
- 起動すると、設定したサーバに `/techcheck` を登録する (すぐ反映される)。
- 動きはコンソールに出る: 起動したときの設定と枠、受け付けたコマンドとボタンとその返事、テストの進み具合、スレッドに書いたこと、運営への通知、エラー。運営への通知のチャンネルや webhook を見なくても、何が起きたかを追える。トークンなどの秘密は出さない。
- 止めるには Ctrl+C。進行中のテスト、待ちの列、枠の設定は `db.path` のファイルに残り、起動し直すと続きから進む。
- 設定ファイルは起動のときに読む。変えたら bot を起動し直す。起動し直せば、設定ファイルの値がすべて効く (保存してある状態より、書き換えた設定ファイルの方が優先)。bot が問題を見つけて止めた枠も、起動し直すと受付を再開する。
- 通知は 2 種類あり、設定も別。どちらも、設定を空にすれば送らない (コンソールには出る)。
  - 運営への通知 (途中の経過と問題): bot が `discord.opsChannelId` のチャンネルに書く。
  - 結果の通知 (テストが終わったとき): `notify.webhookUrl` の webhook で送る。
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
| `/techcheck shot <user>` | 運営 | 配信の静止画を貼る |
| `/techcheck latency <user> <us>` | 運営 | 配信者に案内する latency を手で決める。値は μs (OBS の URL に入れる値。180 ms なら 180000) |
| `/techcheck latency-receiver <channel> <ms>` | 運営 | denpachan の側の latency を変える (denpachan の設定の値なので、これだけは ms) |
| `/techcheck rtmp <user>` | 運営 | RTMP の案内に切り替える |
| `/techcheck cancel <user>` | 運営 | テストを中止して枠を空ける |
| `/techcheck review <user> <audio> [memo]` | 運営 | 後日、録画を聞いた音声の判定 (OK / NG) をシートに書く |

枠の設定は、設定ファイルの `slots` と `/techcheck slot` の、あとから変えた方が効く。

- `/techcheck slot` で設定し直した値は保存され、bot を起動し直しても残る。
- 設定ファイルの `slots` を書き換えて起動し直すと、書き換えた枠は設定ファイルの値になる (その枠を `/techcheck slot` で設定し直していた値は捨てる)。
- SRT の枠の数は、設定ファイルの `slots.srt` に並べた数で決まる。

## ドキュメント

- トークンの払い出し (Discord、AWS、Google): [docs/createToken.md](docs/createToken.md)
- 設計 (テストの流れ、判定の規則、設定値の一覧): [docs/design.md](docs/design.md)
- 開発 (ファイルの構成、試験、README とコードの対応): [docs/development.md](docs/development.md)
