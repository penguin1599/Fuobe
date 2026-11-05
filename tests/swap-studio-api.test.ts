import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { currentSegments, jobState, type SwapProject } from "@/lib/catalog/swap-studio";
import type { SwapProjectView } from "@/server/swap-studio";
import { tempDir } from "./helpers/temp-dir";

vi.setConfig({ testTimeout: 240_000 });
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

// Character Swap Studio's API end to end in demo mode (no keys, no ComfyUI): projects, clips, cuts, words, masks,
// anchors, segments queued with continuations (waiting, launched, stopped), review and the assembly, on both engines.
const dir = tempDir("fuobe-swap-studio-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";
process.env.OLLAMA_URL = "http://127.0.0.1:9";

const { setSetting } = await import("@/server/settings");
const gens = await import("@/server/generations");
const { saveFile } = await import("@/server/storage");
const { encodePng } = await import("@/server/png");
const { recordExists } = await import("@/server/records");
const projects = await import("@/app/api/swap-studio/projects/route");
const project = await import("@/app/api/swap-studio/projects/[id]/route");
const clips = await import("@/app/api/swap-studio/projects/[id]/clips/route");
const transcribe = await import("@/app/api/swap-studio/projects/[id]/transcribe/route");
const masks = await import("@/app/api/swap-studio/projects/[id]/masks/route");
const anchors = await import("@/app/api/swap-studio/projects/[id]/anchors/route");
const queue = await import("@/app/api/swap-studio/projects/[id]/queue/route");
const stopTake = await import("@/app/api/swap-studio/projects/[id]/takes/stop/route");
const assemble = await import("@/app/api/swap-studio/projects/[id]/assemble/route");
const estimate = await import("@/app/api/swap-studio/projects/[id]/estimate/route");
const decisionsRoute = await import("@/app/api/swap-studio/projects/[id]/decisions/route");

const req = (method: string, body?: unknown) => new Request("http://x/api", { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let clip = "";
let hero = "";
beforeAll(() => {
  setSetting("demoMode", "auto");
  // A 12 s, 16 fps, 72×128 clip with a sound track.
  clip = saveFile({ data: fs.readFileSync(path.join(__dirname, "fixtures/shorts-12s.mp4")), contentType: "video/mp4", source: "upload", name: "dance.mp4" }).url;
  const data = Buffer.alloc(64 * 64 * 4, 200);
  hero = saveFile({ data: encodePng({ width: 64, height: 64, data }), contentType: "image/png", source: "upload", name: "hero.png" }).url;
});

async function view(id: string): Promise<SwapProjectView> {
  const res = await project.GET(req("GET"), ctx(id) as never);
  expect(res.status).toBe(200);
  return res.json();
}

async function patch(id: string, edit: unknown): Promise<SwapProject> {
  const res = await project.PATCH(req("PATCH", edit), ctx(id) as never);
  if (res.status !== 200) throw new Error(`${res.status}: ${(await res.json()).error}`);
  return res.json();
}

async function post(route: { POST: (r: Request, c: never) => Promise<Response> }, id: string, body: unknown, status = 201) {
  const res = await route.POST(req("POST", body), ctx(id) as never);
  const out = await res.json();
  if (res.status !== status) throw new Error(`${res.status}: ${out.error}`);
  return out;
}

/** Poll the project (as the page does) until `done` holds. */
async function until(id: string, done: (v: SwapProjectView) => boolean, ms = 150_000): Promise<SwapProjectView> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await view(id);
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(Object.values(v.gens).map((g) => g.status))}`);
    await sleep(400);
  }
}

const statusOf = (v: SwapProjectView, genId?: string) => (genId ? v.gens[genId]?.status : undefined);

describe("Character Swap Studio: the cloud, as a demo", () => {
  let id = "";

  it("makes a project, takes a clip and refuses one it can't", async () => {
    const created = await post(projects, "", { name: "Rain scene", engine: "cloud", character: { image: hero, description: "a woman in a yellow raincoat" } });
    id = created.id;
    expect(created).toMatchObject({ name: "Rain scene", engine: "cloud", character: { image: hero } });
    expect(recordExists({ kind: "swap-project", ids: [id] })).toBe(true);
    expect(recordExists({ kind: "swap-project", ids: ["swap-nope"] })).toBe(false);
    const list = await (await projects.GET(req("GET"))).json();
    expect(list.items[0]).toMatchObject({ id, clips: 0 });

    const p = await post(clips, id, { url: clip, name: "dance.mp4" });
    const c = p.clips[0];
    // 12 s at 24 fps; the cloud keeps the clip as filmed (no 24 fps copy).
    expect(c).toMatchObject({ name: "dance", frames: 288, normalized: null, cutsReviewed: false, source: { duration: 12, hasAudio: true, width: 72, height: 128 } });
    expect(c.shots).toHaveLength(1);
    await expect(post(clips, id, { url: clip, name: "dance.gif" })).rejects.toThrow(/MP4, MOV, MKV, WebM or AVI/);
    await expect(post(clips, id, { url: "/api/files/uploads/nothing.mp4", name: "x.mp4" })).rejects.toThrow(/upload it again/);
  });

  it("confirms cuts, transcribes the words with who speaks, builds the prompts", async () => {
    let p = (await view(id)).project;
    const c = p.clips[0];
    p = await patch(id, { type: "detected", clipId: c.id, cuts: [96, 200] });
    expect(p.clips[0].detected).toEqual([96, 200]);
    p = await patch(id, { type: "cuts", clipId: c.id, cuts: [96], modes: ["generate", "preserve"] });
    expect(p.clips[0].shots.map((s) => [s.start, s.end, s.mode])).toEqual([
      [0, 96, "generate"],
      [96, 288, "preserve"],
    ]);
    p = await post(transcribe, id, { clipId: c.id }, 200);
    expect(p.clips[0].transcript).toMatchObject({ modelId: "scribe-v2", cues: null });
    const v = await until(id, (x) => !!x.project.clips[0].transcript?.cues);
    expect(v.project.clips[0].transcript!.cues!.length).toBeGreaterThan(0);
    p = await patch(id, { type: "build-prompts", clipId: c.id });
    expect(p.clips[0].shots[0].prompt).toMatch(/Current shot dialogue: "This is a demo transcript\./);
    expect(p.clips[0].shots[1].prompt).toBeNull();
  });

  it("prices before running: a take of each segment, the shot, the project", async () => {
    const res = await estimate.GET(req("GET"), ctx(id) as never);
    const e = await res.json();
    const shot = (await view(id)).project.clips[0].shots[0];
    expect(e).toMatchObject({ engine: "cloud", demo: true, free: false });
    const segs = currentSegments(shot);
    expect(Object.keys(e.segments)).toEqual(segs.map((g) => g.id));
    expect(e.shots[shot.id].segments).toBe(segs.length);
    expect(e.project.segments).toBe(segs.length);
    expect(e.notes.join(" ")).toMatch(/no mask/);
    expect(e.anchors.map((a: { id: string }) => a.id)).toEqual(["gpt-image-2-5-sunburst", "nano-banana-pro"]);
  });

  it("who to swap: clicks on a frame become a SAM 3.1 mask version; a scene anchor is made and approved", async () => {
    const p = (await view(id)).project;
    const [c] = p.clips;
    const shot = c.shots[0];
    // An exclude point alone is refused.
    await expect(post(masks, id, { clipId: c.id, shotId: shot.id, kind: "track", frame: 0, points: [{ x: 10, y: 10, label: "negative" }] })).rejects.toThrow(/include point/);
    await expect(post(masks, id, { clipId: c.id, shotId: shot.id, kind: "frame", frame: 3, points: [{ x: 10, y: 10 }] })).rejects.toThrow(/Track the shot first/);
    // Clicked on a 144×256 picture of the 72×128 clip: the points are halved.
    let q = await post(masks, id, { clipId: c.id, shotId: shot.id, kind: "track", frame: 0, points: [{ x: 72, y: 128, label: "positive" }], size: { width: 144, height: 256 } });
    const m = q.clips[0].shots[0].masks[0];
    expect(m).toMatchObject({ kind: "track", engine: "cloud", frame: 0, points: [{ x: 36, y: 64, label: "positive" }], pieces: [{ from: 0, frames: 96 }] });
    const sam = gens.getGeneration(m.genId)!;
    expect(sam.modelId).toBe("sam-3-1-video-mask");
    q = await post(anchors, id, { clipId: c.id, shotId: shot.id, modelId: "nano-banana-pro" });
    const a = q.clips[0].shots[0].anchors[0];
    expect(a).toMatchObject({ source: "generated", modelId: "nano-banana-pro" });
    // Approving before it is made is refused.
    await expect(patch(id, { type: "shot", clipId: c.id, shotId: shot.id, patch: { approvedAnchor: a.id } })).rejects.toThrow(/isn't ready/);
    const v = await until(id, (x) => !!x.project.clips[0].shots[0].anchors[0].url && !!x.project.clips[0].shots[0].masks[0].pieces[0].url);
    expect(jobState(m.genId, m.stepIds, v.gens).status).toBe("succeeded");
    const done = await patch(id, { type: "shot", clipId: c.id, shotId: shot.id, patch: { approvedAnchor: a.id, approvedMask: m.id } });
    expect(done.clips[0].shots[0]).toMatchObject({ approvedAnchor: a.id, approvedMask: m.id });
    // Update frame on the cloud: a one-frame piece over the tracked version.
    q = await post(masks, id, { clipId: c.id, shotId: shot.id, kind: "frame", frame: 3, points: [{ x: 30, y: 60 }] });
    expect(q.clips[0].shots[0].masks[1].pieces.map((x: { from: number; frames: number }) => [x.from, x.frames])).toEqual([
      [0, 96],
      [3, 1],
    ]);
  });

  it("queues two segments: the second waits for the first, then starts from its last frame", async () => {
    let p = (await view(id)).project;
    const [c] = p.clips;
    const shot = c.shots[0];
    p = await patch(id, { type: "layout", clipId: c.id, shotId: shot.id, op: { op: "partition", frames: 48 } });
    const segs = p.clips[0].shots[0].segments!;
    expect(segs.map((g) => [g.start, g.end, g.connection])).toEqual([
      [0, 48, "start"],
      [48, 96, "continue"],
    ]);
    // Segment 2 alone can't run before segment 1 has a take.
    await expect(post(queue, id, { clipId: c.id, shotId: shot.id, segmentId: segs[1].id, mode: "segment" })).rejects.toThrow(/Generate segment 1 first/);
    const out = await post(queue, id, { clipId: c.id, shotId: shot.id, segmentId: segs[0].id, mode: "all" });
    const [t1, t2] = out.project.clips[0].shots[0].segments!.map((g: { takes: { id: string; state: string; waitsOn?: unknown[] }[] }) => g.takes[0]);
    expect(t1.state).toBe("launched");
    expect(t2).toMatchObject({ state: "waiting", waitsOn: [{ segmentId: segs[0].id, takeId: t1.id }] });
    // Asking again while they run: nothing to queue.
    await expect(post(queue, id, { clipId: c.id, shotId: shot.id, segmentId: segs[0].id, mode: "all" })).rejects.toThrow(/already current, queued or generating/);
    // The layout can't change under them.
    await expect(patch(id, { type: "layout", clipId: c.id, shotId: shot.id, op: { op: "merge", index: 1 } })).rejects.toThrow(/409: Wait for this shot's takes/);
    const v = await until(id, (x) => {
      const s = x.project.clips[0].shots[0].segments!;
      return s.every((g) => g.selectedTake && statusOf(x, g.takes[0].genId) === "succeeded");
    });
    const after = v.project.clips[0].shots[0].segments!;
    expect(after.map((g) => g.selectedTake)).toEqual([t1.id, t2.id]);
    // The second take: cut, the first take's last frame, H3 with the swap LoRA and both pictures, cut back to 2 s.
    const take2 = after[1].takes[0];
    const steps = take2.stepIds!.map((s) => gens.getGeneration(s)!);
    expect(steps.map((g) => g.modelId)).toEqual(["trim-video", "extract-frame", "fuobe-character-swap", "trim-video"]);
    // The boundary is the last frame of the first take as trimmed to its segment (H3 made 5 s for 2 s).
    const take1 = gens.getGeneration(after[0].takes[0].genId!)!;
    expect(take1).toMatchObject({ modelId: "trim-video", request: { params: { startTime: 0, endTime: 2 } } });
    expect(steps[1].request.inputs?.video).toBe(v.gens[take1.id].url);
    expect(steps[1].request.params?.extra).toEqual({ frame_type: "last" });
    const swap = steps[2].request;
    expect(swap.loras?.[0]?.file).toMatch(/swap/i);
    expect(swap.params).toMatchObject({ duration: 5, sourceDuration: 2 });
    expect(steps[3].request.params).toMatchObject({ startTime: 0, endTime: 2 });
    expect(take2.genId).toBe(steps[3].id);
    // The anchor is Image 2 on the first segment; after the boundary the boundary frame is Image 2, the anchor Image 3.
    const swap1 = after[0].takes[0].stepIds!.map((s) => gens.getGeneration(s)!).find((g) => g.modelId === "fuobe-character-swap")!;
    expect(swap1.request.prompt).toMatch(/Image 2 is the exact first-frame scene/);
    expect(swap.prompt).toMatch(/Image 2 is the generated boundary/);
  });

  it("review: favourite, decide, note; Export decisions; assemble over the original timeline with its sound", async () => {
    const p = (await view(id)).project;
    const [c] = p.clips;
    const shot = c.shots[0];
    const seg = shot.segments![0];
    await patch(id, { type: "take", clipId: c.id, shotId: shot.id, segmentId: seg.id, takeId: seg.takes[0].id, favourite: true, decision: "keep", notes: "eyes match" });
    await patch(id, { type: "clip", clipId: c.id, review: "keep", reviewNotes: "ship it" });
    const res = await decisionsRoute.GET(req("GET"), ctx(id) as never);
    expect(res.headers.get("Content-Disposition")).toMatch(/Rain-scene-decisions\.json/);
    const d = await res.json();
    expect(d).toMatchObject({ project: "Rain scene", clips: [{ clip: "dance", review: "keep", notes: "ship it", shots: [{ shot: 1, frames: [0, 96], mode: "generate" }, { shot: 2, mode: "preserve", segments: [] }] }] });
    expect(d.clips[0].shots[0].segments[0].takes[0]).toMatchObject({ favourite: true, decision: "keep", notes: "eyes match" });

    const q = await post(assemble, id, { clipId: c.id });
    const asm = q.clips[0].assembly;
    expect(asm.takes).toEqual(shot.segments!.map((g) => g.selectedTake));
    await expect(post(assemble, id, { clipId: c.id })).rejects.toThrow(/being assembled/);
    const v = await until(id, (x) => statusOf(x, x.project.clips[0].assembly?.genId) === "succeeded");
    const steps = asm.stepIds.map((s: string) => gens.getGeneration(s)!);
    // The two takes (already their segments' length) and the kept shot cut to its frames, all scaled to one frame
    // (the 72×128 clip's shape, 512 px on its short side for merge-videos), joined at 24 fps, the clip's sound put back.
    expect(steps.map((g: { modelId: string }) => g.modelId)).toEqual(["scale-video", "scale-video", "trim-video", "scale-video", "join-clips", "merge-audio-video"]);
    const final = gens.getGeneration(asm.genId)!;
    expect(final).toMatchObject({ feature: "swap-studio", op: "mux" });
    expect(final.request.inputs?.audio).toBe(clip);
    expect(steps[2].request.params).toMatchObject({ startTime: 4, endTime: 12 });
    expect(steps[0].request.params).toMatchObject({ extra: { width: 512, height: 910 } });
    expect(steps[4].request.params).toMatchObject({ extra: { target_fps: 24 } });
    expect(v.gens[asm.genId].url).toBeTruthy();
    // The step generations stay out of the Library; the assembled clip is in it.
    expect(gens.listGenerations({ feature: "swap-studio" }).map((g) => g.id)).toContain(asm.genId);
  });

  it("a clip the browser can't play gets a copy for the page; removing a clip stops the jobs it started", async () => {
    let p: SwapProject = await post(clips, id, { url: clip, name: "night.mp4", playable: false });
    const c = p.clips[1];
    const copy = gens.getGeneration(c.preview!.genId!)!;
    expect(copy).toMatchObject({ modelId: "scale-video", op: "reframe", feature: "swap-studio-step", request: { inputs: { video: clip }, params: { extra: { width: 72, height: 128 } } } });
    const v = await until(id, (x) => !!x.project.clips[1].preview?.url);
    expect(v.project.clips[1].preview!.url).toBe(v.gens[copy.id].url);
    // The jobs still read the clip as filmed.
    p = await post(masks, id, { clipId: c.id, shotId: c.shots[0].id, kind: "track", frame: 0, points: [] });
    const m = p.clips[1].shots[0].masks[0];
    expect(gens.getGeneration(m.stepIds![0])!.request.inputs?.video).toBe(clip);
    // Removed while its mask is still being made: the mask's generations are stopped (nothing would show them).
    expect([...m.stepIds!, m.genId].map((g) => gens.getGeneration(g!)!.status)).not.toContain("succeeded");
    await patch(id, { type: "remove-clip", clipId: c.id });
    for (const g of [...m.stepIds!, m.genId!]) expect(gens.getGeneration(g)!.status).toBe("canceled");
    expect((await view(id)).project.clips).toHaveLength(1);
  });
});

describe("Character Swap Studio: your GPU, as a demo", () => {
  let id = "";

  it("prepares the clip at 24 fps, continues from the previous take's lossless master, stops what follows a failed take", async () => {
    id = (await post(projects, "", { name: "GPU", engine: "open", character: { image: hero, description: "a knight" } })).id;
    let p: SwapProject = await post(clips, id, { url: clip, name: "dance.mp4" });
    const c = p.clips[0];
    const norm = gens.getGeneration(c.normalized!.genId!)!;
    expect(norm.modelId).toBe("oss-fit-clip");
    expect(norm.request.params).toMatchObject({ startTime: 0, fps: 24, extra: { width: 72, height: 128 } });
    // Masks wait for the 24 fps copy.
    await expect(post(masks, id, { clipId: c.id, shotId: c.shots[0].id, kind: "track", frame: 0, points: [] })).rejects.toThrow(/being prepared at 24 fps/);
    await until(id, (x) => !!x.project.clips[0].normalized?.url);
    const e = await (await estimate.GET(req("GET"), ctx(id) as never)).json();
    expect(e).toMatchObject({ engine: "open", demo: true });
    expect(e.notes.join(" ")).toMatch(/H3 Relay 2\.0/);

    const shot = c.shots[0];
    p = await patch(id, { type: "shot", clipId: c.id, shotId: shot.id, patch: { settings: { useAnchor: false } } });
    p = await patch(id, { type: "layout", clipId: c.id, shotId: shot.id, op: { op: "partition", frames: 144 } });
    let segs = p.clips[0].shots[0].segments!;
    for (const g of segs) p = await patch(id, { type: "segment", clipId: c.id, shotId: shot.id, segmentId: g.id, patch: { anchorMode: "none" } });
    segs = p.clips[0].shots[0].segments!;
    const out = await post(queue, id, { clipId: c.id, shotId: shot.id, segmentId: segs[0].id, mode: "all" });
    const [t1, t2] = out.project.clips[0].shots[0].segments.map((g: { takes: { id: string }[] }) => g.takes[0]);
    const v = await until(id, (x) => statusOf(x, x.project.clips[0].shots[0].segments![1].takes[0].genId) === "succeeded");
    const after = v.project.clips[0].shots[0].segments!;
    const first = gens.getGeneration(after[0].takes[0].genId!)!;
    const second = gens.getGeneration(after[1].takes[0].genId!)!;
    expect(first).toMatchObject({ modelId: "oss-h3-swap-segment", op: "video-swap", feature: "swap-studio-step" });
    expect(first.request.inputs?.video).toBe(v.project.clips[0].normalized!.url);
    expect(first.request.params?.extra).not.toHaveProperty("historyVideo");
    // Take 1's master keeps its last 18 frames of 144 (what segment 2 reads), and segment 2 reads all of them.
    expect(first.request.params?.extra).toMatchObject({ masterKeep: 18, segmentFrames: 144 });
    expect(after[0].takes[0].frozen?.keep).toBe(18);
    expect(second.request.params?.extra).toMatchObject({ historyVideo: v.gens[first.id].master, historyStart: 0, historyLength: 18 });
    expect(v.gens[first.id].master).toBeTruthy();
    expect(after.map((g) => g.selectedTake)).toEqual([t1.id, t2.id]);

    // Segment 1 made stale (a new seed): "Queue from here" makes both again, segment 2 waiting on segment 1's new take.
    await patch(id, { type: "segment", clipId: c.id, shotId: shot.id, segmentId: segs[0].id, patch: { seed: 7 } });
    const q = await post(queue, id, { clipId: c.id, shotId: shot.id, segmentId: segs[0].id, mode: "from" });
    const [a, b] = q.project.clips[0].shots[0].segments.map((g: { takes: { id: string; state: string }[] }) => g.takes.at(-1)!);
    expect(a.state).toBe("launched");
    expect(b).toMatchObject({ state: "waiting", waitsOn: [{ segmentId: segs[0].id, takeId: a.id }] });
    // Stopping segment 1's take stops segment 2's, with the reason, before it runs.
    await stopTake.POST(req("POST", { clipId: c.id, shotId: shot.id, segmentId: segs[0].id, takeId: a.id }), ctx(id) as never);
    const stopped = await until(id, (x) => x.project.clips[0].shots[0].segments![1].takes.at(-1)!.state === "stopped", 20_000);
    expect(stopped.project.clips[0].shots[0].segments![1].takes.at(-1)!.reason).toMatch(/^Stopped: segment 1's take was stopped/);
  });

  it("deletes the project, and its page is a 404", async () => {
    const res = await project.DELETE(req("DELETE"), ctx(id) as never);
    expect(res.status).toBe(204);
    expect(recordExists({ kind: "swap-project", ids: [id] })).toBe(false);
    expect((await project.GET(req("GET"), ctx(id) as never)).status).toBe(404);
  });
});
