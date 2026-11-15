// Opus のパケットを Ogg のファイル (.ogg) に書く、最小限の書き手 (RFC 3533、RFC 7845)。
// Discord の音声の受信で届くのは Opus のパケットだけなので、入れ物 (Ogg) をここで付ける。
// デコードはしない (あとで人が聞くための録音。音量は ffmpeg で測る)。

const kCrcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let r = i << 24;
        for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
        table[i] = r >>> 0;
    }
    return table;
})();

/** Ogg のページの CRC (多項式 0x04c11db7、反転なし、初期値 0) */
export function oggCrc(data: Buffer): number {
    let crc = 0;
    for (const byte of data) crc = ((crc << 8) ^ kCrcTable[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
    return crc;
}

/** Opus のパケット 1 つが持つ音の長さ (48 kHz のサンプル数)。先頭の TOC バイトから求める (RFC 6716 §3.1) */
export function opusPacketSamples(packet: Buffer): number {
    if (packet.length === 0) return 0;
    const toc = packet[0]!;
    const config = toc >> 3;
    // 1 フレームの長さ (48 kHz のサンプル数)
    const frame = config < 12 ? [480, 960, 1920, 2880][config % 4]! : config < 16 ? [480, 960][config % 2]! : [120, 240, 480, 960][config % 4]!;
    const code = toc & 3;
    const frames = code === 0 ? 1 : code === 3 ? (packet[1] ?? 0) & 0x3f : 2;
    return frame * frames;
}

export class OggOpusWriter {
    private readonly serial = (Math.random() * 0xffffffff) >>> 0;
    private sequence = 0;
    private granule = 0n;
    private held: Buffer | undefined; // 最後のページに「終わり」の印を付けるため、1 つ遅らせて書く
    /** 書いたパケットの数と、音の長さ (ミリ秒) */
    packets = 0;
    get audioMs(): number {
        return Number(this.granule) / 48;
    }

    constructor(
        private readonly write: (chunk: Buffer) => void,
        channels = 2,
    ) {
        const head = Buffer.alloc(19);
        head.write("OpusHead", 0, "latin1");
        head[8] = 1; // 版
        head[9] = channels;
        head.writeUInt16LE(0, 10); // pre-skip
        head.writeUInt32LE(48000, 12); // 元のサンプリング周波数
        head.writeInt16LE(0, 16); // 出力のゲイン
        head[18] = 0; // チャンネルの並び (0 = モノラルかステレオ)
        this.page(head, 0x02, 0n);
        const vendor = Buffer.from("techcheck-bot", "utf8");
        const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
        tags.write("OpusTags", 0, "latin1");
        tags.writeUInt32LE(vendor.length, 8);
        vendor.copy(tags, 12);
        tags.writeUInt32LE(0, 12 + vendor.length); // コメントは無し
        this.page(tags, 0, 0n);
    }

    packet(opus: Buffer): void {
        this.flushHeld(false);
        this.held = Buffer.from(opus);
    }

    end(): void {
        this.flushHeld(true);
    }

    private flushHeld(last: boolean): void {
        if (!this.held) return;
        this.granule += BigInt(opusPacketSamples(this.held));
        this.packets++;
        this.page(this.held, last ? 0x04 : 0, this.granule);
        this.held = undefined;
    }

    /** 1 ページに 1 パケットを入れて書く (パケットは 255 × 255 バイトより小さい前提。Opus は最大でも 1275 バイト × 数フレーム) */
    private page(data: Buffer, flags: number, granule: bigint): void {
        const lacing: number[] = [];
        for (let rest = data.length; ; rest -= 255) {
            if (rest < 255) {
                lacing.push(rest);
                break;
            }
            lacing.push(255);
        }
        const header = Buffer.alloc(27 + lacing.length);
        header.write("OggS", 0, "latin1");
        header[4] = 0; // 版
        header[5] = flags; // 0x02 = 始まり、0x04 = 終わり
        header.writeBigUInt64LE(granule, 6);
        header.writeUInt32LE(this.serial, 14);
        header.writeUInt32LE(this.sequence++, 18);
        header.writeUInt32LE(0, 22); // CRC (あとで入れる)
        header[26] = lacing.length;
        Buffer.from(lacing).copy(header, 27);
        const page = Buffer.concat([header, data]);
        page.writeUInt32LE(oggCrc(page), 22);
        this.write(page);
    }
}
