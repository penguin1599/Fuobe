/**
 * What a studio or tool shows before a visitor has made anything: four real covers of what it makes (Image, Video and
 * Edit under the composer; the other studios and tools under their composer, upload box or empty list), and Mixed
 * Media's one reveal in "How it works". Server only, like Home's showcase it borrows from: the page gets a few slim
 * cards, and the catalog stays here (tests/studio-examples.test.ts checks every id, cover and line).
 */
import "server-only";
import { getPreset } from "@/lib/catalog";
import { HOME_EFFECTS, HOME_MOTIONS, HOME_REVEALS, HOME_WALL, homeCard, presetHref } from "@/lib/home-showcase";
import { PRESET_BEFORE_AFTER } from "@/lib/preset-before-after.generated";
import { STUDIO_COVERS, isStudioCover } from "@/lib/studio-covers";
import type { PresetType } from "@/lib/catalog/types";
import type { PresetCardData } from "@/lib/preset-cards";

export type ExampleStudio =
  | "image"
  | "video"
  | "edit"
  | "video-edit"
  | "extend"
  | "reframe"
  | "inpaint"
  | "lipsync"
  | "motion-control"
  | "upscale"
  | "video-tools"
  | "audio"
  | "layers"
  | "genjutsu"
  | "character-swap"
  | "image-to-3d"
  | "katana"
  | "cinema"
  | "ads"
  | "mixed-media";

const SEE = "See what it makes";

/**
 * Each studio's row: the line above it, and its tiles in the order they show (four; Mixed Media's "How it works" has
 * one). A tile's line is its own here, else EXAMPLE_LINES', else Home's (HOME_CAPTION_MAX.card holds any of them whole
 * on a phone's tile). Video's tiles pick their move in the studio itself; Image's, Edit's and Upscale's are apps, each on a page
 * of its own, and their heading says so. A tile can also be a studio's own cover (studio-covers.ts), which opens its
 * studio: Genjutsu's group swap. Ads Studio and Ad Multiplier share the "ads" row.
 */
export const STUDIO_EXAMPLES: Record<ExampleStudio, { heading: string; tiles: { id: string; caption?: string }[] }> = {
  image: {
    heading: "Or start from an app",
    tiles: [
      { id: "app-sketch-to-real", caption: "A rough sketch, made a real photo" },
      { id: "app-behind-the-scenes" },
      { id: "app-outfit-shot" },
      { id: "app-product-shot" },
    ],
  },
  video: {
    heading: SEE,
    tiles: [{ id: "motion-fpv-drone" }, { id: "effect-sand-storm" }, { id: "motion-dolly-in" }, { id: "effect-nature-bloom" }],
  },
  edit: {
    heading: "Or start from an app",
    tiles: [
      { id: "app-relight", caption: "Change the light of any photo" },
      { id: "app-match-colors" },
      { id: "app-outfit-swap" },
      { id: "app-steal-the-look" },
    ],
  },
  "video-edit": { heading: SEE, tiles: [{ id: "app-recast" }, { id: "app-video-face-swap" }, { id: "app-change-background" }, { id: "effect-outfit-switch" }] },
  extend: { heading: SEE, tiles: [{ id: "app-what-s-next" }, { id: "app-zoom-out" }, { id: "motion-drone-reveal" }, { id: "motion-fpv-drone" }] },
  reframe: { heading: SEE, tiles: [{ id: "app-expand-image" }, { id: "app-zoom-out" }, { id: "app-behind-the-scenes" }, { id: "motion-aerial-pullback" }] },
  inpaint: { heading: SEE, tiles: [{ id: "app-object-remover" }, { id: "app-text-edit" }, { id: "app-expression-edit" }, { id: "app-change-background" }] },
  lipsync: { heading: SEE, tiles: [{ id: "app-talking-photo" }, { id: "app-rap-god" }, { id: "app-japanese-show" }, { id: "effect-selfie" }] },
  "motion-control": { heading: SEE, tiles: [{ id: "app-dance" }, { id: "effect-selfie-posing" }, { id: "motion-static" }, { id: "motion-boxing" }] },
  upscale: { heading: "Or start from an app", tiles: [{ id: "app-upscale" }, { id: "app-restore-photo" }, { id: "app-skin-enhancer" }, { id: "app-colorize" }] },
  "video-tools": { heading: SEE, tiles: [{ id: "app-remove-background" }, { id: "app-object-remover" }, { id: "app-relight" }, { id: "app-match-colors" }] },
  audio: { heading: SEE, tiles: [{ id: "app-clean-up-voice" }, { id: "app-talking-photo" }, { id: "app-rap-god" }, { id: "app-asmr-classic" }] },
  layers: { heading: SEE, tiles: [{ id: "app-text-edit" }, { id: "app-relight" }, { id: "app-object-remover" }, { id: "app-change-background" }] },
  genjutsu: { heading: SEE, tiles: [{ id: "app-recast" }, { id: "app-character-swap" }, { id: "app-video-face-swap" }, { id: "genjutsu-group-swap" }] },
  "character-swap": { heading: SEE, tiles: [{ id: "app-character-swap" }, { id: "app-recast" }, { id: "app-face-swap" }, { id: "app-video-face-swap" }] },
  "image-to-3d": { heading: SEE, tiles: [{ id: "app-image-to-3d" }, { id: "app-3d-rotation" }, { id: "app-product-360" }, { id: "app-3d-figure" }] },
  katana: { heading: SEE, tiles: [{ id: "app-clipcut" }, { id: "app-urban-cuts" }, { id: "app-sticker-match-cut" }, { id: "effect-jump-transition" }] },
  cinema: { heading: SEE, tiles: [{ id: "motion-arc-left" }, { id: "motion-dolly-in" }, { id: "motion-crane-up" }, { id: "motion-fpv-drone" }] },
  ads: { heading: SEE, tiles: [{ id: "app-ad-creative" }, { id: "app-billboard-ad" }, { id: "app-giant-product" }, { id: "app-packshot" }] },
  "mixed-media": { heading: "See a look play out", tiles: [{ id: "effect-paper" }] },
};

/** What each cover shows, for the presets and studio covers Home has no line for (one line each, whichever studio shows it). */
export const EXAMPLE_LINES: Record<string, string> = {
  "app-recast": "A new dancer takes the stage",
  "app-video-face-swap": "A new face in the back seat",
  "app-change-background": "From a grey studio to the Alps",
  "app-what-s-next": "A whale breaches beside the yacht",
  "app-zoom-out": "Pulls back to show the whole fjord",
  "motion-drone-reveal": "Rises over a seaplane on the reef",
  "app-expand-image": "The frame opens up across the bay",
  "motion-aerial-pullback": "Pulls back over a hedge maze",
  "app-object-remover": "The tourists beside her are gone",
  "app-text-edit": "The shop sign now reads BELLE",
  "app-expression-edit": "A calm look turns into a smile",
  "app-talking-photo": "A portrait speaks your words",
  "app-rap-god": "A full verse on a neon stage",
  "app-japanese-show": "A guest on a Japanese TV show",
  "app-asmr-classic": "Soft taps on a glazed pink vase",
  "effect-selfie": "A selfie chat at the canyon's edge",
  "app-dance": "A dance across a gilded ballroom",
  "effect-selfie-posing": "Quick selfie poses in a blue alley",
  "motion-static": "Flamenco in a Moorish courtyard",
  "motion-boxing": "Jabs and hooks in a sunlit gym",
  "app-upscale": "Soft to sharp, down to every strand",
  "app-restore-photo": "A creased wedding portrait, restored",
  "app-skin-enhancer": "Natural skin, gently retouched",
  "app-colorize": "A black and white beach, in color",
  "app-remove-background": "Cut out clean, every curl kept",
  "app-relight": "Grey skies to golden hour",
  "app-character-swap": "He steps into her place by the lake",
  "app-face-swap": "A new face, same suit and light",
  "app-image-to-3d": "A teapot photo, now a 3D model",
  "app-3d-rotation": "A black gown turns full circle",
  "app-product-360": "A red heel on a turntable",
  "app-3d-figure": "You as a boxed collectible figure",
  "app-clipcut": "A new outfit on every beat",
  "app-urban-cuts": "New looks down a neon street",
  "app-sticker-match-cut": "She pops out as a glossy sticker",
  "effect-jump-transition": "One jump from Rio to the dunes",
  "motion-arc-left": "Circles her on the baobab road",
  "app-ad-creative": "A chocolate bar made a bold ad",
  "app-billboard-ad": "A perfume ad over the skyline",
  "app-giant-product": "A lipstick towers over the city",
  "app-packshot": "A handbag, cut out on clean white",
  "app-clean-up-voice": "A noisy restaurant, a clear voice",
  "effect-paper": "Whale and sea, redrawn in cut paper",
  "genjutsu-group-swap": "Two people swapped in one take",
};

/** A tile of the studio's row: its cover, what kind of preset it is, its line, and where it opens. */
export interface StudioExample {
  card: PresetCardData;
  kind: string;
  caption: string;
  href: string;
}

/** A studio's row: the line above it and its tiles. */
export interface StudioExampleRow {
  heading: string;
  tiles: StudioExample[];
}

const homeCaptions = new Map<string, string>([...HOME_WALL, ...HOME_EFFECTS, ...HOME_MOTIONS, ...HOME_REVEALS].map((t) => [t.id, t.caption]));
const homeKinds = new Map<string, string>(HOME_WALL.map((t) => [t.id, t.kind]));

/** The kind a tile names (from xl, as Home's wall does). */
const KIND: Record<PresetType, string> = { app: "App", motion: "Camera motion", effect: "Effect" };
/** An app whose cover wipes from a before to an after (its pair is Home's slider's) says so, as Home's wall does. */
const BEFORE_AFTER = "App · before → after";

export function exampleKind(id: string): string {
  const type = getPreset(id)?.type;
  // A studio's own cover (no preset has its id) names its studio.
  if (!type) return isStudioCover(id) ? STUDIO_COVERS[id].category : KIND.app;
  if (type !== "app") return KIND[type];
  return homeKinds.get(id) ?? (PRESET_BEFORE_AFTER[id] ? BEFORE_AFTER : KIND.app);
}

/** Where a tile opens: a studio's cover its studio, a preset its own page (presetHref). */
const exampleHref = (id: string) => (isStudioCover(id) ? STUDIO_COVERS[id].href : presetHref(id));

/** The studio's row, as cards (each resting on its peak frame, as on Home). */
export function studioExamples(studio: ExampleStudio): StudioExampleRow {
  const { heading, tiles } = STUDIO_EXAMPLES[studio];
  return {
    heading,
    tiles: tiles.map(({ id, caption }) => {
      // homeCard throws for an id that is neither in the catalog nor a studio's cover, so the build fails rather than the page.
      const card = homeCard(id);
      const line = caption ?? EXAMPLE_LINES[id] ?? homeCaptions.get(id);
      if (!line) throw new Error(`The ${studio} studio's example ${id} has no line`);
      return { card, kind: exampleKind(id), caption: line, href: exampleHref(id) };
    }),
  };
}
