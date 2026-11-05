import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GenInput } from "@/lib/catalog/types";
import type { ComfyWorkflow, ManifestWorkflow } from "@/lib/comfy";
import type { GpuInventory, RequirementIndex } from "@/lib/gpu/types";
import { tempDir } from "./helpers/temp-dir";

// MiniMax H3 on smaller cards (docs/research/new-models-10.md §6.4): MiniMax H3 on 8-31 GB cards (FastH3 V2 and Trim), the GPU
// tier decided once per run, the pre-flight checking the graph and file the run loads, the board naming each card's build,
// and Fast decode (Sol-H3-VAE) on the full model. All on the open engine: the cloud keeps fal's hosted MiniMax H3.
const tmp = tempDir("fuobe-h3-any-gpu-");
process.env.FUOBE_DATA_DIR = tmp;
process.env.COMFYUI_URL = "http://comfy.test:8188";
const { prepareWorkflow } = await import("@/server/providers/comfyui");
const { getModel } = await import("@/lib/catalog");
const { resolveWorkflowId } = await import("@/lib/comfy-variants");
const T = await import("@/lib/gpu/h3-tier");
const { h3Gpu } = await import("@/server/h3-gpu");
const { previewGeneration } = await import("@/server/generations");
const { changeAccess, modelLicence } = await import("@/server/model-access");
const { setSetting } = await import("@/server/settings");
const { writeSnapshot, dropSnapshots } = await import("@/server/gpu/snapshots");
const { gateGeneration } = await import("@/server/gpu/gate");
const { buildViews } = await import("@/server/gpu/readiness-service");
const { STUDIO_ROWS, studioTool } = await import("@/server/gpu/tools");

const LIBRARY = path.join(process.cwd(), "workflows/comfyui");
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(LIBRARY, f), "utf8"));
const manifest = read("manifest.json") as { workflows: ManifestWorkflow[] };
const entry = (id: string) => manifest.workflows.find((w) => w.id === id)!;
const graph = (id: string) => read(`${id}.json`) as ComfyWorkflow;
const pins = read("model-pins.json") as Record<string, { revision: string; sizeBytes: number; sha256: string }>;
const index = read("requirements.json") as RequirementIndex;
const has = (id: string) => manifest.workflows.some((w) => w.id === id);
const variant = (endpoint: string, op: string, extra: Record<string, unknown>) => resolveWorkflowId(endpoint, { op, clips: 0, images: 0, audio2: false, extra, has });

const RTX4070 = "cuda:0 NVIDIA GeForce RTX 4070 Ti SUPER : cudaMallocAsync";
const RTX5060 = "cuda:0 NVIDIA GeForce RTX 5060 Ti : cudaMallocAsync";
const RTX4090 = "cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync";
const GIB = 2 ** 30;

/** The install's last GPU check: one card (or none), the H3 files present or not. */
const INSTALL = { kind: "install", key: "install", via: "server" } as const;
function inventory(o: { gb?: number; name?: string; torch?: string; files?: string[] }): GpuInventory {
  const at = Date.now();
  // The folders the H3 graphs read, listed (a folder the check didn't read would leave its files unknown, never missing).
  const models: GpuInventory["models"] = { diffusion_models: { have: {}, total: 0 }, text_encoders: { have: {}, total: 0 }, vae: { have: {}, total: 0 }, loras: { have: {}, total: 0 } };
  for (const key of o.files ?? []) {
    const [folder, file] = key.split("/");
    (models[folder] ??= { have: {}, total: 0 }).have[file] = null;
  }
  for (const m of Object.values(models)) m.total = Object.keys(m.have).length;
  return {
    v: 1,
    via: "server",
    checkedAt: at,
    tookMs: 5,
    reachable: true,
    comfy: { version: "0.43.0", os: "posix", torch: o.torch ?? "2.12.0+cu130", embeddedPython: false, deployEnv: "local-git", flags: {} as never },
    devices: o.gb === undefined ? [] : [{ name: o.name ?? RTX4070, type: "cuda", index: 0, vramTotal: o.gb * GIB, vramFree: o.gb * GIB }],
    manager: { api: "none" },
    nodes: { have: [], missing: [], total: 1, readAt: at, how: "object_info" },
    combos: {},
    packs: {},
    models,
    loras: {},
    fingerprint: "x",
    errors: [],
  } as never;
}
const checked = (o: Parameters<typeof inventory>[0]) => writeSnapshot(INSTALL, inventory(o));

const FAST = ["minimax-h3-fast-t2v", "minimax-h3-fast-i2v", "minimax-h3-fast-flf2v"];
const TRIM = "minimax-h3-trim-t2v";
const SHARED = ["text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "vae/minimax_h3_audio_vae_fp32.safetensors", "vae/minimax_h3_video_vae_int8_convrot.safetensors"];

describe("the FastH3 graphs", () => {
  it("are Comfy-Org's FastH3 template: sigma shift 10 / 3, Comfy Kitchen attention, VSA at 10%, 8 steps res_multistep", () => {
    for (const id of [...FAST, TRIM]) {
      const g = graph(id);
      const cls = (c: string) => Object.values(g).filter((n) => n.class_type === c);
      expect(cls("MiniMaxH3SigmaShift")[0].inputs, id).toMatchObject({ shift_video: 10, shift_audio: 3 });
      expect(cls("ModelAttentionBackend")[0].inputs.attention, id).toBe("comfy kitchen attention");
      expect(cls("BlockSparseAttention")[0].inputs, id).toMatchObject({ selection: "vsa", "selection.keep_percent": 10, start_percent: 0.2, end_percent: 1, sink_conditioning: "exact_kv_and_rows" });
      expect(cls("BasicScheduler")[0].inputs, id).toMatchObject({ scheduler: "simple", steps: 8 });
      expect(cls("KSamplerSelect")[0].inputs.sampler_name, id).toBe("res_multistep");
      expect(cls("CLIPLoader")[0].inputs.clip_name, id).toBe(T.H3_ENCODER);
      // No turbo LoRA, no custom node: core nodes only.
      expect(entry(id).customNodes ?? [], id).toEqual([]);
      expect(index.workflows[id].packs, id).toEqual({});
    }
    // Start frame and start + end frames on V2 only; Trim is text to video.
    expect(graph("minimax-h3-fast-i2v")["131"].inputs).toMatchObject({ first_frame: ["138", 0] });
    expect(graph("minimax-h3-fast-i2v")["131"].inputs.last_frame).toBeUndefined();
    expect(graph("minimax-h3-fast-flf2v")["131"].inputs).toMatchObject({ first_frame: ["138", 0], last_frame: ["140", 0] });
    expect(graph(TRIM)["131"].inputs.first_frame).toBeUndefined();
    expect(entry(TRIM).capability).toBe("t2v");
  });

  it("bind the diffusion file, and list every build of it with its pinned size and hash", () => {
    for (const id of FAST) {
      expect(entry(id).bindings.unet, id).toEqual([{ node: "127", input: "unet_name" }]);
      expect(index.workflows[id].files).toEqual([`diffusion_models/${T.FAST_FILES.int8.file}`, ...SHARED]);
      expect(index.workflows[id].optional).toEqual([`diffusion_models/${T.FAST_FILES.nvfp4.file}`]);
      expect(index.workflows[id].vramGb).toBe(16);
    }
    expect(index.workflows[TRIM].files).toEqual([`diffusion_models/${T.TRIM_FILES.int8.file}`, ...SHARED]);
    expect(index.workflows[TRIM].optional).toEqual([`diffusion_models/${T.TRIM_FILES.fp8.file}`, `diffusion_models/${T.TRIM_FILES.nvfp4.file}`]);
    expect(index.workflows[TRIM].vramGb).toBe(12);
    for (const f of [...Object.values(T.FAST_FILES), ...Object.values(T.TRIM_FILES)]) {
      const file = index.files[`diffusion_models/${f.file}`];
      expect(file, f.file).toBeDefined();
      expect(file.pinnedUrl).toMatch(/\/resolve\/[0-9a-f]{40}\//);
      // The chooser's sizes are the files' (GB, two decimals).
      expect(Math.abs(file.sizeBytes! / 1e9 - f.gb), f.file).toBeLessThan(0.01);
      expect(pins[file.pinnedUrl].sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(entry(TRIM).notes).toMatch(/8 GB figure is FastVideo's test/);
    expect(entry("minimax-h3-fast-i2v").notes).toMatch(/FL2VA was not distilled/);
    // The FastH3 V2 graphs passed a GPU run; Trim waits for one.
    for (const id of FAST) expect(entry(id).validated, id).toBe(true);
    expect(entry(TRIM).validated).toBe(false);
  });

  it("give the full graphs a decode loader of their own, so Fast decode swaps only the decoder", () => {
    for (const id of ["minimax-h3-t2v", "minimax-h3-i2v", "minimax-h3-flf2v", "minimax-h3-t2v-hq", "minimax-h3-i2v-hq", "minimax-h3-flf2v-hq"]) {
      const g = graph(id);
      expect(g["122"].inputs.vae, id).toEqual(["136", 0]);
      expect(g["131"].inputs.vae, id).toEqual(["119", 0]);
      expect(g["136"].inputs.vae_name, id).toBe(g["119"].inputs.vae_name);
      expect(entry(id).bindings.vae, id).toEqual([{ node: "136", input: "vae_name" }]);
      expect(index.workflows[id].optional, id).toEqual([`vae/${T.SOL_VAE}`]);
    }
    expect(pins[index.files[`vae/${T.SOL_VAE}`].pinnedUrl]).toMatchObject({ sizeBytes: 1988306504 });
    expect(index.workflows["minimax-h3-orbit"].optional).toEqual([]);
  });
});

describe("the graph a run takes", () => {
  it("a smaller tier runs its graph, winning over Best; an orbit keeps its graph; Trim has text to video only", () => {
    expect(variant("minimax-h3-t2v", "t2v", { gpuTier: "fast" })).toBe("minimax-h3-fast-t2v");
    expect(variant("minimax-h3-i2v", "i2v", { gpuTier: "fast", quality: "best" })).toBe("minimax-h3-fast-i2v");
    expect(variant("minimax-h3-flf2v", "flf2v", { gpuTier: "fast" })).toBe("minimax-h3-fast-flf2v");
    expect(variant("minimax-h3-t2v", "t2v", { gpuTier: "trim" })).toBe(TRIM);
    expect(variant("minimax-h3-i2v", "i2v", { gpuTier: "trim" })).toBe("minimax-h3-i2v");
    expect(variant("minimax-h3-i2v", "i2v", { gpuTier: "trim", quality: "best" })).toBe("minimax-h3-i2v-hq");
    expect(variant("minimax-h3-i2v", "i2v", { gpuTier: "fast", orbit: true })).toBe("minimax-h3-orbit");
    expect(variant("minimax-h3-t2v", "t2v", { gpuTier: "standard", quality: "best" })).toBe("minimax-h3-t2v-hq");
    expect(variant("minimax-h3-t2v", "t2v", {})).toBe("minimax-h3-t2v");
  });

  it("Fast · Pika Flex runs its own graph on the full model, over any tier; the plan refuses a smaller tier picked with it", () => {
    // Pika's bf16 adapters are made for the full fl2va int8 model: the Flex graphs win over a tier here.
    expect(variant("minimax-h3-t2v", "t2v", { quality: "flex" })).toBe("minimax-h3-flex-t2v");
    expect(variant("minimax-h3-i2v", "i2v", { quality: "flex", gpuTier: "standard" })).toBe("minimax-h3-flex-i2v");
    expect(variant("minimax-h3-flf2v", "flf2v", { quality: "flex", gpuTier: "fast" })).toBe("minimax-h3-flex-flf2v");
    expect(variant("minimax-h3-i2v", "i2v", { quality: "flex", orbit: true })).toBe("minimax-h3-orbit");
    try {
      // Auto on a 16 GB card: Flex keeps the full model (the pre-flight then judges the card), with no FastH3 file.
      checked({ gb: 16, name: RTX4070 });
      expect(h3Gpu("minimax-h3-t2v", { quality: "flex" }, has)).toEqual({ gpuTier: "standard" });
      // FastH3 V2 or Trim picked with Flex: refused in plain words, never one choice dropped.
      expect(() => h3Gpu("minimax-h3-i2v", { quality: "flex", gpuTier: "fast" }, has)).toThrow(T.TIER_FLEX_REFUSAL);
      expect(() => h3Gpu("minimax-h3-t2v", { quality: "flex", gpuTier: "trim" }, has)).toThrow(/Fast · Pika Flex needs a 32 GB GPU/);
      // Trim has no start-frame graph, so Flex with Trim on a start frame runs the full model, as Trim alone does there.
      expect(h3Gpu("minimax-h3-i2v", { quality: "flex", gpuTier: "trim" }, has)).toEqual({ gpuTier: "standard" });
      expect(h3Gpu("minimax-h3-t2v", { quality: "flex", gpuTier: "standard" }, has)).toEqual({ gpuTier: "standard" });
      // The composer says the same before the run.
      expect(T.h3TierNote({ quality: "flex", gpuTier: "fast" }, "t2v")).toBe(T.TIER_FLEX_REFUSAL);
      expect(T.h3TierNote({ quality: "flex" }, "t2v", "fast")).toBeUndefined();
      expect(T.h3TierNote({ quality: "flex", gpuTier: "trim" }, "i2v")).toBeUndefined();
    } finally {
      dropSnapshots("install");
    }
  });

  it("binds the card's file and keeps the H3 canvas and frame grid", async () => {
    const prompt = await prepareWorkflow("minimax-h3-t2v", { prompt: "a lighthouse", seed: 7, aspectRatio: "16:9", duration: 5, extra: { gpuTier: "trim", unet: T.TRIM_FILES.nvfp4.file } } as GenInput, {
      generationId: "g-h3",
      op: "t2v",
      upload: async (_d, _t, name) => `up_${name}`,
      media: () => undefined,
      serverRam: async () => undefined,
      modelPath: async () => undefined,
    });
    const g = prompt.workflow as ComfyWorkflow;
    expect(g["127"].inputs.unet_name).toBe(T.TRIM_FILES.nvfp4.file);
    expect(g["131"].inputs).toMatchObject({ width: 1344, height: 768, length: 124 });
  });
});

describe("Auto and Options → GPU tier, decided once per run", () => {
  it("routes a smaller card to its build, with its file; keeps the full model otherwise", () => {
    try {
      dropSnapshots("install");
      expect(h3Gpu("minimax-h3-t2v", {}, has, has)).toEqual({ gpuTier: "standard" });
      checked({ gb: 16, name: RTX4070 });
      expect(h3Gpu("minimax-h3-t2v", {}, has, has)).toMatchObject({ gpuTier: "fast", unet: T.FAST_FILES.int8.file, note: T.TIER_NOTES.fast });
      checked({ gb: 16, name: RTX5060 });
      expect(h3Gpu("minimax-h3-i2v", {}, has, has)).toMatchObject({ gpuTier: "fast", unet: T.FAST_FILES.nvfp4.file });
      checked({ gb: 12, name: RTX4070, torch: "2.9.1+cu128" });
      expect(h3Gpu("minimax-h3-t2v", {}, has, has)).toMatchObject({ gpuTier: "trim", unet: T.TRIM_FILES.fp8.file, note: T.TIER_NOTES.trim });
      // Trim has no start-frame graph: the full model (the pre-flight then says it needs a bigger GPU).
      expect(h3Gpu("minimax-h3-i2v", {}, has, has)).toEqual({ gpuTier: "standard" });
      checked({ gb: 32, name: RTX4090 });
      expect(h3Gpu("minimax-h3-t2v", {}, has, has)).toEqual({ gpuTier: "standard" });
      // Best and Fast decode on a smaller build say they need 32 GB.
      checked({ gb: 16, name: RTX4070 });
      expect(h3Gpu("minimax-h3-t2v", { quality: "best", vae: T.SOL_VAE }, has, has)?.note).toMatch(/Sharper needs a 32 GB GPU.*Fast decode needs a 32 GB GPU/);
      // Asked for: on any card; an orbit and another model take no tier.
      checked({ gb: 48, name: RTX4090 });
      expect(h3Gpu("minimax-h3-t2v", { gpuTier: "trim" }, has, has)).toMatchObject({ gpuTier: "trim", unet: T.TRIM_FILES.int8.file });
      expect(h3Gpu("minimax-h3-i2v", { orbit: true }, has, has)).toBeUndefined();
      expect(h3Gpu("qwen-image-21-t2i", {}, has, has)).toBeUndefined();
    } finally {
      dropSnapshots("install");
    }
  });

  it("keeps Auto on the full model until ComfyUI has accepted the smaller build's graph, then takes it on a smaller card; asking for it runs it", () => {
    checked({ gb: 16, name: RTX4070 });
    try {
      const accepted = (id: string) => entry(id)?.validated === true;
      expect(accepted("minimax-h3-fast-t2v")).toBe(true);
      expect(h3Gpu("minimax-h3-t2v", {}, has, () => false)).toEqual({ gpuTier: "standard" });
      expect(h3Gpu("minimax-h3-t2v", {}, has)).toMatchObject({ gpuTier: "fast", unet: T.FAST_FILES.int8.file });
      expect(h3Gpu("minimax-h3-t2v", { gpuTier: "fast" }, has, accepted)).toMatchObject({ gpuTier: "fast", unet: T.FAST_FILES.int8.file });
    } finally {
      dropSnapshots("install");
    }
  });

  it("holds a build switched off in Models & licences: Auto keeps the full model, asking for it is refused", () => {
    checked({ gb: 16, name: RTX4070 });
    try {
      changeAccess([{ kind: "model", id: "oss-minimax-h3-fast", on: false }]);
      expect(h3Gpu("minimax-h3-t2v", {}, has, has)).toEqual({ gpuTier: "standard" });
      expect(() => h3Gpu("minimax-h3-t2v", { gpuTier: "fast" }, has, has)).toThrow(/(turned|switched) off in Settings → Models & licences/);
    } finally {
      changeAccess([{ kind: "reset" }]);
      dropSnapshots("install");
    }
  });

  it("carries the tier and file on the run's plan, and drops a file the request names", () => {
    const g = globalThis as unknown as { __fuobeComfyReach?: { ok: boolean; at: number; url: string } };
    const before = g.__fuobeComfyReach;
    g.__fuobeComfyReach = { ok: true, at: Date.now(), url: "http://comfy.test:8188" };
    setSetting("demoMode", "off");
    try {
      const run = (extra: Record<string, unknown> = {}) => previewGeneration({ feature: "video", modelId: "oss-minimax-h3", prompt: "a lighthouse at dusk", params: { aspectRatio: "16:9", duration: 5, extra } });
      checked({ gb: 12, name: RTX4070 });
      const trim = run({ gpuTier: "trim", unet: "something-else.safetensors" });
      expect(trim).toMatchObject({ demo: false, h3: { gpuTier: "trim", unet: T.TRIM_FILES.int8.file }, route: { provider: "comfyui", endpoint: "minimax-h3-t2v" } });
      expect(trim.notes).toContain(T.TIER_NOTES.trim);
      checked({ gb: 32, name: RTX4090 });
      const full = run({ unet: "something-else.safetensors" });
      expect(full.h3).toEqual({ gpuTier: "standard" });
      expect(full.notes ?? []).not.toContain(T.TIER_NOTES.trim);
      // A FastH3 build named directly (its hidden model): its own tier, and the card's file, never the request's.
      checked({ gb: 16, name: RTX5060 });
      const direct = previewGeneration({ feature: "video", modelId: "oss-minimax-h3-trim", prompt: "a lighthouse at dusk", params: { aspectRatio: "16:9", duration: 5, extra: { unet: "something-else.safetensors" } } });
      expect(direct).toMatchObject({ h3: { gpuTier: "trim", unet: T.TRIM_FILES.nvfp4.file }, route: { provider: "comfyui", endpoint: "minimax-h3-trim-t2v" } });
      expect(h3Gpu("minimax-h3-fast-i2v", { unet: "something-else.safetensors", gpuTier: "trim" }, has, has)).toMatchObject({ gpuTier: "fast", unet: T.FAST_FILES.nvfp4.file });
    } finally {
      g.__fuobeComfyReach = before;
      setSetting("demoMode", "auto");
      dropSnapshots("install");
    }
  });
});

describe("the GPU pre-flight", () => {
  const gate = (extra: Record<string, unknown>, h3?: { gpuTier: string; unet?: string }) =>
    gateGeneration(INSTALL, { request: { feature: "video", modelId: "oss-minimax-h3", prompt: "a fox", params: { extra } }, route: { provider: "comfyui", endpoint: "minimax-h3-t2v" }, op: "t2v", modelId: "oss-minimax-h3", h3, actor: "owner" });

  it("checks the build and file the run loads", async () => {
    const trim = [...SHARED, `diffusion_models/${T.TRIM_FILES.nvfp4.file}`];
    checked({ gb: 12, name: RTX5060, files: trim });
    try {
      // The card's NVFP4 file is there: ready, though the graph's default (int8) isn't.
      expect(await gate({}, { gpuTier: "trim", unet: T.TRIM_FILES.nvfp4.file })).toEqual({ ok: true });
      // Its int8 file isn't: the owner is told what's missing.
      expect(await gate({}, { gpuTier: "trim", unet: T.TRIM_FILES.int8.file })).toMatchObject({ ok: true, warning: expect.stringMatching(/more thing/) });
      // The full model on the same card: its files are missing.
      expect(await gate({}, { gpuTier: "standard" })).toMatchObject({ ok: true, warning: expect.stringMatching(/more thing/) });
    } finally {
      dropSnapshots("install");
    }
  });

  it("asks for Sol-H3-VAE only when Fast decode is picked", async () => {
    const full = index.workflows["minimax-h3-t2v"].files;
    checked({ gb: 32, name: RTX4090, files: full });
    // Fast decode is held back (H3_FAST_DECODE_OFFERED): the control is put on the model here as it will be once it validates.
    const options = getModel("oss-minimax-h3")!.options;
    const controls = options.controls;
    options.controls = [...(controls ?? []), T.H3_DECODER];
    try {
      expect(await gate({}, { gpuTier: "standard" })).toEqual({ ok: true });
      expect(await gate({ vae: T.SOL_VAE }, { gpuTier: "standard" })).toMatchObject({ ok: true, warning: expect.stringMatching(/1 more thing/) });
      // Options → Decoder as the composer sends it: the option's value, which the model's control turns into Sol's file.
      expect(await gate({ decoder: "fast" }, { gpuTier: "standard" })).toMatchObject({ ok: true, warning: expect.stringMatching(/1 more thing/) });
      expect(await gate({ decoder: "standard" }, { gpuTier: "standard" })).toEqual({ ok: true });
    } finally {
      options.controls = controls;
      dropSnapshots("install");
    }
  });

  it("withTierFile swaps the default file for the card's, and nothing else", () => {
    const out = T.withTierFile(index, TRIM, T.TRIM_FILES.fp8.file);
    expect(out.workflows[TRIM].files).toEqual([`diffusion_models/${T.TRIM_FILES.fp8.file}`, ...SHARED]);
    expect(out.workflows[TRIM].optional).toEqual([`diffusion_models/${T.TRIM_FILES.nvfp4.file}`]);
    expect(T.withTierFile(index, TRIM, T.TRIM_FILES.int8.file)).toBe(index);
    expect(T.withTierFile(index, TRIM, "elsewhere.safetensors")).toBe(index);
    expect(T.withTierFile(index, "minimax-h3-t2v", T.TRIM_FILES.fp8.file)).toBe(index);
  });
});

describe("the pre-flight board", () => {
  // The board once ComfyUI has accepted the smaller builds' graphs (until then Auto keeps the full model, as runs do).
  beforeAll(() => void (globalThis.__fuobeTestH3Accepted = true));
  afterAll(() => void (globalThis.__fuobeTestH3Accepted = undefined));
  const ctx = { account: false, computer: false, isolatedUrl: false };
  const row = (href: string, inv: GpuInventory) => buildViews(inv, index, ctx).report.studios.find((r) => r.href === href)!;

  it("names the build each card gets on the Video row, and checks that build's files", () => {
    const trimFiles = [...SHARED, `diffusion_models/${T.TRIM_FILES.int8.file}`];
    const trim = row("/video", inventory({ gb: 12, name: RTX4070, files: trimFiles }));
    expect(trim.gpuTier).toEqual({ label: "FastH3 Trim (int8)", note: "Text to video only; part of it waits in system memory" });
    expect(trim.tool.state).toBe("ready");
    const fast = row("/video", inventory({ gb: 16, name: RTX5060 }));
    expect(fast.gpuTier).toEqual({ label: "FastH3 V2 (nvfp4)" });
    expect(fast.tool.needs.map((n) => n.key)).toContain(`file:diffusion_models/${T.FAST_FILES.nvfp4.file}`);
    expect(fast.tool.vram.needGb).toBe(16);
    // 32 GB and up, or a card no build fits: no build named.
    expect(row("/video", inventory({ gb: 32, name: RTX4090 })).gpuTier).toBeUndefined();
    expect(row("/video", inventory({ gb: 8, name: RTX4070 })).gpuTier).toBeUndefined();
    // Auto's build for the composer's note.
    expect(buildViews(inventory({ gb: 12, name: RTX4070 }), index, ctx).badges.h3Tier).toBe("trim");
    expect(buildViews(inventory({ gb: 48, name: RTX4090 }), index, ctx).badges.h3Tier).toBeUndefined();
  });

  it("says plainly that swaps and removals still need the full model", () => {
    const swap = row("/character-swap", inventory({ gb: 16, name: RTX4070 }));
    expect(swap.gpuTier?.note).toMatch(/Runs on the full MiniMax H3: there's no smaller build for swaps and removals yet/);
    expect(row("/character-swap", inventory({ gb: 48, name: RTX4090 })).gpuTier).toBeUndefined();
    // The Video row's own tool is the full model's three modes (the board swaps them per card).
    expect(studioTool(STUDIO_ROWS.find((r) => r.href === "/video")!)!.workflows).toEqual(expect.arrayContaining(["minimax-h3-t2v", "minimax-h3-i2v", "minimax-h3-flf2v"]));
  });
});

describe("Models & licences", () => {
  it("lists each build with its licence and its own switch, never in a picker", () => {
    for (const id of ["oss-minimax-h3-fast", "oss-minimax-h3-trim"]) {
      const m = getModel(id)!;
      expect(m.hidden, id).toBe(true);
      expect(m.engine, id).toBe("open");
      expect(modelLicence(m).licence.name + modelLicence(m).licence.note, id).toMatch(/MiniMax H3 Community License/);
    }
    expect(getModel("oss-minimax-h3-trim")!.routes.map((r) => r.op)).toEqual(["t2v"]);
    expect(getModel("oss-minimax-h3-fast")!.routes.map((r) => r.op)).toEqual(["t2v", "i2v", "flf2v"]);
    expect(T.H3_TIER_MODEL).toEqual({ fast: "oss-minimax-h3-fast", trim: "oss-minimax-h3-trim" });
  });

  it("records Sol-H3-VAE's licence as unconfirmed on the full model's row", () => {
    const full = modelLicence(getModel("oss-minimax-h3")!).licence;
    expect(full.class).toBe("regions");
    expect(full.note).toMatch(/Sol-H3-VAE \(Efficient-Large-Model; the optional fast decoder\): licence unconfirmed/);
    for (const id of ["minimax-h3-t2v", "minimax-h3-i2v-hq"]) expect(entry(id).license, id).toMatch(/Sol-H3-VAE.*licence unconfirmed/);
    expect(entry("minimax-h3-fast-t2v").license).not.toMatch(/Sol-H3-VAE/);
  });

  it("holds Fast decode back until a ComfyUI with Sol's loader validates it, and keeps it off by default when offered", () => {
    const controls = getModel("oss-minimax-h3")!.options.controls!;
    expect(T.H3_FAST_DECODE_OFFERED).toBe(false);
    expect(controls.map((c) => c.param)).toEqual(["quality", "gpuTier"]);
    expect(T.H3_DECODER).toMatchObject({ param: "decoder", default: "standard", sets: { standard: {}, fast: { vae: T.SOL_VAE } } });
    expect(controls.find((c) => c.param === "gpuTier")?.default).toBeUndefined();
    for (const id of ["oss-minimax-h3-fast", "oss-minimax-h3-trim"]) expect(getModel(id)!.options.controls, id).toBeUndefined();
  });
});
