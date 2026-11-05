import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Generation, OutputFile } from "@/lib/catalog/types";

/**
 * Photo to 3D (app-photo-to-3d) and Image to 3D's quick model: Idol on core nodes (image-to-3d-idol), its splat made
 * into a GLB, the splat and an orbit clip beside it; the result's view, tiles and downloads; no server turntable when
 * the job brought its orbit; the tap-to-turn chips' camera; the app and the Library's "Make it 3D".
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fuobe-photo3d-"));
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";

const { setSetting } = await import("@/server/settings");
const { collectOutputs, getWorkflow, prepareWorkflow } = await import("@/server/providers/comfyui");
const { getModel, getPreset } = await import("@/lib/catalog");
const { planGeneration } = await import("@/lib/catalog/plan");
const { OWN_ROUTE_APPS } = await import("@/lib/catalog/preset-recipe-routes");
const m3d = await import("@/lib/av/model3d");
const { outputActions, shownOutputs } = await import("@/lib/output-actions");
const { turntableState, OWN_ORBIT, ACCOUNT_TURNTABLE } = await import("@/server/model3d-finish");

beforeAll(() => setSetting("demoMode", "auto"));
// The database file stays open on Windows until the run ends: removing the folder may fail there, which is fine.
afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
});

const ROOT = path.resolve(__dirname, "..");
const readJson = (p: string) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const manifest = readJson("workflows/comfyui/manifest.json") as { workflows: { id: string; [k: string]: unknown }[] };
const entry = manifest.workflows.find((w) => w.id === "image-to-3d-idol") as unknown as {
  capability: string;
  outputs: { node: string; kind: string; role?: string }[];
  defaults: Record<string, unknown>;
  models: { file: string; folder: string; url: string; sizeGb: number }[];
  customNodes: unknown[];
  license: string;
  vramGb: number;
};
const graph = readJson("workflows/comfyui/image-to-3d-idol.json") as Record<string, { class_type: string; inputs: Record<string, unknown> }>;

describe("the graph (image-to-3d-idol)", () => {
  it("is core ComfyUI only, every class known to the recorded object_info", () => {
    const info = readJson("workflows/comfyui/object_info.subset.json") as Record<string, { python_module: string }>;
    for (const n of Object.values(graph)) {
      expect(info[n.class_type], n.class_type).toBeTruthy();
      expect(info[n.class_type].python_module.startsWith("custom_nodes."), n.class_type).toBe(false);
    }
    expect(entry.customNodes).toEqual([]);
    expect(info.SplatToMesh).toMatchObject({ output: ["MESH"], python_module: "comfy_extras.nodes_gaussian_splat" });
  });

  it("runs Idol's files at its reference settings and makes the GLB from the splat", () => {
    expect(graph["88:16"].inputs.unet_name).toBe("idol_fp16.safetensors");
    expect(graph["88:11"].inputs.vae_name).toBe("idol_decoder_fp16.safetensors");
    expect(graph["88:6"].inputs).toMatchObject({ steps: 50, cfg: 4, sampler_name: "euler", scheduler: "simple", model: ["88:16", 0] });
    expect(graph["60"]).toMatchObject({ class_type: "SplatToMesh", inputs: { splat: ["88:55", 0], min_opacity: 0.05 } });
    expect(graph["61"]).toMatchObject({ class_type: "SaveGLB", inputs: { mesh: ["60", 0] } });
    // The faint halo stays out of the clip and the still.
    expect(graph["75"].inputs.opacity_threshold).toBe(0.05);
    expect(graph["76"].inputs).toMatchObject({ frames: 1, opacity_threshold: 0.05, camera_info: ["80", 0] });
    // The conditioning reads the photo-crop switch, whose default is Idol's own (synthetic) crop.
    expect(graph["88:24"].inputs.image).toEqual(["88:104", 0]);
    expect(graph["88:104"].inputs).toMatchObject({ switch: false, on_false: ["88:2", 0], on_true: ["88:103", 0] });
  });

  it("declares the GLB first, then the splat, the orbit and the still; pins the new files; names its licences", () => {
    expect(entry.capability).toBe("image-to-3d");
    expect(entry.outputs).toEqual([
      { node: "61", kind: "model3d" },
      { node: "51", kind: "model3d", role: "splat" },
      { node: "42", kind: "video", role: "orbit" },
      { node: "77", kind: "image" },
    ]);
    expect(entry.defaults).toMatchObject({ steps: 50, cfg: 4, numGaussians: 262144, orbitFrames: 96, meshDetail: 384, frontYaw: 90, cutout: true, photoCrop: false, splatFormat: "spz" });
    expect(entry.models.map((m) => m.file).sort()).toEqual(
      ["birefnet.safetensors", "dino_v3_vit_h.safetensors", "flux2-vae.safetensors", "idol_decoder_fp16.safetensors", "idol_fp16.safetensors"].sort(),
    );
    for (const m of entry.models.filter((x) => x.file.startsWith("idol_"))) expect(m.url).toMatch(/^https:\/\/huggingface\.co\/nynxz\/Idol\/resolve\/c718f2b1b95b353edd07d17e845719fc10880a44\//);
    const pins = readJson("workflows/comfyui/model-pins.json") as Record<string, { sha256: string; sizeBytes: number }>;
    const pinned = Object.entries(pins).filter(([u]) => u.includes("/nynxz/Idol/"));
    expect(pinned.map(([, p]) => [p.sizeBytes, p.sha256]).sort()).toEqual([
      [576148658, "c511d99eb668ec4b06d883cb6e43770bc35e3864e16e7058e8d6211ba5c509aa"],
      [741107210, "cf452146f78e23a0d34be8f9f79bcde642b9a40ef493046c8e9d5f79096f6dd0"],
    ]);
    expect(entry.license).toMatch(/^Apache-2\.0/);
    expect(entry.license).toMatch(/Built with DINOv3/);
    const req = readJson("workflows/comfyui/requirements.json") as { workflows: Record<string, { core: string[]; packs: Record<string, unknown>; files: string[] }> };
    expect(req.workflows["image-to-3d-idol"].packs).toEqual({});
    expect(req.workflows["image-to-3d-idol"].core).toContain("SplatToMesh");
    expect(req.workflows["image-to-3d-idol"].files).toContain("diffusion_models/idol_fp16.safetensors");
  });

  it("binds the photo and the settings a request sends", async () => {
    const { workflow } = await prepareWorkflow(
      "image-to-3d-idol",
      { prompt: "", images: ["p.png"], seed: 7, extra: { photoCrop: true, meshDetail: 256, frontYaw: 180 } },
      { generationId: "gen-i3", op: "image-to-3d", upload: async () => "x" },
    );
    expect(workflow["99"].inputs.image).toBe("p.png");
    expect(workflow["88:104"].inputs.switch).toBe(true);
    expect(workflow["60"].inputs.resolution).toBe(256);
    expect(workflow["79"].inputs["mode.yaw"]).toBe(180);
    expect(workflow["80"].inputs["mode.yaw"]).toBe(180);
    expect(workflow["88:6"].inputs.seed).toBe(7);
    expect(workflow["88:55"].inputs.seed).toBe(7);
  });

  it("collects the GLB, the splat with its format, the orbit and the still", () => {
    const file = (filename: string) => ({ filename, subfolder: "fuobe", type: "output" });
    const outs = collectOutputs(
      {
        status: { status_str: "success", completed: true },
        outputs: {
          "77": { images: [file("a_00001_.png")] },
          "42": { images: [file("a_00001_.mp4")], animated: [true] },
          "51": { "3d": [file("a_00001_.spz")] },
          "61": { "3d": [file("a_00002_.glb")] },
        },
      },
      getWorkflow("image-to-3d-idol").manifest,
    );
    expect(outs.map((o) => [o.kind, o.meta])).toEqual([
      ["model3d", undefined],
      ["model3d", { role: "splat", format: "spz" }],
      ["video", { role: "orbit" }],
      ["image", undefined],
    ]);
  });
});

describe("the model and the app", () => {
  it("Idol 3D runs the graph on the open engine only, and Image to 3D offers it after Pixal3D and TRELLIS.2", () => {
    const m = getModel("oss-idol-3d")!;
    expect(m).toMatchObject({ engine: "open", kind: "model3d" });
    expect(m.routes).toEqual([expect.objectContaining({ op: "image-to-3d", provider: "comfyui", endpoint: "image-to-3d-idol" })]);
    // Idol 3D quick mesh (Idol's splat as a vertex-coloured mesh, no orbit clip) comes last.
    expect(m3d.MODELS_3D.image.open.map((c) => c.id)).toEqual(["oss-pixal3d", "oss-trellis2", "oss-idol-3d", "oss-hunyuan3d-21", "oss-idol-mesh"]);
    expect(m3d.model3dFor("image", "open")).toBe("oss-pixal3d");
    expect(m3d.modeOf("oss-idol-3d")).toEqual({ mode: "image", engine: "open" });
  });

  it("Photo to 3D: one photo, no words, no cloud route, its own route kept", () => {
    const p = getPreset("app-photo-to-3d")!;
    expect(p).toMatchObject({ type: "app", name: "Photo to 3D", category: "Product", userPrompt: "none", cloud: null });
    expect(p.open).toMatchObject({ modelId: "oss-idol-3d", op: "image-to-3d" });
    expect(p.inputs).toEqual([expect.objectContaining({ key: "image", accept: "image", required: true })]);
    expect(OWN_ROUTE_APPS.has("app-photo-to-3d")).toBe(true);
    const plan = planGeneration({ feature: "app:app-photo-to-3d", presetId: p.id, modelId: "oss-idol-3d", op: "image-to-3d", inputs: { images: ["/api/files/p.png"] } }, getModel, getPreset);
    expect(plan.model.id).toBe("oss-idol-3d");
  });

  it("says nothing of models, splats or files in the app's own words", () => {
    const p = getPreset("app-photo-to-3d")!;
    const words = [p.name, p.description, p.parity ?? "", ...p.inputs.flatMap((s) => [s.label, s.hint ?? ""])].join(" ");
    expect(words).not.toMatch(/idol|tripo|splat|gaussian|comfy|lora|safetensors|dino/i);
  });
});

const gen = (outputs: OutputFile[]): Generation =>
  ({
    id: "gen123456",
    kind: "model3d",
    status: "succeeded",
    op: "image-to-3d",
    modelId: "oss-idol-3d",
    modelName: "Idol 3D",
    feature: "app:app-photo-to-3d",
    favorite: false,
    request: { feature: "app:app-photo-to-3d", modelId: "oss-idol-3d", op: "image-to-3d", inputs: { images: ["/api/files/p.png"] } },
    outputs,
  }) as unknown as Generation;

const idolOutputs: OutputFile[] = [
  { url: "/api/files/m.glb", kind: "model3d", contentType: "model/gltf-binary", meta: { web: "/api/files/m-web.glb" } },
  { url: "/api/files/s.spz", kind: "model3d", contentType: "model/x-spz", meta: { role: "splat", format: "spz" } },
  { url: "/api/files/o.mp4", kind: "video", meta: { role: "orbit" } },
  { url: "/api/files/p.png", kind: "image" },
];

describe("the result", () => {
  it("shows the GLB, with the splat as a download and the orbit as its turntable", () => {
    const v = m3d.model3dView(gen(idolOutputs));
    expect(v).toMatchObject({ glb: "/api/files/m.glb", web: "/api/files/m-web.glb", turntable: "/api/files/o.mp4", poster: "/api/files/p.png" });
    expect(v.splat).toBeUndefined();
    expect(v.formats).toEqual({ splat: "/api/files/s.spz" });
  });

  it("is one tile (the GLB), whose menu also downloads the splat", () => {
    const g = gen(idolOutputs);
    expect(shownOutputs(g)).toEqual([0]);
    const acts = outputActions(g, 0);
    expect(acts.find((a) => a.id === "download")?.label).toBe("Download .glb");
    expect(acts.find((a) => a.id === "download-splat")).toMatchObject({ label: "Download 3D splat (.spz)", placement: "menu" });
    expect(acts.find((a) => a.id === "download-splat")?.href).toMatch(/^\/api\/files\/s\.spz\?download=.+\.spz$/);
  });

  it("leaves a splat-only result (TripoSplat) as it was", () => {
    const g = gen([{ url: "/api/files/s.spz", kind: "model3d", meta: { role: "splat", format: "spz" } }, { url: "/api/files/t.mp4", kind: "video", meta: { role: "turntable" } }]);
    expect(shownOutputs(g)).toEqual([0]);
    expect(outputActions(g, 0).some((a) => a.id === "download-splat")).toBe(false);
    expect(m3d.model3dView(g).splat).toEqual({ url: "/api/files/s.spz", format: "spz" });
  });

  it("gets no server turntable when the job brought its orbit", () => {
    expect(turntableState(idolOutputs)).toBe(OWN_ORBIT);
    expect(turntableState(idolOutputs, "acct")).toBe(OWN_ORBIT);
    expect(turntableState([idolOutputs[0]])).toBe("queued");
    expect(turntableState([idolOutputs[0]], "acct")).toBe(ACCOUNT_TURNTABLE);
  });

  it("puts 'Make it 3D' on a picture's menu", () => {
    const g = { ...gen([{ url: "/api/files/look.png", kind: "image" }]), kind: "image", op: "t2i", provider: "comfyui" } as unknown as Generation;
    expect(outputActions(g, 0).find((a) => a.id === "make-3d")).toMatchObject({ label: "Make it 3D", href: "/apps/app-photo-to-3d?image=%2Fapi%2Ffiles%2Flook.png", placement: "menu" });
  });
});

describe("turn with taps", () => {
  it("has the five views and Left side is the subject's own left (camera on +X)", () => {
    expect(m3d.TURN_VIEWS.map((v) => v.label)).toEqual(["Front", "Left side", "Back", "Right side", "From above"]);
    expect(m3d.turnOrbit("front")).toBe("0deg 75deg 130%");
    expect(m3d.turnOrbit("left")).toBe("90deg 75deg 130%");
    expect(m3d.turnOrbit("back")).toBe("180deg 75deg 130%");
    expect(m3d.turnOrbit("right")).toBe("270deg 75deg 130%");
    expect(m3d.turnOrbit("above")).toBe("25deg 35deg 130%");
  });

  it("adds the model's front and keeps the angle in 0-359", () => {
    expect(m3d.turnOrbit("right", 180)).toBe("90deg 75deg 130%");
    expect(m3d.turnOrbit("front", -90)).toBe("270deg 75deg 130%");
    expect(m3d.FRONT_YAW["oss-idol-3d"]).toBe(90);
  });
});
