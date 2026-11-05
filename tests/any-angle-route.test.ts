import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TINY_PNG } from "./helpers/fake-comfy-runner";
import { tempDir } from "./helpers/temp-dir";

// Any Angle through POST /api/generations: a second build of the same photo answers with the first one (running or
// done) and gives the run back to the hourly count; one account never gets another's; an account may build the 3D view
// on its own GPU (like any 3D model there; on this install's GPUs other 3D models are refused).

const dir = tempDir("fuobe-any-angle-route-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";
process.env.FUOBE_PUBLIC_SIGNUP = "1";
delete process.env.FUOBE_PASSWORD;
globalThis.__fuobeTestDiskFree = 1e13;

const auth = await import("@/server/auth");
const generationsRoute = await import("@/app/api/generations/route");
const { saveFile } = await import("@/server/storage");
const { asAccount, createGenerations } = await import("@/server/generations");
const { withRunStamp } = await import("@/server/run-stamp");
const { viewKeyOf } = await import("@/server/any-angle");
const { ANY_ANGLE } = await import("@/lib/catalog/any-angle");
const { OWN_GPU_TOOL_MESSAGE } = await import("@/lib/guest-access");
const { ACCOUNT_LIMITS } = await import("@/server/account-files");
const { db } = await import("@/server/db");
const { hit, peek, resetRates } = await import("@/server/rate");

let a = "";
let b = "";
const cookies: Record<string, string> = {};
beforeAll(() => {
  auth.setPassword("install password");
  a = auth.createAccount("angle-a@example.com", "long enough").id;
  b = auth.createAccount("angle-b@example.com", "long enough").id;
  cookies[a] = `${auth.SESSION_COOKIE}=${auth.createSession(a).value}`;
  cookies[b] = `${auth.SESSION_COOKIE}=${auth.createSession(b).value}`;
});
afterAll(() => {
  globalThis.__fuobeTestDiskFree = undefined;
});

const headers = (who: string, extra: Record<string, string> = {}) => ({ cookie: cookies[who], host: "localhost:3000", ...extra });
const post = (who: string, body: unknown) => {
  const text = JSON.stringify(body);
  return generationsRoute.POST(new Request("http://localhost:3000/api/generations", { method: "POST", headers: headers(who, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) }), body: text }));
};
/** The account's own upload (as POST /api/uploads stores it once its GPU is connected). */
async function upload(who: string, name: string): Promise<string> {
  return saveFile({ contentType: "image/png", name, source: "upload", accountId: who, data: TINY_PNG }).url;
}
function insertBuild(id: string, account: string, photo: string, key: string) {
  const now = Date.now();
  const request = { feature: ANY_ANGLE.stepFeature, modelId: ANY_ANGLE.buildModel, op: "splat", engine: "open", inputs: { images: [photo] }, params: { extra: { viewKey: key } }, account };
  db()
    .prepare(
      `INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, progress, message, request_json, external_id, external_meta_json, outputs_json, created_at, updated_at)
       VALUES (?, ?, ?, 'open', 'comfyui', 'splat', 'model3d', 'running', 0.5, NULL, ?, ?, '{}', '[]', ?, ?)`,
    )
    .run(id, ANY_ANGLE.stepFeature, ANY_ANGLE.buildModel, JSON.stringify(request), `prompt-${id}`, now, now);
}
const build = (photo: string, params?: Record<string, unknown>) => ({ feature: ANY_ANGLE.stepFeature, modelId: ANY_ANGLE.buildModel, op: "splat", engine: "open", inputs: { images: [photo] }, ...(params && { params }) });

describe("Any Angle's 3D view through the route", () => {
  it("answers a second build of the same photo with the first, gives the run back, and never crosses accounts", async () => {
    resetRates();
    const first = await upload(a, "me.png");
    insertBuild("view-a", a, first, viewKeyOf(TINY_PNG));
    // The same photo under another name, at the edge of the hourly count, with a seed of its own.
    const again = await upload(a, "same photo, new name.png");
    const key = `run:${a}`;
    for (let i = 0; i < ACCOUNT_LIMITS.runsPerHour - 1; i++) hit(key, ACCOUNT_LIMITS.runsPerHour, 60 * 60_000);
    const r = await post(a, build(again, { seed: 7 }));
    expect(r.status).toBe(201);
    expect(((await r.json()) as { items: { id: string }[] }).items.map((g) => g.id)).toEqual(["view-a"]);
    // The run was given back: one more still fits this hour.
    expect(peek(key, ACCOUNT_LIMITS.runsPerHour, 60 * 60_000).ok).toBe(true);

    // Another account with the very same picture doesn't get it.
    resetRates();
    const theirs = await upload(b, "me.png");
    const other = await post(b, build(theirs));
    const body = (await other.json()) as { items?: { id: string }[] };
    expect(body.items?.map((g) => g.id) ?? []).not.toContain("view-a");
  });

  it("lets an account build the 3D view on its own GPU (other 3D models aren't made on this install's GPUs)", async () => {
    const photo = await upload(a, "build.png");
    let refused: unknown = null;
    try {
      createGenerations({ ...build(photo), account: a } as never);
    } catch (e) {
      refused = e;
    }
    // Whatever else stops it here (no GPU connected in this test), it isn't the 3D finish that keeps accounts out.
    expect((refused as Error | null)?.message ?? "").not.toBe(OWN_GPU_TOOL_MESSAGE);
    expect(() => asAccount(a, () => withRunStamp({ place: "pool" }, () => createGenerations({ feature: "image-to-3d", modelId: "oss-triposplat", op: "splat", engine: "open", inputs: { images: [photo] } } as never)))).toThrow(OWN_GPU_TOOL_MESSAGE);

  });
});
