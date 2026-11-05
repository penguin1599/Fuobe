// Storyboard for visitors, in a browser (a studio with a password and public sign-up, fuobe.com by default): a guest and a
// signed-in account see a price, never "Not available here", and Generate is on. A guest's Generate and Look ref open the
// sign-up card; an account with neither a GPU nor a key of its own gets the card that connects one. The account is a
// throwaway one this script makes and deletes. No board is made (that needs the account's own GPU or key).
// Usage: node tests/e2e/storyboard-accounts-live.mjs [appUrl] [--shots <dir>]   Exits 1 on a failed check.
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
const email = `storyboard-ui-${crypto.randomBytes(5).toString("hex")}@example.com`;
const password = crypto.randomBytes(18).toString("base64url");
let signedUp = false;
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
try {
  const page = await context.newPage();
  const card = (title) => page.getByRole("dialog").getByText(title);
  const closeCard = async () => {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  };
  const look = async (who, cards) => {
    await page.goto(`${app}/storyboard`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForTimeout(3000);
    await page.getByLabel("Your story").fill("A model in an emerald gown slips out of a palace ball at midnight and drives a vintage car to the sea");
    await page.waitForTimeout(2500);
    check(`${who}: the price never says "Not available here"`, (await page.getByText("Not available here").count()) === 0);
    const generate = page.getByRole("button", { name: "Generate storyboard" });
    check(`${who}: Generate is on`, await generate.isEnabled());
    if (shots) await page.screenshot({ path: path.join(shots, `storyboard-${who}.png`), fullPage: false });
    // Generate: the card that says what running it takes, and nothing else.
    await generate.click();
    await page.waitForTimeout(2500);
    check(`${who}: Generate opens "${cards.run}"`, (await card(cards.run).count()) > 0);
    if (shots) await page.screenshot({ path: path.join(shots, `storyboard-${who}-generate.png`) });
    await closeCard();
    // Look ref: asked first, before the file chooser.
    await page.getByRole("button", { name: "Look ref: upload" }).click();
    await page.waitForTimeout(1500);
    check(`${who}: Look ref opens "${cards.upload}"`, (await card(cards.upload).count()) > 0);
    if (shots) await page.screenshot({ path: path.join(shots, `storyboard-${who}-look-ref.png`) });
    await closeCard();
  };
  await look("guest", { run: "Create a free account to run this", upload: "Create a free account to add your own files" });

  // A throwaway account (signed in in this browser), then the same page.
  const res = await page.request.post(`${app}/api/auth/signup`, { data: { email, password }, headers: { origin: app } });
  signedUp = res.ok();
  check("signed up a throwaway account", signedUp, String(res.status()));
  await look("account", { run: /^(Connect your GPU|Add an API key) to run this$/, upload: /^Connect your GPU (or add a key )?to add your own files$/ });
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
