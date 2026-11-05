// "Start from an example", every page as a guest: each page with examples of its own (src/lib/examples/plan.json) at
// 390x844 and 1440x900. On each: the row or the preset card's strip shows; nothing scrolls sideways; every card is a
// 44 px tap target; no internal words show; a tap on the first card puts its files and words into the composer, and
// Generate stays enabled; no page or console errors. Pages with only "More to try" covers are checked for the row and
// the layout.
// Usage: node tests/e2e/examples-sweep.mjs <appUrl> [--only=<substring>] [--sizes=phone,desktop] [--jobs=4] [--shots <dir>]
//   (the app running as a public sign-up install; a guest). Exits 1 on a failed check.
import fs from "node:fs";
import path from "node:path";
import { DESKTOP, launch, openRoute, PHONE, root } from "./_browser.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const shotsAt = argv.indexOf("--shots");
const shots = shotsAt >= 0 ? argv[shotsAt + 1] : undefined;
// The address is required: a default would reach whatever server happens to run on that port.
const given = argv.find((a, i) => !a.startsWith("--") && (shotsAt < 0 || i !== shotsAt + 1));
if (!given) {
  console.error("usage: node tests/e2e/examples-sweep.mjs <appUrl> [--only=<substring>] [--sizes=phone,desktop] [--jobs=4] [--shots <dir>]");
  process.exit(2);
}
const app = given.replace(/\/$/, "");
console.log(`Checking ${app}`);
const only = flag("only");
const sizes = (flag("sizes") ?? "phone,desktop").split(",");
const jobs = Number(flag("jobs") ?? 4);
if (shots) fs.mkdirSync(shots, { recursive: true });

/** Words a visitor never sees (the catalog test checks the cards' own text; this checks the whole page). */
const INTERNAL = /\b(unverified|not checked|preview made with|todo|tbd)\b/i;
const IGNORED_CONSOLE = /Failed to load resource|Download the React DevTools|\[Fast Refresh\]/;

const plan = JSON.parse(fs.readFileSync(path.join(root, "src/lib/examples/plan.json"), "utf8"));

function urlOf(surface) {
  const i = surface.indexOf(":");
  const [kind, name] = [surface.slice(0, i), surface.slice(i + 1)];
  if (kind === "app") return `/apps/${name}`;
  if (kind === "preset") return `/video?preset=${name}`;
  return `/${name}`;
}

/** Each page with its first example (lowest rank): what a tap must put in the composer. */
const firstBySurface = new Map();
for (const r of plan) {
  const was = firstBySurface.get(r.surface);
  if (!was || r.rank < was.rank) firstBySurface.set(r.surface, r);
}
/** Pages that show "More to try" covers until they have examples of their own. */
const MORE = ["/video-edit", "/extend", "/reframe", "/lipsync", "/motion-control", "/upscale/video", "/video-tools", "/audio/speech", "/audio/music", "/layers", "/genjutsu", "/katana", "/cinema", "/ads"];

const targets = [
  ...[...firstBySurface.values()].map((r) => ({ url: urlOf(r.surface), row: r })),
  ...MORE.map((url) => ({ url, row: null })),
].filter((t) => !only || t.url.includes(only));

const failures = [];
let checked = 0;
const check = (label, ok, extra = "") => {
  checked++;
  if (!ok) {
    failures.push(`${label}${extra ? ` (${extra})` : ""}`);
    console.log(`FAIL ${label}${extra ? ` ${extra}` : ""}`);
  }
};

const browser = await launch();

async function visit(t, size) {
  const context = await browser.newContext(size === "phone" ? PHONE : DESKTOP);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  page.on("console", (m) => m.type() === "error" && !IGNORED_CONSOLE.test(m.text()) && errors.push(m.text().slice(0, 200)));
  const label = `${t.url} (${size})`;
  try {
    await openRoute(page, `${app}${t.url}`, { settleMs: 2000 });
    // The row waits for the feed (a guest's is empty); the strip for its preset's card.
    await page.locator("[data-examples]").first().waitFor({ timeout: 15_000 }).catch(() => {});
    check(`${label}: its examples show`, (await page.locator("[data-examples]").count()) > 0);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`${label}: nothing scrolls sideways`, wide <= 0, `${wide}px`);
    const small = await page.locator("[data-examples] [data-example]").evaluateAll((els) =>
      els.filter((e) => e.offsetParent !== null).map((e) => e.getBoundingClientRect()).filter((b) => b.width < 44 || b.height < 44).length,
    );
    check(`${label}: every card is a 44 px tap target`, small === 0, `${small} small`);
    const text = await page.evaluate(() => document.body.innerText);
    const internal = INTERNAL.exec(text);
    check(`${label}: no internal words`, !internal, internal?.[0]);
    if (t.row && t.row.load !== "look") {
      const card = page.locator(`[data-examples] button[data-example="${t.row.id}"]`).first();
      check(`${label}: its first example is a card`, (await card.count()) > 0, t.row.id);
      if (await card.count()) {
        await card.scrollIntoViewIfNeeded();
        await card.click();
        await page.waitForTimeout(1500);
        const composer = page.locator("[data-studio] [data-composer]").filter({ visible: true }).first();
        const srcs = await composer.locator("img, video").evaluateAll((els) => els.map((e) => (e.getAttribute("src") ?? "").split("?")[0]));
        const want = Object.entries(t.row.inputs).filter(([slot]) => slot !== "mask");
        for (const [slot, ref] of want) check(`${label}: ${slot} is in the composer`, srcs.includes(ref), `${ref} not in ${srcs.join(" ")}`);
        if (t.row.words) {
          const words = await composer.locator("textarea").first().inputValue().catch(() => "");
          check(`${label}: its words are in the composer`, words.trim() === t.row.words.trim(), words.slice(0, 50));
        }
        // The Video studio's card loads a motion or effect: its own card in the preset's strip then shows it is in.
        const pressed = await page.locator("[data-example][aria-pressed=true]").count();
        check(`${label}: the card says it is in the composer`, pressed > 0);
        const generate = composer.getByRole("button", { name: /^Generate/ }).first();
        check(`${label}: Generate is enabled`, (await generate.count()) > 0 && (await generate.isEnabled()));
      }
    }
    if (shots) await page.screenshot({ path: path.join(shots, `${t.url.replace(/[/?=]+/g, "_").replace(/^_/, "")}-${size}.png`) });
    check(`${label}: no page or console errors`, !errors.length, errors.slice(0, 2).join(" | "));
  } catch (e) {
    check(`${label}: loads`, false, String(e).slice(0, 160));
  } finally {
    await context.close();
  }
}

const queue = targets.flatMap((t) => sizes.map((size) => [t, size]));
const total = queue.length;
let done = 0;
await Promise.all(
  Array.from({ length: jobs }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      await visit(...next);
      if (++done % 25 === 0) console.log(`${done}/${total} pages`);
    }
  }),
);

await browser.close();
console.log(`\n${total} pages, ${checked} checks, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
