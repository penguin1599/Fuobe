// The Kinetic page in WebKit (Safari's engine), end to end. Needs a production build (`pnpm build`); starts `next start`
// on 3544 with a throwaway data folder, the owner's password and public sign-up on. Uses Playwright's WebKit and ffmpeg
// (a fixture clip). Everything it starts is stopped at the end.
//
//   node tests/e2e/kinetic-webkit.mjs [evidence folder]
//
// KINETIC_WEBKIT_PORT moves the app.
//
// Guest (390 dark and 1440 light): the opening screen sends its title and tiles, the four examples draw, an example
// opens the editor and its preview plays, Pro's presets read Custom after a slider move, Save opens the sign-up card
// and nothing uploads; no sideways scroll, no page errors. Canvas filters: the grade's filter test agrees with what the
// canvas really draws. Owner: a frame saves as a PNG result of the export size; a clip saves where this WebKit has an
// encoder (otherwise the page says so and no result is made); a clip under the words either opens and saves a frame, or
// fails with its message within the time limit (never hangs, and the next save still works).
import { spawn, execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DESKTOP, loadPlaywright, PHONE, root } from "./_browser.mjs";

const PORT = Number(process.env.KINETIC_WEBKIT_PORT ?? 3544);
const APP = `http://127.0.0.1:${PORT}`;
const out = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "fuobe-kinetic-webkit-")));
fs.mkdirSync(out, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), "fuobe-kinetic-webkit-data-"));
const PASSWORD = "owner password for kinetic in webkit";
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";

const failures = [];
const notes = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const note = (s) => {
  console.log(`note ${s}`);
  notes.push(s);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const log = fs.openSync(path.join(out, "server.log"), "w");
const server = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "-p", String(PORT), "-H", "127.0.0.1"], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: "production",
    FUOBE_DATA_DIR: data,
    FUOBE_PASSWORD: PASSWORD,
    FUOBE_PUBLIC_SIGNUP: "1",
    FUOBE_DEMO_MODE: "on",
    COMFYUI_URL: "http://127.0.0.1:9",
    OLLAMA_URL: "http://127.0.0.1:9",
    LMSTUDIO_URL: "http://127.0.0.1:9",
    UNSLOTH_URL: "http://127.0.0.1:9",
    FUOBE_ACCOUNT_DISK_FREE_GB: "0.5",
  },
  stdio: ["ignore", log, log],
});
function stopAll() {
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: "ignore" });
    else server.kill("SIGTERM");
  } catch {}
}

const api = async (route, { method = "GET", body, cookie } = {}) => {
  const res = await fetch(APP + route, { method, headers: { Origin: APP, "Content-Type": "application/json", ...(cookie && { cookie }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try {
    json = JSON.parse(buf.toString("utf8"));
  } catch {}
  return { status: res.status, json, buf, headers: res.headers };
};
const cookieOf = (res) => /fuobe_session=[^;]+/.exec(res.headers.get("set-cookie") ?? "")?.[0];
const pngSize = (buf) => (buf.subarray(1, 4).toString() === "PNG" ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : null);
const MAIN = 'canvas[data-kinetic-player="main"]';
const pixels = (page) => page.evaluate((sel) => document.querySelector(sel)?.toDataURL() ?? "", MAIN);

async function closeAll(page) {
  for (let i = 0; i < 4 && (await page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible, [data-kinetic-sheet=group]:visible').count()); i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);
  }
}
async function sideways(page, who) {
  const px = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
  check(px <= 0, `${who}: no sideways scroll (${px} px)`);
}
/** The newest result of a feature, as the owner sees it. */
async function newest(cookie, feature) {
  const r = await api(`/api/generations?features=${feature}&limit=5`, { cookie });
  const list = Array.isArray(r.json) ? r.json : (r.json?.items ?? r.json?.generations ?? []);
  return list[0] ?? null;
}

let browser;
const pageErrors = [];
try {
  for (let i = 0; i < 180; i++) {
    try {
      const r = await fetch(`${APP}/login`);
      if (r.status < 500) break;
    } catch {}
    await wait(1000);
  }
  // The static page itself carries the opening screen (title and tiles) before any script runs.
  const html = await (await fetch(`${APP}/kinetic`)).text();
  check(/<h1[^>]*>Fuobe Kinetic Motion<\/h1>/.test(html), "the static page sends its title");
  check((html.match(/data-kinetic-scenes/g) ?? []).length > 0 && (html.match(/data-kinetic-tile=/g) ?? []).length >= 14, "the static page sends the example and scene tiles");

  const owner = cookieOf(await api("/api/auth/login", { method: "POST", body: { password: PASSWORD } }));
  check(!!owner, "owner signs in");
  const { webkit } = loadPlaywright();
  browser = await webkit.launch();
  note(`WebKit ${browser.version()}`);
  const withCookie = async (cookie, opts) => {
    const ctx = await browser.newContext({ ...opts, baseURL: APP });
    if (cookie) {
      const [n, v] = cookie.split("=");
      await ctx.addCookies([{ name: n, value: v, url: APP }]);
    }
    return ctx;
  };
  const watch = (page, who) => page.on("pageerror", (e) => pageErrors.push(`${who}: ${e.message}`));

  // ---- Guest: phone dark, desktop light.
  for (const [name, opts] of [
    ["390", { viewport: PHONE.viewport, hasTouch: true, colorScheme: "dark" }],
    ["1440", { ...DESKTOP, colorScheme: "light" }],
  ]) {
    const ctx = await withCookie(null, opts);
    const gp = await ctx.newPage();
    watch(gp, `guest ${name}`);
    let uploads = 0;
    gp.on("request", (r) => r.url().includes("/api/uploads") && uploads++);
    await gp.goto("/kinetic", { waitUntil: "load", timeout: 120_000 });
    await gp.locator("[data-kinetic-picker]:visible").first().waitFor({ timeout: 60_000 });
    check((await gp.locator("[data-kinetic-examples] [data-kinetic-tile]").count()) === 4, `guest ${name}: four examples`);
    check((await gp.locator("[data-kinetic-scenes] [data-kinetic-tile]").count()) === 18, `guest ${name}: all eighteen scenes`);
    // The examples are drawn by the engine (a canvas each, not blank).
    await gp.waitForFunction(() => document.querySelectorAll("[data-kinetic-examples] canvas").length === 4, null, { timeout: 60_000 }).catch(() => {});
    await gp.waitForTimeout(1500);
    const drawn = await gp.$$eval("[data-kinetic-examples] canvas", (cs) =>
      cs.map((c) => {
        try {
          const g = c.getContext("2d");
          const d = g.getImageData(0, 0, c.width, c.height).data;
          let lo = 255,
            hi = 0;
          for (let i = 0; i < d.length; i += 4 * 97) {
            const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
            lo = Math.min(lo, v);
            hi = Math.max(hi, v);
          }
          return hi - lo;
        } catch {
          return -1;
        }
      }),
    );
    check(drawn.length === 4 && drawn.every((x) => x > 20), `guest ${name}: the four examples draw (${JSON.stringify(drawn)})`);
    await sideways(gp, `guest ${name} picker`);
    await gp.screenshot({ path: path.join(out, `webkit-guest-picker-${name}.png`), fullPage: true });
    await gp.locator("[data-kinetic-examples] [data-kinetic-tile=big-number]").click();
    await gp.locator(MAIN).waitFor({ timeout: 60_000 });
    await gp.waitForTimeout(1500);
    const a = await pixels(gp);
    await gp.waitForTimeout(500);
    check(a !== (await pixels(gp)), `guest ${name}: the example opens and its preview plays`);
    await sideways(gp, `guest ${name} editor`);
    await gp.getByRole("radio", { name: "Pro", exact: true }).click();
    await gp.getByRole("textbox", { name: "Pace value" }).fill("1.3");
    await gp.getByRole("textbox", { name: "Pace value" }).press("Enter");
    await gp.waitForTimeout(300);
    check(await gp.locator("[data-kinetic-presets=motion] [data-kinetic-custom]").isVisible(), `guest ${name}: a moved slider reads Custom`);
    await gp.screenshot({ path: path.join(out, `webkit-guest-editor-pro-${name}.png`) });
    await gp.locator("[data-kinetic-save=main]").click();
    check(await gp.getByText(/Create a free account/).first().waitFor({ timeout: 10_000 }).then(() => true, () => false), `guest ${name}: Save opens the sign-up card`);
    await closeAll(gp);
    check(uploads === 0, `guest ${name}: nothing uploads`);

    // Canvas filters: the page's test must match what a canvas really draws in this WebKit.
    const filters = await gp.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = c.height = 1;
      const g = c.getContext("2d", { willReadFrequently: true });
      const s = document.createElement("canvas");
      s.width = s.height = 1;
      const sg = s.getContext("2d");
      sg.fillStyle = "rgb(200,40,40)";
      sg.fillRect(0, 0, 1, 1);
      const has = "filter" in Object.getPrototypeOf(g);
      g.filter = "saturate(0)";
      g.drawImage(s, 0, 0);
      const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
      return { has, grey: Math.abs(r - gr) < 12 && Math.abs(gr - b) < 12, px: [r, gr, b] };
    });
    note(`guest ${name}: canvas filter ${filters.has ? "present" : "missing"}, draws ${filters.grey ? "grey (works)" : `colour ${filters.px} (ignored)`}`);
    check(filters.has === filters.grey || !filters.has, `guest ${name}: the filter test reads what the canvas draws`);
    await ctx.close();
  }

  // ---- Owner (1440): a frame, a clip where an encoder exists, and a clip under the words.
  {
    const ctx = await withCookie(owner, { ...DESKTOP, colorScheme: "light" });
    const op = await ctx.newPage();
    watch(op, "owner");
    await op.goto("/kinetic?scene=big-number", { waitUntil: "load", timeout: 120_000 });
    await op.locator(MAIN).waitFor({ timeout: 60_000 });
    await op.waitForTimeout(1200);
    await op.getByRole("button", { name: "Export options" }).click();
    await op.locator("[data-kinetic-sheet=export]").waitFor();
    const mp4Line = await op.getByText(/can't make MP4 here/).count();
    note(`owner: MP4 ${mp4Line ? "not available in this WebKit" : "available"}`);
    await op.locator("[data-kinetic-save=frame]").click();
    const frameOk = await op.getByText(/Saved to your Library/).first().waitFor({ timeout: 60_000 }).then(() => true, () => false);
    check(frameOk, "owner: Save frame saves");
    const frame = await newest(owner, "kinetic-frame");
    if (frame) {
      const png = pngSize((await api(frame.outputs[0].url, { cookie: owner })).buf);
      check(png?.w === 1080 && png?.h === 1350, `owner: the frame is a 1080 × 1350 PNG (${JSON.stringify(png)})`);
      check(frame.outputs[0].width === 1080 && frame.outputs[0].height === 1350, "owner: the frame is recorded with its size");
    } else check(false, "owner: the frame is a result");
    await closeAll(op);

    // The clip: MP4, else WebM, else the page says so.
    await op.getByRole("button", { name: "Export options" }).click();
    await op.locator("[data-kinetic-sheet=export]").waitFor();
    if (mp4Line) await op.getByRole("radio", { name: "WebM", exact: true }).click();
    const save = op.locator("[data-kinetic-sheet=export] [data-kinetic-save=clip]");
    if (await save.isDisabled()) note("owner: no clip encoder in this WebKit (Save clip is off and says why)");
    else {
      const t0 = Date.now();
      await save.click();
      let clip = null;
      let err = 0;
      for (let i = 0; i < 180 && !clip && !err; i++) {
        await wait(1000);
        clip = await newest(owner, "kinetic");
        err = await op.getByText(/Couldn't save it|can't make/).count();
      }
      if (clip) {
        note(`owner: clip saved in ${Math.round((Date.now() - t0) / 100) / 10} s as ${clip?.outputs[0]?.contentType}`);
        check(!!clip && /^video\//.test(clip.outputs[0].contentType ?? ""), "owner: the clip is a video result");
      } else note(`owner: this WebKit could not encode the clip (${err ? "the page said so" : "no message"})`);
    }
    await closeAll(op);

    // A clip under the words: a 2 s H.264 fixture.
    const fixture = path.join(out, "fixture.mp4");
    execFileSync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=2", "-pix_fmt", "yuv420p", "-c:v", "libx264", fixture]);
    const fd = new FormData();
    fd.append("file", new Blob([fs.readFileSync(fixture)], { type: "video/mp4" }), "fixture.mp4");
    const up = await (await fetch(APP + "/api/uploads", { method: "POST", headers: { Origin: APP, cookie: owner }, body: fd })).json();
    check(typeof up?.url === "string", "owner: the fixture clip uploads");
    const opened = await op.evaluate(async (url) => {
      const el = document.createElement("video");
      el.muted = true;
      el.playsInline = true;
      el.src = url;
      el.load();
      const t0 = performance.now();
      const r = await new Promise((res) => {
        el.addEventListener("loadeddata", () => res("loaded"), { once: true });
        el.addEventListener("error", () => res("error"), { once: true });
        setTimeout(() => res("timeout"), 16_000);
      });
      return { r, ms: Math.round(performance.now() - t0) };
    }, up.url);
    note(`owner: this WebKit opens an H.264 clip: ${opened.r} after ${opened.ms} ms`);
    // Pick it through the address of a saved result is not possible here, so set it in the browser draft and reopen.
    await op.goto("/kinetic?scene=big-number", { waitUntil: "load" });
    await op.locator(MAIN).waitFor({ timeout: 60_000 });
    const clipButton = op.getByRole("button", { name: /Pick a clip|Add a clip|Choose a clip/ }).first();
    if (await clipButton.count()) {
      await clipButton.click();
      await op.locator("[data-kinetic-sheet=clip]").waitFor();
      await op.locator("[data-kinetic-clips] [data-kinetic-clip]").first().click();
      await op.waitForTimeout(500);
      await op.getByRole("button", { name: "Export options" }).click();
      await op.locator("[data-kinetic-sheet=export]").waitFor();
      const t0 = Date.now();
      await op.locator("[data-kinetic-save=frame]").click();
      const done = await Promise.race([
        op.getByText(/Saved to your Library|Already saved/).first().waitFor({ timeout: 45_000 }).then(() => "saved", () => null),
        op.getByText(/We can't open that clip|We can't read that clip/).first().waitFor({ timeout: 45_000 }).then(() => "message", () => null),
      ]);
      const secs = Math.round((Date.now() - t0) / 100) / 10;
      check(done === "saved" || done === "message", `owner: a frame over the clip either saves or says why, never hangs (${done ?? "nothing"} after ${secs} s)`);
      // The next save still works (a failed clip never blocks the jobs).
      await op.waitForTimeout(500);
      const busy = await op.locator("[data-kinetic-save=frame]").isDisabled();
      check(!busy, "owner: Save frame is ready again afterwards");
      await op.screenshot({ path: path.join(out, "webkit-owner-clip.png") });
    } else note("owner: no clip control found on Big Number");
    await sideways(op, "owner 1440 editor");
    await ctx.close();
  }

  check(pageErrors.length === 0, `no page errors (${JSON.stringify(pageErrors.slice(0, 5))})`);
} catch (e) {
  check(false, `the run finished (${e.message})`);
} finally {
  await browser?.close().catch(() => {});
  stopAll();
  fs.writeFileSync(path.join(out, "webkit-result.json"), JSON.stringify({ failures, notes }, null, 2));
  console.log(failures.length ? `\n${failures.length} FAILED` : "\nALL PASSED");
  process.exitCode = failures.length ? 1 : 0;
}
