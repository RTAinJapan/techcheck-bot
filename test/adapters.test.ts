import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deniedFrom, iamUserName, kFlowActions, kGlobalActions, permissionLines } from "../src/adapters/aws-permissions.js";
import { NodeDns } from "../src/adapters/dns.js";
import { GoogleDrive, mimeTypeFor } from "../src/adapters/drive.js";
import { OggOpusWriter, oggCrc, opusPacketSamples } from "../src/adapters/ogg.js";
import { GoogleSheet } from "../src/adapters/sheet.js";
import { columnLetter, sheetColumns } from "../src/record.js";
import { FfmpegStill } from "../src/adapters/still.js";
import { parseVolumedetect } from "../src/adapters/voice.js";
import { WsReceiver } from "../src/adapters/receiver.js";
import { SqliteStore } from "../src/store.js";

describe("録音の書き出し (Ogg / Opus)", () => {
    it("Opus のパケットの長さを、先頭のバイトから求める", () => {
        // Discord の音声 (CELT、フルバンド、20 ms、ステレオ、1 フレーム)
        assert.equal(opusPacketSamples(Buffer.from([0xfc, 0x00])), 960);
        // SILK の 60 ms を 2 フレーム
        assert.equal(opusPacketSamples(Buffer.from([0x19, 0x00])), 2880 * 2);
        // フレーム数を 2 バイト目で持つ形 (3 フレーム × 10 ms)
        assert.equal(opusPacketSamples(Buffer.from([0xf3, 0x03])), 480 * 3);
        assert.equal(opusPacketSamples(Buffer.alloc(0)), 0);
    });

    it("Ogg のページを正しい形で書く (見出し 2 ページ、パケットごとに 1 ページ、最後に終わりの印、CRC)", () => {
        const pages: Buffer[] = [];
        const w = new OggOpusWriter((c) => pages.push(c));
        w.packet(Buffer.from([0xfc, 1, 2, 3]));
        w.packet(Buffer.concat([Buffer.from([0xfc]), Buffer.alloc(299, 7)])); // 255 バイトを超えるパケット
        w.end();
        assert.equal(pages.length, 4);
        assert.equal(w.packets, 2);
        assert.equal(w.audioMs, 40);
        for (const [i, p] of pages.entries()) {
            assert.equal(p.subarray(0, 4).toString("latin1"), "OggS");
            assert.equal(p.readUInt32LE(18), i, "ページの通し番号");
            const crc = p.readUInt32LE(22);
            const zeroed = Buffer.from(p);
            zeroed.writeUInt32LE(0, 22);
            assert.equal(oggCrc(zeroed), crc, "CRC");
        }
        assert.equal(pages[0]![5], 0x02, "最初のページは始まりの印");
        assert.equal(pages[0]!.subarray(28, 36).toString("latin1"), "OpusHead");
        assert.equal(pages[1]!.subarray(28, 36).toString("latin1"), "OpusTags");
        assert.equal(pages[3]![5], 0x04, "最後のページは終わりの印");
        assert.equal(pages[2]!.readBigUInt64LE(6), 960n);
        assert.equal(pages[3]!.readBigUInt64LE(6), 1920n);
        // 300 バイトのパケットは、255 + 45 の 2 つの区切りで書く
        assert.deepEqual([...pages[3]!.subarray(26, 29)], [2, 255, 45]);
    });

    it("ffmpeg の volumedetect の出力から、音量と振り切れの割合を読む", () => {
        const text = "[Parsed_volumedetect_0 @ 0] n_samples: 0\n[Parsed_volumedetect_0 @ 0] n_samples: 583680\n mean_volume: -15.5 dB\n max_volume: 0.0 dB\n histogram_0db: 1404\n";
        assert.deepEqual(parseVolumedetect(text), { maxDb: 0, meanDb: -15.5, clippedPct: 0.24 });
        assert.deepEqual(parseVolumedetect(""), { maxDb: undefined, meanDb: undefined, clippedPct: undefined });
    });
});

describe("AWS の権限の確認 (ポリシーのシミュレーション)", () => {
    const flows = [
        { name: "flow-a", arn: "arn:aws:mediaconnect:ap-northeast-1:123456789012:flow:1-AAAA:runner-a" },
        { name: "flow-b", arn: "arn:aws:mediaconnect:ap-northeast-1:123456789012:flow:1-BBBB:runner-b" },
    ];

    it("IAM ユーザーの ARN から名前を取る (ロールなどは対象外)", () => {
        assert.equal(iamUserName("arn:aws:iam::123456789012:user/techcheck-bot"), "techcheck-bot");
        assert.equal(iamUserName("arn:aws:iam::123456789012:user/bots/techcheck-bot"), "techcheck-bot");
        assert.equal(iamUserName("arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_TechcheckBot_abc/someone"), undefined);
        assert.equal(iamUserName(undefined), undefined);
    });

    it("シミュレーションの結果から、許可されていない操作を拾う", () => {
        const denied = deniedFrom([
            { EvalActionName: "mediaconnect:DescribeFlow", EvalResourceName: flows[0]!.arn, EvalDecision: "allowed" },
            { EvalActionName: "mediaconnect:StartFlow", EvalResourceName: flows[1]!.arn, EvalDecision: "implicitDeny" },
        ]);
        assert.deepEqual(denied, [{ action: "mediaconnect:StartFlow", resource: flows[1]!.arn, decision: "implicitDeny" }]);
    });

    it("コンソールに出す行: すべて許可、足りない (フローごと・理由ごとにまとめる)、確かめられなかった", () => {
        assert.deepEqual(permissionLines({ user: "techcheck-bot", denied: [] }, flows), ["AWS: 権限: bot の使う操作は、すべて許可されています (IAM ユーザー techcheck-bot)"]);
        const lines = permissionLines(
            {
                user: "techcheck-bot",
                denied: [
                    { action: "mediaconnect:StartFlow", resource: flows[1]!.arn, decision: "implicitDeny" },
                    { action: "mediaconnect:StopFlow", resource: flows[1]!.arn, decision: "implicitDeny" },
                    { action: "cloudwatch:GetMetricData", resource: "*", decision: "explicitDeny" },
                ],
            },
            flows,
        );
        assert.deepEqual(lines.slice(0, 2), ["AWS: 権限が足りません: フロー flow-b の StartFlow、StopFlow (許可が無い)", "AWS: 権限が足りません: cloudwatch:GetMetricData (明示的に拒否されている)"]);
        assert.match(lines[2]!, /IAM ユーザー techcheck-bot のポリシーを確かめてください/);
        assert.deepEqual(permissionLines({ skipped: "理由", denied: [] }, flows), ["AWS: 権限の確認はしていません: 理由"]);
    });

    it("確かめる操作は、bot が送るコマンドと同じ 6 つ", () => {
        assert.deepEqual([...kFlowActions, ...kGlobalActions].sort(), [
            "cloudwatch:GetMetricData",
            "mediaconnect:DescribeFlow",
            "mediaconnect:DescribeFlowSourceMetadata",
            "mediaconnect:DescribeFlowSourceThumbnail",
            "mediaconnect:StartFlow",
            "mediaconnect:StopFlow",
        ]);
    });
});

describe("Google スプレッドシート", () => {
    /** Sheets API の代わり。見出しと、シートの列の数を持つ */
    function fakeSheetsApi(header: string[], columnCount: number) {
        const calls: { method: string; path: string; body?: unknown }[] = [];
        const state = { columnCount };
        const fetchFn = (async (url: string, init: RequestInit) => {
            const path = decodeURIComponent(String(url).replace("https://sheets.googleapis.com/v4/spreadsheets/SHEET", ""));
            const body = init.body ? JSON.parse(String(init.body)) : undefined;
            calls.push({ method: init.method ?? "GET", path, body });
            const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });
            if (path.startsWith("?fields=sheets")) return json({ sheets: [{ properties: { sheetId: 7, title: "techcheck", gridProperties: { columnCount: state.columnCount } } }] });
            if (path === ":batchUpdate") {
                state.columnCount += body.requests[0].appendDimension.length;
                return json({});
            }
            if (path === "/values/techcheck!1:1") return json(header.length > 0 ? { values: [header] } : {});
            if (path.includes(":append")) return json({ updates: { updatedRange: "techcheck!A2:AH2" } });
            // values.update: シートの外のセルは断る (本物と同じ)
            const column = /!([A-Z]+)\d+/.exec(path)![1]!;
            const index = [...column].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
            if (index + (body.values[0].length - 1) > state.columnCount) return json({ error: { message: "exceeds grid limits" } }, 400);
            return json({});
        }) as unknown as typeof fetch;
        return { fetchFn, calls, state };
    }
    const token = async () => "token";

    it("見出しが無ければ、すべて書く", async () => {
        const api = fakeSheetsApi([], 26);
        const sheet = new GoogleSheet("SHEET", "techcheck", token, api.fetchFn);
        assert.equal(await sheet.append(["a"]), "techcheck!A2:AH2");
        assert.equal(api.state.columnCount, sheetColumns.length, "列が足りなければ足す");
        const header = api.calls.find((c) => c.method === "PUT")!;
        assert.equal(header.path, "/values/techcheck!A1?valueInputOption=RAW");
        assert.deepEqual((header.body as { values: string[][] }).values[0], [...sheetColumns]);
    });

    it("列があとから増えたシートでは、列を足してから、足りない後ろの見出しだけを書き足す", async () => {
        // 最後の列が増える前に作ったシート (見出しも、シートの列も 1 つ少ない)
        const old = sheetColumns.slice(0, -1);
        const api = fakeSheetsApi([...old], old.length);
        const sheet = new GoogleSheet("SHEET", "techcheck", token, api.fetchFn);
        await sheet.append(["a"]);
        assert.deepEqual(api.calls.find((c) => c.path === ":batchUpdate")!.body, { requests: [{ appendDimension: { sheetId: 7, dimension: "COLUMNS", length: 1 } }] });
        const header = api.calls.find((c) => c.method === "PUT")!;
        assert.equal(header.path, `/values/techcheck!${columnLetter(old.length)}1?valueInputOption=RAW`);
        assert.deepEqual((header.body as { values: string[][] }).values[0], [sheetColumns.at(-1)]);
        // 2 回目は、見出しもシートの列も確かめ直さない
        const before = api.calls.length;
        await sheet.append(["b"]);
        assert.equal(api.calls.length, before + 1);
    });

    it("行を足す前にセルを書き換えるとき (起動し直したあとのアップロードの結果など) も、列を足してから書く", async () => {
        const api = fakeSheetsApi([...sheetColumns.slice(0, -1)], sheetColumns.length - 1);
        const sheet = new GoogleSheet("SHEET", "techcheck", token, api.fetchFn);
        await sheet.update(`techcheck!${columnLetter(sheetColumns.length - 1)}7`, ["https://drive.google.com/drive/folders/x"]);
        assert.equal(api.state.columnCount, sheetColumns.length);
    });
});

describe("Google ドライブへのアップロード", () => {
    /** Drive API の代わり。受け取ったかたまりを覚え、決めた回数だけ 503 を返す */
    function fakeDriveApi(failChunks = 0) {
        const calls: { url: string; method: string; range?: string; bytes: number; body?: string }[] = [];
        const received: Buffer[] = [];
        let failures = failChunks;
        const fetchFn = (async (url: string, init: RequestInit) => {
            const headers = init.headers as Record<string, string>;
            const body = init.body;
            const bytes = body instanceof Uint8Array ? body.length : 0;
            calls.push({ url: String(url), method: init.method ?? "GET", range: headers["content-range"], bytes, body: typeof body === "string" ? body : undefined });
            if (String(url).includes("uploadType=resumable")) return new Response(null, { status: 200, headers: { location: "https://upload.example/session-1" } });
            if (String(url).startsWith("https://upload.example/")) {
                if (failures > 0) {
                    failures--;
                    return new Response("backend error", { status: 503 });
                }
                received.push(Buffer.from(body as Uint8Array));
                const [, end, size] = /bytes \d+-(\d+)\/(\d+)/.exec(headers["content-range"]!)!;
                return new Response(null, { status: Number(end) + 1 === Number(size) ? 200 : 308 });
            }
            return new Response(JSON.stringify({ id: "FOLDER-1" }), { status: 200 });
        }) as unknown as typeof fetch;
        return { fetchFn, calls, received };
    }
    const token = async () => "token";

    it("フォルダは、アップロード先の中に作る (共有ドライブに対応する指定を付ける)", async () => {
        const api = fakeDriveApi();
        const drive = new GoogleDrive("ROOT", token, api.fetchFn);
        assert.equal(await drive.createFolder("配信テスト 2026-11-15 20:08 pasta"), "FOLDER-1");
        assert.match(api.calls[0]!.url, /drive\/v3\/files\?supportsAllDrives=true/);
        assert.deepEqual(JSON.parse(api.calls[0]!.body!), { name: "配信テスト 2026-11-15 20:08 pasta", mimeType: "application/vnd.google-apps.folder", parents: ["ROOT"] });
        assert.equal(drive.folderUrl("FOLDER-1"), "https://drive.google.com/drive/folders/FOLDER-1");
    });

    it("ファイルは、かたまりに分けて順に送り、一時的な失敗はやり直す", async () => {
        const dir = mkdtempSync(join(tmpdir(), "techcheck-drive-"));
        try {
            const file = join(dir, "15 20-15-57.mkv");
            const data = Buffer.from(Array.from({ length: 700 }, (_, i) => i % 251));
            writeFileSync(file, data);
            const api = fakeDriveApi(2); // 最初のかたまりが 2 回失敗する
            const waits: number[] = [];
            await new GoogleDrive("ROOT", token, api.fetchFn, 256, async (ms) => void waits.push(ms)).upload(file, "FOLDER-1");
            assert.match(api.calls[0]!.url, /uploadType=resumable&supportsAllDrives=true/);
            assert.deepEqual(JSON.parse(api.calls[0]!.body!), { name: "15 20-15-57.mkv", parents: ["FOLDER-1"] });
            assert.deepEqual(api.calls.slice(1).map((c) => c.range), ["bytes 0-255/700", "bytes 0-255/700", "bytes 0-255/700", "bytes 256-511/700", "bytes 512-699/700"]);
            assert.deepEqual(waits, [2000, 4000]);
            assert.ok(Buffer.concat(api.received).equals(data), "送った中身が、ファイルと同じ");
            assert.equal(mimeTypeFor(file), "video/x-matroska");
            assert.equal(mimeTypeFor("a.ogg"), "audio/ogg");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("サービスアカウントでマイドライブに上げようとしたときは、直し方を添える", async () => {
        const fetchFn = (async () => new Response('{"error":{"errors":[{"reason":"storageQuotaExceeded"}],"message":"Service Accounts do not have storage quota."}}', { status: 403 })) as unknown as typeof fetch;
        await assert.rejects(new GoogleDrive("ROOT", token, fetchFn).createFolder("x"), /403 \(サービスアカウントには保存容量がありません。google\.drive\.folderId を、サービスアカウントをメンバーにした共有ドライブの中のフォルダにしてください\)/);
    });
});

describe("録画から静止画を取る", () => {
    /** 中身が end 秒までのファイル。その先を頼むと、フレームが無い */
    function recording(end: number) {
        const asked: number[] = [];
        const file = { end };
        const still = new FfmpegStill("ffmpeg", async (_file, at) => {
            asked.push(at);
            return at <= file.end ? Buffer.from(`frame@${at}`) : undefined;
        });
        return { still, asked, file };
    }

    it("その位置にフレームがあれば、1 回で取る", async () => {
        const { still, asked } = recording(400);
        assert.equal((await still.fromRecording("a.mkv", 398)).toString(), "frame@398");
        assert.deepEqual(asked, [398]);
    });

    it("配信が途切れてファイルの中身が短いときは、手前へ探して、終わりに寄せる。次からはその位置を先に試す", async () => {
        // 録画を始めて 398 秒だが、途中で 10 秒途切れたので、ファイルの中身は 388.8 秒まで
        const { still, asked, file } = recording(388.8);
        const image = (await still.fromRecording("a.mkv", 398)).toString();
        const at = Number(image.replace("frame@", ""));
        assert.ok(at <= 388.8 && at > 388.8 - 2, `終わりの 2 秒手前までに寄る (${at})`);
        assert.ok(asked.length <= 6, `試す回数 (${asked.length})`);
        // 5 秒後 (ファイルも 5 秒伸びた): 覚えた遅れを使って、1 回で取る
        file.end = 393.8;
        asked.length = 0;
        const next = Number((await still.fromRecording("a.mkv", 403)).toString().replace("frame@", ""));
        assert.deepEqual(asked.length, 1);
        assert.ok(next > at && next <= 393.8);
        // 別の録画には、覚えた遅れを使わない
        asked.length = 0;
        await still.fromRecording("b.mkv", 100);
        assert.deepEqual(asked, [100]);
    });

    it("どこにもフレームが無ければ (ファイルを開けない、など)、理由を付けて失敗する", async () => {
        const still = new FfmpegStill("ffmpeg", async () => undefined);
        await assert.rejects(still.fromRecording("a.mkv", 30), /録画から静止画を取り出せませんでした/);
    });
});

describe("ドメインを引く", () => {
    const fail = (code: string) => async () => {
        throw Object.assign(new Error(`query ${code}`), { code });
    };

    it("DNS サーバに直接聞けない PC では、OS の引き方で引き直す", async () => {
        // Windows で、Node が DNS サーバを見つけられずに 127.0.0.1 へ聞いて ECONNREFUSED になることがある
        const dns = new NodeDns(fail("ECONNREFUSED"), async () => ["203.0.113.10"]);
        assert.deepEqual(await dns.resolve("srt-a.example.jp"), ["203.0.113.10"]);
    });

    it("直接聞けたら、その答えを使う", async () => {
        const dns = new NodeDns(async () => ["203.0.113.10"], fail("SHOULD_NOT_BE_CALLED"));
        assert.deepEqual(await dns.resolve("srt-a.example.jp"), ["203.0.113.10"]);
    });

    it("名前が無いという答えは、そのまま失敗にする (OS の引き方では引き直さない)", async () => {
        const dns = new NodeDns(fail("ENOTFOUND"), async () => ["203.0.113.10"]);
        await assert.rejects(dns.resolve("nope.example.jp"), /A レコードがありません: ENOTFOUND/);
    });

    it("どちらでも引けなければ、両方の理由を付ける", async () => {
        const dns = new NodeDns(fail("ECONNREFUSED"), fail("EAI_AGAIN"));
        await assert.rejects(dns.resolve("srt-a.example.jp"), /DNS サーバに直接聞くと ECONNREFUSED、OS の引き方でも EAI_AGAIN/);
    });
});

describe("denpachan の受信口のクライアント", () => {
    it("URL にトークンを付ける", () => {
        assert.equal(WsReceiver.urlFor("127.0.0.1", 9100, ""), "ws://127.0.0.1:9100/ws");
        assert.equal(WsReceiver.urlFor("::1", 9100, "a b"), "ws://[::1]:9100/ws?token=a%20b");
    });

    it("channels を覚え、繋がっていないときは返さない", () => {
        const rx = new WsReceiver("ws://127.0.0.1:1/ws", () => {});
        rx.handle(JSON.stringify({ event: "channels", channels: [{ ch: 7, status: "live", testSlot: true, source: { protocol: "srt", mode: "caller" } }] }));
        // WebSocket を開いていないので connected() は false
        assert.equal(rx.connected(), false);
        assert.equal(rx.channel(7), undefined);
        rx.handle("not json");
    });

    it("engine の channels の形 (null、メッセージのオブジェクト) をそろえる", async () => {
        const { normalizeChannel } = await import("../src/adapters/receiver.js");
        // denpachan の engine (src/engine/metrics_view.cpp) が送る形: 止まっているチャンネル
        const stopped = normalizeChannel({
            ch: 7, name: "CH7", enabled: false, inUse: true, testSlot: true, status: "stopped",
            source: { protocol: "srt", mode: "caller", host: "mc.example", port: 5000, peer: "", connectedSec: 0 },
            video: null, latency: null, tcp: null, audio: null, record: null, rejectedSenders: null, lastError: null,
        })!;
        assert.equal(stopped.status, "stopped");
        assert.equal(stopped.testSlot, true);
        assert.equal(stopped.video, undefined);
        assert.equal(stopped.lastError, "");
        // 受信中: 値の無い数は null で来る
        const live = normalizeChannel({
            ch: 8, name: "CH8", enabled: true, testSlot: true, status: "live",
            source: { protocol: "rtmp", mode: "pull", peer: "x", connectedSec: 12 },
            video: { codec: "h264", width: 1920, height: 1080, fps: 59.9, outputFps: 60, bitrateMbps: 6, hwDecode: true, decodeErrors: null, droppedLate: 0, droppedQueue: 0 },
            latency: null, tcp: null,
            audio: { peakDb: [-12.5, -13], gaps: 0, silentSec: 0 },
            record: { state: "recording", file: "D:\\rec\\a.mkv", seconds: null },
            lastError: { id: "srt.unreachable", reason: "timeout" },
        })!;
        assert.equal(live.video?.fps, 59.9);
        assert.equal(live.video?.decodeErrors, undefined);
        assert.deepEqual(live.audio?.peakDb, [-12.5, -13]);
        assert.equal(live.record?.seconds, undefined);
        assert.equal(live.record?.position, undefined, "position を出さない版の denpachan");
        // 録画ファイルの中の位置 (途切れた時間を含まないので、seconds より小さい)
        const recording = normalizeChannel({ ch: 7, record: { state: "recording", file: "D:\rec\a.mkv", seconds: 398, position: 388.8 } })!;
        assert.deepEqual(recording.record, { state: "recording", file: "D:\rec\a.mkv", seconds: 398, position: 388.8 });
        assert.equal(live.lastError, 'srt.unreachable {"reason":"timeout"}');
        assert.equal(normalizeChannel({ name: "no ch" }), undefined);
    });

    it("繋がっていなければ call は失敗する", async () => {
        const rx = new WsReceiver("ws://127.0.0.1:1/ws", () => {});
        await assert.rejects(rx.call("getState", {}), /繋がっていません/);
    });
});

describe("SQLite の保存", () => {
    it("起動し直しても残る", () => {
        const dir = mkdtempSync(join(tmpdir(), "techcheck-"));
        try {
            const path = join(dir, "t.db");
            const a = new SqliteStore(path);
            a.set("queue", { entries: [{ userId: "U1" }] });
            a.set("queue", { entries: [{ userId: "U2" }] });
            a.close();
            const b = new SqliteStore(path);
            assert.deepEqual(b.get("queue"), { entries: [{ userId: "U2" }] });
            assert.equal(b.get("nothing"), undefined);
            b.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("スラッシュコマンドの定義", () => {
    it("Discord の決まり (名前、説明の長さ、選択肢) に合う", async () => {
        const { buildCommand } = await import("../src/discord/commands.js");
        const { testConfig } = await import("./helpers.js");
        const json = buildCommand(testConfig().flows).toJSON();
        assert.equal(json.name, "techcheck");
        const names = (json.options ?? []).map((o) => o.name);
        assert.deepEqual(names, ["start", "leave", "slot", "status", "shot", "latency", "latency-receiver", "rtmp", "cancel", "review"]);
    });
});
