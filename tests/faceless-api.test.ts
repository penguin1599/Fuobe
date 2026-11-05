import { beforeAll, describe, expect, it, vi } from "vitest";
import type { EpisodeSettings, EpisodeView, FacelessChannel, FacelessEpisode } from "@/lib/catalog/faceless";
import { tempDir } from "./helpers/temp-dir";

// Regenerate is switched off for now (REGEN_OFFERED); Faceless's Regenerate to 1080p is checked as it runs once switched on.
// tests/regenerate-held.test.ts checks that every way in refuses it while it is off.
vi.mock("@/lib/catalog/regenerate", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/catalog/regenerate")>()), REGEN_OFFERED: true }));

const dir = tempDir("fuobe-faceless-");
process.env.FUOBE_DATA_DIR = dir;
// Nothing listens: open models run on the demo provider, and there's no LLM (the offline writer runs).
process.env.COMFYUI_URL = "http://127.0.0.1:9";
process.env.OLLAMA_URL = "http://127.0.0.1:9";

const { setSetting } = await import("@/server/settings");
const { db } = await import("@/server/db");
const gens = await import("@/server/generations");
const faceless = await import("@/server/faceless");
const { REGEN_OFFERED } = await import("@/lib/catalog/regenerate");
const channelsRoute = await import("@/app/api/faceless/channels/route");
const channelRoute = await import("@/app/api/faceless/channels/[id]/route");
const topicsRoute = await import("@/app/api/faceless/topics/route");
const episodesRoute = await import("@/app/api/faceless/episodes/route");
const episodeRoute = await import("@/app/api/faceless/episodes/[id]/route");
const actionRoute = await import("@/app/api/faceless/episodes/[id]/[action]/route");
const changeRoute = await import("@/app/api/faceless/episodes/[id]/change/route");
const estimateRoute = await import("@/app/api/faceless/estimate/route");
const voiceRoute = await import("@/app/api/faceless/voices/preview/route");
const explainerRoute = await import("@/app/api/explainer/route");
const linkRoute = await import("@/app/api/explainer/link/route");

beforeAll(() => {
  setSetting("demoMode", "auto");
  setSetting("enhanceProvider", "none");
});

const json = (method: string, body?: unknown) =>
  new Request("http://x/api", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cloud: EpisodeSettings = {
  engine: "cloud",
  length: 60,
  animation: "animated",
  aspect: "16:9",
  subtitles: true,
  music: false,
  styleId: "editorial-motion-graphics",
  styleRefs: [],
  voice: { kind: "preset", id: "Xb7hH8MSUJpSbSDYk0k2" },
  elements: [],
};
const open: EpisodeSettings = { ...cloud, engine: "open", music: true, voice: null, aspect: "9:16", animation: "frames" };

async function view(id: string): Promise<EpisodeView> {
  // GET handlers start with connection(), which needs a request scope: read through the server module.
  return JSON.parse(JSON.stringify(faceless.episodeView(id)));
}

/** Poll an episode until `done` says so (demo jobs: a few seconds per step). */
async function until(id: string, done: (v: EpisodeView) => boolean, what: string, ms = 90_000): Promise<EpisodeView> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await view(id);
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${v.episode.status} ${Math.round(v.progress * 100)}%`);
    await sleep(500);
  }
}
const settled = (id: string) => until(id, (v) => v.episode.status === "done" || v.episode.status === "failed", "the render");

/** Every generation an episode made (now and in its previous version) that's still queued or running. */
const stillRunning = (ids: string[]) => ids.filter((g) => ["queued", "running"].includes(gens.getGeneration(g, { includeDeleted: true })?.status ?? ""));

let channel: FacelessChannel;

describe("Faceless channels and topics", () => {
  it("creates a channel straight away with a name from the idea, then draws its avatar on the server", async () => {
    const res = await channelsRoute.POST(json("POST", { idea: "Channel about the rise and fall of empires", genre: "history", engine: "cloud" }));
    expect(res.status).toBe(201);
    channel = await res.json();
    expect(channel).toMatchObject({ name: "The Rise and Fall of Empires", genre: "history", settings: { styleId: "watercolor-chronicle", voice: { kind: "preset", id: "JBFqnCBsd6RMkjVDRZzb" }, aspect: "16:9", subtitles: true } });
    expect(faceless.listChannels().map((c) => c.id)).toContain(channel.id);
    // The avatar is drawn with the channel; it becomes the channel's picture without a browser watching.
    await faceless.channelReady(channel.id);
    const job = faceless.getChannel(channel.id)!.avatarJob!;
    expect(gens.getGeneration(job)).toMatchObject({ feature: "faceless-avatar" });
    for (let i = 0; i < 40 && gens.getGeneration(job)!.status !== "succeeded"; i++) await sleep(250);
    const pictured = faceless.listChannels().find((c) => c.id === channel.id)!;
    expect(pictured.avatarJob).toBeNull();
    expect(pictured.avatarUrl).toBe(gens.getGeneration(job)!.outputs[0].url);
    // Its file is in use: emptying the Library of that picture keeps it.
    const asset = (db().prepare("SELECT id FROM assets WHERE generation_id = ?").get(job) as { id: string }).id;
    expect(gens.assetInUse(asset, job)).toBe(true);

    expect((await channelsRoute.POST(json("POST", { idea: "", genre: "history", engine: "cloud" }))).status).toBe(400);
    const bad = await channelsRoute.POST(json("POST", { idea: "x", genre: "history", engine: "cloud", reference: "https://vimeo.com/1" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("That does not look like a YouTube channel, video or playlist link.");
    const patched = await (await channelRoute.PATCH(json("PATCH", { name: "Empires", settings: { aspect: "9:16" } }), params({ id: channel.id }))).json();
    expect(patched).toMatchObject({ name: "Empires", settings: { aspect: "9:16", styleId: "watercolor-chronicle" } });
    expect((await channelRoute.PATCH(json("PATCH", { name: "x" }), params({ id: "nope" }))).status).toBe(404);
  });

  it("suggests 4–6 topics offline, and different ones on the next round", async () => {
    const first = await (await topicsRoute.POST(json("POST", { channelId: channel.id, engine: "cloud" }))).json();
    expect(first.offline).toBe(true);
    expect(first.topics.length).toBeGreaterThanOrEqual(4);
    expect(first.topics.length).toBeLessThanOrEqual(6);
    expect(first.topics[0].title).toMatch(/rise and fall of empires/i);
    const titles = first.topics.map((t: { title: string }) => t.title);
    const next = await (await topicsRoute.POST(json("POST", { channelId: channel.id, engine: "cloud", round: 1, avoid: titles }))).json();
    expect(next.topics.length).toBeGreaterThanOrEqual(4);
    expect(next.topics.filter((t: { title: string }) => titles.includes(t.title))).toEqual([]);
  });
});

describe("Episodes", () => {
  it("validates lengths, topics and scripts", async () => {
    const bad = await episodesRoute.POST(json("POST", { channelId: channel.id, topic: "x", settings: { ...cloud, length: 90 } }));
    expect((await bad.json()).error).toBe("Choose one of the offered video lengths");
    const empty = await episodesRoute.POST(json("POST", { channelId: channel.id, topic: " ", settings: cloud }));
    expect((await empty.json()).error).toBe("Add a topic, or bring your own script");
    const long = await episodesRoute.POST(json("POST", { channelId: channel.id, topic: "x", script: "word ".repeat(2500), settings: cloud }));
    expect((await long.json()).error).toBe("That script is too long to narrate. Shorten it and try again.");
    const refs = await episodesRoute.POST(json("POST", { channelId: channel.id, topic: "x", settings: { ...cloud, styleRefs: ["/api/files/a.png", "/api/files/b.png", "/api/files/c.png", "/api/files/d.png"] } }));
    expect((await refs.json()).error).toBe("Up to 3 style references");
  });

  it("splits a pasted script into scenes for review, and edits them before rendering", async () => {
    const script = "The Roman Empire did not fall in a day. For centuries it stretched from Britain to Egypt. Then, slowly, the cracks began to show. Armies grew expensive, borders grew long, and emperors came and went. By 476, the western half was gone.";
    const res = await episodesRoute.POST(json("POST", { channelId: channel.id, topic: "How Rome fell", script, settings: cloud }));
    expect(res.status).toBe(201);
    const ep: FacelessEpisode = await res.json();
    expect(ep.status).toBe("writing");
    await faceless.scriptWritten(ep.id);
    const v = await view(ep.id);
    expect(v.episode.status).toBe("review");
    expect(v.episode.script).toMatchObject({ source: "pasted", offline: true });
    expect(v.episode.script.blocks.map((b) => b.narration).join(" ")).toBe(script);
    expect(v.episode.script.blocks.every((b) => b.seconds <= 10 && b.visual)).toBe(true);
    // Review: edit a scene; a scene with too many words is split.
    const blocks = v.episode.script.blocks.map((b, i) => (i === 0 ? { ...b, narration: `${b.narration} ${"and it kept going on ".repeat(8)}` } : b));
    const edited: EpisodeView = await (await episodeRoute.PATCH(json("PATCH", { blocks, title: "Rome, slowly" }), params({ id: ep.id }))).json();
    expect(edited.episode.title).toBe("Rome, slowly");
    expect(edited.episode.script.blocks.length).toBeGreaterThan(v.episode.script.blocks.length);
    expect(edited.episode.script.blocks.every((b) => b.seconds <= 10)).toBe(true);
    expect(edited.steps.filter((s) => s.part === "still")).toHaveLength(edited.episode.script.blocks.length);
    expect(edited.estimate!.total).toBeGreaterThan(0);
    expect(edited.scenes.map((s) => s.id)).toEqual(edited.episode.script.blocks.map((b) => b.id));
    expect(edited.timing).toBe("planned");
    // A channel's first episode saves its look; later ones only when asked.
    expect(faceless.listEpisodes({ channelId: channel.id }).map((e) => e.id)).toContain(ep.id);
    expect(faceless.getChannel(channel.id)!.settings.aspect).toBe("16:9");
    const vertical = faceless.createEpisode({ kind: "faceless", channelId: channel.id, topic: "Carthage", settings: { ...cloud, aspect: "9:16", styleId: "pixel-art" } });
    expect(faceless.getChannel(channel.id)!.settings).toMatchObject({ aspect: "16:9", styleId: "editorial-motion-graphics" });
    faceless.createEpisode({ kind: "faceless", channelId: channel.id, topic: "Sparta", settings: { ...cloud, aspect: "9:16" }, saveLook: true });
    await sleep(50);
    expect(faceless.getChannel(channel.id)!.settings.aspect).toBe("9:16");
    await faceless.scriptWritten(vertical.id);
  });

  it("estimates by engine and mode, and says what's in the way", async () => {
    const est = async (s: EpisodeSettings) => (await estimateRoute.POST(json("POST", { kind: "faceless", settings: s }))).json();
    const animated = await est(cloud);
    const frames = await est({ ...cloud, animation: "frames" });
    expect(animated.demo).toBe(true);
    expect(animated.blocks).toBe(6);
    expect(animated.estimate.parts.clip).toBeCloseTo(6, 5);
    expect(frames.estimate.total).toBeLessThan(animated.estimate.total);
    const openEst = await est(open);
    expect(openEst.estimate.total).toBe(0);
    expect(openEst.error).toBeUndefined();
    // Cloud music is mixed on the cloud (fal compose): fine on a cloud-only install too.
    expect((await est({ ...cloud, music: true })).error).toBeUndefined();
    setSetting("engineMode", "cloud");
    try {
      const music = await est({ ...cloud, music: true });
      expect(music.error).toBeUndefined();
      expect(music.estimate.parts.music).toBeGreaterThan(0);
      expect((await est(open)).error).toMatch(/cloud APIs only/);
    } finally {
      setSetting("engineMode", "both");
    }
    // What the render will do differently: two of three style references on the open engine, a bed looped past 4 minutes.
    const notes = (await est({ ...open, length: 300, styleRefs: ["/api/files/a.png", "/api/files/b.png", "/api/files/c.png"] })).notes;
    expect(notes).toEqual(expect.arrayContaining([expect.stringMatching(/first 2 style references/), expect.stringMatching(/made 4 min long, then looped with a 3-second crossfade/)]));
  });

  it(
    "renders end to end in demo mode on both engines (narration timed first, then the scenes), re-runs one scene, undoes it and retries a failure",
    async () => {
      const make = async (settings: EpisodeSettings, topic: string) => {
        const ep: FacelessEpisode = await (await episodesRoute.POST(json("POST", { channelId: channel.id, topic, settings }))).json();
        await faceless.scriptWritten(ep.id);
        const v = await view(ep.id);
        expect(v.episode.status).toBe("review");
        expect(v.episode.script).toMatchObject({ source: "ai", offline: true });
        expect(v.episode.script.blocks).toHaveLength(6);
        const r = await actionRoute.POST(json("POST"), params({ id: ep.id, action: "render" }));
        expect(r.status).toBe(200);
        return ep.id;
      };
      // The cloud episode has a music bed: Sonilo, levelled, then composed with the voice on fal.
      const cloudId = await make({ ...cloud, music: true }, "Why Rome split in two");
      const openId = await make(open, "The fall of Byzantium");
      expect((await actionRoute.POST(json("POST"), params({ id: cloudId, action: "render" }))).status).toBe(409);

      // Stage one: the pictures, the narration (the demo voice cloned) and its timing. The clips wait for the timing.
      const rendering = await view(openId);
      expect(rendering.episode.status).toBe("rendering");
      const blocks = rendering.episode.script.blocks;
      expect(rendering.episode.plan!.awaiting).toBe(true);
      expect(Object.keys(rendering.episode.plan!.ids).sort()).toEqual([...blocks.map((b) => `still-${b.id}`), "narration", "words"].sort());
      expect(rendering.steps.filter((s) => s.part === "clip").every((s) => !s.generation)).toBe(true);
      const narration = gens.getGeneration(rendering.episode.plan!.ids.narration)!;
      expect(narration.request.inputs?.voiceAudio).toMatch(/^\/api\/files\/uploads\/.+\.wav$/);

      // Stage two starts by itself once the narration is timed. A demo transcript can't time it: planned lengths.
      const timed = await until(openId, (v) => !v.episode.plan!.awaiting, "stage two");
      const ids = timed.episode.plan!.ids;
      expect(timed.timing).toBe("planned");
      expect(timed.episode.plan!.untimed).toBe(true);
      // Open, frame by frame: one Ken Burns move per scene (no video model), one packet-copy join, music, timed captions.
      const clips = Object.keys(ids).filter((k) => k.startsWith("clip-"));
      expect(clips).toHaveLength(6);
      expect(clips).toHaveLength(timed.steps.filter((s) => s.part === "clip").length);
      expect(Object.keys(ids)).toEqual(expect.arrayContaining(["join", "narration", "music", "mix", "words", "captions"]));
      const move = gens.getGeneration(ids[`clip-${blocks[0].id}-1`])!;
      expect(move).toMatchObject({ modelId: "oss-ken-burns", op: "still-motion" });
      expect(move.request.params).toMatchObject({ zoomFrom: 1, fps: 24, easing: "ease-in-out", resolution: "720p" });
      expect(move.request.prompt).toMatch(/^Slow push-in toward/);
      expect(gens.getGeneration(ids.join)!.modelId).toBe("oss-join-encoded");
      // The timeline shows the film as the clips make it.
      expect(timed.scenes.reduce((n, s) => n + s.seconds, 0)).toBe(clips.reduce((n, k) => n + Number(gens.getGeneration(ids[k])!.request.params?.duration), 0));

      const [doneCloud, doneOpen] = await Promise.all([settled(cloudId), settled(openId)]);
      for (const v of [doneCloud, doneOpen]) {
        expect(v.episode.status).toBe("done");
        expect(v.final?.status).toBe("succeeded");
        expect(v.final?.outputs[0].kind).toBe("video");
        expect(v.progress).toBe(1);
        expect(v.steps.every((s) => s.generation?.status === "succeeded")).toBe(true);
      }
      expect(doneOpen.final!.op).toBe("captions");
      expect(doneOpen.final!.request.title).toBe(doneOpen.episode.title);
      const cloudIds = doneCloud.episode.plan!.ids;
      expect(gens.getGeneration(cloudIds.mix)!.modelId).toBe("ffmpeg-compose");
      expect(gens.getGeneration(cloudIds.level)!.request.inputs?.audio).toBeTruthy();

      // Upscale to 1080p: one step on the finished film, on both engines (the open one upscales in passes of a few frames).
      expect(doneCloud.upscale).toEqual({ costUsd: 0, demo: true });
      expect(doneOpen.upscale).toEqual({ costUsd: 0, demo: true });
      const upscaling: EpisodeView = await (await actionRoute.POST(json("POST"), params({ id: cloudId, action: "upscale" }))).json();
      const up = gens.getGeneration(upscaling.episode.plan!.upscaled!)!;
      expect(up).toMatchObject({ op: "upscale-video", modelId: "seedvr-video" });
      expect(up.request.params?.resolution).toBe("1080p");
      const upscalingOpen: EpisodeView = await (await actionRoute.POST(json("POST"), params({ id: openId, action: "upscale" }))).json();
      expect(gens.getGeneration(upscalingOpen.episode.plan!.upscaled!)).toMatchObject({ op: "upscale-video", modelId: "oss-upscale-video-esrgan", engine: "open" });
      // Regenerate to 1080p (open engine only): every scene redrawn by Open-H3 Regenerate, joined and mixed again with the
      // episode's own narration and subtitles timing; the cloud shows no Regenerate.
      expect(doneCloud.regenerate).toBeNull();
      // Offered on the open engine while Regenerate is (REGEN_OFFERED, switched on for this file).
      expect(REGEN_OFFERED).toBe(true);
      expect(doneOpen.regenerate).toEqual({ scenes: 6, demo: true });
      expect((await actionRoute.POST(json("POST"), params({ id: cloudId, action: "regenerate" }))).status).toBe(422);
      const regenOpen: EpisodeView = await (await actionRoute.POST(json("POST"), params({ id: openId, action: "regenerate" }))).json();
      const rIds = regenOpen.episode.plan!.regenerated!.ids;
      const redraws = Object.entries(rIds).filter(([k]) => k.endsWith("-regen")).map(([, g]) => gens.getGeneration(g)!);
      expect(redraws).toHaveLength(6);
      for (const g of redraws) {
        expect(g).toMatchObject({ modelId: "oss-h3-regenerate", op: "upscale-video", engine: "open" });
        expect(g.request.params).toMatchObject({ resolution: "1080p", extra: { startSigma: 0.8, draftFrom: "other" } });
        expect(g.request.prompt?.length).toBeGreaterThan(20);
      }
      // The narration, its timing and the bed are the episode's own: nothing is read or timed again.
      expect(gens.getGeneration(rIds["regen-mix"])).toMatchObject({ op: "mux" });
      expect(Object.keys(rIds).filter((k) => !k.startsWith("regen-"))).toEqual([]);
      expect(Object.values(rIds)).not.toContain(doneOpen.episode.plan!.ids.narration);
      expect(regenOpen.episode.plan!.regenerated!.final).toBe(rIds["regen-captions"]);
      // A second click while it renders starts nothing new.
      const again: EpisodeView = await (await actionRoute.POST(json("POST"), params({ id: openId, action: "regenerate" }))).json();
      expect(again.episode.plan!.regenerated!.ids).toEqual(rIds);

      // Timeline editor: change scene 3's picture.
      const target = doneCloud.episode.script.blocks[2].id;
      const before = doneCloud.episode.plan!.ids;
      const preview = await (await changeRoute.POST(json("POST", { blocks: [target], part: "picture", instruction: "make it night" }), params({ id: cloudId }))).json();
      expect(preview.rerun).toEqual([`still-${target}`, `clip-${target}-1`, "join", "mix", "captions"]);
      expect(preview.costUsd).toBeGreaterThan(0.3);
      expect(preview.demo).toBe(true);
      expect(preview.retime).toBeUndefined();
      const applied = await changeRoute.POST(json("POST", { blocks: [target], part: "picture", instruction: "make it night", apply: true }), params({ id: cloudId }));
      expect(applied.status).toBe(201);
      const changing: EpisodeView = await applied.json();
      expect(changing.episode.status).toBe("rendering");
      expect(changing.episode.plan!.awaiting).toBe(false);
      const after = changing.episode.plan!.ids;
      expect(after[`still-${target}`]).not.toBe(before[`still-${target}`]);
      expect(after[`still-${doneCloud.episode.script.blocks[0].id}`]).toBe(before[`still-${doneCloud.episode.script.blocks[0].id}`]);
      expect(after.narration).toBe(before.narration);
      expect(after.music).toBe(before.music);
      expect(gens.getGeneration(after[`still-${target}`])!.request).toMatchObject({ op: "edit", inputs: { images: [doneCloud.steps.find((s) => s.key === `still-${target}`)!.generation!.outputs[0].url] } });
      expect(changing.previousFinal?.id).toBe(before.captions);
      expect(changing.episode.plan!.changes).toHaveLength(1);
      expect(changing.episode.plan!.upscaled).toBeUndefined();

      // A narration change reads the voice-over again and re-times the scenes before re-mixing.
      const voice = await (await changeRoute.POST(json("POST", { blocks: [doneOpen.episode.script.blocks[2].id], part: "narration", narration: ["Night fell over the city."] }), params({ id: openId }))).json();
      expect(voice.rerun).toEqual(["narration", "words", "mix", "captions"]);
      expect(voice.retime).toBe(true);

      // Retry (meanwhile, on the open episode): a step that fails takes what waits on it down; Retry redoes only those.
      const failing = await view(openId);
      const clipKey = failing.steps.find((s) => s.key.startsWith(`clip-${failing.episode.script.blocks[1].id}-`))!.key;
      await changeRoute.POST(json("POST", { blocks: [failing.episode.script.blocks[1].id], part: "motion", instruction: "a slow zoom out", apply: true }), params({ id: openId }));
      const mid = await view(openId);
      expect(mid.episode.plan!.ids[clipKey]).not.toBe(failing.episode.plan!.ids[clipKey]);
      expect(mid.episode.plan!.ids[`still-${failing.episode.script.blocks[1].id}`]).toBe(failing.episode.plan!.ids[`still-${failing.episode.script.blocks[1].id}`]);
      await gens.cancelGeneration(mid.episode.plan!.ids[clipKey]);

      const [changed, failed] = await Promise.all([settled(cloudId), settled(openId)]);
      expect(changed.episode.status).toBe("done");
      expect(changed.final!.id).toBe(after.captions);
      // Undo goes back to the version before, and marks the change undone.
      const undone: EpisodeView = await (await actionRoute.POST(json("POST"), params({ id: cloudId, action: "undo" }))).json();
      expect(undone.episode.plan!.ids).toEqual(before);
      expect(undone.episode.plan!.changes[0].undone).toBe(true);
      expect((await settled(cloudId)).final!.id).toBe(before.captions);

      expect(failed.episode.status).toBe("failed");
      expect(failed.episode.error).toBe("A step was cancelled — retry to make it again");
      const retried: EpisodeView = await (await actionRoute.POST(json("POST"), params({ id: openId, action: "retry" }))).json();
      expect(retried.episode.status).toBe("rendering");
      expect(retried.episode.plan!.ids[clipKey]).not.toBe(mid.episode.plan!.ids[clipKey]);
      expect(retried.episode.plan!.ids.narration).toBe(mid.episode.plan!.ids.narration);
      // The redone clip runs (what follows it is the same chain the first render ran).
      const redone = retried.episode.plan!.ids[clipKey];
      for (let i = 0; i < 60 && gens.getGeneration(redone)!.status !== "succeeded"; i++) await sleep(500);
      expect(gens.getGeneration(redone)!.status).toBe("succeeded");

      // A narration change on the cloud episode: the voice and its timing first, then the mix and subtitles.
      // The demo can't time the new take, so the scenes keep their clips.
      const restored = await view(cloudId);
      const keep = restored.episode.plan!.ids;
      const lines = await changeRoute.POST(json("POST", { blocks: [restored.episode.script.blocks[0].id], part: "narration", narration: ["Rome was never one city for long."], apply: true }), params({ id: cloudId }));
      const relined: EpisodeView = await lines.json();
      expect(relined.episode.plan!.awaiting).toBe(true);
      expect(relined.episode.plan!.ids.narration).not.toBe(keep.narration);
      expect(relined.episode.plan!.ids.mix).toBeUndefined();
      expect(relined.previousFinal?.id).toBe(keep.captions);
      // Undo while it's still reading: the new steps are stopped.
      const newer = Object.entries(relined.episode.plan!.ids).filter(([k, g]) => keep[k] !== g).map(([, g]) => g);
      expect(newer.length).toBeGreaterThanOrEqual(2);
      await actionRoute.POST(json("POST"), params({ id: cloudId, action: "undo" }));
      await sleep(100);
      expect(stillRunning(newer)).toEqual([]);
      // Again, to the end.
      await changeRoute.POST(json("POST", { blocks: [restored.episode.script.blocks[0].id], part: "narration", narration: ["Rome was never one city for long."], apply: true }), params({ id: cloudId }));
      const revoiced = await settled(cloudId);
      expect(revoiced.episode.status).toBe("done");
      const now = revoiced.episode.plan!.ids;
      for (const k of Object.keys(keep).filter((k) => k.startsWith("clip-") || k.startsWith("still-") || k === "music" || k === "level")) expect(now[k], k).toBe(keep[k]);
      for (const k of ["narration", "words", "mix", "captions"]) expect(now[k], k).not.toBe(keep[k]);
      expect(gens.getGeneration(now.narration)!.request.prompt).toMatch(/^Rome was never one city for long\./);
    },
    300_000,
  );

  it("stops everything an episode or a channel still renders when it's deleted", async () => {
    // An Explainer renders straight away: delete it a moment into the render.
    const res = await explainerRoute.POST(json("POST", { prompt: "How lighthouses work", settings: { ...cloud, length: 30, music: true } }));
    const ep: FacelessEpisode = await res.json();
    await faceless.scriptWritten(ep.id);
    const rendering = await view(ep.id);
    expect(rendering.episode.status).toBe("rendering");
    const made = Object.values(rendering.episode.plan!.ids);
    expect(stillRunning(made).length).toBeGreaterThan(0);
    const del = await episodeRoute.DELETE(json("DELETE"), params({ id: ep.id }));
    expect(del.status).toBe(204);
    expect(stillRunning(made)).toEqual([]);
    await sleep(3000);
    expect(stillRunning(made)).toEqual([]);
    expect(faceless.listEpisodes({ kind: "explainer" }).map((e) => e.id)).not.toContain(ep.id);

    // Deleting while the script is being written stops the writer: no row comes back.
    const writing = faceless.createEpisode({ kind: "explainer", topic: "Why the sky is blue", settings: cloud, autoRender: true });
    await faceless.deleteEpisode(writing.id);
    await faceless.scriptWritten(writing.id);
    expect(faceless.listEpisodes({ kind: "explainer", q: "sky is blue" })).toEqual([]);

    // A channel takes its episodes' renders with it.
    const doomed: FacelessChannel = await (await channelsRoute.POST(json("POST", { idea: "Channel about lighthouses", genre: "education", engine: "cloud" }))).json();
    await faceless.channelReady(doomed.id);
    const e2 = faceless.createEpisode({ kind: "faceless", channelId: doomed.id, topic: "The first lighthouse", settings: cloud });
    await faceless.scriptWritten(e2.id);
    faceless.renderEpisode(e2.id);
    const ids = [...Object.values(faceless.episodeView(e2.id).episode.plan!.ids), faceless.getChannel(doomed.id)!.avatarJob].filter((x): x is string => !!x);
    expect(stillRunning(ids).length).toBeGreaterThan(0);
    expect((await channelRoute.DELETE(json("DELETE"), params({ id: doomed.id }))).status).toBe(204);
    expect(stillRunning(ids)).toEqual([]);
    expect(faceless.getChannel(doomed.id)).toBeNull();
  });

  it("starts stage two without anyone reading the episode (the background sweep)", async () => {
    const ep = faceless.createEpisode({ kind: "explainer", topic: "Why bridges sway", settings: { ...cloud, length: 20 }, autoRender: true });
    await faceless.scriptWritten(ep.id);
    // Only the row is read from here on: no episodeView, no list.
    const plan = () => JSON.parse((db().prepare("SELECT plan_json FROM faceless_episodes WHERE id = ?").get(ep.id) as { plan_json: string }).plan_json);
    expect(plan().awaiting).toBe(true);
    for (let i = 0; i < 60 && plan().awaiting; i++) await sleep(500);
    expect(plan().awaiting).toBe(false);
    expect(Object.keys(plan().ids)).toEqual(expect.arrayContaining(["join", "mix", "captions"]));
    await faceless.deleteEpisode(ep.id);
  }, 60_000);

  it("marks a script that was being written when the server restarted as failed, with Try again", async () => {
    const ep = faceless.createEpisode({ kind: "faceless", channelId: channel.id, topic: "The Silk Road", settings: cloud });
    await faceless.scriptWritten(ep.id);
    // As after a restart: the row says "writing", but no writer is running in this process.
    db().prepare("UPDATE faceless_episodes SET status = 'writing' WHERE id = ?").run(ep.id);
    const v = await view(ep.id);
    expect(v.episode.status).toBe("write-failed");
    expect(v.episode.error).toBe("Interrupted while writing the script — try again");
    const again: EpisodeView = await (await actionRoute.POST(json("POST"), params({ id: ep.id, action: "rewrite" }))).json();
    expect(again.episode.status).toBe("writing");
    await faceless.scriptWritten(ep.id);
    expect((await view(ep.id)).episode.status).toBe("review");
  });
});

describe("Explainer", () => {
  it("renders straight from a prompt and a document, lists history and likes", async () => {
    const res = await explainerRoute.POST(
      json("POST", {
        prompt: "Explain how dinosaurs went extinct, for kids",
        sources: [{ kind: "text", name: "notes.txt", text: "An asteroid hit Chicxulub 66 million years ago." }],
        settings: { ...cloud, length: 30, styleId: "pixel-art" },
      }),
    );
    expect(res.status).toBe(201);
    const ep: FacelessEpisode = await res.json();
    await faceless.scriptWritten(ep.id);
    const v = await view(ep.id);
    expect(v.episode.kind).toBe("explainer");
    expect(v.episode.status).toBe("rendering");
    expect(v.episode.script.blocks).toHaveLength(3);
    expect(v.steps.find((s) => s.part === "still")!.generation!.request.prompt).toMatch(/16-bit pixel art/);
    expect(faceless.listEpisodes({ kind: "explainer", q: "dinosaurs" }).map((c) => c.id)).toEqual([ep.id]);
    expect(faceless.listEpisodes({ kind: "faceless", q: "dinosaurs" })).toEqual([]);
    await episodeRoute.PATCH(json("PATCH", { favorite: true }), params({ id: ep.id }));
    expect(faceless.listEpisodes({ kind: "explainer", liked: true })).toHaveLength(1);
    // Validation the research names.
    const many = await explainerRoute.POST(json("POST", { prompt: "x", sources: Array.from({ length: 4 }, (_, i) => ({ kind: "text", name: `${i}`, text: "t" })), settings: cloud }));
    expect((await many.json()).error).toBe("Up to 3 sources per video — remove one to add another");
    const none = await explainerRoute.POST(json("POST", { prompt: "", settings: cloud }));
    expect((await none.json()).error).toBe("Add a prompt, or attach a file or link");
    for (const length of [10, 601, 45.5]) {
      const r = await explainerRoute.POST(json("POST", { prompt: "x", settings: { ...cloud, length } }));
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe("Duration must be Auto or a whole number of seconds between 15 and 600");
    }
  });

  it(
    "makes Ken Burns moves again for clips an older Frame by frame render made with a video model, and refuses a Motion change that keeps the move",
    async () => {
      const res = await explainerRoute.POST(json("POST", { prompt: "How lighthouses guide ships", settings: { ...open, music: false, subtitles: false, length: 20 } }));
      const ep: FacelessEpisode = await res.json();
      await faceless.scriptWritten(ep.id);
      const done = await settled(ep.id);
      expect(done.episode.status).toBe("done");
      const blocks = done.episode.script.blocks;
      expect(blocks.length).toBeGreaterThanOrEqual(2);
      const ids = done.episode.plan!.ids;
      const clips = Object.keys(ids).filter((k) => k.startsWith("clip-"));
      expect(clips.every((k) => gens.getGeneration(ids[k])!.modelId === "oss-ken-burns")).toBe(true);

      // Motion in Frame by frame is a camera move: words that read as the move a scene has would remake the same clip.
      const motion = (instruction: string) => changeRoute.POST(json("POST", { blocks: [blocks[1].id], part: "motion", instruction }), params({ id: ep.id }));
      for (const words of ["the flags wave in the wind", blocks[1].motion]) {
        const same = await motion(words);
        expect(same.status, words).toBe(422);
        expect((await same.json()).error).toMatch(/^That's the camera move this scene already has\. Name another: zoom in or out, pan left or right/);
      }
      // Scene 2 pans by the cycle; a zoom is another move.
      const zoom = await (await motion("zoom into the lighthouse")).json();
      expect(zoom.rerun).toEqual([...clips.filter((k) => k.startsWith(`clip-${blocks[1].id}-`)), "join", "mix"]);

      // As an episode rendered before Frame by frame moved a camera: every clip was a Wan 2.2 shot of 5 s.
      for (const k of clips) {
        const g = gens.getGeneration(ids[k])!;
        const request = { ...g.request, modelId: "oss-wan22-14b-fast", op: "i2v", params: { ...g.request.params, duration: 5 } };
        db().prepare("UPDATE generations SET model_id = ?, op = ?, request_json = ? WHERE id = ?").run("oss-wan22-14b-fast", "i2v", JSON.stringify(request), ids[k]);
      }
      // A picture change on scene 1 makes every scene's move again (no old clip is kept under a Ken Burns key).
      const preview = await (await changeRoute.POST(json("POST", { blocks: [blocks[0].id], part: "picture", instruction: "make it stormy" }), params({ id: ep.id }))).json();
      expect(preview.rerun).toEqual(expect.arrayContaining([`still-${blocks[0].id}`, ...clips, "join", "mix"]));
      expect(preview.rerun).not.toContain(`still-${blocks[1].id}`);
      const applied = await changeRoute.POST(json("POST", { blocks: [blocks[0].id], part: "picture", instruction: "make it stormy", apply: true }), params({ id: ep.id }));
      expect(applied.status).toBe(201);
      const redone = await settled(ep.id);
      expect(redone.episode.status).toBe("done");
      const now = redone.episode.plan!.ids;
      for (const k of clips) {
        expect(now[k], k).not.toBe(ids[k]);
        expect(gens.getGeneration(now[k])!.request).toMatchObject({ modelId: "oss-ken-burns", op: "still-motion" });
      }
      expect(now[`still-${blocks[1].id}`]).toBe(ids[`still-${blocks[1].id}`]);
      expect(now.narration).toBe(ids.narration);
      await faceless.deleteEpisode(ep.id);
    },
    120_000,
  );

  it("draws open pictures from the attached images", async () => {
    const img = (await import("@/server/storage")).saveFile({ data: Buffer.from("x"), contentType: "image/png", name: "subject.png", source: "upload" }).url;
    const ep = faceless.createEpisode({ kind: "explainer", topic: "Our new kettle", sources: [{ kind: "image", url: img }], settings: { ...open, length: 20 }, autoRender: true });
    await faceless.scriptWritten(ep.id);
    const v = await view(ep.id);
    expect(v.episode.status).toBe("rendering");
    const still = v.steps.find((s) => s.part === "still")!.generation!;
    expect(still).toMatchObject({ modelId: "oss-qwen-image-21-turbo", op: "edit" });
    expect(still.request.inputs?.images).toEqual([img]);
    await faceless.deleteEpisode(ep.id);
  });

  it("refuses links to this machine (SSRF-safe fetch)", async () => {
    const res = await linkRoute.POST(json("POST", { url: "http://127.0.0.1:9/secret", engine: "cloud" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/won't fetch/);
    expect(faceless.pageText("<html><head><title>Tides &amp; you</title><script>x()</script></head><body><p>The moon pulls.</p><p>Twice a day.</p></body></html>")).toEqual({
      title: "Tides & you",
      text: "The moon pulls.\nTwice a day.",
    });
  });

  it("makes one voice preview per narrator and reuses it", async () => {
    const a = await (await voiceRoute.POST(json("POST", { id: "JBFqnCBsd6RMkjVDRZzb" }))).json();
    const b = await (await voiceRoute.POST(json("POST", { id: "JBFqnCBsd6RMkjVDRZzb" }))).json();
    expect(a.id).toBe(b.id);
    expect(a).toMatchObject({ feature: "faceless-voice", op: "tts", modelId: "elevenlabs-v4" });
    expect(a.request.prompt).toMatch(/I'm George/);
    expect((await voiceRoute.POST(json("POST", { id: "nobody" }))).status).toBe(400);
  });
});
