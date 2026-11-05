// Browser check of NVIDIA RTX Video (nm10-rtx-video).
// Usage: node tests/e2e/rtx-video.mjs [appUrl] [outDir]   (the app in demo mode: no keys, no ComfyUI)
// At 1440 px and 390 px, light and dark, on the open engine: Upscale → Video's "Quick · RTX" beside Restore · faithful (and
// Regenerate · creative while it is offered) — last and not picked when the card isn't known, first (still not picked) on an RTX 4070, switched
// off with "Needs an NVIDIA RTX card" on an AMD card; picking it on the RTX card shows its line. FPS boost and SDR to HDR
// open on their RTX choice from a link. The GPU check's answer is stubbed in the browser (/api/gpu/badges). Fails on any
// console error or page error, and on sideways scroll. Screenshots go to outDir.
import fs from "node:fs";
import path from "node:path";
import { DESKTOP, PHONE, launch, openRoute } from "./_browser.mjs";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const app = (args[0] ?? "http://localhost:3000").replace(/\/$/, "");
const out = args[1] ?? fs.mkdtempSync("/tmp/fuobe-rtx-");
fs.mkdirSync(out, { recursive: true });

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures.push(what);
};
const noSideScroll = async (page, label) => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(over <= 0, `${label}: no horizontal scroll (${over}px)`);
};
// What the GPU check would answer for a card: an RTX 4070 (everything ready), an AMD card (the RTX choices can't run).
const BADGES = {
  rtx: { connected: true, checkedAt: Date.now(), gpu: "RTX 4070", vramGb: 12, models: { "oss-rtx-video-upscale#upscale-video": ["r", 0, 0, 0], "oss-seedvr2#upscale-video": ["r", 0, 0, 0] }, presets: {} },
  amd: { connected: true, checkedAt: Date.now(), gpu: "AMD Radeon RX 7900 XTX", vramGb: 24, models: { "oss-rtx-video-upscale#upscale-video": ["u", 0, 0, 8], "oss-seedvr2#upscale-video": ["r", 0, 0, 0] }, presets: {} },
};
const setup = async (browser, device, theme, badges) => {
  const ctx = await browser.newContext({ ...device, colorScheme: theme });
  await ctx.addInitScript(() => localStorage.setItem("fuobe.engine", "open"));
  await ctx.route((u) => u.origin !== new URL(app).origin && /^https?:$/.test(u.protocol), (rt) => rt.abort());
  if (badges) await ctx.route(`${app}/api/gpu/badges`, (rt) => rt.fulfill({ json: badges }));
  return ctx;
};
const watch = (page, label) => {
  page.on("pageerror", (e) => failures.push(`${label} page error: ${e.message.split("\n")[0]}`));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource|net::ERR_/.test(m.text()) && failures.push(`${label} console error: ${process.env.FULL ? m.text().slice(0, 4000) : m.text().split("\n")[0]}`));
};

const browser = await launch();
try {
  for (const [dname, device] of [
    ["1440", DESKTOP],
    ["390", PHONE],
  ]) {
    for (const theme of ["light", "dark"]) {
      for (const card of ["unknown", "rtx", "amd"]) {
        const label = `${dname} ${theme} ${card}`;
        const ctx = await setup(browser, device, theme, BADGES[card]);
        const page = await ctx.newPage();
        watch(page, label);
        await openRoute(page, `${app}/upscale/video`);
        const group = page.getByRole("radiogroup", { name: "How to finish the clip" });
        await group.waitFor({ timeout: 30_000 });
        const radios = group.getByRole("radio");
        const names = await radios.allInnerTexts();
        const quick = group.getByRole("radio", { name: /Quick · RTX/ });
        const restore = group.getByRole("radio", { name: /Restore · faithful/ });
        // Restore · faithful and Quick · RTX (Regenerate · creative joins them while it is offered).
        check(names.length === 2, `${label}: two choices (${names.length})`);
        check((await restore.getAttribute("aria-checked")) === "true", `${label}: Restore · faithful stays the default`);
        check((await quick.getAttribute("aria-checked")) === "false", `${label}: Quick · RTX is not picked for anyone`);
        const first = /Quick · RTX/.test(names[0] ?? "");
        if (card === "rtx") check(first, `${label}: Quick · RTX comes first on an RTX card`);
        else check(!first && /Quick · RTX/.test(names.at(-1) ?? ""), `${label}: Quick · RTX comes last`);
        if (card === "amd") {
          check(/Needs an NVIDIA RTX card/.test(await quick.innerText()), `${label}: says it needs an NVIDIA RTX card`);
          check((await quick.getAttribute("aria-disabled")) === "true", `${label}: switched off`);
          await quick.click({ force: true });
          await page.waitForTimeout(300);
          check((await quick.getAttribute("aria-checked")) === "false", `${label}: a click doesn't pick it`);
        }
        if (card === "unknown") check(/Runs on NVIDIA RTX cards/.test(await quick.innerText()), `${label}: says it runs on NVIDIA RTX cards`);
        await noSideScroll(page, label);
        await page.screenshot({ path: path.join(out, `upscale-video-${card}-${dname}-${theme}.png`), fullPage: true });
        if (card === "rtx") {
          await quick.click();
          await page.waitForTimeout(500);
          check((await quick.getAttribute("aria-checked")) === "true", `${label}: a click picks Quick · RTX`);
          check(await page.getByText("only on NVIDIA RTX cards", { exact: false }).first().isVisible(), `${label}: the line under it says NVIDIA RTX cards only`);
          await noSideScroll(page, `${label} picked`);
          await page.screenshot({ path: path.join(out, `upscale-video-rtx-picked-${dname}-${theme}.png`), fullPage: true });
        }
        await ctx.close();
      }
      // FPS boost and SDR to HDR, opened on their RTX choice.
      for (const [route, name] of [
        ["/upscale/fps?model=oss-rtx-frame-generation", "RTX Frame Generation"],
        ["/upscale/hdr?model=oss-rtx-video-hdr", "RTX Video HDR"],
      ]) {
        const label = `${dname} ${theme} ${route}`;
        const ctx = await setup(browser, device, theme, BADGES.rtx);
        const page = await ctx.newPage();
        watch(page, label);
        await openRoute(page, `${app}${route}`);
        // The composer's model chip names the model it opened on (waited for: a screenshot during hydration would touch the DOM).
        const chip = page.getByRole("button", { name: new RegExp(name) }).first();
        await chip.waitFor({ timeout: 60_000 }).catch(() => {});
        check(await chip.isVisible().catch(() => false), `${label}: opens on ${name}`);
        await noSideScroll(page, label);
        await page.screenshot({ path: path.join(out, `${route.split("?")[0].replaceAll("/", "-").slice(1)}-${dname}-${theme}.png`), fullPage: true });
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
}
console.log(failures.length ? `\n${failures.length} failure(s):\n- ${failures.join("\n- ")}` : "\nAll checks passed.");
console.log(`Screenshots: ${out}`);
process.exit(failures.length ? 1 : 0);
