import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { startFakeComfy, TINY_PNG, type FakeComfy } from "./helpers/fake-comfy-runner";
import { tempDir } from "./helpers/temp-dir";

/**
 * Image to 3D's extra steps for visitors (Refine detail with Hi3D, the TRELLIS.2 final, Idol 3D's other sides and its
 * spike trim): they run on an account's own GPU through POST /api/image-to-3d. A guest gets the sign-up card, an account
 * with no GPU "Connect your GPU" (connect-gpu, never own-gpu-tool), and nothing reaches this studio's ComfyUI.
 */
const dir = tempDir("fuobe-account-3d-extras-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://owner-comfy.test:8188";
process.env.FUOBE_PUBLIC_SIGNUP = "1";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_ALLOW_PRIVATE_URLS;
delete process.env.FUOBE_HOSTED_RUNS;
globalThis.__fuobeTestDiskFree = 1e13;

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
const gpuRoute = await import("@/app/api/account/gpu/route");
const { proxy } = await import("@/proxy");
const access = await import("@/lib/guest-access");
const { db } = await import("@/server/db");
const { resetRates } = await import("@/server/rate");
const { saveFile } = await import("@/server/storage");
const { runAsTenant } = await import("@/server/tenant");
const { refineRequest } = await import("@/lib/av/hi3d");
const { idolViewsRequest } = await import("@/lib/av/idol-views");
const { model3dRequest, FINAL_3D, IDOL_MODELS } = await import("@/lib/av/model3d");
const { ownSetupOnly } = await import("@/lib/own-setup");

let fake: FakeComfy;
let c = "";
const cookies: Record<string, string> = {};
beforeAll(async () => {
  fake = await startFakeComfy({ loras: [], delayMs: 0, output: "model3d" });
  globalThis.__fuobeTestGpuPort = fake.port;
  auth.setPassword("install password");
  for (const [k, email] of [
    ["a", "extras-a@example.com"],
    ["c", "extras-c@example.com"],
  ] as const) {
    const id = auth.createAccount(email, "long enough").id;
    cookies[k] = `${auth.SESSION_COOKIE}=${auth.createSession(id).value}`;
    if (k === "c") c = id;
  }
  // A links its own ComfyUI; C has neither a GPU nor a key.
  expect((await gpuRoute.PUT(json("/api/account/gpu", "PUT", { url: fake.url }, "a"))).status).toBe(200);
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  globalThis.__fuobeTestGpuPort = undefined;
  globalThis.__fuobeTestDiskFree = undefined;
  await fake.close();
});
beforeEach(() => resetRates());

function json(url: string, method: string, body: unknown, who?: string): Request {
  const text = JSON.stringify(body);
  return new Request(`http://localhost:3000${url}`, {
    method,
    headers: { host: "localhost:3000", "content-type": "application/json", "content-length": String(Buffer.byteLength(text)), ...(who && { cookie: cookies[who] }) },
    body: text,
  });
}
const viaProxy = (url: string, who?: string) =>
  proxy(new NextRequest(`http://localhost:3000${url}`, { method: "POST", headers: { host: "localhost:3000", "content-type": "application/json", ...(who && { cookie: cookies[who] }) }, body: "{}" }));

describe("Image to 3D's extra steps run on an account's own GPU", () => {
  const steps = (photo: string) => ({
    "Refine this mesh (Hi3D)": refineRequest({ glb: photo.replace(/\.png$/, ".glb"), photo, resolution: 512 }),
    "Make the other sides (Idol 3D)": idolViewsRequest(photo),
    "Build the final with TRELLIS.2": model3dRequest({ engine: "open", mode: "image", modelId: FINAL_3D.model, photo }),
    "Idol 3D with Trim spikes": model3dRequest({ engine: "open", mode: "splat", modelId: IDOL_MODELS.open, photo, quality: "best", photoCrop: true, trimSpikes: true }),
  });

  it("each step is one of the labelled own-setup items", () => {
    for (const id of ["image-to-3d:hi3d-refine", "image-to-3d:trellis-final", "image-to-3d:idol-other-sides", "image-to-3d:idol-clean"]) expect(ownSetupOnly(id), id).not.toBeNull();
  });

  it("a guest gets the sign-up card, from the proxy and from the route", async () => {
    const g = viaProxy("/api/image-to-3d");
    expect(g.status).toBe(401);
    expect(g.headers.get(access.GUEST_HEADER)).toBe("1");
    for (const [name, req] of Object.entries(steps("/api/files/x.png"))) {
      const r = await route.POST(json("/api/image-to-3d", "POST", req));
      expect(r.status, name).toBe(401);
      expect(r.headers.get(access.GUEST_HEADER), name).toBe("1");
    }
  });

  it("an account with no GPU is asked to connect one (connect-gpu, not own-gpu-tool), and nothing is made", async () => {
    expect(viaProxy("/api/image-to-3d", "a").headers.get("x-middleware-next")).toBe("1");
    const own = runAsTenant({ kind: "account", id: c }, () => saveFile({ data: TINY_PNG, contentType: "image/png", source: "upload", name: "c.png" }).url);
    const count = () => (db().prepare("SELECT COUNT(*) AS n FROM generations").get() as { n: number }).n;
    const n = count();
    for (const [name, req] of Object.entries(steps(own))) {
      if (name.startsWith("Refine")) continue; // its GLB is checked as the account's own first (below)
      const r = await route.POST(json("/api/image-to-3d", "POST", req, "c"));
      expect(r.status, name).toBe(403);
      expect(r.headers.get(access.CONNECT_GPU_HEADER), name).toBe("1");
      const body = (await r.json()) as { code?: string; error?: string };
      expect(body.code, name).toBe("connect-gpu");
      expect(body.error, name).not.toMatch(/isn['’]t available/i);
    }
    expect(count()).toBe(n);
    // Refine reads a model of the account's own; one it doesn't own is never reached, and this studio's ComfyUI never is.
    const refine = await route.POST(json("/api/image-to-3d", "POST", steps(own)["Refine this mesh (Hi3D)"], "c"));
    expect([403, 404]).toContain(refine.status);
    expect(((await refine.json()) as { code?: string }).code).not.toBe("own-gpu-tool");
    expect(fetched.filter((u) => u.startsWith("http://owner-comfy.test:8188/prompt"))).toEqual([]);
  });
});
