import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeComfy, TINY_PNG, type FakeComfy } from "./helpers/fake-comfy-runner";
import { tempDir } from "./helpers/temp-dir";

/**
 * Idol 3D under public sign-up: an account's Idol run is taken for its own GPU or key on both engines — its own
 * linked ComfyUI (oss-idol, and the quick mesh oss-idol-mesh) and its own fal.ai key (idol-3d) — and so is its "Make
 * the other sides" run (Idol 3D's four views). A run on this install's GPUs stays refused (account-3d-apps.test.ts).
 */

const dir = tempDir("fuobe-account-idol-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://owner-comfy.test:8188";
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
const { getGeneration } = await import("@/server/generations");
const { db } = await import("@/server/db");
const { getModel } = await import("@/lib/catalog");
const { model3dRequest } = await import("@/lib/av/model3d");
const { idolViewsRequest } = await import("@/lib/av/idol-views");

let fake: FakeComfy;
let cookie = "";
let account = "";
beforeAll(async () => {
  fake = await startFakeComfy({ loras: [], delayMs: 0 });
  globalThis.__fuobeTestGpuPort = fake.port;
  auth.setPassword("install password");
  account = auth.createAccount("idol-a@example.com", "long enough").id;
  auth.setAccountGpu(account, { url: fake.url });
  keys.saveAccountKey(account, "fal", "acct-fal-idol");
  cookie = `${auth.SESSION_COOKIE}=${auth.createSession(account).value}`;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  globalThis.__fuobeTestGpuPort = undefined;
  globalThis.__fuobeTestDiskFree = undefined;
  await fake.close();
});

const post = (body: unknown) => {
  const text = JSON.stringify(body);
  return generationsRoute.POST(
    new Request("http://localhost:3000/api/generations", {
      method: "POST",
      headers: { cookie, host: "localhost:3000", "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) },
      body: text,
    }) as never,
  );
};

/** Put a queued run aside, so the next run is under the account's limit of runs at once. */
const cancel = (id: string) => db().prepare("UPDATE generations SET status = 'canceled' WHERE id = ? OR batch_id = ?").run(id, id);

describe("Idol 3D runs on the account's own GPU or key", () => {
  it.each([
    ["open", "oss-idol", "splat", "comfyui"],
    ["cloud", "idol-3d", "splat", "fal"],
    // idol-7: Idol 3D quick mesh, in From an image.
    ["open", "oss-idol-mesh", "image", "comfyui"],
  ] as const)("on the %s engine (%s): taken for the account's own %s", async (engine, modelId, mode, provider) => {
    expect(getModel(modelId)?.engine).toBe(engine);
    const photo = saveFile({ data: TINY_PNG, contentType: "image/png", source: "upload", accountId: account }).url;
    const req = model3dRequest({ engine, mode, modelId, photo, quality: "quick", photoCrop: true });
    expect(req.modelId).toBe(modelId);
    const r = await post(req);
    expect(r.status, await r.clone().text()).toBe(201);
    const [item] = ((await r.json()) as { items: { id: string }[] }).items;
    const g = getGeneration(item.id)!;
    expect(g.request.account).toBe(account);
    expect(g.request.place).toBeUndefined();
    expect(g.provider).toBe(provider);
    cancel(item.id);
  });

  it("the other sides from one picture (Idol 3D's views): taken for the account's own ComfyUI", async () => {
    const photo = saveFile({ data: TINY_PNG, contentType: "image/png", source: "upload", accountId: account }).url;
    const r = await post(idolViewsRequest(photo));
    expect(r.status, await r.clone().text()).toBe(201);
    const items = ((await r.json()) as { items: { id: string }[] }).items;
    expect(items.length).toBeGreaterThan(0);
    for (const { id } of items) {
      expect(getGeneration(id)!.request.account).toBe(account);
      expect(getGeneration(id)!.provider).toBe("comfyui");
      cancel(id);
    }
  });
});
