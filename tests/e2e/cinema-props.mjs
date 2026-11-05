// Props in Cinema's 3D scene (idol-9) in a real browser (the app must be running in demo mode; WebGL runs on
// SwiftShader). Usage: node tests/e2e/cinema-props.mjs [appUrl] [--shots=dir]. Exits 1 on the first failure.
//
// SwiftShader sorts the splats slowly: a path with a prop takes a few minutes to render here.
// 1. 1440 px, dark, open engine: the path filmed without a prop, then "Add a prop" places the demo Idol 3D splat from
//    the Library in front of the camera (the view changes; Spark loads only now); the path filmed again shows it: the
//    render's first frame differs from the first one where the prop is, in the splat's own violet, and the handle's
//    red and green never reach the render. The handle drags the prop (the view doesn't turn with it), the Size slider
//    sizes it, and the prop is still there after a reload (kept for the scene in this browser).
// 2. 1440 px, light, cloud: the panel says the cloud films the still without props; nothing scrolls sideways.
// 3. 390 px, light and dark: the Props button opens the Props sheet with the prop and its handles; "Add a prop" opens
//    a dialog that fits the phone; nothing scrolls sideways.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DESKTOP, PHONE, chromiumPath, loadPlaywright } from "./_browser.mjs";

const args = process.argv.slice(2);
const app = (args.find((a) => !a.startsWith("--")) ?? "http://localhost:3000").replace(/\/$/, "");
const shots = args.find((a) => a.startsWith("--shots="))?.slice(8);
if (shots) fs.mkdirSync(shots, { recursive: true });
const { chromium } = loadPlaywright();
const browser = await chromium.launch({ executablePath: chromiumPath(), args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const step = (name) => console.log(`- ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = browser.newContext().then((c) => c.request);
async function call(url, method = "GET", data) {
  const res = await (await api).fetch(app + url, { method, headers: { "Content-Type": "application/json" }, data: data === undefined ? undefined : JSON.stringify(data) });
  return res.json();
}
async function until(fn, what, ms = 90_000) {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error(`Timed out waiting for ${what}`);
    await sleep(700);
  }
}
const shoot = (page, name) => shots && page.screenshot({ path: path.join(shots, `${name}.png`) });
const hideDevBadge = (ctx) =>
  ctx.addInitScript(() =>
    document.addEventListener("DOMContentLoaded", () => {
      const s = document.createElement("style");
      s.textContent = "nextjs-portal{display:none!important}";
      document.head.append(s);
    }),
  );
const noSideScroll = async (page, what) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0, `${what}: nothing scrolls sideways`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fuobe-props-"));

/** The first and last frames of a path render as raw RGB (ffmpeg), with their size. */
async function ends(url, name) {
  const file = path.join(tmp, `${name}${path.extname(url)}`);
  fs.writeFileSync(file, Buffer.from(await (await (await api).fetch(app + url)).body()));
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", file]).toString()).streams[0];
  const first = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 64 << 20 });
  // The last half second, then its last frame.
  const tail = execFileSync("ffmpeg", ["-v", "error", "-sseof", "-0.5", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 256 << 20 });
  const n = probe.width * probe.height * 3;
  return { width: probe.width, height: probe.height, first, last: tail.subarray(tail.length - n) };
}

/** How one frame differs from the same frame without the prop: changed pixels, the splat's violet, the handle's colours. */
function compare(a, b) {
  let changed = 0;
  let violet = 0;
  let handle = 0;
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (d < 60) continue;
    changed++;
    const [r, g, bl] = [b[i], b[i + 1], b[i + 2]];
    if (bl > r + 25 && bl > g + 25) violet++;
    if ((r > 180 && g < 90 && bl < 90) || (g > 180 && r < 90 && bl < 90)) handle++;
  }
  return { changed, violet, handle };
}

const status = await call("/api/status");
assert.notEqual(status.demoMode, "off", "run the app in demo mode (FUOBE_DEMO_MODE=on)");
const project = await call("/api/cinema/projects", "POST", { name: "Props check" });
const items = async () => (await call(`/api/cinema/projects/${project.id}/items`)).items;
const errors = [];
let failed = false;
let splatGen;

async function openScene(ctx, engine) {
  await ctx.addInitScript((e) => localStorage.setItem("fuobe.engine", e), engine);
  await hideDevBadge(ctx);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
  await page.goto(`${app}/cinema/${project.id}`, { waitUntil: "load", timeout: 120_000 });
  await page.locator(`button[aria-label="Open 3D scene"]`).first().click({ force: true, timeout: 90_000 });
  await page.getByText(/Point cloud from a depth map · \d+k points/).waitFor({ timeout: 60_000 });
  return page;
}

/** Film the open path ("Dolly in") and return the render's URL. */
async function filmOpen(page, before) {
  await page.getByRole("complementary").getByRole("button", { name: /^Film this path · Placeholder · free$/ }).click();
  await page.locator("[data-sonner-toast]").filter({ hasText: "Filming this path" }).last().waitFor({ timeout: 420_000 });
  const take = await until(async () => (await items()).find((g) => g.feature === "cinema-path" && g.request.modelId === "oss-uni3c-path" && !before.has(g.id)), "the open path take");
  return take;
}

try {
  step("a still, its cloud 3D scene, and an Idol 3D splat in the Library");
  const settings = { camera: "modern", lens: "clean-sharp", focal: "24mm" };
  const made = await call(`/api/cinema/projects/${project.id}/generate`, "POST", {
    input: { engine: "cloud", mode: "image", action: "generate", prompt: "A quiet kitchen table by a window", settings, aspectRatio: "16:9" },
  });
  const still = await until(async () => (await items()).find((g) => g.id === made.items?.[0]?.id && g.status === "succeeded"), "the still");
  const built = await call(`/api/cinema/projects/${project.id}/generate`, "POST", {
    input: { engine: "cloud", mode: "image", action: "scene", prompt: "", settings, source: { url: still.outputs[0].url, kind: "image" }, aspectRatio: "16:9" },
  });
  await until(async () => (await items()).find((g) => g.id === built.items?.[0]?.id && g.status === "succeeded"), "the scene");
  const splat = await call("/api/generations", "POST", { feature: "image-to-3d", modelId: "oss-idol", op: "splat", inputs: { images: [still.outputs[0].url] } });
  splatGen = splat.items?.[0]?.id;
  assert.ok(splatGen, `an Idol 3D run starts (${JSON.stringify(splat).slice(0, 200)})`);
  await until(async () => (await call(`/api/generations/${splatGen}`)).status === "succeeded", "the Idol 3D splat");

  step("1440 dark, open engine: the path filmed without a prop");
  const ctx = await browser.newContext({ ...DESKTOP, colorScheme: "dark" });
  const page = await openScene(ctx, "open");
  const spark = [];
  page.on("request", (r) => /sparkjsdev|splat-engine/.test(r.url()) && spark.push(r.url()));
  await page.getByRole("button", { name: "Dolly in" }).click();
  const seen = new Set((await items()).map((g) => g.id));
  const plain = await filmOpen(page, seen);
  seen.add(plain.id);
  assert.deepEqual(spark, [], "a scene without props doesn't fetch the splat renderer");

  step("Add a prop: the Library's splat lands in front of the camera");
  const aside = page.getByRole("complementary");
  const canvas = page.locator("canvas[aria-roledescription='3D view']");
  const pixels = () => canvas.screenshot().then((b) => b.toString("base64"));
  await page.mouse.move(1300, 20);
  const empty = await pixels();
  await aside.getByRole("button", { name: "Add a prop" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a prop" });
  await dialog.getByRole("heading", { name: "From a picture" }).waitFor();
  // The owner on placeholder results may make one from a picture (Idol 3D on the GPU). No price shows until a picture
  // is picked and priced (never a "Free" guessed before the preview).
  const makeButton = dialog.getByRole("button", { name: /^Make the prop/ });
  await makeButton.waitFor();
  assert.equal((await makeButton.textContent()).trim(), "Make the prop", "no price before a picture is picked");
  await shoot(page, "props-add-dialog-dark");
  await dialog.getByRole("button", { name: /^Place Idol 3D/ }).first().click();
  await dialog.waitFor({ state: "detached" });
  const item = aside.getByRole("button", { name: /^Prop 1: Idol 3D/ });
  await item.waitFor();
  await aside.getByText("Drag the handle in the view").waitFor({ timeout: 60_000 });
  assert.ok(spark.length > 0, "adding a prop fetches the splat renderer");
  await page.getByText(/· 1 prop( ·|$)/).waitFor();
  await sleep(1500);
  assert.notEqual(await pixels(), empty, "the prop shows in the view");
  await shoot(page, "props-desktop-dark");

  step("the handle drags the prop; the Size slider sizes it");
  const stored = () => page.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.startsWith("fuobe.cinema.scene."))?.[1] ?? "null"));
  const s0 = (await stored()).props[0];
  const box = await canvas.boundingBox();
  // The prop sits at the view's centre: the move handle's centre is there.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.width / 2 + i * 12, box.y + box.height / 2 + i * 4);
  await page.mouse.up();
  const s1 = await until(async () => {
    const p = (await stored()).props[0];
    return p.position[0] !== s0.position[0] ? p : null;
  }, "the handle to move the prop", 10_000);
  assert.ok(s1.position[0] > s0.position[0], "dragged right moves it right");
  const sizeSlider = aside.getByRole("slider", { name: "Prop size" });
  await sizeSlider.focus();
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowRight");
  const s2 = await until(async () => {
    const p = (await stored()).props[0];
    return p.size > s1.size ? p : null;
  }, "the size slider", 10_000);
  // Back where it was for the film (the same frame as the plain render, so only the prop differs).
  await aside.getByRole("button", { name: "In front of the camera" }).click();
  await sizeSlider.focus();
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowLeft");
  console.log(`  prop: moved to x ${s1.position[0]}, sized ${s0.size} → ${s2.size}`);

  step("the path filmed with the prop shows it in the render");
  // The prop stays picked: its handle shows on screen, and must not reach the render.
  await page.mouse.move(1300, 20);
  const withProp = await filmOpen(page, seen);
  const a = await ends(plain.request.inputs.video, "plain");
  const b = await ends(withProp.request.inputs.video, "prop");
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  const total = a.width * a.height;
  const { changed, violet, handle } = compare(a.first, b.first);
  console.log(`  first frame ${a.width}x${a.height}: ${changed} px changed (${((changed / total) * 100).toFixed(1)}%), ${violet} violet, ${handle} handle-coloured`);
  assert.ok(changed > total * 0.01, "the prop changes the render's first frame");
  assert.ok(violet > changed * 0.5, "what changed is the prop's violet");
  assert.ok(handle < changed * 0.01, "the handle isn't in the render");
  // The last frame, the furthest from where the screen's camera stayed, shows the prop too, and only the prop.
  const late = compare(a.last, b.last);
  console.log(`  last frame: ${late.changed} px changed (${((late.changed / total) * 100).toFixed(1)}%), ${late.violet} violet, ${late.handle} handle-coloured`);
  assert.ok(late.changed > total * 0.01, "the prop is in the render's last frame");
  assert.ok(late.violet > late.changed * 0.5, "what changed in the last frame is the prop's violet");
  assert.ok(late.handle < late.changed * 0.01, "the handle isn't in the last frame");

  step("the prop is kept for the scene after a reload");
  await page.reload({ waitUntil: "load" });
  await page.locator(`button[aria-label="Open 3D scene"]`).first().click({ force: true, timeout: 90_000 });
  await page.getByRole("complementary").getByRole("button", { name: /^Prop 1: Idol 3D/ }).waitFor({ timeout: 60_000 });
  await page.getByText(/· 1 prop( ·|$)/).waitFor();
  await noSideScroll(page, "desktop dark");
  await ctx.close();

  step("1440 light, cloud: the panel says the cloud films the still without props");
  const light = await browser.newContext({ ...DESKTOP, colorScheme: "light" });
  // The prop was kept in the other context's browser storage: place it again here.
  const p2 = await openScene(light, "cloud");
  await p2.getByRole("complementary").getByRole("button", { name: "Add a prop" }).click();
  await p2.getByRole("dialog", { name: "Add a prop" }).getByRole("button", { name: /^Place Idol 3D/ }).first().click();
  await p2.getByText(/Filming on the cloud follows the still itself/).waitFor();
  await p2.getByRole("complementary").getByText("Drag the handle in the view").waitFor({ timeout: 60_000 });
  await noSideScroll(p2, "desktop light");
  await shoot(p2, "props-desktop-light-cloud");
  await light.close();

  for (const scheme of ["light", "dark"]) {
    step(`390 ${scheme}: the Props sheet and the add dialog fit the phone`);
    const phone = await browser.newContext({ ...PHONE, colorScheme: scheme });
    const p3 = await openScene(phone, "open");
    await noSideScroll(p3, `phone ${scheme}`);
    await p3.getByRole("button", { name: /^Props, 0 in the scene$/ }).click();
    const sheet = p3.getByRole("dialog", { name: "Props" });
    await sheet.getByRole("button", { name: "Add a prop" }).click();
    const add = p3.getByRole("dialog", { name: "Add a prop" });
    await add.getByRole("button", { name: /^Place Idol 3D/ }).first().waitFor();
    assert.ok((await add.boundingBox()).width <= 390, "the dialog fits the phone");
    await noSideScroll(p3, `phone ${scheme} add dialog`);
    await shoot(p3, `props-phone-${scheme}-add`);
    await add.getByRole("button", { name: /^Place Idol 3D/ }).first().click();
    await sheet.getByRole("button", { name: /^Prop 1: Idol 3D/ }).waitFor();
    await sheet.getByText("Drag the handle in the view").waitFor({ timeout: 60_000 });
    await sheet.getByRole("radio", { name: "Turn" }).click();
    await sheet.getByRole("slider", { name: "Prop turn" }).waitFor();
    assert.ok((await sheet.boundingBox()).width <= 390, "the sheet fits the phone");
    await noSideScroll(p3, `phone ${scheme} sheet`);
    await shoot(p3, `props-phone-${scheme}`);
    await p3.keyboard.press("Escape");
    await p3.getByRole("button", { name: /^Props, 1 in the scene$/ }).waitFor();
    await shoot(p3, `props-phone-${scheme}-view`);
    await phone.close();
  }

  assert.deepEqual(errors, [], "no page or console errors");
  console.log("\nAll props checks passed.");
} catch (e) {
  failed = true;
  if (shots) for (const c of browser.contexts()) for (const [i, pg] of c.pages().entries()) await pg.screenshot({ path: path.join(shots, `fail-${i}.png`) }).catch(() => {});
  console.log(`FAIL ${e.message.split("\n")[0]}`);
  if (errors.length) console.log(`errors: ${errors.slice(0, 5).join(" | ")}`);
} finally {
  await call(`/api/cinema/projects/${project.id}`, "DELETE").catch(() => {});
  if (splatGen) await call(`/api/generations/${splatGen}`, "DELETE").catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
  await browser.close();
}
process.exit(failed ? 1 : 0);
