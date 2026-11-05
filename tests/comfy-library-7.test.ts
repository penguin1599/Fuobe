import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GenInput } from "@/lib/catalog/types";
import type { ComfyWorkflow, Manifest } from "@/lib/comfy";
import { getModel } from "@/lib/catalog";
import { sizeValue } from "@/lib/catalog/payload";
import { compileMoss } from "@/lib/layout-prompt";
import { tempDir } from "./helpers/temp-dir";

// Research #7 (docs/research/new-models-7.md §4.4, §4.6): MOSS-Image's core-node graph in the ComfyUI library, its pinned
// weights, and how the provider fills it (a compiled layout reaches CLIPTextEncode verbatim; Quality / Fast settings).
const tmp = tempDir("fuobe-comfy-moss-");
process.env.FUOBE_DATA_DIR = tmp;
process.env.COMFYUI_URL = "http://comfy.test:8188";
const { prepareWorkflow } = await import("@/server/providers/comfyui");

const dir = path.join(process.cwd(), "workflows/comfyui");
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as Manifest;
const entry = manifest.workflows.find((w) => w.id === "moss-image-t2i")!;
const graph = JSON.parse(fs.readFileSync(path.join(dir, "moss-image-t2i.json"), "utf8")) as ComfyWorkflow;
const subset = JSON.parse(fs.readFileSync(path.join(dir, "object_info.subset.json"), "utf8")) as Record<string, unknown>;

const COMFY_ORG = "https://huggingface.co/Comfy-Org/MOSS-Image/resolve/530a4c94f92c35ef6818b1b035a983fe9dcf5f54";
const FAST = "https://huggingface.co/Spectrallic/MOSS-Image-SFT-8step-DMD-int8-convrot/resolve/8fdeb392c6322418687fc2519a7958c954497a22/moss_image_sft_8stepdmd_int8_convrot.safetensors";

describe("moss-image-t2i in the manifest", () => {
  it("is a t2i graph with the contract's bindings, limits and licence", () => {
    // Validated with its int8 encoder by a real run on a GPU.
    expect(entry).toMatchObject({ capability: "t2i", validated: true, vramGb: 16, customNodes: [], source: "hand-built (scripts/comfy/hand-built/moss-image-t2i.json)" });
    expect(Object.keys(entry.bindings).sort()).toEqual(["cfg", "filenamePrefix", "height", "negativePrompt", "prompt", "sampler", "scheduler", "seed", "steps", "unet", "width"]);
    expect(entry.limits).toEqual({ maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 });
    expect(entry.defaults).toEqual({ width: 1024, height: 1024, steps: 25, cfg: 2.5, sampler: "er_sde", scheduler: "simple", unet: "moss_image_sft_int8_convrot.safetensors" });
    // §4.5: every file's licence, the optional Fast file's too, and where the small decoder's bytes come from.
    expect(entry.license).toBe(
      "Apache-2.0 (MOSS-Image SFT and Base, Qwen3.5-9B, FLUX.2 small decoder, byte-identical to BFL's Apache-2.0 FLUX.2-small-decoder; " +
        "Fast: Spectrallic's MOSS-Image SFT 8-step DMD int8 file, Apache-2.0)",
    );
    expect(entry.outputs).toEqual([{ node: "10", kind: "image" }]);
    expect(entry.notes).toMatch(/The 16 GB VRAM figure is an estimate, as MOSS-Image publishes none/);
    expect(entry.notes).toMatch(/CUDA 13 \(cu130\): comfy\/quant_ops\.py/);
  });

  it("pins Comfy-Org's int8 set (15 GB), never the w4a8 encoder, and lists the Fast and Base files as optional", () => {
    expect(entry.models).toEqual([
      { file: "moss_image_sft_int8_convrot.safetensors", folder: "diffusion_models", url: `${COMFY_ORG}/diffusion_models/moss_image_sft_int8_convrot.safetensors`, sizeGb: 5.41 },
      // The int8 encoder, as FIBO 2's prompt writer loads it, never the template's w4a8 build (it faulted a GPU driver in testing).
      { file: "qwen3.5_9b_int8_convrot.safetensors", folder: "text_encoders", url: "https://huggingface.co/Comfy-Org/MOSS-Image/resolve/main/text_encoders/qwen3.5_9b_int8_convrot.safetensors", sizeGb: 9.75 },
      { file: "flux2-vae_small.safetensors", folder: "vae", url: `${COMFY_ORG}/vae/flux2-vae_small.safetensors`, sizeGb: 0.25 },
      { file: "moss_image_sft_8stepdmd_int8_convrot.safetensors", folder: "diffusion_models", url: FAST, sizeGb: 5.41, optional: true },
      { file: "moss_image_base_int8_convrot.safetensors", folder: "diffusion_models", url: `${COMFY_ORG}/diffusion_models/moss_image_base_int8_convrot.safetensors`, sizeGb: 5.41, optional: true },
    ]);
    expect(JSON.stringify(graph)).not.toMatch(/w4a8/);
    const required = entry.models.filter((m) => !m.optional).reduce((n, m) => n + (m.sizeGb ?? 0), 0);
    expect(required).toBeCloseTo(15.4, 1);
  });

  it("is core nodes only, wired as the Comfy template without its upsampler and box nodes", () => {
    expect(Object.fromEntries(Object.entries(graph).map(([id, n]) => [id, n.class_type]))).toEqual({
      "1": "UNETLoader",
      "2": "CLIPLoader",
      "3": "VAELoader",
      "4": "CLIPTextEncode",
      "5": "CLIPTextEncode",
      "6": "EmptyFlux2LatentImage",
      "7": "SkipLayerGuidanceDiTSimple",
      "8": "KSampler",
      "9": "VAEDecode",
      "10": "SaveImage",
    });
    for (const n of Object.values(graph)) expect(subset[n.class_type], n.class_type).toBeTruthy();
    expect(graph["2"].inputs).toMatchObject({ clip_name: "qwen3.5_9b_int8_convrot.safetensors", type: "moss_image" });
    expect(graph["5"].inputs.text).toBe("nsfw, worst quality, bad anatomy, watermark, jpeg artifact");
    expect(graph["7"].inputs).toEqual({ model: ["1", 0], double_layers: "", single_layers: "22", start_percent: 0, end_percent: 0.5 });
    expect(graph["8"].inputs).toMatchObject({ model: ["7", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0], denoise: 1 });
    expect(graph["9"].inputs).toEqual({ samples: ["8", 0], vae: ["3", 0] });
    // No TextGenerate (it would rewrite a layout) and no third-party loader.
    expect(JSON.stringify(graph)).not.toMatch(/TextGenerate|MOSSImageLayoutPrompt|MOSSImageUNETLoader|ModelSamplingSD3/);
  });
});

describe("the provider fills moss-image-t2i", () => {
  const prepare = async (input: GenInput) =>
    (await prepareWorkflow("moss-image-t2i", { seed: 7, ...input }, { generationId: "gen-moss", op: "t2i", upload: async (_d, _t, name) => `up_${name}` })).workflow;

  it("sends a compiled layout verbatim, at the size the aspect ratio and tier give", async () => {
    const layout = compileMoss(
      { summary: { caption: "雨中的街道。", meta: [], canvas: "single" }, items: [{ label: "text", caption: "Title.", text: "雨天", box: [0.1, 0.05, 0.9, 0.2] }] },
      1248,
      832,
    );
    const wf = await prepare({ prompt: layout, negativePrompt: "blurry", aspectRatio: "3:2", resolution: "1K" });
    expect(wf["4"].inputs.text).toBe(layout);
    expect(wf["5"].inputs.text).toBe("blurry");
    expect(wf["6"].inputs).toMatchObject({ width: 1248, height: 832 });
    expect(wf["8"].inputs).toMatchObject({ seed: 7, steps: 25, cfg: 2.5, sampler_name: "er_sde", scheduler: "simple" });
    expect(wf["1"].inputs.unet_name).toBe("moss_image_sft_int8_convrot.safetensors");
  });

  it("takes a layout's exact canvas and the Quality / Fast settings from params.extra", async () => {
    const best = await prepare({ prompt: "a poster", extra: { width: 1536, height: 1024, steps: 50, cfg: 3, sampler: "euler", scheduler: "simple", layout: { summary: {}, items: [] } } });
    expect(best["6"].inputs).toMatchObject({ width: 1536, height: 1024 });
    expect(best["8"].inputs).toMatchObject({ steps: 50, cfg: 3, sampler_name: "euler" });
    const fast = await prepare({ prompt: "a poster", extra: { steps: 8, cfg: 1, sampler: "euler", unet: "moss_image_sft_8stepdmd_int8_convrot.safetensors" } });
    expect(fast["1"].inputs.unet_name).toBe("moss_image_sft_8stepdmd_int8_convrot.safetensors");
    expect(fast["8"].inputs).toMatchObject({ steps: 8, cfg: 1 });
  });

  it("fits an asked canvas to the graph's grid and 2048 px limit, the size the cloud sends for it", async () => {
    const fal = getModel("moss-image")!.routes[0].map!.size!;
    for (const [w, h] of [
      [2560, 1000],
      [1000, 1000],
      [4096, 1024],
      [1536, 1024],
      [1250, 3000],
    ]) {
      const wf = await prepare({ prompt: "a poster", extra: { width: w, height: h, layout: { summary: {}, items: [] } } });
      const got = wf["6"].inputs as { width: number; height: number };
      expect(got.width % 16, `${w}x${h}`).toBe(0);
      expect(got.height % 16, `${w}x${h}`).toBe(0);
      expect(Math.max(got.width, got.height), `${w}x${h}`).toBeLessThanOrEqual(2048);
      // Past 512 a side both engines render one size, so a layout compiled at it lands where it was drawn.
      if (Math.min(w, h) >= 512) expect({ width: got.width, height: got.height }, `${w}x${h}`).toEqual(sizeValue(fal, undefined, undefined, { width: w, height: h }));
    }
    const wide = await prepare({ prompt: "a poster", extra: { width: 2560, height: 1000 } });
    expect(wide["6"].inputs).toMatchObject({ width: 2048, height: 800 });
  });

  it("keeps a wide shape within 2048 px on the 16-pixel grid", async () => {
    const wf = await prepare({ prompt: "a banner", aspectRatio: "21:9", resolution: "1.5K" });
    const { width, height } = wf["6"].inputs as { width: number; height: number };
    expect(width).toBeLessThanOrEqual(2048);
    expect(width % 16).toBe(0);
    expect(height % 16).toBe(0);
  });
});
