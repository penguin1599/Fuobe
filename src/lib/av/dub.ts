import type { Cue } from "@/lib/cues";
import type { ChainSlot, Engine, Generation, GenerationRequest } from "@/lib/catalog/types";
import { languageByCode, supportsTarget, type DubLanguage, type DubRoute } from "./languages";
import { timelineFor } from "./timeline";

/**
 * Translate & dub, planned as plain data (client and server). Two ways to dub:
 *
 * - One shot (cloud): HeyGen Translate or ElevenLabs Dubbing take the video and return it dubbed.
 * - Step by step (both engines), as two pipelines with a review in between:
 *     prepare: voice stem (+ background on the open engine) → timed transcript → translation per language
 *     review:  the person edits the translated lines (nothing is spoken yet)
 *     voice:   speech in the cloned voice → lips re-synced → the new voice over the background
 *
 * The new voice follows the reviewed timing: the lines are grouped into phrases (lines less than
 * PHRASE_GAP apart are spoken in one take), each phrase is spoken on its own and placed at its cue's
 * start on a silent track exactly as long as the source (the "timeline" step), so pauses are kept, the
 * lip re-sync covers the whole clip and the dubbed video is as long as the original.
 *
 * Open engine: one job splits voice and background and Qwen3-ASR 1.7B times the voice stem: MelBand RoFormer
 * (oss-voice-separate, the default) or DBS (oss-dbs-voice-separate: the background keeps the music, the sound effects
 * and any singing, and the split runs on a CPU), picked by the "Voice split" setting (VOICE_SPLITS); the local LLM
 * translates the cues (oss-text-llm); Chatterbox Multilingual
 * speaks each phrase in the cloned voice; the audio-timeline workflow lays them out; InfiniteTalk
 * re-syncs the lips and the mux mixes the voice over the background stem.
 * Cloud: ElevenLabs Voice Isolation (the clean voice to clone), Scribe v2 on it (transcript), Claude or
 * a local model (translation), and in parallel the source's sound split by Demucs (drums, bass and other: the
 * music and effects). ElevenLabs v4 speaks each phrase, fal's compose lays them out over a blank still
 * (its soundtrack is read back as audio), Chatterbox voice conversion turns the track into the speaker's
 * voice and Sync Lipsync 3 re-syncs the lips; compose then mixes the new voice over the Demucs stems and
 * that mix replaces the video's sound. Like the open mux, the background sits BACKGROUND_DB under its
 * original level: fal's compose has no volume control, so each stem is lowered first by fal's loudnorm
 * in linear mode (see linearGain). Dubs started before the background split, or whose split failed (or
 * found nothing but the voice), carry the dubbed voice only.
 */

export const DUB_FEATURE = "dub";

export const ONE_SHOT_MODELS = ["heygen-translate", "heygen-translate-fast", "elevenlabs-dubbing"] as const;
export type OneShotModel = (typeof ONE_SHOT_MODELS)[number];

export const DUB_STEP_MODELS = {
  cloud: {
    voice: "elevenlabs-voice-isolation",
    words: "scribe-v2",
    translate: "text-llm",
    // The music and effects: the source's sound, split into stems (everything but the vocals is the background).
    sound: "extract-soundtrack",
    stems: "demucs",
    speech: "elevenlabs-v4",
    timeline: "compose-timeline",
    soundtrack: "extract-soundtrack",
    clone: "chatterbox-vc-cloud",
    // Each background stem a little lower before the mix (compose has no volume control).
    level: "ffmpeg-loudnorm",
    lips: "sync-lipsync-3",
    mux: "merge-audio-video",
  },
  // The stems step also times the voice (Qwen3-ASR 1.7B + forced aligner inside the same workflow). Its model is the
  // default voice split's: the "Voice split" setting picks another (VOICE_SPLITS, voiceSplitModel).
  open: { stems: "oss-voice-separate", translate: "oss-text-llm", speech: "oss-chatterbox", timeline: "oss-audio-timeline", lips: "oss-infinitetalk-v2v", mux: "oss-mux" },
} as const;

/** What a music separation model (MelBand RoFormer, Demucs) does to a film's soundtrack, said beside it. */
export const MUSIC_MODEL_NOTE = "Music model: some sound effects may be lowered, and singing may be replaced";

/** The cloud dub's line about keeping the whole soundtrack: DBS isn't hosted, so it runs on your GPU only. */
export const DBS_OPEN_ONLY_NOTE = "Keeping the music and sound effects of the original (DBS) runs on your GPU (open source)";

/**
 * The open engine's voice split (the dub's first step), the "Voice split" setting. DBS was trained for film-style
 * dialogue, music and effects, so the background keeps the score, the sound effects and any singing; MelBand RoFormer
 * is a vocals model (singing goes with the voice and is replaced). MelBand stays the default: on the separation suite's
 * synthetic mixes (no singing, synthesized effects; DBS D4, docs/research/dbs-separation-7.md §9 D4) it scored higher than
 * DBS and its transcripts were as good, so DBS becomes the default only when real clips rated blind say so. Both return
 * the same stems and cues, so nothing after the split changes.
 */
export const VOICE_SPLITS = {
  melband: { modelId: "oss-voice-separate", name: "MelBand RoFormer", note: MUSIC_MODEL_NOTE },
  dbs: { modelId: "oss-dbs-voice-separate", name: "DBS", note: "Keeps the music and sound effects of the original" },
} as const;
export type VoiceSplit = keyof typeof VOICE_SPLITS;
export const VOICE_SPLIT_IDS = Object.keys(VOICE_SPLITS) as VoiceSplit[];
export const DEFAULT_VOICE_SPLIT: VoiceSplit = "melband";

/**
 * The voice split a dub runs: the one named, else the default when its model is offered (`on`, Settings → Models &
 * licences), else the next split that is, else the default (its run then refuses, naming the switch). The studio's
 * picker drops a split that is off the same way, so the server's default and the studio's agree.
 */
export function pickVoiceSplit(split?: string, on?: (modelId: string) => boolean): VoiceSplit {
  if (split && split in VOICE_SPLITS) return split as VoiceSplit;
  const order = [DEFAULT_VOICE_SPLIT, ...VOICE_SPLIT_IDS.filter((k) => k !== DEFAULT_VOICE_SPLIT)];
  return (on && order.find((k) => on(VOICE_SPLITS[k].modelId))) || DEFAULT_VOICE_SPLIT;
}

/** The open dub's first-step model for a voice split (pickVoiceSplit's when none or an unknown one is named). */
export function voiceSplitModel(split?: string, on?: (modelId: string) => boolean): string {
  return VOICE_SPLITS[pickVoiceSplit(split, on)].modelId;
}

/** How far the background (music and effects) sits under its original level once the new voice is on, both engines. */
export const BACKGROUND_DB = -3;

/**
 * fal loudnorm parameters (ffmpeg's loudnorm filter) that change a track's level by `db` and nothing else.
 * In linear mode loudnorm doesn't measure: it trusts the measurements it's given and scales the whole
 * track by (target − measured_I) dB, as long as the "measured" true peak plus that gain stays under the
 * target peak and the "measured" range under the target range — true here. So the gain is exact whatever
 * the track's real loudness, with no dynamics and no limiter, which is why it only lowers (a raise could clip).
 */
export function linearGain(db: number): Record<string, number | boolean> {
  const gain = Math.min(0, db);
  const target = -24;
  return { linear: true, integrated_loudness: target, measured_i: target - gain, measured_tp: -12, measured_lra: 1, measured_thresh: target - 10, loudness_range: 7 };
}

/** The ElevenLabs voice the cloud route speaks with before it's converted into the speaker's own voice. */
export const CLOUD_BASE_VOICE = "JBFqnCBsd6RMkjVDRZzb"; // George

/** A 64×64 black PNG: the picture fal's compose renders the cloud voice track over (only its soundtrack is kept). */
export const BLANK_FRAME = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAAAAACPAi4CAAAAG0lEQVR42u3BgQAAAADDoPlT3+AEVQEAAAB8AxBAAAG9PLePAAAAAElFTkSuQmCC";

export interface DubStep {
  key: string;
  request: GenerationRequest;
  after?: string | string[];
  chain?: ChainSlot[];
}

export const translateKey = (code: string) => `translate:${code}`;

const step = (label: string, index: number, of: number) => ({ label, index, of });

function targetsFor(route: DubRoute, codes: string[]): DubLanguage[] {
  const out: DubLanguage[] = [];
  for (const code of codes) {
    const lang = languageByCode(code);
    if (!lang) throw new Error(`Unknown language “${code}”`);
    if (!supportsTarget(route, lang)) throw new Error(`${lang.name} isn't available ${route === "open" ? "on the open engine (Chatterbox speaks 23 languages)" : "on this model"}`);
    if (!out.includes(lang)) out.push(lang);
  }
  if (!out.length) throw new Error("Pick at least one language to dub into");
  return out;
}

export interface PrepareInput {
  engine: Engine;
  video: string;
  /** ISO code of the spoken language, or "auto". */
  source?: string;
  targets: string[];
  title?: string;
  /** Open engine: the voice split (default DEFAULT_VOICE_SPLIT). The cloud ignores it. */
  voiceSplit?: VoiceSplit;
  /**
   * "gpu": the translations run on the asker's own ComfyUI (Qwen3.5 4B, GPU_TRANSLATE_MODEL), never on the install's
   * AI helper: a signed-in account's dub, on either engine. Default: the install's text model (DUB_STEP_MODELS).
   */
  translator?: "gpu";
  /** The video's length (seconds): how long a GPU translation may write. */
  seconds?: number;
}

/** The ComfyUI translator an account's dub uses (translate-qwen35-textgen): on its own GPU, timings kept. */
export const GPU_TRANSLATE_MODEL = "oss-qwen35-translate";

/**
 * The GPU translator's instruction: the transcript reaches it as the chained JSON list of timed lines, and its answer is
 * one "start-end: text" line per line, which the result reads back as timed lines.
 */
export const GPU_TRANSLATE_INSTRUCTION =
  'The text below is a JSON list of subtitle lines. Each line has a "start" and an "end" time in seconds and its "text". Translate the text of every line into {language}. Write one line per item, in the same order, as start-end: translation, with the start and end numbers exactly as given (for example 0.5-2.75: translation). Keep each translation about as long as the original so it can be spoken in the same time. Output only those lines.\n\n';

/** How many tokens the GPU translator may write for a video this long (about 10 a second, within its limits). */
export function gpuTranslateTokens(seconds?: number): number {
  if (!seconds || !(seconds > 0)) return 8192;
  return Math.min(16_384, Math.max(2048, Math.ceil(seconds * 10)));
}

/** Who is looking, as the studio's status says it (useStatus().data?.viewer): its own GPU and keys. */
export interface DubViewer {
  kind: "guest" | "account";
  gpu?: { connected: boolean };
  keys?: readonly string[];
}

/**
 * Whether "Review the script first" waits for the viewer's own GPU: a signed-in account's translations run there
 * (GPU_TRANSLATE_MODEL; no fal.ai or Replicate model translates text), so an account with a key and no GPU dubs in one
 * shot on its key instead, or connects its GPU for the review. False for the owner, a guest (asked to sign up first) and
 * an account with neither (asked to connect before its video is added).
 */
export function stepsNeedGpu(viewer: DubViewer | undefined): boolean {
  return viewer?.kind === "account" && !viewer.gpu?.connected && !!viewer.keys?.length;
}

/** Step 1 (both engines): the voice to clone, the timed transcript and one translation per target language. */
export function prepareSteps(o: PrepareInput): DubStep[] {
  const targets = targetsFor(o.engine === "open" ? "open" : "cloud-steps", o.targets);
  const source = o.source && o.source !== "auto" ? o.source : undefined;
  const from = languageByCode(source)?.name;
  const n = targets.length + 2;
  const base = { feature: DUB_FEATURE, ...(o.title && { batchTitle: o.title }) };
  const translate = (lang: DubLanguage, i: number, after: string, of = n): DubStep => ({
    key: translateKey(lang.code),
    after,
    chain: [{ slot: "prompt" }],
    request: {
      ...base,
      modelId: o.translator === "gpu" ? GPU_TRANSLATE_MODEL : o.engine === "open" ? DUB_STEP_MODELS.open.translate : DUB_STEP_MODELS.cloud.translate,
      op: "translate",
      params: {
        targetLanguage: lang.name,
        ...(from && { sourceLanguage: from }),
        ...(o.translator === "gpu" && { extra: { instruction: GPU_TRANSLATE_INSTRUCTION, maxTokens: gpuTranslateTokens(o.seconds) } }),
      },
      step: step(`Translate · ${lang.name}`, i, of),
    },
  });
  const lang = source ? { params: { sourceLanguage: source } } : {};
  // The transcript is made from the clean voice stem (music and effects removed), so the timings follow the speech.
  if (o.engine === "open") {
    // One job splits the stems and times the voice stem (Qwen3-ASR 1.7B); the translations read its cues.
    const m = targets.length + 1;
    return [
      { key: "stems", request: { ...base, modelId: voiceSplitModel(o.voiceSplit), op: "separate-audio", inputs: { video: o.video }, ...lang, step: step("Voice, background and transcript", 0, m) } },
      ...targets.map((l, i) => translate(l, i + 1, "stems", m)),
    ];
  }
  const m = DUB_STEP_MODELS.cloud;
  const c = n + 2;
  return [
    { key: "voice", request: { ...base, modelId: m.voice, op: "separate-audio", inputs: { video: o.video }, step: step("Clean voice", 0, c) } },
    { key: "words", after: "voice", chain: [{ slot: "audio" }], request: { ...base, modelId: m.words, op: "transcribe", ...lang, step: step("Transcript", 1, c) } },
    ...targets.map((l, i) => translate(l, i + 2, "words", c)),
    // Demucs reads audio, not a video: the soundtrack first, then the stems the new voice is mixed over.
    { key: "sound", request: { ...base, modelId: m.sound, op: "separate-audio", inputs: { video: o.video }, step: step("Original sound", n, c) } },
    { key: "background", after: "sound", chain: [{ slot: "audio" }], request: { ...base, modelId: m.stems, op: "separate-audio", step: step("Music and effects", n + 1, c) } },
  ];
}

/** Prepare steps a dub can do without: when the cloud background split fails, the dub keeps the voice only. */
export const OPTIONAL_PREPARE = new Set(["sound", "background"]);

const VOICE_STEMS = ["voice", "vocals", "speech", "target"];
const BACKGROUND_STEMS = ["background", "accompaniment", "instrumental", "residual", "no_vocals"];

export interface VoiceInput {
  engine: Engine;
  video: string;
  lang: string;
  /** The reviewed lines, in order. */
  cues: Cue[];
  /** The clean voice to clone (the voice stem / isolated voice). */
  voiceRef: string;
  /**
   * What the new voice is mixed over: the open engine's background stem, or on the cloud the Demucs stems
   * that aren't the voice (drums, bass, other). Either way it's lowered by BACKGROUND_DB.
   */
  background?: string | string[];
  /** Re-sync the lips (default on). Off: the new voice is laid over the original picture. */
  lipsync?: boolean;
  /** Length of the source video (seconds): the voice track is exactly this long. Unknown: a second past the last line. */
  duration?: number;
  title?: string;
}

/** The words the voice speaks: the reviewed lines, one per line. */
export function spokenText(cues: Cue[]): string {
  return cues
    .map((c) => c.text.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** Lines closer than this (seconds) are one breath: spoken in one take, so the speech flows. */
export const PHRASE_GAP = 0.4;
/** A take this long (seconds) starts a new phrase anyway, so long speech re-syncs to the cues often. */
export const PHRASE_MAX = 12;

/** One take of the new voice: it starts at `start`; `end` is where its lines end in the source. */
export interface DubPhrase {
  start: number;
  end: number;
  text: string;
}

/**
 * The reviewed lines as takes: lines less than PHRASE_GAP apart join (up to PHRASE_MAX seconds), empty
 * lines are skipped and lines at or past the end of the video (when its length is known) are dropped.
 */
export function dubPhrases(cues: Cue[], length?: number): DubPhrase[] {
  const lines = cues
    .map((c) => ({ start: Math.max(0, c.start), end: Math.max(c.start, c.end), text: c.text.replace(/\s+/g, " ").trim() }))
    .filter((c) => c.text && (!length || c.start < length))
    .sort((a, b) => a.start - b.start);
  const out: DubPhrase[] = [];
  for (const c of lines) {
    const last = out.at(-1);
    if (last && c.start - last.end < PHRASE_GAP && c.end - last.start <= PHRASE_MAX) {
      last.end = Math.max(last.end, c.end);
      last.text = `${last.text} ${c.text}`;
    } else out.push({ ...c });
  }
  return out;
}

/** The voice track's length: the video's, else a second past the last line. */
export function trackLength(phrases: DubPhrase[], duration?: number): number {
  if (duration && duration > 0) return duration;
  return Math.ceil(((phrases.at(-1)?.end ?? 0) + 1) * 10) / 10;
}

/**
 * Step 2: speak the reviewed translation in the cloned voice, one take per phrase, and lay the takes on
 * the video's timeline; then re-sync the lips and put the new voice on the video. Step keys: "line:0…"
 * (the takes), "track" (the voice track, as long as the video), cloud "soundtrack" + "clone", "lips"
 * (open; cloud when it mixes a background), cloud "bed:0…" (each background stem lowered) and "mix"
 * (the voice over them), and "film" (the dubbed video).
 */
export function voiceSteps(o: VoiceInput): DubStep[] {
  const lang = languageByCode(o.lang);
  if (!lang) throw new Error(`Unknown language “${o.lang}”`);
  if (o.engine === "open" && !supportsTarget("open", lang)) throw new Error(`${lang.name} isn't available on the open engine`);
  const phrases = dubPhrases(o.cues, o.duration);
  if (!phrases.length) throw new Error(o.cues.some((c) => c.text.trim()) ? "Every line starts after the end of the video — check the times" : "There are no lines to speak — write at least one");
  const length = trackLength(phrases, o.duration);
  const timeline = timelineFor(
    phrases.map((p) => p.start),
    length,
  );
  const lips = o.lipsync !== false;
  const beds = o.background === undefined ? [] : Array.isArray(o.background) ? o.background : [o.background];
  const base = { feature: DUB_FEATURE, ...(o.title && { batchTitle: o.title }) };
  const tag = (label: string) => `${label} · ${lang.name}`;
  const k = phrases.length;
  const lineKeys = phrases.map((_, i) => `line:${i}`);
  // Every take at its cue time over silence as long as the video.
  const track = (modelId: string, of: number, inputs?: GenerationRequest["inputs"]): DubStep => ({
    key: "track",
    after: lineKeys,
    chain: lineKeys.map(() => ({ slot: "audios" as const })),
    request: { ...base, modelId, op: "timeline", ...(inputs && { inputs }), params: { duration: length, extra: { timeline } }, step: step(tag("Voice on the timeline"), k, of) },
  });
  if (o.engine === "open") {
    const m = DUB_STEP_MODELS.open;
    const n = k + (lips ? 3 : 2);
    const steps: DubStep[] = phrases.map((p, i) => ({
      key: lineKeys[i],
      request: { ...base, modelId: m.speech, op: "tts", prompt: p.text, inputs: { voiceAudio: o.voiceRef }, params: { targetLanguage: lang.chatterbox }, step: step(tag(`Line ${i + 1} of ${k}`), i, n) },
    }));
    steps.push(track(m.timeline, n));
    if (lips) {
      steps.push({ key: "lips", after: "track", chain: [{ slot: "audio" }], request: { ...base, modelId: m.lips, op: "lipsync", inputs: { video: o.video }, step: step(tag("Lips"), k + 1, n) } });
    }
    steps.push({
      key: "film",
      after: lips ? ["lips", "track"] : "track",
      chain: lips ? [{ slot: "video" }, { slot: "audio" }] : [{ slot: "audio" }],
      request: {
        ...base,
        modelId: m.mux,
        op: "mux",
        inputs: { ...(lips ? {} : { video: o.video }), ...(beds[0] && { audio2: beds[0] }) },
        // The background stem sits a little under the new voice.
        ...(beds[0] && { params: { extra: { backgroundVolumeDb: BACKGROUND_DB } } }),
        step: step(tag("Dubbed video"), n - 1, n),
      },
    });
    return steps;
  }
  const m = DUB_STEP_MODELS.cloud;
  const mixed = beds.length > 0;
  const n = k + 3 + (mixed ? beds.length + (lips ? 3 : 2) : 1);
  // Seconds of media the per-second and per-minute steps bill for (their price estimate).
  const timed = { params: { duration: length } };
  const steps: DubStep[] = phrases.map((p, i) => ({
    key: lineKeys[i],
    request: { ...base, modelId: m.speech, op: "tts", prompt: p.text, params: { voice: CLOUD_BASE_VOICE }, step: step(tag(`Line ${i + 1} of ${k}`), i, n) },
  }));
  // fal's compose renders a video: the track goes over a blank still and its soundtrack is read back as audio.
  steps.push(track(m.timeline, n, { images: [BLANK_FRAME] }));
  steps.push({ key: "soundtrack", after: "track", chain: [{ slot: "video" }], request: { ...base, modelId: m.soundtrack, op: "separate-audio", ...timed, step: step(tag("Voice track"), k + 1, n) } });
  steps.push({ key: "clone", after: "soundtrack", chain: [{ slot: "audio" }], request: { ...base, modelId: m.clone, op: "voice-change", inputs: { voiceAudio: o.voiceRef }, ...timed, step: step(tag("Their voice"), k + 2, n) } });
  if (!mixed) {
    // No background to keep: the new voice alone goes on the video (re-synced, or over the original picture).
    const film = lips ? { modelId: m.lips, op: "lipsync" as const } : { modelId: m.mux, op: "mux" as const };
    steps.push({ key: "film", after: "clone", chain: [{ slot: "audio" }], request: { ...base, ...film, inputs: { video: o.video }, ...timed, step: step(tag("Dubbed video"), k + 3, n) } });
    return steps;
  }
  // Each background stem lowered by BACKGROUND_DB (these start at once, next to the takes); the lips follow
  // the clean voice; the mix is a compose over the blank still with the voice and every lowered stem as
  // tracks of their own for the whole length, and its sound replaces the video's.
  const bedKeys = beds.map((_, i) => `bed:${i}`);
  beds.forEach((url, i) =>
    steps.push({
      key: bedKeys[i],
      request: { ...base, modelId: m.level, op: "level", inputs: { audio: url }, params: { extra: linearGain(BACKGROUND_DB) }, step: step(tag(`Music and effects ${i + 1} of ${beds.length}`), k + 3 + i, n) },
    }),
  );
  if (lips) steps.push({ key: "lips", after: "clone", chain: [{ slot: "audio" }], request: { ...base, modelId: m.lips, op: "lipsync", inputs: { video: o.video }, ...timed, step: step(tag("Lips"), k + 3 + beds.length, n) } });
  const whole = { start: 0, duration: length };
  steps.push({
    key: "mix",
    after: ["clone", ...bedKeys],
    chain: ["clone", ...bedKeys].map(() => ({ slot: "audios" as const, position: "first" as const })),
    request: {
      ...base,
      modelId: m.timeline,
      op: "timeline",
      inputs: { images: [BLANK_FRAME] },
      params: { duration: length, extra: { timeline: { length, clips: [whole, ...beds.map(() => whole)] } } },
      step: step(tag("Over the music and effects"), n - 2, n),
    },
  });
  steps.push({
    key: "film",
    after: lips ? ["lips", "mix"] : "mix",
    chain: lips ? [{ slot: "video" }, { slot: "audio" }] : [{ slot: "audio" }],
    request: { ...base, modelId: m.mux, op: "mux", ...(!lips && { inputs: { video: o.video } }), ...timed, step: step(tag("Dubbed video"), n - 1, n) },
  });
  return steps;
}

/** One-shot cloud dubs: one job per language. */
export function oneShotRequests(o: { model: OneShotModel; video: string; source?: string; targets: string[]; title?: string }): { lang: DubLanguage; request: GenerationRequest }[] {
  const targets = targetsFor(o.model, o.targets);
  const source = o.source && o.source !== "auto" ? o.source : undefined;
  return targets.map((lang, i) => ({
    lang,
    request: {
      feature: DUB_FEATURE,
      ...(o.title && { batchTitle: o.title }),
      modelId: o.model,
      op: "dub",
      inputs: { video: o.video },
      params: {
        targetLanguage: o.model === "elevenlabs-dubbing" ? lang.eleven : lang.heygen,
        ...(o.model === "elevenlabs-dubbing" && source && { sourceLanguage: source }),
      },
      step: { label: `Dub · ${lang.name}`, index: i, of: targets.length },
    },
  }));
}

// ---------------------------------------------------------------------------
// Sessions (stored by the server, shown by the studio)

export interface DubVoiceRun {
  /** Generation id per step key ("speech", "clone", "lips", "film"). */
  ids: Record<string, string>;
  at: number;
  lipsync: boolean;
}

export interface DubSession {
  id: string;
  title: string;
  engine: Engine;
  mode: "oneshot" | "steps";
  video: string;
  source: string;
  targets: string[];
  model?: OneShotModel;
  /** Length of the source video (seconds), when known: the dubbed voice track is made this long. */
  duration?: number;
  /** Open engine, step mode: the voice split its first step ran (none on dubs made before the setting: MelBand). */
  voiceSplit?: VoiceSplit;
  batchId: string;
  /** Step mode: the prepare pipeline's generation ids by step key. */
  prepare?: Record<string, string>;
  /** Reviewed lines per language (saved as the person edits). */
  drafts?: Record<string, Cue[]>;
  /** Voice runs per language, newest last. */
  voices?: Record<string, DubVoiceRun[]>;
  /** One-shot jobs per language. */
  oneshot?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export type DubStage = "preparing" | "review" | "voicing" | "done" | "failed";

/** What a dub step (prepare or voice) costs before it runs. */
export interface DubPrice {
  engine: Engine;
  /** What the priced steps cost together (USD); 0 on the open engine. */
  costUsd: number;
  /** Models with no listed price (ElevenLabs speech per character, the LLM's tokens): not in costUsd. */
  unpriced: string[];
  /** The steps would run as a demo (no key / no GPU): free. */
  demo: boolean;
  steps: number;
}

/** The price as one short line: "≈ $8.13 + ElevenLabs v4", "Placeholder · free", "Free on your GPU". */
export function priceLine(p: DubPrice): string {
  if (p.demo) return "Placeholder · free";
  if (p.engine === "open") return "Free on your GPU";
  const usd = p.costUsd > 0 && p.costUsd < 0.01 ? "< $0.01" : `≈ $${p.costUsd.toFixed(2)}`;
  return p.unpriced.length ? `${usd} + ${p.unpriced.join(" + ")}` : usd;
}

/** Characters a voice speaks per second, about (used to flag lines that won't fit before the next one). */
const SPOKEN_CPS = 16;

/** Takes whose words likely run past the next take's start (they'd be cut there): the lines (indexes) each take speaks. */
export function crowdedLines(cues: Cue[], duration?: number): { first: number; last: number }[] {
  const phrases = dubPhrases(cues, duration);
  const length = trackLength(phrases, duration);
  const out: { first: number; last: number }[] = [];
  phrases.forEach((p, i) => {
    const room = (i + 1 < phrases.length ? phrases[i + 1].start : length) - p.start;
    if (p.text.length / SPOKEN_CPS <= room + 0.25) return;
    const inside = cues.flatMap((c, k) => (c.text.trim() && Math.max(0, c.start) >= p.start && c.start < p.end ? [k] : []));
    if (inside.length) out.push({ first: inside[0], last: inside.at(-1)! });
  });
  return out;
}

/** "line 3", "lines 1–4": the lines a crowded take speaks. */
export const takeLines = (t: { first: number; last: number }) => (t.first === t.last ? `line ${t.first + 1}` : `lines ${t.first + 1}–${t.last + 1}`);

/** A session with its generations, as the studio shows it. */
export interface DubSessionView extends DubSession {
  generations: Record<string, Generation>;
}

const done = (g?: Generation) => g?.status === "succeeded";
const broken = (g?: Generation) => g?.status === "failed" || g?.status === "canceled";

/** The translated lines of a language: the saved draft, else the translation step's cues. */
export function reviewCues(s: DubSessionView, code: string): Cue[] | null {
  if (s.drafts?.[code]) return s.drafts[code];
  const g = s.generations[s.prepare?.[translateKey(code)] ?? ""];
  const out = g?.outputs.find((o) => o.kind === "text");
  const cues = out?.meta?.cues;
  if (Array.isArray(cues) && cues.length) return (cues as Cue[]).map((c) => ({ start: c.start, end: c.end, text: c.text }));
  if (typeof out?.text === "string" && out.text.trim()) {
    // A translation without timings (plain text): one line per cue, spread evenly is the best we can do.
    const lines = out.text.split("\n").filter((l) => l.trim());
    return lines.map((text, i) => ({ start: i * 3, end: i * 3 + 2.8, text }));
  }
  return null;
}

/** The stage of one language: still preparing, ready for review, being voiced, done or failed. */
export function languageStage(s: DubSessionView, code: string): DubStage {
  if (s.mode === "oneshot") {
    const g = s.generations[s.oneshot?.[code] ?? ""];
    return done(g) ? "done" : broken(g) ? "failed" : "voicing";
  }
  const prep = Object.entries(s.prepare ?? {}).filter(([k]) => !k.startsWith("translate:") || k === translateKey(code));
  const needed = prep.filter(([k]) => !OPTIONAL_PREPARE.has(k)).map(([, id]) => s.generations[id]);
  // The background split is waited for (the voice is mixed over it), but a failure there only loses the music.
  const optional = prep.filter(([k]) => OPTIONAL_PREPARE.has(k)).map(([, id]) => s.generations[id]);
  if (needed.some(broken)) return "failed";
  if (!needed.every(done) || !optional.every((g) => !g || done(g) || broken(g))) return "preparing";
  const run = s.voices?.[code]?.at(-1);
  if (!run) return "review";
  const film = s.generations[run.ids.film];
  const all = Object.values(run.ids).map((id) => s.generations[id]);
  if (all.some(broken)) return "failed";
  return done(film) ? "done" : "voicing";
}

const stemOf = (o: { meta?: Record<string, unknown> }) => (typeof o.meta?.stem === "string" ? o.meta.stem.toLowerCase() : "");

/**
 * The clean voice to clone and what it's mixed over, from the finished prepare steps: the open engine's
 * background stem, or the cloud's Demucs stems that aren't the voice (none when that split failed).
 */
export function prepareMedia(s: DubSessionView): { voice?: string; background?: string | string[] } {
  const audioOf = (key: string) => (s.generations[s.prepare?.[key] ?? ""]?.outputs ?? []).filter((o) => o.kind === "audio");
  if (s.engine === "open") {
    const audio = audioOf("stems");
    return { voice: audio.find((o) => VOICE_STEMS.includes(stemOf(o)))?.url ?? audio[0]?.url, background: audio.find((o) => BACKGROUND_STEMS.includes(stemOf(o)))?.url };
  }
  const split = s.generations[s.prepare?.background ?? ""];
  const beds = done(split) ? audioOf("background").filter((o) => !VOICE_STEMS.includes(stemOf(o))).map((o) => o.url) : [];
  return { voice: audioOf("voice")[0]?.url, ...(beds.length && { background: beds }) };
}

/**
 * Whether a cloud step-by-step dub lost its music and effects: started before the split, the split
 * failed, or it found nothing but the voice. (While the split runs, the language is still preparing.)
 */
export function voiceOnly(s: DubSessionView): boolean {
  if (s.engine !== "cloud" || s.mode !== "steps") return false;
  const split = s.generations[s.prepare?.background ?? ""];
  if (!split || broken(split)) return true;
  return done(split) && !prepareMedia(s).background;
}

/** The finished dub of a language, if any. */
export function dubResult(s: DubSessionView, code: string): Generation | undefined {
  const id = s.mode === "oneshot" ? s.oneshot?.[code] : s.voices?.[code]?.at(-1)?.ids.film;
  const g = id ? s.generations[id] : undefined;
  return done(g) ? g : undefined;
}
