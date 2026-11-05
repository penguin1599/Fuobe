import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "./helpers/temp-dir";

/**
 * Hi3D 1.0 refine (hi3d-refine, docs/research/hi3d-refine.json): the request and its parameters, the chain Image to 3D
 * plans per engine (open: the model, then the refine of its mesh; cloud: none), the graph's bindings and pins, the
 * licence and its "Powered by Hi3D 1.0" notice, accounts refused like every 3D model, and the print-ready export's
 * scaling, watertight check and files. Nothing here runs Hi3D (it needs an Ampere-or-newer NVIDIA GPU).
 */

const dir = tempDir("fuobe-hi3d-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";

const { setSetting } = await import("@/server/settings");
const gens = await import("@/server/generations");
const { db } = await import("@/server/db");
const { getWorkflow, prepareWorkflow } = await import("@/server/providers/comfyui");
const { modelToFinish } = await import("@/server/model3d-finish");
const { getModel, getPreset, MODELS } = await import("@/lib/catalog");
const { inferOperation, planGeneration } = await import("@/lib/catalog/plan");
const { OPERATION_OUTPUT } = await import("@/lib/catalog/types");
const { buildLicenceList, licenceInfo, licenceTerms, NODE_PACKS } = await import("@/lib/licences");
const { OWN_GPU_TOOL_MESSAGE } = await import("@/lib/guest-access");
const { withRunStamp } = await import("@/server/run-stamp");
const hi3d = await import("@/lib/av/hi3d");
const m3d = await import("@/lib/av/model3d");
const print = await import("@/lib/print3d");

beforeAll(() => setSetting("demoMode", "auto"));

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const manifest = JSON.parse(read("workflows/comfyui/manifest.json")) as { workflows: { id: string; license: string; bindings: Record<string, unknown>; customNodes: { name: string }[]; models: { file: string; folder: string; url: string }[] }[] };
const wf = manifest.workflows.find((w) => w.id === "mesh-refine-hi3d")!;

describe("the request and its parameters", () => {
  it("takes 512, 1024 or 1536, else the default (1024); the strict reading refuses the rest", () => {
    expect(hi3d.hi3dResolution(512)).toBe(512);
    expect(hi3d.hi3dResolution("1536")).toBe(1536);
    expect(hi3d.hi3dResolution(2048)).toBe(1024);
    expect(hi3d.hi3dResolution(undefined)).toBe(1024);
    expect(hi3d.strictHi3dResolution("1024")).toBe(1024);
    expect(hi3d.strictHi3dResolution(768)).toBeNull();
    expect(hi3d.strictHi3dResolution("")).toBeNull();
  });

  it("refines a finished model with the photo it came from, on your GPU", () => {
    const req = hi3d.refineRequest({ glb: "/api/files/a.glb", photo: "/api/files/p.png", resolution: 1536, seed: 7 });
    expect(req).toEqual({
      feature: "image-to-3d",
      modelId: "oss-hi3d-refine",
      op: "refine-3d",
      engine: "open",
      inputs: { model3d: "/api/files/a.glb", images: ["/api/files/p.png"] },
      params: { extra: { meshResolution: 1536 }, seed: 7 },
    });
  });

  it("asks Image to 3D for the refine step on the open engine only, never on a splat", () => {
    const base = m3d.model3dRequest({ engine: "open", mode: "image", photo: "/api/files/p.png" });
    expect(hi3d.withRefine(base, "open", 512).params?.extra).toEqual({ hi3dRefine: 512 });
    expect(hi3d.withRefine(base, "cloud", 512)).toBe(base);
    expect(hi3d.withRefine(base, "open", null)).toBe(base);
    const splat = m3d.model3dRequest({ engine: "open", mode: "splat", photo: "/api/files/p.png" });
    expect(hi3d.withRefine(splat, "open", 1024)).toBe(splat);
    expect(hi3d.chainedRefine({ params: { extra: { hi3dRefine: "off" } } })).toBeNull();
    expect(hi3d.chainedRefine({ params: { extra: { hi3dRefine: 1536 } } })).toBe(1536);
  });

  it("offers Refine this mesh on a finished mesh with its photo, not on a splat, a rig or a refined model", () => {
    const ok = { glb: "/a.glb", photo: "/p.png", openAllowed: true };
    expect(hi3d.canRefine(ok)).toBe(true);
    expect(hi3d.canRefine({ ...ok, photo: undefined })).toBe(false);
    expect(hi3d.canRefine({ ...ok, splat: { url: "/s.spz" } })).toBe(false);
    expect(hi3d.canRefine({ ...ok, rigged: true })).toBe(false);
    expect(hi3d.canRefine({ ...ok, refined: true })).toBe(false);
    // Paid APIs only (or the model switched off): not offered.
    expect(hi3d.canRefine({ ...ok, openAllowed: false })).toBe(false);
  });
});

describe("the catalog: open engine only", () => {
  it("is an open model on its own graph, with no cloud route anywhere (nobody hosts the open Hi3D)", () => {
    const m = getModel("oss-hi3d-refine")!;
    expect(m).toMatchObject({ engine: "open", kind: "model3d", hidden: true });
    expect(m.routes).toEqual([expect.objectContaining({ op: "refine-3d", provider: "comfyui", endpoint: "mesh-refine-hi3d" })]);
    expect(m.engineNote).toMatch(/your GPU only/);
    expect(m.tagline).toMatch(/Powered by Hi3D 1\.0/);
    expect(MODELS.filter((x) => x.engine === "cloud" && x.routes.some((r) => r.op === "refine-3d"))).toEqual([]);
    expect(OPERATION_OUTPUT["refine-3d"]).toBe("model3d");
  });

  it("reads a model and a photo as a refine, and says what is missing", () => {
    const m = getModel("oss-hi3d-refine")!;
    expect(inferOperation(m, { inputs: { model3d: "/a.glb", images: ["/p.png"] } })).toBe("refine-3d");
    expect(() => planGeneration({ feature: "x", modelId: m.id, op: "refine-3d", inputs: { images: ["/p.png"] } }, getModel, getPreset)).toThrow(/3D model to refine/);
  });

  it("puts the switch on every open image-to-3D model, off unless picked", () => {
    for (const id of ["oss-pixal3d", "oss-trellis2", "oss-hunyuan3d-21", "oss-idol-mesh", "oss-trellis2-multi"]) {
      const c = getModel(id)!.options.controls?.find((x) => x.param === "hi3dRefine");
      expect(c, id).toMatchObject({ default: "off", values: ["off", 512, 1024, 1536] });
    }
  });
});

describe("the chain per engine", () => {
  const photo = "/api/files/placeholder.png";
  it("open: the picked model builds the mesh, then Hi3D refines it from the same photo (chain slot model3d)", () => {
    const req = hi3d.withRefine(m3d.model3dRequest({ engine: "open", mode: "image", modelId: "oss-trellis2", photo }), "open", 1536);
    const [refined, built] = gens.createGenerations(req);
    expect(built).toMatchObject({ modelId: "oss-trellis2", op: "image-to-3d" });
    expect(built.request.params?.extra?.hi3dRefine).toBeUndefined();
    expect(refined).toMatchObject({ modelId: "oss-hi3d-refine", op: "refine-3d", batchId: built.batchId });
    expect(refined.request.chain).toEqual([{ slot: "model3d" }]);
    expect(refined.request.inputs?.images).toEqual([photo]);
    expect(refined.request.params?.extra).toEqual({ meshResolution: 1536 });
    const dep = (db().prepare("SELECT depends_on FROM generations WHERE id = ?").get(refined.id) as { depends_on: string }).depends_on;
    expect(dep).toBe(built.id);
  });

  it("open, from several images: the front is the photo Hi3D reads", () => {
    const req = hi3d.withRefine(m3d.model3dRequest({ engine: "open", mode: "multi", views: { front: "/api/files/f.png", left: "/api/files/l.png" } }), "open", 512);
    const [refined, built] = gens.createGenerations(req);
    expect(built.modelId).toBe("oss-trellis2-multi");
    expect(refined.request.inputs?.images).toEqual(["/api/files/f.png"]);
  });

  const deps = (id: string) => {
    const v = (db().prepare("SELECT depends_on FROM generations WHERE id = ?").get(id) as { depends_on: string | null }).depends_on;
    return !v ? [] : v.startsWith("[") ? (JSON.parse(v) as string[]) : [v];
  };

  it("open, with the photo from an earlier step: the model waits for it, and Hi3D waits for the model and the same photo", async () => {
    const [still] = gens.createGenerations({ feature: "image", modelId: "oss-z-image-turbo", prompt: "A brass desk lamp" });
    const asked = { feature: "canvas", modelId: "oss-pixal3d", op: "image-to-3d" as const, params: { extra: { hi3dRefine: 512 } } };
    const [refined, built] = gens.createGenerations(asked, { batchId: "b-hi3d-up", dependsOn: [still.id] });
    expect(built).toMatchObject({ modelId: "oss-pixal3d", op: "image-to-3d", batchId: "b-hi3d-up" });
    expect(built.request.params?.extra?.hi3dRefine).toBeUndefined();
    expect(deps(built.id)).toEqual([still.id]);
    expect(refined).toMatchObject({ modelId: "oss-hi3d-refine", op: "refine-3d", batchId: "b-hi3d-up" });
    expect(refined.request.chain).toEqual([{ slot: "model3d" }, { slot: "images" }]);
    expect(refined.request.inputs?.images ?? []).toEqual([]);
    expect(refined.request.params?.extra).toEqual({ meshResolution: 512 });
    expect(deps(refined.id)).toEqual([built.id, still.id]);
    // Demo mode runs the three steps through: Hi3D gets the model's mesh and the still.
    const until = Date.now() + 40_000;
    while (!["succeeded", "failed", "canceled"].includes(gens.getGeneration(refined.id)!.status) && Date.now() < until) await new Promise((r) => setTimeout(r, 300));
    const done = gens.getGeneration(refined.id)!;
    expect(done.status, done.message ?? "").toBe("succeeded");
    expect(done.request.inputs?.model3d).toBe(gens.getGeneration(built.id)!.outputs[0].url);
    expect(done.request.inputs?.images).toEqual([gens.getGeneration(still.id)!.outputs[0].url]);
  }, 60_000);

  it("open, with its own photo and an earlier step feeding something else: Hi3D reads the photo it was given", () => {
    const [still] = gens.createGenerations({ feature: "image", modelId: "oss-z-image-turbo", prompt: "A brass desk lamp, side" });
    const asked = { feature: "canvas", modelId: "oss-pixal3d", op: "image-to-3d" as const, inputs: { images: [photo] }, params: { extra: { hi3dRefine: 1024 } } };
    const [refined, built] = gens.createGenerations(asked, { dependsOn: [still.id] });
    expect(deps(built.id)).toEqual([still.id]);
    expect(refined.request.chain).toEqual([{ slot: "model3d" }]);
    expect(refined.request.inputs?.images).toEqual([photo]);
    expect(deps(refined.id)).toEqual([built.id]);
  });

  it("off: one step, as before", () => {
    const steps = gens.createGenerations({ ...m3d.model3dRequest({ engine: "open", mode: "image", photo }), params: { extra: { hi3dRefine: "off" } } });
    expect(steps.map((g) => g.modelId)).toEqual(["oss-pixal3d"]);
  });

  it("cloud: no refine step (a cloud model asked for one is refused, never run on a substitute)", () => {
    const cloud = m3d.model3dRequest({ engine: "cloud", mode: "image", photo });
    expect(hi3d.withRefine(cloud, "cloud", 1024)).toBe(cloud);
    expect(() => gens.createGenerations({ ...cloud, params: { extra: { hi3dRefine: 1024 } } })).toThrow(/your GPU only/);
  });

  it("Paid APIs only: the refine isn't run", () => {
    setSetting("engineMode", "cloud");
    try {
      expect(() => gens.createGenerations(hi3d.refineRequest({ glb: "/api/files/placeholder.glb", photo }))).toThrow();
    } finally {
      setSetting("engineMode", "both");
    }
  });

  it("accounts: on this install's GPUs refused like every 3D model, before anything is queued", () => {
    const onPool = <T,>(fn: () => T) => gens.asAccount("acct-1", () => withRunStamp({ place: "pool" }, fn));
    expect(() => onPool(() => gens.createGenerations(hi3d.refineRequest({ glb: "/api/files/placeholder.glb", photo })))).toThrow(OWN_GPU_TOOL_MESSAGE);
    expect(() => onPool(() => gens.createGenerations(hi3d.withRefine(m3d.model3dRequest({ engine: "open", mode: "image", photo }), "open", 1024)))).toThrow(OWN_GPU_TOOL_MESSAGE);
  });

  it("is free on the open engine, and the refined GLB gets the server's finish", () => {
    expect(gens.previewGeneration(hi3d.refineRequest({ glb: "/api/files/placeholder.glb", photo }))).toMatchObject({ op: "refine-3d", costUsd: 0, engine: "open" });
    const glb = { url: "/api/files/r.glb", kind: "model3d" as const, contentType: "model/gltf-binary", assetId: "a1" };
    expect(modelToFinish({ provider: "comfyui", op: "refine-3d" }, [glb])).toBe(0);
  });
});

describe("the graph", () => {
  it("hands Hi3D the background as the mask (it reads 1 as transparent), and uses SDPA attention, which needs no flash-attn", () => {
    for (const g of [JSON.parse(read("scripts/comfy/hand-built/mesh-refine-hi3d.json")), getWorkflow("mesh-refine-hi3d").workflow]) {
      const [maskNode] = g["6"].inputs.mask as [string, number];
      // Core RemoveBackground's mask is the subject (1 = foreground); the pack's image_to_pil sets alpha = 1 - mask.
      expect(g[maskNode].class_type).toBe("InvertMask");
      expect(g[g[maskNode].inputs.mask[0]].class_type).toBe("RemoveBackground");
      // The pack's requirements carry no flash-attn, and 'flash' without it raises at run time.
      expect(g["1"].inputs.attention).toBe("sdpa");
    }
    expect(read("scripts/comfy/install-comfyui.sh")).not.toMatch(/flash[-_]attn/);
  });

  it("the GPU pre-flight doesn't read Hi3D's weights as missing: ComfyUI never lists models/Hi3D", () => {
    const index = JSON.parse(read("workflows/comfyui/requirements.json")) as { files: Record<string, { folder: string; presence: string }> };
    const hi3dFiles = Object.values(index.files).filter((f) => f.folder === "Hi3D");
    expect(hi3dFiles).toHaveLength(12);
    for (const f of hi3dFiles) expect(f.presence).toBe("unobservable");
  });

  it("binds the coarse GLB, the photo, the resolution and the steps; the pack and weights are pinned", () => {
    expect(Object.keys(wf.bindings)).toEqual(expect.arrayContaining(["image", "model3d", "meshResolution", "steps", "seed", "cpuOffload"]));
    expect(wf.customNodes.map((c) => c.name)).toEqual(["Comfyui-Hi3d-T8"]);
    const packs = JSON.parse(read("workflows/comfyui/packs.json"));
    expect(packs["Comfyui-Hi3d-T8"]).toMatchObject({ repo: "https://github.com/T8mars/Comfyui-Hi3d-T8", commit: "73848490976e6a9b0c735ce02984c03866a495e7" });
    const pins = JSON.parse(read("workflows/comfyui/model-pins.json"));
    const weights = wf.models.filter((m) => m.folder === "Hi3D" && m.file.endsWith(".safetensors"));
    expect(weights.map((m) => m.file).sort()).toEqual(["clip/model.safetensors", "dino/model.safetensors", "hi3d/transformer_1024/model.safetensors", "hi3d/transformer_512/model.safetensors", "hi3d/vae/model.safetensors"]);
    for (const m of wf.models.filter((x) => x.folder === "Hi3D")) expect(pins[m.url]?.sha256, m.file).toMatch(/^[0-9a-f]{64}$/);
    const bytes = weights.reduce((n, m) => n + pins[m.url].sizeBytes, 0);
    expect(bytes).toBe(10656051740);
    const index = JSON.parse(read("workflows/comfyui/requirements.json"));
    expect(index.workflows["mesh-refine-hi3d"].packs).toEqual({ "Comfyui-Hi3d-T8": ["Hi3DLoadMesh", "Hi3DModelLoader", "Hi3DRefine"] });
    // The install script pins the same commit and checks the weights.
    const sh = read("scripts/comfy/install-comfyui.sh");
    expect(sh).toContain('HI3D_REF="${HI3D_REF:-73848490976e6a9b0c735ce02984c03866a495e7}"');
    expect(sh).toContain("8ba88311dccf23463c6e10dd0d3bd5e0c5c35d1608c6f466413b6428b5ad8e56  hi3d/transformer_512/model.safetensors");
  });

  it("puts the uploaded GLB and the resolution into the graph, and refuses what Hi3D can't take", async () => {
    const ctx = { generationId: "g-hi3d", op: "refine-3d" as const, upload: async () => "x" };
    const { workflow } = await prepareWorkflow("mesh-refine-hi3d", { images: ["fuobe_p.png"], model3d: "fuobe_m.glb", extra: { meshResolution: 1536 }, seed: 3 }, ctx);
    expect(workflow["5"].inputs.mesh_file).toBe("fuobe_m.glb");
    expect(workflow["2"].inputs.image).toBe("fuobe_p.png");
    expect(workflow["6"].inputs).toMatchObject({ resolution: 1536, steps: 25, seed: 3 });
    await expect(prepareWorkflow("mesh-refine-hi3d", { images: ["fuobe_p.png"], model3d: "fuobe_m.glb", extra: { meshResolution: 768 } }, ctx)).rejects.toThrow(/512, 1024 or 1536/);
    await expect(prepareWorkflow("mesh-refine-hi3d", { images: ["fuobe_p.png"] }, ctx)).rejects.toThrow(/3D model to refine/);
    // The graph's own default resolution is 1024 when none is asked for.
    expect(getWorkflow("mesh-refine-hi3d").workflow["6"].inputs.resolution).toBe(1024);
  });
});

describe("the licence: information, with its notice", () => {
  it("records the Hi3D Open License as conditions, with 'Powered by Hi3D 1.0' to show", () => {
    expect(licenceInfo(wf.license)).toMatchObject({ name: "Hi3D Open License Agreement 1.0", class: "conditions", notices: ["Powered by Hi3D 1.0"] });
    expect(licenceTerms(wf.license).notices).toEqual(["Powered by Hi3D 1.0"]);
    expect(wf.license).toMatch(/200,000 monthly active users or USD 1,000,000/);
    const list = buildLicenceList(
      [{ id: "oss-hi3d-refine", name: "Hi3D 1.0", vendor: "Hi3D (Sparc3D)", kind: "model3d", routes: [{ provider: "comfyui", endpoint: "mesh-refine-hi3d" }] }],
      manifest.workflows.map((w) => ({ id: w.id, title: "", capability: "", license: w.license })),
    );
    expect(list.notices).toContainEqual({ text: "Powered by Hi3D 1.0", models: ["Hi3D 1.0"] });
    expect(list.rows.find((r) => r.id === "oss-hi3d-refine")?.notices).toEqual(["Powered by Hi3D 1.0"]);
    expect(hi3d.HI3D_NOTICE).toBe("Powered by Hi3D 1.0");
    expect(hi3d.HI3D_URL).toBe("http://hi3d.ai/");
    const pack = NODE_PACKS.find((p) => p.name === "Comfyui-Hi3d-T8")!;
    expect(pack.licence).toMatchObject({ name: "MIT", class: "conditions" });
    expect(pack.licence.note).toMatch(/Powered by Hi3D 1\.0/);
  });
});

/** A closed unit cube, glTF axes, split at one corner the way a GLB splits vertices at seams. */
function cube(open = false): { positions: number[]; indices: number[] } {
  const v = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ];
  const faces = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  const positions = v.flat();
  // A duplicate of vertex 6 (a seam): the welded check must still read the cube as closed.
  positions.push(1, 1, 1);
  const indices = (open ? faces.slice(0, 10) : faces).flat().map((i, k) => (i === 6 && k > 20 ? 8 : i));
  return { positions, indices };
}

describe("print-ready export", () => {
  it("reads a closed mesh as watertight after welding its seams, and an open one as not", () => {
    const closed = print.weld(cube());
    expect(closed.positions.length).toBe(24);
    expect(print.watertightCheck(closed)).toEqual({ watertight: true, triangles: 12, openEdges: 0, nonManifoldEdges: 0 });
    const holed = print.watertightCheck(print.weld(cube(true)));
    expect(holed.watertight).toBe(false);
    expect(holed.openEdges).toBe(4);
    expect(print.watertightLine(holed)).toMatch(/^Not watertight \(4 open edges\)/);
    expect(print.watertightLine({ watertight: true, triangles: 1, openEdges: 0, nonManifoldEdges: 0 })).toMatch(/Watertight/);
  });

  it("scales to the height asked for, Z up, standing on the bed and centred (Hi3D's output has no real size)", () => {
    // A model 2 units tall along glTF's Y, 1 wide along X and 1 deep along Z.
    const placed = print.toPrintSpace([0, -1, 0, 1, 1, 0, 0, 0, 1], 150);
    expect(placed.sizeMm.map((n) => Math.round(n * 1000) / 1000)).toEqual([75, 75, 150]);
    const b = print.bounds(placed.positions);
    expect(b.min[2]).toBeCloseTo(0);
    expect(b.max[2]).toBeCloseTo(150);
    expect((b.min[0] + b.max[0]) / 2).toBeCloseTo(0);
    expect((b.min[1] + b.max[1]) / 2).toBeCloseTo(0);
  });

  it("keeps the height between 5 mm and 2 m", () => {
    expect(print.printHeight(1)).toBe(5);
    expect(print.printHeight(5000)).toBe(2000);
    expect(print.printHeight("abc")).toBe(100);
    expect(print.printHeight("80.25")).toBe(80.3);
  });

  it("writes a binary STL: header, count and 50 bytes a triangle, in millimetres", () => {
    const out = print.printExport(cube(), { heightMm: 40, format: "stl" });
    expect(out.ext).toBe("stl");
    expect(out.data.length).toBe(84 + 12 * 50);
    const view = new DataView(out.data.buffer);
    expect(view.getUint32(80, true)).toBe(12);
    let maxZ = 0;
    for (let t = 0; t < 12; t++) for (let c = 0; c < 3; c++) maxZ = Math.max(maxZ, view.getFloat32(84 + t * 50 + 12 + c * 12 + 8, true));
    expect(maxZ).toBeCloseTo(40, 4);
    expect(out.report.watertight).toBe(true);
  });

  it("writes a 3MF: a zip with the content types, the relationship and a millimetre model", () => {
    const out = print.printExport(cube(), { heightMm: 25, format: "3mf", name: "Lamp <1>" });
    expect(out.mime).toBe("model/3mf");
    const bytes = out.data;
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("[Content_Types].xml");
    expect(text).toContain("_rels/.rels");
    expect(text).toContain('<model unit="millimeter"');
    expect(text).toContain('name="Lamp 1"');
    expect((text.match(/<triangle /g) ?? []).length).toBe(12);
    // The end-of-central-directory record lists three files.
    const end = new DataView(bytes.buffer, bytes.length - 22);
    expect(end.getUint32(0, true)).toBe(0x06054b50);
    expect(end.getUint16(10, true)).toBe(3);
    // The stored model's CRC is its own.
    const model = new TextEncoder().encode(print.threeMfModel([0, 0, 0], [], "x"));
    expect(print.crc32(model)).toBe(print.crc32(new TextEncoder().encode(print.threeMfModel([0, 0, 0], [], "x"))));
    expect(print.crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("Assist and MCP", () => {
  it("plan a refine after an open image-to-3D job (the mesh goes on in the model3d slot)", async () => {
    const tools = await import("@/server/assist/tools");
    const plan = tools.planFor(
      "generate",
      {
        summary: "A lamp in 3D, refined",
        jobs: [
          { model_id: "oss-pixal3d", prompt: "", images: ["/api/files/placeholder.png"] },
          { model_id: "oss-hi3d-refine", op: "refine-3d", prompt: "", images: ["/api/files/placeholder.png"], mesh_resolution: 1536, after: 0 },
        ],
      },
      { engine: "open" },
    );
    expect(plan.jobs.map((j) => [j.op, j.error])).toEqual([
      ["image-to-3d", undefined],
      ["refine-3d", undefined],
    ]);
  });

  it("start a refine of a given model with its resolution", async () => {
    const tools = await import("@/server/assist/tools");
    const out = await tools.executeTool(
      "generate",
      { summary: "Refine", jobs: [{ model_id: "oss-hi3d-refine", prompt: "", model3d: "/api/files/placeholder.glb", images: ["/api/files/placeholder.png"], mesh_resolution: 512 }] },
      { engine: "open" },
    );
    expect(out.isError, String(out.content)).toBeFalsy();
    const [r] = JSON.parse(out.content as string) as { started: string[] }[];
    const g = gens.getGeneration(r.started[0])!;
    expect(g.request.inputs).toEqual({ model3d: "/api/files/placeholder.glb", images: ["/api/files/placeholder.png"] });
    expect(g.request.params?.extra).toEqual({ meshResolution: 512 });
  });

  it("set the refine step on an open image-to-3D model with mesh_resolution", async () => {
    const tools = await import("@/server/assist/tools");
    const out = await tools.executeTool("generate", { summary: "Refined", jobs: [{ model_id: "oss-trellis2", prompt: "", images: ["/api/files/placeholder.png"], mesh_resolution: 1024 }] }, { engine: "open" });
    expect(out.isError, String(out.content)).toBeFalsy();
    const [r] = JSON.parse(out.content as string) as { started: string[] }[];
    expect(r.started.map((id) => gens.getGeneration(id)!.modelId).sort()).toEqual(["oss-hi3d-refine", "oss-trellis2"]);
  });

  it("a still, then an open image-to-3D job with mesh_resolution: the refine still runs, on the still", async () => {
    const tools = await import("@/server/assist/tools");
    const out = await tools.executeTool(
      "generate",
      { summary: "Lamp", jobs: [{ model_id: "oss-z-image-turbo", prompt: "A brass desk lamp" }, { model_id: "oss-pixal3d", prompt: "", mesh_resolution: 1536, after: 0 }] },
      { engine: "open" },
    );
    expect(out.isError, String(out.content)).toBeFalsy();
    const { results } = JSON.parse(out.content as string) as { results: { started: string[] }[] };
    const still = gens.getGeneration(results[0].started[0])!;
    // The job's result is the refined model; the model it refines is the step before it.
    const refined = gens.getGeneration(results[1].started[0])!;
    expect(still.modelId).toBe("oss-z-image-turbo");
    expect(refined).toMatchObject({ modelId: "oss-hi3d-refine", op: "refine-3d" });
    expect(refined.request.params?.extra).toEqual({ meshResolution: 1536 });
    expect(refined.request.chain).toEqual([{ slot: "model3d" }, { slot: "images" }]);
    const dep = (id: string) => (db().prepare("SELECT depends_on FROM generations WHERE id = ?").get(id) as { depends_on: string }).depends_on;
    const [builtId, photoId] = JSON.parse(dep(refined.id)) as string[];
    expect(photoId).toBe(still.id);
    expect(gens.getGeneration(builtId)).toMatchObject({ modelId: "oss-pixal3d", op: "image-to-3d" });
    expect(dep(builtId)).toBe(still.id);
  });
});
