import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Manifest } from "@/lib/comfy";

/**
 * Idol 3D quick mesh (idol-7, docs/research/idol-9.md §9): Idol's splat graph with the splat file replaced by core
 * SplatToMesh, saved as a vertex-coloured GLB beside the orbit video; the model in From an image (open engine only),
 * its outputs as a mesh (never a splat), its licence row, its pre-flight row and Refine this mesh on its results.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fuobe-idol-mesh-"));
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";

const { collectOutputs, getWorkflow, prepareWorkflow } = await import("@/server/providers/comfyui");
const { MODELS, getModel, getPreset } = await import("@/lib/catalog");
const { planGeneration } = await import("@/lib/catalog/plan");
const { buildLicenceList, licenceTerms, workflowLicence } = await import("@/lib/licences");
const { modelChoices } = await import("@/lib/catalog/canvas");
const { modelToFinish } = await import("@/server/model3d-finish");
const { STUDIO_ROWS, studioTool } = await import("@/server/gpu/tools");
const m3d = await import("@/lib/av/model3d");
const hi3d = await import("@/lib/av/hi3d");

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const root = process.cwd();
const read = (...p: string[]) => JSON.parse(fs.readFileSync(path.join(root, ...p), "utf8"));
const manifest = read("workflows", "comfyui", "manifest.json") as Manifest;
const entry = manifest.workflows.find((w) => w.id === "image-to-mesh-idol")!;
const splatEntry = manifest.workflows.find((w) => w.id === "image-to-splat-idol")!;
type Node = { class_type: string; inputs: Record<string, unknown> };
const graph = read("workflows", "comfyui", "image-to-mesh-idol.json") as Record<string, Node>;
const splat = read("workflows", "comfyui", "image-to-splat-idol.json") as Record<string, Node>;
const photo = "/api/files/uploads/p.png";
const file = (filename: string) => ({ filename, subfolder: "fuobe", type: "output" });

describe("image-to-mesh-idol: the manifest entry", () => {
  it("is an image-to-3D graph on core nodes, 8 GB, with Idol's bindings plus the mesh grid and no splat format", () => {
    expect(entry).toMatchObject({ capability: "image-to-3d", customNodes: [], vramGb: 8, validated: true });
    expect(entry.defaults).toMatchObject({ cutout: true, photoCrop: false, steps: 50, cfg: 4, numGaussians: 262144, orbitFrames: 75 });
    expect(Object.keys(entry.bindings).sort()).toEqual(["cfg", "cutout", "filenamePrefix", "image", "meshResolution", "numGaussians", "orbitFrames", "photoCrop", "sampler", "seed", "steps"]);
    expect(entry.bindings.meshResolution).toEqual([{ node: "93", input: "resolution" }]);
    for (const k of ["image", "cutout", "numGaussians", "steps", "cfg", "sampler", "photoCrop", "seed", "orbitFrames"]) expect(entry.bindings[k], k).toEqual(splatEntry.bindings[k]);
    expect(entry.outputs).toEqual([
      { node: "51", kind: "model3d" },
      { node: "42", kind: "video", role: "turntable" },
    ]);
  });

  it("needs exactly Idol's five files, and is in the GPU check's index with no pack", () => {
    expect(entry.models.map((m) => [m.file, m.url, m.sizeGb])).toEqual(splatEntry.models.map((m) => [m.file, m.url, m.sizeGb]));
    const req = read("workflows", "comfyui", "requirements.json") as { workflows: Record<string, { core: string[]; files: string[]; packs: object; validated: boolean }> };
    const mesh = req.workflows["image-to-mesh-idol"];
    expect(mesh.files).toEqual(req.workflows["image-to-splat-idol"].files);
    expect(mesh.packs).toEqual({});
    expect(mesh.core).toContain("SplatToMesh");
    expect(mesh.core).not.toContain("SplatToFile3D");
    expect(read("scripts", "comfy", "validation-state.json")["image-to-mesh-idol"].validated).toBe(true);
  });

  it("carries the same licence as Idol 3D, with the DINOv3 notice", () => {
    expect(entry.license).toBe(splatEntry.license);
    const text = workflowLicence(entry);
    expect(text).toMatch(/^Apache-2.0/);
    expect(licenceTerms(text).notices).toEqual(["Built with DINOv3"]);
  });
});

describe("image-to-mesh-idol: the graph", () => {
  it("meshes Idol's splat with core SplatToMesh at its defaults (384, min_opacity 0.02) and saves a GLB", () => {
    expect(graph["93"]).toMatchObject({
      class_type: "SplatToMesh",
      inputs: { splat: ["88:55", 0], resolution: 384, kernel: 5, smooth: 0, level: 0.4, min_component: 500, min_opacity: 0.02, color_sharpen: 2 },
    });
    expect(graph["51"]).toMatchObject({ class_type: "SaveGLB", inputs: { mesh: ["93", 0] } });
    // The hand-built graph's prefix; the build names the library copy after the workflow, and each job sets its own.
    expect(read("scripts", "comfy", "hand-built", "image-to-mesh-idol.json")["51"].inputs.filename_prefix).toBe("fuobe/idol-mesh");
    expect(Object.values(graph).some((n) => n.class_type === "SplatToFile3D")).toBe(false);
  });

  it("keeps the orbit video and everything else as Idol's splat graph has it", () => {
    expect(graph["75"].inputs).toMatchObject({ splat: ["88:55", 0], opacity_threshold: 0.05, frames: 75 });
    expect(graph["42"]).toMatchObject({ class_type: "SaveVideo", inputs: { video: ["41", 0] } });
    for (const [id, node] of Object.entries(splat)) {
      if (id === "92") continue;
      expect(graph[id]?.class_type, id).toBe(node.class_type);
      if (!["51", "42"].includes(id)) expect(graph[id].inputs, id).toEqual(node.inputs);
    }
    expect(Object.keys(graph).filter((id) => !splat[id])).toEqual(["93"]);
  });

  it("binds the photo, the seed, the crop and the mesh grid; a grid from Canvas or Assist is kept to 64-768 in steps of 16", async () => {
    const ctx = { generationId: "gen-mesh", op: "image-to-3d" as const, upload: async () => "x" };
    const { workflow } = await prepareWorkflow("image-to-mesh-idol", { prompt: "", images: ["p.png"], seed: 7, extra: { meshResolution: 512, photoCrop: true } }, ctx);
    expect(workflow["99"].inputs.image).toBe("p.png");
    expect(workflow["88:6"].inputs).toMatchObject({ seed: 7, steps: 50, cfg: 4, sampler_name: "euler" });
    expect(workflow["88:55"].inputs).toMatchObject({ seed: 7, num_gaussians: 262144 });
    expect(workflow["88:104"].inputs.switch).toBe(true);
    expect(workflow["88:35"].inputs.switch).toBe(true);
    expect(workflow["93"].inputs.resolution).toBe(512);
    const grid = async (v: unknown) => (await prepareWorkflow("image-to-mesh-idol", { prompt: "", images: ["p.png"], extra: { meshResolution: v } }, ctx)).workflow["93"].inputs.resolution;
    expect(await grid(2000)).toBe(768);
    expect(await grid(10)).toBe(64);
    expect(await grid(390)).toBe(384);
    expect(await grid("nope")).toBe(384);
    // Hi3D's graph still refuses a resolution it can't take.
    await expect(prepareWorkflow("mesh-refine-hi3d", { prompt: "", images: ["p.png"], model3d: "m.glb", extra: { meshResolution: 384 } } as never, { ...ctx, op: "refine-3d" as const })).rejects.toThrow(/512, 1024 or 1536/);
  });
});

describe("Idol 3D quick mesh: the model and From an image", () => {
  it("routes oss-idol-mesh to the graph on the open engine only", () => {
    const m = getModel("oss-idol-mesh")!;
    expect(m).toMatchObject({ name: "Idol 3D quick mesh", vendor: "Speridlabs", kind: "model3d", engine: "open" });
    expect(m.tagline).toBe("A rough vertex-coloured .glb from one picture, no textures · 8 GB GPU · Apache-2.0 · Built with DINOv3");
    expect(m.routes).toEqual([expect.objectContaining({ op: "image-to-3d", provider: "comfyui", endpoint: "image-to-mesh-idol" })]);
    expect(MODELS.filter((x) => x.name === "Idol 3D quick mesh")).toHaveLength(1);
    expect(m.options.sliders?.map((s) => [s.param, s.min, s.max, s.default])).toEqual([["meshResolution", 128, 768, 384]]);
    expect(m.options.controls?.find((c) => c.param === hi3d.HI3D_CHAIN_PARAM)).toMatchObject({ default: "off" });
  });

  it("comes after Pixal3D, TRELLIS.2 and Hunyuan3D 2.1 in From an image, with its note; the cloud list is unchanged", () => {
    expect(m3d.MODELS_3D.image.open).toEqual([
      expect.objectContaining({ id: "oss-pixal3d" }),
      expect.objectContaining({ id: "oss-trellis2" }),
      // Photo to 3D's Idol 3D Mesh (its own graph, with an orbit clip) sits before Hunyuan3D 2.1.
      expect.objectContaining({ id: "oss-idol-3d" }),
      expect.objectContaining({ id: "oss-hunyuan3d-21" }),
      { id: "oss-idol-mesh", note: "Rough mesh, vertex colours, no textures · 8 GB GPU" },
    ]);
    expect(m3d.MODELS_3D.image.cloud.some((c) => c.id.includes("idol"))).toBe(false);
    expect(m3d.model3dFor("image", "open")).toBe("oss-pixal3d");
    expect(m3d.modeOf("oss-idol-mesh")).toEqual({ mode: "image", engine: "open" });
    expect(m3d.ALL_MODELS_3D.some((x) => x.id === "oss-idol-mesh")).toBe(true);
    // The splat list keeps TripoSplat and Idol 3D.
    expect(m3d.MODELS_3D.splat.open.map((x) => x.id)).toEqual(["oss-triposplat", "oss-idol"]);
  });

  it("asks for image-to-3d with the photo and Idol's Best / Quick look and photo crop, and plans on the graph", async () => {
    const req = m3d.model3dRequest({ engine: "open", mode: "image", modelId: "oss-idol-mesh", photo, quality: "quick", photoCrop: true });
    expect(req).toEqual({
      feature: "image-to-3d",
      modelId: "oss-idol-mesh",
      op: "image-to-3d",
      inputs: { images: [photo] },
      params: { extra: { steps: 20, sampler: "dpmpp_2m", cfg: 4, numGaussians: 65536, photoCrop: true } },
    });
    expect(m3d.model3dRequest({ engine: "open", mode: "image", modelId: "oss-idol-mesh", photo }).params?.extra).toEqual({ ...m3d.IDOL_PRESETS.best, photoCrop: false });
    const p = planGeneration(req, getModel, getPreset);
    expect(p.model.id).toBe("oss-idol-mesh");
    expect(p.op).toBe("image-to-3d");
    // The settings reach Idol's nodes in the mesh graph.
    const ctx = { generationId: "gen-mesh", op: "image-to-3d" as const, upload: async () => "x" };
    const { workflow } = await prepareWorkflow("image-to-mesh-idol", { prompt: "", images: ["p.png"], extra: req.params!.extra }, ctx);
    expect(workflow["88:6"].inputs).toMatchObject({ steps: 20, sampler_name: "dpmpp_2m" });
    expect(workflow["88:55"].inputs).toMatchObject({ num_gaussians: 65536 });
    expect(workflow["88:104"].inputs.switch).toBe(true);
    // Other From an image models get no Idol settings.
    expect(m3d.model3dRequest({ engine: "open", mode: "image", modelId: "oss-trellis2", photo, quality: "quick", photoCrop: true }).params).toBeUndefined();
    expect(m3d.isIdolMesh("oss-idol-mesh") && !m3d.isIdol("oss-idol-mesh")).toBe(true);
  });

  it("is offered by a Canvas 3D model node", () => {
    const ids = modelChoices({ type: "model", data: { mediaKind: "model3d" } } as never).map((m) => m.id);
    expect(ids).toContain("oss-idol-mesh");
  });
});

describe("Idol 3D quick mesh: what a finished job gives", () => {
  const history = { status: { status_str: "success", completed: true }, outputs: { "51": { "3d": [file("gen-mesh_00001_.glb")] }, "42": { images: [file("gen-mesh_00001_.mp4")], animated: [true] } } };

  it("comes back as a GLB model (no role, no splat format), with the orbit kept as a file but not shown as the mesh's turntable", () => {
    const outs = collectOutputs(history as never, getWorkflow("image-to-mesh-idol").manifest);
    expect(outs.map((o) => [o.kind, o.contentType, o.meta])).toEqual([
      ["model3d", "model/gltf-binary", undefined],
      ["video", undefined, { role: "turntable" }],
    ]);
    const g = { outputs: outs, request: { feature: "image-to-3d", modelId: "oss-idol-mesh", op: "image-to-3d" as const, inputs: { images: [photo] } } };
    const view = m3d.model3dView(g as never);
    expect(view.splat).toBeUndefined();
    expect(view.glb).toBe(outs[0].url);
    // The graph's video is the splat's orbit, smoother than the mesh: not the card's turntable until the server renders the mesh's.
    expect(view.turntable).toBeUndefined();
    expect(view.photo).toBe(photo);
    // Its GLB is Idol's splat through SplatToMesh, as Photo to 3D's: the card and the viewer open on, and turn from, the same front.
    expect(m3d.FRONT_YAW["oss-idol-mesh"]).toBe(m3d.FRONT_YAW["oss-idol-3d"]);
    const skipped = m3d.model3dView({ ...g, outputs: [{ ...outs[0], meta: { finish: { turntable: "skipped: no Chromium" } } }, outs[1]] } as never);
    expect(skipped.turntable).toBeUndefined();
    const mine = { url: "/api/files/turntable.mp4", kind: "video", contentType: "video/mp4", meta: { role: "turntable", fps: 24, frames: 96 } };
    const done = m3d.model3dView({ ...g, outputs: [{ ...outs[0], meta: { finish: { turntable: "done" } } }, mine] } as never);
    expect(done.turntable).toBe(mine.url);
    // Another model's graph turntable still shows (Idol's own splat orbit, TRELLIS.2's).
    expect(m3d.model3dView({ ...g, request: { ...g.request, modelId: "oss-trellis2" } } as never).turntable).toBe(outs[1].url);
    // Once saved, the server finishes the GLB like every image-to-3D route's (a web GLB, and its own turntable of the mesh).
    const saved = outs.map((o, i) => ({ ...o, assetId: `a${i}` }));
    expect(modelToFinish({ provider: "comfyui", op: "image-to-3d" }, saved as never)).toBe(0);
    expect(modelToFinish({ provider: "comfyui", op: "image-to-3d" }, [{ ...saved[0], meta: { role: "splat", format: "spz" } }] as never)).toBe(-1);
  });

  it("offers Refine this mesh with the source picture, and the Hi3D step after the build on the open engine", () => {
    const outs = collectOutputs(history as never, getWorkflow("image-to-mesh-idol").manifest);
    const view = m3d.model3dView({ outputs: outs, request: { feature: "image-to-3d", modelId: "oss-idol-mesh", op: "image-to-3d", inputs: { images: [photo] } } } as never);
    expect(hi3d.canRefine({ glb: view.glb, photo: view.photo, splat: view.splat, openAllowed: true })).toBe(true);
    expect(hi3d.refineRequest({ glb: view.glb!, photo: view.photo! })).toMatchObject({ modelId: "oss-hi3d-refine", inputs: { model3d: view.glb, images: [photo] } });
    const req = hi3d.withRefine(m3d.model3dRequest({ engine: "open", mode: "image", modelId: "oss-idol-mesh", photo }), "open", 512);
    expect(req.params?.extra).toEqual({ ...m3d.IDOL_PRESETS.best, photoCrop: false, hi3dRefine: 512 });
  });
});

describe("Idol 3D quick mesh: licence row and the GPU pre-flight", () => {
  it("has its own row in Models & licences, with Idol's licence and the DINOv3 notice", () => {
    const list = buildLicenceList(MODELS, manifest.workflows);
    const row = list.rows.find((r) => r.id === "oss-idol-mesh")!;
    expect(row).toMatchObject({ name: "Idol 3D quick mesh", by: "Speridlabs", workflows: ["image-to-mesh-idol"], inCatalog: true });
    expect(row.notices).toEqual(["Built with DINOv3"]);
    expect(row.flags).toEqual(list.rows.find((r) => r.id === "oss-idol")!.flags);
    expect(list.notices.find((n) => n.text === "Built with DINOv3")?.models).toContain("Idol 3D quick mesh");
  });

  it("has a row on the board that needs the graph", () => {
    const row = STUDIO_ROWS.find((r) => r.label === "Image to 3D, quick mesh")!;
    expect(row).toMatchObject({ href: "/image-to-3d?model=oss-idol-mesh", group: "Images", steps: [{ modelId: "oss-idol-mesh", op: "image-to-3d" }] });
    expect(studioTool(row)!.workflows).toEqual(["image-to-mesh-idol"]);
  });
});
