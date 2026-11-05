import http from "node:http";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "./helpers/temp-dir";

// The WorldCast worker's client (docs/workers/worldcast.md) against a stand-in worker: submit, poll, download, errors.
const dir = tempDir("fuobe-worldcast-");
process.env.FUOBE_DATA_DIR = dir;

type Job = { status: string; progress?: number; error?: string };
const state: { jobs: Map<string, Job>; health: unknown; healthStatus: number; caseStatus: number; fields: string[]; files: string[]; canceled: string[]; auth: (string | undefined)[] } = {
  auth: [],
  jobs: new Map(),
  health: { ok: true, model: "PixCtrol/WorldCast@7ccf2e0", vram_gb: 80, depth: ["depth-pro"] },
  healthStatus: 200,
  caseStatus: 200,
  fields: [],
  files: [],
  canceled: [],
};
const VIDEO = Buffer.from("fake mp4 bytes");

const server = http.createServer((req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const url = req.url ?? "";
  state.auth.push(req.headers.authorization);
  if (req.method === "GET" && url === "/health") return send(state.healthStatus, state.health);
  if (req.method === "POST" && url === "/cases") {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("latin1");
      state.fields = [...text.matchAll(/name="([^"]+)"(?!; filename)/g)].map((m) => m[1]).filter((n, i, a) => a.indexOf(n) === i);
      state.files = [...text.matchAll(/name="([^"]+)"; filename="([^"]+)"/g)].map((m) => m[2]);
      if (state.caseStatus !== 200) return send(state.caseStatus, { error: "render_mask.mp4 has 40 frames, but nframe=81" });
      state.jobs.set("job1", { status: "queued" });
      send(200, { id: "job1" });
    });
    return;
  }
  if (req.method === "POST" && url === "/depth") {
    req.resume();
    req.on("end", () => {
      state.jobs.set("depth1", { status: "succeeded" });
      send(200, { id: "depth1" });
    });
    return;
  }
  const m = /^\/jobs\/([^/]+)(\/video|\/depth\.png)?$/.exec(url);
  if (m) {
    const job = state.jobs.get(m[1]);
    if (req.method === "DELETE") {
      state.canceled.push(m[1]);
      return job ? send(200, { ok: true }) : send(404, { error: "no such job" });
    }
    if (!job) return send(404, { error: "no such job" });
    if (m[2]) {
      res.writeHead(200, { "content-type": "video/mp4" });
      return res.end(VIDEO);
    }
    return send(200, job);
  }
  send(404, { error: "not found" });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
process.env.WORLDCAST_URL = `http://127.0.0.1:${port}/`;

const wc = await import("@/server/worldcast");
const { worldcastProvider } = await import("@/server/providers/worldcast");
const { runAsTenant } = await import("@/server/tenant");
const { caseParts, worldcastLayout } = await import("@/lib/worldcast");
const { framePoses, presetKeys } = await import("@/lib/camera-path");

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  delete process.env.WORLDCAST_URL;
});

beforeEach(() => {
  state.auth = [];
  state.jobs.clear();
  state.healthStatus = 200;
  state.caseStatus = 200;
  state.health = { ok: true, model: "PixCtrol/WorldCast@7ccf2e0", vram_gb: 80, depth: ["depth-pro"] };
  globalThis.__fuobeWorldcast = undefined;
});

const parts = () => {
  const path81 = framePoses(presetKeys("orbit_360_cw")!, 81, 2, 40, { width: 480, height: 832 });
  const b = new Uint8Array([1, 2, 3]);
  return caseParts(worldcastLayout(["front", "back"]), path81, { firstFrame: b, personMask: b, render: b, renderMask: b, anchors: [{ image: b, mask: b }, { image: b, mask: b }] }, { prompt: "walks", seed: 3, pivotDepth: 2 });
};

describe("the WorldCast worker's client", () => {
  it("reads the worker's health, and remembers it for the planners", async () => {
    expect(wc.worldcastBase()).toBe(`http://127.0.0.1:${port}`);
    const h = await wc.worldcastHealth();
    expect(h).toMatchObject({ ok: true, vramGb: 80, depth: ["depth-pro"] });
    expect(h.detail).toContain("WorldCast worker");
    expect(wc.worldcastAnswers()).toBe(false); // nothing seen yet: a look starts in the background
    expect(await wc.refreshWorldcast(true)).toBe(true);
    expect(wc.worldcastAnswers()).toBe(true);
    expect(wc.worldcastDepths()).toEqual(["depth-pro"]);
    // Never for an account: the worker is the studio's own.
    expect(runAsTenant({ kind: "account", id: "a1" }, () => wc.worldcastAnswers())).toBe(false);
  });

  it("says when the worker is loading or failing", async () => {
    state.health = { ok: false };
    expect((await wc.worldcastHealth()).ok).toBe(false);
    state.healthStatus = 502;
    state.health = { error: "bad gateway" };
    const h = await wc.worldcastHealth();
    expect(h.ok).toBe(false);
    expect(h.detail).toMatch(/HTTP 502.*bad gateway/);
    expect(await wc.refreshWorldcast(true)).toBe(false);
  });

  it("sends a case as one multipart, and gets a job id", async () => {
    expect(await wc.submitCase(parts())).toBe("job1");
    expect(state.files).toEqual([
      "first_frame.png",
      "person_mask.png",
      "render.mp4",
      "render_mask.mp4",
      "cam_info.json",
      "anchor_front.png",
      "anchor_front_mask.png",
      "anchor_back.png",
      "anchor_back_mask.png",
      "anchors_aligned_camera_info.json",
    ]);
    expect(state.fields).toEqual(expect.arrayContaining(["anchors", "prompt", "seed", "steps", "cfg", "shift", "height", "width"]));
  });

  it("passes the worker's own error on", async () => {
    state.caseStatus = 422;
    await expect(wc.submitCase(parts())).rejects.toThrow(/HTTP 422 to the case: render_mask\.mp4 has 40 frames/);
  });

  it("polls a job, then downloads its clip", async () => {
    state.jobs.set("job1", { status: "running", progress: 0.42 });
    expect(await wc.jobStatus("job1")).toEqual({ status: "running", progress: 0.42 });
    state.jobs.set("job1", { status: "failed", error: "CUDA out of memory" });
    expect(await wc.jobStatus("job1")).toEqual({ status: "failed", error: "WorldCast: CUDA out of memory" });
    state.jobs.set("job1", { status: "succeeded" });
    expect(await wc.jobStatus("job1")).toEqual({ status: "succeeded" });
    expect((await wc.jobVideo("job1")).equals(VIDEO)).toBe(true);
    expect(await wc.jobStatus("gone")).toMatchObject({ status: "failed", error: expect.stringMatching(/no longer has this job/) });
    state.jobs.set("odd", { status: "dancing" });
    await expect(wc.jobStatus("odd")).rejects.toThrow(/status Fuobe doesn't know/);
    await expect(wc.jobStatus("../etc")).rejects.toThrow(/isn't a WorldCast job/);
  });

  it("runs as a provider: a poll hands the clip's address on, a cancel stops the job", async () => {
    state.jobs.set("job1", { status: "running", progress: 0.5 });
    const ctx = { externalId: "job1", meta: {}, route: { op: "camera-path", provider: "worldcast", endpoint: "cases" }, model: {} as never, createdAt: 0 } as const;
    expect(await worldcastProvider.poll(ctx as never)).toMatchObject({ state: "running", progress: 0.5 });
    state.jobs.set("job1", { status: "succeeded" });
    expect(await worldcastProvider.poll(ctx as never)).toEqual({
      state: "succeeded",
      outputs: [{ url: `http://127.0.0.1:${port}/jobs/job1/video`, kind: "video", contentType: "video/mp4", meta: { fps: 15 } }],
    });
    await worldcastProvider.cancel!(ctx as never);
    expect(state.canceled).toContain("job1");
    expect(worldcastProvider.isConfigured()).toBe(true);
    expect(await worldcastProvider.prepareFile(Buffer.from("x"), "image/png", "a.png")).toBe("data:image/png;base64,eA==");
  });

  it("sends the worker's token on every call and on the clip's download when one is set, and nothing without one", async () => {
    state.jobs.set("job1", { status: "succeeded" });
    const ctx = { externalId: "job1", meta: {}, route: { op: "camera-path", provider: "worldcast", endpoint: "cases" }, model: {} as never, createdAt: 0 } as const;
    await wc.jobStatus("job1");
    expect(state.auth).toEqual([undefined]);
    process.env.WORLDCAST_TOKEN = "s3cret";
    try {
      await wc.worldcastHealth();
      await wc.submitCase(parts());
      await wc.jobStatus("job1");
      await wc.cancelJob("job1");
      state.jobs.set("job1", { status: "succeeded" });
      expect(state.auth.slice(1)).toEqual(["Bearer s3cret", "Bearer s3cret", "Bearer s3cret", "Bearer s3cret"]);
      expect(await worldcastProvider.poll(ctx as never)).toMatchObject({ state: "succeeded", outputs: [{ headers: { Authorization: "Bearer s3cret" } }] });
    } finally {
      delete process.env.WORLDCAST_TOKEN;
    }
  });

  it("runs the paper's depth model as a job when asked, and hands its picture on", async () => {
    const route = { op: "edit", provider: "worldcast", endpoint: "depth/depth-pro" } as const;
    const sub = await worldcastProvider.submit({ generationId: "g", model: {} as never, route: route as never, input: { images: ["data:image/png;base64,eA=="] } as never });
    expect(sub).toMatchObject({ externalId: "depth1", meta: { depth: "depth-pro" } });
    const polled = await worldcastProvider.poll({ externalId: "depth1", meta: sub.meta!, route: route as never, model: {} as never, createdAt: 0 });
    expect(polled).toMatchObject({ state: "succeeded", outputs: [{ url: `http://127.0.0.1:${port}/jobs/depth1/depth.png`, kind: "image" }] });
    await expect(worldcastProvider.submit({ generationId: "g", model: {} as never, route: { ...route, endpoint: "depth/nope" } as never, input: { images: ["data:image/png;base64,eA=="] } as never })).rejects.toThrow(/doesn't run that model/);
  });

  it("refuses an account's run, and says where to set the worker when none answers", async () => {
    await expect(runAsTenant({ kind: "account", id: "a1" }, () => wc.submitCase(parts()))).rejects.toThrow(/studio's own GPU only/);
    const saved = process.env.WORLDCAST_URL;
    process.env.WORLDCAST_URL = "http://127.0.0.1:9";
    try {
      await expect(wc.jobStatus("job1")).rejects.toThrow(/doesn't answer.*Settings → Open-source engine/);
    } finally {
      process.env.WORLDCAST_URL = saved;
    }
  });
});
