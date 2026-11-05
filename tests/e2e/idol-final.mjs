// Draft then final (idol-6) in a real browser (the app must be running in demo mode).
// Usage: node tests/e2e/idol-final.mjs [appUrl] [--shots=dir]. Exits 1 on any failure.
//
// At 1440 px and 390 px, in light and dark: an Idol 3D result on your GPU shows "Build the final with TRELLIS.2" with its
// note, a TRELLIS.2 result doesn't, and the link opens Image to 3D → From an image on TRELLIS.2 with the same picture
// filled in, also on a second click of the same link. Nothing scrolls sideways; no page errors or console errors.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DESKTOP, PHONE, launch } from "./_browser.mjs";

const args = process.argv.slice(2);
const app = (args.find((a) => !a.startsWith("--")) ?? "http://localhost:3000").replace(/\/$/, "");
const shots = args.find((a) => a.startsWith("--shots="))?.slice(8);
if (shots) fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(url, method = "GET", data) {
  const res = await fetch(app + url, { method, headers: { "Content-Type": "application/json" }, ...(data !== undefined && { body: JSON.stringify(data) }) });
  return res.json();
}
async function until(fn, what, ms = 90_000) {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error(`Timed out waiting for ${what}`);
    await sleep(700);
  }
}

const status = await call("/api/status");
assert.notEqual(status.demoMode, "off", "run the app in demo mode (FUOBE_DEMO_MODE=on)");

// A photo, an Idol 3D draft of it and a TRELLIS.2 model of it (demos).
const photo = await (
  await fetch(`${app}/api/uploads`, { method: "POST", headers: { "content-type": "image/jpeg", "x-file-name": "figure.jpg" }, body: fs.readFileSync(path.resolve("public/previews/presets/app-3d-figure.jpg")) })
).json();
assert.ok(photo.url, `an upload: ${JSON.stringify(photo).slice(0, 200)}`);
const runs = [
  { feature: "image-to-3d", modelId: "oss-trellis2", op: "image-to-3d", inputs: { images: [photo.url] } },
  { feature: "image-to-3d", modelId: "oss-idol", op: "splat", inputs: { images: [photo.url] } },
];
for (const body of runs) {
  const made = await call("/api/generations", "POST", body);
  const g = made.items?.[0];
  assert.ok(g, `a demo ${body.modelId}: ${JSON.stringify(made).slice(0, 200)}`);
  await until(async () => (await call(`/api/generations/${g.id}`)).status === "succeeded", `the demo ${body.modelId}`);
}

const browser = await launch();
const failures = [];
const LABEL = "Build the final with TRELLIS.2";

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"]) {
    const tag = `${phone ? "phone" : "desktop"} ${scheme}`;
    const ctx = await browser.newContext({ ...(phone ? PHONE : DESKTOP), colorScheme: scheme });
    await ctx.addInitScript(() => localStorage.setItem("fuobe.engine", "open"));
    const page = await ctx.newPage();
    page.on("pageerror", (e) => failures.push(`${tag}: page error ${e.message}`));
    page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && failures.push(`${tag}: console ${m.text().slice(0, 200)}`));
    try {
      await page.goto(`${app}/image-to-3d`, { waitUntil: "load", timeout: 120_000 });
      const cards = page.locator("#your-3d-models article");
      await cards.first().waitFor({ timeout: 60_000 });
      await sleep(800);
      // Every Idol draft offers the final and nothing else does (an earlier run of this script leaves its own cards).
      const links = page.getByRole("link", { name: LABEL });
      const idolCards = await page.locator('#your-3d-models article:has(img[alt="The Idol 3D model"])').count();
      assert.ok(idolCards > 0 && (await links.count()) === idolCards, `${tag}: only the Idol drafts offer the final (${await links.count()} of ${idolCards})`);
      assert.equal(await page.locator(`#your-3d-models article:not(:has(img[alt="The Idol 3D model"]))`).getByRole("link", { name: LABEL }).count(), 0, `${tag}: the TRELLIS.2 card doesn't`);
      const link = links.first();
      const href = await link.getAttribute("href");
      const q = new URL(href, app).searchParams;
      assert.deepEqual(Object.fromEntries(q), { mode: "image", model: "oss-trellis2", image: photo.url }, `${tag}: the link`);
      await link.scrollIntoViewIfNeeded();
      assert.ok(await link.locator("xpath=ancestor::article").getByText("A textured, riggable .glb · 16 GB GPU").isVisible(), `${tag}: the note under it`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0, `${tag}: nothing scrolls sideways`);
      if (shots) await link.locator("xpath=ancestor::article").screenshot({ path: path.join(shots, `card-${phone ? "390" : "1440"}-${scheme}.png`) });
      await link.click();
      await page.waitForURL(/model=oss-trellis2/, { timeout: 30_000 });
      await sleep(1200);
      // From an image, on TRELLIS.2, with the picture filled in.
      assert.equal(await page.getByRole("radio", { name: "From an image" }).getAttribute("aria-checked"), "true", `${tag}: From an image`);
      assert.ok((await page.locator("main").innerText()).includes("TRELLIS.2"), `${tag}: TRELLIS.2 picked`);
      // The photo slot's picture (the Idol card shows the same picture, so it is told apart by its label).
      const slotPhoto = page.locator(`img[alt="Add a photo of the object"][src="${photo.url}"]`);
      assert.equal(await slotPhoto.count(), 1, `${tag}: the picture is filled in`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0, `${tag}: the studio doesn't scroll sideways`);
      if (shots) await page.screenshot({ path: path.join(shots, `studio-${phone ? "390" : "1440"}-${scheme}.png`) });
      // Clicked again with the URL already its own (the picture removed by hand): it fills the picture in again.
      await page.getByRole("button", { name: "Remove the photo" }).click();
      await until(async () => (await slotPhoto.count()) === 0, "the picture to go", 15_000);
      await links.first().click();
      await until(async () => (await slotPhoto.count()) === 1, `${tag}: the picture filled in again`, 15_000);
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
