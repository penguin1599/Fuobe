import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  CLEAN_MAX_SECONDS,
  CLOUD_CLEAN_PROBLEM,
  CLOUD_ONLY_CLEAN_PROBLEM,
  cleanTime,
  installedReuse,
  missingReuse,
  planClean,
  planTime,
  rateFor,
  reportLine,
  reuseFileFor,
  rtfAt,
  scanHint,
  tooLongProblem,
  workRate,
} from "@/lib/av/clean-voice";
import { HUB_MODES, modeHref, modeOfPath } from "@/lib/hubs";
import { cleanedName } from "@/components/audio-tools/clean-voice-switch";
import { outputActions } from "@/lib/output-actions";
import { APPS, getModel } from "@/lib/catalog";
import { blockerFor } from "@/lib/composer";
import type { Generation } from "@/lib/catalog/types";
import { defaultModelForNode, NODE_SPECS, nodeOps, paletteItems } from "@/lib/catalog/canvas";
import { tempDir } from "./helpers/temp-dir";

// Audio → Clean up voice (NVIDIA RE-USE): the planner, the rate and time rules, the Library action, the app, and the API
// in demo mode.
const dir = tempDir("fuobe-clean-");
process.env.FUOBE_DATA_DIR = dir;
// Nothing listens: the open model runs on the demo provider.
process.env.COMFYUI_URL = "http://127.0.0.1:9";
vi.mock("sonner", () => ({ toast: Object.assign(() => {}, { error: () => {} }) }));

const { setSetting } = await import("@/server/settings");
const { saveFile } = await import("@/server/storage");
const gens = await import("@/server/generations");
const route = await import("@/app/api/audio-tools/route");

beforeAll(() => setSetting("demoMode", "auto"));

function upload(seconds: number, channels = 1, name = "voice.wav"): string {
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

describe("the RE-USE files a host has", () => {
  it("reads GET /models/reuse, Windows back slashes too", () => {
    expect(installedReuse(["NemotronLabs-RE-USE.safetensors"])).toEqual(["voice"]);
    expect(installedReuse(["x\\NemotronLabs-RE-USE-laughter.safetensors", "NemotronLabs-RE-USE.safetensors"])).toEqual(["voice", "laughter"]);
    expect(installedReuse([])).toEqual([]);
    expect(installedReuse(undefined)).toBeUndefined();
  });

  it("refuses a missing file in words, with what to do", () => {
    expect(missingReuse("laughter", ["voice"])).toBe("Keep laughter isn't installed (models/reuse/NemotronLabs-RE-USE-laughter.safetensors, 39 MB); pick Voice only or install it from Workflows → Clean up voice.");
    expect(missingReuse("voice", [])).toMatch(/^RE-USE isn't on your ComfyUI yet \(models\/reuse\/NemotronLabs-RE-USE\.safetensors, 39 MB\)\. Copy the install commands/);
    expect(reuseFileFor("laughter", ["voice", "laughter"])).toBe("NemotronLabs-RE-USE-laughter.safetensors");
    expect(reuseFileFor(undefined)).toBe("NemotronLabs-RE-USE.safetensors");
    expect(() => reuseFileFor("laughter", ["voice"])).toThrow(/^Keep laughter isn't installed/);
  });
});

describe("the rate a run gets", () => {
  it("keeps the source's on a GPU, caps it on a CPU (16 kHz past 2 minutes), and runs Full band and Fast as named", () => {
    expect(rateFor("auto", "cuda", 3600)).toBe("source");
    expect(rateFor("auto", "cpu", 30)).toBe("source up to 24000");
    expect(rateFor("auto", undefined, 120)).toBe("source up to 24000");
    expect(rateFor("auto", "cpu", 121)).toBe("source up to 16000");
    expect(rateFor("auto", "mps", 10)).toBe("source up to 24000");
    for (const d of ["cuda", "cpu"]) {
      expect(rateFor("full", d)).toBe("48000");
      expect(rateFor("fast", d)).toBe("16000");
      expect(rateFor("48000", d)).toBe("48000");
    }
  });

  it("knows the rate the node will run at, for the estimate", () => {
    expect(workRate("source", 44100)).toBe(44100);
    expect(workRate("source", 96000)).toBe(48000);
    expect(workRate("source", 6000)).toBe(8000);
    expect(workRate("source up to 24000", 44100)).toBe(24000);
    expect(workRate("source up to 24000", 16000)).toBe(16000);
    expect(workRate("48000", 8000)).toBe(48000);
  });
});

describe("time on the open engine", () => {
  it("interpolates the measured work per second of audio by rate", () => {
    expect(rtfAt("cuda", 16000)).toBe(0.26);
    expect(rtfAt("cpu", 8000)).toBe(2);
    expect(rtfAt("cpu", 20000)).toBeCloseTo(4.5);
    expect(rtfAt("cpu", 96000)).toBe(15);
  });

  it("gives a range: GPU measurements were worst cases, a CPU's spread is DBS's, plus loading and DBS for the bed", () => {
    expect(cleanTime({ seconds: 60, rate: 16000, device: "cuda" })).toEqual({ low: Math.round(3 + 60 * 0.26 * 0.3), high: Math.round(3 + 60 * 0.26 * 1.2) });
    expect(cleanTime({ seconds: 60, rate: 16000, device: "cpu" })).toEqual({ low: Math.round(3 + 240 * 0.8), high: Math.round(3 + 240 * 1.6) });
    expect(cleanTime({ seconds: 60, rate: 16000, device: "cuda", firstRun: true }).low).toBe(Math.round(23 + 60 * 0.26 * 0.3));
    expect(cleanTime({ seconds: 60, rate: 16000, device: "cpu", bed: true }).low).toBeGreaterThan(cleanTime({ seconds: 60, rate: 16000, device: "cpu" }).low);
    expect(cleanTime({ seconds: 10, rate: 16000, device: "cpu", passes: 2 }).high).toBe(Math.round(3 + 80 * 1.6));
  });

  it("refuses a plan over 2 hours, with what to change", () => {
    const hour = planTime({ seconds: 3600, quality: "full", device: "cpu" });
    expect(hour.rate).toBe(48000);
    expect(hour.low).toBeGreaterThan(CLEAN_MAX_SECONDS);
    expect(tooLongProblem(hour, "cpu")).toMatch(/^That's about \d+(\.\d)? h on a CPU\. Pick Fast 16 kHz, use a shorter file, or connect a GPU\.$/);
    expect(tooLongProblem(planTime({ seconds: 600, device: "cpu" }), "cpu")).toBeNull();
    expect(tooLongProblem(planTime({ seconds: 3600, device: "cuda" }), "cuda")).toBeNull();
  });
});

describe("planClean", () => {
  it("is one RE-USE job for a recording: Full strength, nothing kept but the voice", () => {
    const p = planClean({ engine: "open", media: "/api/files/uploads/a.wav", kind: "audio", name: "Interview", seconds: 30 });
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0].request).toMatchObject({
      modelId: "oss-reuse-voice",
      op: "enhance-voice",
      feature: "voice-clean",
      title: "Clean voice · Interview",
      inputs: { audio: "/api/files/uploads/a.wav" },
      params: { extra: { reuseModel: "voice", rate: "auto", strength: "full", level: "match input", channels: "mono" }, sourceDuration: 30 },
    });
    expect(p.steps[0].request.params?.extra).not.toHaveProperty("background");
    // The speaker and gap notes show under Background and Strength, not again in the summary.
    expect(p.notes).toEqual([]);
  });

  it("for a video removes everything but the voice at Natural strength and puts the clean soundtrack back on the picture", () => {
    const d = planClean({ engine: "open", media: "/api/files/uploads/v.mp4", kind: "video", name: "Vlog" });
    expect(d).toMatchObject({ strength: "natural", background: "remove", remux: true });
    expect(d.steps[0].request.params?.extra).toMatchObject({ strength: "natural" });
    expect(d.steps[0].request.params?.extra).not.toHaveProperty("background");
    expect(d.summary).toMatch(/^Cleans the video's soundtrack with RE-USE, then puts it back on the picture/);
  });

  it("for a video keeps music & effects when asked (DBS first), and puts the clean soundtrack back on the picture", () => {
    const p = planClean({ engine: "open", media: "/api/files/uploads/v.mp4", kind: "video", name: "Vlog", background: "keep" });
    expect(p).toMatchObject({ strength: "natural", background: "keep", remux: true });
    expect(p.steps.map((s) => s.key)).toEqual(["clean", "remux"]);
    expect(p.steps[0].request).toMatchObject({ inputs: { video: "/api/files/uploads/v.mp4" }, params: { extra: { background: "keep", strength: "natural" } } });
    expect(p.steps[1]).toMatchObject({ after: ["clean"], chain: [{ slot: "audio" }], request: { modelId: "oss-mux", op: "mux", feature: "voice-clean-remux", inputs: { video: "/api/files/uploads/v.mp4" } } });
    expect(p.summary).toMatch(/^Splits the video's soundtrack with DBS, cleans the dialogue with RE-USE/);
  });

  it("leaves the video alone when asked, and cleans everything but the voice when asked", () => {
    const p = planClean({ engine: "open", media: "/api/files/uploads/v.mp4", kind: "video", remux: false, background: "remove", strength: "full" });
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0].request.params?.extra).toMatchObject({ strength: "full" });
    expect(p.steps[0].request.params?.extra).not.toHaveProperty("background");
  });

  it("asks for Fast, the laughter model, voice-over level and stereo when picked; a surround file runs in mono", () => {
    const p = planClean({ engine: "open", media: "/api/files/x.wav", kind: "audio", quality: "fast", model: "laughter", level: "voice", stereo: true, channels: 2 });
    expect(p.steps[0].request.params?.extra).toMatchObject({ rate: "16000", reuseModel: "laughter", level: "-16 LUFS", channels: "each channel", sourceChannels: 2 });
    const five = planClean({ engine: "open", media: "/api/files/x.wav", kind: "audio", stereo: true, channels: 6 });
    expect(five.steps[0].request.params?.extra).toMatchObject({ channels: "mono", sourceChannels: 6 });
    expect(five.notes.at(-1)).toBe("This file has 6 channels: it is cleaned in mono, as ComfyUI saves mono or stereo only.");
  });

  it("has no cloud route, and refuses a file with no sound", () => {
    expect(() => planClean({ engine: "cloud", media: "/api/files/x.wav", kind: "audio" })).toThrow(CLOUD_CLEAN_PROBLEM);
    expect(() => planClean({ engine: "open", media: "/api/files/x.mp4", kind: "video", silent: true })).toThrow("This video has no sound to clean");
    expect(() => planClean({ engine: "open", media: "", kind: "audio" })).toThrow("Add the audio to clean");
  });
});

describe("the report in words", () => {
  it("says the device, rate, scan and speed, and when Triton is missing on a GPU", () => {
    expect(reportLine('{"device":"cuda:0","scan":"triton","rate":48000,"times_real_time":1.9}')).toBe("GPU · 48 kHz · Triton · 1.9x real time");
    expect(reportLine({ device: "cpu", scan: "numba", rate: 16000, times_real_time: 0.3 })).toBe("CPU · 16 kHz · numba · 0.3x real time");
    expect(reportLine("not json")).toBeNull();
    expect(scanHint({ device: "cuda:0", scan: "torch-loop" })).toBe("Install Triton for about 6x faster cleaning");
    expect(scanHint({ device: "cpu", scan: "torch-loop" })).toBeNull();
  });
});

describe("where Clean up voice opens", () => {
  it("is Audio's first mode (/audio opens on it, /audio/clean too), and an app that renders the same tool", () => {
    expect(HUB_MODES.audio[0]).toEqual({ id: "clean", label: "Clean up voice" });
    expect(modeHref("audio", "clean")).toBe("/audio");
    expect(modeOfPath("audio", "/audio")).toBe("clean");
    expect(modeOfPath("audio", "/audio/clean")).toBe("clean");
    const app = APPS.find((a) => a.id === "app-clean-up-voice")!;
    expect(app).toMatchObject({ tool: "clean-voice", category: "Utility", cloud: null, open: { modelId: "oss-reuse-voice", op: "enhance-voice" } });
    expect(app.parity).toBe("Runs on open-source models only, on your GPU or CPU. RE-USE isn't hosted on fal or Replicate.");
    expect(getModel("oss-reuse-voice")?.routes).toEqual([expect.objectContaining({ op: "enhance-voice", provider: "comfyui", endpoint: "voice-clean-reuse" })]);
  });

  it("offers a Clean up voice switch on every voice slot", () => {
    const voiceApps = APPS.filter((a) => a.inputs.some((s) => s.key === "audio" && s.label === "Voice audio"));
    expect(voiceApps.length).toBeGreaterThan(0);
    expect(voiceApps.every((a) => a.inputs.find((s) => s.key === "audio")?.cleanVoice)).toBe(true);
  });

  it("names a cleaned file after the original, cutting only a real extension", () => {
    expect(cleanedName("Take 2.wav")).toBe("Take 2 · cleaned");
    expect(cleanedName("Take")).toBe("Take · cleaned");
    expect(cleanedName("interview")).toBe("interview · cleaned");
    expect(cleanedName(undefined)).toBe("Recording · cleaned");
  });

  it("makes Generate wait for a voice that is being cleaned", () => {
    expect(blockerFor({ model: true, uploading: false, cleaning: true, promptMissing: false })).toEqual({ message: "Waiting for the clean voice", quiet: true });
  });

});

describe("the Canvas node", () => {
  it("cleans audio or a video's soundtrack on the open engine, and isn't offered on a cloud-only install", () => {
    expect(NODE_SPECS["clean-voice"]).toMatchObject({ label: "Clean up voice", group: "Utilities", ops: ["enhance-voice"] });
    expect(nodeOps({ type: "clean-voice", data: {} })).toEqual(["enhance-voice"]);
    expect(defaultModelForNode({ type: "clean-voice", data: {} }, "open")?.id).toBe("oss-reuse-voice");
    expect(defaultModelForNode({ type: "clean-voice", data: {} }, "cloud")).toBeUndefined();
    expect(paletteItems("both").some((p) => p.id === "clean-voice")).toBe(true);
    expect(paletteItems("open").find((p) => p.id === "clean-voice")?.disabled).toBeUndefined();
    expect(paletteItems("cloud").some((p) => p.id === "clean-voice")).toBe(false);
  });
});

describe("the Library's Clean up voice", () => {
  const gen = (o: Partial<Generation>, kind: "audio" | "video"): Generation =>
    ({ id: "g1", status: "succeeded", feature: "audio", op: "tts", outputs: [{ url: "/api/files/out/x", kind }], request: {}, createdAt: "", ...o }) as unknown as Generation;
  const has = (g: Generation) => outputActions(g, 0).find((a) => a.id === "clean-voice");

  it("is on speech and on videos with sound, and opens the tool with the file", () => {
    expect(has(gen({ op: "tts" }, "audio"))?.href).toBe("/audio/clean?audio=%2Fapi%2Ffiles%2Fout%2Fx");
    expect(has(gen({ op: "lipsync" }, "video"))).toMatchObject({ label: "Clean up voice", placement: "menu", href: "/audio/clean?video=%2Fapi%2Ffiles%2Fout%2Fx" });
    expect(has(gen({ feature: "upload", op: undefined }, "video"))).toBeTruthy();
  });

  it("isn't on music, sound effects, a silent clip or a voice it already cleaned", () => {
    expect(has(gen({ op: "music" }, "audio"))).toBeUndefined();
    expect(has(gen({ op: "sfx" }, "audio"))).toBeUndefined();
    expect(has(gen({ op: "enhance-voice", feature: "voice-clean" }, "audio"))).toBeUndefined();
    expect(has(gen({ op: "t2v" }, "video"))).toBeUndefined();
  });
});

describe("POST /api/audio-tools clean (demo mode)", () => {
  it("prices a clean as free with an estimate, and runs it into a clean voice in the Library", async () => {
    const media = upload(6);
    const preview = await (await post({ tool: "clean", engine: "open", media, kind: "audio", name: "Take 1" }, true)).json();
    expect(preview).toMatchObject({ steps: 1, costUsd: 0, demo: true, length: 6 });
    expect(preview.summary).toBe("Cleans the recording with RE-USE.");
    const res = await post({ tool: "clean", engine: "open", media, kind: "audio", name: "Take 1" });
    expect(res.status).toBe(201);
    const run = await res.json();
    expect(run.result).toMatchObject({ feature: "voice-clean", modelId: "oss-reuse-voice", provider: "mock", op: "enhance-voice" });
    const g = await finished(run.result.id);
    expect(g.status).toBe("succeeded");
    expect(g.outputs[0]).toMatchObject({ kind: "audio", meta: { stem: "voice" } });
    expect(g.outputs[0].url.startsWith("/api/files/")).toBe(true);
  });

  it("says plainly that the cloud has no clean, and refuses on an install set to paid APIs only", async () => {
    const media = upload(3);
    const cloud = await post({ tool: "clean", engine: "cloud", media, kind: "audio" }, true);
    expect(cloud.status).toBe(422);
    expect((await cloud.json()).error).toBe(CLOUD_CLEAN_PROBLEM);
    setSetting("engineMode", "cloud");
    try {
      expect((await (await post({ tool: "clean", engine: "open", media, kind: "audio" })).json()).error).toBe(CLOUD_ONLY_CLEAN_PROBLEM);
    } finally {
      setSetting("engineMode", "both");
    }
    expect((await (await post({ tool: "clean", engine: "open", media: "/etc/passwd", kind: "audio" })).json()).error).toBe("Add the audio or video to clean");
  });

  it("refuses a file with no sound before anything is queued", async () => {
    const silent = saveFile({ data: fs.readFileSync(path.join(__dirname, "fixtures", "shorts-silent.webm")), contentType: "video/webm", name: "silent.webm", source: "upload" }).url;
    const res = await post({ tool: "clean", engine: "open", media: silent, kind: "video" }, true);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("This video has no sound to clean");
  });
});
