// The public Canvas, as a guest, a fresh account and the owner, at 390 and 1440 px: "Use this board" opens a ready board
// in the editor with its nodes, links and example film; "New canvas" opens a blank one; a guest's change is kept in the
// browser (it survives a reload at /canvas/draft/<id>) and Save offers an account; an account saves to its account
// (/canvas/saved/<id>), reopens it after a reload, renames and deletes it from /canvas; Run on a visitor's board says
// what running needs and never runs; the owner's "Use this board" makes a studio board. Then the previews: each Canvas
// preview plays its effect's whole clip (currentTime passes 2 s and comes back round: it loops), on /canvas, on a
// board's page and on the board's last step in the editor.
//
// node tests/e2e/canvas-public.mjs <app address> <owner password> [screenshot folder]
// Against `next start` with a fresh data dir, FUOBE_PUBLIC_SIGNUP=1 and COMFYUI_URL pointing at nothing.
import fs from "node:fs";
import path from "node:path";
import { launch, PHONE, DESKTOP } from "./_browser.mjs";

const [app, password, shots] = process.argv.slice(2);
if (!app || !password) throw new Error("usage: node tests/e2e/canvas-public.mjs <app address> <owner password> [screenshot folder]");
if (shots) fs.mkdirSync(shots, { recursive: true });

const BOARD = "effect-chain-pearl-earring";
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
};

async function signIn(ctx, persona) {
  if (persona === "owner") {
    const r = await ctx.request.post(`${app}/api/auth/login`, { data: { password } });
    if (!r.ok()) throw new Error(`owner login ${r.status()}`);
  } else if (persona === "account") {
    const email = `canvas-public-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
    const r = await ctx.request.post(`${app}/api/auth/signup`, { data: { email, password: "canvas-public-pw-123" } });
    if (!r.ok()) throw new Error(`signup ${r.status()}`);
  }
}

/** Every <video> in `scope` sampled for `ms`: the largest time reached, and whether it came back round (a loop). */
async function playback(page, selector, ms = 9000) {
  const seen = new Map();
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const now = await page.evaluate((sel) => [...document.querySelectorAll(sel)].map((v) => ({ src: (v.currentSrc || v.src).split("?")[0].split("/").pop(), t: v.currentTime, d: v.duration })), selector);
    for (const v of now) {
      const s = seen.get(v.src) ?? { max: 0, last: 0, loops: 0, d: v.d };
      if (v.t + 0.5 < s.last) s.loops++;
      s.max = Math.max(s.max, v.t);
      s.last = v.t;
      s.d = v.d;
      seen.set(v.src, s);
    }
    await page.waitForTimeout(200);
  }
  return [...seen.entries()].map(([src, s]) => ({ src, ...s }));
}

const browser = await launch();
try {
  for (const persona of ["guest", "account", "owner"]) {
    for (const [size, device] of [
      ["1440", DESKTOP],
      ["390", PHONE],
    ]) {
      const tag = `${persona} ${size}`;
      const phone = size === "390";
      const ctx = await browser.newContext({ ...device, colorScheme: size === "390" ? "dark" : "light" });
      await signIn(ctx, persona);
      const page = await ctx.newPage();
      page.setDefaultTimeout(30_000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(`${page.url()} :: ${String(e).slice(0, 200)}`));
      page.on("console", (m) => m.type() === "error" && /hydrat/i.test(m.text()) && errors.push(`hydration: ${m.text().slice(0, 200)}`));
      const runs = [];
      page.on("request", (r) => /\/api\/(canvases\/[^/]+\/run|generations)$/.test(new URL(r.url()).pathname) && r.method() === "POST" && runs.push(r.url()));
      const shot = async (name) => shots && page.screenshot({ path: path.join(shots, `${name}--${persona}--${size}.png`) });
      const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

      // ---- /canvas: every ready board's action opens it in the editor
      await page.goto(`${app}/canvas`, { waitUntil: "load", timeout: 180_000 });
      await page.getByRole("heading", { name: persona === "owner" ? "Canvas" : "What's a canvas?", exact: true }).first().waitFor();
      await page.waitForTimeout(1200);
      if (persona !== "owner") {
        const use = page.locator(`#templates article a[href='/canvas/try/${BOARD}']`);
        check(`${tag}: a ready board's card says Use this board`, (await use.count()) === 1 && /Use this board/.test(await use.innerText()));
        check(`${tag}: New canvas opens a blank board`, (await page.getByRole("link", { name: "New canvas" }).getAttribute("href")) === "/canvas/try/blank");
        await use.click();
      } else {
        await page.goto(`${app}/canvas/try/${BOARD}`, { waitUntil: "load" });
      }

      // ---- The board in the editor
      if (persona === "owner") {
        await page.waitForURL(/\/canvas\/(?!try|start|draft|saved)[^/?]+$/, { timeout: 60_000 });
        await page.getByText("Set the scene").first().waitFor({ timeout: 60_000 });
        check(`${tag}: the owner's Use this board makes a studio board`, (await page.getByRole("button", { name: /^Run all$/ }).count()) === 1);
        await shot("owner-board");
        check(`${tag}: no page errors`, errors.length === 0, errors[0]);
        await ctx.close();
        continue;
      }
      await page.waitForURL(new RegExp(`/canvas/try/${BOARD}$`));
      await page.getByText("Set the scene").first().waitFor({ timeout: 60_000 });
      const nodes = await page.locator(".react-flow__node").count();
      const edges = await page.locator(".react-flow__edge").count();
      if (!phone) check(`${tag}: the board opens with all its nodes and links`, nodes >= 4 && edges >= 3, `${nodes} nodes, ${edges} links`);
      else check(`${tag}: the phone shows the board and says where to wire new steps`, nodes >= 4 && (await page.locator("[data-phone-note]").count()) === 1, `${nodes} nodes`);
      const exampleImgs = await page.locator(".react-flow__node img[src*='/examples/'], .react-flow__node img[src*='/previews/'], .react-flow__node video").count();
      check(`${tag}: the board shows its own example photo and film`, exampleImgs >= 2, `${exampleImgs}`);
      // A visitor's board doesn't run here: its film says Example, and no step names a price, a GPU or a run state.
      const nodeText = (await page.locator(".react-flow__node").allInnerTexts()).join(" | ");
      const header = await page.locator("header").filter({ has: page.locator("[data-visitor-run]") }).innerText();
      check(`${tag}: the film says Example, with no price or run state`, /\bExample\b/.test(nodeText) && !/your GPU|Inputs changed|≈ \$/.test(nodeText) && !/to run/.test(header), header.replace(/\s+/g, " ").slice(0, 120));
      check(`${tag}: no sideways scroll in the editor`, (await sideways()) <= 1, `${await sideways()} px`);
      await shot("try-board");

      // The film on its last step plays its whole clip.
      if (!phone) {
        const vid = page.locator(".react-flow__node video").first();
        if (await vid.count()) {
          await vid.evaluate((v) => {
            v.muted = true;
            v.loop = true;
            return v.play();
          }).catch(() => {});
          const p = await playback(page, ".react-flow__node video", 6000);
          check(`${tag}: the board's example film plays past 2 s`, p.some((x) => x.max > 2), JSON.stringify(p.map((x) => [x.src, +x.max.toFixed(2), +x.d.toFixed(2)])));
        }
      }

      // ---- Run says what running needs, and never runs
      await page.locator("[data-visitor-run]").click();
      await page.getByRole("heading", { name: "Running a board isn't available here" }).waitFor();
      const dlg = await page.getByRole("dialog").innerText();
      check(`${tag}: Run says plainly what it needs, with the one-step effect`, /Video studio/.test(dlg) && (await page.getByRole("dialog").getByRole("link", { name: /Try this effect in Video/ }).count()) === 1);
      check(`${tag}: a guest's Run dialog offers an account`, persona !== "guest" || /Sign up to save boards/.test(dlg));
      await shot("run-needs");
      await page.keyboard.press("Escape");

      // ---- A change keeps the board (in this browser, at /canvas/draft/<id>)
      const nameField = page.getByRole("textbox", { name: "Canvas name" });
      await nameField.fill(`My pearl ${persona} ${size}`);
      await nameField.press("Enter");
      if (phone) {
        await page.getByRole("tab", { name: "Nodes" }).click();
        const field = page.locator("[data-testid^='canvas-card-'] textarea").first();
        await field.fill("A pearl earring, warm window light, a soft smile");
      } else {
        const field = page.locator(".react-flow__node textarea").first();
        await field.fill("A pearl earring, warm window light, a soft smile");
      }
      await page.waitForURL(/\/canvas\/draft\/[^/]+$/, { timeout: 10_000 });
      await page.waitForTimeout(1500);
      const draftUrl = page.url();
      check(`${tag}: the first change keeps the board at /canvas/draft/<id>`, /\/canvas\/draft\//.test(draftUrl), draftUrl);
      await page.reload({ waitUntil: "load" });
      await page.getByText("Set the scene").first().waitFor({ timeout: 60_000 });
      if (phone) await page.getByRole("tab", { name: "Nodes" }).click();
      const kept = await page.locator(phone ? "[data-testid^='canvas-card-'] textarea" : ".react-flow__node textarea").first().inputValue();
      check(`${tag}: the draft survives a reload`, /warm window light/.test(kept) && (await nameField.inputValue()) === `My pearl ${persona} ${size}`, kept.slice(0, 60));
      await shot("draft-reloaded");

      if (persona === "guest") {
        await page.locator("[data-visitor-save]").click();
        await page.getByRole("heading", { name: "Keep this board in an account" }).waitFor();
        const href = await page.getByRole("dialog").getByRole("link", { name: "Sign up" }).getAttribute("href");
        check(`${tag}: Save offers an account and comes back to this board`, /signup=1/.test(href ?? "") && /canvas%2Fdraft/.test(href ?? ""), href);
        await shot("guest-save");
        await page.keyboard.press("Escape");
        await page.goto(`${app}/canvas`, { waitUntil: "load" });
        await page.getByRole("heading", { name: "Your canvases" }).waitFor();
        check(`${tag}: the draft is listed under Your canvases`, (await page.locator("[data-visitor-board='browser']", { hasText: `My pearl ${persona} ${size}` }).count()) === 1);
        await shot("guest-list");
        // Renamed in the list, the draft opens with its new name.
        const dcard = page.locator("[data-visitor-board='browser']", { hasText: `My pearl ${persona} ${size}` });
        await dcard.getByRole("button", { name: /^Actions for/ }).click();
        await page.getByRole("menuitem", { name: "Rename" }).click();
        await page.getByRole("dialog").getByRole("textbox").fill(`Draft renamed ${size}`);
        await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
        const rcard = page.locator("[data-visitor-board='browser']", { hasText: `Draft renamed ${size}` });
        await rcard.waitFor();
        await rcard.locator("a").first().click();
        await page.waitForURL(/\/canvas\/draft\/[^/]+$/);
        await page.getByText("Set the scene").first().waitFor({ timeout: 60_000 });
        check(`${tag}: a draft renamed in the list opens with its new name`, (await nameField.inputValue()) === `Draft renamed ${size}`, await nameField.inputValue());
        await page.goto(`${app}/canvas`, { waitUntil: "load" });
        await page.getByRole("heading", { name: "Your canvases" }).waitFor();
        // A guest can't read or write anyone's saved canvases.
        // (Asked outside the page: a refused fetch in the page opens the sign-up card.)
        const api = [(await page.request.get(`${app}/api/account/canvases`)).status(), (await page.request.post(`${app}/api/account/canvases`, { data: {} })).status(), (await page.request.get(`${app}/api/canvases`)).status()];
        check(`${tag}: a guest gets 401 from the account canvases`, api[0] === 401 && api[1] === 401, JSON.stringify(api));
        // Start blank.
        await page.getByRole("link", { name: "New canvas" }).click();
        await page.waitForURL(/\/canvas\/try\/blank$/);
        await page.getByText(/Wire models together/).waitFor();
        check(`${tag}: New canvas opens an empty editor`, (await page.locator(".react-flow__node").count()) === 0);
        await shot("blank");
      } else {
        // ---- An account saves it to its account, reopens it, renames and deletes it
        // An edit just before Save (still waiting to be kept) goes with it, and leaves no second board in this browser.
        const field = page.locator(phone ? "[data-testid^='canvas-card-'] textarea" : ".react-flow__node textarea").first();
        await field.fill("A pearl earring, saved at once");
        await page.locator("[data-visitor-save]").click();
        await page.waitForURL(/\/canvas\/saved\/[^/]+$/, { timeout: 20_000 });
        await page.getByText("Set the scene").first().waitFor({ timeout: 60_000 });
        await page.waitForTimeout(1500);
        const savedUrl = page.url();
        if (phone) await page.getByRole("tab", { name: "Nodes" }).click();
        check(`${tag}: Save to account takes the last edit and stays on the saved board`, /\/canvas\/saved\//.test(page.url()) && /saved at once/.test(await field.inputValue()), page.url());
        await field.fill("A pearl earring, saved to my account");
        await page.waitForTimeout(2000);
        await page.reload({ waitUntil: "load" });
        await page.getByText("Set the scene").first().waitFor({ timeout: 60_000 });
        if (phone) await page.getByRole("tab", { name: "Nodes" }).click();
        check(`${tag}: a saved board reopens with its changes`, /saved to my account/.test(await page.locator(phone ? "[data-testid^='canvas-card-'] textarea" : ".react-flow__node textarea").first().inputValue()), savedUrl);
        await shot("saved-board");
        await page.goto(`${app}/canvas`, { waitUntil: "load" });
        await page.getByRole("heading", { name: "Your canvases" }).waitFor();
        const card = page.locator("[data-visitor-board='account']", { hasText: `My pearl ${persona} ${size}` });
        await card.waitFor();
        check(`${tag}: the saved board is listed, and its draft is gone`, (await card.count()) === 1 && (await page.locator("[data-visitor-board='browser']", { hasText: `My pearl ${persona} ${size}` }).count()) === 0);
        await shot("account-list");
        await card.getByRole("button", { name: /^Actions for/ }).click();
        await page.getByRole("menuitem", { name: "Rename" }).click();
        await page.getByRole("dialog").getByRole("textbox").fill(`Renamed ${size}`);
        await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
        await page.locator("[data-visitor-board='account']", { hasText: `Renamed ${size}` }).waitFor();
        await page.reload({ waitUntil: "load" });
        const renamed = page.locator("[data-visitor-board='account']", { hasText: `Renamed ${size}` });
        await renamed.waitFor();
        check(`${tag}: rename sticks`, (await renamed.count()) === 1);
        await renamed.getByRole("button", { name: /^Actions for/ }).click();
        await page.getByRole("menuitem", { name: "Delete" }).click();
        await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
        await page.waitForTimeout(1500);
        await page.reload({ waitUntil: "load" });
        await page.waitForTimeout(2500);
        check(`${tag}: delete removes it`, (await page.locator("[data-visitor-board='account']", { hasText: `Renamed ${size}` }).count()) === 0);
        // The owner's canvases stay closed to an account.
        const api = [(await page.request.post(`${app}/api/canvases`, { data: {} })).status()];
        check(`${tag}: an account can't make the owner's canvases`, api[0] === 403, JSON.stringify(api));
      }
      check(`${tag}: nothing was sent to run`, runs.length === 0, runs[0]);

      // ---- Previews play the whole effect: the board's page (hover), and /canvas (by itself)
      if (!phone) {
        await page.goto(`${app}/canvas/start/${BOARD}`, { waitUntil: "load" });
        await page.getByRole("heading", { name: "What goes in" }).waitFor();
        await page.locator(".aspect-\\[16\\/9\\]").first().hover();
        const p = await playback(page, "video", 10_000);
        const film = p.find((x) => /effect-pearl-earring/.test(x.src));
        check(`${tag}: the board's page plays the whole effect, looping`, !!film && film.max > 3 && film.loops >= 1 && film.d >= 3.9, JSON.stringify(film));
      }
      check(`${tag}: no page errors`, errors.length === 0, errors[0]);
      await ctx.close();
    }
  }

  // ---- /canvas cards play by themselves, the whole clip (a fresh guest, a wide screen)
  const ctx = await browser.newContext({ ...DESKTOP });
  const page = await ctx.newPage();
  await page.goto(`${app}/canvas`, { waitUntil: "load" });
  await page.locator("#templates").scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  const p = await playback(page, "#templates video", 10_000);
  check("guest 1440: the board cards play their whole clips, looping", p.length > 0 && p.every((x) => x.max > 2) && p.some((x) => x.loops >= 1), JSON.stringify(p.map((x) => [x.src, +x.max.toFixed(2), x.loops])));
  await ctx.close();
} finally {
  await browser.close();
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
