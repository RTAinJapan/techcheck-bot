// テストの流れ (設計書 §5.0) を、偽物の外の口で 1 秒ずつ進めて確かめる。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SrtSample } from "../src/advisor.js";
import { baseYaml, goodSample, makeWorld, twoSlotsYaml, type World } from "./helpers.js";

const U1 = { id: "U1", displayName: "Runner A" };
const U2 = { id: "U2", displayName: "Runner B" };

function sessionIdOf(w: World, threadId: string): string {
    const id = w.chat.buttonId(threadId, "abort");
    return id.split(":")[1]!;
}

/** 配信を始めて、映像の判定が終わるところまで進める (良い回線) */
async function startAndStream(w: World, user = U1, lang?: "ja" | "en") {
    const reply = await w.service.start(user, "C-test", lang, "ja");
    await w.flush();
    const thread = w.chat.threads.find((t) => t.userId === user.id)!;
    w.flow.sampleAt = (t) => goodSample(t);
    await w.run(140, () => w.rx.live(7));
    return { reply, thread: thread.id };
}

async function press(w: World, thread: string, action: string, user = U1) {
    return w.service.button(user.id, false, w.chat.buttonId(thread, action));
}

/** 音声とその他のチェックを全部 OK で通す */
async function passChecks(w: World, thread: string) {
    const audio = (peak: number) => () => w.rx.live(7, { peak });
    await press(w, thread, "step-start");
    await w.run(18, audio(-20)); // ゲーム音
    await press(w, thread, "step-start");
    await w.run(13, audio(-80)); // 静か
    await press(w, thread, "step-start");
    await w.run(13, audio(-80)); // マイク (載らない)
    await press(w, thread, "step-start");
    await w.run(13, audio(-80)); // PC の音 (載らない)
    await press(w, thread, "yes"); // 画面
    await press(w, thread, "step-start"); // 繋ぎ直し
    await w.run(3, () => w.rx.drop(7));
    await w.run(3, () => w.rx.live(7));
}

describe("テストの流れ", () => {
    it("起動から結果の通知まで (うまくいく場合)", async () => {
        const w = makeWorld();
        const { reply, thread } = await startAndStream(w);
        assert.match(reply, /スレッドを作りました/);

        // 準備: 止まっていたフローを開始し、チャンネルと録画を始める
        assert.equal(w.flow.started, 1);
        assert.deepEqual(
            w.rx.calls.slice(0, 2).map((c) => c.method),
            ["startChannel", "setRecording"],
        );
        const t = w.chat.threads[0]!;
        assert.match(t.name, /^配信テスト 2026-11-01 12:00 Runner A$/);
        assert.ok(w.chat.opsLog.some((l) => l.includes("配信テスト開始") && l.includes("/T1")));

        // 初回の案内は IP でなくドメインの URL
        const texts = w.chat.texts(thread);
        assert.ok(texts.some((x) => x.includes("srt://srt-a.example.jp:5000?mode=caller&latency=120000&passphrase=pass-a&pbkeylen=16")));
        assert.ok(!texts.some((x) => x.includes("203.0.113.10")));
        assert.ok(texts.some((x) => x.includes("配信が届きました")));
        assert.ok(texts.some((x) => x.includes("映像は問題なく届いています") && x.includes("120 ms")));

        await passChecks(w, thread);
        assert.match(w.chat.lastPost(thread)!.content, /確認はすべて終わりました/);
        const done = await press(w, thread, "done");
        assert.equal(done.modal?.kind, "done");
        await w.service.complete(sessionIdOf(w, thread), "問題なし");

        // 後片付け、シート、webhook、スレッドを閉じる
        assert.ok(w.rx.calls.some((c) => c.method === "stopChannel" && c.params.ch === 7));
        assert.ok(w.rx.calls.some((c) => c.method === "setRecording" && c.params.ch === 7 && c.params.enabled === false));
        assert.equal(w.flow.stopped, 1, "bot が開始したフローは止める");
        assert.equal(w.sheet.rows.length, 1);
        const row = w.sheet.rows[0]!;
        assert.equal(row[1], "Runner A");
        assert.equal(row[2], "U1");
        assert.equal(row[3], "ja");
        assert.equal(row[6], "完了");
        assert.equal(row[9], 120);
        assert.equal(row[19], 0, "繋ぎ直しの手順は「切れた回数」に数えない");
        assert.equal(row[27], "OK");
        assert.match(String(row[25]), /game-audio: OK.*mic: OK.*reconnect: OK/);
        assert.equal(row[30], "問題なし");
        assert.equal(w.webhook.sent.length, 1);
        const payload = w.webhook.sent[0] as { allowed_mentions: { parse: unknown[] }; embeds: { fields: { name: string; value: string }[] }[] };
        assert.deepEqual(payload.allowed_mentions.parse, []);
        assert.ok(payload.embeds[0]!.fields.some((f) => f.name === "確定した latency" && f.value === "120 ms"));
        assert.ok(w.chat.threads[0]!.closed);
        assert.match(w.chat.texts(thread).at(-1)!, /OBS の配信を止めてください/);

        // 後日の音声の判定
        assert.match(await w.service.review("U1", true, "きれい"), /書きました/);
        assert.deepEqual(w.sheet.updates[0], { range: "techcheck!AC2:AD2", values: ["OK", "きれい"] });
    });

    it("フローにパスフレーズが無ければ、案内する URL にも入れない", async () => {
        const w = makeWorld("", baseYaml.replace("    passphrase: pass-a\n", ""));
        await w.service.start(U1, "C-test", undefined, "ja");
        await w.flush();
        const texts = w.chat.texts(w.chat.threads[0]!.id);
        assert.ok(texts.some((x) => x.includes("srt://srt-a.example.jp:5000?mode=caller&latency=120000")));
        assert.ok(!texts.some((x) => x.includes("passphrase") || x.includes("pbkeylen")));
    });

    it("もともと動いていたフローは止めない", async () => {
        const w = makeWorld();
        w.flow.status = "ACTIVE";
        const { thread } = await startAndStream(w);
        await w.service.cancel("U1");
        assert.equal(w.flow.started, 0);
        assert.equal(w.flow.stopped, 0);
        assert.equal(w.sheet.rows[0]![6], "中断");
        assert.ok(w.chat.threads.find((t) => t.id === thread)!.closed);
    });

    it("英語を選ぶと案内が英語になり、ボタンで日本語に切り替えられる", async () => {
        const w = makeWorld();
        await w.service.start(U1, "C-test", "en", "ja");
        await w.flush();
        const thread = w.chat.threads[0]!.id;
        assert.match(w.chat.texts(thread).at(-1)!, /Let's start your stream test/);
        await press(w, thread, "lang-ja");
        assert.match(w.chat.texts(thread).at(-1)!, /配信テストを始めます/);
        assert.equal(w.sheet.rows.length, 0);
    });

    it("配信テストのチャンネル以外では始めない", async () => {
        const w = makeWorld();
        assert.match(await w.service.start(U1, "C-other", undefined, "ja"), /<#C-test>/);
        assert.equal(w.chat.threads.length, 0);
    });
});

describe("待ちの列", () => {
    it("使われていれば列に入り、空いたら知らせて「始める」で始まる", async () => {
        const w = makeWorld();
        await startAndStream(w);
        assert.match(await w.service.start(U2, "C-test", undefined, "ja"), /1 番目/);
        assert.match(await w.service.start(U2, "C-test", undefined, "ja"), /1 番目/);
        await w.service.cancel("U1");
        await w.run(1);
        assert.equal(w.chat.called.length, 1);
        assert.equal(w.chat.called[0]!.userId, "U2");
        assert.match(w.chat.called[0]!.msg.content, /<@U2>/);
        assert.match(await w.service.claim(U2), /スレッドを作りました/);
        assert.equal(w.chat.threads.length, 2);
    });

    it("5 分以内に押さなければ後ろに回し、2 回続けば列から外す", async () => {
        const w = makeWorld();
        w.flow.status = "ACTIVE";
        await w.service.start(U1, "C-test", undefined, "ja");
        await w.flush();
        await w.service.start(U2, "C-test", undefined, "ja");
        await w.service.cancel("U1");
        await w.run(1); // U2 に知らせる
        await w.run(5 * 60 + 1); // 時間切れ → 後ろに回して、また知らせる
        assert.equal(w.chat.called.length, 2);
        await w.run(5 * 60 + 1); // 2 回目の時間切れ → 外す
        assert.match(w.chat.called.at(-1)!.msg.content, /待ちの列から外しました/);
        assert.match(await w.service.slotShow(), /待ちの列: なし/);
    });
});

describe("SRT の枠が複数", () => {
    const U3 = { id: "U3", displayName: "Runner C" };
    const U4 = { id: "U4", displayName: "Runner D" };
    const two = () => makeWorld("", twoSlotsYaml);
    const begin = async (w: World, user: { id: string; displayName: string }) => {
        const reply = await w.service.start(user, "C-test", undefined, "ja");
        await w.flush();
        return reply;
    };

    it("枠の数だけ同時に始まり、あふれた人は列に入る", async () => {
        const w = two();
        assert.match(await begin(w, U1), /スレッドを作りました/);
        assert.match(await begin(w, U2), /スレッドを作りました/);
        assert.match(await begin(w, U3), /1 番目/);
        assert.equal(w.chat.threads.length, 2);
        // 1 人目は枠 1 (flow-a / ch7)、2 人目は枠 2 (flow-b / ch6)
        assert.ok(w.rx.calls.some((c) => c.method === "startChannel" && c.params.ch === 7));
        assert.ok(w.rx.calls.some((c) => c.method === "startChannel" && c.params.ch === 6));
        assert.ok(w.chat.texts(w.chat.threads[0]!.id).some((x) => x.includes("srt://srt-a.example.jp")));
        assert.ok(w.chat.texts(w.chat.threads[1]!.id).some((x) => x.includes("srt://srt-b.example.jp") && x.includes("pass-b")));
        const show = await w.service.slotShow();
        assert.match(show, /SRT の 1 番の枠: フロー flow-a \/ ch7 \/ 受付中 \/ 使用中: Runner A/);
        assert.match(show, /SRT の 2 番の枠: フロー flow-b \/ ch6 \/ 受付中 \/ 使用中: Runner B/);

        // 2 人とも、それぞれのチャンネルの映像で判定が進む
        w.flow.sampleAt = (t) => goodSample(t);
        await w.run(140, () => {
            w.rx.live(7);
            w.rx.live(6);
        });
        for (const t of w.chat.threads) assert.ok(w.chat.texts(t.id).some((x) => x.includes("映像は問題なく届いています")));

        // 枠 2 が空いたら、列の人に知らせて、枠 2 で始まる
        await w.service.cancel("U2");
        assert.equal(w.rx.channels.get(6)!.status, "stopped");
        assert.notEqual(w.rx.channels.get(7)!.status, "stopped", "1 人目のチャンネルは止めない");
        await w.run(1, () => w.rx.live(7));
        assert.equal(w.chat.called.at(-1)!.userId, "U3");
        assert.match(await w.service.claim(U3), /スレッドを作りました/);
        await w.flush();
        assert.match(await w.service.slotShow(), /SRT の 2 番の枠: [^\n]*使用中: Runner C/);
    });

    it("枠が 2 つ同時に空いたら、列の前から 2 人に知らせる", async () => {
        const w = two();
        await begin(w, U1);
        await begin(w, U2);
        await begin(w, U3);
        await begin(w, U4);
        await w.service.cancel("U1");
        await w.service.cancel("U2");
        await w.run(1);
        assert.deepEqual(w.chat.called.map((c) => c.userId), ["U3", "U4"]);
        assert.match(await w.service.slotShow(), /1\. Runner C \(知らせ済み\)\n2\. Runner D \(知らせ済み\)/);
        // 後ろの人が先に押しても始められる
        assert.match(await w.service.claim(U4), /スレッドを作りました/);
        assert.match(await w.service.claim(U3), /スレッドを作りました/);
    });

    it("止めた枠は使わない。再開は枠の番号で指定する", async () => {
        const w = two();
        assert.match(await w.service.slotEnable("srt", false, 2), /SRT の 2 番の枠を止めました/);
        await begin(w, U1);
        assert.match(await begin(w, U2), /1 番目/, "2 番の枠は止めてあるので待つ");
        assert.match(await w.service.slotEnable("srt", true), /枠の番号 \(slot\) を指定してください/);
        assert.match(await w.service.slotEnable("srt", true, 3), /SRT の 3 番の枠はありません/);
        assert.match(await w.service.slotEnable("srt", true, 2), /SRT の 2 番の枠を再開しました/);
        await w.run(1);
        assert.equal(w.chat.called.at(-1)!.userId, "U2");
        // 番号を省いて止めると、SRT の枠すべて
        assert.match(await w.service.slotEnable("srt", false), /SRT の枠すべてを止めました/);
        assert.match(await begin(w, U3), /受付を止めています/);
    });

    it("問題のあった枠だけを止め、ほかの枠のテストは続ける", async () => {
        const w = two();
        w.dns.answers["srt-b.example.jp"] = ["192.0.2.99"];
        await begin(w, U1);
        await begin(w, U2);
        assert.ok(w.chat.opsLog.some((l) => l.includes("SRT の 2 番の枠に問題があるので止めました") && l.includes("/techcheck slot on srt slot:2")));
        const show = await w.service.slotShow();
        assert.match(show, /SRT の 1 番の枠: [^\n]*受付中 \/ 使用中: Runner A/);
        assert.match(show, /SRT の 2 番の枠: [^\n]*止めている/);
        assert.match(show, /1\. Runner B/, "配信者のせいではないので、列の先頭に戻す");
    });

    it("ほかの枠で使っているフローやチャンネルには設定し直せない", async () => {
        const w = two();
        assert.match(await w.service.slotSet("srt", 6, "flow-a", 2), /フロー flow-a は SRT の 1 番の枠で使っています/);
        assert.match(await w.service.slotSet("srt", 7, "flow-b", 2), /ch7 は SRT の 1 番の枠で使っています/);
        assert.match(await w.service.slotSet("rtmp", 7), /ch7 は SRT の 1 番の枠で使っています/);
        assert.match(await w.service.slotSet("srt", 8, "flow-b", 2), /ch8 は RTMP の枠で使っています/);
        assert.match(await w.service.slotSet("srt", 6, "flow-b", 3), /SRT の 3 番の枠はありません/);
        assert.match(await w.service.slotSet("srt", 6, "flow-b", 2), /SRT の 2 番の枠を設定しました/);
    });
});

describe("latency の調整と RTMP", () => {
    function lossy(from: number, until: number) {
        return (t: number): SrtSample => ({ ...goodSample(t), notRecovered: t >= from && t < until ? 2 : 0 });
    }

    it("取りこぼすと latency を上げてもらい、始め直したら測り直す", async () => {
        const w = makeWorld();
        await w.service.start(U1, "C-test", undefined, "ja");
        await w.flush();
        const thread = w.chat.threads[0]!.id;
        const t0 = Math.floor(w.clock.t / 1000);
        w.flow.sampleAt = lossy(t0, t0 + 10_000);
        await w.run(80, () => w.rx.live(7));
        const ask = w.chat.texts(thread).find((x) => x.includes("latency を **180 ms**"));
        assert.ok(ask, "180 ms に上げる案内");
        assert.ok(ask.includes("latency=180000"));

        // 配信者が設定して始め直す。回線も良くなった
        w.flow.sampleAt = (t) => goodSample(t);
        assert.match((await press(w, thread, "set")).ephemeral!, /始め直すと/);
        await w.run(3, () => w.rx.drop(7));
        await w.run(150, () => w.rx.live(7));
        const texts = w.chat.texts(thread);
        assert.ok(texts.some((x) => x.includes("latency 180 ms で計測し直します")));
        assert.ok(texts.some((x) => x.includes("映像は問題なく届いています") && x.includes("180 ms")));
    });

    it("上げても直らなければ RTMP に案内し、届いたら SRT の枠を空ける", async () => {
        const w = makeWorld("latency: { maxRaises: 0 }\n");
        await w.service.start(U1, "C-test", undefined, "ja");
        await w.flush();
        const thread = w.chat.threads[0]!.id;
        const t0 = Math.floor(w.clock.t / 1000);
        w.flow.sampleAt = lossy(t0, t0 + 10_000);
        await w.run(80, () => w.rx.live(7));
        const ask = w.chat.texts(thread).find((x) => x.includes("RTMP で試します"));
        assert.ok(ask);
        assert.ok(ask.includes("rtmp://rtmp.example.jp/live") && ask.includes("key-1"));
        assert.ok(w.rx.calls.some((c) => c.method === "startChannel" && c.params.ch === 8));

        // 次の人は、RTMP で届くまでは待つ
        assert.match(await w.service.start(U2, "C-test", undefined, "ja"), /1 番目/);
        await press(w, thread, "set");
        await w.run(2, () => w.rx.live(8));
        assert.ok(w.chat.texts(thread).some((x) => x.includes("RTMP で届きました")));
        assert.ok(w.rx.calls.some((c) => c.method === "stopChannel" && c.params.ch === 7));
        assert.equal(w.flow.stopped, 1);
        assert.equal(w.chat.called[0]?.userId, "U2", "SRT の枠が空いたので次の人に知らせる");

        await w.run(65, () => w.rx.live(8));
        assert.ok(w.chat.texts(thread).some((x) => x.includes("RTMP で映像は問題なく届いています")));
    });
});

describe("準備と枠", () => {
    it("ドメインが別のフローを指していたら始めず、枠を止めて列の先頭に戻す", async () => {
        const w = makeWorld();
        w.dns.answers["srt-a.example.jp"] = ["192.0.2.99"];
        await w.service.start(U1, "C-test", undefined, "ja");
        await w.flush();
        assert.ok(w.chat.opsLog.some((l) => l.includes("止めました") && l.includes("192.0.2.99")));
        assert.ok(w.chat.texts(w.chat.threads[0]!.id).some((x) => x.includes("準備に問題がありました")));
        assert.equal(w.sheet.rows[0]![6], "中断");
        assert.match(await w.service.slotShow(), /止めている[\s\S]*1\. Runner A/);
        assert.match(await w.service.start(U2, "C-test", undefined, "ja"), /受付を止めています/);
    });

    it("準備の途中で中止したら、始めたフローとチャンネルを止める", async () => {
        const w = makeWorld();
        // 1 回目の describe は STANDBY (bot がフローを開始する)。2 回目 (ACTIVE になるのを待っているところ) で止めておき、その間に中止する
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        let calls = 0;
        w.flow.describe = async (arn) => {
            const info = { arn, ingestIp: "203.0.113.10", ingestPort: 5000 };
            if (++calls === 1) return { ...info, status: "STANDBY" };
            await gate;
            return { ...info, status: "ACTIVE" };
        };
        await w.service.start(U1, "C-test", undefined, "ja");
        await w.flush();
        await w.service.cancel("U1");
        release();
        await w.flush();
        assert.equal(w.flow.started, 1);
        assert.equal(w.flow.stopped, 1, "bot が開始したフローを 1 回だけ止める");
        assert.equal(w.rx.channels.get(7)!.status, "stopped");
        assert.ok(!w.rx.calls.some((c) => c.method === "setRecording" && c.params.enabled === true), "録画を始めない");
    });

    it("「配信テスト用」の印の無いチャンネルは枠にできない", async () => {
        const w = makeWorld();
        w.rx.channels.get(7)!.testSlot = false;
        assert.match(await w.service.slotSet("srt", 7, "flow-a"), /印がありません/);
        w.rx.channels.get(7)!.testSlot = true;
        assert.match(await w.service.slotSet("srt", 8, "flow-a"), /SRT ではありません/);
        assert.match(await w.service.slotSet("rtmp", 7), /RTMP の pull ではありません/);
        assert.match(await w.service.slotSet("srt", 7, "flow-a"), /設定しました/);
    });

    it("起動し直したとき: 設定ファイルの枠を書き換えていればそれが効き、書き換えていなければ設定し直した値が残る", async () => {
        const w1 = makeWorld();
        assert.match(await w1.service.slotShow(), /SRT の枠: フロー flow-a \/ ch7[\s\S]*RTMP の枠: ch8/);

        // 設定ファイルのチャンネルを 7、8 から 6、5 に書き換えて起動し直す
        const edited = baseYaml.replace("srt: { flow: flow-a, channel: 7 }", "srt: { flow: flow-a, channel: 6 }").replace("rtmp: { channel: 8 }", "rtmp: { channel: 5 }");
        const w2 = makeWorld("", edited, w1.store);
        assert.match(await w2.service.slotShow(), /SRT の枠: フロー flow-a \/ ch6[\s\S]*RTMP の枠: ch5/);

        // /techcheck slot で設定し直した値は、設定ファイルがそのままなら、起動し直しても残る
        assert.match(await w2.service.slotSet("srt", 7, "flow-a"), /設定しました/);
        await w2.service.slotEnable("srt", false);
        const w3 = makeWorld("", edited, w2.store);
        assert.match(await w3.service.slotShow(), /SRT の枠: フロー flow-a \/ ch7 \/ 止めている/);
    });

    it("届かないまま 10 分で催促し、30 分で中断する", async () => {
        const w = makeWorld();
        await w.service.start(U1, "C-test", undefined, "ja");
        await w.flush();
        const thread = w.chat.threads[0]!.id;
        await w.run(10 * 60 + 5);
        assert.ok(w.chat.texts(thread).some((x) => x.includes("まだ配信が届いていません")));
        await w.run(20 * 60);
        assert.equal(w.sheet.rows[0]![6], "中断");
        assert.match(String(w.sheet.rows[0]![7]), /時間切れ/);
    });

    it("シートに書けなくても webhook で知らせる", async () => {
        const w = makeWorld();
        w.sheet.fail = true;
        await startAndStream(w);
        await w.service.cancel("U1");
        const payload = w.webhook.sent[0] as { embeds: { fields: { name: string; value: string }[] }[] };
        assert.ok(payload.embeds[0]!.fields.some((f) => f.name === "シート" && f.value.includes("書けませんでした")));
    });
});

describe("チェック", () => {
    it("マイクが載っていたら直し方を出し、そのまま進めると印を付ける", async () => {
        const w = makeWorld();
        const { thread } = await startAndStream(w);
        const audio = (peak: number) => () => w.rx.live(7, { peak });
        await press(w, thread, "step-start");
        await w.run(18, audio(-20));
        await press(w, thread, "step-start");
        await w.run(13, audio(-80));
        await press(w, thread, "step-start");
        await w.run(13, audio(-25)); // しゃべった声が載った
        assert.match(w.chat.lastPost(thread)!.content, /マイクの音が配信に入っています/);
        await press(w, thread, "step-next");
        await w.service.cancel("U1");
        assert.match(String(w.sheet.rows[0]![25]), /mic: おかしい \(そのまま進めた\)/);
    });
});
