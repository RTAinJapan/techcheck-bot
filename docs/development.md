# 開発

bot を直す人に向けた文書。動かし方と、各サービスのトークンに要る権限は [README](../README.md)、設計は [design.md](design.md)。

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

## 試験

```sh
npm test          # 外 (Discord、AWS、denpachan、シート) を偽物にして、テストの流れを 1 秒ずつ進めて確かめる
npm run typecheck
```

CI (`.github/workflows/ci.yml`) でも、型の確認・試験・ビルドを回す。

## 実物で確かめていないこと

- CloudWatch のメトリクスのディメンション名 (`FlowARN`) と 1 秒の粒度で取れること。AWS のドキュメントの記述どおりにしてあるが、実際のアカウントで一度確かめる (`src/adapters/aws.ts`)。
- `DescribeFlowSourceMetadata` の `StreamType` と `FrameRate` の実際の値の形。
- README の「[トークンと権限](../README.md#トークンと権限)」の表のうち、次の 3 つ。
  - `applications.commands` スコープが要ること (招待の URL はコードに無いので、Discord の仕様から割り出した)。
  - `/techcheck shot` の返事 (実行した人だけに見える返事) にファイルを付けるのに、Attach Files が要るかどうか。
  - `mediaconnect:DescribeFlowSourceMetadata` と `mediaconnect:DescribeFlowSourceThumbnail` を、IAM ポリシーでフローの ARN に絞れるかどうか。
- denpachan のメトリクスの受信口と実際に繋いだ動作。`channels` メッセージの形は denpachan の `src/engine/metrics_view.cpp` に合わせて試験している。
