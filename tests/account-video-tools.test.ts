import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { startFakeComfy, TINY_PNG, type FakeComfy } from "./helpers/fake-comfy-runner";
import { tempDir } from "./helpers/temp-dir";

vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

/**
 * Video tools for a signed-in account (public sign-up): Remove object (and Remove a person), Evolution, Mixed Media,
 * Turnaround video, Fly around and Katana run on the account's own ComfyUI (a stand-in here) through the same generations
 * every studio run makes, with only its own files, and their runs (and Katana's jobs) stay its own. A guest gets the
 * sign-up card; another account, the owner's library, the studio's ComfyUI and its AI helper are never reached.
 */
const dir = tempDir("fuobe-account-video-tools-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://owner-comfy.test:8188";
process.env.OLLAMA_URL = "http://owner-llm.test:11434";
process.env.FUOBE_PUBLIC_SIGNUP = "1";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_ALLOW_PRIVATE_URLS;
delete process.env.FUOBE_HOSTED_RUNS;
globalThis.__fuobeTestDiskFree = 1e13;

// Plain fetch is the install's own ComfyUI, its LLM or anything else: recorded, so a test sees that nothing reached them.
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

const auth = await import("@/server/auth");
const removeRoute = await import("@/app/api/remove-object/route");
const removePreviewRoute = await import("@/app/api/remove-object/preview/route");
const rerollRoute = await import("@/app/api/remove-object/reroll/route");
const removeEstimateRoute = await import("@/app/api/remove-object/estimate/route");
const evolutionRoute = await import("@/app/api/evolution/route");
const directionRoute = await import("@/app/api/evolution/direction/route");
const evolutionEstimateRoute = await import("@/app/api/evolution/estimate/route");
const mixedRoute = await import("@/app/api/mixed-media/route");
const mixedPreviewRoute = await import("@/app/api/mixed-media/preview/route");
const mixedRetryRoute = await import("@/app/api/mixed-media/retry/route");
const mixedProgressRoute = await import("@/app/api/mixed-media/progress/route");
const mixedEstimateRoute = await import("@/app/api/mixed-media/estimate/route");
const turnaroundRoute = await import("@/app/api/turnaround/route");
const flyRoute = await import("@/app/api/fly-around/route");
const katanaRoute = await import("@/app/api/katana/route");
const katanaOneRoute = await import("@/app/api/katana/[id]/route");
const katanaRetryRoute = await import("@/app/api/katana/[id]/retry/route");
const restoreRoute = await import("@/app/api/restore/route");
const uploadsRoute = await import("@/app/api/uploads/route");
const gpuRoute = await import("@/app/api/account/gpu/route");
const { proxy } = await import("@/proxy");
const access = await import("@/lib/guest-access");
const { getGeneration } = await import("@/server/generations");
const { db } = await import("@/server/db");
const { resetRates } = await import("@/server/rate");
const { clearAccountLoras } = await import("@/server/account-loras");
const { saveFile } = await import("@/server/storage");
const { runAsTenant } = await import("@/server/tenant");
const { ACCOUNT_LIMITS } = await import("@/server/account-files");
const { listAccountProjects } = await import("@/server/account-projects");
const { listKatana } = await import("@/server/katana");
const { purgeAccount } = await import("@/server/account-sweep");
const { setSetting } = await import("@/server/settings");
const { saveAccountKey } = await import("@/server/account-keys");
const { RESTORE_ON_YOUR_GPU } = await import("@/server/restore");

const CLIP = fs.readFileSync(path.join(__dirname, "fixtures/shorts-12s.mp4"));
const src = { duration: 12, fps: 16, width: 72, height: 128, hasAudio: true };

let fake: FakeComfy;
let a = "";
let b = "";
let c = "";
const cookies: Record<string, string> = {};
beforeAll(async () => {
  fake = await startFakeComfy({ loras: [], delayMs: 0 });
  globalThis.__fuobeTestGpuPort = fake.port;
  auth.setPassword("install password");
  // The owner's AI helper is set up: an account's run must still never use it.
  setSetting("enhanceProvider", "ollama");
  for (const [k, email] of [
    ["a", "video-a@example.com"],
    ["b", "video-b@example.com"],
    ["c", "video-c@example.com"],
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
  db().prepare("UPDATE generations SET status = 'canceled' WHERE status IN ('queued', 'running') AND json_extract(request_json, '$.account') IS NOT NULL").run();
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
const del = (url: string, who?: string) => new Request(`http://localhost:3000${url}`, { method: "DELETE", headers: { host: "localhost:3000", ...(who && { cookie: cookies[who] }) } });
const params = <T,>(p: T) => ({ params: Promise.resolve(p) }) as never;

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

/**
 * What the studio reads of its own ComfyUI and AI helper to say whether they answer (their status, read by every run's
 * model switches): never a job or a call to them.
 */
const notStatus = (u: string) => !/\/(system_stats|api\/tags)$/.test(u);

type Run = { final: { id: string }; items: { id: string; batchId: string | null }[] };

/** Send a run; a LoRA its ComfyUI lacks is put there (the 409 names it), then it is sent again. */
async function start(send: () => Promise<Response>): Promise<Response> {
  let r = await send();
  if (r.status === 409) {
    const j = (await r.clone().json()) as { code: string; fix?: { items: { file: string }[] } };
    if (j.code === "comfy_missing_model" && j.fix) {
      fake.opts.loras = [...(fake.opts.loras ?? []), ...j.fix.items.map((i) => i.file)];
      for (const id of [a, b]) clearAccountLoras(id);
      r = await send();
    }
  }
  return r;
}

/**
 * The run is the account's from end to end: one batch, every step stamped as its own and sent to its own ComfyUI,
 * nothing reaching the studio's ComfyUI or its AI helper, and the result is its own file it can open.
 */
async function ranAsOwn(r: Response, who: "a" | "b", account: string): Promise<string> {
  expect(r.status, await r.clone().text()).toBe(201);
  const body = (await r.json()) as Run;
  const final = body.final.id;
  expect(new Set(body.items.map((g) => g.batchId)).size).toBe(1);
  const batch = body.items[0].batchId;
  const steps = (db().prepare("SELECT id FROM generations WHERE batch_id IS ?").all(batch) as { id: string }[]).map((x) => x.id);
  for (const id of steps) {
    const g = getGeneration(id)!;
    expect(g.request.account, id).toBe(account);
    expect(g.provider, id).toBe("comfyui");
  }
  const done = await settle(final);
  const why = steps.map((id) => getGeneration(id)!).map((g) => `${g.modelId} ${g.op} ${g.status} ${g.error ?? ""}`).join(" | ");
  expect(done?.status, why).toBe("succeeded");
  for (const id of steps) expect(getGeneration(id)!.status, id).toBe("succeeded");
  // Every step went to its own ComfyUI; nothing reached the install's ComfyUI or AI helper.
  expect(fake.log.filter((e) => e.path === "/prompt").length).toBeGreaterThanOrEqual(1);
  expect(fetched.filter(notStatus), why).toEqual([]);
  const out = done!.outputs[0];
  expect(out.url).toMatch(/^\/api\/files\/outputs\//);
  expect((db().prepare("SELECT account_id FROM assets WHERE id = ?").get(out.assetId) as { account_id: string }).account_id).toBe(account);
  expect(passed(viaProxy(out.url, "GET", who))).toBe(true);
  expect(passed(viaProxy(`/api/generations/${final}`, "GET", who))).toBe(true);
  return final;
}

const RUNS = [
  "/api/remove-object",
  "/api/remove-object/preview",
  "/api/remove-object/reroll",
  "/api/evolution",
  "/api/evolution/direction",
  "/api/mixed-media",
  "/api/mixed-media/preview",
  "/api/mixed-media/retry",
  "/api/turnaround",
  "/api/fly-around",
  "/api/katana",
  "/api/katana/k1/retry",
  "/api/restore",
];

describe("the proxy opens the video tools to accounts, and keeps the sign-up card for guests", () => {
  it("a guest gets the sign-up card on every run; price checks stay open", async () => {
    for (const p of RUNS) {
      const r = viaProxy(p, "POST");
      expect(r.status, p).toBe(401);
      expect(r.headers.get(access.GUEST_HEADER), p).toBe("1");
      expect((await r.json()).error, p).toBe(access.GUEST_RUN_MESSAGE);
    }
    for (const p of ["/api/remove-object/estimate", "/api/evolution/estimate", "/api/mixed-media/estimate", "/api/turnaround/estimate", "/api/turnaround?preview=1", "/api/fly-around?preview=1", "/api/katana?preview=1"]) {
      expect(passed(viaProxy(p, "POST")), p).toBe(true);
    }
    // Its Katana list is empty; one run, forgetting one and a render's progress are closed.
    const list = viaProxy("/api/katana", "GET");
    expect(await list.json()).toEqual({ items: [] });
    expect(viaProxy("/api/katana/k1", "GET").status).toBe(401);
    expect(viaProxy("/api/katana/k1", "DELETE").status).toBe(401);
    expect(viaProxy("/api/mixed-media/progress?id=x", "GET").status).toBe(401);
  });

  it("an account with its own GPU reaches every route; one with neither a GPU nor a key is asked to connect one", async () => {
    for (const p of RUNS) {
      expect(passed(viaProxy(p, "POST", "a")), p).toBe(true);
      if (p === "/api/katana") continue;
      const r = viaProxy(p, "POST", "c");
      expect(r.status, p).toBe(403);
      expect(r.headers.get(access.CONNECT_GPU_HEADER), p).toBe("1");
      expect((await r.json()).code, p).toBe("connect-gpu");
    }
    // Katana's list, one run and forgetting one are its own (the routes answer with its own only).
    for (const [p, m] of [
      ["/api/katana", "GET"],
      ["/api/katana/k1", "GET"],
      ["/api/katana/k1", "DELETE"],
      ["/api/mixed-media/progress", "GET"],
    ] as const) {
      expect(passed(viaProxy(p, m, "a")), `${m} ${p}`).toBe(true);
      expect(passed(viaProxy(p, m, "c")), `${m} ${p}`).toBe(true);
    }
  });

  it("the routes refuse a guest themselves", async () => {
    for (const [route, p] of [
      [removeRoute, "/api/remove-object"],
      [removePreviewRoute, "/api/remove-object/preview"],
      [rerollRoute, "/api/remove-object/reroll"],
      [evolutionRoute, "/api/evolution"],
      [directionRoute, "/api/evolution/direction"],
      [mixedRoute, "/api/mixed-media"],
      [mixedPreviewRoute, "/api/mixed-media/preview"],
      [mixedRetryRoute, "/api/mixed-media/retry"],
      [turnaroundRoute, "/api/turnaround"],
      [flyRoute, "/api/fly-around"],
      [katanaRoute, "/api/katana"],
      [restoreRoute, "/api/restore"],
    ] as const) {
      const r = await route.POST(json(p, "POST", {}));
      expect(r.status, p).toBe(401);
      expect(r.headers.get(access.GUEST_HEADER), p).toBe("1");
    }
    const retry = await katanaRetryRoute.POST(json("/api/katana/k1/retry", "POST", {}), params({ id: "k1" }));
    expect(retry.status).toBe(401);
  });
});

describe("an account runs the video tools on its own ComfyUI", () => {
  let clip = "";
  let pic = "";
  let back = "";
  beforeAll(async () => {
    clip = await upload("a", CLIP, "video/mp4", "skate.mp4");
    pic = await upload("a", TINY_PNG, "image/png", "me.png");
    back = await upload("a", TINY_PNG, "image/png", "back.png");
  });
  beforeEach(() => {
    fake.log.length = 0;
    fetched.length = 0;
    // Every step answers a clip and a picture (a cut keeps its first frame): each chained slot finds its kind.
    fake.opts.output = "both";
  });

  const removal = (over: Record<string, unknown> = {}) => ({ engine: "open", mode: "type", prompt: "the skateboard", source: { url: clip, name: "skate.mp4", ...src }, range: { start: 0, end: 3 }, ...over });

  it("prices each tool for its own GPU, never as a demo", async () => {
    const r = await removeEstimateRoute.POST(json("/api/remove-object/estimate", "POST", removal(), "a"));
    expect(r.status, await r.clone().text()).toBe(200);
    expect((await r.json()).demo).toBe(false);
    const e = await evolutionEstimateRoute.POST(json("/api/evolution/estimate", "POST", { engine: "open", source: { url: clip, ...src }, range: { start: 0, end: 6 } }, "a"));
    expect(e.status, await e.clone().text()).toBe(200);
    expect((await e.json()).demo).toBe(false);
    const m = await mixedEstimateRoute.POST(json("/api/mixed-media/estimate", "POST", { engine: "open", presetId: "mixed-sketch", source: { url: clip, ...src }, range: { start: 0, end: 1 }, fps: 8, resolution: "1K" }, "a"));
    expect(m.status, await m.clone().text()).toBe(200);
    expect((await m.json()).demo).toBe(false);
  });

  it("removes an object end to end, and a second click with the same request id gets the same run", async () => {
    const r = await start(() => removeRoute.POST(json("/api/remove-object", "POST", removal({ requestId: "remove-same-1" }), "a")));
    const final = await ranAsOwn(r, "a", a);
    const again = await removeRoute.POST(json("/api/remove-object", "POST", removal({ requestId: "remove-same-1" }), "a"));
    expect(again.status).toBe(201);
    expect(((await again.json()) as Run).final.id).toBe(final);
    // Its history lists it (GET /api/generations is its own runs).
    expect(passed(viaProxy("/api/generations?features=remove-object", "GET", "a"))).toBe(true);
    // "Redo from here" takes only its own removal: B's and the owner's ask read as not found.
    for (const who of ["b", "owner"] as const) {
      const other = await rerollRoute.POST(json("/api/remove-object/reroll", "POST", { id: final, window: 0 }, who));
      expect(other.status, who).toBe(404);
    }
    const own = await rerollRoute.POST(json("/api/remove-object/reroll", "POST", { id: final, window: 0 }, "a"));
    expect(own.status).toBe(422);
    expect((await own.json()).error).toMatch(/H3 person removal/);
  });

  it("evolves a clip end to end with Fuobe's offline writer, never the studio's AI helper", async () => {
    const d = await directionRoute.POST(json("/api/evolution/direction", "POST", { engine: "open", intensity: "medium", idea: "paper cut", references: [pic] }, "a"));
    expect(d.status, await d.clone().text()).toBe(200);
    const said = (await d.json()) as { by: string; why?: string; direction: string };
    expect(said.by).toBe("offline");
    expect(said.why).toBeUndefined();
    expect(said.direction.length).toBeGreaterThan(10);
    const r = await start(() => evolutionRoute.POST(json("/api/evolution", "POST", { engine: "open", source: { url: clip, ...src }, range: { start: 0, end: 6 }, references: [pic] }, "a")));
    const body = (await r.clone().json()) as { by: string };
    expect(body.by).toBe("offline");
    await ranAsOwn(r, "a", a);
  });

  it("renders Mixed Media end to end; its retry and progress take only its own render", async () => {
    const body = { engine: "open", presetId: "mixed-sketch", source: { url: clip, ...src }, range: { start: 0, end: 1 }, fps: 4, resolution: "1K" };
    const r = await start(() => mixedRoute.POST(json("/api/mixed-media", "POST", body, "a")));
    const final = await ranAsOwn(r, "a", a);
    const progress = await mixedProgressRoute.GET(get(`/api/mixed-media/progress?id=${final}`, "a"));
    expect(progress.status).toBe(200);
    for (const who of ["b", "owner"] as const) {
      expect((await mixedProgressRoute.GET(get(`/api/mixed-media/progress?id=${final}`, who))).status, who).toBe(404);
      expect((await mixedRetryRoute.POST(json("/api/mixed-media/retry", "POST", { id: final }, who))).status, who).toBe(404);
    }
    // Its own render runs again on its own ComfyUI.
    const again = await start(() => mixedRetryRoute.POST(json("/api/mixed-media/retry", "POST", { id: final }, "a")));
    expect(again.status, await again.clone().text()).toBe(201);
    const made = (await again.json()) as Run;
    for (const g of made.items) expect(getGeneration(g.id)!.request.account).toBe(a);
    // A preview frame is its own too.
    const p = await start(() => mixedPreviewRoute.POST(json("/api/mixed-media/preview", "POST", body, "a")));
    expect(p.status, await p.clone().text()).toBe(201);
    expect(getGeneration(((await p.json()) as { id: string }).id)!.request.account).toBe(a);
    // In the Trash, the render is still its own alone: another account and the owner read it as gone.
    db().prepare("INSERT OR IGNORE INTO generation_trash (generation_id, deleted_at) VALUES (?, ?)").run(final, Date.now());
    expect(getGeneration(final)).toBeNull();
    for (const who of ["b", "owner"] as const) {
      const res = await mixedProgressRoute.GET(get(`/api/mixed-media/progress?id=${final}`, who));
      expect(res.status, who).toBe(404);
      expect(await res.json()).toEqual({ error: "This render no longer exists" });
    }
    expect((await mixedProgressRoute.GET(get(`/api/mixed-media/progress?id=${final}`, "a"))).status).toBe(200);
  });

  it("films a turnaround and a fly around end to end, never asking the studio's WorldCast worker", async () => {
    const t = await start(() => turnaroundRoute.POST(json("/api/turnaround", "POST", { engine: "open", views: { front: pic, back }, name: "Ada" }, "a")));
    await ranAsOwn(t, "a", a);
    // A character from the owner's library is never found for an account.
    const el = await turnaroundRoute.POST(json("/api/turnaround", "POST", { engine: "open", views: { front: pic }, elementId: "owner-character" }, "a"));
    expect(el.status).toBe(404);
    fake.log.length = 0;
    const render = await upload("a", CLIP, "video/mp4", "orbit.mp4");
    const f = await start(() => flyRoute.POST(json("/api/fly-around", "POST", { engine: "open", image: pic, render, orbit: { degrees: 90, direction: "cw" }, feature: "model3d-film", title: "Photoreal orbit" }, "a")));
    await ranAsOwn(f, "a", a);
  });

  it("recreates an edit with Katana end to end; its jobs are its own projects", async () => {
    const body = { engine: "open", reference: clip, photos: [pic], segments: [{ start: 0, end: 3 }], duration: 12, title: "My edit" };
    const r = await start(() => katanaRoute.POST(json("/api/katana", "POST", body, "a")));
    expect(r.status, await r.clone().text()).toBe(201);
    const job = (await r.json()) as { id: string; steps: Record<string, string>; final: string };
    const final = job.steps[job.final];
    for (const id of Object.values(job.steps)) expect(getGeneration(id)!.request.account).toBe(a);
    const done = await settle(final);
    const why = Object.values(job.steps).map((id) => getGeneration(id)!).map((g) => `${g.modelId} ${g.op} ${g.status} ${g.error ?? ""}`).join(" | ");
    expect(done?.status, why).toBe("succeeded");
    expect(fetched.filter(notStatus)).toEqual([]);
    // Its list and the job are its own; B and the owner never see it.
    const mine = (await (await katanaRoute.GET(get("/api/katana", "a"))).json()) as { items: { id: string }[] };
    expect(mine.items.map((j) => j.id)).toEqual([job.id]);
    expect((await katanaOneRoute.GET(get(`/api/katana/${job.id}`, "a"), params({ id: job.id }))).status).toBe(200);
    const theirs = (await (await katanaRoute.GET(get("/api/katana", "b"))).json()) as { items: unknown[] };
    expect(theirs.items).toEqual([]);
    expect(listKatana().map((j) => j.id)).not.toContain(job.id);
    expect((await katanaOneRoute.GET(get(`/api/katana/${job.id}`, "b"), params({ id: job.id }))).status).toBe(404);
    expect((await katanaOneRoute.GET(get(`/api/katana/${job.id}`, "owner"), params({ id: job.id }))).status).toBe(404);
    expect((await katanaOneRoute.DELETE(del(`/api/katana/${job.id}`, "b"), params({ id: job.id }))).status).toBe(404);
    expect((await katanaRetryRoute.POST(json(`/api/katana/${job.id}/retry?all=1`, "POST", {}, "b"), params({ id: job.id }))).status).toBe(404);
    // The owner's job is never in reach of an account.
    const t = Date.now();
    db().prepare("INSERT INTO katana_jobs (id, data_json, created_at, updated_at) VALUES ('owner-job', ?, ?, ?)").run(JSON.stringify({ title: "Owner", steps: {}, segments: [], photos: [] }), t, t);
    expect((await katanaOneRoute.GET(get("/api/katana/owner-job", "a"), params({ id: "owner-job" }))).status).toBe(404);
    expect((await katanaOneRoute.DELETE(del("/api/katana/owner-job", "a"), params({ id: "owner-job" }))).status).toBe(404);
    expect((db().prepare("SELECT COUNT(*) AS n FROM katana_jobs WHERE id = 'owner-job'").get() as { n: number }).n).toBe(1);
    // Run again: a new job of its own, on its own ComfyUI.
    const again = await start(() => katanaRetryRoute.POST(json(`/api/katana/${job.id}/retry?all=1`, "POST", {}, "a"), params({ id: job.id })));
    expect(again.status, await again.clone().text()).toBe(201);
    const second = (await again.json()) as { id: string; steps: Record<string, string> };
    expect(second.id).not.toBe(job.id);
    for (const id of Object.values(second.steps)) expect(getGeneration(id)!.request.account).toBe(a);
    // Forgetting one is its own: gone from its list.
    expect((await katanaOneRoute.DELETE(del(`/api/katana/${job.id}`, "a"), params({ id: job.id }))).status).toBe(204);
    expect(listAccountProjects(a, "katana").map((p) => p.id)).toEqual([second.id]);
  });

  it("another account's files, the owner's files and links never go in", async () => {
    const own = await upload("b", TINY_PNG, "image/png", "b.png");
    const ownerClip = saveFile({ data: CLIP, contentType: "video/mp4", source: "upload", name: "owner.mp4" }).url;
    const tries: [string, () => Promise<Response>][] = [
      ["remove", () => removeRoute.POST(json("/api/remove-object", "POST", removal(), "b"))],
      ["evolution", () => evolutionRoute.POST(json("/api/evolution", "POST", { engine: "open", source: { url: clip, ...src }, references: [own] }, "b"))],
      ["mixed", () => mixedRoute.POST(json("/api/mixed-media", "POST", { engine: "open", presetId: "mixed-sketch", source: { url: clip, ...src }, range: { start: 0, end: 1 }, fps: 4, resolution: "1K" }, "b"))],
      ["turnaround", () => turnaroundRoute.POST(json("/api/turnaround", "POST", { engine: "open", views: { front: pic } }, "b"))],
      ["fly", () => flyRoute.POST(json("/api/fly-around", "POST", { engine: "open", image: pic, orbit: { degrees: 90, direction: "cw" } }, "b"))],
      ["katana", () => katanaRoute.POST(json("/api/katana", "POST", { engine: "open", reference: clip, photos: [own], segments: [{ start: 0, end: 3 }], duration: 12 }, "b"))],
      ["owner's clip", () => removeRoute.POST(json("/api/remove-object", "POST", removal({ source: { url: ownerClip, ...src } }), "a"))],
    ];
    fake.log.length = 0;
    for (const [what, send] of tries) {
      const r = await send();
      expect(r.status, what).toBe(403);
      expect((await r.json()).code, what).toBe("input-not-yours");
    }
    expect(fake.log.some((e) => e.path === "/prompt")).toBe(false);
    const link = await removeRoute.POST(json("/api/remove-object", "POST", removal({ source: { url: "https://example.com/a.mp4" } }), "a"));
    expect(link.status).toBe(400);
  });

  it("asks an account with neither a GPU nor a key to connect one, before anything is made", async () => {
    const own = runAsTenant({ kind: "account", id: c }, () => saveFile({ data: CLIP, contentType: "video/mp4", source: "upload", name: "c.mp4" }).url);
    const pc = runAsTenant({ kind: "account", id: c }, () => saveFile({ data: TINY_PNG, contentType: "image/png", source: "upload", name: "c.png" }).url);
    const n = (db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n;
    for (const send of [
      () => removeRoute.POST(json("/api/remove-object", "POST", removal({ source: { url: own, ...src } }), "c")),
      () => evolutionRoute.POST(json("/api/evolution", "POST", { engine: "open", source: { url: own, ...src }, range: { start: 0, end: 6 }, direction: "A paper world." }, "c")),
      () => katanaRoute.POST(json("/api/katana", "POST", { engine: "open", reference: own, photos: [pc], segments: [{ start: 0, end: 3 }], duration: 12 }, "c")),
      () => flyRoute.POST(json("/api/fly-around", "POST", { engine: "open", image: pc, render: own, orbit: { degrees: 90, direction: "cw" } }, "c")),
    ]) {
      const r = await send();
      expect(r.status, await r.clone().text()).toBe(403);
      expect(r.headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
      expect((await r.json()).code).toBe("connect-gpu");
    }
    expect((db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n).toBe(n);
    expect(listAccountProjects(c, "katana")).toEqual([]);
  });

  it("keeps the account's limits: runs going at once, and a body over what a run may weigh", async () => {
    const now = Date.now();
    const add = db().prepare(
      "INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, outputs_json, created_at, updated_at) VALUES (?, 'remove-object', 'oss-trim', 'open', 'comfyui', 'trim', 'video', 'queued', ?, '[]', ?, ?)",
    );
    for (let i = 0; i < ACCOUNT_LIMITS.activeRuns; i++) add.run(`busy-${i}`, JSON.stringify({ feature: "remove-object", modelId: "oss-trim", account: a }), now, now);
    for (const send of [
      () => removeRoute.POST(json("/api/remove-object", "POST", removal(), "a")),
      () => katanaRoute.POST(json("/api/katana", "POST", { engine: "open", reference: clip, photos: [pic], segments: [{ start: 0, end: 3 }], duration: 12 }, "a")),
      () => flyRoute.POST(json("/api/fly-around", "POST", { engine: "open", image: pic, orbit: { degrees: 90, direction: "cw" } }, "a")),
    ]) {
      const r = await send();
      expect(r.status).toBe(429);
      expect((await r.json()).code).toBe(access.ACTIVE_RUNS_CODE);
    }
    db().prepare("DELETE FROM generations WHERE id LIKE 'busy-%'").run();
    const big = (p: string) =>
      new Request(`http://localhost:3000${p}`, { method: "POST", headers: { host: "localhost:3000", cookie: cookies.a, "content-type": "application/json", "content-length": String(ACCOUNT_LIMITS.runBodyBytes + 1) }, body: "{}" });
    for (const [route, p] of [
      [removeRoute, "/api/remove-object"],
      [evolutionRoute, "/api/evolution"],
      [mixedRoute, "/api/mixed-media"],
      [turnaroundRoute, "/api/turnaround"],
      [flyRoute, "/api/fly-around"],
      [katanaRoute, "/api/katana"],
    ] as const) {
      expect((await route.POST(big(p))).status, p).toBe(413);
    }
  });

  it("Restore & colourise runs on the account's own ComfyUI, its words from Fuobe's template (never the AI helper)", async () => {
    const r = await start(() => restoreRoute.POST(json("/api/restore", "POST", { engine: "open", source: { url: clip, name: "skate.mp4", ...src } }, "a")));
    const body = (await r.clone().json()) as { by?: string; prompt?: string };
    expect(body.by).toBe("offline");
    expect(body.prompt).toBeTruthy();
    await ranAsOwn(r, "a", a);
    // Another account's clip is refused; one with neither a GPU nor a key is asked to connect one.
    const theirs = await restoreRoute.POST(json("/api/restore", "POST", { engine: "open", source: { url: clip, ...src } }, "b"));
    expect(theirs.status).toBe(403);
    const none = await restoreRoute.POST(json("/api/restore", "POST", { engine: "open", source: { url: clip, ...src } }, "c"));
    expect([403, 404]).toContain(none.status);
    expect((await none.json()).code).not.toBe("own-gpu-tool");
  });

  it("keeps an account's Restore on its own GPU: a cloud run on its key answers before anything starts, whatever the install holds", async () => {
    // A key-only account (its own fal.ai key, no GPU), with the owner's Hugging Face token set: the gated Restore
    // IC-LoRA is in the install's reach, and still never goes with an account's key.
    const k = auth.createAccount("video-k@example.com", "long enough").id;
    cookies.k = `${auth.SESSION_COOKIE}=${auth.createSession(k).value}`;
    saveAccountKey(k, "fal", "acct-fal-k-key:secret-k");
    const kClip = await upload("k", CLIP, "video/mp4", "old-film.mp4");
    setSetting("huggingfaceDownloadToken", "hf_owner_token_for_this_test");
    try {
      const cloud = await restoreRoute.POST(json("/api/restore", "POST", { engine: "cloud", source: { url: kClip, name: "old-film.mp4", ...src } }, "k"));
      expect(cloud.status, await cloud.clone().text()).toBe(422);
      expect((await cloud.json()).error).toBe(RESTORE_ON_YOUR_GPU);
      expect(db().prepare("SELECT COUNT(*) AS n FROM generations WHERE json_extract(request_json, '$.account') = ?").get(k)).toEqual({ n: 0 });
      // On its GPU's engine the same account is asked to connect one (the card), never refused.
      const open = await restoreRoute.POST(json("/api/restore", "POST", { engine: "open", source: { url: kClip, name: "old-film.mp4", ...src } }, "k"));
      expect(open.status).toBe(403);
      expect(open.headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
      expect((await open.json()).code).toBe("connect-gpu");
    } finally {
      setSetting("huggingfaceDownloadToken", "");
    }
  });

  it("an account's Katana runs go with the account", async () => {
    const bClip = await upload("b", CLIP, "video/mp4", "b.mp4");
    const bPic = await upload("b", TINY_PNG, "image/png", "b2.png");
    const r = await start(() => katanaRoute.POST(json("/api/katana", "POST", { engine: "open", reference: bClip, photos: [bPic], segments: [{ start: 0, end: 3 }], duration: 12 }, "b")));
    expect(r.status, await r.clone().text()).toBe(201);
    expect(listAccountProjects(b, "katana")).toHaveLength(1);
    await purgeAccount(b);
    expect(listAccountProjects(b, "katana")).toEqual([]);
  });
});
