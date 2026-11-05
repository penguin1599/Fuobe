import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Model3dChoice, Model3dMode } from "@/lib/av/model3d";
import { tempDir } from "./helpers/temp-dir";

/**
 * Image to 3D's modes (r4/3d-plus): the plan per mode and engine, the cloud payloads (SAM 3D's prompt is
 * always sent), the outputs the cards read, the open multi-view and splat bindings, the open text-to-3D chain
 * and Rig & animate.
 */

const dir = tempDir("fuobe-model3d-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";

const { setSetting } = await import("@/server/settings");
const gens = await import("@/server/generations");
const { db } = await import("@/server/db");
const { collectOutputs, getWorkflow, prepareWorkflow, viewSlots } = await import("@/server/providers/comfyui");
const { getModel, getPreset } = await import("@/lib/catalog");
const { estimateCost, planGeneration } = await import("@/lib/catalog/plan");
const { buildPayload, extractOutputs } = await import("@/lib/catalog/payload");
const { dropBranch } = await import("@/lib/comfy");
const m3d = await import("@/lib/av/model3d");

beforeAll(() => setSetting("demoMode", "auto"));

const plan = (req: Parameters<typeof planGeneration>[0]) => planGeneration(req, getModel, getPreset);
const photo = "/api/files/uploads/p.png";
const views = { front: "/api/files/f.png", left: "/api/files/l.png", back: "/api/files/b.png" };

describe("modes: which model and operation each runs, per engine", () => {
  const cases: [Model3dMode, "cloud" | "open", string, string][] = [
    ["image", "cloud", "hunyuan-3d-3-1-pro", "image-to-3d"],
    ["image", "open", "oss-pixal3d", "image-to-3d"],
    ["multi", "cloud", "meshy-7-1-multi", "image-to-3d"],
    ["multi", "open", "oss-trellis2-multi", "image-to-3d"],
    ["text", "cloud", "tripo-h3-1-text", "text-to-3d"],
    ["text", "open", "oss-text-trellis2", "text-to-3d"],
    ["objects", "cloud", "sam-3d-objects", "image-to-3d"],
    ["splat", "cloud", "triposplat", "splat"],
    ["splat", "open", "oss-triposplat", "splat"],
  ];
  it.each(cases)("%s on %s → %s (%s)", (mode, engine, modelId, op) => {
    const input = { engine, mode, photo, views, prompt: "a red leather armchair" };
    expect(m3d.model3dBlocker(input)).toBeNull();
    const req = m3d.model3dRequest(input);
    expect(req).toMatchObject({ feature: "image-to-3d", modelId, op });
    const p = plan(req);
    expect([p.model.id, p.op, p.model.engine]).toEqual([modelId, op, engine]);
    expect(p.jobs).toBe(1);
    expect(m3d.modeOfRequest(req)).toBe(mode);
    expect(m3d.modeOf(modelId)).toEqual({ mode, engine });
  });

  it("every model the page offers is in the catalog with its mode's operation", () => {
    const ops: Record<Model3dMode, string> = { image: "image-to-3d", multi: "image-to-3d", text: "text-to-3d", objects: "image-to-3d", splat: "splat" };
    for (const [mode, byEngine] of Object.entries(m3d.MODELS_3D) as [Model3dMode, Record<string, Model3dChoice[]>][]) {
      for (const [engine, list] of Object.entries(byEngine)) {
        for (const c of list) {
          const m = getModel(c.id);
          expect(m?.engine, c.id).toBe(engine);
          expect(m?.routes.some((r) => r.op === ops[mode]), c.id).toBe(true);
        }
      }
    }
    expect(getModel(m3d.RIG_MODEL)?.routes[0]).toMatchObject({ op: "rig-3d", provider: "fal", endpoint: "fal-ai/meshy/rigging" });
    // TripoSplat encodes with DINOv3 on fal too: its results carry the notice.
    expect(m3d.CLOUD_NOTICES.triposplat).toEqual(["Built with DINOv3"]);
    // TRELLIS.2 encodes with DINOv3 ViT-L on fal too, as on the open engine.
    expect(m3d.CLOUD_NOTICES["trellis-2"]).toEqual(["Built with DINOv3"]);
    expect(Object.keys(m3d.CLOUD_NOTICES).every((id) => getModel(id)?.engine === "cloud")).toBe(true);
  });

  it("says which way round the sides go", () => {
    expect(m3d.SIDES_HINT).toMatch(/object's own/);
    expect(m3d.SIDES_HINT).toMatch(/your right for its left/);
  });

  it("says what is missing, and that Pick an object is cloud only", () => {
    expect(m3d.model3dBlocker({ engine: "cloud", mode: "image" })).toBe("Add a photo");
    expect(m3d.model3dBlocker({ engine: "cloud", mode: "multi", views: { left: "l.png", back: "b.png" } })).toBe("Add a photo of the front");
    expect(m3d.model3dBlocker({ engine: "open", mode: "multi", views: { front: "f.png" } })).toBe("Add at least one more side");
    expect(m3d.model3dBlocker({ engine: "cloud", mode: "text", prompt: "  " })).toBe("Describe the object");
    expect(m3d.model3dBlocker({ engine: "cloud", mode: "objects", photo })).toBe("Name the object to take out");
    expect(m3d.model3dBlocker({ engine: "open", mode: "objects", photo, prompt: "lamp" })).toMatch(/cloud model/);
    expect(() => m3d.model3dRequest({ engine: "open", mode: "objects", photo, prompt: "lamp" })).toThrow(/cloud model/);
    // An unknown pick falls back to the mode's default.
    expect(m3d.model3dRequest({ engine: "open", mode: "splat", photo, modelId: "triposplat" }).modelId).toBe("oss-triposplat");
  });

  it("sends several photos in side order; the open graph also gets their sides by name", () => {
    const sides = { front: "f.png", back: "b.png", right: "r.png" };
    expect(m3d.model3dRequest({ engine: "cloud", mode: "multi", views: sides })).toEqual({ feature: "image-to-3d", modelId: "meshy-7-1-multi", op: "image-to-3d", inputs: { images: ["f.png", "b.png", "r.png"] } });
    expect(m3d.model3dRequest({ engine: "open", mode: "multi", views: sides }).params).toEqual({ extra: { views: ["front", "back", "right"] } });
    // Meshy multi-view and the open graph need two photos.
    expect(() => plan({ feature: "x", modelId: "meshy-7-1-multi", op: "image-to-3d", inputs: { images: ["f.png"] } })).toThrow();
    expect(() => plan({ feature: "x", modelId: "oss-trellis2-multi", op: "image-to-3d", inputs: { images: ["f.png"] } })).toThrow();
  });

  it("refuses SAM 3D Objects without words and a text model without a description", () => {
    expect(() => plan({ feature: "x", modelId: "sam-3d-objects", op: "image-to-3d", prompt: "", inputs: { images: [photo] } })).toThrow(/Name the objects/);
    expect(() => plan({ feature: "x", modelId: "tripo-h3-1-text", op: "text-to-3d", prompt: "" })).toThrow();
  });
});

describe("cloud payloads", () => {
  const route = (id: string) => getModel(id)!.routes[0];

  it("SAM 3D Objects: the words always go (the API reads “car” without them), with a textured GLB", () => {
    const req = m3d.model3dRequest({ engine: "cloud", mode: "objects", photo, prompt: "  the green lamp " });
    expect(req.prompt).toBe("the green lamp");
    const p = plan(req);
    const body = buildPayload(route("sam-3d-objects").map!, { prompt: p.prompt, images: ["https://fal.test/p.png"], seed: 4 });
    expect(body).toEqual({ prompt: "the green lamp", image_url: "https://fal.test/p.png", seed: 4, export_textured_glb: true });
  });

  it("Meshy multi-view: the photos as image_urls; Tripo text: the words as the prompt", () => {
    expect(buildPayload(route("meshy-7-1-multi").map!, { prompt: "", images: ["a.png", "b.png"] })).toMatchObject({ image_urls: ["a.png", "b.png"] });
    expect(buildPayload(route("tripo-h3-1-text").map!, { prompt: "a brass lantern", seed: 9 })).toMatchObject({ prompt: "a brass lantern", model_seed: 9 });
  });

  it("TripoSplat: a .ply splat of the photo, with the number of Gaussians picked", () => {
    const body = buildPayload(route("triposplat").map!, { prompt: "", images: ["https://fal.test/p.png"], extra: { num_gaussians: 131072 } });
    expect(body).toEqual({ image_url: "https://fal.test/p.png", output_format: "ply", num_gaussians: 131072 });
  });

  it("Meshy rigging: the model's URL, and a preset turns animation on; it costs $0.12 more", () => {
    const rig = getModel(m3d.RIG_MODEL)!;
    const animated = m3d.rigRequest({ glb: "/api/files/m.glb", animation: 30 });
    expect(animated).toEqual({ feature: "image-to-3d", modelId: "meshy-rigging", op: "rig-3d", inputs: { model3d: "/api/files/m.glb" }, params: { animation: 30 } });
    expect(plan(animated).op).toBe("rig-3d");
    expect(buildPayload(rig.routes[0].map!, { prompt: "", model3d: "https://fal.test/m.glb", animation: 30 })).toEqual({ model_url: "https://fal.test/m.glb", animation_action_id: 30, enable_animation: true });
    expect(buildPayload(rig.routes[0].map!, { prompt: "", model3d: "https://fal.test/m.glb" })).toEqual({ model_url: "https://fal.test/m.glb" });
    expect(estimateCost(rig, {}, 1, "rig-3d")).toBe(0.2);
    expect(estimateCost(rig, { animation: 30 }, 1, "rig-3d")).toBe(0.32);
    // Only Meshy's preset numbers go.
    expect(m3d.rigRequest({ glb: "m.glb", animation: 697 }).params).toBeUndefined();
    expect(m3d.animationId("92")).toBe(92);
    expect(m3d.animationId("9.5")).toBeNull();
    expect(m3d.animationName(30)).toBe("Casual walk");
    expect(m3d.animationName(92)).toBe("Preset 92");
    expect(() => plan({ feature: "x", modelId: "meshy-rigging", op: "rig-3d" })).toThrow(/3D model to rig/);
  });
});

describe("what the cards show", () => {
  const view = (outputs: ReturnType<typeof extractOutputs>, request = m3d.model3dRequest({ engine: "cloud", mode: "splat", photo })) =>
    m3d.model3dView({ outputs: outputs.map((o) => ({ ...o, meta: o.meta ?? {} })) as never, request });

  it("a cloud splat is a download with the cut-out as its poster, not a GLB for the viewer", () => {
    const outs = extractOutputs({ model_mesh: { url: "https://fal.test/x/splat.ply" }, preprocessed_image: { url: "https://fal.test/x/seen.png" } }, "splat");
    expect(view(outs)).toMatchObject({ glb: undefined, splat: { url: "https://fal.test/x/splat.ply", format: "ply" }, poster: "https://fal.test/x/seen.png" });
  });

  it("an open splat (.spz) brings its orbit video", () => {
    const v = m3d.model3dView({
      outputs: [
        { url: "/api/files/g/s.spz", kind: "model3d", meta: { role: "splat", format: "spz" } },
        { url: "/api/files/g/orbit.mp4", kind: "video", meta: { role: "turntable" } },
      ] as never,
      request: m3d.model3dRequest({ engine: "open", mode: "splat", photo }),
    });
    expect(v).toMatchObject({ splat: { url: "/api/files/g/s.spz", format: "spz" }, turntable: "/api/files/g/orbit.mp4", glb: undefined });
    // The demo's splat is a GLB the viewer shows.
    expect(m3d.model3dView({ outputs: [{ url: "sample:demo-model.glb", kind: "model3d", meta: { splat: true, format: "glb" } }] as never, request: { feature: "x", modelId: "y", op: "splat" } as never })).toMatchObject({ glb: "sample:demo-model.glb", splat: undefined });
  });

  it("tells a splat from a GLB by its format or extension (the Library's viewer goes by it too)", () => {
    expect(m3d.splatFormatOf({ url: "/api/files/outputs/a.spz" })).toBe("spz");
    expect(m3d.splatFormatOf({ url: "https://fal.test/x.ply?sig=1" })).toBe("ply");
    expect(m3d.splatFormatOf({ url: "/api/files/outputs/a.bin", meta: { format: "KSPLAT" } })).toBe("ksplat");
    expect(m3d.splatFormatOf({ url: "/api/files/outputs/a.glb" })).toBeUndefined();
    expect(m3d.splatFormatOf({ url: "sample:demo-model.glb", meta: { format: "glb", splat: true } })).toBeUndefined();
    expect(m3d.splatFormatOf(undefined)).toBeUndefined();
  });

  it("a model made from words links to the still it was built from, once the step ran", () => {
    const step = { feature: "image-to-3d", modelId: "oss-trellis2", op: "image-to-3d" as const, prompt: "a lantern", chain: [{ slot: "images" as const, position: "first" as const }] };
    expect(m3d.stillOf({ request: { ...step, inputs: { images: ["/api/files/still.png"] }, chainFilled: true } })).toBe("/api/files/still.png");
    expect(m3d.stillOf({ request: step })).toBeUndefined();
    expect(m3d.stillOf({ request: m3d.model3dRequest({ engine: "open", mode: "image", photo }) })).toBeUndefined();
  });

  it("SAM 3D Objects: the GLB in the viewer, its splat as a download", () => {
    const outs = extractOutputs({ model_glb: { url: "https://fal.test/o.glb" }, gaussian_splat: { url: "https://fal.test/o.ply" } }, "image-to-3d");
    expect(view(outs, m3d.model3dRequest({ engine: "cloud", mode: "objects", photo, prompt: "lamp" }))).toMatchObject({ glb: "https://fal.test/o.glb", formats: { splat: "https://fal.test/o.ply" } });
  });

  it("a rig plays the animated GLB, with the rigged one and the walk and run cycles to download", () => {
    const outs = extractOutputs(
      {
        rigged_character_glb: { url: "https://fal.test/rig.glb" },
        animation_glb: { url: "https://fal.test/anim.glb" },
        animation_fbx: { url: "https://fal.test/anim.fbx" },
        basic_animations: { walking_glb: { url: "https://fal.test/walk.glb" }, running_glb: { url: "https://fal.test/run.glb" } },
      },
      "rig-3d",
    );
    expect(view(outs, m3d.rigRequest({ glb: "/api/files/m.glb", animation: 22 }))).toMatchObject({
      glb: "https://fal.test/anim.glb",
      rigged: true,
      animated: true,
      formats: { fbx: "https://fal.test/anim.fbx", rigged: "https://fal.test/rig.glb", walking: "https://fal.test/walk.glb", running: "https://fal.test/run.glb" },
    });
  });
});

describe("the extra files are kept", () => {
  it("a rig's walk and run cycles and FBX, SAM 3D's splat and the preview become files of the generation", async () => {
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      if (req.url === "/gone.glb") return void res.writeHead(404).end();
      res.setHeader("content-type", "application/octet-stream");
      res.end(Buffer.from(`file ${req.url}`));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const at = (p: string) => `http://127.0.0.1:${(server.address() as { port: number }).port}${p}`;
    process.env.FUOBE_ALLOW_PRIVATE_URLS = "1";
    try {
      const outs = extractOutputs(
        {
          rigged_character_glb: { url: at("/rig.glb") },
          animation_glb: { url: at("/anim.glb") },
          animation_fbx: { url: at("/anim.fbx") },
          basic_animations: { walking_glb: { url: at("/walk.glb") }, running_glb: { url: at("/gone.glb") } },
        },
        "rig-3d",
      );
      const kept = await gens.persistArtifacts(outs[0].meta, "genrig", outs[0].url);
      const formats = kept?.formats as Record<string, string>;
      expect(formats.walking).toMatch(/^\/api\/files\/outputs\/.+\.glb$/);
      expect(formats.rigged).toMatch(/^\/api\/files\/outputs\/.+\.glb$/);
      expect(formats.fbx).toMatch(/^\/api\/files\/outputs\/.+\.fbx$/);
      // Gone at the provider: the link stays.
      expect(formats.running).toBe(at("/gone.glb"));
      expect(kept).toMatchObject({ rigged: true, animated: true });
      const file = path.join(dir, "files", decodeURIComponent(formats.walking.slice("/api/files/".length)));
      expect(fs.readFileSync(file, "utf8")).toBe("file /walk.glb");

      const sam = extractOutputs({ model_glb: { url: at("/o.glb") }, gaussian_splat: { url: at("/o.ply") }, thumbnail: { url: at("/o.png") } }, "image-to-3d");
      const samKept = await gens.persistArtifacts(sam[0].meta, "gensam", sam[0].url);
      expect((samKept?.formats as Record<string, string>).splat).toMatch(/^\/api\/files\/outputs\/.+\.ply$/);
      expect(samKept?.preview).toMatch(/^\/api\/files\/outputs\//);
      // A format that is the main file itself is left to persistOutput (it isn't fetched twice).
      const same = await gens.persistArtifacts({ formats: { glb: at("/o.glb"), obj: at("/o.obj") } }, "gensame", at("/o.glb"));
      expect(same?.formats).toMatchObject({ glb: at("/o.glb"), obj: expect.stringMatching(/^\/api\/files\//) });
    } finally {
      delete process.env.FUOBE_ALLOW_PRIVATE_URLS;
      server.close();
    }
  });
});

describe("open engine: multi-view TRELLIS.2 (image-to-3d-trellis2-multiview)", () => {
  const manifest = getWorkflow("image-to-3d-trellis2-multiview").manifest;
  const prep = (images: string[], extra?: Record<string, unknown>) =>
    prepareWorkflow("image-to-3d-trellis2-multiview", { prompt: "", images, extra }, { generationId: "gen-mv", op: "image-to-3d", upload: async (_d, _t, n) => `up_${n}` });

  it("is a validated workflow with a licence that asks for the DINOv3 notice", () => {
    expect(manifest).toMatchObject({ capability: "image-to-3d", validated: true });
    expect(manifest.license).toMatch(/Built with DINOv3/);
    expect(manifest.outputs).toEqual([{ node: "372", kind: "model3d" }, { node: "702", kind: "video", role: "turntable" }]);
  });

  it("puts each photo on its side and leaves the missing side out of the graph", async () => {
    const { workflow } = await prep(["f.png", "b.png"], { views: ["front", "back"] });
    expect(workflow["360"].inputs.image).toBe("f.png");
    expect(workflow["362"].inputs.image).toBe("b.png");
    // Left and right: their loaders, cut-outs and crops are gone, and the rig doesn't read them.
    for (const id of ["361", "363", "348", "349", "352", "353"]) expect(workflow[id], id).toBeUndefined();
    expect(Object.keys(workflow["324"].inputs).sort()).toEqual(["back", "clip_vision_model", "fov", "front"]);
    expect(workflow["324"].inputs.front).toEqual(["312", 0]);
    // The shared cut-out model and the outputs stay.
    expect(workflow["193"]).toBeDefined();
    expect(workflow["372"].inputs.filename_prefix).toBe("fuobe/gen-mv");
    expect(workflow["702"].inputs.filename_prefix).toBe("fuobe/gen-mv");
  });

  it("measures the photos' field of view on the front crop (MoGe), unless one is given", async () => {
    const { workflow } = await prep(["f.png", "b.png"], { views: ["front", "back"] });
    // Pixal3D reads the views' horizontal FOV from MoGe 2 run on the front's cut-out crop, not the rig's fixed 20°.
    expect(workflow["324"].inputs.fov).toEqual(["382", 0]);
    expect(workflow["382"]).toMatchObject({ class_type: "MoGeGeometryToFOV", inputs: { moge_geometry: ["381", 0], axis: "horizontal", unit: "degrees" } });
    expect(workflow["381"]).toMatchObject({ class_type: "MoGeInference", inputs: { image: ["312", 0], fov_x_degrees: 0 } });
    expect(manifest.models.map((m) => m.file)).toContain("moge_2_vitl_normal_fp16.safetensors");
    // A rendered turnaround sheet: fovX fixes MoGe's lens, which the FOV node passes on.
    const sheet = await prep(["f.png", "l.png"], { views: ["front", "left"], fovX: 20 });
    expect(sheet.workflow["381"].inputs.fov_x_degrees).toBe(20);
    expect(sheet.workflow["324"].inputs.fov).toEqual(["382", 0]);
  });

  it("takes the photos in side order when they aren't named, and all four sides", async () => {
    const { workflow } = await prep(["f.png", "l.png", "b.png", "r.png"]);
    expect(["360", "361", "362", "363"].map((id) => workflow[id].inputs.image)).toEqual(["f.png", "l.png", "b.png", "r.png"]);
    expect(Object.keys(workflow["324"].inputs).sort()).toEqual(["back", "clip_vision_model", "fov", "front", "left", "right"]);
  });

  it("needs the front, and one photo per named side", async () => {
    await expect(prep(["l.png", "b.png"], { views: ["left", "back"] })).rejects.toThrow("Add a photo of the front");
    await expect(prep(["f.png", "b.png"], { views: ["front"] })).rejects.toThrow(/2 photos but 1 side/);
    await expect(prep(["f.png", "x.png"], { views: ["front", "top"] })).rejects.toThrow(/front, left, back, right/);
    await expect(prep(["f.png", "x.png"], { views: ["front", "front"] })).rejects.toThrow(/Two photos of the front/);
    expect(viewSlots({ sides: ["front", "left"], into: "X" }, ["a", "b"], undefined)).toEqual({ image: "a", image2: "b" });
  });

  it("dropBranch refuses a branch that doesn't end in the named node", () => {
    const wf = { "1": { class_type: "LoadImage", inputs: { image: "a.png" } }, "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } } };
    expect(dropBranch(wf, "1", "Pixal3DMultiViewConditioning")).toBeNull();
    expect(dropBranch(wf, "9", "Pixal3DMultiViewConditioning")).toBeNull();
  });
});

describe("open engine: TripoSplat (image-to-splat-triposplat)", () => {
  it("binds the photo, the Gaussians picked and the defaults (cut-out on, .spz)", async () => {
    const m = getModel("oss-triposplat")!;
    expect(m.routes).toEqual([expect.objectContaining({ op: "splat", provider: "comfyui", endpoint: "image-to-splat-triposplat" })]);
    const { workflow } = await prepareWorkflow("image-to-splat-triposplat", { prompt: "", images: ["p.png"], extra: { numGaussians: 131072 } }, { generationId: "gen-sp", op: "splat", upload: async () => "x" });
    expect(workflow["99"].inputs.image).toBe("p.png");
    expect(workflow["88:55"].inputs.num_gaussians).toBe(131072);
    expect(workflow["88:35"].inputs.switch).toBe(true);
    expect(workflow["92"].inputs.format).toBe("spz");
  });

  it("names the splat's format and type, and keeps the orbit video as the turntable", () => {
    const file = (filename: string) => ({ filename, subfolder: "fuobe", type: "output" });
    const outs = collectOutputs(
      { status: { status_str: "success", completed: true }, outputs: { "51": { "3d": [file("gen-sp_00001_.spz")] }, "42": { images: [file("gen-sp_00001_.mp4")], animated: [true] } } },
      getWorkflow("image-to-splat-triposplat").manifest,
    );
    expect(outs.map((o) => [o.kind, o.contentType, o.meta])).toEqual([
      ["model3d", "model/x-spz", { role: "splat", format: "spz" }],
      ["video", undefined, { role: "turntable" }],
    ]);
  });
});

describe("Idol 3D (image-to-splat-idol on the open engine, speridlabs/idol on fal)", () => {
  const file = (filename: string) => ({ filename, subfolder: "fuobe", type: "output" });

  it("takes an upload for a photo and a result made here for a render; a repeat or an upload's second report keeps the switch", () => {
    // Dropped or uploaded here: on, as soon as it starts uploading.
    expect(m3d.idolPhotoFor({ ref: "", uploading: true }, null)).toBe(true);
    // The same upload's second report (done) keeps what the person may have set meanwhile.
    expect(m3d.idolPhotoFor({ ref: "/api/files/a.png" }, { ref: "", uploading: true })).toBeUndefined();
    // From the library: an earlier upload is a photo; a result made here is not.
    expect(m3d.idolPhotoFor({ ref: "/api/files/up.jpg", source: "upload" }, { ref: "/api/files/a.png" })).toBe(true);
    expect(m3d.idolPhotoFor({ ref: "/api/files/gen.png", source: "generation" }, null)).toBe(false);
    expect(m3d.idolPhotoFor({ ref: "/api/files/x.png" }, null)).toBe(false);
    // The same picture again, or a cleared slot: unchanged.
    expect(m3d.idolPhotoFor({ ref: "/api/files/a.png", source: "upload" }, { ref: "/api/files/a.png" })).toBeUndefined();
    expect(m3d.idolPhotoFor(null, { ref: "/api/files/a.png" })).toBeUndefined();
  });

  it("routes oss-idol to its graph and idol-3d to fal; TripoSplat stays first on both engines", () => {
    expect(getModel("oss-idol")!.routes).toEqual([expect.objectContaining({ op: "splat", provider: "comfyui", endpoint: "image-to-splat-idol" })]);
    expect(getModel("idol-3d")!.routes).toEqual([expect.objectContaining({ op: "splat", provider: "fal", endpoint: "speridlabs/idol" })]);
    expect(m3d.MODELS_3D.splat.open.map((m) => m.id)).toEqual(["oss-triposplat", "oss-idol"]);
    expect(m3d.MODELS_3D.splat.cloud.map((m) => m.id)).toEqual(["triposplat", "idol-3d"]);
    expect(m3d.modeOf("oss-idol")).toEqual({ mode: "splat", engine: "open" });
    expect(m3d.modeOf("idol-3d")).toEqual({ mode: "splat", engine: "cloud" });
    expect(m3d.ALL_MODELS_3D.some((m) => m.id === "oss-idol")).toBe(true);
    // Idol encodes with DINOv3 on fal too; cloud TripoSplat is never labelled Idol.
    expect(m3d.CLOUD_NOTICES["idol-3d"]).toEqual(["Built with DINOv3"]);
    expect(getModel("triposplat")!.name).toBe("TripoSplat");
    expect(plan(m3d.model3dRequest({ engine: "cloud", mode: "splat", photo, modelId: "idol-3d" })).model.id).toBe("idol-3d");
  });

  it("sends Best by default and Quick look when asked; TripoSplat's requests are unchanged", () => {
    const open = (more: Partial<Parameters<typeof m3d.model3dRequest>[0]>) => m3d.model3dRequest({ engine: "open", mode: "splat", photo, modelId: "oss-idol", ...more });
    expect(open({}).params).toEqual({ extra: { steps: 50, sampler: "euler", cfg: 4, numGaussians: 262144, photoCrop: false } });
    expect(open({ quality: "quick", photoCrop: true }).params).toEqual({ extra: { steps: 20, sampler: "dpmpp_2m", cfg: 4, numGaussians: 65536, photoCrop: true } });
    expect(m3d.IDOL_PRESETS).toEqual({ best: { steps: 50, sampler: "euler", cfg: 4, numGaussians: 262144 }, quick: { steps: 20, sampler: "dpmpp_2m", cfg: 4, numGaussians: 65536 } });
    // fal takes the steps, the Gaussians and the kind of picture; its guidance stays its own (Idol's weight 3).
    expect(m3d.model3dRequest({ engine: "cloud", mode: "splat", photo, modelId: "idol-3d", quality: "quick", photoCrop: true }).params).toEqual({
      extra: { num_inference_steps: 20, num_gaussians: 65536, image_type: "real" },
    });
    // The Idol settings never reach TripoSplat.
    expect(m3d.model3dRequest({ engine: "open", mode: "splat", photo, quality: "quick", photoCrop: true })).toEqual({ feature: "image-to-3d", modelId: "oss-triposplat", op: "splat", inputs: { images: [photo] } });
    expect(m3d.model3dRequest({ engine: "cloud", mode: "splat", photo, quality: "quick" })).toEqual({ feature: "image-to-3d", modelId: "triposplat", op: "splat", inputs: { images: [photo] } });
  });

  it("binds the photo, the Gaussians, steps / cfg / sampler, the seed on both nodes and the photo crop; cut-out on, .spz", async () => {
    const extra = m3d.model3dRequest({ engine: "open", mode: "splat", photo, modelId: "oss-idol", quality: "quick", photoCrop: true }).params!.extra!;
    const { workflow } = await prepareWorkflow("image-to-splat-idol", { prompt: "", images: ["p.png"], seed: 7, extra }, { generationId: "gen-idol", op: "splat", upload: async () => "x" });
    expect(workflow["99"].inputs.image).toBe("p.png");
    expect(workflow["88:55"].inputs).toMatchObject({ num_gaussians: 65536, seed: 7 });
    expect(workflow["88:6"].inputs).toMatchObject({ steps: 20, cfg: 4, sampler_name: "dpmpp_2m", seed: 7 });
    expect(workflow["88:104"].inputs.switch).toBe(true);
    expect(workflow["88:35"].inputs.switch).toBe(true);
    expect(workflow["92"].inputs.format).toBe("spz");
    const best = await prepareWorkflow("image-to-splat-idol", { prompt: "", images: ["p.png"] }, { generationId: "gen-idol2", op: "splat", upload: async () => "x" });
    expect(best.workflow["88:6"].inputs).toMatchObject({ steps: 50, cfg: 4, sampler_name: "euler" });
    expect(best.workflow["88:104"].inputs.switch).toBe(false);
  });

  it("gives the .spz as the splat and the orbit as the turntable; a chain into a video slot takes the orbit", () => {
    const outs = collectOutputs(
      { status: { status_str: "success", completed: true }, outputs: { "51": { "3d": [file("gen-idol_00001_.spz")] }, "42": { images: [file("gen-idol_00001_.mp4")], animated: [true] } } },
      getWorkflow("image-to-splat-idol").manifest,
    );
    expect(outs.map((o) => [o.kind, o.contentType, o.meta])).toEqual([
      // idol-2: the core graph's splat says it wasn't pruned (the clean graph needs the ComfyUI-Idol pack).
      ["model3d", "model/x-spz", { role: "splat", format: "spz", pruned: false }],
      ["video", undefined, { role: "turntable" }],
    ]);
    expect(gens.pickOutput(outs as never, { slot: "video" } as never)?.kind).toBe("video");
  });

  it("fal: the .ply splat with the cut-out as its preview and the point-cloud GLB as a download", () => {
    const route = getModel("idol-3d")!.routes[0];
    expect(buildPayload(route.map!, { prompt: "", images: ["https://fal.test/p.png"], seed: 3, extra: { num_inference_steps: 20, num_gaussians: 65536, image_type: "real" } })).toEqual({
      image_url: "https://fal.test/p.png",
      seed: 3,
      num_inference_steps: 20,
      num_gaussians: 65536,
      image_type: "real",
    });
    const outs = extractOutputs(
      {
        model_mesh: { url: "https://fal.media/s.ply", content_type: "application/octet-stream" },
        model_glb: { url: "https://fal.media/p.glb" },
        preprocessed_image: { url: "https://fal.media/cut.png" },
        camera: { yaw: 0.1, pitch: 0.2, radius: 2, fov: 40 },
        num_gaussians: 65536,
        seed: 3,
        timings: {},
      },
      "splat",
    );
    expect(outs).toEqual([{ url: "https://fal.media/s.ply", kind: "model3d", contentType: "model/ply", meta: { format: "ply", preview: "https://fal.media/cut.png", formats: { points: "https://fal.media/p.glb" } } }]);
    expect(estimateCost(getModel("idol-3d")!, {}, 1, "splat")).toBe(0.1);
  });
});

describe("open engine: text to 3D as a Qwen-Image 2.1 still, then TRELLIS.2", () => {
  async function settle(id: string, ms = 40_000) {
    const until = Date.now() + ms;
    for (;;) {
      const g = gens.getGeneration(id)!;
      if (["succeeded", "failed", "canceled"].includes(g.status)) return g;
      if (Date.now() > until) throw new Error(`timed out: ${g.status} ${g.message}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  it("is free and runs as two steps: the still (a helper step) and the model made from it", async () => {
    const req = m3d.model3dRequest({ engine: "open", mode: "text", prompt: "A brass lantern." });
    expect(gens.previewGeneration(req)).toMatchObject({ op: "text-to-3d", costUsd: 0 });
    const [built, still] = gens.createGenerations(req);
    expect(still).toMatchObject({ feature: "image-to-3d-step", modelId: "oss-qwen-image-21", op: "t2i" });
    expect(still.request.params).toMatchObject({ aspectRatio: "1:1", resolution: "1K" });
    expect(still.prompt).toMatch(/^A brass lantern\. The object alone, whole and centred/);
    expect(built).toMatchObject({ feature: "image-to-3d", modelId: "oss-trellis2", op: "image-to-3d", status: "queued" });
    expect(built.batchId).toBe(still.batchId);
    const dep = (db().prepare("SELECT depends_on FROM generations WHERE id = ?").get(built.id) as { depends_on: string }).depends_on;
    expect(dep).toBe(still.id);
    const done = await settle(built.id);
    expect(done.status).toBe("succeeded");
    expect(done.outputs.some((o) => o.kind === "model3d")).toBe(true);
    expect(done.request.inputs?.images?.length).toBe(1);
    // Its card links to the still.
    expect(m3d.stillOf(done)).toBe(done.request.inputs?.images?.[0]);
  }, 60_000);

  it("runs as the same two steps when the request leaves op out (Assist, MCP, the API)", () => {
    const steps = gens.createGenerations({ feature: "image-to-3d", modelId: "oss-text-trellis2", prompt: "a brass lantern" });
    expect(steps.map((g) => [g.modelId, g.op])).toEqual([
      ["oss-trellis2", "image-to-3d"],
      ["oss-qwen-image-21", "t2i"],
    ]);
    // A photo sent along has no place in this route: the model is built from the still alone.
    const [built] = gens.createGenerations({ feature: "image-to-3d", modelId: "oss-text-trellis2", prompt: "a brass lantern", inputs: { images: ["/api/files/p.png"] } });
    expect(built.request.inputs?.images).toBeUndefined();
    expect(built.request.chain).toEqual([{ slot: "images", position: "first" }]);
  });

  it("can't wait for another step's words, and says so in 3D terms", () => {
    expect(() => gens.createGenerations({ feature: "image-to-3d", modelId: "oss-text-trellis2", op: "text-to-3d", prompt: "{text}", chain: [{ slot: "prompt" }] }, { dependsOn: "x" })).toThrow(
      /draws the object first, then builds it in 3D/,
    );
  });

  it("needs the words", () => {
    expect(() => gens.createGenerations({ feature: "image-to-3d", modelId: "oss-text-trellis2", op: "text-to-3d", prompt: " " })).toThrow();
  });

  it("writes the still prompt for a clean cut-out", () => {
    expect(m3d.stillPromptFor3d("  a ceramic teapot...  ")).toBe(
      "a ceramic teapot. The object alone, whole and centred, seen from the front at eye level, on a plain light grey background, soft even studio light",
    );
  });
});
