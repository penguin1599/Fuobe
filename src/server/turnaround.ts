import "server-only";
import { nanoid } from "nanoid";
import { z } from "zod";
import { getModel } from "@/lib/catalog";
import { routesFor } from "@/lib/catalog/plan";
import { planTurnaround, routeOfModel, type TurnaroundContext, type TurnaroundInput, type TurnaroundPlan, type TurnaroundPreview, type TurnStep } from "@/lib/catalog/turnaround";
import type { Generation, GenerationRequest } from "@/lib/catalog/types";
import { needsConsent } from "@/lib/catalog/training";
import { getElement } from "./elements";
import { cancelGeneration, createGenerations, previewChained, previewGeneration } from "./generations";
import { isOffered } from "./model-access";
import { worldcastContext } from "./worldcast-on";
import { loadManifest } from "./providers/comfyui";
import { consentOnFile } from "./training";

/**
 * Turnaround video (build plan N7-6): the plan from src/lib/catalog/turnaround.ts, checked step by step on this install
 * (keys, demo mode, Settings → Models & licences, the engine mode) and run as one batch. The Character Sheet page and a
 * character's page call it through /api/turnaround; Cinema runs the same steps as its "turnaround" action.
 */

const FileRef = z.string().startsWith("/api/files/").max(300);

/** A turnaround as API clients send it (the Character Sheet page, a character's page, Cinema's Soul Cast, the eval harness). */
export const TurnaroundSchema = z.object({
  engine: z.enum(["cloud", "open"]),
  views: z.object({ front: FileRef.optional(), right: FileRef.optional(), back: FileRef.optional(), left: FileRef.optional() }).default({}),
  sheet: FileRef.optional(),
  route: z.enum(["worldcast", "frames", "references", "keyframes", "camera", "stills"]).optional(),
  fill: z.boolean().optional(),
  fillWith: z.enum(["angles", "qma"]).optional(),
  path: z.string().max(40).optional(),
  duration: z.number().min(1).max(30).optional(),
  aspectRatio: z.enum(["9:16", "16:9"]).optional(),
  prompt: z.string().max(1000).optional(),
  name: z.string().max(60).optional(),
  seed: z.number().int().min(0).max(4_294_967_295).optional(),
  realPerson: z.boolean().optional(),
  consent: z.boolean().optional(),
});

/** What /api/turnaround and its estimate take: the turnaround, the character it's for, the model named instead of a route. */
export const TurnaroundBodySchema = TurnaroundSchema.extend({
  /** Made from a character's page: the film goes into that character's feed. */
  elementId: z.string().max(40).optional(),
  /** The model to film it with (the evaluation harness names models): its route, when this engine has one for it. */
  modelId: z.string().max(80).optional(),
  /** A repeated requestId (a second click) gets the run the first one started. */
  requestId: z.string().max(80).optional(),
});

/**
 * A request body as the server runs it: a character's run filed in its feed, a named model's route. A character is a
 * person whatever the client says (Soul ID's rule, needsConsent): its run needs the consent line, unless the character
 * was trained with it confirmed (the training's consentAt).
 */
export function turnaroundRun({ elementId, modelId, ...input }: Omit<z.infer<typeof TurnaroundBodySchema>, "requestId">): TurnaroundRequest {
  const route = input.route ?? routeOfModel(input.engine, modelId);
  const el = elementId ? getElement(elementId) : null;
  const person = !!el && needsConsent(el.kind);
  const onFile = person ? consentOnFile(el.id) : undefined;
  return {
    ...input,
    ...(route && { route }),
    ...(elementId && { feature: `element:${elementId}` }),
    ...(person && { realPerson: true }),
    ...(onFile !== undefined && { consentOnFile: onFile }),
  };
}

export class TurnaroundError extends Error {
  constructor(
    message: string,
    public status = 422,
  ) {
    super(message);
  }
}

export interface TurnaroundRequest extends TurnaroundInput {
  /** The pictures show a real person (not one Fuobe made): Soul ID's consent line must be confirmed. */
  realPerson?: boolean;
  consent?: boolean;
  /** Server-set (never from the body): when the character's consent was confirmed for its Soul ID training. */
  consentOnFile?: number;
}

/** What this install offers (Settings → Models & licences). */
export function turnaroundContext(): TurnaroundContext {
  return { has: (id) => !!getModel(id) && isOffered(id), worldcast: worldcastContext() };
}

/** Said when a real person's pictures go without the consent line (Soul ID's, src/lib/catalog/training.ts). */
export const NEEDS_CONSENT = "Confirm the consent line first: a real person is only filmed with their permission";

type Check = { costUsd: number | null; demo: boolean; notes: string[] };

/** Check and price each step as the runner will run it: a step that can't run stops the whole run before anything starts. */
function checkSteps(plan: TurnaroundPlan): Check {
  let cost: number | null = 0;
  let demo = false;
  const notes: string[] = [];
  for (const s of plan.steps) {
    let p: ReturnType<typeof previewGeneration>;
    try {
      p = s.after?.length ? previewChained(s.request, s.after.length) : previewGeneration(s.request);
    } catch (e) {
      throw new TurnaroundError((e as Error).message);
    }
    demo ||= p.demo;
    cost = p.costUsd === null || cost === null ? null : cost + p.costUsd;
    for (const n of p.notes ?? []) if (!notes.includes(n)) notes.push(n);
  }
  return { costUsd: cost === null ? null : Math.round(cost * 1000) / 1000, demo, notes };
}

/** The most VRAM any open step's ComfyUI graph needs (the manifest's figure), for the "on your GPU" line. */
function gpuGb(plan: TurnaroundPlan): number | undefined {
  if (plan.engine !== "open") return undefined;
  const flows = loadManifest().workflows;
  let most: number | undefined;
  for (const s of plan.steps) {
    const m = getModel(s.request.modelId);
    // WorldCast's worker: 48 GB or more (its README and model card).
    if (m?.routes.some((r) => r.provider === "worldcast")) most = Math.max(most ?? 0, 48);
    const route = m && routesFor(m, s.request.op ?? "edit").find((r) => r.provider === "comfyui");
    const gb = route && flows.find((w) => w.id === route.endpoint)?.vramGb;
    if (typeof gb === "number") most = Math.max(most ?? 0, gb);
  }
  return most;
}


/** The run as the server would make it, priced, without running it. */
export function previewTurnaround(input: TurnaroundRequest): TurnaroundPreview {
  const plan = planTurnaround(input, turnaroundContext());
  let check: Check = { costUsd: plan.costUsd, demo: false, notes: [] };
  let blocker = plan.blocker;
  if (!blocker) {
    try {
      check = checkSteps(plan);
    } catch (e) {
      blocker = (e as Error).message;
    }
  }
  if (!blocker && input.realPerson && !input.consent && input.consentOnFile === undefined) blocker = NEEDS_CONSENT;
  return {
    route: plan.route,
    routes: plan.routes,
    model: { id: plan.model.id, name: plan.model.name },
    duration: plan.duration,
    durations: plan.durations,
    frames: plan.frames,
    fills: plan.fills,
    frontFromSheet: plan.frontFromSheet,
    fill: plan.fill,
    steps: plan.steps.length,
    notes: [...plan.notes, ...check.notes.filter((n) => !plan.notes.includes(n))],
    ...(blocker && { blocker }),
    ...(input.realPerson && { consent: input.consentOnFile !== undefined ? ("on-file" as const) : ("asked" as const) }),
    costUsd: check.demo ? 0 : check.costUsd,
    demo: check.demo,
    ...(gpuGb(plan) !== undefined && { gpuGb: gpuGb(plan) }),
  };
}

/**
 * Run a plan's steps in order as one batch: each waits for the steps it names (their outputs go into its chain slots).
 * Returns every generation made, the film first. Steps already made are canceled when a later one can't be.
 */
export function runTurnaroundSteps(steps: TurnStep[], batchId = nanoid(10)): Generation[] {
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
    throw new TurnaroundError((e as Error).message);
  }
  const film = made.main?.[0];
  return film ? [film, ...all.filter((g) => g.id !== film.id)] : all;
}

export interface TurnaroundResult {
  /** The finished turnaround's generation (the film, or the one clip): what the studio routes' `final` names, so the
   * evaluation harness measures the film, not the last step made. */
  final: Generation;
  items: Generation[];
  filmId: string;
  batchId: string;
  plan: TurnaroundPreview;
}

/**
 * Plan, check every step, then run them. A real person's pictures need the consent line: every step's request records
 * when it was confirmed (GenerationRequest.consentAt; the training's time for a character trained with it).
 */
export function createTurnaround(input: TurnaroundRequest): TurnaroundResult {
  return startTurnaround(planTurnaroundRun(input));
}

/** A planned turnaround: its steps (consent recorded) and its priced preview. Nothing is created yet. */
export interface TurnaroundRun {
  steps: TurnStep[];
  preview: TurnaroundPreview;
}

/** Plan and check every step (nothing is created); a blocker is a TurnaroundError. */
export function planTurnaroundRun(input: TurnaroundRequest): TurnaroundRun {
  const preview = previewTurnaround(input);
  if (preview.blocker) throw new TurnaroundError(preview.blocker);
  const plan = planTurnaround(input, turnaroundContext());
  if (input.realPerson) {
    const consentAt = input.consent ? Date.now() : input.consentOnFile;
    for (const s of plan.steps) s.request.consentAt = consentAt;
  }
  return { steps: plan.steps, preview };
}

/** A planned turnaround's steps as the requests they make, with how many earlier steps each waits for (account-tool-run.ts). */
export const turnaroundSteps = (r: TurnaroundRun): { request: GenerationRequest; deps: number }[] => r.steps.map((s) => ({ request: s.request, deps: s.after?.length ?? 0 }));

/** Start a planned turnaround as one batch, the film first. */
export function startTurnaround(r: TurnaroundRun): TurnaroundResult {
  const batchId = nanoid(10);
  const items = runTurnaroundSteps(r.steps, batchId);
  return { final: items[0], items, filmId: items[0].id, batchId, plan: r.preview };
}
