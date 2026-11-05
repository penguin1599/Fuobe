// Photodump, Fashion Factory, Character Sheet and AI Influencer for visitors (a studio with a password and public
// sign-up, fuobe.com by default), through their routes and in a browser at a phone's width and a desktop's. A guest:
// the sign-up card on every run and change, empty packs and characters, the price checks open, no "isn't available
// here" note, and the sign-up card when it creates a pack, a character or chooses a photo. A signed-in account (a
// throwaway one this script makes and deletes): its own empty packs and characters, the connect card on a run and on
// choosing a photo (it has neither a GPU nor a key), and Generate on.
// No run is started (that needs the account's own GPU or key).
// Usage: node tests/e2e/photo-apps-accounts-live.mjs [appUrl] [--shots <dir>]   Exits 1 on a failed check.
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
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(76)}${extra ? ` ${extra}` : ""}`);
  if (!ok) failures.push(label);
};

const RUNS = [
  ["/api/photodump", { packId: "nope", engine: "open", selfie: "/api/files/nope.png" }],
  ["/api/photodump/fashion", { step: "photoset", templateId: "nope", dressed: "/api/files/nope.png", engine: "open" }],
  ["/api/photodump/character", { mode: "describe", engine: "open", prompt: "a surfer" }],
  ["/api/photodump/retry", { id: "nope" }],
  ["/api/influencer", { engine: "open", state: { tier: "normal", picks: {}, locked: [] }, start: "scratch" }],
];

/** The route checks, as a guest (`req`: a context's request, signed out) or as the account (signed in). */
async function routes(req, who) {
  const send = (method, p, data) => req.fetch(`${app}${p}`, { method, headers: { origin: app, "content-type": "application/json" }, ...(data !== undefined && { data }) });
  const body = async (r) => r.json().catch(() => ({}));
  const packs = await send("GET", "/api/photodump/packs");
  check(`${who}: its packs are empty`, packs.status() === 200 && JSON.stringify(await body(packs)) === '{"packs":[]}', String(packs.status()));
  const chars = await send("GET", "/api/photodump/characters");
  check(`${who}: its characters are empty`, chars.status() === 200 && JSON.stringify(await body(chars)) === '{"items":[]}', String(chars.status()));
  for (const [p, data] of [
    ["/api/photodump/character?preview=1", { mode: "describe", engine: "open", prompt: "a surfer and photographer from Lisbon" }],
    ["/api/influencer/estimate", { engine: "open", state: { tier: "normal", picks: {}, locked: [] }, start: "scratch" }],
  ]) {
    const r = await send("POST", p, data);
    const e = await body(r);
    check(`${who}: the price check ${p} works, never as a demo`, r.status() === 200 && !e.error && e.demo === false, `${r.status()} ${JSON.stringify(e).slice(0, 90)}`);
  }
  for (const [p, data] of RUNS) {
    const r = await send("POST", p, data);
    const text = JSON.stringify(await body(r));
    const isntHere = /isn't available here/.test(text);
    if (who === "guest") check(`guest: POST ${p} asks to sign up`, r.status() === 401 && r.headers()["x-fuobe-guest"] === "1" && !isntHere, String(r.status()));
    else check(`account: POST ${p} asks to connect a GPU or key`, r.status() === 403 && r.headers()["x-fuobe-connect-gpu"] === "1" && !isntHere, `${r.status()} ${text.slice(0, 80)}`);
  }
  for (const [method, p, data] of [
    ["POST", "/api/photodump/packs", { name: "x", refs: ["/api/files/not-mine.png"] }],
    ["DELETE", "/api/photodump/packs/nope", undefined],
    ["POST", "/api/photodump/characters", { name: "x", references: ["/api/files/not-mine.png"] }],
    ["DELETE", "/api/photodump/characters/nope", undefined],
  ]) {
    const r = await send(method, p, data);
    if (who === "guest") check(`guest: ${method} ${p} asks to sign up`, r.status() === 401 && r.headers()["x-fuobe-guest"] === "1", String(r.status()));
    else check(`account: ${method} ${p} reaches its own (not its file / not found)`, r.status() === 403 || r.status() === 404, String(r.status()));
  }
}

const PAGES = [
  { path: "/photodump", note: "Photodump isn't available here", run: null, ask: { role: "button", name: /Create pack/ } },
  { path: "/fashion-factory", note: "Fashion Factory isn't available here", run: null, ask: null },
  { path: "/character-sheet", note: "Character Sheet isn't available here", run: /Create AI Avatar/, ask: { role: "button", name: /Drop images here/ } },
  { path: "/influencer", note: "AI Influencer isn't available here", run: /Generate character sheet/, ask: { role: "button", name: "Add clothing references" } },
];

async function look(page, who, width) {
  for (const p of PAGES) {
    const tag = `${who} ${width} ${p.path}`;
    await page.goto(`${app}${p.path}`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForTimeout(2500);
    check(`${tag}: no "isn't available here" note`, (await page.getByText(p.note).count()) === 0 && (await page.getByText(/isn.t available here/).count()) === 0);
    check(`${tag}: no price says "Not available here"`, (await page.getByText("Not available here").count()) === 0);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    check(`${tag}: no sideways scroll`, wide);
    if (p.run) {
      const run = page.getByRole("button", { name: p.run });
      check(`${tag}: its run button is on`, (await run.count()) > 0 && (await run.first().evaluate((e) => !e.disabled)));
    }
    if (shots) await page.screenshot({ path: path.join(shots, `${p.path.slice(1)}-${who}-${width}.png`), fullPage: false });
    if (p.ask) {
      const b = page.getByRole(p.ask.role, { name: p.ask.name });
      check(`${tag}: ${String(p.ask.name)} is offered`, (await b.count()) > 0);
      if ((await b.count()) > 0) {
        await b.first().click();
        await page.waitForTimeout(1500);
        const card = who === "guest" ? /Create a free account/ : /Connect your GPU|your own files/;
        check(`${tag}: it opens the ${who === "guest" ? "sign-up" : "connect"} card`, (await page.getByText(card).count()) > 0);
        if (shots) await page.screenshot({ path: path.join(shots, `${p.path.slice(1)}-${who}-${width}-ask.png`) });
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
      }
    }
  }
  // Fashion Factory's character step: New character asks first too.
  await page.goto(`${app}/fashion-factory`, { waitUntil: "load", timeout: 60_000 });
  await page.waitForTimeout(2000);
  await page.getByRole("radio").first().click();
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.waitForTimeout(800);
  const nc = page.getByRole("button", { name: /New character/ });
  check(`${who} ${width} /fashion-factory: New character is offered`, (await nc.count()) > 0);
  check(`${who} ${width} /fashion-factory: no "Saving characters isn't available here"`, (await page.getByText(/Saving characters/).count()) === 0);
  if ((await nc.count()) > 0) {
    await nc.first().click();
    await page.waitForTimeout(1500);
    const card = who === "guest" ? /Create a free account/ : /Connect your GPU|your own files/;
    check(`${who} ${width} /fashion-factory: New character opens the ${who === "guest" ? "sign-up" : "connect"} card`, (await page.getByText(card).count()) > 0);
    if (shots) await page.screenshot({ path: path.join(shots, `fashion-factory-${who}-${width}-character.png`) });
    await page.keyboard.press("Escape");
  }
  // Leave the template step as it was for the next visit.
  await page.evaluate(() => {
    try {
      localStorage.removeItem("fuobe.fashion");
    } catch {}
  });
}

const browser = await launch();
const email = `photo-ui-${crypto.randomBytes(5).toString("hex")}@example.com`;
const password = crypto.randomBytes(18).toString("base64url");
let signedUp = false;
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
try {
  const page = await context.newPage();
  await routes(page.request, "guest");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await look(page, "guest", width);
  }
  // A throwaway account (signed in in this browser), then the same checks.
  const res = await page.request.post(`${app}/api/auth/signup`, { data: { email, password }, headers: { origin: app } });
  signedUp = res.ok();
  check("signed up a throwaway account", signedUp, String(res.status()));
  if (signedUp) {
    await routes(page.request, "account");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await look(page, "account", width);
    }
  }
} finally {
  if (signedUp) {
    const page = context.pages()[0];
    const del = await page.request.delete(`${app}/api/auth/me`, { data: { password }, headers: { origin: app } });
    console.log(`deleted the throwaway account: ${del.status()}`);
    check("deleted the throwaway account", del.status() === 204, String(del.status()));
  }
  await browser.close();
}
console.log(failures.length ? `${failures.length} failed` : "all ok");
process.exit(failures.length ? 1 : 0);
