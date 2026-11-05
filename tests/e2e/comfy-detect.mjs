// "Use the ComfyUI on this computer": which port the card shows when several answer, at 390 and 1440 wide. A
// production server on 3650 with a throwaway data folder, and stand-ins: a ComfyUI that lets this page in on 18188
// (tests/helpers/fake-local-comfy.ts), the same without it on 18190, and an app that answers 401 with no CORS headers on
// 18189. The browser's requests to ComfyUI's ports are sent to the stand-ins before they leave it (8188 to 18188 or
// 18190, 8189 to 18189), every other loopback port is refused, and its sockets to them are closed: a real ComfyUI on
// 8188 is never touched.
//
//   pnpm build && node tests/e2e/comfy-detect.mjs
//
// Checks: ComfyUI on 8188 and a 401 on 8189 show 8188 alone, with 8189 under "Other ports"; "Use port 8189" and
// "Use port 8188" each look at once and change the screen; ComfyUI letting this page in later connects by itself; a
// readable ComfyUI on 8188 connects without looking at any other port; only the 401 is a weak candidate; nothing is
// "No ComfyUI found", and Check again looks again; quiet looks reach only the port shown.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { launch, root } from "./_browser.mjs";
import { tempDir, removeDir, stopProcess } from "./_temp.mjs";

const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3650);
// The one step a ComfyUI that doesn't let this page in gets: Fuobe Connect once it is published, else Fuobe's setting.
const ONE_STEP = /Install Fuobe Connect|Add this to the command you start ComfyUI with|Download this start file|In ComfyUI Desktop, open Settings|In Stability Matrix, open/;
const COMFY_OPEN = 18188;
const OTHER_APP = 18189;
const COMFY_CLOSED = 18190;
const READABLE_APP = 18191;
const DEAD_PORT = 3659;
const SITE = `http://127.0.0.1:${APP_PORT}`;
const shots = process.env.E2E_SHOTS ?? fs.mkdtempSync(path.join(os.tmpdir(), "fuobe-comfy-detect-shots-"));
fs.mkdirSync(shots, { recursive: true });
const data = tempDir("fuobe-comfy-detect-e2e-");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30_000, every = 200) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() > end) return null;
    await sleep(every);
  }
}

// --- Stand-ins.
const procs = [];
async function startFake(port, cors) {
  const args = ["--port", String(port), "--cors", cors, "--has", path.join(root, "workflows/comfyui/requirements.json")];
  const p = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", path.join(root, "tests/helpers/fake-local-comfy.ts"), ...args], { stdio: ["ignore", "ignore", "inherit"] });
  procs.push(p);
  if (!(await until(() => fetch(`http://127.0.0.1:${port}/__fake/stats`).then((r) => r.ok), 15_000))) throw new Error(`the stand-in on ${port} didn't start`);
}
// Another app: 401 to everything, no CORS headers (the browser can't read it, as with the one on the owner's 8189).
const otherApp = http.createServer((req, res) => {
  res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="app"' });
  res.end('{"error":"unauthorized"}');
});
// Another app the page can read (it lets this site in), and isn't ComfyUI.
const readableApp = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": SITE, vary: "Origin" });
  res.end('{"status":"ok"}');
});

// --- The studio.
const server = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "-p", String(APP_PORT), "-H", "127.0.0.1"], {
  cwd: root,
  env: {
    ...process.env,
    FUOBE_DATA_DIR: data,
    FUOBE_PASSWORD: `e2e-${Math.random().toString(36).slice(2)}`,
    FUOBE_PUBLIC_SIGNUP: "1",
    COMFYUI_URL: `http://127.0.0.1:${DEAD_PORT}`,
    NODE_ENV: "production",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

async function finish(code) {
  for (const p of procs) p.kill();
  otherApp.close();
  readableApp.close();
  await stopProcess(server);
  removeDir(data);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${shots}`);
  if (failed.length) console.log(serverLog.split("\n").slice(-30).join("\n"));
  process.exit(code ?? (failed.length ? 1 : 0));
}

const WIDTHS = [
  { name: "1440", viewport: { width: 1440, height: 1000 } },
  { name: "390", viewport: { width: 390, height: 1400 } },
];

let browser;
let n = 0;
try {
  if (!(await until(() => fetch(`${SITE}/api/auth/me`).then((r) => r.ok), 120_000, 500))) throw new Error(`the studio didn't start:\n${serverLog}`);
  await startFake(COMFY_OPEN, SITE);
  await startFake(COMFY_CLOSED, "off");
  await new Promise((r) => otherApp.listen(OTHER_APP, "127.0.0.1", r));
  await new Promise((r) => readableApp.listen(READABLE_APP, "127.0.0.1", r));
  browser = await launch();

  /**
   * A signed-up account on Settings, with ComfyUI's ports mapped (`map`: the port the page asks for → a stand-in's;
   * a port not named has nothing there). Changing `map` later changes what answers. One account a width (sign-ups are
   * limited): each scenario after the first disconnects, forgets what the browser remembered, and opens Settings again.
   */
  const made = new Map();
  async function account(width, map) {
    const had = made.get(width.name);
    if (had) {
      const { ctx, page } = had;
      ctx.map = map;
      ctx.delay = {};
      ctx.loopback.length = 0;
      await page.evaluate(() => fetch("/api/account/gpu", { method: "DELETE" }).then((r) => r.status));
      await page.evaluate(() => localStorage.clear());
      await page.goto(`${SITE}/settings`, { waitUntil: "load" });
      const card = page.locator("#your-gpu");
      await card.getByRole("button", { name: "Find my ComfyUI" }).waitFor({ timeout: 30_000 });
      return { ...had, card };
    }
    const ctx = await browser.newContext({ viewport: width.viewport });
    ctx.map = map;
    ctx.delay = {};
    ctx.loopback = [];
    await ctx.route(/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+/, async (route) => {
      const u = new URL(route.request().url());
      const port = Number(u.port);
      if (port === APP_PORT) return route.continue();
      ctx.loopback.push({ port, path: u.pathname, cors: !!route.request().headers().origin, at: Date.now() });
      // A slow answer (`delay`: port → ms), to click again while a look is under way.
      if (ctx.delay[port]) await sleep(ctx.delay[port]);
      const to = ctx.map[port];
      if (!to) return route.abort("connectionrefused");
      u.port = String(to);
      return route.continue({ url: u.toString() });
    });
    // Sockets to ComfyUI's ports (the runner, once connected) never leave the browser.
    await ctx.routeWebSocket(/^wss?:\/\/(127\.0\.0\.1|localhost|\[::1\]):(?!3650)\d+/, (ws) => ws.close());
    const page = await ctx.newPage();
    if (process.env.E2E_CONSOLE) page.on("console", (m) => console.log(`[page] ${m.type()} ${m.text()}`));
    await page.goto(`${SITE}/settings`, { waitUntil: "load" });
    const email = `e2e-detect-${++n}-${Date.now()}@example.com`;
    const status = await page.evaluate(
      (email) => fetch("/api/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "long enough password" }) }).then((r) => r.status),
      email,
    );
    if (status !== 201 && status !== 200) throw new Error(`sign-up answered ${status}`);
    await page.goto(`${SITE}/settings`, { waitUntil: "load" });
    const card = page.locator("#your-gpu");
    await card.getByRole("button", { name: "Find my ComfyUI" }).waitFor({ timeout: 30_000 });
    made.set(width.name, { ctx, page });
    return { ctx, page, card };
  }
  const shot = (page, card, name) => card.screenshot({ path: path.join(shots, name) }).catch(() => page.screenshot({ path: path.join(shots, name) }));

  for (const w of WIDTHS) {
    // 1. The owner's computer: ComfyUI on 8188 that doesn't let this page in yet, and a 401 on 8189.
    {
      const { ctx, page, card } = await account(w, { 8188: COMFY_CLOSED, 8189: OTHER_APP });
      await card.getByRole("button", { name: "Find my ComfyUI" }).click();
      const primary = card.getByText("Something is running on port 8188, ComfyUI's usual port.");
      check(`${w.name}: ComfyUI on 8188 and a 401 on 8189 show 8188`, !!(await until(() => primary.isVisible(), 20_000)));
      check(`${w.name}: …saying plainly why this page can't use it, with the one step`, (await card.getByText(/ComfyUI only answers the websites it's told to trust/).isVisible()) && (await card.getByText(ONE_STEP).first().isVisible()));
      check(`${w.name}: …and 8189 is no second sentence, only under Other ports`, (await card.getByText(/Something answers on port 8189/).count()) === 0 && (await card.getByRole("button", { name: "Other ports (1)" }).isVisible()));
      await shot(page, card, `${w.name}-1-comfy-on-8188.png`);

      // Quiet looks: only the port shown, and at most one full look per 10 s there.
      const from = Date.now();
      await sleep(8_000);
      const quiet = ctx.loopback.filter((r) => r.at >= from);
      check(`${w.name}: quiet looks reach only 8188`, quiet.length > 0 && quiet.every((r) => r.port === 8188), JSON.stringify(quiet.map((r) => r.port)));
      check(`${w.name}: …and read it in full at most once in 8 s (pings in between)`, quiet.filter((r) => r.cors).length <= 1, `${quiet.filter((r) => r.cors).length} full of ${quiet.length}`);

      // "Use port 8189": it looks at once, and the screen changes to that port.
      await card.getByRole("button", { name: "Other ports (1)" }).click();
      await shot(page, card, `${w.name}-2-other-ports-open.png`);
      const t0 = Date.now();
      await card.getByRole("button", { name: "Use port 8189" }).click();
      const moved = await until(() => card.getByText("Something answers on port 8189.").isVisible(), 10_000, 50);
      check(`${w.name}: "Use port 8189" switches the card to 8189 at once`, !!moved, `${Date.now() - t0} ms`);
      check(`${w.name}: …which looked at 8189 when clicked`, ctx.loopback.some((r) => r.port === 8189 && r.at >= t0));
      check(`${w.name}: …saying Fuobe can't read that port yet (not that it is ComfyUI)`, await card.getByText(/Fuobe can't read this port yet. If it's ComfyUI, one step lets Fuobe in/).isVisible());
      check(`${w.name}: …and offers 8188 under Other ports`, await card.getByRole("button", { name: "Other ports (1)" }).isVisible());
      await shot(page, card, `${w.name}-3-chose-8189.png`);
      // Stays there: the quiet looks follow the port picked.
      await sleep(4_500);
      check(`${w.name}: …and stays on the port picked`, await card.getByText("Something answers on port 8189.").isVisible());

      // "Use port 8188": back, at once.
      await card.getByRole("button", { name: "Other ports (1)" }).click();
      const t1 = Date.now();
      await card.getByRole("button", { name: "Use port 8188" }).click();
      const back = await until(() => primary.isVisible(), 10_000, 50);
      check(`${w.name}: "Use port 8188" switches the card back to 8188 at once`, !!back, `${Date.now() - t1} ms`);
      await shot(page, card, `${w.name}-4-chose-8188.png`);

      // "Use port 8189", then "Check again" before that look ends: no "Checking port 8189…" left spinning.
      ctx.delay = { 8189: 1200 };
      await card.getByRole("button", { name: "Other ports (1)" }).click();
      await card.getByRole("button", { name: "Use port 8189" }).click();
      await card.getByText("Checking port 8189…").waitFor({ timeout: 5_000 });
      await card.getByRole("button", { name: "Check again" }).click();
      await until(() => primary.isVisible(), 15_000, 50);
      await sleep(4_000);
      ctx.delay = {};
      const spinning = await card.getByText(/Checking port/).count();
      await card.getByRole("button", { name: "Other ports (1)" }).click();
      check(`${w.name}: Use port, then Check again at once: no "Checking port…" left, and the port can be picked again`, spinning === 0 && (await card.getByRole("button", { name: "Use port 8189" }).isEnabled()), `${spinning} spinning`);
      await card.getByRole("button", { name: "Other ports (1)" }).click();

      // A port picked where nothing answers any more: the card says so.
      ctx.map = { 8188: COMFY_CLOSED };
      await card.getByRole("button", { name: "Other ports (1)" }).click();
      await card.getByRole("button", { name: "Use port 8189" }).click();
      check(`${w.name}: a port picked where nothing answers now: the card says so`, !!(await until(() => card.getByText("Nothing answers on port 8189 right now.", { exact: false }).isVisible(), 10_000)));
      check(`${w.name}: …and no longer offers it`, (await card.getByRole("button", { name: "Use port 8189" }).count()) === 0 && (await primary.isVisible()));
      await shot(page, card, `${w.name}-5-picked-port-gone.png`);

      // ComfyUI lets this page in (Fuobe Connect, no restart seen): connects by itself.
      ctx.map = { 8188: COMFY_OPEN };
      const connected = await until(() => card.getByText("Your GPU is connected").isVisible(), 20_000);
      check(`${w.name}: once ComfyUI lets this page in, it connects by itself`, !!connected);
      await shot(page, card, `${w.name}-6-connected.png`);
    }

    // 2. ComfyUI on 8188 that lets this page in: connects, and never looks at another port.
    {
      const { ctx, page, card } = await account(w, { 8188: COMFY_OPEN, 8189: OTHER_APP });
      await card.getByRole("button", { name: "Find my ComfyUI" }).click();
      const ok = await until(() => card.getByText("Your GPU is connected").isVisible(), 20_000);
      check(`${w.name}: a readable ComfyUI on 8188 connects`, !!ok);
      check(`${w.name}: …without looking at any other port`, ctx.loopback.every((r) => r.port === 8188), [...new Set(ctx.loopback.map((r) => r.port))].join(","));
      await shot(page, card, `${w.name}-7-found-8188.png`);
    }

    // 3. Only the 401 on 8189: a weak candidate.
    {
      const { page, card, ctx } = await account(w, { 8189: OTHER_APP });
      await card.getByRole("button", { name: "Find my ComfyUI" }).click();
      const weak = await until(() => card.getByText("No ComfyUI found on port 8188, its usual port.").isVisible(), 20_000);
      check(`${w.name}: only a 401 on 8189 is a weak candidate, not "found"`, !!weak && (await card.getByText(/Something answers on port 8189, but Fuobe can't tell if it's ComfyUI/).isVisible()));
      check(`${w.name}: …with one action, Check again`, (await card.getByRole("button", { name: "Check again" }).count()) === 1 && (await card.getByText(ONE_STEP).first().count()) === 0);
      await shot(page, card, `${w.name}-8-weak-8189.png`);
      const t = Date.now();
      await card.getByRole("button", { name: "Port 8189 is my ComfyUI" }).click();
      check(`${w.name}: "Port 8189 is my ComfyUI" shows the one step for it`, !!(await until(() => card.getByText("Something answers on port 8189.").isVisible(), 10_000)) && (await card.getByText(ONE_STEP).first().isVisible()));
      check(`${w.name}: …after looking at 8189 again`, ctx.loopback.some((r) => r.port === 8189 && r.at >= t));
      await shot(page, card, `${w.name}-9-weak-chosen.png`);
    }

    // 3b. Only the 401 on 8189, then ComfyUI starts on 8188: 8188 takes over with no click.
    {
      const { ctx, card } = await account(w, { 8189: OTHER_APP });
      await card.getByRole("button", { name: "Find my ComfyUI" }).click();
      await until(() => card.getByText("No ComfyUI found on port 8188, its usual port.").isVisible(), 20_000);
      ctx.map = { 8188: COMFY_CLOSED, 8189: OTHER_APP };
      const took = await until(() => card.getByText("Something is running on port 8188, ComfyUI's usual port.").isVisible(), 15_000);
      check(`${w.name}: a weak 8189 gives way by itself once 8188 answers`, !!took && (await card.getByRole("button", { name: "Other ports (1)" }).isVisible()));
    }

    // 3c. Something on 8000, ComfyUI Desktop's port: a candidate with the one step, not "something else".
    {
      const { page, card } = await account(w, { 8000: COMFY_CLOSED });
      await card.getByRole("button", { name: "Find my ComfyUI" }).click();
      const desk = await until(() => card.getByText("Something is running on port 8000, ComfyUI Desktop's usual port.").isVisible(), 20_000);
      check(`${w.name}: something on 8000 is ComfyUI Desktop's usual port, with the one step`, !!desk && (await card.getByText(ONE_STEP).first().isVisible()) && (await card.getByText(/No ComfyUI found/).count()) === 0);
      check(`${w.name}: …and the one-line setting is offered next to it`, await card.getByText("Or start ComfyUI with one setting instead.").isVisible());
      await shot(page, card, `${w.name}-9b-desktop-8000.png`);
    }

    // 3d. Another app the page can read on 8000 (not ComfyUI), and ComfyUI on a port typed by the person.
    {
      const { page, card } = await account(w, { 8000: READABLE_APP, 9188: COMFY_CLOSED });
      await card.getByRole("button", { name: "Find my ComfyUI" }).click();
      const none = await until(() => card.getByText("No ComfyUI found on this computer.").isVisible(), 20_000);
      check(`${w.name}: another app's readable answer is never offered as ComfyUI`, !!none && (await card.getByText(/port 8000/).count()) === 0 && (await card.getByRole("button", { name: /Other ports/ }).count()) === 0);
      const typeAndLook = async (port) => {
        const field = card.getByLabel("ComfyUI's port");
        await field.waitFor({ timeout: 15_000 });
        await field.fill(String(port));
        await card.getByRole("button", { name: "Look" }).click();
      };
      await typeAndLook(8000);
      check(`${w.name}: typing that app's port says it isn't ComfyUI`, !!(await until(() => card.getByText("Another app answers on port 8000, not ComfyUI.").isVisible(), 10_000)));
      await shot(page, card, `${w.name}-9c-typed-other-app.png`);
      await typeAndLook(9188);
      const typed = await until(() => card.getByText("Something answers on port 9188.").isVisible(), 10_000);
      check(`${w.name}: a typed port that answers is taken as the person's ComfyUI, with the one step`, !!typed && (await card.getByText(ONE_STEP).first().isVisible()) && (await card.getByText(/can't tell if it's ComfyUI/).count()) === 0);
      await shot(page, card, `${w.name}-9d-typed-port.png`);
    }

    // 3e. ComfyUI on 8188 closes (restarting): waiting, and the quiet looks reach only 8188, with pings.
    {
      const { ctx, page, card } = await account(w, { 8188: COMFY_CLOSED, 8189: OTHER_APP });
      await card.getByRole("button", { name: "Find my ComfyUI" }).click();
      await until(() => card.getByText("Something is running on port 8188, ComfyUI's usual port.").isVisible(), 20_000);
      ctx.map = { 8189: OTHER_APP };
      const waiting = await until(() => card.getByText("Waiting for ComfyUI to start…").isVisible(), 15_000);
      check(`${w.name}: ComfyUI closing on 8188 shows "Waiting for ComfyUI to start"`, !!waiting);
      const from = Date.now();
      await sleep(8_000);
      const quiet = ctx.loopback.filter((r) => r.at >= from);
      check(`${w.name}: …while waiting, quiet looks reach only 8188, and only with a ping`, quiet.length > 0 && quiet.every((r) => r.port === 8188 && !r.cors), JSON.stringify(quiet.map((r) => `${r.port}${r.cors ? "+read" : ""}`)));
      await shot(page, card, `${w.name}-9e-waiting.png`);
      ctx.map = { 8188: COMFY_OPEN, 8189: OTHER_APP };
      check(`${w.name}: …and ComfyUI back with Fuobe let in connects by itself`, !!(await until(() => card.getByText("Your GPU is connected").isVisible(), 20_000)));
    }

    // 4. Nothing answers: not found; Check again looks again.
    {
      const { ctx, page, card } = await account(w, {});
      await card.getByRole("button", { name: "Find my ComfyUI" }).click();
      const none = await until(() => card.getByText("No ComfyUI found on this computer.").isVisible(), 20_000);
      check(`${w.name}: nothing answers: "No ComfyUI found", start it, then check again`, !!none && (await card.getByText("Start ComfyUI, then check again.").isVisible()));
      await shot(page, card, `${w.name}-10-none.png`);
      const from = Date.now();
      await sleep(7_000);
      const quiet = ctx.loopback.filter((r) => r.at >= from);
      check(`${w.name}: …quiet looks then reach only 8188, one ping each`, quiet.length > 0 && quiet.every((r) => r.port === 8188 && !r.cors), JSON.stringify(quiet.map((r) => `${r.port}${r.cors ? "+read" : ""}`)));
      const t = Date.now();
      await card.getByRole("button", { name: "Check again" }).click();
      check(`${w.name}: Check again looks at every port again`, !!(await until(() => new Set(ctx.loopback.filter((r) => r.at >= t).map((r) => r.port)).size >= 7, 10_000)));
      // ComfyUI starts on 8188: found by the quiet look.
      ctx.map = { 8188: COMFY_OPEN };
      check(`${w.name}: ComfyUI started on 8188 is found by itself`, !!(await until(() => card.getByText("Your GPU is connected").isVisible(), 20_000)));
    }
  }
} catch (e) {
  console.error(e);
  check("the run finished", false, String(e?.message ?? e));
} finally {
  await browser?.close().catch(() => {});
  await finish();
}
