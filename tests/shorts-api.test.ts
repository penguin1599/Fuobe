import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Generation } from "@/lib/catalog/types";
import { tempDir } from "./helpers/temp-dir";

vi.setConfig({ testTimeout: 120_000 });
// Regenerate is switched off for now (REGEN_OFFERED); Shorts' Enhance is checked as it runs once switched on.
// tests/regenerate-held.test.ts checks that every way in refuses it while it is off.
vi.mock("@/lib/catalog/regenerate", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/catalog/regenerate")>()), REGEN_OFFERED: true }));

const dir = tempDir("fuobe-shorts-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";
process.env.OLLAMA_URL = "http://127.0.0.1:9";

const { setSetting } = await import("@/server/settings");
const gens = await import("@/server/generations");
const { saveFile } = await import("@/server/storage");
const { db } = await import("@/server/db");
const shorts = await import("@/server/shorts");
const mixed = await import("@/server/mixed-media");
const { getModel } = await import("@/lib/catalog");
const sessionsRoute = await import("@/app/api/shorts/sessions/route");
const sessionRoute = await import("@/app/api/shorts/sessions/[id]/route");
const regenRoute = await import("@/app/api/shorts/sessions/[id]/segments/[index]/route");
const primaryRoute = await import("@/app/api/shorts/sessions/[id]/segments/[index]/primary/route");
const stitchRoute = await import("@/app/api/shorts/sessions/[id]/stitch/route");
const enhanceRoute = await import("@/app/api/shorts/sessions/[id]/segments/[index]/enhance/route");
const estimateRoute = await import("@/app/api/shorts/estimate/route");
const presetsRoute = await import("@/app/api/shorts/presets/route");
const mixedRoute = await import("@/app/api/mixed-media/route");
const mixedPreviewRoute = await import("@/app/api/mixed-media/preview/route");
const mixedEstimateRoute = await import("@/app/api/mixed-media/estimate/route");
const mixedRetryRoute = await import("@/app/api/mixed-media/retry/route");
const mixedProgressRoute = await import("@/app/api/mixed-media/progress/route");

const json = (method: string, body?: unknown) =>
  new Request("http://x/api", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) }) as never;

let clip = "";
let png = "";

beforeAll(() => {
  setSetting("demoMode", "auto");
  // A 12 s, 16 fps clip with a sound track.
  clip = saveFile({ data: fs.readFileSync(path.join(__dirname, "fixtures/shorts-12s.mp4")), contentType: "video/mp4", source: "upload", name: "beach day.mp4" }).url;
  png = saveFile({ data: Buffer.from("89504e470d0a1a0a", "hex"), contentType: "image/png", source: "upload" }).url;
});

async function settle(id: string, ms = 90_000): Promise<Generation> {
  const end = Date.now() + ms;
  for (;;) {
    const g = gens.getGeneration(id)!;
    if (["succeeded", "failed", "canceled"].includes(g.status)) return g;
    if (Date.now() > end) throw new Error(`timed out: ${g.status} ${g.message}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

const dependsOn = (id: string) => {
  const v = (db().prepare("SELECT depends_on FROM generations WHERE id = ?").get(id) as { depends_on: string | null }).depends_on;
  return !v ? [] : v.startsWith("[") ? (JSON.parse(v) as string[]) : [v];
};

// Gemini Omni Flash (Higgsfield's Shorts engine, a partner choice) unless a test names another model; Fuobe Shorts, the
// default since build plan O9, has tests of its own below.
const body = (over: Record<string, unknown> = {}) => ({
  engine: "cloud",
  presetId: "shorts-claymation",
  source: { url: clip, name: "beach day.mp4" },
  range: { start: 0, end: 12 },
  aspectRatio: "9:16",
  language: "auto",
  ...(over.engine === "open" ? {} : { modelId: "gemini-omni-flash" }),
  ...over,
});

describe("Shorts sessions", () => {
  it("reads the clip's length, frame rate and sound from its header", async () => {
    const info = await shorts.probeSource(clip);
    expect(info.duration).toBeCloseTo(12, 1);
    expect(info.fps).toBeCloseTo(16, 1);
    expect(info.hasAudio).toBe(true);
    await expect(shorts.probeSource("https://example.com/x.mp4")).rejects.toThrow(/Upload the clip first/);
  });

  it("estimates before anything is made: demo is free, a connected provider is priced per second", async () => {
    const demo = await (await estimateRoute.POST(json("POST", body({ source: { url: "/api/files/placeholder.mp4", duration: 12 } })))).json();
    expect(demo).toMatchObject({ demo: true, costUsd: 0, segments: 2, seconds: 12 });
    setSetting("falKey", "test-key");
    try {
      const est = await shorts.estimateShorts(body({ source: { url: clip, duration: 12 } }) as never);
      expect(est.demo).toBe(false);
      // Gemini Omni Flash at 720p ($0.10/s): two 6 s segments, plus the cuts, the join and the soundtrack (≈ free).
      expect(est.costUsd!).toBeGreaterThanOrEqual(1.2);
      expect(est.costUsd!).toBeLessThan(1.25);
      expect(est.perSegmentUsd!).toBeGreaterThanOrEqual(0.6);
      expect(est.perSegmentUsd!).toBeLessThan(0.62);
      // A 9:16 clip for a 9:16 short: nothing to crop. The same clip as a 16:9 short is centre-cropped first.
      expect(est.notes.join(" ")).not.toMatch(/cropped/);
      const wide = await shorts.estimateShorts(body({ aspectRatio: "16:9", source: { url: clip, duration: 12, width: 72, height: 128 } }) as never);
      expect(wide.notes).toContain("Your 72×128 clip is centre-cropped to 16:9 before the restyle");
    } finally {
      setSetting("falKey", "");
    }
    const bad = await estimateRoute.POST(json("POST", body({ range: { start: 0, end: 2 } })));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("Select at least 4 seconds");
  });

  let sessionId = "";

  it("creates a cloud session: segments cut and restyled, stitched under the original sound", async () => {
    const res = await sessionsRoute.POST(json("POST", body()));
    expect(res.status).toBe(201);
    const s = await res.json();
    sessionId = s.id;
    expect(s).toMatchObject({ title: "Claymation · beach day", engine: "cloud", range: { start: 0, end: 12 }, settings: { aspectRatio: "9:16", modelId: "gemini-omni-flash", maxRefs: 0, resolution: "720p" } });
    expect(s.source).toMatchObject({ hasAudio: true });
    expect(s.segments).toHaveLength(2);
    expect(s.segments.map((g: { start: number; end: number }) => [g.start, g.end])).toEqual([
      [0, 6],
      [6, 12],
    ]);
    const [a, b] = s.segments;
    expect(a.primary).toBe(a.takes[0].look);
    expect(dependsOn(a.takes[0].look)).toEqual([a.takes[0].cut]);
    const look = gens.getGeneration(a.takes[0].look)!;
    expect(look).toMatchObject({ modelId: "gemini-omni-flash", op: "v2v", feature: "shorts" });
    expect(look.request.step?.label).toBe("Segment 1 of 2 · restyle");
    const stitch = s.stitches[0];
    const final = gens.getGeneration(stitch.final)!;
    expect(final).toMatchObject({ modelId: "merge-audio-video", op: "mux" });
    // The whole clip: the upload carries the sound; the join waits for both restyles.
    expect(final.request.inputs?.audio).toBe(clip);
    const join = stitch.ids.find((id: string) => gens.getGeneration(id)!.op === "concat");
    expect(dependsOn(join)).toEqual([a.takes[0].look, b.takes[0].look]);
    expect(dependsOn(stitch.final)).toEqual([join]);
    expect(await settle(stitch.final)).toMatchObject({ status: "succeeded" });
  });

  it("returns the session with its generations, and lists it in History", async () => {
    // (GET handlers call connection(), which needs a request scope: read through the server module.)
    const s = shorts.getSession(sessionId);
    expect(Object.keys(s.generations).length).toBe(6);
    expect(shorts.regenerateCost(s)).toBe(0);
    const list = shorts.listSessions();
    expect(list[0]).toMatchObject({ id: sessionId, lookName: "Claymation", segments: 2, seconds: 12, status: "ready" });
    expect(list[0].cover!.op).toBe("mux");
  });

  it("regenerates a segment, picks the new take and stitches again", async () => {
    const res = await regenRoute.POST(json("POST"), params({ id: sessionId, index: "1" }));
    expect(res.status).toBe(201);
    const s = await res.json();
    const seg = s.segments[1];
    expect(seg.takes).toHaveLength(2);
    // The first take is fine, so it stays the chosen one until the user picks.
    expect(seg.primary).toBe(seg.takes[0].look);
    const fresh = seg.takes[1].look;
    expect(gens.getGeneration(fresh)!.request.params?.seed).toEqual(expect.any(Number));
    await settle(fresh);
    const picked = await (await primaryRoute.POST(json("POST", { generationId: fresh }), params({ id: sessionId, index: "1" }))).json();
    expect(picked.segments[1].primary).toBe(fresh);
    const wrong = await primaryRoute.POST(json("POST", { generationId: "nope" }), params({ id: sessionId, index: "1" }));
    expect(wrong.status).toBe(400);
    const st = await (await stitchRoute.POST(json("POST"), params({ id: sessionId }))).json();
    expect(st.stitches).toHaveLength(2);
    const last = st.stitches[1];
    expect(last.clips).toEqual([st.segments[0].primary, fresh]);
    const join = gens.getGeneration(last.ids[0])!;
    // Finished takes are joined by file: nothing to wait for.
    expect(join.request.inputs?.videos).toHaveLength(2);
    expect(dependsOn(join.id)).toEqual([]);
    expect(await settle(last.final)).toMatchObject({ status: "succeeded", op: "mux" });
  });

  it("starts one session per request id, and one stitch per set of takes", async () => {
    const before = shorts.listSessions().length;
    const req = () => sessionsRoute.POST(json("POST", body({ requestId: "dbl-click-0001" })));
    // A double click that got through: both requests arrive before either is answered.
    const [a, b] = await Promise.all([req(), req()]);
    const [sa, sb] = [await a.json(), await b.json()];
    expect(sa.id).toBe(sb.id);
    expect(shorts.listSessions().length).toBe(before + 1);
    // A different id is a new session.
    const c = await (await sessionsRoute.POST(json("POST", body({ requestId: "dbl-click-0002" })))).json();
    expect(c.id).not.toBe(sa.id);
    // Stitch again with the same takes while that stitch is still running: refused, not paid twice.
    await settle(sa.stitches[0].final);
    const fresh = shorts.regenerateSegment(sa.id, 0).segments[0].takes.at(-1)!.look;
    await settle(fresh);
    shorts.makePrimary(sa.id, 0, fresh);
    const st = (id: string) => stitchRoute.POST(json("POST", { requestId: id }), params({ id: sa.id }));
    const [s1, s2] = await Promise.all([st("stitch-nonce-1"), st("stitch-nonce-1")]);
    expect((await s1.json()).stitches).toHaveLength(2);
    expect((await s2.json()).stitches).toHaveLength(2);
    const again = await st("stitch-nonce-2");
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("These takes are already being stitched");
    // Regenerate with the same id twice: one new take.
    const r = (rid: string) => regenRoute.POST(json("POST", { requestId: rid }), params({ id: sa.id, index: "1" }));
    const [r1, r2] = await Promise.all([r("take-nonce-1"), r("take-nonce-1")]);
    expect((await r1.json()).segments[1].takes).toHaveLength(2);
    expect((await r2.json()).segments[1].takes).toHaveLength(2);
    const view = shorts.getSession(sa.id);
    await Promise.all([settle(view.stitches[1].final), settle(view.segments[1].takes[1].look)]);
    shorts.deleteSession(sa.id);
    shorts.deleteSession(c.id);
  });

  it("crops each cut to the output ratio before a restyle model that keeps its input's shape", async () => {
    const s = await shorts.createSession(body({ aspectRatio: "16:9", range: { start: 0, end: 8 } }) as never);
    expect(s.source).toMatchObject({ width: 72, height: 128 });
    const take = s.segments[0].takes[0];
    expect(take.fit).toEqual(expect.any(String));
    expect(gens.getGeneration(take.fit!)).toMatchObject({ modelId: "scale-video", op: "reframe", request: { params: { aspectRatio: "16:9", extra: { width: 1920, height: 1080 } } } });
    expect(dependsOn(take.fit!)).toEqual([take.cut]);
    expect(dependsOn(take.look)).toEqual([take.fit]);
    expect(shorts.sessionIds(s)).toContain(take.fit);
    // A new take crops its cut too.
    const again = shorts.regenerateSegment(s.id, 0).segments[0].takes[1];
    expect(dependsOn(again.look)).toEqual([again.fit]);
    expect(await settle(s.stitches[0].final)).toMatchObject({ status: "succeeded" });
    await settle(again.look);
    shorts.deleteSession(s.id);
  });

  it("won't stitch while a segment is still rendering", async () => {
    const s = shorts.regenerateSegment(sessionId, 0);
    const take = s.segments[0].takes.at(-1)!.look;
    shorts.makePrimary(sessionId, 0, take);
    const res = await stitchRoute.POST(json("POST"), params({ id: sessionId }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Segment 1 is still rendering");
    await settle(take);
  });

  it("trims: the segments start at the selection and the sound is the source cut to it", async () => {
    const s = await shorts.createSession(body({ range: { start: 1.5, end: 9.5 } }) as never);
    expect(s.segments).toHaveLength(1);
    expect(s.segments[0]).toMatchObject({ start: 1.5, end: 9.5 });
    const final = gens.getGeneration(s.stitches[0].final)!;
    const deps = dependsOn(final.id).map((id) => gens.getGeneration(id)!);
    expect(deps.map((g) => g.op)).toEqual(["v2v", "trim"]);
    expect(deps[1].request.params).toMatchObject({ startTime: 1.5, endTime: 9.5 });
    // The mux takes the cut clip's soundtrack (an audio slot fed by a video).
    expect(await settle(final.id)).toMatchObject({ status: "succeeded" });
  });

  it("runs the open engine: segment (+ first frame) → Qwen first-frame restyle → Wan VACE → join → soundtrack", async () => {
    const s = await shorts.createSession(body({ engine: "open" }) as never);
    // Fuobe Shorts is the open engine's restyle model (the same graph oss-wan22-vace-restyle ran), on the GPU.
    expect(s.settings.modelId).toBe("fuobe-shorts");
    expect(gens.getGeneration(s.segments[0].takes[0].look)).toMatchObject({ modelId: "fuobe-shorts", engine: "open", provider: "mock" });
    expect(s.segments.map((g) => g.frames)).toEqual([65, 65, 61]);
    const take = s.segments[2].takes[0];
    expect(gens.getGeneration(take.cut)).toMatchObject({ modelId: "oss-segment", op: "trim" });
    expect(gens.getGeneration(take.frame!)).toMatchObject({ modelId: "oss-qwen-image-21-turbo", op: "edit" });
    expect(dependsOn(take.look)).toEqual([take.cut, take.frame]);
    const final = await settle(s.stitches[0].final);
    expect(final).toMatchObject({ status: "succeeded", modelId: "oss-mux" });
    // The first-frame restyle got the segment's first frame.
    const frame = gens.getGeneration(take.frame!)!;
    expect(frame.status).toBe("succeeded");
    expect(frame.request.inputs?.images?.[0]).toMatch(/^\/api\/files\//);
  });

  it("enhances a segment on your GPU (RIFE to 24 fps, then Regenerate at 1080p) and stitches the mix at one rate", async () => {
    const s = await shorts.createSession(body({ engine: "open" }) as never);
    const before = await settle(s.segments[1].primary);
    expect(before.status).toBe("succeeded");
    const res = await enhanceRoute.POST(json("POST", { requestId: "enhance-1" }), params({ id: s.id, index: "1" }));
    expect(res.status).toBe(201);
    const v = await res.json();
    const take = v.segments[1].takes.at(-1);
    expect(take.enhance.from).toBe(s.segments[1].primary);
    expect(gens.getGeneration(take.enhance.smooth)).toMatchObject({ modelId: "oss-rife", op: "interpolate", request: { params: { targetFps: 24 } } });
    const regen = gens.getGeneration(take.look)!;
    expect(regen).toMatchObject({ modelId: "oss-h3-regenerate", op: "upscale-video", engine: "open", feature: "shorts" });
    expect(regen.request.params).toMatchObject({ resolution: "1080p", extra: { startSigma: 0.8, draftFrom: "other" } });
    expect(regen.request.prompt).toBe(before.request.prompt);
    expect(dependsOn(take.look)).toEqual([take.enhance.smooth]);
    // The same request id answers with the first take; an enhanced take isn't enhanced again.
    const same = await (await enhanceRoute.POST(json("POST", { requestId: "enhance-1" }), params({ id: s.id, index: "1" }))).json();
    expect(same.segments[1].takes).toHaveLength(2);
    expect(await settle(take.look)).toMatchObject({ status: "succeeded" });
    const picked = shorts.makePrimary(s.id, 1, take.look);
    expect((await enhanceRoute.POST(json("POST"), params({ id: s.id, index: "1" }))).status).toBe(409);
    // The stitch: the other segments to 24 fps, the join at 1080p, each clip in its place.
    await settle(s.stitches[0].final);
    const st = await (await stitchRoute.POST(json("POST"), params({ id: picked.id }))).json();
    const ids: string[] = st.stitches.at(-1).ids;
    const smooth = ids.map((id) => gens.getGeneration(id)!).filter((g) => g.modelId === "oss-rife");
    expect(smooth).toHaveLength(2);
    const join = ids.map((id) => gens.getGeneration(id)!).find((g) => g.op === "concat")!;
    expect(join.request.params?.resolution).toBe("1080p");
    expect(await settle(st.stitches.at(-1).final)).toMatchObject({ status: "succeeded" });
    const joined = gens.getGeneration(join.id)!;
    const regenUrl = gens.getGeneration(take.look)!.outputs[0].url;
    expect(joined.request.inputs?.videos?.[1]).toBe(regenUrl);
    // A cloud short: Enhance runs on your GPU only.
    const cloud = await shorts.createSession(body() as never);
    await settle(cloud.segments[0].primary);
    const refused = await enhanceRoute.POST(json("POST"), params({ id: cloud.id, index: "0" }));
    expect(refused.status).toBe(422);
    expect((await refused.json()).error).toMatch(/runs on your GPU \(open source\)/);
  });

  it("runs Fuobe Shorts in the cloud by default: cut → first frame → Qwen edit in the look → Wan Fun VACE by depth → join → sound", async () => {
    const rest = { ...body(), modelId: undefined };
    const s = await shorts.createSession(rest as never);
    expect(s.settings).toMatchObject({ modelId: "fuobe-shorts", maxRefs: 2, resolution: "720p", reframes: false });
    // A 16 fps clip: pieces of up to 240 frames (15 s) and 10 s: two 6 s segments.
    expect(s.source).toMatchObject({ fps: expect.closeTo(16, 1) });
    expect(s.segments.map((g) => [g.start, g.end])).toEqual([
      [0, 6],
      [6, 12],
    ]);
    const take = s.segments[1].takes[0];
    const still = gens.getGeneration(take.still!)!;
    expect(still).toMatchObject({ modelId: "extract-frame", op: "frame", feature: "shorts-step", request: { params: { extra: { frame_type: "first" } } } });
    expect(dependsOn(still.id)).toEqual([take.cut]);
    expect(gens.getGeneration(take.frame!)).toMatchObject({ modelId: "qwen-image-edit-2511-cloud", op: "edit" });
    expect(dependsOn(take.frame!)).toEqual([take.still]);
    const look = gens.getGeneration(take.look)!;
    // The Original runs on the cloud engine asked for, billed on frames ÷ 16 (16 fps: the segment's own 6 s).
    expect(look).toMatchObject({ modelId: "fuobe-shorts", engine: "cloud", op: "v2v", feature: "shorts", request: { params: { duration: 6, sourceDuration: 6, resolution: "720p" } } });
    expect(dependsOn(take.look)).toEqual([take.cut, take.frame]);
    expect(shorts.sessionIds(s)).toEqual(expect.arrayContaining([take.still, take.frame]));
    // A new take makes its own first frame; the stitch joins the takes under the clip's sound.
    const again = shorts.regenerateSegment(s.id, 1).segments[1].takes[1];
    expect(again.still).toEqual(expect.any(String));
    expect(dependsOn(again.look)).toEqual([again.cut, again.frame]);
    expect(await settle(s.stitches[0].final)).toMatchObject({ status: "succeeded", modelId: "merge-audio-video" });
    expect(gens.getGeneration(take.frame!)!.request.inputs?.images?.[0]).toMatch(/^\/api\/files\//);
    await settle(again.look);
    setSetting("falKey", "test-key");
    try {
      const est = await shorts.estimateShorts({ ...rest, source: { url: clip, duration: 12, fps: 16 } } as never);
      // Wan 2.2 Fun VACE at 720p, $0.10 per video second, two 6 s segments at 16 fps, plus the first frames' Qwen edits.
      expect(est).toMatchObject({ demo: false, segments: 2 });
      expect(est.costUsd!).toBeGreaterThanOrEqual(1.2);
      expect(est.costUsd!).toBeLessThan(1.35);
      // Before the clip's rate is known it is priced as 30 fps (30 ÷ 16 of its length): never less than the run costs.
      const unknown = await shorts.estimateShorts(rest as never);
      expect(unknown.costUsd!).toBeGreaterThan(2.25);
      expect(est.notes.join(" ")).toMatch(/Fuobe Shorts draws each segment's first frame in the look/);
      // A 30 fps clip is billed at 30 ÷ 16 of its length, in pieces of 8 s; a 60 fps one is worked at 30 fps.
      const fast = await shorts.estimateShorts({ ...rest, source: { url: clip, duration: 12, fps: 60 } } as never);
      expect(fast.notes.join(" ")).toMatch(/works this 60 fps clip at 30 fps/);
    } finally {
      setSetting("falKey", "");
    }
    shorts.deleteSession(s.id);
  });

  it("custom presets: references go to models that take them", async () => {
    const res = await presetsRoute.POST(json("POST", { description: "dusty desert film", references: [png, png] }));
    expect(res.status).toBe(201);
    const p = await res.json();
    expect(p).toMatchObject({ name: "Dusty desert film", references: [png] });
    expect(shorts.listCustomPresets().map((x) => x.id)).toContain(p.id);
    const kling = await shorts.createSession(body({ presetId: p.id, modelId: "kling-o3-4k-edit", range: { start: 0, end: 8 } }) as never);
    expect(kling.settings.maxRefs).toBe(4);
    const look = gens.getGeneration(kling.segments[0].takes[0].look)!;
    expect(look.request.inputs?.images).toEqual([png]);
    expect(look.request.prompt).toMatch(/^Restyle this video as the look of the reference images: dusty desert film\./);
    const est = await shorts.estimateShorts(body({ presetId: p.id }) as never);
    expect(est.refsSent).toBe(0);
    expect(est.notes[0]).toMatch(/restyles from words only/);
  });

  it("reads WebM headers: a silent recording gets no soundtrack step (it would fail after the restyles were paid for)", async () => {
    const webm = (name: string) => saveFile({ data: fs.readFileSync(path.join(__dirname, "fixtures", name)), contentType: "video/webm", source: "upload", name }).url;
    const silent = webm("shorts-silent.webm");
    expect(await shorts.probeSource(silent)).toMatchObject({ hasAudio: false, width: 96, height: 64 });
    expect((await shorts.probeSource(webm("shorts-sound.webm"))).hasAudio).toBe(true);
    const s = await shorts.createSession(body({ source: { url: silent, name: "screen.webm" }, range: { start: 0, end: 6 } }) as never);
    expect(s.source.hasAudio).toBe(false);
    const final = gens.getGeneration(s.stitches[0].final)!;
    expect(final.op).toBe("v2v");
    expect(Object.values(shorts.getSession(s.id).generations).some((g) => g.op === "mux")).toBe(false);
    await settle(final.id);
    // A file nobody can read counts as silent too.
    const junk = saveFile({ data: Buffer.from("not a video"), contentType: "video/mp4", source: "upload", name: "x.mp4" }).url;
    expect(await shorts.probeSource(junk)).toEqual({});
    shorts.deleteSession(s.id);
  });

  it("checks the picture's size and shape, and custom presets on words-only models", async () => {
    const big = await estimateRoute.POST(json("POST", body({ source: { url: "/api/files/placeholder.mp4", duration: 12, width: 7680, height: 4320 } })));
    expect(big.status).toBe(400);
    expect((await big.json()).error).toBe("This clip is 7680×4320 — use one up to 4000 px on its long side");
    const tall = await estimateRoute.POST(json("POST", body({ source: { url: "/api/files/placeholder.mp4", duration: 12, width: 400, height: 1600 } })));
    expect((await tall.json()).error).toBe("Use a clip between 1:3 and 3:1");
    const bare = shorts.createCustomPreset({ references: [png] });
    const words = await estimateRoute.POST(json("POST", body({ presetId: bare.id })));
    expect(words.status).toBe(422);
    expect((await words.json()).error).toBe("Gemini Omni Flash 1.1 restyles from words only — describe the look in your preset, or pick Fuobe Shorts or Kling O3 4K Edit or Happy Horse Video Edit");
    const kling = await (await estimateRoute.POST(json("POST", body({ presetId: bare.id, modelId: "kling-o3-4k-edit" })))).json();
    expect(kling.refsSent).toBe(1);
    shorts.deleteCustomPreset(bare.id);
  });

  it("respects the engine mode", async () => {
    setSetting("engineMode", "open");
    try {
      const res = await sessionsRoute.POST(json("POST", body()));
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/open-source models only/);
    } finally {
      setSetting("engineMode", "both");
    }
  });

  it("deletes a session and moves its videos to the Trash", async () => {
    const ids = shorts.sessionIds(shorts.getSession(sessionId));
    const res = await sessionRoute.DELETE(json("DELETE"), params({ id: sessionId }));
    expect((await res.json()).trashed).toBe(ids.length);
    expect(gens.getGeneration(ids[0])).toBeNull();
    expect(() => shorts.getSession(sessionId)).toThrow(/no longer exists/);
  });
});

describe("Mixed Media renders", () => {
  // The cloud's Per frame tests below are Nano Banana 2.1's lanes unless a test names another model; Fuobe Mixed Media, the
  // default since build plan O9, has tests of its own (and tests/mixed-shorts-originals.test.ts).
  const mm = (over: Record<string, unknown> = {}) => ({
    engine: "open",
    presetId: "mixed-sketch",
    values: { ink: "#c1121f", intensity: "bold" },
    source: { url: clip, name: "skate.mp4" },
    range: { start: 2, end: 7 },
    fps: 24,
    resolution: "1K",
    ...(over.engine === "cloud" && !over.mode && !over.modelId ? { modelId: "nano-banana-2-1" } : {}),
    ...over,
  });

  it("estimates frames as floor(seconds × fps) and caps the frame rate at the clip's", async () => {
    const est = await (await mixedEstimateRoute.POST(json("POST", mm({ source: { url: "/api/files/placeholder.mp4", duration: 12, fps: 16 } })))).json();
    expect(est).toMatchObject({ frames: 80, fps: 16, demo: true, costUsd: 0, previewUsd: 0 });
  });

  it("renders on the open engine in one per-frame job", async () => {
    const res = await mixedRoute.POST(json("POST", mm()));
    expect(res.status).toBe(201);
    const { final, items } = await res.json();
    expect(items).toHaveLength(1);
    // Fuobe Mixed Media on your GPU: the look's LoRA (Sketch: pencil) and one seed for every frame.
    expect(final).toMatchObject({ modelId: "fuobe-mixed-media", engine: "open", feature: "mixed-media", request: { title: "Sketch · skate" } });
    expect(final.request.params).toMatchObject({ startTime: 2, endTime: 7, fps: 16, seed: 424242, extra: { denoise: 0.82 } });
    expect(final.request.loras.map((l: { file: string }) => l.file)).toEqual(["Zimage_pencil_sketch.safetensors"]);
    expect(final.request.prompt).toMatch(/deep red \(#C1121F\) ink/);
    expect(await settle(final.id)).toMatchObject({ status: "succeeded" });
    // An API caller that names the per-frame model from before the Original keeps it.
    const legacy = await mixed.createMixed(mm({ modelId: "oss-mixed-media" }) as never);
    expect(legacy.final).toMatchObject({ modelId: "oss-mixed-media" });
    expect(legacy.final.request.loras).toBeUndefined();
    await settle(legacy.final.id);
  });

  it("renders on the cloud (Fast): cut → restyle anchored on the preview still → the cut's sound", async () => {
    const preview = await (await mixedPreviewRoute.POST(json("POST", mm({ engine: "cloud", frameUrl: png })))).json();
    expect(preview).toMatchObject({ modelId: "nano-banana-2-1", op: "edit", feature: "mixed-media-preview" });
    const still = await settle(preview.id);
    const anchor = still.outputs[0].url;
    const { final, items } = await mixed.createMixed(mm({ engine: "cloud", mode: "fast", anchor }) as never);
    expect(items.map((g) => g.modelId)).toEqual(["trim-video", "ltx-2-3-restyle", "merge-audio-video"]);
    expect(items[1].request.inputs?.images).toEqual([anchor]);
    expect(items[1].request.params?.extra).toEqual({ preprocessor: "canny" });
    expect(dependsOn(final.id)).toEqual([items[1].id, items[0].id]);
    expect(await settle(final.id)).toMatchObject({ status: "succeeded", feature: "mixed-media" });
  });

  it("tries a failed render again with the same settings, from the step that failed (the cut is kept)", async () => {
    const { final, items } = await mixed.createMixed(mm({ engine: "cloud", mode: "fast", range: { start: 1, end: 4 } }) as never);
    // The restyle stops: the soundtrack step then fails with the generic "An earlier step didn't finish".
    await settle(items[0].id);
    await gens.cancelGeneration(items[1].id);
    expect(await settle(final.id)).toMatchObject({ status: "failed", error: "An earlier step didn't finish" });
    const res = await mixedRetryRoute.POST(json("POST", { id: final.id, requestId: "mm-retry-0001" }));
    expect(res.status).toBe(201);
    const again = await res.json();
    // The cut finished: it isn't made (or paid for) again.
    expect(again.items.map((g: Generation) => g.modelId)).toEqual(["ltx-2-3-restyle", "merge-audio-video"]);
    expect(again.final.id).not.toBe(final.id);
    expect(again.final.batchId).not.toBe(final.batchId);
    // Same settings; the chained inputs are filled again, from the kept cut.
    expect(again.items[0].request).toMatchObject({ prompt: items[1].request.prompt, params: items[1].request.params });
    expect(again.items[0].request.inputs?.video).toBeUndefined();
    expect(dependsOn(again.items[0].id)).toEqual([items[0].id]);
    expect(dependsOn(again.final.id)).toEqual([again.items[0].id, items[0].id]);
    expect(await settle(again.final.id)).toMatchObject({ status: "succeeded" });
    const gone = await mixedRetryRoute.POST(json("POST", { id: "nope" }));
    expect(gone.status).toBe(404);
  });

  it("starts one render per request id", async () => {
    const req = () => mixedRoute.POST(json("POST", mm({ requestId: "mm-render-0001" })));
    const [a, b] = await Promise.all([req(), req()]);
    const [ra, rb] = [await a.json(), await b.json()];
    expect(ra.final.id).toBe(rb.final.id);
    await settle(ra.final.id);
  });

  it("refuses a cut the cloud model won't take, before anything is paid for", async () => {
    const res = await mixedRoute.POST(json("POST", mm({ engine: "cloud", mode: "fast", modelId: "kling-o3-4k-edit", range: { start: 2, end: 3.4 } })));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Kling O3 4K Edit needs at least 3 s — select more, or pick LTX 2.3 Reference Restyle");
    // LTX takes it.
    const est = await mixed.estimateMixed(mm({ engine: "cloud", mode: "fast", range: { start: 2, end: 3.4 } }) as never);
    expect(est.costUsd).toBe(0);
  });

  it("asks for a grabbed frame before a cloud preview", async () => {
    const res = await mixedPreviewRoute.POST(json("POST", mm({ engine: "cloud" })));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Couldn't grab a frame/);
  });

  it("prices the cloud per-frame render from the editor's price per frame", async () => {
    setSetting("falKey", "fal-test-key");
    try {
      const est = await mixed.estimateMixed(mm({ engine: "cloud", source: { url: "/api/files/placeholder.mp4", duration: 12, fps: 30 }, range: { start: 0, end: 10 }, fps: 8 }) as never);
      // Nano Banana 2.1: the catalog's one price an image (fal bills its tokens).
      const per = getModel("nano-banana-2-1")!.pricing!.usd;
      expect(est).toMatchObject({ mode: "frames", frames: 75, fps: 7.5, perFrameUsd: per, demo: false, previewUsd: per });
      expect(est.notes).toContain("Frames are every 4th frame of this 30 FPS clip: 7.5 FPS, 75 frames");
      // A render that names Nano Banana 2 (a saved setup, an API caller) runs on Nano Banana 2.1, not the Original.
      const older = await mixed.estimateMixed(mm({ engine: "cloud", modelId: "nano-banana-2", source: { url: "/api/files/placeholder.mp4", duration: 12, fps: 30 }, range: { start: 0, end: 10 }, fps: 8 }) as never);
      expect(older).toMatchObject({ mode: "frames", modelId: "nano-banana-2-1", perFrameUsd: per });
      expect(older.notes).toContain(`${getModel("nano-banana-2")!.name} is now ${getModel("nano-banana-2-1")!.name} here`);
      // 75 frames × the frame price, plus the cut, the extraction and the assembly (fal compute, about free).
      expect(est.costUsd).toBeGreaterThanOrEqual(75 * per);
      expect(est.costUsd).toBeLessThan(75 * per + 0.01);
      const big = await mixed.estimateMixed(mm({ engine: "cloud", source: { url: "/api/files/placeholder.mp4", duration: 12, fps: 24 }, range: { start: 0, end: 5 }, fps: 24, resolution: "4K" }) as never);
      expect(big).toMatchObject({ frames: 120, fps: 24, perFrameUsd: per });
      expect(big.costUsd).toBeGreaterThanOrEqual(120 * per);
      // Over 200 frames the clips are joined at up to 2048 px: 4K frames would be paid for and shrunk, so they are drawn at 2K.
      const joined = await mixed.estimateMixed(mm({ engine: "cloud", source: { url: "/api/files/placeholder.mp4", duration: 12, fps: 24 }, range: { start: 0, end: 10 }, fps: 24, resolution: "4K" }) as never);
      expect(joined).toMatchObject({ frames: 240, perFrameUsd: per });
      expect(joined.costUsd).toBeGreaterThanOrEqual(240 * per);
      expect(joined.costUsd).toBeLessThan(240 * per + 0.1);
      expect(joined.notes).toContain("Over 200 frames are made as clips and joined at up to 2048 px, so frames are drawn at 2K");
      const flash = await mixed.estimateMixed(mm({ engine: "cloud", modelId: "seedream-5-flash", source: { url: "/api/files/placeholder.mp4", duration: 12, fps: 24 }, range: { start: 0, end: 5 }, fps: 8 }) as never);
      expect(flash).toMatchObject({ frames: 40, perFrameUsd: 0.027 });
      expect(flash.notes.join(" ")).toMatch(/Seedream 5\.0 Flash takes no seed/);
      // Fast keeps the video-to-video price, and says what it skips.
      const fast = await mixed.estimateMixed(mm({ engine: "cloud", mode: "fast", source: { url: "/api/files/placeholder.mp4", duration: 12, fps: 24 }, range: { start: 0, end: 5 } }) as never);
      expect(fast.mode).toBe("fast");
      expect(fast.perFrameUsd).toBeUndefined();
      expect(fast.notes.join(" ")).toMatch(/Per frame redraws every frame/);
      // No frame rate, no per-frame plan.
      const res = await mixedEstimateRoute.POST(json("POST", mm({ engine: "cloud", source: { url: "/api/files/placeholder.mp4", duration: 12 } })));
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/pick Fast/);
      // A caller from before Per frame that names a Fast model gets Fast, as before; a model of the other mode is refused, not swapped.
      const legacy = await mixed.estimateMixed(mm({ engine: "cloud", modelId: "ltx-2-3-restyle", source: { url: "/api/files/placeholder.mp4", duration: 12 }, range: { start: 0, end: 5 } }) as never);
      expect(legacy.mode).toBe("fast");
      expect(legacy.perFrameUsd).toBeUndefined();
      const wrong = await mixedEstimateRoute.POST(json("POST", mm({ engine: "cloud", mode: "frames", modelId: "ltx-2-3-restyle", source: { url: "/api/files/placeholder.mp4", duration: 12, fps: 24 } })));
      expect(wrong.status).toBe(422);
      expect((await wrong.json()).error).toBe("LTX 2.3 Reference Restyle restyles the clip as video — pick Fast for it, or Fuobe Mixed Media or Nano Banana 2.1 or Seedream 5.0 Flash to redraw each frame");
      const still = await mixedEstimateRoute.POST(json("POST", mm({ engine: "cloud", mode: "fast", modelId: "nano-banana-2-1", source: { url: "/api/files/placeholder.mp4", duration: 12, fps: 24 } })));
      expect(still.status).toBe(422);
      expect((await still.json()).error).toMatch(/^Nano Banana 2.1 redraws single frames — pick Per frame/);
    } finally {
      setSetting("falKey", "");
    }
  });

  it("renders on the cloud frame by frame (demo) and tries it again from new frames", async () => {
    const res = await mixedRoute.POST(json("POST", mm({ engine: "cloud", range: { start: 1, end: 2 }, fps: 4, requestId: "mm-frames-0001" })));
    expect(res.status).toBe(201);
    const { final, items, frames } = await res.json();
    // The page follows the main steps; the per-frame edits are counted.
    expect(frames).toBe(4);
    expect(items.map((g: Generation) => g.op)).toEqual(["trim", "extract-frames", "images-to-video", "mux"]);
    const done = await settle(final.id);
    expect(done).toMatchObject({ status: "succeeded", feature: "mixed-media" });
    const edits = gens.listGenerations({ batchId: final.batchId, features: ["mixed-media-frame-step"], limit: 50 }).sort((a, b) => a.request.step!.index - b.request.step!.index);
    expect(edits.map((g) => g.request.step?.label)).toEqual(["Frame 1 of 4", "Frame 2 of 4", "Frame 3 of 4", "Frame 4 of 4"]);
    const extracted = gens.getGeneration(items[1].id)!.outputs;
    expect(edits[0].request.inputs?.images).toEqual([extracted[0].url]);
    expect(edits[2].request.inputs?.images).toEqual([extracted[2].url, edits[1].outputs[0].url]);
    expect(gens.getGeneration(items[2].id)!.request.inputs?.images).toEqual(edits.map((g) => g.outputs[0].url));

    const again = await (await mixedRetryRoute.POST(json("POST", { id: final.id, requestId: "mm-frames-retry1" }))).json();
    expect(again.frames).toBe(4);
    const redo = gens.listGenerations({ batchId: again.final.batchId, features: ["mixed-media-frame-step"], limit: 50 }).sort((a, b) => a.request.step!.index - b.request.step!.index);
    // Rebuilt from the stored steps without the old frames in them.
    expect(redo.map((g) => g.request.inputs)).toEqual([undefined, undefined, undefined, undefined]);
    expect(redo.map((g) => g.request.chainFilled)).toEqual([undefined, undefined, undefined, undefined]);
    expect(await settle(again.final.id)).toMatchObject({ status: "succeeded" });
    expect(gens.getGeneration(redo[3].id)!.request.inputs?.images).toHaveLength(2);
    expect(mixed.framesProgress(again.final.id)).toEqual({ total: 4, done: 4, running: 0 });

    // A frame failed after the others were paid for: Try again redraws that frame and the ones after it in its
    // lane (they matched it), keeping the rest, the cut and the extraction.
    const old = gens.listGenerations({ batchId: again.final.batchId, features: ["mixed-media-frame-step"], limit: 50 }).sort((a, b) => a.request.step!.index - b.request.step!.index);
    const steps = gens.listGenerations({ batchId: again.final.batchId, features: ["mixed-media-step"], limit: 50 });
    const clipStep = steps.find((g) => g.op === "images-to-video")!;
    const fail = (id: string, error: string) => db().prepare("UPDATE generations SET status = 'failed', error = ? WHERE id = ?").run(error, id);
    fail(old[2].id, "Refused by the safety filter");
    fail(old[3].id, "An earlier step didn't finish");
    fail(clipStep.id, "An earlier step didn't finish");
    fail(again.final.id, "An earlier step didn't finish");
    expect(mixed.framesProgress(again.final.id)).toMatchObject({ total: 4, done: 2, failed: { label: "Frame 3 of 4", error: "Refused by the safety filter" } });
    const third = await (await mixedRetryRoute.POST(json("POST", { id: again.final.id, requestId: "mm-frames-retry2" }))).json();
    expect(third.frames).toBe(2);
    expect(third.items.map((g: Generation) => g.op)).toEqual(["images-to-video", "mux"]);
    const redrawn = gens.listGenerations({ batchId: third.final.batchId, features: ["mixed-media-frame-step"], limit: 50 }).sort((a, b) => a.request.step!.index - b.request.step!.index);
    expect(redrawn.map((g) => g.request.step?.label)).toEqual(["Frame 3 of 4", "Frame 4 of 4"]);
    // Frame 3 waits on the kept extraction and the kept frame 2.
    expect(dependsOn(redrawn[0].id)).toEqual([...dependsOn(old[2].id).slice(0, 1), old[1].id]);
    expect(await settle(third.final.id)).toMatchObject({ status: "succeeded" });
    const rebuilt = gens.getGeneration(third.items[0].id)!.request.inputs?.images;
    expect(rebuilt?.slice(0, 2)).toEqual([old[0].outputs[0].url, old[1].outputs[0].url]);
    expect(rebuilt?.slice(2)).toEqual(redrawn.map((g) => gens.getGeneration(g.id)!.outputs[0].url));
    // Progress follows the render across tries: all four frames.
    expect(mixed.framesProgress(third.final.id)).toEqual({ total: 4, done: 4, running: 0 });
  });

  it("renders on Fuobe Mixed Media by default, frame by frame on its own (one seed, the look's LoRA, no lanes), and Smooth", async () => {
    const noir = { ...mm({ engine: "cloud", presetId: "mixed-noir", values: {}, range: { start: 1, end: 2 }, fps: 4 }), modelId: undefined };
    const { final, items, frames } = await mixed.createMixed(noir as never);
    expect(frames).toBe(4);
    expect(items.map((g: Generation) => g.op)).toEqual(["trim", "extract-frames", "images-to-video", "mux"]);
    expect(await settle(final.id)).toMatchObject({ status: "succeeded", feature: "mixed-media" });
    const edits = gens.listGenerations({ batchId: final.batchId ?? undefined, features: ["mixed-media-frame-step"], limit: 50 }).sort((a, b) => a.request.step!.index - b.request.step!.index);
    const extracted = gens.getGeneration(items[1].id)!.outputs;
    // Each frame is its own controlled draw: only its own extracted frame goes in, every one waits for the extraction only.
    for (const [i, g] of edits.entries()) {
      expect(g).toMatchObject({ modelId: "fuobe-mixed-media", engine: "cloud", op: "edit", request: { params: { seed: 424242 } } });
      expect(g.request.inputs?.images).toEqual([extracted[i].url]);
      expect(dependsOn(g.id)).toEqual([items[1].id]);
      expect(g.request.loras?.map((l) => l.file)).toEqual(["darkroom-noir.safetensors"]);
      expect(g.prompt).toMatch(/^drkrm style, /);
    }
    // Smooth: the first frame in the look (the Original), then Fuobe Shorts' Wan 2.2 Fun VACE pass; the cut's sound back.
    // fal's Wan 2.2 Fun VACE takes 17 frames or more: 1 s of this 16 fps clip is refused before anything is paid for.
    await expect(mixed.createMixed({ ...noir, mode: "smooth" } as never)).rejects.toThrow(/needs at least 17 frames: select at least 1\.1 s .* or pick Per frame/);
    const smooth = await mixed.createMixed({ ...noir, mode: "smooth", range: { start: 1, end: 3 } } as never);
    const ops = smooth.items.map((g: Generation) => `${g.modelId} ${g.op}`).sort();
    // The cut, its first frame, that frame in the look, Wan Fun VACE by depth, the selection's sound and the mux.
    expect(ops).toEqual(["extract-frame frame", "fuobe-mixed-media edit", "fuobe-shorts v2v", "merge-audio-video mux", "trim-video trim", "trim-video trim"]);
    const pass = smooth.items.find((g: Generation) => g.modelId === "fuobe-shorts")!;
    expect(pass.engine).toBe("cloud");
    expect(smooth.items.find((g: Generation) => g.modelId === "fuobe-mixed-media")!.engine).toBe("cloud");
    expect(await settle(smooth.final.id)).toMatchObject({ status: "succeeded", feature: "mixed-media", modelId: "merge-audio-video" });
    const est = await mixed.estimateMixed({ ...noir, mode: "smooth" } as never);
    expect(est).toMatchObject({ mode: "smooth", demo: true, modelId: "fuobe-mixed-media" });
    expect(est.notes.join(" ")).toMatch(/Smooth draws the first frame in the look/);
    // Smooth is the Original's own; Fast is the cloud's.
    expect((await mixedEstimateRoute.POST(json("POST", { ...noir, mode: "smooth", modelId: "nano-banana-2-1" }))).status).toBe(422);
    expect((await mixedEstimateRoute.POST(json("POST", mm({ mode: "fast" })))).status).toBe(422);
  });

  it("says which frame failed and why, not just that an earlier step didn't finish", async () => {
    const { final } = await mixed.createMixed(mm({ engine: "cloud", range: { start: 1, end: 2 }, fps: 4 }) as never);
    const edits = gens.listGenerations({ batchId: final.batchId!, features: ["mixed-media-frame-step"], limit: 50 }).sort((a, b) => a.request.step!.index - b.request.step!.index);
    await gens.cancelGeneration(edits[1].id);
    expect(await settle(final.id)).toMatchObject({ status: "failed" });
    const res = await mixedProgressRoute.GET(new Request(`http://x/api/mixed-media/progress?id=${final.id}`));
    const progress = await res.json();
    expect(progress).toMatchObject({ total: 4, failed: { label: "Frame 2 of 4", error: "Canceled" } });
    expect((await mixedProgressRoute.GET(new Request("http://x/api/mixed-media/progress"))).status).toBe(400);
    expect((await mixedProgressRoute.GET(new Request("http://x/api/mixed-media/progress?id=nope"))).status).toBe(404);
  });

  it("stops the frames still waiting when one fails, so the other lanes aren't paid for", async () => {
    // 4 s at 4 FPS: 16 frames in two lanes (frames 1–12 and 13–16).
    const { final, frames } = await mixed.createMixed(mm({ engine: "cloud", range: { start: 1, end: 5 }, fps: 4 }) as never);
    expect(frames).toBe(16);
    const edits = gens.listGenerations({ batchId: final.batchId!, features: ["mixed-media-frame-step"], limit: 50 }).sort((a, b) => a.request.step!.index - b.request.step!.index);
    db().prepare("UPDATE generations SET status = 'failed', error = 'Refused by the safety filter', completed_at = ? WHERE id = ?").run(Date.now(), edits[13].id);
    expect(await settle(final.id)).toMatchObject({ status: "failed" });
    for (const g of edits) await settle(g.id);
    const rows = edits.map((g) => db().prepare("SELECT status, error, external_id FROM generations WHERE id = ?").get(g.id) as { status: string; error: string | null; external_id: string | null });
    // None of the other frames reached a provider: they were waiting for the cut and the extraction.
    expect(rows.filter((r) => r.external_id)).toEqual([]);
    expect(rows.filter((r) => r.status === "canceled").every((r) => r.error === gens.DROPPED_UNUSED)).toBe(true);
    expect(rows.filter((r) => r.status === "canceled")).toHaveLength(14);
    expect(mixed.framesProgress(final.id)).toMatchObject({ total: 16, done: 0, failed: { label: "Frame 14 of 16", error: "Refused by the safety filter" } });
  });

  it("names the step that failed when no frame did (the extraction), not frame 1", async () => {
    const { final, items } = await mixed.createMixed(mm({ engine: "cloud", range: { start: 1, end: 2 }, fps: 4 }) as never);
    const extract = items.find((g) => g.op === "extract-frames")!;
    await gens.cancelGeneration(extract.id);
    expect(await settle(final.id)).toMatchObject({ status: "failed" });
    const progress = mixed.framesProgress(final.id)!;
    expect(progress.total).toBe(4);
    expect(progress.failed).toBeUndefined();
  });
});
