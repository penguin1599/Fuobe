import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { startFakeComfy, TINY_PNG, type FakeComfy } from "./helpers/fake-comfy-runner";
import { tempDir } from "./helpers/temp-dir";

/**
 * Genjutsu for a signed-in account (public sign-up): it runs on the account's own ComfyUI (a stand-in here) through the
 * same generations every studio run makes, with only its own files, and its runs stay its own. A guest gets the sign-up
 * card; another account and the owner's Library are never reached.
 */
const dir = tempDir("fuobe-account-genjutsu-");
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
const genjutsuRoute = await import("@/app/api/genjutsu/route");
const estimateRoute = await import("@/app/api/genjutsu/estimate/route");
const describeRoute = await import("@/app/api/genjutsu/describe/route");
const transcribeRoute = await import("@/app/api/genjutsu/transcribe/route");
const sceneRoute = await import("@/app/api/genjutsu/scene/route");
const uploadsRoute = await import("@/app/api/uploads/route");
const gpuRoute = await import("@/app/api/account/gpu/route");
const { proxy } = await import("@/proxy");
const access = await import("@/lib/guest-access");
const { getGeneration, listGenerations } = await import("@/server/generations");
const { db } = await import("@/server/db");
const { resetRates } = await import("@/server/rate");
const { clearAccountLoras } = await import("@/server/account-loras");
const { saveFile } = await import("@/server/storage");
const { runAsTenant } = await import("@/server/tenant");
const { sceneRequest } = await import("@/server/genjutsu");
const { ACCOUNT_LIMITS } = await import("@/server/account-files");

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
  for (const [k, email] of [
    ["a", "genjutsu-a@example.com"],
    ["b", "genjutsu-b@example.com"],
    ["c", "genjutsu-c@example.com"],
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

/** What GET /api/generations?features=genjutsu lists for an account (the route lists its own runs only). */
const mine = (who: "a" | "b") => listGenerations({ features: ["genjutsu"], account: who === "a" ? a : b });

const motion = (clip: string, pic: string, extra: Record<string, unknown> = {}) => ({ engine: "open", mode: "motion", references: [pic], source: { url: clip, ...src }, range: { start: 0, end: 6 }, ...extra });

/** Start a run; a LoRA its ComfyUI lacks is put there (the 409 names it), then it is sent again. */
async function start(body: unknown, who: string): Promise<Response> {
  let r = await genjutsuRoute.POST(json("/api/genjutsu", "POST", body, who));
  if (r.status === 409) {
    const j = (await r.json()) as { code: string; fix: { items: { file: string }[] } };
    expect(j.code).toBe("comfy_missing_model");
    fake.opts.loras = [...(fake.opts.loras ?? []), ...j.fix.items.map((i) => i.file)];
    for (const id of [a, b]) clearAccountLoras(id);
    r = await genjutsuRoute.POST(json("/api/genjutsu", "POST", body, who));
  }
  return r;
}

describe("the proxy opens Genjutsu's runs to accounts, and keeps the sign-up card for guests", () => {
  it("a guest gets the sign-up card on a run, the part's words, what happens and describing the character", async () => {
    for (const p of ["/api/genjutsu", "/api/genjutsu/scene", "/api/genjutsu/transcribe", "/api/genjutsu/describe"]) {
      const r = viaProxy(p, "POST");
      expect(r.status, p).toBe(401);
      expect(r.headers.get(access.GUEST_HEADER), p).toBe("1");
      expect((await r.json()).error).toBe(access.GUEST_RUN_MESSAGE);
    }
    // A price check stays open to everyone.
    expect(passed(viaProxy("/api/genjutsu/estimate", "POST"))).toBe(true);
  });

  it("an account with its own GPU reaches the routes; one with neither a GPU nor a key is asked to connect one", async () => {
    for (const p of ["/api/genjutsu", "/api/genjutsu/scene", "/api/genjutsu/transcribe", "/api/genjutsu/describe"]) {
      expect(passed(viaProxy(p, "POST", "a")), p).toBe(true);
      const r = viaProxy(p, "POST", "c");
      expect(r.status, p).toBe(403);
      expect(r.headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
      expect((await r.json()).code).toBe("connect-gpu");
    }
    // Describing runs the GPU describer on the account's own GPU (tests/account-genjutsu-describe.test.ts).
    expect(access.ownGpuRun("POST", "/api/genjutsu/describe")).toBe(true);
    expect(access.ownGpuRun("GET", "/api/genjutsu")).toBe(false);
    expect(access.ownGpuRun("POST", "/api/genjutsu/examples")).toBe(false);
  });

  it("the routes refuse a guest themselves", async () => {
    for (const [route, p] of [
      [genjutsuRoute, "/api/genjutsu"],
      [sceneRoute, "/api/genjutsu/scene"],
      [transcribeRoute, "/api/genjutsu/transcribe"],
      [describeRoute, "/api/genjutsu/describe"],
    ] as const) {
      const r = await route.POST(json(p, "POST", {}));
      expect(r.status, p).toBe(401);
      expect(r.headers.get(access.GUEST_HEADER)).toBe("1");
    }
  });
});

describe("an account runs Genjutsu on its own ComfyUI", () => {
  let clip = "";
  let pic = "";
  let final = "";
  beforeAll(async () => {
    clip = await upload("a", CLIP, "video/mp4", "dance.mp4");
    pic = await upload("a", TINY_PNG, "image/png", "me.png");
  });

  it("prices it for its own GPU, never as a demo", async () => {
    const r = await estimateRoute.POST(json("/api/genjutsu/estimate", "POST", motion(clip, pic), "a"));
    expect(r.status, await r.clone().text()).toBe(200);
    const e = (await r.json()) as { demo: boolean; providers: string[] };
    expect(e.demo).toBe(false);
    expect(e.providers).toEqual(["comfyui"]);
  });

  it("runs Motion transfer end to end: every step is its own, on its ComfyUI, and the result is its own file", async () => {
    fake.log.length = 0;
    fetched.length = 0;
    const r = await start(motion(clip, pic, { requestId: "same-request-id-1" }), "a");
    expect(r.status, await r.clone().text()).toBe(201);
    const body = (await r.json()) as { final: { id: string }; items: { id: string; batchId: string | null }[] };
    final = body.final.id;
    expect(body.items.length).toBeGreaterThan(1);
    // One run: its steps share a batch.
    expect(new Set(body.items.map((g) => g.batchId)).size).toBe(1);
    for (const g of body.items) expect(getGeneration(g.id)!.request.account, g.id).toBe(a);
    const done = await settle(final);
    expect(done?.status, done?.error ?? "").toBe("succeeded");
    for (const g of body.items) expect(getGeneration(g.id)!.status, g.id).toBe("succeeded");
    // Every step went to its own ComfyUI; nothing reached the install's.
    expect(fake.log.filter((e) => e.path === "/prompt").length).toBe(body.items.length);
    expect(fetched.filter((u) => !u.endsWith("/system_stats"))).toEqual([]);
    // The result is its own file.
    const out = done!.outputs[0];
    expect(out.url).toMatch(/^\/api\/files\/outputs\//);
    expect((db().prepare("SELECT account_id FROM assets WHERE id = ?").get(out.assetId) as { account_id: string }).account_id).toBe(a);
    expect(passed(viaProxy(out.url, "GET", "a"))).toBe(true);
    // Its list shows it; the result opens for it (and downloads: the file above).
    const list = mine("a");
    expect(list.map((g) => g.id)).toContain(final);
    expect(passed(viaProxy(`/api/generations/${final}`, "GET", "a"))).toBe(true);
  });

  it("a second click with the same request id gets the same run", async () => {
    const r = await start(motion(clip, pic, { requestId: "same-request-id-1" }), "a");
    expect(r.status).toBe(201);
    expect(((await r.json()) as { final: { id: string } }).final.id).toBe(final);
  });

  it("another account never sees, opens or reuses it", async () => {
    // Its runs and files: 403 through the proxy, and not in B's list.
    const out = getGeneration(final)!.outputs[0].url;
    expect(viaProxy(`/api/generations/${final}`, "GET", "b").status).toBe(403);
    expect(viaProxy(out, "GET", "b").status).toBe(403);
    expect(viaProxy(out, "GET").status).toBe(401);
    const list = mine("b");
    expect(list).toEqual([]);
    // A's clip in B's run: refused before anything is planned or sent.
    fake.log.length = 0;
    const own = await upload("b", TINY_PNG, "image/png", "b.png");
    const r = await genjutsuRoute.POST(json("/api/genjutsu", "POST", motion(clip, own), "b"));
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe("input-not-yours");
    expect(fake.log.some((e) => e.path === "/prompt")).toBe(false);
    // The same request id from B is B's own request, never A's run.
    const bClip = await upload("b", CLIP, "video/mp4", "b.mp4");
    const bRun = await start(motion(bClip, own, { requestId: "same-request-id-1" }), "b");
    expect(bRun.status, await bRun.clone().text()).toBe(201);
    const bFinal = ((await bRun.json()) as { final: { id: string } }).final.id;
    expect(bFinal).not.toBe(final);
    expect(getGeneration(bFinal)!.request.account).toBe(b);
  });

  it("the owner's Library is never reachable: an owner's file is refused, and the owner's runs aren't in its list", async () => {
    const ownerClip = saveFile({ data: CLIP, contentType: "video/mp4", source: "upload", name: "owner.mp4" }).url;
    const r = await genjutsuRoute.POST(json("/api/genjutsu", "POST", motion(ownerClip, pic), "a"));
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe("input-not-yours");
    // Through the proxy the owner's file and the owner's Genjutsu runs are closed to it, and its list never has them.
    expect(viaProxy(ownerClip, "GET", "a").status).toBe(403);
    const t = Date.now();
    db()
      .prepare(
        "INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, outputs_json, created_at, updated_at) VALUES ('owner-genjutsu', 'genjutsu', 'oss-trim', 'open', 'comfyui', 'trim', 'video', 'succeeded', ?, ?, ?, ?)",
      )
      .run(JSON.stringify({ feature: "genjutsu", modelId: "oss-trim" }), JSON.stringify([{ url: ownerClip, kind: "video" }]), t, t);
    expect(viaProxy("/api/generations/owner-genjutsu", "GET", "a").status).toBe(403);
    expect(viaProxy("/api/generations/owner-genjutsu", "DELETE", "a").status).toBe(403);
    const ids = mine("a").map((g) => g.id);
    expect(ids).toContain(final);
    expect(ids).not.toContain("owner-genjutsu");
    // The owner's own result as an input: refused like any file that isn't its own.
    const reuse = await genjutsuRoute.POST(json("/api/genjutsu", "POST", motion(clip, ownerClip), "a"));
    expect(reuse.status).toBe(403);
    // A link or a data: URI never goes in.
    for (const url of ["https://example.com/a.mp4", "data:video/mp4;base64,AAAA"]) {
      const bad = await genjutsuRoute.POST(json("/api/genjutsu", "POST", motion(url, pic), "a"));
      expect(bad.status, url).toBe(400);
    }
  });

  it("asks an account with neither a GPU nor a key to connect one, before anything is made", async () => {
    const own = runAsTenant({ kind: "account", id: c }, () => saveFile({ data: CLIP, contentType: "video/mp4", source: "upload", name: "c.mp4" }).url);
    const n = (db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n;
    const r = await genjutsuRoute.POST(json("/api/genjutsu", "POST", motion(own, own), "c"));
    expect(r.status).toBe(403);
    expect(r.headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
    expect((await r.json()).code).toBe("connect-gpu");
    expect((db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n).toBe(n);
  });

  it("keeps the account's limits: runs going at once, and a refusal doesn't use up its hour", async () => {
    const now = Date.now();
    const add = db().prepare(
      "INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, outputs_json, created_at, updated_at) VALUES (?, 'genjutsu', 'oss-trim', 'open', 'comfyui', 'trim', 'video', 'queued', ?, '[]', ?, ?)",
    );
    for (let i = 0; i < ACCOUNT_LIMITS.activeRuns; i++) add.run(`busy-${i}`, JSON.stringify({ feature: "genjutsu", modelId: "oss-trim", account: a }), now, now);
    const r = await genjutsuRoute.POST(json("/api/genjutsu", "POST", motion(clip, pic), "a"));
    expect(r.status).toBe(429);
    expect((await r.json()).code).toBe(access.ACTIVE_RUNS_CODE);
    db().prepare("DELETE FROM generations WHERE id LIKE 'busy-%'").run();
    // A run body over what an account's run may weigh is refused before it is read.
    const big = new Request("http://localhost:3000/api/genjutsu", { method: "POST", headers: { host: "localhost:3000", cookie: cookies.a, "content-type": "application/json", "content-length": String(ACCOUNT_LIMITS.runBodyBytes + 1) }, body: "{}" });
    expect((await genjutsuRoute.POST(big)).status).toBe(413);
  });

  it("transcribes the clip's words on its own ComfyUI, and the clip must be its own", async () => {
    const r = await transcribeRoute.POST(json("/api/genjutsu/transcribe", "POST", { engine: "open", source: { url: clip, duration: 12 } }, "a"));
    expect(r.status, await r.clone().text()).toBe(201);
    const { id } = (await r.json()) as { id: string };
    expect(getGeneration(id)!.request.account).toBe(a);
    expect(getGeneration(id)!.provider).toBe("comfyui");
    const other = await transcribeRoute.POST(json("/api/genjutsu/transcribe", "POST", { engine: "open", source: { url: clip, duration: 12 } }, "b"));
    expect(other.status).toBe(403);
    expect((await other.json()).code).toBe("input-not-yours");
  });

  it("From picture's describer runs on an account's own GPU before From picture opens here; a first frame counts only for whoever made it", async () => {
    const r = await sceneRoute.POST(json("/api/genjutsu/scene", "POST", { engine: "open", source: { url: clip }, range: { start: 0, end: 6 }, ownPerson: true }, "a"));
    expect(r.status, await r.clone().text()).toBe(201);
    // On its own ComfyUI, never the install's.
    expect(fetched.filter((u) => !u.endsWith("/system_stats"))).toEqual([]);
    // A first frame the owner made is no account's; the account's own is its own.
    const frame = (account: string | null, url: string) => {
      const t = Date.now();
      db()
        .prepare(
          "INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, outputs_json, created_at, updated_at) VALUES (?, 'genjutsu-step', 'oss-from-picture-frame', 'open', 'comfyui', 'picture-frame', 'image', 'succeeded', ?, ?, ?, ?)",
        )
        .run(`frame-${url.length}-${t}`, JSON.stringify(account ? { account } : {}), JSON.stringify([{ url, kind: "image" }]), t, t);
    };
    frame(null, "/api/files/owner-frame.png");
    frame(a, "/api/files/a-frame.png");
    const ask = (who: string | null, url: string) => {
      const run = () => {
        try {
          sceneRequest({ engine: "open", source: { url: clip }, range: { start: 0, end: 6 }, frame: url }, { owner: true });
          return "";
        } catch (e) {
          return (e as Error).message;
        }
      };
      return who ? runAsTenant({ kind: "account", id: who }, run) : run();
    };
    expect(ask(a, "/api/files/a-frame.png")).toBe("");
    expect(ask(a, "/api/files/owner-frame.png")).toBe("Make and pick the first frame first");
    expect(ask(b, "/api/files/a-frame.png")).toBe("Make and pick the first frame first");
    expect(ask(null, "/api/files/owner-frame.png")).toBe("");
    expect(ask(null, "/api/files/a-frame.png")).toBe("Make and pick the first frame first");
  });
});
