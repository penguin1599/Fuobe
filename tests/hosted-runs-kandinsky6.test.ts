import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "./helpers/temp-dir";
import { FAKE_POLICY, listenInRange, startFakeBilling, type FakeBilling } from "./helpers/fake-billing";
import { startFakeComfy, type FakeComfy } from "./helpers/fake-comfy-runner";

// Kandinsky 6.0 on hosted runs (FUOBE_HOSTED_RUNS=1; nm10-kandinsky6): an account with no GPU of its own may make a clip with
// dialogue on this install's ComfyUI like any open model, priced by the billing service as a video run; image to video and
// Kandinsky VSR read a file, so they follow the policy's uploads, and fal's Kandinsky never runs there.
const dir = tempDir("fuobe-hosted-k6-");
process.env.FUOBE_DATA_DIR = dir;
process.env.FUOBE_PUBLIC_SIGNUP = "1";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_HOSTED_RUNS;
delete process.env.FUOBE_MODERATION_URL;
globalThis.__fuobeTestDiskFree = 1e13;

const probe = http.createServer();
const comfyPort = await listenInRange(probe);
await new Promise<void>((r) => probe.close(() => r()));
const comfy: FakeComfy = await startFakeComfy({ output: "image", delayMs: 0 }, comfyPort);
process.env.COMFYUI_URL = comfy.url;

const auth = await import("@/server/auth");
const billing = await import("@/server/billing");
const { decidePlace, poolQuote } = await import("@/server/hosted-run");

let fake: FakeBilling;
let account: NonNullable<ReturnType<typeof auth.accountById>>;
beforeAll(async () => {
  fake = await startFakeBilling();
  auth.setPassword("install password");
  account = auth.accountById(auth.createAccount("kandinsky@example.com", "long enough").id)!;
});
afterAll(async () => {
  globalThis.__fuobeTestDiskFree = undefined;
  for (const k of ["FUOBE_HOSTED_RUNS", "FUOBE_BILLING_URL", "FUOBE_BILLING_TOKEN"]) delete process.env[k];
  await fake.close();
  await comfy.close();
});
beforeEach(() => {
  billing.resetBillingCache();
  process.env.FUOBE_HOSTED_RUNS = "1";
  process.env.FUOBE_BILLING_URL = fake.url;
  process.env.FUOBE_BILLING_TOKEN = "test-billing-token";
  fake.policy = { ...FAKE_POLICY };
});

const t2v = { feature: "video" as const, modelId: "oss-kandinsky6", engine: "open" as const, op: "t2v" as const, prompt: "A woman says “Hello”", params: { extra: { quality: "lite" } } };
const i2v = { ...t2v, op: "i2v" as const, inputs: { images: ["/api/files/uploads/face.png"] } };
const vsr = { feature: "upscale" as const, modelId: "oss-kandinsky6-vsr", engine: "open" as const, op: "upscale-video" as const, prompt: "", inputs: { video: "/api/files/uploads/clip.mp4" }, params: { resolution: "2.25x" } };

describe("Kandinsky 6.0 on this install's GPUs", () => {
  it("plans and prices a clip from words there as a video run", async () => {
    const before = fake.calls_of("/v1/quote").length;
    const q = await poolQuote(account, t2v, undefined);
    expect(q).not.toBeNull();
    expect(q!.planned.model.id).toBe("oss-kandinsky6");
    expect(q!.planned.route).toMatchObject({ provider: "comfyui", endpoint: "kandinsky6-t2av" });
    expect(q!.quote).toMatchObject({ amount: 7, priceVersion: "v7" });
    const sent = fake.calls_of("/v1/quote").slice(before);
    expect(sent).toHaveLength(1);
    expect((sent[0].body as { run: Record<string, unknown> }).run).toMatchObject({ place: "pool", model: "oss-kandinsky6", op: "t2v", kind: "video", engine: "open" });
    expect((await decidePlace(account, t2v, undefined)).kind).toBe("pool");
  });

  it("a first frame or a clip to upscale goes there only when the policy takes those uploads", async () => {
    for (const [req, kind] of [[i2v, "image"], [vsr, "video"]] as const) {
      fake.policy = { ...FAKE_POLICY, uploads: { ...FAKE_POLICY.uploads, [kind]: false } };
      billing.resetBillingCache();
      const refused = await decidePlace(account, req, undefined);
      expect(refused.kind, req.modelId).toBe("refuse");
      if (refused.kind === "refuse") expect(refused.refusal.body.code).toBe("not-offered");
      fake.policy = { ...FAKE_POLICY, uploads: { ...FAKE_POLICY.uploads, [kind]: true } };
      billing.resetBillingCache();
      expect((await decidePlace(account, req, undefined)).kind, req.modelId).toBe("pool");
    }
  });

  it("fal's Kandinsky 6.0 and VSR are never priced there", async () => {
    expect(await poolQuote(account, { ...t2v, modelId: "kandinsky-6", engine: "cloud" }, undefined)).toBeNull();
    expect((await decidePlace(account, { ...t2v, modelId: "kandinsky-6", engine: "cloud" }, undefined)).kind).toBe("own");
    expect((await decidePlace(account, { ...vsr, modelId: "kandinsky-vsr", engine: "cloud" }, undefined)).kind).toBe("own");
  });
});
