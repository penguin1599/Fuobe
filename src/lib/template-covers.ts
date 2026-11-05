/**
 * The real covers of the studios' template and style tiles (Marketing Studio's templates, Fashion Factory, Photodump
 * packs, the Shorts and Mixed Media looks, Canvas templates, Content Factory's trending styles, the Explainer styles,
 * Fuobe Soul's looks, AI Influencer's character types, the example pictures of Character Sheet, Storyboard and
 * Elements, and the studios' ready-made starters), from template-covers.generated.ts (pnpm eval:covers --templates). A
 * tile that isn't listed keeps its drawn art. Every URL comes from the manifest with its version (?v=): never build one here without it.
 */
import { thumbOf, type PresetPreview } from "./preset-cards";
import { TEMPLATE_COVERS, type TemplateCoverEntry } from "./template-covers.generated";

export type TemplateGroup = "marketing" | "fashion" | "photodump" | "shorts" | "mixed-media" | "canvas" | "content-factory" | "explainer" | "soul" | "influencer" | "examples" | "starters";

export const TEMPLATE_GROUPS: readonly TemplateGroup[] = ["marketing", "fashion", "photodump", "shorts", "mixed-media", "canvas", "content-factory", "explainer", "soul", "influencer", "examples", "starters"];

/** One still of a cover, and its 320 px copy (thumbs/ next to it, with the same version). */
export interface CoverFrame {
  src: string;
  thumb: string;
}

export interface TemplateCover {
  /** The still the tile shows at rest (a clip's first frame, or its last for a reveal: `at`). */
  poster: string;
  /** The poster's 320 px copy. */
  thumb: string;
  /** A short muted clip, played as the preset covers' are (preview-playback.ts). */
  video?: string;
  /** Where in the clip the poster is (s), when it isn't the first frame: the clip starts there, then loops from 0. */
  at?: number;
  /** Every still of the tile in order, the poster first: a carousel's slides, a contact sheet's cells. */
  frames: CoverFrame[];
}

const frame = (src: string): CoverFrame => ({ src, thumb: thumbOf(src) });

/** A manifest entry's URLs: the slim forms name a cover at /previews/templates/<group>/<id>.jpg (and .mp4) by its versions. */
function expand(key: string, e: TemplateCoverEntry): { poster: string; video?: string; at?: number; frames?: string[] } {
  const base = `/previews/templates/${key}`;
  if (typeof e === "string") return { poster: `${base}.jpg?v=${e}` };
  if (Array.isArray(e)) return { poster: `${base}.jpg?v=${e[0]}`, video: `${base}.mp4?v=${e[1]}` };
  return e;
}

/** The covers read from the manifest, each made once: a card that renders again gets the same object (memo). */
const made = new Map<string, TemplateCover>();

/** A tile's real cover, or undefined: then it shows its drawn art. */
export function templateCover(group: TemplateGroup, id: string | undefined, covers: Record<string, TemplateCoverEntry> = TEMPLATE_COVERS): TemplateCover | undefined {
  if (!id) return undefined;
  const key = `${group}/${id}`;
  if (!Object.hasOwn(covers, key)) return undefined;
  if (covers !== TEMPLATE_COVERS) return read(key, covers[key]);
  let c = made.get(key);
  if (!c) made.set(key, (c = read(key, covers[key])));
  return c;
}

function read(key: string, entry: TemplateCoverEntry): TemplateCover {
  const e = expand(key, entry);
  return {
    poster: e.poster,
    thumb: thumbOf(e.poster),
    ...(e.video && { video: e.video }),
    ...(e.video && e.at !== undefined && { at: e.at }),
    frames: [e.poster, ...(e.frames ?? [])].map(frame),
  };
}

/** A still taken from the middle of an effect's clip (its peak: /previews/presets/peak/), not a reveal's last frame. */
const PEAK_STILL = /^\/previews\/presets\/peak\//;

/**
 * A cover as the preset previews take it (PresetPreview, usePreviewPlayback): its poster and clip, and for a clip
 * whose poster is a later frame, a rest on it. A reveal (its poster is the last frame) starts there and loops from 0.
 * An effect's clip shown by its peak (the finished scene) rests on that still and, when it plays, plays the effect's
 * whole published clip from its first frame, as the effect's own gallery card does: the photo that went in, the
 * change, and the finished scene, looping. (A stretch around the peak alone showed the effect for a moment only.)
 */
export function templatePreview(c: TemplateCover): PresetPreview {
  const at = c.at;
  const peak = PEAK_STILL.test(c.poster);
  return {
    poster: c.poster,
    ...(c.video && { video: c.video }),
    ...(c.video && at !== undefined && !peak && { rest: { src: c.poster, at, from: 0 } }),
    scene: "product",
  };
}

/** For a card without a cover: the same hooks run, with nothing to play. */
export const NO_COVER: PresetPreview = { poster: "", scene: "product" };
