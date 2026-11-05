#!/usr/bin/env node
/**
 * Larger copies of the template tiles' stills (src/lib/template-covers.ts), for boxes wider than the published poster
 * on a 2x or 3x screen (the bar's Canvas menu and its phone sheet): the poster at each width in WIDTHS past the
 * published one's and up to the render's own, as AVIF and JPEG, and an AVIF at 320 px. Made from the render the
 * published cover was cut from (the masters pnpm eval:covers --templates reads), never enlarged from the published copy.
 *
 * Input: one or more masters folders (--masters, in the order to try), each laid out as pnpm eval:covers --templates
 * reads it: <dir>/<group>/<tile id>/ holding clip.mp4 (and meta.json: { "rest": "end" | <seconds> }) or a still
 * (still.png …). A clip is cut as the published one is (coverLoop in scripts/eval/lib/covers.mjs), so its poster is
 * the same frame: its first, or the one it rests on. A reveal that comes with its last frame full size (poster.png)
 * takes that, as its published still does.
 *
 * Output:
 *   public/previews/templates/hd/<W>/<group>/<id>.avif, .jpg   the poster at width W
 *   public/previews/templates/hd/320/<group>/<id>.avif         its small AVIF (the 320 px JPEG is the published thumb)
 *   src/lib/template-hd.generated.ts   { "<group>/<id>": { w: [<widths>], v: "<version>" } }
 *
 * Check: each still is compared with the published poster (the mean difference of 128x96 grey copies, at most MATCH,
 * as scripts/gen-preset-hd.mjs checks): a render whose frame doesn't show what the tile shows is not used.
 *
 * Only tiles with a cover of their own (/previews/templates/<group>/<id>.jpg): a tile that shows a preset's cover
 * already has that preset's copies (scripts/gen-preset-hd.mjs).
 *
 * Run: node scripts/gen-template-hd.mjs --masters <dir> [--masters <dir> …] <group>/<id> …   make these
 *      node scripts/gen-template-hd.mjs -<group>/<id> …                                  take these out, with their files
 *      --dry-run makes and checks, and writes nothing.
 * Needs ffmpeg on PATH (or FUOBE_FFMPEG).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { contentVersion, coverLoop } from "./eval/lib/covers.mjs";
import { readTemplateManifest } from "./eval/lib/template-covers.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const OUT_DIR = path.join(PUBLIC, "previews", "templates", "hd");
const OUT_TS = path.join(ROOT, "src", "lib", "template-hd.generated.ts");
/** The copies' widths, as the preset clips' (gen-preset-hd.mjs): a 262 px menu tile at 2x takes 640, a 534 px lead 1024. */
const WIDTHS = [640, 1024];
/** The small AVIF's width, as the JPEG thumbs' (thumbOf). */
const SMALL_PX = 320;
/** A clip's published poster's width (covers.mjs CLIP_PX); a still's is wider (STILL_PX), and its entry says so. */
const PUBLISHED_PX = 512;
const AVIF_QUALITY = 62;
const JPEG_QUALITY = 82;
/** Each width's most bytes for a copy (tests/template-hd.test.ts holds them): a busy picture steps its quality down to fit. */
const MAX_BYTES = { 320: 30_000, 640: 120_000, 1024: 260_000 };
/** The lowest quality a copy steps down to, and the step. */
const MIN_QUALITY = 60;
const QUALITY_STEP = 4;
/** How far (of 255) a copy may differ from the published poster, on average (from its mean): another frame is 10 and more. */
const MATCH = 7;
const STILLS = ["still.png", "still.jpg", "still.webp", "start.png", "start.jpg"];

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const MASTERS = argv.flatMap((a, i) => (a === "--masters" && argv[i + 1] ? [argv[i + 1]] : []));
const named = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--masters");

const ffmpeg = (args, input) => {
  const r = spawnSync(process.env.FUOBE_FFMPEG ?? "ffmpeg", args, { input, maxBuffer: 1 << 30 });
  if (r.error?.code === "ENOENT") throw new Error("gen-template-hd needs ffmpeg on PATH");
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${String(r.stderr).trim().split("\n").at(-1)}`);
  return r.stdout;
};

const readTs = (file) => {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, "utf8");
  return JSON.parse(text.slice(text.indexOf("= {") + 2, text.lastIndexOf("}") + 1));
};

/** A copy's file: hd/<w>/<group>/<id>.<ext>. */
const fileOf = (w, key, ext) => path.join(OUT_DIR, String(w), ...key.split("/").slice(0, -1), `${key.split("/").at(-1)}.${ext}`);

/** Every file an entry has, in a fixed order (its version is theirs). */
const filesOf = (key, entry) => [...entry.w.flatMap((w) => [fileOf(w, key, "avif"), fileOf(w, key, "jpg")]), fileOf(SMALL_PX, key, "avif")];

/** A copy at `quality`, or at a lower one (down to MIN_QUALITY) when it would be larger than its width's MAX_BYTES. */
async function fitted(encode, quality, w) {
  let buf = await encode(quality);
  for (let q = quality - QUALITY_STEP; buf.length >= (MAX_BYTES[w] ?? Infinity) && q >= MIN_QUALITY; q -= QUALITY_STEP) buf = await encode(q);
  return buf;
}

/** As gen-preset-hd.mjs: the mean difference of two pictures' 128x96 grey copies, each from its own mean brightness. */
async function gap(a, b) {
  const grey = (x) => sharp(x).resize(128, 96, { fit: "fill" }).greyscale().raw().toBuffer();
  const [p, q] = await Promise.all([grey(a), grey(b)]);
  const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
  const [mp, mq] = [mean(p), mean(q)];
  let sum = 0;
  for (let i = 0; i < p.length; i++) sum += Math.abs(p[i] - mp - (q[i] - mq));
  return sum / p.length;
}

function readMeta(folder) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(folder, "meta.json"), "utf8"));
    return meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {};
  } catch {
    return {};
  }
}

/** A tile's master in one folder: its clip and where it rests, or its still; undefined when it has none there. */
function masterIn(dir, key) {
  const folder = path.join(dir, ...key.split("/"));
  if (!fs.existsSync(folder)) return undefined;
  const meta = readMeta(folder);
  const rest = meta.rest === "end" ? "end" : typeof meta.rest === "number" && Number.isFinite(meta.rest) && meta.rest >= 0 ? meta.rest : undefined;
  const clip = path.join(folder, "clip.mp4");
  const full = path.join(folder, "poster.png");
  if (fs.existsSync(clip)) return rest === "end" && fs.existsSync(full) ? { still: full } : { clip, rest };
  const still = STILLS.map((s) => path.join(folder, s)).find((f) => fs.existsSync(f));
  return still ? { still } : undefined;
}

/** The poster at width `w` as a PNG: the clip's frame it rests on (decoded as a browser shows it), or the still resized. */
async function posterAt(m, w) {
  if (m.still) return sharp(m.still).resize(w, null, { kernel: "lanczos3" }).png().toBuffer();
  const { looped, rest, stream } = coverLoop(m.clip, { rest: m.rest }, `scale=${w}:-2:flags=lanczos`);
  return ffmpeg(
    ["-v", "error", "-f", "yuv4mpegpipe", "-i", "-", "-frames:v", "1", "-vf", "scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd+full_chroma_int+lanczos,format=rgb24", "-c:v", "png", "-f", "image2pipe", "-"],
    stream([looped[rest ?? 0]]),
  );
}

const hd = readTs(OUT_TS);
const manifest = readTemplateManifest();
const failed = [];

async function make(key) {
  const entry = manifest[key];
  if (!entry) return failed.push({ key, why: "not in template-covers.generated.ts" });
  const poster = entry.poster.split("?")[0];
  if (poster !== `/previews/templates/${key}.jpg`) return failed.push({ key, why: `it shows another cover (${poster}): that one's copies serve it` });
  const published = path.join(PUBLIC, ...poster.split("/").filter(Boolean));
  const publishedW = (await sharp(published).metadata()).width;
  const misses = [];
  for (const dir of MASTERS) {
    const m = masterIn(dir, key);
    if (!m) continue;
    const own = m.still ? (await sharp(m.still).metadata()).width : probeWidth(m.clip);
    const widths = WIDTHS.filter((w) => w > publishedW && w <= own);
    if (!widths.length) {
      misses.push(`${dir}: its render is ${own} px wide (nothing past the published ${publishedW} px)`);
      continue;
    }
    const made = new Map();
    let largest;
    let ok = true;
    for (const w of widths) {
      const png = await posterAt(m, w);
      const d = await gap(png, published);
      console.log(`${key} ${w}: differs ${d.toFixed(2)} from the published poster`);
      if (d > MATCH) {
        misses.push(`${dir}: its ${w} px poster differs ${d.toFixed(2)} (> ${MATCH})`);
        ok = false;
        break;
      }
      made.set(fileOf(w, key, "avif"), await fitted((q) => sharp(png).avif({ quality: q, effort: 6 }).toBuffer(), AVIF_QUALITY, w));
      made.set(fileOf(w, key, "jpg"), await fitted((q) => sharp(png).jpeg({ quality: q, mozjpeg: true }).toBuffer(), JPEG_QUALITY, w));
      largest = png;
    }
    if (!ok) continue;
    made.set(fileOf(SMALL_PX, key, "avif"), await fitted((q) => sharp(largest).resize(SMALL_PX).avif({ quality: q, effort: 6 }).toBuffer(), AVIF_QUALITY, SMALL_PX));
    for (const [file, buf] of made) {
      console.log(`  ${path.relative(PUBLIC, file).split(path.sep).join("/")}  ${(buf.length / 1024).toFixed(1)} KB`);
      if (DRY) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
    }
    if (!DRY) hd[key] = { w: widths, ...(publishedW !== PUBLISHED_PX && { still: publishedW }) };
    return;
  }
  failed.push({ key, why: misses.length ? misses.join("; ") : "no master found" });
}

/** A clip's width. */
function probeWidth(file) {
  const r = spawnSync(process.env.FUOBE_FFPROBE ?? "ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width", "-of", "csv=p=0", file]);
  if (r.status !== 0) throw new Error(`ffprobe failed on ${file}`);
  return Number(String(r.stdout).trim().split("\n")[0]);
}

for (const arg of named.filter((a) => a.startsWith("-"))) {
  const key = arg.slice(1);
  if (hd[key] && !DRY) for (const f of filesOf(key, hd[key])) fs.rmSync(f, { force: true });
  delete hd[key];
  console.log(`${key}: taken out`);
}
const makes = named.filter((a) => !a.startsWith("-"));
if (makes.length && !MASTERS.length) throw new Error("copies are made from the renders: run with --masters <dir>");
for (const key of makes) await make(key);
if (failed.length) console.log(`not made: ${failed.map((f) => `${f.key} (${f.why})`).join(", ")}`);

if (!DRY) {
  const sorted = Object.entries(hd)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, e]) => {
      const files = filesOf(key, e);
      const missing = files.filter((f) => !fs.existsSync(f));
      if (missing.length) throw new Error(`${key}: ${missing.length} of its copies are missing (${path.relative(ROOT, missing[0])}): make it again, or take it out with -${key}`);
      return [key, { w: e.w, v: contentVersion(files), ...(e.still && { still: e.still }) }];
    });
  fs.writeFileSync(
    OUT_TS,
    `/**
 * Larger copies of template tiles' posters (public/previews/templates/hd/<w>/<group>/<id>), keyed by "<group>/<tile id>":
 * AVIF and JPEG at each width in \`w\`, and an AVIF at 320 px; \`still\`: the published poster's width, when it isn't a
 * clip's 512 px. \`v\` is the content version every copy's URL ends in (?v=), so copies made again get new URLs. Read
 * through src/lib/template-hd.ts. Generated by scripts/gen-template-hd.mjs: run it again rather than editing.
 */
export const TEMPLATE_HD: Record<string, { w: number[]; v: string; still?: number }> = {
${sorted.map(([key, e]) => `  ${JSON.stringify(key)}: ${JSON.stringify(e).replace(/,"/g, ', "').replace(/^\{/, "{ ").replace(/\}$/, " }")}`).join(",\n")}
};
`,
  );
  console.log(`wrote ${sorted.length} entries`);
}
