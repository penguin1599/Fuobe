// The bar's grouped menus in a real browser: Studios, Apps, Motions & effects and Canvas, for a guest, an account and
// the owner, at the desktop sizes they must fit without scrolling; their keys, links, loading and budgets; the phone's
// Studios sheet with its four families; the Canvas menu's pictures sharp on 2x and 3x screens; and the Canvas ready
// boards' covers on /canvas.
// Usage: node tests/e2e/mega-menus.mjs [appUrl] [shotsDir]
//   E2E_BROWSER=webkit (Safari's engine) or firefox runs it there (the loading and budget checks are Chromium's).
//   E2E_OWNER_PASSWORD: the studio's password, when it has one. Account checks need public sign-up (throwaway qa
//   accounts, deleted at the end). MEGA_JS_BASELINE: a JSON file {"/": kB, "/apps": kB} of the cold JS a guest fetches
//   on main, to hold this build to +4 kB of it. MEGA_JS_APP: where to measure that, when the baseline came from a
//   server started with other settings (the same build started the same way as main's); defaults to appUrl.
// Exits 1 if any check fails; shots of every open menu (1280, 1440, 1920; phone 390), light and dark, guest and owner,
// go to shotsDir when given.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { ENGINE, launch, openRoute, PHONE, root } from "./_browser.mjs";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const app = (args[0] ?? "http://localhost:3000").replace(/\/$/, "");
const shots = args[1];
if (shots) fs.mkdirSync(shots, { recursive: true });
const failures = [];
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${what}${!ok && detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(what);
};
const shot = async (page, name) => shots && (await page.screenshot({ path: path.join(shots, `${name}.png`) }));
const publicSignup = !!(await fetch(`${app}/api/auth/me`).then((r) => r.json()).catch(() => null))?.publicSignup;
/** Words a visitor never reads in a menu or on /canvas (owner-only status and model names). */
const OWNER_WORDS = ["No cover yet", "Fuobe DoP", "free on your GPU", "Qwen", "Wan 2", "LTX", "Kling", "ComfyUI"];

const MENUS = {
  studios: { line: /^\d+ studios, grouped by what you want to make$/, groups: 6, seeAll: "/studios", from: 0 },
  apps: { line: /^\d+ apps, grouped by what they change$/, groups: 6, seeAll: "/apps", from: 1280 },
  motions: { line: /^\d+ camera motions and \d+ effects, for any photo$/, groups: 6, seeAll: "/motions-and-effects", from: 1280 },
  canvas: { line: /^\d+ ready boards that run as they are$/, groups: 2, seeAll: "/canvas", from: 1440 },
};
const SIZES = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1680, height: 1050 },
  { width: 1920, height: 1080 },
];
const SHOT_WIDTHS = [1280, 1440, 1920];

const browser = await launch();
const accounts = [];

/** One throwaway qa account for the whole run (sign-up is rate limited), in a context kept open to delete it at the end. */
let accountState;
async function account() {
  if (!accountState) {
    const ctx = await browser.newContext();
    const email = `qa-mega-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.com`;
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
  // Not errors: a resource that failed to load (its own checks catch those), and WebKit's words for a route's
  // prefetch cut short by following a link ("… _rsc=… due to access control checks", logged or thrown).
  const noise = (t) => /Failed to load resource/.test(t) || (/_rsc=/.test(t) && /due to access control checks/.test(t));
  p.on("pageerror", (e) => !noise(e.message) && ctx.errors.push(`uncaught: ${e.message.split("\n")[0]}`));
  p.on("console", (m) => m.type() === "error" && !noise(m.text()) && ctx.errors.push(m.text().slice(0, 200)));
  return p;
}
const bar = (p) => p.locator("[data-top-bar]");
/** A menu's item in the bar: one button (bar-menus.tsx). */
const trig = (p, id) => bar(p).locator(`[data-bar-menu="${id}"]`);
const panelOf = (p, id) => p.locator(`#${id}-launcher`);
const pathOf = (p) => new URL(p.url()).pathname;
const at = (p) => p.evaluate(() => [document.activeElement?.getAttribute("data-col"), document.activeElement?.getAttribute("data-row")].join(","));
const waitPath = (p, want) => p.waitForURL((u) => new URL(u).pathname === want, { timeout: 20_000 }).then(() => true, () => false);

/** Opens a menu with its item and waits for its links and pictures. */
async function openMenu(p, id) {
  await trig(p, id).click();
  const panel = panelOf(p, id);
  await panel.waitFor({ state: "visible" });
  // Its first column's first item (the owner's Canvas column comes a moment after the rest).
  await panel.locator('[data-col="0"][data-row="0"]').first().waitFor({ timeout: 10_000 });
  await p
    .waitForFunction((sel) => [...document.querySelectorAll(`${sel} img`)].filter((i) => i.checkVisibility()).every((i) => i.complete), `#${id}-launcher`, { timeout: 10_000 })
    .catch(() => {});
  await p.waitForTimeout(250);
  return panel;
}

/** What an open panel shows: its header, fit, columns, pictures and words. */
const measure = (panel) =>
  panel.evaluate((el) => {
    const links = [...el.querySelectorAll("[data-col]")].filter((a) => a.checkVisibility());
    const imgs = [...el.querySelectorAll("img")].filter((i) => i.checkVisibility());
    // Values that differ by more than a pixel (rounded), or none when they all agree within one.
    const spread = (v) => (v.length && Math.max(...v) - Math.min(...v) > 1 ? [...new Set(v.map(Math.round))] : []);
    return {
      line: el.querySelector("[data-count-line]")?.textContent?.trim() ?? "",
      inner: el.scrollHeight - el.clientHeight,
      groups: el.querySelectorAll("[data-group]").length,
      links: links.length,
      offscreen: links.filter((a) => {
        const r = a.getBoundingClientRect();
        return r.bottom > innerHeight + 0.5 || r.right > innerWidth + 0.5 || r.top < 0;
      }).length,
      broken: imgs.filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.getAttribute("src")),
      foreign: imgs.filter((i) => !/^\/(previews|samples)\//.test(new URL(i.currentSrc || i.src, location.href).pathname)).map((i) => i.src),
      text: el.innerText,
      // Lead cards of one height, and every column's first row on one line (a list column's row 1).
      // (Within a pixel: columns of a fractional width round their 4:3 covers either way.)
      leads: spread([...el.querySelectorAll('a[data-row="0"][class*="group/lead"]')].filter((a) => a.checkVisibility()).map((a) => a.getBoundingClientRect().height)),
      firstRows: spread([...el.querySelectorAll('[data-group] > ul > li > a[data-row="1"]')].filter((a) => a.checkVisibility()).map((a) => a.getBoundingClientRect().top)),
      // Lines cut with "…" (a row's or a lead's line wider than its box).
      cut: [...el.querySelectorAll("[data-col] span.truncate.text-muted-foreground")].filter((s) => s.checkVisibility() && s.scrollWidth > s.clientWidth + 1).map((s) => s.textContent),
      rowsMax: Math.max(0, ...[...el.querySelectorAll("[data-group] > ul")].map((u) => [...u.querySelectorAll(':scope > li > a[data-row]:not([data-row="0"])')].filter((a) => a.checkVisibility()).length)),
      lit: document.querySelectorAll("[data-top-bar] [data-bar-menu][data-open]").length,
      panels: [...document.querySelectorAll("[data-mega-panel]")].filter((x) => !x.hidden).length,
    };
  });

try {
  // 1. Every menu, every viewer, every size: header, columns, fit, pictures, words; Esc gives focus back.
  for (const who of ["guest", "owner", ...(publicSignup ? ["account"] : [])]) {
    for (const size of SIZES) {
      const ctx = await as(who, { viewport: size });
      const p = await page(ctx);
      await openRoute(p, `${app}/image`, { settleMs: 300 });
      const label = `${who} ${size.width}x${size.height}`;
      for (const [id, m] of Object.entries(MENUS)) {
        if (size.width < m.from) {
          check(!(await trig(p, id).isVisible()), `${label} ${id}: in More at this width`);
          continue;
        }
        const panel = await openMenu(p, id);
        const r = await measure(panel);
        check(m.line.test(r.line), `${label} ${id}: header line with its count`, r.line);
        check(r.inner <= 1 && r.offscreen === 0, `${label} ${id}: every item on screen, no scrolling inside`, `inner ${r.inner}, ${r.offscreen}/${r.links} off screen`);
        check(r.groups === m.groups, `${label} ${id}: ${m.groups} groups`, String(r.groups));
        check(r.broken.length === 0 && r.foreign.length === 0, `${label} ${id}: every picture loaded, from /previews/`, [...r.broken, ...r.foreign].slice(0, 3).join(" "));
        check(r.lit === 1 && r.panels === 1, `${label} ${id}: one bar item open, one panel`, `${r.lit} lit, ${r.panels} panels`);
        if (id !== "canvas") {
          check(r.leads.length <= 1, `${label} ${id}: lead cards of one height`, r.leads.join(", "));
          check(r.firstRows.length <= 1, `${label} ${id}: first rows on one line`, r.firstRows.join(", "));
          check(r.rowsMax <= 7, `${label} ${id}: at most seven rows under a lead`, String(r.rowsMax));
        }
        if (size.width >= 1440) check(r.cut.length === 0, `${label} ${id}: no line cut off`, r.cut.slice(0, 4).join(" | "));
        if (who !== "owner") {
          const said = OWNER_WORDS.filter((w) => r.text.includes(w));
          check(said.length === 0, `${label} ${id}: no owner-only words`, said.join(", "));
        }
        if (shots && who !== "account" && SHOT_WIDTHS.includes(size.width)) await shot(p, `${id}-${size.width}-${who}-light`);
        await p.keyboard.press("Escape");
        await panel.waitFor({ state: "hidden" });
        const back = await trig(p, id).evaluate((b) => b === document.activeElement);
        check(back, `${label} ${id}: Esc closes it and focus goes back to the item`);
      }
      check(ctx.errors.length === 0, `${label}: no console errors`, ctx.errors.join(" | "));
      await ctx.close();
    }
  }

  // 1b. Dark shots.
  if (shots) {
    for (const who of ["guest", "owner"]) {
      for (const width of SHOT_WIDTHS) {
        const size = SIZES.find((s) => s.width === width);
        const ctx = await as(who, { viewport: size }, { colorScheme: "dark" });
        const p = await page(ctx);
        await openRoute(p, `${app}/image`, { settleMs: 300 });
        for (const [id, m] of Object.entries(MENUS)) {
          if (width < m.from) continue;
          const panel = await openMenu(p, id);
          await shot(p, `${id}-${width}-${who}-dark`);
          await p.keyboard.press("Escape");
          await panel.waitFor({ state: "hidden" });
        }
        await ctx.close();
      }
    }
  }

  // 1c. One spacing system (nav-subs.css, mega-panel.tsx): in every list column, a feature's name starts on its
  // studio's text column and the hairline ends at the last feature shown; rows 44 px (40 below lg), 4 px apart, on
  // whole pixels; a card 8 px above the next row (4 above its features), a feature list 4 px above it; See all 32 px;
  // Canvas' tiles on their column's edge and top, on whole pixels; no name cut beside a New badge (and from 1440 px
  // Fuobe Kinetic Motion's badge beside its name); every row's line shown from 1280 px unless a two-line name takes it.
  {
    const widths = {};
    for (const who of ["guest", "owner"]) {
      for (const size of [{ width: 1024, height: 768 }, ...SIZES]) {
        const ctx = await as(who, { viewport: size });
        const p = await page(ctx);
        await openRoute(p, `${app}/image`, { settleMs: 300 });
        const label = `${who} ${size.width}x${size.height}`;
        for (const [id, m] of Object.entries(MENUS)) {
          if (size.width < m.from) continue;
          const panel = await openMenu(p, id);
          const r = await panel.evaluate((el) => {
            const vis = (n) => !!n && n.checkVisibility();
            const box = (n) => n.getBoundingClientRect();
            // Where an element's first words start (a Range on its first text node).
            const textX = (n) => {
              const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.textContent.trim() && vis(t.parentElement) ? 1 : 3) });
              const t = w.nextNode();
              if (!t) return NaN;
              const rg = document.createRange();
              rg.selectNodeContents(t);
              return rg.getClientRects()[0]?.left ?? NaN;
            };
            const near = (a, b, tol = 0.75) => Math.abs(a - b) <= tol;
            const out = { text: [], line: [], gaps: [], heights: [], halves: [], cut: [], badge: [], clipped: [], seeAll: [], seeAllHalves: [], canvas: [], tileHalves: [], widths: [], beside: {}, noLine: [] };
            for (const group of el.querySelectorAll("[data-group]")) {
              const list = group.querySelector(":scope > ul");
              const colX = box(group).left;
              out.widths.push(box(group).width);
              // Tiles (Canvas) are checked below; the owner's Canvas column (New board, recent boards) has its own rows.
              if (!list || list.classList.contains("grid") || list.querySelector(":scope > li > button")) continue;
              let prev = null; // { kind: "card" | "row" | "subs", bottom }
              for (const li of [...list.children].filter(vis)) {
                const a = li.querySelector(":scope > a");
                if (!a) continue;
                const subs = li.querySelector(":scope > ul.nav-subs");
                const lead = a.matches('[class*="group/lead"]');
                const ab = box(a);
                if (prev) out.gaps.push({ at: a.textContent.trim().slice(0, 24), from: prev.kind, gap: +(ab.top - prev.bottom).toFixed(2), want: prev.kind === "card" ? 8 : 4 });
                if (!lead) {
                  out.heights.push({ at: a.textContent.trim().slice(0, 24), h: +ab.height.toFixed(2) });
                  if (Math.abs(ab.top - Math.round(ab.top)) > 0.05) out.halves.push(`${a.textContent.trim().slice(0, 24)} ${ab.top.toFixed(2)}`);
                }
                prev = { kind: lead ? "card" : "row", bottom: ab.bottom };
                const name = lead ? a.querySelector(".nav-mark-start > span > span") : a.querySelector("[data-row-name]");
                const nameX = textX(name);
                // Every row's name shows whole inside its words' box (a two-line name pushes its line out, never itself).
                const holderBox = !lead && a.querySelector("[data-row-text]");
                if (holderBox && (box(name).top < box(holderBox).top - 0.5 || box(name).bottom > box(holderBox).bottom + 0.5 || name.scrollHeight > name.clientHeight + 0.5))
                  out.clipped.push(a.textContent.trim().slice(0, 30));
                if (lead) out.text.push({ at: "lead", x: +(nameX - colX).toFixed(2), want: 12 });
                // A name beside (or above) its New badge keeps all its words, and the badge shows whole.
                const badge = a.querySelector("[data-new]");
                if (badge) {
                  if (name.scrollWidth > name.clientWidth + 0.5 || name.scrollHeight > name.clientHeight + 0.5) out.cut.push(a.textContent.trim().slice(0, 30));
                  const holder = badge.parentElement;
                  if (box(badge).bottom > box(holder).bottom + 0.5 || box(badge).right > box(holder).right + 0.5) out.badge.push(a.textContent.trim().slice(0, 30));
                  // Beside: the badge's middle on the name's first line.
                  out.beside[name.textContent.trim()] = Math.abs((box(badge).top + box(badge).bottom) / 2 - (box(name).top + 9)) <= 3;
                }
                // A row's line shows inside its words' box, unless its name takes two lines.
                const rowLine = holderBox && [...holderBox.children].find((c) => c !== name && !c.matches("[data-new]"));
                if (rowLine && rowLine.textContent.trim() && box(name).height < 20 && (!vis(rowLine) || box(rowLine).bottom > box(holderBox).bottom + 0.5))
                  out.noLine.push(name.textContent.trim().slice(0, 24));
                if (vis(subs)) {
                  const first = [...subs.querySelectorAll(":scope > li > a")].find(vis);
                  const links = [...subs.querySelectorAll(":scope > li")].filter(vis);
                  const sb = box(subs);
                  out.gaps.push({ at: `${a.textContent.trim().slice(0, 16)}'s features`, from: lead ? "card" : "row", gap: +(sb.top - ab.bottom).toFixed(2), want: lead ? 4 : 0 });
                  // Under a card, or under a row without its thumbnail: the card's 12 px column; else the row's name.
                  const words = a.querySelector(":scope > [data-row-text]");
                  const thumb = !lead && [...a.children].some((c) => c !== words && vis(c));
                  const want = lead || !thumb ? 12 : nameX - colX;
                  out.text.push({ at: `${a.textContent.trim().slice(0, 16)}'s features`, x: +(textX(first) - colX).toFixed(2), want: +want.toFixed(2) });
                  const before = getComputedStyle(subs, "::before");
                  const lineBottom = sb.bottom - (parseFloat(before.bottom) || 0);
                  const last = links.at(-1);
                  if (!matchMedia("(pointer: coarse)").matches && !near(lineBottom, box(last).bottom)) out.line.push(`${a.textContent.trim().slice(0, 16)}: ${(lineBottom - box(last).bottom).toFixed(1)} past`);
                  prev = { kind: "subs", bottom: box(last).bottom };
                }
              }
            }
            for (const s of el.querySelectorAll("a:not([data-sub])"))
              if (vis(s) && /^See all/.test(s.textContent.trim())) {
                out.seeAll.push(+box(s).height.toFixed(2));
                if (Math.abs(box(s).top - Math.round(box(s).top)) > 0.05) out.seeAllHalves.push(`${s.getAttribute("aria-label") ?? "See all"} ${box(s).top.toFixed(2)}`);
              }
            // Canvas: a tile's picture on its column's edge, the first row's tops on the lead column's first item.
            const tiles = [...el.querySelectorAll("[data-group] > ul.grid")].filter(vis);
            if (tiles.length) {
              const firstItem = [...el.querySelectorAll("[data-group]")].filter((g) => !g.querySelector(":scope > ul.grid")).map((g) => [...g.querySelectorAll("a, button")].find(vis))[0];
              for (const ul of tiles) {
                const g = ul.closest("[data-group]");
                const ib = box(ul.querySelector(":scope > li > a > *"));
                out.canvas.push({ dx: +(ib.left - box(g).left).toFixed(2), top: +ib.top.toFixed(2), lead: firstItem ? +box(firstItem).top.toFixed(2) : null });
                for (const t of ul.querySelectorAll(":scope > li > a")) if (vis(t) && Math.abs(box(t).top - Math.round(box(t).top)) > 0.05) out.tileHalves.push(`${t.textContent.trim().slice(0, 20)} ${box(t).top.toFixed(2)}`);
              }
            }
            return out;
          });
          const rowH = size.width >= 1024 ? 44 : 40;
          const offText = r.text.filter((t) => Math.abs(t.x - t.want) > 0.75);
          check(offText.length === 0, `${label} ${id}: features start on their studio's text column, card words 12 px in`, offText.map((t) => `${t.at} ${t.x}/${t.want}`).join(", "));
          check(r.line.length === 0, `${label} ${id}: each hairline ends at its last feature`, r.line.join(", "));
          const offGap = r.gaps.filter((g) => Math.abs(g.gap - g.want) > 0.75);
          check(offGap.length === 0, `${label} ${id}: rows 4 px apart, a card 8 (4 to its features), a feature list 4`, offGap.slice(0, 5).map((g) => `${g.at} after ${g.from} ${g.gap}/${g.want}`).join(", "));
          const offH = r.heights.filter((h) => Math.abs(h.h - rowH) > 0.5);
          check(offH.length === 0, `${label} ${id}: rows ${rowH} px tall`, offH.slice(0, 5).map((h) => `${h.at} ${h.h}`).join(", "));
          check(r.halves.length === 0, `${label} ${id}: every row on a whole pixel`, r.halves.slice(0, 4).join(", "));
          if (size.width >= 1280) check(r.cut.length === 0 && r.badge.length === 0, `${label} ${id}: no name cut beside a New badge, the badge whole`, [...r.cut, ...r.badge].join(", "));
          check(r.clipped.length === 0, `${label} ${id}: every row's name whole, none pushed out of its row`, r.clipped.join(", "));
          check(r.seeAll.every((h) => Math.abs(h - 32) <= 0.5), `${label} ${id}: every See all 32 px`, r.seeAll.join(", "));
          check(r.seeAllHalves.length === 0, `${label} ${id}: every See all on a whole pixel`, r.seeAllHalves.join(", "));
          if (size.width >= 1440 && "Fuobe Kinetic Motion" in r.beside) check(r.beside["Fuobe Kinetic Motion"], `${label} ${id}: Fuobe Kinetic Motion's New badge beside its name`, JSON.stringify(r.beside));
          if (size.width >= 1280) check(r.noLine.length === 0, `${label} ${id}: every one-line row shows its line`, r.noLine.join(", "));
          if (id === "canvas") check(r.tileHalves.length === 0, `${label} canvas: every tile on a whole pixel`, r.tileHalves.join(", "));
          if (id === "canvas")
            check(r.canvas.every((c) => Math.abs(c.dx) <= 0.75 && c.lead !== null && Math.abs(c.top - c.lead) <= 0.75) || r.canvas.length === 0, `${label} canvas: tiles on their column's edge, level with the first column`, JSON.stringify(r.canvas));
          if (id === "studios") (widths[size.width] ??= []).push(...r.widths);
          await p.keyboard.press("Escape");
          await panel.waitFor({ state: "hidden" });
        }
        await ctx.close();
      }
    }
    // Wider windows never get narrower columns (the panel stops at 1680 px with one gutter).
    const w = (x) => Math.min(...(widths[x] ?? [0]));
    check(w(1920) >= w(1440) - 0.5, "Studios: columns at 1920 at least as wide as at 1440", `${w(1440).toFixed(1)} → ${w(1920).toFixed(1)}`);
  }

  // 1d. Canvas' pictures are sharp: each loads a copy at least as wide as its box times the screen's pixel ratio
  // (the copies its srcset lists: from 1680 px the lead asks 1068 px at 2x and takes the widest, 1024), in the panel at
  // 1440 and 1920 px on a 2x screen, and on the phone sheet at 3x.
  {
    /** Each picture shown under `sel`: the width of the file it loaded, the width its box asks for and the widest it lists. */
    const sharpness = (p, sel) =>
      p.evaluate(async (sel) => {
        const out = [];
        for (const img of [...document.querySelectorAll(`${sel} img`)].filter((i) => i.checkVisibility() && !/\bblur/.test(i.className))) {
          const r = img.getBoundingClientRect();
          if (r.bottom < 0 || r.top > innerHeight) continue;
          const probe = new Image();
          probe.src = img.currentSrc || img.src;
          await probe.decode().catch(() => {});
          const listed = [img, ...(img.parentElement?.tagName === "PICTURE" ? img.parentElement.querySelectorAll("source") : [])]
            .flatMap((x) => (x.getAttribute("srcset") ?? "").split(",").map((c) => Number(/\s(\d+)w$/.exec(c.trim())?.[1] ?? 0)));
          const need = Math.ceil(Math.max(r.width, probe.naturalHeight ? r.height * (probe.naturalWidth / probe.naturalHeight) : 0) * devicePixelRatio);
          out.push({ src: new URL(probe.src).pathname, file: probe.naturalWidth, need, widest: Math.max(probe.naturalWidth, ...listed) });
        }
        return out;
      }, sel);
    const report = (list) => list.map((x) => `${x.src.split("/").slice(-3).join("/")} ${x.file}/${x.need}`).join(", ");
    for (const width of [1440, 1920]) {
      const size = SIZES.find((s) => s.width === width);
      const ctx = await as("guest", { viewport: size, deviceScaleFactor: 2 });
      const p = await page(ctx);
      await openRoute(p, `${app}/image`, { settleMs: 300 });
      await openMenu(p, "canvas");
      await p.waitForTimeout(500);
      const list = await sharpness(p, "#canvas-launcher");
      const soft = list.filter((x) => x.file < Math.min(x.need, x.widest) - 1 || (width === 1440 && x.file < x.need - 1));
      check(list.length >= 5 && soft.length === 0, `guest ${width}x${size.height} at 2x canvas: every picture at least its box x 2 (${list.length})`, report(soft));
      if (shots) await shot(p, `canvas-${width}-2x`);
      await ctx.close();
    }
    {
      const ctx = await as("guest", { ...PHONE, deviceScaleFactor: 3 });
      const p = await page(ctx);
      await openRoute(p, `${app}/image`, { settleMs: 300 });
      await p.locator("[data-phone-tabs]").getByRole("button", { name: "Studios" }).tap();
      const sheet = p.locator("#phone-sheet");
      await sheet.waitFor({ state: "visible" });
      await sheet.getByRole("group", { name: "What to show" }).getByRole("button", { name: "Canvas", exact: true }).tap();
      await sheet.locator('[data-sheet-family="canvas"] a[href]').first().waitFor({ timeout: 10_000 });
      await p.waitForFunction(() => [...document.querySelectorAll('[data-sheet-family="canvas"] img')].every((i) => i.complete), null, { timeout: 10_000 }).catch(() => {});
      const list = await sharpness(p, '[data-sheet-family="canvas"]');
      const soft = list.filter((x) => x.file < x.need - 1);
      check(list.length >= 2 && soft.length === 0, `guest phone 390 at 3x canvas: every board's picture at least its box x 3 (${list.length})`, report(soft));
      await ctx.close();
    }
  }

  // 2. Keys, one panel at a time, links and See all (guest, 1440x900).
  {
    const ctx = await as("guest");
    const p = await page(ctx);
    await openRoute(p, `${app}/image`, { settleMs: 300 });
    for (const id of ["apps", "motions", "canvas"]) {
      const item = trig(p, id);
      await item.focus();
      await p.keyboard.press("Enter");
      const panel = panelOf(p, id);
      await panel.waitFor({ state: "visible" });
      check(await item.evaluate((b) => b === document.activeElement), `${id}: Enter on the item opens it, focus stays on the item`);
      await p.keyboard.press("Enter");
      await panel.waitFor({ state: "hidden" });
      await p.keyboard.press("ArrowDown");
      await panel.waitFor({ state: "visible" });
      await p.waitForFunction(() => document.activeElement?.closest("[data-mega-panel]"), null, { timeout: 10_000 }).catch(() => {});
      check((await at(p)) === "0,0", `${id}: ArrowDown on the item opens it on the first lead`, await at(p));
      await p.keyboard.press("ArrowRight");
      check((await at(p)) === "1,0", `${id}: Right goes to the next column's first item`, await at(p));
      await p.keyboard.press("ArrowDown");
      const down = await at(p);
      check(down === "1,1", `${id}: Down goes down the column`, down);
      await p.keyboard.press("End");
      const end = await at(p);
      await p.keyboard.press("Home");
      check((await at(p)) === "1,0" && end.startsWith("1,"), `${id}: End and Home go to the column's ends`, `${end} → ${await at(p)}`);
      await p.keyboard.press("ArrowLeft");
      check((await at(p)) === "0,0", `${id}: Left comes back`, await at(p));
      if (id === "motions") {
        // From the last camera-motion column to the first effects column.
        for (let i = 0; i < 3; i++) await p.keyboard.press("ArrowRight");
        const fam = await p.evaluate(() => document.activeElement?.closest("[data-group]")?.getAttribute("data-group"));
        check((await at(p)) === "3,0" && !["push", "orbit", "handheld"].includes(fam ?? ""), "motions: Right crosses from camera motions to effects", `${await at(p)} ${fam}`);
      }
      // Every item's link resolves (rows the window hides too).
      const hrefs = [...new Set(await panel.locator("a[href]").evaluateAll((as_) => as_.map((a) => a.getAttribute("href"))))];
      const bad = [];
      for (const h of hrefs) {
        const res = await ctx.request.get(app + h, { maxRedirects: 0 }).catch(() => null);
        if (!res || res.status() >= 400) bad.push(`${h} ${res?.status()}`);
      }
      check(bad.length === 0, `${id}: all ${hrefs.length} links resolve`, bad.slice(0, 5).join(", "));
      // Tab past the last link closes it.
      // (The last link on screen: rows the window's height hides can't take focus.)
      await panel.locator("a[href]:visible").last().focus();
      await p.keyboard.press("Tab");
      await p.waitForTimeout(150);
      check(!(await panel.isVisible()), `${id}: Tab past its last link closes it`);
    }
    // ArrowDown on the item opens; Esc gives focus back to the item.
    for (const id of ["apps", "canvas"]) {
      const item = trig(p, id);
      await item.focus();
      await p.keyboard.press("ArrowDown");
      await p.waitForFunction(() => document.activeElement?.closest("[data-mega-panel]"), null, { timeout: 10_000 }).catch(() => {});
      check((await at(p)) === "0,0", `${id}: ArrowDown on the item opens it on the first lead`);
      await p.keyboard.press("Escape");
      await p.waitForTimeout(150);
      check(await item.evaluate((a) => a === document.activeElement), `${id}: Esc gives focus back to the item`);
    }
    // One at a time: a grouped menu replaces another, and Create's menu and a grouped menu close each other.
    await openMenu(p, "apps");
    await openMenu(p, "motions");
    check(!(await panelOf(p, "apps").isVisible()) && (await panelOf(p, "motions").isVisible()), "opening Motions & effects closes Apps");
    await trig(p, "create").click();
    await p.locator("#create-menu").waitFor({ timeout: 5_000 }).catch(() => {});
    await p.waitForTimeout(200);
    check(!(await panelOf(p, "motions").isVisible()) && (await p.locator("#create-menu").isVisible()), "opening Create closes Motions & effects");
    await p.keyboard.press("Escape");
    await p.waitForTimeout(200);
    // Resting the mouse: every grouped menu opens after a moment (not at once), keeps focus where it was, and closes
    // once the pointer leaves the item and the panel. While one is open, moving onto another item switches at once.
    for (const id of ["studios", "apps", "canvas"]) {
      await p.mouse.move(6, 28);
      await p.waitForTimeout(400);
      const box = await trig(p, id).boundingBox();
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await p.waitForTimeout(30);
      const early = await panelOf(p, id).isVisible();
      await p.waitForTimeout(500);
      check(!early && (await panelOf(p, id).isVisible()), `resting on ${id} opens its menu after a moment, not at once`);
      await p.mouse.move(6, 28, { steps: 4 });
      await p.waitForTimeout(600);
      check(!(await panelOf(p, id).isVisible()), `${id}: moving the mouse off the item and the panel closes it`);
    }
    {
      await openMenu(p, "apps");
      const box = await trig(p, "canvas").boundingBox();
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await p.waitForTimeout(80);
      // (Apps may still be fading out under it for a moment: inert, no longer open.)
      check((await panelOf(p, "canvas").getAttribute("data-phase")) === "open" && (await panelOf(p, "apps").getAttribute("data-phase")) !== "open", "with Apps open, moving onto Canvas switches to it at once");
      await p.keyboard.press("Escape");
      await p.mouse.move(6, 28);
      await p.waitForTimeout(600);
    }
    {
      await p.mouse.move(700, 700);
      const focusWas = await p.evaluate(() => document.activeElement?.tagName ?? "");
      const box = await trig(p, "motions").boundingBox();
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await p.waitForTimeout(700);
      check(await panelOf(p, "motions").isVisible(), "resting on Motions & effects opens its menu");
      check((await p.evaluate(() => !document.activeElement?.closest("[data-mega-panel]"))) && focusWas !== "", "opened by resting: focus stays where it was");
      // Into the panel and back out: it stays while the pointer is over it, then closes.
      const pb = await panelOf(p, "motions").boundingBox();
      await p.mouse.move(pb.x + pb.width / 2, pb.y + 120, { steps: 6 });
      await p.waitForTimeout(500);
      check(await panelOf(p, "motions").isVisible(), "Motions & effects stays open while the pointer is on its panel");
      await p.mouse.move(6, 28, { steps: 4 }); // the bar's far left: off the item and the panel
      await p.waitForTimeout(600);
      check(!(await panelOf(p, "motions").isVisible()), "and closes once the pointer leaves it");
      // A click on the item while hover-open keeps it open (pinned).
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await p.waitForTimeout(700);
      await trig(p, "motions").click();
      await p.mouse.move(700, 800);
      await p.waitForTimeout(600);
      check(await panelOf(p, "motions").isVisible(), "a click pins Motions & effects open after hovering");
      await p.keyboard.press("Escape");
      await p.waitForTimeout(200);
    }
    await p.mouse.move(700, 700);
    // See all, and the families' See all.
    for (const [id, name, want] of [
      ["apps", "See all apps", "/apps"],
      ["motions", "See all motions and effects", "/motions-and-effects"],
      ["motions", "See all camera motions", "/motions"],
      ["motions", "See all effects", "/effects"],
      ["canvas", "See all of Canvas", "/canvas"],
    ]) {
      await openRoute(p, `${app}/image`, { settleMs: 300 });
      const panel = await openMenu(p, id);
      await panel.getByRole("link", { name, exact: true }).click();
      check(await waitPath(p, want), `${id}: "${name}" opens ${want}`, pathOf(p));
    }
    // A row marks the page it is on.
    await openRoute(p, `${app}/apps`, { settleMs: 300 });
    const firstApp = await (async () => {
      const panel = await openMenu(p, "apps");
      return panel.locator('[data-col="0"][data-row="1"]').getAttribute("href");
    })();
    await openRoute(p, app + firstApp, { settleMs: 300 });
    const panel = await openMenu(p, "apps");
    check((await panel.locator(`a[href="${firstApp}"]`).getAttribute("aria-current")) === "page", "apps: the open app's row is marked as the page");
    check(ctx.errors.length === 0, "keys and links: no console errors", ctx.errors.join(" | "));
    await ctx.close();
  }

  // 3. Loading and budgets (guest, cold, 1440x900): read from Chromium's DevTools protocol, so in Chromium only.
  if (ENGINE !== "chromium") console.log(`  loading and budgets: Chromium only (this run: ${ENGINE})`);
  else {
    const ctx = await as("guest");
    const p = await page(ctx);
    const cdp = await ctx.newCDPSession(p);
    await cdp.send("Network.enable");
    const urls = new Map();
    const bytes = new Map();
    const at_ = new Map();
    cdp.on("Network.requestWillBeSent", (e) => {
      urls.set(e.requestId, e.request.url);
      at_.set(e.requestId, Date.now());
    });
    cdp.on("Network.loadingFinished", (e) => bytes.set(e.requestId, e.encodedDataLength));
    await p.addInitScript(() => {
      window.__cls = 0;
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
      }).observe({ type: "layout-shift", buffered: true });
    });
    await p.goto(`${app}/image`, { waitUntil: "domcontentloaded" });
    const early = [...urls.values()].filter((u) => u.includes("/nav-menus/")).length;
    await p.waitForLoadState("load");
    await p.waitForTimeout(4000);
    const idle = [...urls.values()].filter((u) => u.includes("/nav-menus/"));
    const minis = [...urls.values()].filter((u) => /\/previews\/presets\/mini\//.test(u)).length;
    check(early === 0, "no menu data with the page itself");
    check(idle.length === 3, "idle: the three menus' data (apps, motions, canvas), once each", idle.map((u) => new URL(u).pathname).join(" "));
    check(minis === 0, "idle: no menu pictures before a menu warms", String(minis));
    // Gzipped as the site's front server sends it (next start here may send it plain).
    const sizes = [];
    for (const u of new Set(idle)) sizes.push([new URL(u).pathname, zlib.gzipSync(Buffer.from(await (await fetch(u)).arrayBuffer())).length]);
    check(sizes.length === 3 && sizes.every(([, b]) => b > 0 && b <= 4096), "each menu's data is at most 4 KB gzipped", sizes.map(([u, b]) => `${u} ${b}`).join(", "));
    // Warm, then open: the panel shows within a frame of the click; pictures within budget; nothing moves.
    for (const id of ["apps", "motions", "canvas"]) {
      const since = Date.now();
      const item = trig(p, id);
      await item.hover();
      await p.waitForTimeout(1200);
      await p.evaluate(() => (window.__cls = 0));
      const ms = await p.evaluate(async (sel) => {
        const b = document.querySelector(`[data-mega-trigger="${sel}"]`);
        const t0 = performance.now();
        b.click();
        await new Promise((r) => requestAnimationFrame(() => r()));
        const panel = document.getElementById(`${sel}-launcher`);
        return panel && !panel.hidden && panel.querySelector("[data-col]") ? performance.now() - t0 : -1;
      }, id);
      check(ms >= 0 && ms < 100, `${id}: shows within 100 ms of the click once warmed`, `${ms.toFixed?.(1)} ms`);
      await p.waitForTimeout(2500);
      const img = [...urls].filter(([rid, u]) => at_.get(rid) >= since && /\/previews\//.test(u)).reduce((s, [rid]) => s + (bytes.get(rid) ?? 0), 0);
      check(img <= 250 * 1024, `${id}: first open loads at most 250 KB of pictures at 1440x900`, `${Math.round(img / 1024)} KB`);
      await p.keyboard.press("Escape");
      await p.waitForTimeout(300);
      const cls = await p.evaluate(() => window.__cls);
      check(cls < 0.001, `${id}: opening and closing it moves nothing on the page (CLS)`, String(cls));
    }
    await ctx.close();
    // Cold JS of / and /apps, from a browser of its own (one that already loaded these files serves some from memory):
    // the scripts the page's HTML asks for (what it needs to start), not what idle work or its media fetch later, which
    // varies from load to load.
    const js = {};
    const cold = await launch();
    for (const route of ["/", "/apps"]) {
      const c = await cold.newContext({ viewport: { width: 1440, height: 900 } });
      const q = await c.newPage();
      const s = await c.newCDPSession(q);
      await s.send("Network.enable");
      const u = new Map();
      const b = new Map();
      const by = new Map();
      s.on("Network.requestWillBeSent", (e) => by.set(e.requestId, e.initiator?.type));
      s.on("Network.responseReceived", (e) => u.set(e.requestId, e.response.url));
      s.on("Network.loadingFinished", (e) => b.set(e.requestId, e.encodedDataLength));
      await q.goto((process.env.MEGA_JS_APP ?? app).replace(/\/$/, "") + route, { waitUntil: "load" });
      await q.waitForTimeout(400);
      js[route] = +([...u].filter(([id, x]) => /\.js(\?|$)/.test(x) && by.get(id) === "parser").reduce((sum, [id]) => sum + (b.get(id) ?? 0), 0) / 1024).toFixed(1);
      await c.close();
    }
    await cold.close();
    console.log(`  cold JS: / ${js["/"]} KB, /apps ${js["/apps"]} KB`);
    if (process.env.MEGA_JS_BASELINE) {
      const base = JSON.parse(fs.readFileSync(process.env.MEGA_JS_BASELINE, "utf8"));
      for (const r of ["/", "/apps"]) {
        const was = base[r]?.jsKB ?? base[r];
        check(js[r] - was <= 4, `${r}: cold JS within 4 KB of main`, `${was} → ${js[r]} KB`);
      }
    }
  }

  // 4. The bar fits at each width for each viewer.
  for (const who of ["guest", "owner", ...(publicSignup ? ["account"] : [])]) {
    for (const width of [1280, 1440, 1536, 1600]) {
      const ctx = await as(who, { viewport: { width, height: 900 } });
      const p = await page(ctx);
      await openRoute(p, `${app}/image`, { settleMs: 300 });
      const cut = await bar(p).evaluate((h) => {
        const over = (el) => el.scrollWidth - el.clientWidth;
        return Math.max(over(h), ...[...h.querySelectorAll("nav")].map(over));
      });
      check(cut <= 1, `bar at ${width} (${who}): everything fits`, `${cut}px cut`);
      await ctx.close();
    }
  }

  // 5. Phone: the Studios sheet's families.
  for (const who of ["guest", "owner"]) {
    for (const size of [PHONE.viewport, { width: 360, height: 740 }]) {
      for (const scheme of size.width === 390 ? ["light", "dark"] : ["light"]) {
        const label = `${who} ${size.width}x${size.height} ${scheme}`;
        const ctx = await as(who, { ...PHONE, viewport: size }, { colorScheme: scheme });
        const p = await page(ctx);
        await openRoute(p, `${app}/image`, { settleMs: 300 });
        await p.locator("[data-phone-tabs]").getByRole("button", { name: "Studios" }).tap();
        const sheet = p.locator("#phone-sheet");
        await sheet.waitFor({ state: "visible" });
        const fams = sheet.getByRole("group", { name: "What to show" }).getByRole("button");
        check((await fams.count()) === 4, `${label}: four families in the sheet`);
        const tops = [];
        for (const [fam, name] of [["studios", "Studios"], ["apps", "Apps"], ["motions", "Motions & effects"], ["canvas", "Canvas"]]) {
          await sheet.getByRole("group", { name: "What to show" }).getByRole("button", { name, exact: true }).tap();
          const body = sheet.locator(`[data-sheet-family="${fam}"]`);
          await body.locator("a[href]").first().waitFor({ timeout: 10_000 });
          await p.waitForTimeout(500);
          tops.push(Math.round((await sheet.boundingBox()).y));
          // One See all tile at most (the families' own pages are their chips' and the panel's).
          const seeAll = await body.locator("ul a[href]").evaluateAll((as_) => as_.filter((a) => /^See all/.test(a.getAttribute("aria-label") ?? a.textContent.trim())).length);
          check(seeAll <= 1, `${label} ${fam}: one See all tile`, String(seeAll));
          const r = await body.evaluate((el) => {
            const links = [...el.querySelectorAll("ul a[href]")];
            return {
              n: links.length,
              off: links.filter((a) => a.getBoundingClientRect().bottom > innerHeight - 0).length,
              inner: el.scrollHeight - el.clientHeight,
              page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              text: el.innerText,
            };
          });
          const below = await p.locator("[data-phone-tabs]").evaluate((t) => t.getBoundingClientRect().top).catch(() => size.height);
          const fits = await body.evaluate((el, limit) => [...el.querySelectorAll("ul a[href]")].every((a) => a.getBoundingClientRect().bottom <= limit + 0.5), Math.min(below, size.height));
          if (fam !== "canvas" && size.height >= 844) check(fits && r.inner <= 1, `${label} ${fam}: All fits without scrolling`, `${r.n} tiles, inner ${r.inner}`);
          else check(r.page <= 0, `${label} ${fam}: scrolls inside the sheet only`, `${r.page}px sideways`);
          if (who === "guest") {
            const said = OWNER_WORDS.filter((w) => r.text.includes(w));
            check(said.length === 0, `${label} ${fam}: no owner-only words`, said.join(", "));
          }
          if (fam === "studios") {
            // The family tabs on the chips' 16 px gutter; tile rows of one height (two lines kept for every name).
            const g = await sheet.evaluate((el) => {
              const left = (sel) => el.querySelector(sel)?.getBoundingClientRect().left ?? NaN;
              const tiles = [...el.querySelectorAll('[data-sheet-family="studios"] > ul > li')].filter((li) => li.checkVisibility());
              return {
                fam: left('[role="group"][aria-label="What to show"] button'),
                chip: left('[role="group"][aria-label^="Show the studios"] button'),
                heights: [...new Set(tiles.map((li) => Math.round(li.getBoundingClientRect().height * 10) / 10))],
              };
            });
            check(Math.abs(g.fam - g.chip) <= 0.5, `${label} studios: family tabs and chips on one gutter`, `${g.fam} / ${g.chip}`);
            check(g.heights.length === 1 && g.heights[0] % 4 === 0, `${label} studios: tile rows of one height on the 4 px grid`, g.heights.join(", "));
          }
          if (fam !== "studios" && fam !== "canvas") {
            const chips = sheet.locator('[role="group"][aria-label^="Show one group"] button[aria-pressed]');
            await chips.nth(1).tap();
            await p.waitForTimeout(200);
            const n = await body.locator("ul a[href]").count();
            check(n >= 6 && n <= 13, `${label} ${fam}: a chip shows its group (lead, rows and See all)`, String(n));
            await chips.nth(0).tap();
            await p.waitForTimeout(400); // the chips' colour change settles before the shot
          }
          if (shots && size.width === 390) await shot(p, `phone-${fam}-390-${who}-${scheme}`);
        }
        check(new Set(tops).size === 1, `${label}: the sheet keeps one height across the families`, tops.join(", "));
        check(ctx.errors.length === 0, `${label}: no console errors`, ctx.errors.join(" | "));
        await ctx.close();
      }
    }
  }

  // 5b. Phone: the You sheet's rows (status rows too) start their words on one column; a best match keeps its whole
  // name, its crumb moving to the second line.
  {
    const ctx = await as("owner", PHONE);
    const p = await page(ctx);
    await openRoute(p, `${app}/image`, { settleMs: 300 });
    await p.locator('[data-phone-tabs] [data-tab="you"]').first().tap();
    const sheet = p.locator("#phone-sheet");
    await sheet.waitFor({ state: "visible" });
    await p.waitForTimeout(800);
    const xs = await sheet.evaluate((el) =>
      [...el.querySelectorAll('a[class*="-mx-2"], button[class*="-mx-2"]')]
        .filter((n) => n.checkVisibility())
        .map((n) => {
          const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.textContent.trim() && t.parentElement.checkVisibility() ? 1 : 3) });
          const t = w.nextNode();
          const rg = document.createRange();
          if (t) rg.selectNodeContents(t);
          return { at: t?.textContent.trim().slice(0, 20), x: t ? Math.round(rg.getClientRects()[0].left * 10) / 10 : NaN };
        }),
    );
    const xsOk = xs.length > 2 && Math.max(...xs.map((r) => r.x)) - Math.min(...xs.map((r) => r.x)) <= 0.75;
    check(xsOk, "phone You sheet: every row's words on one column", xs.map((r) => `${r.at} ${r.x}`).join(", "));
    await p.keyboard.press("Escape");
    await p.waitForTimeout(400);
    await p.keyboard.press("/");
    const dlg = p.getByRole("dialog");
    await dlg.waitFor({ state: "visible" });
    await p.keyboard.type("ad", { delay: 40 });
    await p.waitForTimeout(1200);
    const cut = await dlg.evaluate((el) =>
      [...el.querySelectorAll('[data-hit-name="stack"]')].filter((n) => n.checkVisibility() && n.scrollWidth > n.clientWidth + 0.5).map((n) => n.textContent.trim()),
    );
    const stacked = await dlg.locator('[data-hit-name="stack"]').count();
    check(stacked > 0 && cut.length === 0, "phone search: best matches keep their whole names", cut.join(" | ") || `${stacked} names`);
    check(ctx.errors.length === 0, "phone You sheet and search: no console errors", ctx.errors.join(" | "));
    await ctx.close();
  }

  // 6. /canvas: the finished look only, nothing over the subject, no cover-less card for visitors.
  const gen = fs.readFileSync(path.join(root, "src/lib/template-covers.generated.ts"), "utf8");
  const peakAt = new Map([...gen.matchAll(/"video":"([^"?]+)[^"]*","at":([0-9.]+)/g)].map((m) => [m[1], Number(m[2])]));
  for (const who of ["guest", "owner"]) {
    for (const device of [{ viewport: { width: 1440, height: 900 } }, PHONE]) {
      const label = `/canvas ${who} ${device.viewport.width}`;
      const ctx = await as(who, device);
      const p = await page(ctx);
      await openRoute(p, `${app}/canvas`, { settleMs: 1200 });
      const cards = await p.locator("article").evaluateAll((els) =>
        els
          .filter((el) => el.querySelector("h3"))
          .map((el) => {
            const box = el.querySelector("[class*='aspect-[16/9]']")?.getBoundingClientRect();
            const flow = el.querySelector("[data-step-flow]")?.getBoundingClientRect();
            return {
              name: el.querySelector("h3").textContent.trim(),
              still: el.querySelector("img")?.getAttribute("src") ?? "",
              noCover: !!el.querySelector("[data-no-cover]"),
              svg: !!el.querySelector("[data-no-cover] svg[viewBox]:not([class*='lucide'])"),
              chip: el.textContent.includes("No cover yet"),
              over: !!(box && flow && flow.top < box.bottom && flow.bottom > box.top),
              text: el.innerText,
            };
          }),
      );
      const covered = cards.filter((c) => !c.noCover);
      // The finished scene: a peak frame of its clip, or a still made as the board's cover.
      const finished = (s) => /\/previews\/(presets\/peak|templates\/canvas)\//.test(s);
      check(covered.length > 0 && covered.every((c) => finished(c.still)), `${label}: every cover is its finished scene (a peak frame or a scene still)`, covered.filter((c) => !finished(c.still)).map((c) => c.name).join(", "));
      check(covered.every((c) => !c.over), `${label}: the steps line never sits on a cover`, covered.filter((c) => c.over).map((c) => c.name).join(", "));
      if (who === "guest") {
        check(cards.every((c) => !c.noCover), `${label}: no card without a cover`, cards.filter((c) => c.noCover).map((c) => c.name).join(", "));
        const said = OWNER_WORDS.filter((w) => cards.some((c) => c.text.includes(w)));
        check(said.length === 0, `${label}: no model line or owner words`, said.join(", "));
      } else {
        const bare = cards.filter((c) => c.noCover);
        check(bare.every((c) => c.chip && !c.svg), `${label}: cards without a cover (${bare.length}) show "No cover yet" and no diagram`, bare.map((c) => `${c.name}${c.svg ? " svg" : ""}${c.chip ? "" : " no-chip"}`).join(", "));
      }
      if (device.viewport.width === 1440 && who === "guest") {
        // A card resting on its peak plays the effect's whole published clip when hovered, as the effect's own gallery
        // card does: from its first frame (the photo that went in), through the change and the finished scene, looping.
        const loc = p.locator("article").filter({ has: p.locator("video") });
        const n = Math.min(await loc.count(), 7);
        const partial = [];
        for (let i = 0; i < n; i++) {
          const c = loc.nth(i);
          await c.scrollIntoViewIfNeeded();
          await c.hover();
          const src = await c.locator("video").first().getAttribute("src");
          const peak = peakAt.get((src ?? "").split("?")[0]);
          let min = Infinity;
          let max = 0;
          // Long enough for a whole loop of the longest clip, so a card that was already playing comes back to its start.
          for (let k = 0; k < 24; k++) {
            await p.waitForTimeout(300);
            const t = await c.locator("video").first().evaluate((v) => (v.paused && v.currentTime === 0 ? null : v.currentTime));
            if (t !== null) [min, max] = [Math.min(min, t), Math.max(max, t)];
          }
          if (!(min < 0.75) || (peak !== undefined && max < peak - 0.4)) partial.push(`${src} ${min.toFixed(2)}-${max.toFixed(2)}${peak !== undefined ? ` (peak ${peak})` : ""}`);
          await p.mouse.move(0, 0);
        }
        check(n > 0 && partial.length === 0, `${label}: hovered clips play from their first frame through their peak, loops included`, partial.join("; "));
        if (shots) await shot(p, "canvas-1440-guest");
      }
      await ctx.close();
    }
  }
} catch (e) {
  check(false, "run", e.stack ?? String(e));
} finally {
  for (const { ctx, password } of accounts) await ctx.request.delete(`${app}/api/auth/me`, { data: { password } }).catch(() => {});
  await browser.close();
}
console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
