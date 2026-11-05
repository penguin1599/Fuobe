/**
 * Character Swap Studio (/character-swap): Akatz Labs' H3 Character Swap workbench for whole clips, on both engines
 * (docs/research/openjutsu-6.md §4.2, the Akatz app's modes and options). A project holds clips and one character
 * (a reference image and a written description). Each clip is cut into shots at its edits; a shot is either swapped
 * ("Replace character") or kept as filmed ("Keep original"). A swapped shot runs as segments of one diffusion pass each
 * (at most 362 frames with its continuation boundary), each with its own dialogue, speaker, prompt, seed, a fresh start
 * or a continuation of the segment before it, and an anchor. Segments make takes; the chosen takes are laid over the
 * original timeline with the original sound.
 *
 * This module is the pure part, shared by the page, the server (src/server/swap-studio.ts) and the tests: the project
 * document and its defaults, shots from cuts, transcript words and speakers, the performance prompts, segment layouts
 * and their continuation dependencies, take and review state, mask point payloads and the assembly order. The engine
 * steps are in swap-studio-plan.ts. Behaviour follows Akatz Labs' app (MIT, Akatz Labs 2026); its prompts are reused
 * with that notice. No code of theirs is copied.
 */
import { CHARACTER_SWAP, h3Canvas, HISTORY_CHOICES, WINDOW_CHOICES, whoWords, type SwapLora, type SwapWho } from "./character-swap";
import { STUDIO_FPS } from "@/lib/av/scene-cuts";
import { filmSize, type SharpenTier } from "./sharpen";
import { wholeClipBudget } from "@/lib/av/video-finish";
import type { Engine, PixelPoint } from "./types";
import type { OriginalSound } from "../av/original-sound";

export const SWAP_STUDIO = {
  feature: "swap-studio",
  stepFeature: "swap-studio-step",
  fps: STUDIO_FPS,
  /** "Trim this clip to 149.66 seconds or less before import." (Akatz's normaliser: 3,592 frames at 24 fps). */
  maxFrames: 3592,
  maxSeconds: 3592 / STUDIO_FPS,
  /** Fuobe's upload limit. */
  maxBytes: 200 * 1024 * 1024,
  maxClips: 20,
  accept: "video/mp4,video/quicktime,video/x-matroska,video/webm,video/x-msvideo,.mp4,.mov,.mkv,.webm,.avi",
  extensions: ["mp4", "mov", "mkv", "webm", "avi"],
  maxNameChars: 80,
  maxDescriptionChars: 2000,
  /** Akatz: prompts, directions and the custom anchor base prompt are at most 20,000 characters. */
  maxPromptChars: 20_000,
  maxNotesChars: 2000,
  /** One diffusion pass, the continuation boundary included (Akatz: "at most 362 frames"). */
  maxPassFrames: 362,
  /** The layouts the Segments panel offers (5, 10 and 15 s). */
  segmentLengths: [5, 10, 15] as const,
  /** fal's H3 reads 2–15 s of reference video a call. */
  cloudMinFrames: 2 * STUDIO_FPS,
  cloudMaxFrames: 15 * STUDIO_FPS,
  /** Akatz's seed for new shots. */
  seed: 194729,
  maxSeed: 2 ** 32 - 1,
  maxPoints: 24,
  maxTakes: 30,
  maxAnchors: 12,
  maxMaskVersions: 20,
  maxSegments: 1000,
} as const;

// ---------------------------------------------------------------------------
// The document

/** Who speaks (Akatz's speaker choice): the selected character, another person, an offscreen voice, nobody. */
export type SwapRole = "target" | "other" | "offscreen" | "none";
export type ShotMode = "generate" | "preserve";
export type Connection = "start" | "continue";
/** The segment's anchor: the shot's scene anchor, its own reference, or none. */
export type AnchorMode = "shot" | "custom" | "none";
export type Decision = "pending" | "keep" | "maybe" | "skip";
/** Render size in megapixels: 0.5 is H3's "480", 1.0 its "768". */
export type RenderMp = 0.5 | 1;

export const ROLE_LABELS: Record<SwapRole, { label: string; hint: string }> = {
  target: { label: "My character speaks", hint: "Their lips follow the clip's own voice" },
  other: { label: "Someone else speaks", hint: "Your character keeps the filmed mouth movement" },
  offscreen: { label: "Offscreen voice", hint: "Nobody on screen says it" },
  none: { label: "No dialogue", hint: "Nobody speaks here" },
};
export const DECISION_LABELS: Record<Decision, string> = { pending: "Not reviewed", keep: "Keep", maybe: "Maybe", skip: "Skip" };
export const MODE_LABELS: Record<ShotMode, { label: string; hint: string }> = {
  generate: { label: "Replace character", hint: "Your character takes over this shot" },
  preserve: { label: "Keep original", hint: "This shot stays as filmed" },
};

/** H3's quality for a render size. */
export const qualityFor = (mp: RenderMp): "480p" | "768p" => (mp === 0.5 ? "480p" : "768p");

/** A shot's generation settings (Akatz's shot fields; new shots take the project's defaults). */
export interface SwapSettings {
  lora: SwapLora;
  useAnchor: boolean;
  /** Masked generation (your GPU): only the person's mask is regenerated. */
  useMask: boolean;
  renderMp: RenderMp;
  seed: number;
  /** The diffusion window the default segment layout follows (17n + 5, 22–362). */
  windowFrames: number;
  /** Continuation history new segments take (0, 1 or 17n + 1). */
  historyFrames: number;
  /** Pixels the mask grows by (0–256). */
  expansion: number;
}

export const DEFAULT_SETTINGS: SwapSettings = {
  lora: "v1.5",
  useAnchor: true,
  useMask: true,
  renderMp: 1,
  seed: SWAP_STUDIO.seed,
  windowFrames: CHARACTER_SWAP.window,
  historyFrames: CHARACTER_SWAP.history,
  expansion: CHARACTER_SWAP.maskGrow,
};

/** Who to swap: SAM 3.1's words and which of the people they find. */
export interface WhoToSwap {
  selection: SwapWho;
  /** Person #n (from 0). */
  index: number;
  /** What SAM 3.1 looks for ("person"; "the woman in the red coat" narrows it). */
  words: string;
}

export const DEFAULT_WHO: WhoToSwap = { selection: "largest", index: 0, words: "person" };

/** A part of a mask video: frames [from, from + frames) of the shot. A later piece wins where they overlap. */
export interface MaskPiece {
  from: number;
  frames: number;
  /** Frames into its video where `from` is (a cloud Update frame near the clip's end reads frames before it). */
  offset?: number;
  /** The mask video once it is made. */
  url?: string;
  genId?: string;
}

/**
 * A mask version: "track" follows the person from `frame` to the shot's end, "frame" redoes one frame. On your GPU
 * every version is a whole-shot mask (the graph splices the new part into the version it corrects); on the cloud it
 * is the version it corrects plus a new piece.
 */
export interface MaskVersion {
  id: string;
  createdAt: number;
  kind: "track" | "frame";
  engine: Engine;
  frame: number;
  points: PixelPoint[];
  who: WhoToSwap;
  /** The version it corrects. */
  base?: string;
  pieces: MaskPiece[];
  /** The job that makes the newest piece, and every step it took. */
  genId?: string;
  stepIds?: string[];
}

export interface AnchorVariant {
  id: string;
  createdAt: number;
  source: "generated" | "imported";
  /** The image (an upload, or the job's output once it is done). */
  url?: string;
  genId?: string;
  stepIds?: string[];
  modelId?: string;
  prompt?: string;
}

/**
 * What a take was queued with (Akatz's freeze): a continuation launches later, once the takes it continues from are
 * made, and runs with the settings, words, anchor and mask it was queued with, not what was edited meanwhile.
 */
export interface FrozenTake {
  reference: string;
  /** The shot's first frame in the clip, and the segment's frames in the shot. */
  shotStart: number;
  start: number;
  end: number;
  /** Frames of continuation history (0: starts fresh). */
  history: number;
  anchor: string | null;
  /** Your GPU: the approved mask video (masked generation on). */
  mask: string | null;
  /**
   * Your GPU: how many of the take's last frames its lossless master keeps (what the next segment reads as history;
   * unset: all of them).
   */
  keep?: number;
  settings: SwapSettings;
  who: WhoToSwap;
}

export interface TakeDependency {
  segmentId: string;
  takeId: string | null;
  frames: number;
}

/**
 * A take: one render of a segment. `state` is the studio's own: waiting for the segments it continues from, launched
 * (the generations say how it goes), or stopped before it ran (with the reason).
 */
export interface SwapTake {
  id: string;
  createdAt: number;
  engine: Engine;
  state: "waiting" | "launched" | "stopped";
  reason?: string;
  /** The takes of this queue it waits for (the segments it continues from). */
  waitsOn?: { segmentId: string; takeId: string }[];
  /** The finished video's generation, and every step it took. */
  genId?: string;
  stepIds?: string[];
  signature: string;
  dependencies: TakeDependency[];
  prompt: string;
  seed: number;
  /** The selected take when it was queued: it becomes the selection when it finishes, unless that changed. */
  replaces?: string | null;
  favourite: boolean;
  decision: Decision;
  notes: string;
  frozen?: FrozenTake;
  /** The studio has looked at its finished result (selected it, or left the selection alone). */
  settled?: boolean;
  /** Its sharper version (Assemble → Finish → Sharpen), shown beside it until it is picked. */
  finish?: TakeFinish | null;
  /**
   * An account's take (public sign-up): the run its queue started. A take that starts later, once the one it continues
   * from is made, joins that run, so the whole queue counts once against the account's limits.
   */
  batchId?: string;
}

/**
 * A take made sharper (sharpen.ts). Your GPU: the take regenerated and only the character composited over the footage.
 * The cloud: the same segment made again on fal's H3 at 2K or 4K. The assembly uses it once it is picked (`use`).
 */
export interface TakeFinish {
  id: string;
  createdAt: number;
  engine: Engine;
  /** The size asked for, and the size made (your GPU: never above the footage's). */
  asked: SharpenTier;
  tier: SharpenTier;
  genId?: string;
  stepIds?: string[];
  /** Picked after comparing: the assembly uses it instead of the take. */
  use: boolean;
}

export interface SwapSegment {
  id: string;
  /** Frames of the shot: [start, end). */
  start: number;
  end: number;
  connection: Connection;
  history: number;
  seed: number;
  /** Extra direction for this segment. */
  prompt: string;
  /** "Exact prompt for this segment" (null: built from the shot's). */
  performancePrompt: string | null;
  /** The segment's words (null: the transcript's for its frames). */
  dialogue: string | null;
  speaker: SwapRole | null;
  anchorMode: AnchorMode;
  /** The segment reference picked (anchorMode "custom"): one of `anchors`. */
  anchor: string | null;
  anchors: AnchorVariant[];
  takes: SwapTake[];
  selectedTake: string | null;
  /** A layout change merged settings into it: worth a look before it runs. */
  needsReview: boolean;
}

export interface SwapShot {
  id: string;
  /** Frames of the clip at 24 fps: [start, end). */
  start: number;
  end: number;
  mode: ShotMode;
  /** Who speaks (null: from the transcript's voices). */
  speaker: SwapRole | null;
  /** The shot's words (null: the transcript's). */
  dialogue: string | null;
  /** The performance prompt ("Build shot prompts" writes it; editable). Null: built when needed. */
  prompt: string | null;
  who: WhoToSwap;
  masks: MaskVersion[];
  approvedMask: string | null;
  anchors: AnchorVariant[];
  approvedAnchor: string | null;
  /** Extra words for the anchor edit, and a base prompt of your own (replaces Akatz's brief). */
  anchorInstructions: string;
  anchorBasePrompt: string;
  settings: SwapSettings;
  /** The generation segments (null: the default layout, from the window plan). */
  segments: SwapSegment[] | null;
}

export interface TranscriptCue {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface SwapClip {
  id: string;
  name: string;
  /** The upload; `playable` false when the browser that added it couldn't play it (AVI, or a codec it lacks). */
  source: { url: string; name?: string; duration: number; fps?: number; width?: number; height?: number; hasAudio: boolean; bytes?: number; playable?: boolean };
  /** Your GPU: the clip at 24 fps (H.264, its sound kept), made on import. */
  normalized: { genId?: string; url?: string } | null;
  /**
   * The cloud: an H.264 copy at the clip's size for the page to play, show frames from and detect edits in, made when
   * the browser can't play the upload (clipNeedsPreview). The cloud's jobs read the upload as filmed.
   */
  preview?: { genId?: string; url?: string } | null;
  /** Frames at 24 fps. */
  frames: number;
  cuts: number[];
  /** Detected edits not yet confirmed. */
  detected: number[] | null;
  cutsReviewed: boolean;
  shots: SwapShot[];
  transcript: { genId?: string; modelId?: string; cues: TranscriptCue[] | null; voices: Record<string, SwapRole> } | null;
  review: Decision;
  reviewNotes: string;
  /** originalSound: what of the clip's sound went back (absent: Everything). */
  assembly: { genId?: string; stepIds?: string[]; takes: string[]; originalSound?: OriginalSound; createdAt: number } | null;
}

export interface SwapProject {
  id: string;
  name: string;
  engine: Engine;
  character: { image: string | null; description: string };
  defaults: SwapSettings;
  clips: SwapClip[];
  createdAt: number;
  updatedAt: number;
  revision: number;
}

// ---------------------------------------------------------------------------
// Small helpers

const tidy = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number.isFinite(v) ? v : lo)));

/** A short random id (the server passes its own generator in tests). */
export function uid(prefix: string, rand: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < 10; i++) s += "abcdefghijkmnpqrstuvwxyz23456789"[Math.floor(rand() * 32)];
  return `${prefix}${s}`;
}

/** FNV-1a over a string, as 8 hex digits: a take's settings signature. */
export function digest(value: unknown): string {
  const text = typeof value === "string" ? value : stableJson(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** JSON with sorted keys (so a signature doesn't depend on the order fields were written). */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export const seconds = (frames: number) => Math.round((frames / SWAP_STUDIO.fps) * 1000) / 1000;
/** The exact time of a 24 fps frame (graphs and cuts count frames from it, so it isn't rounded). */
export const at = (frame: number) => frame / SWAP_STUDIO.fps;

/**
 * Frames [from, to) as a ComfyUI Trim Video window. It starts half a frame early (Trim Video keeps the frames at or
 * after its start, so float error can't drop the first one) and runs a quarter frame past the range (H3's
 * PrepareVideo keeps floor(seconds × 24) frames, which a hair under the length would make one short). From frame 0
 * the window takes one frame too many, and PrepareVideo's frame limit drops it.
 */
export function frameWindow(from: number, to: number): { startTime: number; endTime: number } {
  const startTime = from > 0 ? (from - 0.5) / SWAP_STUDIO.fps : 0;
  return { startTime, endTime: startTime + (to - from + 0.25) / SWAP_STUDIO.fps };
}
export const framesOf = (s: number) => Math.round(s * SWAP_STUDIO.fps);
/** "12.5 s" */
export const secondsLabel = (frames: number) => `${(Math.round((frames / SWAP_STUDIO.fps) * 10) / 10).toString()} s`;

// ---------------------------------------------------------------------------
// Clips

/** The clip's file kind from its name, or null when the studio doesn't take it. */
export function clipExtension(name: string): string | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return (SWAP_STUDIO.extensions as readonly string[]).includes(ext) ? ext : null;
}

/** What stops a clip from being imported, or null. */
export function clipProblem(c: { name?: string; duration?: number; bytes?: number }): string | null {
  if (c.name && !clipExtension(c.name)) return "Add an MP4, MOV, MKV, WebM or AVI clip";
  if (c.bytes !== undefined && c.bytes > SWAP_STUDIO.maxBytes) return "Keep clips under 200 MB";
  if (c.duration !== undefined && !(c.duration > 0)) return "Couldn't read this clip's length — save it as an MP4 and add it again";
  if (c.duration !== undefined && c.duration > SWAP_STUDIO.maxSeconds + 0.01) return "Trim this clip to 149.66 seconds or less before you add it";
  return null;
}

/**
 * The size the normaliser keeps: the clip's own, on even numbers, at most 2048 px a side (the fit graph's limit;
 * H3 works at 1 MP at most anyway).
 */
export const normalizedSize = (width?: number, height?: number) => filmSize(width, height, "open");

/**
 * The cloud assembly's frame: the clip's own shape on even numbers within fal merge-videos' 512–2048 px (every piece,
 * the clip's own and H3's 480p / 768p takes, is scaled to it before the join). Null when the clip's size is unknown.
 */
export const cloudFilmSize = (width?: number, height?: number) => filmSize(width, height, "cloud");

/** Whether the page needs a copy of a clip to play it (the cloud keeps the upload as filmed; your GPU makes its 24 fps copy anyway). */
export const clipNeedsPreview = (engine: Engine, clip: Pick<SwapClip, "source">) => engine === "cloud" && (clip.source.playable === false || clipExtension(clip.source.name ?? clip.source.url) === "avi");

/** The clip as the page plays it: your GPU's 24 fps copy, the cloud's browser copy, else the upload. */
export const pageClip = (engine: Engine, clip: Pick<SwapClip, "source" | "normalized" | "preview">) => (engine === "open" ? clip.normalized?.url : clip.preview?.url) ?? clip.source.url;

// ---------------------------------------------------------------------------
// Shots

export function newShot(start: number, end: number, defaults: SwapSettings, hasAudio: boolean, rand?: () => number): SwapShot {
  return {
    id: uid("shot-", rand),
    start,
    end,
    mode: "generate",
    speaker: hasAudio ? null : "none",
    dialogue: null,
    prompt: null,
    who: { ...DEFAULT_WHO },
    masks: [],
    approvedMask: null,
    anchors: [],
    approvedAnchor: null,
    anchorInstructions: "",
    anchorBasePrompt: "",
    settings: { ...defaults },
    segments: null,
  };
}

/** What's wrong with a list of cuts for a clip of `frames` frames, or null (whole frames inside the clip). */
export function cutsProblem(cuts: number[], frames: number): string | null {
  if (cuts.some((n) => !Number.isInteger(n))) return "Cut positions must be whole frames";
  if (cuts.some((n) => n <= 0 || n >= frames)) return "Cuts must fall inside the clip";
  return null;
}

export const tidyCuts = (cuts: number[]) => [...new Set(cuts)].sort((a, b) => a - b);

/**
 * The shots of a clip for these cuts. A shot whose frames didn't change keeps everything; a changed one keeps the
 * mode, who to swap, speaker and settings of the old shot it overlaps most, but not what depends on its exact frames
 * (masks, anchors, segments and their takes). `modes` (one per shot) override.
 */
export function shotsFromCuts(clip: Pick<SwapClip, "frames" | "shots" | "source">, cuts: number[], defaults: SwapSettings, modes?: ShotMode[], rand?: () => number): SwapShot[] {
  const bounds = [0, ...tidyCuts(cuts), clip.frames];
  const out: SwapShot[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const [a, b] = [bounds[i], bounds[i + 1]];
    const same = clip.shots.find((s) => s.start === a && s.end === b);
    let shot: SwapShot;
    if (same) shot = same;
    else {
      shot = newShot(a, b, defaults, clip.source.hasAudio, rand);
      const overlap = (s: SwapShot) => Math.min(b, s.end) - Math.max(a, s.start);
      const best = [...clip.shots].filter((s) => overlap(s) > 0).sort((x, y) => overlap(y) - overlap(x))[0];
      if (best) Object.assign(shot, { mode: best.mode, who: { ...best.who }, speaker: best.speaker, settings: { ...best.settings }, anchorInstructions: best.anchorInstructions, anchorBasePrompt: best.anchorBasePrompt });
    }
    if (modes?.[i]) shot = { ...shot, mode: modes[i] };
    out.push(shot);
  }
  return out;
}

/** Add a cut (no-op when it is already there or outside the clip). */
export const addCut = (cuts: number[], frame: number, frames: number) => (frame > 0 && frame < frames && Number.isInteger(frame) ? tidyCuts([...cuts, frame]) : tidyCuts(cuts));
export const removeCut = (cuts: number[], frame: number) => tidyCuts(cuts.filter((c) => c !== frame));

/** Move cut `from` to `to`, keeping it between its neighbours (at least one frame from each). */
export function moveCut(cuts: number[], from: number, to: number, frames: number): number[] {
  const list = tidyCuts(cuts);
  const i = list.indexOf(from);
  if (i < 0) return list;
  const lo = (list[i - 1] ?? 0) + 1;
  const hi = (list[i + 1] ?? frames) - 1;
  if (lo > hi) return list;
  list[i] = clampInt(to, lo, hi);
  return tidyCuts(list);
}

// ---------------------------------------------------------------------------
// Words and speakers

export interface TimedWord {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

/**
 * A transcript's cues as words: a cue's words share its time evenly (the transcribers give caption-sized cues), so a
 * word's middle says which segment it belongs to.
 */
export function cueWords(cues: TranscriptCue[] | null | undefined): TimedWord[] {
  const out: TimedWord[] = [];
  for (const c of cues ?? []) {
    if (!Number.isFinite(c.start) || !Number.isFinite(c.end) || c.end < c.start) continue;
    const words = tidy(c.text).split(" ").filter(Boolean);
    const step = (c.end - c.start) / Math.max(1, words.length);
    words.forEach((w, i) => out.push({ start: c.start + i * step, end: c.start + (i + 1) * step, text: w, ...(c.speaker ? { speaker: c.speaker } : {}) }));
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The words whose middle falls in frames [start, end) of the clip (Akatz: (w.start + w.end) / 2 inside the range). */
export function wordsIn(words: TimedWord[], start: number, end: number): TimedWord[] {
  const a = start / SWAP_STUDIO.fps;
  const b = end / SWAP_STUDIO.fps;
  return words.filter((w) => {
    const mid = (w.start + w.end) / 2;
    return mid >= a && mid < b;
  });
}

export const wordsText = (words: TimedWord[]) => words.map((w) => w.text).join(" ").trim();

/** The voices a transcript names (diarized speakers), in order of first appearance; "voice" when it names none. */
export function voicesOf(cues: TranscriptCue[] | null | undefined): string[] {
  const out: string[] = [];
  for (const c of cues ?? []) {
    const v = c.speaker || "voice";
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** "Voice 1", "Voice 2"… for the transcriber's speaker ids. */
export const voiceLabel = (voices: string[], v: string) => `Voice ${voices.indexOf(v) + 1}`;

/**
 * Who speaks in frames [start, end): the role of the voice with the most words there ("none" when nobody speaks).
 * A voice not marked yet is the selected character (Akatz's default speaker).
 */
export function speakerIn(words: TimedWord[], roles: Record<string, SwapRole>, start: number, end: number): SwapRole {
  const inside = wordsIn(words, start, end);
  if (!inside.length) return "none";
  const count = new Map<string, number>();
  for (const w of inside) count.set(w.speaker || "voice", (count.get(w.speaker || "voice") ?? 0) + 1);
  const top = [...count.entries()].sort((x, y) => y[1] - x[1])[0][0];
  return roles[top] ?? "target";
}

/** A shot's words and speaker: what you set, else the transcript's (frames of the clip). */
export function shotDialogue(clip: SwapClip, shot: SwapShot): string {
  if (shot.dialogue !== null) return shot.dialogue;
  return wordsText(wordsIn(cueWords(clip.transcript?.cues), shot.start, shot.end));
}

export function shotSpeaker(clip: SwapClip, shot: SwapShot): SwapRole {
  if (shot.speaker) return shot.speaker;
  if (!clip.source.hasAudio) return "none";
  if (!clip.transcript?.cues) return "target";
  return speakerIn(cueWords(clip.transcript.cues), clip.transcript.voices, shot.start, shot.end);
}

/** A segment's words and speaker (frames of the shot): its own, else the transcript's for its frames, else the shot's. */
export function segmentDialogue(clip: SwapClip, shot: SwapShot, seg: SwapSegment): string {
  if (seg.dialogue !== null) return seg.dialogue;
  if (!clip.transcript?.cues && shot.dialogue !== null) return shot.dialogue;
  return wordsText(wordsIn(cueWords(clip.transcript?.cues), shot.start + seg.start, shot.start + seg.end));
}

export function segmentSpeaker(clip: SwapClip, shot: SwapShot, seg: SwapSegment): SwapRole {
  if (seg.speaker) return seg.speaker;
  if (shot.speaker || !clip.transcript?.cues || !clip.source.hasAudio) return shotSpeaker(clip, shot);
  const words = cueWords(clip.transcript.cues);
  return wordsIn(words, shot.start + seg.start, shot.start + seg.end).length ? speakerIn(words, clip.transcript.voices, shot.start + seg.start, shot.start + seg.end) : shotSpeaker(clip, shot);
}

// ---------------------------------------------------------------------------
// Prompts (Akatz Labs' performance prompt, MIT, Akatz Labs 2026)

const SPEECH: Record<SwapRole, string> = {
  target: "The selected character is speaking.",
  offscreen: "Speech is offscreen; do not make the selected character speak.",
  other: "Another person is speaking; preserve the selected character’s actual mouth performance.",
  none: "No dialogue; preserve the visible source performance.",
};

const ANCHOR_SENTENCE = "<Picture 2> is the exact first-frame scene and pose anchor.";

/**
 * The shot's performance prompt in H3's reference tags (<Video 1> the clip, <Picture 1> the character, <Picture 2>
 * the anchor, <Audio 1> the clip's sound): who becomes the character, what to keep, who speaks and the shot's words.
 */
export function shotPrompt(description: string, speaker: SwapRole, dialogue: string, anchor = true): string {
  const who = tidy(description).replace(/[.\s]+$/, "") || "the reference character";
  return [
    `Replace only the selected person in <Video 1> with the single character in <Picture 1>: ${who}.`,
    anchor ? ANCHOR_SENTENCE : "",
    "Keep the reference identity and costume throughout. Match source posture, gaze, blinks, facial emotion, mouth movement, hand contacts and camera movement.",
    SPEECH[speaker],
    `Current shot dialogue: "${tidy(dialogue)}".`,
    "<Audio 1> and source video determine exact timing. Do not repeat earlier dialogue or invent words, gestures, people or camera cuts. Retain the scene outside the person region. Output the raw decoded generation.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** "Build shot prompts": the shot's prompt from the character, its speaker and its words. */
export function buildShotPrompt(project: Pick<SwapProject, "character">, clip: SwapClip, shot: SwapShot): string {
  return shotPrompt(project.character.description, shotSpeaker(clip, shot), shotDialogue(clip, shot), shot.settings.useAnchor);
}

/** The continuation history a segment really uses: none when it starts fresh. */
export const effectiveHistory = (seg: Pick<SwapSegment, "connection" | "history">) => (seg.connection === "continue" ? seg.history : 0);

/** The anchor image a segment uses (the shot's approved scene anchor, its own reference, or none). */
export function segmentAnchor(shot: SwapShot, seg: SwapSegment): string | null {
  if (seg.anchorMode === "shot") return shot.settings.useAnchor ? (shot.anchors.find((a) => a.id === shot.approvedAnchor)?.url ?? null) : null;
  if (seg.anchorMode === "custom") return seg.anchors.find((a) => a.id === seg.anchor)?.url ?? null;
  return null;
}

/** What <Picture 2> (and <Picture 3>) are for a segment. */
export function referenceContext(history: number, anchor: boolean): string {
  if (history) {
    return (
      "<Picture 2> is the generated boundary from the preceding segment. Continue its motion and appearance." +
      (anchor ? " <Picture 3> is an additional scene and performance reference for this segment; preserve continuity with the generated boundary." : "")
    );
  }
  return anchor ? ANCHOR_SENTENCE : "";
}

/**
 * The prompt a segment runs with: its exact prompt when you wrote one, else the shot's prompt without the shot-wide
 * words and anchor sentence, what its pictures are, its own words, and its extra direction.
 */
export function segmentPrompt(project: Pick<SwapProject, "character">, clip: SwapClip, shot: SwapShot, seg: SwapSegment): string {
  if (seg.performancePrompt !== null) return seg.performancePrompt;
  const shared = (shot.prompt ?? buildShotPrompt(project, clip, shot))
    .replace(/Current shot dialogue: "[^"]*"\.\s*/, "")
    .replace(ANCHOR_SENTENCE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const context = referenceContext(effectiveHistory(seg), !!segmentAnchor(shot, seg));
  const words = segmentDialogue(clip, shot, seg);
  return [shared, context, `Current segment dialogue: "${tidy(words)}". Follow source audio timing. Earlier reference dialogue is context only; do not repeat it.`, seg.prompt.trim()].filter(Boolean).join("\n\n");
}

/** "Update prompt" for a segment: its full, editable prompt, with its speaker and words in the shot's text. */
export function buildSegmentPrompt(project: Pick<SwapProject, "character">, clip: SwapClip, shot: SwapShot, seg: SwapSegment): string {
  const base = shotPrompt(project.character.description, segmentSpeaker(clip, shot, seg), segmentDialogue(clip, shot, seg), true)
    .replace(ANCHOR_SENTENCE, referenceContext(effectiveHistory(seg), !!segmentAnchor(shot, seg)))
    .replace("Current shot dialogue:", "Current segment dialogue:")
    .replace(/\s{2,}/g, " ")
    .trim();
  return [base, seg.prompt.trim()].filter(Boolean).join("\n\n");
}

/**
 * The prompt in the engine's words. Your GPU's graph reads H3's tags; fal's H3 calls its inputs Video 1, Image 1,
 * Image 2…, has no mask (so "the selected person" becomes who you picked, in words) and gets the clip's sound inside
 * Video 1. `swapPictures`: on the cloud the anchor goes before the boundary frame (Image 2 / Image 3 trade places).
 */
export function enginePrompt(text: string, engine: Engine, who: WhoToSwap, o: { swapPictures?: boolean } = {}): string {
  if (engine === "open") return text;
  let out = text
    .replace(/the selected person/g, whoWords({ who: who.selection, index: who.index, subject: who.words }))
    .replace(/the selected character/g, "the character")
    .replace(/<Audio 1> and source video determine/g, "Video 1's sound and motion determine")
    .replace(/<Video (\d)>/g, "Video $1");
  if (o.swapPictures) out = out.replace(/<Picture 2>/g, "\u0000").replace(/<Picture 3>/g, "<Picture 2>").replace(/\u0000/g, "<Picture 3>");
  return out.replace(/<Picture (\d)>/g, "Image $1");
}

// ---------------------------------------------------------------------------
// Segments

/** The smallest diffusion window that takes a pass of `needed` frames with `history` frames before it, or null. */
export function passWindow(needed: number, history: number): number | null {
  return WINDOW_CHOICES.find((v) => v >= needed && v > history) ?? null;
}

/**
 * The window plan's delivered ranges for `count` frames (H3's plan_windows: the first window has no history, each
 * later one starts on the last frame made and delivers the rest of its window). Akatz's default segment layout.
 */
export function windowRanges(count: number, window: number, history: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let covered = 0;
  while (covered < count) {
    const eh = out.length ? history : 0;
    const start = covered - (eh ? 1 : 0);
    const needed = Math.min(count - start, window);
    const size = WINDOW_CHOICES.find((v) => v >= needed && v > eh) ?? window;
    const end = Math.min(count, start + size);
    if (end <= covered) break;
    out.push({ start: covered, end });
    covered = end;
  }
  return out;
}

export function newSegment(shot: Pick<SwapShot, "settings">, start: number, end: number, index: number, rand?: () => number): SwapSegment {
  return {
    id: uid("seg-", rand),
    start,
    end,
    connection: index ? "continue" : "start",
    history: shot.settings.historyFrames,
    seed: (shot.settings.seed + index) % (SWAP_STUDIO.maxSeed + 1),
    prompt: "",
    performancePrompt: null,
    dialogue: null,
    speaker: null,
    anchorMode: !index && shot.settings.useAnchor ? "shot" : "none",
    anchor: null,
    anchors: [],
    takes: [],
    selectedTake: null,
    needsReview: false,
  };
}

/** A shot's segments: its own layout, or the default one from its window plan (ids stable per range). */
export function currentSegments(shot: SwapShot): SwapSegment[] {
  if (shot.segments) return shot.segments;
  const len = shot.end - shot.start;
  const w = WINDOW_CHOICES.includes(shot.settings.windowFrames) ? shot.settings.windowFrames : CHARACTER_SWAP.window;
  const h = HISTORY_CHOICES.includes(shot.settings.historyFrames) && shot.settings.historyFrames < w ? shot.settings.historyFrames : CHARACTER_SWAP.history;
  return windowRanges(len, w, h).map((r, i) => ({ ...newSegment(shot, r.start, r.end, i), id: `seg-${shot.id.replace(/^shot-/, "")}-${r.start}-${r.end}` }));
}

/** What's wrong with a segment layout for a shot, or null (Akatz's checks, in their words where they exist). */
export function segmentsProblem(shot: Pick<SwapShot, "start" | "end">, items: SwapSegment[], engine?: Engine): string | null {
  if (!items.length || items.length > SWAP_STUDIO.maxSegments) return "Choose between 1 and 1000 segments";
  let covered = 0;
  let chain = 0;
  const ids = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const s = items[i];
    const n = i + 1;
    if (ids.has(s.id)) return "Segment identifiers must be unique";
    ids.add(s.id);
    if (!Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start !== covered || s.end <= s.start) return "Segments must cover the shot in order, without gaps or overlaps";
    if (!i && s.connection !== "start") return "The first segment starts fresh; later segments can continue or start fresh";
    if (s.connection === "start") chain = s.start;
    if (!HISTORY_CHOICES.includes(s.history)) return `Segment ${n}: choose a supported continuation history`;
    const h = effectiveHistory(s);
    if (h > s.start - chain) return `Segment ${n}: history extends before this continuous sequence; reduce history or move the boundary`;
    if (passWindow(s.end - s.start + (h ? 1 : 0), h) === null) return `Segment ${n} must fit one diffusion pass (at most 362 frames, including its continuation boundary)`;
    if (engine === "cloud") {
      const len = s.end - s.start;
      if (len < SWAP_STUDIO.cloudMinFrames || len > SWAP_STUDIO.cloudMaxFrames) return `Segment ${n} is ${secondsLabel(len)}: on the cloud a segment runs 2–15 s (fal's H3 reads 2–15 s of your clip a call)`;
    }
    if (!Number.isInteger(s.seed) || s.seed < 0 || s.seed > SWAP_STUDIO.maxSeed) return `Segment ${n}: use a whole-number seed`;
    if (s.prompt.length > SWAP_STUDIO.maxPromptChars || (s.performancePrompt?.length ?? 0) > SWAP_STUDIO.maxPromptChars || (s.dialogue?.length ?? 0) > SWAP_STUDIO.maxPromptChars) return `Segment ${n}: keep its text under 20,000 characters`;
    covered = s.end;
  }
  if (covered !== shot.end - shot.start) return "Segments must cover the entire shot";
  return null;
}

/** The longest segment the layout offers for the engine (15 s; a cloud call takes 15 s of clip). */
export const layoutFrames = (seconds: number) => Math.round(seconds * SWAP_STUDIO.fps);

export type LayoutOp = { op: "partition"; frames: number } | { op: "split"; frame: number } | { op: "merge"; index: number } | { op: "boundary"; index: number; frame: number };

/**
 * A new layout from an operation (Akatz's layout): partition into equal lengths, split at the playhead, merge at a
 * boundary or move a boundary. A segment whose frames didn't change is kept with its takes; a new one takes its seed,
 * history and direction from the first segment it overlaps (and its connection and anchor when it starts with it),
 * the directions of every overlapped segment, and is marked for review. A continuation can't reach before its
 * sequence: its history shrinks to what is there.
 */
export function applyLayout(shot: SwapShot, op: LayoutOp, rand?: () => number): SwapSegment[] {
  const old = currentSegments(shot);
  const end = shot.end - shot.start;
  let bounds = [0, ...old.map((s) => s.end)];
  if (op.op === "partition") {
    if (!Number.isInteger(op.frames) || op.frames < 1 || op.frames > 361) throw new Error("Choose a segment length of at most 15 seconds");
    bounds = [];
    for (let f = 0; f < end; f += op.frames) bounds.push(f);
    bounds.push(end);
  } else if (op.op === "split") {
    if (!Number.isInteger(op.frame) || op.frame <= 0 || op.frame >= end || bounds.includes(op.frame)) throw new Error("Place the playhead inside a segment to split it");
    bounds = [...bounds, op.frame].sort((a, b) => a - b);
  } else {
    if (!Number.isInteger(op.index) || op.index < 1 || op.index >= old.length) throw new Error("Choose a boundary between segments");
    if (op.op === "merge") bounds.splice(op.index, 1);
    else {
      if (!Number.isInteger(op.frame) || !(bounds[op.index - 1] < op.frame && op.frame < bounds[op.index + 1])) throw new Error("The boundary must stay between its neighbouring boundaries");
      bounds[op.index] = op.frame;
    }
  }
  const out: SwapSegment[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const [a, b] = [bounds[i], bounds[i + 1]];
    const exact = old.find((s) => s.start === a && s.end === b);
    if (exact) {
      out.push({ ...exact });
      continue;
    }
    const overlaps = old.filter((s) => s.end > a && s.start < b);
    const seg = newSegment(shot, a, b, i, rand);
    if (overlaps.length) {
      const first = overlaps[0];
      Object.assign(seg, { seed: first.seed, history: first.history });
      if (a === first.start) Object.assign(seg, { connection: first.connection, anchorMode: first.anchorMode, anchor: first.anchor, anchors: first.anchors });
      seg.prompt = [...new Set(overlaps.map((s) => s.prompt).filter((p) => p.trim()))].join("\n\n");
      for (const key of ["performancePrompt", "dialogue"] as const) {
        const values = [...new Set(overlaps.map((s) => s[key]).filter((v): v is string => v !== null))];
        if (values.length) seg[key] = values.join("\n\n");
      }
      seg.speaker = first.speaker;
      seg.needsReview = !!seg.prompt || seg.performancePrompt !== null || seg.dialogue !== null || seg.speaker !== null;
    }
    out.push(seg);
  }
  let chain = 0;
  out.forEach((seg, i) => {
    if (!i) seg.connection = "start";
    if (seg.connection === "start") chain = seg.start;
    else if (seg.history > seg.start - chain) seg.history = Math.max(...HISTORY_CHOICES.filter((h) => h <= seg.start - chain));
  });
  const problem = segmentsProblem(shot, out);
  if (problem) throw new Error(problem);
  return out;
}

/**
 * The segments a continuation draws its history from, oldest first, with how many frames each gives; never across a
 * fresh start. Throws when the sequence before it is too short.
 */
export function predecessors(items: SwapSegment[], index: number): { segment: SwapSegment; frames: number }[] {
  let needed = effectiveHistory(items[index]);
  const out: { segment: SwapSegment; frames: number }[] = [];
  for (let i = index - 1; i >= 0 && needed > 0; i--) {
    const s = items[i];
    const n = Math.min(needed, s.end - s.start);
    out.push({ segment: s, frames: n });
    needed -= n;
    if (s.connection === "start") break;
  }
  if (needed > 0) throw new Error("Not enough preceding frames in this continuous sequence");
  return out.reverse();
}

export const dependencies = (items: SwapSegment[], index: number): TakeDependency[] => predecessors(items, index).map(({ segment, frames }) => ({ segmentId: segment.id, takeId: segment.selectedTake, frames }));

export const takeOf = (seg: SwapSegment, id?: string | null) => seg.takes.find((t) => t.id === (id ?? seg.selectedTake)) ?? null;

/**
 * The shot's approved mask version, on `engine` when one is named: a version made on the other engine doesn't count
 * there (a cloud mask is pieces of the clip as filmed, your GPU's one whole-shot mask at 24 fps).
 */
export function approvedMask(shot: SwapShot, engine?: Engine): MaskVersion | null {
  const m = shot.masks.find((x) => x.id === shot.approvedMask) ?? null;
  return m && (!engine || m.engine === engine) ? m : null;
}

/**
 * The version a new mask job corrects when none is named: the approved one, else the newest finished one — made on
 * this engine (a version from the other engine can't be spliced into).
 */
export function defaultMaskBase(shot: SwapShot, engine: Engine): MaskVersion | null {
  const finished = (m: MaskVersion) => m.engine === engine && m.pieces.every((x) => x.url);
  const approved = approvedMask(shot, engine);
  return approved && finished(approved) ? approved : ([...shot.masks].reverse().find(finished) ?? null);
}

/** Everything a take's result depends on: a take whose signature differs from its segment's is stale. */
export function settingSignature(project: SwapProject, clip: SwapClip, shot: SwapShot, seg: SwapSegment, engine: Engine = project.engine): string {
  const mask = engine === "open" && shot.settings.useMask ? (approvedMask(shot, engine)?.pieces.map((p) => p.url ?? p.genId) ?? null) : null;
  return digest({
    engine,
    source: clip.normalized?.url ?? clip.source.url,
    reference: project.character.image,
    shotStart: shot.start,
    segment: { id: seg.id, start: seg.start, end: seg.end, connection: seg.connection, history: effectiveHistory(seg), seed: seg.seed },
    prompt: segmentPrompt(project, clip, shot, seg),
    anchor: segmentAnchor(shot, seg),
    settings: { lora: shot.settings.lora, useMask: engine === "open" ? shot.settings.useMask : false, renderMp: shot.settings.renderMp, expansion: engine === "open" ? shot.settings.expansion : 0 },
    // Who to swap: the words and selection, unless an approved mask says it (your GPU).
    who: mask ? null : shot.who,
    mask,
  });
}

export interface SegmentState {
  id: string;
  /** ready: the selected take matches the settings and what it continues from; stale: it doesn't; empty: no take. */
  status: "ready" | "stale" | "empty";
  /** A segment it continues from has no current take. */
  blocked: boolean;
  dialogue: string;
  speaker: SwapRole;
  prompt: string;
  dependencies: TakeDependency[];
  /** The pass's window (frames). */
  windowFrames: number | null;
}

export function segmentStates(project: SwapProject, clip: SwapClip, shot: SwapShot, items: SwapSegment[] = currentSegments(shot)): SegmentState[] {
  const out: SegmentState[] = [];
  items.forEach((seg, i) => {
    let deps: TakeDependency[] = [];
    let broken = false;
    try {
      deps = dependencies(items, i);
    } catch {
      broken = true;
    }
    const chosen = takeOf(seg);
    const staleParent = deps.some((d) => {
      const j = items.findIndex((s) => s.id === d.segmentId);
      return j >= 0 && out[j]?.status !== "ready";
    });
    const done = !!chosen && chosen.state === "launched";
    const sameDeps = !!chosen && stableJson(chosen.dependencies) === stableJson(deps);
    const ready = done && chosen!.signature === settingSignature(project, clip, shot, seg) && sameDeps && !staleParent && !broken;
    const h = effectiveHistory(seg);
    out.push({
      id: seg.id,
      status: ready ? "ready" : chosen ? "stale" : "empty",
      blocked: broken || deps.some((d) => !d.takeId) || staleParent,
      dialogue: segmentDialogue(clip, shot, seg),
      speaker: segmentSpeaker(clip, shot, seg),
      prompt: segmentPrompt(project, clip, shot, seg),
      dependencies: deps,
      windowFrames: passWindow(seg.end - seg.start + (h ? 1 : 0), h),
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Queueing segments

export type QueueMode = "segment" | "from" | "all";

export interface QueueEntry {
  index: number;
  segment: SwapSegment;
  /** Earlier segments of this same queue it continues from (it waits for their takes). */
  waitsOn: string[];
  dependencies: TakeDependency[];
}

/**
 * Which segments a "Queue segment / Queue from here / Queue all segments" makes takes for, and what each waits on
 * (Akatz's freeze): a segment already being made is skipped (or refused when asked for alone), "from here" and "all"
 * skip segments that are already current, and a continuation whose segment before it isn't in the queue needs that
 * segment's current take (your GPU: its lossless master).
 */
export function planQueue(
  project: SwapProject,
  clip: SwapClip,
  shot: SwapShot,
  segmentId: string,
  mode: QueueMode,
  o: { active: (take: SwapTake) => boolean; hasMaster?: (take: SwapTake) => boolean },
): { entries: QueueEntry[] } | { problem: string } {
  const engine = project.engine;
  if (shot.mode !== "generate") return { problem: "This shot keeps its original — switch it to Replace character first" };
  if (!project.character.image) return { problem: "Add a picture of your character first" };
  const items = currentSegments(shot);
  const layout = segmentsProblem(shot, items, engine);
  if (layout) return { problem: layout };
  if (engine === "open" && !clip.normalized?.url) return { problem: "The clip is still being prepared at 24 fps — wait for it, then queue" };
  const start = items.findIndex((s) => s.id === segmentId);
  if (start < 0) return { problem: "That segment is no longer in this shot — reload" };
  const states = segmentStates(project, clip, shot, items);
  const busy = (s: SwapSegment) => s.takes.some((t) => t.state === "waiting" || (t.state === "launched" && o.active(t)));
  let indices = mode === "segment" ? [start] : Array.from({ length: items.length - (mode === "all" ? 0 : start) }, (_, i) => i + (mode === "all" ? 0 : start));
  if (mode === "segment" && busy(items[start])) return { problem: "This segment is already queued or generating" };
  if (mode !== "segment") indices = indices.filter((i) => !busy(items[i]) && states[i].status !== "ready");
  if (!indices.length) return { problem: "These segments are already current, queued or generating" };
  const queued = new Set(indices);
  const mask = approvedMask(shot, engine);
  const entries: QueueEntry[] = [];
  for (const i of indices) {
    const seg = items[i];
    const n = i + 1;
    // "Scene anchor" off in the shot's settings: a segment set to the scene anchor runs without one.
    const wantsAnchor = seg.anchorMode === "custom" || (seg.anchorMode === "shot" && shot.settings.useAnchor);
    if (wantsAnchor && !segmentAnchor(shot, seg)) {
      return { problem: seg.anchorMode === "shot" ? `Segment ${n}: approve a scene anchor, or choose no anchor` : `Segment ${n}: pick its reference image, or choose no anchor` };
    }
    if (engine === "open" && shot.settings.useMask && mask && mask.pieces.some((p) => !p.url)) return { problem: "The approved mask is still being made — wait for it" };
    const waitsOn: string[] = [];
    let deps: TakeDependency[];
    try {
      deps = dependencies(items, i);
    } catch (e) {
      return { problem: `Segment ${n}: ${(e as Error).message.toLowerCase()}` };
    }
    // Your GPU continues from the segment before it: its take's lossless master holds that segment's frames only.
    if (engine === "open" && deps.length > 1) {
      return { problem: `Segment ${n}: its ${effectiveHistory(seg)} frames of history reach back past segment ${n - 1} — on your GPU a continuation reads the segment before it; shorten the history or lengthen segment ${n - 1}` };
    }
    for (const d of deps) {
      const j = items.findIndex((s) => s.id === d.segmentId);
      if (queued.has(j)) {
        waitsOn.push(d.segmentId);
        continue;
      }
      const chosen = takeOf(items[j]);
      if (states[j].status !== "ready" || !chosen) return { problem: `Generate segment ${j + 1} first, or queue from an earlier segment` };
      if (engine === "open" && o.hasMaster && !o.hasMaster(chosen)) return { problem: `Segment ${j + 1}'s take has no lossless master to continue from — make it again on your GPU` };
      const kept = chosen.frozen?.keep ?? items[j].end - items[j].start;
      if (engine === "open" && kept < d.frames) return { problem: `Segment ${j + 1}'s take kept its last ${kept} frame${kept === 1 ? "" : "s"} to continue from — use at most ${kept} frames of history, or make segment ${j + 1} again` };
      if (chosen.engine !== engine) return { problem: `Segment ${j + 1}'s take was made on the ${chosen.engine === "open" ? "open engine" : "cloud"} — make it again on this engine to continue from it` };
    }
    entries.push({ index: i, segment: seg, waitsOn, dependencies: deps });
  }
  return { entries };
}

/**
 * How many of a take's last frames its lossless master keeps (your GPU): the most the segment after it can read as
 * history — its own history when it continues, the shot's history for a layout made later — and at most the segment.
 * A 16-bit master of a whole segment runs to hundreds of MB, more than ComfyUI takes as an upload by default (100 MB);
 * the next segment reads only these frames.
 */
export function masterKeep(items: SwapSegment[], index: number, settings: Pick<SwapSettings, "historyFrames">): number {
  const seg = items[index];
  const next = items[index + 1];
  return Math.min(seg.end - seg.start, Math.max(1, settings.historyFrames, next ? effectiveHistory(next) : 0));
}

/** A segment's take as queued now: what it will run with (see FrozenTake). */
export function freezeTake(project: SwapProject, shot: SwapShot, seg: SwapSegment): FrozenTake {
  const mask = project.engine === "open" && shot.settings.useMask ? (approvedMask(shot, "open")?.pieces[0]?.url ?? null) : null;
  return {
    reference: project.character.image ?? "",
    shotStart: shot.start,
    start: seg.start,
    end: seg.end,
    history: effectiveHistory(seg),
    anchor: segmentAnchor(shot, seg),
    mask,
    settings: { ...shot.settings },
    who: { ...shot.who },
  };
}

// ---------------------------------------------------------------------------
// Jobs as the page sees them

export type GenStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

/** A generation as the project view reports it. */
export interface GenSummary {
  status: GenStatus;
  progress: number | null;
  message: string | null;
  error: string | null;
  /** The main output, and (your GPU's takes) the lossless master. */
  url?: string;
  master?: string;
  costUsd: number | null;
  demo: boolean;
}

export type JobStatus = "waiting" | "stopped" | GenStatus | "missing";

/**
 * One job (a take, a mask, an anchor, an assembly) from its generations: the final one's state, unless a step before it
 * failed (its error is the reason) — progress counts the steps done.
 */
export function jobState(finalId: string | undefined, stepIds: string[] | undefined, gens: Record<string, GenSummary | undefined>): { status: JobStatus; progress: number | null; message: string | null } {
  if (!finalId) return { status: "missing", progress: null, message: null };
  const final = gens[finalId];
  if (!final) return { status: "missing", progress: null, message: "This job is gone from the Library" };
  const steps = (stepIds?.length ? stepIds : [finalId]).map((id) => gens[id]).filter((g): g is GenSummary => !!g);
  const failed = steps.find((g) => g.status === "failed" && g.error);
  if (final.status === "failed" || final.status === "canceled") return { status: final.status, progress: null, message: failed?.error ?? final.error ?? final.message };
  if (final.status === "succeeded") return { status: "succeeded", progress: 1, message: null };
  const done = steps.filter((g) => g.status === "succeeded").length;
  const running = steps.find((g) => g.status === "running");
  const progress = steps.length > 1 ? (done + (running?.progress ?? 0)) / steps.length : final.progress;
  return { status: running || final.status === "running" ? "running" : "queued", progress, message: running?.message ?? final.message };
}

// ---------------------------------------------------------------------------
// What the API answers (src/server/swap-studio.ts)

export interface SwapProjectCard {
  id: string;
  name: string;
  engine: Engine;
  clips: number;
  shots: number;
  swapped: number;
  assembled: number;
  waiting: number;
  character: string | null;
  updatedAt: number;
}

export interface SwapProjectView {
  project: SwapProject;
  /** Every generation the project names. */
  gens: Record<string, GenSummary>;
  /** Akatz's "Finish" stage and the workers note, said on the page. */
  workers: string;
}

export interface StudioEstimate {
  engine: Engine;
  /** Runs as a demo (no provider for it): nothing is paid for. */
  demo: boolean;
  /** Your GPU: nothing to pay. */
  free: boolean;
  /** One take of each generated segment (null: price unknown, or it can't run yet — see `problems`). */
  segments: Record<string, number | null>;
  problems: Record<string, string>;
  /** "Queue all" for each shot: the segments that aren't current. */
  shots: Record<string, { costUsd: number | null; segments: number }>;
  /** Every shot's "Queue all", across the project. */
  project: { costUsd: number | null; segments: number };
  assembly: Record<string, number | null>;
  transcribe: Record<string, number | null>;
  /** Tracking a whole shot's mask. */
  mask: Record<string, number | null>;
  /**
   * Sharpen for each clip: its chosen takes, their seconds, and what each size costs for all of them (null: unknown or
   * not offered; your GPU: 0).
   */
  sharpen: Record<string, { takes: number; seconds: number; costUsd: Partial<Record<SharpenTier, number | null>>; problem?: string }>;
  /** One anchor with each model on this engine. */
  anchors: { id: string; label: string; note: string; costUsd: number | null; offered: boolean }[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// Masks

/** The mask piece covering a frame of the shot: the newest piece that holds it. */
export function maskPieceAt(version: MaskVersion | null | undefined, frame: number): MaskPiece | null {
  if (!version) return null;
  for (let i = version.pieces.length - 1; i >= 0; i--) {
    const p = version.pieces[i];
    if (frame >= p.from && frame < p.from + p.frames) return p;
  }
  return null;
}

/**
 * The pieces of a new version (the cloud keeps the corrected version's pieces under the new one). `offset`: where the
 * new piece's first frame is in its video (a cloud Update frame near the clip's end reads frames before it).
 */
export function maskPieces(engine: Engine, kind: MaskVersion["kind"], frame: number, shotFrames: number, base: MaskVersion | null, offset = 0): MaskPiece[] {
  const piece: MaskPiece = { ...(kind === "frame" ? { from: frame, frames: 1 } : { from: frame, frames: shotFrames - frame }), ...(offset > 0 ? { offset } : {}) };
  // Your GPU splices the new part into the corrected version: one whole-shot mask.
  if (engine === "open") return [{ from: 0, frames: shotFrames }];
  return [...(base?.pieces ?? []).filter((p) => p.url || p.genId), piece];
}

/** What stops a mask job, or null. */
export function maskProblem(engine: Engine, kind: MaskVersion["kind"], frame: number, shotFrames: number, points: PixelPoint[], who: WhoToSwap, base: MaskVersion | null): string | null {
  if (!Number.isInteger(frame) || frame < 0 || frame >= shotFrames) return "Pick a frame inside the shot";
  if (points.length > SWAP_STUDIO.maxPoints) return `Use at most ${SWAP_STUDIO.maxPoints} points`;
  if (points.length && !points.some((p) => p.label !== "negative")) return "Add at least one include point (exclude points only narrow it)";
  if (!points.length && !tidy(who.words)) return "Say who to look for (“person”), or click them";
  if (kind === "frame" && !base) return "Track the shot first — Update frame corrects one frame of a mask";
  if (kind === "frame" && engine === "open" && !points.length) return "Click the person on this frame to correct it";
  if (base && base.engine !== engine) return "That mask was made on the other engine — track the shot again here";
  return null;
}

const GB = 2 ** 30;

/**
 * Your GPU's mask graph holds the whole shot as float frames at H3's canvas size: the prepared shot, SAM's masks as
 * pictures and the joined result — and, correcting a version, that version decoded, fitted and cut around the new part
 * as well. Why a ComfyUI with `ramBytes` of RAM can't take this shot (half of it may go to frames, as for the other
 * whole-clip graphs); null when it fits or the clip's size is unknown.
 */
export function maskMemoryProblem(m: { width?: number; height?: number; quality: string | undefined; shotFrames: number; correcting: boolean }, ramBytes: number | undefined): string | null {
  if (!m.width || !m.height || !(m.shotFrames > 0)) return null;
  const canvas = h3Canvas(m.width, m.height, m.quality);
  const need = canvas.width * canvas.height * 12 * m.shotFrames * (m.correcting ? 6 : 3);
  const budget = wholeClipBudget(ramBytes);
  if (need <= budget) return null;
  return (
    `A mask on your GPU holds the whole shot in memory: this ${secondsLabel(m.shotFrames)} shot needs about ${Math.ceil(need / GB)} GB of RAM and this ComfyUI can spare ${Math.floor(budget / GB)} GB. ` +
    `Cut the shot shorter (Shots → Cut at the playhead)${m.quality === "768p" ? ", or track it at 0.5 MP" : ""}`
  );
}

// ---------------------------------------------------------------------------
// Takes and review

export function selectTake(seg: SwapSegment, takeId: string): SwapSegment {
  const t = takeOf(seg, takeId);
  if (!t) throw new Error("That take is gone");
  if (t.state !== "launched") throw new Error("That take didn't run");
  return { ...seg, selectedTake: takeId };
}

export function updateTake(seg: SwapSegment, takeId: string, patch: Partial<Pick<SwapTake, "favourite" | "decision" | "notes">>): SwapSegment {
  if (!takeOf(seg, takeId)) throw new Error("That take is gone");
  if (patch.notes !== undefined && patch.notes.length > SWAP_STUDIO.maxNotesChars) throw new Error("Keep notes under 2,000 characters");
  return { ...seg, takes: seg.takes.map((t) => (t.id === takeId ? { ...t, ...patch } : t)) };
}

/** Taking a take away: a selected one leaves the segment without a selection. */
export function removeTake(seg: SwapSegment, takeId: string): SwapSegment {
  return { ...seg, takes: seg.takes.filter((t) => t.id !== takeId), selectedTake: seg.selectedTake === takeId ? null : seg.selectedTake };
}

/** A finished take becomes the selection when nothing changed since it was queued (Akatz's attach_take). */
export function autoSelect(project: SwapProject, clip: SwapClip, shot: SwapShot, seg: SwapSegment, take: SwapTake, items: SwapSegment[]): boolean {
  if (seg.selectedTake !== (take.replaces ?? null)) return false;
  const i = items.findIndex((s) => s.id === seg.id);
  let deps: TakeDependency[] = [];
  try {
    deps = dependencies(items, i);
  } catch {
    return false;
  }
  return take.signature === settingSignature(project, clip, shot, seg, take.engine) && stableJson(take.dependencies) === stableJson(deps);
}

export interface DecisionExport {
  project: string;
  exportedAt: string;
  clips: {
    clip: string;
    review: Decision;
    notes: string;
    assembled: boolean;
    shots: {
      shot: number;
      frames: [number, number];
      mode: ShotMode;
      segments: { segment: number; frames: [number, number]; selectedTake: string | null; takes: { take: string; favourite: boolean; decision: Decision; notes: string; seed: number; video?: string }[] }[];
    }[];
  }[];
}

/** "Export decisions": every clip's review and every take's favourite, decision and notes, as JSON. */
export function exportDecisions(project: SwapProject, videoOf: (take: SwapTake) => string | undefined, now = new Date()): DecisionExport {
  return {
    project: project.name,
    exportedAt: now.toISOString(),
    clips: project.clips.map((c) => ({
      clip: c.name,
      review: c.review,
      notes: c.reviewNotes,
      assembled: !!c.assembly?.genId,
      shots: c.shots.map((s, si) => ({
        shot: si + 1,
        frames: [s.start, s.end] as [number, number],
        mode: s.mode,
        segments:
          s.mode === "generate"
            ? currentSegments(s).map((g, gi) => ({
                segment: gi + 1,
                frames: [s.start + g.start, s.start + g.end] as [number, number],
                selectedTake: g.selectedTake,
                takes: g.takes.map((t) => ({ take: t.id, favourite: t.favourite, decision: t.decision, notes: t.notes, seed: t.seed, ...(videoOf(t) ? { video: videoOf(t) } : {}) })),
              }))
            : [],
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Assembly

/** One part of the assembled clip: kept frames of the clip, or a segment's chosen take. */
export type AssemblyPiece = { kind: "source"; start: number; end: number } | { kind: "take"; start: number; end: number; take: SwapTake; segmentId: string };

/**
 * The clip's timeline for the assembly: kept shots as they were filmed (neighbours merged into one piece), swapped
 * shots as their segments' chosen takes, in order. Every swapped segment needs a chosen take that came out (Akatz's
 * assemble: a selected take for every generated shot); one made with settings that changed since is used as it is and
 * named in `stale`, for the page to say.
 */
export function assemblyPieces(project: SwapProject, clip: SwapClip): { pieces: AssemblyPiece[]; stale: string[] } | { problem: string } {
  if (!clip.shots.length) return { problem: "Confirm the clip's shots first" };
  if (!clip.shots.some((s) => s.mode === "generate")) return { problem: "No shot replaces the character — mark at least one shot Replace character" };
  const pieces: AssemblyPiece[] = [];
  const stale: string[] = [];
  for (const [si, shot] of clip.shots.entries()) {
    if (shot.mode === "preserve") {
      const last = pieces.at(-1);
      if (last?.kind === "source" && last.end === shot.start) last.end = shot.end;
      else pieces.push({ kind: "source", start: shot.start, end: shot.end });
      continue;
    }
    const items = currentSegments(shot);
    const states = segmentStates(project, clip, shot, items);
    for (const [gi, seg] of items.entries()) {
      const t = takeOf(seg);
      if (!t || t.state !== "launched") return { problem: `Shot ${si + 1}, segment ${gi + 1} has no chosen take — generate it, or choose one in Takes & review` };
      if (states[gi].status !== "ready") stale.push(`Shot ${si + 1}, segment ${gi + 1}`);
      pieces.push({ kind: "take", start: shot.start + seg.start, end: shot.start + seg.end, take: t, segmentId: seg.id });
    }
  }
  return { pieces, stale };
}

/** The sharper version a take is assembled with, when one is picked. */
export const usedFinish = (take: Pick<SwapTake, "finish">) => (take.finish?.use ? take.finish : null);

/** The takes an assembly is made of (its identity: the same takes, and the same sharper versions, need no new assembly). */
export const assemblyTakes = (pieces: AssemblyPiece[]) => pieces.flatMap((p) => (p.kind === "take" ? [usedFinish(p.take) ? `${p.take.id}@${usedFinish(p.take)!.id}` : p.take.id] : []));

/** The chosen takes Sharpen works on: every swapped segment's, in the assembly's order. */
export const chosenTakes = (pieces: AssemblyPiece[]) => pieces.flatMap((p) => (p.kind === "take" ? [p] : []));

// ---------------------------------------------------------------------------
// From Genjutsu

export interface HandOffInput {
  engine: Engine;
  /** The clip Genjutsu has (its upload once it is done). */
  clip?: { url?: string; name: string; size?: number; duration?: number; width?: number; height?: number } | null;
  /** The character's picture (an upload) and description. */
  image?: string | null;
  description?: string;
}

/**
 * "Open in Character Swap Studio" from Genjutsu's Character swap: a project on the same engine with the character
 * already in it, and the whole clip (the studio cuts it into shots), when Genjutsu has them uploaded.
 */
export function studioHandOff(o: HandOffInput): {
  project: { name: string; engine: Engine; character: { image: string | null; description: string } };
  clip: { url: string; name: string; bytes?: number; duration?: number; width?: number; height?: number } | null;
} {
  const file = o.clip?.url?.startsWith("/api/files/") ? o.clip : null;
  const name = file ? file.name.replace(/\.[a-z0-9]{2,4}$/i, "").trim().slice(0, SWAP_STUDIO.maxNameChars) : "";
  return {
    project: {
      name: name || "Character swap",
      engine: o.engine,
      character: { image: o.image?.startsWith("/api/files/") ? o.image : null, description: tidy(o.description).slice(0, SWAP_STUDIO.maxDescriptionChars) },
    },
    clip: file
      ? {
          url: file.url!,
          name: file.name,
          ...(file.size !== undefined ? { bytes: file.size } : {}),
          ...(file.duration !== undefined ? { duration: file.duration } : {}),
          ...(file.width !== undefined ? { width: file.width } : {}),
          ...(file.height !== undefined ? { height: file.height } : {}),
        }
      : null,
  };
}


/** Where Akatz's GPU workers went: Fuobe's ComfyUI connection (and its isolated worker); no SSH workers. */
export const WORKERS_NOTE = "Runs on your ComfyUI (Settings → ComfyUI).";
