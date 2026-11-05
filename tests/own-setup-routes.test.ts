import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { accountProjectRoute, ownGpuRun } from "@/lib/guest-access";
import { OWN_SETUP_IDS, ownSetupAction, ownSetupGraphs, ownSetupItem, ownSetupLabel, ownSetupOnly } from "@/lib/own-setup";
import { ownSetupOnlyNow, ownSetupsNow } from "@/server/own-setup-live";

/**
 * Every surface that shows a "runs with your own setup" label leads somewhere an account can run it: a label next to a
 * press that the proxy then refuses ("This tool isn't available here") would be a visible feature refused.
 */
const reachable = (pathname: string) => ownGpuRun("POST", pathname) || accountProjectRoute(pathname);

/** The route each labelled surface's press sends an account's run to. */
const ROUTES: Record<string, string> = {
  "video-tools:restore": "/api/restore",
  "regenerate:enhance": "/api/shorts/sessions/s1/segments/0/enhance",
  "regenerate:faceless": "/api/faceless/episodes/e1/regenerate",
  "regenerate:upscale": "/api/generations",
  "regenerate:h3-2k": "/api/generations",
  "regenerate:cinema-finish": "/api/cinema/projects/p1/items/i1/finish",
  "regenerate:swap-sharpen": "/api/swap-studio/projects/p1/sharpen",
  "oss-h3-regenerate": "/api/generations",
  "oss-kandinsky6:pro": "/api/generations",
  "fly-around:exact-orbit": "/api/fly-around",
  "oss-uni3c-path": "/api/fly-around",
  "audio:edit-speech": "/api/audio-tools",
  "video-tools:remove-person": "/api/remove-object",
  "video-tools:remove-object-void": "/api/remove-object",
  "image-to-3d:hi3d-refine": "/api/image-to-3d",
  "image-to-3d:trellis-final": "/api/image-to-3d",
  "image-to-3d:idol-other-sides": "/api/image-to-3d",
  "image-to-3d:idol-clean": "/api/image-to-3d",
  "cinema:world": "/api/cinema/projects/p1/generate",
  "oss-hy-nomas-world": "/api/cinema/projects/p1/generate",
  "sound:clean-voice-first": "/api/genjutsu/transcribe",
};

describe("a labelled item leads to a run an account can reach", () => {
  it("maps every static item with a press to an account's route", () => {
    for (const [id, route] of Object.entries(ROUTES)) {
      expect(ownSetupItem(id), id).not.toBeNull();
      expect(reachable(route), `${id} → ${route}`).toBe(true);
    }
    // Genjutsu's features and makers run through Genjutsu's own route.
    for (const id of OWN_SETUP_IDS.filter((x) => x.startsWith("genjutsu:"))) expect(reachable("/api/genjutsu"), id).toBe(true);
  });

  it("opens Shorts' Enhance and Faceless's Regenerate to 1080p to an account, nothing else on those paths", () => {
    expect(accountProjectRoute("/api/shorts/sessions/s1/segments/0/enhance")).toBe(true);
    expect(accountProjectRoute("/api/shorts/sessions/s1/segments/0/other")).toBe(false);
    expect(accountProjectRoute("/api/faceless/episodes/e1/regenerate")).toBe(true);
    expect(ownGpuRun("POST", "/api/restore")).toBe(true);
    // Writing the words from the frames uses the studio's AI helper: the owner's.
    expect(ownGpuRun("POST", "/api/restore/prompt")).toBe(false);
  });
});

describe("the label follows the GPU's validated graphs on the server", () => {
  const manifest = (validated: Record<string, boolean>) => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "own-setup-manifest-")), "manifest.json");
    fs.writeFileSync(f, JSON.stringify({ workflows: Object.entries(validated).map(([id, v]) => ({ id, validated: v })) }));
    return f;
  };

  it("drops an item whose graphs are all validated; keeps one that still waits", () => {
    const m = manifest({ "image-to-3d-trellis2": true, "speech-edit-auk": false });
    expect(ownSetupOnlyNow("image-to-3d:trellis-final", undefined, m)).toBeNull();
    expect(ownSetupOnly("image-to-3d:trellis-final")).not.toBeNull();
    expect(ownSetupOnlyNow("audio:edit-speech", undefined, m)).toEqual(ownSetupOnly("audio:edit-speech"));
    // Without graphs, the static answer: a 48 GB card stays a 48 GB card.
    expect(ownSetupOnlyNow("regenerate:upscale", undefined, m)).toEqual(ownSetupOnly("regenerate:upscale"));
  });

  it("keeps Remove a person and VOID marked though ComfyUI accepted their graphs: only a real render on this studio's GPU lifts them", () => {
    // The manifest's `validated` on these graphs is ComfyUI's check (queued with placeholder files, never run).
    const m = manifest({ "video-person-remove-h3-relay": true, "video-person-remove-h3-mask": true, "video-erase-void": true });
    const want = { "video-tools:remove-person": { need: "gpu", vramGb: 24 }, "video-tools:remove-object-void": { need: "gpu", vramGb: 40 } };
    for (const [id, setup] of Object.entries(want)) {
      expect(ownSetupGraphs(id), id).toEqual([]);
      expect(ownSetupOnly(id), id).toEqual(setup);
      expect(ownSetupOnlyNow(id, undefined, m), id).toEqual(setup);
    }
    expect(ownSetupsNow(Object.keys(want), m)).toEqual(want);
    // Their labels say what to use, and wait for a pass of their own in gpu-tested.json (own-setup-flags.test.ts).
    expect(ownSetupLabel(ownSetupOnly("video-tools:remove-object-void")!)).toBe("Runs on your own GPU · 40 GB");
    expect(ownSetupLabel(ownSetupOnly("video-tools:remove-person")!)).toBe("Runs on your own GPU · 24 GB");
  });
});

describe("the step's button", () => {
  it("says what it opens, in plain words", () => {
    expect(ownSetupAction({ kind: "sign-up" })).toBe("Create a free account");
    expect(ownSetupAction({ kind: "add-key", provider: "fal" })).toBe("Add your fal.ai key");
    expect(ownSetupAction({ kind: "connect-gpu", gpuOnly: true })).toBe("Connect your GPU");
    expect(ownSetupAction({ kind: "run" })).toBeNull();
  });
});

describe("visitors see every model and every setup step", () => {
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");

  it("lists the paid models for a guest too, marked with the key they need; choosing one offers a free account", () => {
    const picker = read("src/components/studio/model-picker.tsx");
    expect(picker).toContain('status?.viewer?.kind === "guest"');
    expect(picker).toContain('askToSignUp("run")');
    expect(picker).toContain('ownSetupLabel({ need: "key", provider: needs[0] })');
  });

  it("opens the setup card on a refused upload with progress, as a fetch does", () => {
    const up = read("src/lib/upload.ts");
    expect(up).toContain("GUEST_PROMPT_EVENT");
    expect(up).toContain("CONNECT_GPU_EVENT");
    expect(read("src/components/shorts/use-source-clip.ts")).toContain("refusalShown(e)");
  });

  it("never says a visible tool isn't available", () => {
    for (const f of [
      "src/components/restore/restore-tool.tsx",
      "src/components/model3d/retexture-dialog.tsx",
      "src/components/model3d/rig-dialog.tsx",
      "src/components/layers/projects-view.tsx",
      "src/components/elements-view.tsx",
      "src/lib/scene-props.ts",
    ]) {
      expect(read(f), f).not.toMatch(/isn(&apos;|')t available/);
    }
  });
});
