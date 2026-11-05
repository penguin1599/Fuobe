import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "./helpers/temp-dir";
import type { Manifest } from "@/lib/comfy";

/**
 * Fill the other sides from one picture (idol-8, docs/research/idol-9.md §8, §9 idol-8): the image-to-views-idol graph
 * (the clean Idol graph up to the pruned splat, then IdolCamera → RenderSplat with frames +4 → one batch of four), the
 * spec entry with its pack, the provider swapping to it when a request asks for views (and saying plainly when the
 * ComfyUI has no ComfyUI-Idol), the index → side mapping, the demo's four pictures, the slots of From several images and
 * the chain into TRELLIS.2 multi-view, and an element's new references.
 */

const dir = tempDir("fuobe-idol-views-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";

const root = process.cwd();
const { setSetting } = await import("@/server/settings");
const { collectOutputs, comfyProvider, getWorkflow, prepareWorkflow } = await import("@/server/providers/comfyui");
const { changeAccess } = await import("@/server/model-access");
const views = await import("@/lib/av/idol-views");
const m3d = await import("@/lib/av/model3d");
const { resolveWorkflowId } = await import("@/lib/comfy-variants");
const { getModel } = await import("@/lib/catalog");
const { isHelperFeature } = await import("@/lib/library");

const manifest = JSON.parse(fs.readFileSync(path.join(root, "workflows", "comfyui", "manifest.json"), "utf8")) as Manifest;
const byId = new Map(manifest.workflows.map((w) => [w.id, w]));
const entry = byId.get("image-to-views-idol")!;
type Node = { class_type: string; inputs: Record<string, unknown> };
const read = (id: string) => JSON.parse(fs.readFileSync(path.join(root, "workflows", "comfyui", `${id}.json`), "utf8")) as Record<string, Node>;
const graph = read("image-to-views-idol");
const clean = read("image-to-splat-idol-clean");

// A stand-in ComfyUI: GET /object_info/<class> (the pack's classes when `pack` is on) and POST /prompt, keeping the graphs.
let pack = true;
const prompts: Record<string, Node>[] = [];
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/prompt") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      prompts.push((JSON.parse(body) as { prompt: Record<string, Node> }).prompt);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ prompt_id: `p-${prompts.length}` }));
    });
    return;
  }
  const m = /^\/object_info\/(\w+)$/.exec(req.url ?? "");
  if (!m) return void res.writeHead(404).end();
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

const PHOTO = "/api/files/front.png";
const viewsExtra = () => views.idolViewsRequest(PHOTO).params!.extra!;
const prepare = (extra: Record<string, unknown>, idolPack?: () => Promise<boolean | undefined>) =>
  prepareWorkflow("image-to-splat-idol", { prompt: "", images: ["p.png"], seed: 7, extra: { ...extra } }, { generationId: "gen-views", op: "splat", upload: async () => "x", idolPack });

describe("image-to-views-idol: the spec, the manifest and the GPU check", () => {
  it("is a hand-built splat entry with the ComfyUI-Idol pack, Idol's bindings and one batch of four images", async () => {
    const spec = await import("../scripts/comfy/library.spec.mjs");
    const e = spec.SPEC.find((s: { id: string }) => s.id === "image-to-views-idol");
    expect(e).toMatchObject({ packs: ["ComfyUI-Idol"], capability: "splat", handBuilt: "hand-built/image-to-views-idol.json", vramGb: 8 });
    expect(Object.keys(e.bindings).sort()).toEqual(["cfg", "cropMode", "cutout", "image", "maxScale", "minOpacity", "numGaussians", "sampler", "seed", "steps"]);
    expect(entry.customNodes).toEqual([{ name: "ComfyUI-Idol", repo: "https://github.com/Nynxz/ComfyUI-Idol/tree/4d3a4f671028f0e062d9f004cda1a2dd73360d35" }]);
    expect(entry.outputs).toEqual([{ node: "96", kind: "image", role: "tiles" }]);
    expect(entry.defaults).toMatchObject({ steps: 50, cfg: 4, numGaussians: 262144, cutout: true, cropMode: "synthetic", minOpacity: 0.05, maxScale: 0 });
    // Same weights (and sizes) as Idol 3D's other graphs; the licence is the clean graph's.
    expect(entry.models).toEqual(byId.get("image-to-splat-idol-clean")!.models);
    expect(entry.license).toBe(byId.get("image-to-splat-idol-clean")!.license);
    expect(entry.bindings.image).toEqual([{ node: "99", input: "image" }]);
    expect(entry.bindings.cropMode).toEqual([{ node: "88:110", input: "mode" }]);
  });

  it("is in the GPU pre-flight's index with the pack's three classes", () => {
    const req = JSON.parse(fs.readFileSync(path.join(root, "workflows", "comfyui", "requirements.json"), "utf8"));
    const w = req.workflows["image-to-views-idol"];
    expect(w.packs).toEqual({ "ComfyUI-Idol": ["IdolCamera", "IdolPreprocessImage", "IdolPruneSplat"] });
    expect(w.files).toEqual(req.workflows["image-to-splat-idol-clean"].files);
    expect(w.core).toContain("RenderSplat");
    expect(w.core).not.toContain("SaveGLB");
  });
});

describe("image-to-views-idol: the graph", () => {
  it("is the clean graph up to the pruned splat, without the file, the orbit video or the still", () => {
    for (const id of ["99", "88:35", "88:110", "88:24", "88:6", "88:16", "88:96", "88:11", "88:55", "88:111", "88:112", "88:7", "88:8", "88:95", "88:85:81", "88:85:82"]) expect(graph[id], id).toEqual(clean[id]);
    for (const id of ["41", "42", "51", "75", "79", "92", "93", "94", "88:113"]) expect(graph[id], id).toBeUndefined();
    expect(graph["88:112"]).toEqual({ class_type: "IdolCamera", inputs: { samples: ["88:6", 0] }, _meta: expect.anything() });
  });

  it("renders the pruned splat from Idol's camera four times, a quarter turn apart toward the object's left, and saves one batch", () => {
    const r = graph["88:120"];
    expect(r.class_type).toBe("RenderSplat");
    expect(r.inputs).toMatchObject({ splat: ["88:111", 0], camera_info: ["88:112", 0], frames: views.IDOL_VIEWS_FRAMES, width: 1024, height: 1024, opacity_threshold: 0.05, render_style: "color", background: "#FFFFFF" });
    // +4, not -4: RenderSplat turns the camera toward the viewer's right for a positive count, and that's the object's left.
    expect(r.inputs.frames).toBeGreaterThan(0);
    expect(graph["96"]).toMatchObject({ class_type: "SaveImage", inputs: { images: ["88:120", 0] } });
    const saves = Object.values(graph).filter((n) => /^Save/.test(n.class_type));
    expect(saves).toHaveLength(1);
  });
});

describe("the side of each view", () => {
  it("index 0 is the front (the input view), then the object's left, back and right, as From several images names them", () => {
    expect([0, 1, 2, 3].map(views.sideOfIndex)).toEqual(["front", "left", "back", "right"]);
    expect(views.IDOL_VIEW_ORDER).toEqual(m3d.VIEW_SIDES);
    expect(views.sideOfIndex(4)).toBeUndefined();
    expect(views.sideOfIndex(-1)).toBeUndefined();
    expect(views.idolViewMeta(1)).toEqual({ index: 1, side: "left" });
    // The page's own words for left and right: the object's, walking round to your right for its left.
    expect(m3d.SIDES_HINT).toMatch(/walk round to your right for its left side/);
  });

  it("the provider names each image of the batch by its side", () => {
    const f = (n: number) => ({ filename: `idol_0000${n}_.png`, subfolder: "fuobe", type: "output" });
    const outs = collectOutputs({ status: { status_str: "success", completed: true }, outputs: { "96": { images: [f(1), f(2), f(3), f(4)] } } }, getWorkflow("image-to-views-idol").manifest);
    expect(outs.map((o) => o.meta)).toEqual([
      { role: "tiles", index: 0, side: "front" },
      { role: "tiles", index: 1, side: "left" },
      { role: "tiles", index: 2, side: "back" },
      { role: "tiles", index: 3, side: "right" },
    ]);
    expect(views.idolViewsOf(outs as never)).toEqual({ front: outs[0].url, left: outs[1].url, back: outs[2].url, right: outs[3].url });
  });

  it("idolViewsOf reads meta.side, else meta.index, else the order of the images", () => {
    const img = (url: string, meta?: Record<string, unknown>) => ({ url, kind: "image" as const, meta });
    expect(views.idolViewsOf([img("a", { side: "back" }), img("b", { index: 1 }), img("c")])).toEqual({ back: "a", left: "b" });
    expect(views.idolViewsOf([img("a"), img("b"), img("c"), img("d")])).toEqual({ front: "a", left: "b", back: "c", right: "d" });
    expect(views.idolViewsOf([{ url: "v", kind: "video" as const }, img("a")])).toEqual({ front: "a" });
  });
});

describe("the provider: the view graph when a request asks for the views", () => {
  it("resolveWorkflowId swaps either Idol graph to the view graph only when asked and only when the library has it", () => {
    const r = (extra: Record<string, unknown>, has = true) => resolveWorkflowId("image-to-splat-idol", { op: "splat", clips: 0, images: 1, audio2: false, audio: false, extra, has: () => has });
    expect(r({ idolViews: true })).toBe("image-to-views-idol");
    expect(r({})).toBe("image-to-splat-idol");
    expect(r({ idolViews: "yes" })).toBe("image-to-splat-idol");
    expect(r({ idolViews: true }, false)).toBe("image-to-splat-idol");
    expect(resolveWorkflowId("image-to-splat-triposplat", { op: "splat", clips: 0, images: 1, audio2: false, audio: false, extra: { idolViews: true }, has: () => true })).toBe("image-to-splat-triposplat");
  });

  it("runs image-to-views-idol with Idol's Best settings and the photo's crop, and binds nothing it doesn't take", async () => {
    const p = await prepare({ ...views.idolViewsRequest(PHOTO, { asPhoto: true }).params!.extra! }, async () => true);
    expect(p.manifest.id).toBe("image-to-views-idol");
    expect(p.workflow["88:110"].inputs.mode).toBe("real");
    expect(p.workflow["88:6"].inputs).toMatchObject({ steps: 50, cfg: 4, sampler_name: "euler", seed: 7 });
    expect(p.workflow["88:55"].inputs.num_gaussians).toBe(262144);
    expect(p.workflow["88:120"].inputs.frames).toBe(4);
    const generated = await prepare({ ...views.idolViewsRequest(PHOTO, { asPhoto: false }).params!.extra! }, async () => true);
    expect(generated.workflow["88:110"].inputs.mode).toBe("synthetic");
  });

  it("says plainly that the views need the pack when the ComfyUI hasn't got it (or it's switched off)", async () => {
    await expect(prepare(viewsExtra(), async () => false)).rejects.toThrow(views.IDOL_VIEWS_NEEDS_PACK);
    // Unknown (someone's computer, no answer): their ComfyUI has the last word.
    expect((await prepare(viewsExtra(), async () => undefined)).manifest.id).toBe("image-to-views-idol");
  });

  it("leaves an ordinary Idol 3D run as it was", async () => {
    expect((await prepare(m3d.idolExtra("open", "best", false), async () => true)).manifest.id).toBe("image-to-splat-idol-clean");
    expect((await prepare(m3d.idolExtra("open", "best", false), async () => false)).manifest.id).toBe("image-to-splat-idol");
  });
});

describe("the provider's submit", () => {
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
  const submit = (generationId: string) => comfyProvider.submit({ generationId, model, route, input: { prompt: "", images: ["p.png"], seed: 7, extra: viewsExtra() } });

  it("sends the view graph where the server has the pack, and refuses before /prompt where Settings switched it off", async () => {
    pack = true;
    prompts.length = 0;
    const res = await submit("gen-v1");
    expect(res.meta).toMatchObject({ workflowId: "image-to-views-idol" });
    expect(Object.values(prompts.at(-1)!).some((n) => n.class_type === "IdolCamera")).toBe(true);
    expect(prompts.at(-1)!["88:120"].inputs.frames).toBe(4);
    changeAccess([{ kind: "pack", id: "ComfyUI-Idol", on: false }]);
    const before = prompts.length;
    await expect(submit("gen-v2")).rejects.toThrow(views.IDOL_VIEWS_NEEDS_PACK);
    expect(prompts.length).toBe(before);
    changeAccess([{ kind: "pack", id: "ComfyUI-Idol", on: true }]);
  });
});

describe("the request, the slots and the chain into TRELLIS.2 multi-view", () => {
  it("is Idol 3D on your GPU, a helper job kept out of the Library", () => {
    const req = views.idolViewsRequest(PHOTO);
    expect(req).toMatchObject({ modelId: "oss-idol", op: "splat", inputs: { images: [PHOTO] }, feature: views.IDOL_VIEWS_FEATURE });
    expect(req.params?.extra).toMatchObject({ idolViews: true, photoCrop: true, steps: 50, numGaussians: 262144 });
    expect(isHelperFeature(req.feature)).toBe(true);
    expect(views.wantsIdolViews(req.params?.extra)).toBe(true);
    expect(views.wantsIdolViews({})).toBe(false);
  });

  it("offers the button with only the front filled", () => {
    expect(views.canMakeOtherSides({ front: "f" })).toBe(true);
    expect(views.canMakeOtherSides({ front: "f", left: null, back: undefined })).toBe(true);
    expect(views.canMakeOtherSides({})).toBe(false);
    expect(views.canMakeOtherSides({ front: "f", back: "b" })).toBe(false);
  });

  it("fills the left, back and right slots and never replaces a photo the person brought", () => {
    const made = { front: "v0", left: "v1", back: "v2", right: "v3" };
    const slot = (url: string, side: string) => ({ ref: url, side });
    const filled = views.fillOtherSides({ front: { ref: "mine", side: "front" } }, made, slot);
    expect(filled).toEqual({ front: { ref: "mine", side: "front" }, left: { ref: "v1", side: "left" }, back: { ref: "v2", side: "back" }, right: { ref: "v3", side: "right" } });
    const kept = views.fillOtherSides({ front: { ref: "mine", side: "front" }, back: { ref: "my-back", side: "back" } }, made, slot);
    expect(kept.back).toEqual({ ref: "my-back", side: "back" });
    expect(kept.left?.ref).toBe("v1");
    // A run that came back short fills what it has.
    expect(views.fillOtherSides({ front: { ref: "mine", side: "front" } }, { front: "v0", left: "v1" }, slot)).toEqual({ front: { ref: "mine", side: "front" }, left: { ref: "v1", side: "left" } });
  });

  it("the filled slots go to oss-trellis2-multi in VIEW_SIDES order, with each photo's side named", () => {
    const made = { front: "v0", left: "/api/files/l.png", back: "/api/files/b.png", right: "/api/files/r.png" };
    const slots = views.fillOtherSides({ front: PHOTO }, made, (u) => u);
    const req = m3d.model3dRequest({ engine: "open", mode: "multi", views: slots as never });
    expect(req.modelId).toBe("oss-trellis2-multi");
    expect(req.inputs?.images).toEqual([PHOTO, made.left, made.back, made.right]);
    expect(req.params?.extra).toEqual({ views: ["front", "left", "back", "right"] });
    expect(m3d.model3dBlocker({ engine: "open", mode: "multi", views: slots as never })).toBeNull();
    // The person's own photos still go as they did.
    const own = m3d.model3dRequest({ engine: "open", mode: "multi", views: { front: PHOTO, back: "/api/files/my-back.png" } });
    expect(own.inputs?.images).toEqual([PHOTO, "/api/files/my-back.png"]);
    expect(own.params?.extra).toEqual({ views: ["front", "back"] });
  });

  it("a view run belongs to its front picture for the tab, so the button picks it up again and a new front never gets it", () => {
    expect(views.viewRunFor("/api/files/front-a.png")).toBeUndefined();
    views.rememberViewRun("/api/files/front-a.png", "run-1");
    expect(views.viewRunFor("/api/files/front-a.png")).toBe("run-1");
    expect(views.viewRunFor("/api/files/front-b.png")).toBeUndefined();
    // A newer run for the same picture replaces it; an older run's handover doesn't forget the newer one.
    views.rememberViewRun("/api/files/front-a.png", "run-2");
    views.forgetViewRun("/api/files/front-a.png", "run-1");
    expect(views.viewRunFor("/api/files/front-a.png")).toBe("run-2");
    views.forgetViewRun("/api/files/front-a.png", "run-2");
    expect(views.viewRunFor("/api/files/front-a.png")).toBeUndefined();
  });

  it("an element gets the left, back and right views it hasn't got yet", () => {
    const made = { front: "v0", left: "v1", back: "v2", right: "v3" };
    expect(views.elementViews(made)).toEqual(["v1", "v2", "v3"]);
    expect(views.elementViews(made, ["v2"])).toEqual(["v1", "v3"]);
    expect(views.elementViews({ front: "v0" })).toEqual([]);
  });
});

describe("demo mode", () => {
  it("the placeholder answers an Idol views run with four labelled pictures, front first", async () => {
    const { mockProvider } = await import("@/server/providers/mock");
    const model = getModel("oss-idol")!;
    const route = model.routes[0];
    const sub = await mockProvider.submit({ route, input: { prompt: "", images: [PHOTO], extra: viewsExtra() }, generationId: "g", model } as never);
    expect(sub.meta?.idolViews).toBe(true);
    const done = await mockProvider.poll({ externalId: sub.externalId, meta: { ...sub.meta, startedAt: 0 }, model, route } as never);
    expect(done.state).toBe("succeeded");
    const outs = (done as { outputs: { kind: string; url: string; meta?: Record<string, unknown> }[] }).outputs;
    expect(outs.map((o) => [o.kind, o.meta?.index, o.meta?.side])).toEqual([
      ["image", 0, "front"],
      ["image", 1, "left"],
      ["image", 2, "back"],
      ["image", 3, "right"],
    ]);
    // An ordinary splat run is unchanged.
    const plain = await mockProvider.submit({ route, input: { prompt: "", images: [PHOTO], extra: m3d.idolExtra("open") }, generationId: "g2", model } as never);
    expect(plain.meta?.idolViews).toBe(false);
  });
});

describe("the GPU pre-flight board", () => {
  it("has a row for the other sides that needs the view graph (and so the ComfyUI-Idol pack)", async () => {
    const { STUDIO_ROWS, studioTool } = await import("@/server/gpu/tools");
    const row = STUDIO_ROWS.find((r) => r.href === "/image-to-3d?mode=multi")!;
    expect(row).toMatchObject({ label: "Other sides from one picture", group: "Images" });
    expect(studioTool(row)).toMatchObject({ ref: "studio:/image-to-3d?mode=multi", kind: "image", workflows: ["image-to-views-idol"], loras: [] });
    expect(new Set(STUDIO_ROWS.map((r) => r.href)).size).toBe(STUDIO_ROWS.length);
  });
});
