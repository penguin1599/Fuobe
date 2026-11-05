import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "./helpers/temp-dir";
import type { Manifest } from "@/lib/comfy";

/**
 * Idol 3D's clean splats (idol-2, docs/research/idol-9.md §5.6): the ComfyUI-Idol pack pinned and licensed, the
 * image-to-splat-idol-clean graph (IdolPreprocessImage's crop, IdolPruneSplat after the decoder, the input-view still),
 * the provider picking it when the server has the pack and the core graph otherwise, and what the card reads.
 * The pack is never installed here: the graph is checked against the inputs the pack's nodes declare (§5.1).
 */

const dir = tempDir("fuobe-idol-clean-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";

const root = process.cwd();
const { setSetting } = await import("@/server/settings");
const { collectOutputs, comfyHasClass, comfyProvider, forgetComfyClass, getWorkflow, prepareWorkflow } = await import("@/server/providers/comfyui");
const { changeAccess } = await import("@/server/model-access");
const m3d = await import("@/lib/av/model3d");
const { licenceTerms, NODE_PACKS, workflowLicence } = await import("@/lib/licences");

const PIN = "4d3a4f671028f0e062d9f004cda1a2dd73360d35";
const REPO = `https://github.com/Nynxz/ComfyUI-Idol/tree/${PIN}`;
const manifest = JSON.parse(fs.readFileSync(path.join(root, "workflows", "comfyui", "manifest.json"), "utf8")) as Manifest;
const entry = manifest.workflows.find((w) => w.id === "image-to-splat-idol-clean")!;
const core = manifest.workflows.find((w) => w.id === "image-to-splat-idol")!;
type Node = { class_type: string; inputs: Record<string, unknown> };
const read = (id: string) => JSON.parse(fs.readFileSync(path.join(root, "workflows", "comfyui", `${id}.json`), "utf8")) as Record<string, Node>;
const graph = read("image-to-splat-idol-clean");
const coreGraph = read("image-to-splat-idol");

// A stand-in ComfyUI that answers GET /object_info/<class> (the pack's classes when `pack` is on) and counts the asks,
// and takes POST /prompt (or refuses it, as a ComfyUI without the pack does), keeping the graphs it was sent.
let pack = true;
let asks = 0;
let refuse = false;
const prompts: Record<string, Node>[] = [];
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/prompt") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      prompts.push((JSON.parse(body) as { prompt: Record<string, Node> }).prompt);
      res.writeHead(refuse ? 400 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(refuse ? { error: { type: "missing_node_type", message: "Node 'IdolPruneSplat' not found" }, node_errors: {} } : { prompt_id: `p-${prompts.length}` }));
    });
    return;
  }
  const m = /^\/object_info\/(\w+)$/.exec(req.url ?? "");
  if (!m) {
    res.writeHead(404).end();
    return;
  }
  asks++;
  const has = pack && /^Idol(PreprocessImage|Camera|PruneSplat)$/.test(m[1]);
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(has ? { [m[1]]: { input: {}, output: [] } } : {}));
});

beforeAll(async () => {
  setSetting("demoMode", "auto");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  setSetting("comfyUrl", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});
afterAll(() => {
  server.close();
});

const prepare = (extra: Record<string, unknown>, idolPack?: () => Promise<boolean | undefined>) =>
  prepareWorkflow("image-to-splat-idol", { prompt: "", images: ["p.png"], seed: 7, extra }, { generationId: "gen-clean", op: "splat", upload: async () => "x", idolPack });

describe("ComfyUI-Idol: pinned, recorded and expected by the build", () => {
  it("the spec knows the pack's three classes and its repository at the pin, and the new binding keys", async () => {
    const spec = await import("../scripts/comfy/library.spec.mjs");
    const build = await import("../scripts/comfy/build-library.mjs");
    expect(spec.CUSTOM_NODE_REPOS["ComfyUI-Idol"]).toBe(REPO);
    for (const c of ["IdolPreprocessImage", "IdolCamera", "IdolPruneSplat"]) expect(spec.PACK_CLASSES["ComfyUI-Idol"].test(c), c).toBe(true);
    expect(spec.PACK_CLASSES["ComfyUI-Idol"].test("IdolPruneSplatX")).toBe(false);
    expect(spec.PACK_CLASSES["ComfyUI-Idol"].test("TripoSplatPreprocessImage")).toBe(false);
    const e = spec.SPEC.find((s: { id: string }) => s.id === "image-to-splat-idol-clean");
    expect(e).toMatchObject({ packs: ["ComfyUI-Idol"], capability: "splat", handBuilt: "hand-built/image-to-splat-idol-clean.json" });
    for (const k of ["cropMode", "minOpacity", "maxScale"]) expect(build.BINDING_KEYS.has(k), k).toBe(true);
  });

  it("the manifest entry names the pack, keeps idol-1's files and adds the crop and pruning bindings", () => {
    expect(entry).toMatchObject({ capability: "splat", vramGb: 8, limits: { maxGaussians: 1048576 }, validated: false });
    expect(entry.customNodes).toEqual([{ name: "ComfyUI-Idol", repo: REPO }]);
    expect(entry.models).toEqual(core.models);
    expect(entry.defaults).toMatchObject({ splatFormat: "spz", cutout: true, cropMode: "synthetic", minOpacity: 0.05, maxScale: 0, steps: 50, cfg: 4, numGaussians: 262144 });
    expect(entry.defaults).not.toHaveProperty("photoCrop");
    expect(Object.keys(entry.bindings).sort()).toEqual(
      ["cfg", "cropMode", "cutout", "filenamePrefix", "image", "maxScale", "minOpacity", "numGaussians", "orbitFrames", "sampler", "seed", "splatFormat", "steps"].sort(),
    );
    expect(entry.bindings.cropMode).toEqual([{ node: "88:110", input: "mode" }]);
    expect(entry.bindings.minOpacity).toEqual([{ node: "88:111", input: "min_opacity" }]);
    expect(entry.bindings.maxScale).toEqual([{ node: "88:111", input: "max_scale" }]);
    expect(entry.outputs).toEqual([
      { node: "51", kind: "model3d", role: "splat" },
      { node: "42", kind: "video", role: "turntable" },
      { node: "93", kind: "image", role: "preview" },
      { node: "94", kind: "text", role: "report" },
    ]);
  });

  it("the GPU check's index lists the pack's classes for the graph, and its pin", () => {
    const req = JSON.parse(fs.readFileSync(path.join(root, "workflows", "comfyui", "requirements.json"), "utf8")) as {
      workflows: Record<string, { packs: Record<string, string[]>; files: string[]; core: string[] }>;
      packs: Record<string, { commit: string; classes: string[]; isolated: boolean }>;
    };
    expect(req.workflows["image-to-splat-idol-clean"].packs).toEqual({ "ComfyUI-Idol": ["IdolCamera", "IdolPreprocessImage", "IdolPruneSplat"] });
    expect(req.workflows["image-to-splat-idol-clean"].files).toEqual(req.workflows["image-to-splat-idol"].files);
    expect(req.workflows["image-to-splat-idol-clean"].core).not.toContain("TripoSplatPreprocessImage");
    expect(req.packs["ComfyUI-Idol"]).toMatchObject({ commit: PIN, classes: ["IdolCamera", "IdolPreprocessImage", "IdolPruneSplat"], isolated: false });
    const pins = JSON.parse(fs.readFileSync(path.join(root, "workflows", "comfyui", "packs.json"), "utf8")) as Record<string, { repo: string; commit: string; registry: unknown }>;
    // Not in the Comfy Registry: the registry's "comfyui-idol" is another author's pack.
    expect(pins["ComfyUI-Idol"]).toMatchObject({ repo: "https://github.com/Nynxz/ComfyUI-Idol", commit: PIN, registry: null });
  });

  it("install-comfyui.sh pins it in the main ComfyUI, with what was read", () => {
    const sh = fs.readFileSync(path.join(root, "scripts", "comfy", "install-comfyui.sh"), "utf8");
    const nodes = sh.slice(sh.indexOf("declare -A NODES=("), sh.indexOf("\n)\n"));
    expect(nodes).toContain(`[ComfyUI-Idol]="https://github.com/Nynxz/ComfyUI-Idol ${PIN}"`);
    expect(nodes).toMatch(/Apache-2\.0, no Python dependencies, no model code/);
    expect(nodes).toMatch(/not in the Comfy Registry/);
  });

  it("Settings → Models & licences has its row, and the workflow's licence adds the pack's", () => {
    const row = NODE_PACKS.find((p) => p.name === "ComfyUI-Idol")!;
    expect(row.repo).toBe(REPO);
    expect(row.licence).toMatchObject({ name: "Apache-2.0", class: "commercial" });
    expect(row.licence.note).toMatch(/crop modes, predicted camera and splat pruning/);
    const text = workflowLicence(entry);
    expect(text).toBe(`${workflowLicence(core)}; ComfyUI-Idol nodes Apache-2.0`);
    expect(licenceTerms(text).notices).toEqual(["Built with DINOv3"]);
    expect(licenceTerms(text).flags).toEqual(licenceTerms(workflowLicence(core)).flags);
  });
});

describe("image-to-splat-idol-clean: the graph", () => {
  // The inputs the pack's nodes declare at the pin (idol/nodes.py; docs/research/idol-9.md §5.1).
  const PACK_INPUTS: Record<string, string[]> = {
    IdolPreprocessImage: ["image", "mode", "mask", "bg_removal_model", "erode_radius", "size"],
    IdolCamera: ["samples"],
    IdolPruneSplat: ["splat", "min_opacity", "max_scale"],
  };

  it("crops with IdolPreprocessImage on Fuobe's cut-out mask and feeds the conditioning from it", () => {
    expect(graph["88:110"]).toMatchObject({ class_type: "IdolPreprocessImage", inputs: { image: ["99", 0], mode: "synthetic", mask: ["88:35", 0], erode_radius: 1, size: 1024 } });
    expect(graph["88:110"].inputs).not.toHaveProperty("bg_removal_model");
    expect(graph["88:24"].inputs.image).toEqual(["88:110", 0]);
    // The core crop and its photo branch are gone.
    for (const id of ["88:2", "88:101", "88:102", "88:103", "88:104"]) expect(graph[id], id).toBeUndefined();
    expect(Object.values(graph).some((n) => n.class_type === "TripoSplatPreprocessImage")).toBe(false);
  });

  it("prunes after the decoder; the saved file, the orbit and the still all get the pruned splat; the count is reported", () => {
    expect(graph["88:111"]).toMatchObject({ class_type: "IdolPruneSplat", inputs: { splat: ["88:55", 0], min_opacity: 0.05, max_scale: 0 } });
    expect(graph["92"].inputs.splat).toEqual(["88:111", 0]);
    expect(graph["75"].inputs.splat).toEqual(["88:111", 0]);
    expect(graph["94"]).toMatchObject({ class_type: "PreviewAny", inputs: { source: ["88:111", 1] } });
  });

  it("renders the input view from Idol's predicted camera, one 1024 px frame on black, saved as an image", () => {
    expect(graph["88:112"]).toMatchObject({ class_type: "IdolCamera", inputs: { samples: ["88:6", 0] } });
    expect(graph["88:113"]).toMatchObject({
      class_type: "RenderSplat",
      inputs: { frames: 1, width: 1024, height: 1024, background: "#000000", splat: ["88:111", 0], camera_info: ["88:112", 0] },
    });
    expect(graph["93"]).toMatchObject({ class_type: "SaveImage", inputs: { images: ["88:113", 0] } });
  });

  it("gives the pack's nodes only inputs they declare, and everything else is idol-1's graph as it is", () => {
    for (const n of Object.values(graph)) if (PACK_INPUTS[n.class_type]) for (const k of Object.keys(n.inputs)) expect(PACK_INPUTS[n.class_type], `${n.class_type}.${k}`).toContain(k);
    const changed = new Set(["88:24", "92", "75", "42", "51"]);
    for (const [id, n] of Object.entries(coreGraph)) {
      if (changed.has(id) || ["88:2", "88:101", "88:102", "88:103", "88:104"].includes(id)) continue;
      expect(graph[id], id).toEqual(n);
    }
    // The core graph keeps its own crop branch (the fallback is unchanged).
    expect(coreGraph["88:104"].class_type).toBe("ComfySwitchNode");
    expect(coreGraph["75"].inputs.splat).toEqual(["88:55", 0]);
  });
});

describe("the provider: the clean graph where the server has the pack, idol-1's graph otherwise", () => {
  it("runs the clean graph when the server says it has the pack", async () => {
    const p = await prepare(m3d.idolExtra("open", "best", false), async () => true);
    expect(p.manifest.id).toBe("image-to-splat-idol-clean");
    expect(p.workflow["88:110"].inputs.mode).toBe("synthetic");
    expect(p.workflow["88:111"].inputs).toMatchObject({ min_opacity: 0.05, max_scale: 0 });
    expect(p.workflow["88:6"].inputs).toMatchObject({ steps: 50, cfg: 4, sampler_name: "euler", seed: 7 });
  });

  it("runs the core graph without the pack, when the server can't say, or when the question fails", async () => {
    for (const idolPack of [async () => false, async () => undefined, async () => Promise.reject(new Error("down")), undefined]) {
      const p = await prepare(m3d.idolExtra("open", "quick", true, true), idolPack as never);
      expect(p.manifest.id).toBe("image-to-splat-idol");
      // The photo switch still works there; the pack's pruning doesn't exist.
      expect(p.workflow["88:104"].inputs.switch).toBe(true);
      expect(Object.values(p.workflow).some((n) => n.class_type.startsWith("Idol"))).toBe(false);
    }
  });

  it("maps 'It's a photo' to Idol's real crop and Trim spikes to max_scale 0.05; values out of range are clamped", async () => {
    const photo = await prepare(m3d.idolExtra("open", "best", true, true), async () => true);
    expect(photo.workflow["88:110"].inputs.mode).toBe("real");
    expect(photo.workflow["88:111"].inputs).toMatchObject({ min_opacity: 0.05, max_scale: 0.05 });
    const asked = await prepare({ cropMode: "real", minOpacity: 3, maxScale: -1 }, async () => true);
    expect(asked.workflow["88:110"].inputs.mode).toBe("real");
    expect(asked.workflow["88:111"].inputs).toMatchObject({ min_opacity: 1, max_scale: 0 });
    // A cropMode on the core graph turns its photo switch on.
    const coreReal = await prepare({ cropMode: "real" }, async () => false);
    expect(coreReal.workflow["88:104"].inputs.switch).toBe(true);
  });

  it("idolGraphValues speaks each graph's words", () => {
    const clean = (k: string) => ["cropMode", "minOpacity", "maxScale"].includes(k);
    const coreHas = (k: string) => k === "photoCrop";
    expect(m3d.idolGraphValues({ photoCrop: true }, clean)).toEqual({ cropMode: "real" });
    expect(m3d.idolGraphValues({ photoCrop: false, maxScale: 0.05 }, clean)).toEqual({ cropMode: "synthetic", maxScale: 0.05 });
    expect(m3d.idolGraphValues({}, clean)).toEqual({ cropMode: "synthetic" });
    expect(m3d.idolGraphValues({ cropMode: "odd", minOpacity: "x" }, clean)).toEqual({ cropMode: "synthetic" });
    expect(m3d.idolGraphValues({ photoCrop: true, maxScale: 0.05 }, coreHas)).toEqual({ photoCrop: true });
    expect(m3d.idolGraphValues({}, coreHas)).toEqual({});
  });

  it("asks GET /object_info/IdolPruneSplat once a minute, and again after forgetting or when the pack goes", async () => {
    pack = true;
    asks = 0;
    expect(await comfyHasClass("IdolPruneSplat")).toBe(true);
    expect(await comfyHasClass("IdolPruneSplat")).toBe(true);
    expect(asks).toBe(1);
    pack = false;
    forgetComfyClass("IdolPruneSplat");
    expect(await comfyHasClass("IdolPruneSplat")).toBe(false);
    expect(asks).toBe(2);
    // An answer older than asked for is asked again.
    pack = true;
    expect(await comfyHasClass("IdolPruneSplat", "main", 0)).toBe(true);
    expect(asks).toBe(3);
  });
});

describe("the provider's submit: Settings and a refused prompt", () => {
  // No progress socket here: the run is only sent.
  const realWs = globalThis.WebSocket;
  class NoSocket {
    readyState = 1;
    onmessage = null;
    onerror = null;
    close() {}
  }
  beforeAll(() => {
    globalThis.WebSocket = NoSocket as unknown as typeof WebSocket;
  });
  afterAll(() => {
    globalThis.WebSocket = realWs;
    changeAccess([{ kind: "pack", id: "ComfyUI-Idol", on: true }]);
  });
  const route = { op: "splat", provider: "comfyui", endpoint: "image-to-splat-idol" } as never;
  const model = { id: "oss-idol", routes: [route] } as never;
  const submit = (generationId: string) =>
    comfyProvider.submit({ generationId, model, route, input: { prompt: "", images: ["p.png"], seed: 7, extra: m3d.idolExtra("open", "best", false, true) } });
  const classes = (g: Record<string, Node>) => Object.values(g).map((n) => n.class_type);

  it("with ComfyUI-Idol switched off in Settings, sends the core graph without asking the server about the pack", async () => {
    pack = true;
    forgetComfyClass("IdolPruneSplat");
    changeAccess([{ kind: "pack", id: "ComfyUI-Idol", on: false }]);
    asks = 0;
    prompts.length = 0;
    const res = await submit("gen-off");
    expect(res.meta).toMatchObject({ workflowId: "image-to-splat-idol" });
    expect(asks).toBe(0);
    expect(classes(prompts[0]).some((c) => c.startsWith("Idol"))).toBe(false);
    changeAccess([{ kind: "pack", id: "ComfyUI-Idol", on: true }]);
  });

  it("switched on with the pack there, sends the clean graph; a refused prompt makes the next run ask again", async () => {
    pack = true;
    forgetComfyClass("IdolPruneSplat");
    asks = 0;
    prompts.length = 0;
    expect((await submit("gen-on")).meta).toMatchObject({ workflowId: "image-to-splat-idol-clean" });
    expect(asks).toBe(1);
    expect(prompts[0]["88:111"].inputs).toMatchObject({ max_scale: 0.05 });
    // The pack went: ComfyUI refuses the clean graph, and the cached answer is dropped.
    pack = false;
    refuse = true;
    await expect(submit("gen-gone")).rejects.toThrow();
    expect(asks).toBe(1);
    refuse = false;
    expect((await submit("gen-after")).meta).toMatchObject({ workflowId: "image-to-splat-idol" });
    expect(asks).toBe(2);
  });
});

describe("the outputs and the card", () => {
  const file = (filename: string) => ({ filename, subfolder: "fuobe", type: "output" });
  const history = (count?: string) => ({
    status: { status_str: "success", completed: true },
    outputs: {
      "51": { "3d": [file("gen_00001_.spz")] },
      "42": { images: [file("gen_00001_.mp4")], animated: [true] },
      "93": { images: [file("gen_00001_.png")] },
      ...(count !== undefined && { "94": { text: [count] } }),
    },
  });

  it("the clean splat says how many Gaussians were kept; the still is the poster; the count isn't a file", () => {
    const outs = collectOutputs(history("131072"), getWorkflow("image-to-splat-idol-clean").manifest);
    expect(outs.map((o) => [o.kind, o.meta])).toEqual([
      ["model3d", { role: "splat", format: "spz", pruned: true, kept: 131072 }],
      ["video", { role: "turntable" }],
      ["image", { role: "preview" }],
    ]);
    const view = m3d.model3dView({ outputs: outs as never, request: { op: "splat", inputs: { images: ["/api/files/p.png"] } } as never });
    expect(view.clean).toEqual({ cleaned: true, text: "Cleaned: 131,072 Gaussians kept" });
    expect(view.poster).toBe(outs[2].url);
    expect(view.splat?.format).toBe("spz");
    // No count (an older pack, or an answer that isn't a number): pruned, with nothing to say about it.
    const noCount = collectOutputs(history("n/a"), getWorkflow("image-to-splat-idol-clean").manifest);
    expect(noCount[0].meta).toEqual({ role: "splat", format: "spz", pruned: true });
    expect(m3d.model3dView({ outputs: noCount as never, request: { op: "splat", inputs: {} } as never }).clean).toBeUndefined();
  });

  it("the core graph's splat says it wasn't cleaned; TripoSplat's says nothing", () => {
    const h = { status: { status_str: "success", completed: true }, outputs: { "51": { "3d": [file("gen_00001_.spz")] }, "42": { images: [file("gen_00001_.mp4")], animated: [true] } } };
    const outs = collectOutputs(h, getWorkflow("image-to-splat-idol").manifest);
    expect(outs[0].meta).toEqual({ role: "splat", format: "spz", pruned: false });
    expect(m3d.model3dView({ outputs: outs as never, request: { op: "splat", inputs: {} } as never }).clean).toEqual({ cleaned: false, text: "Not cleaned" });
    const tripo = collectOutputs(h, getWorkflow("image-to-splat-triposplat").manifest);
    expect(tripo[0].meta).toEqual({ role: "splat", format: "spz" });
  });

  it("the studio sends Trim spikes on your GPU only (fal has no pruning)", () => {
    const photo = "/api/files/p.png";
    expect(m3d.model3dRequest({ engine: "open", mode: "splat", photo, modelId: "oss-idol", trimSpikes: true }).params?.extra).toMatchObject({ maxScale: m3d.IDOL_TRIM_SPIKES });
    expect(m3d.model3dRequest({ engine: "open", mode: "splat", photo, modelId: "oss-idol" }).params?.extra).not.toHaveProperty("maxScale");
    expect(m3d.model3dRequest({ engine: "cloud", mode: "splat", photo, modelId: "idol-3d", trimSpikes: true }).params?.extra).toEqual({ num_inference_steps: 50, num_gaussians: 262144, image_type: "synthetic" });
    expect(m3d.model3dRequest({ engine: "open", mode: "splat", photo, trimSpikes: true })).toEqual({ feature: "image-to-3d", modelId: "oss-triposplat", op: "splat", inputs: { images: [photo] } });
  });
});
