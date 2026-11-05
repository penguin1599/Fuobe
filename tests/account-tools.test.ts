import fs from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { startFakeComfy, TINY_PNG, type FakeComfy } from "./helpers/fake-comfy-runner";
import { tempDir } from "./helpers/temp-dir";

const dir = tempDir("fuobe-account-tools-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://owner-comfy.test:8188";
process.env.FUOBE_PUBLIC_SIGNUP = "1";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_ALLOW_PRIVATE_URLS;
globalThis.__fuobeTestDiskFree = 1e13;

// Plain fetch is the install's own ComfyUI ("owner-comfy.test"): recorded, and answered like a ComfyUI whose job is done.
const realFetch = globalThis.fetch;
const fetched: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  fetched.push(url.toString());
  if (url.host !== "owner-comfy.test:8188") return new Response("not stubbed", { status: 599 });
  if (url.pathname === "/system_stats") return Response.json({ system: { comfyui_version: "owner", ram_total: 1 }, devices: [] });
  if (url.pathname.startsWith("/history/")) {
    const id = decodeURIComponent(url.pathname.slice("/history/".length));
    return Response.json({ [id]: { status: { completed: true, status_str: "success" }, outputs: { "9": { images: [{ filename: "owner_00001_.png", subfolder: "", type: "output" }] } } } });
  }
  if (url.pathname === "/view") return new Response(new Uint8Array(TINY_PNG), { headers: { "content-type": "image/png" } });
  if (url.pathname === "/queue") return Response.json({ queue_running: [], queue_pending: [] });
  return Response.json({});
}) as typeof fetch;

const auth = await import("@/server/auth");
const generationsRoute = await import("@/app/api/generations/route");
const uploadsRoute = await import("@/app/api/uploads/route");
const gpuRoute = await import("@/app/api/account/gpu/route");
const { proxy } = await import("@/proxy");
const { accountRun, createGenerations, getGeneration } = await import("@/server/generations");
const { OWN_OUTPUT_LIMITS } = await import("@/server/providers/comfyui");
const { libraryEntry } = await import("@/lib/catalog/loras");
const { db } = await import("@/server/db");
const { resetRates } = await import("@/server/rate");
const { clearAccountLoras } = await import("@/server/account-loras");
const { scratchDir } = await import("@/server/storage");

let fake: FakeComfy;
let a = "";
let cookie = "";
beforeAll(async () => {
  fake = await startFakeComfy({ loras: [], delayMs: 0 });
  globalThis.__fuobeTestGpuPort = fake.port;
  auth.setPassword("install password");
  a = auth.createAccount("tools@example.com", "long enough").id;
  cookie = `${auth.SESSION_COOKIE}=${auth.createSession(a).value}`;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  globalThis.__fuobeTestGpuPort = undefined;
  globalThis.__fuobeTestDiskFree = undefined;
  await fake.close();
});
beforeEach(() => {
  resetRates();
  clearAccountLoras(a);
  Object.assign(fake.opts, { loras: [], delayMs: 0, drip: false, huge: false, promptId: undefined, missing: undefined, output: "video" });
  db().prepare("UPDATE generations SET status = 'canceled' WHERE status IN ('queued', 'running') AND json_extract(request_json, '$.account') IS NOT NULL").run();
});

const headers = (extra: Record<string, string> = {}) => ({ cookie, host: "localhost:3000", ...extra });
const json = (url: string, method: string, body: unknown) => {
  const text = JSON.stringify(body);
  return new Request(`http://localhost:3000${url}`, { method, headers: headers({ "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) }), body: text });
};

async function uploadPng(): Promise<{ url: string; id: string }> {
  const r = await uploadsRoute.POST(new Request("http://localhost:3000/api/uploads", { method: "POST", headers: headers({ "content-type": "image/png", "x-file-name": "me.png", "content-length": String(TINY_PNG.length) }), body: TINY_PNG }));
  expect(r.status).toBe(201);
  return r.json();
}

/** Tick the runner until the row is done (or the time is up). */
async function settle(id: string, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    await globalThis.__fuobeRunner?.tick();
    const g = getGeneration(id, { includeDeleted: true });
    if (!g || (g.status !== "queued" && g.status !== "running") || Date.now() > end) return g;
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe("an account runs the catalogue on its own ComfyUI", () => {
  it("connects its ComfyUI, uploads a picture, and runs a camera motion end to end", async () => {
    const put = await gpuRoute.PUT(json("/api/account/gpu", "PUT", { url: fake.url }));
    expect(put.status).toBe(200);
    const pic = await uploadPng();
    fake.log.length = 0;
    const r = await generationsRoute.POST(json("/api/generations", "POST", { feature: "video", modelId: "fuobe-dop", presetId: "motion-zoom-in", prompt: "", inputs: { images: [pic.url] } }));
    expect(r.status).toBe(201);
    const id = (await r.json()).items[0].id as string;
    const g = await settle(id);
    expect(g?.status, g?.error ?? "").toBe("succeeded");
    // The picture went to its ComfyUI as it was uploaded, then the prompt; the result came back from /view.
    const paths = fake.log.map((e) => e.path.split("?")[0]);
    const up = fake.log.find((e) => e.path === "/upload/image");
    expect(up?.upload?.equals(TINY_PNG)).toBe(true);
    expect(paths.indexOf("/prompt")).toBeGreaterThan(paths.indexOf("/upload/image"));
    expect(paths).toContain("/view");
    expect(paths.filter((p) => !["/models/loras", "/system_stats", "/upload/image", "/prompt", "/history/" + g!.request.account].includes(p) && !p.startsWith("/history/") && p !== "/view" && p !== "/queue")).toEqual([]);
    // The result is the account's own.
    expect(g!.request.account).toBe(a);
    const out = g!.outputs[0];
    expect(out.url).toMatch(/^\/api\/files\/outputs\//);
    expect((db().prepare("SELECT account_id FROM assets WHERE id = ?").get(out.assetId) as { account_id: string }).account_id).toBe(a);
    const read = (c?: string) => proxy(new NextRequest(`http://localhost:3000${out.url}`, { headers: c ? { cookie: c } : {} }));
    expect(read(cookie).headers.get("x-middleware-next")).toBe("1");
    const other = auth.createAccount("tools-other@example.com", "long enough");
    expect(read(`${auth.SESSION_COOKIE}=${auth.createSession(other.id).value}`).status).toBe(403);
    expect(proxy(new NextRequest(`http://localhost:3000/api/generations/${id}`, { headers: { cookie: `${auth.SESSION_COOKIE}=${auth.createSession(other.id).value}` } })).status).toBe(403);
    // Nothing of the run reached the install's ComfyUI (its own reachability check, /system_stats, is the owner's).
    expect(fetched.filter((u) => u.includes("owner-comfy.test") && !u.endsWith("/system_stats"))).toEqual([]);
  });

  it("runs an app that edits a picture", async () => {
    fake.opts.output = "image";
    const pic = await uploadPng();
    const r = await generationsRoute.POST(json("/api/generations", "POST", { feature: "app", modelId: "oss-qwen-image-21", presetId: "app-headshot-generator", prompt: "", inputs: { images: [pic.url] } }));
    expect(r.status).toBe(201);
    const g = await settle((await r.json()).items[0].id);
    expect(g?.status, g?.error ?? "").toBe("succeeded");
    expect(g!.outputs[0]).toMatchObject({ kind: "image", contentType: "image/png" });
  });

  it("runs an app run stored on the model its app ran on before (Retry, Run again, a script) on the app's model now", async () => {
    fake.opts.output = "image";
    const pic = await uploadPng();
    // The edit apps ran on Qwen-Image-Edit 2511 and Expand Image on FLUX Fill: a stored request still names them.
    for (const [modelId, presetId, op] of [
      ["oss-qwen-edit", "app-headshot-generator", "edit"],
      ["oss-flux-fill", "app-expand-image", "outpaint"],
    ] as const) {
      const r = await generationsRoute.POST(json("/api/generations", "POST", { feature: "app", modelId, presetId, op, prompt: "", inputs: { images: [pic.url] } }));
      expect(r.status, presetId).toBe(201);
      const body = await r.json();
      expect(body.notes, presetId).toEqual(expect.arrayContaining([expect.stringMatching(/now runs on Qwen-Image 2\.1$/)]));
      const g = await settle(body.items[0].id);
      expect(g?.status, g?.error ?? "").toBe("succeeded");
      expect([g!.request.modelId, g!.op]).toEqual(["oss-qwen-image-21", op]);
    }
  });

  it("names a LoRA its ComfyUI doesn't have, with where to get it, before anything is sent", async () => {
    const pic = await uploadPng();
    fake.log.length = 0;
    const r = await generationsRoute.POST(json("/api/generations", "POST", { feature: "video", modelId: "fuobe-dop", presetId: "motion-dolly-in", prompt: "", inputs: { images: [pic.url] } }));
    expect(r.status).toBe(409);
    expect(r.headers.get("x-fuobe-gpu-setup")).toBeNull();
    const body = await r.json();
    const file = "motionpushin-v5-wan-i2v-14b-720p-400.safetensors";
    expect(body.code).toBe("comfy_missing_model");
    // A preset's own LoRA: the link the catalog names, and its Hugging Face page.
    expect(body.fix.items).toEqual([
      {
        folder: "loras",
        file,
        url: "https://huggingface.co/lovis93/Motion-Lora-Camera-Push-In-Wan-14B-720p-I2V/resolve/main/motionpushin-v5-wan-i2v-14b-720p-400.safetensors",
        page: "https://huggingface.co/lovis93/Motion-Lora-Camera-Push-In-Wan-14B-720p-I2V",
        download: "direct",
      },
    ]);
    expect(body.error).toMatch(/^Your ComfyUI doesn't have a LoRA file this needs\. Download it into ComfyUI\/models\/loras, keep the file name, then press Generate again\.\n• motionpushin/);
    expect(fake.log.some((e) => e.path === "/upload/image" || e.path === "/prompt")).toBe(false);
    // LoRAs from Fuobe's library: their link, page and how they download.
    const orbit = await generationsRoute.POST(json("/api/generations", "POST", { feature: "video", modelId: "fuobe-dop", presetId: "motion-360-orbit", prompt: "", inputs: { images: [pic.url] } }));
    expect(orbit.status).toBe(409);
    const { fix, error } = await orbit.json();
    expect(fix.items).toHaveLength(2);
    for (const item of fix.items) {
      const entry = libraryEntry({ file: item.file })!;
      expect(item).toMatchObject({ folder: "loras", url: entry.url, page: entry.page, download: entry.download });
    }
    expect(error).toMatch(/^Your ComfyUI doesn't have 2 LoRA files this needs\. Download each one into ComfyUI\/models\/loras/);
  });

  it("checks again when a step is handed over, and fails it with the plain message", async () => {
    const pic = await uploadPng();
    fake.log.length = 0;
    const own = accountRun(a, "comfyui");
    if (!("run" in own)) throw new Error(own.error);
    const [g] = own.run(() => createGenerations({ feature: "video", modelId: "fuobe-dop", presetId: "motion-dolly-in", prompt: "", inputs: { images: [pic.url] } } as never));
    const done = await settle(g.id);
    expect(done?.status).toBe("failed");
    expect(done?.error).toMatch(/^Your ComfyUI doesn't have a LoRA file this needs/);
    expect(done?.error).toContain("motionpushin-v5-wan-i2v-14b-720p-400.safetensors");
    // What was missing stays on the failed step, so its tile can offer the pre-flight's "Fix it".
    expect(done?.fix).toMatchObject({ code: "comfy_missing_model", items: [{ folder: "loras", file: "motionpushin-v5-wan-i2v-14b-720p-400.safetensors" }] });
    expect(fake.log.some((e) => e.path === "/upload/image")).toBe(false);
    // With the file there, the same run goes ahead.
    fake.opts.loras = ["motionpushin-v5-wan-i2v-14b-720p-400.safetensors"];
    clearAccountLoras(a);
    const [again] = own.run(() => createGenerations({ feature: "video", modelId: "fuobe-dop", presetId: "motion-dolly-in", prompt: "", inputs: { images: [pic.url] } } as never));
    expect((await settle(again.id))?.status).toBe("succeeded");
  });
});

describe("an account's ComfyUI can't hold up the server", () => {
  it("never holds up the owner's jobs while it drips", async () => {
    fake.opts.drip = true;
    const now = Date.now();
    const insert = (id: string, account?: string) =>
      db()
        .prepare(
          "INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, external_id, external_meta_json, outputs_json, created_at, updated_at) VALUES (?, 'image', 'oss-qwen-edit', 'open', 'comfyui', 'edit', 'image', 'running', ?, ?, '{}', '[]', ?, ?)",
        )
        .run(id, JSON.stringify({ feature: "image", modelId: "oss-qwen-edit", ...(account && { account }) }), `${id}-job`, now, now);
    insert("acct-drip", a);
    insert("owner-job");
    const t = Date.now();
    let ticks = 0;
    while (getGeneration("owner-job")?.status !== "succeeded" && ticks < 5) {
      await globalThis.__fuobeRunner!.tick();
      ticks++;
    }
    expect(getGeneration("owner-job")?.status).toBe("succeeded");
    expect(Date.now() - t).toBeLessThan(5000);
    expect(getGeneration("acct-drip")?.status).toBe("running");
  });

  it("fails a result that never ends at the cap, and leaves no file behind", async () => {
    const was = OWN_OUTPUT_LIMITS.maxBytes;
    OWN_OUTPUT_LIMITS.maxBytes = 2 * 2 ** 20;
    fake.opts.huge = true;
    try {
      const pic = await uploadPng();
      const r = await generationsRoute.POST(json("/api/generations", "POST", { feature: "video", modelId: "fuobe-dop", presetId: "motion-zoom-in", prompt: "", inputs: { images: [pic.url] } }));
      const id = (await r.json()).items[0].id as string;
      const g = await settle(id);
      expect(g?.status).toBe("failed");
      // Said as what it is: a file over what a run on your GPU keeps.
      expect(g?.error).toBe("Your ComfyUI made a file over 2 MB. Try a shorter clip or a lower size.");
      expect(fs.readdirSync(scratchDir()).filter((f) => f.startsWith(`${id}-out-`))).toEqual([]);
    } finally {
      OWN_OUTPUT_LIMITS.maxBytes = was;
    }
  });

  it("refuses a job id it can't use", async () => {
    fake.opts.promptId = "../system_stats?";
    const pic = await uploadPng();
    const r = await generationsRoute.POST(json("/api/generations", "POST", { feature: "video", modelId: "fuobe-dop", presetId: "motion-zoom-in", prompt: "", inputs: { images: [pic.url] } }));
    const g = await settle((await r.json()).items[0].id);
    expect(g?.status).toBe("failed");
    expect(g?.error).toBe("Your ComfyUI couldn't take this run. Press Retry.");
    expect(fake.log.some((e) => e.path.startsWith("/system_stats?"))).toBe(false);
  });
});
