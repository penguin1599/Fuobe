import "server-only";
import { nanoid } from "nanoid";
import { z } from "zod";
import { DISTANCE, MAX_KEYS } from "@/lib/camera-path";
import { EXACT_LIMITS } from "@/lib/exact-orbit";
import { FLY_VIEWS_MAX, planFlyAround, type FlyAroundInput, type FlyAroundPlan, type FlyStep } from "@/lib/catalog/fly-around";
import type { Generation, GenerationRequest } from "@/lib/catalog/types";
import { cancelGeneration, createGenerations, previewChained, previewGeneration } from "./generations";
import { isOffered } from "./model-access";
import { worldcastDepths } from "./worldcast";
import { worldcastContext } from "./worldcast-on";

/**
 * Fly around: the plan from src/lib/catalog/fly-around.ts, checked step by step on this install (keys,
 * demo mode, Settings → Models & licences, the engine mode) and run as one batch. Fuobe DoP's exact orbits, Image to 3D's
 * "Film it photoreal", Canvas's Fly around node and Assist's fly_around tool call it (/api/fly-around).
 */

const FileRef = z.string().startsWith("/api/files/").max(500);

export const CameraKeySchema = z.object({
  t: z.number().min(0).max(1),
  azimuth: z.number().min(-360 * 32).max(360 * 32),
  elevation: z.number().min(-90).max(90),
  distance: z.number().min(DISTANCE.min).max(DISTANCE.max),
  truck: z.number().min(-4).max(4).optional(),
});

export const ExactOrbitSchema = z.object({
  degrees: z.number().min(EXACT_LIMITS.degrees.min).max(EXACT_LIMITS.degrees.max),
  direction: z.enum(["cw", "ccw"]),
  tilt: z.number().min(EXACT_LIMITS.tilt.min).max(EXACT_LIMITS.tilt.max).default(0),
  pulse: z.number().min(0).max(0.25).default(0),
});

/** What /api/fly-around takes. */
export const FlyAroundSchema = z.object({
  engine: z.enum(["cloud", "open"]),
  image: FileRef.optional(),
  views: z.array(FileRef).max(FLY_VIEWS_MAX).optional(),
  orbit: ExactOrbitSchema.optional(),
  preset: z.string().max(40).optional(),
  keys: z.array(CameraKeySchema).min(1).max(MAX_KEYS).optional(),
  render: FileRef.optional(),
  prompt: z.string().max(1500).optional(),
  duration: z.number().min(1).max(15).optional(),
  resolution: z.string().max(10).optional(),
  /** Where the run is filed: the studio's feed it starts from (default "fly-around"). */
  feature: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
    .optional(),
  title: z.string().max(80).optional(),
  seed: z.number().int().min(0).max(4_294_967_295).optional(),
  /** Views by the person's own side: WorldCast's anchors on the open engine (N7-9). */
  sides: z.object({ front: FileRef.optional(), right: FileRef.optional(), back: FileRef.optional(), left: FileRef.optional() }).optional(),
  /** WorldCast's depth model: MoGe 2 (default), or Depth Pro / VGGT-Omega on the worker. */
  depth: z.enum(["moge", "depth-pro", "vggt-omega"]).optional(),
  requestId: z.string().max(80).optional(),
});

export class FlyAroundError extends Error {
  constructor(
    message: string,
    public status = 422,
  ) {
    super(message);
  }
}

export interface FlyAroundPreview {
  engine: FlyAroundPlan["engine"];
  model: { id: string; name: string };
  label: string;
  keys: FlyAroundPlan["keys"];
  duration: number;
  steps: number;
  notes: string[];
  blocker?: string;
  costUsd: number | null;
  demo: boolean;
}

/** The plan as this install runs it: a model switched off in Settings → Models & licences is a blocker. */
function plan(input: FlyAroundInput): FlyAroundPlan {
  const p = planFlyAround(input, { worldcast: worldcastContext() });
  // Depth Pro and VGGT-Omega run on the worker only when it has them installed (its GET /health lists them).
  if (p.model.id === "oss-worldcast" && input.depth && input.depth !== "moge" && !worldcastDepths().includes(input.depth) && !p.blocker) {
    return { ...p, blocker: `Your WorldCast worker doesn't have ${input.depth === "depth-pro" ? "Depth Pro" : "VGGT-Omega"} installed: use MoGe 2, or add it to the worker` };
  }
  const off = p.steps.find((s) => !isOffered(s.request.modelId));
  return off && !p.blocker ? { ...p, blocker: "This move is switched off on this studio" } : p;
}

/** The run as the server would make it, priced, without running it. */
export function previewFlyAround(input: FlyAroundInput): FlyAroundPreview {
  const p = plan(input);
  let blocker = p.blocker;
  let cost: number | null = p.costUsd;
  let demo = false;
  const notes = [...p.notes];
  if (!blocker) {
    cost = 0;
    try {
      for (const s of p.steps) {
        const r = s.after?.length ? previewChained(s.request, s.after.length) : previewGeneration(s.request);
        demo ||= r.demo;
        cost = r.costUsd === null || cost === null ? null : cost + r.costUsd;
        for (const n of r.notes ?? []) if (!notes.includes(n)) notes.push(n);
      }
    } catch (e) {
      blocker = (e as Error).message;
      cost = p.costUsd;
    }
  }
  return {
    engine: p.engine,
    model: { id: p.model.id, name: p.model.name },
    label: p.label,
    keys: p.keys,
    duration: p.duration,
    steps: p.steps.length,
    notes,
    ...(blocker && { blocker }),
    costUsd: demo ? 0 : cost === null ? null : Math.round(cost * 1000) / 1000,
    demo,
  };
}

/** Run the steps in order as one batch (each waits for the steps it names). The film first. */
export function runFlySteps(steps: FlyStep[], batchId = nanoid(10)): Generation[] {
  const made: Record<string, Generation[]> = {};
  const all: Generation[] = [];
  try {
    for (const s of steps) {
      const deps = s.after?.map((k) => made[k]?.[0]?.id).filter((x): x is string => !!x) ?? [];
      const created = createGenerations(s.request, { batchId, ...(deps.length && { dependsOn: deps }) });
      made[s.key] = created;
      all.push(...created);
    }
  } catch (e) {
    for (const g of all) void cancelGeneration(g.id);
    throw new FlyAroundError((e as Error).message);
  }
  const film = made.main?.[0];
  return film ? [film, ...all.filter((g) => g.id !== film.id)] : all;
}

export interface FlyAroundResult {
  final: Generation;
  items: Generation[];
  batchId: string;
  plan: FlyAroundPreview;
}

/** Plan, check every step, then run them. */
export function createFlyAround(input: FlyAroundInput): FlyAroundResult {
  return startFlyAround(planFlyAroundRun(input));
}

/** A planned fly-around: its steps and its priced preview. Nothing is created yet. */
export interface FlyAroundRun {
  steps: FlyStep[];
  preview: FlyAroundPreview;
}

/** Plan and check every step (nothing is created); a blocker is a FlyAroundError. */
export function planFlyAroundRun(input: FlyAroundInput): FlyAroundRun {
  const preview = previewFlyAround(input);
  if (preview.blocker) throw new FlyAroundError(preview.blocker);
  return { steps: plan(input).steps, preview };
}

/** A planned fly-around's steps as the requests they make, with how many earlier steps each waits for (account-tool-run.ts). */
export const flyAroundSteps = (r: FlyAroundRun): { request: GenerationRequest; deps: number }[] => r.steps.map((s) => ({ request: s.request, deps: s.after?.length ?? 0 }));

/** Start a planned fly-around as one batch, the film first. */
export function startFlyAround(r: FlyAroundRun): FlyAroundResult {
  const batchId = nanoid(10);
  const items = runFlySteps(r.steps, batchId);
  return { final: items[0], items, batchId, plan: r.preview };
}
