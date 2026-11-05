import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers/temp-dir";
import { getModel, getPreset } from "@/lib/catalog";
import { buildPayload } from "@/lib/catalog/payload";
import { estimateCost, planGeneration, routesFor, sourceLengthProblem } from "@/lib/catalog/plan";
import type { GenerationRequest, GenInput, ModelDef, ModelRoute, Operation } from "@/lib/catalog/types";
import { PROMPT_HELPER_GRAPHS, PROMPT_HELPER_OPT_IN, skipPromptHelper, type ComfyWorkflow, type Manifest } from "@/lib/comfy";
import { clipBlocker, clipOutcome, relatedHref } from "@/lib/composer";
import { factorTier, factorTierProblem, sideMultipleProblem, upscaleFactorFor, upscaledSize } from "@/lib/av/upscale";
import { inKandinskyForm, kandinskyPrompt } from "@/lib/kandinsky-prompt";
import { NODE_PACKS } from "@/lib/licences";
import type { MediaInfo } from "@/lib/media-probe";
import { LIPSYNC_STUDIO } from "@/lib/studios";

// Package nm10-kandinsky6 (docs/research/new-models-10.md §2.1, §2.6): Kandinsky 6.0 on both engines. Kandinsky Lab's packs
// (kandinsky6, kandinsky6-sr) on your GPU, fal's Pro / Lite / VSR in the cloud, priced by steps and per output frame.
const tmp = tempDir("fuobe-k6-");
process.env.FUOBE_DATA_DIR = tmp;
process.env.COMFYUI_URL = "http://comfy.test:8188";
const { prepareWorkflow } = await import("@/server/providers/comfyui");
const { STUDIO_ROWS } = await import("@/server/gpu/tools");

const dir = path.join(process.cwd(), "workflows/comfyui");
const read = <T>(f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as T;
const manifest = read<Manifest>("manifest.json");
const packs = read<Record<string, { repo: string; commit: string; subdir: string | null; registry: { id: string; version: string } | null }>>("packs.json");
const pins = read<Record<string, { revision: string; sizeBytes: number; sha256?: string }>>("model-pins.json");
const requirements = read<{ workflows: Record<string, { packs: Record<string, string[]>; files: string[]; optional: string[]; vramGb: number }> }>("requirements.json");
const subset = read<Record<string, { python_module: string; input: { required: Record<string, unknown>; optional?: Record<string, unknown> } } | null>>("object_info.subset.json");
const entry = (id: string) => manifest.workflows.find((w) => w.id === id)!;
const graph = (id: string) => read<ComfyWorkflow>(`${id}.json`);
const GRAPHS = ["kandinsky6-t2av", "kandinsky6-i2av", "video-upscale-kandinsky6-vsr"];

const open = getModel("oss-kandinsky6")!;
const cloud = getModel("kandinsky-6")!;
const vsrOpen = getModel("oss-kandinsky6-vsr")!;
const vsrCloud = getModel("kandinsky-vsr")!;
const plan = (req: Partial<GenerationRequest>) => planGeneration({ feature: "video", prompt: "a fox says “hello”", ...req } as GenerationRequest, getModel, getPreset);
const fullRoute = (r: ModelRoute) => r as ModelRoute & { map: NonNullable<ModelRoute["map"]> };

async function prepare(id: string, input: GenInput, op: Operation, media?: Record<string, { width?: number; height?: number; duration?: number }>) {
  const facts = (n: string): MediaInfo | undefined => (media?.[n] ? { container: "mp4", hasVideo: true, hasAudio: true, ...media[n] } : undefined);
  return prepareWorkflow(id, { seed: 7, ...input }, { generationId: "g-k6", op, upload: async (_d, _t, name) => `up_${name}`, media: facts });
}

describe("Kandinsky 6.0's graphs in the library", () => {
  it("follow the packs' templates, wait for the packs, and say what each file's licence is", () => {
    for (const id of GRAPHS) {
      const e = entry(id);
      const pack = id.startsWith("video-upscale") ? "kandinsky6-sr" : "kandinsky6";
      expect(e.customNodes?.map((c) => c.name), id).toEqual([pack]);
      expect(e.validated, id).toBe(false); // the packs aren't on the validation ComfyUI
      expect(requirements.workflows[id].packs[pack].length, id).toBeGreaterThan(0);
      for (const n of Object.values(graph(id))) expect(subset[n.class_type], `${id} ${n.class_type}`).toBeTruthy();
      for (const m of e.models) {
        expect(m.url, `${id} ${m.file}`).toMatch(/^https:\/\/huggingface\.co\//);
        expect(pins[m.url!], `${id} ${m.file} pinned`).toBeTruthy();
      }
    }
    // The packs: their Registry versions and the comfyui/ folder of each repository, at the pinned commits.
    expect(packs.kandinsky6).toMatchObject({ commit: "7ceeefad7fb625011f7db602c43893a989f19c15", subdir: "comfyui", registry: { id: "kandinsky6", version: "1.0.2" } });
    expect(packs["kandinsky6-sr"]).toMatchObject({ commit: "b15e2aac526519c51f59dfec2b848355bb8902de", subdir: "comfyui", registry: { id: "kandinsky6-sr", version: "0.1.2" } });
    for (const [cls, pack] of [["Kandinsky6Sampler", "kandinsky6"], ["Kandinsky6BeautifyPrompt", "kandinsky6"], ["Kandinsky6VSRUpscale", "kandinsky6-sr"]]) {
      expect(subset[cls]!.python_module).toBe(`custom_nodes.${pack}`);
    }
    // Weights MIT; the audio VAE file the pack loads is non-commercial and the HunyuanVideo VAE leaves out three territories.
    expect(entry("kandinsky6-t2av").license).toMatch(/^MIT \(Kandinsky 6\.0 Lite and Pro distilled weights/);
    expect(entry("kandinsky6-t2av").license).toMatch(/v1-44\.pth.*CC BY-NC 4\.0 \(NON-COMMERCIAL\)/);
    expect(entry("video-upscale-kandinsky6-vsr").license).toMatch(/^MIT \(Kandinsky 6\.0 VSR weights/);
    for (const name of ["kandinsky6", "kandinsky6-sr"]) expect(NODE_PACKS.find((p) => p.name === name)?.licence.class, name).toBe("commercial");
  });

  it("make 5 s at 24 fps on Lite by default, Pro as an optional 60 GB file, and the VSR's bundle with its configs", () => {
    const t2v = entry("kandinsky6-t2av");
    expect(t2v.defaults).toMatchObject({ width: 864, height: 480, frames: 121, fps: 24, frameStep: 4, unet: "Kandinsky-6.0-Lite-distill-5s-Diffusers/transformer/diffusion_pytorch_model.safetensors" });
    expect(t2v.limits).toMatchObject({ maxFrames: 121, dimensionMultiple: 16 });
    const pro = t2v.models.find((m) => m.file.startsWith("Kandinsky-6.0-Pro-distill"))!;
    expect(pro).toMatchObject({ folder: "diffusion_models", optional: true, sizeGb: 60.34 });
    expect(t2v.models.find((m) => m.file === "v1-44.pth")).toMatchObject({ folder: "audio_vae" });
    expect(t2v.models.map((m) => m.file)).toEqual(expect.arrayContaining(["bigvgan_vocoder/bigvgan_generator.pt", "bigvgan_vocoder/config.json", "qwen_2.5_vl_7b.safetensors", "clip_l.safetensors", "hunyuan_video_vae_bf16.safetensors"]));
    // Pro and the Prompt helper's 19 GB Qwen3.5 9B are needed only when picked (Quality "pro", Prompt helper "on").
    for (const id of ["kandinsky6-t2av", "kandinsky6-i2av"]) {
      expect(requirements.workflows[id].optional, id).toEqual(["diffusion_models/Kandinsky-6.0-Pro-distill-5s-Diffusers/transformer/diffusion_pytorch_model.safetensors", "text_encoders/qwen3.5_9b_bf16.safetensors"]);
      expect(requirements.workflows[id].files, id).not.toContain("text_encoders/qwen3.5_9b_bf16.safetensors");
    }
    expect(t2v.models.find((m) => m.file === "qwen3.5_9b_bf16.safetensors")).toMatchObject({ optional: true });
    const g = graph("kandinsky6-t2av");
    expect(g["8"].inputs).toMatchObject({ steps: 10, cfg: 1, denoise: 1 });
    expect(g["2"].inputs).toMatchObject({ clip_name1: "qwen_2.5_vl_7b.safetensors", clip_name2: "clip_l.safetensors", type: "kandinsky5" });
    expect(g["4"].inputs).toMatchObject({ tod_vae: "v1-44.pth", bigvgan_dir: "bigvgan_vocoder", mode: "44k", scaling_factor: 0.417 });
    // Image to video: the picture is the first frame, cropped to the clip's size and taken off again before decoding.
    const i2v = graph("kandinsky6-i2av");
    expect(entry("kandinsky6-i2av").bindings.width).toEqual([{ node: "7", input: "width" }, { node: "31", input: "width" }]);
    expect(i2v["33"].class_type).toBe("Kandinsky6ImageToVideoAudio");
    expect(i2v["9"].inputs.samples).toEqual(["34", 0]);
    // The VSR: every file the loaders list it by, configs included.
    const vsr = entry("video-upscale-kandinsky6-vsr");
    expect(vsr.models.map((m) => m.file.replace("Kandinsky-6.0-VSR-distilled2steps-5s-Diffusers/", "")).sort()).toEqual(
      ["latent_upscaler/config.json", "latent_upscaler/diffusion_pytorch_model.safetensors", "model_index.json", "scheduler/scheduler_config.json", "transformer/config.json", "transformer/diffusion_pytorch_model.safetensors", "vae/config.json", "vae/diffusion_pytorch_model.safetensors"],
    );
    expect(vsr.limits).toEqual({ maxDurationSec: 5 });
    expect(Object.keys(vsr.bindings).sort()).toEqual(["filenamePrefix", "scale", "seed", "upscalerScale", "video"]);
  });
});

describe("Kandinsky 6.0 on your GPU", () => {
  it("is in the Video studio on Lite with its sound always on, and Quality picks the transformer", () => {
    expect(open).toMatchObject({ engine: "open", kind: "video", name: "Kandinsky 6.0" });
    expect(open.tagline).toMatch(/^Kandinsky 6\.0 · both engines/);
    expect(open.routes.map((r) => [r.op, r.endpoint])).toEqual([["t2v", "kandinsky6-t2av"], ["i2v", "kandinsky6-i2av"]]);
    expect(open.options).toMatchObject({ durations: [5], resolutions: ["480p"], audio: "always", promptFormat: "kandinsky6" });
    const p = plan({ modelId: open.id, params: { extra: { quality: "pro" } } });
    expect(p.params.extra).toEqual({ unet: "Kandinsky-6.0-Pro-distill-5s-Diffusers/transformer/diffusion_pytorch_model.safetensors" });
    expect(plan({ modelId: open.id }).params.extra?.unet).toMatch(/^Kandinsky-6\.0-Lite-distill/);
    expect(estimateCost(open, p.params, 1, "t2v")).toBe(0);
  });

  it("sizes 5 s at 24 fps on the 16 px grid, takes the helper out unless it is on, and puts the transformer in the loader", async () => {
    const t2v = await prepare("kandinsky6-t2av", { prompt: "A woman says <S>Hi<E>", aspectRatio: "16:9", resolution: "480p", duration: 5, extra: { unet: "Kandinsky-6.0-Pro-distill-5s-Diffusers/transformer/diffusion_pytorch_model.safetensors" } }, "t2v");
    const wf = t2v.workflow;
    expect(wf["7"].inputs).toMatchObject({ length: 121, fps: 24 });
    expect(Number(wf["7"].inputs.width) % 16).toBe(0);
    expect(Number(wf["7"].inputs.height)).toBe(480);
    expect(wf["1"].inputs.unet_name).toMatch(/^Kandinsky-6\.0-Pro-distill/);
    // Off by default: the encoder reads the words, and the helper and its 19 GB model are gone.
    expect(wf["5"].inputs.video_caption).toBe("A woman says <S>Hi<E>");
    expect(wf["5"].inputs.audio_caption).toBe("");
    expect(wf["20"]).toBeUndefined();
    expect(wf["19"]).toBeUndefined();
    expect(wf["8"].inputs.seed).toBe(7);
    // On: the helper writes both captions from the words.
    const on = await prepare("kandinsky6-t2av", { prompt: "a fox", extra: { promptHelper: "on" } }, "t2v");
    expect(on.workflow["5"].inputs.video_caption).toEqual(["20", 0]);
    expect(on.workflow["20"].inputs).toMatchObject({ video_caption: "a fox", seed: 7, enabled: true });
    expect(PROMPT_HELPER_GRAPHS.has("kandinsky6-i2av") && PROMPT_HELPER_OPT_IN.has("kandinsky6-i2av")).toBe(true);
    // Image to video: the still's shape when it is known, the frame cropped to the same size as the latent.
    const i2v = await prepare("kandinsky6-i2av", { prompt: "she waves", images: ["face.png"], aspectRatio: "9:16", resolution: "480p", duration: 5 }, "i2v");
    expect(i2v.workflow["30"].inputs.image).toBe("face.png");
    expect([i2v.workflow["31"].inputs.width, i2v.workflow["31"].inputs.height]).toEqual([i2v.workflow["7"].inputs.width, i2v.workflow["7"].inputs.height]);
    expect(Number(i2v.workflow["7"].inputs.height)).toBeGreaterThan(Number(i2v.workflow["7"].inputs.width));
  });

  it("skipPromptHelper hands Kandinsky's encoder the captions its helper was given", () => {
    const g = graph("kandinsky6-t2av");
    g["20"].inputs.video_caption = "words";
    g["20"].inputs.audio_caption = "rain";
    const out = skipPromptHelper(g, ["12"]);
    expect(out["5"].inputs).toMatchObject({ video_caption: "words", audio_caption: "rain" });
    expect(Object.values(out).some((n) => n.class_type === "Kandinsky6BeautifyPrompt" || (n.class_type === "CLIPLoader"))).toBe(false);
  });

  it("Kandinsky VSR binds the factor and the latent upscaler entry it needs, and refuses a factor it doesn't make", async () => {
    for (const [res, scale, bank] of [["2x", "2x", "2x"], ["2.25x", "2.25x", "2x"], ["4x", "4x", "4x"]]) {
      const r = await prepare("video-upscale-kandinsky6-vsr", { video: "clip.mp4", resolution: res }, "upscale-video", { "clip.mp4": { width: 848, height: 480, duration: 5 } });
      expect(r.workflow["6"].inputs.scale, res).toBe(scale);
      expect(r.workflow["5"].inputs.target_scale, res).toBe(bank);
      expect(r.workflow["1"].inputs.file).toBe("clip.mp4");
    }
    await expect(prepare("video-upscale-kandinsky6-vsr", { video: "clip.mp4", resolution: "3x" }, "upscale-video")).rejects.toThrow(/2x, 2\.25x or 4x/);
  });
});

describe("Kandinsky 6.0 in the cloud", () => {
  it("is one model whose Quality picks Pro or Lite at fal's step counts", () => {
    expect(cloud).toMatchObject({ engine: "cloud", name: "Kandinsky 6.0", licence: { licence: "MIT", commercial: true } });
    expect(cloud.tagline).toMatch(/^Kandinsky 6\.0 · both engines/);
    expect(cloud.routes.map((r) => [r.op, r.endpoint, r.when?.value])).toEqual([
      ["t2v", "fal-ai/kandinsky6-pro/text-to-video", "pro"],
      ["t2v", "fal-ai/kandinsky6-lite/text-to-video", "lite"],
      ["i2v", "fal-ai/kandinsky6-pro/image-to-video", "pro"],
      ["i2v", "fal-ai/kandinsky6-lite/image-to-video", "lite"],
    ]);
    const quality = cloud.options.controls!.find((c) => c.param === "quality")!;
    expect(quality.default).toBe("pro-standard");
    expect(quality.sets).toMatchObject({ "pro-fast": { variant: "pro", num_inference_steps: 8 }, "pro-best": { variant: "pro", num_inference_steps: 50 }, "lite-standard": { variant: "lite", num_inference_steps: 10 }, "lite-best": { variant: "lite", num_inference_steps: 16 } });
    // The run's variant picks the route; unset, the first (Pro).
    const lite = plan({ modelId: cloud.id, params: { extra: { quality: "lite-fast" } } });
    expect(routesFor(cloud, "t2v", lite.params).map((r) => r.endpoint)).toEqual(["fal-ai/kandinsky6-lite/text-to-video"]);
    expect(routesFor(cloud, "t2v", { extra: {} }).map((r) => r.endpoint)).toEqual(["fal-ai/kandinsky6-pro/text-to-video"]);
    expect(routesFor(cloud, "t2v").length).toBe(2);
  });

  it("prices a clip at fal's published price for its steps, Pro or Lite, words or a first frame", () => {
    const cost = (quality: string, op: "t2v" | "i2v" = "t2v") => {
      const p = plan({ modelId: cloud.id, params: { extra: { quality } }, ...(op === "i2v" && { inputs: { images: ["/api/files/a.png"] } }) });
      return estimateCost(cloud, p.params, 1, op);
    };
    expect([cost("pro-fast"), cost("pro-standard"), cost("pro-best")]).toEqual([0.24, 0.56, 1.35]);
    expect([cost("lite-fast"), cost("lite-standard"), cost("lite-best")]).toEqual([0.08, 0.16, 0.24]);
    expect([cost("pro-best", "i2v"), cost("lite-fast", "i2v")]).toEqual([1.4, 0.085]);
    // The default (no Quality picked): Pro at 20 steps; a step count between fal's is priced on the line between them.
    expect(estimateCost(cloud, { ...cloud.defaults }, 1, "t2v")).toBe(0.56);
    expect(estimateCost(cloud, { extra: { variant: "pro", num_inference_steps: 35 } }, 1, "t2v")).toBeCloseTo(0.955, 2);
  });

  it("sends fal what each endpoint takes: steps, sound, the helper on only when asked, and never Fuobe's own settings", () => {
    const pro = plan({ modelId: cloud.id, prompt: "she says “Look!”", params: { extra: { quality: "pro-best", promptHelper: "on" }, generateAudio: false } });
    const proRoute = fullRoute(routesFor(cloud, "t2v", pro.params)[0]);
    const sent = buildPayload(proRoute.map, { prompt: pro.prompt, ...pro.params });
    expect(sent).toMatchObject({ num_inference_steps: 50, generate_audio: false, enable_prompt_expansion: true, aspect_ratio: "16:9" });
    for (const k of ["variant", "quality", "promptHelper"]) expect(sent[k], k).toBeUndefined();
    const lite = plan({ modelId: cloud.id, params: { extra: { quality: "lite-standard" } } });
    const liteSent = buildPayload(fullRoute(routesFor(cloud, "t2v", lite.params)[0]).map, { prompt: lite.prompt, ...lite.params, negativePrompt: "blur" });
    expect(liteSent).toMatchObject({ num_inference_steps: 10, enable_prompt_expansion: false });
    expect(liteSent.negative_prompt).toBeUndefined(); // Lite has no negative prompt
  });
});

describe("Kandinsky VSR on both engines", () => {
  it("offers 2x, 2.25x and 4x, clips up to 5 s, on your GPU and on fal", () => {
    for (const m of [vsrOpen, vsrCloud]) {
      expect(m.options.resolutions, m.id).toEqual(["2x", "2.25x", "4x"]);
      expect(m.defaults?.resolution, m.id).toBe("2.25x");
      expect(m.options.maxSourceSeconds, m.id).toBe(5);
      expect(m.tagline, m.id).toMatch(/^Kandinsky 6\.0 · both engines/);
    }
    expect(fullRoute(vsrCloud.routes[0]).map.upscaleFactor).toEqual({ key: "upscale_factor" });
  });

  it("turns a factor tier into the factor and the size it makes", () => {
    expect(factorTier("2.25x")).toBe(2.25);
    expect(factorTier("1080p")).toBeUndefined();
    expect(upscaleFactorFor("4x", undefined)).toBe(4);
    expect(upscaledSize({ width: 848, height: 480 }, "2.25x")).toEqual({ width: 1908, height: 1080 });
    const sent = buildPayload(fullRoute(vsrCloud.routes[0]).map, { video: "https://x/clip.mp4", resolution: "2.25x" });
    expect(sent).toMatchObject({ video_url: "https://x/clip.mp4", upscale_factor: 2.25 });
    expect(clipOutcome("upscale-video", { width: 848, height: 480, duration: 5 }, { resolution: "4x" }, vsrCloud)).toBe("848×480 → 3392×1920");
  });

  it("prices per output megapixel per frame: about $0.09 for 5 s of 480p to 1080p, $0.29 at 4x", () => {
    const at = (resolution: string, extra: Partial<Parameters<typeof estimateCost>[1]> = {}) =>
      estimateCost(vsrCloud, { resolution, sourceSize: { width: 848, height: 480 }, sourceDuration: 5, ...extra }, 1, "upscale-video");
    // 5 s at 24 fps is 120 frames (fal keeps up to 121); the estimate is rounded to a tenth of a cent.
    expect(at("2.25x")).toBe(0.089);
    expect(at("4x")).toBe(0.281);
    expect(at("2x")).toBe(0.07);
    // 2 s at 24 fps: 48 frames, not the 121-frame cap.
    expect(at("2.25x", { sourceDuration: 2 })).toBe(Math.round(0.00036 * 1908 * 1080 * 48 / 1000) / 1000);
    // A clip not read yet: 480p 16:9 at the cap.
    expect(estimateCost(vsrCloud, { resolution: "2.25x" }, 1, "upscale-video")).toBe(0.09);
    expect(estimateCost(vsrOpen, { resolution: "4x" }, 1, "upscale-video")).toBe(0);
  });

  it("refuses a clip past 5 s in the composer and in the plan, on both engines", () => {
    for (const m of [vsrOpen, vsrCloud]) {
      expect(sourceLengthProblem(m, 12)).toBe("Kandinsky VSR takes clips up to 5 s, and this one is 12 s: trim it first, or pick SeedVR2 for longer clips");
      expect(sourceLengthProblem(m, 5.04)).toBeNull();
      expect(clipBlocker("upscale-video", { width: 848, height: 480, duration: 9.5 }, {}, m, undefined)).toMatch(/up to 5 s, and this one is 9\.5 s/);
      expect(() => plan({ modelId: m.id, prompt: "", inputs: { video: "/api/files/c.mp4" }, params: { sourceDuration: 8 } })).toThrow(/up to 5 s/);
    }
  });
});

describe("Kandinsky VSR's factors and clip sizes", () => {
  it("refuses a resolution that isn't one of its factors before the run, on both engines", () => {
    for (const m of [vsrOpen, vsrCloud]) {
      expect(() => plan({ modelId: m.id, prompt: "", inputs: { video: "/api/files/c.mp4" }, params: { resolution: "1080p" } }), m.id).toThrow("Kandinsky VSR upscales by 2x, 2.25x or 4x: pick one of those");
      expect(() => plan({ modelId: m.id, prompt: "", inputs: { video: "/api/files/c.mp4" }, params: { resolution: "4x" } }), m.id).not.toThrow();
      expect(() => plan({ modelId: m.id, prompt: "", inputs: { video: "/api/files/c.mp4" } }), m.id).not.toThrow();
    }
    // Upscalers that take sizes are unchanged.
    expect(factorTierProblem("SeedVR2", ["720p", "1080p", "1440p", "2160p"], "4x")).toBeNull();
  });

  it("in the cloud, 2x and 4x take sides in multiples of 16 and say to pick 2.25x; your GPU pads the clip itself", () => {
    expect(vsrCloud.options.sideMultiple).toEqual({ of: 16, factors: ["2x", "4x"] });
    expect(vsrOpen.options.sideMultiple).toBeUndefined();
    const clip = { width: 854, height: 480, duration: 5 };
    expect(clipBlocker("upscale-video", clip, { resolution: "2x" }, vsrCloud, undefined)).toBe(
      "Kandinsky VSR at 2x needs a clip whose width and height are multiples of 16 (this one is 854×480): pick 2.25x, or resize the clip first",
    );
    expect(clipBlocker("upscale-video", clip, { resolution: "4x" }, vsrCloud, undefined)).toMatch(/at 4x needs .* multiples of 16/);
    expect(clipBlocker("upscale-video", clip, { resolution: "2.25x" }, vsrCloud, undefined)).toBeNull();
    expect(clipBlocker("upscale-video", clip, {}, vsrCloud, undefined)).toBeNull(); // the default, 2.25x
    expect(clipBlocker("upscale-video", { width: 848, height: 480, duration: 5 }, { resolution: "2x" }, vsrCloud, undefined)).toBeNull();
    expect(clipBlocker("upscale-video", clip, { resolution: "2x" }, vsrOpen, undefined)).toBeNull();
    expect(sideMultipleProblem("X", undefined, [], "2x", { width: 854, height: 480 })).toBeNull();
  });

  it("the cloud's Lite says it takes no negative prompt", () => {
    const labels = cloud.options.controls!.find((c) => c.param === "quality")!.labels!;
    for (const [k, v] of Object.entries(labels)) expect(v.includes("no negative prompt"), k).toBe(k.startsWith("lite"));
  });
});

describe("Kandinsky's spoken lines and sound", () => {
  it("turns quoted words into spoken lines and a closing Sound: line into the sound caption", () => {
    expect(kandinskyPrompt("She smiles and says “Look over there!” Sound: rain on the window")).toBe("She smiles and says <S>Look over there!<E> <AUDCAP>rain on the window<ENDAUDCAP>");
    expect(kandinskyPrompt('A cat turns and says "Hello"\nMusic: soft piano')).toBe("A cat turns and says <S>Hello<E> <AUDCAP>soft piano<ENDAUDCAP>");
    expect(kandinskyPrompt("A paraglider over hills at golden hour")).toBe("A paraglider over hills at golden hour");
    // Already in Kandinsky's form: left alone.
    const tagged = "He says <S>Hi<E> <AUDCAP>wind<ENDAUDCAP>";
    expect(inKandinskyForm(tagged)).toBe(true);
    expect(kandinskyPrompt(tagged)).toBe(tagged);
    // A prompt that is only a sound line is the sound caption alone.
    expect(kandinskyPrompt("Sound: thunder")).toBe("<AUDCAP>thunder<ENDAUDCAP>");
  });
});

describe("Where Kandinsky shows up", () => {
  it("Lipsync links a talking character from words to the Video studio on each engine's Kandinsky", () => {
    expect(LIPSYNC_STUDIO.related?.label).toMatch(/talking character from words/);
    expect(relatedHref(LIPSYNC_STUDIO.related!, "open")).toBe("/video?model=oss-kandinsky6");
    expect(relatedHref(LIPSYNC_STUDIO.related!, "cloud")).toBe("/video?model=kandinsky-6");
    expect(relatedHref({ href: "/genjutsu?mode=x" }, "open")).toBe("/genjutsu?mode=x");
    // Not a lip-sync model: neither engine's Kandinsky runs Lipsync's operations.
    for (const m of [open, cloud] as ModelDef[]) expect(m.routes.some((r) => r.op === "avatar" || r.op === "lipsync"), m.id).toBe(false);
  });

  it("the GPU pre-flight board has rows for video with dialogue and Kandinsky VSR on graphs the index knows", () => {
    const dialog = STUDIO_ROWS.find((r) => r.href === "/video?model=oss-kandinsky6")!;
    expect(dialog).toMatchObject({ label: "Video with dialogue", group: "Video" });
    expect(dialog.steps?.map((s) => s.op)).toEqual(["t2v", "i2v"]);
    const vsr = STUDIO_ROWS.find((r) => r.href === "/upscale/video?model=oss-kandinsky6-vsr")!;
    expect(vsr).toMatchObject({ label: "Kandinsky VSR", group: "Video tools" });
    for (const id of GRAPHS) expect(requirements.workflows[id], id).toBeTruthy();
    expect(new Set(STUDIO_ROWS.map((r) => r.href)).size).toBe(STUDIO_ROWS.length);
  });
});

describe("the GPU pre-flight on Kandinsky 6.0", () => {
  const SITE = "http://127.0.0.1:3370";
  const T2V = "kandinsky6-t2av";
  const AUDIO = ["audio_vae/v1-44.pth", "audio_vae/bigvgan_vocoder/bigvgan_generator.pt", "audio_vae/bigvgan_vocoder/config.json"];

  it("reads the audio files where the pack lists them (kandinsky6_audio_vae), so a ComfyUI with the pack reads Ready", async () => {
    const { parseIndex } = await import("@/lib/gpu/requirements");
    const { gatherInventory } = await import("@/lib/gpu/gather");
    const { fetchTransport } = await import("@/lib/gpu/transport");
    const { filePresence, workflowReadiness } = await import("@/lib/gpu/readiness");
    const { startLocalComfy } = await import("./helpers/fake-local-comfy");
    const idx = parseIndex(read("requirements.json"));
    for (const k of AUDIO) expect(idx.files[k as `${string}/${string}`], k).toMatchObject({ folder: "audio_vae", listFolder: "kandinsky6_audio_vae" });
    expect(idx.folders).toContain("kandinsky6_audio_vae");
    expect(idx.folders).not.toContain("audio_vae"); // ComfyUI has no folder of that name
    const fake = await startLocalComfy({ cors: SITE, has: idx as never });
    try {
      const t = fetchTransport("browser", fake.url, (url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), origin: SITE, "sec-fetch-site": "cross-site" } }), { decodes: true });
      const inv = await gatherInventory(t, idx, { where: "computer" });
      expect(Object.keys(inv.models.kandinsky6_audio_vae.have).sort()).toEqual(["bigvgan_vocoder/bigvgan_generator.pt", "bigvgan_vocoder/config.json", "v1-44.pth"]);
      expect(filePresence(idx.files["audio_vae/bigvgan_vocoder/bigvgan_generator.pt"], inv)).toBe("present");
      for (const id of [T2V, "kandinsky6-i2av"]) expect(workflowReadiness(id, inv, idx, { account: true }).state, id).toBe("ready");
      // The vocoder gone from that listing: the one thing it needs.
      delete inv.models.kandinsky6_audio_vae.have["bigvgan_vocoder/bigvgan_generator.pt"];
      const r = workflowReadiness(T2V, inv, idx, { account: true });
      expect(r.needs.map((n) => n.file)).toEqual(["audio_vae/bigvgan_vocoder/bigvgan_generator.pt"]);
      expect(r.needs[0].detail).toBe("bigvgan_vocoder/bigvgan_generator.pt → models/audio_vae"); // downloaded where the pack reads it
    } finally {
      await fake.close();
    }
  });

  it("asks for Pro's file only on Quality Pro and the helper's only with the Prompt helper on", async () => {
    const { parseIndex } = await import("@/lib/gpu/requirements");
    const { writeSnapshot, dropSnapshots } = await import("@/server/gpu/snapshots");
    const { gateGeneration } = await import("@/server/gpu/gate");
    const idx = parseIndex(read("requirements.json"));
    const INSTALL = { kind: "install", key: "install", via: "server" } as const;
    const at = Date.now();
    const models: Record<string, { have: Record<string, number | null>; total: number }> = {};
    for (const folder of idx.folders) models[folder] = { have: {}, total: 0 };
    const combos: Record<string, string[]> = {};
    for (const k of idx.workflows[T2V].files) {
      const f = idx.files[k];
      models[f.listFolder ?? f.folder].have[f.file] = f.sizeBytes;
      for (const [cls, input] of f.loaders ?? []) (combos[`${cls}.${input}`] ??= []).push(f.file);
    }
    for (const f of Object.values(idx.files)) for (const [cls, input] of f.loaders ?? []) combos[`${cls}.${input}`] ??= [];
    writeSnapshot(INSTALL, {
      v: 1, via: "server", checkedAt: at, tookMs: 5, reachable: true,
      devices: [{ name: "GPU", type: "cuda", index: 0, vramTotal: 24 * 2 ** 30, vramFree: 24 * 2 ** 30 }],
      manager: { api: "none" }, nodes: { have: [], missing: [], total: 1, readAt: at, how: "object_info" },
      combos, packs: {}, models, loras: {}, fingerprint: "x", errors: [],
    } as never);
    const gate = (extra: Record<string, unknown>) =>
      gateGeneration(INSTALL, { request: { feature: "video", modelId: open.id, prompt: "a fox", params: { extra } }, route: { provider: "comfyui", endpoint: T2V }, op: "t2v", modelId: open.id, actor: "owner" });
    try {
      expect(await gate({})).toEqual({ ok: true });
      expect(await gate({ quality: "lite", promptHelper: "off" })).toEqual({ ok: true });
      expect(await gate({ quality: "pro" })).toMatchObject({ ok: true, warning: expect.stringMatching(/needs 1 more thing/) });
      expect(await gate({ promptHelper: "on" })).toMatchObject({ ok: true, warning: expect.stringMatching(/needs 1 more thing/) });
      expect(await gate({ quality: "pro", promptHelper: "on" })).toMatchObject({ ok: true, warning: expect.stringMatching(/needs 2 more things/) });
    } finally {
      dropSnapshots("install");
    }
  });
});
