import "server-only";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import sharp from "sharp";
import { PATH_FPS, PATH_FRAMES, framePoses, renderSize, type CameraKey } from "@/lib/camera-path";
import { splatFrame } from "@/lib/path-splat";
import { LENS, buildPointCloud, lensFov } from "@/lib/scene3d";
import { adoptFile, readRef, scratchDir } from "./storage";

/**
 * The server's path render (option B: a small headless point-cloud renderer, no node pack): a still and
 * its depth picture (MoGe 2's, from the depth step) become a point cloud the way Cinema's 3D scene builds one (scene3d
 * buildPointCloud, the photo taken with the scene's default lens), drawn along the camera path at 81 frames, 16 fps (the
 * Uni3C graph's length), black where nothing was seen, and encoded to an MP4 by ffmpeg. Canvas, Assist, Fuobe DoP and
 * Cinema's exact orbits use it, since none of them has a browser view of the scene; Cinema's 3D scene and Image to 3D
 * still record theirs in the browser.
 *
 * It runs inside the step's run (generations.ts advanceDependents): an account's step reads only its own files
 * (readRef) and the render is stored as its file.
 */

/** At most this many points (every second pixel of an 832 px render): a few seconds of CPU for 81 frames. */
const MAX_POINTS = 300_000;

export class PathRenderError extends Error {}

/** Raw RGBA pixels of a picture at exactly `size`. */
async function pixels(data: Buffer, size: { width: number; height: number }) {
  const img = sharp(data, { failOn: "none" }).rotate().removeAlpha().ensureAlpha().resize(size.width, size.height, { fit: "fill" });
  const { data: raw, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: raw };
}

/** Frames as RGB into ffmpeg's stdin, an H.264 MP4 out (yuv420p, so every reader plays it), written to `file`. */
export function encode(file: string, frames: number, width: number, height: number, fps: number, frame: (i: number) => Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-r", String(fps), "-i", "pipe:0"];
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", "-y", file);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.env.FFMPEG_PATH || "ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
    } catch {
      reject(new PathRenderError("Rendering the camera path needs ffmpeg on the studio's server"));
      return;
    }
    let err = "";
    child.stderr!.on("data", (b: Buffer) => (err += b.toString()));
    child.on("error", () => reject(new PathRenderError("Rendering the camera path needs ffmpeg on the studio's server")));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new PathRenderError(`The camera path couldn't be encoded${err ? `: ${err.trim().split("\n").pop()}` : ""}`))));
    child.stdin!.on("error", () => undefined);
    (async () => {
      for (let i = 0; i < frames; i++) {
        if (!child.stdin!.write(frame(i))) await new Promise((r) => child.stdin!.once("drain", r));
      }
      child.stdin!.end();
    })().catch(() => child.kill());
  });
}

export interface PathRenderInput {
  /** The still (the clip's first frame). */
  photo: string;
  /** Its depth picture (MoGe 2's depth render; any grey or Spectral depth map scene3d reads). */
  depth: string;
  keys: CameraKey[];
  frames?: number;
  fps?: number;
}

/** The path through the still's scene: its frame size and a renderer for frame i (RGB, rows top-down). */
export async function pathScene(input: Omit<PathRenderInput, "fps">): Promise<{ width: number; height: number; count: number; frame: (i: number) => Uint8Array }> {
  const [photoFile, depthFile] = await Promise.all([readRef(input.photo), readRef(input.depth)]);
  const meta = await sharp(photoFile.data, { failOn: "none" }).metadata();
  const aspect = (meta.autoOrient?.width ?? meta.width ?? 1) / (meta.autoOrient?.height ?? meta.height ?? 1);
  // Read at the render's own size, so every point covers about its pixel there.
  const size = renderSize(aspect);
  const photo = await pixels(photoFile.data, size);
  const depth = await pixels(depthFile.data, size);
  const hFov = lensFov(LENS.default, aspect).h;
  const cloud = buildPointCloud(photo, depth, { hFov, maxPoints: MAX_POINTS });
  const poses = framePoses(input.keys, input.frames ?? PATH_FRAMES, cloud.depth, hFov, size);
  // A new buffer a frame: the encoder's pipe may still hold the last one.
  return { ...size, count: poses.poses.length, frame: (i) => splatFrame(cloud, poses.poses[i], poses.intrinsic, size.width, size.height) };
}

/** Render the path and store it (an MP4, as the generation's derived file): its URL, for the step's `video`. */
export async function renderPathVideo(input: PathRenderInput, generationId?: string): Promise<string> {
  const scene = await pathScene(input);
  const file = path.join(scratchDir(), `path-${nanoid(10)}.mp4`);
  try {
    await encode(file, scene.count, scene.width, scene.height, input.fps ?? PATH_FPS, scene.frame);
    return adoptFile({ from: file, contentType: "video/mp4", name: "path-render.mp4", source: "derived", ...(generationId && { generationId }) }).url;
  } finally {
    fs.rmSync(file, { force: true });
  }
}
