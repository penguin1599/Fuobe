import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TINY_MP4 } from "./helpers/fake-comfy-runner";
import { tempDir } from "./helpers/temp-dir";

/**
 * Hosted routes no live call has passed yet (src/lib/catalog/hosted-untested.ts) run on a visitor's own key: an
 * account with a fal.ai key gets them in its pickers and its run goes on that key; one without the key is asked for it
 * (403 add-key), never refused. The owner runs them as before. own-setup.ts labels them "Use your own fal.ai key".
 */

const dir = tempDir("fuobe-hosted-untested-");
process.env.FUOBE_DATA_DIR = dir;
process.env.FUOBE_PUBLIC_SIGNUP = "1";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_ENGINE_MODE;
globalThis.__fuobeTestDiskFree = 1e13;

const realFetch = globalThis.fetch;
const fetched: string[] = [];
globalThis.fetch = (async (u: RequestInfo | URL) => {
  fetched.push(String(u));
  return new Response("not stubbed", { status: 599 });
}) as typeof fetch;

const auth = await import("@/server/auth");
const keys = await import("@/server/account-keys");
const generationsRoute = await import("@/app/api/generations/route");
const { saveFile } = await import("@/server/storage");
const { MODELS, getModel } = await import("@/lib/catalog");
const { HOSTED_UNTESTED_ENDPOINTS, HOSTED_UNTESTED_MODELS, hostedUntested, hostedUntestedSummary, isHostedUntested } = await import("@/lib/catalog/hosted-untested");
const { ownSetupOnly } = await import("@/lib/own-setup");
const { visitorStatus } = await import("@/server/account-gpu");
const { HUB_MODES } = await import("@/lib/hubs");

let cookie = "";
let account = "";
let keylessCookie = "";
beforeAll(() => {
  auth.setPassword("install password");
  account = auth.createAccount("untested-a@example.com", "long enough").id;
  keys.saveAccountKey(account, "fal", "acct-fal-untested");
  cookie = `${auth.SESSION_COOKIE}=${auth.createSession(account).value}`;
  const keyless = auth.createAccount("untested-b@example.com", "long enough").id;
  keylessCookie = `${auth.SESSION_COOKIE}=${auth.createSession(keyless).value}`;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  globalThis.__fuobeTestDiskFree = undefined;
});

const post = (body: unknown, who: string | null = cookie, preview = true) => {
  const text = JSON.stringify(body);
  return generationsRoute.POST(
    new Request(`http://localhost:3000/api/generations${preview ? "?preview=1" : ""}`, {
      method: "POST",
      headers: { ...(who && { cookie: who }), host: "localhost:3000", "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) },
      body: text,
    }) as never,
  );
};

describe("hosted routes without a live call", () => {
  it("lists only endpoints and models the catalog has", () => {
    const endpoints = new Set(MODELS.flatMap((m) => m.routes.map((r) => r.endpoint)));
    // The song tools' upload is a call inside a run, not a route of its own.
    for (const e of HOSTED_UNTESTED_ENDPOINTS) if (e !== "mureka/api/files/upload") expect(endpoints.has(e), e).toBe(true);
    for (const id of HOSTED_UNTESTED_MODELS) expect(getModel(id), id).toBeDefined();
    expect(isHostedUntested("anything", { provider: "comfyui", endpoint: "minimax/h3-lite" })).toBe(false);
    expect(isHostedUntested("fuobe-animation", { provider: "comfyui", endpoint: "wan22-inbetween-anisora" })).toBe(false);
    expect(isHostedUntested("lyria-3-5", { provider: "fal", endpoint: "google/lyria-3.5" })).toBe(true);
    // A visitor's run leaves none of them out any more.
    expect(hostedUntested("lyria-3-5", { provider: "fal", endpoint: "google/lyria-3.5" })).toBe(false);
  });

  it.each([
    ["mureka-stems", { feature: "song-tools" }],
    ["lyria-3-5", { feature: "audio" }],
    ["elevenlabs-music-2-5", { feature: "audio" }],
  ] as const)("prices an account's %s run on its own fal.ai key", async (modelId, extra) => {
    const song = saveFile({ data: Buffer.from("ID3song"), contentType: "audio/mpeg", source: "upload", accountId: account }).url;
    const r = await post({ ...extra, modelId, engine: "cloud", prompt: "a slow jazz song", ...(modelId === "mureka-stems" && { inputs: { audio: song } }) });
    expect(r.status, await r.clone().text()).toBe(200);
    expect((await r.json()).route.provider).toBe("fal");
    expect(ownSetupOnly(modelId)).toEqual({ need: "key", provider: "fal" });
  });

  it("asks an account without a key for it, and a guest to sign up; nothing is sent", async () => {
    fetched.length = 0;
    const keyless = await post({ feature: "audio", modelId: "lyria-3-5", engine: "cloud", prompt: "a slow jazz song" }, keylessCookie, false);
    expect(keyless.status, await keyless.clone().text()).toBe(403);
    expect((await keyless.json()).code).not.toBe("own-gpu-tool");
    const guest = await post({ feature: "audio", modelId: "lyria-3-5", engine: "cloud", prompt: "a slow jazz song" }, null, false);
    expect(guest.status).toBe(401);
    expect(fetched.filter((u) => /fal\.(run|ai|media)/.test(u))).toHaveLength(0);
  });

  it("still prices a hosted model that has had its live call, on the account's key", async () => {
    const r = await generationsRoute.POST(
      new Request("http://localhost:3000/api/generations?preview=1", {
        method: "POST",
        headers: { cookie, host: "localhost:3000", "content-type": "application/json" },
        body: JSON.stringify({ feature: "audio", modelId: "sonilo-music", engine: "cloud", prompt: "a slow jazz song" }),
      }) as never,
    );
    expect(r.status, await r.clone().text()).toBe(200);
    const priced = await post({ feature: "audio", modelId: "lyria-3-5", engine: "cloud", prompt: "a slow jazz song" });
    expect(priced.status).toBe(200);
  });

  it("keeps them in an account's pickers, both engines of an Original too, and opens Extend & remix", async () => {
    const summary = hostedUntestedSummary(MODELS, undefined);
    for (const id of ["mureka-extend", "mureka-remix", "mureka-stems", "lyria-3-5", "vidu-q4", "tripo-p2", "minimax-h3-max-turbo", "fuobe-animation"]) expect(summary.off, id).not.toContain(id);
    expect(summary.engines?.["fuobe-animation"]).toBeUndefined();
    const status = await visitorStatus(auth.accountById(account)!);
    expect(status.access?.off ?? []).not.toContain("mureka-stems");
    const song = HUB_MODES.audio.find((m) => m.id === "song");
    expect(song?.ownerOnly).toBeUndefined();
    expect(song?.ownSetup).toBe("mureka-extend");
    // The Original's cloud half needs the key; its open half runs as before.
    expect(ownSetupOnly("fuobe-animation")).toBeNull();
    expect(ownSetupOnly("fuobe-animation", "cloud")).toEqual({ need: "key", provider: "fal" });
  });
});

describe("Kandinsky 6.0, Kandinsky VSR, Bria's green screen and its guided cut-out (no live call yet)", () => {
  // The asker's own files: an account's run may read only its uploads.
  const pic = (accountId?: string) => saveFile({ data: Buffer.from("89504e470d0a1a0a", "hex"), contentType: "image/png", source: "upload", ...(accountId && { accountId }) }).url;
  const clip = (accountId?: string) => saveFile({ data: TINY_MP4, contentType: "video/mp4", source: "upload", ...(accountId && { accountId }) }).url;
  // One request per endpoint, as its studio sends it (Kandinsky's Quality picks Pro's or Lite's endpoint).
  const k6 = (op: "t2v" | "i2v", quality: string) => (accountId?: string) => ({
    feature: "video",
    modelId: "kandinsky-6",
    op,
    prompt: "A fox runs through the snow",
    ...(op === "i2v" && { inputs: { images: [pic(accountId)] } }),
    params: { extra: { quality } },
  });
  const ROUTES: [string, (accountId?: string) => Record<string, unknown>][] = [
    ["fal-ai/kandinsky6-pro/text-to-video", k6("t2v", "pro-standard")],
    ["fal-ai/kandinsky6-lite/text-to-video", k6("t2v", "lite-standard")],
    ["fal-ai/kandinsky6-pro/image-to-video", k6("i2v", "pro-standard")],
    ["fal-ai/kandinsky6-lite/image-to-video", k6("i2v", "lite-standard")],
    ["fal-ai/kandinsky6-vsr", (a) => ({ feature: "upscale", modelId: "kandinsky-vsr", op: "upscale-video", prompt: "", inputs: { video: clip(a) }, params: { resolution: "2.25x" } })],
    ["bria/video/background-removal/green-screen-despill", (a) => ({ feature: "video-tools", modelId: "bria-green-screen", op: "bg-remove-video", prompt: "", inputs: { video: clip(a) } })],
    ["bria/guided-remove-background", (a) => ({ feature: "image-tools", modelId: "bria-guided-cutout", op: "bg-remove", prompt: "keep the shadow", inputs: { images: [pic(a)] } })],
  ];

  it("lists every endpoint this round added to the catalog", () => {
    for (const [endpoint] of ROUTES) expect(HOSTED_UNTESTED_ENDPOINTS.has(endpoint), endpoint).toBe(true);
  });

  it.each(ROUTES)("prices an account's run on %s on its own key", async (endpoint, ask) => {
    const r = await post({ ...ask(account), engine: "cloud" });
    expect(r.status, await r.clone().text()).toBe(200);
    expect((await r.json()).route).toEqual({ provider: "fal", endpoint });
  });

  it.each(ROUTES)("runs %s for the owner", async (endpoint, ask) => {
    const owner = `${auth.SESSION_COOKIE}=${auth.createSession().value}`;
    process.env.FAL_KEY = "owner-fal-key";
    try {
      const r = await generationsRoute.POST(
        new Request("http://localhost:3000/api/generations?preview=1", {
          method: "POST",
          headers: { cookie: owner, host: "localhost:3000", "content-type": "application/json" },
          body: JSON.stringify({ ...ask(), engine: "cloud" }),
        }) as never,
      );
      expect(r.status, await r.clone().text()).toBe(200);
      expect((await r.json()).route).toEqual({ provider: "fal", endpoint });
    } finally {
      delete process.env.FAL_KEY;
    }
  });

  it("keeps the cloud models and their open halves in an account's pickers, the cloud ones labelled", () => {
    const summary = hostedUntestedSummary(MODELS, undefined);
    for (const id of ["kandinsky-6", "kandinsky-vsr", "bria-green-screen", "bria-guided-cutout", "oss-kandinsky6", "oss-kandinsky6-vsr", "oss-video-key-corridorkey", "oss-matte-feynobg"]) expect(summary.off, id).not.toContain(id);
    for (const id of ["kandinsky-6", "kandinsky-vsr", "bria-green-screen", "bria-guided-cutout"]) expect(ownSetupOnly(id), id).toEqual({ need: "key", provider: "fal" });
    for (const id of ["oss-kandinsky6-vsr", "oss-video-key-corridorkey", "oss-matte-feynobg"]) expect(ownSetupOnly(id), id).toBeNull();
  });
});
