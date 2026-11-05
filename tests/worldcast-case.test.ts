import { describe, expect, it } from "vitest";
import { framePoses, presetKeys } from "@/lib/camera-path";
import { WORLDCAST_RUN, WORLDCAST_VIEWS, alignedAnchors, anchorsField, anchorsMeta, camInfo, caseParts, caseProblem, imageSlots, invertRigid, readLayout, worldcastCrop, worldcastFov, worldcastLayout } from "@/lib/worldcast";

const path = framePoses(presetKeys("orbit_360_cw")!, WORLDCAST_RUN.frames, 2, 40, { width: WORLDCAST_RUN.width, height: WORLDCAST_RUN.height });
const bytes = (n = 4) => new Uint8Array(n).fill(1);
const mul = (a: number[][], b: number[][]) => a.map((row) => b[0].map((_, j) => row.reduce((s, v, k) => s + v * b[k][j], 0)));

describe("a WorldCast case", () => {
  it("names the person's sides by where the camera stands, in WorldCast's order", () => {
    const l = worldcastLayout(["right", "front", "left", "back", "right"]);
    expect(l.anchors.map((a) => a.view)).toEqual(WORLDCAST_VIEWS);
    expect(l.anchors.map((a) => [a.side, a.azimuth])).toEqual([
      ["front", 0],
      ["right", 270],
      ["left", 90],
      ["back", 180],
    ]);
    expect(readLayout({ anchors: [{ side: "back" }, { side: "nope" }, { side: "back" }] }).anchors).toEqual([{ side: "back", view: "back", azimuth: 180 }]);
    expect(readLayout(null).anchors).toEqual([]);
  });

  it("keeps the pictures in fixed places: still, anchors, masks, then the depth", () => {
    const s = imageSlots(worldcastLayout(["front", "back"]));
    expect([s.still, s.anchor(0), s.anchor(1), s.stillMask, s.anchorMask(0), s.anchorMask(1), s.depth, s.total]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("crops to the model's portrait 480 × 832 at the centre, and narrows the field of view with it", () => {
    expect(worldcastCrop(1920, 1080)).toEqual({ left: 648, top: 0, width: 623, height: 1080 });
    expect(worldcastCrop(480, 1000)).toEqual({ left: 0, top: 84, width: 480, height: 832 });
    expect(worldcastFov(60, 1080 / 1920)).toBe(60);
    expect(worldcastFov(60, 16 / 9)).toBeLessThan(25);
  });

  it("writes cam_info.json as 81 camera-to-world poses in OpenCV axes with the frame's pixel intrinsic", () => {
    const c = camInfo(path);
    expect(c.num_frames).toBe(81);
    expect([c.width, c.height]).toEqual([480, 832]);
    expect(c.extrinsic[0]).toEqual([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ]);
    // A quarter of a clockwise orbit: the camera has gone round to its left (−x) and looks back at the subject (+x).
    const q = c.extrinsic[20];
    expect(q[0][3]).toBeLessThan(-1.5);
    expect(q[0][2]).toBeGreaterThan(0.9);
    expect(c.intrinsic[0][2]).toBe(240);
    expect(c.intrinsic[1][2]).toBe(416);
    expect(caseProblem({ anchors: [] }, path, { firstFrame: bytes(), personMask: bytes(), render: bytes(), renderMask: bytes(), anchors: [] })).toBeNull();
  });

  it("puts each anchor camera on a ring at the subject's distance, world-to-camera, the first frame's included", () => {
    const l = worldcastLayout(["front", "right", "back", "left"]);
    const a = alignedAnchors(l, path, 2);
    expect(a.views).toEqual(["first_frame", "front", "left_side", "right_side", "back"]);
    const centre = (w2c: number[][]) => invertRigid(w2c).slice(0, 3).map((r) => r[3]);
    expect(centre(a.extrinsic[0])).toEqual([0, 0, 0]);
    // left_side (the person's right side) stands at −x, right_side at +x, the back beyond the subject: as the demo case's.
    expect(centre(a.extrinsic[2])[0]).toBeCloseTo(-2, 5);
    expect(centre(a.extrinsic[3])[0]).toBeCloseTo(2, 5);
    expect(centre(a.extrinsic[4])[2]).toBeCloseTo(4, 5);
    // Each is the inverse of a rigid pose.
    const id = mul(a.extrinsic[3], invertRigid(a.extrinsic[3]));
    id.forEach((row, i) => row.forEach((v, j) => expect(v).toBeCloseTo(i === j ? 1 : 0, 5)));
    expect(anchorsMeta(l)).toMatchObject({ left_sign: -1, selected_views: ["front", "left_side", "right_side", "back"], per_view: { left_side: { azimuth_deg: 270 } } });
  });

  it("sends the files, the anchors and the run's fixed settings", () => {
    const l = worldcastLayout(["front", "back"]);
    const files = { firstFrame: bytes(), personMask: bytes(), render: bytes(), renderMask: bytes(), anchors: [{ image: bytes(), mask: bytes() }, { image: bytes(), mask: bytes() }] };
    const parts = caseParts(l, path, files, { prompt: "A walk", seed: 7, pivotDepth: 2 });
    const names = parts.map((p) => p.name);
    expect(names).toEqual([
      "first_frame.png",
      "person_mask.png",
      "render.mp4",
      "render_mask.mp4",
      "cam_info.json",
      "anchors",
      "anchor_front.png",
      "anchor_front_mask.png",
      "anchor_back.png",
      "anchor_back_mask.png",
      "anchors_aligned_camera_info.json",
      "prompt",
      "seed",
      "steps",
      "cfg",
      "shift",
      "height",
      "width",
    ]);
    const value = (n: string) => (parts.find((p) => p.name === n) as { value: string }).value;
    expect([value("steps"), value("cfg"), value("shift"), value("height"), value("width"), value("seed")]).toEqual(["50", "5", "2", "832", "480", "7"]);
    expect(JSON.parse(value("anchors"))).toEqual(anchorsField(l));
    expect(caseParts(l, path, files, { prompt: "", seed: 1, pivotDepth: 2, noAlignedCameras: true }).some((p) => p.name === "anchors_aligned_camera_info.json")).toBe(false);
  });

  it("refuses a case the model can't take", () => {
    const files = { firstFrame: bytes(), personMask: bytes(), render: bytes(), renderMask: bytes(), anchors: [] };
    const short = { ...path, poses: path.poses.slice(0, 49) };
    expect(caseProblem({ anchors: [] }, short, files)).toMatch(/81 camera poses/);
    const wide = framePoses(presetKeys("orbit_360")!, 81, 2, 40, { width: 832, height: 480 });
    expect(caseProblem({ anchors: [] }, wide, files)).toMatch(/480 × 832/);
    const bent = { ...path, poses: path.poses.map((m, i) => (i === 3 ? m.map((r, j) => (j === 0 ? [2, r[1], r[2], r[3]] : r)) : m)) };
    expect(caseProblem({ anchors: [] }, bent, files)).toMatch(/rotation/);
    expect(caseProblem(worldcastLayout(["front"]), path, files)).toMatch(/picture and its mask/);
    expect(() => caseParts({ anchors: [] }, short, files, { prompt: "", seed: 0, pivotDepth: 1 })).toThrow();
  });
});
