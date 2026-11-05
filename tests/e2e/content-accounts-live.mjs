// Faceless Studio, the Explainer and Content Factory for visitors (a studio with a password and public sign-up, fuobe.com
// by default), through their routes and in a browser at phone and desktop widths. A guest: the sign-up card on every
// change, empty lists, the price checks open, no "isn't available here" note, and the sign-up card when it attaches a
// file or adds a clip. A signed-in account (a throwaway one this script makes and deletes): its own channel, episode,
// explainer and series made, reopened and deleted; nobody else's (404); its renders ask for its own GPU or key first;
// links, "Generate in Claude" and "Regenerate to 1080p" not offered; the pages' buttons on.
// No render is started (that needs the account's own GPU or key).
// Usage: node tests/e2e/content-accounts-live.mjs [appUrl] [--shots <dir>]   Exits 1 on a failed check.
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

const settings = { engine: "open", length: 20, animation: "frames", aspect: "16:9", subtitles: false, music: false, styleId: "editorial-motion-graphics", styleRefs: [], voice: null, elements: [], auto: false };
const seriesAsk = { prompt: "Three hotels you can only reach by boat", settings: { engine: "open", length: 30, episodes: 1, animation: "frame-by-frame", genre: "education", aspect: "9:16" }, voice: null, subtitles: false, music: false };

/** The route checks, as a guest (`req`: a context's request, signed out) or as the account (signed in). */
async function routes(req, who) {
  const send = (method, p, data) => req.fetch(`${app}${p}`, { method, headers: { origin: app, "content-type": "application/json" }, ...(data !== undefined && { data }) });
  const body = async (r) => r.json().catch(() => ({}));
  const asksFirst = async (r) => {
    const b = await body(r);
    return (r.status() === 400 && /narrator/.test(b.error ?? "")) || (r.status() === 403 && ["connect-gpu", "add-key"].includes(b.code));
  };
  for (const p of ["/api/faceless/channels", "/api/faceless/episodes", "/api/explainer", "/api/content-factory/series"]) {
    const r = await send("GET", p);
    check(`${who}: ${p} lists nothing yet`, r.status() === 200 && JSON.stringify(await body(r)) === '{"items":[]}', String(r.status()));
  }
  const price = await send("POST", "/api/faceless/estimate", { kind: "explainer", settings });
  const e = await body(price);
  check(`${who}: the explainer's price check works, never as a demo`, price.status() === 200 && e.demo === false, `${price.status()} ${JSON.stringify(e).slice(0, 80)}`);
  const cf = await send("POST", "/api/content-factory/estimate", { ...seriesAsk, presetId: "what-if" });
  check(`${who}: the series' price check works`, cf.status() === 200 && (await body(cf)).demo === false, String(cf.status()));
  for (const p of ["/faceless/nope-not-a-channel", "/explainer/nope-not-an-explainer", "/content-factory/nope-not-a-series"]) {
    const r = await send("GET", p);
    check(`${who}: ${p} is a 404`, r.status() === 404, String(r.status()));
  }
  for (const p of ["/api/explainer/link", "/api/content-factory/claude", "/api/faceless/episodes/nope/regenerate"]) {
    const r = await send("POST", p, {});
    check(`${who}: ${p} isn't offered`, r.status() === 403 && (await body(r)).code === "own-gpu-tool", String(r.status()));
  }
  if (who === "guest") {
    for (const [method, p] of [
      ["POST", "/api/faceless/channels"],
      ["POST", "/api/faceless/episodes"],
      ["POST", "/api/faceless/episodes/nope/render"],
      ["POST", "/api/faceless/topics"],
      ["DELETE", "/api/faceless/channels/nope"],
      ["POST", "/api/explainer"],
      ["POST", "/api/content-factory/series"],
      ["POST", "/api/content-factory/series/nope/generate"],
      ["POST", "/api/starters/faceless.boat-hotels"],
    ]) {
      const r = await send(method, p, {});
      check(`guest: ${method} ${p} asks to sign up`, r.status() === 401 && r.headers()["x-fuobe-guest"] === "1", String(r.status()));
    }
    for (const p of ["/api/faceless/channels/nope", "/api/faceless/episodes/nope", "/api/content-factory/series/nope"]) {
      const r = await send("GET", p);
      check(`guest: ${p} is closed`, r.status() === 401, String(r.status()));
    }
    return;
  }
  // The account reaches its routes, which answer with its own only.
  for (const p of ["/api/faceless/channels/nope", "/api/faceless/episodes/nope", "/api/content-factory/series/nope"]) {
    const r = await send("GET", p);
    check(`account: ${p} (none of its own) is not found`, r.status() === 404, String(r.status()));
  }
  // Its own channel: made, reopened, an episode written offline, its render asks for its own GPU or key first.
  const ch = await send("POST", "/api/faceless/channels", { idea: "Strange hotels on the water", genre: "education", engine: "open" });
  const channel = await body(ch);
  check("account: makes a channel of its own", ch.status() === 201 && !!channel.id, String(ch.status()));
  if (channel.id) {
    const list = await body(await send("GET", "/api/faceless/channels"));
    check("account: its channels list it", list.items?.length === 1 && list.items[0].id === channel.id);
    const ep = await send("POST", "/api/faceless/episodes", { channelId: channel.id, topic: "A hotel on a frozen lake", settings: { ...settings, length: 60, auto: undefined } });
    const episode = await body(ep);
    check("account: writes an episode (offline, for review)", ep.status() === 201 && episode.status === "review" && episode.script?.blocks?.length > 0, `${ep.status()} ${episode.status}`);
    if (episode.id) {
      const one = await send("GET", `/api/faceless/episodes/${episode.id}`);
      check("account: reopens its episode", one.status() === 200, String(one.status()));
      const page = await send("GET", `/faceless/${channel.id}/${episode.id}`);
      check("account: its episode's page opens", page.status() === 200, String(page.status()));
      // No narrator yet (open engine): it asks for one; with one, for its own GPU or key. Nothing starts either way.
      const render = await send("POST", `/api/faceless/episodes/${episode.id}/render`, {});
      check("account: its render asks for a narrator, then its own GPU or key", await asksFirst(render), String(render.status()));
    }
    const del = await send("DELETE", `/api/faceless/channels/${channel.id}`);
    check("account: deletes its channel", del.status() === 204, String(del.status()));
  }
  // Its own explainer, written for review.
  const ex = await send("POST", "/api/explainer", { prompt: "Why the sky is blue", settings, review: true });
  const explainer = await body(ex);
  check("account: writes an explainer for review", ex.status() === 201 && explainer.status === "review", `${ex.status()} ${explainer.status}`);
  if (explainer.id) {
    const page = await send("GET", `/explainer/${explainer.id}`);
    check("account: its explainer's page opens", page.status() === 200, String(page.status()));
    const render = await send("POST", `/api/faceless/episodes/${explainer.id}/render`, {});
    check("account: the explainer's render asks for a narrator, then its own GPU or key", await asksFirst(render), String(render.status()));
    const del = await send("DELETE", `/api/faceless/episodes/${explainer.id}`);
    check("account: deletes its explainer", del.status() === 204, String(del.status()));
  }
  // Its own series from a preset (no clip to read).
  const s = await send("POST", "/api/content-factory/series", { reference: { kind: "preset", presetId: "what-if" }, engine: "open" });
  const series = await body(s);
  check("account: makes a series from a preset", s.status() === 201 && !!series.id, String(s.status()));
  if (series.id) {
    const one = await send("GET", `/api/content-factory/series/${series.id}`);
    check("account: reopens its series", one.status() === 200, String(one.status()));
    const gen = await send("POST", `/api/content-factory/series/${series.id}/generate`, seriesAsk);
    check("account: Generate reaches its route (no narrator yet: it says so)", gen.status() >= 400 && gen.status() < 500 && gen.status() !== 401, String(gen.status()));
    const del = await send("DELETE", `/api/content-factory/series/${series.id}`);
    check("account: deletes its series", del.status() === 204, String(del.status()));
  }
}

/** One page's checks at one width. */
async function look(page, who, width) {
  const tag = `${who} @${width}`;
  const shot = async (name) => shots && (await page.screenshot({ path: path.join(shots, `${name}-${who}-${width}.png`), fullPage: false }));
  const card = who === "guest" ? /Create a free account/ : /Connect your GPU|your own files/;
  const notes = ["Faceless channels aren't available here", "Explainer videos aren't available here", "Content Factory isn't available here", "Not available here"];
  const noNotes = async (name) => {
    let found = 0;
    for (const n of notes) found += await page.getByText(n).count();
    check(`${tag}: ${name} shows no "not available" note`, found === 0);
  };

  await page.goto(`${app}/faceless`, { waitUntil: "load", timeout: 60_000 });
  await page.waitForTimeout(3000);
  await noNotes("/faceless");
  const next = page.getByRole("button", { name: /^Next$/ });
  check(`${tag}: Faceless's Next is on`, (await next.count()) > 0 && (await next.first().isEnabled()));
  check(`${tag}: /faceless has no sideways scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await shot("faceless");

  await page.goto(`${app}/explainer`, { waitUntil: "load", timeout: 60_000 });
  await page.waitForTimeout(3000);
  await noNotes("/explainer");
  const generate = page.getByRole("button", { name: /^Generate$/ });
  check(`${tag}: the Explainer's Generate is on`, (await generate.count()) > 0 && (await generate.first().isEnabled()));
  check(`${tag}: the Explainer offers no link source`, (await page.getByRole("button", { name: "Paste a link" }).count()) === 0);
  check(`${tag}: /explainer has no sideways scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await shot("explainer");
  const attach = page.getByRole("button", { name: "Attach a file" });
  check(`${tag}: Attach a file is offered`, (await attach.count()) > 0 && (await attach.first().isEnabled()));
  if (await attach.count()) {
    await attach.first().click();
    await page.waitForTimeout(1500);
    check(`${tag}: Attach a file opens the ${who === "guest" ? "sign-up" : "connect"} card`, (await page.getByText(card).count()) > 0);
    await shot("explainer-attach");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }

  await page.goto(`${app}/content-factory`, { waitUntil: "load", timeout: 60_000 });
  await page.waitForTimeout(3000);
  await noNotes("/content-factory");
  check(`${tag}: Content Factory offers no link (the clip is added)`, (await page.getByRole("button", { name: /TikTok or Instagram link/ }).count()) === 0);
  check(`${tag}: Content Factory offers no "Generate in Claude"`, (await page.getByText("Generate in Claude").count()) === 0);
  const go = page.getByRole("button", { name: /^Generate/ });
  check(`${tag}: Content Factory's Generate is on`, (await go.count()) > 0 && (await go.first().isEnabled()));
  check(`${tag}: /content-factory has no sideways scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await shot("content-factory");
  const add = page.getByRole("button", { name: /Add a video/ });
  if (await add.count()) {
    await add.first().click();
    await page.waitForTimeout(1500);
    check(`${tag}: Add a video opens the ${who === "guest" ? "sign-up" : "connect"} card`, (await page.getByText(card).count()) > 0);
    await shot("content-factory-add");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  } else check(`${tag}: Add a video is offered`, false);
}

const browser = await launch();
const email = `content-ui-${crypto.randomBytes(5).toString("hex")}@example.com`;
const password = crypto.randomBytes(18).toString("base64url");
let signedUp = false;
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
try {
  const page = await context.newPage();
  await routes(page.request, "guest");
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await look(page, "guest", width);
  }
  // A throwaway account (signed in in this browser), then the same checks.
  const res = await page.request.post(`${app}/api/auth/signup`, { data: { email, password }, headers: { origin: app } });
  signedUp = res.ok();
  check("signed up a throwaway account", signedUp, String(res.status()));
  if (signedUp) {
    await routes(page.request, "account");
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await look(page, "account", width);
    }
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
