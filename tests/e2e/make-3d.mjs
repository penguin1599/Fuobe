// Make it 3D (quick) on an image result (idol-5) in a real browser (the app must be running in demo mode).
// Usage: node tests/e2e/make-3d.mjs [appUrl] [--shots=dir]. Exits 1 on any failure.
//
// At 1440 px and 390 px, in light and dark: a demo picture's ⋯ menu offers "Make it 3D (quick)"; it opens Image to 3D
// on Splat with Idol 3D, Quick look, the picture in the slot, the photo crop off and the line that says what it does.
// Nothing scrolls sideways; no page errors or console errors. Engine set to Cloud in the browser still opens the open
// engine (the link names Idol 3D on your GPU).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DESKTOP, PHONE, launch } from "./_browser.mjs";

const args = process.argv.slice(2);
const app = (args.find((a) => !a.startsWith("--")) ?? "http://localhost:3000").replace(/\/$/, "");
const shots = args.find((a) => a.startsWith("--shots="))?.slice(8);
if (shots) fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (name) => console.log(`- ${name}`);
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
assert.equal(status.demoMode, "on", "run the app with placeholder results on (FUOBE_DEMO_MODE=on)");
assert.notEqual(status.engineMode, "cloud", "Make it 3D is hidden on installs that run paid APIs only");

const made = await call("/api/generations", "POST", { feature: "image", modelId: "nano-banana-pro", prompt: "a ceramic teapot, studio light" });
const picture = made.items?.[0];
assert.ok(picture, `a demo picture: ${JSON.stringify(made).slice(0, 200)}`);
const done = await until(async () => {
  const g = await call(`/api/generations/${picture.id}`);
  return g.status === "succeeded" && g;
}, "the demo picture");
const url = done.outputs[0].url;
assert.match(url, /^\/api\/files\//, "the picture is a file Fuobe keeps");

const browser = await launch();
const failures = [];
for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"]) {
    const tag = `${phone ? "390" : "1440"}-${scheme}`;
    const ctx = await browser.newContext({ ...(phone ? PHONE : DESKTOP), colorScheme: scheme });
    await ctx.addInitScript((e) => localStorage.setItem("fuobe.engine", e), scheme === "light" ? "cloud" : "open");
    const page = await ctx.newPage();
    page.on("pageerror", (e) => failures.push(`${tag}: page error ${e.message}`));
    page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && failures.push(`${tag}: console ${m.text().slice(0, 200)}`));
    try {
      step(`${tag}: the picture's menu`);
      await page.goto(`${app}/image`, { waitUntil: "load", timeout: 120_000 });
      const tile = page.locator(`img[src="${url}"]`).first();
      await tile.waitFor({ timeout: 60_000 });
      await tile.scrollIntoViewIfNeeded();
      await tile.hover().catch(() => {});
      const card = page.locator("div", { has: tile }).filter({ has: page.getByRole("button", { name: "More actions" }) }).last();
      await card.getByRole("button", { name: "More actions" }).first().click({ timeout: 20_000 });
      const item = page.getByRole("menuitem", { name: "Make it 3D (quick)" });
      await item.waitFor({ timeout: 10_000 });
      // It sits right after Genjutsu's hand-off; the picture's other actions keep their places.
      const items = await page.getByRole("menuitem").allInnerTexts();
      const at = items.findIndex((t) => t.includes("Make it 3D (quick)"));
      assert.ok(at > 0 && /Genjutsu/.test(items[at - 1]), `${tag}: after Genjutsu (${items.join(" | ")})`);
      await shoot(page, `menu-${tag}`);
      await item.click();
      step(`${tag}: Image to 3D, prefilled`);
      await page.waitForURL(/\/image-to-3d\?/, { timeout: 60_000 });
      const sp = new URL(page.url()).searchParams;
      assert.deepEqual([sp.get("mode"), sp.get("model"), sp.get("quality"), sp.get("image")], ["splat", "oss-idol", "quick", url], `${tag}: the link`);
      await page.getByTestId("make-3d-hint").waitFor({ timeout: 60_000 });
      assert.match(await page.getByTestId("make-3d-hint").innerText(), /tens of seconds on a consumer GPU/);
      assert.equal(await page.getByRole("combobox", { name: "Model" }).innerText(), "Idol 3D", `${tag}: Idol 3D picked`);
      assert.equal(await page.getByRole("radio", { name: /Quick look/ }).getAttribute("aria-checked"), "true", `${tag}: Quick look`);
      assert.equal(await page.getByRole("switch", { name: /It's a photo/ }).getAttribute("aria-checked"), "false", `${tag}: the photo crop starts off`);
      assert.ok(await page.locator(`img[src="${url}"]`).first().isVisible(), `${tag}: the picture is in the slot`);
      // The price line is the run's own (a placeholder here), not still working it out.
      await page.getByText(/Working out the price/).waitFor({ state: "detached", timeout: 60_000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0, `${tag}: nothing scrolls sideways`);
      await shoot(page, `studio-${tag}`);
      if (tag === "1440-light") {
        step(`${tag}: one press makes the splat from the picture`);
        const before = Date.now();
        await page.getByRole("button", { name: "Make the splat" }).click();
        const job = await until(async () => {
          const list = await call("/api/generations?features=image-to-3d&limit=5");
          return (list.items ?? list).find((g) => g.createdAt >= before - 5000 && g.modelId === "oss-idol");
        }, "the splat job", 60_000);
        assert.equal(job.request.inputs.images[0], url, "the splat is made from the picture");
        assert.equal(job.request.params?.extra?.photoCrop, false, "the photo crop is off");
        assert.equal(job.request.params?.extra?.steps, 20, "Quick look's steps");
      }
    } catch (e) {
      failures.push(`${tag}: ${e.message}`);
      await shoot(page, `failed-${tag}`);
    }
    await ctx.close();
  }
}
await browser.close();

function shoot(page, name) {
  return shots ? page.screenshot({ path: path.join(shots, `${name}.png`) }).catch(() => {}) : undefined;
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n${failures.map((f) => `  ✗ ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("\nAll Make it 3D checks passed");
