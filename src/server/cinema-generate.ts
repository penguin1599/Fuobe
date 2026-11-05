import "server-only";
import { nanoid } from "nanoid";
import { BLOCKOUT } from "@/lib/blockout";
import { getModel } from "@/lib/catalog";
import {
  SWATCH_PLACEHOLDER,
  blockoutTake,
  worldTake,
  pathTake,
  planCinema,
  withPlaceholders,
  type CinemaContext,
  type CinemaGenerateInput,
  type CinemaPlan,
  type CinemaStep,
  type BlockoutRun,
  type CinemaTakeInfo,
  type DirectorSettings,
} from "@/lib/catalog/cinema";
import type { Generation, GenerationRequest } from "@/lib/catalog/types";
import { CinemaError, folderExists, getProject, recordTakes, spentUsd } from "./cinema";
import { ConnectComfyError, createGenerations, previewGeneration } from "./generations";
import { encodePng } from "./png";
import { engineMode, getSetting } from "./settings";
import { saveFile, storedMedia } from "./storage";
import { isOffered } from "./model-access";
import { tenantAccount } from "./tenant";
import { worldcastContext } from "./worldcast-on";

/**
 * What this install can run right now (cloud fallbacks such as reading a take's first frame, the workflows it has, a
 * camera LoRA that downloads from civitai, which fal gets only with the user's civitai key). Inside an account's work the
 * engine mode is its own, and the studio's civitai key is never its (loras.ts leaves those LoRAs out of its runs).
 */
export function cinemaContext(): CinemaContext {
  return { cloudAllowed: engineMode() !== "open", has: (id) => !!getModel(id) && isOffered(id), civitai: !tenantAccount() && !!getSetting("civitaiKey"), worldcast: worldcastContext() };
}

declare global {
  var __fuobeSwatches: Map<string, string> | undefined;
}

/**
 * A 12-stripe PNG of the palette: the reference image palette-transfer recolours toward. Each one's own file: an
 * account's run reads only its own files, so an account's swatch is stored as its own (and never handed to another).
 */
export function swatchUrl(hex: string[]): string {
  globalThis.__fuobeSwatches ??= new Map();
  const key = `${tenantAccount() ?? ""}|${hex.join(",").toLowerCase()}`;
  const hit = globalThis.__fuobeSwatches.get(key);
  if (hit) return hit;
  const stripe = 32;
  const width = stripe * hex.length;
  const height = 64;
  const data = Buffer.alloc(width * height * 4);
  hex.forEach((h, i) => {
    const n = parseInt(h.replace("#", ""), 16);
    for (let y = 0; y < height; y++)
      for (let x = i * stripe; x < (i + 1) * stripe; x++) data.set([(n >> 16) & 255, (n >> 8) & 255, n & 255, 255], (y * width + x) * 4);
  });
  const asset = saveFile({ data: encodePng({ width, height, data }), contentType: "image/png", name: "palette-swatch.png", source: "upload" });
  globalThis.__fuobeSwatches.set(key, asset.url);
  return asset.url;
}

/** A generate request from the workspace: the brief always comes from the project, the Director settings unless sent. */
export type CinemaRequest = Omit<CinemaGenerateInput, "settings" | "brief"> & { settings?: DirectorSettings };

/**
 * A blockout as its stored file says: the length from the file's header (the browser's measure only where the header
 * can't be read: a MOV it couldn't decode, a 40 s clip it read as 8, are filmed at their real length), and whether
 * it is WebM (Seedance 2.5 takes MP4 or MOV). Only the header is read; a file the asker may not use is left as sent
 * (its run is refused by the input checks).
 */
export function blockoutFromFile<T extends Pick<BlockoutRun, "video" | "seconds" | "webm">>(b: T): T & Pick<BlockoutRun, "webm"> {
  const info = b.video ? storedMedia(b.video, { allContainers: true })?.info : undefined;
  if (!info) return b;
  const len = info.videoDuration ?? info.duration;
  return {
    ...b,
    ...(len && len > 0 ? { seconds: Math.round(Math.min(BLOCKOUT.maxSeconds, len) * 100) / 100 } : {}),
    ...(info.container === "webm" ? { webm: true } : info.container === "mp4" ? { webm: false } : {}),
  };
}

/** The plan with this project's brief and (unless the request carries its own) Director settings. */
export function planForProject(projectId: string, input: CinemaRequest): CinemaPlan {
  const project = getProject(projectId);
  if (!project) throw new CinemaError("Project not found", 404);
  const asked = input.action === "blockout" && input.blockout ? { ...input, blockout: blockoutFromFile(input.blockout) } : input;
  return planCinema({ ...asked, settings: input.settings ?? project.director, brief: project.brief.body }, cinemaContext());
}

type Preview = ReturnType<typeof previewGeneration>;

/**
 * Check and price every step before any is created, from the server's own route choice (engine
 * mode, keys, demo): a step that can't run must not leave the earlier ones running and billed.
 */
function previewSteps(steps: CinemaStep[]): Preview[] {
  return steps.map((s) => {
    try {
      return previewGeneration(withPlaceholders(s));
    } catch (e) {
      if (e instanceof ConnectComfyError) throw e;
      throw new CinemaError((e as Error).message, 422);
    }
  });
}

/** What the run will really cost (0 for demo-mode steps). */
function realCost(steps: CinemaStep[], previews: Preview[]): number {
  let total = 0;
  const jobs: Record<string, number> = {};
  steps.forEach((s, i) => {
    const p = previews[i];
    const n = s.perJobOf ? (jobs[s.perJobOf] ?? 1) : 1;
    jobs[s.key] = s.after?.length ? n : p.jobs;
    total += (p.costUsd ?? 0) * n;
  });
  return Math.round(total * 1000) / 1000;
}

/** The generations a dependent step waits for: a joined film counts once, otherwise each take. */
function terminal(list: Generation[]): Generation[] {
  return list[0]?.op === "concat" ? [list[0]] : list;
}

export interface CinemaRunResult {
  items: Generation[];
  /** Where the takes were filed: the scene asked for, or the project root when that scene no longer exists. */
  folderId: string | null;
  plan: Pick<CinemaPlan, "notes" | "costUsd" | "outputs"> & { modelId: string };
}

/**
 * Plan, check every step and the project's cost cap, create the chained generations and record them
 * in the project (in `folderId`, the scene the user is looking at).
 */
export function generateInProject(projectId: string, asked: CinemaRequest, folderId: string | null = null): CinemaRunResult {
  return startCinemaRun(prepareCinemaRun(projectId, asked, folderId));
}

/** A take, planned and checked (the project's limit included): what startCinemaRun makes. */
export interface CinemaRun {
  projectId: string;
  input: CinemaRequest;
  plan: CinemaPlan;
  folder: string | null;
  notes: string[];
}

/**
 * The run's steps as an account's run checks them (account-tool-run.ts): each request and how many earlier steps it
 * waits for (one per job of the step before it, or one per step it follows).
 */
export const cinemaSteps = (run: CinemaRun): { request: GenerationRequest; deps: number }[] =>
  run.plan.steps.map((s) => ({ request: s.request, deps: s.perJobOf ? 1 : (s.after?.length ?? 0) }));

/** Plan a take in the project and check every step and the project's limit; nothing is made yet. */
export function prepareCinemaRun(projectId: string, asked: CinemaRequest, folderId: string | null = null): CinemaRun {
  const project = getProject(projectId);
  if (!project) throw new CinemaError("Project not found", 404);
  // A blockout's take remembers the length its file says, as the plan films it.
  const input = asked.action === "blockout" && asked.blockout ? { ...asked, blockout: blockoutFromFile(asked.blockout) } : asked;
  const notes: string[] = [];
  // A scene deleted since the view loaded (the sidebar, another tab): file the takes at the root rather than lose them.
  let folder = folderId;
  if (folder && !folderExists(projectId, folder)) {
    folder = null;
    notes.push("That scene was deleted, so the take is in Home");
  }
  const plan = planForProject(projectId, input);
  if (plan.blocker) throw new CinemaError(plan.blocker, 422);
  if (!plan.steps.length) throw new CinemaError("Nothing to generate", 422);
  const previews = previewSteps(plan.steps);

  if (project.costCapUsd != null) {
    const cost = realCost(plan.steps, previews);
    const spent = spentUsd(projectId);
    if (cost > 0 && spent + cost > project.costCapUsd + 1e-9) {
      throw new CinemaError(
        `This run (≈ $${cost.toFixed(2)}) would take the project past its $${project.costCapUsd.toFixed(2)} limit — $${spent.toFixed(2)} is already spent. Raise the limit in project settings.`,
        422,
      );
    }
  }
  return { projectId, input, plan, folder, notes };
}

/** Make a planned take: its chained generations, recorded in the project. */
export function startCinemaRun({ projectId, input, plan, folder, notes }: CinemaRun): CinemaRunResult {
  const take: CinemaTakeInfo = {
    mode: input.mode,
    action: input.action,
    prompt: input.prompt.slice(0, 4000),
    ...(input.moves?.length ? { moves: input.moves } : {}),
    ...(input.action === "grid" && input.grid ? { grid: input.grid } : {}),
    ...(input.action === "recompose" && input.capture ? { camera: { lens: input.capture.lens, aperture: input.capture.aperture, pose: input.capture.pose } } : {}),
    ...(input.action === "path" && input.path ? { path: pathTake(input, plan) } : {}),
    ...(input.action === "blockout" && input.blockout ? { blockout: blockoutTake(input, plan) } : {}),
    ...(input.action === "world" && input.world ? { world: worldTake(input) } : {}),
  };
  const batchId = nanoid(10);
  const made: Record<string, Generation[]> = {};
  const all: Generation[] = [];
  try {
    for (const step of plan.steps) {
      const req: GenerationRequest = structuredClone(step.request);
      if (step.swatch && req.inputs?.images) req.inputs.images = req.inputs.images.map((u) => (u === SWATCH_PLACEHOLDER ? swatchUrl(step.swatch!) : u));
      let created: Generation[] = [];
      if (step.perJobOf) {
        for (const t of terminal(made[step.perJobOf] ?? [])) created.push(...createGenerations(req, { batchId, dependsOn: t.id }));
      } else if (step.after?.length) {
        const deps = step.after.map((k) => terminal(made[k] ?? [])[0]?.id).filter((x): x is string => !!x);
        created = createGenerations(req, { batchId, dependsOn: deps });
      } else created = createGenerations(req, { batchId });
      made[step.key] = created;
      all.push(...created);
    }
  } catch (e) {
    // Keep what already started visible in the project, then report the step that failed.
    recordTakes(projectId, all, folder, take);
    if (e instanceof ConnectComfyError) throw e;
    throw new CinemaError((e as Error).message, 422);
  }
  recordTakes(projectId, all, folder, take);
  return { items: all, folderId: folder, plan: { notes: [...notes, ...plan.notes], costUsd: plan.costUsd, outputs: plan.outputs, modelId: plan.model.id } };
}
