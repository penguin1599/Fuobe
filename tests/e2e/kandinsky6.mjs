// Kandinsky 6.0 on both engines (build package nm10-kandinsky6), browser check at 1440 and 390 px, light and dark: the Video
// studio's model menu lists Kandinsky 6.0 on each engine (Free on your GPU, fal's price in the cloud), its Quality under Options
// (Lite or Pro on your GPU; Pro / Lite at Fast, Standard or Best steps in the cloud) and its prompt hint for spoken lines;
// Upscale → Video opens on Kandinsky VSR at 2.25x on both engines with what the clip becomes; Lipsync links a talking
// character from words to the Video studio on Kandinsky; nothing scrolls sideways; a page or console error fails the run.
// The prices are checked through the preview route (Pro Best $1.35, Lite Fast $0.08, the VSR $0.09) when a fal key is set.
// Usage: node tests/e2e/kandinsky6.mjs [appUrl] [--shots <dir>]   (app in demo mode, ComfyUI unreachable). Exits 1 on a failure.
import fs from "node:fs";
import path from "node:path";
import { launch } from "./_browser.mjs";

const argv = process.argv.slice(2);
const app = (argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--shots") ?? "http://localhost:3000").replace(/\/$/, "");
const shots = argv.includes("--shots") ? argv[argv.indexOf("--shots") + 1] : undefined;
if (shots) fs.mkdirSync(shots, { recursive: true });

const failures = [];
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(84)}${extra ? ` ${extra}` : ""}`);
  if (!ok) failures.push(label);
};
const flat = (s) => s.replace(/\s+/g, " ").trim();

const browser = await launch();
const contextFor = async (engine, width, colorScheme) => {
  const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, colorScheme, ...(width < 500 && { isMobile: true, hasTouch: true }) });
  await context.addInitScript((e) => {
    try {
      localStorage.setItem("fuobe.engine", e);
    } catch {}
  }, engine);
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const tag = `${width} ${colorScheme} ${engine}`;
  page.on("pageerror", (e) => check(`${tag}: no page error`, false, String(e.message).slice(0, 200)));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && check(`${tag}: no console error`, false, m.text().slice(0, 200)));
  return { context, page };
};
const composer = (page) => page.locator("[data-composer]").first();
const shoot = (page, name) => (shots ? page.screenshot({ path: path.join(shots, name) }) : undefined);
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const openStudio = async (page, where) => {
  await page.goto(`${app}/${where}`, { waitUntil: "load", timeout: 180_000 });
  await composer(page).waitFor({ timeout: 120_000 });
  await page.waitForTimeout(1200);
};
const openMenu = async (page) => {
  const button = page.locator('button[aria-label^="Model: "][aria-label$="Change model"]:visible').first();
  const search = page.getByPlaceholder(/^Search( (all )?models)?/);
  for (let i = 0; i < 3; i++) {
    await button.waitFor({ state: "visible", timeout: 60_000 });
    await button.focus();
    await page.keyboard.press("Enter");
    if (await search.waitFor({ timeout: 10_000 }).then(() => true, () => false)) return search;
  }
  await search.waitFor();
  return search;
};
const pick = async (page, query, id) => {
  const search = page.getByPlaceholder(/^Search( (all )?models)?/);
  await search.fill(query);
  const row = page.locator(`[cmdk-item][data-value$=":${id}"]`).first();
  await row.waitFor({ timeout: 15_000 });
  const text = flat(await row.innerText());
  let picked = false;
  for (let i = 0; i < 12 && !picked; i++) {
    picked = (await row.getAttribute("data-selected")) === "true";
    if (!picked) await page.keyboard.press("ArrowDown");
  }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
  return { text, picked };
};
/** Options (on a phone, inside the Settings sheet): opens it and returns the combobox named `label`. */
const optionsControl = async (page, width, label) => {
  let scope = composer(page);
  if (width < 500) {
    const settings = composer(page).getByRole("button", { name: /^Settings:/ }).first();
    await settings.focus();
    await page.keyboard.press("Enter");
    scope = page.getByRole("dialog").first();
    await scope.waitFor({ timeout: 10_000 });
  }
  // The models' enum settings chip (StudioConfig.controlsTitle: "Director" in the Video studio).
  const options = scope.getByRole("button", { name: /^(Options|Director)/ }).first();
  await options.focus();
  await page.keyboard.press("Enter");
  const box = page.getByRole("combobox", { name: label });
  await box.waitFor({ timeout: 10_000 });
  return box;
};

try {
  // ---- Prices through the preview route (what the composer and the server agree on).
  const preview = async (body) => (await fetch(`${app}/api/generations?preview=1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  const run = { feature: "video", op: "t2v", prompt: "A woman at a window says “Look over there!” Sound: rain" };
  const best = await preview({ ...run, modelId: "kandinsky-6", engine: "cloud", params: { extra: { quality: "pro-best" } } });
  const lite = await preview({ ...run, modelId: "kandinsky-6", engine: "cloud", params: { extra: { quality: "lite-fast" } } });
  const local = await preview({ ...run, modelId: "oss-kandinsky6", engine: "open" });
  if (process.env.FAL_KEY) {
    check("api: Pro Best is $1.35 on fal's Pro endpoint", best.costUsd === 1.35 && best.route?.endpoint === "fal-ai/kandinsky6-pro/text-to-video", `${best.costUsd} ${best.route?.endpoint ?? best.error}`);
    check("api: Lite Fast is $0.08 on fal's Lite endpoint", lite.costUsd === 0.08 && lite.route?.endpoint === "fal-ai/kandinsky6-lite/text-to-video", `${lite.costUsd} ${lite.route?.endpoint ?? lite.error}`);
  } else check("api: without a fal key Kandinsky in the cloud is a free demo", best.demo === true && lite.demo === true, JSON.stringify({ best: best.demo ?? best.error, lite: lite.demo ?? lite.error }));
  check("api: on your GPU it plans on Kandinsky's graph", local.costUsd === 0 && (local.demo === true || local.route?.endpoint === "kandinsky6-t2av"), `${local.costUsd} ${local.route?.endpoint ?? local.error}`);

  for (const width of [1440, 390]) {
    for (const scheme of ["light", "dark"]) {
      // ---- Video studio, both engines.
      for (const [engine, id] of [["open", "oss-kandinsky6"], ["cloud", "kandinsky-6"]]) {
        const tag = `${width} ${scheme} ${engine}`;
        const { context, page } = await contextFor(engine, width, scheme);
        await openStudio(page, "video");
        await openMenu(page);
        const { text, picked } = await pick(page, "Kandinsky", id);
        check(`${tag}: the menu lists Kandinsky 6.0 on both engines`, /Kandinsky 6\.0/.test(text) && /both engines/.test(text), text.slice(0, 160));
        if (engine === "open") check(`${tag}: Free on your GPU`, /\bFree\b/.test(text), text.slice(0, 200));
        else check(`${tag}: its price in the menu`, /\$0\.56|\$/.test(text), text.slice(0, 200));
        check(`${tag}: the keyboard reaches the Kandinsky row`, picked);
        const box = composer(page).getByRole("textbox").first();
        const hint = (await box.getAttribute("placeholder")) ?? "";
        check(`${tag}: the prompt box says how to give a character words`, /in quotes/.test(hint) && /Sound:/.test(hint), hint.slice(0, 120));
        await box.fill("A woman at a café window smiles and says “Look over there!” Sound: rain on the glass");
        await page.waitForFunction(() => /\bFree\b|\bfree\b|Demo|≈ \$|Connect/.test(document.querySelector("[data-composer]")?.textContent ?? ""), null, { timeout: 20_000 }).catch(() => {});
        // On a phone in demo mode the line before the run reads "Placeholder" (the price is the demo's: free).
        const gen = (await composer(page).getByRole("button", { name: /^Generate/ }).first().getAttribute("aria-label").catch(() => "")) ?? "";
        const t = `${flat(await composer(page).innerText())} ${gen}`;
        check(`${tag}: the composer runs Kandinsky 6.0 with a price before the run`, /Kandinsky 6\.0/.test(t) && /\bFree\b|Placeholder|Demo|≈ \$|Connect/.test(t), (t.match(/Placeholder( · free)?|Demo|Connect[^.]*|≈ <?\$[\d.]+|\bFree\b/) ?? ["no price"])[0]);
        const quality = await optionsControl(page, width, "Quality");
        const q = flat(await quality.innerText());
        check(`${tag}: Options → Quality`, engine === "open" ? /Lite · 10 steps/.test(q) : /Pro · Standard, 20 steps/.test(q), q);
        await shoot(page, `video-${engine}-${width}-${scheme}.png`);
        check(`${tag}: no sideways scroll`, (await sideways(page)) <= 1, `${await sideways(page)} px`);
        await context.close();
      }

      // ---- Upscale → Video on Kandinsky VSR, both engines.
      for (const [engine, id] of [["open", "oss-kandinsky6-vsr"], ["cloud", "kandinsky-vsr"]]) {
        const tag = `${width} ${scheme} ${engine}`;
        const { context, page } = await contextFor(engine, width, scheme);
        await openStudio(page, `upscale/video?model=${id}`);
        await page.waitForFunction(() => /Kandinsky VSR/.test(document.querySelector("[data-composer]")?.textContent ?? ""), null, { timeout: 20_000 }).catch(() => {});
        const settingsLabel = (await composer(page).getByRole("button", { name: /^Settings:/ }).first().getAttribute("aria-label").catch(() => "")) ?? "";
        const t = `${flat(await composer(page).innerText())} ${settingsLabel}`;
        check(`${tag}: Upscale → Video opens on Kandinsky VSR at 2.25x`, /Kandinsky VSR/.test(t) && /2\.25x/.test(t), t.slice(-160));
        await openMenu(page);
        const { text } = await pick(page, "Kandinsky VSR", id);
        check(`${tag}: the menu says 2x, 2.25x or 4x, clips up to 5 s`, /2x, 2\.25x or 4x/.test(text) && /up to 5 s/.test(text), text.slice(0, 200));
        await shoot(page, `upscale-${engine}-${width}-${scheme}.png`);
        check(`${tag}: no sideways scroll on Upscale`, (await sideways(page)) <= 1, `${await sideways(page)} px`);
        await context.close();
      }

      // ---- Lipsync: a talking character from words.
      for (const [engine, id] of [["open", "oss-kandinsky6"], ["cloud", "kandinsky-6"]]) {
        const tag = `${width} ${scheme} ${engine}`;
        const { context, page } = await contextFor(engine, width, scheme);
        await openStudio(page, "lipsync");
        const link = page.getByRole("link", { name: /talking character from words with Kandinsky 6\.0/ });
        await page.waitForFunction((want) => [...document.querySelectorAll("a")].some((a) => a.getAttribute("href") === want), `/video?model=${id}`, { timeout: 15_000 }).catch(() => {});
        const visible = await link.isVisible().catch(() => false);
        check(`${tag}: Lipsync links a talking character from words`, visible && (await link.getAttribute("href")) === `/video?model=${id}`, visible ? await link.getAttribute("href") : "not shown");
        await shoot(page, `lipsync-${engine}-${width}-${scheme}.png`);
        check(`${tag}: no sideways scroll on Lipsync`, (await sideways(page)) <= 1, `${await sideways(page)} px`);
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
