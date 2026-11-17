// Google ドライブへのアップロード (設計書 §8.1)。テストの録画と録音を、テストごとのフォルダに上げる。
// サービスアカウントで Drive API v3 を直接呼ぶ (シートと同じキー)。
//
// - サービスアカウントには保存容量が無く、ファイルを持てない。上げる先は共有ドライブ (またはその中のフォルダ) にし、
//   サービスアカウントをその共有ドライブのメンバー (コンテンツ管理者か投稿者) にしておく。マイドライブのフォルダには上げられない。
// - 録画は数百 MB になるので、再開できるアップロード (resumable) で、かたまりごとに送る。
// - スコープは drive。サービスアカウントが触れるのは、共有されたものだけ。
//   使う操作を変えたら、README の「トークンと権限」と docs/createToken.md も直す。

import { JWT } from "google-auth-library";
import { readFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { DrivePort } from "../ports.js";

const kScope = "https://www.googleapis.com/auth/drive";
/** 1 回に送るかたまり。256 KiB の倍数であること (Drive API の決まり) */
const kChunkBytes = 16 * 1024 * 1024;
const kChunkRetries = 4;

const kMimeTypes: Record<string, string> = { mkv: "video/x-matroska", mp4: "video/mp4", ts: "video/mp2t", ogg: "audio/ogg", flv: "video/x-flv", webm: "video/webm" };

export function mimeTypeFor(file: string): string {
    return kMimeTypes[file.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

export class GoogleDrive implements DrivePort {
    private readonly token: () => Promise<string>;

    /** credentials は、サービスアカウントのキーのファイル。試験では、アクセストークンを返す関数を渡す */
    constructor(
        private readonly rootFolderId: string,
        credentials: string | (() => Promise<string>),
        private readonly fetchFn: typeof fetch = fetch,
        private readonly chunkBytes = kChunkBytes,
        private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    ) {
        if (typeof credentials === "function") {
            this.token = credentials;
        } else {
            const key = JSON.parse(readFileSync(credentials, "utf8")) as { client_email: string; private_key: string };
            const jwt = new JWT({ email: key.client_email, key: key.private_key, scopes: [kScope] });
            this.token = async () => (await jwt.getAccessToken()).token ?? "";
        }
    }

    folderUrl(folderId: string): string {
        return `https://drive.google.com/drive/folders/${folderId}`;
    }

    async createFolder(name: string): Promise<string> {
        const res = await this.fetchFn("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id", {
            method: "POST",
            headers: { ...(await this.auth()), "content-type": "application/json" },
            body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [this.rootFolderId] }),
        });
        if (!res.ok) throw new Error(await describeError("フォルダを作れません", res));
        return ((await res.json()) as { id: string }).id;
    }

    async upload(file: string, folderId: string): Promise<void> {
        const size = (await stat(file)).size;
        const mimeType = mimeTypeFor(file);
        const start = await this.fetchFn("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true", {
            method: "POST",
            headers: { ...(await this.auth()), "content-type": "application/json", "x-upload-content-type": mimeType, "x-upload-content-length": String(size) },
            body: JSON.stringify({ name: basename(file), parents: [folderId] }),
        });
        if (!start.ok) throw new Error(await describeError("アップロードを始められません", start));
        const session = start.headers.get("location");
        if (!session) throw new Error("アップロードの送り先が返ってきません");
        if (size === 0) {
            const res = await this.fetchFn(session, { method: "PUT", headers: { "content-length": "0", "content-range": "bytes */0" } });
            if (!res.ok) throw new Error(await describeError("アップロードに失敗しました", res));
            return;
        }
        const handle = await open(file, "r");
        try {
            let offset = 0;
            while (offset < size) {
                const length = Math.min(this.chunkBytes, size - offset);
                const chunk = Buffer.alloc(length);
                await handle.read(chunk, 0, length, offset);
                offset = await this.putChunk(session, chunk, offset, size);
            }
        } finally {
            await handle.close();
        }
    }

    /** かたまりを 1 つ送り、次に送る位置を返す。一時的な失敗 (5xx、429、通信の失敗) はやり直す */
    private async putChunk(session: string, chunk: Buffer, offset: number, size: number): Promise<number> {
        const end = offset + chunk.length;
        let last = "";
        for (let attempt = 0; attempt <= kChunkRetries; attempt++) {
            if (attempt > 0) await this.wait(2 ** attempt * 1000);
            let res: Response;
            try {
                res = await this.fetchFn(session, {
                    method: "PUT",
                    headers: { "content-length": String(chunk.length), "content-range": `bytes ${offset}-${end - 1}/${size}` },
                    body: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) as Uint8Array<ArrayBuffer>,
                });
            } catch (e) {
                last = e instanceof Error ? e.message : String(e);
                continue;
            }
            // 308: かたまりを受け取った (まだ続きがある)。200 / 201: 最後まで受け取った
            if (res.status === 308 || res.ok) return end;
            last = await describeError("アップロードに失敗しました", res);
            if (res.status < 500 && res.status !== 429) break;
        }
        throw new Error(last);
    }

    private async auth(): Promise<{ authorization: string }> {
        return { authorization: `Bearer ${await this.token()}` };
    }
}

async function describeError(what: string, res: Response): Promise<string> {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    // サービスアカウントでマイドライブに上げようとしたときの答え。直し方を添える
    const hint = /storageQuotaExceeded|do not have storage quota/i.test(text)
        ? " (サービスアカウントには保存容量がありません。google.drive.folderId を、サービスアカウントをメンバーにした共有ドライブの中のフォルダにしてください)"
        : res.status === 404
          ? " (google.drive.folderId のフォルダが見つかりません。サービスアカウントを、その共有ドライブのメンバーにしてあるかを確かめてください)"
          : "";
    return `Drive API: ${what}: ${res.status}${hint} ${text}`.trim();
}
