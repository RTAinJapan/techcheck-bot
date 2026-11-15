// bot の外とのやりとりの口。本物 (src/adapters/、src/discord/) と試験用の偽物を差し替えられるようにする。

import type { SrtSample } from "./advisor.js";

// ---- MediaConnect / CloudWatch ----

export interface FlowInfo {
    arn: string;
    /** ACTIVE / STANDBY / STARTING / STOPPING / UPDATING / ERROR */
    status: string;
    ingestIp?: string;
    ingestPort?: number;
    /** source のプロトコル (srt-listener など) */
    protocol?: string;
    minLatencyMs?: number;
    /** フローの出力。denpachan に受信の設定を入れるときに、接続先を読む */
    outputs?: FlowOutput[];
}

export interface FlowOutput {
    name: string;
    /** srt-listener (denpachan が繋ぎに行く) / srt-caller (MediaConnect が denpachan へ繋ぎに来る) など */
    protocol?: string;
    /** srt-listener のとき: 繋ぎに行く先のアドレス */
    listenerAddress?: string;
    /** srt-listener のとき: 繋ぎに行く先のポート。srt-caller のとき: MediaConnect が繋ぎに来るポート */
    port?: number;
}

export interface FlowMetadata {
    width?: number;
    height?: number;
    fps?: number;
    codec?: string;
    hasAudio: boolean;
}

export interface FlowPort {
    describe(arn: string): Promise<FlowInfo>;
    start(arn: string): Promise<void>;
    stop(arn: string): Promise<void>;
    /** [fromSec, toSec) の 1 秒ごとのメトリクス (t は epoch 秒) */
    metrics(arn: string, fromSec: number, toSec: number): Promise<SrtSample[]>;
    metadata(arn: string): Promise<FlowMetadata | undefined>;
    thumbnail(arn: string): Promise<Buffer | undefined>;
}

// ---- denpachan のメトリクスの受信口 (設計書 §3.2 の channels メッセージ) ----

export interface ReceiverChannel {
    ch: number;
    name: string;
    enabled: boolean;
    testSlot: boolean;
    status: string;
    source: { protocol: string; mode: string; peer?: string; connectedSec?: number };
    video?: { width?: number; height?: number; fps?: number; codec?: string; bitrateMbps?: number; decodeErrors?: number };
    latency?: { rttMs?: number; drops?: number; verdict?: string } | null;
    tcp?: { rttMs?: number; retransBytes?: number } | null;
    audio?: { peakDb?: [number, number]; gaps?: number; silentSec?: number };
    /**
     * 録画。seconds は録画を始めてからの実時間、position は録画ファイルの中の位置 (ファイルの時間軸で、最後に書いたパケットの
     * 時刻)。配信が途切れた時間はファイルに入らないので、途切れたあとは position の方が小さい。position を出さない版の
     * denpachan では undefined (recordingPosition で読む)
     */
    record?: { state?: string; file?: string; seconds?: number; position?: number };
    lastError?: string;
}

export interface ReceiverPort {
    /** 受信口に繋がっていて、最近 channels が届いているか */
    connected(): boolean;
    channel(ch: number): ReceiverChannel | undefined;
    call(method: string, params: Record<string, unknown>): Promise<unknown>;
    /** 配信テスト用のチャンネルの受信の設定を、受信口から変えられるか (denpachan の hello の allowConfigure) */
    canConfigure(): boolean;
}

// ---- 配信の静止画 ----

export interface StillPort {
    /** denpachan の録画ファイルの、録画の先頭から atSec 秒のあたりの 1 枚 (JPEG) */
    fromRecording(file: string, atSec: number): Promise<Buffer>;
}

// ---- Discord のボイスチャンネル (マイクの声の録音) ----

export interface VoiceRecording {
    file: string;
    /** 届いた音声のパケットの数。0 なら、声が届いていない (ミュート、入力デバイスの間違いなど) */
    packets: number;
    bytes: number;
    /** 届いた音の長さ (ミリ秒)。Discord は無音の間は送らないので、話していた時間に近い */
    audioMs: number;
    /** 音量 (dBFS)。ffmpeg で測れなかったときは無い */
    maxDb?: number;
    meanDb?: number;
    /** 振り切れた (0 dBFS に達した) サンプルの割合 (%)。大きいと音が割れている */
    clippedPct?: number;
    /** 録った声の波形の画像 (PNG)。配信者に音量を見せる。ffmpeg で作れなかったときは無い */
    waveform?: Buffer;
}

export interface VoiceChannelInfo {
    id: string;
    name: string;
    /** 中にいる人のユーザー ID (bot は数えない) */
    members: string[];
}

export interface VoicePort {
    /** bot が入れる VC (「チャンネルを表示」と「接続」の権限がある所) の一覧。サーバでの並びの順 */
    channels(): Promise<VoiceChannelInfo[]>;
    /** 配信者が今いる VC の ID (いなければ undefined) */
    channelOf(userId: string): Promise<string | undefined>;
    /** VC に入り、userId の声を seconds 秒録って、file (.ogg) に書く */
    record(channelId: string, userId: string, file: string, seconds: number): Promise<VoiceRecording>;
}

// ---- web カメラ (VDO.ninja の受信用のページを、bot がブラウザで開いて見る) ----

export interface WebcamStatus {
    /** opening: ページを開いている途中 / open: 開けた / error: 開けなかった (bot の側の問題。error に理由) */
    state: "opening" | "open" | "error";
    error?: string;
    /** 映像が届いて、再生が進んでいるか (最近の数秒のうちに、新しいフレームが届いた) */
    playing: boolean;
    width?: number;
    height?: number;
    fps?: number;
    /** WebRTC の受信の統計 (ページを開いてからの累計)。取れなければ無い */
    packetsReceived?: number;
    packetsLost?: number;
    /** 映像が固まった回数 (Chrome の freezeCount) */
    freezes?: number;
}

export interface WebcamPort {
    /**
     * 受信用の URL を開いて、見続ける (key はテストの ID)。すぐ戻る (開くのは裏で進み、結果は status で見る)。
     * VDO.ninja は見る側がいる間だけ送るので、bot が開いている間、配信者の PC から WebRTC の映像が送られる
     */
    open(key: string, viewUrl: string): void;
    /** 開いていなければ undefined */
    status(key: string): WebcamStatus | undefined;
    /** いま映っている絵 (JPEG)。映っていなければ undefined */
    still(key: string): Promise<Buffer | undefined>;
    close(key: string): Promise<void>;
}

// ---- Google ドライブ (録画と録音のアップロード) ----

export interface DrivePort {
    /** アップロード先 (設定の google.drive.folderId) の中にフォルダを作り、その ID を返す */
    createFolder(name: string): Promise<string>;
    /** ローカルのファイルを、フォルダに上げる (名前はファイル名のまま) */
    upload(file: string, folderId: string): Promise<void>;
    folderUrl(folderId: string): string;
}

// ---- DNS ----

export interface DnsPort {
    resolve(domain: string): Promise<string[]>;
}

// ---- Discord ----

export type ButtonStyle = "primary" | "secondary" | "success" | "danger";

export interface Button {
    /** customId。bot が解釈する (src/discord/bot.ts) */
    id: string;
    label: string;
    style?: ButtonStyle;
}

export interface OutMessage {
    content: string;
    buttons?: Button[];
    image?: { name: string; data: Buffer };
}

export interface ChatPort {
    /** 配信テストのチャンネルにプライベートスレッドを作り、配信者を招待する。スレッドの ID を返す */
    createThread(name: string, userId: string): Promise<string>;
    post(threadId: string, msg: OutMessage): Promise<string>;
    /** 送ったメッセージのボタンを外す (押したあと) */
    clearButtons(threadId: string, messageId: string): Promise<void>;
    closeThread(threadId: string): Promise<void>;
    threadUrl(threadId: string): string;
    /**
     * 待ちの列の知らせ。配信テストのチャンネルに msg を書き (メンションとボタンはここ)、DM には dm の文と、そのメッセージへのリンクだけを送る。
     * 答える場所を 1 つにするため、DM にはボタンを付けない (両方にボタンがあると、どちらで答えるのか分からなくなる)。
     */
    callUser(userId: string, msg: OutMessage, dm: string): Promise<void>;
    /** 運営への通知のチャンネル (日本語) */
    ops(text: string): Promise<void>;
}

// ---- シート、webhook ----

export interface SheetPort {
    /** 1 行足し、その行の場所 (A1 形式) を返す */
    append(row: (string | number)[]): Promise<string>;
    /** 行の一部を書き換える (後日の音声の判定) */
    update(range: string, values: (string | number)[]): Promise<void>;
    url(): string;
}

export interface WebhookPort {
    /** URL が設定されていなければ何もしない */
    send(payload: unknown): Promise<void>;
}

export interface Clock {
    now(): number;
}
