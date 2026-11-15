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
| `src/adapters/` | MediaConnect / CloudWatch、denpachan の受信口、シート、webhook、DNS |
| `src/discord/` | `/techcheck` の定義と、コマンド・ボタン・モーダル・スレッド |

## 試験

```sh
npm test          # 外 (Discord、AWS、denpachan、シート) を偽物にして、テストの流れを 1 秒ずつ進めて確かめる
npm run typecheck
```

CI (`.github/workflows/ci.yml`) でも、型の確認・試験・ビルドを回す。CI が使うのは、自動で発行される `GITHUB_TOKEN` の `contents: read` だけで、リポジトリのシークレットは要らない。

## README とコードの対応

README の次の箇所は、コードが実際にしていることを写したもの。コードを変えたら README も直す。コードの側にも、同じことをコメントで書いてある。
Discord と AWS の権限を変えたら、[createToken.md](createToken.md) の招待の URL (権限の整数) と許可セットのポリシーも直す。

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
- denpachan のメトリクスの受信口と実際に繋いだ動作。`channels` メッセージの形は denpachan の `src/engine/metrics_view.cpp` に合わせて試験している。
