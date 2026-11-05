import "server-only";
import { z } from "zod";
import { planJoin, planLoop, CROSSFADE_MAX, JOIN_MAX_CLIPS, LOOP_MAX_SECONDS, type AudioToolPreview, type ToolPlan } from "@/lib/av/audio-tools";
import { CLOUD_ONLY_PROBLEM, DBS_MODELS, dbsChannelsFor, hostPick, missingDbs, planRemux, planSplit, splitTime } from "@/lib/av/split";
import { CLOUD_ONLY_REMOVE_PROBLEM, LOWER_MAX_DB, LOWER_MIN_DB, NO_SOUND_PROBLEM, planRemoveDialogue, removeDialogueTime } from "@/lib/av/remove-dialogue";
import { planCleanDialogue, planRemix, REMIX_MAX_DB, REMIX_MIN_DB } from "@/lib/av/clean-dialogue";
import { CLOUD_ONLY_CLEAN_PROBLEM, missingReuse, NO_REUSE_PACK, planClean, planTime, tooLongProblem } from "@/lib/av/clean-voice";
import type { Engine, Generation } from "@/lib/catalog/types";
import { CLOUD_ONLY_SPEECH_EDIT_PROBLEM, EMOTIONS, PACES, PITCH_STEPS, planSpeechEdit, SPEECH_EDIT_MAX_SECONDS, VOLUME_STEPS } from "@/lib/speech-edit";
import { lastGpuDevice } from "./account-gpu";
import type { ToolStep } from "./account-tool-run";
import { createPipeline } from "./chains";
import { ConnectComfyError, previewChained } from "./generations";
import { comfyDbsModels, comfyDevice, comfyReuseModels, ownGpu } from "./providers/comfyui";
import { engineMode } from "./settings";
import { isExampleRef } from "./example-files";
import { storedMedia } from "./storage";
import { tenant, tenantAccount } from "./tenant";

/**
 * The Audio hub's Loop / extend, Join and Split soundtrack tools, and Video tools → Remove dialogue, on the server: each
 * clip's length is read from its own header (the browser's figure is the fallback for containers the probe doesn't read),
 * the plan from src/lib/av/audio-tools.ts, src/lib/av/split.ts or src/lib/av/remove-dialogue.ts is priced step by step,
 * and a run is one createPipeline batch, so its results land in the Library like any generation. Split soundtrack and
 * Remove dialogue run on the open engine only (DBS isn't hosted); a split's mix goes back on the video with a "remux" run
 * on either engine. Clean up dialogue (src/lib/av/clean-dialogue.ts) runs on both: DBS's remix on the open engine, a hosted
 * speech cleaner (VEED, DeepFilterNet 3, ElevenLabs isolation) in the cloud.
 */

/** A stored file, or one of Fuobe's published example inputs (a page's example, loaded as the source: example-files.ts). */
const FileUrl = z
  .string()
  .max(500)
  .refine((v) => v.startsWith("/api/files/") || isExampleRef(v), { message: "Invalid input: expected a stored file" });
const Engine = z.enum(["cloud", "open"]);
const Curve = z.enum(["equal-power", "linear"]).optional();
const Crossfade = z.number().min(0).max(CROSSFADE_MAX).optional();

export const AudioToolBody = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("loop"),
    engine: Engine,
    audio: FileUrl,
    name: z.string().max(200).optional(),
    duration: z.number().positive().max(LOOP_MAX_SECONDS),
    /** What the browser measured, used when the server can't read the file's header. */
    sourceDuration: z.number().positive().max(36_000).optional(),
    crossfade: Crossfade,
    curve: Curve,
  }),
  z.object({
    tool: z.literal("join"),
    engine: Engine,
    clips: z.array(z.object({ url: FileUrl, name: z.string().max(200).optional(), duration: z.number().positive().max(36_000).optional() })).min(2).max(JOIN_MAX_CLIPS),
    crossfade: Crossfade,
    curve: Curve,
  }),
  z.object({
    tool: z.literal("split"),
    engine: Engine,
    media: FileUrl,
    kind: z.enum(["audio", "video"]),
    name: z.string().max(200).optional(),
    /** Fast (DBS-BSRNN) or Best (DBS-TIGER); unset = the host's pick. */
    quality: z.enum(["fast", "best"]).optional(),
    stereo: z.boolean().optional(),
    /** What the browser decoded (the server reads WAV / FLAC / MP3 headers itself). */
    channels: z.number().int().positive().max(64).optional(),
    sourceDuration: z.number().positive().max(36_000).optional(),
  }),
  z.object({
    /** A soundtrack mixed back on the server as one file at set levels (graph C, oss-dbs-remix): Assist and MCP's split_soundtrack. */
    tool: z.literal("remix"),
    engine: Engine,
    media: FileUrl,
    kind: z.enum(["audio", "video"]),
    name: z.string().max(200).optional(),
    quality: z.enum(["fast", "best"]).optional(),
    stereo: z.boolean().optional(),
    keep: z.array(z.enum(["voice", "music", "effects"])).min(1).max(3).optional(),
    levels: z
      .object({ voice: z.number().min(REMIX_MIN_DB).max(REMIX_MAX_DB).optional(), music: z.number().min(REMIX_MIN_DB).max(REMIX_MAX_DB).optional(), effects: z.number().min(REMIX_MIN_DB).max(REMIX_MAX_DB).optional() })
      .optional(),
    channels: z.number().int().positive().max(64).optional(),
    sourceDuration: z.number().positive().max(36_000).optional(),
  }),
  z.object({
    tool: z.literal("remove-dialogue"),
    engine: Engine,
    video: FileUrl,
    name: z.string().max(200).optional(),
    outcome: z.enum(["no-dialogue", "dialogue-only", "lower-music"]).optional(),
    /** Lower the music: the music and effects' level in dB. */
    musicDb: z.number().min(LOWER_MIN_DB).max(LOWER_MAX_DB).optional(),
    quality: z.enum(["fast", "best"]).optional(),
    channels: z.number().int().positive().max(64).optional(),
    sourceDuration: z.number().positive().max(36_000).optional(),
  }),
  z.object({
    tool: z.literal("clean"),
    engine: Engine,
    media: FileUrl,
    kind: z.enum(["audio", "video"]),
    name: z.string().max(200).optional(),
    /** Voice only, or the laughter model. */
    model: z.enum(["voice", "laughter"]).optional(),
    quality: z.enum(["auto", "full", "fast"]).optional(),
    strength: z.enum(["full", "natural", "light"]).optional(),
    background: z.enum(["remove", "keep"]).optional(),
    level: z.enum(["match", "voice"]).optional(),
    /** A video: put the clean soundtrack back on the picture. */
    remux: z.boolean().optional(),
    stereo: z.boolean().optional(),
    channels: z.number().int().positive().max(64).optional(),
    sourceDuration: z.number().positive().max(36_000).optional(),
  }),
  z.object({
    tool: z.literal("clean-dialogue"),
    engine: Engine,
    media: FileUrl,
    kind: z.enum(["audio", "video"]),
    name: z.string().max(200).optional(),
    /** Open: the music and effects' level under the dialogue (dB), or "off". */
    bed: z.union([z.literal("off"), z.number().int().min(-40).max(0)]).optional(),
    quality: z.enum(["fast", "best"]).optional(),
    stereo: z.boolean().optional(),
    /** Cloud: the hosted cleaner. */
    cleaner: z.enum(["veed", "deepfilternet", "isolation"]).optional(),
    strength: z.number().min(0).max(1).optional(),
    /** A video: put the clean soundtrack back on the picture (default on). */
    remux: z.boolean().optional(),
    channels: z.number().int().positive().max(64).optional(),
    sourceDuration: z.number().positive().max(36_000).optional(),
  }),
  z.object({
    // Edit speech (nm10-speech-edit): a recording's words changed (its transcript's lines, edited), or an effect on a range.
    tool: z.literal("speech-edit"),
    engine: Engine,
    media: FileUrl,
    kind: z.enum(["audio", "video"]),
    name: z.string().max(200).optional(),
    cues: z.array(z.object({ start: z.number().min(0).max(SPEECH_EDIT_MAX_SECONDS), end: z.number().min(0).max(SPEECH_EDIT_MAX_SECONDS), text: z.string().max(2000) })).min(1).max(2000),
    edited: z.array(z.string().max(2000)).max(2000).optional(),
    range: z.object({ start: z.number().min(0), end: z.number().min(0) }).optional(),
    effect: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("pitch"), semitones: z.number().refine((n) => (PITCH_STEPS as readonly number[]).includes(n)) }),
        z.object({ kind: z.literal("pace"), speed: z.number().refine((n) => (PACES as readonly number[]).includes(n)) }),
        z.object({ kind: z.literal("volume"), db: z.number().refine((n) => (VOLUME_STEPS as readonly number[]).includes(n)) }),
        z.object({ kind: z.literal("emotion"), emotion: z.enum(EMOTIONS as [string, ...string[]]) }),
        z.object({ kind: z.literal("whisper") }),
        z.object({ kind: z.literal("unwhisper") }),
        z.object({ kind: z.literal("clean") }),
        z.object({ kind: z.literal("isolate") }),
      ])
      .optional(),
    quality: z.enum(["fast", "best"]).optional(),
    sourceDuration: z.number().positive().max(36_000).optional(),
  }),
  z.object({
    tool: z.literal("remux"),
    engine: Engine,
    video: FileUrl,
    audio: FileUrl,
    name: z.string().max(200).optional(),
  }),
]);
export type AudioToolRequest = z.infer<typeof AudioToolBody>;

export class AudioToolError extends Error {}

/** What a clip's header says. */
interface ClipFacts {
  duration?: number;
  channels?: number;
  /** False when the header says the file has no sound track (a silent video). */
  hasAudio?: boolean;
}

/**
 * A clip's length from its header (WAV, FLAC, MP3, M4A), else the browser's. Only the header is read, once per file
 * (storedMedia caches it: the page asks for a price after every settled change). A visitor's price check reads only its
 * own files: another's answers like one that is gone.
 */
function lengthOf(url: string, given?: number): number | undefined {
  const found = storedMedia(url);
  if (!found) throw new AudioToolError("That audio file is gone — add it again");
  const d = found.info?.duration;
  return d && d > 0 ? Math.round(d * 1000) / 1000 : given;
}

/** Throws `gone` unless the file is still in storage (and, in a visitor's price check, the visitor's own). */
function present(url: string, gone: string): void {
  if (!storedMedia(url)) throw new AudioToolError(gone);
}

/**
 * A clip's length, channel count and whether it has sound, from its header (read as {@link lengthOf} reads it, through
 * storedMedia: only the asker's own files, header only, cached; a WebM or AVI header too: screen and browser recordings
 * are WebM), or null when no reader knows the file.
 */
function factsOf(url: string, gone = "That audio file is gone — add it again"): ClipFacts | null {
  const found = storedMedia(url, { allContainers: true });
  if (!found) throw new AudioToolError(gone);
  const info = found.info;
  if (!info) return null;
  const duration = info.duration && info.duration > 0 ? Math.round(info.duration * 1000) / 1000 : undefined;
  return { ...(duration && { duration }), ...(info.channels && { channels: info.channels }), hasAudio: info.hasAudio };
}

export type AudioToolPlan = ToolPlan & { engine: Engine; split?: ClipFacts; headerChannels?: number };

/** Every file a request names (its clip, its clips, the mix and the video it goes on): an account's own, checked first. */
export function audioToolFiles(body: AudioToolRequest): string[] {
  if (body.tool === "join") return body.clips.map((c) => c.url);
  if (body.tool === "loop") return [body.audio];
  if (body.tool === "remux") return [body.video, body.audio];
  if (body.tool === "remove-dialogue") return [body.video];
  return [body.media];
}

async function plan(body: AudioToolRequest): Promise<AudioToolPlan> {
  return planAudioTool(body);
}

/** The plan of a run, from the files' headers (sync: Assist and MCP price a call with it before it runs). */
export function planAudioTool(body: AudioToolRequest): AudioToolPlan {
  const mode = engineMode();
  // Split soundtrack and Remove dialogue run on the open engine only: an install set to paid APIs only says why, whichever
  // engine was asked for.
  if ((body.tool === "split" || body.tool === "remix") && mode === "cloud") throw new AudioToolError(CLOUD_ONLY_PROBLEM);
  if (body.tool === "remove-dialogue" && mode === "cloud") throw new AudioToolError(CLOUD_ONLY_REMOVE_PROBLEM);
  if (body.tool === "clean" && mode === "cloud") throw new AudioToolError(CLOUD_ONLY_CLEAN_PROBLEM);
  if (body.tool === "speech-edit" && mode === "cloud") throw new AudioToolError(CLOUD_ONLY_SPEECH_EDIT_PROBLEM);
  if (mode !== "both" && body.engine !== mode) throw new AudioToolError(mode === "open" ? "This install is set to open source only (Settings → Engine mode)" : "This install is set to paid cloud APIs only (Settings → Engine mode)");
  try {
    if (body.tool === "split") {
      const facts = factsOf(body.media);
      // A clip made without sound (a silent text-to-video take): nothing to split, said before anything is queued.
      if (facts?.hasAudio === false) throw new AudioToolError(body.kind === "video" ? "This video has no sound to split" : "This file has no sound to split");
      const seconds = facts?.duration ?? body.sourceDuration;
      const channels = facts?.channels ?? body.channels;
      return { engine: body.engine, ...planSplit({ ...body, seconds, channels }), split: { duration: seconds, channels }, headerChannels: facts?.channels };
    }
    if (body.tool === "remix") {
      const facts = factsOf(body.media);
      if (facts?.hasAudio === false) throw new AudioToolError(body.kind === "video" ? "This video has no sound to remix" : "This file has no sound to remix");
      const seconds = facts?.duration ?? body.sourceDuration;
      const channels = facts?.channels ?? body.channels;
      return { engine: body.engine, ...planRemix({ ...body, seconds, channels }), split: { duration: seconds, channels }, headerChannels: facts?.channels };
    }
    if (body.tool === "remove-dialogue") {
      const facts = factsOf(body.video, "That video is gone — add it again");
      // A clip made without sound (a silent text-to-video take): nothing to take out, said before anything is queued.
      if (facts?.hasAudio === false) throw new AudioToolError(NO_SOUND_PROBLEM);
      const seconds = facts?.duration ?? body.sourceDuration;
      const channels = facts?.channels ?? body.channels;
      return { engine: body.engine, ...planRemoveDialogue({ ...body, seconds, channels, hasAudio: facts?.hasAudio }), split: { duration: seconds, channels }, headerChannels: facts?.channels };
    }
    if (body.tool === "clean") {
      const facts = factsOf(body.media);
      const seconds = facts?.duration ?? body.sourceDuration;
      const channels = facts?.channels ?? body.channels;
      return { engine: body.engine, ...planClean({ ...body, seconds, channels, silent: facts?.hasAudio === false }), split: { duration: seconds, channels }, headerChannels: facts?.channels };
    }
    if (body.tool === "clean-dialogue") {
      const facts = factsOf(body.media);
      const seconds = facts?.duration ?? body.sourceDuration;
      const channels = facts?.channels ?? body.channels;
      return { engine: body.engine, ...planCleanDialogue({ ...body, seconds, channels, silent: facts?.hasAudio === false }), split: { duration: seconds, channels }, headerChannels: facts?.channels };
    }
    if (body.tool === "speech-edit") {
      const facts = factsOf(body.media, body.kind === "video" ? "That video is gone — add it again" : "That recording is gone — add it again");
      const seconds = facts?.duration ?? body.sourceDuration;
      return { engine: body.engine, ...planSpeechEdit({ ...body, effect: body.effect as Parameters<typeof planSpeechEdit>[0]["effect"], seconds, hasAudio: facts?.hasAudio }) };
    }
    if (body.tool === "remux") {
      present(body.audio, "That mix is gone — export it again");
      present(body.video, "That video is gone — add it again");
      return { engine: body.engine, ...planRemux(body) };
    }
    if (body.tool === "loop") {
      const sourceDuration = lengthOf(body.audio, body.sourceDuration);
      return { engine: body.engine, ...planLoop({ ...body, sourceDuration: sourceDuration ?? 0 }) };
    }
    const clips = body.clips.map((c) => ({ ...c, duration: lengthOf(c.url, c.duration) }));
    return { engine: body.engine, ...planJoin({ ...body, clips }) };
  } catch (e) {
    throw e instanceof AudioToolError ? e : new AudioToolError((e as Error).message);
  }
}

/** What a run would do and cost, without starting it. */
export async function previewAudioTool(body: AudioToolRequest): Promise<AudioToolPreview> {
  const p = await plan(body);
  let cost: number | null = 0;
  let demo = false;
  for (const s of p.steps) {
    let r: ReturnType<typeof previewChained>;
    try {
      r = previewChained(s.chain ? { ...s.request, chain: s.chain } : s.request, s.after?.length ?? 0);
    } catch (e) {
      if (e instanceof ConnectComfyError) throw e;
      throw new AudioToolError((e as Error).message);
    }
    demo ||= r.demo;
    cost = cost === null || r.costUsd === null ? null : cost + r.costUsd;
  }
  const out: AudioToolPreview = { summary: p.summary, notes: p.notes, length: p.length, steps: p.steps.length, costUsd: cost === null ? null : Math.round(cost * 1000) / 1000, demo };
  if (body.tool === "split" || body.tool === "remix" || body.tool === "remove-dialogue" || (body.tool === "clean-dialogue" && body.engine === "open")) {
    // How long it takes on this host: its device (asked once a minute), the model it would use (one it has on disk) and
    // how many passes. A model the host doesn't have is refused here, before the run, with how to install it.
    // A visitor's price check (a guest's, or an account's on its own GPU) never calls a GPU, as main's price checks
    // don't (the server calls an account's address a few times a minute at most): an account's device is what its last
    // status check read (lastGpuDevice), a guest has none, and the run checks the models on the GPU's disk.
    const visitor = !!tenant() || !!ownGpu();
    const account = tenantAccount();
    const [device, installed] = demo
      ? [undefined, undefined]
      : visitor
        ? [account ? lastGpuDevice(account) : undefined, undefined]
        : await Promise.all([comfyDevice().catch(() => undefined), comfyDbsModels().catch(() => undefined)]);
    const pick = hostPick(device, installed);
    const quality = body.quality ?? pick;
    // Picked or the host's pick: a host with neither model on disk can't run its pick either.
    if (installed && !installed.includes(DBS_MODELS[quality])) throw new AudioToolError(missingDbs(DBS_MODELS[quality], installed));
    const { duration: seconds, channels } = p.split ?? {};
    Object.assign(out, { hostPick: pick, ...(device && { device }), ...(installed && { installed: installed.map((m) => (m === DBS_MODELS.best ? "best" : "fast")) }), ...(p.headerChannels && { channels: p.headerChannels }) });
    const mode = dbsChannelsFor((body.tool === "split" || body.tool === "remix" || body.tool === "clean-dialogue") && body.stereo ? "each channel" : "mono", channels);
    if (seconds) out.estimate = (body.tool === "remove-dialogue" ? removeDialogueTime : splitTime)({ seconds, quality, mode, channels, device });
  }
  if (body.tool === "clean") {
    // As Split: the host's device and its RE-USE files (and DBS's, to keep music & effects), asked live for the owner;
    // a visitor's price check never calls a GPU (an account's device is its last status check; the run checks the files).
    const visitor = !!tenant() || !!ownGpu();
    const account = tenantAccount();
    const keep = (p.steps[0]?.request.params?.extra as { background?: string } | undefined)?.background === "keep";
    const [device, installed, dbs] = demo
      ? [undefined, undefined, undefined]
      : visitor
        ? [account ? lastGpuDevice(account) : undefined, undefined, undefined]
        : await Promise.all([comfyDevice().catch(() => undefined), comfyReuseModels().catch(() => undefined), keep ? comfyDbsModels().catch(() => undefined) : undefined]);
    if (installed === null) throw new AudioToolError(NO_REUSE_PACK);
    const model = body.model ?? "voice";
    if (installed && !installed.includes(model)) throw new AudioToolError(missingReuse(model, installed));
    // No DBS file, or (the server answered for RE-USE) no DBS pack at all: refused here, not at the run's validation.
    if (keep && (dbs ? !dbs.length : Array.isArray(installed))) throw new AudioToolError('"Keep music & effects" also needs DBS on your ComfyUI (models/dbs). Copy the install commands from Workflows → "Split a soundtrack", or pick Remove everything but the voice.');
    const { duration: seconds, channels } = p.split ?? {};
    const t = seconds ? planTime({ seconds, quality: body.quality, device, stereo: body.stereo, channels, background: keep ? "keep" : "remove" }) : undefined;
    if (t && !demo) {
      const problem = tooLongProblem(t, device);
      if (problem) throw new AudioToolError(problem);
    }
    Object.assign(out, {
      ...(device && { device }),
      ...(p.headerChannels && { channels: p.headerChannels }),
      reuse: { ...(installed && { installed }), rate: t?.rate ?? planTime({ seconds: 1, quality: body.quality, device }).rate, ...(seconds && { seconds }) },
      ...(t && { estimate: { low: t.low, high: t.high } }),
    });
  }
  return out;
}

/**
 * A planned run's steps as an account's run checks them (src/server/account-tool-run.ts): each request with its chain,
 * and how many earlier steps it waits for.
 */
export function audioToolSteps(p: AudioToolPlan): ToolStep[] {
  return p.steps.map((s) => ({ request: s.chain ? { ...s.request, chain: s.chain } : s.request, deps: s.after?.length ?? 0 }));
}

export type AudioToolRun = { batchId: string; result: Generation; items: Generation[] };

/** Start a run: one batch; the last step's generation is the result. */
export async function runAudioTool(body: AudioToolRequest): Promise<AudioToolRun> {
  return startAudioTool(await plan(body));
}

/** Start a planned run (an account's, after its checks passed: inside asAccount). */
export function startAudioTool(p: AudioToolPlan): AudioToolRun {
  try {
    const run = createPipeline(p.steps.map((s) => ({ key: s.key, request: s.request, ...(s.after && { after: s.after }), ...(s.chain && { chain: s.chain }) })));
    return { batchId: run.batchId, result: run.byKey[p.steps[p.steps.length - 1].key], items: run.items };
  } catch (e) {
    if (e instanceof ConnectComfyError) throw e;
    throw new AudioToolError((e as Error).message);
  }
}
