import "server-only";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { PlannedJob } from "@/lib/assist";
import { finalKey, KATANA_FEATURE, KATANA_LIMITS, katanaSteps, katanaStage, motionModel, MOTION_MODELS, planSegments, currentMotionModel, stepsToRedo, type KatanaInput, type KatanaJob, type KatanaJobView, type KatanaStep, type Segment } from "@/lib/av/katana";
import { getModel } from "@/lib/catalog";
import type { Engine, Generation, GenerationRequest } from "@/lib/catalog/types";
import { ACCOUNT_PROJECT_LIMITS, createAccountProject, deleteAccountProject, getAccountProject, listAccountProjects, updateAccountProject, type AccountProject } from "./account-projects";
import { createPipeline } from "./chains";
import { db } from "./db";
import { cancelGeneration, createGenerations, getGeneration, previewChained } from "./generations";
import { firstOn } from "./model-access";
import { engineMode } from "./settings";
import { ShortsError } from "./shorts";
import { storedMedia } from "./storage";
import { tenantAccount } from "./tenant";

/**
 * Katana jobs: a reference edit rebuilt with your subject (src/lib/av/katana.ts plans it). The steps
 * are chained generations in one batch; the job row keeps what was asked and which generation makes
 * each step, so the studio and Assist can follow it.
 *
 * The owner's jobs are rows of katana_jobs. A signed-in account's (public sign-up) are its own projects of kind "katana"
 * (account-projects.ts), read and changed only inside its own work (asAccount): another account's job, or the owner's,
 * reads as not found, and the owner's list never has an account's. They go when the account is deleted.
 */

/** An account's jobs, in the account project store. */
const KIND = "katana";

/** What an account's job keeps: the job without its id and times (the project row has them). */
type KatanaData = Omit<KatanaJob, "id" | "createdAt" | "updatedAt">;

const fromProject = (p: AccountProject<KatanaData>): KatanaJob => ({ ...p.data, id: p.id, createdAt: p.createdAt, updatedAt: p.updatedAt });

interface Row {
  id: string;
  data_json: string;
  created_at: number;
  updated_at: number;
}

const toJob = (r: Row): KatanaJob => ({ ...(JSON.parse(r.data_json) as Omit<KatanaJob, "id" | "createdAt" | "updatedAt">), id: r.id, createdAt: r.created_at, updatedAt: r.updated_at });

function view(j: KatanaJob): KatanaJobView {
  const generations: Record<string, Generation> = {};
  for (const id of Object.values(j.steps)) {
    const g = getGeneration(id, { includeDeleted: true });
    if (g) generations[id] = g;
  }
  return { ...j, generations };
}

export function getKatana(id: string): KatanaJobView | null {
  const account = tenantAccount();
  if (account) {
    const p = getAccountProject<KatanaData>(account, KIND, id);
    return p ? view(fromProject(p)) : null;
  }
  const r = db().prepare("SELECT * FROM katana_jobs WHERE id = ?").get(id) as Row | undefined;
  return r ? view(toJob(r)) : null;
}

export function listKatana(limit = 20): KatanaJobView[] {
  const n = Math.max(1, Math.min(100, limit));
  const account = tenantAccount();
  if (account) {
    return listAccountProjects(account, KIND)
      .slice(0, n)
      .map((s) => getAccountProject<KatanaData>(account, KIND, s.id))
      .filter((p): p is AccountProject<KatanaData> => !!p)
      .map((p) => view(fromProject(p)));
  }
  const rows = db().prepare("SELECT * FROM katana_jobs ORDER BY updated_at DESC LIMIT ?").all(n) as Row[];
  return rows.map((r) => view(toJob(r)));
}

/** Steps that haven't finished are stopped (nothing more is spent); finished clips stay in the Library. */
function stopUnfinished(ids: string[]): void {
  for (const gid of ids) {
    const g = getGeneration(gid);
    if (g && (g.status === "queued" || g.status === "running")) void cancelGeneration(gid);
  }
}

export function deleteKatana(id: string): boolean {
  const j = getKatana(id);
  if (j) stopUnfinished(Object.values(j.steps));
  const account = tenantAccount();
  if (account) return deleteAccountProject(account, KIND, id);
  return db().prepare("DELETE FROM katana_jobs WHERE id = ?").run(id).changes > 0;
}

function saveJob(j: KatanaJob): KatanaJob {
  const { id, createdAt, ...data } = j;
  const now = Date.now();
  delete (data as Partial<KatanaJob>).updatedAt;
  const account = tenantAccount();
  if (account) {
    const saved = updateAccountProject(account, KIND, id, { data, summary: summaryOf(data) });
    return { ...j, id, createdAt, updatedAt: saved?.updatedAt ?? now };
  }
  db().prepare("UPDATE katana_jobs SET data_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(data), now, id);
  return { ...j, id, createdAt, updatedAt: now };
}

/** An account's job's line in its list. */
const summaryOf = (d: KatanaData) => ({ engine: d.engine, segments: d.segments.length });

const inputOf = (j: KatanaJob): KatanaInput => ({
  engine: j.engine,
  reference: j.reference,
  photos: j.photos,
  instructions: j.instructions,
  segments: j.segments,
  motionModel: j.motionModel,
  aspectRatio: j.aspectRatio,
  keepAudio: j.keepAudio,
  title: j.title,
});

/** The steps a retry makes again: the failed ones and every step after them (in order), with the job. */
function retryPlan(id: string): { j: Omit<KatanaJobView, "generations">; steps: KatanaStep[]; redo: string[] } {
  const found = getKatana(id);
  if (!found) throw new Error("This run no longer exists");
  const { generations, ...j } = found;
  const failed = Object.entries(j.steps)
    .filter(([, gid]) => {
      const g = generations[gid];
      return !g || g.status === "failed" || g.status === "canceled";
    })
    .map(([k]) => k);
  if (!failed.length) throw new Error("No step failed — the run is done or still going");
  const steps = katanaSteps(inputOf(j));
  return { j, steps, redo: stepsToRedo(steps, failed) };
}

/** What a retry would make, as the requests it makes (account-tool-run.ts checks them before anything starts). */
export function katanaRetrySteps(id: string): { request: GenerationRequest; deps: number }[] {
  const { steps, redo } = retryPlan(id);
  return redo.map((key) => toolStep(steps.find((x) => x.key === key)!));
}

/**
 * Retry a run whose steps failed: the failed steps and every step after them are made again (new
 * generations in the same batch, fed by the steps that did finish); nothing that succeeded is paid twice.
 */
export function retryKatana(id: string): KatanaJobView {
  const { j, steps, redo } = retryPlan(id);
  // Old steps downstream of the failure that are still waiting would fail anyway: stop them now.
  stopUnfinished(redo.map((k) => j.steps[k]).filter(Boolean));
  const ids = { ...j.steps };
  const made: string[] = [];
  try {
    for (const key of redo) {
      const st = steps.find((x) => x.key === key)!;
      const after = st.after === undefined ? [] : [st.after].flat();
      const g = createGenerations({ ...st.request, ...(st.chain && { chain: st.chain }) }, { batchId: j.batchId, ...(after.length && { dependsOn: after.map((a) => ids[a]) }) })[0];
      made.push(g.id);
      ids[key] = g.id;
    }
  } catch (e) {
    for (const gid of made) void cancelGeneration(gid);
    throw e;
  }
  const replaced = { ...j.replaced };
  for (const k of redo) if (j.steps[k] && j.steps[k] !== ids[k]) replaced[k] = [...(replaced[k] ?? []), j.steps[k]];
  return view(saveJob({ ...j, steps: ids, replaced }));
}

/** The same reference, photos and settings as a new run. */
export function rerunKatana(id: string): KatanaJobView {
  return createKatana(rerunBody(id));
}

const Seg = z.object({ start: z.number().min(0).max(KATANA_LIMITS.maxReference), end: z.number().min(0).max(KATANA_LIMITS.maxReference + 1) });

export const KatanaBody = z.object({
  engine: z.enum(["cloud", "open"]),
  reference: z.string().startsWith("/api/files/").max(500),
  photos: z.array(z.string().startsWith("/api/files/").max(500)).min(1).max(KATANA_LIMITS.maxPhotos),
  instructions: z.string().max(KATANA_LIMITS.maxInstructions).optional(),
  /** Segments chosen in the studio (scene cuts); without them the clip is cut every `length` seconds. */
  segments: z.array(Seg).max(KATANA_LIMITS.maxSegments).optional(),
  length: z.number().min(1).max(10).optional(),
  duration: z.number().positive().max(600).optional(),
  motionModel: z.string().max(80).optional(),
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]).optional(),
  keepAudio: z.boolean().optional(),
  title: z.string().max(200).optional(),
});
export type KatanaRequest = z.infer<typeof KatanaBody>;

/**
 * The reference's length: what the browser measured, else the file's header (MP4, MOV). Only the header is read; a
 * visitor's price check reads only its own file (storedMedia).
 */
function referenceLength(ref: string, given?: number): number {
  if (given) return given;
  const info = storedMedia(ref)?.info;
  const d = info?.videoDuration ?? info?.duration;
  if (!d) throw new Error("Couldn't read how long the reference is — try an MP4");
  return d;
}

function validSegments(segs: Segment[], duration: number): Segment[] {
  const sorted = [...segs].sort((a, b) => a.start - b.start);
  sorted.forEach((s, i) => {
    if (!(s.end > s.start)) throw new Error("A segment ends before it starts");
    if (i && s.start < sorted[i - 1].end - 0.01) throw new Error("Segments overlap");
  });
  if (sorted.at(-1)!.end > duration + 0.5) throw new Error("A segment runs past the end of the reference");
  return sorted;
}

/** The plan (segments + steps) of a request, validated; throws a readable message. */
export function planKatana(body: KatanaRequest): { input: KatanaInput; engine: Engine } {
  const mode = engineMode();
  const engine: Engine = mode === "both" ? body.engine : mode;
  const duration = Math.min(referenceLength(body.reference, body.duration), KATANA_LIMITS.maxReference);
  if (duration < KATANA_LIMITS.minReference) throw new Error("The reference is too short");
  // Without one asked for: the first motion model switched on in Settings → Models & licences.
  const m = motionModel(engine, body.motionModel ?? firstOn(MOTION_MODELS[engine].map((x) => x.id), engine));
  if (body.motionModel && m.id !== currentMotionModel(body.motionModel)) throw new Error(`${getModel(body.motionModel)?.name ?? body.motionModel} isn't a ${engine === "open" ? "open-source" : "cloud"} motion model for Katana`);
  const segments = body.segments?.length ? validSegments(body.segments, duration) : planSegments({ duration, mode: "fixed", length: body.length ?? m.max, min: m.min, max: m.max });
  const title = body.title?.trim().slice(0, 120) || "Katana edit";
  return {
    engine,
    input: { engine, reference: body.reference, photos: body.photos, instructions: body.instructions, segments, motionModel: m.id, aspectRatio: body.aspectRatio, keepAudio: body.keepAudio, title },
  };
}

/** A step as the request it makes, with how many earlier steps it waits for. */
const toolStep = (s: KatanaStep): { request: GenerationRequest; deps: number } => ({ request: s.chain ? { ...s.request, chain: s.chain } : s.request, deps: [s.after ?? []].flat().length });

/** A planned run (nothing is created yet): its input, engine and steps. */
export interface KatanaRun {
  input: KatanaInput;
  engine: Engine;
  steps: KatanaStep[];
}

/** Plan a run: its segments and steps, validated (reads the reference's header only). */
export function planKatanaRun(body: KatanaRequest): KatanaRun {
  const { input, engine } = planKatana(body);
  return { input, engine, steps: katanaSteps(input) };
}

/** A planned run's steps as the requests they make (account-tool-run.ts). */
export const katanaRunSteps = (r: KatanaRun) => r.steps.map(toolStep);

/** The same reference, photos and settings as a new run's request (Run again). */
export function rerunBody(id: string): KatanaRequest {
  const j = getKatana(id);
  if (!j) throw new Error("This run no longer exists");
  const aspect = j.aspectRatio === "16:9" || j.aspectRatio === "9:16" || j.aspectRatio === "1:1" ? j.aspectRatio : undefined;
  return { ...inputOf(j), aspectRatio: aspect, duration: j.segments.at(-1)?.end };
}

export function createKatana(body: KatanaRequest): KatanaJobView {
  return startKatana(planKatanaRun(body));
}

/** Start a planned run and keep its job (the owner's row, or the account's own project). */
export function startKatana({ input, engine, steps }: KatanaRun): KatanaJobView {
  const run = createPipeline(steps, {});
  const now = Date.now();
  const job: KatanaJob = {
    id: nanoid(10),
    title: input.title ?? "Katana edit",
    engine,
    reference: input.reference,
    photos: input.photos,
    instructions: input.instructions,
    motionModel: input.motionModel!,
    segments: input.segments,
    keepAudio: input.keepAudio !== false,
    ...(input.aspectRatio && { aspectRatio: input.aspectRatio }),
    batchId: run.batchId,
    steps: Object.fromEntries(Object.entries(run.byKey).map(([k, g]) => [k, g.id])),
    final: finalKey(steps),
    createdAt: now,
    updatedAt: now,
  };
  const { id, createdAt, updatedAt, ...data } = job;
  const account = tenantAccount();
  if (account) {
    try {
      return view(fromProject(createAccountProject<KatanaData>(account, KIND, { name: data.title, data, summary: summaryOf(data) })));
    } catch (e) {
      // Kept no job: the steps just made are stopped (nothing more is spent).
      stopUnfinished(Object.values(job.steps));
      throw e;
    }
  }
  db().prepare("INSERT INTO katana_jobs (id, data_json, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, JSON.stringify(data), createdAt, updatedAt);
  return view(job);
}

/** Price a run without starting it (Assist's approval card, the studio's estimate). */
export function previewKatana(body: KatanaRequest): { segments: Segment[]; steps: number; costUsd: number | null; demo: boolean; model: string } {
  const { input } = planKatana(body);
  const steps = katanaSteps(input);
  let cost: number | null = 0;
  let demo = false;
  for (const s of steps) {
    const p = previewChained(s.chain ? { ...s.request, chain: s.chain } : s.request, [s.after ?? []].flat().length);
    demo ||= p.demo;
    cost = cost === null || p.costUsd === null ? null : cost + p.costUsd;
  }
  return { segments: input.segments, steps: steps.length, costUsd: cost, demo, model: input.motionModel! };
}

// ---------------------------------------------------------------------------
// Assist / MCP tool ("katana")

const KatanaToolInput = z.object({
  reference: z.string().describe("The reference edit to recreate: a video URL from the chat (/api/files/…), 1–30 s."),
  photos: z.array(z.string()).describe("1–5 photos of your subject (person, product or outfit) as /api/files/… URLs."),
  instructions: z.string().optional().describe("What to pay attention to when recreating it (optional, ≤2000 characters)."),
  segment_seconds: z.number().optional().describe("Cut the reference every N seconds (default: the longest the motion model takes)."),
  motion_model: z.string().optional().describe(`Motion model: cloud ${MOTION_MODELS.cloud.map((m) => m.id).join(" | ")}; open ${MOTION_MODELS.open.map((m) => m.id).join(" | ")}.`),
  keep_audio: z.boolean().optional().describe("Keep the reference's soundtrack (default true)."),
});

const toBody = (s: z.infer<typeof KatanaToolInput>, engine: Engine): KatanaRequest =>
  KatanaBody.parse({ engine, reference: s.reference, photos: s.photos, instructions: s.instructions, length: s.segment_seconds, motionModel: s.motion_model, keepAudio: s.keep_audio });

/** The tool definition, appended to Assist's TOOLS (and so to MCP). */
export const katanaTool = {
  name: "katana",
  description:
    "Katana: recreate a reference edit (a 1–30 s video) with the user's own subject from 1–5 photos. The reference is cut into segments; each segment's first frame gets the subject, then the segment is regenerated with the reference's motion, joined at the original cut times, with the reference's soundtrack. Use it for 'make this edit with me / my product'. Gated by the same approval card as generate.",
  schema: KatanaToolInput,
  gated: true,
  plan: (s: z.infer<typeof KatanaToolInput>, ctx: { engine: Engine }): PlannedJob[] => {
    const engine = engineMode() === "both" ? ctx.engine : (engineMode() as Engine);
    const m = motionModel(engine, s.motion_model);
    const job: PlannedJob = {
      tool: "katana",
      modelId: m.id,
      modelName: `Katana · ${m.label}`,
      kind: "video",
      op: "v2v",
      prompt: s.instructions?.trim() || "Recreate the reference edit with the subject from the photos",
      count: 1,
      costUsd: null,
      demo: false,
    };
    try {
      const p = previewKatana(toBody(s, ctx.engine));
      return [{ ...job, modelId: p.model, prompt: `${job.prompt} (${p.segments.length} segment${p.segments.length === 1 ? "" : "s"}, ${p.steps} steps)`, costUsd: p.costUsd, demo: p.demo }];
    } catch (e) {
      return [{ ...job, error: e instanceof z.ZodError ? "Give the reference video and 1–5 photos as /api/files/… URLs" : (e as Error).message }];
    }
  },
  /** Where the job opens (the approval card, MCP's estimate_job). */
  place: () => ({ studio: "Katana", href: "/katana" }),
  async run(s: z.infer<typeof KatanaToolInput>, ctx: { engine: Engine }) {
    const job = createKatana(toBody(s, ctx.engine));
    const final = job.steps[job.final];
    return {
      content: JSON.stringify({ studio: "Katana", href: "/katana", katana: job.id, segments: job.segments, final, note: `${Object.keys(job.steps).length} steps; the finished video is generation ${final}. Katana lists the run with its steps, Retry and Run again.` }),
      items: [
        { id: "", role: "tool" as const, text: "Started a Katana edit", href: "/katana", studio: "Katana" },
        { id: "", role: "generations" as const, ids: [final] },
      ],
    };
  },
};

export { KATANA_FEATURE, katanaStage };

/**
 * An account keeps its Katana runs as its own projects: room for one more, checked before anything is made (a
 * ShortsError, 409, when it has as many as it may keep).
 */
export function katanaRoom(accountId: string): void {
  if (listAccountProjects(accountId, KIND).length >= ACCOUNT_PROJECT_LIMITS.projects) {
    throw new ShortsError(`You can keep up to ${ACCOUNT_PROJECT_LIMITS.projects} Katana runs. Delete one to make another.`, 409);
  }
}
