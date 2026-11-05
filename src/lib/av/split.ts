import type { Engine, GenerationRequest } from "@/lib/catalog/types";
import { clock, type ToolPlan } from "./audio-tools";

/**
 * Audio → Split soundtrack (DBS D1, docs/research/dbs-separation-7.md): any audio or video split into Dialogue,
 * Music, Effects and Music & effects stems, a free live mixer over them, and the mix exported or put back on the video.
 * Pure: the page and the server (src/server/audio-tools.ts) share it, and the ComfyUI provider takes its model and
 * channel rules.
 *
 * - Open engine (ComfyUI + ComfyUI-DBS, CPU or GPU): one job on oss-dbs-separate (graph separate-soundtrack-dbs).
 * - Cloud: none. DBS is hosted nowhere and no other model stands in for it: the cloud engine says the tool runs on your GPU. A result's mix still goes back on a video on either engine
 *   (oss-mux / fal merge-audio-video).
 */

export const SPLIT_FEATURE = "audio-split";
export const SPLIT_MODEL = "oss-dbs-separate";
/** An account's Export mix, kept as one of its runs (the owner's is an upload in the Library). */
export const MIX_FEATURE = "audio-split-mix";
export const MIX_MODEL = "local-mix";
/** Putting a mix back on its video: the open stream-copy mux, or fal's merge on the cloud. */
export const REMUX_FEATURE = "audio-split-remux";
export const REMUX_MODELS: Record<Engine, string> = {
  open: "oss-mux",
  cloud: "merge-audio-video",
};

/** Why the cloud engine has no Split soundtrack (and what Engine mode "Paid APIs only" says). */
export const CLOUD_SPLIT_PROBLEM =
  "Split soundtrack works with open-source models. Switch to Open source to use it.";
export const CLOUD_ONLY_PROBLEM = "Split soundtrack works with open-source models, which aren't available here";

// ---------------------------------------------------------------------------
// The DBS models and how a host picks one

export type SplitQuality = "fast" | "best";
export type DbsModel = "DBS-BSRNN-DnR" | "DBS-TIGER-DnR";
export const DBS_MODELS: Record<SplitQuality, DbsModel> = {
  fast: "DBS-BSRNN-DnR",
  best: "DBS-TIGER-DnR",
};
export const QUALITY_LABELS: Record<SplitQuality, string> = {
  fast: "Fast (DBS-BSRNN)",
  best: "Best (DBS-TIGER)",
};
export type DbsChannels = "mono" | "each channel";

/**
 * The DBS models a host has on disk, from GET /models/dbs (paths under the folder; a Windows ComfyUI lists them with
 * back slashes): both files of a model, or it isn't there. Undefined when the host can't say (no list).
 */
export function installedDbs(files: readonly string[] | null | undefined): DbsModel[] | undefined {
  if (!files) return undefined;
  const have = new Set(files.map((f) => f.replace(/\\/g, "/")));
  return Object.values(DBS_MODELS).filter((m) => have.has(`${m}/model.safetensors`) && have.has(`${m}/config.json`));
}

const qualityOf = (m: DbsModel): SplitQuality => (m === DBS_MODELS.best ? "best" : "fast");

/**
 * The model a host does best with: DBS-TIGER (10.13 dB) on a CUDA GPU, where both run well over 10x real time
 * (ROCm reports "cuda" too); DBS-BSRNN (9.07 dB) on a CPU, where it runs about 3x faster than DBS-TIGER (§2.4). When
 * the host's list of DBS models is known and its pick isn't on disk, the other one if that is.
 */
export function hostPick(deviceType?: string | null, installed?: readonly DbsModel[]): SplitQuality {
  const want: SplitQuality = deviceType === "cuda" ? "best" : "fast";
  if (!installed || installed.includes(DBS_MODELS[want])) return want;
  const other: SplitQuality = want === "best" ? "fast" : "best";
  return installed.includes(DBS_MODELS[other]) ? other : want;
}

/** Why a DBS model can't run on this host: its files aren't in models/dbs. */
export function missingDbs(model: DbsModel, installed: readonly DbsModel[]): string {
  const q = qualityOf(model);
  const other = installed.find((m) => m !== model);
  return `${QUALITY_LABELS[q]} isn't installed on your ComfyUI (models/dbs/${model}). Copy the install commands from the Connect your GPU page${other ? `, or pick ${QUALITY_LABELS[qualityOf(other)]}` : ""}.`;
}

/**
 * The DBSLoader model a run gets: the one asked for ("fast" / "best" or the model's name), else the host's pick. With
 * the host's list of DBS models known, a model it doesn't have is refused here, in words, rather than failing inside
 * ComfyUI.
 */
export function dbsModelFor(asked: unknown, deviceType?: string | null, installed?: readonly DbsModel[]): DbsModel {
  const named: DbsModel | undefined = asked === "DBS-BSRNN-DnR" || asked === "DBS-TIGER-DnR" ? asked : asked === "fast" || asked === "best" ? DBS_MODELS[asked] : undefined;
  const model = named ?? DBS_MODELS[hostPick(deviceType, installed)];
  if (installed && !installed.includes(model)) throw new Error(missingDbs(model, installed));
  return model;
}

/**
 * ComfyUI saves audio (SaveAudioAdvanced, comfy_api's AudioSaveHelper) as mono or stereo only: a waveform with more
 * channels is written as "stereo" with its samples interleaved as if it had two, so a 4 s 5.1 stem comes out as 12 s
 * of scrambled stereo (seen on the worker). A file with more channels is therefore split in mono.
 */
export const SAVE_MAX_CHANNELS = 2;

/** A source with more channels than ComfyUI can save (5.1, 7.1): split in mono, with a mono Music & effects. */
export const surroundSource = (channels?: number | null): boolean => typeof channels === "number" && channels > SAVE_MAX_CHANNELS;

/**
 * DBSSeparate's channel mode: "mono" (the mean of the channels, the official usage) unless stereo stems are asked
 * for. A mono file is one pass either way, and a file with more than 2 channels is split in mono too: ComfyUI can't save
 * its channels (SAVE_MAX_CHANNELS), and its background is then made from the music and effects stems (dbsSurroundBed),
 * not the original minus the speech, which would keep all its channels.
 */
export function dbsChannelsFor(asked: unknown, channels?: number | null): DbsChannels {
  if (channels === 1 || surroundSource(channels)) return "mono";
  return asked === "each channel" || asked === "stereo" || asked === true ? "each channel" : "mono";
}

type GraphNode = { class_type: string; inputs: Record<string, unknown> };
const linkedTo = (v: unknown, node: string, slot: number) => Array.isArray(v) && v[0] === node && v[1] === slot;

/**
 * Graph A's background for a surround source: the music and effects stems added up (AudioMerge add, mono) in place of
 * the original minus the speech (which has the source's 6 or 8 channels, more than ComfyUI can save). The graph as it is
 * when it has no DBSSeparate or no such merge.
 */
export function dbsSurroundBed<T extends Record<string, GraphNode>>(wf: T): T {
  const dbs = Object.keys(wf).find((k) => wf[k].class_type === "DBSSeparate");
  if (!dbs) return wf;
  const merge = Object.keys(wf).find((k) => wf[k].class_type === "AudioMerge" && linkedTo(wf[k].inputs.audio2, dbs, 2) && wf[k].inputs.merge_method === "subtract");
  if (!merge) return wf;
  // DBSSeparate's outputs: 0 music, 1 sfx, 2 speech, 3 report.
  return { ...wf, [merge]: { ...wf[merge], inputs: { ...wf[merge].inputs, audio1: [dbs, 0], audio2: [dbs, 1], merge_method: "add" } } };
}

/** How many times the model runs over the clip: once in mono, once per channel otherwise (stereo when unknown). */
export function separationPasses(mode: DbsChannels, channels?: number | null): number {
  return mode === "mono" ? 1 : Math.max(1, Math.round(channels ?? 2));
}

// ---------------------------------------------------------------------------
// Time on the open engine

/**
 * Times real time (seconds of audio per second of work, one pass), as measured. CPU: the separation suite on a 4-CPU
 * host (torch 2.14.1+cpu, ComfyUI-DBS f656e53, 24 runs of 12 s mixes with nothing else running, DBS D4;
 * docs/research/dbs-separation-7.md §2.4): DBS-BSRNN 0.22–0.28x, typically 0.25x; DBS-TIGER 0.10–0.11x (D1 measured
 * 0.27x and 0.09x on the same host while other jobs shared it). GPU: the pack author's RTX 5090 (the same section); a
 * smaller GPU is slower, so the estimate is a range.
 */
export const DBS_SPEED: Record<"cpu" | "cuda", Record<SplitQuality, number>> = {
  cpu: { fast: 0.25, best: 0.1 },
  cuda: { fast: 22.4, best: 15.9 },
};
/** Loading the model and the audio, saving four FLAC stems (seconds, measured on the CPU host). */
const OVERHEAD_SECONDS = 3;

/** About how long a split takes, as a range in seconds (a busy or slower host takes longer). */
export function splitTime(o: { seconds: number; quality: SplitQuality; mode: DbsChannels; channels?: number | null; device?: string | null }): { low: number; high: number } {
  const speed = DBS_SPEED[o.device === "cuda" ? "cuda" : "cpu"][o.quality];
  const work = (Math.max(0, o.seconds) * separationPasses(o.mode, o.channels)) / speed;
  // CPU: from a bit faster than measured to the slowest run measured on a busy host; a GPU smaller than the
  // reference card can be several times slower.
  const [lo, hi] = o.device === "cuda" ? [1, 4] : [0.8, 1.6];
  return {
    low: Math.round(OVERHEAD_SECONDS + work * lo),
    high: Math.round(OVERHEAD_SECONDS + work * hi),
  };
}

/**
 * The price line of an open-engine audio tool (Split soundtrack, Remove dialogue). A guest or an account reads
 * "Not available here": POST /api/audio-tools answers them own-gpu-tool, so "Free" would promise a run that is
 * refused (docs/public-signup.md).
 */
export function openToolPrice(p: { demo: boolean } | undefined, visitor?: boolean): string {
  if (visitor) return "Not available here";
  if (!p) return "…";
  return p.demo ? "Placeholder · free" : "Free";
}

/** "about 1–2 min", "under a minute" */
export function durationWords(r: { low: number; high: number }): string {
  if (r.high < 60) return "under a minute";
  const lo = Math.max(1, Math.round(r.low / 60));
  const hi = Math.max(lo, Math.round(r.high / 60));
  if (hi >= 90) return `about ${Math.round((r.low / 3600) * 10) / 10}–${Math.round((r.high / 3600) * 10) / 10} h`;
  return lo === hi ? `about ${lo} min` : `about ${lo}–${hi} min`;
}

// ---------------------------------------------------------------------------
// The plan

export interface SplitInput {
  engine: Engine;
  /** The audio or video file (/api/files/…). */
  media: string;
  kind: "audio" | "video";
  name?: string;
  quality?: SplitQuality;
  /** Stereo stems: every channel separated on its own (about twice as long for stereo). */
  stereo?: boolean;
  /** The source's channel count (its header, else what the browser decoded). */
  channels?: number;
  /** Seconds the soundtrack runs, when known. */
  seconds?: number;
}

export interface SplitPlan extends ToolPlan {
  quality: SplitQuality | null;
  mode: DbsChannels;
}

const STEP_LABEL: Record<DbsChannels, string> = {
  mono: "Dialogue, music, effects",
  "each channel": "Dialogue, music, effects · every channel",
};

/** One DBS job on the open engine; throws what's in the way (in words the page shows). */
export function planSplit(i: SplitInput): SplitPlan {
  if (i.engine === "cloud") throw new Error(CLOUD_SPLIT_PROBLEM);
  if (!i.media) throw new Error(`Add the ${i.kind === "video" ? "video" : "audio"} to split`);
  const mode = dbsChannelsFor(i.stereo ? "each channel" : "mono", i.channels);
  const name = i.name?.trim();
  const title = `Split · ${name || (i.kind === "video" ? "video soundtrack" : "soundtrack")}`;
  const extra: Record<string, unknown> = { channels: mode };
  if (i.quality) extra.separationModel = DBS_MODELS[i.quality];
  if (i.channels && i.channels > 0) extra.sourceChannels = Math.round(i.channels);
  const request: GenerationRequest = {
    modelId: SPLIT_MODEL,
    op: "separate-audio",
    feature: SPLIT_FEATURE,
    batchTitle: title,
    title,
    inputs: i.kind === "video" ? { video: i.media } : { audio: i.media },
    params: {
      extra,
      ...(i.seconds &&
        i.seconds > 0 && {
          sourceDuration: Math.round(i.seconds * 1000) / 1000,
        }),
    },
    step: { label: STEP_LABEL[mode], index: 0, of: 1 },
  };
  const surround = surroundSource(i.channels);
  const passes = separationPasses(mode, i.channels);
  return {
    steps: [{ key: "split", request }],
    length: i.seconds && i.seconds > 0 ? i.seconds : null,
    quality: i.quality ?? null,
    mode,
    summary: `Splits ${i.kind === "video" ? "the video's soundtrack" : "it"} into dialogue, music, effects and music & effects${mode === "each channel" ? `, every channel on its own (${passes} passes)` : ""}.`,
    notes: [
      ...(surround ? [`This file has ${i.channels} channels. ComfyUI saves audio in mono or stereo only, so the stems come out in mono (all channels mixed), and Music & effects is the music and effects stems added up.`] : []),
      "Dialogue comes out clean; music and effects can bleed into each other.",
    ],
  };
}

/** The mix put back on its video (the picture copied untouched on the open engine). */
export function planRemux(i: { engine: Engine; video: string; audio: string; name?: string }): ToolPlan {
  const title = `Remix · ${i.name?.trim() || "video"}`;
  return {
    steps: [
      {
        key: "remux",
        request: {
          modelId: REMUX_MODELS[i.engine],
          op: "mux",
          feature: REMUX_FEATURE,
          batchTitle: title,
          title,
          inputs: { video: i.video, audio: i.audio },
          step: {
            label: i.engine === "open" ? "New soundtrack · picture copied" : "New soundtrack",
            index: 0,
            of: 1,
          },
        },
      },
    ],
    length: null,
    summary: "Puts your mix on the video in place of its sound.",
    notes: i.engine === "open" ? ["The picture is copied as it is, not re-encoded."] : [],
  };
}

// ---------------------------------------------------------------------------
// Stems and the mixer (the browser's WebAudio graph and its export use these numbers)

export type StemId = "voice" | "music" | "effects" | "background";
export const STEMS: { id: StemId; label: string; hint: string }[] = [
  { id: "voice", label: "Dialogue", hint: "Speech, clean" },
  { id: "music", label: "Music", hint: "Score and songs (singing lands here)" },
  { id: "effects", label: "Effects", hint: "Sound effects and ambience" },
  {
    id: "background",
    label: "Music & effects",
    hint: "Everything but the dialogue",
  },
];
export const stemLabel = (id: string): string => STEMS.find((s) => s.id === id)?.label ?? id;

export const LEVEL_MIN = -24;
export const LEVEL_MAX = 6;

export interface StemMix {
  /** Level in dB, LEVEL_MIN…LEVEL_MAX. */
  db: number;
  mute: boolean;
  solo: boolean;
}
export type Mix = Record<StemId, StemMix>;

const on = (db = 0): StemMix => ({ db, mute: false, solo: false });
const off = (db = 0): StemMix => ({ db, mute: true, solo: false });

/**
 * The original back: dialogue plus music & effects, which the graph makes as the source minus the dialogue, so the two
 * add up to the source. Except on a loud master: where the source minus the dialogue goes over full scale, ComfyUI's
 * AudioMerge lowers the whole background stem to fit (FLAC can't hold more), and this plays the background that much
 * quieter (backgroundLowered says when; the mixer says so). The separate music and effects stems start muted, so
 * nothing plays twice.
 */
export const ORIGINAL_MIX: Mix = {
  voice: on(),
  music: off(),
  effects: off(),
  background: on(),
};

export const PRESETS: { id: string; label: string; mix: Mix }[] = [
  { id: "original", label: "Original", mix: ORIGINAL_MIX },
  {
    id: "no-dialogue",
    label: "No dialogue",
    mix: { voice: off(), music: off(), effects: off(), background: on() },
  },
  {
    id: "dialogue-only",
    label: "Dialogue only",
    mix: { voice: on(), music: off(), effects: off(), background: off() },
  },
  {
    id: "music-only",
    label: "Music only",
    mix: { voice: off(), music: on(), effects: off(), background: off() },
  },
  {
    id: "music-under",
    label: "Music under dialogue (−12 dB)",
    mix: { voice: on(), music: off(), effects: off(), background: on(-12) },
  },
  // Clean up dialogue (D5): the dialogue clear, the music and effects kept quietly under it.
  {
    id: "clean-dialogue",
    label: "Clean dialogue (−18 dB)",
    mix: { voice: on(), music: off(), effects: off(), background: on(-18) },
  },
];
/** The mix a preset id names, or the original. */
export const presetMix = (id: string | null | undefined): Mix => PRESETS.find((p) => p.id === id)?.mix ?? ORIGINAL_MIX;

/** The preset a mix is, if any (levels within 0.5 dB, solo off). */
export function presetOf(mix: Mix): string | null {
  const same = (a: StemMix, b: StemMix) => a.mute === b.mute && a.solo === b.solo && (a.mute || Math.abs(a.db - b.db) < 0.5);
  return PRESETS.find((p) => STEMS.every((s) => same(mix[s.id], p.mix[s.id])))?.id ?? null;
}

/**
 * A background stem that peaks at full scale was lowered by AudioMerge (it divides the whole stem by its peak when the
 * source minus the dialogue goes over 1.0), so dialogue plus music & effects is a little quieter than the source in the
 * background. A stem that was left alone peaks under full scale, but for the rare one that lands on it exactly.
 */
export function backgroundLowered(peak: number): boolean {
  return peak >= 0.999;
}

export const clampDb = (db: number): number => Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, Math.round(db * 2) / 2));

/** A level in dB as a gain (0 dB = 1, −6 dB ≈ 0.5, +6 dB ≈ 2). */
export function dbToGain(db: number): number {
  return Number.isFinite(db) ? 10 ** (db / 20) : 0;
}

/** "+3 dB", "−12 dB", "0 dB" */
export function dbLabel(db: number): string {
  const v = Math.round(db * 2) / 2;
  return v === 0 ? "0 dB" : `${v > 0 ? "+" : "−"}${Math.abs(v)} dB`;
}

/** What each stem plays at: muted = 0; while any stem is soloed, only the soloed ones play. */
export function stemGains(mix: Mix): Record<StemId, number> {
  const solo = STEMS.some((s) => mix[s.id].solo);
  return Object.fromEntries(STEMS.map((s) => [s.id, mix[s.id].mute || (solo && !mix[s.id].solo) ? 0 : dbToGain(clampDb(mix[s.id].db))])) as Record<StemId, number>;
}

/**
 * Mute or unmute a stem. Music & effects is the music and effects stems together, so turning it on turns those two
 * off, and turning either of them on turns it off: nothing plays twice.
 */
export function setMute(mix: Mix, id: StemId, mute: boolean): Mix {
  const next: Mix = { ...mix, [id]: { ...mix[id], mute } };
  if (!mute && id === "background") {
    next.music = { ...next.music, mute: true };
    next.effects = { ...next.effects, mute: true };
  }
  if (!mute && (id === "music" || id === "effects")) next.background = { ...next.background, mute: true };
  return next;
}

export function setSolo(mix: Mix, id: StemId, solo: boolean): Mix {
  return { ...mix, [id]: { ...mix[id], solo } };
}

/** A level change unmutes the stem (moving a fader means you want to hear it). */
export function setLevel(mix: Mix, id: StemId, db: number): Mix {
  const next = mix[id].mute ? setMute(mix, id, false) : mix;
  return { ...next, [id]: { ...next[id], db: clampDb(db) } };
}

/** "Dialogue + Music & effects −12 dB" — the mix in words, for its title in the Library. */
export function mixName(mix: Mix): string {
  const preset = presetOf(mix);
  if (preset && preset !== "original") return PRESETS.find((p) => p.id === preset)!.label;
  const g = stemGains(mix);
  const parts = STEMS.filter((s) => g[s.id] > 0).map((s) => `${s.label}${Math.abs(mix[s.id].db) >= 0.5 ? ` ${dbLabel(mix[s.id].db)}` : ""}`);
  return parts.length ? parts.join(" + ") : "Silence";
}

// ---------------------------------------------------------------------------
// Export: the mix as a WAV file, made and uploaded in parts

/** A WAV holds at most 4 GiB (32-bit sizes); the export route takes up to 2 GiB, in parts the sign-in proxy passes whole. */
export const MIX_MAX_BYTES = 2 * 1024 ** 3;
export const MIX_PART_BYTES = 16 * 1024 * 1024;

/**
 * The gain that keeps a mix from clipping: 1 when its peak is at or under full scale, else just enough to bring the
 * peak to −0.1 dBFS (the whole mix, so the balance stays as set).
 */
export function headroomGain(peak: number): number {
  const ceiling = dbToGain(-0.1);
  return peak > ceiling ? ceiling / peak : 1;
}

/** The size of a 16-bit PCM WAV. */
export const wavBytes = (frames: number, channels: number): number => 44 + frames * Math.max(1, channels) * 2;

/** The 44-byte header of a 16-bit PCM WAV of `frames` frames. */
export function wavHeader(frames: number, channels: number, sampleRate: number): Uint8Array {
  const ch = Math.max(1, channels);
  const bytes = new Uint8Array(44);
  const d = new DataView(bytes.buffer);
  const text = (o: number, s: string) => [...s].forEach((c, k) => d.setUint8(o + k, c.charCodeAt(0)));
  text(0, "RIFF");
  d.setUint32(4, 36 + frames * ch * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  d.setUint32(16, 16, true);
  d.setUint16(20, 1, true);
  d.setUint16(22, ch, true);
  d.setUint32(24, sampleRate, true);
  d.setUint32(28, sampleRate * ch * 2, true);
  d.setUint16(32, ch * 2, true);
  d.setUint16(34, 16, true);
  text(36, "data");
  d.setUint32(40, frames * ch * 2, true);
  return bytes;
}

const int16 = (v: number) => {
  const c = Math.max(-1, Math.min(1, v));
  return Math.round(c < 0 ? c * 0x8000 : c * 0x7fff);
};

/** 16-bit PCM WAV from planar float channels (−1…1, clipped). */
export function encodeWav(channels: Float32Array[], sampleRate: number): Uint8Array {
  const n = channels.length ? channels[0].length : 0;
  const ch = Math.max(1, channels.length);
  const bytes = new Uint8Array(wavBytes(n, ch));
  bytes.set(wavHeader(n, ch, sampleRate));
  const d = new DataView(bytes.buffer);
  for (let i = 0, o = 44; i < n; i++) for (let c = 0; c < ch; c++, o += 2) d.setInt16(o, int16(channels[c]?.[i] ?? 0), true);
  return bytes;
}

/** A decoded stem in a mix: its planar channels (one rate for all stems) and the gain it plays at. */
export interface MixStem {
  channels: Float32Array[];
  gain: number;
}

/**
 * Which channel of a stem with `n` channels feeds output channel `c` of `out` (−1: none), as WebAudio's "speakers"
 * up-mix plays it live: mono into stereo or quad on left and right, into 5.1 on the centre; otherwise channel for
 * channel. (A split's stems are either all one channel count, or mono beside a stereo background.)
 */
export function stemFeed(n: number, out: number, c: number): number {
  if (n === 1) return out === 6 ? (c === 2 ? 0 : -1) : out === 2 || out === 4 ? (c < 2 ? 0 : -1) : c === 0 ? 0 : -1;
  return c < n ? c : -1;
}

/** A mix ready to write: the audible stems, which of their channels feed each output channel, and the file's shape. */
export interface MixPlan {
  stems: MixStem[];
  feeds: number[][];
  frames: number;
  channels: number;
  sampleRate: number;
  /** The whole WAV's size. */
  bytes: number;
}

export function mixPlan(all: MixStem[], sampleRate: number): MixPlan {
  const stems = all.filter((s) => s.gain > 0 && s.channels.length > 0);
  const channels = Math.max(1, ...all.map((s) => s.channels.length));
  const frames = Math.max(0, ...all.flatMap((s) => s.channels.map((d) => d.length)));
  const feeds = stems.map((s) => Array.from({ length: channels }, (_, c) => stemFeed(s.channels.length, channels, c)));
  return { stems, feeds, frames, channels, sampleRate, bytes: wavBytes(frames, channels) };
}

/** One sample of the mix: every audible stem at its gain. */
function mixAt(p: MixPlan, c: number, i: number): number {
  let v = 0;
  for (let s = 0; s < p.stems.length; s++) {
    const k = p.feeds[s][c];
    if (k < 0) continue;
    const data = p.stems[s].channels[k];
    if (i < data.length) v += data[i] * p.stems[s].gain;
  }
  return v;
}

/** The loudest sample of the mix in frames [from, to) (the page looks at it a slice at a time, so it stays responsive). */
export function mixPeak(p: MixPlan, from = 0, to = p.frames): number {
  let peak = 0;
  for (let i = from, end = Math.min(to, p.frames); i < end; i++) for (let c = 0; c < p.channels; c++) peak = Math.max(peak, Math.abs(mixAt(p, c, i)));
  return peak;
}

/** Frames per part of about `partBytes`. */
export const partFrames = (p: MixPlan, partBytes = MIX_PART_BYTES): number => Math.max(1, Math.floor(partBytes / (p.channels * 2)));

/**
 * Frames [from, to) of the mix as 16-bit PCM at gain `k` (headroomGain of the whole mix's peak); the part that starts
 * at frame 0 carries the WAV header. Parts in order, joined, are the WAV file.
 */
export function mixPart(p: MixPlan, from: number, to: number, k = 1): Uint8Array {
  const n = Math.max(0, Math.min(to, p.frames) - from);
  const head = from === 0 ? 44 : 0;
  const out = new Uint8Array(head + n * p.channels * 2);
  if (head) out.set(wavHeader(p.frames, p.channels, p.sampleRate));
  const d = new DataView(out.buffer);
  for (let i = 0, o = head; i < n; i++) for (let c = 0; c < p.channels; c++, o += 2) d.setInt16(o, int16(mixAt(p, c, from + i) * k), true);
  return out;
}

// ---------------------------------------------------------------------------
// What the browser can hold

const GiB = 1024 ** 3;

/** Bytes the browser holds to mix a split: every stem decoded as 32-bit float at the audio context's rate. */
export function mixerBytes(stems: { seconds: number; channels: number }[], sampleRate: number): number {
  return stems.reduce((n, s) => n + Math.ceil(Math.max(0, s.seconds) * sampleRate) * Math.max(1, s.channels) * 4, 0);
}

/**
 * How much decoded audio this browser is trusted with: a quarter of the device's memory where the browser says it
 * (Chrome, at most 8 GB reported), from 512 MiB to 2 GiB; else 1 GiB on a phone or tablet and 2 GiB on a computer.
 */
export function mixerBudget(o: { deviceMemoryGb?: number; coarse?: boolean }): number {
  if (o.deviceMemoryGb && o.deviceMemoryGb > 0) return Math.min(2 * GiB, Math.max(GiB / 2, (o.deviceMemoryGb * GiB) / 4));
  return o.coarse ? GiB : 2 * GiB;
}

const sizeWords = (bytes: number) => (bytes >= GiB ? `${Math.round((bytes / GiB) * 10) / 10} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`);

/** Why the browser shouldn't decode these stems (too long for this device), or null. */
export function mixerProblem(bytes: number, budget: number): string | null {
  if (bytes <= budget) return null;
  return `This split is too long to mix in your browser: its stems take about ${sizeWords(bytes)} of memory to play, and this device has room for about ${sizeWords(budget)}. Download the stems and mix them in an editor, or split a shorter clip.`;
}

/** Why a mix can't be exported as one WAV (over the export's limit), or null. */
export function exportProblem(frames: number, channels: number): string | null {
  const bytes = wavBytes(frames, channels);
  return bytes > MIX_MAX_BYTES ? `This mix would be a ${sizeWords(bytes)} WAV, over the ${sizeWords(MIX_MAX_BYTES)} an export can be. Download the stems and mix them in an editor.` : null;
}

export { clock };
