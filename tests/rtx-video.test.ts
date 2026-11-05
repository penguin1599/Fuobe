import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GenInput } from "@/lib/catalog/types";
import type { MediaInfo } from "@/lib/media-probe";
import type { GpuInventory, RequirementIndex } from "@/lib/gpu/types";

// NVIDIA RTX Video (package nm10-rtx-video): the three graphs against the pack's own node definitions, the chunk sizes, the
// frame counts and the HDR colour tags, the card check of the GPU pre-flight, and where the choices show up (never picked
// on a card that can't run them, never on the cloud).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fuobe-rtx-"));
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";
delete process.env.FUOBE_PASSWORD;

const RTX = await import("@/lib/catalog/rtx-video");
const { readCard, cardFits, offerOn, GPU_NEED_TEXT } = await import("@/lib/gpu/rtx");
const { badgeOf, cardLabel, stateLine, toolReadiness, workflowReadiness } = await import("@/lib/gpu/readiness");
const { parseIndex } = await import("@/lib/gpu/requirements");
const { emptyInventory } = await import("@/lib/gpu/gather");
const { parseArgv } = await import("@/lib/gpu/argv");
const { badgeText } = await import("@/hooks/use-gpu");
const { fpsFrames } = await import("@/lib/av/fps");
const { framesPerPass, rtxFrameGenFrames, rtxOutputSize, rtxScale, PASS_BUDGET } = await import("@/lib/av/video-finish");
const { getModel, getPreset, MODELS } = await import("@/lib/catalog");
const { planGeneration: planWith } = await import("@/lib/catalog/plan");
const planGeneration = (r: Parameters<typeof planWith>[0]) => planWith(r, getModel, getPreset);
const { runsOn } = await import("@/lib/catalog/engines");
const canvas = await import("@/lib/catalog/canvas");
const studios = await import("@/lib/studios");
const { NODE_PACKS, licenceInfo, workflowLicence } = await import("@/lib/licences");
const { prepareWorkflow, getWorkflow, promptRefusal } = await import("@/server/providers/comfyui");
const { STUDIO_ROWS, studioTool } = await import("@/server/gpu/tools");
const { runAsTenant } = await import("@/server/tenant");

const ROOT = path.resolve(__dirname, "..");
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const graphOf = (id: string) => read(`workflows/comfyui/${id}.json`) as Graph;
const manifest = read("workflows/comfyui/manifest.json") as { workflows: { id: string; gpu?: string; customNodes: { name: string }[]; bindings: Record<string, { node: string; input: string }[]>; defaults: Record<string, unknown>; validated: boolean }[] };
const entry = (id: string) => manifest.workflows.find((w) => w.id === id)!;
const idx: RequirementIndex = parseIndex(read("workflows/comfyui/requirements.json"));
const PACK = "ComfyUI_Nvidia_VFX_Nodes";

/**
 * The pack's node definitions at 38d790d (define_schema in __init__.py): every input with its options, and the keys a
 * DynamicCombo's nested input takes in an API prompt ("resize_type.scale").
 */
const SCHEMA: Record<string, Record<string, readonly (string | number | boolean)[] | "IMAGE" | "FLOAT" | "INT" | "BOOLEAN">> = {
  RTXVideoSuperResolution: {
    images: "IMAGE",
    resize_type: ["scale by multiplier", "target dimensions"],
    "resize_type.scale": "FLOAT",
    quality: [
      "BICUBIC", "LOW", "MEDIUM", "HIGH", "ULTRA", "DENOISE_LOW", "DENOISE_MEDIUM", "DENOISE_HIGH", "DENOISE_ULTRA", "DEBLUR_LOW", "DEBLUR_MEDIUM", "DEBLUR_HIGH",
      "DEBLUR_ULTRA", "HIGHBITRATE_LOW", "HIGHBITRATE_MEDIUM", "HIGHBITRATE_HIGH", "HIGHBITRATE_ULTRA", "STREAMING_MEDIUM", "STREAMING_ULTRA",
    ],
    strength: "FLOAT",
    image_encoding: ["8-bit RGB", "10-bit RGB (RGB10A2)"],
  },
  RTXVideoFrameGeneration: {
    images: "IMAGE",
    generation_type: ["frame rate multiplier", "specific timestep"],
    "generation_type.multiplier": "INT",
    mode: ["LOW", "MEDIUM", "HIGH"],
    automatic_shot_change_detection: "BOOLEAN",
    shot_change: "BOOLEAN",
    image_encoding: ["8-bit RGB", "10-bit RGB (RGB10A2)"],
  },
  RTXTrueHDR: {
    images: "IMAGE",
    contrast: "INT",
    saturation: "INT",
    middle_gray: "INT",
    luminance: "INT",
    debanding: "BOOLEAN",
    output_colorspace: ["HDR", "HDR PQ"],
  },
};

describe("the graphs against the pack's node definitions", () => {
  const isLink = (v: unknown) => Array.isArray(v) && v.length === 2 && typeof v[0] === "string";
  it.each([RTX.RTX_UPSCALE_WORKFLOW, RTX.RTX_FRAMEGEN_WORKFLOW, RTX.RTX_HDR_WORKFLOW])("%s sets only the pack's inputs, with values it takes", (id) => {
    const g = graphOf(id);
    const nodes = Object.values(g).filter((n) => n.class_type in SCHEMA);
    expect(nodes).toHaveLength(1);
    for (const n of nodes) {
      const schema = SCHEMA[n.class_type];
      // Every input the node needs is there (the DynamicCombo's nested one for the option picked), and nothing else.
      expect(Object.keys(n.inputs).sort()).toEqual(Object.keys(schema).sort());
      for (const [input, v] of Object.entries(n.inputs)) {
        const s = schema[input];
        if (isLink(v)) continue;
        if (Array.isArray(s)) expect(s, `${n.class_type}.${input}`).toContain(v);
        else if (s === "BOOLEAN") expect(typeof v).toBe("boolean");
        else expect(typeof v, `${n.class_type}.${input}`).toBe("number");
      }
    }
  });

  it("names the pack, the card and no model files; listed as not validated here", () => {
    for (const [id, gpu] of [
      [RTX.RTX_UPSCALE_WORKFLOW, "nvidia-rtx"],
      [RTX.RTX_FRAMEGEN_WORKFLOW, "nvidia-rtx-40"],
      [RTX.RTX_HDR_WORKFLOW, "nvidia-rtx"],
    ] as const) {
      const w = entry(id);
      expect(w.gpu).toBe(gpu);
      expect(w.customNodes.map((c) => c.name)).toContain(PACK);
      expect(w.validated).toBe(false);
      expect(idx.workflows[id].gpu).toBe(gpu);
      expect(idx.workflows[id].files).toEqual([]);
      expect(idx.workflows[id].packs[PACK].length).toBe(1);
    }
    expect(idx.packs[PACK]).toMatchObject({ commit: "38d790ded00650681fa3645362efe28c8560cf40", requirementsTxt: true, registry: { id: "comfyui_nvidia_rtx_nodes" } });
    expect(idx.packs[PACK].classes).toEqual(["RTXTrueHDR", "RTXVideoFrameGeneration", "RTXVideoSuperResolution"]);
  });

  it("the installer adds the pack only on an NVIDIA RTX host, at the pinned commit with the runtime", () => {
    const sh = fs.readFileSync(path.join(ROOT, "scripts/comfy/install-comfyui.sh"), "utf8");
    expect(sh).toContain('RTX_VIDEO_REF="${RTX_VIDEO_REF:-38d790ded00650681fa3645362efe28c8560cf40}"');
    expect(sh).toMatch(/nvidia-smi --query-gpu=name --format=csv,noheader .*grep -i -m1 -E 'RTX'/);
    expect(sh).toContain('[ "$(uname -m)" = "x86_64" ] || rtx_card=""');
    expect(sh).toContain('"nvidia-vfx==0.2.0.0"');
    expect(sh).toContain('"${RTX_VIDEO:-auto}" = "auto" ] && [ -n "$rtx_card" ]');
  });
});

describe("upscale in passes", () => {
  it("scales by the shorter edge asked for, 1-4x, and lands exactly on it", () => {
    const g = graphOf(RTX.RTX_UPSCALE_WORKFLOW);
    expect(g["5"].inputs.expression).toBe("min(4, max(1, a / min(b, c)))");
    expect(g["6"].inputs["resize_type.scale"]).toEqual(["5", 0]);
    expect(g["7"].inputs).toMatchObject({ input: ["6", 0], resize_type: "scale shorter dimension", "resize_type.shorter_size": ["4", 0] });
    // The source's sound and frame rate, one encode across the passes.
    expect(g["8"].inputs).toMatchObject({ audio: ["1", 2], frame_rate: ["3", 5], meta_batch: ["2", 0] });
    expect(rtxScale({ width: 640, height: 360 }, 1080)).toBe(3);
    expect(rtxScale({ width: 320, height: 180 }, 2160)).toBe(4);
    expect(rtxScale({ width: 1920, height: 1080 }, 720)).toBe(1);
    expect(rtxScale({}, 1080)).toBe(4);
    // The pack rounds the node's output to multiples of 8 (1280x720 x 1.5 = 1920x1080; 854x480 x 2.25 = 1920x1080).
    expect(rtxOutputSize(1280, 720, 1.5)).toEqual({ width: 1920, height: 1080 });
    expect(rtxOutputSize(854, 480, 2.25)).toEqual({ width: 1920, height: 1080 });
  });

  it("sizes a pass so its frames stay near the budget", () => {
    const facts = { width: 640, height: 360 };
    const rtx = framesPerPass(facts, { shortSide: 1080, modelScale: rtxScale(facts, 1080), min: 1, max: 64, fallback: 16 });
    const esrgan = framesPerPass(facts, { shortSide: 1080, modelScale: 4, min: 1, max: 64, fallback: 16 });
    // RTX writes the frame at 3x, not ESRGAN's fixed 4x, so a pass holds more frames.
    expect(rtx).toBeGreaterThan(esrgan);
    expect(12 * 640 * 360 * (1 + 9 + 9) * rtx).toBeLessThanOrEqual(PASS_BUDGET);
    expect(framesPerPass({}, { shortSide: 1080, modelScale: 4, fallback: 16 })).toBe(16);
  });

  it("the provider fills the short side, the pass size and the quality", async () => {
    const { workflow } = await prepareWorkflow(
      RTX.RTX_UPSCALE_WORKFLOW,
      { video: "clip.mp4", resolution: "2160p", extra: { rtxQuality: "HIGHBITRATE_ULTRA" } } as GenInput,
      { generationId: "g1", op: "upscale-video", upload: async (_d, _t, n) => n, media: () => clip(1280, 720, 4) },
    );
    expect(workflow["4"].inputs.value).toBe(2160);
    expect(workflow["6"].inputs.quality).toBe("HIGHBITRATE_ULTRA");
    expect(workflow["2"].inputs.frames_per_batch).toBe(framesPerPass({ width: 1280, height: 720 }, { shortSide: 2160, modelScale: 3, min: 1, max: 64, fallback: 16 }));
  });
});

const clip = (w: number, h: number, seconds: number, fps = 24): MediaInfo => ({
  container: "mp4",
  hasVideo: true,
  hasAudio: true,
  duration: seconds,
  videoDuration: seconds,
  width: w,
  height: h,
  fps,
  frames: Math.round(seconds * fps),
});

describe("frame generation", () => {
  it("returns (N - 1) x m + 1 frames, and a clip's N frames become N x m + 1 with the last held", () => {
    expect(rtxFrameGenFrames(48, 2)).toBe(95);
    expect(rtxFrameGenFrames(25, 5)).toBe(121);
    expect(rtxFrameGenFrames(1, 4)).toBe(1);
    // The graph holds the last frame once more, so it writes what RIFE's graph writes.
    for (const [n, m] of [[48, 5], [60, 2], [73, 16]]) expect(rtxFrameGenFrames(n + 1, m)).toBe(fpsFrames(n, { multiplier: m, every: 1 }));
    const g = graphOf(RTX.RTX_FRAMEGEN_WORKFLOW);
    expect(g["4"].inputs).toEqual({ image1: ["2", 0], image2: ["3", 0] });
    expect(g["7"].inputs).toMatchObject({ images: ["4", 0], generation_type: "frame rate multiplier", "generation_type.multiplier": ["6", 0], automatic_shot_change_detection: true, shot_change: false });
  });

  it("picks m and n from the clip's rate, and links the node out when no frame needs making", async () => {
    const run = (target: number, fps: number) =>
      prepareWorkflow(RTX.RTX_FRAMEGEN_WORKFLOW, { video: "clip.mp4", targetFps: target } as GenInput, {
        generationId: "g2",
        op: "interpolate",
        upload: async (_d, _t, n) => n,
        media: () => clip(320, 180, 2, fps),
      });
    const up = (await run(60, 24)).workflow;
    expect([up["6"].inputs.value, up["8"].inputs.value]).toEqual([5, 2]);
    expect(up["7"]?.class_type).toBe("RTXVideoFrameGeneration");
    const down = (await run(30, 60)).workflow;
    expect(down["6"].inputs.value).toBe(1);
    expect(down["7"]).toBeUndefined();
    expect(down["9"].inputs.images).toEqual(["4", 0]);
  });
});

describe("HDR colour tags", () => {
  const run = (format: string, peak?: number) =>
    prepareWorkflow(RTX.RTX_HDR_WORKFLOW, { video: "clip.mp4", format, ...(peak && { extra: { peakNits: peak } }) } as GenInput, {
      generationId: "g3",
      op: "sdr-to-hdr",
      upload: async (_d, _t, n) => n,
      media: () => clip(320, 180, 2),
    });

  it("the node's output and the encoder's tags always say the same transfer", async () => {
    const hlg = (await run("hlg_10bit")).workflow;
    expect([hlg["3"].inputs.output_colorspace, hlg["4"].inputs.color_space, hlg["4"].inputs.bit_depth]).toEqual(["HDR", "HDR", 10]);
    const pq = (await run("pq_10bit", 1000)).workflow;
    expect([pq["3"].inputs.output_colorspace, pq["4"].inputs.color_space]).toEqual(["HDR PQ", "HDR PQ"]);
    expect(pq["3"].inputs.luminance).toBe(1000);
    // CreateVideo takes exactly the node's two colour spaces (core ComfyUI's options at the pinned version).
    const subset = read("workflows/comfyui/object_info.subset.json");
    expect(subset.CreateVideo.input.optional.color_space[1].options).toEqual(expect.arrayContaining(SCHEMA.RTXTrueHDR.output_colorspace as string[]));
    expect(entry(RTX.RTX_HDR_WORKFLOW).bindings.colorSpace).toEqual([
      { node: "3", input: "output_colorspace" },
      { node: "4", input: "color_space" },
    ]);
  });

  it("EXR frames stay with the other SDR to HDR graph", () => {
    expect(() => planGeneration({ modelId: RTX.RTX_HDR_MODEL, operation: "sdr-to-hdr", prompt: "", params: { format: "exr" }, inputs: { video: "/x.mp4" } } as never)).toThrow(/HLG|HDR10|PQ/);
  });
});

describe("the card check", () => {
  it("reads RTX cards and their series from the names ComfyUI reports", () => {
    expect(readCard("cuda:0 NVIDIA GeForce RTX 4070 : cudaMallocAsync")).toEqual({ rtx: true, series: 40 });
    expect(readCard("RTX 5090")).toEqual({ rtx: true, series: 50 });
    expect(readCard("NVIDIA GeForce RTX 3060 Laptop GPU")).toEqual({ rtx: true, series: 30 });
    expect(readCard("NVIDIA GeForce RTX 2080 Ti")).toEqual({ rtx: true, series: 20 });
    expect(readCard("NVIDIA RTX A6000")).toEqual({ rtx: true, series: 30 });
    expect(readCard("NVIDIA RTX 6000 Ada Generation")).toEqual({ rtx: true, series: 40 });
    expect(readCard("NVIDIA RTX PRO 6000 Blackwell Workstation Edition")).toEqual({ rtx: true, series: 50 });
    expect(readCard("Quadro RTX 8000")).toEqual({ rtx: true, series: 20 });
    expect(readCard("NVIDIA GB10")).toEqual({ rtx: undefined });
    expect(readCard("NVIDIA GeForce GTX 1080 Ti").rtx).toBe(false);
    expect(readCard("cuda:0 AMD Radeon RX 7900 XTX : native").rtx).toBe(false);
    expect(readCard("mps", "mps").rtx).toBe(false);
    expect(readCard("cpu", "cpu").rtx).toBe(false);
    // A data-centre card's name doesn't say: never blocked, never picked.
    expect(readCard("NVIDIA A100-SXM4-80GB").rtx).toBeUndefined();
    expect(readCard("NVIDIA H100 80GB HBM3").rtx).toBeUndefined();
    expect(readCard(undefined).rtx).toBeUndefined();
    expect(cardFits("nvidia-rtx-40", readCard("RTX 3090"))).toBe(false);
    expect(cardFits("nvidia-rtx-40", readCard("RTX 4060"))).toBe(true);
    expect(cardFits("nvidia-rtx", readCard("RTX 3090"))).toBe(true);
    expect(offerOn("nvidia-rtx", undefined)).toBe(false);
    expect(offerOn("nvidia-rtx", "H100 80GB HBM3")).toBe(false);
  });

  const GB = 2 ** 30;
  function inventory(device: { name: string; type: string } | null, o: { cpuOnly?: boolean } = {}): GpuInventory {
    const inv = emptyInventory("server", 1);
    inv.reachable = true;
    inv.comfy = { version: "0.42.1", os: "posix", embeddedPython: false, deployEnv: "local-git", flags: parseArgv(o.cpuOnly ? ["main.py", "--cpu"] : ["main.py"]) };
    inv.devices = device ? [{ ...device, index: 0, vramTotal: 16 * GB, vramFree: 0 }] : [];
    inv.manager = { api: "none" };
    const all = new Set(Object.values(idx.workflows).flatMap((w) => [...w.core, ...Object.values(w.packs).flat()]));
    inv.nodes = { have: [...all], missing: [], total: all.size, readAt: 1, how: "object_info" };
    for (const folder of idx.folders) inv.models[folder] = { have: {}, total: 0 };
    return inv;
  }
  const ctx = { account: false };
  const rtx4070 = { name: "cuda:0 NVIDIA GeForce RTX 4070 : cudaMallocAsync", type: "cuda" };
  const rtx3090 = { name: "cuda:0 NVIDIA GeForce RTX 3090 : cudaMallocAsync", type: "cuda" };

  it("the pre-flight says 'Needs an NVIDIA RTX card' on a CPU, AMD or GTX card, and RTX 40+ for frame generation", () => {
    const at = (id: string, inv: GpuInventory) => workflowReadiness(id, inv, idx, ctx);
    expect(at(RTX.RTX_UPSCALE_WORKFLOW, inventory(rtx4070)).state).toBe("ready");
    expect(at(RTX.RTX_FRAMEGEN_WORKFLOW, inventory(rtx4070)).state).toBe("ready");
    expect(at(RTX.RTX_HDR_WORKFLOW, inventory(rtx3090)).state).toBe("ready");
    expect(at(RTX.RTX_FRAMEGEN_WORKFLOW, inventory(rtx3090))).toMatchObject({ state: "unsupported", reason: "Needs an NVIDIA RTX 40 series card or newer", gpuNeed: "nvidia-rtx-40" });
    for (const inv of [
      inventory({ name: "cpu", type: "cpu" }),
      inventory(rtx4070, { cpuOnly: true }),
      inventory({ name: "cuda:0 AMD Radeon RX 7900 XTX : native", type: "cuda" }),
      inventory({ name: "cuda:0 NVIDIA GeForce GTX 1080 : cudaMallocAsync", type: "cuda" }),
      inventory({ name: "mps", type: "mps" }),
    ]) {
      expect(at(RTX.RTX_UPSCALE_WORKFLOW, inv)).toMatchObject({ state: "unsupported", reason: GPU_NEED_TEXT["nvidia-rtx"] });
    }
    // Not read, or a name that doesn't say: never blocked.
    expect(at(RTX.RTX_UPSCALE_WORKFLOW, inventory(null)).state).not.toBe("unsupported");
    expect(at(RTX.RTX_UPSCALE_WORKFLOW, inventory({ name: "cuda:0 NVIDIA H100 80GB HBM3 : cudaMallocAsync", type: "cuda" })).state).toBe("ready");
    // Other graphs don't care about the card's make.
    expect(at("upscale-video-esrgan-chunked", inventory({ name: "cpu", type: "cpu" })).state).not.toBe("unsupported");
  });

  it("the chip, the board line and the tool all say why", () => {
    const tool = (inv: GpuInventory, id = RTX.RTX_UPSCALE_WORKFLOW) => toolReadiness("model:x#upscale-video", "RTX", [id], [], inv, idx, ctx);
    const amd = tool(inventory({ name: "cuda:0 AMD Radeon RX 7900 XTX : native", type: "cuda" }));
    expect(amd.gpuNeed).toBe("nvidia-rtx");
    expect(stateLine(amd)).toBe("Needs an NVIDIA RTX card");
    const chip = badgeOf(amd)!;
    expect(chip[0]).toBe("u");
    expect(badgeText(chip)).toEqual({ short: "RTX only", long: "Needs an NVIDIA RTX card" });
    const old = badgeOf(tool(inventory(rtx3090), RTX.RTX_FRAMEGEN_WORKFLOW))!;
    expect(badgeText(old).long).toBe("Needs an NVIDIA RTX 40 series card or newer");
    // On an RTX card it's ready, and never "Runs on any computer".
    const ok = tool(inventory(rtx4070));
    expect(ok.state).toBe("ready");
    expect(stateLine(ok)).toBe("Ready");
    expect(badgeOf(ok)![3] & 4).toBe(0);
  });

  it("a choice is offered first only on a card known to run it", () => {
    expect(RTX.rtxStanding("nvidia-rtx", "RTX 4070")).toBe("fits");
    expect(RTX.rtxStanding("nvidia-rtx-40", "RTX 3080")).toBe("no");
    expect(RTX.rtxStanding("nvidia-rtx", "GTX 1660")).toBe("no");
    expect(RTX.rtxStanding("nvidia-rtx", undefined)).toBe("unknown");
    expect(RTX.rtxStanding("nvidia-rtx", "H100 80GB HBM3")).toBe("unknown");
    // A CPU or Apple ComfyUI reports no card name: the model's own chip says it can't run there.
    expect(RTX.rtxStanding("nvidia-rtx", undefined, true)).toBe("no");
  });
});

describe("where the choices show up", () => {
  const ids = [RTX.RTX_UPSCALE_MODEL, RTX.RTX_FRAMEGEN_MODEL, RTX.RTX_HDR_MODEL];

  it("open-engine models only: nobody hosts NVIDIA's SDK", () => {
    for (const id of ids) {
      const m = getModel(id)!;
      expect(m.engine).toBe("open");
      expect(runsOn(m, "cloud")).toBe(false);
      expect(m.routes.every((r) => r.provider === "comfyui")).toBe(true);
      expect(m.tagline).toMatch(/RTX/);
    }
    expect(getModel(RTX.RTX_UPSCALE_MODEL)!.routes[0]).toMatchObject({ op: "upscale-video", endpoint: RTX.RTX_UPSCALE_WORKFLOW });
    expect(getModel(RTX.RTX_FRAMEGEN_MODEL)!.routes[0]).toMatchObject({ op: "interpolate", endpoint: RTX.RTX_FRAMEGEN_WORKFLOW });
    expect(getModel(RTX.RTX_HDR_MODEL)!.routes[0]).toMatchObject({ op: "sdr-to-hdr", endpoint: RTX.RTX_HDR_WORKFLOW });
    expect(getWorkflow(RTX.RTX_HDR_WORKFLOW).manifest.capability).toBe("sdr-to-hdr");
  });

  it("keeps today's defaults, and no default pick lands on them", () => {
    expect(studios.VIDEO_UPSCALE_STUDIO.defaultModels.open).toBe("oss-seedvr2");
    expect(studios.FPS_BOOST_STUDIO.defaultModels.open).toBe("oss-rife");
    expect(studios.SDR_TO_HDR_STUDIO.defaultModels.open).toBe("oss-sdr-to-hdr");
    for (const op of ["upscale-video", "interpolate", "sdr-to-hdr"] as const) expect(ids).not.toContain(canvas.defaultModelFor(op, "open")?.id);
    // Listed after each tool's own models.
    const at = (id: string) => MODELS.findIndex((m) => m.id === id);
    expect(at(RTX.RTX_UPSCALE_MODEL)).toBeGreaterThan(at("oss-upscale-video-esrgan"));
    expect(at(RTX.RTX_FRAMEGEN_MODEL)).toBeGreaterThan(at("oss-rife"));
    expect(at(RTX.RTX_HDR_MODEL)).toBeGreaterThan(at("oss-sdr-to-hdr"));
  });

  it("the board has a row for each, and the Canvas Upscale node an RTX entry with no cloud stand-in", () => {
    for (const [href, id] of [
      [`/upscale/video?model=${RTX.RTX_UPSCALE_MODEL}`, RTX.RTX_UPSCALE_WORKFLOW],
      [`/upscale/fps?model=${RTX.RTX_FRAMEGEN_MODEL}`, RTX.RTX_FRAMEGEN_WORKFLOW],
      [`/upscale/hdr?model=${RTX.RTX_HDR_MODEL}`, RTX.RTX_HDR_WORKFLOW],
    ]) {
      const row = STUDIO_ROWS.find((r) => r.href === href)!;
      expect(row.group).toBe("Video tools");
      expect(studioTool(row)!.workflows).toEqual([id]);
    }
    const item = canvas.paletteItems("both", "open").find((p) => p.id === "upscale-rtx")!;
    expect(item.data).toMatchObject({ mediaKind: "video", modelId: RTX.RTX_UPSCALE_MODEL });
    expect(item.disabled).toBeUndefined();
    expect(canvas.paletteItems("both", "cloud").find((p) => p.id === "upscale-rtx")!.disabled).toBe(canvas.GPU_ONLY_ENTRY);
    const node = { id: "n1", type: "upscale" as const, position: { x: 0, y: 0 }, data: { mediaKind: "video" as const, modelId: RTX.RTX_UPSCALE_MODEL } };
    expect(canvas.defaultModelForNode(node, "open")?.id).toBe(RTX.RTX_UPSCALE_MODEL);
    expect(canvas.counterpart({ nodes: [node], edges: [] } as never, node as never, "cloud")).toBeUndefined();
  });

  it("records the licences as information", () => {
    const pack = NODE_PACKS.find((p) => p.name === PACK)!;
    expect(pack.licence).toMatchObject({ name: "Apache-2.0", class: "commercial" });
    expect(pack.licence.note).toMatch(/NVIDIA Software License Agreement/);
    const info = licenceInfo(workflowLicence({ id: RTX.RTX_UPSCALE_WORKFLOW, license: read("workflows/comfyui/manifest.json").workflows.find((w: { id: string }) => w.id === RTX.RTX_UPSCALE_WORKFLOW).license }));
    expect(info).toMatchObject({ name: "NVIDIA Software License Agreement", class: "conditions" });
  });

  it("a ComfyUI without the nodes gets plain words", () => {
    const body = { error: { type: "missing_node_type", message: "Node 'x' not found" } };
    const { message } = promptRefusal(body, 400, getWorkflow(RTX.RTX_UPSCALE_WORKFLOW).manifest, []);
    expect(message).toBe(RTX.RTX_MISSING.owner);
    // An account's run on this install's GPUs (a hosted run) gets the visitor's words, never the setup script's name.
    const pooled = runAsTenant({ kind: "account", id: "acct-rtx" }, () => promptRefusal(body, 400, getWorkflow(RTX.RTX_UPSCALE_WORKFLOW).manifest, []));
    expect(pooled.message).toBe(RTX.RTX_MISSING.visitor);
    expect(pooled.message).not.toMatch(/install-comfyui|RTX_VIDEO|scripts\//);
  });

  it("the guided fix names a graphics card only when it is one (never 'your cpu' or 'your mps')", () => {
    expect(cardLabel({ name: "cpu", type: "cpu" })).toBeUndefined();
    expect(cardLabel({ name: "mps", type: "mps" })).toBeUndefined();
    expect(cardLabel({ name: "cuda:0", type: "cuda" })).toBeUndefined();
    expect(cardLabel(undefined)).toBeUndefined();
    expect(cardLabel({ name: "cuda:0 NVIDIA GeForce GTX 1080 Ti : cudaMallocAsync", type: "cuda" })).toBe("NVIDIA GeForce GTX 1080 Ti");
    const fix = fs.readFileSync(path.join(ROOT, "src/components/gpu/guided-fix.tsx"), "utf8");
    expect(fix).not.toContain("The other choices in this tool work on your GPU");
    // The arrow keys skip a choice that is switched off (Quick · RTX on a card that can't run it).
    expect(fs.readFileSync(path.join(ROOT, "src/components/studio/radio-keys.ts"), "utf8")).toContain(':not([aria-disabled="true"])');
  });
});
