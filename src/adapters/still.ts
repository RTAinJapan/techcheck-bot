// 配信の静止画を、denpachan の録画ファイルから ffmpeg で取り出す。
//
// denpachan はテストの間ずっと録画している (SRT の枠も RTMP の枠も) ので、その録画の「今」に近い 1 枚を取り出せば、
// 配信に映っている絵が分かる。MediaConnect のサムネイル (フローごとに有効にする設定が要り、RTMP では使えない) に頼らずに済む。
//
// - 録画中のファイルは長さが分からないので、末尾からの指定 (-sseof) は使えない。録画の秒数 (denpachan の record.seconds) から
//   少し手前を -ss で指定する。
// - bot と denpachan が同じ PC (または録画先を同じパスで見られる PC) で動いていること。別の PC なら、ファイルを開けずに失敗する。

import { spawn } from "node:child_process";
import type { StillPort } from "../ports.js";

const kTimeoutMs = 10_000;

export class FfmpegStill implements StillPort {
    constructor(private readonly ffmpegPath: string) {}

    fromRecording(file: string, atSec: number): Promise<Buffer> {
        const args = [
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            Math.max(0, atSec).toFixed(1),
            "-i",
            file,
            "-frames:v",
            "1",
            "-q:v",
            "4",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "pipe:1",
        ];
        return new Promise((resolve, reject) => {
            const child = spawn(this.ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
            const out: Buffer[] = [];
            let err = "";
            const timer = setTimeout(() => {
                child.kill();
                reject(new Error(`ffmpeg が ${kTimeoutMs / 1000} 秒で終わりませんでした`));
            }, kTimeoutMs);
            child.stdout.on("data", (d: Buffer) => out.push(d));
            child.stderr.on("data", (d: Buffer) => {
                err += d.toString("utf8");
            });
            child.on("error", (e: NodeJS.ErrnoException) => {
                clearTimeout(timer);
                reject(new Error(e.code === "ENOENT" ? `ffmpeg が見つかりません (${this.ffmpegPath})。ffmpeg.path を確かめてください` : `ffmpeg を起動できません: ${e.message}`));
            });
            child.on("close", (code) => {
                clearTimeout(timer);
                const image = Buffer.concat(out);
                if (image.length > 0) resolve(image);
                else reject(new Error(`録画から静止画を取り出せませんでした (${err.trim().split(/\r?\n/).pop() || `ffmpeg の終了コード ${code}`})`));
            });
        });
    }
}
