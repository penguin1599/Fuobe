import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getModel, supportsOp } from "@/lib/catalog";
import { imageLimit } from "@/lib/catalog/plan";
import type { Operation } from "@/lib/catalog/types";
import { layersHref } from "@/lib/output-actions";
import { tempDir } from "./helpers/temp-dir";
import {
  addNodes,
  addRevision,
  bboxFromAlpha,
  clampLayers,
  crc32,
  cropRect,
  decomposeCost,
  deleteNode,
  docJson,
  duplicateNode,
  expandPads,
  historyReducer,
  MERGE_WINDOW_MS,
  initialDoc,
  layerFileName,
  moveNode,
  nativeSize,
  nodesFromOutputs,
  placeOutput,
  rectFrom,
  relightPrompt,
  reframeDoc,
  replaceNodes,
  resizeBox,
  rotatedBounds,
  rotationTo,
  setRevision,
  slugify,
  storedZip,
  textBlocksFrom,
  textEditPrompt,
  textJobTitle,
  tightenToAlpha,
  toLocal,
  TOOL_MODELS,
  zipPlan,
  ENHANCE_DETAIL_MODELS,
  ENHANCE_DETAIL_SCALE,
  ENHANCE_LOOKS,
  elementDraft,
  enhanceModels,
  enhancePrompt,
  inpaintPrompt,
  needsDetectedSize,
  placeTextBlocks,
  readableBackdrop,
  seeThrough,
  coverage,
  defaultLayers,
  exportScale,
  layerDensity,
  layerExportScale,
  LayerLimitError,
  layersModelFor,
  MAX_NODES,
  MAX_REVISIONS,
  minLayers,
  roomFor,
  scaledSize,
  sourceBoxOf,
  updateNode,
  type Box,
  type History,
  type LayerDoc,
  type LayerNode,
} from "@/lib/layers";

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

const doc = (nodes: LayerNode[], w = 400, h = 300): LayerDoc => ({ v: 1, width: w, height: h, source: "/api/files/src.png", decomposed: true, nodes });
const close = (a: number[], b: number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));

describe("zip naming", () => {
  it("slugs names the way Higgsfield names layer files", () => {
    expect(slugify("Hero Shot / v2!")).toBe("hero-shot-v2");
    expect(slugify("  --Café Crème--  ")).toBe("cafe-creme");
    expect(slugify("x".repeat(60))).toHaveLength(48);
    // Cut at 48, then no dangling dash.
    expect(slugify(`${"a".repeat(47)} b`)).toBe("a".repeat(47));
    expect(layerFileName(3, "Red Guitar")).toBe("layer-z3-red-guitar.png");
    expect(layerFileName(0, "背景", 0)).toBe("layer-z0-layer-0.png");
    expect(layerFileName(2, "!!!", 5)).toBe("layer-z2-layer-5.png");
  });

  it("orders zip entries by z, keeps hidden layers and never repeats a name", () => {
    const d = doc([node("b", 1, { name: "Subject" }), node("a", 0, { name: "Background", hidden: true }), node("c", 2, { name: "Subject" })]);
    expect(zipPlan(d)).toEqual([
      { nodeId: "a", file: "layer-z0-background.png" },
      { nodeId: "b", file: "layer-z1-subject.png" },
      { nodeId: "c", file: "layer-z2-subject.png" },
    ]);
    const twins = doc([node("a", 0, { name: "A" }), node("b", 0, { name: "A" })]);
    expect(zipPlan(twins).map((e) => e.file)).toEqual(["layer-z0-a.png", "layer-z0-a-2.png"]);
  });

  it("writes a stored zip other tools can read back", () => {
    const data = new TextEncoder().encode("hello layers");
    // Known CRC-32 of "123456789".
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const zip = storedZip([
      { name: "composite.png", data: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) },
      { name: "layer-z0-background.png", data },
    ]);
    const dir = tempDir("fuobe-layers-zip-");
    try {
      const file = path.join(dir, "cropped-layers.zip");
      fs.writeFileSync(file, zip);
      const out = execFileSync("python3", ["-c", "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print('|'.join(i.filename+':'+str(i.file_size) for i in z.infolist()));print(z.read('layer-z0-background.png').decode())", file]).toString().trim().split("\n");
      expect(out[0]).toBe("composite.png:7|layer-z0-background.png:12");
      expect(out[1]).toBe("hello layers");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("copies the document as JSON with absolute links", () => {
    const d = doc([node("a", 0, { name: "Background", crop: [1, 2, 3, 4] })]);
    const j = JSON.parse(docJson(d, "http://localhost:3000"));
    expect(j).toMatchObject({ width: 400, height: 300, source: "http://localhost:3000/api/files/src.png" });
    expect(j.layers[0]).toEqual({
      type: "image",
      layerIndex: 0,
      name: "Background",
      geometry: { x: 0, y: 0, width: 100, height: 50, rotation: 0 },
      hidden: false,
      opacity: 1,
      source: "http://localhost:3000/api/files/a.png",
      crop: [1, 2, 3, 4],
    });
  });
});

describe("geometry", () => {
  it("finds the alpha box", () => {
    const w = 8;
    const h = 6;
    const data = new Uint8ClampedArray(w * h * 4);
    expect(bboxFromAlpha(data, w, h)).toBeNull();
    const set = (x: number, y: number, a = 255) => (data[(y * w + x) * 4 + 3] = a);
    set(2, 1);
    set(5, 4);
    set(7, 0, 3); // faint: below the threshold below
    expect(bboxFromAlpha(data, w, h, 8)).toEqual([2, 1, 4, 4]);
    expect(bboxFromAlpha(data, w, h)).toEqual([2, 0, 6, 5]);
  });

  it("crops a layer to its rotation-aware box inside the canvas", () => {
    expect(rotatedBounds(0, 0, 100, 50, 0)).toEqual([0, 0, 100, 50]);
    close(rotatedBounds(0, 0, 100, 50, 90), [25, -25, 50, 100]);
    const d = 100 * Math.SQRT1_2;
    close(rotatedBounds(0, 0, 100, 100, 45), [50 - d, 50 - d, 2 * d, 2 * d]);
    // Whole pixels, outward.
    expect(cropRect({ x: 10.4, y: 20.6, w: 30.2, h: 10, rotation: 0 }, { width: 400, height: 300 })).toEqual([10, 20, 31, 11]);
    // Clipped to the document; null once it's fully off canvas.
    expect(cropRect({ x: -20, y: 280, w: 100, h: 50, rotation: 0 }, { width: 400, height: 300 })).toEqual([0, 280, 80, 20]);
    expect(cropRect({ x: 500, y: 0, w: 10, h: 10, rotation: 0 }, { width: 400, height: 300 })).toBeNull();
    // 90° turn: the box swaps sides around the centre.
    expect(cropRect({ x: 100, y: 100, w: 100, h: 50, rotation: 90 }, { width: 400, height: 300 })).toEqual([125, 75, 50, 100]);
  });

  it("maps document points into a rotated layer", () => {
    const n = { x: 100, y: 100, w: 100, h: 50, rotation: 0 };
    close(toLocal(n, 150, 125)!, [0.5, 0.5]);
    close(toLocal(n, 100, 100)!, [0, 0]);
    expect(toLocal(n, 99, 100)).toBeNull();
    const turned = { ...n, rotation: 90 };
    // After a quarter turn clockwise, the layer's top-left corner sits at the right top of the rotated shape.
    close(toLocal(turned, 175, 75)!, [0, 0]);
    expect(toLocal(turned, 110, 125)).toBeNull();
  });

  it("resizes from a handle, keeping the opposite side fixed", () => {
    const n = { x: 0, y: 0, w: 100, h: 50, rotation: 0 };
    expect(resizeBox(n, "e", 20, 999)).toEqual({ x: 0, y: 0, w: 120, h: 50 });
    expect(resizeBox(n, "w", 20, 0)).toEqual({ x: 20, y: 0, w: 80, h: 50 });
    // Corners keep the shape unless free.
    expect(resizeBox(n, "se", 100, 0)).toEqual({ x: 0, y: 0, w: 200, h: 100 });
    expect(resizeBox(n, "se", 100, 0, true)).toEqual({ x: 0, y: 0, w: 200, h: 50 });
    expect(resizeBox(n, "nw", -100, 0)).toEqual({ x: -100, y: -50, w: 200, h: 100 });
    // Never below 4 px.
    expect(resizeBox(n, "e", -500, 0).w).toBe(4);
    // Rotated 90°: dragging the east handle (now pointing down) by +20 in y grows the width, west edge fixed.
    const r = resizeBox({ ...n, rotation: 90 }, "e", 0, 20);
    close([r.w, r.h], [120, 50]);
    // The fixed (west) edge's midpoint stays where it was: centre (50,25) + rotate(-50,0) = (50,-25).
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    close([cx + 0, cy - r.w / 2], [50, -25]);
  });

  it("turns towards the pointer, snapping to 15°", () => {
    expect(rotationTo(0, 0, 0, -10)).toBe(0);
    expect(rotationTo(0, 0, 10, 0)).toBeCloseTo(90);
    expect(rotationTo(0, 0, 0, 10)).toBeCloseTo(180);
    expect(rotationTo(0, 0, -10, 0)).toBeCloseTo(-90);
    expect(rotationTo(0, 0, 10, -9, true)).toBe(45);
  });

  it("draws region rectangles inside the canvas", () => {
    expect(rectFrom(50, 60, 10, 20, { width: 400, height: 300 })).toEqual([10, 20, 40, 40]);
    expect(rectFrom(-50, -50, 30, 30, { width: 400, height: 300 })).toEqual([0, 0, 30, 30]);
    expect(rectFrom(0, 0, 4, 100, { width: 400, height: 300 })).toBeNull();
  });

  it("renders a layer at its own resolution", () => {
    // A layer cropped out of a 2048-wide image but shown 512 wide: 4× the document pixels.
    expect(nativeSize({ w: 512, h: 256, crop: [0, 0, 2048, 1024], natural: [4096, 4096] })).toEqual([2048, 1024]);
    expect(nativeSize({ w: 512, h: 256, crop: null, natural: [1024, 512] })).toEqual([1024, 512]);
    expect(nativeSize({ w: 512, h: 256, crop: [0, 0, 4096, 2048] }, 1000)).toEqual([1000, 500]);
  });
});

describe("placing model outputs", () => {
  const frame: Box = [0, 0, 1920, 1080];

  it("crops full-canvas layers with pixel boxes (demo, ComfyUI)", () => {
    // A 1024×576 full-canvas layer whose content sits at [256, 144, 512, 288].
    const p = placeOutput(frame, [1024, 576], { bbox: [256, 144, 512, 288] });
    expect(p.needsAlpha).toBe(false);
    expect(p.crop).toEqual([256, 144, 512, 288]);
    close(p.box, [480, 270, 960, 540]);
    // ComfyUI says the size the box is measured in.
    const c = placeOutput(frame, [640, 360], { bbox: [64, 36, 320, 180], width: 640, height: 360 });
    close(c.box, [192, 108, 960, 540]);
  });

  it("places layers already cut to their box (Seedream) by the normalised box", () => {
    // Base image 2048×1152; this layer is a 512×288 cut whose box is [0.25, 0.25, 0.25, 0.25] (0–1000 scale).
    const p = placeOutput(frame, [512, 288], { bbox: [512, 288, 512, 288], bboxNormalized: [250, 250, 250, 250] }, [2048, 1152]);
    expect(p.crop).toBeNull();
    close(p.box, [480, 270, 480, 270]);
    // The same layer as a full-size transparent canvas: crop the box out of it.
    const f = placeOutput(frame, [2048, 1152], { bbox: [512, 288, 512, 288], bboxNormalized: [250, 250, 250, 250] }, [2048, 1152]);
    close(f.crop!, [512, 288, 512, 288]);
    close(f.box, [480, 270, 480, 270]);
  });

  it("covers the frame for the base layer and asks for alpha when there's no box (Qwen)", () => {
    expect(placeOutput(frame, [2048, 1152], { bboxNormalized: [0, 0, 1000, 1000] })).toEqual({ box: frame, crop: null, needsAlpha: false });
    expect(placeOutput(frame, [1024, 576], {})).toEqual({ box: frame, crop: null, needsAlpha: true });
    const t = tightenToAlpha(frame, [1024, 576], [512, 0, 512, 288])!;
    expect(t.crop).toEqual([512, 0, 512, 288]);
    close(t.box, [960, 0, 960, 540]);
    expect(tightenToAlpha(frame, [1024, 576], null)).toBeNull();
  });

  it("maps a split into the layer it came from, turning with it", () => {
    const at = 5;
    let i = 0;
    const id = () => `n${++i}`;
    const layer: Box = [100, 100, 200, 100];
    const outs = [
      { url: "/b.png", meta: { z: 1, name: "Layer 1", bbox: [100, 0, 100, 100] }, natural: [200, 100] as [number, number] },
      { url: "/a.png", meta: { z: 0, name: "Background", bbox: [0, 0, 200, 100] }, natural: [200, 100] as [number, number] },
    ].map((o) => ({ ...o, placement: placeOutput(layer, o.natural, o.meta) }));
    const nodes = nodesFromOutputs(outs, { id, label: "Split", at, baseName: "Poster" });
    expect(nodes.map((n) => [n.id, n.name, n.z, n.src])).toEqual([
      ["n1", "Poster · part 1", 0, "/a.png"],
      ["n2", "Poster · part 2", 1, "/b.png"],
    ]);
    close([nodes[1].x, nodes[1].y, nodes[1].w, nodes[1].h], [200, 100, 100, 100]);
    // The same split of a layer turned 90°: the right half ends up below the centre.
    const turned = nodesFromOutputs(outs, { id, label: "Split", at, frame: layer, rotation: 90 });
    close([turned[1].x + turned[1].w / 2, turned[1].y + turned[1].h / 2], [200, 200]);
    expect(turned[1].rotation).toBe(90);
    expect(turned.map((n) => n.name)).toEqual(["Background", "Layer 1"]);
  });
});

describe("document operations", () => {
  const base = () => doc([node("a", 0), node("b", 1), node("c", 2)]);

  it("starts from the source image as one layer", () => {
    const d = initialDoc("/api/files/x.png", 640, 480, 7);
    expect(d).toMatchObject({ width: 640, height: 480, decomposed: false, source: "/api/files/x.png" });
    expect(d.nodes).toHaveLength(1);
    expect(d.nodes[0]).toMatchObject({ name: "Original image", x: 0, y: 0, w: 640, h: 480, src: "/api/files/x.png", revision: 0 });
  });

  it("reorders, duplicates, deletes and inserts keeping z = position", () => {
    const zs = (d: LayerDoc) => [...d.nodes].sort((x, y) => x.z - y.z).map((n) => `${n.id}${n.z}`).join(" ");
    expect(zs(moveNode(base(), "a", 2))).toBe("b0 c1 a2");
    expect(zs(moveNode(base(), "c", 0))).toBe("c0 a1 b2");
    expect(moveNode(base(), "zz", 0).nodes).toEqual(base().nodes);
    const dup = duplicateNode(base(), "a", "a2");
    expect(zs(dup)).toBe("a0 a21 b2 c3");
    expect(dup.nodes.find((n) => n.id === "a2")?.name).toBe("a copy");
    expect(zs(deleteNode(base(), "b"))).toBe("a0 c1");
    expect(zs(addNodes(base(), [node("x", 9)]))).toBe("a0 b1 c2 x3");
    expect(zs(addNodes(base(), [node("x", 9)], 0))).toBe("x0 a1 b2 c3");
    // A split replaces the layer in its place; a merge replaces a pair at the upper one's place.
    expect(zs(replaceNodes(base(), ["b"], [node("b1", 0), node("b2", 0)]))).toBe("a0 b11 b22 c3");
    expect(zs(replaceNodes(base(), ["a", "b"], [node("m", 0)]))).toBe("m0 c1");
  });

  it("keeps revisions to switch between", () => {
    const n = node("a", 0, { x: 10, y: 10, w: 100, h: 50 });
    const up = addRevision(n, { src: "/up.png", natural: [400, 200], label: "Upscale", at: 2 });
    expect(up).toMatchObject({ src: "/up.png", revision: 1, x: 10, y: 10, w: 100, h: 50 });
    expect(up.revisions.map((r) => r.label)).toEqual(["Original", "Upscale"]);
    // A square result keeps the width and centre.
    const sq = addRevision(up, { src: "/sq.png", natural: [300, 300], label: "Angles", at: 3 });
    expect(sq).toMatchObject({ w: 100, h: 100, x: 10, y: -15, revision: 2 });
    const back = setRevision(sq, 0);
    expect(back).toMatchObject({ src: "/api/files/a.png", w: 100, h: 50, y: 10, revision: 0 });
    expect(setRevision(back, 0)).toBe(back);
    // A node without revisions keeps its current pixels as the first one.
    const bare = addRevision({ ...n, revisions: [], revision: 0 }, { src: "/new.png", natural: [100, 50], label: "Relight", at: 9 });
    expect(bare.revisions.map((r) => [r.label, r.src])).toEqual([
      ["Before", "/api/files/a.png"],
      ["Relight", "/new.png"],
    ]);
  });

  it("expands and crops the canvas", () => {
    const d = doc([node("a", 0, { x: 10, y: 20 })]);
    const cropped = reframeDoc(d, [10, 10, 200, 100]);
    expect(cropped).toMatchObject({ width: 200, height: 100 });
    expect(cropped.nodes[0]).toMatchObject({ x: 0, y: 10 });
    const grown = reframeDoc(d, [-40, -8, 480, 316]);
    expect(grown.nodes[0]).toMatchObject({ x: 50, y: 28 });
    expect(() => reframeDoc(d, [500, 0, 100, 100])).toThrow(/no longer overlaps/);
    expect(reframeDoc(d, [0, 0, 400, 300])).toBe(d);
    expect(expandPads(d, [-40, -8, 480, 316])).toEqual({ left: 40, top: 8, right: 40, bottom: 8 });
    expect(expandPads(d, [-3, 0, 410, 300])).toEqual({ left: 8, top: 0, right: 8, bottom: 0 });
  });
});

describe("edit history", () => {
  it("undoes and redoes commits, and a new edit drops the redo stack", () => {
    const d0 = initialDoc("/s.png", 10, 10, 1);
    const d1 = { ...d0, width: 11 };
    const d2 = { ...d0, width: 12 };
    const d3 = { ...d0, width: 13 };
    let h: History = { past: [], present: d0, future: [] };
    h = historyReducer(h, { type: "commit", doc: d1 });
    h = historyReducer(h, { type: "commit", doc: d2 });
    expect(historyReducer(h, { type: "commit", doc: d2 })).toBe(h);
    h = historyReducer(h, { type: "undo" });
    expect(h.present).toBe(d1);
    h = historyReducer(h, { type: "undo" });
    expect(h.present).toBe(d0);
    expect(historyReducer(h, { type: "undo" })).toBe(h);
    h = historyReducer(h, { type: "redo" });
    expect(h.present).toBe(d1);
    expect(h.future).toEqual([d2]);
    h = historyReducer(h, { type: "commit", doc: d3 });
    expect(h).toEqual({ past: [d0, d1], present: d3, future: [] });
    expect(historyReducer(h, { type: "redo" })).toBe(h);
    expect(historyReducer(h, { type: "reset", doc: d0 })).toEqual({ past: [], present: d0, future: [] });
  });

  it("folds a burst of commits with the same merge key into one undo step", () => {
    const d0 = initialDoc("/s.png", 10, 10, 1);
    const at = (w: number) => ({ ...d0, width: w });
    let h: History = { past: [], present: d0, future: [] };
    // A slider drag: 11 → 12 → 13 within the window is one step back to d0.
    h = historyReducer(h, { type: "commit", doc: at(11), merge: "opacity:a", at: 1000 });
    h = historyReducer(h, { type: "commit", doc: at(12), merge: "opacity:a", at: 1100 });
    h = historyReducer(h, { type: "commit", doc: at(13), merge: "opacity:a", at: 2000 });
    expect(h.past).toEqual([d0]);
    expect(h.present.width).toBe(13);
    // A pause longer than the window starts a new step.
    h = historyReducer(h, { type: "commit", doc: at(14), merge: "opacity:a", at: 2000 + MERGE_WINDOW_MS });
    expect(h.past.map((d) => d.width)).toEqual([10, 13]);
    // Another key, or a plain commit, never folds into the previous step.
    h = historyReducer(h, { type: "commit", doc: at(15), merge: "x:a", at: 3300 });
    h = historyReducer(h, { type: "commit", doc: at(16), at: 3301 });
    h = historyReducer(h, { type: "commit", doc: at(17), merge: "x:a", at: 3302 });
    expect(h.past.map((d) => d.width)).toEqual([10, 13, 14, 15, 16]);
    // Undo ends the burst: the next commit with the same key is its own step.
    h = historyReducer(h, { type: "undo" });
    h = historyReducer(h, { type: "commit", doc: at(18), merge: "x:a", at: 3303 });
    expect(h.past.map((d) => d.width)).toEqual([10, 13, 14, 15, 16]);
    expect(h.present.width).toBe(18);
    h = historyReducer(h, { type: "commit", doc: at(19), merge: "x:a", at: 3304 });
    expect(h.past.map((d) => d.width)).toEqual([10, 13, 14, 15, 16]);
    expect(h.present.width).toBe(19);
  });

  it("keeps at most 100 steps", () => {
    let h: History = { past: [], present: initialDoc("/s.png", 1, 1, 0), future: [] };
    for (let i = 0; i < 130; i++) h = historyReducer(h, { type: "commit", doc: { ...h.present, width: i + 2 } });
    expect(h.past).toHaveLength(100);
    expect(h.present.width).toBe(131);
  });
});

describe("edit text", () => {
  it("writes the edit prompt and job title from the changed rows", () => {
    const rows = [
      { from: "SUMMER SALE", to: "WINTER SALE" },
      { from: "Today only", to: "Today only" },
      { from: "50% off", to: "" },
    ];
    expect(textEditPrompt(rows)).toBe("Preserve the original design and change only the requested text. Change “SUMMER SALE” to “WINTER SALE”. Remove “50% off”.");
    expect(textJobTitle(rows)).toBe("2 text changes");
    expect(textJobTitle([rows[0]])).toBe("“SUMMER SALE” → “WINTER SALE”");
    expect(textJobTitle([{ from: "An extremely long headline here", to: "x" }])).toBe("“An extremely long headl…” → “x”");
    expect(textJobTitle([rows[2]])).toBe("Remove “50% off”");
  });

  it("reads text blocks with pixel or normalised boxes", () => {
    const blocks = textBlocksFrom(
      {
        textBlocks: [
          { text: "  BIG   SALE ", bbox: [100, 50, 200, 100] },
          { text: "small", bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } },
          { text: "" },
          { text: "no box" },
        ],
      },
      [1000, 500],
    );
    expect(blocks).toEqual([
      { text: "BIG SALE", box: [0.1, 0.1, 0.2, 0.2] },
      { text: "small", box: [0.1, 0.2, 0.3, 0.1] },
      { text: "no box", box: null },
    ]);
    expect(textBlocksFrom(undefined)).toEqual([]);
  });

  it("reads OCR lines too: 0–1 boxes as they are, Florence-2's pixel boxes against the size", () => {
    // OvisOCR3 / Florence-2 with a size: fractions already.
    const lines = { lines: [{ text: "SUMMER SALE", bbox: [0.062, 0.096, 0.532, 0.109] }, { text: "no box" }], size: [1280, 960] };
    expect(textBlocksFrom(lines)).toEqual([
      { text: "SUMMER SALE", box: [0.062, 0.096, 0.532, 0.109] },
      { text: "no box", box: null },
    ]);
    expect(needsDetectedSize(lines)).toBe(false);
    // Florence-2 without the image's size: pixels in bboxPx, read against the picture the editor sent.
    const px = { lines: [{ text: "Hi", bboxPx: [100, 50, 200, 100] }] };
    expect(needsDetectedSize(px)).toBe(true);
    expect(textBlocksFrom(px, [1000, 500])).toEqual([{ text: "Hi", box: [0.1, 0.1, 0.2, 0.2] }]);
    expect(textBlocksFrom(px)).toEqual([{ text: "Hi", box: null }]);
    expect(textBlocksFrom({ ...px, size: [2000, 1000] })).toEqual([{ text: "Hi", box: [0.05, 0.05, 0.1, 0.1] }]);
    // Ideogram's object boxes in fractions need no size.
    expect(needsDetectedSize({ textBlocks: [{ text: "x", bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } }] })).toBe(false);
  });

  it("puts a transparent layer on a backdrop its text stands out from before detection", () => {
    const px = (...p: number[][]) => p.flat();
    // Opaque: nothing to fill.
    expect(readableBackdrop(px([10, 10, 10, 255], [250, 250, 250, 255]))).toBeNull();
    // Dark text on transparency → white; light text → black.
    expect(readableBackdrop(px([20, 20, 30, 255], [0, 0, 0, 0], [0, 0, 0, 0]))).toBe("#ffffff");
    expect(readableBackdrop(px([255, 255, 240, 255], [250, 250, 250, 200], [0, 0, 0, 0]))).toBe("#000000");
    // Nothing visible at all: white.
    expect(readableBackdrop(px([0, 0, 0, 0]))).toBe("#ffffff");
  });

  it("keeps transparency by default only for see-through layers, not full-frame pictures", () => {
    const pixels = (n: number, clear: number) => Array.from({ length: n }, (_, i) => [200, 120, 90, i < clear ? 0 : 255]).flat();
    // A whole-image Inpaint or Enhancer result: opaque everywhere.
    expect(seeThrough(pixels(1000, 0))).toBe(false);
    // A soft edge pixel or two doesn't make a cut-out.
    expect(seeThrough(pixels(1000, 2))).toBe(false);
    // A decomposition's layer or a removed background.
    expect(seeThrough(pixels(1000, 400))).toBe(true);
    expect(seeThrough(pixels(1000, 5))).toBe(true);
    // Half-clear pixels count as clear below 128.
    expect(seeThrough([0, 0, 0, 127, 0, 0, 0, 255])).toBe(true);
    expect(seeThrough([])).toBe(false);
  });

  it("lays detected lines out in the frame the detector read, like the cloud route's blocks", () => {
    const rows = placeTextBlocks(
      [
        { text: "SUMMER SALE", box: [0.1, 0.2, 0.5, 0.1] },
        { text: "fine print", box: null },
      ],
      [100, 50, 800, 400],
    );
    expect(rows).toEqual([
      { from: "SUMMER SALE", to: "SUMMER SALE", box: [180, 130, 400, 40] },
      { from: "fine print", to: "fine print", box: null },
    ]);
    // Nothing changed yet: Generate has nothing to send.
    expect(textEditPrompt(rows)).toBe("Preserve the original design and change only the requested text.");
  });
});

describe("inpaint and Save as element", () => {
  it("asks for the painted area only", () => {
    expect(inpaintPrompt("  a red scarf.  ")).toBe("a red scarf. Blend it into the surroundings with matching light, perspective and grain.");
  });

  it("names a layer's element and guesses its kind", () => {
    expect(elementDraft({ name: "Woman in red coat", z: 2 })).toEqual({ name: "Woman in red coat", kind: "character" });
    expect(elementDraft({ name: "Guitar · part 2", z: 3 })).toEqual({ name: "Guitar", kind: "prop" });
    expect(elementDraft({ name: "Sky gradient copy", z: 1 })).toEqual({ name: "Sky gradient", kind: "style" });
    // Generic names: the bottom layer reads as a backdrop, anything else as a prop; prompts say more.
    expect(elementDraft({ name: "Background", z: 0 })).toEqual({ name: "Element", kind: "style" });
    expect(elementDraft({ name: "Layer 4", z: 4 })).toEqual({ name: "Element", kind: "prop" });
    expect(elementDraft({ name: "Generated layer", z: 5, prompt: "a golden retriever puppy" })).toEqual({ name: "Element", kind: "prop", description: "a golden retriever puppy" });
    expect(elementDraft({ name: "Generated layer", z: 5, prompt: "a smiling dog" })).toMatchObject({ kind: "character" });
    expect(elementDraft({ name: "x".repeat(90), z: 1 }).name).toHaveLength(60);
  });
});

describe("Open in Layers", () => {
  it("opens an image result as a new project, and a layers result with its layers", () => {
    const base = { feature: "image", modelId: "m" };
    expect(layersHref({ id: "g1", op: "t2i", status: "succeeded", request: base }, "/api/files/o/a.png")).toBe("/layers?image=%2Fapi%2Ffiles%2Fo%2Fa.png");
    expect(layersHref({ id: "g2", op: "layers", status: "succeeded", request: { ...base, inputs: { images: ["/api/files/u/src.png"] } } }, "/api/files/o/l1.png")).toBe(
      "/layers?image=%2Fapi%2Ffiles%2Fu%2Fsrc.png&generation=g2",
    );
    // A layers result made from an image that isn't stored here opens just that layer.
    expect(layersHref({ id: "g3", op: "layers", status: "succeeded", request: { ...base, inputs: { images: ["https://x.example/a.png"] } } }, "/api/files/o/l1.png")).toBe("/layers?image=%2Fapi%2Ffiles%2Fo%2Fl1.png");
  });
});

describe("tools and prices", () => {
  const OPS: Record<string, Operation[]> = {
    decompose: ["layers"],
    split: ["layers"],
    regenerate: ["edit"],
    "generate-layer": ["t2i", "edit"],
    "text-detect": ["text-layers", "ocr"],
    "text-edit": ["edit"],
    "bg-remove": ["bg-remove"],
    regional: ["edit"],
    upscale: ["upscale-image"],
    relight: ["edit"],
    angles: ["edit"],
    expand: ["edit", "outpaint"],
    inpaint: ["inpaint", "edit"],
    enhance: ["edit"],
    rerender: ["t2i"],
  };

  it("offers catalog models of the right engine and operation for every tool", () => {
    for (const [tool, byEngine] of Object.entries(TOOL_MODELS)) {
      for (const engine of ["cloud", "open"] as const) {
        for (const id of byEngine[engine]) {
          const m = getModel(id);
          expect(m, `${tool}: ${id}`).toBeDefined();
          expect(m!.engine, `${tool}: ${id}`).toBe(engine);
          expect(OPS[tool].some((op) => supportsOp(m!, op)), `${tool}: ${id} supports ${OPS[tool]}`).toBe(true);
        }
      }
    }
  });

  it("puts the newest open image models first: Qwen-Image 2.1, its Turbo, Krea 2, FIBO 2, MOSS-Image and SeedVR2", () => {
    expect(TOOL_MODELS.regenerate.open).toEqual(["oss-qwen-image-21", "oss-qwen-image-21-turbo", "oss-fibo2-edit-turbo"]);
    expect(TOOL_MODELS.regenerate.cloud).toEqual(["nano-banana-pro", "seedream-5-pro", "nano-banana-2-1"]);
    expect(TOOL_MODELS["generate-layer"].open).toEqual(["oss-qwen-image-21", "oss-ideogram-4", "oss-krea2-turbo", "oss-moss-image"]);
    expect(TOOL_MODELS["text-edit"].open).toEqual(["oss-qwen-image-21", "oss-qwen-image-21-turbo", "oss-krea2-edit"]);
    expect(TOOL_MODELS.enhance.open).toEqual(["oss-qwen-image-21", "oss-qwen-image-21-turbo", "oss-krea2-edit"]);
    expect(TOOL_MODELS.regional.open).toEqual(["oss-qwen-image-21", "oss-krea2-edit", "oss-fibo2-edit-turbo"]);
    expect(TOOL_MODELS.upscale.open).toEqual(["oss-seedvr2-image", "oss-upscale-image"]);
    expect(TOOL_MODELS.relight).toEqual({ cloud: ["nano-banana-pro", "nano-banana-2-1"], open: ["oss-qwen-image-21-turbo", "oss-krea2-edit", "oss-qwen-relight"] });
    expect(TOOL_MODELS.angles.open).toEqual(["oss-qwen-image-21"]);
    // FLUX.1 Fill stays the second Inpaint and Expand model on your GPU: it keeps the picture's size and its pixels outside
    // the mask, and its graph runs on core ComfyUI.
    expect(TOOL_MODELS.expand.open).toEqual(["oss-qwen-image-21", "oss-flux-fill"]);
    expect(TOOL_MODELS.inpaint).toEqual({ cloud: ["nano-banana-pro", "bria-fibo-2", "z-image-inpaint"], open: ["oss-qwen-image-21", "oss-flux-fill"] });
    // Qwen-Image-Edit 2511, FLUX.1 Kontext, FLUX.1 Fill pro, Z-Image Turbo, Qwen-Image 2512 and Nano Banana 2 are in no tool
    // list; nor is Krea 2 Inpaint, which redraws the whole picture at about 1 MP.
    const all = Object.values(TOOL_MODELS).flatMap((t) => [...t.cloud, ...t.open]);
    for (const id of ["oss-qwen-edit", "oss-flux-kontext", "flux-fill-pro", "oss-z-image-turbo", "oss-qwen-image", "nano-banana-2", "oss-krea2-inpaint"]) expect(all, id).not.toContain(id);
    // The angle and the front of a turn need the 25-step model (its Turbo misses big camera turns).
    expect(getModel("oss-qwen-image-21")!.routes.find((r) => r.op === "edit")!.endpoint).toBe("qwen-image-21-edit");
  });

  it("only offers models whose route takes what the tool sends", () => {
    // Regional edit, edit text, the Enhancer and Relight send one picture to an edit route: on your GPU its graph binds it.
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "workflows/comfyui/manifest.json"), "utf8")) as { workflows: { id: string; bindings: Record<string, unknown> }[] };
    const graph = (id: string, op: Operation) => {
      const route = getModel(id)!.routes.find((r) => r.op === op);
      return route?.provider === "comfyui" ? manifest.workflows.find((w) => w.id === route.endpoint) : undefined;
    };
    for (const tool of ["regional", "text-edit", "enhance", "relight", "regenerate"] as const) {
      for (const id of TOOL_MODELS[tool].open) {
        expect(supportsOp(getModel(id)!, "edit"), `${tool}: ${id}`).toBe(true);
        expect(graph(id, "edit")?.bindings.image, `${tool}: ${id}`).toBeDefined();
      }
    }
    // Layer edit sends the layer and up to 3 references (the API's limit): every model takes all 4, on both engines.
    for (const engine of ["cloud", "open"] as const) {
      for (const id of TOOL_MODELS.regenerate[engine]) expect(imageLimit(getModel(id)!, "edit"), `regenerate: ${id}`).toBeGreaterThanOrEqual(4);
    }
    // Open Inpaint and Expand keep a choice that runs on core ComfyUI alone (FLUX.1 Fill pastes the picture back around the
    // mask), and none needs the Krea 2 Ostris Edit add-on.
    const nodes = (id: string, op: Operation) =>
      (manifest.workflows.find((w) => w.id === getModel(id)!.routes.find((r) => r.op === op)?.endpoint) as { customNodes?: { name: string }[] } | undefined)?.customNodes?.map((n) => n.name) ?? [];
    for (const [tool, op] of [["inpaint", "inpaint"], ["expand", "outpaint"]] as const) {
      expect(TOOL_MODELS[tool].open.some((id) => !nodes(id, op).length), tool).toBe(true);
      for (const id of TOOL_MODELS[tool].open) expect(nodes(id, op), `${tool}: ${id}`).not.toContain("ComfyUI-Krea2-Ostris-Edit");
    }
    // Inpaint's mask and Expand's four margins reach the open graphs.
    for (const id of TOOL_MODELS.inpaint.open) expect(graph(id, "inpaint")?.bindings.mask, id).toBeDefined();
    for (const id of TOOL_MODELS.expand.open) expect(Object.keys(graph(id, "outpaint")?.bindings ?? {}), id).toEqual(expect.arrayContaining(["image", "padLeft", "padTop", "padRight", "padBottom"]));
    // Inpaint sends a mask: every model past Nano Banana Pro (the red-tinted copy) has an inpaint route with one.
    for (const engine of ["cloud", "open"] as const) {
      for (const id of TOOL_MODELS.inpaint[engine].filter((x) => x !== "nano-banana-pro")) {
        const m = getModel(id)!;
        const route = m.routes.find((r) => r.op === "inpaint");
        expect(route, id).toBeDefined();
        if (engine === "cloud") expect(route!.map?.mask, id).toBeTruthy();
      }
    }
    // Expand on your GPU sends the pads to an outpaint route.
    for (const id of TOOL_MODELS.expand.open) expect(supportsOp(getModel(id)!, "outpaint"), id).toBe(true);
  });

  it("words a relight for each kind of model", () => {
    // The Relight LoRA graph: the light alone (it adds the LoRA's trigger itself).
    expect(relightPrompt("oss-qwen-relight", "warm golden hour sunlight", "coming from the left")).toBe("warm golden hour sunlight, coming from the left");
    // Qwen-Image 2.1 and its Turbo: their own picture tags, as the relit covers were made.
    const qwen = relightPrompt("oss-qwen-image-21-turbo", "warm golden hour sunlight", "coming from the left");
    expect(qwen).toMatch(/^Relight <image1> with warm golden hour sunlight coming from the left\. Keep .* exactly as in <image1>/);
    // Krea 2 Edit and the cloud: a plain instruction.
    expect(relightPrompt("oss-krea2-edit", "soft overcast daylight")).toMatch(/^Relight the image with soft overcast daylight\. Keep the subject/);
    expect(relightPrompt("nano-banana-pro", "soft overcast daylight")).toBe(relightPrompt("oss-krea2-edit", "soft overcast daylight"));
  });

  it("runs the Enhancer's Detail look on catalog upscalers", () => {
    for (const engine of ["cloud", "open"] as const) {
      for (const id of ENHANCE_DETAIL_MODELS[engine]) {
        const m = getModel(id);
        expect(m?.engine, id).toBe(engine);
        expect(supportsOp(m!, "upscale-image"), id).toBe(true);
      }
      expect(enhanceModels("detail", engine)).toBe(ENHANCE_DETAIL_MODELS[engine]);
      expect(enhanceModels("skin", engine)).toBe(TOOL_MODELS.enhance[engine]);
    }
    expect(enhancePrompt("detail")).toBeNull();
    expect(enhancePrompt("glow", "  ")).toBe(
      "Give the portrait a soft beauty retouch with a healthy dewy glow, still keeping real pore texture. Make the skin look like a high-end editorial photograph shot on a sharp lens, with real, natural skin texture and the same makeup. Keep the face shape, identity, expression, hair, lighting and background exactly the same.",
    );
    // Every look but Detail has an instruction.
    expect(ENHANCE_LOOKS.filter((l) => !l.prompt).map((l) => l.id)).toEqual(["detail"]);
    // The open upscalers' 2× scales belong to Detail's own models.
    expect(Object.keys(ENHANCE_DETAIL_SCALE).every((id) => ENHANCE_DETAIL_MODELS.open.includes(id))).toBe(true);
  });

  it("prices a decomposition per layer", () => {
    expect(decomposeCost("seedream-5-layers", 8)).toBeCloseTo(0.27);
    expect(decomposeCost("seedream-5-layers", 8, "2K")).toBeCloseTo(0.54);
    expect(decomposeCost("seedream-5-flash-layers", 8, "2K")).toBeCloseTo(0.216);
    expect(decomposeCost("qwen-image-layered-cloud", 16)).toBeCloseTo(0.4);
    expect(decomposeCost("oss-qwen-layered", 8)).toBe(0);
    expect(decomposeCost("unknown", 8)).toBeNull();
    expect(clampLayers("oss-qwen-layered", 16)).toBe(10);
    expect(clampLayers("seedream-5-layers", 1)).toBe(3);
    expect(clampLayers("oss-qwen-layered-control", 2)).toBe(2);
  });

  it("sends a named element to Layered-Control on the open engine, as the form says", () => {
    // What the Separate layer form posts: the model it shows (the default, or the one picked).
    expect(layersModelFor("split", "open", "oss-qwen-layered", "the guitar")).toBe("oss-qwen-layered-control");
    expect(layersModelFor("split", "open", undefined, "the guitar")).toBe("oss-qwen-layered-control");
    expect(layersModelFor("split", "open", "oss-qwen-layered-control", "the face")).toBe("oss-qwen-layered-control");
    // Control needs a name; without one the plain model splits.
    expect(layersModelFor("split", "open", "oss-qwen-layered-control", "  ")).toBe("oss-qwen-layered");
    expect(layersModelFor("split", "open", undefined, undefined)).toBeUndefined();
    // Cloud models and the decomposition take the prompt as an instruction.
    expect(layersModelFor("split", "cloud", "seedream-5-layers", "the guitar")).toBe("seedream-5-layers");
    expect(layersModelFor("decompose", "open", "oss-qwen-layered", "the guitar")).toBe("oss-qwen-layered");
    expect([defaultLayers("decompose", "seedream-5-layers"), defaultLayers("split", "oss-qwen-layered"), defaultLayers("split", "oss-qwen-layered-control")]).toEqual([8, 3, 2]);
    expect([minLayers("oss-qwen-layered-control"), minLayers("oss-qwen-layered")]).toEqual([2, 3]);
  });
});

describe("exports keep every layer's detail", () => {
  it("renders at the densest visible layer's scale, kept to 8192 px", () => {
    const d = doc([node("bg", 0, { w: 960, h: 720, natural: [960, 720] })], 960, 720);
    expect(exportScale(d)).toBe(1);
    // A 4× upscale of the whole picture, laid over it.
    const up = addNodes(d, [node("up", 0, { w: 960, h: 720, natural: [3840, 2880] })]);
    expect(exportScale(up)).toBe(4);
    expect(scaledSize(960, 720, exportScale(up))).toEqual([3840, 2880]);
    // Hidden layers don't count; a crop counts its own pixels.
    expect(exportScale(updateNode(up, "up", { hidden: true }))).toBe(1);
    // Nor do small layers: a model's 2K answer for a corner of the picture keeps the picture's size.
    expect(exportScale(addNodes(d, [node("corner", 0, { x: 0, y: 0, w: 400, h: 300, natural: [2048, 1536] })]))).toBe(1);
    expect(coverage(node("half", 0, { x: 0, y: 0, w: 960, h: 360 }), d)).toBeCloseTo(0.5);
    expect(coverage(node("off", 0, { x: 2000, y: 0 }), d)).toBe(0);
    expect(layerDensity(node("c", 0, { w: 100, crop: [0, 0, 300, 150], natural: [1000, 1000] }))).toBe(3);
    // Enlarged past its pixels: the document's own size, never smaller.
    expect(exportScale(doc([node("big", 0, { w: 400, natural: [100, 50] })]))).toBe(1);
    // Capped on the long side.
    const huge = addNodes(doc([], 4000, 3000), [node("x", 0, { w: 4000, h: 3000, natural: [16000, 12000] })]);
    expect(scaledSize(4000, 3000, exportScale(huge))[0]).toBe(8192);
    // A cropped download: the layer's own density, capped on its box.
    expect(layerExportScale(node("u", 0, { w: 100, natural: [400, 200] }), [0, 0, 100, 50])).toBe(4);
    expect(layerExportScale(node("u", 0, { w: 100, natural: [100000, 50000] }), [0, 0, 100, 50])).toBeCloseTo(81.92);
  });
});

describe("limits the server enforces", () => {
  it("keeps a layer's first revision and the newest ones", () => {
    let n = node("a", 0);
    for (let i = 1; i <= 70; i++) n = addRevision(n, { src: `/api/files/r${i}.png`, natural: [100, 50], label: `Edit ${i}`, at: i + 1 });
    expect(n.revisions).toHaveLength(MAX_REVISIONS);
    expect(n.revisions[0].label).toBe("Original");
    expect(n.revisions.at(-1)?.label).toBe("Edit 70");
    expect(n.revisions[1].label).toBe("Edit 22");
    expect(n.revision).toBe(MAX_REVISIONS - 1);
    expect(n.src).toBe("/api/files/r70.png");
  });

  it("refuses to grow a project past 200 layers", () => {
    const full = doc(Array.from({ length: MAX_NODES }, (_, i) => node(`n${i}`, i)));
    expect(roomFor(full)).toBe(false);
    expect(roomFor(deleteNode(full, "n0"))).toBe(true);
    expect(() => addNodes(full, [node("x", 0)])).toThrow(LayerLimitError);
    expect(() => duplicateNode(full, "n1", "dup")).toThrow(/up to 200 layers/);
    // Moving, deleting and merging still work at the limit.
    expect(moveNode(full, "n0", 5).nodes).toHaveLength(MAX_NODES);
    expect(replaceNodes(full, ["n0", "n1"], [node("m", 0)]).nodes).toHaveLength(MAX_NODES - 1);
  });
});

describe("where the original sits", () => {
  it("moves with Expand & Crop, so Compare's before lines up with the after", () => {
    const d = initialDoc("/api/files/x.png", 960, 720, 1);
    expect(sourceBoxOf(d)).toEqual([0, 0, 960, 720]);
    const wide = reframeDoc(d, [-160, 0, 1280, 720]);
    expect(sourceBoxOf(wide)).toEqual([160, 0, 960, 720]);
    const crop = reframeDoc(wide, [200, 100, 400, 300]);
    expect(sourceBoxOf(crop)).toEqual([-40, -100, 960, 720]);
    // Documents saved before this was kept: the whole canvas.
    expect(sourceBoxOf({ width: 10, height: 20 })).toEqual([0, 0, 10, 20]);
  });
});
