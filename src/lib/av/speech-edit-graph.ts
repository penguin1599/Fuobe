import type { ComfyNode, ComfyWorkflow } from "@/lib/comfy";
import { AUK_SETTINGS, SPEECH_CROSSFADE, stitchPlan, type AukQuality, type SpeechWindow } from "@/lib/speech-edit";

/**
 * Edit speech's graph (speech-edit-auk, nm10-speech-edit) for any number of windows, in one prompt: the hand-built
 * template binds the recording, the fade-in curve (written by the provider: a linear ramp, then a flat tail that
 * AudioMerge trims off), AuK's loader and one window. This rebuilds the windows and the stitch from
 * src/lib/speech-edit.ts's stitchPlan: each window is cut from the original, edited by AuK (one AuKGenerateEdit each, one
 * shared engine), and crossfaded back over the original's first and last SPEECH_CROSSFADE seconds of the window. Only
 * core audio nodes besides AuK's (TrimAudioDuration, AudioMerge, AudioConcat, AudioAdjustVolume, SplitAudioChannels,
 * EmptyAudio).
 *
 * Clicks: AudioMerge resamples the lower-rate side of a merge, and a resampled piece tapers at its edges. So the
 * recording and each edit are brought to one rate first (each merged with silence at the other's rate: AuK speaks at
 * 24 kHz), and a seam is a + (b − a) × fade-in, which uses only the curve that starts at 0 and whose end is cut away.
 * AudioMerge also divides any result that peaks above 1.0 by its peak, and b − a on loud speech easily does (the two
 * sides aren't in phase): a seam rescaled that way no longer ends where the edit's middle starts. So all the stitching
 * runs HEADROOM_DB lower (AudioAdjustVolume, an exact gain), each window goes to AuK at its own level, and the result is
 * brought back up once at the end: untouched parts come out as they went in.
 */

const ids = (wf: ComfyWorkflow, type: string) => Object.keys(wf).filter((id) => wf[id].class_type === type);
const linkFrom = (v: unknown): string | undefined => (Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Plenty: TrimAudioDuration stops at the end of the audio. */
const REST = 100000;
/** AuK's output rate (its VAE's target_sample_rate in config.yaml at the pinned revisions). */
export const AUK_RATE = 24000;
/** The flat tail after the ramp: longer than the resampler's reach, trimmed off by AudioMerge. */
export const FADE_TAIL = 0.05;
/** How far below its level the stitching runs: room for a seam's difference of two full-scale signals and more. */
export const HEADROOM_DB = 12;

/**
 * The fade-in curve as a 16-bit stereo PCM WAV at 8 kHz: a linear ramp from 0 to 1 over `seconds`, then FADE_TAIL
 * seconds at 1 (both channels the same; the graph reads the left one).
 */
export function speechFadeWav(seconds: number, rate = 8000): Uint8Array {
  if (!(seconds > 0)) throw new Error("A crossfade needs a length above 0 s");
  const ramp = Math.max(2, Math.round(seconds * rate));
  const n = ramp + Math.round(FADE_TAIL * rate);
  const bytes = new Uint8Array(44 + n * 4);
  const v = new DataView(bytes.buffer);
  const text = (o: number, str: string) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + n * 4, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    const g = Math.round(Math.min(1, i / (ramp - 1)) * 32767);
    v.setInt16(44 + i * 4, g, true);
    v.setInt16(46 + i * 4, g, true);
  }
  return bytes;
}

export interface SpeechGraphOptions {
  /** Seconds the recording runs. */
  duration: number;
  quality?: AukQuality;
  seed?: number;
  crossfade?: number;
}

export function expandSpeechEditWorkflow(wf: ComfyWorkflow, windows: SpeechWindow[], o: SpeechGraphOptions): ComfyWorkflow {
  if (!windows.length) throw new Error("Nothing to change: edit the words, or pick a range and an effect");
  const [split] = ids(wf, "SplitAudioChannels");
  const curve = split ? linkFrom(wf[split].inputs.audio) : undefined;
  const [source] = ids(wf, "LoadAudio").filter((id) => id !== curve);
  const [loader] = ids(wf, "AuKModelLoader");
  const [gen] = ids(wf, "AuKGenerateEdit");
  const [trim] = ids(wf, "TrimAudioDuration");
  const [merge] = ids(wf, "AudioMerge");
  const [concat] = ids(wf, "AudioConcat");
  const [empty] = ids(wf, "EmptyAudio");
  const [save] = Object.keys(wf).filter((id) => /^SaveAudio/.test(wf[id].class_type));
  if (!split || !curve || !source || !loader || !gen || !trim || !merge || !concat || !empty || !save) {
    throw new Error("Not an Edit speech workflow (needs the recording, the fade curve, AuK's loader and edit node, silence, trims, merges, concats and a save)");
  }
  const x = o.crossfade ?? SPEECH_CROSSFADE;
  const settings = AUK_SETTINGS[o.quality ?? "fast"];
  const out: ComfyWorkflow = {};
  for (const id of [source, curve, split, loader, empty, save]) out[id] = structuredClone(wf[id]);
  out[loader].inputs.checkpoint_path = settings.checkpoint;
  Object.assign(out[empty].inputs, { duration: 0.05, sample_rate: AUK_RATE, channels: 1 });
  const fadeIn = [split, 0];
  const add = (id: string, node: ComfyNode) => ((out[id] = node), id);
  const cut = (id: string, from: string, start: number, duration: number) =>
    add(id, { class_type: wf[trim].class_type, inputs: { ...wf[trim].inputs, audio: [from, 0], start_index: r3(start), duration: r3(duration) } });
  const mix = (id: string, a: string, b: unknown, method: string) => add(id, { class_type: wf[merge].class_type, inputs: { ...wf[merge].inputs, audio1: [a, 0], audio2: b, merge_method: method } });
  const join = (id: string, a: string, b: string) => add(id, { class_type: wf[concat].class_type, inputs: { ...wf[concat].inputs, audio1: [a, 0], audio2: [b, 0], direction: "after" } });

  const gain = (id: string, from: string, db: number) => add(id, { class_type: "AudioAdjustVolume", inputs: { audio: [from, 0], volume: db } });

  // The recording HEADROOM_DB down, at max(its rate, AuK's): silence at 24 kHz added.
  const src = mix("src", gain("src_low", source, -HEADROOM_DB), [empty, 0], "add");
  const edits = windows.map((w, k) => {
    const n = k + 1;
    const piece = cut(`w${n}_cut`, src, w.start, w.end - w.start);
    // AuK hears the window at the recording's own level.
    const input = gain(`w${n}_in`, piece, HEADROOM_DB);
    const auk = add(`w${n}_auk`, {
      class_type: wf[gen].class_type,
      inputs: {
        ...wf[gen].inputs,
        engine: [loader, 0],
        instruction: w.instruction,
        generation_seconds: w.seconds,
        use_prompt_enhancer: false,
        seed: (o.seed ?? Number(wf[gen].inputs.seed ?? 42)) + k,
        nfe_steps: settings.steps,
        cfg_strength: settings.cfg,
        sway_sampling_coef: -1,
        input_audio: [input, 0],
      },
      _meta: { title: w.label.slice(0, 80) },
    });
    // The edit HEADROOM_DB down, at the recording's rate: silence cut from the window (window − window) added.
    return mix(`w${n}_edit`, gain(`w${n}_low`, auk, -HEADROOM_DB), [mix(`w${n}_zero`, piece, [piece, 0], "subtract"), 0], "add");
  });

  let acc: string | undefined;
  const append = (id: string) => (acc = acc ? join(`j${Object.keys(out).length}`, acc, id) : id);
  stitchPlan(windows, o.duration, x).forEach((p, i) => {
    const tag = `p${i + 1}`;
    if (p.kind === "source") append(cut(`${tag}_orig`, src, p.from, Math.abs(p.to - o.duration) < 1e-6 ? REST : p.to - p.from));
    else if (p.kind === "edit") append(cut(`${tag}_edit`, edits[p.window], p.from, p.to - p.from));
    else {
      // A seam from a (leaving) to b (coming): a + (b − a) × fade-in.
      const w = windows[p.window];
      const orig = cut(`${tag}_o`, src, p.at, p.length);
      const edit = cut(`${tag}_e`, edits[p.window], p.kind === "seam-in" ? 0 : w.seconds - p.length, p.length);
      const [a, b] = p.kind === "seam-in" ? [orig, edit] : [edit, orig];
      append(mix(`${tag}_seam`, a, [mix(`${tag}_ramp`, mix(`${tag}_diff`, b, [a, 0], "subtract"), fadeIn, "multiply"), 0], "add"));
    }
  });
  out[save].inputs.audio = [gain("out", acc!, HEADROOM_DB), 0];
  return out;
}

/** AuK's loader device and dtype for the server's torch device: an NVIDIA GPU in bf16, a CPU in fp32 (its node's rule). */
export function aukDevice(device: string | undefined): { device: string; dtype: string } {
  if (device === "cpu") return { device: "cpu", dtype: "fp32" };
  if (device === "mps") throw new Error("AuK runs on an NVIDIA GPU (or, slowly, a CPU): its nodes don't support Apple's GPU");
  return { device: "cuda:0", dtype: "bf16" };
}

/** Sets AuK's loader(s) for the device. */
export function setAukDevice(wf: ComfyWorkflow, device: string | undefined): ComfyWorkflow {
  const d = aukDevice(device);
  for (const id of ids(wf, "AuKModelLoader")) Object.assign(wf[id].inputs, d);
  return wf;
}

/** The edit windows a request carries (params.extra.speechWindows), checked; null when absent or malformed. */
export function readSpeechWindows(v: unknown): SpeechWindow[] | null {
  if (!Array.isArray(v) || !v.length) return null;
  const out: SpeechWindow[] = [];
  for (const w of v) {
    const x = w as Partial<SpeechWindow>;
    const ok = typeof x?.start === "number" && typeof x.end === "number" && typeof x.seconds === "number" && typeof x.instruction === "string" && x.instruction.trim() && x.end > x.start && x.start >= 0 && x.seconds > 0;
    if (!ok) return null;
    out.push({ start: x.start!, end: x.end!, seconds: x.seconds!, instruction: x.instruction!.slice(0, 1000), label: typeof x.label === "string" ? x.label.slice(0, 200) : "Edit" });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * AuK's text to speech (speech-tts-auk): the generation's length on the edit node, and without a voice sample the loader
 * taken out (instruct TTS from the description alone).
 */
export function aukTtsWorkflow(wf: ComfyWorkflow, o: { seconds: number; hasVoice: boolean }): ComfyWorkflow {
  const [gen] = ids(wf, "AuKGenerateEdit");
  if (!gen) throw new Error("Not an AuK workflow");
  wf[gen].inputs.generation_seconds = o.seconds;
  if (!o.hasVoice) {
    const src = linkFrom(wf[gen].inputs.input_audio);
    delete wf[gen].inputs.input_audio;
    if (src && wf[src]?.class_type === "LoadAudio") delete wf[src];
  }
  return wf;
}
