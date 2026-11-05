// Home's card rows under the first screen in a real browser: Camera motions, Effects, Apps, and Studios and tools
// (src/components/home/home-sections.tsx). Run it on a production server (`next build`, then `next start -p <port>`), or
// against the live site.
//
// Usage: node tests/e2e/home-sections.mjs [appUrl] [--shots <dir>]   (pnpm test:e2e:home-sections)
//
// At 390@3x (a phone) and 1440@2x (a laptop), as a guest:
// 0. Each row shows its cards in full rows: four rows wherever it's a grid (Camera motions and Effects 24 from xl, 16
//    from lg, 12 from sm; Apps 12, six beside the before/after from xl and six under it; Studios and tools 16 from lg,
//    8 from sm), and every card on a phone's rail (24, 24, 12 and 16). Counted at 768 and 1024 too.
// 1. Every card shown at that width has its still, at least as wide as its box shows it (times the pixel ratio, up to
//    the widest copy, 1024 px). On a phone that's every card of a sideways row too, loaded before it is swiped in
//    (useRailStills), and a card swiped in shows its still at once. A card hidden at that width loads nothing.
// 2. With each row in view, its cards' clips play by themselves (muted, inline): every card at least half in view
//    plays, up to the cap (MAX_PLAYING in src/lib/preview-playback.ts: 3 on a phone, 6 wider), its time moving on;
//    never more than the cap on the whole page at once; a card less than half in view plays nothing. No play sign over
//    a card.
// 3. A phone's row swiped along: the card swiped in plays, the one swiped out stops at once.
// 4. The tab hidden: nothing plays; shown again, the cards in view play again.
// 5. Nothing shifts: layout shift under 0.01 through all of it.
// 6. Reduced motion, and Save-Data: no clip plays by itself and every still is there; on the laptop a hover still plays
//    the card's clip.
import fs from "node:fs";
import path from "node:path";
import { DESKTOP, launch, PHONE, root } from "./_browser.mjs";

const args = process.argv.slice(2);
const app = (args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--shots") ?? "http://localhost:3620").replace(/\/$/, "");
const shotsDir = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : undefined;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

/** The rows in the order a reader meets them, top to bottom (src/app/(studio)/page.tsx). */
const SECTIONS = ["home-motions", "home-effects", "home-apps", "home-studios"];
const cap = (() => {
  const src = fs.readFileSync(path.join(root, "src/lib/preview-playback.ts"), "utf8");
  const m = /MAX_PLAYING = \{ narrow: (\d+), wide: (\d+) \}/.exec(src);
  if (!m) throw new Error("MAX_PLAYING not found in src/lib/preview-playback.ts");
  return { narrow: Number(m[1]), wide: Number(m[2]) };
})();
/**
 * The cards each row shows, row by row from the top, at a viewport width (a phone's rail is one row). Apps from xl: three
 * and three beside the before/after, then six under it.
 */
const ROWS = (width) =>
  width < 640
    ? { "home-motions": [24], "home-effects": [24], "home-apps": [12], "home-studios": [16] }
    : width < 1024
      ? { "home-motions": [3, 3, 3, 3], "home-effects": [3, 3, 3, 3], "home-apps": [3, 3, 3, 3], "home-studios": [2, 2, 2, 2] }
      : width < 1280
        ? { "home-motions": [4, 4, 4, 4], "home-effects": [4, 4, 4, 4], "home-apps": [4, 4, 4], "home-studios": [4, 4, 4, 4] }
        : { "home-motions": [6, 6, 6, 6], "home-effects": [6, 6, 6, 6], "home-apps": [3, 3, 6], "home-studios": [4, 4, 4, 4] };
/** The widest copy of a cover's still (preset-hd.generated.ts). */
const WIDEST = 1024;
/** How long a clip may take to load and reach its place in the shared cycle (STAGGER_CYCLE, 2.8 s) before it plays. */
const PLAY_WITHIN = app.includes("localhost") || app.includes("127.0.0.1") ? 9000 : 15000;

// E2E_CHANNEL=chrome: the installed Chrome, which plays H.264 (a Chromium build without the codec can't play the clips).
const browser = await launch({ args: ["--autoplay-policy=no-user-gesture-required"], ...(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : {}) });
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(name);
};

/** Layout shifts (not caused by input), summed in `window.__cls`, from the first paint. */
const watchShifts = () => {
  window.__cls = 0;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
  }).observe({ type: "layout-shift", buffered: true });
};

/**
 * Every card of the four rows shown at this width (a card hidden at this width is skipped): its section, its name,
 * how much of it is in view (cut by its row, which scrolls sideways on a phone), its still and its clip.
 */
const readCards = (sections) =>
  sections.flatMap((id) => {
    const section = document.getElementById(id).closest("section");
    const rail = section.querySelector(".snap-x");
    // From xl the Apps cards sit in the section's own grid (their row is display: contents, which has no box).
    const clip = (getComputedStyle(rail).display === "contents" ? section : rail).getBoundingClientRect();
    return [...rail.children]
      .filter((item) => item.getClientRects().length > 0)
      .map((item) => {
        const a = item.querySelector("a");
        const r = a.getBoundingClientRect();
        const w = Math.max(0, Math.min(r.right, clip.right, innerWidth) - Math.max(r.left, clip.left, 0));
        const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
        const img = a.querySelector("img");
        const v = a.querySelector("video");
        return {
          section: id,
          name: (a.querySelector("p")?.textContent ?? a.getAttribute("href")).trim(),
          ratio: r.width && r.height ? (w * h) / (r.width * r.height) : 0,
          still: !!img && img.complete && img.naturalWidth > 0,
          src: img?.currentSrc ?? "",
          box: img ? [img.clientWidth, img.clientHeight] : [0, 0],
          video: v ? { t: v.currentTime, paused: v.paused, muted: v.muted, inline: v.hasAttribute("playsinline") } : null,
          sign: !!a.querySelector(".pv-play, svg.lucide-play, svg.lucide-circle-play"),
        };
      });
  });

/** Cards' clips playing anywhere on the page (the first screen's tiles too, which share the cap): not paused, not ended. */
const playingOnPage = () => [...document.querySelectorAll("a video")].filter((v) => !v.paused && !v.ended).length;

/** The true width of each still the browser chose, read from its file. */
async function stillWidths(page, srcs) {
  return page.evaluate(
    (list) =>
      Promise.all(
        list.map(
          (src) =>
            new Promise((resolve) => {
              const im = new Image();
              im.onload = () => resolve(im.naturalWidth);
              im.onerror = () => resolve(0);
              im.src = src;
            }),
        ),
      ),
    srcs,
  );
}

/** The device pixels a 4:3 picture covering this box needs (media-pick.ts coverWidth). */
const need = ([w, h], dpr) => Math.ceil(Math.max(w, h * (4 / 3)) * dpr);

/** How many cards each row shows, row by row (cards whose tops line up are a row), and how many it holds in all. */
const readRows = (sections) =>
  Object.fromEntries(
    sections.map((id) => {
      const rail = document.getElementById(id).closest("section").querySelector(".snap-x");
      const shown = [...rail.children].filter((item) => item.getClientRects().length > 0);
      const tops = new Map();
      for (const item of shown) {
        const top = Math.round(item.getBoundingClientRect().top + scrollY);
        tops.set(top, (tops.get(top) ?? 0) + 1);
      }
      return [id, { rows: [...tops.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n), all: rail.children.length }];
    }),
  );

/** Each row's cards, row by row, at this width: as many as ROWS says, every row full. */
async function checkRows(page, label, width) {
  for (const id of SECTIONS) {
    await scrollToSection(page, id);
    await page.waitForTimeout(150);
  }
  const seen = await page.evaluate(readRows, SECTIONS);
  const want = ROWS(width);
  for (const id of SECTIONS)
    check(
      `${label} ${id}: ${want[id].reduce((a, b) => a + b, 0)} cards in ${want[id].length} full row${want[id].length > 1 ? "s" : ""}`,
      JSON.stringify(seen[id].rows) === JSON.stringify(want[id]),
      `rows ${JSON.stringify(seen[id].rows)} of ${seen[id].all}`,
    );
}

async function scrollToSection(page, id) {
  await page.evaluate((i) => {
    const s = document.getElementById(i).closest("section");
    window.scrollTo(0, s.getBoundingClientRect().top + scrollY - 70);
  }, id);
}

/**
 * Waits until every card at least half in view plays (its time moving on), as many as the cap allows: the rows share
 * the cap, so all four are counted. Returns what it saw: the cards, the ones in view and playing, the most clips playing
 * on the page at once and loaded in the rows at once, and whether they all played in time.
 */
async function waitForPlaying(page, max) {
  const start = Date.now();
  let most = 0;
  let mounted = 0;
  let last;
  while (Date.now() - start < PLAY_WITHIN) {
    const a = await page.evaluate(readCards, SECTIONS);
    most = Math.max(most, await page.evaluate(playingOnPage));
    await page.waitForTimeout(500);
    const b = await page.evaluate(readCards, SECTIONS);
    most = Math.max(most, await page.evaluate(playingOnPage));
    mounted = Math.max(mounted, b.filter((c) => c.video).length);
    const inView = b.filter((c) => c.ratio >= 0.5);
    const moving = b.filter((c, i) => c.video && !c.video.paused && a[i]?.video && c.video.t !== a[i].video.t);
    last = { cards: b, inView, moving };
    if (moving.length >= Math.min(max, inView.length)) return { ...last, most, mounted, ok: true };
  }
  return { ...last, most, mounted, ok: false };
}

async function sharpAndFilled(page, label, dpr) {
  const cards = await page.evaluate(readCards, SECTIONS);
  const blank = cards.filter((c) => !c.still);
  check(`${label}: every card shown has its still`, blank.length === 0, `${cards.length} cards${blank.length ? `; blank: ${blank.map((c) => `${c.section}/${c.name}`).join(", ")}` : ""}`);
  const widths = await stillWidths(
    page,
    cards.map((c) => c.src),
  );
  const soft = cards.map((c, i) => ({ ...c, px: widths[i] })).filter((c) => c.px < Math.min(need(c.box, dpr), WIDEST));
  check(
    `${label}: every still is at least as wide as its box needs`,
    soft.length === 0,
    soft.length
      ? soft.map((c) => `${c.name} ${c.px}px < ${need(c.box, dpr)}`).join(", ")
      : `e.g. ${widths[0]} px (${cards[0].src.replace(app, "").split("?")[0]}) for a ${need(cards[0].box, dpr)} px box`,
  );
  return cards;
}

async function run(device, label, dpr, max) {
  const ctx = await browser.newContext({ ...device, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  await page.addInitScript(watchShifts);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 160)));
  await page.goto(`${app}/?e2e=${Date.now()}`, { waitUntil: "load" });
  await page.waitForTimeout(800);

  // The rows sit in that order down the page: Camera motions first, then Effects.
  const tops = await page.evaluate((ids) => ids.map((i) => document.getElementById(i).closest("section").getBoundingClientRect().top), SECTIONS);
  check(`${label}: the rows come in order`, tops.every((t, i) => i === 0 || t > tops[i - 1]), SECTIONS.map((id, i) => `${id} ${Math.round(tops[i])}`).join(" < "));
  await checkRows(page, label, device.viewport.width);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);

  // The rows come into view one by one, as a reader scrolls down to them.
  for (const id of SECTIONS) {
    await scrollToSection(page, id);
    await page.waitForTimeout(400);
    const seen = await waitForPlaying(page, max);
    const here = seen.cards.filter((c) => c.section === id);
    const names = (list) => list.map((c) => `${c.section === id ? "" : `${c.section}/`}${c.name}`).join(", ");
    check(
      `${label} ${id}: the cards in view play by themselves`,
      seen.ok && seen.moving.some((c) => c.section === id),
      `${seen.moving.length} playing of ${seen.inView.length} at least half in view (cap ${max}): ${names(seen.moving)}`,
    );
    check(`${label} ${id}: never more than ${max} clips at once`, seen.most <= max && seen.mounted <= max, `at most ${seen.most} playing, ${seen.mounted} loaded`);
    const out = seen.cards.filter((c) => c.ratio < 0.5 && c.video && !c.video.paused);
    check(`${label} ${id}: a card less than half in view plays nothing`, out.length === 0, names(out));
    const loud = seen.cards.filter((c) => c.video && (!c.video.muted || !c.video.inline));
    check(`${label} ${id}: the clips are muted and inline`, loud.length === 0, names(loud));
    check(`${label} ${id}: no play sign over a card`, !here.some((c) => c.sign));
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${label}-${id}.png`) });
  }
  await sharpAndFilled(page, label, dpr);

  if (device === PHONE) {
    // Swiping the Effects row along, a card at a time: the card swiped in shows its still at once and then plays, and
    // the one swiped out stops.
    await scrollToSection(page, "home-effects");
    await page.waitForTimeout(1200);
    for (const step of [1, 2, 3]) {
      await page.evaluate((i) => {
        const rail = document.getElementById("home-effects").closest("section").querySelector(".snap-x");
        const pad = parseFloat(getComputedStyle(rail).scrollPaddingLeft) || 0;
        const left = rail.scrollLeft + rail.children[i].getBoundingClientRect().left - rail.getBoundingClientRect().left - pad;
        rail.scrollTo({ left, behavior: "instant" });
      }, step);
      const now = (await page.evaluate(readCards, ["home-effects"])).filter((c) => c.ratio > 0);
      check(`${label} swipe ${step}: the cards swiped in show their stills at once`, now.every((c) => c.still), now.filter((c) => !c.still).map((c) => c.name).join(", "));
      await page.waitForTimeout(150);
      const off = (await page.evaluate(readCards, ["home-effects"])).filter((c) => c.ratio < 0.5 && c.video && !c.video.paused);
      check(`${label} swipe ${step}: the card swiped out stops`, off.length === 0, off.map((c) => c.name).join(", "));
      const seen = await waitForPlaying(page, max);
      const full = seen.cards.filter((c) => c.section === "home-effects" && c.ratio >= 0.85).map((c) => c.name);
      check(
        `${label} swipe ${step}: the card swiped in plays`,
        seen.ok && seen.moving.some((c) => full.includes(c.name)),
        `in view: ${full.join(", ")}; playing: ${seen.moving.map((c) => c.name).join(", ")}`,
      );
      if (shotsDir && step === 3) await page.screenshot({ path: path.join(shotsDir, `${label}-swiped.png`) });
    }
    // To the end of the row: every card there already has its still.
    await page.evaluate(() => {
      const rail = document.getElementById("home-effects").closest("section").querySelector(".snap-x");
      rail.scrollTo({ left: rail.scrollWidth, behavior: "instant" });
    });
    const end = (await page.evaluate(readCards, ["home-effects"])).filter((c) => c.ratio > 0);
    check(`${label}: the end of the row shows its stills at once`, end.length > 0 && end.every((c) => c.still), end.map((c) => `${c.name}${c.still ? "" : " (blank)"}`).join(", "));
  }

  // The tab goes to the background: nothing plays. Back: the cards in view play again.
  await scrollToSection(page, "home-motions");
  await waitForPlaying(page, max);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(300);
  const hiddenPlaying = await page.evaluate(playingOnPage);
  check(`${label}: a hidden tab plays nothing`, hiddenPlaying === 0, `${hiddenPlaying} playing`);
  await page.evaluate(() => {
    delete document.hidden;
    delete document.visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const back = await waitForPlaying(page, max);
  check(`${label}: shown again, the cards in view play again`, back.ok, `${back.moving.length} playing`);

  const cls = await page.evaluate(() => window.__cls);
  check(`${label}: nothing shifts`, cls < 0.01, `layout shift ${cls.toFixed(4)}`);
  check(`${label}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

/** Reduced motion, or Save-Data: stills only, every one there; a hover (where there's a pointer) still plays a clip. */
async function stillsOnly(device, label, dpr, opts) {
  const ctx = await browser.newContext({ ...device, deviceScaleFactor: dpr, ...(opts.reducedMotion ? { reducedMotion: "reduce" } : {}) });
  const page = await ctx.newPage();
  if (opts.saveData)
    await page.addInitScript(() => Object.defineProperty(navigator, "connection", { value: { saveData: true, effectiveType: "4g", addEventListener() {} }, configurable: true }));
  await page.goto(`${app}/?e2e=${Date.now()}`, { waitUntil: "load" });
  await page.waitForTimeout(800);
  let most = 0;
  for (const id of SECTIONS) {
    await scrollToSection(page, id);
    await page.waitForTimeout(2500);
    most = Math.max(most, await page.evaluate(playingOnPage), (await page.evaluate(readCards, SECTIONS)).filter((c) => c.video).length);
  }
  check(`${label}: no clip plays by itself`, most === 0, `${most} playing`);
  await sharpAndFilled(page, label, dpr);
  if (device === DESKTOP) {
    await scrollToSection(page, "home-effects");
    await page.waitForTimeout(400);
    const box = await page.evaluate(() => {
      const a = document.getElementById("home-effects").closest("section").querySelector(".snap-x a");
      const r = a.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 3 };
    });
    await page.mouse.move(box.x, box.y);
    const start = Date.now();
    let hovered = false;
    while (!hovered && Date.now() - start < PLAY_WITHIN) {
      await page.waitForTimeout(400);
      hovered = (await page.evaluate(readCards, ["home-effects"])).some((c) => c.video && !c.video.paused && c.video.t > 0);
    }
    check(`${label}: a hover still plays the card's clip`, hovered);
    await page.mouse.move(0, 0);
  }
  await ctx.close();
}

console.log(`Home's card rows at ${app} (caps: ${cap.narrow} on a phone, ${cap.wide} wider)`);
// A tablet held up and turned: the counts only.
for (const width of [768, 1024]) {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(`${app}/?e2e=${Date.now()}`, { waitUntil: "load" });
  await page.waitForTimeout(800);
  await checkRows(page, String(width), width);
  await ctx.close();
}
await run(PHONE, "390@3x", 3, cap.narrow);
await run(DESKTOP, "1440@2x", 2, cap.wide);
await stillsOnly(PHONE, "390@3x reduced motion", 3, { reducedMotion: true });
await stillsOnly(DESKTOP, "1440@2x reduced motion", 2, { reducedMotion: true });
await stillsOnly(PHONE, "390@3x Save-Data", 3, { saveData: true });
await stillsOnly(DESKTOP, "1440@2x Save-Data", 2, { saveData: true });
await browser.close();

console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
