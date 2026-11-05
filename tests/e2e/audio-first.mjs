// Audio opens on Clean up voice, in a real browser (a production build: `pnpm build && pnpm start`).
// Usage: node tests/e2e/audio-first.mjs [appUrl] [shotsDir]   Exits 1 if any check fails.
//
// At 390 and 1440, as a guest:
// 1. /audio: the Modes row starts with Clean up voice and it is the selected tab; the page is its demo ("Studio-clean
//    voice from any recording."); nothing shifts while it loads; the only pictures and sounds it loads are the demo's
//    (no other mode's covers or clips).
// 2. The other tabs still open their own pages (Speech at /audio/speech, Music), and Clean up voice brings /audio back.
// 3. Old links: /audio/clean is the same tool with its tab selected; /audio?mode=speech and ?mode=music land on their
//    pages; links made for Speech when it was /audio (/audio?voice=…, ?prompt=…, ?model=…) open Speech, query kept.
// 4. The Studios menu (desktop launcher, phone sheet's Sound chip) lists Clean up voice right after the Audio studio,
//    and search for "audio" shows Audio, then Clean up voice.
import fs from "node:fs";
import path from "node:path";
import { DESKTOP, ENGINE, launch, openRoute, PHONE } from "./_browser.mjs";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const app = (args[0] ?? "http://localhost:3000").replace(/\/$/, "");
const shots = args[1];
if (shots) fs.mkdirSync(shots, { recursive: true });
const browser = await launch();
const failures = [];
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${what}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(what);
};
const shot = async (p, name) => shots && (await p.screenshot({ path: path.join(shots, `${name}.png`) }));

/** The Modes row's tabs, in order: mode id, words, selected. */
const tabs = (p) =>
  p.locator('nav[aria-label="Modes"] [data-tab-row] a[data-mode]').evaluateAll((els) =>
    els.filter((a) => a.checkVisibility()).map((a) => ({ id: a.dataset.mode, name: a.textContent.trim(), on: a.hasAttribute("data-on") || a.getAttribute("aria-current") === "page" })),
  );
const path_ = (p) => new URL(p.url()).pathname + new URL(p.url()).search;

for (const [label, device] of [
  ["390", PHONE],
  ["1440", DESKTOP],
]) {
  const ctx = await browser.newContext(device);
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));
  // Pictures and sounds the page asks for (the bar's own icons are inline SVG).
  const media = [];
  p.on("request", (r) => ["image", "media"].includes(r.resourceType()) && media.push(new URL(r.url()).pathname));
  if (ENGINE === "chromium") {
    await p.addInitScript(() => {
      window.__cls = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
      }).observe({ type: "layout-shift", buffered: true });
    });
  }

  // 1. /audio opens on Clean up voice.
  await openRoute(p, `${app}/audio`, { settleMs: 2500 });
  const row = await tabs(p);
  check(row[0]?.id === "clean" && row[0]?.name === "Clean up voice", `${label}: Clean up voice is the first tab`, row.slice(0, 4).map((t) => t.name).join(" › "));
  check(row.filter((t) => t.on).map((t) => t.id).join() === "clean", `${label}: on /audio, Clean up voice is the selected tab`);
  check(row[1]?.id === "speech", `${label}: Speech comes next (the old default, still a tab)`);
  check(await p.getByRole("heading", { name: "Studio-clean voice from any recording." }).first().isVisible(), `${label}: /audio shows the Clean up voice demo`);
  check((await p.title()).startsWith("Audio"), `${label}: the page title is Audio`, await p.title());
  if (ENGINE === "chromium") {
    const cls = await p.evaluate(() => window.__cls);
    check(cls < 0.05, `${label}: nothing shifts while /audio loads`, `CLS ${cls.toFixed(3)}`);
  }
  // Another mode's covers and clips (Speech's "More to try" row, the examples); the shell's own pictures are on every page.
  const other = [...new Set(media)].filter((u) => !u.startsWith("/samples/clean-voice/") && /^\/(examples|previews\/presets)\/|\.(mp4|webm|m4a|wav|mp3)$/.test(u));
  check(media.some((u) => u.startsWith("/samples/clean-voice/")), `${label}: the demo's media load`, [...new Set(media)].filter((u) => u.startsWith("/samples/")).join(", "));
  check(other.length === 0, `${label}: no other mode's pictures or clips load on /audio`, other.slice(0, 6).join(", "));
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(overflow <= 0, `${label}: no sideways scroll`, String(overflow));
  await shot(p, `audio-${label}`);

  // 2. The other tabs still work, and Clean up voice brings /audio back.
  for (const [name, to, heading] of [
    ["Speech", "/audio/speech", "Give it a voice"],
    ["Music", "/audio/music", null],
    ["Clean up voice", "/audio", "Studio-clean voice from any recording."],
  ]) {
    const tab = p.locator('nav[aria-label="Modes"] a[data-mode]').filter({ hasText: new RegExp(`^${name}$`) }).first();
    await tab.scrollIntoViewIfNeeded();
    await tab.click();
    const went = await p.waitForURL((u) => new URL(u).pathname === to, { timeout: 20_000 }).then(() => true, () => false);
    if (heading) await p.getByRole("heading", { name: heading }).first().waitFor({ timeout: 15_000 }).catch(() => {});
    const now = await tabs(p);
    check(went && now.find((t) => t.on)?.name === name && (!heading || (await p.getByRole("heading", { name: heading }).first().isVisible())), `${label}: the ${name} tab opens ${to}`, path_(p));
  }

  // 3. Old links.
  await openRoute(p, `${app}/audio/clean`);
  check((await tabs(p)).find((t) => t.on)?.id === "clean" && (await p.getByRole("heading", { name: "Studio-clean voice from any recording." }).first().isVisible()), `${label}: /audio/clean is the same tool, its tab selected`);
  for (const [from, to] of [
    ["/audio?mode=speech", "/audio/speech"],
    ["/audio?mode=music", "/audio/music"],
    ["/audio?mode=clean", "/audio"],
  ]) {
    await openRoute(p, `${app}${from}`);
    check(new URL(p.url()).pathname === to, `${label}: ${from} lands on ${to}`, path_(p));
  }
  await openRoute(p, `${app}/audio/speech`);
  check(await p.getByRole("heading", { name: "Give it a voice" }).first().isVisible(), `${label}: /audio/speech is the Speech composer`);
  // Links made for Speech when it was /audio (a voice sample, words, a model from search) still open Speech.
  for (const q of ["?voice=%2Fapi%2Ffiles%2Fuploads%2Fa.wav", "?prompt=Hello%20there", "?model=elevenlabs-v4"]) {
    await openRoute(p, `${app}/audio${q}`);
    const speech = await p.getByRole("heading", { name: "Give it a voice" }).first().isVisible();
    // The same query (the composer may write it back as "Hello+there").
    const kept = new URL(p.url()).searchParams.toString() === new URLSearchParams(q).toString();
    check(new URL(p.url()).pathname === "/audio/speech" && kept && speech, `${label}: an old /audio${q} link opens Speech`, path_(p));
    if (q.startsWith("?prompt=")) {
      const words = await p.locator("textarea").first().inputValue().catch(() => "");
      check(words.includes("Hello there"), `${label}: its words are in the composer`, words.slice(0, 40));
    }
  }

  // 4. The menus and search.
  if (label === "1440") {
    await openRoute(p, `${app}/image`);
    await p.locator("[data-top-bar]").getByRole("button", { name: /^Studios/ }).click();
    const panel = p.locator("#studios-launcher");
    await panel.waitFor({ state: "visible" });
    await panel.getByRole("link", { name: /^Clean up/ }).first().waitFor({ timeout: 10_000 }).catch(() => {});
    const column = await panel.evaluate((el) => {
      const audio = [...el.querySelectorAll("a[data-col]")].find((a) => new URL(a.href).pathname === "/audio");
      if (!audio) return [];
      // The column's card and rows (each with a picture), not the studio's sub-links under its card.
      return [...el.querySelectorAll(`a[data-col="${audio.dataset.col}"]`)].filter((a) => a.checkVisibility() && a.querySelector("img")).map((a) => new URL(a.href).pathname);
    });
    check(column[0] === "/audio" && column[1] === "/audio/clean", "1440: the Studios menu's Sound column: Audio, then Clean up voice", column.join(" › "));
    await shot(p, "studios-menu-1440");
    await p.keyboard.press("Escape");
    await p.keyboard.press("ControlOrMeta+k");
  } else {
    await openRoute(p, `${app}/image`);
    const bar = p.locator("[data-phone-tabs]");
    await bar.getByRole("button", { name: "Studios" }).tap();
    const sheet = p.locator("#phone-sheet");
    await sheet.waitFor({ state: "visible" });
    await sheet.getByRole("button", { name: /^Sound/ }).tap();
    await p.waitForTimeout(400);
    const tiles = await sheet.locator("ul").first().getByRole("link").evaluateAll((els) => els.map((a) => new URL(a.href).pathname));
    check(tiles[0] === "/audio" && tiles[1] === "/audio/clean", "390: the Studios sheet's Sound chip: Audio, then Clean up voice", tiles.join(" › "));
    await shot(p, "studios-sheet-sound-390");
    await p.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
    await p.locator("main").getByRole("button", { name: "Search", exact: true }).first().tap();
  }
  const dialog = p.getByRole("dialog", { name: "Search Fuobe" });
  await dialog.waitFor();
  await p.keyboard.type("audio");
  await p.locator('[cmdk-item][data-selected="true"]').first().waitFor();
  await p.waitForTimeout(500);
  const hits = await dialog.locator("[cmdk-item]").evaluateAll((els) => els.slice(0, 2).map((e) => e.textContent.trim()));
  check(/^Audio/.test(hits[0] ?? "") && !hits[0].includes("Clean up voice") && hits[1]?.includes("Clean up voice"), `${label}: search "audio": Audio, then Clean up voice`, hits.join(" | "));
  await shot(p, `search-audio-${label}`);

  check(errors.length === 0, `${label}: no page errors`, errors.slice(0, 3).join(" | "));
  await ctx.close();
}

await browser.close();
console.log(failures.length ? `\n${failures.length} failed` : "\nAll passed");
process.exit(failures.length ? 1 : 0);
