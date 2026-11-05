import "server-only";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OutputFile } from "@/lib/catalog/types";
import { absolutePath, deleteAsset, getAsset, saveFile } from "./storage";
import { inTurn } from "./account-send";
import { ACCOUNT_LIMITS, accountTotalBytes, accountUsage, diskHasRoom } from "./account-files";
import { hit } from "./rate";

/**
 * The finish every image-to-3D GLB from ComfyUI gets on this server, in two steps:
 *
 * 1. finishModel, while the job still shows as running (seconds): scripts/model3d/finish-glb.mjs sets a
 *    roughness floor by material (read from the baked metallic channel), puts the pivot at the bottom centre
 *    (Pixal3D's origin is off-centre) and writes meshopt geometry + WebP textures at 2048. The result is the
 *    "web GLB" (meta.web on the model output); the raw GLB stays the download. Then the job succeeds.
 * 2. startTurntable, after the job has succeeded: scripts/model3d/render-turntable.mjs renders a 96-frame,
 *    24 fps turntable of the web GLB with <model-viewer> in headless Chromium on SwiftShader (CPU only, never
 *    the GPU), on a studio backdrop, encoded by ffmpeg; plus a poster. It's added to the finished job as a
 *    video output with meta.role "turntable". meta.finish.turntable says where it stands: "queued",
 *    "rendering" (with turntableProgress), "done", "skipped: …" (no Chromium or ffmpeg here: the 3D page
 *    records one in the browser) or "failed: …". A restart picks up the ones still queued or rendering.
 *
 * Both scripts run as child processes (the work is CPU-heavy and must not stall the server's event loop),
 * one turntable at a time, at below-normal priority. Any failure keeps what was made: the raw GLB always.
 *
 * An account's model (public sign-up, made on its own GPU or key) gets step 1 only, under its limits: one account's
 * finish at a time across the server, the file's size, the server's and its files' room, and an hour's finishes
 * (accountFinishProblem). Its browser records the turntable.
 */

/** Bump when the finish changes what it writes. */
export const MODEL_FINISH_VERSION = 2;

const SCRIPTS = path.join(/*turbopackIgnore: true*/ process.cwd(), "scripts", "model3d");
const FINISH_TIMEOUT_MS = 5 * 60_000;
/** The whole render; the script also limits each step (loading the model, each frame, the encode). */
const TURNTABLE_TIMEOUT_MS = 10 * 60_000;
/** How often a render's progress is written to the job (each write reaches every open page). */
const PROGRESS_EVERY_MS = 2_000;

const isGlb = (o: OutputFile) => o.kind === "model3d" && (o.contentType === "model/gltf-binary" || /\.glb(\?|$)/i.test(o.url));

/** Which output a finish works on: the first GLB of an image-to-3D job (or Hi3D's refine of one) from ComfyUI (not a scene, splat or rig). */
export function modelToFinish(r: { provider: string; op: string }, outputs: OutputFile[]): number {
  if (r.provider !== "comfyui" || (r.op !== "image-to-3d" && r.op !== "refine-3d")) return -1;
  return outputs.findIndex((o) => isGlb(o) && !!o.assetId && !o.meta?.finish && !o.meta?.role);
}

export type FinishStats = { material: string; metalFraction: number; roughFloor: number; noMetal: boolean; triangles: number; vertices: number; bytesIn: number; bytesOut: number; ms: number };

/** The last line of a script's stdout that parses as JSON. */
export function lastJsonLine<T>(stdout: string): T | null {
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    try {
      return JSON.parse(line) as T;
    } catch {}
  }
  return null;
}

/** End a script and everything it started (Chromium, ffmpeg). */
function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    // child.kill() ends only node on Windows: Chromium and ffmpeg under it would outlive it.
    const tk = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    tk.on("error", () => child.kill());
    return;
  }
  // The scripts close their browser on SIGTERM (Playwright's exit handler); SIGKILL if that hangs.
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 5_000).unref();
}

type Run = { code: number | null; stdout: string; stderr: string };

/** The only variables finish-glb.mjs and render-turntable.mjs read (and what Node, Chromium and ffmpeg need to start). */
const SCRIPT_ENV = [
  "PATH",
  "Path",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "LANG",
  "FFMPEG_PATH",
  "CHROMIUM_PATH",
  "FUOBE_CHROMIUM",
  "PLAYWRIGHT_BROWSERS_PATH",
];

/**
 * The environment the scripts run with: a short list, never the server's own (its keys, passwords and tokens stay in
 * this process, whatever a model file makes a script do).
 */
export function scriptEnv(): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  for (const k of SCRIPT_ENV) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  env.FUOBE_PARENT_PIPE = "1";
  return env;
}

function runScript(script: string, args: string[], o: { timeoutMs: number; signal: AbortSignal; cwd: string; lowPriority?: boolean; onLine?: (line: string) => void }): Promise<Run> {
  return new Promise((resolve, reject) => {
    if (o.signal.aborted) return reject(new Error("Stopped"));
    // stdin stays open and unused: the script stops when it closes (this server went away). It runs in the job's
    // own temp folder, with a short environment.
    const child = spawn(process.execPath, [path.join(SCRIPTS, script), ...args], {
      cwd: o.cwd,
      env: scriptEnv(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => {});
    if (o.lowPriority && child.pid) {
      // Below the next ComfyUI job (its remesh, decimate and bake use the CPU too); what it starts inherits it.
      try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {}
    }
    let stdout = "";
    let stderr = "";
    let partial = "";
    child.stdout.on("data", (d) => {
      stdout = (stdout + d).slice(-20_000);
      if (!o.onLine) return;
      const lines = (partial + d).split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const line of lines) o.onLine(line);
    });
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4_000)));
    let timedOut = false;
    const kill = () => killTree(child);
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, o.timeoutMs);
    o.signal.addEventListener("abort", kill, { once: true });
    child.on("error", (e) => {
      clearTimeout(timer);
      o.signal.removeEventListener("abort", kill);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      o.signal.removeEventListener("abort", kill);
      if (o.signal.aborted) return reject(new Error("Stopped"));
      if (timedOut) return reject(new Error(`took over ${Math.round(o.timeoutMs / 60_000)} minutes`));
      resolve({ code, stdout, stderr });
    });
  });
}

const tail = (s: string) => s.trim().split(/\r?\n/).slice(-2).join(" | ").slice(0, 300);

/** Remove a temp folder; on Windows a file can stay locked for a moment, and a leftover folder is no reason to fail. */
const removeDir = (dir: string) => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});

declare global {
  var __fuobeModelFinish: Map<string, AbortController> | undefined;
  var __fuobeTurntableQueue: Promise<unknown> | undefined;
}

const running = () => (globalThis.__fuobeModelFinish ??= new Map());

// One turntable render at a time (each keeps every CPU core busy for a minute or two); shared across hot reloads.
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const next = (globalThis.__fuobeTurntableQueue ?? Promise.resolve()).then(fn, fn);
  globalThis.__fuobeTurntableQueue = next.catch(() => {});
  return next;
}

// One finish for accounts (public sign-up) at a time across the server: a model from someone else's ComfyUI waits its
// turn, so many accounts can't keep every CPU core busy at once. The accounts take turns (account-send.ts), so one
// with many models waiting never holds up another's.
const oneAccountAtATime = <T,>(account: string, fn: () => Promise<T>): Promise<T> => inTurn("finish", 1, account, fn);

/** An account's raw GLB over this is kept as it is, with no finish. */
export const ACCOUNT_FINISH_MAX_BYTES = 300 * 2 ** 20;

/**
 * Why an account's model isn't finished on this server (null: it is), by the account's limits. The raw GLB is kept
 * either way, to view and download; only the web GLB is left out.
 * - file size: a raw GLB over ACCOUNT_FINISH_MAX_BYTES;
 * - disk room: the server keeps its free space and the accounts' share (diskHasRoom), and the account's files have room;
 * - an hour's finishes: ACCOUNT_LIMITS.modelFinishesPerHour (counted only for a finish that runs).
 */
export function accountFinishProblem(account: string, rawBytes: number): string | null {
  if (rawBytes > ACCOUNT_FINISH_MAX_BYTES) return "the model is over 300 MB, so it is kept as it is";
  if (!diskHasRoom()) return "the server is short of room, so the model is kept as it is";
  if (accountUsage(account).total >= accountTotalBytes(account)) return "the account's files are full, so the model is kept as it is";
  if (!hit(`finish3d:${account}`, ACCOUNT_LIMITS.modelFinishesPerHour, 60 * 60_000).ok) return "this hour's finishes are used up, so the model is kept as it is";
  return null;
}

/** Whether an account's files have room for a finished file of this size (its web GLB). */
const accountHasRoomFor = (account: string, bytes: number) => accountUsage(account).total + bytes <= accountTotalBytes(account);

/** What an account's finished model says of its turntable: none on the server; the 3D page records one in the browser. */
export const ACCOUNT_TURNTABLE = "skipped: record it in your browser";
/** A job that came with an orbit clip of its splat keeps it as the turntable. */
export const OWN_ORBIT = "skipped: the job's own orbit clip";

/**
 * Step 1 (see the header): the web GLB. Returns the outputs to store: the model output with meta.web and
 * meta.finish (turntable "queued" when there's a web GLB to render).
 */
export async function finishModel(
  generationId: string,
  outputs: OutputFile[],
  o: { op: string; provider: string; onMessage?: (m: string) => void; signal?: AbortSignal; account?: string },
): Promise<OutputFile[]> {
  const signal = o.signal ?? new AbortController().signal;
  const i = modelToFinish(o, outputs);
  if (i < 0) return outputs;
  const mesh = outputs[i];
  const asset = getAsset(mesh.assetId!);
  if (!asset) return outputs;
  const raw = absolutePath(asset.relPath);
  const finish: Record<string, unknown> = { version: MODEL_FINISH_VERSION };
  const meta: Record<string, unknown> = { ...mesh.meta };
  // An account's model is finished under its own limits (accountFinishProblem), or kept as it came.
  const problem = o.account ? accountFinishProblem(o.account, asset.size) : null;
  if (problem) {
    finish.error = `web GLB: ${problem}`;
    return outputs.map((x, j) => (j === i ? { ...mesh, meta: { ...meta, finish } } : x));
  }
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fuobe-3d-"));
  try {
    o.onMessage?.("Finishing the 3D model");
    const webFile = path.join(tmp, "web.glb");
    let stats: FinishStats | null = null;
    try {
      // An account's model: below the server's own work, one thread for its pictures, their sizes checked first.
      const run = await runScript("finish-glb.mjs", ["--in", raw, "--out", webFile, ...(o.account ? ["--limits", "account"] : [])], {
        timeoutMs: FINISH_TIMEOUT_MS,
        signal,
        cwd: tmp,
        lowPriority: !!o.account,
      });
      stats = run.code === 0 && fs.existsSync(webFile) ? lastJsonLine<FinishStats>(run.stdout) : null;
      if (!stats) finish.error = `web GLB: ${tail(run.stderr) || `exit ${run.code}`}`;
      // An account's web GLB is one of its files: stored only while the server and its files have room for it.
      else if (o.account && (!diskHasRoom() || !accountHasRoomFor(o.account, fs.statSync(webFile).size))) {
        stats = null;
        finish.error = "web GLB: no room for it in the account's files, so the model is kept as it is";
      }
    } catch (e) {
      if (signal.aborted) throw e;
      finish.error = `web GLB: ${(e as Error).message}`;
    }
    if (stats) {
      const web = saveFile({ data: await fs.promises.readFile(webFile), contentType: "model/gltf-binary", name: "model-web.glb", source: "derived", generationId });
      meta.web = web.url;
      Object.assign(finish, { material: stats.material, triangles: stats.triangles, rawBytes: stats.bytesIn, webBytes: stats.bytesOut, webAsset: web.id, turntable: turntableState(outputs, o.account) });
    }
  } finally {
    await removeDir(tmp);
  }
  if (finish.error) console.warn(`[fuobe] 3D finish for ${generationId}: ${finish.error}`);
  return outputs.map((x, j) => (j === i ? { ...mesh, meta: { ...meta, finish } } : x));
}

/** The turntable step a finished model gets: none when the job brought its own orbit clip (Photo to 3D), none on an account (its browser records one), else queued. */
export function turntableState(outputs: OutputFile[], account?: string): string {
  if (outputs.some((x) => x.kind === "video" && x.meta?.role === "orbit")) return OWN_ORBIT;
  return account ? ACCOUNT_TURNTABLE : "queued";
}

/** Whether this process is finishing that job (either step) right now. */
export function finishing(generationId: string): boolean {
  return running().has(generationId);
}

/**
 * Run finishModel (step 1) in the background, once per job, then `done` with the outputs to store. The job's
 * row stays "running" meanwhile; a restart picks it up again from the stored outputs. Not called after a stop.
 */
export function startModelFinish(
  generationId: string,
  outputs: OutputFile[],
  o: { op: string; provider: string; onMessage?: (m: string) => void; done: (outputs: OutputFile[]) => void; account?: string },
): void {
  if (finishing(generationId)) return;
  const ctl = new AbortController();
  running().set(generationId, ctl);
  const run = () => (ctl.signal.aborted ? Promise.reject(new Error("Stopped")) : finishModel(generationId, outputs, { ...o, signal: ctl.signal }));
  // An account's finish waits for the one before it (oneAccountAtATime).
  void (o.account ? oneAccountAtATime(o.account, run) : run())
    .catch((e) => {
      if (ctl.signal.aborted) return null;
      console.warn(`[fuobe] 3D finish for ${generationId} failed: ${(e as Error).message}`);
      return outputs;
    })
    .then((out) => {
      if (running().get(generationId) === ctl) running().delete(generationId);
      if (out && !ctl.signal.aborted) o.done(out);
    });
}

/** Stop a finish or a turntable render (the job was canceled or deleted). */
export function stopModelFinish(generationId: string): void {
  running().get(generationId)?.abort();
  running().delete(generationId);
}

// ---------------------------------------------------------------------------
// Step 2: the turntable, after the job has succeeded.

/** Where a finished job's outputs live: what they are now (null once the job is gone), and storing them. */
export interface OutputStore {
  read(): OutputFile[] | null;
  write(outputs: OutputFile[]): void;
}

const turntableOf = (o: OutputFile) => (o.meta?.finish as { turntable?: unknown } | undefined)?.turntable;

/** The model output whose turntable is still to be rendered (queued, or rendering when the server stopped), or -1. */
export function pendingTurntable(outputs: OutputFile[]): number {
  return outputs.findIndex((o) => o.kind === "model3d" && (turntableOf(o) === "queued" || turntableOf(o) === "rendering"));
}

/**
 * The outputs with the turntable's state on the model output (`assetId`): meta.finish.turntable (+ progress
 * while rendering), the poster, and the video, which replaces a turntable the job brought itself (an old graph).
 */
export function withTurntable(outputs: OutputFile[], assetId: string, r: { state: string; progress?: number; video?: OutputFile; poster?: string }): OutputFile[] {
  const i = outputs.findIndex((o) => o.kind === "model3d" && o.assetId === assetId);
  if (i < 0) return outputs;
  const mesh = outputs[i];
  const finish: Record<string, unknown> = { ...(mesh.meta?.finish as Record<string, unknown> | undefined), turntable: r.state };
  if (r.progress !== undefined) finish.turntableProgress = r.progress;
  else delete finish.turntableProgress;
  const next = outputs.map((o, j) => (j === i ? { ...mesh, meta: { ...mesh.meta, ...(r.poster ? { poster: r.poster } : {}), finish } } : o));
  return r.video ? [...next.filter((o) => !(o.kind === "video" && o.meta?.role === "turntable")), r.video] : next;
}

/** Render the turntable of a finished job whose model output has one queued (step 2), in the background. */
export function startTurntable(generationId: string, store: OutputStore): void {
  if (finishing(generationId)) return;
  const outputs = store.read();
  const i = outputs ? pendingTurntable(outputs) : -1;
  if (i < 0) return;
  const ctl = new AbortController();
  running().set(generationId, ctl);
  void renderTurntable(generationId, outputs![i], store, ctl)
    .catch((e) => {
      if (!ctl.signal.aborted) console.warn(`[fuobe] 3D turntable for ${generationId} failed: ${(e as Error).message}`);
    })
    .finally(() => {
      if (running().get(generationId) === ctl) running().delete(generationId);
    });
}

async function renderTurntable(generationId: string, mesh: OutputFile, store: OutputStore, ctl: AbortController): Promise<void> {
  const { signal } = ctl;
  const assetId = mesh.assetId!;
  const finish = (mesh.meta?.finish ?? {}) as { webAsset?: string; material?: string };
  /** Store the turntable's state; false (and stop) once the job is gone. */
  const set = (r: Parameters<typeof withTurntable>[2]) => {
    const now = store.read();
    if (!now) {
      ctl.abort();
      return false;
    }
    store.write(withTurntable(now, assetId, r));
    return true;
  };
  const web = finish.webAsset ? getAsset(finish.webAsset) : null;
  if (!web) return void set({ state: "failed: the web GLB is missing" });
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fuobe-turntable-"));
  try {
    const video = path.join(tmp, "turntable.mp4");
    const posterFile = path.join(tmp, "poster.webp");
    let run: Run;
    try {
      run = await oneAtATime(() => {
        if (signal.aborted || !set({ state: "rendering", progress: 0 })) throw new Error("Stopped");
        let last = Date.now();
        return runScript("render-turntable.mjs", ["--glb", absolutePath(web.relPath), "--out", video, "--poster", posterFile, "--material", finish.material ?? "auto"], {
          timeoutMs: TURNTABLE_TIMEOUT_MS,
          signal,
          cwd: tmp,
          lowPriority: true,
          // "frame 12/96" after each frame.
          onLine: (line) => {
            const m = /^frame (\d+)\/(\d+)$/.exec(line.trim());
            if (!m || Date.now() - last < PROGRESS_EVERY_MS) return;
            last = Date.now();
            set({ state: "rendering", progress: Math.round((Number(m[1]) / Number(m[2])) * 100) / 100 });
          },
        });
      });
    } catch (e) {
      if (signal.aborted) return;
      set({ state: `failed: ${(e as Error).message}` });
      return;
    }
    if (run.code !== 0 || !fs.existsSync(video)) {
      // Exit 3: no Chromium or ffmpeg here; the 3D page records a turntable in the browser instead.
      const state = run.code === 3 ? `skipped: ${tail(run.stderr)}` : `failed: ${tail(run.stderr) || `exit ${run.code}`}`;
      if (run.code !== 3) console.warn(`[fuobe] 3D turntable for ${generationId}: ${state}`);
      set({ state });
      return;
    }
    if (!store.read()) return;
    const clip = saveFile({ data: await fs.promises.readFile(video), contentType: "video/mp4", name: "turntable.mp4", source: "generation", generationId });
    const poster = fs.existsSync(posterFile) ? saveFile({ data: await fs.promises.readFile(posterFile), contentType: "image/webp", name: "poster.webp", source: "derived", generationId }) : null;
    const stored = set({
      state: "done",
      video: { url: clip.url, kind: "video", contentType: clip.contentType, assetId: clip.id, meta: { role: "turntable", fps: 24, frames: 96 } },
      poster: poster?.url,
    });
    // Deleted while the files were saved: nothing points at them.
    if (!stored) for (const a of [clip, poster]) if (a) deleteAsset(a.id);
  } finally {
    await removeDir(tmp);
  }
}
