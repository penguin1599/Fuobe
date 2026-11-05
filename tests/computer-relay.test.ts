import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FAKE_PNG, startLocalComfy, type LocalComfy } from "./helpers/fake-local-comfy";
import { loadRoutes, tab, type ComputerRoutes } from "./helpers/computer-tab";
import { tempDir } from "./helpers/temp-dir";

vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));
vi.setConfig({ testTimeout: 60_000 });

const dir = tempDir("fuobe-computer-relay-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://owner-comfy.test:8188";
process.env.FUOBE_PUBLIC_SIGNUP = "1";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_ALLOW_PRIVATE_URLS;
globalThis.__fuobeTestDiskFree = 1e13;

// The server's own fetch: recorded. Nothing of a run on someone's computer may reach any ComfyUI from here.
const realFetch = globalThis.fetch;
const fetched: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  fetched.push(url);
  if (url.startsWith("http://owner-comfy.test")) return new Response("the install's ComfyUI must not be called", { status: 599 });
  return realFetch(input, init);
}) as typeof fetch;

const auth = await import("@/server/auth");
const generationsRoute = await import("@/app/api/generations/route");
const uploadsRoute = await import("@/app/api/uploads/route");
const gpuRoute = await import("@/app/api/account/gpu/route");
const { getGeneration } = await import("@/server/generations");
const { db } = await import("@/server/db");
const { resetRates } = await import("@/server/rate");
const { RELAY_WORDS } = await import("@/lib/relay");
const { lastGpuDevice } = await import("@/server/account-gpu");

let fake: LocalComfy;
let routes: ComputerRoutes;
let a = "";
let cookie = "";
const SITE_HEADERS = { host: "localhost:3000", "sec-fetch-site": "same-origin", origin: "http://localhost:3000" };

beforeAll(async () => {
  fake = await startLocalComfy({ cors: "http://localhost:3000", steps: 3, stepMs: 10, latencyMs: 10 });
  routes = await loadRoutes();
  auth.setPassword("install password");
  a = auth.createAccount("computer@example.com", "long enough").id;
  cookie = `${auth.SESSION_COOKIE}=${auth.createSession(a).value}`;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  globalThis.__fuobeTestDiskFree = undefined;
  await fake.close();
});
beforeEach(() => {
  resetRates();
  Object.assign(fake.opts, { failNext: undefined, outputs: ["image"], metaBatch: undefined, steps: 3, stepMs: 10 });
  db().prepare("UPDATE generations SET status = 'canceled' WHERE status IN ('queued', 'running')").run();
  db().prepare("DELETE FROM relay_runners").run();
});

const json = (url: string, method: string, body: unknown) => {
  const text = JSON.stringify(body);
  return new Request(`http://localhost:3000${url}`, { method, headers: { cookie, ...SITE_HEADERS, "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) }, body: text });
};

async function uploadPng(): Promise<{ url: string; id: string }> {
  const r = await uploadsRoute.POST(new Request("http://localhost:3000/api/uploads", { method: "POST", headers: { cookie, ...SITE_HEADERS, "content-type": "image/png", "x-file-name": "me.png", "content-length": String(FAKE_PNG.length) }, body: FAKE_PNG }));
  expect(r.status).toBe(201);
  return r.json();
}

async function run(body: Record<string, unknown>): Promise<string[]> {
  const r = await generationsRoute.POST(json("/api/generations", "POST", body));
  const j = await r.json();
  expect(r.status, JSON.stringify(j)).toBe(201);
  return (j.items as { id: string }[]).map((g) => g.id);
}

const tick = () => globalThis.__fuobeRunner?.tick();

/** Until the run has been handed over (its job exists), ticking the runner. */
async function handedOver(id: string) {
  const handed = () => (db().prepare("SELECT external_id FROM generations WHERE id = ?").get(id) as { external_id: string | null } | undefined)?.external_id;
  for (let i = 0; i < 200 && !handed(); i++) {
    await tick();
    await new Promise((r) => setTimeout(r, 20));
  }
  await tick();
}

/** Tick the server's runner until the row is done (or the time is up). */
async function settle(id: string, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    await tick();
    const g = getGeneration(id, { includeDeleted: true });
    if (!g || (g.status !== "queued" && g.status !== "running") || Date.now() > end) return g;
    await new Promise((r) => setTimeout(r, 60));
  }
}

const going = () => (db().prepare("SELECT COUNT(*) AS n FROM generations WHERE status IN ('queued', 'running')").get() as { n: number }).n;

/** The tab runs every job there is, while the server's runner keeps polling, until no run is going (or the time is up). */
async function work(t: ReturnType<typeof tab>, ms = 20_000) {
  const end = Date.now() + ms;
  while (going() && Date.now() < end) {
    await t.runner.beat();
    await t.runner.claimAndRun();
    await tick();
    await new Promise((r) => setTimeout(r, 30));
  }
}

describe("a run on the ComfyUI on the person's own computer", () => {
  it("connects with one call, waits for the tab, then runs there end to end", async () => {
    const put = await gpuRoute.PUT(json("/api/account/gpu", "PUT", { mode: "computer" }));
    expect(put.status).toBe(200);
    expect((await put.json()).gpu).toMatchObject({ mode: "computer", online: false });
    const pic = await uploadPng();
    fetched.length = 0;
    const [id] = await run({ feature: "app", modelId: "oss-qwen-edit", presetId: "app-headshot-generator", prompt: "", inputs: { images: [pic.url] } });
    await handedOver(id);
    // No tab yet: the tile says what to do, and the run waits.
    expect(getGeneration(id)).toMatchObject({ status: "queued", message: RELAY_WORDS.noComputer });
    const t = tab(routes, cookie, fake.port);
    const beat = await t.runner.beat();
    expect(beat).toMatchObject({ runner: true, heldElsewhere: false, waiting: 1 });
    await tick();
    expect(getGeneration(id)?.message).toBe(RELAY_WORDS.starting);
    // The GPU's facts reached the account's state, never its command line.
    const state = await (await gpuRoute.GET(new Request("http://localhost:3000/api/account/gpu", { headers: { cookie, ...SITE_HEADERS } }))).json();
    expect(state.gpu).toMatchObject({ mode: "computer", online: true, device: "cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync", version: "0.42.0", port: fake.port, cors: "exact" });
    expect(JSON.stringify(state)).not.toMatch(/private|base-directory/);
    // A price check reads the GPU the tab reported (Split soundtrack's pick), and never calls it.
    expect(lastGpuDevice(a)).toBe("cuda");

    fake.log.length = 0;
    expect(await t.runner.claimAndRun()).toBe(true);
    const g = await settle(id);
    expect(g?.status, g?.error ?? "").toBe("succeeded");
    // The picture went to ComfyUI under the name the server chose, byte for byte; then the server's own graph and id.
    const up = fake.log.find((e) => e.path === "/upload/image");
    expect(up?.upload?.name).toMatch(/^fuobe_[A-Za-z0-9_-]{12}\.png$/);
    expect(up?.upload?.bytes.equals(FAKE_PNG)).toBe(true);
    const posted = fake.log.find((e) => e.path === "/prompt")!.prompt!;
    expect(JSON.stringify(posted.prompt)).toContain(up!.upload!.name);
    expect(posted.prompt_id).toBe((db().prepare("SELECT external_id FROM generations WHERE id = ?").get(id) as { external_id: string }).external_id);
    expect(posted.extra_data).toEqual({ preview_method: "auto" });
    expect(fake.log.every((e) => e.origin === "http://localhost:3000" || e.method === "WS")).toBe(true);
    // The result is the account's own, stored as what its bytes are.
    const out = g!.outputs[0];
    expect(out).toMatchObject({ kind: "image", contentType: "image/png" });
    const asset = db().prepare("SELECT account_id, rel_path FROM assets WHERE id = ?").get(out.assetId) as { account_id: string; rel_path: string };
    expect(asset.account_id).toBe(a);
    expect(fs.readFileSync(path.join(dir, "files", asset.rel_path)).equals(FAKE_PNG)).toBe(true);
    // Nothing of it reached a ComfyUI from the server.
    // (The owner's own reachability check of the studio's ComfyUI is the owner's, not the run's.)
    expect(fetched.filter((u) => (u.includes("owner-comfy.test") && !u.endsWith("/system_stats")) || u.includes(`:${fake.port}`))).toEqual([]);
    // The tab saw it through: sending, running with steps, saving, done.
    expect(t.runner.view.jobs.find((j) => j.generationId === id)?.phase).toBe("done");
  });

  it("a ComfyUI paired with a code that is off: the run waits in words for that ComfyUI, not for a browser tab", async () => {
    expect((await gpuRoute.PUT(json("/api/account/gpu", "PUT", { mode: "computer" }))).status).toBe(200);
    // Its paired ComfyUI (Fuobe Connect, device "connect-…") beat a while ago, then went quiet: its pod stopped.
    db()
      .prepare("INSERT INTO relay_runners (principal, device, lease_until, seen_at, port, facts_json, comfy) VALUES (?, ?, ?, ?, NULL, '{}', 'ok')")
      .run(`acct:${a}`, "connect-pod-1", 0, Date.now() - 10 * 60_000);
    const pic = await uploadPng();
    const [id] = await run({ feature: "app", modelId: "oss-qwen-edit", presetId: "app-headshot-generator", prompt: "", inputs: { images: [pic.url] } });
    await handedOver(id);
    expect(getGeneration(id)).toMatchObject({ status: "queued", message: RELAY_WORDS.pairedAway });
    expect(RELAY_WORDS.pairedAway).not.toMatch(/Open Fuobe/);
    expect(RELAY_WORDS.pairedWaitedTooLong(30 * 60_000)).toBe("Your paired ComfyUI didn't come online for 30 minutes. Start it, then press Retry.");
  });

  it("explains a refusal for a missing model or node with the guided fix, and running out of memory in plain words", async () => {
    const t = tab(routes, cookie, fake.port);
    await t.runner.beat();
    const pic = await uploadPng();
    fake.opts.failNext = "missing_model";
    const [m] = await run({ feature: "app", modelId: "oss-qwen-edit", presetId: "app-headshot-generator", prompt: "", inputs: { images: [pic.url] } });
    await work(t);
    const missing = await settle(m);
    expect(missing?.status).toBe("failed");
    expect(missing?.fix).toMatchObject({ code: "comfy_missing_model" });
    fake.opts.failNext = "missing_node";
    const [n] = await run({ feature: "app", modelId: "oss-qwen-edit", presetId: "app-headshot-generator", prompt: "", inputs: { images: [pic.url] } });
    await work(t);
    const node = await settle(n);
    expect(node?.fix).toMatchObject({ code: "comfy_missing_node", items: [{ class: "FancyNode" }] });
    fake.opts.failNext = "oom";
    const [o] = await run({ feature: "app", modelId: "oss-qwen-edit", presetId: "app-headshot-generator", prompt: "", inputs: { images: [pic.url] } });
    await work(t);
    expect((await settle(o))?.error).toBe(RELAY_WORDS.outOfMemory);
  });

  it("runs a two-step run step by step on the computer: the second step gets the first one's result", async () => {
    const t = tab(routes, cookie, fake.port);
    await t.runner.beat();
    const pic = await uploadPng();
    fake.log.length = 0;
    const ids = await run({ feature: "video", modelId: "fuobe-dop", presetId: "effect-window", prompt: "", inputs: { images: [pic.url] } });
    const all = () => db().prepare("SELECT id, status, depends_on FROM generations WHERE batch_id = (SELECT batch_id FROM generations WHERE id = ?) OR id = ? OR depends_on = ?").all(ids[0], ids[0], ids[0]) as { id: string; status: string; depends_on: string | null }[];
    // The first step makes a picture, the second a clip from it.
    fake.opts.outputs = ["image"];
    for (let i = 0; i < 400 && going(); i++) {
      await t.runner.beat();
      await t.runner.claimAndRun();
      await tick();
      const rows = all();
      const second = rows.find((r) => r.depends_on);
      if (second && rows.find((r) => r.id !== second.id)?.status === "succeeded") fake.opts.outputs = ["video"];
      await new Promise((r) => setTimeout(r, 30));
    }
    const rows = all();
    expect(rows.length).toBe(2);
    for (const r of rows) expect(getGeneration(r.id)?.status, getGeneration(r.id)?.error ?? "").toBe("succeeded");
    const prompts = fake.log.filter((e) => e.path === "/prompt");
    expect(prompts).toHaveLength(2);
    // The second prompt loads what the first one made, sent to ComfyUI again under a name of its own.
    const uploads = fake.log.filter((e) => e.path === "/upload/image");
    expect(uploads).toHaveLength(2);
    expect(uploads[1].upload!.bytes.equals(FAKE_PNG)).toBe(true);
    expect(JSON.stringify(prompts[1].prompt!.prompt)).toContain(uploads[1].upload!.name);
  });

  it("picks a job up again after a reload, without sending it twice", async () => {
    fake.opts.steps = 30;
    fake.opts.stepMs = 30;
    const first = tab(routes, cookie, fake.port, { device: "device-reload-1" });
    await first.runner.beat();
    const pic = await uploadPng();
    const [id] = await run({ feature: "app", modelId: "oss-qwen-edit", presetId: "app-headshot-generator", prompt: "", inputs: { images: [pic.url] } });
    await handedOver(id);
    const posts = fake.posts();
    // The tab sends it, then the page reloads mid-run (the old runner is gone).
    const running = first.runner.claimAndRun();
    for (let i = 0; i < 100 && fake.posts() === posts; i++) await new Promise((r) => setTimeout(r, 20));
    first.runner.stop();
    await running.catch(() => {});
    const again = tab(routes, cookie, fake.port, { device: "device-reload-1", clientId: "client-test-1" });
    fake.opts.stepMs = 5;
    await work(again);
    const g = await settle(id);
    expect(g?.status, g?.error ?? "").toBe("succeeded");
    expect(fake.posts() - posts).toBe(1);
  });

  it("a tab with no ComfyUI to reach (a phone, a laptop without one) never takes the jobs from the computer that has one", async () => {
    const phone = tab(routes, cookie, fake.port, { device: "device-phone-1", local: async () => Promise.reject(new TypeError("Failed to fetch")) });
    const pic = await uploadPng();
    const [id] = await run({ feature: "app", modelId: "oss-qwen-edit", presetId: "app-headshot-generator", prompt: "", inputs: { images: [pic.url] } });
    await handedOver(id);
    expect(await phone.runner.beat()).toMatchObject({ runner: false, heldElsewhere: false, waiting: 1 });
    expect(phone.runner.view.comfy).toBe("down");
    expect(await phone.runner.claimAndRun()).toBe(false);
    // The computer with ComfyUI takes them, and the phone hears that another computer runs them.
    const desk = tab(routes, cookie, fake.port, { device: "device-desk-1" });
    expect(await desk.runner.beat()).toMatchObject({ runner: true });
    expect(await phone.runner.beat()).toMatchObject({ runner: false, heldElsewhere: true });
    expect(await phone.runner.beat(true)).toMatchObject({ runner: false });
    await work(desk);
    const g = await settle(id);
    expect(g?.status, g?.error ?? "").toBe("succeeded");
    // A runner whose ComfyUI restarts keeps its place meanwhile.
    fake.opts.cors = "off";
    expect(await desk.runner.beat()).toMatchObject({ runner: true });
    fake.opts.cors = "http://localhost:3000";
  });

  it("ComfyUI started without Fuobe's setting: the tab says so steadily, takes nothing, and the run and the status strip say the same", async () => {
    const t = tab(routes, cookie, fake.port);
    await t.runner.beat();
    fake.opts.cors = "off";
    try {
      const pic = await uploadPng();
      const [id] = await run({ feature: "app", modelId: "oss-qwen-edit", presetId: "app-headshot-generator", prompt: "", inputs: { images: [pic.url] } });
      await handedOver(id);
      const seen = new Set<string>();
      const off = t.runner.onChange((v) => seen.add(v.comfy));
      const posts = fake.posts();
      for (let i = 0; i < 3; i++) {
        expect(await t.runner.beat()).toMatchObject({ runner: true, waiting: 1 });
        expect(await t.runner.claimAndRun()).toBe(false);
      }
      off();
      // One story, never "isn't answering" in between.
      expect([...seen]).toEqual(["no-setting"]);
      expect(fake.posts()).toBe(posts);
      await tick();
      expect(getGeneration(id)?.message).toBe(RELAY_WORDS.comfyNoSetting);
      const { gpuState } = await import("@/server/account-gpu");
      expect(await gpuState(a, { mode: "computer" })).toMatchObject({ online: false, comfy: "no-setting" });
      // ComfyUI comes back with the setting: the run goes on by itself.
      fake.opts.cors = "http://localhost:3000";
      await work(t);
      expect((await settle(id))?.status).toBe("succeeded");
      expect(await gpuState(a, { mode: "computer" })).toMatchObject({ online: true });
    } finally {
      fake.opts.cors = "http://localhost:3000";
    }
  });

  it("ComfyUI restarted without the setting while it ran a job: the run says the setting is missing, then goes on", async () => {
    fake.opts.steps = 60;
    fake.opts.stepMs = 30;
    const t = tab(routes, cookie, fake.port);
    await t.runner.beat();
    const pic = await uploadPng();
    const [id] = await run({ feature: "app", modelId: "oss-qwen-edit", presetId: "app-headshot-generator", prompt: "", inputs: { images: [pic.url] } });
    await handedOver(id);
    const job = t.runner.claimAndRun();
    for (let i = 0; i < 200 && !t.runner.view.jobs.some((j) => j.phase === "running"); i++) await new Promise((r) => setTimeout(r, 20));
    fake.opts.cors = "off";
    try {
      for (let i = 0; i < 200 && (db().prepare("SELECT down_why FROM relay_tasks WHERE generation_id = ?").get(id) as { down_why: string | null }).down_why !== "setting"; i++) await new Promise((r) => setTimeout(r, 20));
      await tick();
      expect(getGeneration(id)?.message).toBe(RELAY_WORDS.comfyNoSetting);
      expect(t.runner.view.comfy).toBe("no-setting");
    } finally {
      fake.opts.cors = "http://localhost:3000";
    }
    await job;
    await work(t);
    expect((await settle(id))?.status).toBe("succeeded");
  });

  it("a tab with nothing remembered finds ComfyUI on another port by itself, and runs there", async () => {
    const { ComputerRunner } = await import("@/lib/computer-runner");
    const { apiAs, browserLocal, sha256 } = await import("./helpers/computer-tab");
    const moved: number[] = [];
    // It starts where nothing answers (the port the studio last heard of, or 8188), as a second browser would.
    const runner = new ComputerRunner(
      {
        api: apiAs(routes, cookie),
        local: browserLocal(),
        socket: (url) => new WebSocket(url) as never,
        sha256,
        origin: "http://localhost:3000",
        sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
        find: async () => ({ port: fake.port }),
        moved: (port) => moved.push(port),
      },
      { device: "device-second-browser", port: 3399, clientId: "client-second-browser" },
    );
    await runner.beat();
    expect(runner.view).toMatchObject({ port: fake.port, comfy: "ok" });
    expect(moved).toEqual([fake.port]);
    const pic = await uploadPng();
    const [id] = await run({ feature: "app", modelId: "oss-qwen-edit", presetId: "app-headshot-generator", prompt: "", inputs: { images: [pic.url] } });
    await work({ runner } as never);
    expect((await settle(id))?.status).toBe("succeeded");
  });

  it("a browser that may not reach this computer yet hears how many runs wait, and never touches ComfyUI or takes the jobs", async () => {
    const urls: string[] = [];
    const listening = tab(routes, cookie, fake.port, { device: "device-asking-1", access: "ask", local: async (u) => (urls.push(u), Promise.reject(new TypeError("no"))) });
    const pic = await uploadPng();
    const [id] = await run({ feature: "app", modelId: "oss-qwen-edit", presetId: "app-headshot-generator", prompt: "", inputs: { images: [pic.url] } });
    await handedOver(id);
    expect(await listening.runner.beat()).toMatchObject({ runner: false, waiting: 1 });
    expect(await listening.runner.claimAndRun()).toBe(false);
    expect(urls).toEqual([]);
    const desk = tab(routes, cookie, fake.port, { device: "device-desk-2" });
    expect(await desk.runner.beat()).toMatchObject({ runner: true });
    await work(desk);
    expect((await settle(id))?.status).toBe("succeeded");
  });

  it("sends a job again once when ComfyUI restarts and loses it, and fails it kindly the second time", async () => {
    const t = tab(routes, cookie, fake.port);
    await t.runner.beat();
    const pic = await uploadPng();
    fake.opts.failNext = "gone";
    const [id] = await run({ feature: "app", modelId: "oss-qwen-edit", presetId: "app-headshot-generator", prompt: "", inputs: { images: [pic.url] } });
    const posts = fake.posts();
    await work(t);
    const g = await settle(id);
    expect(g?.status, g?.error ?? "").toBe("succeeded");
    expect(fake.posts() - posts).toBe(2);
    // Lost twice: the run says what happened, and how to go on.
    fake.opts.loseNext = 2;
    const [lost] = await run({ feature: "app", modelId: "oss-qwen-edit", presetId: "app-headshot-generator", prompt: "", inputs: { images: [pic.url] } });
    await work(t);
    expect((await settle(lost))?.error).toBe(RELAY_WORDS.lost);
    expect(fake.opts.loseNext).toBe(0);
  });

  it("takes a canceled job off the computer's ComfyUI", async () => {
    fake.opts.steps = 200;
    fake.opts.stepMs = 30;
    const t = tab(routes, cookie, fake.port);
    await t.runner.beat();
    const pic = await uploadPng();
    const [id] = await run({ feature: "app", modelId: "oss-qwen-edit", presetId: "app-headshot-generator", prompt: "", inputs: { images: [pic.url] } });
    await handedOver(id);
    fake.log.length = 0;
    const running = t.runner.claimAndRun();
    for (let i = 0; i < 100 && !fake.log.some((e) => e.path === "/prompt"); i++) await new Promise((r) => setTimeout(r, 20));
    const { cancelGeneration } = await import("@/server/generations");
    await cancelGeneration(id);
    await t.runner.beat();
    await running;
    for (let i = 0; i < 50 && !fake.log.some((e) => /^\/api\/jobs\/[^/]+\/cancel$/.test(e.path)); i++) await new Promise((r) => setTimeout(r, 20));
    expect(fake.log.some((e) => /^\/api\/jobs\/[^/]+\/cancel$/.test(e.path))).toBe(true);
    expect(getGeneration(id)?.status).toBe("canceled");
    await t.runner.beat();
    expect(db().prepare("SELECT stop FROM relay_tasks WHERE generation_id = ?").get(id)).toEqual({ stop: 0 });
  });

  it("says Fuobe couldn't reach the computer after 30 minutes without a tab", async () => {
    const pic = await uploadPng();
    const [id] = await run({ feature: "app", modelId: "oss-qwen-edit", presetId: "app-headshot-generator", prompt: "", inputs: { images: [pic.url] } });
    await handedOver(id);
    db().prepare("UPDATE generation_runs SET submitted_at = submitted_at - ? WHERE id = ?").run(31 * 60_000, id);
    const g = await settle(id);
    expect(g?.status).toBe("failed");
    expect(g?.error).toBe("Fuobe couldn't reach your computer for 30 minutes. Open Fuobe there, then press Retry.");
    expect((db().prepare("SELECT state FROM relay_tasks WHERE generation_id = ?").get(id) as { state: string }).state).toBe("canceled");
  });

  it("runs the owner's runs on the owner's computer when Settings says so, and never calls the studio's own ComfyUI", async () => {
    const { setSetting } = await import("@/server/settings");
    setSetting("comfyWhere", "computer");
    setSetting("engineMode", "open");
    setSetting("demoMode", "off");
    const owner = `${auth.SESSION_COOKIE}=${auth.createSession().value}`;
    try {
      const asOwner = (url: string, method: string, body: unknown) => {
        const text = JSON.stringify(body);
        return new Request(`http://localhost:3000${url}`, { method, headers: { cookie: owner, ...SITE_HEADERS, "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) }, body: text });
      };
      fetched.length = 0;
      const r = await generationsRoute.POST(asOwner("/api/generations", "POST", { feature: "image", modelId: "oss-z-image-turbo", prompt: "a lighthouse at dusk" }));
      const j = await r.json();
      expect(r.status, JSON.stringify(j)).toBe(201);
      const id = (j.items as { id: string }[])[0].id;
      await handedOver(id);
      expect((db().prepare("SELECT principal FROM relay_tasks WHERE generation_id = ?").get(id) as { principal: string }).principal).toBe("owner");
      const t = tab(routes, owner, fake.port, { device: "device-owner-1" });
      await work(t);
      const g = await settle(id);
      expect(g?.status, g?.error ?? "").toBe("succeeded");
      expect((db().prepare("SELECT account_id FROM assets WHERE id = ?").get(g!.outputs[0].assetId) as { account_id: string | null }).account_id).toBeNull();
      expect(fetched.filter((u) => u.includes("owner-comfy.test"))).toEqual([]);
      // A run on a computer can't reach the studio's ComfyUI even by mistake.
      const { comfyLoraFiles, onComputer } = await import("@/server/providers/comfyui");
      expect(await onComputer("owner", () => comfyLoraFiles())).toBeNull();
    } finally {
      setSetting("comfyWhere", "server");
    }
  });

  it("follows each run where it was sent when Settings moves ComfyUI: a run on the computer stops saying why, one on the studio's ComfyUI goes on there", async () => {
    const { setSetting } = await import("@/server/settings");
    const settingsRoute = await import("@/app/api/settings/route");
    const { comfyProvider } = await import("@/server/providers/comfyui");
    setSetting("comfyWhere", "computer");
    setSetting("engineMode", "open");
    setSetting("demoMode", "off");
    const owner = `${auth.SESSION_COOKIE}=${auth.createSession().value}`;
    try {
      const text = JSON.stringify({ feature: "image", modelId: "oss-z-image-turbo", prompt: "a lighthouse at dusk" });
      const r = await generationsRoute.POST(new Request("http://localhost:3000/api/generations", { method: "POST", headers: { cookie: owner, ...SITE_HEADERS, "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) }, body: text }));
      expect(r.status).toBe(201);
      const id = ((await r.json()).items as { id: string }[])[0].id;
      await handedOver(id);
      fetched.length = 0;
      await settingsRoute.PUT(new Request("http://localhost:3000/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ comfyWhere: "server" }) }));
      const g = await settle(id);
      expect(g?.status).toBe("failed");
      expect(g?.error).toBe(RELAY_WORDS.switched);
      expect(fetched.filter((u) => u.includes("owner-comfy.test"))).toEqual([]);

      // The other way: a run sent to the studio's ComfyUI is still asked about there, and stopped there.
      setSetting("comfyWhere", "computer");
      fetched.length = 0;
      const ctx = { externalId: "11111111-1111-4111-8111-111111111111", meta: {}, model: undefined } as unknown as Parameters<typeof comfyProvider.poll>[0];
      const polled = await comfyProvider.poll(ctx).catch(() => null);
      expect(polled?.state === "failed" && /lost|disappeared/i.test(polled.error ?? "")).toBe(false);
      expect(fetched.some((u) => u.startsWith("http://owner-comfy.test:8188/history/11111111"))).toBe(true);
      fetched.length = 0;
      await comfyProvider.cancel!(ctx).catch(() => null);
      expect(fetched.some((u) => u.startsWith("http://owner-comfy.test:8188/"))).toBe(true);
    } finally {
      setSetting("comfyWhere", "server");
    }
  });

  it("the owner's Disconnect stops a run on the computer saying so, not that ComfyUI moved", async () => {
    const { setSetting } = await import("@/server/settings");
    const settingsRoute = await import("@/app/api/settings/route");
    setSetting("comfyWhere", "computer");
    setSetting("engineMode", "open");
    setSetting("demoMode", "off");
    const owner = `${auth.SESSION_COOKIE}=${auth.createSession().value}`;
    try {
      const text = JSON.stringify({ feature: "image", modelId: "oss-z-image-turbo", prompt: "a lighthouse at dusk" });
      const r = await generationsRoute.POST(new Request("http://localhost:3000/api/generations", { method: "POST", headers: { cookie: owner, ...SITE_HEADERS, "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) }, body: text }));
      expect(r.status).toBe(201);
      const id = ((await r.json()).items as { id: string }[])[0].id;
      await handedOver(id);
      await settingsRoute.PUT(new Request("http://localhost:3000/api/settings?why=disconnected", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ comfyWhere: "server" }) }));
      const g = await settle(id);
      expect(g?.status).toBe("failed");
      expect(g?.error).toBe(RELAY_WORDS.disconnected);
    } finally {
      setSetting("comfyWhere", "server");
    }
  });

  it("a run already sent says it waits for the computer once that computer's tab stops answering", async () => {
    await gpuRoute.PUT(json("/api/account/gpu", "PUT", { mode: "computer" }));
    const pic = await uploadPng();
    const [id] = await run({ feature: "app", modelId: "oss-qwen-edit", presetId: "app-headshot-generator", prompt: "", inputs: { images: [pic.url] } });
    await handedOver(id);
    const t = tab(routes, cookie, fake.port, { device: "device-away-1" });
    await t.runner.beat();
    // Claimed (sent to the tab), and the tab goes quiet: closed, or the computer asleep.
    const claim = await t.api("/api/gpu/computer/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: "device-away-1" }) });
    expect(claim.status).toBe(200);
    await tick();
    expect(getGeneration(id)?.message).not.toBe(RELAY_WORDS.computerAway);
    db().prepare("UPDATE relay_runners SET seen_at = seen_at - 120000").run();
    await tick();
    expect(getGeneration(id)).toMatchObject({ status: "queued", message: RELAY_WORDS.computerAway });
  });

  it("stops a job whose run went, and forgets a deleted account's computer and files", async () => {
    const { createTask, purgeComputer, stageInput, sweepRelay, relayDir } = await import("@/server/computer/tasks");
    const name = stageInput(`acct:${a}`, FAKE_PNG, "image/png", "x.png");
    const task = createTask({ principal: `acct:${a}`, generationId: "no-such-run", graph: { "1": { class_type: "LoadImage", inputs: { image: name } } } });
    expect(fs.existsSync(path.join(relayDir(), "in", name))).toBe(true);
    sweepRelay();
    expect((db().prepare("SELECT state FROM relay_tasks WHERE id = ?").get(task.id) as { state: string }).state).toBe("canceled");
    expect(fs.existsSync(path.join(relayDir(), "in", name))).toBe(false);
    stageInput(`acct:${a}`, FAKE_PNG, "image/png", "y.png");
    purgeComputer(`acct:${a}`);
    expect(db().prepare("SELECT COUNT(*) AS n FROM relay_tasks WHERE principal = ?").get(`acct:${a}`)).toEqual({ n: 0 });
    expect(db().prepare("SELECT COUNT(*) AS n FROM relay_inputs WHERE principal = ?").get(`acct:${a}`)).toEqual({ n: 0 });
  });

  it("follows a meta-batch job pass by pass and keeps the last pass's clip", async () => {
    const { createTask } = await import("@/server/computer/tasks");
    const now = Date.now();
    db()
      .prepare("INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, external_id, external_meta_json, outputs_json, created_at, updated_at) VALUES ('meta-gen', 'video', 'oss-x', 'open', 'comfyui', 'v2v', 'video', 'queued', ?, NULL, '{}', '[]', ?, ?)")
      .run(JSON.stringify({ account: a }), now, now);
    const graph = { "1": { class_type: "VHS_BatchManager", inputs: {} }, "9": { class_type: "VHS_VideoCombine", inputs: { filename_prefix: "fuobe/meta-gen" } } };
    const task = createTask({ principal: `acct:${a}`, generationId: "meta-gen", graph, prefix: "fuobe/meta-gen", metaBatch: true, preview: false });
    fake.opts.metaBatch = 3;
    fake.opts.outputs = ["video"];
    const posts = fake.posts();
    const t = tab(routes, cookie, fake.port);
    await t.runner.beat();
    await t.runner.claimAndRun();
    const row = db().prepare("SELECT state, wanted_json, result_json FROM relay_tasks WHERE id = ?").get(task.id) as { state: string; wanted_json: string; result_json: string };
    expect(row.state).toBe("done");
    expect(JSON.parse(row.wanted_json)).toEqual([expect.objectContaining({ kind: "video", filename: "meta-gen_00001_.mp4", subfolder: "fuobe" })]);
    // One prompt from the tab; the other passes were ComfyUI's own.
    expect(fake.posts() - posts).toBe(1);
    expect([...fake.history.values()].filter((h) => JSON.stringify(h.prompt).includes("fuobe/meta-gen"))).toHaveLength(3);
  });
});
