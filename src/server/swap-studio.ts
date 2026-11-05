import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { nanoid } from "nanoid";
import { originalSoundOn, type OriginalSound } from "@/lib/av/original-sound";
import { addKeyMessage } from "@/lib/your-keys";
import { z } from "zod";
import { getModel } from "@/lib/catalog";
import { ANCHOR_MODELS, anchorModel, CHARACTER_SWAP, h3Canvas, SWAP_LORAS, swapLoraRef, TURBO_LORA } from "@/lib/catalog/character-swap";
import { scalePoints } from "@/lib/catalog/remove-object";
import type { PlanStep } from "@/lib/catalog/shorts";
import {
  assemblyPieces,
  assemblyTakes,
  chosenTakes,
  clipNeedsPreview,
  clipProblem,
  currentSegments,
  DEFAULT_SETTINGS,
  defaultMaskBase,
  exportDecisions,
  freezeTake,
  maskPieces,
  maskProblem,
  masterKeep,
  newShot,
  normalizedSize,
  planQueue,
  segmentPrompt,
  segmentStates,
  settingSignature,
  autoSelect,
  SWAP_STUDIO,
  uid,
  WORKERS_NOTE,
  type DecisionExport,
  type GenSummary,
  type StudioEstimate,
  type SwapProjectCard,
  type SwapProjectView,
  type MaskVersion,
  type QueueMode,
  type SwapClip,
  type SwapProject,
  type SwapSegment,
  type SwapShot,
  type SwapTake,
  type TakeFinish,
  type TranscriptCue,
  usedFinish,
} from "@/lib/catalog/swap-studio";
import { applyEdit, EditError, type SwapEdit } from "@/lib/catalog/swap-studio-edit";
import { cloudMaskCut, frozenTakePlan, planAnchor, planAssembly, planMask, planNormalize, planPreview, planTakeFinish, planTranscribe, STUDIO_MODELS } from "@/lib/catalog/swap-studio-plan";
import { REGEN_MODEL } from "@/lib/catalog/regenerate";
import { COMPOSITE_MODEL, filmSize, SHARPEN_COPY, SHARPEN_TIERS, sharpenOptions, sharpenTierFor, type SharpenTier } from "@/lib/catalog/sharpen";
import type { Engine, Generation, PixelPoint } from "@/lib/catalog/types";
import { ACCESS_PLACE } from "@/lib/model-access";
import { paidAllowed } from "./account-keys";
import { AccountProjectError, accountProjectsWith, createAccountProject, deleteAccountProject, getAccountProject, listAccountProjects, updateAccountProject } from "./account-projects";
import type { ToolStep } from "./account-tool-run";
import { silenceWriter } from "./canvas";
import { createPipeline } from "./chains";
import { db } from "./db";
import { AccountRunError, asAccount, cancelGeneration, getGeneration, OPEN_ONLY_RUN, previewChained } from "./generations";
import { isOffered, offeredLoras } from "./model-access";
import { engineMode } from "./settings";
import { probeSource, ShortsError } from "./shorts";
import { tenant, tenantAccount } from "./tenant";

/**
 * Character Swap Studio on the server (/character-swap): projects in swap_projects (one JSON document each, see
 * src/lib/catalog/swap-studio.ts), every job an ordinary generation made through createPipeline (feature
 * "swap-studio-step", hidden from the Library; the assembled clip is "swap-studio" and lands in the Library). The
 * document names the generations; whoever reads a project (the page's poll, or the sweep below) fills in what they
 * made and launches takes that were waiting for the segments they continue from.
 *
 * A signed-in account (public sign-up) has projects of its own, kept in its account projects (account-projects.ts,
 * kind "swap"): inside its own work (asAccount, tenant.ts) every read and change here is of its own projects only, and
 * its jobs are its own runs on its own ComfyUI or fal.ai key. Its routes plan each job first (planSwapRun: nothing made
 * or saved), check it as every account run is checked, then start it (startSwapRun). See swap-studio-account.ts.
 */

export { ShortsError as StudioError };
export type { StudioEstimate, SwapProjectCard, SwapProjectView };

// ---------------------------------------------------------------------------
// Rows

interface Row {
  id: string;
  name: string;
  engine: string;
  data_json: string;
  revision: number;
  waiting: number;
  created_at: number;
  updated_at: number;
}

const rowOf = (id: string) => db().prepare("SELECT * FROM swap_projects WHERE id = ?").get(id) as Row | undefined;

function fromRow(r: Row): SwapProject {
  const d = JSON.parse(r.data_json) as SwapProject;
  return { ...d, id: r.id, name: r.name, engine: r.engine === "open" ? "open" : "cloud", revision: r.revision, createdAt: r.created_at, updatedAt: r.updated_at };
}

const takesOf = (p: SwapProject) => p.clips.flatMap((c) => c.shots.flatMap((s) => (s.segments ?? []).flatMap((g) => g.takes)));

/** An account's projects in account-projects.ts. */
export const ACCOUNT_KIND = "swap";

/** What an account's list shows of a project (its summary): the card without its id, name and time. */
type CardSummary = Omit<SwapProjectCard, "id" | "name" | "updatedAt">;

function cardSummary(p: SwapProject, waiting: number): CardSummary {
  return {
    engine: p.engine,
    clips: p.clips.length,
    shots: p.clips.reduce((n, c) => n + c.shots.length, 0),
    swapped: p.clips.reduce((n, c) => n + c.shots.filter((s) => s.mode === "generate").length, 0),
    assembled: p.clips.filter((c) => c.assembly?.genId).length,
    waiting,
    character: p.character.image,
  };
}

/** A project's change that doesn't fit an account's store (too big, too many): its own words and status. */
function accountRefused<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof AccountProjectError) throw new ShortsError(e.message, e.status);
    throw e;
  }
}

function write(p: SwapProject): SwapProject {
  const next = { ...p, revision: p.revision + 1, updatedAt: Date.now() };
  // An account's job being planned (planSwapRun): nothing is saved.
  if (runScope()?.dry) return next;
  const waiting = takesOf(next).filter((t) => t.state === "waiting").length;
  const t = tenant();
  if (t?.kind === "guest") throw new ShortsError("Project not found", 404);
  if (t?.kind === "account") {
    const saved = accountRefused(() => updateAccountProject(t.id, ACCOUNT_KIND, next.id, { name: next.name, data: next, summary: cardSummary(next, waiting) }));
    if (!saved) throw new ShortsError("Project not found", 404);
    return { ...next, name: saved.name, updatedAt: saved.updatedAt };
  }
  db()
    .prepare("UPDATE swap_projects SET name = ?, engine = ?, data_json = ?, revision = ?, waiting = ?, updated_at = ? WHERE id = ?")
    .run(next.name, next.engine, JSON.stringify(next), next.revision, waiting, next.updatedAt, next.id);
  return next;
}

/**
 * The project with this id that the asker may read: the owner's, or inside an account's work only that account's own
 * (another account's, or the owner's, is not found, the same as one that doesn't exist). A guest has none.
 */
function load(id: string): SwapProject | null {
  const t = tenant();
  if (t?.kind === "guest") return null;
  if (t?.kind === "account") {
    const r = getAccountProject<SwapProject>(t.id, ACCOUNT_KIND, id);
    return r ? { ...r.data, id: r.id, name: r.name, engine: r.data.engine === "open" ? "open" : "cloud", createdAt: r.createdAt, updatedAt: r.updatedAt } : null;
  }
  const r = rowOf(id);
  return r ? fromRow(r) : null;
}

function mustProject(id: string): SwapProject {
  const p = load(id);
  if (!p) throw new ShortsError("Project not found", 404);
  return p;
}


/** Change a project in one synchronous read-modify-write (no await inside: nothing else runs between). */
function mutate(id: string, fn: (p: SwapProject) => SwapProject): SwapProject {
  const cur = mustProject(id);
  const next = fn(cur);
  return next === cur ? cur : write(next);
}

function mustClip(p: SwapProject, clipId: string): SwapClip {
  const c = p.clips.find((x) => x.id === clipId);
  if (!c) throw new ShortsError("That clip is no longer in this project — reload", 404);
  return c;
}
function mustShot(c: SwapClip, shotId: string): SwapShot {
  const s = c.shots.find((x) => x.id === shotId);
  if (!s) throw new ShortsError("That shot changed — reload", 404);
  return s;
}

const mapClip = (p: SwapProject, id: string, f: (c: SwapClip) => SwapClip): SwapProject => ({ ...p, clips: p.clips.map((c) => (c.id === id ? f(c) : c)) });
const mapShot = (c: SwapClip, id: string, f: (s: SwapShot) => SwapShot): SwapClip => ({ ...c, shots: c.shots.map((s) => (s.id === id ? f(s) : s)) });

// ---------------------------------------------------------------------------
// Generations as the studio reads them

const mainOutput = (g: Generation) => g.outputs.find((o) => o.meta?.role !== "master") ?? g.outputs[0];
const masterOutput = (g: Generation) => g.outputs.find((o) => o.meta?.role === "master");

export function genSummary(g: Generation): GenSummary {
  const main = mainOutput(g);
  const master = masterOutput(g);
  return {
    status: g.status,
    progress: g.progress,
    message: g.message,
    error: g.error,
    ...(main ? { url: main.url } : {}),
    ...(master ? { master: master.url } : {}),
    costUsd: g.costUsd,
    demo: g.provider === "mock",
  };
}

/**
 * One lookup per id for the duration of a read. Inside an account's work only its own runs are found (its projects name
 * nothing else; this keeps it so).
 */
function lookup(): (id: string | undefined) => Generation | null {
  const cache = new Map<string, Generation | null>();
  const account = tenantAccount();
  return (id) => {
    if (!id) return null;
    if (!cache.has(id)) {
      const g = getGeneration(id, { includeDeleted: true });
      cache.set(id, g && account && g.request.account !== account ? null : g);
    }
    return cache.get(id)!;
  };
}

const ACTIVE = new Set(["queued", "running"]);

/** Every generation a project names. */
function projectGenIds(p: SwapProject): string[] {
  const ids: (string | undefined)[] = [];
  for (const c of p.clips) {
    ids.push(c.normalized?.genId, c.preview?.genId, c.transcript?.genId, c.assembly?.genId, ...(c.assembly?.stepIds ?? []));
    for (const s of c.shots) {
      for (const m of s.masks) ids.push(m.genId, ...(m.stepIds ?? []), ...m.pieces.map((x) => x.genId));
      for (const a of s.anchors) ids.push(a.genId, ...(a.stepIds ?? []));
      for (const g of s.segments ?? []) {
        for (const a of g.anchors) ids.push(a.genId, ...(a.stepIds ?? []));
        for (const t of g.takes) ids.push(t.genId, ...(t.stepIds ?? []), t.finish?.genId, ...(t.finish?.stepIds ?? []));
      }
    }
  }
  return [...new Set(ids.filter((x): x is string => !!x))];
}

/** The transcript's cues (with the speakers a diarizing transcriber names). */
function cuesOf(g: Generation): TranscriptCue[] {
  const raw = g.outputs.find((o) => Array.isArray(o.meta?.cues))?.meta?.cues as unknown[] | undefined;
  const out: TranscriptCue[] = [];
  for (const c of raw ?? []) {
    const x = c as Partial<TranscriptCue>;
    if (typeof x.start !== "number" || typeof x.end !== "number" || typeof x.text !== "string") continue;
    out.push({ start: x.start, end: x.end, text: x.text, ...(typeof x.speaker === "string" && x.speaker ? { speaker: x.speaker } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Settling: fill in what finished, select finished takes, launch or stop waiting ones

type Look = ReturnType<typeof lookup>;

function settleShot(project: SwapProject, clip: SwapClip, shot: SwapShot, look: Look, shotIndex: number): SwapShot {
  const done = (id?: string) => {
    const g = look(id);
    return g?.status === "succeeded" ? g : null;
  };
  let s = shot;
  // Masks: each piece's video once it is made (the matte).
  if (s.masks.some((m) => m.pieces.some((x) => x.genId && !x.url && done(x.genId)))) {
    s = { ...s, masks: s.masks.map((m) => ({ ...m, pieces: m.pieces.map((x) => (x.genId && !x.url && done(x.genId) ? { ...x, url: mainOutput(done(x.genId)!)?.url } : x)) })) };
  }
  // Anchors: the edited image.
  const fill = <T extends { genId?: string; url?: string }>(list: T[]) => list.map((a) => (a.genId && !a.url && done(a.genId) ? { ...a, url: mainOutput(done(a.genId)!)?.url } : a));
  if (s.anchors.some((a) => a.genId && !a.url && done(a.genId))) s = { ...s, anchors: fill(s.anchors) };
  if (!s.segments) return s;
  let items = s.segments;
  if (items.some((g) => g.anchors.some((a) => a.genId && !a.url && done(a.genId)))) {
    items = items.map((g) => {
      const anchors = fill(g.anchors);
      // A reference that just came out becomes the segment's pick when it has none (the newest of them).
      const fresh = anchors.filter((a, i) => a.url && !g.anchors[i].url);
      return { ...g, anchors, anchor: g.anchor ?? fresh.at(-1)?.id ?? null };
    });
  }
  // Finished takes: selected when nothing changed since they were queued (Akatz's attach_take).
  const view = { ...s, segments: items };
  let next = items;
  items.forEach((seg, i) => {
    for (const t of seg.takes) {
      if (t.state !== "launched" || t.settled || !t.genId) continue;
      const g = look(t.genId);
      if (!g || ACTIVE.has(g.status)) continue;
      const pick = g.status === "succeeded" && autoSelect(project, clip, view, next[i], t, next);
      next = next.map((x, j) => (j === i ? { ...x, selectedTake: pick ? t.id : x.selectedTake, takes: x.takes.map((k) => (k.id === t.id ? { ...k, settled: true } : k)) } : x));
    }
  });
  if (next !== s.segments) s = { ...s, segments: next };
  return launchWaiting(project, clip, s, look, shotIndex);
}

/** Waiting takes whose segments-before are made launch; those whose segments-before failed stop, with the reason. */
function launchWaiting(project: SwapProject, clip: SwapClip, shot: SwapShot, look: Look, shotIndex: number): SwapShot {
  const items = shot.segments ?? [];
  if (!items.some((g) => g.takes.some((t) => t.state === "waiting"))) return shot;
  const all = items.flatMap((g, i) => g.takes.map((t) => ({ take: t, seg: g, index: i })));
  let out = items;
  const update = (segId: string, take: SwapTake) => {
    out = out.map((g) => (g.id === segId ? { ...g, takes: g.takes.map((t) => (t.id === take.id ? take : t)) } : g));
  };
  // In segment order, so a stop reaches every take after it in the same sweep.
  for (const [i, seg] of items.entries()) {
    for (const take of seg.takes) {
      if (take.state !== "waiting") continue;
      let blocked: string | null = null;
      let ready = true;
      for (const d of take.dependencies) {
        const found = all.find((x) => x.take.id === d.takeId);
        const current = found ? out[found.index].takes.find((t) => t.id === found.take.id)! : null;
        const n = (found?.index ?? items.findIndex((g) => g.id === d.segmentId)) + 1;
        if (!current) {
          blocked = `Stopped: segment ${n}'s take it continues from was removed`;
          break;
        }
        if (current.state === "stopped") {
          blocked = `Stopped: segment ${n}'s take didn't run${current.reason ? ` (${current.reason.replace(/^Stopped: /, "")})` : ""}`;
          break;
        }
        if (current.state === "waiting") {
          ready = false;
          continue;
        }
        const g = look(current.genId);
        if (!g) {
          blocked = `Stopped: segment ${n}'s take is gone from the Library`;
          break;
        }
        if (g.status === "failed" || g.status === "canceled") {
          const why = g.status === "failed" ? "failed" : "was stopped";
          const steps = (current.stepIds ?? []).map((id) => look(id)).find((x) => x?.status === "failed" && x.error);
          blocked = `Stopped: segment ${n}'s take ${why}${steps?.error || g.error ? ` — ${steps?.error ?? g.error}` : ""}`;
          break;
        }
        if (g.status !== "succeeded") ready = false;
      }
      if (blocked) {
        update(seg.id, { ...take, state: "stopped", reason: blocked, waitsOn: undefined });
        continue;
      }
      if (!ready) continue;
      try {
        update(seg.id, launchTake(project, clip, { ...shot, segments: out }, out[i], take, shotIndex, i, look));
      } catch (e) {
        update(seg.id, { ...take, state: "stopped", reason: `Stopped: ${(e as Error).message}`, waitsOn: undefined });
      }
    }
  }
  return out === items ? shot : { ...shot, segments: out };
}

/** What a take continues from: the segment right before it (your GPU continues from it alone; the cloud from its last frame). */
function previousOf(shot: SwapShot, take: SwapTake, look: Look): { master?: string; video?: string; frames: number } | null {
  if (!take.frozen || take.frozen.history <= 0) return null;
  const items = shot.segments ?? [];
  const dep = take.dependencies[take.dependencies.length - 1];
  const before = items.find((g) => g.id === dep?.segmentId);
  const prev = before?.takes.find((t) => t.id === dep?.takeId);
  const g = look(prev?.genId);
  if (!before || !prev || !g) throw new Error("the take it continues from is gone");
  // Your GPU's master holds the take's last `keep` frames (masterKeep); the cloud's take is the segment's length.
  return { master: masterOutput(g)?.url, video: mainOutput(g)?.url, frames: prev.frozen?.keep ?? before.end - before.start };
}

/** Start one take's generations (its segments-before are made). */
function launchTake(project: SwapProject, clip: SwapClip, shot: SwapShot, seg: SwapSegment, take: SwapTake, shotIndex: number, segIndex: number, look: Look): SwapTake {
  const previous = previousOf(shot, take, look);
  const plan = frozenTakePlan(project, clip, shot, seg, take, { shot: shotIndex + 1, segment: segIndex + 1, take: seg.takes.findIndex((t) => t.id === take.id) + 1 }, previous);
  const pipe = run(plan.steps, { batchId: take.batchId });
  return { ...take, state: "launched", waitsOn: undefined, genId: pipe.byKey[plan.final].id, stepIds: pipe.items.map((g) => g.id) };
}

function settleClip(project: SwapProject, clip: SwapClip, look: Look): SwapClip {
  let c = clip;
  const ok = (id?: string) => {
    const g = look(id);
    return g?.status === "succeeded" ? g : null;
  };
  if (c.normalized?.genId && !c.normalized.url && ok(c.normalized.genId)) c = { ...c, normalized: { ...c.normalized, url: mainOutput(ok(c.normalized.genId)!)?.url } };
  if (c.preview?.genId && !c.preview.url && ok(c.preview.genId)) c = { ...c, preview: { ...c.preview, url: mainOutput(ok(c.preview.genId)!)?.url } };
  if (c.transcript?.genId && c.transcript.cues === null && ok(c.transcript.genId)) c = { ...c, transcript: { ...c.transcript, cues: cuesOf(ok(c.transcript.genId)!) } };
  const shots = c.shots.map((s, i) => settleShot(project, c, s, look, i));
  return shots.some((s, i) => s !== c.shots[i]) ? { ...c, shots } : c;
}

/** The project with every finished job filled in and every ready waiting take launched (pure apart from launching). */
function settle(p: SwapProject, look: Look): SwapProject {
  const clips = p.clips.map((c) => settleClip(p, c, look));
  return clips.some((c, i) => c !== p.clips[i]) ? { ...p, clips } : p;
}

/** Read a project and bring it up to date (saved when anything changed). */
export function advanceProject(id: string): SwapProject {
  return mutate(id, (p) => settle(p, lookup()));
}

declare global {
  var __fuobeSwapStudioRunner: ReturnType<typeof setInterval> | undefined;
}

/**
 * The sweep: takes queued behind the segments they continue from launch when those are made (or stop when they
 * failed), also while nobody has the page open. Every 3 s over projects with waiting takes.
 */
export function ensureSwapStudioRunner(): void {
  if (globalThis.__fuobeSwapStudioRunner) return;
  const tick = () => {
    try {
      const rows = db().prepare("SELECT id FROM swap_projects WHERE waiting > 0").all() as { id: string }[];
      for (const r of rows) {
        try {
          advanceProject(r.id);
        } catch (e) {
          console.error(`[swap-studio] ${r.id}:`, (e as Error).message);
        }
      }
    } catch (e) {
      console.error("[swap-studio] sweep:", (e as Error).message);
    }
    // Accounts' projects (public sign-up), each read and advanced inside its own account's work.
    try {
      for (const r of accountProjectsWith(ACCOUNT_KIND, "waiting")) {
        try {
          asAccount(r.accountId, () => advanceProject(r.id));
        } catch (e) {
          console.error(`[swap-studio] ${r.id}:`, (e as Error).message);
        }
      }
    } catch (e) {
      console.error("[swap-studio] sweep:", (e as Error).message);
    }
  };
  // Started at boot (instrumentation.ts) or by the owner's queue: never from inside an account's work, whose context its
  // timers would keep (queueTakes).
  globalThis.__fuobeSwapStudioRunner = setInterval(tick, 3000);
  globalThis.__fuobeSwapStudioRunner.unref?.();
  setTimeout(tick, 500).unref?.();
}

// ---------------------------------------------------------------------------
// Projects


/** The asker's projects, most recently changed first: the owner's, or inside an account's work its own (a guest has none). */
export function listProjects(limit = 100): SwapProjectCard[] {
  const t = tenant();
  if (t?.kind === "guest") return [];
  if (t?.kind === "account") {
    return listAccountProjects<CardSummary>(t.id, ACCOUNT_KIND)
      .slice(0, limit)
      .map((r) => ({ engine: "open", clips: 0, shots: 0, swapped: 0, assembled: 0, waiting: 0, character: null, ...r.summary, id: r.id, name: r.name, updatedAt: r.updatedAt }));
  }
  const rows = db().prepare("SELECT * FROM swap_projects ORDER BY updated_at DESC LIMIT ?").all(limit) as Row[];
  return rows.map((r) => {
    const p = fromRow(r);
    return { id: p.id, name: p.name, ...cardSummary(p, r.waiting), updatedAt: p.updatedAt };
  });
}

const mustMatchMode = (engine: Engine) => {
  const mode = engineMode();
  if (mode !== "both" && mode !== engine) {
    // An account (public sign-up) runs the cloud on its own fal.ai key: its answer opens "Add your key".
    if (tenantAccount() && engine === "cloud") throw new AccountRunError(paidAllowed() ? { error: addKeyMessage("fal"), code: "add-key", provider: "fal" } : { error: OPEN_ONLY_RUN, code: "open-only" });
    throw new ShortsError(mode === "open" ? "This install runs open-source models only (Settings → Engine mode)" : "This install runs cloud models only (Settings → Engine mode)", 422);
  }
};

/** The engine a new project starts on: the install's only one, else your GPU (Akatz's tool is a local workbench). */
export const defaultEngine = (): Engine => (engineMode() === "cloud" ? "cloud" : "open");

export const CreateSchema = z.object({
  name: z.string().max(200).optional(),
  engine: z.enum(["cloud", "open"]).optional(),
  character: z.object({ image: z.string().startsWith("/api/files/").max(500).nullable().optional(), description: z.string().max(SWAP_STUDIO.maxDescriptionChars).optional() }).optional(),
});

export function createProject(body: z.infer<typeof CreateSchema>): SwapProject {
  const engine = body.engine ?? defaultEngine();
  mustMatchMode(engine);
  const now = Date.now();
  const p: SwapProject = {
    id: uid("swap-"),
    name: body.name?.trim().slice(0, SWAP_STUDIO.maxNameChars) || "Untitled character swap",
    engine,
    character: { image: body.character?.image ?? null, description: body.character?.description?.trim() ?? "" },
    defaults: { ...DEFAULT_SETTINGS },
    clips: [],
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
  const t = tenant();
  if (t?.kind === "guest") throw new ShortsError("Create a free account to make a project.", 401);
  // An account's project is its own (account-projects.ts): its id is the one its store gives it.
  if (t?.kind === "account") {
    const made = accountRefused(() => createAccountProject<SwapProject, CardSummary>(t.id, ACCOUNT_KIND, { name: p.name, data: p, summary: cardSummary(p, 0) }));
    return { ...p, id: made.id, name: made.name, createdAt: made.createdAt, updatedAt: made.updatedAt };
  }
  db()
    .prepare("INSERT INTO swap_projects (id, name, engine, data_json, revision, waiting, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)")
    .run(p.id, p.name, p.engine, JSON.stringify(p), now, now);
  return p;
}

/** Delete a project, stopping what it still makes (finished results stay in the Library). */
export async function deleteProject(id: string): Promise<void> {
  const p = mustProject(id);
  const look = lookup();
  const active = projectGenIds(p).filter((g) => ACTIVE.has(look(g)?.status ?? ""));
  const account = tenantAccount();
  if (account) deleteAccountProject(account, ACCOUNT_KIND, id);
  else db().prepare("DELETE FROM swap_projects WHERE id = ?").run(id);
  for (const g of active) await cancelGeneration(g).catch(() => undefined);
}


export function projectView(id: string): SwapProjectView {
  const project = advanceProject(id);
  const look = lookup();
  const gens: Record<string, GenSummary> = {};
  for (const gid of projectGenIds(project)) {
    const g = look(gid);
    if (g) gens[gid] = genSummary(g);
  }
  return { project, gens, workers: WORKERS_NOTE };
}

// ---------------------------------------------------------------------------
// Edits

const fileUrl = z.string().startsWith("/api/files/").max(500);
const role = z.enum(["target", "other", "offscreen", "none"]);
const decision = z.enum(["pending", "keep", "maybe", "skip"]);
const settings = z
  .object({
    lora: z.enum(["v1.5", "v1", "none"]),
    useAnchor: z.boolean(),
    useMask: z.boolean(),
    renderMp: z.union([z.literal(0.5), z.literal(1)]),
    seed: z.number().int(),
    windowFrames: z.number().int(),
    historyFrames: z.number().int(),
    expansion: z.number().int(),
  })
  .partial();
const text = (max: number) => z.string().max(max);
const id = z.string().min(1).max(80);

export const EditSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rename"), name: z.string().max(200) }),
  z.object({ type: z.literal("engine"), engine: z.enum(["cloud", "open"]) }),
  z.object({ type: z.literal("character"), image: fileUrl.nullable().optional(), description: text(SWAP_STUDIO.maxDescriptionChars).optional() }),
  z.object({ type: z.literal("defaults"), settings }),
  z.object({ type: z.literal("clip"), clipId: id, name: z.string().max(200).optional(), review: decision.optional(), reviewNotes: text(SWAP_STUDIO.maxNotesChars).optional() }),
  z.object({ type: z.literal("remove-clip"), clipId: id }),
  z.object({ type: z.literal("detected"), clipId: id, cuts: z.array(z.number().int()).max(2000), dismiss: z.boolean().optional() }),
  z.object({ type: z.literal("cuts"), clipId: id, cuts: z.array(z.number().int()).max(2000), modes: z.array(z.enum(["generate", "preserve"])).max(2001).optional() }),
  z.object({ type: z.literal("voices"), clipId: id, voices: z.record(z.string().max(80), role) }),
  z.object({
    type: z.literal("shot"),
    clipId: id,
    shotId: id,
    patch: z.object({
      mode: z.enum(["generate", "preserve"]).optional(),
      speaker: role.nullable().optional(),
      dialogue: text(SWAP_STUDIO.maxPromptChars).nullable().optional(),
      prompt: text(SWAP_STUDIO.maxPromptChars).nullable().optional(),
      who: z.object({ selection: z.enum(["largest", "leftmost", "rightmost", "index"]), index: z.number().int(), words: z.string().max(200) }).partial().optional(),
      settings: settings.optional(),
      anchorInstructions: text(SWAP_STUDIO.maxPromptChars).optional(),
      anchorBasePrompt: text(SWAP_STUDIO.maxPromptChars).optional(),
      approvedAnchor: id.nullable().optional(),
      approvedMask: id.nullable().optional(),
    }),
  }),
  z.object({ type: z.literal("build-prompts"), clipId: id, shotId: id.optional() }),
  z.object({
    type: z.literal("layout"),
    clipId: id,
    shotId: id,
    op: z.discriminatedUnion("op", [
      z.object({ op: z.literal("partition"), frames: z.number().int() }),
      z.object({ op: z.literal("split"), frame: z.number().int() }),
      z.object({ op: z.literal("merge"), index: z.number().int() }),
      z.object({ op: z.literal("boundary"), index: z.number().int(), frame: z.number().int() }),
    ]),
  }),
  z.object({
    type: z.literal("segment"),
    clipId: id,
    shotId: id,
    segmentId: id,
    patch: z.object({
      prompt: text(SWAP_STUDIO.maxPromptChars).optional(),
      performancePrompt: text(SWAP_STUDIO.maxPromptChars).nullable().optional(),
      dialogue: text(SWAP_STUDIO.maxPromptChars).nullable().optional(),
      speaker: role.nullable().optional(),
      seed: z.number().int().optional(),
      connection: z.enum(["start", "continue"]).optional(),
      history: z.number().int().optional(),
      anchorMode: z.enum(["shot", "custom", "none"]).optional(),
      anchor: id.nullable().optional(),
    }),
  }),
  z.object({ type: z.literal("update-prompt"), clipId: id, shotId: id, segmentId: id }),
  z.object({
    type: z.literal("take"),
    clipId: id,
    shotId: id,
    segmentId: id,
    takeId: id,
    select: z.boolean().optional(),
    favourite: z.boolean().optional(),
    decision: decision.optional(),
    notes: text(SWAP_STUDIO.maxNotesChars).optional(),
    remove: z.boolean().optional(),
    /** Use its sharper version in the assembly (or the take itself again). */
    finishUse: z.boolean().optional(),
  }),
  z.object({ type: z.literal("anchor-import"), clipId: id, shotId: id, segmentId: id.optional(), url: fileUrl }),
  z.object({ type: z.literal("remove-anchor"), clipId: id, shotId: id, segmentId: id.optional(), anchorId: id }),
  z.object({ type: z.literal("remove-mask"), clipId: id, shotId: id, maskId: id }),
]);

export type EditBody = z.infer<typeof EditSchema>;

/**
 * Apply one edit from the page (src/lib/catalog/swap-studio-edit.ts), on the project as it is now. Jobs the edit leaves
 * nothing to point at (a removed clip's or a re-cut shot's masks, anchors, copies and words) are stopped: their
 * generations are hidden helpers, so nobody could find, stop or use them afterwards.
 */
export async function editProject(projectId: string, body: EditBody): Promise<SwapProject> {
  const look = lookup();
  const active = (gid: string) => ACTIVE.has(look(gid)?.status ?? "");
  const after: { engine: Engine | null; orphans: string[] } = { engine: null, orphans: [] };
  const next = mutate(projectId, (cur) => {
    const p = settle(cur, look);
    const edit: SwapEdit = body.type === "anchor-import" ? { ...body, id: uid("anchor-"), at: Date.now() } : (body as SwapEdit);
    if (edit.type === "engine" && edit.engine !== p.engine) {
      mustMatchMode(edit.engine);
      after.engine = edit.engine;
    }
    // Only a sharper version that came out can be picked for the assembly.
    if (edit.type === "take" && edit.finishUse) {
      const clip = mustClip(p, edit.clipId);
      const t = currentSegments(mustShot(clip, edit.shotId))
        .find((g) => g.id === edit.segmentId)
        ?.takes.find((k) => k.id === edit.takeId);
      if (!t?.finish || look(t.finish.genId)?.status !== "succeeded") throw new ShortsError("Only a finished sharper version can be used", 422);
    }
    // Only a take that came out can be chosen.
    if (edit.type === "take" && edit.select) {
      const clip = mustClip(p, edit.clipId);
      const seg = currentSegments(mustShot(clip, edit.shotId)).find((g) => g.id === edit.segmentId);
      const t = seg?.takes.find((k) => k.id === edit.takeId);
      if (t && look(t.genId)?.status !== "succeeded") throw new ShortsError("Only a finished take can be chosen", 422);
    }
    let out: SwapProject;
    try {
      out = applyEdit(p, edit, { active });
    } catch (e) {
      if (e instanceof EditError) throw new ShortsError(e.message, e.status);
      throw e;
    }
    const kept = new Set(projectGenIds(out));
    after.orphans = projectGenIds(p).filter((g) => !kept.has(g) && active(g));
    return out;
  });
  for (const g of after.orphans) await cancelGeneration(g).catch(() => undefined);
  // An account's copies are runs of its own, started from the clip's "Prepare at 24 fps" (the checks every run gets).
  if (!after.engine || tenantAccount()) return next;
  // Switched engines: on your GPU the clips need their 24 fps copies, on the cloud the page may need browser copies.
  for (const c of next.clips) {
    if (after.engine === "open" && !c.normalized) prepareClipQuietly(next.id, c.id);
    if (after.engine === "cloud" && !c.preview && clipNeedsPreview("cloud", c)) prepareClipQuietly(next.id, c.id);
  }
  return mustProject(projectId);
}

// ---------------------------------------------------------------------------
// Steps run as one pipeline

/**
 * An account's job as its route runs it (swap-studio-account.ts): planned first (`dry`: the steps it would start are
 * kept, nothing is made or saved), then started, every pipeline of it in one batch (one run, as its limits count it).
 */
interface RunScope {
  dry: boolean;
  steps: PlanStep[];
  batchId?: string;
}

declare global {
  var __fuobeSwapRunScope: AsyncLocalStorage<RunScope> | undefined;
}

const runScopes = () => (globalThis.__fuobeSwapRunScope ??= new AsyncLocalStorage<RunScope>());
const runScope = () => runScopes().getStore();

/** The stand-in files the planners price with (no file is read): never one of the account's files to check. */
const STAND_IN = "/api/files/placeholder-";

const withChain = (s: PlanStep) => ({ ...s.request, ...(s.chain ? { chain: s.chain } : {}) });

/** An account's job planned, not started: the runs it would make (for the checks every account run gets) and the files they read. */
export interface PlannedSwapJob {
  steps: ToolStep[];
  files: string[];
}

/**
 * Plan an account's job (call it inside the account's work): `fn` goes as it will, but nothing is made or saved. The
 * steps it would start, and those it checks now and starts later (a take waiting for the one it continues from), come
 * back with every file they read.
 */
export async function planSwapJob(fn: () => unknown): Promise<PlannedSwapJob> {
  const scope: RunScope = { dry: true, steps: [] };
  await runScopes().run(scope, fn);
  const files = new Set<string>();
  for (const m of JSON.stringify(scope.steps.map((s) => s.request)).matchAll(/\/api\/files\/[^"\\\s?#]+/g)) if (!m[0].startsWith(STAND_IN)) files.add(m[0]);
  return { steps: scope.steps.map((s) => ({ request: withChain(s), deps: s.after?.length ?? 0 })), files: [...files] };
}

/** Start an account's job (inside its work, after its checks): every pipeline it makes is one run (one batch). */
export function startSwapJob<T>(fn: () => T): T {
  return runScopes().run({ dry: false, steps: [], batchId: nanoid(10) }, fn);
}

/** Steps checked now that may start later (a waiting take's): planned with the job, never made here. */
function checkLater(steps: PlanStep[]): void {
  const scope = runScope();
  if (scope?.dry) scope.steps.push(...steps);
}

function run(steps: PlanStep[], opts: { existing?: Record<string, string>; batchId?: string } = {}) {
  const scope = runScope();
  if (scope?.dry) {
    // Planned only: stand-in generations, so the job goes on as it will.
    const n = scope.steps.push(...steps);
    const byKey = Object.fromEntries(steps.map((s) => [s.key, { id: `planned-${n}-${s.key}`, status: "queued", outputs: [] } as unknown as Generation]));
    return { batchId: "planned", items: Object.values(byKey), byKey };
  }
  const batchId = opts.batchId ?? scope?.batchId;
  try {
    return createPipeline(steps, { ...(opts.existing && { existing: opts.existing }), ...(batchId && { batchId }) });
  } catch (e) {
    // An account's refusal stays one (Connect your GPU, Add your key).
    if (e instanceof AccountRunError) throw e;
    throw new ShortsError((e as Error).message, 422);
  }
}

const mustOffer = (modelId: string, engine: Engine, instead?: string) => {
  if (!isOffered(modelId, engine)) throw new ShortsError(`${getModel(modelId)?.name ?? modelId} is switched off in ${ACCESS_PLACE}${instead ? ` — ${instead}` : ""}`, 422);
};

// ---------------------------------------------------------------------------
// Clips

export const ClipSchema = z.object({
  url: fileUrl,
  name: z.string().max(200).optional(),
  duration: z.number().finite().positive().max(36_000).optional(),
  fps: z.number().finite().positive().max(1000).optional(),
  width: z.number().int().positive().max(20_000).optional(),
  height: z.number().int().positive().max(20_000).optional(),
  hasAudio: z.boolean().optional(),
  bytes: z.number().int().nonnegative().optional(),
  /** Whether the browser that added it could play it (it couldn't: the cloud makes a copy for the page). */
  playable: z.boolean().optional(),
});

/**
 * Add a clip: its header is read here (MP4, MOV, MKV, WebM, AVI), it must be at most 149.66 s, and on your GPU its
 * 24 fps copy starts right away (Akatz's normaliser). The clip starts as one shot until its edits are confirmed.
 */
export async function addClip(projectId: string, body: z.infer<typeof ClipSchema>): Promise<SwapProject> {
  const before = mustProject(projectId);
  if (before.clips.length >= SWAP_STUDIO.maxClips) throw new ShortsError(`A project holds ${SWAP_STUDIO.maxClips} clips — start another project for more`, 422);
  const info = await probeSource(body.url);
  const name = (body.name ?? "clip.mp4").slice(0, 200);
  const duration = info.duration ?? body.duration;
  const problem = clipProblem({ name, duration, bytes: body.bytes });
  if (problem) throw new ShortsError(problem, 422);
  if (!duration) throw new ShortsError("Couldn't read this clip's length — save it as an MP4 and add it again", 422);
  const frames = Math.min(SWAP_STUDIO.maxFrames, Math.round(duration * SWAP_STUDIO.fps));
  if (frames < 2) throw new ShortsError("This clip is too short — add one of at least a few frames", 422);
  const hasAudio = info.hasAudio ?? body.hasAudio ?? false;
  const clip: SwapClip = {
    id: uid("clip-"),
    name: name.replace(/\.[a-z0-9]{2,4}$/i, "").trim().slice(0, SWAP_STUDIO.maxNameChars) || "Clip",
    source: {
      url: body.url,
      name,
      duration,
      fps: info.fps ?? body.fps,
      width: info.width ?? body.width,
      height: info.height ?? body.height,
      hasAudio,
      ...(body.bytes !== undefined ? { bytes: body.bytes } : {}),
      ...(body.playable !== undefined ? { playable: body.playable } : {}),
    },
    normalized: null,
    preview: null,
    frames,
    cuts: [],
    detected: null,
    cutsReviewed: false,
    shots: [newShot(0, frames, before.defaults, hasAudio)],
    transcript: null,
    review: "pending",
    reviewNotes: "",
    assembly: null,
  };
  if (before.engine === "open") {
    mustMatchMode("open");
    clip.normalized = { genId: normalizeJob(clip) };
  } else if (clipNeedsPreview("cloud", clip)) {
    // The page can't play it: a browser copy (if it can't be made, the page says so and offers to try again).
    try {
      clip.preview = { genId: previewJob(clip) };
    } catch {
      clip.preview = null;
    }
  }
  return mutate(projectId, (p) => ({ ...p, clips: [...p.clips, clip] }));
}

function previewJob(clip: SwapClip): string {
  mustOffer(STUDIO_MODELS.cloud.scale, "cloud");
  const steps = planPreview(clip);
  if (!steps) throw new ShortsError("Couldn't read this clip's size to make a copy your browser can play — save it as an MP4 (H.264) and add it again", 422);
  return run(steps).byKey.preview.id;
}

function normalizeJob(clip: SwapClip): string {
  mustOffer(STUDIO_MODELS.open.normalize, "open");
  const pipe = run(planNormalize(clip));
  return pipe.byKey.normalize.id;
}

/** Your GPU: make (or make again) a clip's 24 fps copy. The cloud: its browser copy, when the page can't play the clip. */
export function prepareClip(projectId: string, clipId: string): SwapProject {
  const p = advanceProject(projectId);
  mustMatchMode(p.engine);
  const clip = mustClip(p, clipId);
  if (p.engine === "cloud") {
    if (!clipNeedsPreview("cloud", clip)) throw new ShortsError("The cloud reads the clip as filmed — no copy needed", 422);
    const g = getGeneration(clip.preview?.genId ?? "");
    if (clip.preview?.url || (g && ACTIVE.has(g.status))) throw new ShortsError("The browser copy is ready or on its way", 409);
    const genId = previewJob(clip);
    return mutate(projectId, (cur) => mapClip(cur, clipId, (c) => ({ ...c, preview: { genId } })));
  }
  const g = getGeneration(clip.normalized?.genId ?? "");
  if (clip.normalized?.url || (g && ACTIVE.has(g.status))) throw new ShortsError("The 24 fps copy is ready or on its way", 409);
  const genId = normalizeJob(clip);
  return mutate(projectId, (cur) => mapClip(cur, clipId, (c) => ({ ...c, normalized: { genId } })));
}

function prepareClipQuietly(projectId: string, clipId: string): void {
  try {
    prepareClip(projectId, clipId);
  } catch {
    // Said on the page: the clip shows "Prepare at 24 fps" when its copy is missing.
  }
}

// ---------------------------------------------------------------------------
// Transcript

export function transcribe(projectId: string, clipId: string, opts: { cleanVoiceFirst?: boolean } = {}): SwapProject {
  const p = advanceProject(projectId);
  mustMatchMode(p.engine);
  const clip = mustClip(p, clipId);
  if (!clip.source.hasAudio) throw new ShortsError("This clip has no sound — nothing to transcribe", 422);
  const modelId = STUDIO_MODELS[p.engine].transcribe;
  mustOffer(modelId, p.engine, "type each shot's words instead");
  const busy = look1(clip.transcript?.genId);
  if (busy && ACTIVE.has(busy.status)) throw new ShortsError("The clip is being transcribed", 409);
  const pipe = run(planTranscribe(clip, p.engine, opts));
  const genId = pipe.byKey.transcribe.id;
  return mutate(projectId, (cur) => mapClip(cur, clipId, (c) => ({ ...c, transcript: { genId, modelId, cues: null, voices: c.transcript?.voices ?? {} } })));
}

const look1 = (gid?: string) => lookup()(gid);

// ---------------------------------------------------------------------------
// Masks

export const MaskSchema = z.object({
  clipId: id,
  shotId: id,
  kind: z.enum(["track", "frame"]),
  /** The shot's frame (0 = its first). */
  frame: z.number().int().min(0),
  points: z.array(z.object({ x: z.number().finite().min(0).max(20_000), y: z.number().finite().min(0).max(20_000), label: z.enum(["positive", "negative"]).optional() })).max(SWAP_STUDIO.maxPoints).default([]),
  /** The picture the points were placed on (the frame the page showed). */
  size: z.object({ width: z.number().int().positive().max(20_000), height: z.number().int().positive().max(20_000) }).optional(),
  /** The version it corrects (default: the approved one, else the newest). */
  base: id.optional(),
});

/** The size of the video a job reads (your GPU's 24 fps copy, else the clip). */
function workingSize(p: SwapProject, clip: SwapClip): { width: number; height: number } | null {
  const { width, height } = clip.source;
  if (!width || !height) return null;
  return p.engine === "open" ? normalizedSize(width, height) : { width, height };
}

/** Track the shot (from a frame, to its end) or update one frame: a new mask version. */
export function makeMask(projectId: string, body: z.infer<typeof MaskSchema>): SwapProject {
  const p = advanceProject(projectId);
  mustMatchMode(p.engine);
  const clip = mustClip(p, body.clipId);
  const shot = mustShot(clip, body.shotId);
  const len = shot.end - shot.start;
  if (shot.masks.length >= SWAP_STUDIO.maxMaskVersions) throw new ShortsError(`A shot keeps ${SWAP_STUDIO.maxMaskVersions} mask versions — remove one first`, 422);
  const finished = (m: MaskVersion) => m.pieces.every((x) => x.url);
  // The version it corrects: the one named, else this engine's approved or newest (never the other engine's).
  const base = body.base ? (shot.masks.find((m) => m.id === body.base) ?? null) : defaultMaskBase(shot, p.engine);
  if (base && !finished(base)) throw new ShortsError("That mask version is still being made — wait for it", 409);
  const size = workingSize(p, clip);
  const points: PixelPoint[] = body.points.length && body.size && size ? scalePoints(body.points, body.size, size) : body.points;
  const problem = maskProblem(p.engine, body.kind, body.frame, len, points, shot.who, base);
  if (problem) throw new ShortsError(problem, 422);
  if (p.engine === "open" && !clip.normalized?.url) throw new ShortsError("The clip is still being prepared at 24 fps — wait for it", 409);
  mustOffer(STUDIO_MODELS[p.engine].mask, p.engine);
  const pipe = run(planMask({ engine: p.engine, clip, shot, kind: body.kind, frame: body.frame, points, who: shot.who, base }));
  const genId = pipe.byKey.mask.id;
  const pieces = maskPieces(p.engine, body.kind, body.frame, len, base, p.engine === "cloud" ? cloudMaskCut(clip, shot, body.kind, body.frame).offset : 0);
  pieces[pieces.length - 1] = { ...pieces[pieces.length - 1], genId };
  const version: MaskVersion = {
    id: uid("mask-"),
    createdAt: Date.now(),
    kind: body.kind,
    engine: p.engine,
    frame: body.frame,
    points,
    who: { ...shot.who },
    ...(base ? { base: base.id } : {}),
    pieces,
    genId,
    stepIds: pipe.items.map((g) => g.id),
  };
  return mutate(projectId, (cur) => mapClip(cur, clip.id, (c) => mapShot(c, shot.id, (s) => ({ ...s, masks: [...s.masks, version] }))));
}

// ---------------------------------------------------------------------------
// Anchors

export const AnchorSchema = z.object({ clipId: id, shotId: id, segmentId: id.optional(), modelId: z.string().max(80).optional(), seed: z.number().int().min(0).max(SWAP_STUDIO.maxSeed).optional() });

/** The anchor model that runs: the one asked for, else the engine's next one that is switched on. */
function anchorModelFor(engine: Engine, asked?: string) {
  const want = anchorModel(engine, asked);
  if (isOffered(want.id, engine)) return want;
  const next = ANCHOR_MODELS[engine].find((m) => isOffered(m.id, engine));
  if (!next) throw new ShortsError(`The anchor models are switched off in ${ACCESS_PLACE} — import an anchor image instead`, 422);
  return next;
}

/** A scene anchor for a shot (its first frame), or a reference for a segment (its first frame): your character in the frame. */
export function makeAnchor(projectId: string, body: z.infer<typeof AnchorSchema>): SwapProject {
  const p = advanceProject(projectId);
  mustMatchMode(p.engine);
  if (!p.character.image) throw new ShortsError("Add a picture of your character first", 422);
  const clip = mustClip(p, body.clipId);
  const shot = mustShot(clip, body.shotId);
  const items = currentSegments(shot);
  const seg = body.segmentId ? items.find((g) => g.id === body.segmentId) : undefined;
  if (body.segmentId && !seg) throw new ShortsError("That segment changed — reload", 404);
  const list = seg ? seg.anchors : shot.anchors;
  if (list.length >= SWAP_STUDIO.maxAnchors) throw new ShortsError(`Keep at most ${SWAP_STUDIO.maxAnchors} ${seg ? "references a segment" : "anchors a shot"} — remove one first`, 422);
  if (p.engine === "open" && !clip.normalized?.url) throw new ShortsError("The clip is still being prepared at 24 fps — wait for it", 409);
  const am = anchorModelFor(p.engine, body.modelId);
  const steps = planAnchor({ engine: p.engine, project: p, clip, shot, frame: shot.start + (seg?.start ?? 0), modelId: am.id, seed: body.seed });
  const pipe = run(steps);
  const variant = {
    id: uid("anchor-"),
    createdAt: Date.now(),
    source: "generated" as const,
    genId: pipe.byKey.anchor.id,
    stepIds: pipe.items.map((g) => g.id),
    modelId: am.id,
    prompt: String(steps.find((s) => s.key === "anchor")?.request.prompt ?? ""),
  };
  return mutate(projectId, (cur) =>
    mapClip(cur, clip.id, (c) =>
      mapShot(c, shot.id, (s) => {
        if (!seg) return { ...s, anchors: [...s.anchors, variant] };
        const now = currentSegments(s);
        if (!now.some((g) => g.id === seg.id)) throw new ShortsError("That segment changed — reload", 404);
        return { ...s, segments: now.map((g) => (g.id === seg.id ? { ...g, anchors: [...g.anchors, variant] } : g)) };
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Takes

export const QueueSchema = z.object({ clipId: id, shotId: id, segmentId: id, mode: z.enum(["segment", "from", "all"]) });

/**
 * The swap LoRA a shot runs with, with what Settings → Models & licences switched off taken out: on your GPU H3 runs
 * without it (with a note); fal's route needs one. Turbo off stops your GPU's 8-step graph.
 */
function loraFor(engine: Engine, lora: SwapShot["settings"]["lora"]): { lora: SwapShot["settings"]["lora"]; note?: string } {
  if (engine === "open" && offeredLoras([TURBO_LORA]).dropped.length) throw new ShortsError(`The H3 Turbo LoRA is switched off in ${ACCESS_PLACE}, and the segment graph's 8 steps need it — turn it on to run on your GPU`, 422);
  if (engine === "cloud" && lora === "none") throw new ShortsError("On the cloud, fal's H3 route runs with a swap LoRA — pick V1.5 or V1 in the shot's settings (no LoRA runs on your GPU)", 422);
  if (lora === "none" || !offeredLoras([swapLoraRef(lora)]).dropped.length) return { lora };
  if (engine === "cloud") throw new ShortsError(`The swap LoRA (${SWAP_LORAS[lora].label}) is switched off in ${ACCESS_PLACE}, and fal's H3 route needs one — turn it on, or pick the other release`, 422);
  return { lora: "none", note: `The swap LoRA is switched off in ${ACCESS_PLACE}: H3 runs with the Turbo LoRA alone` };
}

/** A take's steps with stand-ins for what the segment before will make (for prices and checks before anything runs). */
function takeSteps(p: SwapProject, clip: SwapClip, shot: SwapShot, seg: SwapSegment, take: SwapTake, numbers: { shot: number; segment: number; take: number }) {
  const previous = take.frozen && take.frozen.history > 0 ? { master: "/api/files/placeholder-master.mkv", video: "/api/files/placeholder-take.mp4", frames: Math.max(take.frozen.history, 1) } : null;
  return frozenTakePlan(p, clip, shot, seg, take, numbers, previous);
}

/**
 * A new take of a segment as it reads now (waiting until the takes it continues from are made). `keep`: your GPU's
 * master keeps the take's last frames for the segment after it (masterKeep).
 */
function newTake(p: SwapProject, clip: SwapClip, shot: SwapShot, seg: SwapSegment, deps: SwapTake["dependencies"], lora: SwapShot["settings"]["lora"], keep?: number): SwapTake {
  const frozen = freezeTake(p, shot, seg);
  frozen.settings = { ...frozen.settings, lora };
  if (p.engine === "open" && keep !== undefined) frozen.keep = keep;
  return {
    id: uid("take-"),
    createdAt: Date.now(),
    engine: p.engine,
    state: "waiting",
    signature: settingSignature(p, clip, shot, seg),
    dependencies: deps,
    prompt: segmentPrompt(p, clip, shot, seg),
    seed: seg.seed,
    replaces: seg.selectedTake,
    favourite: false,
    decision: "pending",
    notes: "",
    frozen,
  };
}

export interface QueueResult {
  project: SwapProject;
  takes: string[];
  notes: string[];
}

/**
 * "Queue segment", "Queue from here", "Queue all segments": a take for each segment (planQueue says which), each
 * frozen as it reads now. A take that continues from another one in the same queue waits for it; the rest launch now.
 * Everything is checked (and priced) before the first one starts.
 */
export function queueTakes(projectId: string, body: z.infer<typeof QueueSchema>): QueueResult {
  const cur = advanceProject(projectId);
  mustMatchMode(cur.engine);
  const look = lookup();
  const clip = mustClip(cur, body.clipId);
  const shot = mustShot(clip, body.shotId);
  const planned = planQueue(cur, clip, shot, body.segmentId, body.mode as QueueMode, {
    active: (t) => ACTIVE.has(look(t.genId)?.status ?? ""),
    hasMaster: (t) => {
      const g = look(t.genId);
      return !!g && !!masterOutput(g);
    },
  });
  if ("problem" in planned) throw new ShortsError(planned.problem, 422);
  mustOffer(STUDIO_MODELS[cur.engine].swap, cur.engine);
  const { lora, note } = loraFor(cur.engine, shot.settings.lora);
  const items = currentSegments(shot).map((g) => ({ ...g }));
  const made = new Map<string, SwapTake>();
  // An account's queue is one run: a take that starts later joins it.
  const batchId = tenantAccount() ? runScope()?.batchId : undefined;
  for (const e of planned.entries) {
    const seg = items[e.index];
    if (seg.takes.length >= SWAP_STUDIO.maxTakes) throw new ShortsError(`Segment ${e.index + 1} keeps ${SWAP_STUDIO.maxTakes} takes — remove one first`, 422);
    // Takes it continues from in this queue are named by their new ids (they become the selection when made).
    const deps = e.dependencies.map((d) => ({ ...d, takeId: made.get(d.segmentId)?.id ?? d.takeId }));
    const take = newTake(cur, clip, shot, seg, deps, lora, masterKeep(items, e.index, shot.settings));
    if (batchId) take.batchId = batchId;
    made.set(seg.id, take);
  }
  // Every take's steps checked now (models switched off, demo and real mixed, a request a route refuses).
  const shotIndex = clip.shots.findIndex((s) => s.id === shot.id);
  const checked = { ...shot, segments: items };
  let demo: boolean | null = null;
  for (const e of planned.entries) {
    const take = made.get(items[e.index].id)!;
    const plan = takeSteps(cur, clip, checked, items[e.index], take, { shot: shotIndex + 1, segment: e.index + 1, take: items[e.index].takes.length + 1 });
    const priced = price(plan.steps);
    if (priced.refusal) throw priced.refusal;
    if (priced.problem) throw new ShortsError(priced.problem, 422);
    if (demo !== null && demo !== priced.demo) throw new ShortsError("Some takes would run as a demo and others for real — connect the missing provider in Settings", 422);
    demo = priced.demo;
    // An account's take that waits is checked with the queue, before anything starts.
    checkLater(plan.steps);
  }
  // (An account's takes are swept by the runner the server starts at boot: never started from inside its work.)
  if (!tenant()) ensureSwapStudioRunner();
  const project = mutate(projectId, (p) => {
    const next = mapClip(p, clip.id, (c) =>
      mapShot(c, shot.id, (s) => {
        const now = currentSegments(s);
        if (now.length !== items.length || now.some((g, i) => g.id !== items[i].id)) throw new ShortsError("The shot's segments changed — queue again", 409);
        return { ...s, segments: now.map((g) => (made.has(g.id) ? { ...g, takes: [...g.takes, { ...made.get(g.id)!, waitsOn: made.get(g.id)!.dependencies.filter((d) => [...made.values()].some((t) => t.id === d.takeId)).map((d) => ({ segmentId: d.segmentId, takeId: d.takeId! })) }] } : g)) };
      }),
    );
    // Launch what can start now.
    return settle(next, lookup());
  });
  // A take that couldn't start says why on the page (stopped, with the reason), and so do the takes waiting on it.
  return { project, takes: [...made.values()].map((t) => t.id), notes: note ? [note] : [] };
}

export const TakeRefSchema = z.object({ clipId: id, shotId: id, segmentId: id, takeId: id });

/** Stop a take: one still waiting doesn't run; one running is canceled (takes waiting on it stop on the next sweep). */
export async function stopTake(projectId: string, body: z.infer<typeof TakeRefSchema>): Promise<SwapProject> {
  const p = mustProject(projectId);
  const clip = mustClip(p, body.clipId);
  const shot = mustShot(clip, body.shotId);
  const take = currentSegments(shot)
    .find((g) => g.id === body.segmentId)
    ?.takes.find((t) => t.id === body.takeId);
  if (!take) throw new ShortsError("That take is gone — reload", 404);
  if (take.state === "waiting") {
    mutate(projectId, (cur) =>
      mapClip(cur, clip.id, (c) =>
        mapShot(c, shot.id, (s) => ({ ...s, segments: (s.segments ?? []).map((g) => (g.id === body.segmentId ? { ...g, takes: g.takes.map((t) => (t.id === take.id && t.state === "waiting" ? { ...t, state: "stopped" as const, reason: "Stopped before it ran", waitsOn: undefined } : t)) } : g)) })),
      ),
    );
  } else if (take.state === "launched") {
    for (const gid of [...(take.stepIds ?? []), take.genId]) if (gid && ACTIVE.has(look1(gid)?.status ?? "")) await cancelGeneration(gid).catch(() => undefined);
  }
  return advanceProject(projectId);
}

// ---------------------------------------------------------------------------
// Assembly

/** The clip with its chosen takes over the original timeline and its own sound (the result goes to the Library). */
export function assemble(projectId: string, clipId: string, opts: { originalSound?: OriginalSound } = {}): SwapProject {
  const p = advanceProject(projectId);
  mustMatchMode(p.engine);
  const clip = mustClip(p, clipId);
  const look = lookup();
  const found = assemblyPieces(p, clip);
  if ("problem" in found) throw new ShortsError(found.problem, 422);
  const takes = assemblyTakes(found.pieces);
  // What of the clip's sound goes back: the cloud puts it all back (DBS runs on your GPU).
  const sound = originalSoundOn(opts.originalSound, p.engine);
  const last = look(clip.assembly?.genId);
  if (clip.assembly && last && last.status !== "failed" && last.status !== "canceled" && JSON.stringify(clip.assembly.takes) === JSON.stringify(takes) && (clip.assembly.originalSound ?? "everything") === sound) {
    throw new ShortsError(ACTIVE.has(last.status) ? "This clip is being assembled" : "Already assembled with these takes — download it below", 409);
  }
  if (p.engine === "open" && !clip.normalized?.url) throw new ShortsError("The clip is still being prepared at 24 fps — wait for it", 409);
  const existing: Record<string, string> = {};
  const videoOf = (piece: Extract<(typeof found.pieces)[number], { kind: "take" }>) => {
    // A sharper version picked after comparing goes in instead of the take.
    const finish = usedFinish(piece.take);
    const g = look(finish?.genId ?? piece.take.genId);
    const url = g?.status === "succeeded" ? mainOutput(g)?.url : undefined;
    if (!url) throw new ShortsError(finish ? "A chosen take's sharper version is missing — use the take, or sharpen it again" : "A chosen take's video is missing — make it again", 422);
    existing[`take-${piece.take.id}`] = g!.id;
    return url;
  };
  const plan = planAssembly({ engine: p.engine, clip, pieces: found.pieces, videoOf, originalSound: sound });
  // A silent clip's cloud assembly ends on its silence: the WAV is written now (silenceRef, as Genjutsu and Canvas do),
  // not while an account's job is only planned.
  const withSilence = runScope()?.dry ? (r: (typeof plan.steps)[number]["request"]) => r : silenceWriter();
  // The takes count as steps already made: a demo join of real takes is refused.
  const pipe = run(
    plan.steps.map((s) => ({ ...s, request: withSilence(s.request) })),
    { existing },
  );
  const assembly = { genId: pipe.byKey[plan.final].id, stepIds: pipe.items.map((g) => g.id), takes, ...(sound !== "everything" && { originalSound: sound }), createdAt: Date.now() };
  return mutate(projectId, (cur) => mapClip(cur, clipId, (c) => ({ ...c, assembly })));
}

// ---------------------------------------------------------------------------
// Assemble → Finish → Sharpen (src/lib/catalog/sharpen.ts)

export const SharpenSchema = z.object({ clipId: id, tier: z.enum(SHARPEN_TIERS) });

/** The generations of a take's sharper version (its steps and its result). */
const finishIds = (f: TakeFinish | null | undefined): string[] => (f ? [...(f.stepIds ?? []), ...(f.genId ? [f.genId] : [])] : []);

/** H3's canvas a film's takes are made at: your GPU redraws the character inside the part of it the regenerate keeps. */
const sharpenCanvas = (film: { width: number; height: number } | null) => (film ? h3Canvas(film.width, film.height, CHARACTER_SWAP.defaultQuality) : undefined);

/** A take's sharper version being made, or made: a new Sharpen at the same size doesn't make it again. */
const finishLive = (t: SwapTake, tier: SharpenTier, look: Look) => {
  const st = look(t.finish?.genId)?.status;
  return !!t.finish && t.finish.tier === tier && !!st && st !== "failed" && st !== "canceled";
};

/** Each chosen take's Sharpen steps at a size (your GPU: from the take's video; the cloud: from what it continued from). */
function finishPlans(p: SwapProject, clip: SwapClip, tier: SharpenTier, look: Look, stand = false) {
  const found = assemblyPieces(p, clip);
  if ("problem" in found) throw new ShortsError(found.problem === "Confirm the clip's shots first" ? found.problem : SHARPEN_COPY.none, 422);
  return chosenTakes(found.pieces).map((piece) => {
    const si = clip.shots.findIndex((s) => currentSegments(s).some((g) => g.id === piece.segmentId));
    const shot = clip.shots[si];
    const items = currentSegments(shot);
    const gi = items.findIndex((g) => g.id === piece.segmentId);
    const seg = items[gi];
    const take = piece.take;
    if (take.engine !== p.engine) throw new ShortsError(`Shot ${si + 1}, segment ${gi + 1}'s take was made on the ${take.engine === "open" ? "open engine" : "cloud"} — make it again on this engine to sharpen it`, 422);
    const g = look(take.genId);
    const video = stand ? "/api/files/placeholder-take.mp4" : g?.status === "succeeded" ? mainOutput(g)?.url : undefined;
    let previous: ReturnType<typeof previousOf> = null;
    if (take.engine === "cloud") previous = stand && take.frozen?.history ? { video: "/api/files/placeholder-take.mp4", frames: take.frozen.history } : previousOf(shot, take, look);
    const plan = planTakeFinish({ project: p, clip, shot, seg, take, numbers: { shot: si + 1, segment: gi + 1, take: seg.takes.findIndex((t) => t.id === take.id) + 1 }, tier, video, previous });
    return { shot, seg, take, plan, seconds: (seg.end - seg.start) / SWAP_STUDIO.fps };
  });
}

/**
 * Sharpen: every chosen take of the clip made sharper at a size (sharpen.ts), each a version beside its take until it is
 * picked in Takes & review. Your GPU: regenerated and composited, never above the size the clip is joined at; the cloud:
 * made again at 2K or 4K on fal's H3. Everything is checked (and priced) before the first one starts.
 */
export async function sharpenClip(projectId: string, body: z.infer<typeof SharpenSchema>): Promise<SwapProject> {
  const p = advanceProject(projectId);
  mustMatchMode(p.engine);
  const clip = mustClip(p, body.clipId);
  const look = lookup();
  const film = filmSize(clip.source.width, clip.source.height, p.engine);
  const canvas = sharpenCanvas(film);
  const tier = sharpenTierFor(p.engine, body.tier, film, canvas);
  if (!tier) throw new ShortsError(sharpenOptions(p.engine, film, canvas).find((o) => o.tier === body.tier)?.reason ?? SHARPEN_COPY.small, 422);
  if (p.engine === "open") {
    mustOffer(REGEN_MODEL, "open");
    mustOffer(COMPOSITE_MODEL, "open");
  } else mustOffer(STUDIO_MODELS.cloud.swap, "cloud");
  if (p.engine === "open" && !clip.normalized?.url) throw new ShortsError("The clip is still being prepared at 24 fps — wait for it", 409);
  let plans: ReturnType<typeof finishPlans>;
  try {
    plans = finishPlans(p, clip, tier, look);
  } catch (e) {
    if (e instanceof ShortsError) throw e;
    throw new ShortsError((e as Error).message, 422);
  }
  const todo = plans.filter((x) => !finishLive(x.take, tier, look));
  if (!todo.length) throw new ShortsError(`Every chosen take already has a ${tier} version — compare them in Takes & review`, 409);
  let demo: boolean | null = null;
  for (const x of todo) {
    const priced = price(x.plan.steps);
    if (priced.refusal) throw priced.refusal;
    if (priced.problem) throw new ShortsError(priced.problem, 422);
    if (demo !== null && demo !== priced.demo) throw new ShortsError("Some takes would run as a demo and others for real — connect the missing provider in Settings", 422);
    demo = priced.demo;
  }
  // A version still being made at another size is replaced: it is stopped first (nothing would show it or stop it after).
  // Not while an account's job is only planned.
  if (!runScope()?.dry) for (const x of todo) for (const gid of finishIds(x.take.finish)) if (ACTIVE.has(look(gid)?.status ?? "")) await cancelGeneration(gid).catch(() => undefined);
  const made = new Map<string, TakeFinish>();
  for (const x of todo) {
    const pipe = run(x.plan.steps);
    made.set(x.take.id, { id: uid("finish-"), createdAt: Date.now(), engine: p.engine, asked: body.tier, tier, genId: pipe.byKey[x.plan.final].id, stepIds: pipe.items.map((g) => g.id), use: false });
  }
  return mutate(projectId, (cur) =>
    mapClip(cur, clip.id, (c) => ({
      ...c,
      shots: c.shots.map((s) => (s.segments ? { ...s, segments: s.segments.map((g) => ({ ...g, takes: g.takes.map((t) => (made.has(t.id) ? { ...t, finish: made.get(t.id)! } : t)) })) } : s)),
    })),
  );
}

/** Sharpen's price for a clip: every chosen take at each size the engine offers (stand-ins where a take isn't made). */
function sharpenEstimate(p: SwapProject, clip: SwapClip, look: Look): { estimate: StudioEstimate["sharpen"][string]; demo: boolean } | null {
  const found = assemblyPieces(p, clip);
  if ("problem" in found) return null;
  const takes = chosenTakes(found.pieces);
  const seconds = Math.round(takes.reduce((n, t) => n + (t.end - t.start) / SWAP_STUDIO.fps, 0) * 100) / 100;
  const film = filmSize(clip.source.width, clip.source.height, p.engine);
  const costUsd: Partial<Record<SharpenTier, number | null>> = {};
  let demo = false;
  let problem: string | undefined;
  for (const o of sharpenOptions(p.engine, film, sharpenCanvas(film))) {
    if (!o.available) continue;
    try {
      let cost: number | null = 0;
      for (const x of finishPlans(p, clip, o.tier, look, true)) {
        const r = price(x.plan.steps);
        if (r.problem) throw new Error(r.problem);
        if (r.demo) demo = true;
        cost = add(cost, r.costUsd);
      }
      costUsd[o.tier] = cost;
    } catch (e) {
      costUsd[o.tier] = null;
      problem ??= (e as Error).message;
    }
  }
  return { estimate: { takes: takes.length, seconds, costUsd, ...(problem ? { problem } : {}) }, demo };
}

// ---------------------------------------------------------------------------
// Stopping other jobs

export const StopSchema = z.object({ kind: z.enum(["mask", "anchor", "assembly", "normalize", "transcribe", "finish"]), clipId: id, shotId: id.optional(), segmentId: id.optional(), jobId: id.optional() });

export async function stopJob(projectId: string, body: z.infer<typeof StopSchema>): Promise<SwapProject> {
  const p = mustProject(projectId);
  const clip = mustClip(p, body.clipId);
  let ids: (string | undefined)[] = [];
  if (body.kind === "assembly") ids = [...(clip.assembly?.stepIds ?? []), clip.assembly?.genId];
  if (body.kind === "normalize") ids = [clip.normalized?.genId];
  if (body.kind === "transcribe") ids = [clip.transcript?.genId];
  // Sharpen: every sharper version of the clip still being made.
  if (body.kind === "finish") ids = clip.shots.flatMap((s) => currentSegments(s).flatMap((g) => g.takes.flatMap((t) => finishIds(t.finish))));
  if (body.kind === "mask" || body.kind === "anchor") {
    const shot = mustShot(clip, body.shotId ?? "");
    const seg = body.segmentId ? currentSegments(shot).find((g) => g.id === body.segmentId) : undefined;
    const job = body.kind === "mask" ? shot.masks.find((m) => m.id === body.jobId) : (seg?.anchors ?? shot.anchors).find((a) => a.id === body.jobId);
    if (!job) throw new ShortsError("That job is gone — reload", 404);
    ids = [...(job.stepIds ?? []), job.genId];
  }
  for (const gid of ids) if (gid && ACTIVE.has(look1(gid)?.status ?? "")) await cancelGeneration(gid).catch(() => undefined);
  return advanceProject(projectId);
}

// ---------------------------------------------------------------------------
// Prices

/**
 * What steps cost together (null when a price is unknown), whether they'd run as a demo, and what stops them. `refusal`:
 * an account's own answer (Add your key…), which a run gives as it is.
 */
function price(steps: PlanStep[]): { costUsd: number | null; demo: boolean; problem: string | null; refusal?: AccountRunError } {
  let cost: number | null = 0;
  let demo = false;
  let real = false;
  for (const s of steps) {
    let p: ReturnType<typeof previewChained>;
    try {
      p = previewChained(withChain(s), s.after?.length ?? 0);
    } catch (e) {
      return { costUsd: null, demo: false, problem: (e as Error).message, ...(e instanceof AccountRunError && { refusal: e }) };
    }
    if (p.demo) demo = true;
    else real = true;
    // Tokens-billed anchor models have no fixed price: left out of the total (the page says so).
    const tokens = p.costUsd === null && ANCHOR_MODELS.cloud.some((m) => m.id === s.request.modelId && m.tokens);
    if (tokens) continue;
    cost = cost === null || p.costUsd === null ? null : cost + p.costUsd;
  }
  if (demo && real) {
    const which = steps.find((s) => {
      try {
        return previewChained(withChain(s), s.after?.length ?? 0).demo;
      } catch {
        return false;
      }
    });
    const m = which ? getModel(which.request.modelId) : undefined;
    return { costUsd: null, demo, problem: `${m?.name ?? "A step"} would run as a demo while the others run for real — connect its provider in Settings, or turn on demo mode to try it all as a demo` };
  }
  return { costUsd: cost === null ? null : Math.round(cost * 10000) / 10000, demo, problem: null };
}


const add = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.round((a + b) * 10000) / 10000);

/** Prices before running: a take of each segment, each shot's and the whole project's queue, masks, anchors, words, assembly. */
export function estimateProject(projectId: string): StudioEstimate {
  const p = advanceProject(projectId);
  const look = lookup();
  const engine = p.engine;
  const out: StudioEstimate = { engine, demo: false, free: engine === "open", segments: {}, problems: {}, shots: {}, project: { costUsd: 0, segments: 0 }, assembly: {}, transcribe: {}, mask: {}, sharpen: {}, anchors: [], notes: [] };
  const track = (r: { demo: boolean }) => {
    if (r.demo) out.demo = true;
  };
  const stand = p.character.image ? p : { ...p, character: { ...p.character, image: "/api/files/placeholder-character.png" } };
  let loraNote: string | undefined;
  for (const clip of p.clips) {
    const working = engine === "open" && !clip.normalized?.url ? { ...clip, normalized: { url: "/api/files/placeholder-24fps.mp4" } } : clip;
    if (clip.source.hasAudio) {
      const t = price(planTranscribe(working, engine));
      track(t);
      out.transcribe[clip.id] = t.costUsd;
    }
    for (const [si, shot] of clip.shots.entries()) {
      if (shot.mode !== "generate") continue;
      const m = price(planMask({ engine, clip: working, shot, kind: "track", frame: 0, points: [], who: shot.who, base: null }));
      out.mask[shot.id] = m.costUsd;
      const items = currentSegments(shot);
      const states = segmentStates(p, clip, shot, items);
      let lora = shot.settings.lora;
      try {
        const l = loraFor(engine, lora);
        lora = l.lora;
        loraNote ??= l.note;
      } catch (e) {
        for (const g of items) out.problems[g.id] = (e as Error).message;
        out.shots[shot.id] = { costUsd: null, segments: 0 };
        continue;
      }
      let shotCost: number | null = 0;
      let count = 0;
      for (const [gi, seg] of items.entries()) {
        const take = newTake(stand, working, shot, seg, [], lora, masterKeep(items, gi, shot.settings));
        // A stand-in anchor where one is still to be made: the price doesn't depend on which picture it is.
        const wantsAnchor = seg.anchorMode === "custom" || (seg.anchorMode === "shot" && shot.settings.useAnchor);
        if (wantsAnchor && !take.frozen!.anchor) take.frozen!.anchor = "/api/files/placeholder-anchor.png";
        let r: ReturnType<typeof price>;
        try {
          r = price(takeSteps(stand, working, shot, seg, take, { shot: si + 1, segment: gi + 1, take: seg.takes.length + 1 }).steps);
        } catch (e) {
          r = { costUsd: null, demo: false, problem: (e as Error).message };
        }
        if (r.problem) out.problems[seg.id] = r.problem;
        track(r);
        out.segments[seg.id] = r.costUsd;
        const busy = seg.takes.some((t) => t.state === "waiting" || ACTIVE.has(look(t.genId)?.status ?? ""));
        if (states[gi].status !== "ready" && !busy) {
          shotCost = add(shotCost, r.costUsd);
          count++;
        }
      }
      out.shots[shot.id] = { costUsd: shotCost, segments: count };
      out.project = { costUsd: add(out.project.costUsd, shotCost), segments: out.project.segments + count };
    }
    // The assembly with every swapped segment's take (stand-ins where none is made yet).
    const pieces = assemblyPiecesForPrice(p, clip);
    if (pieces.length) {
      const a = price(planAssembly({ engine, clip: working, pieces, videoOf: () => "/api/files/placeholder-take.mp4" }).steps);
      track(a);
      out.assembly[clip.id] = a.costUsd;
    }
    const sharp = sharpenEstimate(p, working, look);
    if (sharp) {
      if (sharp.demo) out.demo = true;
      out.sharpen[clip.id] = sharp.estimate;
    }
  }
  const sample = p.clips[0];
  if (sample) {
    const working = engine === "open" && !sample.normalized?.url ? { ...sample, normalized: { url: "/api/files/placeholder-24fps.mp4" } } : sample;
    for (const am of ANCHOR_MODELS[engine]) {
      const offered = isOffered(am.id, engine);
      let costUsd: number | null = null;
      if (offered) {
        const r = price(planAnchor({ engine, project: stand, clip: working, shot: sample.shots[0], frame: 0, modelId: am.id }));
        track(r);
        costUsd = r.costUsd;
      }
      out.anchors.push({ id: am.id, label: am.label, note: am.note, costUsd, offered });
    }
  }
  out.notes = studioNotes(engine);
  if (loraNote) out.notes.unshift(loraNote);
  if (out.demo) out.free = false;
  return out;
}

/** The assembly's pieces with a stand-in take wherever a segment has none yet (for its price). */
function assemblyPiecesForPrice(p: SwapProject, clip: SwapClip) {
  if (!clip.shots.some((s) => s.mode === "generate")) return [];
  const stand: SwapTake = { id: "price", createdAt: 0, engine: p.engine, state: "launched", signature: "", dependencies: [], prompt: "", seed: 0, favourite: false, decision: "pending", notes: "" };
  const out: Parameters<typeof planAssembly>[0]["pieces"] = [];
  for (const shot of clip.shots) {
    if (shot.mode === "preserve") {
      const last = out.at(-1);
      if (last?.kind === "source" && last.end === shot.start) last.end = shot.end;
      else out.push({ kind: "source", start: shot.start, end: shot.end });
      continue;
    }
    for (const seg of currentSegments(shot)) out.push({ kind: "take", start: shot.start + seg.start, end: shot.start + seg.end, take: stand, segmentId: seg.id });
  }
  return out;
}

/** What the page says about each engine. */
export function studioNotes(engine: Engine): string[] {
  if (engine === "open") {
    return [
      WORKERS_NOTE,
      "Needs H3 Relay 2.0's nodes on your ComfyUI (add them with Fuobe's ComfyUI setup) and a 24 GB GPU with offloading; the masks need SAM 3.1",
      "Each segment is one H3 Relay pass with the approved mask, its anchor and the previous take's last frames as continuation history (a lossless 16-bit FFV1 master, about 3 MB a frame at 1 MP: ComfyUI takes uploads up to 100 MB unless started with a higher --max-upload-size, so keep history to about 30 frames or raise it)",
    ];
  }
  return [
    "On fal, H3 has no mask: who to swap is said in words, and the whole frame is regenerated around them",
    "fal's H3 reads 2–15 s of the clip a call and bills whole seconds (5–15 s): a segment runs 2–15 s",
    "A continuing segment starts from the previous take's last frame — fal's H3 takes no continuation history. H3 makes whole seconds (at least 5), so each take is trimmed back to its segment",
    "SAM 3.1 on fal marks the person from your clicks or words, for review; the swap itself doesn't read the mask",
  ];
}

// ---------------------------------------------------------------------------
// Review

/** "Export decisions": every clip's review and every take's favourite, decision and notes, as JSON. */
export function decisions(projectId: string): DecisionExport {
  const p = advanceProject(projectId);
  const look = lookup();
  return exportDecisions(p, (t) => {
    const g = look(t.genId);
    return g?.status === "succeeded" ? mainOutput(g)?.url : undefined;
  });
}
