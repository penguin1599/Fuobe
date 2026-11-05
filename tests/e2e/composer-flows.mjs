// Composer flows that broke before. Run against a running app (demo mode is fine):
//   node tests/e2e/composer-flows.mjs [appUrl]
// Checks, each printed ok/FAIL; exits 1 on any failure:
//   1. First paint: a hub mode (/audio/music) and old ?mode= links serve the right studio in the HTML itself.
//   2. Text typed into the prerendered prompt before the page hydrates survives hydration (throttled CPU and network).
//   3. A pasted image attaches once and stops spinning; one removed while it uploads stays removed.
//   4. A clip dropped on an Image tile is refused.
//   5. Phone (390 px): the composer toolbar fits on every studio, the Settings chip is in view, no sideways scroll.
//   6. A blocked Generate says why in a line under the composer on a phone; a tap opens the missing tile's file
//      picker (focus inside the composer), and the line moves on to the next input. A desktop composer shows the
//      line only while its tiles are folded away.
//   7. Layout mode (Image studio, MOSS-Image in the cloud, demo mode): draw one box by mouse and one by touch at
//      390 px, a Text box asks for its words, Generate sends the layout (compiled at the size fal renders, prompt
//      expansion off) and the feed says "Layout · 1 box"; Reuse and Edit layout from the tile reopen the boxes.
//
// Playwright: the `playwright` (or `playwright-core`) package if it resolves, else the global install at
// /opt/node22/lib/node_modules. Chromium: $CHROMIUM_PATH, else the newest /opt/pw-browsers/chromium-*.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const app = (process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "http://localhost:3000").replace(/\/$/, "");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadPlaywright() {
  for (const from of [path.join(root, "package.json"), "/opt/node22/lib/node_modules/", "/opt/node-tools/node_modules/"]) {
    const req = createRequire(from);
    for (const name of ["playwright", "playwright-core"]) {
      try {
        return req(name);
      } catch {}
    }
  }
  throw new Error("Playwright not found: install playwright-core or run where the global install exists");
}

function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const dir = "/opt/pw-browsers";
  if (!fs.existsSync(dir)) return undefined;
  const newest = fs
    .readdirSync(dir)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))[0];
  const exe = newest && path.join(dir, newest, "chrome-linux/chrome");
  return exe && fs.existsSync(exe) ? exe : undefined;
}

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

// 1. First paint, from the HTML alone (what a phone shows before any script runs).
for (const [url, hero, tab] of [
  ["/audio/music", "What should it sound like?", "Music"],
  ["/audio?mode=music", "What should it sound like?", "Music"],
  ["/video-tools/join", "Join clips into one video", "Join clips"],
]) {
  const res = await fetch(app + url, { redirect: "follow" });
  const html = await res.text();
  const current = html.match(/aria-current="page"[^>]*>([^<]+)</)?.[1];
  check(`first paint ${url}`, res.ok && html.includes(hero) && current === tab, `${res.status} → ${new URL(res.url).pathname}, tab "${current ?? "-"}"`);
}

const { chromium } = loadPlaywright();
const browser = await chromium.launch({ executablePath: chromiumPath() });

/** Paste an image file (a solid colour) into the composer's prompt. */
async function pasteImage(page, color) {
  await page.evaluate(async (color) => {
    const c = document.createElement("canvas");
    c.width = 160;
    c.height = 120;
    const x = c.getContext("2d");
    x.fillStyle = color;
    x.fillRect(0, 0, 160, 120);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "pasted.png", { type: "image/png" }));
    const ta = document.querySelector("[data-composer] textarea");
    ta.focus();
    ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, color);
}

async function ready(page, url) {
  await page.goto(app + url, { waitUntil: "load", timeout: 120_000 });
  await page.waitForSelector("[data-composer-toolbar]", { timeout: 60_000 });
  // Hydrated: React has attached itself to the toolbar (some tools have no prompt).
  await page.waitForFunction(() => Object.keys(document.querySelector("[data-composer-toolbar]") ?? {}).some((k) => k.startsWith("__react")), null, { timeout: 60_000 });
}

// 2. Typing before hydration.
{
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
  await page.goto(app + "/image", { waitUntil: "commit", timeout: 120_000 });
  // Visible: a dev server streams the page into a hidden segment first, then moves it into place.
  await page.waitForSelector("[data-composer] textarea", { state: "visible", timeout: 120_000 });
  const early = await page.evaluate(() => {
    const ta = document.querySelector("[data-composer] textarea");
    window.__shell = ta;
    ta.focus();
    return !Object.keys(ta).some((k) => k.startsWith("__react"));
  });
  await page.keyboard.type("early words", { delay: 20 });
  await page.waitForFunction(() => Object.keys(document.querySelector("[data-composer] textarea")).some((k) => k.startsWith("__react")), null, { timeout: 120_000 });
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => {
    const ta = document.querySelector("[data-composer] textarea");
    return { value: ta.value, same: ta === window.__shell, focus: document.activeElement === ta };
  });
  // Then a keystroke after hydration must keep the early text (React would otherwise reset the field).
  await page.keyboard.type("!");
  const final = await page.locator("[data-composer] textarea").inputValue();
  // A fast dev machine may hydrate before the first key: then the check still holds, but says so.
  check("typing before hydration survives", after.same && after.focus && final === "early words!", `typed before hydration: ${early ? "yes" : "no (hydrated first; use a production build)"}, same node: ${after.same}, focused: ${after.focus}, value "${final}"`);
  await page.close();
}

// 3 and 4. Uploads on the Edit studio.
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let delay = 0;
  await page.route("**/api/uploads", async (route) => {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    await route.continue().catch(() => {});
  });
  await ready(page, "/edit");
  await pasteImage(page, "#3366ff");
  await page.waitForFunction(() => !document.querySelector("[data-composer] [aria-label=Uploading]") && !!document.querySelector('[data-slot-key="image"] img'), null, { timeout: 30_000 });
  await page.waitForTimeout(500);
  const imgs = await page.locator('[data-composer] [data-slot-key] img, [data-composer] button[aria-label^="Remove reference"]').count();
  check("paste attaches once", imgs === 1, `${imgs} attachment(s)`);

  delay = 2500;
  await page.getByRole("button", { name: "Remove Image" }).click();
  await pasteImage(page, "#22aa88");
  await page.waitForSelector("[data-composer] [aria-label=Uploading]");
  await page.getByRole("button", { name: "Remove Image" }).click();
  await page.waitForTimeout(3500);
  const back = await page.locator('[data-slot-key="image"] img').count();
  check("removed while uploading stays removed", back === 0);
  delay = 0;

  await page.evaluate(() => {
    const tile = document.querySelector('[data-slot-key="image"]');
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], "clip.mp4", { type: "video/mp4" }));
    for (const t of ["dragover", "drop"]) tile.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(800);
  const video = await page.locator('[data-slot-key="image"] video').count();
  const toast = await page.locator("[data-sonner-toast]").allInnerTexts();
  check("clip dropped on the Image tile is refused", video === 0 && toast.some((t) => /Image only/.test(t)), JSON.stringify(toast));
  await page.close();
}

// 5. Phone toolbar.
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  for (const route of [
    "/image", "/edit", "/inpaint", "/video", "/lipsync", "/motion-control", "/reframe", "/extend", "/video-edit",
    // /audio/translate is the Translate & dub studio (its own steps, no composer); no-horizontal-scroll.mjs covers it.
    "/upscale", "/upscale/video", "/audio/speech", "/audio/dialogue", "/audio/voice-change", "/audio/transcribe", "/audio/sfx", "/audio/music", "/audio/video",
    "/video-tools", "/video-tools/relight", "/video-tools/depth", "/video-tools/join", "/video-tools/colors", "/apps/app-face-swap",
  ]) {
    await ready(page, route);
    await page.waitForTimeout(500);
    const m = await page.evaluate(() => {
      const row = document.querySelector("[data-composer-toolbar]");
      const s = row.querySelector('button[aria-label^="Settings"]')?.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      return {
        over: row.scrollWidth - row.clientWidth,
        settings: s ? Math.min(s.right, r.right) - Math.max(s.left, r.left) >= s.width - 1 : false,
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    check(`phone toolbar ${route}`, m.over <= 0 && m.settings && m.page <= 0, `row overflow ${m.over}px, settings in view: ${m.settings}, page overflow ${m.page}px`);
  }
  await ctx.close();
}

// 6. The blocker line.
{
  const lineText = (page) => page.evaluate(() => document.querySelector("[data-composer] [aria-live=polite] button")?.textContent?.trim() ?? "");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await ready(page, "/apps/app-face-swap");
  await page.waitForTimeout(800);
  const first = await lineText(page);
  check("phone: a blocked Generate says why under the composer", /^Add an? /.test(first), first || "no line");
  const png = Buffer.from(
    await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 160;
      c.height = 120;
      const x = c.getContext("2d");
      x.fillStyle = "#cc6633";
      x.fillRect(0, 0, 160, 120);
      return c.toDataURL("image/png").split(",")[1];
    }),
    "base64",
  );
  if (first) {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null),
      page.locator("[data-composer] [aria-live=polite] button").first().tap(),
    ]);
    const inside = await page.evaluate(() => !!document.activeElement?.closest("[data-composer]"));
    check("…a tap on it opens that tile's file picker", !!chooser && inside, `picker: ${!!chooser}, focus in the composer: ${inside}`);
    if (chooser) {
      await chooser.setFiles({ name: "photo.png", mimeType: "image/png", buffer: png });
      await page.waitForFunction((was) => (document.querySelector("[data-composer] [aria-live=polite] button")?.textContent?.trim() ?? "") !== was, first, { timeout: 30_000 }).catch(() => {});
      const next = await lineText(page);
      check("…and once it's filled the line names the next input", next !== first && /^Add an? /.test(next), `"${first}" → "${next}"`);
    }
  }
  await ctx.close();

  const desk = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await ready(desk, "/apps/app-face-swap");
  await desk.waitForTimeout(800);
  const m = await desk.evaluate(() => {
    const tiles = [...document.querySelectorAll("[data-composer] [data-slot-key]")].some((t) => t.getBoundingClientRect().width > 0);
    const line = document.querySelector("[data-composer] [aria-live=polite] p");
    return { tiles, line: !!line && line.getBoundingClientRect().height > 0 };
  });
  check("desktop: the line shows only while the tiles are folded away", m.line === !m.tiles, `tiles shown: ${m.tiles}, line shown: ${m.line}`);
  await desk.close();
}

// 7. Layout mode.
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await ready(page, "/image?model=moss-image");
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Layout", exact: true }).first().click();
  const canvas = page.locator("[data-layout-canvas]");
  await canvas.waitFor({ timeout: 30_000 });
  const c = await canvas.boundingBox();
  await page.mouse.move(c.x + c.width * 0.1, c.y + c.height * 0.08);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width * 0.9, c.y + c.height * 0.24, { steps: 8 });
  await page.mouse.up();
  check("layout: a drag draws a box", (await page.locator("[data-layout-box]").count()) === 1);
  const row = page.locator('[data-layout-row="1"]');
  await row.getByRole("radio", { name: "Text" }).click();
  check("layout: a Text box asks for its words", await row.getByText("Type the words for box 1").isVisible());
  await row.getByLabel("Box 1: exact words").fill("30% OFF");
  await page.locator("#layout-caption").fill("A candle sale poster");
  await page.getByRole("button", { name: "Done" }).click();
  const strip = await page.locator("[data-layout-strip]").innerText();
  check("layout: the strip says the size it's laid out at", /Laid out for MOSS-Image at \d+ × \d+/.test(strip), strip.replace(/\n/g, " "));
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/generations") && r.method() === "POST", { timeout: 30_000 });
  await page.getByRole("button", { name: /^Generate/ }).click();
  const body = JSON.parse((await sent).postData() ?? "{}");
  const layout = body.params?.extra?.layout;
  check("layout: Generate sends the draft with the prompt as its caption", layout?.items?.length === 1 && layout.items[0].text === "30% OFF" && layout.summary?.caption === "A candle sale poster");
  const tile = page.locator("[data-gen-id]", { has: page.locator("header", { hasText: "Layout · 1 box" }) }).first();
  check("layout: the feed says it's a layout", await tile.waitFor({ timeout: 30_000 }).then(() => true, () => false));
  const preview = await page.request.post(`${app}/api/generations?preview=1`, { data: body }).then((r) => r.json()).catch(() => ({}));
  check("layout: the run gets the compiled MOSS prompt", typeof preview.prompt === "string" && preview.prompt.includes('"bbox_coord_space":"abs_centralized"'), (preview.prompt ?? preview.error ?? "").slice(0, 80));
  // Reuse: with Layout mode off and the prompt cleared, the run comes back as boxes with its caption. The composer docks
  // and folds its strips away after Generate: focusing the prompt opens it again.
  const composer = page.locator("[data-composer] textarea");
  await composer.click();
  await page.getByRole("button", { name: "Layout off" }).click();
  await page.locator("[data-composer] textarea").fill("");
  await tile.locator("header").hover();
  await tile.getByRole("button", { name: "Reuse" }).click();
  await page.locator("[data-layout-strip]").waitFor({ timeout: 10_000 }).catch(() => {});
  const reused = await page.locator("[data-layout-strip]").innerText().catch(() => "");
  check("layout: Reuse brings the boxes and the caption back", /1 box/.test(reused) && (await page.locator("[data-composer] textarea").inputValue()) === "A candle sale poster");
  await page.waitForFunction(() => document.querySelector("[data-gen-id] img, [data-gen-id] video"), null, { timeout: 60_000 }).catch(() => {});
  const t = tile.locator(".group\\/tile").first();
  // Edit layout from a state with no layout on screen (Reuse just put one there), twice on the same picture: the second
  // time must open it again too.
  for (const time of ["first", "second"]) {
    await composer.click();
    await page.getByRole("button", { name: "Layout off" }).click();
    const chip = page.getByRole("button", { name: "Layout", exact: true }).first();
    const off = await page.waitForFunction(() => !document.querySelector("[data-layout-strip]"), null, { timeout: 10_000 }).then(() => true, () => false) && (await chip.getAttribute("aria-pressed")) === "false";
    await t.hover();
    await t.getByRole("button", { name: "More actions" }).first().click();
    await page.getByRole("menuitem", { name: "Edit layout" }).click();
    await page.waitForFunction(() => !location.search.includes("layout="), null, { timeout: 30_000 }).catch(() => {});
    await composer.click();
    await page.locator("[data-layout-strip]").waitFor({ timeout: 30_000 }).catch(() => {});
    const strip = await page.locator("[data-layout-strip]").innerText().catch(() => "");
    check(`layout: Edit layout reopens the boxes (${time} time)`, off && /1 box/.test(strip), off ? strip.replace(/\n/g, " ") || "no strip" : "Layout off left the strip");
  }
  await page.close();

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await ctx.newPage();
  await ready(phone, "/image?model=moss-image");
  await phone.waitForTimeout(800);
  await phone.getByRole("button", { name: /^Settings/ }).first().tap();
  await phone.getByRole("button", { name: "Layout", exact: true }).first().tap();
  await phone.locator("[data-layout-canvas]").waitFor({ timeout: 30_000 });
  const pc = await phone.locator("[data-layout-canvas]").boundingBox();
  const cdp = await ctx.newCDPSession(phone);
  const pt = (x, y) => [{ x: pc.x + pc.width * x, y: pc.y + pc.height * y }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(0.2, 0.3) });
  for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pt(0.2 + 0.06 * i, 0.3 + 0.05 * i) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await phone.waitForTimeout(300);
  check("layout (390 px): a touch drag draws a box", (await phone.locator("[data-layout-box]").count()) === 1);
  const sheet = await phone.locator('aside[aria-label="Boxes"]').boundingBox();
  const board = await phone.locator("[data-layout-canvas]").boundingBox();
  check("layout (390 px): the rows sit in a sheet under the canvas", !!sheet && !!board && sheet.y >= board.y + board.height, `canvas ends at ${Math.round(board?.y + board?.height)}, sheet starts at ${Math.round(sheet?.y)}`);
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("layout (390 px): nothing scrolls sideways", wide <= 0, `${wide}px`);
  await ctx.close();
}

await browser.close();
console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(", ")}` : "\nAll composer checks passed.");
process.exit(failures.length ? 1 : 0);
