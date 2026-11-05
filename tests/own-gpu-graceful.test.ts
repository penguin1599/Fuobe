import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { startFakeComfy, TINY_PNG, type FakeComfy } from "./helpers/fake-comfy-runner";
import { tempDir } from "./helpers/temp-dir";

/**
 * An account's own GPU at a web address that has a problem: Settings' Test and Check my GPU say what is wrong in plain
 * words with what helps; a run waits out a GPU that is off or starting up, asks it once more before it fails, and fails
 * in plain words with its buttons; a run its GPU lost is sent again once; a run whose account moved to another address
 * says so; the status strip (the composer's check before Run) knows why the GPU is offline. All against a stand-in
 * ComfyUI on this machine: no real ComfyUI, RunPod or fuobe.com is called.
 */
const dir = tempDir("fuobe-own-gpu-graceful-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://owner-comfy.test:8188";
process.env.FUOBE_PUBLIC_SIGNUP = "1";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_ALLOW_PRIVATE_URLS;
globalThis.__fuobeTestDiskFree = 1e13;

// Plain fetch is the install's own ComfyUI: an account's runs never reach it.
const realFetch = globalThis.fetch;
const fetched: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  fetched.push(String(input instanceof Request ? input.url : input));
  return new Response("not stubbed", { status: 599 });
}) as typeof fetch;

const auth = await import("@/server/auth");
const generationsRoute = await import("@/app/api/generations/route");
const uploadsRoute = await import("@/app/api/uploads/route");
const gpuRoute = await import("@/app/api/account/gpu/route");
const { getGeneration, SELF_HEAL } = await import("@/server/generations");
const { cleanGpuAddress, checkGpuAddress, visitorStatus } = await import("@/server/account-gpu");
const { comfyProvider, onOwnGpu } = await import("@/server/providers/comfyui");
const { db } = await import("@/server/db");
const { resetRates } = await import("@/server/rate");
const { runAsTenant } = await import("@/server/tenant");
const { ISOLATED_ON_GPU } = await import("@/lib/diagnose");

let fake: FakeComfy;
let a = "";
let cookie = "";
beforeAll(async () => {
  fake = await startFakeComfy({ loras: [], delayMs: 0 });
  globalThis.__fuobeTestGpuPort = fake.port;
  auth.setPassword("install password");
  a = auth.createAccount("graceful@example.com", "long enough").id;
  cookie = `${auth.SESSION_COOKIE}=${auth.createSession(a).value}`;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  globalThis.__fuobeTestGpuPort = undefined;
  globalThis.__fuobeTestDiskFree = undefined;
  SELF_HEAL.scale = 1;
  await fake.close();
});
beforeEach(() => {
  resetRates();
  SELF_HEAL.scale = 0.001;
  Object.assign(fake.opts, { loras: [], delayMs: 0, answer: undefined });
  fake.log.length = 0;
  auth.setAccountGpu(a, { url: fake.url });
  globalThis.__fuobeAccountGpus?.clear();
  globalThis.__fuobePollHeals?.clear();
  db().prepare("UPDATE generations SET status = 'canceled' WHERE status IN ('queued', 'running')").run();
});

const headers = (extra: Record<string, string> = {}) => ({ cookie, host: "localhost:3000", ...extra });
const json = (url: string, method: string, body: unknown) => {
  const text = JSON.stringify(body);
  return new Request(`http://localhost:3000${url}`, { method, headers: headers({ "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) }), body: text });
};
const put = async (body: unknown, test = true) => {
  const r = await gpuRoute.PUT(json(`/api/account/gpu${test ? "?test=1" : ""}`, "PUT", body));
  return { status: r.status, body: (await r.json()) as { error?: string; trouble?: { cause: string; words: string; details?: string; actions: { kind: string }[]; retryable: boolean }; note?: string; url?: string; offline?: true; gpu?: { url: string } }, headers: r.headers };
};
const html = (status: number, title = "Bad gateway") => ({ status, body: `<!DOCTYPE html><html><head><title>${title}</title></head><body>…</body></html>`, contentType: "text/html" });

async function uploadPng(): Promise<string> {
  const r = await uploadsRoute.POST(new Request("http://localhost:3000/api/uploads", { method: "POST", headers: headers({ "content-type": "image/png", "x-file-name": "me.png", "content-length": String(TINY_PNG.length) }), body: TINY_PNG }));
  expect(r.status).toBe(201);
  return ((await r.json()) as { url: string }).url;
}
async function startRun(): Promise<string> {
  const pic = await uploadPng();
  const r = await generationsRoute.POST(json("/api/generations", "POST", { feature: "video", modelId: "fuobe-dop", presetId: "motion-zoom-in", prompt: "", inputs: { images: [pic] } }));
  expect(r.status, await r.clone().text()).toBe(201);
  return ((await r.json()) as { items: { id: string }[] }).items[0].id;
}
/** Tick the runner until the row is done (or the time is up), noting every message the tile showed on the way. */
async function settle(id: string, ms = 15_000, seen: string[] = []) {
  const end = Date.now() + ms;
  for (;;) {
    await globalThis.__fuobeRunner?.tick();
    const g = getGeneration(id, { includeDeleted: true });
    if (g?.message && seen.at(-1) !== g.message) seen.push(g.message);
    if (!g || (g.status !== "queued" && g.status !== "running") || Date.now() > end) return g;
    await new Promise((r) => setTimeout(r, 15));
  }
}
const kinds = (t: { actions: { kind: string }[] } | undefined) => (t?.actions ?? []).map((x) => x.kind);
/** No status code, program words, HTML or an address in what the person reads first. */
const plainWords = (s: string | null | undefined) => {
  expect(s).toBeTruthy();
  expect(s).not.toMatch(/HTTP|\b[1-5]\d\d\b|upload failed|\/prompt|<html|<!DOCTYPE|127\.0\.0\.1|ECONN|isn't JSON/);
};

describe("Settings → Your GPU: Test says what is wrong, in plain words, with what helps", () => {
  it("a GPU starting up (502), a password (401), a web page and another app's 404", async () => {
    fake.opts.answer = (_m, p) => (p === "/system_stats" ? html(502) : undefined);
    const starting = await put({ url: fake.url });
    expect(starting.status).toBe(422);
    expect(starting.body.trouble).toMatchObject({ cause: "gpu-starting", retryable: true });
    expect(starting.body.error).toBe(starting.body.trouble!.words);
    expect(starting.body.error).toMatch(/starting up/);
    expect(starting.body.trouble!.details).toBe(`127.0.0.1:${fake.port} · HTTP 502 · Bad gateway`);
    plainWords(starting.body.error);
    // Today's wrong advice is gone.
    expect(starting.body.error).not.toMatch(/isn't a ComfyUI/);

    fake.opts.answer = (_m, p) => (p === "/system_stats" ? { status: 401, body: "" } : undefined);
    expect((await put({ url: fake.url })).body.trouble).toMatchObject({ cause: "gpu-password", words: "Your GPU asks for a password. Paste it in Access token." });
    expect((await put({ url: fake.url, token: "wrong" })).body.trouble).toMatchObject({ cause: "gpu-password-wrong" });

    fake.opts.answer = (_m, p) => (p === "/system_stats" ? html(200, "Jupyter") : undefined);
    expect((await put({ url: fake.url })).body.trouble).toMatchObject({ cause: "gpu-not-comfy", retryable: false });
    fake.opts.answer = (_m, p) => (p === "/system_stats" ? { status: 404, body: "not found", contentType: "text/plain" } : undefined);
    expect((await put({ url: fake.url })).body.trouble).toMatchObject({ cause: "gpu-not-comfy" });
  });

  it("a GPU that doesn't answer at all", async () => {
    // A port with nothing behind it (the stand-in's port is the one an account may use on this machine).
    const idle = http.createServer();
    await new Promise<void>((r) => idle.listen(0, "127.0.0.1", () => r()));
    const port = (idle.address() as { port: number }).port;
    await new Promise<void>((r) => idle.close(() => r()));
    globalThis.__fuobeTestGpuPort = port;
    try {
      const r = await put({ url: `http://127.0.0.1:${port}` });
      expect(r.status).toBe(422);
      expect(r.body.trouble).toMatchObject({ cause: "gpu-offline", retryable: true });
      expect(r.body.error).toMatch(/^Your GPU didn't answer\./);
      expect(r.body.trouble!.details).toMatch(/ECONNREFUSED/);
      plainWords(r.body.error);
    } finally {
      globalThis.__fuobeTestGpuPort = fake.port;
    }
  });

  it("makes a pasted address whole: https:// added, a ? or # part left out, a password refused", async () => {
    const pod = cleanGpuAddress(" abc123xyz-8188.proxy.runpod.net ");
    expect(pod.url.href).toBe("https://abc123xyz-8188.proxy.runpod.net/");
    expect(pod.fixed).toEqual(["scheme"]);
    const fixed: ("scheme" | "query")[] = [];
    expect(await checkGpuAddress("abc123xyz-8188.proxy.runpod.net/?token=x#queue", { resolve: async () => ["93.184.216.34"], fixed })).toBe("https://abc123xyz-8188.proxy.runpod.net");
    expect(fixed).toEqual(["scheme", "query"]);
    // Through the route: the address back as it was checked, and the note under the field.
    const r = await put({ url: `${fake.url}/?view=queue#x` });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ note: "We kept only the address part.", url: fake.url });
    const pw = await put({ url: "https://me:secret@gpu.example.com" });
    expect(pw.status).toBe(422);
    expect(pw.body.trouble).toMatchObject({ cause: "address-credentials", words: "A password goes in the Access token box, not in the address." });
  });

  it("too many checks: says when it checks again, by itself", async () => {
    let last: Awaited<ReturnType<typeof put>> | undefined;
    for (let i = 0; i < 12; i++) last = await put({ url: fake.url });
    expect(last!.status).toBe(429);
    expect(last!.body.trouble).toMatchObject({ cause: "checks-too-fast", words: "Checking again in a few seconds.", retryable: true });
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("Check my GPU asks the saved address again, and the status strip shows why it is offline without asking again", async () => {
    fake.opts.answer = (_m, p) => (p === "/system_stats" ? html(503, "Service unavailable") : undefined);
    const r = await put({ saved: true });
    expect(r.status).toBe(422);
    expect(r.body.trouble?.cause).toBe("gpu-starting");
    const asked = fake.log.filter((e) => e.path === "/system_stats").length;
    const s = await visitorStatus(auth.accountById(a)!);
    expect(s.viewer.gpu).toMatchObject({ connected: true, mode: "link", online: false, host: "web", trouble: { cause: "gpu-starting", retryable: true } });
    expect(s.viewer.gpu.trouble!.actions.map((x) => x.kind)).toContain("check-gpu");
    // The composer's check before Run reads this answer: nothing more was asked of the GPU.
    expect(fake.log.filter((e) => e.path === "/system_stats").length).toBe(asked);
    fake.opts.answer = undefined;
    expect((await put({ saved: true })).status).toBe(200);
    expect((await visitorStatus(auth.accountById(a)!)).viewer.gpu).toMatchObject({ online: true });
  });

  it("Save anyway keeps the address of a GPU that is off right now; an address that can't work can't be kept", async () => {
    auth.setAccountGpu(a, null);
    fake.opts.answer = (_m, p) => (p === "/system_stats" ? html(502) : undefined);
    const plainConnect = await put({ url: fake.url }, false);
    expect(plainConnect.status).toBe(422);
    expect(auth.accountGpu(a)).toBeNull();
    const kept = await put({ url: fake.url, anyway: true }, false);
    expect(kept.status).toBe(200);
    expect(kept.body).toMatchObject({ offline: true, gpu: { url: fake.url }, trouble: { cause: "gpu-starting" } });
    expect(auth.accountGpu(a)).toEqual({ url: fake.url });
    fake.opts.answer = (_m, p) => (p === "/system_stats" ? { status: 401, body: "" } : undefined);
    auth.setAccountGpu(a, null);
    expect((await put({ url: fake.url, anyway: true }, false)).status).toBe(422);
    expect(auth.accountGpu(a)).toBeNull();
  });
});

describe("a run on an account's own GPU heals itself, or fails in plain words with what helps", () => {
  it("waits while its GPU starts up, saying so, then runs", async () => {
    SELF_HEAL.scale = 0.01;
    let refused = 0;
    fake.opts.answer = (m, p) => (p === "/upload/image" && m === "POST" && refused++ < 2 ? html(502) : undefined);
    const id = await startRun();
    const seen: string[] = [];
    const g = await settle(id, 20_000, seen);
    expect(g?.status, g?.error ?? "").toBe("succeeded");
    expect(seen).toContain("Waiting for your GPU to start up");
    expect(fake.log.filter((e) => e.path === "/upload/image").length).toBeGreaterThanOrEqual(3);
  });

  it("asks its GPU once more before it fails, then says why in plain words, with its buttons and the details", async () => {
    fake.opts.answer = (_m, p) => (p === "/upload/image" || p === "/system_stats" ? html(502) : undefined);
    const id = await startRun();
    const g = await settle(id);
    expect(g?.status).toBe("failed");
    expect(g?.error).toBe("Your GPU is starting up, so ComfyUI wasn't ready for this run. Press Retry in a minute.");
    plainWords(g?.error);
    expect(g?.trouble).toMatchObject({ cause: "gpu-starting", details: `127.0.0.1:${fake.port} · HTTP 502 · Bad gateway` });
    expect(kinds(g?.trouble)).toEqual(expect.arrayContaining(["retry", "check-gpu", "gpu-settings"]));
    // Tried several times, then asked once more (/system_stats) before failing.
    const paths = fake.log.map((e) => e.path);
    expect(paths.filter((p) => p === "/upload/image").length).toBeGreaterThan(1);
    expect(paths.lastIndexOf("/system_stats")).toBeGreaterThan(paths.indexOf("/upload/image"));
    // What it learnt shows in the status strip too.
    expect((await visitorStatus(auth.accountById(a)!)).viewer.gpu).toMatchObject({ online: false, trouble: { cause: "gpu-starting" } });
  });

  it("while a run waits, the status strip says so in a check's words; a GPU moved meanwhile stops the run in plain words", async () => {
    SELF_HEAL.scale = 0.01;
    fake.opts.answer = (_m, p) => (p === "/upload/image" ? html(502) : undefined);
    const id = await startRun();
    for (let i = 0; i < 500 && getGeneration(id)?.message !== "Waiting for your GPU to start up"; i++) await new Promise((r) => setTimeout(r, 10));
    expect(getGeneration(id)?.message).toBe("Waiting for your GPU to start up");
    // The composer's check before Run reads this (Settings' words, not a run's "press Retry").
    const s = await visitorStatus(auth.accountById(a)!);
    expect(s.viewer.gpu).toMatchObject({ online: false, trouble: { cause: "gpu-starting", words: expect.stringMatching(/we connect as soon as ComfyUI is ready/) } });
    auth.setAccountGpu(a, { url: `${fake.url}/elsewhere` });
    const g = await settle(id);
    expect(g?.status).toBe("failed");
    expect(g?.error).toBe("This run stopped because your GPU moved to a new address. Press Retry.");
  });

  it("never waits out what waiting can't fix: a password, a web page instead of ComfyUI", async () => {
    fake.opts.answer = (_m, p) => (p === "/upload/image" ? { status: 401, body: "" } : undefined);
    const id = await startRun();
    const g = await settle(id);
    expect(g?.status).toBe("failed");
    expect(g?.trouble?.cause).toBe("gpu-password");
    expect(g?.error).toMatch(/asks for a password/);
    expect(fake.log.filter((e) => e.path === "/upload/image")).toHaveLength(1);

    fake.log.length = 0;
    fake.opts.answer = (_m, p) => (p === "/upload/image" ? html(200, "Sign in") : undefined);
    const page = await settle(await startRun());
    expect(page?.trouble?.cause).toBe("gpu-not-comfy");
    plainWords(page?.error);
    expect(fake.log.filter((e) => e.path === "/upload/image")).toHaveLength(1);
  });

  it("a GPU known to be off from its last status check waits at once, without sending files to it", async () => {
    SELF_HEAL.scale = 0.01;
    fake.opts.answer = (_m, p) => (p === "/system_stats" ? html(502) : undefined);
    expect((await put({ saved: true })).status).toBe(422);
    fake.log.length = 0;
    fake.opts.answer = undefined;
    const seen: string[] = [];
    const g = await settle(await startRun(), 20_000, seen);
    expect(g?.status).toBe("succeeded");
    expect(seen).toContain("Waiting for your GPU to start up");
  });

  it("its GPU going away mid-run: the tile says it waits, then the run stops in plain words", async () => {
    fake.opts.delayMs = 60_000;
    const id = await startRun();
    // Handed over: the job is on the GPU.
    for (let i = 0; i < 300 && !db().prepare("SELECT external_id FROM generations WHERE id = ?").pluck().get(id); i++) await new Promise((r) => setTimeout(r, 10));
    fake.opts.answer = () => html(502);
    const seen: string[] = [];
    const g = await settle(id, 20_000, seen);
    expect(seen).toContain("Your GPU stopped answering. Waiting for it to come back");
    expect(g?.status).toBe("failed");
    expect(g?.error).toBe("Your GPU stopped answering for 1 minute, so this run stopped. Start it again, then press Retry.");
    expect(kinds(g?.trouble)).toEqual(expect.arrayContaining(["retry", "check-gpu"]));
  });

  it("a run its GPU lost (ComfyUI restarted) is sent again once, and finishes", async () => {
    let prompts = 0;
    fake.opts.answer = (m, p) => {
      if (p === "/prompt" && m === "POST") {
        prompts++;
        return undefined;
      }
      // Until it is sent again: a ComfyUI that forgot everything.
      if (prompts < 2 && p === "/queue" && m === "GET") return { status: 200, body: JSON.stringify({ queue_running: [], queue_pending: [] }), contentType: "application/json" };
      if (prompts < 2 && p.startsWith("/history/")) return { status: 200, body: "{}", contentType: "application/json" };
      return undefined;
    };
    const seen: string[] = [];
    const g = await settle(await startRun(), 20_000, seen);
    expect(g?.status, g?.error ?? "").toBe("succeeded");
    expect(prompts).toBe(2);
    expect(seen).toContain("Your GPU restarted, so we sent this run again");
  });

  it("a run whose account moved to another address says so", async () => {
    fake.opts.delayMs = 60_000;
    const id = await startRun();
    for (let i = 0; i < 300 && !db().prepare("SELECT external_id FROM generations WHERE id = ?").pluck().get(id); i++) await new Promise((r) => setTimeout(r, 10));
    auth.setAccountGpu(a, { url: `${fake.url}/elsewhere` });
    const g = await settle(id);
    expect(g?.status).toBe("failed");
    expect(g?.error).toBe("This run stopped because your GPU moved to a new address. Press Retry.");
  });

  it("a graph that needs a second ComfyUI is refused before anything is sent", async () => {
    const r = await generationsRoute.POST(json("/api/generations", "POST", { feature: "audio", modelId: "oss-thinksound", prompt: "a door slams" }));
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: string }).error).toBe(ISOLATED_ON_GPU);
  });

  it("the owner's runs, and runs off an account's own GPU, keep their own detail", async () => {
    // The owner's ComfyUI (plain fetch): ComfyUI's own words as before.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      return url.endsWith("/upload/image") ? new Response("nope", { status: 500 }) : new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await expect(comfyProvider.prepareFile(Buffer.from("png"), "image/png", "a.png")).rejects.toThrow(/^ComfyUI upload failed: 500 nope$/);
      // An account's run on this install's GPUs (hosted runs: its tenant, not its own GPU) is the install's as well.
      await expect(runAsTenant({ kind: "account", id: a }, () => comfyProvider.prepareFile(Buffer.from("png"), "image/png", "a.png"))).rejects.toThrow(/^ComfyUI upload failed: 500 nope$/);
    } finally {
      globalThis.fetch = (async () => new Response("not stubbed", { status: 599 })) as typeof fetch;
    }
    // On the account's own GPU: the person's words, with what helps.
    fake.opts.answer = (_m, p) => (p === "/upload/image" ? { status: 404, body: "404 page not found", contentType: "text/plain" } : undefined);
    const e = (await onOwnGpu({ url: fake.url }, () => comfyProvider.prepareFile(Buffer.from("png"), "image/png", "a.png")).catch((x: unknown) => x)) as Error & { trouble?: { cause: string; details?: string } };
    expect(e.message).not.toMatch(/upload failed|404/);
    expect(e.trouble).toMatchObject({ cause: "gpu-not-comfy", details: `127.0.0.1:${fake.port} · HTTP 404 · 404 page not found` });
    expect(fetched.filter((u) => u.includes("owner-comfy.test") && !u.endsWith("/system_stats"))).toEqual([]);
  });
});
