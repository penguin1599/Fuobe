/**
 * Shorts Studio (Higgsfield's Shorts Studio / reels_studio): restyle your own footage into a new
 * look while the motion stays yours. Up to 2 minutes in; the clip is cut into segments (≤10 s on
 * cloud models, ≤5 s = 81 frames at 16 fps on the open engine), each segment is restyled, and the
 * segments are stitched back together under the original sound.
 *
 * Fuobe Shorts (build plan O9) is the default on both engines: each segment's first frame drawn in the look
 * (Qwen-Image 2.1 Turbo on your GPU, hosted Qwen-Image-Edit 2511 on fal), then Wan 2.2 Fun VACE carries it through every frame by depth, on your GPU (81 frames at
 * 16 fps a segment) or on fal (pieces of up to 241 frames at the clip's own rate). Gemini Omni Flash (Higgsfield's
 * Shorts engine) and the other partner models stay as choices.
 *
 * Pure module (presets, limits, segment planning, prompts, the pipeline's steps), shared by the
 * page, the server (src/server/shorts.ts) and the tests. Research: docs/research/higgsfield-studios.md §2,
 * docs/research/fuobe-originals-recipes-5.md (studios[shorts]).
 */
import { scenePoster, type PresetPreview, type PreviewFx, type PreviewScene } from "../preset-cards";
import { templateCover, templatePreview } from "../template-covers";
import { finishLengthProblem, REGEN_FINISH_TIER, REGEN_FPS, REGEN_SMOOTH_MODEL, regenFinishSteps } from "./regenerate";
import type { ChainSlot, Engine, Generation, GenerationRequest } from "./types";
import { withOriginalSound, type OriginalSound } from "../av/original-sound";

// ---------------------------------------------------------------------------
// Limits (Higgsfield's, from the upload dialog) and engine shapes

export const SHORTS = {
  minSeconds: 4,
  maxSeconds: 120,
  maxBytes: 200 * 1024 * 1024,
  maxDimension: 4000,
  /** Longest segment a cloud restyle model gets (Gemini Omni Flash: ≤10 s per clip). */
  cloudSegmentSeconds: 10,
  /** Open engine: Wan 2.2 Fun VACE renders 81 frames (4n+1) at 16 fps, ≈5 s. */
  openFps: 16,
  openMaxFrames: 81,
  maxReferences: 10,
  /** The first frame's edit takes the frame plus two references (the Original's first frame, on both engines). */
  openReferences: 2,
  /**
   * Fuobe Shorts in the cloud: fal's Wan 2.2 Fun VACE makes 17–241 frames at 5–30 fps, matching its input clip's count and
   * rate. A clip above 30 fps is worked at half (a third…) its rate and brought back (temporal_downsample_factor).
   */
  original: { minFrames: 17, maxFrames: 240, minFps: 5, maxFps: 30, billFps: 16 },
  accept: "video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm",
} as const;

export const SHORTS_RATIOS = [
  { value: "9:16", label: "9:16", hint: "Vertical" },
  { value: "16:9", label: "16:9", hint: "Horizontal" },
] as const;
export type ShortsRatio = (typeof SHORTS_RATIOS)[number]["value"];

/** Languages for on-screen words (type presets), as Higgsfield lists them. "auto" = the language spoken in the clip. */
export const SHORTS_LANGUAGES = [
  "English",
  "Spanish",
  "French",
  "Kazakh",
  "Arabic",
  "Bulgarian",
  "Chinese",
  "Croatian",
  "Czech",
  "Danish",
  "Dutch",
  "Filipino",
  "Finnish",
  "German",
  "Greek",
  "Hungarian",
  "Hindi",
  "Indonesian",
  "Italian",
  "Japanese",
  "Korean",
  "Malay",
  "Norwegian",
  "Polish",
  "Portuguese",
  "Romanian",
  "Russian",
  "Slovak",
  "Swedish",
  "Tamil",
  "Turkish",
  "Ukrainian",
  "Vietnamese",
] as const;

/** Shorts Studio's Original (O9): the open Shorts chain on both engines. */
export const SHORTS_ORIGINAL = "fuobe-shorts";

/**
 * Restyle models per engine; the first is the default: Fuobe Shorts. Gemini Omni Flash (Higgsfield's Shorts engine) and
 * the other partner models stay as choices in the cloud.
 */
export const SHORTS_MODELS: Record<Engine, string[]> = {
  cloud: [SHORTS_ORIGINAL, "gemini-omni-flash", "kling-o3-4k-edit", "happy-horse-video-edit", "lucy-edit-pro", "runway-aleph-2", "ltx-2-3-restyle", "wan-2-7"],
  open: [SHORTS_ORIGINAL],
};

/**
 * The helper models of the pipeline (the cloud Original's first frame: `still` takes it, `frame` restyles it). The
 * first frame in the look: hosted Qwen-Image-Edit 2511 in the cloud, Qwen-Image 2.1 Turbo (8 steps) on your GPU.
 */
export const SHORTS_TOOLS = {
  cloud: { cut: "trim-video", trim: "trim-video", fit: "scale-video", still: "extract-frame", frame: "qwen-image-edit-2511-cloud", join: "join-clips", mux: "merge-audio-video", joinMax: 24 },
  open: { cut: "oss-segment", trim: "oss-trim", frame: "oss-qwen-image-21-turbo", join: "oss-join-clips", mux: "oss-mux", joinMax: 4 },
} as const;

// ---------------------------------------------------------------------------
// Presets: the 44 Higgsfield names, with Fuobe's own descriptions and prompts

export type ShortsCategory = "Colour" | "Drawn" | "Comic & pop" | "Type" | "Street & collage" | "Digital" | "Craft";

export interface ShortsPreset {
  id: string;
  name: string;
  category: ShortsCategory;
  /** One line for the card. */
  description: string;
  /** The look, as the end of "Restyle this video as …". */
  look: string;
  /** On-screen words are part of the look: the language setting applies. */
  type?: boolean;
  hue: number;
  fx: PreviewFx;
  scene: PreviewScene;
}

type Row = [name: string, category: ShortsCategory, description: string, look: string, hue: number, fx: PreviewFx, scene: PreviewScene, type?: true];

const ROWS: Row[] = [
  ["Bold Urban", "Colour", "Punchy city grade with deep blacks and teal-orange colour", "a bold urban music-video grade: crushed deep blacks, saturated teal and orange, crisp high contrast and sharp street detail", 30, "grade", "city"],
  ["Green Contrast", "Colour", "Moody high contrast with rich emerald greens", "a high-contrast green-tinted look: rich emerald greens in the midtones, inky shadows and bright clean highlights", 150, "grade", "landscape"],
  ["Urban Serenity", "Colour", "Calm, airy city tones in soft pastels", "a calm, airy urban look: soft pastel tones, gentle haze, lifted shadows and quiet muted colours", 220, "grade", "city"],
  ["Warm Glow", "Colour", "Golden-hour warmth with a soft bloom", "warm golden-hour light with a soft dreamy bloom around the highlights, honey tones and glowing skin", 70, "relight", "portrait"],
  ["Yellow Frame", "Comic & pop", "A bold yellow poster frame around the action", "a graphic poster with a thick bright yellow frame around the action, flat bold colours and clean cut-out edges", 95, "frame", "portrait"],
  ["Monochrome Vibes", "Colour", "Rich black and white with film grain", "rich black-and-white film photography: deep blacks, silver highlights, fine film grain and strong contrast", 260, "grade", "city"],
  ["Claymation", "Craft", "Stop-motion clay with a handmade, tactile feel", "stop-motion claymation: every person and object sculpted from plasticine with fingerprint textures, soft studio light and a slightly stepped, handmade motion", 40, "morph", "portrait"],
  ["Marker Scribble", "Drawn", "Loose marker doodles scribbled over the footage", "hand-drawn marker doodles: loose felt-tip outlines, scribbled highlights, arrows and squiggles drawn around the subject over the real footage", 15, "halftone", "portrait"],
  ["Sticker Type", "Type", "Die-cut sticker words that pop onto the frame", "a playful sticker collage: the subject cut out with a thick white die-cut border, bold sticker-style words and emoji stickers popping onto the frame", 330, "pop", "portrait", true],
  ["Blue Comic", "Comic & pop", "Blue-toned comic panels with heavy ink lines", "a comic book drawn in shades of blue: heavy black ink outlines, halftone dots and flat blue and cyan fills", 240, "halftone", "city"],
  ["Red Graffiti", "Street & collage", "Red spray-paint tags, outlines and drips", "street graffiti in bold red spray paint: drippy tags, outlines and splatters sprayed around the subject on a concrete-wall texture", 25, "halftone", "city"],
  ["Watercolor", "Drawn", "Soft watercolour washes on textured paper", "a watercolour painting: soft translucent washes that bleed at the edges, visible paper grain and a loose pencil underdrawing", 200, "halftone", "landscape"],
  ["Pencil Sketch", "Drawn", "A graphite pencil sketch that moves", "a graphite pencil sketch on white paper: hatched shading, smudged tones and confident hand-drawn contour lines", 280, "halftone", "portrait"],
  ["Desktop", "Digital", "Your clip inside a retro computer desktop", "a retro computer desktop: the footage playing inside pixel-perfect windows with title bars, cursors, icons and pop-up dialogs on a bright desktop background", 210, "frame", "city"],
  ["Acid Green", "Colour", "Toxic neon-green duotone", "an acid neon-green duotone: the picture mapped to toxic lime and black, glowing edges and a rave-poster intensity", 125, "glitch", "city"],
  ["Balloon Type", "Type", "Glossy balloon letters floating in", "inflated glossy balloon lettering: shiny 3D balloon words floating around the subject, bright party colours and soft reflections", 345, "pop", "portrait", true],
  ["Blueprint", "Drawn", "White technical lines on blueprint blue", "an architectural blueprint: white technical line drawing on deep blue paper with grid lines, measurements and construction notes", 245, "halftone", "city"],
  ["Bold Caption", "Type", "Big punchy captions stamped over the action", "a social-video look with huge bold captions: thick white words with black outlines stamped over the action and punchy high-contrast colour", 50, "pop", "portrait", true],
  ["Bounding Box", "Digital", "Tracking boxes and labels on everything", "a computer-vision overlay: thin tracking boxes, corner brackets, labels and confidence numbers following the people and objects", 180, "scan", "city"],
  ["Circuit", "Digital", "Glowing circuit-board traces", "a circuit-board world: glowing cyan and green circuit traces flowing across every surface and outlining the subject on a dark PCB texture", 165, "glitch", "product"],
  ["Comic Burst", "Comic & pop", "Action panels with POW-style bursts", "an action comic: bold ink lines, speed lines, halftone shading and starburst sound-effect bubbles bursting behind the subject", 10, "explode", "city"],
  ["Comic Pop", "Comic & pop", "Bright pop-art comic colours and dots", "pop-art comic style: thick black outlines, Ben-Day dots and flat primary colours like a vintage comic print", 55, "halftone", "portrait"],
  ["Pink Wash", "Colour", "A dreamy pink tint over everything", "a dreamy pink colour wash: soft rose and magenta over the whole frame, glowing highlights and pastel shadows", 350, "grade", "landscape"],
  ["Gold Stars", "Comic & pop", "Sparkling gold stars and glitter", "a glamorous sparkle look: twinkling gold stars, glitter and lens sparkles swirling around the subject in warm shimmering light", 80, "sparkle", "portrait"],
  ["Graffiti", "Street & collage", "A colourful wall-mural makeover", "a colourful graffiti mural: the scene repainted as spray-painted street art with bold outlines, gradients and wildstyle shapes on brick", 300, "halftone", "city"],
  ["Green Doodle", "Drawn", "Green hand-drawn doodles around you", "green hand-drawn doodles: playful green marker outlines, stars, hearts and squiggles traced around the subject over the footage", 140, "halftone", "portrait"],
  ["Green Pop", "Comic & pop", "Lime pop-art colour blocking", "pop-art colour blocking in lime and green: flat graphic shapes, bold outlines and a bright cut-out poster feel", 130, "pop", "portrait"],
  ["Heart Pop", "Comic & pop", "Pink hearts popping all around", "a cute pop look: pink and red cartoon hearts popping and floating around the subject, soft pastel tones and glossy highlights", 355, "sparkle", "portrait"],
  ["Kinetic Type", "Type", "Bold words moving with the action", "kinetic typography: big bold words sliding, scaling and stacking around the subject in time with the movement, graphic two-colour design", 270, "pop", "city", true],
  ["Liquid Chrome", "Digital", "Mirror-polished liquid metal", "liquid chrome: everything turned into flowing mirror-polished liquid metal with sharp reflections and iridescent highlights", 230, "shine", "product"],
  ["Mascot", "Craft", "You, as a cute 3D cartoon mascot", "a cute 3D cartoon mascot: the people turned into soft rounded toy-like characters with big eyes, smooth plastic shading and bright colours", 45, "morph", "portrait"],
  ["Neon Pop", "Comic & pop", "Electric neon outlines on dark", "electric neon pop: glowing pink and cyan neon outlines tracing the subject against a dark background, with vivid light trails", 320, "glow", "city"],
  ["Neon Type", "Type", "Glowing neon-sign lettering", "neon-sign lettering: glowing tube-light words and outlines in hot pink and blue buzzing around the subject at night", 300, "glow", "city", true],
  ["Patterned", "Street & collage", "Bold repeating patterns fill the scene", "a patterned collage: the background and clothes filled with bold repeating graphic patterns (checks, stripes and dots) in a flat print style", 20, "halftone", "portrait"],
  ["Pink Pop", "Comic & pop", "Hot-pink pop-art palette", "hot-pink pop art: flat bubblegum pinks, bold black outlines and glossy graphic shapes", 340, "pop", "portrait"],
  ["Pink Scribble", "Drawn", "Pink crayon scribbles and doodles", "pink crayon scribbles: loose hand-drawn pink outlines, hearts and zigzags scribbled over and around the subject", 335, "halftone", "portrait"],
  ["Polka Pop", "Comic & pop", "Polka dots and pop-art colour blocks", "playful pop art with polka dots: oversized dots, flat colour blocks and thick outlines like a retro print", 5, "pop", "portrait"],
  ["Retro Collage", "Street & collage", "Cut-paper textures and grainy print colours", "a vintage cut-paper collage: torn paper edges, magazine cut-outs, grainy risograph print colours and tape marks", 35, "halftone", "landscape"],
  ["Stacked Type", "Type", "Giant stacked words layered behind you", "bold stacked typography: giant repeated words stacked in layers behind the subject, the subject cut out in front, clean two-tone design", 0, "pop", "portrait", true],
  ["Star Comic", "Comic & pop", "Comic panels with exploding stars", "a comic-book look with star bursts: ink outlines, halftone dots and bright yellow stars exploding around the action", 60, "sparkle", "city"],
  ["Street Art", "Street & collage", "Stencils and paste-up posters", "stencil street art: high-contrast spray stencils, paste-up posters and paint drips on an urban wall", 15, "halftone", "city"],
  ["Vintage Paper", "Street & collage", "An old printed page with faded inks", "an old printed page: aged yellowed paper, faded inks, misregistered print colours and creases", 50, "grade", "landscape"],
  ["Yellow Burst", "Comic & pop", "Graphic bursts on a punchy yellow backdrop", "bold graphic bursts on a punchy yellow backdrop: the subject cut out over bright yellow with radiating rays and black outline shapes", 90, "explode", "portrait"],
  ["Yellow Doodle", "Drawn", "Bright yellow highlighter doodles", "yellow highlighter doodles: bright yellow hand-drawn outlines, sparkles and arrows scribbled around the subject over the footage", 95, "halftone", "portrait"],
];

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export const SHORTS_PRESETS: ShortsPreset[] = ROWS.map(([name, category, description, look, hue, fx, scene, type]) => ({
  id: `shorts-${slug(name)}`,
  name,
  category,
  description,
  look,
  hue,
  fx,
  scene,
  ...(type ? { type } : {}),
}));

export const SHORTS_CATEGORIES: ShortsCategory[] = ["Colour", "Drawn", "Comic & pop", "Type", "Street & collage", "Digital", "Craft"];

export function getShortsPreset(id: string): ShortsPreset | undefined {
  return SHORTS_PRESETS.find((p) => p.id === id);
}

/** Looks with a real cover lead; the rest keep their catalog order after them. */
export function coveredFirst<T extends Pick<ShortsPreset, "id">>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => Number(!templateCover("shorts", a.id)) - Number(!templateCover("shorts", b.id)));
}

/** A look's card preview: its real cover when it has one (templateCover: the restyled frame, and its reveal), else drawn. */
export function shortsPreview(p: Pick<ShortsPreset, "id" | "scene" | "fx">): PresetPreview {
  const cover = templateCover("shorts", p.id);
  return cover ? templatePreview(cover) : { poster: scenePoster(p.scene), scene: p.scene, fx: p.fx };
}

/** A preset the user made from reference images (stored in shorts_presets). */
export interface ShortsCustomPreset {
  id: string;
  name: string;
  /** What the look should feel like, in the user's words (optional). */
  description: string;
  references: string[];
  createdAt: number;
  updatedAt: number;
}

/** What a session restyles with: a built-in preset or a custom one, snapshotted when the session starts. */
export interface ShortsLook {
  presetId: string;
  name: string;
  look: string;
  type?: boolean;
  references?: string[];
  custom?: boolean;
  /** A custom preset with words of its own (else the look is only its reference images). */
  described?: boolean;
}

export function lookFromPreset(p: ShortsPreset): ShortsLook {
  return { presetId: p.id, name: p.name, look: p.look, ...(p.type ? { type: true } : {}) };
}

export function lookFromCustom(p: ShortsCustomPreset): ShortsLook {
  const words = p.description.trim().replace(/[.\s]+$/, "");
  return {
    presetId: p.id,
    name: p.name,
    look: words ? `the look of the reference images: ${words}` : "the look of the reference images: their colours, textures, lighting and graphic style",
    references: p.references.slice(0, SHORTS.maxReferences),
    custom: true,
    described: !!words,
  };
}

/** A name for a custom preset when the user leaves it empty: the first words of the description, or "My look N". */
export function customPresetName(description: string, existing: number): string {
  const words = description
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !/^(the|and|with|for|from|that|this|very|look|style)$/i.test(w))
    .slice(0, 3);
  if (!words.length) return `My look ${existing + 1}`;
  const name = words.join(" ");
  return name[0].toUpperCase() + name.slice(1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Prompts

const tidy = (s: string) => s.trim().replace(/[.\s]+$/, "");

/** "on-screen words in Spanish" — only type presets put words on screen. */
function wordsLine(look: Pick<ShortsLook, "type">, language: string): string {
  if (!look.type) return "";
  const lang = !language || language === "auto" ? "the language spoken in the clip" : language;
  return ` Any on-screen words are written in ${lang}.`;
}

/** The video-to-video prompt: the look, and the promise that the motion stays the user's. */
export function restylePrompt(look: Pick<ShortsLook, "look" | "type" | "references">, language = "auto", refsSent = 0): string {
  const refs = refsSent ? ` Match the style of the reference image${refsSent > 1 ? "s" : ""}.` : "";
  return `Restyle this video as ${tidy(look.look)}. Keep everything that happens exactly as it is: the same people, faces, poses, motion, timing and camera moves; change only the look.${refs}${wordsLine(look, language)}`;
}

/** Step 1: restyle the segment's first frame (image 1) with the edit model (SHORTS_TOOLS.frame); references are images 2 and 3. */
export function firstFramePrompt(look: Pick<ShortsLook, "look" | "type">, language = "auto", refs = 0): string {
  const match = refs ? ` Match the style, colours and textures of ${refs > 1 ? "images 2 and 3" : "image 2"}.` : "";
  return `Redraw image 1 as ${tidy(look.look)}. Keep the composition, framing, people, faces, poses and expressions of image 1 exactly.${match}${wordsLine(look, language)}`;
}

/** Open engine, step 2: Wan 2.2 Fun VACE follows the restyled first frame and the clip's depth. */
export function segmentPrompt(look: Pick<ShortsLook, "look">): string {
  const l = tidy(look.look);
  return `${l[0].toUpperCase()}${l.slice(1)}. The same look on every frame, smooth natural motion.`;
}

// ---------------------------------------------------------------------------
// Segments

export interface ShortsRange {
  start: number;
  end: number;
}

export interface ShortsSegment {
  index: number;
  /** Seconds in the source clip. */
  start: number;
  end: number;
  /** Open engine: the segment's exact frame count at SHORTS.openFps (4n+1). */
  frames?: number;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Why a restyle model can't take a clip this long, or null ("Kling O3 4K Edit needs at least 3 s"). */
export function clipLengthProblem(m: { name: string; minSeconds?: number; maxSeconds?: number }, seconds: number): string | null {
  if (m.minSeconds && seconds < m.minSeconds - 0.01) return `${m.name} needs at least ${m.minSeconds} s`;
  if (m.maxSeconds && seconds > m.maxSeconds + 0.01) return `${m.name} takes up to ${m.maxSeconds} s`;
  return null;
}

/** Higgsfield's upload rules for the picture: up to 4000 px on the long side, between 1:3 and 3:1. */
export function clipShapeProblem(width?: number, height?: number): string | null {
  if (!width || !height) return null;
  if (Math.max(width, height) > SHORTS.maxDimension) return `This clip is ${width}×${height} — use one up to ${SHORTS.maxDimension} px on its long side`;
  const r = width / height;
  if (r > 3.01 || r < 1 / 3.01) return "Use a clip between 1:3 and 3:1";
  return null;
}

/** What's wrong with a selection, or null. */
export function rangeProblem(range: ShortsRange, duration?: number): string | null {
  const len = range.end - range.start;
  if (!(len > 0) || range.start < 0) return "Pick a part of the clip";
  if (duration !== undefined && range.end > duration + 0.05) return "The selection runs past the end of the clip";
  if (len < SHORTS.minSeconds - 0.05) return `Select at least ${SHORTS.minSeconds} seconds`;
  if (len > SHORTS.maxSeconds + 0.05) return "Select up to 2 minutes";
  return null;
}

/**
 * Cloud: cut the selection into equal segments of at most `max` seconds, so no segment ends up a
 * sliver (47 s → five 9.4 s segments, not four 10 s and a 7 s one).
 */
export function planCloudSegments(range: ShortsRange, max: number = SHORTS.cloudSegmentSeconds): ShortsSegment[] {
  const len = range.end - range.start;
  const n = Math.max(1, Math.ceil(len / max - 1e-9));
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    start: r3(range.start + (len * i) / n),
    end: i === n - 1 ? r3(range.end) : r3(range.start + (len * (i + 1)) / n),
  }));
}

/**
 * Open: Wan wants 4n+1 frames per segment (at most 81 at 16 fps). Segments are cut back to back
 * on whole frames, so the stitched video has exactly the selection's frames (less up to 3 at the
 * end) and stays in sync with the original sound all the way through.
 */
export function planOpenSegments(range: ShortsRange, fps: number = SHORTS.openFps, maxFrames: number = SHORTS.openMaxFrames): ShortsSegment[] {
  const total = Math.floor((range.end - range.start) * fps + 1e-6);
  const first = Math.round(range.start * fps);
  const k = Math.max(1, Math.ceil(total / maxFrames));
  const units = Math.max(k, Math.floor((total - k) / 4)); // each segment is 4·n + 1 frames
  const base = Math.floor(units / k);
  const extra = units % k;
  const out: ShortsSegment[] = [];
  let at = first;
  for (let i = 0; i < k; i++) {
    const frames = 4 * (base + (i < extra ? 1 : 0)) + 1;
    out.push({ index: i, start: r3(at / fps), end: r3((at + frames) / fps), frames });
    at += frames;
  }
  return out;
}

/**
 * fal's Wan 2.2 Fun VACE works at up to 30 fps: a faster clip is worked at a whole fraction of its rate and brought back
 * (its temporal_downsample_factor: 1 skips every other frame). 0 for 30 fps and below.
 */
export function vaceDownsample(fps: number | undefined): number {
  return fps && fps > SHORTS.original.maxFps + 0.01 ? Math.ceil(fps / SHORTS.original.maxFps - 1e-6) - 1 : 0;
}

/**
 * The longest segment Fuobe Shorts takes in the cloud: up to 241 frames as fal works them (240 here, so a rounded cut
 * never tips over), at most 10 s. An unknown rate counts as 30 fps (8 s segments).
 */
export function originalSegmentSeconds(fps?: number): number {
  const rate = fps && fps > 0 ? fps / (vaceDownsample(fps) + 1) : SHORTS.original.maxFps;
  return Math.min(SHORTS.cloudSegmentSeconds, Math.floor((SHORTS.original.maxFrames / rate) * 100) / 100);
}

/** Segments for a model: the open engine's 81-frame windows, Fuobe Shorts' frame-limited pieces, or ≤10 s cuts. */
export function planSegments(range: ShortsRange, engine: Engine, model?: { modelId?: string; fps?: number }): ShortsSegment[] {
  if (engine === "open") return planOpenSegments(range);
  return model?.modelId === SHORTS_ORIGINAL ? planCloudSegments(range, originalSegmentSeconds(model.fps)) : planCloudSegments(range);
}

/**
 * What fal's Wan 2.2 Fun VACE won't take in a Fuobe Shorts cloud piece, if anything: fewer than 17 frames as it works them,
 * or a clip under 5 fps. Said before anything runs (the cut, the first frame and its edit would be paid for, then refused).
 * Null when the clip's rate isn't known.
 */
export function originalSegmentProblem(seconds: number, fps?: number): string | null {
  if (!fps || !(fps > 0)) return null;
  const o = SHORTS.original;
  if (fps < o.minFps - 0.01) return `Wan 2.2 Fun VACE needs a clip of at least ${o.minFps} fps (this one is ${+fps.toFixed(2)} fps)`;
  const rate = fps / (vaceDownsample(fps) + 1);
  if (Math.floor(seconds * rate + 1e-6) < o.minFrames) return `Wan 2.2 Fun VACE needs at least ${o.minFrames} frames: select at least ${Math.ceil((o.minFrames / rate) * 10) / 10} s of this ${+fps.toFixed(2)} fps clip`;
  return null;
}

/** The seconds fal bills for a Fuobe Shorts segment: its frames ÷ 16 ("video seconds"); an unknown rate counts as 30 fps. */
export function originalBilledSeconds(seconds: number, fps?: number): number {
  return Math.round(((seconds * (fps && fps > 0 ? fps : SHORTS.original.maxFps)) / SHORTS.original.billFps) * 1e6) / 1e6;
}

/** Groups of at most `max` consecutive items, as even as possible (5 by 4 → 3 + 2, never 4 + 1). */
export function joinGroups(n: number, max: number): number[][] {
  const g = Math.max(1, Math.ceil(n / max));
  const out: number[][] = [];
  let at = 0;
  for (let i = 0; i < g; i++) {
    const size = Math.floor(n / g) + (i < n % g ? 1 : 0);
    out.push(Array.from({ length: size }, (_, j) => at + j));
    at += size;
  }
  return out;
}

/** Whether the selection is the whole clip (then the upload itself carries the sound to put back). */
export function wholeClip(range: ShortsRange, duration?: number): boolean {
  return range.start <= 0.05 && duration !== undefined && range.end >= duration - 0.05;
}

// ---------------------------------------------------------------------------
// The pipeline: steps for createPipeline (src/server/chains.ts)

export interface PlanStep {
  key: string;
  request: GenerationRequest;
  after?: string[];
  chain?: ChainSlot[];
}

export interface ShortsPlanInput {
  engine: Engine;
  title: string;
  /** fps: the clip's own frame rate (Fuobe Shorts in the cloud: its pieces are frame-limited and billed on frames). */
  source: { url: string; duration?: number; hasAudio?: boolean; width?: number; height?: number; fps?: number };
  range: ShortsRange;
  look: ShortsLook;
  aspectRatio: ShortsRatio;
  /** Cloud: the restyle model can be asked for the ratio itself; otherwise each cut is cropped to it first (it keeps its input's shape). */
  reframes?: boolean;
  /**
   * Keep the clip's own shape instead of `aspectRatio` (Genjutsu Restyle: framing stays as filmed): no crop, no ratio
   * asked of the cloud model, and the open cuts and join follow the clip ("auto").
   */
  keepShape?: boolean;
  language: string;
  /** The restyle model (SHORTS_MODELS; Fuobe Shorts runs as a chain of its own on both engines). */
  modelId: string;
  /** How many reference images the restyle model takes (0: it restyles from words only). */
  maxRefs: number;
  /** Resolution to ask the cloud model for, when it has a setting. */
  resolution?: string;
  /** Extra params for the restyle model (e.g. a seed for a new take). */
  seed?: number;
  /** What of the clip's sound goes back (src/lib/av/original-sound.ts; the cloud: Everything only). */
  originalSound?: OriginalSound;
}

export const SHORTS_FEATURE = "shorts";
/** The steps in between (cuts, crops, first frames, joins, the sound): kept apart from the takes and the finished short. */
export const SHORTS_STEP_FEATURE = "shorts-step";

/** Keys of one take's steps. */
export interface TakeKeys {
  cut: string;
  /** Cloud: the cut cropped to the output ratio. */
  fit?: string;
  /** Fuobe Shorts in the cloud: the segment's first frame, taken out of the cut (the open cut makes it itself). */
  still?: string;
  /** The first frame in the new look (Fuobe Shorts, both engines). */
  frame?: string;
  look: string;
}

/** The ratio a step is asked for: the session's, or (keepShape) the clip's own on the open engine and none on the cloud. */
const ratioParams = (input: Pick<ShortsPlanInput, "engine" | "aspectRatio" | "keepShape">): { aspectRatio?: string } =>
  !input.keepShape ? { aspectRatio: input.aspectRatio } : input.engine === "open" ? { aspectRatio: "auto" } : {};

const segLabel = (s: ShortsSegment, n: number, what: string) => ({ label: `Segment ${s.index + 1} of ${n} · ${what}`, index: s.index, of: n });

/** Which references go where: the cloud model's own reference slot, or images 2–3 of the first-frame edit (open, and Fuobe Shorts). */
export function refsFor(input: Pick<ShortsPlanInput, "engine" | "look" | "maxRefs" | "modelId">): string[] {
  const refs = input.look.references ?? [];
  if (input.engine === "open" || input.modelId === SHORTS_ORIGINAL) return refs.slice(0, SHORTS.openReferences);
  return refs.slice(0, Math.max(0, input.maxRefs));
}

/** The engine an Original's step runs on (a model on one engine ignores it). */
const originalEngine = (input: Pick<ShortsPlanInput, "engine" | "modelId">) => (input.modelId === SHORTS_ORIGINAL ? { engine: input.engine } : {});

/** One take of one segment: cut it out, (open: restyle its first frame,) restyle it. */
export function planTake(input: ShortsPlanInput, seg: ShortsSegment, total: number, suffix = ""): { steps: PlanStep[]; keys: TakeKeys } {
  const t = SHORTS_TOOLS[input.engine];
  const base = { feature: SHORTS_FEATURE, batchTitle: input.title };
  const helper = { feature: SHORTS_STEP_FEATURE, batchTitle: input.title };
  const k = (what: string) => `${what}${seg.index}${suffix}`;
  const refs = refsFor(input);
  const seed = input.seed !== undefined ? { seed: input.seed } : {};
  if (input.engine === "open") {
    const keys: TakeKeys = { cut: k("cut"), frame: k("frame"), look: k("look") };
    return {
      keys,
      steps: [
        {
          key: keys.cut,
          request: {
            ...helper,
            modelId: t.cut,
            op: "trim",
            inputs: { video: input.source.url },
            params: { startTime: seg.start, endTime: seg.end, fps: SHORTS.openFps, ...ratioParams(input), resolution: "480p" },
            step: segLabel(seg, total, "cut"),
          },
        },
        {
          key: keys.frame!,
          request: {
            ...helper,
            modelId: SHORTS_TOOLS.open.frame,
            op: "edit",
            prompt: firstFramePrompt(input.look, input.language, refs.length),
            inputs: refs.length ? { images: refs } : undefined,
            params: { ...seed },
            step: segLabel(seg, total, "first frame"),
          },
          after: [keys.cut],
          chain: [{ slot: "images", position: "first" }],
        },
        {
          key: keys.look,
          request: {
            ...base,
            ...originalEngine(input),
            modelId: input.modelId,
            op: "v2v",
            prompt: segmentPrompt(input.look),
            params: { ...ratioParams(input), resolution: "480p", duration: (seg.frames ?? Math.round((seg.end - seg.start) * SHORTS.openFps)) / SHORTS.openFps, ...seed },
            step: segLabel(seg, total, "restyle"),
          },
          after: [keys.cut, keys.frame!],
          chain: [{ slot: "video" }, { slot: "images" }],
        },
      ],
    };
  }
  const fit = !input.keepShape && !input.reframes && needsFit(input.source, input.aspectRatio);
  if (input.modelId === SHORTS_ORIGINAL) return planOriginalTake(input, seg, total, k, fit, refs);
  const keys: TakeKeys = { cut: k("cut"), ...(fit ? { fit: k("fit") } : {}), look: k("look") };
  const seconds = seg.end - seg.start;
  return {
    keys,
    steps: [
      {
        key: keys.cut,
        request: { ...helper, modelId: t.cut, op: "trim", inputs: { video: input.source.url }, params: { startTime: seg.start, endTime: seg.end }, step: segLabel(seg, total, "cut") },
      },
      // The restyle keeps its input's shape: crop the cut to the output ratio first (centre crop, no AI, ≈ free).
      ...(keys.fit
        ? [
            {
              key: keys.fit,
              request: {
                ...helper,
                modelId: SHORTS_TOOLS.cloud.fit,
                op: "reframe" as const,
                params: { aspectRatio: input.aspectRatio, extra: { ...fitSize(input.aspectRatio) } },
                step: segLabel(seg, total, `crop to ${input.aspectRatio}`),
              },
              after: [keys.cut],
              chain: [{ slot: "video" as const }],
            },
          ]
        : []),
      {
        key: keys.look,
        request: {
          ...base,
          modelId: input.modelId,
          op: "v2v",
          prompt: restylePrompt(input.look, input.language, refs.length),
          inputs: refs.length ? { images: refs } : undefined,
          // The segment's exact length: what per-second prices count. No restyle route is sent a length
          // (each keeps its clip's), so the restyled segments add up to the selection and stay on the sound.
          params: { ...ratioParams(input), duration: r3(seconds), ...(input.resolution ? { resolution: input.resolution } : {}), ...seed },
          step: segLabel(seg, total, "restyle"),
        },
        after: [keys.fit ?? keys.cut],
        chain: [{ slot: "video" }],
      },
    ],
  };
}

/**
 * Fuobe Shorts in the cloud: cut the segment (cropped to the output ratio when it isn't), take its first frame, draw it in
 * the look with Qwen-Image-Edit 2511 (the look's references as images 2 and 3), then fal's Wan 2.2 Fun VACE carries that
 * frame through every frame of the cut by depth, keeping its frame count and rate (a clip above 30 fps is worked at a
 * fraction of its rate and brought back). Billed on frames ÷ 16, like every fal Wan VACE route.
 */
function planOriginalTake(input: ShortsPlanInput, seg: ShortsSegment, total: number, k: (what: string) => string, fit: boolean, refs: string[]): { steps: PlanStep[]; keys: TakeKeys } {
  const t = SHORTS_TOOLS.cloud;
  const base = { feature: SHORTS_FEATURE, batchTitle: input.title };
  const helper = { feature: SHORTS_STEP_FEATURE, batchTitle: input.title };
  const seed = input.seed !== undefined ? { seed: input.seed } : {};
  const keys: TakeKeys = { cut: k("cut"), ...(fit ? { fit: k("fit") } : {}), still: k("still"), frame: k("frame"), look: k("look") };
  const clip = keys.fit ?? keys.cut;
  const seconds = seg.end - seg.start;
  const downsample = vaceDownsample(input.source.fps);
  return {
    keys,
    steps: [
      {
        key: keys.cut,
        request: { ...helper, modelId: t.cut, op: "trim", inputs: { video: input.source.url }, params: { startTime: seg.start, endTime: seg.end }, step: segLabel(seg, total, "cut") },
      },
      ...(keys.fit
        ? [
            {
              key: keys.fit,
              request: {
                ...helper,
                modelId: t.fit,
                op: "reframe" as const,
                params: { aspectRatio: input.aspectRatio, extra: { ...fitSize(input.aspectRatio) } },
                step: segLabel(seg, total, `crop to ${input.aspectRatio}`),
              },
              after: [keys.cut],
              chain: [{ slot: "video" as const }],
            },
          ]
        : []),
      {
        key: keys.still!,
        request: { ...helper, modelId: t.still, op: "frame", params: { extra: { frame_type: "first" } }, step: segLabel(seg, total, "first frame") },
        after: [clip],
        chain: [{ slot: "video" }],
      },
      {
        key: keys.frame!,
        request: {
          ...helper,
          modelId: t.frame,
          op: "edit",
          prompt: firstFramePrompt(input.look, input.language, refs.length),
          ...(refs.length ? { inputs: { images: refs } } : {}),
          params: { ...seed },
          step: segLabel(seg, total, "first frame in the look"),
        },
        after: [keys.still!],
        chain: [{ slot: "images", position: "first" }],
      },
      {
        key: keys.look,
        request: {
          ...base,
          engine: "cloud",
          modelId: input.modelId,
          op: "v2v",
          prompt: segmentPrompt(input.look),
          // fal bills frames ÷ 16 as "video seconds" (duration); sourceDuration is the cut's own length.
          params: {
            duration: originalBilledSeconds(seconds, input.source.fps),
            sourceDuration: r3(seconds),
            ...(input.resolution ? { resolution: input.resolution } : {}),
            ...seed,
            ...(downsample ? { extra: { temporal_downsample_factor: downsample } } : {}),
          },
          step: segLabel(seg, total, "restyle"),
        },
        after: [clip, keys.frame!],
        chain: [{ slot: "video" }, { slot: "images", position: "first" }],
      },
    ],
  };
}

/** The size a cut is cropped to before a restyle that keeps its input's shape (1080 on the short side). */
export function fitSize(ratio: ShortsRatio): { width: number; height: number } {
  return ratio === "9:16" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
}

/** Whether a clip needs cropping to come out at `ratio` (an unknown shape is cropped: it's ≈ free). */
export function needsFit(source: { width?: number; height?: number }, ratio: ShortsRatio): boolean {
  if (!source.width || !source.height) return true;
  const want = ratio === "9:16" ? 9 / 16 : 16 / 9;
  return Math.abs(source.width / source.height - want) / want > 0.02;
}

/** Where a clip in a stitch comes from: an earlier step's output, or a finished file. */
export type ClipRef = { key: string } | { url: string };

/**
 * Join the restyled segments (in order, folding when the join model takes fewer clips than there
 * are) and put the original sound back. Returns the steps and the key of the finished video
 * (undefined when there is nothing to make: one segment and no sound to add).
 */
export function planStitch(input: ShortsPlanInput, clips: ClipRef[], suffix = "", opts: { resolution?: string } = {}): { steps: PlanStep[]; final?: string } {
  const t = SHORTS_TOOLS[input.engine];
  const base = { feature: SHORTS_FEATURE, batchTitle: input.title };
  const helper = { feature: SHORTS_STEP_FEATURE, batchTitle: input.title };
  const steps: PlanStep[] = [];
  const params = input.engine === "open" ? { ...ratioParams(input), resolution: opts.resolution ?? "480p" } : ratioParams(input);
  // Each join step takes its clips either chained (key) or as files (url).
  let level: ClipRef[] = clips;
  let depth = 0;
  while (level.length > 1) {
    const groups = joinGroups(level.length, t.joinMax);
    const last = groups.length === 1;
    level = groups.map((g, gi) => {
      const items = g.map((i) => level[i]);
      const after = items.flatMap((c) => ("key" in c ? [c.key] : []));
      const urls = items.flatMap((c) => ("url" in c ? [c.url] : []));
      const key = last ? `join${suffix}` : `join${suffix}-${depth}-${gi}`;
      // Files first, then chained clips (a stitch-again fold); a finished stitch's mix is placed by `at` below.
      steps.push({
        key,
        request: {
          ...helper,
          modelId: t.join,
          op: "concat",
          prompt: input.title,
          inputs: urls.length ? { videos: urls } : undefined,
          params,
          step: { label: last ? "Stitch" : "Stitching", index: 1000 + depth, of: 1000 },
        },
        // A group that mixes files and chained clips puts each chained clip at its own place (`at`), keeping the order.
        ...(after.length
          ? { after, chain: urls.length ? items.flatMap((c, at) => ("key" in c ? [{ slot: "videos" as const, at }] : [])) : after.map(() => ({ slot: "videos" as const })) }
          : {}),
      });
      return { key };
    });
    depth++;
  }
  const picture = level[0];
  if (!input.source.hasAudio) {
    // Nothing to put back: the joined clip (or the single segment) is the short.
    if ("key" in picture) {
      const last = steps.find((s) => s.key === picture.key);
      if (last) last.request = { ...last.request, feature: SHORTS_FEATURE, title: input.title };
      return { steps, final: picture.key };
    }
    return { steps, final: undefined };
  }
  const whole = wholeClip(input.range, input.source.duration);
  const after: string[] = [];
  const chain: ChainSlot[] = [];
  const inputs: GenerationRequest["inputs"] = {};
  if ("key" in picture) {
    after.push(picture.key);
    chain.push({ slot: "video" });
  } else inputs.video = picture.url;
  if (whole) inputs.audio = input.source.url;
  else {
    // The sound of the selection: the source cut to the same window (the mux reads a clip's soundtrack).
    const key = `sound${suffix}`;
    steps.push({
      key,
      request: { ...helper, modelId: t.trim, op: "trim", inputs: { video: input.source.url }, params: { startTime: input.range.start, endTime: input.range.end }, step: { label: "Original sound", index: 1100, of: 1000 } },
    });
    after.push(key);
    chain.push({ slot: "audio" });
  }
  const key = `final${suffix}`;
  steps.push({
    key,
    request: { ...base, title: input.title, modelId: t.mux, op: "mux", inputs: Object.keys(inputs).length ? inputs : undefined, step: { label: "Final video", index: 1200, of: 1000 } },
    ...(after.length ? { after, chain } : {}),
  });
  // Original sound: the music and effects, the dialogue, or the dialogue over lower music (DBS on your GPU).
  return { steps: withOriginalSound(steps, key, input.originalSound, input.engine, { seconds: input.range.end - input.range.start }), final: key };
}

// ---------------------------------------------------------------------------
// Enhance (H3 regenerate) on a segment (package n7-10; docs/research/new-models-7.md §2.10)

export const ENHANCE_COPY = {
  label: "Enhance (H3 regenerate)",
  hint: "1080p · sharper, may redraw",
  /** Only on your GPU: nobody hosts the open refiner. */
  gpu: "Runs on your GPU (open source)",
  cloudSession: "Enhance (H3 regenerate) runs on your GPU (open source): make the short on your GPU to use it",
  done: "This take is already enhanced",
  notReady: "Wait for this take to finish first",
} as const;

/** The segment's length in seconds (its exact frames at 16 fps on the open engine). */
export const segmentSeconds = (seg: ShortsSegment) => (seg.frames ? seg.frames / SHORTS.openFps : seg.end - seg.start);

/** Why a segment can't be enhanced in this session, or null. */
export function enhanceProblem(input: Pick<ShortsPlanInput, "engine">, seg: ShortsSegment): string | null {
  if (input.engine !== "open") return ENHANCE_COPY.cloudSession;
  return finishLengthProblem(segmentSeconds(seg));
}

/**
 * Enhance (H3 regenerate) on one segment's take: the restyle (Wan VACE, 16 fps) brought to 24 fps with RIFE, then redrawn
 * by Open-H3 Regenerate at 1080p with the 576p preset and start sigma 0.8, from the segment's own restyle words. A new
 * take of the segment, to compare and pick.
 */
export function planEnhance(input: ShortsPlanInput, seg: ShortsSegment, take: { url: string }, suffix = ""): { steps: PlanStep[]; keys: { smooth?: string; look: string } } {
  const problem = enhanceProblem(input, seg);
  if (problem) throw new Error(problem);
  const plan = regenFinishSteps({
    key: `enhance${seg.index}${suffix}`,
    clip: { url: take.url },
    prompt: segmentPrompt(input.look),
    seconds: segmentSeconds(seg),
    fps: SHORTS.openFps,
    draftFrom: "other",
    helper: { feature: SHORTS_STEP_FEATURE, batchTitle: input.title },
    label: `Segment ${seg.index + 1}`,
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
  });
  // The redraw is the take (in History, like a restyle); RIFE's step stays a helper.
  const steps = plan.steps.map((st) => (st.key === plan.final ? { ...st, request: { ...st.request, feature: SHORTS_FEATURE } } : st));
  const smooth = steps.find((st) => st.request.modelId === REGEN_SMOOTH_MODEL)?.key;
  return { steps, keys: { ...(smooth ? { smooth } : {}), look: plan.final } };
}

/**
 * The stitch of the chosen takes when some are enhanced (1080p at 24 fps): the others are brought to 24 fps with RIFE so
 * every clip shares one rate (the open join concatenates frames, it doesn't retime them), and the join runs at 1080p.
 * With none enhanced it is the plain stitch.
 */
export function planFinishedStitch(input: ShortsPlanInput, clips: { url: string; enhanced: boolean }[], suffix = ""): { steps: PlanStep[]; final?: string } {
  if (input.engine !== "open" || !clips.some((c) => c.enhanced)) return planStitch(input, clips.map((c) => ({ url: c.url })), suffix);
  const helper = { feature: SHORTS_STEP_FEATURE, batchTitle: input.title };
  const smooth: PlanStep[] = [];
  const refs: ClipRef[] = clips.map((c, i) => {
    if (c.enhanced) return { url: c.url };
    const key = `smooth${suffix}-${i}`;
    smooth.push({
      key,
      request: { ...helper, modelId: REGEN_SMOOTH_MODEL, op: "interpolate", inputs: { video: c.url }, params: { targetFps: REGEN_FPS, numOutputs: 1 }, step: { label: `Segment ${i + 1} to ${REGEN_FPS} fps`, index: 900 + i, of: 1000 } },
    });
    return { key };
  });
  const stitch = planStitch(input, refs, suffix, { resolution: REGEN_FINISH_TIER });
  return { steps: [...smooth, ...stitch.steps], final: stitch.final };
}

/** The whole session: every segment's first take, the stitch and the soundtrack. */
export function planShorts(input: ShortsPlanInput): { segments: ShortsSegment[]; steps: PlanStep[]; takes: TakeKeys[]; final?: string } {
  const segments = planSegments(input.range, input.engine, { modelId: input.modelId, fps: input.source.fps });
  const takes = segments.map((s) => planTake(input, s, segments.length));
  const stitch = planStitch(
    input,
    takes.map((t) => ({ key: t.keys.look })),
  );
  return { segments, steps: [...takes.flatMap((t) => t.steps), ...stitch.steps], takes: takes.map((t) => t.keys), final: stitch.final ?? takes[0].keys.look };
}

// ---------------------------------------------------------------------------
// Sessions (stored by src/server/shorts.ts, read by the page)

export interface ShortsTake {
  /** The generations of this take's steps, by role (an enhanced take keeps the cut of the take it was made from). */
  cut: string;
  /** Cloud: the cut cropped to the output ratio. */
  fit?: string;
  /** Fuobe Shorts in the cloud: the segment's first frame. */
  still?: string;
  frame?: string;
  look: string;
  /** "Enhance (H3 regenerate)": the take this one redraws (its look), and RIFE's 24 fps step before the redraw. */
  enhance?: { from: string; smooth?: string };
  createdAt: number;
}

export interface ShortsSessionSegment extends ShortsSegment {
  takes: ShortsTake[];
  /** The take (its look generation id) the stitch uses. */
  primary: string;
}

export interface ShortsStitch {
  /** Every generation of this stitch. */
  ids: string[];
  /** The finished video. */
  final: string;
  /** The primary takes it was made from, in order. */
  clips: string[];
  createdAt: number;
}

export interface ShortsSession {
  id: string;
  title: string;
  engine: Engine;
  batchId: string;
  look: ShortsLook;
  source: { url: string; name?: string; duration?: number; hasAudio?: boolean; width?: number; height?: number; fps?: number };
  range: ShortsRange;
  settings: { aspectRatio: ShortsRatio; language: string; modelId: string; resolution?: string; maxRefs: number; reframes?: boolean; originalSound?: OriginalSound };
  segments: ShortsSessionSegment[];
  stitches: ShortsStitch[];
  createdAt: number;
  updatedAt: number;
}

/** The plan input a stored session stands for (regenerate and stitch reuse it). */
export function sessionPlanInput(s: ShortsSession, seed?: number): ShortsPlanInput {
  return {
    engine: s.engine,
    title: s.title,
    source: s.source,
    range: s.range,
    look: s.look,
    aspectRatio: s.settings.aspectRatio,
    language: s.settings.language,
    modelId: s.settings.modelId,
    maxRefs: s.settings.maxRefs,
    resolution: s.settings.resolution,
    reframes: s.settings.reframes,
    ...(s.settings.originalSound && { originalSound: s.settings.originalSound }),
    ...(seed !== undefined ? { seed } : {}),
  };
}

/** Whether the latest stitch was made from the current primary takes. */
export function stitchCurrent(s: Pick<ShortsSession, "segments" | "stitches">): boolean {
  const last = s.stitches[s.stitches.length - 1];
  if (!last) return false;
  const now = s.segments.map((g) => g.primary);
  return now.length === last.clips.length && now.every((id, i) => last.clips[i] === id);
}

export function formatSeconds(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const whole = Math.floor(rest);
  const tenth = Math.floor((rest - whole) * 10 + 1e-6);
  return `${m}:${String(whole).padStart(2, "0")}${tenth ? `.${tenth}` : ""}`;
}

// ---------------------------------------------------------------------------
// Progress of a chain of steps (a take: cut → first frame → restyle; a stitch: joins → sound → final)

export interface ChainState {
  status: "done" | "working" | "failed" | "gone";
  /** What's happening now ("Restyling", "Stitching"), or why it stopped. */
  label: string;
  /** 0–1 over the whole chain. */
  progress: number;
  error?: string;
  /** The generation that failed (Retry starts there). */
  failed?: Generation;
}

/**
 * One state for a few chained generations: done when the last one is, failed when any step failed
 * (with that step's own error, not "An earlier step didn't finish"), otherwise working on the
 * first step that isn't done. `gone` when the result was deleted.
 */
export function chainState(steps: { g?: Generation; label: string }[]): ChainState {
  const last = steps[steps.length - 1];
  if (!last?.g) return { status: "gone", label: "Deleted", progress: 0 };
  if (last.g.status === "succeeded") return { status: "done", label: "Ready", progress: 1 };
  const failed = steps.find((s) => s.g && (s.g.status === "failed" || s.g.status === "canceled"));
  if (failed?.g) {
    const why = failed.g.status === "canceled" ? "Canceled" : (failed.g.error ?? "Something went wrong");
    return { status: "failed", label: `${failed.label} failed`, progress: 0, error: why, failed: failed.g };
  }
  const missing = steps.find((s) => !s.g);
  if (missing) return { status: "gone", label: `${missing.label} was deleted`, progress: 0 };
  const i = steps.findIndex((s) => s.g!.status !== "succeeded");
  const cur = steps[i];
  const own = cur.g!.status === "running" ? (cur.g!.progress ?? 0) : 0;
  return { status: "working", label: cur.label, progress: (i + own) / steps.length };
}

/** A take's steps with their labels. */
export function takeSteps(t: Pick<ShortsTake, "cut" | "fit" | "still" | "frame" | "look" | "enhance">, gens: Record<string, Generation>): { g?: Generation; label: string }[] {
  if (t.enhance) {
    return [
      { g: gens[t.enhance.from], label: "Restyling" },
      ...(t.enhance.smooth ? [{ g: gens[t.enhance.smooth], label: `Smoothing to ${REGEN_FPS} fps` }] : []),
      { g: gens[t.look], label: "Enhancing" },
    ];
  }
  return [
    { g: gens[t.cut], label: "Cutting the segment" },
    ...(t.fit ? [{ g: gens[t.fit], label: "Cropping the segment" }] : []),
    ...(t.still ? [{ g: gens[t.still], label: "Taking the first frame" }] : []),
    ...(t.frame ? [{ g: gens[t.frame], label: "Restyling the first frame" }] : []),
    { g: gens[t.look], label: "Restyling" },
  ];
}

/** A stitch's steps with their labels (joins, the original sound, the final mux). */
export function stitchSteps(s: Pick<ShortsStitch, "ids" | "final">, gens: Record<string, Generation>): { g?: Generation; label: string }[] {
  const ids = s.ids.includes(s.final) ? s.ids : [...s.ids, s.final];
  return ids.map((id) => {
    const g = gens[id];
    const label = !g ? "A step" : g.op === "concat" ? "Stitching the segments" : g.op === "trim" ? "Cutting the original sound" : g.op === "separate-audio" ? "Splitting the sound" : g.op === "mux" ? "Putting the sound back" : "Restyling";
    return { g, label };
  });
}
