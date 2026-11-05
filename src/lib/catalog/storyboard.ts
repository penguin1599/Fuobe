/**
 * Storyboards (Higgsfield Popcorn): up to 8 consistent frames. Frame 1 is made from the
 * references (or text alone); every later frame is an edit of the previous frame, so faces,
 * wardrobe, location and grade carry through.
 *
 * Since build plan O13 a board can take one of Fuobe Soul's looks (research §8 popcorn): frame 1
 * is made on Fuobe Soul with the look on either engine (with references it stays on the reference
 * model, with the look's words), the next frames carry the look's words, and every frame gets the
 * look's grade and overlay after it is made (each next frame is made from the previous one as it
 * came out, so the grade is applied once).
 *
 * The board is Fuobe's open recipe on both engines: on your GPU each next frame is Qwen-Image 2.1 with akhaliq's 2.1
 * Next-Scene LoRA, or the classic Qwen-Image-Edit 2509 + next-scene LoRA when the board asks for it
 * (`nextScene`); in the cloud fal's hosted Qwen-Image-Edit 2509 with the 2509 LoRA (sent as a URL), as fal's hosted Qwen-Image
 * 2.1 takes no LoRAs. Nano Banana Pro stays a separate choice in the cloud (`partner`), every frame on it as boards ran before.
 */
import { LAYOUT_PARAM, type LayoutDraft } from "@/lib/layout-prompt";
import { loraEntry, loraRef } from "./loras";
import type { ChainSlot, Engine, GenerationRequest, GenerationStatus, LoraRef } from "./types";

export const MAX_FRAMES = 8;

export interface StoryboardModels {
  first: string;
  firstWithRefs: string;
  next: string;
  chainFrom: "first" | "last";
  /** LoRAs each next frame carries (the cloud's next-scene LoRA; the GPU graph loads its own). */
  nextLoras?: LoraRef[];
}

/** The next-scene LoRA (research adapterLoras): the one the GPU graph loads, at its strength. */
const NEXT_SCENE = loraEntry("next-scene-qwen-edit-2509");

/** Which models make the first frame and the follow-ups on each engine (Fuobe's recipe). */
export const STORYBOARD_MODELS: Record<Engine, StoryboardModels> = {
  // Hosted open weights: Z-Image Turbo, Qwen-Image-Edit 2511 with references, then Qwen-Image-Edit 2509 + next-scene.
  cloud: { first: "z-image-turbo-cloud", firstWithRefs: "qwen-image-edit-2511-cloud", next: "qwen-image-edit-2509-cloud", chainFrom: "first", ...(NEXT_SCENE && { nextLoras: [loraRef(NEXT_SCENE)] }) },
  // Frame 1 on Qwen-Image 2.1 (text to image, or an edit of up to 4 references); then Qwen-Image 2.1 + the 2.1 Next-Scene
  // LoRA takes the previous panel as image 1 and the character as image 2.
  open: { first: "oss-qwen-image-21", firstWithRefs: "oss-qwen-image-21", next: "oss-qwen-image-21-next-scene", chainFrom: "first" },
};

/**
 * The model each next frame runs on your GPU: Qwen-Image 2.1's Next-Scene LoRA (the default), or the classic
 * Qwen-Image-Edit 2509 + next-scene LoRA (the graph boards used before, and the cloud's recipe).
 */
export const STORYBOARD_NEXT_SCENE = { "qwen-21": "oss-qwen-image-21-next-scene", classic: "oss-qwen-next-scene" } as const;
export type StoryboardNextScene = keyof typeof STORYBOARD_NEXT_SCENE;
export const STORYBOARD_NEXT_SCENE_IDS = Object.keys(STORYBOARD_NEXT_SCENE) as [StoryboardNextScene, ...StoryboardNextScene[]];

/** Partner models a cloud board can run on instead (a separate choice): every frame on it, each from the last one. */
export const STORYBOARD_PARTNERS = {
  "nano-banana-pro": { first: "nano-banana-pro", firstWithRefs: "nano-banana-pro", next: "nano-banana-pro", chainFrom: "last" },
} as const satisfies Record<string, StoryboardModels>;
export type StoryboardPartner = keyof typeof STORYBOARD_PARTNERS;
export const STORYBOARD_PARTNER_IDS = Object.keys(STORYBOARD_PARTNERS) as [StoryboardPartner, ...StoryboardPartner[]];

/**
 * The models a board runs on: the partner when one is picked in the cloud, else Fuobe's recipe for the engine, whose next
 * frames on your GPU take the next-scene model asked for.
 */
export function storyboardModels(engine: Engine, partner?: StoryboardPartner, nextScene?: StoryboardNextScene): StoryboardModels {
  if (engine === "cloud") return partner ? STORYBOARD_PARTNERS[partner] : STORYBOARD_MODELS.cloud;
  return nextScene ? { ...STORYBOARD_MODELS.open, next: STORYBOARD_NEXT_SCENE[nextScene] } : STORYBOARD_MODELS.open;
}

/** The model a board with a Soul look makes its first frame on (no references): the look's LoRAs, words and grade. */
export const STORYBOARD_LOOK_MODEL = "fuobe-soul";

/** Shapes a board offers; Fuobe Soul has no 21:9, so a look board makes 16:9 frames and crops them to 21:9 after. */
export const STORYBOARD_ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;
export const LOOK_CROPPED = "21:9";

const SHOTS = [
  "establishing wide shot",
  "medium shot",
  "close-up",
  "over-the-shoulder shot",
  "low-angle shot",
  "detail insert shot",
  "tracking shot",
  "wide closing shot",
];

/** Offline split of one story idea into n scenes (used when no LLM is configured). */
export function heuristicScenes(story: string, n: number): string[] {
  const s = story.trim().replace(/[.\s]+$/, "");
  return Array.from({ length: n }, (_, i) => `${SHOTS[i % SHOTS.length]}: ${s} — beat ${i + 1} of ${n}`);
}

/** Parse an LLM answer into n scene lines (JSON array or numbered list). */
export function parseScenes(text: string, n: number): string[] | null {
  const json = /\[[\s\S]*\]/.exec(text)?.[0];
  if (json) {
    try {
      const arr = (JSON.parse(json) as unknown[]).map((x) => String(typeof x === "object" && x ? ((x as { scene?: string }).scene ?? JSON.stringify(x)) : x).trim()).filter(Boolean);
      if (arr.length >= Math.min(2, n)) return arr.slice(0, n);
    } catch {}
  }
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^\s*(\d+[.)]|[-*•])\s*/, "").trim())
    .filter((l) => l.length > 8);
  return lines.length >= Math.min(2, n) ? lines.slice(0, n) : null;
}

export const SPLIT_SYSTEM = `You are a storyboard artist. Split the user's story into the requested number of consecutive frames of one film.
Each frame is one sentence describing a single still image: shot type, what the characters do, where, the light.
Keep the same characters, wardrobe and location style across frames. Return ONLY a JSON array of strings.`;

/** Prompt for one frame. `refs` = number of reference images sent before/after the previous frame. */
export function framePrompt(scene: string, index: number, opts: { refs: number; chainFrom: "first" | "last"; style?: string }): string {
  const s = scene.trim().replace(/[.\s]+$/, "");
  const style = opts.style?.trim() ? ` Style: ${opts.style.trim().replace(/[.\s]+$/, "")}.` : "";
  if (index === 0) {
    const refs = opts.refs ? ` Use the reference image${opts.refs > 1 ? "s" : ""} for the characters and look.` : "";
    return `Frame 1 of a storyboard: ${s}.${refs}${style} Cinematic still, consistent production design.`;
  }
  if (opts.chainFrom === "first") return `Next Scene: ${s}.${style}`;
  const prev = opts.refs + 1;
  return `Next frame of the same storyboard: ${s}. Image ${prev} is the previous frame — continue from it with the same characters, faces, wardrobe, props, location style, lighting and color grade, like consecutive shots of one film.${style}`;
}

// ---------------------------------------------------------------------------
// The board's frames (the server creates them, one waiting on the one before)

export interface StoryboardLook {
  id: string;
  /** The look in words (soulLook(id).look), carried into every next frame's prompt. */
  words: string;
  /** The look's strength (scales its LoRAs on frame 1). */
  strength?: number;
}

export interface StoryboardPlanInput {
  engine: Engine;
  /** A partner model for the whole board (cloud only). */
  partner?: StoryboardPartner;
  /** The next frames' model on your GPU (open only): Qwen-Image 2.1's Next-Scene LoRA unless "classic". */
  nextScene?: StoryboardNextScene;
  scenes: string[];
  references?: string[];
  style?: string;
  look?: StoryboardLook;
  aspectRatio?: string;
  resolution?: string;
  batchTitle?: string;
}

export type FrameRequest = GenerationRequest & { batchTitle?: string };

/**
 * Each frame's request, in order (frame 1 first). A frame after the first waits on the one before and takes its
 * picture as it came out (`raw`: before a look's grade, which every frame gets on its own).
 */
export function planStoryboard(input: StoryboardPlanInput): FrameRequest[] {
  const m = storyboardModels(input.engine, input.partner, input.nextScene);
  const refs = (input.references ?? []).slice(0, 4);
  const look = input.look;
  const cropped = !!look && input.aspectRatio === LOOK_CROPPED;
  const params = { aspectRatio: cropped ? "16:9" : input.aspectRatio, resolution: input.resolution, numOutputs: 1 };
  const lookWords = look?.words.trim().replace(/[.\s]+$/, "");
  // The next frames keep the look in words; frame 1 on Fuobe Soul gets them from its recipe.
  const style = [input.style?.trim().replace(/[.\s]+$/, ""), lookWords].filter(Boolean).join(". ") || undefined;
  return input.scenes.map((scene, i) => {
    const first = i === 0;
    // The open next-scene workflow takes the previous panel plus one character reference.
    const frameRefs = first ? refs : m.chainFrom === "first" ? refs.slice(0, 1) : refs;
    const onSoul = first && !!look && !refs.length;
    // A look board's next frame takes the previous picture as it came out (raw); otherwise the single-image chainFrom.
    const chain: ChainSlot[] | undefined = first || !look ? undefined : [{ slot: "images", position: m.chainFrom, raw: true }];
    return {
      feature: "storyboard",
      modelId: onSoul ? STORYBOARD_LOOK_MODEL : first ? (refs.length ? m.firstWithRefs : m.first) : m.next,
      ...(onSoul && { engine: input.engine, presetId: look.id, ...(look.strength !== undefined && { presetStrength: look.strength }) }),
      prompt: framePrompt(scene, i, { refs: frameRefs.length, chainFrom: m.chainFrom, style: onSoul ? input.style : style }),
      inputs: frameRefs.length ? { images: frameRefs } : undefined,
      params,
      ...(!first && m.nextLoras?.length && { loras: m.nextLoras }),
      ...(chain ? { chain } : !first && { chainFrom: m.chainFrom }),
      frame: { scene, index: i, of: input.scenes.length, ...(look && { look: look.id }), ...(cropped && { crop: LOOK_CROPPED }) },
      ...(input.batchTitle && { batchTitle: input.batchTitle }),
    };
  });
}

// ---------------------------------------------------------------------------
// One sheet (research new-models-7.md §4.10): the whole board as one page on MOSS-Image, one layout box per panel with its
// shot, then cropped into frames in the browser. Every panel is drawn in one pass, so the cast, wardrobe and light match.

/** The model a one-sheet board is drawn on: MOSS-Image on your GPU, and the same model hosted on fal. */
export const SHEET_MODELS: Record<Engine, string> = { open: "oss-moss-image", cloud: "moss-image" };

/** Sheet shapes both MOSS-Image halves take (the open graph's and fal's aspect ratios). */
export const SHEET_ASPECTS = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9", "5:4", "4:5"] as const;

/** The gap between panels and around them, as a share of the sheet's height. */
export const SHEET_GUTTER = 0.03;

/**
 * What a render on a GPU showed about one-sheet boards (how many panels still read as consistent frames). Until one is
 * recorded the option is the owner's alone, said to be untested; once it is, everyone gets it up to that many panels.
 */
export interface SheetTest {
  /** The day it was rendered (YYYY-MM-DD). */
  date: string;
  /** The card it ran on ("RTX 4090 24 GB"). */
  gpu: string;
  /** The most panels that still came out usable. */
  maxPanels: number;
}
export const ONE_SHEET_GPU_TEST: SheetTest | null = { date: "2026-11-05", gpu: "RTX 5090 32 GB", maxPanels: 8 };

/** How many panels a one-sheet board may have for this viewer: 0 hides the option. */
export function sheetPanelLimit(owner: boolean, test: SheetTest | null = ONE_SHEET_GPU_TEST): number {
  if (test) return Math.max(0, Math.min(MAX_FRAMES, test.maxPanels));
  return owner ? MAX_FRAMES : 0;
}

/** Where a sheet is, in the board's header: one generation draws every panel, so it is done, failed or still coming. */
export function sheetState(status: GenerationStatus): string {
  if (status === "succeeded") return "done";
  if (status === "failed") return "failed";
  if (status === "canceled") return "cancelled";
  return "on the way";
}

/** A box on the sheet: [x0, y0, x1, y1] as 0-1 fractions, from its top-left corner (a layout box). */
export type SheetBox = [number, number, number, number];

export interface SheetGrid {
  cols: number;
  rows: number;
  /** The sheet's aspect ratio, one of {@link SHEET_ASPECTS}. */
  aspect: string;
  /** Each panel's box, in reading order. */
  boxes: SheetBox[];
}

const ratio = (a: string): number => {
  const [w, h] = a.split(":").map(Number);
  return w > 0 && h > 0 ? w / h : 1;
};
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * The grid of n panels of `panelAspect` on a sheet: the columns, rows and sheet shape that give the panels the most of the
 * sheet (so each is drawn as large as it can be), then the fewest empty cells. Panels sit in their cells at their own shape,
 * gutters between them; a short last row is centred.
 */
export function sheetGrid(n: number, panelAspect: string, aspects: readonly string[] = SHEET_ASPECTS): SheetGrid {
  const count = Math.max(1, Math.min(MAX_FRAMES, Math.floor(n)));
  const a = ratio(panelAspect);
  const g = SHEET_GUTTER;
  let best: { cols: number; rows: number; aspect: string; pw: number; ph: number; s: number; score: number; empty: number } | undefined;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    for (const aspect of aspects) {
      const s = ratio(aspect);
      // A sheet s wide and 1 high: each cell after the gutters, the panel at its shape inside it.
      const cw = (s - g * (cols + 1)) / cols;
      const ch = (1 - g * (rows + 1)) / rows;
      if (cw <= 0 || ch <= 0) continue;
      const pw = Math.min(cw, ch * a);
      const ph = pw / a;
      const score = r6((count * pw * ph) / s);
      const empty = cols * rows - count;
      if (!best || score > best.score || (score === best.score && empty < best.empty)) best = { cols, rows, aspect, pw, ph, s, score, empty };
    }
  }
  const { cols, rows, aspect, pw, ph, s } = best!;
  const cw = (s - g * (cols + 1)) / cols;
  const ch = (1 - g * (rows + 1)) / rows;
  const boxes: SheetBox[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? count - row * cols : cols;
    const col = i % cols;
    // A short last row moves right by half the cells it leaves empty.
    const shift = ((cols - inRow) * (cw + g)) / 2;
    const x0 = g + col * (cw + g) + (cw - pw) / 2 + shift;
    const y0 = g + row * (ch + g) + (ch - ph) / 2;
    boxes.push([r6(x0 / s), r6(y0), r6((x0 + pw) / s), r6(y0 + ph)]);
  }
  return { cols, rows, aspect, boxes };
}

/** A panel's crop of the sheet as it came out: [x, y, w, h] in whole pixels, inside the box (no gutter), on the image. */
export function sheetCrop(box: SheetBox, width: number, height: number): [number, number, number, number] {
  const x0 = Math.max(0, Math.ceil(r6(box[0] * width)));
  const y0 = Math.max(0, Math.ceil(r6(box[1] * height)));
  const x1 = Math.min(width, Math.floor(r6(box[2] * width)));
  const y1 = Math.min(height, Math.floor(r6(box[3] * height)));
  return [x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)];
}

/** Every panel's crop of the sheet. */
export const sheetCrops = (boxes: SheetBox[], width: number, height: number) => boxes.map((b) => sheetCrop(b, width, height));

/**
 * A panel shown from the sheet without cutting it out (a tile's background): the image scaled so the panel fills the tile,
 * and moved so the panel is in view, as CSS background-size and background-position percentages.
 */
export function sheetPanelStyle(box: SheetBox): { backgroundSize: string; backgroundPosition: string } {
  const w = box[2] - box[0];
  const h = box[3] - box[1];
  const pos = (start: number, span: number) => (span >= 1 ? 0 : r6((start / (1 - span)) * 100));
  return { backgroundSize: `${r6(100 / w)}% ${r6(100 / h)}%`, backgroundPosition: `${pos(box[0], w)}% ${pos(box[1], h)}%` };
}

/** What a one-sheet board keeps on its one picture (request.frame.sheet): the panels, their shots and boxes. */
export interface SheetFrames {
  cols: number;
  rows: number;
  /** The shape of each panel ("16:9"). */
  aspect: string;
  panels: { scene: string; box: SheetBox }[];
}

const SHEET_META = ["storyboard", "film stills", "multi-panel sheet"];

/** The sheet's whole-picture caption: one film, the same cast and light, gutters between panels. */
export function sheetCaption(n: number, grid: Pick<SheetGrid, "cols" | "rows">, style?: string): string {
  const look = style?.trim() ? ` Style: ${style.trim().replace(/[.\s]+$/, "")}.` : "";
  return `A storyboard sheet of ${n} cinematic panels in a ${grid.cols} by ${grid.rows} grid, read left to right and top to bottom: consecutive shots of one film with the same characters, faces, wardrobe, props, location and lighting in every panel. Plain white gutters between the panels, no captions, numbers or borders drawn.${look}`;
}

/**
 * A one-sheet board's single request: MOSS-Image with a multi-panel layout (one object box per panel with its shot), the
 * sheet shaped so the panels are as large as they can be. The layout goes as params.extra.layout, which the plan compiles
 * at the size the model renders and keeps from being rewritten; the panels go in request.frame.sheet for the crop.
 */
export function planOneSheet(input: Omit<StoryboardPlanInput, "partner" | "nextScene" | "look">, test: SheetTest | null = ONE_SHEET_GPU_TEST): FrameRequest {
  // The most panels a sheet may have: the owner's whole board until a GPU render is recorded, then what that render showed.
  const limit = sheetPanelLimit(true, test);
  if (!limit) throw new Error("One sheet isn't available yet: make the board frame by frame");
  const scenes = input.scenes.map((s) => s.trim()).filter(Boolean).slice(0, MAX_FRAMES);
  if (scenes.length > limit) throw new Error(`A one-sheet board has at most ${limit} panels: remove some scenes, or make it frame by frame`);
  if (!scenes.length) throw new Error("Describe the story or write at least one scene");
  if (input.references?.length) throw new Error("A one-sheet board is drawn from your words alone: remove the references, or make it frame by frame");
  const panelAspect = input.aspectRatio && input.aspectRatio !== "auto" ? input.aspectRatio : "16:9";
  const grid = sheetGrid(scenes.length, panelAspect);
  const caption = sheetCaption(scenes.length, grid, input.style);
  const draft: LayoutDraft = {
    summary: { caption, meta: SHEET_META, canvas: "multi_panel" },
    items: scenes.map((scene, i) => ({ label: "object", caption: `Panel ${i + 1}, ${scene.replace(/[.\s]+$/, "")}.`, box: grid.boxes[i] })),
    aspect: grid.aspect,
  };
  const sheet: SheetFrames = { cols: grid.cols, rows: grid.rows, aspect: panelAspect, panels: scenes.map((scene, i) => ({ scene, box: grid.boxes[i] })) };
  return {
    feature: "storyboard",
    modelId: SHEET_MODELS[input.engine],
    prompt: caption,
    params: { aspectRatio: grid.aspect, ...(input.resolution && { resolution: input.resolution }), numOutputs: 1, extra: { [LAYOUT_PARAM]: draft } },
    frame: { scene: scenes[0], index: 0, of: 1, sheet },
    ...(input.batchTitle && { batchTitle: input.batchTitle }),
  };
}
