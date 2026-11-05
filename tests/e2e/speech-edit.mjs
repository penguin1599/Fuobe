// Browser check of Audio → Edit speech (nm10-speech-edit) and Captions' "Fix this line".
// Usage: node tests/e2e/speech-edit.mjs [appUrl] [outDir]
//   appUrl: the app in demo mode (FUOBE_DEMO_MODE=on, no keys, COMFYUI_URL pointing at nothing), signed in as the owner.
// Checks, at 1440 px and 390 px in light and dark: the tool's heading and its Audio tab; a recording added, transcribed
// (demo lines), one line's words changed, the price before running ("Demo · free" / "Free · runs on your GPU"), the run
// and its Original / Edited player; "How it sounds" with a picked line and an effect; the cloud engine saying it runs on
// your GPU; Captions' "Fix this line" opening Edit speech on that line of the clip; no sideways scroll. Screenshots go to
// outDir. A page error or a console error fails the run.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DESKTOP, PHONE, launch, openRoute } from "./_browser.mjs";

const app = process.argv[2] ?? "http://localhost:3000";
const out = process.argv[3] ?? fs.mkdtempSync("/tmp/fuobe-speech-edit-");
fs.mkdirSync(out, { recursive: true });

const wav = path.join(out, "speech-source.wav");
const mp4 = path.join(out, "speech-source.mp4");
const ff = (a) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a]);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
};
ff(["-f", "lavfi", "-i", "aevalsrc=0.25*gt(sin(2*PI*1.5*t)\\,0)*(sin(2*PI*180*t)+0.4*sin(2*PI*360*t)):s=44100:d=10", wav]);
ff(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=10", "-i", wav, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", mp4]);

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures.push(what);
};
const noSideScroll = async (page, label) => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(over <= 0, `${label}: no horizontal scroll (${over}px)`);
};
async function setup(browser, device, theme, engine) {
  const ctx = await browser.newContext({ ...device, colorScheme: theme });
  ctx.on("page", (p) => {
    p.on("pageerror", (e) => check(false, `${engine} ${theme}: no page error (${String(e.message).slice(0, 160)})`));
    p.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && check(false, `${engine} ${theme}: no console error (${m.text().slice(0, 160)})`));
  });
  await ctx.addInitScript(
    ([e]) => {
      try {
        localStorage.setItem("fuobe.engine", e);
      } catch {}
    },
    [engine],
  );
  await ctx.route((u) => u.origin !== new URL(app).origin && /^https?:$/.test(u.protocol), (r) => r.abort());
  return ctx;
}

/** Add the recording and transcribe it (demo lines). */
async function transcribed(page, file = wav) {
  await page.locator('input[type="file"]').first().setInputFiles(file);
  const go = page.getByRole("button", { name: "Transcribe", exact: true });
  await go.waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => ![...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Transcribe")?.disabled, null, { timeout: 30_000 });
  await go.click();
  await page.getByLabel("Words of line 1").waitFor({ timeout: 60_000 });
}

const browser = await launch();
try {
  // 1440 light, open engine: change a word, run, hear Original / Edited; then How it sounds.
  {
    const ctx = await setup(browser, DESKTOP, "light", "open");
    const page = await ctx.newPage();
    await openRoute(page, `${app}/audio/edit-speech`);
    check(await page.getByRole("heading", { name: "Edit speech" }).isVisible(), "1440: the tool's heading");
    check(await page.getByRole("link", { name: "Edit speech" }).first().isVisible(), "1440: the Audio tab");
    // After hydration: a screenshot hides the text caret on inputs, which would read as a server/client mismatch.
    await page.waitForFunction(() => document.querySelector("input[type=file]") && Object.keys(document.querySelector("input[type=file]")).some((k) => k.startsWith("__react")), null, { timeout: 30_000 });
    await page.screenshot({ path: `${out}/edit-1440-light-empty.png`, fullPage: true });
    await transcribed(page);
    const line = page.getByLabel("Words of line 1");
    const before = await line.inputValue();
    await line.fill(before.replace(/demo/i, "sample"));
    check(await page.getByText(before, { exact: true }).isVisible(), "1440: the old words shown struck through under the change");
    const bar = page.locator("p[aria-live=polite]").last();
    await page.getByText(/Demo · free|Free · runs on your GPU/).first().waitFor({ timeout: 20_000 });
    check(/Demo · free|Free · runs on your GPU/.test(await bar.innerText()), `1440: a price before running (${(await bar.innerText()).slice(0, 80)})`);
    check(await page.getByText(/re-spoken by AuK in the same voice/).isVisible(), "1440: what the run will do");
    check(await page.getByText(/Prompt Enhancer/).isVisible(), "1440: the Prompt Enhancer's language model stated");
    await page.screenshot({ path: `${out}/edit-1440-light-words.png`, fullPage: true });
    await page.getByRole("button", { name: "Edit speech", exact: true }).click();
    await page.getByText("Original and edited").waitFor({ timeout: 60_000 });
    check(true, "1440: the edit ran and the Original / Edited player shows");
    await noSideScroll(page, "1440 light");
    await page.screenshot({ path: `${out}/edit-1440-light-result.png`, fullPage: true });
    // How it sounds: tick a line, pick an effect.
    await page.getByRole("radio", { name: "How it sounds" }).click();
    await page.getByLabel("Pick line 2").click();
    await page.getByRole("radio", { name: "Emotion" }).click();
    await page.getByRole("radio", { name: "Calm" }).click();
    await page.getByText(/One part of the recording changed/).waitFor({ timeout: 20_000 });
    check(true, "1440: an effect on a picked line is priced");
    await page.screenshot({ path: `${out}/edit-1440-light-sound.png`, fullPage: true });
    await ctx.close();
  }
  // 1440 dark, cloud engine: runs on your GPU, with the switch.
  {
    const ctx = await setup(browser, DESKTOP, "dark", "cloud");
    const page = await ctx.newPage();
    await openRoute(page, `${app}/audio/edit-speech`);
    await page.locator('input[type="file"]').first().setInputFiles(wav);
    await page.getByText("Edit speech runs on your GPU (open source).").waitFor({ timeout: 30_000 });
    check(await page.getByRole("button", { name: "Use open source" }).isVisible(), "1440 dark cloud: says it runs on your GPU, offers the open engine");
    await noSideScroll(page, "1440 dark");
    await page.screenshot({ path: `${out}/edit-1440-dark-cloud.png`, fullPage: true });
    await ctx.close();
  }
  // 390 px, light and dark.
  for (const theme of ["light", "dark"]) {
    const ctx = await setup(browser, PHONE, theme, "open");
    const page = await ctx.newPage();
    await openRoute(page, `${app}/audio/edit-speech`);
    await noSideScroll(page, `390 ${theme} empty`);
    await transcribed(page);
    await page.getByLabel("Words of line 2").fill("Connect a speech provider in Settings,");
    await page.getByText(/Demo · free|Free · runs on your GPU/).first().waitFor({ timeout: 20_000 });
    await noSideScroll(page, `390 ${theme}`);
    await page.screenshot({ path: `${out}/edit-390-${theme}.png`, fullPage: true });
    await ctx.close();
  }
  // Captions: Fix this line opens Edit speech on that line of the clip, at both widths.
  for (const [device, w, theme] of [
    [DESKTOP, 1440, "light"],
    [PHONE, 390, "dark"],
  ]) {
    const ctx = await setup(browser, device, theme, "open");
    const page = await ctx.newPage();
    await openRoute(page, `${app}/video-tools/captions`);
    await page.locator('input[type="file"]').first().setInputFiles(mp4);
    const go = page.getByRole("button", { name: /Transcribe the speech/ });
    await go.waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => ![...document.querySelectorAll("button")].find((b) => /Transcribe the speech/.test(b.textContent ?? ""))?.disabled, null, { timeout: 30_000 });
    await go.click();
    const fix = page.getByRole("button", { name: "Fix this line: change what was said (line 2)" });
    await fix.waitFor({ timeout: 60_000 });
    await noSideScroll(page, `${w} ${theme} captions`);
    await page.screenshot({ path: `${out}/captions-${w}-${theme}.png`, fullPage: true });
    await fix.click();
    await page.waitForURL(/\/audio\/edit-speech\?video=.*from=handoff/, { timeout: 30_000 });
    const focused = page.getByLabel("Words of line 2");
    await focused.waitFor({ timeout: 30_000 });
    check(await focused.evaluate((el) => el === document.activeElement), `${w} ${theme}: Fix this line opens Edit speech with line 2 in focus`);
    check(await page.locator("video").first().isVisible(), `${w} ${theme}: the clip came along`);
    await noSideScroll(page, `${w} ${theme} handoff`);
    await page.screenshot({ path: `${out}/fix-line-${w}-${theme}.png`, fullPage: true });
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(failures.length ? `\n${failures.length} failed` : "\nAll checks passed");
process.exit(failures.length ? 1 : 0);
