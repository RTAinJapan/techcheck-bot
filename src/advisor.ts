// SRT の latency の推奨値と判定 (設計書 §3.1、§6)。
// denpachan の src/worker/srt_advisor.h と同じ規則を、MediaConnect の 1 秒ごとのメトリクスに当てはめる:
//   推奨値 = 窓の中の RTT の最大 × 倍率 (ロス率で決まる)。窓の中に回復できなかったパケットがあれば今の 1.5 倍以上。
//   下限 20 ms、10 ms 単位に切り上げる。

export interface SrtSample {
    /** 秒 (epoch ms / 1000 でなくてよい。単調に増える秒) */
    t: number;
    connected: boolean;
    rttMs?: number;
    lossPct?: number;
    totalPackets?: number;
    notRecovered?: number;
    continuityErrors?: number;
    tsSyncLoss?: number;
    jitterMs?: number;
    bitrateBps?: number;
    upTimeSec?: number;
}

export type Verdict = "measuring" | "insufficient" | "tight" | "ok" | "generous";

export interface Advice {
    verdict: Verdict;
    recommendMs: number; // 0 = 計測中
    headroomMs: number | null;
    rttMs: number;
    lossPct: number;
    drops: number;
    multiplier: number;
    windowSec: number;
}

export const kMinLatencyMs = 20;
export const kMinSamples = 10;

/**
 * 人に見せる latency の値 (μs)。OBS の SRT の URL に入れる値と同じ (`latency=` はマイクロ秒。180 ms なら 180000)。
 * 配信者にも運営にも、latency はこの値だけで見せる (スレッドの案内、運営への通知、コマンド、webhook、シート)。
 * 配信者が触るのは OBS の URL で、運営も μs で覚えているので、ms の数字を見せると、そのまま URL に入れてしまう。
 * bot の中の計算は ms のまま (設定ファイルの `latency.initialUs`、`latency.maxUs` は μs で書き、読むときに ms にする)
 */
export function obsLatency(latencyMs: number): number {
    return Math.round(latencyMs * 1000);
}

export function multiplierFor(lossPct: number, table: [number, number][]): number {
    for (const [maxLoss, mult] of table) if (lossPct <= maxLoss) return mult;
    return table[table.length - 1]![1];
}

/** samples は判定の窓 (接続直後の除外は呼ぶ側で済ませておく)。effectiveMs は今の latency (案内した値) */
export function advise(samples: SrtSample[], effectiveMs: number, table: [number, number][]): Advice {
    let rtt = 0;
    let received = 0;
    let lost = 0;
    let drops = 0;
    let withData = 0;
    for (const s of samples) {
        if (!s.connected) continue;
        if (s.rttMs !== undefined) rtt = Math.max(rtt, s.rttMs);
        const total = s.totalPackets ?? 0;
        if (total > 0) withData++;
        const lossPct = s.lossPct ?? 0;
        // ロス率は「失ったパケット ÷ (受信 + 失った)」。1 秒ごとの受信数とロス率から失った数を戻す
        const l = lossPct > 0 && lossPct < 100 ? (total * lossPct) / (100 - lossPct) : 0;
        received += total;
        lost += l;
        drops += s.notRecovered ?? 0;
    }
    const lossPct = received + lost > 0 ? (100 * lost) / (received + lost) : 0;
    const base = { rttMs: round1(rtt), lossPct: round2(lossPct), drops, windowSec: samples.length };
    if (withData < kMinSamples) return { verdict: "measuring", recommendMs: 0, headroomMs: null, multiplier: 0, ...base };

    const multiplier = multiplierFor(lossPct, table);
    let latency = Math.max(rtt * multiplier, kMinLatencyMs);
    if (drops > 0) latency = Math.max(latency, effectiveMs * 1.5);
    const recommendMs = Math.ceil(latency / 10) * 10;
    return { verdict: verdictFor(effectiveMs, recommendMs, drops), recommendMs, headroomMs: effectiveMs - recommendMs, multiplier, ...base };
}

/** 画面の経路の行の色と同じ規則 (取りこぼし = 赤、推奨値に足りない = 黄) に「余っている」を足したもの */
export function verdictFor(effectiveMs: number, recommendMs: number, drops: number): Verdict {
    if (recommendMs <= 0) return "measuring";
    if (drops > 0) return "insufficient";
    if (recommendMs > effectiveMs) return "tight";
    if (effectiveMs >= recommendMs * 2) return "generous";
    return "ok";
}

/**
 * 次に案内する latency: 推奨値 (advise の recommendMs) そのもの。10 ms 単位に切り上げ、上限で抑える。
 * ここでは今の値を何倍かにしない: 回線から出した推奨値に合わせる。今の値より大きくならなければ、呼ぶ側が RTMP に切り替える。
 * 「今の 1.5 倍以上」になるのは、実際に取りこぼしたときだけ (推奨値の規則。advise と atLeastAfterDrops)
 */
export function nextLatency(recommendMs: number, maxMs: number): number {
    return Math.min(Math.ceil(recommendMs / 10) * 10, maxMs);
}

/**
 * 実際に映像が乱れた (回復できなかったパケットがある、など) ときの推奨値: 今の 1.5 倍以上にする (advise の中の規則と同じ)。
 * 計測のあとの確定の間に乱れたときに使う (計測のときの推奨値は、乱れる前のもの)
 */
export function atLeastAfterDrops(recommendMs: number, currentMs: number): number {
    return Math.ceil(Math.max(recommendMs, currentMs * 1.5) / 10) * 10;
}

function round1(v: number): number {
    return Math.round(v * 10) / 10;
}
function round2(v: number): number {
    return Math.round(v * 100) / 100;
}
