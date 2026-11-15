// ドメイン名から IPv4 アドレスを引く (フローの配信用のドメインが、そのフローの ingest の IP を指しているかを確かめるため)。
//
// まず DNS サーバに直接聞く (resolve4)。hosts ファイルや OS のキャッシュを通さないので、配信者から見える答えに近い。
// ただし Node のこの引き方 (c-ares) は、OS に設定された DNS サーバを見つけられない PC がある
// (Windows で、見つけられずに 127.0.0.1 へ聞いて ECONNREFUSED になる)。そのときは、OS の引き方 (lookup) で引き直す。
// どちらでも引けなければ、両方の失敗の理由を付けて投げる。

import { lookup, resolve4 } from "node:dns/promises";
import type { DnsPort } from "../ports.js";

type Resolve4 = (domain: string) => Promise<string[]>;
type Lookup4 = (domain: string) => Promise<string[]>;

const osLookup: Lookup4 = async (domain) => (await lookup(domain, { family: 4, all: true })).map((a) => a.address);

function reason(e: unknown): string {
    const err = e as { code?: string; message?: string };
    return err.code ?? err.message ?? String(e);
}

export class NodeDns implements DnsPort {
    constructor(
        private readonly direct: Resolve4 = resolve4,
        private readonly viaOs: Lookup4 = osLookup,
    ) {}

    async resolve(domain: string): Promise<string[]> {
        try {
            return await this.direct(domain);
        } catch (e1) {
            // その名前が無い (ENOTFOUND)、A レコードが無い (ENODATA) は DNS の答えなので、そのまま返す
            const code = (e1 as { code?: string }).code;
            if (code === "ENOTFOUND" || code === "ENODATA") throw new Error(`DNS に A レコードがありません: ${code}`);
            try {
                return await this.viaOs(domain);
            } catch (e2) {
                throw new Error(`DNS サーバに直接聞くと ${reason(e1)}、OS の引き方でも ${reason(e2)}`);
            }
        }
    }
}
