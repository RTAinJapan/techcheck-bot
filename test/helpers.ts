// 試験用の偽物。外の口 (ports.ts) を置き換え、時計を進めながら tick() を回す。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SrtSample } from "../src/advisor.js";
import { parseConfig, type Config } from "../src/config.js";
import { I18n, flatten } from "../src/i18n.js";
import type {
    ChatPort,
    Clock,
    DnsPort,
    DrivePort,
    FlowInfo,
    FlowMetadata,
    FlowPort,
    OutMessage,
    ReceiverChannel,
    ReceiverPort,
    SheetPort,
    StillPort,
    VoiceRecording,
    WebcamPort,
    WebcamStatus,
    WebhookPort,
} from "../src/ports.js";
import { TechcheckService } from "../src/service.js";
import { MemoryStore } from "../src/store.js";

export const here = dirname(fileURLToPath(import.meta.url));
export const messagesDir = join(here, "..", "messages");

/** messages/*.yaml に、キーを足した文言 (設定の checks に足した手順の文言など)。extra は "a.b.c" のキーで、両方の言語に同じ値を入れる */
export function messagesWith(extra: Record<string, string>): I18n {
    const read = (l: "ja" | "en") => ({ ...flatten(parseYaml(readFileSync(join(messagesDir, `${l}.yaml`), "utf8"))), ...extra });
    return new I18n({ ja: read("ja"), en: read("en") });
}

export const baseYaml = `
discord:
  token: t
  guildId: g
  techcheckChannelId: C-test
  staffRoleId: R-staff
  opsChannelId: C-ops
notify:
  webhookUrl: https://discord.com/api/webhooks/1/x
aws:
  region: ap-northeast-1
flows:
  - name: flow-a
    arn: arn:flow-a
    domain: srt-a.example.jp
    passphrase: pass-a
rtmp:
  domain: rtmp.example.jp
  app: live
  key: key-1
slots:
  srt: { flow: flow-a, channel: 7 }
  rtmp: { channel: 8 }
google:
  credentialsFile: none.json
  sheet: { spreadsheetId: sheet-1 }
guide:
  obsProfile: RTA 2026
`;

/** SRT の枠が 2 つ (flow-a / ch7 と flow-b / ch6) の設定 */
export const twoSlotsYaml = baseYaml
    .replace("    passphrase: pass-a\n", "    passphrase: pass-a\n  - name: flow-b\n    arn: arn:flow-b\n    domain: srt-b.example.jp\n    passphrase: pass-b\n")
    .replace("  srt: { flow: flow-a, channel: 7 }\n", "  srt:\n    - { flow: flow-a, channel: 7 }\n    - { flow: flow-b, channel: 6 }\n");

/** 録画と録音を Google ドライブに上げる設定にしたもの */
export const driveYaml = baseYaml.replace("  sheet: { spreadsheetId: sheet-1 }\n", "  sheet: { spreadsheetId: sheet-1 }\n  drive: { folderId: ROOT }\n");

export function testConfig(extra = "", base = baseYaml): Config {
    return parseConfig(base + extra, {});
}

export class FakeClock implements Clock {
    t = Date.UTC(2026, 10, 1, 3, 0, 0);
    now(): number {
        return this.t;
    }
}

export class FakeFlow implements FlowPort {
    status = "STANDBY";
    ingestIp = "203.0.113.10";
    ingestPort = 5000;
    minLatencyMs = 100;
    started = 0;
    stopped = 0;
    /** t (epoch 秒) から 1 秒分のメトリクスを作る。undefined なら CloudWatch にまだ無い */
    sampleAt: (t: number) => SrtSample | undefined = () => undefined;
    meta: FlowMetadata | undefined = { width: 1536, height: 864, fps: 60, codec: "h264", hasAudio: true };

    /** フローの出力 (どのフローも同じ)。main は vMix 用、sub は denpachan 用のつもり */
    outputs: FlowInfo["outputs"] = [
        { name: "main", protocol: "srt-listener", listenerAddress: "203.0.113.10", port: 30000 },
        { name: "sub", protocol: "srt-listener", listenerAddress: "203.0.113.10", port: 30001 },
    ];

    async describe(arn: string): Promise<FlowInfo> {
        return {
            arn,
            status: this.status,
            ingestIp: this.ingestIp,
            ingestPort: this.ingestPort,
            protocol: "srt-listener",
            minLatencyMs: this.minLatencyMs,
            outputs: this.outputs,
        };
    }
    async start(): Promise<void> {
        this.started++;
        this.status = "ACTIVE";
    }
    async stop(): Promise<void> {
        this.stopped++;
        this.status = "STANDBY";
    }
    async metrics(_arn: string, fromSec: number, toSec: number): Promise<SrtSample[]> {
        const out: SrtSample[] = [];
        for (let t = fromSec; t < toSec; t++) {
            const s = this.sampleAt(t);
            if (s) out.push(s);
        }
        return out;
    }
    async metadata(): Promise<FlowMetadata | undefined> {
        return this.meta;
    }
    async thumbnail(): Promise<Buffer | undefined> {
        return Buffer.from("jpeg");
    }
}

export class FakeRx implements ReceiverPort {
    up = true;
    calls: { method: string; params: Record<string, unknown> }[] = [];
    channels = new Map<number, ReceiverChannel>();

    constructor() {
        for (const [ch, protocol, mode] of [
            [6, "srt", "caller"],
            [7, "srt", "caller"],
            [8, "rtmp", "pull"],
        ] as const) {
            this.channels.set(ch, { ch, name: `CH${ch}`, enabled: false, testSlot: true, status: "stopped", source: { protocol, mode } });
        }
    }
    connected(): boolean {
        return this.up;
    }
    channel(ch: number): ReceiverChannel | undefined {
        return this.up ? this.channels.get(ch) : undefined;
    }
    /** 受信の設定の変更を許しているか (denpachan の allowConfigure) */
    configurable = true;
    canConfigure(): boolean {
        return this.up && this.configurable;
    }
    async call(method: string, params: Record<string, unknown>): Promise<unknown> {
        this.calls.push({ method, params });
        const c = this.channels.get(params.ch as number);
        if (!c) throw new Error("no channel");
        if (method === "patchChannel") {
            const source = (params.patch as { source?: Record<string, unknown> }).source ?? {};
            const onlyLatency = Object.keys(source).every((k) => k === "latencyMs");
            if (!onlyLatency && !this.configurable) throw new Error("only name and source.latencyMs can be changed (metrics.allowConfigure is off)");
            if (typeof source.protocol === "string") c.source.protocol = source.protocol;
            if (typeof source.mode === "string") c.source.mode = source.mode;
        }
        if (method === "startChannel") {
            c.enabled = true;
            c.status = c.source.protocol === "srt" ? "connecting" : "listening";
        }
        if (method === "stopChannel") {
            c.enabled = false;
            c.status = "stopped";
        }
        if (method === "setRecording") {
            c.record = params.enabled ? { state: "recording", file: `rec-ch${c.ch}.mkv`, seconds: 0, ...(this.hasPosition ? { position: 0 } : {}) } : { state: "off" };
        }
        return {};
    }
    /** 配信が届いている状態にする */
    live(ch: number, opts: { fps?: number; peak?: number; decodeErrors?: number } = {}): void {
        const c = this.channels.get(ch)!;
        c.status = "live";
        c.source.connectedSec = (c.source.connectedSec ?? 0) + 1;
        c.video = { width: 1920, height: 1080, fps: opts.fps ?? 60, codec: "h264", decodeErrors: opts.decodeErrors ?? c.video?.decodeErrors ?? 0 };
        const p = opts.peak ?? -20;
        c.audio = { peakDb: [p, p], gaps: 0, silentSec: p < -60 ? (c.audio?.silentSec ?? 0) + 1 : 0 };
        c.latency = { rttMs: 3, drops: 0, verdict: "ok" };
        this.recordTick(c, true);
    }
    /** 配信が届いていない状態にする (1 回が 1 秒) */
    drop(ch: number): void {
        const c = this.channels.get(ch)!;
        c.status = c.source.protocol === "srt" ? "connecting" : "listening";
        c.source.connectedSec = 0;
        this.recordTick(c, false);
    }
    /** record.position (録画ファイルの中の位置) を出すか。false は、出さない版の denpachan */
    hasPosition = true;
    /**
     * 録画を 1 秒進める。denpachan と同じく、seconds (録画を始めてからの実時間) は配信が届いていなくても進み、
     * position (録画ファイルの中の位置) は届いた分だけ進む (途切れた時間はファイルに入らない)
     */
    private recordTick(c: ReceiverChannel, written: boolean): void {
        if (c.record?.state !== "recording") return;
        c.record.seconds = (c.record.seconds ?? 0) + 1;
        if (written && c.record.position !== undefined) c.record.position += 1;
    }
}

export interface Posted {
    threadId: string;
    msg: OutMessage;
}

export class FakeChat implements ChatPort {
    threads: { id: string; name: string; userId: string; closed: boolean }[] = [];
    posts: Posted[] = [];
    /** 待ちの列の知らせ。msg は配信テストのチャンネルに書くもの、dm は DM の文 */
    called: { userId: string; msg: OutMessage; dm: string }[] = [];
    opsLog: string[] = [];
    cleared: string[] = [];
    private n = 0;

    async createThread(name: string, userId: string): Promise<string> {
        const id = `T${++this.n}`;
        this.threads.push({ id, name, userId, closed: false });
        return id;
    }
    async post(threadId: string, msg: OutMessage): Promise<string> {
        this.posts.push({ threadId, msg });
        return `M${this.posts.length}`;
    }
    async clearButtons(_t: string, messageId: string): Promise<void> {
        this.cleared.push(messageId);
    }
    /** 書き換えたメッセージ (id → 最後の中身)。posts の中身も書き換える (最後の状態を見られるように) */
    edited = new Map<string, OutMessage>();
    async editMessage(_t: string, messageId: string, msg: OutMessage): Promise<void> {
        this.edited.set(messageId, msg);
        const p = this.posts[Number(messageId.slice(1)) - 1];
        if (p) p.msg = msg;
    }
    async closeThread(threadId: string): Promise<void> {
        this.threads.find((t) => t.id === threadId)!.closed = true;
    }
    threadUrl(threadId: string): string {
        return `https://discord.com/channels/g/${threadId}`;
    }
    async callUser(userId: string, msg: OutMessage, dm: string): Promise<void> {
        this.called.push({ userId, msg, dm });
    }
    async ops(text: string): Promise<void> {
        this.opsLog.push(text);
    }
    lastPost(threadId?: string): OutMessage | undefined {
        const list = threadId ? this.posts.filter((p) => p.threadId === threadId) : this.posts;
        return list[list.length - 1]?.msg;
    }
    texts(threadId: string): string[] {
        return this.posts.filter((p) => p.threadId === threadId).map((p) => p.msg.content);
    }
    /** スレッドに最後に出たボタンの id (action で探す) */
    buttonId(threadId: string, action: string): string {
        for (const p of [...this.posts].reverse()) {
            if (p.threadId !== threadId) continue;
            const b = p.msg.buttons?.find((x) => x.id.endsWith(`:${action}`));
            if (b) return b.id;
        }
        throw new Error(`button ${action} not found`);
    }
}

export class FakeSheet implements SheetPort {
    rows: (string | number)[][] = [];
    updates: { range: string; values: (string | number)[] }[] = [];
    fail = false;
    async append(row: (string | number)[]): Promise<string> {
        if (this.fail) throw new Error("sheet down");
        this.rows.push(row);
        return `techcheck!A${this.rows.length + 1}:AF${this.rows.length + 1}`;
    }
    async update(range: string, values: (string | number)[]): Promise<void> {
        this.updates.push({ range, values });
    }
    url(): string {
        return "https://docs.google.com/spreadsheets/d/sheet-1";
    }
}

export class FakeWebhook implements WebhookPort {
    sent: unknown[] = [];
    async send(payload: unknown): Promise<void> {
        this.sent.push(payload);
    }
}

export class FakeDrive implements DrivePort {
    folders: { id: string; name: string }[] = [];
    uploaded: { file: string; folderId: string }[] = [];
    /** 設定すると、アップロードはこの理由で失敗する */
    error: string | undefined;
    /** ローカルに無いことにするファイル */
    missing: string[] = [];
    async createFolder(name: string): Promise<string> {
        if (this.error) throw new Error(this.error);
        const id = `F${this.folders.length + 1}`;
        this.folders.push({ id, name });
        return id;
    }
    async upload(file: string, folderId: string): Promise<void> {
        if (this.missing.includes(file)) throw Object.assign(new Error(`ENOENT: no such file, stat '${file}'`), { code: "ENOENT" });
        if (this.error) throw new Error(this.error);
        this.uploaded.push({ file, folderId });
    }
    folderUrl(folderId: string): string {
        return `https://drive.google.com/drive/folders/${folderId}`;
    }
}

export class FakeStill implements StillPort {
    calls: { file: string; atSec: number }[] = [];
    /** 設定すると、録画から取り出せないことにする */
    error: string | undefined;
    async fromRecording(file: string, atSec: number): Promise<Buffer> {
        this.calls.push({ file, atSec });
        if (this.error) throw new Error(this.error);
        return Buffer.from(`still of ${file}`);
    }
}

/** VDO.ninja の URL の組を 1 つ書いた設定 */
export const webcamYaml = `
vdoninja:
  links:
    - { push: "https://vdo.ninja/?push=cam1", view: "https://vdo.ninja/?view=cam1" }
`;

export class FakeWebcam implements WebcamPort {
    /** 開いているページ (テストの ID → 受信用の URL と状態) */
    views = new Map<string, { url: string; status: WebcamStatus }>();
    opened: string[] = [];
    closed: string[] = [];
    /** 設定すると、ページを開けないことにする */
    error: string | undefined;
    open(key: string, viewUrl: string): void {
        this.opened.push(viewUrl);
        this.views.set(key, { url: viewUrl, status: this.error ? { state: "error", error: this.error, playing: false } : { state: "open", playing: false } });
    }
    status(key: string): WebcamStatus | undefined {
        return this.views.get(key)?.status;
    }
    async still(key: string): Promise<Buffer | undefined> {
        return this.views.get(key)?.status.playing ? Buffer.from("webcam still") : undefined;
    }
    /** 次の録音の結果 */
    nextAudio: Partial<VoiceRecording> = { audioMs: 15_000, maxDb: -6, meanDb: -24, clippedPct: 0, waveform: Buffer.from("waveform") };
    recorded: { key: string; file: string; seconds: number }[] = [];
    async recordAudio(key: string, file: string, seconds: number): Promise<VoiceRecording> {
        this.recorded.push({ key, file, seconds });
        if (!this.views.get(key)?.status.audio) throw new Error("音声 (マイク) が届いていません");
        return { file, audioMs: 0, ...this.nextAudio };
    }
    /** 録画のファイル名のもと (テストの ID → base) */
    recordBases = new Map<string, string>();
    startRecording(key: string, base: string): void {
        const v = this.views.get(key);
        if (!v || this.recordBases.has(key)) return;
        this.recordBases.set(key, base);
        v.status = { ...v.status, recording: true, recordFiles: [`${base}.webm`] };
    }
    async close(key: string): Promise<string[]> {
        const v = this.views.get(key);
        if (!this.views.delete(key)) return [];
        this.closed.push(key);
        const base = this.recordBases.get(key);
        this.recordBases.delete(key);
        return base ? [...(v?.status.recordFiles ?? [`${base}.webm`])] : [];
    }
    /** その URL を見ているページに、映像が届いている (届いていない) 状態にする */
    play(viewUrl: string, stats: Partial<WebcamStatus> = {}): void {
        for (const v of this.views.values()) {
            if (v.url === viewUrl) v.status = { ...v.status, state: "open", playing: true, width: 1280, height: 720, fps: 30, packetsReceived: 1000, packetsLost: 0, freezes: 0, ...stats };
        }
    }
    stopPlaying(viewUrl: string): void {
        for (const v of this.views.values()) if (v.url === viewUrl) v.status = { ...v.status, playing: false };
    }
}

export class FakeDns implements DnsPort {
    answers: Record<string, string[]> = { "srt-a.example.jp": ["203.0.113.10"], "srt-b.example.jp": ["203.0.113.10"], "rtmp.example.jp": ["198.51.100.1"] };
    async resolve(domain: string): Promise<string[]> {
        const a = this.answers[domain];
        if (!a) throw new Error("NXDOMAIN");
        return a;
    }
}

/**
 * existingStore を渡すと、前の世界の保存を引き継ぐ (bot を起動し直したことにする)。
 * i18n を渡すと、messages/*.yaml の代わりにその文言を使う (messagesWith)
 */
export function makeWorld(extraYaml = "", baseYamlText = baseYaml, existingStore?: MemoryStore, i18n?: I18n) {
    const config = testConfig(extraYaml, baseYamlText);
    const clock = new FakeClock();
    const flow = new FakeFlow();
    const rx = new FakeRx();
    const still = new FakeStill();
    const drive = new FakeDrive();
    const webcam = new FakeWebcam();
    const chat = new FakeChat();
    const sheet = new FakeSheet();
    const webhook = new FakeWebhook();
    const dns = new FakeDns();
    const store = existingStore ?? new MemoryStore();
    const logs: string[] = [];
    const service = new TechcheckService({
        config,
        i18n: i18n ?? I18n.load(messagesDir),
        store,
        flow,
        rx,
        still,
        micDir: "voice-dir",
        vdoninjaDir: "webcam-dir",
        webcam: config.vdoninja.links.length > 0 ? webcam : undefined,
        drive: config.google.drive.folderId ? drive : undefined,
        dns,
        chat,
        sheet,
        webhook,
        clock,
        log: (m) => logs.push(m),
        sleep: async () => {
            clock.t += 5_000;
        },
    });
    /** 非同期の準備 (prepare) が進むよう、いくつか待つ */
    const flush = async () => {
        for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    };
    /** 1 秒ずつ進めて tick する。each で毎秒の状態を作る */
    const run = async (seconds: number, each?: (t: number) => void) => {
        for (let i = 0; i < seconds; i++) {
            clock.t += 1_000;
            each?.(Math.floor(clock.t / 1000));
            await service.tick();
            await flush();
        }
    };
    return { config, clock, flow, rx, still, drive, webcam, chat, sheet, webhook, dns, store, service, logs, flush, run };
}

export type World = ReturnType<typeof makeWorld>;

/** よい回線のメトリクス (RTT 20 ms、ロスなし) */
export function goodSample(t: number): SrtSample {
    return { t, connected: true, rttMs: 20, lossPct: 0, totalPackets: 500, notRecovered: 0, continuityErrors: 0, tsSyncLoss: 0, jitterMs: 5, bitrateBps: 6_000_000, upTimeSec: t };
}
