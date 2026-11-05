import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { startFakeComfy, TINY_PNG, type FakeComfy } from "./helpers/fake-comfy-runner";
import { tempDir } from "./helpers/temp-dir";

vi.setConfig({ testTimeout: 120_000 });
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

/**
 * Shorts Studio for a signed-in account (public sign-up): its sessions and presets are its own projects, its runs go to
 * its own ComfyUI (a stand-in here) through the same generations every studio run makes, with only its own files. A
 * guest gets the sign-up card; another account's sessions and the owner's are never reached.
 */
const dir = tempDir("fuobe-account-shorts-");
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
  if (url.hostname === "127.0.0.1") return realFetch(input, init);
  fetched.push(url.toString());
  if (url.host !== "owner-comfy.test:8188") return new Response("not stubbed", { status: 599 });
  if (url.pathname === "/system_stats") return Response.json({ system: { comfyui_version: "owner", ram_total: 1 }, devices: [] });
  return Response.json({});
}) as typeof fetch;

const auth = await import("@/server/auth");
const sessionsRoute = await import("@/app/api/shorts/sessions/route");
const sessionRoute = await import("@/app/api/shorts/sessions/[id]/route");
const takeRoute = await import("@/app/api/shorts/sessions/[id]/segments/[index]/route");
const primaryRoute = await import("@/app/api/shorts/sessions/[id]/segments/[index]/primary/route");
const enhanceRoute = await import("@/app/api/shorts/sessions/[id]/segments/[index]/enhance/route");
const stitchRoute = await import("@/app/api/shorts/sessions/[id]/stitch/route");
const estimateRoute = await import("@/app/api/shorts/estimate/route");
const presetsRoute = await import("@/app/api/shorts/presets/route");
const presetRoute = await import("@/app/api/shorts/presets/[id]/route");
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
const store = await import("@/server/account-projects");
const { recordFor } = await import("@/server/records");
const { purgeAccount } = await import("@/server/account-sweep");

const CLIP = fs.readFileSync(path.join(__dirname, "fixtures/shorts-12s.mp4"));

let fake: FakeComfy;
let a = "";
let b = "";
let c = "";
const cookies: Record<string, string> = {};
beforeAll(async () => {
  // Each job answers a clip and a picture: a segment's cut keeps its first frame for the restyle.
  fake = await startFakeComfy({ loras: [], delayMs: 0, output: "both" });
  globalThis.__fuobeTestGpuPort = fake.port;
  auth.setPassword("install password");
  for (const [k, email] of [
    ["a", "shorts-a@example.com"],
    ["b", "shorts-b@example.com"],
    ["c", "shorts-c@example.com"],
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

/** An open-engine short of the first 10 s (two segments) in a built-in look. */
const short = (clip: string, extra: Record<string, unknown> = {}) => ({
  engine: "open",
  presetId: "shorts-claymation",
  source: { url: clip, name: "dance.mp4" },
  range: { start: 0, end: 10 },
  aspectRatio: "9:16",
  language: "auto",
  ...extra,
});

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

const create = (body: unknown, who: string) => run(() => sessionsRoute.POST(json("/api/shorts/sessions", "POST", body, who)));

interface View {
  id: string;
  title: string;
  segments: { primary: string; takes: { look: string }[] }[];
  stitches: { final: string; ids: string[] }[];
  generations: Record<string, { id: string; status: string; outputs: { url: string }[] }>;
}

const read = (id: string, who?: string) => sessionRoute.GET(json(`/api/shorts/sessions/${id}`, "GET", undefined, who), params({ id }));

/** Tick the runner until every run of the session is done (or the time is up). */
async function settle(id: string, who: string, ms = 60_000): Promise<View> {
  const end = Date.now() + ms;
  for (;;) {
    await globalThis.__fuobeRunner?.tick();
    const v = (await (await read(id, who)).json()) as View;
    const ids = [...v.segments.flatMap((s) => s.takes.map((t) => t.look)), ...v.stitches.flatMap((s) => [...s.ids, s.final])];
    const busy = ids.some((g) => ["queued", "running"].includes(getGeneration(g, { includeDeleted: true })?.status ?? ""));
    if (!busy || Date.now() > end) return (await (await read(id, who)).json()) as View;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const accountOf = (gid: string) => getGeneration(gid, { includeDeleted: true })?.request.account;

/** A session the owner made: a row in the owner's own table, with one run of the owner's. */
function ownerSession(): { id: string; gen: string } {
  const t = Date.now();
  const clip = saveFile({ data: CLIP, contentType: "video/mp4", source: "upload", name: "owner.mp4" }).url;
  db()
    .prepare(
      "INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, outputs_json, created_at, updated_at) VALUES ('owner-short-take', 'shorts', 'oss-trim', 'open', 'comfyui', 'trim', 'video', 'succeeded', ?, ?, ?, ?)",
    )
    .run(JSON.stringify({ feature: "shorts", modelId: "oss-trim" }), JSON.stringify([{ url: clip, kind: "video" }]), t, t);
  const seg = { index: 0, start: 0, end: 5, takes: [{ cut: "owner-short-take", look: "owner-short-take", createdAt: t }], primary: "owner-short-take" };
  db()
    .prepare(
      `INSERT INTO shorts_sessions (id, title, engine, batch_id, look_json, source_json, range_json, settings_json, segments_json, stitches_json, created_at, updated_at)
       VALUES ('owner-short', 'The owner''s short', 'open', 'owner-batch', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      JSON.stringify({ presetId: "shorts-claymation", name: "Claymation", look: "claymation" }),
      JSON.stringify({ url: clip, hasAudio: false }),
      JSON.stringify({ start: 0, end: 5 }),
      JSON.stringify({ aspectRatio: "9:16", language: "auto", modelId: "oss-shorts", maxRefs: 0 }),
      JSON.stringify([seg]),
      JSON.stringify([{ ids: [], final: "owner-short-take", clips: ["owner-short-take"], createdAt: t }]),
      t,
      t,
    );
  return { id: "owner-short", gen: "owner-short-take" };
}

describe("the proxy opens Shorts to accounts, and keeps the sign-up card for guests", () => {
  it("a guest gets the sign-up card on every change, an empty History, and nobody's session", async () => {
    for (const [method, p] of [
      ["POST", "/api/shorts/sessions"],
      ["POST", "/api/shorts/sessions/s1/segments/0"],
      ["POST", "/api/shorts/sessions/s1/segments/0/primary"],
      ["POST", "/api/shorts/sessions/s1/segments/0/enhance"],
      ["POST", "/api/shorts/sessions/s1/stitch"],
      ["PATCH", "/api/shorts/sessions/s1"],
      ["DELETE", "/api/shorts/sessions/s1"],
      ["POST", "/api/shorts/presets"],
      ["PATCH", "/api/shorts/presets/p1"],
      ["DELETE", "/api/shorts/presets/p1"],
    ] as const) {
      const r = viaProxy(p, method);
      expect(r.status, `${method} ${p}`).toBe(401);
      expect(r.headers.get(access.GUEST_HEADER), p).toBe("1");
      expect((await r.json()).error).toBe(access.GUEST_RUN_MESSAGE);
    }
    expect(await viaProxy("/api/shorts/sessions").json()).toEqual({ items: [] });
    expect(await viaProxy("/api/shorts/presets").json()).toEqual({ items: [] });
    expect(viaProxy("/api/shorts/sessions/s1").status).toBe(401);
    // The price check stays open to everyone.
    expect(passed(viaProxy("/api/shorts/estimate", "POST"))).toBe(true);
  });

  it("an account reaches its own Shorts routes (the routes scope them), Enhance on its own GPU too", async () => {
    for (const [method, p] of [
      ["GET", "/api/shorts/sessions"],
      ["POST", "/api/shorts/sessions"],
      ["GET", "/api/shorts/sessions/s1"],
      ["PATCH", "/api/shorts/sessions/s1"],
      ["DELETE", "/api/shorts/sessions/s1"],
      ["POST", "/api/shorts/sessions/s1/segments/0"],
      ["POST", "/api/shorts/sessions/s1/segments/0/primary"],
      ["POST", "/api/shorts/sessions/s1/segments/0/enhance"],
      ["POST", "/api/shorts/sessions/s1/stitch"],
      ["GET", "/api/shorts/presets"],
      ["POST", "/api/shorts/presets"],
      ["PATCH", "/api/shorts/presets/p1"],
      ["DELETE", "/api/shorts/presets/p1"],
    ] as const) {
      expect(passed(viaProxy(p, method, "a")), `${method} ${p}`).toBe(true);
    }
  });

  it("the routes refuse a guest themselves; Enhance answers an account with its own session only", async () => {
    const p = { id: "s1", index: "0" };
    for (const [name, r] of [
      ["create", () => sessionsRoute.POST(json("/api/shorts/sessions", "POST", {}))],
      ["take", () => takeRoute.POST(json("/api/shorts/sessions/s1/segments/0", "POST", {}), params(p))],
      ["primary", () => primaryRoute.POST(json("/api/shorts/sessions/s1/segments/0/primary", "POST", {}), params(p))],
      ["stitch", () => stitchRoute.POST(json("/api/shorts/sessions/s1/stitch", "POST", {}), params(p))],
      ["rename", () => sessionRoute.PATCH(json("/api/shorts/sessions/s1", "PATCH", { title: "x" }), params(p))],
      ["delete", () => sessionRoute.DELETE(json("/api/shorts/sessions/s1", "DELETE"), params(p))],
      ["preset", () => presetsRoute.POST(json("/api/shorts/presets", "POST", {}))],
    ] as const) {
      const res = await r();
      expect(res.status, name).toBe(401);
      expect(res.headers.get(access.GUEST_HEADER), name).toBe("1");
    }
    // A guest's reads have nothing of anyone's.
    expect(await (await sessionsRoute.GET(json("/api/shorts/sessions", "GET"))).json()).toEqual({ items: [] });
    expect(await (await presetsRoute.GET(json("/api/shorts/presets", "GET"))).json()).toEqual({ items: [] });
    const guest = await enhanceRoute.POST(json("/api/shorts/sessions/s1/segments/0/enhance", "POST", {}), params(p));
    expect(guest.status).toBe(401);
    expect(guest.headers.get(access.GUEST_HEADER)).toBe("1");
    // An account's Enhance is never the "isn't available" refusal: a session that isn't its own reads as gone.
    const mine = await enhanceRoute.POST(json("/api/shorts/sessions/s1/segments/0/enhance", "POST", {}, "a"), params(p));
    expect(mine.status).toBe(404);
    expect((await mine.json()).code).not.toBe("own-gpu-tool");
  });
});

describe("an account makes, reopens and runs its own shorts on its own ComfyUI", () => {
  let clip = "";
  let id = "";
  let view: View;
  beforeAll(async () => {
    clip = await upload("a", CLIP, "video/mp4", "dance.mp4");
  });

  it("prices it for its own GPU, never as a demo", async () => {
    const r = await estimateRoute.POST(json("/api/shorts/estimate", "POST", short(clip), "a"));
    expect(r.status, await r.clone().text()).toBe(200);
    const e = (await r.json()) as { demo: boolean; segments: number };
    expect(e.demo).toBe(false);
    expect(e.segments).toBe(2);
  });

  it("runs a short end to end: every step is its own, on its ComfyUI, and the video is its own file", async () => {
    fake.log.length = 0;
    fetched.length = 0;
    const r = await create(short(clip, { requestId: "same-shorts-request-1" }), "a");
    expect(r.status, await r.clone().text()).toBe(201);
    id = ((await r.json()) as { id: string }).id;
    view = await settle(id, "a");
    const all = Object.values(view.generations);
    expect(all.length).toBeGreaterThan(2);
    for (const g of all) {
      expect(accountOf(g.id), g.id).toBe(a);
      expect(g.status, `${g.id} ${getGeneration(g.id)?.modelId} ${getGeneration(g.id)?.error ?? ""}`).toBe("succeeded");
    }
    // One run: its steps share a batch.
    expect(new Set(all.map((g) => getGeneration(g.id)!.batchId)).size).toBe(1);
    // Every step went to its own ComfyUI; nothing reached the install's.
    expect(fake.log.filter((e) => e.path === "/prompt").length).toBe(all.length);
    expect(fetched.filter((u) => !u.endsWith("/system_stats"))).toEqual([]);
    // The finished video is its own file, and it downloads.
    const final = view.generations[view.stitches[0].final];
    const out = final.outputs[0].url;
    expect(out).toMatch(/^\/api\/files\/outputs\//);
    expect(passed(viaProxy(out, "GET", "a"))).toBe(true);
    // The session is the account's own project, never a row in the owner's table.
    expect(store.getAccountProject(a, "shorts", id)).not.toBeNull();
    expect(db().prepare("SELECT 1 FROM shorts_sessions WHERE id = ?").get(id)).toBeUndefined();
  });

  it("reopens it: its History lists it, and its page opens for it alone", async () => {
    const list = (await (await sessionsRoute.GET(json("/api/shorts/sessions", "GET", undefined, "a"))).json()) as { items: { id: string; status: string; cover: { id: string } | null }[] };
    expect(list.items.map((s) => s.id)).toEqual([id]);
    expect(list.items[0].status).toBe("ready");
    expect(list.items[0].cover?.id).toBe(view.stitches[0].final);
    const r = await read(id, "a");
    expect(r.status).toBe(200);
    // Its page: the proxy and the page's own check find it for A, never for B or a guest.
    expect(passed(viaProxy(`/shorts/${id}`, "GET", "a"))).toBe(true);
    expect(viaProxy(`/shorts/${id}`, "GET", "b").status).toBe(404);
    const h = (who: string) => new Headers({ host: "localhost:3000", cookie: cookies[who] });
    expect(recordFor({ kind: "shorts", ids: [id] }, h("a"))).toBe(true);
    expect(recordFor({ kind: "shorts", ids: [id] }, h("b"))).toBe(false);
  });

  it("a second click with the same request id gets the same short", async () => {
    const r = await create(short(clip, { requestId: "same-shorts-request-1" }), "a");
    expect(r.status).toBe(201);
    expect(((await r.json()) as { id: string }).id).toBe(id);
  });

  it("a new take of a segment runs on its own GPU, can be picked, and is stitched again", async () => {
    const r = await run(() => takeRoute.POST(json(`/api/shorts/sessions/${id}/segments/1`, "POST", { requestId: "take-request-0001" }, "a"), params({ id, index: "1" })));
    expect(r.status, await r.clone().text()).toBe(201);
    let v = await settle(id, "a");
    const takes = v.segments[1].takes;
    expect(takes.length).toBe(2);
    expect(accountOf(takes[1].look)).toBe(a);
    // Pick the new take, then stitch again.
    const pick = await primaryRoute.POST(json(`/api/shorts/sessions/${id}/segments/1/primary`, "POST", { generationId: takes[1].look }, "a"), params({ id, index: "1" }));
    expect(pick.status, await pick.clone().text()).toBe(200);
    // Another session's take can't be picked here.
    const wrong = await primaryRoute.POST(json(`/api/shorts/sessions/${id}/segments/1/primary`, "POST", { generationId: "owner-short-take" }, "a"), params({ id, index: "1" }));
    expect(wrong.status).toBe(400);
    const s = await run(() => stitchRoute.POST(json(`/api/shorts/sessions/${id}/stitch`, "POST", { requestId: "stitch-request-01" }, "a"), params({ id })));
    expect(s.status, await s.clone().text()).toBe(201);
    v = await settle(id, "a");
    expect(v.stitches.length).toBe(2);
    const final = getGeneration(v.stitches[1].final)!;
    expect(final.status).toBe("succeeded");
    expect(final.request.account).toBe(a);
    // Renamed, it keeps its own name.
    const named = await sessionRoute.PATCH(json(`/api/shorts/sessions/${id}`, "PATCH", { title: "Clay dance" }, "a"), params({ id }));
    expect(named.status).toBe(200);
    expect(((await (await read(id, "a")).json()) as View).title).toBe("Clay dance");
  });

  it("another account never sees, opens, changes or runs it", async () => {
    // Not in B's History; its session reads as gone.
    expect(await (await sessionsRoute.GET(json("/api/shorts/sessions", "GET", undefined, "b"))).json()).toEqual({ items: [] });
    expect((await read(id, "b")).status).toBe(404);
    // No take, no stitch, no pick, no rename, no delete.
    fake.log.length = 0;
    const p = { id, index: "0" };
    expect((await takeRoute.POST(json(`/api/shorts/sessions/${id}/segments/0`, "POST", {}, "b"), params(p))).status).toBe(404);
    expect((await stitchRoute.POST(json(`/api/shorts/sessions/${id}/stitch`, "POST", {}, "b"), params(p))).status).toBe(404);
    expect((await primaryRoute.POST(json(`/api/shorts/sessions/${id}/segments/0/primary`, "POST", { generationId: view.segments[0].primary }, "b"), params(p))).status).toBe(404);
    expect((await sessionRoute.PATCH(json(`/api/shorts/sessions/${id}`, "PATCH", { title: "mine" }, "b"), params(p))).status).toBe(404);
    expect((await sessionRoute.DELETE(json(`/api/shorts/sessions/${id}`, "DELETE", undefined, "b"), params(p))).status).toBe(404);
    expect(fake.log.some((e) => e.path === "/prompt")).toBe(false);
    expect(store.getAccountProject(a, "shorts", id)).not.toBeNull();
    // Its runs and files: 403 through the proxy.
    const out = getGeneration(view.stitches[0].final)!.outputs[0].url;
    expect(viaProxy(`/api/generations/${view.stitches[0].final}`, "GET", "b").status).toBe(403);
    expect(viaProxy(out, "GET", "b").status).toBe(403);
    // A's clip in B's short: refused before anything is planned or sent.
    const r = await sessionsRoute.POST(json("/api/shorts/sessions", "POST", short(clip), "b"));
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe("input-not-yours");
    // The same request id from B is B's own request, never A's short.
    const bClip = await upload("b", CLIP, "video/mp4", "b.mp4");
    const bRun = await create(short(bClip, { requestId: "same-shorts-request-1" }), "b");
    expect(bRun.status, await bRun.clone().text()).toBe(201);
    const bId = ((await bRun.json()) as { id: string }).id;
    expect(bId).not.toBe(id);
    expect(store.getAccountProject(b, "shorts", bId)).not.toBeNull();
    expect(store.getAccountProject(a, "shorts", bId)).toBeNull();
    await settle(bId, "b");
  });

  it("the owner's sessions and files are never reachable", async () => {
    const owner = ownerSession();
    // Not in its History, gone by id, and its page is a 404.
    const list = (await (await sessionsRoute.GET(json("/api/shorts/sessions", "GET", undefined, "a"))).json()) as { items: { id: string }[] };
    expect(list.items.map((s) => s.id)).not.toContain(owner.id);
    expect((await read(owner.id, "a")).status).toBe(404);
    expect(viaProxy(`/shorts/${owner.id}`, "GET", "a").status).toBe(404);
    expect(recordFor({ kind: "shorts", ids: [owner.id] }, new Headers({ host: "localhost:3000", cookie: cookies.a }))).toBe(false);
    // Nothing runs on it, nothing changes it.
    const p = { id: owner.id, index: "0" };
    expect((await takeRoute.POST(json(`/api/shorts/sessions/${owner.id}/segments/0`, "POST", {}, "a"), params(p))).status).toBe(404);
    expect((await stitchRoute.POST(json(`/api/shorts/sessions/${owner.id}/stitch`, "POST", {}, "a"), params(p))).status).toBe(404);
    expect((await sessionRoute.PATCH(json(`/api/shorts/sessions/${owner.id}`, "PATCH", { title: "mine" }, "a"), params(p))).status).toBe(404);
    expect((await sessionRoute.DELETE(json(`/api/shorts/sessions/${owner.id}`, "DELETE", undefined, "a"), params(p))).status).toBe(404);
    expect(db().prepare("SELECT title FROM shorts_sessions WHERE id = ?").get(owner.id)).toEqual({ title: "The owner's short" });
    expect(getGeneration(owner.gen)?.status).toBe("succeeded");
    // The owner's file in its run is refused; its run's file is closed to it.
    const ownerClip = (db().prepare("SELECT source_json FROM shorts_sessions WHERE id = ?").get(owner.id) as { source_json: string }).source_json;
    const url = (JSON.parse(ownerClip) as { url: string }).url;
    const r = await sessionsRoute.POST(json("/api/shorts/sessions", "POST", short(url), "a"));
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe("input-not-yours");
    expect(viaProxy(url, "GET", "a").status).toBe(403);
    // The owner still sees it.
    const mine = (await (await sessionsRoute.GET(json("/api/shorts/sessions", "GET", undefined, "owner"))).json()) as { items: { id: string }[] };
    expect(mine.items.map((s) => s.id)).toEqual([owner.id]);
  });

  it("deletes its own short and its runs for good (an account has no Trash)", async () => {
    const gens = Object.keys(((await (await read(id, "a")).json()) as View).generations);
    const r = await sessionRoute.DELETE(json(`/api/shorts/sessions/${id}`, "DELETE", undefined, "a"), params({ id }));
    expect(r.status).toBe(200);
    expect(store.getAccountProject(a, "shorts", id)).toBeNull();
    for (const g of gens) expect(getGeneration(g, { includeDeleted: true }), g).toBeFalsy();
    expect((await read(id, "a")).status).toBe(404);
  });
});

describe("an account's presets are its own", () => {
  it("makes a preset from its own pictures, and nobody else sees or uses it", async () => {
    const pic = await upload("a", TINY_PNG, "image/png", "look.png");
    const r = await presetsRoute.POST(json("/api/shorts/presets", "POST", { name: "My clay", references: [pic] }, "a"));
    expect(r.status, await r.clone().text()).toBe(201);
    const preset = (await r.json()) as { id: string; name: string; references: string[] };
    expect(preset).toMatchObject({ name: "My clay", references: [pic] });
    const mine = (await (await presetsRoute.GET(json("/api/shorts/presets", "GET", undefined, "a"))).json()) as { items: { id: string }[] };
    expect(mine.items.map((p) => p.id)).toEqual([preset.id]);
    // B: not in its list, not changeable, not usable.
    expect(await (await presetsRoute.GET(json("/api/shorts/presets", "GET", undefined, "b"))).json()).toEqual({ items: [] });
    expect((await presetRoute.PATCH(json(`/api/shorts/presets/${preset.id}`, "PATCH", { name: "mine" }, "b"), params({ id: preset.id }))).status).toBe(404);
    expect((await presetRoute.DELETE(json(`/api/shorts/presets/${preset.id}`, "DELETE", undefined, "b"), params({ id: preset.id }))).status).toBe(404);
    const bClip = await upload("b", CLIP, "video/mp4", "b2.mp4");
    const use = await estimateRoute.POST(json("/api/shorts/estimate", "POST", short(bClip, { presetId: preset.id }), "b"));
    expect(use.status).toBe(400);
    // A's picture in B's preset: refused.
    const steal = await presetsRoute.POST(json("/api/shorts/presets", "POST", { references: [pic] }, "b"));
    expect(steal.status).toBe(403);
    // A renames and deletes its own.
    const named = await presetRoute.PATCH(json(`/api/shorts/presets/${preset.id}`, "PATCH", { name: "Clay two" }, "a"), params({ id: preset.id }));
    expect(((await named.json()) as { name: string }).name).toBe("Clay two");
    expect((await presetRoute.DELETE(json(`/api/shorts/presets/${preset.id}`, "DELETE", undefined, "a"), params({ id: preset.id }))).status).toBe(204);
    expect(store.getAccountProject(a, "shorts-preset", preset.id)).toBeNull();
  });

  it("never reaches the owner's presets", async () => {
    const t = Date.now();
    const ownerPic = saveFile({ data: TINY_PNG, contentType: "image/png", source: "upload", name: "owner-look.png" }).url;
    db()
      .prepare("INSERT INTO shorts_presets (id, name, description, references_json, created_at, updated_at) VALUES ('custom-owner01', 'Owner look', '', ?, ?, ?)")
      .run(JSON.stringify([ownerPic]), t, t);
    const list = (await (await presetsRoute.GET(json("/api/shorts/presets", "GET", undefined, "a"))).json()) as { items: { id: string }[] };
    expect(list.items.map((p) => p.id)).not.toContain("custom-owner01");
    expect((await presetRoute.PATCH(json("/api/shorts/presets/custom-owner01", "PATCH", { name: "mine" }, "a"), params({ id: "custom-owner01" }))).status).toBe(404);
    expect((await presetRoute.DELETE(json("/api/shorts/presets/custom-owner01", "DELETE", undefined, "a"), params({ id: "custom-owner01" }))).status).toBe(404);
    const clip = await upload("a", CLIP, "video/mp4", "own.mp4");
    expect((await estimateRoute.POST(json("/api/shorts/estimate", "POST", short(clip, { presetId: "custom-owner01" }), "a"))).status).toBe(400);
    expect((await sessionsRoute.POST(json("/api/shorts/sessions", "POST", short(clip, { presetId: "custom-owner01" }), "a"))).status).toBe(400);
    expect(db().prepare("SELECT name FROM shorts_presets WHERE id = 'custom-owner01'").get()).toEqual({ name: "Owner look" });
    // The owner's own list still has it.
    const owner = (await (await presetsRoute.GET(json("/api/shorts/presets", "GET", undefined, "owner"))).json()) as { items: { id: string }[] };
    expect(owner.items.map((p) => p.id)).toContain("custom-owner01");
  });
});

describe("an account's limits", () => {
  it("asks an account with neither a GPU nor a key to connect one, before anything is made", async () => {
    const own = runAsTenant({ kind: "account", id: c }, () => saveFile({ data: CLIP, contentType: "video/mp4", source: "upload", name: "c.mp4" }).url);
    const n = (db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n;
    const r = await sessionsRoute.POST(json("/api/shorts/sessions", "POST", short(own), "c"));
    expect(r.status).toBe(403);
    expect(r.headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
    expect((await r.json()).code).toBe("connect-gpu");
    expect((db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n).toBe(n);
    expect(store.listAccountProjects(c, "shorts")).toEqual([]);
  });

  it("keeps runs going at once, a run's weight, and how many shorts it keeps", async () => {
    const clip = await upload("a", CLIP, "video/mp4", "limits.mp4");
    const now = Date.now();
    const add = db().prepare(
      "INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, outputs_json, created_at, updated_at) VALUES (?, 'shorts', 'oss-trim', 'open', 'comfyui', 'trim', 'video', 'queued', ?, '[]', ?, ?)",
    );
    for (let i = 0; i < ACCOUNT_LIMITS.activeRuns; i++) add.run(`busy-shorts-${i}`, JSON.stringify({ feature: "shorts", modelId: "oss-trim", account: a }), now, now);
    const r = await sessionsRoute.POST(json("/api/shorts/sessions", "POST", short(clip), "a"));
    expect(r.status).toBe(429);
    expect((await r.json()).code).toBe(access.ACTIVE_RUNS_CODE);
    db().prepare("DELETE FROM generations WHERE id LIKE 'busy-shorts-%'").run();
    // A run body over what an account's run may weigh is refused before it is read.
    const big = new Request("http://localhost:3000/api/shorts/sessions", { method: "POST", headers: { host: "localhost:3000", cookie: cookies.a, "content-type": "application/json", "content-length": String(ACCOUNT_LIMITS.runBodyBytes + 1) }, body: "{}" });
    expect((await sessionsRoute.POST(big)).status).toBe(413);
    // A full account starts nothing: delete one to make another.
    const kept = store.listAccountProjects(a, "shorts").length;
    for (let i = kept; i < store.ACCOUNT_PROJECT_LIMITS.projects; i++) store.createAccountProject(a, "shorts", { name: `filler ${i}`, data: {} });
    const n = (db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n;
    const full = await sessionsRoute.POST(json("/api/shorts/sessions", "POST", short(clip), "a"));
    expect(full.status).toBe(409);
    expect((db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n).toBe(n);
    // Its History skips what isn't a short of its own.
    expect(((await (await sessionsRoute.GET(json("/api/shorts/sessions", "GET", undefined, "a"))).json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("goes with the account", async () => {
    await purgeAccount(b);
    expect(store.listAccountProjects(b, "shorts")).toEqual([]);
  });
});
