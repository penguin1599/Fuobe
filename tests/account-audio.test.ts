import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { startFakeComfy, TINY_WAV, type FakeComfy } from "./helpers/fake-comfy-runner";
import { tempDir } from "./helpers/temp-dir";

vi.setConfig({ testTimeout: 120_000 });
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

/**
 * The Audio tools and Translate & dub for a signed-in account (public sign-up): every step runs on the account's own
 * ComfyUI (a stand-in here) through the same generations every studio run makes, with only its own files; its dubs are
 * its own projects, and their translations run on its own GPU, never on the install's AI helper. A guest gets the
 * sign-up card; another account's dubs and runs and the owner's are never reached.
 */
const dir = tempDir("fuobe-account-audio-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://owner-comfy.test:8188";
process.env.FUOBE_PUBLIC_SIGNUP = "1";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_ALLOW_PRIVATE_URLS;
delete process.env.FUOBE_HOSTED_RUNS;
globalThis.__fuobeTestDiskFree = 1e13;

// Plain fetch is the install's own ComfyUI ("owner-comfy.test"): recorded, so a test sees that nothing reached it.
const realFetch = globalThis.fetch;
const fetched: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "127.0.0.1" && url.port !== "11434" && url.port !== "1234") return realFetch(input, init);
  fetched.push(url.toString());
  if (url.host !== "owner-comfy.test:8188") return new Response("not stubbed", { status: 599 });
  if (url.pathname === "/system_stats") return Response.json({ system: { comfyui_version: "owner", ram_total: 1 }, devices: [] });
  return Response.json({});
}) as typeof fetch;

const auth = await import("@/server/auth");
const toolsRoute = await import("@/app/api/audio-tools/route");
const exportRoute = await import("@/app/api/audio-tools/export/route");
const dubsRoute = await import("@/app/api/dub/route");
const dubRoute = await import("@/app/api/dub/[id]/route");
const voiceRoute = await import("@/app/api/dub/[id]/voice/route");
const uploadsRoute = await import("@/app/api/uploads/route");
const gpuRoute = await import("@/app/api/account/gpu/route");
const { proxy } = await import("@/proxy");
const access = await import("@/lib/guest-access");
const { GPU_TRANSLATE_MODEL, reviewCues } = await import("@/lib/av/dub");
const { ensureRunner, getGeneration, listGenerations } = await import("@/server/generations");
const { db } = await import("@/server/db");
const { resetRates } = await import("@/server/rate");
const { clearAccountLoras } = await import("@/server/account-loras");
const { saveFile } = await import("@/server/storage");
const { runAsTenant } = await import("@/server/tenant");
const { ACCOUNT_LIMITS } = await import("@/server/account-files");
const store = await import("@/server/account-projects");
const { listDubSessions } = await import("@/server/dub");
const { purgeAccount } = await import("@/server/account-sweep");

const CLIP = fs.readFileSync(path.join(__dirname, "fixtures/shorts-12s.mp4"));
// The words the stand-in's text steps write: a transcript (and a translation) as timed lines.
const LINES = "0.00-2.00: Hello there\n2.20-4.00: How are you";

let fake: FakeComfy;
let a = "";
let b = "";
let c = "";
const cookies: Record<string, string> = {};
beforeAll(async () => {
  fake = await startFakeComfy({ loras: [], delayMs: 0, graph: true, text: LINES });
  globalThis.__fuobeTestGpuPort = fake.port;
  auth.setPassword("install password");
  for (const [k, email] of [
    ["a", "audio-a@example.com"],
    ["b", "audio-b@example.com"],
    ["c", "audio-c@example.com"],
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
  // The runner's own start looks for the install's ComfyUI and local AI helper once: not part of any run.
  ensureRunner();
  await new Promise((r) => setTimeout(r, 300));
  fetched.length = 0;
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

function json(url: string, method: string, body: unknown, who?: string): Request {
  const text = JSON.stringify(body);
  return new Request(`http://localhost:3000${url}`, {
    method,
    headers: { host: "localhost:3000", "content-type": "application/json", "content-length": String(Buffer.byteLength(text)), ...(who && { cookie: cookies[who] }) },
    body: text,
  });
}
const get = (url: string, who?: string) => new Request(`http://localhost:3000${url}`, { headers: { host: "localhost:3000", ...(who && { cookie: cookies[who] }) } });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;

const viaProxy = (url: string, method = "GET", who?: string) =>
  proxy(new NextRequest(`http://localhost:3000${url}`, { method, headers: { host: "localhost:3000", ...(who && { cookie: cookies[who] }), ...(method !== "GET" && { "content-type": "application/json" }) }, ...(method !== "GET" && { body: "{}" }) }));
const passed = (r: Response) => r.headers.get("x-middleware-next") === "1";

async function upload(who: string, data: Buffer, type: string, name: string): Promise<string> {
  const r = await uploadsRoute.POST(new Request("http://localhost:3000/api/uploads", { method: "POST", headers: { host: "localhost:3000", cookie: cookies[who], "content-type": type, "x-file-name": name, "content-length": String(data.length) }, body: new Uint8Array(data) }));
  expect(r.status, await r.clone().text()).toBe(201);
  return ((await r.json()) as { url: string }).url;
}

/** Tick the runner until the row is done (or the time is up). */
async function settle(id: string, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    await globalThis.__fuobeRunner?.tick();
    const g = getGeneration(id, { includeDeleted: true });
    if (!g || (g.status !== "queued" && g.status !== "running") || Date.now() > end) return g;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const prompts = () => fake.log.filter((e) => e.path === "/prompt").length;
const generationCount = () => (db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n;

/** Start an audio tool run as `who`; a LoRA its ComfyUI lacks is put there (the 409 names it), then it is sent again. */
async function tool(body: unknown, who: string): Promise<Response> {
  let r = await toolsRoute.POST(json("/api/audio-tools", "POST", body, who));
  if (r.status === 409 && (await r.clone().json()).code === "comfy_missing_model") {
    const j = (await r.json()) as { fix: { items: { file: string }[] } };
    fake.opts.loras = [...(fake.opts.loras ?? []), ...j.fix.items.map((i) => i.file)];
    for (const id of [a, b]) clearAccountLoras(id);
    r = await toolsRoute.POST(json("/api/audio-tools", "POST", body, who));
  }
  return r;
}

type Run = { batchId: string; result: { id: string }; items: { id: string; batchId: string | null }[] };

/** A run's every step: its own, on its own ComfyUI; nothing reached the install's ComfyUI or AI helper. */
async function ranAsOwn(r: Response, who: string) {
  expect(r.status, await r.clone().text()).toBe(201);
  const run = (await r.json()) as Run;
  expect(new Set(run.items.map((g) => g.batchId)).size).toBe(1);
  for (const g of run.items) {
    const row = getGeneration(g.id)!;
    expect(row.request.account, g.id).toBe(who);
    expect(row.provider, g.id).toBe("comfyui");
  }
  const done = await settle(run.result.id);
  expect(done?.status, done?.error ?? "").toBe("succeeded");
  for (const g of run.items) expect(getGeneration(g.id)!.status, g.id).toBe("succeeded");
  return { run, done: done! };
}

describe("the proxy opens the Audio tools and Translate & dub to accounts, and keeps the sign-up card for guests", () => {
  it("a guest gets the sign-up card on a run, a dub, a voice and a change to a dub; its price checks go through", async () => {
    for (const [p, m] of [
      ["/api/audio-tools", "POST"],
      ["/api/dub", "POST"],
      ["/api/dub/some-id/voice", "POST"],
      ["/api/dub/some-id", "PATCH"],
      ["/api/dub/some-id", "DELETE"],
      ["/api/audio-tools/export", "POST"],
    ] as const) {
      const r = viaProxy(p, m);
      expect(r.status, `${m} ${p}`).toBe(401);
      expect(r.headers.get(access.GUEST_HEADER), p).toBe("1");
      expect((await r.json()).error).toBe(access.GUEST_RUN_MESSAGE);
    }
    for (const p of ["/api/audio-tools?preview=1", "/api/dub?preview=1", "/api/dub/some-id/voice?preview=1"]) expect(passed(viaProxy(p, "POST")), p).toBe(true);
    // Its dubs list is empty; a dub is the owner's library (closed).
    expect(await viaProxy("/api/dub").json()).toEqual({ items: [] });
    expect(viaProxy("/api/dub/some-id").status).toBe(401);
  });

  it("an account with its own GPU reaches every route; one with neither a GPU nor a key is asked to connect one", async () => {
    for (const [p, m] of [
      ["/api/audio-tools", "POST"],
      ["/api/dub", "POST"],
      ["/api/dub/some-id/voice", "POST"],
      ["/api/dub", "GET"],
      ["/api/dub/some-id", "GET"],
      ["/api/dub/some-id", "PATCH"],
      ["/api/dub/some-id", "DELETE"],
    ] as const) {
      expect(passed(viaProxy(p, m, "a")), `${m} ${p}`).toBe(true);
    }
    for (const p of ["/api/audio-tools", "/api/dub", "/api/dub/some-id/voice"]) {
      const r = viaProxy(p, "POST", "c");
      expect(r.status, p).toBe(403);
      expect(r.headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
      expect((await r.json()).code).toBe("connect-gpu");
    }
    expect(access.ownGpuRun("POST", "/api/audio-tools")).toBe(true);
    expect(access.ownGpuRun("POST", "/api/dub/x/voice")).toBe(true);
    expect(access.ownGpuRun("GET", "/api/dub")).toBe(false);
    expect(access.accountProjectRoute("/api/dub/x")).toBe(true);
    expect(access.accountProjectRoute("/api/dub/x/voice")).toBe(false);
  });

  it("the routes refuse a guest themselves", async () => {
    expect((await toolsRoute.POST(json("/api/audio-tools", "POST", {}))).status).toBe(401);
    expect((await dubsRoute.POST(json("/api/dub", "POST", {}))).status).toBe(401);
    expect((await voiceRoute.POST(json("/api/dub/x/voice", "POST", {}), ctx("x"))).status).toBe(401);
    expect((await dubRoute.PATCH(json("/api/dub/x", "PATCH", {}), ctx("x"))).status).toBe(401);
    expect((await dubRoute.DELETE(get("/api/dub/x"), ctx("x"))).status).toBe(401);
    expect((await dubRoute.GET(get("/api/dub/x"), ctx("x"))).status).toBe(404);
    expect(await (await dubsRoute.GET(get("/api/dub"))).json()).toEqual({ items: [] });
  });
});

describe("an account runs the Audio tools on its own ComfyUI", () => {
  let clip = "";
  let split = "";
  beforeAll(async () => {
    clip = await upload("a", CLIP, "video/mp4", "scene.mp4");
  });

  it("prices a split for its own GPU, never as a demo", async () => {
    const r = await toolsRoute.POST(json("/api/audio-tools?preview=1", "POST", { tool: "split", engine: "open", media: clip, kind: "video" }, "a"));
    expect(r.status, await r.clone().text()).toBe(200);
    expect(((await r.json()) as { demo: boolean }).demo).toBe(false);
  });

  it("splits a soundtrack end to end: every step is its own, on its ComfyUI, and the stems are its own files", async () => {
    fake.log.length = 0;
    fetched.length = 0;
    const { run, done } = await ranAsOwn(await tool({ tool: "split", engine: "open", media: clip, kind: "video", name: "scene" }, "a"), a);
    split = run.result.id;
    expect(prompts()).toBe(run.items.length);
    expect(fetched.filter((u) => !u.endsWith("/system_stats"))).toEqual([]);
    const stems = done.outputs.filter((o) => o.kind === "audio");
    expect(stems.length).toBeGreaterThan(0);
    for (const o of stems) {
      expect(o.url).toMatch(/^\/api\/files\/outputs\//);
      expect((db().prepare("SELECT account_id FROM assets WHERE id = ?").get(o.assetId) as { account_id: string }).account_id).toBe(a);
      expect(passed(viaProxy(o.url, "GET", "a"))).toBe(true);
      expect(viaProxy(o.url, "GET", "b").status).toBe(403);
    }
    expect(passed(viaProxy(`/api/generations/${split}`, "GET", "a"))).toBe(true);
    expect(viaProxy(`/api/generations/${split}`, "GET", "b").status).toBe(403);
    expect(listGenerations({ features: [done.feature], account: a }).map((g) => g.id)).toContain(split);
    expect(listGenerations({ features: [done.feature], account: b })).toEqual([]);
  });

  it("cleans up dialogue, takes the dialogue out of a video and edits speech, each on its own ComfyUI", async () => {
    for (const body of [
      { tool: "clean-dialogue", engine: "open", media: clip, kind: "video", name: "scene" },
      { tool: "remove-dialogue", engine: "open", video: clip, name: "scene" },
      { tool: "speech-edit", engine: "open", media: clip, kind: "video", name: "scene", cues: [{ start: 0, end: 2, text: "Hello there" }], edited: ["Hello friend"] },
    ]) {
      fetched.length = 0;
      await ranAsOwn(await tool(body, "a"), a);
      expect(fetched.filter((u) => !u.endsWith("/system_stats")), body.tool).toEqual([]);
    }
  });

  it("keeps an exported mix as its own run, and puts it back on its own video", async () => {
    const q = new URLSearchParams({ offset: "0", last: "1", name: "scene · mix.wav" });
    const r = await exportRoute.POST(new Request(`http://localhost:3000/api/audio-tools/export?${q}`, { method: "POST", headers: { host: "localhost:3000", cookie: cookies.a, "content-type": "application/octet-stream", "content-length": String(TINY_WAV.length) }, body: new Uint8Array(TINY_WAV) }));
    expect(r.status, await r.clone().text()).toBe(201);
    const mix = (await r.json()) as { id: string; outputs: { url: string }[] };
    expect(getGeneration(mix.id)!.request.account).toBe(a);
    await ranAsOwn(await tool({ tool: "remux", engine: "open", video: clip, audio: mix.outputs[0].url, name: "scene" }, "a"), a);
    // Another account can't put A's mix on its video.
    const bClip = await upload("b", CLIP, "video/mp4", "b.mp4");
    const other = await tool({ tool: "remux", engine: "open", video: bClip, audio: mix.outputs[0].url }, "b");
    expect(other.status).toBe(403);
    expect((await other.json()).code).toBe("input-not-yours");
  });

  it("refuses another's file, the owner's file, a link, and an account with nothing to run on, before anything is made", async () => {
    const n = generationCount();
    const before = prompts();
    const theirs = await tool({ tool: "split", engine: "open", media: clip, kind: "video" }, "b");
    expect(theirs.status).toBe(403);
    expect((await theirs.json()).code).toBe("input-not-yours");
    const ownerClip = saveFile({ data: CLIP, contentType: "video/mp4", source: "upload", name: "owner.mp4" }).url;
    const owners = await tool({ tool: "remove-dialogue", engine: "open", video: ownerClip }, "a");
    expect(owners.status).toBe(403);
    expect((await tool({ tool: "split", engine: "open", media: "https://example.com/a.mp4", kind: "video" }, "a")).status).toBe(400);
    const own = runAsTenant({ kind: "account", id: c }, () => saveFile({ data: CLIP, contentType: "video/mp4", source: "upload", name: "c.mp4" }).url);
    const none = await tool({ tool: "split", engine: "open", media: own, kind: "video" }, "c");
    expect(none.status).toBe(403);
    expect(none.headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
    expect(generationCount()).toBe(n);
    expect(prompts()).toBe(before);
  });

  it("keeps the account's limits: runs going at once, and a body over a run's size", async () => {
    const now = Date.now();
    const add = db().prepare(
      "INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, outputs_json, created_at, updated_at) VALUES (?, 'audio-split', 'oss-trim', 'open', 'comfyui', 'trim', 'audio', 'queued', ?, '[]', ?, ?)",
    );
    for (let i = 0; i < ACCOUNT_LIMITS.activeRuns; i++) add.run(`busy-${i}`, JSON.stringify({ feature: "audio-split", modelId: "oss-trim", account: a }), now, now);
    const r = await tool({ tool: "split", engine: "open", media: clip, kind: "video" }, "a");
    expect(r.status).toBe(429);
    expect((await r.json()).code).toBe(access.ACTIVE_RUNS_CODE);
    db().prepare("DELETE FROM generations WHERE id LIKE 'busy-%'").run();
    const big = new Request("http://localhost:3000/api/audio-tools", { method: "POST", headers: { host: "localhost:3000", cookie: cookies.a, "content-type": "application/json", "content-length": String(ACCOUNT_LIMITS.runBodyBytes + 1) }, body: "{}" });
    expect((await toolsRoute.POST(big)).status).toBe(413);
  });
});

describe("an account dubs a video on its own ComfyUI, and its dubs are its own", () => {
  let clip = "";
  let dub = "";
  beforeAll(async () => {
    clip = await upload("a", CLIP, "video/mp4", "talk.mp4");
  });

  it("prices a dub as its own run: the translation on its own GPU, free", async () => {
    const r = await dubsRoute.POST(json("/api/dub?preview=1", "POST", { engine: "open", mode: "steps", video: clip, targets: ["es"] }, "a"));
    expect(r.status, await r.clone().text()).toBe(200);
    const p = (await r.json()) as { demo: boolean; costUsd: number };
    expect(p.demo).toBe(false);
    expect(p.costUsd).toBe(0);
  });

  it("never prices another account's video: it reads as a missing file", async () => {
    const price = (video: string) => dubsRoute.POST(json("/api/dub?preview=1", "POST", { engine: "open", mode: "steps", video, targets: ["es"] }, "b"));
    const missing = await price("/api/files/uploads/nothing-here.mp4");
    const theirs = await price(clip);
    expect(theirs.status).toBe(missing.status);
    expect(theirs.status).toBe(422);
    const said = (await theirs.json()) as { error: string; costUsd?: number };
    expect(said).toEqual(await missing.json());
    expect(said.error).toBe("That video is gone — add it again");
  });

  it("transcribes and translates on its own ComfyUI (never the AI helper), then voices a language end to end", async () => {
    fake.log.length = 0;
    fetched.length = 0;
    const r = await dubsRoute.POST(json("/api/dub", "POST", { engine: "open", mode: "steps", video: clip, targets: ["es"], title: "Talk" }, "a"));
    expect(r.status, await r.clone().text()).toBe(201);
    const s = (await r.json()) as { id: string; prepare: Record<string, string> };
    dub = s.id;
    // The account's own project; the owner's dub table never holds it.
    expect(store.getAccountProject(a, "dub", dub)).not.toBeNull();
    expect((db().prepare("SELECT COUNT(*) AS n FROM dub_sessions").get() as { n: number }).n).toBe(0);
    for (const id of Object.values(s.prepare)) {
      const g = getGeneration(id)!;
      expect(g.request.account).toBe(a);
      expect(g.provider).toBe("comfyui");
      expect((await settle(id))?.status, getGeneration(id)?.error ?? "").toBe("succeeded");
    }
    const translate = getGeneration(s.prepare["translate:es"])!;
    expect(translate.modelId).toBe(GPU_TRANSLATE_MODEL);
    // Its graph: the instruction names the language, and the transcript goes in as its timed lines (JSON).
    const graph = fake.log.map((e) => e.prompt).find((p) => Object.values(p ?? {}).some((n) => (n as { class_type?: string }).class_type === "TextGenerate"));
    const words = Object.values(graph ?? {}).find((n) => (n as { class_type?: string }).class_type === "StringConcatenate") as { inputs: { string_a: string; string_b: string } } | undefined;
    expect(words?.inputs.string_a).toMatch(/JSON list of subtitle lines[\s\S]*into Spanish/);
    expect(JSON.parse(words!.inputs.string_b)).toEqual([expect.objectContaining({ start: 0, end: 2, text: "Hello there" }), expect.objectContaining({ start: 2.2, end: 4, text: "How are you" })]);
    // The translator reads the transcript as its timed lines, and its answer is the lines to review.
    const view = (await (await dubRoute.GET(get(`/api/dub/${dub}`, "a"), ctx(dub))).json()) as Parameters<typeof reviewCues>[0];
    expect(reviewCues(view, "es")?.map((c) => c.text)).toEqual(["Hello there", "How are you"]);
    // Its reviewed lines are saved with its dub.
    const saved = await dubRoute.PATCH(json(`/api/dub/${dub}`, "PATCH", { lang: "es", cues: [{ start: 0, end: 2, text: "Hola" }, { start: 2.2, end: 4, text: "¿Qué tal?" }] }, "a"), ctx(dub));
    expect(saved.status, await saved.clone().text()).toBe(200);
    // The voice: every step its own, on its ComfyUI; the dubbed video is its own file.
    const v = await voiceRoute.POST(json(`/api/dub/${dub}/voice`, "POST", { lang: "es", lipsync: false }, "a"), ctx(dub));
    expect(v.status, await v.clone().text()).toBe(201);
    const voiced = (await v.json()) as { voices: Record<string, { ids: Record<string, string> }[]> };
    const ids = Object.values(voiced.voices.es[0].ids);
    for (const id of ids) {
      expect(getGeneration(id)!.request.account).toBe(a);
      expect(getGeneration(id)!.provider).toBe("comfyui");
    }
    for (const id of ids) expect((await settle(id))?.status, getGeneration(id)?.error ?? "").toBe("succeeded");
    expect(fetched.filter((u) => !u.endsWith("/system_stats"))).toEqual([]);
    const film = ids.map((id) => getGeneration(id)!).find((g) => g.outputs.some((o) => o.kind === "video"));
    expect(film?.outputs[0].url).toMatch(/^\/api\/files\/outputs\//);
  });

  it("another account and the owner never see, open, change, voice or forget it", async () => {
    const theirs = (await (await dubsRoute.GET(get("/api/dub", "b"))).json()) as { items: { id: string }[] };
    expect(theirs.items).toEqual([]);
    const mine = (await (await dubsRoute.GET(get("/api/dub", "a"))).json()) as { items: { id: string }[] };
    expect(mine.items.map((s) => s.id)).toEqual([dub]);
    expect((await dubRoute.GET(get(`/api/dub/${dub}`, "b"), ctx(dub))).status).toBe(404);
    expect((await dubRoute.PATCH(json(`/api/dub/${dub}`, "PATCH", { lang: "es", cues: [] }, "b"), ctx(dub))).status).toBe(404);
    expect((await voiceRoute.POST(json(`/api/dub/${dub}/voice`, "POST", { lang: "es" }, "b"), ctx(dub))).status).toBe(404);
    expect((await voiceRoute.POST(json(`/api/dub/${dub}/voice?preview=1`, "POST", { lang: "es" }, "b"), ctx(dub))).status).toBe(404);
    expect((await dubRoute.DELETE(get(`/api/dub/${dub}`, "b"), ctx(dub))).status).toBe(404);
    // The owner's list and the owner's reads are the owner's table only.
    expect(listDubSessions().map((s) => s.id)).not.toContain(dub);
    expect((await dubRoute.GET(get(`/api/dub/${dub}`, "owner"), ctx(dub))).status).toBe(404);
    // A's video in B's dub: refused before anything is made.
    const n = generationCount();
    const other = await dubsRoute.POST(json("/api/dub", "POST", { engine: "open", mode: "steps", video: clip, targets: ["es"] }, "b"));
    expect(other.status).toBe(403);
    expect((await other.json()).code).toBe("input-not-yours");
    expect(generationCount()).toBe(n);
  });

  it("asks an account with nothing to run on to connect its GPU, and keeps nothing", async () => {
    const own = runAsTenant({ kind: "account", id: c }, () => saveFile({ data: CLIP, contentType: "video/mp4", source: "upload", name: "c.mp4" }).url);
    const n = generationCount();
    const r = await dubsRoute.POST(json("/api/dub", "POST", { engine: "open", mode: "steps", video: own, targets: ["es"] }, "c"));
    expect(r.status).toBe(403);
    expect(r.headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
    expect(generationCount()).toBe(n);
    expect(store.listAccountProjects(c, "dub")).toEqual([]);
  });

  it("forgets its own dub, and its dubs go with the account", async () => {
    // A second dub, then the first forgotten.
    const r = await dubsRoute.POST(json("/api/dub", "POST", { engine: "open", mode: "steps", video: clip, targets: ["fr"] }, "a"));
    expect(r.status, await r.clone().text()).toBe(201);
    expect((await dubRoute.DELETE(get(`/api/dub/${dub}`, "a"), ctx(dub))).status).toBe(204);
    expect((await dubRoute.GET(get(`/api/dub/${dub}`, "a"), ctx(dub))).status).toBe(404);
    expect(store.listAccountProjects(a, "dub").length).toBe(1);
    await purgeAccount(a);
    expect(store.listAccountProjects(a, "dub")).toEqual([]);
  });
});
