import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { startFakeComfy, TINY_PNG, type FakeComfy } from "./helpers/fake-comfy-runner";
import { tempDir } from "./helpers/temp-dir";

vi.setConfig({ testTimeout: 120_000 });
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

/**
 * Photodump, Fashion Factory, Character Sheet and AI Influencer for a signed-in account (public sign-up): every photo
 * runs on its own ComfyUI (a stand-in here) through the same generations every studio run makes, with only its own
 * files; its packs and characters are its own projects. A guest gets the sign-up card; another account's packs,
 * characters and photos, and the owner's, are never reached.
 */
const dir = tempDir("fuobe-account-photo-apps-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://owner-comfy.test:8188";
process.env.FUOBE_PUBLIC_SIGNUP = "1";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_ALLOW_PRIVATE_URLS;
delete process.env.FUOBE_HOSTED_RUNS;
globalThis.__fuobeTestDiskFree = 1e13;

// Plain fetch is the install's own ComfyUI ("owner-comfy.test") or an AI helper: recorded, so a test sees nothing reached it.
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
const photodumpRoute = await import("@/app/api/photodump/route");
const fashionRoute = await import("@/app/api/photodump/fashion/route");
const sheetRoute = await import("@/app/api/photodump/character/route");
const retryRoute = await import("@/app/api/photodump/retry/route");
const packsRoute = await import("@/app/api/photodump/packs/route");
const packRoute = await import("@/app/api/photodump/packs/[id]/route");
const charactersRoute = await import("@/app/api/photodump/characters/route");
const characterRoute = await import("@/app/api/photodump/characters/[id]/route");
const influencerRoute = await import("@/app/api/influencer/route");
const influencerEstimate = await import("@/app/api/influencer/estimate/route");
const uploadsRoute = await import("@/app/api/uploads/route");
const gpuRoute = await import("@/app/api/account/gpu/route");
const { proxy } = await import("@/proxy");
const access = await import("@/lib/guest-access");
const { PACKS, FASHION } = await import("@/lib/catalog/packs");
const { INFLUENCER_START } = await import("@/lib/influencer");
const { getGeneration } = await import("@/server/generations");
const { db } = await import("@/server/db");
const { resetRates } = await import("@/server/rate");
const { clearAccountLoras } = await import("@/server/account-loras");
const { saveFile } = await import("@/server/storage");
const { runAsTenant } = await import("@/server/tenant");
const { ACCOUNT_LIMITS } = await import("@/server/account-files");
const store = await import("@/server/account-projects");
const { createElement } = await import("@/server/elements");
const { purgeAccount } = await import("@/server/account-sweep");
const { CHARACTER_KIND, PACK_KIND } = await import("@/server/photodump");

let fake: FakeComfy;
let a = "";
let b = "";
let c = "";
const cookies: Record<string, string> = {};
beforeAll(async () => {
  fake = await startFakeComfy({ loras: [], delayMs: 0, output: "image" });
  globalThis.__fuobeTestGpuPort = fake.port;
  auth.setPassword("install password");
  for (const [k, email] of [
    ["a", "photo-a@example.com"],
    ["b", "photo-b@example.com"],
    ["c", "photo-c@example.com"],
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

async function upload(who: string, name: string): Promise<string> {
  const r = await uploadsRoute.POST(new Request("http://localhost:3000/api/uploads", { method: "POST", headers: { host: "localhost:3000", cookie: cookies[who], "content-type": "image/png", "x-file-name": name, "content-length": String(TINY_PNG.length) }, body: new Uint8Array(TINY_PNG) }));
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

interface Started {
  batchId?: string;
  items: { id: string }[];
}

/** Tick the runner until every one of these runs (and the steps they wait for) is done, or the time is up. */
async function settle(ids: string[], ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    await globalThis.__fuobeRunner?.tick();
    const batches = new Set(ids.map((id) => getGeneration(id, { includeDeleted: true })?.batchId).filter(Boolean));
    const all = [...ids, ...(db().prepare(`SELECT id FROM generations WHERE batch_id IN (${[...batches].map(() => "?").join(",") || "''"})`).all(...batches) as { id: string }[]).map((r) => r.id)];
    const busy = all.some((g) => ["queued", "running"].includes(getGeneration(g, { includeDeleted: true })?.status ?? ""));
    if (!busy || Date.now() > end) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Every generation of the run's batch (or the items when they have none). */
function runOf(s: Started) {
  const batch = s.batchId ?? getGeneration(s.items[0].id)?.batchId;
  const ids = batch ? (db().prepare("SELECT id FROM generations WHERE batch_id = ? OR id = ?").all(batch, batch) as { id: string }[]).map((r) => r.id) : s.items.map((i) => i.id);
  return ids.map((id) => getGeneration(id, { includeDeleted: true })!);
}

/** Start, then expect every step to be the account's, on its ComfyUI, and finished; nothing at the install's ComfyUI. */
async function runsAsOwn(send: () => Promise<Response>, who: string, account: string) {
  fake.log.length = 0;
  fetched.length = 0;
  const r = await run(send);
  expect(r.status, await r.clone().text()).toBe(201);
  const started = (await r.json()) as Started;
  await settle(started.items.map((i) => i.id));
  const gens = runOf(started);
  expect(gens.length).toBeGreaterThan(0);
  for (const g of gens) {
    expect(g.request.account, g.id).toBe(account);
    expect(g.status, `${g.id} ${g.modelId} ${g.error ?? ""}`).toBe("succeeded");
  }
  expect(new Set(gens.map((g) => g.batchId ?? g.id)).size).toBe(1);
  // Every step went to its own ComfyUI; nothing reached the install's (or an AI helper).
  expect(fake.log.filter((e) => e.path === "/prompt").length).toBeGreaterThanOrEqual(gens.length);
  expect(fetched.filter((u) => !u.endsWith("/system_stats"))).toEqual([]);
  // Its results are its own files, and they download for it alone.
  const out = gens[0].outputs[0].url;
  expect(out).toMatch(/^\/api\/files\//);
  expect(passed(viaProxy(out, "GET", who))).toBe(true);
  expect(viaProxy(out, "GET", who === "a" ? "b" : "a").status).toBe(403);
  return { started, gens, out };
}

const PACK = PACKS.find((p) => p.product === "photodump") ?? PACKS[0];
const TEMPLATE = FASHION[0];
const photodump = (extra: Record<string, unknown>) => ({ packId: PACK.id, engine: "open", aspectRatio: "3:4", ...extra });

const RUNS = ["/api/photodump", "/api/photodump/fashion", "/api/photodump/character", "/api/photodump/retry", "/api/influencer"] as const;

describe("the proxy opens the photo apps to accounts, and keeps the sign-up card for guests", () => {
  it("a guest gets the sign-up card on every run and change, and empty lists", async () => {
    for (const [method, p] of [...RUNS.map((r) => ["POST", r] as const), ["POST", "/api/photodump/packs"], ["DELETE", "/api/photodump/packs/p1"], ["POST", "/api/photodump/characters"], ["DELETE", "/api/photodump/characters/c1"]] as const) {
      const r = viaProxy(p, method);
      expect(r.status, `${method} ${p}`).toBe(401);
      expect(r.headers.get(access.GUEST_HEADER), p).toBe("1");
      expect((await r.json()).error).toBe(access.GUEST_RUN_MESSAGE);
    }
    expect(await viaProxy("/api/photodump/packs").json()).toEqual({ packs: [] });
    expect(await viaProxy("/api/photodump/characters").json()).toEqual({ items: [] });
    // Price checks stay open to everyone.
    for (const p of ["/api/photodump?preview=1", "/api/photodump/fashion?preview=1", "/api/photodump/character?preview=1", "/api/influencer?preview=1", "/api/influencer/estimate"]) expect(passed(viaProxy(p, "POST")), p).toBe(true);
  });

  it("an account with a GPU reaches every photo app route (the routes scope them)", () => {
    for (const [method, p] of [...RUNS.map((r) => ["POST", r] as const), ["GET", "/api/photodump/packs"], ["POST", "/api/photodump/packs"], ["DELETE", "/api/photodump/packs/p1"], ["GET", "/api/photodump/characters"], ["POST", "/api/photodump/characters"], ["DELETE", "/api/photodump/characters/c1"]] as const) {
      expect(passed(viaProxy(p, method, "a")), `${method} ${p}`).toBe(true);
    }
  });

  it("an account with neither a GPU nor a key is asked to connect one for a run", async () => {
    for (const p of RUNS) {
      const r = viaProxy(p, "POST", "c");
      expect(r.status, p).toBe(403);
      expect(r.headers.get(access.CONNECT_GPU_HEADER), p).toBe("1");
    }
  });

  it("the routes refuse a guest themselves", async () => {
    for (const [name, r] of [
      ["photodump", () => photodumpRoute.POST(json("/api/photodump", "POST", photodump({ selfie: "/api/files/x.png" })))],
      ["fashion", () => fashionRoute.POST(json("/api/photodump/fashion", "POST", { step: "base", templateId: TEMPLATE.id, elementId: "e1", engine: "open" }))],
      ["sheet", () => sheetRoute.POST(json("/api/photodump/character", "POST", { mode: "describe", engine: "open", prompt: "a surfer" }))],
      ["retry", () => retryRoute.POST(json("/api/photodump/retry", "POST", { id: "g1" }))],
      ["influencer", () => influencerRoute.POST(json("/api/influencer", "POST", { engine: "open", state: INFLUENCER_START, start: "scratch" }))],
      ["pack", () => packsRoute.POST(json("/api/photodump/packs", "POST", { name: "x", refs: ["/api/files/x.png"] }))],
      ["character", () => charactersRoute.POST(json("/api/photodump/characters", "POST", { name: "x", references: ["/api/files/x.png"] }))],
    ] as const) {
      const res = await r();
      expect(res.status, name).toBe(401);
      expect(res.headers.get(access.GUEST_HEADER), name).toBe("1");
    }
    expect(await (await packsRoute.GET(json("/api/photodump/packs", "GET"))).json()).toEqual({ packs: [] });
    expect(await (await charactersRoute.GET(json("/api/photodump/characters", "GET"))).json()).toEqual({ items: [] });
  });
});

describe("an account runs every photo app on its own ComfyUI", () => {
  let selfie = "";
  let photoset = "";
  beforeAll(async () => {
    selfie = await upload("a", "selfie.png");
  });

  it("prices a Photodump for its own GPU, never as a demo, and a guest's on the open engine", async () => {
    const r = await photodumpRoute.POST(json("/api/photodump?preview=1", "POST", photodump({ selfie }), "a"));
    const p = (await r.json()) as { demo: boolean; costUsd: number; count: number; error?: string };
    expect(p.error).toBeUndefined();
    expect(p.demo).toBe(false);
    expect(p.costUsd).toBe(0);
    expect(p.count).toBe(PACK.count);
    const g = (await (await influencerEstimate.POST(json("/api/influencer/estimate", "POST", { engine: "open", state: INFLUENCER_START, start: "scratch" }))).json()) as { demo: boolean; error?: string };
    expect(g.error).toBeUndefined();
    expect(g.demo).toBe(false);
  });

  it("makes a Photodump from its own selfie: every photo its own, on its ComfyUI; a repeat id gets the same set", async () => {
    const send = () => photodumpRoute.POST(json("/api/photodump", "POST", photodump({ selfie, requestId: "photodump-request-1" }), "a"));
    const { started, gens } = await runsAsOwn(send, "a", a);
    expect(gens.length).toBe(PACK.count);
    const again = await send();
    expect(again.status).toBe(201);
    expect(((await again.json()) as Started).batchId).toBe(started.batchId);
    // Its History (its own runs) lists them; B's doesn't.
    const list = await import("@/app/api/generations/route");
    const mine = (await (await list.GET(json("/api/generations?features=photodump", "GET", undefined, "a"))).json()) as { items: { id: string }[] };
    expect(mine.items.length).toBe(PACK.count);
    const theirs = (await (await list.GET(json("/api/generations?features=photodump", "GET", undefined, "b"))).json()) as { items: { id: string }[] };
    expect(theirs.items).toEqual([]);
  });

  it("keeps its own packs: makes one from its photos, runs it, and nobody else sees or uses it", async () => {
    const ref = await upload("a", "pack-ref.png");
    const r = await packsRoute.POST(json("/api/photodump/packs", "POST", { name: "Beach", refs: [ref] }, "a"));
    expect(r.status, await r.clone().text()).toBe(201);
    const pack = (await r.json()) as { id: string };
    expect(store.getAccountProject(a, PACK_KIND, pack.id)).not.toBeNull();
    expect(((await (await packsRoute.GET(json("/api/photodump/packs", "GET", undefined, "a"))).json()) as { packs: { id: string }[] }).packs.map((p) => p.id)).toEqual([pack.id]);
    // GET /api/photodump lists the same: the proxy lets the account's read through (never a guest's stand-in), and the
    // route answers with its own packs; a guest still gets the empty list.
    const list = viaProxy("/api/photodump", "GET", "a");
    expect(passed(list)).toBe(true);
    expect(list.headers.get(access.GUEST_HEADER)).toBeNull();
    expect(((await (await photodumpRoute.GET(json("/api/photodump", "GET", undefined, "a"))).json()) as { packs: { id: string }[] }).packs.map((p) => p.id)).toEqual([pack.id]);
    expect(await (await photodumpRoute.GET(json("/api/photodump", "GET", undefined, "b"))).json()).toEqual({ packs: [] });
    expect(await viaProxy("/api/photodump").json()).toEqual({ packs: [] });
    const { gens } = await runsAsOwn(() => photodumpRoute.POST(json("/api/photodump", "POST", photodump({ packId: pack.id, selfie }), "a")), "a", a);
    expect(gens.length).toBe(1);
    expect(gens[0].request.inputs?.images).toContain(ref);
    // B: not in its list, not deletable, not usable; A's photo can't go in B's pack.
    expect(await (await packsRoute.GET(json("/api/photodump/packs", "GET", undefined, "b"))).json()).toEqual({ packs: [] });
    expect((await packRoute.DELETE(json(`/api/photodump/packs/${pack.id}`, "DELETE", undefined, "b"), params({ id: pack.id }))).status).toBe(404);
    const bSelfie = await upload("b", "b.png");
    const use = await photodumpRoute.POST(json("/api/photodump", "POST", photodump({ packId: pack.id, selfie: bSelfie }), "b"));
    expect(use.status).toBe(422);
    expect((await use.json()).error).toBe("That pack no longer exists");
    const steal = await packsRoute.POST(json("/api/photodump/packs", "POST", { name: "Mine", refs: [ref] }, "b"));
    expect(steal.status).toBe(403);
    // A deletes its own.
    expect((await packRoute.DELETE(json(`/api/photodump/packs/${pack.id}`, "DELETE", undefined, "a"), params({ id: pack.id }))).status).toBe(204);
    expect(store.getAccountProject(a, PACK_KIND, pack.id)).toBeNull();
  });

  it("saves its own character and runs Fashion Factory end to end with it: base shots, outfit, photoset", async () => {
    const face = await upload("a", "face.png");
    const r = await charactersRoute.POST(json("/api/photodump/characters", "POST", { name: "Maya", references: [face] }, "a"));
    expect(r.status, await r.clone().text()).toBe(201);
    const character = (await r.json()) as { id: string; name: string };
    expect(((await (await charactersRoute.GET(json("/api/photodump/characters", "GET", undefined, "a"))).json()) as { items: { id: string }[] }).items.map((x) => x.id)).toEqual([character.id]);
    // Base shots: its character's photo goes in as image 1.
    const base = await runsAsOwn(() => fashionRoute.POST(json("/api/photodump/fashion", "POST", { step: "base", templateId: TEMPLATE.id, elementId: character.id, engine: "open" }, "a")), "a", a);
    expect(base.gens[0].request.inputs?.images).toEqual([face]);
    expect(base.gens[0].request.batchTitle).toContain("Maya");
    const garment = await upload("a", "garment.png");
    const outfit = await runsAsOwn(() => fashionRoute.POST(json("/api/photodump/fashion", "POST", { step: "outfit", templateId: TEMPLATE.id, base: base.out, garment, engine: "open" }, "a")), "a", a);
    const set = await runsAsOwn(() => fashionRoute.POST(json("/api/photodump/fashion", "POST", { step: "photoset", templateId: TEMPLATE.id, dressed: outfit.out, engine: "open" }, "a")), "a", a);
    photoset = set.out;
    // B can't use A's character, its results or delete it; the photoset is A's alone.
    const bChar = await fashionRoute.POST(json("/api/photodump/fashion", "POST", { step: "base", templateId: TEMPLATE.id, elementId: character.id, engine: "open" }, "b"));
    expect(bChar.status).toBe(422);
    expect((await bChar.json()).error).toBe("That character no longer exists");
    const bOutfit = await fashionRoute.POST(json("/api/photodump/fashion", "POST", { step: "photoset", templateId: TEMPLATE.id, dressed: photoset, engine: "open" }, "b"));
    expect(bOutfit.status).toBe(403);
    expect((await bOutfit.json()).code).toBe("input-not-yours");
    expect((await characterRoute.DELETE(json(`/api/photodump/characters/${character.id}`, "DELETE", undefined, "b"), params({ id: character.id }))).status).toBe(404);
    expect(await (await charactersRoute.GET(json("/api/photodump/characters", "GET", undefined, "b"))).json()).toEqual({ items: [] });
    // A's photo in B's character: refused.
    expect((await charactersRoute.POST(json("/api/photodump/characters", "POST", { name: "Not mine", references: [face] }, "b"))).status).toBe(403);
    expect(store.getAccountProject(a, CHARACTER_KIND, character.id)).not.toBeNull();
  });

  it("makes Character Sheets from its own photos, from scratch and from a description", async () => {
    const photo = await upload("a", "ref.png");
    await runsAsOwn(() => sheetRoute.POST(json("/api/photodump/character", "POST", { mode: "reference", engine: "open", images: [photo] }, "a")), "a", a);
    await runsAsOwn(() => sheetRoute.POST(json("/api/photodump/character", "POST", { mode: "cast", engine: "open", cast: { gender: "Female" } }, "a")), "a", a);
    await runsAsOwn(() => sheetRoute.POST(json("/api/photodump/character", "POST", { mode: "describe", engine: "open", prompt: "a surfer and photographer from Lisbon" }, "a")), "a", a);
    // Another's photo is refused before anything is made.
    const bRef = await sheetRoute.POST(json("/api/photodump/character", "POST", { mode: "reference", engine: "open", images: [photo] }, "b"));
    expect(bRef.status).toBe(403);
  });

  it("builds an AI Influencer sheet, and dresses it in its own face photo (two chained steps, both its own)", async () => {
    await runsAsOwn(() => influencerRoute.POST(json("/api/influencer", "POST", { engine: "open", state: INFLUENCER_START, start: "scratch" }, "a")), "a", a);
    const face = await upload("a", "influencer-face.png");
    const { gens } = await runsAsOwn(() => influencerRoute.POST(json("/api/influencer", "POST", { engine: "open", state: INFLUENCER_START, start: "face", photo: face }, "a")), "a", a);
    expect(gens.length).toBe(2);
    const bFace = await influencerRoute.POST(json("/api/influencer", "POST", { engine: "open", state: INFLUENCER_START, start: "face", photo: face }, "b"));
    expect(bFace.status).toBe(403);
  });

  it("retries its own failed photo on its GPU (the failed one is deleted for good); never another's or the owner's", async () => {
    const { gens } = await runsAsOwn(() => photodumpRoute.POST(json("/api/photodump", "POST", photodump({ selfie }), "a")), "a", a);
    const failed = gens[0];
    db().prepare("UPDATE generations SET status = 'failed' WHERE id = ?").run(failed.id);
    // B and the owner's photo: gone for A.
    expect((await retryRoute.POST(json("/api/photodump/retry", "POST", { id: failed.id }, "b"))).status).toBe(404);
    const t = Date.now();
    db()
      .prepare("INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, outputs_json, created_at, updated_at) VALUES ('owner-photo', 'photodump', 'oss-qwen-image-21', 'open', 'comfyui', 'edit', 'image', 'failed', ?, '[]', ?, ?)")
      .run(JSON.stringify({ feature: "photodump", modelId: "oss-qwen-image-21", prompt: "owner" }), t, t);
    expect((await retryRoute.POST(json("/api/photodump/retry", "POST", { id: "owner-photo" }, "a"))).status).toBe(404);
    expect(getGeneration("owner-photo")?.status).toBe("failed");
    fake.log.length = 0;
    const r = await run(() => retryRoute.POST(json("/api/photodump/retry", "POST", { id: failed.id }, "a")));
    expect(r.status, await r.clone().text()).toBe(201);
    const items = ((await r.json()) as { items: { id: string }[] }).items;
    await settle(items.map((i) => i.id));
    const again = getGeneration(items[0].id)!;
    expect(again.request.account).toBe(a);
    expect(again.status).toBe("succeeded");
    expect(again.batchId).toBe(failed.batchId);
    expect(getGeneration(failed.id, { includeDeleted: true })).toBeFalsy();
  });

  it("never reaches the owner's packs or characters, and the owner's lists stay the owner's", async () => {
    const ownerRef = saveFile({ data: TINY_PNG, contentType: "image/png", source: "upload", name: "owner-ref.png" }).url;
    db().prepare("INSERT INTO photodump_packs (id, name, refs_json, created_at) VALUES ('user-owner01', 'Owner pack', ?, ?)").run(JSON.stringify([ownerRef]), Date.now());
    const el = createElement({ name: "Owner Star", kind: "character", references: [ownerRef] });
    const list = (await (await packsRoute.GET(json("/api/photodump/packs", "GET", undefined, "a"))).json()) as { packs: { id: string }[] };
    expect(list.packs.map((p) => p.id)).not.toContain("user-owner01");
    expect((await packRoute.DELETE(json("/api/photodump/packs/user-owner01", "DELETE", undefined, "a"), params({ id: "user-owner01" }))).status).toBe(404);
    const usePack = await photodumpRoute.POST(json("/api/photodump?preview=1", "POST", photodump({ packId: "user-owner01", selfie }), "a"));
    expect((await usePack.json()).error).toBe("That pack no longer exists");
    const useEl = await fashionRoute.POST(json("/api/photodump/fashion", "POST", { step: "base", templateId: TEMPLATE.id, elementId: el.id, engine: "open" }, "a"));
    expect(useEl.status).toBe(422);
    expect((await useEl.json()).error).toBe("That character no longer exists");
    // A guest's price check doesn't find them either.
    const guest = await photodumpRoute.POST(json("/api/photodump?preview=1", "POST", photodump({ elementId: el.id })));
    expect((await guest.json()).error).toBe("That character no longer exists");
    expect(db().prepare("SELECT name FROM photodump_packs WHERE id = 'user-owner01'").get()).toEqual({ name: "Owner pack" });
    // The owner's own list still has it, and none of the accounts' packs.
    const owner = (await (await packsRoute.GET(json("/api/photodump/packs", "GET", undefined, "owner"))).json()) as { packs: { id: string }[] };
    expect(owner.packs.map((p) => p.id)).toEqual(["user-owner01"]);
    expect(await (await charactersRoute.GET(json("/api/photodump/characters", "GET", undefined, "owner"))).json()).toEqual({ items: [] });
  });
});

describe("an account's limits", () => {
  it("asks an account with neither a GPU nor a key to connect one, before anything is made", async () => {
    const own = runAsTenant({ kind: "account", id: c }, () => saveFile({ data: TINY_PNG, contentType: "image/png", source: "upload", name: "c.png" }).url);
    const n = (db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n;
    for (const send of [
      () => photodumpRoute.POST(json("/api/photodump", "POST", photodump({ selfie: own }), "c")),
      () => sheetRoute.POST(json("/api/photodump/character", "POST", { mode: "reference", engine: "open", images: [own] }, "c")),
      () => influencerRoute.POST(json("/api/influencer", "POST", { engine: "open", state: INFLUENCER_START, start: "scratch" }, "c")),
    ]) {
      const r = await send();
      expect(r.status).toBe(403);
      expect(r.headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
      expect((await r.json()).code).toBe("connect-gpu");
    }
    expect((db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n).toBe(n);
  });

  it("keeps runs going at once, a run's weight, and how many packs it keeps", async () => {
    const selfie = await upload("a", "limits.png");
    const now = Date.now();
    const add = db().prepare(
      "INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, outputs_json, created_at, updated_at) VALUES (?, 'photodump', 'oss-qwen-image-21', 'open', 'comfyui', 'edit', 'image', 'queued', ?, '[]', ?, ?)",
    );
    for (let i = 0; i < ACCOUNT_LIMITS.activeRuns; i++) add.run(`busy-photo-${i}`, JSON.stringify({ feature: "photodump", modelId: "oss-qwen-image-21", account: a }), now, now);
    const r = await photodumpRoute.POST(json("/api/photodump", "POST", photodump({ selfie }), "a"));
    expect(r.status).toBe(429);
    expect((await r.json()).code).toBe(access.ACTIVE_RUNS_CODE);
    db().prepare("DELETE FROM generations WHERE id LIKE 'busy-photo-%'").run();
    const big = new Request("http://localhost:3000/api/photodump", { method: "POST", headers: { host: "localhost:3000", cookie: cookies.a, "content-type": "application/json", "content-length": String(ACCOUNT_LIMITS.runBodyBytes + 1) }, body: "{}" });
    expect((await photodumpRoute.POST(big)).status).toBe(413);
    for (let i = store.listAccountProjects(a, PACK_KIND).length; i < store.ACCOUNT_PROJECT_LIMITS.projects; i++) store.createAccountProject(a, PACK_KIND, { name: `filler ${i}`, data: { refs: [selfie] } });
    const full = await packsRoute.POST(json("/api/photodump/packs", "POST", { name: "One more", refs: [selfie] }, "a"));
    expect(full.status).toBe(409);
  });

  it("goes with the account", async () => {
    const pic = await upload("b", "gone.png");
    expect((await packsRoute.POST(json("/api/photodump/packs", "POST", { name: "B pack", refs: [pic] }, "b"))).status).toBe(201);
    expect((await charactersRoute.POST(json("/api/photodump/characters", "POST", { name: "B", references: [pic] }, "b"))).status).toBe(201);
    await purgeAccount(b);
    expect(store.listAccountProjects(b, PACK_KIND)).toEqual([]);
    expect(store.listAccountProjects(b, CHARACTER_KIND)).toEqual([]);
  });
});
