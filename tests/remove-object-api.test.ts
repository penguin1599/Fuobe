import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Generation } from "@/lib/catalog/types";
import { tempDir } from "./helpers/temp-dir";

vi.setConfig({ testTimeout: 120_000 });

// /api/remove-object end to end in demo mode (no keys, no ComfyUI): every way of pointing on both engines
// becomes one pipeline of ordinary generations, which the mock provider runs through.
const dir = tempDir("fuobe-remove-object-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";
process.env.OLLAMA_URL = "http://127.0.0.1:9";

const { setSetting } = await import("@/server/settings");
const gens = await import("@/server/generations");
const { saveFile } = await import("@/server/storage");
const { encodePng } = await import("@/server/png");
const { db } = await import("@/server/db");
const createRoute = await import("@/app/api/remove-object/route");
const estimateRoute = await import("@/app/api/remove-object/estimate/route");
const previewRoute = await import("@/app/api/remove-object/preview/route");
const { CLICK_OPEN_PROBLEM, REMOVE } = await import("@/lib/catalog/remove-object");

const json = (body?: unknown) => new Request("http://x/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let clip = "";
let mask = "";
beforeAll(() => {
  setSetting("demoMode", "auto");
  // A 12 s, 16 fps, 72×128 clip with a sound track.
  clip = saveFile({ data: fs.readFileSync(path.join(__dirname, "fixtures/shorts-12s.mp4")), contentType: "video/mp4", source: "upload", name: "skate.mp4" }).url;
  // The first frame painted where the skateboard is (white = remove).
  const data = Buffer.alloc(72 * 128 * 4);
  for (let y = 0; y < 128; y++)
    for (let x = 0; x < 72; x++) {
      const at = (y * 72 + x) * 4;
      data.fill(x >= 20 && x < 50 && y >= 80 && y < 110 ? 255 : 0, at, at + 3);
      data[at + 3] = 255;
    }
  mask = saveFile({ data: encodePng({ width: 72, height: 128, data }), contentType: "image/png", source: "upload", name: "mask.png" }).url;
});

async function settle(id: string, ms = 90_000): Promise<Generation> {
  const end = Date.now() + ms;
  for (;;) {
    const g = gens.getGeneration(id)!;
    if (["succeeded", "failed", "canceled"].includes(g.status)) return g;
    if (Date.now() > end) throw new Error(`timed out: ${g.status} ${g.message}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Wait until a step has been handed its chained inputs (it left "Waits for the earlier steps"). */
async function launched(id: string, ms = 60_000): Promise<Generation> {
  const end = Date.now() + ms;
  for (;;) {
    const g = gens.getGeneration(id)!;
    if (g.status === "failed" || g.status === "canceled") throw new Error(`${g.id} ${g.status}: ${g.error}`);
    if (!/Waits for/.test(g.message ?? "")) return g;
    if (Date.now() > end) throw new Error(`timed out: ${g.status} ${g.message}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

const batchOf = (id: string) => {
  const b = (db().prepare("SELECT batch_id FROM generations WHERE id = ?").get(id) as { batch_id: string }).batch_id;
  return db().prepare("SELECT id, model_id, op, feature, depends_on, request_json FROM generations WHERE batch_id = ? ORDER BY created_at, id").all(b) as {
    id: string;
    model_id: string;
    op: string;
    feature: string;
    depends_on: string | null;
    request_json: string;
  }[];
};

const body = (over: Record<string, unknown> = {}) => ({ engine: "cloud", mode: "type", prompt: "the skateboard", source: { url: clip, name: "skate.mp4" }, ...over });

describe("Remove object: estimates", () => {
  // Estimates submit nothing: a fal key makes the routes real, so the prices are the providers' own.
  beforeAll(() => setSetting("falKey", "fal-test-key"));
  afterAll(() => setSetting("falKey", ""));

  it("prices the pieces before anything runs, with what happens in words", async () => {
    const res = await estimateRoute.POST(json(body({ modelId: "bria-video-erase", source: { url: clip, duration: 12, fps: 16, width: 72, height: 128, hasAudio: true } })));
    expect(res.status).toBe(200);
    const e = await res.json();
    expect(e).toMatchObject({ modelId: "bria-video-erase", modelName: "Bria Video Eraser", pieces: 3, seconds: 12, demo: false });
    // 3 cuts + 3 erasures + a join + the sound.
    expect(e.steps).toBe(8);
    // Bria at $0.14/s for 12 s, plus the cuts, join and mux.
    expect(e.costUsd).toBeGreaterThanOrEqual(1.68);
    expect(e.costUsd).toBeLessThan(1.7);
    expect(e.notes.join(" ")).toMatch(/cut into 3 pieces/);
    expect(e.notes.join(" ")).not.toMatch(/tested/i);
    expect(e.previewUsd).toBeGreaterThan(0);
    // Bria finds the object by name itself: the preview is only SAM 3.1's reading of the words.
    expect(e.previewExact).toBe(false);
  });

  it("says whether the mask preview is what the eraser works from", async () => {
    const src = { url: clip, duration: 12, fps: 16, width: 1280, height: 720, hasAudio: true };
    const kling = await (await estimateRoute.POST(json(body({ source: { ...src, duration: 10 } })))).json();
    expect(kling).toMatchObject({ modelId: "kling-o3", previewExact: false });
    const voidE = await (await estimateRoute.POST(json(body({ effects: true, source: src, range: { start: 0, end: 8 } })))).json();
    expect(voidE).toMatchObject({ modelId: "void-video-inpainting", previewExact: true });
    const paint = await (await estimateRoute.POST(json(body({ mode: "paint", mask: "/api/files/m.png", source: src })))).json();
    expect(paint).toMatchObject({ modelId: "bria-video-erase-mask", previewExact: true });
    const open = await (await estimateRoute.POST(json(body({ engine: "open", source: src })))).json();
    expect(open).toMatchObject({ modelId: "oss-vace-remove", previewExact: true });
  });

  it("prices LTX Clean Plate per megapixel of each 720p piece, and VOID per piece of exact frames", async () => {
    const src = { url: clip, duration: 12, fps: 30, width: 1920, height: 1080, hasAudio: true };
    const ltx = await (await estimateRoute.POST(json(body({ modelId: "ltx-2-3-clean-plate", prompt: undefined, source: src })))).json();
    // 360 frames → pieces of 121, 121 and 113 frames at 1280×720: 112 + 112 + 105 MP at $0.0024075 (rounded up per piece).
    expect(ltx).toMatchObject({ modelId: "ltx-2-3-clean-plate", pieces: 3 });
    const erase = (112 + 112 + 105) * 0.0024075;
    expect(ltx.costUsd).toBeGreaterThanOrEqual(erase);
    expect(ltx.costUsd).toBeLessThan(erase + 0.05);
    expect(ltx.notes.join(" ")).toMatch(/up to 137 frames/);
    const voidE = await (await estimateRoute.POST(json(body({ effects: true, source: { ...src, duration: 10 } })))).json();
    expect(voidE).toMatchObject({ modelId: "void-video-inpainting", pieces: 2 });
    // The last 2 frames of 300 don't fit VOID's 8-frame steps: said, not hidden.
    expect(voidE.notes.join(" ")).toMatch(/last 2 frames \(0\.07 s\) are left out/);
    const short = await estimateRoute.POST(json(body({ effects: true, source: { ...src, duration: 2 } })));
    expect(short.status).toBe(422);
    expect((await short.json()).error).toMatch(/at least 69 frames/);
  });

  it("prices Kling O3 edit at its edit price, and refuses clips it can't take", async () => {
    const big = { url: clip, duration: 10, fps: 24, width: 1280, height: 720, hasAudio: true };
    const e = await (await estimateRoute.POST(json(body({ source: big })))).json();
    expect(e).toMatchObject({ modelId: "kling-o3", pieces: 1 });
    expect(e.costUsd).toBeCloseTo(1.68, 3);
    const small = await estimateRoute.POST(json(body({ source: { ...big, width: 72, height: 128 } })));
    expect(small.status).toBe(422);
    expect((await small.json()).error).toMatch(/720 px on each side/);
  });

  it("open engine: free, in windows, with the GPU said", async () => {
    const e = await (await estimateRoute.POST(json(body({ engine: "open", source: { url: clip, duration: 12, fps: 16, width: 72, height: 128, hasAudio: true } })))).json();
    expect(e).toMatchObject({ modelId: "oss-vace-remove", pieces: 3, costUsd: 0 });
    expect(e.notes.join(" ")).toMatch(/81 frames at a time/);
    expect(e.notes.join(" ")).toMatch(/runs as 3 windows/);
    expect(e.notes.join(" ")).toMatch(/24 GB GPU/);
    // Painted windows overlap by a frame: 162 frames take three windows, and the note counts what runs.
    const painted = await (await estimateRoute.POST(json(body({ engine: "open", mode: "paint", mask: "/api/files/m.png", source: { url: clip, duration: 6, fps: 27 } })))).json();
    expect(painted).toMatchObject({ modelId: "oss-vace-remove-painted", pieces: 3 });
    expect(painted.notes.join(" ")).toMatch(/runs as 3 windows/);
    expect(painted.notes.join(" ")).not.toMatch(/tested/i);
    const effects = await (await estimateRoute.POST(json(body({ engine: "open", effects: true, source: { url: clip, duration: 12, fps: 16 } })))).json();
    expect(effects.modelId).toBe("oss-void-remove");
    expect(effects.notes.join(" ")).toMatch(/VOID needs a 24–40 GB GPU/);
    expect(effects.notes.join(" ")).not.toMatch(/licen[cs]e/i);
  });

  it("open engine, H3 person removal: the clean first frame, H3 Relay and the GPU said; the LoRA switched off refuses", async () => {
    const h3 = (over: Record<string, unknown> = {}) => estimateRoute.POST(json(body({ engine: "open", modelId: "oss-h3-person-remove", prompt: "the skater", source: { url: clip, duration: 12, fps: 16, width: 72, height: 128, hasAudio: true }, ...over })));
    const e = await (await h3()).json();
    expect(e).toMatchObject({ modelId: "oss-h3-person-remove", pieces: 1, costUsd: 0 });
    const notes = e.notes.join(" ");
    expect(notes).toMatch(/clean copy of the part's first frame with the person gone/);
    expect(notes).toMatch(/Needs the H3 Relay nodes on your ComfyUI and 24 GB of VRAM/);
    expect(notes).not.toMatch(/H3_RELAY|scripts\/|install-comfyui|tested/);
    expect(notes).toMatch(/People only/);
    expect(notes).not.toMatch(/licen[cs]e/i);
    expect((await (await h3({ prompt: " " })).json()).error).toMatch(/Say who to remove/);
    const { changeAccess } = await import("@/server/model-access");
    changeAccess([{ kind: "lora", id: "H3-Person-Remover-V1.safetensors", on: false }]);
    const off = await h3();
    expect(off.status).toBe(422);
    expect((await off.json()).error).toMatch(/Person Remover LoRA is switched off in Settings → Models & licences/);
    changeAccess([{ kind: "reset" }]);
  });

  it("says what's missing", async () => {
    const click = await estimateRoute.POST(json(body({ engine: "open", mode: "click", source: { url: clip, duration: 12, fps: 16 } })));
    expect(click.status).toBe(422);
    expect((await click.json()).error).toBe(CLICK_OPEN_PROBLEM);
    const words = await estimateRoute.POST(json(body({ prompt: " ", modelId: "bria-video-erase", source: { url: clip, duration: 12, fps: 16 } })));
    expect((await words.json()).error).toMatch(/Say what to remove/);
    const points = await estimateRoute.POST(json(body({ mode: "click", points: [{ x: 3, y: 3, label: "negative" }], source: { url: clip, duration: 12, fps: 16 } })));
    expect((await points.json()).error).toMatch(/Click what to remove/);
    // Kling O3 edit's 2500 characters include its template: longer words are refused before anything runs.
    const long = await estimateRoute.POST(json(body({ prompt: "the cup ".repeat(301), source: { url: clip, duration: 10, fps: 24, width: 1280, height: 720 } })));
    expect(long.status).toBe(422);
    expect((await long.json()).error).toMatch(new RegExp(`up to ${REMOVE.maxPromptChars} characters`));
    setSetting("engineMode", "open");
    const cloud = await estimateRoute.POST(json(body({ source: { url: clip, duration: 12, fps: 16 } })));
    expect((await cloud.json()).error).toMatch(/open-source models only/);
    setSetting("engineMode", "both");
  });
});

describe("Remove object: runs", () => {
  it("Type it on Bria: a 12 s clip is cut, erased and joined, and the clip's sound put back", async () => {
    const res = await createRoute.POST(json(body({ modelId: "bria-video-erase", requestId: "type-bria-0001" })));
    expect(res.status).toBe(201);
    const { final, items } = (await res.json()) as { final: Generation; items: Generation[] };
    expect(items).toHaveLength(8);
    expect(final).toMatchObject({ feature: REMOVE.feature, op: "mux", modelId: "merge-audio-video" });
    expect(final.request.title).toMatch(/^Remove · the skateboard · skate/);
    expect(items.filter((g) => g.feature === REMOVE.stepFeature)).toHaveLength(7);
    // A repeated request id gets the first run, not a second one.
    const again = (await (await createRoute.POST(json(body({ modelId: "bria-video-erase", requestId: "type-bria-0001" })))).json()) as { final: Generation };
    expect(again.final.id).toBe(final.id);
  });

  it("Click it, longer than 5 s: SAM 3.1 tracks the clicks (scaled to the clip), Bria erases each piece's mask", async () => {
    const points = [{ x: 72, y: 190, label: "positive" }];
    const res = await createRoute.POST(json(body({ mode: "click", prompt: undefined, points, frame: { width: 144, height: 256 } })));
    const { final } = (await res.json()) as { final: Generation };
    const rows = batchOf(final.id);
    const track = rows.find((r) => r.model_id === "sam-3-1-video-mask")!;
    expect(JSON.parse(track.request_json).params.points).toEqual([{ x: 36, y: 95, label: "positive" }]);
    const erasers = rows.filter((r) => r.op === "remove-object");
    expect(erasers.map((r) => r.model_id)).toEqual(["bria-video-erase-mask", "bria-video-erase-mask", "bria-video-erase-mask"]);
    for (const r of erasers) expect(JSON.parse(r.request_json).chain).toEqual([{ slot: "video" }, { slot: "mask" }]);
    // The cut track and the cut clip reach each eraser (cut ∥ track, then the track's cut).
    for (const r of erasers) {
      const g = await launched(r.id);
      expect(g.request.inputs?.mask).toMatch(/^\/api\/files\//);
      expect(g.request.inputs?.video).toMatch(/^\/api\/files\//);
      expect(g.request.inputs?.mask).not.toBe(g.request.inputs?.video);
    }
  });

  it("Paint it on the cloud: points found in the paint start the SAM 3.1 track", async () => {
    const res = await createRoute.POST(json(body({ mode: "paint", prompt: undefined, mask, source: { url: clip }, range: { start: 0, end: 4 } })));
    const { final } = (await res.json()) as { final: Generation };
    const rows = batchOf(final.id);
    expect(rows.map((r) => r.model_id).sort()).toEqual(["bria-video-erase-mask", "sam-3-1-video-mask", "trim-video"]);
    const p = JSON.parse(rows.find((r) => r.model_id === "sam-3-1-video-mask")!.request_json).params.points as { x: number; y: number }[];
    expect(p.length).toBeGreaterThan(0);
    for (const q of p) {
      expect(q.x).toBeGreaterThanOrEqual(20);
      expect(q.x).toBeLessThan(50);
      expect(q.y).toBeGreaterThanOrEqual(80);
      expect(q.y).toBeLessThan(110);
    }
  });

  it("open engine, Paint it: windows chained by the tracked mask, joined, the sound put back", async () => {
    const res = await createRoute.POST(json(body({ engine: "open", mode: "paint", prompt: undefined, mask })));
    expect(res.status).toBe(201);
    const { final } = (await res.json()) as { final: Generation };
    const rows = batchOf(final.id);
    const windows = rows.filter((r) => r.op === "remove-object").sort((a, b) => JSON.parse(a.request_json).step.index - JSON.parse(b.request_json).step.index);
    expect(windows).toHaveLength(3);
    expect(JSON.parse(windows[0].request_json).inputs.mask).toBe(mask);
    expect(windows[1].depends_on).toBe(windows[0].id);
    expect(JSON.parse(windows[2].request_json).chain).toEqual([{ slot: "mask" }]);
    expect(rows.map((r) => r.model_id)).toEqual(expect.arrayContaining(["oss-join-clips", "oss-mux"]));
    // The later windows start on the frame their mask was tracked on, and lose it again before the join.
    expect(rows.filter((r) => r.model_id === "oss-trim")).toHaveLength(2);
    // The first window's last tracked frame starts the second one.
    const second = await launched(windows[1].id);
    expect(second.request.inputs?.mask).toMatch(/^\/api\/files\//);
    expect(second.request.inputs?.mask).not.toBe(mask);
    // …the mask image the window saved (meta.role "mask"), not its video.
    expect(second.request.inputs?.mask).toMatch(/\.svg$/);
  });

  it("open engine, Paint it, one window: the result is the video alone (no hand-off mask)", async () => {
    const res = await createRoute.POST(json(body({ engine: "open", mode: "paint", prompt: undefined, mask, range: { start: 0, end: 3 } })));
    const { final, items } = (await res.json()) as { final: Generation; items: Generation[] };
    expect(items).toHaveLength(1);
    expect(final).toMatchObject({ modelId: "oss-vace-remove-painted", feature: REMOVE.feature });
    const done = await settle(final.id);
    expect(done.status).toBe("succeeded");
    expect(done.outputs.map((o) => o.kind)).toEqual(["video"]);
  });

  it("open engine, Type it, one window: the eraser's own result is the video", async () => {
    const res = await createRoute.POST(json(body({ engine: "open", range: { start: 0, end: 3 } })));
    const { final, items } = (await res.json()) as { final: Generation; items: Generation[] };
    expect(items).toHaveLength(1);
    expect(final).toMatchObject({ modelId: "oss-vace-remove", feature: REMOVE.feature });
    // 3 s at 16 fps is 48 frames: the window is the largest 4n+1, 45 frames (2.8125 s).
    expect(final.request.params).toMatchObject({ startTime: 0, endTime: 2.8125 });
  });

  it("open engine, H3 person removal: fit, first frame, clean frame, H3 removal, then the sound put back", async () => {
    const res = await createRoute.POST(json(body({ engine: "open", modelId: "oss-h3-person-remove", prompt: "the skater", range: { start: 1, end: 7 } })));
    const out = (await res.json()) as { final: Generation; items: Generation[] };
    expect(res.status).toBe(201);
    const rows = batchOf(out.final.id);
    expect(rows.map((r) => r.model_id)).toEqual(expect.arrayContaining(["oss-fit-clip", "oss-extract-frame", "oss-qwen-image-21", "oss-h3-person-remove", "oss-trim", "oss-mux"]));
    expect(out.final).toMatchObject({ modelId: "oss-mux", feature: REMOVE.feature });
    expect((await settle(out.final.id)).status).toBe("succeeded");
    const removal = gens.getGeneration(rows.find((r) => r.model_id === "oss-h3-person-remove")!.id)!;
    const clean = gens.getGeneration(rows.find((r) => r.model_id === "oss-qwen-image-21")!.id)!;
    const fit = gens.getGeneration(rows.find((r) => r.model_id === "oss-fit-clip")!.id)!;
    // The removal read the fitted part and the clean first frame the steps before it made.
    expect(removal.request.inputs?.video).toBe(fit.outputs[0].url);
    expect(removal.request.inputs?.images).toEqual([clean.outputs[0].url]);
    expect(removal.request.prompt).toBe("the skater");
  });

  it("mask preview: SAM 3.1 on the first 2 s (cloud), the SAM 3 matte (open)", async () => {
    const cloud = (await (await previewRoute.POST(json(body({ requestId: "preview-cloud-1" })))).json()) as Generation;
    expect(cloud).toMatchObject({ feature: REMOVE.previewFeature, modelId: "sam-3-1-video-mask", op: "bg-remove-video", prompt: "the skateboard" });
    expect(cloud.request.params?.duration).toBe(2);
    const open = (await (await previewRoute.POST(json(body({ engine: "open" })))).json()) as Generation;
    expect(open.modelId).toBe("oss-video-matte-sam3");
    // White = what goes, like the cloud's mask video: the graph saves only its matte.
    expect(open.request.params?.matteOutput).toBe("matte");
    const none = await previewRoute.POST(json(body({ engine: "open", mode: "paint", mask })));
    expect(none.status).toBe(422);
    expect((await settle(cloud.id)).status).toBe("succeeded");
  });
});
