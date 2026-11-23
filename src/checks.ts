// 音声とその他のチェック (設計書 §7)。既定の手順と、音声のレベルによる参考の判定。
// 参考の判定は 1 秒ごとのピーク (dBFS、左右の大きい方) で行う。最終的な判定は録画を人が聞いて行う。

import type { CheckStep } from "./config.js";

export const defaultChecks: CheckStep[] = [
    {
        id: "game-audio",
        label: { ja: "ゲーム音が来ている", en: "Game audio arrives" },
        kind: "sound",
        seconds: 15,
        thresholdDb: -40,
        ratio: 0.8,
        text: {
            ja: "ゲームの音を鳴らしてください。BGM や効果音が出る場面で、15 秒ほど続けます。",
            en: "Play your game with sound. Stay in a scene with music or sound effects for about 15 seconds.",
        },
        failHint: {
            ja: "ゲームの音が届いていません。OBS のゲーム音の入力 (キャプチャボード・アプリの音声キャプチャ) と、ミュートになっていないかを確かめてください。",
            en: "Game audio is not reaching us. Check the game audio source in OBS (capture card or application audio capture) and make sure it is not muted.",
        },
    },
    {
        id: "silence",
        label: { ja: "無音シーン", en: "Silent scene" },
        kind: "silence",
        seconds: 10,
        thresholdDb: -60,
        // 「ミュートして」とだけ書くと、OBS の側でミュートしてしまい、配信に載る音の確認にならない。ゲームの側で音を止めてもらう
        text: {
            ja: "ゲームの側で音が出ない状態にして、10 秒ほど静かにしてください。ゲームの中で音の無い場面に移るか、ゲーム内の設定で音量を 0 にします。OBS の設定 (ミュートや音量) は変えないでください。ゲームの音を完全には消せない場合は「音を消せない」を押してください。",
            en: "Make the game itself silent and stay quiet for about 10 seconds. Move to a scene with no sound in the game, or set the volume to 0 in the game's own settings. Do not change anything in OBS (mute or volume). If the game cannot be made completely silent, press \"Can't mute the game\".",
        },
        failHint: {
            ja: "何も鳴らしていないのに音が載っています (ノイズの可能性)。キャプチャボードの音量や、ゲーム機の設定を確かめてください。",
            en: "We hear sound although nothing is playing (possibly noise). Check the capture card volume and your console settings.",
        },
    },
    {
        id: "mic",
        label: { ja: "OBS にマイクが入っていない", en: "Microphone is not in the OBS audio" },
        kind: "quiet",
        seconds: 10,
        marginDb: 6,
        text: {
            // 何のためにマイクで話すのかを先に伝える (マイクの音質を見る手順だと思われないように)
            ja: "OBS にゲーム音だけが載る設定になっていることを確認します。\nゲームの音が出ない状態のまま、マイクに向かって普段の声で 10 秒ほど話してください。",
            en: "We check that OBS is set up to send only the game audio.\nKeep the game silent and talk into your microphone in your normal voice for about 10 seconds.",
        },
        failHint: {
            ja: "マイクの音が配信に入っています。OBS のマイクの入力を、配信の音声から外してください (マイクは別の経路で送ってもらいます)。",
            en: "Your microphone is in the stream. Remove the microphone from the stream audio in OBS (we receive your voice separately).",
        },
    },
    {
        id: "desktop",
        label: { ja: "OBS にゲーム以外のデスクトップ音などが入っていない", en: "No desktop or other non-game audio in OBS" },
        kind: "quiet",
        seconds: 10,
        marginDb: 6,
        text: {
            ja: "ゲームの音が出ない状態のまま、PC の音 (ブラウザの動画、Discord の通知音など) を 10 秒ほど鳴らしてください。",
            en: "Keep the game silent and play some PC sound (a video in your browser, a Discord notification, etc.) for about 10 seconds.",
        },
        failHint: {
            ja: "PC の音が配信に入っています。OBS のデスクトップ音声を、配信の音声から外してください。",
            en: "PC sound is in the stream. Remove desktop audio from the stream audio in OBS.",
        },
    },
    {
        id: "picture",
        label: { ja: "送信されたゲーム映像が意図通り", en: "The game picture is as intended" },
        kind: "confirm",
        seconds: 0,
        text: {
            // 静止画を付けられないときにも読める文にする。
            // 余白があってもよい (受ける側で切り抜く)。送る側は、ゲーム画面の要る範囲がすべて配信の画面に収まっていればよい
            ja: "配信に映っている画面は正しいですか (ゲーム画面が全て映っている。余計なウインドウが無い)。",
            en: "Is the picture in your stream correct (the whole game screen is visible, and there are no other windows)?",
        },
        failHint: {
            ja: "OBS のシーンを直してから「やり直す」を押してください。",
            en: "Fix the scene in OBS, then press \"Retry\".",
        },
    },
];

/**
 * 繋ぎ直しの手順 (配信を止めて始め直す練習)。既定の手順には入れていない: 配信者は OBS の使い方が分かっているので、
 * 練習は要らない。要るイベントでは、設定の checks にこの形の手順を足す (kind: reconnect)。
 */
export const reconnectStep: CheckStep = {
    id: "reconnect",
    label: { ja: "配信を始め直して戻れる", en: "Stream comes back after a restart" },
    kind: "reconnect",
    seconds: 60,
    text: {
        ja: "OBS の配信を一度止めて、もう一度始めてください (本番で切れたときの戻し方の練習です)。",
        en: "Stop streaming in OBS once and start it again (practice for recovering if you drop during the event).",
    },
    failHint: {
        ja: "配信が戻ってきません。OBS の配信の設定 (URL) が保存されているかを確かめてください。",
        en: "Your stream did not come back. Check that the stream settings (URL) in OBS were saved.",
    },
};

/**
 * マイクの声の録音 (Discord のボイスチャンネル)。設定の mic.via が discord のとき、既定の手順の最後に足す。
 * 本番のマイクの声は、配信とは別に Discord のボイスチャンネルで届くので、その経路の音を録って、あとで運営が聞く。
 * マイクを使わない配信者は「マイクは使わない」で飛ばす。
 * 入るボイスチャンネルは、bot が空いている所を選び、この文言の下に付けて案内する (service.ts の promptVoice)。
 */
export const micDiscordStep: CheckStep = {
    id: "voice",
    label: { ja: "マイク音", en: "Microphone voice" },
    kind: "micRecord",
    seconds: 15,
    text: {
        ja: "(マイクを使う方だけ) Discord のボイスチャンネルで届く声を録音します (あとで運営が聞いて確かめます)。下のボイスチャンネルに入り、「始める」を押してから、普段の声で 15 秒ほど話してください。マイクを使わない方は「マイクは使わない」を押してください。",
        en: "(Only if you use a microphone) We record your voice as it reaches us through a Discord voice channel (staff will listen to it later). Join the voice channel below, press \"Start\", then talk in your normal voice for about 15 seconds. If you don't use a microphone, press \"I don't use a mic\".",
    },
    failHint: {
        ja: "声が届いていません。Discord でミュートになっていないか、入力デバイス (マイク) が合っているかを確かめてください。",
        en: "Your voice did not reach us. Check that you are not muted in Discord and that the right input device (microphone) is selected.",
    },
};

/**
 * マイクの声の録音 (VDO.ninja)。設定の mic.via が vdoninja のとき、既定の手順の最後に足す。
 * 本番のマイクの声は、web カメラと同じ VDO.ninja のページから届くので、その経路の音を bot のブラウザで録って、あとで運営が聞く。
 * 送信用の URL は、この文言の下に付けて案内する (service.ts の promptWebcamVoice)。
 */
export const micVdoninjaStep: CheckStep = {
    id: "voice",
    label: { ja: "マイク音", en: "Microphone voice" },
    kind: "micRecord",
    seconds: 15,
    text: {
        ja: "(マイクを使う方だけ) web カメラのページ (VDO.ninja) から届くマイクの声を録音します (あとで運営が聞いて確かめます)。カメラのページで本番で使うマイクが選ばれていて、ミュートになっていないことを確かめ、「始める」を押してから、普段の声で 15 秒ほど話してください。マイクを使わない方は「マイクは使わない」を押してください。",
        en: "(Only if you use a microphone) We record your voice as it reaches us from the webcam page (VDO.ninja) (staff will listen to it later). Check that the microphone you will use at the event is selected on the webcam page and is not muted, press \"Start\", then talk in your normal voice for about 15 seconds. If you don't use a microphone, press \"I don't use a mic\".",
    },
    failHint: {
        ja: "声が届いていません。web カメラのページで、マイクが選ばれているか (本番で使うマイクか)、ミュートになっていないかを確かめてください。",
        en: "Your voice did not reach us. On the webcam page, check that the right microphone is selected and that it is not muted.",
    },
};

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
