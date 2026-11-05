import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Generation } from "@/lib/catalog/types";
import { cueReducer, cueProblems, formatCueTime, normalizeCues, parseCueTime } from "@/lib/av/cue-edit";
import {
  BLANK_FRAME,
  crowdedLines,
  DBS_OPEN_ONLY_NOTE,
  DEFAULT_VOICE_SPLIT,
  DUB_STEP_MODELS,
  linearGain,
  dubPhrases,
  languageStage,
  MUSIC_MODEL_NOTE,
  OPTIONAL_PREPARE,
  oneShotRequests,
  pickVoiceSplit,
  PHRASE_MAX,
  prepareMedia,
  prepareSteps,
  priceLine,
  reviewCues,
  spokenText,
  stepsNeedGpu,
  takeLines,
  VOICE_SPLITS,
  voiceOnly,
  voiceSplitModel,
  voiceSteps,
  type DubSessionView,
} from "@/lib/av/dub";
import { timelineFor, timelineTracks } from "@/lib/av/timeline";
import { DUB_LANGUAGES, supportsTarget } from "@/lib/av/languages";
import { getModel, MODELS } from "@/lib/catalog";
import { buildPayload } from "@/lib/catalog/payload";
import { tempDir } from "./helpers/temp-dir";

vi.setConfig({ testTimeout: 120_000 });

const dir = tempDir("fuobe-av-dub-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";
process.env.OLLAMA_URL = "http://127.0.0.1:9";

const { setSetting } = await import("@/server/settings");
const gens = await import("@/server/generations");
const dub = await import("@/server/dub");
const { changeAccess } = await import("@/server/model-access");
const { STUDIO_ROWS, studioTool, toolFor } = await import("@/server/gpu/tools");
const { loadIndex } = await import("@/server/gpu/index-file");
const { saveFile } = await import("@/server/storage");

beforeAll(() => setSetting("demoMode", "auto"));

async function settle(id: string, ms = 100_000): Promise<Generation> {
  const end = Date.now() + ms;
  for (;;) {
    const g = gens.getGeneration(id)!;
    if (["succeeded", "failed", "canceled"].includes(g.status)) return g;
    if (Date.now() > end) throw new Error(`timed out: ${g.status} ${g.message}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const clip = () => saveFile({ data: fs.readFileSync(path.join(process.cwd(), "public/samples/demo-landscape.mp4")), contentType: "video/mp4", source: "upload" }).url;

describe("dub languages", () => {
  it("name each language the way its model expects", () => {
    const heygen = new Set(getModel("heygen-translate")!.options.languages);
    const eleven = new Set(getModel("elevenlabs-dubbing")!.options.languages);
    const chatterbox = new Set(getModel("oss-chatterbox")!.options.languages);
    for (const l of DUB_LANGUAGES) {
      if (l.heygen) expect(heygen.has(l.heygen), l.heygen).toBe(true);
      if (l.eleven) expect(eleven.has(l.eleven), l.eleven).toBe(true);
      if (l.chatterbox) expect(chatterbox.has(l.chatterbox), l.chatterbox).toBe(true);
    }
    // Every Chatterbox language is a dub target on the open engine.
    expect(DUB_LANGUAGES.filter((l) => supportsTarget("open", l))).toHaveLength(23);
  });
});

describe("dub pipeline DAGs", () => {
  const video = "/api/files/uploads/clip.mp4";

  it("open: one job splits the stems and times the voice → one translation per language from its cues", () => {
    const steps = prepareSteps({ engine: "open", video, source: "en", targets: ["es", "de"] });
    expect(steps.map((s) => [s.key, s.request.modelId, s.request.op, s.after ?? null])).toEqual([
      ["stems", "oss-voice-separate", "separate-audio", null],
      ["translate:es", "oss-text-llm", "translate", "stems"],
      ["translate:de", "oss-text-llm", "translate", "stems"],
    ]);
    // No second, weaker ASR pass: the stems workflow already runs Qwen3-ASR 1.7B + the forced aligner.
    expect(getModel("oss-voice-separate")!.routes[0].endpoint).toBe("dub-prepare-separate-transcribe");
    expect(steps[0].request.params?.sourceLanguage).toBe("en");
    expect(steps[1].chain).toEqual([{ slot: "prompt" }]);
    expect(steps[1].request.params).toEqual({ targetLanguage: "Spanish", sourceLanguage: "English" });
    expect(steps[1].request.step).toMatchObject({ index: 1, of: 3 });
    expect(() => prepareSteps({ engine: "open", video, targets: ["th"] })).toThrow(/Thai isn't available on the open engine/);
  });

  it("cloud: isolated voice → Scribe → translations, and the soundtrack → Demucs stems for the background", () => {
    const steps = prepareSteps({ engine: "cloud", video, targets: ["fr"] });
    expect(steps.map((s) => [s.key, s.request.modelId, s.request.op, s.after ?? null])).toEqual([
      ["voice", "elevenlabs-voice-isolation", "separate-audio", null],
      ["words", "scribe-v2", "transcribe", "voice"],
      ["translate:fr", "text-llm", "translate", "words"],
      ["sound", "extract-soundtrack", "separate-audio", null],
      ["background", "demucs", "separate-audio", "sound"],
    ]);
    expect(steps[0].request.inputs).toEqual({ video });
    expect(steps[1].request.params).toBeUndefined(); // "auto" = detect
    // Demucs reads audio only: the video's soundtrack goes in through the chain.
    expect(steps[3].request.inputs).toEqual({ video });
    expect(steps[4].chain).toEqual([{ slot: "audio" }]);
    expect(steps[4].request.inputs).toBeUndefined();
    expect(steps.map((s) => s.request.step)).toEqual([
      { label: "Clean voice", index: 0, of: 5 },
      { label: "Transcript", index: 1, of: 5 },
      { label: "Translate · French", index: 2, of: 5 },
      { label: "Original sound", index: 3, of: 5 },
      { label: "Music and effects", index: 4, of: 5 },
    ]);
  });

  it("an account's cloud review: only the translations need its GPU, so an account with a key and no GPU is offered One shot", () => {
    const steps = prepareSteps({ engine: "cloud", video, targets: ["fr", "de"], translator: "gpu", seconds: 30 });
    const providers = (id: string) => new Set(getModel(id)?.routes.map((r) => r.provider));
    const onGpu = steps.filter((s) => providers(s.request.modelId).has("comfyui")).map((s) => s.key);
    expect(onGpu).toEqual(["translate:fr", "translate:de"]);
    expect(steps.filter((s) => !onGpu.includes(s.key)).every((s) => providers(s.request.modelId).has("fal"))).toBe(true);
    // No fal.ai or Replicate model translates text, so the review can't move to the key.
    expect(MODELS.some((m) => m.routes.some((r) => r.op === "translate" && (r.provider === "fal" || r.provider === "replicate")))).toBe(false);
    // Who waits for a GPU: an account with a key and no GPU; never the owner, a guest, an account with its GPU, or one with neither.
    expect(stepsNeedGpu({ kind: "account", gpu: { connected: false }, keys: ["fal"] })).toBe(true);
    expect(stepsNeedGpu({ kind: "account", gpu: { connected: false }, keys: ["replicate"] })).toBe(true);
    expect(stepsNeedGpu({ kind: "account", gpu: { connected: true }, keys: ["fal"] })).toBe(false);
    expect(stepsNeedGpu({ kind: "account", gpu: { connected: false }, keys: [] })).toBe(false);
    expect(stepsNeedGpu({ kind: "guest", gpu: { connected: false } })).toBe(false);
    expect(stepsNeedGpu(undefined)).toBe(false);
  });

  it("open: the Voice split picks the first step's model (MelBand RoFormer by default, or DBS); nothing after it changes", () => {
    const keys = (steps: ReturnType<typeof prepareSteps>) => steps.map((s) => [s.key, s.request.modelId, s.request.op, s.after ?? null]);
    const melband = prepareSteps({ engine: "open", video, source: "en", targets: ["es"] });
    const dbs = prepareSteps({ engine: "open", video, source: "en", targets: ["es"], voiceSplit: "dbs" });
    expect(DEFAULT_VOICE_SPLIT).toBe("melband");
    expect(DUB_STEP_MODELS.open.stems).toBe(VOICE_SPLITS.melband.modelId);
    expect(keys(prepareSteps({ engine: "open", video, source: "en", targets: ["es"], voiceSplit: "melband" }))).toEqual(keys(melband));
    expect(keys(dbs)).toEqual([
      ["stems", "oss-dbs-voice-separate", "separate-audio", null],
      ["translate:es", "oss-text-llm", "translate", "stems"],
    ]);
    // Same input, language and step label: only the model id differs.
    expect({ ...dbs[0].request, modelId: "x" }).toEqual({ ...melband[0].request, modelId: "x" });
    expect(dbs[1]).toEqual(melband[1]);
    // Graph B: DBS + Qwen3-ASR in one ComfyUI job.
    expect(getModel("oss-dbs-voice-separate")!.routes).toEqual([expect.objectContaining({ op: "separate-audio", provider: "comfyui", endpoint: "dub-prepare-dbs-transcribe" })]);
    expect(getModel("oss-dbs-voice-separate")!.name).toBe("DBS + Qwen3-ASR");
    expect(voiceSplitModel("dbs")).toBe("oss-dbs-voice-separate");
    expect(voiceSplitModel("nope")).toBe("oss-voice-separate");
    expect(voiceSplitModel()).toBe("oss-voice-separate");
    expect(VOICE_SPLITS.dbs.note).toBe("Keeps the music and sound effects of the original");
    expect(VOICE_SPLITS.melband.note).toBe(MUSIC_MODEL_NOTE);
  });

  it("the default voice split follows Settings → Models & licences: the next split that is on, else MelBand", () => {
    const off = (...ids: string[]) => (id: string) => !ids.includes(id);
    expect(pickVoiceSplit(undefined, off())).toBe("melband");
    expect(pickVoiceSplit(undefined, off("oss-voice-separate"))).toBe("dbs");
    expect(voiceSplitModel(undefined, off("oss-voice-separate"))).toBe("oss-dbs-voice-separate");
    expect(pickVoiceSplit("nope", off("oss-voice-separate"))).toBe("dbs");
    // Both off: the default, whose run then refuses, naming the switch.
    expect(pickVoiceSplit(undefined, off("oss-voice-separate", "oss-dbs-voice-separate"))).toBe("melband");
    // A split asked for by name is kept even when it's off (the run says why it can't start).
    expect(pickVoiceSplit("melband", off("oss-voice-separate"))).toBe("melband");
    expect(pickVoiceSplit()).toBe("melband");
    // The cloud says plainly that keeping the whole soundtrack is the open engine's.
    expect(DBS_OPEN_ONLY_NOTE).toBe("Keeping the music and sound effects of the original (DBS) runs on your GPU (open source)");
  });

  it("cloud: the Voice split changes nothing (no SAM Audio on the cloud: Demucs stays, three beds, voice only when it fails)", () => {
    const keys = (steps: ReturnType<typeof prepareSteps>) => steps.map((s) => [s.key, s.request.modelId, s.after ?? null]);
    expect(keys(prepareSteps({ engine: "cloud", video, targets: ["fr"], voiceSplit: "dbs" }))).toEqual(keys(prepareSteps({ engine: "cloud", video, targets: ["fr"] })));
    expect(DUB_STEP_MODELS.cloud).toMatchObject({ sound: "extract-soundtrack", stems: "demucs", voice: "elevenlabs-voice-isolation" });
    expect([...OPTIONAL_PREPARE]).toEqual(["sound", "background"]);
    expect(getModel("sam-audio-separate")).toBeUndefined();
    // Demucs' drums, bass and other: three beds, each lowered, then the mix.
    const steps = voiceSteps({ engine: "cloud", video, lang: "es", cues: [{ start: 1, end: 2, text: "Hola" }], voiceRef: "/v.mp3", background: ["/a.mp3", "/b.mp3", "/c.mp3"], duration: 10 });
    expect(steps.filter((s) => s.key.startsWith("bed:")).map((s) => s.request.modelId)).toEqual(["ffmpeg-loudnorm", "ffmpeg-loudnorm", "ffmpeg-loudnorm"]);
  });

  // Speech starts at 2 s, pauses at 7–12 s and ends at 26 s of a 30 s clip.
  const cues = [
    { start: 2, end: 4, text: "Hola a todos" },
    { start: 4.2, end: 7, text: "  bienvenidos  " },
    { start: 12, end: 15, text: "Esto es una prueba" },
    { start: 24, end: 26, text: "Adiós" },
  ];

  it("flags takes whose words won't fit before the next one starts", () => {
    const tight = [
      { start: 0, end: 1, text: "Una frase demasiado larga para un segundo, de verdad que sí" },
      { start: 1.6, end: 3, text: "Corta" },
      { start: 10, end: 12, text: "Bien" },
    ];
    expect(crowdedLines(tight, 14)).toEqual([{ first: 0, last: 0 }]);
    // Lines a breath apart are one take: the hint names them all.
    const joined = [
      { start: 0, end: 1, text: "Una frase demasiado larga para un segundo" },
      { start: 1.1, end: 2, text: "y otra más que tampoco cabe aquí" },
      { start: 2.5, end: 3, text: "Fin" },
    ];
    expect(crowdedLines(joined, 4)).toEqual([{ first: 0, last: 1 }]);
    expect(takeLines({ first: 0, last: 1 })).toBe("lines 1–2");
    expect(takeLines({ first: 2, last: 2 })).toBe("line 3");
    expect(crowdedLines(cues, 30)).toEqual([]);
  });

  it("phrases: lines a breath apart are one take, pauses split takes, lines past the end are dropped", () => {
    expect(dubPhrases(cues)).toEqual([
      { start: 2, end: 7, text: "Hola a todos bienvenidos" },
      { start: 12, end: 15, text: "Esto es una prueba" },
      { start: 24, end: 26, text: "Adiós" },
    ]);
    // A long run of speech still re-syncs every PHRASE_MAX seconds.
    const run = Array.from({ length: 10 }, (_, i) => ({ start: i * 2, end: i * 2 + 1.9, text: `line ${i}` }));
    const takes = dubPhrases(run);
    expect(takes.length).toBe(2);
    expect(takes.every((p) => p.end - p.start <= PHRASE_MAX)).toBe(true);
    expect(dubPhrases([...cues, { start: 31, end: 32, text: "after the end" }, { start: 20, end: 21, text: "  " }], 30).map((p) => p.text)).toEqual(["Hola a todos bienvenidos", "Esto es una prueba", "Adiós"]);
  });

  it("open voice: each take in the cloned voice → placed at its cue on a track as long as the video → lips → over the background", () => {
    const steps = voiceSteps({ engine: "open", video, lang: "es", cues, voiceRef: "/v.wav", background: "/bg.wav", duration: 30 });
    expect(steps.map((s) => [s.key, s.request.modelId, s.request.op, s.after ?? null])).toEqual([
      ["line:0", "oss-chatterbox", "tts", null],
      ["line:1", "oss-chatterbox", "tts", null],
      ["line:2", "oss-chatterbox", "tts", null],
      ["track", "oss-audio-timeline", "timeline", ["line:0", "line:1", "line:2"]],
      ["lips", "oss-infinitetalk-v2v", "lipsync", "track"],
      ["film", "oss-mux", "mux", ["lips", "track"]],
    ]);
    expect(steps[0].request).toMatchObject({ prompt: "Hola a todos bienvenidos", inputs: { voiceAudio: "/v.wav" }, params: { targetLanguage: "Spanish (es)" } });
    const track = steps[3];
    expect(track.chain).toEqual([{ slot: "audios" }, { slot: "audios" }, { slot: "audios" }]);
    // The voice keeps the source's length and every take starts at its cue (each may play until the next one).
    expect(track.request.params).toEqual({
      duration: 30,
      extra: { timeline: { length: 30, clips: [{ start: 2, duration: 10 }, { start: 12, duration: 12 }, { start: 24, duration: 6 }] } },
    });
    // Lip re-sync gets no time span: InfiniteTalk runs as long as its voice, which is now the whole clip.
    expect(steps[4].request.params).toBeUndefined();
    expect(steps[5].chain).toEqual([{ slot: "video" }, { slot: "audio" }]);
    expect(steps[5].request.inputs).toEqual({ audio2: "/bg.wav" });
    // Without lip re-sync the new voice goes over the original picture.
    const flat = voiceSteps({ engine: "open", video, lang: "es", cues, voiceRef: "/v.wav", background: "/bg.wav", lipsync: false, duration: 30 });
    expect(flat.map((s) => s.key)).toEqual(["line:0", "line:1", "line:2", "track", "film"]);
    expect(flat.at(-1)!.request.inputs).toEqual({ video, audio2: "/bg.wav" });
    // Unknown length (a WebM the server can't read): a second past the last line.
    expect(voiceSteps({ engine: "open", video, lang: "es", cues, voiceRef: "/v.wav" })[3].request.params?.duration).toBe(27);
  });

  it("cloud voice: ElevenLabs takes → compose on the timeline → its soundtrack → their voice → Sync lipsync", () => {
    const steps = voiceSteps({ engine: "cloud", video, lang: "ja", cues, voiceRef: "/v.mp3", duration: 30 });
    expect(steps.map((s) => [s.key, s.request.modelId, s.request.op, s.after ?? null])).toEqual([
      ["line:0", "elevenlabs-v4", "tts", null],
      ["line:1", "elevenlabs-v4", "tts", null],
      ["line:2", "elevenlabs-v4", "tts", null],
      ["track", "compose-timeline", "timeline", ["line:0", "line:1", "line:2"]],
      ["soundtrack", "extract-soundtrack", "separate-audio", "track"],
      ["clone", "chatterbox-vc-cloud", "voice-change", "soundtrack"],
      ["film", "sync-lipsync-3", "lipsync", "clone"],
    ]);
    expect(steps[3].request.inputs).toEqual({ images: [BLANK_FRAME] });
    expect(steps[3].request.params?.extra?.timeline).toEqual({ length: 30, clips: [{ start: 2, duration: 10 }, { start: 12, duration: 12 }, { start: 24, duration: 6 }] });
    expect(steps[4].chain).toEqual([{ slot: "video" }]);
    expect(steps[5].request.inputs).toEqual({ voiceAudio: "/v.mp3" });
    expect(steps[6].request).toMatchObject({ inputs: { video }, params: { duration: 30 } });
    const flat = voiceSteps({ engine: "cloud", video, lang: "ja", cues, voiceRef: "/v.mp3", lipsync: false, duration: 30 });
    expect(flat.at(-1)!.request.modelId).toBe("merge-audio-video");
    expect(() => voiceSteps({ engine: "cloud", video, lang: "ja", cues: [{ start: 0, end: 1, text: " " }], voiceRef: "/v" })).toThrow(/no lines to speak/);
    expect(() => voiceSteps({ engine: "cloud", video, lang: "ja", cues: [{ start: 40, end: 41, text: "late" }], voiceRef: "/v", duration: 30 })).toThrow(/after the end of the video/);
  });

  it("cloud voice with the background: lips on the clean voice, the voice mixed over the lowered Demucs stems, that mix on the video", () => {
    const beds = ["/drums.mp3", "/bass.mp3", "/other.mp3"];
    const steps = voiceSteps({ engine: "cloud", video, lang: "ja", cues, voiceRef: "/v.mp3", background: beds, duration: 30 });
    expect(steps.map((s) => [s.key, s.request.modelId, s.request.op, s.after ?? null])).toEqual([
      ["line:0", "elevenlabs-v4", "tts", null],
      ["line:1", "elevenlabs-v4", "tts", null],
      ["line:2", "elevenlabs-v4", "tts", null],
      ["track", "compose-timeline", "timeline", ["line:0", "line:1", "line:2"]],
      ["soundtrack", "extract-soundtrack", "separate-audio", "track"],
      ["clone", "chatterbox-vc-cloud", "voice-change", "soundtrack"],
      ["bed:0", "ffmpeg-loudnorm", "level", null],
      ["bed:1", "ffmpeg-loudnorm", "level", null],
      ["bed:2", "ffmpeg-loudnorm", "level", null],
      ["lips", "sync-lipsync-3", "lipsync", "clone"],
      ["mix", "compose-timeline", "timeline", ["clone", "bed:0", "bed:1", "bed:2"]],
      ["film", "merge-audio-video", "mux", ["lips", "mix"]],
    ]);
    expect(steps.map((s) => s.request.step?.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(steps.every((s) => s.request.step?.of === 12)).toBe(true);
    // Each stem 3 dB down, like the open route's background (compose itself has no volume control).
    expect(steps.slice(6, 9).map((s) => s.request.inputs)).toEqual(beds.map((audio) => ({ audio })));
    expect(steps[6].request.params).toEqual({ extra: linearGain(-3) });
    expect(steps[6].request.step?.label).toBe("Music and effects 1 of 3 · Japanese");
    const [lips, mix, film] = steps.slice(9);
    expect(lips.request).toMatchObject({ inputs: { video }, params: { duration: 30 } });
    expect(lips.chain).toEqual([{ slot: "audio" }]);
    // The new voice goes first, then every lowered stem, each for the whole length (so compose mixes them).
    expect(mix.chain).toEqual(Array(4).fill({ slot: "audios", position: "first" }));
    expect(mix.request.inputs).toEqual({ images: [BLANK_FRAME] });
    expect(mix.request.params).toEqual({ duration: 30, extra: { timeline: { length: 30, clips: Array(4).fill({ start: 0, duration: 30 }) } } });
    expect(film.chain).toEqual([{ slot: "video" }, { slot: "audio" }]);
    expect(film.request.inputs).toBeUndefined();
    expect(film.request.params).toEqual({ duration: 30 });
    const payload = buildPayload(getModel("compose-timeline")!.routes[0].map!, { images: ["https://fal.media/still.png"], audios: ["https://a/voice.mp3", ...beds.map((b) => `https://a${b}`)], extra: mix.request.params?.extra });
    expect(payload.tracks).toEqual([
      { id: "picture", type: "image", keyframes: [{ url: "https://fal.media/still.png", timestamp: 0, duration: 30000 }] },
      { id: "voice", type: "audio", keyframes: [{ url: "https://a/voice.mp3", timestamp: 0, duration: 30000 }] },
      { id: "audio-2", type: "audio", keyframes: [{ url: "https://a/drums.mp3", timestamp: 0, duration: 30000 }] },
      { id: "audio-3", type: "audio", keyframes: [{ url: "https://a/bass.mp3", timestamp: 0, duration: 30000 }] },
      { id: "audio-4", type: "audio", keyframes: [{ url: "https://a/other.mp3", timestamp: 0, duration: 30000 }] },
    ]);
    // Without lip re-sync the mix goes over the original picture.
    const flat = voiceSteps({ engine: "cloud", video, lang: "ja", cues, voiceRef: "/v.mp3", background: beds, lipsync: false, duration: 30 });
    expect(flat.slice(5).map((s) => [s.key, s.after])).toEqual([
      ["clone", "soundtrack"],
      ["bed:0", undefined],
      ["bed:1", undefined],
      ["bed:2", undefined],
      ["mix", ["clone", "bed:0", "bed:1", "bed:2"]],
      ["film", "mix"],
    ]);
    expect(flat.at(-1)!.request).toMatchObject({ modelId: "merge-audio-video", inputs: { video } });
    expect(flat.at(-1)!.chain).toEqual([{ slot: "audio" }]);
    expect(flat.every((s) => s.request.step?.of === 11)).toBe(true);
    expect(flat.map((s) => s.request.step?.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("lowers a track by an exact gain with loudnorm's linear mode (target − measured), never raising it", () => {
    const p = linearGain(-3);
    // ffmpeg's loudnorm takes linear mode when measured TP + gain ≤ target TP (−0.1 on fal) and measured LRA ≤ target LRA.
    expect(p).toMatchObject({ linear: true });
    expect(Number(p.integrated_loudness) - Number(p.measured_i)).toBe(-3);
    expect(Number(p.measured_tp) - 3).toBeLessThanOrEqual(-0.1);
    expect(Number(p.measured_lra)).toBeGreaterThan(0);
    expect(Number(p.measured_lra)).toBeLessThanOrEqual(Number(p.loudness_range));
    expect(p.measured_thresh).not.toBe(-70);
    // Inside fal's ranges.
    expect(Number(p.integrated_loudness)).toBeGreaterThanOrEqual(-70);
    expect(Number(p.measured_i)).toBeLessThanOrEqual(0);
    expect(Number(p.measured_thresh)).toBeGreaterThanOrEqual(-99);
    // A raise would clip with no limiter: it's held at 0 dB.
    expect(Number(linearGain(6).integrated_loudness) - Number(linearGain(6).measured_i)).toBe(0);
    // The payload fal gets: the stem as audio_url with the parameters as they are.
    const body = buildPayload(getModel("ffmpeg-loudnorm")!.routes[0].map!, { audio: "https://a/drums.mp3", extra: p });
    expect(body).toEqual({ audio_url: "https://a/drums.mp3", ...p });
  });

  it("timeline tracks: lines that follow each other share the voice track, overlapping clips get tracks of their own", () => {
    const pic = { url: "p.png", type: "image" as const };
    // A millisecond of rounding between two lines isn't an overlap.
    const lines = timelineTracks({ length: 10, clips: [{ start: 0, duration: 2.0004 }, { start: 2, duration: 3 }, { start: 5, duration: 5 }] }, pic, ["a", "b", "c"]);
    expect(lines.map((t) => t.id)).toEqual(["picture", "voice"]);
    const mixed = timelineTracks({ length: 10, clips: [{ start: 0, duration: 4 }, { start: 2, duration: 2 }, { start: 4, duration: 6 }, { start: 5, duration: 1 }] }, pic, ["a", "b", "c", "d"]);
    expect(mixed.slice(1).map((t) => [t.id, (t.keyframes as { url: string }[]).map((k) => k.url)])).toEqual([
      ["voice", ["a", "c"]],
      ["audio-2", ["b", "d"]],
    ]);
    expect(timelineTracks(timelineFor([0, 3.3333, 7.0006], 12), pic, ["a", "b", "c"]).length).toBe(2);
  });

  it("the cloud track is a fal compose timeline over the blank still", () => {
    const steps = voiceSteps({ engine: "cloud", video, lang: "ja", cues, voiceRef: "/v.mp3", duration: 30 });
    const route = getModel("compose-timeline")!.routes[0];
    const payload = buildPayload(route.map!, { images: ["https://fal.media/still.png"], audios: ["https://a/0.mp3", "https://a/1.mp3", "https://a/2.mp3"], extra: steps[3].request.params?.extra });
    expect(payload).toEqual({
      tracks: [
        { id: "picture", type: "image", keyframes: [{ url: "https://fal.media/still.png", timestamp: 0, duration: 30000 }] },
        {
          id: "voice",
          type: "audio",
          keyframes: [
            { url: "https://a/0.mp3", timestamp: 2000, duration: 10000 },
            { url: "https://a/1.mp3", timestamp: 12000, duration: 12000 },
            { url: "https://a/2.mp3", timestamp: 24000, duration: 6000 },
          ],
        },
      ],
    });
    expect(() => buildPayload(route.map!, { images: ["x"], audios: ["a"], extra: {} })).toThrow(/start times/);
  });

  it("one shot: HeyGen display names, ElevenLabs codes", () => {
    expect(oneShotRequests({ model: "heygen-translate", video, targets: ["es", "he"] }).map((r) => r.request.params?.targetLanguage)).toEqual(["Spanish", "Hebrew (Israel)"]);
    const eleven = oneShotRequests({ model: "elevenlabs-dubbing", video, source: "en", targets: ["pt"] })[0].request;
    expect(eleven).toMatchObject({ modelId: "elevenlabs-dubbing", op: "dub", params: { targetLanguage: "pt", sourceLanguage: "en" } });
    expect(() => oneShotRequests({ model: "elevenlabs-dubbing", video, targets: ["he"] })).toThrow(/isn't available on this model/);
  });

  it("spoken text is the reviewed lines, trimmed", () => {
    expect(spokenText(cues)).toBe("Hola a todos\nbienvenidos\nEsto es una prueba\nAdiós");
  });
});

describe("cue edit reducer", () => {
  const base = normalizeCues([
    { start: 2, end: 4, text: "second line" },
    { start: 0, end: 2.5, text: "first line here" },
  ]);

  it("sorts and removes overlaps", () => {
    expect(base).toEqual([
      { start: 0, end: 2, text: "first line here" },
      { start: 2, end: 4, text: "second line" },
    ]);
  });

  it("edits text and keeps timings between the neighbours", () => {
    expect(cueReducer(base, { type: "text", index: 1, text: "changed" })[1].text).toBe("changed");
    expect(cueReducer(base, { type: "time", index: 1, start: 1 })[1]).toEqual({ start: 2, end: 4, text: "second line" });
    expect(cueReducer(base, { type: "time", index: 0, end: 9 })[0].end).toBe(2);
    expect(cueReducer(base, { type: "time", index: 1, end: 2.05 })[1]).toEqual({ start: 2, end: 2.2, text: "second line" });
  });

  it("splits at the nearest space and shares the time by length", () => {
    const out = cueReducer(base, { type: "split", index: 0, caret: 6 });
    expect(out.map((c) => c.text)).toEqual(["first", "line here", "second line"]);
    expect(out[0].start).toBe(0);
    expect(out[1].end).toBe(2);
    expect(out[0].end).toBeCloseTo(2 * (5 / 14), 2);
    // A single word can't be split.
    expect(cueReducer([{ start: 0, end: 1, text: "word" }], { type: "split", index: 0 })).toHaveLength(1);
  });

  it("merges with the next line, removes, inserts in a gap and shifts", () => {
    expect(cueReducer(base, { type: "merge", index: 0 })).toEqual([{ start: 0, end: 4, text: "first line here second line" }]);
    expect(cueReducer(base, { type: "remove", index: 0 })).toHaveLength(1);
    expect(cueReducer(base, { type: "insert", index: 1 })[2]).toEqual({ start: 4, end: 6, text: "" });
    // No room between two touching cues.
    expect(cueReducer(base, { type: "insert", index: 0 })).toHaveLength(2);
    expect(cueReducer(base, { type: "shift", seconds: -5 })[0].start).toBe(0);
    expect(cueReducer(base, { type: "shift", seconds: 1.5 })[1]).toEqual({ start: 3.5, end: 5.5, text: "second line" });
  });

  it("reports problems and reads times back", () => {
    expect(cueProblems([{ start: 0, end: 1, text: "" }], 10)).toEqual(["1 empty line"]);
    expect(cueProblems([{ start: 12, end: 13, text: "late" }], 10)).toEqual(["A line starts after the end of the video"]);
    expect(formatCueTime(62.5)).toBe("1:02.5");
    expect(parseCueTime("1:02.5")).toBe(62.5);
    expect(parseCueTime("abc")).toBeNull();
  });
});

describe("dub sessions (demo mode)", () => {
  async function prepared(engine: "open" | "cloud") {
    const s = dub.createDubSession({ engine, mode: "steps", video: clip(), title: "My clip", source: "en", targets: ["es"] });
    for (const id of Object.values(s.prepare!)) expect((await settle(id)).status).toBe("succeeded");
    return dub.dubView(dub.getDubSession(s.id)!);
  }

  it.each(["open", "cloud"] as const)("%s: prepare, review, edit and voice a language", async (engine) => {
    const view = await prepared(engine);
    expect(languageStage(view, "es")).toBe("review");
    const lines = reviewCues(view, "es")!;
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0].text).toMatch(/^\[Spanish\]/);
    // Edits are saved per language and spoken as edited.
    const edited = cueReducer(lines, { type: "text", index: 0, text: "Hola, esto es una prueba" });
    const saved = dub.saveDubDraft(view.id, "es", edited);
    expect(reviewCues(saved, "es")![0].text).toBe("Hola, esto es una prueba");
    const voiced = dub.voiceDub(view.id, "es");
    const run = voiced.voices!.es[0];
    expect(Object.keys(run.ids)).toEqual(engine === "open" ? ["line:0", "track", "lips", "film"] : ["line:0", "bed:0", "track", "soundtrack", "clone", "lips", "mix", "film"]);
    expect(voiced.generations[run.ids["line:0"]].request.prompt).toContain("Hola, esto es una prueba");
    // The voice track is exactly as long as the source (read from its MP4 header when the session was made).
    expect(view.duration).toBeGreaterThan(1);
    expect(voiced.generations[run.ids.track].request.params?.duration).toBe(view.duration);
    expect((voiced.generations[run.ids.track].request.params?.extra?.timeline as { length: number }).length).toBe(view.duration);
    if (engine === "open") {
      // The background stem rides along to the mix.
      expect(voiced.generations[run.ids.film].request.inputs?.audio2).toMatch(/^\/api\/files\//);
      expect(voiced.generations[run.ids["line:0"]].request.inputs?.voiceAudio).toMatch(/^\/api\/files\//);
    } else {
      // The background split's stems that aren't the voice are mixed under the new one.
      const split = view.generations[view.prepare!.background];
      const bed = split.outputs.filter((o) => o.meta?.stem !== "voice").map((o) => o.url);
      expect(bed.length).toBeGreaterThan(0);
      // Each lowered first: the mix takes the new voice, then the lowered stems.
      const levelled = bed.map((_, i) => voiced.generations[run.ids[`bed:${i}`]]);
      expect(levelled.map((g) => [g.modelId, g.request.inputs?.audio])).toEqual(bed.map((url) => ["ffmpeg-loudnorm", url]));
      expect(voiced.generations[run.ids.mix].request.inputs?.images).toEqual([BLANK_FRAME]);
      expect((await settle(run.ids.mix)).request.inputs?.audios).toEqual([(await settle(run.ids.clone)).outputs[0].url, ...(await Promise.all(levelled.map(async (g) => (await settle(g.id)).outputs[0].url)))]);
      expect(voiceOnly(view)).toBe(false);
    }
    expect(languageStage(voiced, "es")).toBe("voicing");
    expect((await settle(run.ids.film)).status).toBe("succeeded");
    expect(languageStage(dub.dubView(dub.getDubSession(view.id)!), "es")).toBe("done");
    // All steps share the session's batch (one stack in the Library).
    expect(new Set(Object.values(dub.dubView(dub.getDubSession(view.id)!).generations).map((g) => g.batchId))).toEqual(new Set([view.batchId]));
  });

  it("open with DBS: the split returns voice, background and cues (demo), the session keeps its split, the dub mixes over the bed", async () => {
    const s = dub.createDubSession({ engine: "open", mode: "steps", video: clip(), title: "Film", source: "en", targets: ["es"], voiceSplit: "dbs" });
    expect(s.voiceSplit).toBe("dbs");
    const split = await settle(s.prepare!.stems);
    expect(split).toMatchObject({ modelId: "oss-dbs-voice-separate", provider: "mock", status: "succeeded" });
    expect(split.outputs.map((o) => [o.kind, o.meta?.stem ?? o.meta?.role])).toEqual([
      ["audio", "voice"],
      ["audio", "background"],
      ["text", "cues"],
    ]);
    for (const id of Object.values(s.prepare!)) await settle(id);
    const view = dub.dubView(dub.getDubSession(s.id)!);
    expect(languageStage(view, "es")).toBe("review");
    const media = prepareMedia(view);
    expect(media.voice).toBe(split.outputs[0].url);
    expect(media.background).toBe(split.outputs[1].url);
    const voiced = dub.voiceDub(s.id, "es");
    expect(voiced.generations[voiced.voices!.es[0].ids.film].request.inputs?.audio2).toBe(split.outputs[1].url);
    // The voice split is open-engine only: a cloud dub, or one shot, keeps none.
    expect(dub.createDubSession({ engine: "cloud", mode: "steps", video: clip(), targets: ["es"], voiceSplit: "dbs" }).voiceSplit).toBeUndefined();
  });

  it("with MelBand RoFormer switched off, an open dub that names no split runs DBS (as the studio's picker does)", async () => {
    changeAccess([{ kind: "model", id: "oss-voice-separate", on: false }]);
    try {
      expect(dub.dubVoiceSplit({ engine: "open", mode: "steps" })).toBe("dbs");
      expect(dub.dubVoiceSplit({ engine: "cloud", mode: "steps" })).toBeUndefined();
      expect(dub.previewDub({ engine: "open", mode: "steps", video: clip(), targets: ["es"] })).toMatchObject({ engine: "open", costUsd: 0, steps: 2 });
      const s = dub.createDubSession({ engine: "open", mode: "steps", video: clip(), targets: ["es"] });
      expect(s.voiceSplit).toBe("dbs");
      expect(gens.getGeneration(s.prepare!.stems)!.modelId).toBe("oss-dbs-voice-separate");
      await settle(s.prepare!.stems);
    } finally {
      changeAccess([{ kind: "reset" }]);
    }
    // All on: MelBand RoFormer, the default.
    expect(dub.dubVoiceSplit({ engine: "open", mode: "steps" })).toBe("melband");
  });

  it("has a row on the GPU pre-flight board: the voice split, the cloned voice, its timeline, lip sync and the mux", () => {
    const row = STUDIO_ROWS.find((r) => r.href === "/audio/translate")!;
    expect(row).toMatchObject({ label: "Translate & dub", group: "Audio" });
    const t = studioTool(row)!;
    expect(t.ref).toBe("studio:/audio/translate");
    expect(t.local).toBeUndefined();
    expect(t.workflows).toEqual(expect.arrayContaining(["dub-prepare-separate-transcribe", "tts-chatterbox-multilingual", "audio-timeline", "lipsync-v2v-infinitetalk", "video-mux-audio"]));
    const idx = loadIndex();
    for (const wf of t.workflows) expect(idx.workflows[wf], wf).toBeDefined();
    // Graph B (DBS) is in the requirement index too.
    expect(idx.workflows["dub-prepare-dbs-transcribe"]).toBeDefined();
    expect(toolFor("studio:/audio/translate")?.workflows).toEqual(t.workflows);
  });

  it("prices the open dub's first step free with either voice split", () => {
    for (const voiceSplit of ["melband", "dbs"] as const) {
      const p = dub.previewDub({ engine: "open", mode: "steps", video: clip(), targets: ["es"], voiceSplit });
      expect(p).toMatchObject({ engine: "open", costUsd: 0, steps: 2 });
      expect(priceLine(p)).toMatch(/^(Placeholder · free|Free on your GPU)$/);
    }
  });

  it("refuses to voice before the translation is ready, and one-shot on the open engine", () => {
    const s = dub.createDubSession({ engine: "open", mode: "steps", video: clip(), targets: ["fr"] });
    expect(() => dub.voiceDub(s.id, "fr")).toThrow(/isn't ready yet/);
    expect(() => dub.createDubSession({ engine: "open", mode: "oneshot", video: clip(), targets: ["fr"] })).toThrow(/cloud service/);
  });

  it("one shot (cloud): one dub job per language", async () => {
    const s = dub.createDubSession({ engine: "cloud", mode: "oneshot", model: "heygen-translate", video: clip(), targets: ["es", "fr"] });
    expect(Object.keys(s.oneshot!)).toEqual(["es", "fr"]);
    const g = await settle(s.oneshot!.es);
    expect(g.request.params?.targetLanguage).toBe("Spanish");
    expect(languageStage(dub.dubView(dub.getDubSession(s.id)!) as DubSessionView, "es")).toBe("done");
    expect(dub.listDubSessions().map((x) => x.id)).toContain(s.id);
  });

  it("prices the voice before it runs: per-minute steps for the video's length, unpriced ones named", () => {
    setSetting("falKey", "test-key");
    try {
      const lines = [
        { start: 2, end: 4, text: "Hola a todos" },
        { start: 12, end: 15, text: "Esto es una prueba" },
      ];
      const steps = voiceSteps({ engine: "cloud", video: "/api/files/uploads/clip.mp4", lang: "es", cues: lines, voiceRef: "/api/files/uploads/voice.mp3", duration: 30 });
      const p = dub.priceSteps("cloud", steps, 30);
      expect(p.demo).toBe(false);
      expect(p.steps).toBe(6);
      // Sync Lipsync 3 at $8 a minute is $4 for 30 s, ElevenLabs $0.08 a take; compose, soundtrack and voice conversion add cents.
      expect(p.costUsd).toBeCloseTo(4 + 2 * 0.08 + 2 * 0.006 + 0.0075, 2);
      expect(p.unpriced).toEqual([]);
      expect(priceLine(p)).toBe("≈ $4.18");
      // Without lip re-sync it's the takes and cents.
      expect(dub.priceSteps("cloud", voiceSteps({ engine: "cloud", video: "/api/files/uploads/clip.mp4", lang: "es", cues: lines, voiceRef: "/v.mp3", duration: 30, lipsync: false }), 30).costUsd).toBeLessThan(0.2);
      // A model without a listed price is named next to the estimate.
      expect(priceLine({ engine: "cloud", costUsd: 0.5, unpriced: ["Claude"], demo: false, steps: 3 })).toBe("≈ $0.50 + Claude");
    } finally {
      setSetting("falKey", "");
    }
    expect(priceLine({ engine: "open", costUsd: 0, unpriced: [], demo: false, steps: 4 })).toBe("Free on your GPU");
    expect(priceLine({ engine: "cloud", costUsd: 0, unpriced: [], demo: true, steps: 4 })).toBe("Placeholder · free");
  });

  it("cloud: a failed background split still reaches review and voices over silence (voice only)", async () => {
    const view = await prepared("cloud");
    // As if Demucs had failed: the stage stays "review", the media has no background and the dub says so.
    const failed = { ...view, generations: { ...view.generations, [view.prepare!.background]: { ...view.generations[view.prepare!.background], status: "failed" as const } } };
    expect(languageStage(failed, "es")).toBe("review");
    expect(prepareMedia(failed).background).toBeUndefined();
    expect(voiceOnly(failed)).toBe(true);
    // A split that found nothing but the voice leaves nothing to mix under it: voice only too.
    const split = view.generations[view.prepare!.background];
    const vocals = { ...view, generations: { ...view.generations, [split.id]: { ...split, outputs: split.outputs.filter((o) => o.meta?.stem === "voice") } } };
    expect(languageStage(vocals, "es")).toBe("review");
    expect(prepareMedia(vocals).background).toBeUndefined();
    expect(voiceOnly(vocals)).toBe(true);
    expect(voiceOnly(view)).toBe(false);
    // A cloud dub made before the split existed has no background step at all.
    const older = { ...view, prepare: Object.fromEntries(Object.entries(view.prepare!).filter(([k]) => k !== "sound" && k !== "background")) };
    expect(voiceOnly(older)).toBe(true);
    expect(languageStage(older, "es")).toBe("review");
    // While the split is still running the language waits (the voice is mixed over it).
    const running = { ...view, generations: { ...view.generations, [view.prepare!.background]: { ...view.generations[view.prepare!.background], status: "running" as const } } };
    expect(languageStage(running, "es")).toBe("preparing");
    // A failed transcript still fails the dub.
    const broken = { ...view, generations: { ...view.generations, [view.prepare!.words]: { ...view.generations[view.prepare!.words], status: "failed" as const } } };
    expect(languageStage(broken, "es")).toBe("failed");
  });

  it("prices the background split and the mix before they run", () => {
    setSetting("falKey", "test-key");
    try {
      const lines = [
        { start: 2, end: 4, text: "Hola a todos" },
        { start: 12, end: 15, text: "Esto es una prueba" },
      ];
      const prep = prepareSteps({ engine: "cloud", video: "/api/files/uploads/clip.mp4", targets: ["es"] });
      const split = dub.priceSteps("cloud", prep.filter((s) => s.key === "sound" || s.key === "background"), 30);
      // The soundtrack ($0.0002/s) and Demucs ($0.0007/s) for 30 s.
      expect(split.costUsd).toBeCloseTo(30 * 0.0002 + 30 * 0.0007, 3);
      expect(dub.priceSteps("cloud", prep, 30).costUsd).toBeCloseTo(dub.priceSteps("cloud", prep.filter((s) => s.key !== "sound" && s.key !== "background"), 30).costUsd + split.costUsd, 3);
      const voice = (background?: string[]) => voiceSteps({ engine: "cloud", video: "/api/files/uploads/clip.mp4", lang: "es", cues: lines, voiceRef: "/api/files/uploads/voice.mp3", background, duration: 30 });
      const alone = dub.priceSteps("cloud", voice(), 30);
      const mixed = dub.priceSteps("cloud", voice(["/api/files/a.mp3", "/api/files/b.mp3", "/api/files/c.mp3"]), 30);
      expect(mixed.steps).toBe(alone.steps + 5);
      // Lips at $8 a minute either way; levelling the stems is free, the mix and putting it on the video add $0.0002/s each.
      expect(mixed.costUsd).toBeCloseTo(alone.costUsd + 2 * 30 * 0.0002, 3);
      expect(mixed.unpriced).toEqual([]);
    } finally {
      setSetting("falKey", "");
    }
  });

  it("removing a dub stops the steps that haven't finished (nothing more is spent)", async () => {
    const s = dub.createDubSession({ engine: "cloud", mode: "steps", video: clip(), targets: ["es"] });
    const ids = Object.values(s.prepare!);
    expect(dub.deleteDubSession(s.id)).toBe(true);
    expect(dub.getDubSession(s.id)).toBeNull();
    for (const id of ids) expect(["canceled", "succeeded"]).toContain((await settle(id)).status);
    expect(ids.some((id) => gens.getGeneration(id)!.status === "canceled")).toBe(true);
  });
});
