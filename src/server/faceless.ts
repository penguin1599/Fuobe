import "server-only";
import { nanoid } from "nanoid";
import { z } from "zod";
import { getModel } from "@/lib/catalog";
import {
  AUTO_SECONDS,
  blockCount,
  buildEpisodeGraph,
  CAMERA_WORDS,
  changedKeys,
  channelName,
  defaultSettings,
  ENGINE_MODELS,
  estimateGraph,
  EXPLAINER_MAX,
  EXPLAINER_MIN,
  genreInfo,
  getStyle,
  MAX_SCRIPT,
  MAX_SOURCES,
  musicPlan,
  clipBedFor,
  CLIP_BED_MAX,
  CLIP_BED_MIN,
  narrationText,
  normalizeBlocks,
  OFFLINE_NOTE,
  offlineScript,
  offlineTopics,
  parseScript,
  parseTopics,
  parseVisuals,
  placeholderBlocks,
  plannedTiming,
  planRerun,
  previewLine,
  regeneratePlan,
  regenerateReuses,
  resolveModels,
  sameCameraMove,
  sceneSpans,
  sceneTiming,
  scriptBrief,
  scriptSchema,
  scriptSystem,
  splitScript,
  spokenTimes,
  staleSteps,
  styleRefLimit,
  subjectOf,
  TIMING_PARTS,
  topicsBrief,
  topicsSchema,
  topicsSystem,
  totalSeconds,
  visualsBrief,
  visualsSchema,
  visualsSystem,
  withTiming,
  wordsFor,
  youtubeKind,
  YOUTUBE_ERROR,
  type ChangePart,
  type ChangePreview,
  type ChannelReference,
  type ChannelSettings,
  type EpisodeCard,
  type EpisodePlan,
  type EpisodeScript,
  type EpisodeSettings,
  type EpisodeStatus,
  type EpisodeView,
  type EstimateResult,
  type ExplainerSource,
  type FacelessChannel,
  type FacelessEpisode,
  type FacelessGenre,
  type GraphInput,
  type GraphStep,
  type NarratorVoice,
  type ScriptBlock,
  type StillEdits,
  type TimedText,
  type TopicIdea,
} from "@/lib/catalog/faceless";
import { routesFor } from "@/lib/catalog/plan";
import { pricingAt } from "@/lib/catalog/promo";
import { REGEN_COPY, REGEN_OFFERED } from "@/lib/catalog/regenerate";
import { ownSetupGate } from "./own-setup-run";
import type { Engine, Generation, GenerationRequest } from "@/lib/catalog/types";
import { AccountProjectError, accountProjectIds, accountProjectOwner, createAccountProject, deleteAccountProject } from "./account-projects";
import { DocxError, docxText } from "./assist/docx";
import { PdfError, pdfText } from "./assist/pdf";
import { db } from "./db";
import { listElements } from "./elements";
import { connectRefusal } from "./connect-refusal";
import { createPipeline } from "./chains";
import { asAccount, cancelGeneration, chooseRoute, ConnectComfyError, createGenerations, getGeneration, previewChained } from "./generations";
import { provider } from "./providers";
import type { JsonSpec } from "./llm";
import { llmBackends, probeLocal } from "./providers/llm";
import { fetchRemote } from "./remote-fetch";
import { engineMode, getSetting } from "./settings";
import { fileUrl, saveFile } from "./storage";
import { firstOn, offeredModel } from "./model-access";
import { tenant, tenantAccount } from "./tenant";

/**
 * Faceless Studio and the Explainer on the server: channels (genre, saved style, narrator, aspect,
 * subtitles, a name and an avatar made for them), episodes (topic → script → review → render), the
 * render itself as chained generations over the graph from src/lib/catalog/faceless.ts, retries,
 * block changes from the timeline editor (re-run that block's steps and everything after them) with
 * Undo, "Upscale to 1080p", voice previews, topic suggestions, link summaries and estimates.
 *
 * A render runs in two stages. Stage one is the pictures, the narration and its word timings. Once the
 * narration is timed, `advance` cuts every scene to where its lines are spoken and creates stage two:
 * the clips, the joins, the music, the mix and the subtitles. Both stages live in the generations
 * table, so they survive restarts; stage two is created by whoever looks first: a read of the episode,
 * or the background sweep (ensureFacelessRunner, started at boot by src/instrumentation.ts).
 *
 * Writing a script runs in this process (the install's LLM through the "llm" provider, or the offline
 * writer); a restart while it writes leaves the episode "write-failed" with a Try again.
 *
 * Whose channels and episodes (public sign-up): the owner's, or a signed-in account's own. An account's channel and its
 * explainers are its own projects in account-projects.ts (kinds "faceless" and "explainer") under the row's id; a
 * channel's episodes are its channel's. Every read and change here is for whoever the work is for (tenant.ts asAccount):
 * an account reaches only its own (another's, or the owner's, reads as not found) and the owner's lists never hold an
 * account's. An account's work never uses the install's AI helper (its scripts, names, topics and summaries are the
 * offline writer's) or its elements; its renders run on its own GPU or key (src/server/account-tool-run.ts).
 */

export class FacelessError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Rows

interface ChannelRow {
  id: string;
  name: string;
  idea: string;
  genre: string;
  avatar_url: string | null;
  avatar_job: string | null;
  reference_json: string | null;
  settings_json: string;
  created_at: number;
  updated_at: number;
}

interface EpisodeRow {
  id: string;
  channel_id: string | null;
  kind: "faceless" | "explainer";
  title: string;
  topic: string;
  status: EpisodeStatus;
  error: string | null;
  settings_json: string;
  script_json: string;
  plan_json: string | null;
  sources_json: string | null;
  favorite: number;
  created_at: number;
  updated_at: number;
}

const toChannel = (r: ChannelRow): FacelessChannel => ({
  id: r.id,
  name: r.name,
  idea: r.idea,
  genre: genreInfo(r.genre).id,
  avatarUrl: r.avatar_url,
  avatarJob: r.avatar_job ?? null,
  reference: r.reference_json ? (JSON.parse(r.reference_json) as ChannelReference) : null,
  settings: JSON.parse(r.settings_json) as ChannelSettings,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toEpisode = (r: EpisodeRow): FacelessEpisode => ({
  id: r.id,
  channelId: r.channel_id,
  kind: r.kind,
  title: r.title,
  topic: r.topic,
  status: r.status,
  error: r.error,
  settings: JSON.parse(r.settings_json) as EpisodeSettings,
  script: JSON.parse(r.script_json) as EpisodeScript,
  plan: r.plan_json ? (JSON.parse(r.plan_json) as EpisodePlan) : null,
  sources: r.sources_json ? (JSON.parse(r.sources_json) as ExplainerSource[]) : [],
  favorite: !!r.favorite,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

function updateEpisodeRow(id: string, fields: Partial<EpisodeRow>): void {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db()
    .prepare(`UPDATE faceless_episodes SET ${keys.map((k) => `${k} = @${k}`).join(", ")}, updated_at = @__now WHERE id = @__id`)
    .run({ ...fields, __now: Date.now(), __id: id });
}

// ---------------------------------------------------------------------------
// Whose rows (see the header)

/** An account's channel, and an account's explainer, as its own project kinds (account-projects.ts). */
export const CHANNEL_KIND = "faceless";
export const EXPLAINER_KIND = "explainer";

/** Whether the work is a guest's (a visitor's price check): a guest has no channels or episodes. */
const guestWork = () => tenant()?.kind === "guest";

/** A new row's id: the owner's as before; an account's is its own project's (its limit of them counts). */
export function newRowId(kind: string, name: string): string {
  const account = tenantAccount();
  return account ? createAccountProject(account, kind, { name, data: {} }).id : nanoid(10);
}

/** An account's project made for a row that then couldn't be stored: let go of it. */
export function dropRowId(kind: string, id: string): void {
  const account = tenantAccount();
  if (account) deleteAccountProject(account, kind, id);
}

/** Whose a channel is: an account's id, or null for the owner's. */
export const channelOwner = (id: string): string | null => accountProjectOwner(CHANNEL_KIND, id);

/** Whose an episode is: its channel's, or (an explainer) its own project's. */
export const episodeOwner = (r: { id: string; channel_id: string | null }): string | null => (r.channel_id ? channelOwner(r.channel_id) : accountProjectOwner(EXPLAINER_KIND, r.id));

/** Whether a row whose owner this is belongs to whoever the work is for: an account its own, the owner never an account's. */
export const forViewer = (owner: string | null): boolean => !guestWork() && owner === (tenantAccount() ?? null);

/** `column IN / NOT IN (…)`: the rows of one kind that are whoever the work is for (a guest's: none). */
export function viewerScope(column: string, kind: string): { sql: string; args: unknown[] } {
  if (guestWork()) return { sql: "0", args: [] };
  const account = tenantAccount();
  const ids = accountProjectIds(kind, account);
  return { sql: account ? `${column} IN (${ids.sql})` : `${column} NOT IN (${ids.sql})`, args: ids.args };
}

/** The episodes that are whoever the work is for: an account's channels' and its explainers; the owner's, none of those. */
function episodeScope(): { sql: string; args: unknown[] } {
  if (guestWork()) return { sql: "0", args: [] };
  const account = tenantAccount();
  const channels = accountProjectIds(CHANNEL_KIND, account);
  const explainers = accountProjectIds(EXPLAINER_KIND, account);
  return account
    ? { sql: `(channel_id IN (${channels.sql}) OR (channel_id IS NULL AND id IN (${explainers.sql})))`, args: [...channels.args, ...explainers.args] }
    : { sql: `((channel_id IS NULL OR channel_id NOT IN (${channels.sql})) AND id NOT IN (${explainers.sql}))`, args: [...channels.args, ...explainers.args] };
}

const episodeRow = (id: string) => {
  const r = db().prepare("SELECT * FROM faceless_episodes WHERE id = ?").get(id) as EpisodeRow | undefined;
  return r && forViewer(episodeOwner(r)) ? r : undefined;
};

function mustEpisode(id: string): FacelessEpisode {
  const r = episodeRow(id);
  if (!r) throw new FacelessError("Episode not found", 404);
  return toEpisode(r);
}

// ---------------------------------------------------------------------------
// The LLM (the install's own: Claude or a local model for the cloud engine, a local model only for the open one)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AskOptions {
  /** Hears why there's no answer (the LLM failed, or took too long). */
  onError?: (msg: string) => void;
  /** Stops waiting (and cancels the LLM's job): the episode was deleted. */
  signal?: AbortSignal;
  /** How long to wait for the answer (default 8 minutes: a script on a slow local model). */
  timeoutMs?: number;
  /** The JSON Schema the answer follows on a local model that supports it (the prompt asks for the same JSON). */
  json?: JsonSpec;
}

/** Channel names and topic suggestions are waited for: a slow model gives way to the offline wording. */
const NAME_TIMEOUT_MS = 15_000;
const TOPICS_TIMEOUT_MS = 25_000;

/** One answer from the engine's text model, or null (no LLM, AI helper off, demo mode on, or it failed: `onError` hears why). */
export async function askLlm(engine: Engine, system: string, user: string, o: AskOptions = {}): Promise<string | null> {
  // An account's work, or a visitor's price check, never uses the install's AI helper: the offline wording is used.
  if (tenant()) return null;
  if (getSetting("demoMode") === "on") return null;
  // A text model switched off in Settings → Models & licences gives way to the offline wording, like no LLM at all.
  const found = getModel(ENGINE_MODELS[engine].write);
  const model = found && offeredModel(found);
  const route = model?.routes.find((r) => r.op === "write");
  if (!model || !route) return null;
  await probeLocal();
  if (!llmBackends(route).length) return null;
  const llm = provider("llm");
  try {
    const { externalId } = await llm.submit({ generationId: `faceless_${nanoid(6)}`, model, route, input: { prompt: user, extra: { system, ...(o.json && { json: o.json }) } } });
    const ctx = { externalId, meta: {}, route, model, createdAt: Date.now() };
    const deadline = Date.now() + (o.timeoutMs ?? 8 * 60_000);
    while (Date.now() < deadline) {
      await sleep(350);
      if (o.signal?.aborted) {
        await llm.cancel?.(ctx).catch(() => {});
        return null;
      }
      const r = await llm.poll(ctx);
      if (r.state === "succeeded") return r.outputs[0]?.text?.trim() || null;
      if (r.state === "failed") {
        o.onError?.(r.error);
        return null;
      }
    }
    await llm.cancel?.(ctx).catch(() => {});
    o.onError?.("The LLM took too long");
  } catch (e) {
    o.onError?.((e as Error).message);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Channels

const ChannelDefaults = (engine: Engine, genre: FacelessGenre): ChannelSettings => {
  const s = defaultSettings(engine, genreInfo(genre));
  return { engine, styleId: s.styleId, styleRefs: [], voice: s.voice, aspect: s.aspect, subtitles: s.subtitles, music: s.music, animation: s.animation, length: s.length };
};

/** A finished avatar becomes the channel's picture (whoever is watching); a failed one is let go. */
function refreshAvatar(r: ChannelRow): ChannelRow {
  if (!r.avatar_job) return r;
  const g = getGeneration(r.avatar_job, { includeDeleted: true });
  if (g && (g.status === "queued" || g.status === "running")) return r;
  const url = g?.status === "succeeded" ? (g.outputs.find((o) => o.kind === "image")?.url ?? null) : null;
  const next = { ...r, avatar_job: null, avatar_url: url ?? r.avatar_url };
  db().prepare("UPDATE faceless_channels SET avatar_url = ?, avatar_job = NULL WHERE id = ? AND avatar_job = ?").run(next.avatar_url, r.id, r.avatar_job);
  return next;
}

const channelRow = (id: string) => {
  const r = db().prepare("SELECT * FROM faceless_channels WHERE id = ?").get(id) as ChannelRow | undefined;
  return r && forViewer(channelOwner(id)) ? r : undefined;
};

export function listChannels(): FacelessChannel[] {
  const scope = viewerScope("id", CHANNEL_KIND);
  const rows = (db().prepare(`SELECT * FROM faceless_channels WHERE ${scope.sql} ORDER BY updated_at DESC`).all(...scope.args) as ChannelRow[]).map(refreshAvatar);
  const counts = new Map(
    (db().prepare("SELECT channel_id, COUNT(*) AS n FROM faceless_episodes WHERE channel_id IS NOT NULL GROUP BY channel_id").all() as { channel_id: string; n: number }[]).map((r) => [r.channel_id, r.n]),
  );
  return rows.map((r) => {
    const c = toChannel(r);
    // The newest episode with a finished picture: its first scene is the cover.
    const latest = db().prepare("SELECT * FROM faceless_episodes WHERE channel_id = ? AND plan_json IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(r.id) as EpisodeRow | undefined;
    const ep = latest && toEpisode(latest);
    const still = ep?.plan ? getGeneration(ep.plan.ids[`still-${ep.script.blocks[0]?.id}`] ?? "") : null;
    return { ...c, episodes: counts.get(r.id) ?? 0, cover: still?.status === "succeeded" ? still : null };
  });
}

export function getChannel(id: string): FacelessChannel | null {
  const r = channelRow(id);
  return r ? toChannel(refreshAvatar(r)) : null;
}

/**
 * Title and thumbnail of a YouTube link (oEmbed, through the SSRF-safe fetch); the thumbnail is saved as an upload. An
 * account's is kept as the plain link: the server never fetches a link for an account (docs/public-signup.md).
 */
async function readReference(url: string): Promise<ChannelReference> {
  const kind = youtubeKind(url);
  if (!kind) throw new FacelessError(YOUTUBE_ERROR);
  const ref: ChannelReference = { url: url.trim(), kind };
  if (tenant()) return ref;
  try {
    const res = await fetchRemote(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(ref.url)}`, { maxBytes: 256 * 1024, timeoutMs: 8000 });
    const j = JSON.parse(res.data.toString("utf8")) as { title?: string; author_name?: string; thumbnail_url?: string };
    ref.title = j.title?.slice(0, 200);
    ref.author = j.author_name?.slice(0, 120);
    if (j.thumbnail_url) {
      const img = await fetchRemote(j.thumbnail_url, { maxBytes: 4 * 1024 * 1024, timeoutMs: 8000 });
      const type = img.contentType?.startsWith("image/") ? img.contentType : "image/jpeg";
      ref.thumbnail = saveFile({ data: img.data, contentType: type, name: "reference-thumbnail.jpg", source: "upload" }).url;
    }
  } catch {
    // Saved as a plain link: the look can't be matched without the thumbnail, the script still gets the link.
  }
  return ref;
}

declare global {
  var __fuobeFacelessNaming: Map<string, Promise<void>> | undefined;
}
const naming = () => (globalThis.__fuobeFacelessNaming ??= new Map<string, Promise<void>>());

/** Wait for a new channel's name and avatar to be started (tests). */
export const channelReady = (id: string) => naming().get(id) ?? Promise.resolve();

const NAME_SYSTEM = "You name YouTube channels. Reply with the name only: 2–4 words, memorable, no quotes, no emoji.";

/**
 * A new channel is there straight away with a name taken from the idea; the LLM's name replaces it when
 * it answers (within 15 s, and only while the channel still has the first name), then the avatar is drawn.
 */
export async function createChannel(input: { idea: string; genre: FacelessGenre; engine: Engine; reference?: string; name?: string; avatar?: boolean; settings?: Partial<ChannelSettings> }): Promise<FacelessChannel> {
  const idea = input.idea.trim();
  if (!idea) throw new FacelessError("Describe the channel first");
  const reference = input.reference?.trim() ? await readReference(input.reference) : null;
  const given = input.name?.trim().slice(0, 60) || null;
  const now = Date.now();
  const firstName = given ?? channelName(idea);
  const row: ChannelRow = {
    id: newRowId(CHANNEL_KIND, firstName),
    name: firstName,
    idea: idea.slice(0, 500),
    genre: input.genre,
    avatar_url: null,
    avatar_job: null,
    reference_json: reference ? JSON.stringify(reference) : null,
    settings_json: JSON.stringify({ ...ChannelDefaults(input.engine, input.genre), ...input.settings }),
    created_at: now,
    updated_at: now,
  };
  try {
    db()
      .prepare(`INSERT INTO faceless_channels (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map((k) => `@${k}`).join(", ")})`)
      .run(row);
  } catch (e) {
    dropRowId(CHANNEL_KIND, row.id);
    throw e;
  }
  const job = (async () => {
    if (!given) {
      const answer = await askLlm(input.engine, NAME_SYSTEM, `Channel idea: ${idea}\nGenre: ${genreInfo(input.genre).label}`, { timeoutMs: NAME_TIMEOUT_MS });
      const name = answer?.split("\n")[0].replace(/^["'“”]+|["'“”.]+$/g, "").trim().slice(0, 60);
      if (name) db().prepare("UPDATE faceless_channels SET name = ? WHERE id = ? AND name = ?").run(name, row.id, row.name);
    }
    try {
      // avatar: false (Assist's channel) leaves the initials and the "Draw an avatar" button; Content Factory
      // series show their reference instead (no picture to pay for). An account's avatar is a run on its own GPU or
      // key, started by the route after that run's checks (src/app/api/faceless/channels).
      if (input.avatar !== false && !tenantAccount() && channelRow(row.id)) makeAvatar(row.id);
    } catch {
      // No picture model can run right now: the channel shows its initials, and "Draw an avatar" is there.
    }
  })().finally(() => naming().delete(row.id));
  naming().set(row.id, job);
  return toChannel(row);
}

export async function updateChannel(
  id: string,
  patch: { name?: string; idea?: string; genre?: FacelessGenre; avatarUrl?: string | null; reference?: string | null; settings?: Partial<ChannelSettings> },
): Promise<FacelessChannel> {
  const cur = getChannel(id);
  if (!cur) throw new FacelessError("Channel not found", 404);
  const fields: Partial<ChannelRow> = {};
  if (patch.name !== undefined) fields.name = patch.name.trim().slice(0, 60) || cur.name;
  if (patch.idea !== undefined) fields.idea = patch.idea.trim().slice(0, 500) || cur.idea;
  if (patch.genre) fields.genre = patch.genre;
  if (patch.avatarUrl !== undefined) {
    fields.avatar_url = patch.avatarUrl;
    fields.avatar_job = null;
  }
  if (patch.reference !== undefined) fields.reference_json = patch.reference ? JSON.stringify(await readReference(patch.reference)) : null;
  if (patch.settings) fields.settings_json = JSON.stringify({ ...cur.settings, ...patch.settings });
  const keys = Object.keys(fields);
  if (keys.length) {
    db()
      .prepare(`UPDATE faceless_channels SET ${keys.map((k) => `${k} = @${k}`).join(", ")}, updated_at = @__now WHERE id = @__id`)
      .run({ ...fields, __now: Date.now(), __id: id });
  }
  return getChannel(id)!;
}

/** Deletes the channel and its episodes, stopping whatever they still render; finished videos stay in the Library. */
export async function deleteChannel(id: string): Promise<void> {
  const c = channelRow(id);
  if (!c) throw new FacelessError("Channel not found", 404);
  const episodes = (db().prepare("SELECT * FROM faceless_episodes WHERE channel_id = ?").all(id) as EpisodeRow[]).map(toEpisode);
  const stops = [...episodes.flatMap(stopEpisode), ...(c.avatar_job ? [cancelGeneration(c.avatar_job)] : [])];
  db().transaction(() => {
    db().prepare("DELETE FROM faceless_episodes WHERE channel_id = ?").run(id);
    db().prepare("DELETE FROM faceless_channels WHERE id = ?").run(id);
  })();
  dropRowId(CHANNEL_KIND, id);
  await Promise.all(stops);
}

/**
 * When an account is deleted (account-sweep.ts purgeAccount, before its projects go): its channels, their episodes and
 * its explainers. Its runs are deleted with the account.
 */
export function deleteAccountFaceless(accountId: string): void {
  const channels = accountProjectIds(CHANNEL_KIND, accountId);
  const explainers = accountProjectIds(EXPLAINER_KIND, accountId);
  db().transaction(() => {
    db().prepare(`DELETE FROM faceless_episodes WHERE channel_id IN (${channels.sql}) OR (channel_id IS NULL AND id IN (${explainers.sql}))`).run(...channels.args, ...explainers.args);
    db().prepare(`DELETE FROM faceless_channels WHERE id IN (${channels.sql})`).run(...channels.args);
  })();
}

/** A channel avatar in the channel's style (one picture generation); it becomes the channel's picture when it's done. */
export function makeAvatar(id: string): Generation {
  const [g] = createGenerations(avatarRequest(id));
  db().prepare("UPDATE faceless_channels SET avatar_job = ? WHERE id = ?").run(g.id, id);
  return g;
}

/** The avatar's one picture generation, as makeAvatar creates it (an account's run is checked with it first). */
export function avatarRequest(id: string): GenerationRequest {
  const c = getChannel(id);
  if (!c) throw new FacelessError("Channel not found", 404);
  const style = getStyle(c.settings.styleId);
  const engine = c.settings.engine;
  return {
    feature: "faceless-avatar",
    modelId: ENGINE_MODELS[engine].still,
    // The words name only what the picture shows (the open still model draws any words it is given, and reads no negatives).
    prompt: `A round channel avatar for a YouTube channel about ${subjectOf(c.idea) || c.name}: one bold, simple pictorial emblem, centred on a plain background. Style: ${style.look}.`,
    params: { aspectRatio: "1:1", numOutputs: 1 },
    title: `${c.name} · avatar`,
  };
}

// ---------------------------------------------------------------------------
// Topics

export async function suggestTopics(input: { idea: string; genre: FacelessGenre; engine: Engine; avoid?: string[]; count?: number; round?: number; reference?: string }): Promise<{ topics: TopicIdea[]; offline: boolean }> {
  const count = Math.max(4, Math.min(6, input.count ?? 5));
  const genre = genreInfo(input.genre);
  const answer = await askLlm(input.engine, topicsSystem, topicsBrief({ idea: input.idea, genre, count, avoid: input.avoid, reference: input.reference }), { timeoutMs: TOPICS_TIMEOUT_MS, json: topicsSchema(count) });
  const topics = answer ? parseTopics(answer).slice(0, count) : [];
  if (topics.length >= 3) return { topics, offline: false };
  return { topics: offlineTopics(input.idea, genre.id, count, input.round ?? 0, input.avoid), offline: true };
}

// ---------------------------------------------------------------------------
// Episodes: create, write, review

interface WritingJob {
  job: Promise<void>;
  abort: AbortController;
}

declare global {
  var __fuobeFacelessWriting: Map<string, WritingJob> | undefined;
}
const writing = () => (globalThis.__fuobeFacelessWriting ??= new Map<string, WritingJob>());

export interface EpisodeInput {
  kind: "faceless" | "explainer";
  channelId?: string | null;
  topic: string;
  settings: EpisodeSettings;
  /** A pasted script (skips the writer). */
  script?: string;
  sources?: ExplainerSource[];
  /** Explainer: render as soon as the script is written (no review step). */
  autoRender?: boolean;
  /** Save this episode's look and sound as the channel's (default: only for a channel's first episode). */
  saveLook?: boolean;
  /** A script that's written already, with its pictures (Assist): no writer runs; it's ready to review, or renders at once with autoRender. */
  blocks?: Partial<ScriptBlock>[];
  /** The title before the script names it (a series' planned episode title). */
  title?: string;
  /**
   * A script composed already (composeScript): an account's, written before its run is checked, so what renders is
   * what was checked. No writer runs; it's ready to review, or renders at once with autoRender.
   */
  composed?: EpisodeScript;
  /** The render's batch: an account's series renders its episodes as one run. */
  batchId?: string;
}

/** An account's episode on the cloud engine without a key of its own (its engine mode is open source only). */
export const ACCOUNT_CLOUD_ENGINE = "Add a fal.ai or Replicate key to make this on the cloud engine, or switch to open source to make it on your GPU.";

function cleanSettings(s: EpisodeSettings): EpisodeSettings {
  const mode = engineMode();
  if (mode !== "both" && s.engine !== mode) {
    if (tenant()) throw new FacelessError(ACCOUNT_CLOUD_ENGINE, 422);
    throw new FacelessError(mode === "open" ? "This install is set to open source only (Settings → Engine mode)" : "This install is set to paid cloud APIs only (Settings → Engine mode)");
  }
  return {
    ...s,
    styleRefs: s.styleRefs.slice(0, styleRefLimit(s.engine, getModel)),
    elements: [...new Set(s.elements)].slice(0, 8),
    length: Math.max(EXPLAINER_MIN, Math.min(EXPLAINER_MAX, Math.round(s.length))),
  };
}

export function createEpisode(input: EpisodeInput): FacelessEpisode {
  const topic = input.topic.trim();
  const pasted = input.script?.trim() ?? "";
  const composed = input.composed ?? null;
  const written = composed ? normalizeBlocks(composed.blocks) : input.blocks ? normalizeBlocks(input.blocks) : null;
  if (!topic && !pasted && !input.sources?.length && !written?.length) throw new FacelessError(input.kind === "explainer" ? "Add a prompt, or attach a file or link" : "Add a topic, or bring your own script");
  if (pasted.length > MAX_SCRIPT || (written && narrationText(written).length > MAX_SCRIPT)) throw new FacelessError("That script is too long to narrate. Shorten it and try again.");
  if (written && !written.length) throw new FacelessError("The script has no scenes yet");
  const channel = input.channelId ? getChannel(input.channelId) : null;
  if (input.channelId && !channel) throw new FacelessError("Channel not found", 404);
  const settings = cleanSettings(input.settings);
  const sources = (input.sources ?? []).slice(0, MAX_SOURCES);
  settings.sourceImages = sources.filter((s): s is Extract<ExplainerSource, { kind: "image" }> => s.kind === "image").map((s) => s.url);
  const now = Date.now();
  const named = composed?.title?.trim() || input.title?.trim();
  const title = (named || topic || pasted || written?.[0]?.narration || "").replace(/\s+/g, " ").slice(0, named ? 120 : 80) || "Untitled episode";
  const script: EpisodeScript = composed ? { ...composed, blocks: written! } : written ? { blocks: written, source: "ai" } : { blocks: [], source: pasted ? "pasted" : "ai" };
  const row: EpisodeRow = {
    // An explainer of an account's is its own project (a channel's episodes are their channel's).
    id: channel ? nanoid(10) : newRowId(EXPLAINER_KIND, title),
    channel_id: channel?.id ?? null,
    kind: input.kind,
    title,
    topic: topic.slice(0, 5000),
    status: written ? "review" : "writing",
    error: null,
    settings_json: JSON.stringify(settings),
    script_json: JSON.stringify(script),
    plan_json: null,
    sources_json: JSON.stringify(sources),
    favorite: 0,
    created_at: now,
    updated_at: now,
  };
  const first = channel ? !(db().prepare("SELECT 1 FROM faceless_episodes WHERE channel_id = ? LIMIT 1").get(channel.id) as unknown) : false;
  try {
    db()
      .prepare(`INSERT INTO faceless_episodes (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map((k) => `@${k}`).join(", ")})`)
      .run(row);
  } catch (e) {
    if (!channel) dropRowId(EXPLAINER_KIND, row.id);
    throw e;
  }
  if (channel && (input.saveLook ?? first)) {
    void updateChannel(channel.id, {
      settings: {
        engine: settings.engine,
        styleId: settings.styleId,
        styleRefs: settings.styleRefs,
        voice: settings.voice,
        aspect: settings.aspect,
        subtitles: settings.subtitles,
        music: settings.music,
        animation: settings.animation,
        length: settings.length,
        ...(settings.brief && { brief: settings.brief }),
      },
    });
  }
  if (written) {
    if (!input.autoRender) return toEpisode(row);
    try {
      return renderEpisode(row.id, input.batchId);
    } catch (e) {
      // The script is there: show it with what's in the way, as a written script that can't render does.
      updateEpisodeRow(row.id, { status: "review", error: (e as Error).message });
      return mustEpisode(row.id);
    }
  }
  // An account's render starts only after its run's checks (src/server/account-tool-run.ts), with a script composed
  // first: one written here waits for review.
  startWriting(row.id, pasted, !!input.autoRender && !tenant());
  return toEpisode(row);
}

/** Write (or split) the script in the background; the episode moves to review, or straight to rendering. */
function startWriting(id: string, pasted: string, autoRender: boolean): Promise<void> {
  const abort = new AbortController();
  const job = (async () => {
    try {
      await writeScript(id, pasted, abort.signal);
    } catch (e) {
      if (!abort.signal.aborted && episodeRow(id)) updateEpisodeRow(id, { status: "write-failed", error: (e as Error).message || "Couldn't write the script" });
      return;
    }
    if (!autoRender || abort.signal.aborted || !episodeRow(id)) return;
    try {
      renderEpisode(id);
    } catch (e) {
      // The script is there: show it with what's in the way (a missing voice, an engine that isn't connected).
      updateEpisodeRow(id, { status: "review", error: (e as Error).message });
    }
  })().finally(() => {
    if (writing().get(id)?.abort === abort) writing().delete(id);
  });
  writing().set(id, { job, abort });
  return job;
}

/** Wait for a script that's being written (tests, and the API's `?wait=1`). */
export const scriptWritten = (id: string) => writing().get(id)?.job ?? Promise.resolve();

/** What the script writer reads: the episode as it is (or will be) stored. */
export type ScriptAsk = Pick<FacelessEpisode, "kind" | "channelId" | "topic" | "settings" | "sources"> & {
  /** The channel's genre, for an episode whose channel isn't made yet (an account's series, composed before its run). */
  genre?: FacelessGenre;
};

/**
 * A script for an episode: the engine's LLM when it answers, else the offline writer (a pasted script is split into scenes
 * and its pictures planned). An account's is always the offline writer's (askLlm), without the install's notes about its
 * AI helper, and never names the owner's elements.
 */
export async function composeScript(ep: ScriptAsk, pasted: string, signal?: AbortSignal): Promise<EpisodeScript> {
  const visitor = !!tenant();
  const genre = genreInfo(ep.genre ?? (ep.channelId ? (getChannel(ep.channelId)?.genre ?? "education") : "education"));
  const channel = ep.channelId ? getChannel(ep.channelId) : null;
  const s = ep.settings;
  const style = getStyle(s.styleId);
  const auto = ep.kind === "explainer" && s.auto;
  // A Content Factory brief sets the pace: shorter scenes (more of them) for a reference that cuts fast.
  const sceneSecs = s.brief?.sceneSeconds ? Math.max(4, Math.min(10, Math.round(s.brief.sceneSeconds))) : 10;
  const scenes = s.brief?.sceneSeconds && !auto ? Math.max(1, Math.round(s.length / sceneSecs)) : blockCount(auto ? AUTO_SECONDS : s.length);
  const handles = new Set(s.elements.map((h) => h.toLowerCase()));
  const elements = (visitor ? [] : listElements())
    .filter((e) => e.kind !== "voice" && handles.has(e.handle.toLowerCase()))
    .map((e) => ({ handle: e.handle, kind: e.kind, description: e.description }));
  const textSources = ep.sources.flatMap((x) => (x.kind === "text" ? [`${x.name}: ${x.text.slice(0, SOURCE_CHARS)}`] : x.kind === "link" ? [`${x.title ?? x.url} (${x.url}): ${x.text.slice(0, SOURCE_CHARS)}`] : []));
  let failure = "";
  const ask = { onError: (m: string) => (failure = m), signal };
  let script: EpisodeScript;
  if (pasted) {
    const blocks = splitScript(pasted);
    const answer = await askLlm(s.engine, visualsSystem, visualsBrief(blocks, style.name, ep.topic || pasted.slice(0, 200)), { ...ask, json: visualsSchema(blocks.length) });
    const visuals = answer ? parseVisuals(answer, blocks.length) : null;
    script = {
      source: "pasted",
      blocks: visuals ? blocks.map((b, i) => ({ ...b, visual: visuals[i].visual, motion: visuals[i].motion || b.motion })) : blocks,
      ...(!visuals && !visitor && { offline: true, note: failure ? `Pictures planned offline (${failure}).` : "Pictures planned from your words — connect Claude or a local model (Ollama, LM Studio or Unsloth Studio) in Settings for better scenes." }),
    };
  } else {
    const topic = ep.topic || textSources[0]?.slice(0, 300) || "this topic";
    const brief = scriptBrief({
      topic,
      genre: ep.kind === "explainer" ? { ...genre, label: "Explainer", hint: "Explain it clearly to someone new to it", tone: genre.tone } : genre,
      scenes,
      wordsPerScene: wordsFor(sceneSecs),
      channel: channel ? `${channel.name} — ${channel.idea}` : undefined,
      styleName: style.name,
      elements,
      reference: channel?.reference ? [channel.reference.title, channel.reference.author && `by ${channel.reference.author}`].filter(Boolean).join(" ") || channel.reference.url : undefined,
      sources: textSources,
      auto,
      style: s.brief?.script,
    });
    const answer = await askLlm(s.engine, scriptSystem, brief, { ...ask, json: scriptSchema(auto ? null : scenes) });
    const parsed = answer ? parseScript(answer) : null;
    if (parsed?.blocks.length) {
      script = { source: "ai", title: parsed.title ?? undefined, blocks: parsed.blocks };
    } else {
      const blocks = offlineScript(topic, ep.kind === "explainer" ? "education" : genre.id, scenes);
      // The offline beats run about 10 s each: a brief's shorter scenes would overshoot the length, so middle beats go.
      if (s.brief?.sceneSeconds && !auto) while (blocks.length > 1 && totalSeconds(blocks) > s.length * 1.15) blocks.splice(Math.floor(blocks.length / 2), 1);
      if (elements.length) for (const b of blocks) b.visual = `${b.visual}, with ${elements.map((e) => `@${e.handle}`).join(" and ")}`;
      script = visitor ? { source: "ai", blocks } : { source: "ai", blocks, offline: true, note: failure ? `${OFFLINE_NOTE} (${failure})` : OFFLINE_NOTE };
    }
  }
  return script;
}

async function writeScript(id: string, pasted: string, signal: AbortSignal): Promise<void> {
  const ep = mustEpisode(id);
  const script = await composeScript(ep, pasted, signal);
  if (signal.aborted || !episodeRow(id)) return;
  updateEpisodeRow(id, {
    status: "review",
    error: null,
    title: (script.title || ep.title).slice(0, 120),
    script_json: JSON.stringify(script),
  });
}

/** Write the script again (after a failure, or for a fresh draft). */
export function rewriteEpisode(id: string): FacelessEpisode {
  const ep = mustEpisode(id);
  if (ep.status === "rendering" || ep.status === "done" || ep.plan) throw new FacelessError("This episode is already rendered — change scenes in the timeline instead", 409);
  if (writing().has(id)) return ep;
  updateEpisodeRow(id, { status: "writing", error: null });
  startWriting(id, ep.script.source === "pasted" ? ep.script.blocks.map((b) => b.narration).join(" ") : "", false);
  return mustEpisode(id);
}

export function updateEpisode(id: string, patch: { title?: string; favorite?: boolean; blocks?: Partial<ScriptBlock>[]; settings?: Partial<EpisodeSettings> }): FacelessEpisode {
  const ep = mustEpisode(id);
  const fields: Partial<EpisodeRow> = {};
  if (patch.title !== undefined) fields.title = patch.title.trim().slice(0, 120) || ep.title;
  if (patch.favorite !== undefined) fields.favorite = patch.favorite ? 1 : 0;
  if (patch.blocks || patch.settings) {
    if (ep.status !== "review" && ep.status !== "write-failed") throw new FacelessError("The script can only change before the episode renders — use the timeline editor", 409);
    if (patch.blocks) {
      const blocks = normalizeBlocks(patch.blocks);
      if (narrationText(blocks).length > MAX_SCRIPT) throw new FacelessError("That script is too long to narrate. Shorten it and try again.");
      fields.script_json = JSON.stringify({ ...ep.script, blocks });
      fields.status = "review";
    }
    if (patch.settings) fields.settings_json = JSON.stringify(cleanSettings({ ...ep.settings, ...patch.settings }));
  }
  updateEpisodeRow(id, fields);
  return mustEpisode(id);
}

/** Stop an episode: the script writer, and every step still queued or running (now, and the version Undo keeps). */
function stopEpisode(ep: FacelessEpisode): Promise<void>[] {
  const w = writing().get(ep.id);
  if (w) {
    w.abort.abort();
    writing().delete(ep.id);
  }
  const ids = new Set([...Object.values(ep.plan?.ids ?? {}), ...Object.values(ep.plan?.previous?.ids ?? {}), ...(ep.plan?.upscaled ? [ep.plan.upscaled] : []), ...Object.values(ep.plan?.regenerated?.ids ?? {})]);
  return [...ids].map((g) => cancelGeneration(g).catch(() => {}));
}

/** Deletes the episode and stops what it still renders; its finished pictures, clips and videos stay in the Library. */
export async function deleteEpisode(id: string): Promise<void> {
  const ep = mustEpisode(id);
  const stops = stopEpisode(ep);
  db().prepare("DELETE FROM faceless_episodes WHERE id = ?").run(id);
  if (!ep.channelId) dropRowId(EXPLAINER_KIND, id);
  await Promise.all(stops);
}

// ---------------------------------------------------------------------------
// Rendering

/**
 * A voice to clone when an open-source narrator has no sample and the narration would only run as a
 * demo anyway (no ComfyUI): a short tone saved once, so demo mode stays clickable end to end.
 */
function demoVoice(): string {
  const found = db().prepare("SELECT rel_path FROM assets WHERE name = 'fuobe-demo-voice.wav' LIMIT 1").get() as { rel_path: string } | undefined;
  if (found) return fileUrl(found.rel_path);
  const rate = 16000;
  const n = rate * 2;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 0.2 * 32767 * Math.min(1, i / 800, (n - i) / 800)), 44 + i * 2);
  return saveFile({ data: buf, contentType: "audio/wav", name: "fuobe-demo-voice.wav", source: "upload" }).url;
}

/**
 * Whether a model's operation would run as a placeholder right now. Nothing connected that runs it (placeholders off)
 * throws the ConnectComfyError, so the caller says to connect something rather than ask for what the real run needs.
 */
function runsAsDemo(modelId: string, op: GenerationRequest["op"]): boolean {
  const m = getModel(modelId);
  if (!m || !op) return true;
  try {
    return chooseRoute(routesFor(m, op)).demo;
  } catch (e) {
    if (e instanceof ConnectComfyError) throw e;
    return false;
  }
}

/**
 * An episode's settings with the video model Settings → Models & licences offers: without a pick, a default that is
 * switched off gives way to the next video choice that is on (a pick that is off stays, and its run names the switch).
 */
export function withOfferedVideo(s: EpisodeSettings): EpisodeSettings {
  if (s.animation === "frames") return s;
  const m = ENGINE_MODELS[s.engine];
  if (s.videoModel && m.videoChoices.includes(s.videoModel)) return s;
  const id = firstOn([m.video, ...m.videoChoices], s.engine);
  return !id || id === m.video ? s : { ...s, videoModel: id };
}

/**
 * An episode's settings with the music bed model Settings → Models & licences offers, as the settings show it: the pick
 * while it is on, else the engine's default, else the first bed model that is on. A bed switched off after an episode
 * picked it gives way, rather than stopping the film at its music.
 */
export function withOfferedMusic(s: EpisodeSettings): EpisodeSettings {
  if (!s.music) return s;
  const m = ENGINE_MODELS[s.engine];
  const picked = s.musicModel && m.musicChoices.includes(s.musicModel) ? s.musicModel : undefined;
  const id = firstOn([...(picked ? [picked] : []), m.music, ...m.musicChoices], s.engine);
  return !id || id === (picked ?? m.music) ? s : { ...s, musicModel: id };
}

/** An episode's settings with the video and music bed models that are on (withOfferedVideo, withOfferedMusic). */
export const withOfferedModels = (s: EpisodeSettings): EpisodeSettings => withOfferedMusic(withOfferedVideo(s));

function graphInput(ep: FacelessEpisode, blocks = ep.script.blocks, stillEdits?: StillEdits): GraphInput {
  const genre = genreInfo(ep.channelId ? getChannel(ep.channelId)?.genre : "education");
  const s = withOfferedModels(ep.settings);
  const narration = ENGINE_MODELS[s.engine].narration;
  let fallbackVoice: string | undefined;
  if (s.engine === "open" && s.voice?.kind !== "sample") {
    if (!runsAsDemo(narration, "tts")) throw new FacelessError("Pick the narrator's voice: record or upload 10–60 s of speech, or use one of your saved voices (open-source narration clones a voice)");
    fallbackVoice = demoVoice();
  }
  return { feature: ep.kind, title: ep.title, genre, settings: s, blocks, stillEdits, fallbackVoice };
}

function buildGraph(ep: FacelessEpisode, blocks = ep.script.blocks, stillEdits?: StillEdits): GraphStep[] {
  try {
    return buildEpisodeGraph(graphInput(ep, blocks, stillEdits), getModel);
  } catch (e) {
    if (e instanceof FacelessError) throw e;
    if (e instanceof ConnectComfyError) throw e;
    throw new FacelessError((e as Error).message, 422);
  }
}

/** The episode's graph as it renders now: its blocks at their film lengths (once timed) and its picture edits. */
const currentGraph = (ep: FacelessEpisode, blocks = ep.script.blocks) => buildGraph(ep, withTiming(blocks, ep.plan?.timing), ep.plan?.stillEdits);

const previewStep = (s: GraphStep) => previewChained({ ...s.request, ...(s.chain && { chain: s.chain }) }, s.after?.length ?? 0);

/** Every step checked with placeholders for what earlier steps make, and one mode for all: nothing is created when one can't run. */
function validate(steps: GraphStep[]): void {
  const previews = steps.map((s) => {
    try {
      return { label: s.label, ...previewStep(s) };
    } catch (e) {
      if (e instanceof ConnectComfyError) throw e;
      throw new FacelessError(`${s.label}: ${(e as Error).message}`, 422);
    }
  });
  const demo = previews.find((p) => p.demo);
  const real = previews.find((p) => !p.demo);
  if (demo && real) throw new FacelessError(`${demo.label} would run as a demo (${demo.model.name} isn't connected) while ${real.label} runs for real — connect it in Settings, or turn on demo mode`, 422);
}

/**
 * Create the `rerun` steps of a graph, waiting on the new ones or on the current generations of the
 * steps they reuse. They're all checked first, so a bad step creates nothing.
 */
function relaunch(graph: GraphStep[], ids: Record<string, string>, rerun: string[], batchId: string): Record<string, string> {
  const todo = new Set(rerun);
  const steps = graph.filter((s) => todo.has(s.key));
  for (const s of steps) {
    for (const a of s.after ?? []) {
      if (!todo.has(a) && !ids[a]) throw new FacelessError(`“${graph.find((x) => x.key === a)?.label ?? a}” has no result to reuse — try again`, 409);
    }
  }
  validate(steps);
  const next = { ...ids };
  const made: Generation[] = [];
  try {
    for (const s of steps) {
      const after = s.after ?? [];
      const [g] = createGenerations({ ...s.request, ...(s.chain && { chain: s.chain }), step: s.request.step ?? { label: s.label, index: 0, of: 1 } }, { batchId, ...(after.length && { dependsOn: after.map((k) => next[k]) }) });
      next[s.key] = g.id;
      made.push(g);
    }
  } catch (e) {
    for (const g of made) void cancelGeneration(g.id);
    if (e instanceof ConnectComfyError) throw e;
    throw new FacelessError((e as Error).message, 422);
  }
  return next;
}

/** Only the steps the graph has (a re-timed scene may have fewer shots, a refolded join other keys). */
const prune = (ids: Record<string, string>, graph: GraphStep[]) => {
  const keys = new Set(graph.map((s) => s.key));
  return Object.fromEntries(Object.entries(ids).filter(([k]) => keys.has(k)));
};

const partOf = (graph: GraphStep[]) => {
  const m = new Map(graph.map((s) => [s.key, s.part]));
  return (k: string) => m.get(k)!;
};

/**
 * Start `changed` and everything after it. While the scenes aren't timed yet (the first render), or
 * when the narration is read again, only the pictures, the narration and its timing start now: the
 * rest waits for `advance`, which cuts the scenes to the new timing first.
 */
function launch(ep: FacelessEpisode, graph: GraphStep[], ids: Record<string, string>, changed: string[], batchId: string): { ids: Record<string, string>; awaiting: boolean; started: number } {
  const { rerun } = planRerun(graph, changed);
  const part = partOf(graph);
  const needsTiming = !ep.plan?.timing || !!ep.plan.awaiting || rerun.includes("words");
  if (!needsTiming) return { ids: prune(relaunch(graph, ids, rerun, batchId), graph), awaiting: false, started: rerun.length };
  const now = rerun.filter((k) => TIMING_PARTS.has(part(k)));
  const next = relaunch(graph, ids, now, batchId);
  for (const k of rerun) if (!TIMING_PARTS.has(part(k))) delete next[k];
  return { ids: prune(next, graph), awaiting: true, started: now.length };
}

/** The narration's timed words: forced alignment or ASR cues (null for a demo transcript or none). */
function narrationCues(ep: FacelessEpisode): TimedText[] | null {
  const words = getGeneration(ep.plan?.ids.words ?? "", { includeDeleted: true });
  const out = words?.status === "succeeded" ? words.outputs.find((o) => o.kind === "text") : undefined;
  if (!out || out.meta?.demo) return null;
  return Array.isArray(out.meta?.cues) ? (out.meta.cues as TimedText[]) : null;
}

/**
 * Stage two: the narration is timed, so each scene is cut to where its lines are spoken (sceneTiming),
 * then the clips, joins, music, mix and subtitles are created. After a change, scenes whose length moved
 * by more than RETIME_TOLERANCE are animated again; the others keep their clips. Without usable
 * timings (a demo transcript) the scenes keep their planned lengths.
 */
function advance(ep: FacelessEpisode): FacelessEpisode {
  const plan = ep.plan!;
  const blocks = ep.script.blocks;
  const video = getModel(resolveModels(withOfferedModels(ep.settings), narrationText(blocks).length, getModel).video);
  const cues = narrationCues(ep);
  const spoken = cues ? spokenTimes(blocks, cues) : null;
  const timing = spoken ? sceneTiming(blocks, spoken, video, plan.timing) : (plan.timing ?? plannedTiming(blocks, video));
  const graph = buildGraph(ep, withTiming(blocks, timing), plan.stillEdits);
  const part = partOf(graph);
  const status = statusMap(plan.ids);
  const moved = new Set(blocks.filter((b) => plan.timing?.[b.id] !== timing[b.id]).map((b) => b.id));
  // A step kept from before that the graph now asks for differently is made again too: a bed (or its loop)
  // that no longer fits the film, or a clip made by another model (a Frame by frame episode rendered before
  // its scenes became Ken Burns moves).
  const stale = new Set(staleKeys(graph, plan.ids));
  const changed = graph
    .filter((s) => !plan.ids[s.key] || status[s.key] === "failed" || status[s.key] === "canceled" || stale.has(s.key) || (s.part === "clip" && moved.has(blocks[s.block!].id)))
    .map((s) => s.key);
  const rerun = planRerun(graph, changed).rerun.filter((k) => !TIMING_PARTS.has(part(k)));
  const ids = prune(relaunch(graph, plan.ids, rerun, plan.batchId), graph);
  const next: EpisodePlan = { ...plan, ids, timing, untimed: !spoken, awaiting: false };
  updateEpisodeRow(ep.id, { status: "rendering", error: null, plan_json: JSON.stringify(next) });
  return mustEpisode(ep.id);
}

/** The episode ready to render and its whole graph, checked (nothing is created). */
function renderable(id: string): { ready: FacelessEpisode; blocks: ScriptBlock[]; graph: GraphStep[] } {
  const ep = mustEpisode(id);
  if (ep.status === "writing") throw new FacelessError("The script is still being written", 409);
  if (ep.status === "rendering") throw new FacelessError("This episode is already rendering", 409);
  if (ep.plan) throw new FacelessError(ep.status === "done" ? "This episode is done — change scenes in the timeline" : "This episode already rendered — use Retry", 409);
  const blocks = normalizeBlocks(ep.script.blocks);
  if (!blocks.length) throw new FacelessError("The script has no scenes yet");
  const ready = { ...ep, script: { ...ep.script, blocks } };
  const graph = buildGraph(ready, blocks);
  validate(graph);
  return { ready, blocks, graph };
}

/**
 * A graph's steps as an account's run is checked with them (src/server/account-tool-run.ts ToolStep): each request with
 * its chain, waiting for as many earlier steps as it names. Every step of the graph, so every provider it reaches, its
 * words and its files are checked before the first one starts.
 */
export function graphToolSteps(graph: GraphStep[]): { request: GenerationRequest; deps: number }[] {
  return graph.map((s) => ({ request: { ...s.request, ...(s.chain && { chain: s.chain }) }, deps: s.after?.length ?? 0 }));
}

/** The files a graph's steps read (uploads and results): an account's must all be its own. */
export function graphFiles(graph: GraphStep[]): string[] {
  const files = new Set<string>();
  for (const s of graph) {
    for (const v of Object.values(s.request.inputs ?? {})) for (const x of Array.isArray(v) ? v : [v]) if (typeof x === "string" && x) files.add(x);
  }
  return [...files];
}

/** What "Render" would run (an account's run is checked with it first). */
export const renderGraph = (id: string): GraphStep[] => renderable(id).graph;

/** The settings an episode is stored with: its picture sources set from the explainer's image sources. */
function storedSettings(settings: EpisodeSettings, sources: ExplainerSource[]): EpisodeSettings {
  const s = cleanSettings(settings);
  s.sourceImages = sources.slice(0, MAX_SOURCES).filter((x): x is Extract<ExplainerSource, { kind: "image" }> => x.kind === "image").map((x) => x.url);
  return s;
}

/**
 * The graph an episode that isn't made yet would render with this script: an account's explainer or series episode,
 * checked before anything is made. `genre`: the channel's (one that's made in the same run isn't there yet).
 */
export function draftGraph(input: { kind: "faceless" | "explainer"; channelId?: string | null; title: string; settings: EpisodeSettings; sources?: ExplainerSource[]; script: EpisodeScript; genre?: FacelessGenre }): GraphStep[] {
  const blocks = normalizeBlocks(input.script.blocks);
  if (!blocks.length) throw new FacelessError("The script has no scenes yet");
  const ep: FacelessEpisode = {
    id: "draft",
    channelId: input.channelId ?? null,
    kind: input.kind,
    title: input.title,
    topic: "",
    status: "review",
    error: null,
    settings: storedSettings(input.settings, input.sources ?? []),
    script: { ...input.script, blocks },
    plan: null,
    sources: [],
    favorite: false,
    createdAt: 0,
    updatedAt: 0,
  };
  let graph: GraphStep[];
  try {
    graph = buildEpisodeGraph({ ...graphInput(ep, blocks), ...(input.genre && { genre: genreInfo(input.genre) }) }, getModel);
  } catch (e) {
    if (e instanceof FacelessError || e instanceof ConnectComfyError) throw e;
    throw new FacelessError((e as Error).message, 422);
  }
  validate(graph);
  return graph;
}

/** Start the render: the whole graph is checked first, then stage one (pictures, narration, its timing) starts. */
export function renderEpisode(id: string, batch?: string): FacelessEpisode {
  const { ready, graph } = renderable(id);
  const batchId = batch ?? nanoid(10);
  const { ids, awaiting } = launch(ready, graph, {}, graph.map((s) => s.key), batchId);
  const plan: EpisodePlan = { batchId, ids, awaiting, changes: [] };
  updateEpisodeRow(id, { status: "rendering", error: null, plan_json: JSON.stringify(plan), script_json: JSON.stringify(ready.script) });
  ensureFacelessRunner();
  return mustEpisode(id);
}

const statusMap = (ids: Record<string, string>) =>
  Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, getGeneration(id, { includeDeleted: true })?.status])) as Record<string, string | undefined>;

/** Kept steps whose generation isn't what the graph asks for now (another model or op, a clip of another length, a bed that no longer fits). */
const staleKeys = (graph: GraphStep[], ids: Record<string, string>) => staleSteps(graph, (k) => (ids[k] ? getGeneration(ids[k], { includeDeleted: true })?.request : undefined));

/** Redo the steps that failed (and what waited on them); finished steps are kept. */
export function retryEpisode(id: string): FacelessEpisode {
  const ep = mustEpisode(id);
  if (!ep.plan) return renderEpisode(id);
  const graph = currentGraph(ep);
  const status = statusMap(ep.plan.ids);
  if (Object.values(status).some((s) => s === "queued" || s === "running")) {
    // Steps still waiting on a failed one fail on the runner's next tick; retry those too.
    const live = graph.filter((s) => status[s.key] === "queued" || status[s.key] === "running");
    if (live.some((s) => !s.after?.length || s.after.some((a) => status[a] !== "failed" && status[a] !== "canceled"))) throw new FacelessError("Still rendering — retry once it stops", 409);
  }
  const part = partOf(graph);
  const broken = graph
    .filter((s) => {
      const st = status[s.key];
      // Steps still to come after the timing aren't broken: advance makes them.
      if (!st) return !ep.plan!.awaiting || TIMING_PARTS.has(part(s.key));
      return st === "failed" || st === "canceled" || st === "queued" || st === "running";
    })
    .map((s) => s.key);
  if (!broken.length && !ep.plan.awaiting) return ep;
  // Kept steps made for an older graph (another model, another length) are redone with what failed.
  broken.push(...staleKeys(graph, ep.plan.ids).filter((k) => !broken.includes(k)));
  for (const k of planRerun(graph, broken).rerun) if (ep.plan.ids[k]) void cancelGeneration(ep.plan.ids[k]);
  const { ids, awaiting, started } = launch(ep, graph, ep.plan.ids, broken, ep.plan.batchId);
  updateEpisodeRow(id, { status: "rendering", error: null, plan_json: JSON.stringify({ ...ep.plan, ids, awaiting } satisfies EpisodePlan) });
  ensureFacelessRunner();
  // Everything before the timing is there (it was stage two that couldn't start): start it now.
  if (awaiting && !started) {
    try {
      return advance(mustEpisode(id));
    } catch (e) {
      updateEpisodeRow(id, { status: "failed", error: (e as Error).message });
      throw e instanceof FacelessError ? e : new FacelessError((e as Error).message, 422);
    }
  }
  return mustEpisode(id);
}

// ---------------------------------------------------------------------------
// The timeline editor

export interface ChangeInput {
  blocks: string[];
  part: ChangePart;
  /** Picture / motion: what to change. */
  instruction?: string;
  /** Narration: the block's new lines (one per block). */
  narration?: string[];
}

/** What "Retry" would run, at most (an account's run is checked with it first): the episode's graph as it renders now. */
export function retryGraph(id: string): GraphStep[] {
  const ep = mustEpisode(id);
  return ep.plan ? currentGraph(ep) : renderGraph(id);
}

/** The steps a change would run (an account's run is checked with them first). */
export function changeGraph(id: string, c: ChangeInput): GraphStep[] {
  const { graph, plan } = changed(mustEpisode(id), c);
  const rerun = new Set(plan.rerun);
  return graph.filter((s) => rerun.has(s.key));
}

/** The blocks, picture edits and graph a change would render, and the steps it touches. */
function changed(ep: FacelessEpisode, c: ChangeInput) {
  if (!ep.plan) throw new FacelessError("Render the episode first", 409);
  const ids = c.blocks.filter((b) => ep.script.blocks.some((x) => x.id === b));
  if (!ids.length) throw new FacelessError("Pick a scene to change");
  const instruction = c.instruction?.trim() ?? "";
  let blocks = ep.script.blocks;
  const stillEdits: StillEdits = { ...ep.plan.stillEdits };
  if (c.part === "narration") {
    if (!c.narration || c.narration.length !== ids.length || c.narration.some((n) => !n.trim())) throw new FacelessError("Write the new lines for each scene");
    blocks = blocks.map((b) => (ids.includes(b.id) ? { ...b, narration: c.narration![ids.indexOf(b.id)].replace(/\s+/g, " ").trim() } : b));
  } else {
    if (!instruction) throw new FacelessError(c.part === "picture" ? "Describe what to change in the picture" : "Describe the new movement");
    if (c.part === "motion") blocks = blocks.map((b) => (ids.includes(b.id) ? { ...b, motion: instruction } : b));
    if (c.part === "picture") {
      for (const b of ids) {
        const still = getGeneration(ep.plan.ids[`still-${b}`] ?? "");
        const source = still?.status === "succeeded" ? still.outputs.find((o) => o.kind === "image")?.url : undefined;
        if (source) stillEdits[b] = { source, instruction };
        else delete stillEdits[b];
      }
      // A picture that never rendered is made again from its description plus the change.
      blocks = blocks.map((b) => (ids.includes(b.id) && !stillEdits[b.id] ? { ...b, visual: `${b.visual}. ${instruction}` } : b));
    }
  }
  const graph = buildGraph(ep, withTiming(blocks, ep.plan.timing), stillEdits);
  // Frame by frame: words that read as the move the scene already has would render the same clip again.
  if (c.part === "motion") {
    const moves = graph.filter((s) => s.part === "clip" && s.request.op === "still-motion" && ids.includes(blocks[s.block!].id));
    const same = moves.every((s) => {
      const g = getGeneration(ep.plan!.ids[s.key] ?? "", { includeDeleted: true });
      return g?.status === "succeeded" && sameCameraMove(g.request, s.request);
    });
    if (moves.length && same) throw new FacelessError(CAMERA_WORDS[ep.settings.engine].same, 422);
  }
  // Steps that failed earlier are redone with the change, so the new version can finish; so are kept steps
  // made for an older graph (another model, another length).
  const status = statusMap(ep.plan.ids);
  const part = partOf(graph);
  const broken = graph.filter((s) => (!status[s.key] && (!ep.plan!.awaiting || TIMING_PARTS.has(part(s.key)))) || status[s.key] === "failed" || status[s.key] === "canceled").map((s) => s.key);
  const keys = [...new Set([...changedKeys(graph, ids, c.part), ...broken, ...staleKeys(graph, ep.plan.ids)])];
  return { graph, blocks, stillEdits, keys, plan: planRerun(graph, keys), ids };
}

export function previewChange(id: string, c: ChangeInput): ChangePreview {
  const ep = mustEpisode(id);
  const { graph, plan } = changed(ep, c);
  const est = estimateGraph(graph, getModel, plan.rerun);
  const demo = plan.rerun.some((k) => {
    try {
      return previewStep(graph.find((x) => x.key === k)!).demo;
    } catch {
      return false;
    }
  });
  return {
    rerun: plan.rerun,
    labels: plan.rerun.map((k) => graph.find((s) => s.key === k)!.label),
    costUsd: est.unknown ? null : est.total,
    demo,
    ...(plan.rerun.includes("words") && { retime: true }),
  };
}

/** Re-run what the change touches (that block's steps, the joins after it, the mix, the subtitles); Undo keeps the version before. */
export function applyChange(id: string, c: ChangeInput): FacelessEpisode {
  const ep = mustEpisode(id);
  if (ep.status === "rendering") throw new FacelessError("Wait for the current render to finish before changing scenes", 409);
  const { graph, blocks, stillEdits, keys, plan, ids } = changed(ep, c);
  const est = estimateGraph(graph, getModel, plan.rerun);
  const next = launch({ ...ep, script: { ...ep.script, blocks } }, graph, ep.plan!.ids, keys, ep.plan!.batchId);
  const final = getGeneration(ep.plan!.ids[finalKeyOf(ep)] ?? "");
  const p = ep.plan!;
  const updated: EpisodePlan = {
    ...p,
    ids: next.ids,
    awaiting: next.awaiting,
    stillEdits,
    previous: { ids: p.ids, blocks: ep.script.blocks, stillEdits: p.stillEdits, timing: p.timing, untimed: p.untimed, awaiting: p.awaiting },
    lastFinal: final?.status === "succeeded" ? final.id : p.lastFinal,
    // A new version: its upscale (or regenerated film) is made again on request.
    upscaled: undefined,
    regenerated: undefined,
    changes: [...p.changes, { at: Date.now(), blocks: ids, part: c.part, instruction: c.part === "narration" ? (c.narration ?? []).join(" / ") : (c.instruction ?? ""), costUsd: est.unknown ? null : est.total }].slice(-50),
  };
  updateEpisodeRow(id, { status: "rendering", error: null, plan_json: JSON.stringify(updated), script_json: JSON.stringify({ ...ep.script, blocks }) });
  ensureFacelessRunner();
  return mustEpisode(id);
}

/** Back to the version before the last change: the newer steps still running are stopped (nothing is refunded). */
export function undoChange(id: string): FacelessEpisode {
  const ep = mustEpisode(id);
  const prev = ep.plan?.previous;
  if (!prev) throw new FacelessError("Nothing to undo", 409);
  for (const [k, gid] of Object.entries(ep.plan!.ids)) if (prev.ids[k] !== gid) void cancelGeneration(gid);
  const changes = [...ep.plan!.changes];
  const last = changes.map((x) => !x.undone).lastIndexOf(true);
  if (last >= 0) changes[last] = { ...changes[last], undone: true };
  const plan: EpisodePlan = {
    ...ep.plan!,
    ids: prev.ids,
    stillEdits: prev.stillEdits,
    timing: prev.timing,
    untimed: prev.untimed,
    awaiting: prev.awaiting,
    previous: undefined,
    lastFinal: undefined,
    upscaled: undefined,
    regenerated: undefined,
    changes,
  };
  updateEpisodeRow(id, { status: "rendering", error: null, plan_json: JSON.stringify(plan), script_json: JSON.stringify({ ...ep.script, blocks: prev.blocks }) });
  return mustEpisode(id);
}

// ---------------------------------------------------------------------------
// Upscale to 1080p

/** SeedVR2 bills per megapixel of output video: 1920 × 1080 at the clips' 24 fps. */
const UPSCALE_FPS = 24;
const UPSCALE_MP = (1920 * 1080) / 1e6;

function upscaleOffer(ep: FacelessEpisode, seconds: number): EpisodeView["upscale"] {
  const modelId = ENGINE_MODELS[ep.settings.engine].upscale;
  const model = modelId ? getModel(modelId) : undefined;
  if (!model) return null;
  let demo = false;
  try {
    demo = runsAsDemo(model.id, "upscale-video");
  } catch {
    // Nothing connected runs the upscale yet: offered at its price, and the click opens the connect card.
  }
  const p = model.pricing && pricingAt(model.pricing);
  const costUsd = demo || model.engine === "open" ? 0 : p?.unit === "megapixel" ? Math.round(p.usd * UPSCALE_MP * UPSCALE_FPS * seconds * 100) / 100 : p?.unit === "second" ? Math.round(p.usd * seconds * 100) / 100 : null;
  return { costUsd, demo };
}

/** "Upscale to 1080p": one upscale step on the finished film, offered as the download once it's done. */
export function upscaleEpisode(id: string): FacelessEpisode {
  const ep = mustEpisode(id);
  const up = upscaleStep(ep);
  if (!up) return ep;
  let g: Generation;
  try {
    [g] = createGenerations(up.request, { batchId: ep.plan!.batchId, dependsOn: up.final.id });
  } catch (e) {
    if (e instanceof ConnectComfyError) throw e;
    throw new FacelessError((e as Error).message, 422);
  }
  updateEpisodeRow(id, { plan_json: JSON.stringify({ ...ep.plan!, upscaled: g.id } satisfies EpisodePlan) });
  return mustEpisode(id);
}

/** The upscale step on the finished film, or null when one is made or making already. */
function upscaleStep(ep: FacelessEpisode): { request: GenerationRequest; final: Generation } | null {
  const modelId = ENGINE_MODELS[ep.settings.engine].upscale;
  if (!modelId) throw new FacelessError("This engine has no video upscaler", 422);
  const final = finalOf(ep);
  if (!ep.plan || !final) throw new FacelessError("Wait for the episode to finish first", 409);
  const had = ep.plan.upscaled ? getGeneration(ep.plan.upscaled) : null;
  if (had && had.status !== "failed" && had.status !== "canceled") return null;
  const request: GenerationRequest = { feature: ep.kind, modelId, op: "upscale-video", params: { resolution: "1080p" }, chain: [{ slot: "video" }], title: `${ep.title} · 1080p`, batchTitle: ep.title, step: { label: "Upscale to 1080p", index: 0, of: 1 } };
  return { request, final };
}

/** What "Upscale to 1080p" would run (an account's run is checked with it first): nothing when it's made or making. */
export function upscaleToolSteps(id: string): { request: GenerationRequest; deps: number }[] {
  const up = upscaleStep(mustEpisode(id));
  return up ? [{ request: up.request, deps: 1 }] : [];
}

// ---------------------------------------------------------------------------
// Regenerate to 1080p (open engine)

/** "Regenerate to 1080p" on this episode: offered on the open engine once the film is done (null otherwise). */
function regenerateOffer(ep: FacelessEpisode, scenes: number): EpisodeView["regenerate"] {
  const modelId = ENGINE_MODELS[ep.settings.engine].regenerate;
  // Open-H3 Regenerate needs a 48 GB card: offered with its label (own-setup.ts "regenerate:faceless"); an account's run
  // goes to its own GPU only (regenerateEpisode), the owner's once it is offered.
  if (!modelId || !getModel(modelId)) return null;
  let demo = false;
  try {
    demo = runsAsDemo(modelId, "upscale-video");
  } catch {
    // Nothing connected runs it yet: offered, and the click opens the connect card.
  }
  return { scenes, demo };
}

const REGENERATE_OPEN_ONLY = "Regenerate runs on your GPU (open source): switch the episode to open source to use it";
const REGENERATE_WAIT = "Wait for the episode to finish first";

/** Regenerate to 1080p has run on this episode, or is running. */
function regeneratedAlready(ep: FacelessEpisode): boolean {
  const had = ep.plan?.regenerated ? getGeneration(ep.plan.regenerated.final) : null;
  return !!had && had.status !== "failed" && had.status !== "canceled";
}

/** What "Regenerate to 1080p" would run (an account's run is checked with it first): none once it has run or is running. */
export function regenerateToolSteps(id: string): { request: GenerationRequest; deps: number }[] {
  const ep = mustEpisode(id);
  if (!ENGINE_MODELS[ep.settings.engine].regenerate) throw new FacelessError(REGENERATE_OPEN_ONLY, 422);
  if (!ep.plan || !finalOf(ep)) throw new FacelessError(REGENERATE_WAIT, 409);
  if (regeneratedAlready(ep)) return [];
  const models = resolveModels(withOfferedVideo(ep.settings), narrationText(ep.script.blocks).length, getModel);
  let plan: ReturnType<typeof regeneratePlan>;
  try {
    plan = regeneratePlan(currentGraph(ep), { engine: ep.settings.engine, joinMax: models.joinMax, lookup: getModel });
  } catch (e) {
    throw new FacelessError((e as Error).message, 422);
  }
  return plan.steps.map((s) => ({ request: { ...s.request, ...(s.chain && { chain: s.chain }) }, deps: s.after?.length ?? 0 }));
}

/**
 * "Regenerate to 1080p": every scene redrawn by Open-H3 Regenerate (RIFE first for a 16 fps clip), joined at 1080p, with
 * the episode's own narration, music bed and subtitles put back on (regeneratePlan). Runs on your GPU only; the finished
 * film becomes the download once it's done, beside "Upscale to 1080p".
 */
export function regenerateEpisode(id: string): FacelessEpisode {
  const ep = mustEpisode(id);
  // Made or making already: the episode as it is (before any gate: nothing new runs).
  if (regeneratedAlready(ep)) return ep;
  // Open-H3 Regenerate needs a 48 GB card: an account runs it on its own GPU when that GPU fits it (own-setup-run.ts),
  // never on this studio's. The owner's waits until it has run on a card that fits it (REGEN_OFFERED): nothing is made.
  if (tenant()) ownSetupGate("regenerate:faceless");
  else if (!REGEN_OFFERED) throw new FacelessError(REGEN_COPY.heldEpisode, 422);
  if (!ENGINE_MODELS[ep.settings.engine].regenerate) throw new FacelessError(REGENERATE_OPEN_ONLY, 422);
  const final = finalOf(ep);
  if (!ep.plan || !final) throw new FacelessError(REGENERATE_WAIT, 409);
  const graph = currentGraph(ep);
  const models = resolveModels(withOfferedVideo(ep.settings), narrationText(ep.script.blocks).length, getModel);
  let plan: ReturnType<typeof regeneratePlan>;
  try {
    plan = regeneratePlan(graph, { engine: ep.settings.engine, joinMax: models.joinMax, lookup: getModel });
  } catch (e) {
    throw new FacelessError((e as Error).message, 422);
  }
  const existing: Record<string, string> = {};
  for (const k of regenerateReuses(plan.steps)) {
    const gid = ep.plan.ids[k];
    if (!gid || getGeneration(gid)?.status !== "succeeded") throw new FacelessError(`“${graph.find((s) => s.key === k)?.label ?? k}” has no result to reuse — retry the episode first`, 409);
    existing[k] = gid;
  }
  let made: Record<string, string>;
  try {
    const pipeline = createPipeline(plan.steps, { batchId: ep.plan.batchId, existing });
    made = Object.fromEntries(plan.steps.map((s) => [s.key, pipeline.byKey[s.key].id]));
  } catch (e) {
    if (e instanceof ConnectComfyError) throw e;
    throw new FacelessError((e as Error).message, 422);
  }
  updateEpisodeRow(id, { plan_json: JSON.stringify({ ...ep.plan, regenerated: { ids: made, final: made[plan.final] } } satisfies EpisodePlan) });
  return mustEpisode(id);
}

// ---------------------------------------------------------------------------
// Reading, and the sweep that starts stage two

/** The step whose output is the finished episode. */
const finalKeyOf = (ep: FacelessEpisode) => (ep.settings.subtitles ? "captions" : "mix");

function finalOf(ep: FacelessEpisode): Generation | null {
  if (!ep.plan || ep.plan.awaiting) return null;
  const g = getGeneration(ep.plan.ids[finalKeyOf(ep)] ?? "");
  return g?.status === "succeeded" ? g : null;
}

const brokenMessage = (g: Generation | null) =>
  !g ? "A step was deleted — retry to make it again" : g.status === "canceled" ? "A step was cancelled — retry to make it again" : (g.error ?? "A step didn't finish — retry it");

/**
 * The episode's status from its generations (saved when it changes). Once stage one has finished, the
 * first look starts stage two (advance).
 */
function settle(ep: FacelessEpisode, gens?: Map<string, Generation | null>): FacelessEpisode {
  if (ep.status === "writing" && !writing().has(ep.id)) {
    // A restart while the script was being written.
    const error = "Interrupted while writing the script — try again";
    updateEpisodeRow(ep.id, { status: "write-failed", error });
    return { ...ep, status: "write-failed", error };
  }
  if (!ep.plan || ep.status === "writing" || ep.status === "write-failed" || ep.status === "review") return ep;
  const read = (id: string) => (gens?.has(id) ? gens.get(id)! : getGeneration(id, { includeDeleted: true }));
  const list = Object.entries(ep.plan.ids).map(([k, id]) => [k, read(id)] as const);
  const active = list.some(([, g]) => g && (g.status === "queued" || g.status === "running"));
  const broken = list.find(([, g]) => !g || g.status === "failed" || g.status === "canceled");
  let status: EpisodeStatus;
  let error: string | null = null;
  if (ep.plan.awaiting) {
    if (!active && !broken && ep.status !== "failed") {
      try {
        return settle(advance(ep));
      } catch (e) {
        status = "failed";
        error = (e as Error).message;
      }
    } else status = active ? "rendering" : "failed";
    if (status === "failed") error ??= ep.status === "failed" && !broken ? ep.error : brokenMessage(broken?.[1] ?? null);
  } else {
    const final = list.find(([k]) => k === finalKeyOf(ep))?.[1];
    status = final?.status === "succeeded" ? "done" : !active && broken ? "failed" : "rendering";
    if (status === "failed") error = brokenMessage(broken![1]);
  }
  if (status !== ep.status || error !== ep.error) updateEpisodeRow(ep.id, { status, error });
  return { ...ep, status, error };
}

declare global {
  var __fuobeFacelessRunner: { timer: NodeJS.Timeout; tick: () => void } | undefined;
}

const SWEEP_MS = 2000;

/** Episodes whose stage one has finished get stage two, even when nobody has them open. */
function sweep(): void {
  const rows = db().prepare("SELECT * FROM faceless_episodes WHERE status = 'rendering' AND plan_json LIKE '%\"awaiting\":true%'").all() as EpisodeRow[];
  for (const r of rows) {
    try {
      // An account's episode goes on as its own work: its steps stamped as its runs, on its own GPU or key.
      const owner = episodeOwner(r);
      if (owner) asAccount(owner, () => settle(toEpisode(r)));
      else settle(toEpisode(r));
    } catch (e) {
      console.warn(`[faceless] couldn't continue ${r.id}: ${(e as Error).message}`);
    }
  }
}

/** Start the background sweep (once per process: at boot, and whenever a render starts). */
export function ensureFacelessRunner(): void {
  const cur = globalThis.__fuobeFacelessRunner;
  if (cur) {
    // After a dev hot reload, point the timer at this module's code.
    cur.tick = sweep;
    return;
  }
  const state = { tick: sweep, timer: setInterval(() => globalThis.__fuobeFacelessRunner?.tick(), SWEEP_MS) };
  state.timer.unref?.();
  globalThis.__fuobeFacelessRunner = state;
}

const stepProgress = (g: Generation | null) => (!g ? 0 : g.status === "succeeded" ? 1 : g.status === "running" ? Math.max(0.05, Math.min(0.95, g.progress ?? 0.1)) : 0);

export function episodeView(id: string): EpisodeView {
  const current = settle(mustEpisode(id));
  const gens = new Map<string, Generation | null>();
  for (const gid of Object.values(current.plan?.ids ?? {})) gens.set(gid, getGeneration(gid));
  let graph: GraphStep[] = [];
  try {
    if (current.script.blocks.length) graph = buildEpisodeGraph({ ...graphInputSafe(current), blocks: withTiming(current.script.blocks, current.plan?.timing), stillEdits: current.plan?.stillEdits }, getModel);
  } catch {
    graph = [];
  }
  const plan = current.plan;
  const steps = graph.map((s) => ({ key: s.key, part: s.part, block: s.block, label: s.label, generation: plan?.ids[s.key] ? (gens.get(plan.ids[s.key]) ?? null) : null }));
  const final = finalOf(current);
  const previousFinal = !final && plan?.lastFinal ? getGeneration(plan.lastFinal) : null;
  const spent = [...gens.values()].reduce((n, g) => n + (g && g.status !== "failed" && g.status !== "canceled" ? (g.costUsd ?? 0) : 0), 0);
  const spans = sceneSpans(graph, current.script.blocks.length);
  const upscaled = plan?.upscaled ? getGeneration(plan.upscaled) : null;
  const regenIds = Object.values(plan?.regenerated?.ids ?? {});
  const regenerated = plan?.regenerated ? getGeneration(plan.regenerated.final) : null;
  return {
    episode: current,
    channel: current.channelId ? getChannel(current.channelId) : null,
    steps,
    final,
    previousFinal: previousFinal?.status === "succeeded" ? previousFinal : null,
    progress: steps.length && plan ? steps.reduce((n, s) => n + stepProgress(s.generation), 0) / steps.length : 0,
    spentUsd: Math.round(spent * 100) / 100,
    estimate: graph.length ? estimateGraph(graph, getModel) : null,
    scenes: current.script.blocks.map((b, i) => ({ id: b.id, start: spans[i]?.start ?? 0, seconds: spans[i]?.seconds ?? b.seconds })),
    timing: plan?.timing && !plan.untimed ? "narration" : "planned",
    upscaled,
    upscale: final ? upscaleOffer(current, spans.reduce((n, s) => n + s.seconds, 0)) : null,
    regenerated,
    regenerating: regenerated && (regenerated.status === "queued" || regenerated.status === "running") ? { done: regenIds.filter((g) => getGeneration(g)?.status === "succeeded").length, of: regenIds.length } : null,
    regenerate: final ? regenerateOffer(current, steps.filter((s) => s.part === "clip").length) : null,
  };
}

/** The graph input for reading (never throws for a missing open voice: the view just shows the plan). */
function graphInputSafe(ep: FacelessEpisode): GraphInput {
  try {
    return graphInput(ep);
  } catch {
    return { feature: ep.kind, title: ep.title, genre: genreInfo(ep.channelId ? getChannel(ep.channelId)?.genre : "education"), settings: withOfferedModels(ep.settings), blocks: ep.script.blocks, fallbackVoice: "/api/files/placeholder.wav" };
  }
}

function toCard(r: EpisodeRow): EpisodeCard {
  const ep = settle(toEpisode(r));
  const ids = Object.values(ep.plan?.ids ?? {});
  const gens = new Map(ids.map((id) => [id, getGeneration(id)] as const));
  const final = finalOf(ep);
  const firstStill = ep.plan ? (gens.get(ep.plan.ids[`still-${ep.script.blocks[0]?.id}`] ?? "") ?? null) : null;
  const timed = ep.plan?.timing;
  return {
    id: ep.id,
    channelId: ep.channelId,
    kind: ep.kind,
    title: ep.title,
    status: ep.status,
    styleId: ep.settings.styleId,
    ownStyle: ep.settings.styleRefs.length > 0,
    styleRef: ep.settings.styleRefs[0] ?? null,
    aspect: ep.settings.aspect,
    seconds: (timed ? Object.values(timed).reduce((a, b) => a + b, 0) : totalSeconds(ep.script.blocks)) || ep.settings.length,
    favorite: ep.favorite,
    poster: final,
    still: firstStill?.status === "succeeded" ? firstStill : null,
    updating: ep.status === "rendering" && !!ep.plan?.lastFinal,
    progress: ids.length ? [...gens.values()].reduce((n, g) => n + stepProgress(g ?? null), 0) / ids.length : 0,
    createdAt: ep.createdAt,
  };
}

export function listEpisodes(o: { channelId?: string; kind?: "faceless" | "explainer"; q?: string; liked?: boolean; limit?: number }): EpisodeCard[] {
  // Whoever the work is for: an account's own episodes, or the owner's.
  const scope = episodeScope();
  const where: string[] = [scope.sql];
  const args: unknown[] = [...scope.args];
  if (o.channelId) {
    where.push("channel_id = ?");
    args.push(o.channelId);
  }
  if (o.kind) {
    where.push("kind = ?");
    args.push(o.kind);
  }
  if (o.liked) where.push("favorite = 1");
  const q = o.q?.trim();
  if (q) {
    where.push("(title LIKE ? OR topic LIKE ?)");
    args.push(`%${q}%`, `%${q}%`);
  }
  const rows = db()
    .prepare(`SELECT * FROM faceless_episodes WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
    .all(...args, Math.max(1, Math.min(o.limit ?? 60, 200))) as EpisodeRow[];
  return rows.map(toCard);
}

// ---------------------------------------------------------------------------
// Estimates, voices, links

/** What an episode would cost and whether it would run as a demo, before or after the script exists. */
export function estimateEpisode(input: { kind: "faceless" | "explainer"; settings: EpisodeSettings; blocks?: Partial<ScriptBlock>[]; genre?: FacelessGenre }): EstimateResult {
  const settings = { ...input.settings, styleRefs: input.settings.styleRefs.slice(0, 3) };
  const blocks = input.blocks?.length ? normalizeBlocks(input.blocks) : placeholderBlocks(settings.auto ? AUTO_SECONDS : settings.length, settings.brief?.sceneSeconds);
  const fake: FacelessEpisode = {
    id: "estimate",
    channelId: null,
    kind: input.kind,
    title: "Estimate",
    topic: "",
    status: "review",
    error: null,
    settings,
    script: { blocks, source: "ai" },
    plan: null,
    sources: [],
    favorite: false,
    createdAt: 0,
    updatedAt: 0,
  };
  let graph: GraphStep[];
  try {
    graph = buildEpisodeGraph({ ...graphInputSafe(fake), genre: genreInfo(input.genre) }, getModel);
  } catch (e) {
    return { estimate: { total: 0, parts: {}, unknown: true }, demo: true, seconds: totalSeconds(blocks), blocks: blocks.length, error: (e as Error).message };
  }
  const seconds = sceneSpans(graph, blocks.length).reduce((n, s) => n + s.seconds, 0);
  let error: string | undefined;
  let demo = false;
  try {
    cleanSettings(settings);
    if (settings.engine === "open" && settings.voice?.kind !== "sample" && !runsAsDemo(ENGINE_MODELS.open.narration, "tts")) {
      error = "Pick the narrator's voice: record or upload 10–60 s of speech, or use one of your saved voices";
    }
  } catch (e) {
    error = (e as Error).message;
  }
  // Every distinct model once is enough to know the mode (and to catch a step the install can't run).
  const seen = new Set<string>();
  for (const s of graph) {
    const k = `${s.request.modelId}:${s.part}`;
    if (seen.has(k)) continue;
    seen.add(k);
    try {
      demo ||= previewStep(s).demo;
    } catch (e) {
      error ??= `${s.label}: ${(e as Error).message}`;
    }
  }
  return { estimate: estimateGraph(graph, getModel), demo, seconds, blocks: blocks.length, ...(error && { error }), ...notesFor(settings, seconds) };
}

/** What the render will do differently from what was asked (nothing that stops it). */
function notesFor(settings: EpisodeSettings, seconds: number): { notes?: string[] } {
  const notes: string[] = [];
  const m = resolveModels(withOfferedModels(settings), 0, getModel);
  const limit = styleRefLimit(settings.engine, getModel);
  if (settings.styleRefs.length > limit) notes.push(`The open-source picture model follows the first ${limit} style references.`);
  if (settings.engine === "open" && settings.styleRefs.length && settings.sourceImages?.length) notes.push("Your style references set the look; the attached images aren't used for the open-source pictures.");
  if (m.music) {
    const clip = clipBedFor(settings);
    const plan = musicPlan(getModel(m.music), m.loop ? getModel(m.loop) : undefined, seconds, clip?.seconds);
    const minutes = (s: number) => (s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min${Math.round(s % 60) ? ` ${Math.round(s % 60)} s` : ""}`);
    if (clip) notes.push("The music bed is your clip's soundtrack with the talking taken out.");
    if (clip && plan.loop?.crossfade) notes.push(`Your clip is ${minutes(plan.bed)} long, so its soundtrack loops with a ${plan.loop.crossfade}-second crossfade to cover the film.`);
    else if (plan.loop?.crossfade) notes.push(`The music is made ${minutes(plan.bed)} long, then looped with a ${plan.loop.crossfade}-second crossfade to cover the film.`);
    else if (plan.loop) notes.push(`The music is made ${minutes(plan.bed)} long and plays again to cover the film.`);
    if (plan.short) notes.push(`The music bed goes up to ${minutes(plan.loop?.duration ?? plan.bed)}, so the last ${plan.short} s play without music.`);
  }
  return notes.length ? { notes } : {};
}

/** A short sample of a premade narrator (one cheap speech generation, reused once made). */
export function voicePreview(voice: NarratorVoice & { kind: "preset" }): Generation {
  const p = voicePreviewPlan(voice);
  return "made" in p ? p.made : createGenerations(p.request)[0];
}

/**
 * The narrator sample made before (only the asker's own: an account's, or the owner's), or the one speech generation that
 * makes it (an account's run is checked with it first).
 */
export function voicePreviewPlan(voice: NarratorVoice & { kind: "preset" }): { made: Generation } | { request: GenerationRequest } {
  const modelId = ENGINE_MODELS.cloud.narration;
  const model = getModel(modelId)!;
  const v = model.options.voices?.find((x) => x.id === voice.id);
  if (!v) throw new FacelessError("Unknown voice");
  const existing = db()
    .prepare(
      "SELECT g.id FROM generations g LEFT JOIN generation_trash t ON t.generation_id = g.id WHERE t.deleted_at IS NULL AND g.feature = 'faceless-voice' AND g.model_id = ? AND json_extract(g.request_json, '$.params.voice') = ? AND COALESCE(json_extract(g.request_json, '$.account'), '') = ? AND g.status IN ('queued', 'running', 'succeeded') ORDER BY g.created_at DESC LIMIT 1",
    )
    .get(modelId, v.id, tenantAccount() ?? "") as { id: string } | undefined;
  const found = existing && getGeneration(existing.id);
  if (found) return { made: found };
  return { request: { feature: "faceless-voice", modelId, op: "tts", prompt: previewLine(v.name), params: { voice: v.id }, title: `${v.name} · narrator sample` } };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Readable text of an HTML page: title plus paragraphs, scripts and styles dropped. */
export function pageText(html: string): { title: string | null; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i.exec(html)?.[1] ?? null;
  const body = html
    .replace(/<(head|script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|section|article|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (m, e: string) =>
      e.startsWith("#x") ? String.fromCodePoint(parseInt(e.slice(2), 16)) : e.startsWith("#") ? String.fromCodePoint(Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m),
    )
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 2)
    .join("\n");
  const decode = (s: string) => s.replace(/&(\w+);/g, (m, e: string) => ENTITIES[e.toLowerCase()] ?? m).replace(/\s+/g, " ").trim();
  return { title: title ? decode(title) : null, text: body };
}

/** A link source for the Explainer: fetched with the SSRF-safe fetch, then summarised for the writer. */
export async function summarizeLink(url: string, engine: Engine): Promise<Extract<ExplainerSource, { kind: "link" }>> {
  let res: Awaited<ReturnType<typeof fetchRemote>>;
  try {
    res = await fetchRemote(url, { maxBytes: 5 * 1024 * 1024, timeoutMs: 15_000 });
  } catch (e) {
    throw new FacelessError((e as Error).message || "Couldn't open that link", 422);
  }
  const type = res.contentType ?? "";
  if (!/^text\/|html|xml|json/.test(type)) throw new FacelessError("That link isn't a web page or text — upload the file instead", 422);
  const raw = res.data.toString("utf8");
  const { title, text } = /html|xml/.test(type) ? pageText(raw) : { title: null, text: raw };
  if (text.length < 40) throw new FacelessError("That page has no readable text", 422);
  const summary = await askLlm(
    engine,
    "You summarise web pages for a video script writer. Reply with the key facts, numbers, names and explanations as short plain sentences (at most 250 words). No preamble.",
    `Page: ${title ?? url}\n\n${text.slice(0, 24_000)}`,
    { timeoutMs: 2 * 60_000 },
  );
  return { kind: "link", url: res.url, title: title?.slice(0, 160), text: (summary ?? text).slice(0, 6000) };
}

/** The largest PDF or Word file the Explainer reads. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
/** The script writer reads this much of each source; longer documents are summarised for it first. */
const SOURCE_CHARS = 6000;
/** What a document summary is written from (about a 40-page report; a local model's context holds it). */
const SUMMARY_INPUT_CHARS = 40_000;

export type DocumentKind = "pdf" | "docx";

/** What a file is, from its first bytes, name and type: a PDF, a Word file, or neither. */
export function documentKind(file: { name: string; data: Buffer; type?: string }): DocumentKind | null {
  const head = file.data.subarray(0, 5).toString("latin1");
  if (head === "%PDF-") return "pdf";
  if (head.startsWith("PK\x03\x04") && (/\.docx$/i.test(file.name) || /wordprocessingml/.test(file.type ?? ""))) return "docx";
  if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") return "pdf"; // a damaged one: the reader says so
  if (/\.(docx?|dot[xm]?)$/i.test(file.name) || /msword|wordprocessingml/.test(file.type ?? "")) return "docx";
  return null;
}

/**
 * A PDF or Word source for the Explainer: its text is read on the server (PDF.js through unpdf, or
 * word/document.xml through the bounded unzip), and a document longer than the writer reads is
 * summarised by the engine's text model, like a link. With no text model the beginning is kept.
 */
export async function readDocument(
  file: { name: string; data: Buffer; type?: string },
  engine: Engine,
): Promise<{ source: Extract<ExplainerSource, { kind: "text" }>; pages?: number; readPages?: number; summarized: boolean }> {
  if (file.data.length > MAX_DOCUMENT_BYTES) throw new FacelessError(`${file.name} is over ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB — add the part that matters, or paste its text into the prompt`, 413);
  const kind = documentKind(file);
  if (!kind) throw new FacelessError(`${file.name} isn't a PDF or a Word file (.docx)`, 415);
  let read: { text: string; title?: string; pages?: number; pagesRead?: number };
  try {
    read = kind === "pdf" ? await pdfText(file.data, { maxChars: SUMMARY_INPUT_CHARS, maxPages: 200 }) : docxText(file.data, { maxChars: SUMMARY_INPUT_CHARS });
  } catch (e) {
    if (e instanceof PdfError || e instanceof DocxError) throw new FacelessError(e.message, 422);
    throw new FacelessError(kind === "pdf" ? "Couldn't read that PDF — save it again, or paste its text into the prompt" : "Couldn't read that Word file — save it as PDF, or paste its text into the prompt", 422);
  }
  const name = file.name.slice(0, 200);
  const long = read.text.length > SOURCE_CHARS;
  const summary = long
    ? await askLlm(
        engine,
        "You summarise documents for a video script writer. Reply with the key facts, numbers, names, steps and explanations as short plain sentences (at most 300 words). No preamble.",
        `Document: ${read.title ?? name}\n\n${read.text}`,
        { timeoutMs: 2 * 60_000 },
      )
    : null;
  // A PDF read only in part (its first SUMMARY_INPUT_CHARS) says how many of its pages were read.
  const partial = read.pages && read.pagesRead !== undefined && read.pagesRead < read.pages ? { readPages: read.pagesRead } : {};
  return { source: { kind: "text", name, text: (summary ?? read.text).slice(0, 20_000) }, ...(read.pages && { pages: read.pages }), ...partial, summarized: !!summary };
}

// ---------------------------------------------------------------------------
// Request schemas and the route helper (src/app/api/faceless/**, src/app/api/explainer/**)

const FileUrl = z.string().startsWith("/api/files/").max(500);
export const VoiceSchema = z.union([
  z.object({ kind: z.literal("preset"), id: z.string().min(1).max(80), name: z.string().max(80).optional() }),
  z.object({ kind: z.literal("sample"), url: FileUrl, name: z.string().max(120).optional() }),
]);
export const GenreSchema = z.enum(["education", "history", "kids", "storytelling"]);
export const EngineSchema = z.enum(["cloud", "open"]);

/** The research's message for a length outside Auto / 15–600 s. */
export const DURATION_ERROR = "Duration must be Auto or a whole number of seconds between 15 and 600";

/** A Content Factory brief as it reaches an episode (see BriefLook). */
export const BriefLookSchema = z.object({
  script: z.array(z.string().max(600)).max(16),
  look: z.string().max(600).optional(),
  camera: z.string().max(400).optional(),
  music: z.string().max(300).optional(),
  sceneSeconds: z.number().min(3).max(10).optional(),
  captions: z.object({ position: z.enum(["top", "center", "bottom"]).optional(), words: z.number().int().min(1).max(8).optional() }).optional(),
});

export const SettingsSchema = z.object({
  engine: EngineSchema,
  length: z.number(DURATION_ERROR).int(DURATION_ERROR).min(EXPLAINER_MIN, DURATION_ERROR).max(EXPLAINER_MAX, DURATION_ERROR),
  animation: z.enum(["animated", "frames"]),
  aspect: z.enum(["16:9", "9:16"]),
  subtitles: z.boolean(),
  music: z.boolean(),
  styleId: z.string().min(1).max(60),
  styleRefs: z.array(FileUrl).max(3, "Up to 3 style references"),
  voice: VoiceSchema.nullable(),
  elements: z.array(z.string().max(60)).max(8),
  videoModel: z.string().max(60).optional(),
  musicModel: z.string().max(60).optional(),
  resolution: z.string().max(10).optional(),
  auto: z.boolean().optional(),
  brief: BriefLookSchema.optional(),
  /** A clip whose soundtrack is the music bed (open engine; the cloud makes the music). */
  bedClip: z
    .object({
      url: FileUrl,
      seconds: z.number().min(CLIP_BED_MIN, `Pick a clip of at least ${CLIP_BED_MIN} seconds for the music bed`).max(CLIP_BED_MAX, "Pick a clip of up to 10 minutes for the music bed"),
      name: z.string().max(200).optional(),
    })
    .optional(),
});

export const BlockSchema = z.object({
  id: z.string().max(40).optional(),
  narration: z.string().max(2000),
  visual: z.string().max(1200),
  motion: z.string().max(400).optional(),
  seconds: z.number().optional(),
});

export const SourceSchema = z.union([
  z.object({ kind: z.literal("image"), url: FileUrl, name: z.string().max(200).optional() }),
  z.object({ kind: z.literal("text"), name: z.string().max(200), text: z.string().min(1).max(20_000) }),
  z.object({ kind: z.literal("link"), url: z.string().url().max(2000), title: z.string().max(200).optional(), text: z.string().min(1).max(8000) }),
]);

export const ChangeSchema = z.object({
  blocks: z.array(z.string().max(40)).min(1).max(12),
  part: z.enum(["picture", "motion", "narration"]),
  instruction: z.string().max(1000).optional(),
  narration: z.array(z.string().max(2000)).max(12).optional(),
  apply: z.boolean().optional(),
});

/** Parse a JSON body; a schema's own message (e.g. "Up to 3 style references") wins over the generic one. */
export async function body<S extends z.ZodType>(request: Request, schema: S, message: string): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const custom = parsed.error.issues.find((i) => i.message && !/^(Invalid|Expected|Too|Unrecognized)/.test(i.message))?.message;
    throw new FacelessError(custom ?? message, 400);
  }
  return parsed.data;
}

/**
 * Turn thrown errors into the API's `{ error }` responses. With the `request`, a run nothing connected can make opens
 * the connect card in the owner's browser (src/server/connect-refusal.ts) instead of an error.
 */
export async function handle(fn: () => Promise<Response> | Response, request?: Request): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof FacelessError || e instanceof AccountProjectError) return Response.json({ error: e.message }, { status: e.status });
    if (e instanceof ConnectComfyError) return (request && connectRefusal(e, request)) || Response.json({ error: e.message }, { status: 422 });
    console.error("[faceless]", e);
    return Response.json({ error: (e as Error).message || "Something went wrong" }, { status: 500 });
  }
}
