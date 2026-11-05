import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GALLERY_GRID } from "@/components/skeletons";
import { PresetGrid } from "@/components/studio/preset-chips";
import { APPS, EFFECTS, MOTIONS } from "@/lib/catalog";
import type { Preset } from "@/lib/catalog/types";
import { HOME_BEFORE_AFTER, HOME_EFFECTS, HOME_MOTIONS, HOME_REVEALS, HOME_WALL } from "@/lib/home-showcase";
import { toPresetCard } from "@/lib/preset-card-data";
import { FEATURED, FEATURED_BANDS, featuredAll, featuredBand, featuredGallery } from "@/lib/preset-featured";

// home-showcase.ts reads next/cache, which only a Next render provides.
vi.mock("next/cache", () => ({ cacheLife: () => {} }));

/*
 * The featured order (src/lib/preset-featured.ts) against the catalog, Home and the galleries: every preset is
 * listed once, Home and each gallery open on the first band, and a gallery's tabs keep the catalog's order.
 */

const KINDS: [keyof typeof FEATURED, Preset[]][] = [
  ["app", APPS],
  ["motion", MOTIONS],
  ["effect", EFFECTS],
];
/** The most cards a gallery row holds (GALLERY_GRID's widest grid). */
const ROW = Math.max(...[...GALLERY_GRID.matchAll(/grid-cols-(\d+)/g)].map((m) => Number(m[1])));

describe("Featured order", () => {
  it("lists every preset of the catalog once, under its own kind", () => {
    for (const [kind, list] of KINDS) {
      const listed = FEATURED[kind].flat();
      expect(new Set(listed).size, kind).toBe(listed.length);
      expect([...listed].sort(), kind).toEqual(list.map((p) => p.id).sort());
      for (const band of FEATURED[kind]) expect(band.length, kind).toBeGreaterThan(0);
    }
  });

  it("puts a preset that isn't listed yet (a new one) after the listed ones, in catalog order", () => {
    expect(featuredBand("effect-not-listed")).toBe(FEATURED_BANDS);
    const last = FEATURED.effect.at(-1)!.at(-1)!;
    const items = [
      { id: "effect-new-b", category: "Elements" },
      { id: last, category: "Elements" },
      { id: "effect-new-a", category: "Elements" },
      { id: FEATURED.effect[0][0], category: "Elements" },
    ];
    expect(featuredAll(items).map((i) => i.id)).toEqual([FEATURED.effect[0][0], last, "effect-new-b", "effect-new-a"]);
  });

  it("opens Home's wall and every row's first cards on the first band, and takes none from the last", () => {
    // Each row's first row of six where it's widest (Camera motions its first two), and the six beside the before/after.
    const first = [...HOME_WALL, ...HOME_MOTIONS.slice(0, 12), ...HOME_REVEALS.slice(0, 6), ...HOME_BEFORE_AFTER, ...HOME_EFFECTS.slice(0, 6)].map((t) => t.id);
    for (const id of first) expect(featuredBand(id), id).toBe(0);
    // The rows under them: premium first, so nothing from the last band (the novelty effects: flames, wings, clones).
    const later = [...HOME_MOTIONS.slice(12), ...HOME_REVEALS.slice(6), ...HOME_EFFECTS.slice(12)].map((t) => t.id);
    for (const id of later) expect(featuredBand(id), id).toBeLessThan(FEATURED_BANDS - 1);
  });

  it("opens each gallery on the first band, a category per card, with the tabs in catalog order", () => {
    for (const [kind, list] of KINDS) {
      const { presets, categories } = featuredGallery(list.map(toPresetCard));
      expect(categories, kind).toEqual([...new Set(list.map((p) => p.category))]);
      expect(presets.map((p) => p.id).sort(), kind).toEqual(list.map((p) => p.id).sort());
      const row = presets.slice(0, ROW);
      expect(row[0].id, kind).toBe(FEATURED[kind][0][0]);
      for (const p of row) expect(featuredBand(p.id), p.id).toBe(0);
      expect(new Set(row.map((p) => p.category)).size, kind).toBe(ROW);
      // Band by band: no card of a later band before one of an earlier one.
      const bands = presets.map((p) => featuredBand(p.id));
      expect(bands, kind).toEqual([...bands].sort((a, b) => a - b));
      // A category shows its presets in the listed order.
      const place = new Map(FEATURED[kind].flat().map((id, i) => [id, i]));
      for (const c of categories) {
        const at = presets.filter((p) => p.category === c).map((p) => place.get(p.id)!);
        expect(at, `${kind} ${c}`).toEqual([...at].sort((a, b) => a - b));
      }
    }
  });

  it("lists a studio picker's tiles in its gallery's order", () => {
    // The tiles' names as the camera motion and effect pickers render them, after None (the tabs are buttons too).
    const tileNames = (list: Preset[]) =>
      renderToStaticMarkup(createElement(PresetGrid, { list, noneLabel: "None", onPick: () => {} }))
        .split("<button")
        .slice(1)
        .filter((b) => !b.includes('role="tab"'))
        .slice(1)
        .map((b) => [...b.matchAll(/font-medium">([^<]*)<\/span>/g)].at(-1)![1].replaceAll("&amp;", "&").replaceAll("&#x27;", "'"));
    for (const list of [MOTIONS, EFFECTS]) {
      const gallery = featuredGallery(list.map(toPresetCard)).presets.map((p) => p.name);
      expect(tileNames(list)).toEqual(gallery);
      expect(gallery).not.toEqual(list.map((p) => p.name));
    }
  });
});
