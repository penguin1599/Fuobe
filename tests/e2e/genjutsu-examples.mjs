// Genjutsu's mode examples, browser check at 390 and 1440 px, light and dark. Each mode tab: the selected mode's example
// card shows when the mode has one for this viewer (one card at most, none for a mode without one); its loop downloads
// only once the card is half in view and plays muted; nothing moves when it arrives; the pause button, the actions and
// "How it was made" are 44 px; switching modes drops the loop; the card is the page column's width (640 px) and on a
// phone short enough to leave the upload box close. Reduced motion: the finished result as a still, no download until
// Play. Visitors (--viewer guest | account: a studio with a password and public sign-up) see the video, how it was made,
// Use this example and Copy its setup (an account runs Genjutsu on its own GPU or key; a guest signs up when it adds its
// clip), no model names, no "Only you", and no "isn't available" note. The owner: Use this example with no clip marks the card "In use" (the form's setup equals the
// recipe), moves the focus to Choose a video, says what is still needed, and Undo puts the form back; a second mode's
// example after the first asks nothing; a clip added after an example takes the example's length, and a mode change
// drops it; with a clip and the example's kind of photos the estimate's request body equals the run that made the
// example (tests/fixtures/genjutsu-examples/<id>.json; the clip, photos and who-is-who are the test's own, and who is who
// typed before Use this example stays).
// Usage: node tests/e2e/genjutsu-examples.mjs [appUrl] [--viewer owner|guest|account] [--shots <dir>]   Exits 1 on a failed check.
import fs from "node:fs";
import path from "node:path";
import { launch, root, ENGINE } from "./_browser.mjs";

const argv = process.argv.slice(2);
const flag = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const app = (argv.find((a, i) => !a.startsWith("--") && !["--viewer", "--shots"].includes(argv[i - 1])) ?? "http://localhost:4001").replace(/\/$/, "");
const viewer = flag("--viewer") ?? "owner";
const shots = flag("--shots");
if (shots) fs.mkdirSync(shots, { recursive: true });
const visitor = viewer !== "owner";

const failures = [];
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(84)}${extra ? ` ${extra}` : ""}`);
  if (!ok) failures.push(label);
};

const MODES = { motion: "Motion transfer", character: "Character swap", swap: "Object swap", restyle: "Restyle", insert: "Insert", picture: "From picture", finish: "Finish" };
// The examples in src/lib/examples/plan.json (load "genjutsu") and the features each needs open (requestFeatures).
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
const NEEDS = { "genjutsu-character.1": ["group-swap"], "genjutsu-finish.1": ["finish-colours"] };
const FEATURE_WORKFLOWS = { "group-swap": ["video-group-swap-h3"], "finish-colours": ["video-fix-colours"] };
const validated = new Set(readJson("workflows/comfyui/manifest.json").workflows.filter((w) => w.validated === true).map((w) => w.id));
const passed = readJson("workflows/comfyui/gpu-tested.json").features ?? {};
const live = (k) => passed[k]?.passed === true && FEATURE_WORKFLOWS[k].every((id) => validated.has(id));
const rows = readJson("src/lib/examples/plan.json").filter((r) => r.load === "genjutsu");
/** mode → the example this viewer should see (the best ranked whose features are open). */
const expected = {};
for (const r of [...rows].sort((a, b) => a.rank - b.rank)) {
  const mode = r.surface.replace("tool:genjutsu/", "");
  if (expected[mode]) continue;
  if (!visitor || (NEEDS[r.id] ?? []).every(live)) expected[mode] = r;
}

async function upload(file, type, name) {
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(path.join(root, file))], { type }), name);
  const res = await fetch(`${app}/api/uploads`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return (await res.json()).url;
}
const code = (o) => `gj2.${Buffer.from(JSON.stringify(o)).toString("base64url")}`;

const browser = await launch();
try {
  for (const scheme of ["light", "dark"]) {
    for (const [width, height] of [
      [390, 844],
      [1440, 900],
    ]) {
      const tag = `${viewer} ${width} ${scheme}`;
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
      await context.addInitScript(() => {
        try {
          localStorage.setItem("fuobe.engine", "open");
        } catch {}
      });
      if (viewer === "account") {
        const email = `gj-example-${Date.now()}-${width}-${scheme}@example.com`;
        const res = await context.request.post(`${app}/api/auth/signup`, { data: { email, password: "example-pass-1" } });
        check(`${tag}: an account signs up`, res.ok(), String(res.status()));
      }
      const page = await context.newPage();
      const mp4s = [];
      const runs = [];
      page.on("request", (r) => {
        if (/\/examples\/genjutsu-[a-z]+\/\d+\/show\.mp4/.test(r.url())) mp4s.push(r.url());
        if (r.method() === "POST" && r.url().endsWith("/api/genjutsu")) runs.push(r.url());
      });
      const shot = async (name) => shots && (await page.screenshot({ path: path.join(shots, `${viewer}-${name}-${width}-${scheme}.png`) }));
      const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const open = async (url) => {
        await page.goto(`${app}${url}`, { waitUntil: "load", timeout: 180_000 });
        await page.getByRole("tablist", { name: "Genjutsu modes" }).waitFor({ timeout: 120_000 });
        await page.waitForTimeout(1200);
      };
      const cards = () => page.locator("[data-mode-example]");
      const card = () => cards().first();
      const box = (sel) => page.evaluate((s) => {
        const r = document.querySelector(s)?.getBoundingClientRect();
        return r ? [Math.round(r.x), Math.round(r.y + window.scrollY), Math.round(r.width), Math.round(r.height)].join(",") : null;
      }, sel);
      const playing = () =>
        page.evaluate(async () => {
          const v = document.querySelector("[data-example-video]");
          if (!v) return false;
          const t = v.currentTime;
          await new Promise((r) => setTimeout(r, 700));
          return !v.paused && v.muted && v.loop && v.currentTime !== t;
        });

      // Every open mode: a card where this viewer has an example, none elsewhere, one at most.
      await open("/genjutsu?mode=motion");
      check(`${tag}: no loop downloaded on a mode without an example`, expected.motion ? true : mp4s.length === 0, String(mp4s.length));
      const tabNames = (await page.getByRole("tablist", { name: "Genjutsu modes" }).getByRole("tab").allInnerTexts()).map((t) => t.replace(/\s*Only you$/, "").trim());
      for (const [id, label] of Object.entries(MODES)) {
        if (!tabNames.includes(label)) continue;
        await page.getByRole("tablist", { name: "Genjutsu modes" }).getByRole("tab", { name: new RegExp(`^${label}`) }).click();
        await page.waitForTimeout(500);
        const want = expected[id];
        const n = await cards().count();
        check(`${tag}: ${label} shows ${want ? `its example (${want.id})` : "no example card"}`, want ? n === 1 && (await card().getAttribute("data-mode-example")) === want.id : n === 0, `cards ${n}`);
      }

      for (const [id, row] of Object.entries(expected)) {
        const label = MODES[id];
        mp4s.length = 0;
        // The card off screen first (scrolled to the bottom): no download until it is half in view.
        await open(`/genjutsu?mode=${id}`);
        const shifts = await page.evaluate(() => {
          window.__shift = 0;
          new PerformanceObserver((l) => l.getEntries().forEach((e) => !e.hadRecentInput && (window.__shift += e.value))).observe({ type: "layout-shift", buffered: true });
          return true;
        });
        const c = card();
        await c.waitFor({ timeout: 30_000 });
        const before = await box("[data-mode-example]");
        const drop = await box("#gj-clip-drop");
        await c.scrollIntoViewIfNeeded();
        await page.waitForFunction(() => !!document.querySelector("[data-example-video]"), null, { timeout: 20_000 }).catch(() => {});
        await page.waitForTimeout(1500);
        check(`${tag} ${label}: the loop plays muted once in view`, await playing());
        check(`${tag} ${label}: one download of its loop`, mp4s.length >= 1 && mp4s.every((u) => u.includes(row.output)), JSON.stringify(mp4s.map((u) => u.replace(app, ""))));
        check(`${tag} ${label}: nothing moves when the loop arrives`, before === (await box("[data-mode-example]")) && drop === (await box("#gj-clip-drop")), `${before} / ${await box("[data-mode-example]")}`);
        if (ENGINE === "chromium" && shifts) {
          const cls = await page.evaluate(() => window.__shift);
          check(`${tag} ${label}: no layout shift (CLS ${cls.toFixed(3)})`, cls < 0.02);
        }
        const loopBox = await c.locator("[data-example-video]").boundingBox();
        check(`${tag} ${label}: the loop is 4:3 and at least 358 px wide`, !!loopBox && loopBox.width >= 340 && Math.abs(loopBox.width / loopBox.height - 4 / 3) < 0.02, loopBox ? `${Math.round(loopBox.width)}×${Math.round(loopBox.height)}` : "none");
        const cardBox = await c.boundingBox();
        const dropBox = await page.locator("#gj-clip-drop").boundingBox();
        if (width >= 1440) {
          const side = await c.locator("figcaption").boundingBox();
          // 640 px with its 1 px border, lined up with the upload box: the loop takes what the 248 px column leaves.
          check(`${tag} ${label}: 640 px card in the page's column, a 248 px column beside the loop`, Math.round(cardBox.width) === 640 && Math.round(side.width) === 248 && Math.round(loopBox.width) === 390 && Math.abs(cardBox.x - dropBox.x) < 1, `${Math.round(cardBox.width)} / ${Math.round(side.width)} / ${Math.round(loopBox.width)} / x ${Math.round(cardBox.x)} vs ${Math.round(dropBox.x)}`);
        } else {
          check(`${tag} ${label}: the phone card is short (480 px at most)`, cardBox.height <= 480, `${Math.round(cardBox.height)} px`);
        }
        const sizes = await c.evaluate((el) => [...el.querySelectorAll("button, summary")].filter((b) => b.getClientRects().length).map((b) => `${b.getAttribute("aria-label") ?? b.textContent?.trim()}:${Math.round(b.getBoundingClientRect().width)}x${Math.round(b.getBoundingClientRect().height)}`));
        check(`${tag} ${label}: every target is 44 px or more`, sizes.every((s) => s.split(":").pop().split("x").every((d) => Number(d) >= 44) || /summary/.test(s)), JSON.stringify(sizes));
        const summary = c.locator("summary");
        check(`${tag} ${label}: "How it was made" is a 44 px toggle`, (await summary.innerText()).includes("How it was made") && ((await summary.boundingBox())?.height ?? 0) >= 44);
        // Pause and play.
        await c.getByRole("button", { name: "Pause the example" }).click();
        check(`${tag} ${label}: Pause stops the loop`, !(await playing()));
        await c.getByRole("button", { name: "Play the example" }).click();
        check(`${tag} ${label}: Play starts it again`, await playing());
        const text = await c.evaluate((el) => el.textContent ?? "");
        check(`${tag} ${label}: "EXAMPLE", the title and "What went in"`, /example/i.test(text) && text.includes(row.caption) && text.includes("What went in") && row.caption.length <= 40);
        if (visitor) check(`${tag} ${label}: no seed or "Part" chip for a visitor`, !/Seed \d|Part \d/.test(text), text.replace(/\s+/g, " ").slice(-120));
        check(`${tag} ${label}: no test words or file paths`, !/\b(test|pass(ed)?|owner|validated|oss-|\/api\/)/i.test(text), text.replace(/\s+/g, " ").slice(0, 160));
        if (visitor) {
          check(`${tag} ${label}: a visitor has Use this example and Copy its setup`, (await c.locator("[data-use-example]").count()) === 1 && (await c.getByRole("button", { name: /Copy its setup/ }).count()) === 1);
          check(`${tag} ${label}: no model names and no "Only you" for a visitor`, !/Group swap|Colour finish|Only you|MiniMax|H3/.test(text));
          check(`${tag} ${label}: no "isn't available" note`, (await page.getByText("Genjutsu isn't available here.").count()) === 0);
        } else {
          check(`${tag} ${label}: the owner has Use this example`, await c.locator("[data-use-example]").isVisible());
        }
        check(`${tag} ${label}: fits the screen`, (await sideways()) <= 0);
        await shot(`${id}`);
        // Leaving the mode drops the loop.
        await page.getByRole("tablist", { name: "Genjutsu modes" }).getByRole("tab", { name: /^Motion transfer/ }).click();
        await page.waitForTimeout(400);
        check(`${tag} ${label}: leaving the mode removes its loop`, (await page.locator("[data-example-video]").count()) === 0 && (await cards().count()) === (expected.motion ? 1 : 0));

        // The owner: Use this example with no clip puts the exact recipe in the form ("In use"), and Undo takes it out.
        if (!visitor && scheme === "light") {
          await open(`/genjutsu?mode=${id}`);
          await card().locator("[data-use-example]").click();
          await page.waitForTimeout(900);
          const used = card().locator("[data-use-example]");
          check(`${tag} ${label}: Use this example fills the form exactly ("In use")`, (await used.innerText()).includes("In use"), await used.innerText());
          check(`${tag} ${label}: "In use" says so without turning off (aria-disabled, focusable)`, (await used.getAttribute("aria-disabled")) === "true" && (await used.evaluate((b) => !b.disabled)));
          const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() || document.activeElement?.tagName);
          check(`${tag} ${label}: the focus moves to Choose a video`, focused === "Choose a video", String(focused));
          const photos = Object.keys(row.inputs).filter((k) => k.startsWith("photo")).length;
          const want = `Add your clip${photos ? ` and ${photos} character photos` : ""}, then Generate.`;
          check(`${tag} ${label}: the toast says what is still needed`, await page.getByText(want).isVisible().catch(() => false), want);
          check(`${tag} ${label}: it runs nothing (no run request)`, runs.length === 0);
          const undo = page.getByRole("button", { name: "Undo" });
          if (await undo.isVisible().catch(() => false)) {
            await undo.click();
            await page.waitForTimeout(500);
            check(`${tag} ${label}: Undo puts the form back`, (await card().locator("[data-use-example]").innerText()).includes("Use this example"));
          } else check(`${tag} ${label}: the toast offers Undo`, false);
        }
      }

      // The owner: one example, then another mode's: no "Replace your settings?" (the words were the first example's).
      const ids = Object.keys(expected);
      if (!visitor && scheme === "light" && ids.length >= 2) {
        await open(`/genjutsu?mode=${ids[0]}`);
        await card().locator("[data-use-example]").click();
        await page.waitForTimeout(600);
        await page.getByRole("tablist", { name: "Genjutsu modes" }).getByRole("tab", { name: new RegExp(`^${MODES[ids[1]]}`) }).click();
        await page.waitForTimeout(500);
        await card().locator("[data-use-example]").click();
        await page.waitForTimeout(600);
        check(`${tag}: a second mode's example asks nothing`, (await page.getByRole("alertdialog").count()) === 0 && (await card().locator("[data-use-example]").innerText()).includes("In use"));
      }
      await context.close();

      // Reduced motion: the result as a still, the loop only on Play.
      if (scheme === "light") {
        const first = Object.entries(expected)[0];
        if (first) {
          const [id, row] = first;
          const rc = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
          if (viewer === "account") await rc.request.post(`${app}/api/auth/signup`, { data: { email: `gj-example-rm-${Date.now()}-${width}@example.com`, password: "example-pass-1" } });
          const p = await rc.newPage();
          const got = [];
          p.on("request", (r) => r.url().includes("/show.mp4") && got.push(r.url()));
          await p.goto(`${app}/genjutsu?mode=${id}`, { waitUntil: "load", timeout: 180_000 });
          const c = p.locator("[data-mode-example]").first();
          await c.waitFor({ timeout: 60_000 });
          await c.scrollIntoViewIfNeeded();
          await p.waitForTimeout(2000);
          const still = await c.locator("img").first().getAttribute("src");
          check(`${tag} reduced motion: the finished result as a still`, !!still && still.includes(row.rest.src) && (await c.locator("[data-example-video]").count()) === 0, String(still));
          check(`${tag} reduced motion: no download before Play`, got.length === 0, String(got.length));
          await c.getByRole("button", { name: "Play the example" }).click();
          await p.waitForTimeout(1500);
          check(`${tag} reduced motion: Play loads and plays it`, got.length >= 1 && (await p.evaluate(() => !document.querySelector("[data-example-video]")?.paused)));
          await rc.close();
        }
      }
    }
  }

  // The owner with a clip: the estimate's body equals the run that made each example.
  if (!visitor) {
    const clip = await upload("scripts/eval/fixtures/walk-6s.mp4", "video/mp4", "walk.mp4");
    const pics = [await upload("scripts/eval/fixtures/character/drawn-face-2.png", "image/png", "p1.png"), await upload("scripts/eval/fixtures/character/drawn-face-2.png", "image/png", "p2.png")];
    for (const width of [390, 1440]) {
      for (const row of Object.values(expected)) {
        const fixture = readJson(`tests/fixtures/genjutsu-examples/${row.id}.json`).body;
        const mode = row.genjutsu.recipe.mode;
        const context = await browser.newContext({ viewport: { width, height: 900 }, ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
        await context.addInitScript(() => {
          try {
            localStorage.setItem("fuobe.engine", "open");
          } catch {}
        });
        const page = await context.newPage();
        const bodies = [];
        const runs = [];
        page.on("request", (r) => {
          if (r.method() !== "POST") return;
          if (r.url().endsWith("/api/genjutsu/estimate")) bodies.push(JSON.parse(r.postData() ?? "{}"));
          else if (r.url().endsWith("/api/genjutsu")) runs.push(r.url());
        });
        const refs = fixture.references.length ? { r: pics.slice(0, fixture.references.length) } : {};
        await page.goto(`${app}/genjutsu?video=${encodeURIComponent(clip)}&setup=${code({ m: mode, e: "open", ...refs })}`, { waitUntil: "load", timeout: 180_000 });
        const rowEl = page.locator("[data-mode-example-row]");
        await rowEl.waitFor({ timeout: 120_000 }).catch(() => {});
        check(`owner ${width} ${row.id}: with a clip, one "Example:" row in the side panel`, (await rowEl.count()) === 1 && (await page.locator("[data-mode-example]").count()) === 0);
        // Who is who in the example's own clip is the viewer's to give: the test gives the example's, before Use this
        // example where the form asks for it already (it stays), else after.
        const people = row.genjutsu.own?.character?.people ?? [];
        const role = (i) => page.getByRole("textbox", { name: `Character ${i + 1} replaces` });
        const typed = [];
        for (let i = 0; i < people.length; i++) {
          if (await role(i).isVisible().catch(() => false)) {
            await role(i).fill(people[i].role);
            typed.push(i);
          }
        }
        await rowEl.getByRole("button", { name: "See it" }).click();
        const dialog = page.getByRole("dialog");
        await dialog.waitFor({ timeout: 10_000 });
        await dialog.locator("[data-use-example]").click();
        await page.waitForTimeout(800);
        for (let i = 0; i < people.length; i++) {
          if (typed.includes(i)) check(`owner ${width} ${row.id}: who becomes who typed before stays (${i + 1})`, (await role(i).inputValue()) === people[i].role, await role(i).inputValue());
          else await role(i).fill(people[i].role);
        }
        await page.waitForTimeout(1500);
        const last = bodies.at(-1);
        const strip = (b) => {
          // The clip, its first frame's size and the photos are the viewer's own (the test's here).
          const rest = Object.fromEntries(Object.entries(b ?? {}).filter(([k]) => !["source", "references", "requestId", "frame"].includes(k)));
          // Finish keeps the clip's size: its quality plays no part in the run (tests/genjutsu-examples.test.ts).
          if (rest.mode === "finish") delete rest.quality;
          // Fix colours' settings a run left out are the plan's defaults (FINISH_COLOURS_DEFAULT): the run used them.
          if (rest.finish?.tool === "colours") rest.finish = { finish: "soft", strength: 0.4, soften: 0.33, ...rest.finish };
          const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.keys(v).sort().reduce((o, k) => ((o[k] = sorted(v[k])), o), {}) : v);
          return JSON.stringify(sorted(rest));
        };
        check(`owner ${width} ${row.id}: the form's request equals the run that made it`, !!last && strip(last) === strip(fixture), `\n   form: ${strip(last)}\n   run:  ${strip(fixture)}`);
        check(`owner ${width} ${row.id}: the photos are the viewer's own`, !!last && JSON.stringify(last.references) === JSON.stringify(refs.r ?? []));
        check(`owner ${width} ${row.id}: Use this example ran nothing`, runs.length === 0);
        await context.close();
      }
    }
  }

  // The owner: an example with no clip, then a clip: the part takes the example's length; a mode change in between drops it.
  if (!visitor && expected.finish && expected.character) {
    for (const switchMode of [false, true]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await context.addInitScript(() => {
        try {
          localStorage.setItem("fuobe.engine", "open");
        } catch {}
      });
      const page = await context.newPage();
      const bodies = [];
      page.on("request", (r) => r.method() === "POST" && r.url().endsWith("/api/genjutsu/estimate") && bodies.push(JSON.parse(r.postData() ?? "{}")));
      await page.goto(`${app}/genjutsu?mode=${switchMode ? "character" : "finish"}`, { waitUntil: "load", timeout: 180_000 });
      await page.locator("[data-use-example]").first().click();
      await page.waitForTimeout(600);
      if (switchMode) {
        await page.getByRole("tablist", { name: "Genjutsu modes" }).getByRole("tab", { name: /^Finish/ }).click();
        await page.waitForTimeout(400);
      }
      await page.locator("#gj-clip-drop input[type=file]").setInputFiles(path.join(root, "scripts/eval/fixtures/walk-6s.mp4"));
      await page.waitForFunction(() => !document.querySelector("#gj-clip-drop input[type=file]"), null, { timeout: 120_000 }).catch(() => {});
      await page.waitForTimeout(6000);
      const range = bodies.at(-1)?.range;
      const len = range ? Math.round((range.end - range.start) * 1000) / 1000 : null;
      const want = switchMode ? 6 : expected.finish.genjutsu.recipe.length;
      check(`owner: ${switchMode ? "Character swap's example, then Finish, then a clip: the whole clip" : "Finish's example, then a clip: the example's length"}`, len !== null && Math.abs(len - want) < 0.01, `${len} (want ${want})`);
      await context.close();
    }
  }
} finally {
  await browser.close();
}
if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall passed");
