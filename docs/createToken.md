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

マイクの声の録音 (`voice.enabled`。[README の「マイクの声を録音する」](../README.md#マイクの声を録音する-ボイスチャンネル)) を使うなら、「接続」も足す。`permissions` は 360778402816 になる。あとから使い始めるときは、招待し直さなくても、サーバの設定で bot のロールに「接続」を足せばよい。

| 権限 (Developer Portal の日本語の表示) | API の名前 | 値 |
| --- | --- | --- |
| 接続 | `CONNECT` | `1 << 20` |

- サーバで管理の操作に二要素認証を必須にしていると、「スレッドを管理」を使うには、bot を作ったアカウントに二要素認証が要る。
- Developer Portal の `Installation` のページ (`Install Link` を `Discord Provided Link` にし、`Default Install Settings` の `Guild Install` に上のスコープと権限を入れる) でも、同じ内容の招待のリンクを作れる。

### 3. チャンネルの権限を確かめる

招待で付いた権限は、bot のロールの権限としてサーバ全体に効く。配信テストのチャンネルや運営への通知のチャンネルを、ロールで見える人を絞っている (プライベートチャンネルにしている) ときは、そのチャンネルの権限の設定に bot のロールを足す。

| チャンネル | bot に要る権限 |
| --- | --- |
| 配信テストのチャンネル (`discord.techcheckChannelId`) | 上の 7 つ |
| 運営への通知のチャンネル (`discord.opsChannelId`) | チャンネルを表示、メッセージを送る |
| 配信者が入るボイスチャンネル (マイクの声の録音を使うとき。`voice.channelId` で決めたもの、決めていなければ配信者が入りうるもの) | チャンネルを表示、接続 |

サーバの設定の画面では、権限の名前が Developer Portal と少し違う表示になっていることがある。

### 4. ID を控える

Discord のアプリの「ユーザー設定」→「詳細設定」で「開発者モード」を on にすると、右クリックのメニューから ID をコピーできる。

| 設定 | コピーするもの |
| --- | --- |
| `discord.guildId` | サーバの ID |
| `discord.techcheckChannelId` | 配信テストのチャンネルの ID |
| `discord.opsChannelId` | 運営への通知のチャンネルの ID (運営への通知を使わないなら要らない) |
| `discord.staffRoleId` | 運営のロールの ID (サーバの設定のロールの一覧から) |
| `voice.channelId` | 配信者に入ってもらうボイスチャンネルの ID (マイクの声の録音で、入る所を決めるときだけ) |

### 5. 結果の通知の webhook を作る (使うときだけ)

1. 結果を流すチャンネルの設定を開き、「連携サービス」の「ウェブフック」で新しいウェブフックを作る。作る人には、そのチャンネルの「ウェブフックを管理」の権限が要る。
2. ウェブフックの URL をコピーする。これが `notify.webhookUrl` (`TECHCHECK_WEBHOOK_URL`)。

URL を知っていれば誰でも書き込めるので、トークンと同じように扱う。bot の権限は要らない。

## AWS (IAM Identity Center)

AWS のアカウントは、IAM Identity Center で管理している前提。IAM ユーザーの長期のアクセスキーは作らず、bot は、Identity Center のユーザーに割り当てた許可セットの、一時的な認証情報で動く。

1〜2 は Identity Center の管理者が、3〜4 は bot を動かす人が行う。

### 1. 許可セットを作る

1. IAM Identity Center のコンソールで、「許可セット」→「許可セットを作成」→「カスタム許可セット」を選ぶ。
2. 「インラインポリシー」に、次の JSON を入れる。`Resource` の ARN は、`config.yaml` の `flows` に書くフローの ARN に置き換える (フローの数だけ並べる)。
3. 名前 (たとえば `TechcheckBot`) と「セッション期間」を決めて作る。セッション期間は既定で 1 時間、最大 12 時間。

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
        "arn:aws:mediaconnect:ap-northeast-1:123456789012:flow:1-AAAA:runner-a",
        "arn:aws:mediaconnect:ap-northeast-1:123456789012:flow:1-BBBB:runner-b"
      ]
    },
    {
      "Sid": "TechcheckMetrics",
      "Effect": "Allow",
      "Action": "cloudwatch:GetMetricData",
      "Resource": "*"
    }
  ]
}
```

- MediaConnect の 5 つのアクションは、どれもフローの ARN で絞れる。フローを足したら、ここにも ARN を足す。
- `cloudwatch:GetMetricData` はリソースで絞れないアクションなので、`Resource` は `*` にする。

### 2. 許可セットを割り当てる

IAM Identity Center のコンソールの「AWS アカウント」で、フローのあるアカウントを選び、「ユーザーまたはグループを割り当て」で、bot を動かす人 (またはそのグループ) に、1 で作った許可セットを割り当てる。

### 3. bot を動かす PC にプロファイルを作る

AWS CLI v2 を入れて、次を実行する。

```sh
aws configure sso
```

聞かれることと、答え:

| 聞かれること | 答え |
| --- | --- |
| `SSO session name` | 好きな名前 (たとえば `rtainjapan`) |
| `SSO start URL` | AWS アクセスポータルの URL (管理者に聞く) |
| `SSO region` | Identity Center を置いているリージョン (管理者に聞く) |
| `SSO registration scopes` | そのまま Enter (`sso:account:access`) |
| (ブラウザが開く) | Identity Center のユーザーでサインインして、許可する |
| アカウントとロール | フローのあるアカウントと、1 で作った許可セット |
| `Default client Region` | フローのあるリージョン (たとえば `ap-northeast-1`) |
| `Profile name` | `techcheck` |

`~/.aws/config` (Windows では `%USERPROFILE%\.aws\config`) に、次の形の設定ができる。

```ini
[profile techcheck]
sso_session = rtainjapan
sso_account_id = 123456789012
sso_role_name = TechcheckBot
region = ap-northeast-1

[sso-session rtainjapan]
sso_start_url = https://example.awsapps.com/start
sso_region = ap-northeast-1
sso_registration_scopes = sso:account:access
```

### 4. サインインして bot を起動する

```sh
aws sso login --profile techcheck
```

サインインしたら、環境変数 `AWS_PROFILE` に `techcheck` を入れてから bot を起動する。

```powershell
$env:AWS_PROFILE = "techcheck"
npm start
```

- フローのリージョンは `config.yaml` の `aws.region` で決まる (プロファイルの `region` は使わない)。
- 環境変数 `AWS_ACCESS_KEY_ID` が入っていると、プロファイルよりそちらが使われる。プロファイルで動かすときは、入れない。

### 5. サインインの期限が切れたら

- bot (AWS SDK) は、サインインのセッションが続いている間、認証情報を自動で取り直す。許可セットのセッション期間 (最大 12 時間) が来ても、止まらない。
- サインインのセッション (AWS アクセスポータルのセッション) には期限がある。既定は 8 時間で、管理者が 15 分から 90 日の間で変えられる。期限が切れると、bot の AWS の呼び出し (フローの開始・停止、メトリクス、静止画) が失敗するようになる。`aws sso login --profile techcheck` でサインインし直す。
- イベントの期間中ずっと動かすなら、期間より長いセッションにしてもらうよう、管理者に頼んでおく。

### プロファイルを作らずに試す

AWS CLI を入れられないときや、短い時間だけ試すときは、AWS アクセスポータルで、アカウントの許可セットの横の「アクセスキー」を開き、表示された環境変数 (`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、`AWS_SESSION_TOKEN`) を入れてから bot を起動する。

この認証情報は、許可セットのセッション期間 (最大 12 時間) で切れ、自動では更新されない。長く動かすときは、上のプロファイルを使う。

## Google (スプレッドシート)

bot は、Google Cloud のサービスアカウントのキー (JSON ファイル) で Google Sheets API を呼び、結果のシートに書く。シートに書けるかどうかは、Google Cloud の IAM ロールではなく、シートの共有で決まる。

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
3. JSON ファイルがダウンロードされる。これが `sheet.credentialsFile` に書くファイル。見本の設定では、`config.yaml` と同じフォルダの `google-service-account.json`。

- キーのファイルは、あとからダウンロードし直せない。無くしたら、新しいキーを作り、古いキーを消す。
- 作る人には、`Service Account Key Admin` (`roles/iam.serviceAccountKeyAdmin`) のロールが要る。
- 組織のポリシー `iam.disableServiceAccountKeyCreation` が有効だと、キーを作れない。2024 年 5 月 3 日以降に作った組織では、既定で有効になっている。作れないときは、組織の管理者に、このプロジェクトで外してもらう。
- `google-service-account*.json` という名前のファイルは、このリポジトリの `.gitignore` で git の管理から外してある。別の名前にするときは、リポジトリに入れないよう気を付ける。

### 4. シートを共有する

1. 結果を書くスプレッドシートを開き (無ければ作る)、共有 (`Share`) を開く。
2. 2 で控えたサービスアカウントのメールアドレスを、「編集者」(`Editor`) で足す。通知 (`Notify people`) のチェックは外す。
3. `sheet.tabName` (既定は `techcheck`) と同じ名前のシート (タブ) を作っておく。1 行目が空なら、bot が見出しを書く。

スプレッドシートの ID は、URL の `https://docs.google.com/spreadsheets/d/<ここ>/edit` の部分。これが `sheet.spreadsheetId`。
