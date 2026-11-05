/**
 * Home's first screen: a grid of every kind of media Fuobe makes, each tile a real picture, clip or sound from the
 * studio it opens (src/components/home/home-bento.tsx). Every number is read from the catalog and every picture is a
 * published file with its content version, so nothing here is typed in twice (tests/home-bento.test.ts).
 */
import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { MODELS, isListed } from "@/lib/catalog";
import { getTemplate } from "@/lib/catalog/canvas";
import { runsOn } from "@/lib/catalog/engines";
import type { ModelDef } from "@/lib/catalog/types";
import { EXAMPLE_MEDIA } from "@/lib/examples/media.generated";
import { HOME_BENTO_MEDIA, HOME_BENTO_REEL, HOME_BENTO_TINT, HOME_BENTO_WAVE } from "@/lib/home-bento.generated";
import type { ReelClip } from "@/lib/home-reel";
import type { Demo } from "@/lib/live/demo";
import { presetCover } from "@/lib/preset-covers";
import { templateCover } from "@/lib/template-covers";

/** The preset whose clip the 3D tile plays (no other card on Home plays it: tests/home-showcase.test.ts). */
export const BENTO_CLIPS = { threeD: "app-3d-rotation" } as const;
/** Each clip's copies here (scripts/gen-home-bento.mjs): its name, and the widths it and its poster come in. */
export const BENTO_CLIP_FILES = { threeD: "rotation" } as const;
export const BENTO_CLIP_WIDTHS = [640, 1024, 1536, 2048] as const;
/**
 * The presets the video tile plays in turn, in this order: scripts/gen-home-bento.mjs (REEL) cuts each one's stretch
 * and frames it. The first one's first frame is the tile's poster.
 */
export const BENTO_REEL = HOME_BENTO_REEL.map((c) => c.id);
/** The video tile's id in the playback store: its own, as it plays several presets (one of them may be a card lower down). */
export const BENTO_REEL_ID = "home-reel";
/** The width of the JPEG copy of each clip's first frame, for a browser without AVIF. */
export const BENTO_CLIP_FALLBACK = 1024;
/** The Image studio's example the image tile shows and opens with (src/lib/examples/plan.json). */
export const BENTO_IMAGE_EXAMPLE = { id: "image.4", out: "/examples/image/4/out.jpg" };
/**
 * The Genjutsu tile: Genjutsu's own Group swap example (a couple, both people swapped in one take; the studio's cover
 * "genjutsu-group-swap"), cut by scripts/gen-home-bento.mjs into `name`'s copies, with the original clip's first frame in
 * a small window. Its id in the playback store is its own, so a card lower down can play the same clip.
 */
export const BENTO_GENJUTSU = { id: "home-genjutsu", cover: "genjutsu-group-swap", name: "genjutsu", original: "genjutsu-original" } as const;
/** The widths the Genjutsu clip comes in: its render is 1024 px wide, and nothing is made up past that. */
export const BENTO_GENJUTSU_WIDTHS = [640, 1024] as const;
/** The widths of the original's window (it shows at up to about 130 px wide: 480 covers a 3x screen). */
export const BENTO_ORIGINAL_WIDTHS = [240, 480] as const;
/** The example whose original clip's first frame the window shows (Genjutsu's Character swap example, src/lib/examples). */
export const GENJUTSU_ORIGINAL = "/examples/genjutsu-character/1/in-clip.jpg";
/** The Canvas board the canvas tile draws: the same film as /canvas's "What's a canvas?". */
export const BENTO_BOARD = "effect-chain-pearl-earring";
/** The steps the live tile plays: the portrait session's first three changes (Home's Live edit section plays the room). */
export const BENTO_LIVE_STEPS = ["s0", "s1", "s2", "s3"];

/** Where each tile goes. Each label is the navigation's name for the place (or the app's own). */
export const BENTO_HREFS = {
  video: "/cinema",
  image: `/image?example=${BENTO_IMAGE_EXAMPLE.id}`,
  audio: "/audio",
  threeD: "/image-to-3d",
  genjutsu: "/genjutsu",
  numbers: "#home-studios",
  live: "/live-edit?from=home",
  canvas: "/canvas",
} as const;

export type BentoKey = keyof typeof BENTO_HREFS;

/**
 * A picture in two or more widths: AVIF for the browsers that take it, the published JPEG for the rest. `tint`: its
 * mean colour, shown until it is in (a clip's poster).
 */
export interface BentoPicture {
  avif: { src: string; w: number }[];
  fallback: string;
  tint?: string;
}

/** A tile's clip: its id in the playback store, its poster, and the clip in each width (the tile picks one). */
export interface BentoMovingTile {
  id: string;
  poster: BentoPicture;
  clips: { src: string; w: number }[];
}

/** The video tile: its id in the playback store, its poster (the first clip's first frame) and its clips in order. */
export interface BentoReelTile {
  id: string;
  poster: BentoPicture;
  reel: ReelClip[];
}

export interface BentoTile {
  key: BentoKey;
  /** The small line over the title: what kind of media, and how much of it. */
  meta: string;
  title: string;
  /** The link's own words (the place it opens). */
  cta: string;
  href: string;
  /** What a screen reader reads for the whole tile. */
  label: string;
}

/** The numbers Home's first screen quotes, each from the catalog. */
export interface BentoFacts {
  /** Studios, counted as the navigation counts them (its Studios badge and the launcher say the same number). */
  studios: number;
  apps: number;
  effectsAndMotions: number;
  motions: number;
  openModels: number;
  imageModels: number;
  videoModels: number;
  models3d: number;
  soundTools: number;
}

/**
 * Open models a visitor can pick, of one kind (Home is the same page for everyone, and everyone runs open models). The
 * same test as modelCounts().open (src/lib/catalog/counts.ts), so the kinds add up to its total.
 */
export const openModelsOf = (kind: ModelDef["kind"], models: readonly ModelDef[] = MODELS) => models.filter((m) => isListed(m) && runsOn(m, "open") && m.kind === kind).length;

/** The widths a file of the copies named `name` comes in (`<name>-<width>.<ext>`), as scripts/gen-home-bento.mjs made them. */
const widthsOf = (name: string, ext: string) => BENTO_CLIP_WIDTHS.filter((w) => HOME_BENTO_MEDIA[`/previews/home/${name}-${w}.${ext}`]);

/** A file made by scripts/gen-home-bento.mjs, with its version. */
function made(file: string): string {
  const v = HOME_BENTO_MEDIA[file];
  if (!v) throw new Error(`Home's first screen names ${file}, which scripts/gen-home-bento.mjs didn't make`);
  return `${file}?v=${v}`;
}

/** A published example file with its version (src/lib/examples/media.generated.ts). */
function example(file: string): string {
  const m = EXAMPLE_MEDIA[file];
  if (!m) throw new Error(`Home's first screen names ${file}, which isn't a published example file`);
  return `${file}?v=${m.v}`;
}

/** The phrase typed before each step of the tile's portrait session, in its own words: every `type` since the last step. */
export function livePhrases(demo: Pick<Demo, "script">, steps = BENTO_LIVE_STEPS): string[] {
  const out: string[] = [];
  let typed = "";
  for (const s of demo.script) {
    if (s.type === "type") typed += s.text;
    else if (s.type === "frame" && !s.live && steps.includes(s.frame) && s.frame !== steps[0]) {
      out.push(typed.replace(/^[,\s]+/, ""));
      typed = "";
    }
  }
  return out;
}

/**
 * The live tile's session: the portrait (public/previews/live-edit/demo.json). Every LiveDemo player (Home's Live edit
 * section and drawn Live card, the Apps card, Live edit's guest view, the Edit studio's Live pane) plays the room
 * makeover instead (LIVE_DEMO, public/previews/live-edit/room/).
 */
async function readDemo(): Promise<Demo> {
  return JSON.parse(await fs.readFile(path.join(process.cwd(), "public", "previews", "live-edit", "demo.json"), "utf8")) as Demo;
}

/**
 * What the canvas tile draws: the board's nodes in order (its photo, its steps, its film), each with its label; the
 * photo and the film show the board's own pictures (scripts/gen-home-bento.mjs makes their small copies).
 */
function board() {
  const t = getTemplate(BENTO_BOARD);
  if (!t || !templateCover("canvas", BENTO_BOARD)) throw new Error(`Home's canvas tile names ${BENTO_BOARD}, which has no board or cover`);
  const nodes = t.build("open").nodes.map((n) => ({
    id: n.id,
    label: n.data.label ?? n.id,
    kind: n.type === "image-input" ? ("photo" as const) : n.type === "output" ? ("film" as const) : ("step" as const),
  }));
  const photo = nodes.find((n) => n.kind === "photo");
  const film = nodes.find((n) => n.kind === "film");
  const steps = nodes.filter((n) => n.kind === "step");
  if (!photo || !film || steps.length !== 2) throw new Error(`Home's canvas tile draws a photo, two steps and a film; ${BENTO_BOARD} has another shape`);
  return {
    photo: { ...photo, thumb: made("/previews/home/board-photo.webp") },
    steps,
    film: { ...film, thumb: made("/previews/home/board-film.webp") },
  };
}

/** Everything the first screen shows, computed once per build with the rest of Home (homeShowcase). */
export async function homeBento(f: BentoFacts) {
  const threeD = presetCover(BENTO_CLIPS.threeD);
  if (!threeD?.video || BENTO_REEL.some((id) => !presetCover(id)?.video)) throw new Error("Home's first screen names a clip without its published media");
  const demo = await readDemo();
  const frame = (id: string) => {
    const fr = demo.frames[id];
    if (!fr?.small || !fr.mid || !fr.src || !fr.webp) throw new Error(`Home's live tile names frame ${id}, which the portrait session doesn't have`);
    return { avif: [{ src: fr.small, w: 512 }, { src: fr.mid, w: 768 }, { src: fr.src, w: 1280 }], fallback: fr.webp } satisfies BentoPicture;
  };
  // The video tile's reel: each clip in the widths it comes in, and the first one's first frame as the poster, in its
  // widths (and a JPEG at 1024 px for a browser without AVIF).
  const reel = (): BentoReelTile => {
    const first = HOME_BENTO_REEL[0];
    return {
      id: BENTO_REEL_ID,
      poster: {
        avif: widthsOf(first.name, "avif").map((w) => ({ src: made(`/previews/home/${first.name}-${w}.avif`), w })),
        fallback: made(`/previews/home/${first.name}-${BENTO_CLIP_FALLBACK}.jpg`),
        tint: HOME_BENTO_TINT[first.name],
      },
      reel: HOME_BENTO_REEL.map((c) => {
        const widths = widthsOf(c.name, "mp4");
        if (!widths.length) throw new Error(`Home's video tile names ${c.name}, which scripts/gen-home-bento.mjs didn't make`);
        return { id: c.id, position: c.position, hold: c.hold, fade: c.fade, clips: widths.map((w) => ({ src: made(`/previews/home/${c.name}-${w}.mp4`), w })) };
      }),
    };
  };
  // A moving tile: its poster (the clip's first frame) and its clip, each in every width it comes in; for a browser
  // without AVIF, the 1024 px clip's first frame as a JPEG.
  const moving = (id: string, name: string, widths: readonly number[] = BENTO_CLIP_WIDTHS): BentoMovingTile => ({
    id,
    poster: {
      avif: widths.map((w) => ({ src: made(`/previews/home/${name}-${w}.avif`), w })),
      fallback: made(`/previews/home/${name}-${BENTO_CLIP_FALLBACK}.jpg`),
      tint: HOME_BENTO_TINT[name],
    },
    clips: widths.map((w) => ({ src: made(`/previews/home/${name}-${w}.mp4`), w })),
  });
  const tile = (key: BentoKey, kind: string, meta: string, title: string, cta: string): BentoTile => ({
    key,
    meta,
    title,
    cta,
    href: BENTO_HREFS[key],
    label: `${kind}: ${title}. ${cta}`,
  });
  return {
    facts: f,
    tiles: {
      video: tile("video", "Video", `${f.videoModels} video models · ${f.motions} camera moves`, "Films, ads and shorts", "Open Cinema Studio"),
      image: tile("image", "Image", `Image · ${f.imageModels} models`, "Portraits and campaigns", "Open Image"),
      audio: tile("audio", "Audio", `Audio · ${f.soundTools} sound tools`, "Voice, music, sound effects", "Open Audio"),
      threeD: tile("threeD", "3D", `3D · ${f.models3d} models`, "Spin it in 3D", "Open Image to 3D"),
      genjutsu: tile("genjutsu", "Genjutsu", "Genjutsu", "Swap anyone in a clip", "Open Genjutsu"),
      numbers: {
        ...tile("numbers", "Studios", "", "Every studio, app and effect", "All studios"),
        // Read as the numbers it shows, and say that it opens the list of studios in place.
        label: `${f.studios} studios, ${f.apps} apps, ${f.effectsAndMotions} effects and camera moves. Opens all studios`,
      },
      live: tile("live", "Live edit", "Live edit", "Type it, watch it change", "Open Live edit"),
      canvas: tile("canvas", "Canvas", "Canvas", "Chain any step, end to end", "Open Canvas"),
    },
    video: reel(),
    image: {
      avif: [480, 768].map((w) => ({ src: made(`/previews/home/image-4-${w}.avif`), w })),
      fallback: example(BENTO_IMAGE_EXAMPLE.out),
    } satisfies BentoPicture,
    threeD: moving(BENTO_CLIPS.threeD, BENTO_CLIP_FILES.threeD),
    genjutsu: {
      ...moving(BENTO_GENJUTSU.id, BENTO_GENJUTSU.name, BENTO_GENJUTSU_WIDTHS),
      original: {
        avif: BENTO_ORIGINAL_WIDTHS.map((w) => ({ src: made(`/previews/home/${BENTO_GENJUTSU.original}-${w}.avif`), w })),
        fallback: example(GENJUTSU_ORIGINAL),
      } satisfies BentoPicture,
    },
    wave: { bars: HOME_BENTO_WAVE.bars, seconds: HOME_BENTO_WAVE.seconds },
    live: { frames: BENTO_LIVE_STEPS.map(frame), phrases: livePhrases(demo) },
    canvas: board(),
    numbers: [
      { value: f.studios, label: "studios" },
      { value: f.apps, label: "apps" },
      { value: f.effectsAndMotions, label: "effects & moves" },
    ],
    numbersLine: `Plus ${f.openModels} open models for pictures, video, sound and 3D.`,
  };
}

export type HomeBento = Awaited<ReturnType<typeof homeBento>>;
