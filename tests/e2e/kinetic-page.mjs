// The Kinetic page (/kinetic), end to end. Starts `next dev` on 3540 with a throwaway data folder, the owner's password,
// public sign-up on, Demo mode on and a stand-in fal.ai on 3541 for an account's own key. Uses the system Chrome
// (WebCodecs H.264) and ffmpeg (a fixture clip, and reading frames back). Everything it starts is stopped at the end.
//
//   node tests/e2e/kinetic-page.mjs [evidence folder]
//
// KINETIC_PORT moves the app (and the stand-in to the next port).
//
// Guest (390 and 1440, light and dark): the opening screen shows the four examples and every scene; an example opens
// the editor and its preview plays; Easy and Pro work; a Motion preset reads "Custom" after a slider move, and Undo and
// Redo bring it back and forth; Save, Save frame and Save version each open the sign-up card before any upload.
// Owner: Big Number with the Film look, a Slow push and a retimed group, saved at 60 fps (its MP4 has duration × 60
// frames, its recipe in params.extra.motion), a frame and a contact sheet as PNG results of the export size, a version
// restored after a change (it asks first, and Undo brings the change back), and Remix in Kinetic opening the same recipe.
// Account with a stand-in key: saves to its own runs (never the owner's Library), uploads its own clip and saves Kinetic
// Headline over it. Account with neither: saves a clip, a frame and a version with the Kinetic header; "Upload a clip"
// opens the Connect card; it picks its earlier Kinetic clip as the clip layer and saves. Frame-exact clip: a 2 s, 30 fps
// fixture whose frame i is a flat grey that encodes i, saved under Big Number at 30 fps, and at 24 fps from 0.5 s; each
// output frame i shows source frame floor((from + i / fps) × 30). Reduced motion: no autoplay. Layout: no sideways scroll
// (picker, editor, each sheet open), controls at least 44 px, no page errors.
import { spawn, execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DESKTOP, launch, PHONE, root } from "./_browser.mjs";
import { startFakeFal } from "../helpers/fake-cloud.ts";

const PORT = Number(process.env.KINETIC_PORT ?? 3540);
const APP = `http://127.0.0.1:${PORT}`;
const out = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "fuobe-kinetic-page-")));
fs.mkdirSync(out, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), "fuobe-kinetic-page-data-"));
const PASSWORD = "owner password for the kinetic page";
const ACCT_FAL = "acct-kinetic-key:acct-kinetic-secret";
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

const fal = await startFakeFal(PORT + 1);
fal.keys[ACCT_FAL] = "good";
const log = fs.openSync(path.join(out, "server.log"), "w");
const server = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "dev", "-p", String(PORT), "-H", "127.0.0.1"], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: "development",
    FUOBE_DATA_DIR: data,
    FUOBE_PASSWORD: PASSWORD,
    FUOBE_PUBLIC_SIGNUP: "1",
    FUOBE_DEMO_MODE: "on",
    FUOBE_DEV_FAL_URL: fal.url,
    COMFYUI_URL: "http://127.0.0.1:9",
    OLLAMA_URL: "http://127.0.0.1:9",
    LMSTUDIO_URL: "http://127.0.0.1:9",
    UNSLOTH_URL: "http://127.0.0.1:9",
    FUOBE_ACCOUNT_DISK_FREE_GB: "0.5",
  },
  stdio: ["ignore", log, log],
});
async function stopAll() {
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: "ignore" });
    else server.kill("SIGTERM");
  } catch {}
  await fal.close();
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
/** Uploads a file as the owner (the normal upload). */
async function upload(file, type, cookie) {
  const fd = new FormData();
  fd.append("file", new Blob([fs.readFileSync(file)], { type }), path.basename(file));
  const res = await fetch(APP + "/api/uploads", { method: "POST", headers: { Origin: APP, cookie }, body: fd });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const cookieOf = (res) => /fuobe_session=[^;]+/.exec(res.headers.get("set-cookie") ?? "")?.[0];
const mp4Frames = (buf) => {
  const i = buf.indexOf(Buffer.from("stsz"));
  return i < 0 ? -1 : buf.readUInt32BE(i + 12);
};
const pngSize = (buf) => (buf.subarray(1, 4).toString() === "PNG" ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : null);
const MAIN = 'canvas[data-kinetic-player="main"]';
const pixels = (page) => page.evaluate((sel) => document.querySelector(sel)?.toDataURL() ?? "", MAIN);
const recipeKeyOf = (page) => page.locator("[data-recipe-key]").first().getAttribute("data-recipe-key");

/** Closes every open dialog, sheet and card. */
async function closeAll(page) {
  for (let i = 0; i < 4 && (await page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible, [data-kinetic-sheet=group]:visible').count()); i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);
  }
}

async function openEditor(page, href) {
  await page.goto(href, { waitUntil: "load", timeout: 240_000 });
  await page.locator(MAIN).waitFor({ timeout: 120_000 });
  await page.waitForTimeout(1500);
}

/** No sideways scroll, and (in the editor) every visible control at least 44 px. */
async function layout(page, who, what, controls = true) {
  const sideways = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
  check(sideways <= 0, `${who} ${what}: no sideways scroll (${sideways} px)`);
  if (!controls) return;
  const small = await page.$$eval("[data-kinetic-editor] button, [data-kinetic-editor] input:not([type=color]):not([type=file]):not(.sr-only), [data-kinetic-editor] select, [data-kinetic-editor] textarea, [data-kinetic-sheet] button, [data-kinetic-sheet] input:not(.sr-only)", (els) =>
    els
      .filter((e) => e.getClientRects().length && !e.closest(".group\\/slot") && !e.closest("[data-kinetic-made]"))
      .map((e) => {
        const r = e.getBoundingClientRect();
        return [e.getAttribute("aria-label") || e.textContent?.trim().slice(0, 24) || e.tagName, Math.round(Math.min(r.height, r.width < 44 && e.tagName === "BUTTON" ? r.width : r.height))];
      })
      .filter(([, h]) => h < 44),
  );
  check(small.length === 0, `${who} ${what}: every control at least 44 px (${JSON.stringify(small.slice(0, 8))})`);
}

/** The grey a fixture frame shows, read from an output MP4 at frame i (ffmpeg, the top-left 8 × 8 block). */
function greyAt(file, i) {
  const raw = execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `select=eq(n\\,${i}),crop=8:8:2:2,scale=1:1`, "-vsync", "0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
  return raw[0];
}

const timings = {};
let browser;
const pageErrors = [];
try {
  for (let i = 0; i < 300; i++) {
    try {
      const r = await fetch(`${APP}/login`);
      if (r.status < 500) break;
    } catch {}
    await wait(1000);
  }
  const owner = cookieOf(await api("/api/auth/login", { method: "POST", body: { password: PASSWORD } }));
  check(!!owner, "owner signs in");
  browser = await launch({ channel: "chrome" });
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
    ["390", { ...PHONE, colorScheme: "dark" }],
    ["1440", { ...DESKTOP, colorScheme: "light" }],
  ]) {
    const ctx = await withCookie(null, opts);
    const gp = await ctx.newPage();
    watch(gp, `guest ${name}`);
    let uploads = 0;
    gp.on("request", (r) => r.url().includes("/api/uploads") && uploads++);
    await gp.goto("/kinetic", { waitUntil: "load", timeout: 240_000 });
    await gp.locator("[data-kinetic-picker]:visible").first().waitFor({ timeout: 120_000 });
    check((await gp.locator("[data-kinetic-examples] [data-kinetic-tile]").count()) === 4, `guest ${name}: four examples`);
    check((await gp.locator("[data-kinetic-scenes] [data-kinetic-tile]").count()) === 18, `guest ${name}: all eighteen scenes`);
    check((await gp.locator("[data-kinetic-made-strip]").count()) === 0, `guest ${name}: no Made in Kinetic strip`);
    await layout(gp, `guest ${name}`, "picker", false);
    await gp.screenshot({ path: path.join(out, `guest-picker-${name}.png`), fullPage: true });
    await gp.locator("[data-kinetic-examples] [data-kinetic-tile=big-number]").click();
    await gp.locator(MAIN).waitFor({ timeout: 120_000 });
    await gp.waitForTimeout(1200);
    const a = await pixels(gp);
    await gp.waitForTimeout(450);
    check(a !== (await pixels(gp)), `guest ${name}: the example opens and its preview plays`);
    check(/scene=big-number/.test(gp.url()), `guest ${name}: the address names the scene`);
    await layout(gp, `guest ${name}`, "editor (Easy)");
    await gp.getByRole("radio", { name: "Pro", exact: true }).click();
    await gp.getByRole("radio", { name: /^Snappy Quick/ }).click();
    const snappy = await recipeKeyOf(gp);
    check(await gp.locator('[data-kinetic-presets=motion] [role=radio][aria-checked=true]').filter({ hasText: "Snappy" }).count() === 1, `guest ${name}: the Snappy preset is picked`);
    await gp.getByRole("textbox", { name: "Pace value" }).fill("1.3");
    await gp.getByRole("textbox", { name: "Pace value" }).press("Enter");
    await gp.waitForTimeout(300);
    check(await gp.locator("[data-kinetic-presets=motion] [data-kinetic-custom]").isVisible(), `guest ${name}: a moved slider reads Custom`);
    await gp.getByRole("button", { name: "Undo" }).click();
    check((await recipeKeyOf(gp)) === snappy && !(await gp.locator("[data-kinetic-presets=motion] [data-kinetic-custom]").isVisible()), `guest ${name}: Undo brings the preset back`);
    await gp.getByRole("button", { name: "Redo" }).click();
    check(await gp.locator("[data-kinetic-presets=motion] [data-kinetic-custom]").isVisible(), `guest ${name}: Redo makes it Custom again`);
    await layout(gp, `guest ${name}`, "editor (Pro)");
    await gp.screenshot({ path: path.join(out, `guest-editor-pro-${name}.png`) });
    // The three saves each ask first.
    await gp.locator("[data-kinetic-save=main]").click();
    check(await gp.getByText(/Create a free account/).first().waitFor({ timeout: 10_000 }).then(() => true, () => false), `guest ${name}: Save opens the sign-up card`);
    await closeAll(gp);
    await gp.getByRole("button", { name: "Export options" }).click();
    await gp.locator("[data-kinetic-sheet=export]").waitFor();
    await layout(gp, `guest ${name}`, "export sheet");
    await gp.screenshot({ path: path.join(out, `guest-export-${name}.png`) });
    await gp.locator("[data-kinetic-save=frame]").click();
    check(await gp.getByText(/Create a free account/).first().waitFor({ timeout: 10_000 }).then(() => true, () => false), `guest ${name}: Save frame opens the sign-up card`);
    await closeAll(gp);
    await gp.getByRole("button", { name: "More" }).click();
    await gp.getByRole("menuitem", { name: "Versions" }).click();
    await gp.locator("[data-kinetic-sheet=versions]").waitFor();
    await layout(gp, `guest ${name}`, "versions sheet");
    check((await gp.locator("[data-kinetic-versions]").count()) === 0, `guest ${name}: no versions list`);
    await gp.locator("[data-kinetic-save=version]").click();
    check(await gp.getByText(/Create a free account/).first().waitFor({ timeout: 10_000 }).then(() => true, () => false), `guest ${name}: Save version opens the sign-up card`);
    check(uploads === 0, `guest ${name}: nothing uploads`);
    await ctx.close();
  }

  // ---- Reduced motion: nothing autoplays.
  {
    const ctx = await withCookie(null, { ...DESKTOP, reducedMotion: "reduce" });
    const cp = await ctx.newPage();
    watch(cp, "reduced motion");
    await openEditor(cp, "/kinetic?scene=quote");
    const r1 = await pixels(cp);
    await cp.waitForTimeout(800);
    check(r1 === (await pixels(cp)), "reduced motion: the preview holds its rest frame");
    await cp.goto("/kinetic", { waitUntil: "load" });
    await cp.locator("[data-kinetic-picker]:visible").first().waitFor();
    await cp.waitForTimeout(1500);
    const playing = await cp.$$eval("[data-kinetic-picker] video", (vs) => vs.filter((v) => !v.paused).length);
    check(playing === 0, `reduced motion: no tile plays (${playing})`);
    await ctx.close();
  }

  // ---- Owner, desktop: Big Number with the Film look, a Slow push, a retimed group, 60 fps.
  const desk = await withCookie(owner, DESKTOP);
  const op = await desk.newPage();
  watch(op, "owner");
  await openEditor(op, "/kinetic?scene=big-number");
  await op.getByRole("radio", { name: "Pro", exact: true }).click();
  await op.locator("[aria-controls=kinetic-panel-appearance]").click();
  await op.getByRole("radio", { name: /^Film/ }).click();
  await op.locator("[aria-controls=kinetic-panel-camera]").click();
  await op.getByRole("radio", { name: "Push", exact: true }).click();
  await op.locator("[data-kinetic-group=number]").click();
  await op.locator("[data-kinetic-sheet=group]").waitFor();
  await op.getByRole("button", { name: "Ease in", exact: true }).click();
  await op.getByRole("textbox", { name: "Speed value" }).fill("1.5");
  await op.getByRole("textbox", { name: "Speed value" }).press("Enter");
  await layout(op, "owner 1440", "group sheet");
  await op.screenshot({ path: path.join(out, "owner-group-1440.png") });
  await closeAll(op);
  await op.getByRole("button", { name: "Export options" }).click();
  await op.getByRole("radio", { name: "60 fps" }).click();
  const clipKey = await recipeKeyOf(op);
  const t0 = Date.now();
  let rec = op.waitForResponse((r) => r.url().endsWith("/api/generations/local") && r.request().method() === "POST", { timeout: 240_000 });
  await op.locator("[data-kinetic-save=clip]").click();
  let res = await rec;
  check(res.status() === 201, "owner: the 60 fps clip is recorded");
  timings.owner60fpsMs = Date.now() - t0;
  const clip = await res.json();
  const motion = clip.request?.params?.extra?.motion;
  check(motion?.fps === 60 && motion?.finish?.grain > 0 && motion?.camera?.move === "push" && motion?.groups?.number?.rate === 1.5, `owner: its recipe has the Film look, the push and the retimed group (${JSON.stringify({ fps: motion?.fps, finish: motion?.finish, camera: motion?.camera, groups: motion?.groups })})`);
  const lib = await api(`/api/generations?features=kinetic&limit=5`, { cookie: owner });
  check((lib.json?.items ?? []).some((g) => g.id === clip.id), "owner: the Library lists it");
  const file = await api(clip.outputs[0].url, { cookie: owner });
  check(mp4Frames(file.buf) === Math.round(motion.duration * 60), `owner: ${Math.round(motion.duration * 60)} frames at 60 fps (${mp4Frames(file.buf)})`);
  fs.writeFileSync(path.join(out, "owner-big-number-60fps.mp4"), file.buf);
  note(`Big Number ${motion.duration} s at 1080 × 1350, 60 fps, Film: rendered and saved in ${timings.owner60fpsMs} ms`);
  // A frame and a contact sheet.
  for (const kind of ["frame", "sheet"]) {
    rec = op.waitForResponse((r) => r.url().endsWith("/api/generations/local") && r.request().method() === "POST", { timeout: 240_000 });
    await op.locator(`[data-kinetic-save=${kind}]`).click();
    res = await rec;
    const g = await res.json();
    const png = await api(g.outputs?.[0]?.url ?? "/x", { cookie: owner });
    const size = pngSize(png.buf);
    check(res.status() === 201 && g.feature === `kinetic-${kind}` && g.outputs[0].kind === "image" && size?.w === 1080 && size?.h === 1350, `owner: the ${kind} is a 1080 × 1350 PNG result (${JSON.stringify(size)})`);
    fs.writeFileSync(path.join(out, `owner-${kind}.png`), png.buf);
  }
  check(await op.locator("[data-kinetic-saved] li").count() >= 3, "owner: Saved this visit lists them");
  await layout(op, "owner 1440", "export sheet");
  await closeAll(op);
  // A version, a change, and Restore asks first; Undo brings the change back.
  await op.getByRole("button", { name: "More" }).click();
  await op.getByRole("menuitem", { name: "Versions" }).click();
  rec = op.waitForResponse((r) => r.url().endsWith("/api/generations/local") && r.request().method() === "POST", { timeout: 120_000 });
  await op.locator("[data-kinetic-save=version]").click();
  res = await rec;
  check(res.status() === 201 && (await res.json()).feature === "kinetic-version", "owner: the version is saved");
  const versionKey = await recipeKeyOf(op);
  await op.locator("[data-kinetic-restore]").first().waitFor({ timeout: 30_000 });
  await closeAll(op);
  await op.getByRole("radio", { name: "Springy", exact: true }).click();
  const changed = await recipeKeyOf(op);
  check(changed !== versionKey, "owner: a change after the version");
  await op.getByRole("button", { name: "More" }).click();
  await op.getByRole("menuitem", { name: "Versions" }).click();
  await op.locator("[data-kinetic-restore]").first().click();
  check(await op.getByText("Keep what you have?").waitFor({ timeout: 5000 }).then(() => true, () => false), "owner: Restore asks first");
  await op.getByRole("button", { name: "Don't save" }).click();
  await op.waitForTimeout(400);
  check((await recipeKeyOf(op)) === versionKey, "owner: the version is restored");
  await op.getByRole("button", { name: "Undo" }).click();
  check((await recipeKeyOf(op)) === changed, "owner: Undo brings the change back");
  // Remix in Kinetic from the saved clip opens the same recipe.
  await openEditor(op, `/kinetic?from=${clip.id}`);
  check((await recipeKeyOf(op)) === clipKey, "owner: Remix in Kinetic opens the clip's recipe");
  await op.goto("/kinetic", { waitUntil: "load" });
  check(await op.locator("[data-kinetic-made-strip] [data-kinetic-made]").first().waitFor({ timeout: 30_000 }).then(() => true, () => false), "owner: Made in Kinetic lists what it saved");
  await op.screenshot({ path: path.join(out, "owner-picker-1440.png"), fullPage: true });

  // ---- Frame-exact clip under the words: a fixture whose frame i is a flat grey that encodes i.
  const fixture = path.join(out, "fixture-2s-30fps.mp4");
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "nullsrc=s=320x240:r=30:d=2", "-vf", "geq=lum='16+4*N':cb=128:cr=128,format=yuv420p", "-c:v", "libx264", "-qp", "0", "-g", "1", fixture]);
  const up = await upload(fixture, "video/mp4", owner);
  const fixtureUrl = up.json?.url;
  check(!!fixtureUrl, `owner: the fixture clip uploads (${up.status})`);
  // A picture to record the fixture's recipes with as versions (opened through Remix in Kinetic): a version is the rest
  // frame with 540 px on its long side, and the server takes only that size.
  const still = path.join(out, "fixture-still.png");
  const VERSION_SIZE = { "9:16": "304x540", "4:5": "432x540", "1:1": "540x540", "16:9": "540x304" };
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=${VERSION_SIZE[motion.size] ?? "432x540"}`, "-frames:v", "1", still]);
  const stillUrl = (await upload(still, "image/png", owner)).json?.url;
  for (const [fps, from] of [
    [30, 0],
    [24, 0.5],
    [60, 0],
  ]) {
    const base = { ...motion, fps, duration: 5, finish: undefined, camera: undefined, groups: undefined, layers: { video: { src: fixtureUrl, from, fit: "cover", dim: 0, scrim: "none" } }, export: { format: "mp4", blurSamples: 1, shutter: 0 } };
    const g = await api("/api/generations/local", { method: "POST", cookie: owner, body: { feature: "kinetic-version", modelId: "local-motion", op: "motion", prompt: "fixture", title: `Fixture ${fps}`, inputs: {}, params: { extra: { motion: base } }, output: { url: stillUrl, kind: "image", contentType: "image/png" } } });
    check(g.status === 201, `fixture recipe at ${fps} fps recorded (${g.status} ${JSON.stringify(g.json?.error ?? "")})`);
    await openEditor(op, `/kinetic?from=${g.json?.id}`);
    rec = op.waitForResponse((r) => r.url().endsWith("/api/generations/local") && r.request().method() === "POST", { timeout: 240_000 });
    const t0 = Date.now();
    await op.locator("[data-kinetic-save=main]").click();
    res = await rec;
    note(`Big Number 5 s over a clip at ${fps} fps: rendered and saved in ${Date.now() - t0} ms`);
    const made = await res.json();
    const mp4 = path.join(out, `clip-over-fixture-${fps}fps.mp4`);
    fs.writeFileSync(mp4, (await api(made.outputs[0].url, { cookie: owner })).buf);
    const bad = [];
    for (const i of [0, 1, 2, 5, 9, 14, 20, 29, 40]) {
      // Source frame n is luma 16 + 4n in video range, which reads back as full-range grey 4n × 255 / 219.
      const n = Math.min(59, Math.floor((from + i / fps) * 30 + 1e-6));
      const want = Math.round(Math.min(255, (4 * n * 255) / 219));
      const got = greyAt(mp4, i);
      if (Math.abs(got - want) > 3) bad.push({ i, n, want, got });
    }
    check(bad.length === 0, `frame-exact at ${fps} fps from ${from} s: every checked frame shows its source frame (${JSON.stringify(bad)})`);
  }
  await desk.close();

  // ---- Account with a stand-in key: its own runs, its own clip under Kinetic Headline.
  const acct = cookieOf(await api("/api/auth/signup", { method: "POST", body: { email: "kinetic-page@example.com", password: "account password" } }));
  check((await api("/api/account/keys/fal", { method: "PUT", cookie: acct, body: { key: ACCT_FAL } })).status === 200, "the account adds its own key");
  {
    const ctx = await withCookie(acct, { ...PHONE, colorScheme: "light" });
    const ap = await ctx.newPage();
    watch(ap, "account");
    await openEditor(ap, "/kinetic?scene=kinetic-headline");
    await ap.getByRole("button", { name: "Pick a clip" }).click();
    await ap.locator("[data-kinetic-sheet=clip]").waitFor();
    const chooser = ap.waitForEvent("filechooser");
    await ap.locator("[data-kinetic-upload-clip]").click();
    await (await chooser).setFiles(fixture);
    await ap.locator("[data-kinetic-clip-control] video").first().waitFor({ timeout: 60_000 });
    await ap.waitForTimeout(1500);
    await layout(ap, "account 390", "editor with a clip");
    await ap.screenshot({ path: path.join(out, "account-headline-over-clip-390.png"), fullPage: true });
    rec = ap.waitForResponse((r) => r.url().endsWith("/api/generations/local") && r.request().method() === "POST", { timeout: 240_000 });
    await ap.locator("[data-kinetic-save=main]").click();
    res = await rec;
    const g = await res.json();
    check(res.status() === 201 && g.request?.params?.extra?.motion?.layers?.video?.src?.startsWith("/api/files/") && g.request?.inputs?.video === g.request.params.extra.motion.layers.video.src, "account with a key: Kinetic Headline over its own clip is saved");
    const mine = await api("/api/generations?features=kinetic&limit=10", { cookie: acct });
    const owners = await api("/api/generations?features=kinetic&limit=50", { cookie: owner });
    check((mine.json?.items ?? []).some((x) => x.id === g.id) && !(owners.json?.items ?? []).some((x) => x.id === g.id), "account with a key: in its own runs, never the owner's Library");
    await ctx.close();
  }

  // ---- Account with neither a GPU nor a key.
  const bare = cookieOf(await api("/api/auth/signup", { method: "POST", body: { email: "bare-kinetic-page@example.com", password: "account password" } }));
  {
    const ctx = await withCookie(bare, DESKTOP);
    const bp = await ctx.newPage();
    watch(bp, "bare account");
    const marks = [];
    bp.on("request", (r) => r.url().endsWith("/api/uploads") && r.method() === "POST" && marks.push(r.headers()["x-fuobe-kinetic"] ?? ""));
    await openEditor(bp, "/kinetic?scene=big-number");
    for (const kind of ["main", "frame", "version"]) {
      if (kind === "frame") {
        await bp.getByRole("button", { name: "Export options" }).click();
      }
      if (kind === "version") {
        await closeAll(bp);
        await bp.getByRole("button", { name: "More" }).click();
        await bp.getByRole("menuitem", { name: "Versions" }).click();
      }
      rec = bp.waitForResponse((r) => r.url().endsWith("/api/generations/local") && r.request().method() === "POST", { timeout: 240_000 });
      await bp.locator(`[data-kinetic-save=${kind}]`).click();
      res = await rec;
      check(res.status() === 201, `account without a GPU or key: saves its ${kind === "main" ? "clip" : kind}`);
    }
    check(marks.length >= 3 && marks.every((m) => m === "1"), `account without a GPU or key: every upload carries the Kinetic mark (${JSON.stringify(marks)})`);
    check(!(await bp.getByText(/Connect your GPU/).first().isVisible().catch(() => false)), "account without a GPU or key: no Connect card on save");
    await closeAll(bp);
    await bp.getByRole("button", { name: "Pick a clip" }).click();
    await bp.locator("[data-kinetic-sheet=clip]").waitFor();
    await bp.locator("[data-kinetic-upload-clip]").click();
    check(await bp.getByText(/Connect your GPU/).first().waitFor({ timeout: 10_000 }).then(() => true, () => false), "account without a GPU or key: Upload a clip opens the Connect card");
    await closeAll(bp);
    await bp.getByRole("button", { name: "Pick a clip" }).click();
    await bp.locator("[data-kinetic-clips] [data-kinetic-clip]").first().click();
    await bp.locator("[data-kinetic-clip-control] video").first().waitFor({ timeout: 60_000 });
    await bp.waitForTimeout(1200);
    rec = bp.waitForResponse((r) => r.url().endsWith("/api/generations/local") && r.request().method() === "POST", { timeout: 240_000 });
    await bp.locator("[data-kinetic-save=main]").click();
    res = await rec;
    const g = await res.json();
    check(res.status() === 201 && !!g.request?.params?.extra?.motion?.layers?.video, "account without a GPU or key: saves Big Number over its earlier Kinetic clip");
    await layout(bp, "account 1440", "editor with a clip");
    await bp.screenshot({ path: path.join(out, "bare-big-number-over-clip-1440.png") });
    await ctx.close();
  }
  check(pageErrors.length === 0, `no page errors (${JSON.stringify(pageErrors.slice(0, 5))})`);
} catch (e) {
  failures.push(`crashed: ${e?.stack ?? e}`);
  console.error(e);
} finally {
  await browser?.close().catch(() => {});
  await stopAll();
}

fs.writeFileSync(path.join(out, "e2e-result.json"), JSON.stringify({ failures, notes, timings }, null, 2));
console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
