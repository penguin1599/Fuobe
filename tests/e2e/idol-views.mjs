// Fill the other sides from one picture (idol-8) in a real browser (the app must be running in demo mode).
// Usage: node tests/e2e/idol-views.mjs [appUrl] [--shots=dir]. Exits 1 on any failure.
//
// At 1440 px and 390 px, in light and dark, on your GPU: Image to 3D → From several images with only the front filled
// offers "Make the other sides from the front (Idol 3D)" with its price and the soft-renders note; pressing it fills the
// left, back and right slots and Make it 3D is ready. A photo the person brought for a side hides the button. On the cloud
// engine there's no button. In Elements, a new character with one photo offers "Add side and back views", which adds three
// pictures. Nothing scrolls sideways; no page errors or console errors.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DESKTOP, PHONE, launch } from "./_browser.mjs";

const args = process.argv.slice(2);
const app = (args.find((a) => !a.startsWith("--")) ?? "http://localhost:3000").replace(/\/$/, "");
const shots = args.find((a) => a.startsWith("--shots="))?.slice(8);
if (shots) fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 60_000) {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error(`Timed out waiting for ${what}`);
    await sleep(500);
  }
}

const status = await (await fetch(`${app}/api/status`)).json();
assert.notEqual(status.demoMode, "off", "run the app in demo mode (FUOBE_DEMO_MODE=on)");

const PHOTO = path.resolve("public/previews/presets/app-3d-figure.jpg");
const BUTTON = "Make the other sides from the front (Idol 3D)";
const NOTE = /3D guess of your photo/;
const browser = await launch();
const failures = [];
const flat = async (page, tag, where) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0, `${tag}: ${where} doesn't scroll sideways`);

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"]) {
    const tag = `${phone ? "phone" : "desktop"} ${scheme}`;
    const ctx = await browser.newContext({ ...(phone ? PHONE : DESKTOP), colorScheme: scheme });
    await ctx.addInitScript(() => localStorage.setItem("fuobe.engine", "open"));
    const page = await ctx.newPage();
    page.on("pageerror", (e) => failures.push(`${tag}: page error ${e.message}`));
    page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && failures.push(`${tag}: console ${m.text().slice(0, 200)}`));
    try {
      // From several images: only the front in → the button; the views fill the other three slots.
      await page.goto(`${app}/image-to-3d?mode=multi`, { waitUntil: "load", timeout: 120_000 });
      await page.getByRole("button", { name: "Front (required): upload" }).waitFor({ timeout: 60_000 });
      assert.equal(await page.getByRole("button", { name: BUTTON }).count(), 0, `${tag}: no button before the front`);
      await page.locator('input[type="file"]').first().setInputFiles(PHOTO);
      const button = page.getByRole("button", { name: BUTTON });
      await button.waitFor({ timeout: 30_000 });
      const box = page.getByTestId("other-sides");
      await until(async () => /Placeholder · nothing is charged|Free/.test(await box.innerText()), `${tag}: the price`, 20_000);
      assert.match(await box.innerText(), NOTE, `${tag}: the note`);
      await flat(page, tag, "From several images");
      if (shots) await page.screenshot({ path: path.join(shots, `multi-${phone ? "390" : "1440"}-${scheme}.png`), fullPage: false });
      await button.click();
      for (const side of ["Left side", "Back", "Right side"]) await page.getByRole("button", { name: `Remove ${side}` }).waitFor({ timeout: 60_000 });
      assert.equal(await page.getByRole("button", { name: BUTTON }).count(), 0, `${tag}: the button goes once the sides are in`);
      assert.match(await page.locator("main").innerText(), /4 of 4/, `${tag}: four of four`);
      assert.match(await page.locator("main").innerText(), /Made by Idol 3D: rendered from a 3D guess/, `${tag}: the note stays with the views`);
      assert.doesNotMatch(await page.locator("main").innerText(), /Add at least one more side/, `${tag}: ready to make it 3D`);
      await flat(page, tag, "the filled slots");
      if (shots) await page.screenshot({ path: path.join(shots, `multi-filled-${phone ? "390" : "1440"}-${scheme}.png`) });
      // A side the person brought: no button. On the cloud engine: no button.
      await page.getByRole("button", { name: "Remove Left side" }).click();
      await page.getByRole("button", { name: "Remove Right side" }).click();
      assert.equal(await page.getByRole("button", { name: BUTTON }).count(), 0, `${tag}: a side already there hides the button`);
      await page.getByRole("button", { name: "Remove Back" }).click();
      await button.waitFor({ timeout: 10_000 });
      await page.evaluate(() => {
        localStorage.setItem("fuobe.engine", "cloud");
        window.dispatchEvent(new StorageEvent("storage"));
      });
      await until(async () => (await page.getByRole("button", { name: BUTTON }).count()) === 0, `${tag}: no button on the cloud`, 10_000);

      // Elements: a character with one photo → "Add side and back views" adds three pictures.
      await page.evaluate(() => localStorage.setItem("fuobe.engine", "open"));
      await page.goto(`${app}/elements`, { waitUntil: "load", timeout: 120_000 });
      await page.getByRole("button", { name: "New element" }).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      assert.equal(await dialog.getByRole("button", { name: "Add side and back views" }).count(), 0, `${tag}: no views button before a photo`);
      await dialog.locator('input[type="file"]').first().setInputFiles(PHOTO);
      const add = dialog.getByRole("button", { name: "Add side and back views" });
      await add.waitFor({ timeout: 30_000 });
      assert.match(await dialog.getByTestId("other-sides").innerText(), NOTE, `${tag}: the element's note`);
      await flat(page, tag, "the element dialog");
      await add.click();
      await until(async () => (await dialog.getByRole("button", { name: "Remove photo" }).count()) === 4, `${tag}: four photos`, 60_000);
      assert.equal(await dialog.getByRole("button", { name: "Add side and back views" }).count(), 0, `${tag}: offered once`);
      assert.match(await dialog.innerText(), /Side and back views by Idol 3D: rendered from a 3D guess/, `${tag}: the element's note stays`);
      if (shots) await dialog.screenshot({ path: path.join(shots, `element-${phone ? "390" : "1440"}-${scheme}.png`) });
      console.log(`ok ${tag}`);
    } catch (e) {
      failures.push(`${tag}: ${e.message}`);
    }
    await ctx.close();
  }
}
await browser.close();
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("all good");
