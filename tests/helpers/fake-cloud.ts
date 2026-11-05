import http from "node:http";

/**
 * Stand-in fal.ai and Replicate servers on 127.0.0.1, for Your keys (an account's own key). Every request is logged
 * with the Authorization header it carried, so a test can prove which key reached the provider, and that the studio's
 * never did for an account. No real key, no paid call. Plain Node and type annotations only, so a smoke script can run
 * it with `node --experimental-strip-types`.
 *
 * What a key gets is scripted per key: "good" (works), "broke" (its balance has run out), "echo" (refused, and the
 * error repeats the request's Authorization header, like a proxy that echoes it), "outage" (503: says nothing about the key).
 * Any other key is refused (401).
 */

export type KeyMode = "good" | "broke" | "echo" | "outage";

export interface CloudRequest {
  method: string;
  path: string;
  authorization?: string;
  body: string;
}

export interface FakeCloud {
  url: string;
  port: number;
  log: CloudRequest[];
  keys: Record<string, KeyMode>;
  /** Polls a job answers queued/running before it finishes (default 2); Infinity: it never finishes. */
  pollsToFinish: number;
  /** While set, the provider holds every submit until it resolves (a slow hand-over). */
  holdSubmits: Promise<void> | null;
  /** The jobs it was asked to cancel. */
  canceled: string[];
  /**
   * Answers a request before anything else when it returns one (busy, down, a model it doesn't have, an input it
   * refuses): its status, body and headers. Null or undefined: the request goes on as usual.
   */
  script: ((r: CloudRequest) => { status: number; body?: unknown; headers?: Record<string, string> } | null | undefined) | null;
  close(): Promise<void>;
}

/** A 1×1 PNG: what every fake job makes (a data: URI, so an account's result is saved without a download). */
export const PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

async function start(handle: (fake: FakeCloud, req: CloudRequest, res: http.ServerResponse, key: string | null) => Promise<void> | void, scheme: "Key" | "Bearer", port = 0): Promise<FakeCloud> {
  const fake = { log: [], keys: {}, pollsToFinish: 2, holdSubmits: null, canceled: [], script: null } as unknown as FakeCloud;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const r: CloudRequest = { method: req.method ?? "GET", path: req.url ?? "/", authorization: req.headers.authorization, body: Buffer.concat(chunks).toString("latin1") };
      fake.log.push(r);
      const said = fake.script?.(r);
      if (said) {
        res.writeHead(said.status, { "Content-Type": "application/json", ...said.headers });
        return res.end(typeof said.body === "string" ? said.body : JSON.stringify(said.body ?? {}));
      }
      const m = new RegExp(`^${scheme} (.+)$`).exec(r.authorization ?? "");
      Promise.resolve(handle(fake, r, res, m ? m[1] : null)).catch((e) => json(res, 500, { detail: String(e) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  fake.port = addr.port;
  fake.url = `http://127.0.0.1:${addr.port}`;
  fake.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return fake;
}

/** Refuse a request whose key isn't "good": 401, or 403 for an empty balance, or a 401 that echoes the header. */
function refused(fake: FakeCloud, r: CloudRequest, res: http.ServerResponse, key: string | null, broke: { status: number; detail: string }): boolean {
  const mode = key ? fake.keys[key] : undefined;
  if (mode === "good") return false;
  if (mode === "broke") json(res, broke.status, { detail: broke.detail });
  else if (mode === "outage") json(res, 503, { detail: "Service unavailable" });
  else if (mode === "echo") json(res, 401, { detail: `Invalid credentials: ${r.authorization}` });
  else json(res, 401, { detail: "Unauthorized" });
  return true;
}

const ZERO = "00000000-0000-0000-0000-000000000000";

/** fal.ai: the queue (submit, status, result, cancel) and the REST API's storage upload, on one origin. */
export function startFakeFal(port = 0): Promise<FakeCloud> {
  let n = 0;
  const polls = new Map<string, number>();
  return start(
    async (fake, r, res, key) => {
      const path = r.path.split("?")[0];
      // A file's upload address: the client sends no key there.
      if (r.method === "PUT" && path.startsWith("/upload/")) return json(res, 200, {});
      // Like fal.ai, a status path keeps only the app's first two parts: one with an endpoint's sub-path
      // (/fal-ai/flux/dev/requests/…) is 405 whatever the key.
      if (r.method === "GET" && /^\/[^/]+\/[^/]+\/[^/]+\/requests\//.test(path)) return json(res, 405, {});
      if (refused(fake, r, res, key, { status: 403, detail: "User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing." })) return;
      // The key check: the status of a request that doesn't exist.
      if (path === `/fal-ai/flux/requests/${ZERO}/status`) return json(res, 404, { status: "NOT_FOUND" });
      if (r.method === "POST" && path === "/storage/upload/initiate") {
        const id = ++n;
        return json(res, 200, { upload_url: `${fake.url}/upload/${id}`, file_url: `${fake.url}/files/${id}` });
      }
      const job = /^\/(.+)\/requests\/([^/]+)(\/status|\/cancel)?$/.exec(path);
      if (job) {
        const [, , id, tail] = job;
        if (tail === "/cancel" && r.method === "PUT") {
          fake.canceled.push(id);
          return json(res, 202, { status: "CANCELLATION_REQUESTED" });
        }
        if (tail === "/status") {
          const seen = (polls.get(id) ?? 0) + 1;
          polls.set(id, seen);
          if (seen > fake.pollsToFinish) return json(res, 200, { status: "COMPLETED", logs: [] });
          return json(res, 200, seen === 1 ? { status: "IN_QUEUE", queue_position: 0 } : { status: "IN_PROGRESS", logs: [{ message: "50%" }] });
        }
        return json(res, 200, { images: [{ url: PNG_DATA_URI, content_type: "image/png" }] });
      }
      if (r.method === "POST") {
        if (fake.holdSubmits) await fake.holdSubmits;
        const id = `fal-${++n}`;
        // fal's status paths drop an endpoint's sub-path: the app's first two parts.
        const app = path.split("/").slice(1, 3).join("/");
        const base = `${fake.url}/${app}/requests/${id}`;
        return json(res, 200, { request_id: id, status_url: `${base}/status`, response_url: base, cancel_url: `${base}/cancel` });
      }
      json(res, 404, { detail: "Not found" });
    },
    "Key",
    port,
  );
}

/** Replicate: predictions (both forms), polls, cancels, files and the account check. */
export function startFakeReplicate(port = 0): Promise<FakeCloud> {
  let n = 0;
  const polls = new Map<string, number>();
  return start(
    async (fake, r, res, key) => {
      const path = r.path.split("?")[0];
      if (refused(fake, r, res, key, { status: 402, detail: "You have insufficient credit to run this model. Go to https://replicate.com/account/billing to purchase credit." })) return;
      if (r.method === "GET" && path === "/v1/account") return json(res, 200, { type: "user", username: "alice" });
      if (r.method === "POST" && path === "/v1/files") return json(res, 201, { id: `file-${++n}`, urls: { get: `${fake.url}/v1/files/file-${n}` } });
      const cancel = /^\/v1\/predictions\/([^/]+)\/cancel$/.exec(path);
      if (cancel && r.method === "POST") {
        fake.canceled.push(cancel[1]);
        return json(res, 200, { id: cancel[1], status: "canceled" });
      }
      const one = /^\/v1\/predictions\/([^/]+)$/.exec(path);
      if (one && r.method === "GET") {
        const seen = (polls.get(one[1]) ?? 0) + 1;
        polls.set(one[1], seen);
        if (seen > fake.pollsToFinish) return json(res, 200, { id: one[1], status: "succeeded", output: [PNG_DATA_URI] });
        return json(res, 200, seen === 1 ? { id: one[1], status: "starting" } : { id: one[1], status: "processing", logs: "50%" });
      }
      if (r.method === "POST" && (path === "/v1/predictions" || /^\/v1\/models\/[^/]+\/[^/]+\/predictions$/.test(path))) {
        if (fake.holdSubmits) await fake.holdSubmits;
        return json(res, 201, { id: `rep-${++n}`, status: "starting" });
      }
      json(res, 404, { detail: "Not found" });
    },
    "Bearer",
    port,
  );
}

/** Every logged request that carried a key carried one of `allowed` (and the log isn't empty when `some` is set). */
export function keysSeen(log: CloudRequest[]): string[] {
  return [...new Set(log.map((r) => r.authorization ?? "(none)"))];
}
