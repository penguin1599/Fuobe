import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SwapProject } from "@/lib/catalog/swap-studio";
import type { SwapProjectView } from "@/server/swap-studio";
import { startFakeComfy, TINY_PNG, type FakeComfy } from "./helpers/fake-comfy-runner";
import { tempDir } from "./helpers/temp-dir";

vi.setConfig({ testTimeout: 240_000 });
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

/**
 * Character Swap Studio for a signed-in account (public sign-up): its projects are its own (account-projects.ts, kind
 * "swap"), its jobs run on its own ComfyUI (a stand-in here) through the checks every account run gets, with only its
 * own files, and its results are its own runs. A guest gets the sign-up card; another account's projects and the owner's
 * are never in reach.
 */
const dir = tempDir("fuobe-account-swap-");
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
const projectsRoute = await import("@/app/api/swap-studio/projects/route");
const projectRoute = await import("@/app/api/swap-studio/projects/[id]/route");
const clipsRoute = await import("@/app/api/swap-studio/projects/[id]/clips/route");
const transcribeRoute = await import("@/app/api/swap-studio/projects/[id]/transcribe/route");
const masksRoute = await import("@/app/api/swap-studio/projects/[id]/masks/route");
const queueRoute = await import("@/app/api/swap-studio/projects/[id]/queue/route");
const assembleRoute = await import("@/app/api/swap-studio/projects/[id]/assemble/route");
const estimateRoute = await import("@/app/api/swap-studio/projects/[id]/estimate/route");
const decisionsRoute = await import("@/app/api/swap-studio/projects/[id]/decisions/route");
const stopRoute = await import("@/app/api/swap-studio/projects/[id]/stop/route");
const stopTakeRoute = await import("@/app/api/swap-studio/projects/[id]/takes/stop/route");
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
const { accountProjectsWith, getAccountProject } = await import("@/server/account-projects");
const { ensureSwapStudioRunner } = await import("@/server/swap-studio");
const { ACCOUNT_CLIP_BYTES } = await import("@/lib/clip-limit");
const { accountRecordExists, recordExists } = await import("@/server/records");

const CLIP = fs.readFileSync(path.join(__dirname, "fixtures/shorts-12s.mp4"));

let fake: FakeComfy;
let a = "";
let b = "";
let c = "";
const cookies: Record<string, string> = {};
beforeAll(async () => {
  fake = await startFakeComfy({ loras: [], delayMs: 0 });
  globalThis.__fuobeTestGpuPort = fake.port;
  auth.setPassword("install password");
  for (const [k, email] of [
    ["a", "swap-a@example.com"],
    ["b", "swap-b@example.com"],
    ["c", "swap-c@example.com"],
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
  // The sweep the server starts at boot: an account's waiting takes start inside its own work.
  ensureSwapStudioRunner();
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
const del = (url: string, who?: string) => new Request(`http://localhost:3000${url}`, { method: "DELETE", headers: { host: "localhost:3000", ...(who && { cookie: cookies[who] }) } });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const base = (id: string) => `/api/swap-studio/projects/${id}`;

const viaProxy = (url: string, method = "GET", who?: string) =>
  proxy(new NextRequest(`http://localhost:3000${url}`, { method, headers: { host: "localhost:3000", ...(who && { cookie: cookies[who] }), ...(method !== "GET" && { "content-type": "application/json" }) }, ...(method !== "GET" && method !== "DELETE" && { body: "{}" }) }));
const passed = (r: Response) => r.headers.get("x-middleware-next") === "1";

async function upload(who: string, data: Buffer, type: string, name: string): Promise<string> {
  const r = await uploadsRoute.POST(new Request("http://localhost:3000/api/uploads", { method: "POST", headers: { host: "localhost:3000", cookie: cookies[who], "content-type": type, "x-file-name": name, "content-length": String(data.length) }, body: new Uint8Array(data) }));
  expect(r.status, await r.clone().text()).toBe(201);
  return ((await r.json()) as { url: string }).url;
}

async function create(who: string | undefined, body: unknown): Promise<Response> {
  return projectsRoute.POST(json("/api/swap-studio/projects", "POST", body, who));
}
async function view(id: string, who: string): Promise<SwapProjectView> {
  const r = await projectRoute.GET(get(base(id), who), ctx(id));
  expect(r.status, await r.clone().text()).toBe(200);
  return r.json();
}
const list = async (who?: string) => ((await (await projectsRoute.GET(get("/api/swap-studio/projects", who))).json()) as { items: { id: string; waiting: number }[] }).items;
const patch = (id: string, edit: unknown, who: string) => projectRoute.PATCH(json(base(id), "PATCH", edit, who), ctx(id));

/** A job route; a LoRA its ComfyUI lacks is put there (the 409 names it), then it is sent again. */
async function job(route: { POST: (r: Request, c: never) => Promise<Response> }, id: string, sub: string, body: unknown, who: string): Promise<Response> {
  let r = await route.POST(json(`${base(id)}/${sub}`, "POST", body, who), ctx(id));
  if (r.status === 409) {
    const j = (await r.clone().json()) as { code: string; fix?: { items: { file: string }[] } };
    if (j.code === "comfy_missing_model" && j.fix) {
      fake.opts.loras = [...(fake.opts.loras ?? []), ...j.fix.items.map((i) => i.file)];
      for (const x of [a, b]) clearAccountLoras(x);
      r = await route.POST(json(`${base(id)}/${sub}`, "POST", body, who), ctx(id));
    }
  }
  return r;
}

/** Poll the project as its page does (the runner ticked) until `done` holds. */
async function until(id: string, who: string, done: (v: SwapProjectView) => boolean, ms = 60_000): Promise<SwapProjectView> {
  const end = Date.now() + ms;
  for (;;) {
    await globalThis.__fuobeRunner?.tick();
    const v = await view(id, who);
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(Object.values(v.gens).map((g) => [g.status, g.error]))}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const RUNS = ["anchors", "assemble", "clips", "masks", "prepare", "queue", "sharpen", "transcribe"];

describe("the proxy opens Character Swap Studio to accounts, and keeps the sign-up card for guests", () => {
  it("a guest gets the sign-up card on every change, an empty list, and 'Sign up' on a project", async () => {
    for (const p of [...RUNS.map((r) => `${base("swap-1")}/${r}`), "/api/swap-studio/projects", `${base("swap-1")}/stop`, `${base("swap-1")}/takes/stop`]) {
      const r = viaProxy(p, "POST");
      expect(r.status, p).toBe(401);
      expect(r.headers.get(access.GUEST_HEADER), p).toBe("1");
      expect((await r.json()).error).toBe(access.GUEST_RUN_MESSAGE);
    }
    for (const m of ["PATCH", "DELETE"]) expect(viaProxy(base("swap-1"), m).status, m).toBe(401);
    const l = viaProxy("/api/swap-studio/projects");
    expect(l.status).toBe(200);
    expect(await l.json()).toEqual({ items: [] });
    for (const p of [base("swap-1"), `${base("swap-1")}/estimate`, `${base("swap-1")}/decisions`]) expect(viaProxy(p).status, p).toBe(401);
  });

  it("an account reaches its projects' routes; its jobs need its own GPU or key", async () => {
    for (const p of RUNS.map((r) => `${base("x")}/${r}`)) {
      expect(passed(viaProxy(p, "POST", "a")), p).toBe(true);
      const r = viaProxy(p, "POST", "c");
      expect(r.status, p).toBe(403);
      expect(r.headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
      expect((await r.json()).code).toBe("connect-gpu");
    }
    // Its projects: the routes answer with its own only (a project with no GPU yet too).
    for (const [p, m] of [
      ["/api/swap-studio/projects", "GET"],
      ["/api/swap-studio/projects", "POST"],
      [base("x"), "GET"],
      [base("x"), "PATCH"],
      [base("x"), "DELETE"],
      [`${base("x")}/estimate`, "GET"],
      [`${base("x")}/decisions`, "GET"],
      [`${base("x")}/stop`, "POST"],
      [`${base("x")}/takes/stop`, "POST"],
    ]) {
      for (const who of ["a", "c"]) expect(passed(viaProxy(p, m, who)), `${m} ${p} ${who}`).toBe(true);
    }
    expect(access.accountProjectRoute(`${base("x")}/queue`)).toBe(false);
    expect(access.ownGpuRun("POST", `${base("x")}/queue`)).toBe(true);
    expect(access.ownGpuRun("POST", `${base("x")}/nope`)).toBe(false);
  });

  it("the routes refuse a guest themselves", async () => {
    const r = await create(undefined, { name: "x", engine: "open" });
    expect(r.status).toBe(401);
    expect(r.headers.get(access.GUEST_HEADER)).toBe("1");
    expect(await list()).toEqual([]);
    expect((await projectRoute.GET(get(base("x")), ctx("x"))).status).toBe(401);
    expect((await projectRoute.PATCH(json(base("x"), "PATCH", { type: "rename", name: "y" }), ctx("x"))).status).toBe(401);
    expect((await projectRoute.DELETE(del(base("x")), ctx("x"))).status).toBe(401);
    for (const [route, sub] of [
      [masksRoute, "masks"],
      [queueRoute, "queue"],
      [clipsRoute, "clips"],
      [stopRoute, "stop"],
    ] as const) {
      const g = await route.POST(json(`${base("x")}/${sub}`, "POST", {}), ctx("x"));
      expect(g.status, sub).toBe(401);
      expect((await g.json()).error).toBe(access.GUEST_RUN_MESSAGE);
    }
    expect((await estimateRoute.GET(get(`${base("x")}/estimate`), ctx("x"))).status).toBe(401);
    expect((await decisionsRoute.GET(get(`${base("x")}/decisions`), ctx("x"))).status).toBe(401);
  });
});

describe("an account's projects are its own", () => {
  let mine = "";
  let owners = "";
  let pic = "";
  let clip = "";
  beforeAll(async () => {
    pic = await upload("a", TINY_PNG, "image/png", "me.png");
    clip = await upload("a", CLIP, "video/mp4", "dance.mp4");
    const o = await create("owner", { name: "The owner's", engine: "open" });
    expect(o.status).toBe(201);
    owners = ((await o.json()) as SwapProject).id;
  });

  it("creates, lists and reopens its own project; another account and the owner never see it", async () => {
    const r = await create("a", { name: "Rain scene", engine: "open", character: { image: pic, description: "a knight" } });
    expect(r.status, await r.clone().text()).toBe(201);
    const p = (await r.json()) as SwapProject;
    mine = p.id;
    expect(p).toMatchObject({ name: "Rain scene", engine: "open", character: { image: pic, description: "a knight" } });
    // Kept with the account, never in the owner's table.
    expect(getAccountProject(a, "swap", mine)).not.toBeNull();
    expect(recordExists({ kind: "swap-project", ids: [mine] })).toBe(false);
    // Its page opens for it alone (the proxy answers anyone else a 404 before the page streams).
    const page = { kind: "swap-project" as const, ids: [mine] };
    expect(accountRecordExists(page, a)).toBe(true);
    expect(accountRecordExists(page, b)).toBe(false);
    expect(accountRecordExists({ kind: "swap-project", ids: [owners] }, a)).toBe(false);
    expect(passed(viaProxy(`/character-swap/${mine}`, "GET", "a"))).toBe(true);
    expect(viaProxy(`/character-swap/${mine}`, "GET", "b").status).toBe(404);
    expect(viaProxy(`/character-swap/${owners}`, "GET", "a").status).toBe(404);
    // Its list has it (and never the owner's); B's and the owner's lists don't.
    expect((await list("a")).map((x) => x.id)).toEqual([mine]);
    expect(await list("b")).toEqual([]);
    expect((await list("owner")).map((x) => x.id)).toEqual([owners]);
    // Reopened: the project, with its jobs' states.
    const v = await view(mine, "a");
    expect(v.project).toMatchObject({ id: mine, name: "Rain scene", clips: [] });
    // Renamed by A.
    const ren = await patch(mine, { type: "rename", name: "Rain scene 2" }, "a");
    expect(ren.status).toBe(200);
    expect(((await ren.json()) as SwapProject).name).toBe("Rain scene 2");
  });

  it("another account reads, changes, runs and deletes nothing of it: not found", async () => {
    expect((await projectRoute.GET(get(base(mine), "b"), ctx(mine))).status).toBe(404);
    expect((await patch(mine, { type: "rename", name: "mine now" }, "b")).status).toBe(404);
    expect((await projectRoute.DELETE(del(base(mine), "b"), ctx(mine))).status).toBe(404);
    expect((await estimateRoute.GET(get(`${base(mine)}/estimate`, "b"), ctx(mine))).status).toBe(404);
    expect((await decisionsRoute.GET(get(`${base(mine)}/decisions`, "b"), ctx(mine))).status).toBe(404);
    const own = await upload("b", CLIP, "video/mp4", "b.mp4");
    const n = (db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n;
    expect((await job(clipsRoute, mine, "clips", { url: own, name: "b.mp4" }, "b")).status).toBe(404);
    expect((await job(masksRoute, mine, "masks", { clipId: "c", shotId: "s", kind: "track", frame: 0 }, "b")).status).toBe(404);
    expect((await stopRoute.POST(json(`${base(mine)}/stop`, "POST", { kind: "normalize", clipId: "c" }, "b"), ctx(mine))).status).toBe(404);
    expect((db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n).toBe(n);
    expect(getAccountProject(a, "swap", mine)?.name).toBe("Rain scene 2");
  });

  it("the owner's projects are never in reach of an account", async () => {
    expect((await projectRoute.GET(get(base(owners), "a"), ctx(owners))).status).toBe(404);
    expect((await patch(owners, { type: "rename", name: "taken" }, "a")).status).toBe(404);
    expect((await projectRoute.DELETE(del(base(owners), "a"), ctx(owners))).status).toBe(404);
    expect((await job(clipsRoute, owners, "clips", { url: clip, name: "dance.mp4" }, "a")).status).toBe(404);
    expect(recordExists({ kind: "swap-project", ids: [owners] })).toBe(true);
    const o = await projectRoute.GET(get(base(owners), "owner"), ctx(owners));
    expect(((await o.json()) as SwapProjectView).project.name).toBe("The owner's");
    // The owner's own route reads only the owner's table: an account's project is no project of the owner's.
    expect((await projectRoute.GET(get(base(mine), "owner"), ctx(mine))).status).toBe(404);
  });

  it("names only its own files: another account's, the owner's, or a link is refused", async () => {
    const bPic = await upload("b", TINY_PNG, "image/png", "b.png");
    const ownerPic = saveFile({ data: TINY_PNG, contentType: "image/png", source: "upload", name: "owner.png" }).url;
    for (const [image, code] of [
      [bPic, "input-not-yours"],
      [ownerPic, "input-not-yours"],
    ] as const) {
      const r = await create("a", { name: "x", engine: "open", character: { image } });
      expect(r.status, image).toBe(403);
      expect((await r.json()).code).toBe(code);
      const e = await patch(mine, { type: "character", image }, "a");
      expect(e.status).toBe(403);
      const imp = await patch(mine, { type: "anchor-import", clipId: "c", shotId: "s", url: image }, "a");
      expect(imp.status).toBe(403);
    }
    // A clip that isn't its own: refused before anything is read or made.
    const bClip = await upload("b", CLIP, "video/mp4", "b2.mp4");
    const ownerClip = saveFile({ data: CLIP, contentType: "video/mp4", source: "upload", name: "owner.mp4" }).url;
    for (const url of [bClip, ownerClip]) {
      const r = await job(clipsRoute, mine, "clips", { url, name: "x.mp4" }, "a");
      expect(r.status, url).toBe(403);
      expect((await r.json()).code).toBe("input-not-yours");
    }
    expect((await view(mine, "a")).project.clips).toEqual([]);
  });

  it("an account with neither a GPU nor a key makes a project, and is asked to connect one before a job", async () => {
    const r = await create("c", { name: "No GPU", engine: "open" });
    expect(r.status).toBe(201);
    const id = ((await r.json()) as SwapProject).id;
    const own = runAsTenant({ kind: "account", id: c }, () => saveFile({ data: CLIP, contentType: "video/mp4", source: "upload", name: "c.mp4" }).url);
    const n = (db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n;
    const j = await job(clipsRoute, id, "clips", { url: own, name: "c.mp4" }, "c");
    expect(j.status).toBe(403);
    expect(j.headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
    expect((await j.json()).code).toBe("connect-gpu");
    expect((db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n).toBe(n);
    // The cloud is its own fal.ai key's: without one, the add-key answer.
    const cloud = await create("c", { name: "Cloud", engine: "cloud" });
    expect(cloud.status).toBe(422);
    expect((await cloud.json()).error).toMatch(/fal\.ai key/);
  });
});

describe("an account runs Character Swap Studio on its own ComfyUI", () => {
  let id = "";
  let pic = "";
  let clip = "";
  let clipId = "";
  let shotId = "";
  beforeAll(async () => {
    pic = await upload("a", TINY_PNG, "image/png", "hero.png");
    clip = await upload("a", CLIP, "video/mp4", "clip.mp4");
    const r = await create("a", { name: "GPU run", engine: "open", character: { image: pic, description: "a knight in silver armour" } });
    id = ((await r.json()) as SwapProject).id;
  });

  it("adds its clip: the 24 fps copy runs on its ComfyUI as its own run; nothing reaches the install's", async () => {
    fake.log.length = 0;
    fetched.length = 0;
    const r = await job(clipsRoute, id, "clips", { url: clip, name: "clip.mp4" }, "a");
    expect(r.status, await r.clone().text()).toBe(201);
    const p = (await r.json()) as SwapProject;
    const c = p.clips[0];
    clipId = c.id;
    shotId = c.shots[0].id;
    expect(c).toMatchObject({ frames: 288, source: { url: clip, duration: 12 } });
    const norm = getGeneration(c.normalized!.genId!)!;
    expect(norm).toMatchObject({ modelId: "oss-fit-clip", provider: "comfyui", feature: "swap-studio-step" });
    expect(norm.request.account).toBe(a);
    const v = await until(id, "a", (x) => !!x.project.clips[0].normalized?.url);
    expect(v.project.clips[0].normalized!.url).toMatch(/^\/api\/files\/outputs\//);
    expect(fake.log.filter((e) => e.path === "/prompt").length).toBe(1);
    expect(fetched.filter((u) => !u.endsWith("/system_stats"))).toEqual([]);
  });

  it("transcribes its words and tracks who to swap, each its own run on its ComfyUI", async () => {
    const t = await job(transcribeRoute, id, "transcribe", { clipId }, "a");
    expect(t.status, await t.clone().text()).toBe(200);
    const tg = getGeneration(((await t.json()) as SwapProject).clips[0].transcript!.genId!)!;
    expect(tg).toMatchObject({ modelId: "oss-qwen3-asr", provider: "comfyui" });
    expect(tg.request.account).toBe(a);
    const m = await job(masksRoute, id, "masks", { clipId, shotId, kind: "track", frame: 0, points: [] }, "a");
    expect(m.status, await m.clone().text()).toBe(201);
    const mask = ((await m.json()) as SwapProject).clips[0].shots[0].masks[0];
    for (const g of [mask.genId!, ...(mask.stepIds ?? [])]) expect(getGeneration(g)!.request.account, g).toBe(a);
    await until(id, "a", (x) => !!x.project.clips[0].shots[0].masks[0].pieces[0].url && x.project.clips[0].transcript?.cues !== null);
    // A job of its own can be stopped (nothing is running now: it answers with the project).
    const s = await stopRoute.POST(json(`${base(id)}/stop`, "POST", { kind: "transcribe", clipId }, "a"), ctx(id));
    expect(s.status).toBe(200);
  });

  it("prices it for its own GPU, never as a demo", async () => {
    const r = await estimateRoute.GET(get(`${base(id)}/estimate`, "a"), ctx(id));
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await r.json()).toMatchObject({ engine: "open", demo: false });
  });

  it("queues two segments as one run: the second waits, then starts inside its own work when the first is made", async () => {
    let p = ((await (await patch(id, { type: "cuts", clipId, cuts: [96], modes: ["generate", "preserve"] }, "a")).json()) as SwapProject);
    shotId = p.clips[0].shots[0].id;
    p = (await (await patch(id, { type: "shot", clipId, shotId, patch: { settings: { useAnchor: false } } }, "a")).json()) as SwapProject;
    const lay = await patch(id, { type: "layout", clipId, shotId, op: { op: "partition", frames: 48 } }, "a");
    expect(lay.status, await lay.clone().text()).toBe(200);
    p = (await lay.json()) as SwapProject;
    const segs = p.clips[0].shots[0].segments!;
    expect(segs.map((g) => g.connection)).toEqual(["start", "continue"]);
    for (const g of segs) expect((await patch(id, { type: "segment", clipId, shotId, segmentId: g.id, patch: { anchorMode: "none" } }, "a")).status).toBe(200);
    fake.log.length = 0;
    // A take comes out with its lossless master (what the next segment continues from).
    fake.opts.nodes = ["save", "save_master"];
    const q = await job(queueRoute, id, "queue", { clipId, shotId, segmentId: segs[0].id, mode: "all" }, "a");
    expect(q.status, await q.clone().text()).toBe(201);
    const out = (await q.json()) as { project: SwapProject; takes: string[] };
    const [t1, t2] = out.project.clips[0].shots[0].segments!.map((g) => g.takes.at(-1)!);
    expect(t1.state).toBe("launched");
    expect(t2).toMatchObject({ state: "waiting", batchId: t1.batchId });
    const first = getGeneration(t1.genId!)!;
    expect(first).toMatchObject({ modelId: "oss-h3-swap-segment", provider: "comfyui" });
    expect(first.request.account).toBe(a);
    // One run: its steps share the queue's batch.
    expect(t1.batchId).toBeTruthy();
    for (const g of t1.stepIds ?? []) expect(getGeneration(g)!.batchId).toBe(t1.batchId);
    // The waiting take is on its list, and the sweep sees it.
    expect((await list("a")).find((x) => x.id === id)?.waiting).toBe(1);
    expect(accountProjectsWith("swap", "waiting").map((x) => x.id)).toContain(id);
    // Made: the sweep (no page open) starts the second take inside A's own work, in the same run.
    const end = Date.now() + 60_000;
    let second: SwapProject["clips"][number]["shots"][number]["segments"] = null;
    for (;;) {
      await globalThis.__fuobeRunner?.tick();
      second = getAccountProject<SwapProject>(a, "swap", id)!.data.clips[0].shots[0].segments;
      if (second?.[1].takes.at(-1)!.state !== "waiting" || Date.now() > end) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const t2now = second![1].takes.at(-1)!;
    expect(t2now.state, t2now.reason).toBe("launched");
    const g2 = getGeneration(t2now.genId!)!;
    expect(g2.request.account).toBe(a);
    expect(g2.batchId).toBe(t1.batchId);
    // It continues from the first take's master.
    expect(g2.request.params?.extra).toMatchObject({ historyVideo: expect.stringMatching(/^\/api\/files\/outputs\//) });
    const v = await until(id, "a", (x) => x.project.clips[0].shots[0].segments!.every((g) => !!g.selectedTake));
    expect(v.project.clips[0].shots[0].segments!.map((g) => g.selectedTake)).toEqual([t1.id, t2.id]);
    delete fake.opts.nodes;
  });

  it("assembles its clip: the result is its own run and its own file, to open and download; nobody else's", async () => {
    const r = await job(assembleRoute, id, "assemble", { clipId }, "a");
    expect(r.status, await r.clone().text()).toBe(201);
    const asm = ((await r.json()) as SwapProject).clips[0].assembly!;
    for (const g of [asm.genId!, ...asm.stepIds!]) expect(getGeneration(g)!.request.account, g).toBe(a);
    const v = await until(id, "a", (x) => x.gens[x.project.clips[0].assembly!.genId!]?.status === "succeeded");
    const final = getGeneration(asm.genId!)!;
    expect(final.feature).toBe("swap-studio");
    const out = v.gens[asm.genId!].url!;
    expect(out).toMatch(/^\/api\/files\/outputs\//);
    expect(passed(viaProxy(out, "GET", "a"))).toBe(true);
    expect(passed(viaProxy(`/api/generations/${asm.genId}`, "GET", "a"))).toBe(true);
    expect(viaProxy(out, "GET", "b").status).toBe(403);
    expect(viaProxy(`/api/generations/${asm.genId}`, "GET", "b").status).toBe(403);
    expect(viaProxy(out, "GET").status).toBe(401);
    // Export decisions: its own project's.
    const d = await decisionsRoute.GET(get(`${base(id)}/decisions`, "a"), ctx(id));
    expect(d.status).toBe(200);
    expect(d.headers.get("Content-Disposition")).toMatch(/GPU-run-decisions\.json/);
    // Nothing went to the install's own ComfyUI.
    expect(fetched.filter((u) => !u.endsWith("/system_stats"))).toEqual([]);
  });

  it("keeps the account's limits: runs going at once, a run's size, and its saves", async () => {
    const now = Date.now();
    const add = db().prepare(
      "INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, outputs_json, created_at, updated_at) VALUES (?, 'swap-studio-step', 'oss-fit-clip', 'open', 'comfyui', 'trim', 'video', 'queued', ?, '[]', ?, ?)",
    );
    for (let i = 0; i < ACCOUNT_LIMITS.activeRuns; i++) add.run(`busy-swap-${i}`, JSON.stringify({ feature: "swap-studio-step", modelId: "oss-fit-clip", account: a }), now, now);
    try {
      const r = await job(masksRoute, id, "masks", { clipId, shotId, kind: "track", frame: 0, points: [] }, "a");
      expect(r.status).toBe(429);
      expect((await r.json()).code).toBe(access.ACTIVE_RUNS_CODE);
    } finally {
      db().prepare("DELETE FROM generations WHERE id LIKE 'busy-swap-%'").run();
    }
    const big = new Request(`http://localhost:3000${base(id)}/masks`, { method: "POST", headers: { host: "localhost:3000", cookie: cookies.a, "content-type": "application/json", "content-length": String(ACCOUNT_LIMITS.runBodyBytes + 1) }, body: "{}" });
    expect((await masksRoute.POST(big, ctx(id))).status).toBe(413);
    // An account's clip upload limit is what its upload boxes say.
    expect(ACCOUNT_CLIP_BYTES).toBe(ACCOUNT_LIMITS.videoBytes);
  });

  it("stops a waiting take and deletes its project", async () => {
    const s = await stopTakeRoute.POST(json(`${base(id)}/takes/stop`, "POST", { clipId, shotId, segmentId: "nope", takeId: "nope" }, "a"), ctx(id));
    expect(s.status).toBe(404);
    expect((await projectRoute.DELETE(del(base(id), "a"), ctx(id))).status).toBe(204);
    expect((await projectRoute.GET(get(base(id), "a"), ctx(id))).status).toBe(404);
    expect(getAccountProject(a, "swap", id)).toBeNull();
  });
});
