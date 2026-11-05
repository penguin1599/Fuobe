// The rows under a composer ("Start from an example", "More to try", Make your own Soul look): on every studio page with
// a row, at 390, 768 and 1440 px, in light and dark, the row sits a fixed step below the composer (or the suggestions
// right under it), its heading is on the cards' left edge with a fixed step to the cards, and the row lines up with the
// composer's column. On the pages where the row is a section of its own (Genjutsu, Katana, Ads Studio…) the heading is
// on the cards' edge, the row stays inside the page and lines up with the box above it (Cinema: with the page's title;
// Ads Studio: with the page's column, which its ready brands above and Your brands below share).
// The cards' pictures in a line of the grid share one top. After load no card is grey or empty and no skeleton is left;
// while the cards' code loads (on /image, and on /video whose captions wrap to different lengths), the skeleton has the
// row's heading and the cards' place and pictures, so nothing moves when they arrive.
// Usage: node tests/e2e/composer-rows.mjs <appUrl> [--shots <dir>] [--account] [--owner <password>] [--engine webkit]
//   (--account signs up a new account first: the app needs FUOBE_PUBLIC_SIGNUP=1; --owner signs in with the password;
//   --engine runs it in WebKit, Safari's engine, or Firefox instead of Chromium.)
// Exits 1 on a failed check.
import fs from "node:fs";
import path from "node:path";
import { launch, loadPlaywright, openRoute } from "./_browser.mjs";

const argv = process.argv.slice(2);
const valueOf = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const given = argv.find((a, i) => !a.startsWith("--") && !["--shots", "--owner", "--engine"].includes(argv[i - 1]));
if (!given) {
  console.error("usage: node tests/e2e/composer-rows.mjs <appUrl> [--shots <dir>] [--account] [--owner <password>] [--engine webkit]");
  process.exit(2);
}
const app = given.replace(/\/$/, "");
const shots = valueOf("--shots");
const engine = valueOf("--engine") ?? "chromium";
if (!["chromium", "webkit", "firefox"].includes(engine)) {
  console.error(`unknown engine: ${engine}`);
  process.exit(2);
}
if (shots) fs.mkdirSync(shots, { recursive: true });

const failures = [];
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(84)}${extra ? ` ${extra}` : ""}`);
  if (!ok) failures.push(label);
};

/** Studio pages: the row is in the composer's column. */
const STUDIOS = [
  "/image",
  "/edit",
  "/inpaint",
  "/video",
  "/video-edit",
  "/extend",
  "/lipsync",
  "/motion-control",
  "/reframe",
  "/upscale",
  "/audio/speech",
  "/audio/dialogue",
  "/audio/sfx",
  "/video-tools",
  "/video-tools/relight",
];
/** Pages whose row is a section of its own under an upload box or a project list. */
const SECTIONS = ["/genjutsu", "/katana", "/image-to-3d", "/layers", "/cinema", "/ads", "/ads/multiplier", "/character-swap"];
/** Section pages whose row takes the width of the box right above it (an upload box, a hero). */
const BOXED = new Set(["/genjutsu", "/image-to-3d", "/layers"]);
/** Section pages whose row takes the page's own width: its edge is the page title's. */
const TITLED = new Set(["/cinema"]);
/** Section pages whose row fills the page's column (the content box of the element it sits in). */
const COLUMNED = new Set(["/ads"]);
/** Pages whose loading state is checked: every card the same lines (/image), and captions of different lengths (/video). */
const LOADING = ["/image", "/video"];
const SIZES = [
  { name: "390", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  { name: "768", viewport: { width: 768, height: 1024 } },
  { name: "1440", viewport: { width: 1440, height: 900 } },
];
const SCHEMES = ["light", "dark"];
/** The step between the composer (or its suggestions) and a row: Tailwind mt-10 on a phone, mt-12 from 640 px. */
const stepFor = (width) => (width >= 640 ? 48 : 40);
/** The step between a row's heading and its cards (mb-4). */
const HEADING_STEP = 16;
const near = (a, b, tol = 1.5) => a != null && b != null && Math.abs(a - b) <= tol;

const cookieOf = (res) => /fuobe_session=[^;]+/.exec(res.headers.get("set-cookie") ?? "")?.[0];
async function session() {
  const headers = { "Content-Type": "application/json", Origin: app };
  if (argv.includes("--owner")) {
    const res = await fetch(`${app}/api/auth/login`, { method: "POST", headers, body: JSON.stringify({ password: valueOf("--owner") }) });
    return { who: "owner", cookie: cookieOf(res) };
  }
  if (argv.includes("--account")) {
    const res = await fetch(`${app}/api/auth/signup`, { method: "POST", headers, body: JSON.stringify({ email: `rows-${Date.now()}@example.com`, password: `Rows-${Date.now()}-check!` }) });
    return { who: "account", cookie: cookieOf(res) };
  }
  return { who: "guest" };
}

/** Where the row and what is above it sit (page coordinates). */
function measure() {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { l: r.left, r: r.right, t: r.top + scrollY, b: r.bottom + scrollY, w: r.width };
  };
  const section = document.querySelector("[data-examples]") ?? document.querySelector("[data-examples-loading]");
  const heading = section?.querySelector("h2, p");
  const grid = section?.querySelector("[data-example-grid], .grid");
  const composer = document.querySelector("[data-studio] [data-composer]");
  // What sits right above the row in the composer's column: the composer, or what is under it (suggestions, Soul cards).
  let above = composer ? box(composer) : null;
  const column = section?.closest("[data-under-composer]");
  if (column && section) {
    for (const el of column.children) {
      if (el === section || el.contains(section)) break;
      const b = box(el);
      if (b && b.w > 0 && (!above || b.b > above.b)) above = b;
    }
  }
  // A section of its own: the nearest box above it on the page.
  let previous = null;
  if (!composer && section) {
    let el = section;
    while (el && !previous) {
      let sib = el.previousElementSibling;
      while (sib && !previous) {
        const b = box(sib);
        if (b && b.w > 0 && b.b - b.t > 0) previous = b;
        sib = sib.previousElementSibling;
      }
      el = el.parentElement;
    }
  }
  const firstCard = grid?.firstElementChild;
  // Each card's picture top (its first child: the card's picture, or the skeleton's), and whether the pictures in each
  // line of the grid share one top.
  const cards = grid ? [...grid.children] : [];
  const pictures = cards.map((c) => box(c.firstElementChild)?.t ?? null);
  const lines = new Map();
  cards.forEach((c, i) => {
    const key = Math.round(box(c).t);
    lines.set(key, [...(lines.get(key) ?? []), pictures[i]]);
  });
  const misaligned = [...lines.values()].filter((tops) => Math.max(...tops) - Math.min(...tops) > 1.5).map((tops) => tops.map(Math.round).join("/"));
  return {
    pictures,
    misaligned,
    title: box(document.querySelector("h1")),
    column: (() => {
      const parent = section?.parentElement;
      if (!parent) return null;
      const b = box(parent);
      const cs = getComputedStyle(parent);
      return { l: b.l + parseFloat(cs.paddingLeft), r: b.r - parseFloat(cs.paddingRight) };
    })(),
    loading: !!section?.hasAttribute("data-examples-loading"),
    headingText: heading?.textContent?.trim() ?? "",
    headingAlign: heading ? getComputedStyle(heading).textAlign : "",
    heading: box(heading),
    grid: box(grid),
    firstCard: box(firstCard),
    composer: box(composer),
    above,
    previous,
    page: { w: innerWidth, scrollW: document.documentElement.scrollWidth },
  };
}

/** Every card shows its picture (or its clip's still); no skeleton is left. */
async function cardsFilled(page) {
  const cards = page.locator("[data-examples] [data-example]");
  const n = await cards.count();
  for (let i = 0; i < n; i++) await cards.nth(i).scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(1200);
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll("[data-examples] [data-example]")];
    const empty = cards.filter((c) => {
      const media = [...c.querySelectorAll("img, video")];
      if (!media.length) return true;
      return !media.some((m) => (m.tagName === "IMG" ? m.complete && m.naturalWidth > 0 : !!m.poster || m.readyState > 0));
    });
    return { cards: cards.length, empty: empty.map((c) => c.getAttribute("data-example")), skeletons: document.querySelectorAll("[data-example-skeleton]").length };
  });
}

const { who, cookie } = await session();
if (who !== "guest") check(`${who}: signed in`, !!cookie);
console.log(`as ${who}, in ${engine}`);
const browser = engine === "chromium" ? await launch() : await loadPlaywright()[engine].launch();
/** Shots in another engine carry its name. */
const tag = engine === "chromium" ? who : `${who}-${engine}`;

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    // Firefox has no mobile emulation: its phone is the phone's width and touch.
    const mobile = engine === "firefox" ? {} : { isMobile: size.isMobile };
    const context = await browser.newContext({ viewport: size.viewport, ...mobile, hasTouch: size.hasTouch, colorScheme: scheme });
    if (cookie) {
      const [name, value] = cookie.split("=");
      await context.addCookies([{ name, value, url: app }]);
    }
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const step = stepFor(size.viewport.width);
    for (const url of [...STUDIOS, ...SECTIONS]) {
      const label = `${url} (${size.name}, ${scheme})`;
      await openRoute(page, `${app}${url}`, { settleMs: 1500 });
      await page.locator("[data-examples]").first().waitFor({ timeout: 20_000 }).catch(() => {});
      const m = await page.evaluate(measure);
      if (!m.heading) {
        // An owner or an account with results sees the feed instead: nothing to check here.
        const hasFeed = (await page.locator("[data-studio] [data-composer]").count()) && !(await page.locator("[data-studio] h2.text-display").count());
        console.log(`skip ${label}: no row${hasFeed ? " (results shown)" : ""}`);
        continue;
      }
      check(`${label}: no sideways scroll`, m.page.scrollW <= m.page.w + 1, `${m.page.scrollW} > ${m.page.w}`);
      check(`${label}: the heading is on the cards' left edge`, near(m.heading.l, m.grid?.l) && m.headingAlign !== "center", `${m.heading.l} vs ${m.grid?.l} (${m.headingAlign})`);
      check(`${label}: a fixed step from the heading to the cards`, near(m.grid?.t - m.heading.b, HEADING_STEP), `${Math.round(m.grid?.t - m.heading.b)} px`);
      if (m.composer) {
        check(`${label}: a fixed step under the composer`, near(m.heading.t - m.above.b, step), `${Math.round(m.heading.t - m.above.b)} px, want ${step}`);
        check(`${label}: the row starts at the composer's left edge`, near(m.grid.l, m.composer.l), `${m.grid.l} vs ${m.composer.l}`);
        check(`${label}: the row is no wider than the composer`, m.grid.r <= m.composer.r + 1.5, `${m.grid.r} vs ${m.composer.r}`);
      } else {
        check(`${label}: clear space above the row`, m.previous && m.heading.t - m.previous.b >= 32, m.previous ? `${Math.round(m.heading.t - m.previous.b)} px` : "nothing above");
        check(`${label}: the row stays inside the page`, m.grid.l >= 15 && m.grid.r <= m.page.w - 15, `${m.grid.l}-${m.grid.r}`);
        if (BOXED.has(url))
          check(
            `${label}: the row lines up with the box above it`,
            m.previous && near(m.grid.l, m.previous.l) && near(m.grid.r, m.previous.r),
            m.previous ? `row ${Math.round(m.grid.l)}-${Math.round(m.grid.r)}, box ${Math.round(m.previous.l)}-${Math.round(m.previous.r)}` : "nothing above",
          );
        if (COLUMNED.has(url))
          check(`${label}: the row fills the page's column`, near(m.grid.l, m.column?.l) && near(m.grid.r, m.column?.r), `row ${Math.round(m.grid.l)}-${Math.round(m.grid.r)}, column ${Math.round(m.column?.l)}-${Math.round(m.column?.r)}`);
        if (TITLED.has(url)) check(`${label}: the row starts at the page title's edge`, near(m.grid.l, m.title?.l), `${m.grid.l} vs ${m.title?.l}`);
      }
      const filled = await cardsFilled(page);
      const lined = await page.evaluate(measure);
      check(`${label}: the pictures in each line of cards share one top`, !lined.misaligned.length, lined.misaligned.join(", ") || "");
      check(`${label}: no grey or empty card after load`, filled.cards > 0 && !filled.empty.length && !filled.skeletons, `${filled.cards} cards, empty ${filled.empty.join(",") || "none"}, skeletons ${filled.skeletons}`);
      if (shots && (url === "/image" || url === "/genjutsu")) {
        await page.evaluate(() => {
          const c = document.querySelector("[data-studio] [data-composer]") ?? document.querySelector("[data-examples]");
          if (c) window.scrollTo(0, Math.max(0, c.getBoundingClientRect().top + scrollY - 140));
        });
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(shots, `${url.replace(/\W+/g, "_").replace(/^_/, "")}-${tag}-${size.name}-${scheme}.png`) });
      }
    }

    // The loading state on /image and /video: hold every script that starts after the feed answers (the cards' code among
    // them), once, until the skeleton is measured.
    for (const url of LOADING) {
      const label = `${url} loading (${size.name}, ${scheme})`;
      const held = await context.newPage();
      let hold = false;
      let fed = false;
      let released = false;
      const waiting = [];
      await held.route("**/_next/static/chunks/**", async (route) => {
        if (hold) await new Promise((r) => waiting.push(r));
        await route.continue().catch(() => {});
      });
      held.on("response", (r) => {
        if (new URL(r.url()).pathname !== "/api/generations") return;
        fed = true;
        // A feed that answers after the release (a slow first answer) holds nothing: the release is for good.
        if (!released) hold = true;
      });
      // Not "load": when the feed answers first, the held scripts can be ones the load event waits for.
      await held.goto(`${app}${url}`, { waitUntil: "commit", timeout: 60_000 });
      await held.locator("[data-examples-loading], [data-examples]").first().waitFor({ timeout: 30_000 }).catch(() => {});
      for (let waited = 0; !fed && waited < 15_000; waited += 250) await held.waitForTimeout(250);
      await held.waitForTimeout(1500);
      const before = await held.evaluate(measure);
      const loading = before.loading;
      if (!before.heading) console.log(`skip ${label}: no row (results shown)`);
      else {
        check(`${label}: the skeleton has the row's heading`, loading ? before.headingText.length > 0 : true, before.headingText);
        if (shots && loading) await held.screenshot({ path: path.join(shots, `${url.slice(1)}-loading-${tag}-${size.name}-${scheme}.png`) });
        hold = false;
        released = true;
        waiting.splice(0).forEach((r) => r());
        await held.locator("[data-examples]").first().waitFor({ timeout: 30_000 }).catch(() => {});
        await held.waitForTimeout(500);
        const after = await held.evaluate(measure);
        check(`${label}: the cards replace the skeleton`, !after.loading && after.headingText === before.headingText, `${before.headingText} -> ${after.headingText}${fed ? "" : " (the feed never answered)"}`);
        // Heights are from the composer's bottom: a line above the composer that comes with the viewer (a guest's, once
        // known) is not the row's to hold, and in WebKit it can land between the two measures.
        const fromB = (m) => (t) => (t == null ? t : t - (m.composer?.b ?? 0));
        const [b, a] = [fromB(before), fromB(after)];
        const shifted = Math.round((after.composer?.b ?? 0) - (before.composer?.b ?? 0));
        check(
          `${label}: nothing moves when the cards arrive`,
          near(b(before.heading.t), a(after.heading.t)) && near(b(before.grid.t), a(after.grid.t)) && near(before.grid.l, after.grid.l) && near(before.grid.r, after.grid.r) && near(before.firstCard?.w, after.firstCard?.w),
          `heading ${Math.round(before.heading.t)}->${Math.round(after.heading.t)}, grid ${Math.round(before.grid.l)}-${Math.round(before.grid.r)} -> ${Math.round(after.grid.l)}-${Math.round(after.grid.r)}${shifted ? ` (the composer moved ${shifted} px)` : ""}`,
        );
        if (loading)
          check(
            `${label}: each card's picture stays where its skeleton was`,
            before.pictures.length === after.pictures.length && before.pictures.every((t, i) => near(b(t), a(after.pictures[i]))),
            `${before.pictures.map(Math.round).join("/")} -> ${after.pictures.map(Math.round).join("/")}${shifted ? ` (the composer moved ${shifted} px)` : ""}`,
          );
        if (!loading) console.log(`note ${label}: the cards were already there (no skeleton seen)`);
      }
      hold = false;
      released = true;
      waiting.splice(0).forEach((r) => r());
      await held.close();
    }
    await context.close();
  }
}

await browser.close();
console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
