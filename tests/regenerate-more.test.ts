import { describe, expect, it } from "vitest";
import { getModel } from "@/lib/catalog";
import { buildEpisodeGraph, defaultSettings, ENGINE_MODELS, genreInfo, REGEN_PREFIX, regeneratePlan, regenerateReuses, resolveModels, narrationText, type EpisodeSettings, type ScriptBlock } from "@/lib/catalog/faceless";
import { finishLengthProblem, needsSmoothing, REGEN_FINISH_SIGMA, REGEN_MODEL, REGEN_SMOOTH_MODEL, regenFinishSteps, sixteenFpsModel } from "@/lib/catalog/regenerate";

const block = (i: number, seconds = 6): ScriptBlock => ({ id: `b${i}`, narration: `Line ${i} of the story, read slowly and clearly.`, visual: `A lighthouse at dusk, scene ${i}`, motion: "slow push-in", seconds });

function plan(s: Partial<EpisodeSettings>, blocks: ScriptBlock[]) {
  const settings = { ...defaultSettings(s.engine ?? "open", genreInfo("education")), ...s };
  const graph = buildEpisodeGraph({ feature: "faceless", title: "Lighthouses", genre: genreInfo("education"), settings, blocks, fallbackVoice: "/api/files/uploads/demo-voice.wav" }, getModel);
  const models = resolveModels(settings, narrationText(blocks).length, getModel);
  return { graph, ...regeneratePlan(graph, { engine: settings.engine, joinMax: models.joinMax, lookup: getModel }) };
}

describe("finishing passes (shared)", () => {
  it("runs RIFE first only for clips slower than 24 fps, and refuses a pass over 15 s", () => {
    expect(needsSmoothing(16)).toBe(true);
    expect(needsSmoothing(24)).toBe(false);
    expect(needsSmoothing(30)).toBe(false);
    expect(needsSmoothing(undefined)).toBe(false);
    expect(sixteenFpsModel("oss-wan22-14b-fast")).toBe(true);
    expect(sixteenFpsModel("oss-minimax-h3")).toBe(false);
    expect(finishLengthProblem(15)).toBeNull();
    expect(finishLengthProblem(15.4)).toMatch(/up to 15 s in one pass/);
    const helper = { feature: "shorts-step", batchTitle: "A short" };
    const slow = regenFinishSteps({ key: "s0", clip: { key: "look" }, prompt: "A comic-book city at night", seconds: 5.06, fps: 16, draftFrom: "other", helper, label: "Segment 1" });
    expect(slow.steps.map((s) => [s.key, s.request.modelId, s.after, s.chain])).toEqual([
      ["s0-smooth", REGEN_SMOOTH_MODEL, ["look"], [{ slot: "video" }]],
      ["s0-regen", REGEN_MODEL, ["s0-smooth"], [{ slot: "video" }]],
    ]);
    expect(slow.steps[0].request).toMatchObject({ op: "interpolate", params: { targetFps: 24 } });
    expect(slow.final).toBe("s0-regen");
    expect(slow.steps[1].request).toMatchObject({ op: "upscale-video", prompt: "A comic-book city at night", params: { resolution: "1080p", sourceDuration: 5.06, extra: { startSigma: REGEN_FINISH_SIGMA, draftFrom: "other" } } });
    // A stored clip at 24 fps: one pass on the file itself.
    const file = regenFinishSteps({ key: "e", clip: { url: "/api/files/uploads/a.mp4" }, prompt: "x", seconds: 4, fps: 24, draftFrom: "h3", helper, label: "Edit" });
    expect(file.steps).toHaveLength(1);
    expect(file.steps[0]).toMatchObject({ key: "e-regen", request: { inputs: { video: "/api/files/uploads/a.mp4" }, params: { extra: { draftFrom: "h3" } } } });
    expect(file.steps[0].after).toBeUndefined();
    expect(() => regenFinishSteps({ key: "x", clip: { key: "k" }, prompt: "x", seconds: 20, draftFrom: "other", helper, label: "Long" })).toThrow(/15 s/);
  });
});

describe("Faceless · Regenerate to 1080p", () => {
  it("is offered on the open engine only (the cloud keeps its SeedVR upscale)", () => {
    expect(ENGINE_MODELS.open.regenerate).toBe(REGEN_MODEL);
    expect(ENGINE_MODELS.cloud.regenerate).toBeUndefined();
    expect(ENGINE_MODELS.cloud.upscale).toBe("seedvr-video");
    expect(ENGINE_MODELS.open.upscale).toBe("oss-upscale-video-esrgan");
    expect(() => plan({ engine: "cloud" }, [block(1), block(2)])).toThrow(/runs on your GPU/);
  });

  it("redraws each scene from its own words at 1080p (576p preset, sigma 0.8), then joins and mixes again", () => {
    const blocks = [block(1), block(2), block(3), block(4), block(5)];
    const { graph, steps, final } = plan({ engine: "open", videoModel: "oss-minimax-h3", animation: "animated" }, blocks);
    const clips = graph.filter((s) => s.part === "clip");
    const regens = steps.filter((s) => s.request.modelId === REGEN_MODEL);
    expect(regens).toHaveLength(clips.length);
    // H3 clips are 24 fps: no RIFE.
    expect(steps.some((s) => s.request.modelId === REGEN_SMOOTH_MODEL)).toBe(false);
    for (const [i, r] of regens.entries()) {
      const c = clips[i];
      expect(r.after).toEqual([c.key]);
      expect(r.request.params).toMatchObject({ resolution: "1080p", extra: { startSigma: 0.8, draftFrom: "other" } });
      expect(r.request.params?.sourceDuration).toBeLessThanOrEqual(15);
      // The scene's own words: its picture's prompt and its motion.
      const still = graph.find((s) => s.key === c.after![0])!;
      expect(r.request.prompt).toContain(still.request.prompt!.slice(0, 40));
      expect(r.request.prompt).toContain(c.request.prompt!.slice(0, 20));
    }
    // MiniMax H3 scenes join packet by packet (every redrawn clip has the same size and rate), as the episode does.
    const joins = steps.filter((s) => s.request.op === "concat");
    expect(joins.map((j) => [j.key, j.request.modelId])).toEqual([[`${REGEN_PREFIX}join`, graph.find((s) => s.key === "join")!.request.modelId]]);
    expect(joins[0].after).toEqual(regens.map((r) => r.key));
    // The same narration, bed and subtitles go back on.
    const mix = steps.find((s) => s.key === `${REGEN_PREFIX}mix`)!;
    expect(mix.after![0]).toBe(`${REGEN_PREFIX}join`);
    expect(mix.after!.slice(1)).toEqual(graph.find((s) => s.key === "mix")!.after!.slice(1));
    expect(final).toBe(`${REGEN_PREFIX}captions`);
    expect(steps.find((s) => s.key === final)!.after).toEqual([`${REGEN_PREFIX}mix`, "words"]);
    expect(regenerateReuses(steps).sort()).toEqual([...clips.map((c) => c.key), "narration", "words", ...(graph.some((s) => s.key === "music") ? ["music"] : [])].sort());
  });

  it("brings Wan's 16 fps scenes to 24 fps with RIFE first, and folds the joins at 1080p", () => {
    const { steps, graph } = plan({ engine: "open", videoModel: "oss-wan22-14b-fast", animation: "animated" }, [block(1, 5), block(2, 5), block(3, 5), block(4, 5), block(5, 5)]);
    const clips = graph.filter((s) => s.part === "clip");
    const smooth = steps.filter((s) => s.request.modelId === REGEN_SMOOTH_MODEL);
    expect(smooth).toHaveLength(clips.length);
    expect(smooth[0].after).toEqual([clips[0].key]);
    expect(steps.find((s) => s.key === `${REGEN_PREFIX}${clips[0].key}-regen`)!.after).toEqual([smooth[0].key]);
    // The episode's join takes four clips at a time; the redrawn film folds the same way, at 1080p.
    const joins = steps.filter((s) => s.request.op === "concat");
    expect(joins.map((j) => j.key)).toEqual(graph.filter((s) => s.part === "join").map((j) => `${REGEN_PREFIX}${j.key}`));
    expect(joins.length).toBeGreaterThan(1);
    for (const j of joins) expect(j.request.params?.resolution).toBe("1080p");
  });

  it("keeps one scene unjoined and mixes it straight", () => {
    const { steps } = plan({ engine: "open", videoModel: "oss-minimax-h3", animation: "animated", subtitles: false }, [block(1, 8)]);
    expect(steps.some((s) => s.request.op === "concat")).toBe(false);
    const mix = steps.find((s) => s.key === `${REGEN_PREFIX}mix`)!;
    expect(mix.after![0]).toMatch(/-regen$/);
    expect(mix.request.title).toBe("Lighthouses · 1080p");
  });
});
