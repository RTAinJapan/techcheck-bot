// 配信の静止画を、denpachan の録画ファイルから ffmpeg で取り出す。
//
// denpachan はテストの間ずっと録画している (SRT の枠も RTMP の枠も) ので、その録画の「今」に近い 1 枚を取り出せば、
// 配信に映っている絵が分かる。MediaConnect のサムネイル (フローごとに有効にする設定が要り、RTMP では使えない) に頼らずに済む。
//
// - 録画中のファイルは長さが分からないので、末尾からの指定 (-sseof) は使えない。録画ファイルの中の位置 (denpachan の
//   record.position) の少し手前を -ss で指定する。
// - その位置にフレームが無いことがある。そのときは手前へ探しに行く (fromRecording)。
//   - position は 1 秒ごとの値で、書いたパケットがファイルに出るまでにも少し間がある (普段は「少し手前」で足りる)。
//   - position を出さない版の denpachan では、record.seconds (録画を始めてからの時間) で代える。配信が途切れた時間は
//     ファイルに入らないので、途切れたあとは、その分だけファイルの終わりより先を指す。
// - bot と denpachan が同じ PC (または録画先を同じパスで見られる PC) で動いていること。別の PC なら、ファイルを開けずに失敗する。

import { spawn } from "node:child_process";
import type { StillPort } from "../ports.js";

const kTimeoutMs = 10_000;
/** 渡された位置より、ファイルの中身がこれだけ短いと見て、手前へ探しに行く幅 (秒)。届かなければ次の幅へ */
const kBackoffSec = [5, 10, 20, 40, 80, 160, 320, 640];
/** 取れる位置が見つかったあと、ファイルの終わりに寄せるために挟み込む回数 */
const kBisect = 3;

/** その位置にフレームが無い (ファイルの終わりより先) ことを表す */
class NoFrame extends Error {}

/** ファイルの at 秒の 1 枚を取り出す。その位置にフレームが無ければ undefined */
export type Grab = (file: string, at: number) => Promise<Buffer | undefined>;

export class FfmpegStill implements StillPort {
    /** ファイルごとの、渡された位置に対するファイルの中身の遅れ (秒)。次に取るときの最初の位置に使う */
    private readonly lag = new Map<string, number>();
    private lastError = "";
    private readonly grab: Grab;

    /** grab は試験用 (ffmpeg を起動せずに、探し方だけを確かめる) */
    constructor(
        private readonly ffmpegPath: string,
        grab?: Grab,
    ) {
        this.grab = grab ?? ((file, at) => this.ffmpeg(file, at));
    }

    /**
     * 録画の atSec 秒のあたりの 1 枚を取り出す。
     *
     * atSec は denpachan の record.position (録画ファイルの中の位置) から決めるので、普段は 1 回で取れる。
     * position を出さない版の denpachan では record.seconds (録画を始めてからの時間) から決めるが、配信が途切れた時間は
     * ファイルに入らないので、途切れたあとは、ファイルの中身の方が短い (OBS を始め直すと 10 秒ほど)。
     * その位置にフレームが無ければ、手前へ探しに行き、見つかったら、ファイルの終わりに寄せる。分かった遅れは覚えておき、
     * 次は最初からその位置を試す。
     */
    async fromRecording(file: string, atSec: number): Promise<Buffer> {
        const known = this.lag.get(file) ?? 0;
        const at = (back: number) => Math.max(0, atSec - back);
        const first = await this.grab(file, at(known));
        if (first) return first;
        let ng = known;
        let ok: number | undefined;
        let image: Buffer | undefined;
        for (const step of kBackoffSec) {
            const back = known + step;
            image = await this.grab(file, at(back));
            if (image) {
                ok = back;
                break;
            }
            ng = back;
            if (at(back) === 0) break;
        }
        if (!image || ok === undefined) throw new Error(`録画から静止画を取り出せませんでした (${this.lastError})`);
        let best: number = ok;
        let found: Buffer = image;
        for (let i = 0; i < kBisect; i++) {
            const mid: number = (ng + best) / 2;
            const closer = await this.grab(file, at(mid));
            if (closer) {
                best = mid;
                found = closer;
            } else {
                ng = mid;
            }
        }
        // ファイルへの書き込みは少し波打つので、次に同じ位置で外さないよう、1 秒の余裕を足して覚える
        this.lag.set(file, best + 1);
        // 古い録画の分はためない
        if (this.lag.size > 16) this.lag.delete(this.lag.keys().next().value!);
        return found;
    }

    private async ffmpeg(file: string, atSec: number): Promise<Buffer | undefined> {
        try {
            return await this.run(file, atSec);
        } catch (e) {
            if (e instanceof NoFrame) {
                this.lastError = e.message;
                return undefined;
            }
            throw e;
        }
    }

    private run(file: string, atSec: number): Promise<Buffer> {
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
                // 何も出なかった: その位置にフレームが無い (ファイルの終わりより先)、またはファイルを開けない
                else reject(new NoFrame(err.trim().split(/\r?\n/).pop() || `ffmpeg の終了コード ${code}`));
            });
        });
    }
}
