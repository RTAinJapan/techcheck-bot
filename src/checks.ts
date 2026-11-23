// 音声とその他のチェック (設計書 §7)。既定の手順と、音声のレベルによる参考の判定。
// 参考の判定は 1 秒ごとのピーク (dBFS、左右の大きい方) で行う。最終的な判定は録画を人が聞いて行う。
// 手順の文言 (名前・指示・直し方) は、ここには書かない。messages/ja.yaml と en.yaml の steps.<id> に書く (stepTextKeys)。

import type { CheckStep } from "./config.js";

export const defaultChecks: CheckStep[] = [
    { id: "game-audio", kind: "sound", seconds: 15, thresholdDb: -40, ratio: 0.8 },
    { id: "silence", kind: "silence", seconds: 10, thresholdDb: -60 },
    { id: "mic", kind: "quiet", seconds: 10, marginDb: 6 },
    { id: "desktop", kind: "quiet", seconds: 10, marginDb: 6 },
    { id: "picture", kind: "confirm", seconds: 0 },
];

/**
 * 繋ぎ直しの手順 (配信を止めて始め直す練習)。既定の手順には入れていない: 配信者は OBS の使い方が分かっているので、
 * 練習は要らない。要るイベントでは、設定の checks にこの形の手順を足す (kind: reconnect)。
 */
export const reconnectStep: CheckStep = { id: "reconnect", kind: "reconnect", seconds: 60 };

/**
 * マイクの声の録音。設定の vdoninja.links があれば、既定の手順の最後に足す。
 * 本番のマイクの声は web カメラと同じ VDO.ninja のページから届くので、その声を bot のブラウザで録って、あとで運営が聞く。
 * マイクを「使わない」と答えた配信者には出さない。「未定」の配信者は「マイクは使わない」で飛ばせる。
 */
export const micStep: CheckStep = { id: "voice", kind: "micRecord", seconds: 15 };

/** 手順の文言の、messages のキー。label は省ける (無ければ、結果のまとめに id のまま出す)。text と failHint は要る */
export function stepTextKeys(step: CheckStep): { label: string; text: string; failHint: string } {
    const base = `steps.${step.id}`;
    return { label: `${base}.label`, text: `${base}.text`, failHint: `${base}.failHint` };
}

/** 手順の文言が messages にそろっているか。足りないものを返す (起動するときに見る) */
export function missingStepTexts(steps: CheckStep[], has: (key: string) => boolean): string[] {
    return steps.flatMap((s) => {
        const k = stepTextKeys(s);
        return [k.text, k.failHint].filter((key) => !has(key));
    });
}

export type CheckVerdict = "ok" | "ng" | "unknown";

export interface CheckResult {
    verdict: CheckVerdict;
    /** 記録用の数字 (sound: 音が載った秒の割合、silence: ノイズの大きさ、quiet: 最大のピーク) */
    value?: number;
}

/** 1 秒ごとのピークから、手順の参考の判定を出す。peaks が空 (denpachan の受信口が無い) なら unknown */
export function evaluateAudioStep(step: CheckStep, peaks: number[], noiseDb: number | undefined, silentDb: number): CheckResult {
    if (peaks.length === 0) return { verdict: "unknown" };
    const max = Math.max(...peaks);
    switch (step.kind) {
        case "sound": {
            const threshold = step.thresholdDb ?? -40;
            const ratio = peaks.filter((p) => p >= threshold).length / peaks.length;
            return { verdict: ratio >= (step.ratio ?? 0.8) ? "ok" : "ng", value: round1(ratio) };
        }
        case "silence":
            return { verdict: max < (step.thresholdDb ?? silentDb) ? "ok" : "ng", value: round1(max) };
        case "quiet": {
            const base = Math.max(noiseDb ?? silentDb, silentDb);
            return { verdict: max <= base + (step.marginDb ?? 6) ? "ok" : "ng", value: round1(max) };
        }
        default:
            return { verdict: "unknown" };
    }
}

function round1(v: number): number {
    return Math.round(v * 10) / 10;
}
