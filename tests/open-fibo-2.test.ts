import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GenInput, Operation } from "@/lib/catalog/types";
import type { ComfyWorkflow } from "@/lib/comfy";
import { tempDir } from "./helpers/temp-dir";

// FIBO 2 on the open engine (the owner's SOTA image families, 2026-10-31): FIBO 2 Dev for text to image through the
// owner's VGL graph (Qwen3.5 writes Bria's structured JSON prompt) and for edits with up to four references, and
// FIBO 2 Edit Turbo for 4-step edits. The graphs are the owner's fibo/ workflows; none is rendered through Fuobe yet.
const dir = tempDir("fuobe-fibo2-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9"; // nothing listens here

const { getWorkflow, prepareWorkflow } = await import("@/server/providers/comfyui");
const { getModel, getPreset, MODELS } = await import("@/lib/catalog");
const { planGeneration } = await import("@/lib/catalog/plan");
const { dropBranch } = await import("@/lib/comfy");
const { licenceInfo } = await import("@/lib/licences");
const { KNOWN_MODELS } = await import("../scripts/comfy/library.spec.mjs");
const known = KNOWN_MODELS as Record<string, { folder: string; url: string; variants?: string[] }>;


const ROUTES: Record<string, Partial<Record<Operation, string>>> = {
  "oss-fibo2-dev": { t2i: "fibo2-dev-t2i", edit: "fibo2-dev-edit" },
  "oss-fibo2-edit-turbo": { edit: "fibo2-edit-turbo-edit" },
};
const WORKFLOWS = Object.values(ROUTES).flatMap((r) => Object.values(r));
const pins = JSON.parse(fs.readFileSync(path.join(process.cwd(), "workflows/comfyui/model-pins.json"), "utf8")) as Record<string, { revision: string; sizeBytes: number; sha256?: string }>;

async function prepare(id: string, input: GenInput, op: Operation): Promise<ComfyWorkflow> {
  const { workflow } = await prepareWorkflow(id, { seed: 7, ...input }, { generationId: "g", op, upload: async (_d, _t, name) => `up_${name}` });
  return workflow;
}
const plan = (r: Parameters<typeof planGeneration>[0]) => planGeneration(r, getModel, getPreset);
/** Links that point at a node the graph no longer has. */
const dangling = (wf: ComfyWorkflow) =>
  Object.entries(wf).flatMap(([id, n]) => Object.entries(n.inputs).filter(([, v]) => Array.isArray(v) && !wf[String(v[0])]).map(([k]) => `${id}.${k}`));
const references = (wf: ComfyWorkflow, encoder: string) => Object.keys(wf[encoder].inputs).filter((k) => k.startsWith("images.")).sort();

describe("FIBO 2 models", () => {
  it.each(Object.entries(ROUTES))("%s routes each op to its workflow", (id, routes) => {
    const m = getModel(id)!;
    expect(m.engine).toBe("open");
    expect(m.kind).toBe("image");
    expect(m.family).toBe("bria");
    expect(m.badges).toEqual(expect.arrayContaining(["open", "new", "top"]));
    expect(m.tagline).toMatch(/GB GPU$/);
    expect(m.options.maxImages).toBe(4);
    for (const [op, wid] of Object.entries(routes)) {
      const route = m.routes.find((r) => r.op === op);
      expect(route, `${id} ${op}`).toMatchObject({ provider: "comfyui", endpoint: wid });
      const { manifest } = getWorkflow(wid!);
      expect(manifest.capability).toBe(op);
      // Each graph passed a real run on a GPU.
      expect(manifest.validated).toBe(true);
    }
    expect(m.routes.map((r) => r.op).sort()).toEqual(Object.keys(routes).sort());
  });

  it("lists FIBO 2 ahead of the older open image models, Edit Turbo as a fast pick", () => {
    const open = MODELS.filter((m) => m.engine === "open" && m.kind === "image").map((m) => m.id);
    expect(open.indexOf("oss-fibo2-dev")).toBeLessThan(open.indexOf("oss-z-image-turbo"));
    expect(open.indexOf("oss-fibo2-edit-turbo")).toBeLessThan(open.indexOf("oss-qwen-edit"));
    expect(getModel("oss-fibo2-edit-turbo")!.badges).toContain("fast");
  });

  it("plans text to image without a picture and an edit with one; Edit Turbo asks for the picture", () => {
    expect(plan({ feature: "image", modelId: "oss-fibo2-dev", prompt: "a red bicycle" }).op).toBe("t2i");
    expect(plan({ feature: "image", modelId: "oss-fibo2-dev", prompt: "make it blue", inputs: { images: ["/a.png"] } }).op).toBe("edit");
    expect(plan({ feature: "image", modelId: "oss-fibo2-edit-turbo", prompt: "make it blue", inputs: { images: ["/a.png", "/b.png"] } }).op).toBe("edit");
    expect(() => plan({ feature: "image", modelId: "oss-fibo2-edit-turbo", prompt: "make it blue" })).toThrow(/Add an image to edit/);
  });

  it("names the licence and pins every file to a revision, a size and a SHA-256", () => {
    for (const wid of WORKFLOWS) {
      const { manifest } = getWorkflow(wid);
      expect(licenceInfo(manifest.license!)).toMatchObject({ name: "CC BY-NC 4.0", class: "non-commercial" });
      expect(manifest.customNodes, wid).toEqual([]); // core ComfyUI nodes only
      for (const m of manifest.models) {
        const pin = pins[m.url!];
        expect(pin, `${wid}: ${m.file}`).toBeDefined();
        expect(pin.revision).toMatch(/^[0-9a-f]{40}$/);
        expect(pin.sizeBytes).toBeGreaterThan(0);
        expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(known[m.file]?.folder, m.file).toBe(m.folder);
      }
    }
    // Precisions the ComfyUI may have instead: the same weights in the same Hugging Face repo.
    expect(known["fibo2_dev_int8_convrot.safetensors"].variants).toEqual(["fibo2_dev_bf16.safetensors"]);
    expect(known["fibo2_edit_turbo_int8_convrot.safetensors"].variants).toEqual(["fibo2_edit_turbo_bf16.safetensors"]);
  });
});

describe("FIBO 2 Dev text to image", () => {
  it("gives the words to the prompt writer and takes the size from the aspect ratio", async () => {
    const wf = await prepare("fibo2-dev-t2i", { prompt: "a red bicycle against a white wall", negativePrompt: "blurry", aspectRatio: "16:9", resolution: "1K" }, "t2i");
    expect(wf["112"]).toMatchObject({ class_type: "TextGenerate", inputs: { prompt: "a red bicycle against a white wall", max_length: 2048, sampling_mode: "off", system_prompt: ["115", 0] } });
    // Bria's VGL JSON from the owner's art-director system prompt is what the FIBO 2 encoder reads.
    expect(wf["115"].inputs.value).toMatch(/^You are a visionary and creative Visual Art Director/);
    expect(wf["115"].inputs.value).toMatch(/`short_description`[\s\S]*`text_render`[\s\S]*OUTPUT FORMAT \(STRICT\)/);
    expect(wf["6"].inputs).toMatchObject({ clip: ["38", 0], text: ["112", 0] });
    expect(wf["38"].inputs).toMatchObject({ clip_name: "qwen3vl_4b_int8_convrot.safetensors", type: "fibo2" });
    // The prompt writer runs on the int8 Qwen3.5 9B (the w4a8 build faulted the driver here).
    expect(wf["116"].inputs.clip_name).toBe("qwen3.5_9b_int8_convrot.safetensors");
    expect(wf["94"].inputs.text).toBe("blurry");
    expect(wf["102"].inputs).toMatchObject({ width: 1360, height: 768 });
    expect(wf["3"].inputs).toMatchObject({ seed: 7, steps: 30, cfg: 5, sampler_name: "euler", scheduler: "simple", denoise: 1 });
    expect(wf["56"].inputs.filename_prefix).toBe("fuobe/g");
    expect(dangling(wf)).toEqual([]);
  });

  it("runs at about one megapixel by default", async () => {
    const wf = await prepare("fibo2-dev-t2i", { prompt: "a lighthouse at dawn", aspectRatio: "1:1", resolution: "1K" }, "t2i");
    expect(wf["102"].inputs).toMatchObject({ width: 1024, height: 1024 });
    expect(wf["94"].inputs.text).toBe("");
    expect(getModel("oss-fibo2-dev")!.options.resolutions).toEqual(["1K"]);
  });
});

describe("FIBO 2 edits", () => {
  it("one picture: references 2-4 are left out of the encoder, image 1 is scaled to 1 MP on the 16-pixel grid", async () => {
    const wf = await prepare("fibo2-dev-edit", { prompt: "Make the jacket in <image_1> red", images: ["a.png"] }, "edit");
    for (const id of ["116", "117", "118"]) expect(wf[id], id).toBeUndefined();
    expect(references(wf, "112")).toEqual(["images.image_1"]);
    expect(wf["112"].inputs).toMatchObject({ prompt: "Make the jacket in <image_1> red", negative_prompt: "", "images.image_1": ["115", 0], width: 0, height: 0 });
    expect(wf["113"].inputs.image).toBe("a.png");
    expect(wf["114"].inputs).toMatchObject({ input: ["113", 0], resize_type: "scale total pixels", "resize_type.megapixels": 1, scale_method: "bicubic" });
    expect(wf["115"].inputs).toMatchObject({ input: ["114", 0], resize_type: "scale to multiple", "resize_type.multiple": 16 });
    expect(wf["37"].inputs.unet_name).toBe("fibo2_dev_int8_convrot.safetensors");
    expect(wf["3"].inputs).toMatchObject({ seed: 7, steps: 30, cfg: 5, sampler_name: "euler", scheduler: "simple", positive: ["112", 0], negative: ["112", 1], latent_image: ["112", 2] });
    expect(dangling(wf)).toEqual([]);
  });

  it("takes the references it is given, in order, and leaves out only the rest", async () => {
    const two = await prepare("fibo2-dev-edit", { prompt: "Put the woman from <image_2> in <image_1>", images: ["a.png", "b.png"] }, "edit");
    expect(references(two, "112")).toEqual(["images.image_1", "images.image_2"]);
    expect(two["116"].inputs.image).toBe("b.png");
    expect(two["117"]).toBeUndefined();
    const four = await prepare("fibo2-dev-edit", { prompt: "x", images: ["a.png", "b.png", "c.png", "d.png"] }, "edit");
    expect(references(four, "112")).toEqual(["images.image_1", "images.image_2", "images.image_3", "images.image_4"]);
    expect([four["116"], four["117"], four["118"]].map((n) => n.inputs.image)).toEqual(["b.png", "c.png", "d.png"]);
    expect(dangling(four)).toEqual([]);
  });

  it("a negative prompt reaches FIBO 2 Dev's encoder, and steps and cfg sent with the request its sampler", async () => {
    const wf = await prepare("fibo2-dev-edit", { prompt: "x", negativePrompt: "extra fingers", images: ["a.png"], extra: { steps: 20, cfg: 4 } }, "edit");
    expect(wf["112"].inputs.negative_prompt).toBe("extra fingers");
    expect(wf["3"].inputs).toMatchObject({ steps: 20, cfg: 4 });
  });

  it("Edit Turbo runs 4 steps at cfg 1 on its own weights", async () => {
    const wf = await prepare("fibo2-edit-turbo-edit", { prompt: "Swap the sky for a sunset", images: ["a.png", "b.png", "c.png"] }, "edit");
    expect(wf["37"].inputs.unet_name).toBe("fibo2_edit_turbo_int8_convrot.safetensors");
    expect(wf["3"].inputs).toMatchObject({ seed: 7, steps: 4, cfg: 1, sampler_name: "euler", scheduler: "simple" });
    expect(references(wf, "112")).toEqual(["images.image_1", "images.image_2", "images.image_3"]);
    expect(wf["118"]).toBeUndefined();
    expect(dangling(wf)).toEqual([]);
    // cfg 1 has no negative pass: no negative prompt to offer.
    const { manifest } = getWorkflow("fibo2-edit-turbo-edit");
    expect(Object.keys(manifest.bindings)).not.toContain("negativePrompt");
    expect(getModel("oss-fibo2-edit-turbo")!.options.negativePrompt).toBeFalsy();
  });

  it("asks for the picture to edit", async () => {
    await expect(prepare("fibo2-edit-turbo-edit", { prompt: "x" }, "edit")).rejects.toThrow(/Add an image/);
  });
});

describe("optional references (encoders that take any number of images)", () => {
  // LoadImage → ImageScale → an encoder's images.image_2; the encoder feeds the sampler, the sampler the output.
  const graph = (): ComfyWorkflow => ({
    "1": { class_type: "LoadImage", inputs: { image: "a.png" } },
    "2": { class_type: "LoadImage", inputs: { image: "b.png" } },
    "3": { class_type: "ImageScale", inputs: { image: ["2", 0] } },
    "4": { class_type: "TextEncodeFibo2", inputs: { prompt: "x", "images.image_1": ["1", 0], "images.image_2": ["3", 0] } },
    "5": { class_type: "KSampler", inputs: { positive: ["4", 0] } },
    "6": { class_type: "SaveImage", inputs: { images: ["5", 0] } },
  });

  it("drops the loader and what only it feeds, up to any of the named classes", () => {
    const wf = dropBranch(graph(), "2", new Set(["TextEncodeQwenImage21", "TextEncodeFibo2"]), ["6"])!;
    expect(Object.keys(wf).sort()).toEqual(["1", "4", "5", "6"]);
    expect(wf["4"].inputs).toEqual({ prompt: "x", "images.image_1": ["1", 0] });
    // One class name still works as before.
    expect(Object.keys(dropBranch(graph(), "2", "TextEncodeFibo2", ["6"])!).sort()).toEqual(["1", "4", "5", "6"]);
  });

  it("refuses a branch that doesn't end in one of them", () => {
    expect(dropBranch(graph(), "2", new Set(["TextEncodeQwenImage21"]), ["6"])).toBeNull();
    expect(dropBranch(graph(), "9", new Set(["TextEncodeFibo2"]))).toBeNull();
  });
});
