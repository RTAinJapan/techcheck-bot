// Discord のボイスチャンネル (VC) で、配信者のマイクの声を録音する (設計書 §7.3)。
//
// 本番のマイクの声は、配信とは別に Discord の VC で届く。その経路の音を、bot が VC に入って録り、あとで運営が聞いて確かめる。
// 録るのは Opus のパケットそのまま (.ogg に入れる。再エンコードしない)。音量は、録ったファイルを ffmpeg で測る。
//
// - Discord の音声の受信は、Discord が文書にしていない機能 (@discordjs/voice も「保証しない」としている)。
//   音声の暗号化 (DAVE) は @discordjs/voice が中で扱う。動かなくなったら、ここが最初に疑う所。
// - bot に要るもの: Gateway Intent の GuildVoiceStates、その VC の「チャンネルを表示」と「接続」(CONNECT)。
//   使う操作を変えたら、README の「トークンと権限」と docs/createToken.md も直す。

import { EndBehaviorType, VoiceConnectionStatus, entersState, joinVoiceChannel } from "@discordjs/voice";
import type { Client } from "discord.js";
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { VoicePort, VoiceRecording } from "../ports.js";
import { OggOpusWriter } from "./ogg.js";

const kJoinTimeoutMs = 20_000;

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

export class DiscordVoice implements VoicePort {
    constructor(
        private readonly client: Client,
        private readonly guildId: string,
        private readonly ffmpegPath: string,
        private readonly log: (msg: string) => void = console.error,
    ) {}

    async channelOf(userId: string): Promise<string | undefined> {
        const guild = await this.client.guilds.fetch(this.guildId);
        return guild.voiceStates.cache.get(userId)?.channelId ?? undefined;
    }

    async record(channelId: string, userId: string, file: string, seconds: number): Promise<VoiceRecording> {
        const guild = await this.client.guilds.fetch(this.guildId);
        mkdirSync(dirname(file), { recursive: true });
        // 聞く側なので、スピーカーミュートにはしない (すると音声が届かない)。こちらからは何も話さない
        const connection = joinVoiceChannel({ channelId, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: true });
        try {
            try {
                await entersState(connection, VoiceConnectionStatus.Ready, kJoinTimeoutMs);
            } catch {
                throw new Error(`VC に入れませんでした (bot に、その VC の「チャンネルを表示」と「接続」の権限があるかを確かめてください。状態: ${connection.state.status})`);
            }
            const out = createWriteStream(file);
            const ogg = new OggOpusWriter((chunk) => out.write(chunk));
            const stream = connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
            let bytes = 0;
            stream.on("data", (packet: Buffer) => {
                bytes += packet.length;
                ogg.packet(packet);
            });
            stream.on("error", (e: Error) => this.log(`VC の録音: ${e.message}`));
            await new Promise((r) => setTimeout(r, seconds * 1000));
            stream.destroy();
            ogg.end();
            await new Promise<void>((resolve, reject) => {
                out.on("error", reject);
                out.end(() => resolve());
            });
            const level = ogg.packets > 0 ? await this.measure(file).catch(() => undefined) : undefined;
            return { file, packets: ogg.packets, bytes, audioMs: Math.round(ogg.audioMs), ...level };
        } finally {
            connection.destroy();
        }
    }

    /** 録ったファイルの音量 (dBFS) を ffmpeg の volumedetect で測る */
    private measure(file: string): Promise<{ maxDb?: number; meanDb?: number; clippedPct?: number }> {
        return new Promise((resolve, reject) => {
            const child = spawn(this.ffmpegPath, ["-hide_banner", "-nostats", "-i", file, "-af", "volumedetect", "-f", "null", "-"], {
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
}
