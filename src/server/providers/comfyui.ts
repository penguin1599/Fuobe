import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { tracksFor, type MotionPaths } from "@/lib/motion-paths";
import { nanoid } from "nanoid";
import {
  alphaBBox,
  applyBindings,
  asrLanguage,
  bypassNode,
  bypassReference,
  computeDimensions,
  fitCanvas,
  computeFrames,
  dropBranch,
  dropLoadedSound,
  dropVhsAudio,
  silenceVhsAudio,
  expandCaptionWorkflow,
  explainComfyError,
  canTakeLoras,
  injectLoras,
  languageName,
  paletteSentence,
  parseCueLines,
  PROMPT_HELPER_GRAPHS,
  PROMPT_HELPER_OPT_IN,
  PROMPT_HELPER_PARAM,
  skipPromptHelper,
  randomSeed,
  splitCueWords,
  swatchPixels,
  tagMetaBatch,
  whisperLanguage,
  withLoad3dImages,
  type BindingKey,
  type CaptionCue,
  type ComfyWorkflow,
  type Manifest,
  type ManifestOutput,
  type ManifestWorkflow,
} from "@/lib/comfy";
import { HI3D_PARAM, strictHi3dResolution } from "@/lib/av/hi3d";
import { fpsPlan } from "@/lib/av/fps";
import { resolveWorkflowId } from "@/lib/comfy-variants";
import { IDOL_PACK, IDOL_PACK_CLASS, IDOL_WORKFLOWS, idolGraphValues, idolKept } from "@/lib/av/model3d";
import { IDOL_VIEWS_NEEDS_PACK, IDOL_VIEWS_PARAM, IDOL_VIEWS_WORKFLOW, idolViewMeta } from "@/lib/av/idol-views";
import { MOTION_GRAPHS, motionTransferPrompt, neutralPrompt, WORDS_NEEDED } from "@/lib/comfy-prompts";
import { DECODER_PARAM, editCanvas, GPU_PARAM, LIGHTNING_GRAPHS, lightningSigmas, SPEED_PARAM, ZEN_ADAPTER, ZEN_ENCODER } from "@/lib/qwen21-speed";
import { checkWatermarkBoxes, COPY as WATERMARK_COPY, MAX_SIDE as MAX_WATERMARK_SIDE, maxSideFor, mergeScanReports, qualityOf, SCAN_EXPAND as WATERMARK_SCAN_EXPAND, KEPT_EXPAND as WATERMARK_KEPT_EXPAND } from "@/lib/watermark";
import { h3Canvas, h3Frames, isH3Graph } from "@/lib/h3-prompt";
import { expandH3References, h3ReferenceProblem } from "@/lib/h3-references";
import {
  draftSizeFor,
  H3_LATENT_DRAFT_WORKFLOW,
  latentFileFor,
  latentPrefixFor,
  REGEN_COPY,
  REGEN_LATENT_WORKFLOW,
  REGEN_WINDOW_SECONDS,
  REGEN_WORKFLOW,
  regenFrames,
  regenOnePassRefusal,
  regenResolution,
} from "@/lib/catalog/regenerate";
import { carriesBoxes, LAYOUT_PARAM } from "@/lib/layout-prompt";
import { fixFromPromptError } from "@/lib/gpu/fix-codes";
import { loadIndex } from "../gpu/index-file";
import { crossfadeProblem, fadeCurveWav } from "@/lib/av/crossfade";
import { dbsChannelsFor, dbsModelFor, dbsSurroundBed, installedDbs, surroundSource, type DbsModel } from "@/lib/av/split";
import { installedReuse, NO_REUSE_PACK, rateFor, reuseFileFor, STRENGTH_DB, type ReuseModel } from "@/lib/av/clean-voice";
import { expandAudioJoinWorkflow, expandVideoJoinWorkflow } from "@/lib/av/joins";
import { aukTtsWorkflow, expandSpeechEditWorkflow, readSpeechWindows, setAukDevice, speechFadeWav } from "@/lib/av/speech-edit-graph";
import { SpeechEditError, ttsInstruction, ttsLength, type SpeechWindow } from "@/lib/speech-edit";
import { expandInbetweenWorkflow, type InbetweenPass } from "@/lib/av/inbetween-graph";
import { gapPrompt, requestTiming, type InbetweenTiming } from "@/lib/inbetween";
import { expandTimelineWorkflow, readTimeline } from "@/lib/av/timeline";
import { expandWorldWorkflow, readWorld, WorldGraphError, worldProblem, type WorldScript } from "@/lib/world";
import { RTX_FRAMEGEN_WORKFLOW, RTX_HDR_WORKFLOW, RTX_MISSING } from "@/lib/catalog/rtx-video";
import { exportValues, framesPerPass, hdrColorSpace, RTX_UPSCALE_WORKFLOW, rtxScale, upscaleShortSide, wholeClipProblem, wholeClipTool } from "@/lib/av/video-finish";
import { keyFormatValues } from "@/lib/av/keying";
import { factorTier } from "@/lib/av/upscale";
import { guessKind } from "@/lib/catalog/payload";
import { loraByFile, needsToken } from "@/lib/catalog/loras";
import { CHARACTER_SWAP, packResolution, samCoords, swapPrompt, SWAP_LORAS, windowPlan } from "@/lib/catalog/character-swap";
import { maskMemoryProblem } from "@/lib/catalog/swap-studio";
import { STUDIO_WORKFLOWS } from "@/lib/catalog/swap-studio-plan";
import { maskGraph, segmentGraph, type MaskGraphOptions, type SegmentGraphOptions } from "@/lib/swap-studio-graphs";
import { CONTEXT_LOOP_IDS, OPENJUTSU_IDS, openjutsuGraph, openjutsuLeftOut, runName, type OpenjutsuSettings } from "@/lib/openjutsu-graphs";
import { RESTORE_EXTRA_KEYS, restoreGraph, restoreJob, type RestoreJob } from "@/lib/restore-graph";
import { getMaker, makerPrompt, OPEN_TARGET_PROBLEM, ORIGINALS, swapTarget } from "@/lib/catalog/genjutsu";
import { CLICK_OPEN_PROBLEM, HAND_OFF, REMOVE_SCENE, REVIEW_EXTRA, reuseOf, reviewOfRun, targetPhrase, type RemovalReview } from "@/lib/catalog/remove-object";
import { H3_REMOVAL_WORKFLOW } from "@/lib/catalog/character-swap";
import { RECOLOR_TAP_FIRST, recolorItem, recolorTouches, tapFrame } from "@/lib/catalog/recolor";
import type { GenInput, MediaKind, ModelRoute, Operation } from "@/lib/catalog/types";
import { imageSize } from "@/lib/image-size";
import { probeMedia, type MediaInfo } from "@/lib/media-probe";
import { ocrText, parseOcrFrame, parseOcrLines, type OcrFrame } from "@/lib/ocr";
import { getSetting, isCandidate, savedSetting } from "../settings";
import { decodePng, encodePng } from "../png";
import { probeAvi } from "../avi-probe";
import { probeWebm } from "../webm-probe";
import { adoptFile, contentTypeFor, readRef, saveFile, scratchDir } from "../storage";
import { CONNECT_GPU_MESSAGE } from "@/lib/guest-access";
import { discardBody, fetchPublic, peekText, RemoteFetchError } from "../remote-fetch";
import { zipToFile } from "../zip";
import { ACCOUNT_LIMITS, ACCOUNT_MESSAGES, accountTotalBytes, accountUsage, diskHasRoom, filesFullMessage } from "../account-files";
import { accountSend } from "../account-send";
import { outsideTenant, runAsTenant, tenantAccount } from "../tenant";
import { ask, checkReach, reachSync, sharedCheck, type Reach } from "./reach";
import { ProviderError, type PollResult, type ProviderAdapter, type RemoteOutput } from "./types";
import { isOutOfMemory } from "@/lib/gpu/fix-codes";
import { diagnoseGpu, diagnoseGpuJob, diagnoseRefusal, type Diagnosis, type GpuFailure, type GpuStage } from "@/lib/diagnose";
import { makingWords, META_BATCH_HISTORY, queueWords, RELAY_TIMES, RELAY_WORDS, savingWords, sendingWords, tabFailureWords, type HistoryEntryLike, type TabFailure, type WantedFile } from "@/lib/relay";
import type { GenerationFix } from "@/lib/catalog/types";
import {
  checkClocks,
  createTask,
  extraOf,
  getTask,
  inputKinds,
  receivedFile,
  receivedOf,
  refusalOf,
  pairedRunner,
  requestStop,
  resultOf,
  runnerFacts,
  stageInput,
  taskProgress,
  type FinishedPlan,
  type Principal,
  type TaskRow,
} from "../computer/tasks";
import { OWNER_BOOST_MS, poolFields, poolWaitMs, poolWaitWords } from "../computer/pool";
import { worldcastBase, worldcastHealth } from "../worldcast";

export const WORKFLOW_DIR = path.join(process.cwd(), "workflows", "comfyui");

let manifestCache: { mtime: number; manifest: Manifest } | null = null;

export function loadManifest(): Manifest {
  const file = path.join(WORKFLOW_DIR, "manifest.json");
  if (!fs.existsSync(file)) return { version: 1, generatedAt: "", workflows: [] };
  const mtime = fs.statSync(file).mtimeMs;
  if (!manifestCache || manifestCache.mtime !== mtime) {
    manifestCache = { mtime, manifest: JSON.parse(fs.readFileSync(file, "utf8")) as Manifest };
  }
  return manifestCache.manifest;
}

export function getWorkflow(id: string): { manifest: ManifestWorkflow; workflow: ComfyWorkflow } {
  const manifest = loadManifest().workflows.find((w) => w.id === id);
  if (!manifest) throw new ProviderError(`Workflow "${id}" is not in workflows/comfyui/manifest.json`);
  const workflow = JSON.parse(fs.readFileSync(path.join(WORKFLOW_DIR, manifest.file), "utf8")) as ComfyWorkflow;
  return { manifest, workflow };
}

/**
 * Which ComfyUI runs a workflow: the main server, or the isolated worker — a second ComfyUI with its own
 * code copy and virtualenv for node packs that change process-wide state or pin old packages (LatentSync
 * 1.6, ThinkSound; manifest `worker: "isolated"`, scripts/comfy/README.md). Both take the same token.
 */
export type ComfyWorker = "main" | "isolated";

/** Where the isolated worker's address is set, for messages. */
export const ISOLATED_SETTING = "Settings → Open-source engine · ComfyUI → Isolated worker URL";

// ---------------------------------------------------------------------------
// An account's own ComfyUI (public sign-up, "Your GPU")

/**
 * Where an account's run goes: its own ComfyUI at a public address (a link: a tunnel), with its own token; or the
 * ComfyUI on the person's own computer ("computer"), which only their Fuobe tab reaches (src/server/computer).
 */
export type OwnGpu = { kind?: "link"; url: string; token?: string } | { kind: "computer"; principal: `acct:${string}` };

const ownGpuStore = new AsyncLocalStorage<OwnGpu>();

/**
 * Run `fn` on an account's own ComfyUI: every ComfyUI call inside (uploads, the prompt, polls, outputs)
 * goes to `gpu` through fetchPublic, which connects only to public addresses, so it can't reach the
 * install's own ComfyUI, even when the account's name is re-pointed at this machine. The install's
 * address and token are never used. Without a socket: progress comes from polling. On the account's own
 * computer, every ComfyUI job becomes a task its Fuobe tab runs, and nothing is fetched from here.
 */
export function onOwnGpu<T>(gpu: OwnGpu, fn: () => T): T {
  return ownGpuStore.run(gpu.kind === "computer" ? { kind: "computer", principal: gpu.principal } : { url: gpu.url.replace(/\/+$/, ""), token: gpu.token }, fn);
}

/** Inside onOwnGpu: the account's ComfyUI. */
export const ownGpu = (): OwnGpu | undefined => ownGpuStore.getStore();

/** Run `fn` outside any account's ComfyUI (the install's own again). */
export const outsideOwnGpu = <T,>(fn: () => T): T => ownGpuStore.exit(fn);

/**
 * The ComfyUI in scope runs on someone's own computer, reached only through their Fuobe tab: whose (an account's
 * "acct:<id>", or the owner's when Settings says ComfyUI runs on the owner's computer), else undefined.
 */
export function computerScope(): Principal | undefined {
  const own = ownGpu();
  if (own) return own.kind === "computer" ? own.principal : undefined;
  if (serverScope.getStore()) return undefined;
  const where = getSetting("comfyWhere");
  // Workers (docs/gpu-workers.md) take the owner's jobs the way the owner's own computer would: staged here, run there.
  return where === "computer" || where === "workers" ? "owner" : undefined;
}

/** The owner's ComfyUI jobs go to the workers (Settings: ComfyUI runs on "workers"), not to one computer. */
const onWorkers = (computer: Principal | undefined) => computer === "owner" && !ownGpu() && getSetting("comfyWhere") === "workers";

/**
 * Which ComfyUI a job in this scope runs on, as a name two runs are compared by (MiniMax H3's 2K finish loads the latent
 * its draft saved only on the ComfyUI that saved it): an account's link or computer, the owner's computer, or this
 * install's server. null where nothing stays between jobs: the owner's workers empty their output folder after each one.
 */
export function comfyPlace(): string | null {
  const own = ownGpu();
  if (own) return own.kind === "computer" ? `computer:${own.principal}` : own.url ? `link:${own.url}` : null;
  const computer = computerScope();
  if (computer) return onWorkers(computer) ? null : `computer:${computer}`;
  const url = getSetting("comfyUrl").replace(/\/+$/, "");
  return url ? `server:${url}` : null;
}

/**
 * FUOBE_POOL_MEDIA_INPUTS: what a job for workers may send them ("image" unless set; "image,video,audio" for all).
 * Pictures are always made again from their pixels first (no EXIF, no GPS, nothing a decoder on that PC could trip on).
 */
const poolMedia = () => new Set((process.env.FUOBE_POOL_MEDIA_INPUTS ?? "image").split(",").map((s) => s.trim()).filter(Boolean));

export async function forWorkers(data: Buffer, contentType: string, name: string): Promise<{ data: Buffer; contentType: string; name: string }> {
  const kind = contentType.split("/")[0];
  if (!poolMedia().has(kind)) throw new ProviderError(kind === "video" ? "The shared GPUs don't take clips yet." : kind === "audio" ? "The shared GPUs don't take sound yet." : "The shared GPUs don't take this kind of file.");
  if (kind !== "image") return { data, contentType, name };
  const sharp = (await import("sharp")).default;
  const png = await sharp(data, { failOn: "error", limitInputPixels: 64 * 2 ** 20 }).rotate().png().toBuffer();
  return { data: png, contentType: "image/png", name: name.replace(/\.[^.]*$/, "") + ".png" };
}

/** A run the owner sent to the studio's own ComfyUI before Settings moved ComfyUI to the owner's computer. */
const serverScope = new AsyncLocalStorage<true>();

/**
 * Run `fn` on this install's own ComfyUI server (Settings → ComfyUI address), never an account's own GPU and never a
 * computer's tab: an account's run on this install's GPUs (hosted runs, src/server/hosted.ts).
 */
export const onInstallComfy = <T,>(fn: () => T): T => outsideOwnGpu(() => serverScope.run(true, fn));

/**
 * Whose computer a run sent there belongs to, whatever ComfyUI's place is now: the account's (as its tenant), or the
 * owner's.
 */
function relayPrincipal(): Principal {
  const account = tenantAccount();
  return account ? `acct:${account}` : "owner";
}

/**
 * Said when a workflow for the isolated worker (LatentSync 1.6, ThinkSound) would go to someone's computer: it needs a
 * second ComfyUI beside the first, which the tab doesn't reach yet. Refused before anything is staged or queued.
 */
export const ISOLATED_ON_COMPUTER = "This one needs its own ComfyUI, so it can't run from your computer next to your other add-ons.";

/** Said when something would call a ComfyUI that only the person's own tab may reach. */
export const ON_COMPUTER_ONLY = "This ComfyUI is on your own computer: only your Fuobe tab there talks to it.";

/** The most an account's ComfyUI may send back for one output file, and how long it may take. */
export const OWN_OUTPUT_LIMITS = { maxBytes: 2 ** 30, deadlineMs: 15 * 60_000 };

/**
 * A result a computer sent in (relay:<task>/view?…&n=…): the file its task received, for that task's principal only:
 * whose run this is (an account, as its tenant; else the owner), whatever ComfyUI's place is now, as poll and cancel.
 */
export function relayFile(url: string): { path: string; contentType?: string } | null {
  const principal = relayPrincipal();
  const m = /^relay:([A-Za-z0-9_-]{16})\/view\?(.*)$/.exec(url);
  const n = m ? Number(new URLSearchParams(m[2]).get("n")) : NaN;
  return principal && m && Number.isInteger(n) ? receivedFile(principal, m[1], n) : null;
}

/** A computer's result as a fetch() answer (bundleFrames and the layer boxes read results this way). */
function relayResponse(url: string): Response {
  const file = relayFile(url);
  if (!file) return new Response("Not found", { status: 404 });
  const stream = Readable.toWeb(fs.createReadStream(file.path)) as ReadableStream<Uint8Array>;
  return new Response(stream, { headers: { "content-type": file.contentType ?? "application/octet-stream", "content-length": String(fs.statSync(file.path).size) } });
}

/** fetch() for a provider's file: through fetchPublic on an account's own ComfyUI (1 GB and 15 minutes at most, or less). */
export function outputFetch(url: string, init: RequestInit = {}, o: { maxBytes?: number } = {}): Promise<Response> {
  if (url.startsWith("relay:")) return Promise.resolve(relayResponse(url));
  if (!ownGpu()) return fetch(url, init);
  const maxBytes = Math.max(1, Math.min(OWN_OUTPUT_LIMITS.maxBytes, o.maxBytes ?? Infinity));
  return fetchPublic(url, init, { timeoutMs: 120_000, ...OWN_OUTPUT_LIMITS, maxBytes });
}

/** An account's ComfyUI: one EXR frame, at most. */
export const OWN_FRAME_MAX_BYTES = 100 * 2 ** 20;

/**
 * What an account's ComfyUI may answer, by path: a file (/view) up to 1 GB in 15 minutes; an upload's answer 1 MB, in
 * 5 minutes (the time covers sending the file); the node list (/object_info) 64 MB in 2 minutes; anything else 8 MB in
 * 60 seconds. A slow or endless answer can't hold the server.
 */
export function ownGpuLimits(p: string): { maxBytes: number; deadlineMs: number } {
  const at = p.split("?")[0];
  if (at.startsWith("/view")) return OWN_OUTPUT_LIMITS;
  if (at.startsWith("/upload/")) return { maxBytes: 2 ** 20, deadlineMs: 5 * 60_000 };
  if (at.startsWith("/object_info")) return { maxBytes: 64 * 2 ** 20, deadlineMs: 2 * 60_000 };
  return { maxBytes: 8 * 2 ** 20, deadlineMs: 60_000 };
}

/** A job id as ComfyUI gives it (a UUID): anything else from an account's ComfyUI is refused, never put in a path. */
export const PROMPT_ID = /^[\w-]{1,64}$/;

function baseUrl(worker: ComfyWorker = "main"): string {
  const own = ownGpu();
  if (own) return own.kind === "computer" ? "" : own.url;
  if (computerScope()) return "";
  return getSetting(worker === "isolated" ? "comfyIsolatedUrl" : "comfyUrl").replace(/\/+$/, "");
}

/** The worker a workflow runs on. */
export function workerFor(endpoint: string | undefined): ComfyWorker {
  return endpoint && loadManifest().workflows.find((w) => w.id === endpoint)?.worker === "isolated" ? "isolated" : "main";
}

/** A ComfyUI address as compared: no trailing slash. */
const sameAddress = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

function authHeaders(worker: ComfyWorker = "main"): Record<string, string> {
  const own = ownGpu();
  if (own) return own.kind !== "computer" && own.token ? { Authorization: `Bearer ${own.token}` } : {};
  if (computerScope()) return {};
  // Save & test of an address that isn't the saved one: the saved token stays with the server it
  // was saved for. Only a token typed for this test goes to the new address.
  const address = worker === "isolated" ? "comfyIsolatedUrl" : "comfyUrl";
  if (isCandidate(address) && !isCandidate("comfyToken") && !sameAddress(getSetting(address), savedSetting(address))) return {};
  const t = getSetting("comfyToken");
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** An account's saved address in scope (its own GPU at a web address), as diagnose.ts reads it; null anywhere else. */
export function ownLink(): { kind: "link"; url: string; hasToken: boolean } | null {
  const own = ownGpu();
  return own && own.kind !== "computer" && own.url ? { kind: "link", url: own.url, hasToken: !!own.token } : null;
}

/** Which step of a run asked the account's GPU, by path. */
const stageOf = (p: string): GpuStage => {
  const at = p.split("?")[0];
  return at.startsWith("/upload/") ? "upload" : at === "/prompt" ? "prompt" : at.startsWith("/view") ? "result" : at === "/system_stats" ? "status" : "poll";
};

/**
 * An account's GPU that didn't answer as ComfyUI: the run's error in plain words, with what helps (`trouble`), which the
 * runner keeps with the run (generations.ts) and uses to wait out a GPU that is off or starting up. `failure`: what came
 * back, so the status strip can say the same in its own words.
 */
export function troubleError(d: Diagnosis, status?: number, failure?: GpuFailure): ProviderError & { trouble: Diagnosis; failure?: GpuFailure } {
  return Object.assign(new ProviderError(d.words, status), { trouble: d, ...(failure && { failure }) });
}

/** What came back from an account's link, read for the person (diagnose.ts), as the run's error. */
const gpuTrouble = (f: GpuFailure, place: Parameters<typeof diagnoseGpu>[1]) => troubleError(diagnoseGpu(f, place), f.status, f);

/** An answer from an account's link that isn't what was asked: read for the person (its body's first KB, for details). */
async function linkAnswer(res: Response, f: Omit<GpuFailure, "status" | "body" | "contentType" | "location" | "retryAfterS">, link: NonNullable<ReturnType<typeof ownLink>>): Promise<ProviderError> {
  // The start of an error page only, briefly: a body that never ends can't hold the run (its connection is let go).
  const body = res.status >= 300 && res.status < 400 ? "" : await peekText(res);
  discardBody(res);
  return gpuTrouble(
    {
      ...f,
      status: res.status,
      body,
      contentType: res.headers.get("content-type") ?? undefined,
      location: res.headers.get("location") ?? undefined,
      retryAfterS: Number(res.headers.get("retry-after")) || undefined,
    },
    link,
  );
}

async function comfyFetch(p: string, init: RequestInit = {}, worker: ComfyWorker = "main", o: { bytes?: number } = {}): Promise<Response> {
  // A ComfyUI on someone's own computer is never called from here: not the install's, not a link (every caller in that
  // scope goes through its task instead; this is the last guard).
  if (computerScope()) throw new ProviderError(ON_COMPUTER_ONLY);
  const base = baseUrl(worker);
  if (ownGpu()) {
    // A visitor without a GPU of its own (a price check): nothing to reach, and never the install's.
    if (!base) throw new ProviderError(CONNECT_GPU_MESSAGE);
    try {
      return await fetchPublic(`${base}${p}`, { ...init, headers: { "ngrok-skip-browser-warning": "1", ...authHeaders(worker), ...(init.headers ?? {}) } }, { timeoutMs: 120_000, ...ownGpuLimits(p) });
    } catch (e) {
      // The account's words (a stopped pod, a GPU that doesn't answer…); the reason itself goes in the details line.
      throw gpuTrouble({ stage: stageOf(p), error: (e as Error).message, bytes: o.bytes }, ownLink() ?? { kind: "link", url: base });
    }
  }
  if (worker === "isolated" && !base) {
    throw new ProviderError(`This model runs on the isolated ComfyUI worker, which isn't set up yet: add its address in ${ISOLATED_SETTING} (or COMFYUI_ISOLATED_URL). scripts/comfy/README.md shows how to start one, usually on port 8189`);
  }
  try {
    return await fetch(`${base}${p}`, { ...init, headers: { ...authHeaders(worker), ...(init.headers ?? {}) } });
  } catch (e) {
    if (worker === "isolated") throw new ProviderError(`The isolated ComfyUI worker at ${base} doesn't answer (${(e as Error).message}). Start it (scripts/comfy/README.md) or check ${ISOLATED_SETTING}`);
    throw new ProviderError(`Can't reach ComfyUI at ${base} (${(e as Error).message}). Is it running?`);
  }
}

/**
 * A raw request to the ComfyUI in scope: the install's (its address and token), or an account's inside onOwnGpu.
 * The GPU pre-flight's reads go through it (src/server/gpu/target.ts).
 */
export function comfyRequest(p: string, init: RequestInit = {}, worker: ComfyWorker = "main"): Promise<Response> {
  return comfyFetch(p, init, worker);
}

/**
 * The isolated worker answered, but not with what was asked (an HTTP error, or a proxy's error page
 * when the worker behind it is down): say it's that server and where its address is set, so it doesn't
 * read like the main ComfyUI failed.
 */
function isolatedAnswer(what: string, status?: number, detail?: string): ProviderError {
  const said = status ? `HTTP ${status}` : "something that isn't JSON";
  return new ProviderError(
    `The isolated ComfyUI worker at ${baseUrl("isolated")} answered ${said} to ${what}${detail ? ` (${detail})` : ""} — check that it's running (scripts/comfy/README.md) and its address in ${ISOLATED_SETTING}`,
    status,
  );
}

/** A short reason from an error body: its text, unless it's an HTML error page. */
const reasonOf = (text: string) => (/^\s*</.test(text) ? "" : text.trim().slice(0, 200));

/** GET a ComfyUI JSON endpoint. A non-2xx answer or a body that isn't JSON (a proxy's error page) throws, so the runner retries. */
async function comfyJson<T>(p: string, worker: ComfyWorker = "main"): Promise<T> {
  const res = await comfyFetch(p, {}, worker);
  const path = p.split("?")[0];
  const link = ownLink();
  if (!res.ok) {
    // An account's link: what the answer means for the person (a stopped pod, a GPU starting up), not its status code.
    if (link) throw await linkAnswer(res, { stage: stageOf(p) }, link);
    discardBody(res);
    throw worker === "isolated" ? isolatedAnswer(path, res.status) : new ProviderError(`ComfyUI ${path} answered HTTP ${res.status}`, res.status);
  }
  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text) as T;
  } catch {
    if (link) throw gpuTrouble({ stage: stageOf(p), status: res.status, body: text.slice(0, 4096), contentType: res.headers.get("content-type") ?? undefined }, link);
    throw worker === "isolated" ? isolatedAnswer(path) : new ProviderError(`ComfyUI ${path} sent something that isn't JSON (a proxy error page?)`);
  }
}

// ---------------------------------------------------------------------------
// Live progress over the ComfyUI websocket (one connection per worker, reopened when its URL changes).

interface Progress {
  value: number;
  max: number;
  node?: string;
  nodesDone: number;
}

type ComfySocket = { url: string; ws: WebSocket; clientId: string; progress: Map<string, Progress> };

declare global {
  var __fuobeComfyWs: ComfySocket | undefined;
  /** The isolated worker's socket. */
  var __fuobeComfyWsIsolated: ComfySocket | undefined;
  /** Consecutive polls that found a prompt in neither the queue nor the history. */
  var __fuobeComfyMisses: Map<string, number> | undefined;
}

const socketOf = (worker: ComfyWorker) => (worker === "isolated" ? globalThis.__fuobeComfyWsIsolated : globalThis.__fuobeComfyWs);
function setSocket(worker: ComfyWorker, s: ComfySocket | undefined) {
  if (worker === "isolated") globalThis.__fuobeComfyWsIsolated = s;
  else globalThis.__fuobeComfyWs = s;
}

function ensureSocket(worker: ComfyWorker = "main"): { clientId: string; progress: Map<string, Progress> } {
  // An account's own ComfyUI: no socket (the install's stays as it is); its progress comes from polling, or from its tab.
  if (ownGpu() || computerScope()) return { clientId: "fuobe-account", progress: new Map() };
  const url = baseUrl(worker);
  const cur = socketOf(worker);
  if (cur && cur.url === url && cur.ws.readyState <= 1) return cur;
  const clientId = cur?.clientId ?? `fuobe-${nanoid(8)}`;
  // Same server: keep the progress of prompts in flight. Another server: those prompt ids mean nothing there.
  const progress = cur && cur.url === url ? cur.progress : new Map<string, Progress>();
  if (cur) {
    // A new URL (or a dead socket): close the old connection so it stops writing into the progress map.
    cur.ws.onmessage = null;
    cur.ws.onerror = null;
    try {
      cur.ws.close();
    } catch {}
  }
  try {
    const ws = new WebSocket(`${url.replace(/^http/, "ws")}/ws?clientId=${clientId}`);
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return; // binary preview frames
      try {
        const msg = JSON.parse(ev.data) as { type: string; data: Record<string, unknown> };
        const pid = msg.data?.prompt_id as string | undefined;
        if (!pid) return;
        const p = progress.get(pid) ?? { value: 0, max: 0, nodesDone: 0 };
        if (msg.type === "progress") {
          p.value = Number(msg.data.value);
          p.max = Number(msg.data.max);
          p.node = String(msg.data.node ?? p.node ?? "");
        } else if (msg.type === "executing") {
          if (msg.data.node) {
            p.node = String(msg.data.node);
            p.nodesDone += 1;
            p.value = 0;
            p.max = 0;
          }
        }
        progress.set(pid, p);
      } catch {}
    };
    ws.onerror = () => {};
    setSocket(worker, { url, ws, clientId, progress });
  } catch {
    setSocket(worker, undefined);
  }
  return { clientId, progress };
}

/** Forget a finished prompt's progress and missed-poll count. */
function forget(promptId: string) {
  globalThis.__fuobeComfyWs?.progress.delete(promptId);
  globalThis.__fuobeComfyWsIsolated?.progress.delete(promptId);
  globalThis.__fuobeComfyMisses?.delete(promptId);
}

// ---------------------------------------------------------------------------
// Outputs

type HistoryFile = { filename: string; subfolder: string; type: string };
export type HistoryEntry = {
  prompt?: [number, string, ComfyWorkflow, ...unknown[]];
  status?: { status_str?: string; completed?: boolean; messages?: [string, Record<string, unknown>][] };
  outputs?: Record<string, Record<string, unknown>>;
};

/** A provider output that can also carry text (transcripts) and structured extras (cues, layer z/bbox, stems). */
export type ComfyOutput = RemoteOutput & { text?: string; meta?: Record<string, unknown> };

const isFile = (f: unknown): f is HistoryFile =>
  !!f && typeof f === "object" && typeof (f as HistoryFile).filename === "string" && typeof (f as HistoryFile).type === "string";

const MODEL3D_EXT = /\.(glb|gltf|obj|fbx|stl|usdz|ply)$/i;
const TEXT_EXT = /\.(txt|srt|vtt|json|md|csv)$/i;

function kindFor(filename: string, key: string, declared?: MediaKind): MediaKind {
  if (declared) return declared;
  if (MODEL3D_EXT.test(filename) || key === "3d") return "model3d";
  if (TEXT_EXT.test(filename)) return "text";
  return guessKind(filename, undefined, key === "gifs" || key === "videos" ? "video" : key);
}

const CONTENT_TYPES: Record<string, string> = {
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  // Gaussian splats: ComfyUI's /view serves them as application/octet-stream.
  ply: "model/ply",
  spz: "model/x-spz",
  ksplat: "model/x-ksplat",
  txt: "text/plain",
  srt: "application/x-subrip",
  vtt: "text/vtt",
  json: "application/json",
};

function textsOf(ui: Record<string, unknown> | undefined): string[] {
  return Array.isArray(ui?.text) ? (ui.text as unknown[]).filter((t): t is string => typeof t === "string") : [];
}

const dataUrl = (data: Buffer, contentType: string) => `data:${contentType};base64,${data.toString("base64")}`;

/**
 * Every file the prompt saved, declared output nodes first (in manifest order). Text outputs carry their
 * words (`text`) and parsed caption cues (`meta.cues`); a "language" output (PreviewAny) is folded into the
 * text outputs' meta; stems, roles and layer order (`meta.z`, `meta.name`) come from the manifest.
 */
export function collectOutputs(entry: HistoryEntry, manifest: ManifestWorkflow | undefined, base = "", headers: Record<string, string> = {}): ComfyOutput[] {
  const outputs = entry.outputs ?? {};
  const declared = manifest?.outputs ?? [];
  const declaredIds = declared.map((o) => o.node);
  const order = [...declaredIds.filter((id) => outputs[id]), ...Object.keys(outputs).filter((id) => !declaredIds.includes(id))];
  const language = declared
    .filter((o) => o.role === "language")
    .map((o) => textsOf(outputs[o.node])[0]?.trim())
    .find(Boolean);
  // Idol 3D: the clean graph's count of the Gaussians its prune kept (a PreviewAny "report") goes on the splat; the core
  // graph's splat says it wasn't pruned.
  const idolClean = manifest?.id === IDOL_WORKFLOWS.clean;
  const kept = idolClean ? declared.filter((o) => o.role === "report").map((o) => idolKept(textsOf(outputs[o.node])[0])).find((n) => n !== undefined) : undefined;
  const idolSplat = idolClean ? { pruned: true, ...(kept !== undefined && { kept }) } : manifest?.id === IDOL_WORKFLOWS.core ? { pruned: false } : undefined;
  // OCR: the size the model saw (a PreviewAny "frame") goes with the lines it read.
  const frame = declared
    .filter((o) => o.role === "frame")
    .map((o) => parseOcrFrame(textsOf(outputs[o.node]).join("\n")))
    .find(Boolean);
  // The Watermark Remover's verdict (QWMFinal's report, a PreviewAny): kept on the picture's meta, never a result of its own.
  const quality = declared
    .filter((o) => o.role === "quality")
    .map((o) => qualityOf(textsOf(outputs[o.node]).join("\n")))
    .find(Boolean);
  // The Watermark Remover's tile scans (the photo's four quarters): merged into the whole photo's report, never results.
  const tileSpecs = declared.filter((o) => o.role === "scan-tile");
  const tileReports = tileSpecs.map((o) => textsOf(outputs[o.node]).join("\n") || null);
  const files: ComfyOutput[] = [];
  const pick = (type: string) => {
    for (const nodeId of order) {
      const spec: ManifestOutput | undefined = declared.find((o) => o.node === nodeId);
      if (spec?.role === "language" || spec?.role === "frame" || spec?.role === "quality" || spec?.role === "scan-tile" || (idolClean && spec?.role === "report")) continue;
      const ui = outputs[nodeId] ?? {};
      const texts = textsOf(ui);
      const found: { key: string; f: HistoryFile }[] = [];
      for (const [key, val] of Object.entries(ui)) {
        if (!Array.isArray(val)) continue;
        for (const f of val) if (isFile(f) && f.type === type) found.push({ key, f });
      }
      // OCR lines (SaveText .json): the model's answer, read into lines with boxes.
      if (spec?.role === "lines" && texts.length) {
        if (type === "output") files.push(ocrOutput(texts.join("\n"), frame));
        continue;
      }
      // A text output with no file (PreviewAny): keep the words.
      if (!found.length && type === "output" && spec?.kind === "text" && texts.length) {
        const joined = texts.join("\n");
        const text = spec.role === "report" && tileSpecs.length ? (mergeScanReports(joined, tileReports) ?? joined) : joined;
        files.push(textOutput({ url: dataUrl(Buffer.from(text), "text/plain"), kind: "text", contentType: "text/plain" }, text, spec, language));
        continue;
      }
      found.forEach(({ key, f }, i) => {
        const kind = kindFor(f.filename, key, spec?.kind);
        const qs = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder ?? "", type: f.type });
        const ext = f.filename.split(".").pop()?.toLowerCase() ?? "";
        const o: ComfyOutput = { url: `${base}/view?${qs}`, kind, headers, ...(CONTENT_TYPES[ext] && kind !== "image" ? { contentType: CONTENT_TYPES[ext] } : {}) };
        if (kind === "text") {
          files.push(textOutput(o, texts[i] ?? (found.length === 1 ? texts.join("\n") : undefined), spec, language));
          return;
        }
        const meta: Record<string, unknown> = {};
        if (spec?.stem) meta.stem = spec.stem;
        if (spec?.role) meta.role = spec.role;
        // A splat says what it is (the viewer and the download name go by it): spz, ply or ksplat.
        if (spec?.role === "splat" && ext) meta.format = ext;
        if (spec?.role === "splat" && idolSplat) Object.assign(meta, idolSplat);
        // Qwen-Image-Layered saves its layers back to front.
        if (spec?.role === "layers") Object.assign(meta, { z: i, name: i === 0 ? "Background" : `Layer ${i}` });
        // Idol 3D's four views: one batch, front first, then the object's left, back and right (src/lib/av/idol-views.ts).
        if (spec?.role === "tiles" && manifest?.id === IDOL_VIEWS_WORKFLOW) Object.assign(meta, idolViewMeta(i));
        if (quality && kind === "image") meta.quality = quality;
        if (Object.keys(meta).length) o.meta = meta;
        files.push(o);
      });
    }
  };
  pick("output");
  if (!files.length) pick("temp");
  return files;
}

function textOutput(o: ComfyOutput, text: string | undefined, spec: ManifestOutput | undefined, language: string | undefined): ComfyOutput {
  const meta: Record<string, unknown> = {};
  if (spec?.role) meta.role = spec.role;
  if (text !== undefined) {
    const cues = parseCueLines(text);
    if (cues.length) meta.cues = cues;
  }
  if (language) meta.language = language;
  return { ...o, kind: "text", ...(text !== undefined ? { text } : {}), ...(Object.keys(meta).length ? { meta } : {}) };
}

/**
 * An OCR answer as Fuobe's OCR output (the shape Florence-2's cloud route gives): the lines as plain
 * text, `meta.lines` [{text, bbox: [x, y, w, h] 0–1}] and `meta.size`, the picture the model read. An
 * answer with no list in it keeps its words, with no lines and `meta.unreadable`.
 */
function ocrOutput(answer: string, frame: OcrFrame | undefined): ComfyOutput {
  const { lines, ok } = parseOcrLines(answer, frame);
  const text = ok ? ocrText(lines) : answer.trim();
  const size = frame?.width && frame.height ? [frame.width, frame.height] : undefined;
  return { url: dataUrl(Buffer.from(text), "text/plain"), kind: "text", contentType: "text/plain", text, meta: { lines, ...(size ? { size } : {}), ...(ok ? {} : { unreadable: true }) } };
}

/**
 * Layers: download each RGBA layer once, add its bounding box (from alpha) and hand the bytes on as a data URL. On an
 * account's ComfyUI nothing is downloaded or decoded here: decoding a big layer holds up the whole server (over a second
 * for 40 megapixels), so its layers stay links, saved later straight to disk (16 at most), without a box, as a cloud
 * provider's layers often are.
 */
async function withLayerBoxes(outputs: ComfyOutput[]): Promise<ComfyOutput[]> {
  if (ownGpu()) return outputs;
  const isLayer = (o: ComfyOutput) => o.kind === "image" && typeof o.meta?.z === "number" && !o.url.startsWith("data:");
  const box = async (o: ComfyOutput): Promise<ComfyOutput> => {
    try {
      const res = await outputFetch(o.url, { headers: o.headers });
      if (!res.ok) {
        discardBody(res);
        return o;
      }
      const data = Buffer.from(await res.arrayBuffer());
      const png = decodePng(data);
      const bbox = alphaBBox(png.data, png.width, png.height);
      const meta = { ...o.meta, bbox: bbox ?? [0, 0, 0, 0], width: png.width, height: png.height };
      return { ...o, url: dataUrl(data, "image/png"), contentType: "image/png", headers: undefined, meta };
    } catch {
      return o; // keep the layer without a box rather than failing the job
    }
  };
  return Promise.all(outputs.map((o) => (isLayer(o) ? box(o) : o)));
}

/**
 * An EXR export's frames (role "frames", one file per frame) are zipped into one stored file, one frame
 * in memory at a time, and ride along on the preview clip as meta.artifacts.exr (as LTX HDR's EXR zip
 * does on the cloud). Other outputs pass through.
 */
async function bundleFrames(outputs: ComfyOutput[], generationId: string): Promise<ComfyOutput[]> {
  const frames = outputs.filter((o) => o.meta?.role === "frames");
  if (!frames.length) return outputs;
  const rest = outputs.filter((o) => o.meta?.role !== "frames");
  const preview = rest.find((o) => o.kind === "video");
  if (!preview) throw new ProviderError("The EXR export finished without its preview clip");
  // An account's ComfyUI: a frame count that fits a clip, room on the server, 100 MB a frame, and no more in all than
  // the account's files have room for (3 GB).
  const account = ownGpu() ? tenantAccount() : undefined;
  let budget = Infinity;
  if (account) {
    if (frames.length > ACCOUNT_LIMITS.framesPerJob) throw new ProviderError(`Your ComfyUI made ${frames.length} EXR frames. A run on your GPU keeps up to ${ACCOUNT_LIMITS.framesPerJob}: export a shorter clip.`);
    if (!diskHasRoom()) throw new ProviderError(ACCOUNT_MESSAGES.diskLow);
    budget = accountTotalBytes(account) - accountUsage(account).total;
    if (budget <= 0) throw new ProviderError(filesFullMessage(account));
  }
  const dest = path.join(scratchDir(), `${generationId || nanoid(8)}-${nanoid(6)}.zip`);
  let total = 0;
  // Past what the account's files have room for: say that, not the size of one answer.
  const full = (e: unknown) => (account && budget - total < OWN_FRAME_MAX_BYTES && e instanceof RemoteFetchError && /^The answer was over/.test(e.message) ? new ProviderError(filesFullMessage(account)) : e);
  async function* files() {
    for (const [i, f] of frames.entries()) {
      let data: Buffer;
      try {
        const res = await outputFetch(f.url, { headers: f.headers }, account ? { maxBytes: Math.min(OWN_FRAME_MAX_BYTES, budget - total) } : {});
        if (!res.ok) {
          discardBody(res);
          throw new ProviderError(`ComfyUI answered HTTP ${res.status} for EXR frame ${i + 1}`);
        }
        data = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        throw full(e);
      }
      total += data.length;
      yield { name: `frame_${String(i + 1).padStart(5, "0")}.exr`, data };
    }
  }
  try {
    await zipToFile(files(), dest);
  } catch (e) {
    fs.rmSync(dest, { force: true });
    throw e;
  }
  const zip = adoptFile({ from: dest, contentType: "application/zip", name: "exr-frames.zip", source: "generation", generationId: generationId || undefined });
  return rest.map((o) => (o === preview ? { ...o, meta: { ...o.meta, artifacts: { exr: zip.url }, frames: frames.length } } : o));
}

// ---------------------------------------------------------------------------
// Reachability: GET /system_stats by the busy-vs-down rules in ./reach (a late answer is busy when the server
// answered lately; else the longer look when its port takes a connection). A busy server keeps the RAM it last said.

declare global {
  /** Reachability of the ComfyUI server, its RAM (bytes) when /system_stats said, when it last answered, and when a longer look last went unanswered. */
  var __fuobeComfyReach: (Reach & { ram?: number }) | undefined;
}

/** What GET /system_stats got: an answer (with the RAM it says), a no (an HTTP error, a refused connection), or nothing in time. */
function askComfy(url: string, timeoutMs: number) {
  return ask<number>(`${url}/system_stats`, timeoutMs, {
    headers: authHeaders(),
    read: async (r) => {
      const total = ((await r.json()) as { system?: { ram_total?: unknown } } | null)?.system?.ram_total;
      return typeof total === "number" && total > 0 ? total : undefined;
    },
  });
}

async function checkComfy(url: string): Promise<boolean> {
  const prev = globalThis.__fuobeComfyReach?.url === url ? globalThis.__fuobeComfyReach : undefined;
  const { reach, asked } = await checkReach(url, prev, (ms) => askComfy(url, ms));
  const ram = (asked.answer === "yes" ? asked.value : undefined) ?? prev?.ram;
  // The address may have changed while this ran: the new one's check speaks for it.
  if (url === baseUrl()) globalThis.__fuobeComfyReach = reach.ok && ram ? { ...reach, ram } : reach;
  return reach.ok;
}

/** Is the ComfyUI server reachable? Cached for 10 s (`force` checks now); one check runs at a time. */
export async function probeComfy(force = false): Promise<boolean> {
  // An account's own ComfyUI is taken as there: its run says so when it isn't (the install's state stays its own). So is
  // one on a computer: its runs wait for a tab there.
  if (ownGpu() || computerScope()) return true;
  const url = baseUrl();
  const cur = globalThis.__fuobeComfyReach;
  if (!force && cur && cur.url === url && Date.now() - cur.at < 10_000) return cur.ok;
  return sharedCheck("comfy", url, () => checkComfy(url));
}

declare global {
  /** comfyDevice's and comfyDbsModels' requests on their way, by path and address. */
  var __fuobeComfyAsks: Map<string, Promise<unknown>> | undefined;
}

/** One request at a time per path and address: callers that arrive while it is on its way share its answer. */
function oneAsk<T>(key: string, ask: () => Promise<T>): Promise<T> {
  const asks = (globalThis.__fuobeComfyAsks ??= new Map());
  const going = asks.get(key);
  if (going) return going as Promise<T>;
  const p = ask().finally(() => asks.delete(key));
  asks.set(key, p);
  return p;
}

declare global {
  /** The torch device each ComfyUI address reported last (GET /system_stats devices[0].type), and when. */
  var __fuobeComfyDevice: Map<string, { type?: string; at: number }> | undefined;
}

/**
 * The connected ComfyUI's first torch device type ("cuda" for NVIDIA and ROCm, "cpu", "mps"…), from GET /system_stats
 * (devices[0], as Settings' test reads it), kept for a minute; undefined when the server doesn't say or can't be reached.
 */
export async function comfyDevice(worker: ComfyWorker = "main"): Promise<string | undefined> {
  // On someone's computer: what its Fuobe tab last said ("cuda:0 NVIDIA …").
  const computer = computerScope();
  if (computer) return /^[a-z]+/i.exec(runnerFacts(computer)?.device ?? "")?.[0].toLowerCase();
  const url = baseUrl(worker);
  if (!url) return undefined;
  const cache = (globalThis.__fuobeComfyDevice ??= new Map());
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < 60_000) return hit.type;
  return oneAsk(`/system_stats ${url}`, async () => {
    const s = await comfyJson<{ devices?: { type?: unknown }[] }>("/system_stats", worker).catch(() => undefined);
    const type = typeof s?.devices?.[0]?.type === "string" ? (s.devices[0].type as string) : undefined;
    if (s) cache.set(url, { type, at: Date.now() });
    return type;
  });
}

/** A ComfyUI's model folders (GET /experiment/models) and the files of the ones asked about, and when. */
type ModelRoots = { roots?: Record<string, string[]>; files: Map<string, { name: string; pathIndex: number }[] | undefined>; at: number };

declare global {
  /** Each ComfyUI address's model folders and files (comfyModelPath). */
  var __fuobeComfyRoots: Map<string, ModelRoots> | undefined;
}

/**
 * Where a file under one of the connected ComfyUI's model folders is on its disk (GET /experiment/models for the folders,
 * /experiment/models/{folder} for the file and which folder holds it), kept for a minute: undefined when it isn't there or
 * the server can't say (an older ComfyUI, someone's computer, which the server never reads). `name` may be in a subfolder.
 */
export async function comfyModelPath(folder: string, name: string, worker: ComfyWorker = "main"): Promise<string | undefined> {
  if (computerScope()) return undefined;
  const url = baseUrl(worker);
  if (!url) return undefined;
  const cache = (globalThis.__fuobeComfyRoots ??= new Map());
  let hit: ModelRoots | undefined = cache.get(url);
  if (!hit || Date.now() - hit.at > 60_000) {
    const list = await comfyJson<unknown>("/experiment/models", worker).catch(() => undefined);
    const roots: Record<string, string[]> = {};
    for (const x of Array.isArray(list) ? list : []) {
      const f = x as { name?: unknown; folders?: unknown };
      if (typeof f?.name === "string" && Array.isArray(f.folders)) roots[f.name] = f.folders.filter((d): d is string => typeof d === "string");
    }
    hit = { roots: Array.isArray(list) ? roots : undefined, files: new Map<string, { name: string; pathIndex: number }[] | undefined>(), at: Date.now() };
    cache.set(url, hit);
  }
  const dirs = hit.roots?.[folder];
  if (!dirs?.length) return undefined;
  if (!hit.files.has(folder)) {
    const items = await comfyJson<unknown>(`/experiment/models/${encodeURIComponent(folder)}`, worker).catch(() => undefined);
    hit.files.set(
      folder,
      Array.isArray(items)
        ? items.flatMap((x: { name?: unknown; pathIndex?: unknown }) => (typeof x?.name === "string" && typeof x.pathIndex === "number" ? [{ name: x.name, pathIndex: x.pathIndex }] : []))
        : undefined,
    );
  }
  const want = name.replace(/\\/g, "/");
  const found = hit.files.get(folder)?.find((f) => f.name.replace(/\\/g, "/") === want);
  const root = found && dirs[found.pathIndex];
  if (!root) return undefined;
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${sep}${found.name}`;
}

declare global {
  /** The DBS models each ComfyUI address listed last (GET /models/dbs), and when. */
  var __fuobeComfyDbs: Map<string, { models?: DbsModel[]; at: number }> | undefined;
}

/**
 * The DBS models the connected ComfyUI has on disk (GET /models/dbs, which ComfyUI-DBS registers: both files of a
 * model, or it isn't there), at most `maxAgeMs` old; undefined when the server can't say (unreachable, or the pack
 * isn't loaded, so there is no dbs folder).
 */
export async function comfyDbsModels(worker: ComfyWorker = "main", maxAgeMs = 10_000): Promise<DbsModel[] | undefined> {
  const url = baseUrl(worker);
  if (!url) return undefined;
  const cache = (globalThis.__fuobeComfyDbs ??= new Map());
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.models;
  return oneAsk(`/models/dbs ${url}`, async () => {
    const files = await comfyJson<unknown>("/models/dbs", worker).catch(() => undefined);
    const models = Array.isArray(files) ? installedDbs(files.filter((f): f is string => typeof f === "string")) : undefined;
    cache.set(url, { models, at: Date.now() });
    return models;
  });
}

declare global {
  /** Whether each ComfyUI address had a node class (GET /object_info/<class>), by address and class, and when. */
  var __fuobeComfyClasses: Map<string, { has: boolean; at: number }> | undefined;
}

/**
 * Whether the connected ComfyUI has a node class (GET /object_info/<class> answers it; a ComfyUI without it answers
 * {}), kept for a minute; undefined when the server can't say (unreachable: asked again next time), and on someone's
 * computer, which the server never asks. forgetComfyClass drops the answer (a run refused for a missing node).
 */
export async function comfyHasClass(cls: string, worker: ComfyWorker = "main", maxAgeMs = 60_000): Promise<boolean | undefined> {
  if (computerScope()) return undefined;
  const url = baseUrl(worker);
  if (!url) return undefined;
  const cache = (globalThis.__fuobeComfyClasses ??= new Map());
  const key = `${url} ${cls}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.has;
  return oneAsk(`/object_info/${cls} ${url}`, async () => {
    const info = await comfyJson<unknown>(`/object_info/${encodeURIComponent(cls)}`, worker).catch(() => undefined);
    if (!info || typeof info !== "object" || Array.isArray(info)) {
      cache.delete(key);
      return undefined;
    }
    const has = cls in info;
    cache.set(key, { has, at: Date.now() });
    return has;
  });
}

/** Forget what a ComfyUI said about a node class (comfyHasClass asks again). */
export function forgetComfyClass(cls: string, worker: ComfyWorker = "main"): void {
  const url = baseUrl(worker);
  if (url) globalThis.__fuobeComfyClasses?.delete(`${url} ${cls}`);
}

declare global {
  /** The RE-USE files each ComfyUI address listed last (GET /models/reuse; null: no reuse folder, so no ComfyUI-RE-USE), and when. */
  var __fuobeComfyReuse: Map<string, { models?: ReuseModel[] | null; at: number }> | undefined;
}

/**
 * The RE-USE models the connected ComfyUI has on disk (GET /models/reuse, which ComfyUI-RE-USE registers), at most
 * `maxAgeMs` old: null when the server answers but has no reuse folder (the pack isn't installed), undefined when it can't
 * say (unreachable).
 */
export async function comfyReuseModels(worker: ComfyWorker = "main", maxAgeMs = 10_000): Promise<ReuseModel[] | null | undefined> {
  const url = baseUrl(worker);
  if (!url) return undefined;
  const cache = (globalThis.__fuobeComfyReuse ??= new Map());
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.models;
  return oneAsk(`/models/reuse ${url}`, async () => {
    let models: ReuseModel[] | null | undefined;
    try {
      const files = await comfyJson<unknown>("/models/reuse", worker);
      models = Array.isArray(files) ? installedReuse(files.filter((f): f is string => typeof f === "string")) : undefined;
    } catch (e) {
      // ComfyUI answers 404 for a model folder nobody registered: no ComfyUI-RE-USE.
      models = e instanceof ProviderError && e.status === 404 ? null : undefined;
    }
    cache.set(url, { models, at: Date.now() });
    return models;
  });
}

/** The connected ComfyUI's RAM in bytes, as the last reachability check read it (whole-clip tools' budget). */
export function comfyRam(): number | undefined {
  const computer = computerScope();
  if (computer) return runnerFacts(computer)?.ramBytes;
  if (ownGpu()) return undefined;
  const cur = globalThis.__fuobeComfyReach;
  return cur?.ok && cur.url === baseUrl() ? cur.ram : undefined;
}

/**
 * Blocking reachability check (reachSync): a few ms for a server that answers or a refused port, at most `timeoutMs`
 * otherwise; a server that takes the connection but doesn't answer in time is busy for now, and probeComfy goes on in
 * the background to say for sure.
 */
export function probeComfySync(timeoutMs = 1500): boolean {
  if (ownGpu() || computerScope()) return true;
  const url = baseUrl();
  const { reach, sure } = reachSync(url, `${url}/system_stats`, timeoutMs, authHeaders());
  globalThis.__fuobeComfyReach = reach;
  if (!sure) void probeComfy(true).catch(() => false);
  return reach.ok;
}

// ---------------------------------------------------------------------------
// Building the prompt

/** Loader classes whose input is an uploaded file, and which input holds it (AusBoss's Crop + Rotate + Pad loads the upload itself). */
const MEDIA_LOADERS: Record<string, string> = {
  LoadImage: "image",
  LoadImageMask: "image",
  LoadVideo: "file",
  VHS_LoadVideo: "video",
  LoadAudio: "audio",
  VHS_LoadAudioUpload: "audio",
  AUSBOSS_NODES_ImageCropRotatePad: "image",
  // Any Angle's saved 3D view (a .spz sent like any input).
  Load3D: "model_file",
};

// What we learned about each uploaded clip / track from its header (duration, size, fps, audio), by ComfyUI file name.
declare global {
  var __fuobeComfyMedia: Map<string, MediaInfo> | undefined;
}
const MEDIA_FILE = /^(video|audio)\//;
const MEDIA_EXT = /\.(mp4|m4v|mov|m4a|wav|flac|mp3)$/i;

/** A file name as remembered: an account's ComfyUI names its own files, so they are kept apart by its address (or whose computer). */
const mediaKey = (name: string) => {
  const own = ownGpu();
  const computer = computerScope();
  if (computer) return `${computer}|${name}`;
  return own && own.kind !== "computer" ? `${own.url}|${name}` : name;
};

/** What the server reads from a file it sends to ComfyUI (a clip's length and size, a picture's size), by its name there. */
function rememberSent(uploaded: string, data: Buffer, contentType: string, name: string) {
  if (MEDIA_FILE.test(contentType) || MEDIA_EXT.test(name) || /\.(webm|mkv|avi)$/i.test(name)) {
    const info = probeMedia(data) ?? webmInfo(data) ?? aviInfo(data);
    if (info) rememberMedia(uploaded, info);
  } else if (/^image\//.test(contentType)) {
    // A start frame's size: "auto" makes an image-to-video clip in the picture's own shape.
    const size = imageSize(data);
    if (size) rememberMedia(uploaded, { container: "image", ...size, hasVideo: false, hasAudio: false });
  }
}

function rememberMedia(name: string, info: MediaInfo) {
  const seen = (globalThis.__fuobeComfyMedia ??= new Map());
  seen.set(mediaKey(name), info);
  if (seen.size > 256) seen.delete(seen.keys().next().value!);
}

/** A WebM / Matroska clip's header facts in MediaInfo's shape (src/server/webm-probe.ts). */
function webmInfo(data: Buffer): MediaInfo | null {
  const w = probeWebm(data);
  if (!w) return null;
  const frames = w.duration && w.fps ? Math.round(w.duration * w.fps) : undefined;
  return { container: "webm", duration: w.duration, videoDuration: w.hasVideo ? w.duration : undefined, width: w.width, height: w.height, fps: w.fps, frames, hasVideo: w.hasVideo, hasAudio: w.hasAudio, ...(w.channels && { channels: w.channels }) };
}

/** An AVI clip's header facts in MediaInfo's shape (src/server/avi-probe.ts; Character Swap Studio takes AVI). */
function aviInfo(data: Buffer): MediaInfo | null {
  const a = probeAvi(data);
  if (!a) return null;
  const frames = a.duration && a.fps ? Math.round(a.duration * a.fps) : undefined;
  return { container: "avi", duration: a.duration, videoDuration: a.hasVideo ? a.duration : undefined, width: a.width, height: a.height, fps: a.fps, frames, hasVideo: a.hasVideo, hasAudio: a.hasAudio };
}

/** The header facts of a file this server uploaded to ComfyUI (a still has only its size; undefined for unreadable containers). */
export function mediaInfoFor(name: unknown): MediaInfo | undefined {
  return typeof name === "string" ? globalThis.__fuobeComfyMedia?.get(mediaKey(name)) : undefined;
}

/** Inputs a workflow handles its own way (the manifest doesn't say). */
const SLOT_RULES: Record<string, { reuse?: boolean; required?: string[]; hints?: Record<string, string>; views?: ViewSlots }> = {
  // Edit graphs whose extra images feed TextEncodeQwenImageEditPlus: a repeated reference is harmless.
  "qwen-image-edit-2511-multi": { reuse: true },
  "storyboard-qwen-edit-2509-next-scene": { reuse: true },
  "tryon-flux2-klein-4b": { required: ["image2"], hints: { image: "Add a photo of the person", image2: "Add the garment to try on" } },
  // Its describer reads the outfit photo; the words graph (outfit-swap-qwen-image-21-text) runs when there is none.
  "outfit-swap-qwen-image-21": { required: ["image2"], hints: { image: "Add your photo", image2: "Add the outfit photo, or describe the outfit" } },
  "palette-transfer-image": { hints: { image2: "Pick a palette or add a reference image" } },
  "palette-transfer-video": { hints: { image: "Pick a palette or add a reference image" } },
  "relight-qwen-edit-2509-reference": { hints: { image2: "Add the photo whose light to copy" } },
  "face-swap-reactor": { hints: { image2: "Add the face to put in" } },
  // Qwen-Image 2.1's encoder takes its references as optional inputs: without the head it would run as a plain edit.
  "head-swap-qwen-image-21": { required: ["image2"], hints: { image: "Add the photo to keep", image2: "Add a photo of the head to put in" } },
  "video-swap-wan-vace": { hints: { image: "Add a picture of what goes in" } },
  "video-insert-wan-vace": { hints: { image: "Add a picture of what to add", mask: "Paint where it goes on the first frame" } },
  // Pixal3D multi-view: the front, then any of the other sides.
  "image-to-3d-trellis2-multiview": { hints: { image: "Add a photo of the front" }, views: { sides: ["front", "left", "back", "right"], into: "Pixal3DMultiViewConditioning" } },
};

/**
 * Encoders that take their extra references as optional inputs (Qwen-Image 2.1's and FIBO 2's image list, Krea 2 Edit's
 * person): a reference left out goes with the nodes only it feeds, and the encoder runs on the ones it was given.
 * Slots drop from the last, so an encoder's numbered inputs never have a gap.
 */
const OPTIONAL_REFERENCE_INPUTS: ReadonlySet<string> = new Set([
  "TextEncodeQwenImage21",
  "TextEncodeFibo2",
  "Krea2EditModelPatch",
  "Krea2EditGroundedEncode",
  // FLUX 3 Image Klein's edit: its references on one ReferenceMultiLatent, and the batch its prompt helper looks at.
  "ReferenceMultiLatent",
  "BatchImagesNode",
  // Qwen-Image 2.1 on a small GPU: Zen Image Edit's encoder takes image_2-4 the same way.
  "ZenImage21TextEncode",
]);

/** Uploads that are sides of one object (image = the first side, image2 the second…), and the node they all go into. */
interface ViewSlots {
  sides: string[];
  into: string;
}

const IMAGE_SLOTS = ["image", "image2", "image3", "image4"] as const;
/** Every reference slot a graph can bind, in order (FLUX 3 Image Klein's edit takes 10). */
const REFERENCE_SLOTS = ["image", "image2", "image3", "image4", "image5", "image6", "image7", "image8", "image9", "image10"] as const;

/**
 * Which slot each photo of a multi-view 3D model goes to: params.extra.views names the side of each photo
 * ("front", "left"…), in the order of the images; without names they are the sides in order.
 */
export function viewSlots(views: ViewSlots, images: string[], named: unknown): Partial<Record<(typeof IMAGE_SLOTS)[number], string>> {
  const sides = Array.isArray(named) ? named.map((v) => String(v).toLowerCase()) : views.sides.slice(0, images.length);
  if (sides.length !== images.length) throw new ProviderError(`${images.length} photo${images.length === 1 ? "" : "s"} but ${sides.length} side${sides.length === 1 ? "" : "s"} named`);
  const out: Partial<Record<(typeof IMAGE_SLOTS)[number], string>> = {};
  sides.forEach((side, i) => {
    const at = views.sides.indexOf(side);
    if (at < 0 || at >= IMAGE_SLOTS.length) throw new ProviderError(`A photo's side must be ${views.sides.join(", ")} (got “${side}”)`);
    if (out[IMAGE_SLOTS[at]]) throw new ProviderError(`Two photos of the ${side}: keep one`);
    out[IMAGE_SLOTS[at]] = images[i];
  });
  return out;
}

const MEDIA_HINT: Record<string, string> = {
  image: "Add an image",
  image2: "Add a second image",
  image3: "Add a third image",
  image4: "Add a fourth image",
  image5: "Add a fifth image",
  image6: "Add a sixth image",
  image7: "Add a seventh image",
  image8: "Add an eighth image",
  image9: "Add a ninth image",
  image10: "Add a tenth image",
  endImage: "Add an end frame",
  splatFile: "Build the 3D view first",
  mask: "Paint the area to change",
  video: "Add a video",
  video2: "Add a second clip",
  video3: "Add a third clip",
  video4: "Add a fourth clip",
  audio: "Add an audio track",
  audio2: "Add the second audio track",
  paletteImage: "Pick a palette first",
};

/** Binding keys that point at an upload (LoadImage / LoadVideo / LoadAudio…). */
export function mediaKeys(manifest: ManifestWorkflow, workflow: ComfyWorkflow): string[] {
  return Object.entries(manifest.bindings)
    .filter(([, targets]) => targets?.some((t) => MEDIA_LOADERS[workflow[t.node]?.class_type ?? ""] === t.input))
    .map(([k]) => k);
}

const isMediaRef = (v: unknown): v is string => typeof v === "string" && (v.startsWith("/api/files/") || v.startsWith("data:"));

export interface PrepareContext {
  generationId: string;
  op: Operation;
  /** Upload a file to ComfyUI's input folder; returns the name LoadImage/LoadAudio/LoadVideo take. */
  upload: (data: Buffer, contentType: string, name: string) => Promise<string>;
  /** Header facts (duration, size, fps, audio track) of an uploaded clip or track, by its ComfyUI name. */
  media?: (name: string) => MediaInfo | undefined;
  /** The ComfyUI server's RAM in bytes, for graphs that hold a whole clip in memory. */
  serverRam?: () => Promise<number | undefined>;
  /** The server's first torch device type ("cuda", "cpu", "mps"…; GET /system_stats devices[0].type): DBS picks its model by it. */
  device?: () => Promise<string | undefined>;
  /** Where a model file is on the server's disk (comfyModelPath), undefined when it can't say: Zen Image Edit's loader reads paths. */
  modelPath?: (folder: string, name: string) => Promise<string | undefined>;
  /** The first device's memory in bytes (GET /system_stats devices[0].vram_total): the Watermark Remover's repair size. */
  vram?: () => Promise<number | undefined>;
  /** The DBS models on the server's disk (GET /models/dbs), undefined when it can't say: a run never gets one that isn't there. */
  dbsModels?: () => Promise<DbsModel[] | undefined>;
  /** The RE-USE files on the server's disk (GET /models/reuse): null without ComfyUI-RE-USE, undefined when it can't say. */
  reuseModels?: () => Promise<ReuseModel[] | null | undefined>;
  /** Whether the server has the ComfyUI-Idol pack (GET /object_info/IdolPruneSplat): Idol 3D then runs its clean graph. */
  idolPack?: () => Promise<boolean | undefined>;
  /**
   * The route puts the run's one LoRA in the graph's own LoRA slot (ModelRoute.loraSlot: Fuobe Speak's FusioniX on kijai's
   * InfiniteTalk graph, with the settings it goes with). Without it a graph with no model loader refuses a LoRA.
   */
  loraSlot?: boolean;
}

export interface PreparedPrompt {
  manifest: ManifestWorkflow;
  workflow: ComfyWorkflow;
  meta: Record<string, unknown>;
}

/**
 * The canvas a Qwen-Image 2.1 Lightning run samples (its sigmas follow the size): text to image's width × height; an edit's
 * image 1 scaled to 2048 on its long side (the graph's scaling, up or down); inpaint's 1.5 MP crop and expand's 1 MP canvas.
 */
function lightningCanvas(capability: string, values: Partial<Record<BindingKey, unknown>>, image: MediaInfo | undefined): { width: number; height: number } | undefined {
  if (capability === "t2i") {
    const [w, h] = [Number(values.width), Number(values.height)];
    return w > 0 && h > 0 ? { width: w, height: h } : undefined;
  }
  // Only the area counts (tokens of 16 × 16 px): 1.5 MP and 1 MP squares.
  if (capability === "inpaint") return { width: 1254, height: 1254 };
  if (capability === "outpaint") return { width: 1024, height: 1024 };
  // An edit: image 1 scaled to 2048 on its long side, larger or smaller (the graph's ImageScaleToMaxDimension). Without its
  // size the graph keeps its own schedule, made for a 2048 square.
  return image?.width && image.height ? editCanvas(image.width, image.height) : undefined;
}

/** Caption cues for the burn-in: params.extra.cues, or the prompt's "start-end: text" / SRT lines. */
function captionCues(input: GenInput, extra: Record<string, unknown>): CaptionCue[] {
  const given = Array.isArray(extra.cues)
    ? (extra.cues as Partial<CaptionCue>[]).map((c) => ({ start: Number(c.start), end: Number(c.end), text: String(c.text ?? "") })).filter((c) => Number.isFinite(c.start) && c.end > c.start && c.text.trim())
    : parseCueLines(input.prompt);
  return splitCueWords(given, Number(extra.wordsPerCaption ?? 0));
}

const seconds = (n: number) => (n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));

/**
 * Per-frame restyle graphs that follow the clip when a run sets nothing else (Edit video sends a clip and words): the clip's
 * shape, its frame rate up to FOLLOW_CLIP_MAX_FPS, and its whole length. The Mixed Media studio sends its own size, rate and
 * frame count (src/lib/catalog/mixed-media.ts), and those win.
 */
const FOLLOW_CLIP: ReadonlySet<string> = new Set(["mixed-media-zimage-frames"]);
const FOLLOW_CLIP_MAX_FPS = 24;
const GB = 2 ** 30;

const clipFacts = (clip: MediaInfo | undefined) => ({ width: clip?.width, height: clip?.height, fps: clip?.fps, frames: clip?.frames, duration: clip?.videoDuration ?? clip?.duration });

/**
 * Values and graph edits for the Upscale hub's open tools, from the request and the clip's header:
 * VHS format / profile (export), CreateVideo's colour space (HDR10 PQ or HLG), FPS Boost's multiplier m,
 * selection n and slow motion (src/lib/av/fps.ts), the chunked upscalers' short side and pass size.
 * `holds` = frame-sized copies of the whole clip the graph keeps in memory (for the RAM check).
 */
function videoFinishValues(manifest: ManifestWorkflow, input: GenInput, clip: MediaInfo | undefined, extra: Record<string, unknown>) {
  const b = manifest.bindings;
  const d = manifest.defaults;
  const facts = clipFacts(clip);
  const values: Partial<Record<BindingKey, unknown>> = {};
  const out = { values, wholeClip: null as ReturnType<typeof wholeClipTool>, bypassInterpolation: false, dropSound: false };
  try {
    // Export: VideoHelperSuite's format and ProRes profile.
    if (manifest.capability === "export-video" && b.format) {
      const v = exportValues(input.format);
      values.format = v.format;
      if (v.profile) values.profile = v.profile;
    }
    // SDR to HDR: HLG or PQ (HDR10's curve).
    if (manifest.capability === "sdr-to-hdr" && b.colorSpace) values.colorSpace = hdrColorSpace(input.format);
  } catch (e) {
    throw new ProviderError((e as Error).message);
  }
  // Graphs that decode the whole clip (src/lib/av/video-finish.ts wholeClipTool says how many copies they hold).
  if (manifest.capability === "sdr-to-hdr") out.wholeClip = wholeClipTool("sdr-to-hdr", input.format);
  if (manifest.id === "video-export-exr") out.wholeClip = wholeClipTool("export-video", "exr");
  if (manifest.capability === "video-fix-faces") out.wholeClip = wholeClipTool("face-fix-video", undefined);
  // FPS Boost: interpolate by m, keep every n-th frame (the graph computes the output frame rate itself).
  if (b.every && b.multiplier) {
    const target = input.targetFps;
    const slowdown = Math.max(1, Math.round(input.slowdown ?? 1));
    let m = Number(extra.multiplier ?? d.multiplier ?? 2);
    let n = 1;
    // m, n and the slow-motion factor go together: a stray params.extra value can't break the ratio.
    for (const k of ["multiplier", "every", "slowdown"]) delete extra[k];
    if (target) {
      // m and n come from the clip's own rate (the upload's header, else what the server read from it).
      const sourceFps = clip?.fps && clip.fps > 0 ? clip.fps : input.sourceFps && input.sourceFps > 0 ? input.sourceFps : undefined;
      if (!sourceFps) {
        throw new ProviderError(
          `FPS Boost on the open engine works out its frames from the clip's frame rate, and this file doesn't say what it is, so ${target} fps can't be hit. Re-save it as MP4 (H.264) or WebM and try again`,
        );
      }
      const plan = fpsPlan(sourceFps, target, slowdown, Number(manifest.limits?.maxMultiplier ?? 16));
      m = plan.multiplier;
      n = plan.every;
    } else m = Math.max(2, Math.min(Number(manifest.limits?.maxMultiplier ?? 16), Math.round(m * slowdown)));
    // m 1 (a target the clip's rate is a whole multiple of: 60 → 30 keeps every 2nd frame): FrameInterpolate is
    // linked out below, and the graph's frame-rate expression still reads m, so it gets the real 1. Other lower
    // targets still interpolate (30 → 24 is m 4, n 5).
    values.multiplier = m;
    values.every = n;
    values.slowdown = slowdown;
    out.bypassInterpolation = m < 2;
    out.dropSound = slowdown > 1;
    out.wholeClip = wholeClipTool("interpolate", undefined, m);
  }
  // Chunked upscaling: the shorter edge asked for, and passes that hold about 1.5 GB of frames.
  if (b.shortSide) {
    const shortSide = upscaleShortSide(input.resolution, Number(d.shortSide ?? 1080));
    values.shortSide = shortSide;
    if (b.framesPerBatch && extra.framesPerBatch === undefined) {
      const seedvr = /seedvr/i.test(manifest.id);
      // RTX Video Super Resolution writes the scaled frame itself (1-4x, the graph's own factor), not a fixed 4x one.
      const rtx = manifest.id === RTX_UPSCALE_WORKFLOW;
      const modelScale = seedvr ? 0 : rtx ? rtxScale(facts, shortSide) : 4;
      // ESRGAN on a big source (1440p → 2160p: about 0.85 GB a frame): down to one frame a pass, to stay near the budget.
      values.framesPerBatch = framesPerPass(facts, { shortSide, modelScale, fourNPlusOne: seedvr, min: seedvr ? 5 : 1, max: seedvr ? 33 : 64, fallback: Number(d.framesPerBatch ?? 16) });
    }
  } else if (b.framesPerBatch && manifest.capability === "export-video" && extra.framesPerBatch === undefined) {
    values.framesPerBatch = framesPerPass(facts, { min: 8, max: 256, fallback: Number(d.framesPerBatch ?? 64) });
  } else if (b.framesPerBatch && manifest.capability === "video-tone" && extra.framesPerBatch === undefined) {
    // Fix colours: a pass holds three frame-sized copies (the decoded frames, the softened ones, the toned ones).
    values.framesPerBatch = framesPerPass(facts, { modelScale: 1, min: 8, max: 128, fallback: Number(d.framesPerBatch ?? 48) });
  }
  return out;
}

/** Per-job length limits a graph enforces (manifest limits.maxDurationSec), in words. */
const OVER_LIMIT: Record<string, (s: number) => string> = {
  "still-motion": (s) => `Ken Burns on the open engine makes up to ${s} s per clip — split a longer move into pieces`,
  "audio-loop": (s) => `Loops on the open engine run up to ${s / 60} minutes (${s} s)`,
  music: (s) => `This model writes songs up to ${s % 60 ? `${s} s` : `${s / 60} minutes`} on your GPU: pick a shorter length`,
};

/** Songs longer than this decode in tiles on your GPU (MiniMax Music 3's switch). */
export const TILED_SONG_SECONDS = 120;

/**
 * Turn a canonical request into the exact ComfyUI prompt: picks the workflow variant, maps Fuobe's inputs
 * onto the workflow's bindings (sizes, frames, trim times, languages, palettes, layers…), uploads files the
 * provider makes itself (palette swatches, media refs in params.extra) and rewrites graphs that depend on the
 * request (caption cues, left-out references). What the uploads' headers say (`ctx.media`) sizes clips to
 * their source, checks times against the clip's length and times lip re-sync by the voice. Pure apart from
 * `ctx.upload` / `ctx.serverRam` and reading the workflow files.
 */
export async function prepareWorkflow(endpointTemplate: string, input: GenInput, ctx: PrepareContext): Promise<PreparedPrompt> {
  // "video-concat-{n}": one workflow per clip count.
  const clips = input.videos ?? [];
  if (endpointTemplate.includes("{n}") && clips.length > 4) throw new ProviderError("ComfyUI joins up to 4 clips at a time");
  const extra: Record<string, unknown> = { ...(input.extra ?? {}) };
  // The second audio track (mux background): the canonical input when the runtime sends it, else params.extra.audio2.
  const given2 = (input as GenInput & { audio2?: unknown }).audio2;
  const audio2 = typeof given2 === "string" && given2 ? given2 : undefined;
  if (audio2) delete extra.audio2;

  // Media refs in params.extra (e.g. a background stem for "audio2") are uploaded like regular inputs.
  for (const [k, v] of Object.entries(extra)) {
    if (!isMediaRef(v)) continue;
    // An account's file is read and sent when it may send (account-send.ts), as the run's other inputs are.
    const send = async () => {
      const f = await readRef(v);
      return ctx.upload(f.data, f.contentType, f.name);
    };
    const account = ownGpu() ? tenantAccount() : undefined;
    extra[k] = await (account ? accountSend(account, send) : send());
  }
  // The variant this request runs (one graph per clip count, the single-track soundtrack, EXR frames, a Fun Camera pose,
  // the product shot): src/lib/comfy-variants.ts, which the GPU pre-flight's gate reads too. A LoRA mixed into a pose is
  // injected on its experts as on the plain image-to-video graph.
  let endpoint = resolveWorkflowId(endpointTemplate, {
    op: ctx.op,
    clips: clips.length,
    images: input.images?.length ?? 0,
    format: input.format,
    audio2: !!audio2 || !!extra.audio2,
    audio: !!input.audio,
    mask: !!input.mask,
    extra,
    has: (id) => loadManifest().workflows.some((w) => w.id === id),
  });
  // Idol 3D: the clean graph (ComfyUI-Idol's crop, the pruned splat, the input-view still) where the server has the pack,
  // else the core graph, whose saved file isn't pruned (its splat says so: meta.pruned false).
  if (endpoint === IDOL_WORKFLOWS.core && loadManifest().workflows.some((w) => w.id === IDOL_WORKFLOWS.clean) && (await ctx.idolPack?.().catch(() => undefined)) === true) {
    endpoint = IDOL_WORKFLOWS.clean;
  }
  // Idol 3D's four views need the pack's camera (IdolCamera): with no pack (or the pack switched off in Settings), say so
  // instead of a missing-node error. Unknown (someone's computer, a server that didn't answer): their ComfyUI has the last word.
  if (endpoint === IDOL_VIEWS_WORKFLOW && (await ctx.idolPack?.().catch(() => undefined)) === false) throw new ProviderError(IDOL_VIEWS_NEEDS_PACK, 400);
  delete extra[IDOL_VIEWS_PARAM];
  delete extra.productShot;
  delete extra[SPEED_PARAM];
  delete extra[GPU_PARAM];
  delete extra[DECODER_PARAM];

  const { manifest, workflow } = getWorkflow(endpoint);
  const d = manifest.defaults;
  const b = manifest.bindings;
  const rules = SLOT_RULES[manifest.id] ?? {};
  const images = input.images ?? [];
  const values: Partial<Record<BindingKey, unknown>> = {
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    image: images[0],
    image2: images[1],
    image3: images[2],
    image4: images[3],
    // FLUX 3 Image Klein's edit binds up to ten references.
    ...Object.fromEntries(REFERENCE_SLOTS.slice(4).map((k, i) => [k, images[i + 4]])),
    endImage: input.endImage,
    mask: input.mask,
    video: input.video ?? clips[0],
    video2: clips[1],
    video3: clips[2],
    video4: clips[3],
    audio: input.audio,
    // A 3D model to work on (Hi3D's refine reads the coarse GLB from ComfyUI's input folder, where it was uploaded).
    model3d: input.model3d,
    seed: input.seed !== undefined && input.seed >= 0 ? input.seed : randomSeed(),
  };
  // A multi-view 3D model: each photo goes to its side.
  if (rules.views) Object.assign(values, { image: undefined, image2: undefined, image3: undefined, image4: undefined }, viewSlots(rules.views, images, extra.views));
  delete extra.views;
  // Voice workflows: "audio" is the voice to speak with (TTS), speaker A (dialogue) or the speech to convert
  // (voice change, whose target voice is "audio2").
  if (ctx.op === "tts") values.audio = input.voiceAudio ?? input.audio;
  if (ctx.op === "dialogue") {
    values.audio = input.voiceAudio;
    values.audio2 = input.voiceAudio2;
    values.prompt = (input.dialogue ?? []).filter((l) => l.text.trim()).map((l) => `SPEAKER ${l.voice === "B" ? "B" : "A"}: ${l.text.trim()}`).join("\n");
  }
  if (ctx.op === "voice-change") values.audio2 = input.voiceAudio;
  // Design a voice (Qwen3-TTS, VoxCPM2): the voice in words; a clone reads what its sample says (VoxCPM2's "ultimate" clone).
  if (ctx.op === "voice-design") values.voiceDescription = input.voiceDescription?.trim();
  if (ctx.op === "tts" && b.voiceTranscript && input.voiceTranscript?.trim()) values.voiceTranscript = input.voiceTranscript.trim();
  // VoxCPM2's device combo lists what the GPU has (cuda, mps, cpu): the server's first torch device, else the graph's cuda.
  if (b.device && extra.device === undefined) {
    const dev = await ctx.device?.();
    if (dev === "cuda" || dev === "mps" || dev === "cpu") values.device = dev;
  }
  // A join of audio clips takes them in order: the graph binds the first two, expandAudioJoinWorkflow the rest.
  const audios = input.audios ?? [];
  if (manifest.expand === "audios" && audios.length) {
    values.audio = audios[0];
    values.audio2 = audios[1];
  }
  // A voice track on the video's timeline: the clips are the spoken lines (the template binds the first).
  if (ctx.op === "timeline") values.audio = input.audios?.[0] ?? input.audio;
  // Speech workflows read the soundtrack with LoadAudio, which also takes a video upload.
  if ((ctx.op === "transcribe" || ctx.op === "separate-audio" || ctx.op === "enhance-voice" || ctx.op === "translate" || ctx.op === "speech-edit") && b.audio && !b.video) values.audio = input.audio ?? input.video ?? clips[0];
  if (b.language && input.targetLanguage) values.language = input.targetLanguage;
  if (b.sourceLanguage && input.sourceLanguage) {
    const whisper = b.sourceLanguage.some((t) => workflow[t.node]?.class_type === "Apply Whisper");
    values.sourceLanguage = whisper ? whisperLanguage(input.sourceLanguage) : asrLanguage(input.sourceLanguage);
  }
  if (b.instruction) {
    const template = String(extra.instruction ?? d.instruction ?? "");
    delete extra.instruction;
    if (template.includes("{language}") && !input.targetLanguage) throw new ProviderError("Pick a language to translate into");
    values.instruction = template.replaceAll("{language}", languageName(input.targetLanguage));
  }

  // What the upload headers say about the clip (and the voice).
  const clip = ctx.media?.(String(values.video ?? ""));
  const clipLength = clip?.videoDuration ?? clip?.duration;

  // Frame rate (params.fps, or a model's fps control), trim window and frame counts.
  const fpsIn = input.fps ?? (typeof extra.fps === "number" && extra.fps > 0 ? extra.fps : undefined);
  if (b.fps && fpsIn) values.fps = fpsIn;
  const followClip = FOLLOW_CLIP.has(manifest.id) && ctx.op === "v2v" && !!clip;
  if (followClip && b.fps && !fpsIn && clip?.fps && clip.fps > 0) values.fps = Math.max(1, Math.min(FOLLOW_CLIP_MAX_FPS, Math.round(clip.fps)));
  const fps = Number(values.fps ?? d.fps ?? 16);
  const start = Math.max(0, input.startTime ?? 0);
  if (b.startTime || b.startFrame) {
    if (input.endTime !== undefined && input.endTime <= start) throw new ProviderError("The end time must be after the start time");
    if (clipLength && start >= clipLength) throw new ProviderError(`The start time is past the end of the clip (it is ${seconds(clipLength)} s long)`);
  }
  // Sound for a video with no length asked for: as long as the clip (up to 30 s, and what the frame cap holds).
  const soundLength =
    ctx.op === "v2a" && b.duration && input.endTime === undefined && !input.duration && clipLength
      ? Math.min(30, Number(manifest.limits?.maxFrames ?? Infinity) / fps, Math.ceil(clipLength * 10) / 10)
      : undefined;
  const span = input.endTime !== undefined ? Math.max(0, input.endTime - start) : (input.duration ?? soundLength);
  if (b.startTime && input.startTime !== undefined) values.startTime = start;
  if (b.startFrame && input.startTime !== undefined) values.startFrame = Math.round(start * fps);
  if (b.duration) {
    if (input.endTime !== undefined) values.duration = span;
    else if (input.duration) values.duration = input.duration;
    else if (soundLength) values.duration = soundLength;
    else if (ctx.op === "trim") values.duration = 0; // from the start time to the end
  }
  // MiniMax H3 stretches the start frame to the canvas with no crop: a clip from a still (or the orbit of one) always takes the
  // still's shape, so an aspect ratio left over from a text draft can't distort it.
  const h3 = isH3Graph(manifest.id);
  // The clip's own size: its upload's header, else what the server read from the file before sending it (sourceSize).
  const clipSize = clip?.width && clip.height ? clip : input.sourceSize?.width && input.sourceSize.height ? input.sourceSize : undefined;
  // Motion transfer crops the driving clip to the canvas, so the canvas always takes the clip's shape: a run that names
  // none (the Motion control studio) fell back to the graph's portrait 482 × 854 and cut a landscape clip's sides off.
  const followDriver = ctx.op === "motion-transfer" && !!b.video && !!clipSize;
  // References (Pika H3 Flex Ref2VA) are not frames: the aspect ratio asked for holds ("auto" takes Image 1's shape).
  const asFrames = h3 && (ctx.op === "i2v" || ctx.op === "flf2v" || (!!b.image && manifest.expand !== "references"));
  const aspectRatio = asFrames || (h3 && ctx.op === "avatar") ? "auto" : (followClip && !input.aspectRatio) || followDriver ? "auto" : input.aspectRatio;
  if (b.width || b.height) {
    const multiple = Number(manifest.limits?.dimensionMultiple ?? 16);
    // With motion paths the frame keeps the start image's shape, so the paths need no cropping;
    // "auto" keeps the source clip's shape when its header told us.
    const srcAspect = (extra.motionPaths as MotionPaths | undefined)?.aspect;
    // "auto" keeps the source clip's shape when its header told us, else the start frame's (image-to-video).
    const still = aspectRatio === "auto" && !clipSize ? ctx.media?.(String(values.image ?? "")) : undefined;
    const src = clipSize ?? (still?.width && still.height ? still : undefined);
    const shape = srcAspect ? `${srcAspect[0]}:${srcAspect[1]}` : aspectRatio === "auto" ? (src ? `${src.width}:${src.height}` : undefined) : aspectRatio;
    if (h3) {
      // H3's own canvas (ComfyUI's adapt_canvas): 768 px on the short side, at most 768 × 1344, multiples of 32.
      Object.assign(values, h3Canvas(shape));
    } else {
      const dims = computeDimensions(shape, input.resolution, { width: Number(d.width ?? 1024), height: Number(d.height ?? 1024) }, multiple);
      // Respect the workflow's size limits while keeping the aspect ratio.
      const maxW = Number(manifest.limits?.maxWidth ?? Infinity);
      const maxH = Number(manifest.limits?.maxHeight ?? Infinity);
      const k = Math.min(1, maxW / dims.width, maxH / dims.height);
      values.width = Math.max(multiple, Math.floor((dims.width * k) / multiple) * multiple);
      values.height = Math.max(multiple, Math.floor((dims.height * k) / multiple) * multiple);
    }
  }
  // An end card appended to an ad (video-append-endcard): the card is encoded at the ad's own size and frame rate,
  // so the ad's packets are copied as they are. Only the ad's header knows them.
  if (manifest.id === "video-append-endcard") {
    if (!clip?.width || !clip.height || !clip.fps) throw new ProviderError("Couldn't read the ad's size and frame rate, so the end card can't be added");
    Object.assign(values, { width: clip.width, height: clip.height, fps: Math.round(clip.fps * 1000) / 1000 });
  }
  if (b.frames && span) {
    if (h3) {
      // H3's 17n + 5 grid at 24 fps (3 s → 73, 5 s → 124, 10 s → 243, 15 s → 362): the clip h3Prompt's end-frame mark names.
      const cap = Number(manifest.limits?.maxFrames ?? Infinity);
      let frames = h3Frames(span);
      while (frames > cap) frames -= 17;
      values.frames = frames;
    } else values.frames = computeFrames(span, fps, Number(d.frameStep ?? 4), manifest.limits?.maxFrames);
  } else if (followClip && b.frames && !span && extra.frames === undefined && clipLength) {
    // The whole clip from its start (or the start time asked), refused past the graph's frame cap rather than cut short.
    const frames = Math.max(1, Math.floor((clipLength - start) * fps));
    const cap = Number(manifest.limits?.maxFrames ?? Infinity);
    if (frames > cap) {
      throw new ProviderError(`This model redraws up to ${cap} frames per job on the open engine (${seconds(cap / fps)} s at ${fps} fps; this clip is ${seconds(clipLength - start)} s) — trim the clip, or pick a range and a frame rate in the Mixed Media studio`);
    }
    values.frames = frames;
  }
  // Lip re-sync and a talking avatar run as long as the voice (its header, or the length the run was given); a voice past
  // the frame cap is refused, not cut.
  const voiceLength =
    (ctx.op === "lipsync" || ctx.op === "avatar") && b.frames && !span
      ? (ctx.op === "avatar" && input.sourceDuration && input.sourceDuration > 0 ? input.sourceDuration : ctx.media?.(String(values.audio ?? ""))?.duration)
      : undefined;
  if (voiceLength && h3) {
    // H3 makes the clip with its own sound, on its 17n + 5 grid: as long as the voice, 5-15 s (the reference limits say why not).
    values.frames = h3Frames(Math.min(15, Math.max(5, voiceLength)));
  } else if (voiceLength) {
    const step = Number(d.frameStep ?? 4);
    const frames = Math.ceil((voiceLength * fps) / step) * step + 1;
    const cap = Number(manifest.limits?.maxFrames ?? 0);
    if (cap && frames > cap) {
      const what = ctx.op === "avatar" ? "A talking avatar" : "Lip re-sync";
      throw new ProviderError(`${what} on the open engine takes up to ${seconds(cap / fps)} s of speech per job (this voice is ${seconds(voiceLength)} s) — split it into shorter parts`);
    }
    values.frames = frames;
  }
  // Kandinsky VSR: the factor asked (params.resolution "2x" / "2.25x" / "4x") as the pack's combo, and the latent upscaler bank
  // entry it needs (2x serves 2x and 2.25x).
  if (b.upscalerScale) {
    const k = factorTier(input.resolution) ?? factorTier(String(d.scale ?? "")) ?? 2.25;
    if (![2, 2.25, 4].includes(k)) throw new ProviderError("Kandinsky VSR upscales 2x, 2.25x or 4x", 400);
    values.scale = `${k}x`;
    values.upscalerScale = k === 4 ? "4x" : "2x";
  }
  // Video finishing (Upscale hub): export formats, HDR curves, FPS Boost's m / n, chunked upscaling.
  const finish = videoFinishValues(manifest, input, clip, extra);
  Object.assign(values, finish.values);
  // Open-H3 Regenerate (video-regenerate-h3): the output size and the draft preset as the pack's strings, and the frames
  // this pass reads (its seconds at 24 fps, at most 15 s); the words are what it redraws from (regenerate.ts).
  if (manifest.id === REGEN_WORKFLOW) {
    if (!(typeof values.prompt === "string" && values.prompt.trim())) throw new ProviderError("Regenerate redraws the clip from words: describe what is in it", 400);
    const length = span ?? (clipLength !== undefined ? Math.max(0, clipLength - start) : input.sourceDuration);
    // One pass reads at most 15 s: a longer one (a clip from an earlier step) is refused, never cut short.
    if (length !== undefined && length > REGEN_WINDOW_SECONDS + 0.05) throw new ProviderError(regenOnePassRefusal(length), 400);
    values.resolution = regenResolution(input.resolution);
    values.draftSize = draftSizeFor({ fromH3: extra.draftFrom === "h3" });
    values.frames = regenFrames(length);
    delete extra.draftFrom;
  }
  // MiniMax H3 at 2K (n7-10): the 768p draft saves its latent under a name made from its run's id, and the finish loads
  // that file (the same ComfyUI keeps it in output/open_h3_latents/), redrawing it at the size asked from the same words.
  if (manifest.id === H3_LATENT_DRAFT_WORKFLOW) {
    values.latentPrefix = latentPrefixFor(ctx.generationId);
    delete extra.latentDraft;
  }
  if (manifest.id === REGEN_LATENT_WORKFLOW) {
    if (!(typeof values.prompt === "string" && values.prompt.trim())) throw new ProviderError("Regenerate redraws the clip from words: describe what is in it", 400);
    if (typeof extra.latentFrom !== "string" || !extra.latentFrom) throw new ProviderError("This take has no saved draft to finish from", 400);
    values.latent = latentFileFor(extra.latentFrom);
    values.resolution = regenResolution(input.resolution);
    delete extra.latentFrom;
    delete extra.draftFrom;
  }

  // Drawn motion paths (normalised to the start frame) → one pixel point per output frame (Wan-Move).
  const paths = extra.motionPaths as MotionPaths | undefined;
  delete extra.motionPaths;
  if (b.tracks && paths?.paths.length) {
    const frames = Number(values.frames ?? d.frames ?? 81);
    values.tracks = JSON.stringify(tracksFor(paths, Number(values.width ?? d.width ?? 832), Number(values.height ?? d.height ?? 480), frames));
  }
  if (b.tags && !b.prompt) values.tags = input.prompt;
  // MiniMax Music 3: a song over 2 minutes decodes in tiles (much less VRAM), as the template's Tiled decode switch offers.
  if (b.tiledDecode && extra.tiledDecode === undefined) values.tiledDecode = Number(values.duration ?? d.duration ?? 0) > TILED_SONG_SECONDS;
  if (b.description && !extra.description) values.description = input.prompt;
  if (b.numLayers && input.numLayers) values.numLayers = Math.max(1, Math.min(Number(manifest.limits?.maxLayers ?? 10), Math.round(input.numLayers)));

  // Ken Burns (kenburns-still): the move's zoom, crop centre and easing.
  if (b.zoomStart && input.zoomFrom !== undefined) values.zoomStart = input.zoomFrom;
  if (b.zoomEnd && input.zoomTo !== undefined) values.zoomEnd = input.zoomTo;
  if (b.panStartX && input.panFrom) Object.assign(values, { panStartX: input.panFrom.x, panStartY: input.panFrom.y });
  if (b.panEndX && input.panTo) Object.assign(values, { panEndX: input.panTo.x, panEndY: input.panTo.y });
  if (b.easeInOut && input.easing) values.easeInOut = input.easing === "linear" ? 0 : 1;
  const maxSeconds = Number(manifest.limits?.maxDurationSec ?? 0);
  if (maxSeconds && b.duration && Number(values.duration ?? d.duration ?? 0) > maxSeconds + 0.001) {
    throw new ProviderError(OVER_LIMIT[manifest.capability]?.(maxSeconds) ?? `This workflow makes up to ${maxSeconds} s per job`);
  }
  // Edit speech (speech-edit-auk): the edit windows the planner made, crossfaded back on a linear fade-in with a flat tail
  // (src/lib/av/speech-edit-graph.ts says why; both sides of a seam are the same voice, so equal power would bump the level).
  let speechWindows: SpeechWindow[] | null = null;
  const aukQuality = extra.quality === "best" ? "best" : "fast";
  if (manifest.expand === "speech") {
    speechWindows = readSpeechWindows(extra.speechWindows);
    if (!speechWindows) throw new ProviderError("Nothing to change: edit the words, or pick a range and an effect", 400);
    if (b.fadeCurve && extra.fadeCurve === undefined) extra.fadeCurve = await ctx.upload(Buffer.from(speechFadeWav(Math.max(0.02, Number(input.crossfade ?? d.crossfade ?? 0.12)))), "audio/wav", "speech_fade.wav");
  }
  if (Object.values(workflow).some((n) => n.class_type === "AuKModelLoader")) {
    delete extra.speechWindows;
    delete extra.quality;
  }
  // Loops and joins with a crossfade: core ComfyUI has no gain ramp, so the curve is a tiny WAV written here
  // (left = fade-in, right = fade-out, exactly the crossfade long). Clips too short for it are refused up front.
  if (b.fadeCurve) {
    const fade = Math.max(0.02, Number(input.crossfade ?? d.crossfade ?? 1));
    if (b.crossfade) values.crossfade = fade;
    const loop = manifest.capability === "audio-loop";
    const lengths = (loop ? [values.audio] : audios.length ? audios : [values.audio, values.audio2 ?? extra.audio2]).map((name) => ctx.media?.(String(name ?? ""))?.duration);
    const problem = lengths.every((l): l is number => typeof l === "number") ? crossfadeProblem(lengths, fade, loop ? "loop" : "join") : null;
    if (problem) throw new ProviderError(problem);
    if (extra.fadeCurve === undefined) values.fadeCurve = await ctx.upload(Buffer.from(fadeCurveWav(fade, extra.curve === "linear" ? "linear" : "equal-power")), "audio/wav", "fade_curve.wav");
  }
  delete extra.curve;

  // Soul HEX: the hex list as words, plus a swatch the ColorTransfer lock matches.
  const palette = (input.palette ?? []).filter((p) => typeof p === "string" && p.trim());
  if (palette.length) {
    const sentence = paletteSentence(palette);
    if (!sentence) throw new ProviderError("The palette has no valid hex colours (use #RRGGBB)");
    if (b.paletteText) values.paletteText = sentence;
    const swatchSlot = b.paletteImage ? "paletteImage" : ctx.op === "color-match" ? (b.image2 && !values.image2 ? "image2" : b.video && b.image && !values.image ? "image" : undefined) : undefined;
    if (swatchSlot) {
      const weights = Array.isArray(extra.paletteWeights) ? (extra.paletteWeights as number[]) : undefined;
      const px = Buffer.from(swatchPixels(palette, 512, 512, weights));
      values[swatchSlot] = await ctx.upload(encodePng({ width: 512, height: 512, data: px }), "image/png", "palette_swatch.png");
    }
  } else if (b.paletteImage && images[0]) values.paletteImage = images[0]; // a swatch the user made
  delete extra.paletteWeights;

  // Trigger words a LoRA needs at the start of the prompt (try-on: "TRYON").
  const prefix = typeof d.promptPrefix === "string" ? d.promptPrefix.trim() : "";
  if (prefix && typeof values.prompt === "string" && values.prompt.trim() && !values.prompt.trim().startsWith(prefix)) values.prompt = `${prefix} ${values.prompt.trim()}`;
  // Framing text defaults with placeholders ("A {columns}x{rows} grid contact sheet of {count} film stills…").
  const columns = Number(extra.columns ?? d.columns ?? 0);
  const rows = Number(extra.rows ?? d.rows ?? 0);
  for (const key of Object.keys(b)) {
    const def = d[key];
    if (typeof def !== "string" || !def.includes("{") || values[key] !== undefined || extra[key] !== undefined) continue;
    values[key] = def.replaceAll("{columns}", String(columns)).replaceAll("{rows}", String(rows)).replaceAll("{count}", String(columns * rows)).replaceAll("{language}", languageName(input.targetLanguage));
  }

  // Remove object: the words name what SAM 3.1 follows (maskPrompt: the objects alone, comma-separated, each its own
  // SAM 3 prompt, so "Remove the red car from the shot" run straight from a Canvas works too) and the gap is filled
  // with the scene without it (params.extra.prompt, else a neutral default). No graph takes clicked points.
  // The painted eraser's last tracked mask (role "mask") is saved only for a window another one waits on.
  const handOff = ctx.op === "remove-object" && extra[HAND_OFF] === true;
  delete extra[HAND_OFF];
  if (ctx.op === "remove-object") {
    const words = input.prompt?.trim();
    if (b.maskPrompt) {
      if (!words && typeof extra.maskPrompt !== "string") throw new ProviderError(input.points?.length ? CLICK_OPEN_PROBLEM : "Say what to remove, e.g. “the coffee cup in her hand”");
      if (words) values.maskPrompt = targetPhrase(words);
    }
    if (b.prompt) values.prompt = REMOVE_SCENE;
  }
  // Genjutsu's Openjutsu modes (src/lib/openjutsu-graphs.ts): the settings travel as params.extra.openjutsu and are written
  // into the graph by node title after the media are bound; the pictures a request leaves out go with their branches.
  const openjutsu = OPENJUTSU_IDS.has(manifest.id) ? ((extra.openjutsu && typeof extra.openjutsu === "object" ? extra.openjutsu : {}) as OpenjutsuSettings) : null;
  delete extra.openjutsu;
  // Genjutsu's Character swap (MiniMax H3 on the h3_character_swap / H3 Relay packs): the part, the quality as the
  // unpatched pack's string, who to swap (SAM words, largest / leftmost / rightmost / index, or clicks moved into H3's
  // canvas), the swap LoRA's release, the window plan; the anchor first frame is images[1] (absent: its nodes go).
  const characterSwap = manifest.capability === "video-character-swap";
  let dropAnchor = false;
  let dropSwapLora = false;
  if (characterSwap) {
    values.quality = packResolution(input.resolution);
    // The pack's planning.validate_settings: windows 17n + 5, history 0, 1 or 17n + 1 and shorter than the window.
    if (extra.windowFrames !== undefined || extra.historyFrames !== undefined) {
      const plan = windowPlan(Number(extra.windowFrames ?? d.windowFrames ?? CHARACTER_SWAP.window), Number(extra.historyFrames ?? d.historyFrames ?? CHARACTER_SWAP.history));
      extra.windowFrames = String(plan.window);
      extra.historyFrames = String(plan.history);
    }
    const lora = typeof extra.lora === "string" ? extra.lora : undefined;
    delete extra.lora;
    if (lora === "none") dropSwapLora = true;
    else if (lora === "v1" || lora === "v1.5") values.lora = SWAP_LORAS[lora].file;
    if (input.points?.length) {
      if (!clip?.width || !clip.height) throw new ProviderError("Couldn't read the clip's size to place your clicks — pick who to swap instead");
      const [pos, neg] = samCoords(input.points, { width: clip.width, height: clip.height }, input.resolution);
      values.positiveCoords = pos;
      values.negativeCoords = neg;
      // SAM3_Detect puts the clicked mask first and the "person" detections after it: SelectSubject takes that first one
      // ("largest" would take whoever is biggest).
      extra.selection = "index";
      extra.subjectIndex = 0;
    }
    if (b.image2 && !values.image2) dropAnchor = true;
    // No words: Openjutsu's instruction, with the anchor sentence only when the anchor goes in (the graph's own text names it).
    if (!(typeof values.prompt === "string" && values.prompt.trim())) values.prompt = swapPrompt({ engine: "open", anchor: !!b.image2 && !dropAnchor });
  }
  // Character Swap Studio's segment (one H3 Relay pass): the previous take's master as history, the approved mask in
  // place of SAM's, the anchor after the boundary, masked generation off. Branches it doesn't use go after binding.
  // Media inputs a studio job leaves out on purpose (their branches go after binding).
  const studioLeft: string[] = [];
  // AuK's text to speech (speech-tts-auk, nm10-speech-edit): its instruction and length, written here since AuK's Prompt
  // Enhancer is off. Without a voice sample the loader goes (a voice from its description).
  let aukTts: { seconds: number; hasVoice: boolean } | null = null;
  if (manifest.id === "speech-tts-auk") {
    const hasVoice = !!values.audio;
    if (!hasVoice) studioLeft.push("audio");
    const sample = hasVoice ? (ctx.media?.(String(values.audio))?.duration ?? 0) : 0;
    try {
      aukTts = { seconds: ttsLength(String(input.prompt ?? ""), sample), hasVoice };
    } catch (e) {
      throw new ProviderError((e as Error).message, 400);
    }
    values.prompt = ttsInstruction(String(input.prompt ?? ""), { hasVoice, voiceDescription: input.voiceDescription });
  }
  let studioSegment: Omit<SegmentGraphOptions, "outputs"> | null = null;
  if (manifest.id === STUDIO_WORKFLOWS.segment) {
    const history = typeof extra.historyVideo === "string" && !!extra.historyVideo;
    if (!history) {
      studioLeft.push("historyVideo");
      for (const k of ["historyVideo", "historyStart", "historyLength"]) delete extra[k];
    } else {
      const start = Number(extra.historyStart);
      const length = Number(extra.historyLength);
      if (!Number.isInteger(start) || start < 0 || !Number.isInteger(length) || length < 1) throw new ProviderError("The continuation history needs the previous take's frame count");
    }
    const maskFile = typeof extra.maskVideo === "string" && extra.maskVideo ? extra.maskVideo : null;
    const span = input.endTime !== undefined ? Math.max(0, input.endTime - start) : Number(values.duration ?? 0);
    // The master keeps the segment's last frames (the next segment's history), not the whole 16-bit segment.
    const frames = Math.round(Number(extra.segmentFrames ?? 0));
    const keep = Math.round(Number(extra.masterKeep ?? frames));
    studioSegment = {
      anchor: !dropAnchor,
      history,
      anchorAfterHistory: extra.anchorAfterHistory === true,
      mask: maskFile ? { file: maskFile, start: Math.max(0, Number(extra.maskStart ?? 0)), duration: span } : null,
      useMask: extra.useMask !== false,
      masterTail: frames > 0 && keep > 0 && keep < frames ? { from: frames - keep, frames: keep } : null,
    };
    for (const k of ["maskVideo", "maskStart", "anchorAfterHistory", "useMask", "masterKeep", "segmentFrames"]) delete extra[k];
  }
  // Character Swap Studio's mask: who to swap on one frame of a shot (words, a selection or clicks moved into H3's
  // canvas), followed for spanFrames, spliced into the version it corrects (prevMask).
  let studioMask: Omit<MaskGraphOptions, "outputs"> | null = null;
  if (manifest.id === STUDIO_WORKFLOWS.mask) {
    values.quality = packResolution(input.resolution);
    const words = (typeof extra.maskPrompt === "string" && extra.maskPrompt.trim()) || input.prompt?.trim() || "person";
    values.maskPrompt = words.slice(0, 120);
    delete extra.maskPrompt;
    if (input.points?.length) {
      if (!clip?.width || !clip.height) throw new ProviderError("Couldn't read the clip's size to place your clicks — pick who to swap instead");
      const [pos, neg] = samCoords(input.points, { width: clip.width, height: clip.height }, input.resolution);
      values.positiveCoords = pos;
      values.negativeCoords = neg;
      extra.selection = "index";
      extra.subjectIndex = 0;
    }
    const keyFrame = Math.max(0, Math.round(Number(extra.keyFrame ?? 0)));
    const shotFrames = Math.round(Number(extra.shotFrames ?? 0));
    const spanFrames = Math.max(1, Math.round(Number(extra.spanFrames ?? shotFrames - keyFrame)));
    if (!(shotFrames > 0) || keyFrame + spanFrames > shotFrames) throw new ProviderError("The mask's frames don't fit in the shot — reload and try again");
    const prev = typeof extra.prevMask === "string" && !!extra.prevMask;
    if (!prev) {
      studioLeft.push("prevMask");
      delete extra.prevMask;
    }
    Object.assign(extra, { keyFrame, spanFrames, tailStart: keyFrame + spanFrames, tailFrames: Math.max(1, shotFrames - keyFrame - spanFrames) });
    delete extra.shotFrames;
    studioMask = { head: keyFrame, tail: shotFrames - keyFrame - spanFrames, prev };
    // The graph holds the whole shot as float frames: refuse what the server can't hold (before it runs out of memory).
    const tooBig = maskMemoryProblem({ width: clip?.width, height: clip?.height, quality: input.resolution, shotFrames, correcting: prev }, await ctx.serverRam?.());
    if (tooBig) throw new ProviderError(tooBig);
  }
  // Restore & colourise (video-restore-ltx25-tiled): the window, canvas, LoRA and tiles of this pass; the prefix (the window
  // before's restored frames, videos[0]), the reference picture (images[0]) and deinterlacing are branches it may leave out.
  let restore: RestoreJob | null = null;
  if (manifest.capability === "restore-video") {
    const prefixVideo = typeof clips[0] === "string" && clips[0] && clips[0] !== values.video ? clips[0] : undefined;
    try {
      restore = restoreJob({ extra, clip: clip ? clipFacts(clip) : undefined, fps: input.fps, prefixVideo, reference: images[0] });
    } catch (e) {
      throw new ProviderError((e as Error).message);
    }
    for (const k of RESTORE_EXTRA_KEYS) delete extra[k];
    Object.assign(values, restore.values, { video2: restore.prefix ? prefixVideo : undefined, image: restore.reference ? images[0] : undefined });
    if (!restore.prefix) studioLeft.push("video2");
    if (!restore.reference) studioLeft.push("image");
  }
  // Tap to Recolor: the taps (params.points, in the pixels of the picture they were placed on, params.extra.frameWidth /
  // frameHeight) and the piece they are on (params.extra.recolorItem) become the mask node's touches in the photo's own
  // pixels: SAM 3.1 takes the thing of that name under each tap. Only the taps say what changes.
  if (manifest.capability === "recolor") {
    const photo = ctx.media?.(String(values.image ?? ""));
    const touches = recolorTouches(input.points, recolorItem(extra), photo?.width && photo.height ? { width: photo.width, height: photo.height } : undefined, tapFrame(extra));
    if (!touches) throw new ProviderError(RECOLOR_TAP_FIRST);
    values.touches = touches;
    for (const k of ["frameWidth", "frameHeight", "recolorItem", "touches"]) delete extra[k];
  }
  // Genjutsu's Object swap: SAM 3.1 follows what goes (params.extra.maskPrompt, or the "replace … with" part of the prompt,
  // as Genjutsu sends it), the reference comes in, the prompt describes the result. Insert: the painted spot and the
  // reference, the prompt says what appears there. Neither graph takes clicked points.
  if ((ctx.op === "video-swap" || ctx.op === "video-insert") && !characterSwap) {
    if (input.points?.length && !input.mask && typeof extra.maskPrompt !== "string") throw new ProviderError(OPEN_TARGET_PROBLEM[ctx.op === "video-insert" ? "insert" : "swap"]!);
    const words = input.prompt?.trim() ?? "";
    const vace = getMaker(ctx.op === "video-swap" ? ORIGINALS.swap : "oss-vace-insert", "open")!;
    if (ctx.op === "video-swap" && b.maskPrompt) {
      const named = typeof extra.maskPrompt === "string" ? extra.maskPrompt.trim() : "";
      if (!named && !words) throw new ProviderError("Say what to swap, e.g. “the red car”");
      // Named apart: the prompt is the result's own words. Only a sentence: it says both what goes and what comes in.
      values.maskPrompt = swapTarget(named || words);
      delete extra.maskPrompt;
      if (!named) values.prompt = makerPrompt({ mode: "swap", maker: vace, subject: words, refs: 1 });
    }
    if (!words && b.prompt) values.prompt = makerPrompt({ mode: ctx.op === "video-swap" ? "swap" : "insert", maker: vace, subject: String(values.maskPrompt ?? ""), refs: 1 });
  }
  // A graph's own prompt text is its template's sample (Wan Animate 2's "Cartoon character lost" in an empty white room),
  // so it never stays in a run: motion transfer always describes the character from the photo with the user's words,
  // other graphs that run without words take Fuobe's neutral line, and one that can't do without words refuses.
  if (b.prompt) {
    const asked = typeof values.prompt === "string" && values.prompt.trim() ? values.prompt : undefined;
    if (MOTION_GRAPHS.has(manifest.id)) values.prompt = motionTransferPrompt(manifest.id, asked);
    else if (!asked && WORDS_NEEDED[manifest.id]) throw new ProviderError(WORDS_NEEDED[manifest.id], 400);
    else if (!asked) values.prompt = neutralPrompt(manifest.id) ?? values.prompt;
  }
  // Depth maps: Video Depth Anything draws gray or inferno (the other graphs grayscale only), and can put the
  // original clip next to the map.
  if (ctx.op === "depth-video" && input.colormap) {
    const want = input.colormap.toLowerCase() === "grayscale" ? "gray" : input.colormap.toLowerCase();
    if (b.colormap && (want === "gray" || want === "inferno")) values.colormap = want;
    else if (want !== "gray") throw new ProviderError(b.colormap ? "The open engine's depth maps come in grayscale or inferno — turbo, magma and viridis are on the cloud" : "This depth model makes grayscale maps only — pick Video Depth Anything for inferno");
  }
  if (b.sideBySide && input.sideBySide !== undefined) values.sideBySide = input.sideBySide;
  // A wrapper graph that loads its LoRA itself (kijai's InfiniteTalk: WanVideoLoraSelect, no core model loader to attach
  // one after) takes the run's LoRA there on a route made for it: Fuobe Speak's FusioniX in place of the graph's lightx2v,
  // with the steps and guidance it needs. One at most. Other routes on the graph (InfiniteTalk Long, tuned for lightx2v)
  // refuse a LoRA below.
  let loras = input.loras ?? [];
  if (loras.length && b.lora && ctx.loraSlot && !canTakeLoras(workflow)) {
    if (loras.length > 1) throw new ProviderError(`${manifest.title} takes one LoRA (it loads it itself): ${loras.map((l) => l.file).join(", ")}`);
    values.lora = loras[0].file;
    values.loraStrength = loras[0].strength ?? 1;
    loras = [];
  }
  // Matte graphs save a cut-out and a black-and-white matte: params.matteOutput keeps one.
  // The green-screen key's clean foreground leaves through the cut-out's encoder (below), so the cut-out's node is kept.
  const keyForeground = ctx.op === "bg-remove-video" && input.matteOutput === "foreground";
  const keepRole: string | undefined = ctx.op === "bg-remove-video" ? (keyForeground ? "cutout" : input.matteOutput) : undefined;
  // The green-screen key (video-key-corridorkey) writes its cut-out as a transparent WebM, ProRes 4444 with alpha, or EXR
  // frames beside the WebM (params.format; src/lib/av/keying.ts).
  const keyExr = ctx.op === "bg-remove-video" && !!b.format && input.format === "exr";
  if (ctx.op === "bg-remove-video" && b.format) {
    try {
      Object.assign(values, keyFormatValues(input.format, input.matteOutput));
    } catch (e) {
      throw new ProviderError((e as Error).message, 400);
    }
  }

  if (b.filenamePrefix) values.filenamePrefix = `fuobe/${ctx.generationId}`;
  // Keyframe animation: every gap's timing and words (src/lib/inbetween.ts); the graph is rewritten for the keyframes below.
  let inbetween: InbetweenPass[] | null = null;
  if (manifest.expand === "keyframes") {
    let timing: InbetweenTiming;
    try {
      timing = requestTiming(extra, images.length, input.keyframeTimes, "open");
    } catch (e) {
      throw new ProviderError((e as Error).message);
    }
    const stillMouth = extra.stillMouth === true;
    const seed = Number(values.seed);
    inbetween = timing.gaps.map((g, i) => ({ frames: g.frames, speed: g.speed, prompt: gapPrompt(input.prompt, g, stillMouth), seed: seed + i }));
    Object.assign(values, { fps: timing.fps, frames: timing.gaps[0].frames, prompt: inbetween[0].prompt, image: images[0], endImage: images[1] });
    delete extra.inbetween;
    delete extra.stillMouth;
  }
  // World mode (world-hy-nomas-turn): the script and the turn asked for; the graph is rebuilt for them below. The script's
  // own seed always: the turns before this one must match the ones ComfyUI already made.
  let world: { script: WorldScript; turn: number } | null = null;
  if (manifest.expand === "world") {
    const script = readWorld(extra.world);
    const turn = Math.round(Number(extra.turn ?? 0));
    const problem = script ? worldProblem(script, turn) : "Describe the world first: the opening is where it starts";
    if (problem || !script) throw new ProviderError(problem ?? "Describe the world first", 400);
    world = { script, turn };
    if (b.prompt) values.prompt = script.opening.words;
    if (b.seed) values.seed = script.seed;
  }
  delete extra.world;
  delete extra.turn;
  const cues = manifest.expand === "captions" ? captionCues(input, extra) : [];
  delete extra.cues;
  delete extra.wordsPerCaption;
  const timeline = manifest.expand === "timeline" ? readTimeline(extra.timeline) : null;
  if (manifest.expand === "timeline" && !timeline) throw new ProviderError("The voice track needs the lines' start times (params.extra.timeline)");
  delete extra.timeline;
  // A Video concatenator clip muted in the canvas (video-fit-clip): its sound becomes silence below.
  const muted = manifest.id === "video-fit-clip" && extra.mute === true;
  delete extra.mute;
  // DBS (separate-soundtrack-dbs, and the dub's dub-prepare-dbs-transcribe): the model asked for, else the host's pick
  // (DBS-TIGER on a CUDA GPU, DBS-BSRNN on a CPU, the other one when the pick isn't on disk; a model that isn't there is
  // refused in words); "each channel" for stereo stems. A source with more than 2 channels (the header's count, else the
  // browser's) is split in mono with a mono Music & effects (dbsSurroundBed below): ComfyUI can't save more than 2
  // channels. The dub's graph always splits in mono (no channels binding), so only its bed changes.
  if (b.separationModel) {
    const [device, installed] = await Promise.all([extra.separationModel ? undefined : ctx.device?.().catch(() => undefined), ctx.dbsModels?.().catch(() => undefined)]);
    try {
      values.separationModel = dbsModelFor(extra.separationModel, device, installed);
    } catch (e) {
      throw new ProviderError((e as Error).message, 400);
    }
  }
  // RE-USE (voice-clean-reuse, voice-clean-bed-reuse): the file for voice / laughter (refused in words when the host's
  // list doesn't have it, or has no ComfyUI-RE-USE at all), the rate (Auto: the source's on a CUDA GPU, capped on a CPU),
  // Strength as room tone, and the level in the node's words.
  if (b.reuseModel) {
    const installed = await ctx.reuseModels?.().catch(() => undefined);
    if (installed === null) throw new ProviderError(NO_REUSE_PACK, 400);
    try {
      values.reuseModel = reuseFileFor(extra.reuseModel, installed);
    } catch (e) {
      throw new ProviderError((e as Error).message, 400);
    }
    if (b.rate) {
      const auto = extra.rate === undefined || extra.rate === "auto";
      const device = auto ? await ctx.device?.().catch(() => undefined) : undefined;
      values.rate = rateFor(extra.rate ?? "auto", device, input.sourceDuration ?? ctx.media?.(String(values.audio ?? ""))?.duration);
    }
    const strength = extra.strength as keyof typeof STRENGTH_DB | undefined;
    if (b.roomToneDb && extra.roomToneDb === undefined && strength && strength in STRENGTH_DB) values.roomToneDb = STRENGTH_DB[strength];
    if (b.level && (extra.level === "match" || extra.level === "voice")) values.level = extra.level === "voice" ? "-16 LUFS" : "match input";
    for (const k of ["reuseModel", "rate", "strength", "background", ...(values.level !== undefined ? ["level"] : [])]) delete extra[k];
  }
  delete extra.background;
  const sourceChannels = b.channels || b.separationModel ? (ctx.media?.(String(values.audio ?? ""))?.channels ?? (Number(extra.sourceChannels) || undefined)) : undefined;
  if (b.channels) values.channels = dbsChannelsFor(extra.channels, sourceChannels);
  for (const k of ["separationModel", "channels", "sourceChannels"]) delete extra[k];
  // Watermark Remover: the marks kept (checked and rebuilt again, clamped to this picture), how QWMDetect finds what to repair
  // and how far past each mark, and the size the repair works at (the picture's size and the GPU's memory). Never what the
  // request says for these, nor for the picture, the brush, the seeds or the file names already bound.
  if (manifest.capability === "watermark-remove") {
    const still = ctx.media?.(String(values.image ?? ""));
    if (still?.width && still.height && Math.max(still.width, still.height) > MAX_WATERMARK_SIDE) throw new ProviderError(WATERMARK_COPY.tooBig, 400);
    const brushed = !!b.mask;
    // A brush painted on another size of the picture can't line up with it (QWMDetect refuses it): said in words up front.
    const painted = brushed ? ctx.media?.(String(values.mask ?? "")) : undefined;
    if (painted?.width && painted.height && still?.width && still.height && (painted.width !== still.width || painted.height !== still.height)) {
      throw new ProviderError(WATERMARK_COPY.brushAgain, 400);
    }
    if (!brushed && extra.boxes !== undefined) {
      try {
        values.boxes = checkWatermarkBoxes(extra.boxes, { width: still?.width, height: still?.height }).json;
      } catch (e) {
        throw new ProviderError((e as Error).message, 400);
      }
      values.detectMode = "manual_boxes";
    } else if (b.detectMode) values.detectMode = brushed ? "manual_mask" : "auto_qwen";
    // The kept marks get a repair margin past the scan's box; marks the pack finds itself (an API caller's run) get the scan's.
    if (b.detectExpand) values.detectExpand = values.detectMode === "manual_boxes" ? WATERMARK_KEPT_EXPAND : WATERMARK_SCAN_EXPAND;
    if (b.maxSize) values.maxSize = maxSideFor(still?.width, still?.height, await ctx.vram?.().catch(() => undefined));
    for (const k of ["boxes", "detectMode", "detectExpand", "maxSize", "image", "mask", "seed", "filenamePrefix"]) delete extra[k];
  }
  if (manifest.capability === "watermark-scan") {
    const still = ctx.media?.(String(values.image ?? ""));
    if (still?.width && still.height && Math.max(still.width, still.height) > MAX_WATERMARK_SIDE) throw new ProviderError(WATERMARK_COPY.tooBig, 400);
    for (const k of ["image", "filenamePrefix"]) delete extra[k];
  }
  // Options → Prompt helper (FLUX 3 Image Klein) and a layout's draft (kept for Reuse): read here, never bound.
  const helper = extra[PROMPT_HELPER_PARAM];
  const laidOut = carriesBoxes(extra);
  delete extra[PROMPT_HELPER_PARAM];
  delete extra[LAYOUT_PARAM];
  // The Lightning tier's schedule shifted for this canvas (its card's dynamic shift): text to image's size, else image 1's.
  if (b.sigmas && LIGHTNING_GRAPHS.has(manifest.id) && extra.sigmas === undefined) {
    const canvas = lightningCanvas(manifest.capability, values, ctx.media?.(String(values.image ?? "")));
    if (canvas) values.sigmas = lightningSigmas(canvas.width, canvas.height);
  }
  // Hi3D's refine: the mesh to refine is needed, and the resolution is one the model takes (512, 1024, 1536). Other graphs
  // bind meshResolution to their own grid (Idol 3D quick mesh: SplatToMesh, 64-768).
  if (b.model3d && !values.model3d) throw new ProviderError("Add the 3D model to refine");
  if (b.model3d && b.meshResolution && extra[HI3D_PARAM] !== undefined) {
    const r = strictHi3dResolution(extra[HI3D_PARAM]);
    if (r === null) throw new ProviderError("Hi3D refines at 512, 1024 or 1536");
    extra[HI3D_PARAM] = r;
  }
  // SplatToMesh's grid (Idol 3D quick mesh) takes 64-768 in steps of 16: a value from Canvas or Assist is kept to that.
  if (!b.model3d && b.meshResolution && extra[HI3D_PARAM] !== undefined) {
    const n = Number(extra[HI3D_PARAM]);
    if (Number.isFinite(n)) extra[HI3D_PARAM] = Math.min(768, Math.max(64, Math.round(n / 16) * 16));
    else delete extra[HI3D_PARAM];
  }
  // H3 Person Removal's window review (H3 Relay's Review Windows): "Redo from here" sends the same graph again with
  // window controls that lock the windows before it to their checkpoints. The Relay keeps those only while the graph,
  // its input files and its save prefix are the same, so a reroll names the original run's inputs and prefix (set by
  // the server from that run, on the studio's own ComfyUI only: never an account's, a link's or a computer's).
  let reviewInputs: RemovalReview["reuse"] | undefined;
  if (manifest.id === H3_REMOVAL_WORKFLOW) {
    const reuse = reuseOf(extra[REVIEW_EXTRA.reuse]);
    delete extra[REVIEW_EXTRA.reuse];
    const controls = extra[REVIEW_EXTRA.controls];
    if (controls !== undefined && (typeof controls !== "string" || controls.length > 131_072)) delete extra[REVIEW_EXTRA.controls];
    const own = !ownGpu() && !computerScope() && !tenantAccount();
    if (reuse && own) Object.assign(values, { video: reuse.video, image: reuse.image, filenamePrefix: reuse.prefix });
    // Only the studio's own ComfyUI keeps a review (its previews are fetched from there; nothing else can be redone).
    if (own && typeof values.video === "string" && typeof values.image === "string" && typeof values.filenamePrefix === "string") {
      reviewInputs = { video: values.video, image: values.image, prefix: values.filenamePrefix };
    }
  }
  // Idol 3D: "It's a photo" is the clean graph's "real" crop (the core graph's photo switch), then the pack's pruning.
  if (manifest.id === IDOL_WORKFLOWS.core || manifest.id === IDOL_WORKFLOWS.clean || manifest.id === IDOL_VIEWS_WORKFLOW) {
    Object.assign(values, idolGraphValues(extra, (k) => !!b[k as BindingKey]));
    for (const k of ["cropMode", "photoCrop", "minOpacity", "maxScale"]) delete extra[k];
  }
  for (const [k, v] of Object.entries(extra)) values[k as BindingKey] = v;
  // SeedVR2's `scale` multiplies the picture before one diffusion pass over all of it, and its graph is made for up to
  // limits.maxWidth × maxHeight: the multiplier comes down to fit the picture (a 3000 × 2000 photo at the template's 4x
  // would ask for 12000 × 8000), to the resize node's 0.01 step.
  if (manifest.id === "upscale-image-seedvr2" && b.scale) {
    const src = ctx.media?.(String(values.image ?? ""));
    if (src?.width && src.height) {
      const [maxW, maxH] = [Number(manifest.limits?.maxWidth ?? Infinity), Number(manifest.limits?.maxHeight ?? Infinity)];
      const room = Math.min(maxW / src.width, maxH / src.height);
      const asked = Number(values.scale ?? d.scale ?? 1);
      if (room < 1) throw new ProviderError(`SeedVR2 makes pictures up to ${maxW} × ${maxH} px on your GPU, and this one is already ${src.width} × ${src.height}: pick 4x ESRGAN for it`, 400);
      if (asked > room) values.scale = Math.floor(room * 100) / 100;
    }
  }
  // A canvas the request names (a layout's, Soul's exact sizes) stays on the graph's grid and inside its limits, as the
  // cloud fits the same canvas (FieldMap.size): both engines render one size, the size a layout is compiled at.
  if (b.width && b.height && (extra.width !== undefined || extra.height !== undefined)) {
    const [w, h] = [Number(values.width), Number(values.height)];
    if (w > 0 && h > 0 && Number.isFinite(w * h)) Object.assign(values, fitCanvas(w, h, manifest.limits));
  }
  if (audio2 && ctx.op !== "dialogue" && ctx.op !== "voice-change") values.audio2 = audio2;
  // Soundtrack mix: a silent bed as long as the video, so neither track cuts the other short.
  if (ctx.op === "mux" && b.duration) {
    const tracks = [values.audio, values.audio2].map((n) => ctx.media?.(String(n ?? ""))?.duration ?? 0);
    values.duration = Math.round((clipLength ?? (Math.max(...tracks) || 600)) * 100) / 100 + 0.5; // the mux trims it to the picture
  }

  // Reference images the user left out: dropped from a FLUX.2 reference chain or from an encoder that takes them as
  // optional inputs, else the previous image again where that's harmless (style boards, multi-reference edits), else a
  // clear "add …" message.
  let graph = workflow;
  const left: string[] = [...studioLeft, ...(openjutsu ? openjutsuLeftOut(manifest.id, openjutsu) : [])];
  // A side nobody photographed is left out (its cut-out and crop with it); the front is needed.
  if (rules.views) {
    for (const k of IMAGE_SLOTS.slice(1)) {
      if (values[k] !== undefined || b[k]?.length !== 1) continue;
      const dropped = dropBranch(graph, b[k]![0].node, rules.views.into, manifest.outputs.map((o) => o.node));
      if (dropped) {
        graph = dropped;
        left.push(k);
      }
    }
  }
  // MiniMax H3 with references (Pika H3 Flex Ref2VA): Pika's limits, checked on the uploads' headers before the run; the
  // graph's Image 1 loader is taken out by expandH3References when there is no image.
  // A talking clip from a voice (Lipsync & avatars, Fuobe Speak) is one image and the voice as its audio reference.
  const refAudios = ctx.op === "avatar" ? [input.audio].filter((a): a is string => !!a) : audios;
  if (manifest.expand === "references") {
    const length = (n: string) => {
      const m = ctx.media?.(n);
      return m?.videoDuration ?? m?.duration;
    };
    const problem = h3ReferenceProblem({ images: images.length, videos: clips.map(length), audios: refAudios.map(length) });
    if (problem) throw new ProviderError(problem);
    if (!images.length) left.push("image");
  }
  // The Character swap without an anchor frame: its loader and fit are taken out after binding.
  if (dropAnchor) left.push("image2");
  for (const [k, prev] of REFERENCE_SLOTS.slice(1).map((slot, i) => [slot, REFERENCE_SLOTS[i]] as const)) {
    if (rules.views || !b[k] || values[k] !== undefined || rules.required?.includes(k) || left.includes(k)) continue;
    if (values[prev] === undefined && !left.includes(prev)) continue;
    const loader = b[k]!.length === 1 ? b[k]![0].node : undefined;
    const bypassed = loader ? (bypassReference(graph, loader) ?? dropBranch(graph, loader, OPTIONAL_REFERENCE_INPUTS, manifest.outputs.map((o) => o.node))) : null;
    if (bypassed) {
      graph = bypassed;
      left.push(k);
    } else if ((rules.reuse || manifest.capability === "style-reference") && values[prev] !== undefined) values[k] = values[prev];
  }
  for (const k of mediaKeys(manifest, workflow)) {
    if (left.includes(k)) continue;
    if (values[k] === undefined || values[k] === "") throw new ProviderError(rules.hints?.[k] ?? MEDIA_HINT[k] ?? `Add the ${k} input`);
  }

  // Whisper captions hold the whole clip in RAM (decoded + subtitled copy): refuse what the server can't hold.
  if (manifest.capability === "captions" && !manifest.expand && clip?.width && clip.height && clipLength) {
    const need = clip.width * clip.height * 12 * (clip.frames ?? clipLength * (clip.fps ?? 30)) * 2.5;
    const budget = ((await ctx.serverRam?.()) ?? 16 * GB) / 2;
    if (need > budget) {
      throw new ProviderError(
        `Whisper captions hold the whole clip in memory: this one needs about ${Math.ceil(need / GB)} GB of RAM and this ComfyUI can spare ${Math.floor(budget / GB)} GB. ` +
          "Use Qwen3-ASR + Caption burn-in for long clips, or trim it first",
      );
    }
  }

  // Graphs that hold the whole clip in memory (FPS Boost, HDR, EXR): refuse what the server can't hold.
  if (finish.wholeClip) {
    const problem = wholeClipProblem(finish.wholeClip, clipFacts(clip), await ctx.serverRam?.());
    if (problem) throw new ProviderError(problem);
  }

  const bound = applyBindings(graph, b, Object.fromEntries(Object.entries(values).filter(([k]) => !left.includes(k))));
  // maxDimension targets for removed reference branches are expected: their scale nodes go with the loader.
  const realMissing = bound.missing.filter((m) => !/^maxDimension\b/.test(m));
  if (realMissing.length) throw new ProviderError(`Workflow ${manifest.id} bindings point at missing nodes: ${realMissing.join(", ")}`);
  // A saved 3D view read without the browser (Any Angle): Load3D's picture entries point at the run's photo.
  let wf = withLoad3dImages(bound.workflow, typeof values.image === "string" ? values.image : undefined);
  // Qwen3-TTS's clone needs the sample's words unless it clones from the voice's timbre alone (x_vector_only):
  // a sample with no transcript clones that way instead of failing.
  for (const t of b.voiceTranscript ?? []) {
    const inputs = wf[t.node]?.inputs;
    if (!inputs || !("x_vector_only" in inputs)) continue;
    const words = inputs[t.input];
    inputs.x_vector_only = !(typeof words === "string" && words.trim());
  }
  const outputIds = manifest.outputs.map((o) => o.node);
  // The prompt helper (FLUX 3 Image Klein's upsampler) off, or a layout with boxes it would rewrite: the words as typed.
  // Kandinsky 6.0's helper runs only when asked (PROMPT_HELPER_OPT_IN).
  const helperOff = helper === "off" || (helper !== "on" && PROMPT_HELPER_OPT_IN.has(manifest.id));
  if (PROMPT_HELPER_GRAPHS.has(manifest.id) && (helperOff || laidOut)) wf = skipPromptHelper(wf, outputIds);
  if (dropAnchor) wf = withoutAnchor(wf, b.image2![0].node);
  if (openjutsu) {
    try {
      const seed = typeof openjutsu.seed === "number" ? openjutsu.seed : typeof values.seed === "number" ? values.seed : randomSeed();
      wf = openjutsuGraph(manifest.id, wf, { ...openjutsu, seed }, { generationId: ctx.generationId, clip: clip ? { width: clip.width, height: clip.height } : undefined });
    } catch (e) {
      throw new ProviderError((e as Error).message, 400);
    }
  }
  // LoRA "none": the swap LoRA's loader is linked out (H3 runs with the Turbo LoRA alone).
  if (dropSwapLora && b.lora?.length === 1) wf = bypassNode(wf, b.lora[0].node, "model", outputIds);
  if (studioSegment) wf = segmentGraph(wf, { ...studioSegment, outputs: outputIds });
  if (studioMask) wf = maskGraph(wf, { ...studioMask, outputs: outputIds });
  if (restore) wf = restoreGraph(wf, restore, outputIds);
  // FPS Boost to a lower rate, or one the clip divides into: no interpolation, only every n-th frame.
  if (finish.bypassInterpolation) {
    const id = Object.keys(wf).find((k) => wf[k].class_type === "FrameInterpolate" || wf[k].class_type === "RTXVideoFrameGeneration");
    if (id) wf = bypassNode(wf, id, "images", outputIds);
  }
  if (surroundSource(sourceChannels)) wf = dbsSurroundBed(wf);
  // Zen Image Edit's loader (Qwen-Image 2.1 on a small GPU) reads paths, not names: the adapter where the server keeps it
  // in models/text_encoders, and Qwen3.5-0.8B's pinned folder there when it has one (else the loader fetches it by id).
  for (const n of Object.values(wf)) {
    if (n.class_type !== "ZenImage21AdapterLoader") continue;
    const adapter = await ctx.modelPath?.(ZEN_ADAPTER.folder, ZEN_ADAPTER.file).catch(() => undefined);
    n.inputs.adapter_file = adapter ?? `models/${ZEN_ADAPTER.folder}/${ZEN_ADAPTER.file}`;
    const weights = await ctx.modelPath?.(ZEN_ADAPTER.folder, `${ZEN_ENCODER.dir}/${ZEN_ENCODER.weights}`).catch(() => undefined);
    n.inputs.text_encoder = weights ? weights.replace(/[\\/][^\\/]+$/, "") : ZEN_ENCODER.id;
  }
  // Slow motion: the sound would no longer match the picture.
  if (finish.dropSound) for (const n of Object.values(wf)) if (n.class_type === "CreateVideo") delete n.inputs.audio;
  // VHS meta-batch: a manager of its own per job (a stale one loses frames), and no sound link for a silent clip.
  wf = tagMetaBatch(wf, ctx.generationId);
  // A concatenator clip that is muted or has no sound: silence exactly as long as its kept frames, so every clip
  // of the film carries a track (a packet-copy join of clips with and without one would drift). Not knowing how
  // long the window is (no end, no header), it has no track instead.
  if (manifest.id === "video-fit-clip" && (muted || (clip && !clip.hasAudio && clip.hasVideo))) {
    const kept = Number(values.duration) > 0 ? Number(values.duration) : undefined;
    const rest = clipLength !== undefined ? Math.max(0, clipLength - start) : undefined;
    const seconds = kept !== undefined && rest !== undefined ? Math.min(kept, rest) : (kept ?? rest);
    wf = seconds ? silenceVhsAudio(wf, Math.max(1, Math.round(seconds * fps)) / fps) : dropVhsAudio(wf);
  }
  if (clip && !clip.hasAudio && clip.hasVideo) {
    wf = dropVhsAudio(wf);
    // Core LoadAudio reading the clip's own sound (the end card's ad): no sound, no sound track.
    wf = dropLoadedSound(wf, (b.video ?? []).filter((t) => t.input === "audio").map((t) => t.node), outputIds);
  }
  if (manifest.expand === "captions") {
    if (!cues.length) throw new ProviderError("No timed captions to burn in. Transcribe the clip first, or write lines like “0.00-2.40: Hello there”");
    try {
      wf = expandCaptionWorkflow(wf, cues, clip ? { duration: clipLength, fps: clip.fps, width: clip.width, height: clip.height, hasAudio: clip.hasAudio } : {});
    } catch (e) {
      throw new ProviderError((e as Error).message);
    }
  }
  if (timeline) {
    try {
      wf = expandTimelineWorkflow(wf, input.audios?.length ? input.audios : [String(values.audio)], timeline);
    } catch (e) {
      throw new ProviderError((e as Error).message);
    }
  }
  if (speechWindows) {
    const duration = ctx.media?.(String(values.audio ?? ""))?.duration ?? input.sourceDuration;
    if (!duration) throw new ProviderError("Couldn't read how long the recording runs: add it again as WAV, MP3, M4A or MP4", 400);
    try {
      wf = expandSpeechEditWorkflow(wf, speechWindows, { duration, quality: aukQuality, seed: Number(values.seed) || 0, crossfade: Math.max(0.02, Number(input.crossfade ?? d.crossfade ?? 0.12)) });
    } catch (e) {
      throw new ProviderError((e as Error).message, e instanceof SpeechEditError ? 400 : 500);
    }
  }
  if (aukTts) wf = aukTtsWorkflow(wf, aukTts);
  if (Object.values(wf).some((n) => n.class_type === "AuKModelLoader")) {
    try {
      wf = setAukDevice(wf, typeof values.device === "string" ? values.device : undefined);
    } catch (e) {
      throw new ProviderError((e as Error).message, 400);
    }
  }
  if (world) {
    try {
      wf = expandWorldWorkflow(wf, world.script, world.turn);
    } catch (e) {
      throw new ProviderError((e as Error).message, e instanceof WorldGraphError ? 400 : 500);
    }
  }
  // Keyframe animation: one pass per gap on the shared loaders, every keyframe loaded once.
  if (inbetween) {
    try {
      wf = expandInbetweenWorkflow(wf, images, inbetween);
    } catch (e) {
      throw new ProviderError((e as Error).message);
    }
  }
  // Joins of more clips than the template binds: one loader per clip, in one prompt.
  try {
    if (manifest.expand === "videos" && clips.length > 2) wf = expandVideoJoinWorkflow(wf, clips);
    if (manifest.expand === "audios" && audios.length > 2) wf = expandAudioJoinWorkflow(wf, audios);
    if (manifest.expand === "references") wf = expandH3References(wf, { images, videos: clips, audios: refAudios, videoSound: clips.map((n) => ctx.media?.(n)?.hasAudio) });
  } catch (e) {
    throw new ProviderError((e as Error).message);
  }
  if (loras.length) {
    // A LoRA a graph can't attach would be dropped without a word: say so instead.
    if (!canTakeLoras(wf)) throw new ProviderError(`${manifest.title} can't take LoRAs (it has no model loader to attach them to)`);
    wf = injectLoras(wf, loras);
  }
  // The output not asked for isn't saved (nor encoded: ComfyUI runs only what an output node needs).
  if (keepRole && manifest.outputs.some((o) => o.role === keepRole)) for (const o of manifest.outputs) if (o.role && o.role !== keepRole && !(keyExr && o.role === "frames")) delete wf[o.node];
  // The clean foreground (CorridorKey 2.0's despilled colours premultiplied over black, output 2): the cut-out's encoder takes
  // it as a plain H.264 with sound.
  if (keyForeground) {
    const keyer = Object.entries(wf).find(([, n]) => n.class_type === "CorridorKey2")?.[0];
    const cut = manifest.outputs.find((o) => o.role === "cutout")?.node;
    if (!keyer || !cut || !wf[cut]) throw new ProviderError(`${manifest.title} doesn't make a clean foreground — CorridorKey in Green screen does`, 400);
    wf[cut] = { ...wf[cut], inputs: { ...wf[cut].inputs, images: [keyer, 2], format: "video/h264-mp4", pix_fmt: "yuv420p", crf: 19 } };
  }
  // A key's EXR frames are written only when asked for (they ride on the cut-out, zipped).
  if (ctx.op === "bg-remove-video" && !keyExr) for (const o of manifest.outputs) if (o.role === "frames") delete wf[o.node];
  if (ctx.op === "remove-object" && !handOff) for (const o of manifest.outputs) if (o.role === "mask") delete wf[o.node];
  const metaBatch = Object.values(wf).some((n) => n.class_type === "VHS_BatchManager");
  return {
    manifest,
    workflow: wf,
    // The seed the graph drew with (one Fuobe picked when none was asked): its pictures keep it, so Edit layout redraws the same one.
    meta: {
      workflowId: manifest.id,
      nodeCount: Object.keys(wf).length,
      prefix: `fuobe/${ctx.generationId}`,
      ...(metaBatch ? { metaBatch: true } : {}),
      ...(b.seed && typeof values.seed === "number" ? { seed: values.seed } : {}),
      ...(reviewInputs ? { reviewInputs } : {}),
    },
  };
}

/**
 * The Character swap graph without its anchor frame (Openjutsu's swapWorkflow): the anchor's loader and every node that
 * reads only it go, the swap's input takes no anchor and its use_anchor switch is off.
 */
export function withoutAnchor(wf: ComfyWorkflow, loaderId: string): ComfyWorkflow {
  const out = JSON.parse(JSON.stringify(wf)) as ComfyWorkflow;
  const gone = new Set([loaderId]);
  // The loader's direct readers that exist only to fit it (anchor_fit): an image node fed by nothing else.
  for (const [id, n] of Object.entries(out)) {
    const links = Object.values(n.inputs).filter((v) => Array.isArray(v)) as [string, number][];
    if (links.some((v) => v[0] === loaderId) && n.class_type === "ImageScale") gone.add(id);
  }
  for (const id of gone) delete out[id];
  for (const n of Object.values(out)) {
    for (const [k, v] of Object.entries(n.inputs)) {
      if (Array.isArray(v) && gone.has(String(v[0]))) {
        delete n.inputs[k];
        if ("use_anchor" in n.inputs) n.inputs.use_anchor = false;
      }
    }
  }
  return out;
}

/** What ComfyUI's /prompt answers when it refuses a graph. */
export type PromptRefusalBody = { error?: { type?: string; message?: string; extra_info?: { class_type?: string } }; node_errors?: unknown };

/** A 2K finish refused because the latent file it loads isn't on that ComfyUI (Load Refined Latent's list of files). */
export function latentGone(body: PromptRefusalBody, manifest: Pick<ManifestWorkflow, "id">): boolean {
  if (manifest.id !== REGEN_LATENT_WORKFLOW || !body.node_errors || typeof body.node_errors !== "object") return false;
  return Object.values(body.node_errors as Record<string, { class_type?: unknown }>).some((n) => n?.class_type === "OpenH3LoadRefinedLatent");
}

/**
 * A /prompt refusal in words, with what was missing as a code its failed tile turns into "Fix it" (the GPU pre-flight's
 * guided fix). The same for the server's own ComfyUI, a link, and one on someone's computer (its tab reports the answer).
 */
export function promptRefusal(
  body: PromptRefusalBody,
  status: number,
  manifest: ManifestWorkflow,
  loras: { file: string; url?: string }[],
  worker: ComfyWorker = "main",
): { message?: string; fix?: ReturnType<typeof fixFromPromptError>; details?: string; plain?: true } {
  // The index names the pack a missing class comes from, so the message names that pack, not every pack the workflow uses.
  let packOf: (cls: string) => string | undefined = () => undefined;
  try {
    const idx = loadIndex();
    packOf = (cls) => Object.entries(idx.packs).find(([, p]) => p.classes.includes(cls))?.[0];
  } catch {}
  const fix = fixFromPromptError(body, manifest.id, manifest.models, packOf);
  const missingClass = fix?.code === "comfy_missing_node" ? fix.items[0] : undefined;
  // A node class the server doesn't have: name the pack to install (opt-in packs like ComfyUI-Whisper).
  const packs = missingClass?.pack ? [missingClass.pack] : manifest.customNodes.map((c) => c.name);
  const where = worker === "isolated" ? "the isolated ComfyUI worker" : "your ComfyUI";
  // An account's run (on its own GPU, or on this install's GPUs as a hosted run) gets the visitor's words, never the owner's.
  const visitorRun = !!ownGpu() || !!tenantAccount();
  const missingPack =
    body.error?.type === "missing_node_type" && [REGEN_WORKFLOW, REGEN_LATENT_WORKFLOW, H3_LATENT_DRAFT_WORKFLOW].includes(manifest.id) && worker === "main"
      ? visitorRun
        ? REGEN_COPY.missingVisitor
        : REGEN_COPY.missing
      : body.error?.type === "missing_node_type" && RTX_WORKFLOWS.has(manifest.id) && worker === "main"
        ? visitorRun
          ? RTX_MISSING.visitor
          : RTX_MISSING.owner
      : body.error?.type === "missing_node_type" && packs.length
        ? `This workflow needs the ${packs.join(" + ")} node pack${packs.length > 1 ? "s" : ""} on ${where} (see scripts/comfy/README.md)`
        : undefined;
  // A LoRA it lacks: point at its model card (a civitai download URL answers 401 without the key) and the LoRA folder setting.
  // A 2K finish whose draft's saved latent is gone (someone's computer: its tab reports the refusal): plain words, no file.
  if (latentGone(body, manifest)) return { message: REGEN_COPY.latentGone, plain: true };
  const loraModels = loras.map((l) => ({ file: l.file, folder: "loras", url: loraByFile(l.file)?.page ?? (l.url && !needsToken(l.url) ? l.url : undefined) }));
  let detail = body.node_errors && Object.keys(body.node_errors as object).length ? explainComfyError(body.node_errors, { ...manifest, models: [...manifest.models, ...loraModels] }) : (missingPack ?? (typeof body.error?.message === "string" ? body.error.message.slice(0, 1024) : undefined));
  // (Settings → LoRAs is the owner's page, for the server's own ComfyUI: an account's, or one on a computer, gets its LoRAs by hand.)
  if (detail && !ownGpu() && !computerScope() && loraModels.some((l) => detail!.includes(`"${l.file}"`))) detail = `${detail}\nSet the LoRA folder in Settings → LoRAs and Fuobe downloads LoRAs before a run`;
  void status;
  // An account's own GPU (a link or this computer): what is missing in plain words, with "Fix it"; ComfyUI's own words
  // (and the file's folder and download) go in the details line.
  if (ownGpu() && fix && (fix.code === "comfy_missing_node" || fix.code === "comfy_missing_model") && missingPack !== REGEN_COPY.missingVisitor && missingPack !== RTX_MISSING.visitor) {
    const first = fix.items[0];
    const name = fix.code === "comfy_missing_node" ? (first?.pack ?? first?.class) : first?.file;
    if (name) {
      const words =
        fix.code === "comfy_missing_node"
          ? `Your ComfyUI needs one add-on for this: ${name}. Press Fix it to add it.`
          : `Your ComfyUI needs one more file for this: ${name}. Press Fix it to see how to add it.`;
      return { message: words, fix, plain: true, ...(detail && detail !== words && { details: detail.replace(/\s*\(see scripts\/comfy\/README\.md\)/, "") }) };
    }
  }
  const plain = !!detail && (detail === REGEN_COPY.missingVisitor || detail === RTX_MISSING.visitor);
  return { message: detail, ...(fix && { fix }), ...(plain && { plain: true as const }) };
}

/** The NVIDIA RTX Video graphs (their pack is installed only on an NVIDIA RTX host). */
const RTX_WORKFLOWS: ReadonlySet<string> = new Set([RTX_UPSCALE_WORKFLOW, RTX_FRAMEGEN_WORKFLOW, RTX_HDR_WORKFLOW]);

/** Friendlier words for errors that a workflow's nodes report in their own terms. */
function explainExecutionError(err: { exception_message?: string; node_type?: string } | undefined, manifest?: ManifestWorkflow): string {
  if (!err) return "Execution error";
  const msg = (err.exception_message ?? "").trim();
  // On someone's own computer the words are theirs: their GPU ran out (the server's own runs keep ComfyUI's words).
  if (computerScope() && isOutOfMemory(msg)) return RELAY_WORDS.outOfMemory;
  const outOfClip = /division by zero|failed to slice video|failed to trim video|no frames exist/i.test(msg);
  if (manifest?.expand === "captions" && outOfClip) return "A caption starts after the end of the video — check the cue times";
  if (manifest?.capability === "trim" && outOfClip) return "The start time is past the end of the clip";
  if (/no audio stream/i.test(msg)) return "That file has no sound to work with";
  return `${err.node_type}: ${msg}`;
}

const executionError = (entry: HistoryEntry) => entry.status?.messages?.find(([t]) => t === "execution_error")?.[1] as { exception_message?: string; node_type?: string } | undefined;

const promptHasPrefix = (prompt: unknown, prefix: string) =>
  !!prompt && typeof prompt === "object" && Object.values(prompt as ComfyWorkflow).some((n) => n?.inputs?.filename_prefix === prefix);

/** An EXR export's per-frame files (bundleFrames zips them); everything else is a finished result. */
const isFrame = (o: ComfyOutput) => o.meta?.role === "frames";

/**
 * A meta-batch pass's place in its job. ComfyUI numbers the first pass as queued (0 or more); VHS re-queues each later
 * pass under the negated, growing server count (-k, -k-1, …), so a later pass has a more negative number.
 */
const passOrder = (e: { prompt?: unknown[] }) => {
  const n = Number(e.prompt?.[0] ?? 0);
  return n >= 0 ? 0 : -n;
};

/**
 * A meta-batch job's results from its passes (in any order): the clips the last pass saved (only the last pass saves
 * a video), then every pass's EXR frames in pass order (a frame saver writes in each pass). Empty while no pass saved a
 * finished result. `collect` reads one pass's files.
 */
export function metaBatchResults<E extends { prompt?: unknown[] }>(passes: E[], collect: (e: E) => ComfyOutput[]): ComfyOutput[] {
  const files = [...passes].sort((a, c) => passOrder(a) - passOrder(c)).map(collect);
  const last = files.findLastIndex((f) => f.some((o) => !isFrame(o)));
  if (last < 0) return [];
  return [...files[last].filter((o) => !isFrame(o)), ...files.flatMap((f) => f.filter(isFrame))];
}

/**
 * VHS meta-batching re-queues the prompt (new prompt ids) until every frame is done; only the last pass
 * saves the video. Follow the passes by their shared filename prefix.
 */
async function followMetaBatch(prefix: string, manifest: ManifestWorkflow | undefined, worker: ComfyWorker): Promise<ComfyOutput[] | "running" | { error: string } | null> {
  const queue = await comfyJson<{ queue_running?: unknown[][]; queue_pending?: unknown[][] }>("/queue", worker);
  if ([...(queue.queue_running ?? []), ...(queue.queue_pending ?? [])].some((q) => promptHasPrefix(q[2], prefix))) return "running";
  const read = async (n: number) => Object.values(await comfyJson<Record<string, HistoryEntry>>(`/history?max_items=${n}`, worker)).filter((e) => promptHasPrefix(e.prompt?.[2], prefix));
  const collect = (e: HistoryEntry) => collectOutputs(e, manifest, baseUrl(worker), authHeaders(worker));
  let passes = await read(64);
  // Frames in each pass: every pass is needed, so look further back.
  if (passes.some((e) => collect(e).some(isFrame))) passes = await read(META_BATCH_HISTORY);
  // A pass that failed (out of memory, a node exception) ends the job: say why instead of "no output".
  const failed = passes.find((e) => e.status?.status_str === "error");
  if (failed) return { error: explainExecutionError(executionError(failed), manifest) };
  const files = metaBatchResults(passes, collect);
  return files.length ? files : null;
}

/** A window preview H3 Relay writes (a 512 px clip or still): anything bigger isn't kept. */
const WINDOW_PREVIEW_MAX_BYTES = 64 * 2 ** 20;

/**
 * H3 Person Removal: H3 Relay's review of the run (each window's checkpoint, seed and preview) on the video it made, as
 * meta.review plus the previews as meta.artifacts. The previews are copied from ComfyUI here, with its token, into the
 * generation's files (a local or LAN ComfyUI isn't fetched by link later, and raw ComfyUI links never reach a page). A
 * preview that can't be copied is left out; the window can still be redone. Nothing when the Relay didn't report a run
 * (an older pack), the inputs can't be sent again, or the run wasn't on the studio's own ComfyUI.
 */
export async function withRemovalReview(entry: HistoryEntry, outputs: ComfyOutput[], reuseMeta: unknown, worker: ComfyWorker, generationId: string): Promise<ComfyOutput[]> {
  if (ownGpu() || computerScope() || tenantAccount()) return outputs;
  const reuse = reuseOf(reuseMeta);
  const runs = Object.values(entry.outputs ?? {}).flatMap((ui) => (Array.isArray(ui?.h3_removal_run) ? ui.h3_removal_run : []));
  const runId = runs.find((r): r is string => typeof r === "string" && /^[0-9a-f]{32}$/.test(r));
  const at = outputs.findIndex((o) => o.kind === "video");
  if (!reuse || !runId || at < 0) return outputs;
  try {
    const run = await comfyJson<unknown>(`/h3_relay/removal/previews?${new URLSearchParams({ workflow_id: "", node_id: "review", run_id: runId })}`, worker);
    const read = reviewOfRun(run, reuse, (f) => `/view?${new URLSearchParams(f)}`);
    if (!read) return outputs;
    const kept: Record<string, string> = {};
    for (const [key, view] of Object.entries(read.artifacts)) {
      try {
        const res = await comfyFetch(view, {}, worker);
        const size = Number(res.headers.get("content-length") ?? 0);
        if (!res.ok || size > WINDOW_PREVIEW_MAX_BYTES) {
          discardBody(res);
          continue;
        }
        const data = Buffer.from(await res.arrayBuffer());
        if (!data.length || data.length > WINDOW_PREVIEW_MAX_BYTES) continue;
        const name = new URLSearchParams(view.split("?")[1]).get("filename") ?? undefined;
        const type = res.headers.get("content-type");
        const contentType = type && type !== "application/octet-stream" ? type.split(";")[0] : contentTypeFor(name ?? "", "application/octet-stream");
        kept[key] = saveFile({ data, contentType, name, source: "generation", generationId: generationId || undefined }).url;
      } catch {
        // this window shows no preview
      }
    }
    const review = { ...read.review, windows: read.review.windows.map((w) => ({ ...w, video: w.video && kept[w.video] ? w.video : undefined, poster: w.poster && kept[w.poster] ? w.poster : undefined })) };
    const o = outputs[at];
    const artifacts = { ...((o.meta?.artifacts as Record<string, string> | undefined) ?? {}), ...kept };
    return outputs.map((x, i) => (i === at ? { ...x, meta: { ...x.meta, review, artifacts } } : x));
  } catch {
    return outputs;
  }
}

/** Upload a file to a worker's input folder; returns the name LoadImage / LoadAudio / LoadVideo take there. */
async function uploadTo(worker: ComfyWorker, data: Buffer, contentType: string, name: string): Promise<string> {
  // On someone's computer: kept here for the run's task, under the name ComfyUI will get from their tab.
  const computer = computerScope();
  if (computer) {
    if (worker === "isolated") throw new ProviderError(ISOLATED_ON_COMPUTER);
    const sent = onWorkers(computer) ? await forWorkers(data, contentType, name) : { data, contentType, name };
    const staged = stageInput(computer, sent.data, sent.contentType, sent.name);
    rememberSent(staged, sent.data, sent.contentType, sent.name);
    return staged;
  }
  const form = new FormData();
  const ext = name.includes(".") ? name.split(".").pop() : contentType.split("/")[1];
  form.append("image", new Blob([new Uint8Array(data)], { type: contentType }), `fuobe_${nanoid(8)}.${ext}`);
  form.append("type", "input");
  form.append("overwrite", "true");
  const res = await comfyFetch("/upload/image", { method: "POST", body: form }, worker, { bytes: data.length });
  // An account's link: its answer read for the person (a stopped pod, the address's own size limit…).
  const link = ownLink();
  if (link && !res.ok) throw await linkAnswer(res, { stage: "upload", bytes: data.length }, link);
  if (res.status === 413) {
    discardBody(res);
    // ComfyUI's own limit (--max-upload-size, 100 MB unless it was started with more).
    const mb = Math.ceil(data.length / 2 ** 20);
    throw new ProviderError(`ComfyUI refused a ${mb} MB upload as too large (its --max-upload-size, 100 MB unless set) — start ComfyUI with a higher --max-upload-size, or send a smaller file`);
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 500);
    throw worker === "isolated" ? isolatedAnswer("an upload", res.status, reasonOf(text)) : new ProviderError(`ComfyUI upload failed: ${res.status} ${text}`);
  }
  let j: { name: string; subfolder?: string };
  if (link) {
    // A web page instead of ComfyUI's answer (a proxy's or a tunnel's page): said as such, never a parser's words.
    const text = await res.text().catch(() => "");
    try {
      j = JSON.parse(text);
    } catch {
      throw gpuTrouble({ stage: "upload", status: res.status, body: text.slice(0, 4096), contentType: res.headers.get("content-type") ?? undefined }, link);
    }
  } else j = (await res.json()) as { name: string; subfolder?: string };
  const uploaded = j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
  // Remember a clip's / track's header facts (length, size, fps, audio) for prepareWorkflow.
  rememberSent(uploaded, data, contentType, name);
  return uploaded;
}

/**
 * Deletes a finished Context Loop job's run folder (output/h3_chains/<run>) through the pack's own routes: a preview gives
 * the folder's snapshot, the delete names it and the run again. A failure is logged and the run goes on.
 */
export async function deleteRunFolder(run: string, worker: ComfyWorker = "main"): Promise<boolean> {
  try {
    const preview = await comfyFetch("/minimax_h3_context_loop/run-folder/delete-preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ run_name: run }) }, worker);
    const p = (await preview.json().catch(() => ({}))) as { snapshot?: string };
    if (!preview.ok || !p.snapshot) return false;
    const done = await comfyFetch(
      "/minimax_h3_context_loop/run-folder/delete",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ run_name: run, snapshot: p.snapshot, confirmation: run }) },
      worker,
    );
    discardBody(done);
    if (!done.ok) console.warn(`Couldn't delete the H3 run folder ${run} (HTTP ${done.status})`);
    return done.ok;
  } catch (e) {
    console.warn(`Couldn't delete the H3 run folder ${run}: ${(e as Error).message}`);
    return false;
  }
}

type QueueEntry = unknown[];
const postJson = (p: string, body: unknown, worker: ComfyWorker = "main") =>
  comfyFetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, worker).catch(() => undefined);

/**
 * Take a job off ComfyUI: delete its pending prompts and interrupt the one running. A meta-batch job is
 * every prompt carrying its filename prefix (VHS re-queues each pass under a new id with a negative queue
 * number, so the pending pass would run first). Returns whether any prompt of the job was still there.
 */
async function stopPrompts(externalId: string | undefined, prefix: string | undefined, worker: ComfyWorker = "main"): Promise<boolean> {
  const ours = (q: QueueEntry) => (!!externalId && q[1] === externalId) || (!!prefix && promptHasPrefix(q[2], prefix));
  // Always delete the job's own id, even when the queue can't be read.
  if (externalId) await postJson("/queue", { delete: [externalId] }, worker);
  const queue = await comfyJson<{ queue_running?: QueueEntry[]; queue_pending?: QueueEntry[] }>("/queue", worker).catch(() => undefined);
  if (!queue) return false;
  const pending = (queue.queue_pending ?? []).filter(ours).map((q) => String(q[1]));
  if (pending.length) await postJson("/queue", { delete: pending }, worker);
  const running = (queue.queue_running ?? []).filter(ours);
  for (const q of running) await postJson("/interrupt", { prompt_id: String(q[1]) }, worker);
  return pending.length + running.length > 0;
}

/** Cancel tries for a meta-batch job after the first: a pass that was already saving when interrupted can still queue the next one. */
export const CANCEL_SWEEPS = { tries: 5, everyMs: 1000 };

async function sweepPasses(prefix: string, worker: ComfyWorker = "main"): Promise<void> {
  for (let i = 0; i < CANCEL_SWEEPS.tries; i++) {
    await new Promise((r) => setTimeout(r, CANCEL_SWEEPS.everyMs));
    if (!(await stopPrompts(undefined, prefix, worker).catch(() => false))) return;
  }
}

// ---------------------------------------------------------------------------
// A ComfyUI on someone's own computer: its runs are tasks their Fuobe tab does (src/server/computer)

/** Run `fn` as a principal's work on its own computer: an account's (as that account), or the owner's. */
export function onComputer<T>(principal: Principal, fn: () => T): T {
  if (principal === "owner") return outsideTenant(() => outsideOwnGpu(fn));
  // A task always belongs to the owner or an account; a pool only takes it (callers pass the task's own principal).
  if (!principal.startsWith("acct:")) throw new Error("Not a task's principal");
  return runAsTenant({ kind: "account", id: principal.slice(5) }, () => onOwnGpu({ kind: "computer", principal: principal as `acct:${string}` }, fn));
}

/** The most one result may weigh when it comes from a computer: an account's 1 GB (less when its files are fuller); the owner's 8 GB. */
const OWNER_RESULT_BYTES = 8 * 2 ** 30;
/** A text result (a transcript, captions). */
const TEXT_RESULT_BYTES = 8 * 2 ** 20;

/**
 * A computer's finished prompt (its /history entry, or a meta-batch's passes): the results to collect, as the server's
 * own run would collect them (collectOutputs), each one a file the tab uploads under its number. An account keeps up to
 * 16 results and 1,800 EXR frames, never more than its files have room for. Call it as the task's principal (onComputer).
 */
export function planRelayOutputs(t: Pick<TaskRow, "id" | "workflow_id" | "meta_batch" | "prefix">, entries: HistoryEntryLike[], passes: boolean): FinishedPlan {
  let manifest: ManifestWorkflow | undefined;
  try {
    manifest = t.workflow_id ? getWorkflow(t.workflow_id).manifest : undefined;
  } catch {}
  const list = (passes ? entries : entries.slice(0, 1)) as HistoryEntry[];
  // A pass that failed (out of memory, a node exception) ends the job: say why instead of "no output".
  const failed = list.find((e) => e?.status?.status_str === "error");
  if (failed) {
    const interrupted = failed.status?.messages?.some(([type]) => type === "execution_interrupted");
    return { error: interrupted ? RELAY_WORDS.stopped : explainExecutionError(executionError(failed), manifest) };
  }
  const collect = (e: HistoryEntry) => collectOutputs(e, manifest, `relay:${t.id}`);
  let outputs: ComfyOutput[] = passes ? metaBatchResults(list, collect) : list[0] ? collect(list[0]) : [];
  // A meta-batch's first pass may have saved only its EXR frames: the clip comes with the last pass.
  if (t.meta_batch && !passes && t.prefix && !outputs.some((o) => !isFrame(o))) return { follow: t.prefix };
  if (!outputs.length) return { error: "This run finished without a result. Press Retry." };
  const account = tenantAccount();
  let budget = Infinity;
  if (account) {
    const frames = outputs.filter((o) => o.meta?.role === "frames");
    if (frames.length > ACCOUNT_LIMITS.framesPerJob) return { error: `Your ComfyUI made ${frames.length} EXR frames. A run on your GPU keeps up to ${ACCOUNT_LIMITS.framesPerJob}: export a shorter clip.` };
    outputs = [...outputs.filter((o) => o.meta?.role !== "frames").slice(0, ACCOUNT_LIMITS.outputsPerJob), ...frames];
    if (!diskHasRoom()) return { error: ACCOUNT_MESSAGES.diskLow };
    budget = accountTotalBytes(account) - accountUsage(account).total;
    if (budget <= 0) return { error: filesFullMessage(account) };
  }
  const wanted: WantedFile[] = [];
  outputs = outputs.map((o) => {
    if (!o.url.startsWith("relay:")) return o;
    const q = new URLSearchParams(o.url.split("?")[1] ?? "");
    const n = wanted.length;
    const frame = o.meta?.role === "frames";
    const kind: WantedFile["kind"] = frame ? "frame" : o.kind === "image" || o.kind === "video" || o.kind === "audio" || o.kind === "text" || o.kind === "model3d" ? o.kind : "image";
    const cap = frame ? OWN_FRAME_MAX_BYTES : kind === "text" ? TEXT_RESULT_BYTES : account ? OWN_OUTPUT_LIMITS.maxBytes : OWNER_RESULT_BYTES;
    wanted.push({ n, filename: q.get("filename") ?? "", subfolder: q.get("subfolder") ?? "", type: q.get("type") === "temp" ? "temp" : "output", kind, maxBytes: Math.max(1, Math.min(cap, budget)) });
    return { ...o, url: `${o.url}&n=${n}`, headers: undefined };
  });
  return { wanted, outputs, budget: Number.isFinite(budget) ? budget : Number.MAX_SAFE_INTEGER };
}

/** A task's error as the run's words (and what was missing, for "Fix it"). */
function relayFailure(t: TaskRow, manifest: ManifestWorkflow | undefined): { error: string; fix?: GenerationFix } {
  const refusal = refusalOf(t);
  if (refusal && manifest) {
    const r = promptRefusal((refusal.body ?? {}) as PromptRefusalBody, refusal.status, manifest, extraOf(t).loras ?? []);
    return { error: r.message ?? `Your ComfyUI refused the job (HTTP ${refusal.status})`, ...(r.fix && { fix: r.fix }) };
  }
  if (refusal) return { error: `Your ComfyUI refused the job (HTTP ${refusal.status})` };
  const e = t.error ?? "";
  const tab = /^tab:([a-z-]+)(?::(\d+))?$/.exec(e);
  if (tab) return { error: tabFailureWords(tab[1] as TabFailure, tab[2] ? Number(tab[2]) : undefined) };
  const words: Record<string, string> = { lost: RELAY_WORDS.lost, silent: RELAY_WORDS.computerSilent, down: RELAY_WORDS.comfyDownTooLong, tooBig: RELAY_WORDS.tooBig };
  if (e === "full") {
    const account = tenantAccount();
    return { error: account ? filesFullMessage(account) : "There's no room to keep this result." };
  }
  return { error: words[e] ?? (e || "Your ComfyUI couldn't finish this run") };
}

/** A run on someone's computer: where its task is, in the words its tile shows. */
async function pollComputer(principal: Principal, meta: Record<string, unknown>, manifest: ManifestWorkflow | undefined, made: string | undefined): Promise<PollResult> {
  const found = typeof meta.relay === "string" ? getTask(principal, meta.relay) : null;
  if (!found) return { state: "failed", error: "This run was lost. Press Retry." };
  const t = checkClocks(found);
  // A run on the workers: while it waits, its place in line; once a worker has it, that worker's reports (a worker that
  // goes quiet gives it back to the line, pool.ts, so no "open Fuobe on your computer").
  if (t.pools && t.state === "waiting") return { state: "queued", message: t.note === "resent" ? "Back in line for another GPU" : poolWaitWords(t) };
  const p = taskProgress(t.id);
  const kind = extraOf(t).made ?? made ?? "image";
  const waitMs = tenantAccount() ? ACCOUNT_LIMITS.queueMs : 4 * 3_600_000;
  const sentAt = t.sent_at ?? undefined;
  // Sent, and the computer's tab stopped answering (closed, asleep): not a run that looks alive for half an hour.
  const r = t.state === "waiting" || t.pools ? null : runnerFacts(principal);
  const away = !t.pools && t.state !== "waiting" && (!r || Date.now() - r.seenAt >= RELAY_TIMES.onlineMs);
  // A ComfyUI paired with a code runs the jobs itself (no Fuobe tab): one that is off is waited for in its own words.
  const paired = !t.pools && pairedRunner(principal);
  const down = t.down_at ? (t.down_why === "setting" ? RELAY_WORDS.comfyNoSetting : RELAY_WORDS.comfyDown) : away ? (paired ? RELAY_WORDS.pairedAway : RELAY_WORDS.computerAway) : undefined;
  const waitedTooLong = paired ? RELAY_WORDS.pairedWaitedTooLong(waitMs) : RELAY_WORDS.waitedTooLong(waitMs);
  switch (t.state) {
    case "waiting": {
      // The computer's tab is open, but its ComfyUI is closed or runs without Fuobe's setting: say that, not "open Fuobe".
      const f = runnerFacts(principal);
      const message = f?.online
        ? RELAY_WORDS.starting
        : f?.comfy === "no-setting"
          ? RELAY_WORDS.comfyNoSetting
          : f?.comfy === "down"
            ? RELAY_WORDS.comfyDown
            : paired
              ? RELAY_WORDS.pairedAway
              : RELAY_WORDS.noComputer;
      return { state: "queued", message, timeoutError: waitedTooLong };
    }
    case "sending":
      return { state: "queued", message: down ?? (t.note === "resent" ? RELAY_WORDS.resent : sendingWords(inputKinds(t))), timeoutError: waitedTooLong, ...(sentAt && { sentAt }) };
    case "queued":
      return { state: "queued", message: down ?? queueWords(p?.position), ...(sentAt && { sentAt }) };
    case "running": {
      const total = Number(meta.nodeCount ?? 0);
      const stepFrac = p?.max ? (p.value ?? 0) / p.max : 0;
      const value = total ? Math.min(0.99, (Math.max(1, p?.nodesDone ?? 1) - 1 + stepFrac) / total) : stepFrac || undefined;
      return { state: "running", progress: value && value > 0 ? value : undefined, message: down ?? makingWords(kind, p?.value, p?.max), ...(sentAt && { sentAt }) };
    }
    case "collecting": {
      const got = receivedOf(t);
      const total = got.reduce((s, r) => s + r.total, 0);
      return { state: "running", progress: 0.99, message: down ?? savingWords(total ? got.reduce((s, r) => s + r.bytes, 0) / total : undefined), ...(sentAt && { sentAt }) };
    }
    case "done": {
      const types = new Map(receivedOf(t).map((r) => [r.n, r.contentType]));
      let outputs = resultOf<ComfyOutput>(t).map((o) => {
        const n = Number(new URLSearchParams(o.url.split("?")[1] ?? "").get("n"));
        const type = o.url.startsWith("relay:") ? types.get(n) : undefined;
        return type ? { ...o, contentType: type } : o;
      });
      if (!outputs.length) return { state: "failed", error: "This run finished without a result. Press Retry." };
      try {
        outputs = await bundleFrames(outputs, String(meta.generationId ?? ""));
      } catch (e) {
        return { state: "failed", error: (e as Error).message };
      }
      return { state: "succeeded", outputs: await withLayerBoxes(outputs) };
    }
    case "canceled":
      return { state: "failed", error: t.error === "switched" ? RELAY_WORDS.switched : t.error === "disconnected" ? RELAY_WORDS.disconnected : RELAY_WORDS.stopped };
    default:
      return { state: "failed", ...relayFailure(t, manifest) };
  }
}

export const comfyProvider: ProviderAdapter = {
  id: "comfyui",
  label: "ComfyUI",
  isConfigured: () => {
    if (ownGpu() || computerScope()) return true;
    const cur = globalThis.__fuobeComfyReach;
    // First check for this server: wait for the answer, so a request right after start isn't sent to demo.
    if (!cur || cur.url !== baseUrl()) return probeComfySync();
    if (Date.now() - cur.at > 10_000) void probeComfy().catch(() => false);
    return cur.ok;
  },

  // Inputs go to the server that runs the route's workflow (the isolated worker has its own input folder).
  async prepareFile(data, contentType, name, route?: ModelRoute) {
    return uploadTo(workerFor(route?.endpoint), data, contentType, name);
  },

  async submit({ route, input, generationId, model }) {
    const worker = workerFor(route.endpoint);
    if (worker === "isolated" && computerScope()) throw new ProviderError(ISOLATED_ON_COMPUTER);
    // A route's own graph settings (Fuobe Speak's InfiniteTalk recipe) go in unless the run sets them.
    const asked = route.extra ? { ...input, extra: { ...route.extra, ...input.extra } } : input;
    const { manifest, workflow: wf, meta } = await prepareWorkflow(route.endpoint, asked, {
      generationId,
      op: route.op,
      loraSlot: route.loraSlot === true,
      upload: (data, contentType, name) => uploadTo(worker, data, contentType, name),
      media: mediaInfoFor,
      serverRam: async () => {
        const computer = computerScope();
        if (computer) return runnerFacts(computer)?.ramBytes;
        return (await comfyJson<{ system?: { ram_total?: number } }>("/system_stats", worker).catch(() => undefined))?.system?.ram_total;
      },
      device: () => comfyDevice(worker),
      modelPath: (folder, name) => comfyModelPath(folder, name, worker),
      vram: async () => {
        const computer = computerScope();
        if (computer) return runnerFacts(computer)?.vramBytes;
        const s = await comfyJson<{ devices?: { vram_total?: unknown }[] }>("/system_stats", worker).catch(() => undefined);
        const v = s?.devices?.[0]?.vram_total;
        return typeof v === "number" && v > 0 ? v : undefined;
      },
      // Fresh: a model installed a moment ago runs. (On someone's computer, nothing to ask: its ComfyUI has the last word.)
      dbsModels: () => comfyDbsModels(worker, 0),
      reuseModels: () => comfyReuseModels(worker, 0),
      // The pack switched off in Settings → Models & licences: Idol 3D runs its core graph, as without the pack.
      idolPack: async () => ((await import("@/server/model-access")).readAccess().packs.includes(IDOL_PACK) ? false : comfyHasClass(IDOL_PACK_CLASS, worker)),
    });
    // MiniMax H3's 2K draft that kept its latent says where (the finish loads it only there: generations.ts latentHandOff).
    const latentAt = manifest.id === H3_LATENT_DRAFT_WORKFLOW ? comfyPlace() : null;
    if (latentAt) meta.latentAt = latentAt;
    // On someone's computer: the job waits for their Fuobe tab, which sends exactly this graph under the prompt id minted
    // here. A refusal comes back in its report, and the poll explains it as below.
    const computer = computerScope();
    if (computer) {
      const metaBatch = !!meta.metaBatch;
      const task = createTask({
        principal: computer,
        generationId,
        graph: wf,
        prefix: typeof meta.prefix === "string" ? meta.prefix : undefined,
        metaBatch,
        preview: true,
        workflowId: manifest.id,
        made: model?.kind,
        loras: (input.loras ?? []).map((l) => ({ file: l.file, ...(l.url && { url: l.url }) })),
        // The owner's jobs on the workers: the lane and files they need, ahead of everyone else's, with a wait limit.
        ...(onWorkers(computer) && { pool: poolFields(manifest.id, { boostMs: OWNER_BOOST_MS, waitMs: poolWaitMs() }) }),
      });
      return { externalId: task.promptId, meta: { ...meta, generationId, relay: task.id }, payload: wf };
    }
    const { clientId } = ensureSocket(worker);
    const res = await comfyFetch(
      "/prompt",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: wf, client_id: clientId }),
      },
      worker,
    );
    const answer = await res.text().catch(() => "");
    let body: PromptRefusalBody & { prompt_id?: string } = {};
    try {
      body = (JSON.parse(answer) ?? {}) as typeof body;
    } catch {}
    // A 2K finish whose draft's latent isn't on this ComfyUI any more (its output folder was cleaned): the draft's clip,
    // chained into the same run, is redrawn instead.
    if (!res.ok && latentGone(body, manifest) && typeof input.extra?.latentFrom === "string") {
      const { latentFrom: _gone, ...extra } = input.extra;
      void _gone;
      return comfyProvider.submit({ route, input: { ...input, extra }, generationId, model });
    }
    if (!res.ok || !body.prompt_id) {
      // The pack may have gone since the server said it had it: the next run asks again (and runs the core graph without it).
      if (manifest.id === IDOL_WORKFLOWS.clean || manifest.id === IDOL_VIEWS_WORKFLOW) forgetComfyClass(IDOL_PACK_CLASS, worker);
      const refusal = promptRefusal(body, res.status, manifest, input.loras ?? [], worker);
      if (!refusal.message && !res.ok && worker === "isolated") throw isolatedAnswer("the prompt", res.status);
      // An account's link: no words from ComfyUI (a stopped pod's or a proxy's page) is read for what it means; ComfyUI's
      // own refusal is said plainly, its words in the details line.
      const link = ownLink();
      if (link) {
        if (!refusal.message) throw gpuTrouble({ stage: "prompt", status: res.status, body: answer.slice(0, 4096), contentType: res.headers.get("content-type") ?? undefined }, link);
        const d: Diagnosis = refusal.plain
          ? { cause: "gpu-refused", words: refusal.message, ...(refusal.details && { details: refusal.details }), actions: [{ kind: "retry", label: "Retry" }], retryable: false }
          : diagnoseRefusal(refusal.message);
        throw Object.assign(troubleError(d, res.status), refusal.fix ? { fix: refusal.fix } : {});
      }
      throw Object.assign(new ProviderError(refusal.message ?? `ComfyUI /prompt failed (${res.status})`, res.status), refusal.fix ? { fix: refusal.fix } : {});
    }
    if (!PROMPT_ID.test(body.prompt_id)) {
      // Stop it there: an id Fuobe can't use would never be collected.
      throw new ProviderError(ownGpu() ? "Your ComfyUI couldn't take this run. Press Retry." : "ComfyUI couldn't take this run. Press Retry.");
    }
    return { externalId: body.prompt_id, meta: { ...meta, generationId, ...(worker === "isolated" && { worker }) }, payload: wf };
  },

  async poll({ externalId, meta, model, ...rest }) {
    if (!PROMPT_ID.test(externalId)) return { state: "failed", error: "ComfyUI couldn't take this run. Press Retry." };
    const worker: ComfyWorker = meta.worker === "isolated" ? "isolated" : "main";
    let manifest: ManifestWorkflow | undefined;
    try {
      manifest = getWorkflow(String(meta.workflowId)).manifest;
    } catch {}
    // A run is followed where it was sent (Settings, or the account's GPU, may have moved since).
    if (typeof meta.relay === "string") return pollComputer(relayPrincipal(), meta, manifest, model?.kind);
    if (computerScope()) {
      // Sent to a link before the account chose this computer: that link is gone.
      if (ownGpu()) return { state: "failed", error: RELAY_WORDS.switched };
      return serverScope.run(true, () => comfyProvider.poll({ externalId, meta, model, ...rest }));
    }
    const finished = async (entry: HistoryEntry) => {
      // A Context Loop job (Group swap, Scene edit): its clips and checkpoints under output/h3_chains go once it ends (the
      // final video is copied out of that folder first).
      if (manifest && CONTEXT_LOOP_IDS.has(manifest.id) && typeof meta.generationId === "string") void deleteRunFolder(runName(meta.generationId), worker);
      if (entry.status?.status_str === "error") {
        forget(externalId);
        const link = ownLink();
        if (link) {
          // An account's link: stopped there, out of memory, or an add-on's exception, said plainly (its words go in details).
          const err = executionError(entry);
          const said = explainExecutionError(err, manifest);
          const interrupted = !err && entry.status?.messages?.some(([type]) => type === "execution_interrupted");
          const d = interrupted
            ? diagnoseGpuJob({ kind: "interrupted" }, link)
            : err && said !== `${err.node_type}: ${(err.exception_message ?? "").trim()}`
              ? { cause: "gpu-job-error" as const, words: said, actions: [{ kind: "retry" as const, label: "Retry" }], retryable: false }
              : diagnoseGpuJob({ kind: "error", nodeType: err?.node_type, message: err?.exception_message }, link);
          return { state: "failed" as const, error: d.words, trouble: d };
        }
        return { state: "failed" as const, error: explainExecutionError(executionError(entry), manifest) };
      }
      let outputs = collectOutputs(entry, manifest, baseUrl(worker), authHeaders(worker));
      // A meta-batch's first pass may have saved only its EXR frames: the clip comes with the last pass.
      if (meta.metaBatch && typeof meta.prefix === "string" && !outputs.some((o) => !isFrame(o))) {
        const next = await followMetaBatch(meta.prefix, manifest, worker);
        if (next === "running") return { state: "running" as const, message: "Rendering the next batch of frames" };
        if (next && "error" in next) {
          forget(externalId);
          return { state: "failed" as const, error: next.error };
        }
        outputs = next ?? [];
      }
      forget(externalId);
      if (!outputs.length) return { state: "failed" as const, error: "This run finished without a result. Press Retry." };
      try {
        outputs = await bundleFrames(outputs, String(meta.generationId ?? String(meta.prefix ?? "").replace(/^fuobe\//, "")));
      } catch (e) {
        return { state: "failed" as const, error: (e as Error).message };
      }
      const seed = typeof meta.seed === "number" ? meta.seed : undefined;
      if (seed !== undefined) outputs = outputs.map((o) => (o.kind === "image" ? { ...o, meta: { ...o.meta, seed } } : o));
      if (manifest?.id === H3_REMOVAL_WORKFLOW) outputs = await withRemovalReview(entry, outputs, meta.reviewInputs, worker, String(meta.generationId ?? String(meta.prefix ?? "").replace(/^fuobe\//, "")));
      return { state: "succeeded" as const, outputs: await withLayerBoxes(outputs) };
    };
    const isDone = (e: HistoryEntry | undefined): e is HistoryEntry => !!e && (!!e.status?.completed || e.status?.status_str === "success" || e.status?.status_str === "error");

    const entry = (await comfyJson<Record<string, HistoryEntry>>(`/history/${encodeURIComponent(externalId)}`, worker))[externalId];
    if (isDone(entry)) return finished(entry);

    // Still queued or running?
    const { progress } = ensureSocket(worker);
    const p = progress.get(externalId);
    const queue = await comfyJson<{ queue_running?: unknown[][]; queue_pending?: unknown[][] }>("/queue", worker);
    const running = queue.queue_running?.some((q) => q[1] === externalId);
    const pendingIdx = queue.queue_pending?.findIndex((q) => q[1] === externalId) ?? -1;
    if (!running && pendingIdx < 0 && !entry) {
      // It may have finished between the two requests (ComfyUI moves it from the queue to the history at once).
      const again = (await comfyJson<Record<string, HistoryEntry>>(`/history/${encodeURIComponent(externalId)}`, worker))[externalId];
      if (isDone(again)) return finished(again);
      const misses = globalThis.__fuobeComfyMisses ?? (globalThis.__fuobeComfyMisses = new Map());
      const n = (misses.get(externalId) ?? 0) + 1;
      misses.set(externalId, n);
      const link = ownLink();
      if (n < 3) return { state: "running", message: link ? "Checking on your GPU" : "Checking on ComfyUI" };
      forget(externalId);
      // An account's link: the runner may send it once more (generations.ts), as a computer's tab does.
      if (link) {
        const d = diagnoseGpuJob({ kind: "lost" }, link);
        return { state: "failed", error: d.words, trouble: d, lost: true };
      }
      return { state: "failed", error: "ComfyUI restarted and lost this run. Press Retry." };
    }
    globalThis.__fuobeComfyMisses?.delete(externalId);
    if (pendingIdx >= 0) return { state: "queued", message: pendingIdx === 0 ? "Next in ComfyUI's queue" : `In ComfyUI's queue · ${pendingIdx} ahead` };
    const total = Number(meta.nodeCount ?? 0);
    const stepFrac = p && p.max ? p.value / p.max : 0;
    const progressValue = total ? Math.min(0.99, ((p?.nodesDone ?? 0) - 1 + stepFrac) / total) : stepFrac || undefined;
    return {
      state: "running",
      progress: progressValue && progressValue > 0 ? progressValue : undefined,
      message: p?.max ? `Sampling ${p.value}/${p.max}` : worker === "isolated" ? "Running on the isolated ComfyUI worker" : "Running on ComfyUI",
    };
  },

  async cancel(ctx) {
    const { externalId, meta } = ctx;
    // On someone's computer: the task ends now, and its prompt comes off their ComfyUI at their tab's next beat.
    if (typeof meta?.relay === "string") return requestStop(relayPrincipal(), meta.relay);
    if (computerScope()) {
      // Sent before ComfyUI moved to a computer: the owner's goes off the studio's own ComfyUI (a link is gone).
      if (!ownGpu()) await serverScope.run(true, () => comfyProvider.cancel!(ctx));
      return;
    }
    const worker: ComfyWorker = meta?.worker === "isolated" ? "isolated" : "main";
    forget(externalId);
    // A meta-batch job's later passes have prompt ids of their own (and jump the queue): find them by prefix.
    const prefix = meta?.metaBatch && typeof meta.prefix === "string" ? meta.prefix : undefined;
    const found = await stopPrompts(externalId, prefix, worker);
    if (prefix && found) void sweepPasses(prefix, worker);
  },

  async test(opts) {
    // The WorldCast worker's address (Settings → Open-source engine, beside the isolated worker): that worker answers.
    if (opts?.focus === "worldcastUrl") {
      const h = await worldcastHealth(10_000);
      if (h.ok) globalThis.__fuobeWorldcast = { base: worldcastBase(), at: Date.now(), ok: true, depth: h.depth ?? [] };
      return { ok: h.ok, detail: h.detail };
    }
    // On someone's computer: what its tab last said about it.
    const computer = computerScope();
    if (computer) {
      const f = runnerFacts(computer);
      if (!f?.online) return { ok: false, detail: RELAY_WORDS.noComputer };
      return { ok: true, detail: `ComfyUI ${f.version ?? ""} · ${f.device ?? "unknown device"}${f.vramBytes ? ` · ${(f.vramBytes / 2 ** 30).toFixed(0)} GB` : ""} · on your computer`.replace(/\s+/g, " ") };
    }
    const describe = async (worker: ComfyWorker) => {
      const res = await comfyFetch("/system_stats", {}, worker);
      if (!res.ok) {
        discardBody(res);
        throw new ProviderError(`HTTP ${res.status}`);
      }
      const s = (await res.json()) as { system?: { comfyui_version?: string }; devices?: { name?: string; vram_total?: number }[] };
      const dev = s.devices?.[0];
      return `ComfyUI ${s.system?.comfyui_version ?? ""} · ${dev?.name ?? "unknown device"}${dev?.vram_total ? ` · ${(dev.vram_total / 2 ** 30).toFixed(0)} GB` : ""}`;
    };
    // Checking the isolated worker's address: that worker answers, or it isn't connected (the main
    // server's state is the main address's test).
    if (opts?.focus === "comfyIsolatedUrl") {
      if (!baseUrl("isolated")) return { ok: false, detail: "No isolated worker address set" };
      return describe("isolated").then(
        (d) => ({ ok: true, detail: `isolated worker: ${d}` }),
        (e: Error) => ({ ok: false, detail: /^HTTP \d/.test(e.message) ? `The isolated worker at ${baseUrl("isolated")} answered ${e.message}` : e.message }),
      );
    }
    let detail: string;
    try {
      detail = await describe("main");
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
    // The isolated worker is optional: say whether it answers, without failing the main server's test.
    if (baseUrl("isolated")) {
      const iso = await describe("isolated").then(
        (d) => `isolated worker: ${d}`,
        () => `the isolated worker at ${baseUrl("isolated")} doesn't answer`,
      );
      detail = `${detail} · ${iso}`;
    }
    return { ok: true, detail };
  },
};

/** The LoRA files the ComfyUI server that runs `route` has (GET /models/loras), or null when it can't say. */
export async function comfyLoraFiles(route?: ModelRoute): Promise<string[] | null> {
  // On someone's computer: the list its tab last sent (null: it can't say, and ComfyUI's own check has the last word).
  const computer = computerScope();
  if (computer) return runnerFacts(computer)?.loras ?? null;
  try {
    const res = await comfyFetch("/models/loras", {}, workerFor(route?.endpoint));
    if (!res.ok) discardBody(res);
    return res.ok ? ((await res.json()) as string[]) : null;
  } catch {
    return null;
  }
}

/** Which manifest models are present on the connected ComfyUI server. */
export async function modelInventory(): Promise<Record<string, string[]> | null> {
  if (computerScope()) return null;
  try {
    const listed = await comfyFetch("/models");
    const folders = listed.ok ? ((await listed.json()) as string[]) : ["diffusion_models", "checkpoints", "text_encoders", "vae", "loras"];
    const out: Record<string, string[]> = {};
    await Promise.all(
      folders.map(async (f) => {
        const r = await comfyFetch(`/models/${f}`);
        out[f] = r.ok ? ((await r.json()) as string[]) : [];
      }),
    );
    return out;
  } catch {
    return null;
  }
}
