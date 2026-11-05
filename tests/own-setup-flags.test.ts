import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "./helpers/temp-dir";
import { WORLD_MODEL } from "@/lib/world";

vi.mock("server-only", () => ({}));

/**
 * The "runs on your own setup" marks of the items that wait for a check on this studio's GPU leave by themselves once
 * the flags say so: a recorded pass (workflows/comfyui/gpu-tested.json) or a validated graph (the manifest).
 */
const { graphsReady } = await import("@/server/own-setup-live");
const { genjutsuLive } = await import("@/server/genjutsu-live");

const BANNED = /untested|not tested|unverified|not verified|not validated|validat|isn['’]t available|not available|unavailable|coming soon|held|owner|beta|experimental|soon/i;

describe("own setup: the marks follow the GPU checks", () => {
  it("marks Cinema's World mode until its graph is validated, then drops the mark", async () => {
    const { ownSetupLabel, ownSetupOnly } = await import("@/lib/own-setup");
    const d = tempDir("fuobe-own-setup-flags-");
    const manifest = (validated: boolean) => {
      const file = path.join(d, `m-${validated}.json`);
      fs.writeFileSync(file, JSON.stringify({ workflows: [{ id: "world-hy-nomas-turn", validated }] }));
      return file;
    };
    expect(graphsReady(WORLD_MODEL)).toBe(false);
    expect(graphsReady(WORLD_MODEL, manifest(false))).toBe(false);
    expect(graphsReady(WORLD_MODEL, manifest(true))).toBe(true);
    expect(graphsReady(WORLD_MODEL, path.join(d, "none.json"))).toBe(false);
    // A model with no graph of its own is never "ready" by this check.
    expect(graphsReady("nano-banana-pro", manifest(true))).toBe(false);
    const o = ownSetupOnly("cinema:world");
    expect(o).not.toBeNull();
    expect(ownSetupLabel(o!)).toBe("Runs on your own GPU · 24 GB");
    expect(ownSetupLabel(o!)).not.toMatch(BANNED);
  });

  it("opens a Genjutsu feature, and drops its mark, once its graph is validated and its pass recorded", () => {
    const d = tempDir("fuobe-own-setup-gj-");
    const files = (validated: boolean, passed: boolean) => {
      fs.writeFileSync(path.join(d, "m.json"), JSON.stringify({ workflows: ["image-from-picture-prepare", "video-scene-describe", "video-from-picture-solar"].map((id) => ({ id, validated })) }));
      fs.writeFileSync(path.join(d, "r.json"), JSON.stringify({ features: { picture: { passed } } }));
      return [path.join(d, "m.json"), path.join(d, "r.json")] as const;
    };
    expect(genjutsuLive().picture).toBe(false);
    expect(genjutsuLive(...files(true, false)).picture).toBe(false);
    expect(genjutsuLive(...files(false, true)).picture).toBe(false);
    expect(genjutsuLive(...files(true, true)).picture).toBe(true);
  });

  it("drops an item's label once gpu-tested.json records its pass", async () => {
    const before = await import("@/lib/own-setup");
    const ids = ["genjutsu:picture", "genjutsu:finish-faces", "genjutsu:object-change", "oss-h3-motion", "sound:clean-voice-first", "video-tools:remove-person", "video-tools:remove-object-void"];
    // Each has a setup of its own; it is the visitor's label until its pass is recorded.
    for (const id of ids) expect(before.ownSetupItem(id), id).not.toBeNull();
    // Removing a person with H3 and VOID haven't rendered on this studio's GPU yet: labelled today.
    for (const id of ["video-tools:remove-person", "video-tools:remove-object-void"]) expect(before.ownSetupOnly(id), id).not.toBeNull();
    vi.resetModules();
    vi.doMock("../workflows/comfyui/gpu-tested.json", () => ({
      default: {
        features: {
          picture: { passed: true },
          "finish-faces": { passed: true },
          "object-change": { passed: true },
          "motion-h3": { passed: true },
          "clean-voice-first": { passed: true },
          "remove-person": { passed: true },
          "remove-object-void": { passed: true },
        },
      },
    }));
    const after = await import("@/lib/own-setup");
    for (const id of ids) expect(after.ownSetupOnly(id), id).toBeNull();
    // An item with no pass to wait for keeps its label (the 48 GB card, the Linux worker).
    expect(after.ownSetupOnly("oss-h3-regenerate")).not.toBeNull();
    vi.doUnmock("../workflows/comfyui/gpu-tested.json");
    vi.resetModules();
  });
});
