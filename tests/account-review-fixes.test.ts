import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, TINY_PNG, type FakeComfy } from "./helpers/fake-comfy-runner";
import { tempDir } from "./helpers/temp-dir";
import { authDb, authSecret, setAccountCreatedAt, withoutAccounts } from "./helpers/auth-db";

/**
 * The review of "Your GPU" tools (public sign-up): each test here shows one problem the review found, and stays as the
 * guard against it coming back.
 */

const dir = tempDir("fuobe-account-review-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://owner-comfy.test:8188";
process.env.FUOBE_PUBLIC_SIGNUP = "1";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_ALLOW_PRIVATE_URLS;
delete process.env.FUOBE_ACCOUNT_DISK_FREE_GB;
globalThis.__fuobeTestDiskFree = 1e13;

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response("not stubbed", { status: 599 })) as typeof fetch;

const auth = await import("@/server/auth");
const generationsRoute = await import("@/app/api/generations/route");
const probeRoute = await import("@/app/api/media/probe/route");
const { accountLoraFix, accountRun, getGeneration } = await import("@/server/generations");
const { comfyProvider } = await import("@/server/providers/comfyui");
const { saveFile, readRef, scratchDir, filesRel, absolutePath } = await import("@/server/storage");
const { accountInputProblem } = await import("@/server/account-inputs");
const { ACCOUNT_LIMITS, accountUsage, diskFloorBytes } = await import("@/server/account-files");
const { accountSend, accountSends, inTurn } = await import("@/server/account-send");
const { sweepAccountFiles } = await import("@/server/account-sweep");
const { decodePng, pngPixelLimit, MAX_PNG_PIXELS } = await import("@/server/png");
const { runAsTenant } = await import("@/server/tenant");
const { discardBody, fetchPublic } = await import("@/server/remote-fetch");
const { PRESETS } = await import("@/lib/catalog");
const { db } = await import("@/server/db");
const { resetRates } = await import("@/server/rate");
const { clearAccountLoras } = await import("@/server/account-loras");

let fake: FakeComfy;
let a = "";
let b = "";
let cookie = "";
beforeAll(async () => {
  fake = await startFakeComfy({ loras: [], delayMs: 0 });
  globalThis.__fuobeTestGpuPort = fake.port;
  auth.setPassword("install password");
  a = auth.createAccount("review-a@example.com", "long enough").id;
  b = auth.createAccount("review-b@example.com", "long enough").id;
  auth.setAccountGpu(a, { url: fake.url });
  cookie = `${auth.SESSION_COOKIE}=${auth.createSession(a).value}`;
  // Accounts past their first week, so their files may reach 3 GB (a new account keeps 1 GB).
  for (const id of [a, b]) setAccountCreatedAt(id, auth.accountById(id)!.createdAt - 8 * 24 * 60 * 60_000);
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  globalThis.__fuobeTestGpuPort = undefined;
  globalThis.__fuobeTestDiskFree = undefined;
  globalThis.__fuobeTestDiskSize = undefined;
  await fake.close();
});
beforeEach(() => {
  resetRates();
  clearAccountLoras(a);
  Object.assign(fake.opts, { loras: [], delayMs: 0, drip: false, huge: false, promptId: undefined, missing: undefined, output: "video", layers: undefined, frames: undefined, historyError: undefined, uploadStatus: undefined });
  db().prepare("UPDATE generations SET status = 'canceled' WHERE status IN ('queued', 'running') AND json_extract(request_json, '$.account') IS NOT NULL").run();
});

const json = (url: string, body: unknown) => {
  const text = JSON.stringify(body);
  return new Request(`http://localhost:3000${url}`, { method: "POST", headers: { cookie, host: "localhost:3000", "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) }, body: text });
};

/** A PNG the owner made (no account), and one account A uploaded. */
const OWNER_PNG = Buffer.concat([TINY_PNG, Buffer.from("OWNER-SECRET-PIXELS")]);
const ownerFile = () => saveFile({ data: OWNER_PNG, contentType: "image/png", source: "generation" });
const mine = (account = a) => saveFile({ data: TINY_PNG, contentType: "image/png", source: "upload", accountId: account });
/** "/api/files/uploads/<day>/<mine>.png?/../../../outputs/<day>/<target>.png": one path to check, another to read. */
const crafted = (own: { url: string }, target: { relPath: string }) => `${own.url}?/../../../${target.relPath.split(path.sep).join("/")}`;
const asA = <T,>(fn: () => T): T => {
  const own = accountRun(a, "comfyui");
  if (!("run" in own)) throw new Error(own.error);
  return own.run(fn);
};

async function settle(id: string, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    await globalThis.__fuobeRunner?.tick();
    const g = getGeneration(id, { includeDeleted: true });
    if (!g || (g.status !== "queued" && g.status !== "running") || Date.now() > end) return g;
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe("a '?' in a file reference can't reach another file", () => {
  it("reads the file the check looked up, never the one after '?/../'", async () => {
    const target = ownerFile();
    const own = mine();
    const ref = crafted(own, target);
    // The check and the read take the same path.
    expect(filesRel(ref)).toBe(own.relPath.split(path.sep).join("/"));
    expect(accountInputProblem({ inputs: { images: [ref] } }, a)).toBeNull();
    const read = await asA(() => readRef(ref));
    expect(read.data.equals(TINY_PNG)).toBe(true);
    expect(read.data.includes(Buffer.from("OWNER-SECRET-PIXELS"))).toBe(false);
  });

  it("refuses a reference that steps out of its folder", () => {
    const own = mine();
    const day = path.dirname(own.relPath).split(path.sep).join("/");
    for (const ref of [`/api/files/${day}/../${path.basename(own.relPath)}`, `/api/files/${day}/%2e%2e/x.png`, `/api/files/${day}\\..\\x.png`, `/api/files/${day}//x.png`]) {
      expect(filesRel(ref), ref).toBeNull();
      expect(accountInputProblem({ inputs: { images: [ref] } }, a)?.code, ref).toBe("input-not-allowed");
    }
  });

  it("sends the account's own picture to its ComfyUI, not the owner's, for a run named with '?/../'", async () => {
    const target = ownerFile();
    const own = mine();
    fake.log.length = 0;
    const r = await generationsRoute.POST(json("/api/generations", { feature: "video", modelId: "fuobe-dop", presetId: "motion-zoom-in", prompt: "", inputs: { images: [crafted(own, target)] } }));
    expect(r.status).toBe(201);
    const g = await settle((await r.json()).items[0].id);
    expect(g?.status, g?.error ?? "").toBe("succeeded");
    const up = fake.log.filter((e) => e.path === "/upload/image");
    expect(up.length).toBeGreaterThan(0);
    for (const e of up) expect(e.upload?.includes(Buffer.from("OWNER-SECRET-PIXELS"))).toBe(false);
  });

  it("reads params.extra and a clip check the same way", async () => {
    const target = ownerFile();
    const own = mine();
    const ref = crafted(own, target);
    expect(accountInputProblem({ params: { extra: { audio2: ref } } }, a)).toBeNull();
    const { probeSource } = await import("@/server/shorts");
    // The probe reads the account's own picture (not a clip: no facts), never the owner's file.
    await expect(runAsTenant({ kind: "account", id: a }, () => probeSource(ref))).resolves.toEqual({});
  });
});

describe("an account's big files stay out of its runs", () => {
  it("refuses its own result over an upload's size as a run's input, at the route and when a step reads it", async () => {
    const big = saveFile({ data: Buffer.alloc(ACCOUNT_LIMITS.imageBytes + 1, 1), contentType: "image/png", source: "generation", accountId: a });
    expect(accountInputProblem({ inputs: { images: [big.url] } }, a)).toMatchObject({ status: 413, code: "input-too-big" });
    await expect(asA(() => readRef(big.url))).rejects.toMatchObject({ status: 413, message: expect.stringMatching(/over 25 MB/) });
    // The owner's own reads are as before.
    await expect(readRef(big.url)).resolves.toBeTruthy();
    const r = await generationsRoute.POST(json("/api/generations", { feature: "video", modelId: "fuobe-dop", presetId: "motion-zoom-in", prompt: "", inputs: { images: [big.url] } }));
    expect(r.status).toBe(413);
    expect((await r.json()).code).toBe("input-too-big");
  });
});

describe("the clip check has limits for accounts", () => {
  it("allows 60 a minute, then answers 429", async () => {
    const own = mine();
    const ask = () => probeRoute.POST(json("/api/media/probe", { url: own.url }));
    for (let i = 0; i < 60; i++) expect((await ask()).status).toBe(200);
    const r = await ask();
    expect(r.status).toBe(429);
    expect((await r.json()).error).toMatch(/Wait a moment/);
  });

  it("says a clip is too big rather than reading it", async () => {
    const big = saveFile({ data: Buffer.alloc(ACCOUNT_LIMITS.videoBytes + 1, 1), contentType: "video/mp4", source: "generation", accountId: a });
    const r = await probeRoute.POST(json("/api/media/probe", { url: big.url }));
    expect(r.status).toBe(413);
    expect((await r.json()).error).toMatch(/over 95 MB/);
  });
});

describe("an account's ComfyUI can't make the server download without end", () => {
  async function pollAs(workflowId: string) {
    fake.opts.promptId = `job-${workflowId}-${Date.now()}`;
    await realFetch(`${fake.url}/prompt`, { method: "POST", body: JSON.stringify({ prompt: {} }) });
    const externalId = fake.opts.promptId;
    fake.log.length = 0;
    return asA(() => comfyProvider.poll({ externalId, meta: { workflowId, generationId: `g-${workflowId}` } } as never));
  }

  it("M-7: never decodes an account's layers on the server (each 40 MP layer froze it for over a second)", async () => {
    fake.opts.layers = 300;
    const res = await pollAs("layers-qwen-image-layered");
    expect(res.state).toBe("succeeded");
    // Nothing is fetched to find a layer's box: the layers stay links (saved later, straight to disk, 16 at most).
    expect(fake.log.filter((e) => e.path.startsWith("/view")).length).toBe(0);
    const outs = (res as { outputs: { url: string; meta?: { bbox?: unknown } }[] }).outputs;
    expect(outs.filter((o) => o.meta?.bbox).length).toBe(0);
    expect(outs.some((o) => o.url.startsWith("data:"))).toBe(false);
  });

  it("refuses an EXR export with more frames than a clip has, before downloading any", async () => {
    fake.opts.frames = ACCOUNT_LIMITS.framesPerJob + 1;
    const res = await pollAs("video-export-exr");
    expect(res).toMatchObject({ state: "failed", error: expect.stringMatching(/EXR frames.*export a shorter clip/) });
    expect(fake.log.filter((e) => e.path.startsWith("/view")).length).toBe(0);
  });

  it("stops the frames at what the account's files have room for, and leaves no zip", async () => {
    fake.opts.frames = 3;
    const filler = saveFile({ data: Buffer.alloc(16), contentType: "image/png", source: "generation", accountId: a });
    // 6 bytes left: the first frame (4 bytes) fits, the second doesn't.
    db().prepare("UPDATE assets SET size = ? WHERE id = ?").run(ACCOUNT_LIMITS.totalBytes - 6 - (accountUsage(a).total - 16), filler.id);
    try {
      const before = fs.readdirSync(scratchDir()).filter((f) => f.endsWith(".zip")).length;
      const res = await pollAs("video-export-exr");
      expect(res).toMatchObject({ state: "failed", error: expect.stringMatching(/reached 3 GB/) });
      expect(fs.readdirSync(scratchDir()).filter((f) => f.endsWith(".zip")).length).toBe(before);
    } finally {
      db().prepare("DELETE FROM assets WHERE id = ?").run(filler.id);
    }
  });

  it("saves a result only up to what the account's files have room for", async () => {
    fake.opts.huge = true;
    const filler = saveFile({ data: Buffer.alloc(16), contentType: "image/png", source: "generation", accountId: a });
    // 1 MB left: the result streams without end.
    db().prepare("UPDATE assets SET size = ? WHERE id = ?").run(ACCOUNT_LIMITS.totalBytes - 2 ** 20 - (accountUsage(a).total - 16), filler.id);
    try {
      const own = mine();
      const r = await generationsRoute.POST(json("/api/generations", { feature: "video", modelId: "fuobe-dop", presetId: "motion-zoom-in", prompt: "", inputs: { images: [own.url] } }));
      expect(r.status).toBe(201);
      const id = (await r.json()).items[0].id as string;
      const g = await settle(id);
      expect(g?.status).toBe("failed");
      expect(g?.error).toMatch(/reached 3 GB/);
      expect(fs.readdirSync(scratchDir()).filter((f) => f.startsWith(`${id}-out-`))).toEqual([]);
    } finally {
      db().prepare("DELETE FROM assets WHERE id = ?").run(filler.id);
    }
  });
});

describe("an answer that won't be read lets its connection go", () => {
  it("closes the socket of an error answer at once (fetchPublic + discardBody, and the ComfyUI poll)", async () => {
    let closed = 0;
    const server = http.createServer((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.write("x");
      res.on("close", () => closed++);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const was = globalThis.__fuobeTestGpuPort;
    globalThis.__fuobeTestGpuPort = port;
    try {
      const res = await fetchPublic(`http://127.0.0.1:${port}/history/x`, {}, { deadlineMs: 60_000 });
      expect(res.status).toBe(500);
      discardBody(res);
      await new Promise((r) => setTimeout(r, 300));
      expect(closed).toBe(1);
      // A poll against a ComfyUI that answers /history with an error and then nothing.
      const run = accountRun(a, "comfyui");
      if (!("run" in run)) throw new Error(run.error);
      auth.setAccountGpu(a, { url: `http://127.0.0.1:${port}` });
      const own = accountRun(a, "comfyui");
      if (!("run" in own)) throw new Error(own.error);
      // In the account's words, the answer's status in the details line.
      await expect(own.run(() => comfyProvider.poll({ externalId: "abc", meta: {} } as never))).rejects.toMatchObject({ message: expect.stringMatching(/couldn't take this run/), trouble: { details: expect.stringMatching(/HTTP 500/) } });
      await new Promise((r) => setTimeout(r, 300));
      expect(closed).toBe(2);
    } finally {
      auth.setAccountGpu(a, { url: fake.url });
      globalThis.__fuobeTestGpuPort = was;
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("the account sweep never wipes accounts on a bad read of the sign-in data", () => {
  it("keeps every account's files when the sign-in data can't be read, has no secret, or lists no accounts", async () => {
    const own = mine(b);
    // The sign-in tables can't be used.
    globalThis.__fuobeAuthTablesError = "a test";
    try {
      expect((await sweepAccountFiles()).accounts).toBe(0);
      expect(fs.existsSync(absolutePath(own.relPath))).toBe(true);
    } finally {
      globalThis.__fuobeAuthTablesError = null;
    }
    // No secret: never an install that held an account.
    const secret = authSecret();
    authDb().prepare("UPDATE auth_install SET secret = ''").run();
    try {
      expect((await sweepAccountFiles()).accounts).toBe(0);
      expect(fs.existsSync(absolutePath(own.relPath))).toBe(true);
    } finally {
      authDb().prepare("UPDATE auth_install SET secret = ?").run(secret);
    }
    // Data put back from before the sign-ups (no accounts in it) while accounts own files here.
    await withoutAccounts(async () => {
      expect((await sweepAccountFiles()).accounts).toBe(0);
      expect(fs.existsSync(absolutePath(own.relPath))).toBe(true);
    });
    // Read whole, a deleted account's files still go.
    const gone = auth.createAccount("review-gone@example.com", "long enough").id;
    const theirs = mine(gone);
    auth.deleteAccount(gone);
    expect((await sweepAccountFiles()).accounts).toBe(1);
    expect(fs.existsSync(absolutePath(theirs.relPath))).toBe(false);
    expect(fs.existsSync(absolutePath(own.relPath))).toBe(true);
  });

  it("removes a result's download and a zip left behind, after six hours", async () => {
    const stale = path.join(scratchDir(), "gen-out-abcdefgh");
    const zip = path.join(scratchDir(), "gen-abcdef.zip");
    const fresh = path.join(scratchDir(), "gen2-out-abcdefgh");
    for (const f of [stale, zip, fresh]) fs.writeFileSync(f, "x");
    const old = new Date(Date.now() - 7 * 60 * 60_000);
    fs.utimesSync(stale, old, old);
    fs.utimesSync(zip, old, old);
    await sweepAccountFiles();
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(zip)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    fs.rmSync(fresh, { force: true });
  });
});

describe("one slow account can't hold every file send", () => {
  it("sends one file at a time per account, and hands a free slot to an account that isn't sending", async () => {
    const gates: (() => void)[] = [];
    const slow = (who: string) => accountSend(who, () => new Promise<string>((r) => gates.push(() => r(who))));
    const a1 = slow("A");
    const a2 = slow("A");
    const a3 = slow("A");
    await new Promise((r) => setTimeout(r, 10));
    expect(accountSends()).toMatchObject({ total: 1, busy: { A: 1 } });
    const b1 = accountSend("B", async () => "B");
    expect(await b1).toBe("B");
    gates.shift()!();
    expect(await a1).toBe("A");
    await new Promise((r) => setTimeout(r, 10));
    expect(accountSends().busy.A).toBe(1);
    gates.shift()!();
    await a2;
    await new Promise((r) => setTimeout(r, 10));
    gates.shift()!();
    await a3;
    expect(accountSends()).toMatchObject({ total: 0, waiting: [] });
  });

  it("takes turns between accounts: one with many waiting goes to the back after each (the 3D finish line too)", async () => {
    const order: string[] = [];
    const job = (who: string) =>
      inTurn("test-turns", 1, who, async () => {
        order.push(who);
        await new Promise((r) => setTimeout(r, 5));
      });
    const all = [job("A"), job("A"), job("A")];
    await new Promise((r) => setTimeout(r, 1));
    all.push(job("B"));
    await Promise.all(all);
    expect(order).toEqual(["A", "B", "A", "A"]);
  });

  it("sends none of a run's other files once one has failed", async () => {
    fake.opts.uploadStatus = 500;
    fake.log.length = 0;
    const pics = [mine(), mine(), mine()];
    const r = await generationsRoute.POST(json("/api/generations", { feature: "image", modelId: "oss-qwen-edit", prompt: "Make the jacket red", inputs: { images: pics.map((p) => p.url) } }));
    expect(r.status, await r.clone().text()).toBe(201);
    const g = await settle((await r.json()).items[0].id);
    expect(g?.status).toBe("failed");
    expect(g?.error).toMatch(/couldn't take this run/);
    expect(g?.trouble?.details).toMatch(/upload/i);
    expect(fake.log.filter((e) => e.path === "/upload/image")).toHaveLength(1);
    expect(accountSends()).toMatchObject({ total: 0, waiting: [] });
  });
});

describe("a Mixed Media effect's first step is checked for its LoRAs before the run is queued", () => {
  it("names the look's LoRA the account's ComfyUI lacks (409), and keeps the fix on a step that fails later", async () => {
    const preset = PRESETS.find((p) => p.open && p.prestep?.open.labels && p.prestep.open.loras?.length);
    expect(preset, "a DoP Mixed Media effect with a LoRA").toBeTruthy();
    const modelId = preset!.open!.modelId;
    const own = mine();
    const req = { feature: "video", modelId, presetId: preset!.id, prompt: "", inputs: { images: [own.url] }, account: a, engine: "open" } as never;
    const fix = await asA(() => accountLoraFix(req));
    const files = (preset!.prestep!.open.loras ?? []).map((l) => l.file);
    expect(fix?.items.map((i) => i.file)).toEqual(expect.arrayContaining(files));
    const r = await generationsRoute.POST(json("/api/generations", { feature: "video", modelId, presetId: preset!.id, prompt: "", inputs: { images: [own.url] } }));
    expect(r.status).toBe(409);
    expect((await r.json()).fix.items.map((i: { file: string }) => i.file)).toEqual(expect.arrayContaining(files));
  });
});

describe("the owner's own work is as before", () => {
  it("keeps the extension of the owner's file name for a type Fuobe doesn't map, never a page's; an account's is .bin", () => {
    expect(saveFile({ data: Buffer.from("%PDF-1.7"), contentType: "application/pdf", name: "brief.pdf", source: "upload" }).relPath).toMatch(/\.pdf$/);
    expect(saveFile({ data: Buffer.from("# notes"), contentType: "application/octet-stream", name: "notes.md", source: "upload" }).relPath).toMatch(/\.md$/);
    expect(saveFile({ data: Buffer.from("<b>"), contentType: "text/html", name: "page.html", source: "upload" }).relPath).toMatch(/\.bin$/);
    expect(saveFile({ data: Buffer.from("%PDF-1.7"), contentType: "application/pdf", name: "brief.pdf", source: "upload", accountId: a }).relPath).toMatch(/\.bin$/);
  });

  it("decodes the owner's large pictures; an account's stop at 40 megapixels", () => {
    expect(pngPixelLimit()).toBeGreaterThanOrEqual(48_000_000);
    expect(runAsTenant({ kind: "account", id: a }, () => pngPixelLimit())).toBe(MAX_PNG_PIXELS);
    // An 8000 x 6000 claim: past the account's limit before anything is inflated.
    const ihdr = Buffer.from(TINY_PNG);
    ihdr.writeUInt32BE(8000, 16);
    ihdr.writeUInt32BE(6000, 20);
    expect(() => runAsTenant({ kind: "account", id: a }, () => decodePng(ihdr))).toThrow(/40 megapixels/);
  });

  it("keeps a share of a small disk free, not a fixed 20 GB, and the owner can set it", () => {
    const GB = 2 ** 30;
    expect(diskFloorBytes(40 * GB)).toBe(4 * GB);
    expect(diskFloorBytes(10 * GB)).toBe(2 * GB);
    expect(diskFloorBytes(2000 * GB)).toBe(20 * GB);
    process.env.FUOBE_ACCOUNT_DISK_FREE_GB = "5";
    try {
      expect(diskFloorBytes(2000 * GB)).toBe(5 * GB);
    } finally {
      delete process.env.FUOBE_ACCOUNT_DISK_FREE_GB;
    }
  });
});
