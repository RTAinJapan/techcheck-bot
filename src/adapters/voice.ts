// Discord のボイスチャンネル (VC) で、配信者のマイクの声を録音する (設計書 §7.3)。
//
// 本番のマイクの声は、配信とは別に Discord の VC で届く。その経路の音を、bot が VC に入って録り、あとで運営が聞いて確かめる。
// 録るのは Opus のパケットそのまま (.ogg に入れる。再エンコードしない)。音量は、録ったファイルを ffmpeg で測る。
//
// - Discord の音声の受信は、Discord が文書にしていない機能 (@discordjs/voice も「保証しない」としている)。
//   音声の暗号化 (DAVE) は @discordjs/voice が中で扱う。動かなくなったら、ここが最初に疑う所。
// - bot に要るもの: Gateway Intent の GuildVoiceStates、その VC の「チャンネルを表示」と「接続」(CONNECT)。
//   この 2 つの権限がある VC が、配信者に案内する候補になる (空いている所を service.ts が選ぶ)。
//   使う操作を変えたら、README の「トークンと権限」と docs/createToken.md も直す。

import { EndBehaviorType, VoiceConnectionStatus, entersState, joinVoiceChannel } from "@discordjs/voice";
import { ChannelType, PermissionFlagsBits, type Client } from "discord.js";
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { VoiceChannelInfo, VoicePort, VoiceRecording } from "../ports.js";
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

    async channels(): Promise<VoiceChannelInfo[]> {
        const guild = await this.client.guilds.fetch(this.guildId);
        const me = guild.members.me ?? (await guild.members.fetchMe());
        const list: (VoiceChannelInfo & { position: number })[] = [];
        for (const c of guild.channels.cache.values()) {
            if (c.type !== ChannelType.GuildVoice) continue;
            // 放置用 (AFK) のチャンネルでは話せない。人数の上限が 1 の所には、配信者と bot の両方は入れない
            if (c.id === guild.afkChannelId || c.userLimit === 1) continue;
            if (!c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])) continue;
            // 中にいる人は、Gateway の voice state から数える (メンバーの情報が手元に無い人も、人として数える)
            const members = [...guild.voiceStates.cache.values()].filter((vs) => vs.channelId === c.id && vs.id !== me.id && !vs.member?.user.bot).map((vs) => vs.id);
            list.push({ id: c.id, name: c.name, members, position: c.rawPosition });
        }
        return list.sort((a, b) => a.position - b.position).map(({ id, name, members }) => ({ id, name, members }));
    }

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
            const waveform = ogg.packets > 0 ? await this.waveform(file).catch(() => undefined) : undefined;
            return { file, packets: ogg.packets, bytes, audioMs: Math.round(ogg.audioMs), ...level, waveform };
        } finally {
            connection.destroy();
        }
    }

    /**
     * 録った声の波形の画像 (PNG、800x200)。配信者に、どれくらいの音量で届いたかを見せる。
     * 列ごとのピークで描くので、上下の赤い線 (0 dBFS) に届いていれば、音が割れている。
     */
    private waveform(file: string): Promise<Buffer | undefined> {
        const graph =
            "color=c=0x2B2D31:s=800x200[bg];" +
            "[0:a]aformat=channel_layouts=mono,showwavespic=s=800x200:colors=0x57F287:filter=peak[fg];" +
            "[bg][fg]overlay=format=auto," +
            "drawbox=x=0:y=0:w=800:h=2:color=0xED4245:t=fill,drawbox=x=0:y=198:w=800:h=2:color=0xED4245:t=fill";
        const args = ["-hide_banner", "-loglevel", "error", "-i", file, "-filter_complex", graph, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"];
        return new Promise((resolve, reject) => {
            const child = spawn(this.ffmpegPath, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
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
