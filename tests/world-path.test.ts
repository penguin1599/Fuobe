import { describe, expect, it } from "vitest";
import { PATH_PRESETS } from "@/lib/camera-path";
import {
  PortPose,
  STILL_MOVE,
  WORLD_FPS,
  WORLD_SCALES,
  flyTicks,
  matMul,
  moveKeys,
  parseScript,
  pathSketch,
  rigidInverse,
  steerTicks,
  ticksScript,
  turnFrames,
  turnPoses,
  worldIntrinsic,
  worldScripts,
  worldTrajectory,
} from "@/lib/world-path";

// World mode (nm10-hy-nomas-world): Fuobe's camera paths as Hy-Nomas reads a camera — Tencent's trajectory form
// (OpenCV camera-to-world + normalised intrinsics at 24 fps) and the ComfyUI port's key script.

const det3 = (m: number[][]) =>
  m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
const close = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;

describe("the trajectory (Tencent's c2ws + intrinsics)", () => {
  it("makes one pose per frame at 24 fps plus the start, frame 0 the identity", () => {
    const t = worldTrajectory([{ move: "orbit_90_ccw", seconds: 5 }]);
    expect(t.fps).toBe(WORLD_FPS);
    expect(t.c2ws).toHaveLength(5 * 24 + 1);
    expect(t.intrinsics).toHaveLength(t.c2ws.length);
    expect(t.c2ws[0]).toEqual([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ]);
    expect(turnFrames(3)).toBe(72);
    expect(turnFrames(12)).toBe(288);
  });

  it("keeps the release's default gains", () => {
    const t = worldTrajectory([{ move: "zoom_in", seconds: 3 }]);
    expect(t.translationScale).toBe(1);
    expect(t.rotationScale).toBe(2.5);
    expect(WORLD_SCALES).toEqual({ translation: 1, rotation: 2.5 });
  });

  it("writes rigid camera-to-world matrices in OpenCV axes (x right, y down, z forward)", () => {
    for (const p of PATH_PRESETS) {
      for (const m of worldTrajectory([{ move: p.id, seconds: 4 }]).c2ws) {
        const r = m.slice(0, 3).map((row) => row.slice(0, 3));
        expect(close(det3(r), 1, 1e-4), p.id).toBe(true);
        expect(m[3]).toEqual([0, 0, 0, 1]);
      }
    }
    // A dolly in moves along +z (the camera's forward) and keeps looking down +z.
    const dolly = worldTrajectory([{ move: "zoom_in", seconds: 3 }]).c2ws;
    const end = dolly.at(-1)!;
    expect(end[2][3]).toBeGreaterThan(0.3);
    expect(close(end[0][3], 0) && close(end[1][3], 0)).toBe(true);
    expect(close(end[2][2], 1)).toBe(true);
    // Truck right slides along +x without turning.
    const truck = worldTrajectory([{ move: "truck_right", seconds: 3 }]).c2ws.at(-1)!;
    expect(truck[0][3]).toBeGreaterThan(0.3);
    expect(close(truck[0][0], 1)).toBe(true);
    // An arc to the right swings the camera to +x and turns it back towards the subject (−x).
    const arc = worldTrajectory([{ move: "orbit_90_ccw", seconds: 3 }]).c2ws.at(-1)!;
    expect(arc[0][3]).toBeGreaterThan(0.5);
    expect(arc[0][2]).toBeLessThan(-0.9);
  });

  it("has normalised intrinsics: fx = f / width, fy = f / height, principal point at the centre", () => {
    const k = worldIntrinsic(55);
    expect(k[0][2]).toBe(0.5);
    expect(k[1][2]).toBe(0.5);
    expect(close(k[0][0], 0.5 / Math.tan((27.5 * Math.PI) / 180))).toBe(true);
    expect(close(k[1][1] / k[0][0], 1280 / 704)).toBe(true);
    expect(k[2]).toEqual([0, 0, 1]);
  });

  it("chains turns: each starts where the one before stopped", () => {
    const t = worldTrajectory([
      { move: "orbit_90_ccw", seconds: 3 },
      { move: STILL_MOVE, seconds: 4 },
      { move: "zoom_in", seconds: 3 },
    ]);
    expect(t.starts).toEqual([0, 72, 72 + 96]);
    expect(t.c2ws).toHaveLength(1 + 72 + 96 + 72);
    // The still turn holds the arc's last pose.
    expect(t.c2ws[72 + 96]).toEqual(t.c2ws[72]);
    // The dolly continues in the arc's end frame: relative to its first pose it is the same as a dolly from the start.
    const own = worldTrajectory([{ move: "zoom_in", seconds: 3 }]).c2ws.at(-1)!;
    const rel = matMul(rigidInverse(t.c2ws[72 + 96]), t.c2ws.at(-1)!);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) expect(close(rel[i][j], own[i][j], 1e-4)).toBe(true);
  });

  it("holds the camera for a still turn or an unknown move", () => {
    expect(moveKeys(STILL_MOVE)).toEqual([]);
    expect(moveKeys("nope")).toEqual([]);
    expect(new Set(turnPoses(STILL_MOVE, 3).map((m) => JSON.stringify(m))).size).toBe(1);
  });
});

describe("the key script (the ComfyUI port's Nomas Camera Path)", () => {
  it("is read back by the port's rules into exactly one tick per frame", () => {
    for (const p of PATH_PRESETS) {
      const [s] = worldScripts([{ move: p.id, seconds: 5 }]);
      expect(s.ticks, p.id).toBe(5 * 24);
      expect(parseScript(s.script), p.id).toHaveLength(5 * 24);
    }
  });

  it("is empty for a still camera (the turn's seconds set its length)", () => {
    expect(worldScripts([{ move: STILL_MOVE, seconds: 5 }])).toEqual([{ script: "", ticks: 0 }]);
  });

  it("flies a dolly in on W, a truck on D, a truck left on A", () => {
    expect(worldScripts([{ move: "zoom_in", seconds: 3 }])[0].script).toMatch(/^w /);
    expect(worldScripts([{ move: "zoom_out", seconds: 3 }])[0].script).toMatch(/^s /);
    expect(worldScripts([{ move: "truck_right", seconds: 3 }])[0].script).toMatch(/^d /);
    expect(worldScripts([{ move: "truck_left", seconds: 3 }])[0].script).toMatch(/^a /);
  });

  it("follows the path: the flown camera ends near the target, heading and all", () => {
    for (const id of ["orbit_90_ccw", "orbit_90_cw", "orbit_360", "orbit_180_push", "lemniscate", "zoom_in", "truck_right"]) {
      const poses = turnPoses(id, 6);
      const { ticks, end } = steerTicks(poses);
      const flown = flyTicks(ticks);
      const last = flown.at(-1)!;
      expect(last.yaw).toBeCloseTo(end.yaw, 9);
      // The heading matches the path's to within two arrow steps.
      const f = [poses.at(-1)![0][2], -poses.at(-1)![1][2], -poses.at(-1)![2][2]];
      const wantYaw = Math.atan2(-f[0], -f[2]);
      const err = Math.abs(Math.atan2(Math.sin(wantYaw - last.yaw), Math.cos(wantYaw - last.yaw)));
      expect(err, id).toBeLessThan(((2 * 20) / 24) * (Math.PI / 180) + 1e-6);
    }
  });

  it("moves in the path's direction (only direction and relative speed reach the model)", () => {
    // An arc to the right: the camera ends to the right of where it started and has turned left (towards the subject).
    const { ticks } = steerTicks(turnPoses("orbit_90_ccw", 5));
    const last = flyTicks(ticks).at(-1)!;
    expect(last.position[0]).toBeGreaterThan(0);
    expect(last.yaw).toBeGreaterThan(Math.PI / 2 - 0.05);
    // A full ring comes back round: heading +360° and the camera near where it started.
    const ring = flyTicks(steerTicks(turnPoses("orbit_360", 12)).ticks);
    const r = ring.at(-1)!;
    expect(r.yaw).toBeGreaterThan(2 * Math.PI - 0.05);
    const span = Math.max(...ring.map((p) => Math.abs(p.position[0])));
    expect(Math.hypot(r.position[0], r.position[2])).toBeLessThan(span * 0.15);
  });

  it("turns faster than the arrows with mouse drags (a full ring in 5 s is 72°/s)", () => {
    const { ticks } = steerTicks(turnPoses("orbit_360", 5));
    expect(ticks.some((t) => "look" in t)).toBe(true);
    expect(ticksScript(ticks)).toMatch(/^look -?\d/m);
  });

  it("carries the heading from turn to turn", () => {
    const [a, b] = worldScripts([
      { move: "orbit_90_ccw", seconds: 4 },
      { move: "zoom_in", seconds: 3 },
    ]);
    // The dolly after the arc is still flown on W: forward is the camera's, whatever its heading.
    expect(b.script).toMatch(/^w /);
    const start = flyTicks(parseScript(a.script)).at(-1)!;
    const after = flyTicks(parseScript(b.script), start).at(-1)!;
    const moved = [after.position[0] - start.position[0], after.position[2] - start.position[2]];
    const f = start.forward();
    expect(moved[0] * f[0] + moved[1] * f[2]).toBeGreaterThan(0);
  });

  it("merges runs of the same keys and writes seconds the port rounds back to whole ticks", () => {
    const script = ticksScript([{ keys: ["w"] }, { keys: ["w"] }, { keys: ["w", "left"] }, { keys: [] }, { look: [10, 0] }]);
    expect(script).toBe("w 0.0833\nw+left 0.0417\nwait 0.0417\nlook 10 0 0.0417");
    expect(parseScript(script)).toHaveLength(5);
  });

  it("flies the port's controls: W moves 2.8 units a second along the view, the arrows turn 20° a second", () => {
    const p = new PortPose();
    for (let i = 0; i < 24; i++) p.step(new Set(["w"]));
    expect(p.position[2]).toBeCloseTo(-2.8, 6);
    const q = new PortPose();
    for (let i = 0; i < 24; i++) q.step(new Set(["left"]));
    expect(q.yaw).toBeCloseTo((20 * Math.PI) / 180, 6);
  });
});

describe("the path preview", () => {
  it("sketches the camera from above with each turn's start marked", () => {
    const s = pathSketch([
      { move: "orbit_90_ccw", seconds: 4 },
      { move: "truck_left", seconds: 4 },
    ]);
    expect(s.starts).toEqual([0, expect.any(Number)]);
    expect(s.points.length).toBe(s.headings.length);
    expect(s.points[0]).toEqual([0, 0]);
  });
});
