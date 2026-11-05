// Looking around splats (idol-4) in a real browser (the app must be running in demo mode).
// Usage: node tests/e2e/splat-viewer.mjs [appUrl] [--shots=dir]. Exits 1 on any failure.
//
// Demo splats are real files (public/samples/demo-splat.spz and .ply). At 1440 px and 390 px, in light and dark: on
// Image to 3D → Splat, "View in 3D" opens the splat viewer on the card (an .spz from the open engine, a .ply from the
// cloud), the toolbar's controls are labelled and work from the keyboard, "Hide faint haze" starts at 0.05 for
// Idol 3D and Off for TripoSplat; the Library's 3D tab opens a splat full screen with the haze slider and the
// download. Nothing scrolls sideways; no page errors or console errors. Bundle check: a page with no splat never
// fetches Spark; opening a splat does.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { DESKTOP, PHONE, launch } from "./_browser.mjs";

const args = process.argv.slice(2);
const app = (args.find((a) => !a.startsWith("--")) ?? "http://localhost:3000").replace(/\/$/, "");
const shots = args.find((a) => a.startsWith("--shots="))?.slice(8);
if (shots) fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (name) => console.log(`- ${name}`);
async function call(url, method = "GET", data) {
  const res = await fetch(app + url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(data !== undefined && { body: JSON.stringify(data) }),
  });
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

// A photo and three demo splats of it: TripoSplat on the open engine (.spz + orbit video), on the cloud (.ply), and
// Idol 3D on the open engine (.spz, the haze slider at 0.05).
const photo = await (
  await fetch(`${app}/api/uploads`, {
    method: "POST",
    headers: { "content-type": "image/jpeg", "x-file-name": "figure.jpg" },
    body: fs.readFileSync(path.resolve("public/previews/presets/app-3d-figure.jpg")),
  })
).json();
assert.ok(photo.url, `an upload: ${JSON.stringify(photo).slice(0, 200)}`);
const made = {};
for (const modelId of ["oss-triposplat", "triposplat", "oss-idol"]) {
  const r = await call("/api/generations", "POST", {
    feature: "image-to-3d",
    modelId,
    op: "splat",
    inputs: { images: [photo.url] },
  });
  const g = r.items?.[0];
  assert.ok(g, `a demo splat from ${modelId}: ${JSON.stringify(r).slice(0, 300)}`);
  made[modelId] = await until(async () => {
    const d = await call(`/api/generations/${g.id}`);
    return d.status === "succeeded" && d;
  }, `the ${modelId} splat`);
  const mesh = made[modelId].outputs.find((o) => o.kind === "model3d");
  assert.match(mesh.url, modelId === "triposplat" ? /\.ply$/ : /\.spz$/, `${modelId}: a real splat file`);
}

// Chromium draws WebGL2 through SwiftShader when there's no GPU.
const browser = await launch({
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
const failures = [];

async function context(phone, scheme) {
  const ctx = await browser.newContext({
    ...(phone ? PHONE : DESKTOP),
    colorScheme: scheme,
  });
  await ctx.addInitScript(() => {
    localStorage.setItem("fuobe.engine", "both");
    document.addEventListener("DOMContentLoaded", () => {
      const s = document.createElement("style");
      s.textContent = "nextjs-portal{display:none!important}";
      document.head.append(s);
    });
  });
  const page = await ctx.newPage();
  const spark = [];
  // Spark's script, by name (a dev build) or by what's inside it (a production chunk's name is a hash): its WebAssembly
  // glue's module name survives minifying.
  page.on("response", async (r) => {
    if (r.request().resourceType() !== "script") return;
    if (/sparkjsdev|splat-engine/.test(r.url())) return void spark.push(r.url());
    const body = await r.text().catch(() => "");
    if (body.includes("spark_rs_bg")) spark.push(r.url());
  });
  const tag = `${phone ? "phone" : "desktop"} ${scheme}`;
  page.on("pageerror", (e) => failures.push(`${tag}: page error ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && failures.push(`${tag}: console ${m.text().slice(0, 300)}`));
  return { ctx, page, spark, tag };
}
const noSideScroll = async (page, what) =>
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0, `${what}: nothing scrolls sideways`);
const shoot = (page, name) => shots && page.screenshot({ path: path.join(shots, `${name}.png`) });
/** The viewer has drawn something besides its background (a splat is on screen): a screenshot of its canvas. */
async function drawn(locator) {
  const png = await locator.screenshot();
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const [r, g, b] = [data[0], data[1], data[2]];
  let differ = 0;
  // The top two thirds: the toolbar sits at the bottom.
  const end = Math.floor(info.height * 0.66) * info.width * info.channels;
  for (let i = 0; i < end; i += info.channels * 4) if (Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b) > 40) differ++;
  return differ > 200;
}

for (const phone of [false, true]) {
  for (const scheme of ["light", "dark"]) {
    const { ctx, page, spark, tag } = await context(phone, scheme);
    const name = `${phone ? "390" : "1440"}-${scheme}`;
    try {
      // Bundle check: a page with no splat never fetches Spark.
      step(`${tag}: Image (no splat) loads no splat renderer`);
      await page.goto(`${app}/image`, { waitUntil: "load" });
      await sleep(1500);
      assert.deepEqual(spark, [], `${tag}: Spark fetched on a page without a splat`);

      step(`${tag}: Image to 3D → Splat, the cards`);
      await page.goto(`${app}/image-to-3d?mode=splat`, { waitUntil: "load" });
      const cards = page.locator("#your-3d-models article");
      await cards.first().waitFor({ timeout: 30_000 });
      await sleep(800);
      await noSideScroll(page, `${tag} cards`);
      assert.deepEqual(spark, [], `${tag}: Spark fetched before a splat was opened`);
      assert.equal(await page.getByText("doesn't draw splats", { exact: false }).count(), 0, `${tag}: the old note is gone`);

      for (const [modelId, cutoff] of [
        ["oss-idol", "5%"],
        ["triposplat", "Off"],
      ]) {
        const g = made[modelId];
        const card = cards.filter({ hasText: g.modelName ?? modelId }).first();
        await card.scrollIntoViewIfNeeded();
        // The download stays.
        const ext = modelId === "triposplat" ? "ply" : "spz";
        assert.equal(await card.getByRole("link", { name: `.${ext}` }).count(), 1, `${tag} ${modelId}: the .${ext} download`);
        await card.getByRole("button", { name: "View in 3D" }).click();
        const toolbar = card.getByRole("toolbar", { name: "3D view" });
        await toolbar.waitFor({ timeout: 60_000 });
        assert.ok(spark.length > 0, `${tag}: opening a splat fetches Spark`);
        const stage = card.getByRole("application", { name: /Look around/ });
        await until(() => drawn(stage.locator("canvas")), `${tag} ${modelId}: the splat drawn`, 30_000);
        // Focus went to the viewer; the keyboard turns and zooms it, 0 resets.
        assert.equal(await stage.evaluate((el) => document.activeElement === el), true, `${tag} ${modelId}: the viewer has the focus`);
        for (const k of ["ArrowLeft", "ArrowUp", "+", "-", "0"]) await page.keyboard.press(k);
        for (const label of ["Reset view", "Turn it over", "Light background", "Grey background", "Dark background", "Hide faint haze", "Save a still"]) {
          assert.equal(
            await toolbar
              .getByRole(/background/.test(label) ? "radio" : "button", {
                name: label,
              })
              .count(),
            1,
            `${tag} ${modelId}: ${label}`,
          );
        }
        await toolbar.getByRole("radio", { name: "Grey background" }).click();
        assert.equal(await toolbar.getByRole("radio", { name: "Grey background" }).getAttribute("aria-checked"), "true");
        await toolbar.getByRole("button", { name: "Hide faint haze" }).click();
        const slider = page.getByRole("slider", { name: "Hide faint haze" });
        await slider.waitFor();
        assert.equal(
          await page.locator("[data-slot=popover-content]").getByText(cutoff, { exact: true }).count(),
          1,
          `${tag} ${modelId}: haze starts at ${cutoff}`,
        );
        await slider.focus();
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("Escape");
        await noSideScroll(page, `${tag} ${modelId} viewer`);
        await shoot(page, `${name}-card-${modelId}`);
        // Save a still: the PNG goes to the uploads.
        const uploads = async () => {
          const r = await call("/api/assets?source=upload&limit=200");
          return (Array.isArray(r) ? r : (r.items ?? r.assets ?? [])).length;
        };
        const before = await uploads();
        await toolbar.getByRole("button", { name: "Save a still" }).click();
        await page.getByText("Still saved to your Library").first().waitFor({ timeout: 20_000 });
        await until(async () => (await uploads()) > before, `${tag}: the still in the uploads`, 10_000);
      }

      step(`${tag}: the Library's 3D tab opens a splat full screen`);
      await page.goto(`${app}/library?tab=3d`, { waitUntil: "load" });
      await sleep(1500);
      await noSideScroll(page, `${tag} library 3d`);
      // The newest 3D result: a demo splat made above.
      await page
        .getByRole("button", { name: /^Open “Gaussian splat/ })
        .first()
        .focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("toolbar", { name: "3D view" }).waitFor({ timeout: 60_000 });
      assert.equal(await dialog.getByRole("slider", { name: "Hide faint haze" }).count(), 1, `${tag}: the panel's haze slider`);
      await until(() => drawn(dialog.getByRole("application").locator("canvas")), `${tag}: the panel's splat drawn`, 30_000);
      assert.ok((await dialog.getByRole("link", { name: /^\.(spz|ply)$/ }).count()) >= 1, `${tag}: the panel's download`);
      await noSideScroll(page, `${tag} library viewer`);
      await sleep(1000);
      await shoot(page, `${name}-panel`);
      // Opening the panel doesn't take the arrow keys: ArrowRight keeps browsing the results.
      const shown = async () => (await dialog.getByRole("link", { name: /^\.(spz|ply)$/ }).first().getAttribute("href", { timeout: 2000 }).catch(() => null)) ?? "";
      const before = await shown();
      await page.keyboard.press("ArrowRight");
      await until(async () => (await shown()) !== before, `${tag}: ArrowRight moved to the next result`, 15_000);
      // Once the user presses on the splat, the arrow keys turn it instead.
      const stagePanel = dialog.getByRole("application");
      if ((await stagePanel.count()) === 1) {
        await stagePanel.waitFor();
        await stagePanel.click();
        const here = await shown();
        await page.keyboard.press("ArrowRight");
        await sleep(1500);
        assert.equal(await shown(), here, `${tag}: ArrowRight turns the splat the user pressed on`);
      }
    } catch (e) {
      failures.push(`${tag}: ${e.message}`);
      await shoot(page, `${name}-failure`);
    }
    await ctx.close();
  }
}

// A GLB still opens in @google/model-viewer, and doesn't bring Spark in.
{
  step("a GLB result: model-viewer, no splat renderer");
  const r = await call("/api/generations", "POST", { feature: "image-to-3d", modelId: "oss-pixal3d", op: "image-to-3d", inputs: { images: [photo.url] } });
  const g = r.items?.[0];
  assert.ok(g, "a demo GLB");
  await until(async () => (await call(`/api/generations/${g.id}`)).status === "succeeded", "the demo GLB");
  const { ctx, page, spark, tag } = await context(false, "light");
  try {
    await page.goto(`${app}/image-to-3d`, { waitUntil: "load" });
    const card = page.locator("#your-3d-models article").first();
    await card.getByRole("button", { name: "View in 3D" }).click({ timeout: 30_000 });
    await card.locator("model-viewer").waitFor({ timeout: 60_000 });
    await sleep(1000);
    assert.deepEqual(spark, [], `${tag}: Spark fetched for a GLB`);
  } catch (e) {
    failures.push(`GLB: ${e.message}`);
  }
  await ctx.close();
}

// Reduced motion: the full-screen viewer keeps the orbit video until "Look around in 3D".
{
  step("reduced motion: the orbit video stays until asked");
  const ctx = await browser.newContext({ ...DESKTOP, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => failures.push(`reduced motion: page error ${e.message}`));
  try {
    await page.goto(`${app}/library?tab=3d`, { waitUntil: "load" });
    await sleep(1500);
    await page
      .getByRole("button", { name: /^Open “Gaussian splat/ })
      .first()
      .focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Look around in 3D" }).click({ timeout: 30_000 });
    await dialog.getByRole("toolbar", { name: "3D view" }).waitFor({ timeout: 60_000 });
    // Chosen: the viewer takes the focus, so the keys turn the splat.
    await until(() => dialog.getByRole("application").evaluate((el) => document.activeElement === el), "reduced motion: the chosen viewer has the focus", 30_000);
    await shoot(page, "reduced-motion-panel");
  } catch (e) {
    failures.push(`reduced motion: ${e.message}`);
    await shoot(page, "reduced-motion-failure");
  }
  await ctx.close();
}

await browser.close();
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("splat viewer: all checks passed");
