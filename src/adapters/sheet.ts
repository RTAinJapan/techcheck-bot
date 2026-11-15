// Google スプレッドシート (設計書 §8)。サービスアカウントで Sheets API v4 を直接呼ぶ。
// シートはサービスアカウントのメールアドレスに「編集者」で共有しておく (README の「トークンと権限」。キーの作り方は docs/createToken.md)。
// 使うのは values の get / append / update と、列を足す batchUpdate だけなので、スコープは spreadsheets で足りる。

import { JWT } from "google-auth-library";
import { readFileSync } from "node:fs";
import type { SheetPort } from "../ports.js";
import { columnLetter, sheetColumns } from "../record.js";

const kScope = "https://www.googleapis.com/auth/spreadsheets";

interface SheetProperties {
    sheetId: number;
    title: string;
    gridProperties?: { columnCount?: number };
}

export class GoogleSheet implements SheetPort {
    private readonly token: () => Promise<string>;
    private headerChecked = false;
    private gridChecked = false;

    /** credentials は、サービスアカウントのキーのファイル。試験では、アクセストークンを返す関数を渡す */
    constructor(
        private readonly spreadsheetId: string,
        private readonly tab: string,
        credentials: string | (() => Promise<string>),
        private readonly fetchFn: typeof fetch = fetch,
    ) {
        if (typeof credentials === "function") {
            this.token = credentials;
        } else {
            const key = JSON.parse(readFileSync(credentials, "utf8")) as { client_email: string; private_key: string };
            const jwt = new JWT({ email: key.client_email, key: key.private_key, scopes: [kScope] });
            this.token = async () => (await jwt.getAccessToken()).token ?? "";
        }
    }

    url(): string {
        return `https://docs.google.com/spreadsheets/d/${this.spreadsheetId}`;
    }

    async append(row: (string | number)[]): Promise<string> {
        await this.ensureHeader();
        const range = encodeURIComponent(`${this.tab}!A1`);
        const r = await this.request(`/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, "POST", { values: [row] });
        const updated = (r as { updates?: { updatedRange?: string } }).updates?.updatedRange;
        if (!updated) throw new Error("書いた行の場所が返ってきません");
        return updated;
    }

    async update(range: string, values: (string | number)[]): Promise<void> {
        await this.ensureGrid();
        await this.request(`/values/${encodeURIComponent(range)}?valueInputOption=RAW`, "PUT", { values: [values] });
    }

    /**
     * 1 行目が空なら見出しを書く。見出しがすでにあり、列があとから増えた (bot の更新で後ろに足した) ときは、足りない後ろの見出しだけを書き足す。
     * すでにある見出しは書き換えない。
     */
    private async ensureHeader(): Promise<void> {
        if (this.headerChecked) return;
        const r = (await this.request(`/values/${encodeURIComponent(`${this.tab}!1:1`)}`, "GET")) as { values?: string[][] };
        const have = r.values?.[0]?.length ?? 0;
        if (have === 0) await this.update(`${this.tab}!A1`, [...sheetColumns]);
        else if (have < sheetColumns.length) await this.update(`${this.tab}!${columnLetter(have)}1`, sheetColumns.slice(have));
        this.headerChecked = true;
    }

    /**
     * シート (タブ) の列が、bot の書く列の数だけあるようにする。足りなければ、後ろに足す。
     * シートの外のセルに values.update で書くと、「exceeds grid limits」で断られる (列があとから増えたシートで起きる)。
     */
    private async ensureGrid(): Promise<void> {
        if (this.gridChecked) return;
        const r = (await this.request("?fields=sheets(properties(sheetId,title,gridProperties(columnCount)))", "GET")) as { sheets?: { properties: SheetProperties }[] };
        const p = r.sheets?.map((s) => s.properties).find((x) => x.title === this.tab);
        const columns = p?.gridProperties?.columnCount;
        if (p && columns !== undefined && columns < sheetColumns.length) {
            await this.request(":batchUpdate", "POST", { requests: [{ appendDimension: { sheetId: p.sheetId, dimension: "COLUMNS", length: sheetColumns.length - columns } }] });
        }
        this.gridChecked = true;
    }

    private async request(path: string, method: string, body?: unknown): Promise<unknown> {
        const res = await this.fetchFn(`https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheetId}${path}`, {
            method,
            headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`Sheets API ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return res.json();
    }
}
