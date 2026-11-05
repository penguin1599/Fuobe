import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GenInput, GenParams, Generation, Operation } from "@/lib/catalog/types";

/**
 * Green screen and fine hair (nm10-keying): the CorridorKey 2.0 key, Bria VRMBG 3.0 and FeyNoBg graphs (their packs pinned,
 * their classes checked against the packs' source), the key's passes and formats, the Green screen mode's own model list,
 * the two Bria routes on fal, the guided cut-out in Layers and the mask's way on to ProRes or EXR.
 */

process.env.FUOBE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fuobe-keying-"));
process.env.COMFYUI_URL = "http://127.0.0.1:9";

const root = path.resolve(__dirname, "..");
const read = (p: string) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
type Def = { input: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> }; output: string[]; python_module: string };
type Node = { class_type: string; inputs: Record<string, unknown> };
const manifest = read("workflows/comfyui/manifest.json") as { workflows: { id: string; capability: string; customNodes?: { name: string }[]; validated: boolean; license?: string; models?: { file: string; folder: string; gated?: boolean }[]; outputs: { node: string; role?: string }[]; bindings: Record<string, { node: string; input: string }[]> }[] };
const packs = read("workflows/comfyui/packs.json") as Record<string, { repo: string; commit: string }>;
const requirements = read("workflows/comfyui/requirements.json") as { workflows: Record<string, { packs: Record<string, string[]>; files: string[]; firstRun: string[] }> };
const subset = read("workflows/comfyui/object_info.subset.json") as Record<string, Def | null>;
const graph = (id: string) => read(`workflows/comfyui/${id}.json`) as Record<string, Node>;

const { prepareWorkflow } = await import("@/server/providers/comfyui");
const { getModel, getPreset, modelsFor } = await import("@/lib/catalog");
const { planGeneration } = await import("@/lib/catalog/plan");
const { buildPayload } = await import("@/lib/catalog/payload");
const { studioCatalog } = await import("@/lib/studio-catalog");
const { VIDEO_KEY_STUDIO, VIDEO_MATTE_STUDIO } = await import("@/lib/studios");
const { HUB_MODES } = await import("@/lib/hubs");
const { STUDIO_ROWS } = await import("@/server/gpu/tools");
const { modelHref } = await import("@/lib/palette-index");
const { TOOL_MODELS } = await import("@/lib/layers");
const { outputActions } = await import("@/lib/output-actions");
const { settingsShape } = await import("@/lib/composer");
const { licenceInfo, licenceTerms, NODE_PACKS, workflowLicence } = await import("@/lib/licences");
const { keyFormatValues } = await import("@/lib/av/keying");

const GRAPHS = {
  "video-key-corridorkey": { capability: "bg-remove-video", packs: ["ComfyUI-CorridorKey2", "ComfyUI-VideoHelperSuite"], roles: ["cutout", "matte", "frames"] },
  "video-matte-vrmbg3": { capability: "bg-remove-video", packs: ["ComfyUI-RMBG", "ComfyUI-VideoHelperSuite"], roles: ["cutout", "matte", "frames"] },
  "image-matte-feynobg": { capability: "bg-remove", packs: ["ComfyUI-RMBG"], roles: [] },
} as const;

/**
 * A node's inputs against its class's definition: every required input set, each link to an output that exists with the
 * type the input takes, each combo value one it lists (not the bound ones: the run sets those, an upload's name included).
 */
function checkNode(g: Record<string, Node>, id: string, bound: Set<string>): string[] {
  const n = g[id];
  const def = subset[n.class_type];
  if (!def) return [`${id}: ${n.class_type} has no recorded definition`];
  const specs = { ...(def.input.required ?? {}), ...(def.input.optional ?? {}) };
  const problems: string[] = [];
  for (const name of Object.keys(def.input.required ?? {})) if (!(name in n.inputs) && !Object.keys(n.inputs).some((k) => k.startsWith(`${name}.`))) problems.push(`${id}: ${n.class_type} needs ${name}`);
  for (const [name, v] of Object.entries(n.inputs)) {
    const spec = specs[name];
    if (!spec) continue; // dynamic widgets (VHS's per-format inputs, SaveImageAdvanced's format.*) aren't in the static list
    if (Array.isArray(v)) {
      const [from, slot] = v as [string, number];
      const src = g[from];
      const out = src && subset[src.class_type]?.output[slot];
      if (!out) problems.push(`${id}.${name}: no output ${slot} on node ${from}`);
      else if (typeof spec[0] === "string" && spec[0] !== "COMBO" && spec[0] !== "*" && spec[0] !== out) problems.push(`${id}.${name}: takes ${spec[0]}, gets ${out}`);
    } else if (!bound.has(`${id}.${name}`) && Array.isArray(spec[0]) && !(spec[0] as unknown[]).includes(v)) problems.push(`${id}.${name}: ${String(v)} is not one of ${(spec[0] as unknown[]).join(", ")}`);
  }
  return problems;
}

describe("the keying graphs in the library", () => {
  it.each(Object.entries(GRAPHS))("%s: its packs pinned, its classes checked against their definitions, its licence stated", (id, want) => {
    const w = manifest.workflows.find((x) => x.id === id)!;
    expect(w.capability).toBe(want.capability);
    expect(w.customNodes?.map((c) => c.name).sort()).toEqual([...want.packs].sort());
    // The packs (or ComfyUI-RMBG 3.3.0) aren't on the validation server: the graph waits for a GPU that has them.
    expect(w.validated).toBe(false);
    for (const p of want.packs) expect(packs[p].commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(requirements.workflows[id].packs).sort()).toEqual([...want.packs].sort());
    expect(w.outputs.map((o) => o.role).filter(Boolean)).toEqual(want.roles);
    const g = graph(id);
    const bound = new Set(Object.values(w.bindings).flat().map((b) => `${b.node}.${b.input}`));
    expect(Object.keys(g).flatMap((n) => checkNode(g, n, bound))).toEqual([]);
  });

  it("pins ComfyUI-RMBG at 3.3.0 and records where each new class comes from", () => {
    expect(packs["ComfyUI-RMBG"].commit).toBe("a66a5e641a54988d80ed6aad18946081c85f309e");
    expect(packs["ComfyUI-CorridorKey2"]).toMatchObject({ repo: "https://github.com/hashu786/ComfyUI-CorridorKey2", commit: "d1228b68796786acee92b6497f72a60d70d1a844" });
    for (const c of ["AILab_VRMBG", "AILab_FeyNoBg"]) expect(subset[c]?.python_module).toBe("custom_nodes.ComfyUI-RMBG");
    expect(subset.CorridorKey2?.python_module).toBe("custom_nodes.ComfyUI-CorridorKey2");
    // CorridorKey 2.0, not the v1.0 wrapper's classes: the matte, the despilled foreground over black and the straight RGBA.
    expect(subset.CorridorKey2?.output).toEqual(["IMAGE", "MASK", "IMAGE", "IMAGE", "IMAGE"]);
    for (const c of ["LoadCorridorKeyModel", "ChromaKeyPrepass", "CorridorKeyGreenscreen"]) expect(subset[c]).toBeUndefined();
  });

  it("states each model's licence and download plainly: CorridorKey's paid-API rule, VRMBG's gate, FeyNoBg unknown", () => {
    const lic = (id: string) => manifest.workflows.find((x) => x.id === id)!.license!;
    expect(lic("video-key-corridorkey")).toMatch(/NOT be offered as a paid API or inference service/);
    expect(licenceTerms(lic("video-key-corridorkey")).flags).toEqual(["conditions"]);
    expect(licenceTerms(lic("video-matte-vrmbg3")).flags).toEqual(["non-commercial"]);
    expect(lic("image-matte-feynobg")).toMatch(/^FeyNoBg weights: unknown/);
    const vrmbg = manifest.workflows.find((x) => x.id === "video-matte-vrmbg3")!;
    expect(vrmbg.models).toEqual([expect.objectContaining({ file: "VRMBG-3.0/model.safetensors", folder: "RMBG", gated: true })]);
    expect(requirements.workflows["video-matte-vrmbg3"].files).toEqual(["RMBG/VRMBG-3.0/model.safetensors"]);
    expect(requirements.workflows["video-key-corridorkey"].firstRun.join(" ")).toMatch(/corridorkey_v2\.safetensors \(2\.66 GB\)/);
    // As Settings → Models & licences shows them: CorridorKey's own licence by name, FeyNoBg as not recorded.
    expect(licenceInfo(workflowLicence({ id: "video-key-corridorkey", license: lic("video-key-corridorkey") }))).toMatchObject({ name: "Corridor Key Licence 2.0", class: "conditions", url: expect.stringContaining("nikopueringer/CorridorKey2.0") });
    expect(licenceInfo(workflowLicence({ id: "image-matte-feynobg", license: lic("image-matte-feynobg") }))).toMatchObject({ name: "Not recorded", class: "unknown" });
    expect(licenceInfo("CC BY-NC-SA 4.0 (weights: NON-COMMERCIAL)")).toMatchObject({ name: "CC BY-NC-SA 4.0", class: "non-commercial" });
    expect(NODE_PACKS.find((p) => p.name === "ComfyUI-CorridorKey2")?.licence).toMatchObject({ name: "Corridor Key Licence 2.0", class: "conditions" });
    expect(requirements.workflows["image-matte-feynobg"].firstRun.join(" ")).toMatch(/FeyNobg\.safetensors/);
  });
});

const ctx = (op: Operation) => ({ generationId: "g", op, upload: async () => "clip.mp4", media: (() => undefined) as never, serverRam: async () => undefined });
const prepare = async (id: string, input: Partial<GenInput>, op: Operation = "bg-remove-video") => (await prepareWorkflow(id, { video: "/clip.mp4", ...input } as GenInput, ctx(op))).workflow;

describe("the green-screen key on your GPU", () => {
  it("runs in passes: the loader and every encoder share one meta batch", async () => {
    const g = graph("video-key-corridorkey");
    const batched = Object.entries(g).filter(([, n]) => n.inputs.meta_batch).map(([id]) => id);
    expect(batched.sort()).toEqual(["1", "7", "9"]);
    const prepared = await prepareWorkflow("video-key-corridorkey", { video: "/clip.mp4", matteOutput: "cutout" } as GenInput, ctx("bg-remove-video"));
    expect(prepared.meta.metaBatch).toBe(true);
    expect(prepared.workflow["2"].inputs.frames_per_batch).toBe(48);
  });

  it("keeps the output asked for, and writes the cut-out as WebM, ProRes 4444 with alpha or EXR frames", async () => {
    const webm = await prepare("video-key-corridorkey", { matteOutput: "cutout" });
    expect(Object.keys(webm).filter((k) => ["7", "9", "11"].includes(k))).toEqual(["7"]);
    expect(webm["7"].inputs).toMatchObject({ format: "video/webm", pix_fmt: "yuva420p" });
    const prores = await prepare("video-key-corridorkey", { matteOutput: "cutout", format: "prores_4444" });
    expect(prores["7"].inputs).toMatchObject({ format: "video/ProRes", profile: "4444" });
    expect(prores["11"]).toBeUndefined();
    const exr = await prepare("video-key-corridorkey", { matteOutput: "cutout", format: "exr" });
    expect(Object.keys(exr).filter((k) => ["7", "9", "11"].includes(k)).sort()).toEqual(["11", "7"]);
    expect(exr["11"].inputs).toMatchObject({ format: "exr", "format.bit_depth": "16-bit float", "format.input_color_space": "sRGB" });
    // The clean foreground leaves through the cut-out's encoder: the keyer's despilled colours over black as H.264 with the sound.
    const fg = await prepare("video-key-corridorkey", { matteOutput: "foreground", extra: { despill: 0.8 } });
    expect(Object.keys(fg).filter((k) => ["7", "9", "11"].includes(k))).toEqual(["7"]);
    expect(fg["7"].inputs).toMatchObject({ images: ["6", 2], format: "video/h264-mp4", pix_fmt: "yuv420p", audio: ["1", 2] });
    await expect(prepare("video-matte-vrmbg3", { matteOutput: "foreground" })).rejects.toThrow(/doesn't make a clean foreground/);
    expect(fg["6"]).toMatchObject({ class_type: "CorridorKey2", inputs: { despill_strength: 0.8, gamma_space: "sRGB", window: "auto" } });
    // ProRes and EXR carry the cut-out with its alpha, not the mask.
    await expect(prepare("video-key-corridorkey", { matteOutput: "matte", format: "prores_4444" })).rejects.toThrow(/ProRes 4444 is for the cut-out/);
    // Without a format the EXR frames are never written.
    const plain = await prepare("video-key-corridorkey", {});
    expect(plain["11"]).toBeUndefined();
  });

  it("writes VRMBG 3.0's cut-out the same three ways", async () => {
    const prores = await prepare("video-matte-vrmbg3", { matteOutput: "cutout", format: "prores_4444" });
    expect(prores["4"].inputs).toMatchObject({ format: "video/ProRes", profile: "4444" });
    expect(prores["6"]).toBeUndefined();
    const matte = await prepare("video-matte-vrmbg3", { matteOutput: "matte" });
    expect(Object.keys(matte).filter((k) => ["4", "6", "7"].includes(k))).toEqual(["6"]);
    const exr = await prepare("video-matte-vrmbg3", { matteOutput: "cutout", format: "exr" });
    expect(exr["7"]).toBeDefined();
    expect(() => keyFormatValues("h264", "cutout")).toThrow(/WebM, ProRes 4444 or EXR 16-bit/);
  });

  it("binds the picture into FeyNoBg with its edge refine on", async () => {
    const g = await prepareWorkflow("image-matte-feynobg", { images: ["/p.png"] } as GenInput, { ...ctx("bg-remove"), upload: async () => "p.png" });
    expect(g.workflow["2"].inputs).toMatchObject({ refine_foreground: true, background: "Alpha" });
  });
});

const plan = (modelId: string, params: GenParams = {}, op: Operation = "bg-remove-video") =>
  planGeneration({ feature: "video-tools", modelId, op, inputs: { video: "/clip.mp4" }, params }, getModel, getPreset);

describe("Video tools → Green screen", () => {
  it("is a mode of its own, listing the keyers only, and Remove background lists the other mattes", () => {
    expect(HUB_MODES["video-tools"].map((m) => m.id)).toContain("green-screen");
    const keyers = studioCatalog(VIDEO_KEY_STUDIO).models.map((m) => m.id);
    expect(keyers.sort()).toEqual(["bria-green-screen", "oss-video-key-corridorkey"]);
    const mattes = studioCatalog(VIDEO_MATTE_STUDIO).models.map((m) => m.id);
    expect(mattes).toContain("oss-video-matte-vrmbg3");
    expect(mattes).not.toContain("oss-video-key-corridorkey");
    expect(mattes).not.toContain("bria-green-screen");
    expect(modelHref(getModel("oss-video-key-corridorkey")!)).toBe("/video-tools/green-screen?model=oss-video-key-corridorkey");
    expect(modelHref(getModel("oss-video-matte-vrmbg3")!)).toBe("/video-tools?model=oss-video-matte-vrmbg3");
    // The GPU pre-flight board has a row for it.
    expect(STUDIO_ROWS.find((r) => r.href === "/video-tools/green-screen")?.config?.defaultModels.open).toBe("oss-video-key-corridorkey");
  });

  it("offers the cut-out, the mask and the clean foreground, and the formats only where they apply", () => {
    const ck = getModel("oss-video-key-corridorkey")!;
    const shape = settingsShape(ck, "bg-remove-video", "video", false);
    expect(shape.matteOutput).toEqual(["cutout", "matte", "foreground"]);
    expect(shape.formats).toEqual(["webm_alpha", "prores_4444", "exr"]);
    expect(plan("oss-video-key-corridorkey").params.matteOutput).toBe("cutout");
    expect(() => plan("oss-video-key-corridorkey", { matteOutput: "matte", format: "exr" })).toThrow(/EXR frames, 16-bit is for the cut-out/);
    expect(() => plan("oss-video-matte-birefnet", { matteOutput: "foreground" })).toThrow(/doesn't make a clean foreground/);
    expect(() => plan("oss-video-key-corridorkey", { format: "h264" })).toThrow(/writes WebM, ProRes 4444 or EXR 16-bit/);
    // The cloud keyer is Bria's, the cut-out only, priced per second.
    const bria = getModel("bria-green-screen")!;
    expect(bria.options).toMatchObject({ greenScreen: true, matteOutputs: ["cutout"] });
    expect(bria.pricing).toMatchObject({ unit: "second", usd: 0.05 });
  });
});

describe("the Bria routes on fal", () => {
  it("green-screen despill: the clip, a transparent WebM and the spill cleanup", () => {
    const route = getModel("bria-green-screen")!.routes[0];
    expect(route.endpoint).toBe("bria/video/background-removal/green-screen-despill");
    const body = buildPayload(route.map!, { prompt: "", video: "https://x/clip.mp4", extra: { spill_suppression: 0.4 } } as GenInput);
    expect(body).toMatchObject({ video_url: "https://x/clip.mp4", output_container_and_codec: "webm_vp9", spill_suppression: 0.4 });
    expect(body).not.toHaveProperty("prompt");
  });

  it("guided cut-out: the picture and, when given, what to keep or drop", () => {
    const m = getModel("bria-guided-cutout")!;
    expect(m.routes[0].endpoint).toBe("bria/guided-remove-background");
    expect(m.pricing).toMatchObject({ unit: "image", usd: 0.03 });
    expect(buildPayload(m.routes[0].map!, { prompt: "keep the shadow", images: ["https://x/p.png"] } as GenInput)).toEqual({ image_url: "https://x/p.png", prompt: "keep the shadow" });
    // No words: the plain cut-out of the obvious subject.
    expect(buildPayload(m.routes[0].map!, { prompt: "", images: ["https://x/p.png"] } as GenInput)).toEqual({ image_url: "https://x/p.png" });
  });
});

describe("image cut-outs", () => {
  it("Layers' Remove background offers FeyNoBg on your GPU and Bria's guided cut-out in the cloud", () => {
    expect(TOOL_MODELS["bg-remove"].open).toContain("oss-matte-feynobg");
    expect(TOOL_MODELS["bg-remove"].cloud).toContain("bria-guided-cutout");
    // Both are bg-remove models, so the Canvas node and the model picker list them too.
    expect(modelsFor({ kind: "image", ops: ["bg-remove"] }).map((m) => m.id)).toEqual(expect.arrayContaining(["oss-matte-feynobg", "bria-guided-cutout"]));
  });

  it("the Canvas Remove background node takes the guided cut-out's words from a text node", async () => {
    const { describeNode, inputPorts } = await import("@/lib/catalog/canvas");
    const at = { x: 0, y: 0 };
    const cut = { id: "cut", type: "bg-remove" as const, position: at, data: { mediaKind: "image" as const, modelId: "bria-guided-cutout" } };
    expect(inputPorts(cut).map((p) => p.id)).toEqual(["prompt", "images"]);
    // Plain cut-outs take a picture only.
    expect(inputPorts({ ...cut, data: { ...cut.data, modelId: "birefnet-cloud" } }).map((p) => p.id)).toEqual(["images"]);
    const graph = {
      nodes: [{ id: "pic", type: "image-input" as const, position: at, data: { url: "/api/files/u/p.png" } }, { id: "words", type: "prompt" as const, position: at, data: { text: "keep the shadow" } }, cut],
      edges: [
        { id: "e1", source: "pic", sourceHandle: "out", target: "cut", targetHandle: "images" },
        { id: "e2", source: "words", sourceHandle: "out", target: "cut", targetHandle: "prompt" },
      ],
    };
    const d = describeNode(graph as never, cut as never, { engineMode: "cloud" });
    expect(d.error).toBeUndefined();
    expect(d.request).toMatchObject({ modelId: "bria-guided-cutout", op: "bg-remove", prompt: "keep the shadow", inputs: { images: ["/api/files/u/p.png"] } });
  });
});

describe("a matte's way to the edit", () => {
  const gen = (params: GenParams, op = "bg-remove-video") =>
    ({ id: "g1", op, feature: "video-tools", engine: "open", status: "succeeded", prompt: "", request: { modelId: "oss-video-matte-birefnet", params }, outputs: [{ url: "/api/files/m.mp4", kind: "video" }] }) as unknown as Generation;
  it("sends a mask or a clean foreground on to ProRes or EXR, never a cut-out (Export would drop its transparency)", () => {
    const href = (g: Generation, engineMode?: "both" | "cloud") => outputActions(g, 0, { engineMode }).find((a) => a.id === "export-pro")?.href;
    expect(href(gen({ matteOutput: "matte" }))).toBe("/upscale/export?video=%2Fapi%2Ffiles%2Fm.mp4&format=prores_4444");
    expect(href(gen({ matteOutput: "foreground" }))).toBeDefined();
    expect(href(gen({ matteOutput: "cutout" }))).toBeUndefined();
    expect(href(gen({ matteOutput: "matte" }, "depth-video"))).toBeUndefined();
    // Export runs on your GPU only.
    expect(href(gen({ matteOutput: "matte" }), "cloud")).toBeUndefined();
  });
});
