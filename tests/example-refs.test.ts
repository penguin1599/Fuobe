import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, TINY_PNG, type FakeComfy } from "./helpers/fake-comfy-runner";
import { tempDir } from "./helpers/temp-dir";

/**
 * "Start from an example": a run may read Fuobe's published example inputs (src/server/example-files.ts), the same for
 * everyone, by their exact path: a guest's price check, an account's run on its own GPU (the bytes go to its ComfyUI,
 * never a link), the owner's. Nothing else outside the visitor's own files: not another file under public/, not a path
 * that steps out of its folder, not a link.
 */

const dir = tempDir("fuobe-example-refs-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://owner-comfy.test:8188";
process.env.FUOBE_PUBLIC_SIGNUP = "1";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_ALLOW_PRIVATE_URLS;
globalThis.__fuobeTestDiskFree = 1e13;

const realFetch = globalThis.fetch;
const fetched: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  fetched.push(String(input instanceof Request ? input.url : input));
  return new Response("not stubbed", { status: 599 });
}) as typeof fetch;

const auth = await import("@/server/auth");
const generationsRoute = await import("@/app/api/generations/route");
const { guardRef, readRef, localHead, storedMedia, saveFile, RefError } = await import("@/server/storage");
const { isExampleRef, readExampleFile } = await import("@/server/example-files");
const { accountInputProblem } = await import("@/server/account-inputs");
const { accountRun, getGeneration } = await import("@/server/generations");
const { runAsTenant } = await import("@/server/tenant");
const { EXAMPLE_MEDIA } = await import("@/lib/examples/media.generated");
const { imageSize } = await import("@/lib/image-size");
const { db } = await import("@/server/db");
const { resetRates } = await import("@/server/rate");

/** A published example picture, and one of its display copies (an inset: never a file a run reads). */
const PICTURE = "/examples/app-relight/1/in-image.jpg";
const OWN = "/examples/app-face-swap/1/in-image2.jpg";
const INSET = "/examples/app-relight/1/in-image.384.webp";
/** A preset's before still: shown on its page, but its own script rewrites it, so no run reads it. */
const PRESET_STILL = "/previews/presets/ba/1280/app-relight-before.jpg";

let fake: FakeComfy;
let a = "";
let b = "";
let cookie = "";
beforeAll(async () => {
  fake = await startFakeComfy({ loras: [], delayMs: 0 });
  globalThis.__fuobeTestGpuPort = fake.port;
  auth.setPassword("install password");
  a = auth.createAccount("examples-a@example.com", "long enough").id;
  b = auth.createAccount("examples-b@example.com", "long enough").id;
  auth.setAccountGpu(a, { url: fake.url });
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
  db().prepare("UPDATE generations SET status = 'canceled' WHERE status IN ('queued', 'running')").run();
});

const guest = <T,>(fn: () => T) => runAsTenant({ kind: "guest" }, fn);
const account = <T,>(id: string, fn: () => T) => runAsTenant({ kind: "account", id }, fn);
const onDisk = (ref: string) => fs.readFileSync(path.join(process.cwd(), "public", ref));

describe("the published example inputs", () => {
  it("lists the files the examples load, each a run may read", () => {
    expect(EXAMPLE_MEDIA[PICTURE]?.role).toBe("in");
    expect(EXAMPLE_MEDIA[OWN]?.role).toBe("in");
    expect(isExampleRef(PICTURE)).toBe(true);
    expect(isExampleRef(OWN)).toBe(true);
  });

  it("refuses anything that is not an exact listed input", () => {
    for (const ref of [
      "/previews/presets/not-listed.jpg",
      PRESET_STILL,
      INSET,
      "/examples/not-listed.jpg",
      "/examples/../../.env",
      "/examples/app-relight/1/../../../../.env",
      "/examples/%2e%2e/%2e%2e/.env",
      "/examples/app-relight/1/in-image%2Ejpg",
      `${PICTURE}?v=1`,
      `${PICTURE}#x`,
      `https://fuobe.com${PICTURE}`,
      `//fuobe.com${PICTURE}`,
      PICTURE.replace(/\//g, "\\"),
      `/public${PICTURE}`,
      "/api/files/uploads/x.png",
    ]) {
      expect(isExampleRef(ref), ref).toBe(false);
    }
  });

  it("passes guardRef for a guest and for an account; another path still doesn't", () => {
    expect(() => guest(() => guardRef(PICTURE))).not.toThrow();
    expect(() => account(a, () => guardRef(PICTURE))).not.toThrow();
    for (const ref of ["/previews/presets/not-listed.jpg", PRESET_STILL, "/previews/%2e%2e/%2e%2e/.env", `https://fuobe.com${PICTURE}`]) {
      expect(() => guest(() => guardRef(ref)), ref).toThrow(RefError);
    }
  });

  it("reads its bytes and its type for anyone, from disk", async () => {
    for (const run of [<T,>(fn: () => T) => fn(), guest, <T,>(fn: () => T) => account(a, fn)]) {
      const f = await run(() => readRef(PICTURE));
      expect(f.contentType).toBe("image/jpeg");
      expect(f.data.equals(onDisk(PICTURE))).toBe(true);
    }
    expect((await readExampleFile(OWN)).data.equals(onDisk(OWN))).toBe(true);
    expect(fetched.filter((u) => u.includes("/previews/") || u.includes("/examples/"))).toEqual([]);
  });

  it("gives a guest's price check its header: the picture's size, and a clip's facts", () => {
    const head = guest(() => localHead(PICTURE));
    expect(head).not.toBeNull();
    expect(imageSize(head!)).toMatchObject({ width: 1280, height: 960 });
    expect(guest(() => storedMedia(PICTURE))).not.toBeNull();
    expect(guest(() => localHead("/previews/presets/not-listed.jpg"))).toBeNull();
  });

  it("is a file an account's run may name, while another account's file still isn't", () => {
    expect(accountInputProblem({ inputs: { images: [PICTURE, OWN] } }, a)).toBeNull();
    expect(accountInputProblem({ inputs: {}, params: { extra: { reference: PICTURE } } } as never, a)).toBeNull();
    const theirs = saveFile({ data: TINY_PNG, contentType: "image/png", source: "upload", accountId: b });
    expect(accountInputProblem({ inputs: { images: [PICTURE, theirs.url] } }, a)?.code).toBe("input-not-yours");
    expect(accountInputProblem({ inputs: { images: ["/previews/presets/not-listed.jpg"] } }, a)?.code).toBe("input-not-allowed");
  });
});

describe("an account runs an example on its own GPU", () => {
  const json = (body: unknown) => {
    const text = JSON.stringify(body);
    return new Request("http://localhost:3000/api/generations", { method: "POST", headers: { cookie, host: "localhost:3000", "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) }, body: text });
  };
  async function settle(id: string, ms = 15_000) {
    const end = Date.now() + ms;
    for (;;) {
      await globalThis.__fuobeRunner?.tick();
      const g = getGeneration(id, { includeDeleted: true });
      if (!g || (g.status !== "queued" && g.status !== "running") || Date.now() > end) return g;
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  it("sends the example's bytes to its ComfyUI (never a link), with no upload of its own", async () => {
    fake.log.length = 0;
    const r = await generationsRoute.POST(json({ feature: "video", modelId: "fuobe-dop", presetId: "motion-zoom-in", prompt: "", inputs: { images: [PICTURE] } }));
    expect(r.status, await r.clone().text()).toBe(201);
    const g = await settle((await r.json()).items[0].id);
    expect(g?.request.inputs?.images).toEqual([PICTURE]);
    const up = fake.log.filter((e) => e.path === "/upload/image");
    expect(up.length).toBeGreaterThan(0);
    expect(up.some((e) => e.upload?.equals(onDisk(PICTURE)))).toBe(true);
    // Its files list has nothing new from this: the example is Fuobe's.
    expect(db().prepare("SELECT COUNT(*) AS n FROM assets WHERE account_id = ? AND source = 'upload'").get(a)).toMatchObject({ n: 0 });
    // And the account's run never fetched a link.
    expect(fetched.filter((u) => u.includes(PICTURE))).toEqual([]);
    void accountRun;
  });
});

describe("a tool's own example", () => {
  it("lets Clean up voice price its example recording for a guest, and still refuses another path", async () => {
    const { previewAudioTool, AudioToolBody } = await import("@/server/audio-tools");
    // Priced as the demo install prices it (no ComfyUI here): what matters is that the recording is read.
    const { setSetting } = await import("@/server/settings");
    setSetting("demoMode", "auto");
    const recording = "/samples/clean-voice/noisy.m4a";
    expect(isExampleRef(recording)).toBe(true);
    const body = AudioToolBody.parse({ tool: "clean", engine: "open", media: recording, kind: "audio", name: "Restaurant" });
    const preview = await guest(() => previewAudioTool(body));
    expect(preview.steps).toBeGreaterThan(0);
    expect(preview.length).toBeGreaterThan(0);
    expect(AudioToolBody.safeParse({ tool: "clean", engine: "open", media: "/samples/clean-voice/clean.m4a", kind: "audio" }).success).toBe(false);
    expect(AudioToolBody.safeParse({ tool: "clean", engine: "open", media: "/samples/../.env", kind: "audio" }).success).toBe(false);
  });
});
