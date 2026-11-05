/**
 * Audio → Edit speech (nm10-speech-edit): change what was said in a recording, or how it was said, with Tencent's AuK
 * (MIT, open engine only: AuK is hosted on neither fal nor Replicate). Pure data and logic shared by the page, the server
 * (src/server/audio-tools.ts, tool "speech-edit"), the provider (src/server/providers/comfyui.ts) and Assist's
 * edit_speech tool.
 *
 * The flow: a transcript with times (Transcribe's lines; their words are timed by length inside each line) → the person
 * edits the text → the edit is diffed to the smallest changed span of words → a window around it, cut at silences, with at
 * least CONTEXT_MIN seconds of untouched speech on each side (AuK needs the voice around the change to match it) → AuK's
 * content-edit instruction ("Replace 'X' with 'Y'.") on that window → the edited window crossfaded back into the original
 * (the speech-edit-auk graph does it with core audio nodes, one prompt for every window). Several edits run as several
 * windows in that one prompt; windows that would touch are merged into one edit first.
 *
 * Pitch, pace, volume, emotion, whisper, Clean up (noise and room echo) and Keep only this speaker run on a picked range
 * the same way, the range split at silences into windows AuK can take.
 *
 * AuK's limit (its ComfyUI node, docs/COMFYUI.md at the pinned commit): the source audio plus the audio it makes must fit
 * in 30 seconds per call, and the node doesn't split. So a window plus its new length stays under AUK_SEQUENCE_MAX minus a
 * margin for the model's frame rounding: a same-length effect takes at most ~14.7 s of speech per window.
 */
import type { Cue } from "./cues";
import type { Engine, GenerationRequest } from "./catalog/types";
import type { ToolPlan, ToolStep } from "./av/audio-tools";

export const SPEECH_EDIT_FEATURE = "speech-edit";
export const SPEECH_EDIT_MODEL = "oss-auk";
/** The stream-copy mux that puts the edited sound back on a video (video-mux-audio-replace). */
export const SPEECH_EDIT_MUX_MODEL = "oss-mux";

/** Source + generated seconds per AuK call (its node refuses more). */
export const AUK_SEQUENCE_MAX = 30;
/** Kept free for AuK's resampling and model-frame rounding. */
export const SEQUENCE_MARGIN = 0.5;
/** Untouched speech kept on each side of a change inside its window. */
export const CONTEXT_MIN = 1;
/** The seam between the original and an edited window (linear: the two sides are the same voice, nearly the same sound). */
export const SPEECH_CROSSFADE = 0.12;
/** A pause at least this long between two words is a silence a window may be cut at. */
export const MIN_SILENCE = 0.12;
/** Speaking rate when the transcript can't tell (seconds per character, spaces included). */
export const DEFAULT_SECONDS_PER_CHAR = 0.065;
/** The longest recording the tool takes (the whole file goes through the graph once). */
export const SPEECH_EDIT_MAX_SECONDS = 20 * 60;
/** Edits per run (each is a window and an AuK call in the one prompt). */
export const MAX_WINDOWS = 24;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

// ---------------------------------------------------------------------------
// Words

export interface Word {
  text: string;
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
}

/** A word as compared: lower case, without the punctuation around it ("Hello," = "hello"). */
export const normalizeWord = (w: string): string =>
  w
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[’‘]/g, "'")
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");

export const splitWords = (text: string): string[] => text.split(/\s+/).filter(Boolean);

/**
 * Words with times from transcript lines: each line's words share its time by their length (characters plus one for the
 * space), so a line's first word starts with it and its last ends with it. The pauses between lines are the silences a
 * window is cut at; a transcript with a line per word (a word-timed one) gives exact times.
 */
export function wordsFromCues(cues: Cue[]): Word[] {
  const out: Word[] = [];
  for (const c of [...cues].sort((a, b) => a.start - b.start)) {
    const words = splitWords(c.text);
    if (!words.length || !(c.end > c.start)) continue;
    const weights = words.map((w) => w.length + 1);
    const total = weights.reduce((a, b) => a + b, 0);
    let t = c.start;
    words.forEach((w, i) => {
      const end = i === words.length - 1 ? c.end : t + ((c.end - c.start) * weights[i]) / total;
      out.push({ text: w, start: round3(t), end: round3(end) });
      t = end;
    });
  }
  return out;
}

/** Seconds per character of this speaker (spaces counted), from the transcript; the default when it's too short to say. */
export function speakingRate(words: Word[]): number {
  const chars = words.reduce((a, w) => a + w.text.length + 1, 0);
  const seconds = words.reduce((a, w) => a + Math.max(0, w.end - w.start), 0);
  if (chars < 20 || seconds <= 0) return DEFAULT_SECONDS_PER_CHAR;
  return Math.min(0.2, Math.max(0.03, seconds / chars));
}

/** About how long these words take to say at this rate. */
export const sayLength = (text: string, rate: number): number => (text.trim() ? round3((text.trim().length + 1) * rate) : 0);

// ---------------------------------------------------------------------------
// The diff

/** A changed span: old words [from, to) become `words` (from = to: an insertion before word `from`). */
export interface TextChange {
  from: number;
  to: number;
  words: string[];
  /** Where `words` start in the new text (set by diffWords; lets merged changes take the words between them as edited). */
  at?: number;
}

/**
 * The smallest changed spans between the old words and the new text, compared word by word (case and the punctuation
 * around a word don't count as a change). Common words at both ends are taken off first, then the middle is matched by
 * the longest common subsequence, so two edits far apart stay two changes.
 */
export function diffWords(old: string[], next: string[]): TextChange[] {
  const a = old.map(normalizeWord);
  const b = next.map(normalizeWord);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const A = a.slice(head, a.length - tail);
  const B = b.slice(head, b.length - tail);
  if (!A.length && !B.length) return [];
  // LCS table over the middle (n × m; a transcript edit's middle is short once the ends are off).
  const n = A.length;
  const m = B.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const changes: TextChange[] = [];
  let i = 0;
  let j = 0;
  let open: TextChange | null = null;
  const close = () => {
    if (open) changes.push(open);
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      close();
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      open ??= { from: head + i, to: head + i, words: [], at: head + j };
      open.words.push(next[head + j]);
      j++;
    } else {
      open ??= { from: head + i, to: head + i, words: [], at: head + j };
      open.to = head + i + 1;
      i++;
    }
  }
  close();
  return changes;
}

/** Changes from edited transcript lines: the old lines' words against the new lines' words, as one text. */
export function diffLines(cues: Cue[], edited: string[]): TextChange[] {
  const old = [...cues].sort((a, b) => a.start - b.start).flatMap((c) => splitWords(c.text));
  const next = edited.flatMap(splitWords);
  return diffWords(old, next);
}

// ---------------------------------------------------------------------------
// Instructions

/** AuK's text in quotes: single quotes (its Cookbook's), straight apostrophes kept inside words. */
const q = (s: string) => `'${s.replace(/\s+/g, " ").trim()}'`;

/** How many times a run of words occurs among these words (compared as words). */
function occurrences(words: string[], phrase: string[]): number {
  const p = phrase.map(normalizeWord);
  if (!p.length) return 0;
  const w = words.map(normalizeWord);
  let n = 0;
  for (let i = 0; i + p.length <= w.length; i++) if (p.every((x, k) => w[i + k] === x)) n++;
  return n;
}

/**
 * The content-edit instruction for one change (AuK's Cookbook templates, docs/COOKBOOK.md §2.1): Replace 'X' with 'Y'.,
 * Add 'Y' after 'A'. (or before 'B' at the start), Remove 'X'. A phrase that occurs more than once in the window is
 * widened by its neighbouring words on both sides until it occurs once, so AuK edits the right one.
 */
export function editInstruction(words: string[], change: TextChange, windowFrom = 0, windowTo = words.length): string {
  const scope = words.slice(windowFrom, windowTo);
  let { from, to } = change;
  let added = [...change.words];
  if (from === to) {
    // An insertion: anchored on the word before it (or after it, at the start), the anchor widened until it's unique.
    if (from > windowFrom) {
      let a = from - 1;
      while (a > windowFrom && occurrences(scope, words.slice(a, from)) > 1) a--;
      return `Add ${q(added.join(" "))} after ${q(words.slice(a, from).join(" "))}.`;
    }
    let b = from + 1;
    while (b < windowTo && occurrences(scope, words.slice(from, b)) > 1) b++;
    return `Add ${q(added.join(" "))} before ${q(words.slice(from, Math.min(b, windowTo)).join(" "))}.`;
  }
  while (occurrences(scope, words.slice(from, to)) > 1 && (from > windowFrom || to < windowTo)) {
    if (from > windowFrom) {
      from--;
      added = [words[from], ...added];
    }
    if (to < windowTo && occurrences(scope, words.slice(from, to)) > 1) {
      added = [...added, words[to]];
      to++;
    }
  }
  const before = words.slice(from, to).join(" ");
  return added.length ? `Replace ${q(before)} with ${q(added.join(" "))}.` : `Remove ${q(before)}.`;
}

export type EmotionId = "happy" | "angry" | "sad" | "fearful" | "surprised" | "disgusted" | "calm" | "excited";
export const EMOTIONS: EmotionId[] = ["happy", "calm", "excited", "sad", "angry", "surprised", "fearful", "disgusted"];
/** AuK's speed edits (its Cookbook offers these factors). */
export const PACES = [0.5, 0.75, 1.25, 1.5, 2] as const;
export const PITCH_STEPS = [-3, -2, -1, 1, 2, 3] as const;
export const VOLUME_STEPS = [-15, -10, -5, 5, 10, 15] as const;

/** What a picked range can have done to it. */
export type SpeechEffect =
  | { kind: "pitch"; semitones: (typeof PITCH_STEPS)[number] }
  | { kind: "pace"; speed: (typeof PACES)[number] }
  | { kind: "volume"; db: (typeof VOLUME_STEPS)[number] }
  | { kind: "emotion"; emotion: EmotionId }
  | { kind: "whisper" }
  | { kind: "unwhisper" }
  | { kind: "clean" }
  | { kind: "isolate" };

export type EffectKind = SpeechEffect["kind"];

export const EFFECT_LABELS: Record<EffectKind, string> = {
  pitch: "Pitch",
  pace: "Pace",
  volume: "Volume",
  emotion: "Emotion",
  whisper: "Whisper",
  unwhisper: "Normal voice",
  clean: "Clean up",
  isolate: "Keep only this speaker",
};

/**
 * AuK's instruction for an effect on a window, worded exactly as its Cookbook's templates (§3–§5: "by {1/2/3} semitones",
 * "to {0.5/0.75/1.25/1.5/2.0}x"); `said` is what the window's speaker says (Keep only this speaker). */
export function effectInstruction(e: SpeechEffect, said = ""): string {
  switch (e.kind) {
    case "pitch":
      return `${e.semitones > 0 ? "Raise" : "Lower"} the pitch by ${Math.abs(e.semitones)} semitones.`;
    case "pace":
      return `Adjust the speech speed to ${Number.isInteger(e.speed) ? e.speed.toFixed(1) : e.speed}x.`;
    case "volume":
      return `${e.db > 0 ? "Increase" : "Decrease"} the volume by ${Math.abs(e.db)} dB.`;
    case "emotion":
      return `Change the emotion to ${e.emotion}.`;
    case "whisper":
      return "Convert this speech into a soft whisper while preserving the speaker and content.";
    case "unwhisper":
      return "Convert this whispered speech into a normal speaking voice while preserving the speaker and content.";
    case "clean":
      return "Preserve all speakers, remove noise and reverberation, and output clean speech of the same length.";
    case "isolate":
      return said.trim() ? `Keep only the speaker who says "${said.replace(/\s+/g, " ").trim()}" and remove all other speakers.` : "Keep only the first speaker to start talking and remove all other speakers.";
  }
}

/** The length an effect makes from `seconds` of speech (only pace changes it). */
export const effectLength = (e: SpeechEffect, seconds: number): number => round3(e.kind === "pace" ? seconds / e.speed : seconds);

export function effectSummary(e: SpeechEffect): string {
  switch (e.kind) {
    case "pitch":
      return `Pitch ${e.semitones > 0 ? "+" : ""}${e.semitones} semitone${Math.abs(e.semitones) === 1 ? "" : "s"}`;
    case "pace":
      return `Pace ${e.speed}×`;
    case "volume":
      return `Volume ${e.db > 0 ? "+" : ""}${e.db} dB`;
    case "emotion":
      return `Sounds ${e.emotion}`;
    default:
      return EFFECT_LABELS[e.kind];
  }
}

// ---------------------------------------------------------------------------
// Windows

/** One AuK call: [start, end] of the original, the instruction, and how long its new audio runs. */
export interface SpeechWindow {
  start: number;
  end: number;
  instruction: string;
  /** Seconds the edited window runs (AuK's generation_seconds). */
  seconds: number;
  /** What changes, in words the page shows. */
  label: string;
}

/** Places a window may start or end, best first: a silence's middle, then any word boundary. */
interface Cuts {
  silences: number[];
  boundaries: number[];
}

function cutsOf(words: Word[], duration: number): Cuts {
  const silences = [0, duration];
  const boundaries = [0, duration];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    const mid = round3((words[i - 1].end + words[i].start) / 2);
    boundaries.push(mid);
    if (gap >= MIN_SILENCE) silences.push(mid);
  }
  if (words.length) {
    // The silence before the first word and after the last.
    if (words[0].start >= MIN_SILENCE) silences.push(round3(words[0].start / 2));
    if (duration - words[words.length - 1].end >= MIN_SILENCE) silences.push(round3((words[words.length - 1].end + duration) / 2));
  }
  const tidy = (l: number[]) => [...new Set(l.filter((t) => t >= 0 && t <= duration))].sort((a, b) => a - b);
  return { silences: tidy(silences), boundaries: tidy(boundaries) };
}

/** The latest cut at or before t (0 when there's none). */
const cutBefore = (cuts: number[], t: number) => cuts.filter((c) => c <= t + 1e-6).pop() ?? 0;
/** The earliest cut at or after t (the end when there's none). */
const cutAfter = (cuts: number[], t: number, duration: number) => cuts.find((c) => c >= t - 1e-6) ?? duration;

/** The most seconds of source a window may hold when its new audio runs `ratio` × as long (plus `extra` seconds). */
export const windowBudget = (ratio = 1, extra = 0): number => round3((AUK_SEQUENCE_MAX - SEQUENCE_MARGIN - extra) / (1 + ratio));

export class SpeechEditError extends Error {}

export interface PlanInput {
  /** The words with their times. */
  words: Word[];
  /** Seconds the recording runs. */
  duration: number;
  /** The edited text's words (lets two merged changes keep the edited words between them, with their punctuation). */
  next?: string[];
  /**
   * Every window keeps its old length (a video's sound, which must stay in step with the picture): AuK fits the new words
   * into the same time, and Pace, which only changes the length, is refused.
   */
  keepLength?: boolean;
}

/**
 * The window around [s, e] (times of the changed words, or the insertion point twice): at least CONTEXT_MIN seconds of
 * untouched speech on each side (less only where the recording starts or ends), cut at the nearest silence beyond that,
 * else a word boundary, else the exact time; then held to `budget` seconds of source.
 */
function windowAround(s: number, e: number, cuts: Cuts, duration: number, budget: number): { start: number; end: number } | null {
  const wantStart = Math.max(0, s - CONTEXT_MIN);
  const wantEnd = Math.min(duration, e + CONTEXT_MIN);
  const tries: [number, number][] = [
    [cutBefore(cuts.silences, wantStart), cutAfter(cuts.silences, wantEnd, duration)],
    [cutBefore(cuts.silences, wantStart), cutAfter(cuts.boundaries, wantEnd, duration)],
    [cutBefore(cuts.boundaries, wantStart), cutAfter(cuts.silences, wantEnd, duration)],
    [cutBefore(cuts.boundaries, wantStart), cutAfter(cuts.boundaries, wantEnd, duration)],
    [wantStart, wantEnd],
  ];
  for (const [a, b] of tries) if (b - a <= budget + 1e-6) return { start: round3(a), end: round3(b) };
  return null;
}

/** A change's old words' time span (an insertion: the pause it goes into, as one point). */
function spanOf(words: Word[], c: TextChange, duration: number): [number, number] {
  if (c.from < c.to) return [words[c.from].start, words[c.to - 1].end];
  const before = c.from > 0 ? words[c.from - 1].end : 0;
  const after = c.from < words.length ? words[c.from].start : duration;
  const at = round3(c.from === 0 ? Math.min(after, before) : c.from >= words.length ? before : (before + after) / 2);
  return [at, at];
}

/** Merge two changes into one that spans both (the words between them unchanged on both sides). */
function mergeChanges(words: Word[], a: TextChange, b: TextChange, next?: string[]): TextChange {
  const [x, y] = a.from <= b.from ? [a, b] : [b, a];
  // The words between, as edited (they match the old ones but for case and punctuation, which the new text decides).
  const edited = next && x.at !== undefined && y.at !== undefined ? next.slice(x.at + x.words.length, y.at) : null;
  const between = edited && edited.length === y.from - x.to ? edited : words.slice(x.to, y.from).map((w) => w.text);
  return { from: x.from, to: Math.max(x.to, y.to), words: [...x.words, ...between, ...y.words], ...(x.at !== undefined && { at: x.at }) };
}

/**
 * Text edits → AuK windows, one per change (changes whose windows would overlap or nearly touch become one), in time
 * order. Each window's new length is its old length plus the change in the words' time: the difference in characters at the
 * speaker's rate for a replacement, the new words' time for an insertion, the old words' time for a removal (with
 * keepLength, a video's, the old length as it is). Throws (in words the page shows) when a change is too long for one AuK call or there are too many.
 */
export function planTextWindows(input: PlanInput, changes: TextChange[]): SpeechWindow[] {
  const { words, duration, keepLength } = input;
  if (!changes.length) return [];
  const rate = speakingRate(words);
  const cuts = cutsOf(words, duration);
  const texts = words.map((w) => w.text);
  const build = (c: TextChange) => {
    const [s, e] = spanOf(words, c, duration);
    // A replacement keeps the old words' real length and adds or takes the difference in characters at the speaker's
    // rate; an insertion adds the new words' time, a removal takes the old words' time away.
    const oldText = texts.slice(c.from, c.to).join(" ");
    const delta = keepLength ? 0 : c.from === c.to ? sayLength(c.words.join(" "), rate) : c.words.length ? round3((c.words.join(" ").length - oldText.length) * rate) : -(e - s);
    // The window's old length L and new length L + delta must fit together: 2L + delta ≤ max.
    const budget = windowBudget(1, Math.max(0, delta));
    const w = windowAround(s, e, cuts, duration, budget);
    return { c, s, e, w, delta };
  };
  const list = [...changes].sort((a, b) => a.from - b.from || a.to - b.to).map(build);
  // Merge neighbours whose windows overlap or leave no room for two seams between them.
  for (let k = 0; k < list.length - 1; ) {
    const [p, n] = [list[k], list[k + 1]];
    if (p.w && n.w && n.w.start - p.w.end < 2 * SPEECH_CROSSFADE) {
      list.splice(k, 2, build(mergeChanges(words, p.c, n.c, input.next)));
      if (k > 0) k--;
    } else k++;
  }
  const out: SpeechWindow[] = [];
  for (const { c, w, delta } of list) {
    const old = texts.slice(c.from, c.to).join(" ");
    const label = c.from === c.to ? `Add “${c.words.join(" ")}”` : c.words.length ? `“${old}” → “${c.words.join(" ")}”` : `Remove “${old}”`;
    if (!w) throw new SpeechEditError(`${label} is too long for one pass (AuK takes ${AUK_SEQUENCE_MAX} s per call, before and after together): split it into shorter edits`);
    const inWindow = words.map((x, i) => [x, i] as const).filter(([x]) => x.start >= w.start - 1e-6 && x.end <= w.end + 1e-6);
    const from = inWindow.length ? inWindow[0][1] : c.from;
    const to = inWindow.length ? inWindow[inWindow.length - 1][1] + 1 : c.to;
    const seconds = round3(Math.max(2 * SPEECH_CROSSFADE + 0.1, w.end - w.start + delta));
    out.push({ start: w.start, end: w.end, seconds, instruction: editInstruction(texts, c, Math.min(from, c.from), Math.max(to, c.to)), label });
  }
  if (out.length > MAX_WINDOWS) throw new SpeechEditError(`That's ${out.length} edits: up to ${MAX_WINDOWS} run at once. Run some, then the rest on the new version`);
  return out;
}

/** Why a video has no Pace: a faster or slower line changes the sound's length, and the picture would no longer match it. */
export const PACE_ON_VIDEO_PROBLEM = "Pace changes how long the line runs, so on a video the sound would drift from the picture. Change the pace on the audio alone, or pick another effect.";

/**
 * An effect on [start, end] → AuK windows: the range widened to the nearest silence (within half a second, else a word
 * boundary), then split at silences into pieces short enough for one call each (same-length effects up to about 14.7 s,
 * a faster pace a little more). Keep only this speaker names what the speaker says in each piece.
 */
export function planEffectWindows(input: PlanInput, range: { start: number; end: number }, effect: SpeechEffect): SpeechWindow[] {
  const { words, duration } = input;
  if (input.keepLength && effect.kind === "pace") throw new SpeechEditError(PACE_ON_VIDEO_PROBLEM);
  const s0 = Math.max(0, Math.min(range.start, range.end));
  const e0 = Math.min(duration, Math.max(range.start, range.end));
  if (!(e0 - s0 >= 0.3)) throw new SpeechEditError("Pick at least a third of a second to change");
  const cuts = cutsOf(words, duration);
  const near = (list: number[], t: number, dir: -1 | 1) => {
    const c = dir < 0 ? cutBefore(list, t) : cutAfter(list, t, duration);
    return Math.abs(c - t) <= 0.5 ? c : null;
  };
  const start = near(cuts.silences, s0, -1) ?? near(cuts.boundaries, s0, -1) ?? s0;
  const end = near(cuts.silences, e0, 1) ?? near(cuts.boundaries, e0, 1) ?? e0;
  const ratio = effect.kind === "pace" ? 1 / effect.speed : 1;
  const budget = windowBudget(ratio);
  const out: SpeechWindow[] = [];
  let a = round3(start);
  while (end - a > 1e-6) {
    let b: number;
    if (end - a <= budget) b = end;
    else {
      // The latest silence inside the budget, else the latest word boundary, else a hard cut at the budget.
      const limit = a + budget;
      const inside = (l: number[]) => l.filter((c) => c > a + 1 && c <= limit).pop();
      b = inside(cuts.silences) ?? inside(cuts.boundaries) ?? limit;
    }
    b = round3(b);
    const said = words.filter((w) => w.start >= a - 1e-6 && w.end <= b + 1e-6).map((w) => w.text).join(" ");
    out.push({ start: a, end: b, seconds: effectLength(effect, b - a), instruction: effectInstruction(effect, said.split(" ").slice(0, 12).join(" ")), label: effectSummary(effect) });
    a = b;
  }
  if (out.length > MAX_WINDOWS) throw new SpeechEditError(`That range needs ${out.length} passes: pick up to ${Math.floor(MAX_WINDOWS * budget)} s at a time`);
  return out;
}

// ---------------------------------------------------------------------------
// Stitching (what the graph does, as times)

/** A piece of the result: the original between `from` and `to`, an edited window's middle, or a seam of the two. */
export type StitchPiece =
  | { kind: "source"; from: number; to: number }
  | { kind: "edit"; window: number; from: number; to: number }
  | { kind: "seam-in"; window: number; at: number; length: number }
  | { kind: "seam-out"; window: number; at: number; length: number };

/**
 * The result as pieces in order, for windows sorted by time and not overlapping: the original up to each window, a seam
 * where the original's first `x` seconds of the window fade out as the edit's fade in, the edit's middle, a seam back, and
 * the original after it. No seam where a window starts the recording or ends it. The result runs the original's length
 * minus each window's old length plus its new one.
 */
export function stitchPlan(windows: SpeechWindow[], duration: number, x = SPEECH_CROSSFADE): StitchPiece[] {
  const pieces: StitchPiece[] = [];
  let at = 0;
  windows.forEach((w, k) => {
    if (w.start < at - 1e-6) throw new SpeechEditError("Edit windows overlap");
    if (w.seconds <= 2 * x) throw new SpeechEditError("An edited window is too short to crossfade");
    const head = w.start > 1e-6;
    const tail = w.end < duration - 1e-6;
    if (w.start - at > 1e-6) pieces.push({ kind: "source", from: round3(at), to: w.start });
    if (head) pieces.push({ kind: "seam-in", window: k, at: w.start, length: x });
    pieces.push({ kind: "edit", window: k, from: head ? x : 0, to: round3(w.seconds - (tail ? x : 0)) });
    if (tail) pieces.push({ kind: "seam-out", window: k, at: round3(w.end - x), length: x });
    at = w.end;
  });
  if (duration - at > 1e-6) pieces.push({ kind: "source", from: round3(at), to: round3(duration) });
  return pieces;
}

export const pieceLength = (p: StitchPiece): number => round3(p.kind === "source" || p.kind === "edit" ? p.to - p.from : p.length);

/** Seconds the edited recording runs. */
export const editedLength = (windows: SpeechWindow[], duration: number): number => round3(windows.reduce((t, w) => t + w.seconds - (w.end - w.start), duration));

/** Where an original time lands in the edited recording (times inside a window scale with it). */
export function mapTime(windows: SpeechWindow[], t: number): number {
  let shift = 0;
  for (const w of windows) {
    if (t <= w.start) break;
    if (t < w.end) return round3(w.start + shift + ((t - w.start) * w.seconds) / (w.end - w.start));
    shift += w.seconds - (w.end - w.start);
  }
  return round3(t + shift);
}

// ---------------------------------------------------------------------------
// Engines, words for the page

/** AuK checkpoints: Flash (distilled, 4 steps, no guidance) by default, the base model for the best take. */
export type AukQuality = "fast" | "best";
export const AUK_SETTINGS: Record<AukQuality, { checkpoint: string; steps: number; cfg: number; label: string }> = {
  fast: { checkpoint: "ckpts/AuK-Flash/auk_flash.safetensors", steps: 4, cfg: 0, label: "Fast" },
  best: { checkpoint: "ckpts/AuK/auk_base.safetensors", steps: 32, cfg: 2, label: "Best" },
};

/** Why the cloud engine has no Edit speech (and what Engine mode "Paid APIs only" says). */
export const CLOUD_SPEECH_EDIT_PROBLEM =
  "Edit speech runs on your GPU (open source): AuK isn't hosted on fal or Replicate, so the cloud engine can't change what was said. Switch to the open engine.";
export const CLOUD_ONLY_SPEECH_EDIT_PROBLEM = "Edit speech runs on your GPU (open source), but this install is set to paid cloud APIs only (Settings → Engine mode)";

/** What the page says about AuK's optional prompt helper. */
export const PROMPT_HELPER_NOTE =
  "Fuobe writes AuK's instruction itself and sets the new length from your words, so AuK's optional Prompt Enhancer (a separate language model) stays off and nothing you type leaves your GPU.";

/** AuK's languages, from its technical report (arXiv 2609.08936: a bilingual Chinese and English corpus). */
export const AUK_LANGUAGES = ["English", "Chinese"];

/** What each quality setting means, in the page's words. */
export const QUALITY_HINTS: Record<AukQuality, string> = {
  fast: "The quickest take, in the same voice",
  best: "Slower, a little closer to the voice",
};

export const engineProblem = (engine: Engine): string | null => (engine === "cloud" ? CLOUD_SPEECH_EDIT_PROBLEM : null);

/** A changed word shown on camera: the result can say so and offer Lipsync, with the times it should cover. */
export function onCameraWarning(kind: "audio" | "video", windows: SpeechWindow[]): string | null {
  if (kind !== "video" || !windows.some((w) => !/^(Pitch|Volume|Clean up|Keep only|Whisper|Normal voice)/.test(w.label))) return null;
  return "If the speaker is on camera when the words change, their lips won't match the new words. Lipsync the changed part to fix it.";
}

// ---------------------------------------------------------------------------
// AuK speech (op tts on oss-auk)

/** The longest line AuK says in one call: its 30 s holds a voice sample and the line together. */
export const AUK_TTS_MAX_SECONDS = 30;
/** The longest voice sample taken: it leaves about 9.5 s for the line. */
export const AUK_TTS_MAX_SAMPLE = 20;

/**
 * AuK's text-to-speech instruction (Cookbook §1): with a voice sample, "Say the following with the same voice"; without
 * one, a voice from its description (a neutral narrator when none is given).
 */
export function ttsInstruction(text: string, o: { hasVoice: boolean; voiceDescription?: string }): string {
  const line = text.replace(/\s+/g, " ").trim().replace(/"/g, "'");
  if (o.hasVoice) return `Say the following with the same voice: "${line}"`;
  const who = (o.voiceDescription?.trim() || "A clear, natural narrator at a moderate pace").replace(/"/g, "'");
  return `Generate speech based on the following description: "${who}". The content to speak is: "${line}".`;
}

/** How long AuK should make a line, and the room its 30 s leaves (a voice sample of `sample` seconds takes the rest). */
export function ttsLength(text: string, sample = 0): number {
  const want = Math.max(1, sayLength(text, DEFAULT_SECONDS_PER_CHAR) + 0.4);
  if (sample > AUK_TTS_MAX_SAMPLE) throw new SpeechEditError(`That voice sample is too long: use one under ${AUK_TTS_MAX_SAMPLE} seconds`);
  const room = AUK_SEQUENCE_MAX - SEQUENCE_MARGIN - sample;
  if (want > room) throw new SpeechEditError(`AuK says up to about ${Math.floor(room)} s per line${sample ? " with this voice sample" : ""}: split the line`);
  return round3(want);
}

// ---------------------------------------------------------------------------
// A run (src/server/audio-tools.ts, tool "speech-edit")

export interface SpeechEditInput {
  engine: Engine;
  /** The recording (/api/files/…): audio, or a video whose soundtrack is edited. */
  media: string;
  kind: "audio" | "video";
  name?: string;
  /** The transcript the edits were made on (Transcribe's lines). */
  cues: Cue[];
  /** Word edits: every line's new text, in the cues' order (unchanged lines as they were). */
  edited?: string[];
  /** Or an effect on a range of the recording. */
  range?: { start: number; end: number };
  effect?: SpeechEffect;
  quality?: AukQuality;
  /** Seconds the recording runs (its header, else the browser's). */
  seconds?: number;
  /** False when the header says the file has no sound. */
  hasAudio?: boolean;
}

export interface SpeechEditPlan extends ToolPlan {
  windows: SpeechWindow[];
  /** Words to show on a video's result: the changed words may be on camera (Lipsync fixes it). */
  warning: string | null;
}

/** The windows a request makes (word edits, else an effect on a range); throws what's in the way, in words the page shows. */
export function speechWindowsFor(i: Pick<SpeechEditInput, "cues" | "edited" | "range" | "effect" | "seconds"> & { kind?: SpeechEditInput["kind"] }): SpeechWindow[] {
  const duration = i.seconds ?? Math.max(0, ...i.cues.map((c) => c.end));
  if (!(duration > 0)) throw new SpeechEditError("Couldn't tell how long the recording runs: add it again");
  const words = wordsFromCues(i.cues);
  // A video's sound must keep its length: the picture is copied as it is, so every word after a change stays in step.
  const keepLength = i.kind === "video";
  if (i.effect) {
    if (!i.range) throw new SpeechEditError("Pick the part to change");
    return planEffectWindows({ words, duration, keepLength }, i.range, i.effect);
  }
  if (!i.edited) throw new SpeechEditError("Edit the words, or pick a range and an effect");
  const changes = diffLines(i.cues, i.edited);
  if (!changes.length) throw new SpeechEditError("Nothing changed yet: edit a line's words first");
  return planTextWindows({ words, duration, keepLength, next: i.edited.flatMap(splitWords) }, changes);
}

/** One AuK job for every window (and, on a video, the stream-copy mux that puts the new sound on the picture). */
export function planSpeechEdit(i: SpeechEditInput): SpeechEditPlan {
  const problem = engineProblem(i.engine);
  if (problem) throw new SpeechEditError(problem);
  if (i.hasAudio === false) throw new SpeechEditError("This file has no sound to edit");
  if (i.seconds && i.seconds > SPEECH_EDIT_MAX_SECONDS) throw new SpeechEditError(`Recordings run up to ${SPEECH_EDIT_MAX_SECONDS / 60} minutes here: trim it first`);
  const windows = speechWindowsFor(i);
  const duration = i.seconds ?? Math.max(0, ...i.cues.map((c) => c.end));
  const name = i.name?.trim() || (i.kind === "video" ? "video" : "recording");
  const what = i.effect ? effectSummary(i.effect) : windows.length === 1 ? windows[0].label : `${windows.length} edits`;
  const title = `${what} · ${name}`.slice(0, 200);
  const video = i.kind === "video";
  const base = { feature: SPEECH_EDIT_FEATURE, batchTitle: title } satisfies Partial<GenerationRequest>;
  const steps: ToolStep[] = [
    {
      key: "edit",
      request: {
        ...base,
        modelId: SPEECH_EDIT_MODEL,
        engine: "open",
        op: "speech-edit",
        title: video ? `Edited sound · ${name}` : title,
        inputs: video ? { video: i.media } : { audio: i.media },
        params: { sourceDuration: round3(duration), extra: { speechWindows: windows, ...(i.quality === "best" && { quality: "best" }) } },
        step: { label: what, index: 0, of: video ? 2 : 1 },
      },
    },
  ];
  if (video) {
    steps.push({
      key: "video",
      after: ["edit"],
      chain: [{ slot: "audio" }],
      request: {
        ...base,
        modelId: SPEECH_EDIT_MUX_MODEL,
        engine: "open",
        op: "mux",
        title,
        inputs: { video: i.media },
        step: { label: "New sound on the video · picture copied", index: 1, of: 2 },
      },
    });
  }
  const warning = onCameraWarning(i.kind, windows);
  return {
    steps,
    windows,
    warning,
    length: editedLength(windows, duration),
    summary: `${windows.length === 1 ? "One part" : `${windows.length} parts`} of the ${video ? "video's sound" : "recording"} ${i.effect ? "changed" : "re-spoken"} by AuK in the same voice and crossfaded back${video ? ", then put back on the picture (copied as it is)" : ""}.`,
    notes: [
      "Each part keeps at least a second of the untouched recording around it, so the new words match the voice and the room.",
      ...(video ? ["On a video every changed part keeps its length, so the sound stays in step with the picture: the new words are fitted into the same time."] : []),
      ...(i.quality === "best" ? [] : ["Best quality is slower and a little closer to the voice."]),
      ...(warning ? [warning] : []),
    ],
  };
}
