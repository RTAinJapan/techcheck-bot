// シートの 1 行 (設計書 §8) と、webhook の通知 (§5.5) を作る。どちらも運営向けなので日本語。

import { obsLatency } from "./advisor.js";
import type { CheckStep } from "./config.js";
import type { Session, StepRecord } from "./session.js";

export const sheetColumns = [
    "日時",
    "表示名",
    "ユーザー ID",
    "言語",
    "フロー",
    "denpachan のチャンネル",
    "結果",
    "理由",
    // あとで聞く人が最初に開くもの (録画、録音、それを上げたドライブのフォルダ) は、左の方 (I 列から) に置く
    "録画ファイル",
    "マイクの録音 (VC)",
    "Google ドライブ",
    "プロトコル",
    // latency は μs (OBS の URL に入れる値) で書く。RTT とジッタは測った値なので ms のまま
    "確定した latency (μs)",
    "推奨値 (μs)",
    "RTT 最大 (ms)",
    "ロス率 (%)",
    "回復できなかったパケット",
    "ジッタ最大 (ms)",
    "解像度",
    "fps (平均)",
    "コーデック",
    "ビットレート (kbps)",
    "切れた回数",
    "デコードエラー",
    "latency を上げた回数",
    "運営の区間の RTT (ms)",
    "運営の区間の取りこぼし",
    "ノイズ (dBFS)",
    "チェックの参考の判定と録画の区間",
    "映像の判定",
    "音声の判定",
    "音声のメモ",
    "配信者のメモ",
    "スレッド",
    // 列を足すときは、後ろに足す (途中に足すと、すでに書いてあるシートの列がずれる。bot は、足りない後ろの見出しだけを書き足す)。
    // 順を変えるときは、使っているシートの列も同じ順に並べ替える
] as const;

/** Google ドライブへのアップロードの結果を書く列 (0 始まり) */
export const driveColumn = sheetColumns.indexOf("Google ドライブ");

/** append が返した範囲 (`techcheck!A7:AH7`) から、その行の、ある列のセルを作る */
export function cellInRow(sheetRange: string, column: number): string | undefined {
    const row = /(\d+)(?::[A-Z]+\d+)?$/.exec(sheetRange)?.[1];
    if (!row) return undefined;
    const tab = sheetRange.includes("!") ? `${sheetRange.split("!")[0]}!` : "";
    return `${tab}${columnLetter(column)}${row}`;
}

/** 後日の音声の判定で書き換える列 (0 始まり) */
export const audioVerdictColumn = sheetColumns.indexOf("音声の判定");

export function columnLetter(index: number): string {
    let n = index + 1;
    let s = "";
    while (n > 0) {
        const r = (n - 1) % 26;
        s = String.fromCharCode(65 + r) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

export function formatTime(ms: number, timeZone = "Asia/Tokyo"): string {
    // sv-SE は YYYY-MM-DD HH:MM:SS の形
    return new Intl.DateTimeFormat("sv-SE", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    }).format(new Date(ms));
}

export function formatRecPos(sec: number | undefined): string {
    if (sec === undefined || !Number.isFinite(sec)) return "?";
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${String(m).padStart(2, "0")}:${ss}`;
}

const verdictJa = { ok: "OK", ng: "おかしい", unknown: "判定なし" } as const;

/** パスの最後の部分 (ファイル名)。録画ファイルは Windows のパスで来る */
export function baseName(file: string): string {
    return file.split(/[\\/]/).pop() ?? file;
}

/**
 * 手順の録画の区間。録画ファイルが 1 つなら位置だけ (`03:15〜03:33`)。
 * 配信が長く途切れて録画ファイルが複数になったテストでは、どのファイルの位置かを添える (`03:15〜03:33 [15 20-15-57.mkv]`)。
 * 手順の途中でファイルが切り替わったら、始まりと終わりのそれぞれに添える。
 */
export function describeRange(r: StepRecord, files: number): string {
    if (r.recFrom === undefined) return "";
    const from = formatRecPos(r.recFrom);
    const to = formatRecPos(r.recTo);
    if (r.recFile && r.recToFile) return ` [${baseName(r.recFile)}] ${from}〜[${baseName(r.recToFile)}] ${to}`;
    return ` ${from}〜${to}${files > 1 && r.recFile ? ` [${baseName(r.recFile)}]` : ""}`;
}

export function describeChecks(s: Session, checks: CheckStep[]): string {
    return s.results
        .map((r) => {
            const step = checks.find((c) => c.id === r.id);
            const range = describeRange(r, s.recordFiles.length);
            const value = r.value !== undefined ? ` (${step?.kind === "sound" ? `${Math.round(r.value * 100)}%` : `${r.value} dB`})` : "";
            return `${r.id}: ${verdictJa[r.verdict]}${r.skipped ? " (そのまま進めた)" : ""}${value}${range}`;
        })
        .join(" / ");
}

/** マイクの声の録音 (Discord のボイスチャンネル) の欄: ファイルと、声の長さ・音量。あとで運営が聞くための手がかり */
export function describeVoice(s: Session): string {
    const v = s.voice;
    if (!v) return "";
    if (v.skipped) return "マイクは使わない";
    if (!v.file) return "";
    const parts = [`声 ${Math.round((v.audioMs ?? 0) / 1000)} 秒`];
    if (v.maxDb !== undefined) parts.push(`最大 ${v.maxDb} dB`);
    if (v.meanDb !== undefined) parts.push(`平均 ${v.meanDb} dB`);
    if (v.clippedPct) parts.push(`振り切れ ${v.clippedPct} %`);
    return `${v.file} (${parts.join("、")})`;
}

/** drive は、Google ドライブの列に最初に書く文 (アップロードが済んだら、フォルダのリンクに書き換える) */
export function buildRow(s: Session, checks: CheckStep[], result: "done" | "aborted", threadUrl: string, drive = ""): (string | number)[] {
    const m = s.summary;
    const row: Record<(typeof sheetColumns)[number], string | number> = {
        日時: formatTime(s.createdAt),
        表示名: s.displayName,
        "ユーザー ID": s.userId,
        言語: s.lang,
        フロー: s.srt.flowName,
        "denpachan のチャンネル": s.rtmp ? `${s.srt.channel} → ${s.rtmp.channel} (RTMP)` : s.srt.channel,
        結果: result === "done" ? "完了" : "中断",
        理由: s.abortReason ?? "",
        プロトコル: s.protocol,
        "確定した latency (μs)": s.protocol === "srt" && s.confirmedLatencyMs !== undefined ? obsLatency(s.confirmedLatencyMs) : "",
        "推奨値 (μs)": m.recommendMs !== undefined ? obsLatency(m.recommendMs) : "",
        "RTT 最大 (ms)": m.rttMaxMs ?? "",
        "ロス率 (%)": m.lossPct ?? "",
        回復できなかったパケット: m.drops ?? "",
        "ジッタ最大 (ms)": m.jitterMaxMs ?? "",
        解像度: m.width && m.height ? `${m.width}x${m.height}` : "",
        "fps (平均)": m.fpsAvg ?? "",
        コーデック: m.codec ?? "",
        "ビットレート (kbps)": m.bitrateKbps ?? "",
        切れた回数: s.disconnects,
        デコードエラー: m.decodeErrors ?? "",
        "latency を上げた回数": s.raises,
        "運営の区間の RTT (ms)": m.opsRttMs ?? "",
        運営の区間の取りこぼし: m.opsDrops ?? "",
        "ノイズ (dBFS)": s.noiseDb ?? "",
        チェックの参考の判定と録画の区間: describeChecks(s, checks),
        録画ファイル: s.recordFiles.join(" / "),
        映像の判定: s.videoVerdict ?? "",
        音声の判定: "",
        音声のメモ: "",
        配信者のメモ: s.memo ?? "",
        スレッド: threadUrl,
        "マイクの録音 (VC)": describeVoice(s),
        "Google ドライブ": drive,
    };
    return sheetColumns.map((c) => row[c]);
}

export interface WebhookInput {
    session: Session;
    checks: CheckStep[];
    result: "done" | "aborted";
    threadUrl: string;
    sheetUrl: string;
    sheetError?: string;
}

/** Discord webhook の本文。メンションで人を呼ばない (allowed_mentions を空にする) */
export function buildWebhookPayload(input: WebhookInput): unknown {
    const { session: s, result } = input;
    const ng = s.results.filter((r) => r.verdict === "ng").map((r) => r.id);
    const fields = [
        { name: "配信者", value: `${s.displayName} (${s.userId})`, inline: false },
        { name: "結果", value: result === "done" ? "完了" : `中断 (${s.abortReason ?? "理由なし"})`, inline: true },
        { name: "プロトコル", value: s.protocol.toUpperCase(), inline: true },
        { name: "確定した latency", value: s.protocol === "srt" && s.confirmedLatencyMs ? `${obsLatency(s.confirmedLatencyMs)} μs` : "—", inline: true },
        { name: "映像の判定", value: s.videoVerdict ?? "—", inline: true },
        { name: "おかしいが残った手順", value: ng.length > 0 ? ng.join(", ") : "なし", inline: true },
        { name: "スレッド", value: input.threadUrl, inline: false },
        { name: "シート", value: input.sheetError ? `書けませんでした: ${input.sheetError}` : input.sheetUrl, inline: false },
    ];
    return {
        allowed_mentions: { parse: [] },
        embeds: [
            {
                title: `配信テスト ${result === "done" ? "完了" : "中断"}: ${s.displayName}`,
                color: result === "done" && ng.length === 0 && s.videoVerdict !== "NG" ? 0x2ecc71 : 0xe67e22,
                fields,
                timestamp: new Date().toISOString(),
            },
        ],
    };
}
