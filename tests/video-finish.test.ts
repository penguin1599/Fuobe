import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { FORMAT_INFO, formatList, formatsOf } from "@/lib/av/formats";
import { DEFAULT_FPS_TARGET, FPS_TARGETS, fpsFrames, fpsPlan, fpsSummary } from "@/lib/av/fps";
import { targetShortEdge, upscaledSize, upscaleFactorFor, upscaleTier } from "@/lib/av/upscale";
import { exportValues, framesPerPass, hdrColorSpace, upscaleShortSide, wholeClipBytes, wholeClipProblem, wholeClipTool } from "@/lib/av/video-finish";
import { getModel } from "@/lib/catalog";
import { buildPayload } from "@/lib/catalog/payload";
import { estimateCost, planGeneration } from "@/lib/catalog/plan";
import type { Generation, GenerationRequest, GenInput, ModelDef, Operation, OutputFile } from "@/lib/catalog/types";
import { explainComfyError, type ComfyWorkflow } from "@/lib/comfy";
import { clipOutcome, formatOf, settingsShape, settingsSummary, showsPrompt } from "@/lib/composer";
import { HUB_MODES } from "@/lib/hubs";
import type { MediaInfo } from "@/lib/media-probe";
import { editOnlyFormat, outputActions } from "@/lib/output-actions";
import { slimModel } from "@/lib/studio-catalog";
import { FPS_BOOST_STUDIO, SDR_TO_HDR_STUDIO, UPSCALE_STUDIO, VIDEO_EXPORT_STUDIO, VIDEO_UPSCALE_STUDIO } from "@/lib/studios";
import { tempDir } from "./helpers/temp-dir";

// The Upscale hub's video tools (r4/video-finish): FPS Boost and slow motion, SDR to HDR, pro export formats,
// the upscalers' options, and chunked open upscaling.

const model = (id: string) => {
  const m = getModel(id);
  if (!m) throw new Error(`no model ${id}`);
  return m;
};
const route = (id: string, op: Operation) => model(id).routes.find((r) => r.op === op)!;
const plan = (r: Omit<GenerationRequest, "feature">) => planGeneration({ feature: "test", ...r }, getModel, () => undefined);

describe("FPS Boost targets (source × m / n = target × slowdown)", () => {
  // docs/research/comfyui-oss-4.md §i: the multiplier m (FrameInterpolate) and every n-th frame kept (Select Every Nth).
  const TABLE: [number, number, number, number][] = [
    [24, 30, 5, 4],
    [24, 60, 5, 2],
    [24, 90, 15, 4],
    [24, 120, 5, 1],
    [30, 60, 2, 1],
    [30, 90, 3, 1],
    [30, 120, 4, 1],
    [60, 90, 3, 2],
    [60, 120, 2, 1],
    [25, 60, 12, 5],
  ];
  it.each(TABLE)("%i → %i fps: m %i, n %i, exact", (from, to, m, n) => {
    expect(fpsPlan(from, to)).toEqual({ multiplier: m, every: n, fps: to, exact: true });
  });

  it("drops frames for a lower target (m 1), and picks the cheapest exact pair", () => {
    expect(fpsPlan(60, 30)).toEqual({ multiplier: 1, every: 2, fps: 30, exact: true });
    expect(fpsPlan(30, 24)).toEqual({ multiplier: 4, every: 5, fps: 24, exact: true });
    expect(fpsPlan(24, 24)).toEqual({ multiplier: 1, every: 1, fps: 24, exact: true });
  });

  it("slows down by asking for target × slowdown, and plays at the target", () => {
    expect(fpsPlan(24, 60, 2)).toEqual({ multiplier: 5, every: 1, fps: 60, exact: true });
    expect(fpsPlan(30, 30, 4)).toEqual({ multiplier: 4, every: 1, fps: 30, exact: true });
    // 24 → 120 fps at 8× needs 40× the frames: the closest the 16× cap allows, at the clip's exact length.
    const capped = fpsPlan(24, 120, 8);
    expect(capped).toMatchObject({ multiplier: 16, every: 1, exact: false });
    expect(capped.fps).toBe(48);
  });

  it("takes the nearest pair for header rates like 29.97, and says it isn't exact", () => {
    const p = fpsPlan(30000 / 1001, 60);
    expect(p).toMatchObject({ multiplier: 2, every: 1, exact: false });
    expect(p.fps).toBeCloseTo(59.94, 2);
    expect(() => fpsPlan(0, 60)).toThrow(/positive/);
  });

  it("counts the frames the open graph writes (the last frame held once more)", () => {
    // Checked on the CPU server: 48 frames at 24 fps → 121 frames at 60 fps; 60 at 30 → 49 at 24.
    expect(fpsFrames(48, { multiplier: 5, every: 2 })).toBe(121);
    expect(fpsFrames(60, { multiplier: 4, every: 5 })).toBe(49);
    expect(fpsSummary(24, 60)).toBe("24 → 60 fps");
    expect(fpsSummary(undefined, 90, 2)).toBe("90 fps · 2× slow motion");
    expect([...FPS_TARGETS]).toEqual([24, 30, 60, 90, 120]);
    expect(DEFAULT_FPS_TARGET).toBe(60);
  });
});

describe("upscale targets", () => {
  it("reads tiers as the result's shorter edge", () => {
    expect(["720p", "1080p", "1440p", "2160p", "2K", "4K", "4k", "8k", "1k", "Original", undefined].map(targetShortEdge)).toEqual([720, 1080, 1440, 2160, 1440, 2160, 2160, 4320, 1080, undefined, undefined]);
  });

  it("turns a tier into a factor of the clip's size, within the API's limits", () => {
    const hd = { width: 1280, height: 720 };
    expect(upscaleFactorFor("4K", hd)).toBe(3);
    expect(upscaleFactorFor("1080p", hd)).toBe(1.5);
    expect(upscaleFactorFor("Original", hd)).toBe(1);
    expect(upscaleFactorFor("4K", { width: 640, height: 360 })).toBe(4);
    // FLUX.3 Upscale takes 1.5–3×.
    expect(upscaleFactorFor("1440p", { width: 1920, height: 1080 }, 1.5, 3)).toBe(1.5);
    expect(upscaleFactorFor("1080p", { width: 854, height: 480 }, 1.5, 3)).toBe(2.25);
    expect(upscaleFactorFor("1440p", { width: 1920, height: 1080 })).toBe(1.333);
    expect(upscaledSize({ width: 1920, height: 1080 }, "1440p", 1.333)).toEqual({ width: 2560, height: 1440 });
    expect(upscaleFactorFor("4K", undefined)).toBeUndefined();
    expect(upscaledSize({ width: 720, height: 1280 }, "1080p")).toEqual({ width: 1080, height: 1920 });
    expect(upscaledSize({ width: 1280, height: 720 }, "Original")).toEqual({ width: 1280, height: 720 });
  });

  it("never runs a tier that leaves the clip as it is or shrinks it: a default moves up, a picked one is refused", () => {
    const topaz = model("topaz-video").options.resolutions;
    const esrgan = model("oss-upscale-video-esrgan").options.resolutions;
    const fhd = { width: 1920, height: 1080 };
    expect(upscaleTier("4K", topaz, fhd, true)).toEqual({ resolution: "4K" });
    expect(upscaleTier("1080p", topaz, fhd, false)).toEqual({ resolution: "1440p" });
    expect(upscaleTier("1080p", topaz, fhd, true)).toEqual({ error: "This clip is already 1080p — pick a higher resolution, or Original to only clean it up" });
    // Topaz at its top tier: only cleaning up is left.
    expect(upscaleTier("1080p", topaz, { width: 3840, height: 2160 }, false)).toEqual({ resolution: "Original" });
    // Chunked ESRGAN would scale a 4K source down to 1080p.
    expect(upscaleTier("1080p", esrgan, { width: 3840, height: 2160 }, false)).toEqual({ error: "This clip is already 2160p: 1080p would make it smaller — this model upscales no further" });
    expect(upscaleTier("1080p", esrgan, { width: 720, height: 1280 }, true)).toEqual({ resolution: "1080p" });
    expect(upscaleTier("1080p", esrgan, undefined, false)).toEqual({ resolution: "1080p" });
  });
});

describe("Upscale hub modes", () => {
  it("has one path per mode: Image, Video, FPS Boost, SDR to HDR, Export", () => {
    expect(HUB_MODES.upscale.map((m) => m.id)).toEqual(["image", "video", "fps", "hdr", "export"]);
  });

  it("plans each mode on both engines with the studio's default model", () => {
    const video = "/api/files/uploads/clip.mp4";
    for (const [config, op] of [
      [VIDEO_UPSCALE_STUDIO, "upscale-video"],
      [FPS_BOOST_STUDIO, "interpolate"],
      [SDR_TO_HDR_STUDIO, "sdr-to-hdr"],
      [VIDEO_EXPORT_STUDIO, "export-video"],
    ] as const) {
      for (const engine of ["cloud", "open"] as const) {
        const id = config.defaultModels[engine];
        if (!id) continue;
        const m = model(id);
        expect(m.engine, id).toBe(engine);
        const p = plan({ modelId: id, op, inputs: { video }, params: { ...m.defaults } });
        expect(p.op, id).toBe(op);
        expect(p.jobs, id).toBe(1);
      }
    }
    // Export has no cloud model: no API re-encodes a finished clip, and the server runs no ffmpeg.
    expect(VIDEO_EXPORT_STUDIO.defaultModels.cloud).toBe("");
    expect(VIDEO_EXPORT_STUDIO.comfyOnly?.alternative?.href).toBe("/upscale/hdr?model=topaz-sdr-to-hdr&format=prores_422_hq");
    expect(model("topaz-sdr-to-hdr").options.formats).toContain("prores_422_hq");
  });

  it("offers each engine's formats, and refuses one the model doesn't write", () => {
    const cloud = ["topaz-sdr-to-hdr", "ltx-2-3-hdr"].map(model);
    expect(formatsOf(cloud)).toEqual(["h265_10bit", "prores_422_hq", "exr"]);
    expect(model("oss-sdr-to-hdr").options.formats).toEqual(["hlg_10bit", "pq_10bit", "exr"]);
    expect(model("oss-export-video").options.formats).toEqual(["prores_422_hq", "prores_4444", "h265_10bit", "ffv1", "h264", "exr"]);
    expect(() => plan({ modelId: "topaz-sdr-to-hdr", op: "sdr-to-hdr", inputs: { video: "v.mp4" }, params: { format: "exr" } })).toThrow(
      "Topaz SDR to HDR writes H.265 10-bit or ProRes 422 HQ, not EXR 16-bit",
    );
    expect(formatList(["prores_422_hq", "prores_4444", "ffv1"])).toBe("ProRes 422 HQ, ProRes 4444 or FFV1");
    for (const f of Object.values(FORMAT_INFO)) expect(f.hint.length).toBeGreaterThan(20);
  });

  it("prices clip-length tools by the clip's seconds, slow motion by the result's", () => {
    const fps = model("topaz-fps-boost");
    expect(estimateCost(fps, { targetFps: 60, sourceDuration: 10 }, 1, "interpolate")).toBe(0.3);
    expect(estimateCost(fps, { targetFps: 60, slowdown: 2, sourceDuration: 10 }, 1, "interpolate")).toBe(0.6);
    expect(estimateCost(model("topaz-sdr-to-hdr"), { format: "prores_422_hq", sourceDuration: 12 }, 1, "sdr-to-hdr")).toBe(2.88);
    expect(estimateCost(model("topaz-video"), { resolution: "4K", sourceDuration: 10 }, 1, "upscale-video")).toBe(0.6);
    // Without the clip's length: the model's default seconds, as before.
    expect(estimateCost(fps, {}, 1, "interpolate")).toBe(0.15);
    for (const id of ["oss-rife", "oss-sdr-to-hdr", "oss-export-video", "oss-seedvr2", "oss-upscale-video-esrgan"]) expect(estimateCost(model(id), { sourceDuration: 30 }, 1, "upscale-video"), id).toBe(0);
  });

  it("prices the settings that change the price: 60 fps, ByteDance Pro, FLUX.3 Creative, Starlight Fast 2, Aion", () => {
    const at = (id: string, params: GenerationRequest["params"]) => estimateCost(model(id), { sourceDuration: 10, ...params }, 1, "upscale-video");
    expect(at("topaz-video", { resolution: "1080p", targetFps: 30 })).toBe(0.2);
    expect(at("topaz-video", { resolution: "1080p", targetFps: 60 })).toBe(0.4);
    expect(at("bytedance-video-upscale", { resolution: "1080p" })).toBe(0.072);
    expect(at("bytedance-video-upscale", { resolution: "1080p", extra: { enhancement_tier: "pro" } })).toBe(0.72);
    expect(at("bytedance-video-upscale", { resolution: "1080p", targetFps: 60, extra: { enhancement_tier: "pro" } })).toBe(1.44);
    expect(at("flux-video-upscale", { resolution: "1440p", extra: { creativity: 1 } })).toBe(2.1);
    expect(at("flux-video-upscale", { resolution: "1440p", extra: { creativity: 0 } })).toBe(1.5);
    expect(at("topaz-starlight", { resolution: "4K", extra: { model: "Starlight Fast 2" } })).toBe(1.3);
    expect(estimateCost(model("topaz-fps-boost"), { targetFps: 60, sourceDuration: 10, extra: { model: "Aion" } }, 1, "interpolate")).toBe(0.501);
  });

  it("shows the prompt box only for a model that reads one: FLUX.3 Upscale's details to keep", () => {
    const flux = model("flux-video-upscale").options;
    expect(showsPrompt(VIDEO_UPSCALE_STUDIO, flux)).toBe(true);
    expect(VIDEO_UPSCALE_STUDIO.modelPrompt).toBe(UPSCALE_STUDIO.modelPrompt);
    for (const id of ["topaz-video", "topaz-starlight", "bytedance-video-upscale", "seedvr-video", "oss-seedvr2", "oss-upscale-video-esrgan"]) expect(showsPrompt(VIDEO_UPSCALE_STUDIO, model(id).options), id).toBe(false);
    // A studio that hides the box without wording one keeps it hidden; presets and promptless models never show it.
    expect(showsPrompt(SDR_TO_HDR_STUDIO, flux)).toBe(false);
    expect(showsPrompt({}, flux, "none")).toBe(false);
    expect(showsPrompt({}, model("topaz-video").options)).toBe(false);
    expect(showsPrompt({}, {})).toBe(true);
    // FLUX.3 sends what was typed, and leaves the prompt out when nothing was.
    const map = route("flux-video-upscale", "upscale-video").map!;
    expect(buildPayload(map, { video: "v", prompt: "the lettering on the sign", resolution: "4K", sourceSize: { width: 1280, height: 720 } })).toMatchObject({ prompt: "the lettering on the sign", upscale_factor: 3 });
    expect(buildPayload(map, { video: "v", prompt: "  ", resolution: "4K" })).not.toHaveProperty("prompt");
  });
});

describe("cloud payloads", () => {
  it("Topaz FPS Boost: target_fps, slowdown_factor and the model enum, H.264 by default", () => {
    const map = route("topaz-fps-boost", "interpolate").map!;
    expect(buildPayload(map, { video: "v", targetFps: 90, slowdown: 2, extra: { model: "Chronos" } })).toEqual({ video_url: "v", target_fps: 90, slowdown_factor: 2, H264_output: true, model: "Chronos" });
    expect(buildPayload(map, { video: "v", targetFps: 240, slowdown: 9.6 })).toMatchObject({ target_fps: 120, slowdown_factor: 8 });
    expect(model("topaz-fps-boost").options.controls?.[0]).toMatchObject({ param: "model", values: ["Apollo", "Chronos", "Aion"], default: "Apollo" });
    expect(model("topaz-fps-boost").options).toMatchObject({ fpsTargets: [24, 30, 60, 90, 120], slowdowns: [1, 2, 4, 8] });
  });

  it("Topaz SDR to HDR: output_format mp4 (HDR10 H.265) or prores", () => {
    const map = route("topaz-sdr-to-hdr", "sdr-to-hdr").map!;
    expect(buildPayload(map, { video: "v", format: "h265_10bit" })).toEqual({ video_url: "v", output_format: "mp4" });
    expect(buildPayload(map, { video: "v", format: "prores_422_hq" })).toEqual({ video_url: "v", output_format: "prores" });
  });

  it("LTX HDR counts the clip's frames for its EXR job", () => {
    const map = route("ltx-2-3-hdr", "sdr-to-hdr").map!;
    expect(buildPayload(map, { video: "v", format: "exr", sourceDuration: 5 }).num_frames).toBe(120);
  });

  it("Topaz Video: a tier becomes upscale_factor from the clip's size; frame rate within 16–60; Higgsfield's presets", () => {
    const map = route("topaz-video", "upscale-video").map!;
    const hd: GenInput = { video: "v", sourceSize: { width: 1280, height: 720 } };
    expect(buildPayload(map, { ...hd, resolution: "4K", targetFps: 60, extra: { model: "Artemis High Quality", noise: 0.4 } })).toEqual({
      video_url: "v",
      upscale_factor: 3,
      target_fps: 60,
      H264_output: true,
      model: "Artemis High Quality",
      noise: 0.4,
    });
    expect(buildPayload(map, { ...hd, resolution: "Original" }).upscale_factor).toBe(1);
    expect(buildPayload(map, { ...hd, resolution: "4K", targetFps: 120 }).target_fps).toBe(60);
    // Size unknown: the API's own default factor.
    expect(buildPayload(map, { video: "v", resolution: "4K" })).not.toHaveProperty("upscale_factor");
    const values = model("topaz-video").options.controls?.find((c) => c.param === "model")?.values ?? [];
    for (const v of ["Proteus", "Artemis High Quality", "Iris", "Rhea", "Gaia HQ", "Theia Fine Tune Detail"]) expect(values).toContain(v);
    expect(model("topaz-video").options).toMatchObject({ resolutions: ["Original", "1080p", "1440p", "4K"], fpsTargets: [24, 30, 60] });
  });

  it("Topaz Starlight, ByteDance (to 8K, presets), FLUX.3 (1.5–3×, Precise / Creative), SeedVR2 in target mode", () => {
    const hd: GenInput = { video: "v", sourceSize: { width: 1280, height: 720 } };
    expect(buildPayload(route("topaz-starlight", "upscale-video").map!, { ...hd, resolution: "4K" })).toMatchObject({ upscale_factor: 3, H264_output: true });
    expect(model("topaz-starlight").options.controls?.[0]).toMatchObject({ values: expect.arrayContaining(["Starlight Precise 2.6", "Starlight Fast 2"]), default: "Starlight Precise 2.6" });

    const bd = model("bytedance-video-upscale");
    expect(bd.options.resolutions).toEqual(["1080p", "2k", "4k", "6k", "8k"]);
    expect(buildPayload(route(bd.id, "upscale-video").map!, { video: "v", resolution: "8k", targetFps: 60, extra: { enhancement_preset: "old_film", enhancement_tier: "pro" } })).toEqual({
      video_url: "v",
      target_resolution: "8k",
      target_fps: 60,
      enhancement_preset: "old_film",
      enhancement_tier: "pro",
    });
    expect(bd.options.controls?.find((c) => c.param === "enhancement_preset")?.labels).toMatchObject({ general: "Common", aigc: "AI-generated video", old_film: "Old film" });

    const flux = route("flux-video-upscale", "upscale-video").map!;
    expect(buildPayload(flux, { video: "v", sourceSize: { width: 854, height: 480 }, resolution: "1080p" })).toEqual({ video_url: "v", upscale_factor: 2.25, creativity: 0 });
    expect(buildPayload(flux, { video: "v", sourceSize: { width: 1920, height: 1080 }, resolution: "1440p", prompt: "keep the logo crisp", extra: { creativity: 1 } })).toEqual({
      video_url: "v",
      prompt: "keep the logo crisp",
      upscale_factor: 1.5,
      creativity: 1,
    });
    expect(buildPayload(flux, { video: "v", prompt: "" })).not.toHaveProperty("prompt");
    expect(model("flux-video-upscale").options.controls?.[0].labels).toEqual({ "0": "Precise", "1": "Creative" });

    expect(buildPayload(route("seedvr-video", "upscale-video").map!, { video: "v", resolution: "2160p" })).toMatchObject({ target_resolution: "2160p", upscale_mode: "target" });
  });
});

describe("composer: settings and what comes out", () => {
  const facts = { width: 1280, height: 720, fps: 24, duration: 10 };
  it("shows frame rate, slow motion and format, with the clip's own rate as Original where there's no default", () => {
    const topazFps = model("topaz-fps-boost");
    const shape = settingsShape(topazFps, "interpolate", "video", false, {});
    expect(shape.fps).toEqual({ values: [24, 30, 60, 90, 120], original: false });
    expect(shape.slowdown).toEqual([1, 2, 4, 8]);
    expect(settingsSummary(shape, { slowdown: 2 }, topazFps)).toEqual(["60 fps", "2× slow"]);
    expect(settingsShape(model("topaz-video"), "upscale-video", "video", false, {}).fps).toEqual({ values: [24, 30, 60], original: true });

    const ltx = model("ltx-2-3-hdr");
    const hdr = settingsShape(ltx, "sdr-to-hdr", "video", false, {}, [], ["h265_10bit", "prores_422_hq", "exr"]);
    expect(hdr.formats).toEqual(["h265_10bit", "prores_422_hq", "exr"]);
    // The format shown is the model's own (LTX writes EXR), not the studio's first.
    expect(formatOf({}, ltx, hdr.formats!)).toBe("exr");
    expect(settingsSummary(hdr, {}, ltx)).toContain("EXR 16-bit");
    expect(formatOf({}, model("oss-export-video"))).toBe("prores_422_hq");
  });

  it("says what each tool makes of the clip", () => {
    expect(clipOutcome("upscale-video", facts, { resolution: "4K" }, model("topaz-video"))).toBe("1280×720 → 3840×2160");
    expect(clipOutcome("upscale-video", facts, { resolution: "Original", targetFps: 60 }, model("topaz-video"))).toBe("1280×720, cleaned up at its own size · 60 fps");
    expect(clipOutcome("upscale-video", { ...facts, width: 1920, height: 1080 }, { resolution: "1080p" }, model("topaz-video"))).toBe(
      "This clip is already 1080p — pick a higher resolution, or Original to only clean it up",
    );
    expect(clipOutcome("upscale-video", facts, {}, model("oss-upscale-video-esrgan"))).toBe("1280×720 → 1920×1080");
    expect(clipOutcome("interpolate", facts, { slowdown: 2 }, model("topaz-fps-boost"))).toBe("24 → 60 fps · 2× slow motion · 10 s → 20 s");
    expect(clipOutcome("interpolate", { ...facts, fps: 30000 / 1001 }, { targetFps: 60 }, model("oss-rife"))).toBe("29.97 → about 59.94 fps (the nearest this clip's rate allows)");
    expect(clipOutcome("interpolate", { ...facts, fps: 30000 / 1001 }, { targetFps: 60 }, model("topaz-fps-boost"))).toBe("29.97 → 60 fps");
    expect(clipOutcome("interpolate", facts, {}, model("rife-video-cloud"))).toBe("Twice the frames: 24 → 48 fps");
    expect(clipOutcome("sdr-to-hdr", facts, { format: "prores_422_hq" }, model("topaz-sdr-to-hdr"))).toBe("1280×720 · 10 s → ProRes 422 HQ, .mov");
    expect(clipOutcome("export-video", facts, { format: "exr" }, model("oss-export-video"))).toBe("1280×720 · 10 s → EXR 16-bit (240 frames), .zip");
    expect(clipOutcome("export-video", {}, {}, model("oss-export-video"))).toBeNull();
  });

  it("keeps an API's factor range and a frame-count route's cap in the line, also from the browser's slim catalog", () => {
    for (const m of [model("flux-video-upscale"), slimModel(model("flux-video-upscale"))]) {
      // 1440p of a 1080p clip is 1.33×; FLUX.3 takes 1.5× at least.
      expect(clipOutcome("upscale-video", { width: 1920, height: 1080, fps: 24, duration: 10 }, { resolution: "1440p" }, m)).toBe("1920×1080 → 2880×1620 (FLUX.3 Upscale upscales at least 1.5×)");
    }
    // 4K of 480p is 4.5×; Topaz stops at 4×.
    expect(clipOutcome("upscale-video", { width: 854, height: 480 }, { resolution: "4K" }, slimModel(model("topaz-video")))).toBe("854×480 → 3416×1920 (Topaz Video upscales at most 4×)");
    expect(clipOutcome("upscale-video", { width: 1280, height: 720 }, { resolution: "4K" }, slimModel(model("topaz-video")))).toBe("1280×720 → 3840×2160");
    // A default tier the clip already has moves up, as the server does.
    expect(clipOutcome("upscale-video", { width: 1920, height: 1080 }, {}, model("topaz-video"))).toBe("1920×1080 → 2560×1440 · 1440p, as the clip is already 1080p");
    // LTX 2.3 HDR renders 24 fps and at most 481 frames: a 30 s clip is cut to its first 20 s.
    const ltx = slimModel(model("ltx-2-3-hdr"));
    expect(ltx.routes[0]).not.toHaveProperty("map");
    expect(ltx.routes[0].preview).toEqual({ numFrames: { key: "num_frames", fps: 24, min: 9, max: 481 } });
    expect(clipOutcome("sdr-to-hdr", { width: 1280, height: 720, fps: 30, duration: 30 }, {}, ltx)).toBe(
      "1280×720 · 30 s → EXR 16-bit (481 frames at 24 fps: only the first 20 s, the most LTX 2.3 HDR takes), .zip",
    );
    expect(clipOutcome("sdr-to-hdr", { width: 1280, height: 720, fps: 30, duration: 10 }, {}, ltx)).toBe("1280×720 · 10 s → EXR 16-bit (240 frames at 24 fps), .zip");
    expect(slimModel(model("topaz-sdr-to-hdr")).routes[0]).not.toHaveProperty("preview");
  });
});

describe("results", () => {
  const gen = (o: OutputFile, params: GenerationRequest["params"], op: Operation): Generation =>
    ({ id: "g1abcdef", op, kind: "video", modelId: "m", feature: "export-video", outputs: [o], request: { feature: "export-video", modelId: "m", params }, favorite: false }) as unknown as Generation;

  it("offers the EXR zip next to the preview clip", () => {
    const o: OutputFile = { url: "/api/files/outputs/x/preview.mp4", kind: "video", meta: { artifacts: { exr: "/api/files/outputs/x/frames.zip" } } };
    const a = outputActions(gen(o, { format: "exr" }, "export-video"), 0).find((x) => x.id === "download-exr");
    expect(a).toMatchObject({ label: "Download EXR frames (.zip)", placement: "bar", href: expect.stringMatching(/^\/api\/files\/outputs\/x\/frames\.zip\?download=.+-exr\.zip$/) });
    // A provider link that couldn't be stored is still offered (it expires), as it is.
    expect(outputActions(gen({ ...o, meta: { artifacts: { exr: "https://cdn.example/frames.zip" } } }, {}, "sdr-to-hdr"), 0).find((x) => x.id === "download-exr")).toMatchObject({
      label: "Download EXR frames (.zip, provider link)",
      href: "https://cdn.example/frames.zip",
    });
    expect(outputActions(gen({ ...o, meta: { artifacts: { exr: "javascript:alert(1)" } } }, {}, "sdr-to-hdr"), 0).some((x) => x.id === "download-exr")).toBe(false);
  });

  it("shows ProRes and FFV1 files as files for an editor, not as a black player", () => {
    const mov: OutputFile = { url: "/api/files/outputs/x/a.mov", kind: "video" };
    expect(editOnlyFormat(gen(mov, { format: "prores_4444" }, "export-video"), mov)).toBe("prores_4444");
    expect(editOnlyFormat(undefined, { url: "/api/files/outputs/x/a.mkv", kind: "video" })).toBe("ffv1");
    // Demo runs return a playable .mp4 whatever the format.
    const mp4: OutputFile = { url: "/api/files/outputs/x/a.mp4", kind: "video" };
    expect(editOnlyFormat(gen(mp4, { format: "prores_422_hq" }, "export-video"), mp4)).toBeUndefined();
    expect(editOnlyFormat(gen(mov, { format: "prores_422_hq" }, "upscale-video"), mov)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The open engine: values and graph edits prepareWorkflow makes for each tool.

const tmp = tempDir("fuobe-video-finish-");
process.env.FUOBE_DATA_DIR = tmp;
process.env.COMFYUI_URL = "http://127.0.0.1:9";
const { prepareWorkflow, comfyProvider, CANCEL_SWEEPS } = await import("@/server/providers/comfyui");
const { db } = await import("@/server/db");
const { zipToFile } = await import("@/server/zip");
const { mediaFacts } = await import("@/server/media-facts");
const { setSetting } = await import("@/server/settings");
const gens = await import("@/server/generations");
const { saveFile } = await import("@/server/storage");

const clip = (o: Partial<MediaInfo>): MediaInfo => ({ container: "mp4", hasVideo: true, hasAudio: true, duration: 4, videoDuration: 4, width: 1280, height: 720, fps: 24, frames: 96, ...o });
async function prep(endpoint: string, op: Operation, input: GenInput, info: MediaInfo = clip({}), ram = 64 * 2 ** 30) {
  return prepareWorkflow(endpoint, { video: "clip.mp4", seed: 7, ...input }, { generationId: "gen1", op, upload: async (_d, _t, n) => `up_${n}`, media: (n) => (n === "clip.mp4" ? info : undefined), serverRam: async () => ram });
}
const byClass = (wf: ComfyWorkflow, type: string) => Object.entries(wf).filter(([, n]) => n.class_type === type);
const one = (wf: ComfyWorkflow, type: string) => {
  const found = byClass(wf, type);
  expect(found, type).toHaveLength(1);
  return found[0][1];
};

describe("open FPS Boost (interpolate-rife-fps)", () => {
  it("binds m and n from the clip's own frame rate", async () => {
    const { workflow: wf, manifest } = await prep("interpolate-rife-fps", "interpolate", { targetFps: 60 });
    expect(manifest.id).toBe("interpolate-rife-fps");
    expect([wf["6"].inputs.value, wf["8"].inputs.value, wf["10"].inputs.value]).toEqual([5, 2, 1]);
    expect(one(wf, "CreateVideo").inputs.audio).toEqual(["2", 1]);
    expect(one(wf, "FrameInterpolationModelLoader").inputs.model_name).toBe("rife_v4.26.safetensors");
    // 30 fps → 90: m 3; FILM picked in the Options chip.
    const film = await prep("interpolate-rife-fps", "interpolate", { targetFps: 90, extra: { checkpoint: "film_net_fp16.safetensors" } }, clip({ fps: 30 }));
    expect([film.workflow["6"].inputs.value, film.workflow["8"].inputs.value]).toEqual([3, 1]);
    expect(one(film.workflow, "FrameInterpolationModelLoader").inputs.model_name).toBe("film_net_fp16.safetensors");
  });

  it("slow motion stretches the clip and drops its sound; a stray multiplier can't break the ratio", async () => {
    const { workflow: wf } = await prep("interpolate-rife-fps", "interpolate", { targetFps: 60, slowdown: 2, extra: { multiplier: 9, every: 7 } });
    expect([wf["6"].inputs.value, wf["8"].inputs.value, wf["10"].inputs.value]).toEqual([5, 1, 2]);
    expect(one(wf, "CreateVideo").inputs).not.toHaveProperty("audio");
  });

  it("a lower target only keeps every n-th frame: FrameInterpolate is linked out and the rate reads m = 1", async () => {
    const { workflow: wf } = await prep("interpolate-rife-fps", "interpolate", { targetFps: 30 }, clip({ fps: 60, frames: 240 }));
    expect(byClass(wf, "FrameInterpolate")).toHaveLength(0);
    expect(byClass(wf, "FrameInterpolationModelLoader")).toHaveLength(0);
    expect(one(wf, "VHS_SelectEveryNthImage").inputs.images).toEqual(["4", 0]);
    expect([wf["6"].inputs.value, wf["8"].inputs.value]).toEqual([1, 2]);
    expect(one(wf, "ComfyMathExpression").inputs["values.b"]).toEqual(["6", 0]);
  });

  it("refuses a clip whose interpolated frames don't fit in the server's RAM", async () => {
    const long = clip({ width: 1920, height: 1080, fps: 30, duration: 60, videoDuration: 60, frames: 1800 });
    await expect(prep("interpolate-rife-fps", "interpolate", { targetFps: 120 }, long, 32 * 2 ** 30)).rejects.toThrow(
      /FPS Boost on the open engine holds the whole clip in memory: this one needs about \d+ GB of RAM and this ComfyUI can spare 16 GB\. Trim it first \(Video tools → Trim\), or pick a lower frame rate/,
    );
    expect(wholeClipBytes({ width: 100, height: 100, frames: 10 }, 2)).toBe(100 * 100 * 12 * 10 * 2);
  });

  it("counts the copies the graph really holds: the source, its padded copy and m interpolated frames per frame", async () => {
    // 5 s of 1080p at 24 fps → 60 fps is m 5: 7 copies of 120 frames, about 20 GB (Select Every Nth is a view).
    const fhd = clip({ width: 1920, height: 1080, fps: 24, duration: 5, videoDuration: 5, frames: 120 });
    expect(wholeClipTool("interpolate", undefined, 5)).toMatchObject({ copies: 7 });
    expect(wholeClipTool("interpolate", undefined, 1)).toMatchObject({ copies: 2 });
    const message = "FPS Boost on the open engine holds the whole clip in memory: this one needs about 20 GB of RAM and this ComfyUI can spare 16 GB. Trim it first (Video tools → Trim), or pick a lower frame rate";
    await expect(prep("interpolate-rife-fps", "interpolate", { targetFps: 60 }, fhd, 32 * 2 ** 30)).rejects.toThrow(message);
    // The composer checks the same rule before Generate, from the clip's header and the server's RAM.
    expect(wholeClipProblem(wholeClipTool("interpolate", undefined, 5)!, { width: 1920, height: 1080, fps: 24, duration: 5 }, 32 * 2 ** 30)).toBe(message);
    expect(wholeClipProblem(wholeClipTool("interpolate", undefined, 5)!, { width: 1920, height: 1080, fps: 24, duration: 5 }, 64 * 2 ** 30)).toBeNull();
    // 30 → 60 (m 2) on the same server fits: 4 copies, about 11 GB.
    await expect(prep("interpolate-rife-fps", "interpolate", { targetFps: 60 }, clip({ ...fhd, fps: 30, frames: 150 }), 32 * 2 ** 30)).resolves.toBeTruthy();
  });

  it("needs the clip's frame rate: the upload's header, else the server's reading; never a guess", async () => {
    const unknown = clip({ fps: undefined });
    await expect(prep("interpolate-rife-fps", "interpolate", { targetFps: 60 }, unknown)).rejects.toThrow(
      "FPS Boost on the open engine works out its frames from the clip's frame rate, and this file doesn't say what it is, so 60 fps can't be hit. Re-save it as MP4 (H.264) or WebM and try again",
    );
    const { workflow: wf } = await prep("interpolate-rife-fps", "interpolate", { targetFps: 60, sourceFps: 24 }, unknown);
    expect([wf["6"].inputs.value, wf["8"].inputs.value]).toEqual([5, 2]);
  });

  it("lists FILM as an optional download, so a missing FILM file is named with its link", async () => {
    const { manifest } = await prep("interpolate-rife-fps", "interpolate", { targetFps: 60 });
    expect(manifest.models.find((m) => m.file === "film_net_fp16.safetensors")).toMatchObject({ folder: "frame_interpolation", optional: true, sizeGb: 0.07 });
    expect(manifest.models.find((m) => m.file === "rife_v4.26.safetensors")?.optional).toBeUndefined();
    const err = { "5": { class_type: "FrameInterpolationModelLoader", errors: [{ message: "Value not in list", extra_info: { input_name: "model_name", received_value: "film_net_fp16.safetensors" } }] } };
    expect(explainComfyError(err, manifest)).toBe(
      'Missing model "film_net_fp16.safetensors" — put it in ComfyUI/models/frame_interpolation (download: https://huggingface.co/Comfy-Org/Frame-Interpolation/resolve/main/frame_interpolation/film_net_fp16.safetensors)',
    );
  });
});

describe("open SDR to HDR and Export", () => {
  it("writes HLG by default, HDR10's PQ curve on request, EXR frames on a graph of their own", async () => {
    expect(one((await prep("video-sdr-to-hdr", "sdr-to-hdr", {})).workflow, "CreateVideo").inputs.color_space).toBe("HDR");
    const pq = await prep("video-sdr-to-hdr", "sdr-to-hdr", { format: "pq_10bit", extra: { peakNits: 1000 } });
    expect(one(pq.workflow, "CreateVideo").inputs).toMatchObject({ color_space: "HDR PQ", bit_depth: 10 });
    expect(one(pq.workflow, "ImageSDRToHDR").inputs["algorithm.target_luminance"]).toBe(1000);
    const exr = await prep("video-sdr-to-hdr", "sdr-to-hdr", { format: "exr" });
    expect(exr.manifest.id).toBe("video-sdr-to-hdr-exr");
    expect(exr.manifest.outputs.map((o) => o.role)).toEqual(["preview", "frames"]);
    expect(one(exr.workflow, "SaveImageAdvanced").inputs).toMatchObject({ format: "exr", "format.bit_depth": "16-bit float", filename_prefix: "fuobe/gen1" });
    await expect(prep("video-sdr-to-hdr", "sdr-to-hdr", { format: "prores_422_hq" })).rejects.toThrow(/H\.265 and ProRes HDR come from Topaz SDR to HDR on the cloud/);
    expect(hdrColorSpace(undefined)).toBe("HDR");
  });

  it("holds two copies of the clip (decoded, tone mapped): 10 s of 1080p fits a 32 GB server, a minute doesn't", async () => {
    const fhd = (seconds: number) => clip({ width: 1920, height: 1080, fps: 24, duration: seconds, videoDuration: seconds, frames: seconds * 24 });
    await expect(prep("video-sdr-to-hdr", "sdr-to-hdr", {}, fhd(10), 32 * 2 ** 30)).resolves.toBeTruthy();
    await expect(prep("video-sdr-to-hdr", "sdr-to-hdr", { format: "exr" }, fhd(10), 32 * 2 ** 30)).resolves.toBeTruthy();
    await expect(prep("video-export-pro-chunked", "export-video", { format: "exr" }, fhd(10), 32 * 2 ** 30)).resolves.toBeTruthy();
    await expect(prep("video-sdr-to-hdr", "sdr-to-hdr", {}, fhd(60), 32 * 2 ** 30)).rejects.toThrow(
      "SDR to HDR on the open engine holds the whole clip in memory: this one needs about 67 GB of RAM and this ComfyUI can spare 16 GB. Trim it first (Video tools → Trim)",
    );
    // Export in passes holds no whole clip.
    expect(wholeClipTool("export-video", "prores_422_hq")).toBeNull();
    expect(wholeClipTool("export-video", "exr")).toMatchObject({ copies: 2 });
    await expect(prep("video-export-pro-chunked", "export-video", { format: "prores_422_hq" }, fhd(600), 8 * 2 ** 30)).resolves.toBeTruthy();
  });

  it("maps each export format onto VideoHelperSuite, in passes with a manager of the job's own", async () => {
    const cases = [
      ["prores_422_hq", { format: "video/ProRes", profile: "hq" }],
      ["prores_4444", { format: "video/ProRes", profile: "4444" }],
      ["h265_10bit", { format: "video/h265-mp4" }],
      ["ffv1", { format: "video/ffv1-mkv" }],
      ["h264", { format: "video/h264-mp4" }],
    ] as const;
    for (const [format, want] of cases) {
      const { workflow: wf } = await prep("video-export-pro-chunked", "export-video", { format });
      expect(one(wf, "VHS_VideoCombine").inputs, format).toMatchObject(want);
      expect(exportValues(format)).toEqual(want);
    }
    const { workflow: wf, meta } = await prep("video-export-pro-chunked", "export-video", { format: "prores_422_hq" });
    // 1280x720: about 22 MB a frame (decoded and handed to the encoder), so 72 frames hold about 1.5 GB.
    expect(one(wf, "VHS_BatchManager").inputs).toMatchObject({ job: "gen1", frames_per_batch: 72 });
    expect(meta.metaBatch).toBe(true);
    expect((await prep("video-export-pro-chunked", "export-video", { format: "exr" })).manifest.id).toBe("video-export-exr");
    await expect(prep("video-export-pro-chunked", "export-video", { format: "hlg_10bit" })).rejects.toThrow(/Export on the open engine writes ProRes 422 HQ, ProRes 4444, H\.265 10-bit, FFV1, H\.264 or EXR 16-bit, not HLG 10-bit/);
  });

  it("a silent clip loses the sound link VHS would fail on", async () => {
    const { workflow: wf } = await prep("video-export-pro-chunked", "export-video", { format: "ffv1" }, clip({ hasAudio: false }));
    expect(one(wf, "VHS_VideoCombine").inputs).not.toHaveProperty("audio");
  });
});

describe("chunked open upscaling (R4-38)", () => {
  it("ESRGAN: the tier's shorter edge, and passes sized to about 1.5 GB of frames", async () => {
    const { workflow: wf, manifest } = await prep("upscale-video-esrgan-chunked", "upscale-video", { resolution: "2160p" }, clip({ width: 640, height: 360, fps: 25, hasAudio: false }));
    expect(manifest.id).toBe("upscale-video-esrgan-chunked");
    expect(one(wf, "ResizeImageMaskNode").inputs["resize_type.shorter_size"]).toBe(2160);
    expect(one(wf, "VHS_BatchManager").inputs).toEqual({ frames_per_batch: 10, job: "gen1" });
    expect(one(wf, "VHS_VideoCombine").inputs).not.toHaveProperty("audio");
    expect(one(wf, "VHS_LoadVideo").inputs.meta_batch).toEqual(["2", 0]);
  });

  it("ESRGAN on a big source goes down to one frame a pass (about 0.85 GB a frame from 1440p to 2160p)", async () => {
    const { workflow: wf } = await prep("upscale-video-esrgan-chunked", "upscale-video", { resolution: "2160p" }, clip({ width: 2560, height: 1440 }));
    expect(one(wf, "VHS_BatchManager").inputs.frames_per_batch).toBe(1);
  });

  it("SeedVR2: passes of 4n+1 frames", async () => {
    const { workflow: wf } = await prep("upscale-video-seedvr2-chunked", "upscale-video", { resolution: "1080p" });
    expect(one(wf, "VHS_BatchManager").inputs.frames_per_batch).toBe(33);
    expect(framesPerPass({ width: 3840, height: 2160 }, { shortSide: 2160, fourNPlusOne: true, max: 33, fallback: 33 })).toBe(5);
    expect(framesPerPass({}, { fallback: 16 })).toBe(16);
    expect(upscaleShortSide("4K")).toBe(2160);
    expect(upscaleShortSide(undefined)).toBe(1080);
  });

  it("the open video upscalers and Faceless use the chunked graphs", async () => {
    expect(route("oss-upscale-video-esrgan", "upscale-video").endpoint).toBe("upscale-video-esrgan-chunked");
    expect(route("oss-seedvr2", "upscale-video").endpoint).toBe("upscale-video-seedvr2-chunked");
    expect(route("oss-rife", "interpolate").endpoint).toBe("interpolate-rife-fps");
    const { ENGINE_MODELS } = await import("@/lib/catalog/faceless");
    expect(ENGINE_MODELS.open.upscale).toBe("oss-upscale-video-esrgan");
  });
});

describe("files", () => {
  it("zips frames that arrive one at a time", async () => {
    const dest = path.join(tmp, "frames.zip");
    async function* frames() {
      for (let i = 1; i <= 3; i++) yield { name: `frame_${String(i).padStart(5, "0")}.exr`, data: Buffer.alloc(1000 * i, i) };
    }
    const size = await zipToFile(frames(), dest);
    expect(fs.statSync(dest).size).toBe(size);
    const out = execFileSync("python3", ["-I", "-c", "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip(), '|'.join(f'{i.filename}:{i.file_size}' for i in z.infolist()))", dest]).toString().trim();
    expect(out).toBe("None frame_00001.exr:1000|frame_00002.exr:2000|frame_00003.exr:3000");
  });

  it("keeps a provider's big EXR zip (streamed to disk, past the 200 MB in-memory cap), or its link when it can't be fetched", async () => {
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      if (req.url !== "/out/frames.zip") return void res.writeHead(404).end();
      res.setHeader("content-type", "application/zip");
      let i = 0;
      const next = () => (i++ < 20 ? res.write(Buffer.alloc(256 * 1024, i), () => setImmediate(next)) : res.end());
      next();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    process.env.FUOBE_ALLOW_PRIVATE_URLS = "1";
    try {
      const kept = await gens.persistArtifacts({ frames: 481, artifacts: { exr: `http://127.0.0.1:${port}/out/frames.zip` } }, "genexr");
      const url = (kept?.artifacts as Record<string, string>).exr;
      expect(url).toMatch(/^\/api\/files\/outputs\/.+\.zip$/);
      expect(kept?.frames).toBe(481);
      const file = path.join(tmp, "files", decodeURIComponent(url.slice("/api/files/".length)));
      expect(fs.statSync(file).size).toBe(20 * 256 * 1024);
      expect(fs.readdirSync(path.join(tmp, "tmp"))).toEqual([]);
      // Gone at the provider: the link stays (the result still offers it).
      const lost = await gens.persistArtifacts({ artifacts: { exr: `http://127.0.0.1:${port}/out/gone.zip` } }, "genexr");
      expect((lost?.artifacts as Record<string, string>).exr).toBe(`http://127.0.0.1:${port}/out/gone.zip`);
      expect(fs.readdirSync(path.join(tmp, "tmp"))).toEqual([]);
    } finally {
      delete process.env.FUOBE_ALLOW_PRIVATE_URLS;
      server.close();
    }
  });

  it("reads a clip's header: size, frame rate and length", () => {
    const facts = mediaFacts(fs.readFileSync(path.join(process.cwd(), "public/samples/demo-square.mp4")));
    expect(facts).toMatchObject({ width: 576, height: 576, fps: 24 });
    expect(facts.duration).toBeCloseTo(4, 1);
  });
});

describe("cancelling a job", () => {
  const ctx = (externalId: string, meta: Record<string, unknown>) => ({ externalId, meta, route: route("oss-export-video", "export-video"), model: model("oss-export-video"), createdAt: 0 });
  const graph = (prefix: string) => ({ "4": { class_type: "VHS_VideoCombine", inputs: { filename_prefix: prefix } } });

  /** A ComfyUI queue in memory; `onInterrupt` runs when a prompt is interrupted. */
  function fakeComfy(running: unknown[][], pending: unknown[][], onInterrupt?: (q: { pending: unknown[][] }) => void) {
    const state = { running, pending, posts: [] as { path: string; body: Record<string, unknown> }[] };
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        state.posts.push({ path: url.pathname, body });
        if (url.pathname === "/queue") state.pending = state.pending.filter((q) => !(body.delete as string[]).includes(String(q[1])));
        if (url.pathname === "/interrupt") {
          state.running = state.running.filter((q) => q[1] !== body.prompt_id);
          onInterrupt?.(state);
        }
        return Response.json({});
      }
      if (url.pathname === "/queue") return Response.json({ queue_running: state.running, queue_pending: state.pending });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    return { state, restore: () => void (globalThis.fetch = real) };
  }

  it("stops every pass of a meta-batch job (new ids, front of the queue), and one it queued while stopping", async () => {
    const sweeps = { ...CANCEL_SWEEPS };
    Object.assign(CANCEL_SWEEPS, { everyMs: 5 });
    let requeued = false;
    // Pass 3 runs, pass 4 waits at the front; pass 3 was already saving, so it queues pass 5 as it stops.
    const comfy = fakeComfy([[-3, "pass-3", graph("fuobe/gen9")]], [[-4, "pass-4", graph("fuobe/gen9")], [12, "other", graph("fuobe/other")]], (q) => {
      if (!requeued) q.pending = [[-5, "pass-5", graph("fuobe/gen9")], ...q.pending];
      requeued = true;
    });
    try {
      await comfyProvider.cancel!(ctx("pass-1", { metaBatch: true, prefix: "fuobe/gen9" }));
      await vi.waitFor(() => expect(comfy.state.posts).toContainEqual({ path: "/queue", body: { delete: ["pass-5"] } }));
      expect(comfy.state.posts.slice(0, 3)).toEqual([
        { path: "/queue", body: { delete: ["pass-1"] } },
        { path: "/queue", body: { delete: ["pass-4"] } },
        { path: "/interrupt", body: { prompt_id: "pass-3" } },
      ]);
      expect(comfy.state.running).toEqual([]);
      expect(comfy.state.pending.map((q) => q[1])).toEqual(["other"]);
    } finally {
      comfy.restore();
      Object.assign(CANCEL_SWEEPS, sweeps);
    }
  });

  it("a one-prompt job: deleted by its id, interrupted only when it's the one running", async () => {
    const comfy = fakeComfy([[1, "other-running", graph("fuobe/other")]], [[2, "job", graph("fuobe/gen2")]]);
    try {
      await comfyProvider.cancel!(ctx("job", { prefix: "fuobe/gen2" }));
      expect(comfy.state.posts).toEqual([{ path: "/queue", body: { delete: ["job"] } }]);
      expect(comfy.state.running).toHaveLength(1);
    } finally {
      comfy.restore();
    }
  });
});

describe("demo mode", () => {
  beforeAll(() => setSetting("demoMode", "auto"));

  async function settled(id: string) {
    const end = Date.now() + 30_000;
    let g = gens.getGeneration(id)!;
    while (!["succeeded", "failed"].includes(g.status) && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 200));
      g = gens.getGeneration(id)!;
    }
    return g;
  }

  it("an upscale that wouldn't enlarge the clip: a default tier moves up, a picked one fails with the reason", async () => {
    const data = Buffer.from(fs.readFileSync(path.join(process.cwd(), "public/samples/demo-landscape.mp4")));
    // The same clip, its header saying 1920×1080 (tkhd's display size, 16.16 fixed point).
    const tkhd = data.indexOf("tkhd") + 4;
    const matrix = tkhd + (data[tkhd] === 1 ? 52 : 40);
    data.writeUInt32BE(1920 * 65536, matrix + 36);
    data.writeUInt32BE(1080 * 65536, matrix + 40);
    expect(mediaFacts(data)).toMatchObject({ width: 1920, height: 1080 });
    const video = saveFile({ data, contentType: "video/mp4", source: "upload" }).url;
    const [picked] = gens.createGenerations({ feature: "upscale", modelId: "topaz-video", op: "upscale-video", inputs: { video }, params: { resolution: "1080p" } });
    const [auto] = gens.createGenerations({ feature: "upscale", modelId: "topaz-video", op: "upscale-video", inputs: { video } });
    const [p, a] = [await settled(picked.id), await settled(auto.id)];
    expect(p.status).toBe("failed");
    expect(p.error).toBe("This clip is already 1080p — pick a higher resolution, or Original to only clean it up");
    expect(a.status, a.error ?? undefined).toBe("succeeded");
    const sent = db().prepare("SELECT provider_input_json FROM generations WHERE id = ?").get(auto.id) as { provider_input_json: string };
    expect(JSON.parse(sent.provider_input_json)).toMatchObject({ resolution: "1440p", sourceSize: { width: 1920, height: 1080 } });
  }, 40_000);

  it("an upscaler's factor comes from the clip's own header, never from a size the request states", async () => {
    // A clip whose header can't be read, and a request that says it is 640×360: the run gets no size from the request.
    const video = saveFile({ data: Buffer.alloc(256, 7), contentType: "video/mp4", source: "upload" }).url;
    const [g] = gens.createGenerations({ feature: "upscale", modelId: "topaz-video", op: "upscale-video", inputs: { video }, params: { resolution: "1440p", sourceSize: { width: 640, height: 360 } } });
    await settled(g.id);
    const sent = db().prepare("SELECT provider_input_json FROM generations WHERE id = ?").get(g.id) as { provider_input_json: string | null };
    expect(sent.provider_input_json).toBeTruthy();
    expect(JSON.parse(sent.provider_input_json!).sourceSize).toBeUndefined();
  }, 40_000);

  it("an EXR export keeps its frames as a zip in the Library", async () => {
    const video = saveFile({ data: fs.readFileSync(path.join(process.cwd(), "public/samples/demo-square.mp4")), contentType: "video/mp4", source: "upload" }).url;
    const [g] = gens.createGenerations({ feature: "export-video", modelId: "oss-export-video", op: "export-video", inputs: { video }, params: { format: "exr", sourceDuration: 4 } });
    const end = Date.now() + 30_000;
    let done = gens.getGeneration(g.id)!;
    while (!["succeeded", "failed"].includes(done.status) && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 200));
      done = gens.getGeneration(g.id)!;
    }
    expect(done.status, done.error ?? undefined).toBe("succeeded");
    const exr = (done.outputs[0].meta?.artifacts as Record<string, string>).exr;
    expect(exr).toMatch(/^\/api\/files\/outputs\/.+\.zip$/);
    expect(outputActions(done, 0).some((a) => a.id === "download-exr")).toBe(true);
  }, 40_000);

  it("the cloud models (fixtures aside) exist for every mode", () => {
    const ids: ModelDef["id"][] = ["topaz-video", "topaz-starlight", "bytedance-video-upscale", "flux-video-upscale", "seedvr-video", "topaz-fps-boost", "rife-video-cloud", "topaz-sdr-to-hdr", "ltx-2-3-hdr"];
    for (const id of ids) expect(model(id).engine, id).toBe("cloud");
  });
});
