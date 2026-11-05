import "server-only";
import { originalSoundOn, type OriginalSound } from "@/lib/av/original-sound";
import { nanoid } from "nanoid";
import { getModel } from "@/lib/catalog";
import { maxRefsFor, reframes, resolutionFor, sourceSeconds } from "@/lib/catalog/shorts-models";
import {
  clipLengthProblem,
  ENHANCE_COPY,
  clipShapeProblem,
  customPresetName,
  getShortsPreset,
  lookFromCustom,
  lookFromPreset,
  needsFit,
  originalSegmentProblem,
  planSegments,
  planEnhance,
  planFinishedStitch,
  planShorts,
  planTake,
  rangeProblem,
  sessionPlanInput,
  stitchCurrent,
  SHORTS,
  SHORTS_MODELS,
  SHORTS_ORIGINAL,
  vaceDownsample,
  type PlanStep,
  type ShortsCustomPreset,
  type ShortsLook,
  type ShortsPlanInput,
  type ShortsRange,
  type ShortsRatio,
  type ShortsSession,
  type ShortsSessionSegment,
  type ShortsStitch,
  type ShortsTake,
  type TakeKeys,
} from "@/lib/catalog/shorts";
import { REGEN_COPY, REGEN_OFFERED } from "@/lib/catalog/regenerate";
import type { Engine, Generation, GenerationRequest } from "@/lib/catalog/types";
import { generationAccount } from "./account-library";
import {
  ACCOUNT_PROJECT_LIMITS,
  AccountProjectError,
  createAccountProject,
  deleteAccountProject,
  getAccountProject,
  listAccountProjects,
  projectRefsProblem,
  updateAccountProject,
} from "./account-projects";
import { createPipeline } from "./chains";
import { db } from "./db";
import { getGeneration, previewChained } from "./generations";
import { deleteForever, trashGenerations } from "./library";
import { firstOn } from "./model-access";
import { engineMode } from "./settings";
import { readRef, RefError } from "./storage";
import { mediaFacts, type SourceInfo } from "./media-facts";
import { ownSetupGate } from "./own-setup-run";
import { tenant } from "./tenant";

/**
 * Shorts Studio sessions: a clip cut into segments, each restyled (one or more takes, one of them
 * primary) and stitched back together under the original sound. Every step is an ordinary
 * generation made through createPipeline; a session only records which generation is which.
 *
 * Whose sessions and presets: the owner's are in shorts_sessions and shorts_presets. Inside an account's work
 * (tenant.ts, asAccount; public sign-up) every read and change here is that account's own instead, kept in its own
 * projects (account-projects.ts, kinds "shorts" and "shorts-preset"): it never reaches the owner's tables or another
 * account's. A guest has none. An account's runs are checked and started through src/server/account-tool-run.ts, so
 * each run is planned first (planSessionRun, planTakeRun, planStitchRun) and started after the checks (startSession,
 * startTake, startStitch).
 */

export class ShortsError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Models (what each restyle model takes: src/lib/catalog/shorts-models.ts)

export { maxRefsFor, modelInfos, resolutionFor } from "@/lib/catalog/shorts-models";

// ---------------------------------------------------------------------------
// Source clips

export type { SourceInfo } from "./media-facts";

/**
 * What the clip's header says (MP4 / MOV, and WebM / Matroska). A file neither reader knows comes
 * back empty: the browser's numbers are used, and its sound counts as unknown (made without it).
 */
export async function probeSource(url: string): Promise<SourceInfo> {
  if (!url.startsWith("/api/files/")) throw new ShortsError("Upload the clip first");
  let data: Buffer;
  try {
    data = (await readRef(url)).data;
  } catch (e) {
    // An account's clip over an upload's size says so; another's file answers like one that is gone.
    if (e instanceof RefError && e.status === 413) throw new ShortsError(e.message, 413);
    throw new ShortsError("That clip is gone — upload it again", 404);
  }
  return sourceInfo(data);
}

/** What a clip's bytes say (the header readers behind probeSource). */
export function sourceInfo(data: Buffer): SourceInfo {
  return mediaFacts(data);
}

// ---------------------------------------------------------------------------
// Rows

interface SessionRow {
  id: string;
  title: string;
  engine: string;
  batch_id: string;
  look_json: string;
  source_json: string;
  range_json: string;
  settings_json: string;
  segments_json: string;
  stitches_json: string;
  created_at: number;
  updated_at: number;
}

const toSession = (r: SessionRow): ShortsSession => ({
  id: r.id,
  title: r.title,
  engine: r.engine as Engine,
  batchId: r.batch_id,
  look: JSON.parse(r.look_json),
  source: JSON.parse(r.source_json),
  range: JSON.parse(r.range_json),
  settings: JSON.parse(r.settings_json),
  segments: JSON.parse(r.segments_json),
  stitches: JSON.parse(r.stitches_json),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** An account's sessions and presets, as its own projects (account-projects.ts). */
const SESSION_KIND = "shorts";
const PRESET_KIND = "shorts-preset";

/** Whose work this is: the owner's (undefined), an account's (its id), or a guest's (null: nothing of its own). */
function whose(): string | null | undefined {
  const t = tenant();
  if (!t) return undefined;
  return t.kind === "account" ? t.id : null;
}

const GONE = "This short no longer exists";

/** A change the account's project store refused (too big, too many): its words and status. */
function stored<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof AccountProjectError) throw new ShortsError(e.message, e.status);
    throw e;
  }
}

/** What an account's History shows of a session, kept beside it (the list never reads every session). */
interface SessionLine {
  engine: Engine;
  lookName: string;
  segments: number;
  seconds: number;
  /** The newest stitch's video. */
  final?: string;
  /** Each segment's chosen take. */
  primaries: string[];
}

const lineOf = (s: Omit<ShortsSession, "id">): SessionLine => ({
  engine: s.engine,
  lookName: s.look.name,
  segments: s.segments.length,
  seconds: Math.round((s.range.end - s.range.start) * 10) / 10,
  ...(s.stitches.length && { final: s.stitches[s.stitches.length - 1].final }),
  primaries: s.segments.map((g) => g.primary),
});

function readSession(id: string): ShortsSession {
  const who = whose();
  if (who === undefined) {
    const r = db().prepare("SELECT * FROM shorts_sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!r) throw new ShortsError(GONE, 404);
    return toSession(r);
  }
  // Another account's session, the owner's, or none: the same answer.
  const p = who ? getAccountProject<ShortsSession>(who, SESSION_KIND, id) : null;
  if (!p) throw new ShortsError(GONE, 404);
  return { ...p.data, id: p.id, title: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt };
}

function saveSession(s: ShortsSession): ShortsSession {
  const who = whose();
  if (who === undefined) {
    const now = Date.now();
    db()
      .prepare("UPDATE shorts_sessions SET segments_json = ?, stitches_json = ?, title = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(s.segments), JSON.stringify(s.stitches), s.title, now, s.id);
    return { ...s, updatedAt: now };
  }
  const saved = who ? stored(() => updateAccountProject(who, SESSION_KIND, s.id, { name: s.title, data: s, summary: lineOf(s) })) : null;
  if (!saved) throw new ShortsError(GONE, 404);
  return { ...s, title: saved.name, updatedAt: saved.updatedAt };
}

/** Store a new session: the owner's row, or the account's own project. Its id is the store's. */
function insertSession(s: Omit<ShortsSession, "id">): ShortsSession {
  const who = whose();
  if (who === undefined) {
    const session: ShortsSession = { id: nanoid(10), ...s };
    db()
      .prepare(
        `INSERT INTO shorts_sessions (id, title, engine, batch_id, look_json, source_json, range_json, settings_json, segments_json, stitches_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.title,
        session.engine,
        session.batchId,
        JSON.stringify(session.look),
        JSON.stringify(session.source),
        JSON.stringify(session.range),
        JSON.stringify(session.settings),
        JSON.stringify(session.segments),
        JSON.stringify(session.stitches),
        session.createdAt,
        session.updatedAt,
      );
    return session;
  }
  if (!who) throw new ShortsError("Create a free account to make a short.", 401);
  const p = stored(() => createAccountProject(who, SESSION_KIND, { name: s.title, data: s, summary: lineOf(s) }));
  return { ...s, id: p.id, title: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt };
}

/** An account keeps up to ACCOUNT_PROJECT_LIMITS.projects shorts: checked before anything is made. */
function roomForSession(): void {
  const who = whose();
  if (who && listAccountProjects(who, SESSION_KIND).length >= ACCOUNT_PROJECT_LIMITS.projects) {
    throw new ShortsError(`You can keep up to ${ACCOUNT_PROJECT_LIMITS.projects} shorts. Delete one to make another.`, 409);
  }
}

interface PresetRow {
  id: string;
  name: string;
  description: string;
  references_json: string;
  created_at: number;
  updated_at: number;
}

const toPreset = (r: PresetRow): ShortsCustomPreset => ({
  id: r.id,
  name: r.name,
  description: r.description,
  references: JSON.parse(r.references_json),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// ---------------------------------------------------------------------------
// Custom presets ("Create a preset from references")

/** An account's preset, as its project keeps it (the name is the project's). */
interface PresetData {
  description: string;
  references: string[];
}

function accountPreset(who: string, id: string): ShortsCustomPreset | null {
  const p = getAccountProject<PresetData>(who, PRESET_KIND, id);
  return p ? { id: p.id, name: p.name, description: p.data.description, references: p.data.references, createdAt: p.createdAt, updatedAt: p.updatedAt } : null;
}

/** An account's references are its own uploads or results only (or Fuobe's example files): another's is refused. */
function ownReferences(who: string, refs: string[]): void {
  const problem = projectRefsProblem(who, { files: refs });
  if (problem) throw new ShortsError(problem.error, problem.status);
}

export function listCustomPresets(): ShortsCustomPreset[] {
  const who = whose();
  if (who === undefined) return (db().prepare("SELECT * FROM shorts_presets ORDER BY created_at DESC").all() as PresetRow[]).map(toPreset);
  if (!who) return [];
  return listAccountProjects(who, PRESET_KIND)
    .map((p) => accountPreset(who, p.id))
    .filter((p): p is ShortsCustomPreset => !!p)
    .sort((x, y) => y.createdAt - x.createdAt);
}

export function getCustomPreset(id: string): ShortsCustomPreset | null {
  const who = whose();
  if (who === undefined) {
    const r = db().prepare("SELECT * FROM shorts_presets WHERE id = ?").get(id) as PresetRow | undefined;
    return r ? toPreset(r) : null;
  }
  return who ? accountPreset(who, id) : null;
}

export function createCustomPreset(input: { name?: string; description?: string; references: string[] }): ShortsCustomPreset {
  const refs = [...new Set(input.references)].slice(0, SHORTS.maxReferences);
  if (!refs.length) throw new ShortsError("Add at least one reference image");
  const description = (input.description ?? "").trim();
  const who = whose();
  if (who !== undefined) {
    if (!who) throw new ShortsError("Create a free account to make a preset.", 401);
    ownReferences(who, refs);
    const name = input.name?.trim() || customPresetName(description, listAccountProjects(who, PRESET_KIND).length);
    const p = stored(() => createAccountProject<PresetData>(who, PRESET_KIND, { name, data: { description, references: refs } }));
    return accountPreset(who, p.id)!;
  }
  const count = (db().prepare("SELECT COUNT(*) AS n FROM shorts_presets").get() as { n: number }).n;
  const name = input.name?.trim() || customPresetName(description, count);
  const now = Date.now();
  const id = `custom-${nanoid(10)}`;
  db()
    .prepare("INSERT INTO shorts_presets (id, name, description, references_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, name, description, JSON.stringify(refs), now, now);
  return getCustomPreset(id)!;
}

export function updateCustomPreset(id: string, patch: { name?: string; description?: string; references?: string[] }): ShortsCustomPreset {
  const cur = getCustomPreset(id);
  if (!cur) throw new ShortsError("This preset no longer exists", 404);
  const refs = patch.references ? [...new Set(patch.references)].slice(0, SHORTS.maxReferences) : cur.references;
  if (!refs.length) throw new ShortsError("Keep at least one reference image");
  const who = whose();
  if (who) {
    if (patch.references) ownReferences(who, refs);
    const data: PresetData = { description: patch.description?.trim() ?? cur.description, references: refs };
    if (!stored(() => updateAccountProject(who, PRESET_KIND, id, { name: patch.name?.trim() || cur.name, data }))) throw new ShortsError("This preset no longer exists", 404);
    return accountPreset(who, id)!;
  }
  db()
    .prepare("UPDATE shorts_presets SET name = ?, description = ?, references_json = ?, updated_at = ? WHERE id = ?")
    .run(patch.name?.trim() || cur.name, patch.description?.trim() ?? cur.description, JSON.stringify(refs), Date.now(), id);
  return getCustomPreset(id)!;
}

export function deleteCustomPreset(id: string): boolean {
  const who = whose();
  if (who === undefined) return db().prepare("DELETE FROM shorts_presets WHERE id = ?").run(id).changes > 0;
  return !!who && deleteAccountProject(who, PRESET_KIND, id);
}

// ---------------------------------------------------------------------------
// Planning

export interface ShortsBody {
  engine: Engine;
  presetId: string;
  /** width / height / fps: what the browser read, for estimates made before the server has the file. */
  source: { url: string; name?: string; duration?: number; width?: number; height?: number; fps?: number };
  range: ShortsRange;
  aspectRatio: ShortsRatio;
  language: string;
  modelId?: string;
  /** A look of its own instead of a preset (Assist's words), kept on the session like a preset's. Server-side only. */
  look?: ShortsLook;
  /** What of the clip's sound goes back (src/lib/av/original-sound.ts). */
  originalSound?: OriginalSound;
}

function lookFor(presetId: string): ShortsLook {
  const built = getShortsPreset(presetId);
  if (built) return lookFromPreset(built);
  const custom = getCustomPreset(presetId);
  if (custom) return lookFromCustom(custom);
  throw new ShortsError("Pick a preset");
}

function checkEngine(engine: Engine) {
  const mode = engineMode();
  if (mode !== "both" && mode !== engine) {
    throw new ShortsError(mode === "open" ? "This install runs open-source models only (Settings → Engine mode)" : "This install runs cloud models only (Settings → Engine mode)", 422);
  }
}

const fileTitle = (name?: string) =>
  (name ?? "")
    .replace(/\.[a-z0-9]{2,4}$/i, "")
    .replace(/[_-]+/g, " ")
    .trim()
    .slice(0, 40);

/** The plan input for a request: model, look, clip facts (from its header when it has one). */
async function planInput(body: ShortsBody, opts: { probe: boolean }): Promise<{ input: ShortsPlanInput; info: SourceInfo }> {
  return planWith(body, opts.probe ? await probeSource(body.source.url) : {});
}

/** planInput with the clip's header already read (`{}`: the browser's numbers only). */
function planWith(body: ShortsBody, info: SourceInfo): { input: ShortsPlanInput; info: SourceInfo } {
  checkEngine(body.engine);
  // Without one asked for: the engine's first restyle model switched on in Settings → Models & licences.
  const modelId = body.modelId && SHORTS_MODELS[body.engine].includes(body.modelId) ? body.modelId : firstOn(SHORTS_MODELS[body.engine], body.engine)!;
  const look = body.look ?? lookFor(body.presetId);
  const duration = info.duration ?? body.source.duration;
  const fps = info.fps ?? body.source.fps;
  const problem = rangeProblem(body.range, duration) ?? clipShapeProblem(info.width ?? body.source.width, info.height ?? body.source.height);
  if (problem) throw new ShortsError(problem);
  // Every segment has to be a clip the restyle model takes (a cut outside its window is paid for, then refused).
  const limits = sourceSeconds(modelId);
  const segments = planSegments(body.range, body.engine, { modelId, fps });
  const odd = segments.map((s) => clipLengthProblem({ name: getModel(modelId)?.name ?? modelId, minSeconds: limits.min, maxSeconds: limits.max }, s.end - s.start)).find(Boolean);
  if (odd) throw new ShortsError(`${odd} per segment — pick another model`);
  // Fuobe Shorts in the cloud: fal's Wan 2.2 Fun VACE takes 17 frames or more, at 5 fps or more.
  const vace = modelId === SHORTS_ORIGINAL && body.engine === "cloud" ? segments.map((s) => originalSegmentProblem(s.end - s.start, fps)).find(Boolean) : null;
  if (vace) throw new ShortsError(`${vace} — or pick another model`);
  // A custom preset without words on a words-only model would restyle from nothing but "the look of the reference images".
  if (look.custom && !look.described && body.engine === "cloud" && !maxRefsFor(modelId, "cloud")) {
    const readers = SHORTS_MODELS.cloud.filter((id) => maxRefsFor(id, "cloud") > 0).map((id) => getModel(id)?.name ?? id);
    throw new ShortsError(`${getModel(modelId)?.name ?? "This model"} restyles from words only — describe the look in your preset, or pick ${readers.join(" or ")}`, 422);
  }
  const name = fileTitle(body.source.name);
  return {
    info,
    input: {
      engine: body.engine,
      title: name ? `${look.name} · ${name}` : `${look.name} short`,
      // Unknown sound (a container the header reader doesn't know) is treated as present.
      source: {
        url: body.source.url,
        duration,
        // Sound we couldn't read counts as none: a soundtrack step fed a silent file fails after every restyle was paid for.
        hasAudio: info.hasAudio ?? false,
        width: info.width ?? body.source.width,
        height: info.height ?? body.source.height,
        ...(fps ? { fps } : {}),
      },
      range: body.range,
      look,
      aspectRatio: body.aspectRatio,
      language: body.language || "auto",
      modelId,
      maxRefs: maxRefsFor(modelId, body.engine),
      resolution: resolutionFor(modelId, body.engine),
      reframes: body.engine === "open" || reframes(modelId, body.engine),
      // What of the clip's sound goes back: the cloud puts it all back (DBS runs on your GPU).
      ...(body.originalSound && { originalSound: originalSoundOn(body.originalSound, body.engine) }),
    },
  };
}

const withChain = (s: PlanStep) => ({ ...s.request, ...(s.chain ? { chain: s.chain } : {}) });

/** Price and run mode of some steps, as createPipeline would make them. */
function priceSteps(steps: PlanStep[]): { costUsd: number | null; demo: boolean } {
  let cost: number | null = 0;
  let demo = false;
  for (const s of steps) {
    const p = previewChained(withChain(s), s.after?.length ?? 0);
    demo ||= p.demo;
    cost = cost === null || p.costUsd === null ? null : cost + p.costUsd;
  }
  return { costUsd: cost === null ? null : Math.round(cost * 10000) / 10000, demo };
}

export interface ShortsEstimate {
  costUsd: number | null;
  /** One segment's restyle (what Regenerate costs). */
  perSegmentUsd: number | null;
  demo: boolean;
  segments: number;
  seconds: number;
  refsSent: number;
  notes: string[];
}

function notesFor(input: ShortsPlanInput, segments: number): string[] {
  const notes: string[] = [];
  const refs = input.look.references?.length ?? 0;
  const original = input.modelId === SHORTS_ORIGINAL;
  if (refs && input.engine === "cloud" && !input.maxRefs) notes.push(`${getModel(input.modelId)?.name ?? "This model"} restyles from words only — pick Kling O3 4K Edit or Happy Horse to use your reference images`);
  if (refs > SHORTS.openReferences && (input.engine === "open" || original)) notes.push(`${original ? "Fuobe Shorts" : "The open engine"} uses your first ${SHORTS.openReferences} reference images (on each segment's first frame)`);
  if (original) {
    const fps = input.source.fps;
    if (input.engine === "cloud") {
      notes.push(`Fuobe Shorts draws each segment's first frame in the look (Qwen-Image-Edit 2511), then Wan 2.2 Fun VACE carries it through every frame by depth${segments > 1 ? `: ${segments} segments, joined with the clip's own sound` : ""}`);
      if (fps && fps > SHORTS.original.billFps + 0.5) notes.push(`fal bills this clip's ${Math.round(fps)} fps as ${(fps / SHORTS.original.billFps).toFixed(1)}× its length (video seconds at ${SHORTS.original.billFps} fps)`);
      if (vaceDownsample(fps)) notes.push(`Wan 2.2 Fun VACE works this ${Math.round(fps!)} fps clip at ${Math.round(fps! / (vaceDownsample(fps) + 1))} fps and brings it back to its own rate`);
    } else notes.push("Fuobe Shorts on your GPU renders 480p at 16 fps, 5 s a segment");
  }
  if (input.engine === "cloud") {
    const { width: w, height: h } = input.source;
    if (!input.reframes && w && h && needsFit(input.source, input.aspectRatio)) notes.push(`Your ${w}×${h} clip is centre-cropped to ${input.aspectRatio} before the restyle`);
  }
  return notes;
}

/** What a session would cost and how it would run, without creating anything. */
export async function estimateShorts(body: ShortsBody): Promise<ShortsEstimate> {
  return estimateWith(body, {});
}

/** estimateShorts for a clip whose header was read already (Assist prices with its sound and length). */
export function estimateWith(body: ShortsBody, info: SourceInfo): ShortsEstimate {
  const { input } = planWith(body, info);
  const plan = planShorts(input);
  const all = priceSteps(plan.steps);
  const one = priceSteps(planTake(input, plan.segments[0], plan.segments.length).steps);
  return {
    ...all,
    perSegmentUsd: one.costUsd,
    segments: plan.segments.length,
    seconds: Math.round((input.range.end - input.range.start) * 10) / 10,
    refsSent: input.engine === "open" ? Math.min(SHORTS.openReferences, input.look.references?.length ?? 0) : Math.min(input.maxRefs, input.look.references?.length ?? 0),
    notes: notesFor(input, plan.segments.length),
  };
}

// ---------------------------------------------------------------------------
// Sessions

/** A plan's steps as the requests they make, with how many earlier steps each waits for (account-tool-run.ts ToolStep). */
export const shortsSteps = (steps: PlanStep[]): { request: GenerationRequest; deps: number }[] => steps.map((s) => ({ request: withChain(s), deps: s.after?.length ?? 0 }));

/** The steps made, or the planner's words as a 422. */
function pipelineOf(steps: PlanStep[], opts?: { batchId: string }): ReturnType<typeof createPipeline> {
  try {
    return createPipeline(steps, opts);
  } catch (e) {
    throw new ShortsError((e as Error).message, 422);
  }
}

/** A new session planned (the clip's header read, every step planned), not started yet. */
export interface SessionRun {
  body: ShortsBody;
  input: ShortsPlanInput;
  info: SourceInfo;
  plan: ReturnType<typeof planShorts>;
}

/** Plan a session as it will start; `known` is the clip's header when the caller read it already (else it's read here). */
export async function planSessionRun(body: ShortsBody, known?: SourceInfo): Promise<SessionRun> {
  roomForSession();
  const { input, info } = known ? planWith(body, known) : await planInput(body, { probe: true });
  // An account's preset is its own (lookFor), and so must its pictures still be.
  const who = whose();
  if (who && input.look.references?.length) ownReferences(who, input.look.references);
  return { body, input, info, plan: planShorts(input) };
}

/** The files a session's runs take (its clip and its look's pictures): an account's run is checked for them first. */
export function sessionFiles(id: string): string[] {
  const s = readSession(id);
  return [s.source.url, ...(s.look.references ?? [])];
}

/** Start a session; `known` is the clip's header when the caller read it already (else it's read here). */
export async function createSession(body: ShortsBody, known?: SourceInfo): Promise<ShortsSession> {
  return startSession(await planSessionRun(body, known));
}

/** Start a planned session: its steps are made, and the session that records them is stored. */
export function startSession(run: SessionRun): ShortsSession {
  const { body, input, info, plan } = run;
  // Checked again with nothing awaited before the session is stored: a full account starts nothing.
  roomForSession();
  const pipeline = pipelineOf(plan.steps);
  const id = (k: string) => pipeline.byKey[k].id;
  const now = Date.now();
  const segments: ShortsSessionSegment[] = plan.segments.map((s, i) => {
    const t = plan.takes[i];
    return { ...s, takes: [takeOf(t, id, now)], primary: id(t.look) };
  });
  const takeKeys = new Set(plan.takes.flatMap((t) => [t.cut, t.look, ...(t.fit ? [t.fit] : []), ...(t.still ? [t.still] : []), ...(t.frame ? [t.frame] : [])]));
  const stitch: ShortsStitch = {
    ids: plan.steps.filter((s) => !takeKeys.has(s.key)).map((s) => id(s.key)),
    final: id(plan.final!),
    clips: segments.map((s) => s.primary),
    createdAt: now,
  };
  return insertSession({
    title: input.title,
    engine: input.engine,
    batchId: pipeline.batchId,
    look: input.look,
    source: {
      url: input.source.url,
      name: body.source.name,
      duration: input.source.duration,
      hasAudio: input.source.hasAudio,
      width: info.width,
      height: info.height,
      ...(input.source.fps ? { fps: input.source.fps } : {}),
    },
    range: input.range,
    settings: { aspectRatio: input.aspectRatio, language: input.language, modelId: input.modelId, resolution: input.resolution, maxRefs: input.maxRefs, reframes: input.reframes, ...(input.originalSound && input.originalSound !== "everything" && { originalSound: input.originalSound }) },
    segments,
    stitches: [stitch],
    createdAt: now,
    updatedAt: now,
  });
}

/** A take's generations by role, from its steps' keys. */
function takeOf(t: TakeKeys, id: (key: string) => string, createdAt: number): ShortsTake {
  return {
    cut: id(t.cut),
    ...(t.fit ? { fit: id(t.fit) } : {}),
    ...(t.still ? { still: id(t.still) } : {}),
    ...(t.frame ? { frame: id(t.frame) } : {}),
    look: id(t.look),
    createdAt,
  };
}

/** Every generation a session made. */
export function sessionIds(s: ShortsSession): string[] {
  const ids = [
    ...s.segments.flatMap((g) => g.takes.flatMap((t) => [t.cut, ...(t.fit ? [t.fit] : []), ...(t.still ? [t.still] : []), ...(t.frame ? [t.frame] : []), ...(t.enhance?.smooth ? [t.enhance.smooth] : []), t.look])),
    ...s.stitches.flatMap((x) => [...x.ids, x.final]),
  ];
  return [...new Set(ids)];
}

export interface ShortsSessionView extends ShortsSession {
  /** The session's generations by id (trashed or deleted ones are missing). */
  generations: Record<string, Generation>;
}

export function getSession(id: string): ShortsSessionView {
  const s = readSession(id);
  const generations: Record<string, Generation> = {};
  for (const gid of sessionIds(s)) {
    const g = getGeneration(gid);
    if (g) generations[gid] = g;
  }
  return { ...s, generations };
}

export interface ShortsSessionCard {
  id: string;
  title: string;
  engine: Engine;
  lookName: string;
  segments: number;
  seconds: number;
  createdAt: number;
  updatedAt: number;
  /** The newest stitch's video, else the first segment's chosen take. */
  cover: Generation | null;
  status: "rendering" | "ready" | "failed";
}

/** A session's History card, from its line and its generations as they are now. */
function cardOf(s: { id: string; title: string; createdAt: number; updatedAt: number }, l: SessionLine): ShortsSessionCard {
  const final = l.final ? getGeneration(l.final) : null;
  const looks = l.primaries.map((id) => getGeneration(id));
  const active = [final, ...looks].some((g) => g && (g.status === "queued" || g.status === "running"));
  const failed = [final, ...looks].some((g) => !g || g.status === "failed" || g.status === "canceled");
  return {
    id: s.id,
    title: s.title,
    engine: l.engine,
    lookName: l.lookName,
    segments: l.segments,
    seconds: l.seconds,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    cover: final?.status === "succeeded" ? final : (looks.find((g) => g?.status === "succeeded") ?? final ?? looks[0] ?? null),
    status: active ? "rendering" : failed ? "failed" : "ready",
  };
}

export function listSessions(limit = 60): ShortsSessionCard[] {
  const who = whose();
  if (who === undefined) {
    const rows = db().prepare("SELECT * FROM shorts_sessions ORDER BY created_at DESC LIMIT ?").all(limit) as SessionRow[];
    return rows.map((r) => {
      const s = toSession(r);
      return cardOf(s, lineOf(s));
    });
  }
  if (!who) return [];
  return listAccountProjects<SessionLine>(who, SESSION_KIND)
    .filter((p) => p.summary)
    .sort((x, y) => y.createdAt - x.createdAt)
    .slice(0, limit)
    .map((p) => cardOf({ id: p.id, title: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt }, p.summary!));
}

export function renameSession(id: string, title: string): ShortsSession {
  const s = readSession(id);
  return saveSession({ ...s, title: title.trim().slice(0, 120) || s.title });
}

/**
 * Delete a session; its generations move to the Trash (restorable for 30 days) unless `keep`. An account has no Trash
 * (as DELETE /api/generations/<id>): its session's runs are deleted for good, and only ever its own.
 */
export async function deleteSession(id: string, opts: { keep?: boolean } = {}): Promise<number> {
  const s = readSession(id);
  const who = whose();
  if (who === undefined) {
    const trashed = opts.keep ? 0 : trashGenerations(sessionIds(s));
    db().prepare("DELETE FROM shorts_sessions WHERE id = ?").run(id);
    return trashed;
  }
  if (!who || !deleteAccountProject(who, SESSION_KIND, id)) throw new ShortsError(GONE, 404);
  return opts.keep ? 0 : deleteForever(sessionIds(s).filter((g) => generationAccount(g) === who));
}

const segmentAt = (s: ShortsSession, index: number) => {
  const seg = s.segments[index];
  if (!seg) throw new ShortsError("No such segment", 404);
  return seg;
};

const usable = (id: string) => {
  const g = getGeneration(id);
  return !!g && g.status !== "failed" && g.status !== "canceled";
};

/** A new take of one segment planned, not started yet. */
export interface TakeRun {
  id: string;
  index: number;
  steps: PlanStep[];
  keys: TakeKeys;
}

/** Plan a new take of one segment (a fresh seed). */
export function planTakeRun(id: string, index: number): TakeRun {
  const s = readSession(id);
  const seg = segmentAt(s, index);
  checkEngine(s.engine);
  const seed = Math.floor(Math.random() * 2 ** 31);
  const take = planTake(sessionPlanInput(s, seed), seg, s.segments.length, `r${seg.takes.length}`);
  return { id, index, steps: take.steps, keys: take.keys };
}

/** Start a planned take. It becomes the chosen take when the current one failed or is gone. */
export function startTake(run: TakeRun): ShortsSessionView {
  // Read again before anything is made: the session may have gone meanwhile.
  const s = readSession(run.id);
  segmentAt(s, run.index);
  const pipeline = pipelineOf(run.steps, { batchId: s.batchId });
  const next = takeOf(run.keys, (k) => pipeline.byKey[k].id, Date.now());
  const segments = s.segments.map((g, i) => (i === run.index ? { ...g, takes: [...g.takes, next], primary: usable(g.primary) ? g.primary : next.look } : g));
  saveSession({ ...s, segments });
  return getSession(run.id);
}

/** A new take of one segment (a fresh seed). It becomes the chosen take when the current one failed or is gone. */
export function regenerateSegment(id: string, index: number): ShortsSessionView {
  return startTake(planTakeRun(id, index));
}

/**
 * Enhance (H3 regenerate) one segment's chosen take: RIFE to 24 fps, then Open-H3 Regenerate at 1080p from the segment's
 * restyle words (planEnhance). On your GPU only, so an open-source short; Engine mode "Paid APIs only" refuses it. The
 * result is a new take beside the others, to compare and pick.
 */
export function enhanceSegment(id: string, index: number): ShortsSessionView {
  return startEnhance(planEnhanceRun(id, index));
}

/** An Enhance planned (the chosen take's 1080p redraw), not started yet. */
export interface EnhanceRun {
  id: string;
  index: number;
  from: string;
  cut: ShortsTake["cut"];
  plan: ReturnType<typeof planEnhance>;
}

/**
 * Plan an Enhance of one segment's chosen take. An account's runs on its own GPU only, and only when that GPU has the
 * memory it needs (own-setup-run.ts): its route checks the steps first (src/server/account-tool-run.ts).
 */
export function planEnhanceRun(id: string, index: number): EnhanceRun {
  const s = readSession(id);
  const seg = segmentAt(s, index);
  // Open-H3 Regenerate needs a 48 GB card: an account runs it on its own GPU when that GPU fits it (own-setup-run.ts),
  // never on this studio's. The owner's waits until it has run on a card that fits it (REGEN_OFFERED): nothing is made.
  if (tenant()) ownSetupGate("regenerate:enhance");
  else if (!REGEN_OFFERED) throw new ShortsError(REGEN_COPY.heldEnhance, 422);
  if (s.engine !== "open") throw new ShortsError(ENHANCE_COPY.cloudSession, 422);
  checkEngine("open");
  const take = seg.takes.find((t) => t.look === seg.primary);
  if (!take) throw new ShortsError(ENHANCE_COPY.notReady, 409);
  if (take.enhance) throw new ShortsError(ENHANCE_COPY.done, 409);
  const g = getGeneration(take.look);
  const url = g?.status === "succeeded" ? g.outputs.find((o) => o.kind === "video")?.url : undefined;
  if (!url) throw new ShortsError(ENHANCE_COPY.notReady, 409);
  let plan: ReturnType<typeof planEnhance>;
  try {
    plan = planEnhance(sessionPlanInput(s), seg, { url }, `e${seg.takes.length}`);
  } catch (e) {
    throw new ShortsError((e as Error).message, 422);
  }
  return { id, index, from: take.look, cut: take.cut, plan };
}

/** Start a planned Enhance: a new take beside the others, to compare and pick. */
export function startEnhance(run: EnhanceRun): ShortsSessionView {
  // Read again before anything is made: the session may have gone meanwhile.
  const s = readSession(run.id);
  segmentAt(s, run.index);
  const { plan } = run;
  const pipeline = pipelineOf(plan.steps, { batchId: s.batchId });
  const next: ShortsTake = {
    cut: run.cut,
    look: pipeline.byKey[plan.keys.look].id,
    enhance: { from: run.from, ...(plan.keys.smooth ? { smooth: pipeline.byKey[plan.keys.smooth].id } : {}) },
    createdAt: Date.now(),
  };
  saveSession({ ...s, segments: s.segments.map((x, i) => (i === run.index ? { ...x, takes: [...x.takes, next] } : x)) });
  return getSession(run.id);
}

/** Use another take of a segment in the stitch. */
export function makePrimary(id: string, index: number, lookId: string): ShortsSessionView {
  const s = readSession(id);
  const seg = segmentAt(s, index);
  if (!seg.takes.some((t) => t.look === lookId)) throw new ShortsError("That take isn't part of this segment");
  saveSession({ ...s, segments: s.segments.map((g, i) => (i === index ? { ...g, primary: lookId } : g)) });
  return getSession(id);
}

/** A second "Stitch again" while the same takes are still being stitched would pay for the same video twice. */
function stitchingNow(s: ShortsSession): void {
  const last = s.stitches[s.stitches.length - 1];
  if (last && stitchCurrent(s) && [...last.ids, last.final].some((gid) => ["queued", "running"].includes(getGeneration(gid)?.status ?? ""))) {
    throw new ShortsError("These takes are already being stitched", 409);
  }
}

/** A stitch of the chosen takes planned, not started yet. No steps: one silent segment, whose take is the short. */
export interface StitchRun {
  id: string;
  steps: PlanStep[];
  final?: string;
  /** The takes it joins (each segment's chosen one when it was planned). */
  clips: string[];
  /** Their videos (an account's run takes only its own files). */
  files: string[];
}

/** Plan joining the chosen takes again (after a regenerate or a new choice), with the sound put back. */
export function planStitchRun(id: string): StitchRun {
  const s = readSession(id);
  checkEngine(s.engine);
  const clips = s.segments.map((seg, i) => {
    const g = getGeneration(seg.primary);
    if (!g) throw new ShortsError(`Segment ${i + 1}'s take was deleted — regenerate it first`, 409);
    if (g.status === "queued" || g.status === "running") throw new ShortsError(`Segment ${i + 1} is still rendering`, 409);
    const url = g.outputs.find((o) => o.kind === "video")?.url;
    if (g.status !== "succeeded" || !url) throw new ShortsError(`Segment ${i + 1} didn't render — regenerate it first`, 409);
    return { url, enhanced: !!seg.takes.find((t) => t.look === seg.primary)?.enhance };
  });
  stitchingNow(s);
  // Enhanced takes are 1080p at 24 fps: the others are brought to 24 fps and the join runs at 1080p (planFinishedStitch).
  const plan = planFinishedStitch(sessionPlanInput(s), clips, `-s${s.stitches.length}`);
  return { id, steps: plan.final ? plan.steps : [], ...(plan.final && { final: plan.final }), clips: s.segments.map((g) => g.primary), files: clips.map((c) => c.url) };
}

/** Start a planned stitch and record it on the session. */
export function startStitch(run: StitchRun): ShortsSessionView {
  // Read again before anything is made: the session may have gone, or a stitch started meanwhile.
  const s = readSession(run.id);
  stitchingNow(s);
  const now = Date.now();
  let stitch: ShortsStitch;
  if (!run.steps.length || !run.final) {
    // One silent segment: its take is the short.
    stitch = { ids: [], final: run.clips[0], clips: run.clips, createdAt: now };
  } else {
    const pipeline = pipelineOf(run.steps, { batchId: s.batchId });
    stitch = { ids: run.steps.map((x) => pipeline.byKey[x.key].id), final: pipeline.byKey[run.final].id, clips: run.clips, createdAt: now };
  }
  saveSession({ ...s, stitches: [...s.stitches, stitch] });
  return getSession(run.id);
}

/** Join the chosen takes again (after a regenerate or a new choice) and put the sound back. */
export function stitchSession(id: string): ShortsSessionView {
  return startStitch(planStitchRun(id));
}

/** What one more take of a segment costs. */
export function regenerateCost(s: ShortsSession): number | null {
  try {
    return priceSteps(planTake(sessionPlanInput(s, 1), s.segments[0], s.segments.length).steps).costUsd;
  } catch {
    return null;
  }
}
