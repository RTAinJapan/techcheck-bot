// テストのセッション、待ちの列、枠の型。すべて JSON にして保存できる形にする (bot を起動し直しても続きから)。

import type { Advice } from "./advisor.js";
import type { CheckVerdict } from "./checks.js";
import type { Lang } from "./config.js";

export type Phase =
    | "preparing" // フローの開始、denpachan のチャンネルと録画の開始
    | "waitingStream" // 初回の案内を出して、配信の開始を待つ
    | "awaitingUsage" // 配信は届いたが、web カメラとマイクを使うかの答えを待つ (答えないと、VDO.ninja を開くかが決まらない)
    | "awaitingWebcam" // VDO.ninja (web カメラかマイク) が届くのを待つ。届いてから計測する (設計書 §5.9)
    | "measuring" // 計測の窓を溜めている
    | "confirming" // 安定の確定
    | "awaitingLatency" // latency の変更を頼んで、始め直すのを待つ
    | "awaitingRtmp" // RTMP への切り替えを頼んで、届くのを待つ
    | "checks" // 音声とその他のチェック
    | "awaitingDone" // 「完了」を待つ
    | "finished";

export interface StepRecord {
    id: string;
    verdict: CheckVerdict;
    value?: number;
    /** 録画の中の区間 (秒) */
    recFrom?: number;
    recTo?: number;
    /**
     * 区間が入っている録画ファイル。配信が長く途切れると denpachan は録画ファイルを切り替えるので、どのファイルの位置かを覚えておく。
     * recToFile は、手順の途中でファイルが切り替わったときだけ (終わりの位置は、こちらのファイルの中)
     */
    recFile?: string;
    recToFile?: string;
    /** 「おかしい」のまま配信者が先に進めた */
    skipped?: boolean;
}

export interface Pending {
    kind: "latency" | "rtmp";
    target?: number;
    askedAt: number;
    messageId?: string;
    pressed: boolean;
    reconnectedAt?: number;
    reminded: boolean;
}

/** 本番で使うか (web カメラ、マイク)。maybe は「未定」で、使うものとして確かめる */
export type UsageAnswer = "yes" | "maybe" | "no";

/** 本番で web カメラとマイクを使うかの答え (スレッドを作った直後に聞く。設計書 §5.9) */
export interface UsageState {
    camera?: UsageAnswer;
    mic?: UsageAnswer;
    /** 聞いたメッセージ (答えたら、選んだものを書き足す。VDO.ninja の案内を出したら、ボタンを外す) */
    cameraMessageId?: string;
    micMessageId?: string;
    /** VDO.ninja の案内を出した (ここからは、答えを変えられない) */
    locked?: boolean;
}

export interface Session {
    id: string;
    userId: string;
    displayName: string;
    lang: Lang;
    threadId: string;
    createdAt: number;
    phase: Phase;
    phaseSince: number;
    lastActivity: number;
    reminded: boolean;
    protocol: "srt" | "rtmp";
    /** slot は、使っている SRT の枠の番号 (0 始まり。SlotState.srt の位置) */
    srt: { slot: number; flowName: string; flowArn: string; domain: string; channel: number; startedFlow: boolean; released: boolean };
    rtmp?: { channel: number };
    latencyMs: number;
    raises: number;
    recordStartAt?: number;
    recordFiles: string[];
    connectedAt?: number;
    measureFromSec?: number;
    confirmFromSec?: number;
    lastAdvice?: Advice;
    prevDrops?: number;
    pending?: Pending;
    rx: {
        lastStatus?: string;
        lastConnectedSec?: number;
        droppedAt?: number;
        reconnectAt?: number;
        decodeErrorsBase?: number;
        retransBase?: number;
        fps: number[];
        silenceAlerted: boolean;
        opsWarned: boolean;
    };
    cw: { lastUpTime?: number; reconnectAt?: number; missingWarned: boolean };
    disconnects: number;
    metadataChecked: boolean;
    /** 静止画を取れないことを、このテストで運営に知らせたか (同じ知らせを繰り返さない) */
    stillWarned?: boolean;
    /** 本番で web カメラとマイクを使うかの答え (VDO.ninja を使う設定のときだけ聞く) */
    usage?: UsageState;
    /** マイクの声の録音 (VDO.ninja)。skipped は「マイクは使わない」 */
    voice?: { file?: string; audioMs?: number; maxDb?: number; meanDb?: number; clippedPct?: number; skipped?: boolean };
    /** VDO.ninja (web カメラとマイク。設計書 §5.9)。案内したときに作る */
    webcam?: WebcamState;
    /** 「静かにする」手順で、ゲームの音を完全には消せないと申告した (その手順は判定せず、測った大きさをあとの手順の基準にする) */
    cannotMute?: boolean;
    streamFps?: number;
    checkIndex: number;
    checkState: "prompt" | "running" | "result";
    checkStartedAt?: number;
    checkRecFrom?: number;
    /** checkRecFrom を取ったときの録画ファイル */
    checkRecFile?: string;
    checkPeaks: number[];
    results: StepRecord[];
    noiseDb?: number;
    videoVerdict?: "OK" | "RTMP" | "NG";
    confirmedLatencyMs?: number;
    summary: Summary;
    memo?: string;
    abortReason?: string;
}

export interface WebcamState {
    /** 使っている送信用と受信用の URL の組 (設定の vdoninja.links の位置) */
    link: number;
    /** web カメラは使わない (最初の答え、または案内の「web カメラは使わない」)。マイクだけ使う人も、ページは開く */
    skipped?: boolean;
    /** bot の側の問題で、受信用のページを開けなかった (web カメラなしで進めた) */
    failed?: boolean;
    /** 案内のメッセージ (届いたらボタンを外す) */
    messageId?: string;
    /** 映像が続けて届き始めた時刻 (届いたとみなすまでの間) */
    playingSince?: number;
    /** 届いたとみなした時刻 */
    arrivedAt?: number;
    /** 映像の判定の間に、届かなくなった時刻 */
    lostAt?: number;
    /** 映像の判定の間に途切れて、待ち直した回数 */
    drops?: number;
    /** 計測を始めたときの、受信の統計 (ここからの差で、判定の間のロスと固まった回数を出す) */
    base?: { packetsReceived?: number; packetsLost?: number; freezes?: number };
    /** 録画のファイル名のもと (録画を始めたとき。bot を起動し直したら、作り直す) */
    recordBase?: string;
    /** 録画を書いたファイル */
    files?: string[];
    /** 映像の判定が終わったときの値 (シートに書く) */
    width?: number;
    height?: number;
    fps?: number;
    lossPct?: number;
    freezes?: number;
}

export interface Summary {
    rttMaxMs?: number;
    lossPct?: number;
    drops?: number;
    jitterMaxMs?: number;
    bitrateKbps?: number;
    fpsAvg?: number;
    codec?: string;
    width?: number;
    height?: number;
    decodeErrors?: number;
    opsRttMs?: number;
    opsDrops?: number;
    recommendMs?: number;
}

export interface QueueEntry {
    userId: string;
    displayName: string;
    lang: Lang;
    joinedAt: number;
    skips: number;
}

export interface QueueOffer {
    userId: string;
    offeredAt: number;
}

export interface QueueState {
    entries: QueueEntry[];
    /** 「順番が来た」と知らせて、「始める」を待っている人。空いている SRT の枠の数まで */
    offers: QueueOffer[];
}

export interface SrtSlotState {
    flow?: string;
    channel?: number;
    enabled: boolean;
    /**
     * 止めている (enabled が false の) とき、誰が止めたか。true: bot が問題を見つけて止めた。false: 運営が `/techcheck slot off` で止めた。
     * bot が止めた枠は、bot を起動し直すと受付を再開する (設定や環境を直して起動し直したら、もう一度試す)。運営が止めた枠は止めたまま
     */
    stoppedByProblem?: boolean;
}

/** 枠。SRT は同時にテストできる人数だけ並ぶ (数は設定の slots.srt で決まる)。RTMP は 1 つ */
export interface SlotState {
    srt: SrtSlotState[];
    rtmp: { channel?: number; enabled: boolean };
}

/** 終わったテストの録画と録音を、Google ドライブに上げる仕事 (設計書 §8.1)。bot を起動し直しても続きから上げる */
export interface UploadJob {
    id: string;
    displayName: string;
    /** ドライブに作るフォルダの名前 (スレッドと同じ名前) */
    folderName: string;
    /** 上げるファイル (ローカルのパス) */
    files: string[];
    /** 上げ終えたファイル */
    done: string[];
    /** 見つからなかったなどで、上げなかったファイルと理由 */
    skipped: string[];
    folderId?: string;
    /** 結果 (フォルダのリンク) を書くシートのセル */
    sheetCell?: string;
    /** この時刻を過ぎたら上げる (録画ファイルが閉じるのを待つ。失敗のあとのやり直しまでの間隔にも使う) */
    readyAt: number;
    attempts: number;
}

export interface FinishedRecord {
    sessionId: string;
    sheetRange?: string;
    threadUrl: string;
    at: number;
}
