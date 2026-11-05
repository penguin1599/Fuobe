// Home's first screen in a real browser (src/components/home/home-bento.tsx). Run it on a production server
// (`next build`, then `next start -p <port>`): the weight and layout-shift numbers mean little on a dev server.
//
// Usage: node tests/e2e/home-bento.mjs [appUrl] [--shots <dir>] [--weight-only] [--only 1b,1c,1d,4,5]   (pnpm test:e2e:home)
//   E2E_BROWSER=webkit or firefox: run it in that engine (tests/e2e/_browser.mjs).
//   E2E_OWNER_PASSWORD: the studio's password, when it has one; the owner's pass signs in with it. Without one the
//   studio is the owner's, and the guest's pass is skipped.
//   --weight-only: only measure what the first screen downloads (to compare another build, such as main's).
//   --only <ids>: run only these numbered parts (the weight, 6, always runs unless --weight-only is all that's asked).
//   Under WebKit, the checks its Playwright build for Windows can't make (ENGINE_LIMITS) are reported as skipped, with
//   the reason, when they fail.
//
// 1. Every width (390, 768, 1024, 1280, 1440, 1920), light and dark, as a guest and as the owner: no sideways scroll,
//    one h1, the headline in its own words ("Make anything:" on one line; the second line whole from 768, and on a
//    phone two lines that break before "finished film,"), it rose into place once, and the first screen holds what it
//    should (a phone: the video tile and the live tile under it; from 1024: all eight). A picture of each (--shots), and a
//    contact sheet of them all.
// 1b. Sharp at every width and pixel ratio (1x, 2x, 3x): every picture on the first screen is at least as wide as its
//    box shows it (object-fit: cover, times the ratio), up to the widest copy there is, and so is each clip once it
//    plays (up to the widest copy of that clip). No play sign on a tile that plays by itself, at any moment from the
//    first paint until both tiles play, and nothing shifts as a clip takes over from its still.
// 1c. The swap: each tile's still is its clip's first frame (the clip at frame 0 over it differs by under 3 levels in
//    255 on average, read at CSS pixels: a browser scales a video and a picture with different filters, which shows
//    only in single device pixels of fine detail), at 390@3x and 1440@2x.
// 1d. The video tile's reel, at 390@3x and 1440@2x, light and dark: its still is Sand Storm's first frame; it plays Sand
//    Storm, then One Take, and back to Sand Storm, each crossfading into the next; each
//    clip framed as listed (its object-position); never more than the clip playing and the next one loaded, the next
//    asked for only once the current one plays; off screen it pauses, back on screen it goes on. A picture of each
//    clip in the tile (--shots). Under reduced motion a hover plays Sand Storm alone, on a loop.
// 1e. The reel when its second clip can't be had, at 1440@2x (Chromium): when that clip fails, the first loops and never
//    stops on a frame; when it comes 6 s late, the first plays again rather than stop on its last frame (never stuck
//    on one frame longer than REEL_STALL_MS and a little), and the second still comes in, at the end of a pass.
// 1f. Genjutsu's swaps, at 390@3x and 1440@2x (light and dark): its still is the couple's first frame with "Original"
//    on it; it plays the couple, then the lake, and back, each clip coming in only over the last one's dark end; the
//    words ride with the divider on every frame (where the clip's frame puts it, placed as the stylesheet says);
//    never more than two clips, the next asked for only once the current one plays. A picture of the tile every
//    0.38 s through the loop, and a sheet of them (--shots). Under reduced motion the still is the couple at rest half
//    way, the words either side of the divider.
// 2. Layout shift under 0.01 at 390 and 1440, through a load and a scroll to the bottom and back.
// 2b. The headline holds still when its parts come late, at 390@3x, 768 and 1440@2x (Chromium): with every font file
//    2.5 s late, and with the HTML in two parts (cut after the second line's first words, 1.5 s apart, by a proxy) and
//    the fonts 1.5 s late, no layout shift moves anything in the h1, the cut line stays unseen until whole, and once all
//    is in, the headline looks as on a quick load (its picture within 1 level in 255 on average).
// 3. Every tile's link answers 200 (the Audio tile's is its words: the tile holds Clean up voice's demo, checked on its
//    own by tests/e2e/home-voice.mjs), and the numbers tile opens every studio (the launcher; a phone's sheet).
// 4. Reduced motion and Save-Data: no clip is fetched or played, nothing moves by itself (the headline is still, the
//    live words stay), and the tiles keep their stills.
// 5. Pause previews stops the reel and freezes every animation; pressed again, they go on.
// 6. Weight: what the page downloads before `load` (clips aside), at 390 and 1440, reported; the first screen's own
//    stills stay under 420 KB (the clips' posters are encoded close to their clips' first frames, and a 3x phone or a
//    2x laptop gets the video tile's widest still). The clips are reported on their own.
// 7. The composer: /?new=1 brings it into view with the focus; a plain visit stays at the top (no autofocus jump).
// 8. Every tile is a named link (the Audio tile: its words), and Tab reaches them in the grid's reading order (through
//    the Audio tile's buttons) with a visible ring.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { DESKTOP, ENGINE, launch, PHONE, root } from "./_browser.mjs";

const args = process.argv.slice(2);
const app = (args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--shots" && args[i - 1] !== "--only") ?? "http://localhost:3620").replace(/\/$/, "");
const shotsDir = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : undefined;
const weightOnly = args.includes("--weight-only");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : undefined;
/** Whether part `id` runs (all of them, unless --weight-only or --only says otherwise). */
const run = (id) => !weightOnly && (!only || only.includes(id));
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

const browser = await launch();
const failures = [];
const notes = [];
/**
 * The checks the Playwright WebKit build for Windows can't make, whatever the page does: under WebKit, one of these
 * that fails is reported as skipped, with its reason.
 */
const ENGINE_LIMITS =
  ENGINE === "webkit"
    ? [
        [/^sharp at /, "this WebKit build takes no AVIF (the narrower fallbacks) and reads a video's width as its box's"],
        [/^the swap at /, "this WebKit build has no frame-accurate video timing (requestVideoFrameCallback)"],
        [/each clip loads only once the one before it plays$/, "this WebKit build doesn't show media requests to the page"],
        [/^reduced motion: no reel clip until asked/, "a looping video stops after one pass in this WebKit build"],
        [/^Tab reaches the tiles|^a focused tile shows its ring/, "WebKit's Tab moves between form controls only, not links, unless the viewer turns that on"],
      ]
    : [];
const check = (name, ok, detail = "") => {
  const limit = !ok && ENGINE_LIMITS.find(([re]) => re.test(name));
  console.log(`${ok ? "ok  " : limit ? "skip" : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (limit) notes.push(`skipped under ${ENGINE}: ${name} (${limit[1]})`);
  else if (!ok) failures.push(`${name} ${detail}`);
};

const WIDTHS = [
  { w: 390, h: 844, phone: true },
  { w: 768, h: 1024 },
  { w: 1024, h: 768 },
  { w: 1280, h: 800 },
  { w: 1440, h: 900 },
  { w: 1920, h: 1080 },
];
const TILES = ["video", "live", "genjutsu", "image", "threeD", "audio", "numbers", "canvas"];
/** The tiles that play a clip by themselves (the reel, the 3D clip, Genjutsu's swap): each only once it is on screen. */
const MOVING = ["video", "threeD", "genjutsu"];
/** The widest copy of a clip (scripts/gen-home-bento.mjs), where its element doesn't say (a reel clip's data-max). */
const CLIP_MAX = 2048;
/**
 * The video tile's reel, in order (HOME_BENTO_REEL, read from src/lib/home-bento.generated.ts): each clip's preset, how
 * it is framed, and its copies' name.
 */
const HOME_REEL = JSON.parse(/export const HOME_BENTO_REEL = (\[[\s\S]*?\n\]);/.exec(fs.readFileSync(path.join(root, "src/lib/home-bento.generated.ts"), "utf8"))[1]);
const REEL = HOME_REEL.map((c) => c.id);
const REEL_POSITION = Object.fromEntries(HOME_REEL.map((c) => [c.id, c.position]));
const REEL_NAME = Object.fromEntries(HOME_REEL.map((c) => [c.id, c.name]));
/** How long the reel waits for a late next clip before the clip on screen plays again (src/lib/home-reel.ts). */
const REEL_STALL_MS = Number(/export const REEL_STALL_MS = (\d+);/.exec(fs.readFileSync(path.join(root, "src/lib/home-reel.ts"), "utf8"))[1]);
const HEADLINE = "Make anything: From an idea to a finished film, in one place.";

/** A context as `who`; null when that viewer can't be had here (a guest needs a studio with a password). */
async function context(who, opts) {
  const ctx = await browser.newContext(opts);
  if (who === "owner" && process.env.E2E_OWNER_PASSWORD) {
    const r = await ctx.request.post(`${app}/api/auth/login`, { data: { password: process.env.E2E_OWNER_PASSWORD } });
    assert.ok(r.ok(), "the owner signs in");
  }
  if (who === "guest" && !process.env.E2E_OWNER_PASSWORD) {
    await ctx.close();
    return null;
  }
  return ctx;
}

const viewportOpts = (v, extra = {}) => ({
  ...(v.phone ? PHONE : {}),
  viewport: { width: v.w, height: v.h },
  deviceScaleFactor: v.phone ? 3 : v.w >= 1440 ? 2 : 1,
  ...extra,
});

async function open(page, url = "/") {
  await page.goto(app + url, { waitUntil: "load", timeout: 90_000 });
  await page.locator("#home-bento h1").waitFor({ timeout: 20_000 });
}

/** The first screen's layout, read in the page. */
const layout = (page) =>
  page.evaluate((tiles) => {
    const box = (el) => {
      const r = el.getBoundingClientRect();
      // Its title's size: the live tile, the highlight, is second only to the video tile.
      const title = el.querySelector("[class*=title]");
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height, title: title ? parseFloat(getComputedStyle(title).fontSize) : 0 };
    };
    const h1 = document.querySelector("#home-bento h1");
    const [line1, line2] = h1.querySelectorAll(":scope > span");
    // The lines a span's words fall on: its text's boxes, grouped by their top.
    const lines = (el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      const tops = [];
      for (const b of r.getClientRects()) if (b.width > 0 && !tops.some((t) => Math.abs(t - b.top) < b.height / 2)) tops.push(b.top);
      return tops.length;
    };
    const accent = line2.querySelector("[data-glow]");
    const rise = (el) =>
      el.getAnimations().map((a) => ({ name: a.animationName, state: a.playState, ms: a.effect.getTiming().duration, delay: a.effect.getTiming().delay, from: a.effect.getKeyframes()[0]?.opacity }));
    return {
      h1s: document.querySelectorAll("h1").length,
      text: h1.textContent.replace(/\s+/g, " ").trim(),
      line1Lines: lines(line1),
      line2Lines: lines(line2),
      line2Italic: getComputedStyle(line2).fontStyle,
      // On a phone the second line breaks before "finished film,": the accent starts its own line, at the left.
      accentStartsLine: Math.abs(accent.getClientRects()[0].left - line2.getBoundingClientRect().left) < 2,
      rise: { line1: rise(line1), line2: rise(line2) },
      scroll: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
      vh: innerHeight,
      tiles: Object.fromEntries(tiles.map((t) => [t, box(document.querySelector(`#home-bento [data-tile="${t}"]`))])),
      dark: document.documentElement.classList.contains("dark"),
    };
  }, TILES);

/**
 * Each picture and playing clip on the first screen against what its box needs: the box under object-fit: cover (its
 * width, or its height times the picture's shape when that is more), times the pixel ratio, up to the widest copy the
 * page offers for it.
 */
const sharpness = (page) =>
  page.evaluate((CLIP_MAX) => {
    const dpr = devicePixelRatio;
    // The copies the browser could choose from for an img: its <picture>'s matching source, or its own srcset, each as
    // its URL and its width. (naturalWidth is no help here: under a w-descriptor it is scaled by the pixel ratio.)
    const copies = (img) => {
      const pic = img.closest("picture");
      const srcset = (pic ? [...pic.querySelectorAll("source")].find((s) => !s.media || matchMedia(s.media).matches)?.srcset : undefined) ?? img.srcset ?? "";
      return srcset
        .split(",")
        .map((c) => /^(\S+)\s+(\d+)w$/.exec(c.trim()))
        .filter(Boolean)
        .map((m) => ({ url: new URL(m[1], location.href).href, w: Number(m[2]) }));
    };
    const out = [];
    for (const img of document.querySelectorAll("#home-bento [data-tile] img")) {
      const r = img.getBoundingClientRect();
      if (!img.complete || !img.naturalWidth || r.width < 2) continue;
      const list = copies(img);
      const chosen = list.find((c) => c.url === img.currentSrc);
      const has = chosen?.w ?? img.naturalWidth;
      const ratio = img.naturalWidth / img.naturalHeight;
      const need = Math.ceil(Math.max(r.width, r.height * ratio) * dpr);
      const max = list.length ? Math.max(...list.map((c) => c.w)) : has;
      const what = new URL(img.currentSrc || img.src).pathname.split("/").pop();
      out.push({ what, tile: img.closest("[data-tile]").dataset.tile, has, need, max, ok: has >= Math.min(need, max) * 0.98 });
    }
    for (const v of document.querySelectorAll("#home-bento [data-tile] video")) {
      if (!v.videoWidth) continue;
      const r = v.getBoundingClientRect();
      const need = Math.ceil(Math.max(r.width, (r.height * v.videoWidth) / v.videoHeight) * dpr);
      const what = new URL(v.currentSrc).pathname.split("/").pop();
      const max = Number(v.dataset.max) || CLIP_MAX;
      out.push({ what, tile: v.closest("[data-tile]").dataset.tile, has: v.videoWidth, need, max, ok: v.videoWidth >= Math.min(need, max) * 0.98 });
    }
    return out;
  }, CLIP_MAX);

// ------------------------------------------------------------------------------------------- 1. every width
const shots = [];
const sharpNotes = [];
if (run("1"))
  for (const who of ["guest", "owner"]) {
    for (const scheme of ["light", "dark"]) {
      for (const v of WIDTHS) {
        const ctx = await context(who, viewportOpts(v, { colorScheme: scheme }));
        if (!ctx) {
          if (scheme === "light" && v.w === 390) console.log("- (skipped: the guest pass needs a studio with a password, E2E_OWNER_PASSWORD)");
          continue;
        }
        const page = await ctx.newPage();
        await open(page);
        await page.waitForTimeout(1500);
        const l = await layout(page);
        const tag = `${who} ${scheme} ${v.w}`;
        check(`${tag}: no sideways scroll`, l.scroll[0] === l.scroll[1], l.scroll.join(" vs "));
        check(`${tag}: one h1, the headline`, l.h1s === 1 && l.text === HEADLINE, `${l.h1s} · ${l.text}`);
        check(`${tag}: theme`, l.dark === (scheme === "dark"));
        check(`${tag}: "Make anything:" on one line, the second line in italic`, l.line1Lines === 1 && l.line2Italic === "italic", String(l.line1Lines));
        if (v.w >= 768) check(`${tag}: the second line whole`, l.line2Lines === 1, String(l.line2Lines));
        else check(`${tag}: the second line on two, the second starting at "finished film,"`, l.line2Lines === 2 && l.accentStartsLine, `${l.line2Lines} ${l.accentStartsLine}`);
        const [r1, r2] = [l.rise.line1[0], l.rise.line2[0]];
        check(
          `${tag}: the headline rose once, from 40 % (its words on the first paint)`,
          r1?.name === "hb-rise" && r1.ms === 700 && r2?.ms === 900 && r2.delay === 120 && [r1, r2].every((r) => r.state === "finished" && Number(r.from) === 0.4),
          JSON.stringify(l.rise),
        );
        if (v.phone) {
          const bottom = l.vh - 64;
          const first = ["video", "live"];
          const out = first.filter((t) => l.tiles[t].top < 0 || l.tiles[t].bottom > bottom);
          check(`${tag}: the video tile and the live tile under it on the first screen`, out.length === 0, first.map((t) => `${t} ${Math.round(l.tiles[t].bottom)}`).join(", ") + ` ≤ ${bottom}`);
          check(`${tag}: every tile at least 44 px to tap`, TILES.every((t) => l.tiles[t].w >= 44 && l.tiles[t].h >= 44));
          // Genjutsu right under the live tile, the full row wide, at 16:9 or taller.
          const [lv, gj] = [l.tiles.live, l.tiles.genjutsu];
          check(
            `${tag}: Genjutsu right after the live tile, full width, 16:9 or taller`,
            gj.top > lv.bottom && gj.top - lv.bottom < 24 && Math.abs(gj.w - lv.w) < 1 && gj.h / gj.w >= 9 / 16 - 0.005,
            `live ${Math.round(lv.w)}x${Math.round(lv.h)} to ${Math.round(lv.bottom)}, genjutsu ${Math.round(gj.w)}x${Math.round(gj.h)} from ${Math.round(gj.top)}`,
          );
        }
        // The live tile, the highlight, and Genjutsu are the biggest after the video tile, the same size (the live tile
        // never the smaller), and their titles no smaller than any but the video's.
        const area = (t) => l.tiles[t].w * l.tiles[t].h;
        const rest = TILES.filter((t) => !["video", "live", "genjutsu", "numbers"].includes(t));
        check(
          `${tag}: the live and Genjutsu tiles the same size, second only to the video tile`,
          area("live") >= area("genjutsu") * 0.98 &&
            area("genjutsu") >= area("live") * 0.85 &&
            rest.every((t) => area("genjutsu") > area(t) && l.tiles.live.title >= l.tiles[t].title && l.tiles.genjutsu.title >= l.tiles[t].title) &&
            area("video") > area("live"),
          ["video", "live", "genjutsu", ...rest].map((t) => `${t} ${Math.round(l.tiles[t].w)}x${Math.round(l.tiles[t].h)}/${l.tiles[t].title}`).join(", "),
        );
        if (v.w >= 1024) {
          const out = TILES.filter((t) => l.tiles[t].bottom > l.vh || l.tiles[t].top < 0);
          check(`${tag}: all eight tiles on the first screen`, out.length === 0, out.join(", "));
        }
        if (shotsDir) {
          const f = path.join(shotsDir, `${who}-${scheme}-${v.w}.png`);
          await page.screenshot({ path: f });
          shots.push({ f, who, scheme, w: v.w });
        }
        await ctx.close();
      }
    }
  }

/**
 * Watches the first screen from the first paint: every play sign seen on a tile that plays by itself (the video and 3D
 * tiles), when each clip first showed, and every layout shift, with its time.
 */
const watchSwap = () => {
  window.__signs = [];
  window.__shown = {};
  window.__shifts2 = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (!e.hadRecentInput) window.__shifts2.push({ v: e.value, at: Math.round(e.startTime) });
  }).observe({ type: "layout-shift", buffered: true });
  const MOVING = ["video", "threeD", "genjutsu"];
  // A tile below the fold plays only once it is scrolled to: the ones wholly on the first screen are watched.
  const onScreen = () =>
    MOVING.filter((t) => {
      const r = document.querySelector(`#home-bento [data-tile=${t}]`)?.getBoundingClientRect();
      return r && r.top >= 0 && r.bottom <= innerHeight;
    });
  const look = () => {
    for (const t of MOVING) {
      const tile = document.querySelector(`#home-bento [data-tile=${t}]`);
      if (!tile) continue;
      for (const el of tile.querySelectorAll("svg.lucide-play, [class*=play-glyph]")) {
        const st = getComputedStyle(el);
        if (el.getBoundingClientRect().width > 0 && st.visibility !== "hidden" && Number(st.opacity) > 0) window.__signs.push({ t, at: Math.round(performance.now()) });
      }
      if (!window.__shown[t] && tile.querySelector("video[data-ready]")) window.__shown[t] = Math.round(performance.now());
    }
    const on = onScreen();
    if (performance.now() < 15_000 && !(on.length && on.every((t) => window.__shown[t]))) requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
};

// ------------------------------------------------------------------------------------------- 1b. sharp at every ratio
if (run("1b"))
  for (const v of WIDTHS)
    for (const dpr of [1, 2, 3]) {
      const ctx = await browser.newContext({ ...(v.phone ? PHONE : {}), viewport: { width: v.w, height: v.h }, deviceScaleFactor: dpr });
      const page = await ctx.newPage();
      await page.addInitScript(watchSwap);
      await open(page);
      // The clips start once their tile's still is up and on screen: wait until each on the first screen has its first frame.
      const moving = await page.evaluate(
        (all) =>
          all.filter((t) => {
            const r = document.querySelector(`#home-bento [data-tile=${t}]`).getBoundingClientRect();
            return r.top >= 0 && r.bottom <= innerHeight;
          }),
        MOVING,
      );
      await page
        .waitForFunction((ts) => ts.every((t) => [...document.querySelectorAll(`#home-bento [data-tile=${t}] video`)].some((x) => x.videoWidth > 0)), moving, { timeout: 12_000 })
        .catch(() => {});
      await page.waitForTimeout(300);
      const s = await sharpness(page);
      const bad = s.filter((x) => !x.ok);
      const clips = s.filter((x) => x.what.endsWith(".mp4"));
      check(
        `sharp at ${v.w}@${dpr}x: ${s.length} pictures and clips at least their box x ratio`,
        bad.length === 0 && moving.every((t) => clips.some((x) => x.tile === t)),
        (bad.length ? bad : clips).map((x) => `${x.tile} ${x.what} ${x.has} for ${x.need} (max ${x.max})`).join("; "),
      );
      sharpNotes.push(`${v.w}@${dpr}x: ${s.map((x) => `${x.tile} ${x.what} ${x.has}/${x.need}`).join(", ")}`);
      const w = await page.evaluate(() => ({ signs: window.__signs, shown: window.__shown, shifts: window.__shifts2, load: Math.round(performance.getEntriesByType("navigation")[0]?.loadEventEnd ?? 0) }));
      check(`no play sign at ${v.w}@${dpr}x on the tiles that play by themselves`, w.signs.length === 0, JSON.stringify(w.signs.slice(0, 3)));
      // Nothing shifts as a clip takes over from its still (from 100 ms before it shows to 600 ms after).
      const atSwap = w.shifts.filter((x) => Object.values(w.shown).some((t) => x.at >= t - 100 && x.at <= t + 600));
      check(`no layout shift at the swap at ${v.w}@${dpr}x`, atSwap.length === 0 && moving.every((t) => w.shown[t]), `${JSON.stringify(w.shown)} load ${w.load}; ${JSON.stringify(atSwap)}`);
      if (dpr === 2 || (v.phone && dpr === 3)) notes.push(`clips shown at ${v.w}@${dpr}x: video ${w.shown.video} ms, 3D ${w.shown.threeD} ms, Genjutsu ${w.shown.genjutsu} ms (load ${w.load} ms)`);
      await ctx.close();
    }

// ------------------------------------------------------------------------------------------- 1c. the swap
/**
 * How far the clip at frame 0 is from the still under it: the tile's clip area shot with the clip shown and hidden,
 * both read at CSS pixels (`dpr` device pixels to one).
 */
async function swapDiff(page, tile, dpr = 1) {
  const clip = page.locator(`#home-bento [data-tile=${tile}] .hb-clip`);
  await page.evaluate(async (tile) => {
    const v = document.querySelector(`#home-bento [data-tile=${tile}] video`);
    v.pause();
    v.currentTime = 0;
    await new Promise((r) => (v.seeking ? v.addEventListener("seeked", r, { once: true }) : r()));
    // Then two frames of the page, so the seeked frame is on screen (a paused clip presents no further frames).
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 100))));
    // The line along the bottom follows the clip: out of both shots.
    for (const el of document.querySelectorAll(`#home-bento [data-tile=${tile}] .hb-progress`)) el.style.visibility = "hidden";
  }, tile);
  const withClip = await clip.screenshot({ animations: "disabled" });
  await page.evaluate((tile) => (document.querySelector(`#home-bento [data-tile=${tile}] video`).style.visibility = "hidden"), tile);
  const still = await clip.screenshot({ animations: "disabled" });
  const sharp = createRequire(path.join(root, "package.json"))("sharp");
  const width = Math.round((await sharp(withClip).metadata()).width / dpr);
  const [a, b] = await Promise.all([withClip, still].map((x) => sharp(x).removeAlpha().resize(width, null, { kernel: "cubic" }).raw().toBuffer()));
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return { diff: sum / a.length, withClip, still };
}
if (run("1c"))
  for (const [v, dpr] of [
    [WIDTHS[0], 3],
    [WIDTHS[4], 2],
  ]) {
    const ctx = await browser.newContext({ ...(v.phone ? PHONE : {}), viewport: { width: v.w, height: v.h }, deviceScaleFactor: dpr });
    const page = await ctx.newPage();
    await open(page);
    // Each moving tile, scrolled to where it isn't on the first screen (a phone's 3D and Genjutsu tiles).
    for (const tile of MOVING) {
      await page.locator(`#home-bento [data-tile=${tile}]`).scrollIntoViewIfNeeded();
      await page.waitForFunction((t) => document.querySelector(`#home-bento [data-tile=${t}] video[data-ready]`), tile, { timeout: 12_000 }).catch(() => {});
      if (!(await page.locator(`#home-bento [data-tile=${tile}] video[data-ready]`).count())) {
        check(`the swap at ${v.w}@${dpr}x, ${tile}: its clip plays`, false);
        continue;
      }
      const src = await page.evaluate((tile) => new URL(document.querySelector(`#home-bento [data-tile=${tile}] video`).currentSrc).pathname.split("/").pop(), tile);
      const r = await swapDiff(page, tile, dpr);
      check(`the swap at ${v.w}@${dpr}x, ${tile}: the still is ${src}'s first frame`, r.diff < 3, `mean difference ${r.diff.toFixed(2)} of 255 at CSS pixels`);
      if (shotsDir) {
        fs.writeFileSync(path.join(shotsDir, `swap-${tile}-${v.w}@${dpr}x-clip.png`), r.withClip);
        fs.writeFileSync(path.join(shotsDir, `swap-${tile}-${v.w}@${dpr}x-still.png`), r.still);
      }
    }
    await ctx.close();
  }

// ------------------------------------------------------------------------------------------- 1d. the reel
/**
 * Logs the video tile's reel from the first paint: the clip on screen (data-reel) each time it changes, and every
 * moment it holds more than one clip, with each one's state; the time each clip's element first asks for its file is
 * logged on the test's side (the same clock: Date.now()).
 */
const watchReel = () => {
  window.__reel = { turns: [], most: 0, both: [], playing: {}, fades: 0, back: [], outT: new WeakMap() };
  const look = () => {
    const span = document.querySelector("#home-bento [data-tile=video] .hb-clip");
    if (span) {
      const at = span.dataset.reel;
      const last = window.__reel.turns.at(-1);
      if (at !== undefined && last?.i !== at) window.__reel.turns.push({ i: at, t: Date.now() });
      const vids = [...span.querySelectorAll("video")];
      window.__reel.most = Math.max(window.__reel.most, vids.length);
      for (const v of vids) if (!v.paused && !window.__reel.playing[v.dataset.clip + "@" + at]) window.__reel.playing[v.dataset.clip + "@" + at] = Date.now();
      const shown = vids.filter((v) => v.hasAttribute("data-ready"));
      if (shown.length > 1) {
        const o = Number(getComputedStyle(shown.at(-1)).opacity);
        if (o > 0.05 && o < 0.95) window.__reel.fades++;
        // The clip going out plays on to its end, or holds its last frame: it never jumps back while it shows through the
        // fade (the clip coming in under 90 %), until it is let go of, its source gone, once the next one is in.
        const out = shown[0];
        const prev = window.__reel.outT.get(out);
        if (prev !== undefined && o < 0.9 && out.hasAttribute("src") && out.currentTime < prev - 0.05 && out.currentTime < out.duration - 0.1)
          window.__reel.back.push({ clip: out.dataset.clip, from: prev, to: out.currentTime, over: o, ended: out.ended, paused: out.paused });
        window.__reel.outT.set(out, out.currentTime);
      }
      if (vids.length > 1 && window.__reel.both.length < 400) window.__reel.both.push({ t: Date.now(), clips: vids.map((v) => v.dataset.clip) });
    }
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
};
if (run("1d")) {
  for (const [v, dpr] of [
    [WIDTHS[0], 3],
    [WIDTHS[4], 2],
  ])
    for (const scheme of ["light", "dark"]) {
      const tag = `${v.w}@${dpr}x ${scheme}`;
      const ctx = await browser.newContext({ ...(v.phone ? PHONE : {}), viewport: { width: v.w, height: v.h }, deviceScaleFactor: dpr, colorScheme: scheme });
      const page = await ctx.newPage();
      const asked = [];
      page.on("request", (r) => {
        const m = /\/previews\/home\/(reel-[a-z-]+)-(\d+)\.mp4/.exec(r.url());
        if (m) asked.push({ name: m[1], w: Number(m[2]), t: Date.now() });
      });
      await page.addInitScript(watchReel);
      await open(page);
      // The still: the first clip's first frame, framed as its clip is.
      const still = await page.evaluate(() => {
        const img = document.querySelector("#home-bento [data-tile=video] picture img");
        return { src: new URL(img.currentSrc || img.src).pathname.split("/").pop(), pos: getComputedStyle(img).objectPosition };
      });
      check(`reel ${tag}: the still is ${REEL[0]}'s first frame, framed as its clip`, still.src.startsWith(`${REEL_NAME[REEL[0]]}-`) && /^reel-[a-z-]+-\d+\.(avif|jpg)$/.test(still.src) && still.pos === REEL_POSITION[REEL[0]], JSON.stringify(still));
      // Round the reel once and into the first clip again, a picture of each clip as it plays.
      const seen = [];
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        const turns = await page.evaluate(() => window.__reel.turns.map((x) => x.i));
        for (const i of turns.slice(seen.length)) {
          seen.push(i);
          if (seen.length > REEL.length) continue;
          // Halfway through the clip: well after its fade in.
          await page.waitForTimeout(1600);
          const now = await page.evaluate(() => {
            const vids = [...document.querySelectorAll("#home-bento [data-tile=video] video")];
            const shown = vids.filter((x) => x.hasAttribute("data-ready"));
            const top = shown[0];
            return top ? { clip: top.dataset.clip, pos: getComputedStyle(top).objectPosition, w: top.videoWidth, paused: top.paused, t: top.currentTime } : null;
          });
          check(`reel ${tag}: clip ${Number(i) + 1} is ${REEL[i]}, playing, framed ${REEL_POSITION[REEL[i]]}`, now?.clip === REEL[i] && now.pos === REEL_POSITION[REEL[i]] && !now.paused, JSON.stringify(now));
          if (shotsDir) await page.locator("#home-bento [data-tile=video]").screenshot({ path: path.join(shotsDir, `reel-${v.w}-${scheme}-${Number(i) + 1}-${REEL[i]}.png`) });
        }
        if (seen.length > REEL.length) break;
        await page.waitForTimeout(150);
      }
      const r = await page.evaluate(() => window.__reel);
      check(`reel ${tag}: plays the clips in order and back to the first`, seen.join() === [...REEL.keys(), 0].join(), seen.join());
      check(`reel ${tag}: each clip crossfades into the next`, r.fades >= REEL.length, `${r.fades} frames mid-fade`);
      check(`reel ${tag}: the clip going out never jumps back under the fade`, r.back.length === 0, JSON.stringify(r.back.slice(0, 3)));
      check(`reel ${tag}: never more than the clip playing and the next one`, r.most <= 2, String(r.most));
      // Each clip asked for only once the one before it plays; at most one ahead of the clip on screen.
      const order = asked.map((a) => a.name);
      const firstAsk = (name) => asked.find((a) => a.name === name)?.t;
      const names = REEL.map((id) => REEL_NAME[id]);
      const aheadOk = names.slice(1).every((name, i) => {
        const t = firstAsk(name);
        const prevPlays = r.playing[`${REEL[i]}@${i}`];
        return t !== undefined && prevPlays !== undefined && t >= prevPlays - 100;
      });
      check(`reel ${tag}: each clip loads only once the one before it plays`, aheadOk, `asked ${order.join(" ")}; playing ${JSON.stringify(r.playing)}`);
      const widths = [...new Set(asked.map((a) => `${a.name}-${a.w}`))];
      notes.push(`reel ${tag}: ${widths.join(", ")}`);
      // Off screen it pauses; back on screen it goes on.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(900);
      const off = await page.evaluate(() => [...document.querySelectorAll("#home-bento [data-tile=video] video")].map((x) => x.paused));
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(1500);
      const on = await page.evaluate(() => [...document.querySelectorAll("#home-bento [data-tile=video] video[data-ready]")].map((x) => x.paused));
      check(`reel ${tag}: pauses off screen, plays again in view`, off.length > 0 && off.every(Boolean) && on.some((p) => !p), `off ${off} on ${on}`);
      await ctx.close();
    }

  // Reduced motion: nothing plays by itself; a hover plays the first clip alone, on a loop.
  const ctx = await browser.newContext({ ...DESKTOP, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  const asked = [];
  page.on("request", (r) => /\/previews\/home\/reel-/.test(r.url()) && r.url().includes(".mp4") && asked.push(new URL(r.url()).pathname.split("/").pop()));
  await open(page);
  await page.waitForTimeout(2500);
  const before = asked.length;
  await page.locator("#home-bento [data-tile=video]").hover();
  await page.waitForTimeout(6500);
  const st = await page.evaluate(() => [...document.querySelectorAll("#home-bento [data-tile=video] video")].map((x) => ({ clip: x.dataset.clip, loop: x.loop, paused: x.paused })));
  check(
    `reduced motion: no reel clip until asked; a hover plays ${REEL[0]} alone, on a loop`,
    before === 0 && st.length === 1 && st[0].clip === REEL[0] && st[0].loop && !st[0].paused && asked.every((a) => a.startsWith(`${REEL_NAME[REEL[0]]}-`)),
    JSON.stringify({ before, st, asked }),
  );
  await ctx.close();
}

// ------------------------------------------------------------------------------------------- 1e. a late or failed clip
/**
 * Logs the reel's picture a frame at a time from the first paint: the clip on top (the last one shown), its time, and
 * how long the picture has stayed the same; every time the clip on screen changes, where the clip going out was.
 */
const watchStill = () => {
  window.__still = { longest: 0, since: 0, sig: "", samples: [], turns: [] };
  const look = () => {
    const span = document.querySelector("#home-bento [data-tile=video] .hb-clip");
    const vids = span ? [...span.querySelectorAll("video[data-ready]")] : [];
    const top = vids.at(-1);
    const now = performance.now();
    const w = window.__still;
    if (top) {
      const sig = `${top.dataset.clip}@${top.currentTime.toFixed(3)}`;
      if (sig !== w.sig) {
        w.sig = sig;
        w.since = now;
      } else w.longest = Math.max(w.longest, now - w.since);
      if (vids.length > 1 && w.turns.at(-1)?.to !== top.dataset.clip)
        w.turns.push({ from: vids[0].dataset.clip, to: top.dataset.clip, at: vids[0].currentTime, of: vids[0].duration });
      if (w.samples.length < 2000) w.samples.push({ t: Math.round(now), clip: top.dataset.clip, ct: top.currentTime, n: span.querySelectorAll("video").length, loop: top.loop });
    }
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
};
if (run("1e") && ENGINE === "chromium") {
  const second = REEL_NAME[REEL[1]];
  for (const mode of ["fails", "late"]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.route(new RegExp(`/previews/home/${second}-\\d+\\.mp4`), async (route) => {
      if (mode === "fails") return route.abort("failed");
      await new Promise((r) => setTimeout(r, 6000));
      return route.continue().catch(() => {});
    });
    await page.addInitScript(watchStill);
    await open(page);
    await page.waitForTimeout(mode === "fails" ? 14_000 : 22_000);
    const w = await page.evaluate(() => window.__still);
    const last = w.samples.slice(-40);
    const moving = last.length > 1 && last.at(-1).ct !== last[0].ct;
    if (mode === "fails") {
      check(
        `reel when ${REEL[1]} fails: ${REEL[0]} loops alone and never stops on a frame`,
        moving && last.every((x) => x.clip === REEL[0] && x.n === 1 && x.loop) && w.longest < 700,
        `longest still ${Math.round(w.longest)} ms; last ${JSON.stringify(last.at(-1))}`,
      );
    } else {
      const into = w.turns.find((x) => x.to === REEL[1]);
      check(
        `reel when ${REEL[1]} is 6 s late: never stuck on one frame past ${REEL_STALL_MS} ms and a little`,
        moving && w.longest < REEL_STALL_MS + 800,
        `longest still ${Math.round(w.longest)} ms`,
      );
      check(
        `reel when ${REEL[1]} is 6 s late: it still comes in, and every clip comes in at the end of a pass of the one before`,
        !!into && into.from === REEL[0] && w.turns.every((x) => x.at >= x.of - 0.8),
        JSON.stringify(w.turns),
      );
    }
    await ctx.close();
  }
}

// ------------------------------------------------------------------------------------------- 1f. Genjutsu's swaps
/**
 * The Genjutsu tile's reel (HOME_BENTO_GENJUTSU, read from src/lib/home-bento.generated.ts): each clip's copies' name,
 * its labels, and where its divider is on each frame.
 */
const GENJUTSU = JSON.parse(/export const HOME_BENTO_GENJUTSU = (\[[\s\S]*?\]);\r?\n/.exec(fs.readFileSync(path.join(root, "src/lib/home-bento.generated.ts"), "utf8"))[1]);
/**
 * Logs the Genjutsu tile's reel from the first paint: the clip on screen each time it changes, the most clips it holds
 * at once, when each first plays, and every moment the clip coming in shows over the one going out (with where that
 * one is: it must be on its dark last frames by then).
 */
const watchWipe = () => {
  window.__gj = { turns: [], most: 0, overlap: [], playing: {} };
  const look = () => {
    const span = document.querySelector("#home-bento [data-tile=genjutsu] .hb-clip");
    const g = window.__gj;
    if (span) {
      const at = span.dataset.reel;
      if (at !== undefined && g.turns.at(-1)?.i !== at) g.turns.push({ i: at, t: Date.now() });
      const vids = [...span.querySelectorAll("video")];
      g.most = Math.max(g.most, vids.length);
      for (const v of vids) if (!v.paused && !g.playing[v.dataset.clip]) g.playing[v.dataset.clip] = Date.now();
      // The time of the frame each clip has on screen (its own clock runs a little ahead of what is shown).
      for (const v of vids)
        if (!v.__watched && v.requestVideoFrameCallback) {
          v.__watched = true;
          const onFrame = (_, m) => {
            v.__presented = m.mediaTime;
            v.requestVideoFrameCallback(onFrame);
          };
          v.requestVideoFrameCallback(onFrame);
        }
      const shown = vids.filter((v) => v.hasAttribute("data-ready"));
      if (shown.length > 1) {
        const o = Number(getComputedStyle(shown.at(-1)).opacity);
        if (o > 0.02 && g.overlap.length < 400) g.overlap.push({ clip: shown[0].dataset.clip, t: shown[0].currentTime, ended: shown[0].ended, over: o });
      }
    }
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
};
/** The tile, its words and its clip as they are now, each word's box measured from the tile's padding box. */
const wipeState = (page) =>
  page.evaluate(() => {
    const tile = document.querySelector("#home-bento [data-tile=genjutsu]");
    const wipe = tile.querySelector(".hb-wipe");
    const r = tile.getBoundingClientRect();
    const x0 = r.left + tile.clientLeft;
    const box = (sel) => {
      const b = wipe.querySelector(sel).getBoundingClientRect();
      return { l: b.left - x0, r: b.right - x0, text: wipe.querySelector(sel).textContent };
    };
    const shown = [...tile.querySelectorAll("video[data-ready]")];
    const top = shown.at(-1);
    const img = tile.querySelector("picture img");
    return {
      W: tile.clientWidth,
      H: tile.clientHeight,
      lg: innerWidth >= 1024,
      clip: top?.dataset.clip,
      t: top ? (top.__presented ?? top.currentTime) : undefined,
      paused: top?.paused,
      n: shown.length,
      x: wipe.style.getPropertyValue("--x") === "" ? null : Number(wipe.style.getPropertyValue("--x")),
      cssX: Number(getComputedStyle(wipe).getPropertyValue("--x")),
      out: wipe.hasAttribute("data-out"),
      opacity: Number(getComputedStyle(wipe).opacity),
      before: box("[class~=hb-wipe-before]"),
      after: box("[class~=hb-wipe-after]"),
      still: new URL(img.currentSrc || img.src).pathname.split("/").pop(),
    };
  });
/** Where the words should be with the divider at `x` (a share of the clip's width), in a W x H tile (home-bento.css). */
const wipeExpect = ({ W, H, lg }, x) => {
  const fw = lg ? Math.max(W, (H * 4) / 3) : W;
  const lx = x * fw - (fw - W) / 2;
  const [pad, gap] = W >= 340 ? [16, 9] : [12, 8];
  return { beforeL: Math.max(pad, lx + gap), afterR: Math.min(W - pad, lx - gap) };
};
const wipeFrameAt = (c, t) => Math.min(c.line.length - 1, Math.max(0, Math.floor(t * c.fps + 0.01)));
if (run("1f")) {
  for (const [v, dpr, scheme] of [
    [WIDTHS[0], 3, "light"],
    [WIDTHS[4], 2, "light"],
    [WIDTHS[4], 2, "dark"],
  ]) {
    const tag = `${v.w}@${dpr}x ${scheme}`;
    const ctx = await browser.newContext({ ...(v.phone ? PHONE : {}), viewport: { width: v.w, height: v.h }, deviceScaleFactor: dpr, colorScheme: scheme });
    const page = await ctx.newPage();
    const asked = [];
    page.on("request", (r) => {
      const m = /\/previews\/home\/(genjutsu-[a-z]+)-(\d+)\.mp4/.exec(r.url());
      if (m) asked.push({ name: m[1], w: Number(m[2]), t: Date.now() });
    });
    await page.addInitScript(watchWipe);
    await open(page);
    // A phone's Genjutsu tile is under the live tile: it plays once it is on screen.
    await page.locator("#home-bento [data-tile=genjutsu]").scrollIntoViewIfNeeded();
    const first = await wipeState(page);
    check(
      `genjutsu ${tag}: the still is ${GENJUTSU[0].name}'s first frame, "${GENJUTSU[0].labels[0]}" on it at the left`,
      first.still.startsWith(`${GENJUTSU[0].name}-`) && !first.still.includes("split") && first.before.text === GENJUTSU[0].labels[0] && first.before.l < 20 && first.after.r <= 0,
      JSON.stringify(first),
    );
    // Round the reel once and into its first clip again, sampling the words against the clip as it plays.
    const off = [];
    const frames = [];
    let samples = 0;
    const deadline = Date.now() + 32_000;
    let shot = 0;
    while (Date.now() < deadline) {
      const st = await wipeState(page);
      const turns = await page.evaluate(() => window.__gj.turns.map((x) => x.i));
      if (turns.length > GENJUTSU.length) break;
      const c = GENJUTSU.find((g) => g.name === st.clip);
      if (c && st.n === 1 && !st.paused && st.x !== null && !st.out) {
        samples++;
        const f = wipeFrameAt(c, st.t);
        // The words are a frame behind the clip at most (they move on the frame the browser presents).
        const near = [f - 1, f, f + 1].filter((i) => i >= 0 && i < c.line.length).some((i) => Math.abs(c.line[i] - st.x) < 0.0002);
        const e = wipeExpect(st, st.x);
        const placed = Math.abs(st.before.l - e.beforeL) < 1.5 && Math.abs(st.after.r - e.afterR) < 1.5;
        if (!near || !placed) off.push({ clip: st.clip, t: +st.t.toFixed(3), f, x: st.x, want: c.line[f], before: Math.round(st.before.l), wantBefore: Math.round(e.beforeL), after: Math.round(st.after.r), wantAfter: Math.round(e.afterR) });
      }
      if (shotsDir && Date.now() >= shot) {
        shot = Date.now() + 380;
        const f = path.join(shotsDir, `genjutsu-${v.w}-${scheme}-${String(frames.length).padStart(2, "0")}.png`);
        await page.locator("#home-bento [data-tile=genjutsu]").screenshot({ path: f });
        frames.push(f);
      } else await page.waitForTimeout(60);
    }
    const g = await page.evaluate(() => window.__gj);
    const seen = g.turns.map((x) => Number(x.i));
    check(`genjutsu ${tag}: plays its clips in order and back to the first`, seen.join() === [...GENJUTSU.keys(), 0].join(), seen.join());
    check(`genjutsu ${tag}: the words ride with the divider on every frame`, samples > 40 && off.length === 0, `${samples} samples; ${JSON.stringify(off.slice(0, 4))}`);
    check(
      `genjutsu ${tag}: a clip comes in only over the last one's dark end (no two faces at once)`,
      g.overlap.length > 0 && g.overlap.every((o) => o.ended || o.t >= 130 / 24),
      JSON.stringify(g.overlap.filter((o) => !(o.ended || o.t >= 130 / 24)).slice(0, 3)) + ` of ${g.overlap.length}`,
    );
    check(`genjutsu ${tag}: never more than the clip playing and the next one`, g.most <= 2, String(g.most));
    const firstAsk = (name) => asked.find((a) => a.name === name)?.t;
    const nextOk = GENJUTSU.slice(1).every((c, i) => firstAsk(c.name) !== undefined && g.playing[GENJUTSU[i].name] !== undefined && firstAsk(c.name) >= g.playing[GENJUTSU[i].name] - 100);
    check(`genjutsu ${tag}: each clip loads only once the one before it plays`, nextOk, `asked ${asked.map((a) => `${a.name}-${a.w}`).join(" ")}; playing ${JSON.stringify(g.playing)}`);
    notes.push(`genjutsu ${tag}: ${[...new Set(asked.map((a) => `${a.name}-${a.w}`))].join(", ")}; ${frames.length} frames shot`);
    if (frames.length) {
      const sharp = createRequire(path.join(root, "package.json"))("sharp");
      const W = v.phone ? 300 : 260;
      const bufs = await Promise.all(frames.map((f) => sharp(f).resize({ width: W }).png().toBuffer({ resolveWithObject: true })));
      const h = Math.max(...bufs.map((b) => b.info.height));
      const cols = 6;
      const rows = Math.ceil(bufs.length / cols);
      await sharp({ create: { width: cols * (W + 6) + 6, height: rows * (h + 6) + 6, channels: 3, background: "#777" } })
        .composite(bufs.map((b, i) => ({ input: b.data, left: 6 + (i % cols) * (W + 6), top: 6 + Math.floor(i / cols) * (h + 6) })))
        .jpeg({ quality: 85 })
        .toFile(path.join(shotsDir, `genjutsu-${v.w}-${scheme}-loop.jpg`));
    }
    await ctx.close();
  }

  // Reduced motion: the still is the couple at rest half way, "Original" and "Swapped" either side of the divider.
  for (const [v, dpr] of [
    [WIDTHS[0], 3],
    [WIDTHS[4], 2],
  ]) {
    const ctx = await browser.newContext({ ...(v.phone ? PHONE : {}), viewport: { width: v.w, height: v.h }, deviceScaleFactor: dpr, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await open(page);
    await page.locator("#home-bento [data-tile=genjutsu]").scrollIntoViewIfNeeded();
    await page.waitForTimeout(1200);
    const st = await wipeState(page);
    const e = wipeExpect(st, 0.5);
    check(
      `genjutsu reduced motion ${v.w}@${dpr}x: the still is split half way, the words either side of it`,
      st.still.startsWith(`${GENJUTSU[0].name}-split-`) && st.cssX === 0.5 && Math.abs(st.before.l - e.beforeL) < 1.5 && Math.abs(st.after.r - e.afterR) < 1.5 && st.n === 0,
      JSON.stringify(st),
    );
    if (shotsDir) await page.locator("#home-bento [data-tile=genjutsu]").screenshot({ path: path.join(shotsDir, `genjutsu-${v.w}-reduced.png`) });
    await ctx.close();
  }
}

// ------------------------------------------------------------------------------------------- 2. layout shift
async function cls(v) {
  const ctx = await browser.newContext(viewportOpts(v));
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__cls = 0;
    window.__shifts = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        if (!e.hadRecentInput) {
          window.__cls += e.value;
          window.__shifts.push({ v: e.value, at: Math.round(e.startTime), nodes: (e.sources ?? []).map((s) => s.node?.id || s.node?.className?.toString?.().slice(0, 60) || s.node?.nodeName) });
        }
    }).observe({ type: "layout-shift", buffered: true });
  });
  await open(page);
  await page.waitForTimeout(2500);
  const firstScreen = await page.evaluate(() => window.__cls);
  // Down the page and back, a screen at a time (the sections under it are laid out as they come near).
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += v.h * 0.8) {
    await page.evaluate((y) => window.scrollTo(0, y), y);
    await page.waitForTimeout(120);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);
  const all = await page.evaluate(() => ({ cls: window.__cls, shifts: window.__shifts }));
  await ctx.close();
  return { firstScreen, ...all };
}
if (run("2"))
  for (const v of [WIDTHS[0], WIDTHS[4]]) {
    const r = await cls(v);
    check(`layout shift at ${v.w}: first screen ${r.firstScreen.toFixed(4)}, whole page ${r.cls.toFixed(4)}`, r.firstScreen < 0.01, JSON.stringify(r.shifts.slice(0, 4)));
    notes.push(`CLS ${v.w}: first screen ${r.firstScreen.toFixed(4)}, through a scroll ${r.cls.toFixed(4)}`);
  }

// ------------------------------------------------------------------------------------------- 2b. the headline holds still
/**
 * A proxy in front of the app that hands Home's HTML over in two parts, the first ending right after the second line's
 * first words ("From an idea to a"), with `pauseMs` between them, as a slow network can cut it. Everything else passes
 * straight through.
 */
async function splittingProxy(pauseMs) {
  const http = await import("node:http");
  const target = new URL(app);
  // The app over HTTPS (a live check) is asked over HTTPS; the proxy itself stays plain HTTP on localhost.
  const upstream = target.protocol === "https:" ? await import("node:https") : http;
  const server = http.createServer((req, res) => {
    const up = upstream.request(
      // No kept-alive sockets (agent: false), so nothing holds the script open once the proxy closes.
      { host: target.hostname, port: target.port, path: req.url, method: req.method, agent: false, headers: { ...req.headers, host: target.host, connection: "close", "accept-encoding": "identity" } },
      (upRes) => {
        const isHome = req.method === "GET" && new URL(req.url, app).pathname === "/" && /text\/html/.test(upRes.headers["content-type"] ?? "");
        if (!isHome) {
          res.writeHead(upRes.statusCode, upRes.headers);
          return void upRes.pipe(res);
        }
        const parts = [];
        upRes.on("data", (c) => parts.push(c));
        upRes.on("end", () => {
          const html = Buffer.concat(parts).toString("utf8");
          const at = html.indexOf(">", html.indexOf('class="hb-line2"')) + 1;
          const cut = html.startsWith("From an idea to a", at) ? at + "From an idea to a".length : -1;
          const headers = { ...upRes.headers };
          delete headers["content-length"];
          delete headers["content-encoding"];
          res.writeHead(upRes.statusCode, headers);
          if (cut < 0) return void res.end(html); // not the markup this check knows: sent whole (the check below then fails)
          res.write(html.slice(0, cut));
          server.cut = true;
          setTimeout(() => res.end(html.slice(cut)), pauseMs);
        });
      },
    );
    up.on("error", () => res.destroy());
    // A request the browser drops (a clip still streaming as the context closes) ends its upstream request too.
    res.on("close", () => up.destroy());
    req.pipe(up);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  server.url = `http://127.0.0.1:${server.address().port}`;
  return server;
}

/** Every layout shift that moves something in the headline, from the first paint. */
const watchHeadline = () => {
  window.__headShifts = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      const h1 = document.querySelector("#home-bento h1");
      const moved = (e.sources ?? []).filter((s) => h1 && s.node && h1.contains(s.node));
      if (moved.length)
        window.__headShifts.push({
          v: +e.value.toFixed(4),
          at: Math.round(e.startTime),
          what: moved.map((s) => `${(s.node.nodeType === 3 ? s.node.parentElement : s.node).className} ${Math.round(s.previousRect.x)},${Math.round(s.previousRect.y)} -> ${Math.round(s.currentRect.x)},${Math.round(s.currentRect.y)}`),
        });
    }
  }).observe({ type: "layout-shift", buffered: true });
};

/** The headline's picture once everything is in and still (its rise and glow are over). */
async function headlineShot(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(2200);
  return page.locator("#home-bento h1").screenshot();
}

if (run("2b") && ENGINE === "chromium") {
  const sharp = createRequire(path.join(root, "package.json"))("sharp");
  const diff = async (a, b) => {
    const [x, y] = await Promise.all([a, b].map((p) => sharp(p).removeAlpha().raw().toBuffer({ resolveWithObject: true })));
    if (x.info.width !== y.info.width || x.info.height !== y.info.height) return { size: `${x.info.width}x${x.info.height} vs ${y.info.width}x${y.info.height}`, mean: 255 };
    let sum = 0;
    for (let i = 0; i < x.data.length; i++) sum += Math.abs(x.data[i] - y.data[i]);
    return { mean: sum / x.data.length };
  };
  const holdFonts = (page, ms) =>
    page.route(/\.woff2(\?|$)/, async (r) => {
      await new Promise((x) => setTimeout(x, ms));
      await r.continue().catch(() => {});
    });
  const FONT_LATE_MS = 2500;
  const HTML_PAUSE_MS = 1500;
  for (const v of [WIDTHS[0], WIDTHS[1], WIDTHS[4]]) {
    const tag = `${v.w}@${v.phone ? 3 : v.w >= 1440 ? 2 : 1}x`;
    // As it looks on a quick load.
    const ctx0 = await browser.newContext(viewportOpts(v, { colorScheme: "dark" }));
    const p0 = await ctx0.newPage();
    await open(p0);
    const before = await headlineShot(p0);
    await ctx0.close();

    // a) Every font file FONT_LATE_MS late.
    const ctx1 = await browser.newContext(viewportOpts(v, { colorScheme: "dark" }));
    const p1 = await ctx1.newPage();
    await p1.addInitScript(watchHeadline);
    await holdFonts(p1, FONT_LATE_MS);
    await open(p1);
    await p1.waitForTimeout(FONT_LATE_MS + 800);
    const late = await p1.evaluate(() => ({
      shifts: window.__headShifts,
      italic: [...document.fonts].some((f) => f.family.replace(/"/g, "") === "Instrument Serif" && f.style === "italic" && f.status === "loaded"),
      // The italic fallback face (globals.css) joins next/font's fallback family, so it must keep that family's name.
      fallbackItalic: [...document.fonts].some((f) => f.family.replace(/"/g, "") === "Instrument Serif Fallback" && f.style === "italic"),
    }));
    const lateShot = await headlineShot(p1);
    await ctx1.close();
    check(`headline at ${tag}, fonts ${FONT_LATE_MS} ms late: nothing in it shifts`, late.shifts.length === 0 && late.italic, JSON.stringify(late.shifts.slice(0, 3)));
    check(`headline at ${tag}: the italic fallback face is in next/font's fallback family`, late.fallbackItalic);
    const d1 = await diff(before, lateShot);
    check(`headline at ${tag}, fonts late: looks as on a quick load`, d1.mean < 1, d1.size ?? `mean difference ${d1.mean.toFixed(2)} of 255`);

    // b) The HTML in two parts (cut after "From an idea to a", HTML_PAUSE_MS apart) and the fonts 1.5 s late.
    const proxy = await splittingProxy(HTML_PAUSE_MS);
    const ctx2 = await browser.newContext(viewportOpts(v, { colorScheme: "dark" }));
    const p2 = await ctx2.newPage();
    await p2.addInitScript(watchHeadline);
    await holdFonts(p2, 1500);
    await p2.goto(proxy.url + "/", { waitUntil: "commit", timeout: 90_000 });
    // Mid-pause: the second line is cut short, and kept unseen.
    await p2.waitForSelector("#home-bento .hb-line2", { state: "attached", timeout: 20_000 });
    await p2.waitForTimeout(HTML_PAUSE_MS / 3);
    const mid = await p2.evaluate(() => {
      const l2 = document.querySelector("#home-bento .hb-line2");
      return { whole: !!l2.querySelector(".hb-end"), text: l2.textContent.trim(), visibility: getComputedStyle(l2).visibility };
    });
    await p2.waitForLoadState("load", { timeout: 90_000 });
    await p2.waitForTimeout(2300);
    const split = await p2.evaluate(() => window.__headShifts);
    const splitShot = await headlineShot(p2);
    await ctx2.close();
    proxy.closeAllConnections();
    await new Promise((r) => proxy.close(r));
    check(
      `headline at ${tag}, HTML in two parts: the cut second line stays unseen until whole`,
      proxy.cut && !mid.whole && mid.text === "From an idea to a" && mid.visibility === "hidden",
      JSON.stringify({ cut: !!proxy.cut, ...mid }),
    );
    check(`headline at ${tag}, HTML in two parts and fonts late: nothing in it shifts`, split.length === 0, JSON.stringify(split.slice(0, 3)));
    const d2 = await diff(before, splitShot);
    check(`headline at ${tag}, HTML in two parts: looks as on a quick load`, d2.mean < 1, d2.size ?? `mean difference ${d2.mean.toFixed(2)} of 255`);
    if (shotsDir) for (const [n, b] of [["quick", before], ["fonts-late", lateShot], ["html-parts", splitShot]]) fs.writeFileSync(path.join(shotsDir, `headline-${tag}-${n}.png`), b);
  }
}

// ------------------------------------------------------------------------------------------- 3. links
if (run("3")) {
  const ctx = await browser.newContext(DESKTOP);
  const page = await ctx.newPage();
  await open(page);
  // Each tile's link: the tile itself, or (the Audio tile) the link inside it.
  const hrefs = await page.$$eval("#home-bento [data-tile]", (els) => els.map((el) => [el.dataset.tile, (el.matches("a") ? el : el.querySelector("a[href]"))?.getAttribute("href") ?? ""]));
  check("eight tiles, in the grid's reading order", hrefs.map((h) => h[0]).join() === TILES.join(), hrefs.map((h) => h[0]).join());
  for (const [tile, href] of hrefs) {
    if (href.startsWith("#")) {
      check(`${tile}: ${href} is on the page`, (await page.locator(href).count()) === 1);
      continue;
    }
    const r = await ctx.request.get(app + href, { maxRedirects: 5 });
    check(`${tile}: ${href} answers ${r.status()}`, r.status() === 200);
  }
  await page.locator('#home-bento [data-tile="numbers"]').click();
  await page.waitForTimeout(600);
  check("the numbers tile opens every studio (the launcher)", (await page.locator('section[aria-label="All studios"]:visible').count()) > 0 && page.url() === `${app}/`, page.url());
  await ctx.close();

  const phone = await browser.newContext(PHONE);
  const pp = await phone.newPage();
  await open(pp);
  await pp.locator('#home-bento [data-tile="numbers"]').scrollIntoViewIfNeeded();
  await pp.locator('#home-bento [data-tile="numbers"]').click();
  await pp.waitForTimeout(700);
  check("on a phone, the numbers tile opens the Studios sheet", (await pp.locator('[role="dialog"]:visible').count()) > 0);
  await phone.close();
}

// ------------------------------------------------------------------------------------------- 4. reduced motion, Save-Data
if (run("4")) {
  const ctx = await browser.newContext({ ...DESKTOP, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  const clips = [];
  page.on("request", (r) => r.url().includes(".mp4") && clips.push(r.url()));
  await open(page);
  await page.waitForTimeout(3000);
  const pill = () => page.locator("#home-bento [data-tile=live]").innerText();
  const a = await pill();
  await page.waitForTimeout(1000);
  const b = await pill();
  const state = await page.evaluate(() => ({
    play: document.getElementById("home-bento").dataset.play ?? null,
    videos: [...document.querySelectorAll("#home-bento video")].filter((v) => v.getAttribute("src") && !v.paused).length,
    headline: document.querySelector("#home-bento h1").parentElement.getAnimations({ subtree: true }).length,
  }));
  check("reduced motion: nothing moves by itself", state.play === null && state.videos === 0 && clips.length === 0 && state.headline === 0, JSON.stringify({ ...state, clips: clips.length }));
  check("reduced motion: the live words stay", a === b, `${JSON.stringify(a)} / ${JSON.stringify(b)}`);
  await ctx.close();

  // The Save-Data header: through DevTools in Chromium, as the context's own header elsewhere (no DevTools session).
  const sd = await browser.newContext(ENGINE === "chromium" ? DESKTOP : { ...DESKTOP, extraHTTPHeaders: { "Save-Data": "on" } });
  await sd.addInitScript(() => Object.defineProperty(navigator, "connection", { value: { saveData: true, effectiveType: "4g", addEventListener() {} }, configurable: true }));
  const sp = await sd.newPage();
  if (ENGINE === "chromium") {
    const cdp = await sd.newCDPSession(sp);
    await cdp.send("Network.enable");
    await cdp.send("Network.setExtraHTTPHeaders", { headers: { "Save-Data": "on" } });
  }
  const sdClips = [];
  sp.on("request", (r) => r.url().includes(".mp4") && sdClips.push(r.url()));
  await open(sp);
  await sp.waitForTimeout(3500);
  const sdPlay = await sp.evaluate(() => document.getElementById("home-bento").dataset.play ?? null);
  check("Save-Data: no clip fetched, nothing moves", sdClips.length === 0 && sdPlay === null, `${sdClips.length} clips, play=${sdPlay}`);
  await sd.close();
}

// ------------------------------------------------------------------------------------------- 5. pause previews
if (run("5")) {
  const ctx = await browser.newContext(DESKTOP);
  const page = await ctx.newPage();
  await open(page);
  const playing = () =>
    page.evaluate(() => {
      const v = document.querySelector("#home-bento [data-tile=video] video");
      return v ? { paused: v.paused, t: v.currentTime } : null;
    });
  await page.waitForFunction(() => {
    const v = document.querySelector("#home-bento [data-tile=video] video");
    return v && !v.paused && v.currentTime > 0.2;
  }, null, { timeout: 8000 }).catch(() => {});
  const before = await playing();
  check("the reel plays by itself", !!before && !before.paused, JSON.stringify(before));
  await page.getByRole("button", { name: "Pause previews" }).click();
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    v: document.querySelector("#home-bento [data-tile=video] video")?.paused,
    play: document.getElementById("home-bento").dataset.play,
    running: document.getElementById("home-bento").getAnimations({ subtree: true }).filter((a) => a.playState === "running").length,
  }));
  check("Pause previews stops the clip and freezes the tiles", after.v === true && after.play === "0" && after.running === 0, JSON.stringify(after));
  const live1 = await page.locator("#home-bento [data-tile=live]").innerText();
  await page.waitForTimeout(800);
  check("paused, the live words stop", live1 === (await page.locator("#home-bento [data-tile=live]").innerText()));
  await page.getByRole("button", { name: "Play previews" }).click();
  await page.waitForTimeout(1500);
  const again = await page.evaluate(() => ({
    v: document.querySelector("#home-bento [data-tile=video] video")?.paused,
    play: document.getElementById("home-bento").dataset.play,
  }));
  check("Play previews starts them again", again.v === false && again.play === "1", JSON.stringify(again));
  await ctx.close();
}

// ------------------------------------------------------------------------------------------- 6. weight
async function weight(v) {
  const ctx = await browser.newContext(viewportOpts(v));
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  const reqs = new Map();
  let loaded = false;
  // The clips come once their stills are up: every byte of a video response, counted as it arrives (a clip may come in ranges).
  const clips = new Map();
  cdp.on("Network.responseReceived", (e) => reqs.set(e.requestId, { url: e.response.url, type: e.type, mime: e.response.mimeType, bytes: 0, done: false }));
  cdp.on("Network.dataReceived", (e) => {
    const r = reqs.get(e.requestId);
    if (r?.mime.startsWith("video/")) clips.set(r.url, (clips.get(r.url) ?? 0) + e.encodedDataLength);
  });
  cdp.on("Network.loadingFinished", (e) => {
    const r = reqs.get(e.requestId);
    if (r && !loaded) Object.assign(r, { bytes: e.encodedDataLength, done: true });
  });
  await page.goto(app + "/", { waitUntil: "load", timeout: 90_000 });
  loaded = true;
  await page.waitForTimeout(300);
  // The first screen's own pictures: the tiles' stills (anything else is the page's, below it).
  const ownUrls = new Set(await page.evaluate(() => [...document.querySelectorAll("#home-bento img")].map((i) => new URL(i.currentSrc || i.src, location.href).pathname)));
  // Then the clips, until both tiles have theirs whole (or 15 s).
  await page
    .waitForFunction(
      () => {
        const v = [...document.querySelectorAll("#home-bento [data-tile] video")];
        return v.length >= 2 && v.every((x) => x.readyState >= 4 && x.buffered.length > 0 && x.buffered.end(0) >= x.duration - 0.05);
      },
      null,
      { timeout: 15_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(500);
  const by = {};
  let total = 0;
  let own = 0;
  const media = [];
  for (const r of reqs.values()) {
    if (!r.done || r.mime.startsWith("video/")) continue;
    const kind = r.type === "Document" ? "html" : r.type === "Stylesheet" ? "css" : r.type === "Script" ? "js" : r.type === "Font" ? "fonts" : r.type === "Image" ? "images" : "other";
    by[kind] = (by[kind] ?? 0) + r.bytes;
    total += r.bytes;
    const pathname = new URL(r.url).pathname;
    if (kind === "images" && ownUrls.has(pathname)) {
      own += r.bytes;
      media.push(`${pathname} ${(r.bytes / 1024).toFixed(1)}`);
    }
  }
  await ctx.close();
  const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
  const clipBytes = [...clips.values()].reduce((a, b) => a + b, 0);
  const clipLine = [...clips].map(([u, n]) => `${new URL(u).pathname.split("/").pop()} ${kb(n)}`).join(" · ");
  return {
    total,
    own,
    clipBytes,
    line: `${v.w}@${viewportOpts(v).deviceScaleFactor}x: ${kb(total)} (${Object.entries(by).map(([k, n]) => `${k} ${kb(n)}`).join(", ")}); the first screen's own stills ${kb(own)}; clips ${kb(clipBytes)} (${clipLine || "none"})`,
    media,
  };
}
// The weight is read through DevTools: Chromium only.
if ((weightOnly || run("6")) && ENGINE === "chromium")
for (const v of [WIDTHS[0], WIDTHS[3], WIDTHS[4], WIDTHS[5]]) {
  const r = await weight(v);
  // The whole page's total is reported (main's own script and fonts are most of it: compare with --weight-only on
  // main's build); the first screen's own stills have a budget of their own.
  check(`weight before load, clips aside: ${r.line}`, weightOnly || r.own < 420 * 1024);
  notes.push(`weight ${r.line}`);
  notes.push(`  first screen's stills: ${r.media.join(" · ")}`);
}

// ------------------------------------------------------------------------------------------- 7. composer
if (run("7")) {
  const ctx = await browser.newContext(DESKTOP);
  const page = await ctx.newPage();
  await open(page);
  await page.waitForTimeout(1500);
  check("a plain visit stays at the top (no autofocus jump)", (await page.evaluate(() => scrollY)) === 0);
  await open(page, "/?new=1");
  await page.waitForTimeout(1500);
  const c = await page.evaluate(() => {
    const t = document.querySelector('textarea[aria-label="Describe what to create"]');
    const r = t.getBoundingClientRect();
    return { focused: document.activeElement === t, inView: r.top >= 0 && r.bottom <= innerHeight };
  });
  check("New creation (?new=1) brings the composer into view with the focus", c.focused && c.inView, JSON.stringify(c));
  await ctx.close();
}

// ------------------------------------------------------------------------------------------- 8. names and Tab order
if (run("8")) {
  const ctx = await browser.newContext(DESKTOP);
  const page = await ctx.newPage();
  await open(page);
  const names = await page.$$eval("#home-bento a", (as) => as.map((a) => a.getAttribute("aria-label") ?? a.textContent.trim()));
  check("every link on the first screen has a name", names.length === 8 && names.every((n) => n && n.length > 5), names.join(" | "));
  await page.locator("#home-bento h1").click();
  // The tile each Tab lands in, once per tile (the Audio tile's switch, play button and link are all in it).
  const order = [];
  for (let i = 0; i < 16 && order.length < TILES.length; i++) {
    await page.keyboard.press("Tab");
    const at = await page.evaluate(() => document.activeElement?.closest("[data-tile]")?.dataset.tile ?? document.activeElement?.tagName);
    if (order.at(-1) !== at) order.push(at);
  }
  check("Tab reaches the tiles in reading order", order.join() === TILES.join(), order.join());
  await page.keyboard.press("Shift+Tab");
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement).boxShadow);
  check("a focused tile shows its ring", ring && ring !== "none", ring);
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, "focus-ring-1440.png"), clip: { x: 0, y: 0, width: 1440, height: 900 } });
  await ctx.close();
}

await browser.close();

// ------------------------------------------------------------------------------------------- contact sheet
if (shotsDir && shots.length) {
  const sharp = createRequire(path.join(root, "package.json"))("sharp");
  const W = 480;
  const tiles = await Promise.all(
    shots.map(async (s) => {
      const { data, info } = await sharp(s.f).resize({ width: W }).png().toBuffer({ resolveWithObject: true });
      return { ...s, buf: data, h: info.height };
    }),
  );
  const rows = [];
  for (const who of ["guest", "owner"])
    for (const scheme of ["light", "dark"]) {
      const row = tiles.filter((t) => t.who === who && t.scheme === scheme);
      if (row.length) rows.push(row);
    }
  const rowH = rows.map((r) => Math.max(...r.map((t) => t.h)));
  const cols = Math.max(...rows.map((r) => r.length));
  const pad = 12;
  const composite = [];
  let y = pad;
  rows.forEach((r, i) => {
    r.forEach((t, j) => composite.push({ input: t.buf, left: pad + j * (W + pad), top: y }));
    y += rowH[i] + pad;
  });
  await sharp({ create: { width: pad + cols * (W + pad), height: y, channels: 3, background: "#777" } })
    .composite(composite)
    .jpeg({ quality: 82 })
    .toFile(path.join(shotsDir, "contact-sheet.jpg"));
  console.log(`contact sheet: ${path.join(shotsDir, "contact-sheet.jpg")}`);
}

console.log("\n" + [...notes, ...sharpNotes.map((n) => `sharp ${n}`)].join("\n"));
if (failures.length) {
  console.log(`\n${failures.length} failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nall passed");
