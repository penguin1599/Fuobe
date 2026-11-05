/**
 * WorldCast cases (build plan N7-9; research new-models-7.md §3.1-§3.6, §3.11; the worker contract in docs/workers/worldcast.md).
 *
 * WorldCast (PixCtrol, Apache-2.0) films a still along a camera path while the back and sides follow up to four reference
 * views of the subject. It has no ComfyUI port: it runs as a worker on the user's GPU, and Fuobe prepares each case for it:
 *
 * - the still, centre-cropped to the model's portrait 480 × 832, and its person mask (SAM 3.1);
 * - the path: 81 camera-to-world poses in OpenCV axes and a pixel intrinsic (cam_info.json), from the camera-path library's
 *   keys (framePoses), and the point-cloud render along it with its hole mask (render.mp4 / render_mask.mp4, 0 = covered,
 *   255 = a hole), drawn from the still's depth (MoGe 2) the way the Uni3C path render is;
 * - the anchors: the views with their names and azimuths in WorldCast's convention (worldcastAnchor, src/lib/catalog/turnaround.ts),
 *   each with its person mask, and their cameras on a ring at the subject's distance (anchors_aligned_camera_info.json,
 *   world-to-camera, a guess: the paper aligns real cameras with VGGT-Omega).
 *
 * Pure: matrices, names, sizes and the multipart's parts. The pixels are made on the server (src/server/worldcast-case.ts).
 */

import { cropFov, keyPose, type FramePoses, type Mat3, type Mat4 } from "./camera-path";
import type { TurnSide } from "./catalog/turnaround";

/**
 * WorldCast's convention (N7-9; new-models-7.md §3.4, §3.11): its 1–4 anchor photos are named front, right_side, back and
 * left_side, with each one's azimuth in body_views_meta.json. The names are WHERE THE CAMERA STANDS, not the body's own sides:
 * the demo case's aligned cameras (no_padding_black/anchors_aligned_camera_info.json) put right_side at +x of the first camera
 * (moved round to the camera's own right, 91.79°) and left_side at −x (266.91°, `left_sign` −1: reached turning the other
 * way, −93°), and its "right_side" crop shows the boy facing the lens because the first frame shows him in profile. So
 * WorldCast's azimuth is the camera-path library's (+ = moved round to the right), and a person's own right side, seen from
 * the camera moved round to its LEFT (pathAzimuth −90°), is WorldCast's left_side. Convert in worldcastAnchor and nowhere
 * else; a swapped left and right silently hurts identity.
 */
/** Where the camera stands round the person to see each of their sides (turnaround.ts viewAzimuth). */
const PERSON_AZIMUTH: Record<TurnSide, number> = { front: 0, right: 90, back: 180, left: 270 };

export const WORLDCAST = {
  anchor: { front: "front", right: "left_side", back: "back", left: "right_side" } as const satisfies Record<TurnSide, string>,
  /** The demo case's azimuths (demo_case/A360-031__portrait/body_views_vggt/body_views_meta.json). */
  demoAzimuth: { front: 0, right_side: 91.79, back: 171.39, left_side: 266.91 },
  leftSign: -1 as const,
};

export type WorldcastView = (typeof WORLDCAST.anchor)[TurnSide];

/**
 * A side as a WorldCast anchor: its name, the azimuth to write for it (0–360, + = the camera moved round to its right) and
 * the signed one (left_side by `left_sign`: −90°), which is also where camera-path keyPose puts its camera.
 */
export function worldcastAnchor(side: TurnSide): { name: WorldcastView; azimuth: number; signed: number } {
  const name = WORLDCAST.anchor[side];
  // The camera-path azimuth that sees this side (turnaround.ts pathAzimuth: −viewAzimuth), as 0–360.
  const azimuth = (360 - PERSON_AZIMUTH[side]) % 360;
  return { name, azimuth, signed: name === "left_side" ? WORLDCAST.leftSign * (360 - azimuth) : azimuth };
}

/** What the released checkpoint was trained on and the demo runs with (demo.py): fixed, except the seed and the prompt. */
export const WORLDCAST_RUN = { frames: 81, fps: 15, width: 480, height: 832, steps: 50, cfg: 5, shift: 2, maxAnchors: 4 } as const;

/** The anchors' order in body_views_meta.json's selected_views (and the RoPE slots 25 / 30 / 35 / 40 they take). */
export const WORLDCAST_VIEWS: readonly WorldcastView[] = ["front", "left_side", "right_side", "back"];

/** A WorldCast anchor: the person's own side it shows, the name WorldCast gives that camera, and its azimuth (0–360). */
export interface WorldcastAnchor {
  side: TurnSide;
  view: WorldcastView;
  azimuth: number;
}

/** Where a run's anchors are, stored with the request (params.extra.worldcast) so the provider can read its pictures back. */
export interface WorldcastLayout {
  anchors: WorldcastAnchor[];
}

/** The anchors for these sides: one per side, at most four, in WorldCast's own order. */
export function worldcastLayout(sides: readonly TurnSide[]): WorldcastLayout {
  const seen = new Set<WorldcastView>();
  const anchors: WorldcastAnchor[] = [];
  for (const side of sides) {
    const a = worldcastAnchor(side);
    if (seen.has(a.name)) continue;
    seen.add(a.name);
    anchors.push({ side, view: a.name, azimuth: a.azimuth });
  }
  anchors.sort((a, b) => WORLDCAST_VIEWS.indexOf(a.view) - WORLDCAST_VIEWS.indexOf(b.view));
  return { anchors: anchors.slice(0, WORLDCAST_RUN.maxAnchors) };
}

/** A layout read back from a stored request: only known views, each once, at most four. */
export function readLayout(v: unknown): WorldcastLayout {
  const list = (v as { anchors?: unknown } | null)?.anchors;
  if (!Array.isArray(list)) return { anchors: [] };
  const sides = list.flatMap((a) => (a && typeof a === "object" && ["front", "right", "back", "left"].includes((a as { side?: string }).side ?? "") ? [(a as { side: TurnSide }).side] : []));
  return worldcastLayout(sides);
}

/**
 * Where each picture sits in the step's images: the still, the anchors, the still's mask, the anchors' masks, then the
 * still's depth picture (MoGe 2's), which the chain hands in last.
 */
export function imageSlots(layout: WorldcastLayout) {
  const n = layout.anchors.length;
  return { still: 0, anchor: (i: number) => 1 + i, stillMask: 1 + n, anchorMask: (i: number) => 2 + n + i, depth: 2 + 2 * n, total: 3 + 2 * n };
}

/** The part of a `width` × `height` picture the model keeps: the largest 480:832 rectangle at its centre. */
export function worldcastCrop(width: number, height: number): { left: number; top: number; width: number; height: number } {
  const want = WORLDCAST_RUN.width / WORLDCAST_RUN.height;
  if (width / height > want) {
    const w = Math.max(1, Math.round(height * want));
    return { left: Math.floor((width - w) / 2), top: 0, width: w, height };
  }
  const h = Math.max(1, Math.round(width / want));
  return { left: 0, top: Math.floor((height - h) / 2), width, height: h };
}

/** The horizontal field of view of that crop, for a photo whose own is `photoHFov`. */
export function worldcastFov(photoHFov: number, photoAspect: number): number {
  return cropFov(photoHFov, photoAspect, WORLDCAST_RUN.width / WORLDCAST_RUN.height);
}

const r6 = (n: number) => Number(n.toFixed(6)) + 0;

/** The inverse of a rigid camera-to-world matrix (R | t): (Rᵀ | −Rᵀt). */
export function invertRigid(m: Mat4): Mat4 {
  const R = [0, 1, 2].map((r) => [m[r][0], m[r][1], m[r][2]]);
  const t = [m[0][3], m[1][3], m[2][3]];
  const out: Mat4 = [0, 1, 2].map((r) => {
    const row = [R[0][r], R[1][r], R[2][r]];
    return [...row, -(row[0] * t[0] + row[1] * t[1] + row[2] * t[2])].map(r6);
  });
  out.push([0, 0, 0, 1]);
  return out;
}

/** cam_info.json: the path's camera-to-world poses as the pipeline reads them ("as stored", c2w; --invert_camera_extrinsic off). */
export interface CamInfo {
  width: number;
  height: number;
  num_frames: number;
  intrinsic: Mat3;
  extrinsic: Mat4[];
  extrinsic_convention: string;
  source: string;
  alignment: { method: string; scale: number };
}

export function camInfo(path: FramePoses): CamInfo {
  return {
    width: path.width,
    height: path.height,
    num_frames: path.poses.length,
    intrinsic: path.intrinsic,
    extrinsic: path.poses,
    extrinsic_convention: "c2w, OpenCV (x right, y down, z forward); the world is the first frame's camera",
    source: "fuobe_camera_path",
    alignment: { method: "fuobe_moge_depth", scale: 1 },
  };
}

/**
 * anchors_aligned_camera_info.json: a world-to-camera pose for the first frame and each anchor, in cam_info's world, matched
 * by name ("first_frame", "front", …). Fuobe has no pose estimator for the views, so each anchor camera sits on a level ring
 * at the subject's distance at its azimuth, looking at the subject (the research's guess; the paper aligns real cameras).
 */
export function alignedAnchors(layout: WorldcastLayout, path: FramePoses, pivotDepth: number) {
  const views = ["first_frame", ...layout.anchors.map((a) => a.view)];
  const poses = [path.poses[0], ...layout.anchors.map((a) => keyPose({ t: 0, azimuth: a.azimuth > 180 ? a.azimuth - 360 : a.azimuth, elevation: 0, distance: 1 }, pivotDepth))];
  return {
    width: path.width,
    height: path.height,
    intrinsic: path.intrinsic,
    views,
    extrinsic: poses.map(invertRigid),
    extrinsic_convention: "w2c in cam_info's world frame (inverse of c2w)",
    source: "fuobe_ring",
    view_provenance: Object.fromEntries([["first_frame", { branch: "path" }], ...layout.anchors.map((a) => [a.view, { branch: "ring", azimuth_deg: a.azimuth, side: a.side }])]),
  };
}

/** body_views_meta.json's fields the worker writes beside the anchors (selected_views in WorldCast's order, left_sign −1). */
export function anchorsMeta(layout: WorldcastLayout) {
  return {
    az_front_deg: 0,
    left_sign: -1,
    selected_views: layout.anchors.map((a) => a.view),
    per_view: Object.fromEntries(layout.anchors.map((a) => [a.view, { azimuth_deg: a.azimuth }])),
  };
}

/** The anchors field of POST /cases: each anchor's view, azimuth and the names of its two files in the form. */
export function anchorsField(layout: WorldcastLayout) {
  return layout.anchors.map((a) => ({ side: a.view, azimuth: a.azimuth, image: `anchor_${a.view}.png`, mask: `anchor_${a.view}_mask.png` }));
}

export interface CaseFiles {
  firstFrame: Uint8Array;
  personMask: Uint8Array;
  render: Uint8Array;
  renderMask: Uint8Array;
  anchors: { image: Uint8Array; mask: Uint8Array }[];
}

export interface CaseOptions {
  prompt: string;
  seed: number;
  /** Leave anchors_aligned_camera_info.json out (WorldCast then skips the anchors' Plücker rays). */
  noAlignedCameras?: boolean;
  pivotDepth: number;
}

export type CasePart = { name: string; value: string } | { name: string; filename: string; contentType: string; data: Uint8Array };

/** Everything POST /cases sends, in order (docs/workers/worldcast.md). */
export function caseParts(layout: WorldcastLayout, path: FramePoses, files: CaseFiles, o: CaseOptions): CasePart[] {
  const problem = caseProblem(layout, path, files);
  if (problem) throw new Error(problem);
  const json = (name: string, v: unknown): CasePart => ({ name, filename: name, contentType: "application/json", data: new TextEncoder().encode(JSON.stringify(v)) });
  const parts: CasePart[] = [
    { name: "first_frame.png", filename: "first_frame.png", contentType: "image/png", data: files.firstFrame },
    { name: "person_mask.png", filename: "person_mask.png", contentType: "image/png", data: files.personMask },
    { name: "render.mp4", filename: "render.mp4", contentType: "video/mp4", data: files.render },
    { name: "render_mask.mp4", filename: "render_mask.mp4", contentType: "video/mp4", data: files.renderMask },
    json("cam_info.json", camInfo(path)),
    { name: "anchors", value: JSON.stringify(anchorsField(layout)) },
  ];
  layout.anchors.forEach((a, i) => {
    parts.push({ name: `anchor_${a.view}.png`, filename: `anchor_${a.view}.png`, contentType: "image/png", data: files.anchors[i].image });
    parts.push({ name: `anchor_${a.view}_mask.png`, filename: `anchor_${a.view}_mask.png`, contentType: "image/png", data: files.anchors[i].mask });
  });
  if (layout.anchors.length && !o.noAlignedCameras) parts.push(json("anchors_aligned_camera_info.json", alignedAnchors(layout, path, o.pivotDepth)));
  const r = WORLDCAST_RUN;
  parts.push(
    { name: "prompt", value: o.prompt },
    { name: "seed", value: String(o.seed) },
    { name: "steps", value: String(r.steps) },
    { name: "cfg", value: String(r.cfg) },
    { name: "shift", value: String(r.shift) },
    { name: "height", value: String(r.height) },
    { name: "width", value: String(r.width) },
  );
  return parts;
}

const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) <= eps;

/** What is wrong with a case before it is sent, or null. */
export function caseProblem(layout: WorldcastLayout, path: FramePoses, files: CaseFiles): string | null {
  if (path.poses.length !== WORLDCAST_RUN.frames) return `WorldCast takes ${WORLDCAST_RUN.frames} camera poses, not ${path.poses.length}`;
  if (path.width !== WORLDCAST_RUN.width || path.height !== WORLDCAST_RUN.height) return `WorldCast films ${WORLDCAST_RUN.width} × ${WORLDCAST_RUN.height}`;
  for (const m of path.poses) {
    if (m.length !== 4 || m.some((row) => row.length !== 4 || row.some((v) => !Number.isFinite(v)))) return "A camera pose isn't a 4 × 4 matrix";
    if (!(near(m[3][0], 0) && near(m[3][1], 0) && near(m[3][2], 0) && near(m[3][3], 1))) return "A camera pose isn't rigid";
    const c = [0, 1, 2].map((j) => [m[0][j], m[1][j], m[2][j]]);
    for (let a = 0; a < 3; a++)
      for (let b = 0; b < 3; b++) {
        const dot = c[a][0] * c[b][0] + c[a][1] * c[b][1] + c[a][2] * c[b][2];
        if (!near(dot, a === b ? 1 : 0)) return "A camera pose isn't a rotation";
      }
  }
  const k = path.intrinsic;
  if (k.length !== 3 || !(k[0][0] > 0 && k[1][1] > 0) || !near(k[2][2], 1)) return "The camera intrinsic isn't a pixel intrinsic";
  if (layout.anchors.length > WORLDCAST_RUN.maxAnchors) return `WorldCast takes up to ${WORLDCAST_RUN.maxAnchors} views`;
  if (files.anchors.length !== layout.anchors.length) return "Each view needs its picture and its mask";
  if (!files.firstFrame.length || !files.personMask.length || !files.render.length || !files.renderMask.length) return "The case is missing a file";
  return null;
}
