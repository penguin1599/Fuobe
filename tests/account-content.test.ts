import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { startFakeComfy, TINY_PNG, type FakeComfy } from "./helpers/fake-comfy-runner";
import { tempDir } from "./helpers/temp-dir";

vi.setConfig({ testTimeout: 180_000 });
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {}, after: () => {} }));

/**
 * Faceless Studio, the Explainer and Content Factory for a signed-in account (public sign-up): its channels, episodes,
 * explainers and series are its own (account-projects.ts kinds "faceless", "explainer", "content-factory"), its scripts
 * are the offline writer's (never the studio's AI helper), and every render and reading runs on its own ComfyUI (a
 * stand-in here) through the same generations every studio run makes, with only its own files. A guest gets the
 * sign-up card; another account's and the owner's are never reached.
 */
const dir = tempDir("fuobe-account-content-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://owner-comfy.test:8188";
process.env.FUOBE_PUBLIC_SIGNUP = "1";
// The studio's own AI helper: recorded, so a test sees that an account's scripts never reach it.
process.env.OLLAMA_URL = "http://owner-llm.test:11434";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_ALLOW_PRIVATE_URLS;
delete process.env.FUOBE_HOSTED_RUNS;
globalThis.__fuobeTestDiskFree = 1e13;

// Plain fetch is the install's own ComfyUI or AI helper: recorded, so a test sees that nothing reached them.
const realFetch = globalThis.fetch;
const fetched: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "127.0.0.1") return realFetch(input, init);
  fetched.push(url.toString());
  if (url.host !== "owner-comfy.test:8188") return new Response("not stubbed", { status: 599 });
  if (url.pathname === "/system_stats") return Response.json({ system: { comfyui_version: "owner", ram_total: 1 }, devices: [] });
  return Response.json({});
}) as typeof fetch;
// The runner's start lists the AI helper's models once (/api/tags): a status read, never a request with anyone's words.
const reachedOwner = () => fetched.filter((u) => !u.endsWith("/system_stats") && !u.endsWith("/api/tags"));

const auth = await import("@/server/auth");
const channelsRoute = await import("@/app/api/faceless/channels/route");
const channelRoute = await import("@/app/api/faceless/channels/[id]/route");
const avatarRoute = await import("@/app/api/faceless/channels/[id]/avatar/route");
const episodesRoute = await import("@/app/api/faceless/episodes/route");
const episodeRoute = await import("@/app/api/faceless/episodes/[id]/route");
const actionRoute = await import("@/app/api/faceless/episodes/[id]/[action]/route");
const changeRoute = await import("@/app/api/faceless/episodes/[id]/change/route");
const topicsRoute = await import("@/app/api/faceless/topics/route");
const voicesRoute = await import("@/app/api/faceless/voices/preview/route");
const facelessEstimate = await import("@/app/api/faceless/estimate/route");
const explainerRoute = await import("@/app/api/explainer/route");
const documentRoute = await import("@/app/api/explainer/document/route");
const seriesListRoute = await import("@/app/api/content-factory/series/route");
const seriesRoute = await import("@/app/api/content-factory/series/[id]/route");
const generateRoute = await import("@/app/api/content-factory/series/[id]/generate/route");
const moreRoute = await import("@/app/api/content-factory/series/[id]/episodes/route");
const readRoute = await import("@/app/api/content-factory/series/[id]/read/route");
const cfEstimate = await import("@/app/api/content-factory/estimate/route");
const startersRoute = await import("@/app/api/starters/[id]/route");
const uploadsRoute = await import("@/app/api/uploads/route");
const gpuRoute = await import("@/app/api/account/gpu/route");
const { proxy } = await import("@/proxy");
const access = await import("@/lib/guest-access");
const { defaultSettings, genreInfo } = await import("@/lib/catalog/faceless");
const faceless = await import("@/server/faceless");
const { getGeneration } = await import("@/server/generations");
const { db } = await import("@/server/db");
const { resetRates } = await import("@/server/rate");
const { clearAccountLoras } = await import("@/server/account-loras");
const { saveFile } = await import("@/server/storage");
const { runAsTenant } = await import("@/server/tenant");
const { ACCOUNT_LIMITS } = await import("@/server/account-files");
const store = await import("@/server/account-projects");
const { recordFor } = await import("@/server/records");
const { purgeAccount } = await import("@/server/account-sweep");
const { provider } = await import("@/server/providers");
// The studio's AI helper (the "llm" provider every script, name, topic and summary would go through): never asked for an account.
const llmAsked = vi.spyOn(provider("llm"), "submit");

const CLIP = fs.readFileSync(path.join(__dirname, "fixtures/shorts-12s.mp4"));

/** 12 s of a quiet tone: a narrator's sample (open-source narration clones a voice from 10–60 s of it). */
const VOICE = (() => {
  const rate = 16000;
  const n = rate * 12;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 180 * i) / rate) * 4000), 44 + i * 2);
  return buf;
})();

let fake: FakeComfy;
let a = "";
let b = "";
let c = "";
const cookies: Record<string, string> = {};
const voices: Record<string, string> = {};
beforeAll(async () => {
  fake = await startFakeComfy({ loras: [], delayMs: 0, mixed: true });
  globalThis.__fuobeTestGpuPort = fake.port;
  auth.setPassword("install password");
  for (const [k, email] of [
    ["a", "content-a@example.com"],
    ["b", "content-b@example.com"],
    ["c", "content-c@example.com"],
  ] as const) {
    const id = auth.createAccount(email, "long enough").id;
    cookies[k] = `${auth.SESSION_COOKIE}=${auth.createSession(id).value}`;
    if (k === "a") a = id;
    if (k === "b") b = id;
    if (k === "c") c = id;
  }
  cookies.owner = `${auth.SESSION_COOKIE}=${auth.createSession().value}`;
  // A and B link their own ComfyUI; C has neither a GPU nor a key.
  for (const who of ["a", "b"]) expect((await gpuRoute.PUT(json("/api/account/gpu", "PUT", { url: fake.url }, who))).status).toBe(200);
  for (const who of ["a", "b"]) voices[who] = await upload(who, VOICE, "audio/wav", "narrator.wav");
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  globalThis.__fuobeTestGpuPort = undefined;
  globalThis.__fuobeTestDiskFree = undefined;
  await fake.close();
});
beforeEach(() => {
  resetRates();
  for (const id of [a, b]) clearAccountLoras(id);
});

function json(url: string, method: string, body?: unknown, who?: string): Request {
  const text = body === undefined ? "" : JSON.stringify(body);
  return new Request(`http://localhost:3000${url}`, {
    method,
    headers: { host: "localhost:3000", "content-type": "application/json", "content-length": String(Buffer.byteLength(text)), ...(who && { cookie: cookies[who] }) },
    ...(method !== "GET" && method !== "HEAD" && text && { body: text }),
  });
}
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) }) as never;

const viaProxy = (url: string, method = "GET", who?: string) =>
  proxy(new NextRequest(`http://localhost:3000${url}`, { method, headers: { host: "localhost:3000", ...(who && { cookie: cookies[who] }), ...(method !== "GET" && { "content-type": "application/json" }) }, ...(method !== "GET" && { body: "{}" }) }));
const passed = (r: Response) => r.headers.get("x-middleware-next") === "1";

async function upload(who: string, data: Buffer, type: string, name: string): Promise<string> {
  const r = await uploadsRoute.POST(new Request("http://localhost:3000/api/uploads", { method: "POST", headers: { host: "localhost:3000", cookie: cookies[who], "content-type": type, "x-file-name": name, "content-length": String(data.length) }, body: new Uint8Array(data) }));
  expect(r.status, await r.clone().text()).toBe(201);
  return ((await r.json()) as { url: string }).url;
}

/** Send a run; a LoRA its ComfyUI lacks is put there (the 409 names it), then it is sent again. */
async function run(send: () => Promise<Response>): Promise<Response> {
  let r = await send();
  for (let i = 0; i < 3 && r.status === 409; i++) {
    const j = (await r.clone().json()) as { code: string; fix?: { items: { file: string }[] } };
    if (j.code !== "comfy_missing_model" || !j.fix) break;
    fake.opts.loras = [...(fake.opts.loras ?? []), ...j.fix.items.map((x) => x.file)];
    for (const id of [a, b]) clearAccountLoras(id);
    r = await send();
  }
  return r;
}

/** An open-engine, 20-second explainer in still pictures, narrated by the account's own sample. */
const explainerSettings = (who: string, extra: Record<string, unknown> = {}) => ({
  ...defaultSettings("open", genreInfo("education"), { explainer: true }),
  length: 20,
  auto: false,
  animation: "frames" as const,
  music: false,
  subtitles: false,
  styleRefs: [],
  elements: [],
  voice: { kind: "sample", url: voices[who], name: "Narrator" },
  ...extra,
});

interface EpisodeViewBody {
  episode: { id: string; status: string; error: string | null; title: string; channelId: string | null; script: { blocks: unknown[]; offline?: boolean; note?: string }; plan: { batchId: string; ids: Record<string, string> } | null };
  final: { id: string; outputs: { url: string }[] } | null;
}

const readEpisode = (id: string, who?: string) => episodeRoute.GET(json(`/api/faceless/episodes/${id}`, "GET", undefined, who), params({ id }));

/** Tick the runner and read the episode (its first look after stage one starts stage two) until it is done or failed. */
async function settleEpisode(id: string, who: string, ms = 90_000): Promise<EpisodeViewBody> {
  const end = Date.now() + ms;
  for (;;) {
    await globalThis.__fuobeRunner?.tick();
    const v = (await (await readEpisode(id, who)).json()) as EpisodeViewBody;
    if (v.episode.status === "done" || v.episode.status === "failed" || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const accountOf = (gid: string) => getGeneration(gid, { includeDeleted: true })?.request.account;
const count = () => (db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n;
const h = (who: string) => new Headers({ host: "localhost:3000", ...(cookies[who] && { cookie: cookies[who] }) });

describe("the proxy opens the three tools to accounts, and keeps the sign-up card for guests", () => {
  const CHANGES = [
    ["POST", "/api/faceless/channels"],
    ["PATCH", "/api/faceless/channels/ch1"],
    ["DELETE", "/api/faceless/channels/ch1"],
    ["POST", "/api/faceless/channels/ch1/avatar"],
    ["POST", "/api/faceless/episodes"],
    ["PATCH", "/api/faceless/episodes/ep1"],
    ["DELETE", "/api/faceless/episodes/ep1"],
    ["POST", "/api/faceless/episodes/ep1/render"],
    ["POST", "/api/faceless/episodes/ep1/retry"],
    ["POST", "/api/faceless/episodes/ep1/upscale"],
    ["POST", "/api/faceless/episodes/ep1/change"],
    ["POST", "/api/faceless/topics"],
    ["POST", "/api/faceless/voices/preview"],
    ["POST", "/api/explainer"],
    ["POST", "/api/content-factory/series"],
    ["PATCH", "/api/content-factory/series/s1"],
    ["DELETE", "/api/content-factory/series/s1"],
    ["POST", "/api/content-factory/series/s1/generate"],
    ["POST", "/api/content-factory/series/s1/episodes"],
    ["POST", "/api/content-factory/series/s1/read"],
    ["POST", "/api/starters/faceless.boat-hotels"],
  ] as const;

  it("a guest gets the sign-up card on every change, empty lists, and nobody's channel, episode or series", async () => {
    for (const [method, p] of CHANGES) {
      const r = viaProxy(p, method);
      expect(r.status, `${method} ${p}`).toBe(401);
      expect(r.headers.get(access.GUEST_HEADER), p).toBe("1");
      expect((await r.json()).error).toBe(access.GUEST_RUN_MESSAGE);
    }
    for (const p of ["/api/faceless/channels", "/api/faceless/episodes", "/api/explainer", "/api/content-factory/series"]) expect(await viaProxy(p).json(), p).toEqual({ items: [] });
    for (const p of ["/api/faceless/channels/ch1", "/api/faceless/episodes/ep1", "/api/content-factory/series/s1"]) expect(viaProxy(p).status, p).toBe(401);
    // Price checks stay open to everyone.
    for (const p of ["/api/faceless/estimate", "/api/content-factory/estimate"]) expect(passed(viaProxy(p, "POST")), p).toBe(true);
    // The explainer's document route makes the proxy's checks itself: a guest is asked to sign up.
    const form = new FormData();
    form.append("file", new File(["hello"], "notes.pdf", { type: "application/pdf" }));
    const doc = await documentRoute.POST(new Request("http://localhost:3000/api/explainer/document", { method: "POST", headers: { host: "localhost:3000" }, body: form }));
    expect(doc.status).toBe(401);
    expect(doc.headers.get(access.GUEST_HEADER)).toBe("1");
  });

  it("an account reaches its own routes (the routes scope them); handing a brief to Claude stays the owner's", async () => {
    for (const [method, p] of [...CHANGES, ["GET", "/api/faceless/channels"], ["GET", "/api/faceless/channels/ch1"], ["GET", "/api/faceless/episodes/ep1"], ["GET", "/api/explainer"], ["GET", "/api/content-factory/series/s1"]] as const) {
      expect(passed(viaProxy(p, method, "a")), `${method} ${p}`).toBe(true);
    }
    const claude = viaProxy("/api/content-factory/claude", "POST", "a");
    expect(claude.status).toBe(403);
    expect((await claude.json()).code).toBe("own-gpu-tool");
    // The server never fetches a link for an account (or a guest): an explainer's link source is the owner's.
    for (const who of [undefined, "a"]) {
      const link = viaProxy("/api/explainer/link", "POST", who);
      expect(link.status, who).toBe(403);
      expect((await link.json()).code).toBe("own-gpu-tool");
    }
    // "Regenerate to 1080p" runs on its own GPU: the route checks its own episode first.
    expect(passed(viaProxy("/api/faceless/episodes/ep1/regenerate", "POST", "a"))).toBe(true);
    const guestRegen = viaProxy("/api/faceless/episodes/ep1/regenerate", "POST");
    expect(guestRegen.status).toBe(401);
  });

  it("the routes refuse a guest themselves", async () => {
    for (const [name, r] of [
      ["channel", () => channelsRoute.POST(json("/api/faceless/channels", "POST", {}))],
      ["episode", () => episodesRoute.POST(json("/api/faceless/episodes", "POST", {}))],
      ["render", () => actionRoute.POST(json("/api/faceless/episodes/e/render", "POST"), params({ id: "e", action: "render" }))],
      ["change", () => changeRoute.POST(json("/api/faceless/episodes/e/change", "POST", {}), params({ id: "e" }))],
      ["explainer", () => explainerRoute.POST(json("/api/explainer", "POST", {}))],
      ["series", () => seriesListRoute.POST(json("/api/content-factory/series", "POST", {}))],
      ["generate", () => generateRoute.POST(json("/api/content-factory/series/s/generate", "POST", {}), params({ id: "s" }))],
      ["topics", () => topicsRoute.POST(json("/api/faceless/topics", "POST", {}))],
    ] as const) {
      const res = await r();
      expect(res.status, name).toBe(401);
      expect(res.headers.get(access.GUEST_HEADER), name).toBe("1");
    }
  });
});

describe("Explainer: an account's explainers are its own and render on its own GPU", () => {
  let id = "";
  let view: EpisodeViewBody;

  it("asks an account with neither a GPU nor a key to connect one, before anything is made", async () => {
    const n = count();
    const own = runAsTenant({ kind: "account", id: c }, () => saveFile({ data: VOICE, contentType: "audio/wav", source: "upload", name: "c.wav" }).url);
    const r = await explainerRoute.POST(json("/api/explainer", "POST", { prompt: "How bees make honey", settings: { ...explainerSettings("a"), voice: { kind: "sample", url: own } } }, "c"));
    expect(r.status, await r.clone().text()).toBe(403);
    expect(r.headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
    expect(count()).toBe(n);
    expect(store.listAccountProjects(c, "explainer")).toEqual([]);
  });

  it("prices it for its own GPU, never as a demo", async () => {
    const r = await facelessEstimate.POST(json("/api/faceless/estimate", "POST", { kind: "explainer", settings: explainerSettings("a") }, "a"));
    expect(r.status, await r.clone().text()).toBe(200);
    expect(((await r.json()) as { demo: boolean }).demo).toBe(false);
  });

  it("writes the script offline and renders it end to end: every step its own, on its ComfyUI", async () => {
    fake.log.length = 0;
    fetched.length = 0;
    const r = await run(() => explainerRoute.POST(json("/api/explainer", "POST", { prompt: "How bees make honey", settings: explainerSettings("a") }, "a")));
    expect(r.status, await r.clone().text()).toBe(201);
    id = ((await r.json()) as { id: string }).id;
    view = await settleEpisode(id, "a");
    expect(view.episode.status, view.episode.error ?? "").toBe("done");
    // The offline writer's script, with no note about the studio's AI helper.
    expect(view.episode.script.blocks.length).toBeGreaterThan(0);
    expect(view.episode.script.offline).toBeFalsy();
    expect(view.episode.script.note).toBeUndefined();
    expect(llmAsked).not.toHaveBeenCalled();
    const gens = Object.values(view.episode.plan!.ids);
    expect(gens.length).toBeGreaterThan(3);
    for (const g of gens) {
      expect(accountOf(g), g).toBe(a);
      expect(getGeneration(g)?.status, `${g} ${getGeneration(g)?.modelId} ${getGeneration(g)?.error ?? ""}`).toBe("succeeded");
    }
    // One run: its steps share a batch; every step went to its own ComfyUI; nothing reached the studio's ComfyUI or AI helper.
    expect(new Set(gens.map((g) => getGeneration(g)!.batchId)).size).toBe(1);
    expect(fake.log.filter((e) => e.path === "/prompt").length).toBe(gens.length);
    expect(reachedOwner()).toEqual([]);
    // The explainer is the account's own project; the finished video is its own file, and it downloads.
    expect(store.getAccountProject(a, "explainer", id)).not.toBeNull();
    const out = view.final!.outputs[0].url;
    expect(passed(viaProxy(out, "GET", "a"))).toBe(true);
    expect(viaProxy(out, "GET", "b").status).toBe(403);
  });

  it("reopens it: its history lists it, and its page opens for it alone", async () => {
    const list = (await (await explainerRoute.GET(json("/api/explainer", "GET", undefined, "a"))).json()) as { items: { id: string; status: string }[] };
    expect(list.items.map((e) => e.id)).toEqual([id]);
    expect(list.items[0].status).toBe("done");
    expect(passed(viaProxy(`/explainer/${id}`, "GET", "a"))).toBe(true);
    // Another account, a guest and the owner: a real 404 from the proxy, before the page's shell streams.
    for (const who of ["b", undefined, "owner"]) expect(viaProxy(`/explainer/${id}`, "GET", who).status, who ?? "guest").toBe(404);
    expect(recordFor({ kind: "explainer", ids: [id] }, h("a"))).toBe(true);
    expect(recordFor({ kind: "explainer", ids: [id] }, h("b"))).toBe(false);
    expect(recordFor({ kind: "explainer", ids: [id] }, h("owner"))).toBe(false);
  });

  it("another account and the owner never see, open, change or run it", async () => {
    for (const who of ["b", "owner"]) {
      const list = (await (await explainerRoute.GET(json("/api/explainer", "GET", undefined, who))).json()) as { items: { id: string }[] };
      expect(list.items.map((e) => e.id), who).not.toContain(id);
    }
    fake.log.length = 0;
    expect((await readEpisode(id, "b")).status).toBe(404);
    expect((await readEpisode(id, "owner")).status).toBe(404);
    for (const action of ["render", "retry", "upscale", "rewrite", "undo"]) {
      expect((await actionRoute.POST(json(`/api/faceless/episodes/${id}/${action}`, "POST", undefined, "b"), params({ id, action }))).status, action).toBe(404);
    }
    expect((await changeRoute.POST(json(`/api/faceless/episodes/${id}/change`, "POST", { blocks: ["x"], part: "motion", instruction: "zoom", apply: true }, "b"), params({ id }))).status).toBe(404);
    expect((await episodeRoute.PATCH(json(`/api/faceless/episodes/${id}`, "PATCH", { title: "mine" }, "b"), params({ id }))).status).toBe(404);
    expect((await episodeRoute.DELETE(json(`/api/faceless/episodes/${id}`, "DELETE", undefined, "b"), params({ id }))).status).toBe(404);
    expect(fake.log.some((e) => e.path === "/prompt")).toBe(false);
    // A's narrator in B's explainer: refused before anything is planned or sent.
    const r = await explainerRoute.POST(json("/api/explainer", "POST", { prompt: "Tides", settings: explainerSettings("a") }, "b"));
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe("input-not-yours");
  });

  it("never reaches the owner's explainers", async () => {
    const owner = faceless.createEpisode({ kind: "explainer", topic: "The owner's explainer", settings: { ...explainerSettings("a"), voice: null }, blocks: [{ narration: "One.", visual: "A field" }] });
    expect((await readEpisode(owner.id, "a")).status).toBe(404);
    const list = (await (await explainerRoute.GET(json("/api/explainer", "GET", undefined, "a"))).json()) as { items: { id: string }[] };
    expect(list.items.map((e) => e.id)).not.toContain(owner.id);
    expect((await actionRoute.POST(json(`/api/faceless/episodes/${owner.id}/render`, "POST", undefined, "a"), params({ id: owner.id, action: "render" }))).status).toBe(404);
    expect((await episodeRoute.DELETE(json(`/api/faceless/episodes/${owner.id}`, "DELETE", undefined, "a"), params({ id: owner.id }))).status).toBe(404);
    expect(recordFor({ kind: "explainer", ids: [owner.id] }, h("a"))).toBe(false);
    // The owner still has it, and its page opens.
    expect((await readEpisode(owner.id, "owner")).status).toBe(200);
    expect(passed(viaProxy(`/explainer/${owner.id}`, "GET", "owner"))).toBe(true);
  });

  it("writes one for review first, then renders it from the review", async () => {
    const n = count();
    const r = await explainerRoute.POST(json("/api/explainer", "POST", { prompt: "Why the sky is blue", settings: explainerSettings("a"), review: true }, "a"));
    expect(r.status, await r.clone().text()).toBe(201);
    const ep = (await r.json()) as { id: string; status: string };
    expect(ep.status).toBe("review");
    expect(count()).toBe(n);
    const go = await run(() => actionRoute.POST(json(`/api/faceless/episodes/${ep.id}/render`, "POST", undefined, "a"), params({ id: ep.id, action: "render" })));
    expect(go.status, await go.clone().text()).toBe(200);
    const v = await settleEpisode(ep.id, "a");
    expect(v.episode.status, v.episode.error ?? "").toBe("done");
    for (const g of Object.values(v.episode.plan!.ids)) expect(accountOf(g)).toBe(a);
  });

  it("a change from the timeline runs on its own GPU, after its checks", async () => {
    const blocks = (await (await readEpisode(id, "a")).json()) as { scenes: { id: string }[] };
    const scene = blocks.scenes[0].id;
    const preview = await changeRoute.POST(json(`/api/faceless/episodes/${id}/change`, "POST", { blocks: [scene], part: "picture", instruction: "make it night" }, "a"), params({ id }));
    expect(preview.status, await preview.clone().text()).toBe(200);
    const before = count();
    const r = await run(() => changeRoute.POST(json(`/api/faceless/episodes/${id}/change`, "POST", { blocks: [scene], part: "picture", instruction: "make it night", apply: true }, "a"), params({ id })));
    expect(r.status, await r.clone().text()).toBe(201);
    expect(count()).toBeGreaterThan(before);
    const v = await settleEpisode(id, "a");
    expect(v.episode.status, v.episode.error ?? "").toBe("done");
    for (const g of Object.values(v.episode.plan!.ids)) expect(accountOf(g)).toBe(a);
  });
});

describe("Faceless Studio: an account's channels and episodes are its own", () => {
  let channel = "";
  let episode = "";

  it("makes a channel of its own, with an avatar drawn on its own GPU", async () => {
    fake.log.length = 0;
    fetched.length = 0;
    const r = await channelsRoute.POST(json("/api/faceless/channels", "POST", { idea: "Strange hotels on the water", genre: "education", engine: "open" }, "a"));
    expect(r.status, await r.clone().text()).toBe(201);
    const ch = (await r.json()) as { id: string; name: string; avatarJob: string | null };
    channel = ch.id;
    expect(store.getAccountProject(a, "faceless", channel)).not.toBeNull();
    expect(ch.avatarJob).toBeTruthy();
    expect(accountOf(ch.avatarJob!)).toBe(a);
    expect(fake.log.filter((e) => e.path === "/prompt").length).toBeLessThanOrEqual(1);
    expect(reachedOwner()).toEqual([]);
    const list = (await (await channelsRoute.GET(json("/api/faceless/channels", "GET", undefined, "a"))).json()) as { items: { id: string }[] };
    expect(list.items.map((x) => x.id)).toEqual([channel]);
  });

  it("an account without a GPU or key still makes its channel; its avatar waits for one", async () => {
    const n = count();
    const r = await channelsRoute.POST(json("/api/faceless/channels", "POST", { idea: "Tiny museums", genre: "history", engine: "open" }, "c"));
    expect(r.status).toBe(201);
    const ch = (await r.json()) as { id: string; avatarJob: string | null };
    expect(ch.avatarJob).toBeNull();
    expect(count()).toBe(n);
    const draw = await avatarRoute.POST(json(`/api/faceless/channels/${ch.id}/avatar`, "POST", undefined, "c"), params({ id: ch.id }));
    expect(draw.status).toBe(403);
    expect(draw.headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
  });

  it("suggests topics offline and writes the episode's script offline: the studio's AI helper is never asked", async () => {
    fetched.length = 0;
    const t = await topicsRoute.POST(json("/api/faceless/topics", "POST", { channelId: channel, engine: "open" }, "a"));
    expect(t.status, await t.clone().text()).toBe(200);
    expect(((await t.json()) as { topics: unknown[] }).topics.length).toBeGreaterThan(2);
    const r = await episodesRoute.POST(json("/api/faceless/episodes", "POST", { channelId: channel, topic: "A hotel on a frozen lake", settings: { ...explainerSettings("a"), length: 60, auto: undefined } }, "a"));
    expect(r.status, await r.clone().text()).toBe(201);
    const ep = (await r.json()) as { id: string; status: string; script: { blocks: unknown[]; offline?: boolean } };
    episode = ep.id;
    expect(ep.status).toBe("review");
    expect(ep.script.blocks.length).toBeGreaterThan(0);
    expect(ep.script.offline).toBeFalsy();
    expect(reachedOwner()).toEqual([]);
    expect(llmAsked).not.toHaveBeenCalled();
  });

  it("renders the episode on its own GPU, and its channel page lists it", async () => {
    fake.log.length = 0;
    fetched.length = 0;
    const r = await run(() => actionRoute.POST(json(`/api/faceless/episodes/${episode}/render`, "POST", undefined, "a"), params({ id: episode, action: "render" })));
    expect(r.status, await r.clone().text()).toBe(200);
    const v = await settleEpisode(episode, "a");
    expect(v.episode.status, v.episode.error ?? "").toBe("done");
    const gens = Object.values(v.episode.plan!.ids);
    for (const g of gens) expect(accountOf(g)).toBe(a);
    expect(reachedOwner()).toEqual([]);
    const page = (await (await channelRoute.GET(json(`/api/faceless/channels/${channel}`, "GET", undefined, "a"), params({ id: channel }))).json()) as { episodes: { id: string }[] };
    expect(page.episodes.map((e) => e.id)).toEqual([episode]);
    expect(passed(viaProxy(`/faceless/${channel}/${episode}`, "GET", "a"))).toBe(true);
    for (const who of ["b", undefined, "owner"]) {
      for (const p of [`/faceless/${channel}`, `/faceless/${channel}/new`, `/faceless/${channel}/${episode}`]) expect(viaProxy(p, "GET", who).status, `${who ?? "guest"} ${p}`).toBe(404);
    }
    expect(passed(viaProxy(`/faceless/${channel}`, "GET", "a"))).toBe(true);
    expect(recordFor({ kind: "episode", ids: [channel, episode] }, h("a"))).toBe(true);
    expect(recordFor({ kind: "channel", ids: [channel] }, h("b"))).toBe(false);
    expect(recordFor({ kind: "channel", ids: [channel] }, h("owner"))).toBe(false);
  });

  it("another account and the owner never see, change or add to its channel", async () => {
    for (const who of ["b", "owner"]) {
      const list = (await (await channelsRoute.GET(json("/api/faceless/channels", "GET", undefined, who))).json()) as { items: { id: string }[] };
      expect(list.items.map((x) => x.id), who).not.toContain(channel);
      const eps = (await (await episodesRoute.GET(json("/api/faceless/episodes", "GET", undefined, who))).json()) as { items: { id: string }[] };
      expect(eps.items.map((x) => x.id), who).not.toContain(episode);
    }
    expect((await channelRoute.GET(json(`/api/faceless/channels/${channel}`, "GET", undefined, "b"), params({ id: channel }))).status).toBe(404);
    expect((await channelRoute.PATCH(json(`/api/faceless/channels/${channel}`, "PATCH", { name: "mine" }, "b"), params({ id: channel }))).status).toBe(404);
    expect((await channelRoute.DELETE(json(`/api/faceless/channels/${channel}`, "DELETE", undefined, "b"), params({ id: channel }))).status).toBe(404);
    expect((await avatarRoute.POST(json(`/api/faceless/channels/${channel}/avatar`, "POST", undefined, "b"), params({ id: channel }))).status).toBe(404);
    const add = await episodesRoute.POST(json("/api/faceless/episodes", "POST", { channelId: channel, topic: "Mine now", settings: { ...explainerSettings("b"), length: 60, auto: undefined } }, "b"));
    expect(add.status).toBe(404);
    // A picture of A's as B's channel picture: refused.
    const pic = await upload("a", TINY_PNG, "image/png", "avatar.png");
    const own = await channelsRoute.POST(json("/api/faceless/channels", "POST", { idea: "Night trains", genre: "education", engine: "open" }, "b"));
    const bChannel = ((await own.json()) as { id: string }).id;
    const steal = await channelRoute.PATCH(json(`/api/faceless/channels/${bChannel}`, "PATCH", { avatarUrl: pic }, "b"), params({ id: bChannel }));
    expect(steal.status).toBe(403);
    // A's own picture as its own channel's: fine.
    const mine = await channelRoute.PATCH(json(`/api/faceless/channels/${channel}`, "PATCH", { avatarUrl: pic, name: "Water hotels" }, "a"), params({ id: channel }));
    expect(mine.status, await mine.clone().text()).toBe(200);
    expect(((await mine.json()) as { name: string }).name).toBe("Water hotels");
  });

  it("never reaches the owner's channels", async () => {
    const owner = await faceless.createChannel({ idea: "The owner's channel", genre: "education", engine: "open", name: "Owner TV", avatar: false });
    expect((await channelRoute.GET(json(`/api/faceless/channels/${owner.id}`, "GET", undefined, "a"), params({ id: owner.id }))).status).toBe(404);
    expect((await channelRoute.DELETE(json(`/api/faceless/channels/${owner.id}`, "DELETE", undefined, "a"), params({ id: owner.id }))).status).toBe(404);
    const add = await episodesRoute.POST(json("/api/faceless/episodes", "POST", { channelId: owner.id, topic: "Mine", settings: { ...explainerSettings("a"), length: 60, auto: undefined } }, "a"));
    expect(add.status).toBe(404);
    const list = (await (await channelsRoute.GET(json("/api/faceless/channels", "GET", undefined, "owner"))).json()) as { items: { id: string }[] };
    expect(list.items.map((x) => x.id)).toEqual([owner.id]);
    expect(passed(viaProxy(`/faceless/${owner.id}`, "GET", "owner"))).toBe(true);
  });

  it("a ready channel is made as its own", async () => {
    const r = await startersRoute.POST(json("/api/starters/faceless.boat-hotels", "POST", { engine: "open" }, "a"), params({ id: "faceless.boat-hotels" }));
    expect(r.status, await r.clone().text()).toBe(201);
    const href = ((await r.json()) as { href: string }).href;
    const id = /^\/faceless\/([^/]+)\/new/.exec(href)![1];
    expect(store.getAccountProject(a, "faceless", id)).not.toBeNull();
    expect(store.getAccountProject(b, "faceless", id)).toBeNull();
  });

  it("a narrator sample on its own key only (no key: the card that adds one)", async () => {
    const n = count();
    const r = await voicesRoute.POST(json("/api/faceless/voices/preview", "POST", { id: "rachel" }, "a"));
    expect([400, 403]).toContain(r.status);
    expect(count()).toBe(n);
  });

  it("deletes its channel and the channel's episodes", async () => {
    const r = await channelRoute.DELETE(json(`/api/faceless/channels/${channel}`, "DELETE", undefined, "a"), params({ id: channel }));
    expect(r.status).toBe(204);
    expect(store.getAccountProject(a, "faceless", channel)).toBeNull();
    expect(db().prepare("SELECT 1 FROM faceless_episodes WHERE channel_id = ?").get(channel)).toBeUndefined();
    expect((await readEpisode(episode, "a")).status).toBe(404);
  });
});

describe("Content Factory: an account's series are its own", () => {
  let clip = "";
  let series = "";

  beforeAll(async () => {
    clip = await upload("a", CLIP, "video/mp4", "reference.mp4");
  });

  const ask = (who: string, extra: Record<string, unknown> = {}) => ({
    prompt: "Three hotels you can only reach by boat",
    settings: { engine: "open", length: 30, episodes: 2, animation: "frame-by-frame", genre: "education", aspect: "9:16" },
    voice: { kind: "sample", url: voices[who], name: "Narrator" },
    subtitles: false,
    music: false,
    ...extra,
  });

  async function settleSeries(id: string, who: string, ms = 60_000): Promise<{ analysis: { status: string; offline?: boolean; note?: string } | null; brief: unknown; episodes: { id: string; status: string }[]; channel: { id: string } | null }> {
    const end = Date.now() + ms;
    for (;;) {
      await globalThis.__fuobeRunner?.tick();
      const v = (await (await seriesRoute.GET(json(`/api/content-factory/series/${id}`, "GET", undefined, who), params({ id }))).json()) as Awaited<ReturnType<typeof settleSeries>>;
      if (v.analysis?.status !== "reading" || Date.now() > end) return v;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it("reads its own clip into a brief on its own GPU", async () => {
    fake.log.length = 0;
    fetched.length = 0;
    const r = await run(() => seriesListRoute.POST(json("/api/content-factory/series", "POST", { reference: { kind: "upload", url: clip }, engine: "open" }, "a")));
    expect(r.status, await r.clone().text()).toBe(201);
    series = ((await r.json()) as { id: string }).id;
    expect(store.getAccountProject(a, "content-factory", series)).not.toBeNull();
    const v = await settleSeries(series, "a");
    expect(v.analysis?.status).toBe("ready");
    expect(v.brief).toBeTruthy();
    for (const e of fake.log.filter((x) => x.path === "/prompt")) expect(e.prompt).toBeTruthy();
    expect(fake.log.filter((x) => x.path === "/prompt").length).toBe(1);
    expect(reachedOwner()).toEqual([]);
  });

  it("never fetches a link for an account: it uploads the clip", async () => {
    fetched.length = 0;
    const r = await seriesListRoute.POST(json("/api/content-factory/series", "POST", { reference: { kind: "link", link: "https://www.tiktok.com/@someone/video/123" }, engine: "open" }, "a"));
    expect(r.status).toBe(403);
    expect(fetched).toEqual([]);
    // A channel's YouTube reference is kept as the link, never fetched.
    const ch = await channelsRoute.POST(json("/api/faceless/channels", "POST", { idea: "Calm trains", genre: "education", engine: "open", reference: "https://www.youtube.com/@calmtrains" }, "b"));
    expect(ch.status, await ch.clone().text()).toBe(201);
    expect(((await ch.json()) as { reference: { url: string; title?: string } }).reference).toMatchObject({ url: "https://www.youtube.com/@calmtrains" });
    expect(fetched).toEqual([]);
  });

  it("refuses another account's clip, and reading for an account with no GPU or key", async () => {
    const steal = await seriesListRoute.POST(json("/api/content-factory/series", "POST", { reference: { kind: "upload", url: clip }, engine: "open" }, "b"));
    expect(steal.status).toBe(403);
    const n = count();
    const own = runAsTenant({ kind: "account", id: c }, () => saveFile({ data: CLIP, contentType: "video/mp4", source: "upload", name: "c.mp4" }).url);
    const r = await seriesListRoute.POST(json("/api/content-factory/series", "POST", { reference: { kind: "upload", url: own }, engine: "open" }, "c"));
    expect(r.status).toBe(403);
    expect(r.headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
    expect(count()).toBe(n);
    expect(store.listAccountProjects(c, "content-factory")).toEqual([]);
  });

  it("prices the series for its own GPU", async () => {
    const r = await cfEstimate.POST(json("/api/content-factory/estimate", "POST", { ...ask("a"), seriesId: series }, "a"));
    expect(r.status, await r.clone().text()).toBe(200);
    expect(((await r.json()) as { demo: boolean }).demo).toBe(false);
  });

  it("generates its episodes as one run on its own GPU, in a channel of its own", async () => {
    fake.log.length = 0;
    fetched.length = 0;
    const r = await run(() => generateRoute.POST(json(`/api/content-factory/series/${series}/generate`, "POST", ask("a"), "a"), params({ id: series })));
    expect(r.status, await r.clone().text()).toBe(200);
    const v = (await r.json()) as { made: boolean; channel: { id: string }; episodes: { id: string }[] };
    expect(v.made).toBe(true);
    expect(v.episodes.length).toBe(2);
    expect(store.getAccountProject(a, "faceless", v.channel.id)).not.toBeNull();
    const batches = new Set<string>();
    for (const e of v.episodes) {
      const ev = await settleEpisode(e.id, "a");
      expect(ev.episode.status, ev.episode.error ?? "").toBe("done");
      for (const g of Object.values(ev.episode.plan!.ids)) {
        expect(accountOf(g)).toBe(a);
        batches.add(getGeneration(g)!.batchId!);
      }
    }
    // Its episodes render as one run.
    expect(batches.size).toBe(1);
    expect(reachedOwner()).toEqual([]);
    const list = (await (await seriesListRoute.GET(json("/api/content-factory/series", "GET", undefined, "a"))).json()) as { items: { id: string; episodes: number }[] };
    expect(list.items.map((s) => s.id)).toEqual([series]);
    expect(list.items[0].episodes).toBe(2);
    expect(passed(viaProxy(`/content-factory/${series}`, "GET", "a"))).toBe(true);
    for (const who of ["b", undefined, "owner"]) expect(viaProxy(`/content-factory/${series}`, "GET", who).status, who ?? "guest").toBe(404);
    expect(recordFor({ kind: "series", ids: [series] }, h("owner"))).toBe(false);
  });

  it("adds an episode for review: written, nothing renders yet", async () => {
    const n = count();
    const r = await moreRoute.POST(json(`/api/content-factory/series/${series}/episodes`, "POST", { count: 1, next: "A floating spa", review: true }, "a"), params({ id: series }));
    expect(r.status, await r.clone().text()).toBe(200);
    const v = (await r.json()) as { episodes: { id: string; status: string }[] };
    expect(v.episodes.length).toBe(3);
    expect(v.episodes.filter((e) => e.status === "review").length).toBe(1);
    expect(count()).toBe(n);
  });

  it("another account and the owner never see, change or run it", async () => {
    for (const who of ["b", "owner"]) {
      const list = (await (await seriesListRoute.GET(json("/api/content-factory/series", "GET", undefined, who))).json()) as { items: { id: string }[] };
      expect(list.items.map((s) => s.id), who).not.toContain(series);
      expect((await seriesRoute.GET(json(`/api/content-factory/series/${series}`, "GET", undefined, who), params({ id: series }))).status, who).toBe(404);
    }
    fake.log.length = 0;
    expect((await seriesRoute.PATCH(json(`/api/content-factory/series/${series}`, "PATCH", { name: "mine" }, "b"), params({ id: series }))).status).toBe(404);
    expect((await moreRoute.POST(json(`/api/content-factory/series/${series}/episodes`, "POST", { count: 1 }, "b"), params({ id: series }))).status).toBe(404);
    expect((await readRoute.POST(json(`/api/content-factory/series/${series}/read`, "POST", { engine: "open" }, "b"), params({ id: series }))).status).toBe(404);
    expect((await seriesRoute.DELETE(json(`/api/content-factory/series/${series}`, "DELETE", undefined, "b"), params({ id: series }))).status).toBe(404);
    expect(fake.log.some((e) => e.path === "/prompt")).toBe(false);
    expect(store.getAccountProject(a, "content-factory", series)).not.toBeNull();
  });

  it("says its brief is being written on the cloud engine too, never that an AI helper writes it", async () => {
    const before = (db().prepare("SELECT data_json FROM content_series WHERE id = ?").get(series) as { data_json: string }).data_json;
    const data = JSON.parse(before) as { analysis?: Record<string, unknown> };
    data.analysis = { ...data.analysis, status: "reading", engine: "cloud", steps: {}, stage: undefined };
    db().prepare("UPDATE content_series SET data_json = ? WHERE id = ?").run(JSON.stringify(data), series);
    try {
      const v = (await (await seriesRoute.GET(json(`/api/content-factory/series/${series}`, "GET", undefined, "a"), params({ id: series }))).json()) as { analysis: { stage?: string } };
      expect(v.analysis.stage).toBe("Writing the brief…");
      expect((await settleSeries(series, "a")).analysis?.status).toBe("ready");
      expect(llmAsked).not.toHaveBeenCalled();
    } finally {
      db().prepare("UPDATE content_series SET data_json = ? WHERE id = ?").run(before, series);
    }
  });

  it("a series from a preset for an account with no GPU or key: made, but its run asks for one first", async () => {
    const r = await seriesListRoute.POST(json("/api/content-factory/series", "POST", { reference: { kind: "preset", presetId: "what-if" }, engine: "open" }, "c"));
    expect(r.status, await r.clone().text()).toBe(201);
    const id = ((await r.json()) as { id: string }).id;
    const n = count();
    const sample = runAsTenant({ kind: "account", id: c }, () => saveFile({ data: VOICE, contentType: "audio/wav", source: "upload", name: "c.wav" }).url);
    const g = await generateRoute.POST(json(`/api/content-factory/series/${id}/generate`, "POST", { ...ask("a"), voice: { kind: "sample", url: sample } }, "c"), params({ id }));
    expect(g.status, await g.clone().text()).toBe(403);
    expect(g.headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
    // The cloud engine without a key of its own: said plainly (no studio settings named).
    const cloud = await generateRoute.POST(json(`/api/content-factory/series/${id}/generate`, "POST", { ...ask("a"), voice: null, settings: { ...ask("a").settings, engine: "cloud" } }, "c"), params({ id }));
    expect(cloud.status).toBe(422);
    expect((await cloud.json()).error).toBe(faceless.ACCOUNT_CLOUD_ENGINE);
    expect(count()).toBe(n);
    expect(store.listAccountProjects(c, "faceless").length).toBe(1);
  });
});

describe("an account's limits, and its deletion", () => {
  it("keeps runs going at once", async () => {
    const now = Date.now();
    const add = db().prepare(
      "INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, outputs_json, created_at, updated_at) VALUES (?, 'explainer', 'oss-chatterbox', 'open', 'comfyui', 'tts', 'audio', 'queued', ?, '[]', ?, ?)",
    );
    for (let i = 0; i < ACCOUNT_LIMITS.activeRuns; i++) add.run(`busy-content-${i}`, JSON.stringify({ feature: "explainer", modelId: "oss-chatterbox", account: b }), now, now);
    const r = await explainerRoute.POST(json("/api/explainer", "POST", { prompt: "Volcanoes", settings: explainerSettings("b") }, "b"));
    expect(r.status).toBe(429);
    expect((await r.json()).code).toBe(access.ACTIVE_RUNS_CODE);
    db().prepare("DELETE FROM generations WHERE id LIKE 'busy-content-%'").run();
  });

  it("goes with the account: its channels, episodes, explainers and series", async () => {
    const channels = store.listAccountProjects(a, "faceless").map((p) => p.id);
    const series = store.listAccountProjects(a, "content-factory").map((p) => p.id);
    expect(channels.length).toBeGreaterThan(0);
    expect(series.length).toBeGreaterThan(0);
    const rows = (table: string, ids: string[]) =>
      (db().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id IN (${ids.map(() => "?").join(",")})`).get(...ids) as { n: number }).n;
    expect(rows("faceless_channels", channels)).toBe(channels.length);
    expect(rows("content_series", series)).toBe(series.length);
    await purgeAccount(a);
    for (const kind of ["faceless", "explainer", "content-factory"]) expect(store.listAccountProjects(a, kind), kind).toEqual([]);
    // Their rows in the tools' own tables go too: channels (with their episodes) and series.
    expect(rows("faceless_channels", channels)).toBe(0);
    expect((db().prepare(`SELECT COUNT(*) AS n FROM faceless_episodes WHERE channel_id IN (${channels.map(() => "?").join(",")})`).get(...channels) as { n: number }).n).toBe(0);
    expect(rows("content_series", series)).toBe(0);
    const left = db().prepare("SELECT COUNT(*) AS n FROM faceless_episodes e WHERE e.kind = 'explainer' AND e.channel_id IS NULL AND e.title = 'How bees make honey'").get() as { n: number };
    expect(left.n).toBe(0);
    expect((db().prepare("SELECT COUNT(*) AS n FROM content_series").get() as { n: number }).n).toBeGreaterThan(0);
  });
});

describe("the content tools' pages ask first, and lead visitors only where they can go", () => {
  const src = (f: string) => fs.readFileSync(path.join(__dirname, "..", f), "utf8").replace(/\s+/g, " ");

  it("the narrator's Upload asks first, as Record does; saving voices in Elements is the owner's link", () => {
    const page = src("src/components/faceless/narrator.tsx");
    expect(page).toContain("const askFirst = useAskBeforeUpload();");
    expect(page).toContain("onClick={() => askFirst() || file.current?.click()}");
    expect(page).toContain("{!saved.length && !visitor && ( <Link href=\"/elements?new=1\"");
  });

  it("characters and places from Elements show for the owner only", () => {
    expect(src("src/components/faceless/settings-form.tsx")).toContain('{!visitor && ( <Section title="Characters and places"');
  });

  it("Explainer's Generate asks a guest to sign up (an account to connect) before any hint about the settings", () => {
    expect(src("src/components/explainer/explainer-studio.tsx")).toMatch(/const generate = \(\) => \{ (\/\/[^\n]*?)?.*?if \(askFirst\("run"\)\) return; setTried\(true\);/);
  });
});
