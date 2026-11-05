import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "./helpers/temp-dir";

// The items that need more than this studio's GPU has (Open-H3 Regenerate and everything that finishes with it, and
// Kandinsky 6.0 Pro): every visitor sees them with a plain label (src/lib/own-setup.ts), a guest's press asks it to sign
// up, and an account runs them on its own GPU only, when that GPU has the memory, never on this studio's GPUs. The
// owner keeps today's rules (tests/regenerate-held.test.ts).

const dir = tempDir("fuobe-own-setup-hw-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";
process.env.FUOBE_PUBLIC_SIGNUP = "1";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_HOSTED_RUNS;

const auth = await import("@/server/auth");
const { runAsTenant } = await import("@/server/tenant");
const { asAccount, AccountRunError } = await import("@/server/generations");
const { ownSetupGate, ownSetupRefusal, requestOwnSetupItem } = await import("@/server/own-setup-run");
const { regenHeld } = await import("@/server/regenerate");
const { ownSetupDetail, ownSetupLabel, ownSetupOnly, ownSetupShort, ownSetupStep } = await import("@/lib/own-setup");
const R = await import("@/lib/catalog/regenerate");

/** The same words tests/own-setup.test.ts keeps out of every label. */
const BANNED = /untested|not tested|unverified|not verified|not validated|validat|isn['’]t available|not available|unavailable|coming soon|held|owner|beta|experimental|soon/i;

const HW_IDS = ["oss-h3-regenerate", "regenerate:upscale", "regenerate:h3-2k", "regenerate:cinema-finish", "regenerate:enhance", "regenerate:faceless", "regenerate:swap-sharpen", "oss-kandinsky6:pro"];

let bare = "";
let linked = "";
beforeAll(() => {
  auth.setPassword("install password");
  bare = auth.createAccount("no-gpu@example.com", "long enough").id;
  linked = auth.createAccount("big-gpu@example.com", "long enough").id;
  auth.setAccountGpu(linked, { url: "https://gpu.example.com" });
});
afterAll(() => {
  globalThis.__fuobeAccountGpus?.delete(linked);
});

/** What the account's GPU last said of its memory, as a status check leaves it. */
const reports = (gb: number) => (globalThis.__fuobeAccountGpus ??= new Map()).set(linked, { url: "https://gpu.example.com", at: Date.now(), online: true, info: { vramBytes: gb * 2 ** 30 } });

describe("hardware items: what a visitor sees", () => {
  it("names a GPU setup for each, with the memory it needs and no status words", () => {
    for (const id of HW_IDS) {
      const o = ownSetupOnly(id);
      expect(o, id).not.toBeNull();
      expect(o!.need, id).toBe("gpu");
      for (const words of [ownSetupLabel(o!), ownSetupShort(o!), ownSetupDetail(o!)]) expect(words, id).not.toMatch(BANNED);
    }
    expect(ownSetupLabel(ownSetupOnly("regenerate:upscale")!)).toBe("Runs on your own GPU · 48 GB");
    expect(ownSetupLabel(ownSetupOnly("oss-kandinsky6:pro")!)).toBe("Runs on your own GPU · 80 GB");
    // Kandinsky 6.0 itself (Lite) runs as any other open model.
    expect(ownSetupOnly("oss-kandinsky6")).toBeNull();
  });

  it("a guest's press asks it to sign up; an account without a GPU connects one (no key runs these); the owner runs", () => {
    const o = ownSetupOnly("regenerate:upscale");
    expect(ownSetupStep(o, { kind: "guest" })).toEqual({ kind: "sign-up" });
    expect(ownSetupStep(o, { kind: "account", gpu: { connected: false }, keys: ["fal"] })).toEqual({ kind: "connect-gpu", gpuOnly: true });
    expect(ownSetupStep(o, { kind: "account", gpu: { connected: true } })).toEqual({ kind: "run" });
    expect(ownSetupStep(o, null)).toEqual({ kind: "run" });
  });

  it("Cinema's exact orbit says it films with a 48 GB GPU or a fal.ai key, and a key runs it", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/components/cinema/prompt-bar.tsx", "utf8");
    expect(src).toMatch(/<OwnSetupChip setup="fly-around:exact-orbit"/);
    const o = ownSetupOnly("fly-around:exact-orbit")!;
    expect(ownSetupLabel(o)).toBe("Runs on your own GPU · 48 GB or fal.ai key");
    for (const words of [ownSetupLabel(o), ownSetupShort(o), ownSetupDetail(o)]) expect(words).not.toMatch(BANNED);
    expect(ownSetupStep(o, { kind: "guest" })).toEqual({ kind: "sign-up" });
    expect(ownSetupStep(o, { kind: "account", gpu: { connected: false }, keys: ["fal"] })).toEqual({ kind: "run" });
    expect(ownSetupStep(o, { kind: "account", gpu: { connected: false } })).toMatchObject({ kind: "connect-gpu" });
  });
});

describe("hardware items: where an account's run goes", () => {
  it("asks an account with no GPU of its own to connect one, in the item's own words, never own-gpu-tool", () => {
    asAccount(bare, () => {
      const r = ownSetupRefusal("regenerate:h3-2k");
      expect(r).toEqual({ error: ownSetupDetail(ownSetupOnly("regenerate:h3-2k")!), code: "connect-gpu" });
      expect(() => ownSetupGate("regenerate:h3-2k")).toThrow(AccountRunError);
    });
  });

  it("runs on the account's own GPU when it has the memory, or hasn't said yet; a smaller card connects a bigger one", () => {
    asAccount(linked, () => {
      expect(ownSetupRefusal("oss-h3-regenerate")).toBeNull();
      reports(47.5);
      expect(ownSetupRefusal("oss-h3-regenerate")).toBeNull();
      reports(32);
      expect(ownSetupRefusal("oss-h3-regenerate")?.code).toBe("connect-gpu");
      reports(80);
      expect(ownSetupRefusal("oss-kandinsky6:pro")).toBeNull();
      reports(48);
      expect(ownSetupRefusal("oss-kandinsky6:pro")?.code).toBe("connect-gpu");
    });
  });

  it("never goes on this studio's GPUs", () => {
    reports(96);
    asAccount(linked, () => expect(ownSetupRefusal("oss-h3-regenerate", "pool")?.code).toBe("connect-gpu"));
    // Outside the account's own GPU scope.
    runAsTenant({ kind: "account", id: linked }, () => expect(ownSetupRefusal("oss-h3-regenerate")?.code).toBe("connect-gpu"));
  });

  it("leaves the owner's and a guest's price check to today's rules", () => {
    expect(ownSetupRefusal("oss-h3-regenerate")).toBeNull();
    runAsTenant({ kind: "guest" }, () => expect(ownSetupRefusal("oss-h3-regenerate")).toBeNull());
  });

  it("checks every way a run asks for them: Regenerate, Enhance, H3 in 2K and Kandinsky 6.0 Pro", () => {
    expect(requestOwnSetupItem({ modelId: "oss-kandinsky6", params: { extra: { quality: "pro" } } })).toBe("oss-kandinsky6:pro");
    expect(requestOwnSetupItem({ modelId: "oss-kandinsky6", params: { extra: { quality: "lite" } } })).toBeUndefined();
    const asks = [
      { feature: "upscale", modelId: R.REGEN_MODEL },
      { feature: "video-edit", modelId: R.REGEN_MODEL },
      { feature: "video", modelId: R.H3_OPEN_MODEL, params: { resolution: "2K" } },
      { feature: "video", modelId: "oss-kandinsky6", params: { extra: { quality: "pro" } } },
    ];
    for (const ask of asks) {
      asAccount(bare, () => {
        let code: string | undefined;
        try {
          regenHeld(ask);
        } catch (e) {
          code = (e as InstanceType<typeof AccountRunError>).refusal?.code;
        }
        expect(code, ask.modelId).toBe("connect-gpu");
      });
    }
    // An account's 768p H3 and Kandinsky Lite are anyone's runs.
    asAccount(bare, () => {
      expect(regenHeld({ feature: "video", modelId: R.H3_OPEN_MODEL, params: { resolution: "768p" } })).toBeUndefined();
      expect(regenHeld({ feature: "video", modelId: "oss-kandinsky6", params: { extra: { quality: "lite" } } })).toBeUndefined();
    });
    // The owner's: today's plain words while it is held on this studio's GPUs, and Kandinsky Pro as before.
    expect(regenHeld({ feature: "upscale", modelId: R.REGEN_MODEL })).toBe(R.REGEN_COPY.held);
    expect(regenHeld({ feature: "video", modelId: R.H3_OPEN_MODEL, params: { resolution: "2K" } })).toBe(R.REGEN_COPY.heldTwoK);
    expect(regenHeld({ feature: "video", modelId: "oss-kandinsky6", params: { extra: { quality: "pro" } } })).toBeUndefined();
  });
});
