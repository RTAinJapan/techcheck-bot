// web カメラの受信用のページを見る adapter (src/adapters/webcam.ts) を、実際のブラウザで確かめる。
// VDO.ninja の代わりに、同じページの中で WebRTC を繋いで <video> に映すページを使う。
// ブラウザが無ければ飛ばす (環境変数 TECHCHECK_TEST_BROWSER に、Chrome 系の実行ファイルの場所を書くと、それを使う)。

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { BrowserWebcam } from "../src/adapters/webcam.js";
import type { WebcamStatus } from "../src/ports.js";

const browserPath = [process.env.TECHCHECK_TEST_BROWSER, "/opt/pw-browsers/chromium", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(
    (p) => p && existsSync(p),
);

/** 動く絵を canvas で作り、WebRTC で自分に送って <video> に映す。?stop なら、何も映さない */
const kPage = `<!doctype html><video id="v" autoplay muted playsinline></video><canvas id="c" width="320" height="240"></canvas><script>
(async () => {
    if (location.search.includes("stop")) return;
    const ctx = document.getElementById("c").getContext("2d");
    let n = 0;
    setInterval(() => { ctx.fillStyle = "hsl(" + (n++ % 360) + ",80%,50%)"; ctx.fillRect(0, 0, 320, 240); }, 33);
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    b.ontrack = (e) => { document.getElementById("v").srcObject = e.streams[0]; };
    const stream = document.getElementById("c").captureStream(30);
    for (const t of stream.getTracks()) a.addTrack(t, stream);
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
})();
</script>`;

async function until(read: () => WebcamStatus | undefined, ok: (s: WebcamStatus) => boolean, ms = 30_000): Promise<WebcamStatus> {
    const end = Date.now() + ms;
    for (;;) {
        const s = read();
        if (s && ok(s)) return s;
        if (Date.now() > end) throw new Error(`時間切れ: ${JSON.stringify(s)}`);
        await new Promise((r) => setTimeout(r, 200));
    }
}

describe("web カメラの受信用のページ (ブラウザ)", { skip: browserPath ? false : "Chrome 系のブラウザが無い" }, () => {
    let server: Server;
    let url = "";
    const cam = new BrowserWebcam({ path: browserPath ?? "", channel: "chrome" });

    before(async () => {
        server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(kPage));
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    });
    after(async () => {
        await cam.stop();
        server.close();
    });

    it("WebRTC で届いた映像を見つけ、大きさ・受信の統計・静止画を取る", async () => {
        assert.equal(cam.status("a"), undefined);
        cam.open("a", url);
        assert.equal(cam.status("a")?.state, "opening");
        const s = await until(
            () => cam.status("a"),
            (x) => x.playing && (x.packetsReceived ?? 0) > 0,
        );
        assert.equal(s.state, "open");
        assert.equal(s.width, 320);
        assert.equal(s.height, 240);
        assert.equal(s.packetsLost, 0);
        assert.equal(s.freezes, 0);
        const jpeg = await cam.still("a");
        assert.ok(jpeg && jpeg.length > 500);
        assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8]);
        await cam.close("a");
        assert.equal(cam.status("a"), undefined);
    });

    it("映像が無いページは、開けても「届いていない」", async () => {
        cam.open("b", `${url}?stop`);
        const s = await until(
            () => cam.status("b"),
            (x) => x.state === "open",
        );
        await new Promise((r) => setTimeout(r, 1_500));
        assert.equal(cam.status("b")?.playing, false);
        assert.equal(s.width, undefined);
        assert.equal(await cam.still("b"), undefined);
        await cam.close("b");
    });

    it("ページを開けなければ、理由を返す", async () => {
        cam.open("c", "http://127.0.0.1:1/");
        const s = await until(
            () => cam.status("c"),
            (x) => x.state === "error",
        );
        assert.ok(s.error);
        assert.equal(s.playing, false);
        await cam.close("c");
    });
});
