// Which URLs the browser checks visit: every page under src/app/(studio), with sample values for
// the dynamic segments. Pure (file system only) so vitest can check it too.
import fs from "node:fs";
import path from "node:path";

/** Static routes ("/", "/assist/skills") and dynamic patterns ("/cinema/[id]") under (studio). */
export function studioRoutes(root) {
  const base = path.join(root, "src/app/(studio)");
  const routes = [];
  const patterns = [];
  const walk = (dir, url, dynamic) => {
    if (fs.existsSync(path.join(dir, "page.tsx"))) (dynamic ? patterns : routes).push(url || "/");
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const seg = e.name;
      if (seg.startsWith("(")) walk(path.join(dir, seg), url, dynamic);
      else walk(path.join(dir, seg), `${url}/${seg}`, dynamic || seg.startsWith("["));
    }
  };
  walk(base, "", false);
  return { routes: routes.sort(), patterns: patterns.sort() };
}

/** Every mode path of the studio hubs (/audio/music, /video-tools/join…), read from src/lib/hubs.ts. */
export function hubModePaths(root) {
  const src = fs.readFileSync(path.join(root, "src/lib/hubs.ts"), "utf8");
  const block = /HUB_MODES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src)?.[1] ?? "";
  const out = [];
  for (const m of block.matchAll(/["']?([\w-]+)["']?:\s*\[([\s\S]*?)\]/g)) {
    const ids = [...m[2].matchAll(/id:\s*"([\w-]+)"/g)].map((x) => x[1]);
    // Every mode has a path of its own (the first one is also the hub's own page).
    for (const id of ids) out.push(`/${m[1]}/${id}`);
  }
  return out;
}

/**
 * Sample URLs for the dynamic patterns. `ids` holds ids created for the run (cinema, canvas,
 * assistProject). Unknown ids are included on purpose: their not-found pages must fit too. A
 * pattern with no explicit sample (a route another branch adds) gets one with "does-not-exist"
 * for each [param], so every dynamic page is visited at least through its not-found state;
 * `generated` lists those patterns.
 */
export function dynamicSamples(root, ids = {}) {
  const samples = {
    "/apps/[id]": ["/apps/app-face-swap", "/apps/app-packshot", "/apps/does-not-exist"],
    "/elements/[id]": ["/elements/does-not-exist"],
    "/cinema/[id]": [ids.cinema && `/cinema/${ids.cinema}`, "/cinema/does-not-exist"],
    "/canvas/[id]": [ids.canvas && `/canvas/${ids.canvas}`, "/canvas/does-not-exist"],
    "/assist/projects/[id]": [ids.assistProject && `/assist/projects/${ids.assistProject}`, "/assist/projects/does-not-exist"],
  };
  const hubs = hubModePaths(root);
  const { patterns } = studioRoutes(root);
  const urls = [];
  /** @type {Record<string, string[]>} */
  const byPattern = {};
  const generated = [];
  for (const p of patterns) {
    const hub = /^\/([\w-]+)\/\[mode\]$/.exec(p);
    let list = hub ? hubs.filter((h) => h.startsWith(`/${hub[1]}/`)) : (samples[p] ?? []).filter(Boolean);
    if (!list.length) {
      // [id], [...slug] and [[...slug]] alike: one unknown value per segment.
      list = [p.replace(/\[\[?(?:\.\.\.)?[\w-]+\]?\]/g, "does-not-exist")];
      generated.push(p);
    }
    byPattern[p] = list;
    urls.push(...list);
  }
  return { urls, byPattern, generated };
}

/**
 * Pages a query opens a dialog on, with sample values: `ids.recipeSkill` names a skill with a recipe (its Run form,
 * /assist/skills?run=…); an unknown one is visited too (the form says so in the dialog).
 */
export function querySamples(ids = {}) {
  // Genjutsu's From picture and Finish tabs (a visitor lands on Motion transfer until they open), and Marketing's
  // code-drawn templates open in their own panel (a tall one, a 4:5 one with cards, one with a picture, the end card).
  const kinetic = ["ms-kinetic-headline", "ms-feature-cards", "m2-line-reveal", "ms-end-card"].map((id) => `/marketing?template=${id}`);
  return [ids.recipeSkill && `/assist/skills?run=${ids.recipeSkill}`, "/assist/skills?run=does-not-exist", "/genjutsu?mode=picture", "/genjutsu?mode=finish", ...kinetic].filter(Boolean);
}
