import { describe, expect, it } from "vitest";
import { getModel } from "@/lib/catalog";
import {
  chainState,
  customPresetName,
  fitSize,
  needsFit,
  firstFramePrompt,
  formatSeconds,
  joinGroups,
  lookFromCustom,
  lookFromPreset,
  planCloudSegments,
  planOpenSegments,
  planShorts,
  planStitch,
  planTake,
  rangeProblem,
  restylePrompt,
  segmentPrompt,
  SHORTS,
  SHORTS_LANGUAGES,
  SHORTS_MODELS,
  SHORTS_PRESETS,
  SHORTS_TOOLS,
  stitchCurrent,
  stitchSteps,
  takeSteps,
  wholeClip,
  type ShortsPlanInput,
} from "@/lib/catalog/shorts";
import { FX } from "@/lib/preset-cards";
import { MOTIF_IDS } from "@/components/shorts/look-motif";
import { MIXED_PRESETS } from "@/lib/catalog/mixed-media";

const claymation = SHORTS_PRESETS.find((p) => p.name === "Claymation")!;
const kinetic = SHORTS_PRESETS.find((p) => p.name === "Kinetic Type")!;

const input = (over: Partial<ShortsPlanInput> = {}): ShortsPlanInput => ({
  engine: "cloud",
  title: "Claymation · beach",
  source: { url: "/api/files/uploads/beach.mp4", duration: 30, hasAudio: true },
  range: { start: 0, end: 30 },
  look: lookFromPreset(claymation),
  aspectRatio: "9:16",
  language: "auto",
  modelId: "gemini-omni-flash",
  maxRefs: 0,
  ...over,
});

describe("Shorts presets and catalog", () => {
  it("gives every Shorts and Mixed Media preset its own motif on the card (lettering, scribbles, paper, grids…)", () => {
    const ids = [...SHORTS_PRESETS, ...MIXED_PRESETS].map((p) => p.id);
    expect(ids.filter((id) => !MOTIF_IDS.includes(id))).toEqual([]);
    expect(MOTIF_IDS.filter((id) => !ids.includes(id))).toEqual([]);
  });

  it("has Higgsfield's 44 presets with Fuobe's own descriptions and looks", () => {
    expect(SHORTS_PRESETS).toHaveLength(44);
    expect(new Set(SHORTS_PRESETS.map((p) => p.id)).size).toBe(44);
    expect(new Set(SHORTS_PRESETS.map((p) => p.name)).size).toBe(44);
    for (const p of SHORTS_PRESETS) {
      expect(p.description.length).toBeGreaterThan(10);
      expect(p.description.length).toBeLessThanOrEqual(100);
      expect(p.look.length).toBeGreaterThan(30);
      expect(FX).toContain(p.fx);
      expect(p.hue).toBeGreaterThanOrEqual(0);
      expect(p.hue).toBeLessThan(360);
    }
    // The type presets put words on screen, so the language applies to them.
    expect(SHORTS_PRESETS.filter((p) => p.type).map((p) => p.name)).toEqual(["Sticker Type", "Balloon Type", "Bold Caption", "Kinetic Type", "Neon Type", "Stacked Type"]);
  });

  it("lists auto-detect plus 33 languages and only real models", () => {
    expect(SHORTS_LANGUAGES).toHaveLength(33);
    for (const id of [...SHORTS_MODELS.cloud, ...SHORTS_MODELS.open, ...Object.values(SHORTS_TOOLS.cloud), ...Object.values(SHORTS_TOOLS.open)]) {
      if (typeof id === "number") continue;
      expect(getModel(id), id).toBeDefined();
    }
    // Fuobe Shorts (O9) is the default on both engines; Gemini Omni Flash (Higgsfield's Shorts engine) stays a choice.
    expect(SHORTS_MODELS.cloud.slice(0, 2)).toEqual(["fuobe-shorts", "gemini-omni-flash"]);
    expect(SHORTS_MODELS.open).toEqual(["fuobe-shorts"]);
    for (const id of SHORTS_MODELS.cloud) expect(getModel(id)!.routes.some((r) => r.op === "v2v"), id).toBe(true);
  });

  it("names a custom preset from its description, or numbers it", () => {
    expect(customPresetName("warm slow film look with soft grain", 0)).toBe("Warm slow film");
    expect(customPresetName("", 2)).toBe("My look 3");
    const look = lookFromCustom({ id: "custom-1", name: "Mine", description: "dusty 70s film.", references: Array.from({ length: 12 }, (_, i) => `/api/files/r${i}.png`), createdAt: 0, updatedAt: 0 });
    expect(look.references).toHaveLength(10);
    expect(look.look).toBe("the look of the reference images: dusty 70s film");
  });
});

describe("Shorts prompts", () => {
  it("restyles the look and keeps the motion", () => {
    const p = restylePrompt(lookFromPreset(claymation));
    expect(p).toMatch(/^Restyle this video as stop-motion claymation/);
    expect(p).toMatch(/same people, faces, poses, motion, timing and camera moves; change only the look\.$/);
    expect(p).not.toMatch(/on-screen/);
  });

  it("writes on-screen words in the chosen language for type presets", () => {
    expect(restylePrompt(lookFromPreset(kinetic), "Spanish")).toMatch(/Any on-screen words are written in Spanish\.$/);
    expect(restylePrompt(lookFromPreset(kinetic), "auto")).toMatch(/written in the language spoken in the clip\.$/);
    expect(restylePrompt(lookFromPreset(kinetic), "auto", 2)).toMatch(/Match the style of the reference images\./);
  });

  it("restyles the first frame with references as images 2 and 3 (open engine)", () => {
    expect(firstFramePrompt(lookFromPreset(claymation), "auto", 0)).toMatch(/^Redraw image 1 as stop-motion claymation.*poses and expressions of image 1 exactly\.$/);
    expect(firstFramePrompt(lookFromPreset(claymation), "auto", 1)).toMatch(/Match the style, colours and textures of image 2\./);
    expect(firstFramePrompt(lookFromPreset(claymation), "auto", 2)).toMatch(/of images 2 and 3\./);
    expect(segmentPrompt(lookFromPreset(claymation))).toMatch(/^Stop-motion claymation: .*smooth natural motion\.$/);
  });
});

describe("Shorts segment planning", () => {
  it("cuts cloud selections into equal segments of at most 10 s", () => {
    expect(planCloudSegments({ start: 0, end: 10 })).toEqual([{ index: 0, start: 0, end: 10 }]);
    const five = planCloudSegments({ start: 0, end: 47 });
    expect(five).toHaveLength(5);
    for (const s of five) expect(s.end - s.start).toBeCloseTo(9.4, 3);
    const two = planCloudSegments({ start: 3, end: 13.5 });
    expect(two.map((s) => [s.start, s.end])).toEqual([
      [3, 8.25],
      [8.25, 13.5],
    ]);
    expect(planCloudSegments({ start: 0, end: 120 })).toHaveLength(12);
  });

  it("covers the selection back to back, never longer than the limit", () => {
    for (const [a, b] of [
      [0, 4],
      [1.3, 33.7],
      [5, 125],
      [0, 120],
    ]) {
      const segs = planCloudSegments({ start: a, end: b });
      expect(segs[0].start).toBe(a);
      expect(segs[segs.length - 1].end).toBe(b);
      segs.forEach((s, i) => {
        expect(s.end - s.start).toBeLessThanOrEqual(10.001);
        if (i) expect(s.start).toBe(segs[i - 1].end);
      });
    }
  });

  it("cuts open selections on whole frames: 4n+1 frames, at most 81, back to back", () => {
    const segs = planOpenSegments({ start: 0, end: 12 });
    // 192 frames at 16 fps → 3 segments of 65 + 65 + 61 frames (191: one frame dropped at the end).
    expect(segs.map((s) => s.frames)).toEqual([65, 65, 61]);
    expect(segs.map((s) => [s.start, s.end])).toEqual([
      [0, 4.063],
      [4.063, 8.125],
      [8.125, 11.938],
    ]);
    for (const [a, b] of [
      [0, 4],
      [2.3, 14.3],
      [0, 120],
      [7.77, 61.2],
    ]) {
      const s = planOpenSegments({ start: a, end: b });
      const total = Math.floor((b - a) * 16 + 1e-6);
      const used = s.reduce((n, x) => n + x.frames!, 0);
      expect(used).toBeLessThanOrEqual(total);
      expect(total - used).toBeLessThanOrEqual(3);
      for (const x of s) {
        expect((x.frames! - 1) % 4).toBe(0);
        expect(x.frames!).toBeLessThanOrEqual(81);
        // Frame-exact: start and end land on whole frames, and the span is the frame count.
        expect(Math.round((x.end - x.start) * 16)).toBe(x.frames);
      }
      s.forEach((x, i) => i && expect(x.start).toBe(s[i - 1].end));
    }
    expect(planOpenSegments({ start: 0, end: 120 })).toHaveLength(24);
  });

  it("groups joins evenly, never leaving a single clip", () => {
    expect(joinGroups(1, 4)).toEqual([[0]]);
    expect(joinGroups(2, 4)).toEqual([[0, 1]]);
    expect(joinGroups(5, 4)).toEqual([
      [0, 1, 2],
      [3, 4],
    ]);
    expect(joinGroups(24, 4)).toHaveLength(6);
    expect(joinGroups(12, 24)).toEqual([Array.from({ length: 12 }, (_, i) => i)]);
    for (let n = 2; n <= 30; n++) for (const g of joinGroups(n, 4)) expect(g.length).toBeGreaterThanOrEqual(2);
  });

  it("checks the selection", () => {
    expect(rangeProblem({ start: 0, end: 3 })).toBe("Select at least 4 seconds");
    expect(rangeProblem({ start: 0, end: 130 })).toBe("Select up to 2 minutes");
    expect(rangeProblem({ start: 5, end: 15 }, 12)).toBe("The selection runs past the end of the clip");
    expect(rangeProblem({ start: 2, end: 2 })).toBe("Pick a part of the clip");
    expect(rangeProblem({ start: 10, end: 130 }, 200)).toBe(null);
    expect(wholeClip({ start: 0, end: 30 }, 30.02)).toBe(true);
    expect(wholeClip({ start: 1, end: 30 }, 30)).toBe(false);
    expect(formatSeconds(75.25)).toBe("1:15.2");
    expect(formatSeconds(9)).toBe("0:09");
  });
});

describe("Shorts pipeline shape", () => {
  it("cloud: cut → crop to the ratio → restyle per segment, one join, then the original sound from the upload", () => {
    const plan = planShorts(input());
    expect(plan.segments).toHaveLength(3);
    const by = Object.fromEntries(plan.steps.map((s) => [s.key, s]));
    expect(Object.keys(by)).toEqual(["cut0", "fit0", "look0", "cut1", "fit1", "look1", "cut2", "fit2", "look2", "join", "final"]);
    expect(by.cut1.request).toMatchObject({ modelId: "trim-video", op: "trim", inputs: { video: "/api/files/uploads/beach.mp4" }, params: { startTime: 10, endTime: 20 } });
    // The restyle model keeps its input's shape: the cut is centre-cropped to 9:16 first.
    expect(by.fit1).toMatchObject({ after: ["cut1"], chain: [{ slot: "video" }], request: { modelId: "scale-video", op: "reframe", params: { aspectRatio: "9:16", extra: { width: 1080, height: 1920 } } } });
    expect(by.look1).toMatchObject({ after: ["fit1"], chain: [{ slot: "video" }], request: { modelId: "gemini-omni-flash", op: "v2v", params: { aspectRatio: "9:16", duration: 10 } } });
    expect(by.look1.request.inputs).toBeUndefined();
    expect(by.join).toMatchObject({ after: ["look0", "look1", "look2"], request: { modelId: "join-clips", op: "concat" } });
    expect(by.join.chain).toHaveLength(3);
    // The whole clip was used: the upload itself carries the sound.
    expect(by.final).toMatchObject({ after: ["join"], chain: [{ slot: "video" }], request: { modelId: "merge-audio-video", op: "mux", inputs: { audio: "/api/files/uploads/beach.mp4" }, title: "Claymation · beach" } });
    expect(plan.final).toBe("final");
    // The takes and the finished short are "shorts"; the cuts, crops and joins in between are "shorts-step".
    for (const s of plan.steps) expect(s.request).toMatchObject({ feature: /^(look|final)/.test(s.key) ? "shorts" : "shorts-step", batchTitle: "Claymation · beach" });
    expect(by.look2.request.step).toEqual({ label: "Segment 3 of 3 · restyle", index: 2, of: 3 });
  });

  it("cloud: a trimmed selection takes its sound from the source cut to the same window", () => {
    const plan = planShorts(input({ range: { start: 4, end: 12 } }));
    const by = Object.fromEntries(plan.steps.map((s) => [s.key, s]));
    expect(plan.segments).toHaveLength(1);
    expect(by.join).toBeUndefined();
    expect(by.sound.request).toMatchObject({ modelId: "trim-video", params: { startTime: 4, endTime: 12 } });
    expect(by.final).toMatchObject({ after: ["look0", "sound"], chain: [{ slot: "video" }, { slot: "audio" }] });
    expect(by.final.request.inputs).toBeUndefined();
  });

  it("silent clips skip the soundtrack; one silent segment is the short itself", () => {
    const silent = planShorts(input({ source: { url: "/api/files/x.mp4", duration: 30, hasAudio: false } }));
    expect(silent.steps.map((s) => s.key)).not.toContain("final");
    expect(silent.final).toBe("join");
    expect(silent.steps.find((s) => s.key === "join")!.request).toMatchObject({ title: "Claymation · beach", feature: "shorts" });
    const one = planShorts(input({ source: { url: "/api/files/x.mp4", duration: 8, hasAudio: false, width: 1080, height: 1920 }, range: { start: 0, end: 8 } }));
    expect(one.steps.map((s) => s.key)).toEqual(["cut0", "look0"]);
    expect(one.final).toBe("look0");
  });

  it("crops only clips of another shape (or of an unknown one), and only for models that can't be asked for the ratio", () => {
    const at = (width: number, height: number, aspectRatio: "9:16" | "16:9" = "9:16") =>
      planTake(input({ aspectRatio, source: { url: "/api/files/x.mp4", duration: 30, hasAudio: true, width, height } }), { index: 0, start: 0, end: 5 }, 1).keys;
    expect(at(1920, 1080).fit).toBe("fit0");
    expect(at(1080, 1920).fit).toBeUndefined();
    expect(at(720, 1280).fit).toBeUndefined();
    expect(at(1920, 1080, "16:9").fit).toBeUndefined();
    expect(at(1080, 1920, "16:9").fit).toBe("fit0");
    expect(needsFit({}, "9:16")).toBe(true);
    expect(fitSize("16:9")).toEqual({ width: 1920, height: 1080 });
    const asked = planTake(input({ reframes: true }), { index: 0, start: 0, end: 5 }, 1);
    expect(asked.keys.fit).toBeUndefined();
    expect(asked.steps[1]).toMatchObject({ after: ["cut0"], request: { params: { aspectRatio: "9:16" } } });
    expect(takeSteps({ cut: "c", fit: "f", look: "l" }, {}).map((s) => s.label)).toEqual(["Cutting the segment", "Cropping the segment", "Restyling"]);
  });

  it("sends references only to cloud models that take them, up to their limit", () => {
    const refs = Array.from({ length: 6 }, (_, i) => `/api/files/ref${i}.png`);
    const look = { ...lookFromPreset(claymation), references: refs };
    const words = planTake(input({ look }), { index: 0, start: 0, end: 5 }, 1);
    expect(words.steps.find((s) => s.key === words.keys.look)!.request.inputs).toBeUndefined();
    const kling = planTake(input({ look, modelId: "kling-o3-4k-edit", maxRefs: 4 }), { index: 0, start: 0, end: 5 }, 1);
    const klingLook = kling.steps.find((s) => s.key === kling.keys.look)!;
    expect(klingLook.request.inputs?.images).toEqual(refs.slice(0, 4));
    expect(klingLook.request.prompt).toMatch(/Match the style of the reference images/);
  });

  it("open: segment (with its first frame) → restyled first frame → Wan VACE, joined 4 at a time", () => {
    const refs = ["/api/files/a.png", "/api/files/b.png", "/api/files/c.png"];
    const plan = planShorts(input({ engine: "open", modelId: "oss-wan22-vace-restyle", maxRefs: 2, range: { start: 0, end: 30 }, look: { ...lookFromPreset(claymation), references: refs } }));
    expect(plan.segments).toHaveLength(6);
    const by = Object.fromEntries(plan.steps.map((s) => [s.key, s]));
    expect(by.cut0.request).toMatchObject({ modelId: "oss-segment", op: "trim", params: { startTime: 0, fps: 16, aspectRatio: "9:16", resolution: "480p" } });
    expect(by.frame0).toMatchObject({ after: ["cut0"], chain: [{ slot: "images", position: "first" }], request: { modelId: "oss-qwen-image-21-turbo", op: "edit", inputs: { images: refs.slice(0, 2) } } });
    expect(by.look0).toMatchObject({ after: ["cut0", "frame0"], chain: [{ slot: "video" }, { slot: "images" }], request: { modelId: "oss-wan22-vace-restyle", op: "v2v" } });
    // The restyle runs exactly as many frames as its segment.
    for (const s of plan.segments) expect(Math.round((by[`look${s.index}`].request.params!.duration as number) * 16)).toBe(s.frames);
    // 6 clips → two joins of 3, then one join of the two.
    const joins = plan.steps.filter((s) => s.request.op === "concat");
    expect(joins.map((j) => [j.key, j.after?.length])).toEqual([
      ["join-0-0", 3],
      ["join-0-1", 3],
      ["join", 2],
    ]);
    for (const j of joins) expect(j.request.modelId).toBe("oss-join-clips");
    expect(by.final).toMatchObject({ after: ["join"], request: { modelId: "oss-mux", op: "mux", inputs: { audio: "/api/files/uploads/beach.mp4" } } });
  });

  it("stitch again joins finished takes by file and keeps the sound step for a trimmed selection", () => {
    const st = planStitch(input({ range: { start: 2, end: 22 } }), [{ url: "/api/files/a.mp4" }, { url: "/api/files/b.mp4" }], "-s1");
    expect(st.steps.map((s) => s.key)).toEqual(["join-s1", "sound-s1", "final-s1"]);
    expect(st.steps[0].request.inputs).toEqual({ videos: ["/api/files/a.mp4", "/api/files/b.mp4"] });
    expect(st.steps[0].after).toBeUndefined();
    expect(st.final).toBe("final-s1");
    const single = planStitch(input({ source: { url: "/api/files/x.mp4", hasAudio: false } }), [{ url: "/api/files/a.mp4" }]);
    expect(single).toEqual({ steps: [], final: undefined });
  });

  it("knows when the stitch is out of date", () => {
    const s = { segments: [{ primary: "a" }, { primary: "b" }], stitches: [{ clips: ["a", "b"] }] } as never;
    expect(stitchCurrent(s)).toBe(true);
    expect(stitchCurrent({ segments: [{ primary: "a" }, { primary: "c" }], stitches: [{ clips: ["a", "b"] }] } as never)).toBe(false);
    expect(stitchCurrent({ segments: [{ primary: "a" }], stitches: [] } as never)).toBe(false);
  });

  it("sums a chain of steps into one state with the failing step's own error", () => {
    const g = (status: string, extra: Record<string, unknown> = {}) => ({ id: Math.random().toString(), status, ...extra }) as never;
    const gens: Record<string, never> = { c: g("succeeded"), f: g("running", { progress: 0.5 }), l: g("queued") };
    expect(chainState(takeSteps({ cut: "c", frame: "f", look: "l" }, gens))).toEqual({ status: "working", label: "Restyling the first frame", progress: 0.5 });
    const failed = { c: g("failed", { error: "The start time is past the end of the clip" }), l: g("failed", { error: "An earlier step didn't finish" }) };
    expect(chainState(takeSteps({ cut: "c", look: "l" }, failed))).toMatchObject({ status: "failed", label: "Cutting the segment failed", error: "The start time is past the end of the clip" });
    expect(chainState(takeSteps({ cut: "c", look: "gone" }, gens))).toMatchObject({ status: "gone" });
    expect(chainState(takeSteps({ cut: "c", look: "c" }, gens))).toMatchObject({ status: "done", progress: 1 });
    const st = stitchSteps({ ids: ["j", "s"], final: "m" }, { j: g("succeeded", { op: "concat" }), s: g("succeeded", { op: "trim" }), m: g("running", { op: "mux", progress: 0.2 }) });
    expect(st.map((x) => x.label)).toEqual(["Stitching the segments", "Cutting the original sound", "Putting the sound back"]);
    expect(chainState(st).progress).toBeCloseTo((2 + 0.2) / 3);
    // Original sound split on the GPU before the final mux.
    const split = stitchSteps({ ids: ["j", "t", "x"], final: "m" }, { j: g("succeeded", { op: "concat" }), t: g("succeeded", { op: "trim" }), x: g("running", { op: "separate-audio", progress: 0.4 }), m: g("queued", { op: "mux" }) });
    expect(chainState(split)).toMatchObject({ status: "working", label: "Splitting the sound" });
  });

  it("limits are Higgsfield's", () => {
    expect(SHORTS.minSeconds).toBe(4);
    expect(SHORTS.maxSeconds).toBe(120);
    expect(SHORTS.maxBytes).toBe(200 * 1024 * 1024);
  });
});
