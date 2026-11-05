// The owner's "Use the ComfyUI on this computer" on a hosted studio, end to end in Chromium. A production server on
// 3375 with a throwaway data folder; stand-in ComfyUIs (tests/helpers/fake-local-comfy.ts): the owner's computer on
// 3376, the account's on 3378, and (E2E_MODE=local) the server's own on 3377. Nothing listens on 3399.
//
// Hosted (E2E_MODE=hosted, the default): the page is http://studio.test:3375, a name Chromium maps to this machine, so
// the studio reads as hosted (lib/page-place.ts) while the browser still reaches only loopback. The browser treats it
// as secure (as https would be), so it may ask to reach apps on this computer.
// Local (E2E_MODE=local): the page is http://127.0.0.1:3375, the server's ComfyUI at 127.0.0.1:3377, as before.
//
// Every loopback request but the studio's and the stand-ins' is refused before it leaves the browser, so a real
// ComfyUI on 8188 is never touched.
//
//   pnpm build && node tests/e2e/owner-computer.mjs && E2E_MODE=local node tests/e2e/owner-computer.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launch, root } from "./_browser.mjs";
import { tempDir, removeDir, stopProcess } from "./_temp.mjs";

const MODE = process.env.E2E_MODE === "local" ? "local" : "hosted";
const HOSTED = MODE === "hosted";
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3375);
const PC_PORT = Number(process.env.E2E_PC_PORT ?? 3376);
const SERVER_COMFY_PORT = Number(process.env.E2E_SERVER_COMFY_PORT ?? 3377);
const ACCOUNT_PORT = Number(process.env.E2E_ACCOUNT_PORT ?? 3378);
const DEAD_PORT = 3399;
const SITE = HOSTED ? `http://studio.test:${APP_PORT}` : `http://127.0.0.1:${APP_PORT}`;
const LOCAL = `http://127.0.0.1:${APP_PORT}`;
const shots = process.env.E2E_SHOTS ?? fs.mkdtempSync(path.join(os.tmpdir(), "fuobe-owner-computer-shots-"));
fs.mkdirSync(shots, { recursive: true });
const data = tempDir("fuobe-owner-computer-e2e-");
const PASSWORD = `e2e-${Math.random().toString(36).slice(2)}`;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * The install's status lives in the account menu (the avatar at the top bar's right end): opens it (again, after a page
 * load or a dialog closed it) and returns it.
 */
async function statusMenu(page) {
  const menu = page.getByRole("menu");
  if (!(await menu.isVisible().catch(() => false))) await page.getByRole("button", { name: /^Account and settings/ }).click({ timeout: 5_000 }).catch(() => {});
  return menu;
}

async function until(fn, ms = 30_000, every = 250) {
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

// --- Stand-in ComfyUIs, each its own process (a restart is a new process, as for the real one).
const fakes = new Map();
async function startFake(port, cors, o = {}) {
  const args = ["--port", String(port), "--cors", cors, "--steps", "6", "--step-ms", "200", "--has", path.join(root, "workflows/comfyui/requirements.json"), ...(o.guard ? ["--guard", "1"] : [])];
  const p = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", path.join(root, "tests/helpers/fake-local-comfy.ts"), ...args], { stdio: ["ignore", "ignore", "inherit"] });
  fakes.set(port, p);
  await until(() => fetch(`http://127.0.0.1:${port}/__fake/stats`).then((r) => r.ok), 15_000);
}
async function stopFake(port) {
  const p = fakes.get(port);
  if (!p) return;
  fakes.delete(port);
  p.kill();
  await until(() => fetch(`http://127.0.0.1:${port}/__fake/stats`).then(() => false, () => true), 10_000);
}
const posts = async (port) => (await fetch(`http://127.0.0.1:${port}/__fake/stats`).then((r) => r.json()).catch(() => ({ posts: -1 }))).posts;

// --- The studio.
const server = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "-p", String(APP_PORT), "-H", "127.0.0.1"], {
  cwd: root,
  env: {
    ...process.env,
    FUOBE_DATA_DIR: data,
    FUOBE_PASSWORD: PASSWORD,
    FUOBE_PUBLIC_SIGNUP: "1",
    FUOBE_ALLOWED_ORIGINS: SITE,
    // Hosted: the server's own ComfyUI address answers nothing. Local: the server's stand-in.
    COMFYUI_URL: HOSTED ? `http://127.0.0.1:${DEAD_PORT}` : `http://127.0.0.1:${SERVER_COMFY_PORT}`,
    NODE_ENV: "production",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

let browser;
async function finish(code) {
  await browser?.close().catch(() => {});
  for (const port of [...fakes.keys()]) await stopFake(port).catch(() => {});
  await stopProcess(server);
  removeDir(data);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[${MODE}] ${results.length - failed.length}/${results.length} passed. Screenshots: ${shots}`);
  if (failed.length) console.log(serverLog.split("\n").slice(-30).join("\n"));
  fs.writeFileSync(path.join(shots, `results-${MODE}.json`), JSON.stringify(results, null, 2));
  process.exit(code ?? (failed.length ? 1 : 0));
}

/** Every request this browser sends to a loopback port other than the studio's, and every connection test it sends. */
async function context(o = {}, allow = [APP_PORT, PC_PORT]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", ...o });
  // Every loopback request the page tried (the finder looks at ComfyUI's usual ports), and the ones let through.
  ctx.loopback = [];
  ctx.passed = [];
  ctx.tests = [];
  await ctx.route(/^(https?|wss?):\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+/, (route) => {
    const port = Number(new URL(route.request().url()).port);
    if (port !== APP_PORT) ctx.loopback.push(`${route.request().method()} ${route.request().url()}`);
    if (!allow.includes(port)) return route.abort("connectionrefused");
    if (port !== APP_PORT) ctx.passed.push(port);
    return route.continue();
  });
  ctx.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/api/providers/test") ctx.tests.push(r.postData() ?? "");
  });
  return ctx;
}

const api = (page, url, init = {}) =>
  page.evaluate(
    async ({ url, init }) => {
      const r = await fetch(url, init);
      return { status: r.status, headers: Object.fromEntries(r.headers), body: await r.json().catch(() => null) };
    },
    { url, init },
  );
const send = (page, url, body, method = "POST") => api(page, url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const runs = async (page) => (await api(page, "/api/generations?limit=20")).body?.items ?? [];

async function signIn(page, who) {
  await page.goto(`${SITE}/settings`, { waitUntil: "load" });
  const r = who === "owner" ? await send(page, "/api/auth/login", { password: PASSWORD }) : await send(page, "/api/auth/signup", { email: who, password: "long enough password" });
  if (r.status !== 200 && r.status !== 201) throw new Error(`sign-in answered ${r.status}`);
}

/** The screen at 1440 and 390, light and dark. */
async function shoot(page, name, o = {}) {
  for (const [w, h] of [
    [1440, 900],
    [390, 844],
  ]) {
    for (const scheme of ["light", "dark"]) {
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: scheme });
      await sleep(400);
      if (o.scroll) await page.locator(o.scroll).first().scrollIntoViewIfNeeded().catch(() => {});
      await page.screenshot({ path: path.join(shots, `${MODE}-${name}-${w}-${scheme}.png`) });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await sleep(200);
}

async function studio(page, url) {
  await page.goto(SITE + url, { waitUntil: "load", timeout: 120_000 });
  await page.waitForSelector("[data-composer-toolbar]", { timeout: 60_000 });
  await page.waitForFunction(() => Object.keys(document.querySelector("[data-composer-toolbar]") ?? {}).some((k) => k.startsWith("__react")), null, { timeout: 60_000 });
}

async function generate(page, prompt) {
  const known = new Set((await runs(page)).map((g) => g.id));
  await page.locator("[data-composer] textarea").fill(prompt);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  return () => runs(page).then((list) => list.find((g) => !known.has(g.id)));
}

const ended = (g) => g && (g.status === "succeeded" || g.status === "failed" || g.status === "canceled");

/** The relay task of a run, read from the studio's database (no API shows task ids). */
function taskOf(generationId) {
  const db = new DatabaseSync(path.join(data, "fuobe.db"), { readOnly: true });
  try {
    return db.prepare("SELECT id, principal, state FROM relay_tasks WHERE generation_id = ?").get(generationId);
  } finally {
    db.close();
  }
}

try {
  if (!(await until(() => fetch(`${LOCAL}/api/auth/me`).then((r) => r.ok), 90_000, 500))) throw new Error(`the studio didn't start:\n${serverLog}`);
  // Hosted: Chromium itself (its new headless mode), which honours the flag that makes the page secure; the older
  // headless shell ignores it.
  browser = await launch({
    ...(HOSTED && { channel: process.env.E2E_CHANNEL ?? "chromium" }),
    args: HOSTED ? [`--host-resolver-rules=MAP studio.test 127.0.0.1`, `--unsafely-treat-insecure-origin-as-secure=${SITE}`, "--disable-gpu"] : ["--disable-gpu"],
  });

  if (HOSTED) await hosted();
  else await local();
} catch (e) {
  check("the scenarios ran to the end", false, (e && e.stack) || String(e));
}
await finish();

// ---------------------------------------------------------------------------------------------------------------------
async function hosted() {
  await startFake(PC_PORT, SITE, { guard: true });
  const ctx = await context();
  const page = await ctx.newPage();
  await signIn(page, "owner");
  await page.evaluate((port) => localStorage.setItem("fuobe.comfy.port", String(port)), PC_PORT);
  // As on fuobe.com: open-source models only, no demo.
  check("settings as on the live studio", (await send(page, "/api/settings", { engineMode: "open", demoMode: "off" }, "PUT")).status === 200);

  // H1. Home's guide: the GPU card offers this computer, and nothing shows the server's 127.0.0.1:8188.
  await page.goto(`${SITE}/`, { waitUntil: "load" });
  const card = page.getByRole("region", { name: "Use your GPU" });
  await card.getByRole("button", { name: "Use the ComfyUI on this computer" }).waitFor({ timeout: 30_000 });
  check("Home's GPU card: Use the ComfyUI on this computer", true);
  check("Home's GPU card: the server is the quieter second way", await card.getByRole("button", { name: /ComfyUI on a server or a cloud GPU\?/ }).isVisible());
  const shown = await page.evaluate(() => document.body.innerText + [...document.querySelectorAll("input")].map((i) => i.value).join(" "));
  check("no 127.0.0.1:8188 anywhere on Home", !shown.includes("127.0.0.1:8188"));
  await shoot(page, "home-guide");

  // The bug: the server address typed into the guide is never sent.
  await card.getByRole("button", { name: /ComfyUI on a server or a cloud GPU\?/ }).click();
  const field = card.getByRole("textbox", { name: "Server address" });
  // Only the built-in address: the field is empty and Connect waits. (Here COMFYUI_URL names the server's own 127.0.0.1,
  // so it shows, and what it means on this website is said at once.)
  const preset = await field.inputValue();
  check(
    "the guide's server field: empty, or the server's own address with what it means here",
    preset === "" ? await card.getByRole("button", { name: /Connect Server address/ }).isDisabled() : await card.getByText("On this website, 127.0.0.1 is Fuobe's server, not your computer.").isVisible(),
    preset,
  );
  await field.fill("127.0.0.1:8188");
  await card.getByRole("button", { name: /Save and test Server address/ }).click();
  const line = await until(() => card.getByText("On this website, 127.0.0.1 is Fuobe's server, not your computer.").isVisible(), 10_000);
  check("127.0.0.1:8188 in the guide: one line, and the server makes no call", !!line && ctx.tests.length === 0, `tests sent: ${ctx.tests.length}`);
  check("the line offers this computer right there", await card.getByRole("button", { name: "Use the ComfyUI on this computer" }).nth(1).isVisible());
  await shoot(page, "home-guide-refused", { scroll: '[aria-label="Use your GPU"]' });

  // The guide's button opens the dialog already looking (the button said "this computer"): connected, with the owner's
  // words, and no second "Find my ComfyUI" to press.
  await card.getByRole("button", { name: "Use the ComfyUI on this computer" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: "Connect your GPU", exact: true }).waitFor({ timeout: 15_000 });
  check("the dialog says Connect your GPU (no run waiting)", true);
  check("the dialog: this computer first", await dialog.getByText("Use the ComfyUI on this computer", { exact: true }).first().isVisible());
  check("the dialog: a ComfyUI on a server second", await dialog.getByText("Use a ComfyUI on a server", { exact: true }).isVisible());
  check("the dialog doesn't start in an address field", !(await page.evaluate(() => document.activeElement?.tagName === "INPUT")));
  await shoot(page, "dialog-choose");
  check("found and connected with one tap (the guide's)", !!(await until(() => dialog.getByText("Your GPU is connected").isVisible(), 30_000)));
  check("the owner's done line", await until(() => dialog.getByText("Done. Your open-source runs now go to this computer. Keep a Fuobe tab open here while they run.").isVisible(), 10_000));
  await until(() => dialog.getByText(/Ready now:/).isVisible(), 20_000);
  await shoot(page, "dialog-connected");
  const settings = (await api(page, "/api/settings")).body;
  check("Settings now say ComfyUI runs on the owner's computer", settings?.settings?.find((s) => s.name === "comfyWhere")?.value === "computer");
  await page.keyboard.press("Escape");

  // The account menu and Settings' strip say where the GPU is.
  // The line is in the account menu now (the sidebar footer showed it all the time): open it, then read it.
  const chip = await until(async () => {
    const menu = await statusMenu(page);
    return (await menu.getByText(/^Your computer · NVIDIA GeForce RTX 5090/).first().isVisible()) && (await menu.getByText("online", { exact: true }).first().isVisible());
  }, 45_000, 500);
  check("the account menu: Your GPU · online · Your computer · RTX 5090", !!chip);
  await shoot(page, "menu-online");
  await page.keyboard.press("Escape");
  await page.goto(`${SITE}/settings`, { waitUntil: "load" });
  const strip = page.getByRole("navigation", { name: "Connections" });
  check("Settings' strip: Your GPU · Your computer · Online", !!(await until(() => strip.getByText("Your computer · Online").isVisible(), 30_000)));
  const section = page.locator("#comfyui");
  await section.getByText(/This computer/).first().waitFor({ timeout: 15_000 });
  check("Settings' ComfyUI section: this computer, ready, with Disconnect", await section.getByRole("button", { name: "Disconnect" }).isVisible());
  await shoot(page, "settings-computer", { scroll: "#comfyui" });

  // A run from /image goes to the owner's computer, and its result is in the Library.
  const before = await posts(PC_PORT);
  await studio(page, "/image?model=oss-z-image-turbo");
  const pending = await generate(page, "a lighthouse at dusk");
  const done = await until(async () => {
    const g = await pending();
    return ended(g) && g;
  }, 90_000, 500);
  check("an open-source run ran on the owner's computer", done?.status === "succeeded" && (await posts(PC_PORT)) > before, done?.error ?? done?.status ?? "no run");
  check("its task was the owner's", taskOf(done?.id)?.principal === "owner");
  await page.goto(`${SITE}/library`, { waitUntil: "load" });
  const inLibrary = await until(() => page.locator(`img[src*="/api/files/"]`).first().isVisible(), 30_000);
  check("the result is in the Library", !!inLibrary);

  // /connect: the board, not "Your link didn't answer".
  await page.goto(`${SITE}/connect`, { waitUntil: "load" });
  check("/connect: the board, and Change where it runs", !!(await until(() => page.getByRole("link", { name: "Change where it runs" }).isVisible(), 30_000)));
  check("/connect: never the link's words", !(await page.getByText(/Your link didn't answer/).isVisible()));
  await shoot(page, "connect-computer");

  // ComfyUI closes: the account menu says so; it comes back and goes on.
  await page.goto(`${SITE}/image?model=oss-z-image-turbo`, { waitUntil: "load" });
  await stopFake(PC_PORT);
  const down = await until(async () => (await statusMenu(page)).getByText("ComfyUI not running").isVisible(), 70_000, 1000);
  check("ComfyUI closed: the account menu says ComfyUI not running", !!down);
  await shoot(page, "menu-comfy-down");
  await startFake(PC_PORT, SITE, { guard: true });
  check("ComfyUI back: online again", !!(await until(async () => (await statusMenu(page)).getByText("online").isVisible(), 70_000, 1000)));

  // ComfyUI started the usual way (without Fuobe's setting): the account menu's row opens the fix; /connect says it once.
  await stopFake(PC_PORT);
  await startFake(PC_PORT, "off");
  const needs = page.getByRole("menu").getByRole("menuitem", { name: /needs a setting/ });
  check("no setting: the account menu says needs a setting, as an item", !!(await until(async () => (await statusMenu(page), needs.isVisible()), 70_000, 1000)));
  await needs.click();
  check("the account menu's item opens the setting's fix", !!(await until(() => page.getByRole("dialog").getByRole("heading", { name: "Your ComfyUI needs Fuobe's setting again" }).isVisible(), 15_000)));
  check("the fix: the start file", !!(await until(() => page.getByRole("dialog").getByRole("button", { name: /Download start file/ }).first().isVisible(), 15_000)));
  await shoot(page, "dialog-no-setting");
  await page.keyboard.press("Escape");
  await page.goto(`${SITE}/connect`, { waitUntil: "load" });
  await page.getByRole("button", { name: /Check again|Check my GPU/ }).first().click({ timeout: 30_000 });
  await until(() => page.getByText("ComfyUI is running, but it isn't letting this page in.").first().isVisible(), 30_000);
  const connectText = await page.locator("body").innerText();
  // What the page shows, without the checklist's screen-reader announcer, which repeats the last line on purpose.
  const shownText = await page.locator("main").evaluate((m) => {
    const c = m.cloneNode(true);
    c.querySelectorAll(".sr-only").forEach((e) => e.remove());
    return c.textContent ?? "";
  });
  const said = (shownText.match(/isn't letting this page in\./g) ?? []).length;
  check("/connect, no setting: one line, never the closed line", said === 1 && !shownText.includes("isn't answering on this computer"), `said ${said} time(s)${shownText.includes("isn't answering on this computer") ? ", with the closed line" : ""}`);
  check("/connect, no setting: no browser error words", !/Failed to fetch|NetworkError/.test(connectText));
  check("/connect, no setting: Show me how", await page.getByRole("button", { name: "Show me how" }).isVisible());
  await shoot(page, "connect-no-setting");
  await stopFake(PC_PORT);
  await startFake(PC_PORT, SITE, { guard: true });
  check("ComfyUI back with the setting: online again", !!(await until(async () => (await statusMenu(page)).getByText("online").isVisible(), 70_000, 1000)));
  await page.keyboard.press("Escape");

  // H2. A phone of the owner's: what the computer said, why not here, and the server way.
  {
    const phone = await context({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const p = await phone.newPage();
    await signIn(p, "owner");
    await p.goto(`${SITE}/settings`, { waitUntil: "load" });
    const s = p.locator("#comfyui");
    check("a phone: the phone line", !!(await until(() => s.getByText(/A phone or tablet can't reach the ComfyUI on your computer from a website\. Use a ComfyUI on a server below/).isVisible(), 30_000)));
    check("a phone: the computer's state from the server", await s.getByText(/Your computer/).first().isVisible());
    check("a phone: the server address right there", await s.getByRole("textbox", { name: "Server address" }).isVisible());
    await s.scrollIntoViewIfNeeded();
    await p.screenshot({ path: path.join(shots, `${MODE}-phone-settings-390-light.png`), fullPage: false });
    await p.emulateMedia({ colorScheme: "dark" });
    await sleep(300);
    await p.screenshot({ path: path.join(shots, `${MODE}-phone-settings-390-dark.png`), fullPage: false });
    await phone.close();
  }

  // H3. Settings → the server way: every local address is refused here, with no request.
  await page.goto(`${SITE}/settings`, { waitUntil: "load" });
  const sec = page.locator("#comfyui");
  await sec.getByRole("button", { name: "Use a server address instead" }).click();
  const addr = sec.getByRole("textbox", { name: "Server address" });
  ctx.tests.length = 0;
  for (const [typed, words] of [
    [`127.0.0.1:${DEAD_PORT}`, "On this website, 127.0.0.1 is Fuobe's server, not your computer."],
    [`http://10.255.255.1:${DEAD_PORT}`, "10.255.255.1 is on your own network, which Fuobe's server can't reach."],
    [`http://169.254.0.1:${DEAD_PORT}`, "169.254.0.1 is on your own network, which Fuobe's server can't reach."],
    [`http://nas.local:${DEAD_PORT}`, "nas.local is on your own network, which Fuobe's server can't reach."],
  ]) {
    await addr.fill(typed);
    await sec.getByRole("button", { name: /Save and test Server address/ }).click();
    check(`Settings: ${typed} refused with one line`, !!(await until(() => sec.getByText(words).isVisible(), 10_000)));
  }
  check("Settings: no connection test was sent for any of them", ctx.tests.length === 0, ctx.tests.join(" | "));
  check("already on this computer, the refusal offers to keep it", await sec.getByRole("button", { name: "Keep using this computer" }).isVisible());
  await shoot(page, "settings-refused", { scroll: "#comfyui" });
  await addr.fill("");

  // Disconnect: back to the server's address, nothing connected.
  await sec.getByRole("button", { name: "Disconnect" }).click();
  check("Disconnect: the choice again, this computer first", !!(await until(() => sec.getByText("Use the ComfyUI on this computer", { exact: true }).first().isVisible(), 15_000)));
  check("the account menu: Your GPU · Connect", !!(await until(async () => (await statusMenu(page)).getByRole("menuitem", { name: /Your GPU\s*Connect/ }).isVisible(), 40_000, 500)));
  await page.keyboard.press("Escape");
  await shoot(page, "settings-choose", { scroll: "#comfyui" });
  await page.getByRole("navigation", { name: "Connections" }).getByText("Connect").waitFor({ timeout: 30_000 });
  check("Settings' strip: Your GPU · Connect", true);
  const where = async () => (await api(page, "/api/settings")).body?.settings?.find((s) => s.name === "comfyWhere")?.value;

  // Disconnect sticks: Settings opened again (this browser may reach ComfyUI already) waits for Find my ComfyUI.
  await page.goto(`${SITE}/`, { waitUntil: "load" });
  await page.goto(`${SITE}/settings`, { waitUntil: "load" });
  await page.locator("#comfyui").getByRole("button", { name: "Find my ComfyUI" }).waitFor({ timeout: 30_000 });
  await sleep(8000);
  check("Disconnect sticks: Settings opened again doesn't connect by itself", (await where()) !== "computer" && (await page.locator("#comfyui").getByRole("button", { name: "Find my ComfyUI" }).isVisible()), String(await where()));

  // The refusal's button starts this computer's finder in the card above.
  await sec.getByRole("button", { name: /Use a ComfyUI on a server/ }).click();
  await sec.getByRole("textbox", { name: "Server address" }).fill(`localhost:${DEAD_PORT}`);
  await sec.getByRole("button", { name: /Save and test Server address/ }).click();
  await sec.getByText("On this website, localhost is Fuobe's server, not your computer.").waitFor({ timeout: 10_000 });
  await sec.getByRole("button", { name: "Use the ComfyUI on this computer" }).click();
  check("the refusal's button finds this computer's ComfyUI", !!(await until(() => sec.getByText("Your GPU is connected").isVisible(), 30_000)));
  await sec.getByRole("button", { name: "Disconnect" }).waitFor({ timeout: 1000 }).catch(() => {});
  // Back to the server's address for H4.
  check("back to server mode", (await send(page, "/api/settings", { comfyWhere: "server" }, "PUT")).status === 200);

  // /connect with nothing connected: where ComfyUI runs comes first; no check of the server's own address. (A browser
  // already allowed to reach ComfyUI may connect it by itself here: that's the quickest way.)
  await page.goto(`${SITE}/connect`, { waitUntil: "load" });
  check("/connect: Where is ComfyUI running?", !!(await until(() => page.getByRole("heading", { name: "Where is ComfyUI running?" }).isVisible(), 30_000)));
  check("/connect: no failing check of the server's address", !(await page.getByText(/didn't answer/).isVisible()));
  await sleep(8000);
  check("/connect doesn't connect this computer by itself", (await where()) !== "computer", String(await where()));
  await shoot(page, "connect-choose");
  await send(page, "/api/settings", { comfyWhere: "server" }, "PUT");

  // A ComfyUI at a server address that answers (here the server's own stand-in): opening Settings keeps the runs there.
  await startFake(SERVER_COMFY_PORT, "off");
  check("a server address that answers", (await send(page, "/api/settings", { comfyUrl: `http://127.0.0.1:${SERVER_COMFY_PORT}`, comfyWhere: "server" }, "PUT")).status === 200);
  await until(async () => (await api(page, "/api/status")).body?.providers?.comfyui?.configured, 30_000, 1000);
  await page.goto(`${SITE}/settings`, { waitUntil: "load" });
  await page.locator("#comfyui").getByText("Use the ComfyUI on this computer instead").first().waitFor({ timeout: 30_000 });
  await sleep(8000);
  check("server mode: opening Settings keeps the runs on the server address", (await where()) === "server", String(await where()));
  await send(page, "/api/settings", { comfyUrl: "" }, "PUT");
  await stopFake(SERVER_COMFY_PORT);

  // A run that went through (a demo), then "Your GPU · Connect": the card never starts that run again.
  check("placeholders on for a moment", (await send(page, "/api/settings", { demoMode: "on" }, "PUT")).status === 200);
  await until(async () => !(await api(page, "/api/status")).body?.providers?.comfyui?.configured, 30_000, 1000);
  await studio(page, "/image?model=oss-z-image-turbo");
  const demoRun = await generate(page, "a demo first");
  const demoDone = await until(async () => {
    const g = await demoRun();
    return ended(g) && g;
  }, 60_000, 500);
  check("the demo run went through", demoDone?.status === "succeeded", demoDone?.error ?? demoDone?.status ?? "no run");
  const count = (await runs(page)).length;
  await (await statusMenu(page)).getByRole("menuitem", { name: /Your GPU\s*Connect/ }).click();
  const d3 = page.getByRole("dialog");
  check("the account menu's Connect: Connect your GPU, with no run waiting", !!(await until(() => d3.getByRole("heading", { name: "Connect your GPU", exact: true }).isVisible(), 15_000)));
  check("the account menu's Connect looks at once", !!(await until(() => d3.getByText(/Your GPU is connected/).isVisible(), 30_000)));
  await sleep(6000);
  check("no run started again", (await runs(page)).length === count, `${(await runs(page)).length} vs ${count}`);
  await page.keyboard.press("Escape");
  await send(page, "/api/settings", { comfyWhere: "server", demoMode: "off" }, "PUT");

  // H4. A run with nothing connected opens the dialog (no toast); once connected, it starts and runs on the computer.
  await studio(page, "/image?model=oss-z-image-turbo");
  const before4 = await posts(PC_PORT);
  const pending4 = await generate(page, "a red bicycle");
  const d4 = page.getByRole("dialog");
  check("a refused run opens Connect your GPU to run this", !!(await until(() => d4.getByRole("heading", { name: "Connect your GPU to run this" }).isVisible(), 20_000)));
  check("no error toast on top", (await page.locator("[data-sonner-toast]").filter({ hasText: "Connect ComfyUI in Settings" }).count()) === 0);
  await shoot(page, "dialog-from-run");
  const find = d4.getByRole("button", { name: "Find my ComfyUI" });
  if (await find.isVisible().catch(() => false)) await find.click();
  check("connected from the run", !!(await until(() => d4.getByText(/Your GPU is connected/).isVisible(), 30_000)));
  check("the run starts in a moment", !!(await until(() => d4.getByText(/Your run starts in a moment|Starting your/).isVisible(), 15_000)));
  const ran = await until(async () => {
    const g = await pending4();
    return ended(g) && g;
  }, 90_000, 500);
  check("the run went to the owner's computer", ran?.status === "succeeded" && (await posts(PC_PORT)) > before4, ran?.error ?? ran?.status ?? "no run");

  // A1. An account on the same studio: its own computer, never the owner's.
  {
    await startFake(ACCOUNT_PORT, SITE, { guard: true });
    const actx = await context({}, [APP_PORT, ACCOUNT_PORT]);
    const ap = await actx.newPage();
    const email = `qa-owner-pc-${Math.random().toString(36).slice(2, 8)}@example.com`;
    await signIn(ap, email);
    await ap.evaluate((port) => localStorage.setItem("fuobe.comfy.port", String(port)), ACCOUNT_PORT);
    const st = (await api(ap, "/api/status")).body;
    check("an account's status has no ownerGpu", !!st && st.ownerGpu === undefined && st.viewer?.kind === "account");
    check("an account can't move the owner's ComfyUI", [401, 403].includes((await send(ap, "/api/settings", { comfyWhere: "server" }, "PUT")).status));
    await studio(ap, "/image?model=oss-z-image-turbo");
    const ownerBefore = await posts(PC_PORT);
    const acctBefore = await posts(ACCOUNT_PORT);
    const pendingA = await generate(ap, "a quiet harbour");
    const da = ap.getByRole("dialog");
    check("the account's dialog: this computer first", !!(await until(() => da.getByText("Use the ComfyUI on this computer", { exact: true }).first().isVisible(), 20_000)));
    check("the account's dialog: a link second", await da.getByText("Run from anywhere with a link").isVisible());
    await da.getByRole("button", { name: "Find my ComfyUI" }).click();
    await da.getByText(/Your GPU is connected/).waitFor({ timeout: 30_000 });
    // The owner runs one too, at the same time.
    const ownerPending = await generate(page, "an owner's run in parallel");
    const ga = await until(async () => {
      const g = await pendingA();
      return ended(g) && g;
    }, 90_000, 500);
    const go = await until(async () => {
      const g = await ownerPending();
      return ended(g) && g;
    }, 90_000, 500);
    check("the account's run ran on the account's computer only", ga?.status === "succeeded" && (await posts(ACCOUNT_PORT)) > acctBefore, ga?.error ?? ga?.status ?? "no run");
    check("the owner's run ran on the owner's computer only", go?.status === "succeeded" && (await posts(PC_PORT)) === ownerBefore + 1, `${go?.status} owner posts +${(await posts(PC_PORT)) - ownerBefore}`);
    check("the account's task was its own", taskOf(ga?.id)?.principal?.startsWith("acct:"));
    const ownerTask = taskOf(go?.id);
    for (const [method, url] of [
      ["GET", `/api/gpu/computer/tasks/${ownerTask?.id}/inputs/0`],
      ["POST", `/api/gpu/computer/tasks/${ownerTask?.id}/report`],
      ["GET", `/api/gpu/computer/tasks/${ownerTask?.id}/outputs/0`],
      ["PUT", `/api/gpu/computer/tasks/${ownerTask?.id}/outputs/0?offset=0&total=1`],
      ["POST", `/api/gpu/computer/tasks/${ownerTask?.id}/release`],
    ]) {
      const r = await ap.evaluate(
        async ({ method, url }) => (await fetch(url, { method, headers: { "content-type": "application/json", "x-fuobe-lease": "0".repeat(64) }, body: method === "GET" ? undefined : method === "PUT" ? "x" : JSON.stringify({ lease: "0".repeat(64), event: "gone" }) })).status,
        { method, url },
      );
      check(`an account gets 404 for the owner's task: ${method} ${url.split("/").slice(-2).join("/")}`, r === 404, String(r));
    }
    check("the account's browser reached only its own ComfyUI", !actx.loopback.some((u) => u.includes(`:${PC_PORT}`)), actx.loopback.filter((u) => u.includes(`:${PC_PORT}`)).join(", "));
    await shoot(ap, "account-done");
    // The throwaway account goes.
    check("the throwaway account is deleted", (await send(ap, "/api/auth/me", { password: "long enough password" }, "DELETE")).status === 204);
    await actx.close();
    await stopFake(ACCOUNT_PORT);
  }

  // G1. A guest sees nothing new, and reaches nothing on this computer.
  {
    const gctx = await context({}, [APP_PORT]);
    const gp = await gctx.newPage();
    await gp.goto(`${SITE}/`, { waitUntil: "load" });
    await sleep(2000);
    const st = (await api(gp, "/api/status")).body;
    check("a guest's status has no ownerGpu", !!st && st.ownerGpu === undefined && st.viewer?.kind === "guest");
    check("a guest can't beat as a computer", (await send(gp, "/api/gpu/computer/beat", { device: "device-guest-1" })).status === 401);
    for (const [url, words] of [
      ["/", "Your GPU"],
      ["/connect", "Create a free account, then connect the ComfyUI on your computer."],
      ["/settings", "Sign up free"],
    ]) {
      await gp.goto(SITE + url, { waitUntil: "load" });
      check(`a guest on ${url} sees the same words`, !!(await until(() => gp.getByText(words).first().isVisible(), 20_000)));
    }
    check("a guest's browser reached nothing on this computer", gctx.loopback.length === 0, gctx.loopback.join(", "));
    await gctx.close();
  }

  const tried = [...new Set(ctx.loopback.map((u) => new URL(u.split(" ")[1]).port))].sort();
  check("the owner's browser reached only its stand-in ComfyUI on this computer (every other port refused in the browser)", ctx.passed.every((p) => p === PC_PORT), `tried ports ${tried.join(", ")}; let through: ${[...new Set(ctx.passed)].join(", ")}`);
  check("nothing ever reached 8188", !ctx.passed.includes(8188));
  await ctx.close();
}

// ---------------------------------------------------------------------------------------------------------------------
async function local() {
  const ctx = await context({}, [APP_PORT]);
  const page = await ctx.newPage();
  await signIn(page, "owner");
  check("settings as on the live studio", (await send(page, "/api/settings", { engineMode: "open", demoMode: "off" }, "PUT")).status === 200);

  // L1. Home's guide: today's ComfyUI address field with the server's address, no computer button.
  await page.goto(`${SITE}/`, { waitUntil: "load" });
  const card = page.getByRole("region", { name: "Use your GPU" });
  const field = card.getByRole("textbox", { name: "ComfyUI address" });
  await field.waitFor({ timeout: 30_000 });
  check("local guide: the address field holds the server's address", (await field.inputValue()) === `http://127.0.0.1:${SERVER_COMFY_PORT}`);
  check("local guide: no computer button", (await card.getByRole("button", { name: "Use the ComfyUI on this computer" }).count()) === 0);
  await shoot(page, "home-guide");
  await startFake(SERVER_COMFY_PORT, "off");
  await card.getByRole("button", { name: /Connect ComfyUI address/ }).click();
  check("local guide: Connect connects the server's ComfyUI", !!(await until(() => page.getByText("ComfyUI connected").first().isVisible(), 20_000)));

  await page.goto(`${SITE}/settings`, { waitUntil: "load" });
  const radio = page.getByRole("radiogroup", { name: "Where ComfyUI runs" });
  check("local Settings: Where ComfyUI runs, On this server first", !!(await until(() => radio.getByRole("radio").first().getByText("On this server").isVisible(), 20_000)));
  check("local Settings: the server URL field as before", await page.getByRole("textbox", { name: "ComfyUI server URL" }).isVisible());
  await shoot(page, "settings", { scroll: "#comfyui" });

  const before = await posts(SERVER_COMFY_PORT);
  await studio(page, "/image?model=oss-z-image-turbo");
  const pending = await generate(page, "a lighthouse at dusk");
  const g = await until(async () => {
    const x = await pending();
    return ended(x) && x;
  }, 90_000, 500);
  check("local: a run goes to the server's ComfyUI", g?.status === "succeeded" && (await posts(SERVER_COMFY_PORT)) > before, g?.error ?? g?.status ?? "no run");

  await stopFake(SERVER_COMFY_PORT);
  // The status sees it gone (cached for 10 s).
  await sleep(12_000);
  await studio(page, "/image?model=oss-z-image-turbo");
  await generate(page, "another one");
  const gate = await until(() => page.getByRole("dialog").filter({ hasText: "Connect your GPU to run this" }).isVisible(), 20_000);
  check("local: ComfyUI gone, Generate opens the connect card, no error toast", !!gate && !(await page.locator("[data-sonner-toast]").filter({ hasText: "Connect ComfyUI in Settings" }).first().isVisible().catch(() => false)));
  check("the browser reached nothing on this computer but the studio", ctx.loopback.length === 0, ctx.loopback.join(", "));
  await ctx.close();
}
