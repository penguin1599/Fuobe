// Tab switches never blank the page (the app must be running, a production build: `pnpm build && pnpm start`).
// Usage: node tests/e2e/instant-tabs.mjs [appUrl]   (pnpm test:e2e:tabs). Exits 1 on the first failure.
//
// Every frame from the tap until the new tab's page has drawn is sampled (requestAnimationFrame), on a phone and a
// desktop, over Chrome's "Fast 4G" preset, so a switch that waits for the server shows up as frames:
// 1. Hub tabs (Audio, Video tools, Upscale): the title and the tab row are on screen in every frame, the tapped tab is the
//    current one within two frames, and the area under the tabs always shows a page or its skeleton, never nothing.
//    Both after the page has settled (every mode prefetched: no request on the tap, no skeleton) and straight after load
//    (nothing prefetched yet: the skeleton under the tabs may show). Within 100 ms of the tap the new page or its skeleton
//    is there, never the old page.
// 1b. A fresh load of a mode (phone CPU 4× slower): once drawn, the page never goes blank or back to its skeleton, and a
//    tab row swiped before the page is interactive stays where it was put.
// 2. Going back to a mode shows that mode's header controls once (the hidden pages kept for Back add none), and Back marks
//    the tab of the page it returns to (Audio, the Marketing suite).
// 2b. Marketing suite tabs: the tapped tab is current within two frames and the tab row never leaves.
// 3. Library sections: the tapped section is selected within two frames, with no request to the server.
// 4. Sidebar (desktop): Image → Audio never blanks the content area, the clicked row is marked within two frames, and the
//    hub's tabs are there when it lands.
import assert from "node:assert/strict";
import { DESKTOP, launch, openRoute, PHONE } from "./_browser.mjs";

const app = (process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "http://localhost:3000").replace(/\/$/, "");
const browser = await launch();
// --only=<text>: run the steps whose name has that text.
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const step = (name) => {
  if (only && !name.includes(only)) return false;
  console.log(`- ${name}`);
  return true;
};
// Chrome DevTools "Fast 4G": 9 Mbps down, 1.5 Mbps up, 165 ms latency.
const FAST4G = { offline: false, downloadThroughput: (9e6 / 8) * 0.9, uploadThroughput: (1.5e6 / 8) * 0.9, latency: 165 };

/** Injected before the page's scripts: `__frames.start(cfg)` samples every frame until `__frames.stop()`. */
const SAMPLER = () => {
  const w = window;
  const vis = (el) => !!el && el.checkVisibility();
  // innerText leaves out display:none subtrees (the previous page that React keeps hidden for Back).
  const text = (el) => (el ? (el.innerText || "").replace(/\s+/g, "").length : 0);
  w.__frames = {
    list: [],
    t0: 0,
    on: false,
    start(cfg) {
      this.list = [];
      this.on = true;
      this.t0 = 0;
      const tick = () => {
        if (!this.on) return;
        const content = document.getElementById("content");
        // The area under the hub's bar; the whole content area where there is none (another page, or a build without it).
        const body = (cfg.body && [...document.querySelectorAll(cfg.body)].find(vis)) || content;
        const bar = cfg.bar ? [...document.querySelectorAll(cfg.bar)].find(vis) : null;
        const current = cfg.current ? [...document.querySelectorAll(cfg.current)].find(vis) : null;
        this.list.push({
          t: performance.now(),
          path: location.pathname + location.search,
          content: text(content),
          body: text(body),
          skeleton: body ? [...body.querySelectorAll('[aria-busy="true"]')].some(vis) : false,
          bar: !!bar,
          title: cfg.title ? ([...document.querySelectorAll(cfg.title)].find(vis)?.textContent?.trim() ?? null) : null,
          current: current ? (current.textContent || "").trim() : null,
        });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    stop() {
      this.on = false;
      return { t0: this.t0, list: this.list };
    },
  };
  document.addEventListener("pointerdown", () => (w.__frames.t0 ||= performance.now()), true);
  document.addEventListener("click", () => (w.__frames.t0 ||= performance.now()), true);
};

async function context(device) {
  const ctx = await browser.newContext({ ...(device === "phone" ? PHONE : DESKTOP), colorScheme: "dark" });
  await ctx.addInitScript(SAMPLER);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", FAST4G);
  const rsc = [];
  page.on("request", (r) => {
    const h = r.headers();
    if (h.rsc || /[?&]_rsc=/.test(r.url())) rsc.push({ url: r.url(), prefetch: !!h["next-router-prefetch"] });
  });
  return { ctx, page, rsc };
}

/** Taps `target`, samples frames until `done(frame)` holds (or 15 s), and returns the frames from the tap on. */
async function sampleSwitch(page, target, device, cfg, done) {
  await page.evaluate((c) => window.__frames.start(c), cfg);
  if (device === "phone") await target.tap();
  else await target.click();
  const deadline = Date.now() + 15_000;
  let frames = [];
  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    const { list } = await page.evaluate(() => ({ list: window.__frames.list }));
    if (list.length && done(list[list.length - 1])) break;
  }
  await page.waitForTimeout(300);
  const { t0, list } = await page.evaluate(() => window.__frames.stop());
  frames = list.filter((f) => f.t >= t0).map((f) => ({ ...f, ms: Math.round(f.t - t0) }));
  assert.ok(frames.length > 0, "no frames sampled after the tap");
  return frames;
}

const HUB = {
  bar: 'nav[aria-label="Modes"]',
  body: "[data-hub-body]",
  title: "#content header h1",
  current: 'nav[aria-label="Modes"] [aria-current="page"]',
};

const SWITCHES = [
  { hub: "Audio", from: "/audio", tab: "Music", to: "/audio/music" },
  { hub: "Audio", from: "/audio/music", tab: "Translate", to: "/audio/translate" },
  { hub: "Audio", from: "/audio/translate", tab: "Dialogue", to: "/audio/dialogue" },
  { hub: "Audio", from: "/audio/split", tab: "Speech", to: "/audio/speech" },
  { hub: "Audio", from: "/audio/music", tab: "Clean up voice", to: "/audio" },
  { hub: "Video tools", from: "/video-tools", tab: "Trim", to: "/video-tools/trim" },
  { hub: "Upscale", from: "/upscale/fps", tab: "Export", to: "/upscale/export" },
  { hub: "Upscale", from: "/upscale/export", tab: "SDR to HDR", to: "/upscale/hdr" },
];

let failures = 0;
const check = (cond, msg) => {
  if (!cond) {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

try {
  for (const device of ["phone", "desktop"]) {
    for (const settled of [true, false]) {
      for (const sw of SWITCHES) {
        if (!step(`${device}${settled ? "" : ", straight after load"}: ${sw.from} → ${sw.tab}`)) continue;
        const { ctx, page, rsc } = await context(device);
        if (settled) await openRoute(page, app + sw.from, { settleMs: 4000 });
        // Straight after load: the page has hydrated (a tap before that is a full page load) and the tabs' prefetches are
        // still on their way over the throttled network.
        else await page.goto(app + sw.from, { waitUntil: "load" }).then(() => page.waitForTimeout(150));
        const tab = page.locator(HUB.bar).getByRole("link", { name: sw.tab, exact: true });
        await tab.waitFor({ timeout: 30_000 });
        await tab.scrollIntoViewIfNeeded();
        const before = rsc.length;
        const frames = await sampleSwitch(page, tab, device, HUB, (f) => f.path === sw.to && f.body > 0 && !f.skeleton);
        const last = frames[frames.length - 1];
        check(last.path === sw.to && last.body > 0 && !last.skeleton, `never reached ${sw.to} with its page drawn (last frame ${JSON.stringify(last)})`);
        const noBar = frames.filter((f) => !f.bar);
        check(!noBar.length, `the tab row was missing in ${noBar.length} frame(s), first ${JSON.stringify(noBar[0])}`);
        const noTitle = frames.filter((f) => f.title !== sw.hub);
        check(!noTitle.length, `the title “${sw.hub}” was missing in ${noTitle.length} frame(s), from ${noTitle[0]?.ms} ms`);
        const blank = frames.filter((f) => f.body === 0 && !f.skeleton);
        check(!blank.length, `the page under the tabs was blank in ${blank.length} frame(s), ${blank[0]?.ms}–${blank[blank.length - 1]?.ms} ms`);
        const moved = frames.findIndex((f) => f.current === sw.tab);
        check(moved >= 0 && moved <= 1, `the tapped tab became current only at frame ${moved} (${frames[moved]?.ms} ms)`);
        // Within 100 ms of the tap (a frame's slack) the area under the tabs is the new page or its skeleton, not the old page.
        const answered = frames.find((f) => f.path === sw.to || f.skeleton);
        check(answered && answered.ms <= 120, `neither ${sw.to} nor its skeleton showed within 100 ms (first at ${answered?.ms} ms)`);
        if (settled) {
          // Once the page has settled every mode is prefetched (ahead of the navigation's routes): the switch is drawn from the
          // client cache, with no request and no skeleton.
          const asked = rsc.slice(before).filter((r) => !r.prefetch);
          check(!asked.length, `the switch waited for the server: ${asked.map((r) => r.url.replace(app, "")).join(", ")}`);
          const skeleton = frames.filter((f) => f.skeleton);
          check(!skeleton.length, `the skeleton showed in ${skeleton.length} frame(s) though the page had settled`);
        }
        await ctx.close();
      }
    }
  }

  // A fresh load (a slow phone: CPU 4× slower): once the mode's page has drawn it stays drawn until it is interactive (a
  // context change that reaches a part still hydrating makes React swap its server HTML for the skeleton), and the area
  // under the hub's bar is never blank.
  for (const device of ["phone", "desktop"]) {
    for (const path of ["/audio/music", "/upscale/fps"]) {
      if (!step(`${device}, fresh load: ${path} draws once and never goes blank or back to its skeleton`)) continue;
      const { ctx, page } = await context(device);
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await page.addInitScript((cfg) => {
        const go = () => (window.__frames ? window.__frames.start(cfg) : requestAnimationFrame(go));
        go();
      }, HUB);
      await page.goto(app + path, { waitUntil: "load" });
      await page.waitForTimeout(5000);
      const { list } = await page.evaluate(() => window.__frames.stop());
      const drawn = list.findIndex((f) => f.bar && f.body > 0 && !f.skeleton);
      check(drawn >= 0, `${path} never drew its page`);
      const flip = list.slice(drawn).filter((f) => f.body === 0 || f.skeleton);
      check(!flip.length, `after drawing at ${Math.round(list[drawn]?.t)} ms the page went back to ${flip[0]?.skeleton ? "its skeleton" : "blank"} in ${flip.length} frame(s)`);
      const blank = list.filter((f) => f.bar && f.body === 0 && !f.skeleton);
      check(!blank.length, `the area under the bar was blank in ${blank.length} frame(s) of the load`);
      await ctx.close();
    }
  }

  if (step("phone: a tab row swiped before the page is interactive stays where it was put")) {
    const { ctx, page } = await context("phone");
    await page.goto(`${app}/audio`, { waitUntil: "commit" });
    const row = `${HUB.bar} > div`;
    await page.waitForSelector(row, { state: "attached", timeout: 30_000 });
    await page.evaluate((sel) => {
      document.querySelector(sel).scrollLeft = 200;
    }, row);
    await page.waitForLoadState("load");
    await page.waitForTimeout(4000);
    const left = await page.evaluate((sel) => document.querySelector(sel).scrollLeft, row);
    check(left >= 150, `the row was scrolled back to ${left} px`);
    await ctx.close();
  }

  if (step("going back to a mode shows its header controls once")) {
    const { ctx, page } = await context("desktop");
    await openRoute(page, `${app}/audio/music`, { settleMs: 2500 });
    const header = page.locator("#content header").first();
    const fresh = await header.innerText();
    for (const [tab, to] of [
      ["Speech", "/audio/speech"],
      ["Translate", "/audio/translate"],
      ["Music", "/audio/music"],
    ]) {
      await page.locator(HUB.bar).getByRole("link", { name: tab, exact: true }).click();
      await page.waitForURL((u) => u.pathname === to);
      await page.waitForTimeout(800);
    }
    check((await header.innerText()) === fresh, `the header after switching back reads “${await header.innerText()}”, on a fresh load “${fresh}”`);
    await ctx.close();
  }

  for (const device of ["phone", "desktop"]) {
    if (!step(`${device}: Marketing suite tabs move in the next frame, and Back shows the page's own tab`)) continue;
    const { ctx, page } = await context(device);
    await openRoute(page, `${app}/marketing`, { settleMs: 4000 });
    const bar = 'nav[aria-label="Marketing tools"]';
    const cfg = { bar, current: `${bar} [aria-current="page"]` };
    const click = page.locator(bar).getByRole("link", { name: "Click to Ad" });
    const frames = await sampleSwitch(page, click, device, cfg, (f) => f.path === "/marketing/click-to-ad" && f.content > 0);
    const moved = frames.findIndex((f) => f.current === "Click to Ad");
    check(moved >= 0 && moved <= 1, `Click to Ad became current only at frame ${moved} (${frames[moved]?.ms} ms)`);
    const noBar = frames.filter((f) => !f.bar);
    check(!noBar.length, `the Marketing tabs were missing in ${noBar.length} frame(s), first ${JSON.stringify(noBar[0])}`);
    await page.goBack();
    await page.waitForURL((u) => u.pathname === "/marketing");
    await page.waitForTimeout(500);
    const back = await page.locator(`${bar} [aria-current="page"]`).filter({ visible: true }).allInnerTexts();
    check(back.length === 1 && back[0].trim() === "Marketing Studio", `after Back the current Marketing tab reads ${JSON.stringify(back)}`);
    await ctx.close();
  }

  if (step("Back after a hub tab switch shows the mode it returns to")) {
    const { ctx, page } = await context("phone");
    await openRoute(page, `${app}/audio/music`, { settleMs: 2500 });
    await page.locator(HUB.bar).getByRole("link", { name: "Dialogue", exact: true }).tap();
    await page.waitForURL((u) => u.pathname === "/audio/dialogue");
    await page.waitForTimeout(500);
    await page.goBack();
    await page.waitForURL((u) => u.pathname === "/audio/music");
    await page.waitForTimeout(500);
    const back = await page.locator(HUB.current).filter({ visible: true }).allInnerTexts();
    check(back.length === 1 && back[0].trim() === "Music", `after Back the current tab reads ${JSON.stringify(back)}`);
    await ctx.close();
  }

  for (const device of ["phone", "desktop"]) {
    if (!step(`${device}: Library sections switch in the same frame, with no request`)) continue;
    const { ctx, page, rsc } = await context(device);
    await openRoute(page, `${app}/library`, { settleMs: 2500 });
    const list = page.locator('[role="tablist"][aria-label="Library sections"]');
    const videos = list.getByRole("tab", { name: /^Videos/ });
    await videos.waitFor({ timeout: 20_000 });
    const before = rsc.length;
    const frames = await sampleSwitch(page, videos, device, { current: '[aria-label="Library sections"] [aria-selected="true"]' }, (f) => /^Videos/.test(f.current ?? ""));
    const moved = frames.findIndex((f) => /^Videos/.test(f.current ?? ""));
    check(moved >= 0 && moved <= 1, `the Videos section became selected only at frame ${moved} (${frames[moved]?.ms} ms)`);
    check(new URL(page.url()).searchParams.get("tab") === "videos", `the address did not follow (${page.url()})`);
    const asked = rsc.slice(before).filter((r) => !r.prefetch);
    check(!asked.length, `switching asked the server: ${asked.map((r) => r.url).join(", ")}`);
    await ctx.close();
  }

  if (step("desktop: Studios launcher Image → Audio never blanks the content area")) {
    const { ctx, page } = await context("desktop");
    await openRoute(page, `${app}/image`, { settleMs: 4000 });
    await page.locator("[data-top-bar]").getByRole("button", { name: /^Studios/ }).click();
    const audio = page.locator("#studios-launcher").getByRole("link", { name: /^Audio/ }).first();
    await audio.waitFor();
    const frames = await sampleSwitch(page, audio, "desktop", { bar: HUB.bar, body: HUB.body, current: HUB.current }, (f) => f.path === "/audio" && f.bar && f.body > 0 && !f.skeleton);
    const blank = frames.filter((f) => f.content === 0);
    check(!blank.length, `the content area was blank in ${blank.length} frame(s), from ${blank[0]?.ms} ms`);
    const last = frames[frames.length - 1];
    check(last.path === "/audio" && last.bar, `Audio did not land with its tabs (last frame ${JSON.stringify(last)})`);
    await ctx.close();
  }

  if (step("desktop: the bar's Library is marked the frame after the click")) {
    const { ctx, page } = await context("desktop");
    await openRoute(page, `${app}/image`, { settleMs: 4000 });
    const library = page.locator("[data-top-bar]").getByRole("link", { name: "Library", exact: true });
    const frames = await sampleSwitch(page, library, "desktop", { current: '[data-top-bar] a[aria-current="page"]' }, (f) => f.path === "/library");
    const moved = frames.findIndex((f) => f.current === "Library");
    check(moved >= 0 && moved <= 1, `Library became the open page's item only at frame ${moved} (${frames[moved]?.ms} ms)`);
    await ctx.close();
  }
} finally {
  await browser.close();
}

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("ok");
