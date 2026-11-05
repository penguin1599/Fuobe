#!/usr/bin/env node
/**
 * Media and data for Home's first screen (src/components/home/home-bento.tsx): the video tile's reel of clips and its
 * poster, the 3D tile's clip and its poster, each in several widths, and AVIF copies of pictures the site already
 * publishes (the Audio tile's two photos among them, from Clean up voice's demo). Nothing is rendered: every file is a
 * copy of a published picture or of the full-size render a published clip was cut from, so the tiles show exactly what
 * the studios show, only sharper.
 *
 * Output (public/previews/home/):
 *   reel-<name>-{640,1024}.mp4                each clip of the video tile's reel (REEL), and at 1536 and 2048 where its
 *                                             2048 px master is in the masters folder
 *   reel-sand-storm-<width>.avif              the reel's first clip's first frame at each of its widths: the tile's poster
 *   rotation-{640,1024,1536,2048}.{mp4,avif}  the turning gown (the 3D tile) at four widths, and each one's first frame
 *   reel-sand-storm-1024.jpg, rotation-1024.jpg the 1024 px clips' first frames, for a browser without AVIF
 *   image-4-{480,768}.avif                the Image studio's example 4
 *   voice-{room,quiet}-{480,768,1024}.avif  Clean up voice's demo photos (public/samples/clean-voice/): the restaurant,
 *                                         and the same photo softened around her, which the Audio tile shows once the
 *                                         noise is off; voice-{room,quiet}-1024.jpg for a browser without AVIF
 *   genjutsu-<name>-{640,768,1024}.mp4    each clip of the Genjutsu tile's reel (WIPES): a swap shown as it happens, the
 *                                         original clip and the swapped one under a divider that sweeps across them
 *   genjutsu-couple-{640,768,1024}.avif   the reel's first clip's first frame at each width: the tile's poster
 *   genjutsu-couple-1024.jpg              the 1024 px clip's first frame, for a browser without AVIF
 *   genjutsu-couple-split-{640,768,1024}.avif  a frame of that clip split down the middle (original | swapped): the
 *                                         tile's still under reduced motion
 *   board-{photo,film}.webp               the Canvas board's photo and a frame of its film, 168 px squares
 * and src/lib/home-bento.generated.ts: each file's content version, the reel (its clips in order, each one's length and
 * framing, and where set how long it holds its last frame and fades out), the Genjutsu reel (each clip's labels and
 * where its divider is on every frame), and each poster's mean colour.
 *
 * The reel: the video tile plays these clips one after another, each once, and crossfades into the next (after the
 * last, back to the first). Each is a stretch of its preset's full-size render: `from` (its first frame in the render)
 * and `frames` long, at CLIP_FPS, with no loop of its own. The 3D tile's clip is the published clip's own cut
 * (scripts/eval/lib/covers.mjs: its first CLIP_SECONDS at CLIP_FPS, looped the same way), made again from the full-size
 * render instead of the 512 px copy. All are H.264 High (a CRF per clip and width, faststart, no sound), tagged BT.709
 * so every browser shows their colours the same way. Each tile picks the width its box needs on the screen it is on
 * (bento-islands.tsx).
 *
 * The posters: the reel's first clip's and the 3D clip's own first frame, decoded from the encoded file the way a
 * browser shows it (BT.709, limited range), at POSTER_QUALITY: the tile shows it until its clip plays, and the clip
 * takes over on that same frame, so the swap can't be seen. They are made again from the clips on every run, with or without masters.
 *
 * Masters: the full-size renders are not in the repo. With --masters <dir> (or FUOBE_HOME_MASTERS) the clips, their
 * posters and the before/after copies are made from the files in it:
 *   <dir>/<preset>.mp4             the full-size render each reel clip and the 3D clip are cut from (1024 x 768, 24 fps)
 *   <dir>/<preset>-2048.mkv        the same render upscaled to 2048 x 1536, every frame (SeedVR2 7B, lossless FFV1,
 *                                  BT.709), for the 1536 and 2048 px copies: the 3D clip needs it; a reel clip without
 *                                  one comes at 640 and 1024 only
 *   <dir>/genjutsu-<name>-swap.mp4      each Genjutsu clip's swapped take as the model made it (24 fps)
 *   <dir>/genjutsu-<name>-original.mp4  the clip it was made from, as it went in
 * Without it those files are kept as they are (and versioned; a reel clip in the widths it has), the posters are made
 * again from the clips kept, and so is the rest.
 *
 * Run: node scripts/gen-home-bento.mjs            make every file and the generated module
 *      node scripts/gen-home-bento.mjs --dry-run  make and measure, write nothing
 * Needs ffmpeg on PATH (or FUOBE_FFMPEG).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { CLIP_FPS, CLIP_SECONDS, LOOP_FADE, contentVersion, loopsAlready, readY4m, seamless } from "./eval/lib/covers.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const OUT_DIR = path.join(PUBLIC, "previews", "home");
const OUT_TS = path.join(ROOT, "src", "lib", "home-bento.generated.ts");
const DRY = process.argv.includes("--dry-run");
const argAt = process.argv.indexOf("--masters");
const MASTERS = argAt > 0 ? process.argv[argAt + 1] : process.env.FUOBE_HOME_MASTERS;

/**
 * The video tile's reel, in the order it plays: each clip's preset, the name of its copies here, the stretch of its
 * render it plays (`from`, its first frame; `frames`, at CLIP_FPS), where the tile anchors it (its object-position:
 * the tile is wider than the 4:3 clip, so only its top and bottom are cropped), and the CRF each width is encoded at
 * (chosen on close crops of faces and fine detail against the render; a busy picture, such as One Take's leaves, costs
 * more bits). The stretches are the ones that hold up frame by frame at the tile's size: One Take from the arch to its
 * look back (the render's last frame) and Sand Storm from the first gust until the sand has wrapped round her (the render's last second relights the shot). The first clip's first frame is the
 * tile's poster. `hold` and `fade` (ms, src/lib/home-reel.ts ReelClip): One Take ends on her face, so it holds that
 * last frame a moment before the next clip comes in, and crossfades out quicker, so the two faces barely overlap.
 */
export const REEL = [
  { id: "effect-sand-storm", name: "reel-sand-storm", from: 0, frames: 96, position: "50% 0%", crf: { 640: 22, 1024: 22, 1536: 26, 2048: 27 } },
  { id: "motion-one-take", name: "reel-one-take", from: 28, frames: 96, position: "50% 15%", hold: 450, fade: 350, crf: { 640: 22, 1024: 23, 1536: 27, 2048: 28 } },
];
/**
 * The 3D tile's clip: its published preset, the name of its copies here, and the CRF each width is encoded at (the
 * wider copies, made from the 2048 px master, at a higher CRF: their pixels are smaller on the screen).
 */
const LOOPS = [{ key: "app-3d-rotation", name: "rotation", crf: { 640: 23, 1024: 23, 1536: 27, 2048: 28 } }];
/**
 * The Genjutsu tile's reel (BENTO_GENJUTSU in src/lib/home-bento.ts), in the order it plays: each clip shows a swap as
 * it happens. It opens on the original clip; then a divider sweeps across from the left with the swapped take behind
 * it (the two play in step, frame for frame), and the rest of the take plays swapped. Its masters are
 * `<name>-swap.mp4` and `<name>-original.mp4`. `render`: the size the model made the swap at; the original is fitted
 * to it as the model fitted it (scaled to cover it, centred), so the two line up to the pixel. `sweep`: where the
 * divider is, as [frame, share of the width swapped] keyframes, eased in and out between them (the couple's rests
 * between the two people, one swapped and one not, before it goes on). `labels`: the words either side of the divider
 * (the tile sets them over the clip, in step with it). Each clip holds its last frame `hold` frames and fades it to the
 * tiles' dark colour over the last `fadeOut`, so the next one comes in over dark (a crossfade would lay one face over
 * another). `still`: the frame of the first clip that is the tile's still under reduced motion (the sweep at rest, half
 * and half). The CRFs were chosen on close crops of the faces and the divider against the frames before encoding.
 */
export const WIPES = [
  { name: "genjutsu-couple", render: [992, 736], labels: ["Original", "Swapped"], sweep: [[30, 0], [44, 0.5], [54, 0.5], [68, 1]], still: 46, frames: 124, hold: 8, fadeOut: 8, crf: { 640: 24, 768: 24, 1024: 23 } },
  { name: "genjutsu-lakeside", render: [1024, 768], labels: ["Original", "Swapped"], sweep: [[18, 0], [56, 1]], frames: 124, hold: 8, fadeOut: 8, crf: { 640: 24, 768: 24, 1024: 23 } },
];
/** The widths the Genjutsu clips come in: their renders are about 1024 px wide, and nothing is made up past that. */
const WIPE_WIDTHS = [640, 768, 1024];
/**
 * The divider, in shares of the frame's width: a white line WIPE_LINE wide (at least 1.5 px) in a soft shade
 * WIPE_SHADE either side, over a seam feathered across WIPE_FEATHER. It starts and ends WIPE_MARGIN outside the frame,
 * shade and all, so the first and last frames are whole.
 */
const WIPE_LINE = 0.003;
const WIPE_SHADE = 0.011;
const WIPE_FEATHER = 0.004;
const WIPE_MARGIN = 0.03;

/** The share of the width swapped at frame `f` (cosine-eased between the keyframes of `sweep`). */
export function sweepAt(sweep, f) {
  if (f <= sweep[0][0]) return sweep[0][1];
  for (let i = 1; i < sweep.length; i++) {
    const [f0, p0] = sweep[i - 1];
    const [f1, p1] = sweep[i];
    if (f <= f1) return p0 + (p1 - p0) * (0.5 - 0.5 * Math.cos((Math.PI * (f - f0)) / (f1 - f0)));
  }
  return sweep.at(-1)[1];
}
/** Where the divider's middle is at frame `f`, as a share of the frame's width (outside 0..1 at either end). */
export const lineAt = (sweep, f) => sweepAt(sweep, f) * (1 + 2 * WIPE_MARGIN) - WIPE_MARGIN;

/**
 * A clip of the reel at `width` (4:3): the original and the swap fitted to the same frame, the swap left of the
 * divider and the original right of it, each frame's divider at lineAt(); then its last frame held and faded out.
 * Returns its y4m stream.
 */
export function wipeAt(c, width) {
  const height = (width * 3) / 4;
  const [rw, rh] = c.render;
  // Both are scaled to cover the 4:3 frame, centred.
  const cover = `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height}`;
  const decode = (file, fit) =>
    readY4m(ffmpeg(["-v", "error", "-i", path.join(MASTERS, file), "-an", "-sn", "-dn", "-vf", `fps=${CLIP_FPS},trim=end_frame=${c.frames},setpts=PTS-STARTPTS,${fit}${cover},format=yuv420p`, "-f", "yuv4mpegpipe", "-"]));
  // The original, fitted to the render's size as the model fitted it (scaled to cover it, centred).
  const swap = decode(`${c.name}-swap.mp4`, `scale=${rw}:${rh}:flags=lanczos,`);
  const orig = decode(`${c.name}-original.mp4`, `scale=${rw}:${rh}:force_original_aspect_ratio=increase:flags=lanczos,crop=${rw}:${rh},`);
  if (swap.frames.length !== c.frames || orig.frames.length !== c.frames) throw new Error(`${c.name}: ${swap.frames.length} and ${orig.frames.length} frames, not ${c.frames}`);
  const W = width;
  const cw = W / 2;
  const ch = height / 2;
  const line = Math.max(1.5, WIPE_LINE * W);
  const shade = WIPE_SHADE * W;
  const feather = WIPE_FEATHER * W;
  const frames = swap.frames.map((s, f) => {
    const x = lineAt(c.sweep, f) * W;
    // Per column (x at its centre, in luma pixels): how much is the swap, how much shade, how much white line.
    const weights = (cx) => {
      const d = cx - x;
      const t = Math.min(1, Math.max(0, 0.5 - d / feather));
      const swapW = t * t * (3 - 2 * t);
      const dark = 0.32 * Math.exp(-((d / shade) ** 2));
      const white = Math.min(1, Math.max(0, Math.min(cx + 0.5, x + line / 2) - Math.max(cx - 0.5, x - line / 2)));
      return [swapW, dark, white];
    };
    const ly = Array.from({ length: W }, (_, i) => weights(i + 0.5));
    const lc = Array.from({ length: cw }, (_, i) => weights(2 * i + 1));
    const o = orig.frames[f];
    const out = Buffer.alloc(s.length);
    const mix = (a, b, [sw, dark, white], blackV, whiteV, i) => {
      let v = b[i] + (a[i] - b[i]) * sw;
      v = blackV + (v - blackV) * (1 - dark);
      v = v + (whiteV - v) * white;
      out[i] = Math.round(v);
    };
    for (let y = 0; y < height; y++) for (let i = 0; i < W; i++) mix(s, o, ly[i], 16, 235, y * W + i);
    for (const base of [W * height, W * height + cw * ch])
      for (let y = 0; y < ch; y++) for (let i = 0; i < cw; i++) mix(s, o, lc[i], 128, 128, base + y * cw + i);
    return out;
  });
  const y4m = Buffer.concat([Buffer.from(`${swap.header}\n`, "latin1"), ...frames.flatMap((fr) => [Buffer.from("FRAME\n"), fr])]);
  const total = c.frames + c.hold;
  return ffmpeg(
    ["-v", "error", "-f", "yuv4mpegpipe", "-i", "-", "-vf", `tpad=stop_mode=clone:stop=${c.hold},fade=t=out:start_frame=${total - c.fadeOut}:nb_frames=${c.fadeOut - 1}:color=${FADE_COLOR},format=yuv420p`, "-f", "yuv4mpegpipe", "-"],
    y4m,
  );
}
/** The colour a clip fades out to before it loops: the tiles' dark media colour (globals.css --media). */
const FADE_COLOR = "0x0d0d0f";
/** The widths each clip and its poster are made at: a tile takes the first at least as wide as its box needs. */
const CLIP_WIDTHS = [640, 1024, 1536, 2048];
/** The widths a reel clip is made at from its render alone (wider ones need its 2048 px master). */
const RENDER_WIDTHS = [640, 1024];
/** From this width up, a clip is made from its 2048 px master (`<key>-2048.mkv`) instead of the render itself. */
const HD_FROM = 1536;
/** The width of each clip's first frame as a JPEG, the poster for a browser without AVIF (BENTO_CLIP_FALLBACK). */
const FALLBACK_WIDTH = 1024;
/** The Canvas board's two pictures (src/lib/home-bento.ts, BENTO_BOARD): the photo going in and a frame of the film. */
const BOARD_THUMBS = [
  { name: "board-photo.webp", from: "/examples/effect-pearl-earring/1/in-image.jpg" },
  { name: "board-film.webp", from: "/previews/presets/peak/effect-pearl-earring.jpg" },
];
/**
 * The Audio tile's photos (BENTO_VOICE in src/lib/home-bento.ts): Clean up voice's demo photos, in the widths the tile
 * shows them at (up to a 3x phone's full row), and as a JPEG at FALLBACK_WIDTH.
 */
const VOICE = [
  { name: "voice-room", from: "/samples/clean-voice/room.webp" },
  { name: "voice-quiet", from: "/samples/clean-voice/quiet.webp" },
];
const VOICE_WIDTHS = [480, 768, 1024];
/**
 * Each copy: its name under previews/home (an AVIF, or a JPEG where it ends in .jpg), the published file it comes from,
 * its width, and a crop where it has one.
 */
const STILLS = [
  { name: "image-4-480.avif", from: "/examples/image/4/out.jpg", width: 480 },
  { name: "image-4-768.avif", from: "/examples/image/4/out.jpg", width: 768 },
  ...VOICE.flatMap((v) => [
    ...VOICE_WIDTHS.map((width) => ({ name: `${v.name}-${width}.avif`, from: v.from, width })),
    { name: `${v.name}-${FALLBACK_WIDTH}.jpg`, from: v.from, width: FALLBACK_WIDTH },
  ]),
];
/** AVIF quality: the copies sit under a dark shade, and each tile takes one at least as wide as it shows. */
const QUALITY = 55;
/** The clips' posters: close enough to the clip's own first frame that the swap from one to the other can't be seen. */
const POSTER_QUALITY = 65;
/**
 * The Genjutsu reel's poster: its first frame is full of fine detail (stone steps, leaves, carved balconies), so it is
 * encoded finer, to stay as close to its clip's first frame as the other posters are to theirs.
 */
const WIPE_POSTER_QUALITY = 80;
/** The colours every clip is tagged with (libx264 takes them as its own options): its poster is decoded the same way. */
const BT709 = ["-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709", "-color_range", "tv"];
/** The board's pictures show at 36 to 56 px: a 168 px square covers them on a 3x screen. */
const THUMB = 168;

const ffmpeg = (args, input) => {
  const r = spawnSync(process.env.FUOBE_FFMPEG ?? "ffmpeg", args, { input, maxBuffer: 1 << 30 });
  if (r.error?.code === "ENOENT") throw new Error("gen-home-bento needs ffmpeg on PATH");
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${String(r.stderr).trim().split("\n").at(-1)}`);
  return r.stdout;
};

/**
 * A clip's loop at `width`, cut as covers.mjs encode() cuts the published one: decoded at CLIP_FPS, its first
 * CLIP_SECONDS (and the frames the crossfade takes back), looped without a seam unless it loops already. Returns its
 * y4m stream.
 */
function loopAt(src, width) {
  const seconds = CLIP_SECONDS + LOOP_FADE / CLIP_FPS;
  const y4m = ffmpeg(["-v", "error", "-i", src, "-t", String(seconds), "-an", "-sn", "-dn", "-vf", `scale=${width}:-2:flags=lanczos,fps=${CLIP_FPS},format=yuv420p`, "-f", "yuv4mpegpipe", "-"]);
  const { header, frames, luma } = readY4m(y4m);
  const cut = frames.slice(0, CLIP_SECONDS * CLIP_FPS);
  const looped = loopsAlready(cut, luma) ? cut : seamless(frames, Math.min(LOOP_FADE, Math.floor(frames.length / 4)));
  const stream = (list) => Buffer.concat([Buffer.from(`${header}\n`, "latin1"), ...list.flatMap((fr) => [Buffer.from("FRAME\n"), fr])]);
  return { all: stream(looped), frames: looped.length };
}

/**
 * A reel clip at `width`: `frames` frames from frame `from` of the render (at CLIP_FPS), played once, no loop.
 * Returns its y4m stream.
 */
function cutAt(src, width, from, frames) {
  const y4m = ffmpeg(["-v", "error", "-i", src, "-an", "-sn", "-dn", "-vf", `fps=${CLIP_FPS},trim=start_frame=${from}:end_frame=${from + frames},setpts=PTS-STARTPTS,scale=${width}:-2:flags=lanczos,format=yuv420p`, "-f", "yuv4mpegpipe", "-"]);
  const got = readY4m(y4m).frames.length;
  if (got !== frames) throw new Error(`${path.basename(src)} has ${got} frames from frame ${from}, not ${frames}`);
  return y4m;
}

/** H.264 High, the published clip's loop, muted, its index at the front so it starts before it has all loaded. */
function encodeClipBuffer(y4m, crf) {
  const out = path.join(os.tmpdir(), `gen-home-bento-${process.pid}.mp4`);
  try {
    encodeClip(y4m, crf, out);
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(out, { force: true });
  }
}

function encodeClip(y4m, crf, out) {
  ffmpeg(["-v", "error", "-y", "-f", "yuv4mpegpipe", "-i", "-", "-an", "-c:v", "libx264", "-profile:v", "high", "-preset", "slow", "-tune", "film", "-crf", String(crf), "-g", String(2 * CLIP_FPS), "-pix_fmt", "yuv420p", ...BT709, "-map_metadata", "-1", "-movflags", "+faststart", out], y4m);
}

/** Frame `n` of a clip as a PNG, decoded from the encoded file as a browser shows it. */
function frameAt(file, n) {
  const vf = `trim=start_frame=${n},scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd+full_chroma_int+lanczos,format=rgb24`;
  return ffmpeg(["-v", "error", "-i", file, "-frames:v", "1", "-vf", vf, "-c:v", "png", "-f", "image2pipe", "-"]);
}

/** A clip's first frame as a PNG, decoded from the encoded file as a browser shows it. */
const firstFrame = (file) => frameAt(file, 0);

/**
 * A reel clip as the generated list holds it (and src/lib/home-reel.ts ReelClip reads it): `hold` and `fade` only where set.
 * @param {{ id: string; name: string; frames: number; position: string; hold?: number; fade?: number }} c
 */
export const reelEntry = ({ id, name, frames, position, hold, fade }) => ({ id, name, frames, fps: CLIP_FPS, position, ...(hold ? { hold } : {}), ...(fade ? { fade } : {}) });

async function main() {
  if (!DRY) fs.mkdirSync(OUT_DIR, { recursive: true });
  if (MASTERS && !fs.existsSync(MASTERS)) throw new Error(`no masters folder at ${MASTERS}`);
  const master = (name) => path.join(MASTERS, name);
  const versions = {};
  let total = 0;
  // Made from the masters when there are any; without them the files already here are kept (and versioned).
  // The reel's widths: 640 and 1024 from each render, the wider ones from its 2048 px master where there is one;
  // without masters, the widths already here.
  const reelWidths = (c) =>
    CLIP_WIDTHS.filter((w) =>
      MASTERS ? RENDER_WIDTHS.includes(w) || fs.existsSync(master(`${c.id}-2048.mkv`)) : fs.existsSync(path.join(OUT_DIR, `${c.name}-${w}.mp4`)),
    );
  const reel = REEL.map((c) => ({ ...c, widths: reelWidths(c) }));
  for (const c of reel) if (!RENDER_WIDTHS.every((w) => c.widths.includes(w))) throw new Error(`${c.name} is made from the full-size renders: run with --masters <dir>`);
  const fromMasters = [
    ...reel.flatMap((c) =>
      c.widths.map((w) => ({
        name: `${c.name}-${w}.mp4`,
        clip: true,
        make: () => encodeClipBuffer(cutAt(master(RENDER_WIDTHS.includes(w) ? `${c.id}.mp4` : `${c.id}-2048.mkv`), w, c.from, c.frames), c.crf[w]),
      })),
    ),
    ...LOOPS.flatMap((c) =>
      CLIP_WIDTHS.map((w) => ({
        name: `${c.name}-${w}.mp4`,
        clip: true,
        make: () => encodeClipBuffer(loopAt(master(w >= HD_FROM ? `${c.key}-2048.mkv` : `${c.key}.mp4`), w).all, c.crf[w]),
      })),
    ),
    ...WIPES.flatMap((c) =>
      WIPE_WIDTHS.map((w) => ({
        name: `${c.name}-${w}.mp4`,
        clip: true,
        make: () => encodeClipBuffer(wipeAt(c, w), c.crf[w]),
      })),
    ),
  ];
  for (const s of fromMasters) {
    const out = path.join(OUT_DIR, s.name);
    if (!MASTERS) {
      if (!fs.existsSync(out)) throw new Error(`${s.name} is made from the full-size renders: run with --masters <dir>`);
      console.log(`${s.name}  kept (no --masters)`);
    } else {
      const buf = await s.make();
      if (!s.clip) total += buf.length;
      console.log(`${s.name}  ${(buf.length / 1024).toFixed(1)} KB`);
      if (DRY) continue;
      if (!fs.existsSync(out) || !fs.readFileSync(out).equals(buf)) fs.writeFileSync(out, buf);
    }
    if (!DRY) versions[`/previews/home/${s.name}`] = contentVersion([out]);
  }
  // Each poster, from its clip as it is now (just made, or kept): the reel's first clip's, the 3D clip's and the
  // Genjutsu reel's first clip's.
  const posterSets = [{ name: reel[0].name, widths: reel[0].widths }, ...LOOPS.map((c) => ({ name: c.name, widths: CLIP_WIDTHS })), { name: WIPES[0].name, widths: WIPE_WIDTHS, quality: WIPE_POSTER_QUALITY }];
  const posters = posterSets.flatMap((c) => c.widths.map((w) => ({ name: `${c.name}-${w}.avif`, clip: `${c.name}-${w}.mp4`, quality: c.quality ?? POSTER_QUALITY })));
  const jobs = [
    ...posters.map((p) => ({
      ...p,
      make: () => {
        // A dry run writes no clip: it reads the one already here.
        return sharp(firstFrame(path.join(OUT_DIR, p.clip))).avif({ quality: p.quality, effort: 6 }).toBuffer();
      },
    })),
    // The Genjutsu tile's still under reduced motion: its first clip at rest, half and half, read from that clip.
    ...WIPE_WIDTHS.map((w) => ({
      name: `${WIPES[0].name}-split-${w}.avif`,
      make: () => sharp(frameAt(path.join(OUT_DIR, `${WIPES[0].name}-${w}.mp4`), WIPES[0].still)).avif({ quality: POSTER_QUALITY, effort: 6 }).toBuffer(),
    })),
    // For a browser without AVIF: the FALLBACK_WIDTH clip's first frame as a JPEG.
    ...posterSets.map((c) => ({
      name: `${c.name}-${FALLBACK_WIDTH}.jpg`,
      make: () => sharp(firstFrame(path.join(OUT_DIR, `${c.name}-${FALLBACK_WIDTH}.mp4`))).jpeg({ quality: 85, mozjpeg: true }).toBuffer(),
    })),
    ...STILLS.map((s) => ({
      ...s,
      make: () => {
        const img = sharp(path.join(PUBLIC, s.from));
        const sized = (s.crop ? img.extract(s.crop) : img).resize(s.width);
        return (s.name.endsWith(".jpg") ? sized.jpeg({ quality: 85, mozjpeg: true }) : sized.avif({ quality: QUALITY, effort: 6 })).toBuffer();
      },
    })),
    ...BOARD_THUMBS.map((s) => ({ ...s, make: () => sharp(path.join(PUBLIC, s.from)).resize(THUMB, THUMB, { fit: "cover", position: "attention" }).webp({ quality: 72 }).toBuffer() })),
  ];
  for (const s of jobs) {
    const buf = await s.make();
    total += buf.length;
    const out = path.join(OUT_DIR, s.name);
    console.log(`${s.name}  ${(buf.length / 1024).toFixed(1)} KB`);
    if (DRY) continue;
    // Only a changed picture is written, so its version (and URL) stays the same run to run.
    if (!fs.existsSync(out) || !fs.readFileSync(out).equals(buf)) fs.writeFileSync(out, buf);
    versions[`/previews/home/${s.name}`] = contentVersion([out]);
  }
  // Each poster's mean colour: its tile's background until the picture is in, so the first paint is never an empty box.
  const tints = {};
  for (const c of posterSets) {
    const { channels } = await sharp(path.join(OUT_DIR, `${c.name}-${FALLBACK_WIDTH}.jpg`)).stats();
    tints[c.name] = `#${channels.slice(0, 3).map((ch) => Math.round(ch.mean).toString(16).padStart(2, "0")).join("")}`;
  }
  console.log(`stills ${(total / 1024).toFixed(1)} KB (clips aside)`);
  if (DRY) return;
  const body = `/**
 * Home's first screen (src/components/home/home-bento.tsx): the content version of each file made for it, the video
 * tile's reel and the Genjutsu tile's, and each poster's mean colour. Generated by scripts/gen-home-bento.mjs: run it
 * again rather than editing.
 */
export const HOME_BENTO_MEDIA: Record<string, string> = ${JSON.stringify(versions, null, 2)};

/** The video tile's reel, in the order it plays: each clip's preset, its copies' name, its length and its framing. */
export const HOME_BENTO_REEL = ${JSON.stringify(
    REEL.map(reelEntry),
    null,
    2,
  )};

/**
 * The Genjutsu tile's reel, in the order it plays: each clip's copies' name, its length in frames (its held last frames
 * too), the words either side of its divider, where the divider is on each frame (a share of the frame's width, the
 * swap left of it), and the frame its fade out starts on.
 */
export const HOME_BENTO_GENJUTSU = ${JSON.stringify(
    WIPES.map((c) => ({
      name: c.name,
      frames: c.frames + c.hold,
      fps: CLIP_FPS,
      labels: c.labels,
      fadeFrom: c.frames + c.hold - c.fadeOut,
      line: Array.from({ length: c.frames + c.hold }, (_, f) => Math.round(lineAt(c.sweep, Math.min(f, c.frames - 1)) * 10000) / 10000),
    })),
  )};

/** Each poster's mean colour (by its clip's name): the tile shows it until the poster is in. */
export const HOME_BENTO_TINT: Record<string, string> = ${JSON.stringify(tints, null, 2)};

`;
  fs.writeFileSync(OUT_TS, body);
  console.log(`wrote ${path.relative(ROOT, OUT_TS)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
