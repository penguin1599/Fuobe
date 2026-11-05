// Character Swap Studio for visitors, in a browser (a studio with a password and public sign-up, fuobe.com by default):
// a guest and a signed-in account see no "isn't available here" note and can press New project; the guest's opens the
// sign-up card, the account's makes a project of its own, which opens, lists, stays out of another's reach and is
// deleted. The upload boxes (here and in Genjutsu) say the clip size the viewer may upload. The account is a throwaway
// one this script makes and deletes. No run is started (that needs the account's own GPU or key).
// Usage: node tests/e2e/character-swap-accounts-live.mjs [appUrl] [--shots <dir>]   Exits 1 on a failed check.
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
const NOTE = "Character Swap isn't available here.";

const browser = await launch();
const email = `swap-ui-${crypto.randomBytes(5).toString("hex")}@example.com`;
const password = crypto.randomBytes(18).toString("base64url");
let signedUp = false;
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
try {
  const page = await context.newPage();
  const api = (method, url, data) => page.request.fetch(`${app}${url}`, { method, headers: { origin: app, ...(data && { "content-type": "application/json" }) }, ...(data && { data }) });
  const home = async (who) => {
    await page.goto(`${app}/character-swap`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForTimeout(2500);
    check(`${who}: no "isn't available here" note`, (await page.getByText(NOTE).count()) === 0);
    const button = page.getByRole("button", { name: /New project/ });
    check(`${who}: New project is on`, (await button.count()) > 0 && (await button.first().isEnabled()));
    check(`${who}: the projects list shows`, (await page.locator("#swap-projects").count()) > 0);
    if (shots) await page.screenshot({ path: path.join(shots, `swap-${who}.png`) });
    return button.first();
  };
  const genjutsuBox = async (who) => {
    await page.goto(`${app}/genjutsu?mode=character`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForTimeout(2500);
    check(`${who}: Genjutsu's upload box says 95 MB`, (await page.getByText(/· 95 MB/).count()) > 0 && (await page.getByText(/· 200 MB/).count()) === 0);
  };

  // A guest: the routes, then the page.
  const gl = await api("GET", "/api/swap-studio/projects");
  check("guest: the list is empty", gl.status() === 200 && JSON.stringify(await gl.json()) === '{"items":[]}', String(gl.status()));
  check("guest: a project is 'Sign up'", (await api("GET", "/api/swap-studio/projects/x")).status() === 401);
  for (const p of ["/api/swap-studio/projects", "/api/swap-studio/projects/x/queue", "/api/swap-studio/projects/x/clips"]) {
    const r = await api("POST", p, {});
    check(`guest: POST ${p} gets the sign-up card`, r.status() === 401 && r.headers()["x-fuobe-guest"] === "1", String(r.status()));
  }
  const newGuest = await home("guest");
  await newGuest.click();
  await page.waitForTimeout(2000);
  check("guest: New project opens the sign-up card", (await page.getByText(/Create a free account/).count()) > 0);
  if (shots) await page.screenshot({ path: path.join(shots, "swap-guest-new.png") });
  await genjutsuBox("guest");

  // A throwaway account (signed in in this browser).
  const res = await page.request.post(`${app}/api/auth/signup`, { data: { email, password }, headers: { origin: app } });
  signedUp = res.ok();
  check("signed up a throwaway account", signedUp, String(res.status()));
  const al = await api("GET", "/api/swap-studio/projects");
  check("account: its list starts empty", al.status() === 200 && (await al.json()).items.length === 0, String(al.status()));
  const newAccount = await home("account");
  await page.getByPlaceholder(/Project name/).fill("Live check");
  await newAccount.click();
  await page.waitForURL(/\/character-swap\/[^/]+$/, { timeout: 30_000 }).catch(() => {});
  const id = page.url().split("/character-swap/")[1];
  check("account: New project opens its own project", !!id && !id.includes("?"), page.url());
  await page.waitForTimeout(2500);
  check("account: the project opens (no 'not found')", (await page.getByText("Project not found").count()) === 0);
  check("account: the clip box says 95 MB", (await page.getByText(/up to 149\.66 s and 95 MB/).count()) > 0);
  if (shots) await page.screenshot({ path: path.join(shots, "swap-account-project.png") });
  const list = await (await api("GET", "/api/swap-studio/projects")).json();
  check("account: its list has the project", list.items.some((p) => p.id === id && p.name === "Live check"));
  check("account: its project reads", (await api("GET", `/api/swap-studio/projects/${id}`)).status() === 200);
  check("account: its prices read", (await api("GET", `/api/swap-studio/projects/${id}/estimate`)).status() === 200);
  check("account: another id is not found", (await api("GET", "/api/swap-studio/projects/swap-not-mine")).status() === 404);
  const job = await api("POST", `/api/swap-studio/projects/${id}/queue`, { clipId: "c", shotId: "s", segmentId: "g", mode: "segment" });
  check("account: a job without its own GPU or key asks to connect one", job.status() === 403 && job.headers()["x-fuobe-connect-gpu"] === "1", String(job.status()));
  await genjutsuBox("account");
  const gone = await api("DELETE", `/api/swap-studio/projects/${id}`);
  check("account: deletes its project", gone.status() === 204, String(gone.status()));
  check("account: the deleted project is gone", (await api("GET", `/api/swap-studio/projects/${id}`)).status() === 404);
  // Signed out: the account's project page is no guest's.
  await context.clearCookies();
  check("guest again: an account's project id reads as 'Sign up'", (await api("GET", `/api/swap-studio/projects/${id}`)).status() === 401);
  // Signed back in for the delete below.
  const back = await page.request.post(`${app}/api/auth/login`, { data: { email, password }, headers: { origin: app } });
  check("signed back in", back.ok(), String(back.status()));
} finally {
  if (signedUp) {
    const page = context.pages()[0];
    const del = await page.request.delete(`${app}/api/auth/me`, { data: { password }, headers: { origin: app } });
    console.log(`deleted the throwaway account: ${del.status()}`);
  }
  await browser.close();
}
console.log(failures.length ? `${failures.length} failed` : "all ok");
process.exit(failures.length ? 1 : 0);
