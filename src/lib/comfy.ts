/**
 * Pure helpers for ComfyUI API-format workflows: manifest types, binding application,
 * LoRA injection and size/frame math. No I/O here so it is easy to unit test.
 */
import type { LoraRef, MediaKind } from "./catalog/types";
import { ASR_LANGUAGES, WHISPER_LANGUAGES } from "./speech-languages";

export type ComfyNode = { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } };
export type ComfyWorkflow = Record<string, ComfyNode>;

export interface BindingTarget {
  node: string;
  input: string;
}

export type BindingKey =
  | "prompt"
  | "negativePrompt"
  | "image"
  | "image2"
  | "image3"
  | "image4"
  | "mask"
  | "endImage"
  | "video"
  | "audio"
  | "width"
  | "height"
  | "frames"
  | "fps"
  | "seed"
  | "steps"
  | "cfg"
  | "guidance"
  | "denoise"
  | "shift"
  | "loraHigh"
  | "loraLow"
  | "lora"
  | "loraStrength"
  | "upscaleModel"
  | "scale"
  | "duration"
  | "lyrics"
  | "tags"
  | (string & {});

export interface ManifestModel {
  file: string;
  folder: string;
  url?: string;
  sizeGb?: number;
  /** A licence to accept on Hugging Face (and a token) before it downloads (the LTX-2.5 files). */
  gated?: boolean;
  /** An alternative a model control can pick (FILM for RIFE): not needed for the workflow's defaults. */
  optional?: boolean;
}

export interface ManifestOutput {
  node: string;
  kind: MediaKind;
  /** Audio stems of a separation: voice / background, and DBS's music and effects. */
  stem?: "voice" | "background" | "music" | "effects";
  /**
   * What a text, image or 3D output is: timed caption cues, a plain transcript, the detected language, layers, a grid's sheet or tiles…
   * Round 4: OCR "lines" (JSON, boxes 0–1000) and the "frame" the model saw, an EXR sequence's "frames", a whole-"scene" GLB and its
   * "depth" map, a Gaussian "splat", a reference video's style "brief"; a painted eraser's last tracked "mask" (handed to the next
   * window), and a matte graph's "cutout" (transparent video) and "matte" (black and white) videos. A "preview" is the clip shown
   * for an EXR export (the frames ride along zipped). A "master" is a lossless copy a later job continues from (Character Swap
   * Studio's segment, 16-bit FFV1). A "report" is a node's own account of the run (DBS: model, device, windows, seconds).
   * An "orbit" is a clip of a splat turning that came with a 3D model (Photo to 3D): the server's mesh turntable never replaces it.
   */
  role?:
    | "cues"
    | "transcript"
    | "language"
    | "layers"
    | "sheet"
    | "tiles"
    | "first-frame"
    | "turntable"
    | "orbit"
    | "lines"
    | "frame"
    | "frames"
    | "scene"
    | "depth"
    | "splat"
    | "brief"
    | "mask"
    | "cutout"
    | "matte"
    | "preview"
    | "master"
    | "report"
    // Any Angle: the turntable at 192 px (colour, and its coverage) the front view is measured on, and a GLB made from a splat.
    | "sweep"
    | "sweep-mask"
    | "mesh"
    // Watermark Remover: the repair's verdict (QWMFinal), folded into the picture outputs' meta.
    | "quality"
    // Watermark Remover: a tile's scan report (QWMDetect on a quarter of the photo), merged into the "report" output.
    | "scan-tile";
}

export interface ManifestWorkflow {
  id: string;
  title: string;
  capability: string;
  file: string;
  source: string;
  bindings: Partial<Record<BindingKey, BindingTarget[]>>;
  outputs: ManifestOutput[];
  defaults: Record<string, number | string | boolean>;
  limits?: Record<string, number>;
  models: ManifestModel[];
  customNodes: { name: string; repo: string }[];
  vramGb?: number | string;
  license?: string;
  /** Node-managed downloads that happen on the first run (not in `models`). */
  autoDownloads?: string[];
  /** "isolated": the node pack has process-wide side effects and runs on a separate ComfyUI. */
  worker?: "isolated";
  /**
   * The provider rewrites the graph before submitting ("captions": one segment per caption cue;
   * "timeline": one loader per audio clip, each placed at its start time; "videos" / "audios": one loader
   * per clip of a join, src/lib/av/joins.ts; "references": one loader per reference image, clip and audio clip of
   * MiniMax H3's Ref2VA graph, src/lib/h3-references.ts; "speech": every Edit speech window of params.extra.speechWindows,
   * src/lib/av/speech-edit-graph.ts; "world": the opening and every turn of a World up to the one asked for,
   * src/lib/world.ts).
   */
  expand?: "captions" | "timeline" | "videos" | "audios" | "speech" | "keyframes" | "references" | "world";
  /** Classes the app adds to the graph per run (the References clip loaders): the GPU pre-flight counts them as the graph's. */
  runtimeNodes?: string[];
  validated: boolean;
  /** What ComfyUI answered when it last refused this graph. */
  validationError?: string;
  notes?: string;
}

export interface Manifest {
  version: number;
  generatedAt: string;
  comfyuiCommit?: string;
  workflows: ManifestWorkflow[];
}

export function cloneWorkflow(wf: ComfyWorkflow): ComfyWorkflow {
  return JSON.parse(JSON.stringify(wf)) as ComfyWorkflow;
}

/** Write values into the workflow. Unknown nodes are reported, not silently ignored. */
export function applyBindings(
  wf: ComfyWorkflow,
  bindings: ManifestWorkflow["bindings"],
  values: Partial<Record<BindingKey, unknown>>,
): { workflow: ComfyWorkflow; missing: string[] } {
  const out = cloneWorkflow(wf);
  const missing: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    const targets = bindings[key as BindingKey];
    if (!targets) continue;
    for (const t of targets) {
      const node = out[t.node];
      if (!node) {
        missing.push(`${key} → node ${t.node}`);
        continue;
      }
      node.inputs[t.input] = value;
    }
  }
  return { workflow: out, missing };
}

/**
 * Load3D reads a saved 3D file without the browser (Any Angle's saved view): its picture entries, which the viewer's
 * capture fills in the editor, point at the run's own photo (any file it sent works; nothing else is read from the folder).
 */
export function withLoad3dImages(wf: ComfyWorkflow, image: string | undefined): ComfyWorkflow {
  if (!image) return wf;
  let out = wf;
  for (const [id, n] of Object.entries(wf)) {
    const entry = n.inputs.image;
    if (n.class_type !== "Load3D" || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (out === wf) out = cloneWorkflow(wf);
    out[id].inputs.image = { ...(entry as Record<string, unknown>), image, mask: image, normal: image, recording: "" };
  }
  return out;
}

const MODEL_LOADERS = new Set(["UNETLoader", "CheckpointLoaderSimple", "UnetLoaderGGUF", "ImageOnlyCheckpointLoader"]);

/** Whether a graph has a diffusion model loader LoRAs can be attached after (wrapper graphs load models their own way). */
export function canTakeLoras(wf: ComfyWorkflow): boolean {
  return Object.values(wf).some((n) => MODEL_LOADERS.has(n.class_type));
}

/**
 * Insert LoraLoaderModelOnly nodes after every diffusion model loader (or only the
 * high/low-noise expert for Wan 2.2 MoE when a LoRA targets one of them) and rewire
 * all consumers of the loader's MODEL output.
 */
export function injectLoras(
  wf: ComfyWorkflow,
  all: (LoraRef & { target?: "high" | "low" | "both" })[],
): ComfyWorkflow {
  // A LoRA the graph loads itself (Fuobe Try-On's try-on LoRA in tryon-flux2-klein-4b) isn't loaded twice.
  const own = new Set(Object.values(wf).flatMap((n) => (/^LoraLoader/.test(n.class_type) && typeof n.inputs.lora_name === "string" ? [n.inputs.lora_name] : [])));
  const loras = all.filter((l) => !own.has(l.file));
  if (!loras.length) return wf;
  const out = cloneWorkflow(wf);
  const loaders = Object.entries(out).filter(([, n]) => MODEL_LOADERS.has(n.class_type));
  let nextId = Math.max(1000, ...Object.keys(out).map((k) => Number(k.split(":").pop()) || 0)) + 1;
  for (const [loaderId, loader] of loaders) {
    const fileName = String(loader.inputs.unet_name ?? loader.inputs.ckpt_name ?? "");
    const expert = /high[_-]?noise/i.test(fileName) ? "high" : /low[_-]?noise/i.test(fileName) ? "low" : "both";
    const applicable = loras.filter((l) => !l.target || l.target === "both" || expert === "both" || l.target === expert);
    if (!applicable.length) continue;
    let upstream: [string, number] = [loaderId, 0];
    const chainIds: string[] = [];
    for (const lora of applicable) {
      const id = String(nextId++);
      out[id] = {
        class_type: "LoraLoaderModelOnly",
        inputs: { model: upstream, lora_name: lora.file, strength_model: lora.strength ?? 1 },
        _meta: { title: `LoRA ${lora.file}` },
      };
      chainIds.push(id);
      upstream = [id, 0];
    }
    for (const [id, node] of Object.entries(out)) {
      if (chainIds.includes(id)) continue;
      for (const [k, v] of Object.entries(node.inputs)) {
        if (Array.isArray(v) && v[0] === loaderId && v[1] === 0) node.inputs[k] = upstream;
      }
    }
  }
  return out;
}

const RES_SHORT_SIDE: Record<string, number> = {
  "360p": 360,
  "480p": 480,
  "540p": 544,
  "580p": 576,
  "720p": 720,
  "768p": 768,
  "1080p": 1088,
};

const RES_AREA: Record<string, number> = {
  "0.5K": 512 * 512,
  "1K": 1024 * 1024,
  "1MP": 1024 * 1024,
  "1.5K": 1536 * 1536,
  "2K": 2048 * 2048,
  "4K": 4096 * 4096,
};

function parseRatio(ar: string): number | null {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ar);
  return m ? Number(m[1]) / Number(m[2]) : null;
}

const roundTo = (v: number, m: number) => Math.max(m, Math.round(v / m) * m);

/** Width/height for an aspect ratio, keeping the workflow's default pixel budget unless a resolution tier is given. */
export function computeDimensions(
  aspectRatio: string | undefined,
  resolution: string | undefined,
  defaults: { width?: number; height?: number },
  multiple = 16,
): { width: number; height: number } {
  const dw = Number(defaults.width ?? 1024);
  const dh = Number(defaults.height ?? 1024);
  const ratio = (aspectRatio && parseRatio(aspectRatio)) || dw / dh;
  if (resolution && RES_SHORT_SIDE[resolution]) {
    const short = RES_SHORT_SIDE[resolution];
    return ratio >= 1
      ? { width: roundTo(short * ratio, multiple), height: roundTo(short, multiple) }
      : { width: roundTo(short, multiple), height: roundTo(short / ratio, multiple) };
  }
  const area = (resolution && RES_AREA[resolution]) || dw * dh;
  const height = Math.sqrt(area / ratio);
  return { width: roundTo(height * ratio, multiple), height: roundTo(height, multiple) };
}

/**
 * A canvas the request names (params.extra.width / height: a layout's, Soul's exact sizes) on the workflow's grid and
 * inside its maxWidth / maxHeight, the shape kept: rounded to the grid, then scaled down whole when a side is past its
 * limit. The cloud fits the same canvas the same way (payload.ts sizeValue), so 2560 × 1000 is 2048 × 800 on both.
 */
export function fitCanvas(width: number, height: number, limits: Record<string, number> | undefined): { width: number; height: number } {
  const multiple = Number(limits?.dimensionMultiple ?? 16) || 16;
  const maxW = Number(limits?.maxWidth ?? Infinity);
  const maxH = Number(limits?.maxHeight ?? Infinity);
  let w = roundTo(width, multiple);
  let h = roundTo(height, multiple);
  const k = Math.min(1, maxW / w, maxH / h);
  if (k < 1) {
    w = Math.min(Math.max(multiple, Math.floor(maxW / multiple) * multiple), roundTo(w * k, multiple));
    h = Math.min(Math.max(multiple, Math.floor(maxH / multiple) * multiple), roundTo(h * k, multiple));
  }
  return { width: w, height: h };
}

/** Frame count for a duration. Wan/Hunyuan want 4n+1, LTX wants 8n+1. */
export function computeFrames(durationSec: number, fps: number, step = 4, maxFrames?: number): number {
  let frames = Math.round((durationSec * fps) / step) * step + 1;
  if (maxFrames) while (frames > maxFrames) frames -= step;
  return Math.max(step + 1, frames);
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 48);
}

/** Collect every model filename referenced by loader nodes in a workflow. */
export function referencedModels(wf: ComfyWorkflow): string[] {
  const keys = ["unet_name", "ckpt_name", "clip_name", "clip_name1", "clip_name2", "clip_name3", "vae_name", "lora_name", "model_name", "audio_encoder_name", "clip_vision_name"];
  const files = new Set<string>();
  for (const n of Object.values(wf)) {
    for (const k of keys) {
      const v = n.inputs[k];
      if (typeof v === "string" && /\.(safetensors|ckpt|pt|pth|bin|gguf|onnx)$/i.test(v)) files.add(v);
    }
  }
  return [...files];
}

/** Turn a ComfyUI validation error into a human sentence with a fix. */
export function explainComfyError(nodeErrors: unknown, manifest?: ManifestWorkflow): string {
  const parts: string[] = [];
  const errs = (nodeErrors ?? {}) as Record<string, { errors?: { message?: string; details?: string; extra_info?: { input_name?: string; received_value?: unknown } }[]; class_type?: string }>;
  // A ComfyUI's answer can be large (or, from someone's own computer, anything): its words are cut short, and few.
  const cut = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : undefined);
  for (const [nodeId, ne] of Object.entries(errs).slice(0, 24)) {
    for (const e of (Array.isArray(ne?.errors) ? ne.errors : []).slice(0, 6)) {
      const received = cut(e?.extra_info?.received_value, 256);
      const message = cut(e?.message, 300);
      const cls = cut(ne?.class_type, 128) ?? `node ${nodeId.slice(0, 32)}`;
      if (message?.includes("not in list") && received !== undefined) {
        const m = manifest?.models.find((mm) => mm.file === received);
        parts.push(
          m
            ? `Missing model "${received}" — put it in ComfyUI/models/${m.folder}${m.url ? ` (download: ${m.url})` : ""}`
            : `ComfyUI can't find "${received}" (${cls}.${cut(e.extra_info?.input_name, 64) ?? "input"})`,
        );
      } else {
        const details = cut(e?.details, 300);
        parts.push(`${cls}: ${message ?? "error"}${details ? ` — ${details}` : ""}`);
      }
    }
  }
  return [...new Set(parts)].slice(0, 20).join("\n") || "Your ComfyUI couldn't run this. Check the setup, then retry.";
}

// ---------------------------------------------------------------------------
// Round-3 helpers: caption cues, caption burn-in graphs, languages, palettes, layer bounding boxes.

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

const CUE_LINE = /^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*:\s?(.*)$/;
const SRT_TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/;

const srtSeconds = (h: string | undefined, m: string, s: string, ms: string) => Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, "0")) / 1000;

/**
 * Timed caption cues from text: Qwen3-ASR's "start-end: text" lines (seconds) or SRT / WebVTT blocks.
 * Lines that are neither are ignored; the result is sorted by start time.
 */
export function parseCueLines(input: string | undefined | null): CaptionCue[] {
  if (!input) return [];
  const cues: CaptionCue[] = [];
  const lines = input.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const simple = CUE_LINE.exec(line);
    if (simple) {
      cues.push({ start: Number(simple[1]), end: Number(simple[2]), text: simple[3].trim() });
      continue;
    }
    const srt = SRT_TIME.exec(line);
    if (srt) {
      const text: string[] = [];
      while (i + 1 < lines.length && lines[i + 1].trim() && !SRT_TIME.test(lines[i + 1])) text.push(lines[++i].trim());
      cues.push({ start: srtSeconds(srt[1], srt[2], srt[3], srt[4]), end: srtSeconds(srt[5], srt[6], srt[7], srt[8]), text: text.join(" ") });
    }
  }
  return cues.filter((c) => c.text && Number.isFinite(c.start) && c.end > c.start).sort((a, b) => a.start - b.start);
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Split cues into captions of at most `words` words (TikTok style), timed by their share of the characters. */
export function splitCueWords(cues: CaptionCue[], words: number): CaptionCue[] {
  if (!words || words < 1) return cues;
  return cues.flatMap((c) => {
    const w = c.text.split(/\s+/).filter(Boolean);
    if (w.length <= words) return [c];
    const groups: string[] = [];
    for (let i = 0; i < w.length; i += words) groups.push(w.slice(i, i + words).join(" "));
    const total = groups.reduce((n, g) => n + g.length + 1, 0);
    let t = c.start;
    return groups.map((text, i) => {
      const end = i === groups.length - 1 ? c.end : t + ((c.end - c.start) * (text.length + 1)) / total;
      const cue = { start: round3(t), end: round3(end), text };
      t = end;
      return cue;
    });
  });
}

const isLinkValue = (v: unknown): v is [string, number] => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "number";

/** What the provider knows about the clip being captioned (from its MP4 header); every field is optional. */
export interface CaptionClip {
  /** Seconds: cues past the end are dropped and the part after the last cue stays uncaptioned. */
  duration?: number;
  fps?: number;
  width?: number;
  height?: number;
  /** true: the clip's own soundtrack (LoadAudio) runs under the whole result. Otherwise each segment carries its own audio. */
  hasAudio?: boolean;
}

/** ConcatenateVideo joins up to 100 clips; two levels hold 10,000. */
const CONCAT_MAX = 100;
export const MAX_CAPTION_SEGMENTS = 2500;
/** Frames decoded at once per captioned chunk: about 384 MB of float32 RGB (≈0.5 s of 1080×1920 at 30 fps). */
const CAPTION_CHUNK_BYTES = 384 * 2 ** 20;
/** Shortest window the join takes safely (see expandCaptionWorkflow). */
const MIN_WINDOW_FRAMES = 3;

/** Length of the pieces a captioned stretch is cut into, so only one piece's frames are in memory at a time. */
export function captionChunkSeconds(clip: CaptionClip): number {
  if (!clip.width || !clip.height) return 1;
  const perSecond = clip.width * clip.height * 3 * 4 * (clip.fps || 30);
  return Math.max(0.25, Math.min(5, CAPTION_CHUNK_BYTES / perSecond));
}

/**
 * Rewrite the captions-burnin template for a list of cues. The clip is cut into consecutive Trim Video
 * windows: gaps go to the join untouched (never decoded); a cue's window is cut into chunks of at most
 * `captionChunkSeconds`, and each chunk is decoded, gets a Draw Text Overlay with the template's style and is
 * encoded straight away (Create Video, codec h264). Concatenate Video joins everything in order and lays the
 * clip's soundtrack under it. So ComfyUI never holds more than one chunk of raw frames that it still needs,
 * whatever the clip's length (finished chunks can be evicted from its cache under memory pressure).
 *
 * With `clip.fps` known, window edges sit half a frame before a frame, so every frame lands in exactly one window.
 * With `clip.duration` known, cues past the end are dropped and the clip after the last cue is kept as a gap;
 * without it, the last cue's window runs to the end of the clip (a window may not start after the end).
 */
export function expandCaptionWorkflow(wf: ComfyWorkflow, cues: CaptionCue[], clip: CaptionClip = {}): ComfyWorkflow {
  const out = cloneWorkflow(wf);
  const ids = Object.keys(out);
  const find = (cls: string) => ids.find((id) => out[id].class_type === cls);
  const loader = find("LoadVideo");
  const join = find("ConcatenateVideo");
  const style = ids.map((id) => out[id]).find((n) => n.class_type === "TextOverlay");
  const encode = ids.map((id) => out[id]).find((n) => n.class_type === "CreateVideo");
  if (!loader || !join || !style || !encode) throw new Error("Not a caption burn-in workflow (needs LoadVideo, TextOverlay, CreateVideo and ConcatenateVideo)");

  const fps = clip.fps && clip.fps > 0 ? clip.fps : undefined;
  const end = clip.duration && clip.duration > 0 ? clip.duration : undefined;
  // Edges: half a frame before the first frame shown (fps known), else the time to the millisecond.
  const edge = (t: number) => (fps ? Math.max(0, (Math.ceil(t * fps - 1e-6) - 0.5) / fps) : Math.max(0, round3(t)));
  // Every window but the last holds at least MIN_WINDOW_FRAMES frames: an empty one fails to decode, and
  // Concatenate Video rejects a 2-frame clip followed by another one (non-monotonic timestamps).
  const minLength = fps ? (MIN_WINDOW_FRAMES - 0.5) / fps : 0.15;
  const sorted = cues
    .filter((c) => c.text.trim() && c.end > c.start && (end === undefined || edge(c.start) < end - minLength))
    .sort((a, b) => a.start - b.start);
  if (!sorted.length) throw new Error(end !== undefined && cues.length ? "Every caption starts after the end of the clip — check the cue times" : "No captions to burn in");

  // Windows in order: { start, length (0 = to the end of the clip), text? }.
  type Window = { start: number; length: number; text?: string };
  const windows: Window[] = [];
  let cursor = 0;
  const shortest = fps ? MIN_WINDOW_FRAMES / fps : minLength;
  for (const [i, c] of sorted.entries()) {
    if (end !== undefined && cursor >= end - minLength) break; // no room left for another caption
    let start = Math.max(edge(c.start), cursor);
    if (start - cursor < minLength) start = cursor; // a pause too short for a window of its own: no gap
    const nextStart = i < sorted.length - 1 ? edge(sorted[i + 1].start) : undefined;
    let stop: number | undefined = edge(Math.min(c.end, end ?? Infinity));
    if (nextStart !== undefined) stop = Math.min(stop, nextStart);
    else if (end === undefined) stop = undefined; // last cue: to the end of the clip
    if (stop !== undefined) stop = Math.max(stop, start + shortest); // a very short caption stays up a few frames
    if (stop !== undefined && end !== undefined && end - stop < minLength) stop = undefined; // too close to the end: run to it
    if (start > cursor) windows.push({ start: cursor, length: start - cursor });
    windows.push({ start, length: stop === undefined ? 0 : stop - start, text: c.text.trim() });
    cursor = stop ?? Infinity;
  }
  if (end !== undefined && end - cursor >= minLength) windows.push({ start: cursor, length: 0 }); // the uncaptioned rest

  // Cut captioned windows into chunks (in whole frames when the frame rate is known).
  const chunk = captionChunkSeconds(clip);
  const parts: Window[] = windows.flatMap((w) => {
    if (w.text === undefined || !w.length) return [w];
    if (fps) {
      const first = w.start > 0 ? w.start : -0.5 / fps; // the window's half-frame edge (0 is clamped)
      const frames = Math.round((w.start + w.length - first) * fps);
      const n = Math.max(1, Math.min(Math.ceil(w.length / chunk), Math.floor(frames / MIN_WINDOW_FRAMES)));
      if (n === 1) return [w];
      const at = (k: number) => (k === 0 ? w.start : k === n ? w.start + w.length : first + Math.floor((k * frames) / n) / fps);
      return Array.from({ length: n }, (_, k) => ({ start: at(k), length: at(k + 1) - at(k), text: w.text }));
    }
    if (w.length <= chunk * 1.25) return [w];
    const n = Math.ceil(w.length / chunk);
    const at = (k: number) => (k === n ? w.start + w.length : round3(w.start + (k * w.length) / n));
    return Array.from({ length: n }, (_, k) => ({ start: at(k), length: at(k + 1) - at(k), text: w.text }));
  });
  if (parts.length > MAX_CAPTION_SEGMENTS) throw new Error(`Too many caption segments (${parts.length}, max ${MAX_CAPTION_SEGMENTS}) — trim the clip or use fewer captions`);

  // Drop the template's own segments; keep the loader, the soundtrack, the join and the save node.
  const keep = new Set([loader, join, ...ids.filter((id) => ["LoadAudio", "SaveVideo"].includes(out[id].class_type))]);
  for (const id of ids) if (!keep.has(id) && ["Video Slice", "GetVideoComponents", "TextOverlay", "CreateVideo", "ConcatenateVideo"].includes(out[id].class_type)) delete out[id];
  const soundtrack = ids.find((id) => out[id]?.class_type === "LoadAudio");
  const joinInputs = Object.fromEntries(Object.entries(out[join].inputs).filter(([k]) => !k.startsWith("videos.") && k !== "complete_audio"));
  if (clip.hasAudio === true && soundtrack) joinInputs.complete_audio = [soundtrack, 0];
  else if (soundtrack) delete out[soundtrack]; // silent or unknown: each segment brings its own audio (LoadAudio fails on a silent file)

  const styleInputs = Object.fromEntries(Object.entries(style.inputs).filter(([k]) => k !== "images" && k !== "text"));
  const encodeInputs = Object.fromEntries(Object.entries(encode.inputs).filter(([k]) => !["images", "fps", "audio"].includes(k)));
  const ms = (n: number) => Math.round(n * 1e6) / 1e6;
  let next = Math.max(1000, ...ids.map((k) => Number(k.split(":").pop()) || 0)) + 1;
  const links: [string, number][] = parts.map((p, i) => {
    const slice = String(next++);
    out[slice] = { class_type: "Video Slice", inputs: { video: [loader, 0], start_time: ms(p.start), duration: ms(p.length), strict_duration: false }, _meta: { title: `${p.text === undefined ? "Gap" : "Caption"} ${i + 1}` } };
    if (p.text === undefined) return [slice, 0];
    const frames = String(next++);
    const overlay = String(next++);
    const video = String(next++);
    out[frames] = { class_type: "GetVideoComponents", inputs: { video: [slice, 0] }, _meta: { title: `Frames ${i + 1}` } };
    out[overlay] = { class_type: "TextOverlay", inputs: { ...styleInputs, images: [frames, 0], text: p.text }, _meta: { title: `Caption ${i + 1}` } };
    out[video] = { class_type: "CreateVideo", inputs: { ...encodeInputs, images: [overlay, 0], fps: [frames, 2], audio: [frames, 1] }, _meta: { title: `Encoded ${i + 1}` } };
    return [video, 0];
  });
  const concat = (list: [string, number][], extra: Record<string, unknown>): ComfyNode => ({
    class_type: "ConcatenateVideo",
    inputs: { ...extra, ...Object.fromEntries(list.map((l, i) => [`videos.video${i}`, l])) },
    _meta: { title: "Segments in order" },
  });
  const innerInputs = Object.fromEntries(Object.entries(joinInputs).filter(([k]) => k !== "complete_audio"));
  if (links.length <= CONCAT_MAX) out[join] = concat(links, joinInputs);
  else {
    const groups: [string, number][] = [];
    for (let i = 0; i < links.length; i += CONCAT_MAX) {
      const id = String(next++);
      out[id] = concat(links.slice(i, i + CONCAT_MAX), innerInputs);
      groups.push([id, 0]);
    }
    out[join] = concat(groups, joinInputs);
  }
  return out;
}

/**
 * Drop an image slot from a FLUX.2-style reference chain: when everything downstream of `loaderId` ends in
 * ReferenceLatent "latent" inputs, those ReferenceLatent nodes are bypassed (their consumers read the
 * conditioning they were given) and the loader with its resize/encode nodes is removed. Returns null when the
 * image is used any other way (then the slot can't simply be left out).
 */
export function bypassReference(wf: ComfyWorkflow, loaderId: string): ComfyWorkflow | null {
  const consumers = (id: string) =>
    Object.entries(wf).flatMap(([cid, n]) => Object.entries(n.inputs).filter(([, v]) => isLinkValue(v) && v[0] === id).map(([input]) => ({ id: cid, input })));
  const refs = new Set<string>();
  const path = new Set<string>([loaderId]);
  const queue = [loaderId];
  while (queue.length) {
    const id = queue.shift()!;
    const users = consumers(id);
    if (!users.length) return null; // feeds an output directly
    for (const u of users) {
      const n = wf[u.id];
      if (n.class_type === "ReferenceLatent" && u.input === "latent") refs.add(u.id);
      else if (n.class_type === "ReferenceLatent" || /^(Save|Preview)/.test(n.class_type)) return null;
      else if (!path.has(u.id)) {
        path.add(u.id);
        queue.push(u.id);
      }
    }
  }
  if (!refs.size) return null;
  const out = cloneWorkflow(wf);
  // A chain of references: follow bypassed nodes to the first conditioning that stays.
  const source = (link: [string, number]): [string, number] => {
    let l = link;
    while (refs.has(l[0]) && isLinkValue(out[l[0]].inputs.conditioning)) l = out[l[0]].inputs.conditioning as [string, number];
    return l;
  };
  for (const n of Object.values(out)) for (const [k, v] of Object.entries(n.inputs)) if (isLinkValue(v) && refs.has(v[0])) n.inputs[k] = source(v);
  for (const id of [...refs, ...path]) delete out[id];
  return out;
}

/**
 * Take a node out of the graph: whatever read its first output reads `input`'s link instead (FPS Boost
 * without interpolation: Select Every Nth takes the frames straight). Nodes nothing reads any more (its
 * model loader, its constants) go too, except output nodes (`keep`). Unchanged when `input` isn't a link.
 */
export function bypassNode(wf: ComfyWorkflow, nodeId: string, input: string, keep: string[] = []): ComfyWorkflow {
  const src = wf[nodeId]?.inputs[input];
  if (!isLinkValue(src)) return wf;
  const out = cloneWorkflow(wf);
  for (const n of Object.values(out)) for (const [k, v] of Object.entries(n.inputs)) if (isLinkValue(v) && v[0] === nodeId) n.inputs[k] = [...src];
  delete out[nodeId];
  return dropUnused(out, keep);
}

/**
 * Graphs that run a prompt helper before the model (FLUX 3 Image Klein's: BFL's upsampler, a TextGenerate whose caption the
 * text encoder reads). Options → Prompt helper "off" (params.extra.promptHelper) or a layout of boxes takes it out.
 */
export const PROMPT_HELPER_GRAPHS: ReadonlySet<string> = new Set(["flux3-klein-t2i", "flux3-klein-edit", "flux3-klein-base-t2i-lora", "kandinsky6-t2av", "kandinsky6-i2av"]);

/**
 * Prompt helper graphs whose helper runs only when asked ("on"): Kandinsky 6.0's (Kandinsky6BeautifyPrompt on a 19 GB Qwen3.5
 * 9B file), off by default on both engines as on fal.
 */
export const PROMPT_HELPER_OPT_IN: ReadonlySet<string> = new Set(["kandinsky6-t2av", "kandinsky6-i2av"]);

/** The file an opt-in helper loads (an optional file of its graph): a run with the helper on needs it on that ComfyUI. */
export const PROMPT_HELPER_FILES: Readonly<Record<string, string>> = {
  "kandinsky6-t2av": "text_encoders/qwen3.5_9b_bf16.safetensors",
  "kandinsky6-i2av": "text_encoders/qwen3.5_9b_bf16.safetensors",
};

/** params.extra.promptHelper: "on" (the graph's default) or "off". */
export const PROMPT_HELPER_PARAM = "promptHelper";

/**
 * The words as typed, without the prompt helper: every CLIPTextEncode that reads a TextGenerate's caption reads that
 * TextGenerate's own prompt instead, and the helper's nodes (its model, system prompt, the references it looked at) go
 * with dropUnused. Unchanged when no encoder reads a TextGenerate.
 */
export function skipPromptHelper(wf: ComfyWorkflow, keep: string[] = []): ComfyWorkflow {
  const reads = (n: ComfyWorkflow[string], input: string, helper: string) => isLinkValue(n.inputs[input]) && wf[(n.inputs[input] as [string, number])[0]]?.class_type === helper;
  const readers = Object.values(wf).filter((n) => (n.class_type === "CLIPTextEncode" && reads(n, "text", "TextGenerate")) || (n.class_type === "Kandinsky6TextEncode" && reads(n, "video_caption", "Kandinsky6BeautifyPrompt")));
  if (!readers.length) return wf;
  const out = cloneWorkflow(wf);
  const own = (v: unknown) => (isLinkValue(v) ? [...v] : String(v ?? ""));
  for (const n of Object.values(out)) {
    const t = n.inputs.text;
    if (n.class_type === "CLIPTextEncode" && isLinkValue(t) && out[t[0]]?.class_type === "TextGenerate") n.inputs.text = own(out[t[0]].inputs.prompt);
    // Kandinsky 6.0: the encoder reads the captions the helper was given (its video and audio captions, outputs 0 and 1).
    if (n.class_type !== "Kandinsky6TextEncode") continue;
    for (const [input, slot] of [["video_caption", 0], ["audio_caption", 1]] as const) {
      const v = n.inputs[input];
      if (!isLinkValue(v) || out[v[0]]?.class_type !== "Kandinsky6BeautifyPrompt" || v[1] !== slot) continue;
      n.inputs[input] = own(out[v[0]].inputs[input]);
    }
  }
  return dropUnused(out, keep);
}

/** Remove nodes whose outputs nothing reads, over and over, keeping the output nodes `keep`. */
export function dropUnused(wf: ComfyWorkflow, keep: string[]): ComfyWorkflow {
  const out = cloneWorkflow(wf);
  for (;;) {
    const read = new Set(Object.values(out).flatMap((n) => Object.values(n.inputs).filter(isLinkValue).map((v) => v[0])));
    const gone = Object.keys(out).filter((id) => !read.has(id) && !keep.includes(id));
    if (!gone.length) return out;
    for (const id of gone) delete out[id];
  }
}

/**
 * VHS meta-batch graphs: tag each job's VHS_BatchManager with an input of its own. ComfyUI caches a node
 * whose inputs didn't change, so without it a job right after a failed or canceled meta-batch reuses the
 * stale manager and silently loses frames (checked on the CPU server: 32 of 48 frames). VHS keeps inputs
 * it doesn't declare (it adds its own "requeue" the same way).
 */
export function tagMetaBatch(wf: ComfyWorkflow, job: string): ComfyWorkflow {
  if (!Object.values(wf).some((n) => n.class_type === "VHS_BatchManager")) return wf;
  const out = cloneWorkflow(wf);
  for (const n of Object.values(out)) if (n.class_type === "VHS_BatchManager") n.inputs.job = job;
  return out;
}

/**
 * A clip with no sound: VHS_LoadVideo fails ("failed to extract audio") once its audio output is read, so
 * the links from that output (VHS_VideoCombine.audio) are dropped. Only for clips whose header says so.
 */
export function dropVhsAudio(wf: ComfyWorkflow): ComfyWorkflow {
  const loaders = new Set(Object.entries(wf).filter(([, n]) => n.class_type === "VHS_LoadVideo").map(([id]) => id));
  if (!loaders.size) return wf;
  const out = cloneWorkflow(wf);
  for (const n of Object.values(out)) {
    const a = n.inputs.audio;
    if (isLinkValue(a) && loaders.has(a[0]) && a[1] === 2) delete n.inputs.audio;
  }
  return out;
}
/**
 * The sound a VHS loader hands on replaced by `seconds` of stereo silence (the Video concatenator's muted
 * clips and clips without sound): every input fed by a loader's audio output takes an EmptyAudio instead,
 * so the clip still has a sound track as long as its picture and a join keeps the clips in step. The
 * loader's own sound is then never read (a file without one would stop VHS).
 */
export function silenceVhsAudio(wf: ComfyWorkflow, seconds: number): ComfyWorkflow {
  const loaders = new Set(Object.entries(wf).filter(([, n]) => n.class_type === "VHS_LoadVideo").map(([id]) => id));
  if (!loaders.size) return wf;
  const out = cloneWorkflow(wf);
  let id = "silence";
  for (let k = 2; out[id]; k++) id = `silence${k}`;
  out[id] = { class_type: "EmptyAudio", inputs: { duration: Math.round(seconds * 1000) / 1000, sample_rate: 44100, channels: 2 }, _meta: { title: "Silence as long as the clip" } };
  for (const n of Object.values(out)) {
    const a = n.inputs.audio;
    if (isLinkValue(a) && loaders.has(a[0]) && a[1] === 2) n.inputs.audio = [id, 0];
  }
  return out;
}
/**
 * A silent clip read by core LoadAudio (video-append-endcard reads the ad's sound from the same upload): LoadAudio
 * stops with "No audio stream found in the file". The loaders go, with the sound nodes fed only by them (the card's
 * silence and the AudioConcat), and the inputs of the picture nodes that took that sound (ConcatenateVideo's
 * complete_audio), so the result has no sound track. `loaders` are the LoadAudio node ids; `keep` the output nodes.
 */
export function dropLoadedSound(wf: ComfyWorkflow, loaders: string[], keep: string[]): ComfyWorkflow {
  const gone = new Set(loaders.filter((id) => wf[id]?.class_type === "LoadAudio"));
  if (!gone.size) return wf;
  const out = cloneWorkflow(wf);
  const isSound = (cls: string) => /audio/i.test(cls) && !/video/i.test(cls);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [id, n] of Object.entries(out)) {
      if (gone.has(id) || !isSound(n.class_type)) continue;
      if (Object.values(n.inputs).some((v) => isLinkValue(v) && gone.has(v[0]))) {
        gone.add(id);
        grew = true;
      }
    }
  }
  for (const n of Object.values(out)) for (const [k, v] of Object.entries(n.inputs)) if (isLinkValue(v) && gone.has(v[0])) delete n.inputs[k];
  for (const id of gone) delete out[id];
  return dropUnused(out, keep);
}

/**
 * An optional upload with no file (a side of a multi-view 3D model nobody photographed): the loader goes, with
 * every node downstream of it, up to the inputs of `into` nodes (Pixal3DMultiViewConditioning's "left"; one class
 * or a set of them), which are dropped. Null when its branch doesn't end in such an input, or reaches an output node
 * in `keep` (then the upload can't simply be left out).
 */
export function dropBranch(wf: ComfyWorkflow, loaderId: string, into: string | ReadonlySet<string>, keep: string[] = []): ComfyWorkflow | null {
  if (!wf[loaderId]) return null;
  const isInto = (cls: string) => (typeof into === "string" ? cls === into : into.has(cls));
  const gone = new Set([loaderId]);
  const cut: { id: string; input: string }[] = [];
  for (const queue = [loaderId]; queue.length; ) {
    const id = queue.shift()!;
    for (const [cid, n] of Object.entries(wf)) {
      for (const [input, v] of Object.entries(n.inputs)) {
        if (!isLinkValue(v) || v[0] !== id) continue;
        if (isInto(n.class_type)) cut.push({ id: cid, input });
        else if (keep.includes(cid)) return null;
        else if (!gone.has(cid)) {
          gone.add(cid);
          queue.push(cid);
        }
      }
    }
  }
  if (!cut.length) return null;
  const out = cloneWorkflow(wf);
  for (const c of cut) delete out[c.id].inputs[c.input];
  for (const id of gone) delete out[id];
  return out;
}

/** Codes people use that Whisper spells differently. */
const WHISPER_ALIASES: Record<string, string> = { fil: "tl", jv: "jw", iw: "he", nb: "no", zh_hans: "zh" };

const LANGUAGE_NAMES: Record<string, string> = { ...WHISPER_LANGUAGES, ...ASR_LANGUAGES, nb: "Norwegian", fil: "Filipino", jv: "Javanese" };

/** The ISO code in "de", "de-DE", "pt_BR" or "German (de)". */
function languageCode(v: string): string | undefined {
  return (/\(([a-z]{2,3})(?:-[A-Za-z]+)?\)\s*$/i.exec(v)?.[1] ?? /^([a-z]{2,3})(?:[-_][A-Za-z]+)?$/i.exec(v)?.[1])?.toLowerCase();
}

/** "tl", "fil", "he", "Hebrew" or "Hebrew (he)" → ComfyUI-Whisper's combo value ("Tagalog", "Hebrew"); unknown → "auto". */
export function whisperLanguage(value: string | undefined | null): string {
  const v = (value ?? "").trim();
  if (!v || v.toLowerCase() === "auto") return "auto";
  const code = languageCode(v);
  const byCode = code && (WHISPER_LANGUAGES[code] ?? WHISPER_LANGUAGES[WHISPER_ALIASES[code] ?? ""]);
  if (byCode) return byCode;
  const name = v.replace(/\s*\(.*\)\s*$/, "").toLowerCase();
  if (name === "filipino") return "Tagalog";
  return Object.values(WHISPER_LANGUAGES).find((n) => n.toLowerCase() === name) ?? "auto";
}

/** "de", "German", "German (de)" or "de-DE" → the ASR combo value ("German"); anything unknown → "auto" (detect). */
export function asrLanguage(value: string | undefined | null): string {
  const v = (value ?? "").trim();
  if (!v || v.toLowerCase() === "auto") return "auto";
  const code = languageCode(v);
  if (code && ASR_LANGUAGES[code]) return ASR_LANGUAGES[code];
  const name = v.replace(/\s*\(.*\)\s*$/, "").toLowerCase();
  return Object.values(ASR_LANGUAGES).find((n) => n.toLowerCase() === name) ?? "auto";
}

/** A language as words for an instruction: "German (de)" → "German", "pt-BR" → "Portuguese", "Klingon" stays. */
export function languageName(value: string | undefined | null): string {
  const v = (value ?? "").trim();
  const code = languageCode(v);
  if (code && LANGUAGE_NAMES[code]) return LANGUAGE_NAMES[code];
  return v.replace(/\s*\(.*\)\s*$/, "") || "English";
}

/** "#E4572E" / "e4572e" / "#fff" → [r, g, b], or null. */
export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const toHex = ([r, g, b]: [number, number, number]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;

/** The palette sentence the Soul HEX graph puts after the prompt ("Color palette: #E4572E, #29335C."). */
export function paletteSentence(palette: string[]): string {
  const hexes = palette.map(parseHex).filter((c): c is [number, number, number] => !!c).map(toHex);
  return hexes.length ? `Color palette: ${hexes.join(", ")}.` : "";
}

/**
 * RGBA pixels of a palette swatch: one vertical band per colour, widths proportional to `weights`
 * (equal by default). ColorTransfer matches the colour statistics of this image.
 */
export function swatchPixels(palette: string[], width = 512, height = 512, weights?: number[]): Uint8Array {
  const colors = palette.map(parseHex).filter((c): c is [number, number, number] => !!c);
  if (!colors.length) throw new Error("No valid hex colours in the palette");
  let w = colors.map((_, i) => (weights ? Math.max(0, Number(weights[i]) || 0) : 1));
  if (!w.some((v) => v > 0)) w = colors.map(() => 1);
  const sum = w.reduce((a, b) => a + b, 0);
  const edges: number[] = [];
  let acc = 0;
  for (const v of w) {
    acc += v / sum;
    edges.push(Math.round(acc * width));
  }
  const px = new Uint8Array(width * height * 4);
  for (let x = 0, band = 0; x < width; x++) {
    while (band < colors.length - 1 && x >= edges[band]) band++;
    const [r, g, b] = colors[band];
    for (let y = 0; y < height; y++) {
      const o = (y * width + x) * 4;
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = 255;
    }
  }
  return px;
}

/** Bounding box [x, y, w, h] of the pixels whose alpha is above `threshold`, or null for an empty layer. */
export function alphaBBox(rgba: Uint8Array, width: number, height: number, threshold = 8): [number, number, number, number] | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (rgba[row + x * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : [minX, minY, maxX - minX + 1, maxY - minY + 1];
}
