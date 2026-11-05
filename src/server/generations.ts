import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { getModel, getPreset } from "@/lib/catalog";
import { ANY_ANGLE } from "@/lib/catalog/any-angle";
import { NO_SUBJECT_MESSAGE, withFrontView } from "./any-angle";
import { applyMentions } from "@/lib/catalog/elements";
import { migrateRequest, replacedBy } from "@/lib/catalog/replaced";
import { directorFieldWords } from "@/lib/catalog/cinema";
import { withSignatureWords } from "@/lib/catalog/palettes";
import { applySketch, stripMotionPaths } from "@/lib/catalog/sketch";
import { cueText, type Cue } from "@/lib/cues";
import { HELPER_FEATURES, HELPER_SUFFIX, isReviewStatus, type AssetUse, type ReviewFilter } from "@/lib/library";
import { checkWatermarkBoxes, COPY as WATERMARK_COPY, parseScanReport, rejectedRepair, type WatermarkQuality } from "@/lib/watermark";
import { sideMultipleProblem, upscaleTier } from "@/lib/av/upscale";
import { chainedWaitMessage, framesWait, keyframeChain } from "@/lib/catalog/keyframes";
import { clipFpsProblem, clipSizeProblem, clipTotalProblem, clipWindowProblem, elementClipProblem, insertRangeProblem, portraitShapeProblem, sourceFrames, voiceWindowProblem } from "@/lib/catalog/clip-windows";
import { avatarSeconds, clipEditSeconds, estimateCost, inferOperation, movedAppRequest, planGeneration, presetRoute, routeLoras, routesFor, sourceLengthProblem, withoutTriggers } from "@/lib/catalog/plan";
import { framedLength, keepMatte, sizeValue } from "@/lib/catalog/payload";
import { fitLoras, loraName, lorasFit } from "@/lib/catalog/loras";
import { dualEngine, onEngine, pickEngine } from "@/lib/catalog/engines";
import { promptWithLoras, SOUL_MODELS, soulKind, soulLook, soulPostStep, soulPostSteps } from "@/lib/catalog/soul";
import { isDop } from "@/lib/catalog/dop";
import { postStepCost } from "@/lib/composer";
import { MIXED_ORIGINAL, originalFrameSize } from "@/lib/catalog/mixed-media";
import { imageSize } from "@/lib/image-size";
import { finishSteps, mosaicPixels, unionMasks } from "@/lib/soul-post";
import { ANGLES_ORIGINAL, MOSAIC_SCALE } from "@/lib/catalog/open-tools";
import { computeDimensions } from "@/lib/comfy";
import { captionFromWords, parseCaption } from "@/lib/ideogram-caption";
import { h3Frames, h3Prompt, inH3Layout } from "@/lib/h3-prompt";
import { h3ReferenceTags, h3TalkPrompt } from "@/lib/h3-references";
import {
  CHAIN_LIST_SLACK,
  LAST_FRAME_CHAIN,
  OPERATION_OUTPUT,
  type ChainSlot,
  type Engine,
  type Generation,
  type GenerationFix,
  type GenerationRequest,
  type MediaKind,
  type GenInput,
  type LoraRef,
  type ModelDef,
  type ModelRoute,
  type Operation,
  type OutputFile,
  type Preset,
  type ProviderId,
} from "@/lib/catalog/types";
import { db } from "./db";
import { keepVoiceEmbedding, savedVoiceFor } from "./voices";
import { listElements } from "./elements";
import { markStale } from "./gpu/snapshots";
import { loadIndex } from "./gpu/index-file";
import { qwen21Gpu } from "./qwen21-gpu";
import { h3Gpu } from "./h3-gpu";
import { H3_TIER_PARAM, H3_UNET_PARAM } from "@/lib/gpu/h3-tier";
import { DETAILS_MAX_IMAGES, GPU_PARAM, QWEN21_SPEED, speedLora } from "@/lib/qwen21-speed";
import { BLOCKED_CARD_MESSAGE, looksBlocked } from "./safety-card";
import { pollTrainings } from "./training";
import { createEndFrameClip, createExtendChain, createKeyframeFilm, createMosaicRun, createRefinedModel, createRelitClip, createShotFilm, createStillTo3d, createVoiceFirst, joinClips } from "./chains";
import { chainedRefine } from "@/lib/av/hi3d";
import { wantsVoiceFirst } from "@/lib/av/voice-first";
import { createH3TwoKRun, createRegenerateRun, keepsH3Latent, regenHeld, regenSwitchedOff } from "./regenerate";
import { H3_2K_STEPS_NOTE, h3TwoKRequests, REGEN_COPY, REGEN_MODEL, regenerateGraphLoras, wantsH3TwoK } from "@/lib/catalog/regenerate";
import { enhancePrompt, enhanceSoulWords, ideogramCaption } from "./enhance";
import { kandinskyPrompt } from "@/lib/kandinsky-prompt";
import { carriesLayout } from "@/lib/layout-prompt";
import { setResolver, watchGenerations, type LiveEvent } from "./live";
import { provider, PROVIDERS, RETIRED_PROVIDER_ERROR } from "./providers";
import { comfyLoraFiles, comfyPlace, computerScope, onOwnGpu, outputFetch, outsideOwnGpu, OWN_OUTPUT_LIMITS, ownGpu, ownLink, probeComfy, relayFile, troubleError, type OwnGpu } from "./providers/comfyui";
import { accountById, accountGpu, gpuLink, type AccountGpu } from "./auth";
import { accountEngineMode, accountKey, accountProviders, paidAllowed } from "./account-keys";
import { addKeyMessage, CLOUD_PROVIDERS, isCloudProvider, keyRemovedMessage, type CloudProvider } from "@/lib/your-keys";
import { cachedGpuState, GpuError, noteGpuState, testGpu } from "./account-gpu";
import { presetRoutes } from "@/lib/catalog/preset-recipe-routes";
import {
  backoffMs,
  diagnoseGpu,
  diagnoseGpuJob,
  diagnoseKey,
  resultExpired,
  retryPlan,
  troubleOf,
  waitingWords,
  withKeyAction,
  type Diagnosis,
  type GpuFailure,
  type KeyStage,
  type RunTrouble,
  type TroubleAction,
} from "@/lib/diagnose";
import { CONNECT_GPU_MESSAGE, GUEST_RUN_MESSAGE, OWN_GPU_TOOL_MESSAGE } from "@/lib/guest-access";
import { outsideTenant, runAsTenant, tenant, tenantAccount } from "./tenant";
import { generationAccount } from "./account-library";
import { ACCOUNT_LIMITS, ACCOUNT_MESSAGES, accountTotalBytes, accountUsage, diskHasRoom, filesFullMessage } from "./account-files";
import { checkAccountLoras } from "./account-loras";
import { missingFilesMessage, type MissingFiles } from "@/lib/missing-files";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { graphLoras as h3GraphLoras } from "@/lib/catalog/character-swap";
import { PIKA_FLEX_REF_WORKFLOW, pikaFlexGraphLoras } from "@/lib/catalog/pika-flex";
import { restoreGraphLoras } from "@/lib/restore-graph";
import { ensureLorasOnComfy, prepareCloudLoras, withoutUnreachableCivitai } from "./loras";
import { ACCESS_PLACE } from "@/lib/model-access";
import { offeredLoras, offeredRoutes, requireOffered } from "./model-access";
import { llmBackends, llmLabel, llmMissing, llmUsesClaude, probeLocal } from "./providers/llm";
import type { PollContext, PollResult, ProviderAdapter, RemoteOutput } from "./providers/types";
import { mediaFacts } from "./media-facts";
import { renderPathVideo } from "./path-render";
import { songFormat, songToolProblem } from "@/lib/lyrics";
import { hostedUntested } from "@/lib/catalog/hosted-untested";
import { modelToFinish, startModelFinish, startTurntable, stopModelFinish, type OutputStore } from "./model3d-finish";
import { cropPicture, isCropWindow } from "./crop-picture";
import { convertMask, decodePng, encodePng } from "./png";
import { engineMode, getSetting, withCandidates, withoutCandidates } from "./settings";
import { blockedForAccounts, discardBody, fetchRemoteToFile, RemoteFetchError } from "./remote-fetch";
import { accountSend } from "./account-send";
import { stamped, stampOf, withRunStamp } from "./run-stamp";
import { placeInLine, poolWaitMs, runOnPool } from "./hosted";
import { sweepBilling } from "./billing-outbox";
import { inDemoScope, outsideDemo } from "./demo-scope";
import { moderationConfigured } from "./moderation";
import { holdForCheck, sweepOutputChecks } from "./output-checks";
import { absolutePath, adoptFile, contentTypeFor, deleteAsset, localHead, readRef, saveFile, scratchDir, scratchOutputFile } from "./storage";

interface Row {
  id: string;
  batch_id: string | null;
  feature: string;
  preset_id: string | null;
  model_id: string;
  engine: Generation["engine"];
  provider: ProviderId;
  op: Generation["op"];
  kind: Generation["kind"];
  status: Generation["status"];
  progress: number | null;
  message: string | null;
  prompt: string | null;
  request_json: string;
  provider_input_json: string | null;
  external_id: string | null;
  external_meta_json: string | null;
  outputs_json: string;
  error: string | null;
  cost_usd: number | null;
  favorite: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  depends_on: string | null;
  /** Library pin and review status (NULL until set; inserts leave them out). */
  pinned_at?: number | null;
  review?: string | null;
  /** Joined by the library readers (generation_trash, folder_items); looked up when absent. */
  deleted_at?: number | null;
  folder_id?: string | null;
  /** What a failed ComfyUI run was missing (GenerationFix as JSON). */
  fix_json?: string | null;
  /** NULL, or "checking": its outputs wait for the moderation service (output-checks.ts). */
  stage?: string | null;
}

/** Trash and folder columns, joined onto every library read. */
const LIBRARY_COLUMNS = "g.*, t.deleted_at AS deleted_at, fi.folder_id AS folder_id";
const LIBRARY_JOINS = "LEFT JOIN generation_trash t ON t.generation_id = g.id LEFT JOIN folder_items fi ON fi.generation_id = g.id";
const LIBRARY_JOIN = `generations g ${LIBRARY_JOINS}`;

export function toGeneration(r: Row): Generation {
  const stored = JSON.parse(r.request_json) as GenerationRequest;
  // The billing hold is the server's: never sent to a browser or a script.
  const { hold, ...request } = stored;
  const checking = r.stage === "checking";
  const model = getModel(r.model_id);
  const ar = request.params?.aspectRatio ?? model?.defaults?.aspectRatio;
  // Rows read without the library join (the runner's own SELECTs) look the trash and folder up.
  const lib =
    r.deleted_at !== undefined && r.folder_id !== undefined
      ? { deleted_at: r.deleted_at, folder_id: r.folder_id }
      : (db()
          .prepare(
            "SELECT (SELECT deleted_at FROM generation_trash WHERE generation_id = ?) AS deleted_at, (SELECT folder_id FROM folder_items WHERE generation_id = ?) AS folder_id",
          )
          .get(r.id, r.id) as { deleted_at: number | null; folder_id: string | null });
  return {
    id: r.id,
    batchId: r.batch_id,
    feature: r.feature,
    presetId: r.preset_id,
    modelId: r.model_id,
    engine: r.engine,
    provider: r.provider,
    op: r.op,
    kind: r.kind,
    status: r.status,
    progress: r.progress,
    message: r.message,
    prompt: r.prompt,
    request,
    // Held for the moderation service's check: nothing of it is shown until it passes.
    outputs: checking ? [] : (JSON.parse(r.outputs_json) as OutputFile[]),
    error: r.error,
    costUsd: r.cost_usd,
    favorite: !!r.favorite,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
    // A run on a model Fuobe retired keeps the name it ran under (replaced.ts `was`); Reuse moves it to the replacement.
    modelName: model?.name ?? replacedBy(r.model_id)?.was ?? r.model_id,
    // A Fuobe Soul look is named like a preset ("Look · Y2K" in the viewer).
    presetName: r.preset_id ? (getPreset(r.preset_id)?.name ?? (soulKind(r.model_id) ? (soulLook(r.preset_id)?.name ?? null) : null)) : null,
    aspectRatio: ar && ar !== "auto" ? ar : null,
    deletedAt: lib.deleted_at ?? null,
    folderId: lib.folder_id ?? null,
    pinnedAt: r.pinned_at ?? null,
    review: isReviewStatus(r.review) ? r.review : null,
    ...(r.status === "failed" && r.fix_json && { fix: parseFix(r.fix_json) }),
    ...(r.status === "failed" && r.fix_json && parseTrouble(r.fix_json)),
    // Failed or stopped before a paid provider took the job (a refused key, an empty balance): nothing was billed.
    ...((r.status === "failed" || r.status === "canceled") && !r.external_id && (r.provider === "fal" || r.provider === "replicate") && { notBilled: true as const }),
    // On this install's GPUs (hosted runs): what it cost, or that it cost nothing.
    ...(stored.place === "pool" && { place: "pool" as const }),
    ...(stored.charge && r.status === "succeeded" && { charge: stored.charge }),
    ...(hold && (r.status === "failed" || r.status === "canceled") && { notCharged: true as const }),
    ...(checking && { stage: "checking" as const }),
    // Waiting in line on this install's GPUs: its place and the wait, about.
    ...(stored.place === "pool" && (r.status === "queued" || r.status === "running") && !checking && poolQueue(r.id)),
  };
}

/** A pool row's place in line, as the Generation field (none once it has started). */
function poolQueue(id: string): { queue: { place: number; etaSeconds: number | null } } | Record<string, never> {
  const q = placeInLine(id);
  return q ? { queue: q } : {};
}

function parseFix(json: string): GenerationFix | null {
  try {
    const { trouble: _trouble, ...f } = JSON.parse(json) as GenerationFix & { trouble?: unknown };
    void _trouble;
    return f && typeof f.code === "string" && Array.isArray(f.items) ? f : null;
  } catch {
    return null;
  }
}

/** What an account's GPU or key ran into (fix_json `trouble`), as the Generation field. */
function parseTrouble(json: string): { trouble: RunTrouble } | Record<string, never> {
  try {
    const t = (JSON.parse(json) as { trouble?: RunTrouble }).trouble;
    return t && typeof t.cause === "string" && Array.isArray(t.actions) ? { trouble: t } : {};
  } catch {
    return {};
  }
}

function update(id: string, fields: Partial<Row>): void {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db()
    .prepare(`UPDATE generations SET ${keys.map((k) => `${k} = @${k}`).join(", ")}, updated_at = @__now WHERE id = @__id`)
    .run({ ...fields, __now: Date.now(), __id: id });
}

/**
 * Set server fields on rows a studio tool made, after it made them (a skill recipe's tool run: the `skill` stamp and the
 * skill's `batchTitle`), and on every row of their batches (the tool's helper steps). Returns those batches.
 */
export function stampRequests(ids: string[], fields: (batches: string[]) => Pick<GenerationRequest, "skill" | "batchTitle">): string[] {
  if (!ids.length) return [];
  const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");
  const batches = (db().prepare(`SELECT DISTINCT batch_id FROM generations WHERE id IN (${marks(ids.length)}) AND batch_id IS NOT NULL`).all(...ids) as { batch_id: string }[]).map((r) => r.batch_id);
  const rows = db()
    .prepare(`SELECT id, request_json FROM generations WHERE id IN (${marks(ids.length)})${batches.length ? ` OR batch_id IN (${marks(batches.length)})` : ""}`)
    .all(...ids, ...batches) as Pick<Row, "id" | "request_json">[];
  const set = fields(batches);
  db().transaction(() => {
    for (const r of rows) update(r.id, { request_json: JSON.stringify({ ...(JSON.parse(r.request_json) as GenerationRequest), ...set }) });
  })();
  return batches;
}

/** One generation; a row in the Trash reads as missing unless `includeDeleted`. */
export function getGeneration(id: string, opts: { includeDeleted?: boolean } = {}): Generation | null {
  ensureRunner();
  const r = db().prepare(`SELECT ${LIBRARY_COLUMNS} FROM ${LIBRARY_JOIN} WHERE g.id = ?`).get(id) as Row | undefined;
  if (!r || (r.deleted_at && !opts.includeDeleted)) return null;
  return toGeneration(r);
}

export interface ListOptions {
  batchId?: string;
  feature?: string;
  features?: string[];
  kind?: string;
  kinds?: string[];
  models?: string[];
  favorites?: boolean;
  status?: string;
  statuses?: string[];
  /** Only clips saved from this Marketing template (a Kinetic Motion recipe that names it). */
  template?: string;
  /** Only the Trash, newest deletion first (`before` is then a deletedAt cursor). Otherwise the Trash is left out. */
  trashed?: boolean;
  folderId?: string;
  /** In any of these folders (a folder and its subfolders). */
  folderIds?: string[];
  /** Only pinned ones, most recently pinned first (`before` is then a pinnedAt cursor); false: only the others. */
  pinned?: boolean;
  /** Review statuses ("none": no status). */
  reviews?: ReviewFilter[];
  /**
   * Also list helper steps (chain steps and helper jobs: isHelperFeature in src/lib/library.ts). A list
   * that names its features or its batch always gets them; others (the Library, the home feed,
   * Assist's list_recent) leave them out unless this is set.
   */
  steps?: boolean;
  limit?: number;
  /**
   * Paging cursor: made before this (deleted before, in the Trash). With `beforeId` it is the last
   * row of the previous page, so rows sharing its timestamp (a bulk trash, a batch made in one
   * millisecond) are paged by id instead of skipped.
   */
  before?: number;
  beforeId?: string;
  /**
   * Public sign-up: only this account's runs. Without it, only the owner's (an account's runs are its
   * own: they stay out of the owner's lists).
   */
  account?: string;
  /** Every account's runs, never the owner's: the owner's view of what accounts make (src/server/account-admin.ts). */
  accounts?: boolean;
  /** Date range on createdAt: since ≤ t < until. */
  since?: number;
  until?: number;
  q?: string;
}

const featureLike = (f: string) => (f.endsWith("*") ? `${f.slice(0, -1)}%` : f);

export function listGenerations(o: ListOptions = {}): Generation[] {
  const where: string[] = [o.trashed ? "t.deleted_at IS NOT NULL" : "t.deleted_at IS NULL"];
  const args: unknown[] = [];
  const add = (sql: string, ...values: unknown[]) => {
    where.push(sql);
    args.push(...values);
  };
  const oneOf = (col: string, values: unknown[]) => add(`${col} IN (${values.map(() => "?").join(", ")})`, ...values);
  if (o.account) add("json_extract(g.request_json, '$.account') = ?", o.account);
  // A range rather than IS NOT NULL: SQLite can search the generations_account index for a range (it scans it whole for IS NOT NULL).
  else if (o.accounts) add("json_extract(g.request_json, '$.account') > ''");
  else add("json_extract(g.request_json, '$.account') IS NULL");
  if (o.batchId) add("g.batch_id = ?", o.batchId);
  if (o.feature) add("g.feature = ?", o.feature);
  if (o.features?.length) add(`(${o.features.map(() => "g.feature LIKE ?").join(" OR ")})`, ...o.features.map(featureLike));
  if (o.kind) add("g.kind = ?", o.kind);
  if (o.kinds?.length) oneOf("g.kind", o.kinds);
  if (o.models?.length) oneOf("g.model_id", o.models);
  if (o.favorites) add("g.favorite = 1");
  if (o.status) add("g.status = ?", o.status);
  if (o.statuses?.length) oneOf("g.status", o.statuses);
  if (o.template) add("json_extract(g.request_json, '$.params.extra.motion.controls.template') = ?", o.template);
  if (o.folderId) add("fi.folder_id = ?", o.folderId);
  if (o.folderIds?.length) oneOf("fi.folder_id", o.folderIds);
  if (o.pinned !== undefined) add(o.pinned ? "g.pinned_at IS NOT NULL" : "g.pinned_at IS NULL");
  if (o.reviews?.length) {
    const set = o.reviews.filter((r) => r !== "none");
    const any = [set.length ? `g.review IN (${set.map(() => "?").join(", ")})` : "", o.reviews.includes("none") ? "g.review IS NULL" : ""].filter(Boolean);
    add(`(${any.join(" OR ")})`, ...set);
  }
  if (!o.steps && !o.feature && !o.features?.length && !o.batchId) {
    add(`g.feature NOT LIKE ? AND g.feature NOT IN (${HELPER_FEATURES.map(() => "?").join(", ")})`, `%${HELPER_SUFFIX}`, ...HELPER_FEATURES);
  }
  // The cursor's order: the Trash by deletion, a pinned list by pin, the rest by creation (then id, all descending).
  const col = o.trashed ? "t.deleted_at" : o.pinned ? "g.pinned_at" : "g.created_at";
  if (o.before) {
    if (o.beforeId) add(`(${col} < ? OR (${col} = ? AND g.id < ?))`, o.before, o.before, o.beforeId);
    else add(`${col} < ?`, o.before);
  }
  if (o.since) add("g.created_at >= ?", o.since);
  if (o.until) add("g.created_at < ?", o.until);
  const q = o.q?.trim();
  // The user's own words (request.prompt) and what the model got (prompt, with suffixes and templates).
  if (q) add("(g.prompt LIKE ? OR json_extract(g.request_json, '$.prompt') LIKE ?)", `%${q}%`, `%${q}%`);
  // Every account's runs: from the accounts' entries in generations_account, then sorted (they go after 30 days, so they
  // stay few). Left to its own plan, SQLite walks every run newest first (or every run of a status), the owner's too,
  // until the page is full: the whole table when accounts' runs are few or none match. Without the index (db.ts goes
  // on when it can't make it), the plain plan.
  const from = !o.account && o.accounts && accountIndexed() ? `generations g INDEXED BY generations_account ${LIBRARY_JOINS}` : LIBRARY_JOIN;
  const sql = `SELECT ${LIBRARY_COLUMNS} FROM ${from} WHERE ${where.join(" AND ")} ORDER BY ${col} DESC, g.id DESC LIMIT ?`;
  return (db().prepare(sql).all(...args, Math.max(1, Math.min(o.limit ?? 60, 200))) as Row[]).map(toGeneration);
}

/** Whether the runs-by-account index exists (db.ts makes it outside the migrations, and goes on without it on a failure). */
const accountIndexed = () => !!db().prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'generations_account'").get();

export function setFavorite(id: string, favorite: boolean): void {
  update(id, { favorite: favorite ? 1 : 0 });
}

export interface AssetRef {
  table: string;
  cols: string[];
  /** A column whose row belongs to the generation being purged (its own row and Cinema membership don't keep its files). */
  except?: string;
  /** What a row is, for "where is it used" ("element", "Cinema project"). */
  what: string;
  /** SQL that names the row, and the key that tells rows apart (default `id`; a Cinema take and its project are one project). */
  name?: string;
  key?: string;
  /**
   * The column naming the account a row belongs to (an account's own board or project). Such a row keeps only that
   * account's own files: what a board names is checked when the file is read, not when the board is saved, and a
   * project's free text is never checked, so a row naming the owner's or another account's file must never keep it.
   */
  account?: string;
}

/**
 * Everywhere a stored file can still be in use, by URL (which ends in the asset id, …/<id>.png) or
 * by id: other jobs' inputs and outputs (an upload a request still names keeps Retry and Reuse
 * working), elements, Assist chats and projects, every studio's sessions, projects and presets.
 * When a table starts storing file URLs, add it here (tests/library.test.ts checks every `_json` /
 * `_url` column is either here or in ASSET_FREE).
 */
export const ASSET_REFS: AssetRef[] = [
  { table: "generations", cols: ["request_json", "outputs_json"], except: "id", what: "result" },
  { table: "characters", cols: ["reference_asset_ids_json", "loras_json", "lora_file", "voice_json"], what: "element", name: "name" },
  { table: "trainings", cols: ["meta_json"], what: "element", key: "element_id", name: "(SELECT name FROM characters WHERE id = element_id)" },
  { table: "assist_threads", cols: ["messages_json", "items_json", "pending_json"], what: "Assist chat", name: "title" },
  // A chat's frozen context names its project's sources; a project's file sources are uploads.
  { table: "assist_thread_state", cols: ["context", "sent_json"], what: "Assist chat", key: "thread_id", name: "(SELECT title FROM assist_threads WHERE id = thread_id)" },
  { table: "assist_project_sources", cols: ["url", "content"], what: "Assist project", key: "project_id", name: "(SELECT name FROM assist_projects WHERE id = project_id)" },
  { table: "cinema_projects", cols: ["cover_url", "palettes_json", "director_json", "chat_json", "brief_body"], what: "Cinema project", name: "name" },
  { table: "cinema_items", cols: ["meta_json"], except: "generation_id", what: "Cinema project", key: "project_id", name: "(SELECT name FROM cinema_projects WHERE id = project_id)" },
  { table: "canvases", cols: ["graph_json", "runs_json"], what: "canvas", name: "name" },
  // A Layers project's source, cover, its tools' inputs (a picked image) and every saved version.
  { table: "layer_projects", cols: ["source_url", "cover_url", "jobs_json"], what: "Layers project", name: "name" },
  { table: "layer_versions", cols: ["doc_json"], what: "Layers project", key: "project_id", name: "(SELECT name FROM layer_projects WHERE id = project_id)" },
  { table: "shorts_sessions", cols: ["source_json", "look_json"], what: "Shorts session", name: "title" },
  { table: "shorts_presets", cols: ["references_json"], what: "Shorts preset", name: "name" },
  { table: "brand_kits", cols: ["kit_json", "chat_json"], what: "brand kit", name: "name" },
  { table: "products", cols: ["images_json"], what: "product", name: "name" },
  { table: "ad_creatives", cols: ["meta_json"], what: "ad", name: "headline" },
  { table: "marketing_runs", cols: ["meta_json"], what: "marketing run", name: "title" },
  // Image studios: a palette's thumbnail, a moodboard's images, collages and cover, an Instadump pack's photos.
  { table: "palettes", cols: ["thumb_url"], what: "palette", name: "name" },
  { table: "moodboards", cols: ["images_json", "collages_json", "cover_url"], what: "moodboard", name: "name" },
  { table: "photodump_packs", cols: ["refs_json"], what: "photo pack", name: "name" },
  // Faceless / Explainer: a channel's avatar, style references and voice samples; an episode's sources, script and picture edits.
  { table: "faceless_channels", cols: ["avatar_url", "reference_json", "settings_json"], what: "Faceless channel", name: "name" },
  { table: "faceless_episodes", cols: ["settings_json", "sources_json", "script_json", "plan_json"], what: "episode", name: "title" },
  // Translate & dub sessions and Katana jobs: the source video, the subject picture and each step's files.
  { table: "dub_sessions", cols: ["data_json"], what: "dub", name: "json_extract(data_json, '$.title')" },
  { table: "katana_jobs", cols: ["data_json"], what: "Katana job", name: "json_extract(data_json, '$.title')" },
  // Content Factory: a series' reference clip and its thumbnail.
  { table: "content_series", cols: ["data_json"], what: "Content Factory series", name: "COALESCE(json_extract(data_json, '$.name'), json_extract(data_json, '$.reference.title'))" },
  // Assist's scheduled tasks: the files the prompt runs with, and the files a skill task's inputs name.
  { table: "assist_schedules", cols: ["attachments_json", "skill_json"], what: "scheduled task", name: "title" },
  // A skill run that waits across studios: its input values and each step's results.
  { table: "skill_runs", cols: ["values_json", "state_json"], what: "skill run", name: "skill" },
  // Character Swap Studio: the character picture, each clip and its 24 fps copy, masks, anchors, takes and their masters.
  { table: "swap_projects", cols: ["data_json"], what: "Character Swap project", name: "name" },
  // A user skill's bundled text files: its recipe.json names the files a run starts from (an example, a fixed logo).
  { table: "skills", cols: ["files_json"], what: "skill", key: "name", name: "title" },
  // An account's own boards and projects (public sign-up): a board's pages (its nodes' pictures and clips), and a
  // project's data (a Shorts session or preset, a Cinema project, a Character Swap project…) and its list line (a
  // short's final video, a swap's character picture). `key` is set so an owner's dry run never deletes these rows
  // (skill-runs.ts STUDIO_TABLES). `account` lets a row keep only its own account's files.
  { table: "account_canvases", cols: ["pages_json"], what: "account canvas", key: "id", name: "name", account: "account_id" },
  { table: "account_projects", cols: ["data_json", "summary_json"], what: "account project", key: "id", name: "name", account: "account_id" },
];

/**
 * Columns that look like they could hold a file (`_json`, `_url`) but never hold one of Fuobe's
 * stored files, with the reason. The ASSET_REFS coverage test reads this list.
 */
export const ASSET_FREE: Record<string, string> = {
  "generations.provider_input_json": "what a provider was sent: its own upload URLs or file names, never ours",
  "generations.fix_json":
    "what a failed ComfyUI run was missing (model file names, node classes and packs), and what an account's GPU or key ran into: a cause, a details line and its buttons' links",
  "gpu_snapshots.inventory_json": "what a GPU's ComfyUI has (class names, model file names and sizes), never a Fuobe file",
  "gpu_snapshots.report_json": "readiness built from that inventory",
  "generations.external_meta_json": "the provider's job handles",
  "billing_outbox.payload_json": "reports for the billing service: hold and run ids, counts and words, never a file",
  "reports_inbox.target_json": "what a report is about: a run, asset or share id, never a file",
  "admin_tokens.scopes_json": "an admin token's scope names",
  "admin_audit.detail_json": "small facts about an admin action: counts, ids and names, never a file's URL",
  "auth_install.extra_json": "sign-in settings an older auth.json held that this build doesn't know",
  "auth_migration.counts_json": "how many accounts, tokens and keys moved in from auth.json",
  "auth_migration.backup_file": "the name auth.json was kept under in the data folder, never a served file",
  "auth_tokens.extra_json": "an API token's fields this build doesn't know",
  "auth_accounts.extra_json": "an account's fields this build doesn't know",
  "auth_account_gpu.url": "the address of an account's own ComfyUI, never a Fuobe file",
  "auth_stray_files.counts_json": "how many accounts and tokens a set-aside auth.json lists",
  "auth_stray_files.account_ids_json": "ids of the accounts a set-aside auth.json lists that the database doesn't have",
  "shorts_sessions.range_json": "start and end times",
  "shorts_sessions.settings_json": "ratio, language, model and resolution",
  "shorts_sessions.segments_json": "generation ids of each take",
  "shorts_sessions.stitches_json": "generation ids of each stitch",
  "brand_kits.progress_json": "research progress labels",
  "products.selling_points_json": "words",
  "products.url": "the product's own web page",
  "marketing_runs.final_ids_json": "generation ids",
  "palettes.colors_json": "hex colours",
  "assist_projects.skills_json": "skill names",
  "assist_thread_state.skills_json": "skill names",
  "skills.meta_json": "SKILL.md front matter",
  "lora_mirrors.source_url": "where a LoRA file downloads from (civitai, Hugging Face), without the key",
  "lora_mirrors.hosted_url": "the provider's copy of a LoRA file (fal or Replicate storage), never ours",
  "shares.tags_json": "words",
  "shares.items_json": "generation ids: a share link shows what still exists and keeps no file alive",
  "lora_mirrors.licence_json": "the licence and civitai permissions a LoRA copy was made under",
  "assist_schedules.rule_json": "when a scheduled task runs",
  "assist_schedules.mode_json": "the Assist mode a scheduled run starts in",
  "assist_connectors.url": "a remote MCP server Claude connects to, never one of ours",
  "assist_connectors.tools_json": "the tool names a connector is limited to",
  "relay_runners.facts_json": "what a person's computer said about its ComfyUI: its GPU, memory, version and LoRA names",
  "relay_tasks.graph_json": "the graph a person's computer runs: file names on that computer's ComfyUI, never a Fuobe file",
  "relay_tasks.extra_json": "the run's LoRA names and where they download from, as its generation's request has them (which keeps them)",
  "relay_tasks.wanted_json": "the results asked of a person's computer: file names on its ComfyUI",
  "relay_tasks.received_json": "how much of each result has arrived",
  "relay_tasks.result_json": "the finished entry a person's ComfyUI reported: its own file names",
  "relay_tasks.refusal_json": "a ComfyUI refusal: node classes and model names",
  "relay_tasks.needs_json": "what a job for the workers needs: workflow, model file names and sizes, node packs, VRAM",
  "relay_tasks.tried_json": "the ids of the workers that lost or failed this job",
  "relay_workers.facts_json": "what a worker said about its ComfyUI: its GPU, memory and version",
  "relay_workers.inventory_json": "a worker's model files and node packs: names, sizes and hashes on that PC",
  "relay_workers.lanes_json": "the lanes a worker can run: hashes of model file names",
  "relay_workers.bench_json": "a worker's job times in each lane",
  "relay_workers.hours_json": "a worker's hours: a time zone and windows",
  "relay_workers.allow_json": "the lanes the owner lets a worker run, with their delays",
  "relay_pairings.facts_json": "what a paired ComfyUI said about itself: its name, GPU and version",
  "account_canvases.summary_json": "an account board's list line: node and page counts, and its outline (node types, places and short labels)",
};

/** The query that finds the rows of one ASSET_REFS table naming a file (@id), except the purged generation's own (@g). */
export function assetRefSql(r: AssetRef): string {
  const where = r.cols.map((c) => `instr(COALESCE(${c}, ''), @id) > 0`).join(" OR ");
  const except = r.except ? ` AND ${r.except} != @g` : "";
  // A row of the file's own account only (the owner's files have no account, so no account's row keeps them).
  const own = r.account ? ` AND ${r.account} = (SELECT account_id FROM assets WHERE id = @id)` : "";
  const trashed = r.table === "generations" ? ", EXISTS (SELECT 1 FROM generation_trash t WHERE t.generation_id = generations.id) AS trashed" : "";
  return `SELECT ${r.key ?? "id"} AS k, ${r.name ?? "NULL"} AS n${trashed} FROM ${r.table} WHERE (${where})${except}${own} LIMIT @max`;
}

/**
 * Where a stored file is still used (see ASSET_REFS), at most `max` rows: enough to say where
 * ("2 results and the element “Maya”", describeUses in src/lib/library.ts) or, with max 1, whether.
 */
export function assetUses(assetId: string, opts: { exceptGeneration?: string; max?: number } = {}): AssetUse[] {
  const max = opts.max ?? 50;
  const out: AssetUse[] = [];
  for (const r of ASSET_REFS) {
    try {
      const rows = db()
        .prepare(assetRefSql(r))
        .all({ id: assetId, g: opts.exceptGeneration ?? "", max: max - out.length }) as { k: string; n: string | null; trashed?: number }[];
      for (const row of rows) out.push({ what: r.what, key: String(row.k), name: row.n ?? null, ...(row.trashed ? { trashed: true } : {}) });
    } catch {
      // A table or column this install doesn't have yet: nothing there to keep the file for.
    }
    if (out.length >= max) break;
  }
  return out;
}

/** Whether anything still refers to this stored file (see ASSET_REFS). */
export function assetInUse(assetId: string, exceptGeneration = ""): boolean {
  return assetUses(assetId, { exceptGeneration, max: 1 }).length > 0;
}

/**
 * Delete for good (Trash → Delete forever, Empty trash, the 30-day purge): the row, its trash and
 * folder entries, and the output files nothing else still points at (assetInUse). Dependents still
 * waiting on it fail ("An earlier step didn't finish"). Use deleteForever / emptyTrash in
 * src/server/library.ts (they cancel running jobs first); moving to the Trash is trashGenerations.
 */
export function deleteGeneration(id: string): void {
  // A 3D job's finish or turntable render stops with it.
  stopModelFinish(id);
  const assets = db().prepare("SELECT id FROM assets WHERE generation_id = ?").all(id) as { id: string }[];
  db().transaction(() => {
    db().prepare("DELETE FROM generations WHERE id = ?").run(id);
    db().prepare("DELETE FROM generation_trash WHERE generation_id = ?").run(id);
    db().prepare("DELETE FROM folder_items WHERE generation_id = ?").run(id);
  })();
  for (const a of assets) if (!assetInUse(a.id, id)) deleteAsset(a.id);
}

// ---------------------------------------------------------------------------
// Routing

/**
 * Pick the provider for a run: a configured real provider, or the demo provider when placeholder results are on
 * (Settings, demoMode "on") or the request asks for one. With neither and nothing connected, the run is refused.
 * `images` is how many images the run sends: a route whose list takes fewer (FieldMap.maxImages: Grok
 * Imagine Image takes 5 on fal) gives way to one that takes them all, or says so.
 * `loras` and `seconds` (the clip length asked for) prefer a route that carries every LoRA and makes that
 * length (Replicate's Wan 2.2 fast renders only 81–121 frames, fal's 17–161).
 */
export function chooseRoute(candidates: ModelRoute[], images = 0, loras: LoraRef[] = [], seconds?: number, forceDemo = false): { route: ModelRoute; demo: boolean } {
  // Honour the preferred cloud aggregator (Settings → API configuration) when a model is on several.
  const preferred = getSetting("cloudProvider");
  const routes = preferred === "auto" ? candidates : [...candidates].sort((a, b) => Number(b.provider === preferred) - Number(a.provider === preferred));
  const demo = getSetting("demoMode");
  // A request marked demo (a skill recipe's free dry run) runs on the demo provider whatever Settings says, as does
  // anything a studio starts inside runAsDemo (a skill's dry run of a studio step, src/server/demo-scope.ts).
  if (demo === "on" || forceDemo || inDemoScope()) return { route: routes[0], demo: true };
  const takes = (r: ModelRoute) => !r.map?.maxImages || images <= r.map.maxImages;
  // A route that carries every LoRA wins (Replicate's Wan 2.2 takes one per expert, fal's takes a Mix), then one
  // that makes the length asked; otherwise the first ready one runs and the plan's notes say what it changes.
  const ok = (r: ModelRoute) => routeReady(r) && takes(r);
  const long = (r: ModelRoute) => framedLength(r.map?.numFrames, seconds) === undefined;
  const real =
    routes.find((r) => ok(r) && lorasFit(r, loras) && long(r)) ?? routes.find((r) => ok(r) && lorasFit(r, loras)) ?? routes.find((r) => ok(r) && long(r)) ?? routes.find(ok);
  if (real) return { route: real, demo: false };
  const short = routes.find(routeReady);
  if (short) {
    const others = [...new Set(routes.filter((r) => takes(r) && r.provider !== short.provider).map((r) => provider(r.provider).label))];
    throw new Error(`This model takes up to ${short.map!.maxImages} images on ${provider(short.provider).label} — remove some${others.length ? `, or connect ${others.join(" or ")} for more` : ""}`);
  }
  // "auto", which only code in this process sets (settings.ts): a placeholder where nothing connected runs the model.
  if (demo === "auto") return { route: routes[0], demo: true };
  // Nothing connected runs it, and placeholders are off (the default): never a silent placeholder.
  // An account's paid model with no key of its own for any of the model's providers: "Add your key" (fal.ai first).
  const cloud = tenantAccount() ? routes.map((r) => r.provider).find(isCloudProvider) : undefined;
  if (cloud) throw new AccountRunError(paidAllowed() ? { error: addKeyMessage(cloud), code: "add-key", provider: cloud } : { error: OPEN_ONLY_RUN, code: "open-only" });
  if (routes.every((r) => r.provider === "llm")) throw new Error(llmMissing(routes[0]));
  const names = [...new Set(routes.map((r) => provider(r.provider).label))].join(" or ");
  const message = `Connect ${names} in Settings to run this model`;
  // ComfyUI, or a fal.ai or Replicate key, could run it: the owner's own browser opens the connect card for it
  // (generations/route.ts), with the way or ways that would.
  const gpu = routes.some((r) => r.provider === "comfyui");
  const key = !tenantAccount() && routes.some((r) => isCloudProvider(r.provider));
  throw gpu || key ? new ConnectComfyError(message, gpu && key ? "any" : gpu ? "gpu" : "key") : new Error(message);
}

/** What would run a refused model: a GPU (ComfyUI), a fal.ai or Replicate key, or either. */
export type ConnectNeeds = "gpu" | "key" | "any";

/** A run nothing connected can make, and ComfyUI or a key could: connecting one is the way (same words as before). */
export class ConnectComfyError extends Error {
  constructor(
    message: string,
    readonly needs: ConnectNeeds = "gpu",
  ) {
    super(message);
  }
}

/** Text steps depend on which LLM the route may use (the open model never calls Claude). */
const routeReady = (r: ModelRoute) => (r.provider === "llm" ? llmBackends(r).length > 0 : provider(r.provider).isConfigured());

/** What a run produces: colour matching works on images and videos, and fal renders a timeline as a video, so those follow the model. */
export function outputKind(op: Generation["op"], model: { kind: MediaKind }): MediaKind {
  // A 3D scene is a mesh on the open engine and a depth map (an image) on the cloud.
  return op === "color-match" || op === "timeline" || op === "scene-3d" ? model.kind : OPERATION_OUTPUT[op];
}

// Live updates: every write to the table becomes an event (src/server/live.ts). A trashed row
// (soft delete, when the table has one) leaves the feeds like a deleted one.
// The live feed is the owner's (accounts don't get it): an account's runs are never sent on it.
setResolver((ids) =>
  ids.flatMap((id): LiveEvent[] => {
    const r = db().prepare("SELECT * FROM generations WHERE id = ?").get(id) as (Row & { deleted_at?: number | null; trashed_at?: number | null }) | undefined;
    if (r && accountOf(r)) return [];
    const g = r && (toGeneration(r) as Generation & { deletedAt?: number | null; trashedAt?: number | null });
    if (!r || !g || r.deleted_at || r.trashed_at || g.deletedAt || g.trashedAt) return [{ type: "deleted", id, json: JSON.stringify({ id }) }];
    return [{ type: "generation", id, json: JSON.stringify(g) }];
  }),
);

// ---------------------------------------------------------------------------
// Create

/**
 * A request as it runs now: one that names a model (or an operation) Fuobe retired when it stopped calling Higgsfield moves
 * to what replaced it (src/lib/catalog/replaced.ts), with Cinema Studio's Director fields in words; an app run on the model
 * its app ran on before moves to the app's model now (movedAppRequest). Every way in goes through it (the API, a retry, a
 * waiting step, a saved project's run); `note` says what changed.
 */
export function currentRequest(req: GenerationRequest): { request: GenerationRequest; note?: string } {
  const moved = migrateRequest(req, { directorWords: directorFieldWords });
  const app = movedAppRequest(moved.request, getModel, getPreset);
  const note = [moved.note, app.note].filter(Boolean).join("; ");
  return { request: app.request, ...(note && { note }) };
}

/**
 * The engine a model runs a request on: a Fuobe Original runs on the engine asked for (the composer's switch), else
 * the engine mode, else the first one connected; any other model on its own.
 */
export function engineFor(m: ModelDef, asked: Engine | undefined): Engine {
  return dualEngine(m) ? pickEngine(m, asked, engineMode(), (e) => onEngine(m, e).routes.some(routeReady)) : m.engine;
}

/**
 * Fuobe DoP's relight effects (Silhouette, Window…) on their own model: the step that relights the start frame on the
 * engine the clip runs on. None for any other request (the effect on a partner model runs on its words).
 */
export function relightStep(req: GenerationRequest, model: ModelDef): { engine: Engine; step: NonNullable<Preset["prestep"]>["open"] } | undefined {
  const preset = req.presetId ? getPreset(req.presetId) : undefined;
  if (!preset?.prestep || !req.inputs?.images?.length) return undefined;
  const engine = engineFor(model, req.engine);
  if (presetRoute(preset, engine)?.modelId !== model.id) return undefined;
  return { engine, step: preset.prestep[engine] };
}

/**
 * The engine an app runs an Original on when only one of its routes names it (the AI Influencer app: Fuobe Soul in the
 * cloud, the Soul Cast sheet graph on your GPU); undefined otherwise.
 */
export function appEngine(req: Pick<GenerationRequest, "presetId">, m: ModelDef): Engine | undefined {
  const preset = req.presetId ? getPreset(req.presetId) : undefined;
  if (preset?.type !== "app") return undefined;
  const sides = (["cloud", "open"] as const).filter((e) => presetRoute(preset, e)?.modelId === m.id);
  return sides.length === 1 ? sides[0] : undefined;
}

/**
 * The model a request may run, as Settings → Models & licences offers it (only its routes that are on). Engine mode
 * refuses an Original's engine it rules out first; then a model that is off is refused naming the switch, and so is
 * an Original's engine that is off when it is the one asked for, or the one the install's engine mode runs it on.
 * Every run and every chain (createGenerations, before any step is queued) goes through it.
 */
export function offeredFor(m: ModelDef, asked: Engine | undefined): ModelDef {
  const mode = engineMode();
  if (dualEngine(m)) pickEngine(m, asked, mode, () => true);
  return requireOffered(m, asked ?? (mode === "both" ? undefined : mode));
}

/**
 * Fuobe Mixed Media's single picture in the cloud (DoP's Mixed Media stills, an API caller's edit), and Fuobe Angles' other
 * camera, drawn at about 1 megapixel in its picture's shape, as it's priced (and as the GPU graphs scale it): without a
 * size, fal keeps the upload's own (a 12-megapixel photo costs 12 times as much). The studio sends each Mixed Media frame's
 * size itself; a picture that isn't a file in Fuobe keeps fal's.
 */
const SIZED_EDITS = new Set([MIXED_ORIGINAL, ANGLES_ORIGINAL]);
function sizedMixedFrame(plan: ReturnType<typeof planGeneration>, req: GenerationRequest): ReturnType<typeof planGeneration> {
  if (!SIZED_EDITS.has(plan.model.id) || plan.model.engine !== "cloud" || plan.op !== "edit" || plan.params.extra?.image_size) return plan;
  const first = req.inputs?.images?.[0];
  const head = first ? localHead(first) : null;
  const size = head ? imageSize(head) : null;
  const fit = size ? originalFrameSize(size, "1K") : undefined;
  return fit ? { ...plan, params: { ...plan.params, extra: { ...plan.params.extra, image_size: fit } } } : plan;
}

/**
 * A cloud edit that follows image 1's shape (ModelRoute.followsImage: fal's FLUX 3 Klein, whose GPU edit keeps reference 1's
 * shape): image 1's shape on the chosen tier's square, on the route's grid and within its limits, as its size field. Without
 * it the size would be the default aspect ratio's (a 16:9 photo back as a square). The tier, and so the price, stays the one
 * picked. A size the request gives itself wins; a picture that isn't a file in Fuobe keeps the aspect ratio's size.
 */
function sizedEdit(plan: ReturnType<typeof planGeneration>, req: GenerationRequest): ReturnType<typeof planGeneration> {
  if (plan.model.engine !== "cloud" || plan.op !== "edit") return plan;
  const field = plan.model.routes.find((r) => r.op === "edit" && r.followsImage)?.map?.size;
  if (!field?.key || plan.params.extra?.[field.key] !== undefined) return plan;
  const first = req.inputs?.images?.[0];
  const head = first ? localHead(first) : null;
  const shape = head ? imageSize(head) : null;
  if (!shape) return plan;
  const fit = sizeValue(field, `${shape.width}:${shape.height}`, plan.params.resolution ?? plan.model.defaults?.resolution);
  return { ...plan, params: { ...plan.params, extra: { ...plan.params.extra, [field.key]: fit } } };
}

/**
 * A talking avatar's picture held to the shape the hosted model takes (fal's H3 Max lip sync: 0.4 to 2.5 wide), read from the
 * file's header before the run is paid for. A picture that isn't a file in Fuobe (or isn't the run's own) goes as it is.
 */
function portraitProblem(plan: ReturnType<typeof planGeneration>, req: GenerationRequest): string | null {
  if (plan.op !== "avatar" || plan.model.engine === "open") return null;
  const first = req.inputs?.images?.[0];
  const head = first ? localHead(first) : null;
  const size = head ? imageSize(head) : null;
  return size ? portraitShapeProblem(plan.model, size.width, size.height) : null;
}

/**
 * The elements "@Name" can mention: the owner's. An account's run or a visitor's price check has none, so "@Name" stays
 * words there (an owner's element photo or LoRA never reaches someone else's run).
 */
export const mentionElements = () => (tenant() ? [] : listElements());

/**
 * A guest's or an account's candidates without the hosted routes no live call has passed yet (hosted-untested.ts): those
 * run for the owner only. With nothing else to run on, the run is refused as a tool that isn't available here.
 */
function triedRoutes(m: ModelDef, routes: ModelRoute[]): ModelRoute[] {
  if (!tenant()) return routes;
  const tried = routes.filter((r) => !hostedUntested(m.id, r));
  if (routes.length && !tried.length) throw new AccountRunError({ error: OWN_GPU_TOOL_MESSAGE, code: "own-gpu-tool" });
  return tried;
}

/** Resolve mentions and drawings, plan, enforce the engine mode and pick a provider route. */
function prepare(original: GenerationRequest) {
  // @element mentions become reference images / LoRAs; the stored request keeps the mentions for "Reuse".
  // A style signature's sentences (palette, look) join the prompt here; the stored request keeps the user's words.
  const worded = withSignatureWords(original);
  const mode = engineMode();
  // Settings → Models & licences: a model (or the engine of an Original asked for) that is switched off is refused,
  // naming the switch; an Original otherwise runs on an engine that is still on, with the routes that are on.
  const found = getModel(worded.modelId);
  const onSide = worded.engine ?? (found && appEngine(worded, found));
  const allowed = found && offeredFor(found, onSide);
  const model = allowed && dualEngine(allowed) ? onEngine(allowed, engineFor(allowed, onSide)) : allowed;
  const lookup = (id: string) => (model && id === model.id ? model : getModel(id));
  const req = model ? stripMotionPaths(applySketch(applyMentions(worded, model, mentionElements()).request, model).request, model) : worded;
  let plan = sizedEdit(sizedMixedFrame(planGeneration(req, lookup, getPreset), req), req);
  const portrait = portraitProblem(plan, req);
  if (portrait) throw new Error(portrait);
  if (mode !== "both" && plan.model.engine !== mode) {
    // An account on the open engine has no key of its own that opens (Your keys), or the studio is open-source only.
    const cloud = mode === "open" && tenantAccount() ? plan.model.routes.map((r) => r.provider).find(isCloudProvider) : undefined;
    if (cloud) throw new AccountRunError(paidAllowed() ? { error: addKeyMessage(cloud), code: "add-key", provider: cloud } : { error: OPEN_ONLY_RUN, code: "open-only" });
    throw new Error(
      mode === "open"
        ? `${plan.model.name} is a cloud model, which isn't available here. Pick an open-source model`
        : `${plan.model.name} is an open-source model, which isn't available here. Pick a cloud model`,
    );
  }
  // Checks planGeneration can't make without knowing the model's kind or the text ops' needs.
  if (plan.op === "color-match" && plan.model.kind === "video" && !req.inputs?.video) throw new Error("Add the video and a reference image");
  if (plan.op === "translate" && !plan.params.targetLanguage) throw new Error("Pick a language to translate into");
  // The length asked of a clip that is made (not one that follows its input video's length).
  const seconds = MADE_LENGTH_OPS.has(plan.op) ? plan.params.duration : undefined;
  // LoRAs switched off (by file or licence class) are left out, their trigger words with them; with "keep GPU-only
  // LoRAs on your GPU" on, the rest are marked so a cloud route leaves those out (fitLoras).
  const access = offeredLoras(plan.loras);
  // A LoRA the model's recipe can't run without (Fuobe Try-On's try-on LoRA) switched off: the model can't run.
  const needed = access.dropped.find((d) => plan.model.options.loras?.some((l) => l.file === d.file));
  if (needed) throw new Error(`${plan.model.name} runs with the LoRA “${loraName(needed)}”, which is switched off in ${ACCESS_PLACE}. Turn it back on there, or pick another model`);
  if (access.dropped.length) plan = { ...plan, loras: access.loras, prompt: withoutTriggers(plan.prompt, plan.loras.filter((l) => !access.loras.some((k) => k.file === l.file)), access.loras) };
  else if (access.loras.some((l, i) => l !== plan.loras[i])) plan = { ...plan, loras: access.loras };
  // A preset can route to another model than the one asked for: its routes that are on (or the switch that's off).
  const { route, demo } = chooseRoute(triedRoutes(plan.model, offeredRoutes(plan.model, routesFor(plan.model, plan.op, plan.params))), req.inputs?.images?.length ?? 0, plan.loras, seconds, !!worded.demo);
  // Qwen-Image 2.1's Options → Speed loads its speed's LoRA in the graph: that LoRA switched off holds the speed.
  const tier = route.provider === "comfyui" ? speedLora(route.endpoint, plan.params.extra) : undefined;
  if (tier && offeredLoras([{ file: tier.file }]).dropped.length) {
    const speed = QWEN21_SPEED.labels?.[tier.speed] ?? tier.speed;
    throw new Error(
      tenantAccount() ? `${speed} isn't available here. Pick another speed` : `${speed} runs with the LoRA “${loraName({ file: tier.file })}”, which is switched off in ${ACCESS_PLACE}. Pick another speed, or turn it back on there`,
    );
  }
  // Pika H3 Flex (MiniMax H3's Fast · Pika Flex, References and Talk from a voice clip) loads Pika's adapter in the graph:
  // that adapter switched off holds the run.
  const flexOff = route.provider === "comfyui" ? offeredLoras(pikaFlexGraphLoras(route.endpoint, plan.params.extra)).dropped[0] : undefined;
  if (flexOff) {
    const refs = route.endpoint === PIKA_FLEX_REF_WORKFLOW;
    const what = refs ? (plan.op === "avatar" ? "Talk from a voice clip" : "References") : "Fast · Pika Flex";
    const instead = refs ? "Use one start frame, or pick another model" : "Pick Standard or Sharper";
    throw new Error(
      tenantAccount() ? `${what} isn't available here. ${instead}` : `${what} runs with “${loraName(flexOff)}”, which is switched off in ${ACCESS_PLACE}. ${instead}, or turn it back on there`,
    );
  }
  // "Fast · writes the details" edits with at most 3 pictures (its LoRA's card).
  if (tier?.speed === "details" && (req.inputs?.images?.length ?? 0) > DETAILS_MAX_IMAGES) {
    throw new Error(`${QWEN21_SPEED.labels?.details ?? "Fast · writes the details"} edits with up to ${DETAILS_MAX_IMAGES} pictures. Remove one, or pick another speed`);
  }
  // Qwen-Image 2.1's Options → GPU, decided once here (src/server/qwen21-gpu.ts): the pre-flight and the run read the choice.
  const gpu = route.provider === "comfyui" && !demo ? qwen21Gpu(route.endpoint, plan.params.extra ?? {}, (id) => !!loadIndex().workflows[id]) : undefined;
  if (gpu) plan = { ...plan, params: { ...plan.params, extra: { ...plan.params.extra, [GPU_PARAM]: gpu.gpu } }, notes: [...(plan.notes ?? []), ...(gpu.note ? [gpu.note] : [])] };
  // MiniMax H3's Options → GPU tier, decided once here too (src/server/h3-gpu.ts): FastH3 V2 or Trim on a smaller card, with its file.
  const h3 = route.provider === "comfyui" && !demo ? h3Gpu(route.endpoint, plan.params.extra ?? {}, (id) => !!loadIndex().workflows[id]) : undefined;
  if (h3) {
    // The file is the plan's alone (never one a request names).
    const extra: Record<string, unknown> = { ...plan.params.extra, [H3_TIER_PARAM]: h3.gpuTier };
    if (h3.unet) extra[H3_UNET_PARAM] = h3.unet;
    else delete extra[H3_UNET_PARAM];
    plan = { ...plan, params: { ...plan.params, extra }, notes: [...(plan.notes ?? []), ...(h3.note ? [h3.note] : [])] };
  }
  // What the cloud run can carry: a LoRA whose licence doesn't allow hosting stays on the GPU, and an API
  // takes at most so many (the plan's notes say which were left out). Open runs carry them all. Without a
  // civitai key a look's civitai LoRA the run can't get is left out (and said), rather than failing at the
  // download: the look's words still carry it. Looks are Fuobe Soul's and Fuobe Mixed Media's (the studio's frames,
  // Smooth's first frame, DoP's Mixed Media stills). Any other run (a motion, whose LoRA is the point) still stops there.
  const asked = plan.loras;
  const look = !!plan.soul || plan.model.id === MIXED_ORIGINAL;
  const reachable =
    demo || !look ? { loras: asked, notes: [] } : withoutUnreachableCivitai(asked, route.provider === "comfyui" ? "comfyui" : route.provider === "replicate" ? "replicate" : "fal");
  const fitted = fitLoras(reachable.loras, route);
  // A LoRA the recipe can't run without that this route leaves out for any reason (its cap, a GPU-only licence, no
  // cloud path): the model can't run here, rather than running without it.
  const lost = demo ? undefined : plan.model.options.loras?.find((l) => asked.some((a) => a.file === l.file) && !fitted.loras.some((k) => k.file === l.file));
  if (lost) {
    const why = [...reachable.notes, ...fitted.notes].join("; ");
    throw new Error(`${plan.model.name} runs with the LoRA “${loraName(lost)}”, which this run leaves out${why ? ` (${why})` : ""}. Pick another model or engine`);
  }
  // A look's triggers lead the prompt: a LoRA left out takes its trigger with it.
  const prompt = plan.soul
    ? promptWithLoras(plan.prompt, plan.soul.triggers, fitted.loras)
    : look
      ? withoutTriggers(plan.prompt, asked.filter((l) => !reachable.loras.includes(l)), reachable.loras)
      : plan.prompt;
  plan = { ...plan, prompt, loras: fitted.loras };
  const notes = [...(plan.notes ?? []), ...access.notes, ...reachable.notes, ...fitted.notes];
  // A frame-count API that can't make the length asked (Replicate's Wan 2.2 fast: 81–121 frames) says what it makes.
  const made = demo ? undefined : framedLength(route.map?.numFrames, seconds, plan.params.fps);
  if (made !== undefined && route.map?.numFrames) {
    const f = route.map.numFrames;
    const fps = plan.params.fps && plan.params.fps > 0 ? plan.params.fps : f.fps;
    const half = (x: number) => Math.round(x * 2) / 2;
    const span = f.min !== undefined && f.max !== undefined ? ` makes ${half(f.min / fps)}–${half(f.max / fps)} s clips,` : "";
    notes.push(`${plan.model.name} on ${provider(route.provider).label}${span} so this one is about ${half(made)} s, not ${seconds} s`);
  }
  // A talking avatar is as long as its voice, up to what a frame-count route makes a call (fal's InfiniteTalk about 29 s, Wan
  // 2.2 S2V 7.5 s): a longer voice is cut there, and said.
  const voice = !demo && plan.op === "avatar" && route.map?.numFrames ? plan.params.sourceDuration : undefined;
  if (voice && voice > 0) {
    const reach = avatarSeconds({ routes: [route] }, voice, plan.params.fps);
    const half = (x: number) => Math.round(x * 2) / 2;
    if (reach < voice - 0.25) notes.push(`${plan.model.name} on ${provider(route.provider).label} makes up to ${half(reach)} s a call, so this one stops ${half(reach)} s into the ${half(voice)} s voice`);
  }
  // A route that can't batch (Replicate's Nano Banana Pro beside fal's num_images; a ComfyUI graph, which makes
  // one picture a run: Fuobe Soul on the open engine) runs one job per output.
  if (!demo && !route.map?.numOutputs && plan.perJobOutputs > 1) {
    plan = { ...plan, jobs: plan.jobs * plan.perJobOutputs, perJobOutputs: 1, params: { ...plan.params, numOutputs: 1 } };
  }
  const providerId: ProviderId = demo ? "mock" : route.provider;
  // A text step that runs on a local model is free; only Claude costs money.
  const free = demo || (route.provider === "llm" && !llmUsesClaude(route));
  const withLoras = fitted.loras.length > 0 && !!route.loraEndpoint;
  const unreachable = asked.filter((l) => !reachable.loras.includes(l));
  // Priced for the clip the route makes: Replicate's Wan 2.2 fast makes 5 s when 3 s was asked.
  const priced = made !== undefined && plan.params.duration !== undefined ? { ...plan.params, duration: Math.round(made * 2) / 2 } : plan.params;
  return { req, plan, route, demo, providerId, notes, asked, unreachable, switchedOff: access.dropped, gpu: gpu?.gpu, h3: h3 && { gpuTier: h3.gpuTier, ...(h3.unet && { unet: h3.unet }) }, cost: free ? 0 : estimateCost(plan.model, priced, 1, plan.op, withLoras) };
}

/** The LoRA files a graph loads itself (not injected), so a run downloads the ones ComfyUI lacks before it starts. */
const graphLoras = (endpoint: string, extra: Record<string, unknown> | undefined) => [
  ...h3GraphLoras(endpoint, extra),
  ...restoreGraphLoras(endpoint, extra),
  ...regenerateGraphLoras(endpoint, extra),
  ...pikaFlexGraphLoras(endpoint, extra),
];

/** Operations whose clip length is the duration picked (made, or added by extend), not an input video's. */
const MADE_LENGTH_OPS = new Set<Operation>(["t2v", "i2v", "flf2v", "ref2v", "extend", "keyframes"]);


/** What a request would run as — model, operation, job count and cost — without starting it. */
export function previewGeneration(asked: GenerationRequest) {
  const moved = currentRequest(asked);
  // Open-H3 Regenerate while it is held (REGEN_OFFERED), and MiniMax H3's 2K on your GPU that finishes with it: priced as refused.
  const held = regenHeld(moved.request);
  if (held) throw new Error(held);
  const prepared = prepare(moved.request);
  const { plan, route, demo, providerId, cost, asked: askedLoras, unreachable, switchedOff, gpu, h3 } = prepared;
  const notes = moved.note ? [moved.note, ...prepared.notes] : prepared.notes;
  const fitted = routeLoras(route, askedLoras.filter((l) => !unreachable.includes(l)));
  const loras = {
    ...fitted,
    dropped: [...switchedOff, ...unreachable.map((l) => ({ file: l.file, reason: "it downloads from civitai, which needs your civitai key (Settings → LoRAs)" })), ...fitted.dropped],
  };
  // PixeletedFace pixelates each picture's faces afterwards (createMosaicRun): fal's SAM 3.1 per picture in the cloud.
  let post = demo || moved.request.postMade ? 0 : postStepCost(plan.model.id, moved.request.presetId, plan.model.engine, plan.jobs * plan.perJobOutputs, getModel);
  // MiniMax H3 at 2K on your GPU: each take's Open-H3 Regenerate finish is planned and priced beside its draft.
  const twoK = h3TwoKExtra(moved.request, plan.model, plan.op);
  if (twoK) {
    if (twoK.costUsd !== null) post += twoK.costUsd;
    notes.push(...twoK.notes);
  }
  // A finish whose price isn't known leaves the run's price unknown too, never the main step's alone.
  const priceUnknown = cost === null || twoK?.costUsd === null;
  return {
    model: plan.model,
    op: plan.op,
    jobs: plan.jobs,
    outputs: plan.jobs * plan.perJobOutputs,
    demo,
    providerId,
    costUsd: priceUnknown || cost === null ? null : post ? Math.round((cost * plan.jobs + post) * 1000) / 1000 : cost * plan.jobs,
    // The other steps the run makes beside its own model (a 2K take's finish), so a policy and a price see them all.
    ...(twoK?.steps.length && { steps: twoK.steps }),
    // The engine it runs on (a Fuobe Original picks one per request).
    engine: plan.model.engine,
    // What the route runs (the evaluation harness records it): the provider endpoint, the final prompt and the LoRAs it loads.
    route: { provider: route.provider, endpoint: loras.applied.length && route.provider !== "comfyui" && route.loraEndpoint ? route.loraEndpoint : route.endpoint },
    prompt: plan.prompt,
    loras,
    ...(notes.length && { notes }),
    // Qwen-Image 2.1's Options → GPU as decided for this run: the GPU pre-flight checks the graph it picks.
    ...(gpu && { gpu }),
    // MiniMax H3's GPU tier and the card's file as decided for this run: the GPU pre-flight checks the graph and file it picks.
    ...(h3 && { h3 }),
    plan: { end: plan.end },
  };
}

/**
 * The finishes MiniMax H3's 2K tier adds on your GPU (createH3TwoKRun): one Open-H3 Regenerate pass per take, checked
 * (the refiner LoRA's switch, the finish's own plan) and priced as the run makes them.
 */
function h3TwoKExtra(req: GenerationRequest, model: ModelDef, op: Operation): { costUsd: number | null; notes: string[]; steps: { model: string; op: string }[] } | null {
  if (!wantsH3TwoK(model.id, req.params?.resolution)) return null;
  const off = regenSwitchedOff();
  if (off) throw new Error(off);
  const takes = Math.max(1, Math.min(4, Math.round(req.params?.numOutputs ?? 1)));
  const { finish } = h3TwoKRequests(req, op, { keepLatent: keepsH3Latent() });
  const p = previewChained(finish, 1);
  return {
    costUsd: p.costUsd === null ? null : Math.round(p.costUsd * takes * 10000) / 10000,
    notes: [H3_2K_STEPS_NOTE],
    steps: Array.from({ length: takes }, () => ({ model: p.model.id, op: p.op })),
  };
}

/** Preview a step that will wait for `deps` earlier steps: validated with placeholders in its chain slots, as createGenerations does. */
export function previewChained(req: GenerationRequest, deps: number) {
  if (!deps) return previewGeneration(req);
  // A waiting step always runs as one job (createGenerations doesn't batch dependents).
  const p = previewGeneration(withChainInputs(req, slotsFor(req, deps).map(placeholderFor)));
  // Refused before anything starts, as createGenerations refuses it.
  // A keyframe film waits for frames earlier steps make (framesWait): its clips are created then, each waiting for its own.
  if (routesFor(p.model, p.op).some((r) => r.chained) && !(p.op === "keyframes" && framesWait(req))) throw new Error(chainedWaitMessage(p.model.name, p.op));
  const jobs = Math.max(1, p.jobs);
  return { ...p, jobs: 1, outputs: p.outputs / jobs, costUsd: p.costUsd === null ? null : p.costUsd / jobs };
}

export interface CreateOptions {
  /** Group several requests (storyboard frames, the shots of a film) into one batch. */
  batchId?: string;
  /**
   * Wait for these generations, then feed their first outputs in as inputs: where each goes is
   * `request.chain` (one slot per id), or `request.chainFrom` for a single image dependency.
   */
  dependsOn?: string | string[];
}

const depIds = (v: string | null): string[] => (!v ? [] : v.startsWith("[") ? (JSON.parse(v) as string[]) : [v]);

/**
 * Public sign-up: inside an account's run (accountRun) every request it makes, and every step its chains queue, is
 * stamped as the account's own: on the open engine, or the engine it asked for while it may use paid models on its own
 * keys (account-keys.ts accountEngineMode). A request stamped for another account, a step that waits for someone
 * else's run, a run on an account's GPU outside its account, and a guest's run are refused.
 */
function stampTenant(asked: GenerationRequest, opts: CreateOptions): GenerationRequest {
  if (tenant()?.kind === "guest") throw new Error(GUEST_RUN_MESSAGE);
  const who = tenantAccount();
  if (!who) {
    if (ownGpu()) throw new Error("We can't find that run.");
    // The owner's runs carry no place, hold or check of an account's run (run-stamp.ts).
    return withRunStamp({}, () => stamped(asked));
  }
  if (asked.account && asked.account !== who) throw new Error("We can't find that run.");
  const deps = opts.dependsOn === undefined ? [] : Array.isArray(opts.dependsOn) ? opts.dependsOn : [opts.dependsOn];
  if (deps.some((d) => generationAccount(d) !== who)) throw new Error("We can't find that run.");
  // Where the run goes and its billing hold are the route's decision for this run (run-stamp.ts), never a stored request's.
  return { ...stamped(asked), account: who, engine: accountEngineMode(who) === "open" ? "open" : asked.engine };
}

export function createGenerations(sent: GenerationRequest, opts: CreateOptions = {}): Generation[] {
  // Inside a skill's dry run of a studio step every row is a demo row, as the check's own rows are.
  const given: GenerationRequest = inDemoScope() && !sent.demo ? { ...sent, demo: true } : sent;
  const asked = stampTenant(given, opts);
  // A retired model or operation (a retry, an old script, a saved project) runs on what replaced it, and says so.
  const moved = currentRequest(asked);
  const original = withFinishOf(moved.request, opts.dependsOn);
  // Open-H3 Regenerate is held until it has run on a card that fits it (REGEN_OFFERED): a run of it, or of MiniMax H3's 2K on
  // your GPU that finishes with it, is refused here before any step is made, whichever way it was asked for.
  const held = regenHeld(original);
  if (held) throw new Error(held);
  // Open models make multi-shot films shot by shot, then join the clips. A Fuobe Original is taken on the engine it runs
  // on (Fuobe DoP's Frames mode is a GPU chain).
  // A model (or an Original's engine asked for) switched off in Settings → Models & licences is refused here, before a
  // chain queues any step; an Original otherwise runs on an engine still on.
  const catalogModel = getModel(original.modelId);
  const found = catalogModel && offeredFor(catalogModel, original.engine);
  const shotModel = found && dualEngine(found) ? onEngine(found, engineFor(found, original.engine)) : found;
  // An account's 3D model is finished on this server under its own limits (model3d-finish.ts); on this install's GPUs it isn't offered yet.
  // Any Angle's 3D view is the exception: a splat and its turntable, nothing to finish here.
  if (original.account && original.place === "pool" && shotModel?.kind === "model3d" && shotModel.id !== ANY_ANGLE.buildModel) throw new Error(OWN_GPU_TOOL_MESSAGE);
  if (!opts.dependsOn && shotModel?.options.multiShot?.mode === "concat" && (original.params?.shots?.filter((x) => x.prompt.trim()).length ?? 0) > 1) {
    return createShotFilm(original, shotModel);
  }
  if (!opts.dependsOn && original.op === "extend" && shotModel && routesFor(shotModel, "extend").some((r) => r.endpoint === LAST_FRAME_CHAIN)) {
    return createExtendChain(original, shotModel);
  }
  // Frames mode on an open model: one start/end-frame clip per pair of frames, then joined.
  const filmRoute = shotModel && keyframeChain(shotModel);
  // Its frames can come from earlier steps (framesWait): each clip then waits for the frames it starts and ends on.
  if (filmRoute && inferOperation(shotModel, original) === "keyframes" && (!opts.dependsOn || framesWait(original))) {
    return createKeyframeFilm(original, shotModel, filmRoute, { batchId: opts.batchId, dependsOn: opts.dependsOn });
  }
  // Image to 3D's "Refine detail" (open engine): the model, then Hi3D's refine of its mesh with the same photo.
  // Its photo may come from an earlier step (a Canvas image node, an Assist plan's still): the refine then waits for it too.
  if (shotModel && shotModel.kind === "model3d" && original.op !== "refine-3d" && chainedRefine(original) !== null) {
    return createRefinedModel(original, shotModel, { batchId: opts.batchId, dependsOn: opts.dependsOn });
  }
  // Text to 3D on the open engine: a still first, then the 3D model of it. The operation is read as the planner
  // reads it (Assist, MCP and API clients usually leave op out).
  const stillTo3d = !opts.dependsOn && shotModel && inferOperation(shotModel, original) === "text-to-3d" ? routesFor(shotModel, "text-to-3d").find((r) => r.chained) : undefined;
  if (shotModel && stillTo3d) return createStillTo3d(original, shotModel, stillTo3d);
  // Fuobe DoP's relight effects: the start frame is relit first, then animated.
  const relight = !opts.dependsOn && shotModel ? relightStep(original, shotModel) : undefined;
  if (relight) return createRelitClip(original, relight);
  // "Clean the voice first": the speech apart from the music and effects before a transcriber or a lip sync hears it.
  if (!opts.dependsOn && shotModel && wantsVoiceFirst(original)) return createVoiceFirst(original, shotModel.engine, { batchId: opts.batchId });
  // Fuobe Soul's PixeletedFace look: the picture, then its faces pixelated (SAM 3.1 + a mosaic), also as a pipeline step or a
  // Canvas node (it waits for what they wait for). The picture made inside that run (postMade) runs as it is.
  if (!original.postMade && shotModel && soulPostStep(shotModel.id, original.presetId) === "face-mosaic") {
    const waitsFor = opts.dependsOn === undefined ? undefined : Array.isArray(opts.dependsOn) ? opts.dependsOn : [opts.dependsOn];
    return createMosaicRun(original, shotModel, { batchId: opts.batchId, dependsOn: waitsFor });
  }
  // Open-H3 Regenerate: the draft preset from the clip's maker, and a clip over 15 s in 15 s parts joined (regenerate.ts).
  if (shotModel?.id === REGEN_MODEL) {
    const run = createRegenerateRun(original, shotModel, opts, createGenerations, joinClips, (id) => void cancelGeneration(id));
    if (run) return run;
  }
  // MiniMax H3 at 2K on your GPU (n7-10): a 768p draft, then Open-H3 Regenerate at 2K from it (from its latent for text to video).
  if (shotModel && wantsH3TwoK(shotModel.id, original.params?.resolution)) {
    return createH3TwoKRun(original, inferOperation(shotModel, original), opts, createGenerations, (id) => void cancelGeneration(id));
  }
  const deps = opts.dependsOn === undefined ? [] : Array.isArray(opts.dependsOn) ? opts.dependsOn : [opts.dependsOn];
  const waits = deps.length > 0;
  // A dependent job can't be planned until its inputs exist; it's validated with placeholders, then launched by the runner.
  const p = waits ? prepare(withChainInputs(original, slotsFor(original, deps.length).map(placeholderFor))) : prepare(original);
  const { req, plan, route, demo, providerId, cost } = p;
  // A preset whose recipe edited the start frame into an end frame first: two steps (the edit, then the clip).
  if (!opts.dependsOn && plan.end) return createEndFrameClip(original, plan.end);
  const notes = moved.note ? [moved.note, ...p.notes] : p.notes;
  // A chained route is built from its inputs when it's created; it can't wait for another step's output.
  if (waits && route.chained) throw new Error(chainedWaitMessage(plan.model.name, plan.op));
  const jobs = waits ? 1 : plan.jobs;
  const batchId = opts.batchId ?? (jobs > 1 ? nanoid(10) : null);
  const now = Date.now();
  const created: Generation[] = [];
  for (let i = 0; i < jobs; i++) {
    const id = nanoid(12);
    const row: Row = {
      id,
      batch_id: batchId,
      feature: req.feature,
      preset_id: req.presetId ?? null,
      model_id: plan.model.id,
      engine: plan.model.engine,
      provider: providerId,
      op: plan.op,
      kind: outputKind(plan.op, plan.model),
      status: "queued",
      progress: null,
      message: waits ? (original.frame ? "Waits for the previous frame" : "Waits for the earlier steps") : demo ? "Demo mode — no provider connected" : "Submitting",
      // A step whose prompt comes from an earlier step shows its own words (not the placeholder) until then.
      prompt: waits && req.chain?.some((s) => s.slot === "prompt") ? original.prompt?.replaceAll("{text}", "…").trim() || null : plan.prompt,
      // An Original remembers the engine it ran on, so a retry or a chained step runs there too.
      request_json: JSON.stringify(dualEngine(plan.model) ? { ...original, engine: plan.model.engine } : original),
      provider_input_json: null,
      external_id: null,
      external_meta_json: null,
      outputs_json: "[]",
      error: null,
      cost_usd: cost,
      favorite: 0,
      created_at: now + i,
      updated_at: now + i,
      completed_at: null,
      depends_on: !waits ? null : deps.length === 1 ? deps[0] : JSON.stringify(deps),
    };
    db()
      .prepare(
        `INSERT INTO generations (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row)
          .map((k) => `@${k}`)
          .join(", ")})`,
      )
      .run(row);
    // What the run leaves out or changes (LoRAs a cloud run can't carry, a length the API rounds) goes back
    // with it, so the composer and API clients can say so; it isn't stored.
    created.push(notes.length ? { ...toGeneration(row), notes } : toGeneration(row));
    if (!waits) void submit(id, route, providerId, plan, req, i);
  }
  ensureRunner();
  return created;
}

/** Where each dependency's output goes: `chain`, or the single-image `chainFrom`. */
function slotsFor(req: GenerationRequest, n: number): ChainSlot[] {
  // Dependencies beyond the listed slots are images (a chain shorter than dependsOn used to crash the launch).
  return Array.from({ length: n }, (_, i) => req.chain?.[i] ?? { slot: "images" as const, position: req.chainFrom ?? "last" });
}

const SLOT_KIND: Record<ChainSlot["slot"], MediaKind> = {
  images: "image",
  endImage: "image",
  video: "video",
  videos: "video",
  audio: "audio",
  voiceAudio: "audio",
  audio2: "audio",
  audios: "audio",
  model3d: "model3d",
  mask: "video",
  prompt: "text",
};

/** Names providers give the same stem (ComfyUI: voice/background, DBS also music/effects; Demucs: vocals…; SAM Audio: target/residual). */
const STEM_ALIASES: Record<string, string[]> = {
  voice: ["voice", "vocals", "speech", "target"],
  background: ["background", "accompaniment", "instrumental", "residual", "no_vocals"],
  music: ["music"],
  effects: ["effects", "sfx"],
};

/**
 * Soundtrack slots a video can fill: a step that made only a clip hands over the clip itself, and the
 * mux reads its sound (ComfyUI's LoadAudio and fal's FFmpeg take a video file as the audio input).
 * Shorts and Mixed Media put the trimmed source's own sound back under the restyled picture this way.
 */
const SOUNDTRACK_SLOTS = new Set<ChainSlot["slot"]>(["audio", "audio2"]);

/** The dependency output a slot takes: the first of the slot's kind, or the one with the slot's `stem`. */
export function pickOutput(outputs: OutputFile[], s: ChainSlot): OutputFile | undefined {
  // A mask: the output made as one (meta.role "mask": a painted window's last tracked frame), else a mask video, else a still.
  if (s.slot === "mask") return outputs.find((o) => o.meta?.role === "mask") ?? outputs.find((o) => o.kind === "video") ?? outputs.find((o) => o.kind === "image");
  // A path render (ChainSlot.render "path") is drawn from the depth picture the scene step made (MoGe 2: a GLB and a depth PNG).
  if (s.render === "path") return outputs.find((o) => o.kind === "image");
  const ofKind = outputs.filter((o) => o.kind === SLOT_KIND[s.slot]);
  if (s.index !== undefined) {
    if (!ofKind.length) return undefined;
    const at = (o: OutputFile, i: number) => (typeof o.meta?.index === "number" ? o.meta.index : i);
    const ordered = ofKind.map((o, i) => ({ o, i: at(o, i) })).sort((a, b) => a.i - b.i);
    return (ordered.find((x) => x.i === s.index) ?? ordered[Math.min(s.index, ordered.length - 1)]).o;
  }
  if (!s.stem) return ofKind[0] ?? (SOUNDTRACK_SLOTS.has(s.slot) ? outputs.find((o) => o.kind === "video") : undefined);
  const want = STEM_ALIASES[s.stem.toLowerCase()] ?? [s.stem.toLowerCase()];
  return ofKind.find((o) => typeof o.meta?.stem === "string" && want.includes(o.meta.stem.toLowerCase()));
}

const slotNoun = (s: ChainSlot) => (s.stem ? `${s.stem} stem` : s.slot === "mask" ? "mask" : SLOT_KIND[s.slot]);

/**
 * A planned list (ChainSlot `index` + `of`) that came back too short to read: a frame or two missing at
 * the end is held (pickOutput takes the last one), more fails the step before it is paid for.
 */
export function listShortfall(outputs: OutputFile[], s: ChainSlot): string | null {
  if (s.index === undefined || s.of === undefined) return null;
  const made = outputs.filter((o) => o.kind === SLOT_KIND[s.slot]).length;
  if (made >= s.of - CHAIN_LIST_SLACK) return null;
  const noun = slotNoun(s);
  return `made ${made} ${noun}${made === 1 ? "" : "s"} where ${s.of} were planned`;
}

function placeholderFor(s: ChainSlot): string {
  const kind = SLOT_KIND[s.slot];
  if (kind === "text") return "Placeholder text from an earlier step";
  if (kind === "model3d") return "/api/files/placeholder.glb";
  return kind === "image" ? "/api/files/placeholder.png" : kind === "video" ? "/api/files/placeholder.mp4" : "/api/files/placeholder.wav";
}

/**
 * What a chained step takes from a dependency's output: the file URL, or the text for "prompt".
 * A translation of timed text gets the cue list (so the timing survives); text saved only as a
 * file, or cut short inline (meta.truncated), is read back from it.
 */
export async function chainValue(o: OutputFile | undefined, s: ChainSlot, op?: Generation["op"]): Promise<string | undefined> {
  if (!o) return undefined;
  // The picture as it was made, before a Soul finish replaced it (a look board's next frame: its own grade comes after).
  if (s.raw && typeof o.meta?.original === "string" && o.meta.original) return o.meta.original;
  if (s.slot !== "prompt") return o.url;
  const cues = Array.isArray(o.meta?.cues) && o.meta.cues.length ? (o.meta.cues as Cue[]) : null;
  if (op === "translate" && cues) return JSON.stringify(cues);
  if (typeof o.text === "string" && !o.meta?.truncated) return o.text;
  // Timed text is saved as subtitles: its words come from the cues, not the .srt file.
  if (cues) return cueText(cues);
  if (!o.url) return undefined;
  return readRef(o.url)
    .then((f) => f.data.toString("utf8"))
    .catch(() => undefined);
}

/** A list slot with its own place in the list (ChainSlot.at). */
const placed = (s: ChainSlot) => s.at !== undefined && s.at >= 0;

/**
 * Put the dependencies' outputs into the request's inputs, slot by slot (lists keep dependency order).
 * A "prompt" slot gets the dependency's text: it fills "{text}" in the prompt, or becomes the prompt.
 */
export function withChainInputs(req: GenerationRequest, urls: string[]): GenerationRequest {
  const inputs = { ...req.inputs };
  let prompt = req.prompt;
  const slots = slotsFor(req, urls.length);
  for (const k of ["images", "videos", "audios"] as const) {
    const at = (pos: "first" | "last") => slots.flatMap((s, i) => (s.slot === k && !placed(s) && (s.position ?? "last") === pos ? [urls[i]] : []));
    const first = at("first");
    const last = at("last");
    // Slots with a place go in last, in order of it, so each lands where it says (a film's frames made by earlier steps).
    const inserts = slots.flatMap((s, i) => (s.slot === k && placed(s) ? [{ at: s.at!, url: urls[i] }] : [])).sort((a, b) => a.at - b.at);
    if (first.length || last.length || inserts.length) {
      const list = [...first, ...(inputs[k] ?? []), ...last];
      for (const x of inserts) list.splice(Math.min(x.at, list.length), 0, x.url);
      inputs[k] = list;
    }
  }
  slots.forEach((s, i) => {
    if (s.slot === "prompt") prompt = prompt?.includes("{text}") ? prompt.replaceAll("{text}", urls[i]) : urls[i];
    else if (s.slot !== "images" && s.slot !== "videos" && s.slot !== "audios") inputs[s.slot] = urls[i];
  });
  return { ...req, prompt, inputs };
}

/**
 * A stored step as it was before the runner filled its chain slots (`chainFilled`): the chained list
 * items come out from the front ("first") and the back ("last"), single slots are emptied, and the
 * step's own items stay. A retry rebuilds the step from new dependencies this way. Text that filled a
 * "prompt" slot can't be told from the prompt, so it stays.
 */
export function unfilledRequest(req: GenerationRequest, deps: number): GenerationRequest {
  const { chainFilled, chainSkipped, ...rest } = req;
  // A fallback's notice belongs to the run that fell back, not to a retry.
  delete rest.notice;
  if (!chainFilled) return chainSkipped ? { ...rest, ...(chainSkipped.prompt !== undefined ? { prompt: chainSkipped.prompt } : {}) } : rest;
  // Optional slots left out filled nothing; the fallback's prompt goes back to the one planned.
  if (chainSkipped?.prompt !== undefined) rest.prompt = chainSkipped.prompt;
  const slots = filledSlots({ ...rest, chainSkipped }, deps);
  const inputs = { ...rest.inputs };
  for (const k of ["images", "videos", "audios"] as const) {
    const count = (pos: "first" | "last") => slots.filter((s) => s.slot === k && !placed(s) && (s.position ?? "last") === pos).length;
    const list = [...(inputs[k] ?? [])];
    // Placed items come out first, the last placed first, as they went in.
    for (const at of slots.filter((s) => s.slot === k && placed(s)).map((s) => s.at!).sort((a, b) => b - a)) if (at < list.length) list.splice(at, 1);
    const own = list.slice(count("first"), list.length - count("last"));
    if (own.length) inputs[k] = own;
    else delete inputs[k];
  }
  for (const s of slots) if (s.slot !== "images" && s.slot !== "videos" && s.slot !== "audios" && s.slot !== "prompt") delete inputs[s.slot];
  return { ...rest, inputs: Object.keys(inputs).length ? inputs : undefined };
}

/** Generations this process is handing to a provider right now (shared across hot reloads and bundles). */
declare global {
  var __fuobeSubmitting: Set<string> | undefined;
}
const submitting = (): Set<string> => (globalThis.__fuobeSubmitting ??= new Set<string>());

/**
 * Wait (at most `ms`) until none of these runs is still being handed to its provider. A run cancelled during its
 * hand-over is stopped there as soon as its submit lands (submitNow), with the key it was sent with: removing or
 * replacing that key, or deleting the account, waits for this first. False when one is still going at the end.
 */
export async function handOversDone(ids: readonly string[], ms = 60_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (ids.some((id) => submitting().has(id))) {
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

/**
 * A chain runs all for real or all as a demo (a demo join of paid clips, or a paid step fed a demo
 * placeholder, helps nobody). Returns the error for a step that can't match its dependencies, and
 * whether it should run as a demo because they did.
 */
function chainMode(p: { demo: boolean; plan: { model: { name: string } }; route: ModelRoute }, deps: Pick<Row, "provider">[], asked?: Pick<GenerationRequest, "demo">): { error?: string; forceDemo?: boolean } {
  const demoDeps = deps.filter((d) => d.provider === "mock").length;
  if (p.demo && demoDeps < deps.length) {
    const needs = p.route.provider === "llm" ? llmLabel(p.route) : provider(p.route.provider).label;
    return { error: `${p.plan.model.name} needs ${needs} to continue what the earlier steps made for real — connect it in Settings, then retry` };
  }
  if (!p.demo && demoDeps > 0) {
    // A dry run (GenerationRequest.demo) stays a demo even with Settings → Demo mode off.
    if (getSetting("demoMode") === "off" && !asked?.demo) return { error: "An earlier step made a placeholder. Retry it once a model is connected." };
    return { forceDemo: true };
  }
  return {};
}

/** A waiting row's dependency ids as a json_each source (depends_on is one id, or a JSON list). */
const DEP_IDS = "json_each(CASE WHEN substr(g.depends_on, 1, 1) = '[' AND json_valid(g.depends_on) THEN g.depends_on ELSE json_array(g.depends_on) END) d";

/**
 * Waiting steps that can move: none of their dependencies is still queued or running (so they launch), or one
 * failed, was canceled or is gone (so they fail now, not after the others finish). A per-frame render keeps
 * hundreds of steps waiting for its lanes, and a plain "oldest 50 waiting" would hold every chain started after
 * it until its backlog drained. The steps this process is handing to a provider right now are still "queued":
 * the limit makes room for them.
 */
const READY_DEPENDENTS = `SELECT g.* FROM generations g
  WHERE g.status = 'queued' AND g.external_id IS NULL AND g.depends_on IS NOT NULL
    AND (
      NOT EXISTS (SELECT 1 FROM ${DEP_IDS} JOIN generations dep ON dep.id = d.value WHERE dep.status IN ('queued', 'running'))
      OR EXISTS (SELECT 1 FROM ${DEP_IDS} LEFT JOIN generations dep ON dep.id = d.value WHERE dep.id IS NULL OR dep.status IN ('failed', 'canceled'))
    )
  ORDER BY g.created_at ASC LIMIT ?`;

/** The error a waiting step gets when an input failed (framesProgress tells these from a step's own failure). */
export const waitedOnFailure = (frame?: boolean) => `${frame ? "The previous frame" : "An earlier step"} didn't finish`;
/** What a step dropped by dropUnused says (canceled, not by anyone: the steps it was for failed). */
export const DROPPED_UNUSED = "Stopped before it ran: the steps it was for failed";

/** Ids in a depends_on column that name `id` (one id, or a JSON list). */
const DEPENDENTS_OF = "(depends_on = @id OR (substr(depends_on, 1, 1) = '[' AND instr(depends_on, @quoted) > 0))";

/**
 * A waiting step marked dropWhenUnused whose every dependent has failed or been canceled can no longer be
 * used: cancel it (nothing was spent on it) and look again at the steps it waited for. `ids` are the inputs
 * of a step that just failed. A step being handed to its provider right now is left alone.
 */
function dropUnused(ids: string[]): void {
  const todo = [...ids];
  // Settled: dropped, or not a waiting dropWhenUnused step. One still used is looked at again when a step using it is dropped.
  const settled = new Set<string>();
  const live = db().prepare(`SELECT 1 FROM generations WHERE status IN ('queued', 'running') AND ${DEPENDENTS_OF} LIMIT 1`);
  while (todo.length) {
    const id = todo.pop()!;
    if (settled.has(id) || submitting().has(id)) continue;
    const r = db().prepare("SELECT status, external_id, depends_on, request_json FROM generations WHERE id = ?").get(id) as Pick<Row, "status" | "external_id" | "depends_on" | "request_json"> | undefined;
    if (!r || r.status !== "queued" || r.external_id || !r.depends_on || !(JSON.parse(r.request_json) as GenerationRequest).dropWhenUnused) {
      settled.add(id);
      continue;
    }
    if (live.get({ id, quoted: JSON.stringify(id) })) continue;
    settled.add(id);
    const now = Date.now();
    db()
      .prepare("UPDATE generations SET status = 'canceled', error = ?, message = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'queued' AND external_id IS NULL")
      .run(DROPPED_UNUSED, now, now, id);
    todo.push(...depIds(r.depends_on));
  }
}

/**
 * A step with optional inputs whose steps failed (ChainSlot.optional): its chain without those slots, the fallback's
 * prompt and notice, and what was left out (so a retry can put the request back as it was: unfilledRequest).
 */
export function withoutSkipped(req: GenerationRequest, slots: ChainSlot[], skipped: number[]): GenerationRequest {
  const left = skipped.map((i) => slots[i]);
  const prompt = left.map((s) => s.optional?.prompt).find((p) => p !== undefined);
  const notice = [req.notice, ...left.map((s) => s.optional?.notice)].filter(Boolean).join(" · ");
  return {
    ...req,
    chainSkipped: { slots: skipped, ...(prompt !== undefined && req.prompt !== undefined ? { prompt: req.prompt } : {}) },
    ...(prompt !== undefined ? { prompt } : {}),
    ...(notice ? { notice } : {}),
  };
}

/** The chain slots a step fills: its own, less the optional ones left out (chainSkipped). */
const filledSlots = (req: GenerationRequest, n: number): ChainSlot[] => slotsFor(req, n).filter((_, i) => !req.chainSkipped?.slots.includes(i));

/** When a step after real ComfyUI steps first found ComfyUI not answering, by step id (shared across hot reloads). */
declare global {
  var __fuobeComfyWaits: Map<string, number> | undefined;
}
const comfyWaits = (): Map<string, number> => (globalThis.__fuobeComfyWaits ??= new Map<string, number>());
/** How long such a step waits for ComfyUI to answer again before chainMode fails it. */
export const COMFY_WAIT = { ms: 60_000 };

/** Launch dependent jobs whose inputs finished; fail the ones whose inputs failed. Never waits for an upload. */
async function advanceDependents(): Promise<void> {
  const rows = db().prepare(READY_DEPENDENTS).all(50 + submitting().size) as Row[];
  // A forced look at ComfyUI, at most one a sweep, for the steps that found it not answering.
  let lookedAgain: Promise<boolean> | undefined;
  for (const r of rows) {
    if (submitting().has(r.id)) continue;
    // A step queued before its model was retired runs on what replaced it (and its row says so).
    const moved = currentRequest(JSON.parse(r.request_json) as GenerationRequest);
    const stored = moved.request;
    const allIds = depIds(r.depends_on);
    const allSlots = slotsFor(stored, allIds.length);
    const allDeps = allIds.map(
      (id) => db().prepare("SELECT status, provider, outputs_json, request_json FROM generations WHERE id = ?").get(id) as Pick<Row, "status" | "provider" | "outputs_json" | "request_json"> | undefined,
    );
    const earlier = stored.frame ? "The previous frame" : "An earlier step";
    const fail = (error: string) => {
      update(r.id, { status: "failed", error, message: null, completed_at: Date.now() });
      // Steps waiting only to feed this one (the other lanes of a per-frame render) are dropped before they are paid for.
      dropUnused(allIds);
    };
    const broken = (d: (typeof allDeps)[number]) => !d || d.status === "failed" || d.status === "canceled";
    // An optional input whose step failed is left out (Genjutsu's anchor frame): the step runs without it.
    const skipped = allSlots.flatMap((s, i) => (s.optional && broken(allDeps[i]) ? [i] : []));
    if (allDeps.some((d, i) => broken(d) && !skipped.includes(i))) {
      fail(waitedOnFailure(!!stored.frame));
      continue;
    }
    const keep = (_: unknown, i: number) => !skipped.includes(i);
    const deps = allDeps.filter(keep);
    const slots = allSlots.filter(keep);
    if (deps.some((d) => d!.status !== "succeeded")) continue;
    const request = skipped.length ? withoutSkipped(stored, allSlots, skipped) : stored;
    // What changed upstream (an earlier fallback) is said on this step too, down to the finished result.
    const notices = [request.notice, ...deps.map((d) => (JSON.parse(d!.request_json) as GenerationRequest).notice)].filter((x): x is string => !!x);
    if (notices.length) request.notice = [...new Set(notices)].join(" · ");
    const outputs = deps.map((d) => JSON.parse(d!.outputs_json) as OutputFile[]);
    const short = slots.map((s, i) => listShortfall(outputs[i], s)).find(Boolean);
    if (short) {
      fail(`${earlier} ${short}`);
      continue;
    }
    submitting().add(r.id);
    let handedOff = false;
    // An account's step reads its inputs, and is planned, as its run was: as that account, on its own ComfyUI and its own
    // keys. submit() then checks the step's own provider (its GPU, or its key for that provider).
    const account = stored.account;
    // A step of a run on this install's GPUs is planned there too, with the run's stamp (its place and hold).
    const asRun = <T,>(fn: () => T): T => (account ? (stored.place === "pool" ? runOnPool(account, () => withRunStamp(stampOf(stored), fn)) : asAccount(account, fn)) : fn());
    try {
      // The planned op (r.op), not request.op: a translate whose op was inferred still gets the cue list.
      const values = await asRun(() => Promise.all(outputs.map((o, i) => chainValue(pickOutput(o, slots[i]), slots[i], r.op))));
      const missing = values.findIndex((u) => !u);
      if (missing >= 0) {
        fail(`${earlier} has no ${slots[missing].render ? "depth picture" : slotNoun(slots[missing])} to use`);
        continue;
      }
      // Routing reads cached reachability: make sure it's fresh for local engines. An Original counts with the routes of
      // the engine it runs on, ComfyUI taken as answering: one on the cloud doesn't use it, so doesn't wait for it.
      const model = getModel(request.modelId);
      const runs = model && dualEngine(model) ? onEngine(model, pickEngine(model, request.engine, engineMode(), () => true)) : model;
      // (An account's step looks at its own ComfyUI, never the install's: inside its run, probeComfy says yes and the run finds out.)
      if (runs?.routes.some((x) => x.provider === "comfyui") && !(await asRun(() => probeComfy())) && deps.some((d) => d!.provider === "comfyui")) {
        // The earlier steps ran for real on ComfyUI: one missed check (a server busy finishing them, or restarting)
        // mustn't make this one a demo, which chainMode fails. Look again at once (one forced look a sweep), then wait
        // for the next sweeps (COMFY_WAIT from the first miss) before chainMode has its say.
        const first = comfyWaits().get(r.id);
        const back = first === undefined && (await (lookedAgain ??= probeComfy(true)));
        if (!back && first === undefined) {
          comfyWaits().set(r.id, Date.now());
          update(r.id, { message: "Waits for ComfyUI to answer" });
          continue;
        }
        if (!back && Date.now() - first! < COMFY_WAIT.ms) continue;
      }
      comfyWaits().delete(r.id);
      // A camera path drawn through the still's depth on this server (Uni3C's guide where no browser drew one); a demo
      // depth step hands on a demo render. Only once ComfyUI answers: a sweep that waits for it renders nothing.
      for (let i = 0; i < slots.length; i++) {
        if (slots[i].render !== "path") continue;
        // The still, once the other slots are in (it can come from an earlier step too: a Canvas node's picture).
        const photo = withChainInputs({ ...request, chain: slots }, values as string[]).inputs?.images?.[0];
        const keys = request.params?.cameraPath ?? [];
        if (deps[i]!.provider === "mock" || !photo) values[i] = placeholderFor(slots[i]);
        else {
          update(r.id, { message: "Rendering the camera path" });
          values[i] = await asRun(() => renderPathVideo({ photo, depth: values[i]!, keys }, r.id));
        }
      }
      if (model?.routes.some((x) => x.provider === "llm")) await probeLocal();
      // Filled with the slots that have an input; stored with its whole chain (and what was skipped) for a retry.
      const filled = withChainInputs({ ...request, chain: slots }, values as string[]);
      // A 2K finish names the draft it waits for as the latent to load (never an id stored before: a retried draft is new).
      const original: GenerationRequest = latentFromDependency({ ...filled, chain: request.chain, chainFilled: true }, allIds.filter(keep), slots, deps);
      const prepared = asRun(() => prepare(original));
      const mode = chainMode(prepared, deps as Pick<Row, "provider">[], original);
      if (mode.error) throw new Error(mode.error);
      const p = mode.forceDemo ? { ...prepared, demo: true, providerId: "mock" as const, cost: 0 } : prepared;
      update(r.id, {
        ...(moved.note && { model_id: p.plan.model.id, engine: p.plan.model.engine }),
        provider: p.providerId,
        op: p.plan.op,
        kind: outputKind(p.plan.op, p.plan.model),
        prompt: p.plan.prompt,
        cost_usd: p.cost,
        request_json: JSON.stringify(original),
        message: mode.forceDemo ? "Demo — an earlier step ran as a demo" : p.demo ? "Demo mode — no provider connected" : "Submitting",
      });
      // In the background: an upload must not hold up the runner's other polls.
      handedOff = true;
      void submit(r.id, p.route, p.providerId, p.plan, p.req, 0);
    } catch (e) {
      fail((e as Error).message);
    } finally {
      if (!handedOff) submitting().delete(r.id);
    }
  }
}

/** A chained 2K finish finishes the run its clip comes from (a retried draft is a new run: read again when it is created). */
function withFinishOf(req: GenerationRequest, dependsOn: string | string[] | undefined): GenerationRequest {
  if (!req.finishOf || dependsOn === undefined) return req;
  const deps = Array.isArray(dependsOn) ? dependsOn : [dependsOn];
  const at = slotsFor(req, deps.length).findIndex((s) => s.slot === "video");
  return at >= 0 && deps[at] !== req.finishOf ? { ...req, finishOf: deps[at] } : req;
}

/**
 * MiniMax H3's 2K finish (Open-H3 Regenerate chained after its 768p draft): the draft it waits for, when that draft kept
 * its latent, is the latent it may load (latentHandOff checks it again when it starts). Any other latentFrom is dropped.
 */
function latentFromDependency(req: GenerationRequest, ids: string[], slots: ChainSlot[], deps: (Pick<Row, "request_json"> | undefined)[]): GenerationRequest {
  if (req.modelId !== REGEN_MODEL) return req;
  const at = slots.findIndex((s) => s.slot === "video");
  let draft: GenerationRequest | undefined;
  try {
    draft = at >= 0 && deps[at] ? (JSON.parse(deps[at]!.request_json) as GenerationRequest) : undefined;
  } catch {}
  const { latentFrom: _stored, ...extra } = req.params?.extra ?? {};
  void _stored;
  const latentFrom = draft?.params?.extra?.latentDraft === true ? ids[at] : undefined;
  if (!latentFrom && _stored === undefined) return req;
  return { ...req, params: { ...req.params, extra: { ...extra, ...(latentFrom && { latentFrom }) } } };
}

/**
 * The 2K hand-off as the run starts, on the ComfyUI it runs on (never trusted from the request; package n7-10). A draft
 * keeps its latent only where one stays between jobs (not the owner's workers) and while its Turbo 4-step LoRA is on. A
 * finish loads a latent only from a run of the same account (or the owner's own) that kept one on this same ComfyUI,
 * and that no earlier finish found gone; otherwise it redraws its clip.
 */
export function latentHandOff(extra: Record<string, unknown> | undefined, account: string | undefined): Record<string, unknown> | undefined {
  if (!extra || (extra.latentDraft === undefined && extra.latentFrom === undefined)) return extra;
  const out = { ...extra };
  const place = comfyPlace();
  if (out.latentDraft !== undefined && !(out.latentDraft === true && place && keepsH3Latent())) delete out.latentDraft;
  if (out.latentFrom !== undefined && !(typeof out.latentFrom === "string" && place && keptLatent(out.latentFrom, account, place))) delete out.latentFrom;
  return out;
}

/** Whether run `id` kept its 768p latent on `place` for this account (the owner: undefined), and it is still there. */
function keptLatent(id: string, account: string | undefined, place: string): boolean {
  const row = db().prepare("SELECT status, request_json, external_meta_json FROM generations WHERE id = ?").get(id) as Pick<Row, "status" | "request_json" | "external_meta_json"> | undefined;
  if (!row || row.status !== "succeeded" || accountOf(row) !== account) return false;
  try {
    const req = JSON.parse(row.request_json) as GenerationRequest;
    const meta = JSON.parse(row.external_meta_json ?? "{}") as { latentAt?: unknown };
    if (req.params?.extra?.latentDraft !== true || meta.latentAt !== place) return false;
  } catch {
    return false;
  }
  // A finish that found it gone (someone's computer reports that after the fact): the next one redraws the clip.
  const gone = db()
    .prepare("SELECT 1 FROM generations WHERE status = 'failed' AND error = ? AND json_extract(request_json, '$.params.extra.latentFrom') = ? LIMIT 1")
    .get(REGEN_COPY.latentGone, id);
  return !gone;
}

const statusOf = (id: string) => (db().prepare("SELECT status FROM generations WHERE id = ?").get(id) as Pick<Row, "status"> | undefined)?.status;

/** Start the timeout clock: the job has reached its provider. */
function recordSubmission(id: string, at: number): void {
  db()
    .prepare("INSERT INTO generation_runs (id, submitted_at, started_at) VALUES (?, ?, NULL) ON CONFLICT(id) DO UPDATE SET submitted_at = excluded.submitted_at, started_at = NULL")
    .run(id, at);
}

// ---------------------------------------------------------------------------
// Public sign-up: an account's runs go to its own ComfyUI ("Your GPU") or its own fal.ai or Replicate key ("Your
// keys"), never the install's providers

export const OWN_GPU_ONLY = "Pick an open-source model to run it on your GPU.";
export const OPEN_ONLY_RUN = "Pick an open-source model to run this on your GPU.";
export const SWITCHED_OFF_RUN = "This account is closed, so its runs stopped.";
/** A run on this install's GPUs that waited past its limit (hosted runs). */
export const POOL_WAITED = "The studio's GPUs were busy, so it didn't run. Not charged.";

/**
 * Everything an account's work runs inside: as the account (tenant.ts: only its own files and runs), on its own ComfyUI
 * (none yet: an address that reaches nothing), with its own fal.ai and Replicate keys (provider-keys.ts), its engine
 * mode, fal.ai before Replicate among the keys it has, and no demo outputs.
 */
export function asAccount<T>(id: string, fn: () => T): T {
  const mode = accountEngineMode(id);
  const gpu = accountGpu(id);
  return runAsTenant({ kind: "account", id }, () =>
    onOwnGpu(gpu ? ownGpuOf(id, gpu) : { url: "" }, () => withCandidates({ engineMode: mode, demoMode: "off", cloudProvider: "auto" }, fn)),
  );
}

export type AccountRunRefusal = { error: string; code: "connect-gpu" | "add-key" | "own-gpu-tool" | "open-only" | "switched-off"; provider?: CloudProvider };

/**
 * How an account's job reaches a provider, inside asAccount, or not at all. ComfyUI needs its own GPU; fal.ai and
 * Replicate need its own key for that provider. Anything else (the install's local LLM, demo outputs) is refused. A
 * "submit" also needs a live account and a studio that isn't open-source only; a "poll" or "cancel" works for a
 * switched-off account too, so a job going on its key finishes or stops, never runs on. An unreachable GPU or a refused
 * key fails the job: it never falls back to the install's.
 */
export function accountRun(accountId: string, providerId: string, purpose: "submit" | "poll" | "cancel" = "submit"): { run: <T>(fn: () => T) => T } | AccountRunRefusal {
  const run = <T,>(fn: () => T): T => asAccount(accountId, fn);
  if (providerId === "comfyui") return accountGpu(accountId) ? { run } : { error: CONNECT_GPU_MESSAGE, code: "connect-gpu" };
  if (!isCloudProvider(providerId)) return { error: OWN_GPU_ONLY, code: "own-gpu-tool" };
  const p = providerId;
  if (purpose === "submit") {
    const a = accountById(accountId);
    if (!a || a.disabled) return { error: SWITCHED_OFF_RUN, code: "switched-off" };
    if (!paidAllowed()) return { error: OPEN_ONLY_RUN, code: "open-only" };
  }
  if (accountKey(accountId, p) === null) return { error: purpose === "submit" ? addKeyMessage(p) : keyRemovedMessage(p), code: "add-key", provider: p };
  return { run };
}

/** The account's answer to "who may run this": the route turns it into a 403 the client acts on (Connect your GPU, Add your key). */
export class AccountRunError extends Error {
  constructor(readonly refusal: AccountRunRefusal) {
    super(refusal.error);
  }
}

/**
 * The adapter for a run's provider, only inside its own account's work (none: the owner's). A run that lost its scope
 * fails here: it never falls into the owner's keys (provider-keys.ts).
 */
export function adapterFor(providerId: ProviderId, account: string | undefined): ProviderAdapter {
  if ((tenantAccount() ?? undefined) !== (account ?? undefined)) throw new Error("We can't find that run.");
  return provider(providerId);
}

/** Where an account's ComfyUI is, as the provider takes it: a link, or the person's own computer (its tab runs the jobs). */
function ownGpuOf(accountId: string, gpu: AccountGpu): OwnGpu {
  return gpu.mode === "computer" ? { kind: "computer", principal: `acct:${accountId}` } : { url: gpu.url, token: gpu.token };
}

/**
 * The LoRA files an account's run needs that its own ComfyUI doesn't have (call it inside accountRun): the run's own,
 * and those of the step that makes its start frame first (a Fuobe DoP relight or Mixed Media effect, which
 * createRelitClip queues as a step of its own). Null when nothing is missing, or the list couldn't be read.
 */
export async function accountLoraFix(req: GenerationRequest): Promise<MissingFiles | null> {
  const p = previewGeneration(req);
  const asks: { loras: LoraRef[]; endpoint: string }[] = [];
  if (p.route.provider === "comfyui") asks.push({ loras: [...p.loras.applied, ...graphLoras(p.route.endpoint, req.params?.extra)], endpoint: p.route.endpoint });
  const pre = relightStep(req, p.model);
  if (pre) {
    try {
      const { step } = pre;
      const s = previewGeneration({
        feature: req.feature,
        account: req.account,
        engine: pre.engine,
        modelId: step.modelId,
        op: step.op,
        prompt: step.prompt,
        inputs: { images: (req.inputs?.images ?? []).slice(0, 1) },
        ...(step.loras?.length && { loras: step.loras }),
        ...(step.params && { params: step.params }),
      });
      if (s.route.provider === "comfyui") asks.push({ loras: [...s.loras.applied, ...graphLoras(s.route.endpoint, step.params?.extra)], endpoint: s.route.endpoint });
    } catch {
      // The step says what's wrong when it is created.
    }
  }
  // An end-frame step (Qwen-Image 2.1 edit that makes the clip's end frame) runs on the GPU too.
  if (p.plan.end) {
    try {
      const step = p.plan.end;
      const s = previewGeneration({
        feature: req.feature,
        account: req.account,
        engine: "open",
        modelId: step.modelId,
        op: step.op,
        prompt: step.promptTemplate,
        inputs: { images: (req.inputs?.images ?? []).slice(0, 1) },
        ...(step.params && { params: step.params }),
      });
      if (s.route.provider === "comfyui") asks.push({ loras: [...s.loras.applied, ...graphLoras(s.route.endpoint, step.params?.extra)], endpoint: s.route.endpoint });
    } catch {
      // The step says what's wrong when it is created.
    }
  }
  const items: MissingFiles["items"] = [];
  let workflowId: string | undefined;
  for (const a of asks) {
    const f = await checkAccountLoras(a.loras, a.endpoint);
    if (!f) continue;
    workflowId ??= f.workflowId;
    for (const i of f.items) if (!items.some((x) => x.file === i.file)) items.push(i);
  }
  return items.length ? { code: "comfy_missing_model", ...(workflowId && { workflowId }), items } : null;
}

/**
 * Plan (and price) as a visitor's run would go: as that visitor (an account, or a guest), on its own ComfyUI (none
 * yet: an empty address that reaches nothing), the open engine, no demo outputs. For previews; a run goes through
 * accountRun.
 */
export function asVisitor<T>(gpu: AccountGpu | null, fn: () => T, accountId?: string): T {
  return runAsTenant(accountId ? { kind: "account", id: accountId } : { kind: "guest" }, () =>
    onOwnGpu(gpu && accountId ? ownGpuOf(accountId, gpu) : { url: gpuLink(gpu)?.url ?? "" }, () => withCandidates({ engineMode: "open", demoMode: "off" }, fn)),
  );
}

/** A row whose request can't be read: whose it is is unknown, so it is never taken for the owner's (accountOf). */
const UNREADABLE = "\u0000unreadable";

/** The account a row's run is for; undefined: the owner's. A request that can't be read counts as nobody's (UNREADABLE). */
const accountOf = (r: Pick<Row, "request_json">): string | undefined => {
  try {
    return (JSON.parse(r.request_json) as GenerationRequest).account;
  } catch {
    return UNREADABLE;
  }
};

/** A row of a run on this install's GPUs (hosted runs). */
const poolOf = (r: Pick<Row, "request_json">): boolean => {
  try {
    return (JSON.parse(r.request_json) as GenerationRequest).place === "pool";
  } catch {
    return false;
  }
};

function submit(id: string, route: ModelRoute, providerId: ProviderId, plan: ReturnType<typeof planGeneration>, req: GenerationRequest, index: number): Promise<void> {
  if (!req.account) return submitNow(id, route, providerId, plan, req, index);
  // On this install's GPUs (hosted runs): as the account, on this install's ComfyUI server only.
  if (req.place === "pool") {
    if (providerId !== "comfyui") {
      update(id, { status: "failed", error: OWN_GPU_ONLY, completed_at: Date.now(), message: null });
      submitting().delete(id);
      return Promise.resolve();
    }
    return runOnPool(req.account, () => withRunStamp(stampOf(req), () => submitNow(id, route, providerId, plan, req, index)));
  }
  const own = accountRun(req.account, providerId, "submit");
  if ("error" in own) {
    update(id, { status: "failed", error: own.error, completed_at: Date.now(), message: null });
    // A chained step advanceDependents marked as being handed over isn't any more.
    submitting().delete(id);
    return Promise.resolve();
  }
  return own.run(() => submitNow(id, route, providerId, plan, req, index));
}

/** A song's cloud tools (Mureka): the song's length and format are read before it's sent. */
const SONG_TOOL_OPS = new Set<Operation>(["song-extend", "song-remix", "song-stems"]);

async function submitNow(
  id: string,
  route: ModelRoute,
  providerId: ProviderId,
  plan: ReturnType<typeof planGeneration>,
  req: GenerationRequest,
  index: number,
): Promise<void> {
  submitting().add(id);
  // MiniMax H3's 2K hand-off, decided here, on the ComfyUI this run goes to.
  if (providerId === "comfyui") {
    const extra = latentHandOff(plan.params.extra, req.account);
    if (extra !== plan.params.extra) plan = { ...plan, params: { ...plan.params, extra } };
  }
  // An account's run on its own GPU or key (not on this install's GPUs): a passing problem (a GPU that is off or starting
  // up, a busy or down provider) is waited out within a budget, the tile saying what it waits for; anything else fails
  // in plain words, with what helps (src/lib/diagnose.ts). The owner's runs and runs on this install's GPUs fail at once,
  // in their own words, as before.
  const account = req.account && req.place !== "pool" ? req.account : undefined;
  const link = account && providerId === "comfyui" ? gpuLink(accountGpu(account)) : null;
  const started = Date.now();
  let tries = 0;
  let rechecked = false;
  try {
    for (;;) {
      let error: unknown;
      // The first try reads the GPU's last status check (never asked again here): one that is off waits at once,
      // instead of sending files to an address that answers nothing.
      const known = link && tries === 0 ? cachedGpuState(account!, link.url) : undefined;
      if (known && !known.online && known.trouble?.retryable) error = troubleError(known.trouble);
      else {
        try {
          await handOver(id, route, providerId, plan, req, index);
          if (link && statusOf(id) !== "failed") noteHandedOver(account!, link.url);
          return;
        } catch (e) {
          error = e;
        }
      }
      const status = statusOf(id);
      // A cancel during the hand-over stays a cancel.
      if (!status || status === "canceled") return;
      let trouble = account ? accountTrouble(error, account, providerId, "submit", req) : undefined;
      const heal = trouble?.retryable ? retryPlan(trouble.cause) : null;
      if (heal && trouble) {
        tries++;
        const wait = backoffMs(tries, heal, trouble.retryAfterMs) * SELF_HEAL.scale;
        if (Date.now() - started + wait <= heal.budgetMs * SELF_HEAL.scale) {
          if (link) noteGpuState(account!, link.url, false, { trouble: asStatus(error, trouble, link) });
          update(id, { status: "queued", message: waitingWords(trouble, isCloudProvider(providerId) ? providerId : undefined) });
          if (!(await pause(id, wait))) return;
          // The account moved its GPU meanwhile (another address, or this computer): this run was planned for the old one.
          if (link && gpuLink(accountGpu(account!))?.url !== link.url) {
            failRun(id, error, diagnoseGpuJob({ kind: "moved" }, { kind: "link", url: link.url }), req.account);
            return;
          }
          continue;
        }
        // Out of time: a GPU that seemed off is asked once more before the run fails (it may be back by now).
        if (link && !rechecked) {
          rechecked = true;
          const again = await recheckGpu(account!, link);
          if (again === "online") continue;
          trouble = { ...again, actions: withKeyOffer(again.actions, account!, req) };
        }
      }
      failRun(id, error, trouble, req.account);
      return;
    }
  } finally {
    submitting().delete(id);
  }
}

/** Self-healing's clock: tests make it faster (0.001: a 30-minute wait takes 1.8 s). */
export const SELF_HEAL = { scale: 1 };

/** Wait `ms`, looking every second whether the run was cancelled (false: it was, or it was deleted). */
async function pause(id: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    const left = end - Date.now();
    if (left <= 0) return true;
    await new Promise((r) => setTimeout(r, Math.min(1000, left)));
    const s = statusOf(id);
    if (!s || s === "canceled") return false;
  }
}

/** A failed run in its words: an account's plain sentence (the owner's own detail as before), with what helps and "Fix it". */
function failRun(id: string, e: unknown, trouble: Diagnosis | undefined, account: string | undefined): void {
  const fix = (e as { fix?: GenerationFix }).fix;
  const kept = keptFix(fix, trouble);
  // What the GPU was missing (a model, a node class) is kept, so the tile offers "Fix it", and its GPU check counts as stale.
  update(id, { status: "failed", error: trouble?.words ?? (e as Error).message, completed_at: Date.now(), message: null, ...(kept && { fix_json: kept }) });
  if (fix) markStale(account ? `acct:${account}` : "install");
}

/** generations.fix_json: what the GPU was missing (GenerationFix) and, for an account, what its GPU or key ran into. */
const keptFix = (fix: GenerationFix | undefined, trouble: Diagnosis | undefined): string | undefined =>
  fix || trouble ? JSON.stringify({ ...(fix ?? {}), ...(trouble && { trouble: troubleOf(trouble) }) }) : undefined;

/** A network failure (no answer at all) as its words, or undefined for any other error. */
function networkReason(e: unknown): string | undefined {
  const err = e as { message?: unknown; cause?: { code?: unknown } } | null;
  const code = typeof err?.cause?.code === "string" ? err.cause.code : undefined;
  const msg = String(err?.message ?? "");
  if (!code && !/fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|UND_ERR/i.test(msg)) return undefined;
  return [msg, code && !msg.includes(code) ? code : undefined].filter(Boolean).join(" ");
}

/** Another key of the account that runs the same model (Replicate for fal.ai, or the other way round). */
function otherKeyFor(account: string, p: CloudProvider, modelId: string | undefined): CloudProvider | undefined {
  const m = modelId ? getModel(modelId) : undefined;
  return m ? accountProviders(account).find((k) => k !== p && m.routes.some((r) => r.provider === k)) : undefined;
}

/**
 * The cloud version of a run on the account's GPU that one of its keys runs: a preset's first cloud route, or the same
 * Fuobe Original on the cloud engine. Null without a key that serves it, or when the studio is open-source only.
 */
export function cloudTwin(req: Pick<GenerationRequest, "presetId" | "modelId">, account: string): { modelId: string; provider: CloudProvider; op?: string } | null {
  if (!paidAllowed()) return null;
  const keys = accountProviders(account);
  if (!keys.length) return null;
  const has = (id: string) => !!getModel(id);
  const preset = req.presetId ? getPreset(req.presetId) : undefined;
  const asked = getModel(req.modelId);
  const routes: { modelId: string; op?: string }[] = preset ? presetRoutes(preset as Parameters<typeof presetRoutes>[0], "cloud", has) : asked && dualEngine(asked) ? [{ modelId: asked.id }] : [];
  for (const { modelId: id, op } of routes) {
    const m = getModel(id);
    if (!m) continue;
    const cloud = dualEngine(m) ? onEngine(m, "cloud") : m;
    if (cloud.engine === "open") continue;
    const p = CLOUD_PROVIDERS.find((k) => keys.includes(k) && cloud.routes.some((r) => r.provider === k));
    // Another model: its operation there goes with it (the same model keeps the run's own).
    if (p) return { modelId: id, provider: p, ...(op && id !== req.modelId && { op }) };
  }
  return null;
}

/** A GPU trouble's buttons, with "Run with your … key" when one of the account's keys runs this tool's cloud version. */
function withKeyOffer(actions: TroubleAction[], account: string, req: Pick<GenerationRequest, "presetId" | "modelId">): TroubleAction[] {
  if (actions.some((a) => a.kind === "run-with-key")) return actions;
  const twin = cloudTwin(req, account);
  return twin ? [...actions, withKeyAction(twin.provider, twin.modelId, twin.op)] : actions;
}

/**
 * What an account's run ran into, as diagnose.ts reads it: its own GPU's words (comfyui.ts troubleError), or its key's
 * provider's status and words. Undefined for anything else (a request's own problem, already in plain words).
 */
function accountTrouble(e: unknown, account: string, providerId: string, stage: KeyStage, req?: Pick<GenerationRequest, "presetId" | "modelId">): Diagnosis | undefined {
  const own = (e as { trouble?: Diagnosis } | null)?.trouble;
  if (own) return providerId === "comfyui" && req && own.cause.startsWith("gpu-") ? { ...own, actions: withKeyOffer(own.actions, account, req) } : own;
  if (!isCloudProvider(providerId)) return undefined;
  const ctx = { provider: providerId, other: otherKeyFor(account, providerId, req?.modelId) };
  const message = String((e as Error | null)?.message ?? "");
  // No key to send (removed, or one this server can't open any more): its own words, and where to add one.
  if (message === addKeyMessage(providerId) || message === keyRemovedMessage(providerId)) {
    return { cause: "key-rejected", words: message, actions: [{ kind: "key-settings", label: "Add your key", target: "/settings#your-keys" }], retryable: false };
  }
  const status = (e as { status?: unknown } | null)?.status;
  // The provider's own words (provider-keys.ts accountKeyError keeps them, without the key) tell a refused key from a
  // model the key may not run.
  const said = (e as { said?: unknown } | null)?.said;
  if (typeof status === "number" && status > 0) return diagnoseKey({ stage, status, text: typeof said === "string" ? said : message }, ctx);
  const net = networkReason(e);
  return net ? diagnoseKey({ stage, error: net }, ctx) : undefined;
}

/** A short, stable name for the address a run was sent to (kept with the run, never the address itself). */
const addressKey = (url: string) => crypto.createHash("sha256").update(url.replace(/\/+$/, "")).digest("hex").slice(0, 16);

/** A run reached the account's GPU: the status strip and the next run take it as online (without asking it). */
function noteHandedOver(account: string, url: string): void {
  const known = cachedGpuState(account, url);
  if (known && !known.online) noteGpuState(account, url, true);
}

/** The account's GPU asked once more, before a run that couldn't reach it fails: "online", or why not (the run's words). */
async function recheckGpu(account: string, link: { url: string; token?: string }): Promise<"online" | Diagnosis> {
  const place = { kind: "link" as const, url: link.url, hasToken: !!link.token };
  try {
    const { url: _moved, ...info } = await testGpu(link, { timeoutMs: 8000, stage: "status" });
    void _moved;
    noteGpuState(account, link.url, true, { info });
    return "online";
  } catch (e) {
    // The status strip keeps the check's words; the run says the same in a run's words.
    const f: GpuFailure = (e instanceof GpuError && e.failure) || { stage: "status", error: (e as Error).message };
    noteGpuState(account, link.url, false, { trouble: e instanceof GpuError && !e.failure ? e.trouble : diagnoseGpu(f, place) });
    return e instanceof GpuError && !e.failure ? e.trouble : diagnoseGpu({ ...f, stage: "poll" }, place);
  }
}

/** A run's GPU trouble as the status strip says it (in a check's words) when what came back is known; else as it is. */
function asStatus(error: unknown, trouble: Diagnosis, link: { url: string; token?: string }): Diagnosis {
  const f = (error as { failure?: GpuFailure } | null)?.failure;
  return f ? diagnoseGpu({ ...f, stage: "status" }, { kind: "link", url: link.url, hasToken: !!link.token }) : trouble;
}

declare global {
  /** Account runs whose polls keep failing: since when, how many in a row, and when to ask again (self-healing). */
  var __fuobePollHeals: Map<string, { first: number; n: number; next: number }> | undefined;
  /** Account runs already sent again once after their GPU restarted and lost them. */
  var __fuobeResent: Set<string> | undefined;
}
const pollHeals = () => (globalThis.__fuobePollHeals ??= new Map());
/** A run its GPU lost, sent again (diagnose.ts diagnoseGpuJob "lost"). */
const RESENT_WORDS = "Your GPU restarted, so we sent this run again";
const resentRuns = () => (globalThis.__fuobeResent ??= new Set());

/** What a poll can't wait out: a key refused, credit gone, no access; a GPU that wants a password or a sign-in. */
const FINAL_AT_POLL: ReadonlySet<string> = new Set(["key-rejected", "key-balance", "key-permission", "gpu-password", "gpu-password-wrong", "gpu-sign-in", "address-local"]);

/** How long an account's run's polls may keep failing before it stops: its own GPU, or its key's provider. */
const POLL_HEAL_MS = { comfyui: 15 * 60_000, cloud: 10 * 60_000 };
/** Polls that fail in a row before the tile says it is waiting. */
const POLL_MISSES_SAID = 3;

/**
 * A run its GPU lost (ComfyUI restarted): sent again once, planned as it was (inputs uploaded again). False when it
 * can't be (sent again before, or its plan doesn't go to the same place any more).
 */
function resend(r: Row, account: string, words: string): boolean {
  if (resentRuns().has(r.id)) return false;
  try {
    const stored = JSON.parse(r.request_json) as GenerationRequest;
    const p = asAccount(account, () => prepare(stored));
    if (p.providerId !== r.provider) return false;
    resentRuns().add(r.id);
    if (resentRuns().size > 5000) resentRuns().delete(resentRuns().values().next().value!);
    db().transaction(() => {
      update(r.id, { external_id: null, external_meta_json: null, status: "queued", progress: null, message: words });
      db().prepare("DELETE FROM generation_runs WHERE id = ?").run(r.id);
    })();
    submitting().add(r.id);
    void submit(r.id, p.route, p.providerId, p.plan, p.req, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * An account's poll that failed: a key that won't work (refused, no credit, no access) fails the run at once; a passing
 * problem (its GPU off, its provider busy) is asked again with a growing wait, the tile saying so, until the budget is
 * spent: then its GPU is asked once more, and the run fails in plain words. True when the poll was handled here.
 */
async function healPoll(r: Row, ctx: PollContext, account: string, pollError: unknown): Promise<boolean> {
  const stored = JSON.parse(r.request_json) as GenerationRequest;
  const d = accountTrouble(pollError, account, r.provider, "poll", stored);
  const cancel = () =>
    adapterFor(r.provider, account)
      .cancel?.(ctx)
      .catch(() => {});
  if (d && !d.retryable && FINAL_AT_POLL.has(d.cause)) {
    await cancel();
    pollHeals().delete(r.id);
    failRun(r.id, pollError, d, account);
    return true;
  }
  if (!d) return false;
  const now = Date.now();
  const h = pollHeals().get(r.id) ?? { first: now, n: 0, next: 0 };
  h.n++;
  h.next = now + backoffMs(h.n, { budgetMs: 0, firstMs: 5_000, maxMs: 60_000 }, d.retryAfterMs) * SELF_HEAL.scale;
  pollHeals().set(r.id, h);
  const budget = (r.provider === "comfyui" ? POLL_HEAL_MS.comfyui : POLL_HEAL_MS.cloud) * SELF_HEAL.scale;
  if (now - h.first >= budget) {
    const link = r.provider === "comfyui" ? gpuLink(accountGpu(account)) : null;
    // Its GPU asked once more: back, it is polled again at once (and collected, or found lost and sent again).
    if (link && (await recheckGpu(account, link)) === "online") {
      pollHeals().delete(r.id);
      return true;
    }
    await cancel();
    pollHeals().delete(r.id);
    const minutes = Math.max(1, Math.round((now - h.first) / 60_000));
    const end = link ? diagnoseGpuJob({ kind: "gone", minutes }, { kind: "link", url: link.url }) : d;
    failRun(r.id, pollError, { ...end, actions: link ? withKeyOffer(end.actions, account, stored) : end.actions }, account);
    return true;
  }
  if (h.n >= POLL_MISSES_SAID) {
    const words = r.provider === "comfyui" ? "Your GPU stopped answering. Waiting for it to come back" : waitingWords(d, isCloudProvider(r.provider) ? r.provider : undefined);
    if (r.message !== words) update(r.id, { message: words });
  }
  return true;
}

/** Copy one result of an account's run, trying again a few times when the copy breaks off (a passing network problem). */
async function persistWithRetry(o: RichOutput, id: string): Promise<OutputFile> {
  for (let n = 1; ; n++) {
    try {
      return await persistOutput(o, id);
    } catch (e) {
      const msg = (e as Error).message ?? "";
      const passing =
        !(e instanceof AccountFilesFull) && !/^The answer was over/.test(msg) && msg !== ACCOUNT_MESSAGES.diskLow && (/^download (5\d\d|429|408)$/.test(msg) || e instanceof RemoteFetchError || !!networkReason(e));
      if (!passing || n >= 3) throw e;
      await new Promise((r) => setTimeout(r, [2_000, 5_000][n - 1] * SELF_HEAL.scale));
    }
  }
}

/** Why an account's result couldn't be saved, in its words: too big, an expired link, or a GPU that stopped answering. */
function saveTrouble(e: unknown, provider: string): Diagnosis | undefined {
  const msg = (e as Error).message ?? "";
  if (msg === ACCOUNT_MESSAGES.diskLow) return undefined;
  // (An account's saved address is in scope for its runs on its keys too: only a run on its GPU was copied from there.)
  const link = provider === "comfyui" ? ownLink() : null;
  const over = /^The answer was over (.+)$/.exec(msg)?.[1];
  if (link) return diagnoseGpuJob({ kind: "save", ...(over && { over }) }, link);
  if (isCloudProvider(provider) && /^download (403|404|410)$/.test(msg)) return resultExpired();
  return undefined;
}

/**
 * Hand a run over to its provider once: its files, then the job. Throws what went wrong (submitNow decides whether to wait
 * and try again, or to fail the run).
 */
async function handOver(id: string, route: ModelRoute, providerId: ProviderId, plan: ReturnType<typeof planGeneration>, req: GenerationRequest, index: number): Promise<void> {
  /** Why the run failed, once it has: its files still waiting to be sent are not sent. */
  let failed: { error: unknown } | undefined;
  try {
    // An account's run on its own ComfyUI and keys only (asAccount): outside it, nothing is sent.
    const adapter = adapterFor(providerId, req.account);
    // An account's run on its own ComfyUI: every LoRA it adds must be there first (nothing is sent before this check).
    if (req.account && req.place !== "pool" && providerId === "comfyui") {
      const fix = await checkAccountLoras([...plan.loras, ...graphLoras(route.endpoint, plan.params.extra)], route.endpoint, route);
      if (fix) throw Object.assign(new Error(missingFilesMessage(fix)), { fix });
    }
    // An account's files go to its ComfyUI one at a time, a few across the server (account-send.ts). A file whose turn
    // comes after another input failed, or after a cancel, isn't read or sent.
    const gate = <T,>(fn: () => Promise<T>): Promise<T> => {
      if (!req.account) return fn();
      return accountSend(req.account, async () => {
        if (failed) throw failed.error;
        if (statusOf(id) === "canceled") throw new Error("Stopped");
        try {
          return await fn();
        } catch (e) {
          failed ??= { error: e };
          throw e;
        }
      });
    };
    const prep = async (ref?: string) => {
      if (!ref) return undefined;
      return gate(async () => {
        const f = await readRef(ref);
        return adapter.prepareFile(f.data, f.contentType, f.name, route);
      });
    };
    // An end-frame step crops the start frame before the edit (the recipe's crop of the subject).
    const cropWindow = isCropWindow(plan.params.extra?.crop) ? plan.params.extra.crop : undefined;
    const prepCropped = async (ref?: string) => {
      if (!ref || !cropWindow) return prep(ref);
      return gate(async () => {
        const f = await readRef(ref);
        const data = cropPicture(f.data, cropWindow);
        return adapter.prepareFile(data, "image/png", f.name.replace(/\.[^.]+$/, ".png"), route);
      });
    };
    // The input clip's header (size, frame rate, length): upscalers that take a factor and frame-count routes read it.
    let source: Pick<GenInput, "sourceSize" | "sourceFps" | "sourceDuration"> = {};
    const prepVideo = async (ref?: string) => {
      if (!ref) return undefined;
      return gate(async () => {
        const f = await readRef(ref);
        const facts = mediaFacts(f.data);
        source = {
          ...(facts.width && facts.height ? { sourceSize: { width: facts.width, height: facts.height } } : {}),
          ...(facts.fps ? { sourceFps: facts.fps } : {}),
          ...(facts.duration ? { sourceDuration: facts.duration } : {}),
        };
        return adapter.prepareFile(f.data, f.contentType, f.name, route);
      });
    };
    // A talking avatar is as long as its voice (fal's InfiniteTalk and Wan 2.2 S2V take a frame count): the voice's header.
    const prepVoice = async (ref?: string) => {
      if (!ref) return undefined;
      return gate(async () => {
        const f = await readRef(ref);
        const facts = mediaFacts(f.data);
        if (facts.duration && !source.sourceDuration) source = { ...source, sourceDuration: facts.duration };
        return adapter.prepareFile(f.data, f.contentType, f.name, route);
      });
    };
    // A song tool's song (Mureka): its length read as a voice's is, and one Mureka refuses (Stems: MP3 or M4A, 10 MB; Remix:
    // 10 to 350 seconds) refused here, before it's sent to Mureka or paid for.
    const prepSong = async (ref?: string) => {
      if (!ref) return undefined;
      return gate(async () => {
        const f = await readRef(ref);
        const facts = mediaFacts(f.data);
        if (facts.duration && !source.sourceDuration) source = { ...source, sourceDuration: facts.duration };
        const problem = providerId === "mock" ? null : songToolProblem(plan.op, { format: songFormat(f.contentType, f.name), bytes: f.data.length, seconds: facts.duration });
        if (problem) throw new Error(problem);
        return adapter.prepareFile(f.data, f.contentType, f.name, route);
      });
    };
    // Reference clips and clip elements a model bills with the output (Kling 4.0, Pricing.clipInput): their headers' lengths.
    // By the clip's place in inputs.videos, so a clip element (params.elements' video) finds its own length.
    const clipLengths: (number | undefined)[] = [];
    const billsClips = !!plan.model.pricing?.clipInput;
    const prepClip = async (ref: string | undefined, i: number) => {
      if (!ref || !billsClips) return prep(ref);
      return gate(async () => {
        const f = await readRef(ref);
        const facts = mediaFacts(f.data);
        if (facts.duration) clipLengths[i] = facts.duration;
        return adapter.prepareFile(f.data, f.contentType, f.name, route);
      });
    };
    const prepMask = async (ref?: string) => {
      if (!ref) return undefined;
      return gate(async () => {
        const f = await readRef(ref);
        const fmt = route.map?.maskFormat;
        const data = fmt && fmt !== "white" && f.contentType === "image/png" ? convertMask(f.data, fmt) : f.data;
        return adapter.prepareFile(data, f.contentType, f.name, route);
      });
    };
    let prompt = plan.prompt;
    const captioned = plan.model.options.promptFormat === "ideogram4";
    // A layout's prompt is compiled boxes (plan.layout): the enhancer would rewrite them, so it never runs on one.
    const laidOut = !!plan.layout || carriesLayout(req.params?.extra);
    if (req.params?.enhancePrompt && prompt && !captioned && !laidOut) {
      update(id, { message: "Enhancing prompt" });
      const words = plan.soul?.words;
      const at = words ? prompt.indexOf(words) : -1;
      if (words && at >= 0) {
        // Soul: only the user's words are expanded (60–120 words of subject, wardrobe, place, light); the look stays as it is.
        const longer = await enhanceSoulWords(words).catch(() => words);
        prompt = prompt.slice(0, at) + longer + prompt.slice(at + words.length);
      } else prompt = await enhancePrompt(prompt, plan.model.kind, plan.op).catch(() => prompt);
      update(id, { prompt });
    }
    // Ideogram 4 reads a JSON caption (src/lib/ideogram-caption.ts): one given as the prompt (a reused run) is kept, plain
    // words get one written. It becomes the run's prompt, as Enhance's rewrite does, so Reuse makes the same picture. A
    // layout's words are never rewritten by the helper: they get the fixed wrapper.
    if (captioned && prompt) {
      update(id, { message: "Writing the caption" });
      const words = prompt;
      prompt =
        parseCaption(words) ??
        (laidOut ? captionFromWords(words) : await ideogramCaption(words, computeDimensions(plan.params.aspectRatio, plan.params.resolution, {})).catch(() => captionFromWords(words)));
      update(id, { prompt });
    }
    // MiniMax H3 on your GPU reads its own layout (src/lib/h3-prompt.ts): the words (after any Enhance) go into it, with the
    // start (and end) frame's alignment line for the clip's length on H3's frame grid. It becomes the run's prompt, so Reuse
    // makes the same clip. An orbit keeps its words as they are: the Orbit LoRA reads its own caption style.
    const h3Op = plan.op === "t2v" || plan.op === "i2v" || plan.op === "flf2v" ? plan.op : undefined;
    const orbit = h3Op === "i2v" && plan.params.extra?.orbit === true;
    if (plan.model.options.promptFormat === "minimax-h3" && h3Op && prompt && !orbit) {
      const wrapped = h3Prompt(prompt, h3Op, h3Frames(plan.params.duration ?? plan.model.defaults?.duration ?? 5), plan.sound?.soundscape, plan.sound?.music);
      if (wrapped !== prompt) {
        prompt = wrapped;
        update(id, { prompt });
      }
    }
    // H3 with references (Pika H3 Flex Ref2VA): the studio's names (Image 1, Clip 1, Voice 1) become H3's tags (<Picture 1>,
    // <Video 1>, <Audio 1>) in the same layout, with no alignment line (src/lib/h3-references.ts).
    // Talk from a voice clip (avatar on H3): the portrait speaks the voice clip, with the words saying how.
    if (plan.model.options.promptFormat === "minimax-h3" && plan.op === "avatar" && !inH3Layout(prompt ?? "")) {
      const wrapped = h3Prompt(h3TalkPrompt(prompt ?? ""), "t2v", h3Frames(plan.params.duration ?? plan.model.defaults?.duration ?? 5), plan.sound?.soundscape ?? "Only the voice of <Audio 1>, clear and close.", plan.sound?.music);
      prompt = wrapped;
      update(id, { prompt });
    } else if (plan.model.options.promptFormat === "minimax-h3" && plan.op === "ref2v" && prompt) {
      const wrapped = h3Prompt(h3ReferenceTags(prompt), "t2v", h3Frames(plan.params.duration ?? plan.model.defaults?.duration ?? 5), plan.sound?.soundscape, plan.sound?.music);
      if (wrapped !== prompt) {
        prompt = wrapped;
        update(id, { prompt });
      }
    }
    // Kandinsky 6.0 (both engines) reads spoken lines and the sound in tags of its own (src/lib/kandinsky-prompt.ts): quoted
    // words and a "Sound:" line become them for this run; the run keeps the words as typed, so Reuse shows them.
    if (plan.model.options.promptFormat === "kandinsky6" && prompt) prompt = kandinskyPrompt(prompt);
    const input: GenInput = {
      ...plan.params,
      // The clip's size is only ever its header's (below): a size the request states (params.sourceSize) prices the run
      // before it starts, never what an upscaler's factor is made from.
      sourceSize: undefined,
      prompt,
      negativePrompt: req.negativePrompt,
      images: (await Promise.all((req.inputs?.images ?? []).map((ref, i) => (i === 0 ? prepCropped(ref) : prep(ref))))).filter(Boolean) as string[],
      endImage: await prep(req.inputs?.endImage),
      mask: await prepMask(req.inputs?.mask),
      video: await prepVideo(req.inputs?.video),
      audio: await (plan.op === "avatar" ? prepVoice : SONG_TOOL_OPS.has(plan.op) ? prepSong : prep)(req.inputs?.audio),
      audio2: await prep(req.inputs?.audio2),
      voiceAudio: await prep(req.inputs?.voiceAudio),
      voiceAudio2: await prep(req.inputs?.voiceAudio2),
      videos: (await Promise.all((req.inputs?.videos ?? []).map((ref, i) => prepClip(ref, i)))).filter(Boolean) as string[],
      audios: (await Promise.all((req.inputs?.audios ?? []).map(prep))).filter(Boolean) as string[],
      model3d: await prep(req.inputs?.model3d),
      loras: plan.loras,
      // Vary seeds across a batch so N jobs don't return N identical results.
      seed: plan.params.seed !== undefined && plan.params.seed >= 0 ? plan.params.seed + index : undefined,
    };
    // A saved voice (Design a voice; src/server/voices.ts): what its clip says makes a closer clone, and a cloud route that
    // speaks with an embedding gets the one fal made from it before, so the clip isn't cloned again.
    const savedVoice = req.account ? null : savedVoiceFor(req.inputs?.voiceAudio);
    if (savedVoice) {
      if (!input.voiceTranscript?.trim() && savedVoice.voice.transcript) input.voiceTranscript = savedVoice.voice.transcript;
      if (route.map?.voiceEmbedding && savedVoice.voice.embedding) input.voiceEmbedding = await prep(savedVoice.voice.embedding);
    }
    // What the caller said about the clip's length wins; the header fills the rest.
    Object.assign(input, { ...source, ...(plan.params.sourceDuration !== undefined && { sourceDuration: plan.params.sourceDuration }) });
    // Extending a song (Mureka): the new part starts at its end (or, before its start, at 0) unless the run says where.
    if (plan.op === "song-extend" && input.startTime === undefined) {
      const head = input.extra?.extend_type === "head";
      if (!head && !(input.sourceDuration && input.sourceDuration > 0)) throw new Error("The song's length couldn't be read: add it again as an MP3, WAV or M4A file");
      input.startTime = head ? 0 : input.sourceDuration;
    }
    // A talking avatar renders as long as its voice: priced for it once its header is read (an API call that didn't say).
    if (plan.op === "avatar" && plan.params.sourceDuration === undefined && input.sourceDuration && providerId !== "mock" && plan.model.engine !== "open") {
      update(id, { cost_usd: estimateCost(plan.model, { ...plan.params, sourceDuration: input.sourceDuration }, 1, plan.op, plan.loras.length > 0 && !!route.loraEndpoint) });
    }
    // A clip edit of a clip sent as it is (Edit video, an API call; the studios that cut clips keep to the windows
    // themselves): one outside the model's window is refused before it's paid for (Happy Horse bills 60 s and returns
    // 15; fal's Wan 2.2 Fun VACE takes at most 241 frames), and one that keeps the clip's length is priced for it once
    // the header is read (a call that didn't say). A route billed by frames is priced on the header's rate as well.
    if (plan.op === "v2v" && input.sourceDuration && !req.chain?.length && req.params?.duration === undefined && providerId !== "mock" && plan.model.engine !== "open") {
      const problem = clipWindowProblem(plan.model, input.sourceDuration, input.sourceFps) ?? (input.sourceSize ? clipSizeProblem(plan.model, input.sourceSize.width, input.sourceSize.height) : null);
      if (problem) throw new Error(problem);
      const byFrames = !!sourceFrames(plan.model.id, plan.model.engine) && source.sourceFps !== undefined && source.sourceFps !== plan.params.sourceFps;
      if ((plan.params.sourceDuration === undefined || byFrames) && clipEditSeconds(plan.model, input, plan.op) !== undefined) {
        update(id, { cost_usd: estimateCost(plan.model, { ...plan.params, sourceDuration: input.sourceDuration, sourceFps: input.sourceFps }, 1, plan.op, plan.loras.length > 0 && !!route.loraEndpoint) });
      }
    }
    // A clip relit, extended or given a new moment, or a voice made into a talking video, held to the hosted model's window once
    // its header is read (fal's H3 Max relight: up to 15 s; insert and Turbo extend: up to 60 s; lip sync: 5 s to 15 min).
    if (input.sourceDuration && !req.chain?.length && providerId !== "mock" && plan.model.engine !== "open") {
      const problem =
        plan.op === "avatar"
          ? voiceWindowProblem(plan.model, input.sourceDuration)
          : plan.op === "relight-video" || plan.op === "extend"
            ? clipWindowProblem(plan.model, input.sourceDuration, input.sourceFps)
            : plan.op === "insert-moment"
              ? (clipWindowProblem(plan.model, input.sourceDuration, input.sourceFps) ?? insertRangeProblem(input.startTime, input.endTime, input.sourceDuration))
              : null;
      if (problem) throw new Error(problem);
      // A relight is billed on the clip's length: priced for it once the header is read (an API call that didn't say).
      if (plan.op === "relight-video" && plan.params.sourceDuration === undefined) update(id, { cost_usd: estimateCost(plan.model, { ...plan.params, sourceDuration: input.sourceDuration }, 1, plan.op) });
    }
    const edits = plan.op === "v2v" || plan.op === "video-swap" || plan.op === "video-insert";
    // An edit whose route sends no length keeps the clip's own (Kling 4.0's edit, swap and insert), whatever the request
    // said: the clip is held to the model's window, sides, shape and frame rate before it's paid for. Frame-billed routes
    // (fal's Wan 2.2 Fun VACE) keep the rule above: their studios cut the pieces and say the length.
    if (edits && !route.map?.duration && !req.chain?.length && providerId !== "mock" && plan.model.engine !== "open" && !sourceFrames(plan.model.id, plan.model.engine)) {
      const problem =
        (input.sourceDuration ? clipWindowProblem(plan.model, input.sourceDuration, input.sourceFps) : null) ??
        (input.sourceSize ? clipSizeProblem(plan.model, input.sourceSize.width, input.sourceSize.height) : null) ??
        (input.sourceFps ? clipFpsProblem(plan.model, input.sourceFps) : null);
      if (problem) throw new Error(problem);
    }
    // Reference clips (and clip elements) billed with the output: refused past the most the model takes in all (with the
    // clip edited), or a clip element outside its own window, before it's paid for, and priced on their seconds once read
    // (the plan priced the least they bill). An edit of a clip whose length the caller didn't say is priced on it (in and
    // out) once its header is read.
    const read = clipLengths.filter((n): n is number => n !== undefined);
    const unpricedEdit = edits && !!input.sourceDuration && plan.params.sourceDuration === undefined;
    if (billsClips && (read.length || unpricedEdit) && providerId !== "mock" && plan.model.engine !== "open") {
      for (const g of plan.params.elements ?? []) {
        const seconds = g.video !== undefined ? clipLengths[g.video] : undefined;
        const problem = seconds !== undefined ? elementClipProblem(plan.model, seconds) : null;
        if (problem) throw new Error(problem);
      }
      const seconds = read.reduce((a, b) => a + b, 0);
      const problem = clipTotalProblem(plan.model, (edits ? (input.sourceDuration ?? 0) : 0) + seconds);
      if (problem) throw new Error(problem);
      if (read.length) input.clipSeconds = seconds;
      const priced = { ...plan.params, ...(input.sourceDuration !== undefined && { sourceDuration: input.sourceDuration }), ...(read.length && { clipSeconds: seconds }) };
      update(id, { cost_usd: estimateCost(plan.model, priced, 1, plan.op) });
    }
    // An upscale that wouldn't enlarge the clip (a 1080p clip at a default 1080p; a 4K clip would even shrink):
    // a tier the model only defaulted to moves up to the next one it offers, one the caller picked is refused.
    // A clip longer than the model takes (Kandinsky VSR: about 5 s) is refused, never cut short; one billed per output frame is
    // priced again on its size and length.
    if (plan.op === "upscale-video") {
      const long = sourceLengthProblem(plan.model, input.sourceDuration);
      if (long) throw new Error(long);
      if (plan.model.pricing?.outputFrames && input.sourceSize && providerId !== "mock" && plan.model.engine !== "open") {
        update(id, { cost_usd: estimateCost(plan.model, { ...plan.params, sourceSize: input.sourceSize, sourceDuration: input.sourceDuration }, 1, plan.op) });
      }
    }
    if (plan.op === "upscale-video" && input.sourceSize) {
      const tier = upscaleTier(input.resolution, plan.model.options.resolutions, input.sourceSize, req.params?.resolution !== undefined);
      if ("error" in tier) throw new Error(tier.error);
      if (tier.resolution !== input.resolution) {
        input.resolution = tier.resolution;
        if (providerId !== "mock" && plan.model.engine !== "open") update(id, { cost_usd: estimateCost(plan.model, { ...plan.params, resolution: tier.resolution }, 1, plan.op) });
      }
      const sides = sideMultipleProblem(plan.model.name, plan.model.options.sideMultiple, plan.model.options.resolutions, input.resolution, input.sourceSize);
      if (sides) throw new Error(sides);
    }
    // LoRA files: ComfyUI gets the ones it lacks downloaded into its loras folder; a cloud run gets a civitai
    // file mirrored once to the provider's storage (the civitai key never leaves this server).
    if (input.loras?.length && (providerId === "fal" || providerId === "replicate")) {
      input.loras = await prepareCloudLoras(input.loras, providerId, (data, name) => adapter.prepareFile(data, "application/octet-stream", name, route), (message) => update(id, { message }));
    } else if (providerId === "comfyui" && !req.account && !computerScope() && (input.loras?.length || graphLoras(route.endpoint, input.extra).length)) {
      // (Not for an account's own ComfyUI, nor one on the owner's computer: the download writes to the install's LoRA folder.)
      // A graph that loads its own LoRAs (Genjutsu's Character swap: the Turbo and swap LoRAs; Restore & colourise: the
      // gated Restore or Detail Refine IC-LoRA) gets them downloaded too.
      await ensureLorasOnComfy([...(input.loras ?? []), ...graphLoras(route.endpoint, input.extra)], await comfyLoraFiles(route), (message) => update(id, { message }));
    }
    const res = await adapter.submit({ generationId: id, model: plan.model, route, input });
    // A saved voice the cloud just cloned keeps the embedding (the owner's runs only), so its next line skips the clone.
    if (typeof res.meta?.voiceEmbedding === "string" && !req.account) void keepVoiceEmbedding(req.inputs?.voiceAudio, res.meta.voiceEmbedding).catch(() => {});
    const now = Date.now();
    const status = statusOf(id);
    if (!status || status === "canceled") {
      // Canceled (or deleted) while it was being handed over: stop the provider's job too.
      await adapter.cancel?.({ externalId: res.externalId, meta: res.meta ?? {}, route, model: plan.model, createdAt: now }).catch(() => {});
      if (status) update(id, { external_id: res.externalId, external_meta_json: JSON.stringify(res.meta ?? {}), message: null });
      return;
    }
    // An account's link: which address the job went to (its name, never the address), so a run whose account moved to
    // another address meanwhile says so instead of asking the new one about it.
    const sentTo = req.account && req.place !== "pool" && providerId === "comfyui" ? ownLink()?.url : undefined;
    db().transaction(() => {
      update(id, {
        external_id: res.externalId,
        external_meta_json: JSON.stringify({ ...(res.meta ?? {}), ...(sentTo && { sentTo: addressKey(sentTo) }) }),
        provider_input_json: res.payload ? JSON.stringify(res.payload).slice(0, 200_000) : null,
        // A run sent again after its GPU lost it says so until its GPU reports on it.
        message: resentRuns().has(id) ? RESENT_WORDS : "Queued",
      });
      recordSubmission(id, now);
    })();
  } catch (e) {
    failed ??= { error: e };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Polling loop

const POLL_MS = 1500;
/** Jobs about to finish (progress ≥ 0.9) are polled this often, so results land sooner. */
const FAST_POLL_MS = 500;
/** How long a job may run once its provider has started it… */
const TIMEOUT_MS = 45 * 60 * 1000;
/** …except on the WorldCast worker (N7-9): 50 steps at CFG 5 on a 14B model, tens of minutes a clip (its time is unpublished). */
const WORLDCAST_TIMEOUT_MS = 3 * 60 * 60 * 1000;
/** …and how long it may wait in the provider's queue first (a busy local GPU works through jobs one by one). */
const QUEUE_TIMEOUT_MS = 4 * 60 * 60 * 1000;
/** A row this old with no external id, that no submit in this process is working on, was cut off by a restart. */
const STALE_SUBMIT_MS = 2 * 60 * 1000;

interface RunnerState {
  timer: NodeJS.Timeout;
  busy: boolean;
  tick: () => Promise<void>;
  fastTimer?: NodeJS.Timeout;
  fastBusy?: boolean;
  fast?: () => Promise<void>;
  /** Rows being polled right now (the fast lane and the tick never poll one row twice at once). */
  polling?: Set<string>;
}

declare global {
  var __fuobeRunner: RunnerState | undefined;
}

/**
 * Run `fn` as the owner's background work: outside a skill check's demo scope and any account's run (its tenant, its ComfyUI, the open-engine settings
 * it runs with). Timers started inside inherit where they were started, so the runner, often first started by a run, is
 * started this way: every tick then polls each row in that row's own context.
 */
export function outsideRuns<T>(fn: () => T): T {
  return outsideDemo(() => outsideTenant(() => outsideOwnGpu(() => withoutCandidates(fn))));
}

/**
 * Start the background runner (once per process; started at boot by src/instrumentation.ts).
 * Also installs the live-update hooks and primes the reachability probes routing reads.
 */
export function ensureRunner(): void {
  outsideRuns(startRunner);
}

function startRunner(): void {
  watchGenerations(db());
  const cur = globalThis.__fuobeRunner;
  if (cur) {
    // After a dev hot-reload, point the existing timers at this module's (fresh) code.
    cur.tick = tick;
    cur.fast = fastTick;
    cur.polling ??= new Set();
    if (!cur.fastTimer) {
      cur.fastTimer = setInterval(() => void globalThis.__fuobeRunner?.fast?.(), FAST_POLL_MS);
      cur.fastTimer.unref?.();
    }
    return;
  }
  const state: RunnerState = {
    busy: false,
    tick,
    fast: fastTick,
    polling: new Set(),
    timer: setInterval(() => void globalThis.__fuobeRunner?.tick(), POLL_MS),
    fastTimer: setInterval(() => void globalThis.__fuobeRunner?.fast?.(), FAST_POLL_MS),
  };
  state.timer.unref?.();
  state.fastTimer?.unref?.();
  globalThis.__fuobeRunner = state;
  void probeComfy().catch(() => false);
  void probeLocal().catch(() => false);
  sweepInterrupted();
  resumeTurntables();
}

/** Jobs that never got an external id (the server died mid-submit) can't be recovered. Runs every tick. */
function sweepInterrupted(): void {
  const rows = db()
    .prepare("SELECT id FROM generations WHERE status IN ('queued','running') AND external_id IS NULL AND depends_on IS NULL AND created_at < ?")
    .all(Date.now() - STALE_SUBMIT_MS) as Pick<Row, "id">[];
  const busy = submitting();
  for (const r of rows) {
    if (busy.has(r.id)) continue;
    update(r.id, { status: "failed", error: "This run stopped before it started. Press Retry.", completed_at: Date.now(), message: null });
  }
}

async function pollGuarded(r: Row): Promise<void> {
  const polling = (globalThis.__fuobeRunner!.polling ??= new Set());
  if (polling.has(r.id)) return;
  polling.add(r.id);
  try {
    const account = accountOf(r);
    // Whose run it is can't be read: never polled as the owner's (with the owner's keys).
    if (account === UNREADABLE) {
      update(r.id, { status: "failed", error: "This run's details can't be read, so it was stopped.", completed_at: Date.now(), message: null });
      return;
    }
    const onPool = account ? poolOf(r) : false;
    const own = account && !onPool ? accountRun(account, r.provider, "poll") : undefined;
    if (onPool) await runOnPool(account!, () => pollOne(r));
    else if (own && "error" in own) update(r.id, { status: "failed", error: own.error, completed_at: Date.now(), message: null });
    else if (own) await own.run(() => pollOne(r));
    else await pollOne(r);
  } catch (e) {
    console.warn(`[generations] ${r.id}: ${(e as Error).message}`);
  } finally {
    polling.delete(r.id);
  }
}

/**
 * The jobs one tick polls (100 at most): the owner's first, then every account's in turn (each account's oldest job,
 * then each one's second, and so on), so one account's long queue never hides another account's jobs.
 */
export function rowsToPoll(limit = 100): Row[] {
  return db()
    .prepare(
      `SELECT g.* FROM generations g
       JOIN (SELECT id, ROW_NUMBER() OVER (PARTITION BY json_extract(request_json, '$.account') ORDER BY created_at) AS turn
             FROM generations WHERE status IN ('queued','running') AND external_id IS NOT NULL AND stage IS NULL) t ON t.id = g.id
       ORDER BY ${ACCOUNT_LAST.replace("request_json", "g.request_json")}, t.turn, g.created_at ASC LIMIT ?`,
    )
    .all(limit) as Row[];
}

async function tick(): Promise<void> {
  const state = globalThis.__fuobeRunner;
  if (!state || state.busy) return;
  state.busy = true;
  try {
    sweepInterrupted();
    // The owner's jobs first, then the accounts' in turn. An account's ComfyUI may be slow to answer: its polls run on
    // their own, so they never hold up the owner's (pollGuarded never polls one row twice at once).
    const active = rowsToPoll();
    for (const r of active) if (accountOf(r)) void pollGuarded(r);
    await Promise.all([...active.filter((r) => !accountOf(r)).map(pollGuarded), pollTrainings().catch(() => {}), advanceDependents().catch(() => {})]);
    // The optional services (billing.ts, moderation.ts): outputs waiting for their check, then reports for the billing
    // service. Neither does anything while no service is set.
    if (moderationConfigured()) await sweepOutputChecks();
    void sweepBilling();
  } finally {
    state.busy = false;
  }
}

async function fastTick(): Promise<void> {
  const state = globalThis.__fuobeRunner;
  if (!state || state.fastBusy) return;
  state.fastBusy = true;
  try {
    const rows = db()
      .prepare(
        `SELECT g.*, r.started_at AS run_started_at FROM generations g LEFT JOIN generation_runs r ON r.id = g.id WHERE g.status = 'running' AND g.external_id IS NOT NULL AND g.progress IS NOT NULL AND g.stage IS NULL ORDER BY ${ACCOUNT_LAST.replace("request_json", "g.request_json")}, g.created_at ASC LIMIT 50`,
      )
      .all() as (Row & { run_started_at: number | null })[];
    const now = Date.now();
    // At 90% (or on course to be there by now, at the pace it has reported since it started).
    const nearlyDone = rows.filter((r) => {
      const p = r.progress ?? 0;
      if (p >= 0.9) return true;
      const ran = r.run_started_at ? r.updated_at - r.run_started_at : 0;
      return ran > 0 && p > 0 && (p * (now - r.run_started_at!)) / ran >= 0.9;
    });
    const soon = nearlyDone.slice(0, 20);
    for (const r of soon) if (accountOf(r)) void pollGuarded(r);
    await Promise.all(soon.filter((r) => !accountOf(r)).map(pollGuarded));
  } finally {
    state.fastBusy = false;
  }
}

/** Order by: the owner's rows (no account in the request) before accounts'. */
const ACCOUNT_LAST = "(json_extract(request_json, '$.account') IS NOT NULL)";

function runRoute(model: NonNullable<ReturnType<typeof getModel>>, r: Pick<Row, "op" | "provider">): ModelRoute {
  return model.routes.find((x) => x.op === r.op && (x.provider === r.provider || r.provider === "mock")) ?? model.routes[0];
}

function pollContext(r: Row, model: NonNullable<ReturnType<typeof getModel>>): PollContext {
  return { externalId: r.external_id!, meta: JSON.parse(r.external_meta_json ?? "{}") as Record<string, unknown>, route: runRoute(model, r), model, createdAt: r.created_at };
}

async function pollOne(r: Row): Promise<void> {
  const model = getModel(r.model_id);
  if (!model) {
    // A job on a model Fuobe retired with its provider (replaced.ts) can't be collected: Reuse runs it on the replacement.
    const retired = !!replacedBy(r.model_id) || !Object.hasOwn(PROVIDERS, r.provider);
    update(r.id, { status: "failed", error: retired ? RETIRED_PROVIDER_ERROR : "This model isn't available any more. Pick another.", completed_at: Date.now(), message: null });
    return;
  }
  // The clock runs from when the provider got the job (and from when it started it), not from creation:
  // a chained step created at the start of a long pipeline gets its full time once it's submitted.
  const now = Date.now();
  let run = db().prepare("SELECT submitted_at, started_at FROM generation_runs WHERE id = ?").get(r.id) as { submitted_at: number; started_at: number | null } | undefined;
  if (!run) {
    // Submitted before this was recorded (an upgrade mid-job): start counting now.
    recordSubmission(r.id, now);
    run = { submitted_at: now, started_at: null };
  }
  const ctx = pollContext(r, model);
  // Its outputs are saved and the 3D finish runs (or ran until a restart): nothing more to ask the provider.
  if (ctx.meta.finishing) return resumeFinish(r);
  // Poll first: a job that finished while the server was asleep or down is collected, not timed out.
  let res: PollResult | undefined;
  let pollError: unknown;
  const account = accountOf(r);
  // An account's own GPU or key (not this install's GPUs): its polls heal (healPoll), and its failures say what helps.
  const own = account && !poolOf(r) ? account : undefined;
  if (own && r.provider === "comfyui" && typeof ctx.meta.sentTo === "string") {
    // Sent to a link the account has since replaced with another: the new one knows nothing of it.
    const now = gpuLink(accountGpu(own));
    if (now && addressKey(now.url) !== ctx.meta.sentTo) {
      pollHeals().delete(r.id);
      return failRun(r.id, new Error("moved"), diagnoseGpuJob({ kind: "moved" }, { kind: "link", url: now.url }), own);
    }
  }
  // A poll that failed a moment ago waits its turn (a growing wait), instead of asking every 1.5 s.
  const healing = own ? pollHeals().get(r.id) : undefined;
  if (healing && Date.now() < healing.next) return;
  try {
    res = await adapterFor(r.provider, account).poll(ctx);
  } catch (e) {
    pollError = e;
  }
  if (own && pollError && (await healPoll(r, ctx, own, pollError))) {
    if (statusOf(r.id) !== "queued" && statusOf(r.id) !== "running") return;
  } else if (own && !pollError) pollHeals().delete(r.id);
  // An account's job waits at most 30 minutes in its own ComfyUI's queue (or its provider's).
  const stored = JSON.parse(r.request_json) as GenerationRequest;
  const onPool = !!account && stored.place === "pool";
  // On this install's GPUs: the wait the billing service set for the run, else FUOBE_POOL_WAIT_MIN.
  const queueMs = onPool ? poolWaitMs(stored.waitMs) : account ? ACCOUNT_LIMITS.queueMs : QUEUE_TIMEOUT_MS;
  if (!res || res.state === "queued" || res.state === "running") {
    // A job on someone's own computer reached their ComfyUI later than it was handed over (it waited for their tab): its
    // queue clock starts then.
    if (res?.sentAt && res.sentAt > run.submitted_at) {
      recordSubmission(r.id, res.sentAt);
      run = { submitted_at: res.sentAt, started_at: null };
    }
    // A job that has just left the queue gets its full running time from now.
    const startsNow = res?.state === "running" && !run.started_at;
    const runMs = r.provider === "worldcast" ? WORLDCAST_TIMEOUT_MS : TIMEOUT_MS;
    const overdue = run.started_at ? now - run.started_at > runMs : !startsNow && now - run.submitted_at > queueMs;
    if (overdue) {
      // Stop the provider's job too, so it doesn't keep rendering (or billing) for nothing.
      await adapterFor(r.provider, account)
        .cancel?.(ctx)
        .catch(() => {});
      update(r.id, {
        status: "failed",
        error: run.started_at
          ? `Timed out after ${runMs / 60_000} minutes`
          : res?.state === "queued" && res.timeoutError
            ? res.timeoutError
            : onPool
              ? POOL_WAITED
              : account
                ? `This waited over ${queueMs / 60_000} minutes to start. Press Retry.`
              : "This took too long to start. Press Retry.",
        completed_at: now,
        message: null,
      });
      return;
    }
    if (!res) {
      // An account's poll that healPoll took (waiting with a growing wait): nothing more to do this turn.
      if (own && pollHeals().has(r.id)) return;
      throw pollError;
    }
    if (startsNow) db().prepare("UPDATE generation_runs SET started_at = ? WHERE id = ?").run(Date.now(), r.id);
    update(r.id, { status: res.state, progress: res.progress ?? r.progress, message: res.message ?? null });
    return;
  }
  if (res.state === "failed") {
    // Its GPU restarted and lost the job: an account's run is sent again once, as a computer's tab does.
    if (own && res.lost && resend(r, own, RESENT_WORDS)) return;
    // An account's run: its own GPU's words (comfyui.ts), or its key's provider's read plainly; the provider's own words
    // go in the details line. The owner's runs keep the provider's words.
    const trouble =
      res.trouble ??
      (own && isCloudProvider(r.provider)
        ? diagnoseKey(
            { stage: "poll", failed: true, text: res.error, canceled: r.provider === "replicate" && /^(canceled|aborted)$/i.test(res.error.trim()) },
            { provider: r.provider, other: otherKeyFor(own, r.provider, r.model_id) },
          )
        : undefined);
    // What the GPU was missing (a model, a node class): the tile offers "Fix it", and the GPU's check counts as stale.
    const kept = keptFix(res.fix, own ? trouble : undefined);
    update(r.id, { status: "failed", error: (own && trouble?.words) || res.error, completed_at: Date.now(), message: null, ...(kept && { fix_json: kept }) });
    if (res.fix) markStale(account ? `acct:${account}` : "install");
    return;
  }
  // The Watermark Remover gave the original back (no clean repair was possible): no new result, the run says what to try.
  if (r.op === "watermark-remove" && (res.outputs as RichOutput[]).some((o) => rejectedRepair(o.meta?.quality as WatermarkQuality | undefined))) {
    update(r.id, { status: "failed", error: WATERMARK_COPY.rejected, completed_at: Date.now(), message: null });
    return;
  }
  // A Watermark Remover scan with no report the page can read fails in words (never a page that waits for marks forever).
  if (r.op === "watermark-scan" && !(res.outputs as RichOutput[]).some((o) => parseScanReport(o.text))) {
    update(r.id, { status: "failed", error: WATERMARK_COPY.scanFailed, completed_at: Date.now(), message: null });
    return;
  }
  // A Watermark Remover result keeps how it was asked, next to the repair's verdict: the marks removed (as checked) and how.
  if (r.op === "watermark-remove") {
    const req = JSON.parse(r.request_json) as GenerationRequest;
    const asked = req.params?.extra?.boxes;
    const mode = req.inputs?.mask ? "manual_mask" : asked !== undefined ? "manual_boxes" : "auto_qwen";
    let marks: unknown[] | undefined;
    try {
      marks = mode === "manual_boxes" ? (JSON.parse(checkWatermarkBoxes(asked).json) as { boxes: unknown[] }).boxes : undefined;
    } catch {
      marks = undefined;
    }
    res = { ...res, outputs: (res.outputs as RichOutput[]).map((o) => (o.kind === "image" ? { ...o, meta: { ...o.meta, watermark: { mode, ...(marks && { marks }) } } } : o)) };
  }
  // Mark first so a slow download isn't polled twice.
  update(r.id, { status: "running", progress: 0.99, message: "Saving results" });
  const outputs: OutputFile[] = [];
  // An account's job keeps at most 16 outputs, and a result it can't save fails the job (never a link to its ComfyUI).
  const dropped = account && res.outputs.length > ACCOUNT_LIMITS.outputsPerJob ? res.outputs.length - ACCOUNT_LIMITS.outputsPerJob : 0;
  if (dropped) res = { ...res, outputs: res.outputs.slice(0, ACCOUNT_LIMITS.outputsPerJob) };
  // Remove background: of a cut-out and its mask (BiRefNet's answer), the one asked for (params.matteOutput).
  const matte = r.op === "bg-remove-video" ? (JSON.parse(r.request_json) as GenerationRequest).params?.matteOutput : undefined;
  // The face mosaic's cloud step answers with the faces' masks: the result is the picture, pixelated under them.
  const faceMasks = r.op === "face-mosaic" && res.outputs.length > 0 && (res.outputs as RichOutput[]).every((o) => o.meta?.role === "mask" && Array.isArray(o.meta.masks));
  if (faceMasks) {
    try {
      outputs.push(await mosaicOutput(r, res.outputs as RichOutput[]));
    } catch (e) {
      update(r.id, { status: "failed", error: (e as Error).message, completed_at: Date.now(), message: null });
      return;
    }
  } else {
    for (const o of keepMatte(res.outputs as RichOutput[], matte)) {
      try {
        // An account's own GPU or key: a copy that breaks off is tried again a few times (the result is made, and paid).
        outputs.push(await (own ? persistWithRetry(o, r.id) : persistOutput(o, r.id)));
      } catch (e) {
        if (account) {
          for (const kept of outputs) if (kept.assetId) deleteAsset(kept.assetId);
          // Stems unpacked to the scratch folder and not saved go now, not at the next sweep.
          for (const rest of res.outputs as RichOutput[]) {
            const left = rest.url ? scratchOutputFile(rest.url) : null;
            if (left) fs.rmSync(left, { force: true });
          }
          // Its own GPU or key: why, and what helps (a file over the cap, an expired link, a GPU that went away).
          const trouble = own && !(e instanceof AccountFilesFull) ? saveTrouble(e, r.provider) : undefined;
          const why = e instanceof AccountFilesFull ? e.message : (trouble?.words ?? "We couldn't save this result. Press Retry.");
          const kept = keptFix(undefined, trouble);
          update(r.id, { status: "failed", error: why, completed_at: Date.now(), message: null, ...(kept && { fix_json: kept }) });
          return;
        }
        outputs.push({ url: o.url, kind: o.kind ?? r.kind, ...inlineText(o.text, o.meta), ...(o.draftId ? { draftId: o.draftId } : {}) });
        console.warn(`[fuobe] could not save output for ${r.id}: ${(e as Error).message}`);
      }
    }
  }
  // Ideogram 4's grey "blocked by safety filter" card is no picture (src/server/safety-card.ts): it is deleted, and a run
  // left with nothing else fails, saying what to try.
  if (model.options.promptFormat === "ideogram4") {
    const cards = new Set<OutputFile>();
    for (const o of outputs) {
      const png = o.kind === "image" && o.assetId ? await readRef(o.url).catch(() => null) : null;
      if (png && looksBlocked(png.data)) cards.add(o);
    }
    for (const o of cards) deleteAsset(o.assetId!);
    if (cards.size && cards.size === outputs.length) {
      update(r.id, { status: "failed", error: BLOCKED_CARD_MESSAGE, completed_at: Date.now(), message: null });
      return;
    }
    if (cards.size) outputs.splice(0, outputs.length, ...outputs.filter((o) => !cards.has(o)));
  }
  // Any Angle's 3D view: its front view is measured on the turntable it rendered, and kept on the splat (meta.front).
  if (r.model_id === ANY_ANGLE.buildModel) {
    const measured = await withFrontView(JSON.parse(r.request_json) as GenerationRequest, outputs);
    if (!measured) {
      // Nothing of a failed build is kept, the owner's included.
      for (const kept of outputs) if (kept.assetId) deleteAsset(kept.assetId);
      update(r.id, { status: "failed", error: NO_SUBJECT_MESSAGE, completed_at: Date.now(), message: null });
      return;
    }
    outputs.splice(0, outputs.length, ...measured);
  }
  // Fuobe Soul: what follows in the browser (the look's grade, an overlay, Soul Cinema's 21:9 crop), on each image;
  // API clients read it as meta.
  // A storyboard frame with a look gets the look's finish whatever model made it (a 21:9 board is cropped after).
  const board = (JSON.parse(r.request_json) as GenerationRequest).frame;
  const boardPost = board?.look ? soulPostSteps(SOUL_MODELS.soul, board.look) : undefined;
  const post = boardPost ? { ...boardPost, ...(board?.crop && { crop: board.crop }) } : soulPostSteps(r.model_id, r.preset_id, soulKind(r.model_id) ? requestAspect(r.request_json) : undefined);
  if (post) for (const [i, o] of outputs.entries()) if (o.kind === "image") outputs[i] = { ...o, meta: { ...o.meta, ...post } };
  // Fuobe DoP's colour-grade effects: the grade the browser applies to the clip (the result's "Apply the grade" step).
  const grade = isDop(r.model_id) && r.preset_id ? getPreset(r.preset_id)?.grade : undefined;
  if (grade) for (const [i, o] of outputs.entries()) if (o.kind === "video") outputs[i] = { ...o, meta: { ...o.meta, grade } };
  // An image-to-3D GLB from ComfyUI gets the server's finish first (the web GLB, seconds): the outputs are
  // stored now and the row stays running until it's done, so a restart resumes it from them. The turntable
  // is rendered after the job has succeeded (src/server/model3d-finish.ts).
  if (modelToFinish(r, outputs) >= 0) {
    update(r.id, { outputs_json: JSON.stringify(outputs), external_meta_json: JSON.stringify({ ...ctx.meta, finishing: true }), message: "Finishing the 3D model" });
    resumeFinish({ ...r, outputs_json: JSON.stringify(outputs) });
    return;
  }
  // The moderation service asked to see this run's outputs first: they are held, and the row waits ("Checking").
  if (stored.checkOutputs && moderationConfigured()) {
    holdForCheck(r.id, outputs);
    return;
  }
  update(r.id, {
    status: "succeeded",
    outputs_json: JSON.stringify(outputs),
    progress: 1,
    message: dropped ? `Kept ${ACCOUNT_LIMITS.outputsPerJob} of ${ACCOUNT_LIMITS.outputsPerJob + dropped} results` : null,
    completed_at: Date.now(),
  });
}

/** Start (or keep running) the 3D finish of a job whose outputs are stored; it marks the job done when it ends. */
function resumeFinish(r: Row): void {
  const outputs = JSON.parse(r.outputs_json || "[]") as OutputFile[];
  // An account's model: one account finish at a time, and no turntable on the server (its browser records one).
  const account = accountOf(r);
  startModelFinish(r.id, outputs, {
    op: r.op,
    provider: r.provider,
    account,
    onMessage: (message) => update(r.id, { message }),
    done: (finished) => {
      const now = db().prepare("SELECT status, external_meta_json FROM generations WHERE id = ?").get(r.id) as Pick<Row, "status" | "external_meta_json"> | undefined;
      // Canceled or deleted meanwhile: leave it be.
      if (!now || now.status !== "running") return;
      const meta = JSON.parse(now.external_meta_json ?? "{}") as Record<string, unknown>;
      delete meta.finishing;
      update(r.id, { status: "succeeded", outputs_json: JSON.stringify(finished), external_meta_json: JSON.stringify(meta), progress: 1, message: null, completed_at: Date.now() });
      // The model can be opened and downloaded now; its turntable is rendered after and added to the result.
      if (!account) startTurntable(r.id, outputStore(r.id));
    },
  });
}

/** A finished job's outputs, for the turntable render that adds to them later. */
function outputStore(id: string): OutputStore {
  return {
    read: () => {
      const row = db().prepare("SELECT outputs_json FROM generations WHERE id = ?").get(id) as Pick<Row, "outputs_json"> | undefined;
      return row ? (JSON.parse(row.outputs_json || "[]") as OutputFile[]) : null;
    },
    write: (outputs) => update(id, { outputs_json: JSON.stringify(outputs) }),
  };
}

/** Turntables the server stopped before rendering (meta.finish.turntable queued or rendering): render them now. */
function resumeTurntables(): void {
  const rows = db()
    .prepare(
      `SELECT id FROM generations WHERE status = 'succeeded' AND op = 'image-to-3d' AND provider = 'comfyui' AND (outputs_json LIKE '%"turntable":"queued"%' OR outputs_json LIKE '%"turntable":"rendering"%') ORDER BY created_at ASC`,
    )
    .all() as Pick<Row, "id">[];
  for (const r of rows) startTurntable(r.id, outputStore(r.id));
}

/**
 * The face mosaic's cloud step (fal's SAM 3.1 answered with the faces' masks): the picture it looked at, pixelated under
 * every mask, made here when the picture and the masks are PNGs (fal's Soul pictures are), so the Library, share links,
 * Canvas and API clients get the finished picture. A picture the server can't decode is kept as it is with the masks
 * (meta.mosaic) for the browser to pixelate (src/components/studio/soul-finish.ts). No face found: the picture as it is, as
 * the GPU graph returns it. The masks are kept as files of the generation (meta.masks).
 */
async function mosaicOutput(r: Row, given: RichOutput[]): Promise<OutputFile> {
  const req = JSON.parse(r.request_json) as GenerationRequest;
  const source = req.inputs?.images?.[0];
  if (!source) throw new Error("The face mosaic has no picture to pixelate");
  const asked = req.params?.extra?.mosaicScale;
  const scale = typeof asked === "number" && asked > 0 && asked < 1 ? asked : MOSAIC_SCALE;
  const links = given.flatMap((o) => (o.meta?.masks as unknown[]).filter((u): u is string => typeof u === "string" && !!u));
  const masks: string[] = [];
  for (const [i, url] of [...new Set(links)].entries()) masks.push(String(await keepLink(url, `mask-${i}`, r.id)));
  const picture = await readRef(source);
  let data = picture.data;
  let contentType = picture.contentType;
  let done = !masks.length;
  if (masks.length) {
    try {
      const img = decodePng(picture.data);
      const layers = await Promise.all(masks.map(async (m) => decodePng((await readRef(m)).data)));
      if (layers.some((l) => l.width !== img.width || l.height !== img.height)) throw new Error("The masks aren't the picture's size");
      const view = (b: Buffer) => new Uint8ClampedArray(b.buffer, b.byteOffset, b.byteLength);
      mosaicPixels(view(img.data), unionMasks(layers.map((l) => view(l.data))), img.width, img.height, scale);
      data = encodePng(img);
      contentType = "image/png";
      done = true;
    } catch (e) {
      console.warn(`[fuobe] face mosaic ${r.id} is left to the browser: ${(e as Error).message}`);
    }
  }
  const asset = saveFile({ data, contentType, source: "generation", generationId: r.id });
  return {
    url: asset.url,
    kind: "image",
    contentType: asset.contentType,
    assetId: asset.id,
    meta: { masks, faces: masks.length, ...(!done && { mosaic: { source: asset.url, masks, scale } }) },
  };
}

/** Outputs may carry text (transcripts, translations, scripts) and structured extras (layer boxes, cues, stems). */
type RichOutput = RemoteOutput & { text?: string; meta?: Record<string, unknown> };

/**
 * Text kept inline on the generation. Every list page and live event carries it, so longer text
 * (long transcripts, scripts) is cut there, marked `meta.truncated`, and read in full from its file.
 */
export const MAX_INLINE_TEXT = 64_000;

function inlineText(text: string | undefined, meta: Record<string, unknown> | undefined): Pick<OutputFile, "text" | "meta"> {
  if (text === undefined) return meta ? { meta } : {};
  if (text.length <= MAX_INLINE_TEXT) return { text, ...(meta && { meta }) };
  return { text: text.slice(0, MAX_INLINE_TEXT), meta: { ...meta, truncated: true } };
}

/**
 * Extra files a result carries as links are kept too, so the Library never depends on a provider's expiring URL:
 * meta.artifacts (LTX HDR's EXR zip, Higgsfield's fbx / zip), meta.formats (a 3D model's other formats, a rig's FBX
 * and its walk and run cycles, SAM 3D's splat) and meta.preview (a 3D model's render, the cut-out a splat was
 * made from). Links are streamed to disk (an EXR zip runs to gigabytes); one that can't be fetched stays as it
 * was (the result's actions still offer it). A link to the main file itself (`main`) is left for persistOutput.
 */
export async function persistArtifacts(meta: Record<string, unknown> | undefined, generationId: string, main?: string): Promise<Record<string, unknown> | undefined> {
  if (!meta) return meta;
  let out = meta;
  for (const key of LINK_MAPS) {
    const links = meta[key];
    if (!links || typeof links !== "object" || Array.isArray(links)) continue;
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(links as Record<string, unknown>)) kept[k] = v === main ? v : await keepLink(v, key === "artifacts" ? k : `${key}-${k}`, generationId);
    out = { ...out, [key]: kept };
  }
  for (const key of LINKS) if (typeof meta[key] === "string" && meta[key] !== main) out = { ...out, [key]: await keepLink(meta[key], key, generationId) };
  return out;
}

/** Maps of extra files by name, and single extra files, that a result links to (see persistArtifacts). */
const LINK_MAPS = ["artifacts", "formats"] as const;
const LINKS = ["preview"] as const;

/** A provider's link stored as a file of the generation (its local URL), or the link as it was when it can't be fetched. */
async function keepLink(v: unknown, label: string, generationId: string): Promise<unknown> {
  if (typeof v !== "string" || !/^(https?:|data:)/.test(v)) return v;
  try {
    if (v.startsWith("data:")) {
      const f = await readRef(v);
      return saveFile({ data: f.data, contentType: f.contentType, source: "generation", generationId }).url;
    }
    const dest = path.join(scratchDir(), `${generationId}-${label}-${nanoid(6)}`);
    // An account's run: 1 GB at most, and never this machine or its networks.
    const res = await fetchRemoteToFile(v, dest, tenantAccount() ? { maxBytes: ACCOUNT_LIMITS_FILE_BYTES, blocked: blockedForAccounts } : {});
    const name = new URL(res.url).pathname.split("/").pop() || undefined;
    const header = res.contentType && res.contentType !== "application/octet-stream" ? res.contentType : null;
    return adoptFile({ from: dest, contentType: header ?? contentTypeFor(name ?? "", "application/octet-stream"), name, source: "generation", generationId }).url;
  } catch (e) {
    console.warn(`[fuobe] could not keep the ${label} file of ${generationId}: ${(e as Error).message}`);
    return v;
  }
}

/** The extra links that pointed at the main file point at its stored copy. */
function relinkMain(meta: Record<string, unknown> | undefined, from: string, to: string): Record<string, unknown> | undefined {
  if (!meta || !from) return meta;
  let out = meta;
  for (const key of LINK_MAPS) {
    const links = meta[key];
    if (!links || typeof links !== "object" || Array.isArray(links) || !Object.values(links).includes(from)) continue;
    out = { ...out, [key]: Object.fromEntries(Object.entries(links as Record<string, unknown>).map(([k, v]) => [k, v === from ? to : v])) };
  }
  for (const key of LINKS) if (meta[key] === from) out = { ...out, [key]: to };
  return out;
}

/** The most one file of an account's run may weigh (a result, or a file it links to). */
const ACCOUNT_LIMITS_FILE_BYTES = 2 ** 30;

/** An account's files are full (accountTotalBytes): the job fails with this message. */
class AccountFilesFull extends Error {}

/** Types an account's result is stored as; any other is stored as application/octet-stream (.bin), never served as a page. */
const ACCOUNT_OUTPUT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/flac",
  "audio/mp4",
  "audio/aac",
  "audio/webm",
  "model/gltf-binary",
  "text/plain",
  "application/x-subrip",
  "text/vtt",
]);

const accountType = (t: string) => {
  const bare = t.split(";")[0].trim().toLowerCase();
  return ACCOUNT_OUTPUT_TYPES.has(bare) ? bare : "application/octet-stream";
};

/** Before an account's file is kept: refuse it (and remove `file`, when given) when its files would pass its total (3 GB; 1 GB while new). */
function roomFor(account: string, bytes: number, file?: string): void {
  if (accountUsage(account).total + bytes <= accountTotalBytes(account)) return;
  if (file) fs.rmSync(file, { force: true });
  throw new AccountFilesFull(filesFullMessage(account));
}

/**
 * An account's result from its own ComfyUI: streamed to disk (1 GB at most, outputFetch, and never more than its files
 * have room for), checked against its storage, stored as a type from the allowlist. Nothing is fetched while the
 * server is short of space. A download that fails leaves no file behind.
 */
async function persistAccountOutput(o: RichOutput, generationId: string, account: string, linked: Record<string, unknown> | undefined): Promise<OutputFile> {
  const left = accountTotalBytes(account) - accountUsage(account).total;
  if (left <= 0) throw new AccountFilesFull(filesFullMessage(account));
  if (!diskHasRoom()) throw new Error(ACCOUNT_MESSAGES.diskLow);
  const quotaCapped = left < OWN_OUTPUT_LIMITS.maxBytes;
  // A result over what the account has room for says so, not the size of one answer.
  const full = (e: unknown) => (quotaCapped && e instanceof RemoteFetchError && /^The answer was over/.test(e.message) ? new AccountFilesFull(filesFullMessage(account)) : e);
  let res: Response;
  try {
    res = await outputFetch(o.url, { headers: o.headers }, { maxBytes: left });
  } catch (e) {
    throw full(e);
  }
  if (!res.ok || !res.body) {
    discardBody(res);
    throw new Error(`download ${res.status}`);
  }
  const dest = path.join(scratchDir(), `${generationId}-out-${nanoid(8)}`);
  try {
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>), fs.createWriteStream(dest));
  } catch (e) {
    fs.rmSync(dest, { force: true });
    throw full(e);
  }
  roomFor(account, fs.statSync(dest).size, dest);
  const header = res.headers.get("content-type")?.split(";")[0];
  const given = o.contentType ?? (header && header !== "application/octet-stream" ? header : contentTypeFor(new URL(o.url).searchParams.get("filename") ?? o.url));
  const asset = adoptFile({ from: dest, contentType: accountType(given), source: "generation", generationId, accountId: account });
  const meta = relinkMain(linked, o.url, asset.url);
  const text = o.text ?? (asset.kind === "text" && asset.size <= MAX_INLINE_TEXT * 4 ? fs.readFileSync(absolutePath(asset.relPath), "utf8") : undefined);
  return {
    url: asset.url,
    kind: asset.contentType === "application/octet-stream" ? (o.kind ?? asset.kind) : asset.kind,
    contentType: asset.contentType,
    assetId: asset.id,
    ...inlineText(text, meta),
    ...(o.draftId ? { draftId: o.draftId } : {}),
  };
}

/** A result the provider already wrote to the scratch folder (a song's stems): the file, as the type the provider gave. */
function scratchOutput(o: RichOutput): { path: string; contentType?: string } | null {
  const file = scratchOutputFile(o.url);
  return file ? { path: file, contentType: o.contentType } : null;
}

/**
 * A result a computer sent in (its task received and checked it, src/server/computer), or one the provider wrote to the
 * scratch folder: moved into the files folder as it is, no second copy, as the type its bytes said. An account's counts
 * against its files first (a result over its room is removed).
 */
async function persistRelayOutput(o: RichOutput, generationId: string, account: string | undefined, linked: Record<string, unknown> | undefined): Promise<OutputFile> {
  const file = o.url.startsWith("scratch:") ? scratchOutput(o) : relayFile(o.url);
  if (!file) throw new Error("The result isn't here any more");
  const from = file.path;
  const contentType = o.contentType ?? file.contentType ?? "application/octet-stream";
  const size = fs.statSync(from).size;
  if (account) roomFor(account, size, o.url.startsWith("scratch:") ? from : undefined);
  const asset = adoptFile({ from, contentType: account ? accountType(contentType) : contentType, source: "generation", generationId, ...(account && { accountId: account }) });
  const meta = relinkMain(linked, o.url, asset.url);
  const text = o.text ?? (asset.kind === "text" && asset.size <= MAX_INLINE_TEXT * 4 ? fs.readFileSync(absolutePath(asset.relPath), "utf8") : undefined);
  return {
    url: asset.url,
    kind: asset.contentType === "application/octet-stream" ? (o.kind ?? asset.kind) : asset.kind,
    contentType: asset.contentType,
    assetId: asset.id,
    ...inlineText(text, meta),
    ...(o.draftId ? { draftId: o.draftId } : {}),
  };
}

async function persistOutput(o: RichOutput, generationId: string): Promise<OutputFile> {
  const linked = await persistArtifacts(o.meta, generationId, o.url);
  const account = tenantAccount();
  if (o.url?.startsWith("relay:") || o.url?.startsWith("scratch:")) return persistRelayOutput(o, generationId, account, linked);
  if (account && o.url && /^https?:\/\//.test(o.url)) return persistAccountOutput(o, generationId, account, linked);
  let data: Buffer;
  let contentType = o.contentType;
  if (!o.url && o.text !== undefined) {
    data = Buffer.from(o.text);
    contentType ??= "text/plain";
  } else if (o.url.startsWith("sample:")) {
    const file = path.join(process.cwd(), "public", "samples", path.basename(o.url.slice(7)));
    data = fs.readFileSync(file);
    contentType ??= contentTypeFor(file);
  } else if (o.url.startsWith("data:")) {
    const f = await readRef(o.url);
    data = f.data;
    contentType ??= f.contentType;
  } else {
    const res = await outputFetch(o.url, { headers: o.headers });
    if (!res.ok) throw new Error(`download ${res.status}`);
    data = Buffer.from(await res.arrayBuffer());
    const header = res.headers.get("content-type")?.split(";")[0];
    contentType ??= header && header !== "application/octet-stream" ? header : contentTypeFor(new URL(o.url).searchParams.get("filename") ?? o.url);
  }
  if (account) {
    roomFor(account, data.length);
    contentType = accountType(contentType!);
  }
  const asset = saveFile({ data, contentType: contentType!, source: "generation", generationId });
  const meta = relinkMain(linked, o.url, asset.url);
  // A text file's words travel with the generation, so feeds and the next chained step can use them.
  const text = o.text ?? (asset.kind === "text" ? data.toString("utf8") : undefined);
  return {
    url: asset.url,
    kind: asset.kind,
    contentType: asset.contentType,
    assetId: asset.id,
    ...inlineText(text, meta),
    ...(o.draftId ? { draftId: o.draftId } : {}),
  };
}

export async function cancelGeneration(id: string): Promise<void> {
  const r = db().prepare("SELECT * FROM generations WHERE id = ?").get(id) as Row | undefined;
  if (!r || (r.status !== "queued" && r.status !== "running")) return;
  // Its outputs are in and the 3D finish runs: the provider's job is over. Stop the finish before anything
  // awaits, so it can't mark the job done in between.
  if ((JSON.parse(r.external_meta_json ?? "{}") as Record<string, unknown>).finishing) {
    stopModelFinish(id);
    update(id, { status: "canceled", completed_at: Date.now(), message: null });
    return;
  }
  const model = getModel(r.model_id);
  // Without an external id the job is still being handed over: submit() cancels it as soon as it lands, with the key it
  // was sent with (removing that key, or deleting the account, waits for it: handOversDone).
  if (r.external_id && model) {
    const account = accountOf(r);
    // An account's job is stopped with its own key, also when the account is switched off or about to be deleted.
    const own = account ? accountRun(account, r.provider, "cancel") : undefined;
    // A run on this install's GPUs is stopped there, as the account.
    const onPool = !!account && poolOf(r);
    const cancel = () =>
      Promise.resolve()
        .then(() => adapterFor(r.provider, account).cancel?.(pollContext(r, model)))
        .catch(() => {});
    if (onPool) await runOnPool(account!, cancel);
    else if (!own) await cancel();
    else if ("run" in own) await own.run(cancel);
  }
  stopModelFinish(id);
  update(id, { status: "canceled", completed_at: Date.now(), message: null });
  // Steps waiting only to feed this one are dropped too (nothing was spent on them).
  dropUnused(depIds(r.depends_on));
}

// ---------------------------------------------------------------------------
// Fuobe Soul's post steps (the look's grade and overlay), made in the browser when the result arrives.

/** The aspect ratio a stored request asked for (Soul Cinema's 21:9 is made at 16:9 and cropped). */
function requestAspect(json: string): string | undefined {
  try {
    return (JSON.parse(json) as GenerationRequest).params?.aspectRatio;
  } catch {
    return undefined;
  }
}

export class FinishError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Keep the finished picture of a Soul result in place of the raw one: the raw one stays as meta.original (its
 * file is still the generation's), meta.finished marks it done. The first finished copy wins: another tab's
 * answer is 409, and an output with nothing left to do is refused.
 */
export function finishOutput(id: string, index: number, png: Buffer): Generation {
  const r = db().prepare("SELECT * FROM generations WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new FinishError("Not found", 404);
  if (r.status !== "succeeded") throw new FinishError("The result isn't ready yet", 409);
  const outputs = JSON.parse(r.outputs_json) as OutputFile[];
  const o = outputs[index];
  if (!o || !Number.isInteger(index)) throw new FinishError("No such output", 404);
  if (o.meta?.finished) throw new FinishError("Already finished", 409);
  if (!finishSteps(o)) throw new FinishError("This output has no grade or overlay to apply", 400);
  const asset = saveFile({ data: png, contentType: "image/png", name: `${id}-${index}-finished.png`, source: "generation", generationId: id });
  outputs[index] = { ...o, url: asset.url, assetId: asset.id, contentType: "image/png", meta: { ...o.meta, finished: true, original: o.url } };
  update(id, { outputs_json: JSON.stringify(outputs) });
  return getGeneration(id, { includeDeleted: true })!;
}

// ---------------------------------------------------------------------------
// Results made in the browser (colour grading): stored as finished generations.

/**
 * A live edit saved to the Library (the owner's): the kept master as the result, the steps that made it in
 * params.liveSteps, the joined step texts as the prompt. It ran on the owner's GPU already, so nothing is queued.
 */
export function recordLiveEdit(input: { master: string; original?: string; steps: { text: string; seed: number }[]; from?: string }): Generation {
  const model = getModel("oss-qwen-image-21-live");
  if (!model) throw new Error("Live edit's model is missing");
  const now = Date.now();
  const prompt = input.steps.map((s) => s.text).filter(Boolean).join(" · ").slice(0, 2000) || "Live edit";
  const op: Generation["op"] = input.original ? "edit" : "t2i";
  const req: GenerationRequest = {
    feature: "live-edit",
    modelId: model.id,
    op,
    prompt,
    inputs: input.original ? { images: [input.original] } : {},
    params: { extra: { liveSteps: input.steps, ...(input.from && { from: input.from }) } },
  };
  const row: Row = {
    id: nanoid(12),
    batch_id: null,
    feature: "live-edit",
    preset_id: null,
    model_id: model.id,
    engine: model.engine,
    provider: "comfyui",
    op,
    kind: "image",
    status: "succeeded",
    progress: 1,
    message: null,
    prompt,
    request_json: JSON.stringify(req),
    provider_input_json: null,
    external_id: "live",
    external_meta_json: null,
    outputs_json: JSON.stringify([{ url: input.master, kind: "image", contentType: "image/png" }]),
    error: null,
    cost_usd: 0,
    favorite: 0,
    created_at: now,
    updated_at: now,
    completed_at: now,
    depends_on: null,
  };
  db()
    .prepare(`INSERT INTO generations (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map((k) => `@${k}`).join(", ")})`)
    .run(row);
  return toGeneration(row);
}

export function recordLocalGeneration(input: {
  feature: string;
  modelId: string;
  op: Generation["op"];
  prompt: string;
  /** What the tool calls its result, shown instead of the prompt. */
  title?: string;
  inputs: GenerationRequest["inputs"];
  params?: GenerationRequest["params"];
  output: { url: string; kind: OutputFile["kind"]; contentType?: string; meta?: { poster: string }; width?: number; height?: number };
}): Generation {
  const model = getModel(input.modelId);
  // A browser tool's own result: the model's local route for this very step (a grade is not recorded as a Relight blend).
  if (!model || !model.routes.some((r) => r.provider === "local" && r.op === input.op)) throw new Error("Not a browser tool");
  const now = Date.now();
  // Inside an account's work (the route's runAsTenant) the result is the account's own, as its runs are (stampTenant).
  const account = tenantAccount();
  const req: GenerationRequest = { feature: input.feature, modelId: input.modelId, op: input.op, prompt: input.prompt, ...(input.title && { title: input.title }), inputs: input.inputs, params: input.params, ...(account && { account }) };
  const row: Row = {
    id: nanoid(12),
    batch_id: null,
    feature: input.feature,
    preset_id: null,
    model_id: model.id,
    engine: model.engine,
    provider: "local",
    op: input.op,
    kind: input.output.kind,
    status: "succeeded",
    progress: 1,
    message: null,
    prompt: input.prompt,
    request_json: JSON.stringify(req),
    provider_input_json: null,
    external_id: "local",
    external_meta_json: null,
    outputs_json: JSON.stringify([input.output]),
    error: null,
    cost_usd: 0,
    favorite: 0,
    created_at: now,
    updated_at: now,
    completed_at: now,
    depends_on: null,
  };
  db()
    .prepare(`INSERT INTO generations (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map((k) => `@${k}`).join(", ")})`)
    .run(row);
  return toGeneration(row);
}
