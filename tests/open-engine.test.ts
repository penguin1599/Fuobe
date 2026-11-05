import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getModel, getPreset, MODELS } from "@/lib/catalog";
import { OPERATION_OUTPUT, type MediaKind, type Operation } from "@/lib/catalog/types";
import type { Manifest } from "@/lib/comfy";
import { planGeneration } from "@/lib/catalog/plan";
import { applySketch, stripMotionPaths } from "@/lib/catalog/sketch";
import { resample, tracksFor } from "@/lib/motion-paths";
import { ANGLES_FIELDS, ANGLES_ORIGINAL } from "@/lib/catalog/open-tools";
import { H3_BEST_GRAPH } from "@/lib/comfy-variants";
import { QWEN21_SPEED_GRAPH } from "@/lib/qwen21-speed";
import { H3_TIER_GRAPH } from "@/lib/gpu/h3-tier";

describe("motion paths (Wan-Move draw to video)", () => {
  it("resamples a path to evenly spaced points, one per frame", () => {
    const pts = resample([[0, 0], [1, 0], [1, 1]], 5);
    expect(pts.map(([x, y]) => [Number(x.toFixed(2)), Number(y.toFixed(2))])).toEqual([[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1]]);
  });

  it("scales normalised paths to the workflow's pixel grid", () => {
    const t = tracksFor({ aspect: [16, 9], paths: [[[0, 0], [1, 1]]] }, 833, 481, 3);
    expect(t).toEqual([[{ x: 0, y: 0 }, { x: 416, y: 240 }, { x: 832, y: 480 }]]);
  });

  it("keeps the clean start frame for Wan-Move and drops paths for other models", () => {
    const req = { feature: "video", prompt: "the boat sails off", inputs: { images: ["/a.png"], sketch: "/drawn.png" }, params: { extra: { motionPaths: { aspect: [1, 1], paths: [[[0, 0], [1, 1]]] } } } };
    const wm = getModel("oss-wan-move")!;
    const r = applySketch({ ...req, modelId: wm.id }, wm).request;
    expect(r.inputs?.images).toEqual(["/a.png"]);
    expect(r.prompt).toBe("the boat sails off");
    expect(planGeneration(r, getModel, getPreset).op).toBe("i2v");
    const kling = getModel("kling-2-5-turbo")!;
    expect(stripMotionPaths({ ...req, modelId: kling.id }, kling).params?.extra).toEqual({});
    expect(() => planGeneration({ feature: "video", modelId: wm.id, prompt: "x", inputs: { images: ["/a.png"] } }, getModel, getPreset)).toThrow(/Draw on the start frame/);
  });
});

describe("open-source voice", () => {
  it("needs a sample per speaker for Chatterbox dialogue", () => {
    const req = { feature: "audio", modelId: "oss-chatterbox-dialogue", params: { dialogue: [{ text: "Hi", voice: "A" }] } };
    expect(() => planGeneration(req, getModel, getPreset)).toThrow(/each speaker/);
    expect(planGeneration({ ...req, inputs: { voiceAudio: "/a.wav", voiceAudio2: "/b.wav" } }, getModel, getPreset).op).toBe("dialogue");
  });
  it("routes the relight app to the Relight LoRA workflow on the open engine", () => {
    expect(getPreset("app-relight")?.open?.modelId).toBe("oss-qwen-relight");
  });
});

/** The round-3 open models (docs/research/comfyui-oss-3.md), one or more per capability. */
const ROUND3_MODELS: Record<string, { op: Operation; kind: MediaKind; workflow: string }> = {
  "oss-qwen-layered": { op: "layers", kind: "image", workflow: "layers-qwen-image-layered" },
  "oss-qwen-layered-control": { op: "layers", kind: "image", workflow: "layers-qwen-image-layered-control" },
  "oss-style-qwen-edit": { op: "t2i", kind: "image", workflow: "style-ref-qwen-edit-2511" },
  "oss-style-flux2-klein": { op: "t2i", kind: "image", workflow: "style-ref-flux2-klein-4b" },
  "oss-style-krea2": { op: "t2i", kind: "image", workflow: "style-ref-krea2" },
  "oss-style-uso": { op: "t2i", kind: "image", workflow: "style-ref-uso-flux1" },
  "oss-zimage-palette": { op: "t2i", kind: "image", workflow: "palette-zimage-hex" },
  "oss-trim": { op: "trim", kind: "video", workflow: "video-trim" },
  "oss-segment": { op: "trim", kind: "video", workflow: "video-segment-resample" },
  "oss-wan22-vace-restyle": { op: "v2v", kind: "video", workflow: "video-restyle-wan22-fun-vace" },
  "oss-mixed-media": { op: "v2v", kind: "video", workflow: "mixed-media-zimage-frames" },
  "oss-stable-audio-3": { op: "sfx", kind: "audio", workflow: "sfx-stable-audio-3-small" },
  "oss-stable-audio-open": { op: "sfx", kind: "audio", workflow: "sfx-stable-audio-open" },
  "oss-hunyuan-foley": { op: "sfx", kind: "audio", workflow: "sfx-hunyuan-foley" },
  "oss-mmaudio-sfx": { op: "sfx", kind: "audio", workflow: "sfx-mmaudio-t2a" },
  "oss-thinksound": { op: "sfx", kind: "audio", workflow: "sfx-thinksound" },
  "oss-voice-separate": { op: "separate-audio", kind: "audio", workflow: "dub-prepare-separate-transcribe" },
  "oss-qwen3-asr": { op: "transcribe", kind: "text", workflow: "captions-qwen3-asr" },
  "oss-captions-burnin": { op: "captions", kind: "video", workflow: "captions-burnin" },
  "oss-captions-whisper": { op: "captions", kind: "video", workflow: "captions-whisper-burnin" },
  "oss-qwen35-translate": { op: "translate", kind: "text", workflow: "translate-qwen35-textgen" },
  "oss-gemma4-speech-translate": { op: "translate", kind: "text", workflow: "speech-translate-gemma4" },
  "oss-infinitetalk-v2v": { op: "lipsync", kind: "video", workflow: "lipsync-v2v-infinitetalk" },
  "oss-latentsync": { op: "lipsync", kind: "video", workflow: "lipsync-latentsync16" },
  "oss-mux": { op: "mux", kind: "video", workflow: "video-mux-audio" },
  "oss-pixal3d": { op: "image-to-3d", kind: "model3d", workflow: "image-to-3d-pixal3d" },
  "oss-trellis2": { op: "image-to-3d", kind: "model3d", workflow: "image-to-3d-trellis2" },
  "oss-hunyuan3d-21": { op: "image-to-3d", kind: "model3d", workflow: "image-to-3d-hunyuan3d-21" },
  "oss-tryon-klein": { op: "edit", kind: "image", workflow: "tryon-flux2-klein-4b" },
  "oss-zimage-grid": { op: "t2i", kind: "image", workflow: "grid-zimage-contact-sheet" },
  "oss-zimage-soul-cast": { op: "t2i", kind: "image", workflow: "soul-cast-sheet-zimage" },
  // round 4
  "oss-vtracer": { op: "vectorize", kind: "image", workflow: "image-vectorize-vtracer" },
};
const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "workflows/comfyui/manifest.json"), "utf8")) as Manifest;
const workflowById = new Map(manifest.workflows.map((w) => [w.id, w]));
/** Settings the ComfyUI provider consumes itself instead of writing them into a binding. */
// promptHelper: FLUX 3 Image Klein's Prompt helper, which the provider reads to take the helper's branch out (skipPromptHelper).
// hi3dRefine: read by the server (Refine detail · Hi3D 1.0 adds the refine step after the model, src/server/chains.ts), not the graph.
const PROVIDER_PARAMS = new Set(["wordsPerCaption", "paletteWeights", "cues", "promptHelper", "hi3dRefine"]);

describe("round-3 open models", () => {
  it.each(Object.entries(ROUND3_MODELS))("%s routes to its validated workflow", (id, want) => {
    const m = getModel(id);
    expect(m, id).toBeDefined();
    expect(m!.engine).toBe("open");
    expect(m!.badges).toContain("open");
    expect(m!.kind).toBe(want.kind);
    const route = m!.routes.find((r) => r.provider === "comfyui" && r.endpoint === want.workflow);
    expect(route?.op, `${id} route`).toBe(want.op);
    const wf = workflowById.get(want.workflow);
    expect(wf?.validated, want.workflow).toBe(true);
    // What the model makes is what the operation's rows say they hold (the feed and the mock provider use it).
    expect(OPERATION_OUTPUT[want.op] === m!.kind || (want.op === "t2i" && m!.kind === "image") || (want.op === "translate" && m!.kind === "text")).toBe(true);
    // Every slider or control reaches the workflow (pitfall: unknown extra keys are dropped silently).
    for (const p of [...(m!.options.sliders ?? []), ...(m!.options.controls ?? [])].map((s) => s.param)) {
      if (!PROVIDER_PARAMS.has(p)) expect(Object.keys(wf!.bindings), `${id}: ${p} is not a binding of ${want.workflow}`).toContain(p);
    }
    // Taglines tell people what the GPU asks of them (licences are on Thanks & licences).
    expect(m!.tagline, id).toMatch(/GB|CPU/);
  });

  it("keeps licences out of the taglines (Thanks & licences lists them)", () => {
    for (const id of ["oss-style-uso", "oss-mmaudio-sfx", "oss-captions-whisper", "oss-hunyuan-foley", "oss-stable-audio-3"]) expect(getModel(id)!.tagline, id).not.toMatch(/licen[cs]e|non-commercial|Apache|Community|US\$1M|South Korea/i);
    // Offered in their studios, and marked as running on the isolated worker.
    for (const id of ["oss-thinksound", "oss-latentsync"]) {
      expect(getModel(id)!.worker, id).toBe("isolated");
      expect(getModel(id)!.hidden, id).toBeFalsy();
    }
  });

  it("every open model's sliders and controls are bindings of its workflows", () => {
    for (const m of MODELS.filter((x) => x.engine === "open")) {
      for (const r of m.routes.filter((x) => x.provider === "comfyui")) {
        const ids = r.endpoint.includes("{n}") ? ["2", "3", "4"].map((n) => r.endpoint.replace("{n}", n)) : [r.endpoint];
        for (const wid of ids) {
          const keys = Object.keys(workflowById.get(wid)?.bindings ?? {});
          // A control that stands for several settings (MOSS-Image's Quality) is the settings it writes.
          // A control offered on some operations only (MiniMax H3's Quality: not on References) binds there only.
          const offered = (s: object) => {
            const ops = "ops" in s ? (s.ops as Record<string, string[]> | undefined) : undefined;
            return !ops || Object.values(ops).some((o) => o.includes(r.op));
          };
          const params = [...(m.options.sliders ?? []), ...(m.options.controls ?? [])].filter(offered).flatMap((s) =>
            "sets" in s && s.sets ? [...new Set(Object.values(s.sets).flatMap((v) => Object.keys(v)))] : [s.param],
          );
          for (const p of params) {
            // Fuobe Angles' camera fields become the Multiple-angles LoRA's words in the planner (src/lib/catalog/open-tools.ts).
            // MiniMax H3's Quality picks the graph that runs (its -hq graph: src/lib/comfy-variants.ts).
            if (p === "quality" && H3_BEST_GRAPH[wid]) continue;
            // Qwen-Image 2.1's Speed and GPU pick the graph that runs too (src/lib/qwen21-speed.ts).
            if ((p === "speed" || p === "gpu") && QWEN21_SPEED_GRAPH[wid]) continue;
            // QMA · 96 views' camera settings become its LoRA's words in the planner (src/lib/qma.ts, promptFormat "qma").
            if (m.options.promptFormat === "qma" && ["horizontal_angle", "vertical_angle", "zoom"].includes(p)) continue;
            // MiniMax H3's GPU tier picks the FastH3 graph that runs (src/lib/gpu/h3-tier.ts).
            if (p === "gpuTier" && H3_TIER_GRAPH[wid]) continue;
            if (!PROVIDER_PARAMS.has(p) && p !== "cameraMotion" && !(m.id === ANGLES_ORIGINAL && (ANGLES_FIELDS as readonly string[]).includes(p))) expect(keys, `${m.id} → ${wid}: ${p}`).toContain(p);
          }
        }
      }
    }
  });

  it("plans the new tools without a prompt, and asks for what's missing", () => {
    expect(planGeneration({ feature: "video", modelId: "oss-trim", inputs: { video: "/v.mp4" }, params: { startTime: 1, endTime: 3 } }, getModel, getPreset).op).toBe("trim");
    expect(() => planGeneration({ feature: "video", modelId: "oss-trim" }, getModel, getPreset)).toThrow(/video to trim/);
    expect(() => planGeneration({ feature: "video", modelId: "oss-mux", inputs: { video: "/v.mp4" } }, getModel, getPreset)).toThrow(/soundtrack/);
    expect(planGeneration({ feature: "image", modelId: "oss-qwen-layered", inputs: { images: ["/a.png"] }, params: { numLayers: 4 } }, getModel, getPreset).op).toBe("layers");
    expect(planGeneration({ feature: "captions", modelId: "oss-qwen3-asr", inputs: { video: "/v.mp4" } }, getModel, getPreset).op).toBe("transcribe");
    expect(() => planGeneration({ feature: "3d", modelId: "oss-trellis2" }, getModel, getPreset)).toThrow(/photo/);
    // Whisper transcribes by itself; the burn-in's provider asks for timed lines when they're missing.
    expect(planGeneration({ feature: "captions", modelId: "oss-captions-whisper", inputs: { video: "/v.mp4" } }, getModel, getPreset).op).toBe("captions");
    expect(() => planGeneration({ feature: "captions", modelId: "oss-captions-burnin" }, getModel, getPreset)).toThrow(/video to caption/);
  });

  it("asks for a model's own inputs before a job exists (style references, a named element, media to transcribe)", () => {
    const plan = (r: Record<string, unknown>) => () => planGeneration({ feature: "image", ...r } as Parameters<typeof planGeneration>[0], getModel, getPreset);
    for (const id of ["oss-style-qwen-edit", "oss-style-flux2-klein", "oss-style-krea2", "oss-style-uso"]) {
      expect(plan({ modelId: id, prompt: "a lighthouse at dawn" }), id).toThrow(/style reference|moodboard/);
      expect(plan({ modelId: id, prompt: "a lighthouse at dawn", inputs: { images: ["/board.png"] } })().op).toBe("t2i");
    }
    expect(plan({ modelId: "oss-qwen-layered-control", inputs: { images: ["/a.png"] } })).toThrow("Name the element to pull out, e.g. “the guitar”");
    expect(plan({ modelId: "oss-qwen-layered-control", prompt: "the guitar", inputs: { images: ["/a.png"] } })().op).toBe("layers");
    expect(plan({ modelId: "oss-qwen-layered", inputs: { images: ["/a.png"] } })().op).toBe("layers"); // the plain split needs no prompt
    expect(plan({ modelId: "oss-qwen3-asr" })).toThrow("Add the audio or video to transcribe");
    expect(plan({ modelId: "oss-qwen3-asr", inputs: { audio: "/a.wav" } })().op).toBe("transcribe");
    expect(plan({ modelId: "oss-voice-separate" })).toThrow("Add the audio or video to split");
    expect(plan({ modelId: "oss-voice-separate", inputs: { video: "/v.mp4" } })().op).toBe("separate-audio");
    expect(plan({ modelId: "oss-tryon-klein", prompt: "x", inputs: { images: ["/me.png"] } })).toThrow("Add a photo of the person, then the garment");
  });

  it("every open slider and control shows the value the workflow runs with when it is left alone", () => {
    // Sliders and controls send params.extra only after a change, so their default must be the workflow's own.
    const bound = (wid: string, key: string) => {
      const t = workflowById.get(wid)?.bindings[key]?.[0];
      if (!t) return undefined;
      const graph = JSON.parse(fs.readFileSync(path.join(process.cwd(), "workflows/comfyui", workflowById.get(wid)!.file), "utf8"));
      return graph[t.node]?.inputs[t.input];
    };
    const off: string[] = [];
    for (const m of MODELS.filter((x) => x.engine === "open")) {
      for (const r of m.routes.filter((x) => x.provider === "comfyui" && !x.endpoint.includes("{n}"))) {
        const wf = workflowById.get(r.endpoint);
        for (const c of [...(m.options.sliders ?? []), ...(m.options.controls ?? [])]) {
          if (PROVIDER_PARAMS.has(c.param) || c.default === undefined || !wf?.bindings[c.param]) continue;
          const runs = wf.defaults[c.param] ?? bound(r.endpoint, c.param);
          if (runs !== undefined && String(runs) !== String(c.default)) off.push(`${m.id} ${c.param}: shows ${c.default}, runs ${runs}`);
        }
      }
    }
    expect(off).toEqual([]);
  });

  it("runs Virtual Try-On on the try-on LoRA on the open engine", () => {
    const p = getPreset("app-virtual-try-on")!;
    expect(p.open).toMatchObject({ modelId: "oss-tryon-klein", op: "edit" });
    expect(p.parity).toMatch(/dresses you in the new one/);
    const plan = planGeneration({ feature: "app", presetId: p.id, modelId: "oss-tryon-klein", inputs: { images: ["/me.png", "/dress.png"] } }, getModel, getPreset);
    // The LoRA's trigger leads the words (the graph's own prefix would add it too), and the run carries the LoRA so
    // Settings → Models & licences can switch it off; the graph doesn't load it twice (injectLoras).
    expect(plan.prompt).toMatch(/^TRYON A full-body photo of a person/);
    expect(plan.loras.map((l) => l.file)).toEqual(["tryon-klein-4b.safetensors"]);
  });
});
