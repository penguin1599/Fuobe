/**
 * Genjutsu's Character swap (Openjutsu and Akatz Labs' H3 Character Swap tool, docs/research/openjutsu-6.md): the person
 * in a 5–15 s part of a clip becomes the character in one image, keeping the performance, the scene and the clip's own
 * sound. On your GPU it is MiniMax H3 with Akatz Labs' Character Swap LoRA on the h3_character_swap node pack (SAM 3.1
 * finds the person on the part's first frame and H3 regenerates only them, in 124-frame windows with 18 frames of
 * history); in the cloud it is fal's MiniMax H3 reference-to-video with the same LoRA (no mask: who to swap is said in
 * words). An optional "anchor" first frame (the part's first frame with the character already in it, made by an image
 * edit) starts the swap off right; when it can't be made the swap runs without it.
 *
 * Pure module: limits, prompts, the H3 window plan, who to swap, the anchor's prompt and models, licences as data.
 * The prompts follow Openjutsu's (MIT, Comfy Org 2026) and Akatz Labs' anchor brief (MIT, Akatz Labs 2026).
 */
import { isSharpenTier, type SharpenTier } from "./sharpen";
import type { Engine, LoraRef, PixelPoint } from "./types";

export const CHARACTER_SWAP = {
  /** One H3 call: Openjutsu's part picker (Start 0 … duration − 5 s, Length 5 … 15 s). */
  minSeconds: 5,
  maxSeconds: 15,
  /** Longer parts continue window by window (your GPU) or run as 15 s pieces joined with the sound (cloud). */
  maxContinued: 30,
  /** "Choose a clip at least 5 seconds long." Genjutsu's own upload limit (Openjutsu's is 100 MB). */
  maxBytes: 200 * 1024 * 1024,
  maxDirectionChars: 500,
  maxDescriptionChars: 500,
  /** Seeds Openjutsu takes (uint32); blank is random. */
  maxSeed: 2 ** 32 - 1,
  /** H3's two sizes: every swap is made at one of them. */
  qualities: ["480p", "768p"] as const,
  defaultQuality: "768p" as const,
  /** The sizes a 768p swap is finished at (sharpen.ts): regenerated on your GPU, made at 2K / 4K by fal in the cloud. */
  finishes: ["1080p", "2K", "4K"] as const,
  /** H3's frame rate: every part is normalised to 24 fps before it is swapped. */
  fps: 24,
  window: 124,
  history: 18,
  /** H3's documented range ends near 362 frames (15 s): past it the pack prints "Long clip: beyond … trained range". */
  trainedFrames: 362,
  maskGrow: 64,
  maxPeople: 8,
  accept: "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp",
} as const;

export type CharacterQuality = (typeof CHARACTER_SWAP.qualities)[number];
/** A quality the page offers: H3's own two, or a finishing size of the 768p swap. */
export type CharacterChoice = CharacterQuality | (typeof CHARACTER_SWAP.finishes)[number];

/** Who to swap when several people are on screen (the pack's SelectSubject). */
export type SwapWho = "largest" | "leftmost" | "rightmost" | "index";
/** Akatz Labs' speaker choice for the performance prompt. */
export type SwapSpeech = "character" | "other" | "offscreen" | "none";
/** Character Swap LoRA releases: V1.5 (Akatz's recommended release), V1, or none (H3 with the Turbo LoRA only). */
export type SwapLora = "v1.5" | "v1" | "none";

export const WHO_LABELS: Record<SwapWho, string> = { largest: "Largest", leftmost: "Leftmost", rightmost: "Rightmost", index: "Person #" };
/**
 * What "Person #n" counts, per engine: fal's prompt names the nth person from the left; the open graph's SelectSubject
 * takes SAM 3.1's nth detection, and SAM orders its detections by confidence (the surest first), not by position.
 */
export const WHO_INDEX_LABEL: Record<Engine, { label: string; hint: string }> = {
  cloud: { label: "Person number, from the left", hint: "Said in the prompt" },
  open: { label: "Detection number", hint: "In SAM 3.1's order: the person it is surest of first, not left to right — for a position, pick Leftmost or Rightmost, or click them" },
};
export const SPEECH_LABELS: Record<SwapSpeech, { label: string; hint: string }> = {
  character: { label: "My character speaks", hint: "Lips follow the clip's own voice" },
  other: { label: "Someone else speaks", hint: "The character listens" },
  offscreen: { label: "Offscreen voice", hint: "The voice isn't anyone on screen" },
  none: { label: "No dialogue", hint: "Nobody speaks in this part" },
};

/** The Character Swap LoRA files (Hugging Face akatz-ai/MiniMax-H3-Character-Swap-LoRA at the researched revisions). */
export const SWAP_LORAS: Record<Exclude<SwapLora, "none">, { label: string; file: string; url: string; bytes: number }> = {
  "v1.5": {
    label: "V1.5 (recommended)",
    file: "h3_character_swap_v1.5.safetensors",
    url: "https://huggingface.co/akatz-ai/MiniMax-H3-Character-Swap-LoRA/resolve/d06323b7c8e70e97cdab48b78a1e05f786c8cba9/h3_character_swap_v1.5.safetensors",
    bytes: 155_110_792,
  },
  v1: {
    label: "V1",
    file: "h3_character_swap_pro4500_1000.safetensors",
    url: "https://huggingface.co/akatz-ai/MiniMax-H3-Character-Swap-LoRA/resolve/a665bb7e3bb9804e487d2925f67744f554c8ad49/h3_character_swap_pro4500_1000.safetensors",
    bytes: 155_110_320,
  },
};

const H3_LORA_LICENCE = { commercial: true, hostedOk: true, snapshotDate: "2026-10-27", name: "MiniMax H3 Community License" };

/**
 * The swap LoRA a run carries (fal loads it by its pinned Hugging Face URL; ComfyUI gets the file downloaded). "none"
 * has no file: the open graph runs H3 with the Turbo LoRA alone, and fal's route (which needs a LoRA) refuses it
 * (CLOUD_NO_LORA) rather than quietly running V1.5.
 */
export function swapLoraRef(lora: Exclude<SwapLora, "none"> | undefined): LoraRef {
  const l = SWAP_LORAS[lora === "v1" ? "v1" : "v1.5"];
  return { file: l.file, url: l.url, weightName: l.file, strength: 1, version: l.url.split("/resolve/")[1]?.split("/")[0], licence: H3_LORA_LICENCE };
}

/** fal's H3 + LoRA route takes 1–3 LoRAs: "no swap LoRA" is the open graph's choice only. */
export const CLOUD_NO_LORA = "On the cloud, fal's H3 route runs with a swap LoRA — pick V1.5 or V1 (no LoRA runs on your GPU)";

/** lightx2v's FL2V Turbo 8-step LoRA the open graphs load (Apache-2.0 at this revision). */
export const TURBO_LORA: LoraRef = {
  file: "minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
  url: "https://huggingface.co/lightx2v/Minimax-h3-Turbo/resolve/3ec17a324ced54151364f24f8b5fb6bf7e26414f/minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
  version: "3ec17a324ced54151364f24f8b5fb6bf7e26414f",
  licence: { commercial: true, hostedOk: true, snapshotDate: "2026-10-27", name: "Apache-2.0" },
};

/** The ComfyUI workflows of the Character swap (and Character Swap Studio's one-pass segment, on H3 Relay). */
export const H3_WORKFLOWS = ["video-character-swap-h3", "video-character-swap-h3-relay", "video-character-swap-h3-segment"] as const;

/** Remove object's "Remove a person (H3)": H3 Relay's Person Removal graph (docs/research/openjutsu-6.md §4.4). */
export const H3_REMOVAL_WORKFLOW = "video-person-remove-h3-relay";

/** Akatz Labs' Person Remover V1 LoRA (Hugging Face akatz-ai/MiniMax-H3-Person-Remover-LoRA at the researched revision). */
export const PERSON_REMOVER_LORA: LoraRef = {
  file: "H3-Person-Remover-V1.safetensors",
  url: "https://huggingface.co/akatz-ai/MiniMax-H3-Person-Remover-LoRA/resolve/fe136b3dc93aea993b9f194d48ea9859fdc2de14/H3-Person-Remover-V1.safetensors",
  version: "fe136b3dc93aea993b9f194d48ea9859fdc2de14",
  licence: { commercial: true, hostedOk: true, snapshotDate: "2026-10-27", name: "MiniMax H3 Community License" },
};

/**
 * The LoRA files a Character swap graph loads itself (not injected: its own loaders name them), so a run can download
 * the ones ComfyUI lacks before it starts: the Turbo LoRA and the swap LoRA's release (none: only Turbo).
 */
export function graphLoras(endpoint: string, extra: Record<string, unknown> | undefined): LoraRef[] {
  if (endpoint === H3_REMOVAL_WORKFLOW) return [PERSON_REMOVER_LORA];
  if (!(H3_WORKFLOWS as readonly string[]).includes(endpoint)) return [];
  const lora = extra?.lora;
  return lora === "none" ? [TURBO_LORA] : [TURBO_LORA, swapLoraRef(lora === "v1" ? "v1" : "v1.5")];
}

/** The settings of one swap (the body's `character`, all optional: the defaults are Openjutsu's and Akatz's). */
export interface CharacterOptions {
  who?: SwapWho;
  /** Person #n, from 0 (the pack's index). */
  index?: number;
  /** What SAM 3.1 looks for ("person"; "the man in the red jacket" picks among several). */
  subject?: string;
  /** Pixels the person's mask grows by (0–256). */
  maskGrow?: number;
  /** The anchor first frame (on by default). */
  anchor?: boolean;
  /** The image model that makes it (the engine's choice by default, ANCHOR_MODELS). */
  anchorModel?: string;
  /** What the character looks like, in words (Akatz found generic prompts weak). */
  description?: string;
  speech?: SwapSpeech;
  /** The part's words (a transcript), for the performance prompt. */
  dialogue?: string;
  lora?: SwapLora;
  /** H3's audio guide: the clip's own sound conditions the performance (the result keeps the sound either way). */
  audioGuide?: boolean;
  /** Masked regeneration (off: the whole frame is regenerated). */
  useMask?: boolean;
  /** Advanced: H3's window and continuation history (frames). */
  windowFrames?: number;
  historyFrames?: number;
  /** 1080p / 2K / 4K on your GPU: the regenerate's start noise (sharpen.ts; for evaluations, the page leaves it). */
  sharpenSigma?: number;
  /**
   * Group swap (2–4 characters): who each character replaces, in words (index = the character), and where they were
   * tapped on the part's first frame (0–1 of its width and height; only an aid for writing the words).
   */
  people?: { role: string; pin?: { x: number; y: number } }[];
  /** Group swap with exactly 2 characters: a pass for each person (sharper, about twice as long). */
  onePerPerson?: boolean;
  /** Group swap: hats and big hair are masked too (a little slower). */
  hats?: boolean;
  /** Group swap: mouths follow the sound (on by default; off for music clips where nobody sings). */
  mouthsFollowSound?: boolean;
  /** Group swap: how far the redrawn area reaches past each person. */
  edge?: "tight" | "normal" | "loose";
  /** Group swap: the motion reference's long edge (512 standard, 768 high). */
  motionDetail?: 512 | 768;
}

/** Who becomes who: the words a tap on the part's first frame writes (where the person stands). */
export function roleFromPin(pin: { x: number; y: number }): string {
  const side = pin.x < 1 / 3 ? "on the left" : pin.x > 2 / 3 ? "on the right" : "in the centre";
  const depth = pin.y > 2 / 3 ? " in front" : pin.y < 1 / 3 ? " at the back" : "";
  return `the person ${side}${depth}`;
}

// ---------------------------------------------------------------------------
// Quality, sizes and windows

/** Genjutsu's qualities to H3's two: 480p stays, anything higher is swapped at 768p (H3's native top). */
export function characterQuality(q: string | undefined): CharacterQuality {
  return q === "480p" ? "480p" : "768p";
}

/** The finishing size a quality asks for (1080p, 2K, 4K), or null for H3's own 480p / 768p. */
export function characterFinish(q: string | undefined): SharpenTier | null {
  return isSharpenTier(q) ? q : null;
}

/**
 * The qualities each engine offers: your GPU regenerates 1080p, 2K and 4K with Open-H3 Regenerate (a 48 GB card: the
 * choice says so, own-setup.ts "regenerate:swap-sharpen"); fal's H3 makes 2K and 4K (no 1080P).
 */
export const CHARACTER_QUALITIES: Record<Engine, CharacterChoice[]> = {
  open: ["480p", "768p", "1080p", "2K", "4K"],
  cloud: ["480p", "768p", "2K", "4K"],
};

/** What the unpatched h3_character_swap pack's PrepareVideo takes: the strings "480" / "768" (the patched one: integers). */
export const packResolution = (q: string | undefined, patched = false): string | number => {
  const v = characterQuality(q) === "480p" ? "480" : "768";
  return patched ? Number(v) : v;
};

/**
 * fal's H3 resolution enum for a quality: 480P and 768P are made natively, 2K and 4K from a 768P base. fal has no 1080P:
 * 1080p goes to the largest it makes below it (768P), as Genjutsu's other models do (qualityFor).
 */
export const falResolution = (q: string | undefined): "480P" | "768P" | "2K" | "4K" => (q === "2K" || q === "4K" ? q : characterQuality(q) === "480p" ? "480P" : "768P");

/** H3's frame grid: the first count of the form 17n + 5 at or above n (ComfyUI's align_frame_count). */
export function alignFrames(n: number): number {
  let f = Math.max(5, Math.ceil(n));
  while (f % 17 !== 5) f++;
  return f;
}

/** Frames of a part at H3's 24 fps, as the pack's PrepareVideo keeps them (floor(seconds × 24)). */
export const partFrames = (seconds: number) => Math.max(1, Math.floor(seconds * CHARACTER_SWAP.fps + 1e-6));

/** Window sizes the pack takes (17n + 5, 22 … 362) and continuation history (0, 1 or 17n + 1, 18 … 341). */
export const WINDOW_CHOICES = Array.from({ length: 21 }, (_, i) => 22 + 17 * i);
export const HISTORY_CHOICES = [0, 1, ...Array.from({ length: 20 }, (_, i) => 18 + 17 * i)];

const nearest = (xs: number[], v: number) => xs.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

/** The pack's window and history for what was asked (each snapped to its grid; history shorter than the window). */
export function windowPlan(window: number | undefined, history: number | undefined): { window: number; history: number } {
  const w = nearest(WINDOW_CHOICES, window ?? CHARACTER_SWAP.window);
  const h = nearest(HISTORY_CHOICES, history ?? CHARACTER_SWAP.history);
  // planning.validate_settings: "History must be smaller than the generation window."
  return { window: w, history: h < w ? h : Math.max(...HISTORY_CHOICES.filter((x) => x < w)) };
}
export const windowFrames = (v: number | undefined) => String(windowPlan(v, 0).window);
export const historyFrames = (v: number | undefined, window?: number) => String(windowPlan(window ?? 362, v).history);

/** The history lengths a window takes (the pack refuses a history as long as the window). */
export const historyChoicesFor = (window: number) => HISTORY_CHOICES.filter((h) => h < window);

/** What the pack would refuse in a window and history asked for, or null. */
export function windowProblem(c: { windowFrames?: number; historyFrames?: number }): string | null {
  if (c.windowFrames === undefined && c.historyFrames === undefined) return null;
  const w = nearest(WINDOW_CHOICES, c.windowFrames ?? CHARACTER_SWAP.window);
  const h = nearest(HISTORY_CHOICES, c.historyFrames ?? CHARACTER_SWAP.history);
  return h >= w ? `History (${h} frames) must be shorter than the window (${w} frames)` : null;
}

/**
 * How many diffusion windows a part takes: the pack's plan_windows (planning.py at 0670e4f, the same in H3 Relay). The
 * first window has no history; each later one starts on the last frame already made (history before it) and delivers
 * up to window − 1 new frames, its size the smallest on H3's grid that fits what is left. 5 s → 1, 10 s → 2, 15 s → 3.
 */
export function h3Windows(seconds: number, window?: number, history?: number): number {
  const p = windowPlan(window, history);
  const count = partFrames(seconds);
  let n = 0;
  let covered = 0;
  while (covered < count) {
    const eh = n ? p.history : 0;
    const start = covered - (eh ? 1 : 0);
    const needed = Math.min(count - start, p.window);
    const size = WINDOW_CHOICES.find((v) => v >= needed && v > eh) ?? p.window;
    covered = Math.min(count, start + size);
    n++;
  }
  return Math.max(1, n);
}

/** The pixel budgets of the pack's PrepareVideo (video.py PIXEL_BUDGETS; H3 Relay's video_prep.py is the same). */
export const H3_PIXEL_BUDGET: Record<CharacterQuality, number> = { "480p": 500_000, "768p": 1_000_000 };

/**
 * The size H3 works at for a clip: the pack's canvas_dimensions. A clip already on the 32-pixel grid and within the
 * budget (0.5 MP at "480", 1.0 MP at "768") keeps its size; otherwise the shape on the 32-pixel grid within the budget
 * nearest the ideal area-scaled one (squared log distances on each side; the larger area on a tie).
 */
export function h3Canvas(width: number, height: number, quality: string | undefined): { width: number; height: number } {
  const budget = H3_PIXEL_BUDGET[characterQuality(quality)];
  if (!(width > 0 && height > 0) || !Number.isFinite(width * height)) return { width: 32, height: 32 };
  if (width * height <= budget && width % 32 === 0 && height % 32 === 0) return { width, height };
  const ratio = width / height;
  const iw = Math.sqrt(budget * ratio);
  const ih = Math.sqrt(budget / ratio);
  let best: [number, number, number, number] | null = null;
  const less = (a: [number, number, number, number], b: [number, number, number, number]) => {
    for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  };
  for (let w = 32; w <= Math.min(16384, Math.floor(budget / 32)); w += 32) {
    const maxH = Math.min(16384, Math.floor(Math.floor(budget / w) / 32) * 32);
    for (const h of new Set([Math.max(32, Math.min(maxH, Math.floor(ih / 32) * 32)), Math.max(32, Math.min(maxH, Math.ceil(ih / 32) * 32))])) {
      const c: [number, number, number, number] = [Math.log(w / iw) ** 2 + Math.log(h / ih) ** 2, -(w * h), w, h];
      if (!best || less(c, best)) best = c;
    }
  }
  return { width: best![2], height: best![3] };
}

/**
 * A point in the clip's pixels → the same spot in H3's prepared frame: the pack scales the clip to cover the canvas
 * (FFmpeg scale=ceil(max(w, h·dar)) × ceil(max(h, w/dar))) and crops the middle, so a point in the cut-off margin lands
 * on the nearest edge.
 */
export function toH3Canvas(p: { x: number; y: number }, clip: { width: number; height: number }, quality: string | undefined): { x: number; y: number } {
  const c = h3Canvas(clip.width, clip.height, quality);
  const dar = clip.width / clip.height;
  const sw = Math.ceil(Math.max(c.width, c.height * dar) - 1e-6);
  const sh = Math.ceil(Math.max(c.height, c.width / dar) - 1e-6);
  const x0 = Math.floor((sw - c.width) / 2);
  const y0 = Math.floor((sh - c.height) / 2);
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max - 1, Math.round(v)));
  return { x: clamp((p.x / clip.width) * sw - x0, c.width), y: clamp((p.y / clip.height) * sh - y0, c.height) };
}

/** Clicks in the clip's pixels → SAM3_Detect's JSON points in H3's prepared frame: [positive, negative] ("" when none). */
export function samCoords(points: PixelPoint[] | undefined, clip: { width: number; height: number }, quality: string | undefined): [string, string] {
  if (!points?.length || !clip.width || !clip.height) return ["", ""];
  const at = (p: PixelPoint) => toH3Canvas(p, clip, quality);
  const pos = points.filter((p) => p.label !== "negative").map(at);
  const neg = points.filter((p) => p.label === "negative").map(at);
  return [pos.length ? JSON.stringify(pos) : "", neg.length ? JSON.stringify(neg) : ""];
}

// ---------------------------------------------------------------------------
// Words

const tidy = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];

/** Who to swap, in words (the cloud has no mask; the open graph's prompt keeps "the selected person"). */
export function whoWords(o: Pick<CharacterOptions, "who" | "index" | "subject">): string {
  const subject = tidy(o.subject);
  if (subject && subject.toLowerCase() !== "person") return /^(the|a|an)\s/i.test(subject) ? subject : `the ${subject}`;
  switch (o.who ?? "largest") {
    case "leftmost":
      return "the person on the left";
    case "rightmost":
      return "the person on the right";
    case "index":
      return `the ${ORDINALS[Math.max(0, Math.min(ORDINALS.length - 1, o.index ?? 0))]} person from the left`;
    default:
      return "the main person";
  }
}

/** One line for who speaks (Akatz Labs' speaker choice), with the part's words when there are some. */
export function speechLine(speech: SwapSpeech | undefined, dialogue?: string): string {
  const words = tidy(dialogue).slice(0, 600);
  const said = words ? ` The words: "${words}".` : "";
  switch (speech) {
    case "character":
      return `The character speaks the clip's lines, lips in sync with its audio.${said}`;
    case "other":
      return `Someone else speaks; the character listens and does not talk.${said}`;
    case "offscreen":
      return `The voice comes from off screen; the character does not speak.${said}`;
    case "none":
      return "Nobody speaks in this part.";
    default:
      return "";
  }
}

/**
 * The words spoken in a part, from a transcription of the whole clip (cues in clip seconds): every cue that overlaps
 * the part, in order (Akatz Labs feed each segment's dialogue into its prompt the same way).
 */
export function partWords(cues: { start: number; end: number; text: string }[] | undefined, part: { start: number; end: number }): string {
  const inside = (cues ?? []).filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > part.start + 0.05 && c.start < part.end - 0.05);
  return tidy(
    inside
      .sort((a, b) => a.start - b.start)
      .map((c) => c.text.trim())
      .filter(Boolean)
      .join(" "),
  ).slice(0, 2000);
}

export interface SwapPromptInput extends Pick<CharacterOptions, "who" | "index" | "subject" | "description" | "speech" | "dialogue"> {
  engine: Engine;
  /** The anchor first frame goes along (Picture 2 / Image 2). */
  anchor: boolean;
  /** Your direction (≤ 500 characters). */
  direction?: string;
}

/**
 * The swap's prompt: Openjutsu's instruction in H3's reference tags, the anchor sentence only with an anchor, then the
 * character's description, who speaks and your direction. ComfyUI's graph names the inputs <Video 1>, <Picture 1> and
 * <Picture 2>; fal's H3 names them Video 1, Image 1 and Image 2. Open: the mask says who; cloud: the words do.
 */
export function swapPrompt(p: SwapPromptInput): string {
  const open = p.engine === "open";
  const video = open ? "<Video 1>" : "Video 1";
  const picture = (n: number) => (open ? `<Picture ${n}>` : `Image ${n}`);
  const who = open ? "the selected person" : whoWords(p);
  const parts = [`Replace ${who} in ${video} with the character in ${picture(1)}. Preserve the source performance, scene and audio timing.`];
  if (p.anchor) parts.push(`Start from the first frame in ${picture(2)}.`);
  const description = tidy(p.description).slice(0, CHARACTER_SWAP.maxDescriptionChars);
  if (description) parts.push(`The character: ${description}.`);
  const speech = speechLine(p.speech, p.dialogue);
  if (speech) parts.push(speech);
  const direction = tidy(p.direction).slice(0, CHARACTER_SWAP.maxDirectionChars);
  if (direction) parts.push(`${direction[0].toUpperCase()}${direction.slice(1)}.`);
  return parts.join(" ");
}

/**
 * The anchor frame's edit (image 1: the part's first frame, image 2: the character): Openjutsu's instruction, or Akatz
 * Labs' brief when the character is described (it names who to replace and keeps everyone else).
 */
export function anchorPrompt(o: Pick<CharacterOptions, "who" | "index" | "subject" | "description">): string {
  const description = tidy(o.description).slice(0, CHARACTER_SWAP.maxDescriptionChars);
  if (!description) {
    return "Replace the person in image 1 with the character from image 2, including their face, hair, body and complete outfit exactly as shown in image 2: every garment they wear comes from image 2. Keep image 1's pose, framing, background and lighting.";
  }
  return (
    `Image 1 is the source frame to edit. Image 2 is character identity only: ${description}. Replace ONLY ${whoWords(o)} with that single character. ` +
    "Match the exact source pose, face angle, gaze, mouth opening, expression, limb placement, scale and occlusions. Preserve all other people, the entire original scene, camera framing, lighting and aspect ratio. " +
    "Take only the identity and costume from the reference; the pose and background come from the source frame. One full-aspect edited source frame."
  );
}

/** The image edit that makes the anchor frame, per engine (the first is the default; docs/research/openjutsu-6.md §10). */
export const ANCHOR_MODELS: Record<Engine, { id: string; label: string; note: string; extra?: Record<string, string>; tokens?: string }[]> = {
  cloud: [
    // fal bills Sunburst by tokens, so the catalog has no fixed price for it: the estimate leaves it out and says so.
    { id: "gpt-image-2-5-sunburst", label: "GPT Image 2.5 Sunburst", note: "Fast draft frame", extra: { quality: "low" }, tokens: "$8 per million tokens in, $30 per million out" },
    { id: "nano-banana-pro", label: "Nano Banana Pro", note: "$0.15 an image" },
  ],
  open: [
    { id: "oss-qwen-image-21", label: "Qwen-Image 2.1", note: "Free on your GPU (20 GB)" },
    { id: "oss-krea2-identity-edit", label: "Krea 2 Identity Edit", note: "Free on your GPU (20 GB)" },
  ],
};

export const anchorModel = (engine: Engine, id?: string) => ANCHOR_MODELS[engine].find((m) => m.id === id) ?? ANCHOR_MODELS[engine][0];

/**
 * The aspect ratio the anchor edit is asked for, so the first frame keeps the part's shape: "auto" (the first image's
 * shape) when the model takes it, else the ratio it lists nearest the clip's. Undefined: the model has no ratios, or
 * the clip's size isn't known.
 */
export function anchorAspect(ratios: readonly string[] | undefined, clip: { width?: number; height?: number }): string | undefined {
  if (!ratios?.length) return undefined;
  if (ratios.includes("auto")) return "auto";
  if (!clip.width || !clip.height) return undefined;
  const want = Math.log(clip.width / clip.height);
  const value = (r: string) => {
    const [a, b] = r.split(":").map(Number);
    return a > 0 && b > 0 ? Math.log(a / b) : NaN;
  };
  const listed = ratios.filter((r) => Number.isFinite(value(r)));
  return listed.length ? listed.reduce((best, r) => (Math.abs(value(r) - want) < Math.abs(value(best) - want) ? r : best)) : undefined;
}

/** What a run says when the anchor frame couldn't be made (the swap goes ahead without it). */
export const ANCHOR_FALLBACK = "Couldn't make the first frame — swapped without it";

// ---------------------------------------------------------------------------
// Checks and notes

/** What stops a part from being swapped, or null. `continued`: longer parts are allowed (up to 30 s). */
export function partProblem(part: { start: number; end: number }, clipSeconds?: number): string | null {
  const len = part.end - part.start;
  if (clipSeconds !== undefined && clipSeconds < CHARACTER_SWAP.minSeconds - 0.05) return `Choose a clip at least ${CHARACTER_SWAP.minSeconds} seconds long`;
  if (!(len > 0) || part.start < 0) return "Choose where the part starts";
  if (clipSeconds !== undefined && part.end > clipSeconds + 0.05) return "The part runs past the end of the clip";
  if (len < CHARACTER_SWAP.minSeconds - 0.05) return `Pick a part of ${CHARACTER_SWAP.minSeconds}–${CHARACTER_SWAP.maxSeconds} seconds (this is ${len.toFixed(1)} s)`;
  if (len > CHARACTER_SWAP.maxContinued + 0.05) return `A part can run up to ${CHARACTER_SWAP.maxContinued} seconds — 5–15 s swaps best`;
  return null;
}

export function seedProblem(seed: number | undefined): string | null {
  if (seed === undefined) return null;
  return Number.isInteger(seed) && seed >= 0 && seed <= CHARACTER_SWAP.maxSeed ? null : "Use a whole-number seed, or leave it blank";
}

/** The hard cuts inside a part (times in the clip), from the browser's cut detection (Katana's detectCuts). */
export const cutsInPart = (cuts: number[] | undefined, part: { start: number; end: number }) => (cuts ?? []).filter((t) => t > part.start + 0.2 && t < part.end - 0.2);

/** The warning for a part with a hard cut (the swap breaks at a cut). */
export function cutWarning(cuts: number[]): string | null {
  if (!cuts.length) return null;
  const at = cuts.map((t) => `${t.toFixed(1)} s`).join(", ");
  return `Your part has a cut at ${at} — the swap breaks at a cut. Move the part, or pick one continuous shot`;
}

/** The limits the page shows before a run (Openjutsu's README and Akatz Labs' validation notes). */
export const CHARACTER_LIMITS = [
  "A part of 5–15 seconds (up to 30 s, continued window by window)",
  "One continuous shot: a hard cut breaks the swap",
  "The person must be visible in the part's first frame",
  "With several people, the largest is swapped unless you pick another",
  "A silent clip gives a silent result",
] as const;

/** What the open route was tested on (its authors' words), for the GPU line. */
export const CHARACTER_GPU = {
  weightsGb: 46.33,
  tested: "Tested by its authors on a 96 GB RTX PRO 6000, and on a 24 GB RTX 4090 with 128 GB of RAM and model offloading",
  advice: "24 GB of VRAM with offloading and 64–128 GB of RAM; 48 GB+ for 768p. The NVFP4 text encoder runs at full speed on Blackwell (RTX 50, RTX PRO 6000) and slower on older GPUs",
  speed: "About two minutes for 5 s at 480p on a warm RTX PRO 6000",
} as const;

// ---------------------------------------------------------------------------
// Licences (information for Settings → Models & licences, never a gate: the owner's decision of 2026-10-27)

export type CharacterLicenceClass = "commercial" | "conditions" | "regions" | "non-commercial" | "paid-api";

export interface CharacterLicence {
  /** What it covers. */
  item: string;
  name: string;
  class: CharacterLicenceClass;
  url: string;
  /** Who a restricted-regions licence leaves out. */
  excludes?: string;
  /** Notices the app must show. */
  notices?: string[];
  note: string;
}

const H3_LICENCE_URL = "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/42ed227ee7df40d41602854ae760620d6eb651fe/LICENSE";

export const MINIMAX_H3_LICENCE: CharacterLicence = {
  item: "MiniMax H3 (diffusion model, VAEs, packaged text encoder), Akatz Labs' Character Swap LoRA V1 / V1.5 and Person Remover V1",
  name: "MiniMax H3 Community License",
  class: "regions",
  url: H3_LICENCE_URL,
  excludes: "the US, the EU, the UK and South Korea",
  notices: ["MiniMax H3"],
  note:
    "Granted outside the US, the EU, the UK and South Korea (MiniMax sells licences there, through Comfy); written authorization above US$20M yearly revenue; " +
    'show "MiniMax H3" on a commercial product\'s interface; outputs may not be used to improve other AI models; services for others must keep safeguards and a way to report misuse. MiniMax claims no rights over the outputs',
};

/** Every licence the Character swap touches, as data (the model picker's line and Settings → Models & licences). */
export const CHARACTER_LICENCES: CharacterLicence[] = [
  MINIMAX_H3_LICENCE,
  {
    item: "SAM 3.1 (finds and follows the person)",
    name: "Meta SAM License",
    class: "conditions",
    url: "https://huggingface.co/Comfy-Org/sam3.1/blob/7bb8374780a725b4353ed31f3a9395c9742b5621/LICENSE",
    note: "Royalty-free, commercial use allowed; give a copy of the licence when distributing, acknowledge SAM in publications, follow trade controls; no military, nuclear or weapons uses",
  },
  {
    item: "FL2V Turbo 8-step LoRA (lightx2v)",
    name: "Apache-2.0",
    class: "commercial",
    url: "https://huggingface.co/lightx2v/Minimax-h3-Turbo/blob/3ec17a324ced54151364f24f8b5fb6bf7e26414f/README.md",
    note: "Apache-2.0 at the pinned revision; the current card no longer states a licence",
  },
  {
    item: "h3_character_swap node pack (Akatz Labs)",
    name: "GPL-3.0",
    class: "commercial",
    url: "https://github.com/akatz-labs/h3-character-swap-tool/tree/0670e4fdf95adf2262caa4b81afed2a9c4ae4b7b/worker_nodes/h3_character_swap",
    note: "GPL-3.0 code, like ComfyUI; a modified NVIDIA INT8 kernel inside is Apache-2.0",
  },
  {
    item: "H3 Relay 2.0 node pack (Akatz Labs)",
    name: "GPL-3.0",
    class: "commercial",
    url: "https://github.com/akatz-ai/h3-relay/tree/e2a7665b6eb8ea37a88c0de2c9c6b69a8f7c9220",
    note: "GPL-3.0 code (Sendy Software LLC and contributors); vendored Context Loop and Spectrum GPL-3.0",
  },
  {
    item: "Openjutsu's workflow and Akatz Labs' app",
    name: "MIT",
    class: "commercial",
    url: "https://github.com/Comfy-Org/comfy-openjutsu",
    note: "The graph Fuobe runs is Openjutsu's (Comfy Org, MIT), derived from Akatz Labs' MIT workflow",
  },
  {
    item: "fal's hosted MiniMax H3 and H3 Max Recast",
    name: "Paid API · fal.ai",
    class: "paid-api",
    url: "https://fal.ai/models/minimax/h3/reference-to-video/lora",
    note: "Pay per second on your fal key, under fal's terms and MiniMax's",
  },
];

/** Turbo's licence at the pinned revision (Apache-2.0; the current card dropped the tag). */
const TURBO_LICENCE = CHARACTER_LICENCES.find((l) => l.item.startsWith("FL2V Turbo"))!;

/**
 * The LoRA files the Character swap loads, with their licence, for Settings → Models & licences (the LoRA rows and
 * the run-time class check): the swap LoRA's releases are MiniMax H3 Community License work, Turbo is Apache-2.0.
 */
export const CHARACTER_LORAS: { file: string; name: string; url: string; licence: CharacterLicence }[] = [
  { file: SWAP_LORAS["v1.5"].file, name: "H3 Character Swap LoRA V1.5 (Akatz Labs)", url: SWAP_LORAS["v1.5"].url, licence: MINIMAX_H3_LICENCE },
  { file: SWAP_LORAS.v1.file, name: "H3 Character Swap LoRA V1 (Akatz Labs)", url: SWAP_LORAS.v1.url, licence: MINIMAX_H3_LICENCE },
  { file: TURBO_LORA.file, name: "MiniMax H3 FL2V Turbo 8-step (lightx2v)", url: TURBO_LORA.url!, licence: TURBO_LICENCE },
  // Remove object's "Remove a person (H3)".
  { file: PERSON_REMOVER_LORA.file, name: "H3 Person Remover V1 (Akatz Labs)", url: PERSON_REMOVER_LORA.url!, licence: MINIMAX_H3_LICENCE },
];

export const characterLora = (file: string) => CHARACTER_LORAS.find((l) => l.file === file);
