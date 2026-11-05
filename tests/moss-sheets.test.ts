import { beforeAll, describe, expect, it, vi } from "vitest";
import { tempDir } from "./helpers/temp-dir";
import { applyMeasured, imagesToMeasure } from "@/components/layers/apply";
import { getModel, getPreset } from "@/lib/catalog";
import { planGeneration } from "@/lib/catalog/plan";
import { planOneSheet, sheetCrop, sheetCrops, sheetGrid, sheetPanelLimit, sheetPanelStyle, sheetState, SHEET_MODELS } from "@/lib/catalog/storyboard";
import type { GenerationRequest } from "@/lib/catalog/types";
import { layersLayout, RERENDER_MAX_LAYERS, TOOL_MODELS, type LayerDoc, type LayerJob, type LayerJobInput, type LayerNode } from "@/lib/layers";
import { readLayout } from "@/lib/layout-prompt";

// N7-11: MOSS-Image's layouts in two studios people already use. Storyboard's "One sheet" draws every panel on one page
// (a multi-panel layout, cropped into frames in the browser); Layers' "Re-render from layers" paints the arrangement again
// from each visible layer's box and the text read off the picture. Demo mode: no keys, no GPU.
const dir = tempDir("fuobe-moss-sheets-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";

const { setSetting } = await import("@/server/settings");
const { createStoryboard, estimateStoryboard } = await import("@/server/storyboard");
const { jobSteps, nearestAspect, rerenderCaption } = await import("@/server/layers");
const { getGeneration } = await import("@/server/generations");

beforeAll(() => setSetting("demoMode", "auto"));

const plan = (r: GenerationRequest) => planGeneration(r, getModel, getPreset);
const ratio = (a: string) => {
  const [w, h] = a.split(":").map(Number);
  return w / h;
};

describe("one-sheet storyboard: the grid", () => {
  it("puts four 16:9 panels in a 2 × 2 grid on a 16:9 sheet, and keeps every panel at its shape inside the sheet", () => {
    const g = sheetGrid(4, "16:9");
    expect(g).toMatchObject({ cols: 2, rows: 2, aspect: "16:9" });
    for (const [x0, y0, x1, y1] of g.boxes) {
      expect(x0).toBeGreaterThan(0);
      expect(y0).toBeGreaterThan(0);
      expect(x1).toBeLessThan(1);
      expect(y1).toBeLessThan(1);
      // The panel's shape in pixels: its fractions times the sheet's shape.
      expect(((x1 - x0) * ratio(g.aspect)) / (y1 - y0)).toBeCloseTo(16 / 9, 4);
    }
  });

  it("never overlaps panels, reads left to right then down, and centres a short last row", () => {
    for (const [n, aspect] of [[3, "16:9"], [5, "16:9"], [6, "9:16"], [7, "1:1"], [8, "21:9"], [1, "4:3"]] as const) {
      const g = sheetGrid(n, aspect);
      expect(g.boxes).toHaveLength(n);
      expect(g.cols * g.rows).toBeGreaterThanOrEqual(n);
      g.boxes.forEach((a, i) =>
        g.boxes.slice(i + 1).forEach((b) => {
          const apart = a[2] <= b[0] + 1e-9 || b[2] <= a[0] + 1e-9 || a[3] <= b[1] + 1e-9 || b[3] <= a[1] + 1e-9;
          expect(apart, `${n} at ${aspect}`).toBe(true);
        }),
      );
    }
    const five = sheetGrid(5, "16:9");
    expect(five).toMatchObject({ cols: 3, rows: 2 });
    // The last row's two panels sit in the middle: as far from the left edge as from the right.
    const [d, e] = five.boxes.slice(3);
    expect(d[0]).toBeCloseTo(1 - e[2], 5);
    expect(five.boxes[1][0]).toBeGreaterThan(five.boxes[0][0]);
    expect(five.boxes[3][1]).toBeGreaterThan(five.boxes[0][1]);
  });

  it("takes the sheet shape that gives the panels the most room", () => {
    // Two tall panels side by side fit a landscape-ish sheet better than a portrait one.
    expect(ratio(sheetGrid(2, "9:16").aspect)).toBeGreaterThanOrEqual(1);
    // Eight wide panels stack in more rows than columns would allow at their shape.
    const eight = sheetGrid(8, "21:9");
    expect(eight.rows).toBeGreaterThanOrEqual(eight.cols);
  });
});

describe("one-sheet storyboard: the crop", () => {
  it("cuts each panel inside its box in whole pixels, on the picture", () => {
    expect(sheetCrop([0.1, 0.2, 0.5, 0.6], 1000, 500)).toEqual([100, 100, 400, 200]);
    // Fractional edges round inward, so no gutter shows at the panel's edge.
    expect(sheetCrop([0.1004, 0.2004, 0.4996, 0.5996], 1000, 500)).toEqual([101, 101, 398, 198]);
    // Past the edge is kept on the picture.
    expect(sheetCrop([-0.1, 0.9, 1.2, 1.5], 100, 100)).toEqual([0, 90, 100, 10]);
  });

  it("crops the panels of a real grid at the size the model rendered, the same shape as the panels", () => {
    const g = sheetGrid(4, "16:9");
    const crops = sheetCrops(g.boxes, 1376, 768);
    expect(crops).toHaveLength(4);
    for (const [x, y, w, h] of crops) {
      expect([x, y, w, h].every(Number.isInteger)).toBe(true);
      expect(x + w).toBeLessThanOrEqual(1376);
      expect(y + h).toBeLessThanOrEqual(768);
      expect(w / h).toBeCloseTo(16 / 9, 1);
    }
  });

  it("shows a panel from the sheet as a tile's background", () => {
    expect(sheetPanelStyle([0.25, 0, 0.75, 0.5])).toEqual({ backgroundSize: "200% 200%", backgroundPosition: "50% 0%" });
    expect(sheetPanelStyle([0, 0, 1, 1])).toEqual({ backgroundSize: "100% 100%", backgroundPosition: "0% 0%" });
  });
});

describe("one-sheet storyboard: who gets it", () => {
  it("is the owner's alone until a GPU render is recorded, then everyone's up to the panels it showed", () => {
    expect(sheetPanelLimit(true, null)).toBe(8);
    expect(sheetPanelLimit(false, null)).toBe(0);
    const test = { date: "2026-11-02", gpu: "RTX 4090 24 GB", maxPanels: 6 };
    expect(sheetPanelLimit(false, test)).toBe(6);
    expect(sheetPanelLimit(true, test)).toBe(6);
  });

  it("holds the panel count a GPU render showed on the server too, not only in the browser", () => {
    const seven = Array.from({ length: 7 }, (_, i) => `scene ${i + 1}`);
    const test = { date: "2026-11-02", gpu: "RTX 4090 24 GB", maxPanels: 6 };
    expect(() => planOneSheet({ engine: "open", scenes: seven }, test)).toThrow(/at most 6 panels/);
    expect(planOneSheet({ engine: "open", scenes: seven.slice(0, 6) }, test).frame?.sheet?.panels).toHaveLength(6);
    expect(() => planOneSheet({ engine: "open", scenes: seven }, { ...test, maxPanels: 0 })).toThrow(/isn't available yet/);
    expect(planOneSheet({ engine: "open", scenes: seven }).frame?.sheet?.panels).toHaveLength(7);
  });

  it("says in the board's header when the sheet failed or was cancelled, not that it is on the way", () => {
    expect(sheetState("succeeded")).toBe("done");
    expect(sheetState("failed")).toBe("failed");
    expect(sheetState("canceled")).toBe("cancelled");
    expect(sheetState("queued")).toBe("on the way");
    expect(sheetState("running")).toBe("on the way");
  });
});

describe("one-sheet storyboard: the request", () => {
  const scenes = ["a keeper climbs the lighthouse stairs", "she finds a glowing bottle.", "she unrolls the map", "she rows into the dark sea"];

  it("draws every panel on MOSS-Image on both engines, a multi-panel layout with one box per panel and its shot", () => {
    for (const engine of ["open", "cloud"] as const) {
      const r = planOneSheet({ engine, scenes, aspectRatio: "16:9", style: "35mm film" });
      expect(r.modelId).toBe(SHEET_MODELS[engine]);
      expect(getModel(r.modelId)?.options.layout).toBe("moss");
      const draft = readLayout(r.params?.extra?.layout)!;
      expect(draft.summary.canvas).toBe("multi_panel");
      expect(draft.items.map((i) => i.caption)).toEqual(["Panel 1, a keeper climbs the lighthouse stairs.", "Panel 2, she finds a glowing bottle.", "Panel 3, she unrolls the map.", "Panel 4, she rows into the dark sea."]);
      expect(r.params?.aspectRatio).toBe("16:9");
      expect(r.prompt).toMatch(/4 cinematic panels in a 2 by 2 grid.*Style: 35mm film\.$/);
      expect(r.frame).toMatchObject({ scene: scenes[0], index: 0, of: 1, sheet: { cols: 2, rows: 2, aspect: "16:9" } });
      expect(r.frame?.sheet?.panels.map((p) => p.box)).toEqual(draft.items.map((i) => i.box));
    }
  });

  it("compiles to MOSS-Image's multi-panel JSON at the size each engine renders, with prompt rewriting off", () => {
    const open = plan(planOneSheet({ engine: "open", scenes, aspectRatio: "16:9" }));
    const json = JSON.parse(open.prompt);
    expect(json.summary.canvas).toBe("multi_panel");
    expect(json.items).toHaveLength(4);
    expect(json.bbox_coord_space).toBe("abs_centralized");
    expect(open.params.enhancePrompt).toBe(false);
    expect(open.layout).toMatchObject({ format: "moss", boxes: 4 });
    const cloud = plan(planOneSheet({ engine: "cloud", scenes, aspectRatio: "16:9" }));
    expect(JSON.parse(cloud.prompt).items).toHaveLength(4);
    expect(cloud.params.extra?.image_size).toEqual({ width: cloud.layout!.width, height: cloud.layout!.height });
  });

  it("is drawn from words alone: references are refused, and so is a look", () => {
    expect(() => planOneSheet({ engine: "open", scenes, references: ["/api/files/a.png"] })).toThrow(/from your words alone/);
    expect(() => estimateStoryboard({ engine: "open", sheet: true, scenes, look: "v1-general" })).toThrow(/no look/);
  });

  it("prices one sheet (free on your GPU, per megapixel in the cloud) and makes one picture", async () => {
    const open = estimateStoryboard({ engine: "open", sheet: true, scenes });
    expect(open).toMatchObject({ frames: 4, models: ["MOSS-Image"] });
    const cloud = estimateStoryboard({ engine: "cloud", sheet: true, scenes, aspectRatio: "16:9" });
    expect(cloud.models).toEqual(["MOSS-Image"]);
    const board = await createStoryboard({ engine: "open", sheet: true, scenes });
    expect(board.items).toHaveLength(1);
    const g = getGeneration(board.items[0].id)!;
    expect(g.modelId).toBe("oss-moss-image");
    expect(g.request.frame?.sheet?.panels).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------

const node = (id: string, z: number, extra: Partial<LayerNode> = {}): LayerNode => ({
  id,
  name: id,
  z,
  x: 0,
  y: 0,
  w: 100,
  h: 50,
  rotation: 0,
  src: `/api/files/${id}.png`,
  natural: [100, 50],
  revisions: [{ src: `/api/files/${id}.png`, natural: [100, 50], label: "Original", at: 1 }],
  revision: 0,
  ...extra,
});
const doc = (nodes: LayerNode[], w = 400, h = 200): LayerDoc => ({ v: 1, width: w, height: h, source: "/api/files/src.png", decomposed: true, nodes });

describe("re-render from layers: the layout", () => {
  it("boxes each visible layer by its rotation-aware bounds on the canvas, bottom to top, with its name or prompt", () => {
    const d = doc([
      node("Sky", 0, { w: 400, h: 200 }),
      node("Red mug", 1, { x: 40, y: 40, w: 100, h: 50 }),
      // Turned 90°: a 100 × 50 box around (250, 100) stands 50 wide and 100 tall.
      node("Layer 3", 2, { x: 200, y: 75, w: 100, h: 50, rotation: 90, prompt: "A brass key." }),
      node("Hidden", 3, { x: 0, y: 0, hidden: true }),
      node("Woman in a red coat", 4, { x: 350, y: 150, w: 100, h: 100 }),
    ]);
    const { draft, counts, caption } = layersLayout(d);
    expect(counts).toEqual({ layers: 3, text: 0, backdrop: 1 });
    expect(draft.items.map((i) => [i.label, i.caption])).toEqual([
      ["object", "Red mug"],
      ["object", "A brass key"],
      ["character", "Woman in a red coat"],
    ]);
    expect(draft.items[0].box).toEqual([0.1, 0.2, 0.35, 0.45]);
    expect(draft.items[1].box).toEqual([0.5625, 0.25, 0.6875, 0.75]);
    // Kept on the canvas: the part past the right and bottom edges is cut off.
    expect(draft.items[2].box).toEqual([0.875, 0.75, 1, 1]);
    expect(caption).toMatch(/^One coherent picture that keeps this arrangement: red mug, a brass key, woman in a red coat\. Behind everything: Sky\./);
    expect(draft.summary.caption).toBe(caption);
  });

  it("adds the lines of text read off the picture as text items with their exact words", () => {
    const d = doc([node("Bottle", 0, { x: 100, y: 50 })]);
    const text = [
      { text: "  SUMMER\n SALE ", box: [20, 10, 200, 40] as [number, number, number, number] },
      { text: "no place", box: null },
      { text: "off canvas", box: [500, 500, 10, 10] as [number, number, number, number] },
    ];
    const { draft, counts } = layersLayout(d, text, "A bright beach poster.");
    expect(counts).toEqual({ layers: 1, text: 1, backdrop: 0 });
    expect(draft.items[1]).toMatchObject({ label: "text", text: "SUMMER SALE", box: [0.05, 0.05, 0.55, 0.25] });
    expect(draft.summary.caption).toBe("A bright beach poster.");
  });

  it("keeps the largest layers when there are too many, and leaves out an edit's original half", () => {
    const many = Array.from({ length: RERENDER_MAX_LAYERS + 5 }, (_, i) => node(`L${i}`, i, { x: i, y: 0, w: 10 + i, h: 10 }));
    const { draft } = layersLayout(doc([...many, node("Original", 99, { role: "original" })]));
    expect(draft.items).toHaveLength(RERENDER_MAX_LAYERS);
    expect(draft.items[0].caption).toBe("L5");
    expect(draft.items.some((i) => i.caption === "Original")).toBe(false);
  });

  it("leaves out an earlier re-render, which repaints the layers under it rather than being a backdrop", () => {
    const earlier = node("Re-render", 2, { w: 400, h: 200, revisions: [{ src: "/api/files/r.png", natural: [400, 200], label: "Re-render from layers", at: 2 }] });
    const { counts, caption } = layersLayout(doc([node("Sky", 0, { w: 400, h: 200 }), node("Red mug", 1, { x: 40, y: 40 }), earlier]));
    expect(counts).toEqual({ layers: 1, text: 0, backdrop: 1 });
    expect(caption).not.toMatch(/Re-render/);
    // Renamed and kept as an ordinary layer, the name alone says nothing about what it shows.
    const renamed = layersLayout(doc([node("Re-render", 0, { w: 400, h: 200 }), node("Red mug", 1, { x: 40, y: 40 })]));
    expect(renamed.caption).toMatch(/Behind everything: a picture element/);
  });

  it("drops a layer whose part on the canvas is under a pixel, instead of a box with no size", () => {
    const d = doc([node("Red mug", 0, { x: 40, y: 40 }), node("Sliver", 1, { x: 399.9999, y: 0 })], 400, 200);
    const text = [{ text: "EDGE", box: [399.5, 10, 20, 20] as [number, number, number, number] }];
    const { draft, counts } = layersLayout(d, text);
    expect(counts).toEqual({ layers: 1, text: 0, backdrop: 0 });
    expect(readLayout(draft)?.items).toHaveLength(1);
    expect(() => jobSteps({ tool: "rerender", engine: "open", frame: [0, 0, 400, 200], settings: { aspect: "400:200", layout: draft } } as LayerJobInput)).not.toThrow();
  });
});

describe("re-render from layers: the job", () => {
  const frame: [number, number, number, number] = [0, 0, 1400, 900];
  const layout = layersLayout(doc([node("Red mug", 0, { x: 40, y: 40 })], 1400, 900)).draft;
  const steps = (i: Partial<LayerJobInput>) => jobSteps({ tool: "rerender", engine: "open", frame, settings: { aspect: "1400:900", layout }, ...i } as LayerJobInput);

  it("offers MOSS-Image on both engines, and Ideogram 4.5 and FLUX.3 as the cloud's other box readers", () => {
    expect(TOOL_MODELS.rerender).toEqual({ cloud: ["moss-image", "ideogram-4-5", "flux-3"], open: ["oss-moss-image"] });
    for (const id of [...TOOL_MODELS.rerender.cloud, ...TOOL_MODELS.rerender.open]) expect(getModel(id)?.options.layout, id).toMatch(/moss|ideogram|flux3/);
  });

  it("runs the layout as text to image at the picture's nearest shape, compiled for the model it runs on", () => {
    const [step] = steps({});
    expect(step.request).toMatchObject({ feature: "layers", modelId: "oss-moss-image", op: "t2i", params: { aspectRatio: "3:2", numOutputs: 1 } });
    const p = plan(step.request);
    expect(JSON.parse(p.prompt).items[0]).toMatchObject({ label: "object", caption: "Red mug" });
    expect(p.params.enhancePrompt).toBe(false);
    const ideo = plan(steps({ engine: "cloud", modelId: "ideogram-4-5" })[0].request);
    expect(ideo.layout?.format).toBe("ideogram");
    // Words sent beside a caption made without them go in front of it.
    expect(steps({ engine: "cloud", prompt: "A cosy kitchen" })[0].request.prompt).toMatch(/^A cosy kitchen\. One coherent picture that keeps this arrangement: red mug\./);
  });

  it("keeps the backdrop in the words the model reads when the person describes the picture", () => {
    const d = doc([node("a beach at dusk", 0, { w: 1400, h: 900 }), node("Red mug", 1, { x: 40, y: 40 })], 1400, 900);
    const typed = layersLayout(d, [], "warm photo").draft;
    expect(typed.summary.caption).toBe("warm photo. Behind everything: a beach at dusk.");
    for (const [engine, modelId] of [["open", "oss-moss-image"], ["cloud", "moss-image"], ["cloud", "ideogram-4-5"], ["cloud", "flux-3"]] as const) {
      const [step] = jobSteps({ tool: "rerender", engine, modelId, frame, prompt: "warm photo", settings: { aspect: "1400:900", layout: typed } } as LayerJobInput);
      expect(step.request.prompt, modelId).toBe("warm photo. Behind everything: a beach at dusk.");
      expect(plan(step.request).prompt, modelId).toMatch(/a beach at dusk/);
    }
    expect(rerenderCaption("Warm photo. Behind everything: sand.", "warm photo.")).toBe("Warm photo. Behind everything: sand.");
    expect(rerenderCaption("", "warm photo")).toBe("warm photo");
    expect(rerenderCaption("A caption.", undefined)).toBe("A caption.");
  });

  it("refuses an empty arrangement and a model that doesn't read boxes", () => {
    expect(() => steps({ settings: { layout: { summary: { caption: "", meta: [], canvas: "single" }, items: [] } } })).toThrow(/at least one layer/);
    expect(() => steps({ settings: {} })).toThrow(/at least one layer/);
    expect(() => steps({ engine: "cloud", modelId: "nano-banana-pro" })).toThrow(/can't run this tool/);
  });

  it("picks the nearest aspect ratio on a log scale", () => {
    expect(nearestAspect("1400:900", ["1:1", "3:2", "16:9"])).toBe("3:2");
    expect(nearestAspect("1000:3000", ["1:1", "9:16", "2:3"])).toBe("9:16");
    expect(nearestAspect(undefined, ["1:1"])).toBe("1:1");
    expect(nearestAspect("5:4", undefined)).toBe("5:4");
  });

  it("lands as a new layer covering the canvas, the layers kept underneath", () => {
    const d = doc([node("Red mug", 0)], 400, 300);
    const job: LayerJob = { id: "j", tool: "rerender", label: "Re-render from layers", frame: [0, 0, 400, 300], generationIds: ["g"], state: "pending", createdAt: 1, result: { status: "succeeded", progress: 1, message: null, error: null, provider: "mock", outputs: [{ url: "/api/files/r.png", kind: "image" }] } };
    expect(imagesToMeasure(job)).toEqual([{ url: "/api/files/r.png", alpha: false }]);
    const r = applyMeasured(d, job, { outputs: [{ url: "/api/files/r.png", natural: [1216, 832] }] }, { newId: () => "n1", at: 2 });
    expect(r.doc.nodes).toHaveLength(2);
    expect(r.doc.nodes[1]).toMatchObject({ id: "n1", name: "Re-render", x: 0, y: 0, w: 400, h: 300 });
    expect(r.doc.nodes[0].hidden).toBeUndefined();
    expect(r.message).toMatch(/added on top/);
  });
});

vi.setConfig({ testTimeout: 20_000 });
