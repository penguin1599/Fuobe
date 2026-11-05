import "server-only";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Cue } from "@/lib/cues";
import {
  DUB_FEATURE,
  languageStage,
  oneShotRequests,
  pickVoiceSplit,
  prepareMedia,
  prepareSteps,
  reviewCues,
  voiceSteps,
  type DubSession,
  type DubStep,
  type DubPrice,
  type DubSessionView,
  type OneShotModel,
  type VoiceSplit,
} from "@/lib/av/dub";
import { normalizeCues } from "@/lib/av/cue-edit";
import { getModel } from "@/lib/catalog";
import type { Engine, Generation, GenerationRequest } from "@/lib/catalog/types";
import { ACCOUNT_PROJECT_LIMITS, createAccountProject, deleteAccountProject, getAccountProject, listAccountProjects, updateAccountProject } from "./account-projects";
import type { ToolStep } from "./account-tool-run";
import { createPipeline } from "./chains";
import { db } from "./db";
import { cancelGeneration, createGenerations, getGeneration, previewChained } from "./generations";
import { isOffered } from "./model-access";
import { storedMedia } from "./storage";
import { tenantAccount } from "./tenant";

/**
 * Translate & dub sessions. A session remembers the source video, the languages and which generations
 * make each step; the steps themselves are ordinary chained generations (createPipeline), so they run,
 * survive restarts and show in the Library like everything else. Step mode is two pipelines with a
 * review in between: prepare (stems → transcript → translations) and, per language, voice.
 */

/** A cue as the browser sends it (review and captions editors). */
export const CueSchema = z.object({ start: z.number().min(0).max(36_000), end: z.number().min(0).max(36_000), text: z.string().max(2000) });

interface Row {
  id: string;
  data_json: string;
  created_at: number;
  updated_at: number;
}

type SessionData = Omit<DubSession, "id" | "createdAt" | "updatedAt">;

const toSession = (r: Row): DubSession => ({ ...(JSON.parse(r.data_json) as SessionData), id: r.id, createdAt: r.created_at, updatedAt: r.updated_at });

/**
 * A signed-in account's dubs (public sign-up) are its own projects (account-projects.ts, kind "dub"), never rows of the
 * owner's dub_sessions: inside the account's work (asAccount) every read and change names it, so another account's dub
 * or the owner's reads as not found. Its steps are its own runs (src/server/account-tool-run.ts).
 */
const DUB_KIND = "dub";

/** The session's data as it's stored (its id and times are the row's). */
function dataOf(s: DubSession): SessionData {
  const { id, createdAt, updatedAt, ...data } = s;
  void id;
  void createdAt;
  void updatedAt;
  return data;
}

/** A line in an account's list of dubs: what the list shows without reading the dub. */
const summaryOf = (s: DubSession) => ({ mode: s.mode, engine: s.engine, targets: s.targets });

function save(s: DubSession): DubSession {
  const data = dataOf(s);
  const account = tenantAccount();
  if (account) {
    const saved = updateAccountProject(account, DUB_KIND, s.id, { name: s.title, data, summary: summaryOf(s) });
    if (!saved) throw new Error("This dub no longer exists");
    return { ...s, updatedAt: saved.updatedAt };
  }
  const now = Date.now();
  db()
    .prepare("INSERT INTO dub_sessions (id, data_json, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at")
    .run(s.id, JSON.stringify(data), s.createdAt, now);
  return { ...s, updatedAt: now };
}

export function getDubSession(id: string): DubSession | null {
  const account = tenantAccount();
  if (account) {
    const p = getAccountProject<SessionData>(account, DUB_KIND, id);
    return p ? { ...p.data, id: p.id, createdAt: p.createdAt, updatedAt: p.updatedAt } : null;
  }
  const r = db().prepare("SELECT * FROM dub_sessions WHERE id = ?").get(id) as Row | undefined;
  return r ? toSession(r) : null;
}

/** An account has room for another dub (its projects of this kind): the words to say when it hasn't, else null. */
export function dubRoomProblem(): string | null {
  const account = tenantAccount();
  if (!account) return null;
  return listAccountProjects(account, DUB_KIND).length >= ACCOUNT_PROJECT_LIMITS.projects ? `You can keep up to ${ACCOUNT_PROJECT_LIMITS.projects} dubs. Delete one to make another.` : null;
}

/** Every generation id a session refers to. */
function sessionIds(s: DubSession): string[] {
  return [
    ...Object.values(s.prepare ?? {}),
    ...Object.values(s.oneshot ?? {}),
    ...Object.values(s.voices ?? {}).flatMap((runs) => runs.flatMap((r) => Object.values(r.ids))),
  ];
}

export function dubView(s: DubSession): DubSessionView {
  const generations: Record<string, Generation> = {};
  for (const id of sessionIds(s)) {
    // Trashed steps still count for the session (their status), like Cinema's takes.
    const g = getGeneration(id, { includeDeleted: true });
    if (g) generations[id] = g;
  }
  return { ...s, generations };
}

export function listDubSessions(limit = 30): DubSessionView[] {
  const n = Math.max(1, Math.min(100, limit));
  const account = tenantAccount();
  if (account) {
    return listAccountProjects(account, DUB_KIND)
      .slice(0, n)
      .flatMap((p) => {
        const s = getDubSession(p.id);
        return s ? [dubView(s)] : [];
      });
  }
  const rows = db().prepare("SELECT * FROM dub_sessions ORDER BY updated_at DESC LIMIT ?").all(n) as Row[];
  return rows.map((r) => dubView(toSession(r)));
}

export interface CreateDubInput {
  engine: Engine;
  mode: "oneshot" | "steps";
  video: string;
  title?: string;
  source?: string;
  targets: string[];
  model?: OneShotModel;
  /** The video's length as the browser measured it (seconds); the file's header wins when it has one. */
  duration?: number;
  /** Open engine, step mode: the voice split (MelBand RoFormer by default, or DBS). */
  voiceSplit?: VoiceSplit;
}

/**
 * The source's length: its MP4/MOV header, else what the browser measured. The dubbed voice track is this long. Only
 * the header is read, once per file (a dub is checked, priced and started, each asking for the length), and a visitor's
 * price check reads only its own file (storedMedia). Gone, another's, or a header Fuobe can't read (WebM): what the
 * browser measured.
 */
export function videoLength(ref: string, measured?: number): number | undefined {
  const info = storedMedia(ref)?.info;
  const v = info?.videoDuration ?? info?.duration;
  if (v && v > 0) return v;
  return measured && measured > 0 ? measured : undefined;
}

/**
 * The voice split an open step dub runs: the one asked for, else the default as Settings → Models & licences leaves it
 * (MelBand RoFormer, or DBS when MelBand is switched off), as the studio's picker does. None on the cloud or one shot.
 */
export function dubVoiceSplit(input: Pick<CreateDubInput, "engine" | "mode" | "voiceSplit">): VoiceSplit | undefined {
  return input.engine === "open" && input.mode === "steps" ? pickVoiceSplit(input.voiceSplit, (id) => isOffered(id, "open")) : undefined;
}

/** A dub planned, not started: the session it will be, and its one-shot jobs or its prepare pipeline. */
export interface DubPlan {
  base: DubSession;
  oneshot?: { model: OneShotModel; jobs: { lang: { code: string }; request: GenerationRequest }[] };
  steps?: DubStep[];
}

/**
 * Plan a dub. Inside a signed-in account's work its translations run on its own GPU (Qwen3.5 4B), never on this
 * install's AI helper (prepareSteps `translator`).
 */
export function planDub(input: CreateDubInput): DubPlan {
  if (input.mode === "oneshot" && input.engine === "open") throw new Error("One-shot dubbing is a cloud service — the open engine dubs step by step");
  const now = Date.now();
  const title = input.title?.trim().slice(0, 120) || "Dubbed video";
  const duration = videoLength(input.video, input.duration);
  const voiceSplit = dubVoiceSplit(input);
  const base: DubSession = {
    id: nanoid(10),
    title,
    engine: input.engine,
    mode: input.mode,
    video: input.video,
    source: input.source || "auto",
    targets: [...new Set(input.targets)],
    ...(duration && { duration }),
    ...(voiceSplit && { voiceSplit }),
    batchId: nanoid(10),
    createdAt: now,
    updatedAt: now,
  };
  if (input.mode === "oneshot") {
    const model = input.model ?? "heygen-translate";
    return { base, oneshot: { model, jobs: oneShotRequests({ model, video: input.video, source: input.source, targets: base.targets, title }) } };
  }
  const gpu = tenantAccount() ? ({ translator: "gpu", seconds: duration } as const) : {};
  return { base, steps: prepareSteps({ engine: input.engine, video: input.video, source: input.source, targets: base.targets, title, voiceSplit, ...gpu }) };
}

/** A planned dub's requests as an account's run checks them (src/server/account-tool-run.ts). */
export function dubPlanSteps(p: DubPlan): ToolStep[] {
  if (p.oneshot) return p.oneshot.jobs.map((j) => ({ request: j.request }));
  return (p.steps ?? []).map(toolStep);
}

const toolStep = (st: DubStep): ToolStep => ({ request: st.chain ? { ...st.request, chain: st.chain } : st.request, deps: asList(st.after).length });

/**
 * Start a planned dub. An account's is kept as one of its own projects first (its id is the dub's), and forgotten
 * again when nothing could start.
 */
export function startDub(p: DubPlan): DubSessionView {
  const account = tenantAccount();
  let base = p.base;
  if (account) {
    const made = createAccountProject(account, DUB_KIND, { name: base.title, data: dataOf(base), summary: summaryOf(base) });
    base = { ...base, id: made.id, createdAt: made.createdAt, updatedAt: made.updatedAt };
  }
  const forget = () => account && deleteAccountProject(account, DUB_KIND, base.id);
  if (p.oneshot) {
    const oneshot: Record<string, string> = {};
    const made: Generation[] = [];
    try {
      for (const j of p.oneshot.jobs) {
        const g = createGenerations(j.request, { batchId: base.batchId })[0];
        made.push(g);
        oneshot[j.lang.code] = g.id;
      }
    } catch (e) {
      // An account keeps the languages that started (it can open and stop them); with none, its dub is forgotten.
      if (account && made.length) save({ ...base, model: p.oneshot.model, oneshot });
      else forget();
      throw new Error(made.length ? `${(e as Error).message} (the other languages were started)` : (e as Error).message);
    }
    return dubView(save({ ...base, model: p.oneshot.model, oneshot }));
  }
  let run: ReturnType<typeof createPipeline>;
  try {
    run = createPipeline(p.steps ?? [], { batchId: base.batchId });
  } catch (e) {
    forget();
    throw e;
  }
  const prepare = Object.fromEntries(Object.entries(run.byKey).map(([k, g]) => [k, g.id]));
  return dubView(save({ ...base, prepare }));
}

export function createDubSession(input: CreateDubInput): DubSessionView {
  return startDub(planDub(input));
}

/** Save the reviewed lines of one language (nothing is spoken until voiceDub). */
export function saveDubDraft(id: string, lang: string, cues: Cue[]): DubSessionView {
  const s = getDubSession(id);
  if (!s) throw new Error("This dub no longer exists");
  if (!s.targets.includes(lang)) throw new Error("That language isn't part of this dub");
  return dubView(save({ ...s, drafts: { ...s.drafts, [lang]: normalizeCues(cues) } }));
}

/** The voice pipeline of one language, planned (not started): the steps and the session as it'll be saved. */
function planVoice(id: string, lang: string, opts: { cues?: Cue[]; lipsync?: boolean }): { s: DubSession; current: DubSession; steps: DubStep[]; lipsync: boolean; lang: string } {
  const s = getDubSession(id);
  if (!s) throw new Error("This dub no longer exists");
  if (s.mode !== "steps") throw new Error("This dub was made in one go — there's nothing to voice");
  if (!s.targets.includes(lang)) throw new Error("That language isn't part of this dub");
  const current: DubSession = opts.cues ? { ...s, drafts: { ...s.drafts, [lang]: normalizeCues(opts.cues) } } : s;
  const view = dubView(current);
  const stage = languageStage(view, lang);
  if (stage === "preparing") throw new Error("The translation isn't ready yet");
  if (stage === "failed" && !view.voices?.[lang]?.length) throw new Error("An earlier step failed — start a new dub");
  const cues = reviewCues(view, lang);
  if (!cues?.length) throw new Error("There are no translated lines to speak");
  const media = prepareMedia(view);
  if (!media.voice) throw new Error("The voice to clone is missing from the first step");
  const lipsync = opts.lipsync !== false;
  const steps = voiceSteps({ engine: s.engine, video: s.video, lang, cues, voiceRef: media.voice, background: media.background, lipsync, duration: s.duration ?? videoLength(s.video), title: s.title });
  return { s, current, steps, lipsync, lang };
}

export type VoicePlan = ReturnType<typeof planVoice>;

/** One language's voice pipeline planned, not started (an account's run checks its steps first: voicePlanSteps). */
export const planVoiceDub = (id: string, lang: string, opts: { cues?: Cue[]; lipsync?: boolean } = {}): VoicePlan => planVoice(id, lang, opts);

export const voicePlanSteps = (p: VoicePlan): ToolStep[] => p.steps.map(toolStep);

/** Speak the reviewed lines of one language: the voice pipeline. */
export function voiceDub(id: string, lang: string, opts: { cues?: Cue[]; lipsync?: boolean } = {}): DubSessionView {
  return startVoiceDub(planVoice(id, lang, opts));
}

/** Start a planned voice pipeline (an account's, inside asAccount after its checks). */
export function startVoiceDub({ s, current, steps, lipsync, lang }: VoicePlan): DubSessionView {
  const run = createPipeline(steps, { batchId: s.batchId });
  const ids = Object.fromEntries(Object.entries(run.byKey).map(([k, g]) => [k, g.id]));
  const voices = { ...s.voices, [lang]: [...(s.voices?.[lang] ?? []), { ids, at: Date.now(), lipsync }] };
  return dubView(save({ ...current, voices }));
}

// ---------------------------------------------------------------------------
// Prices, before anything runs

const asList = (a: string | string[] | undefined) => (a === undefined ? [] : Array.isArray(a) ? a : [a]);

/** Price planned steps; per-second and per-minute steps are priced for the video's length. */
export function priceSteps(engine: Engine, steps: DubStep[], seconds?: number): DubPrice {
  let costUsd = 0;
  let demo = false;
  const unpriced = new Set<string>();
  for (const st of steps) {
    const unit = getModel(st.request.modelId)?.pricing?.unit;
    const timed = seconds && (unit === "second" || unit === "minute") && st.request.params?.duration === undefined ? { ...st.request, params: { ...st.request.params, duration: seconds } } : st.request;
    const p = previewChained(st.chain ? { ...timed, chain: st.chain } : timed, asList(st.after).length);
    demo ||= p.demo;
    if (p.costUsd === null) unpriced.add(p.model.name);
    else costUsd += p.costUsd;
  }
  return { engine, costUsd: Math.round(costUsd * 1000) / 1000, unpriced: demo || engine === "open" ? [] : [...unpriced], demo, steps: steps.length };
}

/** What starting this dub would cost (POST /api/dub?preview=1). */
export function previewDub(input: CreateDubInput): DubPrice {
  if (input.mode === "oneshot" && input.engine === "open") throw new Error("One-shot dubbing is a cloud service — the open engine dubs step by step");
  // An account prices only its own video (or one of Fuobe's examples): another's reads as a missing file.
  if (tenantAccount() && !storedMedia(input.video)) throw new Error("That video is gone — add it again");
  const seconds = videoLength(input.video, input.duration);
  const targets = [...new Set(input.targets)];
  if (input.mode === "oneshot") {
    const jobs = oneShotRequests({ model: input.model ?? "heygen-translate", video: input.video, source: input.source, targets });
    return priceSteps(input.engine, jobs.map((j, i) => ({ key: `dub:${i}`, request: j.request })), seconds);
  }
  // An account's translations run on its own GPU (planDub), and are priced so.
  const gpu = tenantAccount() ? ({ translator: "gpu", seconds } as const) : {};
  return priceSteps(input.engine, prepareSteps({ engine: input.engine, video: input.video, source: input.source, targets, voiceSplit: dubVoiceSplit(input), ...gpu }), seconds);
}

/** What voicing one language would cost (POST /api/dub/[id]/voice?preview=1). */
export function previewVoiceDub(id: string, lang: string, opts: { cues?: Cue[]; lipsync?: boolean } = {}): DubPrice {
  const { s, steps } = planVoice(id, lang, opts);
  return priceSteps(s.engine, steps, s.duration ?? videoLength(s.video));
}

/** Forget a dub: steps still waiting or running are stopped first (nothing more is spent); finished results stay in the Library. */
export function deleteDubSession(id: string): boolean {
  const s = getDubSession(id);
  if (s) stopSteps(sessionIds(s));
  const account = tenantAccount();
  if (account) return deleteAccountProject(account, DUB_KIND, id);
  return db().prepare("DELETE FROM dub_sessions WHERE id = ?").run(id).changes > 0;
}

/** Cancel the generations among these that haven't finished. */
export function stopSteps(ids: string[]): number {
  let n = 0;
  for (const gid of ids) {
    const g = getGeneration(gid);
    if (g && (g.status === "queued" || g.status === "running")) {
      void cancelGeneration(gid);
      n++;
    }
  }
  return n;
}

export { DUB_FEATURE };
