import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backgroundLowered,
  CLOUD_ONLY_PROBLEM,
  CLOUD_SPLIT_PROBLEM,
  clampDb,
  dbLabel,
  dbsChannelsFor,
  dbsModelFor,
  dbsSurroundBed,
  dbToGain,
  DBS_SPEED,
  durationWords,
  encodeWav,
  exportProblem,
  headroomGain,
  hostPick,
  installedDbs,
  missingDbs,
  MIX_MAX_BYTES,
  MIX_PART_BYTES,
  mixerBudget,
  mixerBytes,
  mixerProblem,
  mixName,
  mixPart,
  mixPeak,
  mixPlan,
  ORIGINAL_MIX,
  partFrames,
  planRemux,
  planSplit,
  presetOf,
  PRESETS,
  SAVE_MAX_CHANNELS,
  separationPasses,
  setLevel,
  setMute,
  setSolo,
  splitTime,
  stemFeed,
  STEMS,
  stemGains,
  surroundSource,
  wavBytes,
  type Mix,
} from "@/lib/av/split";
import { getModel } from "@/lib/catalog";
import { HUB_MODES, modeHref } from "@/lib/hubs";
import { tempDir } from "./helpers/temp-dir";

// Audio → Split soundtrack (DBS D1): the planner, the mixer maths and the API in demo mode.
const SURROUND_NOTE =
  "This file has 6 channels. ComfyUI saves audio in mono or stereo only, so the stems come out in mono (all channels mixed), and Music & effects is the music and effects stems added up.";
const dir = tempDir("fuobe-split-");
process.env.FUOBE_DATA_DIR = dir;
// Nothing listens: the open model runs on the demo provider.
process.env.COMFYUI_URL = "http://127.0.0.1:9";

const toasts = vi.hoisted(() => ({ error: [] as string[] }));
vi.mock("sonner", () => ({ toast: Object.assign(() => {}, { error: (m: string) => void toasts.error.push(m) }) }));

const { setSetting } = await import("@/server/settings");
const { getAsset, saveFile, scratchDir, storedMedia } = await import("@/server/storage");
const gens = await import("@/server/generations");
const route = await import("@/app/api/audio-tools/route");
const exportRoute = await import("@/app/api/audio-tools/export/route");
const { PART_MAX } = await import("@/server/mix-export");
const { uploadSource } = await import("@/components/audio-tools/split-tool");
const { CONNECT_GPU_HEADER, CONNECT_GPU_MESSAGE, GUEST_HEADER, GUEST_RUN_MESSAGE } = await import("@/lib/guest-access");

beforeAll(() => setSetting("demoMode", "auto"));

/** A 16-bit WAV of a tone with `channels` channels, saved as an upload. */
function upload(seconds: number, channels = 2, name = "film.wav"): string {
  const rate = 8000;
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2 * channels);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2 * channels, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2 * channels, 28);
  buf.writeUInt16LE(2 * channels, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2 * channels, 40);
  return saveFile({ data: buf, contentType: "audio/wav", name, source: "upload" }).url;
}

/** A small MP4: a video track and, unless `channels` is null, an AAC sound track with that many channels (2 s each). */
function mp4Sound(channels: number | null): Buffer {
  const u32 = (...v: number[]) => Buffer.concat(v.map((n) => Buffer.from([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])));
  const box = (type: string, ...parts: Buffer[]) => {
    const body = Buffer.concat(parts);
    return Buffer.concat([u32(8 + body.length), Buffer.from(type), body]);
  };
  const trak = (handler: string, ...stbl: Buffer[]) =>
    box("trak", box("mdia", box("mdhd", u32(0, 0, 0, 1000, 2000), Buffer.alloc(4)), box("hdlr", u32(0, 0), Buffer.from(handler), Buffer.alloc(12)), box("minf", box("stbl", ...stbl))));
  const entry = Buffer.alloc(28);
  entry.writeUInt16BE(1, 6);
  entry.writeUInt16BE(channels ?? 2, 16);
  entry.writeUInt16BE(16, 18);
  const sound = channels === null ? [] : [trak("soun", box("stsd", u32(0, 1), box("mp4a", entry)))];
  return Buffer.concat([box("ftyp", Buffer.from("isom"), u32(0)), box("moov", box("mvhd", u32(0, 0, 0, 1000, 2000), Buffer.alloc(80)), trak("vide", box("stts", u32(0, 1, 50, 40))), ...sound)]);
}

const post = (body: unknown, preview = false) =>
  route.POST(new Request(`http://x/api/audio-tools${preview ? "?preview=1" : ""}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

async function finished(id: string) {
  const deadline = Date.now() + 15_000;
  let g = gens.getGeneration(id)!;
  while (g.status !== "succeeded" && g.status !== "failed" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    g = gens.getGeneration(id)!;
  }
  return g;
}

describe("the DBS model and channels a run gets", () => {
  it("picks DBS-TIGER on a CUDA host and DBS-BSRNN otherwise, unless one is asked for", () => {
    expect(hostPick("cuda")).toBe("best");
    expect(hostPick("cpu")).toBe("fast");
    expect(hostPick("mps")).toBe("fast");
    expect(hostPick(undefined)).toBe("fast");
    expect(dbsModelFor(undefined, "cuda")).toBe("DBS-TIGER-DnR");
    expect(dbsModelFor(undefined, "cpu")).toBe("DBS-BSRNN-DnR");
    expect(dbsModelFor("fast", "cuda")).toBe("DBS-BSRNN-DnR");
    expect(dbsModelFor("best", "cpu")).toBe("DBS-TIGER-DnR");
    expect(dbsModelFor("DBS-TIGER-DnR", "cpu")).toBe("DBS-TIGER-DnR");
    expect(dbsModelFor("something else", "cpu")).toBe("DBS-BSRNN-DnR");
  });

  it("separates the mono mix unless stereo stems are asked for, and anything over two channels in mono", () => {
    expect(dbsChannelsFor(undefined, 2)).toBe("mono");
    expect(dbsChannelsFor("mono", 1)).toBe("mono");
    expect(dbsChannelsFor("each channel", 2)).toBe("each channel");
    expect(dbsChannelsFor("stereo")).toBe("each channel");
    // 5.1: ComfyUI saves mono or stereo only (a 6-channel stem comes out as scrambled stereo), so mono, stereo asked or not.
    expect(SAVE_MAX_CHANNELS).toBe(2);
    expect([surroundSource(6), surroundSource(3), surroundSource(2), surroundSource(undefined)]).toEqual([true, true, false, false]);
    expect(dbsChannelsFor("mono", 6)).toBe("mono");
    expect(dbsChannelsFor("each channel", 6)).toBe("mono");
    expect(dbsChannelsFor(undefined, 3)).toBe("mono");
    // A mono file is one pass whatever is asked: no stereo stems to make, and the estimate isn't doubled.
    expect(dbsChannelsFor("each channel", 1)).toBe("mono");
    expect(separationPasses("each channel", 1)).toBe(1);
    expect(separationPasses("each channel", 2)).toBe(2);
    expect(separationPasses("each channel")).toBe(2);
    expect(separationPasses("mono", 6)).toBe(1);
  });

  it("only picks a model the host has on disk, and refuses one asked for that isn't there", () => {
    // GET /models/dbs: both files of a model, or it isn't there (a Windows ComfyUI answers with back slashes).
    expect(installedDbs(["DBS-BSRNN-DnR/config.json", "DBS-BSRNN-DnR/model.safetensors", "DBS-TIGER-DnR/config.json"])).toEqual(["DBS-BSRNN-DnR"]);
    expect(installedDbs(["DBS-TIGER-DnR\\config.json", "DBS-TIGER-DnR\\model.safetensors"])).toEqual(["DBS-TIGER-DnR"]);
    expect(installedDbs([])).toEqual([]);
    expect(installedDbs(null)).toBeUndefined();
    // A GPU host set up without TIGER runs BSRNN rather than a model that isn't there; a CPU host without BSRNN, TIGER.
    expect(hostPick("cuda", ["DBS-BSRNN-DnR"])).toBe("fast");
    expect(hostPick("cuda", ["DBS-BSRNN-DnR", "DBS-TIGER-DnR"])).toBe("best");
    expect(hostPick("cpu", ["DBS-TIGER-DnR"])).toBe("best");
    expect(hostPick("cuda", [])).toBe("best");
    expect(dbsModelFor(undefined, "cuda", ["DBS-BSRNN-DnR"])).toBe("DBS-BSRNN-DnR");
    expect(() => dbsModelFor("best", "cuda", ["DBS-BSRNN-DnR"])).toThrow(missingDbs("DBS-TIGER-DnR", ["DBS-BSRNN-DnR"]));
    expect(missingDbs("DBS-TIGER-DnR", ["DBS-BSRNN-DnR"])).toBe(
      'Best (DBS-TIGER) isn\'t installed on your ComfyUI (models/dbs/DBS-TIGER-DnR). Copy the install commands from the Connect your GPU page, or pick Fast (DBS-BSRNN).',
    );
    // No weights at all: said in words, not a FileNotFoundError from inside ComfyUI.
    expect(() => dbsModelFor(undefined, "cpu", [])).toThrow(/Fast \(DBS-BSRNN\) isn't installed on your ComfyUI \(models\/dbs\/DBS-BSRNN-DnR\)\. Copy the install commands from the Connect your GPU page\.$/);
  });
});

describe("planSplit", () => {
  it("is one DBS job on the open engine, the host's model unless one is picked", () => {
    const p = planSplit({ engine: "open", media: "/api/files/u/film.wav", kind: "audio", name: "Film", channels: 2, seconds: 20 });
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0].key).toBe("split");
    expect(p.steps[0].request).toEqual({
      modelId: "oss-dbs-separate",
      op: "separate-audio",
      feature: "audio-split",
      batchTitle: "Split · Film",
      title: "Split · Film",
      inputs: { audio: "/api/files/u/film.wav" },
      params: { extra: { channels: "mono", sourceChannels: 2 }, sourceDuration: 20 },
      step: { label: "Dialogue, music, effects", index: 0, of: 1 },
    });
    expect(p).toMatchObject({ length: 20, quality: null, mode: "mono" });
    expect(p.summary).toBe("Splits it into dialogue, music, effects and music & effects.");
    expect(p.notes).toEqual(["Dialogue comes out clean; music and effects can bleed into each other."]);
    // The model the page picked goes as the DBSLoader name.
    expect(planSplit({ engine: "open", media: "/api/files/a.wav", kind: "audio", quality: "best" }).steps[0].request.params?.extra).toEqual({ channels: "mono", separationModel: "DBS-TIGER-DnR" });
    expect(planSplit({ engine: "open", media: "/api/files/a.wav", kind: "audio", quality: "fast" }).steps[0].request.params?.extra?.separationModel).toBe("DBS-BSRNN-DnR");
  });

  it("takes a video's soundtrack (LoadAudio reads it) and does stereo stems on request", () => {
    const p = planSplit({ engine: "open", media: "/api/files/u/clip.mp4", kind: "video", stereo: true });
    expect(p.steps[0].request.inputs).toEqual({ video: "/api/files/u/clip.mp4" });
    expect(p.steps[0].request.title).toBe("Split · video soundtrack");
    expect(p.steps[0].request.params?.extra).toEqual({ channels: "each channel" });
    expect(p.steps[0].request.step?.label).toBe("Dialogue, music, effects · every channel");
    expect(p.mode).toBe("each channel");
    expect(p.summary).toBe("Splits the video's soundtrack into dialogue, music, effects and music & effects, every channel on its own (2 passes).");
    expect(p.length).toBeNull();
  });

  it("splits a 5.1 file in mono, and says why its stems are mono", () => {
    const p = planSplit({ engine: "open", media: "/api/files/a.wav", kind: "audio", channels: 6, stereo: true });
    expect(p.mode).toBe("mono");
    expect(p.steps[0].request.params?.extra).toEqual({ channels: "mono", sourceChannels: 6 });
    expect(p.notes[0]).toBe(SURROUND_NOTE);
    expect(p.summary).toBe("Splits it into dialogue, music, effects and music & effects.");
  });

  it("makes a surround file's background from the music and effects stems (graph A's node 4 rewired)", () => {
    const graph = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "workflows/comfyui/separate-soundtrack-dbs.json"), "utf8"));
    const bed = dbsSurroundBed(graph);
    expect(bed["4"].inputs).toEqual({ audio1: ["3", 0], audio2: ["3", 1], merge_method: "add" });
    // Nothing else changes, and the graph it came from is left as it was.
    expect({ ...bed, "4": graph["4"] }).toEqual(graph);
    expect(graph["4"].inputs.merge_method).toBe("subtract");
    // A graph without DBS, or already rewired: as it is.
    const other = { "1": { class_type: "LoadAudio", inputs: {} } };
    expect(dbsSurroundBed(other)).toBe(other);
    expect(dbsSurroundBed(bed)).toBe(bed);
  });

  it("has no cloud route: DBS isn't hosted, and no other model stands in for it", () => {
    expect(() => planSplit({ engine: "cloud", media: "/api/files/a.wav", kind: "audio" })).toThrow(CLOUD_SPLIT_PROBLEM);
    expect(CLOUD_SPLIT_PROBLEM).toMatch(/works with open-source models/);
    expect(() => planSplit({ engine: "open", media: "", kind: "video" })).toThrow("Add the video to split");
  });

  it("puts a mix back on its video: the stream-copy mux on the open engine, fal's merge on the cloud", () => {
    const open = planRemux({ engine: "open", video: "/api/files/v.mp4", audio: "/api/files/mix.wav", name: "Trailer" });
    expect(open.steps[0].request).toMatchObject({ modelId: "oss-mux", op: "mux", feature: "audio-split-remux", inputs: { video: "/api/files/v.mp4", audio: "/api/files/mix.wav" }, title: "Remix · Trailer" });
    expect(open.notes).toEqual(["The picture is copied as it is, not re-encoded."]);
    const cloud = planRemux({ engine: "cloud", video: "/api/files/v.mp4", audio: "/api/files/mix.wav" });
    expect(cloud.steps[0].request).toMatchObject({ modelId: "merge-audio-video", op: "mux", title: "Remix · video" });
    // Both models exist and do the mux.
    for (const id of ["oss-mux", "merge-audio-video", "oss-dbs-separate"]) expect(getModel(id)).toBeTruthy();
    expect(getModel("oss-dbs-separate")!.routes[0]).toMatchObject({ op: "separate-audio", provider: "comfyui", endpoint: "separate-soundtrack-dbs" });
  });
});

describe("time on the open engine", () => {
  it("uses the measured CPU speeds (0.25x / 0.10x per pass, DBS D4) and the reference GPU's", () => {
    expect(DBS_SPEED.cpu).toEqual({ fast: 0.25, best: 0.1 });
    // 60 s on a CPU with DBS-BSRNN: about 240 s of work, 3 s to load and save.
    expect(splitTime({ seconds: 60, quality: "fast", mode: "mono", device: "cpu" })).toEqual({ low: 195, high: 387 });
    // Stereo stems: one pass per channel.
    const stereo = splitTime({ seconds: 60, quality: "fast", mode: "each channel", channels: 2, device: "cpu" });
    expect(stereo.high).toBe(Math.round(3 + ((60 * 2) / 0.25) * 1.6));
    expect(splitTime({ seconds: 60, quality: "best", mode: "mono" }).low).toBe(Math.round(3 + (60 / 0.1) * 0.8));
    // A mono file with stereo stems asked for: one pass (DBS runs once per channel).
    expect(splitTime({ seconds: 60, quality: "fast", mode: dbsChannelsFor("each channel", 1), channels: 1, device: "cpu" })).toEqual({ low: 195, high: 387 });
    // Each channel is one pass per channel (the measured 5.1 run: six passes); a 5.1 split is mono now, one pass.
    expect(splitTime({ seconds: 10, quality: "fast", mode: "each channel", channels: 6, device: "cpu" }).low).toBe(Math.round(3 + (60 / 0.25) * 0.8));
    expect(splitTime({ seconds: 10, quality: "fast", mode: dbsChannelsFor("each channel", 6), channels: 6, device: "cpu" }).low).toBe(Math.round(3 + (10 / 0.25) * 0.8));
    // CUDA: well over real time, a range up to 4x slower than the reference card.
    expect(splitTime({ seconds: 600, quality: "best", mode: "mono", device: "cuda" })).toEqual({ low: 41, high: 154 });
  });

  it("says it in words", () => {
    expect(durationWords({ low: 20, high: 50 })).toBe("under a minute");
    expect(durationWords({ low: 195, high: 387 })).toBe("about 3–6 min");
    expect(durationWords({ low: 120, high: 130 })).toBe("about 2 min");
    expect(durationWords({ low: 7200, high: 10800 })).toBe("about 2–3 h");
  });
});

describe("the mixer", () => {
  it("turns levels into gains: −24…+6 dB in half-dB steps", () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
    expect(dbToGain(6)).toBeCloseTo(1.995, 3);
    expect(dbToGain(-12)).toBeCloseTo(0.251, 3);
    expect(dbToGain(-Infinity)).toBe(0);
    expect(clampDb(-40)).toBe(-24);
    expect(clampDb(9)).toBe(6);
    expect(clampDb(-3.3)).toBe(-3.5);
    expect([dbLabel(0), dbLabel(3), dbLabel(-12), dbLabel(-0.2)]).toEqual(["0 dB", "+3 dB", "−12 dB", "0 dB"]);
  });

  it("starts as the original: dialogue plus music & effects, the separate stems muted so nothing plays twice", () => {
    expect(stemGains(ORIGINAL_MIX)).toEqual({ voice: 1, music: 0, effects: 0, background: 1 });
    expect(presetOf(ORIGINAL_MIX)).toBe("original");
    expect(STEMS.map((s) => [s.id, s.label])).toEqual([
      ["voice", "Dialogue"],
      ["music", "Music"],
      ["effects", "Effects"],
      ["background", "Music & effects"],
    ]);
  });

  it("has the presets: no dialogue, dialogue only, music only, music under dialogue at −12 dB, clean dialogue at −18 dB", () => {
    const gains = Object.fromEntries(PRESETS.map((p) => [p.id, stemGains(p.mix)]));
    expect(gains["no-dialogue"]).toEqual({ voice: 0, music: 0, effects: 0, background: 1 });
    expect(gains["dialogue-only"]).toEqual({ voice: 1, music: 0, effects: 0, background: 0 });
    expect(gains["music-only"]).toEqual({ voice: 0, music: 1, effects: 0, background: 0 });
    expect(gains["music-under"].voice).toBe(1);
    expect(gains["music-under"].background).toBeCloseTo(0.251, 3);
    // Clean up dialogue (D5): the dialogue with the music and effects 18 dB down.
    expect(gains["clean-dialogue"].voice).toBe(1);
    expect(gains["clean-dialogue"].background).toBeCloseTo(0.126, 3);
    expect(PRESETS.map((p) => p.label)).toEqual(["Original", "No dialogue", "Dialogue only", "Music only", "Music under dialogue (−12 dB)", "Clean dialogue (−18 dB)"]);
    for (const p of PRESETS) expect(presetOf(p.mix)).toBe(p.id);
  });

  it("never plays music or effects twice: the bed and its two stems take turns", () => {
    let m: Mix = setMute(ORIGINAL_MIX, "music", false);
    expect(stemGains(m)).toEqual({ voice: 1, music: 1, effects: 0, background: 0 });
    m = setMute(m, "effects", false);
    expect(stemGains(m)).toEqual({ voice: 1, music: 1, effects: 1, background: 0 });
    m = setMute(m, "background", false);
    expect(stemGains(m)).toEqual({ voice: 1, music: 0, effects: 0, background: 1 });
    // Moving a muted stem's level unmutes it (and the same rule applies).
    m = setLevel(m, "music", -6);
    expect(m.music).toEqual({ db: -6, mute: false, solo: false });
    expect(m.background.mute).toBe(true);
    expect(presetOf(m)).toBeNull();
    expect(setLevel(ORIGINAL_MIX, "voice", 40).voice.db).toBe(6);
  });

  it("solo plays only the soloed stems; a muted one stays silent", () => {
    let m = setSolo(ORIGINAL_MIX, "voice", true);
    expect(stemGains(m)).toEqual({ voice: 1, music: 0, effects: 0, background: 0 });
    m = setSolo(m, "background", true);
    expect(stemGains(m)).toEqual({ voice: 1, music: 0, effects: 0, background: 1 });
    m = setMute(m, "voice", true);
    expect(stemGains(m).voice).toBe(0);
  });

  it("names a mix for the Library", () => {
    expect(mixName(ORIGINAL_MIX)).toBe("Dialogue + Music & effects");
    expect(mixName(PRESETS.find((p) => p.id === "music-under")!.mix)).toBe("Music under dialogue (−12 dB)");
    expect(mixName(setLevel(PRESETS.find((p) => p.id === "dialogue-only")!.mix, "voice", 3))).toBe("Dialogue +3 dB");
    expect(mixName({ ...ORIGINAL_MIX, voice: { db: 0, mute: true, solo: false }, background: { db: 0, mute: true, solo: false } })).toBe("Silence");
  });

  it("knows a background that AudioMerge lowered to fit under full scale (a loud master)", () => {
    expect(backgroundLowered(1)).toBe(true);
    expect(backgroundLowered(32767 / 32768)).toBe(true);
    expect(backgroundLowered(0.97)).toBe(false);
  });

  it("exports a 16-bit WAV kept under full scale", () => {
    expect(headroomGain(0.5)).toBe(1);
    expect(headroomGain(2) * 2).toBeCloseTo(dbToGain(-0.1), 6);
    const wav = encodeWav([Float32Array.from([0, 0.5, -1, 2]), Float32Array.from([1, -0.5, 0, 0])], 44100);
    const d = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
    expect([d.getUint16(22, true), d.getUint32(24, true), d.getUint16(34, true), d.getUint32(40, true)]).toEqual([2, 44100, 16, 4 * 2 * 2]);
    // Interleaved L/R, clipped at full scale.
    expect(Array.from({ length: 8 }, (_, i) => d.getInt16(44 + i * 2, true))).toEqual([0, 32767, 16384, -16384, -32768, 0, 32767, 0]);
  });

  it("mixes the stems as WebAudio plays them: mono up-mixed to both sides of stereo, to the centre of 5.1", () => {
    expect([0, 1].map((c) => stemFeed(1, 2, c))).toEqual([0, 0]);
    expect([0, 1, 2, 3, 4, 5].map((c) => stemFeed(1, 6, c))).toEqual([-1, -1, 0, -1, -1, -1]);
    expect([0, 1, 2, 3, 4, 5].map((c) => stemFeed(6, 6, c))).toEqual([0, 1, 2, 3, 4, 5]);
    expect([0, 1, 2].map((c) => stemFeed(2, 3, c))).toEqual([0, 1, -1]);
    expect(stemFeed(1, 1, 0)).toBe(0);
  });

  it("writes the mix in parts that join into the WAV, lowering the whole mix when it would clip", () => {
    const voice = { channels: [Float32Array.from([0.5, 0.5, 0.5, 0.5, 0.5])], gain: 1 };
    const bed = { channels: [Float32Array.from([0.25, 0.5, 0.75, 0.25, 0]), Float32Array.from([-0.25, -0.5, -0.75, -0.25, 0])], gain: 1 };
    const muted = { channels: [Float32Array.from([1, 1, 1, 1, 1])], gain: 0 };
    const plan = mixPlan([voice, bed, muted], 8000);
    expect(plan).toMatchObject({ frames: 5, channels: 2, sampleRate: 8000, bytes: wavBytes(5, 2) });
    // Left 0.5 + 0.75 = 1.25 at its loudest: over full scale, so the whole mix comes down to −0.1 dBFS.
    expect(mixPeak(plan)).toBeCloseTo(1.25, 6);
    expect(mixPeak(plan, 3, 5)).toBeCloseTo(0.75, 6);
    const k = headroomGain(mixPeak(plan));
    const expected = encodeWav(
      [Float32Array.from([0.75, 1, 1.25, 0.75, 0.5].map((v) => v * k)), Float32Array.from([0.25, 0, -0.25, 0.25, 0.5].map((v) => v * k))],
      8000,
    );
    // 2 frames (8 bytes) a part: the header rides on the first.
    const parts = [0, 2, 4].map((f) => mixPart(plan, f, f + 2, k));
    expect(partFrames(plan, 8)).toBe(2);
    expect(parts.map((p) => p.length)).toEqual([44 + 8, 8, 4]);
    expect(Buffer.concat(parts)).toEqual(Buffer.from(expected));
    // Frame 2's left sample, the loudest, lands at −0.1 dBFS.
    expect(new DataView(parts[1].buffer).getInt16(0, true)).toBe(Math.round(1.25 * k * 0x7fff));
    // A quiet mix is left as it is.
    expect(headroomGain(mixPeak(mixPlan([voice], 8000)))).toBe(1);
  });

  it("knows how much the browser can hold, and says so before decoding a split too long for it", () => {
    // Four stems of a 7-minute 5.1 clip, every channel split: 24 channels at 48 kHz as 32-bit floats.
    const surround = mixerBytes(Array(4).fill({ seconds: 420, channels: 6 }), 48000);
    expect(surround).toBe(420 * 48000 * 24 * 4);
    expect(mixerBudget({ deviceMemoryGb: 8 })).toBe(2 * 1024 ** 3);
    expect(mixerBudget({ deviceMemoryGb: 2 })).toBe(512 * 1024 ** 2);
    expect(mixerBudget({ coarse: true })).toBe(1024 ** 3);
    expect(mixerBudget({})).toBe(2 * 1024 ** 3);
    expect(mixerProblem(surround, mixerBudget({}))).toBeNull();
    // An hour of stereo on a phone: refused, in words, before anything is fetched.
    const hour = mixerBytes([{ seconds: 3600, channels: 1 }, { seconds: 3600, channels: 1 }, { seconds: 3600, channels: 1 }, { seconds: 3600, channels: 2 }], 48000);
    expect(mixerProblem(hour, mixerBudget({ coarse: true }))).toBe(
      "This split is too long to mix in your browser: its stems take about 3.2 GB of memory to play, and this device has room for about 1 GB. Download the stems and mix them in an editor, or split a shorter clip.",
    );
    // The export itself: a WAV up to MIX_MAX_BYTES, sent in parts, so a 7-minute 5.1 mix (242 MB) is fine.
    expect(wavBytes(420 * 48000, 6)).toBe(44 + 420 * 48000 * 12);
    expect(exportProblem(420 * 48000, 6)).toBeNull();
    expect(exportProblem(Math.ceil(MIX_MAX_BYTES / 12), 6)).toMatch(/^This mix would be a 2 GB WAV, over the 2 GB an export can be/);
  });
});

describe("Split soundtrack in the Audio hub", () => {
  it("is a mode after Transcribe, with its own path", () => {
    const ids = HUB_MODES.audio.map((m) => m.id);
    expect(ids.indexOf("split")).toBe(ids.indexOf("transcribe") + 1);
    expect(HUB_MODES.audio.find((m) => m.id === "split")?.label).toBe("Split soundtrack");
    expect(modeHref("audio", "split")).toBe("/audio/split");
  });
});

describe("POST /api/audio-tools split and remux (demo mode)", () => {
  it("prices a split as free with a time estimate, and runs it into four Library stems", async () => {
    const media = upload(6, 2);
    const preview = await (await post({ tool: "split", engine: "open", media, kind: "audio", name: "Film" }, true)).json();
    expect(preview).toMatchObject({ steps: 1, costUsd: 0, demo: true, length: 6, hostPick: "fast" });
    expect(preview.summary).toBe("Splits it into dialogue, music, effects and music & effects.");
    // The header's length beats the browser's; the estimate is the CPU's (no device in demo mode).
    expect(preview.estimate).toEqual(splitTime({ seconds: 6, quality: "fast", mode: "mono", channels: 2 }));
    const best = await (await post({ tool: "split", engine: "open", media, kind: "audio", quality: "best", stereo: true, sourceDuration: 99 }, true)).json();
    expect(best.estimate).toEqual(splitTime({ seconds: 6, quality: "best", mode: "each channel", channels: 2 }));

    const res = await post({ tool: "split", engine: "open", media, kind: "audio", name: "Film" });
    expect(res.status).toBe(201);
    const run = await res.json();
    expect(run.result).toMatchObject({ feature: "audio-split", modelId: "oss-dbs-separate", provider: "mock", op: "separate-audio" });
    const g = await finished(run.result.id);
    expect(g.status).toBe("succeeded");
    expect(g.outputs.map((o) => [o.kind, o.meta?.stem])).toEqual([
      ["audio", "voice"],
      ["audio", "music"],
      ["audio", "effects"],
      ["audio", "background"],
    ]);
    expect(g.outputs.every((o) => o.url.startsWith("/api/files/"))).toBe(true);
  });

  it("reads a 5.1 file's channels from its header and splits it in mono", async () => {
    const media = upload(4, 6, "surround.wav");
    const preview = await (await post({ tool: "split", engine: "open", media, kind: "audio", stereo: true }, true)).json();
    expect(preview.notes[0]).toBe(SURROUND_NOTE);
    expect(preview.estimate).toEqual(splitTime({ seconds: 4, quality: "fast", mode: "mono", channels: 6 }));
    const run = await (await post({ tool: "split", engine: "open", media, kind: "audio" })).json();
    expect(run.result.request.params.extra).toEqual({ channels: "mono", sourceChannels: 6 });
  });

  it("says plainly that the cloud has no split, and refuses on an install set to paid APIs only", async () => {
    const media = upload(3, 2, "a.wav");
    const cloud = await post({ tool: "split", engine: "cloud", media, kind: "audio" }, true);
    expect(cloud.status).toBe(422);
    expect((await cloud.json()).error).toBe(CLOUD_SPLIT_PROBLEM);
    setSetting("engineMode", "cloud");
    try {
      expect((await (await post({ tool: "split", engine: "cloud", media, kind: "audio" }, true)).json()).error).toBe(CLOUD_ONLY_PROBLEM);
      expect((await (await post({ tool: "split", engine: "open", media, kind: "audio" })).json()).error).toBe(CLOUD_ONLY_PROBLEM);
    } finally {
      setSetting("engineMode", "both");
    }
    expect((await (await post({ tool: "split", engine: "open", media: "/etc/passwd", kind: "audio" })).json()).error).toBe("Add the audio or video to split");
    expect((await (await post({ tool: "split", engine: "open", media: "/api/files/uploads/gone.wav", kind: "audio" }, true)).json()).error).toBe("That audio file is gone — add it again");
  });

  it("refuses a file with no sound before anything is queued", async () => {
    const silent = saveFile({ data: fs.readFileSync(path.join(__dirname, "fixtures", "shorts-silent.webm")), contentType: "video/webm", name: "silent.webm", source: "upload" }).url;
    for (const preview of [true, false]) {
      const res = await post({ tool: "split", engine: "open", media: silent, kind: "video" }, preview);
      expect(res.status).toBe(422);
      expect((await res.json()).error).toBe("This video has no sound to split");
    }
    const silentMp4 = saveFile({ data: mp4Sound(null), contentType: "video/mp4", name: "t2v.mp4", source: "upload" }).url;
    expect((await (await post({ tool: "split", engine: "open", media: silentMp4, kind: "video" }, true)).json()).error).toBe("This video has no sound to split");
  });

  it("reads a 5.1 MP4's channels from its header, so an API call without the browser's count gets the surround rule", async () => {
    const media = saveFile({ data: mp4Sound(6), contentType: "video/mp4", name: "film.mp4", source: "upload" }).url;
    const preview = await (await post({ tool: "split", engine: "open", media, kind: "video" }, true)).json();
    expect(preview).toMatchObject({ channels: 6, length: 2 });
    expect(preview.notes[0]).toBe(SURROUND_NOTE);
    const run = await (await post({ tool: "split", engine: "open", media, kind: "video" })).json();
    expect(run.result.request.params.extra).toEqual({ channels: "mono", sourceChannels: 6 });
  });

  it("reads a header without reading the file: a 2.2 GB file is a few small reads", () => {
    fs.mkdirSync(path.join(dir, "files", "uploads"), { recursive: true });
    const file = path.join(dir, "files", "uploads", "huge.wav");
    const head = Buffer.alloc(44);
    const data = 2.2e9 - 44;
    head.write("RIFF", 0);
    head.writeUInt32LE(36 + data, 4);
    head.write("WAVEfmt ", 8);
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20);
    head.writeUInt16LE(2, 22);
    head.writeUInt32LE(48000, 24);
    head.writeUInt32LE(192000, 28);
    head.writeUInt16LE(4, 32);
    head.writeUInt16LE(16, 34);
    head.write("data", 36);
    head.writeUInt32LE(data, 40);
    fs.writeFileSync(file, head);
    fs.truncateSync(file, 2.2e9);
    try {
      expect(storedMedia("/api/files/uploads/huge.wav", { allContainers: true })).toEqual({ info: { container: "wav", duration: data / 192000, hasVideo: false, hasAudio: true, channels: 2 } });
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("puts a mix back on the video: free on the open engine, priced on the cloud", async () => {
    const audio = upload(3, 2, "mix.wav");
    const video = saveFile({ data: Buffer.from("not really a video"), contentType: "video/mp4", name: "clip.mp4", source: "upload" }).url;
    const open = await (await post({ tool: "remux", engine: "open", video, audio, name: "Clip" }, true)).json();
    expect(open).toMatchObject({ steps: 1, costUsd: 0, summary: "Puts your mix on the video in place of its sound." });
    const cloud = await (await post({ tool: "remux", engine: "cloud", video, audio }, true)).json();
    expect(cloud.steps).toBe(1);
    const run = await (await post({ tool: "remux", engine: "open", video, audio, name: "Clip" })).json();
    expect(run.result).toMatchObject({ feature: "audio-split-remux", modelId: "oss-mux", op: "mux" });
    expect(run.result.request.inputs).toEqual({ video, audio });
    expect((await (await post({ tool: "remux", engine: "open", video, audio: "/api/files/uploads/gone.wav" }, true)).json()).error).toBe("That mix is gone — export it again");
    expect((await (await post({ tool: "remux", engine: "open", video })).json()).error).toBe("Export the mix first");
  });
});

describe("POST /api/audio-tools/export (a mix sent in parts)", () => {
  const send = (q: string, body: Uint8Array) => exportRoute.POST(new Request(`http://x/api/audio-tools/export?${q}`, { method: "POST", body: Buffer.from(body) }));

  it("joins the parts into one WAV in the Library, whatever its size", async () => {
    const plan = mixPlan([{ channels: [Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10) / 2), Float32Array.from({ length: 1000 }, () => 0.25)], gain: 1 }], 8000);
    const per = partFrames(plan, 1000);
    const parts = Array.from({ length: Math.ceil(plan.frames / per) }, (_, i) => mixPart(plan, i * per, (i + 1) * per));
    expect(parts.length).toBe(4);
    let id = "";
    let offset = 0;
    let res: Response | undefined;
    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1;
      res = await send(`offset=${offset}${id ? `&id=${id}` : ""}${last ? `&last=1&name=${encodeURIComponent("Film · No dialogue.wav")}` : ""}`, part);
      if (!last) {
        expect(res.status).toBe(200);
        const body = await res.json();
        id = body.id;
        offset = body.received;
      }
    }
    expect(res!.status).toBe(201);
    const asset = await res!.json();
    expect(asset).toMatchObject({ kind: "audio", contentType: "audio/wav", name: "Film · No dialogue.wav", source: "upload" });
    const stored = getAsset(asset.id)!;
    const bytes = fs.readFileSync(path.join(dir, "files", stored.relPath));
    expect(bytes).toEqual(Buffer.concat(parts));
    expect(bytes.length).toBe(plan.bytes);
    // Nothing is left behind in the scratch folder.
    expect(fs.readdirSync(scratchDir()).filter((f) => f.startsWith("mix-"))).toEqual([]);
  });

  it("refuses what isn't a 16-bit WAV, a part that doesn't follow on, too much audio and a short export", async () => {
    expect((await send("offset=0&last=1", new TextEncoder().encode("not a wav file at all, not even close to one"))).status).toBe(415);
    expect((await send("offset=10", mixPart(mixPlan([{ channels: [new Float32Array(10)], gain: 1 }], 8000), 0, 10))).status).toBe(409);
    const plan = mixPlan([{ channels: [new Float32Array(100)], gain: 1 }], 8000);
    const first = await (await send("offset=0", mixPart(plan, 0, 50))).json();
    expect(first.received).toBe(44 + 100);
    expect((await send(`offset=0&id=${first.id}`, mixPart(plan, 50, 100))).status).toBe(409);
    const short = await send(`offset=${first.received}&id=${first.id}&last=1`, mixPart(plan, 50, 60));
    expect(short.status).toBe(409);
    expect((await short.json()).error).toMatch(/^The export stopped short/);
    // The short part was kept (20 bytes): the next one must start after it, and the header caps what can follow.
    expect((await send(`offset=${first.received}&id=${first.id}`, mixPart(plan, 60, 70))).status).toBe(409);
    expect((await send(`offset=${first.received + 20}&id=${first.id}`, new Uint8Array(400))).status).toBe(413);
    const done = await send(`offset=${first.received + 20}&id=${first.id}&last=1&name=Mix`, mixPart(plan, 60, 100));
    expect(done.status).toBe(201);
    expect((await done.json()).name).toBe("Mix.wav");
    expect((await send("offset=4&id=../../etc", new Uint8Array(4))).status).toBe(404);
    expect((await send("offset=4&id=AAAAAAAAAAAAAAAA", new Uint8Array(4))).status).toBe(404);
    // A header that declares more than an export can be.
    const huge = mixPart(plan, 0, 10);
    new DataView(huge.buffer).setUint32(4, MIX_MAX_BYTES, true);
    expect((await send("offset=0", huge)).status).toBe(413);
  });

  it("takes a whole 16 MB part, sent without a length, and never reads past a part", async () => {
    // The sign-in proxy holds 4 MB of a body at most (next.config.ts): this route skips it and reads the part itself.
    const plan = mixPlan([{ channels: [new Float32Array(MIX_PART_BYTES / 2)], gain: 1 }], 48000);
    const part = mixPart(plan, 0, plan.frames);
    expect(part.length).toBe(MIX_PART_BYTES + 44);
    const stream = (bytes: Uint8Array, chunk = 1024 ** 2) => {
      let at = 0;
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (at >= bytes.length) return c.close();
          const next = bytes.subarray(at, at + chunk);
          at += next.length;
          pulled += next.length;
          c.enqueue(next);
        },
      });
      return { body, pulled: () => pulled };
    };
    const whole = stream(part);
    const req = (q: string, body: ReadableStream<Uint8Array>) => new Request(`http://x/api/audio-tools/export?${q}`, { method: "POST", body, duplex: "half" } as RequestInit);
    const res = await exportRoute.POST(req("offset=0&last=1&name=Big", whole.body));
    expect(res.status).toBe(201);
    expect(fs.statSync(path.join(dir, "files", getAsset((await res.json()).id)!.relPath)).size).toBe(part.length);
    // A body past a part's limit stops being read soon after it.
    const over = stream(new Uint8Array(PART_MAX * 3));
    expect((await exportRoute.POST(req("offset=0", over.body))).status).toBe(413);
    expect(over.pulled()).toBeLessThanOrEqual(PART_MAX + 2 * 1024 ** 2);
  });
});

describe("a price check on a ComfyUI without the DBS model it would use", () => {
  it("refuses the host's pick in words, as it refuses a picked model, before anything runs", async () => {
    // A CPU ComfyUI with ComfyUI-DBS loaded: GET /models/dbs lists the files on disk.
    let files: string[] = [];
    const server = http.createServer((req, res) => {
      const at = (req.url ?? "").split("?")[0];
      const body = at === "/system_stats" ? { system: { comfyui_version: "0.41.0" }, devices: [{ name: "cpu", type: "cpu" }] } : at === "/models/dbs" ? files : null;
      res.writeHead(body ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    setSetting("comfyUrl", url);
    globalThis.__fuobeComfyReach = { ok: true, at: Date.now(), url, seen: Date.now() };
    globalThis.__fuobeComfyDevice = globalThis.__fuobeComfyDbs = undefined;
    try {
      const media = upload(5, 2, "pick.wav");
      const price = (asked: Record<string, unknown>) => post({ tool: "split", engine: "open", media, kind: "audio", ...asked }, true);
      // Neither model on disk: no quality picked is refused as Fast picked is (the CPU's pick), not priced as if it ran.
      for (const asked of [{}, { quality: "fast" }]) {
        const res = await price(asked);
        expect(res.status).toBe(422);
        expect((await res.json()).error).toBe(missingDbs("DBS-BSRNN-DnR", []));
      }
      // DBS-TIGER alone: the host's pick is it, priced; Fast picked is refused and names Best.
      files = ["DBS-TIGER-DnR/config.json", "DBS-TIGER-DnR/model.safetensors"];
      globalThis.__fuobeComfyDbs = undefined;
      expect(await (await price({})).json()).toMatchObject({ demo: false, hostPick: "best", installed: ["best"], device: "cpu" });
      expect((await (await price({ quality: "fast" })).json()).error).toBe(missingDbs("DBS-BSRNN-DnR", ["DBS-TIGER-DnR"]));
    } finally {
      setSetting("comfyUrl", "");
      globalThis.__fuobeComfyReach = undefined;
      globalThis.__fuobeComfyDevice = globalThis.__fuobeComfyDbs = undefined;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("the soundtrack while it uploads (the page's source)", () => {
  type Shown = { id?: string; ref: string; preview: string; kind: "audio" | "video"; name?: string; uploading?: boolean } | null;
  const answer = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  const film = (name = "Film.wav") => new File([new Uint8Array(64)], name, { type: "audio/wav" });
  let server: () => Response | Promise<Response> = () => answer(500, {});
  beforeEach(() => {
    toasts.error.length = 0;
    vi.stubGlobal("fetch", async () => server());
  });
  afterEach(() => vi.unstubAllGlobals());

  /** The page's source as React keeps it: the upload puts it up, then changes what is there by its answer. */
  function page() {
    let source: Shown = null;
    const seen: Shown[] = [];
    const put = (s: NonNullable<Shown>) => void seen.push((source = s));
    const update = (next: (cur: Shown) => Shown) => void seen.push((source = next(source)));
    return { seen, now: () => source, remove: () => void (source = null), upload: (f = film()) => uploadSource(f, "audio", put, update) };
  }

  it("a guest's refused upload goes back to the empty tool, not Uploading… for good", async () => {
    server = () => answer(401, { error: GUEST_RUN_MESSAGE }, { [GUEST_HEADER]: "1" });
    const p = page();
    await p.upload();
    expect(p.seen.map((s) => s && { uploading: s.uploading, name: s.name })).toEqual([{ uploading: true, name: "Film.wav" }, null]);
    expect(p.now()).toBeNull();
  });

  it("so does an account's without its GPU, and a file the server reads as another kind (with why)", async () => {
    server = () => answer(403, { error: CONNECT_GPU_MESSAGE, code: "connect-gpu" }, { [CONNECT_GPU_HEADER]: "1" });
    const p = page();
    await p.upload();
    expect(p.seen.map((s) => s?.uploading ?? null)).toEqual([true, null]);
    server = () => answer(201, { id: "a1", url: "/api/files/uploads/a1.png", kind: "image" });
    toasts.error.length = 0;
    await p.upload(film("cover.wav"));
    expect(p.now()).toBeNull();
    expect(toasts.error).toEqual(["Audio only — drop a sound file here"]);
  });

  it("a finished upload gives the soundtrack its address and keeps the file's name", async () => {
    server = () => answer(201, { id: "a2", url: "/api/files/uploads/a2.wav", kind: "audio" });
    const p = page();
    await p.upload();
    expect(p.now()).toMatchObject({ ref: "/api/files/uploads/a2.wav", preview: "/api/files/uploads/a2.wav", kind: "audio", name: "Film.wav", id: p.seen[0]?.id });
    expect(p.now()?.uploading).toBeUndefined();
  });

  it("a soundtrack removed or replaced while it uploads stays as it is when the answer comes", async () => {
    let reply: (r: Response) => void = () => {};
    server = () => new Promise<Response>((r) => (reply = r));
    const p = page();
    const removed = p.upload();
    p.remove();
    reply(answer(201, { id: "a3", url: "/api/files/uploads/a3.wav", kind: "audio" }));
    await removed;
    expect(p.now()).toBeNull();
    // Replaced: the newer file stays, whatever the older one's answer.
    const older = p.upload(film("Older.wav"));
    const refuse = reply;
    server = () => answer(201, { id: "a4", url: "/api/files/uploads/a4.wav", kind: "audio" });
    await p.upload(film("Newer.wav"));
    refuse(answer(401, { error: GUEST_RUN_MESSAGE }, { [GUEST_HEADER]: "1" }));
    await older;
    expect(p.now()).toMatchObject({ ref: "/api/files/uploads/a4.wav", name: "Newer.wav" });
  });
});
