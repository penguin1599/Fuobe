// Home's Audio tile in a real browser: Clean up voice's demo, played on Home (src/components/home/bento-voice.tsx, its
// sound in src/components/audio-tools/use-clean-voice-demo.ts). Run it on a production server (`next build`, then
// `next start -p <port>`).
//
// Usage: node tests/e2e/home-voice.mjs [appUrl] [--shots <dir>]   (E2E_BROWSER=webkit or firefox: that engine)
//
// The page's Web Audio is watched from inside (an init script records each AudioContext, gain and source it makes):
// 1. At rest, 1440 x 900 and 390 x 844: no sound, no AudioContext and no clip fetched; the chip says Noisy restaurant,
//    Noise on is pressed, the play button says Tap to listen; on a phone every button is at least 44 px to tap.
// 2. A tap (a click at 1440, a touch at 390): the context runs, both takes start on the same sample, the room heard and
//    her voice silent, each clip fetched once; a few seconds in the noise goes by itself (the gains cross to her voice,
//    the chip says Voice only, the softened photo shows). Noise on and Noise off cross the gains back and forth.
//    Nothing on the first screen shifts while it plays (Chromium).
// 3. Out of view it pauses (the context suspended), and one tap resumes it; a hidden tab pauses it too.
// 4. One sound at a time: a song starting on the page pauses the demo, and the demo resumed pauses the song.
// 5. The keyboard alone: Tab reaches Noise on, Noise off and the play button, each says what it does, Space and Enter
//    work, and the chip's live region says what is heard.
// 6. Reduced motion: it plays, and the photo doesn't move.
import fs from "node:fs";
import path from "node:path";
import { DESKTOP, ENGINE, launch, PHONE } from "./_browser.mjs";

const args = process.argv.slice(2);
const app = (args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--shots") ?? "http://localhost:3620").replace(/\/$/, "");
const shotsDir = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : undefined;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

const failures = [];
const notes = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(`${name} ${detail}`);
};

/** Records the page's Web Audio: each context, gain and buffer source it makes, and when each source starts. */
const watchAudio = () => {
  const AC = window.AudioContext || window.webkitAudioContext;
  window.__audio = { contexts: [], gains: [], sources: [] };
  if (!AC) return;
  const createGain = AC.prototype.createGain;
  AC.prototype.createGain = function () {
    const g = createGain.call(this);
    window.__audio.gains.push(g);
    return g;
  };
  const createBufferSource = AC.prototype.createBufferSource;
  AC.prototype.createBufferSource = function () {
    const src = createBufferSource.call(this);
    const rec = { at: null, stopped: false, duration: 0 };
    const start = src.start.bind(src);
    src.start = (when = 0, ...rest) => {
      rec.at = when;
      rec.duration = src.buffer?.duration ?? 0;
      return start(when, ...rest);
    };
    const stop = src.stop.bind(src);
    src.stop = (...a) => {
      rec.stopped = true;
      return stop(...a);
    };
    window.__audio.sources.push(rec);
    return src;
  };
  function Watched(...a) {
    const ctx = new AC(...a);
    window.__audio.contexts.push(ctx);
    return ctx;
  }
  Watched.prototype = AC.prototype;
  window.AudioContext = Watched;
  if (window.webkitAudioContext) window.webkitAudioContext = Watched;
  // Layout shifts, for the check that nothing moves while it plays.
  window.__shifts = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) window.__shifts.push({ v: e.value, at: Math.round(e.startTime) });
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}
};

/** What the page's sound is doing now: the context, the last two gains (room, voice) and the two latest sources. */
const audioNow = (page) =>
  page.evaluate(() => {
    const a = window.__audio;
    const ctx = a.contexts.at(-1);
    return {
      contexts: a.contexts.length,
      state: ctx?.state ?? null,
      time: ctx?.currentTime ?? 0,
      gains: a.gains.slice(-2).map((g) => Math.round(g.gain.value * 100) / 100),
      sources: a.sources.slice(-2).map((s) => ({ at: s.at, stopped: s.stopped, duration: s.duration })),
      started: a.sources.length,
    };
  });

const tile = (page) => page.locator('#home-bento [data-tile="audio"]');
const phase = (page) => tile(page).getAttribute("data-phase");
const chip = (page) => tile(page).locator("[data-demo-state]").innerText();
const pressed = (page, name) => tile(page).getByRole("button", { name, exact: true }).getAttribute("aria-pressed");
const waitPhase = (page, want, timeout = 20_000) =>
  page
    .waitForFunction((w) => document.querySelector('#home-bento [data-tile="audio"]')?.dataset.phase === w, want, { timeout })
    .then(() => true)
    .catch(() => false);
/** Waits until both gains have settled at `want` (room, voice). */
const waitGains = (page, want, timeout = 6000) =>
  page
    .waitForFunction(
      (w) => {
        const g = window.__audio.gains.slice(-2).map((x) => x.gain.value);
        return g.length === 2 && g.every((v, i) => Math.abs(v - w[i]) < 0.02);
      },
      want,
      { timeout },
    )
    .then(() => true)
    .catch(() => false);

async function open(ctx) {
  await ctx.addInitScript(watchAudio);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => check(`no page error (${String(e.message).slice(0, 140)})`, false));
  const clips = [];
  page.on("request", (r) => /\/samples\/clean-voice\/.*\.m4a/.test(r.url()) && clips.push(new URL(r.url()).pathname));
  await page.goto(app + "/", { waitUntil: "load", timeout: 90_000 });
  await tile(page).waitFor({ timeout: 20_000 });
  return { page, clips };
}

const shot = async (page, name) => {
  if (!shotsDir) return;
  const b = await tile(page).boundingBox();
  if (b)
    await page.screenshot({
      path: path.join(shotsDir, `${name}.png`),
      clip: { x: Math.max(0, b.x - 10), y: Math.max(0, b.y - 10), width: b.width + 20, height: b.height + 20 },
    });
};

const browser = await launch();
try {
  // ---------------------------------------------------------------------------------- 1, 2, 3, 4: at rest, then played
  for (const [label, device] of [
    ["1440", DESKTOP],
    ["390", PHONE],
  ]) {
    for (const scheme of ["light", "dark"]) {
      const tag = `${label} ${scheme}`;
      const ctx = await browser.newContext({ ...device, colorScheme: scheme, deviceScaleFactor: label === "390" ? 3 : 2 });
      const { page, clips } = await open(ctx);
      await tile(page).scrollIntoViewIfNeeded();
      await page.waitForTimeout(1200);
      const rest = await audioNow(page);
      check(`${tag}: at rest, no sound and nothing fetched`, rest.contexts === 0 && clips.length === 0, JSON.stringify({ contexts: rest.contexts, clips }));
      check(
        `${tag}: at rest, Noisy restaurant, Noise on pressed, Tap to listen`,
        (await chip(page)) === "Noisy restaurant" &&
          (await pressed(page, "Noise on")) === "true" &&
          (await pressed(page, "Noise off")) === "false" &&
          (await phase(page)) === "idle",
      );
      check(`${tag}: the play button is named`, (await tile(page).getByRole("button", { name: "Tap to listen" }).count()) === 1);
      if (label === "390") {
        const sizes = await tile(page)
          .locator("button")
          .evaluateAll((bs) =>
            bs.map((b) => [b.textContent.trim(), Math.round(b.getBoundingClientRect().width), Math.round(b.getBoundingClientRect().height)]),
          );
        check(
          `${tag}: every button at least 44 px to tap`,
          sizes.every(([, w, h]) => w >= 44 && h >= 44),
          JSON.stringify(sizes),
        );
        const box = await tile(page).boundingBox();
        check(`${tag}: the tile is the full row`, Math.round(box.width) === 358, String(box.width));
      }
      await shot(page, `${tag}-rest`);

      // A browser without Web Audio (Playwright's WebKit for Windows has none; Safari itself has it): a tap says it
      // can't, and nothing else on the page breaks.
      if (!(await page.evaluate(() => !!(window.AudioContext || window.webkitAudioContext)))) {
        await tile(page).getByRole("button", { name: "Tap to listen" }).click();
        check(
          `${tag}: without Web Audio, a tap offers to try again`,
          (await waitPhase(page, "failed", 4000)) && (await tile(page).getByRole("button", { name: "Try again" }).count()) === 1,
        );
        if (!notes.some((n) => n.includes("Web Audio"))) notes.push(`skipped under ${ENGINE}: the sound checks (this build has no Web Audio)`);
        await ctx.close();
        continue;
      }

      // A tap: both takes, the room first.
      const play = tile(page).getByRole("button", { name: "Tap to listen" });
      if (label === "390") await play.tap();
      else await play.click();
      const started = await waitPhase(page, "playing");
      const a = await audioNow(page);
      check(`${tag}: one tap plays it`, started && a.state === "running", JSON.stringify({ phase: await phase(page), state: a.state }));
      check(
        `${tag}: both takes start on the same sample`,
        a.sources.length === 2 && a.sources[0].at !== null && a.sources[0].at === a.sources[1].at && a.sources.every((s) => s.duration > 7),
        JSON.stringify(a.sources),
      );
      check(`${tag}: the room first, her voice silent`, a.gains.join() === "1,0", a.gains.join());
      check(`${tag}: each clip fetched once, on the tap`, clips.length === 2 && new Set(clips).size === 2, clips.join(" "));
      await page.waitForTimeout(700);
      const later = await audioNow(page);
      check(`${tag}: the sound's clock runs`, later.time > a.time + 0.4, `${a.time.toFixed(2)} -> ${later.time.toFixed(2)}`);
      await shot(page, `${tag}-playing`);

      // A few seconds in, the noise goes by itself.
      const quietNow = await page
        .waitForFunction(() => document.querySelector('#home-bento [data-tile="audio"] [data-demo-state]')?.textContent === "Voice only", null, {
          timeout: 8000,
        })
        .then(() => true)
        .catch(() => false);
      check(`${tag}: the noise goes by itself, the chip says Voice only`, quietNow);
      check(`${tag}: the gains cross to her voice`, await waitGains(page, [0, 1]), (await audioNow(page)).gains.join());
      check(`${tag}: Noise off is pressed`, (await pressed(page, "Noise off")) === "true");
      await page.waitForTimeout(1100);
      const soft = await tile(page).evaluate((el) => Number(getComputedStyle(el.querySelector(".hb-voice-quiet")).opacity));
      check(`${tag}: the softened photo shows`, soft > 0.95, String(soft));
      await shot(page, `${tag}-voice-only`);

      // Noise on, Noise off: the switch crosses the gains at once.
      await tile(page).getByRole("button", { name: "Noise on", exact: true }).click();
      check(
        `${tag}: Noise on brings the room back`,
        (await waitGains(page, [1, 0], 2000)) && (await chip(page)) === "Noisy restaurant" && (await pressed(page, "Noise on")) === "true",
        (await audioNow(page)).gains.join(),
      );
      await tile(page).getByRole("button", { name: "Noise off", exact: true }).click();
      check(`${tag}: Noise off takes it away again`, (await waitGains(page, [0, 1], 2000)) && (await chip(page)) === "Voice only");
      check(`${tag}: still one take of each, still playing`, (await audioNow(page)).started === 2 && (await phase(page)) === "playing");

      if (ENGINE === "chromium") {
        const shifts = await page.evaluate(() => window.__shifts.reduce((s, e) => s + e.v, 0));
        check(`${tag}: nothing shifts while it plays`, shifts < 0.001, String(shifts));
      }

      // 3. Out of view it pauses; a tap resumes it.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const pausedOut = await waitPhase(page, "paused", 4000);
      const out = await audioNow(page);
      check(`${tag}: scrolled away, it pauses`, pausedOut && out.state === "suspended", JSON.stringify({ phase: await phase(page), state: out.state }));
      await tile(page).scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      check(`${tag}: back in view it stays paused until asked`, (await phase(page)) === "paused");
      const resume = tile(page).getByRole("button", { name: "Resume" });
      if (label === "390") await resume.tap();
      else await resume.click();
      const back = await waitPhase(page, "playing", 4000);
      // (The context resumes a moment after the tap: its promise.)
      const running = await page
        .waitForFunction(() => window.__audio.contexts.at(-1)?.state === "running", null, { timeout: 3000 })
        .then(() => true)
        .catch(() => false);
      const resumed = await audioNow(page);
      check(`${tag}: one tap resumes it`, back && running, JSON.stringify({ back, phase: await phase(page), state: resumed.state, time: resumed.time }));

      // A hidden tab pauses it.
      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { value: true, configurable: true });
        Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      check(`${tag}: a hidden tab pauses it`, await waitPhase(page, "paused", 3000));
      await page.evaluate(() => {
        delete document.hidden;
        delete document.visibilityState;
        document.dispatchEvent(new Event("visibilitychange"));
      });

      // 4. One sound at a time.
      if (label === "1440" && scheme === "light") {
        await tile(page).getByRole("button", { name: "Resume" }).click();
        await waitPhase(page, "playing", 4000);
        const songPlays = await page.evaluate(async () => {
          // Two seconds of a quiet tone, as a WAV, playing with its sound on.
          const rate = 8000;
          const n = rate * 2;
          const buf = new ArrayBuffer(44 + n * 2);
          const v = new DataView(buf);
          const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
          str(0, "RIFF");
          v.setUint32(4, 36 + n * 2, true);
          str(8, "WAVEfmt ");
          v.setUint32(16, 16, true);
          v.setUint16(20, 1, true);
          v.setUint16(22, 1, true);
          v.setUint32(24, rate, true);
          v.setUint32(28, rate * 2, true);
          v.setUint16(32, 2, true);
          v.setUint16(34, 16, true);
          str(36, "data");
          v.setUint32(40, n * 2, true);
          for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i / 8) * 200), true);
          const song = new Audio(URL.createObjectURL(new Blob([buf], { type: "audio/wav" })));
          song.loop = true;
          song.id = "e2e-song";
          document.body.append(song);
          try {
            await song.play();
            return true;
          } catch (e) {
            return String(e);
          }
        });
        if (songPlays === true) {
          check("a song starting on the page pauses the demo", await waitPhase(page, "paused", 3000));
          await tile(page).getByRole("button", { name: "Resume" }).click();
          await waitPhase(page, "playing", 4000);
          await page.waitForTimeout(300);
          check("the demo resumed pauses the song", await page.evaluate(() => document.getElementById("e2e-song").paused));
          // Home's own previews play muted: they never stop it.
          await page.waitForTimeout(1500);
          check("the muted previews never stop it", (await phase(page)) === "playing" || (await phase(page)) === "done", await phase(page));
        } else notes.push(`one sound at a time: skipped, this ${ENGINE} build wouldn't play the test song (${songPlays})`);
      }
      await ctx.close();
    }
  }

  /** Set when the browser has no Web Audio (above): only the checks that need no sound run. */
  const noWebAudio = notes.some((n) => n.includes("Web Audio"));

  // ---------------------------------------------------------------------------------- 5. the keyboard alone
  {
    const ctx = await browser.newContext(DESKTOP);
    const { page } = await open(ctx);
    await page.locator("#home-bento h1").click();
    const stops = [];
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press("Tab");
      const at = await page.evaluate(() => {
        const el = document.activeElement;
        return el?.closest('[data-tile="audio"]') ? `${el.tagName.toLowerCase()}:${el.getAttribute("aria-label") ?? el.textContent.trim()}` : null;
      });
      if (at) stops.push(at);
      else if (stops.length) break;
    }
    // (WebKit's Tab moves between form controls only, not links, unless the viewer turns that on.)
    const wantStops = [
      "button:Noise on",
      "button:Noise off",
      "button:Tap to listen",
      ...(ENGINE === "webkit" ? [] : ["a:Audio: Studio-clean voice. Open Clean up voice"]),
    ];
    check(
      "keyboard: Tab reaches Noise on, Noise off, the play button and the link, in that order",
      stops.join(" | ") === wantStops.join(" | "),
      stops.join(" | "),
    );
    // Back to Noise off: Space starts it with the noise off.
    for (let i = 0; i < wantStops.length - 1; i++) await page.keyboard.press("Shift+Tab");
    const focused = await page.evaluate(() => document.activeElement?.textContent.trim());
    check("keyboard: Shift+Tab goes back to Noise off", focused === "Noise off", focused);
    if (noWebAudio) {
      await ctx.close();
    } else {
      await page.keyboard.press("Space");
      const keyed = await waitPhase(page, "playing");
      check(
        "keyboard: Space on Noise off plays it with her voice alone",
        keyed && (await waitGains(page, [0, 1], 3000)) && (await pressed(page, "Noise off")) === "true",
        (await audioNow(page)).gains.join(),
      );
      const live = await tile(page).locator("[aria-live=polite]").innerText();
      check("keyboard: the live region says what is heard", live.trim() === "Voice only", live);
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Enter");
      check("keyboard: Enter on Noise on brings the room back", (await waitGains(page, [1, 0], 3000)) && (await pressed(page, "Noise on")) === "true");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      const pauseName = await page.evaluate(() => document.activeElement?.textContent.trim());
      await page.keyboard.press("Enter");
      check(
        "keyboard: the play button says Pause while it plays, and Enter pauses it",
        pauseName === "Pause" && (await waitPhase(page, "paused", 3000)),
        pauseName,
      );
      await ctx.close();
    }
  }

  // ---------------------------------------------------------------------------------- 6. reduced motion
  if (!noWebAudio) {
    const ctx = await browser.newContext({ ...DESKTOP, reducedMotion: "reduce" });
    const { page } = await open(ctx);
    await tile(page).getByRole("button", { name: "Tap to listen" }).click();
    const ok = await waitPhase(page, "playing");
    await page.waitForTimeout(800);
    const t = await tile(page).evaluate((el) => getComputedStyle(el.querySelector(".hb-voice-pics")).transform);
    check("reduced motion: it plays, and the photo doesn't move", ok && (t === "none" || t === "matrix(1, 0, 0, 1, 0, 0)"), t);
    await ctx.close();
  }
} finally {
  await browser.close();
}

if (notes.length) console.log("\n" + notes.join("\n"));
if (failures.length) {
  console.log(`\n${failures.length} failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`\nall passed (${ENGINE})`);
