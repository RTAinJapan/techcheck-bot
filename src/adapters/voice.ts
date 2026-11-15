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
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { VoiceChannelInfo, VoicePort, VoiceRecording } from "../ports.js";
import { measureLevel, waveformImage } from "./level.js";
import { OggOpusWriter } from "./ogg.js";

export { parseVolumedetect } from "./level.js";

const kJoinTimeoutMs = 20_000;

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
            const level = ogg.packets > 0 ? await measureLevel(this.ffmpegPath, file).catch(() => undefined) : undefined;
            const waveform = ogg.packets > 0 ? await waveformImage(this.ffmpegPath, file).catch(() => undefined) : undefined;
            return { file, packets: ogg.packets, bytes, audioMs: Math.round(ogg.audioMs), ...level, waveform };
        } finally {
            connection.destroy();
        }
    }
}
