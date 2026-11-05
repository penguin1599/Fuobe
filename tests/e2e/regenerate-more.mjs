// Browser check of Regenerate in Faceless, video segments and Cinema H3 shots (n7-10-regenerate-more).
// Usage: node tests/e2e/regenerate-more.mjs [appUrl] [outDir]   (the app in demo mode: FUOBE_DEMO_MODE=on, no keys, no ComfyUI)
// At 1440 px and 390 px, light and dark: Faceless's "Regenerate to 1080p" in an open episode's actions menu (Free, the
// GPU time, reached by keyboard, tapped at 390 px); Shorts' "Enhance (H3 regenerate)" on an open short's segment (reached
// by Tab, tapped at 390 px: the new take shows with its HD mark); Edit video's "Enhance (H3 regenerate) · 1080p" in a feed
// tile's menu; Cinema's 2K tier for MiniMax H3 in the Resolution chip (with what it does on your GPU) and "Finish in 2K"
// in a take's menu. No sideways scroll anywhere. Screenshots go to outDir.
import fs from "node:fs";
import path from "node:path";
import { DESKTOP, PHONE, launch, openRoute, root } from "./_browser.mjs";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const app = (args[0] ?? "http://localhost:3000").replace(/\/$/, "");
const out = args[1] ?? fs.mkdtempSync("/tmp/fuobe-regenerate-more-");
fs.mkdirSync(out, { recursive: true });

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures.push(what);
};
const json = async (p, init) => {
  const res = await fetch(app + p, { headers: { "Content-Type": "application/json" }, ...init });
  const body = await res.json();
  if (!res.ok) throw new Error(`${p}: ${body.error ?? res.status}`);
  return body;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 240_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(1500);
  }
};
const noSideScroll = async (page, label) => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(over <= 0, `${label}: no horizontal scroll (${over}px)`);
};
const fits = async (loc, page, label) => {
  const box = await loc.boundingBox();
  const width = page.viewportSize().width;
  check(!!box && box.x >= 0 && box.x + box.width <= width + 0.5, `${label}: fits on screen`);
};
const setup = async (browser, device, theme, engine, extra = {}) => {
  const ctx = await browser.newContext({ ...device, colorScheme: theme });
  await ctx.addInitScript(([e, kv]) => {
    localStorage.setItem("fuobe.engine", e);
    for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
  }, [engine, extra]);
  await ctx.route((u) => u.origin !== new URL(app).origin && /^https?:$/.test(u.protocol), (rt) => rt.abort());
  return ctx;
};
const press = async (device, loc) => (device === PHONE ? loc.tap() : loc.click());

// ---- Data (demo mode): an uploaded 16 fps clip, an open Faceless episode, an open short, an Edit video result, a Cinema take.
const form = new FormData();
form.append("file", new Blob([fs.readFileSync(path.join(root, "tests/fixtures/shorts-12s.mp4"))], { type: "video/mp4" }), "beach day.mp4");
const upload = await (await fetch(`${app}/api/uploads`, { method: "POST", body: form })).json();
const clip = upload.url ?? upload.items?.[0]?.url ?? upload.file?.url;
if (!clip) throw new Error(`upload failed: ${JSON.stringify(upload).slice(0, 200)}`);

const channel = await json("/api/faceless/channels", { method: "POST", body: JSON.stringify({ idea: "Channel about lighthouses and the sea", genre: "history", engine: "open" }) });
const settings = { engine: "open", length: 60, animation: "frames", aspect: "16:9", subtitles: true, music: false, styleId: "editorial-motion-graphics", styleRefs: [], voice: null, elements: [] };
const ep = await json("/api/faceless/episodes", { method: "POST", body: JSON.stringify({ channelId: channel.id, topic: "The last lighthouse keepers", settings }) });
await until("the script", async () => (await json(`/api/faceless/episodes/${ep.id}`)).episode.status === "review");
await json(`/api/faceless/episodes/${ep.id}/render`, { method: "POST" });

const short = await json("/api/shorts/sessions", {
  method: "POST",
  body: JSON.stringify({ engine: "open", presetId: "shorts-claymation", source: { url: clip, name: "beach day.mp4" }, range: { start: 0, end: 12 }, aspectRatio: "9:16", language: "auto" }),
});
const editMade = await json("/api/generations", { method: "POST", body: JSON.stringify({ feature: "video-edit", modelId: "fuobe-mixed-media", op: "v2v", prompt: "Make it snow over the beach", inputs: { video: clip }, params: { duration: 5 } }) });
const editId = (editMade.items ?? [editMade])[0].id;
const project = await json("/api/cinema/projects", { method: "POST", body: JSON.stringify({ name: "Storm at sea" }) });
await json(`/api/cinema/projects/${project.id}/generate`, {
  method: "POST",
  body: JSON.stringify({ input: { engine: "open", mode: "video", modelId: "oss-minimax-h3", prompt: "A lighthouse beam sweeps over a stormy sea at night", duration: 5, resolution: "768p", aspectRatio: "16:9", batch: 1 }, folderId: null }),
});
await until("the short's segments", async () => {
  const s = await json(`/api/shorts/sessions/${short.id}`);
  return s.segments.every((g) => s.generations[g.primary]?.status === "succeeded");
});
await until("the edit", async () => {
  const g = await json(`/api/generations/${editId}`);
  return (g.generation ?? g).status === "succeeded";
});
await until("the Cinema take", async () => (await json(`/api/cinema/projects/${project.id}/items`)).items.some((g) => g.status === "succeeded"));
await until("the episode", async () => (await json(`/api/faceless/episodes/${ep.id}`)).episode.status === "done", 360_000);
console.log("data ready");

const browser = await launch();
let enhanced = false;
try {
  for (const [dname, device] of [
    ["1440", DESKTOP],
    ["390", PHONE],
  ]) {
    for (const theme of ["light", "dark"]) {
      const label = `${dname} ${theme}`;
      const ctx = await setup(browser, device, theme, "open", {
        [`fuobe.cinema.draft.${project.id}`]: JSON.stringify({ mode: "video", models: { "video:open": "oss-minimax-h3" }, resolution: { video: "2K", image: "1K" } }),
      });
      const page = await ctx.newPage();
      page.on("pageerror", (e) => failures.push(`${label} page error: ${e.message.split("\n")[0]}`));

      // ---- Faceless: the episode's actions menu.
      await openRoute(page, `${app}/faceless/${channel.id}/${ep.id}`);
      const actions = page.getByRole("button", { name: "Episode actions" });
      await actions.waitFor({ timeout: 30_000 });
      if (device === PHONE) await actions.tap();
      else {
        await actions.focus();
        await page.keyboard.press("Enter");
      }
      const regen = page.getByRole("menuitem", { name: /Regenerate to 1080p/ });
      await regen.waitFor({ timeout: 10_000 });
      const text = (await regen.innerText()).replace(/\s+/g, " ");
      check(/Sharper, may redraw/.test(text) && /Free/.test(text) && /Runs on your GPU · about \d+ min/.test(text), `${label}: Faceless offers Regenerate to 1080p, sharper, may redraw, free on your GPU (${text})`);
      await fits(regen, page, `${label} Faceless item`);
      if (device !== PHONE) {
        for (let i = 0; i < 8 && !(await page.evaluate(() => /Regenerate to 1080p/.test(document.activeElement?.textContent ?? ""))); i++) {
          await page.keyboard.press("ArrowDown");
          await page.waitForTimeout(120);
        }
        check(await page.evaluate(() => /Regenerate to 1080p/.test(document.activeElement?.textContent ?? "")), `${label}: the arrow keys reach Regenerate to 1080p`);
      }
      await page.screenshot({ path: path.join(out, `faceless-${dname}-${theme}.png`) });
      await page.keyboard.press("Escape");
      await noSideScroll(page, `${label} Faceless`);

      // ---- Shorts: Enhance on a segment of the open short.
      await openRoute(page, `${app}/shorts/${short.id}`);
      const card = page.getByRole("article", { name: "Segment 1" });
      const enhance = card.getByRole("button", { name: /Enhance \(H3 regenerate\)/ });
      if (!enhanced) {
        await enhance.waitFor({ timeout: 30_000 });
        const t = (await enhance.innerText()).replace(/\s+/g, " ");
        check(/1080p · Free/.test(t), `${label}: Shorts' segment offers Enhance (H3 regenerate) · 1080p · Free (${t})`);
        await fits(enhance, page, `${label} Enhance button`);
        // Keyboard: Tab from the segment's Regenerate reaches Enhance.
        await card.getByRole("button", { name: /^Regenerate/ }).focus();
        await page.keyboard.press("Tab");
        check(await page.evaluate(() => /Enhance \(H3 regenerate\)/.test(document.activeElement?.textContent ?? "")), `${label}: Tab reaches Enhance`);
        await page.screenshot({ path: path.join(out, `shorts-${dname}-${theme}.png`) });
        if (device === PHONE) {
          await enhance.tap();
          const takes = card.getByRole("radiogroup", { name: "Takes of segment 1" });
          await takes.getByRole("radio", { name: /enhanced/ }).waitFor({ timeout: 30_000 });
          check(true, `${label}: a tap on Enhance adds an enhanced take beside the first`);
          enhanced = true;
        }
      } else {
        const takes = card.getByRole("radiogroup", { name: "Takes of segment 1" });
        await takes.getByRole("radio", { name: /enhanced/ }).waitFor({ timeout: 30_000 });
        check(true, `${label}: the enhanced take shows with its mark`);
        await page.screenshot({ path: path.join(out, `shorts-${dname}-${theme}.png`) });
      }
      await noSideScroll(page, `${label} Shorts`);

      // ---- Edit video: a result's menu.
      await openRoute(page, `${app}/video-edit`);
      const tileOpen = page.getByRole("button", { name: /^Open “Make it snow/ }).first();
      await tileOpen.waitFor({ timeout: 30_000 });
      if (device !== PHONE) {
        const box = await tileOpen.boundingBox();
        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      }
      const more = page.getByRole("button", { name: "More actions" }).first();
      await more.waitFor({ timeout: 30_000 });
      await press(device, more);
      const enhanceItem = page.getByRole("menuitem", { name: /Enhance \(H3 regenerate\) · 1080p/ });
      await enhanceItem.waitFor({ timeout: 10_000 });
      check(await enhanceItem.isVisible(), `${label}: an Edit video result's menu has Enhance (H3 regenerate) · 1080p`);
      await fits(enhanceItem, page, `${label} Edit video item`);
      await page.screenshot({ path: path.join(out, `edit-video-${dname}-${theme}.png`) });
      await page.keyboard.press("Escape");
      await noSideScroll(page, `${label} Edit video`);

      // ---- Cinema: the 2K tier for MiniMax H3, and Finish in 2K on a take.
      await openRoute(page, `${app}/cinema/${project.id}`);
      let resChip = page.getByRole("button", { name: "Resolution: 2K" });
      if (device === PHONE) {
        const settingsBtn = page.getByRole("button", { name: /^Settings:/ }).first();
        await settingsBtn.waitFor({ timeout: 30_000 });
        await settingsBtn.tap();
        resChip = page.getByRole("button", { name: "Resolution: 2K" });
      }
      await resChip.waitFor({ timeout: 30_000 });
      check(await resChip.isVisible(), `${label}: Cinema's Resolution chip keeps 2K for MiniMax H3`);
      await fits(resChip, page, `${label} Resolution chip`);
      if (device === PHONE) await resChip.tap();
      else {
        await resChip.focus();
        await page.keyboard.press("Enter");
      }
      const twoK = page.getByRole("menuitemradio", { name: /2K/ });
      await twoK.waitFor({ timeout: 10_000 });
      const tierText = (await twoK.innerText()).replace(/\s+/g, " ");
      check(/768p draft, then redrawn at 2K on your GPU/.test(tierText), `${label}: the 2K tier says what your GPU does (${tierText})`);
      check((await page.getByRole("menuitemradio").count()) === 4, `${label}: four tiers (480p, 720p, 1080p, 2K)`);
      await fits(twoK, page, `${label} 2K tier`);
      await page.screenshot({ path: path.join(out, `cinema-tier-${dname}-${theme}.png`) });
      await page.keyboard.press("Escape");
      if (device === PHONE) await page.keyboard.press("Escape");
      const take = page.getByRole("button", { name: "More actions" }).first();
      if (device !== PHONE) {
        const tile = page.locator("video, img").first();
        const box = await tile.boundingBox();
        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      }
      await take.waitFor({ timeout: 30_000 });
      await press(device, take);
      const finish = page.getByRole("menuitem", { name: /Finish in 2K/ });
      await finish.waitFor({ timeout: 10_000 });
      check(/Free/.test(await finish.innerText()), `${label}: a take's menu has Finish in 2K · Free`);
      await fits(finish, page, `${label} Finish in 2K`);
      await page.screenshot({ path: path.join(out, `cinema-finish-${dname}-${theme}.png`) });
      await page.keyboard.press("Escape");
      await noSideScroll(page, `${label} Cinema`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${failures.length ? `${failures.length} failure(s):\n  ${failures.join("\n  ")}` : "All checks passed"}  (screenshots: ${out})`);
process.exitCode = failures.length ? 1 : 0;
