import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_MOTION, presetKeys } from "@/lib/camera-path";
import { getModel } from "@/lib/catalog";
import { estimateCost } from "@/lib/catalog/plan";
import { buildPayload } from "@/lib/catalog/payload";
import { ANGLES_2511_LORA } from "@/lib/catalog/open-tools";
import {
  NEEDS_FRONT,
  NEEDS_SECOND_VIEW,
  ORBIT_PROMPT,
  TURN_FRAMES,
  TURN_SIDES,
  WORLDCAST,
  anglesHorizontal,
  cameraWords,
  elementPictures,
  pathAzimuth,
  planTurnaround,
  referencesPrompt,
  sheetPictures,
  startingViews,
  viewAzimuth,
  worldcastAnchor,
  type TurnSide,
} from "@/lib/catalog/turnaround";
import type { Generation, GenInput } from "@/lib/catalog/types";

// Prices at list rates: after FLUX 3 Max's launch price (2026-11-07) and H3 Max camera controls' (2026-10-31).
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
});
afterAll(() => vi.useRealTimers());

const V = { front: "/api/files/front.png", right: "/api/files/right.png", back: "/api/files/back.png", left: "/api/files/left.png" };
const SHEET = "/api/files/sheet.png";
const views = (...sides: TurnSide[]) => Object.fromEntries(sides.map((s) => [s, V[s]]));

describe("views", () => {
  it("puts the sides round the person, their own left and right, front → right → back → left → front", () => {
    expect(TURN_SIDES.map(viewAzimuth)).toEqual([0, 90, 180, 270]);
    expect(TURN_FRAMES).toEqual([
      { side: "front", t: 0 },
      { side: "right", t: 0.25 },
      { side: "back", t: 0.5 },
      { side: "left", t: 0.75 },
      { side: "front", t: 1 },
    ]);
  });

  it("is a clockwise orbit in the camera-path library's terms (+ = round to the viewer's right)", () => {
    // Seeing someone's right side means walking round to your left: N7-5's orbit_360_cw passes it at a quarter of the way.
    const keys = presetKeys("orbit_360_cw")!;
    expect(keys.map((k) => [k.t, k.azimuth])).toEqual(TURN_FRAMES.map((f) => [f.t, f.t === 1 ? -360 : pathAzimuth(f.side)]));
  });

  it("names WorldCast's anchors by where the camera stands: the person's right side is its left_side, left_sign −1", () => {
    for (const s of TURN_SIDES) {
      const a = worldcastAnchor(s);
      expect(a.name).toBe(WORLDCAST.anchor[s]);
      // Each demo anchor sits within 10° of the side's angle here.
      expect(Math.abs(WORLDCAST.demoAzimuth[a.name] - a.azimuth)).toBeLessThan(10);
    }
    expect(worldcastAnchor("right")).toEqual({ name: "left_side", azimuth: 270, signed: -90 });
    expect(worldcastAnchor("left")).toEqual({ name: "right_side", azimuth: 90, signed: 90 });
    expect(worldcastAnchor("back")).toEqual({ name: "back", azimuth: 180, signed: 180 });
    expect(worldcastAnchor("front")).toEqual({ name: "front", azimuth: 0, signed: 0 });
    expect(WORLDCAST.leftSign).toBe(-1);
  });

  it("asks the Angles app for the missing sides at 90°, 180° and 270°", () => {
    expect((["right", "back", "left"] as const).map(anglesHorizontal)).toEqual([90, 180, 270]);
  });
});

describe("the pictures a sheet or a character offers", () => {
  const gen = (outputs: Generation["outputs"], images?: string[]) => ({ outputs, request: { feature: "character-sheet", modelId: "m", ...(images && { inputs: { images } }) } });

  it("takes the Soul Cast sheet graph's front and back, and leaves the three-quarter and profile for the user to place", () => {
    const pics = sheetPictures(
      gen([
        { url: "/s.png", kind: "image", meta: { role: "sheet" } },
        ...["/f.png", "/q.png", "/p.png", "/b.png"].map((url) => ({ url, kind: "image" as const, meta: { role: "tiles" } })),
      ]),
    );
    expect(pics).toEqual([
      { url: "/s.png", label: "Sheet", sheet: true },
      { url: "/f.png", label: "Front", side: "front" },
      { url: "/q.png", label: "Three-quarter" },
      { url: "/p.png", label: "Profile" },
      { url: "/b.png", label: "Back", side: "back" },
    ]);
    expect(startingViews(pics)).toEqual({ views: { front: "/f.png", back: "/b.png" }, sheet: "/s.png" });
  });

  it("reads a one-picture sheet as the sheet, and its first source photo as the front", () => {
    expect(startingViews(sheetPictures(gen([{ url: "/s.png", kind: "image" }])))).toEqual({ views: {}, sheet: "/s.png" });
    const pics = sheetPictures(gen([{ url: "/s.png", kind: "image" }], ["/api/files/me.jpg", "/api/files/me2.jpg"]));
    expect(pics.slice(1)).toEqual([
      { url: "/api/files/me.jpg", label: "Photo 1", side: "front" },
      { url: "/api/files/me2.jpg", label: "Photo 2" },
    ]);
  });

  it("offers every variant of a cloud batch as a sheet, the picked one first (by its url or the one it was finished from)", () => {
    // Fuobe Soul makes a Soul Cast batch as one generation with a sheet per variant (the open engine makes one job each).
    const batch = gen([
      { url: "/v1.png", kind: "image" },
      { url: "/v2.png", kind: "image", meta: { original: "/v2-raw.png" } },
      { url: "/v3.png", kind: "image" },
    ]);
    const pics = sheetPictures(batch, "/v2.png");
    expect(pics).toEqual([
      { url: "/v2.png", label: "Sheet 2", sheet: true },
      { url: "/v1.png", label: "Sheet 1", sheet: true },
      { url: "/v3.png", label: "Sheet 3", sheet: true },
    ]);
    expect(startingViews(pics).sheet).toBe("/v2.png");
    expect(startingViews(sheetPictures(batch, "/v2-raw.png")).sheet).toBe("/v2.png");
    // Nothing picked: the first variant.
    expect(startingViews(sheetPictures(batch)).sheet).toBe("/v1.png");
  });

  it("takes a character's wide picture as its sheet and the first other one as its front", () => {
    const pics = elementPictures([
      { url: "/a.png", width: 2048, height: 1152 },
      { url: "/b.png", width: 768, height: 1024 },
      { url: "/c.png", width: 1024, height: 1024 },
    ]);
    expect(pics.map((p) => [p.url, p.side, p.sheet])).toEqual([
      ["/a.png", undefined, true],
      ["/b.png", "front", undefined],
      ["/c.png", undefined, undefined],
    ]);
  });
});

describe("the open engine: Frames mode's chain", () => {
  it("films all four sides as keyframes at 0, ¼, ½, ¾ and the end, with the orbit words, free", () => {
    const plan = planTurnaround({ engine: "open", views: views("front", "right", "back", "left"), name: "Maya" });
    expect(plan).toMatchObject({ route: "frames", routes: ["frames", "stills"], fills: [], duration: 8, costUsd: 0 });
    expect(plan.blocker).toBeUndefined();
    expect(plan.steps).toHaveLength(1);
    const { request } = plan.steps[0];
    expect(request).toMatchObject({
      feature: "turnaround",
      modelId: "oss-wan22-14b",
      op: "keyframes",
      prompt: ORBIT_PROMPT,
      title: "Turnaround · Maya",
      inputs: { images: [V.front, V.right, V.back, V.left, V.front] },
      params: { duration: 8, keyframeTimes: [0, 2, 4, 6, 8], aspectRatio: "9:16", resolution: "480p" },
    });
    expect(request.chain).toBeUndefined();
  });

  it("draws the missing sides from the front with the Angles app's open route, and places them in the film", () => {
    const plan = planTurnaround({ engine: "open", views: views("front", "back") });
    expect(plan.fills).toEqual(["right", "left"]);
    expect(plan.steps.map((s) => s.key)).toEqual(["fill-right", "fill-left", "main"]);
    const right = plan.steps[0].request;
    expect(right).toMatchObject({ modelId: "oss-qwen-edit", op: "edit", inputs: { images: [V.front] }, loras: [ANGLES_2511_LORA] });
    expect(right.prompt).toMatch(/^<sks> right side view eye-level shot medium shot\. Keep the same person/);
    expect(plan.steps[1].request.prompt).toMatch(/^<sks> left side view /);
    expect(right.step).toEqual({ label: "Right side (Angles)", index: 0, of: 3 });
    const main = plan.steps[2];
    expect(main.request.inputs?.images).toEqual([V.front, V.back, V.front]);
    expect(main.request.chain).toEqual([
      { slot: "images", at: 1 },
      { slot: "images", at: 3 },
    ]);
    expect(main.after).toEqual(["fill-right", "fill-left"]);
    expect(plan.frames.map((f) => [f.side, f.from])).toEqual([
      ["front", "picture"],
      ["right", "angles"],
      ["back", "picture"],
      ["left", "angles"],
      ["front", "picture"],
    ]);
    expect(plan.costUsd).toBe(0);
  });

  it("without fills, films the sides it has, and says when a gap is too long for Wan 2.2's clips", () => {
    const two = planTurnaround({ engine: "open", views: views("front", "back"), fill: false });
    expect(two.steps).toHaveLength(1);
    expect(two.steps[0].request.inputs?.images).toEqual([V.front, V.back, V.front]);
    expect(two.steps[0].request.params?.keyframeTimes).toEqual([0, 4, 8]);
    expect(planTurnaround({ engine: "open", views: views("front", "back"), fill: false, duration: 20 }).blocker).toMatch(/up to 7 s from one view to the next — make the turnaround shorter or let Fuobe draw the missing sides/);
    expect(planTurnaround({ engine: "open", views: views("front"), fill: false }).blocker).toBe(NEEDS_SECOND_VIEW);
    expect(planTurnaround({ engine: "open", views: views("back") }).blocker).toBe(NEEDS_FRONT);
  });

  it("draws a front view from a sheet first, then the sides from it, then films them all", () => {
    const plan = planTurnaround({ engine: "open", sheet: SHEET });
    expect(plan.frontFromSheet).toBe(true);
    expect(plan.steps.map((s) => [s.key, s.after])).toEqual([
      ["front", undefined],
      ["fill-right", ["front"]],
      ["fill-back", ["front"]],
      ["fill-left", ["front"]],
      ["main", ["front", "fill-right", "fill-back", "fill-left", "front"]],
    ]);
    expect(plan.steps[0].request).toMatchObject({ modelId: "oss-qwen-image-21", op: "edit", inputs: { images: [SHEET] } });
    expect(plan.steps[1].request.chain).toEqual([{ slot: "images" }]);
    const main = plan.steps[4].request;
    expect(main.inputs).toBeUndefined();
    expect(main.chain?.map((c) => c.at)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("the camera route's words", () => {
  it("uses the orbit words only for a level full ring, and N7-5's neutral words for any other move", () => {
    const words = (path?: string, prompt?: string) => planTurnaround({ engine: "cloud", views: views("front"), ...(path && { path }), ...(prompt && { prompt }) }).steps[0].request.prompt;
    expect(words()).toBe(ORBIT_PROMPT);
    expect(words("orbit_360_cw")).toBe(ORBIT_PROMPT);
    for (const path of ["zoom_in", "zoom_out", "orbit_90_cw", "orbit_90_ccw", "orbit_180_push", "orbit_tilt_20"]) expect(words(path), path).toBe(DEFAULT_MOTION);
    expect(cameraWords("zoom_in", "slow")).toBe(`${DEFAULT_MOTION}. slow`);
    expect(cameraWords("orbit_360")).toBe(ORBIT_PROMPT);
  });
});

describe("the cloud", () => {
  it("takes the camera path from a single front view, an exact clockwise orbit by default: $0.40 for 5 s at 768P", () => {
    const plan = planTurnaround({ engine: "cloud", views: views("front") });
    expect(plan).toMatchObject({ route: "camera", routes: ["references", "keyframes", "camera"], fills: [], costUsd: 0.4 });
    expect(plan.steps[0].request).toMatchObject({
      modelId: "minimax-h3-max-camera",
      op: "camera-path",
      inputs: { images: [V.front] },
      params: { duration: 5, resolution: "768P", cameraPath: presetKeys("orbit_360_cw") },
    });
    expect(planTurnaround({ engine: "cloud", views: views("front"), path: "orbit_180_push" }).steps[0].request.params?.cameraPath).toEqual(presetKeys("orbit_180_push"));
  });

  it("takes two or more views or a sheet as references on H3 Max: Image N named by side, $0.40 for 5 s at 768P", () => {
    const plan = planTurnaround({ engine: "cloud", views: views("front", "right", "back", "left") });
    expect(plan).toMatchObject({ route: "references", fills: [], costUsd: 0.4 });
    const r = plan.steps[0].request;
    expect(r).toMatchObject({ modelId: "minimax-h3-max", op: "ref2v", inputs: { images: [V.front, V.right, V.back, V.left] }, params: { duration: 5, resolution: "768P", aspectRatio: "9:16" } });
    expect(r.prompt).toMatch(/^Image 1 is the person's front view, Image 2 is their right side, Image 3 is their back, Image 4 is their left side\. The camera orbits 360 degrees/);
    // It starts and ends on the front: the front is also the last frame.
    expect(r.inputs?.endImage).toBe(V.front);
    // With a sheet: no sides drawn (the sheet shows them), and it is the last reference.
    const sheet = planTurnaround({ engine: "cloud", views: views("front", "back"), sheet: SHEET });
    expect(sheet.fills).toEqual([]);
    expect(sheet.steps[0].request.inputs?.images).toEqual([V.front, V.back, SHEET]);
    expect(sheet.steps[0].request.prompt).toMatch(/Image 3 is a turnaround sheet of the same person/);
  });

  it("ends on a front drawn from the sheet when no picture shows the front", () => {
    const plan = planTurnaround({ engine: "cloud", sheet: SHEET });
    expect(plan.route).toBe("references");
    const main = plan.steps.at(-1)!;
    expect(main.request.chain).toEqual([{ slot: "images", at: 0 }, { slot: "endImage" }]);
    expect(main.after).toEqual(["front", "front"]);
    expect(main.request.inputs).toEqual({ images: [SHEET] });
  });

  it("draws missing sides with Qwen Multiple Angles ($0.035 each) and places them among the references", () => {
    const plan = planTurnaround({ engine: "cloud", views: views("front", "back"), fill: true });
    expect(plan.steps.map((s) => s.key)).toEqual(["fill-right", "fill-left", "main"]);
    expect(plan.steps[0].request).toMatchObject({ modelId: "qwen-multiple-angles", op: "edit", inputs: { images: [V.front] }, params: { extra: { horizontal_angle: 90, vertical_angle: 0, zoom: 5 } } });
    expect(plan.steps[1].request.params?.extra).toMatchObject({ horizontal_angle: 270 });
    expect(plan.steps[2].request.chain).toEqual([
      { slot: "images", at: 1 },
      { slot: "images", at: 3 },
    ]);
    expect(plan.costUsd).toBe(0.47);
  });

  it("films the views as FLUX 3 Max keyframes at their quarters, silent: $0.17/s at 720p", () => {
    const plan = planTurnaround({ engine: "cloud", views: views("front", "right", "back", "left"), route: "keyframes" });
    expect(plan.steps[0].request).toMatchObject({
      modelId: "flux-3-max",
      op: "keyframes",
      inputs: { images: [V.front, V.right, V.back, V.left, V.front] },
      params: { duration: 8, keyframeTimes: [0, 2, 4, 6, 8], resolution: "720p", generateAudio: false },
    });
    expect(plan.costUsd).toBe(1.36);
    // With a front alone and the sides drawn: 3 drawn pictures, then the film.
    expect(planTurnaround({ engine: "cloud", views: views("front"), route: "keyframes" }).costUsd).toBe(1.465);
  });

  it("prices 1 to 5 pictures, with and without the sides drawn", () => {
    const cases: [TurnSide[], boolean, boolean, string, number][] = [
      [["front"], false, true, "camera", 0.4],
      [["front", "back"], false, true, "references", 0.47],
      [["front", "back"], false, false, "references", 0.4],
      [["front", "right", "back"], false, true, "references", 0.435],
      [["front", "right", "back", "left"], false, true, "references", 0.4],
      [["front", "right", "back", "left"], true, true, "references", 0.4],
    ];
    for (const [sides, withSheet, fill, route, cost] of cases) {
      const plan = planTurnaround({ engine: "cloud", views: views(...sides), ...(withSheet && { sheet: SHEET }), fill });
      expect([plan.route, plan.costUsd], `${sides.join("+")}${withSheet ? "+sheet" : ""} fill ${fill}`).toEqual([route, cost]);
      expect(plan.steps.at(-1)!.request.inputs?.images?.length ?? 0).toBeLessThanOrEqual(9);
    }
  });

  it("prices H3 Max per second by resolution, 2K (extend's alone) at $0.32", () => {
    const h3 = getModel("minimax-h3-max")!;
    const at = (resolution: string, op: "ref2v" | "extend") => estimateCost(h3, { duration: 5, resolution }, 1, op);
    expect([at("480P", "ref2v"), at("768P", "ref2v"), at("1080P", "ref2v"), at("2K", "extend")]).toEqual([0.25, 0.4, 0.8, 1.6]);
  });

  it("picks another route when a model is switched off in Settings → Models & licences", () => {
    const plan = planTurnaround({ engine: "cloud", views: views("front", "right", "back", "left") }, { has: (id) => id !== "minimax-h3-max" });
    expect(plan.routes).toEqual(["keyframes", "camera"]);
    expect(plan.route).toBe("keyframes");
  });
});

describe("the reference-to-video payload", () => {
  it("sends the views as reference_image_urls (H3 Max takes up to 9, 12 files in all), the front as the first frame, and names each Image N", () => {
    const plan = planTurnaround({ engine: "cloud", views: views("front", "right", "back", "left"), sheet: SHEET });
    const r = plan.steps[0].request;
    const route = getModel("minimax-h3-max")!.routes.find((x) => x.op === "ref2v")!;
    const body = buildPayload(route.map!, { prompt: r.prompt, images: r.inputs?.images, endImage: r.inputs?.endImage, ...(r.params as GenInput) });
    expect(body).toMatchObject({
      reference_image_urls: [V.front, V.right, V.back, V.left, SHEET],
      image_url: V.front,
      end_image_url: V.front,
      duration: 5,
      resolution: "768P",
      aspect_ratio: "9:16",
    });
    expect((body.reference_image_urls as string[]).length).toBeLessThanOrEqual(9);
    for (const [n, words] of [
      [1, "the person's front view"],
      [2, "their right side"],
      [3, "their back"],
      [4, "their left side"],
      [5, "a turnaround sheet"],
    ] as const)
      expect(body.prompt).toContain(`Image ${n} is ${words}`);
  });

  it("words a single picture as a turn all the way round", () => {
    expect(referencesPrompt(["front"])).toBe(
      "Image 1 is the person's front view. The camera orbits 360 degrees around the person at a constant height, all the way round them; the person stands naturally and looks the same from every side as in the images",
    );
    expect(referencesPrompt(["front"], "golden hour")).toMatch(/as in the images\. golden hour$/);
  });
});
