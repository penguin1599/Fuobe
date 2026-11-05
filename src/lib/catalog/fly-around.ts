/**
 * Fly around (research new-models-7.md §3.10 rows 3-5): a still filmed along an exact camera path, with no
 * browser view of its scene. Fuobe DoP's and Cinema's exact orbits, Image to 3D's "Film it photoreal", Canvas's "Fly
 * around" node and Assist's fly_around tool all plan through here, on Fly path's models:
 *
 * - Open engine: MoGe 2 (oss-scene-moge) makes the still's depth, the server renders the path through that depth as a point
 *   cloud (src/server/path-render.ts, ChainSlot.render "path"), and Wan 2.1 + Uni3C (oss-uni3c-path) films the still along
 *   it. With a render already made (Image to 3D records its model along the path in the browser), the depth step is skipped.
 * - Cloud: H3 Max camera-controls with the path as its keyframes. With reference views (Canvas "Fly around" with views),
 *   MiniMax H3 Max reference-to-video takes the still and the views, and the path goes in words (the References route).
 *
 * Pure: the browser prices it, the server runs the same steps (src/server/fly-around.ts).
 */

import { DEFAULT_MOTION, MAX_KEYS, PATH_FPS, PATH_FRAMES, PATH_PRESETS, normalizeKeys, presetKeys, toH3MaxTrajectory, type CameraKey } from "@/lib/camera-path";
import { exactOrbitKeys, exactSummary, exactWords, type ExactOrbit } from "@/lib/exact-orbit";
import { getModel, getPreset } from "./index";
import { onEngine } from "./engines";
import { estimateCost, planGeneration } from "./plan";
import type { TurnSide } from "./turnaround";
import type { Engine, GenerationRequest, GenParams, ModelDef } from "./types";
import { WORLDCAST_AFTER, WORLDCAST_MODELS, WORLDCAST_SECONDS, worldcastFallback, worldcastNote, worldcastSteps, type WorldcastDepth } from "./worldcast-plan";

/** What films a path on each engine , what makes the depth on the open engine, and the cloud's route with views. */
export const FLY_MODELS = { open: "oss-uni3c-path", cloud: "minimax-h3-max-camera", depth: "oss-scene-moge", views: "minimax-h3-max" } as const;
/** The cloud's lengths; the open engine always makes 81 frames at 16 fps (about 5 s). */
export const FLY_DURATIONS = [3, 5, 8, 10, 15];
export const FLY_VIEWS_MAX = 8;
/** MoGe's scene for a render only needs its depth picture: a lighter mesh. */
const DEPTH_DECIMATION = 4;

export interface FlyAroundInput {
  engine: Engine;
  /** The still to film (the first frame). */
  image?: string;
  /** Other views of the subject (cloud: references; the open engine films from the still alone). */
  views?: string[];
  /** The path: an exact orbit, a preset id (camera-path PATH_PRESETS, orbit_<N>_cw…) or keys. The first that is given wins. */
  orbit?: Partial<ExactOrbit>;
  preset?: string;
  keys?: CameraKey[];
  /** A render of the path made already (Image to 3D's model recorded in the browser): the open engine's guide. */
  render?: string;
  prompt?: string;
  duration?: number;
  resolution?: string;
  feature?: string;
  title?: string;
  seed?: number;
  /** Views by the person's own side (Canvas's Fly around with named views): WorldCast's anchors on the open engine. */
  sides?: Partial<Record<TurnSide, string>>;
  /** WorldCast's depth model (default MoGe 2). */
  depth?: WorldcastDepth;
}

/** What the planner knows about this install: whether its WorldCast worker answers and WorldCast is switched on. */
export interface FlyContext {
  worldcast?: boolean;
}

export interface FlyStep {
  key: string;
  request: GenerationRequest;
  after?: string[];
}

export interface FlyAroundPlan {
  engine: Engine;
  model: ModelDef;
  keys: CameraKey[];
  /** The path in words, for the result's caption ("360° counter-clockwise · level"). */
  label: string;
  steps: FlyStep[];
  notes: string[];
  blocker?: string;
  costUsd: number | null;
  /** Seconds of film. */
  duration: number;
}

/** The keys a request asks for: an orbit's numbers, a preset or keys, from the photo's pose. Empty when none is given. */
export function flyKeys(input: Pick<FlyAroundInput, "orbit" | "preset" | "keys">): { keys: CameraKey[]; label: string } {
  if (input.orbit) return { keys: exactOrbitKeys(input.orbit), label: exactSummary(input.orbit) };
  const fromPreset = input.preset ? presetKeys(input.preset) : null;
  if (fromPreset) return { keys: fromPreset, label: input.preset!.replace(/_/g, " ") };
  const keys = input.keys?.length ? normalizeKeys(input.keys).slice(0, MAX_KEYS) : [];
  return { keys, label: keys.length > 1 ? `${keys.length} keyframes` : "" };
}

const tidy = (p: string | undefined) => (p ?? "").trim();

/** The path in words, for a model that turns the camera from words (H3 Max reference-to-video): the orbit's numbers or the move. */
export function pathWords(input: Pick<FlyAroundInput, "orbit" | "preset">): string {
  if (input.orbit) return exactWords(input.orbit);
  const move = input.preset && PATH_PRESETS.find((p) => p.id === input.preset);
  if (move) return `The camera moves: ${move.name}, ${move.description.charAt(0).toLowerCase()}${move.description.slice(1)}`;
  const sweep = input.preset && /^orbit_(\d+(?:\.\d+)?)(?:_(cw|ccw))?$/.exec(input.preset);
  if (sweep) return exactWords({ degrees: Number(sweep[1]), direction: sweep[2] === "cw" ? "cw" : "ccw" });
  return "The camera flies around the subject";
}

function stepCost(req: GenerationRequest, engine: Engine): number | null {
  const lookup = (id: string) => {
    const m = getModel(id);
    return m && onEngine(m, engine);
  };
  // Chained inputs are priced with stand-ins (the render a step makes first).
  const filled: GenerationRequest = req.chain?.some((c) => c.slot === "video") ? { ...req, inputs: { ...req.inputs, video: "/api/files/placeholder.mp4" } } : req;
  const p = planGeneration(filled, lookup, getPreset);
  return estimateCost(p.model, p.params, 1, p.op);
}

/** Plan a fly-around: the steps each engine runs, priced (free on the open engine), and what it still needs. */
export function planFlyAround(input: FlyAroundInput, ctx: FlyContext = {}): FlyAroundPlan {
  const { engine } = input;
  const feature = input.feature ?? "fly-around";
  const { keys, label } = flyKeys(input);
  const views = (input.views ?? []).filter(Boolean).slice(0, FLY_VIEWS_MAX);
  const notes: string[] = [];
  const seed = input.seed !== undefined ? { seed: input.seed } : {};
  const title = input.title ? { title: input.title } : {};
  const steps: FlyStep[] = [];
  let model: ModelDef;
  let duration: number;
  const image = input.image;
  if (engine === "open" && ctx.worldcast) {
    // N7-9: WorldCast on the studio's worker; the still is the first frame and, when the views are named, the front's anchor.
    model = getModel(WORLDCAST_MODELS.film)!;
    duration = WORLDCAST_SECONDS;
    const sides = (Object.entries(input.sides ?? {}) as [TurnSide, string][]).filter(([, url]) => !!url).map(([side, url]) => ({ side, src: { url } }));
    steps.push(
      ...worldcastSteps({ feature, title: input.title, still: image ? { url: image } : undefined, anchors: sides, keys, prompt: input.prompt, seed: input.seed, depth: input.depth }),
    );
    notes.push(worldcastNote(sides.length, input.depth), WORLDCAST_AFTER);
    if (views.length && !sides.length) notes.push("WorldCast needs to know which side each view shows: name them to use them");
  } else if (engine === "open") {
    model = getModel(FLY_MODELS.open)!;
    duration = Math.round((PATH_FRAMES / PATH_FPS) * 10) / 10;
    const resolution = model.options.resolutions?.find((r) => r.toLowerCase() === input.resolution?.toLowerCase()) ?? "480p";
    const params: GenParams = { numOutputs: 1, aspectRatio: "auto", resolution, cameraPath: keys, ...seed };
    const prompt = tidy(input.prompt) || DEFAULT_MOTION;
    if (input.render) {
      notes.push(`Wan 2.1 starts from the still and Uni3C keeps its camera on your render of the path — ${PATH_FRAMES} frames at ${PATH_FPS} fps (${duration} s) on your GPU`);
      steps.push({ key: "main", request: { feature, modelId: model.id, op: "camera-path", prompt, ...title, inputs: image ? { images: [image], video: input.render } : undefined, params } });
    } else {
      const depth = getModel(FLY_MODELS.depth)!;
      notes.push(
        `MoGe 2 measures the still's depth, the studio renders the path through it, then Wan 2.1 films the still along that render with Uni3C — ${PATH_FRAMES} frames at ${PATH_FPS} fps (${duration} s) on your GPU, which needs about 48 GB`,
      );
      steps.push({
        key: "depth",
        request: { feature, modelId: depth.id, op: "scene-3d", prompt: "", inputs: image ? { images: [image] } : undefined, params: { numOutputs: 1, extra: { decimation: DEPTH_DECIMATION } }, step: { label: "Depth of the still", index: 0, of: 2 } },
      });
      steps.push({
        key: "main",
        request: { feature, modelId: model.id, op: "camera-path", prompt, ...title, inputs: image ? { images: [image] } : undefined, chain: [{ slot: "video", render: "path" }], params, step: { label: "Film along the path", index: 1, of: 2 } },
        after: ["depth"],
      });
    }
    if (views.length) notes.push("Your other views aren't used on your GPU: it films from the still alone");
    if (ctx.worldcast === false) notes.push(worldcastFallback("Uni3C"));
  } else if (views.length) {
    model = getModel(FLY_MODELS.views)!;
    duration = nearest(model.options.durations ?? FLY_DURATIONS, input.duration ?? 5);
    const resolution = model.options.resolutions?.find((r) => r.toLowerCase() === input.resolution?.toLowerCase()) ?? model.defaults?.resolution;
    const max = model.options.maxImages ?? 9;
    const images = image ? [image, ...views].slice(0, max) : views.slice(0, max);
    if (1 + views.length > max) notes.push(`${model.name} takes up to ${max} pictures: the rest are left out`);
    const words = pathWords(input);
    steps.push({
      key: "main",
      request: {
        feature,
        modelId: model.id,
        op: "ref2v",
        prompt: `${words}. Image 1 is the first frame; the other images show the same subject from other sides. ${tidy(input.prompt) || DEFAULT_MOTION}`,
        ...title,
        inputs: { images },
        params: { numOutputs: 1, duration, ...(resolution ? { resolution } : {}), ...seed },
      },
    });
    notes.push(`${model.name} takes the still and your ${views.length} view${views.length === 1 ? "" : "s"} as references and turns the camera from the words: the sides hold, the path is loose`);
  } else {
    model = getModel(FLY_MODELS.cloud)!;
    const range = model.routes[0]?.map?.ranges?.duration;
    duration = Math.min(range?.max ?? 15, Math.max(Math.max(1, range?.min ?? 1), Math.round((input.duration ?? 5) * 10) / 10));
    const resolution = model.options.resolutions?.find((r) => r.toLowerCase() === input.resolution?.toLowerCase()) ?? model.defaults?.resolution;
    if (keys.length > 1) {
      const cam = toH3MaxTrajectory(keys);
      notes.push("trajectory" in cam ? `H3 Max follows the ${cam.trajectory.length} keyframes from the still, with prompt expansion off` : cam.notes[0]);
      if ("trajectory" in cam) notes.push(...cam.notes);
    }
    steps.push({
      key: "main",
      request: { feature, modelId: model.id, op: "camera-path", prompt: tidy(input.prompt) || DEFAULT_MOTION, ...title, inputs: image ? { images: [image] } : undefined, params: { numOutputs: 1, duration, ...(resolution ? { resolution } : {}), cameraPath: keys, ...seed } },
    });
  }
  let blocker = !image ? "Add the still to film" : keys.length < 2 && !(engine === "cloud" && views.length) ? "Pick a path first" : undefined;
  let cost: number | null = 0;
  for (const s of steps) {
    try {
      const priced: GenerationRequest = s.request.inputs?.images?.length ? s.request : { ...s.request, inputs: { ...s.request.inputs, images: ["/api/files/placeholder.png"] } };
      const c = stepCost(priced, engine);
      cost = c === null || cost === null ? null : cost + c;
    } catch (e) {
      blocker ??= (e as Error).message;
    }
  }
  return { engine, model, keys, label, steps, notes, ...(blocker && { blocker }), costUsd: cost === null ? null : Math.round(cost * 1000) / 1000, duration };
}

function nearest(list: number[], n: number): number {
  return list.reduce((best, x) => (Math.abs(x - n) < Math.abs(best - n) ? x : best), list[0] ?? n);
}
