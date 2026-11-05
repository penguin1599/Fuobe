/**
 * World mode's camera (package nm10-hy-nomas-world): Fuobe's camera paths (the fly-path library in ./camera-path: orbits,
 * arcs, dollies, trucks, the figure-8, or any keys made in the 3D scene) as Hy-Nomas reads a camera.
 *
 * Two forms of the same move:
 *
 * - **The trajectory** Tencent's offline inference reads (`inference.camera_trajectory`, an .npz): camera-to-world
 *   matrices `c2ws` [N, 4, 4] in OpenCV axes (x right, y down, z forward) and normalised intrinsics [N, 3, 3]
 *   (fx = f / width, fy = f / height, principal point 0.5, 0.5, as hymm/models/camera/geometry/generate_npz_trajectories.py
 *   writes them), one per frame at 24 fps, with the release's default gains (trajectory_translation_scale 1.0,
 *   trajectory_rotation_scale 2.5). A world's turns are chained: each turn starts where the one before stopped.
 * - **The key script** the ComfyUI port (Nynxz/ComfyUI-HyNomas, Nomas Camera Path) reads: keys held at 24 fps, the way
 *   Tencent's demo is steered (W/S along the view, A/D sideways, the arrows turn 20°/s, a mouse drag turns 0.0024 rad/px).
 *   The port integrates the keys into the same camera-to-world poses, so the script is made by steering a simulated camera
 *   along the trajectory frame by frame (closed loop: every tick corrects what the earlier ticks missed).
 *
 * What survives into the model (both runtimes): each turn's poses relative to its first frame, frame-to-frame deltas,
 * translations divided by their 99th-percentile step (only direction and relative speed matter), rotations scaled by 2.5.
 * So a path's size doesn't matter, its shape and timing do. Keys can't rise straight up: a change of height is flown
 * along the (tilted) view, as the demo flies it.
 *
 * Pure: no DOM, no three.js.
 */

import { framePoses, normalizeKeys, presetKeys, PHOTO_KEY, type CameraKey, type Mat3, type Mat4 } from "./camera-path";

/** Hy-Nomas's frame rate and the size it was trained at (the release's "720p" is 1280 × 704). */
export const WORLD_FPS = 24;
export const WORLD_SIZE = { width: 1280, height: 704 } as const;
/** The release's default camera gains (configs/config.yaml): translation × 1.0, each step's rotation × 2.5. */
export const WORLD_SCALES = { translation: 1.0, rotation: 2.5 } as const;
/** The horizontal field of view the intrinsics describe (the browser demo's default camera). */
export const WORLD_FOV = 55;

/** The port's controls (nomas/camera.py at the pinned commit). */
export const PORT_CONTROLS = { moveSpeed: 2.8, turnDegPerSec: 20, mouseRadPerPx: 0.0024 } as const;

const DEG = Math.PI / 180;
const tidy = (n: number, digits = 6) => Number(n.toFixed(digits)) + 0;

/** A move for a turn: one of the fly-path presets, "still" (no camera move: words only), or keys made in the 3D scene. */
export type WorldMove = string | CameraKey[];
export const STILL_MOVE = "still";

/** The keys of a move ([] for a still camera or an unknown id). */
export function moveKeys(move: WorldMove | undefined): CameraKey[] {
  if (!move || move === STILL_MOVE) return [];
  const keys = typeof move === "string" ? presetKeys(move) : normalizeKeys(move);
  if (!keys || keys.length < 2) return [];
  const moving = keys.some((k) => Math.abs(k.azimuth) > 0.05 || Math.abs(k.elevation) > 0.05 || Math.abs(k.distance - 1) > 1e-3 || Math.abs(k.truck ?? 0) > 1e-3);
  return moving ? keys : [];
}

/** Frames of a turn `seconds` long at 24 fps (whole frames; a turn is at least one frame long). */
export function turnFrames(seconds: number): number {
  return Math.max(1, Math.round(seconds * WORLD_FPS));
}

// ---------------------------------------------------------------------------
// Small matrix helpers (4×4 rows)

type V3 = [number, number, number];

export function matMul(a: Mat4, b: Mat4): Mat4 {
  return a.map((row) => [0, 1, 2, 3].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j] + row[3] * b[3][j]));
}

/** The inverse of a rigid camera-to-world matrix. */
export function rigidInverse(m: Mat4): Mat4 {
  const r = [0, 1, 2].map((i) => [m[0][i], m[1][i], m[2][i]]);
  const t: V3 = [m[0][3], m[1][3], m[2][3]];
  const ti = r.map((row) => -(row[0] * t[0] + row[1] * t[1] + row[2] * t[2]));
  return [[...r[0], ti[0]], [...r[1], ti[1]], [...r[2], ti[2]], [0, 0, 0, 1]];
}

const IDENTITY: Mat4 = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

// ---------------------------------------------------------------------------
// The trajectory (Tencent's .npz form)

/** Normalised intrinsics of a WORLD_SIZE frame with a horizontal field of view of `fovDeg`. */
export function worldIntrinsic(fovDeg = WORLD_FOV, size: { width: number; height: number } = WORLD_SIZE): Mat3 {
  const fx = 0.5 / Math.tan(Math.max(1, Math.min(179, fovDeg)) * DEG * 0.5);
  return [
    [tidy(fx), 0, 0.5],
    [0, tidy((fx * size.width) / size.height), 0.5],
    [0, 0, 1],
  ];
}

/**
 * One turn's camera: frames + 1 camera-to-world poses (frame 0 = where the turn starts, the identity), OpenCV axes in the
 * turn's own frame. A still camera holds the identity. The subject's pivot sits one unit ahead (the size cancels out).
 */
export function turnPoses(move: WorldMove | undefined, seconds: number): Mat4[] {
  const n = turnFrames(seconds) + 1;
  const keys = moveKeys(move);
  if (!keys.length) return Array.from({ length: n }, () => IDENTITY.map((r) => [...r]));
  return framePoses(keys, n, 1, WORLD_FOV).poses;
}

export interface WorldTurnCamera {
  move?: WorldMove;
  seconds: number;
}

export interface WorldTrajectory {
  /** Camera-to-world per frame, OpenCV axes, the world being the first turn's starting camera: 1 + Σ frames. */
  c2ws: Mat4[];
  /** Normalised intrinsics per frame (fx = f / width, fy = f / height, cx = cy = 0.5). */
  intrinsics: Mat3[];
  fps: number;
  /** Where each turn starts in `c2ws` (its first pose is the previous turn's last). */
  starts: number[];
  translationScale: number;
  rotationScale: number;
}

/**
 * The whole world's camera as Tencent's trajectory file holds it: every turn's poses chained onto the end of the one
 * before (a turn's frame 0 is the previous turn's last frame), with the intrinsics and the default gains.
 */
export function worldTrajectory(turns: readonly WorldTurnCamera[], fovDeg = WORLD_FOV): WorldTrajectory {
  const c2ws: Mat4[] = [IDENTITY.map((r) => [...r])];
  const starts: number[] = [];
  let base: Mat4 = IDENTITY;
  for (const t of turns) {
    starts.push(c2ws.length - 1);
    const local = turnPoses(t.move, t.seconds);
    for (let i = 1; i < local.length; i++) c2ws.push(matMul(base, local[i]).map((row) => row.map((v) => tidy(v))));
    base = c2ws[c2ws.length - 1];
  }
  const k = worldIntrinsic(fovDeg);
  return { c2ws, intrinsics: c2ws.map(() => k.map((r) => [...r])), fps: WORLD_FPS, starts, translationScale: WORLD_SCALES.translation, rotationScale: WORLD_SCALES.rotation };
}

// ---------------------------------------------------------------------------
// The key script (the ComfyUI port's Nomas Camera Path)

/** OpenCV world (y down, z forward) → the port's Three.js world (y up, the camera looking down −Z). */
const toThree = (p: V3): V3 => [p[0], -p[1], -p[2]];

/** The port's camera (nomas/camera.py Pose): position, yaw and pitch (Euler 'YXZ', no roll), stepped one tick at a time. */
export class PortPose {
  constructor(
    public position: V3 = [0, 0, 0],
    public yaw = 0,
    public pitch = 0,
  ) {}

  copy(): PortPose {
    return new PortPose([...this.position], this.yaw, this.pitch);
  }

  /** The view direction (Three axes). */
  forward(): V3 {
    const cp = Math.cos(this.pitch);
    return [-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp];
  }

  /** One 24 fps control tick, as the port applies it. */
  step(keys: ReadonlySet<string>, mouseDx = 0, mouseDy = 0): void {
    const dt = 1 / WORLD_FPS;
    const f = this.forward();
    let right: V3 = [-f[2], 0, f[0]]; // cross(forward, up)
    const n = Math.hypot(...right);
    right = n > 1e-8 ? [right[0] / n, right[1] / n, right[2] / n] : [Math.cos(this.yaw), 0, -Math.sin(this.yaw)];
    const fw = (keys.has("w") ? 1 : 0) - (keys.has("s") ? 1 : 0);
    const rt = (keys.has("d") ? 1 : 0) - (keys.has("a") ? 1 : 0);
    const v = PORT_CONTROLS.moveSpeed * dt;
    this.position = [0, 1, 2].map((i) => this.position[i] + (f[i] * fw + right[i] * rt) * v) as V3;
    const turn = PORT_CONTROLS.turnDegPerSec * DEG * dt;
    this.yaw += turn * ((keys.has("left") ? 1 : 0) - (keys.has("right") ? 1 : 0)) - mouseDx * PORT_CONTROLS.mouseRadPerPx;
    this.pitch += turn * ((keys.has("up") ? 1 : 0) - (keys.has("down") ? 1 : 0)) - mouseDy * PORT_CONTROLS.mouseRadPerPx;
  }
}

/** A tick of the script: keys held for one frame, or a mouse drag in pixels (the port's `look`, which holds no keys). */
export type Tick = { keys: string[] } | { look: [number, number] };

/** A camera-to-world pose (OpenCV) as the port's position / yaw / pitch (Three axes). */
function portTarget(m: Mat4): { position: V3; yaw: number; pitch: number } {
  const f = toThree([m[0][2], m[1][2], m[2][2]]);
  return { position: toThree([m[0][3], m[1][3], m[2][3]]), yaw: Math.atan2(-f[0], -f[2]), pitch: Math.asin(Math.max(-1, Math.min(1, f[1]))) };
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** How many arrow steps the heading may fall behind before a mouse drag catches it up (about 3.3°). */
const LOOK_DEBT = 4;

/**
 * Steer the port's camera along a turn's poses (`poses[0]` is where it starts), one tick per frame. The path is scaled so
 * its fastest stretch runs at 90 % of the keys' speed (less when it also turns faster than the arrows can, leaving room
 * for the mouse-drag ticks that catch the heading up, which hold no keys); keys and arrows are pressed when the simulated
 * camera falls half a step behind. The start pose carries the earlier turns' heading and tilt.
 */
export function steerTicks(poses: readonly Mat4[], start: PortPose = new PortPose()): { ticks: Tick[]; end: PortPose } {
  const n = poses.length - 1;
  if (n < 1) return { ticks: [], end: start.copy() };
  const first = portTarget(poses[0]);
  // The turn's own frame, turned to the camera's heading: the targets are relative to the turn's first pose.
  const rel = poses.map((m) => portTarget(m));
  let fastest = 0;
  let fastestTurn = 0;
  for (let i = 1; i <= n; i++) {
    fastest = Math.max(fastest, Math.hypot(...([0, 1, 2].map((a) => rel[i].position[a] - rel[i - 1].position[a]) as V3)));
    fastestTurn = Math.max(fastestTurn, Math.abs(wrap(rel[i].yaw - rel[i - 1].yaw)), Math.abs(rel[i].pitch - rel[i - 1].pitch));
  }
  const keyStep = PORT_CONTROLS.moveSpeed / WORLD_FPS;
  const arrowStep = (PORT_CONTROLS.turnDegPerSec * DEG) / WORLD_FPS;
  // Turning faster than the arrows: the heading falls behind by (turn − arrow) a tick, and a drag catches it up once it is
  // LOOK_DEBT arrow steps behind, so one tick in (m + 1) holds no keys; the path is slowed to leave that room.
  const behind = fastestTurn - arrowStep;
  const share = behind > 1e-9 ? 1 / ((LOOK_DEBT * arrowStep) / behind + 1) : 0;
  const scale = fastest > 1e-9 ? (keyStep * 0.9 * (1 - share)) / fastest : 0;
  // Rotate the turn's frame by the start heading so "forward" in the path is forward for the camera.
  const cy = Math.cos(start.yaw - first.yaw);
  const sy = Math.sin(start.yaw - first.yaw);
  const place = (p: V3): V3 => {
    const d: V3 = [(p[0] - first.position[0]) * scale, (p[1] - first.position[1]) * scale, (p[2] - first.position[2]) * scale];
    // Rotation about +Y by (start.yaw - first.yaw), Three axes.
    return [start.position[0] + cy * d[0] + sy * d[2], start.position[1] + d[1], start.position[2] - sy * d[0] + cy * d[2]];
  };
  const cam = start.copy();
  const ticks: Tick[] = [];
  for (let i = 1; i <= n; i++) {
    const want = place(rel[i].position);
    const wantYaw = start.yaw + wrap(rel[i].yaw - first.yaw);
    const wantPitch = start.pitch + (rel[i].pitch - first.pitch);
    const dyaw = wrap(wantYaw - cam.yaw);
    const dpitch = wantPitch - cam.pitch;
    // Turning further than the arrows reach this tick: a mouse drag (no keys) catches the heading up exactly.
    if (Math.abs(dyaw) > arrowStep * LOOK_DEBT || Math.abs(dpitch) > arrowStep * LOOK_DEBT) {
      const dx = -dyaw / PORT_CONTROLS.mouseRadPerPx;
      const dy = -dpitch / PORT_CONTROLS.mouseRadPerPx;
      const look: [number, number] = [tidy(dx, 3), tidy(dy, 3)];
      cam.step(new Set(), look[0], look[1]);
      ticks.push({ look });
      continue;
    }
    const keys: string[] = [];
    const f = cam.forward();
    const fr: V3 = [-f[2], 0, f[0]];
    const fn = Math.hypot(...fr) || 1;
    const r: V3 = [fr[0] / fn, 0, fr[2] / fn];
    const err: V3 = [want[0] - cam.position[0], want[1] - cam.position[1], want[2] - cam.position[2]];
    const along = err[0] * f[0] + err[1] * f[1] + err[2] * f[2];
    const side = err[0] * r[0] + err[2] * r[2];
    if (along > keyStep / 2) keys.push("w");
    else if (along < -keyStep / 2) keys.push("s");
    if (side > keyStep / 2) keys.push("d");
    else if (side < -keyStep / 2) keys.push("a");
    if (dyaw > arrowStep / 2) keys.push("left");
    else if (dyaw < -arrowStep / 2) keys.push("right");
    if (dpitch > arrowStep / 2) keys.push("up");
    else if (dpitch < -arrowStep / 2) keys.push("down");
    cam.step(new Set(keys));
    ticks.push({ keys });
  }
  return { ticks, end: cam };
}

/** Ticks as the port's script: runs of the same keys merged ("w+left 0.375"), one instruction per line. */
export function ticksScript(ticks: readonly Tick[]): string {
  const lines: string[] = [];
  let i = 0;
  while (i < ticks.length) {
    const t = ticks[i];
    let j = i + 1;
    if ("look" in t) {
      lines.push(`look ${t.look[0]} ${t.look[1]} ${secs(1)}`);
      i = j;
      continue;
    }
    const name = t.keys.length ? t.keys.join("+") : "wait";
    while (j < ticks.length && !("look" in ticks[j]) && ((ticks[j] as { keys: string[] }).keys.join("+") || "wait") === name) j++;
    lines.push(`${name} ${secs(j - i)}`);
    i = j;
  }
  return lines.join("\n");
}

/** Seconds of `n` ticks, written so the port's round(seconds × 24) gives back n. */
function secs(n: number): string {
  return String(tidy(n / WORLD_FPS, 4));
}

/** The port's own reading of a script (nomas/camera.py parse_script): one tick per frame. */
export function parseScript(script: string): Tick[] {
  const ticks: Tick[] = [];
  for (const raw of script.replace(/,/g, "\n").split("\n")) {
    const parts = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!parts.length || parts[0].startsWith("#")) continue;
    if (parts[0] === "look") {
      const dx = Number(parts[1]);
      const dy = Number(parts[2]);
      const n = Math.max(1, Math.round((parts.length > 3 ? Number(parts[3]) : 1) * WORLD_FPS));
      for (let k = 0; k < n; k++) ticks.push({ look: [dx / n, dy / n] });
      continue;
    }
    const keys = ["wait", "stay", "none"].includes(parts[0]) ? [] : parts[0].split("+");
    const n = Math.max(1, Math.round((parts.length > 1 ? Number(parts[1]) : 1) * WORLD_FPS));
    for (let k = 0; k < n; k++) ticks.push({ keys });
  }
  return ticks;
}

/** Ticks flown from `start`: the poses the port integrates (frame 0 = the start). */
export function flyTicks(ticks: readonly Tick[], start: PortPose = new PortPose()): PortPose[] {
  const cam = start.copy();
  const out = [cam.copy()];
  for (const t of ticks) {
    if ("look" in t) cam.step(new Set(), t.look[0], t.look[1]);
    else cam.step(new Set(t.keys));
    out.push(cam.copy());
  }
  return out;
}

export interface WorldScriptTurn {
  /** The port's script for this turn ("" for a still camera: the turn's length comes from its seconds). */
  script: string;
  /** Ticks in the script (= frames − 1 of the turn when it moves). */
  ticks: number;
}

/**
 * Every turn's key script, flown one after the other: a turn starts with the heading and tilt the one before left, as the
 * port's world carries its camera from turn to turn. A still turn has no script.
 */
export function worldScripts(turns: readonly WorldTurnCamera[]): WorldScriptTurn[] {
  let cam = new PortPose();
  return turns.map((t) => {
    if (!moveKeys(t.move).length) return { script: "", ticks: 0 };
    const { ticks, end } = steerTicks(turnPoses(t.move, t.seconds), cam);
    cam = end;
    return { script: ticksScript(ticks), ticks: ticks.length };
  });
}

/** A top-down sketch of the world's camera for "Preview the path": x / z of every frame (Three axes) and each turn's start. */
export function pathSketch(turns: readonly WorldTurnCamera[], step = 4): { points: [number, number][]; starts: number[]; headings: number[] } {
  const traj = worldTrajectory(turns);
  const points: [number, number][] = [];
  const headings: number[] = [];
  const starts: number[] = [];
  const keep = (i: number) => i % step === 0 || traj.starts.includes(i) || i === traj.c2ws.length - 1;
  traj.c2ws.forEach((m, i) => {
    if (!keep(i)) return;
    if (traj.starts.includes(i)) starts.push(points.length);
    const t = portTarget(m);
    points.push([tidy(t.position[0], 4), tidy(t.position[2], 4)]);
    headings.push(tidy(t.yaw, 4));
  });
  return { points, starts, headings };
}

export { PHOTO_KEY };
