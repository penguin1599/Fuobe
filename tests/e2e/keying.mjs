// Browser check of Green screen and fine hair (nm10-keying): Video tools → Green screen (CorridorKey 2.0 on your GPU, Bria
// green screen in the cloud) with its outputs and formats, Remove background with Bria VRMBG 3.0 on the open engine, and
// Layers → Remove background with FeyNoBg (open) and Bria's guided cut-out and its what-to-keep box (cloud).
// Usage: node tests/e2e/keying.mjs [appUrl] [outDir]
//   appUrl: the app in demo mode (FUOBE_DEMO_MODE=on, no keys, COMFYUI_URL pointing at nothing), as the owner.
// Each page at 1440 and 390 px, light and dark, both engines: its heading, the model it opens on, no sideways scroll.
// A page error or a console error fails the run. Screenshots go to outDir.
import fs from "node:fs";
import path from "node:path";
import { DESKTOP, PHONE, launch, openRoute, root } from "./_browser.mjs";

const app = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");
const out = process.argv[3] ?? fs.mkdtempSync("/tmp/fuobe-keying-");
fs.mkdirSync(out, { recursive: true });
const SAMPLE = path.join(root, "public/samples/grade-sample.jpg");

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures.push(what);
};
const noSideScroll = async (page, label) => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(over <= 0, `${label}: no horizontal scroll (${over}px)`);
};
async function setup(browser, device, theme, engine, label) {
  const ctx = await browser.newContext({ ...device, colorScheme: theme });
  ctx.on("page", (p) => {
    p.on("pageerror", (e) => check(false, `${label}: no page error (${String(e.message).slice(0, 160)})`));
    p.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && check(false, `${label}: no console error on ${p.url()} (${m.text().slice(0, process.env.FULL ? 4000 : 160)})`));
  });
  await ctx.addInitScript(
    ([e]) => {
      try {
        localStorage.setItem("fuobe.engine", e);
      } catch {}
    },
    [engine],
  );
  await ctx.route((u) => u.origin !== new URL(app).origin && /^https?:$/.test(u.protocol), (r) => r.abort());
  return ctx;
}

// An image for Layers, uploaded once.
const form = new FormData();
form.append("file", new Blob([fs.readFileSync(SAMPLE)], { type: "image/jpeg" }), "keying-sample.jpg");
const up = await fetch(`${app}/api/uploads`, { method: "POST", body: form });
const image = up.ok ? (await up.json()).url : null;
check(!!image, `the sample image uploads (${up.status})`);

const browser = await launch();
try {
  for (const [size, device] of [["1440", DESKTOP], ["390", PHONE]]) {
    for (const theme of ["light", "dark"]) {
      for (const engine of ["open", "cloud"]) {
        const label = `${size} ${theme} ${engine}`;
        const ctx = await setup(browser, device, theme, engine, label);
        const page = await ctx.newPage();

        // Video tools → Green screen.
        await openRoute(page, `${app}/video-tools/green-screen`);
        check(await page.getByRole("heading", { name: "Key out a green screen" }).isVisible(), `${label}: Green screen's heading`);
        // The composer settles on the engine's model once it has hydrated (the engine is the browser's choice).
        const shows = (t) => page.locator(`:text-is("${t}"):visible`).first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
        check(await shows(engine === "open" ? "CorridorKey 2.0" : "Bria green screen"), `${label}: opens on ${engine === "open" ? "CorridorKey 2.0" : "Bria green screen"}`);
        // "Free" when the app reaches a ComfyUI; "Placeholder" when it doesn't (demo mode with no GPU).
        check(engine === "cloud" || /\bFree\b|Placeholder/.test(await page.locator("form, main, body").first().innerText()), `${label}: the price says Free on your GPU (or Placeholder with none connected)`);
        await noSideScroll(page, `${label} green screen`);
        if (size === "1440" && engine === "open") {
          // The settings: the three outputs and the three formats.
          const settings = page.getByRole("button", { name: /^Settings:/ }).first();
          if (await settings.isVisible().catch(() => false)) {
            await settings.click();
            await page.waitForTimeout(400);
            const panel = await page.locator("body").innerText();
            for (const t of ["Cutout video", "Alpha mask", "Clean foreground", "Transparent WebM", "ProRes 4444", "EXR frames, 16-bit"]) check(panel.includes(t), `${label}: settings offer ${t}`);
            await page.screenshot({ path: `${out}/green-screen-settings-${theme}.png`, caret: "initial" });
            await page.keyboard.press("Escape");
          } else check(false, `${label}: a settings button`);
        }
        await page.screenshot({ path: `${out}/green-screen-${label.replaceAll(" ", "-")}.png`, fullPage: true, caret: "initial" });

        // Remove background: VRMBG 3.0 is offered on the open engine (the picker lists it), the keyers aren't.
        await openRoute(page, `${app}/video-tools?model=oss-video-matte-vrmbg3`);
        check(await page.getByRole("heading", { name: "Cut out the subject" }).isVisible(), `${label}: Remove background's heading`);
        if (engine === "open") check(await shows("Bria VRMBG 3.0"), `${label}: ?model= opens Remove background on Bria VRMBG 3.0`);
        check(!(await page.locator("body").innerText()).includes("CorridorKey"), `${label}: Remove background doesn't list CorridorKey`);
        await noSideScroll(page, `${label} remove background`);
        await page.screenshot({ path: `${out}/matte-${label.replaceAll(" ", "-")}.png`, fullPage: true, caret: "initial" });

        // Layers → Remove background: FeyNoBg on your GPU, the guided cut-out's box in the cloud.
        if (image && size === "1440") {
          await page.goto(`${app}/layers?image=${encodeURIComponent(image)}`, { waitUntil: "load", timeout: 120_000 });
          await page.waitForURL(/\/layers\/[\w-]+$/, { timeout: 60_000 });
          await page.getByRole("button", { name: "Separate layers" }).waitFor({ timeout: 60_000 });
          const back = page.getByRole("button", { name: "Back to tools" });
          if (await back.isVisible()) await back.click();
          await page.getByRole("button", { name: /^Remove background/ }).first().click();
          await page.waitForTimeout(400);
          const select = page.getByRole("combobox", { name: "Model" });
          await select.click();
          const want = engine === "open" ? "FeyNoBg fine hair" : "Bria guided cut-out";
          const option = page.getByRole("option", { name: want });
          check(await option.isVisible(), `${label}: Layers' Remove background lists ${want}`);
          await option.click();
          await page.waitForTimeout(300);
          const box = page.getByLabel("What to keep or drop (optional)");
          if (engine === "cloud") {
            check(await box.isVisible(), `${label}: the guided cut-out's what-to-keep box`);
            await box.fill("keep the shadow");
          } else check(!(await box.isVisible().catch(() => false)), `${label}: no words box for FeyNoBg`);
          await noSideScroll(page, `${label} layers`);
          await page.screenshot({ path: `${out}/layers-cutout-${label.replaceAll(" ", "-")}.png`, caret: "initial" });
        }
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
}
console.log(failures.length ? `\n${failures.length} failed` : "\nAll checks passed");
console.log(`Screenshots: ${out}`);
process.exit(failures.length ? 1 : 0);
