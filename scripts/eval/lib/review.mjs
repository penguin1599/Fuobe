// Blind A/B review: a static page per run (review/index.html) shows two results side by side in an
// order the page can't reveal — a Fuobe output against your own reference (local/references/…),
// another variant of the same case and seed, or the same job in another run. You rate with the
// keyboard; ratings land in review/ratings.json (pnpm eval:review serves the page and saves them;
// opened as a file it keeps them in the browser and offers a download). review/key.json, which the
// page never loads, says which side was which; the summary unblinds the ratings with it.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { esc, page } from "./html.mjs";
import { candidateOf, latestJobs, readJson, writeJson } from "./store.mjs";

const IMAGE = /\.(png|jpe?g|webp|gif|svg)$/i;
const VIDEO = /\.(mp4|mov|m4v|webm)$/i;
const AUDIO = /\.(flac|wav|mp3|m4a|ogg)$/i;
/** The one format a blind audio pair is served in (lossless; every current browser plays it). */
const AUDIO_EXT = ".flac";
/** A sound re-encoded as FLAC for the review; false when ffmpeg can't (the file is then served as it is, under the FLAC name). */
function toAudio(file, dest) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-vn", "-c:a", "flac", dest], { stdio: "ignore" });
  return r.status === 0 && fs.existsSync(dest);
}
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** The first picture or clip of a succeeded row (helpers like masks left out); a separation's first stem. */
const mainOutput = (row) => (row.outputs ?? []).find((o) => (o.kind === "image" || o.kind === "video") && !["mask", "first-frame", "depth"].includes(o.role)) ?? (row.outputs ?? []).find((o) => o.kind === "audio");

/** What a separation's two stems are judged on, blind (the words above each pair). */
const STEM_ASKS = {
  voice: "Dialogue: which is clearer, with the least music, effects or noise left in it?",
  background: "Music & effects: which keeps the music and effects fuller, with no speech left in it?",
};

/** The results to pair for a row: a separation's dialogue and its music & effects (each judged on its own), else the main output. */
function sidesOf(row) {
  const audio = (row.outputs ?? []).filter((o) => o.kind === "audio");
  if (audio.length) {
    const pick = Object.keys(STEM_ASKS).flatMap((stem) => {
      const o = audio.find((x) => x.stem === stem);
      return o ? [{ out: o, stem, ask: STEM_ASKS[stem] }] : [];
    });
    if (pick.length) return pick;
  }
  const o = mainOutput(row);
  return o ? [{ out: o, stem: null, ask: null }] : [];
}

/**
 * The pairs to rate.
 * @param {{ dir: string, rows: object[] }} run
 * @param {{ against?: "variants" | "references" | { dir: string, runId: string, rows: object[] }, limit?: number, base?: string }} [opts]
 *   base: the variant paired with each of the others (default: the run's candidate, see candidateOf)
 */
export function buildPairs(run, opts = {}) {
  const ok = run.rows.filter((r) => r.status === "succeeded" && mainOutput(r));
  const variants = [...new Set(ok.map((r) => r.variant))];
  const against = opts.against ?? (variants.length > 1 ? "variants" : "references");
  const side = (label, file, extra = {}) => ({ label, file, ...extra });
  const pairs = [];
  if (against === "variants") {
    // The candidate against each alternative: the pairs the promote rule reads.
    const base = opts.base && variants.includes(opts.base) ? opts.base : candidateOf(run.run ?? readJson(path.join(run.dir, "run.json"), null), variants);
    const byKey = new Map(ok.map((r) => [`${r.key}|${r.variant}`, r]));
    for (const r of ok.filter((x) => x.variant === base)) {
      for (const v of variants.filter((x) => x !== base)) {
        const o = byKey.get(`${r.key}|${v}`);
        if (!o) continue;
        const theirs = sidesOf(o);
        for (const mine of sidesOf(r)) {
          const other = theirs.find((t) => t.stem === mine.stem);
          if (other) pairs.push({ a: side(base, path.join(run.dir, mine.out.file), { job: r.id, ...(mine.stem && { stem: mine.stem }) }), b: side(v, path.join(run.dir, other.out.file), { job: o.id, ...(mine.stem && { stem: mine.stem }) }), prompt: mine.ask ?? r.prompt, caseTitle: r.caseTitle, caseId: r.caseId });
        }
      }
    }
  } else if (against === "references") {
    for (const r of ok) {
      const out = mainOutput(r);
      const refs = (r.references ?? []).filter((f) => (out.kind === "video" ? VIDEO.test(f) || IMAGE.test(f) : IMAGE.test(f)) && fs.existsSync(f));
      if (!refs.length) continue;
      // Spread the references over the case's jobs, so one image isn't the yardstick for all of them.
      const ref = refs[parseInt(hash(r.id).slice(0, 8), 16) % refs.length];
      pairs.push({ a: side(r.variant, path.join(run.dir, out.file), { job: r.id }), b: side("reference", ref, { reference: ref }), prompt: r.prompt, caseTitle: r.caseTitle, caseId: r.caseId });
    }
  } else {
    const other = new Map(against.rows.filter((r) => r.status === "succeeded" && mainOutput(r)).map((r) => [`${r.key}|${r.variant}`, r]));
    for (const r of ok) {
      const o = other.get(`${r.key}|${r.variant}`);
      if (o) pairs.push({ a: side(`${r.variant} (this run)`, path.join(run.dir, mainOutput(r).file), { job: r.id }), b: side(`${o.variant} (${against.runId})`, path.join(against.dir, mainOutput(o).file), { job: o.id, run: against.runId }), prompt: r.prompt, caseTitle: r.caseTitle, caseId: r.caseId });
    }
  }
  return pairs.slice(0, opts.limit ?? Infinity).map((p) => {
    const id = hash(`${p.a.file}|${p.b.file}`).slice(0, 12);
    // Which side shows on the left comes from the pair's id, so rebuilding the page keeps it.
    const aLeft = parseInt(id.slice(-1), 16) % 2 === 0;
    return { id, ...p, aLeft, order: hash(`order|${id}`) };
  });
}

/** Write review/index.html, the media under neutral names, and review/key.json; returns the pair count. */
export function writeReview(run, opts = {}) {
  const pairs = buildPairs(run, opts).sort((x, y) => x.order.localeCompare(y.order));
  const out = path.join(run.dir, "review");
  const mediaDir = path.join(out, "media");
  fs.rmSync(mediaDir, { recursive: true, force: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  const placed = new Map();
  const place = (file, audio = false) => {
    const key = `${audio ? "a" : "m"}|${file}`;
    if (placed.has(key)) return placed.get(key);
    const name = `${hash(`media|${file}`).slice(0, 10)}${audio ? AUDIO_EXT : path.extname(file).toLowerCase()}`;
    const dest = path.join(mediaDir, name);
    if (!audio || path.extname(file).toLowerCase() === AUDIO_EXT || !toAudio(file, dest)) {
      try {
        fs.linkSync(file, dest);
      } catch {
        fs.copyFileSync(file, dest);
      }
    }
    placed.set(key, `media/${name}`);
    return `media/${name}`;
  };
  const items = pairs.map((p) => {
    const [left, right] = p.aLeft ? [p.a, p.b] : [p.b, p.a];
    // Two sounds are served in one format, so a file type (DBS's FLAC against MelBand's MP3) can't say which is which.
    const audio = [left.file, right.file].every((f) => AUDIO.test(f));
    return { id: p.id, prompt: p.prompt ?? "", title: p.caseTitle ?? "", left: place(left.file, audio), right: place(right.file, audio), video: [left.file, right.file].some((f) => VIDEO.test(f)), audio };
  });
  writeJson(path.join(out, "key.json"), {
    runId: run.runId,
    against: opts.against?.runId ?? opts.against ?? null,
    pairs: pairs.map((p) => ({ id: p.id, caseId: p.caseId, a: p.a, b: p.b, left: p.aLeft ? "a" : "b" })),
  });
  fs.writeFileSync(path.join(out, "index.html"), reviewHtml(run.runId, items));
  return { pairs: items.length, file: path.join(out, "index.html") };
}

/** The review page: one pair at a time, keyboard first, works on a phone. */
export function reviewHtml(runId, items) {
  const css = `
/* Both results stay side by side, on a phone too: an A/B is judged by looking at the two at once. */
.pair { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
.side { position: relative; border: 2px solid var(--border); border-radius: 12px; padding: 8px; background: var(--card); min-width: 0; }
.side.picked { border-color: var(--accent); }
.side .tag { position: absolute; top: 12px; left: 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 0 6px; font-weight: 600; }
.side .sound { padding: 40px 0 8px; }
.side img, .side video { width: 100%; max-height: 62vh; object-fit: contain; display: block; border-radius: 8px; background: var(--chip); }
.bar { position: sticky; bottom: 0; background: var(--bg); border-top: 1px solid var(--border); padding: 12px 0; margin-top: 16px; }
.bar .row { justify-content: center; }
.keys { text-align: center; margin-top: 8px; font-size: 12px; }
progress { width: 100%; height: 6px; accent-color: var(--accent); }
@media (max-width: 640px) {
  .pair { gap: 6px; }
  .side { padding: 4px; border-radius: 10px; }
  .side .tag { top: 8px; left: 8px; font-size: 12px; }
  .bar .row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .bar .btn { padding: 10px 6px; }
  .bar .btn.minor { grid-column: span 1; }
}
/* Touch screens: no keyboard hints. */
@media (hover: none) { .keys, .bar kbd { display: none; } }
`;
  const body = `<main>
<div class="row" style="justify-content:space-between"><h1>Blind review</h1><div class="row"><button class="btn" type="button" id="download">Download ratings</button><button class="btn" type="button" onclick="toggleTheme()">Light / dark</button></div></div>
<p class="muted">${esc(runId)} · Which result is better for the words below? The sides are shuffled; nothing on the page says which is which.</p>
<p class="muted" id="saved" role="status" aria-live="polite"></p>
<progress id="progress" max="${items.length}" value="0" aria-label="Pairs rated"></progress>
<p id="count" class="muted"></p>
<section id="stage" aria-live="polite"></section>
<div class="bar"><div class="row">
<button class="btn primary" type="button" data-choice="left"><kbd>←</kbd> Left is better</button>
<button class="btn" type="button" data-choice="same"><kbd>↓</kbd> Same</button>
<button class="btn primary" type="button" data-choice="right">Right is better <kbd>→</kbd></button>
<button class="btn minor" type="button" data-choice="skip"><kbd>S</kbd> Skip</button>
<button class="btn minor" type="button" id="undo"><kbd>U</kbd> Undo</button>
</div><p class="muted keys">Keys: <kbd>←</kbd>/<kbd>1</kbd> left · <kbd>→</kbd>/<kbd>2</kbd> right · <kbd>↓</kbd>/<kbd>0</kbd>/<kbd>Space</kbd> same · <kbd>S</kbd> skip · <kbd>U</kbd> undo</p></div>
</main>`;
  const script = `
const RUN = ${JSON.stringify(runId)};
const PAIRS = ${JSON.stringify(items).replaceAll("<", "\\u003c")};
const STORE = "fuobe-eval-ratings:" + RUN;
const served = location.protocol.startsWith("http");
let ratings = [];
try { ratings = JSON.parse(localStorage.getItem(STORE) || "[]"); } catch {}
let shownAt = performance.now();
const $ = (id) => document.getElementById(id);
const doneIds = () => new Set(ratings.map((r) => r.pair));
const next = () => PAIRS.find((p) => !doneIds().has(p.id));
function media(src, video, label, audio) {
  if (audio) return '<div class="sound"><audio src="' + src + '" controls preload="auto" aria-label="' + label + '"></audio></div>';
  return video ? '<video src="' + src + '" muted loop playsinline autoplay controls aria-label="' + label + '"></video>' : '<img src="' + src + '" alt="' + label + '">';
}
function render() {
  const p = next();
  const rated = ratings.filter((r) => r.choice !== "skip").length;
  $("progress").value = doneIds().size;
  $("count").textContent = doneIds().size + " of " + PAIRS.length + " pairs · " + rated + " rated";
  if (!PAIRS.length) { $("stage").innerHTML = "<p>There is nothing to compare in this run yet: it needs two variants of the same case, or your own references in scripts/eval/local/references/.</p>"; return; }
  if (!p) { $("stage").innerHTML = "<h2>All done</h2><p>Thanks — " + rated + " ratings. " + (served ? "They are saved in the run folder." : "Download them and put ratings.json in the run's review folder.") + "</p>"; return; }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  $("stage").innerHTML = '<p><b>' + esc(p.title) + '</b></p><p class="muted">' + esc(p.prompt) + '</p><div class="pair">' +
    '<div class="side" id="L"><span class="tag">Left</span>' + media(p.left, p.video, "Left result", p.audio) + '</div>' +
    '<div class="side" id="R"><span class="tag">Right</span>' + media(p.right, p.video, "Right result", p.audio) + '</div></div>';
  shownAt = performance.now();
}
async function persist() {
  try { localStorage.setItem(STORE, JSON.stringify(ratings)); } catch {}
  if (!served) { $("saved").textContent = "Saved in this browser. Download the ratings when you're done."; return; }
  try {
    const res = await fetch("ratings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: RUN, ratings }) });
    $("saved").textContent = res.ok ? "Saved to the run folder." : "Couldn't save to the run folder (" + res.status + "): they are kept in this browser.";
  } catch { $("saved").textContent = "The review server isn't answering: ratings are kept in this browser."; }
}
function rate(choice) {
  const p = next();
  if (!p) return;
  const el = choice === "left" ? $("L") : choice === "right" ? $("R") : null;
  if (el) el.classList.add("picked");
  ratings.push({ pair: p.id, choice, at: new Date().toISOString(), ms: Math.round(performance.now() - shownAt) });
  persist();
  setTimeout(render, el ? 120 : 0);
}
function undo() { ratings.pop(); persist(); render(); }
document.querySelectorAll("[data-choice]").forEach((b) => b.addEventListener("click", () => rate(b.dataset.choice)));
$("undo").addEventListener("click", undo);
$("download").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ runId: RUN, ratings }, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "ratings.json"; a.click(); URL.revokeObjectURL(a.href);
});
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  // Space and Enter on a focused button press that button (a keyboard user's "Left is better"), and a focused
  // clip keeps its own keys: only the page's shortcuts are taken here.
  const control = e.target instanceof Element ? e.target.closest("button, a, input, select, textarea, summary, video, audio, [contenteditable]") : null;
  if (control && (k === " " || k === "Enter")) return;
  if (control && (control.tagName === "VIDEO" || control.tagName === "AUDIO") && k.startsWith("Arrow")) return;
  const choice = k === "ArrowLeft" || k === "1" ? "left" : k === "ArrowRight" || k === "2" ? "right" : k === "ArrowDown" || k === "0" || k === " " ? "same" : k === "s" || k === "S" ? "skip" : null;
  if (choice) { e.preventDefault(); rate(choice); }
  else if (k === "u" || k === "U" || k === "Backspace") { e.preventDefault(); undo(); }
});
(async () => {
  if (served) {
    try { const r = await fetch("ratings.json", { cache: "no-store" }); if (r.ok) { const d = await r.json(); if (Array.isArray(d.ratings) && d.ratings.length >= ratings.length) ratings = d.ratings; } } catch {}
  }
  render();
})();
`;
  return page({ title: `Blind review · ${runId}`, body, head: css, script });
}

/**
 * Ratings unblinded with the key: per pair of labels, how often each side won. With `caseId`, only that
 * case's pairs count (a look is judged on its own pictures), and `available` says how many pairs of each
 * kind the review offered for it.
 * @param {{ dir: string, rows?: object[], key?: object, ratings?: object }} loaded
 * @param {{ caseId?: string }} [opts]
 */
export function aggregateRatings(loaded, opts = {}) {
  const key = loaded.key ?? readJson(path.join(loaded.dir, "review", "key.json"), null);
  const ratings = loaded.ratings ?? readJson(path.join(loaded.dir, "review", "ratings.json"), null);
  // Keys written before pairs carried their case: the case of the job on either side.
  const caseOfJob = new Map((loaded.rows ?? []).map((r) => [r.id, r.caseId]));
  const caseOf = (p) => p.caseId ?? caseOfJob.get(p.a?.job) ?? caseOfJob.get(p.b?.job) ?? null;
  const keyPairs = (key?.pairs ?? []).filter((p) => !opts.caseId || caseOf(p) === opts.caseId);
  const available = {};
  for (const p of keyPairs) available[`${p.a.label}|${p.b.label}`] = (available[`${p.a.label}|${p.b.label}`] ?? 0) + 1;
  if (!key || !ratings?.ratings?.length) return { total: 0, pairs: [], ...(opts.caseId && { available }) };
  const byId = new Map(keyPairs.map((p) => [p.id, p]));
  const last = new Map();
  for (const r of ratings.ratings) last.set(r.pair, r);
  const groups = new Map();
  let total = 0;
  for (const r of last.values()) {
    const p = byId.get(r.pair);
    if (!p || r.choice === "skip") continue;
    total++;
    const g = groups.get(`${p.a.label}|${p.b.label}`) ?? { a: p.a.label, b: p.b.label, aWins: 0, bWins: 0, ties: 0 };
    const picked = r.choice === "same" ? null : r.choice === "left" ? p.left : p.left === "a" ? "b" : "a";
    if (picked === "a") g.aWins++;
    else if (picked === "b") g.bWins++;
    else g.ties++;
    groups.set(`${p.a.label}|${p.b.label}`, g);
  }
  return { total, pairs: [...groups.values()].map((g) => ({ ...g, preferA: g.aWins + g.bWins ? g.aWins / (g.aWins + g.bWins) : null })), ...(opts.caseId && { available }) };
}

const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/mp4", ".flac": "audio/flac", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg" };

/**
 * Serve a run's review folder on 127.0.0.1 and save ratings it POSTs. Only files inside review/
 * are served; the key stays private.
 */
export function serveReview(dir, { port = 0, host = "127.0.0.1" } = {}) {
  const root = path.join(dir, "review");
  /** The names this server answers to (set once it listens): another Host is a page that rebound its name here. */
  let hosts = new Set();
  const server = http.createServer(async (req, res) => {
    const send = (status, body, type = "text/plain; charset=utf-8") => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    if (!hosts.has(String(req.headers.host ?? "").toLowerCase())) return send(421, "not this server");
    let url;
    try {
      url = new URL(req.url ?? "/", "http://local");
    } catch {
      return send(400, "bad address");
    }
    if (req.method === "POST" && url.pathname === "/ratings") {
      // Only the review page itself saves ratings: a page from anywhere else can't (a cross-site form or
      // fetch either sends its own Origin, or can't send JSON without a preflight this server never answers).
      const origin = req.headers.origin;
      if (origin && !hosts.has(origin.replace(/^http:\/\//, "").toLowerCase())) return send(403, "ratings are saved from the review page only");
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return send(415, "send the ratings as application/json");
      let raw = "";
      for await (const c of req) {
        raw += c;
        if (raw.length > 5_000_000) return send(413, "too large");
      }
      let doc;
      try {
        doc = JSON.parse(raw);
      } catch {
        return send(400, "not JSON");
      }
      const valid = Array.isArray(doc?.ratings) && doc.ratings.every((r) => typeof r?.pair === "string" && ["left", "right", "same", "skip"].includes(r.choice));
      if (!valid) return send(400, "ratings must be [{pair, choice: left|right|same|skip}]");
      writeJson(path.join(root, "ratings.json"), { runId: path.basename(dir), savedAt: new Date().toISOString(), ratings: doc.ratings.map(({ pair, choice, at, ms }) => ({ pair, choice, at, ms })) });
      return send(204, "");
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "GET or POST /ratings");
    let rel;
    try {
      rel = decodeURIComponent(url.pathname === "/" ? "index.html" : url.pathname.slice(1));
    } catch {
      return send(400, "bad address");
    }
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep) || path.basename(abs) === "key.json") return send(404, "not found");
    fs.stat(abs, (err, st) => {
      if (err || !st.isFile()) return send(404, "not found");
      res.writeHead(200, { "content-type": TYPES[path.extname(abs).toLowerCase()] ?? "application/octet-stream", "content-length": st.size, "cache-control": "no-store" });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(abs).pipe(res);
    });
  });
  return new Promise((resolve) =>
    server.listen(port, host, () => {
      const p = server.address().port;
      hosts = new Set([`${host}:${p}`, `localhost:${p}`, `127.0.0.1:${p}`].map((h) => h.toLowerCase()));
      resolve({ server, url: `http://${host}:${p}/` });
    }),
  );
}

/** A run's rows, for building pairs against another run. */
export const runRows = (dir) => latestJobs(dir);
