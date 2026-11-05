import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers/temp-dir";

/**
 * WorldCast behind the camera-path buttons (build plan N7-9): the steps of a run, the buttons preferring it when the
 * worker answers and saying what they film on when it doesn't, the ModelDef's visibility, and the server's case.
 */

const dir = tempDir("fuobe-worldcast-plan-");
process.env.FUOBE_DATA_DIR = dir;

const { getModel, MODELS } = await import("@/lib/catalog");
const { providerEngine } = await import("@/lib/catalog/engines");
const { planFlyAround } = await import("@/lib/catalog/fly-around");
const { planTurnaround } = await import("@/lib/catalog/turnaround");
const { pathTake, planCinema } = await import("@/lib/catalog/cinema");
const { WORLDCAST_MODELS, worldcastFallback, worldcastSteps } = await import("@/lib/catalog/worldcast-plan");
const { imageSlots, readLayout, worldcastLayout } = await import("@/lib/worldcast");
const { modelLicence } = await import("@/server/model-access");

const image = "/api/files/uploads/still.png";
const V = { front: "/api/files/uploads/front.png", right: "/api/files/uploads/right.png", back: "/api/files/uploads/back.png", left: "/api/files/uploads/left.png" };
const FALLBACK = "Runs on Uni3C: add a WorldCast worker (48 GB+) for sides that match your photos";

describe("a WorldCast run's steps", () => {
  it("measures the depth, masks the still and every view, then films with every picture in its slot", () => {
    const steps = worldcastSteps({ feature: "fly-around", still: { url: V.front }, anchors: [{ side: "back", src: { url: V.back } }, { side: "front", src: { url: V.front } }], keys: [{ t: 0, azimuth: 0, elevation: 0, distance: 1 }, { t: 1, azimuth: -360, elevation: 0, distance: 1 }] });
    expect(steps.map((s) => [s.key, s.request.modelId, s.request.op])).toEqual([
      ["depth", "oss-scene-moge", "scene-3d"],
      ["mask-still", "oss-person-mask", "bg-remove"],
      ["mask-front", "oss-person-mask", "bg-remove"],
      ["mask-back", "oss-person-mask", "bg-remove"],
      ["main", "oss-worldcast", "camera-path"],
    ]);
    const main = steps.at(-1)!;
    const layout = readLayout(main.request.params?.extra?.worldcast);
    expect(layout.anchors.map((a) => a.view)).toEqual(["front", "back"]);
    const slots = imageSlots(layout);
    // The files first, in slot order; the masks and the depth come from the steps, each at its place.
    expect(main.request.inputs?.images).toEqual([V.front, V.front, V.back]);
    expect(main.request.chain).toEqual([
      { slot: "images", at: slots.stillMask },
      { slot: "images", at: slots.anchorMask(0) },
      { slot: "images", at: slots.anchorMask(1) },
      { slot: "images", at: slots.depth },
    ]);
    expect(main.after).toEqual(["mask-still", "mask-front", "mask-back", "depth"]);
    expect(main.request.params).toMatchObject({ aspectRatio: "9:16", extra: { worldcast: worldcastLayout(["front", "back"]) } });
    expect(steps.map((s) => s.request.step?.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("takes the paper's depth model when asked, and a still an earlier step makes", () => {
    const steps = worldcastSteps({ feature: "t", still: { key: "front" }, anchors: [{ side: "front", src: { key: "front" } }], keys: [], depth: "depth-pro" });
    expect(steps[0]).toMatchObject({ key: "depth", request: { modelId: "oss-depth-pro", op: "edit", chain: [{ slot: "images" }] }, after: ["front"] });
    const main = steps.at(-1)!;
    expect(main.request.inputs).toBeUndefined();
    expect(main.after).toEqual(["front", "front", "mask-still", "mask-front", "depth"]);
  });
});

describe("the buttons prefer WorldCast when the worker answers", () => {
  const orbit = { degrees: 360, direction: "cw" as const, tilt: 0, pulse: 0 };
  it("Fly around / exact orbits: WorldCast with a worker, Uni3C and the line without one", () => {
    const on = planFlyAround({ engine: "open", image, orbit, sides: { back: V.back } }, { worldcast: true });
    expect(on.model.id).toBe("oss-worldcast");
    expect(on.duration).toBe(5.4);
    expect(on.costUsd).toBe(0);
    expect(on.blocker).toBeUndefined();
    // The still is the front's anchor too, so WorldCast always has the first frame's anchor it was trained with.
    expect(on.steps.map((s) => s.key)).toEqual(["depth", "mask-still", "mask-front", "mask-back", "main"]);
    expect(readLayout(on.steps.at(-1)!.request.params?.extra?.worldcast).anchors.map((a) => a.view)).toEqual(["front", "back"]);
    expect(on.steps.at(-1)!.request.inputs?.images).toEqual([image, image, V.back]);
    expect(on.notes[0]).toMatch(/the back and sides follow your 1 view/);
    // With no views named, the still alone is still sent as the front's anchor.
    const alone = planFlyAround({ engine: "open", image, orbit }, { worldcast: true });
    expect(readLayout(alone.steps.at(-1)!.request.params?.extra?.worldcast).anchors.map((a) => [a.side, a.view])).toEqual([["front", "front"]]);
    expect(on.notes.join(" ")).toMatch(/RIFE/);

    const off = planFlyAround({ engine: "open", image, orbit }, { worldcast: false });
    expect(off.model.id).toBe("oss-uni3c-path");
    expect(off.notes).toContain(FALLBACK);
    // Nothing said where nobody can add a worker (a visitor, or WorldCast switched off), nor on the cloud.
    expect(planFlyAround({ engine: "open", image, orbit }).notes).not.toContain(FALLBACK);
    expect(planFlyAround({ engine: "cloud", image, orbit }, { worldcast: true }).model.id).toBe("minimax-h3-max-camera");
  });

  it("Turnaround: WorldCast is the GPU's default with a worker, with the front as the first frame and every view an anchor", () => {
    const on = planTurnaround({ engine: "open", views: V }, { worldcast: true });
    expect(on.routes).toEqual(["worldcast", "frames", "stills"]);
    expect(on.route).toBe("worldcast");
    expect(on.model.id).toBe(WORLDCAST_MODELS.film);
    expect(on.fills).toEqual([]);
    const main = on.steps.at(-1)!;
    expect(main.key).toBe("main");
    expect(main.request.inputs?.images?.[0]).toBe(V.front);
    // The person's right side is WorldCast's left_side (where the camera stands).
    expect(readLayout(main.request.params?.extra?.worldcast).anchors.map((a) => [a.side, a.view])).toEqual([
      ["front", "front"],
      ["right", "left_side"],
      ["left", "right_side"],
      ["back", "back"],
    ]);
    expect(on.steps.map((s) => s.request.step?.index)).toEqual(on.steps.map((_, i) => i));

    const off = planTurnaround({ engine: "open", views: V }, { worldcast: false });
    expect(off.routes).toEqual(["frames", "stills"]);
    expect(off.route).toBe("frames");
    expect(off.notes).toContain(worldcastFallback("Frames"));
    expect(planTurnaround({ engine: "open", views: V }).notes).not.toContain(worldcastFallback("Frames"));
  });

  it("Cinema's Fly path: WorldCast needs no browser render; without a worker the Uni3C line is said", () => {
    const input = {
      engine: "open" as const,
      mode: "video" as const,
      action: "path" as const,
      prompt: "",
      settings: {},
      source: { url: image, kind: "image" as const },
      path: { keys: [{ t: 0, azimuth: 0, elevation: 0, distance: 1 }, { t: 1, azimuth: 90, elevation: 0, distance: 1 }], duration: 5 },
    };
    const on = planCinema(input, { worldcast: true });
    expect(on.model.id).toBe("oss-worldcast");
    expect(on.blocker).toBeUndefined();
    expect(on.steps.at(-1)?.request.feature).toBe("cinema-path");
    expect(readLayout(on.steps.at(-1)?.request.params?.extra?.worldcast).anchors.map((a) => a.view)).toEqual(["front"]);
    // The take remembers WorldCast's own length and the keys it filmed.
    expect(pathTake(input, on)).toEqual({ keys: on.steps.at(-1)?.request.params?.cameraPath, duration: 81 / 15 });
    const off = planCinema({ ...input, path: { ...input.path, render: "/api/files/uploads/r.webm" } }, { worldcast: false });
    expect(off.model.id).toBe("oss-uni3c-path");
    expect(off.notes).toContain(FALLBACK);
  });
});

describe("the WorldCast models", () => {
  it("are open-engine models kept out of the pickers, with their licences recorded as information", () => {
    for (const id of ["oss-worldcast", "oss-depth-pro", "oss-vggt-omega", "oss-person-mask"]) {
      const m = getModel(id)!;
      expect(m.engine).toBe("open");
      expect(m.hidden).toBe(true);
      expect(MODELS.some((x) => x.id === id)).toBe(true);
      for (const r of m.routes) expect(providerEngine(r.provider)).toBe("open");
    }
    expect(getModel("oss-worldcast")!.routes[0].provider).toBe("worldcast");
    const wc = modelLicence(getModel("oss-worldcast")!).licence;
    expect(wc.class).toBe("commercial");
    expect(wc.note).toMatch(/SpatialVID.*academic research/);
    expect(modelLicence(getModel("oss-depth-pro")!).licence.class).toBe("non-commercial");
    expect(modelLicence(getModel("oss-vggt-omega")!).licence.note).toMatch(/FAIR Noncommercial/);
    expect(modelLicence(getModel("oss-person-mask")!).licence.name).toMatch(/SAM/);
  });
});

describe("public sign-up", () => {
  it("never sends an account's run to the studio's worker, and says nothing about it to a visitor", async () => {
    const { accountRun, asVisitor } = await import("@/server/generations");
    const { runAsTenant } = await import("@/server/tenant");
    const { worldcastContext } = await import("@/server/worldcast-on");
    expect(accountRun("acct-1", "worldcast")).toMatchObject({ code: "own-gpu-tool" });
    expect(runAsTenant({ kind: "account", id: "acct-1" }, () => worldcastContext())).toBeUndefined();
    expect(asVisitor(null, () => worldcastContext())).toBeUndefined();
    // The owner, with no worker set: Fly path says what it films on.
    expect(worldcastContext()).toBe(false);
  });

  it("keeps the Uni3C / Frames run, saying nothing, when a step WorldCast needs is switched off", async () => {
    const { changeAccess } = await import("@/server/model-access");
    const { worldcastContext } = await import("@/server/worldcast-on");
    expect(worldcastContext()).toBe(false);
    try {
      for (const id of ["oss-person-mask", "oss-scene-moge", "oss-worldcast"]) {
        changeAccess([{ kind: "model", id, on: false }]);
        expect(worldcastContext()).toBeUndefined();
        changeAccess([{ kind: "reset" }]);
      }
    } finally {
      changeAccess([{ kind: "reset" }]);
    }
  });
});

const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe.skipIf(!ffmpeg)("the server's case", async () => {
  const sharp = (await import("sharp")).default;
  const { ANCHOR_MAX_SIDE, buildCase } = await import("@/server/worldcast-case");
  it("crops the still to 480 × 832, renders the path and its holes at 81 frames, and keeps each view whole", async () => {
    const still = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#2050a0" } }).png().toBuffer();
    const mask = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#000" } })
      .composite([{ input: await sharp({ create: { width: 60, height: 160, channels: 3, background: "#fff" } }).png().toBuffer(), left: 130, top: 40 }])
      .png()
      .toBuffer();
    const depth = await sharp({ create: { width: 160, height: 120, channels: 3, background: "#808080" } }).png().toBuffer();
    const view = await sharp({ create: { width: 200, height: 300, channels: 3, background: "#a03020" } }).png().toBuffer();
    const layout = worldcastLayout(["back"]);
    const keys = [{ t: 0, azimuth: 0, elevation: 0, distance: 1 }, { t: 1, azimuth: -90, elevation: 0, distance: 1 }];
    const { parts } = await buildCase({ layout, images: [still, view, mask, mask, depth], keys, prompt: "", seed: 5 });
    const file = (n: string) => (parts.find((p) => p.name === n) as { data: Uint8Array }).data;
    expect(await sharp(file("first_frame.png")).metadata()).toMatchObject({ width: 480, height: 832 });
    const m = await sharp(file("person_mask.png")).raw().toBuffer({ resolveWithObject: true });
    expect(new Set(m.data)).toEqual(new Set([0, 255]));
    expect(await sharp(file("anchor_back.png")).metadata()).toMatchObject({ width: 200, height: 300 });
    const cam = JSON.parse(new TextDecoder().decode(file("cam_info.json")));
    expect(cam.extrinsic).toHaveLength(81);
    for (const name of ["render.mp4", "render_mask.mp4"]) {
      const f = path.join(dir, name);
      fs.writeFileSync(f, file(name));
      const probe = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_read_frames,r_frame_rate", "-of", "csv=p=0", f], { encoding: "utf8" });
      expect(probe.stdout.trim()).toBe("480,832,15/1,81");
    }
  }, 60_000);

  it("brings a big view down to the demo's scale before the worker crops it, with its mask the same size", async () => {
    const still = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#2050a0" } }).png().toBuffer();
    const mask = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#fff" } }).png().toBuffer();
    const depth = await sharp({ create: { width: 160, height: 120, channels: 3, background: "#808080" } }).png().toBuffer();
    const view = await sharp({ create: { width: 2000, height: 3000, channels: 3, background: "#a03020" } }).png().toBuffer();
    const viewMask = await sharp({ create: { width: 500, height: 750, channels: 3, background: "#fff" } }).png().toBuffer();
    const layout = worldcastLayout(["back"]);
    const keys = [{ t: 0, azimuth: 0, elevation: 0, distance: 1 }, { t: 1, azimuth: -90, elevation: 0, distance: 1 }];
    const { parts } = await buildCase({ layout, images: [still, view, mask, viewMask, depth], keys });
    const file = (n: string) => (parts.find((p) => p.name === n) as { data: Uint8Array }).data;
    expect(ANCHOR_MAX_SIDE).toBe(1344);
    expect(await sharp(file("anchor_back.png")).metadata()).toMatchObject({ width: 896, height: 1344 });
    expect(await sharp(file("anchor_back_mask.png")).metadata()).toMatchObject({ width: 896, height: 1344 });
  }, 60_000);
});
