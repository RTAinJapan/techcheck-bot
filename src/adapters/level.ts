// 録った声の音量と波形を、ffmpeg で測る。VDO.ninja で届いたマイクの声の録音 (webcam.ts) で使う。

import { spawn } from "node:child_process";

/**
 * 録った声の波形の画像 (PNG、800x200)。配信者に、どれくらいの音量で届いたかを見せる。
 * 列ごとのピークで描くので、上下の赤い線 (0 dBFS) に届いていれば、音が割れている。
 */
export function waveformImage(ffmpegPath: string, file: string): Promise<Buffer | undefined> {
    const graph =
        "color=c=0x2B2D31:s=800x200[bg];" +
        "[0:a]aformat=channel_layouts=mono,showwavespic=s=800x200:colors=0x57F287:filter=peak[fg];" +
        "[bg][fg]overlay=format=auto," +
        "drawbox=x=0:y=0:w=800:h=2:color=0xED4245:t=fill,drawbox=x=0:y=198:w=800:h=2:color=0xED4245:t=fill";
    const args = ["-hide_banner", "-loglevel", "error", "-i", file, "-filter_complex", graph, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"];
    return new Promise((resolve, reject) => {
        const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
        const out: Buffer[] = [];
        const timer = setTimeout(() => child.kill(), 15_000);
        child.stdout.on("data", (d: Buffer) => out.push(d));
        child.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
        });
        child.on("close", () => {
            clearTimeout(timer);
            const image = Buffer.concat(out);
            resolve(image.length > 0 ? image : undefined);
        });
    });
}

/** 録ったファイルの音量 (dBFS) を ffmpeg の volumedetect で測る */
export function measureLevel(ffmpegPath: string, file: string): Promise<{ maxDb?: number; meanDb?: number; clippedPct?: number }> {
    return new Promise((resolve, reject) => {
        const child = spawn(ffmpegPath, ["-hide_banner", "-nostats", "-i", file, "-af", "volumedetect", "-f", "null", "-"], {
            stdio: ["ignore", "ignore", "pipe"],
            windowsHide: true,
        });
        let err = "";
        const timer = setTimeout(() => child.kill(), 15_000);
        child.stderr.on("data", (d: Buffer) => {
            err += d.toString("utf8");
        });
        child.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
        });
        child.on("close", () => {
            clearTimeout(timer);
            resolve(parseVolumedetect(err));
        });
    });
}

/** ffmpeg の volumedetect の出力から、音量と、振り切れたサンプルの割合を読む */
export function parseVolumedetect(text: string): { maxDb?: number; meanDb?: number; clippedPct?: number } {
    const num = (re: RegExp) => {
        const m = re.exec(text);
        return m ? Number(m[1]) : undefined;
    };
    // n_samples は最初に 0 で 1 回出て、終わりに本当の数が出る。0 でない方を読む
    const samples = num(/n_samples:\s*([1-9]\d*)/);
    const at0 = num(/histogram_0db:\s*(\d+)/);
    return {
        maxDb: num(/max_volume:\s*(-?[\d.]+) dB/),
        meanDb: num(/mean_volume:\s*(-?[\d.]+) dB/),
        clippedPct: samples ? Math.round(((at0 ?? 0) / samples) * 10000) / 100 : undefined,
    };
}
