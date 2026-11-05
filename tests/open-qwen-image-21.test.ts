import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GenInput, Operation } from "@/lib/catalog/types";
import { dropBranch, type ComfyWorkflow, type ManifestWorkflow } from "@/lib/comfy";
import { tempDir } from "./helpers/temp-dir";

// Qwen-Image 2.1 and Qwen-Image 2.1 Turbo on the open engine (the owner's SOTA image families, 2026-10-31): text to
// image, edits with up to four references, inpaint and expand from the owner's workflows and the proven preview graphs.
const tmp = tempDir("fuobe-qwen21-");
process.env.FUOBE_DATA_DIR = tmp;
process.env.COMFYUI_URL = "http://comfy.test:8188";
const { prepareWorkflow, getWorkflow } = await import("@/server/providers/comfyui");
const { getModel, getPreset } = await import("@/lib/catalog");
const { planGeneration } = await import("@/lib/catalog/plan");
const { licenceInfo, NODE_PACKS, workflowLicence } = await import("@/lib/licences");
const { KNOWN_MODELS, PACK_CLASSES } = await import("../scripts/comfy/library.spec.mjs");

const LIBRARY = path.join(process.cwd(), "workflows/comfyui");
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(LIBRARY, f), "utf8"));
const WORKFLOWS = ["qwen-image-21-t2i", "qwen-image-21-edit", "qwen-image-21-turbo-edit", "qwen-image-21-inpaint", "qwen-image-21-outpaint"];

async function prepare(id: string, input: GenInput, op: Operation) {
  const uploads: string[] = [];
  const res = await prepareWorkflow(id, { seed: 7, ...input }, {
    generationId: "g",
    op,
    upload: async (_d, _t, name) => {
      uploads.push(name);
      return `up_${name}`;
    },
    media: () => undefined,
    serverRam: async () => undefined,
  });
  return { ...res, uploads };
}
const at = (wf: ComfyWorkflow, m: ManifestWorkflow, key: string) => (m.bindings[key] ?? []).map((t) => wf[t.node].inputs[t.input]);
const ofClass = (wf: ComfyWorkflow, cls: string) => Object.entries(wf).filter(([, n]) => n.class_type === cls);
/** The node an output node saves, followed back through its first image link. */
const savedFrom = (wf: ComfyWorkflow, m: ManifestWorkflow) => {
  const link = wf[m.outputs[0].node].inputs.images as [string, number];
  return wf[link[0]].class_type;
};
const plan = (r: Record<string, unknown>) => planGeneration({ feature: "image", ...r } as Parameters<typeof planGeneration>[0], getModel, getPreset);

describe("Qwen-Image 2.1 in the catalog", () => {
  it("routes every operation of both models to its workflow in the library", () => {
    const manifest = read("manifest.json") as { workflows: ManifestWorkflow[] };
    const byId = new Map(manifest.workflows.map((w) => [w.id, w]));
    const want: Record<string, [Operation, string][]> = {
      "oss-qwen-image-21": [
        ["t2i", "qwen-image-21-t2i"],
        ["edit", "qwen-image-21-edit"],
        ["inpaint", "qwen-image-21-inpaint"],
        ["outpaint", "qwen-image-21-outpaint"],
      ],
      "oss-qwen-image-21-turbo": [["edit", "qwen-image-21-turbo-edit"]],
    };
    for (const [id, routes] of Object.entries(want)) {
      const m = getModel(id)!;
      expect(m.engine, id).toBe("open");
      expect(m.kind).toBe("image");
      expect(m.badges).toEqual(expect.arrayContaining(["open", "new", "top"]));
      expect(m.routes.map((r) => [r.op, r.endpoint])).toEqual(routes);
      for (const [op, wid] of routes) {
        expect(byId.get(wid)?.capability, wid).toBe(op);
        expect(byId.get(wid)?.validated, `${wid} passed a real run on a GPU`).toBe(true);
      }
      expect(m.options.maxImages).toBe(4);
      expect(m.tagline).toMatch(/20 GB GPU$/);
    }
    expect(getModel("oss-qwen-image-21-turbo")!.badges).toContain("fast");
    // Turbo has no text to image: none of the owner's workflows runs it that way.
    expect(getModel("oss-qwen-image-21-turbo")!.routes.some((r) => r.op === "t2i")).toBe(false);
  });

  it("plans text to image, edits and inpaint from the inputs, and asks for what's missing", () => {
    expect(plan({ modelId: "oss-qwen-image-21", prompt: "a bakery sign" }).op).toBe("t2i");
    expect(plan({ modelId: "oss-qwen-image-21", prompt: "make it night", inputs: { images: ["/a.png"] } }).op).toBe("edit");
    expect(plan({ modelId: "oss-qwen-image-21", prompt: "a glass", inputs: { images: ["/a.png"], mask: "/m.png" } }).op).toBe("inpaint");
    expect(plan({ modelId: "oss-qwen-image-21", op: "outpaint", prompt: "more street", inputs: { images: ["/a.png"] } }).op).toBe("outpaint");
    expect(plan({ modelId: "oss-qwen-image-21-turbo", prompt: "relight", inputs: { images: ["/a.png", "/b.png", "/c.png", "/d.png"] } }).op).toBe("edit");
    expect(() => plan({ modelId: "oss-qwen-image-21", op: "inpaint", prompt: "a glass", inputs: { images: ["/a.png"] } })).toThrow(/paint the area/);
    expect(() => plan({ modelId: "oss-qwen-image-21", op: "outpaint", prompt: "more street" })).toThrow(/image to extend/);
    expect(() => plan({ modelId: "oss-qwen-image-21-turbo", prompt: "relight" })).toThrow(/Add an image/);
  });

  it("records the weights' licence as non-commercial and the AusBoss nodes as MIT", () => {
    const manifest = read("manifest.json") as { workflows: ManifestWorkflow[] };
    for (const id of WORKFLOWS) {
      const info = licenceInfo(workflowLicence(manifest.workflows.find((w) => w.id === id)!));
      expect(info, id).toMatchObject({ name: "Qwen Research License", class: "non-commercial" });
    }
    expect(NODE_PACKS.find((p) => p.name === "ausboss-nodes")?.licence).toMatchObject({ name: "MIT", class: "commercial" });
  });

  it("pins every file to Hugging Face and the AusBoss pack to a commit", () => {
    const pins = read("model-pins.json") as Record<string, { revision: string; sizeBytes: number; sha256: string }>;
    const packs = read("packs.json") as Record<string, { repo: string; commit: string }>;
    const files = ["qwen_image_2.1_int8_convrot.safetensors", "qwen_image_2.1_turbo_int8_convrot.safetensors", "qwen3vl_8b_int8_convrot.safetensors", "qwen_image_2.1_vae_bf16.safetensors", "qwen-image-2.1-outpaint-v2.safetensors"];
    for (const f of files) {
      const known = (KNOWN_MODELS as Record<string, { url: string }>)[f];
      expect(known?.url, f).toMatch(/^https:\/\/huggingface\.co\//);
      expect(pins[known.url], f).toMatchObject({ revision: expect.stringMatching(/^[0-9a-f]{40}$/), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    }
    expect(pins[(KNOWN_MODELS as Record<string, { url: string }>)["qwen_image_2.1_int8_convrot.safetensors"].url].sizeBytes).toBe(7256783064);
    expect(packs["ausboss-nodes"]).toMatchObject({ repo: "https://github.com/ausboss/ComfyUI-AusBoss", commit: "bce780f2598f47c239cbf6503ea0984f96229391" });
    expect((PACK_CLASSES as Record<string, RegExp>)["ausboss-nodes"].test("AUSBOSS_NODES_StitchInpaint")).toBe(true);
  });
});

describe("Qwen-Image 2.1 graphs as Fuobe sends them", () => {
  it("text to image: the prompt, the size from aspect and resolution on the 32 grid, the seed, 25 steps at cfg 1", async () => {
    const { workflow: wf, manifest } = await prepare("qwen-image-21-t2i", { prompt: "a bakery sign that reads OPEN", aspectRatio: "1:1", resolution: "1K" }, "t2i");
    expect(at(wf, manifest, "prompt")).toEqual(["a bakery sign that reads OPEN"]);
    expect([at(wf, manifest, "width")[0], at(wf, manifest, "height")[0]]).toEqual([1024, 1024]);
    expect(at(wf, manifest, "seed")).toEqual([7]);
    expect(ofClass(wf, "KSampler")[0][1].inputs).toMatchObject({ steps: 25, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 });
    expect(ofClass(wf, "UNETLoader")[0][1].inputs.unet_name).toBe("qwen_image_2.1_int8_convrot.safetensors");
    expect(ofClass(wf, "CLIPLoader")[0][1].inputs).toMatchObject({ clip_name: "qwen3vl_8b_int8_convrot.safetensors", type: "qwen_image" });
    expect(savedFrom(wf, manifest)).toBe("SplitImageWithAlpha");
    // 2K in 16:9 is 2720x1536 on the grid, kept within 2048 in its shape.
    const wide = await prepare("qwen-image-21-t2i", { prompt: "x", aspectRatio: "16:9", resolution: "2K" }, "t2i");
    expect([at(wide.workflow, wide.manifest, "width")[0], at(wide.workflow, wide.manifest, "height")[0]]).toEqual([2048, 1152]);
    const tall = await prepare("qwen-image-21-t2i", { prompt: "x", aspectRatio: "3:4", resolution: "1.5K" }, "t2i");
    const [w, h] = [Number(at(tall.workflow, tall.manifest, "width")[0]), Number(at(tall.workflow, tall.manifest, "height")[0])];
    expect([w % 32, h % 32]).toEqual([0, 0]);
    expect(w / h).toBeCloseTo(3 / 4, 1);
  });

  it.each(["qwen-image-21-edit", "qwen-image-21-turbo-edit"])("%s: four references reach one encoder as images 1-4", async (id) => {
    const { workflow: wf, manifest } = await prepare(id, { prompt: "Put the sofa from image 2 in the room of image 1. Keep the room exactly as in image 1.", images: ["a.png", "b.png", "c.png", "d.png"] }, "edit");
    expect(at(wf, manifest, "image")).toEqual(["a.png"]);
    expect([...at(wf, manifest, "image2"), ...at(wf, manifest, "image3"), ...at(wf, manifest, "image4")]).toEqual(["b.png", "c.png", "d.png"]);
    const [encId, enc] = ofClass(wf, "TextEncodeQwenImage21")[0];
    expect(enc.inputs).toMatchObject({ prompt: expect.stringMatching(/^Put the sofa/), negative_prompt: "", resolution: 0 });
    // Each image is scaled to 2048 on its long side before the encoder, in slot order.
    const slots = [1, 2, 3, 4].map((i) => enc.inputs[`images.image_${i}`] as [string, number]);
    expect(slots.map(([node]) => wf[node].class_type)).toEqual(Array(4).fill("ImageScaleToMaxDimension"));
    expect(slots.map(([node]) => wf[(wf[node].inputs.image as [string, number])[0]].inputs.image)).toEqual(["a.png", "b.png", "c.png", "d.png"]);
    expect(slots.every(([node]) => wf[node].inputs.largest_size === 2048 && wf[node].inputs.upscale_method === "lanczos")).toBe(true);
    // The sampler starts from the encoder's latent (image 1's size), on the cached model.
    const sampler = ofClass(wf, id.includes("turbo") ? "SamplerCustomAdvanced" : "KSampler")[0][1];
    expect(sampler.inputs.latent_image).toEqual([encId, 2]);
    expect(ofClass(wf, "QwenImage21Cache")).toHaveLength(1);
    expect(at(wf, manifest, "seed")).toEqual([7]);
    expect(savedFrom(wf, manifest)).toBe("SplitImageWithAlpha");
  });

  it("the Turbo edit runs the fixed 8-step schedule at cfg 1 on the turbo model", async () => {
    const { workflow: wf, manifest } = await prepare("qwen-image-21-turbo-edit", { prompt: "Relight the scene as golden hour.", images: ["a.png"] }, "edit");
    expect(ofClass(wf, "UNETLoader")[0][1].inputs.unet_name).toBe("qwen_image_2.1_turbo_int8_convrot.safetensors");
    expect(ofClass(wf, "ManualSigmas")[0][1].inputs.sigmas).toBe("1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0");
    expect(ofClass(wf, "CFGGuider")[0][1].inputs.cfg).toBe(1);
    expect(ofClass(wf, "KSamplerSelect")[0][1].inputs.sampler_name).toBe("euler");
    expect(manifest.bindings.steps).toBeUndefined();
    // The prompt enhancer branch is not in the graph.
    expect(ofClass(wf, "TextGenerate")).toEqual([]);
  });

  it.each(["qwen-image-21-edit", "qwen-image-21-turbo-edit"])("%s: references not given are dropped, loader and scaler with them", async (id) => {
    for (const n of [1, 2, 3]) {
      const images = ["a.png", "b.png", "c.png"].slice(0, n);
      const { workflow: wf } = await prepare(id, { prompt: "Change the jacket to red.", images }, "edit");
      const enc = ofClass(wf, "TextEncodeQwenImage21")[0][1];
      const refs = Object.keys(enc.inputs).filter((k) => k.startsWith("images.")).sort();
      expect(refs, `${n} image(s)`).toEqual([1, 2, 3].slice(0, n).map((i) => `images.image_${i}`));
      expect(ofClass(wf, "LoadImage").map(([, l]) => l.inputs.image)).toEqual(images);
      expect(ofClass(wf, "ImageScaleToMaxDimension")).toHaveLength(n);
    }
    await expect(prepare(id, { prompt: "x", images: [] }, "edit")).rejects.toThrow(/Add an image/);
  });

  it("inpaint: the photo and a red-channel mask, cropped around it, repainted and stitched back", async () => {
    const { workflow: wf, manifest } = await prepare("qwen-image-21-inpaint", { prompt: "Replace the cup with a glass of orange juice.", images: ["photo.png"], mask: "mask.png" }, "inpaint");
    expect(at(wf, manifest, "image")).toEqual(["photo.png"]);
    const [maskId, mask] = ofClass(wf, "LoadImageMask")[0];
    expect(mask.inputs).toEqual({ image: "mask.png", channel: "red" });
    const [cropId, crop] = ofClass(wf, "AUSBOSS_NODES_CropForInpaint")[0];
    expect(crop.inputs).toMatchObject({ mask: [maskId, 0], context_factor: 1.6, blend_pixels: 8, output_multiple: 32, target_megapixels: 1.5, invert_mask: false });
    // The request plus one keep sentence, read with the crop as image 1.
    const [fmtId, fmt] = ofClass(wf, "StringFormat")[0];
    expect(fmt.inputs).toMatchObject({ "values.a": "Replace the cup with a glass of orange juice.", f_string: "{a} Keep everything else exactly the same." });
    expect(ofClass(wf, "TextEncodeQwenImage21")[0][1].inputs).toMatchObject({ prompt: [fmtId, 0], "images.image_1": [cropId, 0], resolution: 0 });
    // Only the grown mask may change, from the crop's own latent.
    const noise = ofClass(wf, "SetLatentNoiseMask")[0][1];
    expect(wf[(noise.inputs.mask as [string, number])[0]]).toMatchObject({ class_type: "GrowMask", inputs: { expand: 8 } });
    expect(ofClass(wf, "KSampler")[0][1].inputs).toMatchObject({ seed: 7, steps: 25, cfg: 1, sampler_name: "euler", scheduler: "simple" });
    // Alpha dropped before the crop is stitched back into the full picture.
    const stitch = wf[(wf[manifest.outputs[0].node].inputs.images as [string, number])[0]];
    expect(stitch.class_type).toBe("AUSBOSS_NODES_StitchInpaint");
    expect(wf[(stitch.inputs.inpainted as [string, number])[0]].class_type).toBe("SplitImageWithAlpha");
    expect(stitch.inputs.stitcher).toEqual([cropId, 2]);
    await expect(prepare("qwen-image-21-inpaint", { prompt: "x", images: ["photo.png"] }, "inpaint")).rejects.toThrow(/Paint the area/);
  });

  it("expand: the photo and the pads go to both pad nodes, the hint after the lead-in, the original back on top", async () => {
    const pads = { padLeft: 256, padTop: 128, padRight: 512, padBottom: 0 };
    const { workflow: wf, manifest } = await prepare("qwen-image-21-outpaint", { prompt: "parks and swimming pools", images: ["photo.png"], extra: pads }, "outpaint");
    const padNodes = ofClass(wf, "AUSBOSS_NODES_ImageCropRotatePad").map(([, n]) => n.inputs);
    expect(padNodes).toHaveLength(2);
    for (const p of padNodes) expect(p).toMatchObject({ image: "photo.png", pad_left: 256, pad_top: 128, pad_right: 512, pad_bottom: 0, fill_color: "#808080" });
    expect(padNodes.map((p) => p.feather).sort()).toEqual([12, 48]);
    expect(ofClass(wf, "RegexReplace")[0][1].inputs.string).toBe("parks and swimming pools");
    expect(ofClass(wf, "LoraLoaderModelOnly")[0][1].inputs).toMatchObject({ lora_name: "qwen-image-2.1-outpaint-v2.safetensors", strength_model: 1 });
    expect(ofClass(wf, "KSampler")[0][1].inputs).toMatchObject({ seed: 7, steps: 25, cfg: 1 });
    // No noise mask: the whole canvas is sampled, then the stitch blends the new area in.
    expect(ofClass(wf, "SetLatentNoiseMask")).toEqual([]);
    expect(ofClass(wf, "AUSBOSS_NODES_StitchInpaint")[0][1].inputs).toMatchObject({ seam: "blend in", color_match: 1, inpainted: [ofClass(wf, "SplitImageWithAlpha")[0][0], 0] });
    expect(savedFrom(wf, manifest)).toBe("ImageCompositeMasked");
    // Apps run the graph's own pads: a 1.5x zoom-out of a 1536x1152 photo.
    const app = await prepare("qwen-image-21-outpaint", { prompt: "", images: ["photo.png"] }, "outpaint");
    for (const p of ofClass(app.workflow, "AUSBOSS_NODES_ImageCropRotatePad")) expect(p[1].inputs).toMatchObject({ pad_left: 384, pad_top: 288, pad_right: 384, pad_bottom: 288 });
    expect(app.manifest.defaults).toMatchObject({ padLeft: 384, padTop: 288, padRight: 384, padBottom: 288 });
    await expect(prepare("qwen-image-21-outpaint", { prompt: "x", images: [] }, "outpaint")).rejects.toThrow(/Add an image/);
  });

  it("saves every graph under the run's prefix, and leaves nothing that saves elsewhere", async () => {
    for (const id of WORKFLOWS) {
      const { workflow, manifest } = getWorkflow(id);
      expect(manifest.outputs.map((o) => workflow[o.node].class_type), id).toEqual(["SaveImage"]);
      expect(Object.values(workflow).filter((n) => /^(Save|Preview)/.test(n.class_type) || n.class_type.startsWith("AUSBOSS_NODES_Save")), id).toHaveLength(1);
    }
  });
});

describe("optional references (dropBranch into a set of encoders)", () => {
  const graph = (): ComfyWorkflow => ({
    1: { class_type: "LoadImage", inputs: { image: "a.png" } },
    2: { class_type: "LoadImage", inputs: { image: "b.png" } },
    3: { class_type: "ImageScaleToMaxDimension", inputs: { image: ["2", 0], upscale_method: "lanczos", largest_size: 2048 } },
    4: { class_type: "TextEncodeQwenImage21", inputs: { prompt: "", "images.image_1": ["1", 0], "images.image_2": ["3", 0] } },
    5: { class_type: "SaveImage", inputs: { images: ["4", 0] } },
  });
  const ENCODERS = new Set(["TextEncodeQwenImage21", "TextEncodeFibo2"]);

  it("takes the loader and what only it feeds out, up to the encoder's input", () => {
    const out = dropBranch(graph(), "2", ENCODERS, ["5"])!;
    expect(Object.keys(out).sort()).toEqual(["1", "4", "5"]);
    expect(out[4].inputs).toEqual({ prompt: "", "images.image_1": ["1", 0] });
  });

  it("still takes a single class name, and refuses a branch that reaches an output", () => {
    expect(dropBranch(graph(), "2", "TextEncodeQwenImage21", ["5"])).not.toBeNull();
    expect(dropBranch(graph(), "2", new Set(["Krea2EditModelPatch"]), ["5"])).toBeNull();
    const direct = graph();
    direct[6] = { class_type: "SaveImage", inputs: { images: ["2", 0] } };
    expect(dropBranch(direct, "2", ENCODERS, ["5", "6"])).toBeNull();
  });
});
