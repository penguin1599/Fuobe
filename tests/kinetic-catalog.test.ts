import { describe, expect, it } from "vitest";
import { TEMPLATES } from "@/lib/catalog/marketing";
import { CLIP_SCENES, groupDefsFor, groupMatches } from "@/lib/motion/kinetic-groups";
import { entryBySlug, entryForRecipe, exampleRecipe, KINETIC_EXAMPLES, KINETIC_SCENES, KINETIC_SLUGS, normalizeKinetic, restingTime, startRecipe, templateOf } from "@/lib/motion/kinetic-catalog";
import { loadScene } from "@/lib/motion/registry";
import { presetOf } from "@/lib/motion/edit";
import { templateLengths, templateSizes } from "@/lib/motion/template";
import { templateCover } from "@/lib/template-covers";
import { measure, RASTER_LOGO } from "./helpers/motion";

// The scene list bundled with /kinetic: a scene for every code template a visitor sees, and every animation step of
// every scene in exactly one named motion group (so no visitor ever sees an internal id).

describe("the Kinetic scene catalogue", () => {
  it("has the eighteen scenes with their slugs and every template field", () => {
    expect([...KINETIC_SLUGS].sort()).toEqual(
      [
        "announcement",
        "big-number",
        "drop-countdown",
        "editorial-sale",
        "end-card",
        "feature-cards",
        "fragrance-reveal",
        "glass-spotlight",
        "kinetic-headline",
        "line-reveal",
        "logo-sting",
        "lookbook",
        "offer-badge",
        "quote",
        "starburst",
        "stat-dashboard",
        "stat-stack",
        "testimonials",
      ].sort(),
    );
    const code = TEMPLATES.filter((t) => t.render === "code" && !t.ownerOnly).map((t) => t.id);
    expect(KINETIC_SCENES.map((e) => e.template).sort()).toEqual([...code].sort());
    for (const e of KINETIC_SCENES) {
      const t = templateOf(e);
      expect(e.name).toBe(t.name);
      expect(t.fields?.length, e.slug).toBeGreaterThan(0);
      expect(e.blurb.length).toBeGreaterThan(10);
      expect(e.groups.length).toBeGreaterThan(1);
      for (const g of e.groups) expect(g.label).not.toMatch(/^[a-z]+(\.|$)/);
    }
    expect(KINETIC_SCENES.find((e) => e.slug === "end-card")!.scenes).toHaveLength(5);
    expect(KINETIC_SCENES.filter((e) => e.clip).map((e) => e.slug).sort()).toEqual(["big-number", "feature-cards", "kinetic-headline", "logo-sting", "quote"]);
    expect(CLIP_SCENES).toHaveLength(5);
  });

  it("has four examples, each with a cover", () => {
    expect(KINETIC_EXAMPLES.map((x) => x.label)).toEqual(["Kinetic Headline", "Big Number", "Logo End Card", "Five-Star Quote"]);
    for (const x of KINETIC_EXAMPLES) expect(templateCover("marketing", entryBySlug(x.slug)!.template), x.slug).toBeTruthy();
    expect(KINETIC_EXAMPLES.find((x) => x.slug === "end-card")?.style).toBe("glint");
  });

  it("finishes each example with its own presets, in 4:5 where the scene offers it", () => {
    for (const x of KINETIC_EXAMPLES) {
      const r = exampleRecipe(x);
      expect(x.purpose.length, x.slug).toBeGreaterThan(10);
      expect(normalizeKinetic(r)?.entry.slug, x.slug).toBe(x.slug);
      // Different from the scene's own tile: a look, a feel or a camera of its own.
      expect(JSON.stringify(r), x.slug).not.toBe(JSON.stringify(startRecipe(entryBySlug(x.slug)!, { style: x.style })));
      if (x.presets.appearance) expect(presetOf("appearance", r), x.slug).toBe(x.presets.appearance);
      if (templateSizes(templateOf(entryBySlug(x.slug)!)).includes("4:5")) expect(r.size, x.slug).toBe("4:5");
    }
  });

  it("rests every scene on its last frame, the poster", async () => {
    const kh = startRecipe(entryBySlug("kinetic-headline")!);
    const plan = (await loadScene(kh.scene)).plan({ recipe: kh, measure, logo: null });
    expect(restingTime(plan, kh)).toBe(plan.rest);
    const big = startRecipe(entryBySlug("big-number")!);
    const bp = (await loadScene(big.scene)).plan({ recipe: big, measure, logo: null });
    expect(restingTime(bp, big)).toBe(bp.rest);
  });

  it("holds a custom size to the export sheet's rule wherever a recipe comes from", () => {
    const big = startRecipe(entryBySlug("big-number")!);
    for (const size of [{ w: 4096, h: 4096 }, { w: 2160, h: 2160 }, { w: 255, h: 600 }, { w: 1081, h: 1350 }]) expect(normalizeKinetic({ ...big, size }), JSON.stringify(size)).toBeNull();
    expect(normalizeKinetic({ ...big, size: { w: 1080, h: 1350 } })?.recipe.size).toEqual({ w: 1080, h: 1350 });
  });

  it("puts every event of every scene in exactly one group (all sizes, shortest and longest, with and without a logo and a picture)", async () => {
    let checked = 0;
    for (const e of KINETIC_SCENES) {
      const t = templateOf(e);
      const len = templateLengths(t);
      for (const scene of e.scenes) {
        const defs = groupDefsFor(scene);
        const sc = await loadScene(scene);
        for (const size of ["9:16", "1:1", "16:9", "4:5"] as const) {
          for (const duration of [len.min, len.max]) {
            for (const logo of [true, false]) {
              for (const picture of [true, false]) {
                const base = startRecipe(e);
                const r = { ...base, scene, size, duration, brand: { ...base.brand, ...(logo ? { logo: "/previews/logo.png" } : { logo: undefined }) } };
                if (!logo) delete r.brand.logo;
                const plan = sc.plan({ recipe: r, measure, logo: logo ? RASTER_LOGO : null, ...(picture && { images: { product: { w: 800, h: 1024 } }, outlines: { product: null } }) });
                for (const ev of plan.timeline.events) {
                  const hits = groupMatches(defs, ev);
                  expect(hits, `${scene} ${size} ${duration}s logo=${logo} pic=${picture}: ${ev.id}`).toHaveLength(1);
                }
                checked++;
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  it("opens a saved recipe on its scene, drops what the scene doesn't take, and refuses what isn't a scene", () => {
    const big = startRecipe(entryBySlug("big-number")!);
    expect(normalizeKinetic(big)?.entry.slug).toBe("big-number");
    const withClip = { ...startRecipe(entryBySlug("line-reveal")!), layers: { video: { src: "/api/files/x.mp4", from: 0, fit: "cover" as const, dim: 0, scrim: "none" as const } }, groups: { nope: { keys: [[0, 0], [1, 1]] as [number, number][], rate: 1.5 }, outline: { keys: [[0, 0], [1, 1]] as [number, number][], rate: 1.5 } } };
    const n = normalizeKinetic(withClip)!;
    expect(n.recipe.layers).toBeUndefined();
    expect(Object.keys(n.recipe.groups!)).toEqual(["outline"]);
    expect(normalizeKinetic({ ...big, scene: "marketing/nothing" })).toBeNull();
    expect(normalizeKinetic({ hello: 1 })).toBeNull();
    // Click to Ad's end cards (no template) open as Logo End Card.
    const card = { ...startRecipe(entryBySlug("end-card")!), controls: {}, size: { w: 720, h: 1280 }, fps: 24 as const, duration: 2.5 };
    expect(entryForRecipe(card)?.slug).toBe("end-card");
    expect(normalizeKinetic(card)?.recipe.size).toEqual({ w: 720, h: 1280 });
  });
});
