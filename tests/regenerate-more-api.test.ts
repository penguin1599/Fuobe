import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { tempDir } from "./helpers/temp-dir";
import type { Generation, GenerationRequest, GenInput } from "@/lib/catalog/types";

// Regenerate in Faceless, video segments and Cinema H3 shots (package n7-10-regenerate-more): MiniMax H3's 2K tier on your
// GPU (a 768p draft that keeps its latent, then the 2K finish from it), Finish in 2K on a take, Cinema's tiers, Edit video's
// Enhance with RIFE first for a 16 fps clip, and what an account may read.
vi.setConfig({ testTimeout: 120_000 });
// Regenerate is switched off for now (REGEN_OFFERED); these tests check it as it runs once switched on.
// tests/regenerate-offered.test.ts checks that nothing offers it while it is off.
vi.mock("@/lib/catalog/regenerate", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/catalog/regenerate")>()), REGEN_OFFERED: true }));

const dir = tempDir("fuobe-regen-more-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";
delete process.env.FUOBE_PASSWORD;

const R = await import("@/lib/catalog/regenerate");
const { getModel } = await import("@/lib/catalog");
const { resolveWorkflowId } = await import("@/lib/comfy-variants");
const { videoResolutionsFor, planCinema, H3_2K_OPEN_NOTE } = await import("@/lib/catalog/cinema");
const { outputActions } = await import("@/lib/output-actions");
const { isH3Graph } = await import("@/lib/h3-prompt");
const { prepareWorkflow, getWorkflow } = await import("@/server/providers/comfyui");
const { setSetting } = await import("@/server/settings");
const gens = await import("@/server/generations");
const { createRegenerateRun } = await import("@/server/regenerate");
const { saveFile } = await import("@/server/storage");
const { db } = await import("@/server/db");
const { runAsTenant } = await import("@/server/tenant");
const cinema = await import("@/server/cinema");
const mk = await import("@/server/marketing");
const { pickerData } = await import("@/lib/catalog/faceless");
const { settingsShape } = await import("@/lib/composer");
const { accessList, knownSwitch, readAccess, saveAccess } = await import("@/server/model-access");
const { GenerationRequestSchema } = await import("@/server/request-schema");
const finishRoute = await import("@/app/api/cinema/projects/[id]/items/[generationId]/finish/route");

const ROOT = path.resolve(__dirname, "..");
const read = (id: string) => JSON.parse(fs.readFileSync(path.join(ROOT, `workflows/comfyui/${id}.json`), "utf8")) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const at = (wf: Record<string, { inputs: Record<string, unknown> }>, node: string, input: string) => wf[node]?.inputs[input];
const json = (method: string, body?: unknown) => new Request("http://x/api", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) }) as never;
// A 12 s clip at 16 fps (a Wan restyle's rate).
const sixteen = (accountId?: string) => saveFile({ data: fs.readFileSync(path.join(__dirname, "fixtures/shorts-12s.mp4")), contentType: "video/mp4", source: "upload", name: "edit.mp4", ...(accountId && { accountId }) }).url;

beforeAll(() => setSetting("demoMode", "auto"));

async function settle(id: string, ms = 60_000): Promise<Generation> {
  const end = Date.now() + ms;
  for (;;) {
    const g = gens.getGeneration(id)!;
    if (["succeeded", "failed", "canceled"].includes(g.status)) return g;
    if (Date.now() > end) throw new Error(`timed out: ${g.status}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("the 768p draft that keeps its latent, and the 2K finish from it", () => {
  const draft = read(R.H3_LATENT_DRAFT_WORKFLOW);
  const finish = read(R.REGEN_LATENT_WORKFLOW);

  it("is rdh's Prompt to 2K draft: FL2VA int8 + Turbo 4-step v1.2, 6 steps er_sde, the latent saved before the decode", () => {
    expect(at(draft, "2", "unet_name")).toBe("minimax_h3_fl2va_pruned_int8_convrot.safetensors");
    expect(draft["9"].class_type).toBe("LoraLoaderModelOnly");
    expect(at(draft, "9", "lora_name")).toBe("minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors");
    expect(draft["10"].class_type).toBe("MiniMaxH3ImageToVideo");
    expect([at(draft, "13", "scheduler"), at(draft, "13", "steps")]).toEqual(["simple", 6]);
    expect(at(draft, "12", "sampler_name")).toBe("er_sde");
    expect(draft["20"].class_type).toBe("OpenH3SaveRefinedLatent");
    expect(at(draft, "20", "samples")).toEqual(["15", 0]);
    expect(at(draft, "16", "samples")).toEqual(["20", 0]);
    expect(at(draft, "20", "audio")).toEqual(["17", 0]);
    expect(isH3Graph(R.H3_LATENT_DRAFT_WORKFLOW)).toBe(true);
  });

  it("finishes from that latent: no clip loaded, its frame count and sound carried to Finish", () => {
    const classes = Object.values(finish).map((n) => n.class_type);
    expect(classes).not.toContain("LoadVideo");
    expect(classes).not.toContain("VAEEncode");
    expect(finish["1"].class_type).toBe("OpenH3LoadRefinedLatent");
    expect(at(finish, "17", "latent")).toEqual(["1", 0]);
    expect(at(finish, "26", "frame_count")).toEqual(["1", 1]);
    expect(at(finish, "26", "audio")).toEqual(["1", 2]);
    expect(at(finish, "3", "curve_name")).toBe("none");
  });

  it("hands the latent over by name: the draft saves under its run's id, the finish loads that file", async () => {
    const d = await prepareWorkflow(R.H3_LATENT_DRAFT_WORKFLOW, { prompt: "a lighthouse in a storm", aspectRatio: "16:9", duration: 5, seed: 7, extra: { latentDraft: true } } as GenInput, {
      generationId: "draftAbc123",
      op: "t2v",
      upload: async (_d, _t, name) => `up_${name}`,
    });
    expect(at(d.workflow, "20", "filename_prefix")).toBe("fuobe_h3_draftAbc123");
    expect(at(d.workflow, "10", "length")).toBe(124);
    expect([at(d.workflow, "10", "width"), at(d.workflow, "10", "height")]).toEqual([1344, 768]);
    const f = await prepareWorkflow(R.REGEN_LATENT_WORKFLOW, { prompt: "a lighthouse in a storm", resolution: "1440p", seed: 3, extra: { latentFrom: "draftAbc123", draftFrom: "h3", startSigma: 0.8 } } as GenInput, {
      generationId: "fin1",
      op: "upscale-video",
      upload: async (_d, _t, name) => `up_${name}`,
    });
    expect(at(f.workflow, "1", "latent_file")).toBe("fuobe_h3_draftAbc123_00001.safetensors");
    expect(at(f.workflow, "17", "resolution")).toBe("2k (2560x1440)");
    expect(at(f.workflow, "19", "start_sigma")).toBe(0.8);
    await expect(prepareWorkflow(R.REGEN_LATENT_WORKFLOW, { prompt: "x", resolution: "1440p" } as GenInput, { generationId: "f2", op: "upscale-video", upload: async () => "u" })).rejects.toThrow(/no saved draft/);
  });

  it("picks the graphs by the run's flags, so the GPU pre-flight checks the graph that runs", () => {
    const req = (extra: Record<string, unknown>, op = "t2v") => ({ op, clips: 0, images: 0, audio2: false, extra, has: () => true });
    expect(resolveWorkflowId("minimax-h3-t2v", req({ latentDraft: true }))).toBe("video-h3-t2v-2k");
    expect(resolveWorkflowId("minimax-h3-t2v", req({ latentDraft: true, quality: "best" }))).toBe("video-h3-t2v-2k");
    expect(resolveWorkflowId("minimax-h3-t2v", req({}))).toBe("minimax-h3-t2v");
    expect(resolveWorkflowId("video-regenerate-h3", req({ latentFrom: "g1" }, "upscale-video"))).toBe("video-regenerate-h3-latent");
    expect(resolveWorkflowId("video-regenerate-h3", req({}, "upscale-video"))).toBe("video-regenerate-h3");
    expect(R.regenerateGraphLoras(R.REGEN_LATENT_WORKFLOW)).toEqual([R.REGEN_LORA]);
    // The draft that keeps its latent loads the Turbo 4-step LoRA itself, so a run downloads it (or an account's GPU is
    // checked for it) like the refiner.
    expect(R.regenerateGraphLoras(R.H3_LATENT_DRAFT_WORKFLOW)).toEqual([R.H3_TURBO_4STEP_LORA]);
    expect(R.regenerateGraphLoras("minimax-h3-t2v", { latentDraft: true })).toEqual([R.H3_TURBO_4STEP_LORA]);
    expect(R.regenerateGraphLoras("minimax-h3-t2v", {})).toEqual([]);
  });

  it("has a row on the GPU pre-flight board with both graphs and the refiner LoRA", async () => {
    const { STUDIO_ROWS, studioTool } = await import("@/server/gpu/tools");
    const row = STUDIO_ROWS.find((r) => r.label === "MiniMax H3 in 2K")!;
    const tool = studioTool(row)!;
    expect(tool.workflows).toEqual([R.H3_LATENT_DRAFT_WORKFLOW, R.REGEN_LATENT_WORKFLOW]);
    expect(tool.loras.map((l) => l.file)).toEqual(expect.arrayContaining([R.REGEN_LORA.file, R.H3_TURBO_4STEP_LORA.file]));
  });

  it("pins the Turbo 4-step v1.2 file at 3ec17a3 with its size and SHA-256", () => {
    const pins = JSON.parse(fs.readFileSync(path.join(ROOT, "workflows/comfyui/model-pins.json"), "utf8"));
    const url = "https://huggingface.co/lightx2v/Minimax-h3-Turbo/resolve/3ec17a324ced54151364f24f8b5fb6bf7e26414f/minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors";
    expect(pins[url]).toEqual({ revision: "3ec17a324ced54151364f24f8b5fb6bf7e26414f", sizeBytes: 1956193000, sha256: "c8168ebc17bbacc4296103dda2fec1ba85b24392fa08cf2bfbcef0cff0dc3cc8" });
    const { manifest } = getWorkflow(R.H3_LATENT_DRAFT_WORKFLOW);
    expect(manifest.validated).toBe(false);
    expect(manifest.license).toMatch(/Turbo 4-step v1\.2 LoRA Apache-2\.0/);
  });
});

describe("MiniMax H3 at 2K on your GPU", () => {
  it("drafts each take at 768p, then finishes it in 2K: from its latent for text to video, from the clip for a start frame", () => {
    const made = gens.createGenerations({ feature: "cinema", modelId: "oss-minimax-h3", op: "t2v", prompt: "A lighthouse in a storm", params: { resolution: "2K", duration: 5, numOutputs: 2 } });
    expect(made).toHaveLength(4);
    const [f1, f2, d1, d2] = made;
    for (const [f, d] of [
      [f1, d1],
      [f2, d2],
    ]) {
      expect(d).toMatchObject({ modelId: "oss-minimax-h3", op: "t2v" });
      expect(d.request.params).toMatchObject({ resolution: "768p", numOutputs: 1, extra: { latentDraft: true } });
      expect(f).toMatchObject({ modelId: R.REGEN_MODEL, op: "upscale-video" });
      expect(f.request.params).toMatchObject({ resolution: "1440p", extra: { startSigma: 0.8, draftFrom: "h3" } });
      // The latent to load is decided when the finish starts, from the draft it waits for (never an id stored now).
      expect(f.request.params?.extra?.latentFrom).toBeUndefined();
      expect(f.request.finishOf).toBe(d.id);
      expect(f.request.prompt).toBe("A lighthouse in a storm");
    }
    const png = saveFile({ data: Buffer.from("89504e470d0a1a0a", "hex"), contentType: "image/png", source: "upload" }).url;
    const [f, d] = gens.createGenerations({ feature: "video", modelId: "oss-minimax-h3", op: "i2v", prompt: "She turns", inputs: { images: [png] }, params: { resolution: "2K", duration: 5 } });
    expect(d.request.params?.extra?.latentDraft).toBeUndefined();
    expect(f.request.params?.extra).toMatchObject({ draftFrom: "h3" });
    expect(f.request.params?.extra?.latentFrom).toBeUndefined();
    // 768p stays a single run.
    expect(gens.createGenerations({ feature: "video", modelId: "oss-minimax-h3", op: "t2v", prompt: "x", params: { resolution: "768p", duration: 5 } })).toHaveLength(1);
  });

  it("drafts a Fast · Pika Flex take on Flex's graph with Pika's adapter, and finishes it from its clip", async () => {
    const { pikaFlexGraphLoras, PIKA_FLEX_FL2VA } = await import("@/lib/catalog/pika-flex");
    const asked: GenerationRequest = { feature: "video", modelId: "oss-minimax-h3", op: "t2v", prompt: "A lighthouse in a storm", params: { resolution: "2K", duration: 5, extra: { quality: "flex" } } };
    const { draft, fromLatent } = R.h3TwoKRequests(asked, "t2v", { keepLatent: true });
    expect(fromLatent).toBe(false);
    const extra = draft.params!.extra!;
    expect(extra).toEqual({ quality: "flex" });
    const req = { op: "t2v", clips: 0, images: 0, audio2: false, extra, has: () => true };
    expect(resolveWorkflowId("minimax-h3-t2v", req)).toBe("minimax-h3-flex-t2v");
    // The run downloads (or an account's GPU is checked for) the adapter the graph loads, never the Turbo 4-step LoRA.
    expect(pikaFlexGraphLoras("minimax-h3-t2v", extra)).toEqual([PIKA_FLEX_FL2VA]);
    expect(R.regenerateGraphLoras("minimax-h3-t2v", extra)).toEqual([]);
    const [f, d] = gens.createGenerations(asked);
    expect(d.request.params).toMatchObject({ resolution: "768p", extra: { quality: "flex" } });
    expect(d.request.params?.extra?.latentDraft).toBeUndefined();
    expect(f.request.params?.extra).toMatchObject({ draftFrom: "h3" });
    expect(f.request.params?.extra?.latentFrom).toBeUndefined();
  });

  it("offers 2K in Cinema only for MiniMax H3 models, and says how your GPU makes it", () => {
    for (const id of ["minimax-h3", "oss-minimax-h3", "minimax-h3-max"]) expect(videoResolutionsFor(getModel(id)), id).toContain("2K");
    for (const id of ["fuobe-cinema", "kling-4", "seedance-2-5", "oss-ltx25", "oss-wan22-14b", "veo-3-1"]) expect(videoResolutionsFor(getModel(id)), id).toEqual(["480p", "720p", "1080p"]);
    const ctx = { cloudAllowed: true, has: () => true, civitai: false };
    const base = { mode: "video" as const, prompt: "A lighthouse in a storm", aspectRatio: "16:9", duration: 5, batch: 1, settings: { genre: "general", camera: "", lens: "", focal: "", aperture: "", style: "" } };
    const open = planCinema({ ...base, engine: "open", modelId: "oss-minimax-h3", resolution: "2K" } as never, ctx as never);
    expect(open.steps[0].request.params?.resolution).toBe("2K");
    expect(open.notes).toContain(H3_2K_OPEN_NOTE);
    const cloud = planCinema({ ...base, engine: "cloud", modelId: "minimax-h3", resolution: "2K" } as never, ctx as never);
    expect(cloud.steps[0].request.params?.resolution).toBe("2K");
    expect(cloud.costUsd).toBeCloseTo(0.65, 2);
    const ltx = planCinema({ ...base, engine: "open", modelId: "oss-ltx25", resolution: "2K" } as never, ctx as never);
    expect(ltx.steps[0].request.params?.resolution).toBe("1080p");
    expect(ltx.notes).not.toContain(H3_2K_OPEN_NOTE);
  });
});

describe("Finish in 2K", () => {
  const take = (over: Partial<Generation>): Generation =>
    ({
      id: "take1",
      feature: "cinema",
      modelId: "oss-minimax-h3",
      engine: "open",
      provider: "comfyui",
      op: "t2v",
      kind: "video",
      status: "succeeded",
      request: { feature: "cinema", modelId: "oss-minimax-h3", prompt: "A lighthouse", params: { resolution: "768p", duration: 5 } },
      outputs: [{ url: "/api/files/take.mp4", kind: "video" }],
      ...over,
    }) as Generation;

  it("redraws a take from your GPU for free (from its latent when it kept one) and re-renders a fal take at $0.13/s", () => {
    const open = R.finishIn2k(take({}), "both")!;
    expect(open.perSecond).toBeNull();
    expect(open.request).toMatchObject({ modelId: R.REGEN_MODEL, inputs: { video: "/api/files/take.mp4" }, params: { resolution: "1440p", extra: { startSigma: 0.8 } } });
    expect(open.request.params?.extra?.latentFrom).toBeUndefined();
    const kept = R.finishIn2k(take({ request: { feature: "cinema", modelId: "oss-minimax-h3", prompt: "A", params: { resolution: "768p", extra: { latentDraft: true } } } }))!;
    expect(kept.request.params?.extra).toMatchObject({ latentFrom: "take1", draftFrom: "h3" });
    const fal = R.finishIn2k(take({ engine: "cloud", provider: "fal", modelId: "minimax-h3", request: { feature: "cinema", modelId: "minimax-h3", prompt: "A", params: { resolution: "768P" } } }), "both")!;
    expect(fal.perSecond).toBe(0.13);
    expect(fal.request.params?.resolution).toBe("2K");
    // Not for a take already at 2K, a non-H3 take, Paid APIs only (your GPU), or Open source only (a paid render).
    expect(R.finishIn2k(take({ request: { feature: "cinema", modelId: "oss-minimax-h3", params: { resolution: "2K" } } }))).toBeNull();
    expect(R.finishIn2k(take({ modelId: "oss-ltx25" }))).toBeNull();
    expect(R.finishIn2k(take({}), "cloud")).toBeNull();
    expect(R.finishIn2k(take({ engine: "cloud", provider: "fal", modelId: "minimax-h3" }), "open")).toBeNull();
  });

  it("puts the 2K take beside the first one in its Cinema project", async () => {
    const project = cinema.createProject({ name: "Storm" });
    const [g] = gens.createGenerations({ feature: "cinema", modelId: "oss-minimax-h3", op: "t2v", prompt: "A lighthouse in a storm", params: { resolution: "768p", duration: 5 } });
    cinema.addItems(project.id, [g.id]);
    expect(await settle(g.id)).toMatchObject({ status: "succeeded" });
    const res = await finishRoute.POST(json("POST"), params({ id: project.id, generationId: g.id }));
    expect(res.status).toBe(201);
    const { items } = await res.json();
    expect(items[0]).toMatchObject({ modelId: R.REGEN_MODEL, request: { params: { resolution: "1440p" } } });
    expect(cinema.listItems(project.id).map((x) => x.id)).toEqual(expect.arrayContaining([g.id, items[0].id]));
    const again = await finishRoute.POST(json("POST"), params({ id: project.id, generationId: items[0].id }));
    expect(again.status).toBe(422);
    expect((await finishRoute.POST(json("POST"), params({ id: project.id, generationId: "nope" }))).status).toBe(404);
    // Once per take: a second Finish in 2K is refused while the first is under way or made.
    const twice = await finishRoute.POST(json("POST"), params({ id: project.id, generationId: g.id }));
    expect(twice.status).toBe(409);
    expect((await twice.json()).error).toBe("This take already has a 2K finish");
    expect(R.finishedTakes(cinema.listItems(project.id))).toEqual(new Set([g.id]));
  });

  it("answers a repeated request id with the first finish, and offers it again once that finish failed", async () => {
    const project = cinema.createProject({ name: "Harbour" });
    const [g] = gens.createGenerations({ feature: "cinema", modelId: "oss-minimax-h3", op: "t2v", prompt: "A harbour at dawn", params: { resolution: "768p", duration: 5 } });
    cinema.addItems(project.id, [g.id]);
    expect(await settle(g.id)).toMatchObject({ status: "succeeded" });
    const send = () => finishRoute.POST(json("POST", { requestId: "finish-nonce-0001" }), params({ id: project.id, generationId: g.id }));
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status]).toEqual([201, 201]);
    const [first, second] = [(await a.json()).items, (await b.json()).items];
    expect(second.map((x: Generation) => x.id)).toEqual(first.map((x: Generation) => x.id));
    expect(first[0].request.finishOf).toBe(g.id);
    expect((await finishRoute.POST(json("POST", { requestId: "../x" }), params({ id: project.id, generationId: g.id }))).status).toBe(400);
    // A finish that failed doesn't count.
    db().prepare("UPDATE generations SET status = 'failed' WHERE id = ?").run(first[0].id);
    expect((await finishRoute.POST(json("POST", { requestId: "finish-nonce-0002" }), params({ id: project.id, generationId: g.id }))).status).toBe(201);
  });

  it("isn't offered on a 2K run's own 768p draft", () => {
    const made = gens.createGenerations({ feature: "cinema", modelId: "oss-minimax-h3", op: "t2v", prompt: "A lighthouse", params: { resolution: "2K", duration: 5 } });
    const draft = made.find((x) => x.modelId === "oss-minimax-h3")!;
    expect(R.finishedTakes(made)).toEqual(new Set([draft.id]));
  });
});

describe("Edit video · Enhance (H3 regenerate)", () => {
  const edit = (over: Partial<Generation> = {}): Generation =>
    ({
      id: "e1",
      feature: "video-edit",
      modelId: "fuobe-mixed-media",
      engine: "open",
      provider: "comfyui",
      op: "v2v",
      kind: "video",
      status: "succeeded",
      request: { feature: "video-edit", modelId: "fuobe-mixed-media", prompt: "make it snow", params: { duration: 5 } },
      outputs: [{ url: "/api/files/edit.mp4", kind: "video" }],
      ...over,
    }) as Generation;

  it("is offered on Edit video results up to 15 s, hidden by Paid APIs only", () => {
    const ids = (g: Generation, mode?: "both" | "open" | "cloud") => outputActions(g, 0, { engineMode: mode }).map((a) => a.id);
    expect(ids(edit(), "both")).toContain("enhance-h3");
    expect(ids(edit(), "cloud")).not.toContain("enhance-h3");
    expect(ids(edit({ request: { feature: "video-edit", modelId: "x", params: { duration: 20 } } }), "both")).not.toContain("enhance-h3");
    expect(ids(edit({ feature: "video" }), "both")).not.toContain("enhance-h3");
    expect(R.enhanceRequest(edit(), "/api/files/edit.mp4")).toMatchObject({ modelId: R.REGEN_MODEL, prompt: "make it snow", params: { resolution: "1080p", extra: { startSigma: 0.8 } } });
  });

  it("brings a 16 fps clip to 24 fps with RIFE first, then redraws RIFE's clip", () => {
    const clip = sixteen();
    const made = gens.createGenerations({ ...R.enhanceRequest(edit(), clip) });
    const rife = made.find((g) => g.modelId === R.REGEN_SMOOTH_MODEL)!;
    const regen = made.find((g) => g.modelId === R.REGEN_MODEL)!;
    expect(rife).toMatchObject({ op: "interpolate", request: { inputs: { video: clip }, params: { targetFps: 24 } } });
    expect(regen.request.chain).toEqual([{ slot: "video" }]);
    expect(regen.request.inputs?.video).toBeUndefined();
    expect(made[0].id).toBe(regen.id);
  });

  it("reads the frame rate only from the asker's own files", () => {
    const ownersClip = sixteen();
    const mine = sixteen("acct-a");
    const model = getModel(R.REGEN_MODEL)!;
    const run = (video: string) => {
      const asked: GenerationRequest[] = [];
      const fake = (r: GenerationRequest) => {
        asked.push(r);
        return [{ id: `g${asked.length}`, notes: [] } as unknown as Generation];
      };
      createRegenerateRun({ feature: "video-edit", modelId: R.REGEN_MODEL, prompt: "x", inputs: { video }, params: { resolution: "1080p" } }, model, {}, fake, () => ({ id: "j" }) as Generation, () => {});
      return asked.map((r) => r.modelId);
    };
    runAsTenant({ kind: "account", id: "acct-a" }, () => {
      expect(run(mine)).toEqual([R.REGEN_SMOOTH_MODEL, R.REGEN_MODEL]);
      // The owner's file: no header is read, so nothing about it shapes the run (the route refuses the input itself).
      expect(run(ownersClip)).toEqual([R.REGEN_MODEL]);
    });
    runAsTenant({ kind: "account", id: "acct-b" }, () => expect(run(mine)).toEqual([R.REGEN_MODEL]));
  });
});

describe("2K stays where it is offered (review 1)", () => {
  const h3 = () => getModel("oss-minimax-h3")!;

  it("keeps MiniMax H3's own tiers at 768p; only the Video studio and Cinema add the 2K finish", () => {
    expect(h3().options.resolutions).toEqual(["768p"]);
    expect(h3().options.finishTiers).toEqual(["2K"]);
    expect(R.studioResolutions(h3().options)).toEqual(["768p", "2K"]);
    expect(settingsShape(h3(), "t2v", "video", true).resolution).toEqual(["768p", "2K"]);
    expect(videoResolutionsFor(h3())).toContain("2K");
    // A model without finishing tiers keeps its own list as it is.
    const ltx = getModel("oss-ltx25")!;
    expect(R.studioResolutions(ltx.options)).toBe(ltx.options.resolutions);
  });

  it("Ad Multiplier's open hook and CTA stay at 768p whatever quality is asked", () => {
    const frame = saveFile({ data: Buffer.from("89504e470d0a1a0a", "hex"), contentType: "image/png", source: "upload" }).url;
    const clip = saveFile({ data: Buffer.from("89504e470d0a1a0a", "hex"), contentType: "video/mp4", name: "ad.mp4", source: "upload" }).url;
    for (const quality of ["480p", "720p", "1080p"] as const) {
      const plan = mk.planMultiplier({ engine: "open", video: clip, duration: 12, mode: "sections", hook: "Wait for it", cta: "Shop today", quality, firstFrame: frame, lastFrame: frame }, {});
      const clips = plan.steps.filter((x) => x.key === "hook" || x.key === "cta");
      expect(clips.map((x) => x.key)).toEqual(["hook", "cta"]);
      for (const c of clips) expect(c.request).toMatchObject({ modelId: "oss-minimax-h3", params: { resolution: "768p" } });
    }
  });

  it("Faceless's Quality control has no 2K (MiniMax H3 offers one tier there, so no control shows)", () => {
    const open = pickerData(getModel).videoModels.find((m) => m.id === "oss-minimax-h3");
    expect(open?.resolutions).toEqual(["768p"]);
    // (fal's hosted MiniMax H3 renders 2K itself and keeps it, as before.)
    for (const m of pickerData(getModel).videoModels.filter((x) => x.engine === "open")) expect(m.resolutions, m.id).not.toContain("2K");
  });
});

describe("the 2K run's other pieces (review 4 to 8)", () => {
  it("lists the Turbo 4-step v1.2 LoRA in Settings → Models & licences, Apache-2.0 at 3ec17a3, with a switch the draft honours", () => {
    const row = accessList().loras.find((l) => l.file === R.H3_TURBO_4STEP_LORA.file)!;
    expect(row).toMatchObject({ name: "MiniMax H3 FL2V Turbo 4-step v1.2 (lightx2v)", group: "adapter", base: "MiniMax H3", on: true });
    expect(row.licence).toMatchObject({ name: "Apache-2.0", class: "commercial" });
    expect(row.licence.url).toContain("3ec17a324ced54151364f24f8b5fb6bf7e26414f");
    expect(row.licence.note).toMatch(/current card no longer states a licence/);
    expect(knownSwitch("lora", R.H3_TURBO_4STEP_LORA.file)).toBe(true);
    const was = readAccess();
    saveAccess({ ...was, loras: [...was.loras, R.H3_TURBO_4STEP_LORA.file] });
    try {
      expect(accessList().loras.find((l) => l.file === R.H3_TURBO_4STEP_LORA.file)?.on).toBe(false);
      // Off: the 2K tier still runs; its draft runs on H3's own graph and the finish redraws the draft's clip.
      const made = gens.createGenerations({ feature: "video", modelId: "oss-minimax-h3", op: "t2v", prompt: "A lighthouse", params: { resolution: "2K", duration: 5 } });
      const draft = made.find((x) => x.modelId === "oss-minimax-h3")!;
      expect(draft.request.params?.extra?.latentDraft).toBeUndefined();
    } finally {
      saveAccess(was);
    }
  });

  it("chains words from an earlier step into the finish too", () => {
    const [write] = gens.createGenerations({ feature: "canvas", modelId: "oss-text-llm", op: "write", prompt: "A storm over a lighthouse" });
    const made = gens.createGenerations({ feature: "canvas", modelId: "oss-minimax-h3", op: "t2v", prompt: "{text}", chain: [{ slot: "prompt" }], params: { resolution: "2K", duration: 5 } }, { dependsOn: write.id });
    const finish = made.find((x) => x.modelId === R.REGEN_MODEL)!;
    const draft = made.find((x) => x.modelId === "oss-minimax-h3")!;
    expect(finish.request.chain).toEqual([{ slot: "video" }, { slot: "prompt" }]);
    expect(finish.request.prompt).toBe("{text}");
    const deps = db().prepare("SELECT depends_on FROM generations WHERE id = ?").get(finish.id) as { depends_on: string };
    expect(JSON.parse(deps.depends_on)).toEqual([draft.id, write.id]);
  });

  it("plans and prices each take's finish in a preview, as the run makes it", () => {
    const p = gens.previewGeneration({ feature: "video", modelId: "oss-minimax-h3", op: "t2v", prompt: "A lighthouse", params: { resolution: "2K", duration: 5, numOutputs: 2 } });
    expect(p.steps).toEqual([
      { model: R.REGEN_MODEL, op: "upscale-video" },
      { model: R.REGEN_MODEL, op: "upscale-video" },
    ]);
    expect(p.notes).toContain(R.H3_2K_STEPS_NOTE);
    expect(p.costUsd).toBe(0);
    // 768p is the model alone.
    expect(gens.previewGeneration({ feature: "video", modelId: "oss-minimax-h3", op: "t2v", prompt: "x", params: { resolution: "768p", duration: 5 } }).steps).toBeUndefined();
  });

  it("says on Edit video's Enhance item that it runs on your GPU", () => {
    expect(R.ENHANCE_LABEL).toBe("Enhance (H3 regenerate) · 1080p · on your GPU");
  });

  it("never takes the 2K hand-off's flags from a client", () => {
    const parsed = GenerationRequestSchema.parse({
      feature: "video",
      modelId: R.REGEN_MODEL,
      inputs: { video: "/api/files/x.mp4" },
      params: { resolution: "1440p", extra: { latentFrom: "someonesDraft", latentDraft: true, startSigma: 0.8 } },
      finishOf: "x",
    });
    expect(parsed.params?.extra).toEqual({ startSigma: 0.8 });
    expect(parsed).not.toHaveProperty("finishOf");
  });
});
