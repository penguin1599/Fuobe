import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { keysSeen, startFakeFal, startFakeReplicate, type FakeCloud } from "./helpers/fake-cloud";
import { TINY_PNG } from "./helpers/fake-comfy-runner";
import { tempDir } from "./helpers/temp-dir";
import { dbBytes } from "./helpers/auth-db";

vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));
vi.mock("next/headers", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/headers")>()), cookies: async () => ({ delete: () => {}, get: () => undefined }) }));

/**
 * Your keys, end to end through the runs: an account's run, its uploads, polls, cancels (its own, on a timeout, during the
 * hand-over, the owner's, on deletion) and its chained steps reach fal.ai and Replicate with that account's own key only.
 * The owner's keys are set in Settings and in the environment all along, and the stand-ins accept them, so any leak
 * would succeed and show in their logs. An account without a key, or whose key can't be opened, sends nothing.
 */
const dir = tempDir("fuobe-keys-isolation-");
process.env.FUOBE_DATA_DIR = dir;
process.env.FUOBE_PUBLIC_SIGNUP = "1";
process.env.COMFYUI_URL = "http://owner-comfy.test:8188";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_ENGINE_MODE;
process.env.FAL_KEY = "owner-fal-env";
process.env.FAL_KEY_ID = "owner-fal-env-id";
process.env.FAL_KEY_SECRET = "owner-fal-env-secret";
process.env.REPLICATE_API_TOKEN = "owner-rep-env";
globalThis.__fuobeTestDiskFree = 1e13;

const auth = await import("@/server/auth");
const keys = await import("@/server/account-keys");
const generationsRoute = await import("@/app/api/generations/route");
const cancelRoute = await import("@/app/api/generations/[id]/cancel/route");
const adminRunRoute = await import("@/app/api/admin/generations/[id]/route");
const adminAccountRoute = await import("@/app/api/admin/accounts/[id]/route");
const meRoute = await import("@/app/api/auth/me/route");
const uploadsRoute = await import("@/app/api/uploads/route");
const statusRoute = await import("@/app/api/status/route");
const modelsRoute = await import("@/app/api/models/route");
const { proxy } = await import("@/proxy");
const gens = await import("@/server/generations");
const { db } = await import("@/server/db");
const { setSetting } = await import("@/server/settings");
const { resetRates, hit } = await import("@/server/rate");
const { runAsTenant } = await import("@/server/tenant");
const { MODELS, getModel } = await import("@/lib/catalog");
const { dualEngine } = await import("@/lib/catalog/engines");

let fal: FakeCloud;
let rep: FakeCloud;
let A = "";
let B = "";
let C = "";
let D = "";
const cookies: Record<string, string> = {};
const ownerCookie = () => `${auth.SESSION_COOKIE}=${auth.createSession().value}`;

beforeAll(async () => {
  fal = await startFakeFal();
  rep = await startFakeReplicate();
  globalThis.__fuobeTestFalUrl = fal.url;
  globalThis.__fuobeTestReplicateUrl = rep.url;
  for (const k of ["owner-fal-db", "owner-fal-env", "owner-fal-env-id:owner-fal-env-secret", "acct-fal-A", "acct-fal-B", "acct-fal-E"]) fal.keys[k] = "good";
  for (const k of ["owner-rep-db", "owner-rep-env", "acct-rep-A", "acct-rep-D"]) rep.keys[k] = "good";
  setSetting("falKey", "owner-fal-db");
  setSetting("replicateToken", "owner-rep-db");
  auth.setPassword("install password");
  A = auth.createAccount("iso-a@example.com", "long enough").id;
  B = auth.createAccount("iso-b@example.com", "long enough").id;
  C = auth.createAccount("iso-c@example.com", "long enough").id;
  D = auth.createAccount("iso-d@example.com", "long enough").id;
  keys.saveAccountKey(A, "fal", "acct-fal-A");
  keys.saveAccountKey(A, "replicate", "acct-rep-A");
  keys.saveAccountKey(B, "fal", "acct-fal-B");
  keys.saveAccountKey(D, "replicate", "acct-rep-D");
  for (const [n, id] of Object.entries({ A, B, C, D })) cookies[n] = `${auth.SESSION_COOKIE}=${auth.createSession(id).value}`;
});
afterAll(async () => {
  globalThis.__fuobeTestFalUrl = undefined;
  globalThis.__fuobeTestReplicateUrl = undefined;
  globalThis.__fuobeTestDiskFree = undefined;
  await fal.close();
  await rep.close();
});
beforeEach(async () => {
  resetRates();
  fal.holdSubmits = null;
  db().prepare("UPDATE generations SET status = 'canceled' WHERE status IN ('queued', 'running')").run();
  // Work still in flight from the last test (a hand-over landing, a poll) ends before the logs start afresh.
  await new Promise((r) => setTimeout(r, 150));
  fal.log.length = 0;
  rep.log.length = 0;
  fal.pollsToFinish = 2;
  rep.pollsToFinish = 2;
});

const post = (cookie: string, body: unknown, url = "/api/generations") => {
  const text = JSON.stringify(body);
  return generationsRoute.POST(new Request(`http://localhost:3000${url}`, { method: "POST", headers: { cookie, host: "localhost:3000", "content-type": "application/json", "content-length": String(text.length) }, body: text }));
};
const run = async (cookie: string, body: Record<string, unknown>) => {
  const r = await post(cookie, { feature: "image", prompt: "a quiet harbour at dawn", ...body });
  const json = await r.json();
  if (r.status !== 201) throw new Error(`${r.status}: ${JSON.stringify(json)}`);
  return json.items[0] as { id: string; provider: string };
};
const row = (id: string) => db().prepare("SELECT * FROM generations WHERE id = ?").get(id) as { status: string; error: string | null; external_id: string | null; message: string | null; provider: string; outputs_json: string; request_json: string };
/** Wait for the hand-over to land (an external id), without polling. */
async function handedOver(id: string) {
  for (let i = 0; i < 200 && !row(id).external_id && ["queued", "running"].includes(row(id).status); i++) await new Promise((r) => setTimeout(r, 10));
  return row(id);
}
/** Tick the runner until the row is done. */
async function settle(id: string, ms = 10_000) {
  const end = Date.now() + ms;
  await handedOver(id);
  for (;;) {
    await globalThis.__fuobeRunner?.tick();
    const g = row(id);
    if (!["queued", "running"].includes(g.status) || Date.now() > end) return g;
    await new Promise((r) => setTimeout(r, 30));
  }
}
const keyed = (f: FakeCloud) => f.log.filter((r) => !r.path.startsWith("/upload/"));

describe("an account's runs reach the provider with its own key only", () => {
  it("fal.ai: submit, polls (runner and fast lane) and the result", async () => {
    const g = await run(cookies.A, { modelId: "nano-banana-pro", engine: "cloud" });
    expect(g.provider).toBe("fal");
    const done = await settle(g.id);
    expect(done.status).toBe("succeeded");
    const outputs = JSON.parse(done.outputs_json) as { url: string }[];
    expect(outputs[0].url).toMatch(/^\/api\/files\//);
    expect(keysSeen(fal.log)).toEqual(["Key acct-fal-A"]);
    expect(rep.log).toEqual([]);
    // The fast lane polls a job near its end in the same scope.
    fal.log.length = 0;
    const g2 = await run(cookies.A, { modelId: "nano-banana-pro", engine: "cloud" });
    await handedOver(g2.id);
    db().prepare("UPDATE generations SET status = 'running', progress = 0.95 WHERE id = ?").run(g2.id);
    await globalThis.__fuobeRunner?.fast?.();
    // An account's polls run on their own (never holding up the owner's): wait for this one to land.
    for (let i = 0; i < 100 && !fal.log.some((r) => r.path.split("?")[0].endsWith("/status")); i++) await new Promise((r) => setTimeout(r, 10));
    expect(keysSeen(fal.log)).toEqual(["Key acct-fal-A"]);
    expect(fal.log.some((r) => r.path.split("?")[0].endsWith("/status"))).toBe(true);
  });

  it("fal.ai: its uploaded picture goes up with its key (none on the upload address)", async () => {
    const up = await uploadsRoute.POST(
      new Request("http://localhost:3000/api/uploads", { method: "POST", headers: { cookie: cookies.A, host: "localhost:3000", "content-type": "image/png", "x-file-name": "me.png", "content-length": String(TINY_PNG.length) }, body: TINY_PNG }),
    );
    expect(up.status).toBe(201);
    const file = (await up.json()) as { url: string };
    const g = await run(cookies.A, { modelId: "nano-banana-pro", engine: "cloud", op: "edit", inputs: { images: [file.url] } });
    expect((await settle(g.id)).status).toBe("succeeded");
    expect(fal.log.map((r) => r.path)).toContain("/storage/upload/initiate?storage_type=fal-cdn-v3");
    expect(keysSeen(keyed(fal))).toEqual(["Key acct-fal-A"]);
    expect(fal.log.filter((r) => r.path.startsWith("/upload/")).map((r) => r.authorization)).toEqual([undefined]);
  });

  it("Replicate: an account with only a Replicate key runs there, with its token", async () => {
    const g = await run(cookies.D, { modelId: "nano-banana-pro", engine: "cloud" });
    expect(g.provider).toBe("replicate");
    expect((await settle(g.id)).status).toBe("succeeded");
    const only = await run(cookies.A, { modelId: "imagen-4", engine: "cloud" });
    expect(only.provider).toBe("replicate");
    expect((await settle(only.id)).status).toBe("succeeded");
    expect(new Set(rep.log.map((r) => r.authorization))).toEqual(new Set(["Bearer acct-rep-D", "Bearer acct-rep-A"]));
    expect(fal.log).toEqual([]);
  });

  it("a timeout in the provider's queue cancels there, with the account's key", async () => {
    fal.pollsToFinish = Infinity;
    const g = await run(cookies.A, { modelId: "nano-banana-pro", engine: "cloud" });
    await handedOver(g.id);
    db().prepare("UPDATE generation_runs SET submitted_at = ? WHERE id = ?").run(Date.now() - 31 * 60_000, g.id);
    const done = await settle(g.id);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("This waited over 30 minutes to start. Press Retry.");
    const cancel = fal.log.find((r) => r.path.endsWith("/cancel"));
    expect(cancel?.authorization).toBe("Key acct-fal-A");
    expect(keysSeen(fal.log)).toEqual(["Key acct-fal-A"]);
  });

  it("its own cancel, a cancel during the hand-over, and the owner deleting its run: all with its key", async () => {
    fal.pollsToFinish = Infinity;
    const a = await run(cookies.A, { modelId: "nano-banana-pro", engine: "cloud" });
    await handedOver(a.id);
    await cancelRoute.POST(new Request(`http://localhost:3000/api/generations/${a.id}/cancel`, { method: "POST", headers: { cookie: cookies.A } }), { params: Promise.resolve({ id: a.id }) });
    expect(row(a.id).status).toBe("canceled");
    // During the hand-over: the provider holds the submit; the cancel lands first, then the job is stopped there.
    let release!: () => void;
    fal.holdSubmits = new Promise((r) => (release = r));
    const b = await run(cookies.A, { modelId: "nano-banana-pro", engine: "cloud" });
    while (!fal.log.some((r) => r.method === "POST" && r.body.includes("harbour") && fal.log.indexOf(r) > 1)) await new Promise((r) => setTimeout(r, 5));
    await gens.cancelGeneration(b.id);
    release();
    for (let i = 0; i < 100 && fal.canceled.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(row(b.id).status).toBe("canceled");
    // The owner deletes an account's run, outside any account's scope.
    fal.holdSubmits = null;
    const c = await run(cookies.A, { modelId: "nano-banana-pro", engine: "cloud" });
    await handedOver(c.id);
    const del = await adminRunRoute.DELETE(new Request(`http://localhost:3000/api/admin/generations/${c.id}`, { method: "DELETE", headers: { cookie: ownerCookie() } }), { params: Promise.resolve({ id: c.id }) });
    expect(del.status).toBe(204);
    const cancels = fal.log.filter((r) => r.path.endsWith("/cancel"));
    expect(cancels).toHaveLength(3);
    expect(keysSeen(fal.log)).toEqual(["Key acct-fal-A"]);
  });

  it("a chained step on fal.ai is planned and sent in the account's scope", async () => {
    const [first] = gens.asAccount(A, () => gens.createGenerations({ feature: "image", modelId: "nano-banana-pro", engine: "cloud", prompt: "first", account: A }));
    const [second] = gens.asAccount(A, () =>
      gens.createGenerations({ feature: "image", modelId: "nano-banana-pro", engine: "cloud", op: "edit", prompt: "second", chainFrom: "first", account: A }, { dependsOn: first.id }),
    );
    expect((await settle(first.id)).status).toBe("succeeded");
    expect((await settle(second.id)).status).toBe("succeeded");
    expect(fal.log.filter((r) => r.method === "POST" && !r.path.startsWith("/storage")).map((r) => JSON.parse(r.body).prompt)).toEqual(["first", "second"]);
    expect(keysSeen(keyed(fal))).toEqual(["Key acct-fal-A"]);
  });

  it("the owner's runs in the same process still use the owner's key", async () => {
    const g = await run(ownerCookie(), { modelId: "nano-banana-pro", engine: "cloud" });
    expect((await settle(g.id)).status).toBe("succeeded");
    expect(keysSeen(fal.log)).toEqual(["Key owner-fal-db"]);
  });

  it("owner, A and B at once: every request carries only its own key, the runner started inside an account's request", async () => {
    let release!: () => void;
    fal.holdSubmits = new Promise((r) => (release = r));
    const runs = await Promise.all([run(cookies.A, { modelId: "nano-banana-pro", engine: "cloud", prompt: "from A" }), run(ownerCookie(), { modelId: "nano-banana-pro", engine: "cloud", prompt: "from owner" }), run(cookies.B, { modelId: "nano-banana-pro", engine: "cloud", prompt: "from B" })]);
    while (fal.log.filter((r) => r.method === "POST").length < 3) await new Promise((r) => setTimeout(r, 5));
    release();
    fal.holdSubmits = null;
    await Promise.all(runs.map((g) => settle(g.id)));
    const want: Record<string, string> = { "from A": "Key acct-fal-A", "from owner": "Key owner-fal-db", "from B": "Key acct-fal-B" };
    for (const r of fal.log.filter((x) => x.method === "POST")) expect(r.authorization).toBe(want[JSON.parse(r.body).prompt]);
    // Each job's polls carry its own key too.
    const owners = new Map(runs.map((g) => [db().prepare("SELECT external_id FROM generations WHERE id = ?").pluck().get(g.id) as string, g]));
    for (const r of fal.log.filter((x) => x.method === "GET")) {
      const ext = /requests\/([^/]+)/.exec(r.path)?.[1];
      const g = ext ? owners.get(ext) : undefined;
      if (!g) continue;
      const i = runs.indexOf(g);
      expect(r.authorization).toBe(["Key acct-fal-A", "Key owner-fal-db", "Key acct-fal-B"][i]);
    }
  });
});

describe("no fallback, ever", () => {
  it("an account without a key gets Add your key for a paid model, and nothing reaches either provider", async () => {
    auth.setAccountGpu(C, { url: "https://gpu.example" });
    try {
      const r = await post(cookies.C, { feature: "image", modelId: "nano-banana-pro", engine: "cloud", prompt: "x" });
      expect(r.status).toBe(403);
      expect(r.headers.get("x-fuobe-add-key")).toBe("fal");
      expect(await r.json()).toMatchObject({ code: "add-key", provider: "fal", error: expect.stringMatching(/^Add your fal\.ai key/) });
      // A refused run doesn't count against its runs an hour.
      expect(hit(`run:${C}`, 60, 3_600_000).ok).toBe(true);
    } finally {
      auth.setAccountGpu(C, null);
    }
    // With neither a GPU nor a key, the proxy answers first.
    const p = proxy(new NextRequest("http://localhost:3000/api/generations", { method: "POST", headers: { cookie: cookies.C }, body: "{}" }));
    expect(p.status).toBe(403);
    expect((await p.json()).error).toMatch(/Connect your GPU to/);
    // B has a fal.ai key only: a Replicate-only model asks for a Replicate key.
    const r = await post(cookies.B, { feature: "image", modelId: "imagen-4", engine: "cloud", prompt: "x" });
    expect(r.status).toBe(403);
    expect(r.headers.get("x-fuobe-add-key")).toBe("replicate");
    expect(fal.log).toEqual([]);
    expect(rep.log).toEqual([]);
  });

  it("an account whose key this server can't open (secrets.key replaced) is asked to add it again, with nothing sent", async () => {
    const file = path.join(dir, "secrets.key");
    const saved = fs.readFileSync(file);
    fs.writeFileSync(file, "ef".repeat(32));
    fs.utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    try {
      const r = await post(cookies.B, { feature: "image", modelId: "nano-banana-pro", engine: "cloud", prompt: "x" });
      expect(r.status).toBe(403);
      expect(r.headers.get("x-fuobe-add-key")).toBe("fal");
      expect(fal.log).toEqual([]);
    } finally {
      fs.writeFileSync(file, saved);
      fs.utimesSync(file, new Date(Date.now() + 120_000), new Date(Date.now() + 120_000));
    }
    expect(keys.accountKey(B, "fal")).toBe("acct-fal-B");
  });

  it("a guest's price check reaches no provider, and no provider counts as connected for it", async () => {
    const r = await generationsRoute.POST(
      new Request("http://localhost:3000/api/generations?preview=1", { method: "POST", headers: { host: "localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ feature: "image", modelId: "nano-banana-pro", prompt: "x" }) }),
    );
    expect(r.status).toBeLessThan(500);
    gens.asVisitor(null, () => expect(gens.previewGeneration).toBeDefined());
    const { falProvider } = await import("@/server/providers/fal");
    gens.asVisitor(null, () => expect(falProvider.isConfigured()).toBe(false));
    expect(fal.log).toEqual([]);
    expect(rep.log).toEqual([]);
  });

  it("the runner refuses an adapter call outside its run's own account", () => {
    expect(() => gens.adapterFor("fal", A)).toThrow(/can't find that run/);
    runAsTenant({ kind: "account", id: B }, () => expect(() => gens.adapterFor("fal", A)).toThrow(/can't find that run/));
    runAsTenant({ kind: "account", id: A }, () => expect(() => gens.adapterFor("fal", undefined)).toThrow(/can't find that run/));
    runAsTenant({ kind: "account", id: A }, () => expect(gens.adapterFor("fal", A).id).toBe("fal"));
    expect(gens.adapterFor("fal", undefined).id).toBe("fal");
  });

  it("a row whose request can't be read can't be stored (and the runner would fail one, never poll it as the owner's)", () => {
    const now = Date.now();
    const insert = () =>
      db()
        .prepare(
          "INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, outputs_json, external_id, external_meta_json, created_at, updated_at) VALUES ('broken-row', 'image', 'nano-banana-pro', 'cloud', 'fal', 't2i', 'image', 'running', '{not json', '[]', 'x', '{}', ?, ?)",
        )
        .run(now, now);
    // The account index reads request_json, so SQLite refuses the row; generations.ts accountOf fails one closed anyway.
    expect(insert).toThrow(/malformed JSON/);
  });

  it("a stored address outside fal.ai is never sent the key", async () => {
    const g = await run(cookies.A, { modelId: "nano-banana-pro", engine: "cloud" });
    await handedOver(g.id);
    fal.log.length = 0;
    db().prepare("UPDATE generations SET external_meta_json = ? WHERE id = ?").run(JSON.stringify({ statusUrl: "https://collector.example/s", responseUrl: "https://collector.example/r", cancelUrl: "https://collector.example/c" }), g.id);
    const real = globalThis.fetch;
    const elsewhere: string[] = [];
    globalThis.fetch = (async (u: RequestInfo | URL, init?: RequestInit) => {
      const url = String(u instanceof Request ? u.url : u);
      if (url.includes("collector.example")) elsewhere.push(url);
      return real(u, init);
    }) as typeof fetch;
    try {
      await globalThis.__fuobeRunner?.tick();
      await gens.cancelGeneration(g.id);
    } finally {
      globalThis.fetch = real;
    }
    expect(elsewhere).toEqual([]);
  });
});

describe("deleting an account stops its paid runs with its key, then forgets the key", () => {
  it("by the owner, and by the account itself", async () => {
    for (const how of ["owner", "self"] as const) {
      const id = auth.createAccount(`gone-${how}@example.com`, "long enough").id;
      keys.saveAccountKey(id, "fal", "acct-fal-E");
      const cookie = `${auth.SESSION_COOKIE}=${auth.createSession(id).value}`;
      fal.pollsToFinish = Infinity;
      fal.log.length = 0;
      const g = await run(cookie, { modelId: "nano-banana-pro", engine: "cloud" });
      await handedOver(g.id);
      const res =
        how === "owner"
          ? await adminAccountRoute.DELETE(new Request(`http://localhost:3000/api/admin/accounts/${id}`, { method: "DELETE", headers: { cookie: ownerCookie() } }), { params: Promise.resolve({ id }) })
          : await meRoute.DELETE(new Request("http://localhost:3000/api/auth/me", { method: "DELETE", headers: { cookie, host: "localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ password: "long enough" }) }));
      expect(res.status, how).toBe(204);
      const cancel = fal.log.find((r) => r.path.endsWith("/cancel"));
      expect(cancel?.authorization, how).toBe("Key acct-fal-E");
      expect(auth.accountById(id), how).toBeUndefined();
      expect(dbBytes(dir)).not.toContain(`gone-${how}@example.com`);
      expect(keysSeen(fal.log)).toEqual(["Key acct-fal-E"]);
    }
  });
});

describe("routing for an account", () => {
  it("status and models follow its own keys", async () => {
    const status = async (cookie: string) => (await statusRoute.GET(new Request("http://localhost:3000/api/status", { headers: { cookie, host: "localhost:3000" } }))).json();
    const a = await status(cookies.A);
    expect(a).toMatchObject({ engineMode: "both", demoMode: "off", providers: { fal: { configured: true }, replicate: { configured: true } }, viewer: { kind: "account", keys: ["fal", "replicate"], paidAllowed: true } });
    const c = await status(cookies.C);
    expect(c).toMatchObject({ engineMode: "open", providers: { fal: { configured: false }, replicate: { configured: false } }, viewer: { keys: [] } });
    const d = await status(cookies.D);
    expect(d.viewer.keys).toEqual(["replicate"]);
    for (const s of [a, c, d]) expect(JSON.stringify(s)).not.toMatch(/acct-|owner-fal|owner-rep|v1\./);
    const models = async (cookie: string, q: string) => (await modelsRoute.GET(new Request(`http://localhost:3000/api/models?${q}`, { headers: { cookie, host: "localhost:3000" } }))).json();
    const am = await models(cookies.A, "kind=image&engine=cloud");
    expect(am.engineMode).toBe("both");
    expect(am.items.find((m: { id: string }) => m.id === "nano-banana-pro")).toMatchObject({ connected: true, runs: "real" });
    const bm = await models(cookies.B, "kind=image&engine=cloud");
    expect(bm.items.find((m: { id: string }) => m.id === "imagen-4")).toMatchObject({ connected: false, runs: "refused" });
    // A Replicate-only account never starts on a fal.ai-only video default.
    const dm = await models(cookies.D, "kind=video");
    const dv = dm.defaults.video.cloud as string | undefined;
    const repVideo = MODELS.some((m) => !m.hidden && m.kind === "video" && m.routes.some((r) => r.provider === "replicate"));
    if (repVideo) expect(getModel(dv!)!.routes.some((r) => r.provider === "replicate")).toBe(true);
    expect((await models(cookies.C, "")).engineMode).toBe("open");
  });

  it("an account's run keeps the engine it asked for; fal.ai first among its keys, whatever the owner's order", () => {
    setSetting("cloudProvider", "replicate");
    try {
      const route = (id: string, modelId = "nano-banana-pro") => gens.asAccount(id, () => gens.previewGeneration({ feature: "image", modelId, prompt: "x", engine: "cloud", account: id }).route.provider);
      expect(route(A)).toBe("fal");
      expect(route(D)).toBe("replicate");
      // The owner's own runs keep the owner's choice.
      expect(gens.previewGeneration({ feature: "image", modelId: "nano-banana-pro", prompt: "x", engine: "cloud" }).route.provider).toBe("replicate");
    } finally {
      setSetting("cloudProvider", "");
    }
    const original = MODELS.find((m) => dualEngine(m) && m.kind === "image" && m.routes.some((r) => r.provider === "fal"));
    if (original) {
      const [g] = gens.asAccount(A, () => gens.createGenerations({ feature: "image", modelId: original.id, prompt: "x", engine: "cloud", account: A }));
      expect(JSON.parse(row(g.id).request_json ?? "{}").engine ?? "cloud").toBe("cloud");
      void gens.cancelGeneration(g.id);
    }
  });

  it("an open-source-only studio keeps an account with a key on open models", async () => {
    setSetting("engineMode", "open");
    try {
      expect(keys.accountEngineMode(A)).toBe("open");
      const r = await post(cookies.A, { feature: "image", modelId: "nano-banana-pro", engine: "cloud", prompt: "x" });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(fal.log).toEqual([]);
      expect(gens.accountRun(A, "fal")).toMatchObject({ code: "open-only" });
      // A job already going still finishes or stops on its key.
      expect("run" in gens.accountRun(A, "fal", "poll")).toBe(true);
    } finally {
      setSetting("engineMode", "");
    }
  });

  it("text steps, the AI helpers, 3D and the other tools stay closed to an account with a key", async () => {
    expect(gens.accountRun(A, "llm")).toMatchObject({ code: "own-gpu-tool" });
    const at = (url: string) => proxy(new NextRequest(`http://localhost:3000${url}`, { method: "POST", headers: { cookie: cookies.A }, body: "{}" }));
    for (const url of ["/api/assist", "/api/enhance", "/api/shorts", "/api/content-factory/claude", "/api/explainer/link"]) {
      const r = at(url);
      expect(r.status, url).toBe(403);
    }
    expect(at("/api/generations").headers.get("x-middleware-next")).toBe("1");
    // An account switched off: its new runs stop; a job already going finishes or stops on its key.
    auth.setAccountDisabled(B, true);
    try {
      expect(gens.accountRun(B, "fal")).toMatchObject({ code: "switched-off" });
      expect("run" in gens.accountRun(B, "fal", "cancel")).toBe(true);
    } finally {
      auth.setAccountDisabled(B, false);
    }
  });
});

describe("a run its provider never took", () => {
  it("says it was not billed (an empty balance at submit); a run fal.ai took keeps its price", async () => {
    const id = auth.createAccount("not-billed@example.com", "long enough").id;
    fal.keys["acct-fal-broke"] = "broke";
    keys.saveAccountKey(id, "fal", "acct-fal-broke");
    const cookie = `${auth.SESSION_COOKIE}=${auth.createSession(id).value}`;
    const g = await run(cookie, { modelId: "nano-banana-pro", engine: "cloud" });
    const failed = await settle(g.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("Your fal.ai balance has run out. Top it up on fal.ai, then run again.");
    const shown = gens.getGeneration(g.id)!;
    expect(shown.costUsd).toBeGreaterThan(0);
    expect(shown.notBilled).toBe(true);
    const ok = await run(cookies.A, { modelId: "nano-banana-pro", engine: "cloud" });
    expect((await settle(ok.id)).status).toBe("succeeded");
    expect(gens.getGeneration(ok.id)!.notBilled).toBeUndefined();
  });
});

describe("deleting an account while its run is being handed over", () => {
  it("stops the job at fal.ai with its key when the submit lands, then the account and its key go", async () => {
    const id = auth.createAccount("gone-handover@example.com", "long enough").id;
    keys.saveAccountKey(id, "fal", "acct-fal-E");
    const cookie = `${auth.SESSION_COOKIE}=${auth.createSession(id).value}`;
    fal.pollsToFinish = Infinity;
    fal.canceled.length = 0;
    let release!: () => void;
    fal.holdSubmits = new Promise((r) => (release = r));
    const g = await run(cookie, { modelId: "nano-banana-pro", engine: "cloud" });
    while (!fal.log.some((r) => r.method === "POST" && !r.path.startsWith("/storage"))) await new Promise((r) => setTimeout(r, 5));
    const pending = adminAccountRoute.DELETE(new Request(`http://localhost:3000/api/admin/accounts/${id}`, { method: "DELETE", headers: { cookie: ownerCookie() } }), { params: Promise.resolve({ id }) });
    for (let i = 0; i < 200 && db().prepare("SELECT 1 FROM generations WHERE id = ?").get(g.id); i++) await new Promise((r) => setTimeout(r, 10));
    expect(auth.accountById(id)).toBeDefined();
    release();
    expect((await pending).status).toBe(204);
    expect(fal.canceled).toHaveLength(1);
    expect(fal.log.find((r) => r.path.endsWith("/cancel"))?.authorization).toBe("Key acct-fal-E");
    expect(keysSeen(fal.log)).toEqual(["Key acct-fal-E"]);
    expect(auth.accountById(id)).toBeUndefined();
  });
});
