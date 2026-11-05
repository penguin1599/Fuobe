/**
 * WorldCast behind Fuobe's camera-path buttons (build plan N7-9): Cinema's Fly path, Turnaround / Fly around and the exact
 * orbits (Fuobe DoP, Cinema moves, Image to 3D, Canvas, Assist) plan their open-engine run here when the studio's WorldCast
 * worker answers (docs/workers/worldcast.md), and say what they run on instead when it doesn't.
 *
 * The steps: the still's depth (MoGe 2 by default; the paper's Depth Pro or VGGT-Omega when the worker has them), a SAM 3.1
 * person mask of the still and of each view, then one WorldCast case (oss-worldcast), whose pictures sit where
 * src/lib/worldcast.ts imageSlots says. Pure: the browser prices it, the server runs the same steps.
 */

import type { CameraKey } from "@/lib/camera-path";
import { DEFAULT_MOTION } from "@/lib/camera-path";
import { WORLDCAST_RUN, imageSlots, worldcastLayout } from "@/lib/worldcast";
import type { TurnSide } from "./turnaround";
import type { ChainSlot, GenerationRequest } from "./types";

export const WORLDCAST_MODELS = { film: "oss-worldcast", mask: "oss-person-mask" } as const;

/** What makes the still's depth: MoGe 2 (MIT, pinned, the default), or the paper's own models on the worker. */
export const WORLDCAST_DEPTH = { moge: "oss-scene-moge", "depth-pro": "oss-depth-pro", "vggt-omega": "oss-vggt-omega" } as const;
export type WorldcastDepth = keyof typeof WORLDCAST_DEPTH;
export const DEPTH_NAMES: Record<WorldcastDepth, string> = { moge: "MoGe 2", "depth-pro": "Depth Pro", "vggt-omega": "VGGT-Omega" };

/** WorldCast's clip, in seconds: 81 frames at 15 fps. */
export const WORLDCAST_SECONDS = Math.round((WORLDCAST_RUN.frames / WORLDCAST_RUN.fps) * 10) / 10;

/** Said on the open engine when no WorldCast worker answers, by the run that films instead. */
export function worldcastFallback(on: "Uni3C" | "Frames"): string {
  return `Runs on ${on}: add a WorldCast worker (48 GB+) for sides that match your photos`;
}

/** What WorldCast's run says about itself. */
export function worldcastNote(views: number, depth: WorldcastDepth = "moge"): string {
  const sides = views ? `the back and sides follow your ${views} view${views === 1 ? "" : "s"}` : "it films from the still alone (add views of the other sides so they match)";
  return `${DEPTH_NAMES[depth]} measures the still's depth and SAM 3.1 finds the person, then WorldCast films the path on your WorldCast worker: ${sides} — portrait 480 × 832, ${WORLDCAST_RUN.frames} frames at ${WORLDCAST_RUN.fps} fps (${WORLDCAST_SECONDS} s)`;
}

/** Said after the run: what else the clip can go through. */
export const WORLDCAST_AFTER = "Upscale, under the finished clip, opens it in Upscale: FPS Boost (RIFE) takes it to 24 fps and the upscalers enlarge it";

/** A picture of the run: a file, or what an earlier step makes. */
export type WorldcastSource = { url: string } | { key: string };

export interface WorldcastInput {
  feature: string;
  /** Where the depth and mask steps are filed (default: `feature`). */
  stepFeature?: string;
  title?: string;
  /** The first frame. */
  still?: WorldcastSource;
  /** The views of the subject, by the person's own side (the front is usually the still itself). */
  anchors: { side: TurnSide; src: WorldcastSource }[];
  keys: CameraKey[];
  prompt?: string;
  seed?: number;
  depth?: WorldcastDepth;
  /** Leave the anchors' ring cameras out (anchors_aligned_camera_info.json). */
  alignedCameras?: boolean;
}

export interface WorldcastStep {
  key: string;
  request: GenerationRequest;
  after?: string[];
}

/** One request's pictures in slot order: its own files, and the chain slots (with `at`) for what earlier steps make. */
function gather(list: WorldcastSource[]) {
  const images: string[] = [];
  const chain: ChainSlot[] = [];
  const after: string[] = [];
  list.forEach((src, i) => {
    if ("url" in src) images.push(src.url);
    else {
      chain.push({ slot: "images", at: i });
      after.push(src.key);
    }
  });
  return { images, chain, after };
}

const one = (src: WorldcastSource): Pick<WorldcastStep, "after"> & { request: Pick<GenerationRequest, "inputs" | "chain"> } =>
  "url" in src ? { request: { inputs: { images: [src.url] } } } : { request: { chain: [{ slot: "images" }] }, after: [src.key] };

/** The steps of a WorldCast run, film last (key "main"); numbered as one run. */
export function worldcastSteps(input: WorldcastInput): WorldcastStep[] {
  const still = input.still ?? { url: "/api/files/placeholder.png" };
  // WorldCast's "front" anchor is the first frame's own camera (the demo's body_views_meta: front = source frame 0). Without a
  // body view the pipeline drops every anchor, the first frame's included, which the released checkpoint never ran: so the
  // still is always the front's anchor when no front view is given.
  const given = input.anchors.some((a) => a.side === "front") ? input.anchors : [{ side: "front" as const, src: still }, ...input.anchors];
  const layout = worldcastLayout(given.map((a) => a.side));
  const anchors = layout.anchors.map((a) => given.find((x) => x.side === a.side)!.src);
  const stepFeature = input.stepFeature ?? input.feature;
  const depth = input.depth ?? "moge";
  const steps: WorldcastStep[] = [];
  const pre = (key: string, src: WorldcastSource, request: Omit<GenerationRequest, "inputs" | "chain">): WorldcastStep => {
    const o = one(src);
    return { key, request: { ...request, ...o.request }, ...(o.after && { after: o.after }) };
  };
  steps.push(
    depth === "moge"
      ? pre("depth", still, { feature: stepFeature, modelId: WORLDCAST_DEPTH.moge, op: "scene-3d", prompt: "", params: { numOutputs: 1, extra: { decimation: 4 } } })
      : pre("depth", still, { feature: stepFeature, modelId: WORLDCAST_DEPTH[depth], op: "edit", prompt: "", params: { numOutputs: 1 } }),
  );
  steps.push(pre("mask-still", still, { feature: stepFeature, modelId: WORLDCAST_MODELS.mask, op: "bg-remove", prompt: "person", params: { numOutputs: 1 } }));
  layout.anchors.forEach((a, i) => steps.push(pre(`mask-${a.view}`, anchors[i], { feature: stepFeature, modelId: WORLDCAST_MODELS.mask, op: "bg-remove", prompt: "person", params: { numOutputs: 1 } })));
  const slots = imageSlots(layout);
  const order: WorldcastSource[] = new Array(slots.total);
  order[slots.still] = still;
  anchors.forEach((src, i) => (order[slots.anchor(i)] = src));
  order[slots.stillMask] = { key: "mask-still" };
  layout.anchors.forEach((a, i) => (order[slots.anchorMask(i)] = { key: `mask-${a.view}` }));
  order[slots.depth] = { key: "depth" };
  const { images, chain, after } = gather(order);
  steps.push({
    key: "main",
    request: {
      feature: input.feature,
      modelId: WORLDCAST_MODELS.film,
      op: "camera-path",
      prompt: input.prompt?.trim() || DEFAULT_MOTION,
      ...(input.title && { title: input.title }),
      ...(images.length && { inputs: { images } }),
      chain,
      params: {
        numOutputs: 1,
        aspectRatio: "9:16",
        cameraPath: input.keys,
        ...(input.seed !== undefined && { seed: input.seed }),
        extra: { worldcast: layout, ...(input.alignedCameras === false && { alignedCameras: false }) },
      },
    },
    after,
  });
  const labels: Record<string, string> = { depth: `Depth of the still (${DEPTH_NAMES[depth]})`, "mask-still": "The person in the still", main: "Film along the path (WorldCast)" };
  steps.forEach((s, i) => (s.request.step = { label: labels[s.key] ?? `The person in the ${s.key.slice(5).replace("_", " ")} view`, index: i, of: steps.length }));
  return steps;
}
