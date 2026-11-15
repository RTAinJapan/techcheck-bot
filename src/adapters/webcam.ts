// web カメラ (VDO.ninja) の受信用のページを、画面の無い (headless) ブラウザで開いて、映像が届いているかを見る (設計書 §5.9)。
//
// - VDO.ninja は WebRTC の P2P で、見る側がいる間だけ送る。bot がページを開いている間、配信者の PC から映像が送られる
//   (OBS の配信と WebRTC の両方を送っている状態を作るのは、このページ)。
// - 映像が届いているかは、ページの中の <video> のフレームが進んでいるかで見る。VDO.ninja の中の作りには頼らない。
// - 受信の統計 (ロス、固まった回数) は、ページが作る RTCPeerConnection を覚えておいて、getStats() で読む。
// - ブラウザは、PC に入っている Chrome 系を使う (設定の webcam.browser)。Playwright はブラウザを操作するのに使うだけで、
//   ブラウザそのものは持ってこない (playwright-core)。

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Browser, type Page, chromium } from "playwright-core";
import type { VoiceRecording, WebcamPort, WebcamStatus } from "../ports.js";
import { measureLevel, waveformImage } from "./level.js";

const kPollMs = 1_000;
/** 新しいフレームがこれだけ届かなければ、再生が止まっているとみなす (ミリ秒) */
const kPlayingMs = 3_000;
const kOpenTimeoutMs = 30_000;

/** ページの中で測ったもの */
interface Probe {
    width: number;
    height: number;
    /** 進んでいるかを見る数 (デコードしたフレームの数。取れなければ再生位置) */
    progress: number;
    fps?: number;
    packetsReceived?: number;
    packetsLost?: number;
    freezes?: number;
    /** 届いた音声のパケットの数 (音声のトラックが無ければ無い) */
    audioPackets?: number;
}

interface View {
    status: WebcamStatus;
    page?: Page;
    closed: boolean;
    lastProgress?: number;
    lastAdvanceAt?: number;
    lastAudioPackets?: number;
    lastAudioAt?: number;
}

/** ページが作る RTCPeerConnection を覚えておく (ページのスクリプトより先に入れる) */
const kInitScript = `(() => {
    const Orig = window.RTCPeerConnection;
    if (!Orig) return;
    const peers = (window.__techcheckPeers = []);
    const Wrapped = new Proxy(Orig, {
        construct(target, args, newTarget) {
            const pc = Reflect.construct(target, args, newTarget);
            peers.push(pc);
            return pc;
        },
    });
    window.RTCPeerConnection = Wrapped;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Wrapped;
})();`;

/** いちばん大きく映っている <video> と、受信の統計を読む。文字列で渡す (ページの中で動くので、bot の側の型は使えない) */
const kProbeScript = `(async () => {
    let best;
    for (const v of document.querySelectorAll("video")) {
        // 自動再生が止められていたら、音を消して再生する (見るだけなので、音は要らない)
        if (v.paused && v.srcObject) { v.muted = true; v.play().catch(() => undefined); }
        if (v.videoWidth > 0 && (!best || v.videoWidth * v.videoHeight > best.videoWidth * best.videoHeight)) best = v;
    }
    const out = { width: best ? best.videoWidth : 0, height: best ? best.videoHeight : 0, progress: 0 };
    if (best) {
        const q = best.getVideoPlaybackQuality ? best.getVideoPlaybackQuality() : undefined;
        out.progress = q && q.totalVideoFrames ? q.totalVideoFrames : best.currentTime;
    }
    let found = false, received = 0, lost = 0, freezes = 0, audio;
    for (const pc of window.__techcheckPeers || []) {
        if (pc.connectionState === "closed") continue;
        let stats;
        try { stats = await pc.getStats(); } catch { continue; }
        stats.forEach((r) => {
            if (r.type === "inbound-rtp" && r.kind === "audio") audio = (audio || 0) + (r.packetsReceived || 0);
            if (r.type !== "inbound-rtp" || r.kind !== "video") return;
            found = true;
            received += r.packetsReceived || 0;
            lost += r.packetsLost || 0;
            freezes += r.freezeCount || 0;
            if (r.framesPerSecond !== undefined) out.fps = r.framesPerSecond;
        });
    }
    if (found) { out.packetsReceived = received; out.packetsLost = lost; out.freezes = freezes; }
    if (audio !== undefined) out.audioPackets = audio;
    return out;
})()`;

const kStillScript = `(() => {
    let best;
    for (const v of document.querySelectorAll("video")) {
        if (v.videoWidth > 0 && (!best || v.videoWidth * v.videoHeight > best.videoWidth * best.videoHeight)) best = v;
    }
    if (!best) return "";
    const c = document.createElement("canvas");
    c.width = best.videoWidth;
    c.height = best.videoHeight;
    c.getContext("2d").drawImage(best, 0, 0);
    return c.toDataURL("image/jpeg", 0.85);
})()`;

/**
 * 届いている音声のトラックを MediaRecorder で録り (WebM / Opus)、base64 で返す。音声のトラックが無ければ ""。
 * トラックは、<video> ではなく RTCPeerConnection の受信側から取る (ページの作りに頼らない)
 */
const kRecordScript = `async (seconds) => {
    let track;
    for (const pc of window.__techcheckPeers || []) {
        if (pc.connectionState === "closed") continue;
        for (const r of pc.getReceivers()) {
            // muted は「何も届いていない」トラック (送るだけの接続の受信側、など)
            if (!track && r.track && r.track.kind === "audio" && r.track.readyState === "live" && !r.track.muted) track = r.track;
        }
    }
    if (!track) return "";
    const chunks = [];
    const rec = new MediaRecorder(new MediaStream([track]), { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 128000 });
    rec.ondataavailable = (e) => chunks.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));
    rec.start();
    await new Promise((r) => setTimeout(r, seconds * 1000));
    rec.stop();
    await stopped;
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}`;

export class BrowserWebcam implements WebcamPort {
    private browser: Promise<Browser> | undefined;
    private readonly views = new Map<string, View>();

    /** browser.path があればその実行ファイル、無ければ channel (chrome、msedge など) の、PC に入っているブラウザを使う */
    constructor(
        private readonly browserOptions: { path: string; channel: string },
        private readonly log: (msg: string) => void = () => undefined,
        /** 録った声の音量を測る ffmpeg */
        private readonly ffmpegPath = "ffmpeg",
    ) {}

    open(key: string, viewUrl: string): void {
        if (this.views.has(key)) return;
        const view: View = { status: { state: "opening", playing: false }, closed: false };
        this.views.set(key, view);
        void this.watch(view, viewUrl);
    }

    status(key: string): WebcamStatus | undefined {
        return this.views.get(key)?.status;
    }

    async still(key: string): Promise<Buffer | undefined> {
        const page = this.views.get(key)?.page;
        if (!page) return undefined;
        const dataUrl = (await page.evaluate(kStillScript)) as string;
        const base64 = dataUrl.split(",")[1];
        return base64 ? Buffer.from(base64, "base64") : undefined;
    }

    async recordAudio(key: string, file: string, seconds: number): Promise<VoiceRecording> {
        const page = this.views.get(key)?.page;
        if (!page) throw new Error("受信用のページを開いていません");
        const base64 = (await page.evaluate(`(${kRecordScript})(${seconds})`)) as string;
        if (!base64) throw new Error("音声 (マイク) が届いていません");
        const data = Buffer.from(base64, "base64");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, data);
        const level = await measureLevel(this.ffmpegPath, file).catch(() => undefined);
        const waveform = await waveformImage(this.ffmpegPath, file).catch(() => undefined);
        // WebRTC は無音の間も送るので、長さは録った時間。届いたかどうかは音量で見る
        return { file, packets: 0, bytes: data.length, audioMs: seconds * 1000, ...level, waveform };
    }

    async close(key: string): Promise<void> {
        const view = this.views.get(key);
        if (!view) return;
        view.closed = true;
        this.views.delete(key);
        await view.page
            ?.context()
            .close()
            .catch(() => undefined);
        // 見ているページが無くなったら、ブラウザも閉じる (テストの無い間は、動かしておかない)
        if (this.views.size === 0) await this.closeBrowser();
    }

    /** bot を止めるとき */
    async stop(): Promise<void> {
        for (const view of this.views.values()) view.closed = true;
        this.views.clear();
        await this.closeBrowser();
    }

    private async closeBrowser(): Promise<void> {
        const browser = this.browser;
        this.browser = undefined;
        await browser?.then((b) => b.close()).catch(() => undefined);
    }

    private launch(): Promise<Browser> {
        this.browser ??= chromium
            .launch({
                headless: true,
                ...(this.browserOptions.path ? { executablePath: this.browserOptions.path } : { channel: this.browserOptions.channel }),
                // 操作なしで再生を始められるようにする。音は出さない
                args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
            })
            .then((b) => {
                // ブラウザが落ちたら、次に開くときに起動し直す
                b.on("disconnected", () => {
                    if (this.browser === launched) this.browser = undefined;
                });
                return b;
            });
        const launched = this.browser;
        launched.catch(() => {
            if (this.browser === launched) this.browser = undefined;
        });
        return launched;
    }

    /** ページを開き、閉じるまで 1 秒ごとに映像の状態を読む */
    private async watch(view: View, viewUrl: string): Promise<void> {
        try {
            const browser = await this.launch();
            if (view.closed) return;
            const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
            await context.addInitScript(kInitScript);
            const page = await context.newPage();
            view.page = page;
            if (view.closed) return void (await context.close().catch(() => undefined));
            await page.goto(viewUrl, { waitUntil: "domcontentloaded", timeout: kOpenTimeoutMs });
            view.status = { state: "open", playing: false };
            while (!view.closed) {
                this.update(view, (await page.evaluate(kProbeScript)) as Probe);
                await new Promise((r) => setTimeout(r, kPollMs));
            }
        } catch (e) {
            if (view.closed) return;
            const error = e instanceof Error ? e.message.split("\n")[0]! : String(e);
            this.log(`web カメラ: 受信用のページを見られません: ${error}`);
            view.status = { state: "error", error, playing: false };
        }
    }

    private update(view: View, p: Probe): void {
        const now = Date.now();
        // 初めて見えた 1 枚は数えない (止まった絵が 1 枚あるだけでは、届いているとは言えない)
        if (p.width > 0 && view.lastProgress !== undefined && p.progress > view.lastProgress) view.lastAdvanceAt = now;
        // 映像が入れ替わる (配信者がページを開き直す) と、数え直しになる
        view.lastProgress = p.width > 0 ? p.progress : undefined;
        const playing = p.width > 0 && view.lastAdvanceAt !== undefined && now - view.lastAdvanceAt < kPlayingMs;
        if (p.audioPackets !== undefined && view.lastAudioPackets !== undefined && p.audioPackets > view.lastAudioPackets) view.lastAudioAt = now;
        view.lastAudioPackets = p.audioPackets;
        const audio = view.lastAudioAt !== undefined && now - view.lastAudioAt < kPlayingMs;
        view.status = {
            state: "open",
            playing,
            ...(p.width > 0 ? { width: p.width, height: p.height } : {}),
            fps: p.fps,
            packetsReceived: p.packetsReceived,
            packetsLost: p.packetsLost,
            freezes: p.freezes,
            audio,
        };
    }
}
