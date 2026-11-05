// Canvas's first screen, as a guest, a fresh account and the owner, at 390 and 1440 px: "What's a canvas?" and the ready
// boards come first while the viewer has no boards of their own; visitors see only boards with a real cover and no
// model or engine words; a card opens the board's page, an effect film's page links to its Video effect with the
// effect's example loaded; the owner's "Use template" makes the board, which runs as it is ("Run all" in demo mode,
// nothing left to add), after which their boards lead and one template row sits below.
//
// node tests/e2e/canvas-starters.mjs <app address> <owner password> [screenshot folder]
// Against `next start` with a fresh data dir, FUOBE_PUBLIC_SIGNUP=1 and demo mode on (FUOBE_DEMO_MODE=on): the
// boards run on demo outputs, never on a model.
import fs from "node:fs";
import path from "node:path";
import { launch, PHONE, DESKTOP } from "./_browser.mjs";

const [app, password, shots] = process.argv.slice(2);
if (!app || !password) throw new Error("usage: node tests/e2e/canvas-starters.mjs <app address> <owner password> [screenshot folder]");
if (shots) fs.mkdirSync(shots, { recursive: true });

const ENGINE_WORDS = /Fuobe DoP|Effects 2\.0|\bGPU\b|Variant|Qwen|MiniMax|Nano Banana|Seedance|Wan VACE|Kling|Chatterbox|InfiniteTalk/;
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
};

async function signIn(ctx, persona) {
  if (persona === "owner") {
    const r = await ctx.request.post(`${app}/api/auth/login`, { data: { password } });
    if (!r.ok()) throw new Error(`owner login ${r.status()}`);
  } else if (persona === "account") {
    const email = `canvas-starters-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
    const r = await ctx.request.post(`${app}/api/auth/signup`, { data: { email, password: "canvas-starters-pw-123" } });
    if (!r.ok()) throw new Error(`signup ${r.status()}`);
  }
}

const browser = await launch();
try {
  for (const persona of ["guest", "account", "owner"]) {
    for (const [size, device] of [
      ["390", PHONE],
      ["1440", DESKTOP],
    ]) {
      const tag = `${persona} ${size}`;
      const ctx = await browser.newContext({ ...device, colorScheme: "light" });
      await signIn(ctx, persona);
      const page = await ctx.newPage();
      page.setDefaultTimeout(30_000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(`${page.url()} :: ${String(e).slice(0, 200)}`));
      const shot = async (name) => shots && page.screenshot({ path: path.join(shots, `${name}--${persona}--${size}.png`), fullPage: false });
      const fullShot = async (name) => shots && page.screenshot({ path: path.join(shots, `${name}--${persona}--${size}--full.png`), fullPage: true });
      const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const text = () => page.locator("main, body").first().innerText();

      // ---- The first screen, with no boards of one's own
      await page.goto(`${app}/canvas`, { waitUntil: "load", timeout: 180_000 });
      const intro = page.getByRole("heading", { name: "What's a canvas?" });
      await intro.waitFor();
      if (persona === "owner") await page.getByRole("button", { name: "Use template" }).first().waitFor();
      else await page.waitForTimeout(1500);
      const order = await page.evaluate(() => [...document.querySelectorAll("h2")].map((h) => h.textContent?.trim()));
      check(`${tag}: "What's a canvas?" leads, then the ready boards`, order[0] === "What's a canvas?" && order[1] === "Start from a ready board", order.join(" | "));
      check(`${tag}: the strip shows a photo, a scene and a moving shot`, (await page.getByText("Your photo", { exact: true }).count()) > 0 && (await page.getByText("A moving shot", { exact: true }).count()) > 0);
      const cards = page.locator("#templates article");
      const n = await cards.count();
      const covered = await cards.evaluateAll((els) => els.filter((e) => e.querySelector("img")).length);
      const t = await text();
      if (persona === "owner") {
        check(`${tag}: the owner sees every ready board and More templates`, n >= 18 && /More templates/.test(t), `${n} cards`);
        check(`${tag}: a board without a cover is marked for the owner`, (await page.getByText("No cover yet").count()) > 0);
        check(`${tag}: the owner sees what a board runs on`, /Fuobe DoP/.test(t));
      } else {
        check(`${tag}: a visitor sees only boards with a real cover`, n > 0 && covered === n, `${covered}/${n}`);
        check(`${tag}: no model or engine words for a visitor`, !ENGINE_WORDS.test(t), (t.match(ENGINE_WORDS) ?? [""])[0]);
        check(`${tag}: no "No cover yet" or More templates for a visitor`, !/No cover yet|More templates|Use template/.test(t));
        check(`${tag}: the visitor's action opens the board in the editor`, (await page.locator("#templates a[data-use-board]").count()) === n);
        check(`${tag}: no "isn't available here" note for a visitor`, !/isn.t available here/.test(t));
        const firstCard = await cards.first().evaluate((e) => e.getBoundingClientRect().top);
        const vh = await page.evaluate(() => window.innerHeight);
        check(`${tag}: the first card starts on the first screen`, firstCard < vh - 120, `${Math.round(firstCard)} of ${vh} px`);
      }
      check(`${tag}: no sideways scroll on /canvas`, (await sideways()) <= 1, `${await sideways()} px`);
      await shot("canvas-first");
      await fullShot("canvas-first");

      // ---- A ready board's page
      await page.locator("#templates article", { hasText: "Pearl Earring" }).getByRole("link", { name: "Pearl Earring" }).click();
      await page.waitForURL(/\/canvas\/start\/effect-chain-pearl-earring$/);
      await page.getByRole("heading", { name: "What goes in" }).waitFor();
      const pt = await text();
      check(`${tag}: the page says what goes in, the steps and what comes out`, /The steps/i.test(pt) && /What comes out/i.test(pt) && /An edit sets the scene/.test(pt));
      check(`${tag}: no sideways scroll on the board's page`, (await sideways()) <= 1, `${await sideways()} px`);
      await shot("canvas-start-pearl-earring");
      if (persona === "owner") {
        check(`${tag}: the owner can use the board from its page`, (await page.getByRole("button", { name: "Use template" }).count()) === 1);
      } else {
        check(`${tag}: no model or engine words on the board's page`, !ENGINE_WORDS.test(pt), (pt.match(ENGINE_WORDS) ?? [""])[0]);
        check(`${tag}: the page has no "isn't available here" note, one quiet line instead`, !/isn.t available here/.test(pt) && /Opens the board in the editor/.test(pt));
        check(`${tag}: Use this board leads on the board's page`, (await page.getByRole("link", { name: "Use this board" }).getAttribute("href")) === "/canvas/try/effect-chain-pearl-earring");
        await page.getByRole("link", { name: "Try this effect in Video" }).click();
        await page.waitForURL(/\/video\?preset=effect-pearl-earring&example=effect-pearl-earring\.1/);
        await page.getByText("Pearl Earring").first().waitFor({ timeout: 60_000 }).catch(() => {});
        await page.waitForTimeout(2500);
        const vt = await text();
        check(`${tag}: the Video effect opens with the effect and its example loaded`, /Pearl Earring/i.test(vt) && /In the composer/.test(vt));
        await shot("video-from-canvas");
        // A board that visitors don't get to see yet.
        await page.goto(`${app}/canvas/start/script-film`, { waitUntil: "load" });
        await page.getByText("This board isn't here.").waitFor({ timeout: 30_000 }).catch(() => {});
        check(`${tag}: a board without its cover isn't shown to a visitor`, /This board isn.t here/.test(await text()) && !/The steps/i.test(await text()));
      }
      // An unknown board.
      // (Its status is 404 once the route is warm; the first render streams the not-found page under a 200.)
      const missing = await page.goto(`${app}/canvas/start/no-such-board`, { waitUntil: "load" });
      await page.getByText("This page isn’t here").first().waitFor({ timeout: 30_000 }).catch(() => {});
      check(`${tag}: an unknown board is not found`, /This page isn’t here/.test(await text()), String(missing?.status()));

      // ---- The owner makes a board; then their boards lead
      if (persona === "owner" && size === "1440") {
        await page.goto(`${app}/canvas`, { waitUntil: "load" });
        await page.locator("#templates article", { hasText: "Pearl Earring" }).getByRole("button", { name: "Use template" }).click();
        await page.waitForURL(/\/canvas\/(?!start)[^/?]+$/, { timeout: 60_000 });
        await page.getByText("Set the scene").first().waitFor({ timeout: 60_000 }).catch(() => {});
        check(`${tag}: Use template opens the board with its steps`, /Set the scene/.test(await text()));
        await shot("canvas-board-from-template");
        await page.goto(`${app}/canvas`, { waitUntil: "load" });
        await page.getByRole("heading", { name: "Your canvases" }).waitFor();
        const h2 = await page.evaluate(() => [...document.querySelectorAll("h2")].map((h) => h.textContent?.trim()));
        check(`${tag}: with a board, their boards lead and one template row sits below`, h2[0] === "Your canvases" && h2[1] === "Start from a template" && !h2.includes("What's a canvas?"), h2.join(" | "));
        check(`${tag}: the row has three cards and See all templates`, (await page.locator("#templates article").count()) === 3 && (await page.getByRole("button", { name: "See all templates" }).count()) === 1);
        await shot("canvas-with-boards");
        await page.getByRole("button", { name: "See all templates" }).click();
        check(`${tag}: See all templates opens the sections`, (await page.getByRole("heading", { name: "Effect films" }).count()) === 1);
        await page.goto(`${app}/canvas?tab=templates`, { waitUntil: "load" });
        await page.getByRole("heading", { name: "Effect films" }).waitFor();
        const top = await page.evaluate(() => document.getElementById("templates")?.getBoundingClientRect().top ?? 9999);
        check(`${tag}: ?tab=templates opens the templates, scrolled to`, top < 200, `${Math.round(top)} px`);
        await shot("canvas-tab-templates");
      }
      // ---- Every ready board runs as it is: Use template, then Run all (demo mode), and nothing needs attention
      if (persona === "owner" && size === "1440") {
        await page.goto(`${app}/canvas?tab=templates`, { waitUntil: "load" });
        await page.getByRole("heading", { name: "Effect films" }).waitFor();
        const ids = await page
          .locator("#templates section:not(:has(#tpl-more)) article a[href^='/canvas/start/']")
          .evaluateAll((as) => [...new Set(as.map((a) => a.getAttribute("href").split("/").pop()))]);
        check(`${tag}: every ready board is listed for the owner`, ids.length >= 17, `${ids.length}`);
        for (const id of ids) {
          await page.goto(`${app}/canvas/start/${id}`, { waitUntil: "load" });
          await page.getByRole("button", { name: "Use template" }).click();
          await page.waitForURL(/\/canvas\/(?!start)[^/?]+$/, { timeout: 60_000 });
          const run = page.getByRole("button", { name: /^Run all$/ }).first();
          await run.waitFor();
          await page.waitForTimeout(1500);
          const before = await text();
          const enabled = await run.isEnabled();
          if (enabled) {
            await run.click();
            const t0 = Date.now();
            await page.waitForTimeout(4000);
            while (Date.now() - t0 < 180_000 && (await page.getByText(/^\d+ running$/).count())) await page.waitForTimeout(2000);
          }
          await page.waitForTimeout(1500);
          const after = await text();
          const problem = (before + "\n" + after).match(/[^\n]*(need(s)? attention|Add an? [a-z]+ to|failed|couldn.t)[^\n]*/i)?.[0];
          check(`${tag}: ${id} runs as it is`, enabled && !problem, problem ?? (enabled ? "" : "Run all is off"));
          await shot(`board-run-${id}`);
        }
      }
      if (persona === "owner" && size === "390") {
        await page.goto(`${app}/canvas/start/script-film`, { waitUntil: "load" });
        await page.getByRole("heading", { name: "The steps" }).waitFor();
        check(`${tag}: the owner sees a board without a cover, marked`, (await page.getByText("No cover yet").count()) > 0);
        await shot("canvas-start-script-film");
      }
      check(`${tag}: no page errors`, errors.length === 0, errors[0]);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
