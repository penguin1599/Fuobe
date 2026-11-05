import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listenInRange, startFakeBilling, type FakeBilling } from "./helpers/fake-billing";
import { startFakeComfy, type FakeComfy } from "./helpers/fake-comfy-runner";

// MiniMax H3 at 2K with hosted runs on: an account's 2K run finishes with Open-H3 Regenerate, which needs a 48 GB card,
// so it never goes on this install's GPUs (src/lib/own-setup.ts): it runs on the account's own GPU. Its 768p draft
// alone still runs here.
// Regenerate is switched off for now (REGEN_OFFERED); these tests check it as it runs once switched on.
// tests/regenerate-offered.test.ts checks where it is offered.
vi.mock("@/lib/catalog/regenerate", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/catalog/regenerate")>()), REGEN_OFFERED: true }));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fuobe-regen-hosted-"));
process.env.FUOBE_DATA_DIR = dir;
process.env.FUOBE_PUBLIC_SIGNUP = "1";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_HOSTED_RUNS;
delete process.env.FUOBE_BILLING_URL;
delete process.env.FUOBE_MODERATION_URL;
globalThis.__fuobeTestDiskFree = 1e13;

const probe = http.createServer();
const comfyPort = await listenInRange(probe);
await new Promise<void>((r) => probe.close(() => r()));
const comfy: FakeComfy = await startFakeComfy({ output: "video", delayMs: 0 }, comfyPort);
process.env.COMFYUI_URL = comfy.url;

const auth = await import("@/server/auth");
const billing = await import("@/server/billing");
const { resetRates } = await import("@/server/rate");
const { decidePlace, poolQuote } = await import("@/server/hosted-run");
const R = await import("@/lib/catalog/regenerate");

let fake: FakeBilling;
let a = "";
beforeAll(async () => {
  fake = await startFakeBilling();
  auth.setPassword("install password");
  a = auth.createAccount("hosted-2k@example.com", "long enough").id;
});
afterAll(async () => {
  globalThis.__fuobeTestDiskFree = undefined;
  for (const k of ["FUOBE_HOSTED_RUNS", "FUOBE_BILLING_URL", "FUOBE_BILLING_TOKEN"]) delete process.env[k];
  await fake.close();
  await comfy.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
});
beforeEach(() => {
  resetRates();
  billing.resetBillingCache();
  process.env.FUOBE_HOSTED_RUNS = "1";
  process.env.FUOBE_BILLING_URL = fake.url;
  process.env.FUOBE_BILLING_TOKEN = "test-billing-token";
  fake.policy = { hosted: true, pool: {}, uploads: { image: true, video: false, audio: false }, limits: { activeRuns: 7, waiting: 7, runsPerHour: 70, outputsPerRun: 2, maxMegapixels: 7, maxSeconds: 7, keepDays: 7, spaceBytes: 7 }, ttlS: 0 };
});

const twoK = (resolution = "2K") => ({ feature: "video", modelId: R.H3_OPEN_MODEL, op: "t2v" as const, prompt: "A lighthouse in a storm", params: { resolution, duration: 5, numOutputs: 2 } });

describe("MiniMax H3 at 2K on this install's GPUs", () => {
  it("never goes on these GPUs: its Open-H3 Regenerate finish needs a 48 GB card, so it runs on the account's own GPU", async () => {
    expect(await poolQuote(auth.accountById(a)!, twoK(), undefined)).toBeNull();
    expect((await decidePlace(auth.accountById(a)!, twoK(), undefined)).kind).not.toBe("pool");
    // 768p is the model alone, and runs here.
    const draft = await decidePlace(auth.accountById(a)!, twoK("768p"), undefined);
    expect(draft.kind).toBe("pool");
    if (draft.kind === "pool") expect(draft.planned.steps).toBeUndefined();
  });

  it("a policy that keeps Open-H3 Regenerate off these GPUs changes nothing for 768p", async () => {
    fake.policy = { ...fake.policy, pool: { deny: [R.REGEN_MODEL] } };
    expect(await poolQuote(auth.accountById(a)!, twoK(), undefined)).toBeNull();
    expect((await decidePlace(auth.accountById(a)!, twoK(), undefined)).kind).not.toBe("pool");
    expect((await decidePlace(auth.accountById(a)!, twoK("768p"), undefined)).kind).toBe("pool");
  });
});
