/**
 * A ComfyUI stand-in for "Use the ComfyUI on this computer": what the Fuobe tab talks to on 127.0.0.1. It behaves like
 * ComfyUI 0.42 where it matters: without the cross-site setting it answers 403 to another site's requests (its
 * origin_only_middleware); with it, it sends the CORS headers for that one origin (or every origin) and answers
 * OPTIONS. It takes uploads under the name given, prompts with a client's prompt_id and preview_method, runs one job at
 * a time (progress steps and preview frames on /ws), keeps a history, cancels jobs (/api/jobs, or /queue and
 * /interrupt on an older one), and serves result files. It can refuse a prompt (a missing node or model), run out of
 * memory, restart (losing its queue and history), stop and come back. Every request is logged.
 *
 *   node tests/helpers/fake-local-comfy.ts --port 3371 --cors http://127.0.0.1:3370
 *
 * Runs under plain Node too: only erasable TypeScript.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
// @ts-expect-error -- plain Node (the review harness) needs the extension; the bundler resolution allows none.
import { isLiveGraph, liveModelSize, pictureSize, renderLive, type LiveRender } from "./fake-live.ts";
// @ts-expect-error -- as above.
import { LIVE_NODES_SHA256, LIVE_NODES_VERSION } from "../../src/lib/comfy-live-nodes.ts";

export interface LocalComfyOptions {
  /** "off": ComfyUI's own check (other sites get 403); an origin, or "*". */
  cors: string;
  version?: string;
  /** /api/jobs exists (ComfyUI 0.42 and later). */
  jobsApi?: boolean;
  /** /prompt honours a client's prompt_id (else it mints its own, as older ComfyUI does). */
  clientPromptId?: boolean;
  /** Before a job starts, and between its steps. */
  latencyMs?: number;
  stepMs?: number;
  steps?: number;
  /** What the next prompt does. */
  failNext?: "oom" | "missing_node" | "missing_model" | "gone" | "never";
  /** Lose this many prompts in a row (taken, then gone: a restart while it waited). */
  loseNext?: number;
  /** What a job saves (default: what its save node makes: a clip, a sound, else a picture). "fake-png" is a web page named .png. */
  outputs?: ("image" | "video" | "audio" | "exr" | "text" | "fake-png")[];
  /** VHS meta-batch: the job finishes without outputs and queues this many more passes (the last one saves the clip). */
  metaBatch?: number;
  /** Embedded Python (portable / Easy-Install). */
  portable?: boolean;
  loras?: string[];
  /** Fuobe's guard is in its custom nodes (it answers GET /fuobe/guard). */
  guard?: boolean;
  /**
   * Fuobe Connect is in its custom nodes, trusting this origin: that origin gets CORS (with no start setting), every
   * other site still meets ComfyUI's own check, and GET /fuobe/connect answers.
   */
  connect?: string;
  /**
   * Everything a requirement index names is installed (the studio's workflows/comfyui/requirements.json): its node
   * classes, with the loaders listing its files, and its model files. Without it, this ComfyUI has nothing.
   */
  has?: IndexLike;
  /**
   * Live edit (graphs with SaveImageFuobeLive, tests/helpers/fake-live.ts): each of the 2 steps takes this long at
   * 512 x 512, scaled by the model's area. Unset: stepMs.
   */
  stepMsAt512?: number;
  /** Live renders get a lossy round trip over the whole frame (noise and a slight blur), as a VAE's would. */
  lossy?: boolean;
  /** The live nodes aren't installed (object_info leaves out the *FuobeLive classes; /fuobe/live is 404). */
  noLiveNodes?: boolean;
  /**
   * An old copy of the live nodes (version 1): /fuobe/live answers no hash, and its save node has no IS_CHANGED, so a
   * graph identical to the last one is served from ComfyUI's cache: no picture, only execution_cached, executed and
   * execution_success.
   */
  oldLiveNodes?: boolean;
  /** Nothing ever starts: prompts wait in the queue (a stuck ComfyUI). */
  stall?: boolean;
}

/** One live render the stand-in made (for the bookkeeping checks). */
export interface LiveRenderLog extends Omit<LiveRender, "data"> {
  id: string;
  clientId?: string;
  sha256: string;
  bytes: Buffer;
  ms: number;
}

/** The parts of a requirement index (src/lib/gpu/types.ts) the stand-in reads. */
export interface IndexLike {
  folders: string[];
  files: Record<string, { folder: string; file: string; listFolder?: string; sizeBytes?: number; presence?: string; loaders?: [string, string][] }>;
  workflows: Record<string, { core: string[]; packs: Record<string, string[]> }>;
}

const made = new WeakMap<IndexLike, ReturnType<typeof install>>();
/** /object_info and the model folders of a ComfyUI that has everything in `idx`. */
const installed = (idx: IndexLike) => made.get(idx) ?? made.set(idx, install(idx)).get(idx)!;
function install(idx: IndexLike) {
  const info: Record<string, { input: { required: Record<string, unknown[]> } }> = {};
  const node = (cls: string) => (info[cls] ??= { input: { required: {} } });
  for (const w of Object.values(idx.workflows)) {
    for (const c of w.core) node(c);
    for (const cs of Object.values(w.packs)) for (const c of cs) node(c);
  }
  const folders = new Map<string, { name: string; size: number }[]>(idx.folders.map((f) => [f, []]));
  for (const f of Object.values(idx.files)) {
    // A pack's folder is listed under the name the pack registers it as (kandinsky6: audio_vae as kandinsky6_audio_vae).
    const listed = f.listFolder ?? f.folder;
    if (!folders.has(listed)) folders.set(listed, []);
    folders.get(listed)!.push({ name: f.file, size: f.sizeBytes ?? 1 });
    if (f.presence === "loader") for (const [cls, input] of f.loaders ?? []) ((node(cls).input.required[input] ??= [[]])[0] as string[]).push(f.file);
  }
  return { info, folders };
}

export interface LocalComfyLog {
  method: string;
  path: string;
  origin?: string;
  status?: number;
  at?: number;
  upload?: { name: string; bytes: Buffer };
  prompt?: { prompt_id?: string; prompt?: Record<string, { class_type: string; inputs: Record<string, unknown> }>; extra_data?: Record<string, unknown>; client_id?: string; front?: boolean };
  /** POST /queue, /interrupt and /history: what it asked. */
  body?: unknown;
}

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
interface Job {
  id: string;
  number: number;
  graph: Graph;
  clientId?: string;
  preview: boolean;
  fail?: LocalComfyOptions["failNext"];
  pass?: number;
  /** Another client's long job (foreign): how long it runs. */
  ms?: number;
}
type Entry = { prompt: unknown[]; outputs: Record<string, Record<string, unknown>>; status: { status_str: string; completed: boolean; messages: [string, Record<string, unknown>][] } };

export interface LocalComfy {
  port: number;
  url: string;
  opts: LocalComfyOptions;
  log: LocalComfyLog[];
  inputs: Map<string, Buffer>;
  history: Map<string, Entry>;
  /** Prompts posted (a resumed task must not post twice). */
  posts: () => number;
  /** ComfyUI restarted: its queue, history and sockets are gone, the inputs folder stays (unless wipeInputs). */
  restart: (o?: Partial<LocalComfyOptions> & { wipeInputs?: boolean }) => void;
  /** Queue a long job from another client (someone else's run on the same GPU). */
  foreign: (ms: number) => string;
  /** Live renders made, in order. */
  renders: LiveRenderLog[];
  /** Stop listening (ComfyUI closed), and start again on the same port. */
  stop: () => Promise<void>;
  start: (o?: Partial<LocalComfyOptions>) => Promise<void>;
  close: () => Promise<void>;
}

/** The ports a stand-in takes when none is given. */
export const TEST_PORTS = [3360, 3399] as const;
let nextPort = 0;

export const FAKE_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000200000002080600000072b60d240000001149444154789c63381150f11f8419600c005a940a3db632c1b20000000049454e44ae426082",
  "hex",
);
export const FAKE_MP4 = Buffer.concat([Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex"), Buffer.alloc(64, 1)]);
const FAKE_WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.from([36, 0, 0, 0]), Buffer.from("WAVEfmt "), Buffer.alloc(64, 0)]);
const FAKE_EXR = Buffer.concat([Buffer.from("762f3101", "hex"), Buffer.alloc(60, 2)]);

/** The parts of a multipart body: field name â†’ {filename?, data}. */
function multipart(body: Buffer, contentType: string): Map<string, { filename?: string; data: Buffer }> {
  const out = new Map<string, { filename?: string; data: Buffer }>();
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  if (!boundary) return out;
  const marker = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  let at = body.indexOf(marker);
  while (at >= 0) {
    const next = body.indexOf(marker, at + marker.length);
    if (next < 0) break;
    const part = body.subarray(at + marker.length + 2, next - 2);
    const headEnd = part.indexOf("\r\n\r\n");
    if (headEnd >= 0) {
      const head = part.subarray(0, headEnd).toString("utf8");
      const name = /name="([^"]+)"/.exec(head)?.[1];
      const filename = /filename="([^"]*)"/.exec(head)?.[1];
      if (name) out.set(name, { filename, data: part.subarray(headEnd + 4) });
    }
    at = next;
  }
  return out;
}

/** A WebSocket frame from the server (never masked). */
function frame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  return Buffer.concat([head, payload]);
}

export function startLocalComfy(given: LocalComfyOptions, port = 0): Promise<LocalComfy> {
  const opts: LocalComfyOptions = { version: "0.42.0", jobsApi: true, clientPromptId: true, latencyMs: 30, stepMs: 20, steps: 4, ...given };
  const log: LocalComfyLog[] = [];
  const inputs = new Map<string, Buffer>();
  const history = new Map<string, Entry>();
  let queue: Job[] = [];
  let running: Job | null = null;
  let number = 0;
  let posts = 0;
  let timer: NodeJS.Timeout | undefined;
  const sockets = new Map<string, Set<Duplex>>();
  const renders: LiveRenderLog[] = [];
  let lastLive: { graph: string; ui: Record<string, unknown> } | undefined;
  const temps = new Map<string, { data: Buffer; type: string }>();
  const sizes = new Map<string, { w: number; h: number }>();
  let server: http.Server;
  let generation = 0;

  const send = (clientId: string | undefined, payload: Buffer, binary = false) => {
    for (const [id, set] of sockets) if (!clientId || id === clientId) for (const s of set) s.write(frame(binary ? 2 : 1, payload));
  };
  const event = (clientId: string | undefined, type: string, data: Record<string, unknown>) => send(clientId, Buffer.from(JSON.stringify({ type, data })));
  const status = () => event(undefined, "status", { status: { exec_info: { queue_remaining: queue.length + (running ? 1 : 0) } } });

  /** What a graph's save node makes. */
  const madeBy = (g: Graph): NonNullable<LocalComfyOptions["outputs"]> => {
    const classes = Object.values(g).map((n) => n.class_type);
    if (classes.some((c) => /VHS_VideoCombine|SaveVideo|SaveWEBM|CreateVideo|SaveAnimated/.test(c))) return ["video"];
    if (classes.some((c) => /SaveAudio/.test(c))) return ["audio"];
    return ["image"];
  };
  const outputNode = (g: Graph) => Object.keys(g).find((k) => /^(Save|VHS_VideoCombine|PreviewImage|CreateVideo)/.test(g[k].class_type)) ?? "9";
  const prefixOf = (g: Graph) => String(Object.values(g).find((n) => typeof n.inputs?.filename_prefix === "string")?.inputs.filename_prefix ?? "ComfyUI");

  function outputsFor(job: Job): Record<string, Record<string, unknown>> {
    const node = outputNode(job.graph);
    const prefix = prefixOf(job.graph);
    const sub = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "";
    const base = prefix.split("/").pop();
    const ui: Record<string, unknown[]> = {};
    const add = (key: string, ext: string, i: number) => (ui[key] ??= []).push({ filename: `${base}_${String(i + 1).padStart(5, "0")}_.${ext}`, subfolder: sub, type: "output" });
    (opts.outputs ?? madeBy(job.graph)).forEach((k, i) => {
      if (k === "image" || k === "fake-png") add("images", "png", i);
      else if (k === "video") add("gifs", "mp4", i);
      else if (k === "audio") add("audio", "wav", i);
      else if (k === "exr") add("images", "exr", i);
      else if (k === "text") add("text_files", "txt", i);
    });
    return { [node]: ui };
  }

  function finish(job: Job, entry: Entry) {
    history.set(job.id, entry);
    running = null;
    tick();
  }

  function runLive(job: Job) {
    running = job;
    const gen = generation;
    const alive = () => gen === generation && running === job;
    const started = Date.now();
    const same = lastLive !== undefined && lastLive.graph === JSON.stringify(job.graph);
    if (same && opts.oldLiveNodes) {
      // ComfyUI's cache: every node, the save node included, is served from the last run. No picture is sent.
      const ui = lastLive!.ui;
      event(job.clientId, "execution_start", { prompt_id: job.id });
      event(job.clientId, "execution_cached", { nodes: Object.keys(job.graph), prompt_id: job.id });
      event(job.clientId, "executed", { node: "90", prompt_id: job.id, output: ui });
      event(job.clientId, "executing", { node: null, prompt_id: job.id });
      event(job.clientId, "execution_success", { prompt_id: job.id });
      timer = setTimeout(() => alive() && finish(job, { prompt: [job.number, job.id, job.graph, {}, []], outputs: { "90": ui }, status: { status_str: "success", completed: true, messages: [["execution_success", { prompt_id: job.id }]] } }), 1);
      return;
    }
    event(job.clientId, "execution_start", { prompt_id: job.id });
    event(job.clientId, "executing", { node: "32", prompt_id: job.id });
    const size = liveModelSize(job.graph, (n) => sizes.get(n) ?? null);
    const stepMs = (opts.stepMsAt512 ?? opts.stepMs ?? 20) * ((size.w * size.h) / (512 * 512));
    let step = 0;
    const fail = (message: string, nodeType: string, node = "10") => {
      const err = { prompt_id: job.id, node_id: node, node_type: nodeType, exception_message: message, exception_type: "ValueError" };
      event(job.clientId, "execution_error", err);
      finish(job, { prompt: [job.number, job.id, job.graph, {}, []], outputs: {}, status: { status_str: "error", completed: false, messages: [["execution_error", err]] } });
    };
    const next = () => {
      if (!alive()) return;
      if (step < 2) {
        step++;
        event(job.clientId, "progress", { value: step, max: 2, prompt_id: job.id, node: "32" });
        timer = setTimeout(next, stepMs);
        return;
      }
      renderLive(job.graph, inputs, { lossy: opts.lossy }).then(
        (r) => {
          if (!alive()) return;
          const to = job.graph["90"]?.inputs?.to;
          const sha256 = createHash("sha256").update(r.data).digest("hex");
          const { data, ...rest } = r;
          renders.push({ ...rest, id: job.id, clientId: job.clientId, sha256, bytes: data, ms: Date.now() - started });
          let ui: Record<string, unknown>;
          if (to === "socket" && job.clientId && sockets.get(job.clientId)?.size) {
            const meta = Buffer.from(JSON.stringify({ prompt_id: job.id, node_id: "90", image_type: r.type, width: r.width, height: r.height, fuobe_live: 1 }));
            const len = Buffer.alloc(4);
            len.writeUInt32BE(meta.length);
            send(job.clientId, Buffer.concat([Buffer.from([0, 0, 0, 4]), len, meta, data]), true);
            ui = { fuobe_live: [{ sent: true, width: r.width, height: r.height }] };
          } else {
            const name = `fuobe_live_${job.number}.${r.type === "image/png" ? "png" : "webp"}`;
            temps.set(name, { data, type: r.type });
            ui = { images: [{ filename: name, subfolder: "", type: "temp" }] };
          }
          lastLive = { graph: JSON.stringify(job.graph), ui };
          event(job.clientId, "executed", { node: "90", prompt_id: job.id, output: ui });
          event(job.clientId, "executing", { node: null, prompt_id: job.id });
          event(job.clientId, "execution_success", { prompt_id: job.id });
          finish(job, { prompt: [job.number, job.id, job.graph, {}, []], outputs: { "90": ui }, status: { status_str: "success", completed: true, messages: [["execution_success", { prompt_id: job.id }]] } });
        },
        (e: Error & { nodeType?: string; node?: string }) => {
          if (alive()) fail(e.message, e.nodeType ?? "SaveImageFuobeLive", e.node);
        },
      );
    };
    timer = setTimeout(next, opts.latencyMs);
  }

  function run(job: Job) {
    if (isLiveGraph(job.graph)) return runLive(job);
    running = job;
    const gen = generation;
    const alive = () => gen === generation && running === job;
    const steps = opts.steps ?? 4;
    const stepMs = job.ms !== undefined ? job.ms / steps : opts.stepMs;
    const node = Object.keys(job.graph).find((k) => /KSampler|Sampler/.test(job.graph[k].class_type)) ?? Object.keys(job.graph)[0] ?? "1";
    event(job.clientId, "execution_start", { prompt_id: job.id });
    event(job.clientId, "executing", { node, prompt_id: job.id });
    let step = 0;
    const next = () => {
      if (!alive()) return;
      if (job.fail === "never") return;
      if (step < steps) {
        step++;
        event(job.clientId, "progress", { value: step, max: steps, prompt_id: job.id, node });
        if (job.preview) {
          const meta = Buffer.from(JSON.stringify({ prompt_id: job.id, node_id: node, image_type: "image/png" }));
          const len = Buffer.alloc(4);
          len.writeUInt32BE(meta.length);
          send(job.clientId, Buffer.concat([Buffer.from([0, 0, 0, 4]), len, meta, FAKE_PNG]), true);
        }
        timer = setTimeout(next, stepMs);
        return;
      }
      if (job.fail === "oom") {
        const err = { prompt_id: job.id, node_id: node, node_type: "KSampler", exception_message: "Allocation on device 0 would exceed allowed memory. (out of memory)", exception_type: "torch.OutOfMemoryError" };
        event(job.clientId, "execution_error", err);
        return finish(job, { prompt: [job.number, job.id, job.graph, {}, []], outputs: {}, status: { status_str: "error", completed: false, messages: [["execution_error", err]] } });
      }
      // A meta-batch's first passes save nothing and queue the next pass (a new prompt id, the same prefix).
      const passes = opts.metaBatch ?? 0;
      const pass = job.pass ?? 1;
      const outputs = passes && pass < passes ? {} : outputsFor(job);
      if (passes && pass < passes) queue.unshift({ ...job, id: randomUUID(), number: -++number, pass: pass + 1, preview: false });
      event(job.clientId, "executed", { node: outputNode(job.graph), prompt_id: job.id, output: outputs[outputNode(job.graph)] ?? {} });
      event(job.clientId, "executing", { node: null, prompt_id: job.id });
      event(job.clientId, "execution_success", { prompt_id: job.id });
      finish(job, { prompt: [job.number, job.id, job.graph, {}, []], outputs, status: { status_str: "success", completed: true, messages: [["execution_success", { prompt_id: job.id }]] } });
    };
    timer = setTimeout(next, opts.latencyMs);
  }

  function tick() {
    status();
    if (running || !queue.length || opts.stall) return;
    const job = queue.shift()!;
    run(job);
  }

  const jobStatus = (id: string) => {
    if (running?.id === id) return { id, status: "in_progress" };
    if (queue.some((j) => j.id === id)) return { id, status: "pending" };
    const h = history.get(id);
    if (h) return { id, status: h.status.status_str === "success" ? "completed" : "failed", outputs_count: Object.keys(h.outputs).length };
    return null;
  };

  const cancel = (id: string) => {
    if (running?.id === id) {
      event(running.clientId, "execution_interrupted", { prompt_id: id });
      history.set(id, { prompt: [running.number, id, running.graph, {}, []], outputs: {}, status: { status_str: "error", completed: false, messages: [["execution_interrupted", { prompt_id: id }]] } });
      running = null;
      clearTimeout(timer);
      tick();
      return true;
    }
    const before = queue.length;
    queue = queue.filter((j) => j.id !== id);
    return queue.length < before;
  };

  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://fake");
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
      const entry: LocalComfyLog = { method: req.method ?? "GET", path: url.pathname + url.search, at: Date.now(), ...(origin && { origin }) };
      log.push(entry);
      const headers: Record<string, string> = {};
      if (opts.cors === "off" && opts.connect && origin === opts.connect) {
        Object.assign(headers, { "Access-Control-Allow-Origin": opts.connect, Vary: "Origin", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type" });
        if (req.headers["access-control-request-private-network"] === "true") headers["Access-Control-Allow-Private-Network"] = "true";
      } else if (opts.cors !== "off") {
        Object.assign(headers, {
          "Access-Control-Allow-Origin": opts.cors,
          "Access-Control-Allow-Methods": "POST, GET, DELETE, PUT, OPTIONS, PATCH",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Allow-Credentials": "true",
        });
      } else {
        // ComfyUI's origin_only_middleware: another site's request, or an Origin that isn't this host.
        const site = req.headers["sec-fetch-site"];
        const host = String(req.headers.host ?? "");
        const otherOrigin = origin && new URL(origin).host !== host;
        if (site === "cross-site" || otherOrigin) {
          entry.status = 403;
          res.writeHead(403);
          return res.end();
        }
      }
      const reply = (code: number, value: unknown, type = "application/json") => {
        entry.status = code;
        res.writeHead(code, { ...headers, "content-type": type });
        res.end(Buffer.isBuffer(value) ? value : JSON.stringify(value));
      };
      if (req.method === "OPTIONS") return reply(200, "");
      // The stand-in's own count, for a test driving it from another process (never a ComfyUI route).
      if (url.pathname === "/__fake/stats") return reply(200, { posts, uploads: inputs.size, history: history.size, pid: process.pid });
      const p = url.pathname;
      if (p === "/system_stats" || p === "/api/system_stats") {
        const argv = ["main.py", ...(opts.cors === "off" ? [] : ["--enable-cors-header", opts.cors]), "--base-directory", "C:\\Users\\someone\\private"];
        return reply(200, {
          system: { os: "nt", comfyui_version: opts.version, ram_total: 64 * 2 ** 30, embedded_python: !!opts.portable, argv, python_version: "3.12" },
          devices: [{ name: "cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync", type: "cuda", vram_total: 32 * 2 ** 30 }],
        });
      }
      // No list given: an older ComfyUI without the route (the run goes ahead, and ComfyUI has the last word).
      if (p === "/models/loras") return opts.loras ? reply(200, opts.loras) : reply(404, { error: "not found" });
      if (p === "/fuobe/guard") return opts.guard ? reply(200, { guard: 1 }) : reply(404, { error: "not found" });
      if (p === "/fuobe/connect") return opts.connect ? reply(200, { connect: 1, version: "1.0.0", guard: 1 }) : reply(404, { error: "not found" });
      const has = opts.has ? installed(opts.has) : null;
      const liveNodes = !!has?.info.SaveImageFuobeLive && !opts.noLiveNodes;
      if (p === "/fuobe/live") return liveNodes ? reply(200, opts.oldLiveNodes ? { version: 1 } : { version: LIVE_NODES_VERSION, sha256: LIVE_NODES_SHA256 }) : reply(404, { error: "not found" });
      if (p === "/models") return reply(200, has ? [...has.folders.keys()] : ["checkpoints", "loras", "vae"]);
      if (p.startsWith("/models/")) return reply(200, (has?.folders.get(decodeURIComponent(p.slice(8))) ?? []).map((f) => f.name));
      if (p.startsWith("/experiment/models/") && has) {
        const files = has.folders.get(decodeURIComponent(p.slice(19)));
        return files ? reply(200, files.map((f) => ({ name: f.name, pathIndex: 0, size: f.size }))) : reply(404, { error: "not found" });
      }
      const hidden = (cls: string) => !!opts.noLiveNodes && /FuobeLive$/.test(cls);
      if (p === "/object_info") return reply(200, Object.fromEntries(Object.entries(has?.info ?? {}).filter(([c]) => !hidden(c))));
      if (p.startsWith("/object_info/")) {
        const cls = decodeURIComponent(p.slice(13));
        return reply(200, has?.info[cls] && !hidden(cls) ? { [cls]: has.info[cls] } : {});
      }
      if (p === "/embeddings") return reply(200, []);
      if (p === "/upload/image" && req.method === "POST") {
        const parts = multipart(body, String(req.headers["content-type"] ?? ""));
        const image = parts.get("image");
        const name = image?.filename ?? "";
        if (!image || !name || /[\\/]|\.\./.test(name)) return reply(400, { error: "bad name" });
        inputs.set(name, Buffer.from(image.data));
        entry.upload = { name, bytes: Buffer.from(image.data) };
        void pictureSize(Buffer.from(image.data)).then((sz) => sz && sizes.set(name, sz));
        return reply(200, { name, subfolder: "", type: parts.get("type")?.data.toString() ?? "input" });
      }
      if (p === "/prompt" && req.method === "POST") {
        let json: LocalComfyLog["prompt"] & { prompt?: Graph };
        try {
          json = JSON.parse(body.toString("utf8"));
        } catch {
          return reply(400, { error: { type: "invalid_prompt", message: "not json" } });
        }
        entry.prompt = json;
        posts++;
        const fail = opts.failNext;
        opts.failNext = undefined;
        if (fail === "missing_node") {
          return reply(400, {
            error: { type: "missing_node_type", message: "Node 'FancyNode' not found. The custom node may not be installed.", details: "Node ID '#3'", extra_info: { node_id: "3", class_type: "FancyNode", node_title: "FancyNode" } },
            node_errors: {},
          });
        }
        if (fail === "missing_model") {
          const [id, n] = Object.entries(json.prompt ?? {}).find(([, v]) => /Loader/.test(v.class_type)) ?? ["1", { class_type: "CheckpointLoaderSimple", inputs: {} }];
          const [input, value] = Object.entries(n.inputs).find(([k]) => /name/.test(k)) ?? ["ckpt_name", "model.safetensors"];
          return reply(400, {
            error: { type: "prompt_outputs_failed_validation", message: "Prompt outputs failed validation", details: "", extra_info: {} },
            node_errors: { [id]: { errors: [{ type: "value_not_in_list", message: "Value not in list", details: `${input}: '${value}' not in []`, extra_info: { input_name: input, received_value: value } }], dependent_outputs: [], class_type: n.class_type } },
          });
        }
        const id = opts.clientPromptId && typeof json.prompt_id === "string" ? json.prompt_id : randomUUID();
        if (opts.loseNext && opts.loseNext > 0) {
          opts.loseNext--;
          return reply(200, { prompt_id: id, number: ++number, node_errors: {} });
        }
        if (fail === "gone") return reply(200, { prompt_id: id, number: ++number, node_errors: {} });
        if (opts.noLiveNodes && isLiveGraph(json.prompt ?? {})) {
          return reply(400, {
            error: { type: "missing_node_type", message: "Node 'SaveImageFuobeLive' not found. The custom node may not be installed.", details: "Node ID '#90'", extra_info: { node_id: "90", class_type: "SaveImageFuobeLive", node_title: "SaveImageFuobeLive" } },
            node_errors: {},
          });
        }
        const job: Job = { id, number: ++number, graph: json.prompt ?? {}, clientId: json.client_id, preview: !!json.extra_data?.preview_method && json.extra_data.preview_method !== "none", fail };
        // front: ComfyUI puts it ahead of everything waiting.
        if (json.front === true) queue.unshift(job);
        else queue.push(job);
        setImmediate(tick);
        return reply(200, { prompt_id: id, number: job.number, node_errors: {} });
      }
      if (p === "/queue") {
        if (req.method === "POST") {
          const asked = JSON.parse(body.toString("utf8") || "{}") as { delete?: string[]; clear?: boolean };
          entry.body = asked;
          const del = asked.delete ?? [];
          queue = asked.clear ? [] : queue.filter((j) => !del.includes(j.id));
          status();
          return reply(200, {});
        }
        const row = (j: Job) => [j.number, j.id, j.graph, { client_id: j.clientId }, []];
        return reply(200, { queue_running: running ? [row(running)] : [], queue_pending: queue.map(row) });
      }
      if (p === "/interrupt" && req.method === "POST") {
        const asked = JSON.parse(body.toString("utf8") || "{}") as { prompt_id?: string };
        entry.body = asked;
        const id = asked.prompt_id;
        if (id && running?.id === id) cancel(id);
        return reply(200, {});
      }
      if (p.startsWith("/history/")) {
        const id = decodeURIComponent(p.slice(9));
        const h = history.get(id);
        return reply(200, h ? { [id]: h } : {});
      }
      if (p === "/history" && req.method === "POST") {
        // ComfyUI's own: { delete: [ids] } or { clear: true } (a worker cleans up after each job).
        const asked = JSON.parse(body.toString("utf8") || "{}") as { delete?: string[]; clear?: boolean };
        entry.body = asked;
        if (asked.clear) history.clear();
        for (const id of asked.delete ?? []) history.delete(id);
        return reply(200, {});
      }
      if (p === "/history") {
        const max = Number(url.searchParams.get("max_items") ?? 64);
        return reply(200, Object.fromEntries([...history.entries()].slice(-max)));
      }
      if (p === "/api/jobs" && opts.jobsApi) return reply(200, { jobs: [...queue.map((j) => ({ id: j.id, status: "pending" })), ...(running ? [{ id: running.id, status: "in_progress" }] : [])] });
      const job = /^\/api\/jobs\/([^/]+)(\/cancel)?$/.exec(p);
      if (job && opts.jobsApi) {
        if (job[2] && req.method === "POST") return reply(200, { cancelled: cancel(job[1]) });
        const s = jobStatus(job[1]);
        return s ? reply(200, s) : reply(404, { error: "Job not found" });
      }
      if (p === "/view") {
        const name = url.searchParams.get("filename") ?? "";
        const temp = url.searchParams.get("type") === "temp" ? temps.get(name) : undefined;
        if (temp) return reply(200, temp.data, temp.type);
        // The input folder: what was uploaded, nothing else.
        if (url.searchParams.get("type") === "input") {
          const got = inputs.get(name);
          return got ? reply(200, got, "application/octet-stream") : reply(404, { error: "no file" });
        }
        const kind = (opts.outputs ?? ["image"])[Math.max(0, Number(/_(\d{5})_\./.exec(name)?.[1] ?? 1) - 1)];
        if (kind === "fake-png") return reply(200, Buffer.from("<!doctype html><script>alert(document.cookie)</script>".padEnd(200, " ")), "image/png");
        if (name.endsWith(".png")) return reply(200, FAKE_PNG, "image/png");
        if (name.endsWith(".mp4")) return reply(200, FAKE_MP4, "video/mp4");
        if (name.endsWith(".wav")) return reply(200, FAKE_WAV, "audio/wav");
        if (name.endsWith(".exr")) return reply(200, FAKE_EXR, "image/x-exr");
        if (name.endsWith(".txt")) return reply(200, Buffer.from("0.00-1.20: Hello there\n"), "text/plain");
        return reply(404, { error: "no file" });
      }
      reply(404, { error: "not found" });
    });
  };

  const upgrade = (req: http.IncomingMessage, socket: Duplex) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    log.push({ method: "WS", path: url.pathname + url.search, ...(origin && { origin }) });
    const key = req.headers["sec-websocket-key"];
    if (url.pathname !== "/ws" || typeof key !== "string") return socket.destroy();
    // ComfyUI's own check applies to the socket too when the setting is off.
    if (opts.cors === "off" && origin && new URL(origin).host !== String(req.headers.host ?? "")) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      return socket.destroy();
    }
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const clientId = url.searchParams.get("clientId") ?? randomUUID();
    const set = sockets.get(clientId) ?? new Set<Duplex>();
    sockets.set(clientId, set);
    set.add(socket);
    const drop = () => set.delete(socket);
    socket.on("data", (d: Buffer) => {
      if ((d[0] & 0x0f) === 0x8) {
        drop();
        socket.end();
      }
    });
    socket.on("close", drop);
    socket.on("error", drop);
    socket.write(frame(1, Buffer.from(JSON.stringify({ type: "status", data: { status: { exec_info: { queue_remaining: queue.length + (running ? 1 : 0) } }, sid: clientId } }))));
    // A client that comes back while its prompt runs hears which node it is on.
    if (running && running.clientId === clientId) event(clientId, "executing", { node: "1", prompt_id: running.id });
  };

  const listenOn = (at: number) =>
    new Promise<number>((resolve, reject) => {
      server = http.createServer(handler);
      server.on("upgrade", upgrade);
      server.once("error", reject);
      server.listen(at, "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : at);
      });
    });
  // No port given: a free one of the test ports (never ComfyUI's own 8188 and its neighbours), not the one the last
  // stand-in had (a client may still hold a connection to it).
  const listen = async (at: number): Promise<number> => {
    if (at) return listenOn(at);
    const span = TEST_PORTS[1] - TEST_PORTS[0] + 1;
    for (let i = 0; i < span; i++) {
      const p = TEST_PORTS[0] + ((nextPort++ + process.pid) % span);
      try {
        return await listenOn(p);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
      }
    }
    throw new Error(`No free port in ${TEST_PORTS.join("â€“")}`);
  };

  const closeSockets = () => {
    for (const set of sockets.values()) for (const s of set) s.destroy();
    sockets.clear();
  };

  const restart = ({ wipeInputs, ...o }: Partial<LocalComfyOptions> & { wipeInputs?: boolean } = {}) => {
    generation++;
    clearTimeout(timer);
    queue = [];
    running = null;
    history.clear();
    closeSockets();
    if (wipeInputs) {
      inputs.clear();
      sizes.clear();
    }
    Object.assign(opts, o);
  };

  const foreign = (ms: number) => {
    const id = randomUUID();
    queue.push({ id, number: ++number, graph: { "1": { class_type: "KSampler", inputs: {} }, "9": { class_type: "SaveImage", inputs: { filename_prefix: "someone" } } }, clientId: "someone-else", preview: false, ms });
    setImmediate(tick);
    return id;
  };

  return listen(port).then((at) => {
    const fake: LocalComfy = {
      port: at,
      url: `http://127.0.0.1:${at}`,
      opts,
      log,
      inputs,
      history,
      posts: () => posts,
      restart,
      foreign,
      renders,
      stop: () =>
        new Promise<void>((done) => {
          restart();
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      start: async (o = {}) => {
        Object.assign(opts, o);
        await listen(at);
      },
      close: () =>
        new Promise<void>((done) => {
          restart();
          server.closeAllConnections?.();
          server.close(() => done());
        }),
    };
    return fake;
  });
}

// Run on its own: node tests/helpers/fake-local-comfy.ts --port 3371 --cors http://127.0.0.1:3370
// [--has workflows/comfyui/requirements.json]: everything that index names is installed. [--guard 1]: Fuobe's guard answers.
// [--connect <origin>]: Fuobe Connect is installed, trusting that origin.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const index = arg("has");
  const has = index ? (JSON.parse(readFileSync(index, "utf8")) as IndexLike) : undefined;
  const fake = await startLocalComfy({ cors: arg("cors") ?? "off", steps: Number(arg("steps") ?? 8), stepMs: Number(arg("step-ms") ?? 250), portable: arg("portable") === "1", guard: arg("guard") === "1", ...(arg("connect") && { connect: arg("connect") }), has }, Number(arg("port") ?? 3371));
  console.log(`fake ComfyUI on ${fake.url} (cross-site setting: ${fake.opts.cors})`);
}
