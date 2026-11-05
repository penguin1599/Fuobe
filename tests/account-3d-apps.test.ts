import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { startFakeComfy, TINY_PNG, type FakeComfy } from "./helpers/fake-comfy-runner";
import { tempDir } from "./helpers/temp-dir";

/**
 * 3D from the apps (public sign-up): the Image to 3D app and Photo to 3D (where an image result's Make it 3D goes) run
 * through POST /api/generations. A signed-in account's run goes to its own ComfyUI (a stand-in here) and is made there,
 * with no "isn't available here" answer; an account with neither a GPU nor a key is asked to connect one; a guest gets
 * the sign-up card; a run stamped for this install's GPUs is still refused, and a place sent in the body changes
 * nothing. The owner's run is as before.
 */
const dir = tempDir("fuobe-account-3d-apps-");
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
const route = await import("@/app/api/generations/route");
const uploadsRoute = await import("@/app/api/uploads/route");
const gpuRoute = await import("@/app/api/account/gpu/route");
const { proxy } = await import("@/proxy");
const access = await import("@/lib/guest-access");
const { createGenerations, getGeneration, asAccount } = await import("@/server/generations");
const { db } = await import("@/server/db");
const { resetRates } = await import("@/server/rate");
const { withRunStamp } = await import("@/server/run-stamp");
const { outputActions } = await import("@/lib/output-actions");

let fake: FakeComfy;
let a = "";
const cookies: Record<string, string> = {};
beforeAll(async () => {
  fake = await startFakeComfy({ loras: [], delayMs: 0, output: "model3d" });
  globalThis.__fuobeTestGpuPort = fake.port;
  auth.setPassword("install password");
  for (const [k, email] of [
    ["a", "apps3d-a@example.com"],
    ["c", "apps3d-c@example.com"],
  ] as const) {
    const id = auth.createAccount(email, "long enough").id;
    cookies[k] = `${auth.SESSION_COOKIE}=${auth.createSession(id).value}`;
    if (k === "a") a = id;
  }
  cookies.owner = `${auth.SESSION_COOKIE}=${auth.createSession().value}`;
  // A links its own ComfyUI; C has neither a GPU nor a key.
  expect((await gpuRoute.PUT(json("/api/account/gpu", "PUT", { url: fake.url }, "a"))).status).toBe(200);
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  globalThis.__fuobeTestGpuPort = undefined;
  globalThis.__fuobeTestDiskFree = undefined;
  await fake.close();
});
beforeEach(() => {
  resetRates();
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

const viaProxy = (url: string, method: string, who?: string) =>
  proxy(new NextRequest(`http://localhost:3000${url}`, { method, headers: { host: "localhost:3000", "content-type": "application/json", ...(who && { cookie: cookies[who] }) }, body: "{}" }));
const passed = (r: Response) => r.headers.get("x-middleware-next") === "1";

async function upload(who: string, name: string): Promise<string> {
  const r = await uploadsRoute.POST(new Request("http://localhost:3000/api/uploads", { method: "POST", headers: { host: "localhost:3000", cookie: cookies[who], "content-type": "image/png", "x-file-name": name, "content-length": String(TINY_PNG.length) }, body: new Uint8Array(TINY_PNG) }));
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

/** What the Image to 3D app's composer sends on the open engine. */
const imageTo3dApp = (photo: string) => ({ feature: "app:app-image-to-3d", presetId: "app-image-to-3d", modelId: "oss-pixal3d", op: "image-to-3d", engine: "open", prompt: "", inputs: { images: [photo] } });
/** What Photo to 3D's composer sends (Make it 3D opens it with the picture in). */
const photoTo3dApp = (photo: string) => ({ feature: "app:app-photo-to-3d", presetId: "app-photo-to-3d", modelId: "oss-idol-3d", op: "image-to-3d", engine: "open", prompt: "", inputs: { images: [photo] } });
const made = async (r: Response) => {
  expect(r.status, await r.clone().text()).toBe(201);
  return ((await r.json()) as { items: { id: string }[] }).items;
};

describe("a guest and an account with nothing connected", () => {
  it("a guest gets the sign-up card at the proxy and at the route", async () => {
    const p = viaProxy("/api/generations", "POST");
    expect(p.status).toBe(401);
    expect(p.headers.get(access.GUEST_HEADER)).toBe("1");
    const r = await route.POST(json("/api/generations", "POST", imageTo3dApp("/api/files/x.png")));
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe(access.GUEST_RUN_MESSAGE);
  });

  it("an account with neither a GPU nor a key is asked to connect one, never told the tool isn't available", async () => {
    const r = viaProxy("/api/generations", "POST", "c");
    expect(r.status).toBe(403);
    expect(r.headers.get(access.CONNECT_GPU_HEADER)).toBe("1");
    const body = (await r.json()) as { code: string; error: string };
    expect(body.code).toBe("connect-gpu");
    expect(body.error).not.toBe(access.OWN_GPU_TOOL_MESSAGE);
    expect(passed(viaProxy("/api/generations", "POST", "a"))).toBe(true);
  });
});

describe("an account's 3D app runs on its own ComfyUI", () => {
  let photo = "";
  beforeAll(async () => {
    photo = await upload("a", "lamp.png");
  });

  it("the Image to 3D app: made on its ComfyUI end to end, a GLB of its own", async () => {
    fake.log.length = 0;
    fetched.length = 0;
    const [item] = await made(await route.POST(json("/api/generations", "POST", imageTo3dApp(photo), "a")));
    const g = getGeneration(item.id)!;
    expect(g.request.account).toBe(a);
    expect(g.provider).toBe("comfyui");
    expect(g.kind).toBe("model3d");
    const done = await settle(item.id);
    expect(done?.status, done?.error ?? "").toBe("succeeded");
    expect(fake.log.filter((e) => e.path === "/prompt")).toHaveLength(1);
    // Nothing reached the install's own ComfyUI.
    expect(fetched.filter((u) => !u.endsWith("/system_stats"))).toEqual([]);
    const model = done!.outputs.find((o) => o.kind === "model3d")!;
    expect(model.contentType).toBe("model/gltf-binary");
  }, 120_000);

  it("Photo to 3D (an image result's Make it 3D) is taken for its own ComfyUI", async () => {
    const actions = outputActions({ id: "g1", feature: "image", modelId: "x", status: "succeeded", request: { account: a }, outputs: [{ url: photo, kind: "image" }] } as never, 0, { visitor: true, account: true });
    expect(actions.find((x) => x.id === "make-3d")?.href).toBe(`/apps/app-photo-to-3d?image=${encodeURIComponent(photo)}`);
    const [item] = await made(await route.POST(json("/api/generations", "POST", photoTo3dApp(photo), "a")));
    const g = getGeneration(item.id)!;
    expect(g.request.account).toBe(a);
    expect(g.provider).toBe("comfyui");
    expect(g.kind).toBe("model3d");
  });

  it("a place sent in the body changes nothing: the run is the account's own, never stamped for this install's GPUs", async () => {
    for (const place of ["own", "pool"]) {
      const [item] = await made(await route.POST(json("/api/generations", "POST", { ...imageTo3dApp(photo), place }, "a")));
      const g = getGeneration(item.id)!;
      expect(g.request.account, place).toBe(a);
      expect(g.request.place, place).toBeUndefined();
      expect(g.provider, place).toBe("comfyui");
      db().prepare("UPDATE generations SET status = 'canceled' WHERE id = ?").run(item.id);
    }
  });

  it("the same run stamped for this install's GPUs is refused when it is made", () => {
    const req = imageTo3dApp(photo) as Parameters<typeof createGenerations>[0];
    expect(() => asAccount(a, () => withRunStamp({ place: "pool" }, () => createGenerations(req)))).toThrow(access.OWN_GPU_TOOL_MESSAGE);
    // A place in the request itself is dropped: only the stamp in scope sets it.
    const own = asAccount(a, () => createGenerations({ ...req, place: "pool" } as never));
    expect(own[0].request.place).toBeUndefined();
    expect(own[0].kind).toBe("model3d");
  });
});

describe("the owner's 3D app runs are as before", () => {
  it("the owner's Image to 3D app run is made", async () => {
    const [item] = await made(await route.POST(json("/api/generations", "POST", imageTo3dApp("/api/files/placeholder.png"), "owner")));
    expect(getGeneration(item.id)!.request.account).toBeUndefined();
    db().prepare("UPDATE generations SET status = 'canceled' WHERE id = ?").run(item.id);
  });
});
