import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { GenInput, ModelDef } from "@/lib/catalog/types";
import type { Manifest } from "@/lib/comfy";
import { H3_GPU_TIER } from "@/lib/gpu/h3-tier";
import { tempDir } from "./helpers/temp-dir";

// MiniMax H3 as an open video model (text, image and start + end frame to video with sound), the Video studio's first
// model on both engines, the hosted H3's prices, and the studio defaults that changed with it.
const dir = tempDir("fuobe-open-h3-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9"; // nothing listens here: open runs fall back to the demo

const { setSetting } = await import("@/server/settings");
const { createGenerations, getGeneration } = await import("@/server/generations");
const { saveFile } = await import("@/server/storage");
const { encodePng } = await import("@/server/png");
const { mockProvider } = await import("@/server/providers/mock");
const { prepareWorkflow } = await import("@/server/providers/comfyui");
const { getModel, getPreset, MODELS } = await import("@/lib/catalog");
const { onEngine } = await import("@/lib/catalog/engines");
const { estimateCost, planGeneration } = await import("@/lib/catalog/plan");
const { filterModels, studioBest } = await import("@/lib/composer");
const { H3_BEST_GRAPH, PRODUCT_SHOT_GRAPH, resolveWorkflowId } = await import("@/lib/comfy-variants");
const { h3Frames } = await import("@/lib/h3-prompt");
const { HOME_NEW_OPEN, newOpenModels } = await import("@/lib/home-showcase");
const { IMAGE_STUDIO, REFRAME_STUDIO, UPSCALE_STUDIO, VIDEO_EDIT_STUDIO, VIDEO_STUDIO } = await import("@/lib/studios");
const { studioCatalog } = await import("@/lib/studio-catalog");
const { startingModel } = await import("@/lib/your-keys");
const { MARKETING_IMAGE_MODEL } = await import("@/lib/catalog/marketing");
const { modelHref } = await import("@/lib/palette-index");

beforeAll(() => setSetting("demoMode", "auto"));

const ROOT = process.cwd();
const LIB = path.join(ROOT, "workflows/comfyui");
const readJson = <T,>(p: string): T => JSON.parse(fs.readFileSync(p, "utf8")) as T;
const manifest = readJson<Manifest>(path.join(LIB, "manifest.json"));
const pins = readJson<Record<string, { revision: string; sizeBytes: number; sha256?: string }>>(path.join(LIB, "model-pins.json"));
const packs = readJson<Record<string, { repo: string; commit: string; registry: { id: string; version: string } | null }>>(path.join(LIB, "packs.json"));
const requirements = readJson<{ packs: Record<string, unknown>; files: Record<string, { sizeBytes: number }>; workflows: Record<string, { packs: Record<string, string[]>; files: string[]; validated?: true }> }>(
  path.join(LIB, "requirements.json"),
);
type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const graph = (id: string) => readJson<Graph>(path.join(LIB, `${id}.json`));
const wf = (id: string) => manifest.workflows.find((w) => w.id === id)!;

const FAST = ["minimax-h3-t2v", "minimax-h3-i2v", "minimax-h3-flf2v"];
const HQ = ["minimax-h3-t2v-hq", "minimax-h3-i2v-hq", "minimax-h3-flf2v-hq"];
const ALL = [...FAST, ...HQ, "minimax-h3-orbit"];
const h3 = getModel("oss-minimax-h3")!;

describe("MiniMax H3 on your GPU: the catalog entry", () => {
  it("is the first open video model, with sound, its routes and no negative prompt", () => {
    expect(h3).toMatchObject({ name: "MiniMax H3", vendor: "MiniMax", family: "minimax-h3", kind: "video", engine: "open" });
    expect(h3.badges).toEqual(["open", "new", "audio", "top"]);
    expect(h3.routes.map((r) => [r.op, r.provider, r.endpoint])).toEqual([
      ["t2v", "comfyui", "minimax-h3-t2v"],
      ["i2v", "comfyui", "minimax-h3-i2v"],
      ["flf2v", "comfyui", "minimax-h3-flf2v"],
      // Pika H3 Flex's references and Talk from a voice clip (nm10-pika-flex).
      ["ref2v", "comfyui", "minimax-h3-flex-ref2va"],
      ["avatar", "comfyui", "minimax-h3-flex-ref2va"],
    ]);
    expect(h3.options).toMatchObject({
      aspectRatios: ["auto", "16:9", "9:16", "1:1", "4:3", "3:4"],
      durations: [3, 5, 10, 15],
      resolutions: ["768p"],
      seed: true,
      endFrame: true,
      audio: "always",
      promptFormat: "minimax-h3",
    });
    expect(h3.options.controls).toEqual([
      {
        param: "quality",
        label: "Quality",
        values: ["fast", "best", "flex"],
        default: "fast",
        labels: { fast: "Standard · 8 steps", best: "Sharper · 20 steps, about 2.3x longer", flex: "Fast · Pika Flex (6 steps)" },
        // References and Talk from a voice clip always run Pika H3 Flex: no Quality there.
        ops: { fast: ["t2v", "i2v", "flf2v"], best: ["t2v", "i2v", "flf2v"], flex: ["t2v", "i2v", "flf2v"] },
      },
      // The GPU tier (FastH3 V2 / Trim on smaller cards); Fast decode is held back until it validates
      // (tests/h3-any-gpu.test.ts).
      H3_GPU_TIER,
    ]);
    expect(h3.options.negativePrompt).toBeUndefined();
    expect(h3.options.multiShot).toBeUndefined();
    expect(h3.routes.some((r) => r.op === "keyframes")).toBe(false);
    expect(h3.defaults).toEqual({ aspectRatio: "auto", duration: 5, resolution: "768p" });
    const video = MODELS.filter((m) => m.engine === "open" && m.kind === "video" && m.vendor !== "Fuobe Original").map((m) => m.id);
    expect(video.slice(0, 3)).toEqual(["oss-minimax-h3", "oss-ltx25", "oss-wan22-14b-fast"]);
    expect(getModel("oss-ltx25")!.badges).toEqual(["open", "audio", "top", "new"]);
    expect(getModel("oss-wan22-14b-fast")!.badges).toEqual(["open", "fast", "top"]);
  });

  it("has seven graphs in the library, each validated by a GPU run, with their packs, pinned files and bound frames", () => {
    for (const id of ALL) {
      const w = wf(id);
      expect(w, id).toBeDefined();
      expect(w.validated, id).toBe(true);
      expect(requirements.workflows[id].validated, id).toBe(true);
      expect(w.limits).toMatchObject({ maxFrames: 362, dimensionMultiple: 32 });
      expect(w.vramGb).toBe(32);
      expect(w.outputs).toEqual([{ node: "174", kind: "video" }]);
      expect(w.bindings.prompt).toEqual([{ node: "131", input: "prompt" }]);
      expect(w.bindings.frames).toEqual([{ node: "131", input: "length" }]);
      expect(w.bindings.seed).toEqual([{ node: "129", input: "noise_seed" }]);
      expect(w.bindings.steps).toEqual([{ node: "124", input: "steps" }]);
      expect(w.notes, id).toMatch(/Canvas: 768 px on the short side/);
      // Every file the graph loads is in the manifest, pinned to a revision with its size and sha256.
      for (const m of w.models) {
        const pin = pins[m.url!];
        expect(pin, `${id}: ${m.file}`).toBeDefined();
        expect(m.url).toContain(`/resolve/${pin.revision}/`);
        expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(requirements.files[`${m.folder}/${m.file}`].sizeBytes).toBe(pin.sizeBytes);
      }
      // Every LoadImage is bound (the build refuses a graph whose loader keeps an example picture).
      const g = graph(id);
      const bound = new Set(Object.values(w.bindings).flatMap((ts) => (ts ?? []).map((t) => `${t.node}.${t.input}`)));
      for (const [nid, n] of Object.entries(g)) if (n.class_type === "LoadImage") expect(bound.has(`${nid}.image`), `${id} ${nid}`).toBe(true);
      expect(g["127"].inputs.unet_name).toBe("minimax_h3_fl2va_pruned_int8_convrot.safetensors");
      expect(g["119"].inputs.vae_name).toBe("minimax_h3_video_vae_int8_convrot.safetensors");
    }
    expect(wf("minimax-h3-t2v").defaults).toMatchObject({ width: 1344, height: 768, frames: 124, steps: 8, loraStrength: 1 });
    expect(wf("minimax-h3-i2v-hq").defaults).toMatchObject({ width: 1344, height: 768, frames: 124, steps: 20 });
    expect(wf("minimax-h3-orbit").defaults).toMatchObject({ frames: 73, steps: 28 });
    // Text to video has no frame to load; image to video one; start and end frames two.
    expect(Object.keys(wf("minimax-h3-t2v").bindings)).not.toContain("image");
    expect(wf("minimax-h3-i2v").bindings.image).toEqual([{ node: "138", input: "image" }]);
    expect(wf("minimax-h3-flf2v").bindings).toMatchObject({ image: [{ node: "138", input: "image" }], endImage: [{ node: "140", input: "image" }] });
  });

  it("runs the fast graphs on the turbo and SLA packs, the -hq and orbit graphs on core nodes only", () => {
    for (const id of FAST) {
      expect(wf(id).customNodes.map((n) => n.name).sort(), id).toEqual(["ComfyUI-MiniMax-H3-Turbo", "plaguekind-nodes"]);
      expect(wf(id).bindings.loraStrength).toEqual([{ node: "134", input: "strength" }]);
      expect(requirements.workflows[id].packs).toEqual({ "ComfyUI-MiniMax-H3-Turbo": ["MiniMaxH3TurboLoRA", "MiniMaxH3TurboSampler"], "plaguekind-nodes": ["H3AdaLNLoRAFix", "H3SLAAttention"] });
      expect(requirements.workflows[id].files).toContain("loras/minimax_h3_turbo_v4_step600_ema.safetensors");
    }
    for (const id of [...HQ, "minimax-h3-orbit"]) {
      expect(wf(id).customNodes, id).toEqual([]);
      expect(wf(id).bindings.loraStrength, id).toBeUndefined();
    }
    expect(packs["ComfyUI-MiniMax-H3-Turbo"]).toMatchObject({ repo: "https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo", commit: "77bfa67575b14e3be6214f1747732e540c68b5dd", registry: { id: "comfyui-minimax-h3-turbo", version: "" } });
    expect(packs["plaguekind-nodes"]).toMatchObject({ repo: "https://github.com/PlagueKind/ComfyUI-PlagueKind-Nodes", commit: "d58d006a4ea32c25c06499f2ff104f0852a045a6", registry: { id: "plaguekind-nodes", version: "" } });
    for (const name of ["ComfyUI-MiniMax-H3-Turbo", "plaguekind-nodes"]) expect(requirements.packs[name], name).toBeDefined();
    const sh = fs.readFileSync(path.join(ROOT, "scripts/comfy/install-comfyui.sh"), "utf8");
    expect(sh).toContain('[ComfyUI-MiniMax-H3-Turbo]="https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo 77bfa67575b14e3be6214f1747732e540c68b5dd"');
    expect(sh).toContain('[plaguekind-nodes]="https://github.com/PlagueKind/ComfyUI-PlagueKind-Nodes d58d006a4ea32c25c06499f2ff104f0852a045a6"');
  });

  it("orbits a still with the Orbit LoRA: the one bound picture is both the first and the last frame", () => {
    const w = wf("minimax-h3-orbit");
    const g = graph("minimax-h3-orbit");
    expect(w.capability).toBe("i2v");
    expect(w.bindings.image).toEqual([{ node: "138", input: "image" }]);
    expect(g["131"].inputs).toMatchObject({ first_frame: ["138", 0], last_frame: ["138", 0], length: 73 });
    expect(g["141"]).toMatchObject({ class_type: "LoraLoaderModelOnly", inputs: { lora_name: "minimax_h3_flf2v_lora_v1.safetensors", strength_model: 1 } });
    expect(g["142"]).toMatchObject({ class_type: "MiniMaxH3SigmaShift", inputs: { shift_video: 12, shift_audio: 3 } });
    expect(g["124"].inputs.steps).toBe(28);
    expect(w.models.find((m) => m.file === "minimax_h3_flf2v_lora_v1.safetensors")?.url).toBe(
      "https://huggingface.co/pablodawson/MiniMax-H3-360-Orbit-LoRA/resolve/5ddbc2dbbe95edbbdaf5017c3e934b1d01791697/minimax_h3_flf2v_lora_v1.safetensors",
    );
  });

  it("picks the graph a request runs: Best → the 20-step graph, an orbit → the Orbit LoRA graph (orbit wins)", () => {
    const has = (id: string) => manifest.workflows.some((w) => w.id === id);
    const run = (endpoint: string, extra: Record<string, unknown>, op = "i2v") => resolveWorkflowId(endpoint, { op, clips: 0, images: 1, audio2: false, extra, has });
    for (const [fast, best] of Object.entries(H3_BEST_GRAPH)) {
      expect(run(fast, { quality: "best" })).toBe(best);
      expect(run(fast, { quality: "fast" })).toBe(fast);
      expect(run(fast, {})).toBe(fast);
    }
    expect(run("minimax-h3-i2v", { orbit: true })).toBe("minimax-h3-orbit");
    expect(run("minimax-h3-i2v", { orbit: true, quality: "best" })).toBe("minimax-h3-orbit");
    expect(run("minimax-h3-flf2v", { orbit: true })).toBe("minimax-h3-flf2v");
    // A library without the variant keeps the route's own graph.
    expect(resolveWorkflowId("minimax-h3-i2v", { op: "i2v", clips: 0, images: 1, audio2: false, extra: { quality: "best" }, has: () => false })).toBe("minimax-h3-i2v");
  });
});

describe("MiniMax H3 on your GPU: canvas, frames and prompt", () => {
  const sizes: Record<string, { width: number; height: number }> = {
    "landscape43.png": { width: 1600, height: 1200 },
    "portrait.png": { width: 1080, height: 1920 },
    "square.png": { width: 1000, height: 1000 },
    "wide.png": { width: 1920, height: 1080 },
  };
  const prepare = async (endpoint: string, input: Partial<GenInput>, op: "t2v" | "i2v" | "flf2v") =>
    prepareWorkflow(endpoint, { prompt: "a dancer spins", seed: 7, ...input } as GenInput, {
      generationId: "g",
      op,
      upload: async (_d, _t, name) => name,
      media: ((name: string) => sizes[name]) as never,
      serverRam: async () => undefined,
    });
  const canvas = (w: Graph) => [w["131"].inputs.width, w["131"].inputs.height];

  it("gives a clip from a still the still's shape on H3's canvas, whatever aspect ratio a text draft left", async () => {
    for (const [still, want] of [
      ["landscape43.png", [1024, 768]],
      ["portrait.png", [768, 1344]],
      ["square.png", [768, 768]],
      ["wide.png", [1344, 768]],
    ] as const) {
      for (const aspectRatio of ["auto", "16:9", "1:1"]) {
        const { workflow } = await prepare("minimax-h3-i2v", { images: [still], aspectRatio }, "i2v");
        expect(canvas(workflow as Graph), `${still} ${aspectRatio}`).toEqual(want);
        expect((workflow as Graph)["138"].inputs.image).toBe(still);
      }
    }
    // Start and end frames, the orbit and the Best graph size the same way.
    expect(canvas((await prepare("minimax-h3-flf2v", { images: ["portrait.png"], endImage: "square.png", aspectRatio: "16:9" }, "flf2v")).workflow as Graph)).toEqual([768, 1344]);
    expect(canvas((await prepare("minimax-h3-i2v", { images: ["landscape43.png"], extra: { orbit: true } }, "i2v")).workflow as Graph)).toEqual([1024, 768]);
    const best = await prepare("minimax-h3-i2v", { images: ["portrait.png"], extra: { quality: "best" } }, "i2v");
    expect(best.manifest.id).toBe("minimax-h3-i2v-hq");
    expect(canvas(best.workflow as Graph)).toEqual([768, 1344]);
  });

  it("text to video: the aspect ratio asked for (16:9 → 1344 × 768, auto → 16:9)", async () => {
    expect(canvas((await prepare("minimax-h3-t2v", { aspectRatio: "16:9" }, "t2v")).workflow as Graph)).toEqual([1344, 768]);
    expect(canvas((await prepare("minimax-h3-t2v", { aspectRatio: "9:16" }, "t2v")).workflow as Graph)).toEqual([768, 1344]);
    expect(canvas((await prepare("minimax-h3-t2v", { aspectRatio: "4:3" }, "t2v")).workflow as Graph)).toEqual([1024, 768]);
    expect(canvas((await prepare("minimax-h3-t2v", { aspectRatio: "auto" }, "t2v")).workflow as Graph)).toEqual([1344, 768]);
  });

  it("puts 3, 5, 10 and 15 s on H3's grid (73, 124, 243, 362 frames), the length the prompt names", async () => {
    for (const [duration, frames] of [
      [3, 73],
      [5, 124],
      [10, 243],
      [15, 362],
    ]) {
      expect(h3Frames(duration)).toBe(frames);
      const { workflow } = await prepare("minimax-h3-t2v", { duration, aspectRatio: "16:9" }, "t2v");
      expect((workflow as Graph)["131"].inputs.length, `${duration} s`).toBe(frames);
    }
    // The orbit's own length when the run names none (the planner gives it 3 s), and the length it names otherwise.
    const orbit = (params: NonNullable<Parameters<typeof planGeneration>[0]["params"]>) =>
      planGeneration({ feature: "video", modelId: "oss-minimax-h3", op: "i2v", prompt: "a dancer mid-leap", inputs: { images: ["/api/files/square.png"] }, params }, getModel, getPreset).params;
    const planned = orbit({ extra: { orbit: true } });
    expect(planned.duration).toBe(3);
    expect(((await prepare("minimax-h3-orbit", { ...planned, images: ["square.png"] }, "i2v")).workflow as Graph)["131"].inputs.length).toBe(73);
    expect(orbit({ duration: 5, extra: { orbit: true } }).duration).toBe(5);
    expect(orbit({}).duration).toBe(5);
  });

  it("wraps the words in H3's layout on the server and keeps it as the run's prompt; an orbit keeps its words", async () => {
    const still = saveFile({ data: encodePng({ width: 8, height: 6, data: Buffer.alloc(8 * 6 * 4, 200) }), contentType: "image/png", source: "upload" });
    const submit = mockProvider.submit;
    const seen = new Map<string, string>();
    const lengths = new Map<string, number | undefined>();
    mockProvider.submit = async (ctx) => {
      if (ctx.model.id === "oss-minimax-h3") lengths.set(ctx.generationId, ctx.input.duration);
      if (ctx.model.id === "oss-minimax-h3") seen.set(ctx.generationId, ctx.input.prompt ?? "");
      return submit(ctx);
    };
    const settled = async (id: string) => {
      for (let i = 0; i < 200 && !seen.has(id); i++) await new Promise((r) => setTimeout(r, 25));
      return seen.get(id);
    };
    try {
      const [i2v] = createGenerations({ feature: "video", modelId: "oss-minimax-h3", op: "i2v", prompt: "She turns to the camera and smiles", inputs: { images: [still.url] }, params: { duration: 5 } });
      const sent = await settled(i2v.id);
      expect(sent).toMatch(/^For the target video, at 0\.00 seconds into the target video, <Picture 1> \(from \[Shot 1\]\) is fully referenced\.\n\nintegrated_multimodal_description: \[Shot 1\] She turns to the camera and smiles\n\n/);
      expect(getGeneration(i2v.id)!.prompt).toBe(sent);
      const [flf] = createGenerations({ feature: "video", modelId: "oss-minimax-h3", op: "flf2v", prompt: "The candle melts", inputs: { images: [still.url], endImage: still.url }, params: { duration: 10 } });
      expect(await settled(flf.id)).toContain("aligns with the 10.13-second mark of the target video");
      const [t2v] = createGenerations({ feature: "video", modelId: "oss-minimax-h3", op: "t2v", prompt: "Waves roll onto a beach at dawn" });
      expect(await settled(t2v.id)).toMatch(/^integrated_multimodal_description: \[Shot 1\] Waves roll onto a beach at dawn\n\noverall_soundscape: /);
      const words = "One frozen instant, filmed by a camera that moves in one continuous 360-degree orbit.";
      // An orbit with no length asked: its words as they are, at the Orbit LoRA's 3 s (73 frames).
      const [orbit] = createGenerations({ feature: "video", modelId: "oss-minimax-h3", op: "i2v", prompt: words, inputs: { images: [still.url] }, params: { extra: { orbit: true } } });
      expect(await settled(orbit.id)).toBe(words);
      expect(lengths.get(orbit.id)).toBe(3);
      // The orbit setting on a text run changes nothing: the turbo graph runs, so the words are wrapped.
      const [text] = createGenerations({ feature: "video", modelId: "oss-minimax-h3", op: "t2v", prompt: "Waves roll onto a beach at dawn", params: { extra: { orbit: true } } });
      expect(await settled(text.id)).toMatch(/^integrated_multimodal_description: \[Shot 1\] Waves roll/);
      // Hosted H3 gets plain words.
      expect(getModel("minimax-h3")!.options.promptFormat).toBeUndefined();
    } finally {
      mockProvider.submit = submit;
    }
  });
});

describe("the Video studio and the other studio defaults", () => {
  const best = (engine: "open" | "cloud") => {
    const ops = VIDEO_STUDIO.pickerOps ?? VIDEO_STUDIO.ops;
    return studioBest(filterModels(MODELS, { kind: VIDEO_STUDIO.kind, ops }), engine, VIDEO_STUDIO.defaultModels[engine], ops);
  };

  it("opens on MiniMax H3 on both engines, with LTX-2.5, Lightning and Seedance next in Best", () => {
    expect(VIDEO_STUDIO.defaultModels).toEqual({ cloud: "minimax-h3", open: "oss-minimax-h3" });
    expect(best("open")).toEqual(["oss-minimax-h3", "oss-ltx25", "oss-wan22-14b-fast", "fuobe-cinema"]);
    // Kling 4.0 (nm10-kling-4) sits after Seedance 2.5, so Veo 3.1 leaves the four Best picks (the owner's choice).
    expect(best("cloud")).toEqual(["minimax-h3", "seedance-2-5", "kling-4", "kling-3"]);
    expect(studioCatalog(VIDEO_STUDIO).models.map((m) => m.id)).toEqual(expect.arrayContaining(["oss-minimax-h3", "minimax-h3", "oss-wan22-14b"]));
  });

  it("starts a Replicate-only account on a cloud video model it can run (hosted H3 is on fal.ai alone)", () => {
    const cloud = studioCatalog(VIDEO_STUDIO).models.filter((m) => m.engine === "cloud");
    const replicateOnly = { viewer: { kind: "account" as const, gpu: { connected: false }, keys: ["replicate" as const], paidAllowed: true } };
    const start = startingModel("minimax-h3", cloud, replicateOnly)!;
    expect(start).not.toBe("minimax-h3");
    expect(cloud.find((m) => m.id === start)!.routes.some((r) => r.provider === "replicate")).toBe(true);
    expect(startingModel("minimax-h3", cloud, { viewer: { kind: "account", gpu: { connected: false }, keys: ["fal"], paidAllowed: true } })).toBe("minimax-h3");
  });

  it("hosted MiniMax H3: top pick with sound, 5-15 s, 768P by default, priced per second by resolution", () => {
    const m = getModel("minimax-h3")!;
    expect(m.badges).toEqual(expect.arrayContaining(["top", "new", "audio"]));
    expect(m.defaults).toEqual({ aspectRatio: "16:9", duration: 5, resolution: "768P" });
    const durations = m.options.durations!;
    expect(durations).toContain(5);
    for (const d of durations) expect(d >= 5 && d <= 15, String(d)).toBe(true);
    // fal's pricing record (docs/research/new-models-7.json): USD per second by resolution.
    const research = readJson<{ items: { hosted: { id: string; price?: Record<string, number> }[] }[] }>(path.join(ROOT, "docs/research/new-models-7.json"));
    const price = research.items.flatMap((i) => i.hosted).find((h) => h.id === "minimax/h3/image-to-video")!.price!;
    expect(m.pricing).toMatchObject({ unit: "second", usd: price["768p"], byResolution: { "480P": price["480p"], "768P": price["768p"], "2K": price["2k"], "4K": price["4k"] } });
    expect(estimateCost(m, { duration: 5, resolution: "768P" })).toBeCloseTo(5 * price["768p"], 6);
    expect(estimateCost(m, { duration: 5, resolution: "768P" })).toBeCloseTo(0.3, 6);
    expect(estimateCost(m, { ...m.defaults })).toBeCloseTo(0.3, 6);
  });

  it("Reframe starts on MiniMax H3 Max Reframe in the cloud (Luma stays listed), Upscale on SeedVR2 on your GPU", () => {
    expect(REFRAME_STUDIO.defaultModels).toEqual({ cloud: "minimax-h3-max-reframe", open: "oss-wan22-vace-reframe" });
    expect(getModel("minimax-h3-max-reframe")!.routes.map((r) => r.op)).toEqual(["reframe"]);
    expect(studioCatalog(REFRAME_STUDIO).models.map((m) => m.id)).toContain("luma-ray-3-2");
    expect(UPSCALE_STUDIO.defaultModels.open).toBe("oss-seedvr2-image");
    expect(getModel("oss-seedvr2-image")!.routes.map((r) => r.op)).toEqual(["upscale-image"]);
    expect(manifest.workflows.find((w) => w.id === "upscale-image-seedvr2")!.validated).toBe(true);
  });

  it("Edit video starts on your GPU on a v2v model that runs on a clip and words alone, in the clip's shape, rate and length", async () => {
    const id = VIDEO_EDIT_STUDIO.defaultModels.open;
    const view = (x: string) => (getModel(x)?.engines ? onEngine(getModel(x)!, "open") : getModel(x));
    const model = view(id)! as ModelDef;
    const route = model.routes.find((r) => r.op === "v2v")!;
    expect(route.provider).toBe("comfyui");
    const plan = planGeneration({ feature: "video-edit", modelId: id, op: "v2v", prompt: "make it snow", inputs: { video: "/api/files/clip.mp4" }, engine: "open" }, view, getPreset);
    expect(plan.op).toBe("v2v");
    const run = (clip: { width: number; height: number; duration: number; fps: number }, params: Partial<GenInput> = {}) =>
      prepareWorkflow(route.endpoint, { prompt: plan.prompt, video: "clip.mp4", seed: 1, ...plan.params, ...params } as GenInput, {
        generationId: "g",
        op: "v2v",
        upload: async (_d, _t, n) => n,
        media: (() => ({ ...clip, videoDuration: clip.duration })) as never,
        serverRam: async () => undefined,
      });
    const prepared = await run({ width: 1280, height: 720, duration: 5, fps: 24 });
    expect(prepared.manifest.id).toBe(route.endpoint);
    // The edit follows the clip: its shape, its frame rate and its whole length.
    const at = (key: string) => {
      const [{ node, input }] = (wf(route.endpoint).bindings as Record<string, { node: string; input: string }[]>)[key];
      return (prepared.workflow as Graph)[node].inputs[input];
    };
    const [w, h] = [Number(at("width")), Number(at("height"))];
    expect(w).toBeGreaterThan(h);
    expect(Math.abs(w / h - 16 / 9)).toBeLessThan(0.02);
    expect([at("fps"), at("frames")]).toEqual([24, 120]);
    // A 30 fps portrait clip: its shape, at 24 fps. Past the frame cap the run is refused, not cut short.
    const tall = (await run({ width: 1080, height: 1920, duration: 4, fps: 30 })).workflow as Graph;
    const shape = (key: string) => tall[(wf(route.endpoint).bindings as Record<string, { node: string }[]>)[key][0].node].inputs;
    expect(Number(shape("height").height)).toBeGreaterThan(Number(shape("width").width));
    expect(shape("fps").force_rate).toBe(24);
    await expect(run({ width: 1280, height: 720, duration: 30, fps: 24 })).rejects.toThrow(/up to 240 frames/);
    // What a run sets itself still wins (the Mixed Media studio sends its own size, rate and frames).
    const own = (await run({ width: 1280, height: 720, duration: 5, fps: 24 }, { fps: 8, aspectRatio: "9:16", extra: { frames: 40 } })).workflow as Graph;
    expect([own["1"].inputs.force_rate, own["1"].inputs.frame_load_cap]).toEqual([8, 40]);
    expect(Number(own["3"].inputs.height)).toBeGreaterThan(Number(own["3"].inputs.width));
    expect(filterModels(MODELS, { kind: "video", ops: VIDEO_EDIT_STUDIO.ops }).map((m) => m.id)).toContain(id);
  });

  it("puts MiniMax H3 first under Just added, and takes SDXL out of the Image picker", () => {
    expect(HOME_NEW_OPEN[0]).toBe("oss-minimax-h3");
    expect(newOpenModels()[0].id).toBe("oss-minimax-h3");
    expect(getModel("oss-sdxl")!.hidden).toBe(true);
    expect(filterModels(MODELS, { kind: "image", ops: IMAGE_STUDIO.pickerOps ?? IMAGE_STUDIO.ops }).map((m) => m.id)).not.toContain("oss-sdxl");
    // A hidden model with no picker links to its kind's studio.
    expect(modelHref(getModel("oss-sdxl")!)).toBe("/image");
    expect(modelHref(h3)).toBe("/video?model=oss-minimax-h3");
  });

  it("Fuobe Marketing Image runs Qwen-Image 2.1 on your GPU; its Standalone product shot keeps the 2509 graph", () => {
    const open = onEngine(getModel(MARKETING_IMAGE_MODEL)!, "open");
    expect(open.routes.map((r) => [r.op, r.endpoint])).toEqual([
      ["edit", "qwen-image-21-edit"],
      ["t2i", "qwen-image-21-t2i"],
    ]);
    expect(open.options.maxImages).toBe(4);
    expect(open.tagline).toContain("Qwen-Image 2.1");
    expect(PRODUCT_SHOT_GRAPH).toEqual({ "qwen-image-21-edit": "product-shot-qwen-edit-2509" });
    const has = (x: string) => manifest.workflows.some((w) => w.id === x);
    expect(resolveWorkflowId("qwen-image-21-edit", { op: "edit", clips: 0, images: 1, audio2: false, extra: { productShot: true }, has })).toBe("product-shot-qwen-edit-2509");
  });
});
