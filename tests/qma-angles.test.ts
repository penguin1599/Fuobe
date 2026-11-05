import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GenInput, Operation } from "@/lib/catalog/types";
import type { ComfyWorkflow, ManifestWorkflow } from "@/lib/comfy";
import { tempDir } from "./helpers/temp-dir";

// The QMA camera-angles LoRA on Qwen-Image 2.1 (96 views) in the Angles app, Cinema's location views and
// 3D re-shoots, the turnaround's missing sides and its 8-view still set, and the Canvas product angles. Open engine only:
// fal's Qwen-Image 2.1 takes no LoRAs and Replicate has none.
const tmp = tempDir("fuobe-qma-");
process.env.FUOBE_DATA_DIR = tmp;
process.env.COMFYUI_URL = "http://comfy.test:8188";
const { prepareWorkflow } = await import("@/server/providers/comfyui");
const { getModel, getPreset } = await import("@/lib/catalog");
const { planGeneration } = await import("@/lib/catalog/plan");
const { appModels } = await import("@/lib/catalog/preset-recipe-routes");
const { libraryEntry } = await import("@/lib/catalog/loras");
const { planCinema, RECOMPOSE_MODELS } = await import("@/lib/catalog/cinema");
const { planTurnaround, qmaHorizontal, ROUTES_ON, TURN_ROUTES, anglesHorizontal } = await import("@/lib/catalog/turnaround");
const { CANVAS_TEMPLATES, convertEngine } = await import("@/lib/catalog/canvas");
const { QMA_MODEL, QMA_WORKFLOW, parseQmaPrompt } = await import("@/lib/qma");
const { STUDIO_ROWS, studioTool } = await import("@/server/gpu/tools");
const { modelLicence } = await import("@/server/model-access");
const { TurnaroundSchema } = await import("@/server/turnaround");

const LIBRARY = path.join(process.cwd(), "workflows/comfyui");
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(LIBRARY, f), "utf8"));
const manifest = read("manifest.json") as { workflows: ManifestWorkflow[] };
const entry = (id: string) => manifest.workflows.find((w) => w.id === id)!;
const pins = read("model-pins.json") as Record<string, { revision: string; sizeBytes: number; sha256: string }>;
const index = read("requirements.json") as { workflows: Record<string, { files: string[]; packs: Record<string, string[]>; vramGb: number }> };
const ofClass = (wf: ComfyWorkflow, cls: string) => Object.entries(wf).filter(([, n]) => n.class_type === cls);
const has = (id: string) => !!getModel(id);

async function prepare(input: GenInput, op: Operation = "edit") {
  return prepareWorkflow(QMA_WORKFLOW, { seed: 7, ...input }, {
    generationId: "g-qma",
    op,
    upload: async (_d, _t, name) => `up_${name}`,
    media: () => undefined as never,
    serverRam: async () => undefined,
    modelPath: async () => undefined,
  });
}

describe("the QMA model and its graph", () => {
  it("is an open edit model with the camera as three settings, its LoRA held to its switch", () => {
    const m = getModel(QMA_MODEL)!;
    expect(m).toMatchObject({ engine: "open", kind: "image", name: "QMA · 96 views" });
    expect(m.routes.map((r) => [r.provider, r.op, r.endpoint])).toEqual([["comfyui", "edit", QMA_WORKFLOW]]);
    expect(m.options.promptFormat).toBe("qma");
    expect(m.options.controls?.map((c) => c.param)).toEqual(["horizontal_angle", "vertical_angle", "zoom", "size", "decoder"]);
    expect(m.options.controls?.[0].values).toEqual([0, 45, 90, 135, 180, 225, 270, 315]);
    expect(m.options.loras?.map((l) => [l.file, l.strength])).toEqual([["qwen-image-2.1-qma-camera-angles.safetensors", 1]]);
    expect(m.tagline).toMatch(/on your GPU/);
  });

  it("records the LoRA pinned, with its licence, and the graph validated with the card's settings", () => {
    const e = libraryEntry({ file: "qwen-image-2.1-qma-camera-angles.safetensors" })!;
    expect(e.url).toContain("/resolve/13007eec2648c09529e930164c2ccc9c8c12428c/");
    expect(e.sha256).toBe("ad2c20e0e103b6ad3ffffc56ab4e89c0822263c488aa4dd70e7e03091ff37b8d");
    expect(e.licence).toMatchObject({ commercial: false, hostedOk: false });
    const w = entry(QMA_WORKFLOW);
    expect(w.validated).toBe(true);
    expect(w.defaults).toMatchObject({ steps: 30, cfg: 3, loraStrength: 1, megapixels: 1 });
    expect(w.vramGb).toBe(20);
    expect(w.notes).not.toMatch(/src\//);
    const lora = w.models.find((x) => x.folder === "loras")!;
    expect(lora.sizeGb).toBe(0.32);
    expect(pins[lora.url!]).toMatchObject({ revision: "13007eec2648c09529e930164c2ccc9c8c12428c", sizeBytes: 318820224 });
    expect(index.workflows[QMA_WORKFLOW].files).toEqual(expect.arrayContaining(["loras/qwen-image-2.1-qma-camera-angles.safetensors", "diffusion_models/qwen_image_2.1_int8_convrot.safetensors"]));
    expect(index.workflows[QMA_WORKFLOW].packs).toEqual({});
    expect(modelLicence(getModel(QMA_MODEL)!).licence.name).toMatch(/Qwen Research/);
  });

  it("writes the camera words from the run's settings and binds the card's sampler", async () => {
    const m = getModel(QMA_MODEL)!;
    const plan = planGeneration({ feature: "edit", modelId: m.id, prompt: "make it dusk", inputs: { images: ["/api/files/p.png"] }, params: { extra: { horizontal_angle: 180, vertical_angle: 60, zoom: 0 } } }, getModel, getPreset);
    expect(plan.prompt).toBe("<qma> back view high-angle shot wide shot make it dusk");
    // No words and no settings: a quarter turn at eye level.
    expect(planGeneration({ feature: "edit", modelId: m.id, prompt: "", inputs: { images: ["/api/files/p.png"] } }, getModel, getPreset).prompt).toBe("<qma> front-right quarter view eye-level shot medium shot");
    const { workflow: wf } = await prepare({ prompt: plan.prompt, images: ["/api/files/p.png"], loras: plan.loras });
    expect(wf["30"].inputs.prompt).toBe(plan.prompt);
    expect(wf["32"].inputs).toMatchObject({ steps: 30, cfg: 3, sampler_name: "euler", scheduler: "simple" });
    expect(wf["20"].inputs.megapixels).toBe(1);
    // The graph loads the LoRA itself: the plan's copy isn't added twice.
    expect(ofClass(wf, "LoraLoaderModelOnly").map(([, n]) => [n.inputs.lora_name, n.inputs.strength_model])).toEqual([["qwen-image-2.1-qma-camera-angles.safetensors", 1]]);
    const preview = planGeneration({ feature: "edit", modelId: m.id, prompt: "", inputs: { images: ["/api/files/p.png"] }, params: { extra: { size: "preview" } } }, getModel, getPreset);
    const { workflow: small } = await prepare({ prompt: preview.prompt, images: ["/api/files/p.png"], extra: preview.params.extra });
    expect(small["20"].inputs.megapixels).toBe(0.6);
  });
});

describe("the Angles app", () => {
  const app = getPreset("app-angles")!;

  it("offers QMA · 96 views on your GPU only, after its own routes", () => {
    expect(appModels(app, "open", has)).toContain(QMA_MODEL);
    expect(appModels(app, "open", has).at(-1)).toBe(QMA_MODEL);
    expect(appModels(app, "cloud", has)).not.toContain(QMA_MODEL);
    // Without the model in the catalog it isn't offered.
    expect(appModels(app, "open", (id) => id !== QMA_MODEL && has(id))).not.toContain(QMA_MODEL);
  });

  it("turns the app's choices into QMA's words, the note after them, and none of the 2511 LoRA", () => {
    const plan = planGeneration(
      { feature: "app:app-angles", modelId: QMA_MODEL, presetId: app.id, prompt: "keep the red scarf", inputs: { images: ["/api/files/p.png"] }, presetOptions: { angle: "back-left", height: "elevated", distance: "close-up" } },
      getModel,
      getPreset,
    );
    expect(plan.prompt).toBe("<qma> back-left quarter view elevated shot close-up keep the red scarf");
    expect(plan.loras.map((l) => l.file)).toEqual(["qwen-image-2.1-qma-camera-angles.safetensors"]);
    expect(parseQmaPrompt(plan.prompt)?.view).toEqual({ azimuth: "back-left quarter view", elevation: "elevated shot", distance: "close-up" });
    // Every one of the app's 8 × 4 × 3 choices reaches its own view.
    const views = new Set<string>();
    for (const a of app.options![0].choices)
      for (const h of app.options![1].choices)
        for (const d of app.options![2].choices) {
          const p = planGeneration({ feature: "app:app-angles", modelId: QMA_MODEL, presetId: app.id, prompt: "", inputs: { images: ["/api/files/p.png"] }, presetOptions: { angle: a.value, height: h.value, distance: d.value } }, getModel, getPreset).prompt;
          expect(p).toBe(`<qma> ${a.prompt} ${h.prompt} ${d.prompt}`);
          views.add(p);
        }
    expect(views.size).toBe(96);
  });
});

describe("Cinema", () => {
  const settings = {} as never;
  it("re-angles a location with QMA when asked, on your GPU", () => {
    const plan = planCinema({ engine: "open", mode: "image", action: "location-view", view: "reverse", modelId: QMA_MODEL, prompt: "", settings, source: { url: "/api/files/loc.png", kind: "image" } } as never, {} as never);
    expect(plan.model.id).toBe(QMA_MODEL);
    const req = plan.steps[0].request;
    expect(req.params?.extra).toMatchObject({ horizontal_angle: 180, vertical_angle: 0, zoom: 5 });
    expect(planGeneration(req, getModel, getPreset).prompt).toMatch(/^<qma> back view eye-level shot medium shot Keep everything about the place the same/);
    // The default stays the Multiple-Angles route.
    expect(planCinema({ engine: "open", mode: "image", action: "location-view", view: "reverse", prompt: "", settings, source: { url: "/api/files/loc.png", kind: "image" } } as never, {} as never).model.id).toBe("oss-qwen-edit");
  });

  it("re-shoots a still from the flown camera's nearest view", () => {
    expect(RECOMPOSE_MODELS.open).toContain(QMA_MODEL);
    expect(RECOMPOSE_MODELS.cloud).not.toContain(QMA_MODEL);
    const plan = planCinema(
      { engine: "open", mode: "image", action: "recompose", modelId: QMA_MODEL, prompt: "", settings, source: { url: "/api/files/still.png", kind: "image" }, capture: { url: "/api/files/cap.png", lens: 24, aperture: 5.6, pose: { horizontal: 100, vertical: 20, zoom: 8 } } } as never,
      {} as never,
    );
    const req = plan.steps[0].request;
    expect(req.inputs?.images).toEqual(["/api/files/still.png"]);
    expect(planGeneration(req, getModel, getPreset).prompt).toBe("<qma> right side view elevated shot close-up");
  });
});

describe("the turnaround", () => {
  it("knows QMA turns the camera, not the person", () => {
    expect(qmaHorizontal("front")).toBe(0);
    expect(qmaHorizontal("right")).toBe(270);
    expect(qmaHorizontal("back")).toBe(180);
    expect(qmaHorizontal("left")).toBe(90);
    expect(anglesHorizontal("right")).toBe(90);
  });

  it("draws the missing sides with QMA when picked, on your GPU", () => {
    const plan = planTurnaround({ engine: "open", views: { front: "/api/files/front.png" }, fillWith: "qma" });
    const fills = plan.steps.filter((s) => s.key.startsWith("fill-"));
    expect(fills.map((s) => [s.key, s.request.modelId, s.request.params?.extra?.horizontal_angle])).toEqual([
      ["fill-right", QMA_MODEL, 270],
      ["fill-back", QMA_MODEL, 180],
      ["fill-left", QMA_MODEL, 90],
    ]);
    expect(fills[0].request.loras).toBeUndefined();
    expect(planGeneration(fills[0].request, getModel, getPreset).prompt).toMatch(/^<qma> left side view eye-level shot medium shot Keep the same person/);
    expect(plan.costUsd).toBe(0);
    // The default stays the Angles app's route, and the cloud never takes QMA.
    expect(planTurnaround({ engine: "open", views: { front: "/api/files/front.png" } }).steps.find((s) => s.key === "fill-right")!.request.modelId).toBe("oss-qwen-edit");
    expect(planTurnaround({ engine: "cloud", views: { front: "/api/files/front.png" }, route: "keyframes", fillWith: "qma" }).steps.find((s) => s.key === "fill-right")!.request.modelId).toBe("qwen-multiple-angles");
  });

  it("makes the 8-view still set from the front view in one batch, with no film", () => {
    expect(ROUTES_ON.open).toEqual(["worldcast", "frames", "stills"]);
    expect(TURN_ROUTES.stills.modelId).toBe(QMA_MODEL);
    const plan = planTurnaround({ engine: "open", views: { front: "/api/files/front.png", back: "/api/files/back.png" }, route: "stills", name: "Ada" });
    expect(plan.route).toBe("stills");
    expect(plan.blocker).toBeUndefined();
    expect(plan.steps).toHaveLength(7);
    // Named by the person's own sides, going round to their right; QMA's camera turns the other way (as the fill's qmaHorizontal).
    expect(plan.steps.map((s) => s.request.params?.extra?.horizontal_angle)).toEqual([315, 270, 225, 180, 135, 90, 45]);
    expect(plan.steps.find((s) => s.request.step?.label === "Right side")!.request.params?.extra?.horizontal_angle).toBe(qmaHorizontal("right"));
    expect(plan.steps.find((s) => s.request.step?.label === "Left side")!.request.params?.extra?.horizontal_angle).toBe(qmaHorizontal("left"));
    expect(plan.steps[1].request.title).toBe("Turnaround stills · Ada · Right side");
    expect(plan.steps.every((s) => s.request.modelId === QMA_MODEL && s.request.inputs?.images?.[0] === "/api/files/front.png" && s.request.feature === "turnaround")).toBe(true);
    expect(plan.steps.map((s) => s.request.step?.label)).toEqual(["Front right", "Right side", "Back right", "Back", "Back left", "Left side", "Front left"]);
    expect(plan.steps[3].request.title).toBe("Turnaround stills · Ada · Back");
    expect(plan.durations).toEqual([]);
    expect(plan.costUsd).toBe(0);
    // From a sheet: its front is drawn first and each view chains from it.
    const sheet = planTurnaround({ engine: "open", sheet: "/api/files/sheet.png", route: "stills" });
    expect(sheet.steps[0].key).toBe("front");
    expect(sheet.steps.slice(1).every((s) => s.after?.[0] === "front")).toBe(true);
    // No front: asked for. The cloud has no stills route.
    expect(planTurnaround({ engine: "open", route: "stills" }).blocker).toMatch(/front view/);
    expect(planTurnaround({ engine: "cloud", views: { front: "/api/files/front.png" }, route: "stills" }).route).not.toBe("stills");
    // Without the QMA model offered the route isn't either.
    expect(planTurnaround({ engine: "open", views: { front: "/api/files/front.png" }, route: "stills" }, { has: (id) => id !== QMA_MODEL }).routes).toEqual(["frames"]);
  });

  it("takes the still route and the QMA fill through the API", () => {
    expect(TurnaroundSchema.parse({ engine: "open", route: "stills", fillWith: "qma" })).toMatchObject({ route: "stills", fillWith: "qma" });
    expect(() => TurnaroundSchema.parse({ engine: "open", fillWith: "other" })).toThrow();
  });
});

describe("the Canvas product angles and the GPU board", () => {
  it("runs the front and side angles on QMA on your GPU, with the camera in each node's settings", () => {
    const t = CANVAS_TEMPLATES.find((x) => x.id === "product-angles")!;
    const open = t.build("open");
    const cloud = t.build("cloud");
    for (const id of ["front", "side", "top"]) {
      const c = cloud.nodes.find((n) => n.id === id)!;
      expect(c.data.modelId).toBe("nano-banana-pro");
      expect(c.data.params).toBeUndefined();
    }
    for (const id of ["front", "side"]) {
      const o = open.nodes.find((n) => n.id === id)!;
      expect(o.data.modelId).toBe(QMA_MODEL);
      expect(o.data.params?.extra).toHaveProperty("horizontal_angle");
    }
    // QMA has no straight-down camera: the flat lay stays a plain edit.
    const top = open.nodes.find((n) => n.id === "top")!;
    expect(top.data.modelId).toBe("oss-qwen-image-21");
    expect(top.data.params?.extra).toBeUndefined();
    const side = open.nodes.find((n) => n.id === "side")!;
    expect(planGeneration({ feature: "canvas", modelId: QMA_MODEL, prompt: side.data.prompt ?? "", inputs: { images: ["/api/files/p.png"] }, params: side.data.params }, getModel, getPreset).prompt).toMatch(
      /^<qma> .*The same product in a clean side profile/,
    );
  });

  it("keeps each angle's words when the board moves to the cloud, and falls back when QMA is switched off", () => {
    const t = CANVAS_TEMPLATES.find((x) => x.id === "product-angles")!;
    const moved = convertEngine(t.build("open"), "cloud").graph;
    const prompts = ["front", "side", "top"].map((id) => moved.nodes.find((n) => n.id === id)!.data.prompt);
    expect(new Set(prompts).size).toBe(3);
    expect(prompts[0]).toMatch(/three-quarter front/);
    expect(prompts[1]).toMatch(/side profile/);
    expect(prompts[2]).toMatch(/top-down/);
    const off = t.build("open", (id) => id !== QMA_MODEL);
    for (const id of ["front", "side", "top"]) {
      const n = off.nodes.find((x) => x.id === id)!;
      expect(n.data.modelId).toBe("oss-qwen-image-21");
      expect(n.data.params?.extra).toBeUndefined();
    }
    expect(t.build("open", () => true).nodes.find((n) => n.id === "side")!.data.modelId).toBe(QMA_MODEL);
  });

  it("gives the 8-view stills a row on the pre-flight board", () => {
    const row = STUDIO_ROWS.find((r) => r.label === "Turnaround stills · 8 views")!;
    expect(row).toBeDefined();
    expect(studioTool(row)!.workflows).toEqual([QMA_WORKFLOW]);
  });
});
