import { describe, expect, it } from "vitest";
import { getModel, MODELS } from "@/lib/catalog";
import { HOSTED_UNTESTED_ENDPOINTS, isHostedUntested } from "@/lib/catalog/hosted-untested";
import { OWN_SETUP_IDS, ownSetupDetail, ownSetupItem, ownSetupLabel, ownSetupOnly, ownSetupShort, ownSetupStep, type OwnSetup } from "@/lib/own-setup";

/**
 * "Runs with your own setup" (src/lib/own-setup.ts): the items a visitor sees and runs only on its own GPU or its own
 * fal.ai / Replicate key. Their words are plain and positive, a press never refuses, the owner keeps today's runs, and
 * the hosted runs can ask, for each of them, that it never goes on this studio's GPUs or keys.
 */

/** Words a visitor never reads on these labels: they say why, not what to use. */
const BANNED = /untested|not tested|unverified|not verified|not validated|validat|isn['’]t available|not available|unavailable|coming soon|held|owner|beta|experimental|soon/i;

/**
 * Every item of the sweep of what is hidden or held from visitors, by the id each surface asks own-setup.ts with. The
 * items left out have no setup a visitor makes (see SKIPPED).
 */
const INVENTORY: Record<string, string[]> = {
  "regenerate (Upscale, result menu, Canvas node, picker)": ["oss-h3-regenerate", "regenerate:upscale"],
  "MiniMax H3 in 2K on your GPU": ["regenerate:h3-2k"],
  "Cinema Finish in 2K on a GPU take": ["regenerate:cinema-finish"],
  "Enhance on Shorts and Edit video": ["regenerate:enhance"],
  "Faceless Regenerate to 1080p": ["regenerate:faceless"],
  "Character Swap Sharpen and open 1080p/2K/4K": ["regenerate:swap-sharpen"],
  "MiniMax H3 Fast decode": ["h3:fast-decode"],
  "Genjutsu group swap one by one": ["genjutsu:group-swap-one-by-one"],
  "Genjutsu Change it": ["genjutsu:object-change", "oss-h3-scene-edit"],
  "Genjutsu Remove it": ["genjutsu:object-remove"],
  "Genjutsu New background": ["genjutsu:object-background"],
  "Genjutsu From picture": ["genjutsu:picture", "oss-from-picture", "oss-from-picture-frame"],
  "Genjutsu From picture Light": ["genjutsu:picture-light"],
  "Genjutsu From picture own person": ["genjutsu:picture-own-person"],
  "Genjutsu From picture H3 renderer": ["genjutsu:picture-h3-renderer"],
  "Genjutsu Fix faces": ["genjutsu:finish-faces", "oss-h3-fix-faces"],
  "Genjutsu Motion transfer H3": ["genjutsu:motion-h3", "oss-h3-motion"],
  "Clean the voice first": ["sound:clean-voice-first"],
  WorldCast: ["oss-worldcast", "worldcast:film"],
  "Exact orbit": ["fly-around:exact-orbit", "oss-uni3c-path"],
  "Kandinsky 6.0 open, Pro": ["oss-kandinsky6:pro"],
  "Image to 3D Refine detail (Hi3D)": ["image-to-3d:hi3d-refine"],
  "Image to 3D final with TRELLIS.2": ["image-to-3d:trellis-final"],
  "Make the other sides (Idol views)": ["image-to-3d:idol-other-sides"],
  "Idol 3D clean": ["image-to-3d:idol-clean"],
  "Edit speech": ["audio:edit-speech"],
  "Restore & colourise": ["video-tools:restore"],
  "Remove a person": ["video-tools:remove-person"],
  "Cinema World mode": ["cinema:world", "oss-hy-nomas-world"],
  // The cloud models no live call has passed yet: each on its own key.
  "Audio Extend & remix": ["mureka-extend", "mureka-remix", "mureka-stems"],
  "MiniMax H3 Max family": [
    "minimax-h3-max-lipsync",
    "minimax-h3-max-relight",
    "minimax-h3-max-insert",
    "minimax-h3-max-look-pixel",
    "minimax-h3-max-look-hand-drawn",
    "minimax-h3-max-look-low-poly",
    "minimax-h3-max-look-retro-toon",
    "minimax-h3-max-look-vhs",
    "minimax-h3-max-turbo",
    "minimax-h3-max-turbo-refs",
    "minimax-h3-max-turbo-extend",
  ],
  "MiniMax H3 Lite and HighSpeed": ["minimax-h3-lite", "minimax-h3-highspeed"],
  "Vidu Q4": ["vidu-q4"],
  "Songs and music": ["mureka-song", "mureka-9", "mureka-9-5-instrumental", "mureka-9-instrumental", "minimax-music-3", "elevenlabs-music-2-5", "lyria-3-5"],
  "Voice cleaners": ["veed-clean-audio", "deepfilternet3"],
  "3D cloud": ["idol-3d", "meshy-7-retexture", "meshy-6-retexture", "tripo-p2"],
  "Kandinsky cloud": ["kandinsky-6", "kandinsky-vsr"],
  Bria: ["bria-green-screen", "bria-guided-cutout"],
};

/** Items of the sweep that are not a setup a visitor makes (they keep their own rules). */
const SKIPPED = [
  "AI helper buttons: the install's own language model; no GPU or key of a visitor runs them",
  "Starters and Canvas boards without a cover: a cover rule, not a setup",
  "Paid cloud models for guests: every paid model already runs on an account's own key (Add your key)",
  "Result hand-offs and owner menu links: they take their tool's label once that tool opens to accounts",
];

const engineOf = (id: string) => (getModel(id)?.engines && getModel(id)!.engines!.length > 1 ? ("cloud" as const) : undefined);

describe("own setup: what a visitor needs", () => {
  it("names a setup for every item of the sweep", () => {
    expect(SKIPPED.length).toBeGreaterThan(0);
    // An item whose GPU pass is recorded (gpu-tested.json) has dropped its label; it still has its setup in the table.
    for (const [item, ids] of Object.entries(INVENTORY)) for (const id of ids) expect(ownSetupOnly(id, engineOf(id)) ?? ownSetupItem(id), `${item}: ${id}`).not.toBeNull();
  });

  it("puts every cloud model no live call has passed yet on the visitor's own key, by its route's provider", () => {
    const untested = MODELS.filter((m) => m.routes.some((r) => isHostedUntested(m.id, r)));
    expect(untested.length).toBeGreaterThan(30);
    for (const m of untested) {
      const o = ownSetupOnly(m.id, "cloud");
      expect(o, m.id).not.toBeNull();
      expect(o!.need, m.id).toBe("key");
      const provider = (o as Extract<OwnSetup, { need: "key" }>).provider;
      expect(m.routes.some((r) => r.provider === provider && isHostedUntested(m.id, r)), m.id).toBe(true);
    }
    expect(ownSetupOnly("minimax-h3-lite")).toEqual({ need: "key", provider: "replicate" });
    expect(HOSTED_UNTESTED_ENDPOINTS.size).toBeGreaterThan(0);
  });

  it("leaves everything else as it is", () => {
    for (const id of ["oss-qwen-image-21", "nano-banana-pro", "oss-kandinsky6", "oss-h3-group-swap", "no-such-model"]) expect(ownSetupOnly(id), id).toBeNull();
    expect(ownSetupOnly("fuobe-animation")).toBeNull();
    expect(ownSetupOnly("fuobe-animation", "cloud")).toEqual({ need: "key", provider: "fal" });
  });

  it("knows every id its table holds by a real model where it names one", () => {
    for (const id of OWN_SETUP_IDS) if (!id.includes(":")) expect(getModel(id), id).toBeDefined();
  });
});

describe("own setup: the words", () => {
  const all: OwnSetup[] = [
    ...OWN_SETUP_IDS.map((id) => ownSetupOnly(id)).filter((o): o is OwnSetup => !!o),
    ...MODELS.map((m) => ownSetupOnly(m.id, "cloud")).filter((o): o is OwnSetup => !!o),
  ];

  it("say what to use, plainly, with no status words", () => {
    for (const o of all) {
      for (const text of [ownSetupLabel(o), ownSetupShort(o), ownSetupDetail(o)]) {
        expect(text, JSON.stringify(o)).not.toMatch(BANNED);
        expect(text.trim()).toBe(text);
      }
      expect(ownSetupLabel(o).length, ownSetupLabel(o)).toBeLessThanOrEqual(44);
      expect(ownSetupShort(o).length, ownSetupShort(o)).toBeLessThanOrEqual(18);
    }
  });

  it("read as the examples", () => {
    expect(ownSetupLabel({ need: "gpu", vramGb: 48 })).toBe("Runs on your own GPU · 48 GB");
    expect(ownSetupLabel({ need: "gpu", vramGb: 48, files: true })).toBe("Runs on your own GPU · 48 GB");
    expect(ownSetupLabel({ need: "gpu", files: true })).toBe("Set up on your computer");
    expect(ownSetupLabel({ need: "gpu", vramGb: 48, linux: true })).toBe("Runs on your own Linux GPU · 48 GB");
    expect(ownSetupLabel({ need: "gpu", vramGb: 48, orKey: "fal" })).toBe("Runs on your own GPU · 48 GB or fal.ai key");
    expect(ownSetupLabel({ need: "key", provider: "fal" })).toBe("Use your own fal.ai key");
    expect(ownSetupLabel({ need: "key", provider: "replicate" })).toBe("Use your own Replicate key");
    expect(ownSetupShort({ need: "gpu", vramGb: 48 })).toBe("Your GPU · 48 GB");
    expect(ownSetupShort({ need: "key", provider: "fal" })).toBe("Your fal.ai key");
    expect(ownSetupLabel(ownSetupOnly("oss-h3-regenerate")!)).toBe("Runs on your own GPU · 48 GB");
    expect(ownSetupLabel(ownSetupOnly("lyria-3-5")!)).toBe("Use your own fal.ai key");
  });
});

describe("own setup: a press", () => {
  const key: OwnSetup = { need: "key", provider: "fal" };
  const big: OwnSetup = { need: "gpu", vramGb: 48 };
  const either: OwnSetup = { need: "gpu", orKey: "fal" };
  const guest = { kind: "guest" as const };
  const bare = { kind: "account" as const, gpu: { connected: false }, keys: [] };
  const keyed = { kind: "account" as const, gpu: { connected: false }, keys: ["fal"] };
  const gpu = { kind: "account" as const, gpu: { connected: true }, keys: [] };

  it("asks a guest to sign up, whatever the item", () => {
    for (const o of [key, big, either, null]) expect(ownSetupStep(o, guest)).toEqual({ kind: "sign-up" });
  });

  it("runs for an account with the setup", () => {
    expect(ownSetupStep(key, keyed)).toEqual({ kind: "run" });
    expect(ownSetupStep(big, gpu)).toEqual({ kind: "run" });
    expect(ownSetupStep(either, keyed)).toEqual({ kind: "run" });
    expect(ownSetupStep(either, gpu)).toEqual({ kind: "run" });
    expect(ownSetupStep(null, bare)).toEqual({ kind: "run" });
  });

  it("gives an account without it the way to set it up, never a refusal", () => {
    expect(ownSetupStep(key, bare)).toEqual({ kind: "add-key", provider: "fal" });
    expect(ownSetupStep(key, gpu)).toEqual({ kind: "add-key", provider: "fal" });
    expect(ownSetupStep({ need: "key", provider: "replicate" }, keyed)).toEqual({ kind: "add-key", provider: "replicate" });
    expect(ownSetupStep(big, bare)).toEqual({ kind: "connect-gpu", gpuOnly: true });
    expect(ownSetupStep(big, keyed)).toEqual({ kind: "connect-gpu", gpuOnly: true });
    expect(ownSetupStep(either, bare)).toEqual({ kind: "connect-gpu", gpuOnly: false });
  });

  it("keeps the owner's runs as they are", () => {
    for (const o of [key, big, either, null]) {
      expect(ownSetupStep(o, null)).toEqual({ kind: "run" });
      expect(ownSetupStep(o, undefined)).toEqual({ kind: "run" });
    }
  });

  it("says Restore & colourise runs on the visitor's own GPU only: a key alone opens Connect your GPU, not a run", () => {
    // Its cloud engine carries the gated Restore IC-LoRA, which never goes with a visitor's key (an account's cloud run
    // answers 422): the label promises no key, and a key-only account's press leads to its GPU.
    const restore = ownSetupOnly("video-tools:restore")!;
    expect(restore).toEqual({ need: "gpu", vramGb: 24, files: true });
    expect(ownSetupLabel(restore)).toBe("Runs on your own GPU · 24 GB");
    expect(ownSetupShort(restore)).toBe("Your GPU · 24 GB");
    for (const text of [ownSetupLabel(restore), ownSetupShort(restore), ownSetupDetail(restore)]) expect(text).not.toMatch(/key|fal/i);
    expect(ownSetupStep(restore, keyed)).toEqual({ kind: "connect-gpu", gpuOnly: true });
    expect(ownSetupStep(restore, bare)).toEqual({ kind: "connect-gpu", gpuOnly: true });
    expect(ownSetupStep(restore, gpu)).toEqual({ kind: "run" });
    expect(ownSetupStep(restore, guest)).toEqual({ kind: "sign-up" });
  });
});
