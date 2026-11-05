import { Worker } from "node:worker_threads";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ManifestWorkflow } from "@/lib/comfy";
import type { MediaInfo } from "@/lib/media-probe";
import type { ModelDef, ModelRoute } from "@/lib/catalog/types";
import { tempDir } from "./helpers/temp-dir";

const dir = tempDir("fuobe-comfy-provider-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://comfy.test:8188";

const { setSetting } = await import("@/server/settings");
const { comfyProvider, collectOutputs, getWorkflow, loadManifest, mediaInfoFor, prepareWorkflow } = await import("@/server/providers/comfyui");
const { MODELS } = await import("@/lib/catalog");
const { computeFrames } = await import("@/lib/comfy");


// ---------------------------------------------------------------------------
// fetch + WebSocket stubs

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
const realFetch = globalThis.fetch;
const realWs = globalThis.WebSocket;
let handler: Handler = () => new Response("not stubbed", { status: 599 });
const calls: string[] = [];

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 1;
  closed = false;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  emit(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

beforeEach(() => {
  calls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  setSetting("comfyUrl", "http://comfy.test:8188");
});
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.WebSocket = realWs;
});

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
const route: ModelRoute = { op: "edit", provider: "comfyui", endpoint: "selftest-image" };
const model = { id: "m", routes: [route] } as unknown as ModelDef;
const pollCtx = (externalId: string, meta: Record<string, unknown> = { workflowId: "selftest-image", nodeCount: 3 }) => ({ externalId, meta, route, model, createdAt: Date.now() });
const done = (outputs: Record<string, Record<string, unknown>>) => ({ status: { status_str: "success", completed: true }, outputs });

describe("ComfyUI poll (S5)", () => {
  it("retries instead of failing when /queue answers with a proxy error page", async () => {
    handler = (url) => (url.includes("/history/") ? json({}) : new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    await expect(comfyProvider.poll(pollCtx("p-502"))).rejects.toThrow(/HTTP 502/);
    handler = (url) => (url.includes("/history/") ? json({}) : new Response("<html>oops</html>", { status: 200 }));
    await expect(comfyProvider.poll(pollCtx("p-html"))).rejects.toThrow(/isn't JSON/);
  });

  it("collects the outputs of a prompt that finished between the history and queue requests", async () => {
    let historyCalls = 0;
    handler = (url) => {
      if (url.includes("/history/p-race")) {
        historyCalls += 1;
        return json(historyCalls === 1 ? {} : { "p-race": done({ "3": { images: [{ filename: "fuobe_00001_.png", subfolder: "fuobe", type: "output" }] } }) });
      }
      return json({ queue_running: [], queue_pending: [] });
    };
    const res = await comfyProvider.poll(pollCtx("p-race"));
    expect(res.state).toBe("succeeded");
    expect(historyCalls).toBe(2);
  });

  it("fails a prompt only after it is missing from the queue and the history three polls in a row", async () => {
    handler = (url) => (url.includes("/history/") ? json({}) : json({ queue_running: [], queue_pending: [] }));
    expect((await comfyProvider.poll(pollCtx("p-gone"))).state).toBe("running");
    expect((await comfyProvider.poll(pollCtx("p-gone"))).state).toBe("running");
    const third = await comfyProvider.poll(pollCtx("p-gone"));
    expect(third).toMatchObject({ state: "failed", error: expect.stringMatching(/restarted and lost/) });
  });

  it("keeps the seed the graph drew with on each picture, so Edit layout draws it again (N7-2)", async () => {
    // prepareWorkflow records the seed it put in the graph (one Fuobe picked when none was asked).
    const ctx = { generationId: "g-seed", op: "t2i" as const, upload: async () => "x" };
    expect((await prepareWorkflow("moss-image-t2i", { prompt: "p", seed: 4242 }, ctx)).meta.seed).toBe(4242);
    const picked = (await prepareWorkflow("moss-image-t2i", { prompt: "p" }, ctx)).meta.seed;
    expect(typeof picked).toBe("number");
    handler = (url) =>
      url.includes("/history/p-seed")
        ? json({ "p-seed": done({ "3": { images: [{ filename: "fuobe_00001_.png", subfolder: "fuobe", type: "output" }, { filename: "fuobe_00002_.png", subfolder: "fuobe", type: "output" }] } }) })
        : json({ queue_running: [], queue_pending: [] });
    const res = await comfyProvider.poll(pollCtx("p-seed", { workflowId: "selftest-image", nodeCount: 3, seed: 4242 }));
    expect(res.state).toBe("succeeded");
    const outputs = (res as { outputs: { kind: string; meta?: Record<string, unknown> }[] }).outputs;
    expect(outputs).toHaveLength(2);
    expect(outputs.every((o) => o.kind === "image" && o.meta?.seed === 4242)).toBe(true);
    // Without a recorded seed the pictures carry none.
    const plain = await comfyProvider.poll(pollCtx("p-seed"));
    expect((plain as { outputs: { meta?: Record<string, unknown> }[] }).outputs.some((o) => o.meta?.seed !== undefined)).toBe(false);
  });

  it("reports the queue position while pending", async () => {
    handler = (url) => (url.includes("/history/") ? json({}) : json({ queue_running: [[0, "other"]], queue_pending: [[1, "x"], [2, "p-wait"]] }));
    expect(await comfyProvider.poll(pollCtx("p-wait"))).toMatchObject({ state: "queued", message: "In ComfyUI's queue · 1 ahead" });
  });
});

describe("ComfyUI websocket (S15)", () => {
  it("closes the old socket when the server URL changes and forgets finished prompts' progress", async () => {
    handler = (url) => (url.includes("/history/") ? json({}) : json({ queue_running: [[0, "p-run"]], queue_pending: [] }));
    await comfyProvider.poll(pollCtx("p-run"));
    const first = FakeSocket.all.at(-1)!;
    expect(first.url).toBe("ws://comfy.test:8188/ws?clientId=" + globalThis.__fuobeComfyWs!.clientId);
    first.emit({ type: "progress", data: { prompt_id: "p-run", value: 2, max: 8, node: "3" } });
    expect(globalThis.__fuobeComfyWs!.progress.get("p-run")?.value).toBe(2);
    const running = await comfyProvider.poll(pollCtx("p-run"));
    expect(running).toMatchObject({ state: "running", message: "Sampling 2/8" });

    // The prompt finishes: its progress entry goes away.
    handler = (url) => (url.includes("/history/") ? json({ "p-run": done({ "3": { images: [{ filename: "a.png", subfolder: "", type: "output" }] } }) }) : json({}));
    expect((await comfyProvider.poll(pollCtx("p-run"))).state).toBe("succeeded");
    expect(globalThis.__fuobeComfyWs!.progress.has("p-run")).toBe(false);

    // Another server: the first socket is closed and detached, a new one is opened.
    setSetting("comfyUrl", "http://gpu.test:8188");
    handler = (url) => (url.includes("/history/") ? json({}) : json({ queue_running: [[0, "p-gpu"]], queue_pending: [] }));
    await comfyProvider.poll(pollCtx("p-gpu"));
    const second = FakeSocket.all.at(-1)!;
    expect(second).not.toBe(first);
    expect(second.url.startsWith("ws://gpu.test:8188/ws")).toBe(true);
    expect(first.closed).toBe(true);
    expect(first.onmessage).toBeNull();
  });
});

describe("ComfyUI reachability (S16)", () => {
  it("answers the first routing question for a server from a real probe, not a pending one", async () => {
    // A stand-in ComfyUI on its own thread (a real one is another process): the probe blocks this thread.
    const server = new Worker(
      `const http = require("node:http"); const { parentPort } = require("node:worker_threads");
       const s = http.createServer((req, res) => { res.writeHead(req.url === "/system_stats" ? 200 : 404); res.end("{}"); });
       s.listen(0, "127.0.0.1", () => parentPort.postMessage(s.address().port));`,
      { eval: true },
    );
    const port = await new Promise<number>((r) => server.once("message", r));
    try {
      setSetting("comfyUrl", `http://127.0.0.1:${port}`);
      globalThis.__fuobeComfyReach = undefined;
      expect(comfyProvider.isConfigured()).toBe(true); // was false until a background probe finished
      setSetting("comfyUrl", "http://127.0.0.1:9");
      const t0 = Date.now();
      expect(comfyProvider.isConfigured()).toBe(false); // nothing listens: demo mode can take over at once
      expect(Date.now() - t0).toBeLessThan(1500);
    } finally {
      await server.terminate();
    }
  });
});

// ---------------------------------------------------------------------------
// Output mapping

function rgbaPng(w: number, h: number, alpha: (x: number, y: number) => number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 4);
    for (let x = 0; x < w; x++) row.set([200, 100, 50, alpha(x, y)], 1 + x * 4);
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

const manifestOf = (id: string): ManifestWorkflow => getWorkflow(id).manifest;
const file = (filename: string, subfolder = "fuobe") => ({ filename, subfolder, type: "output" });

describe("ComfyUI output mapping", () => {
  it("turns SaveText into text outputs with parsed cues, and folds the detected language in", () => {
    const outs = collectOutputs(
      done({
        "5": { text: ["English"] },
        "4": { text: ["0.00-1.20: Hello and welcome back.\n1.30-2.80: Today we test the camera."], files: [file("gen_00001.txt")] },
      }),
      manifestOf("captions-qwen3-asr"),
      "http://comfy.test:8188",
    );
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatchObject({
      kind: "text",
      contentType: "text/plain",
      text: "0.00-1.20: Hello and welcome back.\n1.30-2.80: Today we test the camera.",
      meta: {
        role: "cues",
        language: "English",
        cues: [
          { start: 0, end: 1.2, text: "Hello and welcome back." },
          { start: 1.3, end: 2.8, text: "Today we test the camera." },
        ],
      },
    });
    expect(outs[0].url).toBe("http://comfy.test:8188/view?filename=gen_00001.txt&subfolder=fuobe&type=output");
  });

  it("labels the voice and background stems and keeps the manifest's output order", () => {
    const outs = collectOutputs(
      done({
        "10": { text: ["German"] },
        "9": { text: ["Hallo zusammen."], files: [file("t_00001.txt")] },
        "8": { text: ["0.00-1.50: Hallo zusammen."], files: [file("s_00001.txt")] },
        "6": { audio: [file("background_00001_.mp3")] },
        "5": { audio: [file("vocals_00001_.mp3")] },
      }),
      manifestOf("dub-prepare-separate-transcribe"),
    );
    expect(outs.map((o) => [o.kind, o.meta?.stem ?? o.meta?.role])).toEqual([
      ["audio", "voice"],
      ["audio", "background"],
      ["text", "cues"],
      ["text", "transcript"],
    ]);
    expect(outs[2].meta?.cues).toEqual([{ start: 0, end: 1.5, text: "Hallo zusammen." }]);
    expect(outs[3].meta).toMatchObject({ language: "German" });
    expect(outs[3].meta?.cues).toBeUndefined();
  });

  it("reads Save3D's ui['3d'] as a .glb model (the turntable is rendered after the job, not in the graph)", () => {
    for (const id of ["image-to-3d-pixal3d", "image-to-3d-trellis2"]) {
      const outs = collectOutputs(done({ "322": { "3d": [file("product_00001_.glb", "fuobe")], camera_info: [{ position: { x: 1 } }], model_3d_info: [] } }), manifestOf(id));
      expect(outs.map((o) => [o.kind, o.contentType, o.meta?.role]), id).toEqual([["model3d", "model/gltf-binary", undefined]]);
    }
  });

  it("returns layers back to front with z, name and a bounding box from alpha (one download each)", async () => {
    const pngs: Record<string, Buffer> = {
      "layer_00001_.png": rgbaPng(16, 12, () => 255),
      "layer_00002_.png": rgbaPng(16, 12, (x, y) => (x >= 4 && x < 10 && y >= 2 && y < 7 ? 255 : 0)),
    };
    handler = (url) => {
      if (url.includes("/history/")) return json({ "p-layers": done({ "60": { images: [file("layer_00001_.png"), file("layer_00002_.png")] } }) });
      const name = new URL(url).searchParams.get("filename")!;
      return new Response(new Uint8Array(pngs[name]), { headers: { "Content-Type": "image/png" } });
    };
    const res = await comfyProvider.poll(pollCtx("p-layers", { workflowId: "layers-qwen-image-layered", nodeCount: 19 }));
    expect(res.state).toBe("succeeded");
    const outs = (res as { outputs: { url: string; kind: string; meta?: Record<string, unknown> }[] }).outputs;
    expect(outs.map((o) => o.meta)).toEqual([
      { role: "layers", z: 0, name: "Background", bbox: [0, 0, 16, 12], width: 16, height: 12 },
      { role: "layers", z: 1, name: "Layer 1", bbox: [4, 2, 6, 5], width: 16, height: 12 },
    ]);
    expect(outs.every((o) => o.url.startsWith("data:image/png;base64,"))).toBe(true);
    expect(calls.filter((c) => c.includes("/view?")).length).toBe(2);
  });

  it("follows VHS meta-batch passes to the one that saved the video", async () => {
    const prefix = "fuobe/gen-mm";
    const pass = (n: number, outputs: Record<string, Record<string, unknown>>) => ({ prompt: [n, `pass-${n}`, { "22": { class_type: "VHS_VideoCombine", inputs: { filename_prefix: prefix } } }], ...done(outputs) });
    let queued = true;
    handler = (url) => {
      if (url.includes("/history/p-mm")) return json({ "p-mm": pass(1, {}) });
      if (url.endsWith("/queue")) return json({ queue_running: queued ? [[2, "pass-2", { "22": { class_type: "VHS_VideoCombine", inputs: { filename_prefix: prefix } } }]] : [], queue_pending: [] });
      if (url.includes("/history?max_items")) return json({ "pass-1": pass(1, {}), "pass-2": pass(2, { "22": { gifs: [file("gen-mm_00001.mp4")] } }) });
      return json({});
    };
    const meta = { workflowId: "mixed-media-zimage-frames", nodeCount: 17, prefix, metaBatch: true };
    expect(await comfyProvider.poll(pollCtx("p-mm", meta))).toMatchObject({ state: "running", message: "Rendering the next batch of frames" });
    queued = false;
    const res = await comfyProvider.poll(pollCtx("p-mm", meta));
    expect(res).toMatchObject({ state: "succeeded", outputs: [{ kind: "video", url: expect.stringContaining("gen-mm_00001.mp4") }] });
  });

  it("keeps every pass's EXR frames when a meta-batch key saves frames in each pass and its clip in the last", async () => {
    const prefix = "fuobe/gen-exr";
    const graph = { "7": { class_type: "VHS_VideoCombine", inputs: { filename_prefix: prefix } }, "11": { class_type: "SaveImageAdvanced", inputs: { filename_prefix: prefix } } };
    const frames = (from: number) => ({ "11": { images: [0, 1].map((i) => file(`gen-exr_${String(from + i).padStart(5, "0")}_.exr`)) } });
    // ComfyUI numbers the first pass as queued; VHS re-queues each later pass under a more negative number.
    const first = { prompt: [5, "p-exr", graph], ...done(frames(1)) };
    const passes = { "pass-b": { prompt: [-7, "pass-b", graph], ...done({ ...frames(5), "7": { gifs: [file("gen-exr_00001.webm")] } }) }, "p-exr": first, "pass-a": { prompt: [-6, "pass-a", graph], ...done(frames(3)) } };
    let queued = true;
    const fetched: string[] = [];
    handler = (url) => {
      if (url.includes("/history/p-exr")) return json({ "p-exr": first });
      if (url.endsWith("/queue")) return json({ queue_running: queued ? [[-6, "pass-a", graph]] : [], queue_pending: [] });
      if (url.includes("/history?max_items")) return json(passes);
      if (url.includes("/view?")) {
        fetched.push(new URL(url).searchParams.get("filename")!);
        return new Response(new Uint8Array([1, 2, 3]));
      }
      return json({});
    };
    const meta = { workflowId: "video-key-corridorkey", nodeCount: 11, prefix, metaBatch: true, generationId: "gen-exr" };
    // The first pass's frames alone are not the result: the job is still running.
    expect(await comfyProvider.poll(pollCtx("p-exr", meta))).toMatchObject({ state: "running", message: "Rendering the next batch of frames" });
    queued = false;
    const res = await comfyProvider.poll(pollCtx("p-exr", meta));
    expect(res).toMatchObject({ state: "succeeded", outputs: [{ kind: "video", url: expect.stringContaining("gen-exr_00001.webm"), meta: { frames: 6, artifacts: { exr: expect.any(String) } } }] });
    // Every pass's frames, in pass order.
    expect(fetched).toEqual([1, 2, 3, 4, 5, 6].map((n) => `gen-exr_0000${n}_.exr`));
  });

  it("has a computer's tab follow a meta-batch key whose first pass saved only frames, then collect every pass's frames", async () => {
    const { planRelayOutputs } = await import("@/server/providers/comfyui");
    const prefix = "fuobe/gen-relay-exr";
    const t = { id: "task-exr", workflow_id: "video-key-corridorkey", meta_batch: 1, prefix } as unknown as Parameters<typeof planRelayOutputs>[0];
    const frames = (from: number) => ({ "11": { images: [file(`gen_${from}_.exr`)] } });
    const first = { prompt: [3, "p1"], ...done(frames(1)) };
    expect(planRelayOutputs(t, [first], false)).toEqual({ follow: prefix });
    const plan = planRelayOutputs(t, [{ prompt: [-5, "p3"], ...done({ ...frames(3), "7": { gifs: [file("gen.webm")] } }) }, first, { prompt: [-4, "p2"], ...done(frames(2)) }], true);
    expect("wanted" in plan && plan.wanted.map((w) => [w.kind, w.filename])).toEqual([
      ["video", "gen.webm"],
      ["frame", "gen_1_.exr"],
      ["frame", "gen_2_.exr"],
      ["frame", "gen_3_.exr"],
    ]);
  });

  it("orders a meta-batch's passes and keeps the last clip with every pass's frames", async () => {
    const { metaBatchResults } = await import("@/server/providers/comfyui");
    const out = (url: string, role?: string) => ({ url, kind: role === "frames" ? ("image" as const) : ("video" as const), ...(role && { meta: { role } }) });
    const passes = [
      { prompt: [-9], files: [out("f3", "frames"), out("clip")] },
      { prompt: [0], files: [out("f1", "frames")] },
      { prompt: [-8], files: [out("f2", "frames")] },
    ];
    expect(metaBatchResults(passes, (p) => p.files).map((o) => o.url)).toEqual(["clip", "f1", "f2", "f3"]);
    // Frames with no clip yet: not a result.
    expect(metaBatchResults(passes.slice(1), (p) => p.files)).toEqual([]);
  });

  it("reports a meta-batch pass that failed instead of 'no output'", async () => {
    const prefix = "fuobe/gen-mm-fail";
    const graph = { "22": { class_type: "VHS_VideoCombine", inputs: { filename_prefix: prefix } } };
    handler = (url) => {
      if (url.includes("/history/p-mmf")) return json({ "p-mmf": { prompt: [1, "p-mmf", graph], ...done({}) } });
      if (url.endsWith("/queue")) return json({ queue_running: [], queue_pending: [] });
      if (url.includes("/history?max_items"))
        return json({
          "p-mmf": { prompt: [1, "p-mmf", graph], ...done({}) },
          "pass-2": { prompt: [2, "pass-2", graph], status: { status_str: "error", messages: [["execution_error", { node_type: "KSampler", exception_message: "CUDA out of memory" }]] }, outputs: {} },
        });
      return json({});
    };
    const meta = { workflowId: "mixed-media-zimage-frames", nodeCount: 17, prefix, metaBatch: true };
    expect(await comfyProvider.poll(pollCtx("p-mmf", meta))).toEqual({ state: "failed", error: "KSampler: CUDA out of memory" });
  });

  it("explains a trim that starts past the end of the clip", async () => {
    handler = () => json({ "p-trim": { status: { status_str: "error", messages: [["execution_error", { node_type: "SaveVideo", exception_message: "No frames exist for start_time 9.0" }]] }, outputs: {} } });
    expect(await comfyProvider.poll(pollCtx("p-trim", { workflowId: "video-trim", nodeCount: 3 }))).toEqual({ state: "failed", error: "The start time is past the end of the clip" });
  });

  it("explains a caption that starts after the end of the clip", async () => {
    handler = () =>
      json({
        "p-cap": {
          status: { status_str: "error", messages: [["execution_error", { node_type: "GetVideoComponents", exception_message: "division by zero\n" }]] },
          outputs: {},
        },
      });
    expect(await comfyProvider.poll(pollCtx("p-cap", { workflowId: "captions-burnin", nodeCount: 11 }))).toEqual({
      state: "failed",
      error: "A caption starts after the end of the video — check the cue times",
    });
  });
});

describe("ComfyUI uploads and submit", () => {
  /** A minimal MP4: ftyp + moov with mvhd and one video trak (tkhd 1280x720, mdhd, hdlr vide, stts 50 frames). */
  function tinyMp4(): Buffer {
    const box = (type: string, ...parts: Buffer[]) => {
      const body = Buffer.concat(parts);
      const head = Buffer.alloc(8);
      head.writeUInt32BE(8 + body.length);
      head.write(type, 4);
      return Buffer.concat([head, body]);
    };
    const u32 = (...v: number[]) => Buffer.concat(v.map((n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }));
    const mvhd = box("mvhd", u32(0, 0, 0, 1000, 2000), Buffer.alloc(80));
    const matrix = u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);
    const tkhd = box("tkhd", u32(0, 0, 0, 1, 0, 2000), Buffer.alloc(8), Buffer.alloc(8), matrix, u32(1280 << 16, 720 << 16));
    const mdhd = box("mdhd", u32(0, 0, 0, 25, 50), Buffer.alloc(4));
    const hdlr = box("hdlr", u32(0, 0), Buffer.from("vide"), Buffer.alloc(12));
    const stts = box("stts", u32(0, 1, 50, 1));
    const trak = box("trak", tkhd, box("mdia", mdhd, hdlr, box("minf", box("stbl", stts))));
    return Buffer.concat([box("ftyp", Buffer.from("isom"), u32(0)), box("moov", mvhd, trak)]);
  }

  it("remembers what an uploaded clip's header says, for the next prompt", async () => {
    handler = (url) => (url.endsWith("/upload/image") ? json({ name: "fuobe_abc.mp4", subfolder: "" }) : json({}));
    const name = await comfyProvider.prepareFile(tinyMp4(), "video/mp4", "clip.mp4");
    expect(name).toBe("fuobe_abc.mp4");
    expect(mediaInfoFor(name)).toMatchObject({ container: "mp4", hasVideo: true, hasAudio: false, width: 1280, height: 720, frames: 50, fps: 25, duration: 2, videoDuration: 2 });
    handler = (url) => (url.endsWith("/upload/image") ? json({ name: "fuobe_img.png", subfolder: "" }) : json({}));
    expect(mediaInfoFor(await comfyProvider.prepareFile(Buffer.from("\x89PNG...."), "image/png", "a.png"))).toBeUndefined();
  });

  it("names the node pack to install when ComfyUI lacks a node class: the missing class's pack, with a code for Fix it", async () => {
    handler = (url) =>
      url.endsWith("/prompt")
        ? json({ error: { type: "missing_node_type", message: "Node 'Apply Whisper' not found. The custom node may not be installed." }, node_errors: {} }, 400)
        : json({});
    const whisperRoute: ModelRoute = { op: "captions", provider: "comfyui", endpoint: "captions-whisper-burnin" };
    const err = (await comfyProvider.submit({ generationId: "g-np", model, route: whisperRoute, input: { video: "clip.mp4", prompt: "" } }).then(
      () => new Error("submitted"),
      (e: unknown) => e,
    )) as Error & { fix?: unknown };
    expect(err.message).toBe("This workflow needs the ComfyUI-Whisper node pack on your ComfyUI (see scripts/comfy/README.md)");
    expect(err.fix).toEqual({ code: "comfy_missing_node", workflowId: "captions-whisper-burnin", items: [{ class: "Apply Whisper", pack: "ComfyUI-Whisper" }] });
  });
});

// ---------------------------------------------------------------------------
// Every round-3 workflow, bound for real (applyBindings on the library graph through prepareWorkflow)

const ROUND3 = [
  "layers-qwen-image-layered", "layers-qwen-image-layered-control", "style-ref-qwen-edit-2511", "style-ref-flux2-klein-4b", "style-ref-krea2",
  "style-ref-uso-flux1", "palette-zimage-hex", "video-trim", "video-segment-resample", "video-restyle-wan22-fun-vace", "mixed-media-zimage-frames",
  "sfx-stable-audio-3-small", "sfx-stable-audio-open", "sfx-hunyuan-foley", "sfx-mmaudio-t2a", "sfx-thinksound", "dub-prepare-separate-transcribe",
  "captions-qwen3-asr", "captions-burnin", "captions-whisper-burnin", "translate-qwen35-textgen", "speech-translate-gemma4", "lipsync-v2v-infinitetalk",
  "lipsync-latentsync16", "video-mux-audio", "video-mux-audio-replace", "image-to-3d-pixal3d", "image-to-3d-trellis2", "image-to-3d-hunyuan3d-21", "tryon-flux2-klein-4b",
  "grid-zimage-contact-sheet", "soul-cast-sheet-zimage",
];
const LOADERS: Record<string, string> = { LoadImage: "image", LoadImageMask: "image", LoadVideo: "file", VHS_LoadVideo: "video", LoadAudio: "audio" };
const CUES = "0.00-1.00: Hello there\n1.20-2.00: Second line";
const GIVEN = new Set(["img1.png", "img2.png", "clip.mp4", "voice.wav", "bg.wav", "up_palette_swatch.png"]);
const opFor = (id: string) => MODELS.flatMap((m) => m.routes).find((r) => r.provider === "comfyui" && r.endpoint === id)?.op ?? (id.startsWith("video-mux") ? "mux" : "t2i");

type Facts = { media?: Record<string, MediaInfo>; ram?: number };
async function prepare(id: string, over: Record<string, unknown> = {}, op = opFor(id), facts: Facts = {}) {
  const input = {
    prompt: CUES,
    negativePrompt: "blurry",
    images: ["img1.png", "img2.png"],
    video: "clip.mp4",
    audio: "voice.wav",
    palette: ["#112233", "#445566"],
    targetLanguage: "German (de)",
    sourceLanguage: "de",
    startTime: 1,
    endTime: 3,
    numLayers: 3,
    aspectRatio: "16:9",
    seed: 7,
    extra: { audio2: "bg.wav" },
    ...over,
  };
  const uploads: string[] = [];
  const res = await prepareWorkflow(id, input, {
    generationId: "gen1",
    op,
    upload: async (_d, _t, name) => {
      uploads.push(name);
      return `up_${name}`;
    },
    media: (name) => facts.media?.[name],
    serverRam: async () => facts.ram,
  });
  return { ...res, uploads };
}
const mp4 = (over: Partial<MediaInfo> = {}): MediaInfo => ({ container: "mp4", hasVideo: true, hasAudio: true, duration: 6, videoDuration: 6, width: 640, height: 360, fps: 30, frames: 180, ...over });
const wavOf = (duration: number): MediaInfo => ({ container: "wav", hasVideo: false, hasAudio: true, duration });
const at = (wf: Record<string, { inputs: Record<string, unknown> }>, m: ManifestWorkflow, key: string) => (m.bindings[key] ?? []).map((t) => wf[t.node].inputs[t.input]);

describe("round-3 workflow bindings", () => {
  it("are all in the manifest, validated, with a licence", () => {
    const byId = new Map(loadManifest().workflows.map((w) => [w.id, w]));
    for (const id of ROUND3) {
      expect(byId.get(id)?.validated, id).toBe(true);
      expect(byId.get(id)?.license, id).toBeTruthy();
    }
    expect(byId.get("lipsync-latentsync16")?.worker).toBe("isolated");
    expect(byId.get("sfx-thinksound")?.worker).toBe("isolated");
  });

  it.each(ROUND3)("%s: every upload slot, the seed and the file prefix are filled", async (id) => {
    const { workflow, manifest } = await prepare(id);
    for (const [nid, n] of Object.entries(workflow)) {
      const inp = LOADERS[n.class_type];
      if (inp) expect(GIVEN.has(String(n.inputs[inp])), `${id} node ${nid} ${n.class_type}.${inp} = ${n.inputs[inp]}`).toBe(true);
      if ("filename_prefix" in n.inputs && manifest.outputs.some((o) => o.node === nid)) expect(n.inputs.filename_prefix, `${id} ${nid}`).toBe("fuobe/gen1");
    }
    for (const v of at(workflow, manifest, "seed")) expect(v).toBe(7);
    if (manifest.bindings.negativePrompt) expect(at(workflow, manifest, "negativePrompt")).toEqual(manifest.bindings.negativePrompt.map(() => "blurry"));
  });

  it("maps trim times, frame rates and frame counts", async () => {
    const trim = await prepare("video-trim");
    expect(trim.workflow["2"].inputs).toMatchObject({ start_time: 1, duration: 2 });
    const open = await prepare("video-trim", { endTime: undefined, startTime: 4 });
    expect(open.workflow["2"].inputs).toMatchObject({ start_time: 4, duration: 0 }); // to the end
    const seg = await prepare("video-segment-resample", { fps: 16 });
    expect(seg.workflow["1"].inputs).toMatchObject({ force_rate: 16, skip_first_frames: 16, frame_load_cap: computeFrames(2, 16, 4, 241) });
    expect(seg.workflow["3"].inputs.fps).toBe(16);
    const { width, height } = seg.workflow["2"].inputs as { width: number; height: number };
    expect(width % 16 + (height % 16)).toBe(0);
    expect(width / height).toBeCloseTo(16 / 9, 1);
    const mm = await prepare("mixed-media-zimage-frames", { extra: { fps: 12 } });
    expect(mm.workflow["1"].inputs).toMatchObject({ force_rate: 12, skip_first_frames: 12, frame_load_cap: computeFrames(2, 12, 1, 240) });
    expect(mm.workflow["22"].inputs.frame_rate).toBe(12);
    expect(mm.meta.metaBatch).toBe(true);
  });

  it("maps layers, languages, palettes and instructions", async () => {
    const layers = await prepare("layers-qwen-image-layered");
    expect(layers.workflow["83:118"].inputs.layers).toBe(3);
    const asr = await prepare("captions-qwen3-asr", { audio: undefined });
    expect(asr.workflow["1"].inputs.audio).toBe("clip.mp4"); // LoadAudio reads the video's soundtrack
    expect(asr.workflow["3"].inputs.language).toBe("German");
    const pal = await prepare("palette-zimage-hex", { prompt: "a rooftop at dusk" });
    expect(pal.workflow["20"].inputs).toMatchObject({ string_a: "a rooftop at dusk", string_b: "Color palette: #112233, #445566." });
    expect(pal.workflow["1"].inputs.image).toBe("up_palette_swatch.png");
    expect(pal.uploads).toEqual(["palette_swatch.png"]);
    const recolor = await prepare("palette-transfer-image", { images: ["img1.png"] }, "color-match");
    expect(recolor.workflow["2"].inputs.image).toBe("up_palette_swatch.png");
    const tr = await prepare("translate-qwen35-textgen");
    expect(tr.workflow["2"].inputs.string_a).toMatch(/into German\./);
    expect(tr.workflow["2"].inputs.string_b).toBe(CUES);
    await expect(prepare("translate-qwen35-textgen", { targetLanguage: undefined })).rejects.toThrow(/Pick a language/);
    const speech = await prepare("speech-translate-gemma4");
    expect(speech.workflow["1"].inputs.prompt).toBe("Transcribe the speech in this audio, then translate it into German. Output only the German translation.");
    const ts = await prepare("sfx-thinksound", { prompt: "door slam" });
    expect(ts.workflow["3"].inputs).toMatchObject({ caption: "door slam", cot_description: "door slam", duration: 2 });
  });

  it("fills reference slots, trigger words and grid framing", async () => {
    // FLUX.2 reference chains: references not given are left out (their ReferenceLatent pair bypassed), not repeated
    const klein = await prepare("style-ref-flux2-klein-4b");
    expect(klein.workflow["77"]).toBeUndefined();
    expect(klein.workflow["78"]).toBeUndefined();
    expect(klein.workflow["75:63"].inputs.positive).toEqual(["75:200", 0]);
    const tryon = await prepare("tryon-flux2-klein-4b", { prompt: "wear these" });
    expect(tryon.workflow["75:74"].inputs.text).toBe("TRYON wear these");
    expect(tryon.workflow["81"].inputs.image).toBe("img2.png"); // the garment
    expect(tryon.workflow["77"]).toBeUndefined(); // no bottom given: one garment reference, not the top twice
    const grid = await prepare("grid-zimage-contact-sheet", { prompt: "a heist", extra: { columns: 2, rows: 2 } });
    expect(grid.workflow["20"].inputs.string_a).toMatch(/^A 2x2 grid contact sheet of 4 film stills/);
    expect(grid.workflow["27"].inputs).toMatchObject({ columns: 2, rows: 2 });
    await expect(prepare("style-ref-qwen-edit-2511", { images: [] })).rejects.toThrow(/Add an image/);
  });

  it("repeats a reference only where that is harmless, and otherwise asks for the missing image", async () => {
    // style boards (TextEncodeQwenImageEditPlus): one collage passed twice
    const board = await prepare("style-ref-qwen-edit-2511", { images: ["img1.png"] });
    expect(at(board.workflow, board.manifest, "image2")).toEqual(["img1.png"]);
    // a photo is not its own palette, lighting reference or garment
    await expect(prepare("palette-transfer-image", { images: ["img1.png"], palette: [] }, "color-match")).rejects.toThrow("Pick a palette or add a reference image");
    await expect(prepare("relight-qwen-edit-2509-reference", { images: ["img1.png"] }, "edit")).rejects.toThrow("Add the photo whose light to copy");
    await expect(prepare("tryon-flux2-klein-4b", { images: ["img1.png"], prompt: "x" })).rejects.toThrow("Add the garment to try on");
    // with a palette the swatch fills the reference slot
    const swatch = await prepare("palette-transfer-image", { images: ["img1.png"] }, "color-match");
    expect(swatch.workflow["2"].inputs.image).toBe("up_palette_swatch.png");
  });

  it("checks trim times against each other and the clip's length", async () => {
    await expect(prepare("video-trim", { startTime: 3, endTime: 2 })).rejects.toThrow("The end time must be after the start time");
    await expect(prepare("video-segment-resample", { startTime: 2, endTime: 2 })).rejects.toThrow("The end time must be after the start time");
    await expect(prepare("video-trim", { startTime: 7, endTime: 9 }, "trim", { media: { "clip.mp4": mp4() } })).rejects.toThrow("The start time is past the end of the clip (it is 6 s long)");
    const ok = await prepare("video-trim", { startTime: 1, endTime: 3 }, "trim", { media: { "clip.mp4": mp4() } });
    expect(ok.workflow["2"].inputs).toMatchObject({ start_time: 1, duration: 2 });
  });

  it("takes the source clip's shape for 'auto' and times lip re-sync by the voice, refusing more than the frame cap", async () => {
    const portrait = mp4({ width: 1080, height: 1920 });
    const lip = await prepare("lipsync-v2v-infinitetalk", { aspectRatio: "auto", resolution: "480p", startTime: undefined, endTime: undefined }, "lipsync", {
      media: { "clip.mp4": portrait, "voice.wav": wavOf(12.3) },
    });
    const { workflow: wf, manifest } = lip;
    expect(at(wf, manifest, "width")).toEqual([480]);
    expect(at(wf, manifest, "height")).toEqual([848]); // 9:16 at 480p, multiple of 16: no squashing into 16:9
    expect(wf["228"].inputs.custom_height).toBe(0); // VHS keeps the proportions, ImageResizeKJv2 crops
    expect(at(wf, manifest, "frames")).toEqual([309, 309]); // ceil(12.3 s × 25 fps / 4) × 4 + 1, also VHS frame_load_cap
    await expect(
      prepare("lipsync-v2v-infinitetalk", { aspectRatio: "auto", startTime: undefined, endTime: undefined }, "lipsync", { media: { "voice.wav": wavOf(55) } }),
    ).rejects.toThrow(/up to 40 s of speech per job \(this voice is 55 s\)/);
    // without header facts: the old 16:9 default, the 1000-frame cap
    const blind = await prepare("lipsync-v2v-infinitetalk", { aspectRatio: "auto", startTime: undefined, endTime: undefined }, "lipsync");
    expect(at(blind.workflow, blind.manifest, "frames")).toEqual([1000, 1000]);
  });

  it("maps the source language to Whisper's names and refuses clips Whisper can't hold in RAM", async () => {
    const tl = await prepare("captions-whisper-burnin", { sourceLanguage: "tl" }, "captions");
    expect(tl.workflow["3"].inputs.language).toBe("Tagalog");
    const he = await prepare("captions-whisper-burnin", { sourceLanguage: "he" }, "captions");
    expect(he.workflow["3"].inputs.language).toBe("Hebrew");
    const short = { "clip.mp4": mp4() };
    await expect(prepare("captions-whisper-burnin", {}, "captions", { media: short, ram: 16 * 2 ** 30 })).resolves.toBeTruthy();
    const long = { "clip.mp4": mp4({ width: 1080, height: 1920, duration: 30, videoDuration: 30, frames: 900 }) };
    await expect(prepare("captions-whisper-burnin", {}, "captions", { media: long, ram: 16 * 2 ** 30 })).rejects.toThrow(/needs about 53 GB of RAM and this ComfyUI can spare 8 GB/);
  });

  it("uses the one-track soundtrack graph without a background stem", async () => {
    const mix = await prepare("video-mux-audio");
    expect(mix.manifest.id).toBe("video-mux-audio");
    expect(mix.workflow["4"].inputs.audio).toBe("bg.wav");
    expect(mix.workflow["7"]).toMatchObject({ class_type: "ConcatenateVideo", inputs: { "videos.video0": ["1", 0], complete_audio: ["6", 0] } });
    const one = await prepare("video-mux-audio", { extra: {} });
    expect(one.manifest.id).toBe("video-mux-audio-replace");
    expect(one.workflow["3"].inputs.audio).toBe("voice.wav");
  });

  it("takes the background from inputs.audio2 when the runtime sends it, and mixes over a bed as long as the video", async () => {
    const canonical = await prepare("video-mux-audio", { audio2: "stem_bg.wav", extra: { audio2: "bg.wav" } }, "mux", { media: { "clip.mp4": mp4({ videoDuration: 61.2, duration: 61.25 }) } });
    expect(canonical.manifest.id).toBe("video-mux-audio");
    expect(canonical.workflow["4"].inputs.audio).toBe("stem_bg.wav");
    expect(canonical.workflow["9"].inputs.duration).toBe(61.7); // the video's length (+0.5 s; the mux trims to the picture)
    const onlyCanonical = await prepare("video-mux-audio", { audio2: "stem_bg.wav", extra: {} });
    expect(onlyCanonical.manifest.id).toBe("video-mux-audio");
    // no video header: the longer of the two tracks
    const blind = await prepare("video-mux-audio", {}, "mux", { media: { "voice.wav": wavOf(5), "bg.wav": wavOf(8.04) } });
    expect(blind.workflow["9"].inputs.duration).toBe(8.54);
  });

  it("burns captions with the clip's facts: a gap after the last cue and the clip's own soundtrack", async () => {
    const { workflow } = await prepare("captions-burnin", {}, "captions", { media: { "clip.mp4": mp4() } });
    const joins = Object.values(workflow).filter((n) => n.class_type === "ConcatenateVideo");
    expect(joins).toHaveLength(1);
    expect(joins[0].inputs.complete_audio).toEqual(["3", 0]);
    expect(workflow["3"].inputs.audio).toBe("clip.mp4");
    const slices = Object.values(workflow).filter((n) => n.class_type === "Video Slice");
    expect(slices.at(-1)!.inputs.duration).toBe(0); // the uncaptioned rest of the clip
    expect(slices).toHaveLength(4); // cue, gap, cue, rest
    const silent = await prepare("captions-burnin", {}, "captions", { media: { "clip.mp4": mp4({ hasAudio: false }) } });
    expect(Object.values(silent.workflow).some((n) => n.class_type === "LoadAudio")).toBe(false);
    await expect(prepare("captions-burnin", { prompt: "9.00-10.00: too late" }, "captions", { media: { "clip.mp4": mp4() } })).rejects.toThrow(/after the end of the clip/);
  });

  it("writes one segment per caption cue with the chosen style", async () => {
    const { workflow } = await prepare("captions-burnin", { extra: { fontSize: 8, captionPosition: "top", fontColor: "#ffd400" } });
    const slices = Object.values(workflow).filter((n) => n.class_type === "Video Slice").map((n) => [n.inputs.start_time, n.inputs.duration]);
    expect(slices).toEqual([[0, 1], [1, 0.2], [1.2, 0]]);
    const overlays = Object.values(workflow).filter((n) => n.class_type === "TextOverlay");
    expect(overlays.map((n) => n.inputs.text)).toEqual(["Hello there", "Second line"]);
    expect(overlays.every((n) => n.inputs.font_size === 8 && n.inputs.position === "top" && n.inputs.color === "#ffd400")).toBe(true);
    await expect(prepare("captions-burnin", { prompt: "no timings here" })).rejects.toThrow(/No timed captions/);
  });
});
