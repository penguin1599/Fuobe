import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { startFakeComfy, TINY_PNG, type FakeComfy } from "./helpers/fake-comfy-runner";
import { tempDir } from "./helpers/temp-dir";

/**
 * Storyboard for a signed-in account (public sign-up): its boards and their films run on the account's own ComfyUI (a
 * stand-in here) through the same generations every studio run makes, with only its own reference pictures, and they
 * stay its own: it reopens them from its own runs, and another account or the owner's boards are never reached. A
 * guest gets the sign-up card. Splitting a story never asks the install's AI helper for an account.
 */
const dir = tempDir("fuobe-account-storyboard-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://owner-comfy.test:8188";
process.env.FUOBE_PUBLIC_SIGNUP = "1";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_ALLOW_PRIVATE_URLS;
delete process.env.FUOBE_HOSTED_RUNS;
delete process.env.ANTHROPIC_API_KEY;
globalThis.__fuobeTestDiskFree = 1e13;

// Plain fetch is the install's own ComfyUI ("owner-comfy.test") or its AI helper, a local model ("owner-llm.test"):
// recorded ("METHOD url"), so a test sees that nothing reached them.
const LLM_SCENES = ["Wide shot: the crew boards the night train", "Close-up: a gloved hand lifts the case", "Wide shot: the train vanishes into the tunnel"];
const realFetch = globalThis.fetch;
const fetched: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "127.0.0.1") return realFetch(input, init);
  fetched.push(`${(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()} ${url}`);
  if (url.host === "owner-llm.test:11434") {
    if (url.pathname === "/api/tags") return Response.json({ models: [{ name: "qwen3:8b", model: "qwen3:8b" }] });
    if (url.pathname === "/api/chat") return Response.json({ model: "qwen3:8b", message: { role: "assistant", content: JSON.stringify(LLM_SCENES) }, done: true });
  }
  if (url.host !== "owner-comfy.test:8188") return new Response("not stubbed", { status: 599 });
  if (url.pathname === "/system_stats") return Response.json({ system: { comfyui_version: "owner", ram_total: 1 }, devices: [] });
  return Response.json({});
}) as typeof fetch;

const auth = await import("@/server/auth");
const boardsRoute = await import("@/app/api/storyboards/route");
const filmRoute = await import("@/app/api/storyboards/[id]/film/route");
const estimateRoute = await import("@/app/api/storyboards/estimate/route");
const uploadsRoute = await import("@/app/api/uploads/route");
const gpuRoute = await import("@/app/api/account/gpu/route");
const { proxy } = await import("@/proxy");
const access = await import("@/lib/guest-access");
const { getGeneration, listGenerations } = await import("@/server/generations");
const { db } = await import("@/server/db");
const { resetRates } = await import("@/server/rate");
const { clearAccountLoras } = await import("@/server/account-loras");
const { saveFile } = await import("@/server/storage");
const { setSetting } = await import("@/server/settings");
const { splitStory } = await import("@/server/storyboard");
const { heuristicScenes, ONE_SHEET_GPU_TEST } = await import("@/lib/catalog/storyboard");
const { ACCOUNT_LIMITS } = await import("@/server/account-files");

let fake: FakeComfy;
let a = "";
let b = "";
const cookies: Record<string, string> = {};
beforeAll(async () => {
  fake = await startFakeComfy({ loras: [], delayMs: 0, output: "image" });
  globalThis.__fuobeTestGpuPort = fake.port;
  auth.setPassword("install password");
  for (const [k, email] of [
    ["a", "storyboard-a@example.com"],
    ["b", "storyboard-b@example.com"],
    ["c", "storyboard-c@example.com"],
  ] as const) {
    const id = auth.createAccount(email, "long enough").id;
    cookies[k] = `${auth.SESSION_COOKIE}=${auth.createSession(id).value}`;
    if (k === "a") a = id;
    if (k === "b") b = id;
  }
  cookies.owner = `${auth.SESSION_COOKIE}=${auth.createSession().value}`;
  // The install's own AI helper is a local model: the owner's boards would ask it to split a story.
  setSetting("enhanceProvider", "local");
  setSetting("ollamaUrl", "http://owner-llm.test:11434");
  // A and B link their own ComfyUI; C has neither a GPU nor a key.
  for (const who of ["a", "b"]) expect((await gpuRoute.PUT(json("/api/account/gpu", "PUT", { url: fake.url }, who))).status).toBe(200);
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

const viaProxy = (url: string, method = "GET", who?: string) =>
  proxy(new NextRequest(`http://localhost:3000${url}`, { method, headers: { host: "localhost:3000", ...(who && { cookie: cookies[who] }), ...(method !== "GET" && { "content-type": "application/json" }) }, ...(method !== "GET" && { body: "{}" }) }));
const passed = (r: Response) => r.headers.get("x-middleware-next") === "1";

async function upload(who: string, data: Buffer, type: string, name: string): Promise<string> {
  const r = await uploadsRoute.POST(new Request("http://localhost:3000/api/uploads", { method: "POST", headers: { host: "localhost:3000", cookie: cookies[who], "content-type": type, "x-file-name": name, "content-length": String(data.length) }, body: new Uint8Array(data) }));
  expect(r.status, await r.clone().text()).toBe(201);
  return ((await r.json()) as { url: string }).url;
}

/** Tick the runner until the row is done (or the time is up). */
async function settle(id: string, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    await globalThis.__fuobeRunner?.tick();
    const g = getGeneration(id, { includeDeleted: true });
    if (!g || (g.status !== "queued" && g.status !== "running") || Date.now() > end) return g;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** What GET /api/generations?features=storyboard,storyboard-film lists for an account (the route lists its own runs only). */
const mine = (who: "a" | "b") => listGenerations({ features: ["storyboard", "storyboard-film"], account: who === "a" ? a : b });

/**
 * What reached the install's own GPU or AI helper. Its own checks aside: whether its ComfyUI and its local model are up
 * (they send nothing of anyone's run).
 */
const reached = () => fetched.filter((f) => !f.endsWith("/system_stats") && f !== "GET http://owner-llm.test:11434/api/tags");

const rows = () => (db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n;

/** Send a run; a LoRA its ComfyUI lacks is put there (the 409 names it), then it is sent again. */
async function send(call: () => Promise<Response>): Promise<Response> {
  let r = await call();
  if (r.status === 409) {
    const j = (await r.clone().json()) as { code: string; fix?: { items: { file: string }[] } };
    expect(j.code).toBe("comfy_missing_model");
    fake.opts.loras = [...(fake.opts.loras ?? []), ...j.fix!.items.map((i) => i.file)];
    for (const id of [a, b]) clearAccountLoras(id);
    r = await call();
  }
  return r;
}
const board = (body: unknown, who: string) => send(() => boardsRoute.POST(json("/api/storyboards", "POST", body, who)));
const film = (id: string, body: unknown, who?: string) => send(() => filmRoute.POST(json(`/api/storyboards/${id}/film`, "POST", body, who), { params: Promise.resolve({ id }) }));

const SCENES = ["A model in an emerald gown on a palace stair at midnight", "She runs to a vintage car under the lamps", "The car on a coast road at dawn"];

describe("the proxy opens Storyboard's runs to accounts, and keeps the sign-up card for guests", () => {
  it("a guest gets the sign-up card on a board and a film; the price check stays open", async () => {
    for (const p of ["/api/storyboards", "/api/storyboards/b1/film"]) {
      const r = viaProxy(p, "POST");
      expect(r.status, p).toBe(401);
      expect(r.headers.get(access.GUEST_HEADER), p).toBe("1");
      expect((await r.json()).error).toBe(access.GUEST_RUN_MESSAGE);
    }
    expect(passed(viaProxy("/api/storyboards/estimate", "POST"))).toBe(true);
  });

  it("an account with its own GPU reaches the routes; one with neither a GPU nor a key is asked to connect one", async () => {
    for (const p of ["/api/storyboards", "/api/storyboards/b1/film"]) {
      expect(passed(viaProxy(p, "POST", "a")), p).toBe(true);
      const r = viaProxy(p, "POST", "c");
      expect(r.status, p).toBe(403);
      expect(r.headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
      expect((await r.json()).code).toBe("connect-gpu");
    }
    expect(access.ownGpuRun("GET", "/api/storyboards")).toBe(false);
    expect(access.ownGpuRun("POST", "/api/storyboards/b1")).toBe(false);
    expect(access.ownGpuRun("POST", "/api/storyboards/b1/film/x")).toBe(false);
    // Reading the owner's boards stays closed (an account's own boards are its own runs).
    expect(viaProxy("/api/storyboards", "GET", "a").status).toBe(403);
  });

  it("the routes refuse a guest themselves", async () => {
    const r = await boardsRoute.POST(json("/api/storyboards", "POST", { engine: "open", scenes: SCENES }));
    expect(r.status).toBe(401);
    expect(r.headers.get(access.GUEST_HEADER)).toBe("1");
    const f = await filmRoute.POST(json("/api/storyboards/b1/film", "POST", {}), { params: Promise.resolve({ id: "b1" }) });
    expect(f.status).toBe(401);
    expect(f.headers.get(access.GUEST_HEADER)).toBe("1");
  });
});

describe("an account makes, reopens and films its own storyboards on its own ComfyUI", () => {
  let ref = "";
  let batch = "";
  let frames: string[] = [];
  beforeAll(async () => {
    ref = await upload("a", TINY_PNG, "image/png", "look.png");
  });

  it("prices a board for its own GPU, never as a demo", async () => {
    const r = await estimateRoute.POST(json("/api/storyboards/estimate", "POST", { engine: "open", scenes: SCENES, references: [ref] }, "a"));
    expect(r.status, await r.clone().text()).toBe(200);
    const e = (await r.json()) as { demo: boolean; costUsd: number | null; frames: number };
    expect(e.demo).toBe(false);
    expect(e.frames).toBe(3);
  });

  it("makes a board with its own look reference: every frame is its own, on its ComfyUI, and its results are its own files", async () => {
    fake.log.length = 0;
    fetched.length = 0;
    const r = await board({ engine: "open", scenes: SCENES, references: [ref], aspectRatio: "16:9", requestId: "board-request-1" }, "a");
    expect(r.status, await r.clone().text()).toBe(201);
    const body = (await r.json()) as { batchId: string; scenes: string[]; items: { id: string; batchId: string | null }[] };
    batch = body.batchId;
    frames = body.items.map((g) => g.id);
    expect(body.scenes).toEqual(SCENES);
    expect(frames).toHaveLength(3);
    expect(new Set(body.items.map((g) => g.batchId))).toEqual(new Set([batch]));
    for (const id of frames) expect(getGeneration(id)!.request.account, id).toBe(a);
    // Its look reference went into frame 1.
    expect(getGeneration(frames[0])!.request.inputs?.images).toEqual([ref]);
    for (const id of frames) {
      const g = await settle(id);
      expect(g?.status, g?.error ?? "").toBe("succeeded");
    }
    // Every frame went to its own ComfyUI; nothing reached the install's GPU or AI helper.
    expect(fake.log.filter((e) => e.path === "/prompt").length).toBe(3);
    expect(reached()).toEqual([]);
    const out = getGeneration(frames[2])!.outputs[0];
    expect(out.url).toMatch(/^\/api\/files\/outputs\//);
    expect((db().prepare("SELECT account_id FROM assets WHERE id = ?").get(out.assetId) as { account_id: string }).account_id).toBe(a);
    // It reopens the board from its own runs, and opens (and downloads) each frame.
    expect(mine("a").map((g) => g.id)).toEqual(expect.arrayContaining(frames));
    expect(passed(viaProxy(out.url, "GET", "a"))).toBe(true);
    expect(passed(viaProxy(`/api/generations/${frames[0]}`, "GET", "a"))).toBe(true);
  });

  it("a second click with the same request id gets the same board", async () => {
    const n = rows();
    const r = await board({ engine: "open", scenes: SCENES, references: [ref], aspectRatio: "16:9", requestId: "board-request-1" }, "a");
    expect(r.status).toBe(201);
    expect(((await r.json()) as { batchId: string }).batchId).toBe(batch);
    expect(rows()).toBe(n);
  });

  it("splits a story without the install's AI helper", async () => {
    // The owner's split asks the install's own model.
    fetched.length = 0;
    expect(await splitStory("a heist on a night train", 3)).toEqual(LLM_SCENES);
    expect(fetched).toContain("POST http://owner-llm.test:11434/api/chat");
    // An account's board is split offline: the same shot list, and nothing reaches the install's AI helper.
    fetched.length = 0;
    const story = "A model in a silver coat crosses a night market, then steps onto a rooftop";
    const r = await board({ engine: "open", story, frames: 3, aspectRatio: "16:9" }, "a");
    expect(r.status, await r.clone().text()).toBe(201);
    const body = (await r.json()) as { scenes: string[]; items: { id: string }[] };
    expect(body.scenes).toEqual(heuristicScenes(story, 3));
    expect(reached()).toEqual([]);
    // Named after the idea it was made from.
    expect((getGeneration(body.items[0].id)!.request as { batchTitle?: string }).batchTitle).toBe(story);
    for (const g of body.items) await settle(g.id);
  });

  it("makes the board's film: every shot and the join are its own, on its ComfyUI", async () => {
    fake.opts.output = "video";
    fake.log.length = 0;
    fetched.length = 0;
    const r = await film(batch, { requestId: "film-request-1" }, "a");
    expect(r.status, await r.clone().text()).toBe(201);
    const body = (await r.json()) as { batchId: string; items: { id: string; op: string }[] };
    expect(body.batchId).toBe(`${batch}-film`);
    const join = body.items[0];
    expect(join.op).toBe("concat");
    expect(body.items).toHaveLength(4);
    for (const g of body.items) expect(getGeneration(g.id)!.request.account, g.id).toBe(a);
    const done = await settle(join.id);
    expect(done?.status, done?.error ?? "").toBe("succeeded");
    for (const g of body.items) expect(getGeneration(g.id)!.status, g.id).toBe("succeeded");
    expect(fake.log.filter((e) => e.path === "/prompt").length).toBe(body.items.length);
    expect(reached()).toEqual([]);
    const out = done!.outputs[0];
    expect((db().prepare("SELECT account_id FROM assets WHERE id = ?").get(out.assetId) as { account_id: string }).account_id).toBe(a);
    expect(passed(viaProxy(out.url, "GET", "a"))).toBe(true);
    expect(mine("a").map((g) => g.id)).toContain(join.id);
    // The same click again: the same film.
    const again = await film(batch, { requestId: "film-request-1" }, "a");
    expect(((await again.json()) as { items: { id: string }[] }).items[0].id).toBe(join.id);
    fake.opts.output = "image";
  });

  it("another account never sees, opens, films or reuses its boards", async () => {
    const out = getGeneration(frames[0])!.outputs[0].url;
    expect(viaProxy(`/api/generations/${frames[0]}`, "GET", "b").status).toBe(403);
    expect(viaProxy(`/api/generations/${frames[0]}`, "DELETE", "b").status).toBe(403);
    expect(viaProxy(out, "GET", "b").status).toBe(403);
    expect(viaProxy(out, "GET").status).toBe(401);
    expect(mine("b")).toEqual([]);
    // A film of A's board: not found for B, the same as a board that doesn't exist, and nothing is made.
    const n = rows();
    for (const id of [batch, "no-such-board"]) {
      const r = await filmRoute.POST(json(`/api/storyboards/${id}/film`, "POST", {}, "b"), { params: Promise.resolve({ id }) });
      expect(r.status, id).toBe(404);
      expect((await r.json()).error).toBe("We can't find that storyboard.");
    }
    expect(rows()).toBe(n);
    // A's picture as B's look reference: refused before anything is planned or sent.
    fake.log.length = 0;
    const r = await boardsRoute.POST(json("/api/storyboards", "POST", { engine: "open", scenes: SCENES, references: [ref] }, "b"));
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe("input-not-yours");
    expect(fake.log.some((e) => e.path === "/prompt")).toBe(false);
    // A's frame as B's reference: the same.
    const frame = await boardsRoute.POST(json("/api/storyboards", "POST", { engine: "open", scenes: SCENES, references: [out] }, "b"));
    expect(frame.status).toBe(403);
    // The same request id from B is B's own board, never A's.
    const own = await upload("b", TINY_PNG, "image/png", "b.png");
    const bRun = await board({ engine: "open", scenes: SCENES.slice(0, 2), references: [own], requestId: "board-request-1" }, "b");
    expect(bRun.status, await bRun.clone().text()).toBe(201);
    const bBody = (await bRun.json()) as { batchId: string; items: { id: string }[] };
    expect(bBody.batchId).not.toBe(batch);
    for (const g of bBody.items) expect(getGeneration(g.id)!.request.account).toBe(b);
    for (const g of bBody.items) await settle(g.id);
    expect(mine("a").some((g) => g.batchId === bBody.batchId)).toBe(false);
  });

  it("the owner's storyboards and files are never reachable", async () => {
    const ownerPic = saveFile({ data: TINY_PNG, contentType: "image/png", source: "upload", name: "owner.png" }).url;
    const t = Date.now();
    const add = db().prepare(
      "INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, batch_id, request_json, outputs_json, created_at, updated_at) VALUES (?, 'storyboard', 'oss-qwen-image-21', 'open', 'comfyui', 't2i', 'image', 'succeeded', 'owner-board', ?, ?, ?, ?)",
    );
    for (const i of [0, 1]) add.run(`owner-frame-${i}`, JSON.stringify({ feature: "storyboard", modelId: "oss-qwen-image-21", frame: { scene: `owner scene ${i}`, index: i, of: 2 } }), JSON.stringify([{ url: ownerPic, kind: "image" }]), t + i, t + i);
    // Not in its list, closed through the proxy, and its film is not found (nothing is made).
    expect(mine("a").map((g) => g.id)).not.toContain("owner-frame-0");
    expect(viaProxy("/api/generations/owner-frame-0", "GET", "a").status).toBe(403);
    expect(viaProxy(ownerPic, "GET", "a").status).toBe(403);
    const n = rows();
    const r = await filmRoute.POST(json("/api/storyboards/owner-board/film", "POST", {}, "a"), { params: Promise.resolve({ id: "owner-board" }) });
    expect(r.status).toBe(404);
    expect(rows()).toBe(n);
    // The owner's picture as its look reference: refused like any file that isn't its own; a link never goes in.
    const reuse = await boardsRoute.POST(json("/api/storyboards", "POST", { engine: "open", scenes: SCENES, references: [ownerPic] }, "a"));
    expect(reuse.status).toBe(403);
    expect((await reuse.json()).code).toBe("input-not-yours");
    const link = await boardsRoute.POST(json("/api/storyboards", "POST", { engine: "open", scenes: SCENES, references: ["https://example.com/a.png"] }, "a"));
    expect(link.status).toBe(400);
  });

  it("asks an account with neither a GPU nor a key to connect one, before anything is made", async () => {
    const n = rows();
    const r = await boardsRoute.POST(json("/api/storyboards", "POST", { engine: "open", scenes: SCENES }, "c"));
    expect(r.status).toBe(403);
    expect(r.headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
    expect((await r.json()).code).toBe("connect-gpu");
    expect(rows()).toBe(n);
  });

  it("keeps the account's limits: runs going at once, and a body over what a run may weigh", async () => {
    const now = Date.now();
    const add = db().prepare(
      "INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, outputs_json, created_at, updated_at) VALUES (?, 'storyboard', 'oss-qwen-image-21', 'open', 'comfyui', 't2i', 'image', 'queued', ?, '[]', ?, ?)",
    );
    for (let i = 0; i < ACCOUNT_LIMITS.activeRuns; i++) add.run(`busy-${i}`, JSON.stringify({ feature: "storyboard", modelId: "oss-qwen-image-21", account: a }), now, now);
    for (const call of [
      () => boardsRoute.POST(json("/api/storyboards", "POST", { engine: "open", scenes: SCENES }, "a")),
      () => filmRoute.POST(json(`/api/storyboards/${batch}/film`, "POST", {}, "a"), { params: Promise.resolve({ id: batch }) }),
    ]) {
      const r = await call();
      expect(r.status).toBe(429);
      expect((await r.json()).code).toBe(access.ACTIVE_RUNS_CODE);
    }
    db().prepare("DELETE FROM generations WHERE id LIKE 'busy-%'").run();
    const big = new Request("http://localhost:3000/api/storyboards", { method: "POST", headers: { host: "localhost:3000", cookie: cookies.a, "content-type": "application/json", "content-length": String(ACCOUNT_LIMITS.runBodyBytes + 1) }, body: "{}" });
    expect((await boardsRoute.POST(big)).status).toBe(413);
  });

  it("offers One sheet to an account only once its GPU test is recorded", async () => {
    const body = { engine: "open", sheet: true, scenes: SCENES, aspectRatio: "16:9" };
    const priced = await estimateRoute.POST(json("/api/storyboards/estimate", "POST", body, "a"));
    const n = rows();
    const r = await board(body, "a");
    if (ONE_SHEET_GPU_TEST) {
      expect(priced.status).toBe(200);
      expect(r.status, await r.clone().text()).toBe(201);
      // One picture with every panel, its own, drawn on its own ComfyUI.
      const { items } = (await r.json()) as { items: { id: string }[] };
      expect(items).toHaveLength(1);
      const g = getGeneration(items[0].id)!;
      expect(g.request.account).toBe(a);
      expect(g.request.frame?.sheet?.panels).toHaveLength(3);
      const done = await settle(g.id);
      expect(done?.status, done?.error ?? "").toBe("succeeded");
      expect(done!.provider).toBe("comfyui");
    } else {
      expect(priced.status).toBe(422);
      expect(r.status).toBe(422);
      expect((await r.json()).error).toMatch(/One sheet isn't available yet/);
      expect(rows()).toBe(n);
      // The owner's price check still has it.
      const owner = await estimateRoute.POST(json("/api/storyboards/estimate", "POST", body, "owner"));
      expect(owner.status, await owner.clone().text()).toBe(200);
    }
  });
});
