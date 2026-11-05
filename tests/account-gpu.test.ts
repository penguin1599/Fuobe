import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "./helpers/temp-dir";
import { accountRows } from "./helpers/auth-db";

const dir = tempDir("fuobe-account-gpu-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://owner-comfy.test:8188";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_ALLOW_PRIVATE_URLS;

// Every plain fetch is recorded: an account's run must never reach the install's ComfyUI.
const realFetch = globalThis.fetch;
const fetched: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  fetched.push(String(input instanceof Request ? input.url : input));
  return new Response("not stubbed", { status: 599 });
}) as typeof fetch;

const auth = await import("@/server/auth");
const { checkGpuAddress, GpuError } = await import("@/server/account-gpu");
const { fetchPublic } = await import("@/server/remote-fetch");
const { comfyProvider, onOwnGpu, ownGpu, probeComfy } = await import("@/server/providers/comfyui");
const { accountRun, OWN_GPU_ONLY } = await import("@/server/generations");
const { getSetting } = await import("@/server/settings");
afterAll(() => {
  globalThis.fetch = realFetch;
});

const publicDns = async () => ["93.184.216.34"];

describe("Your GPU: the address", () => {
  it("takes a public address, normalised", async () => {
    expect(await checkGpuAddress(" https://abc.trycloudflare.com/ ", { resolve: publicDns })).toBe("https://abc.trycloudflare.com");
  });

  it("refuses this machine, private networks and the install's own ComfyUI", async () => {
    for (const url of ["http://localhost:8188", "http://127.0.0.1:8188", "http://192.168.1.5:8188", "http://169.254.169.254", "http://comfy:8188", "http://box.local:8188"]) {
      await expect(checkGpuAddress(url, { resolve: publicDns }), url).rejects.toThrow(/only works on your own network/);
    }
    // A public name that resolves to a private address.
    await expect(checkGpuAddress("https://sneaky.example", { resolve: async () => ["10.0.0.7"] })).rejects.toThrow(/only works on your own network/);
    // The install's own ComfyUI by host, on any scheme, port or path (ComfyUI copies every route under /api), with one
    // message that doesn't confirm the guess.
    for (const url of ["http://owner-comfy.test:8188", "https://owner-comfy.test/api", "http://OWNER-comfy.test.:9000/", "https://owner-comfy.test:8188/api/"]) {
      await expect(checkGpuAddress(url, { resolve: publicDns }), url).rejects.toThrow(/can't use this address/);
    }
    await expect(checkGpuAddress("ftp://x.example", { resolve: publicDns })).rejects.toBeInstanceOf(GpuError);
    await expect(checkGpuAddress("https://user:pw@x.example", { resolve: publicDns })).rejects.toThrow(/Access token box/);
  });

  it("connects to public addresses only, checked on the address actually used", async () => {
    await expect(fetchPublic("http://rebound.example:8188/system_stats", {}, { resolve: async () => ["127.0.0.1"] })).rejects.toThrow(/won't fetch/);
    await expect(fetchPublic("http://169.254.169.254/latest", {})).rejects.toThrow(/won't fetch/);
    await expect(fetchPublic("http://[::1]:8188/", {})).rejects.toThrow(/won't fetch/);
  });
});

describe("Your GPU: where an account's runs go", () => {
  let id = "";
  beforeAll(() => {
    auth.setPassword("install password");
    id = auth.createAccount("gpu-runs@example.com", "long enough").id;
  });

  it("refuses an account without a GPU, fal.ai and Replicate without its own key, and any other provider", () => {
    const none = accountRun(id, "comfyui");
    expect("error" in none && none.error).toMatch(/Connect your GPU/);
    auth.setAccountGpu(id, { url: "https://gpu.example", token: "secret" });
    expect(auth.accountGpu(id)).toEqual({ url: "https://gpu.example", token: "secret" });
    // fal.ai and Replicate now run on the account's own key (Your keys): without one, "Add your key", never the studio's.
    for (const p of ["fal", "replicate"]) {
      const r = accountRun(id, p);
      expect("error" in r && r, p).toMatchObject({ code: "add-key", provider: p, error: expect.stringMatching(/^Add your (fal\.ai|Replicate) key/) });
    }
    for (const p of ["llm", "mock"]) {
      const r = accountRun(id, p);
      expect("error" in r && r.error, p).toBe(OWN_GPU_ONLY);
    }
  });

  it("runs on the account's ComfyUI, open engine, no demo outputs", async () => {
    const r = accountRun(id, "comfyui");
    if (!("run" in r)) throw new Error("expected a run");
    const seen = await r.run(async () => ({ own: ownGpu(), mode: getSetting("engineMode"), demo: getSetting("demoMode"), reach: await probeComfy(true) }));
    expect(seen).toEqual({ own: { url: "https://gpu.example", token: "secret" }, mode: "open", demo: "off", reach: true });
    expect(ownGpu()).toBeUndefined();
  });

  it("never falls back to the install's ComfyUI when the account's can't be reached", async () => {
    fetched.length = 0;
    // A name re-pointed at this machine: refused at connect time, and the install's server is never asked.
    const r = await onOwnGpu({ url: "http://127.0.0.1:8188" }, () => comfyProvider.test!());
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/your ComfyUI/);
    expect(fetched.filter((u) => u.includes("owner-comfy.test"))).toEqual([]);
  });

  it("forgets the GPU on disconnect", () => {
    auth.setAccountGpu(id, null);
    expect(auth.accountGpu(id)).toBeNull();
    expect(auth.accountById(id)).not.toHaveProperty("gpu");
    expect(accountRows("auth_account_gpu", id)).toEqual([]);
  });
});

describe("an account's own runs", () => {
  it("are its own: listed, opened, cancelled and deleted by it only, and out of the owner's lists", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const { NextRequest } = await import("next/server");
    const { proxy } = await import("@/proxy");
    const { db } = await import("@/server/db");
    const { listGenerations } = await import("@/server/generations");
    const a = auth.createAccount("own-runs@example.com", "long enough");
    const b = auth.createAccount("other-runs@example.com", "long enough");
    const row = (id: string, account?: string) =>
      db()
        .prepare(
          "INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, outputs_json, created_at, updated_at) VALUES (?, 'image', 'm', 'open', 'comfyui', 'text-to-image', 'image', 'succeeded', ?, '[]', ?, ?)",
        )
        .run(id, JSON.stringify({ feature: "image", modelId: "m", ...(account && { account }) }), Date.now(), Date.now());
    row("owner-run");
    row("a-run", a.id);
    row("b-run", b.id);
    db().prepare("INSERT INTO assets (id, kind, rel_path, content_type, size, source, generation_id, created_at) VALUES ('as1', 'image', 'outputs/a-run.png', 'image/png', 1, 'generation', 'a-run', ?)").run(Date.now());
    expect(listGenerations({ steps: true }).map((g) => g.id)).toEqual(["owner-run"]);
    expect(listGenerations({ steps: true, account: a.id }).map((g) => g.id)).toEqual(["a-run"]);
    const cookie = `${auth.SESSION_COOKIE}=${auth.createSession(a.id).value}`;
    const at = (url: string, method = "GET") => proxy(new NextRequest(`http://localhost:3000${url}`, { method, headers: { cookie }, ...(method !== "GET" && { body: "{}" }) }));
    const passed = (r: Response) => r.headers.get("x-middleware-next") === "1";
    expect(passed(at("/api/generations"))).toBe(true);
    expect(passed(at("/api/generations/a-run"))).toBe(true);
    expect(passed(at("/api/generations/a-run", "DELETE"))).toBe(true);
    // A like, a pin or a review status of its own run.
    expect(passed(at("/api/generations/a-run", "PATCH"))).toBe(true);
    expect(passed(at("/api/generations/a-run/cancel", "POST"))).toBe(true);
    expect(passed(at("/api/files/outputs/a-run.png"))).toBe(true);
    for (const [url, method] of [
      ["/api/generations/owner-run", "GET"],
      ["/api/generations/owner-run", "DELETE"],
      ["/api/generations/b-run", "GET"],
      ["/api/generations/b-run/cancel", "POST"],
      ["/api/generations/b-run", "PATCH"],
      ["/api/files/outputs/owner.png", "GET"],
    ]) {
      expect(at(url, method).status, `${method} ${url}`).toBe(403);
    }
    // The live stream carries everyone's events: not for an account (it polls; no content, so no error in the console).
    expect(at("/api/generations/stream").status).toBe(204);
  });
});

describe("the status strip", () => {
  it("shows a visitor its own GPU, never the install's ComfyUI, servers or Demo mode", async () => {
    const { visitorStatus } = await import("@/server/account-gpu");
    const guest = await visitorStatus(null);
    expect(guest).toMatchObject({ demoMode: "off", engineMode: "open", onboarded: true, viewer: { kind: "guest", gpu: { connected: false } } });
    expect(guest.providers.comfyui).toEqual({ label: "Your GPU", configured: true });
    expect(guest.providers.fal.configured).toBe(false);
    expect(JSON.stringify(guest)).not.toContain("owner-comfy.test");
    expect(guest).not.toHaveProperty("llm");
    const a = auth.createAccount("strip@example.com", "long enough");
    auth.setAccountGpu(a.id, { url: "http://127.0.0.1:8188" });
    const acct = await visitorStatus(auth.accountById(a.id)!);
    // (keys: the providers it added its own key for, none here; paidAllowed: the studio isn't open-source only.)
    expect(acct.viewer).toEqual({
      kind: "account",
      // Why it is offline, in plain words with what helps (an address on this machine is never called).
      gpu: { connected: true, mode: "link", online: false, host: "web", trouble: expect.objectContaining({ cause: "address-local", words: expect.stringMatching(/only works on your own network/) }) },
      keys: [],
      paidAllowed: true,
    });
    expect(acct.providers.comfyui.configured).toBe(false);
    expect(JSON.stringify(acct)).not.toContain("owner-comfy.test");
  });
});

describe("a visitor's price checks", () => {
  it("are priced as the run would go: its own GPU (none yet), the open engine, never a demo", async () => {
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const { priceAs } = await import("@/server/visitor");
    const seen = () => ({ own: ownGpu(), mode: getSetting("engineMode"), demo: getSetting("demoMode") });
    expect(priceAs(new Request("http://localhost:3000/api/shorts/estimate"), seen)).toEqual({ own: { url: "" }, mode: "open", demo: "off" });
    const a = auth.createAccount("prices@example.com", "long enough");
    auth.setAccountGpu(a.id, { url: "https://gpu.example" });
    const asAccount = new Request("http://localhost:3000/api/shorts/estimate", { headers: { cookie: `${auth.SESSION_COOKIE}=${auth.createSession(a.id).value}` } });
    expect(priceAs(asAccount, seen).own).toEqual({ url: "https://gpu.example" });
    const asOwner = new Request("http://localhost:3000/api/shorts/estimate", { headers: { cookie: `${auth.SESSION_COOKIE}=${auth.createSession().value}` } });
    expect(priceAs(asOwner, seen).own).toBeUndefined();
  });
});
