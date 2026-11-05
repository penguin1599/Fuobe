// World mode (package nm10-hy-nomas-world) in a real browser (the app must be running in demo mode).
// Usage: node tests/e2e/cinema-world.mjs [appUrl] [--shots=dir]. Exits 1 on the first failure.
//
// 1. 1440 px, light, open engine: /cinema/<id>?world=1 opens the World panel; the opening is written (with stray spaces,
//    which must not leave a finished turn looking changed), "Run the opening"
//    queues a take that remembers its turn; once its clip lands a turn is added with a camera move, "Preview the path"
//    draws the camera from above, turn 1 runs, and Export joins the two turns into one film. "Free" and the sound links
//    show; Redo from here is offered on a finished turn.
// 2. 1440 px, dark, cloud engine: the panel says it runs on your GPU and offers to switch; nothing runs on the cloud.
// 3. 390 px, light and dark: the panel fits with nothing scrolling sideways.
// Any page error or console error fails the run.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DESKTOP, PHONE, chromiumPath, loadPlaywright } from "./_browser.mjs";

const args = process.argv.slice(2);
const app = (args.find((a) => !a.startsWith("--")) ?? "http://localhost:3000").replace(/\/$/, "");
const shots = args.find((a) => a.startsWith("--shots="))?.slice(8);
if (shots) fs.mkdirSync(shots, { recursive: true });
const { chromium } = loadPlaywright();
const browser = await chromium.launch({ executablePath: chromiumPath() });
const step = (name) => console.log(`- ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = browser.newContext().then((c) => c.request);
async function call(url, method = "GET", data) {
  const res = await (await api).fetch(app + url, { method, headers: { "Content-Type": "application/json" }, data: data === undefined ? undefined : JSON.stringify(data) });
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
const shoot = (page, name) => shots && page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });
const hideDevBadge = (ctx) =>
  ctx.addInitScript(() =>
    document.addEventListener("DOMContentLoaded", () => {
      const s = document.createElement("style");
      s.textContent = "nextjs-portal{display:none!important}";
      document.head.append(s);
    }),
  );
const noSideScroll = async (page, what) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0, `${what}: nothing scrolls sideways`);

const status = await call("/api/status");
assert.notEqual(status.demoMode, "off", "run the app in demo mode (FUOBE_DEMO_MODE=on)");
const project = await call("/api/cinema/projects", "POST", { name: "World check" });
const items = async () => (await call(`/api/cinema/projects/${project.id}/items`)).items;
const errors = [];
let failed = false;

async function open(ctx, engine) {
  await ctx.addInitScript((e) => localStorage.setItem("fuobe.engine", e), engine);
  await hideDevBadge(ctx);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${app}/cinema/${project.id}?world=1`, { waitUntil: "load", timeout: 120_000 });
  await page.getByRole("dialog", { name: "World" }).waitFor({ timeout: 60_000 });
  return page;
}

try {
  {
    step("1440 px, light, your GPU: write the opening, run it, add a turn, preview the path, run it, export");
    const ctx = await browser.newContext({ ...DESKTOP, colorScheme: "light" });
    const page = await open(ctx, "open");
    const dlg = page.getByRole("dialog", { name: "World" });
    await dlg.getByLabel("The world, in words").fill("A stone path through a luminous forest at dusk, blue fireflies between mossy trees, mist on the ground. \n");
    await dlg.getByLabel("Who the camera follows").fill(" a small orange fox ");
    await dlg.getByLabel("What happens first").fill("the fox walks slowly along the path");
    await dlg.getByLabel("Opening camera move").selectOption("zoom_in");
    assert.match(await dlg.innerText(), /free/i);
    assert.match(await dlg.innerText(), /Sound for video/);
    await shoot(page, "world-1440-light-opening");
    await dlg.getByRole("button", { name: "Run the opening" }).last().click();
    const first = await until(async () => (await items()).find((g) => g.take?.world?.turn === 0), "the opening's take");
    assert.equal(first.feature, "cinema-world");
    assert.equal(first.op, "world-turn");
    await until(async () => (await items()).find((g) => g.id === first.id && g.status === "succeeded"), "the opening's clip");
    await dlg.getByText("Ready").first().waitFor({ timeout: 30_000 });
    await dlg.getByRole("button", { name: "Redo from here" }).first().waitFor();
    assert.equal(await dlg.getByText("Changed: run it again").count(), 0, "a finished turn typed with stray spaces stays finished");

    await dlg.getByRole("button", { name: "Add a turn" }).click();
    await dlg.getByLabel("Turn 1: what changes").fill("a wooden bridge crosses a glowing stream ahead ");
    await dlg.getByLabel("Turn 1: camera move").selectOption("orbit_90_ccw");
    await dlg.getByRole("button", { name: "Preview the path" }).click();
    await dlg.getByRole("img", { name: /camera's path from above/ }).waitFor();
    assert.equal(await dlg.locator("svg polyline").count(), 2, "one line per turn");
    await shoot(page, "world-1440-light-turns");
    await dlg.getByRole("button", { name: "Run turn 1" }).click();
    const second = await until(async () => (await items()).find((g) => g.take?.world?.turn === 1), "turn 1's take");
    await until(async () => (await items()).find((g) => g.id === second.id && g.status === "succeeded"), "turn 1's clip");
    const exportButton = dlg.getByRole("button", { name: "Export" });
    await until(async () => exportButton.isEnabled(), "Export to be offered", 30_000);
    await exportButton.click();
    const film = await until(async () => (await items()).find((g) => g.take?.world?.joined), "the joined film");
    assert.equal(film.op, "concat");
    await shoot(page, "world-1440-light-exported");
    await ctx.close();
  }
  {
    step("1440 px, dark, cloud: runs on your GPU only, offered to switch");
    const ctx = await browser.newContext({ ...DESKTOP, colorScheme: "dark" });
    const page = await open(ctx, "cloud");
    const dlg = page.getByRole("dialog", { name: "World" });
    assert.match(await dlg.innerText(), /Runs on your GPU \(open source\)/);
    await dlg.getByRole("button", { name: "Use your GPU" }).waitFor();
    await shoot(page, "world-1440-dark-cloud");
    await ctx.close();
  }
  for (const scheme of ["light", "dark"]) {
    step(`390 px, ${scheme}: the panel fits`);
    const ctx = await browser.newContext({ ...PHONE, colorScheme: scheme });
    const page = await open(ctx, "open");
    await noSideScroll(page, `World panel at 390 px (${scheme})`);
    const dlg = page.getByRole("dialog", { name: "World" });
    const box = await dlg.boundingBox();
    assert.ok(box && box.width <= 390, "the panel fits the screen");
    await dlg.getByRole("button", { name: "Preview the path" }).click();
    await noSideScroll(page, `World path at 390 px (${scheme})`);
    await shoot(page, `world-390-${scheme}`);
    await ctx.close();
  }
  assert.deepEqual(errors, [], "no page or console errors");
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  if (errors.length) console.log("PAGE ERRORS:\n" + errors.map((e) => e.slice(0, 600)).join("\n---\n"));
  await browser.close();
}
if (failed) process.exit(1);
console.log("ok");
