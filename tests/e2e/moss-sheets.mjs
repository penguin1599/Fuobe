// N7-11 in a real browser (the app must be running in demo mode, as the owner): Storyboard's "One sheet" option and
// Layers' "Re-render from layers" tool, at 1440 px and 390 px, in light and dark. Usage: node tests/e2e/moss-sheets.mjs [appUrl]
//
// 1. Storyboard: One sheet renders with its price, hides references, looks and the partner picker, reaches by keyboard,
//    makes one sheet whose panels show as frames; nothing scrolls sideways, no console errors.
// 2. Layers (desktop; phones get the read-only view): the tool opens, lists the layers it will place, reaches by keyboard
//    and runs; the re-render lands as a new layer on top.
import assert from "node:assert/strict";
import path from "node:path";
import { DESKTOP, launch, PHONE, root } from "./_browser.mjs";

const app = (process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "http://localhost:3000").replace(/\/$/, "");
const SAMPLE = path.join(root, "public/samples/grade-sample.jpg");
const browser = await launch();
const step = (name) => console.log(`- ${name}`);

const noSideScroll = async (page, where) => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(over <= 1, `${where}: scrolls sideways by ${over}px`);
};
/** Tab until the element named has focus (at most 80 presses). */
const tabTo = async (page, locator, where) => {
  const el = await locator.elementHandle();
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate((e) => document.activeElement === e, el)) return;
  }
  assert.fail(`${where}: keyboard focus never reached it`);
};
const watch = (page) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  return errors;
};

try {
  for (const scheme of ["light", "dark"]) {
    for (const [label, device] of [["1440", DESKTOP], ["390", PHONE]]) {
      const where = `storyboard ${label} ${scheme}`;
      step(where);
      const ctx = await browser.newContext({ ...device, colorScheme: scheme });
      await ctx.addInitScript(() => localStorage.setItem("fuobe.engine", "open"));
      const page = await ctx.newPage();
      const errors = watch(page);
      await page.goto(`${app}/storyboard`, { waitUntil: "load", timeout: 120_000 });
      const one = page.getByRole("radio", { name: "One sheet" });
      await one.waitFor({ timeout: 60_000 });
      assert.ok(await page.getByRole("button", { name: "Look ref" }).count(), `${where}: references offered frame by frame`);
      if (label === "1440") await tabTo(page, one, where);
      if (label === "390") await one.tap();
      else await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelector('[role="radio"][aria-checked="true"]')?.textContent?.includes("One sheet") || [...document.querySelectorAll('[role="radio"]')].some((r) => r.textContent?.includes("One sheet") && r.getAttribute("aria-checked") === "true"));
      assert.equal(await page.getByRole("button", { name: "Look ref" }).count(), 0, `${where}: no references on one sheet`);
      assert.equal(await page.getByRole("radiogroup", { name: "Next frames made on" }).count(), 0, `${where}: no next-frame picker`);
      await page.getByText(/panels · 1 sheet/).waitFor({ timeout: 30_000 });
      await page.getByText(/Free|Placeholder/).first().waitFor();
      await page.getByText(/Not yet tested on a GPU/).waitFor();
      await noSideScroll(page, where);
      await page.screenshot({ path: `/tmp/moss-sheets-storyboard-${label}-${scheme}.png`, fullPage: false });
      if (label === "1440" && scheme === "light") {
        step("one sheet: four panels come back as frames");
        await page.getByRole("textbox", { name: "Your story" }).fill("a lighthouse keeper finds a glowing bottle and follows its map into the sea");
        await page.getByRole("button", { name: "Generate storyboard" }).click();
        await page.getByText(/4 panels on one sheet/).first().waitFor({ timeout: 90_000 });
        await page.getByRole("button", { name: /Open the sheet at panel 4/ }).first().waitFor({ timeout: 90_000 });
        await noSideScroll(page, `${where} with a sheet`);
        await page.screenshot({ path: `/tmp/moss-sheets-storyboard-board.png` });
      }
      assert.deepEqual(errors, [], `${where}: console errors`);
      await ctx.close();
    }
  }

  step("layers: Re-render from layers");
  for (const scheme of ["light", "dark"]) {
    const where = `layers 1440 ${scheme}`;
    const ctx = await browser.newContext({ ...DESKTOP, colorScheme: scheme });
    await ctx.addInitScript(() => localStorage.setItem("fuobe.engine", "cloud"));
    const page = await ctx.newPage();
    const errors = watch(page);
    await page.goto(`${app}/layers`, { waitUntil: "load", timeout: 120_000 });
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload Media" }).first().click();
    await (await chooser).setFiles(SAMPLE);
    await page.waitForURL(/\/layers\/[\w-]+$/, { timeout: 60_000 });
    await page.getByRole("button", { name: "Separate layers" }).waitFor({ timeout: 60_000 });
    if (scheme === "light") {
      // Layers to place: a decomposition (placeholder layers in demo mode).
      await page.getByRole("button", { name: "Separate layers" }).click();
      await page.locator("[data-sonner-toast]").filter({ hasText: /Decomposed into/ }).first().waitFor({ timeout: 120_000 });
    }
    await page.getByRole("button", { name: "Back to tools" }).click();
    const tool = page.getByRole("button", { name: "Re-render from layers" });
    await tool.waitFor({ timeout: 60_000 });
    await tabTo(page, tool, where);
    await page.keyboard.press("Enter");
    await page.getByText(/lines? of text in place|backdrop layer/).first().waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Read the text first" }).waitFor();
    const run = page.getByRole("button", { name: "Re-render", exact: true });
    // The original picture alone is its backdrop: nothing to box yet, so the run waits for a layer.
    const status = await page.getByRole("status").filter({ hasText: /in place|Show at least one layer/ }).first().textContent();
    await tabTo(page, page.getByRole("textbox", { name: "Describe the picture" }), where);
    await noSideScroll(page, where);
    await page.screenshot({ path: `/tmp/moss-sheets-layers-${scheme}.png` });
    if (/Show at least one layer/.test(status ?? "")) assert.ok(await run.isDisabled(), `${where}: run waits for a layer`);
    else {
      await run.click();
      await page.locator("[data-sonner-toast]").filter({ hasText: /Re-render added on top/ }).first().waitFor({ timeout: 120_000 });
      await page.getByRole("button", { name: /^Select layer Re-render/ }).first().waitFor();
    }
    assert.deepEqual(errors, [], `${where}: console errors`);
    await ctx.close();
  }
  console.log("ok");
} finally {
  await browser.close();
}
