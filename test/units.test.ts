import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseFrameRate } from "../src/adapters/aws.js";
import { DiscordWebhook, retryAfterMs } from "../src/adapters/webhook.js";
import { advise, multiplierFor, nextLatency, verdictFor, type SrtSample } from "../src/advisor.js";
import { defaultChecks, evaluateAudioStep, voiceStep } from "../src/checks.js";
import { ConfigError, expandEnv, parseConfig } from "../src/config.js";
import { I18n, checkParity, langFromLocale } from "../src/i18n.js";
import { buildRow, columnLetter, formatRecPos, sheetColumns } from "../src/record.js";
import { loadQueue, loadSlots, slotConfigSnapshot } from "../src/service.js";
import { baseYaml, goodSample, here, messagesDir, testConfig, twoSlotsYaml } from "./helpers.js";

const table = testConfig().judge.multipliers;

describe("advisor (srt_advisor.h と同じ規則)", () => {
    it("ロス率で倍率が決まる", () => {
        assert.equal(multiplierFor(0, table), 3);
        assert.equal(multiplierFor(1, table), 3);
        assert.equal(multiplierFor(2, table), 4);
        assert.equal(multiplierFor(8, table), 8);
        assert.equal(multiplierFor(50, table), 10);
    });

    it("10 秒分そろうまでは計測中", () => {
        const w = Array.from({ length: 9 }, (_, i) => goodSample(i));
        assert.equal(advise(w, 120, table).verdict, "measuring");
    });

    it("RTT の最大 × 倍率を 10 ms 単位に切り上げる", () => {
        const w: SrtSample[] = Array.from({ length: 60 }, (_, i) => ({ ...goodSample(i), rttMs: i === 30 ? 41 : 20 }));
        const a = advise(w, 120, table);
        assert.equal(a.recommendMs, 130); // 41 × 3 = 123 → 130
        assert.equal(a.verdict, "tight");
        assert.equal(a.headroomMs, -10);
        assert.equal(advise(w, 300, table).verdict, "generous");
        assert.equal(advise(w, 200, table).verdict, "ok");
    });

    it("回復できなかったパケットがあれば足りない (今の 1.5 倍以上)", () => {
        const w: SrtSample[] = Array.from({ length: 60 }, (_, i) => ({ ...goodSample(i), notRecovered: i === 10 ? 3 : 0 }));
        const a = advise(w, 200, table);
        assert.equal(a.verdict, "insufficient");
        assert.equal(a.recommendMs, 300);
        assert.equal(a.drops, 3);
    });

    it("ロス率は受信数とロス率から戻して求める", () => {
        const w: SrtSample[] = Array.from({ length: 60 }, (_, i) => ({ ...goodSample(i), lossPct: 5 }));
        const a = advise(w, 120, table);
        assert.ok(Math.abs(a.lossPct - 5) < 0.01);
        assert.equal(a.multiplier, 6);
    });

    it("下限 20 ms", () => {
        const w: SrtSample[] = Array.from({ length: 20 }, (_, i) => ({ ...goodSample(i), rttMs: 1 }));
        assert.equal(advise(w, 120, table).recommendMs, 20);
    });

    it("次の latency は max(推奨, 今 × 1.5) で、上限で抑える", () => {
        assert.equal(nextLatency(120, 130, 2000), 180);
        assert.equal(nextLatency(120, 400, 2000), 400);
        assert.equal(nextLatency(1500, 0, 2000), 2000);
        assert.equal(verdictFor(120, 0, 0), "measuring");
    });
});

describe("checks (音声の参考の判定)", () => {
    const step = (id: string) => defaultChecks.find((s) => s.id === id)!;
    it("sound: 8 割以上の秒で -40 dB 以上なら OK", () => {
        assert.equal(evaluateAudioStep(step("game-audio"), Array(10).fill(-20), undefined, -60).verdict, "ok");
        assert.equal(evaluateAudioStep(step("game-audio"), [...Array(7).fill(-20), -70, -70, -70], undefined, -60).verdict, "ng");
    });
    it("silence: -60 dB 未満なら OK で、最大をノイズとして返す", () => {
        assert.deepEqual(evaluateAudioStep(step("silence"), [-80, -75, -72], undefined, -60), { verdict: "ok", value: -72 });
        assert.equal(evaluateAudioStep(step("silence"), [-80, -30], undefined, -60).verdict, "ng");
    });
    it("quiet: ノイズ (下限 -60 dB) + 6 dB を超えたら載っている", () => {
        assert.equal(evaluateAudioStep(step("mic"), [-70, -58], -72, -60).verdict, "ok"); // 基準 -60 + 6 = -54
        assert.equal(evaluateAudioStep(step("mic"), [-70, -30], -72, -60).verdict, "ng");
    });
    it("レベルが無ければ判定しない", () => {
        assert.equal(evaluateAudioStep(step("mic"), [], -72, -60).verdict, "unknown");
    });
});

describe("config", () => {
    it("${ENV} を環境変数で置き換え、無いものを返す", () => {
        assert.deepEqual(expandEnv("a ${X} b ${Y}", { X: "1" }), { text: "a 1 b ", missing: ["Y"] });
    });
    it("既定値が入る", () => {
        const c = testConfig();
        assert.equal(c.latency.initialMs, 120);
        assert.equal(c.latency.maxMs, 2000);
        assert.equal(c.flows[0]!.pbkeylen, 16);
        assert.equal(c.i18n.fallback, "en");
        assert.equal(c.guide.expected.fps, 60);
        assert.deepEqual([c.guide.expected.width, c.guide.expected.height, c.guide.expected.bitrateKbps, c.guide.expected.keyframeSec], [1536, 864, 3000, 2]);
        assert.equal(c.checks.length, defaultChecks.length);
    });
    it("webhook の URL は省ける", () => {
        const c = parseConfig(baseYaml.replace(/notify:\n {2}webhookUrl: .*\n/, ""), {});
        assert.equal(c.notify.webhookUrl, "");
    });
    it("省ける項目は、${ENV} の環境変数が無くても (値が空になっても) 読める", () => {
        // `webhookUrl: ${TECHCHECK_WEBHOOK_URL}` は、環境変数が無いと `webhookUrl:` (null) になる
        const yaml = baseYaml.replace("webhookUrl: https://discord.com/api/webhooks/1/x", "webhookUrl: ${TECHCHECK_WEBHOOK_URL}");
        assert.equal(parseConfig(yaml, {}).notify.webhookUrl, "");
        assert.equal(parseConfig(yaml, { TECHCHECK_WEBHOOK_URL: "https://example.com/hook" }).notify.webhookUrl, "https://example.com/hook");
        const c = parseConfig(`${baseYaml}denpachan: { token: \${DENPACHAN_TOKEN} }\n`.replace("  key: key-1\n", "  key: key-1\n  statsUrl: ${RTMP_STATS_URL}\n"), {});
        assert.equal(c.denpachan.token, "");
        assert.equal(c.rtmp.statsUrl, "");
    });
    it("見本の設定 (config.example.yaml) は、必須の環境変数だけで読める", () => {
        const example = readFileSync(join(here, "..", "config.example.yaml"), "utf8");
        const c = parseConfig(example, { DISCORD_TOKEN: "t", RTMP_KEY: "k" });
        assert.equal(c.notify.webhookUrl, "", "TECHCHECK_WEBHOOK_URL が無ければ、結果の通知を送らない");
        assert.deepEqual(c.flows.map((f) => f.passphrase), ["", ""], "FLOW_x_PASSPHRASE が無ければ、パスフレーズなし");
        assert.equal(c.slots.srt.length, 1);
    });
    it("必須の項目が無ければ、場所と環境変数の名前を出す", () => {
        assert.throws(
            () => parseConfig(baseYaml.replace("token: t", "token: ${DISCORD_TOKEN}"), {}),
            (e: unknown) => e instanceof ConfigError && /discord\.token/.test(e.message) && /DISCORD_TOKEN/.test(e.message),
        );
    });
    it("slots.srt の flow は flows にある名前", () => {
        assert.throws(() => parseConfig(baseYaml.replace("flow: flow-a", "flow: nope"), {}), /slots\.srt\.0\.flow.*"nope" は flows にありません/);
    });
    it("SRT の枠は、1 つならそのまま、複数なら並べて書ける", () => {
        assert.deepEqual(testConfig().slots.srt, [{ flow: "flow-a", channel: 7, enabled: true }]);
        assert.deepEqual(testConfig("", twoSlotsYaml).slots.srt, [
            { flow: "flow-a", channel: 7, enabled: true },
            { flow: "flow-b", channel: 6, enabled: true },
        ]);
        const spare = twoSlotsYaml.replace("{ flow: flow-b, channel: 6 }", "{ flow: flow-b, channel: 6, enabled: false }");
        assert.equal(parseConfig(spare, {}).slots.srt[1]!.enabled, false);
    });
    it("同じフローやチャンネルを 2 つの枠で使えない", () => {
        assert.throws(() => parseConfig(twoSlotsYaml.replace("{ flow: flow-b, channel: 6 }", "{ flow: flow-a, channel: 6 }"), {}), /フロー "flow-a" を 2 つの枠で/);
        assert.throws(() => parseConfig(twoSlotsYaml.replace("{ flow: flow-b, channel: 6 }", "{ flow: flow-b, channel: 7 }"), {}), /チャンネル 7 を 2 つの枠で/);
        assert.throws(() => parseConfig(twoSlotsYaml.replace("{ flow: flow-b, channel: 6 }", "{ flow: flow-b, channel: 8 }"), {}), /チャンネル 8 を 2 つの枠で/);
    });
    it("保存してある枠は、設定ファイルのその枠が変わっていなければ使い、変わっていれば設定ファイルの値にする", () => {
        const two = testConfig("", twoSlotsYaml);
        const base = slotConfigSnapshot(two);
        // 保存が無ければ設定ファイルの値
        assert.deepEqual(loadSlots(undefined, undefined, two).srt.map((s) => s.channel), [7, 6]);
        // /techcheck slot で設定し直した値 (ch5、運営が止めた) は、設定ファイルが同じなら残る
        const saved = { srt: [{ flow: "flow-a", channel: 5, enabled: false, stoppedByProblem: false }, { flow: "flow-b", channel: 6, enabled: true }], rtmp: { channel: 8, enabled: false } };
        assert.deepEqual(loadSlots(saved, base, two), saved);
        // 設定ファイルの 1 番の枠のチャンネルを書き換えたら、その枠は設定ファイルの値になる。変えていない枠は保存の値のまま
        const edited = parseConfig(twoSlotsYaml.replace("{ flow: flow-a, channel: 7 }", "{ flow: flow-a, channel: 1 }").replace("rtmp: { channel: 8 }", "rtmp: { channel: 2 }"), {});
        const savedBoth = { ...saved, srt: [saved.srt[0]!, { flow: "flow-b", channel: 6, enabled: false, stoppedByProblem: false }] };
        assert.deepEqual(loadSlots(savedBoth, base, edited), {
            srt: [{ flow: "flow-a", channel: 1, enabled: true }, { flow: "flow-b", channel: 6, enabled: false, stoppedByProblem: false }],
            rtmp: { channel: 2, enabled: true },
        });
        // もとにした設定を保存していなかった版の保存は、設定ファイルの値にする
        assert.deepEqual(loadSlots(saved, undefined, two).srt.map((s) => s.channel), [7, 6]);
        // 枠が 1 つだったときの形 (srt が配列でない) も読める
        const one = testConfig();
        assert.deepEqual(loadSlots({ srt: saved.srt[0], rtmp: saved.rtmp }, slotConfigSnapshot(one), one).srt, [saved.srt[0]]);
        // 設定の枠を減らしたら、余った分は使わない
        assert.equal(loadSlots(saved, base, one).srt.length, 1);
    });
    it("bot が問題で止めた枠は、起動し直すと再開する。運営が止めた枠は止めたまま", () => {
        const two = testConfig("", twoSlotsYaml);
        const base = slotConfigSnapshot(two);
        const notes: string[] = [];
        const saved = {
            srt: [
                { flow: "flow-a", channel: 7, enabled: false, stoppedByProblem: true },
                { flow: "flow-b", channel: 6, enabled: false, stoppedByProblem: false },
            ],
            rtmp: { channel: 8, enabled: true },
        };
        const loaded = loadSlots(saved, base, two, (m) => notes.push(m));
        assert.deepEqual(loaded.srt, [{ flow: "flow-a", channel: 7, enabled: true }, saved.srt[1]]);
        assert.equal(notes.length, 1);
        assert.match(notes[0]!, /SRT の 1 番の枠: 前回は問題があって止めていました。起動し直したので、受付を再開します/);
        // 誰が止めたかの印を付けていなかった版の保存は、問題で止めたものとして再開する
        const legacy = { srt: [{ flow: "flow-a", channel: 7, enabled: false }, { flow: "flow-b", channel: 6, enabled: true }], rtmp: saved.rtmp };
        assert.equal(loadSlots(legacy, base, two).srt[0]!.enabled, true);
        // 設定ファイルを書き換えた枠は、そのことを知らせる
        const edited = parseConfig(twoSlotsYaml.replace("{ flow: flow-a, channel: 7 }", "{ flow: flow-a, channel: 1 }"), {});
        const notes2: string[] = [];
        loadSlots(saved, base, edited, (m) => notes2.push(m));
        assert.match(notes2[0]!, /SRT の 1 番の枠: 設定ファイルが変わったので、設定ファイルの値にしました \(保存してあった値: フロー flow-a \/ ch7 \/ 止めている\)/);
    });
    it("保存してある待ちの列は、知らせが 1 人だけだったときの形も読める", () => {
        assert.deepEqual(loadQueue({ entries: [], offer: { userId: "U1", offeredAt: 1 } }).offers, [{ userId: "U1", offeredAt: 1 }]);
        assert.deepEqual(loadQueue(undefined), { entries: [], offers: [] });
    });
    it("denpachan.configure が true なら、フローに output が要る", () => {
        assert.throws(() => parseConfig(`${baseYaml}denpachan: { configure: true }\n`, {}), /flows\.0\.output.*フロー "flow-a" に output/);
        const ok = parseConfig(`${baseYaml.replace("    passphrase: pass-a\n", "    passphrase: pass-a\n    output: sub\n")}denpachan: { configure: true }\n`, {});
        assert.equal(ok.flows[0]!.output, "sub");
        assert.equal(testConfig().denpachan.configure, false, "既定は false");
    });
    it("voice の手順は voice.enabled が要る。有効なら既定の手順の最後に入る", () => {
        const custom = `checks: ${JSON.stringify([voiceStep])}\n`;
        assert.throws(() => parseConfig(baseYaml + custom, {}), /voice の手順を使うには、voice\.enabled を true/);
        assert.equal(parseConfig(`${baseYaml}voice: { enabled: true }\n${custom}`, {}).checks.length, 1);
        const on = parseConfig(`${baseYaml}voice: { enabled: true }\n`, {});
        assert.deepEqual(on.checks.map((c) => c.id), [...defaultChecks.map((c) => c.id), "voice"]);
        assert.equal(on.voice.dir, "./voice");
        assert.equal(defaultChecks.some((c) => c.kind === "voice"), false, "既定の手順そのものは変えない");
    });
    it("quiet の手順の前に silence が要る", () => {
        const yaml = `${baseYaml}checks:\n  - { id: q, kind: quiet, seconds: 5, text: { ja: a, en: a }, failHint: { ja: b, en: b } }\n`;
        assert.throws(() => parseConfig(yaml, {}), /silence/);
    });
    it("denpachan を loopback 以外にするならトークンが要る", () => {
        assert.throws(() => parseConfig(`${baseYaml}denpachan: { host: 192.168.1.5 }\n`, {}), /denpachan\.token/);
    });
});

describe("i18n", () => {
    it("ja と en のキーと差し込みがそろっている", () => {
        I18n.load(messagesDir); // 食い違っていれば例外
        assert.deepEqual(checkParity({ ja: { a: "x {n}" }, en: { a: "y" } }).length, 1);
        assert.deepEqual(checkParity({ ja: { a: "x" }, en: {} }).length, 1);
    });
    it("コードで使っているキーがすべてある", () => {
        const i18n = I18n.load(messagesDir);
        const src = join(here, "..", "src");
        const files = readdirSync(src, { recursive: true }).filter((f) => String(f).endsWith(".ts"));
        const used = new Set<string>();
        for (const f of files) {
            const text = readFileSync(join(src, String(f)), "utf8");
            for (const m of text.matchAll(/\bt\([^,]+,\s*"([a-zA-Z]+\.[a-zA-Z.]+)"/g)) used.add(m[1]!);
            for (const m of text.matchAll(/"(button\.[a-zA-Z]+|modal\.[a-zA-Z]+)"/g)) used.add(m[1]!);
        }
        for (const v of ["ok", "ng", "unknown"]) used.add(`verdict.${v}`);
        assert.ok(used.size > 40, `見つけたキーが少なすぎる (${used.size})`);
        const missing = [...used].filter((k) => !i18n.has(k));
        assert.deepEqual(missing, []);
    });
    it("Discord の言語設定から決める", () => {
        assert.equal(langFromLocale("ja", "en"), "ja");
        assert.equal(langFromLocale("en-US", "ja"), "en");
        assert.equal(langFromLocale("ko", "en"), "en");
        assert.equal(langFromLocale(undefined, "ja"), "ja");
    });
    it("差し込み", () => {
        const i18n = I18n.load(messagesDir);
        assert.match(i18n.t("en", "judge.ok", { latencyMs: 180, latencyUs: 180000 }), /180 ms.*`latency=180000`/);
        assert.match(i18n.t("ja", "judge.ok", { latencyMs: 180, latencyUs: 180000 }), /180 ms.*`latency=180000`/);
    });
    it("配信者に latency を ms で伝える文には、OBS の URL に入れる値 (マイクロ秒) も出す", () => {
        const i18n = I18n.load(messagesDir);
        for (const lang of ["ja", "en"] as const) {
            assert.match(i18n.t(lang, "finish.latency", { latencyMs: 180, latencyUs: 180000 }), /180 ms.*`latency=180000`/);
            assert.match(i18n.t(lang, "judge.generous", { recommendMs: 60, recommendUs: 60000 }), /60 ms.*`latency=60000`/);
            assert.match(i18n.t(lang, "latency.ask", { latencyMs: 180, latencyUs: 180000, url: "srt://x" }), /180 ms[\s\S]*180000/);
        }
    });
});

describe("record", () => {
    it("列の文字", () => {
        assert.equal(columnLetter(0), "A");
        assert.equal(columnLetter(25), "Z");
        assert.equal(columnLetter(26), "AA");
        assert.equal(columnLetter(31), "AF");
    });
    it("録画の位置", () => {
        assert.equal(formatRecPos(75), "01:15");
        assert.equal(formatRecPos(3675), "1:01:15");
        assert.equal(formatRecPos(undefined), "?");
    });
    it("行は見出しと同じ数", () => {
        const s = {
            createdAt: 0, displayName: "a", userId: "1", lang: "ja", srt: { flowName: "f", channel: 7 }, protocol: "srt",
            summary: {}, disconnects: 0, raises: 0, results: [], recordFiles: [],
        } as unknown as Parameters<typeof buildRow>[0];
        assert.equal(buildRow(s, defaultChecks, "done", "u").length, sheetColumns.length);
    });
});

describe("webhook", () => {
    const ok = () => new Response(null, { status: 204 });
    it("URL が無ければ送らない", async () => {
        let calls = 0;
        await new DiscordWebhook("", async () => (calls++, ok())).send({});
        assert.equal(calls, 0);
    });
    it("429 は Retry-After に従ってやり直す", async () => {
        const waits: number[] = [];
        let calls = 0;
        const fetchFn = async () => (++calls < 3 ? new Response("slow", { status: 429, headers: { "retry-after": "2" } }) : ok());
        await new DiscordWebhook("https://x", fetchFn as typeof fetch, async (ms) => void waits.push(ms)).send({});
        assert.equal(calls, 3);
        assert.deepEqual(waits, [2000, 2000]);
    });
    it("4xx はやり直さずに失敗、5xx は 3 回まで", async () => {
        let calls = 0;
        await assert.rejects(new DiscordWebhook("https://x", (async () => (calls++, new Response("bad", { status: 400 }))) as typeof fetch).send({}));
        assert.equal(calls, 1);
        calls = 0;
        await assert.rejects(new DiscordWebhook("https://x", (async () => (calls++, new Response("x", { status: 503 }))) as typeof fetch, async () => {}).send({}));
        assert.equal(calls, 4);
        assert.equal(retryAfterMs(null, 2), 4000);
    });
});

describe("aws", () => {
    it("フレームレートの形", () => {
        assert.equal(parseFrameRate("60"), 60);
        assert.equal(parseFrameRate("59.94"), 59.94);
        assert.equal(parseFrameRate("60000/1001"), 59.94);
        assert.equal(parseFrameRate(""), undefined);
    });
});
