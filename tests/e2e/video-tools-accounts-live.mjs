// Remove object, Remove a person, Evolution, Mixed Media, Turnaround video, Fly around and Katana for visitors (a studio
// with a password and public sign-up, fuobe.com by default), through their routes and in a browser at phone and desktop
// widths. A guest: the sign-up card on every run, the price checks open, an empty Katana list, no "isn't available here"
// note, and the sign-up card when it chooses a clip. A signed-in account (a throwaway one this script makes and deletes):
// its runs reach the routes (a bad request is a 400, nobody else's run or render is found), its own empty Katana list,
// the pages' upload and run buttons on, and the connect card when it has neither a GPU nor a key.
// No run is started (that needs the account's own GPU or key).
// Usage: node tests/e2e/video-tools-accounts-live.mjs [appUrl] [--shots <dir>]   Exits 1 on a failed check.
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

const clip = { url: "/api/files/placeholder.mp4", duration: 12, fps: 24, width: 720, height: 1280, hasAudio: true };
const PRICES = [
  ["/api/remove-object/estimate", { engine: "open", mode: "type", prompt: "the cup", source: clip, range: { start: 0, end: 3 } }],
  ["/api/evolution/estimate", { engine: "open", source: clip, range: { start: 0, end: 6 } }],
  ["/api/mixed-media/estimate", { engine: "open", presetId: "mixed-sketch", source: clip, range: { start: 0, end: 2 }, fps: 8, resolution: "1K" }],
  ["/api/turnaround?preview=1", { engine: "open", views: { front: "/api/files/placeholder.png" } }],
  ["/api/fly-around?preview=1", { engine: "open", image: "/api/files/placeholder.png", orbit: { degrees: 90, direction: "cw" } }],
];
const RUNS = ["/api/remove-object", "/api/remove-object/preview", "/api/remove-object/reroll", "/api/evolution", "/api/evolution/direction", "/api/mixed-media", "/api/mixed-media/preview", "/api/mixed-media/retry", "/api/turnaround", "/api/fly-around", "/api/katana", "/api/katana/nope/retry"];

/** The route checks, as a guest (`req`: a context's request, signed out) or as the account (signed in). */
async function routes(req, who) {
  const send = (method, p, data) => req.fetch(`${app}${p}`, { method, headers: { origin: app, "content-type": "application/json" }, ...(data !== undefined && { data }) });
  const body = async (r) => r.json().catch(() => ({}));
  for (const [p, data] of PRICES) {
    const r = await send("POST", p, data);
    const e = await body(r);
    check(`${who}: the price check ${p.replace(/\?.*/, "")} works, never as a demo`, r.status() === 200 && e.demo === false, `${r.status()} ${JSON.stringify(e).slice(0, 80)}`);
  }
  const list = await send("GET", "/api/katana");
  check(`${who}: its Katana list is empty`, list.status() === 200 && JSON.stringify(await body(list)) === '{"items":[]}', String(list.status()));
  if (who === "guest") {
    for (const p of RUNS) {
      const r = await send("POST", p, {});
      check(`guest: POST ${p} asks to sign up`, r.status() === 401 && r.headers()["x-fuobe-guest"] === "1", String(r.status()));
    }
    for (const [method, p] of [
      ["GET", "/api/katana/nope"],
      ["DELETE", "/api/katana/nope"],
      ["GET", "/api/mixed-media/progress?id=nope"],
    ]) {
      const r = await send(method, p);
      check(`guest: ${method} ${p} is closed`, r.status() === 401, String(r.status()));
    }
    return;
  }
  // The account with neither a GPU nor a key: a run is asked to connect one (the proxy, or the route's own checks).
  for (const p of RUNS.filter((x) => x !== "/api/katana")) {
    const r = await send("POST", p, {});
    check(`account: POST ${p} asks to connect a GPU or key`, r.status() === 403 && (await body(r)).code === "connect-gpu", String(r.status()));
  }
  const bad = await send("POST", "/api/katana", {});
  check("account: a Katana run reaches the route (a bad request is a 400)", bad.status() === 400, String(bad.status()));
  for (const [method, p] of [
    ["GET", "/api/katana/nope"],
    ["DELETE", "/api/katana/nope"],
    ["GET", "/api/mixed-media/progress?id=nope"],
  ]) {
    const r = await send(method, p);
    check(`account: ${method} ${p} is not found`, r.status() === 404, String(r.status()));
  }
}

const PAGES = [
  ["remove-object", "/video-tools/remove-object", /Remove object isn't available here/, "Choose a video"],
  ["remove-person", "/video-tools/remove-person", /Remove a person isn't available here/, "Choose a video"],
  ["evolution", "/video-tools/evolution", /Evolution isn't available here/, "Choose a video"],
  ["mixed-media", "/mixed-media", /Mixed Media isn't available here/, "Choose a video"],
  ["katana", "/katana", /Katana isn't available here/, "Upload a video"],
];

const browser = await launch();
const email = `video-ui-${crypto.randomBytes(5).toString("hex")}@example.com`;
const password = crypto.randomBytes(18).toString("base64url");
let signedUp = false;
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
try {
  const page = await context.newPage();
  await routes(page.request, "guest");
  const look = async (who) => {
    for (const [width, height] of [
      [1440, 1000],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      for (const [name, url, note, choose] of PAGES) {
        await page.goto(`${app}${url}`, { waitUntil: "load", timeout: 60_000 });
        await page.waitForTimeout(2500);
        const at = `${who} ${name} @${width}`;
        check(`${at}: no "isn't available here" note`, (await page.getByText(note).count()) === 0);
        check(`${at}: no price says "Not available here"`, (await page.getByText("Not available here").count()) === 0);
        const scroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        check(`${at}: no sideways scroll`, scroll <= 1, String(scroll));
        const button = page.getByRole("button", { name: choose });
        check(`${at}: the clip drop is on`, (await button.count()) > 0 && (await button.first().isEnabled()));
        if (shots) await page.screenshot({ path: path.join(shots, `${name}-${who}-${width}.png`) });
        if (width !== 1440) continue;
        // Choosing a clip asks first: the sign-up card for a guest, the connect card for an account with no GPU or key.
        await button.first().click();
        await page.waitForTimeout(1500);
        const card = who === "guest" ? /Create a free account/ : /Connect your GPU|your own files/;
        check(`${at}: choosing a clip opens the ${who === "guest" ? "sign-up" : "connect"} card`, (await page.getByText(card).count()) > 0);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
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
