# トークンの払い出し

bot を動かすのに要る Discord、AWS、Google の認証情報を、用意する手順。どの権限が何のために要るかは [README の「トークンと権限」](../README.md#トークンと権限)。

- 払い出した値は秘密。`config.yaml` に直接書くか、環境変数に入れて `${環境変数名}` で読ませる。キーのファイルも含めて、リポジトリには入れない。
- 画面の名前は、Discord の Developer Portal と Google Cloud のコンソールは英語の表示、AWS は日本語のコンソールの表示で書いてある。表示の言語が違うと、訳された名前で出る。

## Discord

### 1. アプリケーションと bot を作る

1. [Discord Developer Portal](https://discord.com/developers/applications) を開き、`New Application` で名前を付けて作る。
2. `General Information` のページの `Application ID` を控える (招待の URL に使う)。
3. `Bot` のページを開く。
   - `Token` の `Reset Token` を押し、表示されたトークンを控える。これが `discord.token` (`DISCORD_TOKEN`)。トークンはあとから見直せない。見失ったら `Reset Token` で作り直す (古いトークンは使えなくなる)。
   - `Privileged Gateway Intents` (`Presence Intent`、`Server Members Intent`、`Message Content Intent`) は、3 つとも off のままでよい (マイクの声の録音を使うときも)。
   - `Public Bot` を off にすると、作った本人しかサーバに追加できなくなる。

### 2. サーバに招待する

次の URL の `<Application ID>` を置き換えて、ブラウザで開く。サーバを選んで認証すると、bot がサーバに入る。開く人には、そのサーバの「サーバー管理」の権限が要る。

```text
https://discord.com/oauth2/authorize?client_id=<Application ID>&scope=bot%20applications.commands&permissions=360777354240
```

- `scope` は `bot` と `applications.commands`。`/techcheck` の登録に要る `applications.commands` は `bot` に含まれるが、公式の手順に合わせて両方書いてある。
- `permissions` の 360777354240 は、次の 7 つの権限を足した値。`Bot` のページの「Botの権限」でこの 7 つにチェックを入れると、`Permissions Integer` に同じ値が出る。

| 権限 (Developer Portal の日本語の表示) | API の名前 | 値 |
| --- | --- | --- |
| チャンネルを表示 | `VIEW_CHANNEL` | `1 << 10` |
| メッセージを送る | `SEND_MESSAGES` | `1 << 11` |
| ファイルを添付 | `ATTACH_FILES` | `1 << 15` |
| メッセージ履歴を読む | `READ_MESSAGE_HISTORY` | `1 << 16` |
| スレッドを管理 | `MANAGE_THREADS` | `1 << 34` |
| プライベートスレッドを作成 | `CREATE_PRIVATE_THREADS` | `1 << 36` |
| Threadsでメッセージを送る | `SEND_MESSAGES_IN_THREADS` | `1 << 38` |

- マイクの声の録音 (`voice.enabled`。[README の「マイクの声を録音する」](../README.md#マイクの声を録音する-ボイスチャンネル)) に要る「接続」(`CONNECT`、`1 << 20`) は、配信テストに使うボイスチャンネルに、チャンネルの権限の設定で付ける (下の「3. チャンネルの権限を確かめる」)。
- サーバで管理の操作に二要素認証を必須にしていると、「スレッドを管理」を使うには、bot を作ったアカウントに二要素認証が要る。
- Developer Portal の `Installation` のページ (`Install Link` を `Discord Provided Link` にし、`Default Install Settings` の `Guild Install` に上のスコープと権限を入れる) でも、同じ内容の招待のリンクを作れる。

### 3. チャンネルの権限を確かめる

招待で付いた権限は、bot のロールの権限としてサーバ全体に効く。配信テストのチャンネルや運営への通知のチャンネルを、ロールで見える人を絞っている (プライベートチャンネルにしている) ときは、そのチャンネルの権限の設定に bot のロールを足す。

| チャンネル | bot に要る権限 |
| --- | --- |
| 配信テストのチャンネル (`discord.techcheckChannelId`) | 上の 7 つ |
| 運営への通知のチャンネル (`discord.opsChannelId`) | チャンネルを表示、メッセージを送る |
| 配信テストに使うボイスチャンネル (マイクの声の録音を使うとき) | チャンネルを表示、接続 |

ボイスチャンネルは、bot に「チャンネルを表示」と「接続」の両方がある所が、配信者に案内する候補になる。

- 配信テストに使うボイスチャンネルの設定 →「権限」で、bot (または bot のロール) を足し、「チャンネルを表示」と「接続」を許可する。配信者もそのボイスチャンネルに入れるようにしておく。
- 同時にテストする人数だけ用意しておくと、待たせずに済む。
- 候補にしたくないボイスチャンネルで bot に「接続」が付いてしまうとき (bot のロールやほかのロールで付いている) は、そのチャンネルの権限の設定で bot の「接続」を拒否する。
- bot を起動すると、候補の一覧がコンソールに出る (`録音に使えるボイスチャンネル (bot が入れる所): …`)。

サーバの設定の画面では、権限の名前が Developer Portal と少し違う表示になっていることがある。

### 4. ID を控える

Discord のアプリの「ユーザー設定」→「詳細設定」で「開発者モード」を on にすると、右クリックのメニューから ID をコピーできる。

| 設定 | コピーするもの |
| --- | --- |
| `discord.guildId` | サーバの ID |
| `discord.techcheckChannelId` | 配信テストのチャンネルの ID |
| `discord.opsChannelId` | 運営への通知のチャンネルの ID (運営への通知を使わないなら要らない) |
| `discord.staffRoleId` | 運営のロールの ID (サーバの設定のロールの一覧から) |
### 5. 結果の通知の webhook を作る (使うときだけ)

1. 結果を流すチャンネルの設定を開き、「連携サービス」の「ウェブフック」で新しいウェブフックを作る。作る人には、そのチャンネルの「ウェブフックを管理」の権限が要る。
2. ウェブフックの URL をコピーする。これが `notify.webhookUrl` (`TECHCHECK_WEBHOOK_URL`)。

URL を知っていれば誰でも書き込めるので、トークンと同じように扱う。bot の権限は要らない。

## AWS (IAM ユーザーのアクセスキー)

bot は、bot 専用の IAM ユーザーのアクセスキーで動く。IAM ユーザーには、下のポリシーだけを付ける。

1〜3 は、フローのある AWS アカウントで IAM を操作できる人が行う。

### 1. ポリシーを作る

1. IAM のコンソールで、「ポリシー」→「ポリシーの作成」を開き、「JSON」を選ぶ。
2. 次の JSON を入れる。`Resource` の ARN は、`config.yaml` の `flows` に書くフローの ARN に置き換える (フローの数だけ並べる)。
3. 名前 (たとえば `TechcheckBot`) を付けて作る。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TechcheckFlows",
      "Effect": "Allow",
      "Action": [
        "mediaconnect:DescribeFlow",
        "mediaconnect:StartFlow",
        "mediaconnect:StopFlow",
        "mediaconnect:DescribeFlowSourceMetadata",
        "mediaconnect:DescribeFlowSourceThumbnail"
      ],
      "Resource": [
        "arn:aws:mediaconnect:ap-northeast-1:123456789012:flow:1-AAAA:runner-a★環境に合わせて修正",
        "arn:aws:mediaconnect:ap-northeast-1:123456789012:flow:1-BBBB:runner-b★環境に合わせて修正"
      ]
    },
    {
      "Sid": "TechcheckMetrics",
      "Effect": "Allow",
      "Action": "cloudwatch:GetMetricData",
      "Resource": "*"
    },
    {
      "Sid": "TechcheckSelfCheck",
      "Effect": "Allow",
      "Action": "iam:SimulatePrincipalPolicy",
      "Resource": "arn:aws:iam::123456789012:user/techcheck-bot★環境に合わせて修正"
    }
  ]
}
```

- MediaConnect の 5 つのアクションは、どれもフローの ARN で絞れる。フローを足したら、ここにも ARN を足す。
- `cloudwatch:GetMetricData` はリソースで絞れないアクションなので、`Resource` は `*` にする。
- `iam:SimulatePrincipalPolicy` は、bot が起動のときに、上の権限がそろっているかを確かめるのに使う (ポリシーのシミュレーション。何も実行せずに、フローの開始・停止の権限まで確かめられる)。`Resource` は、2 で作る IAM ユーザー自身の ARN にする (アカウント ID とユーザー名を置き換える)。

### 2. IAM ユーザーを作る

1. IAM のコンソールで、「ユーザー」→「ユーザーの作成」を開き、名前 (たとえば `techcheck-bot`) を付ける。
2. 「AWS マネジメントコンソールへのユーザーアクセスを提供する」には、チェックを入れない (bot はコンソールを使わない)。
3. 許可の設定で「ポリシーを直接アタッチする」を選び、1 で作ったポリシーだけを付けて、作る。

### 3. アクセスキーを作る

1. 作ったユーザーを開き、「セキュリティ認証情報」のタブの「アクセスキーを作成」を押す。
2. ユースケースは「AWS の外部で実行されるアプリケーション」を選ぶ。
3. 表示された「アクセスキー」と「シークレットアクセスキー」を控える。シークレットアクセスキーは、この画面でしか見られない。見失ったら、キーを作り直す。

### 4. bot に渡す

`config.yaml` の `aws` に、2 つとも書く。直接書くか、環境変数に入れて `${環境変数名}` で読ませる。

```yaml
aws:
  region: ap-northeast-1
  accessKeyId: ${AWS_ACCESS_KEY_ID}
  secretAccessKey: ${AWS_SECRET_ACCESS_KEY}
```

- bot は起動のとき、`flows` の各フローを 1 回読んで、結果をコンソールに出す (`AWS: フロー flow-a を読めました (STANDBY)`)。キーが違っていれば、配信者が来る前に、ここで分かる。
- 続けて、bot の使う操作 (フローの開始・停止を含む) がポリシーで許可されているかを確かめて、コンソールに出す。そろっていれば `AWS: 権限: bot の使う操作は、すべて許可されています`、足りなければ `AWS: 権限が足りません: フロー flow-b の StartFlow、StopFlow (許可が無い)` のように出る。
- フローのリージョンは `aws.region` で決まる。
- 片方だけ書くと、起動のときに断る。

### 5. キーの扱い

- キーは、リポジトリに入れない (`config.yaml` は `.gitignore` で外してある)。チャットや画面の共有にも出さない。
- 漏れたかもしれないときは、IAM のコンソールで、そのキーをすぐに「無効化」する。bot が止まってよいのを確かめてから、消す。
- 入れ替えるときは、新しいキーを作って bot の設定を切り替え、起動のときの `AWS: フロー … を読めました` を確かめてから、古いキーを消す (IAM ユーザーは、アクセスキーを 2 つまで持てる)。
- イベントが終わって bot を動かさない間は、キーを無効化しておく。
- フローを足したら、1 のポリシーの `Resource` にも ARN を足す。足りないと、起動のときに `AWS: フロー … を読めません` と出る。

## Google (スプレッドシート、ドライブ)

bot は、Google Cloud のサービスアカウントのキー (JSON ファイル) で Google Sheets API を呼び、結果のシートに書く。録画と録音を Google ドライブに上げるとき (5) も、同じキーを使う。シートに書けるかどうかは、Google Cloud の IAM ロールではなく、シートの共有で決まる。

### 1. Google Sheets API を有効にする

1. [Google Cloud のコンソール](https://console.cloud.google.com/)で、bot 用のプロジェクトを選ぶ (無ければ作る)。
2. `APIs & Services` → `Library` で `Google Sheets API` を探し、`Enable` を押す。

### 2. サービスアカウントを作る

1. `IAM & Admin` → `Service Accounts` を開き、サービスアカウントを作る (`Create service account`)。
2. 名前を入れて `Done` を押す。プロジェクトのロールを付ける手順は、飛ばしてよい (bot には要らない)。
3. 一覧に出たサービスアカウントのメールアドレス (`<名前>@<プロジェクト>.iam.gserviceaccount.com`) を控える。

作る人には、プロジェクトの `Create Service Accounts` (`roles/iam.serviceAccountCreator`) のロールが要る。

### 3. キーを作る

1. サービスアカウントのメールアドレスを押して開き、`Keys` のタブを開く。
2. `Add key` → `Create new key` を選び、`Key type` を `JSON` にして `Create` を押す。
3. JSON ファイルがダウンロードされる。これが `google.credentialsFile` に書くファイル。見本の設定では、`config.yaml` と同じフォルダの `google-service-account.json`。

- キーのファイルは、あとからダウンロードし直せない。無くしたら、新しいキーを作り、古いキーを消す。
- 作る人には、`Service Account Key Admin` (`roles/iam.serviceAccountKeyAdmin`) のロールが要る。
- 組織のポリシー `iam.disableServiceAccountKeyCreation` が有効だと、キーを作れない。2024 年 5 月 3 日以降に作った組織では、既定で有効になっている。作れないときは、組織の管理者に、このプロジェクトで外してもらう。
- `google-service-account*.json` という名前のファイルは、このリポジトリの `.gitignore` で git の管理から外してある。別の名前にするときは、リポジトリに入れないよう気を付ける。

### 4. シートを共有する

1. 結果を書くスプレッドシートを開き (無ければ作る)、共有 (`Share`) を開く。
2. 2 で控えたサービスアカウントのメールアドレスを、「編集者」(`Editor`) で足す。通知 (`Notify people`) のチェックは外す。
3. `google.sheet.tabName` (既定は `techcheck`) と同じ名前のシート (タブ) を作っておく。1 行目が空なら、bot が見出しを書く。

### 5. 録画と録音を上げる共有ドライブを用意する (使うときだけ)

録画と録音を Google ドライブに上げる (`google.drive.folderId`。[README の「録画と録音を Google ドライブに上げる」](../README.md#録画と録音を-google-ドライブに上げる)) ときだけ要る。キーは、上で作ったサービスアカウントのものをそのまま使う。

上げる先は、Google Workspace の**共有ドライブ**にする。

1. Google Cloud のコンソールの `APIs & Services` → `Library` で `Google Drive API` を探し、`Enable` を押す (1 と同じプロジェクト)。
2. Google ドライブで、共有ドライブを作る (すでにあるものを使ってもよい)。作れるのは、Google Workspace のアカウントで、管理者が共有ドライブの作成を許しているとき。
3. 共有ドライブの「メンバーを管理」で、サービスアカウントのメールアドレスを足す。役割は「投稿者」以上 (ファイルを足せればよい。「コンテンツ管理者」でもよい)。組織の外のアカウントを足せない設定になっていると足せないので、そのときは管理者に相談する。
4. 上げる先のフォルダを決める。共有ドライブの直下でも、その中に作ったフォルダでもよい。ブラウザで開いたときの URL の `folders/` のあとの部分が ID で、これが `google.drive.folderId`。

- 録画と録音を聞く人には、その共有ドライブ (または上げる先のフォルダ) を見られるようにしておく。
- bot は、このフォルダの中にテストごとのフォルダを作り、ファイルを足すだけで、消したり書き換えたりはしない。

スプレッドシートの ID は、URL の `https://docs.google.com/spreadsheets/d/<ここ>/edit` の部分。これが `google.sheet.spreadsheetId`。
