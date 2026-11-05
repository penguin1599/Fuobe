/**
 * Canvas (Higgsfield Canvas parity): node-graph workflows. A canvas is a board of nodes wired
 * with typed edges (text, image, video, audio, element). Generator nodes (any catalog model,
 * plus utilities such as Join clips or Upscale) become generations; edges become chained
 * inputs (`dependsOn` + `request.chain`), which the runner already resolves.
 *
 * Everything here is pure (no server, no DOM) so the editor (live validation, ports, cost) and
 * the server (POST /api/canvases/:id/run) plan a graph exactly the same way.
 */
import type { CanvasComment, CanvasGroup, CanvasPage, CanvasShape } from "./canvas-board";
import { EXAMPLE_SCENE, EXAMPLE_WORDS, beatsFrom, blockoutFramePrompt, compileBlockoutPrompt, type BlockoutRef } from "@/lib/blockout";
import { QMA_MODEL } from "@/lib/qma";
import type { TemplateSectionKey } from "@/lib/canvas-sections";
import { CLOUD_SPLIT_PROBLEM, SPLIT_MODEL } from "@/lib/av/split";
import { getModel, getPreset, MODELS, supportsOp } from "./index";
import { dualEngine, onEngine, runsOn } from "./engines";
import { chainedWaitMessage, keyframeChain } from "./keyframes";
import { isSpeed, keyTimes, timingFor, timingProblem, type GapTiming, type InbetweenTiming } from "@/lib/inbetween";
import { estimateCost, inferOperation, planGeneration, routesFor, type Plan } from "./plan";
import { replacedBy, replacementOf } from "./replaced";
import { REGEN_COPY, REGEN_MODEL } from "./regenerate";
import { RTX_UPSCALE_MODEL } from "./rtx-video";
import { compileWords, LAYOUT_PARAM, readLayout, type LayoutDraft } from "@/lib/layout-prompt";
import { fillLayout, layoutPlaceholders } from "@/lib/layout-surfaces";
import { FLY_MODELS, flyKeys, planFlyAround } from "./fly-around";
import type { CameraKey } from "@/lib/camera-path";
import type { ExactOrbit } from "@/lib/exact-orbit";
import type { Recipe } from "@/lib/motion/recipe";
import { CLIP_SCENES as KINETIC_CLIP_SCENES } from "@/lib/motion/kinetic-groups";
import {
  OPERATION_LABELS,
  OPERATION_OUTPUT,
  type ChainSlot,
  type Engine,
  type GenerationRequest,
  type GenerationStatus,
  type GenParams,
  type MediaKind,
  type ModelDef,
  type Operation,
} from "./types";

/** Upscale node entries fixed to an open model nobody hosts (Open-H3 Regenerate, NVIDIA RTX Video): no cloud stand-in. */
const GPU_ONLY_FIXED = new Set([REGEN_MODEL, RTX_UPSCALE_MODEL]);

// ---------------------------------------------------------------------------
// Graph types (stored as JSON in the canvases table)

/** What travels along an edge. A voice is an audio sample to speak with (Clone Voice). */
export type PortType = "text" | "image" | "video" | "audio" | "element" | "voice" | "path";

export const PORT_TYPE_LABEL: Record<PortType, string> = {
  text: "Text",
  image: "Image",
  video: "Video",
  audio: "Audio",
  element: "Element",
  voice: "Voice",
  path: "Camera path",
};

export type CanvasNodeType =
  | "prompt"
  | "image-input"
  | "video-input"
  | "audio-input"
  | "element"
  | "model"
  | "join"
  | "frame"
  | "upscale"
  | "bg-remove"
  | "tts"
  | "voice-change"
  | "clean-voice"
  | "split-soundtrack"
  | "clone-voice"
  | "translate"
  | "concat"
  | "restore"
  | "table"
  | "layout"
  | "camera-path"
  | "fly-around"
  | "kinetic"
  | "output"
  | "note";

/** Video Concatenator: one clip's cut and sound. Start and end are seconds of the clip; length and size are what the editor measured. */
export interface ClipSettings {
  start?: number;
  end?: number;
  mute?: boolean;
  /** The clip's own length, size and whether it has sound (read from its file; undefined = not known yet). */
  length?: number;
  width?: number;
  height?: number;
  audio?: boolean;
}

/** One flat shape for every node type (React Flow wants `data` to be a plain record). */
export interface CanvasNodeData {
  [key: string]: unknown;
  /** User-facing title (defaults to the node type's label). */
  label?: string;
  /** Text prompt and sticky note content. */
  text?: string;
  /** Image / video / audio inputs: an /api/files URL (upload or library pick). */
  url?: string;
  name?: string;
  /** Element node: the @character / location / prop / style it adds. */
  elementId?: string;
  handle?: string;
  preview?: string;
  /** Generator nodes. `op` undefined = worked out from what's connected. */
  modelId?: string;
  /** A Fuobe Original (runs on both engines, ModelDef.engines): the engine this node runs it on. */
  engine?: Engine;
  op?: Operation;
  prompt?: string;
  params?: GenParams;
  /** Keep the current result: never re-run this node, downstream nodes use its output as is. */
  pinned?: boolean;
  /** Model node: the kind it was added as (filters the model list). Upscale / Remove background: image or video. Translate: text or video. */
  mediaKind?: MediaKind;
  /** Video Concatenator: each clip's cut and sound, by the node it comes from. */
  clips?: Record<string, ClipSettings>;
  /** Video Concatenator: the clips' order (node ids); clips not listed follow in board order. */
  order?: string[];
  /** Table: its column names, and its rows of cells (one per column). */
  columns?: string[];
  rows?: string[][];
  /** Translate (video) on the open engine: the Translate & dub session it started (its result comes back from there). */
  dubId?: string;
  /** Layout: its boxes, one row per box (src/lib/layout-prompt.ts), drawn in the Layout editor. */
  layout?: LayoutDraft;
  /** Camera path: a preset (camera-path PATH_PRESETS), an exact orbit's numbers, or keys; the first set wins. */
  pathPreset?: string;
  orbit?: ExactOrbit;
  keys?: CameraKey[];
  /** Fly around: the clip's length in seconds (the cloud; your GPU always films about 5 s). */
  duration?: number;
  /** Kinetic: the scene and its settings, as a Kinetic Motion recipe (its words come from the Text input per row). */
  kinetic?: Recipe;
}

export interface CanvasNode {
  id: string;
  type: CanvasNodeType;
  position: { x: number; y: number };
  data: CanvasNodeData;
  /** Resized nodes (sticky notes, output previews). */
  width?: number;
  height?: number;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface CanvasGraph {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport?: { x: number; y: number; zoom: number };
  /** Frames around nodes, comment pins and drawings (src/lib/catalog/canvas-board.ts): not run. */
  groups?: CanvasGroup[];
  comments?: CanvasComment[];
  shapes?: CanvasShape[];
}

/** What a generator node last ran as: its signature (inputs + settings) and its generations. */
export interface NodeRun {
  sig: string;
  ids: string[];
  at: number;
  /** A node made in several steps (Video Concatenator): the generation holding its result. Default: the first id. */
  out?: string;
  /** A node run once per row of a table: each row's generation, in row order (what a row of the next node takes). */
  rows?: string[];
  /** Each row's own signature (rowSignature): a row whose inputs didn't change and whose result is live is kept. */
  rowSigs?: string[];
}

/** The generation a node's result (and what it passes on) is in. */
export const runOutput = (r: NodeRun): string => r.out ?? r.ids[0];

export type CanvasRuns = Record<string, NodeRun>;

export interface Canvas {
  id: string;
  name: string;
  /** Its pages, each a board of its own (one for a canvas saved before pages). */
  pages: CanvasPage[];
  runs: CanvasRuns;
  templateId: string | null;
  createdAt: number;
  updatedAt: number;
  /** null until the user changes the board ("Never edited"). */
  editedAt: number | null;
}

/** A node's box on the list page's schematic preview. */
export interface OutlineBox {
  x: number;
  y: number;
  type: CanvasNodeType;
  /** The node's own label, short (a template page's diagram names its steps). */
  label?: string;
}

/** The board in miniature: node boxes and the edges between them (as indexes into `boxes`). */
export interface Outline {
  boxes: OutlineBox[];
  links: [number, number][];
}

export interface CanvasSummary {
  id: string;
  name: string;
  nodeCount: number;
  pageCount: number;
  templateId: string | null;
  /** The newest finished image or video made on this canvas. */
  preview: { url: string; kind: MediaKind; poster?: string } | null;
  outline: Outline;
  createdAt: number;
  updatedAt: number;
  editedAt: number | null;
}

export const EMPTY_GRAPH: CanvasGraph = { nodes: [], edges: [] };

/** Longest text a prompt, script or note may hold (longer pastes are cut, never refused). */
export const CANVAS_TEXT_MAX = 10_000;

// ---------------------------------------------------------------------------
// Node registry

export type NodeGroup = "Inputs" | "Generate" | "Utilities" | "Output";

export interface NodeSpec {
  type: CanvasNodeType;
  label: string;
  group: NodeGroup;
  description: string;
  /** lucide icon name (mapped to a component in the editor). */
  icon: string;
  /** Generator nodes: the operations they run (empty = any operation of the chosen model). */
  ops?: Operation[];
  /** Two ops picked by what goes in: the first runs on the first kind (the default), the second on the second. */
  variants?: [MediaKind, MediaKind];
}

export const NODE_SPECS: Record<CanvasNodeType, NodeSpec> = {
  prompt: { type: "prompt", label: "Text prompt", group: "Inputs", icon: "Type", description: "Words that feed the prompt of the nodes it connects to" },
  "image-input": { type: "image-input", label: "Image", group: "Inputs", icon: "ImageIcon", description: "Upload an image or pick one from your library" },
  "video-input": { type: "video-input", label: "Video", group: "Inputs", icon: "Film", description: "Upload a clip or pick one from your library" },
  "audio-input": { type: "audio-input", label: "Audio", group: "Inputs", icon: "AudioLines", description: "A voice sample, music or any sound" },
  element: { type: "element", label: "Element", group: "Inputs", icon: "AtSign", description: "An @character, location, prop or style from Elements" },
  model: { type: "model", label: "Model", group: "Generate", icon: "Sparkles", ops: [], description: "Any model in the catalog — image, video, audio or text" },
  join: { type: "join", label: "Join clips", group: "Utilities", icon: "Combine", ops: ["concat"], description: "Stitch clips into one video, in order (top to bottom)" },
  frame: { type: "frame", label: "Extract frame", group: "Utilities", icon: "Frame", ops: ["frame"], description: "The last frame of a video, as an image" },
  upscale: { type: "upscale", label: "Upscale", group: "Utilities", icon: "ZoomIn", ops: ["upscale-image", "upscale-video"], variants: ["image", "video"], description: "Sharper, larger images or videos" },
  "bg-remove": { type: "bg-remove", label: "Remove background", group: "Utilities", icon: "Eraser", ops: ["bg-remove", "bg-remove-video"], variants: ["image", "video"], description: "Cut out the subject of an image or video" },
  tts: { type: "tts", label: "Text to speech", group: "Utilities", icon: "Mic2", ops: ["tts"], description: "Speak a text, in a preset voice or a cloned one" },
  "voice-change": { type: "voice-change", label: "Change voice", group: "Utilities", icon: "AudioWaveform", ops: ["voice-change"], description: "Say a recording again in another voice, keeping its timing" },
  // NVIDIA RE-USE on the open engine only (nothing like it is hosted on fal or Replicate): hidden on a cloud-only install.
  "clean-voice": { type: "clean-voice", label: "Clean up voice", group: "Utilities", icon: "AudioLines", ops: ["enhance-voice"], description: "Remove noise, echo and room sound from speech" },
  // DBS on the open engine only (hosted nowhere): its four outputs wire each part of a soundtrack on (SPLIT_OUTPUTS).
  "split-soundtrack": { type: "split-soundtrack", label: "Split soundtrack", group: "Utilities", icon: "AudioWaveform", ops: ["separate-audio"], description: "Dialogue, music and effects of a soundtrack, each its own output" },
  "clone-voice": { type: "clone-voice", label: "Clone voice", group: "Inputs", icon: "UserRound", description: "A voice sample (or one of your saved voices) to speak with" },
  translate: { type: "translate", label: "Translate", group: "Utilities", icon: "Languages", ops: ["translate", "dub"], variants: ["text", "video"], description: "Translate a text, or dub a video into another language" },
  concat: { type: "concat", label: "Assemble film", group: "Utilities", icon: "Film", ops: ["concat"], description: "Up to 50 clips in one film: trim and mute each, pick the frame" },
  restore: { type: "restore", label: "Restore & colourise", group: "Utilities", icon: "Palette", ops: ["restore-video"], description: "Old or black-and-white footage, cleaned and in colour" },
  table: { type: "table", label: "Table", group: "Inputs", icon: "Table", description: "Rows of words: what it feeds runs once per row" },
  layout: { type: "layout", label: "Layout", group: "Inputs", icon: "LayoutDashboard", description: "Boxes for a headline, a product, a price: the image model draws each in its place" },
  "camera-path": { type: "camera-path", label: "Camera path", group: "Inputs", icon: "Orbit", description: "A move round the subject: a preset or an exact orbit" },
  "fly-around": { type: "fly-around", label: "Fly around", group: "Generate", icon: "Rotate3d", ops: ["camera-path"], description: "A still filmed along a camera path, with other views if you have them" },
  kinetic: { type: "kinetic", label: "Kinetic", group: "Generate", icon: "LetterText", description: "Your words as motion graphics in your brand, drawn in your browser" },
  output: { type: "output", label: "Output", group: "Output", icon: "MonitorPlay", description: "Preview what's connected, side by side" },
  note: { type: "note", label: "Sticky note", group: "Output", icon: "StickyNote", description: "A note on the board (not run)" },
};

export const GENERATOR_TYPES = new Set<CanvasNodeType>(["model", "join", "frame", "upscale", "bg-remove", "tts", "voice-change", "clean-voice", "split-soundtrack", "translate", "concat", "restore", "fly-around"]);
export const isGenerator = (n: Pick<CanvasNode, "type">) => GENERATOR_TYPES.has(n.type);

/** Entries of the Add-node palette (several entries can make the same node type). */
export interface PaletteItem {
  id: string;
  type: CanvasNodeType;
  label: string;
  group: NodeGroup;
  description: string;
  icon: string;
  data?: CanvasNodeData;
  keywords?: string;
  /** Why it can't be added on this install (no model for it on the only engine allowed). */
  disabled?: string;
}

export const PALETTE: PaletteItem[] = [
  { ...pick("prompt"), id: "prompt", keywords: "text words script" },
  { ...pick("image-input"), id: "image-input", keywords: "upload photo picture library reference" },
  { ...pick("video-input"), id: "video-input", keywords: "upload clip footage library" },
  { ...pick("audio-input"), id: "audio-input", keywords: "upload voice sound music sample" },
  { ...pick("element"), id: "element", keywords: "character location prop style mention @" },
  { id: "model-image", type: "model", label: "Image model", group: "Generate", icon: "ImageIcon", description: "Text to image, or edit connected images", data: { mediaKind: "image" }, keywords: "generate picture edit t2i" },
  { id: "model-video", type: "model", label: "Video model", group: "Generate", icon: "Clapperboard", description: "Text or image to video, start & end frames, references", data: { mediaKind: "video" }, keywords: "generate animate i2v t2v clip" },
  { id: "model-audio", type: "model", label: "Audio model", group: "Generate", icon: "AudioLines", description: "Speech, sound effects, music, voice change", data: { mediaKind: "audio" }, keywords: "sound music sfx voice" },
  { id: "model-text", type: "model", label: "Text model", group: "Generate", icon: "MessageSquareText", description: "Write or translate text with an LLM", data: { mediaKind: "text" }, keywords: "llm write script translate copy" },
  { id: "model-any", type: "model", label: "Any model", group: "Generate", icon: "Sparkles", description: "Pick any model from the catalog", keywords: "catalog" },
  { ...pick("join"), id: "join", keywords: "concat merge stitch film" },
  { ...pick("frame"), id: "frame", keywords: "still last frame screenshot" },
  { ...pick("upscale"), id: "upscale", data: { mediaKind: "image" }, keywords: "enhance resolution 4k sharpen" },
  // The Upscale node on Open-H3 Regenerate: a clip redrawn at 2K from its words, on your GPU only (nobody hosts it).
  {
    ...pick("upscale"),
    id: "upscale-regenerate",
    label: "Regenerate (creative)",
    description: "Redraws a soft clip at 1080p, 2K or 4K from its words: details may change, motion and layout stay (your GPU)",
    data: { mediaKind: "video", modelId: REGEN_MODEL },
    keywords: "regenerate redraw 2k 4k h3 creative upscale sharpen finish",
  },
  // The Upscale node on NVIDIA RTX Video Super Resolution: a fast upscale on an NVIDIA RTX card only (nobody hosts it).
  {
    ...pick("upscale"),
    id: "upscale-rtx",
    label: "Quick upscale (RTX)",
    description: "Fast upscale up to 4x on an NVIDIA RTX card: sharpens without adding new detail (your GPU)",
    data: { mediaKind: "video", modelId: RTX_UPSCALE_MODEL },
    keywords: "rtx nvidia quick fast upscale super resolution vsr sharpen 4k",
  },
  { ...pick("bg-remove"), id: "bg-remove", data: { mediaKind: "image" }, keywords: "cutout matte transparent" },
  { ...pick("tts"), id: "tts", keywords: "voice speech narration clone" },
  { ...pick("voice-change"), id: "voice-change", keywords: "voice changer speech to speech revoice convert" },
  { ...pick("clean-voice"), id: "clean-voice", keywords: "denoise enhance speech noise clean up voice echo reverb podcast" },
  { ...pick("split-soundtrack"), id: "split-soundtrack", keywords: "stems separate dialogue music effects remove voice isolate soundtrack dbs" },
  { ...pick("clone-voice"), id: "clone-voice", keywords: "voice sample clone my voice speaker" },
  { ...pick("translate"), id: "translate", data: { mediaKind: "text" }, keywords: "language translate dub localize subtitles" },
  { ...pick("concat"), id: "concat", keywords: "concatenate join merge stitch edit trim mute film assemble" },
  { ...pick("restore"), id: "restore", keywords: "restore colourise colorize archive old footage black and white film scan vhs" },
  { ...pick("table"), id: "table", data: { columns: ["Subject"], rows: [[""], [""], [""]] }, keywords: "rows batch spreadsheet list variations csv grid" },
  { ...pick("layout"), id: "layout", data: { layout: { summary: { caption: "", meta: [], canvas: "single" }, items: [], aspect: "1:1" } }, keywords: "layout boxes poster text placement composition headline price moss" },
  { ...pick("camera-path"), id: "camera-path", data: { pathPreset: "orbit_360" }, keywords: "orbit arc camera move path keyframes exact turnaround" },
  { ...pick("fly-around"), id: "fly-around", keywords: "orbit fly around turnaround camera path 360 spin product" },
  { ...pick("kinetic"), id: "kinetic", keywords: "motion text title animation brand kinetic" },
  { ...pick("output"), id: "output", keywords: "preview compare result" },
  { ...pick("note"), id: "note", keywords: "comment annotation" },
];

function pick(type: CanvasNodeType): Omit<PaletteItem, "id"> {
  const s = NODE_SPECS[type];
  return { type, label: s.label, group: s.group, description: s.description, icon: s.icon };
}

const paletteCache = new Map<string, PaletteItem[]>();

/** Why a GPU-only entry (Regenerate: nobody hosts its model) can't be added on a cloud board, or on a cloud-only install. */
export const GPU_ONLY_ENTRY = `${REGEN_COPY.gpuOnly}: switch the board to Open source`;
export const GPU_ONLY_INSTALL = `${REGEN_COPY.gpuOnly}: this install uses paid APIs only`;

/**
 * Palette entries whose models exist in this catalog (no text models until an LLM model is
 * installed). On an install locked to one engine, entries with no model there are disabled, with why. An entry fixed to
 * an open model nobody hosts (Regenerate) is disabled on the cloud engine too, with that reason.
 */
export function paletteItems(mode: "both" | "open" | "cloud" = "both", engine?: Engine): PaletteItem[] {
  const key = `${mode}:${engine ?? ""}`;
  const hit = paletteCache.get(key);
  if (hit) return hit;
  // Clean up voice has no cloud route: a cloud-only install doesn't offer it at all.
  const items = PALETTE.filter((p) => (p.id !== "model-text" || MODELS.some((m) => m.kind === "text" && !m.hidden)) && !(mode === "cloud" && p.id === "clean-voice")).map((p): PaletteItem => {
    const fixed = p.data?.modelId ? getModel(p.data.modelId) : undefined;
    if (fixed && !runsOn(fixed, "cloud") && (mode === "cloud" || engine === "cloud")) return { ...p, disabled: mode === "cloud" ? GPU_ONLY_INSTALL : GPU_ONLY_ENTRY };
    // Split soundtrack: DBS runs on the open engine only, and no other model stands in for it.
    if (p.type === "split-soundtrack" && (mode === "cloud" || engine === "cloud")) return { ...p, disabled: CLOUD_SPLIT_PROBLEM };
    if (mode === "both" || !isGenerator(p) || defaultModelForNode({ type: p.type, data: p.data ?? {} }, mode)) return p;
    return { ...p, disabled: `No ${mode === "open" ? "open-source" : "cloud"} model for ${p.label.toLowerCase()} yet` };
  });
  paletteCache.set(key, items);
  return items;
}

export function nodeLabel(n: Pick<CanvasNode, "type" | "data">): string {
  const custom = n.data.label?.trim();
  if (custom) return custom;
  if (n.type === "model") {
    const m = n.data.modelId ? getModel(n.data.modelId) : undefined;
    if (m) return m.name;
    const k = n.data.mediaKind;
    return k ? `${k[0].toUpperCase()}${k.slice(1)} model` : "Model";
  }
  return NODE_SPECS[n.type]?.label ?? n.type;
}

// ---------------------------------------------------------------------------
// Models for generator nodes

/**
 * Ops the canvas can't feed (masks, browser-only tools, multi-speaker scripts, draft finishing, and
 * inputs it has no port for: a 3D model to rig or retexture, a list of audio clips to join, the two points of an
 * inserted moment).
 */
const UNSUPPORTED_OPS = new Set<Operation>(["grade", "inpaint", "finalize", "dialogue", "rig-3d", "retexture-3d", "audio-join", "composite", "insert-moment"]);

/**
 * Models that only run on a painted mask or clicked points (VACE inpaint, Bria's point eraser), or on a light picked on a
 * sphere (H3 Max relight): the canvas has none of these.
 */
const needsMarks = (m: ModelDef) => !!(m.options.requires?.mask || m.options.requires?.points || m.options.lightSphere);

/** Preferred defaults; anything missing falls back to the first catalog model for that op and engine. */
const PREFERRED: Partial<Record<Operation, Partial<Record<Engine, string>>>> = {
  t2i: { cloud: "nano-banana-pro", open: "oss-ideogram-4" },
  edit: { cloud: "nano-banana-pro", open: "oss-qwen-image-21" },
  t2v: { cloud: "minimax-h3", open: "oss-minimax-h3" },
  i2v: { cloud: "minimax-h3", open: "oss-minimax-h3" },
  flf2v: { cloud: "minimax-h3", open: "oss-minimax-h3" },
  ref2v: { cloud: "seedance-2-5", open: "oss-wan-vace" },
  avatar: { cloud: "kling-avatar-2", open: "oss-infinitetalk" },
  lipsync: { cloud: "sync-lipsync-3" },
  tts: { cloud: "elevenlabs-v4", open: "oss-chatterbox" },
  "voice-change": { cloud: "elevenlabs-voice-changer", open: "oss-chatterbox-vc" },
  "enhance-voice": { open: "oss-reuse-voice" },
  dub: { cloud: "elevenlabs-dubbing" },
  music: { cloud: "elevenlabs-music", open: "oss-ace-step" },
  sfx: { cloud: "elevenlabs-sfx" },
  concat: { cloud: "join-clips", open: "oss-join-clips" },
  frame: { cloud: "extract-frame" },
  "upscale-image": { cloud: "topaz-image", open: "oss-seedvr2-image" },
  "upscale-video": { cloud: "topaz-video", open: "oss-seedvr2" },
  "restore-video": { cloud: "fuobe-restore", open: "fuobe-restore" },
  "bg-remove": { cloud: "birefnet-cloud", open: "oss-rmbg" },
  "bg-remove-video": { cloud: "birefnet-video", open: "oss-video-matte-birefnet" },
  write: { cloud: "text-llm", open: "oss-text-llm" },
  translate: { cloud: "text-llm", open: "oss-text-llm" },
};

/** The ops a generator node may run: fixed for utilities (by image/video choice), the model's own for Model nodes. */
export function nodeOps(n: Pick<CanvasNode, "type" | "data">, model?: ModelDef): Operation[] {
  const spec = NODE_SPECS[n.type];
  if (!spec?.ops) return [];
  if (spec.ops.length) {
    if (spec.ops.length === 1 || !spec.variants) return spec.ops.slice(0, 1);
    // Upscale / Remove background (image or video), Translate (text or video).
    return [spec.ops[n.data.mediaKind === spec.variants[1] ? 1 : 0]];
  }
  if (!model) return [];
  return [...new Set(model.routes.map((r) => r.op))].filter((op) => !UNSUPPORTED_OPS.has(op));
}

/**
 * Video Concatenator (Higgsfield's video_assemble): up to 50 clips, each trimmed and muted on its own, framed
 * to one of 8 aspect ratios at 30 fps. Clips over 512 MB are refused. The node's model names its engine: the
 * cloud cuts with trim-video, frames with scale-video, mutes with a −70 dB level and joins with merge-videos;
 * the open engine cuts, frames, retimes and mutes each clip in one CPU step (video-fit-clip) and joins them
 * packet by packet (video-concat-encoded).
 */
export const CONCAT_LIMITS = { clips: 50, fps: 30, maxBytes: 512 * 1024 * 1024, cloudJoin: 24 } as const;
export const CONCAT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "21:9"] as const;
export type ConcatRatio = (typeof CONCAT_RATIOS)[number];
/** The film's size per ratio (720 on the short side, 1280×720 by default; even, within merge-videos' 512–2048). */
export const CONCAT_SIZE: Record<ConcatRatio, { width: number; height: number }> = {
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
  "1:1": { width: 960, height: 960 },
  "4:3": { width: 960, height: 720 },
  "3:4": { width: 720, height: 960 },
  "3:2": { width: 1080, height: 720 },
  "2:3": { width: 720, height: 1080 },
  "21:9": { width: 1680, height: 720 },
};
export const CONCAT_MODELS: Record<Engine, string> = { cloud: "join-clips", open: "oss-join-encoded" };
/** The steps of a concatenation, per engine. */
export const CONCAT_TOOLS = {
  cloud: { trim: "trim-video", fit: "scale-video", sound: "extract-soundtrack", level: "ffmpeg-loudnorm", mux: "merge-audio-video", join: "join-clips" },
  open: { fit: "oss-fit-clip", join: "oss-join-encoded" },
} as const;

/** The default model for an op on an engine (utilities may use hidden models, e.g. Extract frame). */
export function defaultModelFor(op: Operation, engine: Engine, opts: { hidden?: boolean } = {}): ModelDef | undefined {
  const preferred = PREFERRED[op]?.[engine];
  const m = preferred ? getModel(preferred) : undefined;
  // A Fuobe Original runs on both engines, so it is the default on either.
  if (m && runsOn(m, engine) && supportsOp(m, op)) return m;
  return MODELS.find((x) => x.engine === engine && (opts.hidden || !x.hidden) && supportsOp(x, op));
}

const KIND_OP: Record<MediaKind, Operation> = { image: "t2i", video: "t2v", audio: "tts", text: "write", model3d: "image-to-3d" };

/** The model a new generator node starts with. */
export function defaultModelForNode(n: Pick<CanvasNode, "type" | "data">, engine: Engine): ModelDef | undefined {
  if (n.type === "concat") return getModel(CONCAT_MODELS[engine]);
  if (n.type === "fly-around") return getModel(FLY_MODELS[engine]);
  if (n.type === "model") {
    const kind = n.data.mediaKind ?? "image";
    return defaultModelFor(n.data.op ?? KIND_OP[kind], engine) ?? MODELS.find((m) => m.engine === engine && !m.hidden && m.kind === kind);
  }
  // Clean up voice is RE-USE, on your GPU only: the hosted cleaners (VEED, DeepFilterNet 3: Clean up dialogue's cloud
  // engine) share its op but are other tools, so the node doesn't take one of them on the cloud.
  if (n.type === "clean-voice" && engine === "cloud") return undefined;
  // Split soundtrack runs DBS, on the open engine only (never Demucs or a cloud isolation in its place).
  if (n.type === "split-soundtrack") return engine === "open" ? getModel(SPLIT_MODEL) : undefined;
  const op = nodeOps(n)[0];
  // The Upscale node's Regenerate choice starts on Open-H3 Regenerate (on the cloud the entry is disabled: paletteItems).
  const fixed = n.data.modelId && GPU_ONLY_FIXED.has(n.data.modelId) ? getModel(n.data.modelId) : undefined;
  if (fixed && op && supportsOp(fixed, op) && runsOn(fixed, engine)) return fixed;
  return op ? defaultModelFor(op, engine, { hidden: true }) : undefined;
}

/**
 * The engine a node runs its model on: the model's own, or for a Fuobe Original (both engines) the install's only
 * engine, else the node's pick, else the model's first (the open engine: free).
 */
export function nodeEngine(n: Pick<CanvasNode, "data">, m: ModelDef, mode: "both" | Engine = "both"): Engine {
  if (!dualEngine(m)) return m.engine;
  if (mode !== "both" && runsOn(m, mode)) return mode;
  return n.data.engine && runsOn(m, n.data.engine) ? n.data.engine : m.engine;
}

/** A node's model as it runs: a Fuobe Original keeps its engine's routes and price (onEngine). */
export function nodeModel(n: Pick<CanvasNode, "data">, mode: "both" | Engine = "both"): ModelDef | undefined {
  const m = n.data.modelId ? getModel(n.data.modelId) : undefined;
  return m && onEngine(m, nodeEngine(n, m, mode));
}

/** Models the node's picker offers. */
export function modelChoices(n: Pick<CanvasNode, "type" | "data">): ModelDef[] {
  if (n.type === "model") {
    const kind = n.data.mediaKind;
    return MODELS.filter((m) => !m.hidden && (!kind || m.kind === kind) && !needsMarks(m) && m.routes.some((r) => !UNSUPPORTED_OPS.has(r.op)));
  }
  if (n.type === "concat") return Object.values(CONCAT_MODELS).flatMap((id) => getModel(id) ?? []);
  if (n.type === "fly-around") return [FLY_MODELS.cloud, FLY_MODELS.open].flatMap((id) => getModel(id) ?? []);
  if (n.type === "split-soundtrack") return [getModel(SPLIT_MODEL)!];
  const ops = nodeOps(n);
  // Clean up voice offers only what runs on your GPU (RE-USE): the hosted cleaners share its op but are Clean up
  // dialogue's cloud engine (defaultModelForNode).
  const own = (m: ModelDef) => n.type !== "clean-voice" || runsOn(m, "open");
  return MODELS.filter((m) => ops.some((op) => supportsOp(m, op)) && (!m.hidden || ops.includes("frame")) && !needsMarks(m) && own(m));
}

// ---------------------------------------------------------------------------
// Ports

export type InputPortId = "prompt" | "elements" | "images" | "endImage" | "video" | "videos" | "audio" | "voice" | "path";

export interface PortDef {
  id: InputPortId;
  label: string;
  type: PortType;
  multiple: boolean;
}

/** Output handle id of every node that has one; the Output node's input handle id. */
export const OUT = "out";
export const PREVIEW_IN = "in";

/**
 * Split soundtrack's four output handles, each the stem it carries on (ChainSlot.stem). OUT, every other node's one output,
 * stands for Dialogue, so an edge saved before the node had four outputs keeps working.
 */
export const SPLIT_OUTPUTS: { id: "voice" | "music" | "effects" | "background"; label: string }[] = [
  { id: "voice", label: "Dialogue" },
  { id: "music", label: "Music" },
  { id: "effects", label: "Effects" },
  { id: "background", label: "Music & effects" },
];

/** The output handles a node has: Split soundtrack's four (and OUT, as Dialogue), else OUT. */
export function outputHandles(n: Pick<CanvasNode, "type">): string[] {
  return n.type === "split-soundtrack" ? [OUT, ...SPLIT_OUTPUTS.map((o) => o.id)] : [OUT];
}

/** The stem an edge out of a node carries (Split soundtrack: its handle's; OUT is Dialogue), or undefined. */
export function edgeStem(source: Pick<CanvasNode, "type"> | undefined, sourceHandle: string | null | undefined): string | undefined {
  if (source?.type !== "split-soundtrack") return undefined;
  return SPLIT_OUTPUTS.find((o) => o.id === sourceHandle)?.id ?? "voice";
}

/** "Music & effects": what an output handle is called ("" for a plain OUT). */
export function outputLabel(source: Pick<CanvasNode, "type"> | undefined, sourceHandle: string | null | undefined): string {
  const stem = edgeStem(source, sourceHandle);
  return stem ? SPLIT_OUTPUTS.find((o) => o.id === stem)!.label : "";
}

const INPUT_ORDER: InputPortId[] = ["prompt", "elements", "images", "endImage", "video", "videos", "audio", "voice", "path"];

/** Which inputs each operation reads. */
const OP_PORTS: Partial<Record<Operation, InputPortId[]>> = {
  t2i: ["prompt", "elements"],
  edit: ["prompt", "elements", "images"],
  outpaint: ["prompt", "images"],
  t2v: ["prompt", "elements"],
  i2v: ["prompt", "elements", "images"],
  flf2v: ["prompt", "images", "endImage"],
  ref2v: ["prompt", "elements", "images"],
  v2v: ["prompt", "elements", "video", "images"],
  lipsync: ["video", "audio"],
  avatar: ["prompt", "images", "audio"],
  "motion-transfer": ["prompt", "images", "video"],
  "upscale-image": ["images"],
  "upscale-video": ["video"],
  "bg-remove": ["images"],
  "face-swap": ["images"],
  tts: ["prompt", "voice"],
  sfx: ["prompt"],
  music: ["prompt"],
  v2a: ["prompt", "video"],
  interpolate: ["video"],
  extend: ["prompt", "video"],
  reframe: ["prompt", "video"],
  "voice-change": ["audio", "voice"],
  dub: ["video"],
  "bg-remove-video": ["video"],
  "depth-video": ["video"],
  "relight-video": ["prompt", "video", "images"],
  // The archive clip, the period words, and an optional first frame already in colour.
  "restore-video": ["prompt", "video", "images"],
  concat: ["videos"],
  frame: ["video"],
  "color-match": ["images", "video"],
  layers: ["images"],
  "text-layers": ["images"],
  trim: ["video"],
  transcribe: ["video", "audio"],
  captions: ["video"],
  mux: ["video", "audio"],
  "image-to-3d": ["images"],
  "separate-audio": ["audio", "video"],
  "enhance-voice": ["audio", "video"],
  translate: ["prompt"],
  write: ["prompt"],
  vectorize: ["images"],
  // round 4 (masks, clicked points and keyframe times are set outside the canvas)
  "remove-object": ["prompt", "video"],
  "video-swap": ["prompt", "elements", "video", "images"],
  "video-insert": ["prompt", "elements", "video", "images"],
  keyframes: ["prompt", "images"],
  "sdr-to-hdr": ["video"],
  "export-video": ["video"],
  ocr: ["images"],
  "still-motion": ["images"],
  "audio-loop": ["audio"],
  "scene-3d": ["images"],
  splat: ["images"],
  "text-to-3d": ["prompt"],
  "extract-frames": ["video"],
  "images-to-video": ["images"],
  overlay: ["images"],
};

/** Ops whose images list takes several images. */
const MULTI_IMAGE_OPS = new Set<Operation>(["edit", "ref2v", "face-swap", "color-match", "relight-video", "video-swap", "video-insert", "keyframes", "images-to-video", "overlay"]);

const TEXT_LABEL_OPS = new Set<Operation>(["tts", "translate", "write", "sfx", "music"]);

/** The input handles a generator node shows (the union over its ops when the op is automatic). */
export function inputPorts(n: Pick<CanvasNode, "type" | "data">): PortDef[] {
  // Clone voice: the sample can come from another node (a recording, a generated voice) instead of a file.
  if (n.type === "clone-voice") return [{ id: "audio", label: "Sample", type: "audio", multiple: false }];
  if (n.type === "output") return [];
  // Kinetic: words (a Table feeds one render per row), a picture (the product, else the logo) and a clip under the words.
  if (n.type === "kinetic")
    return [
      { id: "prompt", label: "Text", type: "text", multiple: true },
      { id: "images", label: "Picture", type: "image", multiple: false },
      { id: "video", label: "Clip", type: "video", multiple: false },
    ];
  // Fly around: the still (then any other views of the subject), the path, and motion words.
  if (n.type === "fly-around")
    return [
      { id: "prompt", label: "Motion words", type: "text", multiple: true },
      { id: "images", label: "Still, then views", type: "image", multiple: true },
      { id: "path", label: "Camera path", type: "path", multiple: false },
    ];
  if (!isGenerator(n)) return [];
  const model = n.data.modelId ? getModel(n.data.modelId) : undefined;
  const all = nodeOps(n, model);
  const fallback: Operation[] = n.type === "model" ? (n.data.mediaKind === "video" ? ["t2v", "i2v"] : n.data.mediaKind === "audio" ? ["tts"] : n.data.mediaKind === "text" ? ["write"] : ["t2i", "edit"]) : [];
  // On Auto, a keyframe film made clip by clip (the open chain) only runs when it's picked: Auto never infers it
  // without frame times, which the canvas doesn't set, so Wan's image port stays the start frame.
  const auto = all.filter((op) => !(op === "keyframes" && model && keyframeChain(model)));
  const ops = n.data.op && all.includes(n.data.op) ? [n.data.op] : auto.length ? auto : fallback;
  const ids = new Set(ops.flatMap((op) => OP_PORTS[op] ?? []));
  // Start & end frames: shown on image-to-video models that can take an end frame.
  if (ops.includes("i2v") && (model?.options.endFrame || (model && supportsOp(model, "flf2v")))) ids.add("endImage");
  // Reference clips: on reference-to-video models that take them (Seedance 2.5's @Video1, as Cinema's Blockout sends it).
  if (ops.includes("ref2v") && (model?.options.maxVideos ?? 0) > 0) ids.add("videos");
  // A cloned voice only where the model clones voices (Text to speech and Change voice always show it, and say
  // which models clone when a voice is connected to one that doesn't).
  if (ids.has("voice") && model && !model.options.voiceClone && n.type !== "tts" && n.type !== "voice-change") ids.delete("voice");
  // A model that redraws from words even where its operation takes none (Open-H3 Regenerate on the Upscale node).
  if (model?.options.requires?.prompt) ids.add("prompt");
  // A cut-out that reads optional words on what to keep or drop (Bria's guided cut-out on Remove background).
  if (model?.options.guided) ids.add("prompt");
  // Visual elements only on image and video models.
  if (ids.has("elements") && model && model.kind !== "image" && model.kind !== "video") ids.delete("elements");
  const maxImages = model?.options.maxImages ?? (ops.some((op) => MULTI_IMAGE_OPS.has(op)) ? 4 : 1);
  const multiImages = ops.some((op) => MULTI_IMAGE_OPS.has(op)) && maxImages > 1;
  const textLabel = ops.every((op) => TEXT_LABEL_OPS.has(op)) ? "Text" : "Prompt";
  const defs: Record<InputPortId, PortDef> = {
    prompt: { id: "prompt", label: textLabel, type: "text", multiple: true },
    elements: { id: "elements", label: "Elements", type: "element", multiple: true },
    images: { id: "images", label: multiImages ? "Images" : ops.includes("i2v") || ops.includes("flf2v") ? "Start frame" : "Image", type: "image", multiple: multiImages },
    endImage: { id: "endImage", label: "End frame", type: "image", multiple: false },
    video: { id: "video", label: "Video", type: "video", multiple: false },
    videos: { id: "videos", label: "Clips", type: "video", multiple: true },
    audio: { id: "audio", label: "Audio", type: "audio", multiple: false },
    voice: { id: "voice", label: "Voice", type: "voice", multiple: false },
    path: { id: "path", label: "Camera path", type: "path", multiple: false },
  };
  return INPUT_ORDER.filter((id) => ids.has(id)).map((id) => defs[id]);
}

const MEDIA_INPUT_TYPE: Partial<Record<CanvasNodeType, PortType>> = { "image-input": "image", "video-input": "video", "audio-input": "audio" };

const toPortType = (k: MediaKind | undefined): PortType | null => (k === "image" || k === "video" || k === "audio" || k === "text" ? k : null);

/** The type of a node's output handle (null = no output handle). */
export function outputType(_graph: CanvasGraph, n: CanvasNode): PortType | null {
  if (n.type === "prompt" || n.type === "table" || n.type === "layout") return "text";
  if (n.type === "clone-voice") return "voice";
  if (n.type === "element") return "element";
  if (n.type === "camera-path") return "path";
  if (n.type === "fly-around" || n.type === "kinetic") return "video";
  if (MEDIA_INPUT_TYPE[n.type]) return MEDIA_INPUT_TYPE[n.type]!;
  if (!isGenerator(n)) return null;
  // Never inferred from the inputs (that would walk the whole upstream graph): a chosen or fixed op, else the model's kind.
  const model = n.data.modelId ? getModel(n.data.modelId) : undefined;
  const ops = nodeOps(n, model);
  const op = n.data.op && ops.includes(n.data.op) ? n.data.op : n.type !== "model" ? ops[0] : undefined;
  if (op) return toPortType(OPERATION_OUTPUT[op]);
  if (model) return toPortType(model.kind);
  if (n.type === "upscale" || n.type === "bg-remove") return n.data.mediaKind === "video" ? "video" : "image";
  if (n.type === "join" || n.type === "concat") return "video";
  if (n.type === "frame") return "image";
  if (n.type === "tts") return "audio";
  return toPortType(n.data.mediaKind ?? "image");
}

/** Which ports accept which types: a voice input also takes plain audio (a sample straight from a file or a model). */
export function acceptsType(port: PortDef | "preview", type: PortType): boolean {
  if (port === "preview") return type !== "element" && type !== "path";
  return port.type === type || (port.type === "voice" && type === "audio");
}

// ---------------------------------------------------------------------------
// Graph helpers

const byPosition = (a: CanvasNode, b: CanvasNode) => a.position.y - b.position.y || a.position.x - b.position.x;

export function nodeMap(graph: CanvasGraph): Map<string, CanvasNode> {
  return new Map(graph.nodes.map((n) => [n.id, n]));
}

export function incoming(graph: CanvasGraph, nodeId: string): CanvasEdge[] {
  return graph.edges.filter((e) => e.target === nodeId);
}

/** Every node upstream of these (not including them). */
export function ancestors(graph: CanvasGraph, ids: string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of graph.edges) {
      if (e.target === id && !out.has(e.source)) {
        out.add(e.source);
        stack.push(e.source);
      }
    }
  }
  return out;
}

export function descendants(graph: CanvasGraph, ids: string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of graph.edges) {
      if (e.source === id && !out.has(e.target)) {
        out.add(e.target);
        stack.push(e.target);
      }
    }
  }
  return out;
}

/**
 * Topological order (Kahn), ties broken left to right then top to bottom so steps read the way
 * the board does. Nodes on a loop can't be ordered: they come back in `cyclic`.
 */
export function topoOrder(graph: CanvasGraph): { order: string[]; cyclic: string[] } {
  const nodes = nodeMap(graph);
  const indeg = new Map(graph.nodes.map((n) => [n.id, 0]));
  const valid = graph.edges.filter((e) => nodes.has(e.source) && nodes.has(e.target) && e.source !== e.target);
  for (const e of valid) indeg.set(e.target, indeg.get(e.target)! + 1);
  const cmp = (a: string, b: string) => {
    const na = nodes.get(a)!;
    const nb = nodes.get(b)!;
    return na.position.x - nb.position.x || na.position.y - nb.position.y || a.localeCompare(b);
  };
  const ready = graph.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id).sort(cmp);
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    let added = false;
    for (const e of valid) {
      if (e.source !== id) continue;
      const d = indeg.get(e.target)! - 1;
      indeg.set(e.target, d);
      if (d === 0) {
        ready.push(e.target);
        added = true;
      }
    }
    if (added) ready.sort(cmp);
  }
  const done = new Set(order);
  const selfLoops = graph.edges.filter((e) => e.source === e.target).map((e) => e.source);
  const cyclic = [...new Set([...graph.nodes.filter((n) => !done.has(n.id)).map((n) => n.id), ...selfLoops])];
  return { order, cyclic };
}

export interface Connection {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

/** Why this edge can't be drawn, or null when it can. */
export function connectionError(graph: CanvasGraph, c: Connection): string | null {
  const nodes = nodeMap(graph);
  const s = nodes.get(c.source);
  const t = nodes.get(c.target);
  if (!s || !t) return "That node no longer exists";
  if (s.id === t.id) return "A node can't feed itself";
  const type = outputType(graph, s);
  if (!type || (c.sourceHandle && !outputHandles(s).includes(c.sourceHandle))) return `${nodeLabel(s)} has no output`;
  // Kinetic renders in the browser: its clips go to Output nodes only (for now).
  if (s.type === "kinetic" && t.type !== "output") return "Connect Kinetic to an Output node";
  if (t.type === "kinetic" && c.targetHandle === "video" && !KINETIC_CLIP_SCENES.includes(t.data.kinetic?.scene ?? "")) return "This scene doesn't take a clip";
  if (t.type === "output") {
    if (c.targetHandle && c.targetHandle !== PREVIEW_IN) return "Unknown input";
    if (!acceptsType("preview", type)) return "Elements go into a model's Elements input";
    if (s.type === "table") return "A table goes into a node's Text input: that node runs once per row";
  } else {
    const port = inputPorts(t).find((p) => p.id === c.targetHandle);
    if (!port) return `${nodeLabel(t)} has no ${c.targetHandle ?? ""} input`;
    if (!acceptsType(port, type)) return type === "voice" ? `A voice goes into a Voice input (Text to speech, Change voice)` : `${PORT_TYPE_LABEL[type]} can't go into ${port.label}`;
    if (t.type === "concat" && graph.edges.filter((e) => e.target === t.id && e.source !== s.id).length >= CONCAT_LIMITS.clips) return `Assemble film takes up to ${CONCAT_LIMITS.clips} clips`;
    // Rows from a table: one table per node, and Join clips can't take a clip per row (the concatenator can).
    if (graph.nodes.some((n) => n.type === "table")) {
      const withEdge: CanvasGraph = { ...graph, edges: [...graph.edges, { id: "", source: s.id, target: t.id, sourceHandle: OUT, targetHandle: c.targetHandle ?? null }] };
      const rows = rowsFeeding(withEdge, t);
      if (rows && "error" in rows) return rows.error;
      if (rows && t.type === "join") return "Join clips takes one clip per input. Assemble film joins a clip per row";
    }
  }
  if (ancestors(graph, [s.id]).has(t.id)) return "That would make a loop";
  return null;
}

/** True when this target handle takes only one edge (a new edge replaces the old one). */
export function singleInput(graph: CanvasGraph, target: string, targetHandle?: string | null): boolean {
  const t = nodeMap(graph).get(target);
  if (!t || t.type === "output") return false;
  const port = inputPorts(t).find((p) => p.id === targetHandle);
  return !!port && !port.multiple;
}

// ---------------------------------------------------------------------------
// From a node to a generation request

type Source =
  | { kind: "text"; text: string }
  | { kind: "layout"; draft: LayoutDraft }
  | { kind: "media"; url: string }
  | { kind: "element"; handle: string }
  | { kind: "node"; nodeId: string };

const SLOT: Record<InputPortId, ChainSlot["slot"] | null> = {
  prompt: "prompt",
  elements: null,
  images: "images",
  endImage: "endImage",
  video: "video",
  videos: "videos",
  audio: "audio",
  voice: "voiceAudio",
  path: null,
};

type InputKey = "endImage" | "video" | "audio" | "voiceAudio";
const SINGLE_FIELD: Partial<Record<InputPortId, InputKey>> = { endImage: "endImage", video: "video", audio: "audio", voice: "voiceAudio" };

const PLACEHOLDER: Record<MediaKind, string> = {
  image: "/api/files/placeholder.png",
  video: "/api/files/placeholder.mp4",
  audio: "/api/files/placeholder.wav",
  text: "Placeholder text from an earlier step",
  model3d: "/api/files/placeholder.glb",
};

const SLOT_KIND: Record<ChainSlot["slot"], MediaKind> = {
  images: "image",
  endImage: "image",
  video: "video",
  videos: "video",
  audio: "audio",
  voiceAudio: "audio",
  audio2: "audio",
  audios: "audio",
  model3d: "model3d",
  mask: "video",
  prompt: "text",
};

/** The request with placeholders where earlier steps' outputs will go (mirrors withChainInputs on the server). */
export function withPlaceholders(req: GenerationRequest): GenerationRequest {
  const slots = req.chain ?? [];
  const inputs = { ...req.inputs };
  let prompt = req.prompt;
  for (const k of ["images", "videos", "audios"] as const) {
    const at = (pos: "first" | "last") => slots.filter((s) => s.slot === k && (s.position ?? "last") === pos).map((s) => PLACEHOLDER[SLOT_KIND[s.slot]]);
    const first = at("first");
    const last = at("last");
    if (first.length || last.length) inputs[k] = [...first, ...(inputs[k] ?? []), ...last];
  }
  for (const s of slots) {
    if (s.slot === "prompt") prompt = prompt?.includes("{text}") ? prompt.replaceAll("{text}", PLACEHOLDER.text) : PLACEHOLDER.text;
    else if (s.slot !== "images" && s.slot !== "videos" && s.slot !== "audios") inputs[s.slot] = PLACEHOLDER[SLOT_KIND[s.slot]];
  }
  return { ...req, prompt, inputs };
}

export interface NodeRequest {
  /** The request (the last step's, for a node made in several steps). */
  request: GenerationRequest;
  /** Upstream generator nodes, in the order of `request.chain` (for steps: each one once, in order of use). */
  deps: string[];
  /** A node made in several steps (Video Concatenator): its jobs in order; the last one holds the result. */
  steps?: NodeStep[];
  /** A node run once per row of a table: how many rows (its steps are the rows, and every one is a result). */
  rows?: number;
}

/** What fills a step's chain slot: an upstream node's result (one row of it, for a node run per row), or an earlier step of the same node. */
export type StepSource = { node: string; row?: number } | { step: string };

export interface NodeStep {
  key: string;
  /** Its chain slots (request.chain) are filled from `from`, in order. */
  request: GenerationRequest;
  from: StepSource[];
}

export interface NodeDescription extends Partial<NodeRequest> {
  model?: ModelDef;
  /** The planned run (with placeholders for upstream outputs), when the node is valid. */
  plan?: Plan;
  /** Estimated USD for one run of this node (null = unknown price). */
  costUsd: number | null;
  error?: string;
}

function sourceOf(graph: CanvasGraph, s: CanvasNode): Source | { error: string } {
  if (s.type === "prompt") return { kind: "text", text: (s.data.text ?? "").trim() };
  // A table is read row by row (rowRequest); read whole, it is its first row.
  if (s.type === "table") {
    const first = tableRows(s)[0];
    return first ? { kind: "text", text: rowText(first) } : { error: `Fill in a row of “${nodeLabel(s)}”` };
  }
  // A layout goes in whole: the request carries it and the plan compiles it for the model at the size it renders.
  if (s.type === "layout") {
    const draft = readLayout(s.data.layout);
    return draft?.items.length ? { kind: "layout", draft } : { error: `Draw a box in “${nodeLabel(s)}”: Edit layout` };
  }
  if (s.type === "clone-voice") {
    // A sample wired in wins over the node's own file (a recording, a generated voice).
    const e = graph.edges.find((x) => x.target === s.id && x.targetHandle === "audio");
    const from = e && graph.nodes.find((n) => n.id === e.source);
    if (from && from.type !== "clone-voice") return sourceOf(graph, from);
    return s.data.url ? { kind: "media", url: s.data.url } : { error: `Add a voice sample to “${nodeLabel(s)}”: record, upload or pick a saved voice` };
  }
  if (MEDIA_INPUT_TYPE[s.type]) {
    const what = s.type === "image-input" ? "an image" : s.type === "video-input" ? "a video" : "an audio clip";
    return s.data.url ? { kind: "media", url: s.data.url } : { error: `Add ${what} to “${nodeLabel(s)}”` };
  }
  if (s.type === "element") return s.data.handle ? { kind: "element", handle: s.data.handle } : { error: `Pick an element in “${nodeLabel(s)}”` };
  if (isGenerator(s)) return { kind: "node", nodeId: s.id };
  return { error: `${nodeLabel(s)} has no output` };
}

/**
 * A text model (LLM) on Auto writes, unless a language to translate into is set. (The catalog
 * lists translate first, so leaving it to inferOperation would translate a "Write a slogan…" prompt.)
 */
function textOp(model: ModelDef, params: GenParams | undefined): Operation | undefined {
  if (model.kind !== "text") return undefined;
  if (params?.targetLanguage && supportsOp(model, "translate")) return "translate";
  return supportsOp(model, "write") ? "write" : undefined;
}

/** What a generator node's own text box asks for, by the op it runs. */
export function promptPlaceholder(op: Operation | undefined): string {
  switch (op) {
    case "write":
      return "What should it write? Connected text joins in, or use {text}";
    case "translate":
      return "Text to translate, or connect a text";
    case "tts":
      return "Text to speak, or connect a text";
    case "sfx":
      return "Describe the sound, or connect a text";
    case "music":
      return "Describe the music: style, mood, instruments";
    default:
      return "Describe it — connected text joins in, or use {text}";
  }
}

/** The operation a node runs: its own choice, the utility's op, or inferred from what's connected. */
export function effectiveOp(graph: CanvasGraph, n: CanvasNode): Operation | undefined {
  const model = n.data.modelId ? getModel(n.data.modelId) : undefined;
  const ops = nodeOps(n, model);
  if (n.data.op && ops.includes(n.data.op)) return n.data.op;
  if (n.type !== "model") return ops[0];
  if (!model) return undefined;
  const text = textOp(model, n.data.params);
  if (text) return text;
  const built = buildRequest(graph, n, model);
  if ("error" in built) return undefined;
  let op = inferOperation(model, withPlaceholders(built.request));
  // Connected elements bring reference images (applyMentions on the server): text-only ops become edits / references.
  if (graph.edges.some((e) => e.target === n.id && e.targetHandle === "elements")) {
    if (op === "t2i" && supportsOp(model, "edit")) op = "edit";
    else if (op === "t2v" && supportsOp(model, "ref2v")) op = "ref2v";
  }
  return ops.includes(op) ? op : ops[0];
}

/** "With @Maya and @Paris." — how connected elements join the prompt. */
function mentionLine(handles: string[]): string {
  if (!handles.length) return "";
  const list = handles.map((h) => `@${h}`);
  return `With ${list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}` : list[0]}.`;
}

/** Handles already @mentioned in a text, lowercased (the same pattern as elements.ts: letters, digits, _ and -). */
function mentionedIn(text: string): Set<string> {
  return new Set([...text.matchAll(/@([\p{L}\p{N}_-]+)/gu)].map((m) => m[1].toLowerCase()));
}

function buildRequest(graph: CanvasGraph, n: CanvasNode, model: ModelDef, single = false): NodeRequest | { error: string } {
  const nodes = nodeMap(graph);
  const ports = inputPorts(n);
  const ops = nodeOps(n, model);
  const op = n.data.op && ops.includes(n.data.op) ? n.data.op : n.type !== "model" ? ops[0] : textOp(model, n.data.params);
  if (n.type !== "model" && op && !supportsOp(model, op)) return { error: `${model.name} can't do ${OPERATION_LABELS[op].toLowerCase()} — pick another model` };
  if ((op === "translate" || op === "dub") && !n.data.params?.targetLanguage) return { error: op === "dub" ? "Pick a language to dub into" : "Pick a language to translate into" };
  if (n.type === "concat") return concatRequest(graph, n, model);
  if (n.type === "fly-around") return flyAroundRequest(graph, n, model);
  // Keyframe animation: a table wired in is its gaps' timing (one row per gap), not a run per row.
  const timingTable = model.options.inbetween ? timingTableOf(graph, n) : undefined;
  if (timingTable) return inbetweenRequest(graph, n, model, timingTable);
  if (!single) {
    const rows = rowsFeeding(graph, n);
    if (rows && "error" in rows) return rows;
    if (rows && n.type === "join") return { error: `Join clips takes one clip per input. Use Assemble film to join every row of “${nodeLabel(rows.table)}”` };
    if (rows) return rowRequest(graph, n, model, rows);
  }

  const inputs: NonNullable<GenerationRequest["inputs"]> = {};
  const chain: ChainSlot[] = [];
  const deps: string[] = [];
  const texts: string[] = [];
  const handles: string[] = [];
  const layouts: LayoutDraft[] = [];
  let generatedText = 0;

  for (const port of ports) {
    const edges = incoming(graph, n.id)
      .filter((e) => e.targetHandle === port.id && nodes.has(e.source))
      .sort((a, b) => byPosition(nodes.get(a.source)!, nodes.get(b.source)!));
    if (!port.multiple && edges.length > 1) return { error: `${port.label} takes one input — remove a connection` };
    const list: Source[] = [];
    // The stem each edge carries (Split soundtrack's outputs), in the order of `list`.
    const stems: (string | undefined)[] = [];
    for (const e of edges) {
      const s = nodes.get(e.source)!;
      const type = outputType(graph, s);
      if (!type || !acceptsType(port, type)) return { error: `${nodeLabel(s)} can't go into ${port.label}` };
      const src = sourceOf(graph, s);
      if ("error" in src) return src;
      list.push(src);
      stems.push(edgeStem(s, e.sourceHandle));
    }
    if (port.id === "prompt") {
      for (const src of list) {
        if (src.kind === "text" && src.text) texts.push(src.text);
        if (src.kind === "layout") layouts.push(src.draft);
        if (src.kind === "node") {
          generatedText++;
          chain.push({ slot: "prompt" });
          deps.push(src.nodeId);
        }
      }
      continue;
    }
    if (port.id === "elements") {
      for (const src of list) if (src.kind === "element" && !handles.includes(src.handle)) handles.push(src.handle);
      continue;
    }
    if (port.id === "images" || port.id === "videos") {
      // Keep the board's top-to-bottom order: leading generated items go first, the rest after the files.
      let seenLiteral = false;
      const own: string[] = [];
      for (const src of list) {
        if (src.kind === "media") {
          own.push(src.url);
          seenLiteral = true;
        } else if (src.kind === "node") {
          chain.push({ slot: port.id, position: seenLiteral ? "last" : "first" });
          deps.push(src.nodeId);
        }
      }
      if (own.length) inputs[port.id] = own;
      continue;
    }
    const field = SINGLE_FIELD[port.id];
    const src = list[0];
    if (!field || !src) continue;
    if (src.kind === "media") inputs[field] = src.url;
    else if (src.kind === "node") {
      chain.push({ slot: SLOT[port.id]!, ...(stems[0] && { stem: stems[0] }) });
      deps.push(src.nodeId);
    }
  }
  if (generatedText > 1) return { error: "Connect one generated text at a time — join the others into one text model" };
  if (layouts.length > 1) return { error: "Connect one layout at a time" };
  // A picture model takes the layout itself (params.extra.layout: planLayout compiles it for that model at the size it
  // renders, prompt rewriting off); anything else reads it as sentences.
  const layout = layouts[0] && model.kind === "image" ? layouts[0] : undefined;
  if (layouts[0] && !layout) texts.push(compileWords(layouts[0]));
  // A voice wired into a model that only speaks preset voices: say which ones clone.
  if (!model.options.voiceClone && graph.edges.some((e) => e.target === n.id && e.targetHandle === "voice")) {
    const cloners = MODELS.filter((m) => !m.hidden && m.options.voiceClone && op && supportsOp(m, op) && m.engine === model.engine).map((m) => m.name);
    return { error: `${model.name} speaks in preset voices — pick ${cloners.length ? cloners.slice(0, 2).join(" or ") : "a model that clones voices"} to use the connected voice, or disconnect it` };
  }

  // Prompt: the node's own words, then connected texts, then the elements, then generated text.
  // "{text}" in the node's prompt marks where connected text goes (a generated text fills it on the server).
  const own = (n.data.prompt ?? "").trim();
  const slot = own.includes("{text}");
  const parts = generatedText || !slot ? [own, ...texts].filter(Boolean) : [own.replaceAll("{text}", texts.join("\n\n")).trim()].filter(Boolean);
  const already = mentionedIn(parts.join(" "));
  const mentions = mentionLine(handles.filter((h) => !already.has(h.toLowerCase())));
  if (mentions) parts.push(mentions);
  if (generatedText && !slot) parts.push("{text}");
  const prompt = parts.join("\n\n");

  const params: GenParams = { ...n.data.params };
  for (const k of Object.keys(params) as (keyof GenParams)[]) if (params[k] === undefined || params[k] === "") delete params[k];
  // The node's aspect ratio is the picture's (the Layout editor draws on it and sets it), so the boxes land where drawn.
  if (layout) params.extra = { ...params.extra, [LAYOUT_PARAM]: layout };
  const request: GenerationRequest = {
    feature: "canvas",
    modelId: model.id,
    // A Fuobe Original runs on the engine the node picked (the server would otherwise take the first one ready).
    ...(dualEngine(model) && { engine: model.engine }),
    ...(op && { op }),
    ...(prompt && { prompt }),
    ...(Object.keys(inputs).length && { inputs }),
    ...(Object.keys(params).length && { params }),
    ...(chain.length && { chain }),
  };
  return { request, deps };
}

// ---------------------------------------------------------------------------
// Keyframe animation on the Canvas: keyframe images into an In-between node (Fuobe Animation), and a table of its gaps

/** The "Keyframes → animation" table's columns: one row per gap between two keyframes. */
export const TIMING_COLUMNS = ["Frames", "Speed", "Words"];

/** The table wired straight into an In-between node, if any. */
function timingTableOf(graph: CanvasGraph, n: CanvasNode): CanvasNode | undefined {
  const nodes = nodeMap(graph);
  return incoming(graph, n.id)
    .map((e) => nodes.get(e.source))
    .find((s): s is CanvasNode => s?.type === "table");
}

/**
 * A timing table's rows as gaps: a "Frames" (or "Length") column, a "Speed" column (1–4, "×2" reads as 2) and a "Words"
 * column, found by name (else in that order). Missing cells take the defaults.
 */
export function timingFromTable(t: Pick<CanvasNode, "data">): Partial<InbetweenTiming> {
  const columns = (t.data.columns ?? []).map((c) => c.trim().toLowerCase());
  const at = (re: RegExp, fallback: number) => {
    const i = columns.findIndex((c) => re.test(c));
    return i >= 0 ? i : fallback < columns.length ? fallback : -1;
  };
  const fi = at(/^(frames?|length)/, 0);
  const si = at(/^(speed|every)/, 1);
  const wi = at(/^(words?|prompt|action|what)/, 2);
  const num = (v: string | undefined) => Number(String(v ?? "").replace(/[^\d.]/g, ""));
  const gaps = tableRows(t).map((r): GapTiming => {
    const frames = fi >= 0 ? num(r[fi]) : NaN;
    const speed = si >= 0 ? num(r[si]) : 1;
    const words = wi >= 0 ? r[wi] : "";
    return { frames: Number.isFinite(frames) && frames > 0 ? frames : 33, speed: isSpeed(speed) ? speed : 1, ...(words && { prompt: words }) };
  });
  return { gaps };
}

function inbetweenRequest(graph: CanvasGraph, n: CanvasNode, model: ModelDef, table: CanvasNode): NodeRequest | { error: string } {
  const without: CanvasGraph = { ...graph, edges: graph.edges.filter((e) => !(e.source === table.id && e.target === n.id)) };
  const made = buildRequest(without, n, model, true);
  if ("error" in made) return made;
  const keys = (made.request.inputs?.images?.length ?? 0) + (made.request.chain?.filter((c) => c.slot === "images").length ?? 0);
  const asked = timingFromTable(table);
  if (keys >= 2 && (asked.gaps?.length ?? 0) !== keys - 1) return { error: `${keys} keyframes have ${keys - 1} gaps — give “${nodeLabel(table)}” one row per gap` };
  const fps = (made.request.params?.extra?.inbetween as Partial<InbetweenTiming> | undefined)?.fps;
  const timing = timingFor(keys, { ...asked, ...(fps && { fps }) }, model.engine);
  const problem = keys >= 2 ? timingProblem(timing, keys, model.engine) : null;
  if (problem) return { error: problem };
  const params: GenParams = { ...made.request.params, extra: { ...made.request.params?.extra, inbetween: timing }, ...(keys >= 2 && { keyframeTimes: keyTimes(timing) }) };
  return { ...made, request: { ...made.request, op: "keyframes", params } };
}

// ---------------------------------------------------------------------------
// Tables: the node a table feeds runs once per filled row (and so does every node after it, until a Video
// concatenator joins the rows into one film). "{Column}" in that node's prompt takes the row's cell; otherwise the
// row's cells, joined, are its connected text.

export const TABLE_LIMITS = { rows: 50, columns: 8, cell: 2000, column: 40 } as const;

/** A Layout node holds up to this many boxes. */
export const LAYOUT_NODE_LIMITS = { boxes: 64 } as const;

/** A table's filled rows (a row with at least one cell written), each with one cell per column. */
export function tableRows(t: Pick<CanvasNode, "data">): string[][] {
  const width = Math.max(1, t.data.columns?.length ?? 1);
  return (t.data.rows ?? []).filter((r) => r.some((c) => c?.trim())).map((r) => Array.from({ length: width }, (_, j) => (r[j] ?? "").trim()));
}

const rowText = (cells: string[]) => cells.filter(Boolean).join(", ");

/** The table a node runs per row of (with its filled rows), why it can't, or null when no table is upstream. */
export type RowsFeed = { table: CanvasNode; rows: string[][] } | { error: string } | null;

/**
 * The table every node of a graph runs per row of, worked out once per node however many nodes ask (the
 * editor asks for each generator on every keystroke). See rowsFeeding.
 */
export function tablesFeeding(graph: CanvasGraph): (n: Pick<CanvasNode, "id" | "type" | "data">) => RowsFeed {
  const nodes = nodeMap(graph);
  const into = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = into.get(e.target);
    if (list) list.push(e.source);
    else into.set(e.target, [e.source]);
  }
  const memo = new Map<string, RowsFeed>();
  const visiting = new Set<string>();
  const feed = (n: Pick<CanvasNode, "id" | "type" | "data">): RowsFeed => {
    if (n.type === "table") return { table: n as CanvasNode, rows: tableRows(n) };
    if (!isGenerator(n) || n.type === "concat" || visiting.has(n.id)) return null;
    // An In-between node reads its table as timing and makes one film: nothing after it runs per row.
    if (n.data.modelId && getModel(n.data.modelId)?.options.inbetween) return null;
    const known = memo.get(n.id);
    if (known !== undefined) return known;
    visiting.add(n.id);
    let found: { table: CanvasNode; rows: string[][] } | null = null;
    let out: RowsFeed | undefined;
    for (const sid of into.get(n.id) ?? []) {
      const s = nodes.get(sid);
      if (!s || (s.type !== "table" && !isGenerator(s))) continue;
      const r = feed(s);
      if (!r) continue;
      if ("error" in r) {
        out = r;
        break;
      }
      if (found && found.table.id !== r.table.id) {
        out = { error: `“${nodeLabel(found.table)}” and “${nodeLabel(r.table)}” both reach “${nodeLabel(n)}” — rows run from one table at a time` };
        break;
      }
      found = r;
    }
    visiting.delete(n.id);
    const result = out ?? found;
    memo.set(n.id, result);
    return result;
  };
  return feed;
}

/**
 * The table a node runs per row of: one wired into it, or one feeding a node it builds on (a Video concatenator
 * collects the rows instead, so nothing after it runs per row). Null when no table is upstream.
 */
export function rowsFeeding(graph: CanvasGraph, n: CanvasNode): RowsFeed {
  return tablesFeeding(graph)(n);
}

/** One job per row: the table read as that row (its cells in "{Column}", or as connected text), upstream rows matched by number. */
function rowRequest(graph: CanvasGraph, n: CanvasNode, model: ModelDef, b: { table: CanvasNode; rows: string[][] }): NodeRequest | { error: string } {
  if (!b.rows.length) return { error: `Fill in a row of “${nodeLabel(b.table)}”` };
  if (b.rows.length > TABLE_LIMITS.rows) return { error: `“${nodeLabel(b.table)}” has ${b.rows.length} rows — up to ${TABLE_LIMITS.rows} run at once` };
  const nodes = nodeMap(graph);
  const columns = (b.table.data.columns ?? []).map((c) => c.trim());
  const own = n.data.prompt ?? "";
  const direct = graph.edges.some((e) => e.source === b.table.id && e.target === n.id);
  // Layouts wired into this node: "{Column}" in their words fills from each row too (one layout, a batch of posters).
  const layoutIds = graph.edges.filter((e) => e.target === n.id && e.targetHandle === "prompt" && nodes.get(e.source)?.type === "layout").map((e) => e.source);
  const layoutNames = new Set(layoutIds.flatMap((id) => layoutPlaceholders(readLayout(nodes.get(id)!.data.layout) ?? { summary: { caption: "", meta: [], canvas: "single" }, items: [] })));
  const named = direct && columns.some((c) => c && (own.includes(`{${c}}`) || layoutNames.has(c)));
  const feeds = tablesFeeding(graph);
  const perRow = (id: string) => {
    const r = feeds(nodes.get(id)!);
    return !!r && !("error" in r);
  };
  const steps: NodeStep[] = [];
  const deps: string[] = [];
  for (const [i, cells] of b.rows.entries()) {
    const prompt = named ? columns.reduce((p, c, j) => (c ? p.replaceAll(`{${c}}`, cells[j]) : p), own) : own;
    const rowGraph: CanvasGraph = {
      ...graph,
      nodes: graph.nodes.map((x) => {
        if (x.id === b.table.id) return { ...x, type: "prompt" as const, data: { text: named ? "" : rowText(cells) } };
        if (x.id === n.id) return { ...x, data: { ...x.data, prompt } };
        const d = direct && layoutIds.includes(x.id) ? readLayout(x.data.layout) : null;
        return d ? { ...x, data: { ...x.data, layout: fillLayout(d, columns, cells) } } : x;
      }),
    };
    const r = buildRequest(rowGraph, rowGraph.nodes.find((x) => x.id === n.id)!, model, true);
    if ("error" in r) return { error: `Row ${i + 1}: ${r.error}` };
    for (const d of r.deps) if (!deps.includes(d)) deps.push(d);
    steps.push({
      key: `row:${i}`,
      request: { ...r.request, step: { label: `${nodeLabel(n)} · row ${i + 1}`, index: i, of: b.rows.length } },
      from: r.deps.map((d) => (perRow(d) ? { node: d, row: i } : { node: d })),
    });
  }
  return { request: steps[0].request, deps, steps, rows: steps.length };
}

// ---------------------------------------------------------------------------
// Video Concatenator: one job per clip step, then the join

/** A Video Concatenator's clips in their order: the order picked in the node, then the others top to bottom. */
export function concatClips(graph: CanvasGraph, n: Pick<CanvasNode, "id" | "data">): { nodeId: string; settings: ClipSettings }[] {
  const nodes = nodeMap(graph);
  const ids = [...new Set(incoming(graph, n.id).filter((e) => e.targetHandle === "videos" && nodes.has(e.source)).map((e) => e.source))];
  ids.sort((a, b) => byPosition(nodes.get(a)!, nodes.get(b)!));
  const picked = (n.data.order ?? []).filter((id) => ids.includes(id));
  return [...picked, ...ids.filter((id) => !picked.includes(id))].map((nodeId) => ({ nodeId, settings: n.data.clips?.[nodeId] ?? {} }));
}

/** The feature of a node's in-between jobs (a "-step" feature: the Library lists them under Show steps). */
export const CANVAS_STEP_FEATURE = "canvas-step";

export const concatRatio = (r: string | undefined): ConcatRatio => ((CONCAT_RATIOS as readonly string[]).includes(r ?? "") ? (r as ConcatRatio) : "16:9");

/** loudnorm in linear mode at its lowest target: the clip's sound −70 dB (silent), with no measuring (see linearGain in av/dub.ts). */
export const MUTE_LEVEL = { linear: true, integrated_loudness: -70, measured_i: 0, measured_tp: -12, measured_lra: 1, measured_thresh: -80, loudness_range: 7 } as const;

/**
 * A silent sound track `seconds` long, as a concatenator step names it: the server writes the WAV when the run
 * starts (silenceSeconds reads the length back). A clip muted, or with no sound of its own, gets one, so every clip
 * reaches merge-videos with sound (whether it keeps the others' sound when one clip has no audio stream is unknown).
 */
export const SILENCE_REF = "silence:";
export const silenceRef = (seconds: number) => `${SILENCE_REF}${Math.round(seconds * 1000) / 1000}`;
export function silenceSeconds(ref: string | undefined): number | null {
  if (!ref?.startsWith(SILENCE_REF)) return null;
  const s = Number(ref.slice(SILENCE_REF.length));
  return Number.isFinite(s) && s > 0 && s <= 36_000 ? s : null;
}

/** One clip's cut, in seconds, checked against its length when known. */
function clipCut(c: ClipSettings, i: number): { start: number; end?: number } | { error: string } {
  const start = Math.max(0, c.start ?? 0);
  const end = c.end;
  if (end !== undefined && end <= start + 0.05) return { error: `Clip ${i + 1}: the end has to come after the start` };
  if (c.length !== undefined && start >= c.length) return { error: `Clip ${i + 1} starts past its end (it is ${Math.round(c.length * 10) / 10} s long)` };
  return { start: Math.round(start * 1000) / 1000, ...(end !== undefined && { end: Math.round(Math.min(end, c.length ?? end) * 1000) / 1000 }) };
}

/**
 * The Video Concatenator's jobs. Cloud, per clip: trim-video (when cut), scale-video (into the film's frame), and
 * for a muted clip or one with no sound of its own, silence as long as it plays muxed in (merge-audio-video with a
 * WAV the server writes); a muted clip whose length isn't known yet gets its own soundtrack lowered −70 dB instead.
 * Then merge-videos at 30 fps, folded in joins of 24. Open, per clip: video-fit-clip (cut, frame, 30 fps and the sound or silence in one
 * CPU pass), then video-concat-encoded (packet copy: the clips now share one size, rate and sound layout).
 */
function concatRequest(graph: CanvasGraph, n: CanvasNode, model: ModelDef): NodeRequest | { error: string } {
  const engine = model.engine;
  const nodes = nodeMap(graph);
  // A node run once per row of a table gives a clip per row, in row order (each with that node's cut and sound).
  const feeds = tablesFeeding(graph);
  const clips = concatClips(graph, n).flatMap((c): { nodeId: string; settings: ClipSettings; row?: number }[] => {
    const rows = feeds(nodes.get(c.nodeId)!);
    return rows && !("error" in rows) ? rows.rows.map((_, row) => ({ ...c, row })) : [c];
  });
  if (!clips.length) return { error: `Connect the clips to join (up to ${CONCAT_LIMITS.clips})` };
  if (clips.length > CONCAT_LIMITS.clips) return { error: `Assemble film takes up to ${CONCAT_LIMITS.clips} clips. Remove ${clips.length - CONCAT_LIMITS.clips}` };
  const ratio = concatRatio(n.data.params?.aspectRatio);
  const size = CONCAT_SIZE[ratio];
  const title = nodeLabel(n);
  const base = { feature: "canvas" } as const;
  const steps: NodeStep[] = [];
  const deps: string[] = [];
  const lasts: string[] = [];
  /** A step reading one video: a file (inputs.video) or an upstream node / earlier step (a chain slot). */
  const add = (key: string, from: StepSource | { url: string }, req: Omit<GenerationRequest, "feature">, more: { slot: ChainSlot; from: StepSource }[] = []) => {
    const url = "url" in from ? from.url : undefined;
    const slots: ChainSlot[] = [...(url ? [] : [{ slot: "video" as const }]), ...more.map((m) => m.slot)];
    steps.push({
      key,
      request: { ...base, ...req, ...(url && { inputs: { ...req.inputs, video: url } }), ...(slots.length && { chain: slots }) },
      from: [...(url ? [] : [from as StepSource]), ...more.map((m) => m.from)],
    });
    return { step: key } as StepSource;
  };
  for (const [i, c] of clips.entries()) {
    const s = nodes.get(c.nodeId)!;
    if (outputType(graph, s) !== "video") return { error: `${nodeLabel(s)} can't go into Clips` };
    const src = sourceOf(graph, s);
    if ("error" in src) return src;
    if (src.kind !== "media" && src.kind !== "node") return { error: `${nodeLabel(s)} can't go into Clips` };
    if (src.kind === "node" && !deps.includes(src.nodeId)) deps.push(src.nodeId);
    // A clip per table row: the facts measured from one row's file (length, sound) don't hold for the others.
    const facts: ClipSettings = c.row === undefined ? c.settings : { start: c.settings.start, end: c.settings.end, mute: c.settings.mute };
    const cut = clipCut(facts, i);
    if ("error" in cut) return cut;
    const label = (what: string) => ({ label: `${title} · ${what} clip ${i + 1}`, index: i, of: clips.length });
    let at: StepSource | { url: string } = src.kind === "media" ? { url: src.url } : { node: src.nodeId, ...(c.row !== undefined && { row: c.row }) };
    const mute = !!facts.mute;
    if (engine === "open") {
      at = add(`fit:${i}`, at, {
        modelId: CONCAT_TOOLS.open.fit,
        op: "trim",
        params: { startTime: cut.start, ...(cut.end !== undefined && { endTime: cut.end }), fps: CONCAT_LIMITS.fps, extra: { ...size, ...(mute && { mute: true }) } },
        step: label("Fit"),
      });
    } else {
      if (cut.start > 0 || cut.end !== undefined) {
        // fal's trim-video defaults to 1 s → 3 s when an end is missing: always send both.
        const end = cut.end ?? facts.length;
        if (end === undefined) return { error: `Clip ${i + 1}: set where it ends too — the cloud cut needs both ends (or run the clip first, so its length is known)` };
        at = add(`trim:${i}`, at, { modelId: CONCAT_TOOLS.cloud.trim, op: "trim", params: { startTime: cut.start, endTime: end }, step: label("Trim") });
      }
      at = add(`fit:${i}`, at, { modelId: CONCAT_TOOLS.cloud.fit, op: "reframe", params: { aspectRatio: ratio, extra: { ...size } }, step: label("Frame") });
      // How long the clip plays: its cut, else its measured length from the start of the cut.
      const plays = cut.end !== undefined ? cut.end - cut.start : facts.length !== undefined ? facts.length - cut.start : undefined;
      if ((mute || facts.audio === false) && plays !== undefined && plays > 0) {
        // Muted, or silent to begin with: its sound becomes silence exactly as long as the clip.
        at = add(`quiet:${i}`, at, { modelId: CONCAT_TOOLS.cloud.mux, op: "mux", inputs: { audio: silenceRef(plays) }, step: label("Mute") });
      } else if (mute) {
        // Its length isn't known yet (a clip made upstream in this run): its own sound, lowered to −70 dB.
        const sound = add(`sound:${i}`, at, { modelId: CONCAT_TOOLS.cloud.sound, op: "separate-audio", step: label("Sound of") });
        steps.push({ key: `quiet:${i}`, request: { ...base, modelId: CONCAT_TOOLS.cloud.level, op: "level", params: { extra: { ...MUTE_LEVEL } }, chain: [{ slot: "audio" }], step: label("Mute") }, from: [sound] });
        at = add(`mute:${i}`, at, { modelId: CONCAT_TOOLS.cloud.mux, op: "mux", step: label("Mute") }, [{ slot: { slot: "audio" }, from: { step: `quiet:${i}` } }]);
      }
    }
    lasts.push((at as { step: string }).step);
  }
  // The join: one on the open engine (up to 100 clips), folded by 24 on the cloud.
  let level = lasts;
  const max = engine === "open" ? CONCAT_LIMITS.clips : CONCAT_LIMITS.cloudJoin;
  for (let depth = 0; level.length > 1; depth++) {
    const groups = Math.ceil(level.length / max);
    const last = groups === 1;
    const next: string[] = [];
    for (let g = 0; g < groups; g++) {
      const part = level.slice(Math.floor((g * level.length) / groups), Math.floor(((g + 1) * level.length) / groups));
      if (part.length === 1) {
        next.push(part[0]);
        continue;
      }
      const key = last ? "join" : `join:${depth}:${g}`;
      steps.push({
        key,
        request: {
          ...base,
          modelId: engine === "open" ? CONCAT_TOOLS.open.join : CONCAT_TOOLS.cloud.join,
          op: "concat",
          ...(engine === "cloud" && { params: { extra: { target_fps: CONCAT_LIMITS.fps } } }),
          chain: part.map(() => ({ slot: "videos" as const })),
          step: { label: last ? title : `${title} · join part ${g + 1}`, index: clips.length, of: clips.length + 1 },
        },
        from: part.map((k) => ({ step: k })),
      });
      next.push(key);
    }
    level = next;
  }
  // The cuts, frames and parts are helper steps (the Library hides them): only the film is a result.
  for (const st of steps) if (st.key !== level[0]) st.request = { ...st.request, feature: CANVAS_STEP_FEATURE };
  const final = steps.find((x) => x.key === level[0])!;
  return { request: final.request, deps, steps };
}

/** A Camera path node's keys (a preset, an exact orbit or keys) and their words; none when it has nothing set. */
export function cameraPathOf(n: Pick<CanvasNode, "data">): { keys: CameraKey[]; label: string } {
  return flyKeys(pathInputOf(n));
}

/** What a Camera path node holds, as the planner takes it: the orbit's numbers, a preset, or keys. */
function pathInputOf(n: Pick<CanvasNode, "data">) {
  const d = n.data;
  return d.orbit ? { orbit: d.orbit } : d.pathPreset ? { preset: d.pathPreset } : { keys: d.keys };
}

/**
 * Fly around: the still (the first image, top to bottom; any more are other views of the subject) filmed along the
 * connected Camera path, as src/lib/catalog/fly-around.ts plans it. Cloud: H3 Max camera-controls, or with views H3 Max
 * reference-to-video. Your GPU: MoGe 2's depth of the still, then Wan 2.1 + Uni3C along the server's render of the path.
 */
function flyAroundRequest(graph: CanvasGraph, n: CanvasNode, model: ModelDef): NodeRequest | { error: string } {
  const nodes = nodeMap(graph);
  const into = (port: InputPortId) =>
    incoming(graph, n.id)
      .filter((e) => e.targetHandle === port && nodes.has(e.source))
      .map((e) => nodes.get(e.source)!)
      .sort(byPosition);
  const pathNode = into("path")[0];
  if (!pathNode) return { error: "Connect a Camera path" };
  if (pathNode.type !== "camera-path") return { error: `${nodeLabel(pathNode)} can't go into Camera path` };
  const { keys } = cameraPathOf(pathNode);
  if (keys.length < 2) return { error: `Pick a move in “${nodeLabel(pathNode)}”` };
  const words: string[] = [];
  for (const s of into("prompt")) {
    const src = sourceOf(graph, s);
    if ("error" in src) return src;
    if (src.kind !== "text") return { error: "Fly around takes typed words: connect a Text prompt" };
    if (src.text) words.push(src.text);
  }
  const pictures: Source[] = [];
  for (const s of into("images")) {
    if (outputType(graph, s) !== "image") return { error: `${nodeLabel(s)} can't go into Still, then views` };
    const src = sourceOf(graph, s);
    if ("error" in src) return src;
    pictures.push(src);
  }
  if (!pictures.length) return { error: "Connect the still to film" };
  const urlOf = (src: Source) => (src.kind === "media" ? src.url : PLACEHOLDER.image);
  const plan = planFlyAround({
    engine: model.engine,
    image: urlOf(pictures[0]),
    views: pictures.slice(1).map(urlOf),
    // The node's own numbers or move (not only its keys): with views, the cloud turns the camera from their words.
    ...pathInputOf(pathNode),
    prompt: words.join(". ") || undefined,
    duration: n.data.duration,
    resolution: n.data.params?.resolution,
    feature: "canvas",
    title: nodeLabel(n),
  });
  if (plan.blocker) return { error: plan.blocker };
  // Pictures from other nodes go in as chain slots, in board order; the planner's stand-ins for them come out.
  const deps: string[] = [];
  const fromNodes = pictures.flatMap((src) => (src.kind === "node" ? [src.nodeId] : []));
  for (const id of fromNodes) if (!deps.includes(id)) deps.push(id);
  const steps: NodeStep[] = plan.steps.map((st) => {
    // A step takes as many pictures as the planner gave it (the depth and the film: the still; references: all of them).
    const taken = st.request.inputs?.images?.length ?? 0;
    const mine = pictures.slice(0, taken);
    const slots: ChainSlot[] = [];
    const from: StepSource[] = [];
    let literal = false;
    for (const src of mine) {
      if (src.kind === "node") {
        slots.push({ slot: "images", position: literal ? "last" : "first" });
        from.push({ node: src.nodeId });
      } else literal = true;
    }
    for (const [i, c] of (st.request.chain ?? []).entries()) {
      slots.push(c);
      from.push({ step: st.after![i] });
    }
    const images = mine.flatMap((src) => (src.kind === "media" ? [src.url] : []));
    const inputs = { ...st.request.inputs, images: images.length ? images : undefined };
    return {
      key: st.key,
      request: { ...st.request, feature: st.key === "main" ? "canvas" : CANVAS_STEP_FEATURE, inputs, ...(slots.length ? { chain: slots } : { chain: undefined }) },
      from,
    };
  });
  const main = steps.find((st) => st.key === "main")!;
  return { request: main.request, deps, steps };
}

/** A Translate node set to video with no cloud model allowed: where the open engine dubs. */
export const OPEN_DUB_HINT = "Dubbing a video on a canvas runs on the cloud (ElevenLabs Dubbing, HeyGen). On the open engine it's made in Translate & dub, where you check the translation before it's spoken: start it from here";

export interface DescribeContext {
  engineMode?: "both" | "open" | "cloud";
}

/** Everything the editor and the planner need about one generator node. */
export function describeNode(graph: CanvasGraph, n: CanvasNode, ctx: DescribeContext = {}): NodeDescription {
  if (!isGenerator(n)) return { costUsd: null, error: "Not a generator" };
  const mode = ctx.engineMode ?? "both";
  // A Fuobe Original as it runs on the node's engine (its routes, its price).
  const model = nodeModel(n, mode);
  // Dubbing has no open model: an open-only install says where it dubs instead. The concatenator's tools are
  // picked by engine, not by model.
  if (!model) {
    const pick = n.type === "translate" && n.data.mediaKind === "video" && mode === "open" ? OPEN_DUB_HINT : n.type === "concat" ? "Pick where the film is made: on the cloud or with open source" : "Pick a model";
    return { costUsd: null, error: n.data.modelId ? "That model is no longer in the catalog — pick another" : pick };
  }
  if (mode !== "both" && !runsOn(model, mode)) {
    return {
      model,
      costUsd: null,
      error:
        mode === "open"
          ? `${model.name} is a cloud model: pick an open-source model`
          : `${model.name} is an open-source model: pick a cloud model`,
    };
  }
  const built = buildRequest(graph, n, model);
  if ("error" in built) return { model, costUsd: null, error: built.error };
  if (built.steps) return describeSteps(built, model);
  try {
    const plan = planGeneration(withPlaceholders(built.request), (id) => (id === model.id ? model : getModel(id)), getPreset);
    // A film built clip by clip, or the open text-to-3D still and model, is planned from its inputs when it starts:
    // it can't wait for another node (said before Run).
    const chained = plan.op === "keyframes" ? !!keyframeChain(plan.model) : routesFor(plan.model, plan.op).some((r) => r.chained);
    if (built.deps.length && chained) return { ...built, model, costUsd: null, error: chainedWaitMessage(plan.model.name, plan.op) };
    return { ...built, model, plan, costUsd: planCost(plan) };
  } catch (e) {
    return { ...built, model, costUsd: null, error: (e as Error).message };
  }
}

/**
 * A planned node's price, as the composer and the server work it out. A run with LoRAs (Fuobe Soul's look, a recipe's)
 * goes to the route's LoRA endpoint at its own price, or an unknown one (fal's MOSS-Image /lora): null then, which the
 * node shows as "Price unknown", never as free.
 */
function planCost(plan: Plan): number | null {
  const withLoras = plan.loras.length > 0 && routesFor(plan.model, plan.op).some((r) => !!r.loraEndpoint);
  return estimateCost(plan.model, plan.params, plan.jobs, plan.op, withLoras);
}

/** A node made in several steps: every step planned with placeholders, the price their sum, the plan the last step's. */
function describeSteps(built: NodeRequest, model: ModelDef): NodeDescription {
  let cost = 0;
  let unknown = false;
  let plan: Plan | undefined;
  for (const st of built.steps!) {
    try {
      plan = planGeneration(withPlaceholders(st.request), getModel, getPreset);
    } catch (e) {
      return { ...built, model, costUsd: null, error: `${st.request.step?.label ?? st.key}: ${(e as Error).message}` };
    }
    const c = planCost(plan);
    if (c === null) unknown = true;
    else cost += c;
  }
  return { ...built, model, plan, costUsd: unknown ? null : Math.round(cost * 10000) / 10000 };
}

// ---------------------------------------------------------------------------
// Signatures: a node is fresh when it last ran with exactly these inputs and settings.

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** 53-bit string hash (cyrb53), as hex. */
function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

const unlabeled = (req: GenerationRequest): Partial<GenerationRequest> => {
  const rest: Partial<GenerationRequest> = { ...req };
  delete rest.step;
  delete rest.frame;
  delete rest.feature;
  return rest;
};

/**
 * The node's identity for "is this result still fresh": its request (minus labels) and the generations it
 * builds on. A node made in several steps: every step and what feeds it.
 */
export function nodeSignature(req: GenerationRequest, depIds: string[], steps?: NodeStep[]): string {
  if (steps) return hash(stable({ steps: steps.map((st) => ({ key: st.key, request: unlabeled(st.request), from: st.from })), deps: depIds }));
  return hash(stable({ ...unlabeled(req), deps: depIds }));
}

/**
 * What a node builds on, for its signature: the generation of the node it takes, or for a node run per table row
 * every row's (a row run again on its own leaves the first one as it was, and what joins the rows is stale all the same).
 */
export const depIdentity = (run: Pick<NodeRun, "rows"> | undefined, generationId: string): string => run?.rows?.join(",") ?? generationId;

/** One row of a node run per table row: its request (minus labels) and the generations its slots take. */
export function rowSignature(req: GenerationRequest, sources: (string | undefined)[]): string {
  return hash(stable({ ...unlabeled(req), from: sources }));
}

const LIVE = new Set<GenerationStatus | undefined>(["queued", "running", "succeeded"]);

/**
 * The generation a row of a node run per table row keeps from its last run: the row's result when it's still live
 * and the row's inputs are unchanged (its own signature; for a run saved before rows had one, the node's).
 */
export function keptRow(prev: NodeRun | undefined, row: number, rowSig: string, sig: string, status: (generationId: string) => GenerationStatus | undefined): string | undefined {
  const old = prev?.rows?.[row];
  if (!old || !LIVE.has(status(old))) return undefined;
  return (prev!.rowSigs ? prev!.rowSigs[row] === rowSig : prev!.sig === sig) ? old : undefined;
}

// ---------------------------------------------------------------------------
// Planning a run

export type RunReason = "new" | "changed" | "failed" | "forced" | "upstream";

export interface PlannedStep extends NodeRequest {
  nodeId: string;
  label: string;
  reason: RunReason;
  /** What this run costs (a node run per row: the rows it runs again, when the planner can tell). */
  costUsd: number | null;
  /** A node run per row: one row's price. */
  rowCostUsd?: number | null;
}

export interface CanvasPlan {
  /** Generator nodes in scope, in run order. */
  order: string[];
  /** Nodes that will make new generations, in order. */
  steps: PlannedStep[];
  /** Nodes whose current result is used as is. */
  reused: { nodeId: string; reason: "fresh" | "pinned"; generationId: string }[];
  errors: { nodeId: string; message: string }[];
  /** Sum of the known per-step estimates. */
  costUsd: number;
  /** Some step's price is unknown. */
  costUnknown: boolean;
}

export interface PlanOptions extends DescribeContext {
  /** Nodes to run (with everything upstream). Omit to run every generator node. */
  targets?: string[];
  /** Run the targets again even when their result is fresh. */
  force?: boolean;
  runs?: CanvasRuns;
  /** Status of a generation this canvas made (undefined = gone). */
  status?: (generationId: string) => GenerationStatus | undefined;
  /** describeNode, when the caller keeps its own cache of it (the editor re-plans on every keystroke). */
  describe?: (n: CanvasNode) => NodeDescription;
}

export function planCanvas(graph: CanvasGraph, opts: PlanOptions = {}): CanvasPlan {
  const nodes = nodeMap(graph);
  const runs = opts.runs ?? {};
  const status = opts.status ?? (() => undefined);
  const { order, cyclic } = topoOrder(graph);
  const errors: CanvasPlan["errors"] = [];
  const loop = new Set(cyclic);
  for (const id of cyclic) {
    const inLoop = ancestors(graph, [id]).has(id);
    errors.push({ nodeId: id, message: inLoop ? "This node is part of a loop — remove one of its connections" : "This node comes after a loop — remove one of the loop's connections" });
  }

  // Targets: generator nodes as given; other nodes (an Output, an input) stand for the generators feeding them.
  const all = graph.nodes.filter(isGenerator).map((n) => n.id);
  const requested = opts.targets ? opts.targets.filter((id) => nodes.has(id)) : all;
  const targets = new Set<string>();
  for (const id of requested) {
    if (isGenerator(nodes.get(id)!)) targets.add(id);
    else for (const a of ancestors(graph, [id])) if (isGenerator(nodes.get(a)!)) targets.add(a);
  }
  const scope = new Set([...targets, ...[...ancestors(graph, [...targets])].filter((id) => isGenerator(nodes.get(id)!))]);
  const inScope = [...order, ...cyclic].filter((id) => scope.has(id));

  const state = new Map<string, { kind: "run" } | { kind: "reuse"; id: string } | { kind: "blocked" }>();
  const steps: PlannedStep[] = [];
  const reused: CanvasPlan["reused"] = [];
  let costUsd = 0;
  let costUnknown = false;

  for (const id of inScope) {
    const n = nodes.get(id)!;
    const label = nodeLabel(n);
    if (loop.has(id)) {
      state.set(id, { kind: "blocked" });
      continue;
    }
    const prev = runs[id];
    // A node run per row is as fresh as its weakest row: a failed or trashed row makes it run again (that row only).
    const rowStatus = prev?.rows?.map(status);
    const weakest = rowStatus?.findIndex((x) => !LIVE.has(x)) ?? -1;
    const prevStatus = rowStatus ? rowStatus[Math.max(0, weakest)] : prev ? status(runOutput(prev)) : undefined;
    if (n.data.pinned) {
      if (prev && LIVE.has(prevStatus)) {
        state.set(id, { kind: "reuse", id: runOutput(prev) });
        reused.push({ nodeId: id, reason: "pinned", generationId: runOutput(prev) });
      } else {
        state.set(id, { kind: "blocked" });
        errors.push({ nodeId: id, message: "Pinned, but there's no result to use yet — unpin it to run it" });
      }
      continue;
    }
    const d = opts.describe?.(n) ?? describeNode(graph, n, opts);
    if (d.error || !d.request || !d.deps) {
      state.set(id, { kind: "blocked" });
      errors.push({ nodeId: id, message: d.error ?? "Can't run this node" });
      continue;
    }
    const upstream = d.deps.map((dep) => ({ dep, s: state.get(dep) }));
    const blockedBy = upstream.find((u) => !u.s || u.s.kind === "blocked");
    if (blockedBy) {
      state.set(id, { kind: "blocked" });
      errors.push({ nodeId: id, message: `Waiting on “${nodeLabel(nodes.get(blockedBy.dep)!)}” — fix it first` });
      continue;
    }
    let reason: RunReason | null;
    let cost = d.costUsd;
    if (upstream.some((u) => u.s!.kind === "run")) reason = prev ? "upstream" : "new";
    else {
      const sig = nodeSignature(d.request, upstream.map((u) => depIdentity(runs[u.dep], (u.s as { id: string }).id)), d.steps);
      const fresh = !!prev && prev.sig === sig && LIVE.has(prevStatus);
      reason = opts.force && targets.has(id) ? "forced" : fresh ? null : !prev || prevStatus === undefined ? "new" : prev.sig !== sig ? "changed" : "failed";
      // Rows that are live and unchanged are kept (the server does the same): only the others are paid for.
      if (reason && reason !== "forced" && d.rows && d.steps && prev?.rows && cost !== null) {
        const from = (f: StepSource) => ("node" in f ? (f.row === undefined ? (state.get(f.node) as { id: string }).id : runs[f.node]?.rows?.[f.row]) : undefined);
        const redo = d.steps.filter((st, r) => !keptRow(prev, r, rowSignature(st.request, st.from.map(from)), sig, status)).length;
        cost = Math.round(((cost * redo) / d.steps.length) * 10000) / 10000;
      }
    }
    if (!reason) {
      state.set(id, { kind: "reuse", id: runOutput(prev!) });
      reused.push({ nodeId: id, reason: "fresh", generationId: runOutput(prev!) });
      continue;
    }
    state.set(id, { kind: "run" });
    steps.push({
      nodeId: id,
      label,
      request: d.request,
      deps: d.deps,
      ...(d.steps && { steps: d.steps }),
      ...(d.rows && { rows: d.rows, rowCostUsd: d.costUsd === null ? null : d.costUsd / d.rows }),
      reason,
      costUsd: cost,
    });
    if (cost === null) costUnknown = true;
    else costUsd += cost;
  }
  return { order: inScope, steps, reused, errors, costUsd: Math.round(costUsd * 1000) / 1000, costUnknown };
}

// ---------------------------------------------------------------------------
// Engines: switch a whole board to open-source (or cloud) models

/** The equivalent model on the other engine for a node, if there is one. */
export function counterpart(graph: CanvasGraph, n: CanvasNode, engine: Engine): ModelDef | undefined {
  const current = n.data.modelId ? getModel(n.data.modelId) : undefined;
  // A Fuobe Original runs on both: it stays, on the other engine.
  if (current && runsOn(current, engine)) return current;
  // Open-H3 Regenerate and NVIDIA RTX Video are GPU-only: nobody hosts them, so they have no cloud stand-in.
  if (current && GPU_ONLY_FIXED.has(current.id)) return undefined;
  if (n.type !== "model") return defaultModelForNode(n, engine);
  const op = n.data.op ?? effectiveOp(graph, n) ?? (current ? current.routes[0].op : KIND_OP[n.data.mediaKind ?? "image"]);
  const kind = current?.kind ?? n.data.mediaKind;
  return defaultModelFor(op, engine) ?? MODELS.find((m) => m.engine === engine && !m.hidden && (!kind || m.kind === kind) && supportsOp(m, op));
}

/** The board with every generator node on `engine`; `missing` lists nodes with no model there. */
export function convertEngine(graph: CanvasGraph, engine: Engine): { graph: CanvasGraph; changed: number; missing: string[] } {
  let changed = 0;
  const missing: string[] = [];
  const nodes = graph.nodes.map((n) => {
    if (!isGenerator(n)) return n;
    const current = n.data.modelId ? getModel(n.data.modelId) : undefined;
    if (current && runsOn(current, engine)) {
      // A Fuobe Original keeps its model and its settings; only the engine it runs on changes.
      if (!dualEngine(current) || nodeEngine(n, current) === engine) return n;
      changed++;
      return { ...n, data: { ...n.data, engine } };
    }
    const m = counterpart(graph, n, engine);
    if (!m) {
      missing.push(n.id);
      return n;
    }
    changed++;
    // The concatenator's settings are its own (the frame, the cuts): only the engine's tools change.
    if (n.type === "concat") return { ...n, data: { ...n.data, modelId: m.id } };
    const keepOp = n.data.op && supportsOp(m, n.data.op) ? n.data.op : undefined;
    return { ...n, data: { ...n.data, modelId: m.id, op: keepOp, params: sanitizeParams(m, n.data.params), engine: dualEngine(m) ? engine : undefined } };
  });
  return { graph: { ...graph, nodes }, changed, missing };
}

/** Keep only the settings the new model offers (ratio, duration, resolution…). */
export function sanitizeParams(m: ModelDef, params: GenParams | undefined): GenParams | undefined {
  if (!params) return params;
  const p: GenParams = { ...params };
  if (p.aspectRatio && !m.options.aspectRatios?.includes(p.aspectRatio)) delete p.aspectRatio;
  if (p.resolution && !m.options.resolutions?.includes(p.resolution)) delete p.resolution;
  if (p.duration && m.options.durations && !m.options.durations.includes(p.duration)) delete p.duration;
  if (p.numOutputs && p.numOutputs > (m.options.maxOutputs ?? 4)) p.numOutputs = m.options.maxOutputs ?? 1;
  if (p.voice && !m.options.voices?.some((v) => v.id === p.voice)) delete p.voice;
  if (p.generateAudio !== undefined && !m.options.audio) delete p.generateAudio;
  if (p.extra) delete p.extra;
  return Object.keys(p).length ? p : undefined;
}

/** The engine most generator nodes use (for the header switch); null for a board without models. */
export function graphEngine(graph: CanvasGraph): Engine | null {
  let cloud = 0;
  let open = 0;
  for (const n of graph.nodes) {
    const m = isGenerator(n) ? nodeModel(n) : undefined;
    if (m?.engine === "cloud") cloud++;
    if (m?.engine === "open") open++;
  }
  return cloud + open === 0 ? null : open > cloud ? "open" : "cloud";
}

/** What an element node shows and mentions, from the Elements list. */
export type ElementInfo = { id: string; handle: string; name: string; references: string[] };

/**
 * Element nodes copy the element's name, @handle and first photo when it's picked. Renaming an
 * element gives it a new handle too, so a node is brought up to date by its element's id: the patch
 * for each element node whose element changed (keyed by node id). Elements that are gone, and
 * nodes without one, are left as they are.
 */
export function elementUpdates(graph: CanvasGraph, elements: readonly ElementInfo[]): Map<string, Partial<CanvasNodeData>> {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const out = new Map<string, Partial<CanvasNodeData>>();
  for (const n of graph.nodes) {
    const e = n.type === "element" && n.data.elementId ? byId.get(n.data.elementId) : undefined;
    if (!e) continue;
    const patch: Partial<CanvasNodeData> = {};
    if (n.data.handle !== e.handle) patch.handle = e.handle;
    if (n.data.name !== e.name) patch.name = e.name;
    if ((n.data.preview ?? undefined) !== (e.references[0] ?? undefined)) patch.preview = e.references[0];
    if (Object.keys(patch).length) out.set(n.id, patch);
  }
  return out;
}

/** The graph with every element node up to date (the same graph when nothing changed). */
export function withCurrentElements(graph: CanvasGraph, elements: readonly ElementInfo[]): CanvasGraph {
  const updates = elementUpdates(graph, elements);
  if (!updates.size) return graph;
  return { ...graph, nodes: graph.nodes.map((n) => (updates.has(n.id) ? { ...n, data: { ...n.data, ...updates.get(n.id) } } : n)) };
}

// ---------------------------------------------------------------------------
// Graph hygiene

const NODE_TYPES = new Set(Object.keys(NODE_SPECS));

/**
 * The operation a node on a retired model ran: its own, else what the retired model read connected images or elements
 * as (Cinema Studio took them as references, Replacement.withReferences).
 */
function storedOp(graph: CanvasGraph, n: CanvasNode): Operation | undefined {
  if (n.data.op) return n.data.op;
  const by = replacedBy(n.data.modelId)?.withReferences;
  return by && graph.edges.some((e) => e.target === n.id && (e.targetHandle === "images" || e.targetHandle === "elements")) ? by : undefined;
}

/**
 * A node saved on a model (or a model's operation) Fuobe retired when it stopped calling Higgsfield (replaced.ts)
 * moves to the one that does it now, keeping the settings it offers. A board picks a node's engine itself (nodeEngine
 * follows the install's engine mode first), so an Original keeps the cloud, where the retired model ran with your key.
 */
function currentNode(graph: CanvasGraph, n: CanvasNode): CanvasNode {
  const op = storedOp(graph, n);
  const to = n.data.modelId ? replacementOf(n.data.modelId, op) : undefined;
  const m = to && getModel(to.id);
  if (!m) return n;
  const runs = to.op ?? op;
  return {
    ...n,
    data: { ...n.data, modelId: m.id, ...(runs && { op: runs }), params: sanitizeParams(m, n.data.params), engine: dualEngine(m) ? (n.data.engine ?? "cloud") : undefined },
  };
}

/** A stored board with its nodes on retired models moved to the ones that replaced them (read before any save). */
export const withCurrentModels = (graph: CanvasGraph): CanvasGraph =>
  graph.nodes.some((n) => !!n.data.modelId && !!replacementOf(n.data.modelId, storedOp(graph, n))) ? { ...graph, nodes: graph.nodes.map((n) => currentNode(graph, n)) } : graph;

/**
 * Drop unknown node types, dangling edges and edges into handles that don't exist (after a model or op change), and
 * move nodes on a retired model to the one that replaced it.
 */
export function cleanGraph(graph: CanvasGraph): CanvasGraph {
  const nodes = graph.nodes.filter((n) => NODE_TYPES.has(n.type)).map((n) => currentNode(graph, n));
  const g: CanvasGraph = { ...graph, nodes, edges: [] };
  const ids = new Set(nodes.map((n) => n.id));
  const seen = new Set<string>();
  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    const key = `${e.source}|${e.sourceHandle ?? ""}|${e.target}|${e.targetHandle ?? ""}`;
    if (seen.has(key)) continue;
    const without = { ...g, edges: g.edges };
    if (connectionError(without, e)) continue;
    seen.add(key);
    g.edges.push(e);
  }
  return g;
}

export function outline(graph: CanvasGraph): Outline {
  const nodes = graph.nodes.filter((n) => n.type !== "note").slice(0, 40);
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  return {
    boxes: nodes.map((n) => ({ x: Math.round(n.position.x), y: Math.round(n.position.y), type: n.type, ...(n.data.label && { label: n.data.label.slice(0, 24) }) })),
    links: graph.edges.flatMap((e) => (index.has(e.source) && index.has(e.target) ? [[index.get(e.source)!, index.get(e.target)!] as [number, number]] : [])),
  };
}

let seq = 0;
/** A node or edge id that's unique within a canvas. */
export function newId(prefix: string): string {
  seq = (seq + 1) % 1e6;
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${seq.toString(36)}`;
}

// ---------------------------------------------------------------------------
// Templates: each in a cloud and an all-open-source variant

export interface CanvasTemplate {
  id: string;
  name: string;
  description: string;
  /** lucide icon name. */
  icon: string;
  hue: number;
  /** The section's key (TEMPLATE_SECTIONS: "effect-films"); none: the films and campaigns. */
  group?: TemplateSectionKey;
  /** Its place in its section, ascending: the most premium first. */
  rank: number;
  /** false: no ready board of its own (Blockout → film): only the owner sees it, under "More templates". */
  starter?: false;
  /** What the board makes, in plain words (its page's "What comes out"): no model names. */
  makes: string;
  /** The steps in order, in plain words (its page's "The steps"): no model names. */
  steps: string[];
  /** Plain words for an input node, by node id (its page's "What goes in"), where its label alone doesn't say it. */
  inputs?: Record<string, string>;
  /** The studio that makes the same in one step: an effect film's Video effect. */
  oneStep?: { href: string; label: string };
  /** The steps as a word or two each, for the small flow over a card's cover ("Photo", "Scene", "Film"). */
  flow: string[];
  /**
   * Files the board starts with, by input node id: a public file Fuobe ships (a published example input, a sample),
   * copied into the owner's storage when the board is made (src/server/canvas-samples.ts), so the board runs as it is.
   */
  samples?: Record<string, { src: string; name: string }>;
  /** `offered`: whether the install offers a model (Settings → Models & licences); a node falls back when it doesn't. */
  build: (engine: Engine, offered?: (id: string) => boolean) => CanvasGraph;
}

/** A node's model on each engine; `fallback`, the model it takes on an engine whose own isn't offered (without `on`). */
type ModelPair = { cloud: string; open: string; fallback?: Partial<Record<Engine, string>> };

interface TplNode {
  id: string;
  type: CanvasNodeType;
  x: number;
  y: number;
  data?: CanvasNodeData;
  models?: ModelPair;
  /** What changes on one engine (the product angles' QMA · 96 views on your GPU: its pose). */
  on?: Partial<Record<Engine, CanvasNodeData>>;
  width?: number;
}

function tpl(nodes: TplNode[], edges: [string, string, string?][]): (engine: Engine, offered?: (id: string) => boolean) => CanvasGraph {
  return (engine, offered) => {
    const graph: CanvasGraph = {
      nodes: nodes.map((t) => {
        const own = t.models?.[engine];
        const fallback = own && offered && !offered(own) ? t.models?.fallback?.[engine] : undefined;
        return {
          id: t.id,
          type: t.type,
          position: { x: t.x, y: t.y },
          data: { ...t.data, ...(!fallback && t.on?.[engine]), ...(own && { modelId: fallback ?? own }) },
          ...(t.width && { width: t.width }),
        };
      }),
      edges: [],
    };
    graph.edges = edges.map(([source, target, handle], i) => ({
      id: `e${i + 1}`,
      source,
      sourceHandle: OUT,
      target,
      targetHandle: handle ?? PREVIEW_IN,
    }));
    return graph;
  };
}

/** Column and row spacing: a generator node with a result is about 300 × 460 px. */
const COL = 380;
const ROW = 500;
/** A video node with its clip is taller (four inputs, prompt, settings, result). */
const FILM_ROW = 620;

/**
 * "Blockout → film" (package blockout-film), as Cinema's Blockout runs a one-shot blockout: in the cloud the grey box goes
 * to Seedance 2.5 as its reference clip (@Video1) with three stills and the compiled prompt (the corridor example's
 * beats); on your GPU the grey box's first frame is drawn from the stills, then the blockout's depth (near = bright)
 * drives Wan 2.2 Fun VACE for one 81-frame window. Cinema's Blockout builds blockouts and chains longer ones.
 */
const BLOCKOUT_REFS: Pick<BlockoutRef, "role" | "name">[] = [{ role: "interior" }, { role: "character" }, { role: "exterior" }];
const BLOCKOUT_BEATS = () => beatsFrom(EXAMPLE_SCENE.markers, EXAMPLE_SCENE.duration, EXAMPLE_WORDS);
const BLOCKOUT_STYLE = "Low-key horror, cold torchlight, 35 mm film grain";
const BLOCKOUT_CLOUD = tpl(
  [
    { id: "blockout", type: "video-input", x: 0, y: 0, data: { label: "Blockout (grey-box render)" } },
    { id: "interior", type: "image-input", x: 0, y: 340, data: { label: "Interior" } },
    { id: "character", type: "image-input", x: 0, y: 640, data: { label: "Character" } },
    { id: "exterior", type: "image-input", x: 0, y: 940, data: { label: "Exterior" } },
    {
      id: "beats",
      type: "prompt",
      x: COL,
      y: 0,
      width: 420,
      data: {
        label: "Beats (Subject · Action · Camera · Style · No)",
        text: compileBlockoutPrompt({ beats: BLOCKOUT_BEATS(), refs: BLOCKOUT_REFS, target: "seedance", style: BLOCKOUT_STYLE, sound: true, audio: ["Footsteps on concrete", "A long door creak", "Low room tone"], avoid: ["jump cuts", "text on screen", "extra people"] }),
      },
    },
    { id: "film", type: "model", x: COL * 2 + 80, y: 280, data: { mediaKind: "video", label: "Film", op: "ref2v", params: { aspectRatio: "16:9", duration: 8, resolution: "720p", generateAudio: true } }, models: { cloud: "seedance-2-5", open: "seedance-2-5" } },
    { id: "out", type: "output", x: COL * 3 + 120, y: 320, data: { label: "Film" } },
  ],
  [
    ["blockout", "film", "videos"],
    ["interior", "film", "images"],
    ["character", "film", "images"],
    ["exterior", "film", "images"],
    ["beats", "film", "prompt"],
    ["film", "out"],
  ],
);
const BLOCKOUT_OPEN = tpl(
  [
    { id: "first", type: "image-input", x: 0, y: 0, data: { label: "Blockout's first frame" } },
    { id: "interior", type: "image-input", x: 0, y: 320, data: { label: "Interior" } },
    { id: "character", type: "image-input", x: 0, y: 620, data: { label: "Character" } },
    { id: "depth", type: "video-input", x: COL, y: 620, data: { label: "Blockout depth (near = bright)" } },
    { id: "look", type: "model", x: COL, y: 0, data: { mediaKind: "image", label: "First frame from the stills", op: "edit", prompt: blockoutFramePrompt(BLOCKOUT_REFS.slice(0, 2), BLOCKOUT_STYLE) }, models: { cloud: "oss-qwen-edit", open: "oss-qwen-edit" } },
    {
      id: "film",
      type: "model",
      x: COL * 2 + 40,
      y: 260,
      data: { mediaKind: "video", label: "Film (one 5 s window)", op: "v2v", prompt: compileBlockoutPrompt({ beats: BLOCKOUT_BEATS().filter((b) => b.start < 5), refs: BLOCKOUT_REFS, target: "open", style: BLOCKOUT_STYLE }), params: { aspectRatio: "16:9", duration: 5, resolution: "480p" } },
      models: { cloud: "oss-wan22-vace-blockout", open: "oss-wan22-vace-blockout" },
    },
    { id: "out", type: "output", x: COL * 3 + 80, y: 300, data: { label: "Film" } },
  ],
  [
    ["first", "look", "images"],
    ["interior", "look", "images"],
    ["character", "look", "images"],
    ["look", "film", "images"],
    ["depth", "film", "video"],
    ["film", "out"],
  ],
);

/** Keyframes → animation: three keyframes and a table of their two gaps into one In-between node (Fuobe Animation). */
const keyframesAnimation = tpl(
      [
        { id: "key1", type: "image-input", x: 0, y: 0, data: { label: "Keyframe 1" } },
        { id: "key2", type: "image-input", x: 0, y: ROW, data: { label: "Keyframe 2" } },
        { id: "key3", type: "image-input", x: 0, y: ROW * 2, data: { label: "Keyframe 3" } },
        {
          id: "timing",
          type: "table",
          x: COL,
          y: ROW * 2 + 40,
          data: { label: "Gaps (frames, speed ×1–×4, words)", columns: TIMING_COLUMNS, rows: [["37", "1", "she turns toward us"], ["17", "3", "she waves"]] },
        },
        {
          id: "animate",
          type: "model",
          x: COL * 2,
          y: ROW - 40,
          data: { mediaKind: "video", label: "In-between", op: "keyframes", prompt: "A character animation, clean lines", params: { aspectRatio: "16:9", extra: { stillMouth: true } } },
          models: { cloud: "fuobe-animation", open: "fuobe-animation" },
        },
        { id: "out", type: "output", x: COL * 3, y: ROW - 20, data: { label: "Animation" } },
      ],
      [
        ["key1", "animate", "images"],
        ["key2", "animate", "images"],
        ["key3", "animate", "images"],
        ["timing", "animate", "prompt"],
        ["animate", "out"],
      ],
    );

/** The outfit lookbook's four looks: one outfit and one place each, the model's face, hair and pose kept. */
const LOOKBOOK_LOOKS = [
  { label: "Paris balcony", prompt: "Dress the woman from the photo in an ivory tailored trouser suit on a Paris balcony in morning light, a wrought-iron rail and zinc rooftops behind her. Keep her face, hair and pose, full length." },
  { label: "Opera staircase", prompt: "Dress the woman from the photo in a black velvet column gown on a grand opera staircase lit by crystal chandeliers, red carpet and gilded balustrades around her. Keep her face, hair and pose, full length." },
  { label: "Alpine terrace", prompt: "Dress the woman from the photo in a long camel cashmere coat over a cream knit on a snowy Alpine hotel terrace at golden hour, the peaks glowing behind her. Keep her face, hair and pose, full length." },
  { label: "Yacht deck", prompt: "Dress the woman from the photo in a white linen shirt and wide white trousers on the teak deck of a yacht off Capri in bright sun, the turquoise sea behind her. Keep her face, hair and pose, full length." },
];

export const CANVAS_TEMPLATES: CanvasTemplate[] = [
  {
    id: "keyframes-animation",
    name: "Keyframes → animation",
    description: "Your keyframes in, the in-betweens drawn, one animation: a table times each gap",
    icon: "Sparkles",
    hue: 320,
    rank: 98,
    starter: false,
    makes: "One animation through your keyframes, each gap timed as the table says.",
    flow: ["Keyframes", "Timing", "Animation"],
    steps: ["Your keyframes go in, in order.", "A table gives each gap its length, speed and what happens in it.", "An animation model draws the in-betweens and joins them into one animation."],
    // Fuobe Animation runs on both engines: the node takes the template's.
    build: (engine) => {
      const g = keyframesAnimation(engine);
      for (const n of g.nodes) if (n.id === "animate") n.data.engine = engine;
      return g;
    },
  },
  {
    id: "image-animate",
    name: "Image → Animate",
    description: "Write a prompt, make a still, bring it to life",
    icon: "Clapperboard",
    hue: 282,
    rank: 5,
    makes: "A 5-second film of the still, in 16:9.",
    flow: ["Words", "Still", "Film"],
    steps: ["Your prompt says what the picture shows.", "An image model makes a still from it.", "A video model brings the still to life as a 5-second shot."],
    build: tpl(
      [
        { id: "prompt", type: "prompt", x: 0, y: 80, data: { label: "Prompt", text: "A fashion model in a long crimson silk gown on an Icelandic black-sand beach, the silk train lifting in the sea wind, basalt sea stacks behind her, soft overcast light, cinematic wide shot" } },
        { id: "still", type: "model", x: COL, y: 40, data: { mediaKind: "image", label: "Still", params: { aspectRatio: "16:9" } }, models: { cloud: "nano-banana-pro", open: "oss-qwen-image-21" } },
        { id: "animate", type: "model", x: COL * 2, y: 40, data: { mediaKind: "video", label: "Animate", op: "i2v", prompt: "Slow push-in as the silk train lifts in the sea wind and she turns her face towards the light", params: { aspectRatio: "16:9", duration: 5 } }, models: { cloud: "minimax-h3", open: "oss-minimax-h3" } },
        { id: "out", type: "output", x: COL * 3, y: 60, data: { label: "Film" } },
      ],
      [
        ["prompt", "still", "prompt"],
        ["still", "animate", "images"],
        ["animate", "out"],
      ],
    ),
  },
  {
    id: "product-angles",
    name: "Product shot → 3 angles → video",
    description: "One product photo, three studio angles, one ad clip",
    icon: "Package",
    hue: 30,
    rank: 1,
    makes: "Three studio angles of the product and a 5-second ad clip.",
    steps: ["Your product photo goes in.", "Three edits show it from the front, from the side and from above, on a clean studio background.", "A video model turns the three angles into a 5-second ad clip with a slow orbit."],
    inputs: { product: "A photo of your product on its own." },
    flow: ["Product", "3 angles", "Ad"],
    samples: { product: { src: "/examples/app-product-360/1/in-image.jpg", name: "Red patent heel.jpg" } },
    build: tpl(
      [
        { id: "product", type: "image-input", x: 0, y: ROW, data: { label: "Product photo" } },
        // On your GPU the front and side angles are QMA · 96 views: the camera itself turns (its pose in params.extra) and
        // the words follow its camera words, so a board switched to the cloud keeps each angle. Without QMA offered: Qwen-Image 2.1.
        // The top-down flat lay stays on Qwen-Image 2.1: QMA's highest camera is a high angle, not straight down.
        { id: "front", type: "model", x: COL, y: 0, data: { mediaKind: "image", label: "Front ¾ angle", op: "edit", prompt: "The same product from a three-quarter front angle on a seamless studio background, soft key light, sharp details" }, models: { cloud: "nano-banana-pro", open: QMA_MODEL, fallback: { open: "oss-qwen-image-21" } }, on: { open: { params: { extra: { horizontal_angle: 45, vertical_angle: 30, zoom: 5 } } } } },
        { id: "side", type: "model", x: COL, y: ROW, data: { mediaKind: "image", label: "Side profile", op: "edit", prompt: "The same product in a clean side profile on a seamless studio background, rim light, sharp details" }, models: { cloud: "nano-banana-pro", open: QMA_MODEL, fallback: { open: "oss-qwen-image-21" } }, on: { open: { params: { extra: { horizontal_angle: 90, vertical_angle: 0, zoom: 5 } } } } },
        { id: "top", type: "model", x: COL, y: ROW * 2, data: { mediaKind: "image", label: "Top-down", op: "edit", prompt: "The same product shot top-down as a flat lay on a seamless studio background, even light" }, models: { cloud: "nano-banana-pro", open: "oss-qwen-image-21" } },
        { id: "video", type: "model", x: COL * 2, y: ROW - 40, data: { mediaKind: "video", label: "Ad clip", op: "ref2v", prompt: "A premium product commercial: the camera orbits the product from the reference angles, studio lighting, slow and smooth", params: { aspectRatio: "16:9", duration: 5 } }, models: { cloud: "seedance-2-5", open: "oss-wan-vace" } },
        { id: "out", type: "output", x: COL * 3, y: ROW, data: { label: "Ad" } },
      ],
      [
        ["product", "front", "images"],
        ["product", "side", "images"],
        ["product", "top", "images"],
        ["front", "video", "images"],
        ["side", "video", "images"],
        ["top", "video", "images"],
        ["video", "out"],
      ],
    ),
  },
  {
    id: "lookbook",
    name: "Outfit lookbook",
    description: "One model photo, four looks in four places, then one moving shot",
    icon: "Shirt",
    hue: 20,
    rank: 2,
    makes: "Four lookbook pictures of the model and a 5-second moving shot of the first look.",
    flow: ["Model", "4 looks", "Film"],
    steps: [
      "A full-length photo of the model goes in.",
      "Four edits dress her in four outfits, each in its own place: a Paris balcony, an opera staircase, an Alpine terrace and a yacht deck.",
      "The four looks sit side by side as a lookbook.",
      "The first look comes to life as a 5-second moving shot.",
    ],
    inputs: { model: "A full-length photo of a person, head to toe." },
    samples: { model: { src: "/examples/app-3d-rotation/1/in-image.jpg", name: "Model photo.jpg" } },
    build: tpl(
      [
        { id: "model", type: "image-input", x: 0, y: ROW + 160, data: { label: "Model photo" } },
        ...LOOKBOOK_LOOKS.map((l, i) => ({
          id: `look${i + 1}`,
          type: "model" as const,
          x: COL,
          y: i * (ROW + 40),
          data: { mediaKind: "image" as const, label: l.label, op: "edit" as const, prompt: l.prompt, params: { aspectRatio: "3:4" } },
          models: { cloud: "nano-banana-pro", open: "oss-qwen-image-21" },
        })),
        { id: "book", type: "output", x: COL * 2, y: 0, data: { label: "Lookbook" }, width: 560 },
        { id: "animate", type: "model", x: COL * 2, y: ROW * 2 + 200, data: { mediaKind: "video", label: "Moving shot", op: "i2v", prompt: "She turns slowly towards the camera and smiles, the ivory suit moving softly, morning light on her face, the Paris rooftops behind her", params: { aspectRatio: "3:4", duration: 5 } }, models: { cloud: "minimax-h3", open: "oss-minimax-h3" } },
        { id: "out", type: "output", x: COL * 3, y: ROW * 2 + 240, data: { label: "Film" } },
      ],
      [
        ...LOOKBOOK_LOOKS.map((_, i): [string, string, string] => ["model", `look${i + 1}`, "images"]),
        ...LOOKBOOK_LOOKS.map((_, i): [string, string] => [`look${i + 1}`, "book"]),
        ["look1", "animate", "images"],
        ["animate", "out"],
      ],
    ),
  },
  {
    id: "music-video",
    name: "Music video",
    description: "One singer photo, three song scenes as moving shots, and a song laid under the film",
    icon: "Music",
    hue: 315,
    rank: 4,
    makes: "A 15-second music video of the three scenes, with its song.",
    flow: ["Singer", "Scenes", "Film"],
    steps: [
      "A photo of the singer goes in, so she looks the same in every scene.",
      "Each row of the table is one scene: a line of the song and what the picture shows.",
      "Every scene becomes a still of her, then a 5-second moving shot.",
      "The shots are joined into one film, and a song is made in the same mood.",
      "The song is laid under the film and cut to its 15 seconds.",
    ],
    inputs: { singer: "A clear photo of the singer's face and hair." },
    samples: { singer: { src: "/examples/app-hairstyle-try-on/1/in-image.jpg", name: "Singer photo.jpg" } },
    build: tpl(
      [
        { id: "singer", type: "image-input", x: 0, y: FILM_ROW - 80, data: { label: "Singer photo" } },
        {
          id: "scenes",
          type: "table",
          x: 0,
          y: 40,
          width: 420,
          data: {
            label: "Scenes",
            columns: ["Lyric", "Scene"],
            rows: [
              ["Midnight, the city is ours", "she dances in a silver sequin gown on a Tokyo rooftop at night, neon signs glowing behind her"],
              ["I keep the lights on for you", "she drives a red vintage convertible on a coast road at night in the silver sequin gown, city lights below"],
              ["Till the sun comes up", "she laughs on a Malibu beach at sunrise, the silver sequin gown catching the pink light"],
            ],
          },
        },
        { id: "still", type: "model", x: COL + 180, y: 0, data: { mediaKind: "image", label: "Still", op: "edit", prompt: "The same woman from the photo, her face and long dark hair unchanged: {Scene}. A music video still, glossy cinematic light, fashion film look", params: { aspectRatio: "16:9" } }, models: { cloud: "nano-banana-pro", open: "oss-qwen-image-21" } },
        { id: "animate", type: "model", x: COL * 2 + 180, y: 0, data: { mediaKind: "video", label: "Moving shot", op: "i2v", prompt: "She moves to the music, her sequin gown shimmering, the camera gliding slowly around her, lights glowing", params: { aspectRatio: "16:9", duration: 5 } }, models: { cloud: "minimax-h3", open: "oss-minimax-h3" } },
        { id: "film", type: "concat", x: COL * 3 + 180, y: 0, data: { label: "Film", params: { aspectRatio: "16:9" } }, models: { cloud: CONCAT_MODELS.cloud, open: CONCAT_MODELS.open } },
        { id: "song", type: "model", x: COL * 3 + 180, y: FILM_ROW, data: { mediaKind: "audio", label: "Song", op: "music", prompt: "Dreamy synth-pop, 104 bpm, a female vocal, glossy and cinematic, a warm night-drive mood", params: { duration: 30 } }, models: { cloud: "elevenlabs-music", open: "oss-ace-step" } },
        // The song under the film, then the whole cut to the film's 15 seconds (three 5-second shots).
        { id: "score", type: "model", x: COL * 4 + 220, y: FILM_ROW / 2, data: { mediaKind: "video", label: "Song under the film", op: "mux" }, models: { cloud: CONCAT_TOOLS.cloud.mux, open: "oss-mux" } },
        { id: "cut", type: "model", x: COL * 5 + 220, y: FILM_ROW / 2, data: { mediaKind: "video", label: "Cut to the film", op: "trim", params: { startTime: 0, endTime: 15 } }, models: { cloud: CONCAT_TOOLS.cloud.trim, open: "oss-trim" } },
        { id: "out", type: "output", x: COL * 6 + 220, y: FILM_ROW / 2, data: { label: "Music video" } },
      ],
      [
        ["singer", "still", "images"],
        ["scenes", "still", "prompt"],
        ["still", "animate", "images"],
        ["animate", "film", "videos"],
        ["film", "score", "video"],
        ["song", "score", "audio"],
        ["score", "cut", "video"],
        ["cut", "out"],
      ],
    ),
  },
  {
    id: "script-film",
    name: "Script → storyboard → film",
    description: "A short script becomes three frames, three clips and one film",
    icon: "GalleryHorizontal",
    hue: 200,
    rank: 6,
    makes: "Three frames, three clips and one film.",
    flow: ["Script", "Frames", "Film"],
    steps: ["Your script goes in.", "A writing model splits it into three shots: the opening, the turning point and the ending.", "Each shot becomes a still frame, all in one look.", "Each frame becomes a 5-second clip.", "The three clips are joined into one film."],
    build: tpl(
      [
        { id: "script", type: "prompt", x: 0, y: FILM_ROW, data: { label: "Script", text: "On a candlelit night, a woman in an emerald silk ball gown walks down the grand marble staircase of a palace. At the bottom she turns, and her face catches the candlelight. Then she pushes open tall gilded doors onto a moonlit garden." } },
        // The script reaches every shot through a text model: edit the script and all three shots follow.
        ...[0, 1, 2].map((i) => ({
          id: `beat${i + 1}`,
          type: "model" as const,
          x: COL,
          y: i * FILM_ROW,
          data: {
            mediaKind: "text" as const,
            label: `Shot ${i + 1} text`,
            op: "write" as const,
            prompt: `Describe shot ${i + 1} of 3 of this script (${["the opening moment", "the turning point", "the ending"][i]}) as one cinematic sentence. Reply with the sentence only.\n\n{text}`,
          },
          models: { cloud: "text-llm", open: "oss-text-llm" },
        })),
        ...[0, 1, 2].map((i) => ({
          id: `frame${i + 1}`,
          type: "model" as const,
          x: COL * 2,
          y: i * FILM_ROW,
          data: { mediaKind: "image" as const, label: `Frame ${i + 1}`, prompt: "Cinematic storyboard still, one consistent look across the film: {text}", params: { aspectRatio: "16:9" } },
          models: { cloud: "nano-banana-pro", open: "oss-qwen-image-21" },
        })),
        ...[0, 1, 2].map((i) => ({
          id: `shot${i + 1}`,
          type: "model" as const,
          x: COL * 3,
          y: i * FILM_ROW,
          data: { mediaKind: "video" as const, label: `Shot ${i + 1}`, op: "i2v" as const, prompt: "Animate this moment, smooth cinematic camera move: {text}", params: { aspectRatio: "16:9", duration: 5 } },
          models: { cloud: "minimax-h3", open: "oss-minimax-h3" },
        })),
        { id: "film", type: "join", x: COL * 4, y: FILM_ROW / 2, data: { label: "Film" }, models: { cloud: "join-clips", open: "oss-join-clips" } },
        { id: "out", type: "output", x: COL * 4, y: FILM_ROW * 1.5, data: { label: "Film" } },
      ],
      [
        ["script", "beat1", "prompt"],
        ["script", "beat2", "prompt"],
        ["script", "beat3", "prompt"],
        ["beat1", "frame1", "prompt"],
        ["beat2", "frame2", "prompt"],
        ["beat3", "frame3", "prompt"],
        ["beat1", "shot1", "prompt"],
        ["beat2", "shot2", "prompt"],
        ["beat3", "shot3", "prompt"],
        ["frame1", "shot1", "images"],
        ["frame2", "shot2", "images"],
        ["frame3", "shot3", "images"],
        ["shot1", "film", "videos"],
        ["shot2", "film", "videos"],
        ["shot3", "film", "videos"],
        ["film", "out"],
      ],
    ),
  },
  {
    id: "compare-image",
    name: "Compare 3 image models",
    description: "One prompt, three models, side by side",
    icon: "Columns3",
    hue: 150,
    rank: 7,
    makes: "Three pictures of the same prompt, side by side.",
    flow: ["Prompt", "3 pictures"],
    steps: ["Your prompt goes in.", "Three image models each make a picture from it.", "The three pictures sit side by side, so you can keep the best."],
    build: (engine) => {
      const models = engine === "open" ? ["oss-ideogram-4", "oss-qwen-image-21", "oss-krea2-realism"] : ["nano-banana-pro", "seedream-5-pro", "flux-3"];
      return tpl(
        [
          { id: "prompt", type: "prompt", x: 0, y: ROW - 60, data: { label: "Prompt", text: "Editorial beauty portrait of a Senegalese fashion model in a gold silk headwrap and gold earrings, warm studio light, film grain" } },
          ...models.map((m, i) => ({ id: `m${i + 1}`, type: "model" as const, x: COL, y: i * (ROW - 60), data: { mediaKind: "image" as const, modelId: m, params: { aspectRatio: "3:4" } } })),
          { id: "out", type: "output", x: COL * 2, y: ROW - 120, data: { label: "Compare" }, width: 560 },
        ],
        [["prompt", "m1", "prompt"], ["prompt", "m2", "prompt"], ["prompt", "m3", "prompt"], ["m1", "out"], ["m2", "out"], ["m3", "out"]],
      )(engine);
    },
  },
  {
    id: "talking-avatar",
    name: "Portrait → talking avatar with a cloned voice",
    description: "A photo, a short voice sample and a script make a talking clip",
    icon: "Mic2",
    hue: 340,
    rank: 8,
    makes: "A talking clip of the portrait in the cloned voice.",
    steps: ["A portrait, a short voice sample and a script go in.", "The script is read in the cloned voice.", "The portrait speaks the lines, with natural head movement."],
    inputs: { portrait: "A photo of a face, looking at the camera.", sample: "10 to 30 seconds of the voice to copy." },
    flow: ["Portrait", "Voice", "Talk"],
    samples: { portrait: { src: "/examples/effect-pearl-earring/1/in-image.jpg", name: "Portrait.jpg" }, sample: { src: "/samples/clean-voice/clean.m4a", name: "Voice sample.m4a" } },
    build: tpl(
      [
        { id: "portrait", type: "image-input", x: 0, y: 0, data: { label: "Portrait" } },
        { id: "sample", type: "clone-voice", x: 0, y: 340, data: { label: "Your voice (10–30 s sample)" } },
        { id: "script", type: "prompt", x: 0, y: 540, data: { label: "Script", text: "Welcome to the new collection. Every piece is cut by hand in our Milan atelier, and made to last a lifetime." } },
        { id: "voice", type: "tts", x: COL, y: 400, data: { label: "Cloned voice" }, models: { cloud: "chatterbox-cloud", open: "oss-chatterbox" } },
        { id: "avatar", type: "model", x: COL * 2, y: 80, data: { mediaKind: "video", label: "Talking avatar", op: "avatar", prompt: "A model talking warmly to the camera, natural head movement" }, models: { cloud: "kling-avatar-2", open: "oss-infinitetalk" } },
        { id: "out", type: "output", x: COL * 3, y: 100, data: { label: "Clip" } },
      ],
      [
        ["sample", "voice", "voice"],
        ["script", "voice", "prompt"],
        ["portrait", "avatar", "images"],
        ["voice", "avatar", "audio"],
        ["avatar", "out"],
      ],
    ),
  },
  {
    id: "table-film",
    name: "Table → shots → film",
    description: "Each row is a shot: a still, then a clip, all joined into one film",
    icon: "Table",
    hue: 160,
    rank: 3,
    makes: "One film with a shot for every row.",
    flow: ["Table", "Stills", "Film"],
    steps: ["Each row of the table is one shot.", "Every row becomes a still.", "Every still becomes a 5-second clip.", "The clips are joined into one film."],
    build: tpl(
      [
        { id: "cast", type: "table", x: 0, y: 40, data: { label: "Shots", columns: ["Shot", "Scene"], rows: [["Opening", "a fashion model in a white linen dress at the bow of a classic wooden yacht off Capri, morning sun"], ["Middle", "the model on the teak deck in a navy silk scarf, the cliffs of the Amalfi coast behind her"], ["Ending", "the model at the stern at golden hour, the sea glittering behind her"]] } },
        { id: "still", type: "model", x: COL + 140, y: 0, data: { mediaKind: "image", label: "Still", prompt: "{Scene}, a luxury yacht campaign, cinematic light", params: { aspectRatio: "16:9" } }, models: { cloud: "nano-banana-pro", open: "oss-qwen-image-21" } },
        { id: "animate", type: "model", x: COL * 2 + 140, y: 0, data: { mediaKind: "video", label: "Animate", op: "i2v", prompt: "Slow cinematic camera move, the sea glittering, fabric moving in the wind", params: { aspectRatio: "16:9", duration: 5 } }, models: { cloud: "minimax-h3", open: "oss-minimax-h3" } },
        { id: "film", type: "concat", x: COL * 3 + 140, y: 0, data: { label: "Film", params: { aspectRatio: "16:9" } }, models: { cloud: CONCAT_MODELS.cloud, open: CONCAT_MODELS.open } },
      ],
      [
        ["cast", "still", "prompt"],
        ["still", "animate", "images"],
        ["animate", "film", "videos"],
      ],
    ),
  },
  {
    id: "blockout-film",
    name: "Blockout → film",
    description: "A grey-box blockout sets the camera and timing; reference stills and timed beats say what it becomes",
    icon: "Box",
    hue: 210,
    rank: 99,
    starter: false,
    makes: "A film that follows the blockout's camera and timing.",
    flow: ["Blockout", "Film"],
    steps: ["A grey-box blockout sets the camera and timing.", "Reference stills and timed beats say what it becomes.", "A video model renders the film."],
    build: (engine) => (engine === "cloud" ? BLOCKOUT_CLOUD(engine) : BLOCKOUT_OPEN(engine)),
  },
  {
    id: "clips-film",
    name: "Clips → one film",
    description: "Trim, mute and join clips into one film, at 30 fps",
    icon: "Film",
    hue: 250,
    rank: 9,
    makes: "One film made of the three clips.",
    flow: ["Clips", "Film"],
    samples: Object.fromEntries(["pearl-earring", "superstar", "blue-depth"].map((e, i) => [`clip${i + 1}`, { src: `/previews/presets/effect-${e}.mp4`, name: `Clip ${i + 1}.mp4` }])),
    steps: ["Three clips go in.", "Each one is trimmed, muted and set to 30 frames a second.", "They are joined into one film."],
    build: tpl(
      [
        ...[0, 1, 2].map((i) => ({ id: `clip${i + 1}`, type: "video-input" as const, x: 0, y: i * 320, data: { label: `Clip ${i + 1}` } })),
        { id: "film", type: "concat", x: COL, y: 200, data: { label: "Film", params: { aspectRatio: "16:9" } }, models: { cloud: CONCAT_MODELS.cloud, open: CONCAT_MODELS.open } },
        { id: "out", type: "output", x: COL * 2 + 40, y: 240, data: { label: "Film" } },
      ],
      [
        ["clip1", "film", "videos"],
        ["clip2", "film", "videos"],
        ["clip3", "film", "videos"],
        ["film", "out"],
      ],
    ),
  },
];

// ---------------------------------------------------------------------------
// Effects 2.0 chains (build plan O13): Higgsfield's "Prompt based" effect chains as Fuobe templates. A photo goes
// through an image edit that sets the scene, then Fuobe DoP animates it with the effect's words (research
// higgsfield-originals-5.md §3.8: an image edit, then image to video). Both steps are open weights on both engines:
// Qwen-Image 2.1 Turbo on your GPU (Qwen-Image-Edit 2511 hosted on fal) and Fuobe DoP (Wan 2.2 14B on your GPU, or hosted on fal).
// The edit prompts are Fuobe's own words; the motion is the effect's own prompt from the effects catalog.

/** The effect films' section (TEMPLATE_SECTIONS). */
export const EFFECT_CHAIN_GROUP = "effect-films" satisfies TemplateSectionKey;

/** Image edit, then image to video: the models per engine (Fuobe DoP is an Original, run on the template's engine). */
export const EFFECT_CHAIN_MODELS = { edit: { cloud: "qwen-image-edit-2511-cloud", open: "oss-qwen-image-21-turbo" }, video: "fuobe-dop" } as const;

/** The researched Effects 2.0 chains with a scene to set first: the effect (its name in the effects catalog) and the edit. */
/** `line`: what it does for you, in one short line (cards and pages). `photo`: another effect's example photo, where its own has none yet. */
export const EFFECT_CHAINS: { effect: string; line: string; edit: string; icon: string; hue: number; rank: number; photo?: string }[] = [
  { effect: "Agamemnon", line: "You become a bronze-armoured king before a vast army at golden hour.", rank: 6, icon: "Swords", hue: 35, edit: "Dress the person as an ancient Greek warrior king in polished bronze armour and a red cape, a sword in hand, a vast army on a dusty battlefield behind them at golden hour. Keep their face and pose." },
  { effect: "Fallen Angel", photo: "superstar", line: "You get dark wings on a storm-lit rooftop, feathers in the air.", rank: 10, icon: "Feather", hue: 270, edit: "Give the person large dark ragged wings and put them on a storm-lit rooftop at night, black feathers drifting in the air. Keep their face, clothes and pose." },
  { effect: "Pearl Earring", line: "You become a Dutch Golden Age portrait with a pearl earring.", rank: 1, icon: "Gem", hue: 220, edit: "Repaint the picture as a Dutch Golden Age oil portrait: a blue and gold head wrap, a pearl earring, a dark background and soft window light. Keep the person's face." },
  { effect: "Monet Muse", line: "You step into an impressionist painting of a water-lily pond.", rank: 2, icon: "Palette", hue: 150, edit: "Repaint the scene as an impressionist oil painting of a garden pond with water lilies, soft dabs of light and colour. Keep the person and their pose." },
  { effect: "Fairytale Castle", line: "A fairytale castle rises behind you under a twilight sky.", rank: 4, icon: "Castle", hue: 300, edit: "Put a magical fairytale castle on a hill far behind the person under a twilight sky with the first fireworks. Keep the person exactly as they are." },
  { effect: "Blue Depth", line: "You drift in deep blue water, light rays falling from above.", rank: 5, icon: "Waves", hue: 210, edit: "Place the person underwater in deep blue ocean light, rays shimmering down from the surface, hair and clothes floating. Keep their face." },
  { effect: "Superstar", line: "You take the stage under bright spotlights as confetti falls.", rank: 3, icon: "Star", hue: 50, edit: "Put the person on a glittering concert stage under bright spotlights, a cheering crowd in silhouette and confetti in the air. Keep their face and outfit." },
  { effect: "Street Colossus", photo: "blue-depth", line: "You stand as tall as the buildings in a busy city street.", rank: 9, icon: "Building2", hue: 15, edit: "Make the person a giant standing in the middle of a city street, as tall as the buildings, with tiny cars and people around their feet. Keep their face and clothes." },
  { effect: "Dolphin Ride", line: "You ride a dolphin over sparkling waves in bright sunshine.", rank: 7, icon: "Fish", hue: 190, edit: "Put the person on the back of a dolphin leaping over sparkling ocean waves in bright sunshine. Keep their face." },
  { effect: "Skatedog", line: "A dog on a skateboard rolls along right beside you.", rank: 8, icon: "Dog", hue: 95, edit: "Add a happy dog riding a skateboard next to the person on a sunny street. Keep the person exactly as they are." },
];

const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** An effect's own motion words (its catalog prompt without the user's part). */
export function effectWords(name: string): string | undefined {
  return getPreset(`effect-${slugOf(name)}`)?.promptTemplate?.replace(/^\{prompt\}\.\s*/, "").trim() || undefined;
}

function effectChainTemplate(c: (typeof EFFECT_CHAINS)[number]): CanvasTemplate {
  const words = effectWords(c.effect);
  if (!words) throw new Error(`Effects 2.0 chain ${c.effect}: no such effect in the catalog`);
  return {
    id: `effect-chain-${slugOf(c.effect)}`,
    name: c.effect,
    description: c.line,
    icon: c.icon,
    hue: c.hue,
    group: EFFECT_CHAIN_GROUP,
    rank: c.rank,
    makes: `A 5-second moving shot of you in the ${c.effect} scene.`,
    flow: ["Photo", "Scene", "Film"],
    // The photo its Video effect's own example starts from (a published example input: example-files.ts).
    samples: { photo: { src: `/examples/effect-${c.photo ?? slugOf(c.effect)}/1/in-image.jpg`, name: "Your photo.jpg" } },
    steps: ["Your photo goes in.", `An edit sets the scene: ${c.edit}`, `The ${c.effect} effect brings it to life as a 5-second moving shot.`],
    inputs: { photo: "A photo of a person, facing the camera." },
    // canvas-template-cards.ts adds the effect's own example, when it has one.
    oneStep: { href: `/video?preset=effect-${slugOf(c.effect)}`, label: "Try this effect in Video" },
    build: (engine) => {
      const graph = tpl(
        [
          { id: "photo", type: "image-input", x: 0, y: 60, data: { label: "Your photo" } },
          { id: "scene", type: "model", x: COL, y: 0, data: { mediaKind: "image", label: "Set the scene", op: "edit", prompt: c.edit, params: { aspectRatio: "auto" } }, models: EFFECT_CHAIN_MODELS.edit },
          {
            id: "effect",
            type: "model",
            x: COL * 2,
            y: 0,
            data: { mediaKind: "video", label: c.effect, op: "i2v", modelId: EFFECT_CHAIN_MODELS.video, engine, prompt: words, params: { aspectRatio: "auto", duration: 5 } },
          },
          { id: "out", type: "output", x: COL * 3, y: 40, data: { label: "Your film" } },
        ],
        [
          ["photo", "scene", "images"],
          ["scene", "effect", "images"],
          ["effect", "out"],
        ],
      )(engine);
      return graph;
    },
  };
}

CANVAS_TEMPLATES.push(...EFFECT_CHAINS.map(effectChainTemplate));

export function getTemplate(id: string): CanvasTemplate | undefined {
  return CANVAS_TEMPLATES.find((t) => t.id === id);
}
