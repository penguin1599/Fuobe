// Genjutsu for visitors, in a browser (a studio with a password and public sign-up, fuobe.com by default): a guest and a
// signed-in account see no "isn't available here" note, the clip drop and the mode's example ("Use this example") are
// on, and the guest's upload opens the sign-up card. "Describe my character" (shown with the form, once a clip is in)
// answers a guest with the sign-up card and an account with no GPU with "connect-gpu". The account is a throwaway one
// this script makes and deletes.
// No run is started (that needs the account's own GPU or key).
// Usage: node tests/e2e/genjutsu-accounts-live.mjs [appUrl] [--shots <dir>]   Exits 1 on a failed check.
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

const browser = await launch();
const email = `genjutsu-ui-${crypto.randomBytes(5).toString("hex")}@example.com`;
const password = crypto.randomBytes(18).toString("base64url");
let signedUp = false;
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
try {
  const page = await context.newPage();
  const look = async (who) => {
    await page.goto(`${app}/genjutsu?mode=character`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForTimeout(3000);
    check(`${who}: no "isn't available here" note`, (await page.getByText("Genjutsu isn't available here.").count()) === 0);
    check(`${who}: the price never says "Not available here"`, (await page.getByText("Not available here").count()) === 0);
    const drop = page.locator("#gj-clip-drop");
    check(`${who}: the clip drop is there`, await drop.isVisible());
    const disabled = await drop.locator("input[type=file]").first().isDisabled().catch(() => false);
    check(`${who}: the clip drop is on`, !disabled);
    const use = page.locator("[data-use-example]");
    if (await use.count()) check(`${who}: Use this example is offered`, await use.first().isVisible());
    if (shots) await page.screenshot({ path: path.join(shots, `genjutsu-${who}.png`), fullPage: false });
  };
  // Describing the character: a guest gets the sign-up card; an account with no GPU is asked to connect one.
  const describeAs = (request) => request.post(`${app}/api/genjutsu/describe`, { data: { engine: "open", image: "/api/files/x.png" }, headers: { origin: app }, failOnStatusCode: false });
  await look("guest");
  const guestDescribe = await describeAs(page.request);
  check("guest: describing answers the sign-up card", guestDescribe.status() === 401 && guestDescribe.headers()["x-fuobe-guest"] === "1", String(guestDescribe.status()));
  // A guest's upload: the sign-up card, nothing uploaded.
  const input = page.locator("#gj-clip-drop input[type=file]").first();
  if (await input.count()) {
    await input.setInputFiles({ name: "clip.mp4", mimeType: "video/mp4", buffer: fs.readFileSync(new URL("../fixtures/shorts-12s.mp4", import.meta.url)) });
    await page.waitForTimeout(2500);
    check("guest: adding a clip opens the sign-up card", (await page.getByText(/Create a free account/).count()) > 0);
    if (shots) await page.screenshot({ path: path.join(shots, "genjutsu-guest-upload.png") });
  }

  // A throwaway account (signed in in this browser), then the same page.
  const res = await page.request.post(`${app}/api/auth/signup`, { data: { email, password }, headers: { origin: app } });
  signedUp = res.ok();
  check("signed up a throwaway account", signedUp, String(res.status()));
  await look("account");
  const accountDescribe = await describeAs(page.request);
  const answer = await accountDescribe.json().catch(() => ({}));
  check("account without a GPU: describing asks to connect one", accountDescribe.status() === 403 && answer.code === "connect-gpu", `${accountDescribe.status()} ${answer.code ?? ""}`);
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
