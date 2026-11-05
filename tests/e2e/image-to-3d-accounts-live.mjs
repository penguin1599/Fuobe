// Image to 3D for visitors, in a browser (a studio with a password and public sign-up, fuobe.com by default): a guest and
// a signed-in account see no "isn't available here" note, the photo drop and Make it 3D are on, a guest's run opens the
// sign-up card, and the run of an account with neither a GPU nor a key opens "Connect your GPU". The account is a
// throwaway one this script makes and deletes. No model is made (that needs the account's own GPU or key).
// Usage: node tests/e2e/image-to-3d-accounts-live.mjs [appUrl] [--shots <dir>]   Exits 1 on a failed check.
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
const email = `threed-ui-${crypto.randomBytes(5).toString("hex")}@example.com`;
const password = crypto.randomBytes(18).toString("base64url");
let signedUp = false;
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
try {
  const page = await context.newPage();
  const make = page.getByRole("button", { name: /Make it 3D/ });
  const look = async (who) => {
    await page.goto(`${app}/image-to-3d`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForTimeout(3000);
    check(`${who}: no "isn't available here" note`, (await page.getByText(/isn't available here/).count()) === 0);
    check(`${who}: the price never says "Not available here"`, (await page.getByText("Not available here").count()) === 0);
    const disabled = await page.locator("input[type=file]").first().isDisabled().catch(() => true);
    check(`${who}: the photo drop is on`, !disabled);
    check(`${who}: Make it 3D is on`, await make.isEnabled());
    if (shots) await page.screenshot({ path: path.join(shots, `image-to-3d-${who}.png`), fullPage: false });
  };
  /** From text: words, then Make it 3D; the card the run opens. */
  const runFromText = async (who, card, name) => {
    await page.goto(`${app}/image-to-3d?mode=text`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForTimeout(2500);
    await page.locator("#m3d-text").fill("A brass ship's lantern with a glass globe");
    await page.waitForTimeout(800);
    await make.click();
    await page.waitForTimeout(3000);
    check(`${who}: Make it 3D opens the ${name} card`, (await page.getByText(card).count()) > 0);
    if (shots) await page.screenshot({ path: path.join(shots, `image-to-3d-${who}-run.png`) });
  };

  await look("guest");
  // A guest's upload: the sign-up card, nothing uploaded.
  const input = page.locator("input[type=file]").first();
  if (await input.count()) {
    await input.setInputFiles({ name: "lamp.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a0000000d494844520000000200000002080600000072b60d240000001149444154789c63381150f11f8419600c005a940a3db632c1b20000000049454e44ae426082", "hex") });
    await page.waitForTimeout(2500);
    check("guest: adding a photo opens the sign-up card", (await page.getByText(/Create a free account/).count()) > 0);
  }
  await runFromText("guest", /Create a free account/, "sign-up");

  // A throwaway account (signed in in this browser), then the same page.
  const res = await page.request.post(`${app}/api/auth/signup`, { data: { email, password }, headers: { origin: app } });
  signedUp = res.ok();
  check("signed up a throwaway account", signedUp, String(res.status()));
  await look("account");
  await runFromText("account", /Connect your GPU/, "Connect your GPU");
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
