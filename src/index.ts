// 起動: node dist/src/index.js [config.yaml]  (または環境変数 TECHCHECK_CONFIG。どちらも無ければ、今いるフォルダの config.yaml)
// 設定の中の相対パス (i18n.dir、db.path、google.credentialsFile、mic.dir、vdoninja.dir) は、設定ファイルのあるフォルダから探す。
// ここを変えたら、README の「準備」「動かす」も直す。

import { Client, Events, GatewayIntentBits } from "discord.js";
import { resolve } from "node:path";
import { AwsFlowPort } from "./adapters/aws.js";
import { checkPermissions, permissionLines } from "./adapters/aws-permissions.js";
import { NodeDns } from "./adapters/dns.js";
import { GoogleDrive } from "./adapters/drive.js";
import { WsReceiver } from "./adapters/receiver.js";
import { GoogleSheet } from "./adapters/sheet.js";
import { FfmpegStill } from "./adapters/still.js";
import { BrowserWebcam } from "./adapters/webcam.js";
import { DiscordWebhook } from "./adapters/webhook.js";
import { loadConfig } from "./config.js";
import { buildCommand } from "./discord/commands.js";
import { DiscordChat, InteractionHandler } from "./discord/bot.js";
import { I18n } from "./i18n.js";
import { TechcheckService, errorText } from "./service.js";
import { SqliteStore } from "./store.js";

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

async function main(): Promise<void> {
    const configPath = resolve(process.argv[2] ?? process.env.TECHCHECK_CONFIG ?? "config.yaml");
    const config = loadConfig(configPath);
    const baseDir = resolve(configPath, "..");
    const i18n = I18n.load(resolve(baseDir, config.i18n.dir));
    const store = new SqliteStore(resolve(baseDir, config.db.path));

    // Gateway Intent は Guilds だけ (Privileged Intent は使わない)。運営のロールは interaction の member から見る。
    // Intent を足したら、README の「トークンと権限」も直す。
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    const micDir = resolve(baseDir, config.mic.dir);
    const google = config.google;
    const credentialsFile = resolve(baseDir, google.credentialsFile);
    // VDO.ninja の受信用のページを開くブラウザ。使うとき (vdoninja.links があるとき) だけ
    const webcam = config.vdoninja.links.length > 0 ? new BrowserWebcam(config.vdoninja.browser, log, config.ffmpeg.path) : undefined;
    const vdoninjaDir = resolve(baseDir, config.vdoninja.dir);
    const rx = new WsReceiver(WsReceiver.urlFor(config.denpachan.host, config.denpachan.port, config.denpachan.token), log);
    // AWS の認証: 設定にアクセスキーがあればそれ、無ければ AWS SDK の既定の探し方 (環境変数、AWS_PROFILE のプロファイルなど)
    const awsKey = config.aws.accessKeyId ? { accessKeyId: config.aws.accessKeyId, secretAccessKey: config.aws.secretAccessKey } : undefined;
    const flow = new AwsFlowPort(config.aws.region, awsKey);
    const service = new TechcheckService({
        config,
        i18n,
        store,
        flow,
        rx,
        still: new FfmpegStill(config.ffmpeg.path),
        micDir,
        webcam,
        vdoninjaDir,
        // サービスアカウントのキーは、シートと同じもの (google.credentialsFile)
        drive: google.drive.folderId ? new GoogleDrive(google.drive.folderId, credentialsFile) : undefined,
        dns: new NodeDns(),
        chat: new DiscordChat(client, config),
        sheet: new GoogleSheet(google.sheet.spreadsheetId, google.sheet.tabName, credentialsFile),
        webhook: new DiscordWebhook(config.notify.webhookUrl),
        clock: { now: () => Date.now() },
        log,
    });
    const handler = new InteractionHandler(service, config, i18n, log);

    // 起動したときの設定と状態。秘密 (トークン、キー、webhook の URL) は出さない
    log(`設定ファイル: ${configPath}`);
    log(`Discord: サーバ ${config.discord.guildId} / 配信テストのチャンネル ${config.discord.techcheckChannelId} / 運営のロール ${config.discord.staffRoleId}`);
    const awsAuth = awsKey
        ? "設定ファイルのアクセスキー"
        : `AWS SDK の既定の探し方 (${process.env.AWS_ACCESS_KEY_ID ? "環境変数のアクセスキー" : process.env.AWS_PROFILE ? `プロファイル ${process.env.AWS_PROFILE}` : "既定のプロファイル"})`;
    log(`AWS: リージョン ${config.aws.region} / 認証 ${awsAuth} / フロー ${config.flows.map((f) => f.name).join("、")}`);
    log(
        `denpachan: ${config.denpachan.host}:${config.denpachan.port} (トークン${config.denpachan.token ? "あり" : "なし"}) / 枠のチャンネルの受信の設定: ` +
            (config.denpachan.configure ? "bot が入れる (denpachan.configure)" : "denpachan の画面で合わせる"),
    );
    log(`シート: ${google.sheet.spreadsheetId} / ${google.sheet.tabName}`);
    log(
        `VDO.ninja (web カメラの映像とマイクの声): ${
            webcam
                ? `使う (URL の組 ${config.vdoninja.links.length} つ。ブラウザ: ${config.vdoninja.browser.path || `PC に入っている ${config.vdoninja.browser.channel}`}。` +
                  `録画: ${config.vdoninja.record ? `する (置き場所 ${vdoninjaDir})` : "しない (vdoninja.record)"})`
                : "使わない (vdoninja.links が未設定)"
        }`,
    );
    log(`マイクの声の録音: ${webcam ? `VDO.ninja で届く声を録る (マイクを使う、または未定の人だけ。置き場所 ${micDir})` : "しない (vdoninja.links が未設定)"}`);
    log(`録画と録音の Google ドライブへのアップロード: ${google.drive.folderId ? `する (フォルダ ${google.drive.folderId})` : "しない (google.drive.folderId が未設定)"}`);
    // 通知は 2 つあり、設定も別。どちらも、未設定なら送らない
    log(`運営への通知 (途中の経過と問題。bot がチャンネルに書く): ${config.discord.opsChannelId ? `チャンネル ${config.discord.opsChannelId} に送る` : "discord.opsChannelId が未設定なので送らない (コンソールにだけ出る)"}`);
    log(`結果の通知 (テストが終わったとき。webhook): ${config.notify.webhookUrl ? "送る" : "notify.webhookUrl が未設定なので送らない"}`);
    for (const line of service.startupSummary()) log(line);

    client.on(Events.Error, (e) => log(`Discord: エラー: ${errorText(e)}`));
    client.on(Events.Warn, (m) => log(`Discord: 警告: ${m}`));
    process.on("unhandledRejection", (e) => log(`処理されなかったエラー: ${e instanceof Error && e.stack ? e.stack : errorText(e)}`));

    client.once(Events.ClientReady, async (c) => {
        log(`Discord: ${c.user.tag} でログインしました`);
        // サーバのコマンドの登録。bot を招待するときの OAuth2 スコープ applications.commands で許される (bot スコープに含まれる。README の「トークンと権限」)
        const guild = await c.guilds.fetch(config.discord.guildId);
        await guild.commands.set([buildCommand(config.flows).toJSON()]);
        log("/techcheck を登録しました");
        // AWS の認証と権限を、配信者が来る前に確かめる (キーの間違い、期限切れ、ポリシーの不足は、テストを始めるまで分からない)。
        // 返事を待たずに先へ進む (AWS に届かないときに、起動を止めない)
        for (const f of config.flows) {
            void flow.describe(f.arn).then(
                (info) => log(`AWS: フロー ${f.name} を読めました (${info.status})`),
                (e) => log(`AWS: フロー ${f.name} を読めません。このままだと、このフローのテストは準備で失敗します: ${errorText(e)}`),
            );
        }
        // 開始・停止も含めて、要る権限がそろっているかを、何も実行せずに確かめる (IAM のポリシーのシミュレーション)
        void checkPermissions(config.aws.region, awsKey, config.flows.map((f) => f.arn)).then(
            (check) => {
                for (const line of permissionLines(check, config.flows)) log(line);
            },
            (e) => log(`AWS: 権限の確認に失敗しました: ${errorText(e)}`),
        );
        rx.start();
        // 準備の途中で止まったテストは、denpachan に繋がってから準備をやり直す
        const since = Date.now();
        const resume = setInterval(() => {
            if (!rx.connected() && Date.now() - since < 30_000) return;
            clearInterval(resume);
            void service.reportSlotMismatches().catch((e) => log(`枠の確認: ${errorText(e)}`));
            service.resumePreparing();
        }, 1_000);
        setInterval(() => {
            service.tick().catch((e) => log(`tick: ${errorText(e)}`));
        }, 1_000);
    });
    client.on(Events.InteractionCreate, (i) => {
        void handler.handle(i);
    });

    const stop = () => {
        log("止めます");
        rx.stop();
        void webcam?.stop();
        void client.destroy().finally(() => {
            store.close();
            process.exit(0);
        });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    await client.login(config.discord.token);
}

main().catch((e) => {
    console.error(errorText(e));
    process.exit(1);
});
