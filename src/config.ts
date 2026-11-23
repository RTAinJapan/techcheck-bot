// 設定ファイル (config.yaml) の読み込みと検証。項目は設計書 §4.1 の表のとおり。
// 秘密は `${環境変数名}` で環境変数から読める。

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { defaultChecks, micDiscordStep, micVdoninjaStep } from "./checks.js";

const nonEmpty = z.string().min(1);
/**
 * 省ける文字列。書いていないときも、値が空のときも "" にする。
 * `key: ${ENV}` で環境変数が無いと、置き換えたあとが `key:` (YAML では null) になるので、null も受ける。
 */
const optionalText = z
    .string()
    .nullish()
    .transform((v) => v ?? "");
const lang = z.enum(["ja", "en"]);
const localized = z.object({ ja: nonEmpty, en: nonEmpty });

export const checkStepSchema = z.object({
    id: nonEmpty,
    // 配信者に見せる結果のまとめでの、この手順の名前 (何を確かめた手順か)。省くと id をそのまま出す。
    // id はシートなど運営向けの記録に使う名前で、配信者には意味が分かりにくい
    label: localized.optional(),
    // sound: 音が載ることを期待 / silence: 静かにする (ノイズの大きさを測る) / quiet: 載らないことを期待 (基準は silence)
    // confirm: 静止画を見て はい / いいえ / reconnect: 配信を止めて始め直す
    // micRecord: マイクの声を録音する。録る経路は設定の mic.via (vdoninja か discord)
    kind: z.enum(["sound", "silence", "quiet", "confirm", "reconnect", "micRecord"]),
    seconds: z.number().int().min(0).max(600),
    text: localized,
    failHint: localized,
    thresholdDb: z.number().optional(), // sound: これ以上の秒を「音が載った」とみなす / silence: これ未満なら静か
    ratio: z.number().min(0).max(1).optional(), // sound: 音が載った秒の割合の下限
    marginDb: z.number().optional(), // quiet: silence で測ったノイズにこれを足した値を超えたら「載った」
});
export type CheckStep = z.infer<typeof checkStepSchema>;

const flowSchema = z.object({
    name: nonEmpty,
    arn: nonEmpty,
    domain: nonEmpty,
    // フローの source に SRT の暗号化を設定しているときだけ書く。空なら、案内する URL にパスフレーズを入れない
    // (暗号化していないフローにパスフレーズ付きで送ると、SRT は接続を断る)
    passphrase: optionalText,
    pbkeylen: z.number().int().prefault(16),
    // denpachan が受けるフローの出力の名前 (MediaConnect の出力の Name)。denpachan.configure が true のとき、
    // bot がこの出力の接続先を読んで、枠のチャンネルに受信の設定を入れる
    output: optionalText,
    // その出力に SRT の暗号化を設定しているときのパスワード (設定していなければ書かない)
    outputPassphrase: optionalText,
});
export type FlowConfig = z.infer<typeof flowSchema>;

/** SRT の枠 1 つ。enabled が false なら、設定はしておくが受け付けない (`/techcheck slot on` で使い始める) */
const srtSlotSchema = z.object({
    flow: z.string().optional(),
    channel: z.number().int().min(1).max(8).optional(),
    enabled: z.boolean().prefault(true),
});
export const kMaxSrtSlots = 8;

export const configSchema = z
    .object({
        discord: z.object({
            token: nonEmpty,
            guildId: nonEmpty,
            techcheckChannelId: nonEmpty,
            staffRoleId: nonEmpty,
            // 運営への通知のチャンネル。未設定なら、運営への通知を送らない (コンソールにだけ出る)
            opsChannelId: optionalText,
        }),
        // notify: の下が全部空 (null) でもよい
        notify: z
            .object({ webhookUrl: optionalText })
            .nullish()
            .transform((v) => v ?? { webhookUrl: "" }),
        aws: z.object({
            region: nonEmpty,
            // bot 用の IAM ユーザーのアクセスキー (秘密)。2 つとも書く。作り方は docs/createToken.md。
            // 2 つとも書かなければ、AWS SDK の既定の探し方 (環境変数 AWS_ACCESS_KEY_ID、AWS_PROFILE のプロファイルなど) で探す
            accessKeyId: optionalText,
            secretAccessKey: optionalText,
        }),
        flows: z.array(flowSchema).min(1),
        rtmp: z.object({
            domain: nonEmpty,
            app: nonEmpty,
            key: nonEmpty,
            statsUrl: optionalText,
        }),
        slots: z
            .object({
                // SRT の枠は、同時にテストできる人数だけ並べる。1 つなら並べずにそのまま書いてもよい
                srt: z
                    .union([srtSlotSchema, z.array(srtSlotSchema).min(1).max(kMaxSrtSlots)])
                    .transform((v) => (Array.isArray(v) ? v : [v]))
                    .prefault({}),
                rtmp: z.object({ channel: z.number().int().min(1).max(8).optional() }).prefault({}),
            })
            .prefault({}),
        denpachan: z
            .object({
                host: z.string().prefault("127.0.0.1"),
                port: z.number().int().prefault(9100),
                token: optionalText,
                // true なら、テストを始めるときに、bot が枠のチャンネルに受信の設定を入れる
                // (SRT の枠: フローの出力へ繋ぐ設定。RTMP の枠: RTMP サーバから pull する設定)。
                // denpachan の全体設定で「受信の設定の変更も許す」(allowConfigure) を on にしておく。
                // false なら、枠のチャンネルの受信の設定は、denpachan の画面で合わせておく
                configure: z.boolean().prefault(false),
            })
            .prefault({}),
        // Google のものは、ここにまとめる。サービスアカウントのキーは、シートとドライブで同じものを使う
        google: z.object({
            credentialsFile: nonEmpty, // サービスアカウントのキーのファイル (秘密)
            sheet: z.object({
                spreadsheetId: nonEmpty,
                tabName: z.string().prefault("techcheck"),
            }),
            // テストの録画と録音を Google ドライブに上げる。folderId が空なら上げない。
            // サービスアカウントには保存容量が無いので、共有ドライブ (またはその中のフォルダ) の ID を書く
            drive: z.object({ folderId: optionalText }).prefault({}),
        }),
        guide: z.object({
            obsProfile: nonEmpty,
            // 既定は、配布している走者配信用の OBS のプロファイルの値 (出力 1536x864 / 60 fps、x264 3000 kbps、キーフレーム 2 秒)
            expected: z
                .object({
                    width: z.number().int().prefault(1536),
                    height: z.number().int().prefault(864),
                    fps: z.number().prefault(60),
                    bitrateKbps: z.number().int().prefault(3000),
                    keyframeSec: z.number().prefault(2),
                })
                .prefault({}),
        }),
        // latency の設定は μs (OBS の URL の latency= に入れる値) で書く。人が見る latency は、どこでも μs にそろえる。
        // bot の中の計算は ms なので、読んだあとに ms の値 (initialMs、maxMs) も作っておく
        latency: z
            .object({
                // 既定は、走者に配布している OBS の設定の初期値 (100 ms 相当) と同じ
                initialUs: z.number().int().min(20_000).prefault(100_000),
                maxUs: z.number().int().prefault(2_000_000),
                maxRaises: z.number().int().min(0).prefault(4),
            })
            .prefault({})
            .transform((v) => ({ ...v, initialMs: v.initialUs / 1000, maxMs: v.maxUs / 1000 })),
        judge: z
            .object({
                windowSec: z.number().int().min(10).prefault(60),
                confirmSec: z.number().int().min(0).prefault(60),
                // [ロス率 (%) の上限, 倍率] を小さい順に。最後の行より大きいロス率も最後の倍率
                multipliers: z
                    .array(z.tuple([z.number(), z.number()]))
                    .min(1)
                    .prefault([
                        [1, 3],
                        [3, 4],
                        [7, 6],
                        [10, 8],
                        [100, 10],
                    ]),
                minFpsRatio: z.number().min(0).max(1).prefault(0.9),
                maxJitterMs: z.number().prefault(500),
                silentDb: z.number().prefault(-60),
                silentAlertSec: z.number().int().prefault(10),
            })
            .prefault({}),
        timeouts: z
            .object({
                claimMin: z.number().prefault(5),
                connectRemindMin: z.number().prefault(10),
                connectAbortMin: z.number().prefault(30),
                raiseRemindMin: z.number().prefault(10),
                stepAbortMin: z.number().prefault(20),
                halveWhenQueued: z.boolean().prefault(true),
            })
            .prefault({}),
        checks: z.array(checkStepSchema).min(1).optional(),
        // VDO.ninja の接続。配信者の web カメラの映像とマイクの声が、ここから届く。links が空なら使わない。
        // 配信が届いたあと、配信者に送信用の URL (push) を渡し、bot は受信用の URL (view) をブラウザで開いて、映っているかを見る。
        // そのまま (OBS の配信と WebRTC の両方を送っている状態で) 映像の判定と latency の調整をする
        vdoninja: z
            .object({
                // 送信用と受信用の URL の組。同時にテストする人数 (SRT の枠の数) だけ並べる (同じ組を 2 人に使わせない)
                links: z.array(z.object({ push: nonEmpty, view: nonEmpty })).prefault([]),
                browser: z
                    .object({
                        // 受信用のページを開くブラウザ (Chrome 系) の実行ファイル。空なら、channel のブラウザを探す
                        path: optionalText,
                        // インストールしてあるブラウザの種類 (chrome、msedge など。Playwright の channel)
                        channel: z.string().min(1).prefault("chrome"),
                    })
                    .prefault({}),
                // 映像が届かなくなってから、「途切れた」とみなすまで (秒)
                lostSec: z.number().int().min(1).prefault(10),
                // true なら、web カメラが届いてからテストが終わるまで、届いた映像と音声を録画する (Google ドライブにも上げる)
                record: z.boolean().prefault(true),
                // 録画 (.webm) の置き場所
                dir: z.string().min(1).prefault("./vdoninja"),
            })
            // vdoninja: の下が全部空 (null) でもよい
            .nullish()
            .transform((v) => v ?? { links: [], browser: { path: "", channel: "chrome" }, lostSec: 10, record: true, dir: "./vdoninja" }),
        // マイクの声の録音。via で、本番のマイクの声が届く経路を選ぶ。off 以外なら、チェックの最後に録音の手順を足す。
        // - vdoninja: VDO.ninja のページから届く声を、bot のブラウザで録る (vdoninja.links が要る)
        // - discord: Discord のボイスチャンネルで録る。入ってもらうボイスチャンネルは、bot に「チャンネルを表示」と「接続」の
        //   権限がある所のうち、空いている所を bot が選ぶ
        // - off: 録らない
        // 省くと、vdoninja.links があれば vdoninja、無ければ off
        mic: z
            .object({
                via: z.enum(["vdoninja", "discord", "off"]).optional(),
                dir: z.string().min(1).prefault("./mic"), // 録音の置き場所 (Discord は .ogg、VDO.ninja は .webm)
            })
            .nullish()
            .transform((v) => v ?? { via: undefined, dir: "./mic" }),
        // 配信の静止画を、denpachan の録画から取り出すのに使う ffmpeg。既定は PATH の ffmpeg
        ffmpeg: z.object({ path: z.string().min(1).prefault("ffmpeg") }).prefault({}),
        i18n: z.object({ dir: z.string().prefault("./messages"), fallback: lang.prefault("en") }).prefault({}),
        db: z.object({ path: z.string().prefault("./techcheck.db") }).prefault({}),
    })
    .superRefine((c, ctx) => {
        const names = new Set<string>();
        for (const f of c.flows) {
            if (names.has(f.name)) ctx.addIssue({ code: "custom", path: ["flows"], message: `flows: 名前 "${f.name}" が重複しています` });
            names.add(f.name);
        }
        // アクセスキーは、ID とシークレットの組。片方だけでは使えない (環境変数が片方だけ未設定、などに気づけるように)
        if (!c.aws.accessKeyId !== !c.aws.secretAccessKey) {
            const missing = c.aws.accessKeyId ? "secretAccessKey" : "accessKeyId";
            ctx.addIssue({ code: "custom", path: ["aws", missing], message: "aws.accessKeyId と aws.secretAccessKey は、2 つとも書くか、2 つとも書かないかにしてください" });
        }
        // bot が受信の設定を入れるなら、どの出力を denpachan が受けるかが要る
        if (c.denpachan.configure) {
            c.flows.forEach((f, i) => {
                if (!f.output) {
                    ctx.addIssue({ code: "custom", path: ["flows", i, "output"], message: `denpachan.configure が true のときは、フロー "${f.name}" に output (denpachan が受ける出力の名前) が要ります` });
                }
            });
        }
        // 枠どうしで、フローと denpachan のチャンネルが重ならないこと (同じものを 2 人に使わせない)
        const slotFlows = new Set<string>();
        const slotChannels = new Set<number>();
        if (c.slots.rtmp.channel !== undefined) slotChannels.add(c.slots.rtmp.channel);
        c.slots.srt.forEach((slot, i) => {
            if (slot.flow !== undefined) {
                if (!names.has(slot.flow)) {
                    ctx.addIssue({ code: "custom", path: ["slots", "srt", i, "flow"], message: `SRT の枠 ${i + 1} のフロー "${slot.flow}" は flows にありません` });
                }
                if (slotFlows.has(slot.flow)) {
                    ctx.addIssue({ code: "custom", path: ["slots", "srt", i, "flow"], message: `フロー "${slot.flow}" を 2 つの枠で使っています` });
                }
                slotFlows.add(slot.flow);
            }
            if (slot.channel !== undefined) {
                if (slotChannels.has(slot.channel)) {
                    ctx.addIssue({ code: "custom", path: ["slots", "srt", i, "channel"], message: `チャンネル ${slot.channel} を 2 つの枠で使っています` });
                }
                slotChannels.add(slot.channel);
            }
        });
        // VDO.ninja の URL の組は、同時にテストする人数だけ要る。同じ URL を 2 つの組に書かない
        if (c.vdoninja.links.length > 0) {
            if (c.vdoninja.links.length < c.slots.srt.length) {
                ctx.addIssue({ code: "custom", path: ["vdoninja", "links"], message: `vdoninja.links は、SRT の枠の数 (${c.slots.srt.length}) 以上の組を書いてください (同時にテストする人ごとに、別の URL を使います)` });
            }
            const urls = new Set<string>();
            c.vdoninja.links.forEach((l, i) => {
                for (const k of ["push", "view"] as const) {
                    if (!/^https:\/\//.test(l[k])) ctx.addIssue({ code: "custom", path: ["vdoninja", "links", i, k], message: `vdoninja.links の ${k} は https:// で始まる URL にしてください` });
                    if (urls.has(l[k])) ctx.addIssue({ code: "custom", path: ["vdoninja", "links", i, k], message: `vdoninja.links: 同じ URL を 2 回書いています (${k})` });
                    urls.add(l[k]);
                }
                // 組の取り違えに気づけるように: 受信用は、送信用と同じストリーム ID (と、部屋を使うなら同じ部屋) を見ること。
                // 合っていないと、配信者が送っても bot には届かず、「web カメラが届かない」まま時間切れになる
                const param = (url: string, name: string) => {
                    try {
                        return new URL(url).searchParams.get(name);
                    } catch {
                        return null;
                    }
                };
                const pushId = param(l.push, "push");
                const viewId = param(l.view, "view");
                if (pushId && viewId && pushId !== viewId) {
                    ctx.addIssue({ code: "custom", path: ["vdoninja", "links", i, "view"], message: `vdoninja.links: view のストリーム ID (${viewId}) が、push (${pushId}) と違います` });
                }
                const room = param(l.push, "room");
                if (room && param(l.view, "room") !== room) {
                    ctx.addIssue({ code: "custom", path: ["vdoninja", "links", i, "view"], message: `vdoninja.links: push が部屋 (room=${room}) を使っているので、view にも同じ &room=${room} が要ります (https://vdo.ninja/?view=<ID>&solo&room=<部屋> の形。部屋を付けないと届きません)` });
                }
            });
        }
        if (c.notify.webhookUrl && !/^https:\/\//.test(c.notify.webhookUrl)) {
            ctx.addIssue({ code: "custom", path: ["notify", "webhookUrl"], message: "notify.webhookUrl は https:// で始まる URL にしてください" });
        }
        if (c.latency.maxUs < c.latency.initialUs) {
            ctx.addIssue({ code: "custom", path: ["latency", "maxUs"], message: "latency.maxUs は latency.initialUs 以上にしてください" });
        }
        // bot は latency を ms の整数で扱う (MediaConnect の MinLatency も ms)
        for (const k of ["initialUs", "maxUs"] as const) {
            if (c.latency[k] % 1000 !== 0) ctx.addIssue({ code: "custom", path: ["latency", k], message: `latency.${k} は 1000 の倍数 (ms の整数にあたる μs) にしてください` });
        }
        const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(c.denpachan.host);
        if (!isLoopback && !c.denpachan.token) {
            ctx.addIssue({ code: "custom", path: ["denpachan", "token"], message: "denpachan.host が loopback でないときは denpachan.token が必要です" });
        }
        const checks = c.checks ?? defaultChecks;
        const via = micVia(c);
        if (c.mic.via === "vdoninja" && c.vdoninja.links.length === 0) {
            ctx.addIssue({ code: "custom", path: ["mic", "via"], message: "mic.via を vdoninja にするには、vdoninja.links を書いてください" });
        }
        if (via === "off" && checks.some((s) => s.kind === "micRecord")) {
            ctx.addIssue({ code: "custom", path: ["checks"], message: "checks: micRecord の手順を使うには、mic.via を vdoninja か discord にしてください" });
        }
        const ids = new Set<string>();
        for (const s of checks) {
            if (ids.has(s.id)) ctx.addIssue({ code: "custom", path: ["checks"], message: `checks: id "${s.id}" が重複しています` });
            ids.add(s.id);
        }
        const firstQuiet = checks.findIndex((s) => s.kind === "quiet");
        const firstSilence = checks.findIndex((s) => s.kind === "silence");
        if (firstQuiet >= 0 && (firstSilence < 0 || firstSilence > firstQuiet)) {
            ctx.addIssue({ code: "custom", path: ["checks"], message: "checks: quiet の手順の前に silence の手順が要ります (ノイズの基準を測るため)" });
        }
    });

/** マイクの声の録音の経路 (mic.via) */
export type MicVia = "vdoninja" | "discord" | "off";

/** mic.via。省いたら、VDO.ninja の URL があれば vdoninja (web カメラと同じページで声も届く)、無ければ off */
function micVia(c: { mic: { via?: MicVia }; vdoninja: { links: unknown[] } }): MicVia {
    return c.mic.via ?? (c.vdoninja.links.length > 0 ? "vdoninja" : "off");
}

export type Config = Omit<z.infer<typeof configSchema>, "checks" | "mic"> & { checks: CheckStep[]; mic: { via: MicVia; dir: string } };
export type Lang = z.infer<typeof lang>;

/** `${NAME}` を環境変数で置き換える。無い変数は空文字にし、名前を返す (必須の項目は検証で引っかかる) */
export function expandEnv(text: string, env: NodeJS.ProcessEnv): { text: string; missing: string[] } {
    const missing: string[] = [];
    const out = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
        const v = env[name];
        if (v === undefined) {
            missing.push(name);
            return "";
        }
        return v;
    });
    return { text: out, missing };
}

export class ConfigError extends Error {}

export function parseConfig(yamlText: string, env: NodeJS.ProcessEnv = process.env): Config {
    const { text, missing } = expandEnv(yamlText, env);
    const raw: unknown = parseYaml(text);
    const result = configSchema.safeParse(raw);
    // 前の書き方 (いちばん上の sheet / drive) は、google の下に移した。黙って無視せずに、移し方を伝える
    const moved = raw && typeof raw === "object" ? ["sheet", "drive"].filter((k) => k in raw) : [];
    // latency の設定は ms から μs に変えた。前の名前のままだと既定値で動いてしまうので、黙って無視せずに、直し方を伝える
    const rawLatency = raw && typeof raw === "object" ? (raw as { latency?: unknown }).latency : undefined;
    const oldLatency = rawLatency && typeof rawLatency === "object" ? (["initialMs", "maxMs"] as const).filter((k) => k in rawLatency) : [];
    // webcam と voice は、VDO.ninja の接続 (vdoninja) とマイクの声の録音 (mic) に分け直した。前の名前のままだと
    // VDO.ninja もマイクの録音も使わずに動いてしまうので、黙って無視せずに、移し方を伝える
    const oldMedia = raw && typeof raw === "object" ? ["webcam", "voice"].filter((k) => k in raw) : [];
    if (!result.success || moved.length > 0 || oldLatency.length > 0 || oldMedia.length > 0) {
        const lines = (result.error?.issues ?? []).map((i) => `- ${i.path.join(".") || "(全体)"}: ${i.message}`);
        for (const k of moved) {
            lines.push(
                k === "sheet"
                    ? "- sheet: Google の設定は google の下にまとめました。sheet.credentialsFile は google.credentialsFile へ、sheet.spreadsheetId と sheet.tabName は google.sheet の下へ移してください"
                    : "- drive: Google の設定は google の下にまとめました。drive.folderId は google.drive.folderId へ移してください",
            );
        }
        for (const k of oldLatency) {
            const value = (rawLatency as Record<string, unknown>)[k];
            const to = k === "initialMs" ? "initialUs" : "maxUs";
            const example = typeof value === "number" ? ` (${value} → ${value * 1000})` : "";
            lines.push(`- latency.${k}: μs (OBS の URL の latency= に入れる値) で書く latency.${to} に変えました。値を 1000 倍にして、名前を変えてください${example}`);
        }
        for (const k of oldMedia) {
            lines.push(
                k === "webcam"
                    ? "- webcam: VDO.ninja の接続は vdoninja に名前を変えました (links、browser、lostSec、record、dir はそのまま移す)。webcam.mic は mic.via に変えました (VDO.ninja で録るなら vdoninja、録らないなら off)"
                    : "- voice: マイクの声の録音は mic にまとめました。voice.enabled: true は mic.via: discord に、voice.dir は mic.dir に移してください",
            );
        }
        if (missing.length > 0) lines.push(`(設定されていない環境変数: ${[...new Set(missing)].join(", ")})`);
        throw new ConfigError(`設定ファイルが正しくありません:\n${lines.join("\n")}`);
    }
    // 既定の手順。マイクの声を録るなら、その経路の録音の手順を最後に足す
    const via = micVia(result.data);
    const defaults = via === "discord" ? [...defaultChecks, micDiscordStep] : via === "vdoninja" ? [...defaultChecks, micVdoninjaStep] : defaultChecks;
    return { ...result.data, mic: { via, dir: result.data.mic.dir }, checks: result.data.checks ?? defaults };
}

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Config {
    return parseConfig(readFileSync(path, "utf8"), env);
}
