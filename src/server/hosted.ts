import "server-only";
import { getModel } from "@/lib/catalog";
import type { GenerationRequest } from "@/lib/catalog/types";
import { db } from "./db";
import { hostedRunsOn } from "./hosted-switch";
import { onInstallComfy } from "./providers/comfyui";
import { getSetting, withCandidates } from "./settings";
import { runAsTenant } from "./tenant";
import type { Policy, QueueFacts, RunFacts } from "./billing";

/**
 * Hosted runs (FUOBE_HOSTED_RUNS=1; docs/public-signup.md "Hosted runs"): an account with no GPU of its own may run on
 * this install's GPUs (the "pool" place). With the switch off, nothing here is used and accounts run as before: on
 * their own GPU or their own key only.
 *
 * Where an account's run goes (the generations route):
 * 1. the account asked for its own GPU, or its own GPU is online and it didn't ask for this install's → its own GPU;
 * 2. a paid model and its own key → its own key;
 * 3. hosted runs are on, the model runs on ComfyUI, and the policy allows it → this install's GPUs, with a billing hold
 *    when a billing service is set (billing.ts), free otherwise;
 * 4. otherwise today's answer ("Connect your GPU", "Add your key").
 *
 * This install's GPUs are its own ComfyUI server (Settings → ComfyUI address). An install whose ComfyUI is on the
 * owner's computer (a browser tab) doesn't offer hosted runs: that computer is the owner's alone.
 */

export const hostedRuns = hostedRunsOn;

/** Hosted runs are on and this install has a ComfyUI server they can use. */
export function poolReady(): boolean {
  if (!hostedRunsOn()) return false;
  if (getSetting("comfyWhere") === "computer") return false;
  return !!getSetting("comfyUrl").trim();
}

/**
 * Run `fn` as an account's run on this install's GPUs: as the account (its own files and runs only), on this install's
 * ComfyUI server, the open engine, no demo outputs.
 */
export function runOnPool<T>(accountId: string | null, fn: () => T): T {
  const inside = () => onInstallComfy(() => withCandidates({ engineMode: "open", demoMode: "off" }, fn));
  return accountId ? runAsTenant({ kind: "account", id: accountId }, inside) : runAsTenant({ kind: "guest" }, inside);
}

/** Words for runs on this install's GPUs (generic: they fit any install). */
export const HOSTED_WORDS = {
  notOffered: "This one runs on your own GPU. Connect one in Settings, or pick another model.",
  loras: "Extra LoRAs run on your own GPU. Connect one in Settings, or run without them.",
  inputs: "This kind of file runs on your own GPU. Connect one in Settings, or use a picture.",
  rtxCard: "This one needs an NVIDIA RTX card, and this studio's GPUs can't run it right now. Connect your own GPU in Settings, or pick another choice.",
  notHosted: "Runs on this studio's GPUs aren't open to this account. Connect your own GPU in Settings.",
  waitedTooLong: "This studio's GPUs were busy, so it didn't run. Not charged.",
};

/** May this model (and app) run on this install's GPUs under this policy? */
export function poolAllows(p: Pick<Policy, "pool">, modelId: string, presetId?: string | null): boolean {
  const m = p.pool ?? {};
  if (m.deny?.includes(modelId)) return false;
  if (m.allow && !m.allow.includes(modelId)) return false;
  if (presetId) {
    if (m.apps?.deny?.includes(presetId)) return false;
    if (m.apps?.allow && !m.apps.allow.includes(presetId)) return false;
  }
  return true;
}

/**
 * May this whole run go on this install's GPUs: its model and every other step it makes (a 2K take's Open-H3 Regenerate
 * finish), so a policy that keeps a model off the pool keeps it off as a step too.
 */
export function poolAllowsRun(p: Pick<Policy, "pool">, planned: { model: { id: string }; steps?: { model: string }[] }, presetId?: string | null): boolean {
  return [planned.model.id, ...(planned.steps ?? []).map((s) => s.model)].every((id) => poolAllows(p, id, presetId));
}

/** The file kinds a request uses (for the policy's uploads rule and the billing facts). */
export function inputCounts(req: GenerationRequest): { image: number; video: number; audio: number } {
  const i = req.inputs ?? {};
  const image = (i.images?.length ?? 0) + (i.endImage ? 1 : 0) + (i.mask ? 1 : 0) + (i.sketch ? 1 : 0);
  const video = (i.video ? 1 : 0) + (i.videos?.length ?? 0);
  const audio = [i.audio, i.audio2, i.voiceAudio, i.voiceAudio2].filter(Boolean).length + (i.audios?.length ?? 0);
  return { image, video, audio };
}

/** The pool's one lane while this install's GPUs are its own ComfyUI server. */
export const POOL_LANE = "comfyui";

/** The pool's rows that wait or run (the route's place-in-line facts). */
const POOL_ROWS = "json_extract(g.request_json, '$.place') = 'pool' AND g.status IN ('queued', 'running')";

/** How long a run on this install's GPUs may wait in line: the billing service's limit, else FUOBE_POOL_WAIT_MIN (30). */
export function poolWaitMs(stamped?: number): number {
  if (stamped && stamped > 0) return stamped;
  const m = Number(process.env.FUOBE_POOL_WAIT_MIN);
  return (Number.isFinite(m) && m > 0 ? m : 30) * 60_000;
}

/** A typical run's time on this install's GPUs (the median of the last 20 that finished), or null before any. */
function typicalRunMs(): number | null {
  const rows = db()
    .prepare(
      `SELECT g.completed_at - r.started_at AS ms FROM generations g JOIN generation_runs r ON r.id = g.id
       WHERE json_extract(g.request_json, '$.place') = 'pool' AND g.status = 'succeeded' AND r.started_at IS NOT NULL AND g.completed_at > r.started_at
       ORDER BY g.completed_at DESC LIMIT 20`,
    )
    .all() as { ms: number }[];
  if (!rows.length) return null;
  const sorted = rows.map((r) => r.ms).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Rows not started yet (no provider start): they wait in line. */
const WAITING = "NOT EXISTS (SELECT 1 FROM generation_runs r WHERE r.id = g.id AND r.started_at IS NOT NULL)";

/** The line on this install's GPUs right now, for a quote or a reserve (QueueFacts). */
export function queueFacts(accountId: string | null): QueueFacts {
  const d = db();
  const ahead = (d.prepare(`SELECT COUNT(*) AS n FROM generations g WHERE ${POOL_ROWS} AND ${WAITING}`).get() as { n: number }).n;
  const typical = typicalRunMs();
  const mine = accountId
    ? (d
        .prepare(
          `SELECT SUM(CASE WHEN ${WAITING} THEN 1 ELSE 0 END) AS waiting, SUM(CASE WHEN ${WAITING} THEN 0 ELSE 1 END) AS running
           FROM generations g WHERE ${POOL_ROWS} AND json_extract(g.request_json, '$.account') = ?`,
        )
        .get(accountId) as { waiting: number | null; running: number | null })
    : { waiting: 0, running: 0 };
  return {
    lane: POOL_LANE,
    ahead,
    etaS: typical === null ? null : Math.round(((ahead + 1) * typical) / 1000),
    workersOnline: poolReady() ? 1 : 0,
    nextOpenAt: null,
    mine: { waiting: mine.waiting ?? 0, running: mine.running ?? 0 },
  };
}

/** A waiting row's place in line on this install's GPUs (1: next), and the wait, about. Null when it isn't waiting there. */
export function placeInLine(generationId: string): { place: number; etaSeconds: number | null } | null {
  const d = db();
  const row = d.prepare(`SELECT g.created_at FROM generations g WHERE g.id = ? AND ${POOL_ROWS} AND ${WAITING}`).get(generationId) as { created_at: number } | undefined;
  if (!row) return null;
  const before = (d.prepare(`SELECT COUNT(*) AS n FROM generations g WHERE ${POOL_ROWS} AND ${WAITING} AND (g.created_at < ? OR (g.created_at = ? AND g.id < ?))`).get(row.created_at, row.created_at, generationId) as { n: number }).n;
  const typical = typicalRunMs();
  return { place: before + 1, etaSeconds: typical === null ? null : Math.round(((before + 1) * typical) / 1000) };
}

/** The facts the billing service prices a run by (from a planned request: previewGeneration's answer). */
export function runFacts(
  req: GenerationRequest,
  p: { model: { id: string; kind: string; engine: "open" | "cloud" }; op: string; jobs: number; outputs: number; providerId: string; costUsd: number | null; loras: { applied: unknown[] }; steps?: { model: string; op: string }[] },
  kind: RunFacts["kind"],
): RunFacts {
  const model = getModel(p.model.id);
  return {
    place: "pool",
    model: p.model.id,
    op: p.op ?? null,
    app: req.presetId ?? null,
    preset: req.presetId ?? null,
    studio: req.feature,
    kind,
    engine: p.model.engine,
    provider: p.providerId,
    jobs: p.jobs,
    outputsPerJob: p.jobs > 0 ? Math.max(1, Math.round(p.outputs / p.jobs)) : 1,
    megapixels: null,
    seconds: req.params?.duration ?? (kind === "video" ? (model?.defaults?.duration ?? null) : null),
    fps: req.params?.fps ?? null,
    loras: p.loras.applied.length,
    inputs: inputCounts(req),
    lane: POOL_LANE,
    providerUsd: p.costUsd,
    // The run's other steps (a 2K take's finish), each a model and op the service prices beside the main one.
    ...(p.steps?.length && { steps: p.steps.map((s) => ({ model: s.model, op: s.op })) }),
  };
}
