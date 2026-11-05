/**
 * A headless point-cloud renderer (option B): the frames of a camera path drawn through a still's point
 * cloud (scene3d buildPointCloud) with no browser and no GPU, for the server's path render (src/server/path-render.ts).
 * It draws what the browser's recordPath draws for Uni3C: the points seen from each camera, nearest in front, black where
 * nothing was seen.
 *
 * Pure: typed arrays in, typed arrays out.
 */

import type { Mat3, Mat4 } from "./camera-path";
import type { PointCloud } from "./scene3d";

/** The widest a point is drawn (pixels), so a point right in front of the camera doesn't paint the whole frame. */
export const MAX_SPLAT_PX = 6;

/**
 * One frame, RGB (3 bytes a pixel, rows top-down), of `cloud` (glTF axes: x right, y up, the photo looking down −Z) seen by
 * a camera-to-world `pose` in OpenCV axes (x right, y down, z forward; the world is the photo camera's own frame, as
 * camera-path framePoses makes them) with pixel intrinsic `k`. Each point is a square as wide as its size at its distance.
 * `holes` (RGB too, for WorldCast's render_mask.mp4) is filled white where no point landed and black where one did.
 */
export function splatFrame(
  cloud: Pick<PointCloud, "positions" | "colors" | "sizes" | "count">,
  pose: Mat4,
  k: Mat3,
  width: number,
  height: number,
  out?: Uint8Array,
  holes?: Uint8Array,
): Uint8Array {
  const rgb = out ?? new Uint8Array(width * height * 3);
  rgb.fill(0);
  const zbuf = new Float32Array(width * height).fill(Infinity);
  const [fx, fy, cx, cy] = [k[0][0], k[1][1], k[0][2], k[1][2]];
  // World → camera: R^T (p − eye), R's columns being the camera's right, down and forward.
  const ex = pose[0][3];
  const ey = pose[1][3];
  const ez = pose[2][3];
  const r = [0, 1, 2].map((c) => [pose[0][c], pose[1][c], pose[2][c]]);
  const { positions: P, colors: C, sizes: S } = cloud;
  for (let i = 0; i < cloud.count; i++) {
    // glTF → OpenCV: y and z flip.
    const px = P[i * 3] - ex;
    const py = -P[i * 3 + 1] - ey;
    const pz = -P[i * 3 + 2] - ez;
    const zc = r[2][0] * px + r[2][1] * py + r[2][2] * pz;
    if (zc <= 1e-4) continue;
    const xc = r[0][0] * px + r[0][1] * py + r[0][2] * pz;
    const yc = r[1][0] * px + r[1][1] * py + r[1][2] * pz;
    const u = (fx * xc) / zc + cx;
    const v = (fy * yc) / zc + cy;
    const half = Math.min(MAX_SPLAT_PX, Math.max(1, (fx * S[i]) / zc)) / 2;
    const x0 = Math.max(0, Math.floor(u - half));
    const x1 = Math.min(width - 1, Math.ceil(u + half) - 1);
    const y0 = Math.max(0, Math.floor(v - half));
    const y1 = Math.min(height - 1, Math.ceil(v + half) - 1);
    if (x0 > x1 || y0 > y1) continue;
    const red = Math.round(C[i * 3] * 255);
    const green = Math.round(C[i * 3 + 1] * 255);
    const blue = Math.round(C[i * 3 + 2] * 255);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const o = y * width + x;
        if (zc >= zbuf[o]) continue;
        zbuf[o] = zc;
        rgb[o * 3] = red;
        rgb[o * 3 + 1] = green;
        rgb[o * 3 + 2] = blue;
      }
  }
  if (holes) for (let o = 0; o < zbuf.length; o++) holes[o * 3] = holes[o * 3 + 1] = holes[o * 3 + 2] = zbuf[o] === Infinity ? 255 : 0;
  return rgb;
}
