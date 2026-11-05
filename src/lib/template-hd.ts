/**
 * The larger copies of a template tile's poster (template-hd.generated.ts, made by scripts/gen-template-hd.mjs): its
 * own poster's URL as the tile holds it (/previews/templates/<group>/<id>.jpg) and the copies a box can choose from by
 * its size and the screen's pixel ratio, as preset-hd.ts gives a preset cover's. A tile that shows a preset's cover
 * takes that preset's copies (presetStillSources); a tile without copies keeps its published files.
 */
import { PUBLISHED_PX, SMALL_PX, type StillSources } from "@/lib/preset-hd";
import { TEMPLATE_HD } from "@/lib/template-hd.generated";

const POSTER = /^\/previews\/templates\/([a-z0-9-]+\/[a-z0-9-]+)\.jpg(?:\?|$)/;

/** The srcsets of a tile's own poster with larger copies, or undefined. `thumb` is its 320 px JPEG (thumbOf). */
export function templateStillSources(poster: string, thumb?: string): StillSources | undefined {
  const key = POSTER.exec(poster)?.[1];
  const hd = key ? TEMPLATE_HD[key] : undefined;
  if (!key || !hd) return undefined;
  const at = (w: number, ext: string) => `/previews/templates/hd/${w}/${key}.${ext}?v=${hd.v}`;
  return {
    avif: [SMALL_PX, ...hd.w].map((w) => `${at(w, "avif")} ${w}w`).join(", "),
    jpeg: [...(thumb ? [`${thumb} ${SMALL_PX}w`] : []), `${poster} ${hd.still ?? PUBLISHED_PX}w`, ...hd.w.map((w) => `${at(w, "jpg")} ${w}w`)].join(", "),
  };
}

/** Every copy a tile has (bare URLs): its poster at each width, AVIF and JPEG, and its 320 px AVIF. */
export function templateHdFiles(key: string): string[] {
  const hd = TEMPLATE_HD[key];
  if (!hd) return [];
  const at = (w: number, ext: string) => `/previews/templates/hd/${w}/${key}.${ext}`;
  return [...hd.w.flatMap((w) => [at(w, "avif"), at(w, "jpg")]), at(SMALL_PX, "avif")];
}
