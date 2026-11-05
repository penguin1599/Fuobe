import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers/temp-dir";
import { getModel, getPreset } from "@/lib/catalog";
import { planCinema, takesClips, type CinemaGenerateInput } from "@/lib/catalog/cinema";
import { PIKA_FLEX_FL2VA, PIKA_FLEX_LORAS, PIKA_FLEX_NOTICE, PIKA_FLEX_REF2VA, pikaFlexGraphLoras } from "@/lib/catalog/pika-flex";
import { planGeneration } from "@/lib/catalog/plan";
import { controlsFor } from "@/lib/composer";
import type { GenInput } from "@/lib/catalog/types";
import type { ComfyWorkflow, ManifestWorkflow } from "@/lib/comfy";
import { H3_FLEX_GRAPH, resolveWorkflowId } from "@/lib/comfy-variants";
import { expandH3References, h3ReferenceLabels, h3ReferenceProblem, h3ReferenceTags, h3TalkPrompt, openReferenceMode } from "@/lib/h3-references";
import type { MediaInfo } from "@/lib/media-probe";

// Pika H3 Flex on your GPU (nm10-pika-flex; docs/research/new-models-10.md): 6-step FL2VA graphs, the Ref2VA references
// graph, the References mode's limits and order, Cinema and Lipsync on it, the adapters' licence rows and pre-flight row.
const tmp = tempDir("fuobe-pika-flex-");
process.env.FUOBE_DATA_DIR = tmp;
process.env.COMFYUI_URL = "http://comfy.test:8188";
const { prepareWorkflow } = await import("@/server/providers/comfyui");
const { accessList, knownSwitch, readAccess, saveAccess } = await import("@/server/model-access");
const { previewGeneration } = await import("@/server/generations");
const { runAsTenant } = await import("@/server/tenant");
const { STUDIO_ROWS, studioTool, modelTool } = await import("@/server/gpu/tools");

const DIR = path.join(__dirname, "../workflows/comfyui");
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8")) as { workflows: ManifestWorkflow[] };
const pins = JSON.parse(fs.readFileSync(path.join(DIR, "model-pins.json"), "utf8")) as Record<string, { sizeBytes: number; sha256: string; revision: string }>;
const graph = (id: string) => JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), "utf8")) as ComfyWorkflow;
const entry = (id: string) => manifest.workflows.find((w) => w.id === id)!;
const FLEX = ["minimax-h3-flex-t2v", "minimax-h3-flex-i2v", "minimax-h3-flex-flf2v", "minimax-h3-flex-ref2va"];
const SIGMAS = "1.0, 0.972973, 0.923077, 0.8, 0.571429, 0.333333, 0.0";

describe("Pika H3 Flex graphs", () => {
  it("are in the library, validated on ComfyUI, with Pika's adapter at 1.0 and the 6-step contract", () => {
    for (const id of FLEX) {
      const e = entry(id);
      expect(e, id).toBeTruthy();
      expect(e.validated, id).toBe(true);
      const g = graph(id);
      const by = (cls: string) => Object.values(g).filter((n) => n.class_type === cls);
      expect(by("ManualSigmas")[0].inputs.sigmas).toBe(SIGMAS);
      expect(SIGMAS.split(",").length - 1).toBe(6);
      expect(by("KSamplerSelect")[0].inputs.sampler_name).toBe("lcm");
      expect(by("BasicGuider")).toHaveLength(1);
      // No other speed LoRA, no second shift: the knots carry shift 12.
      const loras = by("LoraLoaderModelOnly");
      expect(loras).toHaveLength(1);
      expect(loras[0].inputs.strength_model).toBe(1);
      expect(by("MiniMaxH3SigmaShift")).toHaveLength(0);
      expect(by("MiniMaxH3TurboLoRA")).toHaveLength(0);
      const ref = id.endsWith("ref2va");
      expect(loras[0].inputs.lora_name).toBe(ref ? PIKA_FLEX_REF2VA.file : PIKA_FLEX_FL2VA.file);
      expect(by("UNETLoader")[0].inputs.unet_name).toBe(ref ? "minimax_h3_ref2va_pruned_int8_convrot.safetensors" : "minimax_h3_fl2va_pruned_int8_convrot.safetensors");
      expect(e.defaults).toMatchObject({ frames: 124, fps: 24 });
      expect(e.notes).toMatch(/6 steps/);
      expect(e.notes).toMatch(/17n\+5/);
      expect(e.license).toMatch(/Mellis, Inc\./);
    }
  });

  it("bind frames as the templates do: none, the first, the first and the last; references expand", () => {
    expect(entry("minimax-h3-flex-t2v").bindings.image).toBeUndefined();
    expect(entry("minimax-h3-flex-i2v").bindings).toMatchObject({ image: [{ node: "138", input: "image" }] });
    expect(entry("minimax-h3-flex-i2v").bindings.endImage).toBeUndefined();
    expect(entry("minimax-h3-flex-flf2v").bindings).toMatchObject({ image: [{ node: "138" }], endImage: [{ node: "140" }] });
    expect(entry("minimax-h3-flex-ref2va")).toMatchObject({ capability: "ref2v", expand: "references" });
  });

  it("pin Pika's two Comfy files with their size and SHA-256 at the card's revision", () => {
    for (const l of [PIKA_FLEX_FL2VA, PIKA_FLEX_REF2VA]) {
      const pin = pins[l.url!];
      expect(pin, l.file).toMatchObject({ revision: "3ff166447d5edb1406107ab8370c42000ce173e4", sizeBytes: 1956172176 });
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("Quality → Fast · Pika Flex picks them; an orbit and Sharper keep theirs", () => {
    const has = () => true;
    const r = (endpoint: string, extra: Record<string, unknown>) => resolveWorkflowId(endpoint, { op: "i2v", clips: 0, images: 1, audio2: false, extra, has });
    for (const [base, flex] of Object.entries(H3_FLEX_GRAPH)) expect(r(base, { quality: "flex" })).toBe(flex);
    expect(r("minimax-h3-i2v", { quality: "best" })).toBe("minimax-h3-i2v-hq");
    expect(r("minimax-h3-i2v", { quality: "flex", orbit: true })).toBe("minimax-h3-orbit");
    expect(r("minimax-h3-t2v", {})).toBe("minimax-h3-t2v");
    const m = getModel("oss-minimax-h3")!;
    const q = m.options.controls!.find((c) => c.param === "quality")!;
    expect(q.values).toEqual(["fast", "best", "flex"]);
    expect(q.labels?.flex).toBe("Fast · Pika Flex (6 steps)");
  });

  it("each run downloads the adapter its graph loads", () => {
    expect(pikaFlexGraphLoras("minimax-h3-flex-ref2va", {})).toEqual([PIKA_FLEX_REF2VA]);
    expect(pikaFlexGraphLoras("minimax-h3-t2v", { quality: "flex" })).toEqual([PIKA_FLEX_FL2VA]);
    expect(pikaFlexGraphLoras("minimax-h3-t2v", { quality: "best" })).toEqual([]);
    expect(pikaFlexGraphLoras("minimax-h3-i2v", { quality: "flex", orbit: true })).toEqual([]);
  });
});

describe("References: Pika's limits and the order the prompt cites", () => {
  it("needs an image or a clip, and holds 9 images, 3 clips and 3 audio clips, 12 in all", () => {
    expect(h3ReferenceProblem({ images: 0, videos: [], audios: [5] })).toMatch(/at least one image or clip/);
    expect(h3ReferenceProblem({ images: 1, videos: [], audios: [] })).toBeNull();
    expect(h3ReferenceProblem({ images: 0, videos: [4], audios: [] })).toBeNull();
    expect(h3ReferenceProblem({ images: 10, videos: [], audios: [] })).toMatch(/9 reference images/);
    expect(h3ReferenceProblem({ images: 1, videos: [3, 3, 3, 3], audios: [] })).toMatch(/3 reference clips/);
    expect(h3ReferenceProblem({ images: 1, videos: [], audios: [3, 3, 3, 3] })).toMatch(/3 voice or music clips/);
    expect(h3ReferenceProblem({ images: 9, videos: [2], audios: [2] })).toBeNull();
    expect(h3ReferenceProblem({ images: 9, videos: [2, 2], audios: [2] })).toBeNull();
    expect(h3ReferenceProblem({ images: 9, videos: [2, 2], audios: [2, 2] })).toMatch(/12 references in all/);
  });

  it("keeps each clip 2-15 s and each group at most 15 s; a clip's own sound isn't an audio file", () => {
    expect(h3ReferenceProblem({ images: 1, videos: [1.5], audios: [] })).toMatch(/Clip 1 is 1.5 s: references need at least 2 s/);
    expect(h3ReferenceProblem({ images: 1, videos: [], audios: [16] })).toMatch(/Voice 1 is 16 s: trim it/);
    expect(h3ReferenceProblem({ images: 1, videos: [8, 8], audios: [] })).toMatch(/clips add up to 16 s/);
    expect(h3ReferenceProblem({ images: 1, videos: [7.5, 7.5], audios: [7.5, 7.5] })).toBeNull();
    expect(h3ReferenceProblem({ images: 1, videos: [], audios: [10, 6] })).toMatch(/voice and music clips add up to 16 s/);
    // A length not known yet isn't counted against the limits.
    expect(h3ReferenceProblem({ images: 1, videos: [undefined, 14], audios: [] })).toBeNull();
  });

  it("names them Image 1, Image 2, Clip 1, Voice 1 and turns the names into H3's tags", () => {
    expect(h3ReferenceLabels({ images: 2, videos: 1, audios: 1 })).toEqual(["Image 1", "Image 2", "Clip 1", "Voice 1"]);
    expect(h3ReferenceTags("The woman in Image 1 dances like Clip 1, singing Voice 1 over music 2")).toBe(
      "The woman in <Picture 1> dances like <Video 1>, singing <Audio 1> over <Audio 2>",
    );
    expect(h3ReferenceTags("Keep <Picture 1> as is, image 2 too")).toBe("Keep <Picture 1> as is, <Picture 2> too");
    expect(h3TalkPrompt("smiling")).toMatch(/^The person in <Picture 1> talks to the camera, speaking exactly the words of <Audio 1>.* smiling$/);
  });

  it("the graph gets one loader per reference, in order, and Image 1's loader goes with no image", () => {
    const g = graph("minimax-h3-flex-ref2va");
    const out = expandH3References(g, { images: ["a.png", "b.png"], videos: ["c.mp4", "d.mp4"], audios: ["v.wav"], videoSound: [true, false] });
    const ref = Object.values(out).find((n) => n.class_type === "MiniMaxH3ReferenceToVideo")!;
    expect(ref.inputs["ref_images.ref_image_0"]).toEqual(["150", 0]);
    expect(out["150"].inputs.image).toBe("a.png");
    expect(out[(ref.inputs["ref_images.ref_image_1"] as [string, number])[0]].inputs.image).toBe("b.png");
    const v0 = out[(ref.inputs["ref_videos.ref_video_0"] as [string, number])[0]];
    expect(v0).toMatchObject({ class_type: "VHS_LoadVideo", inputs: { video: "c.mp4", force_rate: 24, frame_load_cap: 360 } });
    expect(ref.inputs["ref_video_audios.ref_video_audio_0"]).toEqual(["ref_video_0", 2]);
    expect(ref.inputs["ref_video_audios.ref_video_audio_1"]).toBeUndefined();
    expect(out[(ref.inputs["ref_audios.ref_audio_0"] as [string, number])[0]]).toMatchObject({ class_type: "LoadAudio", inputs: { audio: "v.wav" } });
    const clipOnly = expandH3References(g, { images: [], videos: ["c.mp4"], audios: [] });
    expect(clipOnly["150"]).toBeUndefined();
    expect(Object.keys(Object.values(clipOnly).find((n) => n.class_type === "MiniMaxH3ReferenceToVideo")!.inputs).filter((k) => k.startsWith("ref_images"))).toEqual([]);
    expect(() => expandH3References(g, { images: [], videos: [], audios: ["v.wav"] })).toThrow(/image or clip/);
  });
});

describe("References on the open engine", () => {
  const media: Record<string, MediaInfo> = {
    "a.png": { container: "image", width: 1024, height: 1024, hasVideo: false, hasAudio: false },
    "c.mp4": { container: "mp4", duration: 4, videoDuration: 4, width: 1280, height: 720, fps: 30, hasVideo: true, hasAudio: true },
    "long.mp4": { container: "mp4", duration: 16, videoDuration: 16, width: 1280, height: 720, fps: 30, hasVideo: true, hasAudio: false },
    "v.wav": { container: "wav", duration: 6, hasVideo: false, hasAudio: true },
  };
  const ctx = (op: string) => ({ generationId: "g1", op, upload: async (_d: Uint8Array, _t: string, name: string) => `up_${name}`, media: (n: string) => media[n] });

  it("MiniMax H3 has a References mode on your GPU; the hosted H3 has none", () => {
    expect(openReferenceMode(getModel("oss-minimax-h3"))).toEqual({ images: 9, videos: 3, audios: 3 });
    expect(openReferenceMode(getModel("minimax-h3"))).toBeNull();
    const m = getModel("oss-minimax-h3")!;
    expect(takesClips(m, "ref2v", "videos")).toBe(true);
    expect(takesClips(m, "ref2v", "audios")).toBe(true);
    expect(m.engineNote).toMatch(/runs on your GPU only/);
  });

  it("a Video studio run with a clip and a voice plans to the references graph", () => {
    const plan = planGeneration(
      { feature: "video", modelId: "oss-minimax-h3", prompt: "Image 1 walks", inputs: { images: ["/api/files/uploads/a.png"], videos: ["/api/files/uploads/c.mp4"], audios: ["/api/files/uploads/v.wav"] } },
      getModel,
      getPreset,
    );
    expect(plan.op).toBe("ref2v");
    expect(plan.model.routes.find((r) => r.op === plan.op)!.endpoint).toBe("minimax-h3-flex-ref2va");
  });

  it("the provider binds the references in order, sizes H3's canvas, and refuses what Pika's limits rule out", async () => {
    const p = await prepareWorkflow("minimax-h3-flex-ref2va", { prompt: "x", images: ["a.png"], videos: ["c.mp4"], audios: ["v.wav"], aspectRatio: "16:9", duration: 5 } as GenInput, ctx("ref2v") as never);
    const wf = p.workflow;
    const ref = Object.values(wf).find((n) => n.class_type === "MiniMaxH3ReferenceToVideo")!;
    expect(ref.inputs).toMatchObject({ width: 1344, height: 768, length: 124 });
    expect(wf["150"].inputs.image).toBe("a.png");
    expect(ref.inputs["ref_videos.ref_video_0"]).toBeTruthy();
    expect(ref.inputs["ref_audios.ref_audio_0"]).toBeTruthy();
    await expect(
      prepareWorkflow("minimax-h3-flex-ref2va", { prompt: "x", images: ["a.png"], videos: ["long.mp4"], duration: 5 } as GenInput, ctx("ref2v") as never),
    ).rejects.toThrow(/Clip 1 is 16 s/);
    const clipOnly = await prepareWorkflow("minimax-h3-flex-ref2va", { prompt: "x", videos: ["c.mp4"], duration: 5 } as GenInput, ctx("ref2v") as never);
    expect(clipOnly.workflow["150"]).toBeUndefined();
  });

  it("Cinema on your GPU sends several images and reference clips to H3's references", () => {
    const input = (over: Partial<CinemaGenerateInput>): CinemaGenerateInput => ({ engine: "open", mode: "video", action: "generate", prompt: "A keeper climbs the stairs", settings: {}, duration: 5, batch: 1, ...over });
    const imgs = Array.from({ length: 4 }, (_, i) => `/api/files/uploads/r${i}.png`);
    const plan = planCinema(input({ modelId: "oss-minimax-h3", images: imgs, videos: ["/api/files/uploads/c.mp4"], audios: ["/api/files/uploads/v.wav"] }), { cloudAllowed: true });
    const main = plan.steps.find((s) => s.key === "main")!.request;
    expect(main.op).toBe("ref2v");
    expect(main.inputs).toMatchObject({ images: imgs, videos: ["/api/files/uploads/c.mp4"], audios: ["/api/files/uploads/v.wav"] });
    // Images alone: still references (several), not a start frame.
    const stills = planCinema(input({ modelId: "oss-minimax-h3", images: imgs.slice(0, 2) }), { cloudAllowed: true }).steps[0].request;
    expect(stills.op).toBe("ref2v");
    // 12 in all: images give way to the clips.
    const many = Array.from({ length: 11 }, (_, i) => `/api/files/uploads/m${i}.png`);
    const full = planCinema(input({ modelId: "oss-minimax-h3", images: many, videos: ["/api/files/uploads/c.mp4"], audios: ["/api/files/uploads/v.wav", "/api/files/uploads/w.wav"] }), { cloudAllowed: true });
    expect(full.steps[0].request.inputs?.images).toHaveLength(9);
    // Other open models keep one start frame.
    const ltx = planCinema(input({ modelId: "oss-ltx25", images: imgs.slice(0, 2) }), { cloudAllowed: true }).steps[0].request;
    expect(ltx.op).not.toBe("ref2v");
  });

  it("Lipsync & avatars: Talk from a voice clip is one image and the voice on the references graph, as long as the voice", async () => {
    const m = getModel("oss-minimax-h3")!;
    const route = m.routes.find((r) => r.op === "avatar")!;
    expect(route.endpoint).toBe("minimax-h3-flex-ref2va");
    expect(route.note).toMatch(/not a re-sync of existing footage/);
    const plan = planGeneration({ feature: "lipsync", modelId: "oss-minimax-h3", prompt: "", inputs: { images: ["/api/files/uploads/a.png"], audio: "/api/files/uploads/v.wav" } }, getModel, getPreset);
    expect(plan.op).toBe("avatar");
    const p = await prepareWorkflow("minimax-h3-flex-ref2va", { prompt: "x", images: ["a.png"], audio: "v.wav" } as GenInput, ctx("avatar") as never);
    const ref = Object.values(p.workflow).find((n) => n.class_type === "MiniMaxH3ReferenceToVideo")!;
    expect(ref.inputs.length).toBe(158); // 6 s of voice on the 17n + 5 grid
    expect(p.workflow[(ref.inputs["ref_audios.ref_audio_0"] as [string, number])[0]].inputs.audio).toBe("v.wav");
    expect(ref.inputs).toMatchObject({ width: 768, height: 768 }); // the portrait's shape
  });
});

describe("Settings → Models & licences and the GPU pre-flight", () => {
  it("list both adapters with the MiniMax H3 licence and Pika's NOTICE, switched on", () => {
    const rows = accessList().loras.filter((l) => PIKA_FLEX_LORAS.some((p) => p.file === l.file));
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.on).toBe(true);
      expect(r.licence.name).toBe("MiniMax H3 Community License");
      expect(r.licence.notices).toContain(PIKA_FLEX_NOTICE);
      expect(r.licence.url).toMatch(/Pika-Labs\/Pika-H3-Flex/);
    }
    expect(knownSwitch("lora", PIKA_FLEX_REF2VA.file)).toBe(true);
  });

  it("the references have a row of their own (the Ref2VA partition); the Video row stays as it was", () => {
    const video = studioTool(STUDIO_ROWS.find((r) => r.href === "/video")!)!;
    expect(video.workflows).not.toContain("minimax-h3-flex-ref2va");
    const refs = studioTool(STUDIO_ROWS.find((r) => r.href === "/video?model=oss-minimax-h3")!)!;
    expect(refs.workflows).toEqual(["minimax-h3-flex-ref2va"]);
    expect(refs.loras.map((l) => l.file)).toContain(PIKA_FLEX_REF2VA.file);
    expect(modelTool("oss-minimax-h3", "avatar")!.workflows).toEqual(["minimax-h3-flex-ref2va"]);
  });
});

describe("What a References run can't carry is said, not dropped", () => {
  const plan = (feature: string, inputs: GenerationRequestInputs) => () => planGeneration({ feature, modelId: "oss-minimax-h3", prompt: "friendly", inputs }, getModel, getPreset);
  type GenerationRequestInputs = Parameters<typeof planGeneration>[0]["inputs"];

  it("Lipsync & avatars on MiniMax H3: a clip to re-sync is refused (H3 makes a new clip), not run as words alone", () => {
    expect(plan("lipsync", { video: "/api/files/uploads/c.mp4", audio: "/api/files/uploads/v.wav" })).toThrow(/doesn't re-sync an existing clip\. Add a portrait instead of the video/);
    expect(plan("lipsync", { images: ["/api/files/uploads/a.png"], video: "/api/files/uploads/c.mp4", audio: "/api/files/uploads/v.wav" })).toThrow(/doesn't re-sync/);
    // The portrait and the voice still make the talking clip; an asked op isn't second-guessed.
    expect(plan("lipsync", { images: ["/api/files/uploads/a.png"], audio: "/api/files/uploads/v.wav" })().op).toBe("avatar");
    // A model with a lip-sync route still re-syncs the clip.
    expect(planGeneration({ feature: "lipsync", modelId: "oss-latentsync", prompt: "", inputs: { video: "/api/files/uploads/c.mp4", audio: "/api/files/uploads/v.wav" } }, getModel, getPreset).op).toBe("lipsync");
  });

  it("an end frame with reference clips or sound is refused (first and last frames carry neither)", () => {
    expect(plan("video", { images: ["/api/files/uploads/a.png"], endImage: "/api/files/uploads/b.png", videos: ["/api/files/uploads/c.mp4"] })).toThrow(/can't go with an end frame/);
    expect(plan("video", { images: ["/api/files/uploads/a.png"], endImage: "/api/files/uploads/b.png", audios: ["/api/files/uploads/v.wav"] })).toThrow(/can't go with an end frame/);
    expect(plan("video", { images: ["/api/files/uploads/a.png"], endImage: "/api/files/uploads/b.png" })().op).toBe("flf2v");
  });

  it("the Quality chip shows on words and frames only: References and Talk always run Pika H3 Flex", () => {
    const controls = getModel("oss-minimax-h3")!.options.controls!;
    // GPU tier (nm10-h3-any-gpu) shows beside it on the same modes; no smaller build runs references, so neither shows there.
    for (const op of ["t2v", "i2v", "flf2v"]) expect(controlsFor(controls, op).map((c) => c.param)).toEqual(["quality", "gpuTier"]);
    for (const op of ["ref2v", "avatar"]) expect(controlsFor(controls, op)).toEqual([]);
  });

  it("a run whose Pika adapter is switched off in Settings → Models & licences doesn't start (a visitor gets plain words)", () => {
    const flex = { feature: "video", modelId: "oss-minimax-h3", prompt: "a fox", params: { extra: { quality: "flex" } } } as const;
    const refs = { feature: "video", modelId: "oss-minimax-h3", prompt: "Image 1 walks", inputs: { images: ["/api/files/uploads/a.png"], videos: ["/api/files/uploads/c.mp4"] } } as const;
    const talk = { feature: "lipsync", modelId: "oss-minimax-h3", prompt: "", inputs: { images: ["/api/files/uploads/a.png"], audio: "/api/files/uploads/v.wav" } } as const;
    // A ComfyUI that answers (comfy.test, as the provider tests do).
    const g = globalThis as unknown as { __fuobeComfyReach?: { ok: boolean; at: number; url: string } };
    const reach = g.__fuobeComfyReach;
    g.__fuobeComfyReach = { ok: true, at: Date.now(), url: "http://comfy.test:8188" };
    const was = readAccess();
    try {
      expect(() => previewGeneration(flex as never)).not.toThrow();
      saveAccess({ ...was, loras: [...was.loras, PIKA_FLEX_FL2VA.file] });
      expect(() => previewGeneration(flex as never)).toThrow(/Fast · Pika Flex runs with .*switched off in Settings → Models & licences\. Pick Standard or Sharper/);
      // Standard keeps running without the adapter.
      expect(() => previewGeneration({ ...flex, params: { extra: { quality: "fast" } } } as never)).not.toThrow();
      saveAccess({ ...was, loras: [...was.loras, PIKA_FLEX_REF2VA.file] });
      expect(() => previewGeneration(refs as never)).toThrow(/References runs with .*switched off/);
      expect(() => previewGeneration(talk as never)).toThrow(/Talk from a voice clip runs with .*switched off/);
      runAsTenant({ kind: "account", id: "acct-a" } as never, () => {
        let message = "";
        try {
          previewGeneration(refs as never);
        } catch (e) {
          message = (e as Error).message;
        }
        expect(message).toMatch(/^References isn't available here/);
        expect(message).not.toMatch(/LoRA|Settings|safetensors/);
      });
    } finally {
      saveAccess(was);
      g.__fuobeComfyReach = reach;
    }
  });

  it("the references graph asks the GPU pre-flight for the clip loader's pack", () => {
    const req = JSON.parse(fs.readFileSync(path.join(DIR, "requirements.json"), "utf8")) as { workflows: Record<string, { packs: Record<string, string[]> }> };
    expect(req.workflows["minimax-h3-flex-ref2va"].packs).toEqual({ "ComfyUI-VideoHelperSuite": ["VHS_LoadVideo"] });
  });
});
