import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Operation } from "@/lib/catalog/types";
import type { ComfyWorkflow, Manifest, ManifestOutput, ManifestWorkflow } from "@/lib/comfy";
import type { MediaInfo } from "@/lib/media-probe";
import { tempDir } from "./helpers/temp-dir";

// The round-4 ComfyUI library (docs/research/comfyui-oss-4.json): the 17 graphs with the bindings and outputs the
// feature packages drive, and the CausVid licence fix of wan21-vace-14b-ref2v.
const dir = path.join(process.cwd(), "workflows/comfyui");
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as Manifest;
const byId = new Map(manifest.workflows.map((w) => [w.id, w]));
const graph = (id: string) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8")) as ComfyWorkflow;
const subset = JSON.parse(fs.readFileSync(path.join(dir, "object_info.subset.json"), "utf8")) as Record<string, unknown>;

const VACE = ["startTime", "duration", "width", "height", "maskGrow", "prompt", "negativePrompt", "checkpoint", "loraStrength", "shift", "seed", "steps", "cfg", "filenamePrefix"];
const ROUND4: Record<string, { capability: string; bindings: string[]; outputs: [string, string?][] }> = {
  "ocr-lines-qwen35": { capability: "ocr", bindings: ["image", "maxSize", "checkpoint", "instruction", "maxTokens", "filenamePrefix"], outputs: [["text", "lines"], ["text", "frame"]] },
  "video-inpaint-wan-vace": { capability: "remove-object", bindings: ["video", "maskPrompt", ...VACE], outputs: [["video"]] },
  // The painted eraser also saves its last tracked frame's mask, which starts the next window (remove-object package).
  "video-inpaint-wan-vace-painted": { capability: "remove-object", bindings: ["video", "mask", ...VACE], outputs: [["video"], ["image", "mask"]] },
  "video-erase-void": {
    capability: "remove-object",
    bindings: ["video", "startTime", "duration", "width", "height", "maskPrompt", "maskGrow", "prompt", "negativePrompt", "cfg", "steps", "seed", "skipPass2", "filenamePrefix"],
    outputs: [["video"]],
  },
  "video-swap-wan-vace": { capability: "video-swap", bindings: ["video", "image", "maskPrompt", ...VACE], outputs: [["video"]] },
  "video-insert-wan-vace": { capability: "video-insert", bindings: ["video", "image", "mask", ...VACE], outputs: [["video"]] },
  "kenburns-still": {
    capability: "still-motion",
    bindings: ["image", "supersample", "width", "height", "duration", "fps", "zoomStart", "zoomEnd", "panStartX", "panStartY", "panEndX", "panEndY", "easeInOut", "chunkFrames", "filenamePrefix"],
    outputs: [["video"]],
  },
  "audio-loop-crossfade": { capability: "audio-loop", bindings: ["audio", "fadeCurve", "crossfade", "duration", "headroomDb", "filenamePrefix"], outputs: [["audio"]] },
  "audio-join-crossfade": { capability: "audio-join", bindings: ["audio", "audio2", "fadeCurve", "crossfade", "filenamePrefix"], outputs: [["audio"]] },
  "video-export-pro": { capability: "export-video", bindings: ["video", "format", "profile", "filenamePrefix"], outputs: [["video"]] },
  // r4/video-finish: colorSpace picks HLG or PQ (HDR10); the EXR export also saves a preview clip to show in the feed.
  "video-sdr-to-hdr": { capability: "sdr-to-hdr", bindings: ["video", "peakNits", "colorSpace", "filenamePrefix"], outputs: [["video"]] },
  "video-export-exr": { capability: "export-video", bindings: ["video", "filenamePrefix"], outputs: [["video", "preview"], ["image", "frames"]] },
  "still-to-clip": { capability: "still-motion", bindings: ["image", "width", "height", "duration", "fps", "filenamePrefix"], outputs: [["video"]] },
  "video-append-endcard": { capability: "concat", bindings: ["video", "image", "width", "height", "fps", "duration", "filenamePrefix"], outputs: [["video"]] },
  "scene-mesh-moge": { capability: "scene-3d", bindings: ["image", "checkpoint", "resolutionLevel", "fovX", "decimation", "filenamePrefix"], outputs: [["model3d", "scene"], ["image", "depth"]] },
  "image-to-splat-triposplat": {
    capability: "splat",
    bindings: ["image", "cutout", "numGaussians", "steps", "cfg", "seed", "splatFormat", "orbitFrames", "filenamePrefix"],
    outputs: [["model3d", "splat"], ["video", "turntable"]],
  },
  "reference-brief-gemma4": {
    capability: "write",
    bindings: ["video", "frames", "startFrame", "frameWidth", "checkpoint", "instruction", "seed", "maxTokens", "filenamePrefix"],
    outputs: [["text", "brief"]],
  },
};
/** Loaders whose input is an upload: every one must be a binding, or the graph points at a researcher's file. */
const MEDIA: Record<string, string> = { LoadImage: "image", LoadImageMask: "image", LoadVideo: "file", VHS_LoadVideo: "video", LoadAudio: "audio", VHS_LoadAudioUpload: "audio" };
const ROLES: NonNullable<ManifestOutput["role"]>[] = [
  "cues", "transcript", "language", "layers", "sheet", "tiles", "first-frame", "turntable", "lines", "frame", "frames", "scene", "depth", "splat", "brief", "preview",
  // remove-object package: the painted eraser's hand-off mask, the matte graphs' two videos.
  "mask", "cutout", "matte",
  // Character Swap Studio: a segment's lossless master, which the next segment continues from.
  "master",
  // DBS soundtrack separation: the pack's own report of the run (model, device, windows, seconds).
  "report",
  // Any Angle: the turntable a photo's front view is measured on (colour, coverage), and a GLB made from a splat.
  "sweep", "sweep-mask", "mesh",
  // Photo to 3D: the orbit clip of the splat that came with its GLB.
  "orbit",
  // Watermark Remover: the repair's verdict, folded into the picture's meta.
  "quality",
  // Watermark Remover: the four tiles' scan reports, merged into the whole photo's report.
  "scan-tile",
];

describe("round-4 ComfyUI workflows", () => {
  it.each(Object.entries(ROUND4))("%s: validated, licensed, with the contract's bindings and outputs", (id, want) => {
    const w = byId.get(id);
    expect(w, id).toBeDefined();
    expect(w!.validated).toBe(true);
    expect(w!.license).toBeTruthy();
    expect(w!.notes?.length).toBeGreaterThan(100);
    expect(w!.capability).toBe(want.capability);
    expect(Object.keys(w!.bindings).sort()).toEqual([...want.bindings].sort());
    expect(w!.outputs.map((o) => (o.role ? [o.kind, o.role] : [o.kind]))).toEqual(want.outputs);
    for (const m of w!.models) expect(m.url && m.sizeGb, `${id} ${m.file}`).toBeTruthy();
    const g = graph(id);
    const bound = new Set(Object.values(w!.bindings).flatMap((ts) => ts!.map((t) => `${t.node}.${t.input}`)));
    for (const [nid, n] of Object.entries(g)) {
      expect(subset[n.class_type], `${id}: ${n.class_type} in object_info.subset.json`).toBeTruthy();
      if (MEDIA[n.class_type]) expect(bound.has(`${nid}.${MEDIA[n.class_type]}`), `${id} node ${nid} ${n.class_type}`).toBe(true);
    }
  });

  it("keeps the whole library validated, and every output role is a typed role", () => {
    expect(manifest.workflows.length).toBeGreaterThanOrEqual(132);
    expect(new Set(manifest.workflows.map((w) => w.id)).size).toBe(manifest.workflows.length);
    // Graphs on node packs this server doesn't have (h3_character_swap, H3 Relay, ComfyUI-LTXVideo) name a missing node at
    // their /prompt check (tests/comfy-character-swap.test.ts, tests/restore-comfy.test.ts); the rest wait for a GPU run.
    expect(manifest.workflows.filter((w) => !w.validated).map((w) => w.id)).toEqual([
      // Green screen and fine hair (nm10-keying): ComfyUI-RMBG 3.3.0 and the CorridorKey wrapper aren't on the validation
      // server (tests/keying.test.ts checks their classes against the packs' source).
      "image-matte-feynobg",
      // MiniMax H3 on 8-31 GB cards: FastH3 V2 and Trim, unvalidated like the H3 graphs until a GPU run.
      "minimax-h3-trim-t2v",
      // Design a voice: ComfyUI-QwenTTS and ComfyUI-VoxCPM2 aren't on the validation server (tests/voice-design-server.test.ts).
      "tts-qwen3-design",
      "tts-qwen3-clone",
      "tts-voxcpm2",
      "tts-voxcpm2-clone",
      // Edit speech (nm10-speech-edit): ComfyUI-AuK isn't on the validation server (tests/speech-edit-comfy.test.ts checks its node list).
      "speech-edit-auk",
      "speech-tts-auk",
      "video-matte-vrmbg3",
      "video-key-corridorkey",
      // Qwen-Image 2.1's speeds, its next scene and its 16 GB route: unvalidated like their base graphs until
      // they run on a GPU (tests/qwen21-fast.test.ts).
      "qwen-image-21-t2i-small",
      "qwen-image-21-edit-small",
      "krea2-inpaint",
      "krea2-outpaint",
      "video-restore-ltx25-tiled",
      // Hi3D refine (hi3d-refine): Comfyui-Hi3d-T8 needs an Ampere-or-newer NVIDIA GPU, so it isn't on the validation server.
      "mesh-refine-hi3d",
      "video-character-swap-h3-relay",
      "video-character-swap-h3-segment",
      "video-mask-h3-relay",
      // Idol 3D's clean splats and four views: ComfyUI-Idol isn't on the validation server (tests/idol-clean.test.ts).
      "image-to-splat-idol-clean",
      "image-to-views-idol",
      "video-regenerate-h3",
      "video-h3-t2v-2k",
      "video-regenerate-h3-latent",
      // NVIDIA RTX Video: the pack needs an NVIDIA RTX card, so it isn't on the CPU validation server (tests/rtx-video.test.ts checks its inputs).
      "upscale-video-rtx",
      "fps-rtx-framegen",
      "sdr-to-hdr-rtx",
      // Kandinsky 6.0: Kandinsky Lab's kandinsky6 / kandinsky6-sr packs aren't on the validation server (tests/kandinsky6.test.ts).
      "kandinsky6-t2av",
      "kandinsky6-i2av",
      "video-upscale-kandinsky6-vsr",
      // World mode: Nynxz's ComfyUI-HyNomas isn't on the validation server (tests/world-mode.test.ts).
      "world-hy-nomas-turn",
      // Genjutsu's Openjutsu modes not checked against ComfyUI yet; each opens only after its /prompt
      // check and a real render (workflows/comfyui/gpu-tested.json, src/server/genjutsu-live.ts).
      "image-from-picture-prepare",
      "video-motion-transfer-h3",
    ]);
    for (const w of manifest.workflows) for (const o of w.outputs) if (o.role) expect(ROLES, `${w.id} ${o.role}`).toContain(o.role);
  });

  it("states the limits and defaults the app plans windows and jobs with", () => {
    for (const id of ["video-inpaint-wan-vace", "video-inpaint-wan-vace-painted", "video-swap-wan-vace", "video-insert-wan-vace"]) {
      expect(byId.get(id)!.limits).toEqual({ maxWidth: 1280, maxHeight: 1280, maxFrames: 81, dimensionMultiple: 16 });
      expect(byId.get(id)!.defaults).toMatchObject({ startTime: 0, duration: 0, width: 832, height: 480, checkpoint: "wan2.1_vace_14B_fp16.safetensors", steps: 4, cfg: 1, loraStrength: 1 });
      expect(byId.get(id)!.defaults.frameStep, id).toBeUndefined(); // the graph counts the frames itself
    }
    expect(byId.get("video-erase-void")!.limits).toEqual({ maxWidth: 1024, maxHeight: 1024, maxFrames: 197, dimensionMultiple: 8 });
    expect(byId.get("video-erase-void")!.defaults).toMatchObject({ startTime: 0, duration: 0, width: 672, height: 384, skipPass2: false });
    expect(byId.get("image-to-splat-triposplat")!.defaults).toMatchObject({ cutout: true, splatFormat: "spz" });
    expect(byId.get("kenburns-still")!.limits).toMatchObject({ maxDurationSec: 10 });
    expect(byId.get("audio-loop-crossfade")!.limits).toMatchObject({ maxDurationSec: 600 });
    expect(byId.get("reference-brief-gemma4")!.defaults).toMatchObject({ fps: 24, frameStep: 1, frames: 720 });
  });

  it("writes the TextGenerate instructions back from defaults, word for word", () => {
    expect(byId.get("ocr-lines-qwen35")!.defaults.instruction).toBe(graph("ocr-lines-qwen35")["4"].inputs.prompt);
    expect(String(byId.get("ocr-lines-qwen35")!.defaults.instruction)).toMatch(/\[0, 1000\)/);
    expect(byId.get("reference-brief-gemma4")!.defaults.instruction).toBe(graph("reference-brief-gemma4")["3"].inputs.prompt);
  });

  it("reads painted masks from the red channel (white = erase / the region), like flux1-fill-inpaint", () => {
    for (const id of ["video-inpaint-wan-vace-painted", "video-insert-wan-vace"]) {
      const g = graph(id);
      const [t] = byId.get(id)!.bindings.mask!;
      expect(g[t.node].class_type).toBe("LoadImageMask");
      expect(g[t.node].inputs.channel).toBe("red");
    }
  });

  it("Ken Burns blends linear and eased progress through easeInOut", () => {
    const g = graph("kenburns-still");
    const [ease] = byId.get("kenburns-still")!.bindings.easeInOut!;
    const progress = Object.values(g).find((n) => n.class_type === "ComfyMathExpression" && String(n.inputs.expression).includes("cos("))!;
    expect(progress.inputs["values.c"]).toEqual([ease.node, 0]);
    expect(progress.inputs.expression).toMatch(/^\(1 - c\) \* a \/ max\(b - 1, 1\) \+ c \* \(1 - cos/);
  });

  it("the audio graphs load the crossfade curve the provider writes", () => {
    for (const id of ["audio-loop-crossfade", "audio-join-crossfade"]) {
      const g = graph(id);
      const [curve] = byId.get(id)!.bindings.fadeCurve!;
      expect(g[curve.node].class_type).toBe("LoadAudio");
      expect(Object.values(g).some((n) => n.class_type === "SplitAudioChannels" && JSON.stringify(n.inputs.audio) === JSON.stringify([curve.node, 0]))).toBe(true);
    }
  });

  it("wan21-vace-14b-ref2v runs on the Apache-2.0 lightx2v LoRA, not CausVid (CC-BY-NC-4.0)", () => {
    const w = byId.get("wan21-vace-14b-ref2v")!;
    const g = graph("wan21-vace-14b-ref2v");
    expect(JSON.stringify(g)).not.toMatch(/CausVid/i);
    expect(w.models.map((m) => m.file)).toContain("lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank64_bf16.safetensors");
    expect(w.models.some((m) => /CausVid/i.test(m.file))).toBe(false);
    expect(w.license).toMatch(/^Apache-2.0/);
    expect(w.validated).toBe(true);
    const [lora] = w.bindings.loraStrength!;
    expect(g[lora.node].inputs).toMatchObject({ lora_name: "lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank64_bf16.safetensors", strength_model: 1 });
    const sampler = Object.values(g).find((n) => n.class_type === "KSampler")!;
    expect(sampler.inputs).toMatchObject({ sampler_name: "euler", steps: 4, cfg: 1 });
    expect(w.defaults).toMatchObject({ shift: 5, steps: 4, cfg: 1, loraStrength: 1 });
  });

  it("flags the licence terms people have to know about", () => {
    expect(byId.get("video-erase-void")!.license).toMatch(/CogVideoX License.*commercial use only after registering.*1 million/);
    expect(byId.get("image-to-splat-triposplat")!.license).toMatch(/Built with DINOv3/);
    for (const id of ["video-inpaint-wan-vace", "video-inpaint-wan-vace-painted", "video-swap-wan-vace", "video-insert-wan-vace"]) {
      expect(byId.get(id)!.license, id).toMatch(/KJNodes \(GPL-3.0 code\)/);
      expect(byId.get(id)!.customNodes.map((c) => c.name)).toEqual(["ComfyUI-KJNodes"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Graph wiring the contract depends on (the bindings alone would not catch a re-wired graph).

type Link = [string, number];
const isLink = (v: unknown): v is Link => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "number";
const linkOf = (v: unknown): Link => {
  expect(isLink(v), JSON.stringify(v)).toBe(true);
  return v as Link;
};
/** Every node that reads output `out` of node `nid`. */
const readersOf = (g: ComfyWorkflow, nid: string, out = 0) =>
  Object.entries(g).filter(([, n]) => Object.values(n.inputs).some((v) => isLink(v) && v[0] === nid && v[1] === out));
const ofClass = (g: ComfyWorkflow, cls: string) => Object.entries(g).filter(([, n]) => n.class_type === cls);
/** A ComfyMathExpression, evaluated in JS (the graphs use only arithmetic, comparisons, min, max, floor and sqrt). */
const evalMath = (expr: unknown, vars: Record<string, number>): number =>
  Number(new Function("min", "max", "floor", "sqrt", ...Object.keys(vars), `return (${String(expr)});`)(Math.min, Math.max, Math.floor, Math.sqrt, ...Object.values(vars)));

const SAMPLE_SIZES = {
  vace: [
    [[832, 480, 1080, 1920], [464, 832]], // 9:16 phone clip, default budget
    [[832, 480, 1920, 1080], [832, 464]],
    [[1280, 720, 1920, 1080], [1280, 720]],
    [[832, 480, 1000, 1000], [624, 624]],
    [[1280, 720, 2560, 1080], [1280, 528]], // ultra-wide: capped at 1280 a side
  ],
  void: [
    [[672, 384, 640, 360], [672, 376]],
    [[672, 384, 360, 640], [376, 672]],
    [[1024, 576, 1920, 1080], [1024, 576]],
  ],
} as const;
const WINDOWS: Record<string, { cap: number; counts: [number, number][]; lengthUsers: string[]; model: string; workScales: number; sizes: (typeof SAMPLE_SIZES)[keyof typeof SAMPLE_SIZES] }> = {};
for (const id of ["video-inpaint-wan-vace", "video-inpaint-wan-vace-painted", "video-swap-wan-vace", "video-insert-wan-vace"]) {
  WINDOWS[id] = {
    cap: 81,
    counts: [[82, 81], [81, 81], [80, 77], [30, 29], [5, 5], [1, 1]],
    // The painted eraser also counts back from the window's last frame for the mask it hands on.
    lengthUsers: ["ComfyMathExpression", "ImageFromBatch", ...(id === "video-insert-wan-vace" ? ["RepeatImageBatch"] : []), ...(id.endsWith("-painted") ? ["ComfyMathExpression"] : []), "WanVaceToVideo"],
    model: "WanVaceToVideo",
    workScales: id.endsWith("-painted") || id === "video-insert-wan-vace" ? 2 : 1,
    sizes: SAMPLE_SIZES.vace,
  };
}
WINDOWS["video-erase-void"] = {
  cap: 197,
  counts: [[198, 197], [197, 197], [196, 189], [50, 45], [53, 53], [5, 5]],
  lengthUsers: ["ComfyMathExpression", "ImageFromBatch", "VOIDInpaintConditioning", "VOIDWarpedNoise"],
  model: "VOIDInpaintConditioning",
  workScales: 1,
  sizes: SAMPLE_SIZES.void,
};

describe("round-4 window graphs: VACE remove / swap / insert and VOID", () => {
  it.each(Object.entries(WINDOWS))("%s decodes only the window, counts its frames and keeps its sound the same length", (id, w) => {
    const m = byId.get(id)!;
    const g = graph(id);
    const [video] = m.bindings.video!;
    const [start] = m.bindings.startTime!;
    const [dur] = m.bindings.duration!;
    expect(m.bindings.frames, id).toBeUndefined();
    expect(m.bindings.startFrame, id).toBeUndefined();
    expect(g[video.node].class_type).toBe("LoadVideo");
    // Nothing decodes the whole clip: the loader feeds only Video Slice nodes (the window and a 0.1 s fps probe).
    expect(readersOf(g, video.node).map(([, n]) => n.class_type)).toEqual(["Video Slice", "Video Slice"]);
    const slice = g[start.node];
    expect([slice.class_type, start.input]).toEqual(["Video Slice", "start_time"]);
    expect(slice.inputs.video).toEqual([video.node, 0]);
    expect(g[dur.node].class_type).toBe("PrimitiveFloat");
    const span = g[linkOf(slice.inputs.duration)[0]];
    expect(span.inputs["values.a"]).toEqual([dur.node, 0]);
    const probeParts = g[linkOf(span.inputs["values.b"])[0]];
    expect(probeParts.class_type).toBe("GetVideoComponents");
    expect(linkOf(span.inputs["values.b"])[1]).toBe(2); // fps
    const probe = g[linkOf(probeParts.inputs.video)[0]];
    expect(probe.class_type).toBe("Video Slice");
    expect(probe.inputs).toMatchObject({ video: [video.node, 0], start_time: 0 });
    expect(Number(probe.inputs.duration)).toBeGreaterThan(0);
    expect(Number(probe.inputs.duration)).toBeLessThanOrEqual(0.1);
    expect(g[linkOf(span.inputs["values.c"])[0]].inputs.value).toBe(w.cap);
    const seconds = (a: number, b: number) => evalMath(span.inputs.expression, { a, b, c: w.cap });
    expect(seconds(0, 30)).toBeCloseTo((w.cap + 0.5) / 30, 9); // 0 = the longest window
    expect(seconds(1, 30)).toBe(1);
    expect(seconds(600, 25)).toBeCloseTo((w.cap + 0.5) / 25, 9); // never more than the cap

    // The window: its components, the frames kept (the largest 4n+1 / 8n+5 decoded, at most the cap), the cut.
    const [partsId] = readersOf(g, start.node).find(([, n]) => n.class_type === "GetVideoComponents")!;
    const [, cut] = readersOf(g, partsId, 0).find(([, n]) => n.class_type === "ImageFromBatch")!;
    expect(cut.inputs.batch_index).toBe(0);
    const framesLink = linkOf(cut.inputs.length);
    expect(framesLink[1]).toBe(1); // the INT output
    const frames = g[framesLink[0]];
    expect(frames.class_type).toBe("ComfyMathExpression");
    const decoded = linkOf(frames.inputs["values.a"]);
    expect([g[decoded[0]].class_type, decoded[1]]).toEqual(["GetImageSize", 2]); // batch_size
    expect(g[decoded[0]].inputs.image).toEqual([partsId, 0]);
    for (const [n, kept] of w.counts) expect(evalMath(frames.inputs.expression, { a: n, c: w.cap }), `${n} decoded`).toBe(kept);
    const users = Object.values(g).filter((n) => Object.values(n.inputs).some((v) => JSON.stringify(v) === JSON.stringify(framesLink)));
    expect(users.map((n) => n.class_type).sort()).toEqual([...w.lengthUsers].sort());

    // Sound: the window's own, trimmed to exactly the kept frames at the clip's fps, muxed with them.
    const [[trimId, trim]] = ofClass(g, "TrimAudioDuration");
    expect(trim.inputs).toMatchObject({ audio: [partsId, 1], start_index: 0 });
    expect(g[linkOf(trim.inputs.duration)[0]].inputs).toMatchObject({ expression: "a / b", "values.a": framesLink, "values.b": [partsId, 2] });
    const create = g[linkOf(g[m.outputs[0].node].inputs.video)[0]];
    expect(create.class_type).toBe("CreateVideo");
    expect(create.inputs).toMatchObject({ fps: [partsId, 2], audio: [trimId, 0] });
  });

  it.each(Object.entries(WINDOWS))("%s renders a work-size budget in the clip's own shape, scaled and never cropped", (id, w) => {
    const m = byId.get(id)!;
    const g = graph(id);
    expect(m.bindings.width).toHaveLength(1);
    expect(m.bindings.height).toHaveLength(1);
    const [bw] = m.bindings.width!;
    const [bh] = m.bindings.height!;
    expect([g[bw.node].class_type, g[bh.node].class_type]).toEqual(["PrimitiveInt", "PrimitiveInt"]);
    const scales = ofClass(g, "ImageScale");
    for (const [nid, n] of scales) expect(n.inputs.crop, `${id} node ${nid}`).toBe("disabled"); // the paste-back is exact
    const work = scales.filter(([, n]) => isLink(n.inputs.width) && g[(n.inputs.width as Link)[0]].class_type === "ComfyMathExpression");
    expect(work).toHaveLength(w.workScales); // the frames (and the painted mask)
    const [, first] = work[0];
    const fw = g[linkOf(first.inputs.width)[0]];
    const fh = g[linkOf(first.inputs.height)[0]];
    for (const e of [fw, fh]) {
      expect(e.inputs["values.a"]).toEqual([bw.node, 0]);
      expect(e.inputs["values.b"]).toEqual([bh.node, 0]);
      const [src] = linkOf(e.inputs["values.c"]);
      expect(g[src].class_type).toBe("GetImageSize");
      expect([e.inputs["values.c"], e.inputs["values.d"]]).toEqual([[src, 0], [src, 1]]);
    }
    for (const [[a, b, c, d], want] of w.sizes) expect([evalMath(fw.inputs.expression, { a, b, c, d }), evalMath(fh.inputs.expression, { a, b, c, d })], `${a}x${b} on ${c}x${d}`).toEqual(want);
    // Everything renders at that one size.
    for (const [, n] of [...work, ...ofClass(g, w.model)]) expect([n.inputs.width, n.inputs.height]).toEqual([first.inputs.width, first.inputs.height]);
    if (id === "video-erase-void") for (const [, n] of ofClass(g, "VOIDWarpedNoise")) expect([n.inputs.width, n.inputs.height]).toEqual([first.inputs.width, first.inputs.height]);
  });

  it("VOID's skipPass2 switch picks pass 1 when true and pass 2 when false", () => {
    const g = graph("video-erase-void");
    const [skip] = byId.get("video-erase-void")!.bindings.skipPass2!;
    expect(g[skip.node]).toMatchObject({ class_type: "PrimitiveBoolean", inputs: { value: false } });
    const [[, sw]] = readersOf(g, skip.node).filter(([, n]) => n.class_type === "ComfySwitchNode");
    const unetOf = (l: unknown) => {
      const decode = g[linkOf(l)[0]];
      expect(decode.class_type).toBe("VAEDecode");
      const sampler = g[linkOf(decode.inputs.samples)[0]];
      const guider = g[linkOf(sampler.inputs.guider)[0]];
      return g[linkOf(guider.inputs.model)[0]].inputs.unet_name;
    };
    expect(unetOf(sw.inputs.on_true)).toBe("void_pass1.safetensors");
    expect(unetOf(sw.inputs.on_false)).toBe("void_pass2.safetensors");
  });

  it("TripoSplat's cutout switch uses BiRefNet when true and the image's own alpha when false", () => {
    const g = graph("image-to-splat-triposplat");
    const w = byId.get("image-to-splat-triposplat")!;
    const [cut] = w.bindings.cutout!;
    const [img] = w.bindings.image!;
    const sw = g[cut.node];
    expect([sw.class_type, cut.input, sw.inputs.switch, w.defaults.cutout]).toEqual(["ComfySwitchNode", "switch", true, true]);
    const birefnet = g[linkOf(sw.inputs.on_true)[0]];
    expect(birefnet).toMatchObject({ class_type: "RemoveBackground", inputs: { image: [img.node, 0] } });
    expect(g[linkOf(sw.inputs.on_false)[0]]).toMatchObject({ class_type: "InvertMask", inputs: { mask: [img.node, 1] } });
    expect(readersOf(g, cut.node).map(([, n]) => n.class_type)).toEqual(["TripoSplatPreprocessImage"]);
  });

  it("the end card reads the ad's picture and its sound from the one upload", () => {
    const g = graph("video-append-endcard");
    const targets = byId.get("video-append-endcard")!.bindings.video!;
    expect(targets.map((t) => `${g[t.node].class_type}.${t.input}`)).toEqual(["LoadVideo.file", "LoadAudio.audio"]);
    const [concat] = ofClass(g, "ConcatenateVideo").map(([, n]) => n);
    expect(concat.inputs["videos.video0"]).toEqual([targets[0].node, 0]);
    const pad = g[linkOf(concat.inputs.complete_audio)[0]];
    expect(pad).toMatchObject({ class_type: "AudioConcat", inputs: { audio1: [targets[1].node, 0], direction: "after" } });
  });

  it("MoGe resizes on the longer edge, so tall portraits are capped too", () => {
    const g = graph("scene-mesh-moge");
    const [img] = byId.get("scene-mesh-moge")!.bindings.image!;
    const [[sizeId]] = readersOf(g, img.node).filter(([, n]) => n.class_type === "GetImageSize");
    const [[testId, test]] = readersOf(g, sizeId, 0).filter(([, n]) => n.class_type === "ComfyMathExpression");
    expect(test.inputs).toMatchObject({ "values.a": [sizeId, 0], "values.b": [sizeId, 1] });
    for (const [a, b, big] of [[1536, 3000, true], [3000, 1536, true], [2048, 2048, false], [1024, 768, false]] as const) expect(Boolean(evalMath(test.inputs.expression, { a, b })), `${a}x${b}`).toBe(big);
    const [[, sw]] = readersOf(g, testId, 2).filter(([, n]) => n.class_type === "ComfySwitchNode");
    expect(g[linkOf(sw.inputs.on_true)[0]]).toMatchObject({ class_type: "ResizeImagesByLongerEdge", inputs: { longer_edge: 2048 } });
    expect(sw.inputs.on_false).toEqual([img.node, 0]);
  });
});

// ---------------------------------------------------------------------------
// Every round-4 workflow bound for real through the provider (prepareWorkflow → applyBindings on the library graph).

const tmp = tempDir("fuobe-comfy-library-4-");
process.env.FUOBE_DATA_DIR = tmp;
process.env.COMFYUI_URL = "http://comfy.test:8188";
const { prepareWorkflow } = await import("@/server/providers/comfyui");

const GIVEN = new Set(["img1.png", "mask.png", "clip.mp4", "voice.wav", "voice2.wav", "curve.wav"]);
const portrait: MediaInfo = { container: "mp4", hasVideo: true, hasAudio: true, duration: 8, videoDuration: 8, width: 360, height: 640, fps: 30, frames: 240 };
async function prepare(id: string) {
  return prepareWorkflow(
    id,
    {
      prompt: "a quiet street",
      negativePrompt: "blurry",
      images: ["img1.png"],
      mask: "mask.png",
      video: "clip.mp4",
      audio: "voice.wav",
      startTime: 1,
      endTime: 3,
      seed: 7,
      extra: { audio2: "voice2.wav", fadeCurve: "curve.wav" },
    },
    // The round-4 operations live in the catalog-4 package; none of them changes how the bindings are filled.
    { generationId: "gen1", op: "v2v" as Operation, upload: async (_d, _t, name) => `up_${name}`, media: (n) => (n === "clip.mp4" ? portrait : undefined), serverRam: async () => undefined },
  );
}
const valuesAt = (wf: ComfyWorkflow, m: ManifestWorkflow, key: string) => (m.bindings[key] ?? []).map((t) => wf[t.node].inputs[t.input]);

describe("round-4 workflows through the provider", () => {
  it.each(Object.keys(ROUND4))("%s: every upload slot, the seed and the file prefix are filled", async (id) => {
    const { workflow, manifest: m } = await prepare(id);
    for (const [nid, n] of Object.entries(workflow)) {
      const inp = MEDIA[n.class_type];
      if (inp) expect(GIVEN.has(String(n.inputs[inp])), `${id} node ${nid} ${n.class_type}.${inp} = ${n.inputs[inp]}`).toBe(true);
      if ("filename_prefix" in n.inputs && m.outputs.some((o) => o.node === nid)) expect(n.inputs.filename_prefix, `${id} ${nid}`).toBe("fuobe/gen1");
    }
    for (const v of valuesAt(workflow, m, "seed")) expect(v).toBe(7);
  });

  it("fills the VACE / VOID window in seconds and the work-size budget, with no fps needed", async () => {
    for (const id of Object.keys(WINDOWS)) {
      const { workflow, manifest: m } = await prepare(id);
      expect(valuesAt(workflow, m, "startTime"), id).toEqual([1]);
      expect(valuesAt(workflow, m, "duration"), id).toEqual([2]);
      expect([...valuesAt(workflow, m, "width"), ...valuesAt(workflow, m, "height")], id).toEqual(id === "video-erase-void" ? [672, 384] : [832, 480]);
    }
  });

  it("fills the brief's frame window at its fixed 24 fps", async () => {
    const { workflow, manifest: m } = await prepare("reference-brief-gemma4");
    expect(valuesAt(workflow, m, "startFrame")).toEqual([24]);
    expect(valuesAt(workflow, m, "frames")).toEqual([49]);
  });
});
