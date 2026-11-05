import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { startFakeComfy, TINY_GLB, TINY_PNG, type FakeComfy } from "./helpers/fake-comfy-runner";
import { tempDir } from "./helpers/temp-dir";

/**
 * Image to 3D for a signed-in account (public sign-up): it runs on the account's own ComfyUI (a stand-in here) through
 * POST /api/image-to-3d, with only its own files; its model is finished on this server under the account's limits, and
 * its models and their files stay its own. A guest gets the sign-up card; another account and the owner's Library are
 * never reached; on this install's GPUs (hosted runs) 3D stays refused.
 */
const dir = tempDir("fuobe-account-3d-");
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
const route = await import("@/app/api/image-to-3d/route");
const uploadsRoute = await import("@/app/api/uploads/route");
const gpuRoute = await import("@/app/api/account/gpu/route");
const { proxy } = await import("@/proxy");
const access = await import("@/lib/guest-access");
const { createGenerations, getGeneration, listGenerations, asAccount } = await import("@/server/generations");
const { db } = await import("@/server/db");
const { resetRates } = await import("@/server/rate");
const { saveFile } = await import("@/server/storage");
const { runAsTenant } = await import("@/server/tenant");
const { withRunStamp } = await import("@/server/run-stamp");
const { ACCOUNT_LIMITS, accountTotalBytes, accountUsage } = await import("@/server/account-files");
const { model3dAllowed } = await import("@/server/account-tool-run");
const { ACCOUNT_TURNTABLE, accountFinishProblem, finishModel } = await import("@/server/model3d-finish");
const { model3dRequest, rigRequest } = await import("@/lib/av/model3d");
const { nanoid } = await import("nanoid");

let fake: FakeComfy;
let a = "";
let b = "";
let c = "";
const cookies: Record<string, string> = {};
beforeAll(async () => {
  fake = await startFakeComfy({ loras: [], delayMs: 0, output: "model3d" });
  globalThis.__fuobeTestGpuPort = fake.port;
  auth.setPassword("install password");
  for (const [k, email] of [
    ["a", "threed-a@example.com"],
    ["b", "threed-b@example.com"],
    ["c", "threed-c@example.com"],
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
  globalThis.__fuobeTestDiskFree = 1e13;
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

const ownerOf = (assetId: string | undefined) => (db().prepare("SELECT account_id FROM assets WHERE id = ?").get(assetId) as { account_id: string | null } | undefined)?.account_id;
const fromImage = (photo: string) => model3dRequest({ engine: "open", mode: "image", modelId: "oss-pixal3d", photo });
const mine = (id: string) => listGenerations({ features: ["image-to-3d"], account: id });

describe("the proxy opens Image to 3D's runs to accounts, and keeps the sign-up card for guests", () => {
  it("a guest gets the sign-up card; an account with its own GPU reaches the route; one with neither a GPU nor a key is asked to connect one", async () => {
    const g = viaProxy("/api/image-to-3d", "POST");
    expect(g.status).toBe(401);
    expect(g.headers.get(access.GUEST_HEADER)).toBe("1");
    expect((await g.json()).error).toBe(access.GUEST_RUN_MESSAGE);
    expect(passed(viaProxy("/api/image-to-3d", "POST", "a"))).toBe(true);
    const r = viaProxy("/api/image-to-3d", "POST", "c");
    expect(r.status).toBe(403);
    expect(r.headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
    expect((await r.json()).code).toBe("connect-gpu");
    expect(access.ownGpuRun("POST", "/api/image-to-3d")).toBe(true);
    expect(access.ownGpuRun("GET", "/api/image-to-3d")).toBe(false);
    expect(access.ownGpuRun("POST", "/api/image-to-3d/other")).toBe(false);
  });

  it("the route refuses a guest itself, and the owner's run goes through the studios' route", async () => {
    const r = await route.POST(json("/api/image-to-3d", "POST", fromImage("/api/files/x.png")));
    expect(r.status).toBe(401);
    expect(r.headers.get(access.GUEST_HEADER)).toBe("1");
    // The owner's request is POST /api/generations' own (its answer to a body it can't read).
    const own = await route.POST(json("/api/image-to-3d", "POST", { nothing: true }, "owner"));
    expect(own.status).toBe(400);
    expect((await own.json()).error).toMatch(/feature/);
  });
});

describe("an account makes a 3D model on its own ComfyUI", () => {
  let photo = "";
  let made = "";
  beforeAll(async () => {
    photo = await upload("a", TINY_PNG, "image/png", "lamp.png");
  });

  it("runs end to end: the model is made on its ComfyUI, finished here, and every file is its own", async () => {
    fake.log.length = 0;
    fetched.length = 0;
    const r = await route.POST(json("/api/image-to-3d", "POST", { ...fromImage(photo), requestId: "same-3d-request" }, "a"));
    expect(r.status, await r.clone().text()).toBe(201);
    const { items } = (await r.json()) as { items: { id: string }[] };
    expect(items).toHaveLength(1);
    made = items[0].id;
    expect(getGeneration(made)!.request.account).toBe(a);
    expect(getGeneration(made)!.provider).toBe("comfyui");
    const done = await settle(made);
    expect(done?.status, done?.error ?? "").toBe("succeeded");
    // Made on its own ComfyUI; nothing reached the install's.
    expect(fake.log.filter((e) => e.path === "/prompt")).toHaveLength(1);
    expect(fetched.filter((u) => !u.endsWith("/system_stats"))).toEqual([]);
    // The raw GLB and the web GLB the finish made are its own files; no turntable on the server.
    const model = done!.outputs.find((o) => o.kind === "model3d")!;
    expect(model.contentType).toBe("model/gltf-binary");
    expect(ownerOf(model.assetId)).toBe(a);
    const finish = model.meta?.finish as { webAsset?: string; turntable?: string; error?: string };
    expect(finish.error).toBeUndefined();
    expect(finish.turntable).toBe(ACCOUNT_TURNTABLE);
    expect(ownerOf(finish.webAsset)).toBe(a);
    const web = model.meta?.web as string;
    expect(web).toMatch(/^\/api\/files\//);
    expect(web).not.toBe(model.url);
    // It opens and downloads both (the proxy lets its own files through), and its list shows the model.
    expect(passed(viaProxy(model.url, "GET", "a"))).toBe(true);
    expect(passed(viaProxy(web, "GET", "a"))).toBe(true);
    expect(passed(viaProxy(`/api/generations/${made}`, "GET", "a"))).toBe(true);
    expect(mine(a).map((g) => g.id)).toContain(made);
  }, 120_000);

  it("a second click with the same request id gets the same run", async () => {
    const r = await route.POST(json("/api/image-to-3d", "POST", { ...fromImage(photo), requestId: "same-3d-request" }, "a"));
    expect(r.status).toBe(201);
    expect(((await r.json()) as { items: { id: string }[] }).items[0].id).toBe(made);
  });

  it("another account never sees, opens, downloads or reuses its model", async () => {
    const model = getGeneration(made)!.outputs.find((o) => o.kind === "model3d")!;
    for (const url of [model.url, model.meta?.web as string, `/api/generations/${made}`]) {
      expect(viaProxy(url, "GET", "b").status, url).toBe(403);
      expect(viaProxy(url, "GET").status, url).toBe(401);
    }
    expect(viaProxy(`/api/generations/${made}`, "DELETE", "b").status).toBe(403);
    expect(mine(b)).toEqual([]);
    fake.log.length = 0;
    // A's photo, or A's model to rig, in B's run: refused before anything is planned or sent.
    for (const req of [fromImage(photo), rigRequest({ glb: model.url })]) {
      const r = await route.POST(json("/api/image-to-3d", "POST", req, "b"));
      expect(r.status, req.modelId).toBe(403);
      expect((await r.json()).code).toBe("input-not-yours");
    }
    expect(fake.log.some((e) => e.path === "/prompt")).toBe(false);
    // The same request id from B is B's own request, never A's run.
    const own = await upload("b", TINY_PNG, "image/png", "b.png");
    const r = await route.POST(json("/api/image-to-3d", "POST", { ...fromImage(own), requestId: "same-3d-request" }, "b"));
    expect(r.status, await r.clone().text()).toBe(201);
    const id = ((await r.json()) as { items: { id: string }[] }).items[0].id;
    expect(id).not.toBe(made);
    expect(getGeneration(id)!.request.account).toBe(b);
  });

  it("the owner's files and 3D models are never reachable", async () => {
    const ownerPhoto = saveFile({ data: TINY_PNG, contentType: "image/png", source: "upload", name: "owner.png" }).url;
    const ownerGlb = saveFile({ data: TINY_GLB, contentType: "model/gltf-binary", source: "generation", name: "owner.glb" }).url;
    for (const req of [fromImage(ownerPhoto), rigRequest({ glb: ownerGlb })]) {
      const r = await route.POST(json("/api/image-to-3d", "POST", req, "a"));
      expect(r.status, req.modelId).toBe(403);
      expect((await r.json()).code).toBe("input-not-yours");
    }
    const t = Date.now();
    db()
      .prepare(
        "INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, outputs_json, created_at, updated_at) VALUES ('owner-3d', 'image-to-3d', 'oss-pixal3d', 'open', 'comfyui', 'image-to-3d', 'model3d', 'succeeded', ?, ?, ?, ?)",
      )
      .run(JSON.stringify({ feature: "image-to-3d", modelId: "oss-pixal3d" }), JSON.stringify([{ url: ownerGlb, kind: "model3d" }]), t, t);
    expect(viaProxy("/api/generations/owner-3d", "GET", "a").status).toBe(403);
    expect(viaProxy(ownerGlb, "GET", "a").status).toBe(403);
    expect(mine(a).map((g) => g.id)).not.toContain("owner-3d");
    // A link or a data: URI never goes in.
    for (const url of ["https://example.com/a.png", "data:image/png;base64,AAAA"]) {
      const r = await route.POST(json("/api/image-to-3d", "POST", fromImage(url), "a"));
      expect(r.status, url).toBe(400);
    }
  });

  it("takes 3D models only, and asks an account with neither a GPU nor a key to connect one before anything is made", async () => {
    const r = await route.POST(json("/api/image-to-3d", "POST", { feature: "image", modelId: "oss-z-image-turbo", prompt: "a lamp" }, "a"));
    expect(r.status).toBe(422);
    const own = runAsTenant({ kind: "account", id: c }, () => saveFile({ data: TINY_PNG, contentType: "image/png", source: "upload", name: "c.png" }).url);
    const n = (db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n;
    const refused = await route.POST(json("/api/image-to-3d", "POST", fromImage(own), "c"));
    expect(refused.status).toBe(403);
    expect(refused.headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
    expect((await refused.json()).code).toBe("connect-gpu");
    expect((db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n).toBe(n);
  });

  it("keeps the account's run limits: runs going at once, the hour, and what a request may weigh", async () => {
    const now = Date.now();
    const add = db().prepare(
      "INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, outputs_json, created_at, updated_at) VALUES (?, 'image-to-3d', 'oss-pixal3d', 'open', 'comfyui', 'image-to-3d', 'model3d', 'queued', ?, '[]', ?, ?)",
    );
    for (let i = 0; i < ACCOUNT_LIMITS.activeRuns; i++) add.run(`busy-3d-${i}`, JSON.stringify({ feature: "image-to-3d", modelId: "oss-pixal3d", account: a }), now, now);
    const r = await route.POST(json("/api/image-to-3d", "POST", fromImage(photo), "a"));
    expect(r.status).toBe(429);
    expect((await r.json()).code).toBe(access.ACTIVE_RUNS_CODE);
    db().prepare("DELETE FROM generations WHERE id LIKE 'busy-3d-%'").run();
    const big = new Request("http://localhost:3000/api/image-to-3d", { method: "POST", headers: { host: "localhost:3000", cookie: cookies.a, "content-type": "application/json", "content-length": String(ACCOUNT_LIMITS.runBodyBytes + 1) }, body: "{}" });
    expect((await route.POST(big)).status).toBe(413);
  });
});

describe("an account's 3D finish runs under its limits", () => {
  /** A raw GLB of an account's run, as the runner stores it. */
  const rawOf = (account: string) => {
    const asset = runAsTenant({ kind: "account", id: account }, () => saveFile({ data: TINY_GLB, contentType: "model/gltf-binary", source: "generation", name: "raw.glb" }));
    return [{ url: asset.url, kind: "model3d" as const, contentType: "model/gltf-binary", assetId: asset.id }];
  };
  const finishOf = (o: { meta?: Record<string, unknown> }[]) => o[0].meta?.finish as { error?: string; webAsset?: string };

  it("file size: a model over 300 MB is kept as it came", () => {
    expect(accountFinishProblem(a, 300 * 2 ** 20 + 1)).toMatch(/over 300 MB/);
    expect(accountFinishProblem(a, 1024)).toBeNull();
  });

  it("disk room: a server short of room keeps the model as it came, with no web GLB", async () => {
    globalThis.__fuobeTestDiskFree = 0;
    const out = await finishModel(`gen-${nanoid(6)}`, rawOf(a), { op: "image-to-3d", provider: "comfyui", account: a });
    expect(finishOf(out).error).toMatch(/short of room/);
    expect(finishOf(out).webAsset).toBeUndefined();
    expect(out[0].meta?.web).toBeUndefined();
    // The owner's model is finished as before.
    const own = saveFile({ data: TINY_GLB, contentType: "model/gltf-binary", source: "generation", name: "own.glb" });
    const mine = await finishModel(`gen-${nanoid(6)}`, [{ url: own.url, kind: "model3d", contentType: "model/gltf-binary", assetId: own.id }], { op: "image-to-3d", provider: "comfyui" });
    expect(finishOf(mine).error).toBeUndefined();
  }, 60_000);

  it("its files' room: full files keep the model as it came, and a web GLB that wouldn't fit isn't stored", async () => {
    const id = auth.createAccount(`threed-room-${nanoid(6)}@example.com`, "long enough").id;
    const raw = rawOf(id);
    const pad = db().prepare("INSERT INTO assets (id, kind, name, rel_path, content_type, size, source, generation_id, created_at, account_id) VALUES (?, 'other', 'pad', ?, 'application/octet-stream', ?, 'generation', NULL, ?, ?)");
    // Just short of its room: the finish runs, but its web GLB has no room.
    pad.run(`pad-${id}`, `outputs/pad-${id}.bin`, accountTotalBytes(id) - accountUsage(id).total - 8, Date.now(), id);
    const tight = await finishModel(`gen-${nanoid(6)}`, raw, { op: "image-to-3d", provider: "comfyui", account: id });
    expect(finishOf(tight).error).toMatch(/no room/);
    expect(tight[0].meta?.web).toBeUndefined();
    // Full: not even started.
    db().prepare("UPDATE assets SET size = size + 8 WHERE id = ?").run(`pad-${id}`);
    expect(accountFinishProblem(id, 1024)).toMatch(/files are full/);
    db().prepare("DELETE FROM assets WHERE id = ?").run(`pad-${id}`);
  }, 60_000);

  it("an hour's finishes: past the limit the model is kept as it came", async () => {
    for (let i = 0; i < ACCOUNT_LIMITS.modelFinishesPerHour; i++) expect(accountFinishProblem(b, 1024), String(i)).toBeNull();
    expect(accountFinishProblem(b, 1024)).toMatch(/this hour/);
    const out = await finishModel(`gen-${nanoid(6)}`, rawOf(b), { op: "image-to-3d", provider: "comfyui", account: b });
    expect(finishOf(out).error).toMatch(/this hour/);
    // Another account's hour is its own.
    expect(accountFinishProblem(a, 1024)).toBeNull();
  });
});

describe("3D is allowed on the account's own GPU or key, and refused on this install's GPUs", () => {
  it("the tool runs' placement check", () => {
    expect(model3dAllowed({ kind: "own" })).toBe(true);
    expect(model3dAllowed({ kind: "pool" })).toBe(false);
  });

  it("a run stamped for this install's GPUs is refused when it is made; the account's own is made", () => {
    const photo = runAsTenant({ kind: "account", id: a }, () => saveFile({ data: TINY_PNG, contentType: "image/png", source: "upload", name: "p.png" }).url);
    const req = fromImage(photo);
    expect(() => asAccount(a, () => withRunStamp({ place: "pool" }, () => createGenerations(req)))).toThrow(access.OWN_GPU_TOOL_MESSAGE);
    const made = asAccount(a, () => createGenerations(req));
    expect(made[0].kind).toBe("model3d");
    expect(made[0].request.account).toBe(a);
  });
});
