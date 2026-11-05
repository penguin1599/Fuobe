// Cinema Studio for visitors, in a browser (a studio with a password and public sign-up, fuobe.com by default): a guest
// sees no "Projects aren't available here" note, and New project and a ready film's Use template open the sign-up card. A
// signed-in account (a throwaway one this script makes and deletes) makes its own project, opens it, asks the AI
// Director (its breakdown, with no note about Settings), and its Generate opens the connect card (it has no GPU or key):
// no refusal after a click. Its project is deleted with the account.
// Usage: node tests/e2e/cinema-accounts-live.mjs [appUrl] [--shots <dir>]   Exits 1 on a failed check.
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
const NOTE = /aren.t available here/;
const SIGN_UP = /Create a free account/;

const browser = await launch();
const email = `cinema-ui-${crypto.randomBytes(5).toString("hex")}@example.com`;
const password = crypto.randomBytes(18).toString("base64url");
let signedUp = false;
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const shot = async (page, name) => shots && (await page.screenshot({ path: path.join(shots, `cinema-${name}.png`), fullPage: false }));
try {
  const page = await context.newPage();
  // A guest: the list, New project, a ready film's page.
  await page.goto(`${app}/cinema`, { waitUntil: "load", timeout: 60_000 });
  await page.waitForTimeout(3000);
  check("guest: no \"isn't available here\" note on /cinema", (await page.getByText(NOTE).count()) === 0);
  const newProject = page.getByRole("button", { name: "New project" }).first();
  check("guest: New project is offered", await newProject.isVisible());
  await newProject.click();
  await page.waitForTimeout(1500);
  check("guest: New project opens the sign-up card", (await page.getByText(SIGN_UP).count()) > 0);
  await shot(page, "guest-signup");
  await page.keyboard.press("Escape");
  await page.goto(`${app}/cinema/start/cinema.desert-couture`, { waitUntil: "load", timeout: 60_000 });
  await page.waitForTimeout(2500);
  check("guest: a ready film's page has no \"isn't available here\" note", (await page.getByText(NOTE).count()) === 0);
  // A ready film without its cover yet is the owner's only (its page says it isn't here): nothing more to check then.
  const shown = (await page.getByText("This starter isn't here.").count()) === 0;
  const use = page.getByRole("button", { name: /Use template/ }).first();
  if (shown) check("guest: a ready film offers Use template", (await use.count()) > 0 && (await use.isVisible()));
  else console.log("     (the ready film has no cover yet: the owner's only)");
  if (shown && (await use.count())) {
    await use.click();
    await page.waitForTimeout(2000);
    check("guest: Use template opens the sign-up card", (await page.getByText(SIGN_UP).count()) > 0);
    await page.keyboard.press("Escape");
  }

  // A throwaway account (signed in in this browser).
  const res = await page.request.post(`${app}/api/auth/signup`, { data: { email, password }, headers: { origin: app } });
  signedUp = res.ok();
  check("signed up a throwaway account", signedUp, String(res.status()));
  await page.goto(`${app}/cinema`, { waitUntil: "load", timeout: 60_000 });
  await page.waitForTimeout(3000);
  check("account: no \"isn't available here\" note on /cinema", (await page.getByText(NOTE).count()) === 0);
  await page.getByRole("button", { name: "New project" }).first().click();
  await page.getByPlaceholder("e.g. “Night Shift”").fill("Live check film");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(/\/cinema\/[A-Za-z0-9_-]+/, { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const id = /\/cinema\/([A-Za-z0-9_-]+)/.exec(new URL(page.url()).pathname)?.[1];
  check("account: New project opens its own project", !!id && (await page.getByRole("heading", { name: "Live check film" }).count()) > 0, page.url());
  check("account: no sharing or elements of the owner's library", (await page.getByLabel("Share a read-only link").count()) === 0 && (await page.getByText("My Elements").count()) === 0);
  await shot(page, "account-workspace");

  // The AI Director: a breakdown, and nothing about the studio's Settings.
  await page.getByRole("button", { name: "AI Director" }).first().click();
  await page.getByPlaceholder("Ask AI Director anything, or paste a script").fill("Generate a 4-shot storyboard for a rooftop chase at night");
  await page.getByRole("button", { name: "Send" }).click();
  await page.waitForTimeout(4000);
  check("account: the AI Director answers with shots", (await page.getByRole("button", { name: "Load into prompt bar" }).count()) >= 4);
  check("account: no note about connecting an AI helper", (await page.getByText(/connect Claude or a local model/).count()) === 0);
  await shot(page, "account-director");
  await page.getByRole("button", { name: "Load into prompt bar" }).first().click();
  await page.waitForTimeout(1000);

  // Generate with neither a GPU nor a key: the connect card, not a refusal.
  const generate = page.getByRole("button", { name: /^Generate/ }).last();
  if (await generate.isEnabled().catch(() => false)) {
    await generate.click();
    await page.waitForTimeout(3000);
    check("account: Generate opens the connect card", (await page.getByText(/Connect your GPU/).count()) > 0);
    check("account: no \"isn't available here\" after Generate", (await page.getByText(NOTE).count()) === 0);
    await shot(page, "account-generate");
    await page.keyboard.press("Escape");
  } else check("account: Generate is on once a shot is loaded", false);

  // Its list shows it; the API answers its own project.
  const list = await page.request.get(`${app}/api/cinema/projects`);
  const items = list.ok() ? (await list.json()).items : [];
  check("account: its list has its project", items.some((p) => p.id === id), String(list.status()));
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
