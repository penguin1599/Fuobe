// Shorts Studio for visitors (a studio with a password and public sign-up, fuobe.com by default), through its routes and
// in a browser. A guest: the sign-up card on every change, an empty History, the price check open, no "isn't available
// here" note, and the sign-up card when it chooses a video or a preset of its own. A signed-in account (a throwaway one
// this script makes and deletes): its own empty History and presets, nobody else's short (404), Enhance not offered, the
// page's upload, Create a preset and Generate on, and the connect card when it has neither a GPU nor a key.
// No run is started (that needs the account's own GPU or key).
// Usage: node tests/e2e/shorts-accounts-live.mjs [appUrl] [--shots <dir>]   Exits 1 on a failed check.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { launch } from "./_browser.mjs";

const argv = process.argv.slice(2);
const flag = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const app = (argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--shots") ?? "https://fuobe.com").replace(/\/$/, "");
const shots = flag("--shots");
if (shots) fs.mkdirSync(shots, { recursive: true });

const failures = [];
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(72)}${extra ? ` ${extra}` : ""}`);
  if (!ok) failures.push(label);
};

const estimate = { engine: "open", presetId: "shorts-claymation", source: { url: "/api/files/placeholder.mp4", duration: 10, width: 720, height: 1280 }, range: { start: 0, end: 10 }, aspectRatio: "9:16", language: "auto" };

/** The route checks, as a guest (`req`: a context's request, signed out) or as the account (signed in). */
async function routes(req, who) {
  const send = (method, p, data) => req.fetch(`${app}${p}`, { method, headers: { origin: app, "content-type": "application/json" }, ...(data !== undefined && { data }) });
  const body = async (r) => r.json().catch(() => ({}));
  const sessions = await send("GET", "/api/shorts/sessions");
  check(`${who}: History is empty`, sessions.status() === 200 && JSON.stringify(await body(sessions)) === '{"items":[]}', String(sessions.status()));
  const presets = await send("GET", "/api/shorts/presets");
  check(`${who}: its presets are empty`, presets.status() === 200 && JSON.stringify(await body(presets)) === '{"items":[]}', String(presets.status()));
  const price = await send("POST", "/api/shorts/estimate", estimate);
  const e = await body(price);
  check(`${who}: the price check works, never as a demo`, price.status() === 200 && e.demo === false && e.segments === 2, `${price.status()} ${JSON.stringify(e).slice(0, 80)}`);
  const enhance = await send("POST", "/api/shorts/sessions/nope/segments/0/enhance", {});
  check(`${who}: Enhance isn't offered`, enhance.status() === 403 && (await body(enhance)).code === "own-gpu-tool", String(enhance.status()));
  const page = await send("GET", "/shorts/nope-not-a-short");
  check(`${who}: an unknown short's page is a 404`, page.status() === 404, String(page.status()));
  if (who === "guest") {
    for (const [method, p] of [
      ["POST", "/api/shorts/sessions"],
      ["POST", "/api/shorts/sessions/nope/segments/0"],
      ["POST", "/api/shorts/sessions/nope/stitch"],
      ["PATCH", "/api/shorts/sessions/nope"],
      ["DELETE", "/api/shorts/sessions/nope"],
      ["POST", "/api/shorts/presets"],
    ]) {
      const r = await send(method, p, {});
      check(`guest: ${method} ${p} asks to sign up`, r.status() === 401 && r.headers()["x-fuobe-guest"] === "1", String(r.status()));
    }
    const one = await send("GET", "/api/shorts/sessions/nope");
    check("guest: a short by id is closed", one.status() === 401, String(one.status()));
    return;
  }
  // The account reaches its routes, which answer with its own only.
  const one = await send("GET", "/api/shorts/sessions/nope");
  check("account: another's or no short reads as gone", one.status() === 404, String(one.status()));
  for (const [method, p, data] of [
    ["POST", "/api/shorts/sessions/nope/segments/0", {}],
    ["POST", "/api/shorts/sessions/nope/stitch", {}],
    ["POST", "/api/shorts/sessions/nope/segments/0/primary", { generationId: "x" }],
    ["PATCH", "/api/shorts/sessions/nope", { title: "x" }],
    ["DELETE", "/api/shorts/sessions/nope", undefined],
    ["PATCH", "/api/shorts/presets/nope", { name: "x" }],
  ]) {
    const r = await send(method, p, data);
    check(`account: ${method} ${p} is not found`, r.status() === 404, String(r.status()));
  }
  const bad = await send("POST", "/api/shorts/sessions", {});
  check("account: its run reaches the route (a bad request is a 400)", bad.status() === 400, String(bad.status()));
  const notMine = await send("POST", "/api/shorts/presets", { references: ["/api/files/not-mine.png"] });
  check("account: a picture that isn't its own makes no preset", notMine.status() >= 400 && notMine.status() < 500 && notMine.status() !== 401, String(notMine.status()));
}

const browser = await launch();
const email = `shorts-ui-${crypto.randomBytes(5).toString("hex")}@example.com`;
const password = crypto.randomBytes(18).toString("base64url");
let signedUp = false;
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
try {
  const page = await context.newPage();
  await routes(page.request, "guest");
  const look = async (who) => {
    await page.goto(`${app}/shorts`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForTimeout(3000);
    check(`${who}: no "isn't available here" note`, (await page.getByText("Shorts Studio isn't available here").count()) === 0);
    check(`${who}: no price says "Not available here"`, (await page.getByText("Not available here").count()) === 0);
    const choose = page.getByRole("button", { name: "Choose a video" });
    check(`${who}: the clip drop is on`, (await choose.count()) > 0 && (await choose.first().isEnabled()));
    check(`${who}: Create a preset is offered`, (await page.getByText("Create a preset").count()) > 0);
    const generate = page.getByRole("button", { name: /Generate short/ });
    // Not turned off (`disabled`); like everyone's, it waits for a preset and a clip (aria-disabled, with the reason).
    check(`${who}: Generate is on`, (await generate.count()) > 0 && (await generate.first().evaluate((e) => !e.disabled)));
    if (shots) await page.screenshot({ path: path.join(shots, `shorts-${who}.png`), fullPage: false });
    // Choosing a video asks first: the sign-up card for a guest, the connect card for an account with no GPU or key.
    await choose.first().click();
    await page.waitForTimeout(1500);
    const card = who === "guest" ? /Create a free account/ : /Connect your GPU|your own files/;
    check(`${who}: choosing a video opens the ${who === "guest" ? "sign-up" : "connect"} card`, (await page.getByText(card).count()) > 0);
    if (shots) await page.screenshot({ path: path.join(shots, `shorts-${who}-choose.png`) });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    await page.goto(`${app}/shorts?tab=history`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForTimeout(2500);
    check(`${who}: History says there are no shorts yet`, (await page.getByText("No shorts yet").count()) > 0);
  };
  await look("guest");

  // A throwaway account (signed in in this browser), then the same checks.
  const res = await page.request.post(`${app}/api/auth/signup`, { data: { email, password }, headers: { origin: app } });
  signedUp = res.ok();
  check("signed up a throwaway account", signedUp, String(res.status()));
  if (signedUp) {
    await routes(page.request, "account");
    await look("account");
  }
} finally {
  if (signedUp) {
    const page = context.pages()[0];
    const del = await page.request.delete(`${app}/api/auth/me`, { data: { password }, headers: { origin: app } });
    console.log(`deleted the throwaway account: ${del.status()}`);
    check("deleted the throwaway account", del.status() === 204 || del.ok(), String(del.status()));
  }
  await browser.close();
}
console.log(failures.length ? `${failures.length} failed` : "all ok");
process.exit(failures.length ? 1 : 0);
