import "server-only";
import { readLayout } from "@/lib/worldcast";
import { buildCase } from "../worldcast-case";
import { WORKER_DEPTH, cancelJob, jobDepthUrl, jobStatus, jobVideoUrl, submitCase, submitDepth, worldcastBase, worldcastHeaders, worldcastHealth, type WorkerDepth } from "../worldcast";
import type { ProviderAdapter } from "./types";
import { ProviderError } from "./types";

/**
 * The WorldCast worker as a provider (build plan N7-9): a run's pictures stay on this server until submit, where the case
 * is made (src/server/worldcast-case.ts) and sent as one multipart POST; polls read the job, and the clip is fetched from
 * the worker when it is done. Open engine, the studio's own GPU only (accountRun refuses an account: not ComfyUI, not a key).
 */

/** The worker's Bearer header for the clip's download, when a WORLDCAST_TOKEN is set. */
function auth(): { headers?: Record<string, string> } {
  const headers = worldcastHeaders();
  return Object.keys(headers).length ? { headers } : {};
}

const DATA_URI = /^data:([^;,]+);base64,(.*)$/s;

function fileOf(ref: string): Buffer {
  const m = DATA_URI.exec(ref);
  if (!m) throw new ProviderError("WorldCast got a picture it can't read");
  return Buffer.from(m[2], "base64");
}

export const worldcastProvider: ProviderAdapter = {
  id: "worldcast",
  label: "WorldCast worker",
  isConfigured: () => !!worldcastBase(),
  // Kept as data until the case is made: nothing is sent before submit.
  prepareFile: async (data, contentType) => `data:${contentType || "application/octet-stream"};base64,${data.toString("base64")}`,

  async submit({ input, route }) {
    // The paper's own depth models (Depth Pro, VGGT-Omega), when the worker has them: route endpoint "depth/<model>".
    if (route.endpoint.startsWith("depth/")) {
      const model = route.endpoint.slice(6) as WorkerDepth;
      if (!WORKER_DEPTH.includes(model)) throw new ProviderError("The WorldCast worker doesn't run that model");
      const still = input.images?.[0];
      if (!still) throw new ProviderError("Add the still");
      const id = await submitDepth(model, fileOf(still));
      return { externalId: id, meta: { depth: model }, payload: { job: id, depth: model } };
    }
    const layout = readLayout(input.extra?.worldcast);
    const images = (input.images ?? []).map(fileOf);
    const keys = input.cameraPath ?? [];
    if (keys.length < 2) throw new ProviderError("Pick a path first");
    const { parts } = await buildCase({
      layout,
      images,
      keys,
      prompt: input.prompt,
      seed: input.seed,
      alignedCameras: input.extra?.alignedCameras !== false,
    });
    const id = await submitCase(parts);
    return {
      externalId: id,
      meta: { worldcast: true },
      payload: { job: id, anchors: layout.anchors.map((a) => a.view), parts: parts.map((p) => p.name) },
    };
  },

  async poll({ externalId, meta }) {
    const job = await jobStatus(externalId);
    if (job.status === "succeeded" && typeof meta.depth === "string") return { state: "succeeded", outputs: [{ url: jobDepthUrl(externalId), kind: "image", contentType: "image/png", ...auth(), meta: { role: "depth" } }] };
    if (job.status === "succeeded") return { state: "succeeded", outputs: [{ url: jobVideoUrl(externalId), kind: "video", contentType: "video/mp4", ...auth(), meta: { fps: 15 } }] };
    if (job.status === "failed") return { state: "failed", error: job.error };
    return { state: job.status, ...(job.progress !== undefined && { progress: job.progress }), message: job.message ?? (job.status === "queued" ? "Waiting for the WorldCast worker" : "WorldCast is filming") };
  },

  async cancel({ externalId }) {
    await cancelJob(externalId);
  },

  async test() {
    const h = await worldcastHealth();
    return { ok: h.ok, detail: h.detail };
  },
};
