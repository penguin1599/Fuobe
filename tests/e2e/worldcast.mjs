// WorldCast on your GPU (build plan N7-9) in a real browser. The app must run in demo mode, on the open engine, with
// ComfyUI unreachable (FUOBE_DEMO_MODE=on FUOBE_ENGINE_MODE=open COMFYUI_URL=http://127.0.0.1:9).
// Usage: node tests/e2e/worldcast.mjs [appUrl] [--shots=dir]. Exits 1 on any failure.
//
// A stand-in WorldCast worker answers GET /health on a free port. At 1440 px and 390 px, in light and in dark:
// 1. Settings → Open-source engine: the WorldCast worker URL row renders, keyboard focus reaches its field and its button,
//    Save & test connects to the stand-in, nothing scrolls sideways.
// 2. A character's Fly around (Turnaround), with the worker: the WorldCast route, chosen, and its line; without it: Frames
//    and "Runs on Frames: add a WorldCast worker (48 GB+)…". At 390 px a finger drag scrolls the dialog.
// 3. Fly around / exact orbits (/api/fly-around?preview=1): WorldCast with the worker, the Uni3C line without it.
// No page errors or console errors.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DESKTOP, PHONE, launch, root } from "./_browser.mjs";

const args = process.argv.slice(2);
const app = (args.find((a) => !a.startsWith("--")) ?? "http://localhost:3000").replace(/\/$/, "");
const shots = args.find((a) => a.startsWith("--shots="))?.slice(8);
if (shots) fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (what, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${what}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};
async function call(url, method = "GET", data) {
  const res = await fetch(app + url, { method, headers: { "Content-Type": "application/json" }, ...(data !== undefined && { body: JSON.stringify(data) }) });
  return res.json();
}

// The stand-in worker.
const worker = http.createServer((req, res) => {
  res.writeHead(req.url === "/health" ? 200 : 404, { "content-type": "application/json" });
  res.end(JSON.stringify(req.url === "/health" ? { ok: true, model: "PixCtrol/WorldCast@7ccf2e0", vram_gb: 80, depth: [] } : { error: "not found" }));
});
await new Promise((r) => worker.listen(0, "127.0.0.1", r));
const workerUrl = `http://127.0.0.1:${worker.address().port}`;
const setWorker = (url) => call("/api/settings", "PUT", { worldcastUrl: url });

const status = await call("/api/status");
assert.notEqual(status.demoMode, "off", "run the app in demo mode (FUOBE_DEMO_MODE=on)");

async function upload(file, name) {
  const f = new FormData();
  f.append("file", new Blob([fs.readFileSync(file)], { type: "image/png" }), name);
  return (await (await fetch(`${app}/api/uploads`, { method: "POST", body: f })).json()).url;
}
const fixtures = path.join(root, "scripts/eval/fixtures/character");
const photos = await Promise.all(["drawn-face-1.png", "drawn-face-2.png", "drawn-face-3.png"].map((f) => upload(path.join(fixtures, f), f)));
const element = await call("/api/elements", "POST", { name: "Ada Cast", kind: "character", references: photos });

// 3. The planner's answers, with and without the worker.
const orbit = { degrees: 360, direction: "cw", tilt: 0, pulse: 0 };
await setWorker(workerUrl);
const withWorker = await call("/api/fly-around?preview=1", "POST", { engine: "open", image: photos[0], orbit });
check("Fly around plans WorldCast while the worker answers", withWorker.model?.id === "oss-worldcast", JSON.stringify(withWorker).slice(0, 300));
check("…free, 5.4 s", withWorker.costUsd === 0 && withWorker.duration === 5.4, `${withWorker.costUsd} ${withWorker.duration}`);
await setWorker("");
const without = await call("/api/fly-around?preview=1", "POST", { engine: "open", image: photos[0], orbit });
check("Fly around falls back to Uni3C and says so", without.model?.id === "oss-uni3c-path" && without.notes.some((n) => n.startsWith("Runs on Uni3C: add a WorldCast worker (48 GB+)")), JSON.stringify(without.notes));

const browser = await launch();
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const shoot = (page, name) => shots && page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });

async function fingerScroll(page, el) {
  const box = await el.boundingBox();
  const before = await el.evaluate((n) => n.scrollTop);
  const cdp = await page.context().newCDPSession(page);
  const at = (x, y) => [{ x, y, id: 1 }];
  const x = box.x + box.width / 2;
  const y0 = box.y + box.height - 60;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(x, y0) });
  for (let i = 1; i <= 12; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(x, y0 - i * 25) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(500);
  return (await el.evaluate((n) => n.scrollTop)) > before;
}

for (const [size, scheme] of [
  ["1440", "light"],
  ["1440", "dark"],
  ["390", "light"],
  ["390", "dark"],
]) {
  const tag = `${size} ${scheme}`;
  const phone = size === "390";
  const ctx = await browser.newContext({ ...(phone ? PHONE : DESKTOP), colorScheme: scheme });
  await ctx.addInitScript(() =>
    document.addEventListener("DOMContentLoaded", () => {
      const s = document.createElement("style");
      s.textContent = "nextjs-portal{display:none!important}";
      document.head.append(s);
    }),
  );
  await ctx.addInitScript(() => localStorage.setItem("fuobe.engine", "open"));
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));

  // 1. Settings
  await setWorker("");
  await page.goto(`${app}/settings#comfyui`, { waitUntil: "load", timeout: 120_000 });
  const field = page.getByRole("textbox", { name: "WorldCast worker URL (optional)" });
  await field.waitFor({ timeout: 60_000 });
  await field.scrollIntoViewIfNeeded();
  check(`${tag}: Settings shows the WorldCast worker URL beside the isolated worker`, (await page.getByRole("textbox", { name: "Isolated worker URL (optional)" }).count()) > 0);
  await page.getByRole("textbox", { name: "Isolated worker URL (optional)" }).focus();
  const reached = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    reached.push(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.id ?? ""));
  }
  await field.focus();
  await page.keyboard.type(workerUrl);
  const go = page.getByRole("button", { name: "Save and test WorldCast worker URL (optional)" });
  await go.waitFor();
  check(`${tag}: keyboard focus reaches the worker's field and its button`, (await field.evaluate((n) => n === document.activeElement)) && reached.length > 0);
  await go.focus();
  check(`${tag}: …and its button`, await go.evaluate((n) => n === document.activeElement));
  await page.keyboard.press("Enter");
  await page.getByText(/WorldCast worker · PixCtrol\/WorldCast@7ccf2e0/).first().waitFor({ timeout: 30_000 });
  check(`${tag}: Save & test connects to the worker`, true);
  check(`${tag}: no sideways scroll in Settings`, (await sideways(page)) <= 1, String(await sideways(page)));
  const fieldBox = await field.boundingBox();
  check(`${tag}: the field fits the page`, fieldBox && fieldBox.x >= 0 && fieldBox.x + fieldBox.width <= (phone ? 390 : 1440));
  await shoot(page, `settings-${size}-${scheme}`);

  // 2. Turnaround on a character's page, with the worker and without it.
  for (const on of [true, false]) {
    await setWorker(on ? workerUrl : "");
    await page.goto(`${app}/elements/${element.id}`, { waitUntil: "load", timeout: 120_000 });
    const fly = page.getByRole("button", { name: /^Fly around/ });
    await fly.waitFor({ timeout: 60_000 });
    await fly.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText(/^Fly around Ada Cast/).waitFor();
    await dialog.getByText(/Free · on your GPU|Placeholder · free/).first().waitFor({ timeout: 30_000 });
    if (on) {
      const chip = dialog.getByRole("radio", { name: "WorldCast" });
      await chip.waitFor({ timeout: 30_000 });
      check(`${tag}: with a worker, WorldCast is the route`, (await chip.getAttribute("aria-checked")) === "true");
      await dialog.getByText(/then WorldCast films the path on your WorldCast worker/).waitFor({ timeout: 30_000 });
      check(`${tag}: …and says what it does`, true);
      await chip.focus();
      check(`${tag}: keyboard focus reaches the WorldCast route`, await chip.evaluate((n) => n === document.activeElement));
    } else {
      await dialog.getByText("Runs on Frames: add a WorldCast worker (48 GB+) for sides that match your photos").waitFor({ timeout: 30_000 });
      check(`${tag}: without a worker, Frames says how to get WorldCast`, (await dialog.getByRole("radio", { name: "WorldCast" }).count()) === 0);
    }
    check(`${tag}: no sideways scroll with the dialog open (${on ? "worker" : "none"})`, (await sideways(page)) <= 1);
    if (phone && on) check(`${tag}: a finger drag scrolls the dialog`, await fingerScroll(page, dialog));
    await shoot(page, `turnaround-${on ? "worldcast" : "frames"}-${size}-${scheme}`);
    await page.keyboard.press("Escape");
  }
  check(`${tag}: no page or console errors`, errors.length === 0, errors.join(" | ").slice(0, 600));
  await ctx.close();
}

await setWorker("");
await browser.close();
worker.close();
console.log(failures ? `\n${failures} failed` : "\nAll passed");
process.exit(failures ? 1 : 0);
