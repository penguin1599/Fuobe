// The Audio tools and Translate & dub for visitors (a studio with a password and public sign-up, fuobe.com by default),
// through their routes and in a browser at a phone's and a desktop's width. A guest: the sign-up card on every run and
// change, an empty list of dubs, the price checks open, no "isn't available here" note, and the sign-up card when it
// adds a file. A signed-in account (a throwaway one this script makes and deletes): its own empty dubs, nobody else's
// dub (404), the pages' upload and run on, and the connect card when it has neither a GPU nor a key.
// No run is started (that needs the account's own GPU or key).
// Usage: node tests/e2e/audio-accounts-live.mjs [appUrl] [--shots <dir>]   Exits 1 on a failed check.
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
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(78)}${extra ? ` ${extra}` : ""}`);
  if (!ok) failures.push(label);
};

const PAGES = [
  { path: "/audio/split", name: "Split soundtrack", upload: /Upload audio or video/ },
  { path: "/video-tools/remove-dialogue", name: "Remove dialogue", upload: /Upload a video/ },
  { path: "/audio/edit-speech", name: "Edit speech", upload: /^Upload$/, label: "Runs on your own GPU · 24 GB" },
  { path: "/audio/translate", name: "Translate & dub", upload: /Upload a video/ },
];

/** The route checks, as a guest (`req`: a context's request, signed out) or as the account (signed in). */
async function routes(req, who) {
  const send = (method, p, data) => req.fetch(`${app}${p}`, { method, headers: { origin: app, "content-type": "application/json" }, ...(data !== undefined && { data }) });
  const body = async (r) => r.json().catch(() => ({}));
  const dubs = await send("GET", "/api/dub");
  check(`${who}: its dubs are empty`, dubs.status() === 200 && JSON.stringify(await body(dubs)) === '{"items":[]}', String(dubs.status()));
  // A price check passes the sign-in gate (a file that isn't the asker's reads as gone: 422, never 401 or 403).
  const price = await send("POST", "/api/audio-tools?preview=1", { tool: "split", engine: "open", media: "/api/files/not-mine.wav", kind: "audio" });
  check(`${who}: Split's price check is open`, price.status() === 422, String(price.status()));
  const dubPrice = await send("POST", "/api/dub?preview=1", { engine: "open", mode: "steps", video: "/api/files/not-mine.mp4", targets: ["es"] });
  check(`${who}: a dub's price check is open`, dubPrice.status() !== 401 && dubPrice.status() !== 403, String(dubPrice.status()));
  if (who === "guest") {
    for (const [method, p] of [
      ["POST", "/api/audio-tools"],
      ["POST", "/api/dub"],
      ["POST", "/api/dub/nope/voice"],
      ["PATCH", "/api/dub/nope"],
      ["DELETE", "/api/dub/nope"],
    ]) {
      const r = await send(method, p, {});
      check(`guest: ${method} ${p} asks to sign up`, r.status() === 401 && r.headers()["x-fuobe-guest"] === "1", String(r.status()));
    }
    const one = await send("GET", "/api/dub/nope");
    check("guest: a dub by id is closed", one.status() === 401, String(one.status()));
    return;
  }
  // The account reaches its routes, which answer with its own only.
  for (const [method, p, data] of [
    ["GET", "/api/dub/nope", undefined],
    ["PATCH", "/api/dub/nope", { lang: "es", cues: [] }],
    ["DELETE", "/api/dub/nope", undefined],
  ]) {
    const r = await send(method, p, data);
    check(`account: ${method} ${p} is not found`, r.status() === 404, String(r.status()));
  }
  // With neither a GPU nor a key of its own: the connect card, never "isn't available here".
  for (const [p, data] of [
    ["/api/audio-tools", { tool: "split", engine: "open", media: "/api/files/x.wav", kind: "audio" }],
    ["/api/dub", { engine: "open", mode: "steps", video: "/api/files/x.mp4", targets: ["es"] }],
    ["/api/dub/nope/voice", { lang: "es" }],
  ]) {
    const r = await send("POST", p, data);
    const j = await body(r);
    check(`account: POST ${p} asks to connect a GPU`, r.status() === 403 && j.code === "connect-gpu" && r.headers()["x-fuobe-connect-gpu"] === "1", `${r.status()} ${j.code ?? ""}`);
  }
}

const browser = await launch();
const email = `audio-ui-${crypto.randomBytes(5).toString("hex")}@example.com`;
const password = crypto.randomBytes(18).toString("base64url");
let signedUp = false;
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
try {
  const page = await context.newPage();
  await routes(page.request, "guest");
  const look = async (who) => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      for (const p of PAGES) {
        const at = `${who} ${width}: ${p.name}`;
        await page.goto(`${app}${p.path}`, { waitUntil: "load", timeout: 60_000 });
        await page.waitForTimeout(2500);
        check(`${at}: no "isn't available here" note`, (await page.getByText(/isn.t available here/).count()) === 0);
        check(`${at}: no price says "Not available here"`, (await page.getByText("Not available here").count()) === 0);
        const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check(`${at}: no sideways scroll`, scroll <= 1, String(scroll));
        if (p.label) check(`${at}: its own-setup label shows`, (await page.getByText(p.label).count()) > 0);
        const upload = page.getByRole("button", { name: p.upload });
        check(`${at}: the upload is on`, (await upload.count()) > 0 && (await upload.first().isEnabled()));
        if (shots) await page.screenshot({ path: path.join(shots, `${who}-${width}-${p.path.replace(/\//g, "_")}.png`) });
        if (width !== 1440 || !(await upload.count())) continue;
        // Adding a file asks first: the sign-up card for a guest, the connect card for an account with no GPU or key.
        await upload.first().click();
        await page.waitForTimeout(1500);
        const card = who === "guest" ? /Create a free account/ : /Connect your GPU|your own files/;
        check(`${at}: the upload opens the ${who === "guest" ? "sign-up" : "connect"} card`, (await page.getByText(card).count()) > 0);
        if (shots) await page.screenshot({ path: path.join(shots, `${who}-${width}-${p.path.replace(/\//g, "_")}-card.png`) });
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
      }
    }
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
    check("deleted the throwaway account", del.status() === 204, String(del.status()));
  }
  await browser.close();
}
console.log(failures.length ? `${failures.length} failed` : "all ok");
process.exit(failures.length ? 1 : 0);
