// テストの流れ (設計書 §5.0) を、偽物の外の口で 1 秒ずつ進めて確かめる。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SrtSample } from "../src/advisor.js";
import { defaultChecks, reconnectStep } from "../src/checks.js";
import { columnLetter, describeRange, formatRecPos, sheetColumns } from "../src/record.js";
import { baseYaml, driveYaml, goodSample, makeWorld, messagesWith, twoSlotsYaml, webcamYaml, type World } from "./helpers.js";

/** シートの列の番号を、見出しの名前で引く (列の順を変えても、試験が何を見ているかが分かるように) */
const col = (name: (typeof sheetColumns)[number]) => sheetColumns.indexOf(name);
const kChecks = col("チェックの参考の判定と録画の区間");
const kFiles = col("録画ファイル");

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

/** 音声とその他のチェック (既定の 5 手順) を全部 OK で通す */
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
        // 配布している OBS の設定の URL と同じ形 (mode=caller は付けない。OBS は書かなければ caller)
        assert.ok(texts.some((x) => x.includes("srt://srt-a.example.jp:5000?latency=100000&passphrase=pass-a&pbkeylen=16")));
        assert.ok(!texts.some((x) => x.includes("mode=")));
        assert.ok(!texts.some((x) => x.includes("203.0.113.10")));
        assert.ok(texts.some((x) => x.includes("配信が届きました")));
        assert.ok(texts.some((x) => x.includes("映像は問題なく届いています") && x.includes("**100000 μs**")));

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
        assert.equal(row[col("確定した latency (μs)")], 100000, "確定した latency は μs (OBS の URL に入れる値) で書く");
        assert.equal(row[col("切れた回数")], 0);
        assert.equal(row[col("映像の判定")], "OK");
        // あとで聞く人が最初に開く 3 つは、I 列から並ぶ
        assert.deepEqual([col("録画ファイル"), col("マイクの録音 (VC)"), col("Google ドライブ")].map(columnLetter), ["I", "J", "K"]);
        assert.equal(row[kFiles], "rec-ch7.mkv");
        assert.match(String(row[kChecks]), /game-audio: OK.*mic: OK.*picture: OK/);
        assert.ok(!String(row[kChecks]).includes("reconnect"), "繋ぎ直しは既定の手順に無い");
        // 手順の数は、手順ごとの見出し (手順 n/5) で分かる。始めの案内には書かない
        const all = texts.concat(w.chat.texts(thread));
        assert.ok(all.some((x) => x.includes("**手順 1/5**")));
        assert.ok(all.some((x) => x.startsWith("次に、音声とその他の確認をします。手順ごとに")));
        assert.equal(row[col("配信者のメモ")], "問題なし");
        assert.equal(w.webhook.sent.length, 1);
        const payload = w.webhook.sent[0] as { allowed_mentions: { parse: unknown[] }; embeds: { fields: { name: string; value: string }[] }[] };
        assert.deepEqual(payload.allowed_mentions.parse, []);
        assert.ok(payload.embeds[0]!.fields.some((f) => f.name === "確定した latency" && f.value === "100000 μs"));
        assert.ok(w.chat.threads[0]!.closed);
        assert.match(w.chat.texts(thread).at(-1)!, /OBS の配信を止めてください/);
        // 配信者には、OBS の URL に入れる値 (μs) で伝える。ms の数字を見せると、そのまま URL に入れてしまう
        assert.ok(w.chat.texts(thread).at(-1)!.includes("本番の latency: 100000 μs\n"), w.chat.texts(thread).at(-1));

        // 後日の音声の判定
        assert.match(await w.service.review("U1", true, "きれい"), /書きました/);
        assert.deepEqual(w.sheet.updates[0], { range: "techcheck!AE2:AF2", values: ["OK", "きれい"] });
    });

    it("繋ぎ直しの手順は、設定の checks に足せば使える (切れた回数には数えない)", async () => {
        const w = makeWorld(`checks: ${JSON.stringify([...defaultChecks, reconnectStep])}\n`);
        const { thread } = await startAndStream(w);
        await passChecks(w, thread);
        assert.match(w.chat.lastPost(thread)!.content, /手順 6\/6[\s\S]*OBS の配信を一度止めて/);
        await press(w, thread, "step-start");
        await w.run(3, () => w.rx.drop(7));
        await w.run(3, () => w.rx.live(7));
        assert.match(w.chat.lastPost(thread)!.content, /確認はすべて終わりました/);
        await w.service.complete(sessionIdOf(w, thread), "");
        const row = w.sheet.rows[0]!;
        assert.equal(row[col("切れた回数")], 0, "繋ぎ直しの手順は「切れた回数」に数えない");
        assert.match(String(row[kChecks]), /reconnect: OK/);
    });

    it("フローにパスフレーズが無ければ、案内する URL にも入れない", async () => {
        const w = makeWorld("", baseYaml.replace("    passphrase: pass-a\n", ""));
        await w.service.start(U1, "C-test", undefined, "ja");
        await w.flush();
        const texts = w.chat.texts(w.chat.threads[0]!.id);
        assert.ok(texts.some((x) => x.includes("srt://srt-a.example.jp:5000?latency=100000")));
        assert.ok(!texts.some((x) => x.includes("passphrase") || x.includes("pbkeylen")));
    });

    it("進み具合と運営への通知はコンソールにも出し、通知を送れなくてもテストは進む", async () => {
        const w = makeWorld();
        w.chat.ops = async () => {
            throw new Error("Missing Access");
        };
        await w.service.start(U1, "C-test", undefined, "ja");
        await w.flush();
        const has = (part: string) => w.logs.some((l) => l.includes(part));
        assert.ok(has("運営への通知: 配信テスト開始: Runner A"), w.logs.join("\n"));
        assert.ok(has("運営への通知を送れませんでした") && has("Missing Access"));
        assert.ok(has("準備 (Runner A): フロー flow-a は STANDBY"));
        assert.ok(has("準備 (Runner A): フロー flow-a は ACTIVE"));
        assert.ok(has("スレッド (Runner A): "));
        assert.ok(has("Runner A: preparing → waitingStream"));
        // 通知を送れなくても、案内までは進んでいる
        assert.ok(w.chat.texts(w.chat.threads[0]!.id).some((x) => x.includes("srt://srt-a.example.jp")));

        await w.service.cancel("U1");
        assert.ok(has("テスト終了: Runner A / 中断 (運営が中止)"));
    });

    it("運営への通知のチャンネルが未設定なら、運営への通知は送らない (コンソールには出す)", async () => {
        for (const yaml of [baseYaml.replace("  opsChannelId: C-ops\n", ""), baseYaml.replace("opsChannelId: C-ops", 'opsChannelId: ""'), baseYaml.replace("opsChannelId: C-ops", "opsChannelId: ${OPS_CHANNEL}")]) {
            const w = makeWorld("", yaml);
            assert.equal(w.config.discord.opsChannelId, "");
            await w.service.start(U1, "C-test", undefined, "ja");
            await w.flush();
            assert.deepEqual(w.chat.opsLog, [], "bot はチャンネルに書かない");
            assert.ok(w.logs.some((l) => l.includes("運営への通知: 配信テスト開始: Runner A")), "コンソールには出る");
            assert.ok(!w.logs.some((l) => l.includes("送れませんでした")));
            // テストそのものは進む
            assert.ok(w.chat.texts(w.chat.threads[0]!.id).some((x) => x.includes("srt://srt-a.example.jp")));
        }
        // 設定してあれば送る
        const w = makeWorld();
        await w.service.start(U1, "C-test", undefined, "ja");
        await w.flush();
        assert.ok(w.chat.opsLog.some((l) => l.startsWith("配信テスト開始: Runner A")));
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
        // 答える場所は 1 つ: 「始める」のボタンは配信テストのチャンネルのメッセージにだけあり、DM はそこへ案内するだけ
        assert.match(w.chat.called[0]!.msg.content, /<@U2> 配信テストの順番が来ました。5 分以内に「始める」を押してください/);
        assert.deepEqual(w.chat.called[0]!.msg.buttons?.map((b) => b.label), ["始める"]);
        assert.match(w.chat.called[0]!.dm, /5 分以内に、下のリンク先 \(配信テストのチャンネル\) のメッセージにある「始める」を押してください。この DM には返信しなくて構いません/);
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
        assert.match(w.chat.called.at(-1)!.msg.content, /^<@U2> .*待ちの列から外しました/);
        assert.match(w.chat.called.at(-1)!.dm, /待ちの列から外しました/);
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

describe("denpachan の受信の設定を bot が入れる (denpachan.configure)", () => {
    // flow-a の出力 sub (SRT listener、203.0.113.10:30001) を denpachan が受ける
    const configured = `${baseYaml.replace("    passphrase: pass-a\n", "    passphrase: pass-a\n    output: sub\n")}denpachan: { configure: true }\n`;
    const patches = (w: World) => w.rx.calls.filter((c) => c.method === "patchChannel").map((c) => c.params);

    it("テストを始めるとき、フローの出力へ繋ぐ設定を枠のチャンネルに入れる", async () => {
        const w = makeWorld("", configured);
        // 画面で RTMP に設定してあっても構わない (bot が入れ直す)
        w.rx.channels.get(7)!.source = { protocol: "rtmp", mode: "pull" };
        assert.deepEqual(w.service.slotMismatches(), []);
        assert.match(await w.service.start(U1, "C-test", undefined, "ja"), /スレッドを作りました/);
        await w.flush();
        assert.deepEqual(patches(w), [
            { ch: 7, patch: { source: { protocol: "srt", mode: "caller", host: "203.0.113.10", port: 30001, passphrase: "", pbkeylen: 0, streamId: "" } } },
        ]);
        const methods = w.rx.calls.map((c) => c.method);
        assert.ok(methods.indexOf("patchChannel") < methods.indexOf("startChannel"), "設定を入れてから開始する");
        assert.equal(w.rx.channels.get(7)!.source.protocol, "srt");
        assert.ok(w.logs.some((l) => l.includes("ch7 に受信の設定を入れます (srt caller 203.0.113.10:30001)")));
    });

    it("出力が SRT caller なら待ち受ける設定を、出力にパスワードがあればパスフレーズも入れる", async () => {
        const w = makeWorld("", configured.replace("    output: sub\n", "    output: sub\n    outputPassphrase: 0123456789ab\n"));
        w.flow.outputs = [{ name: "sub", protocol: "srt-caller", port: 9007 }];
        await w.service.start(U1, "C-test", undefined, "ja");
        await w.flush();
        assert.deepEqual(patches(w)[0], {
            ch: 7,
            patch: { source: { protocol: "srt", mode: "listener", host: "0.0.0.0", port: 9007, passphrase: "0123456789ab", pbkeylen: 16, streamId: "" } },
        });
        assert.ok(!w.logs.some((l) => l.includes("0123456789ab")), "パスフレーズはログに出さない");
    });

    it("RTMP に移すとき、RTMP サーバから pull する設定を入れる", async () => {
        const w = makeWorld("latency: { maxRaises: 0, maxUs: 100000 }\n", configured);
        w.rx.channels.get(8)!.source = { protocol: "srt", mode: "listener" };
        await w.service.start(U1, "C-test", undefined, "ja");
        await w.flush();
        const t0 = Math.floor(w.clock.t / 1000);
        w.flow.sampleAt = (t) => ({ ...goodSample(t), notRecovered: t >= t0 ? 2 : 0 });
        await w.run(80, () => w.rx.live(7));
        assert.deepEqual(patches(w)[1], { ch: 8, patch: { source: { protocol: "rtmp", mode: "pull", url: "rtmp://rtmp.example.jp/live/key-1" } } });
        assert.ok(!w.logs.some((l) => l.includes("key-1") && l.includes("受信の設定")), "キーはログに出さない");
    });

    it("denpachan が受信の設定の変更を許していなければ、始めずに知らせる", async () => {
        const w = makeWorld("", configured);
        w.rx.configurable = false;
        assert.ok(w.service.slotMismatches().some((p) => p.includes("受信の設定の変更を許していません")));
        assert.match(await w.service.start(U1, "C-test", undefined, "ja"), /準備に問題がありました/);
        assert.equal(w.flow.started, 0);
        assert.ok(w.chat.opsLog.some((l) => l.includes("止めました") && l.includes("受信の設定の変更を許していません")));
    });

    it("設定に書いた出力がフローに無ければ、ある出力の名前を付けて止める", async () => {
        const w = makeWorld("", configured.replace("output: sub", "output: nope"));
        await w.service.start(U1, "C-test", undefined, "ja");
        await w.flush();
        assert.ok(w.chat.opsLog.some((l) => l.includes('フロー flow-a に出力 "nope" がありません (ある出力: main、sub)')));
        assert.deepEqual(patches(w), []);
    });

    it("configure が false (既定) なら、受信の設定には触らない", async () => {
        const w = makeWorld();
        await w.service.start(U1, "C-test", undefined, "ja");
        await w.flush();
        assert.deepEqual(patches(w), []);
    });
});

describe("届いた配信の形を、期待する出力と比べる", () => {
    it("解像度や fps が期待 (既定は 1536x864 / 60 fps) と違えば伝える。合っていれば何も言わない", async () => {
        const ok = makeWorld();
        const a = await startAndStream(ok);
        assert.equal(ok.chat.texts(a.thread).some((x) => x.includes("案内と違います")), false);
        const w = makeWorld();
        w.flow.meta = { width: 1920, height: 1080, fps: 30, codec: "h264", hasAudio: true };
        const b = await startAndStream(w);
        assert.ok(w.chat.texts(b.thread).some((x) => x.includes("配信の形が案内と違います (1920x1080, 30 fps)。OBS の出力を 1536x864 / 60 fps にしてください")));
    });
});

describe("結果のまとめ", () => {
    it("配信者には、手順を意味の分かる名前で見せる (内部の名前は出さない)。シートは内部の名前のまま", async () => {
        const w = makeWorld("mic: { via: discord }\n");
        const { thread } = await startAndStream(w);
        await passChecks(w, thread);
        await press(w, thread, "voice-skip");
        const done = w.chat.lastPost(thread)!.content;
        const labels = ["ゲーム音が来ている", "無音シーン", "OBS にマイクが入っていない", "OBS にゲーム以外のデスクトップ音などが入っていない", "送信されたゲーム映像が意図通り", "マイク音"];
        assert.deepEqual(
            done.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.replace(/: [^:]*$/, "")),
            labels.map((l) => `- ${l}`),
        );
        assert.match(done, /- ゲーム音が来ている: OK\n/);
        assert.ok(!/game-audio|silence|desktop|picture|voice/.test(done));
        await w.service.complete(sessionIdOf(w, thread), "");
        const closing = w.chat.texts(thread).find((x) => x.includes("配信テストの結果"))!;
        assert.match(closing, /- ゲーム音が来ている: OK \d\d:\d\d-\d\d:\d\d\n- 無音シーン: OK/);
        assert.ok(!closing.includes("game-audio"));
        // シートは運営向けなので、これまでどおりの名前
        assert.match(String(w.sheet.rows[0]![kChecks]), /^game-audio: OK/);

        // 英語の案内では英語の名前
        const en = makeWorld();
        await en.service.start(U1, "C-test", "en", "en-US");
        await en.flush();
        en.flow.sampleAt = (t) => goodSample(t);
        await en.run(140, () => en.rx.live(7));
        const t = en.chat.threads[0]!.id;
        await passChecks(en, t);
        assert.match(en.chat.lastPost(t)!.content, /- Game audio arrives: /);
    });

    it("設定の checks に足した手順: 文言は messages の steps.<id> から出す。名前 (label) が無ければ id のまま", async () => {
        const custom = `checks: ${JSON.stringify([{ id: "my-step", kind: "confirm", seconds: 0 }])}\n`;
        const i18n = messagesWith({ "steps.my-step.text": "よいですか", "steps.my-step.failHint": "直してください" });
        const w = makeWorld(custom, baseYaml, undefined, i18n);
        const { thread } = await startAndStream(w);
        assert.match(w.chat.lastPost(thread)!.content, /手順 1\/1\*\*\nよいですか$/);
        await press(w, thread, "no");
        assert.match(w.chat.lastPost(thread)!.content, /直してください$/);
        await press(w, thread, "step-retry");
        await press(w, thread, "yes");
        assert.match(w.chat.lastPost(thread)!.content, /- my-step: OK/);
    });

    it("手順の文言が messages に無ければ、起動しない (手順の途中で止まらないように)", () => {
        const custom = `checks: ${JSON.stringify([{ id: "my-step", kind: "confirm", seconds: 0 }])}\n`;
        assert.throws(() => makeWorld(custom), /手順の文言が、文言のファイル[\s\S]*- steps\.my-step\.text\n- steps\.my-step\.failHint/);
    });
});

describe("ゲームの音を完全には消せない", () => {
    it("「音を消せない」で、小さくした音量を測って進む。その音量を基準に、あとの手順を比べる", async () => {
        const w = makeWorld();
        const { thread } = await startAndStream(w);
        await press(w, thread, "step-start");
        await w.run(18, () => w.rx.live(7, { peak: -20 }));
        // 「静かにする」手順には、「始める」と「音を消せない」がある
        const prompt = w.chat.lastPost(thread)!;
        assert.match(prompt.content, /OBS にゲーム音以外が入っていないことを確認するため、まずはゲーム内で静かなシーンや設定によって音が出ない状態にしてください。\nそのまま 10 秒ほど静かにしてください。/);
        assert.match(prompt.content, /ゲームの音を完全には消せない場合は「音を消せない」を押してください/);
        assert.deepEqual(prompt.buttons?.map((b) => b.label), ["始める", "音を消せない"]);
        await press(w, thread, "cannot-mute");
        assert.match(w.chat.lastPost(thread)!.content, /ゲームの音をできるだけ小さくして、10 秒ほどそのままにしてください/);
        assert.ok(w.chat.opsLog.some((l) => l.includes("ゲームの音を消せないとの申告: Runner A")));
        // ゲームの音が -45 dB で残っている: 無音ではないが、「おかしい」とは言わずに進む
        await w.run(13, () => w.rx.live(7, { peak: -45 }));
        const texts = w.chat.texts(thread);
        assert.ok(!texts.some((x) => x.includes("何も鳴らしていないのに音が載っています")));
        // マイクの手順: 同じ音量のままにしてもらう。ゲームの音と同じ大きさなら OK
        const mic = w.chat.lastPost(thread)!;
        assert.match(mic.content, /手順 3\/5[\s\S]*\(ゲームの音は、さきほどと同じ小さい音量のままにしてください。\)/);
        assert.deepEqual(mic.buttons?.map((b) => b.label), ["始める"]);
        await press(w, thread, "step-start");
        await w.run(13, () => w.rx.live(7, { peak: -44 }));
        assert.match(w.chat.lastPost(thread)!.content, /手順 4\/5/);
        // PC の音の手順: 基準よりずっと大きい音が載ったら伝えるが、ゲームの音が大きくなっただけのこともあると添える
        await press(w, thread, "step-start");
        await w.run(13, () => w.rx.live(7, { peak: -20 }));
        const ng = w.chat.lastPost(thread)!;
        assert.match(ng.content, /PC の音が配信に入っています[\s\S]*ゲームの音が大きくなっただけのこともあります/);
        await press(w, thread, "step-next");
        await press(w, thread, "yes");
        // 結果のまとめには、選んだとおりに書く
        assert.match(w.chat.lastPost(thread)!.content, /- 無音シーン: ゲームの音を消せない$/m);
        await w.service.complete(sessionIdOf(w, thread), "");
        const checks = String(w.sheet.rows[0]![kChecks]);
        assert.match(checks, /silence: 判定なし \(ゲームの音を消せない\) \(-45 dB\)/);
        assert.match(checks, /mic: OK/);
        assert.match(checks, /desktop: おかしい \(そのまま進めた\)/);
        assert.equal(w.sheet.rows[0]![col("ノイズ (dBFS)")], -45);
    });

    it("「始める」でやり直せば、音を消せる扱いに戻る", async () => {
        const w = makeWorld();
        const { thread } = await startAndStream(w);
        await press(w, thread, "step-start");
        await w.run(18, () => w.rx.live(7, { peak: -20 }));
        // 「音を消せない」は、「静かにする」手順でだけ効く
        await press(w, thread, "cannot-mute");
        await w.run(13, () => w.rx.live(7, { peak: -45 }));
        assert.equal((await press(w, thread, "cannot-mute")).ephemeral, "受け付けました。");
        // ここでは戻せないので、別のテストで: 音を消せた人は、これまでどおり判定する
        const ok = makeWorld();
        const t = await startAndStream(ok);
        await press(ok, t.thread, "step-start");
        await ok.run(18, () => ok.rx.live(7, { peak: -20 }));
        await press(ok, t.thread, "step-start");
        await ok.run(13, () => ok.rx.live(7, { peak: -45 }));
        assert.match(ok.chat.lastPost(t.thread)!.content, /何も鳴らしていないのに音が載っています/);
        // 「やり直す」→「音を消せない」に切り替えられる
        await press(ok, t.thread, "step-retry");
        await press(ok, t.thread, "cannot-mute");
        await ok.run(13, () => ok.rx.live(7, { peak: -45 }));
        assert.match(ok.chat.lastPost(t.thread)!.content, /手順 3\/5/);
    });
});

describe("録画ファイルが途中で切り替わる", () => {
    it("区間にファイル名を添え、シートにすべてのファイルを残す (1 つだけなら添えない)", async () => {
        const w = makeWorld();
        const { thread } = await startAndStream(w);
        await press(w, thread, "step-start");
        await w.run(18, () => w.rx.live(7, { peak: -20 }));
        // 配信が長く途切れて、denpachan が新しい録画ファイルに切り替えた (位置は 0 から数え直し)
        w.rx.channels.get(7)!.record = { state: "recording", file: "D:\\rec\\rec-ch7-2.mkv", seconds: 0, position: 0 };
        for (let i = 0; i < 3; i++) {
            await press(w, thread, "step-start");
            await w.run(13, () => w.rx.live(7, { peak: -80 }));
        }
        await press(w, thread, "yes");
        await w.service.complete(sessionIdOf(w, thread), "");
        const row = w.sheet.rows[0]!;
        assert.match(String(row[kChecks]), /^game-audio: OK \(\d+%\) \d\d:\d\d〜\d\d:\d\d \[rec-ch7\.mkv\] \/ silence: OK \([^)]*\) 00:0\d〜00:\d\d \[rec-ch7-2\.mkv\] \//);
        assert.equal(row[kFiles], "rec-ch7.mkv / D:\\rec\\rec-ch7-2.mkv");

        // 録画ファイルが 1 つのテストでは、区間にファイル名を添えない
        const one = makeWorld();
        const t = await startAndStream(one);
        await passChecks(one, t.thread);
        await one.service.complete(sessionIdOf(one, t.thread), "");
        assert.ok(!String(one.sheet.rows[0]![kChecks]).includes("["));
        assert.equal(one.sheet.rows[0]![kFiles], "rec-ch7.mkv");
    });

    it("手順の途中で切り替わったら、始まりと終わりのそれぞれにファイル名を添える", () => {
        assert.equal(describeRange({ id: "x", verdict: "ok", recFrom: 230, recTo: 4, recFile: "C:\\v\\a.mkv", recToFile: "C:\\v\\b.mkv" }, 2), " [a.mkv] 03:50〜[b.mkv] 00:04");
        assert.equal(describeRange({ id: "x", verdict: "ok", recFrom: 5, recTo: 9, recFile: "C:/v/a.mkv" }, 1), " 00:05〜00:09");
        assert.equal(describeRange({ id: "x", verdict: "ok" }, 2), "");
    });
});

describe("録画と録音を Google ドライブに上げる", () => {
    const voiceToo = "mic: { via: discord }\n";
    /** テストを 1 つ最後まで通す (録音が有効なら、録音も)。base を省くと、ドライブに上げる設定 */
    async function finishedTest(extra = "", base = driveYaml) {
        const w = makeWorld(extra, base);
        const { thread } = await startAndStream(w);
        await passChecks(w, thread);
        if (w.config.mic.via === "discord") {
            w.voice.where.U1 = "VC-1";
            await press(w, thread, "step-start");
            await w.flush();
            await press(w, thread, "step-next");
        }
        await w.service.complete(sessionIdOf(w, thread), "");
        return w;
    }
    const lastCell = (w: World) => w.sheet.updates.at(-1);

    it("テストが終わったら、テストごとのフォルダに録画と録音を上げ、シートにリンクを書く", async () => {
        const w = await finishedTest(voiceToo);
        assert.equal(w.sheet.rows[0]![col("Google ドライブ")], "アップロード待ち");
        // denpachan が録画ファイルを閉じるのを待ってから上げる
        await w.run(5);
        assert.equal(w.drive.uploaded.length, 0);
        await w.run(7);
        assert.equal(w.drive.folders.length, 1);
        assert.match(w.drive.folders[0]!.name, /^配信テスト 2026-11-01 \d\d:\d\d Runner A$/);
        assert.deepEqual(w.drive.uploaded.map((u) => u.folderId), ["F1", "F1"]);
        assert.equal(w.drive.uploaded[0]!.file, "rec-ch7.mkv");
        assert.match(w.drive.uploaded[1]!.file, /^voice-dir\/.* U1\.ogg$/);
        assert.deepEqual(lastCell(w), { range: "techcheck!K2", values: ["https://drive.google.com/drive/folders/F1"] });
        assert.ok(w.chat.opsLog.some((l) => l.includes("録画と録音を Google ドライブに上げました: Runner A https://drive.google.com/drive/folders/F1")));
        // 上げ終えたら、もう上げない
        await w.run(120);
        assert.equal(w.drive.uploaded.length, 2);
    });

    it("google.drive.folderId が無ければ、上げない", async () => {
        const w = await finishedTest("", baseYaml);
        assert.equal(w.sheet.rows[0]![col("Google ドライブ")], "");
        await w.run(30);
        assert.equal(w.drive.folders.length, 0);
        assert.equal(w.sheet.updates.length, 0);
    });

    it("一時的に失敗したら、あとでやり直す。3 回失敗したら、あきらめて運営に知らせる", async () => {
        const w = await finishedTest();
        w.drive.error = "Drive API: アップロードに失敗しました: 503";
        await w.run(12);
        assert.ok(w.logs.some((l) => l.includes("あとでやり直します (1/3)")));
        assert.equal(w.sheet.updates.length, 0);
        // 1 分後のやり直しで通る
        w.drive.error = undefined;
        await w.run(61);
        assert.deepEqual(w.drive.uploaded.map((u) => u.file), ["rec-ch7.mkv"]);
        assert.deepEqual(lastCell(w)?.values, ["https://drive.google.com/drive/folders/F1"]);

        const bad = await finishedTest();
        bad.drive.error = "Drive API: フォルダを作れません: 404";
        await bad.run(12 + 61 + 121);
        assert.deepEqual(lastCell(bad), { range: "techcheck!K2", values: ["アップロード失敗: Drive API: フォルダを作れません: 404"] });
        assert.ok(bad.chat.opsLog.some((l) => l.includes("録画と録音を Google ドライブに上げられませんでした: Runner A") && l.includes("ファイルは PC に残っています")));
        await bad.run(300);
        assert.equal(bad.sheet.updates.length, 1, "あきらめたあとは、やり直さない");
    });

    it("PC に無いファイルは飛ばして、ほかのファイルは上げる", async () => {
        const w = await finishedTest(voiceToo);
        w.drive.missing = ["rec-ch7.mkv"];
        await w.run(12);
        assert.equal(w.drive.uploaded.length, 1);
        assert.match(String(lastCell(w)?.values[0]), /^https:\/\/drive\.google\.com\/drive\/folders\/F1 \(上げられなかったもの: rec-ch7\.mkv \(ファイルがありません\)\)$/);
    });

    it("上げる前に bot を起動し直しても、続きから上げる", async () => {
        const w = await finishedTest();
        const again = makeWorld("", driveYaml, w.store);
        again.clock.t = w.clock.t;
        assert.ok(again.service.startupSummary().some((l) => l.includes("Google ドライブに上げるのを待っているテスト: Runner A")));
        await again.run(12);
        assert.deepEqual(again.drive.uploaded.map((u) => u.file), ["rec-ch7.mkv"]);
        assert.deepEqual(lastCell(again), { range: "techcheck!K2", values: ["https://drive.google.com/drive/folders/F1"] });
    });
});

describe("マイクの声の録音 (ボイスチャンネル)", () => {
    const voiceOn = "mic: { via: discord }\n";
    /** 既定の 5 手順を通して、6 つ目 (マイクの録音) が出るところまで進める */
    async function toVoiceStep(extra = voiceOn) {
        const w = makeWorld(extra);
        const { thread } = await startAndStream(w);
        await passChecks(w, thread);
        return { w, thread };
    }

    it("既定では手順に無い。mic.via: discord で、最後の手順として足す", async () => {
        assert.equal(makeWorld().config.checks.some((c) => c.kind === "micRecord"), false);
        const { w, thread } = await toVoiceStep();
        const prompt = w.chat.lastPost(thread)!;
        assert.match(prompt.content, /手順 6\/6[\s\S]*下のボイスチャンネルに入り[\s\S]*入るボイスチャンネル: <#VC-1>/);
        assert.deepEqual(prompt.buttons?.map((b) => b.label), ["始める", "マイクは使わない"]);
    });

    it("案内したボイスチャンネルに入って「始める」を押すと録音し、ファイルと音量をシートに残す", async () => {
        const { w, thread } = await toVoiceStep();
        // 入る前に押したら、入るよう促す
        assert.match((await press(w, thread, "step-start")).ephemeral!, /案内したボイスチャンネル \(<#VC-1>\) に入ってから/);
        assert.equal(w.voice.calls.length, 0);
        w.voice.where.U1 = "VC-1";
        await press(w, thread, "step-start");
        await w.flush();
        assert.deepEqual({ ...w.voice.calls[0], file: "" }, { channelId: "VC-1", userId: "U1", file: "", seconds: 15 });
        assert.match(w.voice.calls[0]!.file, /^voice-dir\/2026-11-01-12-\d\d-\d\d Runner_A U1\.ogg$/);
        const texts = w.chat.texts(thread);
        assert.ok(texts.some((x) => x.includes("録音しています。15 秒ほど")));
        assert.ok(texts.some((x) => x.includes("録音しました (声が 10 秒ぶん届きました)")));
        // どれくらいの音量で届いたかを、数字と波形の画像で返す
        const recorded = w.chat.lastPost(thread)!;
        assert.match(recorded.content, /届いた声の音量: 最大 -6 dB、平均 -24 dB \(0 dB が上限です\)。\n下の画像は、録音した声の波形です/);
        assert.equal(recorded.image?.name, "voice-waveform.png");
        assert.equal(recorded.image?.data.toString(), "waveform");
        // すぐには次へ進まない: 音量を見て、録り直すか、これでよいかを配信者が選ぶ
        assert.match(recorded.content, /マイクの音量を直して録り直すときは「録り直す」を、これでよければ「これでよい」を押してください/);
        assert.deepEqual(recorded.buttons?.map((b) => b.label), ["録り直す", "これでよい"]);
        await press(w, thread, "step-next");
        assert.ok(w.chat.texts(thread).some((x) => x === "ボイスチャンネルからは退出してください。"));
        assert.match(w.chat.lastPost(thread)!.content, /確認はすべて終わりました/);
        assert.ok(!w.chat.lastPost(thread)!.content.includes("そのまま進めた"));
        await w.service.complete(sessionIdOf(w, thread), "");
        const row = w.sheet.rows[0]!;
        assert.match(String(row[sheetColumns.indexOf("マイクの録音 (VC)")]), /^voice-dir\/.*U1\.ogg \(声 10 秒、最大 -6 dB、平均 -24 dB\)$/);
        assert.match(String(row[kChecks]), /voice: OK \(-24 dB\)$/);
    });

    it("録音のあと、音量を直して録り直せる。記録に残るのは最後の録音", async () => {
        const { w, thread } = await toVoiceStep();
        w.voice.where.U1 = "VC-1";
        // 1 回目: 声が小さい
        w.voice.next = { packets: 400, bytes: 30_000, audioMs: 9_000, maxDb: -30, meanDb: -48, clippedPct: 0 };
        await press(w, thread, "step-start");
        await w.flush();
        assert.match(w.chat.lastPost(thread)!.content, /声が小さめです/);
        await press(w, thread, "step-retry");
        // 同じボイスチャンネルを、もう一度案内する
        const again = w.chat.lastPost(thread)!;
        assert.match(again.content, /手順 6\/6[\s\S]*入るボイスチャンネル: <#VC-1>/);
        assert.deepEqual(again.buttons?.map((b) => b.label), ["始める", "マイクは使わない"]);
        // 2 回目: ちょうどよい。同じ分のうちに録り直しても、前の録音を上書きしない (ファイル名に秒まで入れる)
        w.clock.t += 20_000;
        w.voice.next = { packets: 500, bytes: 60_000, audioMs: 11_000, maxDb: -5, meanDb: -22, clippedPct: 0 };
        await press(w, thread, "step-start");
        await w.flush();
        assert.ok(!w.chat.lastPost(thread)!.content.includes("声が小さめです"));
        await press(w, thread, "step-next");
        assert.equal(w.voice.calls.length, 2);
        assert.notEqual(w.voice.calls[0]!.file, w.voice.calls[1]!.file, "録り直しは別のファイルに録る");
        await w.service.complete(sessionIdOf(w, thread), "");
        const cell = String(w.sheet.rows[0]![sheetColumns.indexOf("マイクの録音 (VC)")]);
        assert.ok(cell.startsWith(w.voice.calls[1]!.file) && cell.includes("平均 -22 dB"));
    });

    it("声が届かなければ直し方を出し、やり直せる。音が割れていれば伝える", async () => {
        const { w, thread } = await toVoiceStep();
        w.voice.where.U1 = "VC-1";
        w.voice.next = { packets: 0, bytes: 0, audioMs: 0 };
        await press(w, thread, "step-start");
        await w.flush();
        assert.match(w.chat.lastPost(thread)!.content, /声が届いていません。Discord でミュートになっていないか/);
        await press(w, thread, "step-retry");
        w.voice.next = { packets: 400, bytes: 50_000, audioMs: 8_000, maxDb: 0, meanDb: -12, clippedPct: 0.24 };
        await press(w, thread, "step-start");
        await w.flush();
        assert.ok(w.chat.texts(thread).some((x) => x.includes("録音しました") && x.includes("音が割れているところがあります")));
        assert.equal(w.voice.calls.length, 2);
    });

    it("マイクを使わない人は飛ばせる", async () => {
        const { w, thread } = await toVoiceStep();
        await press(w, thread, "voice-skip");
        assert.ok(w.chat.texts(thread).some((x) => x.includes("マイクの確認は飛ばします")));
        assert.match(w.chat.lastPost(thread)!.content, /確認はすべて終わりました/);
        // 結果のまとめには、選んだとおりに書く (「記録のみ」では、何が記録されたのか分からない)
        assert.match(w.chat.lastPost(thread)!.content, /- マイク音: マイクは使わない$/m);
        await w.service.complete(sessionIdOf(w, thread), "");
        assert.ok(w.chat.texts(thread).some((x) => x.includes("配信テストの結果") && /- マイク音: マイクは使わない$/m.test(x)));
        assert.equal(w.sheet.rows[0]![sheetColumns.indexOf("マイクの録音 (VC)")], "マイクは使わない");
        assert.equal(w.voice.calls.length, 0);
    });

    it("bot の側の問題で録れなかったら、運営に知らせて、そのまま次へ進める", async () => {
        const { w, thread } = await toVoiceStep();
        w.voice.where.U1 = "VC-1";
        w.voice.error = "VC に入れませんでした (bot に、その VC の「チャンネルを表示」と「接続」の権限があるかを確かめてください。状態: signalling)";
        await press(w, thread, "step-start");
        await w.flush();
        assert.ok(w.chat.opsLog.some((l) => l.includes("マイクの声を録音できませんでした: Runner A") && l.includes("「接続」の権限")));
        assert.ok(w.chat.texts(thread).some((x) => x.includes("こちらの都合で録音できませんでした")));
        assert.match(w.chat.lastPost(thread)!.content, /確認はすべて終わりました/);
    });

    /** 5 つ目の手順 (画面) の手前まで進める。録音の手順が出る前に、ボイスチャンネルの様子を作るため */
    async function beforeVoiceStep(extra = voiceOn) {
        const w = makeWorld(extra);
        const { thread } = await startAndStream(w);
        await press(w, thread, "step-start");
        await w.run(18, () => w.rx.live(7, { peak: -20 }));
        for (let i = 0; i < 3; i++) {
            await press(w, thread, "step-start");
            await w.run(13, () => w.rx.live(7, { peak: -80 }));
        }
        return { w, thread };
    }

    it("bot が入れるボイスチャンネルのうち、空いている所を案内する。別の所にいたら促す", async () => {
        const { w, thread } = await beforeVoiceStep();
        w.voice.rooms = [
            { id: "VC-1", name: "vc-1" },
            { id: "VC-2", name: "vc-2" },
            { id: "VC-3", name: "vc-3" },
        ];
        w.voice.where.OTHER = "VC-1"; // ほかの人が使っている
        await press(w, thread, "yes");
        assert.match(w.chat.lastPost(thread)!.content, /入るボイスチャンネル: <#VC-2>/);
        w.voice.where.U1 = "VC-3";
        assert.match((await press(w, thread, "step-start")).ephemeral!, /案内したボイスチャンネル \(<#VC-2>\) に入ってから/);
        w.voice.where.U1 = "VC-2";
        await press(w, thread, "step-start");
        await w.flush();
        assert.equal(w.voice.calls[0]!.channelId, "VC-2");
    });

    it("配信者がもう 1 人で入っている所があれば、そこを案内する", async () => {
        const { w, thread } = await beforeVoiceStep();
        w.voice.rooms = [
            { id: "VC-1", name: "vc-1" },
            { id: "VC-2", name: "vc-2" },
        ];
        w.voice.where.U1 = "VC-2";
        await press(w, thread, "yes");
        assert.match(w.chat.lastPost(thread)!.content, /入るボイスチャンネル: <#VC-2>/);
    });

    it("空いている所が無ければ待たせ、空いたらメンションして案内する。待っている間は時間切れにしない", async () => {
        const { w, thread } = await beforeVoiceStep();
        w.voice.where.OTHER = "VC-1";
        await press(w, thread, "yes");
        const waiting = w.chat.lastPost(thread)!;
        assert.match(waiting.content, /手順 6\/6[\s\S]*いま、空いているボイスチャンネルがありません。空いたらここでお知らせします/);
        assert.deepEqual(waiting.buttons?.map((b) => b.label), ["マイクは使わない"]);
        assert.ok(w.chat.opsLog.some((l) => l.includes("空いているボイスチャンネルが無いので、録音の手順で待ってもらっています: Runner A") && l.includes("vc-1")));
        const posts = w.chat.texts(thread).length;
        // 既定の時間切れ (20 分) を超えて待たせても、中断しない。同じ案内も繰り返さない
        await w.run(25 * 60, () => w.rx.live(7, { peak: -80 }));
        assert.equal(w.chat.texts(thread).length, posts);
        assert.equal(w.sheet.rows.length, 0);
        delete w.voice.where.OTHER;
        await w.run(2, () => w.rx.live(7, { peak: -80 }));
        const prompt = w.chat.lastPost(thread)!;
        assert.match(prompt.content, /^<@U1> お待たせしました。ボイスチャンネルが空きました。\n\*\*手順 6\/6\*\*[\s\S]*入るボイスチャンネル: <#VC-1>/);
        assert.deepEqual(prompt.buttons?.map((b) => b.label), ["始める", "マイクは使わない"]);
        // 案内したあとにほかの人が入ってきても、案内は変えない (録るのは配信者の声だけ)
        w.voice.where.OTHER = "VC-1";
        w.voice.where.U1 = "VC-1";
        await press(w, thread, "step-start");
        await w.flush();
        assert.equal(w.voice.calls[0]!.channelId, "VC-1");
    });

    it("待っている間も「マイクは使わない」で飛ばせる", async () => {
        const { w, thread } = await beforeVoiceStep();
        w.voice.where.OTHER = "VC-1";
        await press(w, thread, "yes");
        await press(w, thread, "voice-skip");
        assert.match(w.chat.lastPost(thread)!.content, /確認はすべて終わりました/);
    });

    it("bot が入れるボイスチャンネルが 1 つも無ければ、運営に知らせて、そのまま次へ進める", async () => {
        const { w, thread } = await beforeVoiceStep();
        w.voice.rooms = [];
        await press(w, thread, "yes");
        assert.ok(w.chat.opsLog.some((l) => l.includes("マイクの声を録音できませんでした: Runner A") && l.includes("bot が入れるボイスチャンネルがありません")));
        assert.ok(w.chat.texts(thread).some((x) => x.includes("こちらの都合で録音できませんでした")));
        assert.match(w.chat.lastPost(thread)!.content, /確認はすべて終わりました/);
    });

    const U2local = { id: "U2", displayName: "Runner B" };
    const quiet = (w: ReturnType<typeof makeWorld>) => () => {
        w.rx.live(7, { peak: -80 });
        w.rx.live(6, { peak: -80 });
    };
    /** SRT の枠を 2 つにして、2 人とも録音の手順まで進める (1 人目が先に着く) */
    async function twoAtVoiceStep(rooms: string[]) {
        const w = makeWorld(voiceOn, twoSlotsYaml);
        w.voice.rooms = rooms.map((id) => ({ id, name: id.toLowerCase() }));
        await w.service.start(U1, "C-test", undefined, "ja");
        await w.service.start(U2local, "C-test", undefined, "ja");
        await w.flush();
        w.flow.sampleAt = (t) => goodSample(t);
        await w.run(140, () => {
            w.rx.live(7);
            w.rx.live(6);
        });
        const [t1, t2] = w.chat.threads.map((t) => t.id);
        // 2 人とも、5 手順を通す (それぞれのチャンネルの音で)
        for (const [thread, user, ch] of [
            [t1!, U1, 7],
            [t2!, U2local, 6],
        ] as const) {
            const audio = (peak: number) => () => {
                w.rx.live(7, { peak: ch === 7 ? peak : -80 });
                w.rx.live(6, { peak: ch === 6 ? peak : -80 });
            };
            await press(w, thread, "step-start", user);
            await w.run(18, audio(-20));
            for (let i = 0; i < 3; i++) {
                await press(w, thread, "step-start", user);
                await w.run(13, audio(-80));
            }
            await press(w, thread, "yes", user);
        }
        return { w, t1: t1!, t2: t2! };
    }

    it("同時にテストしている 2 人には、別々のボイスチャンネルを案内する。録音は同時に 1 人だけ", async () => {
        const { w, t1, t2 } = await twoAtVoiceStep(["VC-1", "VC-2"]);
        // 1 人目はまだ入っていないが、案内した所は、ほかの人には案内しない
        assert.match(w.chat.lastPost(t1)!.content, /入るボイスチャンネル: <#VC-1>/);
        assert.match(w.chat.lastPost(t2)!.content, /入るボイスチャンネル: <#VC-2>/);
        w.voice.where.U1 = "VC-1";
        w.voice.where.U2 = "VC-2";
        // bot は同時に 1 つのボイスチャンネルにしか入れない
        let release!: () => void;
        w.voice.gate = new Promise<void>((r) => (release = r));
        await press(w, t1, "step-start", U1);
        assert.match((await press(w, t2, "step-start", U2local)).ephemeral!, /ほかの方の録音中です/);
        release();
        await w.flush();
        w.voice.gate = undefined;
        await press(w, t2, "step-start", U2local);
        await w.flush();
        assert.deepEqual(w.voice.calls.map((c) => [c.userId, c.channelId]), [["U1", "VC-1"], ["U2", "VC-2"]]);
    });

    it("ボイスチャンネルが 1 つなら、2 人目は、1 人目の録音が終わって退出するまで待つ", async () => {
        const { w, t1, t2 } = await twoAtVoiceStep(["VC-1"]);
        assert.match(w.chat.lastPost(t1)!.content, /入るボイスチャンネル: <#VC-1>/);
        assert.match(w.chat.lastPost(t2)!.content, /いま、空いているボイスチャンネルがありません/);
        assert.equal((await press(w, t2, "step-start", U2local)).ephemeral, "受け付けました。");
        w.voice.where.U1 = "VC-1";
        await press(w, t1, "step-start", U1);
        await w.flush();
        // 1 人目の録音は終わったが、録り直すかもしれないので、ボイスチャンネルは 1 人目のもののまま
        await w.run(2, quiet(w));
        assert.match(w.chat.lastPost(t2)!.content, /いま、空いているボイスチャンネルがありません/);
        // 1 人目が「これでよい」で次へ進んだが、まだ中にいる
        await press(w, t1, "step-next", U1);
        await w.run(2, quiet(w));
        assert.match(w.chat.lastPost(t2)!.content, /いま、空いているボイスチャンネルがありません/);
        delete w.voice.where.U1;
        await w.run(2, quiet(w));
        assert.match(w.chat.lastPost(t2)!.content, /^<@U2> お待たせしました[\s\S]*入るボイスチャンネル: <#VC-1>/);
    });
});

describe("latency の調整と RTMP", () => {
    function lossy(from: number, until: number) {
        return (t: number): SrtSample => ({ ...goodSample(t), notRecovered: t >= from && t < until ? 2 : 0 });
    }

    it("運営にも latency は μs (OBS の URL に入れる値) で見せ、/techcheck latency も μs で受ける", async () => {
        const w = makeWorld();
        const { thread } = await startAndStream(w);
        assert.ok(w.chat.opsLog.some((l) => l.includes("映像 OK") && l.includes("latency 100000 μs")), w.chat.opsLog.join("\n"));
        assert.match(await w.service.status("U1"), /latency 100000 μs/);
        // 運営が 300000 μs (300 ms) を案内する
        assert.equal(await w.service.setLatency("U1", 300_000), "Runner A に latency 300000 μs を案内しました");
        const ask = w.chat.texts(thread).at(-1)!;
        assert.ok(ask.includes("latency を **300000 μs**") && ask.includes("latency=300000"), ask);
        // 上限 (latency.maxUs) を超える値は上限に抑え、抑えた値を返す
        assert.match(await w.service.setLatency("U1", 9_000_000), /latency 2000000 μs を案内しました/);
        for (const text of [...w.chat.opsLog, await w.service.status("U1")]) {
            assert.doesNotMatch(text, /latency \d+ ms|推奨 \d+ ms/, `運営向けの latency に ms が残っていない: ${text}`);
        }
    });

    it("取りこぼすと latency を上げてもらい、始め直したら測り直す", async () => {
        const w = makeWorld();
        await w.service.start(U1, "C-test", undefined, "ja");
        await w.flush();
        const thread = w.chat.threads[0]!.id;
        const t0 = Math.floor(w.clock.t / 1000);
        w.flow.sampleAt = lossy(t0, t0 + 10_000);
        await w.run(80, () => w.rx.live(7));
        const ask = w.chat.texts(thread).find((x) => x.includes("latency を **150000 μs**"));
        assert.ok(ask, "150 ms (配信者には 150000 μs) に上げる案内");
        assert.ok(ask.includes("latency=150000"));

        // 配信者が設定して始め直す。回線も良くなった
        w.flow.sampleAt = (t) => goodSample(t);
        assert.match((await press(w, thread, "set")).ephemeral!, /始め直すと/);
        await w.run(3, () => w.rx.drop(7));
        await w.run(150, () => w.rx.live(7));
        const texts = w.chat.texts(thread);
        assert.ok(texts.some((x) => x.includes("latency 150000 μs で計測し直します")));
        assert.ok(texts.some((x) => x.includes("映像は問題なく届いています") && x.includes("**150000 μs**")));
    });

    it("取りこぼしが無く、推奨値に足りないだけなら、推奨値ちょうどに上げてもらう (今の値を 1.5 倍にしない)", async () => {
        const w = makeWorld();
        await w.service.start(U1, "C-test", undefined, "ja");
        await w.flush();
        const thread = w.chat.threads[0]!.id;
        // RTT 40 ms、ロスなし: 推奨値は 40 × 3 = 120 ms。今は 100 ms
        w.flow.sampleAt = (t) => ({ ...goodSample(t), rttMs: 40 });
        await w.run(80, () => w.rx.live(7));
        assert.ok(w.chat.texts(thread).some((x) => x.includes("latency を **120000 μs**")), w.chat.texts(thread).join("\n"));
        assert.ok(!w.chat.texts(thread).some((x) => x.includes("150000")));
    });

    it("RTMP に案内する前に、SRT の上限を 1 回試してもらう。上限で安定すれば SRT のまま進む", async () => {
        const w = makeWorld("latency: { maxRaises: 1 }\n");
        await w.service.start(U1, "C-test", undefined, "ja");
        await w.flush();
        const thread = w.chat.threads[0]!.id;
        const t0 = Math.floor(w.clock.t / 1000);
        const restart = async () => {
            await press(w, thread, "set");
            await w.run(3, () => w.rx.drop(7));
        };
        // 1 回目: 推奨値 (取りこぼしたので 1.5 倍) に上げる
        w.flow.sampleAt = lossy(t0, t0 + 10_000);
        await w.run(80, () => w.rx.live(7));
        assert.ok(w.chat.texts(thread).some((x) => x.includes("latency を **150000 μs**")));
        // 上げても取りこぼす。回数 (1 回) は使い切ったが、RTMP ではなく、SRT の上限を案内する
        await restart();
        await w.run(80, () => w.rx.live(7));
        assert.ok(w.chat.texts(thread).some((x) => x.includes("latency を **2000000 μs**")), w.chat.texts(thread).join("\n"));
        assert.ok(!w.chat.texts(thread).some((x) => x.includes("RTMP で試します")));
        assert.ok(w.chat.opsLog.some((l) => l.includes("SRT の上限を試します") && l.includes("150000 → 2000000 μs")));
        // 上限にしたら安定した
        w.flow.sampleAt = (t) => goodSample(t);
        await restart();
        await w.run(150, () => w.rx.live(7));
        assert.ok(w.chat.texts(thread).some((x) => x.includes("映像は問題なく届いています") && x.includes("**2000000 μs**")));
        assert.ok(!w.chat.texts(thread).some((x) => x.includes("RTMP で試します")));
    });

    it("SRT の上限でも安定しなければ、RTMP に案内する", async () => {
        const w = makeWorld("latency: { maxRaises: 0 }\n");
        await w.service.start(U1, "C-test", undefined, "ja");
        await w.flush();
        const thread = w.chat.threads[0]!.id;
        const t0 = Math.floor(w.clock.t / 1000);
        w.flow.sampleAt = lossy(t0, t0 + 10_000);
        await w.run(80, () => w.rx.live(7));
        assert.ok(w.chat.texts(thread).some((x) => x.includes("latency を **2000000 μs**")));
        await press(w, thread, "set");
        await w.run(3, () => w.rx.drop(7));
        await w.run(80, () => w.rx.live(7));
        assert.ok(w.chat.texts(thread).some((x) => x.includes("RTMP で試します")));
        assert.ok(w.chat.opsLog.some((l) => l.includes("RTMP に案内") && l.includes("SRT の上限 2000000 μs でも安定しない")));
    });

    it("上げても直らなければ RTMP に案内し、届いたら SRT の枠を空ける", async () => {
        const w = makeWorld("latency: { maxRaises: 0, maxUs: 100000 }\n");
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

    it("ドメインを引けなかったときは、別の IP を指しているのとは分けて、理由を付けて知らせる", async () => {
        const w = makeWorld();
        w.dns.resolve = async () => {
            throw new Error("DNS サーバに直接聞くと ECONNREFUSED、OS の引き方でも EAI_AGAIN");
        };
        await w.service.start(U1, "C-test", undefined, "ja");
        await w.flush();
        const ops = w.chat.opsLog.find((l) => l.includes("止めました"))!;
        assert.match(ops, /ドメイン srt-a\.example\.jp を引けません \(DNS サーバに直接聞くと ECONNREFUSED、OS の引き方でも EAI_AGAIN\)/);
        assert.match(ops, /bot を動かしている PC の DNS の問題かもしれません/);
        assert.ok(!ops.includes("指していません"));
    });

    it("枠のチャンネルの受信の方式が合っていなければ、始めずに知らせる (設定ファイルで SRT と RTMP を逆に書いたとき)", async () => {
        // denpachan の ch7 は SRT、ch8 は RTMP の pull。設定ファイルでは逆に書いてある
        const swapped = baseYaml.replace("srt: { flow: flow-a, channel: 7 }", "srt: { flow: flow-a, channel: 8 }").replace("rtmp: { channel: 8 }", "rtmp: { channel: 7 }");
        const w = makeWorld("", swapped);
        assert.deepEqual(w.service.slotMismatches(), [
            "SRT の枠: denpachan の ch8 の受信が SRT ではありません (rtmp pull)。denpachan のチャンネルの設定か、枠の設定 (slots) を直してください。",
            "RTMP の枠: denpachan の ch7 の受信が RTMP の pull ではありません (srt caller)。denpachan のチャンネルの設定か、枠の設定 (slots) を直してください。",
        ]);
        await w.service.reportSlotMismatches();
        assert.ok(w.chat.opsLog.some((l) => l.includes("枠の設定が denpachan のチャンネルと合っていません")));

        // そのまま始めようとしても、フローを開始する前に止める
        assert.match(await w.service.start(U1, "C-test", undefined, "ja"), /準備に問題がありました/);
        assert.equal(w.flow.started, 0);
        assert.ok(w.chat.opsLog.some((l) => l.includes("止めました") && l.includes("ch8 の受信が SRT ではありません")));

        // 合っていれば、何も言わない
        assert.deepEqual(makeWorld().service.slotMismatches(), []);
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

    it("起動し直したとき: 問題で止めた枠は再開し、列の先頭の人に知らせる", async () => {
        const w1 = makeWorld();
        w1.dns.answers["srt-a.example.jp"] = ["192.0.2.99"]; // ドメインの設定が間違っている
        await w1.service.start(U1, "C-test", undefined, "ja");
        await w1.flush();
        assert.match(await w1.service.slotShow(), /止めている[\s\S]*1\. Runner A/);

        // 直して起動し直す (設定ファイルは同じ)。/techcheck slot on をしなくても、受付が戻る
        const w2 = makeWorld("", baseYaml, w1.store);
        assert.ok(w2.service.startupSummary().some((l) => l.includes("前回は問題があって止めていました。起動し直したので、受付を再開します")));
        assert.match(await w2.service.slotShow(), /SRT の枠: フロー flow-a \/ ch7 \/ 受付中/);
        await w2.run(1);
        assert.equal(w2.chat.called.at(-1)?.userId, "U1");

        // 運営が止めた枠は、起動し直しても止めたまま
        await w2.service.slotEnable("srt", false);
        const w3 = makeWorld("", baseYaml, w2.store);
        assert.match(await w3.service.slotShow(), /SRT の枠: フロー flow-a \/ ch7 \/ 止めている/);
    });

    it("起動し直したとき: 進行中のテストは今の設定ファイルのフローを使い、フローが無くなっていれば中断する", async () => {
        const w1 = makeWorld();
        await w1.service.start(U1, "C-test", undefined, "ja");
        await w1.flush();

        // フローの ARN とドメインを書き換えて起動し直す
        const moved = baseYaml.replace("arn: arn:flow-a", "arn: arn:flow-a2").replace("domain: srt-a.example.jp", "domain: srt-b.example.jp");
        const w2 = makeWorld("", moved, w1.store);
        assert.ok(w2.service.startupSummary().some((l) => l.includes("Runner A のテスト: フロー flow-a の設定が変わったので")));
        assert.match(await w2.service.status("U1"), /Runner A/);

        // フローの名前ごと変えて起動し直すと、そのテストは続けられないので中断する
        const renamed = baseYaml.replaceAll("flow-a", "flow-x");
        const w3 = makeWorld("", renamed, w2.store);
        await w3.run(1);
        assert.match(await w3.service.status("U1"), /進行中のテストはありません/);
        assert.match(String(w3.sheet.rows[0]![7]), /設定ファイルからフロー flow-a が無くなった/);
        assert.ok(!w3.logs.some((l) => l.startsWith("tick ")), "tick のたびにエラーにならない");
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
    it("チェックの間は、無音を知らせない (ゲームの音を止めたままの手順が続くので)", async () => {
        const w = makeWorld();
        const { thread } = await startAndStream(w);
        const audio = (peak: number) => () => w.rx.live(7, { peak });
        await press(w, thread, "step-start");
        await w.run(18, audio(-20)); // ゲーム音
        await press(w, thread, "step-start");
        await w.run(13, audio(-80)); // 静か
        await press(w, thread, "step-start");
        await w.run(13, audio(-80)); // マイク (載らない)
        await press(w, thread, "step-start");
        await w.run(13, audio(-80)); // PC の音 (載らない)
        // 「画面」の手順。ゲームの音は止めたままで、無音が 40 秒以上続いている
        await w.run(15, audio(-80));
        assert.match(w.chat.lastPost(thread)!.content, /配信に映っている画面は正しいですか/);
        assert.ok(!w.chat.texts(thread).some((x) => x.includes("音が届いていません")));
    });

    it("映像を判定している間に無音が続いたら、知らせる", async () => {
        const w = makeWorld();
        await w.service.start(U1, "C-test", undefined, "ja");
        await w.flush();
        w.flow.sampleAt = (t) => goodSample(t);
        await w.run(30, () => w.rx.live(7, { peak: -80 }));
        assert.ok(w.chat.texts(w.chat.threads[0]!.id).some((x) => x.includes("音が届いていません")));
    });

    /** 「画面」の手順が出るところまで進める */
    async function toPictureStep(w: World, thread: string) {
        const audio = (peak: number) => () => w.rx.live(7, { peak });
        await press(w, thread, "step-start");
        await w.run(18, audio(-20));
        for (let i = 0; i < 3; i++) {
            await press(w, thread, "step-start");
            await w.run(13, audio(-80));
        }
        return w.chat.posts.filter((p) => p.threadId === thread).at(-1)!.msg;
    }
    const thumbnailsOff = async () => {
        throw new Error("This action can only be performed on a flow with ThumbnailState in SourceMonitoringConfiguration set to ENABLED.");
    };

    // 配信が途切れた時間は録画ファイルに入らない。denpachan の record.seconds (録画を始めてからの時間) は途切れた分だけ
    // ファイルより先へ進むので、録画の区間と静止画の位置は record.position (録画ファイルの中の位置) から取る
    async function checksAfterGap(hasPosition: boolean) {
        const w = makeWorld();
        w.rx.hasPosition = hasPosition;
        const { thread } = await startAndStream(w);
        const rec = w.rx.channels.get(7)!.record!;
        // 10 秒途切れて戻る (配信者が OBS の配信を始め直した、など)
        await w.run(10, () => w.rx.drop(7));
        await w.run(5, () => w.rx.live(7));
        assert.equal(rec.seconds! - (rec.position ?? rec.seconds!), hasPosition ? 10 : 0);
        const atStart = { seconds: rec.seconds!, position: rec.position };
        const picture = await toPictureStep(w, thread);
        assert.ok(picture.image, "画面の手順に静止画が付く");
        const still = w.still.calls.at(-1)!.atSec;
        await press(w, thread, "yes");
        await press(w, thread, "done");
        await w.service.complete(sessionIdOf(w, thread), "");
        const checks = String(w.sheet.rows[0]![kChecks]);
        return { rec, atStart, still, checks };
    }

    it("録画の区間と静止画の位置は、途切れのあとも、録画ファイルの中の位置 (record.position) から取る", async () => {
        const { rec, atStart, still, checks } = await checksAfterGap(true);
        assert.ok(checks.includes(`game-audio: OK (100%) ${formatRecPos(atStart.position)}〜`), checks);
        assert.ok(!checks.includes(`${formatRecPos(atStart.seconds)}〜`), `seconds (途切れの分だけ先) の位置は書かない: ${checks}`);
        assert.ok(rec.position! - still >= 2 && rec.position! - still <= 3, `録画の位置 ${rec.position} 秒に対して静止画は ${still} 秒`);
    });

    it("record.position を出さない版の denpachan では、record.seconds で代える", async () => {
        const { rec, atStart, still, checks } = await checksAfterGap(false);
        assert.ok(checks.includes(`game-audio: OK (100%) ${formatRecPos(atStart.seconds)}〜`), checks);
        assert.ok(rec.seconds! - still >= 2 && rec.seconds! - still <= 3, `録画 ${rec.seconds} 秒に対して静止画は ${still} 秒`);
    });

    it("画面の手順の静止画は、denpachan の録画から取る (フローのサムネイルが無効でも付く)", async () => {
        const w = makeWorld();
        w.flow.thumbnail = thumbnailsOff;
        const { thread } = await startAndStream(w);
        const picture = await toPictureStep(w, thread);
        assert.equal(picture.image?.data.toString(), "still of rec-ch7.mkv");
        assert.ok(!picture.content.includes("静止画を取れませんでした"));
        // 録画の「今」の 2 秒手前を取る (手順を出したあとも録画は 1 秒進んでいる)
        const rec = w.rx.channels.get(7)!.record!;
        const call = w.still.calls.at(-1)!;
        assert.equal(call.file, "rec-ch7.mkv");
        assert.ok(rec.position! - call.atSec >= 2 && rec.position! - call.atSec <= 3, `録画の位置 ${rec.position} 秒に対して ${call.atSec} 秒`);
        assert.ok(!w.chat.opsLog.some((l) => l.includes("静止画を取れません")), "録画から取れていれば、サムネイルが無効でも知らせない");
        const shot = await w.service.shot("U1");
        assert.equal(shot.image?.toString(), "still of rec-ch7.mkv");
    });

    it("録画から取れないときは、フローのサムネイルを使う (bot が別の PC にあるとき)", async () => {
        const w = makeWorld();
        w.still.error = "録画から静止画を取り出せませんでした (No such file or directory)";
        const { thread } = await startAndStream(w);
        const picture = await toPictureStep(w, thread);
        assert.equal(picture.image?.data.toString(), "jpeg");
        assert.ok(!w.chat.opsLog.some((l) => l.includes("静止画を取れません")));
    });

    it("どちらでも取れないときは、理由を運営に 1 回だけ知らせ、OBS のプレビューで答えてもらう", async () => {
        const w = makeWorld();
        w.still.error = "ffmpeg が見つかりません (ffmpeg)。ffmpeg.path を確かめてください";
        w.flow.thumbnail = thumbnailsOff;
        const { thread } = await startAndStream(w);
        const warned = () => w.chat.opsLog.filter((l) => l.includes("配信の静止画を取れません"));
        assert.equal(warned().length, 0, "録画が始まったばかりで取れないだけのときは、知らせない");
        const picture = await toPictureStep(w, thread);
        assert.match(picture.content, /配信に映っている画面は正しいですか[\s\S]*こちらで配信の静止画を取れませんでした。OBS のプレビューを見て答えてください/);
        assert.equal(picture.image, undefined);
        assert.equal(warned().length, 1);
        assert.match(warned()[0]!, /ffmpeg が見つかりません.* \/ フローのサムネイルも無効です/);
        const shot = await w.service.shot("U1");
        assert.match(shot.text, /静止画を取れませんでした: ffmpeg が見つかりません/);
        assert.equal(warned().length, 1, "同じ知らせを繰り返さない");
    });

    it("RTMP に移ったテストの静止画も、RTMP の枠のチャンネルの録画から取る", async () => {
        const w = makeWorld("latency: { maxRaises: 0, maxUs: 100000 }\n");
        await w.service.start(U1, "C-test", undefined, "ja");
        await w.flush();
        const thread = w.chat.threads[0]!.id;
        const t0 = Math.floor(w.clock.t / 1000);
        w.flow.sampleAt = (t) => ({ ...goodSample(t), notRecovered: t >= t0 ? 2 : 0 });
        await w.run(80, () => w.rx.live(7));
        await press(w, thread, "set");
        await w.run(10, () => w.rx.live(8));
        const shot = await w.service.shot("U1");
        assert.equal(shot.image?.toString(), "still of rec-ch8.mkv");
    });

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
        assert.match(String(w.sheet.rows[0]![kChecks]), /mic: おかしい \(そのまま進めた\)/);
    });
});

describe("web カメラ (VDO.ninja)", () => {
    const kView = "https://vdo.ninja/?view=cam1";
    const kCam = col("web カメラ");

    /** 配信が届いて、web カメラの案内が出るところまで進める */
    async function untilAsked(w: World, user = U1, ch = 7) {
        await w.service.start(user, "C-test", undefined, "ja");
        await w.flush();
        const thread = w.chat.threads.find((t) => t.userId === user.id)!.id;
        w.flow.sampleAt = (t) => goodSample(t);
        await w.run(3, () => w.rx.live(ch));
        return thread;
    }

    it("配信が届いたら送信用の URL を渡し、受信用の URL で映像が届いてから計測する。結果はシートに書く", async () => {
        const w = makeWorld(webcamYaml);
        const thread = await untilAsked(w);
        assert.ok(w.chat.texts(thread).some((x) => x.includes("https://vdo.ninja/?push=cam1")));
        // 受信用の URL は、bot が開くだけ (配信者には見せない)
        assert.ok(!w.chat.texts(thread).some((x) => x.includes("view=cam1")));
        assert.deepEqual(w.webcam.opened, [kView]);

        // カメラが届くまでは、計測を始めない
        await w.run(200, () => w.rx.live(7));
        assert.match(await w.service.status("U1"), /awaitingWebcam/);
        assert.ok(!w.chat.texts(thread).some((x) => x.includes("映像は問題なく届いています")));

        // 届いたら (3 秒続けて)、静止画を付けて知らせ、計測を始める
        await w.run(5, () => {
            w.rx.live(7);
            w.webcam.play(kView);
        });
        const arrived = w.chat.posts.find((p) => p.msg.content.includes("web カメラの映像が届きました"))!;
        assert.equal(arrived.msg.image?.data.toString(), "webcam still");
        assert.match(await w.service.status("U1"), /measuring/);
        let received = 1000;
        await w.run(140, () => {
            w.rx.live(7);
            w.webcam.play(kView, { packetsReceived: (received += 100), packetsLost: 0 });
        });
        assert.ok(w.chat.texts(thread).some((x) => x.includes("映像は問題なく届いています")));
        assert.ok(!w.chat.opsLog.some((l) => l.includes("web カメラの映像が乱れています")));

        // 終わったら、受信用のページを閉じ、配信者にもカメラのページを閉じてもらう
        await w.service.cancel("U1");
        assert.equal(w.webcam.views.size, 0);
        assert.match(w.chat.lastPost(thread)!.content, /web カメラのページ.*を閉じてください/);
        assert.equal(w.sheet.rows[0]![kCam], "1280x720 / 30 fps / ロス 0 % / 固まった 0 回");
    });

    it("「web カメラは使わない」で飛ばすと、そのまま計測する", async () => {
        const w = makeWorld(webcamYaml);
        const thread = await untilAsked(w);
        await press(w, thread, "webcam-skip");
        assert.equal(w.webcam.views.size, 0);
        await w.run(140, () => w.rx.live(7));
        assert.ok(w.chat.texts(thread).some((x) => x.includes("映像は問題なく届いています")));
        await w.service.cancel("U1");
        assert.equal(w.sheet.rows[0]![kCam], "使わない");
        assert.ok(!w.chat.lastPost(thread)!.content.includes("web カメラのページ"));
    });

    it("映像の判定の間にカメラが届かなくなったら、待ち直して、届いてから測り直す", async () => {
        const w = makeWorld(webcamYaml);
        const thread = await untilAsked(w);
        const both = () => {
            w.rx.live(7);
            w.webcam.play(kView);
        };
        await w.run(40, both);
        assert.match(await w.service.status("U1"), /measuring/);
        // 一瞬 (10 秒未満) の途切れでは、待ち直さない
        w.webcam.stopPlaying(kView);
        await w.run(5, () => w.rx.live(7));
        await w.run(5, both);
        assert.match(await w.service.status("U1"), /measuring/);
        // 10 秒続けて届かなければ、案内し直す
        w.webcam.stopPlaying(kView);
        await w.run(12, () => w.rx.live(7));
        assert.match(await w.service.status("U1"), /awaitingWebcam/);
        assert.match(w.chat.lastPost(thread)!.content, /届かなくなりました/);
        await w.run(145, both);
        assert.ok(w.chat.texts(thread).some((x) => x.includes("映像は問題なく届いています")));
        // 途切れたことは、運営に知らせて、シートにも残す
        assert.ok(w.chat.opsLog.some((l) => l.includes("web カメラの映像が乱れています") && l.includes("途切れ 1 回")));
        await w.service.cancel("U1");
        assert.match(String(w.sheet.rows[0]![kCam]), /途切れ 1 回/);
    });

    it("判定の間のロスや固まりは、運営に知らせる (テストは進める)", async () => {
        const w = makeWorld(webcamYaml);
        const thread = await untilAsked(w);
        let n = 0;
        await w.run(150, () => {
            w.rx.live(7);
            n++;
            w.webcam.play(kView, { packetsReceived: 1000 + n * 95, packetsLost: n * 5, freezes: n > 100 ? 2 : 0 });
        });
        assert.ok(w.chat.texts(thread).some((x) => x.includes("映像は問題なく届いています")));
        assert.ok(w.chat.opsLog.some((l) => l.includes("web カメラの映像が乱れています") && l.includes("ロス 5 %") && l.includes("固まった 2 回")));
    });

    it("受信用のページを開けなければ、運営に知らせて、web カメラなしで進める", async () => {
        const w = makeWorld(webcamYaml);
        w.webcam.error = "Chrome が見つかりません";
        const thread = await untilAsked(w);
        await w.run(140, () => w.rx.live(7));
        assert.ok(w.chat.opsLog.some((l) => l.includes("web カメラの映像を確認できませんでした") && l.includes("Chrome が見つかりません")));
        assert.ok(w.chat.texts(thread).some((x) => x.includes("こちらの都合で web カメラ")));
        assert.ok(w.chat.texts(thread).some((x) => x.includes("映像は問題なく届いています")));
        await w.service.cancel("U1");
        assert.equal(w.sheet.rows[0]![kCam], "確認できず (bot の側の問題)");
    });

    it("届かないまま 10 分で催促し、20 分で中断する", async () => {
        const w = makeWorld(webcamYaml);
        const thread = await untilAsked(w);
        await w.run(601, () => w.rx.live(7));
        assert.ok(w.chat.texts(thread).some((x) => x.includes("まだ web カメラの映像が届いていません")));
        await w.run(600, () => w.rx.live(7));
        assert.match(String(w.sheet.rows[0]![col("理由")]), /web カメラが届かないまま時間切れ/);
        assert.equal(w.sheet.rows[0]![kCam], "届いていない");
    });

    it("同時にテストしている 2 人には、別々の URL の組を渡す", async () => {
        const two = webcamYaml + '    - { push: "https://vdo.ninja/?push=cam2", view: "https://vdo.ninja/?view=cam2" }\n';
        const w = makeWorld(two, twoSlotsYaml);
        const t1 = await untilAsked(w, U1, 7);
        const t2 = await untilAsked(w, U2, 6);
        assert.ok(w.chat.texts(t1).some((x) => x.includes("push=cam1")));
        assert.ok(w.chat.texts(t2).some((x) => x.includes("push=cam2")));
        assert.deepEqual(w.webcam.opened, [kView, "https://vdo.ninja/?view=cam2"]);
    });

    /** 映像の判定が終わり、音声のチェックの 5 手順を通して、マイクの声の録音の手順が出るところまで進める */
    async function untilMicStep(w: World, skipCamera = false) {
        const thread = await untilAsked(w);
        if (skipCamera) await press(w, thread, "webcam-skip");
        const both = () => {
            w.rx.live(7);
            if (!skipCamera) w.webcam.play(kView, { audio: true });
        };
        await w.run(145, both);
        const audio = (peak: number) => () => {
            w.rx.live(7, { peak });
            if (!skipCamera) w.webcam.play(kView, { audio: true });
        };
        for (const [sec, peak] of [[18, -20], [13, -80], [13, -80], [13, -80]] as const) {
            await press(w, thread, "step-start");
            await w.run(sec, audio(peak));
        }
        await press(w, thread, "yes");
        return thread;
    }

    it("マイクの声の録音は、VDO.ninja で届く音声を録る (Discord のボイスチャンネルは使わない)", async () => {
        const w = makeWorld(webcamYaml);
        assert.deepEqual(w.config.checks.map((c) => c.kind).slice(-1), ["micRecord"]);
        assert.equal(w.config.mic.via, "vdoninja");
        const thread = await untilMicStep(w);
        assert.match(w.chat.lastPost(thread)!.content, /手順 6\/6[\s\S]*VDO\.ninja[\s\S]*push=cam1/);
        await press(w, thread, "step-start");
        await w.flush();
        assert.equal(w.webcam.recorded[0]!.seconds, 15);
        assert.match(w.webcam.recorded[0]!.file, /^voice-dir\/.* Runner_A U1\.webm$/);
        const post = w.chat.lastPost(thread)!;
        assert.match(post.content, /録音しました[\s\S]*最大 -6 dB、平均 -24 dB/);
        assert.equal(post.image?.name, "voice-waveform.png");
        await press(w, thread, "step-next");
        assert.match(w.chat.lastPost(thread)!.content, /確認はすべて終わりました[\s\S]*マイク音: OK/);
        // ボイスチャンネルからの退出は頼まない
        assert.ok(!w.chat.texts(thread).some((x) => x.includes("ボイスチャンネル")));
        await w.service.cancel("U1");
        assert.match(String(w.sheet.rows[0]![col("マイクの録音 (VC)")]), /\.webm \(声 15 秒、最大 -6 dB、平均 -24 dB\)/);
    });

    it("マイクの音声が届いていなければ「始める」で録らずに伝え、無音なら直し方を出す", async () => {
        const w = makeWorld(webcamYaml);
        const thread = await untilMicStep(w);
        w.webcam.play(kView, { audio: false });
        const r = await press(w, thread, "step-start");
        assert.match(r.ephemeral ?? "", /マイクの音声がまだ届いていません/);
        assert.equal(w.webcam.recorded.length, 0);
        // 届いてはいるが、無音 (ページでミュート、別のマイク)
        w.webcam.play(kView, { audio: true });
        w.webcam.nextAudio = { audioMs: 15_000, maxDb: -91, meanDb: -91 };
        await press(w, thread, "step-start");
        await w.flush();
        assert.match(w.chat.lastPost(thread)!.content, /声が届いていません。web カメラのページで/);
        await press(w, thread, "step-retry");
        await press(w, thread, "voice-skip");
        assert.match(w.chat.lastPost(thread)!.content, /マイク音: マイクは使わない/);
    });

    it("web カメラを使わない人も、マイクの手順では受信用のページを開き直して録れる", async () => {
        const w = makeWorld(webcamYaml);
        const thread = await untilMicStep(w, true);
        assert.deepEqual(w.webcam.opened, [kView, kView]);
        assert.match(w.chat.lastPost(thread)!.content, /push=cam1/);
        w.webcam.play(kView, { audio: true });
        await press(w, thread, "step-start");
        await w.flush();
        assert.match(w.chat.lastPost(thread)!.content, /録音しました/);
        await w.service.cancel("U1");
        assert.match(w.chat.lastPost(thread)!.content, /web カメラのページ.*を閉じてください/);
    });

    it("web カメラが届いたら録画を始め、終わったらシートに書き、録画と一緒に Google ドライブに上げる", async () => {
        const w = makeWorld(webcamYaml, driveYaml);
        const thread = await untilAsked(w);
        // 届く前は録らない
        await w.run(3, () => w.rx.live(7));
        assert.equal(w.webcam.recordBases.size, 0);
        await w.run(6, () => {
            w.rx.live(7);
            w.webcam.play(kView);
        });
        const base = [...w.webcam.recordBases.values()][0]!;
        assert.match(base, /^webcam-dir\/2026-11-01-12-0\d-\d\d Runner_A U1 webcam$/);
        await w.service.cancel("U1");
        assert.ok(w.chat.lastPost(thread));
        assert.equal(w.sheet.rows[0]![col("web カメラの録画")], `${base}.webm`);
        // 録画を書き終えて (ページを閉じて) から、上げる
        await w.run(15);
        await w.flush();
        assert.deepEqual(
            w.drive.uploaded.map((u) => u.file),
            ["rec-ch7.mkv", `${base}.webm`],
        );
    });

    it("「web カメラは使わない」の人と、vdoninja.record: false では録らない", async () => {
        const w = makeWorld(webcamYaml);
        const thread = await untilAsked(w);
        await press(w, thread, "webcam-skip");
        await w.run(5, () => w.rx.live(7));
        assert.equal(w.webcam.recordBases.size, 0);

        const w2 = makeWorld(`${webcamYaml}  record: false\n`);
        await untilAsked(w2);
        await w2.run(6, () => {
            w2.rx.live(7);
            w2.webcam.play(kView);
        });
        assert.match(await w2.service.status("U1"), /measuring/);
        assert.equal(w2.webcam.recordBases.size, 0);
        await w2.service.cancel("U1");
        assert.equal(w2.sheet.rows[0]![col("web カメラの録画")], "");
    });

    it("bot を起動し直したら、録画も別のファイルで録り直し、前のファイルも残す", async () => {
        const w = makeWorld(webcamYaml);
        await untilAsked(w);
        await w.run(6, () => {
            w.rx.live(7);
            w.webcam.play(kView);
        });
        const first = `${[...w.webcam.recordBases.values()][0]!}.webm`;
        const w2 = makeWorld(webcamYaml, baseYaml, w.store);
        w2.clock.t = w.clock.t + 5_000;
        await w2.run(1, () => w2.rx.live(7));
        w2.webcam.play(kView);
        await w2.run(2, () => {
            w2.rx.live(7);
            w2.webcam.play(kView);
        });
        const second = `${[...w2.webcam.recordBases.values()][0]!}.webm`;
        assert.notEqual(second, first);
        await w2.service.cancel("U1");
        assert.equal(w2.sheet.rows[0]![col("web カメラの録画")], `${first} / ${second}`);
    });

    it("bot を起動し直したら、受信用のページを開き直す", async () => {
        const w = makeWorld(webcamYaml);
        await untilAsked(w);
        const w2 = makeWorld(webcamYaml, baseYaml, w.store);
        w2.clock.t = w.clock.t;
        w2.rx.channels.get(7)!.status = "live";
        await w2.run(1, () => w2.rx.live(7));
        assert.deepEqual(w2.webcam.opened, [kView]);
    });
});
