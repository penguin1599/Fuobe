import { describe, expect, it } from "vitest";
import { TEMPLATES, templatesFor, visibleTemplate } from "@/lib/catalog/marketing";
import { textNodes, type DisplayNode } from "@/lib/motion/display";
import type { Recipe } from "@/lib/motion/recipe";
import { loadScene } from "@/lib/motion/registry";
import { COVER_LEAD } from "@/lib/motion/scenes/marketing/poster";
import { showcaseRecipe } from "@/lib/motion/showcase";
import { initialState, templateRecipe } from "@/lib/motion/template";
import { measure, RASTER_LOGO } from "./helpers/motion";

// The poster scenes inside Kinetic's editor and the gallery: the brand's own fonts when the person picks them, the
// Pro controls (pace, camera, finish), a gallery cover's clip that opens on its finished poster, and every code template
// open to everyone.

const tpl = (id: string) => TEMPLATES.find((t) => t.id === id)!;
const plan = async (r: Recipe) => (await loadScene(r.scene)).plan({ recipe: r, measure, logo: RASTER_LOGO, images: { product: { w: 800, h: 1024 }, photo: { w: 1024, h: 1536 } }, outlines: { product: null } });
const fonts = (nodes: DisplayNode[]) => new Set(textNodes(nodes).flatMap((n) => n.runs.map((r) => /"([^"]+)"/.exec(r.font)?.[1] ?? "")));

describe("poster scenes in the editor", () => {
  it("sets the words in the brand's own fonts when the person picks them, and in the template's pairing otherwise", async () => {
    const t = tpl("ms-kinetic-headline");
    const s = { ...initialState(t), brand: { ...initialState(t).brand, fonts: { heading: "Playfair Display", body: "Inter" } } };
    const own = await plan(templateRecipe(t, s));
    expect([...fonts(own.evaluate(own.rest).nodes)].some((f) => f.startsWith("Kinetic "))).toBe(true);
    const brand = templateRecipe(t, { ...s, brandFonts: true });
    expect(brand.controls?.type).toBe("brand");
    const mine = fonts((await plan(brand)).evaluate(own.rest).nodes);
    expect(mine.has("Playfair Display")).toBe(true);
    expect([...mine].some((f) => f.startsWith("Kinetic "))).toBe(false);
  });

  it("takes the Pro pace, a locked camera and the finish", async () => {
    const t = tpl("ms-big-number");
    const base = templateRecipe(t, initialState(t));
    const p0 = await plan(base);
    const slow = await plan({ ...base, motion: { curves: "smooth", pace: 1.2 } });
    expect(slow.settled).toBeGreaterThan(p0.settled);
    const graded = await plan({ ...base, finish: { contrast: 0.2, saturation: 0, grain: 0.3, grainSize: 1.2 } });
    expect(graded.evaluate(1).finish).toBeTruthy();
    const locked = await plan({ ...base, camera: { move: "locked", amount: 1, breath: 1 } });
    expect(JSON.stringify(locked.evaluate(locked.rest))).toBe(JSON.stringify(p0.evaluate(p0.rest)));
  });
});

describe("gallery covers", () => {
  it("open on the finished poster, dissolve into the opening and end on the same poster", async () => {
    for (const id of ["ms-feature-cards", "ms-dashboard-zoom", "m2-offer-badge"]) {
      const r = showcaseRecipe(id, tpl(id).scene!, 5, { cover: true })!;
      const p = await plan(r);
      const first = p.evaluate(0);
      const lead = first.nodes.find((n) => n.type === "group" && n.id === "lead");
      expect(lead, id).toBeTruthy();
      expect(lead!.type === "group" && lead!.opacity, id).toBe(1);
      expect(p.evaluate(COVER_LEAD + 0.01).nodes.some((n) => n.type === "group" && n.id === "lead"), id).toBe(false);
      // The tile's still is the rest frame, unchanged.
      const controls = { ...r.controls };
      delete controls.cover;
      const plain = await plan({ ...r, controls });
      expect(p.evaluate(p.rest).nodes.length).toBeGreaterThan(0);
      expect(plain.evaluate(0).nodes.some((n) => n.type === "group" && n.id === "lead")).toBe(false);
    }
  });
});

describe("who sees the code templates", () => {
  it("lists and opens every one of them for everyone", () => {
    const code = TEMPLATES.filter((t) => t.render === "code").map((t) => t.id);
    expect(code.length).toBeGreaterThanOrEqual(18);
    const guest = templatesFor("all", "all").map((t) => t.id);
    for (const id of code) {
      expect(guest, id).toContain(id);
      expect(visibleTemplate(tpl(id), false), id).toBe(true);
    }
    for (const id of ["m2-midnight-drop", "m2-nocturne", "m2-season-finale", "m2-prism-stage", "mm-marquee", "mm-runway-titles", "ms-stat-stack", "ms-kind-words"]) expect(guest, id).toContain(id);
  });

  it("still keeps a template marked for the owner to the owner", () => {
    const held = { ...tpl("ms-stat-stack"), ownerOnly: true as const };
    expect(visibleTemplate(held, false)).toBe(false);
    expect(visibleTemplate(held, true)).toBe(true);
  });
});
