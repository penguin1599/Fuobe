import { afterEach, describe, expect, it } from "vitest";
import { draftToInput, initialDraft } from "@/components/cinema/draft";
import { getModel } from "@/lib/catalog";
import { planCinema, takesClips, type CinemaGenerateInput } from "@/lib/catalog/cinema";
import type { ModelRoute } from "@/lib/catalog/types";

// Reference clips (video, audio) reach the cloud models whose field maps take them, and every other
// route says plainly that they're left out. The maps come from the cloud catalog: the tests give the
// Seedance / Kling routes the fields the catalog adds (video_urls, audio_urls) and put them back.
// Fuobe Cinema takes none yet (LTX-2.3's reference-video endpoint isn't read in the research).

const VIDEO: CinemaGenerateInput = { engine: "cloud", mode: "video", action: "generate", prompt: "A lighthouse keeper climbs the stairs", settings: {}, duration: 5, batch: 1 };
const CLIPS = { videos: ["/api/files/ref.mp4"], audios: ["/api/files/ref.mp3"] };
const ctx = { cloudAllowed: true };

const saved: [ModelRoute, ModelRoute["map"]][] = [];
function giveClipFields(modelId: string, op: ModelRoute["op"]) {
  for (const r of getModel(modelId)!.routes.filter((x) => x.op === op)) {
    saved.push([r, r.map]);
    r.map = { ...r.map, videos: "video_urls", audios: "audio_urls" } as ModelRoute["map"];
  }
}
afterEach(() => {
  for (const [r, map] of saved.splice(0)) r.map = map;
});

describe("reference clips", () => {
  it("are sent to reference-to-video when the model's routes take them", () => {
    giveClipFields("seedance-2-5", "ref2v");
    expect(takesClips(getModel("seedance-2-5")!, "ref2v", "videos")).toBe(true);
    const plan = planCinema({ ...VIDEO, ...CLIPS, modelId: "seedance-2-5", images: ["/api/files/a.png"] }, ctx);
    expect(plan.model.id).toBe("seedance-2-5");
    expect(plan.blocker).toBeUndefined();
    const req = plan.steps[0].request;
    expect(req.op).toBe("ref2v");
    expect(req.inputs).toMatchObject({ images: ["/api/files/a.png"], ...CLIPS });
    expect(plan.notes.join(" ")).toMatch(/image is a reference rather than the start frame/);
    // Clips are references, not a scene: the prompt is still needed.
    expect(planCinema({ ...VIDEO, ...CLIPS, modelId: "seedance-2-5", prompt: "" }, ctx).blocker).toBe("Describe your scene first");
  });

  it("are left out with a note naming the models that would take them", () => {
    giveClipFields("seedance-2-5", "ref2v");
    const plan = planCinema({ ...VIDEO, ...CLIPS, modelId: "kling-3" }, ctx);
    expect(plan.model.id).toBe("kling-3");
    expect(plan.steps[0].request.inputs).toBeUndefined();
    expect(plan.notes.join(" ")).toMatch(/Kling 3\.0 doesn't take reference videos and reference audio — MiniMax H3 or Seedance 2\.5 or MiniMax H3 Max do/);
    // Fuobe Cinema picked from the menu takes none yet: the partners that do are named.
    const original = planCinema({ ...VIDEO, ...CLIPS, modelId: "fuobe-cinema" }, ctx);
    expect(original.model.id).toBe("fuobe-cinema");
    expect(original.steps[0].request.op).toBeUndefined();
    expect(original.notes.join(" ")).toMatch(/Fuobe Cinema doesn't take reference videos and reference audio — MiniMax H3 or Seedance 2\.5/);
    expect(original.notes.join(" ")).not.toMatch(/Cinema Studio/);
    // On your GPU only MiniMax H3 takes them (Pika H3 Flex's references, nm10-pika-flex); stills never do.
    expect(planCinema({ ...VIDEO, ...CLIPS, engine: "open" }, ctx).notes.join(" ")).toMatch(/Fuobe Cinema doesn't take reference videos and reference audio — MiniMax H3 does/);
    expect(planCinema({ ...VIDEO, ...CLIPS, mode: "image", settings: { camera: "modern", lens: "clean-sharp", focal: "50mm" } }, ctx).notes).toContain(
      "Stills use image references — reference videos and audio are left out",
    );
  });

  it("ride along on Edit and Extend when those routes take them", () => {
    giveClipFields("kling-o3", "v2v");
    giveClipFields("seedance-2-5", "extend");
    const source = { url: "/api/files/take.mp4", kind: "video" as const };
    // A partner's take is edited with Kling O3, which (here) takes clips.
    const edit = planCinema({ ...VIDEO, ...CLIPS, modelId: "seedance-2-5", action: "edit", prompt: "make it snow", source }, ctx);
    expect(edit.model.id).toBe("kling-o3");
    expect(edit.steps[0].request.inputs).toMatchObject({ video: source.url, ...CLIPS });
    const ext = planCinema({ ...VIDEO, ...CLIPS, modelId: "seedance-2-5", action: "extend-forward", source }, ctx);
    expect(ext.model.id).toBe("seedance-2-5");
    expect(ext.steps[0].request.inputs).toMatchObject({ video: source.url, ...CLIPS });
    // Fuobe Cinema's edit (LTX-2.3 video to video) takes only the take.
    const original = planCinema({ ...VIDEO, ...CLIPS, action: "edit", prompt: "make it snow", source }, ctx);
    expect(original.model.id).toBe("fuobe-cinema");
    expect(original.steps[0].request.inputs).toEqual({ video: source.url });
    expect(original.notes.join(" ")).toMatch(/Fuobe Cinema edits from the take alone — reference videos and audio aren't used/);
  });

  it("move a take on the default model to the first partner model that takes them all, with a note", () => {
    // Nothing picked in the menu (the cloud default, Fuobe Cinema): the clips aren't dropped.
    const plan = planCinema({ ...VIDEO, ...CLIPS }, ctx);
    expect(plan.model.id).toBe("minimax-h3");
    expect(plan.steps[0].request).toMatchObject({ modelId: "minimax-h3", op: "ref2v", inputs: CLIPS });
    expect(plan.notes[0]).toBe("Fuobe Cinema doesn't take reference clips yet, so this take runs on MiniMax H3 (a partner model) with them — pick Fuobe Cinema in the menu to leave them out");
    expect(plan.costUsd).toBeGreaterThan(0);
    // Only a reference video, or only audio: the same.
    expect(planCinema({ ...VIDEO, videos: CLIPS.videos }, ctx).model.id).toBe("minimax-h3");
    expect(planCinema({ ...VIDEO, audios: CLIPS.audios }, ctx).model.id).toBe("minimax-h3");
    // More clips than MiniMax H3 takes (3 of each kind): the first partner that takes them all.
    const many = planCinema({ ...VIDEO, videos: ["/api/files/a.mp4", "/api/files/b.mp4", "/api/files/c.mp4", "/api/files/d.mp4"], audios: CLIPS.audios }, ctx);
    expect(many.model.id).toBe("seedance-2-5");
    expect(many.steps[0].request.inputs?.videos).toHaveLength(4);
    // No clips, or the GPU, or a still: Fuobe Cinema stays.
    expect(planCinema(VIDEO, ctx).model.id).toBe("fuobe-cinema");
    expect(planCinema({ ...VIDEO, ...CLIPS, engine: "open" }, ctx).model.id).toBe("fuobe-cinema");
  });
});

describe("draftToInput", () => {
  it("maps the prompt bar's state to a generate request", () => {
    const d = initialDraft();
    const refs = [
      { id: "1", ref: "/api/files/a.png", preview: "", kind: "image" as const },
      { id: "2", ref: "", preview: "blob:x", kind: "image" as const, uploading: true },
      { id: "3", ref: "/api/files/b.mp4", preview: "", kind: "video" as const },
      { id: "4", ref: "/api/files/c.mp3", preview: "", kind: "audio" as const },
    ];
    const v = draftToInput({ ...d, prompt: "rain", refs, models: { "video:cloud": "kling-3" } }, "cloud", { genre: "noir" });
    expect(v).toMatchObject({ engine: "cloud", mode: "video", action: "generate", modelId: "kling-3", prompt: "rain", images: ["/api/files/a.png"], videos: ["/api/files/b.mp4"], audios: ["/api/files/c.mp3"], settings: { genre: "noir" } });
    expect(v.source).toBeUndefined();
    expect(v.grid).toBeUndefined();

    // A selected take: its action and source go along (with the first frame read in the browser).
    const source = { generationId: "g1", url: "/api/files/take.mp4", kind: "video" as const, label: "Take" };
    const edit = draftToInput({ ...d, source, action: "edit" }, "open", {}, "/api/files/frame.png");
    expect(edit).toMatchObject({ action: "edit", source: { url: source.url, kind: "video", firstFrame: "/api/files/frame.png" } });
    // Image mode ignores the take and its action; Grid sends the grid.
    const grid = draftToInput({ ...d, mode: "image", imageTool: "grid", source, action: "edit", grid: { size: "3x3", type: "zooms" } }, "cloud", {});
    expect(grid).toMatchObject({ mode: "image", action: "grid", grid: { size: "3x3", type: "zooms" }, moves: undefined, multiShot: undefined });
    expect(grid.source).toBeUndefined();
    expect(draftToInput({ ...d, mode: "image", source, action: "edit" }, "cloud", {}).action).toBe("generate");
  });

  it("sends what the browser knows about the picked take: its model, scene, length and size", () => {
    const d = initialDraft();
    const take = { generationId: "g1", url: "/api/files/take.mp4", kind: "video" as const, label: "Take", modelId: "seedance-2-5", prompt: "  a lighthouse at dusk  ", seconds: 30.0417, resolution: "720p", aspectRatio: "21:9" };
    const edit = draftToInput({ ...d, source: take, action: "edit", prompt: "make it snow" }, "cloud", {});
    expect(edit.source).toEqual({ url: take.url, kind: "video", modelId: "seedance-2-5", prompt: "a lighthouse at dusk", seconds: 30.04, resolution: "720p", aspectRatio: "21:9" });
    // Unknown facts are left out rather than sent empty.
    const bare = draftToInput({ ...d, source: { ...take, modelId: undefined, prompt: " ", seconds: Number.NaN, resolution: undefined, aspectRatio: undefined }, action: "edit" }, "cloud", {});
    expect(bare.source).toEqual({ url: take.url, kind: "video" });
  });
});
