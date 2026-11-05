import "server-only";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import sharp from "sharp";
import { DEFAULT_MOTION, framePoses, type CameraKey } from "@/lib/camera-path";
import { splatFrame } from "@/lib/path-splat";
import { LENS, buildPointCloud, lensFov } from "@/lib/scene3d";
import { WORLDCAST_RUN, caseParts, imageSlots, worldcastCrop, worldcastFov, type CasePart, type WorldcastLayout } from "@/lib/worldcast";
import { encode } from "./path-render";
import { scratchDir } from "./storage";

/**
 * A WorldCast case made from a run's pictures (build plan N7-9): the still cropped to 480 × 832 and its SAM 3.1 mask, the
 * point-cloud render of the path through MoGe 2's depth with its hole mask (two MP4s at 15 fps), cam_info.json, and the anchors
 * with their masks (the worker cuts their tight no_padding_black crops: docs/workers/worldcast.md). The pictures arrive in the
 * order src/lib/worldcast.ts imageSlots gives.
 */

const MAX_POINTS = 300_000;
/**
 * The longest side an anchor picture is sent at. The worker crops each anchor to the person at the size it gets, and
 * WorldCast encodes that crop at its own size: the demo's body views are cut from 768 × 1344 frames, so a phone photo is
 * brought down to that scale first (a 4000 × 6000 photo would otherwise add tens of thousands of tokens per anchor).
 */
export const ANCHOR_MAX_SIDE = 1344;

export interface CaseInput {
  layout: WorldcastLayout;
  /** The step's pictures, as files (imageSlots' order). */
  images: Buffer[];
  keys: CameraKey[];
  prompt?: string;
  seed?: number;
  /** false: leave anchors_aligned_camera_info.json out. */
  alignedCameras?: boolean;
}

const W = WORLDCAST_RUN.width;
const H = WORLDCAST_RUN.height;

async function raw(img: ReturnType<typeof sharp>) {
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

/** A mask as 0 / 255 grey, white where the person is (any picture SAM 3.1 saved: grey, RGB or with alpha). */
async function binaryMask(data: Buffer, size?: { width: number; height: number }, crop?: ReturnType<typeof worldcastCrop>): Promise<Buffer> {
  let img = sharp(data, { failOn: "none" }).rotate().flatten({ background: "#000" }).greyscale();
  if (size) img = img.resize(size.width, size.height, { fit: "fill", kernel: "nearest" });
  if (crop) img = sharp(await img.png().toBuffer()).extract(crop).resize(W, H, { fit: "fill", kernel: "nearest" });
  return img.threshold(128).png().toBuffer();
}

async function sizeOf(data: Buffer): Promise<{ width: number; height: number }> {
  const m = await sharp(data, { failOn: "none" }).metadata();
  return { width: m.autoOrient?.width ?? m.width ?? 1, height: m.autoOrient?.height ?? m.height ?? 1 };
}

/** The case's parts, ready for POST /cases. */
export async function buildCase(input: CaseInput): Promise<{ parts: CasePart[]; pivotDepth: number }> {
  const slots = imageSlots(input.layout);
  if (input.images.length < slots.total) throw new Error("WorldCast needs the still, its depth and every picture's mask");
  const still = input.images[slots.still];
  const full = await sizeOf(still);
  const crop = worldcastCrop(full.width, full.height);
  const firstFrame = await sharp(still, { failOn: "none" }).rotate().removeAlpha().extract(crop).resize(W, H, { fit: "fill" }).png().toBuffer();
  const personMask = await binaryMask(input.images[slots.stillMask], full, crop);
  // The depth picture is MoGe 2's of the whole still: brought to the still's size, then cropped the same way.
  const depthFull = await sharp(input.images[slots.depth], { failOn: "none" }).rotate().resize(full.width, full.height, { fit: "fill" }).png().toBuffer();
  const photo = await raw(sharp(firstFrame).removeAlpha().ensureAlpha());
  const depth = await raw(sharp(depthFull).extract(crop).resize(W, H, { fit: "fill" }).removeAlpha().ensureAlpha());
  const hFov = worldcastFov(lensFov(LENS.default, full.width / full.height).h, full.width / full.height);
  const cloud = buildPointCloud(photo, depth, { hFov, maxPoints: MAX_POINTS });
  const poses = framePoses(input.keys, WORLDCAST_RUN.frames, cloud.depth, hFov, { width: W, height: H });
  const dir = scratchDir();
  const id = nanoid(10);
  const renderFile = path.join(dir, `worldcast-${id}-render.mp4`);
  const maskFile = path.join(dir, `worldcast-${id}-mask.mp4`);
  try {
    const holes: Uint8Array[] = [];
    await encode(renderFile, poses.poses.length, W, H, WORLDCAST_RUN.fps, (i) => {
      const hole = new Uint8Array(W * H * 3);
      const rgb = splatFrame(cloud, poses.poses[i], poses.intrinsic, W, H, undefined, hole);
      holes[i] = hole;
      return rgb;
    });
    await encode(maskFile, poses.poses.length, W, H, WORLDCAST_RUN.fps, (i) => holes[i]);
    const anchors = await Promise.all(
      input.layout.anchors.map(async (_, i) => {
        const pic = input.images[slots.anchor(i)];
        const full = await sizeOf(pic);
        const scale = Math.min(1, ANCHOR_MAX_SIDE / Math.max(full.width, full.height));
        const size = { width: Math.max(1, Math.round(full.width * scale)), height: Math.max(1, Math.round(full.height * scale)) };
        return {
          image: await sharp(pic, { failOn: "none" }).rotate().removeAlpha().resize(size.width, size.height, { fit: "fill" }).png().toBuffer(),
          mask: await binaryMask(input.images[slots.anchorMask(i)], size),
        };
      }),
    );
    const parts = caseParts(
      input.layout,
      poses,
      { firstFrame, personMask, render: fs.readFileSync(renderFile), renderMask: fs.readFileSync(maskFile), anchors },
      { prompt: input.prompt?.trim() || DEFAULT_MOTION, seed: input.seed ?? 42, pivotDepth: cloud.depth, noAlignedCameras: input.alignedCameras === false },
    );
    return { parts, pivotDepth: cloud.depth };
  } finally {
    fs.rmSync(renderFile, { force: true });
    fs.rmSync(maskFile, { force: true });
  }
}
