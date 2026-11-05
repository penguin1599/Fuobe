import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Generation, GenerationRequest } from "@/lib/catalog/types";
import { tempDir } from "./helpers/temp-dir";

vi.mock("@/lib/catalog", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/catalog")>();
  const { ROUND3_FIXTURES } = await import("./fixtures/round3-models");
  const { ROUND4_FIXTURES } = await import("./fixtures/round4-models");
  const fixtures = [...ROUND3_FIXTURES, ...ROUND4_FIXTURES];
  return { ...mod, MODELS: [...mod.MODELS, ...fixtures], getModel: (id: string) => fixtures.find((m) => m.id === id) ?? mod.getModel(id) };
});
vi.setConfig({ testTimeout: 60_000 });

const dir = tempDir("fuobe-demo-ops-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";
process.env.OLLAMA_URL = "http://127.0.0.1:9";

const { setSetting } = await import("@/server/settings");
const gens = await import("@/server/generations");
const { contentTypeFor, kindFor, saveFile } = await import("@/server/storage");
const files = await import("@/app/api/files/[...path]/route");

beforeAll(() => setSetting("demoMode", "auto"));

async function settle(id: string, ms = 40_000): Promise<Generation> {
  const end = Date.now() + ms;
  for (;;) {
    const g = gens.getGeneration(id)!;
    if (["succeeded", "failed", "canceled"].includes(g.status)) return g;
    if (Date.now() > end) throw new Error(`timed out: ${g.status} ${g.message}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f0005000201a2e2b6a40000000049454e44ae426082", "hex");

async function serve(url: string, download?: string) {
  const parts = url.replace(/^\/api\/files\//, "").split("/");
  return files.GET(new Request(`http://localhost${url}${download ? `?download=${download}` : ""}`), { params: Promise.resolve({ path: parts }) } as never);
}

/** Reads a GLB and checks it against the glTF 2.0 binary layout. */
function checkGlb(buf: Buffer) {
  expect(buf.readUInt32LE(0)).toBe(0x46546c67);
  expect(buf.readUInt32LE(4)).toBe(2);
  expect(buf.readUInt32LE(8)).toBe(buf.length);
  const jsonLen = buf.readUInt32LE(12);
  expect(buf.readUInt32LE(16)).toBe(0x4e4f534a);
  expect(jsonLen % 4).toBe(0);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8").trimEnd());
  const binAt = 20 + jsonLen;
  const binLen = buf.readUInt32LE(binAt);
  expect(buf.readUInt32LE(binAt + 4)).toBe(0x004e4942);
  expect(gltf.asset.version).toBe("2.0");
  expect(gltf.buffers[0].byteLength).toBe(binLen);
  const size = { SCALAR: 1, VEC3: 3, VEC4: 4 } as Record<string, number>;
  const bytes = { 5126: 4, 5123: 2 } as Record<number, number>;
  for (const a of gltf.accessors) {
    const v = gltf.bufferViews[a.bufferView];
    expect(v.byteOffset + v.byteLength).toBeLessThanOrEqual(binLen);
    expect(a.count * size[a.type] * bytes[a.componentType]).toBe(v.byteLength);
    expect(v.byteOffset % bytes[a.componentType]).toBe(0);
  }
  const prim = gltf.meshes[0].primitives[0];
  expect(gltf.accessors[prim.attributes.POSITION].min).toHaveLength(3);
  expect(gltf.accessors[prim.indices].count % 3).toBe(0);
}

describe("storage", () => {
  it("knows text and 3D files", () => {
    expect(kindFor("text/plain")).toBe("text");
    expect(kindFor("application/json")).toBe("text");
    expect(kindFor("application/x-subrip")).toBe("text");
    expect(kindFor("text/plain; charset=utf-8")).toBe("text");
    expect(kindFor("model/gltf-binary")).toBe("model3d");
    expect(kindFor("image/png")).toBe("image");
    expect(contentTypeFor("a.srt")).toBe("application/x-subrip");
    expect(contentTypeFor("a.glb")).toBe("model/gltf-binary");
    expect(saveFile({ data: Buffer.from("hi"), contentType: "text/plain", source: "generation" }).url).toMatch(/\.txt$/);
    expect(saveFile({ data: Buffer.from("[]"), contentType: "application/json", source: "generation" }).kind).toBe("text");
  });

  it("ships a valid demo .glb", () => {
    checkGlb(fs.readFileSync(path.join(process.cwd(), "public/samples/demo-model.glb")));
  });
});

describe("demo outputs for every new operation", () => {
  it("gives layers, text, stems, clips and 3D the extras real providers return", async () => {
    const image = saveFile({ data: png, contentType: "image/png", source: "upload" }).url;
    const video = saveFile({ data: fs.readFileSync(path.join(process.cwd(), "public/samples/demo-square.mp4")), contentType: "video/mp4", source: "upload" }).url;
    const audio = saveFile({ data: Buffer.from("RIFF0000WAVEfmt "), contentType: "audio/wav", source: "upload" }).url;
    const reqs: Record<string, GenerationRequest> = {
      layers: { feature: "layers", modelId: "test-layers", prompt: "Summer sale poster", inputs: { images: [image] }, params: { numLayers: 4 } },
      textLayers: { feature: "layers", modelId: "test-text-layers", prompt: "Big summer sale", inputs: { images: [image] } },
      trim: { feature: "shorts", modelId: "test-trim", prompt: "trim", inputs: { video: video }, params: { startTime: 1, endTime: 3, aspectRatio: "9:16" } },
      captions: { feature: "captions", modelId: "test-captions", prompt: "captions", inputs: { video: video } },
      mux: { feature: "dub", modelId: "test-mux", prompt: "mux", inputs: { video: video, audio: audio } },
      transcribe: { feature: "dub", modelId: "test-transcribe", prompt: "transcribe", inputs: { video: video } },
      separate: { feature: "dub", modelId: "test-separate", prompt: "separate", inputs: { video: video } },
      model: { feature: "3d", modelId: "test-3d", prompt: "a ceramic vase", inputs: { images: [image] } },
    };
    const started = Object.fromEntries(Object.entries(reqs).map(([k, r]) => [k, gens.createGenerations(r)[0]]));
    expect(started.transcribe.kind).toBe("text");
    expect(started.model.kind).toBe("model3d");
    const done = Object.fromEntries(await Promise.all(Object.entries(started).map(async ([k, g]) => [k, await settle(g.id)] as const)));
    for (const [k, g] of Object.entries(done)) expect(g.status, `${k}: ${g.error}`).toBe("succeeded");

    const layers = done.layers.outputs;
    expect(layers.length).toBeGreaterThanOrEqual(3);
    expect(layers.length).toBeLessThanOrEqual(4);
    expect(layers.map((l) => l.meta?.z)).toEqual(layers.map((_, i) => i));
    for (const l of layers) {
      expect(l).toMatchObject({ kind: "image", contentType: "image/svg+xml" });
      expect(l.meta).toMatchObject({ name: expect.any(String), bbox: [expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number)] });
    }
    expect(done.textLayers.outputs[0].meta?.textBlocks).toEqual(expect.arrayContaining([expect.objectContaining({ text: "BIG SUMMER SALE", bbox: expect.any(Array) })]));

    for (const k of ["trim", "captions", "mux"]) expect(done[k].outputs[0]).toMatchObject({ kind: "video", contentType: "video/mp4", meta: { demo: true } });

    const t = done.transcribe.outputs[0];
    expect(t).toMatchObject({ kind: "text", contentType: "application/x-subrip" });
    expect((t.meta?.cues as unknown[]).length).toBeGreaterThan(2);
    expect(t.text).toContain("This is a demo transcript.");
    const served = await serve(t.url, "transcript.srt");
    expect(served.headers.get("content-type")).toBe("application/x-subrip; charset=utf-8");
    expect(served.headers.get("content-disposition")).toBe('attachment; filename="transcript.srt"');
    expect(await served.text()).toMatch(/^1\n00:00:00,000 --> 00:00:02,300\nThis is a demo transcript\./);

    expect(done.separate.outputs.map((o) => [o.kind, o.meta?.stem])).toEqual([
      ["audio", "voice"],
      ["audio", "background"],
    ]);

    const [glb, turntable] = done.model.outputs;
    expect(glb).toMatchObject({ kind: "model3d", contentType: "model/gltf-binary" });
    expect(glb.url).toMatch(/\.glb$/);
    expect(turntable).toMatchObject({ kind: "video", meta: { turntable: true } });
    const res = await serve(glb.url, "vase.glb");
    expect(res.headers.get("content-type")).toBe("model/gltf-binary");
    checkGlb(Buffer.from(await res.arrayBuffer()));
  });
});

describe("demo outputs for the round-4 operations", () => {
  it("gives clips, OCR lines, longer tones, meshes and numbered frames", async () => {
    const image = saveFile({ data: png, contentType: "image/png", source: "upload" }).url;
    const image2 = saveFile({ data: png, contentType: "image/png", source: "upload" }).url;
    const video = saveFile({ data: fs.readFileSync(path.join(process.cwd(), "public/samples/demo-square.mp4")), contentType: "video/mp4", source: "upload" }).url;
    const audio = saveFile({ data: Buffer.from("RIFF0000WAVEfmt "), contentType: "audio/wav", source: "upload" }).url;
    const glb = saveFile({ data: fs.readFileSync(path.join(process.cwd(), "public/samples/demo-model.glb")), contentType: "model/gltf-binary", source: "upload" }).url;
    const req = (op: string, r: Omit<GenerationRequest, "feature" | "modelId">): GenerationRequest => ({ feature: "tools", modelId: `test4-${op}`, ...r });
    const reqs: Record<string, GenerationRequest> = {
      "remove-object": req("remove-object", { prompt: "the coffee cup", inputs: { video } }),
      "video-swap": req("video-swap", { prompt: "swap the car for the red one", inputs: { video, images: [image] } }),
      "video-insert": req("video-insert", { prompt: "put the lamp on the table", inputs: { video, images: [image] } }),
      keyframes: req("keyframes", { prompt: "she puts on the hat", inputs: { images: [image, image2] }, params: { keyframeTimes: [0, 4], duration: 5 } }),
      "sdr-to-hdr": req("sdr-to-hdr", { inputs: { video }, params: { format: "h265_10bit" } }),
      "export-video": req("export-video", { inputs: { video }, params: { format: "prores_422_hq" } }),
      ocr: req("ocr", { inputs: { images: [image] } }),
      "still-motion": req("still-motion", { inputs: { images: [image] }, params: { zoomFrom: 1, zoomTo: 1.2, duration: 5 } }),
      "audio-loop": req("audio-loop", { inputs: { audio }, params: { duration: 20, crossfade: 1 } }),
      "audio-join": req("audio-join", { inputs: { audios: [audio, audio, audio] }, params: { crossfade: 0.5 } }),
      "scene-3d": req("scene-3d", { inputs: { images: [image] } }),
      splat: req("splat", { inputs: { images: [image] } }),
      "text-to-3d": req("text-to-3d", { prompt: "a brass lantern" }),
      "rig-3d": req("rig-3d", { inputs: { model3d: glb }, params: { animation: 12 } }),
      "extract-frames": req("extract-frames", { inputs: { video }, params: { frameInterval: 2 } }),
      "images-to-video": req("images-to-video", { inputs: { images: [image, image2] }, params: { fps: 12 } }),
      overlay: req("overlay", { inputs: { images: [image, image2] }, params: { position: { x: 0.5, y: 0.8 }, scale: 0.5 } }),
    };
    const started = Object.fromEntries(Object.entries(reqs).map(([k, r]) => [k, gens.createGenerations(r)[0]]));
    expect(started.ocr.kind).toBe("text");
    expect(started.splat.kind).toBe("model3d");
    expect(started["extract-frames"].kind).toBe("image");
    const done = Object.fromEntries(await Promise.all(Object.entries(started).map(async ([k, g]) => [k, await settle(g.id)] as const)));
    for (const [k, g] of Object.entries(done)) {
      expect(g.status, `${k}: ${g.error}`).toBe("succeeded");
      expect(g.op, k).toBe(k);
    }

    for (const k of ["remove-object", "video-swap", "video-insert", "keyframes", "sdr-to-hdr", "export-video", "still-motion", "images-to-video"]) {
      expect(done[k].outputs, k).toHaveLength(1);
      expect(done[k].outputs[0], k).toMatchObject({ kind: "video", contentType: "video/mp4", meta: { demo: true } });
    }
    expect(done["sdr-to-hdr"].outputs[0].meta?.format).toBe("h265_10bit");
    expect(done["export-video"].outputs[0].meta?.format).toBe("prores_422_hq");

    const ocr = done.ocr.outputs[0];
    expect(ocr).toMatchObject({ kind: "text", contentType: "text/plain" });
    const lines = ocr.meta?.lines as { text: string; bbox: number[] }[];
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(ocr.text).toBe(lines.map((l) => l.text).join("\n"));
    for (const l of lines) {
      expect(l.bbox).toHaveLength(4);
      for (const n of l.bbox) expect(n >= 0 && n <= 1).toBe(true);
    }

    // The loop is as long as asked (20 s), longer than the 3 s demo tone; a join is a track too.
    const wavSeconds = async (url: string) => {
      const buf = Buffer.from(await (await serve(url)).arrayBuffer());
      return buf.readUInt32LE(40) / buf.readUInt32LE(28);
    };
    expect(done["audio-loop"].outputs[0]).toMatchObject({ kind: "audio", contentType: "audio/wav" });
    expect(await wavSeconds(done["audio-loop"].outputs[0].url)).toBeCloseTo(20, 1);
    expect(await wavSeconds(done["audio-join"].outputs[0].url)).toBeCloseTo(9, 1);

    for (const k of ["scene-3d", "text-to-3d", "rig-3d"]) {
      const m = done[k].outputs.find((o) => o.kind === "model3d");
      expect(m, k).toMatchObject({ contentType: "model/gltf-binary" });
      expect(m!.url, k).toMatch(/\.glb$/);
    }
    expect(done["rig-3d"].outputs[0].meta?.rigged).toBe(true);
    checkGlb(Buffer.from(await (await serve(done["rig-3d"].outputs[0].url)).arrayBuffer()));
    // A cloud splat is a real .ply (the splat viewer draws it in demo mode), like fal's TripoSplat.
    expect(done.splat.outputs).toEqual([expect.objectContaining({ kind: "model3d", contentType: "model/ply", meta: expect.objectContaining({ format: "ply" }) })]);
    expect(done.splat.outputs[0].url).toMatch(/\.ply$/);
    const ply = Buffer.from(await (await serve(done.splat.outputs[0].url)).arrayBuffer());
    expect(ply.subarray(0, 4).toString("ascii")).toBe("ply\n");

    const frames = done["extract-frames"].outputs;
    expect(frames.map((f) => [f.kind, f.meta?.index])).toEqual([0, 1, 2, 3].map((i) => ["image", i]));
    expect(done.overlay.outputs).toEqual([expect.objectContaining({ kind: "image", contentType: "image/svg+xml" })]);
  });

  it("gives an open-engine splat an .spz with its orbit video, as the TripoSplat and Idol 3D graphs write", async () => {
    const image = saveFile({ data: png, contentType: "image/png", source: "upload" }).url;
    for (const modelId of ["oss-triposplat", "oss-idol"]) {
      const [g] = gens.createGenerations({ feature: "image-to-3d", modelId, op: "splat", inputs: { images: [image] } });
      expect(g.kind, modelId).toBe("model3d");
      const done = await settle(g.id);
      expect(done.status, `${modelId}: ${done.error}`).toBe("succeeded");
      const splat = done.outputs.find((o) => o.kind === "model3d");
      expect(splat, modelId).toMatchObject({ contentType: "model/x-spz", meta: expect.objectContaining({ format: "spz", role: "splat" }) });
      expect(splat!.url, modelId).toMatch(/\.spz$/);
      expect(done.outputs.find((o) => o.kind === "video"), modelId).toMatchObject({ contentType: "video/mp4", meta: expect.objectContaining({ turntable: true }) });
      // Niantic's .spz is gzip.
      const spz = Buffer.from(await (await serve(splat!.url)).arrayBuffer());
      expect([spz[0], spz[1]], modelId).toEqual([0x1f, 0x8b]);
    }
  });
});
