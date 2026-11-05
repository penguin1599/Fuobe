// What each studio holds inside (its tabs and modes) in the top nav, in a real browser, for a guest, an account and the
// owner: the links under their studio in the Studios menu (fit, keys, focus, current page, deep links that open the right
// tab), the phone's Studios sheet pills, /studios' "Inside these studios" rows, search, and the owner's Canvas column.
// Usage: node tests/e2e/nav-subfeatures.mjs [appUrl] [shotsDir]
//   E2E_BROWSER=webkit or firefox runs it there. E2E_OWNER_PASSWORD: the studio's password, when it has one. Account
//   checks need public sign-up (a throwaway qa account, deleted at the end).
// Exits 1 if any check fails; shots (1440 and 1280 menus, 390 sheets and /studios, light and dark) go to shotsDir.
import fs from "node:fs";
import path from "node:path";
import { ENGINE, launch, openRoute, PHONE } from "./_browser.mjs";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const app = (args[0] ?? "http://localhost:3000").replace(/\/$/, "");
const shots = args[1];
if (shots) fs.mkdirSync(shots, { recursive: true });
const failures = [];
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${what}${!ok && detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(what);
};
const shot = async (page, name, opts = {}) => shots && (await page.screenshot({ path: path.join(shots, `${name}.png`), ...opts }));
const publicSignup = !!(await fetch(`${app}/api/auth/me`).then((r) => r.json()).catch(() => null))?.publicSignup;

/** Features a visitor never gets a menu or sheet link to: the owner's own, and pages that say "isn't available here". */
const OWNER_SUBS = ["From picture", "Split soundtrack", "Remove dialogue", "From an image", "From several images", "From a selfie", "From Reference", "Skills as canvases"];

const browser = await launch();
const accounts = [];
let accountState;
async function account() {
  if (!accountState) {
    const ctx = await browser.newContext();
    const email = `qa-navsub-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.com`;
    const password = `Qa-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const res = await ctx.request.post(`${app}/api/auth/signup`, { data: { email, password } });
    if (!res.ok()) throw new Error(`sign-up answered ${res.status()}`);
    accounts.push({ ctx, password });
    accountState = await ctx.storageState();
  }
  return accountState;
}
async function as(who, device = { viewport: { width: 1440, height: 900 } }, extra = {}) {
  const ctx = await browser.newContext({ ...device, ...extra });
  ctx.errors = [];
  if (who === "owner" && process.env.E2E_OWNER_PASSWORD) await ctx.request.post(`${app}/api/auth/login`, { data: { password: process.env.E2E_OWNER_PASSWORD } });
  if (who === "account") await ctx.addCookies((await account()).cookies);
  const me = (await (await ctx.request.get(`${app}/api/auth/me`)).json().catch(() => null)) ?? {};
  if (who === "owner" && !me.owner) throw new Error("couldn't sign in as the owner (set E2E_OWNER_PASSWORD)");
  return ctx;
}
async function page(ctx) {
  const p = await ctx.newPage();
  const noise = (t) => /Failed to load resource/.test(t) || (/_rsc=/.test(t) && /due to access control checks/.test(t));
  p.on("pageerror", (e) => !noise(e.message) && ctx.errors.push(`uncaught: ${e.message.split("\n")[0]}`));
  p.on("console", (m) => m.type() === "error" && !noise(m.text()) && ctx.errors.push(m.text().slice(0, 200)));
  return p;
}
const bar = (p) => p.locator("[data-top-bar]");
const panel = (p) => p.locator("#studios-launcher");
const focused = (p) =>
  p.evaluate(() => {
    const a = document.activeElement;
    return { text: a?.textContent?.trim() ?? "", sub: a?.hasAttribute("data-sub") ?? false, col: a?.getAttribute("data-col"), row: a?.getAttribute("data-row") };
  });
const waitUrl = (p, test) => p.waitForURL((u) => test(new URL(u)), { timeout: 20_000 }).then(() => true, () => false);
/** Whether a page's tab (or a mode picked as a radio, Image to 3D's) by this name is the selected one. */
const selectedTab = async (p, name) => {
  const tab = p.getByRole("tab", { name, exact: true }).or(p.getByRole("radio", { name, exact: true })).first();
  try {
    await tab.waitFor({ timeout: 15_000 });
    // A page picks its linked tab once it has read the address: give a slow engine up to 3 s.
    for (let i = 0; i < 15; i++) {
      await p.waitForTimeout(200);
      if ((await tab.getAttribute("aria-selected")) === "true" || (await tab.getAttribute("aria-checked")) === "true") return true;
    }
    return false;
  } catch {
    return false;
  }
};
/** Opens search from the bar's own button (the / key belongs to a focused field when there is one). */
async function openSearch(p) {
  await p.keyboard.press("Escape").catch(() => {});
  const input = p.locator("[cmdk-input]").or(p.getByPlaceholder("What do you want to make?")).first();
  // The bar's search button, else its / key (a click can land while the page is still settling).
  await p.locator('[data-top-bar] button[aria-keyshortcuts^="/"]').first().click({ timeout: 5_000 }).catch(() => p.keyboard.press("/"));
  if (!(await input.isVisible().catch(() => false))) await input.waitFor({ timeout: 3_000 }).catch(() => p.keyboard.press("/"));
  await input.waitFor({ timeout: 10_000 });
  return input;
}

async function openStudios(p) {
  // A click opens it, or pins it when the resting mouse opened it first: it never closes it.
  await bar(p).locator('[data-bar-menu="studios"]').click();
  await panel(p).waitFor({ state: "visible" });
  await panel(p).locator('[data-col="0"][data-row="0"]').first().waitFor({ timeout: 10_000 });
  await p.waitForFunction(() => [...document.querySelectorAll("#studios-launcher img")].filter((i) => i.checkVisibility()).every((i) => i.complete), null, { timeout: 10_000 }).catch(() => {});
  await p.waitForTimeout(250);
}

/** The Studios panel as it shows: fit, and each studio's links that show. */
const measure = (p) =>
  panel(p).evaluate((el) => {
    const links = [...el.querySelectorAll("[data-col]")].filter((a) => a.checkVisibility());
    const subs = {};
    for (const ul of el.querySelectorAll("[data-subs]")) {
      if (!ul.checkVisibility()) continue;
      subs[ul.getAttribute("data-subs")] = [...ul.querySelectorAll("a")]
        .filter((a) => a.checkVisibility())
        .map((a) => {
          // A pill's touch area past it (::after on a touch screen).
          const after = getComputedStyle(a, "::after");
          const reach = after.content !== "none" && after.position === "absolute" ? Math.max(0, -parseFloat(after.top) || 0) + Math.max(0, -parseFloat(after.bottom) || 0) : 0;
          return { label: a.textContent.trim(), h: a.getBoundingClientRect().height, tap: a.getBoundingClientRect().height + reach, line: getComputedStyle(ul).flexDirection === "row" && !matchMedia("(pointer: coarse)").matches };
        });
    }
    // Each list column's rows (studios, not their links): their tops, to see the columns' rows in line.
    const rows = [...el.querySelectorAll("[data-group] > ul > li:not(:first-child) > a")].filter((a) => a.checkVisibility()).map((a) => a.getBoundingClientRect().top);
    return {
      rows,
      inner: el.scrollHeight - el.clientHeight,
      offscreen: links.filter((a) => {
        const r = a.getBoundingClientRect();
        return r.bottom > innerHeight + 0.5 || r.right > innerWidth + 0.5 || r.top < 0;
      }).length,
      links: links.length,
      subs,
      text: el.innerText,
    };
  });

try {
  // 1. The Studios menu: each viewer, each size: everything on screen, the studios' links where their column has room.
  for (const who of ["guest", "owner", ...(publicSignup ? ["account"] : [])]) {
    // Window sizes, and the page area common laptops leave inside the browser's own bars (1440x790, 1536x730, 1920x940),
    // and both sides of the 880 px step.
    for (const size of [
      { width: 1280, height: 720 },
      { width: 1366, height: 768 },
      { width: 1536, height: 730 },
      { width: 1440, height: 790 },
      { width: 1280, height: 800 },
      { width: 1440, height: 879 },
      { width: 1440, height: 880 },
      { width: 1440, height: 900 },
      { width: 1920, height: 940 },
      { width: 1920, height: 1080 },
    ]) {
      const label = `${who} ${size.width}x${size.height}`;
      const ctx = await as(who, { viewport: size });
      const p = await page(ctx);
      await openRoute(p, `${app}/image`, { settleMs: 300 });
      await openStudios(p);
      const r = await measure(p);
      const names = (id) => (r.subs[id] ?? []).map((s) => s.label);
      check(r.inner <= 1 && r.offscreen === 0, `${label}: every studio and link on screen, no scrolling inside`, `inner ${r.inner}, ${r.offscreen}/${r.links} off`);
      check(names("marketing").join(" · ") === "Click to Ad · Ads Studio · Ad Multiplier", `${label}: Marketing Studio lists Click to Ad · Ads Studio · Ad Multiplier`, names("marketing").join(" · "));
      check(names("upscale").join(" · ") === "Image · Video · FPS Boost · SDR to HDR · Export", `${label}: Upscale lists its five tabs`, names("upscale").join(" · "));
      {
        // Genjutsu's modes at every height: a column of links from 800 px, one wrapped line of names below it. The
        // owner's own two modes from 880 px (People is the tallest column then).
        const gen = names("genjutsu");
        const want = ["Motion transfer", "Character swap", "Object swap", "Restyle", "Insert", ...(who === "owner" && size.height >= 880 ? ["From picture", "Finish"] : [])];
        check(want.every((w) => gen.includes(w)) && gen.length === want.length, `${label}: Genjutsu lists its modes`, gen.join(" · "));
        const line = (r.subs.genjutsu ?? []).some((s) => s.line);
        check(line === size.height < 800, `${label}: Genjutsu's modes ${size.height < 800 ? "as one line" : "as a column"}`);
        if (size.height >= 880) check(/^See all \d+$/.test(names("video-tools").at(-1) ?? ""), `${label}: Video tools lists a few, then See all`, names("video-tools").join(" · "));
        else check(!r.subs["video-tools"], `${label}: Video tools keeps its row only (its links from 880 px)`);
      }
      check((await panel(p).locator('[data-group="sell"] > ul > li > a[href="/ads"]').count()) === 0, `${label}: Ads Studio is under Marketing Studio, not a row of its own`);
      const allSubs = Object.values(r.subs).flat();
      // 24 px with a mouse, in a column or in wrapped lines (two to a row's 48 px).
      const short = allSubs.filter((s) => s.h < 23.5);
      check(short.length === 0, `${label}: every link 24 px tall`, short.map((s) => `${s.label} ${s.h}`).join(", "));
      // The columns' rows keep one grid (from 800 px: below it Genjutsu's lines take what they need): a list ends where
      // its last feature does and the next row follows 4 px below, as rows follow rows, so every row's top is a whole
      // number of 24 px (half a row) from the first one's.
      if (size.width >= 1280 && size.height >= 800 && r.rows.length) {
        const base = Math.min(...r.rows);
        const off = r.rows.filter((t) => {
          const m = (((t - base) % 24) + 24) % 24;
          return m > 1 && m < 23;
        });
        check(off.length === 0, `${label}: the columns' rows keep one 24 px grid`, off.map(Math.round).join(", "));
      }
      if (who !== "owner") {
        const said = OWNER_SUBS.filter((w) => allSubs.some((s) => s.label === w));
        check(said.length === 0, `${label}: no link a visitor can't use`, said.join(", "));
      } else if (size.height >= 800) {
        check(names("image-to-3d").length === 4, `${label}: the owner's Image to 3D modes, then See all`, names("image-to-3d").join(" · "));
      }
      if (shots && who !== "account" && [1280, 1440].includes(size.width)) await shot(p, `studios-${size.width}-${who}-light`);
      await p.keyboard.press("Escape");
      check(ctx.errors.length === 0, `${label}: no console errors`, ctx.errors.join(" | "));
      await ctx.close();
    }
  }

  // 1b. Dark, and a touch screen at desktop width (44 px links), and reduced motion (no transitions on the links).
  if (shots) {
    for (const who of ["guest", "owner"]) {
      const ctx = await as(who, { viewport: { width: 1440, height: 900 } }, { colorScheme: "dark" });
      const p = await page(ctx);
      await openRoute(p, `${app}/image`, { settleMs: 300 });
      await openStudios(p);
      await shot(p, `studios-1440-${who}-dark`);
      await ctx.close();
    }
  }
  for (const who of ["guest", "owner"]) {
    for (const [width, height] of [
      [1180, 820],
      [1280, 800],
      [1366, 1024],
      [1280, 1100],
    ]) {
      const label = `touch screen ${who} ${width}x${height}`;
      const ctx = await as(who, { viewport: { width, height }, hasTouch: true, isMobile: false });
      const p = await page(ctx);
      await openRoute(p, `${app}/image`, { settleMs: 300 });
      const coarse = await p.evaluate(() => matchMedia("(pointer: coarse)").matches);
      if (coarse) {
        await openStudios(p);
        const r = await measure(p);
        const small = Object.values(r.subs).flat().filter((s) => s.tap < 43.5);
        check(small.length === 0, `${label}: every link 44 px to tap`, small.map((s) => `${s.label} ${s.tap}`).join(", "));
        check(r.inner <= 1 && r.offscreen === 0, `${label}: no scrolling inside`, `inner ${r.inner}, off ${r.offscreen}`);
        check(!!r.subs.genjutsu === height >= 1024, `${label}: Genjutsu's modes ${height >= 1024 ? "listed" : "left to its page (from 1024 px)"}`);
        if (shots && who === "guest" && width === 1280) await shot(p, `studios-${width}x${height}-touch-guest`);
      } else console.log(`  ${label}: this engine doesn't report (pointer: coarse) here, skipped`);
      await ctx.close();
    }
  }
  {
    const ctx = await as("guest", { viewport: { width: 1440, height: 900 } }, { reducedMotion: "reduce" });
    const p = await page(ctx);
    await openRoute(p, `${app}/image`, { settleMs: 300 });
    await openStudios(p);
    const t = await panel(p).locator("[data-sub]").first().evaluate((a) => getComputedStyle(a).transitionDuration);
    check(t.split(",").every((d) => parseFloat(d) === 0), "reduced motion: the links don't animate", t);
    await ctx.close();
  }

  // 2. Keys, focus and links (guest 1440x900).
  {
    const ctx = await as("guest");
    const p = await page(ctx);
    await openRoute(p, `${app}/image`, { settleMs: 300 });
    const chev = bar(p).locator('[data-bar-menu="studios"]');
    await chev.focus();
    await p.keyboard.press("ArrowDown");
    await panel(p).waitFor({ state: "visible" });
    await p.waitForFunction(() => document.activeElement?.closest("[data-mega-panel]"), null, { timeout: 10_000 }).catch(() => {});
    await p.keyboard.press("ArrowRight");
    await p.keyboard.press("ArrowRight");
    check((await focused(p)).text.startsWith("Marketing Studio"), "keys: Right, Right reaches Marketing Studio", (await focused(p)).text);
    await p.keyboard.press("ArrowDown");
    let f = await focused(p);
    check(f.sub && f.text === "Click to Ad", "keys: Down from a studio goes to its first link", JSON.stringify(f));
    await p.keyboard.press("ArrowDown");
    await p.keyboard.press("ArrowDown");
    f = await focused(p);
    check(f.sub && f.text === "Ad Multiplier", "keys: Down walks its links", JSON.stringify(f));
    await p.keyboard.press("ArrowDown");
    f = await focused(p);
    // The next studio in the column: its first row (the lead's links come before it).
    const nextStudio = await panel(p).locator('[data-group="sell"] > ul > li:nth-child(2) > a').evaluate((a) => ({ text: a.textContent.trim(), row: a.getAttribute("data-row") }));
    check(!f.sub && f.text === nextStudio.text && f.row === nextStudio.row, "keys: Down from its last link goes on to the next studio", `${JSON.stringify(f)} want ${JSON.stringify(nextStudio)}`);
    await p.keyboard.press("ArrowUp");
    check((await focused(p)).text === "Ad Multiplier", "keys: Up comes back to the link");
    await p.keyboard.press("ArrowRight");
    f = await focused(p);
    check(f.col === "3", "keys: Right from a link goes to the next column", JSON.stringify(f));
    await p.keyboard.press("Escape");
    await p.waitForTimeout(200);
    check(await chev.evaluate((b) => b === document.activeElement), "keys: Esc from a link closes the menu and focus goes back to the chevron");
    // Tab order: a studio, then its links, then the next studio.
    await chev.focus();
    await p.keyboard.press("Enter");
    await p.waitForFunction(() => document.activeElement?.closest("[data-mega-panel]"), null, { timeout: 10_000 }).catch(() => {});
    await panel(p).locator('[data-group="sell"] a[data-row="0"]').focus();
    // Safari's engine leaves links out of Tab order unless the person turns it on: the arrow keys are its way in.
    if (ENGINE === "webkit") await p.keyboard.press("ArrowDown");
    else await p.keyboard.press("Tab");
    check((await focused(p)).text === "Click to Ad", "Tab goes from a studio to its first link");
    // Enter on a link opens its page.
    await p.keyboard.press("Enter");
    check(await waitUrl(p, (u) => u.pathname === "/marketing/click-to-ad"), "Enter on Click to Ad opens /marketing/click-to-ad", p.url());
    check(await panel(p).waitFor({ state: "hidden", timeout: 2_000 }).then(() => true, () => false), "the menu closes when a link is followed");
    await p.waitForTimeout(800);
    // On a studio's feature, its link is the one marked.
    await openRoute(p, `${app}/ads/multiplier`, { settleMs: 300 });
    await openStudios(p);
    check((await panel(p).locator('a[data-sub][href="/ads/multiplier"]').getAttribute("aria-current")) === "page", "on Ad Multiplier its link is marked as the page");
    check((await panel(p).locator('[aria-current="page"]').count()) === 1, "and nothing else is");
    check((await panel(p).locator('a[href="/marketing"]:not([data-sub])').getAttribute("data-active")) === "", "and Marketing Studio shows it holds the page");
    await p.keyboard.press("Escape");
    // A feature the menu doesn't link for a visitor still marks its studio (Character Sheet's modes).
    await openRoute(p, `${app}/character-sheet?mode=cast`, { settleMs: 300 });
    await openStudios(p);
    check((await panel(p).locator('a[href="/character-sheet"]:not([data-sub])').getAttribute("data-active")) === "", "on Character Sheet's Build from scratch, Character Sheet is marked");
    // Every link resolves (those the window hides too).
    const hrefs = [...new Set(await panel(p).locator("a[data-sub]").evaluateAll((as_) => as_.map((a) => a.getAttribute("href"))))];
    const bad = [];
    for (const h of hrefs) {
      const res = await ctx.request.get(app + h, { maxRedirects: 0 }).catch(() => null);
      if (!res || res.status() >= 400) bad.push(`${h} ${res?.status()}`);
    }
    check(hrefs.length >= 15 && bad.length === 0, `all ${hrefs.length} studio links resolve`, bad.join(", "));
    await p.keyboard.press("Escape");
    check(ctx.errors.length === 0, "keys and links: no console errors", ctx.errors.join(" | "));
    await ctx.close();
  }

  // 3. Deep links open the right tab, from the menu, from the address, and on the same page.
  {
    const ctx = await as("guest");
    const p = await page(ctx);
    for (const [href, tab] of [
      ["/genjutsu?mode=restyle", "Restyle"],
      ["/genjutsu?mode=character", "Character swap"],
      ["/character-sheet?mode=cast", "Build from scratch"],
      ["/character-sheet?mode=describe", "From a description"],
      ["/photodump?tab=instadump", "From a selfie"],
      ["/image-to-3d?mode=text", "From text"],
    ]) {
      await openRoute(p, app + href, { settleMs: 600 });
      check(await selectedTab(p, tab), `${href} opens on its "${tab}" tab`);
    }
    // From the menu, then another of the same studio's links while on it (same page, new query).
    await openRoute(p, `${app}/image`, { settleMs: 300 });
    await openStudios(p);
    await panel(p).locator('a[data-sub][href="/genjutsu?mode=swap"]').click();
    check(await waitUrl(p, (u) => u.pathname === "/genjutsu" && u.searchParams.get("mode") === "swap"), "menu: Object swap opens Genjutsu", p.url());
    check(await selectedTab(p, "Object swap"), "on its Object swap tab");
    await p.waitForTimeout(500);
    await openStudios(p);
    check((await panel(p).locator('a[data-sub][href="/genjutsu?mode=swap"]').getAttribute("aria-current")) === "page", "menu: Object swap is marked as the page");
    await panel(p).locator('a[data-sub][href="/genjutsu?mode=insert"]').click();
    check(await waitUrl(p, (u) => u.searchParams.get("mode") === "insert"), "menu: Insert while on Genjutsu", p.url());
    await p.waitForTimeout(400);
    check(await selectedTab(p, "Insert"), "switches the open studio to its Insert tab");
    // A tab picked on the page goes in the address, so a link to another still switches it.
    await openRoute(p, `${app}/character-sheet?mode=cast`, { settleMs: 600 });
    await p.getByRole("tab", { name: "From a description", exact: true }).click();
    check(await waitUrl(p, (u) => u.searchParams.get("mode") === "describe"), "Character Sheet: a picked tab goes in the address", p.url());
    // The search finds Build from scratch: a link to another tab of the open page switches it.
    await (await openSearch(p)).fill("build from scratch");
    await p.waitForTimeout(500);
    await p.keyboard.press("Enter");
    check(await waitUrl(p, (u) => u.searchParams.get("mode") === "cast"), "Character Sheet: a link to another tab while on it", p.url());
    await p.waitForTimeout(400);
    check(await selectedTab(p, "Build from scratch"), "switches it to that tab");
    await openRoute(p, `${app}/photodump`, { settleMs: 600 });
    await p.getByRole("tab", { name: "From a selfie", exact: true }).click();
    check(await waitUrl(p, (u) => u.searchParams.get("tab") === "instadump"), "Photodump: a picked tab goes in the address", p.url());
    check(ctx.errors.length === 0, "deep links: no console errors", ctx.errors.join(" | "));
    await ctx.close();
  }

  // 4. Phone: the Studios sheet's groups list their studios' features as 44 px pills; All stays one screen.
  for (const who of ["guest", "owner", ...(publicSignup ? ["account"] : [])]) {
    for (const scheme of who === "account" ? ["light"] : ["light", "dark"]) {
      const label = `phone ${who} ${scheme}`;
      const ctx = await as(who, PHONE, { colorScheme: scheme });
      const p = await page(ctx);
      await openRoute(p, `${app}/image`, { settleMs: 300 });
      await p.locator("[data-phone-tabs]").getByRole("button", { name: "Studios" }).tap();
      const sheet = p.locator("#phone-sheet");
      await sheet.waitFor({ state: "visible" });
      const body = sheet.locator('[data-sheet-family="studios"]');
      await body.locator("a[href]").first().waitFor({ timeout: 10_000 });
      check((await body.locator("[data-sheet-subs]").count()) === 0, `${label}: All shows tiles only`);
      check((await body.locator('a[href="/ads"]').count()) === 1, `${label}: All keeps the Ads Studio tile`);
      const chip = (name) => sheet.locator('[role="group"][aria-label="Show the studios for one goal"]').getByRole("button", { name, exact: true });
      for (const [g, studio, want] of [
        // Ads Studio is a tile of Sell (and of All), so not a pill again.
        ["Sell", "Marketing Studio", ["Click to Ad", "Ad Multiplier"]],
        ["People", "Genjutsu", ["Motion transfer", "Character swap", "Object swap", "Restyle", "Insert"]],
        ["Film", "Video tools", ["Remove background", "Relight", "Captions"]],
        ["Finish", "Upscale", ["Image", "Video", "FPS Boost", "SDR to HDR", "Export"]],
      ]) {
        await chip(g).tap();
        await p.waitForTimeout(350);
        const subs = body.locator("[data-sheet-subs]");
        const r = await subs.evaluate((el, name) => {
          const sec = [...el.querySelectorAll("section")].find((s) => s.querySelector("p")?.textContent?.trim().toLowerCase() === name.toLowerCase());
          const pills = sec ? [...sec.querySelectorAll("a")] : [];
          return {
            labels: pills.map((a) => a.textContent.trim()),
            // The pill and its touch area past it (::after on a touch screen: 44 px).
            small: pills
              .map((a) => {
                const after = getComputedStyle(a, "::after");
                const reach = after.content !== "none" && after.position === "absolute" ? Math.max(0, -parseFloat(after.top) || 0) + Math.max(0, -parseFloat(after.bottom) || 0) : 0;
                return [a.textContent.trim(), a.getBoundingClientRect().height + reach];
              })
              .filter(([, h]) => h < 43.5)
              .map(([t, h]) => `${t} ${h}`),
            all: el.innerText,
            sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            wide: [...el.querySelectorAll("a")].filter((a) => a.getBoundingClientRect().right > innerWidth + 0.5).length,
          };
        }, studio);
        check(want.every((w) => r.labels.includes(w)), `${label} ${g}: ${studio}'s features as pills`, r.labels.join(" · "));
        check(r.small.length === 0, `${label} ${g}: pills 44 px tall`, r.small.join(", "));
        check(r.sideways <= 0 && r.wide === 0, `${label} ${g}: no sideways scroll`, `${r.sideways}px, ${r.wide} past the edge`);
        if (who !== "owner") {
          const said = OWNER_SUBS.filter((w) => r.all.split("\n").some((l) => l.trim() === w));
          check(said.length === 0, `${label} ${g}: no pill a visitor can't use`, said.join(", "));
        }
        if (shots && who !== "account" && (g === "Sell" || g === "People")) await shot(p, `phone-sheet-${g.toLowerCase()}-${who}-${scheme}`);
      }
      // Cinema Studio's Blockout is linked for everyone.
      await chip("Film").tap();
      await p.waitForTimeout(300);
      check((await body.locator("[data-sheet-subs]").innerText()).includes("Blockout"), `${label}: Cinema Studio's Blockout in Film`);
      check((await body.locator('[data-sheet-subs] a[href="/cinema?blockout=1"]').count()) === 1, `${label}: Blockout links /cinema?blockout=1`);
      // A pill opens its feature on the right tab.
      await chip("People").tap();
      await p.waitForTimeout(300);
      await body.locator("[data-sheet-subs]").getByRole("link", { name: "Restyle", exact: true }).tap();
      check(await waitUrl(p, (u) => u.pathname === "/genjutsu" && u.searchParams.get("mode") === "restyle"), `${label}: Restyle opens Genjutsu`, p.url());
      check(await selectedTab(p, "Restyle"), `${label}: on its Restyle tab`);
      check(ctx.errors.length === 0, `${label}: no console errors`, ctx.errors.join(" | "));
      await ctx.close();
    }
  }

  // 5. /studios: each section's "Inside these studios" rows.
  for (const who of ["guest", "owner"]) {
    for (const device of [{ viewport: { width: 1440, height: 900 } }, PHONE]) {
      const w = device.viewport.width;
      const label = `/studios ${who} ${w}`;
      const ctx = await as(who, device);
      const p = await page(ctx);
      await openRoute(p, `${app}/studios`, { settleMs: 1200 });
      const sell = p.locator('[data-studio-features="sell"]');
      const text = await sell.innerText().catch(() => "");
      check(["Marketing Studio", "Click to Ad", "Ad Multiplier"].every((x) => text.includes(x)), `${label}: Sell lists Marketing Studio's Click to Ad and Ad Multiplier`, text.replace(/\n/g, " · "));
      const people = await p.locator('[data-studio-features="people"]').innerText().catch(() => "");
      check(["Genjutsu", "Restyle", "Character Sheet", "Build from scratch"].every((x) => people.includes(x)), `${label}: People lists Genjutsu's and Character Sheet's`, people.replace(/\n/g, " · "));
      // The owner's own rows come once the viewer is known.
      const film = await p.locator('[data-studio-features="film"]').innerText().catch(() => "");
      check(film.includes("Blockout"), `${label}: Cinema Studio's Blockout for everyone`);
      const all = await p.locator("[data-studio-features]").allInnerTexts();
      if (who !== "owner") check(!all.join("\n").includes("From picture"), `${label}: no owner-only mode`);
      const r = await p.evaluate(() => ({
        sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        small: [...document.querySelectorAll("[data-studio-features] a")].filter((a) => {
          const after = getComputedStyle(a, "::after");
          const h = a.getBoundingClientRect().height + (after.content !== "none" ? Math.max(0, -parseFloat(after.top) - parseFloat(after.bottom)) : 0);
          return h < 43.5;
        }).length,
      }));
      check(r.sideways <= 0, `${label}: no sideways scroll`, `${r.sideways}px`);
      check(r.small === 0, `${label}: pills 44 px to tap`, `${r.small} smaller`);
      if (shots && who === "guest") {
        await sell.scrollIntoViewIfNeeded();
        await p.waitForTimeout(300);
        await shot(p, `studios-page-sell-${w}-${who}`);
      }
      const hrefs = await p.locator("[data-studio-features] a").evaluateAll((as_) => as_.map((a) => a.getAttribute("href")));
      const bad = [];
      for (const h of new Set(hrefs)) {
        const res = await ctx.request.get(app + h, { maxRedirects: 0 }).catch(() => null);
        if (!res || res.status() >= 400) bad.push(`${h} ${res?.status()}`);
      }
      check(bad.length === 0, `${label}: all ${hrefs.length} feature links resolve`, bad.join(", "));
      check(ctx.errors.length === 0, `${label}: no console errors`, ctx.errors.join(" | "));
      await ctx.close();
    }
  }

  // 6. Search: a feature by its name, under its studio; the owner's own for the owner only.
  for (const who of ["guest", "owner"]) {
    const ctx = await as(who);
    const p = await page(ctx);
    await openRoute(p, `${app}/image`, { settleMs: 500 });
    const ask = async (q) => {
      const input = await openSearch(p);
      await input.fill(q);
      await p.waitForTimeout(500);
      return p.locator("[cmdk-item]").evaluateAll((els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
    };
    const restyle = await ask("restyle");
    check(/Restyle/.test(restyle[0] ?? "") && /Genjutsu/.test(restyle[0] ?? ""), `search (${who}): "restyle" finds Genjutsu › Restyle first`, restyle.slice(0, 3).join(" | "));
    const cta = await ask("click to ad");
    check(/Click to Ad/.test(cta[0] ?? ""), `search (${who}): "click to ad" finds Click to Ad first`, cta.slice(0, 3).join(" | "));
    const blockout = await ask("blockout");
    check(blockout.some((t) => /^Blockout|Blockout Cinema|Cinema Studio.*Blockout|Blockout.*Cinema/.test(t)), `search (${who}): Blockout found`, blockout.slice(0, 3).join(" | "));
    {
      await ask("genjutsu");
      const heads = await p.locator("[cmdk-group-heading]").allInnerTexts();
      const inGen = await p.locator('[cmdk-group]:has([cmdk-group-heading]:text-is("In Genjutsu")) [cmdk-item]').allInnerTexts();
      const modes = ["Motion transfer", "Character swap", "Object swap", "Restyle", "Insert"];
      check(heads.some((h) => h.trim().toLowerCase() === "in genjutsu") && modes.every((m) => inGen.some((t) => t.includes(m))), `search (${who}): "genjutsu" lists its modes right after it`, `${heads.join(" | ")} :: ${inGen.join(" | ").replace(/\s+/g, " ")}`);
    }
    if (who === "guest") {
      await ask("restyle");
      await p.keyboard.press("Enter");
      check(await waitUrl(p, (u) => u.pathname === "/genjutsu" && u.searchParams.get("mode") === "restyle"), "search: Enter on Restyle opens Genjutsu on it", p.url());
      if (shots) {
        await openRoute(p, `${app}/image`, { settleMs: 300 });
        await ask("genjutsu");
        await shot(p, "search-genjutsu-1440-guest");
      }
    }
    await ctx.close();
  }

  // 7. Canvas: the owner's column links Skills as canvases; a visitor's menu doesn't.
  for (const who of ["guest", "owner"]) {
    const ctx = await as(who);
    const p = await page(ctx);
    await openRoute(p, `${app}/image`, { settleMs: 300 });
    await bar(p).locator('[data-bar-menu="canvas"]').click();
    const cp = p.locator("#canvas-launcher");
    await cp.waitFor({ state: "visible" });
    await cp.locator('[data-col="0"][data-row="0"]').first().waitFor({ timeout: 10_000 });
    await p.waitForTimeout(1500);
    const n = await cp.locator('a[href="/canvas?tab=skills"]').count();
    check(n === (who === "owner" ? 1 : 0), `Canvas menu (${who}): Skills as canvases ${who === "owner" ? "linked" : "not linked"}`, String(n));
    const fit = await cp.evaluate((el) => el.scrollHeight - el.clientHeight);
    check(fit <= 1, `Canvas menu (${who}): no scrolling inside`, String(fit));
    if (shots && who === "owner") await shot(p, "canvas-1440-owner");
    await ctx.close();
  }
} catch (e) {
  check(false, "run", e.stack ?? String(e));
} finally {
  for (const { ctx, password } of accounts) await ctx.request.delete(`${app}/api/auth/me`, { data: { password } }).catch(() => {});
  await browser.close();
}
console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
