// 起動: node dist/src/index.js [config.yaml]  (または環境変数 TECHCHECK_CONFIG。どちらも無ければ、今いるフォルダの config.yaml)
// 設定の中の相対パス (i18n.dir、db.path、sheet.credentialsFile) は、設定ファイルのあるフォルダから探す。
// ここを変えたら、README の「準備」「動かす」も直す。

import { Client, Events, GatewayIntentBits } from "discord.js";
import { resolve } from "node:path";
import { AwsFlowPort } from "./adapters/aws.js";
import { NodeDns } from "./adapters/dns.js";
import { WsReceiver } from "./adapters/receiver.js";
import { GoogleSheet } from "./adapters/sheet.js";
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
    const rx = new WsReceiver(WsReceiver.urlFor(config.denpachan.host, config.denpachan.port, config.denpachan.token), log);
    const service = new TechcheckService({
        config,
        i18n,
        store,
        flow: new AwsFlowPort(config.aws.region),
        rx,
        dns: new NodeDns(),
        chat: new DiscordChat(client, config),
        sheet: new GoogleSheet(config.sheet.spreadsheetId, config.sheet.tabName, resolve(baseDir, config.sheet.credentialsFile)),
        webhook: new DiscordWebhook(config.notify.webhookUrl),
        clock: { now: () => Date.now() },
        log,
    });
    const handler = new InteractionHandler(service, config, i18n, log);

    client.once(Events.ClientReady, async (c) => {
        log(`Discord: ${c.user.tag} でログインしました`);
        // サーバのコマンドの登録。bot を招待するときの OAuth2 スコープに applications.commands が要る (README の「トークンと権限」)
        const guild = await c.guilds.fetch(config.discord.guildId);
        await guild.commands.set([buildCommand(config.flows).toJSON()]);
        log("/techcheck を登録しました");
        rx.start();
        // 準備の途中で止まったテストは、denpachan に繋がってから準備をやり直す
        const since = Date.now();
        const resume = setInterval(() => {
            if (!rx.connected() && Date.now() - since < 30_000) return;
            clearInterval(resume);
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
