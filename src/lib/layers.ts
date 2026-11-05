/**
 * Layers studio (Higgsfield Layers): the layer document, its geometry, the downloads and the edit
 * history. Pure, so the editor, the server and the tests share it; no catalog import (the editor gets
 * model names and prices from its page).
 *
 * A project is one source image plus versions of a {@link LayerDoc}. Each layer is an image file
 * placed on the document: `x, y, w, h` in document pixels (the source image's own pixels), rotated
 * clockwise around its centre, showing the `crop` part of its image (all of it when unset).
 * Full-canvas RGBA layers (Qwen-Image-Layered) are cropped to their alpha box, so selection handles
 * hug what you see.
 */
import type { Pricing } from "./catalog/types";
import type { LayoutDraft, LayoutItem } from "./layout-prompt";

export type Box = [x: number, y: number, w: number, h: number];

/** One version of a layer's pixels: switch between them in the Layers panel. */
export interface LayerRevision {
  /** Asset URL (/api/files/…), as everywhere in Fuobe (the server's readRef takes it). */
  src: string;
  /** The part of the image the layer shows (image px); null = the whole image. */
  crop?: Box | null;
  /** The image's pixel size. */
  natural?: [number, number];
  label: string;
  prompt?: string;
  at: number;
}

export interface LayerNode {
  id: string;
  name: string;
  /** Stacking order, 0 = bottom; always the node's index after {@link normalize}. */
  z: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees, clockwise around the centre. */
  rotation: number;
  /** The image (asset URL) this layer shows: the active revision's. */
  src: string;
  crop?: Box | null;
  natural?: [number, number];
  hidden?: boolean;
  /** 0–1 (1 when unset). */
  opacity?: number;
  /** Visibility mask (asset URL, PNG): its alpha is stretched over the layer box; transparent = hidden. */
  maskSrc?: string;
  /** Soft edge in document pixels (a regional edit's “Mask feather”). */
  feather?: number;
  /** The last “Layer edit prompt” and reference image. */
  prompt?: string;
  refSrc?: string;
  revisions: LayerRevision[];
  /** Index of the active revision. */
  revision: number;
  /** A regional edit's pair: the region as it was, and the edited one. */
  role?: "original" | "new";
}

export interface LayerDoc {
  v: 1;
  width: number;
  height: number;
  /** The image the project was opened on (Compare's “before”). */
  source: string;
  /** “An image can only be decomposed once”: set after the first decomposition lands. */
  decomposed: boolean;
  /** Where the source image sits in the document (doc px): Expand & Crop moves it. Unset = the whole canvas. */
  sourceBox?: Box;
  nodes: LayerNode[];
}

/** Layers a project holds at most (the server refuses more). */
export const MAX_NODES = 200;
/** Revisions a layer keeps: its first one and the newest (the server refuses more than 60). */
export const MAX_REVISIONS = 50;

/** A document change that would go past {@link MAX_NODES}. */
export class LayerLimitError extends Error {
  constructor() {
    super(`A project can hold up to ${MAX_NODES} layers. Merge or delete some layers first.`);
  }
}

// ---------------------------------------------------------------------------
// Projects, versions and jobs as the API returns them

export type LayerTool =
  | "decompose"
  | "split"
  | "regenerate"
  | "generate-layer"
  | "text-detect"
  | "text-edit"
  | "bg-remove"
  | "regional"
  | "upscale"
  | "relight"
  | "angles"
  | "expand"
  | "inpaint"
  | "enhance"
  | "rerender";

export interface LayerProject {
  id: string;
  name: string;
  sourceUrl: string;
  coverUrl: string;
  width: number;
  height: number;
  /** Layers in the newest version. */
  layers: number;
  /**
   * "processing" while a decomposition runs, "unopened" when it finished but the editor hasn't laid
   * the layers out yet (`pendingLayers` of them), "failed" when the only one failed.
   */
  status: "ready" | "processing" | "unopened" | "failed";
  /** Layers a finished decomposition holds, waiting for the editor to lay them out. */
  pendingLayers?: number;
  /** “An image can only be decomposed once”: true once a decomposition (or a split of the original picture) landed, whichever version is open. */
  decomposed: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface LayerVersion {
  id: string;
  label: string;
  createdAt: number;
  updatedAt: number;
}

/** What a finished generation hands back (a slice of Generation, so the editor needs no catalog). */
export interface LayerJobResult {
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  progress: number | null;
  message: string | null;
  error: string | null;
  provider: string;
  outputs: { url: string; kind: string; meta?: Record<string, unknown>; width?: number; height?: number }[];
}

export interface LayerJob {
  id: string;
  tool: LayerTool;
  /** “Separating Subject”, “Upscale”, ““SALE” → “OPEN””. */
  label: string;
  /** The layer it works on (none = the whole image). */
  nodeId?: string;
  /** Where its input sat in the document when it started (doc px). */
  frame: Box;
  /** Tool settings the editor needs when the result lands (the prompt, a region's feather…). */
  settings?: Record<string, unknown>;
  /** Every generation it started; the last one's outputs are the result. */
  generationIds: string[];
  state: "pending" | "applied" | "dismissed";
  createdAt: number;
  /** The result generation, joined by the server. */
  result?: LayerJobResult | null;
}

export interface LayerProjectView {
  project: LayerProject;
  versions: LayerVersion[];
  headVersionId: string;
  doc: LayerDoc;
  jobs: LayerJob[];
}

/** What the editor posts to start a tool. */
export interface LayerJobInput {
  tool: LayerTool;
  engine: "cloud" | "open";
  modelId?: string;
  /** The picture to work on (an uploaded render of the layer, region or composite). */
  image?: string;
  /** Reference images (per-layer generate). */
  refs?: string[];
  /** Inpaint: the painted area as a PNG the size of `image` (white = change), and `image` with that area tinted red. */
  mask?: string;
  sketch?: string;
  prompt?: string;
  nodeId?: string;
  frame: Box;
  label?: string;
  settings?: {
    resolution?: "1K" | "1.5K" | "2K";
    mode?: "standard" | "fast";
    layers?: number;
    keepAlpha?: boolean;
    light?: string;
    direction?: string;
    angle?: string;
    rotate?: number;
    tilt?: number;
    zoom?: number;
    rows?: { from: string; to: string }[];
    pads?: { left: number; top: number; right: number; bottom: number };
    feather?: number;
    aspect?: string;
    /** Enhancer: one of {@link ENHANCE_LOOKS}. */
    look?: EnhanceLook;
    /** Re-render from layers: the layers and text as a layout ({@link layersLayout}). */
    layout?: LayoutDraft | Record<string, unknown>;
  };
}

/** What each tool is called in job titles, toasts and the generations' step labels. */
export const TOOL_LABELS: Record<LayerTool, string> = {
  decompose: "Layer decomposition",
  split: "Separate layer",
  regenerate: "Layer edit",
  "generate-layer": "Generate layer",
  "text-detect": "Detect text",
  "text-edit": "Edit text",
  "bg-remove": "Remove background",
  regional: "Regional edit",
  upscale: "Upscale",
  relight: "Relight",
  angles: "Angles",
  expand: "Expand",
  inpaint: "Inpaint",
  enhance: "Enhance",
  rerender: "Re-render from layers",
};

/**
 * Models each tool offers, per engine (the first is the default). Checked against the catalog in tests. On the open
 * engine the newest image models come first: Qwen-Image 2.1 (and its 8-step Turbo) edits, inpaints, expands, turns the
 * camera and makes a layer; Krea 2 and FIBO 2 edit after it. Ideogram 4 comes second for a layer: its safety filter
 * answers most lone objects on a plain background with a grey card. Every list holds only models whose route takes what
 * the tool sends (an edit of one picture, a mask, the margins to fill).
 */
export const TOOL_MODELS: Record<LayerTool, { cloud: string[]; open: string[] }> = {
  decompose: { cloud: ["seedream-5-layers", "seedream-5-flash-layers", "qwen-image-layered-cloud"], open: ["oss-qwen-layered"] },
  split: { cloud: ["seedream-5-layers", "seedream-5-flash-layers", "qwen-image-layered-cloud"], open: ["oss-qwen-layered", "oss-qwen-layered-control"] },
  // Layer edit sends the layer and up to 3 references: Krea 2 Edit isn't offered here, it takes 2 and reads the second as a person.
  regenerate: { cloud: ["nano-banana-pro", "seedream-5-pro", "nano-banana-2-1"], open: ["oss-qwen-image-21", "oss-qwen-image-21-turbo", "oss-fibo2-edit-turbo"] },
  "generate-layer": { cloud: ["nano-banana-pro", "seedream-5-pro"], open: ["oss-qwen-image-21", "oss-ideogram-4", "oss-krea2-turbo", "oss-moss-image"] },
  // Ideogram ($0.09) also lifts the text off the picture, which the editor doesn't use; Florence-2 only
  // reads it (fal lists $0 per compute second, real cost unverified: the catalog's $0.001 is a placeholder).
  "text-detect": { cloud: ["ideogram-3-text-layers", "florence-2-ocr"], open: ["oss-ocr-lines"] },
  "text-edit": { cloud: ["nano-banana-pro", "seedream-5-pro"], open: ["oss-qwen-image-21", "oss-qwen-image-21-turbo", "oss-krea2-edit"] },
  // Bria's guided cut-out takes optional words on what to keep or drop; FeyNoBg keeps fine hair (nm10-keying).
  "bg-remove": { cloud: ["birefnet-cloud", "ideogram-remove-bg", "bria-guided-cutout"], open: ["oss-rmbg", "oss-matte-feynobg"] },
  regional: { cloud: ["seedream-5-pro", "nano-banana-pro"], open: ["oss-qwen-image-21", "oss-krea2-edit", "oss-fibo2-edit-turbo"] },
  // SeedVR2 restores detail as it enlarges; 4x ESRGAN is the quick choice.
  upscale: { cloud: ["topaz-image", "seedvr-image", "recraft-crisp"], open: ["oss-seedvr2-image", "oss-upscale-image"] },
  // Qwen-Image 2.1 Turbo and Krea 2 Edit relight from plain words; the Qwen-Image-Edit 2509 graph carries its Relight LoRA.
  relight: { cloud: ["nano-banana-pro", "nano-banana-2-1"], open: ["oss-qwen-image-21-turbo", "oss-krea2-edit", "oss-qwen-relight"] },
  // Qwen-Image 2.1 at 25 steps on plain camera words (its Turbo misses big camera turns).
  angles: { cloud: ["qwen-multiple-angles", "nano-banana-pro"], open: ["oss-qwen-image-21"] },
  // Both open graphs grow the canvas themselves from the pads. Krea 2 Inpaint isn't offered here: its graph scales the
  // picture to about 1 MP and redraws all of it, and it needs the Ostris Edit add-on.
  expand: { cloud: ["nano-banana-pro"], open: ["oss-qwen-image-21", "oss-flux-fill"] },
  // Nano Banana Pro sees the painted area tinted red (Higgsfield's nano_banana_pro_inpaint); the others take the mask itself
  // (Bria FIBO 2's edit keeps a single picture's own shape).
  inpaint: { cloud: ["nano-banana-pro", "bria-fibo-2", "z-image-inpaint"], open: ["oss-qwen-image-21", "oss-flux-fill"] },
  // The retouch looks; Detail runs on {@link ENHANCE_DETAIL_MODELS}.
  enhance: { cloud: ["nano-banana-pro", "seedream-5-pro"], open: ["oss-qwen-image-21", "oss-qwen-image-21-turbo", "oss-krea2-edit"] },
  // One repaint of the arrangement from its boxes: MOSS-Image on both engines (fal hosts it), and the cloud's other models
  // that read layout boxes in their prompt (Ideogram 4.5, FLUX.3).
  rerender: { cloud: ["moss-image", "ideogram-4-5", "flux-3"], open: ["oss-moss-image"] },
};

// ---------------------------------------------------------------------------
// Enhancer (Higgsfield's skin-enhancer, plus the upscalers' detail pass)

export type EnhanceLook = "skin" | "glow" | "sharpen" | "detail";

/** The looks: what each does, and the instruction an edit model gets (Detail has none: an upscaler restores it). */
export const ENHANCE_LOOKS: { id: EnhanceLook; label: string; verb: string; hint: string; prompt?: string }[] = [
  {
    id: "skin",
    label: "Skin",
    verb: "Retouch skin",
    hint: "A natural retouch: blemishes and redness even out, pores and freckles stay",
    prompt: "Give the portrait a subtle natural retouch: even out redness and blemishes while keeping every pore, freckle and fine line.",
  },
  {
    id: "glow",
    label: "Soft glow",
    verb: "Add a soft glow",
    hint: "A soft beauty retouch with a healthy, dewy glow",
    prompt: "Give the portrait a soft beauty retouch with a healthy dewy glow, still keeping real pore texture.",
  },
  {
    id: "sharpen",
    label: "Sharpen",
    verb: "Sharpen",
    hint: "Removes blur and noise, restores crisp edges",
    prompt: "Sharpen the image: remove blur, noise and compression artefacts and restore crisp detail in edges, eyes, hair, fabric and text.",
  },
  { id: "detail", label: "Detail", verb: "Restore detail", hint: "An upscaler rebuilds fine detail at twice the width and height, in the same place on the canvas" },
];

/** The upscalers behind the Detail look (the Upscale tool's, Topaz with its face pass first). */
export const ENHANCE_DETAIL_MODELS: { cloud: string[]; open: string[] } = { cloud: ["topaz-image", "seedvr-image"], open: ["oss-seedvr2-image", "oss-upscale-image"] };

/**
 * Detail is 2× on every engine: the cloud upscalers are 2× as listed (Topaz, SeedVR's upscale_factor),
 * the open graphs default to 4× and take a `scale` (SeedVR2's output multiplier; ESRGAN's resize after
 * its fixed 4×, so 0.5 nets 2×). A 2048-px layer would otherwise come back at 8192 px.
 */
export const ENHANCE_DETAIL_SCALE: Record<string, number> = { "oss-seedvr2-image": 2, "oss-upscale-image": 0.5 };

/** The models a look offers on an engine (the first is the default). */
export function enhanceModels(look: EnhanceLook | undefined, engine: "cloud" | "open"): string[] {
  return look === "detail" ? ENHANCE_DETAIL_MODELS[engine] : TOOL_MODELS.enhance[engine];
}

/** The edit instruction of a retouch look, with anything the user added; null for Detail. */
export function enhancePrompt(look: EnhanceLook | undefined, extra?: string): string | null {
  const l = ENHANCE_LOOKS.find((x) => x.id === look) ?? ENHANCE_LOOKS[0];
  if (!l.prompt) return null;
  const keep =
    l.id === "sharpen"
      ? "Keep the content, composition, colours and lighting exactly the same."
      : "Make the skin look like a high-end editorial photograph shot on a sharp lens, with real, natural skin texture and the same makeup. Keep the face shape, identity, expression, hair, lighting and background exactly the same.";
  return [l.prompt, keep, extra?.trim()].filter(Boolean).join(" ");
}

/** Relight looks (the Relight app's), as [label, prompt]. */
export const RELIGHT_LIGHTS: [string, string][] = [
  ["Golden hour", "warm golden hour sunlight"],
  ["Neon night", "pink and blue neon lights at night"],
  ["Studio softbox", "soft, even studio softbox lighting"],
  ["Dramatic", "dramatic low-key lighting with a single hard light and deep shadows"],
  ["Overcast", "soft overcast daylight"],
  ["Candlelight", "warm flickering candlelight"],
  ["Silhouette", "strong backlight that turns the subject into a near-silhouette"],
  ["Window", "soft directional window light"],
];

export const RELIGHT_DIRECTIONS: [string, string][] = [
  ["Auto", ""],
  ["Left", "coming from the left"],
  ["Right", "coming from the right"],
  ["Front", "coming from the front"],
  ["Above", "coming from above"],
  ["Behind", "coming from behind the subject as a rim light"],
];

/** The Qwen-Image-Edit 2509 relight graph: it loads the Relight LoRA and puts the LoRA's trigger before the words itself. */
export const RELIGHT_LORA_MODEL = "oss-qwen-relight";
/** Qwen-Image 2.1's edit models: its text encoder names the pictures <image1>, <image2>… */
export const QWEN21_EDIT_MODELS: readonly string[] = ["oss-qwen-image-21", "oss-qwen-image-21-turbo"];

/**
 * A relight's words for an edit model: the light alone for the Relight LoRA graph, Qwen-Image 2.1's own picture tags
 * (the wording its relit preset covers were made with), and a plain instruction for every other model.
 */
export function relightPrompt(modelId: string, light: string, direction = ""): string {
  if (modelId === RELIGHT_LORA_MODEL) return `${light}${direction ? `, ${direction}` : ""}`;
  const lit = `${light}${direction ? ` ${direction}` : ""}`;
  if (QWEN21_EDIT_MODELS.includes(modelId)) {
    return `Relight <image1> with ${lit}. Keep every person, face, pose, object, the setting and the framing exactly as in <image1>; only the light, shadows, reflections and colour temperature change.`;
  }
  return `Relight the image with ${lit}. Keep the subject, composition and all details identical; only the light, shadows, reflections and color temperature change.`;
}

/** Camera angles (the Angles app's), as [label, prompt]. */
export const ANGLES: [string, string][] = [
  ["Left 45°", "rotated 45 degrees to the left around the subject"],
  ["Right 45°", "rotated 45 degrees to the right around the subject"],
  ["Left profile", "a full left side profile view"],
  ["Right profile", "a full right side profile view"],
  ["Back", "a view from directly behind"],
  ["High angle", "a high-angle view looking down at the subject"],
  ["Low angle", "a low-angle view looking up at the subject"],
  ["Bird's eye", "a top-down bird's-eye view from directly above"],
  ["Close-up", "a tight close-up"],
  ["Wide", "a wide shot showing the full environment"],
];

/** What the editor knows about a tool's model (built by its page, so the browser needs no catalog). */
export interface LayerModelInfo {
  id: string;
  name: string;
  engine: "cloud" | "open";
  tagline: string;
  /** Its price; a launch price (Pricing.promo) holds through its last day (costLabel reads the browser's clock). */
  pricing?: { unit: string; usd: number; note?: string; promo?: Pricing["promo"] };
  /** Providers its routes run on (demo detection: none of them connected). */
  providers: string[];
  /** It takes words on what to keep or drop (Bria's guided cut-out): Remove background shows a box for them. */
  guided?: boolean;
}

/** Cuts the background back out after an edit model repaints a transparent layer. */
export const CUTOUT_MODELS = { cloud: "birefnet-cloud", open: "oss-rmbg" } as const;

/** Decomposition list prices per layer (research: paid-model-apis-3 §3). */
export const LAYER_PRICES: Record<string, { perLayer: number; doubleAt2K?: boolean; maxLayers: number }> = {
  "seedream-5-layers": { perLayer: 0.03375, doubleAt2K: true, maxLayers: 16 },
  "seedream-5-flash-layers": { perLayer: 0.027, maxLayers: 16 },
  "qwen-image-layered-cloud": { perLayer: 0.05, maxLayers: 8 },
  "oss-qwen-layered": { perLayer: 0, maxLayers: 10 },
  "oss-qwen-layered-control": { perLayer: 0, maxLayers: 10 },
};

/** Estimated price of a decomposition ("≈"): Seedream bills each layer it returns. */
export function decomposeCost(modelId: string, layers: number, resolution: "1K" | "1.5K" | "2K" = "1K"): number | null {
  const p = LAYER_PRICES[modelId];
  if (!p) return null;
  const n = Math.min(p.maxLayers, Math.max(1, Math.round(layers)));
  return Math.round(p.perLayer * n * (p.doubleAt2K && resolution === "2K" ? 2 : 1) * 1000) / 1000;
}

/** Qwen-Image-Layered Control: pulls a named element out of a layer (it needs the name). */
export const LAYERED_CONTROL = "oss-qwen-layered-control";

/**
 * The model a decomposition or a split runs on. On the open engine a split with a named element
 * (a prompt) goes to Layered-Control and one without a name to plain Qwen-Image-Layered, whichever of
 * the two was asked for (the form says so). Elsewhere: the model asked for (unset = the default).
 */
export function layersModelFor(tool: "decompose" | "split", engine: "cloud" | "open", modelId: string | undefined, prompt: string | undefined): string | undefined {
  if (tool !== "split" || engine !== "open") return modelId;
  const plain = TOOL_MODELS.split.open[0];
  if (prompt?.trim()) return !modelId || modelId === plain ? LAYERED_CONTROL : modelId;
  return modelId === LAYERED_CONTROL ? plain : modelId;
}

/** The layer count a decomposition starts at: 8 for the image, 3 for a layer, 2 for a named element. */
export function defaultLayers(tool: "decompose" | "split", modelId: string | undefined): number {
  return modelId === LAYERED_CONTROL ? 2 : tool === "split" ? 3 : 8;
}

/** The fewest layers a model can be asked for (Layered-Control: the element and the rest). */
export function minLayers(modelId: string): number {
  return modelId === LAYERED_CONTROL ? 2 : 3;
}

/** The layer count a decomposition model can be asked for (Seedream picks its own, up to 16). */
export function clampLayers(modelId: string, layers: number): number {
  const max = LAYER_PRICES[modelId]?.maxLayers ?? 10;
  return Math.min(max, Math.max(minLayers(modelId), Math.round(layers)));
}

// ---------------------------------------------------------------------------
// Names and downloads

/** "Hero Shot / v2!" → "hero-shot-v2": lower case, runs of anything but a–z0–9 become "-", ≤ 48 chars. */
export function slugify(name: string, max = 48): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

/** `layer-z{z}-{slug}.png`, or `layer-z{z}-layer-{index}.png` when the name has no usable characters. */
export function layerFileName(z: number, name: string, index = z): string {
  return `layer-z${z}-${slugify(name) || `layer-${index}`}.png`;
}

/** The layers a zip holds, bottom to top, with their file names (every layer, hidden ones too). */
export function zipPlan(doc: LayerDoc): { nodeId: string; file: string }[] {
  const seen = new Set<string>();
  return [...doc.nodes]
    .sort((a, b) => a.z - b.z)
    .map((n, i) => {
      let file = layerFileName(n.z, n.name, i);
      for (let k = 2; seen.has(file); k++) file = file.replace(/(-\d+)?\.png$/, `-${k}.png`);
      seen.add(file);
      return { nodeId: n.id, file };
    });
}

/** The project's file names: "cropped-layers.zip", "positioned-layers.zip", "<slug>.png". */
export function downloadFileName(kind: "cropped" | "positioned" | "image", projectName: string): string {
  if (kind === "cropped") return "cropped-layers.zip";
  if (kind === "positioned") return "positioned-layers.zip";
  return `${slugify(projectName) || "image"}.png`;
}

/** Copy JSON: the document as a design file (absolute image links when `origin` is given). */
export function docJson(doc: LayerDoc, origin = ""): string {
  const abs = (u: string | undefined) => (u && u.startsWith("/") ? `${origin}${u}` : u);
  return JSON.stringify(
    {
      width: doc.width,
      height: doc.height,
      source: abs(doc.source),
      layers: [...doc.nodes]
        .sort((a, b) => a.z - b.z)
        .map((n) => ({
          type: "image",
          layerIndex: n.z,
          name: n.name,
          geometry: { x: round2(n.x), y: round2(n.y), width: round2(n.w), height: round2(n.h), rotation: round2(n.rotation) },
          hidden: !!n.hidden,
          opacity: n.opacity ?? 1,
          source: abs(n.src),
          ...(n.crop ? { crop: n.crop.map(round2) } : {}),
          ...(n.maskSrc ? { mask: abs(n.maskSrc) } : {}),
        })),
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Geometry

const round2 = (n: number) => Math.round(n * 100) / 100;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** [x, y, w, h] from an array of four numbers, else null. */
export function asBox(v: unknown): Box | null {
  return Array.isArray(v) && v.length === 4 && v.every(finite) ? (v as Box) : null;
}

/** Axis-aligned bounds of a box rotated `deg` clockwise around its centre. */
export function rotatedBounds(x: number, y: number, w: number, h: number, deg: number): Box {
  const r = (deg * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  const bw = w * c + h * s;
  const bh = w * s + h * c;
  return [x + w / 2 - bw / 2, y + h / 2 - bh / 2, bw, bh];
}

/** Overlap of two boxes, or null. */
export function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a[0], b[0]);
  const y = Math.max(a[1], b[1]);
  const r = Math.min(a[0] + a[2], b[0] + b[2]);
  const btm = Math.min(a[1] + a[3], b[1] + b[3]);
  return r > x && btm > y ? [x, y, r - x, btm - y] : null;
}

/**
 * A layer's cropped download: its rotation-aware bounding box, rounded out to whole pixels and kept
 * inside the document (null when nothing of it is on the canvas).
 */
export function cropRect(node: Pick<LayerNode, "x" | "y" | "w" | "h" | "rotation">, doc: Pick<LayerDoc, "width" | "height">): Box | null {
  const [bx, by, bw, bh] = rotatedBounds(node.x, node.y, node.w, node.h, node.rotation);
  const x0 = Math.floor(bx + 1e-6);
  const y0 = Math.floor(by + 1e-6);
  const x1 = Math.ceil(bx + bw - 1e-6);
  const y1 = Math.ceil(by + bh - 1e-6);
  return intersect([x0, y0, x1 - x0, y1 - y0], [0, 0, doc.width, doc.height]);
}

/** The tight box of the pixels with alpha above `threshold` in RGBA data, or null when all are clear. */
export function bboxFromAlpha(data: ArrayLike<number>, width: number, height: number, threshold = 0): Box | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : [minX, minY, maxX - minX + 1, maxY - minY + 1];
}

/**
 * Whether RGBA pixels are a cut-out rather than a full-frame picture: at least `share` of them mostly
 * clear (a decomposition's layer, a removed background). A few soft edge pixels don't count.
 */
export function seeThrough(rgba: ArrayLike<number>, share = 0.005): boolean {
  const n = Math.floor(rgba.length / 4);
  let clear = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 128) clear++;
  return n > 0 && clear / n >= share;
}

/** Where a document point falls inside a (rotated) layer: [u, v] in 0–1, or null when outside. */
export function toLocal(node: Pick<LayerNode, "x" | "y" | "w" | "h" | "rotation">, px: number, py: number): [number, number] | null {
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  const r = (-node.rotation * Math.PI) / 180;
  const dx = px - cx;
  const dy = py - cy;
  const lx = dx * Math.cos(r) - dy * Math.sin(r);
  const ly = dx * Math.sin(r) + dy * Math.cos(r);
  const u = lx / node.w + 0.5;
  const v = ly / node.h + 0.5;
  const e = 1e-9;
  return u >= -e && u <= 1 + e && v >= -e && v <= 1 + e ? [Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v))] : null;
}

/** The image pixels a layer shows, from its crop (or the whole image). */
export function sourceRect(node: Pick<LayerNode, "crop" | "natural">): Box | null {
  if (node.crop) return node.crop;
  return node.natural ? [0, 0, node.natural[0], node.natural[1]] : null;
}

/**
 * The size to render one layer alone at its own resolution (the pixels it shows, not the document's),
 * for handing it to a model. Capped at `max` on the long side.
 */
export function nativeSize(node: Pick<LayerNode, "w" | "h" | "crop" | "natural">, max = 2048): [number, number] {
  const src = sourceRect(node);
  const scale = src ? src[2] / node.w : 1;
  let w = node.w * scale;
  let h = node.h * scale;
  const k = Math.min(1, max / Math.max(w, h));
  w = Math.max(1, Math.round(w * k));
  h = Math.max(1, Math.round(h * k));
  return [w, h];
}

/** Exports stay at most this many pixels on their long side. */
export const EXPORT_MAX_PX = 8192;

/** Image pixels per document pixel a layer carries: 1 as placed, 4 after a 4× upscale. */
export function layerDensity(node: Pick<LayerNode, "w" | "crop" | "natural">): number {
  const src = sourceRect(node);
  return src && node.w > 0 && src[2] > 0 ? src[2] / node.w : 1;
}

/** The share of the canvas a layer covers (its rotation-aware box inside the document), 0–1. */
export function coverage(node: Pick<LayerNode, "x" | "y" | "w" | "h" | "rotation">, doc: Pick<LayerDoc, "width" | "height">): number {
  const b = intersect(rotatedBounds(node.x, node.y, node.w, node.h, node.rotation), [0, 0, doc.width, doc.height]);
  return b ? (b[2] * b[3]) / (doc.width * doc.height) : 0;
}

/**
 * The scale a full-detail export renders at: the densest of the visible layers that cover at least
 * half of the canvas (a whole-picture upscale makes the export bigger; a small layer a model
 * returned at 2K doesn't blow up the picture around it), never below 1, kept to `max` px on the long side.
 */
export function exportScale(doc: Pick<LayerDoc, "width" | "height" | "nodes">, max = EXPORT_MAX_PX): number {
  let d = 1;
  for (const n of doc.nodes) if (!n.hidden && coverage(n, doc) >= 0.5) d = Math.max(d, layerDensity(n));
  return Math.max(1, Math.min(d, max / Math.max(doc.width, doc.height)));
}

/** One layer's own scale for a cropped download (its density, ≥ 1, ≤ `max` px on the long side of `rect`). */
export function layerExportScale(node: Pick<LayerNode, "w" | "crop" | "natural">, rect: Box, max = EXPORT_MAX_PX): number {
  return Math.max(1, Math.min(layerDensity(node), max / Math.max(rect[2], rect[3])));
}

/** The pixel size of a render of `w × h` doc px at `scale`. */
export const scaledSize = (w: number, h: number, scale: number): [number, number] => [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];

export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/**
 * Resize a (rotated) layer by dragging a handle `dx, dy` document pixels (screen direction). The
 * opposite edge or corner stays put; corners keep the aspect ratio unless `free`. Minimum 4 px.
 */
export function resizeBox(node: Pick<LayerNode, "x" | "y" | "w" | "h" | "rotation">, handle: Handle, dx: number, dy: number, free = false): Pick<LayerNode, "x" | "y" | "w" | "h"> {
  const r = (node.rotation * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  // The drag in the layer's own axes.
  const lx = dx * cos + dy * sin;
  const ly = -dx * sin + dy * cos;
  const sx = handle.includes("e") ? 1 : handle.includes("w") ? -1 : 0;
  const sy = handle.includes("s") ? 1 : handle.includes("n") ? -1 : 0;
  let w = Math.max(4, node.w + sx * lx);
  let h = Math.max(4, node.h + sy * ly);
  if (sx && sy && !free) {
    // Corners: follow the larger change, keep the shape.
    const k = Math.max(w / node.w, h / node.h);
    w = Math.max(4, node.w * k);
    h = Math.max(4, node.h * k);
  }
  // The fixed point (opposite edge/corner) in local coords, relative to the old centre.
  const fx = (-sx * node.w) / 2;
  const fy = (-sy * node.h) / 2;
  // New centre = fixed point + half the new size towards the handle, back in document axes.
  const ncx = fx + (sx * w) / 2;
  const ncy = fy + (sy * h) / 2;
  const cx = node.x + node.w / 2 + ncx * cos - ncy * sin;
  const cy = node.y + node.h / 2 + ncx * sin + ncy * cos;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** Rotation (degrees, clockwise, -180…180) that points a layer's top at a pointer; `snap` rounds to 15°. */
export function rotationTo(cx: number, cy: number, px: number, py: number, snap = false): number {
  let deg = (Math.atan2(px - cx, -(py - cy)) * 180) / Math.PI;
  if (snap) deg = Math.round(deg / 15) * 15;
  if (deg > 180) deg -= 360;
  if (deg <= -180) deg += 360;
  return Math.abs(deg) < 1e-9 ? 0 : deg;
}

/** A rectangle from two corner points, kept inside the document; null when smaller than `min` px. */
export function rectFrom(x0: number, y0: number, x1: number, y1: number, doc: Pick<LayerDoc, "width" | "height">, min = 8): Box | null {
  const b = intersect([Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)], [0, 0, doc.width, doc.height]);
  if (!b || b[2] < min || b[3] < min) return null;
  return [Math.round(b[0]), Math.round(b[1]), Math.round(b[2]), Math.round(b[3])];
}

// ---------------------------------------------------------------------------
// Placing model outputs

export interface OutputMeta {
  bbox?: unknown;
  bboxNormalized?: unknown;
  width?: unknown;
  height?: unknown;
}

export interface Placement {
  /** Where the layer goes (doc px). */
  box: Box;
  /** The part of the image to show (image px), null = all of it. */
  crop: Box | null;
  /** A full-canvas image with no box from the provider: crop it to its alpha (see {@link tightenToAlpha}). */
  needsAlpha: boolean;
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= Math.max(tol, Math.abs(b) * 0.02);

/**
 * Where a model's layer goes in the document. The model worked on the picture that sat at `frame`;
 * its layer is either the whole canvas (Qwen: full-size RGBA, boxes from alpha) or already cut to its
 * box (Seedream may return cut layers with boxes in the base image's pixels). Boxes come as
 * `bboxNormalized` (0–1000 or 0–1) or `bbox` in pixels of `meta.width × meta.height`, else of `ref`
 * (Seedream: the base layer), else of the image itself.
 */
export function placeOutput(frame: Box, image: [number, number], meta: OutputMeta = {}, ref?: [number, number]): Placement {
  const [iw, ih] = image;
  const refW = finite(meta.width) && meta.width > 0 ? meta.width : ref?.[0] ?? iw;
  const refH = finite(meta.height) && meta.height > 0 ? meta.height : ref?.[1] ?? ih;
  let rel: Box | null = null;
  const bn = asBox(meta.bboxNormalized);
  const b = asBox(meta.bbox);
  if (bn) {
    const k = Math.max(...bn.map(Math.abs)) > 1.5 ? 1000 : 1;
    rel = [bn[0] / k, bn[1] / k, bn[2] / k, bn[3] / k];
  } else if (b) rel = [b[0] / refW, b[1] / refH, b[2] / refW, b[3] / refH];
  if (rel && (rel[2] <= 0 || rel[3] <= 0)) rel = null;
  const map = (r: Box): Box => [frame[0] + r[0] * frame[2], frame[1] + r[1] * frame[3], r[2] * frame[2], r[3] * frame[3]];
  if (!rel) return { box: frame, crop: null, needsAlpha: true };
  const whole = near(rel[0], 0, 0.005) && near(rel[1], 0, 0.005) && near(rel[2], 1, 0.005) && near(rel[3], 1, 0.005);
  if (whole) return { box: frame, crop: null, needsAlpha: false };
  // Already cut to its box: the image is the region's size.
  const cut = near(iw, rel[2] * refW, 2) && near(ih, rel[3] * refH, 2);
  const fullCanvas = !cut && near(iw / ih, refW / refH, 0.01);
  if (!fullCanvas) return { box: map(rel), crop: null, needsAlpha: false };
  return { box: map(rel), crop: [rel[0] * iw, rel[1] * ih, rel[2] * iw, rel[3] * ih], needsAlpha: false };
}

/** A full-canvas layer cropped to its alpha box (image px); null when the layer is empty. */
export function tightenToAlpha(frame: Box, image: [number, number], alpha: Box | null): Placement | null {
  if (!alpha) return null;
  const [iw, ih] = image;
  const rel: Box = [alpha[0] / iw, alpha[1] / ih, alpha[2] / iw, alpha[3] / ih];
  return { box: [frame[0] + rel[0] * frame[2], frame[1] + rel[1] * frame[3], rel[2] * frame[2], rel[3] * frame[3]], crop: alpha, needsAlpha: false };
}

export interface MeasuredOutput {
  url: string;
  meta?: Record<string, unknown>;
  natural: [number, number];
  placement: Placement;
}

/** A layer's display name from a model's meta, else "Background" / "Layer n". */
export function outputName(meta: Record<string, unknown> | undefined, z: number): string {
  const n = typeof meta?.name === "string" ? meta.name.trim() : "";
  return n ? n.slice(0, 80) : z === 0 ? "Background" : `Layer ${z}`;
}

/**
 * New layer nodes from measured model outputs, bottom to top by meta.z (then output order). A split
 * passes the layer's `frame` and `rotation`: the parts turn with it around its centre. Unnamed parts
 * of a split are called “{baseName} · part n”.
 */
export function nodesFromOutputs(
  outs: MeasuredOutput[],
  opts: { id: () => string; label: string; at: number; baseName?: string; frame?: Box; rotation?: number },
): LayerNode[] {
  const rot = opts.rotation ?? 0;
  const r = (rot * Math.PI) / 180;
  return outs
    .map((o, i) => ({ o, i, z: finite(o.meta?.z) ? (o.meta!.z as number) : i }))
    .sort((a, b) => a.z - b.z || a.i - b.i)
    .map(({ o }, i) => {
      let [x, y] = o.placement.box;
      const [, , w, h] = o.placement.box;
      if (rot && opts.frame) {
        // Turn the part's centre around the frame's centre.
        const fcx = opts.frame[0] + opts.frame[2] / 2;
        const fcy = opts.frame[1] + opts.frame[3] / 2;
        const dx = x + w / 2 - fcx;
        const dy = y + h / 2 - fcy;
        x = fcx + dx * Math.cos(r) - dy * Math.sin(r) - w / 2;
        y = fcy + dx * Math.sin(r) + dy * Math.cos(r) - h / 2;
      }
      const rev: LayerRevision = { src: o.url, crop: o.placement.crop, natural: o.natural, label: opts.label, at: opts.at };
      // Providers without names call them "Background" / "Layer n": those read as unnamed parts.
      const named = typeof o.meta?.name === "string" && o.meta.name.trim() && !/^(background|layer \d+)$/i.test(o.meta.name.trim());
      const name = opts.baseName && !named ? `${opts.baseName} · part ${i + 1}`.slice(0, 80) : outputName(o.meta, i);
      return { id: opts.id(), name, z: i, x, y, w, h, rotation: rot, src: o.url, crop: o.placement.crop, natural: o.natural, revisions: [rev], revision: 0 };
    });
}

// ---------------------------------------------------------------------------
// Document operations (all return a new document)

/** A new project's document: the source image as its only layer. */
export function initialDoc(source: string, width: number, height: number, at = Date.now(), id = "original"): LayerDoc {
  const rev: LayerRevision = { src: source, crop: null, natural: [width, height], label: "Original", at };
  return {
    v: 1,
    width,
    height,
    source,
    decomposed: false,
    sourceBox: [0, 0, width, height],
    nodes: [{ id, name: "Original image", z: 0, x: 0, y: 0, w: width, h: height, rotation: 0, src: source, crop: null, natural: [width, height], revisions: [rev], revision: 0 }],
  };
}

/** Nodes sorted by z with z = index. */
export function normalize(doc: LayerDoc): LayerDoc {
  const nodes = [...doc.nodes].sort((a, b) => a.z - b.z).map((n, i) => (n.z === i ? n : { ...n, z: i }));
  return nodes.every((n, i) => n === doc.nodes[i]) ? doc : { ...doc, nodes };
}

const withNodes = (doc: LayerDoc, nodes: LayerNode[]): LayerDoc => {
  if (nodes.length > MAX_NODES && nodes.length > doc.nodes.length) throw new LayerLimitError();
  return normalize({ ...doc, nodes: nodes.map((n, i) => (n.z === i ? n : { ...n, z: i })) });
};

/** Whether `more` layers still fit in the document. */
export const roomFor = (doc: Pick<LayerDoc, "nodes">, more = 1): boolean => doc.nodes.length + more <= MAX_NODES;

export function getNode(doc: LayerDoc, id: string | null | undefined): LayerNode | undefined {
  return id ? doc.nodes.find((n) => n.id === id) : undefined;
}

export function updateNode(doc: LayerDoc, id: string, patch: Partial<LayerNode>): LayerDoc {
  let changed = false;
  const nodes = doc.nodes.map((n) => {
    if (n.id !== id) return n;
    const next = { ...n, ...patch };
    changed = (Object.keys(patch) as (keyof LayerNode)[]).some((k) => n[k] !== next[k]);
    return changed ? next : n;
  });
  return changed ? { ...doc, nodes } : doc;
}

/** Move a layer to stacking position `to` (0 = bottom). */
export function moveNode(doc: LayerDoc, id: string, to: number): LayerDoc {
  const sorted = [...doc.nodes].sort((a, b) => a.z - b.z);
  const from = sorted.findIndex((n) => n.id === id);
  const dest = Math.max(0, Math.min(sorted.length - 1, Math.round(to)));
  if (from < 0 || from === dest) return doc;
  const [n] = sorted.splice(from, 1);
  sorted.splice(dest, 0, n);
  return withNodes(doc, sorted);
}

/** A copy right above the original, in the same place. */
export function duplicateNode(doc: LayerDoc, id: string, newId: string): LayerDoc {
  const sorted = [...doc.nodes].sort((a, b) => a.z - b.z);
  const i = sorted.findIndex((n) => n.id === id);
  if (i < 0) return doc;
  const src = sorted[i];
  sorted.splice(i + 1, 0, { ...src, id: newId, name: `${src.name} copy`.slice(0, 80), revisions: src.revisions.map((r) => ({ ...r })), role: undefined });
  return withNodes(doc, sorted);
}

export function deleteNode(doc: LayerDoc, id: string): LayerDoc {
  return doc.nodes.some((n) => n.id === id) ? withNodes(doc, [...doc.nodes].sort((a, b) => a.z - b.z).filter((n) => n.id !== id)) : doc;
}

/** Insert layers at stacking position `at` (default: on top). */
export function addNodes(doc: LayerDoc, add: LayerNode[], at?: number): LayerDoc {
  const sorted = [...doc.nodes].sort((a, b) => a.z - b.z);
  sorted.splice(at === undefined ? sorted.length : Math.max(0, Math.min(sorted.length, at)), 0, ...add);
  return withNodes(doc, sorted);
}

/** Swap layers for others in the place of the topmost one (a split, a merged region). */
export function replaceNodes(doc: LayerDoc, ids: string[], add: LayerNode[]): LayerDoc {
  const sorted = [...doc.nodes].sort((a, b) => a.z - b.z);
  const idx = sorted.map((n, i) => (ids.includes(n.id) ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return doc;
  const keep = sorted.filter((n) => !ids.includes(n.id));
  const at = Math.max(...idx) - (idx.length - 1);
  keep.splice(at, 0, ...add);
  return withNodes(doc, keep);
}

/** Keep the centre and width, take the height from the image's shape. */
function refit(node: LayerNode, rev: Pick<LayerRevision, "crop" | "natural">): Pick<LayerNode, "x" | "y" | "w" | "h"> {
  const src = rev.crop ?? (rev.natural ? ([0, 0, rev.natural[0], rev.natural[1]] as Box) : null);
  if (!src || src[2] <= 0 || src[3] <= 0) return node;
  const aspect = src[2] / src[3];
  if (near(node.w / node.h, aspect, 0.01)) return node;
  const h = node.w / aspect;
  return { x: node.x, y: node.y + node.h / 2 - h / 2, w: node.w, h };
}

/**
 * Add a new version of a layer's pixels and switch to it. A layer keeps {@link MAX_REVISIONS}: its
 * first one (“Reset layer”) and the newest.
 */
export function addRevision(node: LayerNode, rev: LayerRevision): LayerNode {
  let revisions = node.revisions.length ? [...node.revisions, rev] : [{ src: node.src, crop: node.crop ?? null, natural: node.natural, label: "Before", at: rev.at - 1 }, rev];
  if (revisions.length > MAX_REVISIONS) revisions = [revisions[0], ...revisions.slice(revisions.length - (MAX_REVISIONS - 1))];
  return { ...node, ...refit(node, rev), src: rev.src, crop: rev.crop ?? null, natural: rev.natural, revisions, revision: revisions.length - 1 };
}

/** Show another of a layer's revisions (“Show previous versions”, “Restore layer revision”). */
export function setRevision(node: LayerNode, index: number): LayerNode {
  const i = Math.max(0, Math.min(node.revisions.length - 1, Math.round(index)));
  const rev = node.revisions[i];
  if (!rev || i === node.revision) return node;
  return { ...node, ...refit(node, rev), src: rev.src, crop: rev.crop ?? null, natural: rev.natural, revision: i };
}

/**
 * Expand & Crop: the document becomes `rect` (doc px, may reach outside the old canvas). Layers keep
 * their pixels and move with the frame. Throws when the frame misses the picture.
 */
export function reframeDoc(doc: LayerDoc, rect: Box): LayerDoc {
  const [rx, ry, rw, rh] = rect.map(Math.round) as Box;
  if (rw < 8 || rh < 8 || !intersect([rx, ry, rw, rh], [0, 0, doc.width, doc.height])) throw new Error("The frame no longer overlaps the image. Move it back over the picture.");
  if (rx === 0 && ry === 0 && rw === doc.width && rh === doc.height) return doc;
  const [sx, sy, sw, sh] = sourceBoxOf(doc);
  return { ...doc, width: rw, height: rh, sourceBox: [sx - rx, sy - ry, sw, sh], nodes: doc.nodes.map((n) => ({ ...n, x: n.x - rx, y: n.y - ry })) };
}

/** Where the source image sits in the document (the whole canvas for documents saved before this was kept). */
export function sourceBoxOf(doc: Pick<LayerDoc, "width" | "height" | "sourceBox">): Box {
  return asBox(doc.sourceBox) ?? [0, 0, doc.width, doc.height];
}

/** Outpaint padding for an expanded frame (whole pixels, multiples of 8 as the open workflow wants). */
export function expandPads(doc: Pick<LayerDoc, "width" | "height">, rect: Box): { left: number; top: number; right: number; bottom: number } {
  const up8 = (n: number) => Math.ceil(Math.max(0, n) / 8) * 8;
  return { left: up8(-rect[0]), top: up8(-rect[1]), right: up8(rect[0] + rect[2] - doc.width), bottom: up8(rect[1] + rect[3] - doc.height) };
}

// ---------------------------------------------------------------------------
// Edit history (undo / redo within a session; versions are saved snapshots on the server)

export interface History {
  past: LayerDoc[];
  present: LayerDoc;
  future: LayerDoc[];
  /** The last commit's merge key and time: a burst of commits with the same key is one undo step. */
  merge?: { key: string; at: number };
}

/**
 * `merge` (with `at`, ms) folds a continuous edit into one undo step: a slider drag, typing in a
 * number field, arrow-key nudges. Commits with the same key less than {@link MERGE_WINDOW_MS} apart
 * replace the present instead of adding a step.
 */
export type HistoryAction = { type: "commit"; doc: LayerDoc; merge?: string; at?: number } | { type: "undo" } | { type: "redo" } | { type: "reset"; doc: LayerDoc };

export const HISTORY_LIMIT = 100;
export const MERGE_WINDOW_MS = 1200;

export function historyReducer(h: History, a: HistoryAction): History {
  switch (a.type) {
    case "commit": {
      if (a.doc === h.present) return h;
      const at = a.at ?? 0;
      const merge = a.merge ? { key: a.merge, at } : undefined;
      if (merge && h.merge?.key === merge.key && h.past.length && at - h.merge.at < MERGE_WINDOW_MS) {
        return { past: h.past, present: a.doc, future: [], merge };
      }
      return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: a.doc, future: [], ...(merge ? { merge } : {}) };
    }
    case "undo":
      if (!h.past.length) return h;
      return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] };
    case "redo":
      if (!h.future.length) return h;
      return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) };
    case "reset":
      return { past: [], present: a.doc, future: [] };
  }
}

// ---------------------------------------------------------------------------
// Edit text

export const TEXT_EDIT_PROMPT = "Preserve the original design and change only the requested text.";

export interface TextRow {
  from: string;
  to: string;
}

/** The changes asked for: rows whose text changed (an emptied row removes that text). */
export function textChanges(rows: TextRow[]): TextRow[] {
  return rows.filter((r) => r.from.trim() && r.to.trim() !== r.from.trim()).slice(0, 500);
}

/** The edit instruction: the fixed sentence, then each change. */
export function textEditPrompt(rows: TextRow[]): string {
  const lines = textChanges(rows).map((r) => (r.to.trim() ? `Change “${r.from.trim()}” to “${r.to.trim()}”.` : `Remove “${r.from.trim()}”.`));
  return [TEXT_EDIT_PROMPT, ...lines].join(" ");
}

const cut24 = (s: string) => (s.length > 24 ? `${s.slice(0, 23)}…` : s);

/** “old” → “new” / Remove “old” / {n} text changes. */
export function textJobTitle(rows: TextRow[]): string {
  const c = textChanges(rows);
  if (c.length !== 1) return `${c.length} text changes`;
  const [r] = c;
  return r.to.trim() ? `“${cut24(r.from.trim())}” → “${cut24(r.to.trim())}”` : `Remove “${cut24(r.from.trim())}”`;
}

export interface TextBlock {
  text: string;
  /** 0–1 of the image, when the model said where. */
  box: Box | null;
}

/**
 * Text blocks from a detection: Ideogram's text layers (OutputFile.meta.textBlocks) or an OCR result's
 * lines (meta.lines, from OvisOCR3 or Florence-2). Boxes in pixels are normalised against the size the
 * result gives (meta.size), else `image` (the picture the detector read); without either they're dropped.
 */
export function textBlocksFrom(meta: Record<string, unknown> | undefined, image?: [number, number]): TextBlock[] {
  const size = asSize(meta?.size) ?? image;
  return detectedBlocks(meta)
    .map((o): TextBlock | null => {
      const text = typeof o.text === "string" ? o.text.replace(/\s+/g, " ").trim() : "";
      if (!text) return null;
      const raw = rawBox(o);
      let box = raw?.box ?? null;
      if (box && raw!.px) box = size ? [box[0] / size[0], box[1] / size[1], box[2] / size[0], box[3] / size[1]] : null;
      if (box && (box[2] <= 0 || box[3] <= 0)) box = null;
      return { text, box };
    })
    .filter((b): b is TextBlock => !!b);
}

/** The items of a detection: Ideogram's text blocks or an OCR result's lines. */
function detectedBlocks(meta: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const raw = Array.isArray(meta?.textBlocks) ? meta.textBlocks : Array.isArray(meta?.lines) ? meta.lines : [];
  return raw.filter((b): b is Record<string, unknown> => !!b && typeof b === "object");
}

/** A block's [x, y, w, h], and whether it's in pixels (`bboxPx`, or numbers past 1) rather than 0–1. */
function rawBox(o: Record<string, unknown>): { box: Box; px: boolean } | null {
  let box = asBox(o.bbox);
  if (!box && o.bbox && typeof o.bbox === "object") {
    const q = o.bbox as Record<string, unknown>;
    box = asBox([q.x, q.y, q.w ?? q.width, q.h ?? q.height]);
  }
  if (box) return { box, px: Math.max(...box) > 1.0001 };
  const px = asBox(o.bboxPx);
  return px ? { box: px, px: true } : null;
}

const asSize = (v: unknown): [number, number] | undefined =>
  Array.isArray(v) && v.length === 2 && v.every((n) => finite(n) && n > 0) ? (v as [number, number]) : undefined;

/** A detection gives its boxes in pixels but not the size they're of: the editor measures the picture it sent. */
export function needsDetectedSize(meta: Record<string, unknown> | undefined): boolean {
  return !asSize(meta?.size) && detectedBlocks(meta).some((o) => !!rawBox(o)?.px);
}

/**
 * The backdrop a transparent layer goes on before a detector reads it (detectors see no alpha, and
 * transparent pixels read as black): white under dark text, black under light text. Null when the
 * layer has no transparency to fill.
 */
export function readableBackdrop(rgba: ArrayLike<number>): "#ffffff" | "#000000" | null {
  let sum = 0;
  let n = 0;
  let clear = false;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (a < 250) clear = true;
    if (a > 128) {
      sum += 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
      n++;
    }
  }
  if (!clear) return null;
  return n && sum / n > 140 ? "#000000" : "#ffffff";
}

/** Lay detected blocks out in the document: their 0–1 boxes inside the frame the detector read (doc px). */
export function placeTextBlocks(blocks: TextBlock[], frame: Box): (TextRow & { box: Box | null })[] {
  const [fx, fy, fw, fh] = frame;
  return blocks.map((b) => ({ from: b.text, to: b.text, box: b.box ? [fx + b.box[0] * fw, fy + b.box[1] * fh, b.box[2] * fw, b.box[3] * fh] : null }));
}

// ---------------------------------------------------------------------------
// Inpaint

/** The painted area on the picture handed to edit models without a mask input (the Inpaint studio's red). */
export const INPAINT_TINT = "rgba(255, 59, 48, 0.55)";

/** Inpaint models with no mask input: they're shown the painted area tinted red instead. */
export const INPAINT_SEES_TINT = new Set(["nano-banana-pro"]);

/**
 * The instruction an Inpaint run sends: what goes in the painted area, blended in. Nothing about the
 * background, even on a see-through layer: only the painted area changes, and the cut-out step that
 * follows restores the transparency.
 */
export function inpaintPrompt(prompt: string): string {
  const p = prompt.trim().replace(/[.\s]+$/, "");
  return `${p}. Blend it into the surroundings with matching light, perspective and grain.`;
}

// ---------------------------------------------------------------------------
// Save as Element (a layer becomes a reusable @character, prop or style)

export type LayerElementKind = "character" | "prop" | "style";

export const LAYER_ELEMENT_KINDS: { kind: LayerElementKind; label: string; hint: string }[] = [
  { kind: "character", label: "Character", hint: "A person or creature to keep the same in every picture" },
  { kind: "prop", label: "Prop", hint: "An object or product to place in new scenes" },
  { kind: "style", label: "Style", hint: "A look, texture or background to reuse" },
];

const GENERIC_NAME = /^(background|original image|layer \d+|cut-out|edited layer|text edit|upscaled|relit|new angle|inpainted|enhanced|edited region|expanded fill|color graded|generated layer|original|new|re-render)$/i;
const PERSON = /\b(person|people|man|men|woman|women|girl|boy|child|kid|baby|face|portrait|model|character|subject|figure|hero|lady|guy|dancer|singer|athlete|cat|dog|animal|creature|robot|avatar|mascot)\b/i;
const STYLE = /\b(background|backdrop|texture|pattern|sky|wall|floor|style|look|gradient|scene|landscape|scenery)\b/i;

/**
 * What “Save as element” starts with for a layer: a name from the layer (generic names like
 * “Layer 3” become “Element”), the kind its name suggests (people → character, backdrops → style,
 * anything else → prop) and, when the layer was generated or edited with a prompt, that prompt.
 */
export function elementDraft(node: Pick<LayerNode, "name" | "z" | "prompt">): { name: string; kind: LayerElementKind; description?: string } {
  const base = node.name
    .replace(/\s*·\s*part \d+$/i, "")
    .replace(/\s+copy$/i, "")
    .trim();
  const name = (base && !GENERIC_NAME.test(base) ? base : "Element").slice(0, 60);
  const words = `${base} ${node.prompt ?? ""}`;
  const kind: LayerElementKind = PERSON.test(words) ? "character" : STYLE.test(words) || (node.z === 0 && GENERIC_NAME.test(base)) ? "style" : "prop";
  const description = node.prompt?.trim().slice(0, 500);
  return { name, kind, ...(description ? { description } : {}) };
}

// ---------------------------------------------------------------------------
// Decomposition states (Higgsfield's copy)

export type DecomposeState = "setting-up" | "submitting" | "processing" | "stalled" | "ready" | "failed" | "decomposed";

export const DECOMPOSE_COPY: Record<DecomposeState, [string, string]> = {
  "setting-up": ["Setting up layer decomposition", "One moment."],
  submitting: ["Starting layer decomposition", "Preparing your image for processing."],
  processing: ["Separating image layers", "Your editable layers are being prepared."],
  stalled: ["This is taking longer than expected", "We could not prepare this image for layers. Try again, and if it keeps happening, reload the page."],
  ready: ["Layers are ready", "Opening the layer editor."],
  failed: ["Layer decomposition failed", "Try again, or return to the settings."],
  decomposed: ["Decomposed", "This image is split into # layers. Edit them on the canvas or in the Layers panel."],
};

/** A queued job that hasn't moved for this long reads as stalled. */
export const STALL_MS = 3 * 60_000;

/** "In queue" / "In progress 40%" for a job's generation. */
export function jobStatusText(r: LayerJobResult | null | undefined): string {
  if (!r) return "Starting…";
  if (r.status === "queued") return "In queue";
  if (r.status === "running") return r.progress ? `In progress · ${Math.round(r.progress * 100)}%` : "In progress";
  if (r.status === "failed") return r.error ?? "Failed";
  if (r.status === "canceled") return "Canceled";
  return "Done";
}

/** Tools whose result changes the document when it lands (text detection only fills the Edit text list). */
export const APPLIES_TO_DOC = new Set<LayerTool>(["decompose", "split", "regenerate", "generate-layer", "text-edit", "bg-remove", "regional", "upscale", "relight", "angles", "expand", "inpaint", "enhance", "rerender"]);

// ---------------------------------------------------------------------------
// Re-render from layers (research new-models-7.md §4.10): the arrangement as a layout, painted again as one picture

/** Boxes a re-render sends at most: the largest layers, and the first lines of text. */
export const RERENDER_MAX_LAYERS = 32;
export const RERENDER_MAX_TEXT = 16;
/** A layer covering this much of the canvas is the backdrop: said in the caption, not boxed. */
const BACKDROP_SHARE = 0.9;

/** A line of text on the picture, placed in the document (doc px), as Edit text lists it. */
export interface PlacedText {
  text: string;
  box: Box | null;
}

export interface LayersLayout {
  draft: LayoutDraft;
  /** The words for the whole picture: the person's, else made from the layers' names. */
  caption: string;
  /** Layers in the draft, lines of text in it, and the backdrop layers named in the caption. */
  counts: { layers: number; text: number; backdrop: number };
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** What a layer shows, in words: its prompt, else its name ("a picture element" for a generic one). */
function layerWords(n: Pick<LayerNode, "name" | "prompt">): string {
  const p = n.prompt?.trim();
  if (p) return p.replace(/[.\s]+$/, "");
  const name = n.name.trim();
  return !name || GENERIC_NAME.test(name) ? "a picture element, kept as it looks now" : name;
}

/**
 * The document as a layout for one repaint: each visible layer's box (its rotation-aware bounds, kept on the canvas) with
 * its name or prompt as an object item (a person or animal as a character), bottom to top; each line of text read off the
 * picture as a text item with its exact words. A layer that fills the canvas is the backdrop, named in the caption. The
 * boxes are 0-1 fractions of the canvas, so the model's own size places them.
 */
export function layersLayout(doc: Pick<LayerDoc, "width" | "height" | "nodes">, text: PlacedText[] = [], words = ""): LayersLayout {
  const { width: W, height: H } = doc;
  const canvas: Box = [0, 0, W, H];
  // The part on the canvas, when it is at least a pixel each way (a sliver would be a box with no size).
  const onCanvas = (b: Box): Box | null => {
    const box = intersect(b, canvas);
    return box && box[2] >= 1 && box[3] >= 1 ? box : null;
  };
  const frac = (b: Box): [number, number, number, number] => [r6(b[0] / W), r6(b[1] / H), r6((b[0] + b[2]) / W), r6((b[1] + b[3]) / H)];
  const backdrop: string[] = [];
  const layers: { z: number; area: number; item: LayoutItem }[] = [];
  for (const n of doc.nodes) {
    if (n.hidden || (n.opacity ?? 1) <= 0.05 || n.role === "original") continue;
    // An earlier re-render is a repaint of the layers under it, not a layer of its own.
    if (n.revisions[n.revision]?.label === TOOL_LABELS.rerender) continue;
    const box = onCanvas(rotatedBounds(n.x, n.y, n.w, n.h, n.rotation));
    if (!box) continue;
    const area = (box[2] * box[3]) / (W * H);
    const what = layerWords(n);
    if (area >= BACKDROP_SHARE) {
      backdrop.push(what);
      continue;
    }
    const label = PERSON.test(`${n.name} ${n.prompt ?? ""}`) ? "character" : "object";
    layers.push({ z: n.z, area, item: { label, caption: what.charAt(0).toUpperCase() + what.slice(1), box: frac(box) } });
  }
  const kept = [...layers].sort((a, b) => b.area - a.area).slice(0, RERENDER_MAX_LAYERS).sort((a, b) => a.z - b.z);
  const lines = text
    .flatMap((t) => {
      const line = t.text.replace(/\s+/g, " ").trim();
      const box = t.box && onCanvas(t.box);
      return line && box ? [{ label: "text" as const, caption: "Lettering in the same typeface, colour and size as now", text: line, box: frac(box) }] : [];
    })
    .slice(0, RERENDER_MAX_TEXT);
  const named = kept.map((k) => k.item.caption.toLowerCase()).filter((c) => !c.startsWith("a picture element"));
  const behind = backdrop.length ? ` Behind everything: ${backdrop.join("; ")}.` : "";
  const auto = `One coherent picture that keeps this arrangement${named.length ? `: ${named.slice(0, 8).join(", ")}` : ""}.${behind} Every element sits where it is now, with one light, perspective and colour grade across the whole picture.`;
  const caption = words.trim() ? `${words.trim().replace(/[.\s]+$/, "")}.${behind}` : auto;
  const draft: LayoutDraft = { summary: { caption, meta: ["re-render"], canvas: "single" }, items: [...kept.map((k) => k.item), ...lines] };
  return { draft, caption, counts: { layers: kept.length, text: lines.length, backdrop: backdrop.length } };
}

// ---------------------------------------------------------------------------
// Zip (stored): built in the browser from rendered PNGs

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip of the files, uncompressed (PNGs are already compressed). UTF-8 names. */
export function storedZip(files: { name: string; data: Uint8Array }[], when = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2);
  const date = when.getFullYear() < 1980 ? (1 << 5) | 1 : ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true);
    head.setUint16(8, 0, true);
    head.setUint16(10, time, true);
    head.setUint16(12, date, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, f.data.length, true);
    head.setUint32(22, f.data.length, true);
    head.setUint16(26, name.length, true);
    head.setUint16(28, 0, true);
    parts.push(new Uint8Array(head.buffer), name, f.data);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(10, 0, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, date, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, f.data.length, true);
    dir.setUint32(24, f.data.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const dirSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of all) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
