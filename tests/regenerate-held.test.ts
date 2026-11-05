import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EpisodeSettings, FacelessChannel, FacelessEpisode } from "@/lib/catalog/faceless";
import type { Generation, GenerationRequest } from "@/lib/catalog/types";
import { TINY_MP4 } from "./helpers/fake-comfy-runner";
import { tempDir } from "./helpers/temp-dir";

// Open-H3 Regenerate is held on this studio's GPUs until it has run on a card that fits it (REGEN_OFFERED, off). It shows
// for everyone with what it needs (tests/regenerate-offered.test.ts), and an account runs it on its own GPU (a 48 GB card,
// src/lib/own-setup.ts). For the owner the server refuses every way in, in plain words and before anything is made: a run
// of it sent straight to the API (Upscale → Video, Edit video's Enhance, a Canvas or skill step), MiniMax H3 at 2K on
// your GPU, Shorts' Enhance, Faceless's Regenerate to 1080p and Cinema's Finish in 2K on a take from your GPU.
// The tests that mock it on check each of them as it runs once it is switched on.
vi.setConfig({ testTimeout: 120_000 });

const dir = tempDir("fuobe-regen-held-");
process.env.FUOBE_DATA_DIR = dir;
// Nothing listens: open models run on the demo provider, and there's no LLM (Faceless's offline writer runs).
process.env.COMFYUI_URL = "http://127.0.0.1:9";
process.env.OLLAMA_URL = "http://127.0.0.1:9";
process.env.FUOBE_PUBLIC_SIGNUP = "1";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_HOSTED_RUNS;
globalThis.__fuobeTestDiskFree = 1e13;

const R = await import("@/lib/catalog/regenerate");
const { ownSetupDetail, ownSetupOnly } = await import("@/lib/own-setup");
const auth = await import("@/server/auth");
const { setSetting } = await import("@/server/settings");
const gens = await import("@/server/generations");
const { saveFile } = await import("@/server/storage");
const { db } = await import("@/server/db");
const shorts = await import("@/server/shorts");
const cinema = await import("@/server/cinema");
const generationsRoute = await import("@/app/api/generations/route");
const enhanceRoute = await import("@/app/api/shorts/sessions/[id]/segments/[index]/enhance/route");
const channelsRoute = await import("@/app/api/faceless/channels/route");
const episodesRoute = await import("@/app/api/faceless/episodes/route");
const facelessAction = await import("@/app/api/faceless/episodes/[id]/[action]/route");
const finishRoute = await import("@/app/api/cinema/projects/[id]/items/[generationId]/finish/route");

let owner = "";
let account = "";
let accountCookie = "";
beforeAll(() => {
  setSetting("demoMode", "auto");
  setSetting("enhanceProvider", "none");
  auth.setPassword("install password");
  owner = `${auth.SESSION_COOKIE}=${auth.createSession().value}`;
  account = auth.createAccount("held@example.com", "long enough").id;
  accountCookie = `${auth.SESSION_COOKIE}=${auth.createSession(account).value}`;
});
afterAll(() => {
  globalThis.__fuobeTestDiskFree = undefined;
});

/** The owner's request (a guest is asked to sign up first; an account's own channels: tests/account-content.test.ts). */
const json = (method: string, body?: unknown) =>
  new Request("http://x/api", { method, headers: { "Content-Type": "application/json", cookie: owner }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) }) as never;
const clip = (accountId?: string) => saveFile({ data: TINY_MP4, contentType: "video/mp4", source: "upload", name: "clip.mp4", ...(accountId && { accountId }) }).url;
const count = () => (db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n;
/** POST /api/generations as the owner or an account, run or priced (?preview=1). */
const post = (body: unknown, o: { cookie?: string; preview?: boolean } = {}) => {
  const text = JSON.stringify(body);
  return generationsRoute.POST(
    new Request(`http://localhost:3000/api/generations${o.preview ? "?preview=1" : ""}`, {
      method: "POST",
      headers: { cookie: o.cookie ?? owner, host: "localhost:3000", "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) },
      body: text,
    }) as never,
  );
};
/** Refused with these words, and nothing made. */
async function refused(send: () => Promise<Response>, words: string) {
  const before = count();
  const r = await send();
  expect(r.status, await r.clone().text()).toBe(422);
  const { error } = (await r.json()) as { error: string };
  expect(error).toBe(words);
  expect(count()).toBe(before);
  return error;
}
/** Visitor-facing words: product copy, no build words. */
const plain = (words: string) => expect(words).not.toMatch(/\b(graphs?|routes?|providers?|loras?|workflows?|endpoints?|comfyui|oss-[\w-]+)\b|safetensors|\.json|_OFFERED/i);

async function settle(id: string, ms = 60_000): Promise<Generation> {
  const end = Date.now() + ms;
  for (;;) {
    const g = gens.getGeneration(id)!;
    if (["succeeded", "failed", "canceled"].includes(g.status)) return g;
    if (Date.now() > end) throw new Error(`timed out: ${g.status}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const regen = (video: string): GenerationRequest => ({ feature: "upscale", modelId: R.REGEN_MODEL, op: "upscale-video", prompt: "A fox runs through the snow", inputs: { video }, params: { resolution: "1440p" } });
const twoK: GenerationRequest = { feature: "video", modelId: R.H3_OPEN_MODEL, op: "t2v", prompt: "A lighthouse in a storm", params: { resolution: "2K", duration: 5 } };

describe("Open-H3 Regenerate while it is held", () => {
  it("is held, and the owner's answers say what it needs in plain words", () => {
    expect(R.REGEN_OFFERED).toBe(false);
    for (const words of [R.REGEN_COPY.held, R.REGEN_COPY.heldTwoK, R.REGEN_COPY.heldEnhance, R.REGEN_COPY.heldFinish, R.REGEN_COPY.heldEpisode]) {
      plain(words);
      expect(words).toMatch(/needs a GPU with 48 GB or more/);
      expect(words).not.toMatch(/isn't available|not available|coming soon|yet/i);
    }
  });

  it("refuses a run of it sent straight to POST /api/generations, priced or run", async () => {
    const video = clip();
    await refused(() => post(regen(video), { preview: true }), R.REGEN_COPY.held);
    await refused(() => post(regen(video)), R.REGEN_COPY.held);
    // At any size, and with the hand-off flags a finish carries.
    await refused(() => post({ ...regen(video), params: { resolution: "1080p", extra: { startSigma: 0.8, draftFrom: "h3" } } }), R.REGEN_COPY.held);
  });

  it("refuses MiniMax H3 in 2K on your GPU without drafting the take; 768p still runs", async () => {
    await refused(() => post(twoK, { preview: true }), R.REGEN_COPY.heldTwoK);
    await refused(() => post(twoK), R.REGEN_COPY.heldTwoK);
    await refused(() => post({ ...twoK, op: "i2v", inputs: { images: [saveFile({ data: Buffer.from("89504e470d0a1a0a", "hex"), contentType: "image/png", source: "upload" }).url] }, params: { resolution: "1440p", duration: 5 } }), R.REGEN_COPY.heldTwoK);
    const r = await post({ ...twoK, params: { resolution: "768p", duration: 5 } });
    expect(r.status, await r.clone().text()).toBe(201);
    const { items } = (await r.json()) as { items: Generation[] };
    expect(items.map((g) => g.modelId)).toEqual([R.H3_OPEN_MODEL]);
  });

  it("refuses Edit video's Enhance (H3 regenerate) on a result", async () => {
    const result = { feature: "video-edit", request: { feature: "video-edit", modelId: "fuobe-mixed-media", prompt: "make it snow", params: { duration: 5 } } } as Generation;
    const asked = R.enhanceRequest(result, clip());
    expect(asked.modelId).toBe(R.REGEN_MODEL);
    await refused(() => post(asked, { preview: true }), R.REGEN_COPY.heldEnhance);
    await refused(() => post(asked), R.REGEN_COPY.heldEnhance);
  });

  it("asks an account with no GPU of its own to connect one (a 48 GB card), never with the owner's words", async () => {
    const detail = ownSetupDetail(ownSetupOnly(R.REGEN_MODEL)!);
    for (const body of [regen(clip(account)), twoK]) {
      const before = count();
      const r = await post(body, { cookie: accountCookie });
      expect(r.status, await r.clone().text()).toBe(403);
      expect(r.headers.get("x-fuobe-connect-gpu")).toBe("1");
      const answer = (await r.json()) as { error: string; code: string };
      expect(answer).toEqual({ error: detail, code: "connect-gpu" });
      expect(answer.error).not.toMatch(/isn't available|held|yet/);
      expect(count()).toBe(before);
    }
  });

  it("refuses it as any tool's step: a Canvas node, a step that waits for another, a 2K take whose words come from a text node", async () => {
    const before = count();
    expect(() => gens.createGenerations({ ...regen(clip()), feature: "canvas" })).toThrow(R.REGEN_COPY.held);
    expect(() => gens.previewChained({ ...regen(clip()), feature: "canvas" }, 1)).toThrow(R.REGEN_COPY.held);
    expect(count()).toBe(before);
    const [take] = gens.createGenerations({ ...twoK, feature: "canvas", params: { resolution: "768p", duration: 5 } });
    const waiting: GenerationRequest = { feature: "canvas", modelId: R.REGEN_MODEL, op: "upscale-video", prompt: "A lighthouse", chain: [{ slot: "video" }], params: { resolution: "1440p" } };
    expect(() => gens.createGenerations(waiting, { dependsOn: take.id })).toThrow(R.REGEN_COPY.held);
    expect(() => gens.createGenerations({ ...twoK, feature: "canvas", prompt: "{text}", chain: [{ slot: "prompt" }] }, { dependsOn: take.id })).toThrow(R.REGEN_COPY.heldTwoK);
    expect(count()).toBe(before + 1);
  });

  it("refuses Shorts' Enhance on a segment, adding no take", async () => {
    const source = saveFile({ data: fs.readFileSync(path.join(__dirname, "fixtures/shorts-12s.mp4")), contentType: "video/mp4", source: "upload", name: "beach day.mp4" }).url;
    const s = await shorts.createSession({ engine: "open", presetId: "shorts-claymation", source: { url: source, name: "beach day.mp4" }, range: { start: 0, end: 12 }, aspectRatio: "9:16", language: "auto" } as never);
    const takes = s.segments[1].takes.length;
    // The owner's Enhance (anyone else's is refused before it is read: tests/account-shorts.test.ts).
    const asOwner = (body?: unknown) => new Request("http://localhost:3000/api", { method: "POST", headers: { cookie: owner, host: "localhost:3000", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    await refused(() => enhanceRoute.POST(asOwner({ requestId: "held-enhance-1" }), params({ id: s.id, index: "1" })), R.REGEN_COPY.heldEnhance);
    expect(shorts.getSession(s.id).segments[1].takes).toHaveLength(takes);
    // A missing segment is still not found.
    expect((await enhanceRoute.POST(asOwner(), params({ id: s.id, index: "9" }))).status).toBe(404);
  });

  it("refuses Faceless's Regenerate to 1080p on an episode", async () => {
    const channel: FacelessChannel = await (await channelsRoute.POST(json("POST", { idea: "Channel about the rise and fall of empires", genre: "history", engine: "open" }))).json();
    const settings: EpisodeSettings = {
      engine: "open",
      length: 60,
      animation: "frames",
      aspect: "9:16",
      subtitles: true,
      music: true,
      styleId: "editorial-motion-graphics",
      styleRefs: [],
      voice: null,
      elements: [],
    };
    const script = "The Roman Empire did not fall in a day. For centuries it stretched from Britain to Egypt. Then, slowly, the cracks began to show.";
    const created = await episodesRoute.POST(json("POST", { channelId: channel.id, topic: "How Rome fell", script, settings }));
    expect(created.status).toBe(201);
    const ep: FacelessEpisode = await created.json();
    await refused(() => facelessAction.POST(json("POST"), params({ id: ep.id, action: "regenerate" })), R.REGEN_COPY.heldEpisode);
    expect((await facelessAction.POST(json("POST"), params({ id: "nope", action: "regenerate" }))).status).toBe(404);
  });

  it("refuses Cinema's Finish in 2K on a take from your GPU", async () => {
    const project = cinema.createProject({ name: "Storm" });
    const [g] = gens.createGenerations({ feature: "cinema", modelId: R.H3_OPEN_MODEL, op: "t2v", prompt: "A lighthouse in a storm", params: { resolution: "768p", duration: 5 } });
    cinema.addItems(project.id, [g.id]);
    expect(await settle(g.id)).toMatchObject({ status: "succeeded" });
    // Offered by the catalog as a free redraw on your GPU, refused while it is held.
    expect(R.finishIn2k(gens.getGeneration(g.id)!, "both")?.perSecond).toBeNull();
    // The owner's take (the route answers anyone else with their own projects only).
    const asOwner = new Request("http://x/api", { method: "POST", headers: { "Content-Type": "application/json", cookie: owner } });
    await refused(() => finishRoute.POST(asOwner, params({ id: project.id, generationId: g.id })), R.REGEN_COPY.heldFinish);
    expect(cinema.listItems(project.id).map((x) => x.id)).toEqual([g.id]);
  });
});
