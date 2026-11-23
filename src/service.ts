// 配信テストの進行 (設計書 §5〜§7)。
// 1 秒ごとの tick() で各テストを進め、Discord の操作 (コマンド、ボタン、モーダル) を受ける。
// 外とのやりとりは ports.ts の口を通すので、試験では偽物に差し替えられる。

import { randomUUID } from "node:crypto";
import { type Advice, type SrtSample, advise, atLeastAfterDrops, kMinLatencyMs, nextLatency, obsLatency } from "./advisor.js";
import { evaluateAudioStep, missingStepTexts, stepTextKeys } from "./checks.js";
import type { CheckStep, Config, FlowConfig, Lang } from "./config.js";
import type { I18n } from "./i18n.js";
import { langFromLocale } from "./i18n.js";
import type {
    Button,
    ChatPort,
    Clock,
    DnsPort,
    DrivePort,
    FlowInfo,
    FlowPort,
    OutMessage,
    ReceiverChannel,
    ReceiverPort,
    SheetPort,
    StillPort,
    VoiceRecording,
    WebcamPort,
    WebhookPort,
} from "./ports.js";
import { audioVerdictColumn, buildRow, buildWebhookPayload, cellInRow, columnLetter, describeUsage, describeWebcam, driveColumn, formatRecPos, formatTime } from "./record.js";
import type { FinishedRecord, Phase, QueueOffer, QueueState, Session, SlotState, SrtSlotState, StepRecord, UploadJob, UsageAnswer } from "./session.js";
import type { KeyValueStore } from "./store.js";

export interface Deps {
    config: Config;
    i18n: I18n;
    store: KeyValueStore;
    flow: FlowPort;
    rx: ReceiverPort;
    still: StillPort;
    /** マイクの声の録音の置き場所 (mic.dir を、設定ファイルのフォルダから見た場所にしたもの) */
    micDir?: string;
    /** VDO.ninja の受信用のページを開くブラウザ (設定の vdoninja.links があるときだけ渡す) */
    webcam?: WebcamPort;
    /** VDO.ninja で届いた映像と音声の録画の置き場所 (vdoninja.dir を、設定ファイルのフォルダから見た場所にしたもの) */
    vdoninjaDir?: string;
    /** 録画と録音を上げる Google ドライブ (設定の google.drive.folderId があるときだけ渡す) */
    drive?: DrivePort;
    dns: DnsPort;
    chat: ChatPort;
    sheet: SheetPort;
    webhook: WebhookPort;
    clock: Clock;
    log?: (msg: string) => void;
    /** フローが ACTIVE になるのを待つ間の待ち (試験では差し替える) */
    sleep?: (ms: number) => Promise<void>;
}

export interface UserRef {
    id: string;
    displayName: string;
}

/** ボタンを押したときの返事。modal があれば Discord の側でモーダルを出す */
export interface ButtonReply {
    ephemeral?: string;
    modal?: { kind: "done" | "abort"; sessionId: string; lang: Lang };
}

const kFlowStartWaitMs = 4 * 60_000;
const kCwPollMs = 10_000;
const kCwLookbackSec = 240;
const kCwMissingGraceSec = 120;
const kWarmupSec = 5;
const kOpsWarnAfterSec = 60;
const kAssumePressedMs = 30_000;
const kReconnectLiveMs = 30_000;
const kSenderDecodeErrors = 5;
/** 録画から静止画を取るのに要る、録画の長さ (秒)。これより短いと、まだ絵が書かれていないことがある */
const kStillMinRecordSec = 3;
/** 録画の「今」から、どれだけ手前の絵を取るか (秒)。書き込みが追いついている所を読む */
const kStillBackSec = 2;
/** テストが終わってから Google ドライブに上げ始めるまで (denpachan が録画ファイルを閉じるのを待つ) */
const kUploadSettleMs = 10_000;
/** 上げるのに失敗したとき、やり直す回数と、やり直しまでの間隔 (回数を掛ける) */
const kUploadAttempts = 3;
const kUploadRetryMs = 60_000;
/** マイクの録音: 振り切れたサンプルがこの割合 (%) 以上なら、音が割れていると伝える */
const kVoiceClippedPct = 0.1;
/** マイクの録音: 平均の音量がこれより小さければ、声が小さいと伝える (dBFS) */
const kVoiceQuietDb = -40;
/** マイクの録音: 録音が終わるはずの時刻から、これだけ過ぎても終わらなければ手順を出し直す (秒) */
const kVoiceGraceSec = 45;

/** web カメラ: 映像がこれだけ続けて届いたら、届いたとみなす (ミリ秒) */
const kWebcamStableMs = 3_000;
/** マイクの録音 (VDO.ninja): 最大の音量がこれより小さければ「届いていない」とみなす (dBFS) */
const kWebcamVoiceSilentDb = -50;
/** web カメラ: 映像の判定の間のロス率がこれ以上なら、運営に知らせる (%) */
const kWebcamLossPct = 2;

/** 設定ファイルに書いてある枠の値。保存した枠が、どの設定のときのものかを覚えておくために、枠と一緒に保存する */
export interface SlotConfigSnapshot {
    srt: { flow: string | null; channel: number | null; enabled: boolean }[];
    rtmp: { channel: number | null };
}

export function slotConfigSnapshot(cfg: Config): SlotConfigSnapshot {
    return {
        srt: cfg.slots.srt.map((c) => ({ flow: c.flow ?? null, channel: c.channel ?? null, enabled: c.enabled })),
        rtmp: { channel: cfg.slots.rtmp.channel ?? null },
    };
}

/**
 * 保存してある枠を読む。SRT の枠の数は設定 (slots.srt) で決まる。それぞれの中身は:
 * - 設定ファイルのその枠が、保存したときから変わっていなければ、保存してある値 (`/techcheck slot` で設定し直した値が、起動し直しても残る)。
 * - 変わっていれば、設定ファイルの値 (設定ファイルを書き換えて起動し直したら、それが効く)。
 * storedBase は、保存したときの設定ファイルの値 (slotConfigSnapshot)。無ければ (これを保存していなかった版の保存) 設定ファイルの値を使う。
 * 枠が 1 つだったときの保存の形 (srt が配列でない) も読む。
 *
 * bot が問題を見つけて止めた枠 (stoppedByProblem) は、受付を再開する。設定や環境を直して起動し直したのに、
 * 止まったままでは「直しても効かない」ことになるため (運営が `/techcheck slot off` で止めた枠は止めたまま)。
 *
 * note には、保存してあった値と違う結果になったことを 1 行ずつ渡す (起動時のログ用)。
 */
export function loadSlots(stored: unknown, storedBase: unknown, cfg: Config, note: (msg: string) => void = () => undefined): SlotState {
    const old = stored as { srt?: SrtSlotState | SrtSlotState[]; rtmp?: SlotState["rtmp"] } | undefined;
    const storedSrt = old?.srt === undefined ? [] : Array.isArray(old.srt) ? old.srt : [old.srt];
    const base = storedBase as Partial<SlotConfigSnapshot> | undefined;
    const now = slotConfigSnapshot(cfg);
    const unchanged = (a: unknown, b: unknown) => a !== undefined && JSON.stringify(a) === JSON.stringify(b);
    const label = (i: number) => (cfg.slots.srt.length > 1 ? `SRT の ${i + 1} 番の枠` : "SRT の枠");
    const text = (s: { flow?: string; channel?: number; enabled: boolean }) => `フロー ${s.flow ?? "未設定"} / ch${s.channel ?? "?"} / ${s.enabled ? "受付中" : "止めている"}`;
    return {
        srt: cfg.slots.srt.map((c, i): SrtSlotState => {
            const kept = storedSrt[i];
            const fromConfig = { flow: c.flow, channel: c.channel, enabled: c.enabled };
            if (!kept) return fromConfig;
            if (!unchanged(base?.srt?.[i], now.srt[i])) {
                if (text(kept) !== text(fromConfig)) note(`${label(i)}: 設定ファイルが変わったので、設定ファイルの値にしました (保存してあった値: ${text(kept)})`);
                return fromConfig;
            }
            // 運営が止めた枠は stoppedByProblem が false。印が無いのは、印を付けていなかった版の保存で、
            // どちらが止めたか分からないので、問題で止めたものとして再開する
            if (!kept.enabled && kept.stoppedByProblem !== false) {
                note(`${label(i)}: 前回は問題があって止めていました。起動し直したので、受付を再開します`);
                return { flow: kept.flow, channel: kept.channel, enabled: true };
            }
            return kept;
        }),
        rtmp: (() => {
            const fromConfig = { channel: cfg.slots.rtmp.channel, enabled: true };
            if (!old?.rtmp) return fromConfig;
            if (unchanged(base?.rtmp, now.rtmp)) return old.rtmp;
            if (old.rtmp.channel !== fromConfig.channel || !old.rtmp.enabled) {
                note(`RTMP の枠: 設定ファイルが変わったので、設定ファイルの値にしました (保存してあった値: ch${old.rtmp.channel ?? "?"} / ${old.rtmp.enabled ? "受付中" : "止めている"})`);
            }
            return fromConfig;
        })(),
    };
}

/** 保存してある待ちの列を読む。知らせが 1 人だけだったときの保存の形 (offer) も読む */
export function loadQueue(stored: unknown): QueueState {
    const old = stored as { entries?: QueueState["entries"]; offers?: QueueOffer[]; offer?: QueueOffer } | undefined;
    return { entries: old?.entries ?? [], offers: old?.offers ?? (old?.offer ? [old.offer] : []) };
}

export class TechcheckService {
    private readonly cfg: Config;
    private readonly checks: CheckStep[];
    private sessions: Session[];
    private queue: QueueState;
    private slots: SlotState;
    private readonly slotsConfig: SlotConfigSnapshot;
    private langPrefs: Record<string, Lang>;
    private finished: Record<string, FinishedRecord>;
    private readonly samples = new Map<string, Map<number, SrtSample>>();
    private readonly lastCwFetch = new Map<string, number>();
    private chain: Promise<unknown> = Promise.resolve();
    private ticking = false;
    /** 起動したとき、保存してあった状態を今の設定ファイルに合わせて変えたこと (startupSummary で出す) */
    private readonly startupNotes: string[] = [];
    private orphansChecked = false;
    /** いま VDO.ninja のマイクの声を録音しているテスト */
    private readonly webcamRecording = new Set<string>();
    /** Google ドライブに上げるのを待っている、終わったテスト (設計書 §8.1)。1 つずつ上げる */
    private uploads: UploadJob[];
    private uploading = false;

    constructor(private readonly d: Deps) {
        this.cfg = d.config;
        this.checks = d.config.checks;
        // 手順の文言は messages の steps.<id> にある。足りなければ、手順の途中で止まらないように、起動しない
        const missing = missingStepTexts(this.checks, (k) => d.i18n.has(k));
        if (missing.length > 0) {
            throw new Error(`手順の文言が、文言のファイル (ja.yaml と en.yaml) にありません。steps の下に書いてください:\n${missing.map((k) => `- ${k}`).join("\n")}`);
        }
        this.sessions = d.store.get<Session[]>("sessions") ?? [];
        for (const s of this.sessions) {
            // 枠が 1 つだったときに保存したセッションには、枠の番号が無い
            s.srt.slot ??= 0;
            // 進行中のテストも、フローの ARN とドメインは今の設定ファイルの値にする (フローは名前で対応させる)。
            // 設定ファイルから無くなったフローのテストは、最初の tick で中断する (abortOrphans)
            const flow = d.config.flows.find((f) => f.name === s.srt.flowName);
            if (flow && !s.srt.released && (s.srt.flowArn !== flow.arn || s.srt.domain !== flow.domain)) {
                this.startupNotes.push(`${s.displayName} のテスト: フロー ${flow.name} の設定が変わったので、今の設定ファイルの ARN とドメインを使います`);
                s.srt.flowArn = flow.arn;
                s.srt.domain = flow.domain;
            }
        }
        this.queue = loadQueue(d.store.get<unknown>("queue"));
        this.slots = loadSlots(d.store.get<unknown>("slots"), d.store.get<unknown>("slotsConfig"), d.config, (m) => this.startupNotes.push(m));
        // 読んだ枠と、そのもとにした設定ファイルの値を、組で保存し直す (次に起動したとき、設定ファイルが変わったかを見分ける)
        this.slotsConfig = slotConfigSnapshot(d.config);
        d.store.set("slots", this.slots);
        d.store.set("slotsConfig", this.slotsConfig);
        this.langPrefs = d.store.get<Record<string, Lang>>("langPrefs") ?? {};
        this.finished = d.store.get<Record<string, FinishedRecord>>("finished") ?? {};
        this.uploads = d.store.get<UploadJob[]>("uploads") ?? [];
    }

    // ================= 外から呼ぶもの =================

    /** 1 秒ごとに呼ぶ。前の tick が終わっていなければ飛ばす */
    async tick(): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;
        try {
            await this.locked(async () => {
                await this.abortOrphans();
                await this.tickQueue();
                for (const s of [...this.sessions]) {
                    try {
                        await this.tickSession(s);
                    } catch (e) {
                        this.log(`tick ${s.displayName}: ${errorText(e)}`);
                    }
                }
                this.save();
            });
            this.pumpUploads();
        } finally {
            this.ticking = false;
        }
    }

    // ================= Google ドライブへのアップロード (設計書 §8.1) =================

    /** 上げる仕事があれば、裏で 1 つ進める。録画は大きく、数分かかるので、ロックの外で、テストの進行を止めずに上げる */
    private pumpUploads(): void {
        if (this.uploading || !this.d.drive) return;
        const job = this.uploads.find((j) => j.readyAt <= this.now());
        if (!job) return;
        this.uploading = true;
        void this.runUpload(job, this.d.drive)
            .catch((e) => this.log(`Google ドライブ: ${errorText(e)}`))
            .finally(() => {
                this.uploading = false;
            });
    }

    private async runUpload(job: UploadJob, drive: DrivePort): Promise<void> {
        try {
            if (!job.folderId) {
                job.folderId = await drive.createFolder(job.folderName);
                this.saveUploads();
            }
            for (const file of job.files) {
                if (job.done.includes(file) || job.skipped.some((x) => x.startsWith(file))) continue;
                this.log(`Google ドライブ (${job.displayName}): ${file} を上げます`);
                try {
                    await drive.upload(file, job.folderId);
                    job.done.push(file);
                } catch (e) {
                    // ファイルが無い (録画先を消した、別の PC の録画) のは、やり直しても直らない。ほかのファイルは上げる
                    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
                    job.skipped.push(`${file} (ファイルがありません)`);
                }
                this.saveUploads();
            }
        } catch (e) {
            job.attempts++;
            if (job.attempts < kUploadAttempts) {
                job.readyAt = this.now() + kUploadRetryMs * job.attempts;
                this.saveUploads();
                this.log(`Google ドライブ (${job.displayName}): 上げられませんでした。あとでやり直します (${job.attempts}/${kUploadAttempts}): ${errorText(e)}`);
                return;
            }
            const reason = errorText(e);
            return this.closeUpload(job, `アップロード失敗: ${reason}`, `録画と録音を Google ドライブに上げられませんでした: ${job.displayName} (${reason})。ファイルは PC に残っています`);
        }
        const url = drive.folderUrl(job.folderId);
        const skipped = job.skipped.length > 0 ? ` (上げられなかったもの: ${job.skipped.join("、")})` : "";
        await this.closeUpload(job, `${url}${skipped}`, `録画と録音を Google ドライブに上げました: ${job.displayName} ${url}${skipped}`);
    }

    /** 上げる仕事を終える: シートの「Google ドライブ」の列に結果を書き、運営に知らせる */
    private async closeUpload(job: UploadJob, cell: string, notice: string): Promise<void> {
        this.uploads = this.uploads.filter((j) => j !== job);
        this.saveUploads();
        if (job.sheetCell) await this.d.sheet.update(job.sheetCell, [cell]).catch((e) => this.log(`シート: ${errorText(e)}`));
        await this.ops(notice);
    }

    private saveUploads(): void {
        this.d.store.set("uploads", this.uploads);
    }

    /** /techcheck start */
    async start(user: UserRef, channelId: string, langOption: Lang | undefined, locale: string | undefined): Promise<string> {
        return this.locked(async () => {
            const lang = langOption ?? this.langPrefs[user.id] ?? langFromLocale(locale, this.cfg.i18n.fallback);
            if (langOption) this.langPrefs[user.id] = langOption;
            if (channelId !== this.cfg.discord.techcheckChannelId) return this.t(lang, "start.wrongChannel", { channel: `<#${this.cfg.discord.techcheckChannelId}>` });
            const running = this.sessions.find((s) => s.userId === user.id);
            if (running) return this.t(running.lang, "start.alreadyRunning", { url: this.d.chat.threadUrl(running.threadId) });
            const pos = this.queue.entries.findIndex((e) => e.userId === user.id);
            if (pos >= 0) return this.t(lang, "start.alreadyQueued", { position: pos + 1 });

            const slot = this.freeSrtSlot();
            if (this.queue.entries.length === 0 && slot !== undefined) {
                const r = await this.begin(user, lang, slot);
                this.save();
                return r;
            }
            this.queue.entries.push({ userId: user.id, displayName: user.displayName, lang, joinedAt: this.now(), skips: 0 });
            this.save();
            const position = this.queue.entries.length;
            return this.slots.srt.some((x) => x.enabled) ? this.t(lang, "queue.joined", { position }) : this.t(lang, "queue.paused", { position });
        });
    }

    /** /techcheck leave */
    async leave(userId: string): Promise<string> {
        return this.locked(async () => {
            const i = this.queue.entries.findIndex((e) => e.userId === userId);
            const lang = this.langPrefs[userId] ?? this.cfg.i18n.fallback;
            if (i < 0) return this.t(lang, "queue.notQueued");
            this.queue.entries.splice(i, 1);
            this.queue.offers = this.queue.offers.filter((o) => o.userId !== userId);
            this.save();
            return this.t(lang, "queue.left");
        });
    }

    /** 待ちの列の知らせの「始める」 */
    async claim(user: UserRef): Promise<string> {
        return this.locked(async () => {
            const entry = this.queue.entries.find((e) => e.userId === user.id);
            const lang = entry?.lang ?? this.langPrefs[user.id] ?? this.cfg.i18n.fallback;
            if (!entry || !this.queue.offers.some((o) => o.userId === user.id)) return this.t(lang, "queue.notYourTurn");
            const slot = this.freeSrtSlot();
            if (slot === undefined) return this.t(lang, "queue.notYourTurn");
            this.queue.entries = this.queue.entries.filter((e) => e.userId !== user.id);
            this.queue.offers = this.queue.offers.filter((o) => o.userId !== user.id);
            const r = await this.begin({ id: user.id, displayName: user.displayName || entry.displayName }, entry.lang, slot);
            this.save();
            return r;
        });
    }

    /** スレッドの中のボタン。id は `tc:<sessionId>:<action>` */
    async button(actorId: string, isStaff: boolean, customId: string): Promise<ButtonReply> {
        return this.locked(async () => {
            const [, sessionId, action] = customId.split(":");
            const s = this.sessions.find((x) => x.id === sessionId);
            if (!s) return { ephemeral: this.t(this.langPrefs[actorId] ?? this.cfg.i18n.fallback, "button.expired") };
            if (actorId !== s.userId && !isStaff) return { ephemeral: this.t(s.lang, "button.notYours") };
            s.lastActivity = this.now();
            const reply = await this.onButton(s, action ?? "");
            this.save();
            return reply;
        });
    }

    /** 「完了」のモーダルの送信 */
    async complete(sessionId: string, memo: string): Promise<void> {
        await this.locked(async () => {
            const s = this.sessions.find((x) => x.id === sessionId);
            if (!s || s.phase !== "awaitingDone") return;
            s.memo = memo.trim() || undefined;
            await this.finish(s, "done");
            this.save();
        });
    }

    /** 「中断する」のモーダルの送信 */
    async abortByUser(sessionId: string, reason: string): Promise<void> {
        await this.locked(async () => {
            const s = this.sessions.find((x) => x.id === sessionId);
            if (!s) return;
            await this.finish(s, "aborted", `配信者が中断: ${reason.trim() || "理由なし"}`);
            this.save();
        });
    }

    /** 進行中のテストの配信者 (無ければ undefined) */
    sessionOwner(sessionId: string): string | undefined {
        return this.sessions.find((s) => s.id === sessionId)?.userId;
    }

    sessionLang(sessionId: string): Lang {
        return this.sessions.find((s) => s.id === sessionId)?.lang ?? this.cfg.i18n.fallback;
    }

    // ---- 運営のコマンド (返事は日本語) ----

    async slotShow(): Promise<string> {
        return this.locked(async () => {
            const rtmpUser = this.sessions.find((s) => s.rtmp && s.phase !== "finished");
            const q = this.queue.entries.map((e, i) => `${i + 1}. ${e.displayName}${this.queue.offers.some((o) => o.userId === e.userId) ? " (知らせ済み)" : ""}`);
            const srtLines = this.slots.srt.map((slot, i) => {
                const user = this.sessions.find((s) => this.usesSrtSlot(s, i));
                return `${this.srtSlotLabel(i)}: フロー ${slot.flow ?? "未設定"} / ch${slot.channel ?? "?"} / ${slot.enabled ? "受付中" : "止めている"}${user ? ` / 使用中: ${user.displayName}` : ""}`;
            });
            return [
                ...srtLines,
                `RTMP の枠: ch${this.slots.rtmp.channel ?? "?"} / ${this.slots.rtmp.enabled ? "受付中" : "止めている"}${rtmpUser ? ` / 使用中: ${rtmpUser.displayName}` : ""}`,
                `待ちの列: ${q.length > 0 ? `\n${q.join("\n")}` : "なし"}`,
            ].join("\n");
        });
    }

    /** slotNo は SRT の枠の番号 (1 始まり。省けば 1)。RTMP の枠は 1 つなので使わない */
    async slotSet(kind: "srt" | "rtmp", channel: number, flowName?: string, slotNo = 1): Promise<string> {
        return this.locked(async () => {
            const index = slotNo - 1;
            if (kind === "srt" && !this.slots.srt[index]) return this.noSuchSrtSlot(slotNo);
            const problems = await this.validateSlot(kind, channel, flowName, index);
            if (problems.length > 0) return `設定し直せませんでした (前の設定のまま):\n${problems.map((p) => `- ${p}`).join("\n")}`;
            const busy = kind === "srt" ? this.sessions.some((s) => this.usesSrtSlot(s, index)) : this.sessions.some((s) => s.rtmp);
            if (kind === "srt") this.slots.srt[index] = { ...this.slots.srt[index]!, flow: flowName, channel };
            else this.slots.rtmp = { ...this.slots.rtmp, channel };
            this.save();
            const note = busy ? "\n進行中のテストは前の枠のまま続けます。新しい枠は次のテストから使います。" : "";
            const label = kind === "srt" ? this.srtSlotLabel(index) : "RTMP の枠";
            return `${label}を設定しました: ${kind === "srt" ? `フロー ${flowName} / ` : ""}ch${channel}${note}`;
        });
    }

    /**
     * 枠の受付を止める / 再開する。slotNo は SRT の枠の番号 (1 始まり)。
     * 省いたとき: 止めるのは SRT の枠すべて。再開は、枠が 1 つならその枠、複数なら番号が要る
     * (止めてある予備の枠まで、まとめて動かしてしまわないように)。
     */
    async slotEnable(kind: "srt" | "rtmp", on: boolean, slotNo?: number): Promise<string> {
        return this.locked(async () => {
            const done = on ? "再開しました" : "止めました (待ちの列は残します)";
            if (kind === "rtmp") {
                this.slots.rtmp.enabled = on;
                this.save();
                return `RTMP の枠を${done}`;
            }
            if (slotNo === undefined && on && this.slots.srt.length > 1) {
                return `SRT の枠は ${this.slots.srt.length} つあります。再開する枠の番号 (slot) を指定してください (止めてある枠をまとめて動かさないため)`;
            }
            if (slotNo !== undefined && !this.slots.srt[slotNo - 1]) return this.noSuchSrtSlot(slotNo);
            const targets = slotNo !== undefined ? [slotNo - 1] : this.slots.srt.map((_, i) => i);
            for (const i of targets) {
                // 運営が決めた状態。止めたのなら、起動し直しても止めたまま (stoppedByProblem: false)
                this.slots.srt[i] = { flow: this.slots.srt[i]!.flow, channel: this.slots.srt[i]!.channel, enabled: on, ...(on ? {} : { stoppedByProblem: false }) };
            }
            this.save();
            const label = targets.length === 1 ? this.srtSlotLabel(targets[0]!) : "SRT の枠すべて";
            return `${label}を${done}`;
        });
    }

    async status(userId?: string): Promise<string> {
        return this.locked(async () => {
            const list = userId ? this.sessions.filter((s) => s.userId === userId) : this.sessions;
            if (list.length === 0) return "進行中のテストはありません";
            return list.map((s) => this.describeSession(s)).join("\n\n");
        });
    }

    async shot(userId: string): Promise<{ text: string; image?: Buffer }> {
        const s = this.sessions.find((x) => x.userId === userId);
        if (!s) return { text: "その配信者のテストは進行中ではありません" };
        const r = await this.takeStill(s);
        return r.image ? { text: `${s.displayName} の静止画`, image: r.image } : { text: `静止画を取れませんでした: ${r.reasons.join(" / ")}` };
    }

    /**
     * 配信の静止画を取る。取れなければ、試した方法ごとの理由を返す。
     * 1. denpachan の録画から取り出す (SRT でも RTMP でも使える。録画が 2 秒分たまってから)。
     * 2. だめなら、SRT のときは MediaConnect のフローのサムネイル (フローで有効にしてあるとき)。
     *    bot が denpachan と別の PC で動いていて、録画のファイルを開けないときのためのもの。
     */
    private async takeStill(s: Session): Promise<{ image?: Buffer; reasons: string[]; tooEarly: boolean }> {
        const reasons: string[] = [];
        const rec = this.activeChannel(s)?.record;
        const pos = recordingPosition(rec) ?? 0;
        const tooEarly = rec?.state === "recording" && pos < kStillMinRecordSec;
        if (!rec?.file || rec.state !== "recording") reasons.push("denpachan が録画していません");
        else if (tooEarly) reasons.push("録画が始まったばかりです");
        else {
            try {
                return { image: await this.d.still.fromRecording(rec.file, pos - kStillBackSec), reasons, tooEarly };
            } catch (e) {
                reasons.push(errorText(e));
            }
        }
        if (s.protocol === "srt" && !s.srt.released) {
            try {
                const image = await this.d.flow.thumbnail(s.srt.flowArn);
                if (image) return { image, reasons, tooEarly };
                reasons.push("フローが静止画を返しませんでした");
            } catch (e) {
                reasons.push(thumbnailReason(e));
            }
        }
        return { reasons, tooEarly };
    }

    /**
     * スレッドに貼る静止画。取れなければ undefined を返し、理由をコンソールと運営への通知に出す (同じテストでは 1 回だけ)。
     * 黙って失敗すると、静止画が出ない原因に気付けない。録画が始まったばかりで取れないだけのときは、知らせない。
     */
    private async still(s: Session): Promise<Buffer | undefined> {
        const r = await this.takeStill(s);
        if (r.image) return r.image;
        if (!r.tooEarly && !s.stillWarned) {
            s.stillWarned = true;
            await this.ops(`配信の静止画を取れません。${s.displayName} のスレッドには静止画なしで案内します: ${r.reasons.join(" / ")}`);
        }
        return undefined;
    }

    /** us は運営がコマンドで入れた値 (μs。OBS の URL に入れる値)。bot の中では ms で持つ */
    async setLatency(userId: string, us: number): Promise<string> {
        return this.locked(async () => {
            const s = this.sessions.find((x) => x.userId === userId);
            if (!s) return "その配信者のテストは進行中ではありません";
            if (s.protocol !== "srt") return "RTMP のテストでは latency を変えられません";
            const target = Math.min(Math.max(Math.round(us / 1000), kMinLatencyMs), this.cfg.latency.maxMs);
            await this.askLatency(s, target);
            this.save();
            return `${s.displayName} に latency ${obsLatency(target)} μs を案内しました`;
        });
    }

    /** denpachan の側 (MediaConnect → denpachan) の latency。denpachan の設定と画面が ms なので、ここだけは ms のまま */
    async setReceiverLatency(channel: number, ms: number): Promise<string> {
        try {
            await this.d.rx.call("patchChannel", { ch: channel, patch: { source: { latencyMs: ms } } });
            return `denpachan の ch${channel} の latency (denpachan の設定の値) を ${ms} ms にしました`;
        } catch (e) {
            return `変えられませんでした: ${errorText(e)}`;
        }
    }

    async forceRtmp(userId: string): Promise<string> {
        return this.locked(async () => {
            const s = this.sessions.find((x) => x.userId === userId);
            if (!s) return "その配信者のテストは進行中ではありません";
            if (s.protocol === "rtmp" || s.pending?.kind === "rtmp") return "すでに RTMP です";
            await this.goRtmp(s, "運営の指示");
            this.save();
            return `${s.displayName} を RTMP に案内しました`;
        });
    }

    async cancel(userId: string): Promise<string> {
        return this.locked(async () => {
            const s = this.sessions.find((x) => x.userId === userId);
            if (!s) return "その配信者のテストは進行中ではありません";
            await this.finish(s, "aborted", "運営が中止");
            this.save();
            return `${s.displayName} のテストを中止しました`;
        });
    }

    async review(userId: string, ok: boolean, memo: string): Promise<string> {
        const rec = this.finished[userId];
        if (!rec?.sheetRange) return "その配信者の記録が見つかりません (シートに書けていない可能性があります)";
        const row = /(\d+)(?::[A-Z]+\d+)?$/.exec(rec.sheetRange)?.[1];
        if (!row) return `シートの行が分かりません (${rec.sheetRange})`;
        const tab = rec.sheetRange.includes("!") ? `${rec.sheetRange.split("!")[0]}!` : "";
        const from = columnLetter(audioVerdictColumn);
        const to = columnLetter(audioVerdictColumn + 1);
        await this.d.sheet.update(`${tab}${from}${row}:${to}${row}`, [ok ? "OK" : "NG", memo]);
        return `音声の判定を書きました (${ok ? "OK" : "NG"})`;
    }

    // ================= テストの始まり =================

    /** このセッションが、SRT の枠 index (0 始まり) を使っているか (RTMP に移って空けたあとは使っていない) */
    private usesSrtSlot(s: Session, index: number): boolean {
        return s.protocol === "srt" && !s.srt.released && s.srt.slot === index;
    }

    /** 受け付けられる SRT の枠 (受付中で、設定が済んでいて、誰も使っていない) の番号 (0 始まり)。前から順 */
    private freeSrtSlots(): number[] {
        const out: number[] = [];
        this.slots.srt.forEach((slot, i) => {
            if (slot.enabled && slot.flow !== undefined && slot.channel !== undefined && !this.sessions.some((s) => this.usesSrtSlot(s, i))) out.push(i);
        });
        return out;
    }

    private freeSrtSlot(): number | undefined {
        return this.freeSrtSlots()[0];
    }

    /** 運営に見せる枠の名前。枠が 1 つなら番号を付けない */
    private srtSlotLabel(index: number): string {
        return this.slots.srt.length > 1 ? `SRT の ${index + 1} 番の枠` : "SRT の枠";
    }

    private noSuchSrtSlot(slotNo: number): string {
        return `SRT の ${slotNo} 番の枠はありません (枠は 1〜${this.slots.srt.length} 番。数は設定ファイルの slots.srt で決まります)`;
    }

    private rtmpAvailable(): boolean {
        return this.slots.rtmp.enabled && this.slots.rtmp.channel !== undefined && !this.sessions.some((s) => s.rtmp);
    }

    /** slotIndex は、使う SRT の枠 (0 始まり。freeSrtSlot() で選んだもの) */
    private async begin(user: UserRef, lang: Lang, slotIndex: number): Promise<string> {
        const slot = this.slots.srt[slotIndex];
        const flowCfg = this.cfg.flows.find((f) => f.name === slot?.flow);
        const channel = slot?.channel;
        const problems: string[] = [];
        if (!flowCfg || channel === undefined) problems.push(`${this.srtSlotLabel(slotIndex)}が設定されていません`);
        else {
            const ch = this.d.rx.channel(channel);
            if (!this.d.rx.connected()) problems.push("denpachan の受信口に繋がっていません");
            else if (!ch) problems.push(`denpachan に ch${channel} がありません`);
            else {
                if (!ch.testSlot) problems.push(`ch${channel} に「配信テスト用」の印がありません`);
                // 設定ファイルに書いた枠は /techcheck slot の検証を通っていないので、受信の方式もここで確かめる
                // (bot が受信の設定を入れるときは、準備の中で入れ直すので見ない)
                if (!this.cfg.denpachan.configure && ch.source.protocol !== "srt") problems.push(this.wrongProtocol(channel, ch, "SRT"));
                if (this.cfg.denpachan.configure && !this.d.rx.canConfigure()) problems.push(this.cannotConfigure());
                if (ch.status !== "stopped") problems.push(`ch${channel} が止まっていません (${ch.status})`);
            }
        }
        if (problems.length > 0 || !flowCfg || channel === undefined) {
            await this.blockSlot(slotIndex, problems);
            this.queue.entries.unshift({ userId: user.id, displayName: user.displayName, lang, joinedAt: this.now(), skips: 0 });
            return this.t(lang, "start.prepareProblem");
        }

        const now = this.now();
        const name = `配信テスト ${formatTime(now)} ${user.displayName}`.slice(0, 100);
        const threadId = await this.d.chat.createThread(name, user.id);
        const s: Session = {
            id: randomUUID(),
            userId: user.id,
            displayName: user.displayName,
            lang,
            threadId,
            createdAt: now,
            phase: "preparing",
            phaseSince: now,
            lastActivity: now,
            reminded: false,
            protocol: "srt",
            srt: { slot: slotIndex, flowName: flowCfg.name, flowArn: flowCfg.arn, domain: flowCfg.domain, channel, startedFlow: false, released: false },
            latencyMs: this.cfg.latency.initialMs,
            raises: 0,
            recordFiles: [],
            rx: { fps: [], silenceAlerted: false, opsWarned: false },
            cw: { missingWarned: false },
            disconnects: 0,
            metadataChecked: false,
            checkIndex: 0,
            checkState: "prompt",
            checkPeaks: [],
            results: [],
            summary: {},
        };
        this.sessions.push(s);
        this.langPrefs[user.id] = lang;
        await this.post(s, { content: this.t(lang, "prepare.preparing") });
        // 準備の間に、本番で web カメラとマイクを使うかを聞く (どちらかを使うなら、配信が届いたあとに VDO.ninja を 1 回だけ開いてもらう)
        if (this.vdoAvailable()) await this.askUsage(s);
        await this.ops(`配信テスト開始: ${user.displayName} (フロー ${flowCfg.name} / ch${channel}) ${this.d.chat.threadUrl(threadId)}`);
        // フローの開始は 1 分ほどかかるので、ロックの外で待つ
        void this.prepare(s.id);
        return this.t(lang, "start.threadCreated", { url: this.d.chat.threadUrl(threadId) });
    }

    /** フローを開始し (止まっていれば)、ドメインを確かめ、denpachan のチャンネルと録画を始める */
    private async prepare(sessionId: string): Promise<void> {
        const get = () => this.sessions.find((x) => x.id === sessionId);
        const s0 = get();
        if (!s0) return;
        const flowCfg = this.cfg.flows.find((f) => f.name === s0.srt.flowName);
        if (!flowCfg) return; // 設定ファイルから無くなったフロー。abortOrphans が中断する
        const channel = s0.srt.channel;
        let startedFlow = false;
        let channelStarted = false;
        /**
         * 待っている間に中止された (運営の cancel、中断) か。中止の後片付け (finish) は、そのときまでに始めたフロー
         * (startedFlow を先に覚えている) とチャンネルを止める。そのあとでこちらが始めたチャンネルは、ここで止める
         */
        const cancelled = async (): Promise<boolean> => {
            if (get()) return false;
            if (channelStarted) await this.stopChannel(channel);
            return true;
        };
        const tag = `準備 (${s0.displayName})`;
        try {
            let info = await this.d.flow.describe(flowCfg.arn);
            this.log(`${tag}: フロー ${flowCfg.name} は ${info.status}`);
            if (info.status !== "ACTIVE") {
                if (info.status !== "STARTING") {
                    this.log(`${tag}: フロー ${flowCfg.name} を開始します (ACTIVE になるまで待ちます)`);
                    await this.d.flow.start(flowCfg.arn);
                    startedFlow = true;
                    // 中止されたときに後片付けが止められるよう、すぐに覚えておく
                    const s = get();
                    if (s) s.srt.startedFlow = true;
                    else {
                        // 開始を待つ間に中止された (後片付けはこのフローを知らない)
                        await this.d.flow.stop(flowCfg.arn).catch((e) => this.log(`StopFlow: ${errorText(e)}`));
                        return;
                    }
                }
                const until = this.now() + kFlowStartWaitMs;
                while (info.status !== "ACTIVE") {
                    if (await cancelled()) return;
                    if (this.now() > until) throw new Error(`フローが ACTIVE になりません (${info.status})`);
                    await (this.d.sleep ?? sleep)(5_000);
                    info = await this.d.flow.describe(flowCfg.arn);
                }
            }
            if (await cancelled()) return;
            if (!info.ingestIp || !info.ingestPort) throw new Error("フローの ingest の IP / ポートが分かりません");
            const domainProblem = await this.domainProblem(flowCfg.domain, info.ingestIp);
            if (domainProblem) throw new Error(domainProblem);
            if (this.cfg.denpachan.configure) {
                // フローの出力に合わせて、枠のチャンネルの受信の設定を入れる (人が画面で合わせなくてよいように)
                const source = this.srtSourceFor(flowCfg, info);
                this.log(`${tag}: denpachan の ch${channel} に受信の設定を入れます (${describeSource(source)})`);
                await this.d.rx.call("patchChannel", { ch: channel, patch: { source } });
            }
            this.log(`${tag}: フロー ${flowCfg.name} は ACTIVE (ingest ${info.ingestIp}:${info.ingestPort})。denpachan の ch${channel} と録画を始めます`);
            channelStarted = true;
            await this.d.rx.call("startChannel", { ch: channel });
            await this.d.rx.call("setRecording", { ch: channel, enabled: true });
            await this.locked(async () => {
                if (await cancelled()) return;
                const s = get()!;
                s.srt.startedFlow = startedFlow;
                s.recordStartAt = this.now();
                await this.postGuide(s, info.ingestPort!);
                this.save();
            });
        } catch (e) {
            this.log(`${tag}: 失敗しました: ${errorText(e)}`);
            await this.locked(async () => {
                if (await cancelled()) return;
                const s = get()!;
                s.srt.startedFlow = startedFlow;
                await this.blockSlot(s.srt.slot, [errorText(e)]);
                await this.post(s, { content: this.t(s.lang, "start.prepareProblem") });
                await this.finish(s, "aborted", `準備の失敗: ${errorText(e)}`);
                // 配信者のせいではないので、列の先頭に戻す
                this.queue.entries.unshift({ userId: s.userId, displayName: s.displayName, lang: s.lang, joinedAt: this.now(), skips: 0 });
                this.save();
            });
        }
    }

    /**
     * bot を起動し直したとき、設定ファイルから無くなったフローを使っていたテストを中断する (起動後の最初の tick で 1 回)。
     * そのままにすると、案内する URL を作れず、tick のたびにエラーになる。
     */
    private async abortOrphans(): Promise<void> {
        if (this.orphansChecked) return;
        this.orphansChecked = true;
        for (const s of [...this.sessions]) {
            if (s.protocol !== "srt" || s.srt.released || this.cfg.flows.some((f) => f.name === s.srt.flowName)) continue;
            this.log(`${s.displayName} のテスト: フロー ${s.srt.flowName} が設定ファイルから無くなったので、中断します`);
            await this.finish(s, "aborted", `設定ファイルからフロー ${s.srt.flowName} が無くなった`);
        }
    }

    /** bot を起動し直したとき、準備の途中だったテストの準備をやり直す */
    resumePreparing(): void {
        for (const s of this.sessions) if (s.phase === "preparing") void this.prepare(s.id);
    }

    /** 枠に問題があったとき: 運営に知らせ、枠を止める (次の人も同じ問題に当たらないように) */
    private async blockSlot(slotIndex: number, problems: string[]): Promise<void> {
        const slot = this.slots.srt[slotIndex];
        if (slot) {
            slot.enabled = false;
            slot.stoppedByProblem = true;
        }
        const command = this.slots.srt.length > 1 ? `/techcheck slot on srt slot:${slotIndex + 1}` : "/techcheck slot on srt";
        await this.ops(`${this.srtSlotLabel(slotIndex)}に問題があるので止めました。直してから \`${command}\` で再開してください:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    }

    private srtUrl(s: Session, port: number, latencyMs: number): string {
        const f = this.cfg.flows.find((x) => x.name === s.srt.flowName)!;
        // パスフレーズは、フローが暗号化しているとき (設定に書いてあるとき) だけ付ける
        const encryption = f.passphrase ? `&passphrase=${encodeURIComponent(f.passphrase)}&pbkeylen=${f.pbkeylen}` : "";
        // mode=caller は付けない: OBS は何も書かなければ caller で繋ぐ。配布している OBS の設定の URL と同じ形
        // (srt://<ドメイン>:<port>?latency=<値>) にして、配信者が見比べて latency の数字だけを直せるようにする
        return `srt://${f.domain}:${port}?latency=${obsLatency(latencyMs)}${encryption}`;
    }

    private srtPort = new Map<string, number>();

    private async postGuide(s: Session, port: number): Promise<void> {
        this.srtPort.set(s.id, port);
        const e = this.cfg.guide.expected;
        const other: Lang = s.lang === "ja" ? "en" : "ja";
        await this.post(s, {
            content: this.t(s.lang, "guide.first", {
                url: this.srtUrl(s, port, s.latencyMs),
                profile: this.cfg.guide.obsProfile,
                width: e.width,
                height: e.height,
                fps: e.fps,
                bitrate: e.bitrateKbps,
                keyframe: e.keyframeSec,
            }),
            buttons: [
                this.btn(s, "started", "button.started", "primary"),
                this.btn(s, "abort", "button.abort", "danger"),
                { id: `tc:${s.id}:lang-${other}`, label: other === "en" ? "English" : "日本語", style: "secondary" },
            ],
        });
        this.setPhase(s, "waitingStream");
    }

    // ================= 1 秒ごとの進行 =================

    private async tickQueue(): Promise<void> {
        const q = this.queue;
        const claimMs = this.cfg.timeouts.claimMin * 60_000;
        // 「始める」を押さないまま時間が切れた人は、後ろに回す (2 回続けば列から外す)
        for (const offer of q.offers.filter((o) => this.now() - o.offeredAt > claimMs)) {
            q.offers = q.offers.filter((o) => o !== offer);
            const i = q.entries.findIndex((e) => e.userId === offer.userId);
            if (i < 0) continue;
            const [entry] = q.entries.splice(i, 1);
            entry!.skips++;
            if (entry!.skips >= 2) {
                this.log(`待ちの列: ${entry!.displayName} は 2 回「始める」を押さなかったので、列から外しました`);
                const removed = this.t(entry!.lang, "queue.removed");
                await this.d.chat.callUser(entry!.userId, { content: `<@${entry!.userId}> ${removed}` }, removed).catch(() => undefined);
            } else {
                this.log(`待ちの列: ${entry!.displayName} は時間内に「始める」を押さなかったので、後ろに回しました`);
                q.entries.push(entry!);
            }
        }
        // 空いている SRT の枠の数まで、列の前から順に知らせる
        const free = this.freeSrtSlots().length;
        while (q.offers.length < free) {
            const next = q.entries.find((e) => !q.offers.some((o) => o.userId === e.userId));
            if (!next) break;
            q.offers.push({ userId: next.userId, offeredAt: this.now() });
            this.log(`待ちの列: ${next.displayName} に順番を知らせます`);
            // 「始める」のボタンは、配信テストのチャンネルのメッセージにだけ付ける。DM は、そこへ案内するだけ
            await this.d.chat
                .callUser(
                    next.userId,
                    {
                        content: this.t(next.lang, "queue.yourTurn", { user: `<@${next.userId}>`, minutes: this.cfg.timeouts.claimMin }),
                        buttons: [{ id: "tcq:claim", label: this.t(next.lang, "button.claim"), style: "primary" }],
                    },
                    this.t(next.lang, "queue.yourTurnDm", { minutes: this.cfg.timeouts.claimMin }),
                )
                .catch((e) => this.log(`待ちの列: ${next.displayName} に知らせを送れませんでした: ${errorText(e)}`));
        }
    }

    private cannotConfigure(): string {
        return "denpachan が、受信の設定の変更を許していません。denpachan の全体設定で「受信の設定の変更も許す」を on にしてください (この項目が無い版の denpachan では、bot の設定の denpachan.configure を false にして、画面で合わせます)";
    }

    /**
     * SRT の枠のチャンネルに入れる受信の設定。フローの出力 (flows[].output) の接続先から作る。
     * 出力が SRT listener なら denpachan は caller で繋ぎに行き、SRT caller なら denpachan が listener で待つ。
     * latency は変えない (MediaConnect → denpachan の区間の値で、運営が /techcheck latency-receiver で決める)。
     */
    private srtSourceFor(flowCfg: FlowConfig, info: FlowInfo): Record<string, string | number> {
        const outputs = info.outputs ?? [];
        const out = outputs.find((o) => o.name === flowCfg.output);
        if (!out) {
            throw new Error(`フロー ${flowCfg.name} に出力 "${flowCfg.output}" がありません (ある出力: ${outputs.map((o) => o.name).join("、") || "なし"})。flows の output を確かめてください`);
        }
        const encryption = { passphrase: flowCfg.outputPassphrase, pbkeylen: flowCfg.outputPassphrase ? flowCfg.pbkeylen : 0, streamId: "" };
        if (out.protocol === "srt-listener") {
            if (!out.listenerAddress || !out.port) throw new Error(`フロー ${flowCfg.name} の出力 "${out.name}" の接続先が分かりません`);
            return { protocol: "srt", mode: "caller", host: out.listenerAddress, port: out.port, ...encryption };
        }
        if (out.protocol === "srt-caller") {
            if (!out.port) throw new Error(`フロー ${flowCfg.name} の出力 "${out.name}" のポートが分かりません`);
            return { protocol: "srt", mode: "listener", host: "0.0.0.0", port: out.port, ...encryption };
        }
        throw new Error(`フロー ${flowCfg.name} の出力 "${out.name}" は SRT ではありません (${out.protocol ?? "不明"})。denpachan が受けられるのは SRT listener か SRT caller の出力です`);
    }

    private wrongProtocol(channel: number, ch: ReceiverChannel, want: string): string {
        return `denpachan の ch${channel} の受信が ${want} ではありません (${ch.source.protocol} ${ch.source.mode})。denpachan のチャンネルの設定か、枠の設定 (slots) を直してください。`;
    }

    /**
     * 枠の設定が、denpachan のチャンネルと合っているか (チャンネルがある、「配信テスト用」の印、受信の方式)。合わない点を返す。
     * 設定ファイルに書いた枠は `/techcheck slot` の検証を通らないので、起動して denpachan に繋がったときに確かめる。
     */
    slotMismatches(): string[] {
        if (!this.d.rx.connected()) return ["denpachan の受信口に繋がっていないので、枠のチャンネルを確かめられません"];
        const out: string[] = [];
        const check = (label: string, channel: number | undefined, isRight: (c: ReceiverChannel) => boolean, want: string) => {
            if (channel === undefined) return;
            const ch = this.d.rx.channel(channel);
            if (!ch) out.push(`${label}: denpachan に ch${channel} がありません`);
            else {
                if (!ch.testSlot) out.push(`${label}: ch${channel} に「配信テスト用」の印がありません`);
                if (!isRight(ch)) out.push(`${label}: ${this.wrongProtocol(channel, ch, want)}`);
            }
        };
        // bot が受信の設定を入れるなら、今の方式は問わない (テストを始めるときに入れ直す)。入れられるかだけを見る
        const configure = this.cfg.denpachan.configure;
        if (configure && !this.d.rx.canConfigure()) out.push(this.cannotConfigure());
        this.slots.srt.forEach((slot, i) => check(this.srtSlotLabel(i), slot.channel, (c) => configure || c.source.protocol === "srt", "SRT"));
        check("RTMP の枠", this.slots.rtmp.channel, (c) => configure || (c.source.protocol === "rtmp" && c.source.mode === "pull"), "RTMP の pull");
        return out;
    }

    /** 起動したとき: 枠と denpachan のチャンネルが合わなければ、コンソールと運営への通知で知らせる */
    async reportSlotMismatches(): Promise<void> {
        const problems = this.slotMismatches();
        if (problems.length === 0) {
            this.log("枠の設定は、denpachan のチャンネルと合っています");
            return;
        }
        await this.ops(`枠の設定が denpachan のチャンネルと合っていません。このままだと、テストの配信を受けられません:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    }

    /** 起動したときにコンソールへ出す、今の状態 (枠、進行中のテスト、待ちの列) */
    startupSummary(): string[] {
        const lines = this.slots.srt.map((slot, i) => `${this.srtSlotLabel(i)}: フロー ${slot.flow ?? "未設定"} / ch${slot.channel ?? "?"} / ${slot.enabled ? "受付中" : "止めている"}`);
        lines.push(`RTMP の枠: ch${this.slots.rtmp.channel ?? "?"} / ${this.slots.rtmp.enabled ? "受付中" : "止めている"}`);
        lines.push(`進行中のテスト: ${this.sessions.length > 0 ? this.sessions.map((s) => `${s.displayName} (${s.phase})`).join("、") : "なし"}`);
        lines.push(`待ちの列: ${this.queue.entries.length > 0 ? this.queue.entries.map((e) => e.displayName).join("、") : "なし"}`);
        if (this.uploads.length > 0) {
            lines.push(
                this.d.drive
                    ? `Google ドライブに上げるのを待っているテスト: ${this.uploads.map((j) => j.displayName).join("、")} (続きから上げます)`
                    : `Google ドライブに上げるのを待っているテストがありますが、google.drive.folderId が未設定なので上げません: ${this.uploads.map((j) => j.displayName).join("、")}`,
            );
        }
        // 保存してあった状態を、今の設定ファイルに合わせて変えたこと
        lines.push(...this.startupNotes);
        return lines;
    }

    private async tickSession(s: Session): Promise<void> {
        if (s.phase === "preparing" || s.phase === "finished") return;
        const rxCh = this.activeChannel(s);
        // 録画ファイルは、配信が長く途切れると切り替わる。テストの間に書いたファイルを、順にすべて覚える (シートの「録画ファイル」)
        if (rxCh?.record?.state === "recording" && rxCh.record.file) this.addRecordFile(s, rxCh.record.file);
        this.observeReceiver(s, rxCh);
        if (s.protocol === "srt" && !s.srt.released) await this.pollCloudWatch(s);
        await this.silenceAlert(s, rxCh);
        // VDO.ninja の受信用のページは、案内してからテストが終わるまで開いておく (マイクだけ使う人も。最後に録音する)
        if (this.vdoOpen(s)) {
            // bot を起動し直したあとは、受信用のページを開き直す
            const link = this.cfg.vdoninja.links[s.webcam!.link];
            if (link && !this.d.webcam!.status(s.id)) this.d.webcam!.open(s.id, link.view);
            this.keepWebcamRecording(s);
            if (this.webcamActive(s) && (s.phase === "measuring" || s.phase === "confirming") && (await this.watchWebcam(s))) return;
        }

        switch (s.phase) {
            case "waitingStream":
                return this.tickWaiting(s, rxCh);
            case "awaitingUsage":
                return this.tickAwaitingUsage(s);
            case "awaitingWebcam":
                return this.tickAwaitingWebcam(s);
            case "measuring":
                return s.protocol === "srt" ? this.tickMeasuringSrt(s, rxCh) : this.tickMeasuringRtmp(s, rxCh);
            case "confirming":
                return this.tickConfirming(s, rxCh);
            case "awaitingLatency":
            case "awaitingRtmp":
                return this.tickPending(s);
            case "checks":
                return this.tickChecks(s, rxCh);
            case "awaitingDone":
                return this.idleTimeout(s);
        }
    }

    private activeChannel(s: Session): ReceiverChannel | undefined {
        const ch = s.protocol === "rtmp" && s.rtmp ? s.rtmp.channel : s.srt.channel;
        return this.d.rx.channel(ch);
    }

    /** denpachan の状態から、繋ぎ直し・途絶を見る */
    private observeReceiver(s: Session, ch: ReceiverChannel | undefined): void {
        if (!ch) return;
        const now = this.now();
        const live = ch.status === "live";
        if (s.rx.lastStatus === "live" && !live) s.rx.droppedAt = now;
        if (live && s.rx.droppedAt !== undefined) {
            s.rx.reconnectAt = now;
            s.rx.droppedAt = undefined;
            if (this.unexpectedDrop(s)) s.disconnects++;
        }
        const sec = ch.source.connectedSec;
        if (sec !== undefined && s.rx.lastConnectedSec !== undefined && sec + 2 < s.rx.lastConnectedSec && live) s.rx.reconnectAt = now;
        s.rx.lastStatus = ch.status;
        s.rx.lastConnectedSec = sec;
        if (live && ch.video?.fps !== undefined && (s.phase === "measuring" || s.phase === "confirming")) {
            s.rx.fps.push(ch.video.fps);
            if (s.rx.fps.length > 600) s.rx.fps.shift();
        }
    }

    /** 頼んでいない途切れか (latency の変更・RTMP への切り替え・繋ぎ直しの手順は数えない) */
    private unexpectedDrop(s: Session): boolean {
        if (s.phase === "measuring" || s.phase === "confirming" || s.phase === "awaitingDone") return true;
        return s.phase === "checks" && !(this.currentStep(s)?.kind === "reconnect" && s.checkState === "running");
    }

    private async pollCloudWatch(s: Session): Promise<void> {
        const now = this.now();
        if (now - (this.lastCwFetch.get(s.id) ?? 0) < kCwPollMs) return;
        this.lastCwFetch.set(s.id, now);
        const toSec = Math.floor(now / 1000);
        const fromSec = Math.max(Math.floor(s.createdAt / 1000), toSec - kCwLookbackSec);
        let got: SrtSample[];
        try {
            got = await this.d.flow.metrics(s.srt.flowArn, fromSec, toSec);
        } catch (e) {
            this.log(`CloudWatch: ${errorText(e)}`);
            return;
        }
        const map = this.samples.get(s.id) ?? new Map<number, SrtSample>();
        for (const x of got) map.set(x.t, x);
        for (const t of map.keys()) if (t < toSec - 900) map.delete(t);
        this.samples.set(s.id, map);
        // SourceUpTime が戻った = 繋ぎ直した
        const latest = [...map.values()].filter((x) => x.upTimeSec !== undefined).sort((a, b) => a.t - b.t);
        for (const x of latest) {
            if (s.cw.lastUpTime !== undefined && x.upTimeSec! + 2 < s.cw.lastUpTime && x.t * 1000 > (s.cw.reconnectAt ?? 0)) s.cw.reconnectAt = x.t * 1000;
            s.cw.lastUpTime = x.upTimeSec;
        }
    }

    private window(s: Session, fromSec: number | undefined): SrtSample[] {
        if (fromSec === undefined) return [];
        const map = this.samples.get(s.id);
        if (!map) return [];
        return [...map.values()].filter((x) => x.t >= fromSec).sort((a, b) => a.t - b.t);
    }

    /** CloudWatch で見て、いま繋がっているか (CloudWatch は数十秒遅れて届くので、最近 2 分の最後の値で見る) */
    private mcConnected(s: Session): boolean {
        const w = this.window(s, Math.floor(this.now() / 1000) - 120);
        return w.length > 0 && w[w.length - 1]!.connected;
    }

    /** CloudWatch で見て、しばらく (秒数分の値が) 繋がったままか */
    private mcConnectedFor(s: Session, sec: number): boolean {
        const w = this.window(s, Math.floor(this.now() / 1000) - sec - 120);
        const connected = w.filter((x) => x.connected).length;
        return connected >= sec && w[w.length - 1]!.connected;
    }

    private async silenceAlert(s: Session, ch: ReceiverChannel | undefined): Promise<void> {
        if (!ch || ch.status !== "live") return;
        // 知らせるのは、映像を判定している間だけ。チェックの間は知らせない: 手順が「ゲームの側で音が出ない状態にして」と頼み、
        // そのあとの手順 (画面) でも止めたままなので、無音は頼んだとおりの状態。
        // 音が届いているかは、チェックの最初の手順 (ゲーム音) が確かめる
        const silent = (ch.audio?.silentSec ?? 0) > this.cfg.judge.silentAlertSec;
        if (silent && !s.rx.silenceAlerted && ["measuring", "confirming"].includes(s.phase)) {
            s.rx.silenceAlerted = true;
            await this.post(s, { content: this.t(s.lang, "audio.silent") });
        } else if (!silent && (ch.audio?.silentSec ?? 0) === 0) {
            s.rx.silenceAlerted = false;
        }
    }

    // ---- 配信の開始を待つ ----

    private async tickWaiting(s: Session, ch: ReceiverChannel | undefined): Promise<void> {
        const now = this.now();
        const rxLive = ch?.status === "live";
        const mcConnected = this.mcConnected(s);
        const connected = this.d.rx.connected() ? rxLive : mcConnected;
        if (connected) {
            s.connectedAt = now;
            await this.onConnected(s);
            return;
        }
        if (this.d.rx.connected() && !rxLive && this.mcConnectedFor(s, kOpsWarnAfterSec) && !s.rx.opsWarned) {
            s.rx.opsWarned = true;
            await this.ops(`運営側の問題の可能性: ${s.displayName} の配信は MediaConnect に届いているのに、denpachan の ch${s.srt.channel} が live になりません (${ch?.status ?? "不明"} ${ch?.lastError ?? ""})`);
            await this.post(s, { content: this.t(s.lang, "wait.opsChecking") });
        }
        const elapsed = now - s.phaseSince;
        // 催促は「OBS は配信中なのに、別の場所に送っている」ときのためのもの。MediaConnect に届いている (運営側の受信の問題) なら、
        // 配信者に確かめてもらうことは無いので出さない (「運営側の受信を確認しています」と伝えてある)
        if (!s.reminded && !mcConnected && !s.rx.opsWarned && elapsed > this.timeout(this.cfg.timeouts.connectRemindMin)) {
            s.reminded = true;
            await this.post(s, { content: this.t(s.lang, "wait.remind") });
        }
        if (elapsed > this.timeout(this.cfg.timeouts.connectAbortMin)) await this.finish(s, "aborted", "配信が届かないまま時間切れ");
    }

    private async onConnected(s: Session): Promise<void> {
        const image = await this.still(s);
        // web カメラかマイクを使うなら、先に VDO.ninja を届けてもらい、両方を送っている状態で計測する (設計書 §5.9)。
        // まだ答えていなければ、答えを待つ (答えで、VDO.ninja を開くかが決まる)
        const vdo = this.vdoAvailable() && !s.webcam && (!this.usageAnswered(s) || this.vdoWanted(s));
        await this.post(s, { content: this.t(s.lang, vdo ? "wait.arrivedWebcam" : "wait.arrived"), image: image ? { name: "stream.jpg", data: image } : undefined });
        if (s.protocol === "srt" && !s.metadataChecked) {
            s.metadataChecked = true;
            const md = await this.d.flow.metadata(s.srt.flowArn).catch(() => undefined);
            if (md) {
                s.streamFps = md.fps;
                s.summary.codec = md.codec;
                s.summary.width = md.width;
                s.summary.height = md.height;
                const e = this.cfg.guide.expected;
                const diffs: string[] = [];
                if (md.width && md.height && (md.width !== e.width || md.height !== e.height)) diffs.push(`${md.width}x${md.height}`);
                if (md.fps && Math.abs(md.fps - e.fps) > 1) diffs.push(`${md.fps} fps`);
                if (!md.hasAudio) diffs.push(this.t(s.lang, "metadata.noAudio"));
                if (diffs.length > 0) {
                    await this.post(s, { content: this.t(s.lang, "metadata.mismatch", { actual: diffs.join(", "), width: e.width, height: e.height, fps: e.fps }) });
                }
            }
        }
        if (vdo && !this.usageAnswered(s)) return this.waitUsage(s);
        if (vdo) return this.askWebcam(s, false);
        this.startMeasuring(s, Math.floor(this.now() / 1000) + kWarmupSec);
    }

    // ---- 本番で web カメラとマイクを使うか (設計書 §5.9) ----

    /** VDO.ninja を使う設定か (vdoninja.links がある) */
    private vdoAvailable(): boolean {
        return this.d.webcam !== undefined;
    }

    /** web カメラとマイクの両方に答えたか (VDO.ninja を使わない設定なら、聞かないので答えたものとする) */
    private usageAnswered(s: Session): boolean {
        return !this.vdoAvailable() || (s.usage?.camera !== undefined && s.usage?.mic !== undefined);
    }

    /** web カメラを確かめるか (「使う」か「未定」で、案内の「web カメラは使わない」を押していない) */
    private cameraWanted(s: Session): boolean {
        return this.vdoAvailable() && s.usage?.camera !== "no" && !s.webcam?.skipped;
    }

    /** マイクの声を録るか (「使う」か「未定」)。録音の手順の「マイクは使わない」は、手順の中で記録する */
    private micWanted(s: Session): boolean {
        return this.vdoAvailable() && s.usage?.mic !== "no";
    }

    /** VDO.ninja を開いてもらうか (web カメラかマイクのどちらかを使う) */
    private vdoWanted(s: Session): boolean {
        return this.cameraWanted(s) || this.micWanted(s);
    }

    /** 使うかを聞く。web カメラとマイクで、メッセージを分ける (ボタンを 1 行にまとめるため) */
    private async askUsage(s: Session): Promise<void> {
        s.usage = {};
        s.usage.cameraMessageId = await this.post(s, this.usageMessage(s, "camera"));
        s.usage.micMessageId = await this.post(s, this.usageMessage(s, "mic"));
    }

    /** 使うかを聞くメッセージ。答えたら、選んだものを書き足し、そのボタンを目立たせる。VDO.ninja の案内のあとはボタンを外す */
    private usageMessage(s: Session, item: "camera" | "mic"): OutMessage {
        const answer = s.usage?.[item];
        const content = this.t(s.lang, `usage.${item}`) + (answer ? `\n${this.t(s.lang, "usage.chosen", { answer: this.t(s.lang, `usage.answer.${answer}`) })}` : "");
        if (s.usage?.locked) return { content };
        const keys: Record<UsageAnswer, string> = { yes: "button.usageYes", maybe: "button.usageMaybe", no: "button.usageNo" };
        const buttons = (["yes", "maybe", "no"] as const).map((a) => this.btn(s, `usage-${item}-${a}`, keys[a], answer === a ? "primary" : "secondary"));
        return { content, buttons };
    }

    private async refreshUsageMessages(s: Session): Promise<void> {
        for (const item of ["camera", "mic"] as const) {
            const id = item === "camera" ? s.usage?.cameraMessageId : s.usage?.micMessageId;
            if (id) await this.d.chat.editMessage(s.threadId, id, this.usageMessage(s, item)).catch((e) => this.log(`使うかの質問を書き換えられませんでした: ${errorText(e)}`));
        }
    }

    /** 配信は届いたが、まだ答えていない。答えるまで待つ (答えで、VDO.ninja を開くかが決まる) */
    private async waitUsage(s: Session): Promise<void> {
        await this.post(s, { content: this.t(s.lang, "usage.remind", { user: `<@${s.userId}>` }) });
        this.setPhase(s, "awaitingUsage");
    }

    private async tickAwaitingUsage(s: Session): Promise<void> {
        if (this.usageAnswered(s)) return this.afterUsage(s);
        const elapsed = this.now() - s.phaseSince;
        if (!s.reminded && elapsed > this.timeout(this.cfg.timeouts.raiseRemindMin)) {
            s.reminded = true;
            await this.post(s, { content: this.t(s.lang, "usage.remind", { user: `<@${s.userId}>` }) });
        }
        if (elapsed > this.timeout(this.cfg.timeouts.stepAbortMin)) await this.finish(s, "aborted", "web カメラとマイクを使うかに答えないまま時間切れ");
    }

    /** 答えがそろったら: VDO.ninja を使うなら案内し、使わないなら計測へ */
    private async afterUsage(s: Session): Promise<void> {
        if (this.vdoWanted(s)) return this.askWebcam(s, false);
        this.startMeasuring(s, Math.floor(this.now() / 1000) + kWarmupSec);
    }

    /** 使うかのボタン。VDO.ninja の案内を出すまでは、押し直せる */
    private async onUsage(s: Session, item: "camera" | "mic", answer: UsageAnswer): Promise<ButtonReply> {
        if (!s.usage || s.usage.locked) return { ephemeral: this.t(s.lang, "usage.locked") };
        s.usage[item] = answer;
        s.lastActivity = this.now();
        await this.refreshUsageMessages(s);
        // 配信が届いて答えを待っていたなら、そろった時点で進む
        if (s.phase === "awaitingUsage" && this.usageAnswered(s)) await this.afterUsage(s);
        return {};
    }

    private startMeasuring(s: Session, fromSec: number): void {
        s.measureFromSec = fromSec;
        // web カメラの受信の統計は、ここからの差で見る
        if (this.webcamActive(s)) {
            const st = this.d.webcam!.status(s.id);
            s.webcam!.base = { packetsReceived: st?.packetsReceived, packetsLost: st?.packetsLost, freezes: st?.freezes };
            s.webcam!.lostAt = undefined;
        }
        s.rx.fps = [];
        const ch = this.activeChannel(s);
        s.rx.decodeErrorsBase = ch?.video?.decodeErrors;
        s.rx.retransBase = ch?.tcp?.retransBytes;
        this.setPhase(s, "measuring");
    }

    // ---- web カメラ (VDO.ninja。設計書 §5.9) ----

    /**
     * web カメラの録画 (設定の vdoninja.record)。届いてからテストが終わるまで録る。毎秒呼ぶ:
     * ページを開き直した (bot を起動し直した) ら録り直し、書いたファイルを覚える (シートと Google ドライブ)
     */
    private keepWebcamRecording(s: Session): void {
        const cam = s.webcam;
        if (!cam || !this.cfg.vdoninja.record || !this.webcamActive(s) || cam.arrivedAt === undefined) return;
        const st = this.d.webcam!.status(s.id);
        if (!st || st.state !== "open") return;
        if (!st.recording) {
            cam.recordBase = `${this.d.vdoninjaDir ?? "."}/${fileStamp(this.now())} ${safeFileName(s.displayName)} ${s.userId} webcam`;
            this.d.webcam!.startRecording(s.id, cam.recordBase);
            this.log(`${s.displayName}: web カメラの録画を始めます (${cam.recordBase}.webm)`);
        }
        this.addWebcamFiles(s, st.recordFiles ?? []);
    }

    private addWebcamFiles(s: Session, files: string[]): void {
        if (!s.webcam || files.length === 0) return;
        const known = s.webcam.files ?? [];
        s.webcam.files = [...known, ...files.filter((f) => !known.includes(f))];
    }

    /** 受信用のページを閉じる。録画していたら、書き終えたファイルを覚える */
    private async closeWebcam(s: Session): Promise<void> {
        if (!this.d.webcam) return;
        const files = await this.d.webcam.close(s.id).catch((e) => {
            this.log(`web カメラ: ${errorText(e)}`);
            return [] as string[];
        });
        this.addWebcamFiles(s, files);
    }

    /**
     * VDO.ninja の受信用のページを開いているテストか (案内したあと)。bot の側の問題で開けなかったテストと、
     * あとで web カメラもマイクも使わないことになった (ページを閉じた) テストは除く
     */
    private vdoOpen(s: Session): boolean {
        return this.d.webcam !== undefined && s.webcam !== undefined && !s.webcam.failed && this.vdoWanted(s);
    }

    /** このテストで、web カメラの映像を見ているか (使わない人と、bot の側の問題で見られなかったテストは見ない) */
    private webcamActive(s: Session): boolean {
        return this.vdoOpen(s) && !s.webcam!.skipped;
    }

    /** ほかのテストが使っていない、送信用と受信用の URL の組 (設定の vdoninja.links の位置) */
    private freeWebcamLink(s: Session): number | undefined {
        // 「web カメラは使わない」の人の組も、空けない (マイクの声の録音の手順で、同じ組を使う)
        const used = new Set(this.sessions.filter((x) => x.id !== s.id && x.webcam && !x.webcam.failed).map((x) => x.webcam!.link));
        const i = this.cfg.vdoninja.links.findIndex((_, n) => !used.has(n));
        return i < 0 ? undefined : i;
    }

    /**
     * 送信用の URL を配信者に渡し、bot は受信用の URL を開いて、届くのを待つ。VDO.ninja を開いてもらうのは、このテストで 1 回だけ:
     * web カメラとマイクの両方を、同じページから送ってもらう。使わない方は、ページの上で切ってもらう
     * (「Video Source」を「Disable Video」に、「Audio Source(s)」を「No Audio」に)。
     * lost は、映像の判定の間に web カメラが届かなくなって、待ち直すとき
     */
    private async askWebcam(s: Session, lost: boolean): Promise<void> {
        const index = s.webcam?.link ?? this.freeWebcamLink(s);
        const link = index === undefined ? undefined : this.cfg.vdoninja.links[index];
        if (!link || index === undefined) {
            s.webcam = { link: -1 };
            return this.webcamFailed(s, "空いている web カメラの URL の組がありません (設定の vdoninja.links を確かめてください)");
        }
        // 案内を出したら、使うかの答えは変えられない (ボタンを外す)。web カメラを使わない人は、映像を待たない
        if (s.usage && !s.usage.locked) {
            s.usage.locked = true;
            await this.refreshUsageMessages(s);
        }
        s.webcam = { ...s.webcam, link: index, skipped: s.webcam?.skipped ?? s.usage?.camera === "no", playingSince: undefined, arrivedAt: undefined, lostAt: undefined };
        if (!this.d.webcam!.status(s.id)) this.d.webcam!.open(s.id, link.view);
        const camera = this.cameraWanted(s);
        const sources = this.t(s.lang, camera && this.micWanted(s) ? "webcam.sourcesBoth" : camera ? "webcam.sourcesCamera" : "webcam.sourcesMic");
        const content = lost ? this.t(s.lang, "webcam.lost", { url: link.push }) : this.t(s.lang, "webcam.ask", { url: link.push, sources }) + (camera ? `\n${this.t(s.lang, "webcam.skipHint")}` : "");
        const buttons = [...(camera ? [this.btn(s, "webcam-skip", "button.webcamSkip", "secondary")] : []), this.btn(s, "abort", "button.abort", "danger")];
        s.webcam.messageId = await this.post(s, { content, buttons });
        this.setPhase(s, "awaitingWebcam");
    }

    /** VDO.ninja が届くのを待つ。web カメラを使うなら映像が続けて届いたら、マイクだけなら音声が届いたら、計測を始める */
    private async tickAwaitingWebcam(s: Session): Promise<void> {
        const cam = s.webcam;
        if (!cam || !this.vdoOpen(s)) return this.startMeasuring(s, Math.floor(this.now() / 1000) + kWarmupSec);
        const now = this.now();
        const st = this.d.webcam!.status(s.id);
        if (st?.state === "error") return this.webcamFailed(s, st.error ?? "");
        const camera = this.cameraWanted(s);
        if (camera ? st?.playing : st?.audio) {
            cam.playingSince ??= now;
            if (!camera || now - cam.playingSince >= kWebcamStableMs) {
                cam.arrivedAt = now;
                if (cam.messageId) await this.d.chat.clearButtons(s.threadId, cam.messageId).catch(() => undefined);
                cam.messageId = undefined;
                const image = camera ? await this.d.webcam!.still(s.id).catch(() => undefined) : undefined;
                await this.post(s, { content: this.t(s.lang, camera ? "webcam.arrived" : "webcam.arrivedMic"), image: image ? { name: "webcam.jpg", data: image } : undefined });
                this.log(camera ? `${s.displayName}: web カメラが届きました (${st?.width ?? "?"}x${st?.height ?? "?"})` : `${s.displayName}: VDO.ninja のマイクの音声が届きました`);
                this.startMeasuring(s, Math.floor(now / 1000) + kWarmupSec);
            }
            return;
        }
        cam.playingSince = undefined;
        const elapsed = now - s.phaseSince;
        if (!s.reminded && elapsed > this.timeout(this.cfg.timeouts.raiseRemindMin)) {
            s.reminded = true;
            await this.post(s, { content: this.t(s.lang, camera ? "webcam.remind" : "webcam.remindMic") });
        }
        if (elapsed > this.timeout(this.cfg.timeouts.stepAbortMin)) await this.finish(s, "aborted", camera ? "web カメラが届かないまま時間切れ" : "VDO.ninja のマイクの音声が届かないまま時間切れ");
    }

    /**
     * 映像の判定の間、web カメラが届き続けているかを見る。届かなくなったら (vdoninja.lostSec 秒)、判定をやめて待ち直す:
     * 判定は、OBS の配信と WebRTC の両方を送っている状態でする。待ち直したら true
     */
    private async watchWebcam(s: Session): Promise<boolean> {
        const cam = s.webcam!;
        const st = this.d.webcam!.status(s.id);
        if (st?.state === "error") {
            await this.webcamFailed(s, st.error ?? "");
            return false;
        }
        if (st?.playing) {
            cam.lostAt = undefined;
            return false;
        }
        const now = this.now();
        cam.lostAt ??= now;
        if (now - cam.lostAt < this.cfg.vdoninja.lostSec * 1000) return false;
        cam.drops = (cam.drops ?? 0) + 1;
        await this.askWebcam(s, true);
        return true;
    }

    /** bot の側の問題で web カメラを見られない (ブラウザを開けない、など)。配信者のせいではないので、運営に知らせて、web カメラなしで進める */
    private async webcamFailed(s: Session, error: string): Promise<void> {
        await this.closeWebcam(s);
        s.webcam = { ...(s.webcam ?? { link: -1 }), failed: true };
        await this.ops(`web カメラの映像を確認できませんでした: ${s.displayName} (${error})。web カメラなしで進めます`);
        if (s.webcam.messageId) await this.d.chat.clearButtons(s.threadId, s.webcam.messageId).catch(() => undefined);
        await this.post(s, { content: this.t(s.lang, "webcam.failed") });
        if (s.phase !== "measuring" && s.phase !== "confirming") this.startMeasuring(s, Math.floor(this.now() / 1000) + kWarmupSec);
    }

    /** 映像の判定が終わったときの、web カメラの受信の状態を覚える (シートに書く)。乱れていれば運営に知らせる */
    private async summarizeWebcam(s: Session): Promise<void> {
        if (!this.webcamActive(s)) return;
        const cam = s.webcam!;
        const st = this.d.webcam!.status(s.id);
        if (!st) return;
        cam.width = st.width;
        cam.height = st.height;
        cam.fps = round1(st.fps);
        if (st.packetsReceived !== undefined && st.packetsLost !== undefined) {
            const received = st.packetsReceived - (cam.base?.packetsReceived ?? 0);
            const lost = Math.max(0, st.packetsLost - (cam.base?.packetsLost ?? 0));
            if (received + lost > 0) cam.lossPct = Math.round((lost / (received + lost)) * 1000) / 10;
        }
        if (st.freezes !== undefined) cam.freezes = Math.max(0, st.freezes - (cam.base?.freezes ?? 0));
        if ((cam.lossPct ?? 0) >= kWebcamLossPct || (cam.freezes ?? 0) > 0 || (cam.drops ?? 0) > 0) {
            await this.ops(`web カメラの映像が乱れています: ${s.displayName} (${describeWebcam(s)}) ${this.d.chat.threadUrl(s.threadId)}`);
        }
    }

    // ---- 映像の判定 (SRT) ----

    private async tickMeasuringSrt(s: Session, ch: ReceiverChannel | undefined): Promise<void> {
        const nowSec = Math.floor(this.now() / 1000);
        const w = this.window(s, s.measureFromSec);
        const elapsed = nowSec - (s.measureFromSec ?? nowSec);
        const cwMissing = w.length === 0 && elapsed > this.cfg.judge.windowSec + kCwMissingGraceSec;
        if (w.length < this.cfg.judge.windowSec && !cwMissing) return;
        if (elapsed < this.cfg.judge.windowSec) return;

        if (cwMissing && !s.cw.missingWarned) {
            s.cw.missingWarned = true;
            await this.ops(`CloudWatch のメトリクスが取れません (${s.srt.flowName})。${s.displayName} の映像は denpachan の受信状態だけで判定します`);
        }
        const advice: Advice = cwMissing
            ? { verdict: "ok", recommendMs: 0, headroomMs: null, rttMs: 0, lossPct: 0, drops: 0, multiplier: 0, windowSec: 0 }
            : advise(w.slice(-this.cfg.judge.windowSec), s.latencyMs, this.cfg.judge.multipliers);
        s.lastAdvice = advice;
        this.updateSummary(s, w, advice, ch);

        const jitterBad = w.length > 0 && w.filter((x) => (x.jitterMs ?? 0) > this.cfg.judge.maxJitterMs).length > w.length / 2;
        if (this.senderProblem(s, ch) || jitterBad) {
            await this.maxOrRtmp(s, jitterBad ? "ジッタが大きい" : "デコードが安定しない");
            return;
        }
        if (advice.verdict === "measuring") return;
        if (advice.verdict === "tight" || advice.verdict === "insufficient") {
            await this.raise(s, advice);
            return;
        }
        s.confirmFromSec = nowSec;
        s.rx.fps = [];
        s.rx.decodeErrorsBase = ch?.video?.decodeErrors;
        this.setPhase(s, "confirming");
    }

    private senderProblem(s: Session, ch: ReceiverChannel | undefined): boolean {
        if (!ch || !this.d.rx.connected()) return false;
        const expected = s.streamFps ?? this.cfg.guide.expected.fps;
        const fpsAvg = avg(s.rx.fps);
        const decodeDelta = (ch.video?.decodeErrors ?? 0) - (s.rx.decodeErrorsBase ?? ch.video?.decodeErrors ?? 0);
        return (fpsAvg !== undefined && fpsAvg < expected * this.cfg.judge.minFpsRatio) || decodeDelta >= kSenderDecodeErrors;
    }

    private async tickConfirming(s: Session, ch: ReceiverChannel | undefined): Promise<void> {
        const nowSec = Math.floor(this.now() / 1000);
        const from = s.confirmFromSec ?? nowSec;
        if (nowSec - from < this.cfg.judge.confirmSec) return;
        const w = this.window(s, from);
        // CloudWatch は遅れて届くので、窓の 8 割が揃うまで (最大 90 秒) 待つ
        if (s.protocol === "srt" && !s.cw.missingWarned && w.length < this.cfg.judge.confirmSec * 0.8 && nowSec - from < this.cfg.judge.confirmSec + 90) return;
        const drops = sum(w.map((x) => x.notRecovered ?? 0));
        const broken = sum(w.map((x) => (x.continuityErrors ?? 0) + (x.tsSyncLoss ?? 0)));
        const expected = s.streamFps ?? this.cfg.guide.expected.fps;
        const fpsAvg = avg(s.rx.fps);
        const decodeDelta = ch?.video?.decodeErrors !== undefined && s.rx.decodeErrorsBase !== undefined ? ch.video.decodeErrors - s.rx.decodeErrorsBase : 0;
        const fpsOk = fpsAvg === undefined || fpsAvg >= expected * this.cfg.judge.minFpsRatio;
        if (drops === 0 && broken === 0 && decodeDelta === 0 && fpsOk) {
            await this.confirmed(s);
            return;
        }
        // 確定の間に乱れた: 計測のときの推奨値では足りなかったので、推奨値の規則どおり、今の 1.5 倍以上にする
        const last = s.lastAdvice ?? advise([], s.latencyMs, this.cfg.judge.multipliers);
        const advice: Advice = { ...last, verdict: "insufficient", drops, recommendMs: atLeastAfterDrops(last.recommendMs, s.latencyMs) };
        if (!fpsOk || decodeDelta >= kSenderDecodeErrors) {
            await this.maxOrRtmp(s, "デコードが安定しない");
            return;
        }
        await this.raise(s, advice);
    }

    private async confirmed(s: Session): Promise<void> {
        s.confirmedLatencyMs = s.latencyMs;
        s.videoVerdict = s.protocol === "rtmp" ? "RTMP" : "OK";
        s.summary.fpsAvg = round1(avg(s.rx.fps));
        const ch = this.activeChannel(s);
        if (ch?.video?.decodeErrors !== undefined) s.summary.decodeErrors = ch.video.decodeErrors;
        await this.summarizeWebcam(s);
        if (s.protocol === "srt") {
            // 回線に余裕があっても「下げてもよい」とは伝えない: 下げるかどうかを配信者に委ねると、結局どうすればよいのか分からない。
            // 配信者には、決まった値をそのまま使ってもらう。推奨値はシートに残る (運営が見て、必要なら /techcheck latency で案内し直す)
            await this.post(s, { content: this.t(s.lang, "judge.ok", { latencyUs: obsLatency(s.latencyMs) }) });
            await this.ops(`映像 OK: ${s.displayName} (SRT、latency ${obsLatency(s.latencyMs)} μs)`);
        } else {
            await this.post(s, { content: this.t(s.lang, "judge.okRtmp") });
            await this.ops(`映像 OK: ${s.displayName} (RTMP)`);
        }
        await this.startChecks(s);
    }

    // ---- latency を上げてもらう ----

    private async raise(s: Session, advice: Advice): Promise<void> {
        const max = this.cfg.latency.maxMs;
        const target = nextLatency(advice.recommendMs, max);
        // 上げる回数を使い切った、または推奨値が今より大きくならない: RTMP の前に、SRT の上限を試す (maxOrRtmp)
        if (s.raises >= this.cfg.latency.maxRaises || target <= s.latencyMs) {
            await this.maxOrRtmp(s, "latency を上げても直らない");
            return;
        }
        s.prevDrops = advice.drops;
        await this.askLatency(s, target);
    }

    /**
     * SRT で安定しないとき: RTMP に案内する前に、まず SRT の latency の上限 (latency.maxUs) を試してもらう。
     * 上限でも安定しなければ (もう上限にしているなら)、RTMP に案内する。
     * 上限を試すのは 1 回で、上げる回数 (latency.maxRaises) には数えない
     */
    private async maxOrRtmp(s: Session, reason: string): Promise<void> {
        const max = this.cfg.latency.maxMs;
        if (s.protocol !== "srt" || s.latencyMs >= max) return this.goRtmp(s, `${reason} (SRT の上限 ${obsLatency(max)} μs でも安定しない)`);
        await this.ops(`SRT の上限を試します: ${s.displayName} (${reason}。latency ${obsLatency(s.latencyMs)} → ${obsLatency(max)} μs。これでも安定しなければ RTMP に案内します)`);
        await this.askLatency(s, max);
    }

    private async askLatency(s: Session, target: number): Promise<void> {
        let port = this.srtPort.get(s.id);
        if (port === undefined) {
            port = (await this.d.flow.describe(s.srt.flowArn)).ingestPort ?? 0;
            this.srtPort.set(s.id, port);
        }
        const msgId = await this.post(s, {
            content: this.t(s.lang, "latency.ask", { latencyUs: obsLatency(target), url: this.srtUrl(s, port, target) }),
            buttons: [this.btn(s, "set", "button.set", "primary"), this.btn(s, "abort", "button.abort", "danger")],
        });
        s.pending = { kind: "latency", target, askedAt: this.now(), messageId: msgId, pressed: false, reminded: false };
        this.setPhase(s, "awaitingLatency");
    }

    // ---- RTMP へ ----

    private async goRtmp(s: Session, reason: string): Promise<void> {
        const rtmpCh = this.slots.rtmp.channel === undefined ? undefined : this.d.rx.channel(this.slots.rtmp.channel);
        const configure = this.cfg.denpachan.configure;
        const wrong =
            configure && !this.d.rx.canConfigure()
                ? ` ${this.cannotConfigure()}`
                : !configure && rtmpCh && (rtmpCh.source.protocol !== "rtmp" || rtmpCh.source.mode !== "pull")
                  ? ` ${this.wrongProtocol(rtmpCh.ch, rtmpCh, "RTMP の pull")}`
                  : "";
        if (!this.rtmpAvailable() || wrong) {
            s.videoVerdict = "NG";
            await this.ops(`RTMP の枠が使えません。${wrong}${s.displayName} の映像が安定しません (${reason})。連絡してください ${this.d.chat.threadUrl(s.threadId)}`);
            await this.post(s, { content: this.t(s.lang, "rtmp.unavailable") });
            await this.startChecks(s);
            return;
        }
        const channel = this.slots.rtmp.channel!;
        s.rtmp = { channel };
        try {
            if (configure) {
                // RTMP サーバから pull する設定を入れる (URL は、配信者に案内するものと同じ)
                const r = this.cfg.rtmp;
                this.log(`${s.displayName}: denpachan の ch${channel} に受信の設定を入れます (RTMP の pull rtmp://${r.domain}/${r.app}/…)`);
                await this.d.rx.call("patchChannel", { ch: channel, patch: { source: { protocol: "rtmp", mode: "pull", url: `rtmp://${r.domain}/${r.app}/${r.key}` } } });
            }
            await this.d.rx.call("startChannel", { ch: channel });
            await this.d.rx.call("setRecording", { ch: channel, enabled: true });
        } catch (e) {
            this.log(`RTMP の枠の開始: ${errorText(e)}`);
        }
        const r = this.cfg.rtmp;
        const msgId = await this.post(s, {
            content: this.t(s.lang, "rtmp.ask", { url: `rtmp://${r.domain}/${r.app}`, key: r.key }),
            buttons: [this.btn(s, "set", "button.set", "primary"), this.btn(s, "abort", "button.abort", "danger")],
        });
        s.pending = { kind: "rtmp", askedAt: this.now(), messageId: msgId, pressed: false, reminded: false };
        await this.ops(`RTMP に案内: ${s.displayName} (${reason})`);
        this.setPhase(s, "awaitingRtmp");
    }

    private async tickPending(s: Session): Promise<void> {
        const p = s.pending;
        if (!p) return;
        const now = this.now();
        if (p.kind === "latency") {
            if (p.reconnectedAt === undefined) {
                const at = Math.max(s.rx.reconnectAt ?? 0, s.cw.reconnectAt ?? 0);
                if (at > p.askedAt) p.reconnectedAt = at;
            }
            if (p.reconnectedAt !== undefined && (p.pressed || now - p.reconnectedAt > kAssumePressedMs)) {
                s.latencyMs = p.target!;
                s.raises++;
                if (p.messageId) await this.d.chat.clearButtons(s.threadId, p.messageId).catch(() => undefined);
                s.pending = undefined;
                await this.post(s, { content: this.t(s.lang, "latency.remeasure", { latencyUs: obsLatency(s.latencyMs) }) });
                this.startMeasuring(s, Math.floor(p.reconnectedAt / 1000) + kWarmupSec);
                return;
            }
        } else {
            const rtmpCh = s.rtmp ? this.d.rx.channel(s.rtmp.channel) : undefined;
            if (rtmpCh?.status === "live") {
                if (p.messageId) await this.d.chat.clearButtons(s.threadId, p.messageId).catch(() => undefined);
                s.pending = undefined;
                s.protocol = "rtmp";
                await this.releaseSrt(s);
                await this.post(s, { content: this.t(s.lang, "rtmp.arrived") });
                s.rx.lastStatus = "live";
                this.startMeasuring(s, Math.floor(now / 1000));
                return;
            }
        }
        if (!p.reminded && now - p.askedAt > this.timeout(this.cfg.timeouts.raiseRemindMin)) {
            p.reminded = true;
            await this.post(s, { content: this.t(s.lang, p.kind === "latency" ? "latency.remind" : "rtmp.remind") });
        }
        if (now - p.askedAt > this.timeout(this.cfg.timeouts.stepAbortMin)) {
            await this.finish(s, "aborted", p.kind === "latency" ? "latency の変更を待って時間切れ" : "RTMP への切り替えを待って時間切れ");
        }
    }

    // ---- 映像の判定 (RTMP) ----

    private async tickMeasuringRtmp(s: Session, ch: ReceiverChannel | undefined): Promise<void> {
        const nowSec = Math.floor(this.now() / 1000);
        if (nowSec - (s.measureFromSec ?? nowSec) < this.cfg.judge.windowSec) return;
        const expected = this.cfg.guide.expected.fps;
        const fpsAvg = avg(s.rx.fps);
        const decodeDelta = (ch?.video?.decodeErrors ?? 0) - (s.rx.decodeErrorsBase ?? ch?.video?.decodeErrors ?? 0);
        const live = ch?.status === "live";
        s.summary.opsRttMs = ch?.tcp?.rttMs;
        if (live && (fpsAvg === undefined || fpsAvg >= expected * this.cfg.judge.minFpsRatio) && decodeDelta === 0) {
            await this.confirmed(s);
            return;
        }
        s.videoVerdict = "NG";
        await this.ops(`RTMP でも安定しません: ${s.displayName} (fps ${round1(fpsAvg) ?? "?"}、デコードエラー +${decodeDelta})。連絡してください ${this.d.chat.threadUrl(s.threadId)}`);
        await this.post(s, { content: this.t(s.lang, "rtmp.unstable") });
        await this.startChecks(s);
    }

    // ---- 音声とその他のチェック ----

    private async startChecks(s: Session): Promise<void> {
        s.checkIndex = 0;
        this.setPhase(s, "checks");
        await this.post(s, { content: this.t(s.lang, "checks.intro") });
        await this.promptStep(s);
    }

    /**
     * このテストのチェックの手順。マイクの声の録音の手順は、マイクを「使う」か「未定」と答えた人にだけ出す
     * (答えは VDO.ninja の案内を出したときに決まっていて、チェックの間は変わらない)
     */
    private stepsOf(s: Session): CheckStep[] {
        return this.checks.filter((c) => c.kind !== "micRecord" || this.micWanted(s));
    }

    private currentStep(s: Session): CheckStep | undefined {
        return this.stepsOf(s)[s.checkIndex];
    }

    private stepHeader(s: Session): string {
        return this.t(s.lang, "checks.header", { n: s.checkIndex + 1, total: this.stepsOf(s).length });
    }

    private async promptStep(s: Session): Promise<void> {
        const step = this.currentStep(s);
        if (!step) {
            await this.checksDone(s);
            return;
        }
        s.checkState = "prompt";
        s.checkPeaks = [];
        s.lastActivity = this.now();
        const header = this.stepHeader(s);
        if (step.kind === "confirm") {
            // 静止画を見て答える手順。静止画が無いとき (サムネイルが無効、RTMP) は、OBS のプレビューで確かめてもらう
            const image = await this.still(s);
            const note = image ? "" : `\n${this.t(s.lang, "checks.noImage")}`;
            await this.post(s, {
                content: `${header}\n${this.stepText(s.lang, step, "text")}${note}`,
                image: image ? { name: "stream.jpg", data: image } : undefined,
                buttons: [this.btn(s, "yes", "button.yes", "success"), this.btn(s, "no", "button.no", "danger")],
            });
            this.markCheckStart(s);
            return;
        }
        if (step.kind === "micRecord") return this.promptWebcamVoice(s, step);
        const buttons = [this.btn(s, "step-start", "button.stepStart", "primary")];
        // ゲームによっては、音を完全には消せない。その人は「音を消せない」で、できるだけ小さくした状態を測って進む
        if (step.kind === "silence") buttons.push(this.btn(s, "cannot-mute", "button.cannotMute", "secondary"));
        // 音を消せない人には、このあとの「載らない」手順で、同じ小さい音量のままにしてもらう (その音量を基準に比べる)
        const note = step.kind === "quiet" && s.cannotMute ? `\n${this.t(s.lang, "checks.cannotMuteKeep")}` : "";
        await this.post(s, { content: `${header}\n${this.stepText(s.lang, step, "text")}${note}`, buttons });
    }

    /**
     * マイクの声の録音の手順 (VDO.ninja。設計書 §7.4) を出す。本番と同じく、VDO.ninja のページから届く音声を録る。
     * ページは計測の前に開いてもらってある。閉じてしまった人が開き直せるように、送信用の URL を添える
     */
    private async promptWebcamVoice(s: Session, step: CheckStep): Promise<void> {
        const link = s.webcam ? this.cfg.vdoninja.links[s.webcam.link] : undefined;
        if (!this.d.webcam || !s.webcam || !link || s.webcam.failed) return this.voiceFailed(s, step, "VDO.ninja の受信用のページを開けません");
        if (!this.d.webcam.status(s.id)) this.d.webcam.open(s.id, link.view);
        const header = this.stepHeader(s);
        await this.post(s, {
            content: `${header}\n${this.stepText(s.lang, step, "text")}\n${this.t(s.lang, "webcam.micUrl", { url: link.push })}`,
            buttons: [this.btn(s, "step-start", "button.stepStart", "primary"), this.btn(s, "voice-skip", "button.voiceSkip", "secondary")],
        });
    }

    /** bot の側の問題で録音できない (受信用のページを開けない、録れない、など)。配信者のせいではないので、運営に知らせて次へ進める */
    private async voiceFailed(s: Session, step: CheckStep, error: string): Promise<void> {
        await this.ops(`マイクの声を録音できませんでした: ${s.displayName} (${error})`);
        await this.post(s, { content: this.t(s.lang, "voice.failed") });
        s.results = s.results.filter((x) => x.id !== step.id);
        s.results.push({ id: step.id, verdict: "unknown" });
        s.checkIndex++;
        await this.promptStep(s);
    }

    /**
     * マイクの声の録音 (設計書 §7.4)。bot のブラウザが、VDO.ninja のページに届いている音声を録る。録る間 (十数秒) は、ロックの外で待つ。
     * 終わったら、声が届いていれば次の手順へ、届いていなければ「おかしい」として直し方を出す。
     */
    private async recordVoice(sessionId: string, step: CheckStep): Promise<void> {
        const s0 = this.sessions.find((x) => x.id === sessionId);
        if (!s0) return;
        // 秒まで入れる: 録り直しが同じ分のうちに始まっても、前の録音を上書きしない (分までだと、同じ名前になる)
        const stamp = fileStamp(this.now());
        const safeName = safeFileName(s0.displayName);
        // ブラウザが録った WebM (Opus)
        const file = `${this.d.micDir ?? "."}/${stamp} ${safeName} ${s0.userId}.webm`;
        let result: VoiceRecording | undefined;
        let error: string | undefined;
        try {
            result = await this.d.webcam!.recordAudio(sessionId, file, step.seconds);
        } catch (e) {
            error = errorText(e);
        }
        await this.locked(async () => {
            this.webcamRecording.delete(sessionId);
            const s = this.sessions.find((x) => x.id === sessionId);
            // 録っている間に中断された、またはやり直された
            if (!s || s.phase !== "checks" || s.checkState !== "running" || this.currentStep(s)?.id !== step.id) return;
            if (!result) {
                await this.voiceFailed(s, step, error ?? "");
                this.save();
                return;
            }
            this.log(`マイクの録音 (${s.displayName}): ${result.file} / 声 ${result.audioMs} ms / 最大 ${result.maxDb ?? "?"} dB / 平均 ${result.meanDb ?? "?"} dB / 振り切れ ${result.clippedPct ?? "?"} %`);
            s.voice = { file: result.file, audioMs: result.audioMs, maxDb: result.maxDb, meanDb: result.meanDb, clippedPct: result.clippedPct };
            // VDO.ninja (WebRTC) は無音の間も送るので、届いたかどうかは音量で見る (測れなかったときは、届いたものとして進める)
            if (result.maxDb !== undefined && result.maxDb < kWebcamVoiceSilentDb) {
                await this.stepResult(s, step, { verdict: "ng" });
                this.save();
                return;
            }
            // どれくらいの音量で届いたかを、数字と波形の画像で返す (配信者が自分で大きさを確かめられるように)
            const notes: string[] = [];
            if (result.maxDb !== undefined && result.meanDb !== undefined) notes.push(this.t(s.lang, "voice.level", { max: result.maxDb, mean: result.meanDb }));
            if (result.waveform) notes.push(this.t(s.lang, "voice.waveform"));
            if ((result.clippedPct ?? 0) >= kVoiceClippedPct) notes.push(this.t(s.lang, "voice.clipped"));
            else if (result.meanDb !== undefined && result.meanDb < kVoiceQuietDb) notes.push(this.t(s.lang, "voice.quiet"));
            // すぐには次へ進まない: 音量を見て、配信者が自分でマイクの入力を直して録り直せるように、「録り直す」と「これでよい」を出す。
            // 録り直すと、記録に残る (シートとドライブに上がる) のは最後の録音
            notes.push(this.t(s.lang, "voice.retryHint"));
            await this.post(s, {
                content: [this.t(s.lang, "voice.recorded", { seconds: Math.round(result.audioMs / 1000) }), ...notes].join("\n"),
                image: result.waveform ? { name: "voice-waveform.png", data: result.waveform } : undefined,
                buttons: [this.btn(s, "step-retry", "button.voiceRetry", "secondary"), this.btn(s, "step-next", "button.voiceNext", "primary")],
            });
            s.results = s.results.filter((x) => x.id !== step.id);
            s.results.push({ id: step.id, verdict: "ok", value: result.meanDb });
            s.checkState = "result";
            s.lastActivity = this.now();
            this.save();
        });
    }

    private async tickChecks(s: Session, ch: ReceiverChannel | undefined): Promise<void> {
        const step = this.currentStep(s);
        if (!step) return;
        const now = this.now();
        if (s.checkState !== "running") return this.idleTimeout(s);
        const elapsed = now - (s.checkStartedAt ?? now);
        if (step.kind === "micRecord") {
            // 録音は recordVoice が進める。録音が動いていない (bot を起動し直した、いつまでも終わらない) なら、手順を出し直す
            if (!this.webcamRecording.has(s.id) || elapsed > (step.seconds + kVoiceGraceSec) * 1000) {
                this.webcamRecording.delete(s.id);
                await this.promptStep(s);
            }
            return;
        }
        if (step.kind === "reconnect") {
            const ok = (s.rx.reconnectAt ?? 0) > (s.checkStartedAt ?? now) || (s.cw.reconnectAt ?? 0) > (s.checkStartedAt ?? now);
            const live = !this.d.rx.connected() || ch?.status === "live";
            if (ok && live) return this.stepResult(s, step, { verdict: "ok" });
            if (elapsed > step.seconds * 1000 + kReconnectLiveMs) return this.stepResult(s, step, { verdict: "ng" });
            return;
        }
        // 押してから 2 秒は手を動かす時間なので使わない
        const peak = ch?.audio?.peakDb ? Math.max(ch.audio.peakDb[0], ch.audio.peakDb[1]) : undefined;
        if (peak !== undefined && elapsed >= 2_000 && ch?.status === "live") s.checkPeaks.push(peak);
        if (elapsed >= (step.seconds + 2) * 1000) {
            const r = evaluateAudioStep(step, this.d.rx.connected() ? s.checkPeaks : [], s.noiseDb, this.cfg.judge.silentDb);
            if (step.kind === "silence" && r.value !== undefined) s.noiseDb = r.value;
            // ゲームの音を消せない人: 無音にはならないので、判定はしない (測った大きさは、このあとの手順の基準として残す)
            if (step.kind === "silence" && s.cannotMute) return this.stepResult(s, step, { verdict: "unknown", value: r.value });
            return this.stepResult(s, step, r);
        }
    }

    private async stepResult(s: Session, step: CheckStep, r: { verdict: "ok" | "ng" | "unknown"; value?: number }): Promise<void> {
        const endFile = this.recFile(s);
        const rec: StepRecord = { id: step.id, verdict: r.verdict, value: r.value, recFrom: s.checkRecFrom, recTo: this.recPos(s), recFile: s.checkRecFile };
        // 手順の途中で録画ファイルが切り替わった (配信が長く途切れた): 終わりの位置は、新しいファイルの中
        if (endFile && s.checkRecFile && endFile !== s.checkRecFile) rec.recToFile = endFile;
        s.results = s.results.filter((x) => x.id !== step.id);
        s.results.push(rec);
        s.checkState = "result";
        s.lastActivity = this.now();
        if (r.verdict === "ng") {
            // 音を消せない人の「載らない」手順は、ゲームの音が大きくなっただけでも「おかしい」になる。そのことを添える
            const note = step.kind === "quiet" && s.cannotMute ? `\n${this.t(s.lang, "checks.cannotMuteNg")}` : "";
            await this.post(s, {
                content: `${this.t(s.lang, "checks.ng")}\n${this.stepText(s.lang, step, "failHint")}${note}`,
                buttons: [this.btn(s, "step-retry", "button.retry", "primary"), this.btn(s, "step-next", "button.next", "secondary")],
            });
            return;
        }
        await this.post(s, { content: this.t(s.lang, r.verdict === "ok" ? "checks.ok" : "checks.recorded") });
        s.checkIndex++;
        await this.promptStep(s);
    }

    /**
     * 配信者に見せる、手順の名前 (何を確かめた手順か)。手順の id (game-audio など) は運営向けの記録に使う名前で、
     * 配信者には意味が分かりにくい。名前は messages の steps.<id>.label。無い手順は id のまま出す
     */
    private stepLabel(s: Session, id: string): string {
        const key = `steps.${id}.label`;
        return this.d.i18n.has(key) ? this.t(s.lang, key) : id;
    }

    /**
     * 配信者に見せる、手順の結果。判定の言葉 (OK / おかしい / 記録のみ) が基本だが、配信者が自分で選んだことは、選んだとおりに書く:
     * 「マイクは使わない」を押した人に「記録のみ」と出すと、何が記録されたのか分からない
     */
    private verdictText(s: Session, r: StepRecord): string {
        const kind = this.checks.find((c) => c.id === r.id)?.kind;
        if (kind === "micRecord" && s.voice?.skipped) return this.t(s.lang, "voice.notUsed");
        if (kind === "silence" && s.cannotMute && r.verdict === "unknown") return this.t(s.lang, "checks.cannotMuteResult");
        return this.t(s.lang, `verdict.${r.verdict}`);
    }

    private async checksDone(s: Session): Promise<void> {
        const lines = s.results.map((r) => `- ${this.stepLabel(s, r.id)}: ${this.verdictText(s, r)}${r.skipped ? ` (${this.t(s.lang, "checks.skipped")})` : ""}`);
        await this.post(s, {
            content: `${this.t(s.lang, "checks.done")}\n${lines.join("\n")}`,
            buttons: [this.btn(s, "done", "button.done", "success"), this.btn(s, "abort", "button.abort", "danger")],
        });
        if (s.results.some((r) => r.skipped)) {
            await this.ops(`チェックで「おかしい」のまま進めた手順があります: ${s.displayName} (${s.results.filter((r) => r.skipped).map((r) => r.id).join(", ")})`);
        }
        this.setPhase(s, "awaitingDone");
    }

    private async idleTimeout(s: Session): Promise<void> {
        if (this.now() - s.lastActivity > this.timeout(this.cfg.timeouts.stepAbortMin)) {
            await this.finish(s, "aborted", "操作が無いまま時間切れ");
        }
    }

    // ---- ボタン ----

    private async onButton(s: Session, action: string): Promise<ButtonReply> {
        // 本番で web カメラとマイクを使うか (usage-camera-yes など)
        const usage = /^usage-(camera|mic)-(yes|maybe|no)$/.exec(action);
        if (usage) return this.onUsage(s, usage[1] as "camera" | "mic", usage[2] as UsageAnswer);
        switch (action) {
            case "started": {
                const ch = this.activeChannel(s);
                if (s.phase === "waitingStream" && ch?.status !== "live") return { ephemeral: this.t(s.lang, "wait.notYet") };
                return { ephemeral: this.t(s.lang, "button.ack") };
            }
            case "lang-ja":
            case "lang-en": {
                s.lang = action === "lang-ja" ? "ja" : "en";
                this.langPrefs[s.userId] = s.lang;
                if (s.phase === "waitingStream") {
                    const port = this.srtPort.get(s.id) ?? (await this.d.flow.describe(s.srt.flowArn)).ingestPort ?? 0;
                    await this.postGuide(s, port);
                }
                return {};
            }
            case "set": {
                if (!s.pending) return { ephemeral: this.t(s.lang, "button.ack") };
                s.pending.pressed = true;
                return { ephemeral: this.t(s.lang, s.pending.kind === "latency" ? "latency.waitRestart" : "rtmp.waitArrive") };
            }
            case "step-start": {
                if (s.phase !== "checks" || s.checkState !== "prompt") return { ephemeral: this.t(s.lang, "button.ack") };
                const step = this.currentStep(s)!;
                if (step.kind === "micRecord") {
                    if (!this.d.webcam || this.webcamRecording.has(s.id)) return { ephemeral: this.t(s.lang, "button.ack") };
                    // マイクの音声が届いているか (ページを開いていない、マイクを許可していない、なら届かない)
                    if (!this.d.webcam.status(s.id)?.audio) return { ephemeral: this.t(s.lang, "webcam.micNotYet") };
                    s.checkState = "running";
                    s.checkStartedAt = this.now();
                    this.webcamRecording.add(s.id);
                    await this.post(s, { content: this.t(s.lang, "voice.recording", { seconds: step.seconds }) });
                    void this.recordVoice(s.id, step);
                    return {};
                }
                // 「静かにする」手順を「始める」でやり直したら、音を消せる扱いに戻す
                if (step.kind === "silence") s.cannotMute = false;
                s.checkState = "running";
                s.checkStartedAt = this.now();
                this.markCheckStart(s);
                s.checkPeaks = [];
                await this.post(s, { content: this.t(s.lang, "checks.running", { seconds: step.seconds }) });
                return {};
            }
            case "cannot-mute": {
                // ゲームの音を完全には消せない人: できるだけ小さくした状態を測って、そのまま進む (設計書 §7.1)
                const step = this.currentStep(s);
                if (s.phase !== "checks" || step?.kind !== "silence" || s.checkState !== "prompt") return { ephemeral: this.t(s.lang, "button.ack") };
                s.cannotMute = true;
                s.checkState = "running";
                s.checkStartedAt = this.now();
                this.markCheckStart(s);
                s.checkPeaks = [];
                await this.post(s, { content: this.t(s.lang, "checks.cannotMuteRunning", { seconds: step.seconds }) });
                await this.ops(`ゲームの音を消せないとの申告: ${s.displayName}。音声は、録画を聞いて確かめてください`);
                return {};
            }
            case "yes":
            case "no": {
                const step = this.currentStep(s);
                if (s.phase !== "checks" || step?.kind !== "confirm" || s.checkState !== "prompt") return { ephemeral: this.t(s.lang, "button.ack") };
                await this.stepResult(s, step, { verdict: action === "yes" ? "ok" : "ng" });
                return {};
            }
            case "webcam-skip": {
                if (s.phase !== "awaitingWebcam" || !s.webcam || s.webcam.skipped) return { ephemeral: this.t(s.lang, "button.ack") };
                s.webcam.skipped = true;
                if (s.webcam.messageId) await this.d.chat.clearButtons(s.threadId, s.webcam.messageId).catch(() => undefined);
                // マイクを使うなら、ページは開いたまま、マイクの音声が届くのを待つ
                if (this.micWanted(s)) {
                    s.webcam.playingSince = undefined;
                    await this.post(s, { content: this.t(s.lang, "webcam.skippedMic") });
                    return {};
                }
                await this.closeWebcam(s);
                await this.post(s, { content: this.t(s.lang, "webcam.skipped") });
                this.startMeasuring(s, Math.floor(this.now() / 1000) + kWarmupSec);
                return {};
            }
            case "voice-skip": {
                const step = this.currentStep(s);
                if (s.phase !== "checks" || step?.kind !== "micRecord" || s.checkState !== "prompt") return { ephemeral: this.t(s.lang, "button.ack") };
                s.voice = { skipped: true };
                s.results = s.results.filter((x) => x.id !== step.id);
                s.results.push({ id: step.id, verdict: "unknown" });
                await this.post(s, { content: this.t(s.lang, "voice.skipped") });
                s.checkIndex++;
                await this.promptStep(s);
                return {};
            }
            case "step-retry": {
                if (s.phase !== "checks" || s.checkState !== "result") return { ephemeral: this.t(s.lang, "button.ack") };
                await this.promptStep(s);
                return {};
            }
            case "step-next": {
                if (s.phase !== "checks" || s.checkState !== "result") return { ephemeral: this.t(s.lang, "button.ack") };
                const step = this.currentStep(s);
                const rec = s.results.find((r) => r.id === step?.id);
                // 「おかしい」のまま進めた印。録音の手順の「次へ」は、録音できたあとにも出るので、判定が「おかしい」のときだけ付ける
                if (rec && rec.verdict === "ng") rec.skipped = true;
                s.checkIndex++;
                await this.promptStep(s);
                return {};
            }
            case "done":
                if (s.phase !== "awaitingDone") return { ephemeral: this.t(s.lang, "button.ack") };
                return { modal: { kind: "done", sessionId: s.id, lang: s.lang } };
            case "abort":
                return { modal: { kind: "abort", sessionId: s.id, lang: s.lang } };
            default:
                return { ephemeral: this.t(s.lang, "button.expired") };
        }
    }

    // ================= 終わり =================

    private async finish(s: Session, result: "done" | "aborted", reason?: string): Promise<void> {
        if (s.phase === "finished") return;
        this.webcamRecording.delete(s.id);
        // 配信者が VDO.ninja のページを開いているかもしれないか (web カメラかマイクを使う人に、案内した)
        const webcamOpen = this.vdoOpen(s);
        // 録画を書き終えてから閉じる (このあと、録画を Google ドライブに上げる)
        if (s.webcam) await this.closeWebcam(s);
        this.setPhase(s, "finished");
        if (reason) s.abortReason = reason;
        const ch = this.activeChannel(s);
        if (ch?.record?.file) this.addRecordFile(s, ch.record.file);
        await this.releaseSrt(s);
        if (s.rtmp) await this.stopChannel(s.rtmp.channel);
        this.sessions = this.sessions.filter((x) => x.id !== s.id);
        this.samples.delete(s.id);
        this.lastCwFetch.delete(s.id);
        this.srtPort.delete(s.id);

        const threadUrl = this.d.chat.threadUrl(s.threadId);
        let sheetRange: string | undefined;
        let sheetError: string | undefined;
        // 録画と録音は、このあと裏で Google ドライブに上げる (設定してあれば)。シートには、まず「アップロード待ち」と書いておく
        const uploadFiles = this.d.drive ? [...s.recordFiles, ...(s.voice?.file ? [s.voice.file] : []), ...(s.webcam?.files ?? [])] : [];
        try {
            sheetRange = await this.d.sheet.append(buildRow(s, this.checks, result, threadUrl, uploadFiles.length > 0 ? "アップロード待ち" : ""));
        } catch (e) {
            sheetError = errorText(e);
            this.log(`シート: ${sheetError}`);
        }
        if (uploadFiles.length > 0) {
            this.uploads.push({
                id: s.id,
                displayName: s.displayName,
                folderName: `配信テスト ${formatTime(s.createdAt)} ${s.displayName}`.slice(0, 100),
                files: uploadFiles,
                done: [],
                skipped: [],
                sheetCell: sheetRange ? cellInRow(sheetRange, driveColumn) : undefined,
                // denpachan が録画ファイルを閉じるのを待ってから上げる
                readyAt: this.now() + kUploadSettleMs,
                attempts: 0,
            });
            this.saveUploads();
        }
        await this.post(s, { content: this.closingMessage(s, result, webcamOpen) }).catch(() => undefined);
        try {
            await this.d.webhook.send(buildWebhookPayload({ session: s, checks: this.checks, result, threadUrl, sheetUrl: this.d.sheet.url(), sheetError }));
        } catch (e) {
            this.log(`webhook: ${errorText(e)}`);
        }
        await this.d.chat.closeThread(s.threadId).catch((e) => this.log(`スレッドを閉じる: ${errorText(e)}`));
        this.finished[s.userId] = { sessionId: s.id, sheetRange, threadUrl, at: this.now() };
        this.log(
            `テスト終了: ${s.displayName} / ${result === "done" ? "完了" : `中断 (${s.abortReason ?? "理由なし"})`} / 映像 ${s.videoVerdict ?? "未判定"} / ` +
                `シート ${sheetRange ?? `書けませんでした (${sheetError ?? "?"})`}`,
        );
    }

    private closingMessage(s: Session, result: "done" | "aborted", webcamOpen: boolean): string {
        const lines = [this.t(s.lang, result === "done" ? "finish.summaryTitle" : "finish.abortedTitle")];
        lines.push(this.t(s.lang, "finish.protocol", { protocol: s.protocol.toUpperCase() }));
        if (s.protocol === "srt" && s.confirmedLatencyMs) lines.push(this.t(s.lang, "finish.latency", { latencyUs: obsLatency(s.confirmedLatencyMs) }));
        for (const r of s.results) {
            const range = r.recFrom !== undefined ? ` ${formatRecPos(r.recFrom)}-${formatRecPos(r.recTo)}` : "";
            lines.push(`- ${this.stepLabel(s, r.id)}: ${this.verdictText(s, r)}${range}`);
        }
        // 案内した URL (配信、web カメラ) は配信テスト用。本番では、本番のときに送る URL を使ってもらう
        lines.push(this.t(s.lang, "finish.testUrls"));
        // カメラのページを開いたままにすると、同じ URL を使う次の人のテストに、この人の映像が届いてしまう
        if (webcamOpen) lines.push(this.t(s.lang, "finish.webcamClose"));
        lines.push(this.t(s.lang, "finish.bye"));
        return lines.join("\n");
    }

    /** SRT の枠を空ける: 録画とチャンネルを止め、bot が開始したフローなら止める */
    private async releaseSrt(s: Session): Promise<void> {
        if (s.srt.released) return;
        s.srt.released = true;
        const ch = this.d.rx.channel(s.srt.channel);
        if (ch?.record?.file) this.addRecordFile(s, ch.record.file);
        await this.stopChannel(s.srt.channel);
        if (s.srt.startedFlow) {
            await this.d.flow.stop(s.srt.flowArn).catch((e) => this.log(`StopFlow: ${errorText(e)}`));
        }
    }

    private async stopChannel(channel: number): Promise<void> {
        await this.d.rx.call("setRecording", { ch: channel, enabled: false }).catch((e) => this.log(`setRecording: ${errorText(e)}`));
        await this.d.rx.call("stopChannel", { ch: channel }).catch((e) => this.log(`stopChannel: ${errorText(e)}`));
    }

    // ================= 枠の検証 (§5.6) =================

    /** srtIndex は、設定し直す SRT の枠 (0 始まり。kind が rtmp のときは使わない) */
    private async validateSlot(kind: "srt" | "rtmp", channel: number, flowName: string | undefined, srtIndex: number): Promise<string[]> {
        const problems: string[] = [];
        if (!this.d.rx.connected()) return ["denpachan の受信口に繋がっていません"];
        const ch = this.d.rx.channel(channel);
        if (!ch) return [`denpachan に ch${channel} がありません`];
        if (!ch.testSlot) problems.push(`ch${channel} に「配信テスト用」の印がありません`);
        // ほかの枠と、ほかの枠で進行中のテストが使っているチャンネル・フローは使えない (同じものを 2 人に使わせない)
        const isOther = (i: number) => kind === "rtmp" || i !== srtIndex;
        this.slots.srt.forEach((slot, i) => {
            if (!isOther(i)) return;
            if (slot.channel === channel) problems.push(`ch${channel} は ${this.srtSlotLabel(i)}で使っています`);
            if (kind === "srt" && slot.flow !== undefined && slot.flow === flowName) problems.push(`フロー ${flowName} は ${this.srtSlotLabel(i)}で使っています`);
        });
        if (kind === "srt" && this.slots.rtmp.channel === channel) problems.push(`ch${channel} は RTMP の枠で使っています`);
        for (const s of this.sessions) {
            if (s.protocol !== "srt" || s.srt.released || !isOther(s.srt.slot)) continue;
            if (s.srt.channel === channel && this.slots.srt[s.srt.slot]?.channel !== channel) problems.push(`ch${channel} は ${s.displayName} のテストで使っています`);
            if (kind === "srt" && s.srt.flowName === flowName && this.slots.srt[s.srt.slot]?.flow !== flowName) problems.push(`フロー ${flowName} は ${s.displayName} のテストで使っています`);
        }
        const usedBySession = this.sessions.some((s) => (s.srt.channel === channel && !s.srt.released) || s.rtmp?.channel === channel);
        if (ch.status !== "stopped" && !usedBySession) problems.push(`ch${channel} が止まっていません (${ch.status})`);
        // bot が受信の設定を入れるなら、今の方式は問わない (テストを始めるときに入れ直す)
        const configure = this.cfg.denpachan.configure;
        if (configure && !this.d.rx.canConfigure()) problems.push(this.cannotConfigure());
        if (!configure && kind === "srt" && ch.source.protocol !== "srt") problems.push(`ch${channel} の受信が SRT ではありません (${ch.source.protocol})`);
        if (!configure && kind === "rtmp" && (ch.source.protocol !== "rtmp" || ch.source.mode !== "pull")) {
            problems.push(`ch${channel} の受信が RTMP の pull ではありません (${ch.source.protocol} ${ch.source.mode})`);
        }
        if (kind === "srt") {
            const f = this.cfg.flows.find((x) => x.name === flowName);
            if (!f) return [...problems, `フローの組 "${flowName}" が設定にありません`];
            try {
                const info = await this.d.flow.describe(f.arn);
                if (info.protocol && info.protocol !== "srt-listener") problems.push(`フローの source が SRT listener ではありません (${info.protocol})`);
                if (info.minLatencyMs !== undefined && info.minLatencyMs > this.cfg.latency.initialMs) {
                    // MinLatency は AWS の画面では ms なので、その値も添える
                    problems.push(
                        `フローの MinLatency (${obsLatency(info.minLatencyMs)} μs。AWS の画面では ${info.minLatencyMs} ms) が案内の初期値 (${obsLatency(this.cfg.latency.initialMs)} μs) より大きい`,
                    );
                }
                if (info.status === "ACTIVE" && info.ingestIp) {
                    const domainProblem = await this.domainProblem(f.domain, info.ingestIp);
                    if (domainProblem) problems.push(domainProblem);
                }
            } catch (e) {
                problems.push(`フローを読めません: ${errorText(e)}`);
            }
        } else {
            try {
                const ips = await this.d.dns.resolve(this.cfg.rtmp.domain);
                if (ips.length === 0) problems.push(`RTMP サーバのドメイン ${this.cfg.rtmp.domain} に A レコードがありません`);
            } catch (e) {
                problems.push(`RTMP サーバのドメイン ${this.cfg.rtmp.domain} を引けません (${errorText(e)})`);
            }
        }
        return problems;
    }

    /**
     * 配信用のドメインが、フローの ingest の IP を指しているかを確かめる。合っていれば undefined、合わなければ理由。
     * 「引けなかった」(bot の側の DNS の問題かもしれない) と「別の IP を指している」(ドメインの設定の問題) を分けて伝える。
     */
    private async domainProblem(domain: string, ingestIp: string): Promise<string | undefined> {
        let ips: string[];
        try {
            ips = await this.d.dns.resolve(domain);
        } catch (e) {
            return `ドメイン ${domain} を引けません (${errorText(e)})。ドメインの設定ではなく、bot を動かしている PC の DNS の問題かもしれません`;
        }
        if (ips.includes(ingestIp)) return undefined;
        return `ドメイン ${domain} がこのフローの ingest の IP (${ingestIp}) を指していません (引いた結果: ${ips.join(", ") || "なし"})`;
    }

    // ================= 小物 =================

    private describeSession(s: Session): string {
        const a = s.lastAdvice;
        const step = this.currentStep(s);
        return [
            `${s.displayName}: ${s.phase}${s.phase === "checks" && step ? ` (${step.id})` : ""} / ${s.protocol.toUpperCase()} / latency ${obsLatency(s.latencyMs)} μs / 上げた回数 ${s.raises}`,
            ...(s.usage ? [`使うもの: ${describeUsage(s)}`] : []),
            ...(s.webcam ? [`web カメラ: ${describeWebcam(s)}`] : []),
            a ? `推奨 ${a.recommendMs ? `${obsLatency(a.recommendMs)} μs` : "計測中"} / RTT 最大 ${a.rttMs} ms / ロス ${a.lossPct}% / 回復できなかった ${a.drops} / 判定 ${a.verdict}` : "計測前",
            this.d.chat.threadUrl(s.threadId),
        ].join("\n");
    }

    private updateSummary(s: Session, w: SrtSample[], advice: Advice, ch: ReceiverChannel | undefined): void {
        const m = s.summary;
        if (advice.recommendMs) m.recommendMs = advice.recommendMs;
        m.rttMaxMs = Math.max(m.rttMaxMs ?? 0, advice.rttMs);
        m.lossPct = advice.lossPct;
        m.drops = (m.drops ?? 0) + advice.drops;
        const jit = w.map((x) => x.jitterMs ?? 0);
        if (jit.length > 0) m.jitterMaxMs = Math.max(m.jitterMaxMs ?? 0, ...jit);
        const br = avg(w.map((x) => x.bitrateBps ?? 0).filter((x) => x > 0));
        if (br !== undefined) m.bitrateKbps = Math.round(br / 1000);
        if (ch?.latency) {
            m.opsRttMs = ch.latency.rttMs;
            m.opsDrops = ch.latency.drops;
        }
    }

    private recPos(s: Session): number | undefined {
        const rec = this.activeChannel(s)?.record;
        const pos = rec?.state === "recording" ? recordingPosition(rec) : undefined;
        if (pos !== undefined) return pos;
        return s.recordStartAt ? (this.now() - s.recordStartAt) / 1000 : undefined;
    }

    /** いま書いている録画ファイル (録画していなければ undefined) */
    private recFile(s: Session): string | undefined {
        const rec = this.activeChannel(s)?.record;
        return rec?.state === "recording" && rec.file ? rec.file : undefined;
    }

    /** チェックの手順の始まり: 録画の中の位置と、そのときの録画ファイルを覚える */
    private markCheckStart(s: Session): void {
        s.checkRecFrom = this.recPos(s);
        s.checkRecFile = this.recFile(s);
    }

    private addRecordFile(s: Session, file: string): void {
        if (!s.recordFiles.includes(file)) s.recordFiles.push(file);
    }

    private setPhase(s: Session, phase: Phase): void {
        if (s.phase !== phase) this.log(`${s.displayName}: ${s.phase} → ${phase}`);
        s.phase = phase;
        s.phaseSince = this.now();
        s.lastActivity = this.now();
        s.reminded = false;
    }

    /** 待っている人がいれば半分にする (枠が 1 つなので) */
    private timeout(minutes: number): number {
        const half = this.cfg.timeouts.halveWhenQueued && this.queue.entries.length > 0;
        return (minutes * 60_000) / (half ? 2 : 1);
    }

    private btn(s: Session, action: string, labelKey: string, style: Button["style"]): Button {
        return { id: `tc:${s.id}:${action}`, label: this.t(s.lang, labelKey), style };
    }

    /** スレッドに書く。何を書いたかは、コンソールにも 1 行で出す (Discord を見なくても進み具合が分かるように) */
    private async post(s: Session, msg: OutMessage): Promise<string> {
        const buttons = msg.buttons?.length ? ` [${msg.buttons.map((b) => b.label).join(" | ")}]` : "";
        this.log(`スレッド (${s.displayName}): ${oneLine(msg.content)}${buttons}${msg.image ? " (画像付き)" : ""}`);
        try {
            return await this.d.chat.post(s.threadId, msg);
        } catch (e) {
            this.log(`スレッド (${s.displayName}) に書けませんでした: ${errorText(e)}`);
            throw e;
        }
    }

    /**
     * 運営への通知。同じ内容をコンソールにも出す。送れなくてもテストは止めない
     * (通知のチャンネルの ID や権限の間違いで、テストが途中で止まらないように)。
     * 通知のチャンネル (discord.opsChannelId) が未設定なら送らない (コンソールにだけ出る)。
     */
    private async ops(text: string): Promise<void> {
        this.log(`運営への通知: ${oneLine(text)}`);
        if (!this.cfg.discord.opsChannelId) return;
        try {
            await this.d.chat.ops(text);
        } catch (e) {
            this.log(`運営への通知を送れませんでした (discord.opsChannelId と bot の権限を確かめてください): ${errorText(e)}`);
        }
    }

    private t(lang: Lang, key: string, vars: Record<string, string | number> = {}): string {
        return this.d.i18n.t(lang, key, vars);
    }

    /** 手順の指示 (text) か直し方 (failHint)。messages の steps.<id> から引き、{seconds} に手順の秒数を入れる */
    private stepText(lang: Lang, step: CheckStep, field: "text" | "failHint"): string {
        return this.t(lang, stepTextKeys(step)[field], { seconds: step.seconds });
    }

    private now(): number {
        return this.d.clock.now();
    }

    private log(msg: string): void {
        (this.d.log ?? console.error)(msg);
    }

    private save(): void {
        this.d.store.set("sessions", this.sessions);
        this.d.store.set("queue", this.queue);
        this.d.store.set("slots", this.slots);
        this.d.store.set("slotsConfig", this.slotsConfig);
        this.d.store.set("langPrefs", this.langPrefs);
        this.d.store.set("finished", this.finished);
    }

    /** 操作を 1 つずつ順に行う (tick と Discord の操作が混ざらないように) */
    private locked<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.chain.then(fn, fn);
        this.chain = run.catch(() => undefined);
        return run;
    }
}

/** ファイル名に入れる日時 (秒まで。同じ分のうちに作り直しても、前のファイルを上書きしない) */
function fileStamp(ms: number): string {
    return `${formatTime(ms).replace(/[: ]/g, "-")}-${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
}

/** ファイル名に入れる表示名 (使えない文字を _ にする) */
function safeFileName(name: string): string {
    return name.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 40);
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function avg(xs: number[]): number | undefined {
    return xs.length === 0 ? undefined : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sum(xs: number[]): number {
    return xs.reduce((a, b) => a + b, 0);
}

/**
 * 録画の「今」が、録画ファイルのどこにあたるか (秒)。手順の録画の区間と、静止画を取る位置に使う。
 *
 * denpachan の record.position (録画ファイルの中の位置) を使う。record.seconds は録画を始めてからの実時間で、配信が途切れた
 * 時間 (OBS の配信を始め直すと 10 秒ほど) はファイルに入らないので、途切れたあとはその分だけファイルより先を指す。
 * position を出さない版の denpachan のときだけ seconds で代える
 */
export function recordingPosition(rec: ReceiverChannel["record"]): number | undefined {
    return rec?.position ?? rec?.seconds;
}

function round1(v: number | undefined): number | undefined {
    return v === undefined ? undefined : Math.round(v * 10) / 10;
}

export function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** フローのサムネイルを取れなかった理由 (録画から取れなかったときの、予備の方法) */
function thumbnailReason(e: unknown): string {
    const text = errorText(e);
    return /ThumbnailState/i.test(text) ? "フローのサムネイルも無効です (録画から取れないときの予備。使うなら MediaConnect のフローで ThumbnailState を有効にします)" : `フローのサムネイル: ${text}`;
}

/** 受信の設定をログ用に書く (パスフレーズそのものは出さない) */
function describeSource(source: Record<string, string | number>): string {
    return `${source.protocol} ${source.mode} ${source.host}:${source.port}${source.passphrase ? "、パスフレーズあり" : ""}`;
}

/** ログ用に 1 行にする (改行は " / " にし、長すぎるものは切る) */
export function oneLine(text: string, max = 200): string {
    const s = text.replace(/\s*\n\s*/g, " / ").trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
