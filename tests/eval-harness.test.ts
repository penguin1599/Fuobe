import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tempDir } from "./helpers/temp-dir";

/**
 * The evaluation harness (scripts/eval) end to end against Fuobe's real route handlers, served over
 * HTTP the way a running Fuobe serves them, with the demo provider (no keys, no GPU): plan, price,
 * upload, submit, wait, download, record; then report, blind review, compare and promote.
 */

vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const dir = tempDir("fuobe-eval-harness-");
const results = path.join(dir, "results");
process.env.FUOBE_DATA_DIR = path.join(dir, "data");
process.env.COMFYUI_URL = "http://127.0.0.1:9";
process.env.OLLAMA_URL = "http://127.0.0.1:9";

const { setSetting } = await import("@/server/settings");
const { getElement } = await import("@/server/elements");
const status = await import("@/app/api/status/route");
const models = await import("@/app/api/models/route");
const generations = await import("@/app/api/generations/route");
const generation = await import("@/app/api/generations/[id]/route");
const uploads = await import("@/app/api/uploads/route");
const files = await import("@/app/api/files/[...path]/route");
const elements = await import("@/app/api/elements/route");
const element = await import("@/app/api/elements/[id]/route");
const genjutsu = await import("@/app/api/genjutsu/route");
const genjutsuEstimate = await import("@/app/api/genjutsu/estimate/route");
const mixedEstimate = await import("@/app/api/mixed-media/estimate/route");
const shortsEstimate = await import("@/app/api/shorts/estimate/route");
const shortsSessions = await import("@/app/api/shorts/sessions/route");
const paletteLock = await import("@/app/api/palettes/lock/route");
const evolution = await import("@/app/api/evolution/route");
const evolutionEstimate = await import("@/app/api/evolution/estimate/route");
const restore = await import("@/app/api/restore/route");
const restoreEstimate = await import("@/app/api/restore/estimate/route");

// The harness is plain ESM JavaScript (it runs with node, no build step).
const evalCli = (await import("../scripts/eval/eval.mjs")) as { main: (argv: string[], io?: object) => Promise<number> };
const cases = (await import("../scripts/eval/lib/cases.mjs")) as {
  loadSuite: (n: string) => Record<string, unknown> & { cases: { presetId?: string }[]; decides?: string };
  validateAll: () => { ok: boolean; file: string; suite?: string; runFirst?: string; lines: string[] }[];
};
const runner = (await import("../scripts/eval/lib/run.mjs")) as {
  runEval: (opts: object, io: object) => Promise<Record<string, unknown>>;
  routeResult: (answer: unknown, how?: string) => { id: string }[];
  lorasMissing: (jobs: object[], installed: string[] | null) => { file: string; url?: string; jobs: number }[] | null;
  trainingPrice: (target: { price?: string } | null) => number | null;
};
const plan = (await import("../scripts/eval/lib/plan.mjs")) as { expandJobs: (suite: object, opts: object) => { request: Record<string, unknown> & { loras?: unknown[] } }[] };
const report = (await import("../scripts/eval/lib/report.mjs")) as { writeReport: (dir: string, root: string) => Record<string, unknown> };
const review = (await import("../scripts/eval/lib/review.mjs")) as {
  writeReview: (run: object, opts?: object) => { pairs: number };
  serveReview: (dir: string, opts?: object) => Promise<{ server: http.Server; url: string }>;
};
const compare = (await import("../scripts/eval/lib/compare.mjs")) as { promote: (dir: string, opts?: object) => { candidate: string; results: { caseId: string; verdict: string; reasons: string[]; notes: string[]; mainMetric: string }[] } };
const store = (await import("../scripts/eval/lib/store.mjs")) as { latestJobs: (d: string) => Row[]; readJsonl: (f: string) => Record<string, unknown>[] };
const { createClient } = (await import("../bin/lib/client.mjs")) as { createClient: (t: { url: string }) => unknown };

type Row = Record<string, unknown> & { id: string; status: string; variant: string; key: string; caseId: string; outputs?: { file: string; kind: string }[]; recipe?: Record<string, unknown>; request?: Record<string, unknown> };

const ctx = (params: Record<string, unknown>) => ({ params: Promise.resolve(params) }) as never;
const ROUTES: [string, RegExp, (req: Request, m: RegExpExecArray) => Promise<Response>][] = [
  ["GET", /^\/api\/status$/, () => status.GET()],
  ["GET", /^\/api\/models$/, (r) => models.GET(r)],
  ["POST", /^\/api\/generations$/, (r) => generations.POST(r)],
  ["GET", /^\/api\/generations\/([^/]+)$/, (r, m) => generation.GET(r, ctx({ id: m[1] }))],
  ["DELETE", /^\/api\/generations\/([^/]+)$/, (r, m) => generation.DELETE(r, ctx({ id: m[1] }))],
  ["POST", /^\/api\/uploads$/, (r) => uploads.POST(r)],
  ["GET", /^\/api\/files\/(.+)$/, (r, m) => files.GET(r, ctx({ path: m[1].split("/").map(decodeURIComponent) }))],
  ["POST", /^\/api\/elements$/, (r) => elements.POST(r)],
  ["GET", /^\/api\/elements\/([^/]+)$/, (r, m) => element.GET(r, ctx({ id: m[1] }))],
  ["POST", /^\/api\/genjutsu$/, (r) => genjutsu.POST(r)],
  ["POST", /^\/api\/genjutsu\/estimate$/, (r) => genjutsuEstimate.POST(r)],
  ["POST", /^\/api\/mixed-media\/estimate$/, (r) => mixedEstimate.POST(r)],
  ["POST", /^\/api\/shorts\/estimate$/, (r) => shortsEstimate.POST(r)],
  ["POST", /^\/api\/shorts\/sessions$/, (r) => shortsSessions.POST(r)],
  ["POST", /^\/api\/palettes\/lock$/, (r) => paletteLock.POST(r)],
  ["POST", /^\/api\/evolution$/, (r) => evolution.POST(r)],
  ["POST", /^\/api\/evolution\/estimate$/, (r) => evolutionEstimate.POST(r)],
  ["POST", /^\/api\/restore$/, (r) => restore.POST(r)],
  ["POST", /^\/api\/restore\/estimate$/, (r) => restoreEstimate.POST(r)],
];

let server: http.Server;
let base = "";
const seen: string[] = [];

beforeAll(async () => {
  setSetting("demoMode", "auto");
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fuobe.test");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    seen.push(`${req.method} ${url.pathname}`);
    const route = ROUTES.find(([method, re]) => method === req.method && re.test(url.pathname));
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "Not found" }));
    }
    const body = chunks.length && req.method !== "GET" ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://localhost${url.pathname}${url.search}`, { method: req.method, headers: req.headers as Record<string, string>, body });
    try {
      const answer = await route[2](request, route[1].exec(url.pathname)!);
      res.writeHead(answer.status, Object.fromEntries(answer.headers));
      res.end(Buffer.from(await answer.arrayBuffer()));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

const sink = () => {
  let text = "";
  const stream = new Writable({
    write(chunk, _enc, done) {
      text += chunk.toString();
      done();
    },
  });
  return { stream, text: () => text };
};

/** The harness's own command line, as `pnpm eval:<command>` runs it, against the bridged server. */
async function cli(argv: string[]) {
  const out = sink();
  const err = sink();
  const code = await evalCli.main(argv, { stdout: out.stream, stderr: err.stream, env: { ...process.env, FUOBE_EVAL_RESULTS: results, FUOBE_URL: base, FUOBE_CONFIG: path.join(dir, "no-config.json"), FUOBE_EVAL_PYTHON: "/nonexistent/python" } });
  return { code, stdout: out.text(), stderr: err.text() };
}

const runIdFrom = (text: string) => /Run (\S+):/.exec(text)?.[1] ?? "";

describe("case files", () => {
  it("every suite in scripts/eval/cases validates, and the generated ones match the research", async () => {
    const all = cases.validateAll();
    expect(all.filter((r) => !r.ok).map((r) => `${r.file}: ${r.lines.join("; ")}`)).toEqual([]);
    expect(all.length).toBeGreaterThanOrEqual(9);
    const v = await cli(["validate"]);
    expect(v.code, v.stdout).toBe(0);
    const soul = cases.loadSuite("soul") as { cases: { id: string; look: string }[] };
    expect(soul.cases).toHaveLength(139);
  });

  it("refuses a malformed suite with the path to each problem", () => {
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, JSON.stringify({ suite: "Bad Name", title: "x", description: "x", original: "x", kind: "image", targets: {}, cases: [{ id: "a", title: "a", prompts: [{ text: "p", seed: -1 }], look: "v1-general" }, { id: "a", title: "dup" }] }));
    let message = "";
    try {
      cases.loadSuite(bad);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/suite: lower-case letters/);
    expect(message).toMatch(/targets: name a target for at least one engine/);
    expect(message).toMatch(/cases\[0\]\.prompts\[0\]\.seed/);
    expect(message).toMatch(/duplicate case id a/);
    expect(message).toMatch(/a look needs "recipe": "soul-look"/);
  });

  it("refuses a route body that names an input the case's inputs or demo inputs don't have", () => {
    const bad = path.join(dir, "bad-inputs.json");
    const kase = (demo: string[]) => ({
      id: `x/${demo.length}`,
      title: "x",
      inputs: { images: ["local/x/a.png", "local/x/b.png"] },
      demoInputs: { images: demo },
      submit: { route: "/api/x", body: { refs: ["{{inputs.images.0}}", "{{inputs.images.1}}"], video: "{{source:inputs.video}}" } },
    });
    fs.writeFileSync(bad, JSON.stringify({ suite: "bad-inputs", title: "x", description: "x", original: "x", kind: "video", targets: { demo: { models: ["x"] } }, cases: [kase(["fixtures/a.png"])] }));
    let message = "";
    try {
      cases.loadSuite(bad);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/cases\[0\]\.demoInputs: the route body names \{\{inputs\.images\.1\}\}, which demoInputs doesn't have/);
    expect(message).toMatch(/cases\[0\]\.inputs: the route body names \{\{source:inputs\.video\}\}, which inputs doesn't have/);
  });
});

describe("the runner on the demo provider", () => {
  let selftestRun = "";

  it("runs the self-test suite through the API: uploads, submits, waits, downloads and records each job", async () => {
    const r = await cli(["run", "--suite", "selftest", "--engine", "demo", "--label", "e2e"]);
    expect(r.code, r.stderr).toBe(0);
    selftestRun = runIdFrom(r.stderr);
    const runDir = path.join(results, selftestRun);
    const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
    expect(run).toMatchObject({ suite: "selftest", engine: "demo", label: "e2e", server: { url: base, demoMode: "auto" }, results: { succeeded: 5, failed: 0 } });
    expect(run.harness.recipes.sha).toMatch(/^[0-9a-f]{16}$/);
    const rows = store.latestJobs(runDir);
    expect(rows.map((x) => x.status)).toEqual(Array(5).fill("succeeded"));
    for (const row of rows) {
      expect(row.outputs?.length, row.id).toBeGreaterThan(0);
      for (const o of row.outputs!) expect(fs.statSync(path.join(runDir, o.file)).size).toBeGreaterThan(0);
      expect(row).toMatchObject({ model: { demo: true, provider: "mock" }, costUsd: { estimate: 0 } });
      expect((row.timing as { wallMs: number }).wallMs).toBeGreaterThan(0);
    }
    // Inputs went up once each and the requests carried the server's URLs.
    const trim = rows.find((x) => x.caseId === "selftest/trim")!;
    expect((trim.request!.inputs as { video: string }).video).toMatch(/^\/api\/files\/uploads\//);
    expect(seen.filter((s) => s === "POST /api/uploads").length).toBeGreaterThanOrEqual(3);
    // Scoring had no Python here: the report says so instead of failing.
    expect(r.stderr).toMatch(/Not scored: Couldn't start \/nonexistent\/python|Not scored/);
    const summary = JSON.parse(fs.readFileSync(path.join(runDir, "summary.json"), "utf8"));
    expect(summary.counts).toMatchObject({ jobs: 5, succeeded: 5 });
    expect(fs.readFileSync(path.join(runDir, "report.html"), "utf8")).toContain("Harness self-test");
    expect(r.stdout).toMatch(/Harness self-test · demo · 5\/5 done · Free/);
  });

  it("runs Soul HEX's palette lock end to end: Fuobe Soul, then the lock step, whose picture is the result", async () => {
    const r = await cli(["run", "--suite", "soul-hex", "--engine", "demo", "--cases", "soul-hex/candy-pop", "--variants", "words,lock", "--prompts", "1", "--no-metrics"]);
    expect(r.code, r.stderr).toBe(0);
    const rows = store.latestJobs(path.join(results, runIdFrom(r.stderr)));
    expect(rows.map((x) => [x.variant, x.status])).toEqual([["words", "succeeded"], ["lock", "succeeded"]]);
    const lock = rows.find((x) => x.variant === "lock")!;
    const body = (lock.request as { route: string; body: { request: { modelId: string; prompt: string }; colors: string[] } }).body;
    expect(lock.request).toMatchObject({ route: "/api/palettes/lock" });
    expect(body.request.modelId).toBe("fuobe-soul");
    expect(body.request.prompt).toMatch(/Color palette: use only these colors/);
    expect(body.colors).toEqual(["#118AB2", "#06D6A0", "#FF5DA2", "#FFD166", "#FDF6EC"]);
    expect((lock as { steps?: string[] }).steps).toHaveLength(2);
  });

  it("records the recipe a Soul look ran with: the look's words, its LoRAs at each variant's strength, and what the route loads", async () => {
    const r = await cli(["run", "--suite", "soul", "--engine", "demo", "--looks", "v2-flash-editorial", "--variants", "recipe,prompt-only,half-strength", "--prompts", "1", "--no-metrics"]);
    expect(r.code, r.stderr).toBe(0);
    const runDir = path.join(results, runIdFrom(r.stderr));
    const rows = store.latestJobs(runDir);
    expect(rows).toHaveLength(3);
    const by = Object.fromEntries(rows.map((x) => [x.variant, x]));
    const sent = (v: string) => (by[v].request!.loras as { file: string; strength: number }[] | undefined) ?? [];
    expect(sent("recipe").map((l) => l.strength)).toEqual([0.7, 0.4]);
    expect(sent("half-strength").map((l) => l.strength)).toEqual([0.35, 0.2]);
    expect(sent("prompt-only")).toEqual([]);
    expect(String(by.recipe.request!.prompt)).toMatch(/^hardflashy, a young woman .*Direct on-camera flash/);
    // The preview named the open route, and ComfyUI loads every LoRA the harness sent.
    expect(by.recipe.route).toEqual({ provider: "comfyui", endpoint: "z-image-turbo-t2i" });
    expect(by.recipe.recipe).toMatchObject({ kind: "soul-look", look: { name: "Flash editorial", family: "v2" }, complete: true, dropped: [] });
    expect((by.recipe.recipe!.applied as unknown[]).length).toBe(2);
    expect(by.recipe.seed).toBe(1001);
  });

  it("runs a studio route (Genjutsu) with a probed source clip and a stable requestId", async () => {
    const r = await cli(["run", "--suite", "genjutsu", "--engine", "demo", "--cases", "genjutsu/move", "--no-metrics"]);
    expect(r.code, r.stderr).toBe(0);
    const [row] = store.latestJobs(path.join(results, runIdFrom(r.stderr)));
    expect(row.status).toBe("succeeded");
    const body = (row.request as { route: string; body: Record<string, unknown> }).body;
    expect((row.request as { route: string }).route).toBe("/api/genjutsu");
    expect(body).toMatchObject({ engine: "open", mode: "motion", modelId: "fuobe-genjutsu-motion", seed: 1001 });
    expect(String(body.requestId)).toMatch(/^eval-[0-9a-f]{24}$/);
    expect((body.source as { url: string }).url).toMatch(/^\/api\/files\//);
    if (fs.existsSync("/usr/bin/ffprobe")) expect(body.source).toMatchObject({ fps: 24, width: 432, height: 768, duration: 4 });
    expect(row.outputs?.[0]?.kind).toBe("video");
  });

  it("runs a Shorts session through its route and measures the stitched clip", async () => {
    const r = await cli(["run", "--suite", "shorts", "--engine", "demo", "--cases", "shorts/session", "--seeds", "1001", "--no-metrics"]);
    expect(r.code, r.stderr).toBe(0);
    const [row] = store.latestJobs(path.join(results, runIdFrom(r.stderr)));
    expect(row.status, JSON.stringify(row)).toBe("succeeded");
    expect((row.request as { route: string }).route).toBe("/api/shorts/sessions");
    expect((row.request as { body: Record<string, unknown> }).body).toMatchObject({ engine: "open", modelId: "fuobe-shorts", presetId: "shorts-claymation", range: { start: 0, end: 6 } });
    expect(row.outputs?.[0]?.kind).toBe("video");
  });

  it("runs Fuobe Evolution's suite on the demo provider: two references a case, three for the written direction", async () => {
    const r = await cli(["run", "--suite", "evolution", "--engine", "demo", "--cases", "evolution/low,evolution/written", "--no-metrics"]);
    expect(r.code, r.stderr).toBe(0);
    const rows = store.latestJobs(path.join(results, runIdFrom(r.stderr)));
    expect(rows.map((x) => [x.caseId, x.status]).sort()).toEqual([
      ["evolution/low", "succeeded"],
      ["evolution/written", "succeeded"],
    ]);
    const body = (id: string) => (rows.find((x) => x.caseId === id)!.request as { body: Record<string, unknown> }).body;
    expect(body("evolution/low")).toMatchObject({ engine: "open", intensity: "low" });
    expect(body("evolution/low").references).toHaveLength(2);
    expect(body("evolution/written").references).toHaveLength(3);
    expect(body("evolution/written").direction).toBeUndefined();
    expect(rows.every((x) => x.outputs?.[0]?.kind === "video")).toBe(true);
  });

  it("runs Fuobe Restore's suite on the demo provider: your words, and words written for the clip", async () => {
    const r = await cli(["run", "--suite", "restore", "--engine", "demo", "--no-metrics"]);
    expect(r.code, r.stderr).toBe(0);
    const rows = store.latestJobs(path.join(results, runIdFrom(r.stderr)));
    expect(rows.map((x) => [x.caseId, x.status]).sort()).toEqual([
      ["restore/words", "succeeded"],
      ["restore/written", "succeeded"],
    ]);
    const body = (id: string) => (rows.find((x) => x.caseId === id)!.request as { body: Record<string, unknown> }).body;
    expect(body("restore/words")).toMatchObject({ engine: "open", prompt: expect.stringMatching(/natural colour$/) });
    expect(body("restore/written")).toMatchObject({ engine: "open", hint: "a street, 1930s" });
    expect(body("restore/written").prompt).toBeUndefined();
    expect(rows.every((x) => x.outputs?.[0]?.kind === "video")).toBe(true);
  });

  it("runs Genjutsu's Character swap on the 6 s fixture clip: the part, the character, who to swap", async () => {
    const r = await cli(["run", "--suite", "genjutsu", "--engine", "demo", "--cases", "genjutsu/character,genjutsu/character-plain", "--no-metrics"]);
    expect(r.code, r.stderr).toBe(0);
    const rows = store.latestJobs(path.join(results, runIdFrom(r.stderr)));
    expect(rows.map((x) => [x.caseId, x.status]).sort()).toEqual([
      ["genjutsu/character", "succeeded"],
      ["genjutsu/character-plain", "succeeded"],
    ]);
    const body = (rows.find((x) => x.caseId === "genjutsu/character")!.request as { body: Record<string, unknown> }).body;
    expect(body).toMatchObject({ mode: "character", modelId: "fuobe-character-swap", range: { start: 0, end: 5 }, character: { who: "largest" } });
    if (fs.existsSync("/usr/bin/ffprobe")) expect(body.source).toMatchObject({ duration: 6, width: 432, height: 768 });
  });

  it("a training case in a demo run makes an element from the fixtures and @mentions it (no training)", async () => {
    const r = await cli(["run", "--suite", "soul-id", "--engine", "demo", "--cases", "soul-id/character,soul-id/look", "--prompts", "1", "--variants", "trained", "--no-metrics"]);
    const runDir = path.join(results, runIdFrom(r.stderr));
    const elements = JSON.parse(fs.readFileSync(path.join(runDir, "elements.json"), "utf8"));
    const el = elements["soul-id/character"];
    expect(el).toMatchObject({ status: "demo", photos: 3 });
    const rows = store.latestJobs(runDir);
    const prompt = (caseId: string) => String((rows.find((x) => x.caseId === caseId)!.request as { prompt: string }).prompt);
    expect(prompt("soul-id/character")).toContain(`@${el.handle} as a chef`);
    // The look case makes a style element (no consent line), @mentioned on Fuobe Soul.
    expect(elements["soul-id/look"]).toMatchObject({ status: "demo", photos: 2 });
    expect(prompt("soul-id/look")).toContain(`@${elements["soul-id/look"].handle} a lighthouse`);
    // The trained style is the look, as the app runs a trained moodboard: none of Soul's own look LoRAs under it.
    expect((rows.find((x) => x.caseId === "soul-id/look")!.request as { presetId?: string }).presetId).toBe("own-style");
    const look = getElement(elements["soul-id/look"].id);
    expect(look?.kind).toBe("style");
  });

  it("runs each Genjutsu mode's own partner model on fal", async () => {
    type Plan = { jobs: { case: string; variant: string; model: string; skip?: string; costUsd?: number | null }[] };
    const dry = async (args: string[]) => JSON.parse((await cli(["run", ...args, "--dry-run", "--json"])).stdout) as Plan;
    setSetting("falKey", "fal-test-key");
    // Group swap, Scene edit, From picture and Finish run on your GPU only: on the cloud their jobs say so and skip.
    const cloud = (p: Plan) => {
      const gpu = p.jobs.filter((j) => j.skip === "runs on open only");
      expect(gpu.map((j) => j.case)).toEqual([
        "genjutsu/group",
        "genjutsu/group-one-by-one",
        "genjutsu/scene-change",
        "genjutsu/scene-remove",
        "genjutsu/scene-background",
        "genjutsu/picture",
        "genjutsu/picture-golden-halo",
        "genjutsu/fix-faces",
        "genjutsu/fix-colours",
      ]);
      return p.jobs.filter((j) => !gpu.includes(j));
    };
    try {
      // With fal connected, each mode runs its own partner on fal.
      const g = await dry(["--suite", "genjutsu", "--engine", "cloud", "--variants", "partner", "--allow-fixtures"]);
      expect(cloud(g).map((j) => [j.case, j.model, j.skip ?? null])).toEqual([
        ["genjutsu/move", "kling-motion-control", null],
        // A case with no partner of its own runs its own models (the -lite tiers, the Original without its first frame).
        ["genjutsu/move-lite", "fuobe-genjutsu-motion-lite", null],
        // Character swap's partner: MiniMax's own Recast on fal.
        ["genjutsu/character", "h3-max-recast", null],
        ["genjutsu/character-plain", "fuobe-character-swap", null],
        // The fixture clip is 768×432: Kling O3's edit wants 720 px on each side (your street.mp4 must be that big).
        ["genjutsu/swap", "kling-o3", expect.stringMatching(/at least 720 px on each side/)],
        ["genjutsu/swap-lite", "fuobe-genjutsu-swap-lite", null],
        ["genjutsu/restyle", "kling-o3-4k-edit", null],
      ]);
      // The Originals on the cloud: their hosted open halves on fal.
      const o = await dry(["--suite", "genjutsu", "--engine", "cloud", "--variants", "original", "--allow-fixtures"]);
      expect(cloud(o).map((j) => [j.case, j.model, j.skip ?? null])).toEqual([
        ["genjutsu/move", "fuobe-genjutsu-motion", null],
        ["genjutsu/move-lite", "fuobe-genjutsu-motion-lite", null],
        ["genjutsu/character", "fuobe-character-swap", null],
        ["genjutsu/character-plain", "fuobe-character-swap", null],
        ["genjutsu/swap", "fuobe-genjutsu-swap", null],
        ["genjutsu/swap-lite", "fuobe-genjutsu-swap-lite", null],
        ["genjutsu/restyle", "fuobe-genjutsu-restyle", null],
      ]);
      // Mixed Media and Shorts run their Originals on fal (the cloud halves); the partner variant runs Gemini Omni Flash.
      const mm = await dry(["--suite", "mixed-media", "--engine", "cloud", "--cases", "mixed-media/toxic", "--allow-fixtures"]);
      expect(mm.jobs.map((j) => [j.model, j.skip ?? null])).toEqual([["fuobe-mixed-media", null]]);
      // Two seeds a case: one segment from its first frame, and a whole session through the Shorts route.
      const sh = await dry(["--suite", "shorts", "--engine", "cloud", "--allow-fixtures"]);
      expect(sh.jobs.map((j) => [j.case, j.model, j.skip ?? null])).toEqual([
        ["shorts/segment", "fuobe-shorts", null],
        ["shorts/segment", "fuobe-shorts", null],
        ["shorts/session", "fuobe-shorts", null],
        ["shorts/session", "fuobe-shorts", null],
      ]);
      // Clean up dialogue's hosted cleaners: planned and priced as dry runs, each on its own op.
      // The video case reads your own clip (scripts/eval/local, git-ignored); where there is none, it borrows the fixture
      // clip (a video with sound) for this check, so the case is a video here too, not the audio fixture it falls back to.
      const clip = path.join(process.cwd(), "scripts/eval/local/separation/video/clip.mp4");
      const lent = !fs.existsSync(clip);
      // The first folder this check made (none if the folder was already there): removed afterwards with the clip.
      const made = lent ? fs.mkdirSync(path.dirname(clip), { recursive: true }) : undefined;
      if (lent) fs.copyFileSync(path.join(process.cwd(), "scripts/eval/fixtures/walk-6s.mp4"), clip);
      let sep: Plan;
      try {
        sep = await dry(["--suite", "separation", "--engine", "cloud", "--variants", "clean-veed,clean-deepfilternet,demucs", "--cases", "separation/centre,separation/video", "--allow-fixtures"]);
      } finally {
        if (lent) fs.rmSync(made ?? clip, { recursive: true, force: true });
      }
      expect(sep.jobs.map((j) => [j.case, j.variant, j.model, j.skip ? "refused" : typeof j.costUsd])).toEqual([
        ["separation/centre", "clean-veed", "veed-clean-audio", "number"],
        ["separation/centre", "clean-deepfilternet", "deepfilternet3", "number"],
        ["separation/centre", "demucs", "demucs", "number"],
        // VEED takes a video's file itself; DeepFilterNet 3 and Demucs take audio only.
        ["separation/video", "clean-veed", "veed-clean-audio", "number"],
        ["separation/video", "clean-deepfilternet", "deepfilternet3", "refused"],
        ["separation/video", "demucs", "demucs", "refused"],
      ]);
      const shp = await dry(["--suite", "shorts", "--engine", "cloud", "--variants", "partner", "--seeds", "1001", "--allow-fixtures"]);
      expect(shp.jobs.map((j) => [j.case, j.model, j.skip ?? null])).toEqual([
        ["shorts/segment", "gemini-omni-flash", null],
        ["shorts/session", "gemini-omni-flash", null],
      ]);
      // DoP's Mixed Media effects, blind: the shipped preset on Fuobe DoP against its words on Kling 2.5 Turbo (decided
      // 2026-10-30), the first suite to run once paid keys exist, with the rule it decides by.
      const dmm = await dry(["--suite", "dop-mixed-media", "--engine", "cloud", "--variants", "original,partner", "--seeds", "1001", "--allow-fixtures"]);
      expect(dmm.jobs).toHaveLength(16);
      expect(new Set(dmm.jobs.map((j) => `${j.variant}:${j.model}:${j.skip ?? ""}`))).toEqual(new Set(["original:fuobe-dop:", "partner:kling-2-5-turbo:"]));
      const suite = cases.loadSuite("dop-mixed-media");
      expect(suite).toMatchObject({ runFirst: "paid-keys", defaults: { candidate: "original" } });
      expect(suite.decides).toMatch(/Kling 2\.5 Turbo takes at least two thirds .* goes back to Kling 2\.5 Turbo, in a reviewed code change/);
      expect(cases.validateAll().filter((r) => r.runFirst === "paid-keys").map((r) => r.suite)).toEqual(["dop-mixed-media"]);
      const { getPreset } = await import("@/lib/catalog");
      for (const c of suite.cases) expect(getPreset(c.presetId!)?.cloud?.modelId, c.presetId).toBe("fuobe-dop");
      // A partner variant is a cloud model: on the open engine it would only repeat the Original's run.
      const open = await dry(["--suite", "genjutsu", "--engine", "open", "--variants", "partner", "--allow-fixtures"]);
      expect(open.jobs.every((j) => j.skip === "the partner variant runs on cloud only")).toBe(true);
    } finally {
      setSetting("falKey", "");
    }
  });

  it("runs the separation suite: stems keep their names, and each variant asks for its DBS model and channels", async () => {
    const r = await cli(["run", "--suite", "separation", "--engine", "demo", "--cases", "separation/centre", "--no-metrics"]);
    expect(r.code, r.stderr).toBe(0);
    const rows = store.latestJobs(path.join(results, runIdFrom(r.stderr)));
    expect(rows.map((x) => [x.caseId, x.status])).toEqual([["separation/centre", "succeeded"]]);
    const outs = (rows[0].outputs ?? []) as { kind: string; stem?: string }[];
    // The demo split answers a voice and a background stem, recorded by name for the scorer.
    expect(outs.filter((o) => o.kind === "audio").map((o) => o.stem)).toEqual(expect.arrayContaining(["voice", "background"]));
    const suite = cases.loadSuite("separation") as unknown as { file: string; kind: string; decides: string; description: string };
    expect(suite).toMatchObject({ kind: "audio", defaults: { candidate: "bsrnn-mono", metrics: ["separation", "wer"] } });
    expect(suite.description).toMatch(/DBS-TIGER-DnR Apache-2\.0.*MelBand RoFormer MIT/);
    expect(suite.decides).toMatch(/reviewed code change/);
    const jobs = plan.expandJobs(suite, { engine: "open", variants: ["bsrnn-mono", "bsrnn-stereo", "tiger-mono", "tiger-stereo", "dbs-dub", "melband", "demucs"], cases: ["separation/centre"], exists: () => true }) as unknown as {
      variant: string;
      skip?: string;
      request: { modelId: string; op?: string; params: { extra?: Record<string, unknown> } };
    }[];
    expect(jobs.map((j) => [j.variant, j.request.modelId, j.request.params.extra?.separationModel ?? null, j.request.params.extra?.channels ?? null, j.skip ?? null])).toEqual([
      ["bsrnn-mono", "oss-dbs-separate", "DBS-BSRNN-DnR", "mono", null],
      ["bsrnn-stereo", "oss-dbs-separate", "DBS-BSRNN-DnR", "each channel", null],
      ["tiger-mono", "oss-dbs-separate", "DBS-TIGER-DnR", "mono", null],
      ["tiger-stereo", "oss-dbs-separate", "DBS-TIGER-DnR", "each channel", null],
      ["dbs-dub", "oss-dbs-voice-separate", "DBS-BSRNN-DnR", null, null],
      ["melband", "oss-voice-separate", null, null, null],
      ["demucs", "oss-dbs-separate", null, null, "the demucs variant runs on cloud only"],
    ]);
    expect(jobs.every((j) => j.request.op === "separate-audio")).toBe(true);
    // Clean up dialogue on the open engine: graph C with the music and effects at −18 dB; the cloud cleaners run enhance-voice.
    const clean = plan.expandJobs(suite, { engine: "open", variants: ["clean-dialogue", "clean-veed"], cases: ["separation/hiss"], exists: () => true }) as unknown as typeof jobs;
    expect(clean.map((j) => [j.variant, j.request.modelId, j.request.op, j.request.params.extra ?? null, j.skip ?? null])).toEqual([
      ["clean-dialogue", "oss-dbs-remix", "separate-audio", { separationModel: "DBS-BSRNN-DnR", channels: "mono", voiceDb: 0, musicDb: -18, effectsDb: -18 }, null],
      ["clean-veed", "oss-dbs-separate", "enhance-voice", null, "the clean-veed variant runs on cloud only"],
    ]);
    // The cloud runs Demucs as today's cloud dub does; DBS isn't hosted, so its variants say they run on the open engine.
    const cloud = plan.expandJobs(suite, { engine: "cloud", variants: ["demucs", "bsrnn-mono"], cases: ["separation/centre"], exists: () => true }) as unknown as { variant: string; skip?: string; request: { modelId: string } }[];
    expect(cloud.map((j) => [j.variant, j.request.modelId, j.skip ?? null])).toEqual([
      ["demucs", "demucs", null],
      ["bsrnn-mono", "demucs", "the bsrnn-mono variant runs on open / demo only"],
    ]);
  });

  it("runs the splat suite: Idol 3D's Best and Quick against TripoSplat on the orbit video, the photo crop on photos only", async () => {
    const r = await cli(["run", "--suite", "splat", "--engine", "demo", "--cases", "splat/photo-mug,splat/bottle", "--seeds", "1001", "--variants", "all", "--no-metrics"]);
    expect(r.code, r.stderr).toBe(0);
    const runDir = path.join(results, runIdFrom(r.stderr));
    expect(JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"))).toMatchObject({ suite: "splat", kind: "video", candidate: "idol-best", styleModel: "dinov2" });
    const rows = store.latestJobs(runDir);
    const done = rows.filter((x) => x.status === "succeeded");
    expect(done.map((x) => `${x.caseId} ${x.variant}`).sort()).toEqual(
      ["idol-best", "idol-quick", "idol-photo-crop", "triposplat-today"].map((v) => `splat/photo-mug ${v}`).concat(["idol-best", "idol-quick", "triposplat-today"].map((v) => `splat/bottle ${v}`)).sort(),
    );
    // The demo's splat comes with its turntable, as a real open run comes with the orbit video the scorer and the blind
    // review read.
    for (const row of done) expect((row.outputs as { kind: string }[]).map((o) => o.kind)).toEqual(["model3d", "video"]);
    expect(rows.filter((x) => x.status === "skipped").map((x) => [x.caseId, x.variant, x.skip])).toEqual(
      expect.arrayContaining([
        ["splat/bottle", "idol-photo-crop", "the idol-photo-crop variant runs on cases tagged photo only"],
        ["splat/bottle", "triposplat-cloud", "the triposplat-cloud variant runs on cloud only"],
      ]),
    );
    const suite = cases.loadSuite("splat") as unknown as { decides: string };
    expect(suite.decides).toMatch(/MODELS_3D\.splat\.open.*IDOL_PRESETS\.quick.*photo crop/s);
    type Job = { variant: string; skip?: string; request: { modelId: string; op?: string; params: { extra?: Record<string, unknown> } } };
    const all = ["idol-best", "idol-quick", "triposplat-today", "idol-photo-crop", "triposplat-cloud"];
    const open = plan.expandJobs(suite, { engine: "open", variants: all, cases: ["splat/photo-mug"], seeds: [1], exists: () => true }) as unknown as Job[];
    expect(open.map((j) => [j.variant, j.request.modelId, j.request.op, j.request.params.extra ?? null, j.skip ?? null])).toEqual([
      ["idol-best", "oss-idol", "splat", { steps: 50, sampler: "euler", cfg: 4, numGaussians: 262144 }, null],
      ["idol-quick", "oss-idol", "splat", { steps: 20, sampler: "dpmpp_2m", cfg: 4, numGaussians: 65536 }, null],
      ["triposplat-today", "oss-triposplat", "splat", null, null],
      ["idol-photo-crop", "oss-idol", "splat", { steps: 50, sampler: "euler", cfg: 4, numGaussians: 262144, photoCrop: true, cropMode: "real" }, null],
      ["triposplat-cloud", "oss-idol", "splat", null, "the triposplat-cloud variant runs on cloud only"],
    ]);
    // No Idol on the cloud: only fal's TripoSplat runs there, as itself.
    const cloud = plan.expandJobs(suite, { engine: "cloud", variants: ["triposplat-cloud", "idol-best"], cases: ["splat/bottle"], seeds: [1], exists: () => true }) as unknown as Job[];
    expect(cloud.map((j) => [j.variant, j.request.modelId, j.skip ?? null])).toEqual([
      ["triposplat-cloud", "triposplat", null],
      ["idol-best", "", "the idol-best variant runs on open / demo only"],
    ]);
    // Idol's presets in the suite are the ones the page sends.
    const { IDOL_PRESETS } = await import("@/lib/av/model3d");
    expect(open[0].request.params.extra).toEqual(IDOL_PRESETS.best);
    expect(open[1].request.params.extra).toEqual(IDOL_PRESETS.quick);
    // A variant limited to tags no case has is refused.
    const bad = path.join(dir, "bad-tags.json");
    fs.writeFileSync(bad, JSON.stringify({ suite: "bad-tags", title: "x", description: "x", original: "x", kind: "video", targets: { demo: { models: ["x"] } }, variants: { a: {}, b: { tags: ["photo"] } }, cases: [{ id: "x/1", title: "x", inputs: { images: ["fixtures/start-frame.png"] } }] }));
    expect(() => cases.loadSuite(bad)).toThrow(/variants\.b\.tags: no case is tagged photo/);
  });

  it("runs Fuobe Cinema's Director and camera-move cases, and plans its cloud variants", async () => {
    const r = await cli(["run", "--suite", "cinema", "--engine", "demo", "--cases", "cinema/director-noir,cinema/move-dolly-in", "--no-metrics"]);
    expect(r.code, r.stderr).toBe(0);
    const rows = store.latestJobs(path.join(results, runIdFrom(r.stderr)));
    expect(rows.map((x) => [x.caseId, x.status]).sort()).toEqual([
      ["cinema/director-noir", "succeeded"],
      ["cinema/move-dolly-in", "succeeded"],
    ]);
    expect(rows.every((x) => (x.request as { modelId: string }).modelId === "fuobe-cinema")).toBe(true);
    type Plan = { jobs: { case: string; variant: string; model: string; skip?: string }[] };
    setSetting("falKey", "fal-test-key");
    try {
      const plan = JSON.parse((await cli(["run", "--suite", "cinema", "--engine", "cloud", "--cases", "cinema/move-dolly-in", "--variants", "original,words,expansion,wan", "--dry-run", "--json"])).stdout) as Plan;
      const by = Object.fromEntries(plan.jobs.map((j) => [j.variant, j]));
      expect(by.original).toMatchObject({ model: "fuobe-cinema" });
      expect([by.original.skip, by.words.skip, by.expansion.skip, by.wan.skip]).toEqual([undefined, undefined, undefined, undefined]);
      expect(by.wan).toMatchObject({ model: "wan-2-2-a14b-cloud" });
      // The camera-move cases run in the cloud only: on the GPU the move is a Wan LoRA or a pose (the dop suite measures those).
      const open = JSON.parse((await cli(["run", "--suite", "cinema", "--engine", "open", "--cases", "cinema/move-dolly-in", "--dry-run", "--json"])).stdout) as Plan;
      expect(open.jobs.every((j) => !!j.skip)).toBe(true);
    } finally {
      setSetting("falKey", "");
    }
  });

  it("refuses an engine the server can't run, and skips jobs that would run as a demo on a real engine", async () => {
    const dry = await cli(["run", "--suite", "soul", "--engine", "cloud", "--looks", "v1-general", "--dry-run"]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toMatch(/would run as a demo: Z-Image Turbo \(hosted\) has no cloud provider connected/);
    // With placeholder results on, that is the reason given (a connected engine wouldn't help).
    setSetting("demoMode", "on");
    try {
      expect((await cli(["run", "--suite", "soul", "--engine", "open", "--looks", "v1-general", "--dry-run"])).stdout).toMatch(/placeholder results are on on that Fuobe/);
    } finally {
      setSetting("demoMode", "auto");
    }
    setSetting("engineMode", "open");
    try {
      const r = await cli(["run", "--suite", "soul", "--engine", "cloud", "--looks", "v1-general"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/runs open-source models only \(Settings → Engine mode\)/);
    } finally {
      setSetting("engineMode", "both");
    }
  });

  it("prices a cloud run before anything starts, and stops it at the spend cap", async () => {
    setSetting("falKey", "fal-test-key");
    try {
      const dry = await cli(["run", "--suite", "soul", "--engine", "cloud", "--looks", "v2-flash-editorial,v1-general", "--dry-run", "--json"]);
      const plan = JSON.parse(dry.stdout);
      expect(plan).toMatchObject({ engine: "cloud", total: 6, runnable: 6, skipped: 0, maxUsd: 5 });
      expect(plan.estimateUsd).toBeGreaterThan(0);
      const flash = plan.jobs.find((j: { case: string }) => j.case === "soul/v2-flash-editorial");
      // On the cloud the civitai Hard Flash LoRA is left out (its link needs a token); fal's LoRA endpoint takes the HF one.
      expect(flash.loras.applied).toEqual(["AWPortrait-Z.safetensors@0.4"]);
      expect(flash.notes.join(" ")).toMatch(/Hard Flash left out on the cloud/);
      const before = seen.filter((s) => s === "POST /api/generations").length;
      const r = await cli(["run", "--suite", "soul", "--engine", "cloud", "--looks", "v2-flash-editorial", "--max-usd", "0.00001"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/over the spend cap of \$0\.0000.*--max-usd/);
      // Only the three previews went out (POST ?preview=1 is the same path): nothing was started.
      expect(seen.filter((s) => s === "POST /api/generations").length - before).toBe(3);
    } finally {
      setSetting("falKey", "");
    }
  });

  it("keeps its renders out of the Library, and trash moves a run's generations to the Trash", async () => {
    const { listGenerations } = await import("@/server/generations");
    const runDir = path.join(results, selftestRun);
    const ids = [...new Set(store.readJsonl(path.join(runDir, "jobs.jsonl")).flatMap((r) => (r.generations as string[] | undefined) ?? []))];
    expect(ids.length).toBeGreaterThanOrEqual(5);
    // feature "eval" is a helper: the Library and Home feeds leave it out unless they ask for steps.
    const listed = (o: object) => new Set(listGenerations({ limit: 1000, ...o }).map((g) => g.id));
    expect(ids.filter((id) => listed({}).has(id))).toEqual([]);
    expect(ids.filter((id) => listed({ steps: true }).has(id))).toEqual(ids);
    const dry = await cli(["trash", selftestRun, "--dry-run"]);
    expect(dry.stdout).toMatch(new RegExp(`${ids.length} generations of ${selftestRun} would go to the Trash on ${base.replace(/[.]/g, "\\.")}`));
    const before = seen.filter((x) => x.startsWith("DELETE /api/generations/")).length;
    const r = await cli(["trash", selftestRun]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`Moved ${ids.length} generations of ${selftestRun} to the Trash`));
    expect(seen.filter((x) => x.startsWith("DELETE /api/generations/")).length - before).toBe(ids.length);
  });

  it("resume runs only what isn't done", async () => {
    const runDir = path.join(results, selftestRun);
    const lines = fs.readFileSync(path.join(runDir, "jobs.jsonl"), "utf8").trim().split("\n");
    // Pretend the last job failed.
    const last = JSON.parse(lines.at(-1)!);
    fs.appendFileSync(path.join(runDir, "jobs.jsonl"), `${JSON.stringify({ ...last, status: "failed", error: "pretend" })}\n`);
    const r = await cli(["run", "--resume", selftestRun, "--no-metrics"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/4 jobs already done in this run; running the other 1/);
    expect(store.latestJobs(runDir).every((x) => x.status === "succeeded")).toBe(true);
    expect(store.latestJobs(runDir).find((x) => x.id === last.id)?.attempt).toBe(2);
  });
});

/** A run folder made by hand: rows and metrics as the runner and the scorer write them. */
function fakeRun(name: string, engine: string, scores: Record<string, Record<string, number>>, extra: Partial<Row> = {}, runExtra: Record<string, unknown> = {}) {
  const runDir = path.join(results, name);
  fs.mkdirSync(path.join(runDir, "outputs"), { recursive: true });
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f0005000201a2e2b6a40000000049454e44ae426082", "hex");
  const ids = Object.keys(scores);
  const variants = [...new Set(ids.map((id) => id.split("--").at(-1)!))];
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ runId: name, suite: "soul", title: "Fuobe Soul", engine, variants, startedAt: Date.now(), server: { url: "x" }, ...runExtra }));
  const rows = ids.map((id) => {
    const [caseId, promptId, seed, variant] = id.split("--");
    fs.writeFileSync(path.join(runDir, "outputs", `${id}.png`), png);
    return {
      id,
      key: `soul/${caseId}/${promptId}/${seed}`,
      caseId: `soul/${caseId}`,
      caseTitle: caseId,
      variant,
      promptId,
      seed: Number(seed.slice(1)),
      prompt: "a portrait",
      status: "succeeded",
      outputs: [{ file: `outputs/${id}.png`, kind: "image" }],
      references: [],
      recipe: { kind: "soul-look", loras: [{ file: "a.safetensors", commercial: true, hostedOk: true }], applied: variant === "plain" ? [] : [{ file: "a.safetensors", strength: 0.7 }], complete: true, sent: { complete: true, loras: [] } },
      costUsd: { estimate: 0 },
      timing: { wallMs: 1000 },
      ...extra,
    };
  });
  fs.writeFileSync(path.join(runDir, "jobs.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(path.join(runDir, "metrics.json"), JSON.stringify({ version: 1, jobs: scores, groups: {}, models: {}, skipped: {} }));
  return runDir;
}

describe("report, blind review, compare and promote", () => {
  const ids = (variant: string) => ["s1001", "s2002", "s3003"].map((s) => `look-a--p1--${s}--${variant}`);
  const scored = (variant: string, style: number, clip: number) => Object.fromEntries(ids(variant).map((id, i) => [id, { style: style + i * 0.001, clip: clip + i * 0.1, aesthetic: 6 }]));

  it("summarises variants against each other and writes history lines per case and variant", () => {
    const runDir = fakeRun("fake-open-1", "open", { ...scored("recipe", 0.8, 30), ...scored("prompt-only", 0.7, 31) });
    const s = report.writeReport(runDir, results) as { variants: Record<string, { mean: Record<string, number> }>; pairs: { other: string; metrics: Record<string, { wins: number; losses: number }> }[] };
    expect(s.variants.recipe.mean.style).toBeCloseTo(0.801, 3);
    expect(s.pairs[0]).toMatchObject({ other: "prompt-only", metrics: { style: { wins: 3, losses: 0 }, clip: { wins: 0, losses: 3 } } });
    const hist = store.readJsonl(path.join(results, "history.jsonl")).filter((h) => h.runId === "fake-open-1");
    expect(hist.map((h) => h.variant).sort()).toEqual(["prompt-only", "recipe"]);
    // A second report of the same run replaces its lines instead of adding more.
    report.writeReport(runDir, results);
    expect(store.readJsonl(path.join(results, "history.jsonl")).filter((h) => h.runId === "fake-open-1")).toHaveLength(2);
    const html = fs.readFileSync(path.join(runDir, "report.html"), "utf8");
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain("prefers-color-scheme: dark");
  });

  it("serves both sounds of a blind pair in one format, so the file type doesn't give the model away", () => {
    if (spawnSync("ffmpeg", ["-version"]).status !== 0) return; // re-encoding needs ffmpeg
    const runDir = tempDir("fuobe-review-audio-");
    const tone = (file: string) => spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", path.join(runDir, file)]);
    const rows = [
      ["dbs-dub", ".flac"],
      ["melband", ".mp3"],
    ].map(([variant, ext]) => {
      fs.mkdirSync(path.join(runDir, variant), { recursive: true });
      for (const stem of ["voice", "background"]) tone(`${variant}/${stem}${ext}`);
      return { id: `separation__centre--p1--s1001--${variant}`, key: "separation/centre/p1/s1001", variant, status: "succeeded", caseId: "separation/centre", caseTitle: "Centre", outputs: ["voice", "background"].map((stem) => ({ file: `${variant}/${stem}${ext}`, kind: "audio", stem })) };
    });
    fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ candidate: "dbs-dub" }));
    try {
      expect(review.writeReview({ dir: runDir, runId: "fake-sep", rows }).pairs).toBe(2);
      const media = fs.readdirSync(path.join(runDir, "review", "media"));
      expect(media).toHaveLength(4);
      expect(media.every((f) => f.endsWith(".flac"))).toBe(true);
      for (const f of media) expect(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=format_name", "-of", "csv=p=0", path.join(runDir, "review", "media", f)], { encoding: "utf8" }).stdout.trim()).toBe("flac");
      expect(fs.readFileSync(path.join(runDir, "review", "index.html"), "utf8")).not.toMatch(/\.mp3|melband|dbs-dub/);
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("builds blind pairs whose page doesn't say which side is which, saves ratings and unblinds them in the summary", async () => {
    const runDir = path.join(results, "fake-open-1");
    const rows = store.latestJobs(runDir);
    const made = review.writeReview({ dir: runDir, runId: "fake-open-1", rows });
    expect(made.pairs).toBe(3);
    const html = fs.readFileSync(path.join(runDir, "review", "index.html"), "utf8");
    expect(html).not.toMatch(/prompt-only|recipe|look-a--/);
    const key = JSON.parse(fs.readFileSync(path.join(runDir, "review", "key.json"), "utf8"));
    const { server, url } = await review.serveReview(runDir);
    try {
      expect((await fetch(`${url}key.json`)).status).toBe(404);
      expect((await fetch(`${url}..%2Frun.json`)).status).toBe(404);
      expect((await fetch(url)).status).toBe(200);
      // Pick the recipe side every time.
      const ratings = key.pairs.map((p: { id: string; left: "a" | "b"; a: { label: string } }) => ({ pair: p.id, choice: (p.a.label === "recipe") === (p.left === "a") ? "left" : "right" }));
      const json = { "content-type": "application/json" };
      expect((await fetch(`${url}ratings`, { method: "POST", headers: json, body: JSON.stringify({ ratings: [{ pair: "x", choice: "maybe" }] }) })).status).toBe(400);
      // Only the review page saves ratings: another site's page sends its own Origin, or plain text (no preflight).
      const raw = (method: string, p: string, headers: Record<string, string>, body = "") =>
        new Promise<number>((resolve, reject) => {
          const req = http.request(new URL(p, url), { method, headers }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.on("error", reject);
          req.end(body);
        });
      const body = JSON.stringify({ ratings });
      expect(await raw("POST", "/ratings", { ...json, origin: "https://evil.example" }, body)).toBe(403);
      expect(await raw("POST", "/ratings", { "content-type": "text/plain" }, body)).toBe(415);
      // A name rebound to 127.0.0.1 isn't this server; a malformed address is refused, and the server stays up.
      expect(await raw("GET", "/", { host: "evil.example" })).toBe(421);
      expect(await raw("GET", "/%E0%A4%A", {})).toBe(400);
      expect((await fetch(url)).status).toBe(200);
      expect(fs.existsSync(path.join(runDir, "review", "ratings.json"))).toBe(false);
      expect((await fetch(`${url}ratings`, { method: "POST", headers: { ...json, origin: url.replace(/\/$/, "") }, body })).status).toBe(204);
    } finally {
      await new Promise((r) => server.close(r));
    }
    const s = report.writeReport(runDir, results) as { ratings: { total: number; pairs: { a: string; b: string; aWins: number; bWins: number; preferA: number }[] } };
    expect(s.ratings).toEqual({ total: 3, pairs: [{ a: "recipe", b: "prompt-only", aWins: 3, bWins: 0, ties: 0, preferA: 1 }] });
  });

  /** Rate the review's pairs (those `only` keeps, at most `limit`) for the `winner` variant, as the page saves them. */
  const rateFor = (runDir: string, winner: string, only: (caseId: string) => boolean = () => true, limit = Infinity) => {
    const key = JSON.parse(fs.readFileSync(path.join(runDir, "review", "key.json"), "utf8")) as { pairs: { id: string; caseId: string; left: "a" | "b"; a: { label: string } }[] };
    const ratings = key.pairs.filter((p) => only(p.caseId)).slice(0, limit).map((p) => ({ pair: p.id, choice: (p.a.label === winner) === (p.left === "a") ? "left" : "right" }));
    fs.writeFileSync(path.join(runDir, "review", "ratings.json"), JSON.stringify({ ratings }));
    return ratings.length;
  };
  const review3 = (runDir: string) => review.writeReview({ dir: runDir, runId: path.basename(runDir), rows: store.latestJobs(runDir) });
  type Verdicts = { candidate: string; results: { caseId: string; verdict: string; reasons: string[]; notes: string[]; mainMetric: string }[] };
  const verdicts = (d: Verdicts) => Object.fromEntries(d.results.map((r) => [r.caseId, r.verdict]));

  it("promotes a look only on its own blind ratings, and says when strengths over-cook", () => {
    // fake-open-1: one look, three pairs, all three rated for the recipe (every pair the review offered).
    let doc = compare.promote(path.join(results, "fake-open-1")) as Verdicts;
    expect(doc.results[0]).toMatchObject({ verdict: "promote", reasons: [] });
    // Three looks, the recipe best on style in each; six pairs per look against prompt only and half strength.
    const looks = ["look-a", "look-b", "look-c"];
    const scores: Record<string, Record<string, number>> = {};
    for (const look of looks) {
      for (const [variant, style] of [["recipe", 0.8], ["prompt-only", 0.7], ["half-strength", 0.75]] as const) {
        for (const seed of ["s1001", "s2002", "s3003"]) scores[`${look}--p1--${seed}--${variant}`] = { style, clip: 30, aesthetic: 6 };
      }
    }
    const runDir = fakeRun("fake-open-looks", "open", scores);
    expect(review3(runDir).pairs).toBe(18);
    // Only looks A and C were rated: B is held, though six ratings exist for the run.
    rateFor(runDir, "recipe", (c) => c !== "soul/look-b");
    doc = compare.promote(runDir) as Verdicts;
    expect(verdicts(doc)).toEqual({ "soul/look-a": "promote", "soul/look-b": "hold", "soul/look-c": "promote" });
    expect(doc.results[1].reasons).toEqual(["needs a blind review of this case: 0 ratings against the alternatives, the rule wants 6 (pnpm eval:review)"]);
    rateFor(runDir, "recipe", (c) => c === "soul/look-b", 3);
    expect((compare.promote(runDir) as Verdicts).results[1].reasons[0]).toMatch(/3 ratings against the alternatives, the rule wants 6/);
    // Half strength scoring higher on the look's main metric: lower the strengths instead.
    const over = fakeRun("fake-open-2", "open", { ...scored("recipe", 0.8, 30), ...scored("half-strength", 0.9, 30) });
    const d2 = compare.promote(over);
    expect(d2.results[0].verdict).toBe("lower strengths");
    expect(d2.results[0].notes.join(" ")).toMatch(/over-cook/);
    // Demo runs never promote anything.
    const demo = fakeRun("fake-demo-1", "demo", { ...scored("recipe", 0.9, 30), ...scored("prompt-only", 0.1, 30) });
    expect(compare.promote(demo).results[0].reasons[0]).toBe("demo media, not model output");
  });

  it("judges a clip on its words and guards its flicker; a licence is a note, and a hold only with --licence-hold", () => {
    // A DoP motion: no style or aesthetic scores, so prompt adherence decides; the suite names its candidate.
    const clipScores = (warp: number) => ({
      ...Object.fromEntries(["s1001", "s2002", "s3003"].map((s) => [`motion-a--bridge--${s}--research`, { clip: 32, warp, drift: 0.02 }])),
      ...Object.fromEntries(["s1001", "s2002", "s3003"].map((s) => [`motion-a--bridge--${s}--catalog`, { clip: 28, warp: 0.03, drift: 0.02 }])),
    });
    const good = fakeRun("fake-dop-1", "open", clipScores(0.01), {}, { candidate: "research", variants: ["catalog", "research"] });
    review3(good);
    rateFor(good, "research");
    const d = compare.promote(good) as Verdicts;
    expect(d.candidate).toBe("research");
    expect(d.results[0]).toMatchObject({ verdict: "promote", mainMetric: "clip", reasons: [] });
    // Better words but more flicker than the guard allows: held.
    const flicker = fakeRun("fake-dop-2", "open", clipScores(0.04), {}, { candidate: "research", variants: ["catalog", "research"] });
    review3(flicker);
    rateFor(flicker, "research");
    expect((compare.promote(flicker) as Verdicts).results[0].reasons).toEqual(["it gives up warp error (flicker) against catalog (0.0400 vs 0.0300, the rule allows 0.0020)"]);
    // The recipe is the candidate even when it isn't the run's first variant. Its non-commercial LoRA is a note on the
    // verdict (half strength won, so: lower strengths); with --licence-hold it holds the recipe.
    const nc = { recipe: { kind: "soul-look", commercialOk: false, loras: [{ file: "nc.safetensors", commercial: false, hostedOk: true }], applied: [{ file: "nc.safetensors", strength: 0.7 }], complete: true, sent: { complete: true, loras: [] } } };
    const lic = fakeRun("fake-open-nc", "open", { ...scored("half-strength", 0.9, 30), ...scored("recipe", 0.8, 30) }, nc);
    const d3 = compare.promote(lic) as Verdicts;
    expect(d3.candidate).toBe("recipe");
    expect(d3.results[0].verdict).not.toBe("promote");
    expect(d3.results[0].reasons).not.toContain("non-commercial LoRA: nc.safetensors");
    expect(d3.results[0].notes).toContain("licence: non-commercial LoRA: nc.safetensors");
    const held = compare.promote(lic, { rule: { licenceHold: true } }) as Verdicts;
    expect(held.results[0].verdict).toBe("hold");
    expect(held.results[0].reasons[0]).toBe("non-commercial LoRA: nc.safetensors");
  });

  it("promote --record writes each verdict into the research entry it measured, and nothing else", async () => {
    const python = spawnSync("python3", ["--version"]).status === 0 ? "python3" : null;
    if (!python) return; // no Python 3 here: the pytest covers the writer where there is one
    const research = path.join(process.cwd(), "docs/research/fuobe-originals-recipes-5.json");
    const copy = path.join(dir, "research-copy.json");
    fs.copyFileSync(research, copy);
    const before = fs.readFileSync(copy, "utf8");
    const look = "464ea177-8d40-4940-8d9d-b438bab269c7";
    // fake-open-2 has half strength beating the recipe: give its rows the look they measured.
    const runDir = path.join(results, "fake-open-2");
    const rows = store.latestJobs(runDir).map((r) => ({ ...r, recipe: { ...r.recipe, look: { id: look, slug: "v1-general" }, ...(r.variant === "half-strength" && { applied: [{ file: "a.safetensors", strength: 0.35 }] }) } }));
    fs.writeFileSync(path.join(runDir, "jobs.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const run = async (args: string[]) => {
      const err = sink();
      const code = await evalCli.main(["promote", ...args, "--record", "--research", copy], { stdout: sink().stream, stderr: err.stream, env: { ...process.env, FUOBE_EVAL_RESULTS: results, FUOBE_EVAL_PYTHON: python } });
      return { code, stderr: err.text() };
    };
    const r = await run(["fake-open-2"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/Recorded 1 result/);
    await run(["fake-open-2"]); // again: the record is replaced, not added
    const after = JSON.parse(fs.readFileSync(copy, "utf8"));
    const entry = after.presets.find((p: { id: string }) => p.id === look);
    expect(entry.eval).toHaveLength(1);
    expect(entry.eval[0]).toMatchObject({ engine: "open", case: "soul/look-a", runId: "fake-open-2", verdict: "lower strengths", mainMetric: "style", suggestedLoras: [{ file: "a.safetensors", strength: 0.35 }] });
    // Only the record and its convention line are new: recipes, strengths and the file's format stay.
    delete entry.eval;
    delete after.conventions.eval;
    expect(after).toEqual(JSON.parse(before));
    expect(fs.readFileSync(copy, "utf8")).not.toMatch(/\\u[0-9a-f]{4}/);
    // Demo runs have nothing to record.
    expect((await run(["fake-demo-1"])).stderr).toMatch(/demo run measures the harness/);
    // --apply-strengths: where half strength won, the entry's LoRAs take the strengths it ran (AWPortrait-Z 0.6 → 0.3), and the record says so.
    const halves = store.latestJobs(runDir).map((r) => (r.variant === "half-strength" ? { ...r, recipe: { ...r.recipe, applied: [{ file: "AWPortrait-Z.safetensors", strength: 0.3 }] } } : r));
    fs.writeFileSync(path.join(runDir, "jobs.jsonl"), halves.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const lowered = await run(["fake-open-2", "--apply-strengths"]);
    expect(lowered.code, lowered.stderr).toBe(0);
    expect(lowered.stderr).toMatch(/General: AWPortrait-Z\.safetensors 0\.6 → 0\.3/);
    const changed = JSON.parse(fs.readFileSync(copy, "utf8"));
    const e2 = changed.presets.find((p: { id: string }) => p.id === look);
    expect(e2.loras.map((l: { file: string; strength: number }) => [l.file, l.strength])).toEqual([["AWPortrait-Z.safetensors", 0.3], ["lenovo_z.safetensors", 0.35]]);
    expect(e2.eval[0].appliedStrengths).toEqual([{ file: "AWPortrait-Z.safetensors", from: 0.6, to: 0.3 }]);
    expect((await evalCli.main(["promote", "fake-open-2", "--apply-strengths"], { stdout: sink().stream, stderr: sink().stream, env: { ...process.env, FUOBE_EVAL_RESULTS: results } }))).toBe(2);
  });

  it("covers: the best render of each promoted case becomes its preset's cover, small, and listed for the gallery", async () => {
    const pub = path.join(dir, "covers-public");
    const out = path.join(pub, "previews", "soul");
    const manifest = path.join(dir, "covers-manifest.ts");
    const covers = (args: string[]) => cli(["covers", ...args, "--public-dir", pub, "--manifest", manifest]);
    // A DoP run of clips: research beats catalog on its words, and the review agreed.
    const clip = (c: number, w: number) => ({ clip: c, warp: w, drift: 0.02 });
    const scores = Object.fromEntries(["s1001", "s2002", "s3003"].flatMap((s, i) => [[`effect-thunder-god--bridge--${s}--research`, clip(32 + i, 0.01)], [`effect-thunder-god--bridge--${s}--catalog`, clip(28, 0.02)]]));
    const runDir = fakeRun("fake-dop-covers", "open", scores, { request: { presetId: "effect-thunder-god" } } as Partial<Row>, { candidate: "research", variants: ["catalog", "research"] });
    const rows = store.latestJobs(runDir).map((r) => {
      fs.copyFileSync(path.join(process.cwd(), "public/samples/demo-portrait.mp4"), path.join(runDir, "outputs", `${r.id}.mp4`));
      return { ...r, outputs: [{ file: `outputs/${r.id}.mp4`, kind: "video" }] };
    });
    fs.writeFileSync(path.join(runDir, "jobs.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    // Not reviewed yet: held, so no cover.
    expect((await covers(["fake-dop-covers"])).stdout).toMatch(/0 covers[\s\S]*hold: only a promoted recipe's render becomes a cover/);
    review3(runDir);
    rateFor(runDir, "research");
    const dry = await covers(["fake-dop-covers", "--dry-run"]);
    expect(dry.stdout).toMatch(/1 cover from fake-dop-covers \(open, research\) would be made\n  effect-thunder-god ← effect-thunder-god--bridge--s3003--research \(best clip 34\.000\)/);
    expect(fs.existsSync(out)).toBe(false);
    if (spawnSync("ffmpeg", ["-version"]).status !== 0) return; // encoding needs ffmpeg
    const r = await covers(["fake-dop-covers"]);
    expect(r.code, r.stderr).toBe(0);
    const entry = (await import("../scripts/eval/lib/covers.mjs")).readManifest(manifest)["effect-thunder-god"];
    // Each URL ends in its file's content version, so a cover made again gets a new URL.
    expect(entry).toEqual({
      poster: expect.stringMatching(/^\/previews\/soul\/effect-thunder-god\.jpg\?v=[0-9a-f]{8}$/),
      video: expect.stringMatching(/^\/previews\/soul\/effect-thunder-god\.mp4\?v=[0-9a-f]{8}$/),
      run: "fake-dop-covers",
      engine: "open",
      model: "",
      variant: "research",
    });
    const probe = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height:format=duration", "-of", "json", path.join(out, "effect-thunder-god.mp4")], { encoding: "utf8" }).stdout);
    expect(Math.max(probe.streams[0].width, probe.streams[0].height)).toBeLessThanOrEqual(512);
    expect(Number(probe.format.duration)).toBeLessThanOrEqual(4.1);
    expect(fs.statSync(path.join(out, "effect-thunder-god.jpg")).size).toBeGreaterThan(0);
    // The gallery reads the manifest's format: a TS module whose entries round-trip.
    expect(fs.readFileSync(manifest, "utf8")).toMatch(/^\/\*\*[\s\S]*export const PRESET_PREVIEWS: Record<string, PresetPreviewMedia> = \{\n {2}"effect-thunder-god": \{/m);
    // Demo media never becomes a cover.
    expect((await cli(["covers", "fake-demo-1"])).stderr).toMatch(/never becomes a cover/);
  });

  it("compare prints wins and losses and fails when a chosen metric regresses beyond the threshold", async () => {
    fakeRun("fake-open-3", "open", { ...scored("recipe", 0.8, 28.5), ...scored("prompt-only", 0.7, 31) });
    const ok = await cli(["compare", "fake-open-1", "fake-open-3", "--fail-on", "style"]);
    expect(ok.code, ok.stdout).toBe(0);
    expect(ok.stdout).toMatch(/6 jobs in both/);
    expect(ok.stdout).toMatch(/No regressions beyond the threshold/);
    // The recipe lost 1.5 CLIP on its three jobs: 0.75 over all six, more than the 0.5 allowed.
    const bad = await cli(["compare", "fake-open-1", "fake-open-3", "--fail-on", "clip", "--threshold", "0.5"]);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toMatch(/CLIP prompt adherence: mean 30\.6 → 29\.[89] \(−0\.8\)/);
    expect((await cli(["compare", "fake-open-1", "fake-open-3", "--fail-on", "clip", "--threshold", "1"])).code).toBe(0);
    // --per-case catches the one case that lost more than its share.
    expect((await cli(["compare", "fake-open-1", "fake-open-3", "--fail-on", "clip", "--threshold", "0.5", "--per-case"])).stdout).toMatch(/soul\/look-a: −0\.8/);
    // A percentage threshold of A's mean: 0.75 CLIP lost is under 5% of 30.6.
    expect((await cli(["compare", "fake-open-1", "fake-open-3", "--fail-on", "clip", "--threshold", "5%"])).code).toBe(0);
    // One variant against another of the same run.
    const v = await cli(["compare", "fake-open-1:prompt-only", "fake-open-1:recipe", "--fail-on", "style", "--json"]);
    expect(JSON.parse(v.stdout)).toMatchObject({ matched: 3, failed: false, metrics: expect.arrayContaining([expect.objectContaining({ metric: "style", wins: 3 })]) });
    const unknown = await cli(["compare", "fake-open-1", "fake-open-3", "--fail-on", "smell"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/Unknown metric “smell”/);
    // Scores from different metric models are flagged, not silently compared.
    const m3 = path.join(results, "fake-open-3", "metrics.json");
    const saved = fs.readFileSync(m3, "utf8");
    fs.writeFileSync(m3, JSON.stringify({ ...JSON.parse(saved), config: { clip: "clip-b32", style: "dinov2" } }));
    try {
      expect((await cli(["compare", "fake-open-1", "fake-open-3"])).stdout).toMatch(/^! the runs were scored with a different style model \(clip vs dinov2\)[^\n]*\n\nmetric/m);
    } finally {
      fs.writeFileSync(m3, saved);
    }
  });

  it("fuobe eval hands its arguments to the harness, with the CLI's server and token", async () => {
    const { main } = (await import("../bin/lib/cli.mjs")) as { main: (argv: string[], io: object) => Promise<number> };
    const out = sink();
    const err = sink();
    const io = { stdout: out.stream, stderr: err.stream, env: { ...process.env, FUOBE_EVAL_RESULTS: results, FUOBE_CONFIG: path.join(dir, "no-config.json") }, cwd: process.cwd(), home: dir, fetch, columns: 100, stdinIsTTY: false, stderrIsTTY: false, now: Date.now, sleep: async () => {}, onInterrupt: () => () => {}, ask: async () => "", readStdin: async () => "" };
    expect(await main(["eval", "compare", "fake-open-1", "fake-open-3", "--fail-on", "clip", "--threshold", "0.5"], io)).toBe(1);
    expect(out.text()).toMatch(/Regressions:/);
    expect(await main(["eval", "history", "--suite", "soul", "--json"], io)).toBe(0);
  });

  it("fuobe eval sends the saved token only to the server it was saved for, even when --url names another", async () => {
    const { main } = (await import("../bin/lib/cli.mjs")) as { main: (argv: string[], io: object) => Promise<number> };
    const config = path.join(dir, "saved-config.json");
    fs.writeFileSync(config, JSON.stringify({ url: "http://saved.local:3000", token: "SAVED-SECRET-TOKEN" }));
    const calls: string[] = [];
    const stub = async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input instanceof Request ? input.url : input));
      const auth = new Headers(init?.headers).get("authorization") ?? "none";
      calls.push(`${u.host} ${u.pathname} ${auth}`);
      const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
      if (u.pathname === "/api/status") return json({ engineMode: "both", demoMode: "auto", providers: {} });
      if (u.pathname === "/api/models") return json({ items: ["oss-trim", "oss-palette-video", "oss-join-clips", "oss-extract-frame", "oss-z-image-turbo"].map((id) => ({ id })) });
      return json({ demo: true, providerId: "mock", costUsd: 0 });
    };
    const io = () => ({ stdout: sink().stream, stderr: sink().stream, env: { PATH: process.env.PATH, FUOBE_EVAL_RESULTS: results, FUOBE_CONFIG: config }, cwd: process.cwd(), home: dir, fetch: stub, columns: 100, stdinIsTTY: false, stderrIsTTY: false, now: Date.now, sleep: async () => {}, onInterrupt: () => () => {}, ask: async () => "", readStdin: async () => "" });
    expect(await main(["eval", "run", "--suite", "selftest", "--engine", "demo", "--dry-run", "--url", "http://other.example:4000"], io())).toBe(0);
    expect(calls.length).toBeGreaterThan(2);
    expect(calls.every((c) => c.startsWith("other.example:4000 ") && c.endsWith(" none")), calls.join("\n")).toBe(true);
    // Without --url the saved server gets its own token, as with every other fuobe command.
    calls.length = 0;
    expect(await main(["eval", "run", "--suite", "selftest", "--engine", "demo", "--dry-run"], io())).toBe(0);
    expect(calls.length).toBeGreaterThan(2);
    expect(calls.every((c) => c.startsWith("saved.local:3000 ") && c.endsWith(" Bearer SAVED-SECRET-TOKEN")), calls.join("\n")).toBe(true);
  });

  it("history lists runs, newest first", async () => {
    const h = await cli(["history", "--json"]);
    const doc = JSON.parse(h.stdout);
    expect(doc.runs.length).toBeGreaterThanOrEqual(5);
    expect(doc.history.length).toBeGreaterThan(0);
  });
});

describe("runEval as a library", () => {
  it("reads a Shorts session's answer: the last stitch is the result, each take's look the steps", () => {
    const session = {
      id: "s1",
      segments: [
        { index: 0, takes: [{ look: "g-look-0" }] },
        { index: 1, takes: [{ look: "g-look-1" }, { look: "g-look-1b" }] },
      ],
      stitches: [{ final: "g-old" }, { final: "g-final" }],
    };
    expect(runner.routeResult(session)).toEqual([{ id: "g-final" }]);
    expect(runner.routeResult(session, "all").map((g) => g.id)).toEqual(["g-look-0", "g-look-1", "g-look-1b"]);
    expect(runner.routeResult(session, "last")).toEqual([{ id: "g-look-1b" }]);
    // A studio route's {final, items} answer reads as before.
    expect(runner.routeResult({ final: { id: "f" }, items: [{ id: "a" }, { id: "f" }] })).toEqual([{ id: "f" }]);
    expect(runner.routeResult({ items: [{ id: "a" }, { id: "b" }] }, "all")).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("names the LoRAs ComfyUI doesn't have yet, once each with how many jobs load them", () => {
    const job = (files: string[], applied = true) => (applied ? { preview: { loras: { applied: files.map((file) => ({ file, url: `https://x/${file}` })) } } } : { request: { loras: files.map((file) => ({ file })) } });
    const jobs = [job(["a.safetensors", "b.safetensors"]), job(["a.safetensors"]), job(["[ZImage.Turbo]c.safetensors"], false)];
    expect(runner.lorasMissing(jobs, ["b.safetensors"])).toEqual([
      { file: "a.safetensors", url: "https://x/a.safetensors", jobs: 2 },
      { file: "[ZImage.Turbo]c.safetensors", jobs: 1 },
    ]);
    // ComfyUI didn't answer: nothing to say.
    expect(runner.lorasMissing(jobs, null)).toBeNull();
  });

  it("sends the shipped Soul Original the look's Fuobe id, never a Higgsfield one", () => {
    const { expandJobs } = plan;
    const jobs = expandJobs(cases.loadSuite("soul"), { engine: "open", looks: ["v1-general"], variants: ["original"], prompts: 1 });
    expect(jobs[0].request).toMatchObject({ modelId: "fuobe-soul", presetId: "v1-general", engine: "open" });
    expect(jobs[0].request.loras).toBeUndefined();
    expect(JSON.stringify(jobs[0].request)).not.toContain("464ea177-8d40-4940-8d9d-b438bab269c7");
    // The Original runs on the engine the run names (a demo run lets the server pick); a lettering look runs on Soul HD.
    expect(expandJobs(cases.loadSuite("soul"), { engine: "cloud", looks: ["v1-general"], variants: ["original"], prompts: 1 })[0].request.engine).toBe("cloud");
    expect(expandJobs(cases.loadSuite("soul"), { engine: "demo", looks: ["v1-general"], variants: ["original"], prompts: 1 })[0].request.engine).toBeUndefined();
    const graffiti = expandJobs(cases.loadSuite("soul"), { engine: "cloud", looks: ["v1-graffiti"], variants: ["original", "recipe"], prompts: 1 });
    expect(graffiti.map((j) => j.request.modelId)).toEqual(["fuobe-soul-hd", "fuobe-soul-hd"]);
  });

  it("gives Soul Cinema's recipe its LoRAs, triggers and cine tail, and the Original the scene alone", async () => {
    const { expandJobs } = plan;
    const { SOUL_TAILS } = await import("@/lib/catalog/soul-originals.generated");
    const suite = cases.loadSuite("soul-cinema");
    const by = (engine: string) => Object.fromEntries(expandJobs(suite, { engine, cases: ["soul-cinema/diner"], variants: ["recipe", "prompt-only", "plain", "original"] }).map((j) => [(j as unknown as { variant: string }).variant, j as unknown as { request: { prompt: string; modelId: string; loras?: { file: string; strength: number }[]; params: { aspectRatio: string } }; notes: string[] }]));
    const open = by("open");
    const scene = "a waitress refills a coffee cup for a tired trucker in an empty roadside diner at night";
    expect(open.recipe.request.prompt).toBe(`CINEMATIC, FILM STILL, ${scene}. ${SOUL_TAILS.cine}`);
    expect(open.recipe.request.loras!.map((l) => [l.file, l.strength])).toEqual([["[ZImage.Turbo]FilmStill_Redmond.safetensors", 0.7], ["civitai-2462010-moviewide.safetensors", 0.5]]);
    expect(open.recipe.request.params.aspectRatio).toBe("16:9");
    expect(open["prompt-only"].request.prompt).toBe(`${scene}. ${SOUL_TAILS.cine}`);
    expect(open.plain.request.prompt).toBe(scene);
    expect(open.original.request).toMatchObject({ modelId: "fuobe-soul-cinema", prompt: scene });
    expect(open.original.request.loras).toBeUndefined();
    // The cloud can't fetch a civitai link without a mirrored copy: that LoRA is left out, and the runner says so.
    const cloud = by("cloud");
    expect(cloud.recipe.request.loras!.map((l) => l.file)).toEqual(["[ZImage.Turbo]FilmStill_Redmond.safetensors"]);
    expect(cloud.recipe.notes.join(" ")).toMatch(/Movie Wide Angle Z-image left out on the cloud: its civitai link needs a token/);
  });

  it("runs the soul-id look as the board's own look, but not on the references variant's edit models", () => {
    type LookJob = { variant: string; request: { modelId: string; presetId?: string; params: { extra?: Record<string, unknown> } } };
    const jobs = plan.expandJobs(cases.loadSuite("soul-id"), { engine: "cloud", cases: ["soul-id/look"], prompts: 1, variants: ["trained", "half-strength", "references"] }) as unknown as LookJob[];
    const by = Object.fromEntries(jobs.map((j) => [j.variant, j.request]));
    expect(by.trained).toMatchObject({ modelId: "fuobe-soul", presetId: "own-style" });
    expect(by["half-strength"]).toMatchObject({ presetId: "own-style", params: { extra: { characterStrength: 0.5 } } });
    expect(by.references.modelId).toBe("nano-banana-pro");
    expect(by.references.presetId).toBeUndefined();
  });

  it("writes a HEX palette as the Color signature does, and sends the lock variant through the palette-lock route", async () => {
    const { expandJobs } = plan;
    const { palettePrompt } = await import("@/lib/catalog/palettes");
    const { fillTemplate } = (await import("../scripts/eval/lib/media.mjs")) as { fillTemplate: (v: unknown, vars: object) => Record<string, unknown> };
    const suite = cases.loadSuite("soul-hex");
    type HexJob = { variant: string; skip?: string; submit?: { route: string; body: object }; request: { prompt: string; modelId: string; engine?: string; params: { palette: string[] } } };
    const jobs = (engine: string) => expandJobs(suite, { engine, cases: ["soul-hex/teal-dusk"], prompts: 1, variants: ["words", "lock", "base", "palette-model", "plain"] }) as unknown as HexJob[];
    const open = Object.fromEntries(jobs("open").map((j) => [j.variant, j]));
    const colors = ["#0B1D2A", "#1F4E5F", "#2A9D8F", "#E9C46A", "#F4A261"];
    const subject = "a woman in a knitted sweater sits by a window with a cup of tea, half-length portrait";
    expect(open.words.request).toMatchObject({ modelId: "fuobe-soul", engine: "open", prompt: `${subject}. ${palettePrompt({ colors, background: null })}`, params: { palette: colors } });
    expect(open.base.request.modelId).toBe("oss-z-image-turbo");
    expect(open["palette-model"].request).toMatchObject({ modelId: "oss-zimage-palette", prompt: subject });
    expect(open.plain.request.prompt).toBe(subject);
    expect(open.lock.submit!.route).toBe("/api/palettes/lock");
    expect(fillTemplate(open.lock.submit!.body, { request: open.lock.request })).toEqual({ request: open.lock.request, colors });
    // The lock is the open engine's: on the cloud it is skipped, not run as something else.
    const cloud = Object.fromEntries(jobs("cloud").map((j) => [j.variant, j]));
    expect(cloud.lock.skip).toMatch(/runs on demo \/ open only/);
    expect(cloud.words.request.engine).toBe("cloud");
  });

  it("expands, prices and lists a dry run without uploading anything", async () => {
    const before = seen.filter((s) => s === "POST /api/uploads").length;
    const suite = cases.loadSuite("dop");
    const plan = (await runner.runEval({ suite, engine: "demo", dryRun: true, cases: ["dop/motion-overhead", "dop/effect-thunder-god"], variants: ["catalog", "prompt-only", "research"], root: results }, { client: createClient({ url: base }) })) as { jobs: { case: string; variant: string; skip?: string; loras?: { applied: string[] } }[]; runnable: number };
    expect(seen.filter((s) => s === "POST /api/uploads").length).toBe(before);
    const job = (c: string, v: string) => plan.jobs.find((j) => j.case === c && j.variant === v)!;
    // Fuobe DoP ships the research's map v2 (O4): the catalog run carries the LoRAs, the prompt-only run none, and the
    // research run the same files sent by the harness at the research's strengths (what O8 tunes).
    const overhead = job("dop/motion-overhead", "catalog").loras?.applied ?? [];
    expect(overhead).toHaveLength(2);
    expect(overhead.every((f) => /camera-tilt-up-overhead\.safetensors@1$/.test(f))).toBe(true);
    expect(job("dop/motion-overhead", "prompt-only").loras?.applied).toEqual([]);
    expect(job("dop/motion-overhead", "prompt-only").skip).toBeUndefined();
    expect(job("dop/motion-overhead", "research").loras?.applied).toEqual(overhead);
    // Thunder God's research row replaces round 1's Electrify with ThunderHero (high and low experts).
    expect(job("dop/effect-thunder-god", "catalog").loras?.applied.every((f) => /thunderhero-redmond/.test(f))).toBe(true);
    expect(job("dop/effect-thunder-god", "prompt-only").loras?.applied).toEqual([]);
    expect(plan.runnable).toBe(12);
  });

  it("dry-runs Fuobe DoP's Mix: both presets' LoRAs against the first alone, and a camera move's pose", async () => {
    const mixes = (await runner.runEval({ suite: cases.loadSuite("dop-mix"), engine: "demo", dryRun: true, cases: ["dop-mix/overhead--building-explosion"], variants: ["mix", "first"], root: results }, { client: createClient({ url: base }) })) as {
      jobs: { variant: string; loras?: { applied: string[] } }[];
    };
    const mix = mixes.jobs.find((j) => j.variant === "mix")!;
    const first = mixes.jobs.find((j) => j.variant === "first")!;
    // The server's preview of the request the harness sends: the Mix's two pairs, the second at 0.6.
    expect(mix.loras?.applied).toHaveLength(4);
    expect(mix.loras?.applied.filter((f) => f.endsWith("@0.6"))).toHaveLength(2);
    expect(first.loras?.applied).toHaveLength(2);
    // A pose-only move (Zoom): its prompt-only run would repeat the catalog run on the GPU, so it is skipped there.
    const zoom = (await runner.runEval({ suite: cases.loadSuite("dop"), engine: "demo", dryRun: true, cases: ["dop/motion-zoom"], variants: ["catalog", "prompt-only"], root: results }, { client: createClient({ url: base }) })) as {
      jobs: { variant: string; skip?: string }[];
    };
    expect(zoom.jobs.find((j) => j.variant === "catalog")).toBeDefined();
    expect(zoom.jobs.find((j) => j.variant === "prompt-only")!.skip).toMatch(/same request as the catalog variant/);
  });
});

/**
 * A stand-in Fuobe for the runner's cloud logic: previews at a fixed price, generations that finish on the
 * second look and report their own cost, and (optionally) downloads that break. Records what was started and
 * how many ran at once.
 */
function cloudStub(o: { previewUsd: number | null; actualUsd: number | null; failDownload?: boolean; models?: string[]; trainingTargets?: object[]; route?: { provider: string; endpoint: string } }) {
  let n = 0;
  const started: string[] = [];
  const looked = new Set<string>();
  let running = 0;
  let most = 0;
  const models = o.models ?? ["trim-video", "join-clips", "extract-frame"];
  const client = {
    url: "http://stub.local",
    async request(method: string, p: string, opts: { json?: Record<string, unknown>; query?: Record<string, unknown> } = {}) {
      if (p === "/api/status") return { engineMode: "both", demoMode: "auto", cloudProvider: "auto", providers: { fal: { configured: true } } };
      if (p === "/api/models") return { items: models.map((id) => ({ id })) };
      if (p === "/api/uploads") return { url: `/api/files/uploads/${++n}.mp4` };
      if (p.endsWith("/trainings") && method === "GET") return { targets: o.trainingTargets ?? [], items: [] };
      if (p === "/api/generations" && opts.query?.preview) return { demo: false, providerId: o.route?.provider ?? "fal", costUsd: o.previewUsd, model: { id: opts.json?.modelId }, route: o.route ?? { provider: "fal", endpoint: "fal-ai/ffmpeg-api" }, prompt: opts.json?.prompt ?? "", loras: { applied: [], dropped: [] } };
      if (p === "/api/generations" && method === "POST") {
        const id = `g${++n}`;
        started.push(id);
        running++;
        most = Math.max(most, running);
        return { items: [{ id, status: "queued" }] };
      }
      const m = /^\/api\/generations\/(.+)$/.exec(p);
      if (m) {
        if (!looked.has(m[1])) {
          looked.add(m[1]);
          return { id: m[1], status: "running" };
        }
        running--;
        return { id: m[1], status: "succeeded", costUsd: o.actualUsd, modelId: "trim-video", provider: "fal", createdAt: 1, completedAt: 2, outputs: [{ url: `/api/files/out/${m[1]}.mp4`, kind: "video" }] };
      }
      throw new Error(`stub: no ${method} ${p}`);
    },
    async download(_url: string, dest: string) {
      if (o.failDownload) throw new Error("connection reset");
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, "x");
      return 1;
    },
  };
  return { client, started, most: () => most };
}

describe("the cloud spend cap", () => {
  const root = path.join(dir, "cap-results");
  const run = (o: Record<string, unknown>, stub: ReturnType<typeof cloudStub>) =>
    runner.runEval({ suite: cases.loadSuite("selftest"), engine: "cloud", seeds: [1, 2, 3], root, ...o }, { client: stub.client, sleep: async () => {}, pollMs: 0 }) as Promise<{ runId: string; dir: string; run: { spentUsd: number; results: Record<string, number> }; rows: Row[] }>;

  it("doesn't start a job the server can't price, unless asked, and then runs it alone and stops at the cap", async () => {
    const none = cloudStub({ previewUsd: null, actualUsd: 2 });
    const r = await run({ maxUsd: 1 }, none);
    expect(none.started).toEqual([]);
    const cloudRows = r.rows.filter((x) => !/^runs on/.test(String(x.skip)));
    expect(cloudRows).toHaveLength(9);
    expect(cloudRows.every((x) => x.status === "skipped" && /can't price it/.test(String(x.skip)))).toBe(true);
    expect(r.run.spentUsd).toBe(0);
    // --allow-unpriced: the first one holds what's left of the cap, so nothing starts beside it; once it has cost $2 nothing else starts.
    const some = cloudStub({ previewUsd: null, actualUsd: 2 });
    const r2 = await run({ maxUsd: 1, allowUnpriced: true }, some);
    expect(some.started).toHaveLength(1);
    expect(some.most()).toBe(1);
    expect(r2.run.spentUsd).toBe(2);
    expect(r2.rows.filter((x) => x.status === "skipped" && !/^runs on/.test(String(x.skip))).map((x) => x.skip)).toEqual(Array(8).fill("the spend cap ($1.00) was reached"));
  });

  it("keeps the cap with jobs running side by side, counts an earlier attempt's spend on --resume, and keeps a paid job's cost when its download breaks", async () => {
    const stub = cloudStub({ previewUsd: 0.4, actualUsd: 0.4 });
    // 9 jobs at $0.40 are $3.60: the run refuses to start over a $1 cap.
    await expect(run({ maxUsd: 1 }, stub)).rejects.toThrow(/about \$3\.60, over the spend cap of \$1\.00/);
    expect(stub.started).toEqual([]);
    const first = await run({ maxUsd: 5, limit: 1 }, stub);
    expect(first.run.spentUsd).toBeCloseTo(1.2, 6);
    // Resuming the same run under a $1.50 cap: $1.20 is already spent, and the jobs left can't fit.
    const statusOf = (rows: Row[]) => rows.map((x) => x.status).join(",");
    fs.appendFileSync(path.join(first.dir, "jobs.jsonl"), `${JSON.stringify({ ...first.rows[0], status: "failed", error: "pretend", attempt: 1, costUsd: { estimate: 0.4, actual: 0.4 }, generations: ["gx"] })}\n`);
    await expect(run({ maxUsd: 1.5, resume: first.runId }, stub)).rejects.toThrow(/\$1\.60 already spent in this run/);
    const again = await run({ maxUsd: 5, resume: first.runId }, stub);
    expect(statusOf(again.rows)).toBe("succeeded,succeeded,succeeded");
    // Three paid attempts, one pretend failure and one retry: $2.00.
    expect(again.run.spentUsd).toBeCloseTo(2, 6);
    // Jobs that cost more than their price: once the real spend reaches the cap, nothing else starts.
    const dear = cloudStub({ previewUsd: 0.25, actualUsd: 1 });
    const capped = await run({ maxUsd: 1, limit: 1, seeds: [1, 2, 3, 4], concurrency: 1 }, dear);
    expect(dear.started).toHaveLength(1);
    expect(capped.run.spentUsd).toBe(1);
    const broken = cloudStub({ previewUsd: 0.4, actualUsd: 0.5, failDownload: true });
    const r = await run({ maxUsd: 5, limit: 1 }, broken);
    expect(r.rows.every((x) => x.status === "failed" && /didn't download: connection reset/.test(String(x.error)))).toBe(true);
    expect(r.rows.map((x) => (x.costUsd as { actual: number }).actual)).toEqual([0.5, 0.5, 0.5]);
    expect(r.run.spentUsd).toBeCloseTo(1.5, 6);
  });

  it("prices cloud training before anything starts, and skips a target the server no longer trains", async () => {
    const suiteFile = path.join(dir, "train-suite.json");
    const train = (target: string) => ({ photos: path.join(process.cwd(), "scripts/eval/fixtures/character"), targets: { cloud: target }, minPhotos: 3, consent: true });
    fs.writeFileSync(
      suiteFile,
      JSON.stringify({
        suite: "train-cap",
        title: "Training under the cap",
        description: "x",
        original: "fuobe-soul",
        kind: "image",
        targets: { cloud: { models: ["z-image-turbo-cloud"] } },
        cases: [
          { id: "t/fal", title: "fal", train: train("fal-z-image"), prompts: [{ id: "p", text: "{character} in a cafe", seed: 1 }] },
          { id: "t/old", title: "old", train: train("soul-id-v2"), prompts: [{ id: "p", text: "{character} in a cafe", seed: 1 }] },
        ],
      }),
    );
    const stub = cloudStub({ previewUsd: 0.01, actualUsd: 0.01, models: ["z-image-turbo-cloud"], trainingTargets: [{ id: "fal-z-image", provider: "fal", price: "≈ $0.85 (1,000 steps)" }] });
    const suite = cases.loadSuite(suiteFile);
    const dry = (await runner.runEval({ suite, engine: "cloud", dryRun: true, root }, { client: stub.client })) as { estimateUsd: number; trainingUsd: number; jobs: { case: string; skip?: string }[] };
    expect(dry.trainingUsd).toBe(0.85);
    expect(dry.estimateUsd).toBeCloseTo(0.86, 6);
    // An older Soul ID target isn't among the server's targets: it has no price, so it can't run under the cap.
    expect(dry.jobs.find((j) => j.case === "t/old")?.skip).toMatch(/training on soul-id-v2 has no price/);
    await expect(runner.runEval({ suite, engine: "cloud", maxUsd: 0.5, root }, { client: stub.client })).rejects.toThrow(/about \$0\.86, over the spend cap/);
    expect(runner.trainingPrice({ price: "Free" })).toBe(0);
    expect(runner.trainingPrice({ price: "Pay as you go" })).toBeNull();
  });
  it("trains a character with the consent line the case confirms, and a look without one", async () => {
    const suiteFile = path.join(dir, "train-consent.json");
    const photos = path.join(process.cwd(), "scripts/eval/fixtures/character");
    fs.writeFileSync(
      suiteFile,
      JSON.stringify({
        suite: "train-consent",
        title: "Consent",
        description: "x",
        original: "fuobe-soul-id",
        kind: "image",
        targets: { cloud: { models: ["fuobe-soul"] } },
        cases: [
          { id: "t/person", title: "person", train: { photos, targets: { cloud: "fal-z-image" }, minPhotos: 3, consent: true }, prompts: [{ id: "p", text: "{character} in a cafe", seed: 1 }] },
          { id: "t/look", title: "look", train: { photos, kind: "style", targets: { cloud: "fal-z-image-style" }, minPhotos: 3 }, prompts: [{ id: "p", text: "{character} a cafe", seed: 1 }] },
          { id: "t/noconsent", title: "no consent", train: { photos, targets: { cloud: "fal-z-image" }, minPhotos: 3 }, prompts: [{ id: "p", text: "{character}", seed: 1 }] },
        ],
      }),
    );
    const stub = cloudStub({ previewUsd: 0.01, actualUsd: 0.01, models: ["fuobe-soul"], trainingTargets: [{ id: "fal-z-image", provider: "fal", price: "≈ $1.70 (2,000 steps)" }, { id: "fal-z-image-style", provider: "fal", price: "≈ $3.39 (1,500 steps)" }] });
    const made: { kind: string }[] = [];
    const trainings: Record<string, unknown>[] = [];
    const base = stub.client.request.bind(stub.client);
    const client = {
      ...stub.client,
      async request(method: string, p: string, opts: { json?: Record<string, unknown>; query?: Record<string, unknown> } = {}) {
        if (p === "/api/elements" && method === "POST") {
          made.push(opts.json as { kind: string });
          return { id: `el${made.length}`, handle: `Eval_${made.length}` };
        }
        const t = /^\/api\/elements\/(el\d+)\/trainings$/.exec(p);
        if (t && method === "POST") {
          trainings.push(opts.json!);
          return { id: `tr-${t[1]}` };
        }
        if (t) return { targets: [], items: [{ id: `tr-${t[1]}`, status: "succeeded", costUsd: 1.7 }] };
        return base(method, p, opts);
      },
    };
    const suite = cases.loadSuite(suiteFile);
    const r = (await runner.runEval({ suite, engine: "cloud", maxUsd: 10, root }, { client, sleep: async () => {} })) as { run: { jobs?: unknown } };
    expect(r).toBeDefined();
    expect(made.map((m) => m.kind)).toEqual(["character", "style"]);
    expect(trainings).toEqual([
      { target: "fal-z-image", consent: true },
      { target: "fal-z-image-style" },
    ]);
    const dry = (await runner.runEval({ suite, engine: "cloud", dryRun: true, root }, { client })) as { jobs: { case: string; skip?: string }[] };
    expect(dry.jobs.find((j) => j.case === "t/noconsent")?.skip).toMatch(/training a character needs "consent": true/);
  });

  it("never measures a demo training as trained: skipped when the server says it would be one, stopped when it ran as one", async () => {
    const suiteFile = path.join(dir, "train-demo.json");
    const photos = path.join(process.cwd(), "scripts/eval/fixtures/character");
    fs.writeFileSync(
      suiteFile,
      JSON.stringify({
        suite: "train-demo",
        title: "Demo trainings",
        description: "x",
        original: "fuobe-soul-id",
        kind: "image",
        targets: { cloud: { models: ["fuobe-soul"] } },
        cases: [{ id: "t/person", title: "person", train: { photos, targets: { cloud: "fal-z-image" }, minPhotos: 3, consent: true }, prompts: [{ id: "p", text: "{character} in a cafe", seed: 1 }] }],
      }),
    );
    const suite = cases.loadSuite(suiteFile);
    // The server lists the target as a demo (no fal.ai key there): nothing is planned for it.
    const demoTarget = cloudStub({ previewUsd: 0.01, actualUsd: 0.01, models: ["fuobe-soul"], trainingTargets: [{ id: "fal-z-image", provider: "fal", price: "≈ $1.70 (2,000 steps)", demo: true, blocker: null }] });
    const dry = (await runner.runEval({ suite, engine: "cloud", dryRun: true, root }, { client: demoTarget.client })) as { trainingUsd?: number; jobs: { case: string; skip?: string }[] };
    expect(dry.jobs[0].skip).toMatch(/would run as a demo on that Fuobe \(no fal\.ai key connected\), so nothing would be trained/);
    expect(dry.trainingUsd).toBeUndefined();
    // One that can't start at all says why.
    const blocked = cloudStub({ previewUsd: 0.01, actualUsd: 0.01, models: ["fuobe-soul"], trainingTargets: [{ id: "fal-z-image", provider: "fal", price: "≈ $1.70 (2,000 steps)", demo: false, blocker: "Add a fal.ai key in Settings" }] });
    const dry2 = (await runner.runEval({ suite, engine: "cloud", dryRun: true, root }, { client: blocked.client })) as { jobs: { skip?: string }[] };
    expect(dry2.jobs[0].skip).toMatch(/can't start there: Add a fal\.ai key/);
    // The key went missing between the plan and the training: the server ran a demo, so the case stops before any render.
    const stub = cloudStub({ previewUsd: 0.01, actualUsd: 0.01, models: ["fuobe-soul"], trainingTargets: [{ id: "fal-z-image", provider: "fal", price: "≈ $1.70 (2,000 steps)", demo: false, blocker: null }] });
    const base = stub.client.request.bind(stub.client);
    const client = {
      ...stub.client,
      async request(method: string, p: string, opts: { json?: Record<string, unknown>; query?: Record<string, unknown> } = {}) {
        if (p === "/api/elements" && method === "POST") return { id: "el1", handle: "Eval_1" };
        if (p === "/api/elements/el1/trainings" && method === "POST") return { id: "tr-demo", provider: "demo", status: "running" };
        return base(method, p, opts);
      },
    };
    const r = (await runner.runEval({ suite, engine: "cloud", maxUsd: 10, root }, { client, sleep: async () => {} })) as { dir: string; run: { spentUsd: number }; rows: Row[] };
    expect(stub.started).toEqual([]);
    expect(r.rows.every((x) => x.status === "skipped" && /training didn't finish: the server ran the training on fal-z-image as a demo/.test(String(x.skip)))).toBe(true);
    expect(r.run.spentUsd).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(r.dir, "elements.json"), "utf8"))["t/person"]).toMatchObject({ status: "failed", demoTraining: "tr-demo" });
  });
});

describe("what a job measures", () => {
  /** A Fuobe whose Genjutsu estimate answers with `estimate`, and whose status says which providers are connected. */
  const studioStub = (estimate: Record<string, unknown>, providers: Record<string, { configured: boolean }>) => ({
    url: "http://stub.local",
    async request(method: string, p: string) {
      if (p === "/api/status") return { engineMode: "both", demoMode: "auto", cloudProvider: "auto", providers };
      if (p === "/api/models") return { items: ["kling-motion-control", "kling-o3", "kling-o3-4k-edit"].map((id) => ({ id })) };
      if (p === "/api/genjutsu/estimate") return estimate;
      throw new Error(`stub: no ${method} ${p}`);
    },
  });
  const plan = (client: object) =>
    runner.runEval({ suite: cases.loadSuite("genjutsu"), engine: "cloud", variants: ["partner"], cases: ["genjutsu/move"], allowFixtures: true, dryRun: true, root: path.join(dir, "measure") }, { client }) as Promise<{ jobs: { skip?: string }[] }>;

  it("skips a job the server would run on another model than the one named", async () => {
    const swapped = await plan(studioStub({ costUsd: 1, demo: false, modelId: "fuobe-genjutsu-motion", providers: ["fal"] }, { fal: { configured: true } }));
    expect(swapped.jobs[0].skip).toMatch(/would run fuobe-genjutsu-motion instead of kling-motion-control/);
    const other = await plan(studioStub({ costUsd: 1, demo: false, modelId: "kling-o3", providers: ["fal"] }, { fal: { configured: true } }));
    expect(other.jobs[0].skip).toBe("the server would run kling-o3 instead of kling-motion-control, so this wouldn't measure kling-motion-control");
    const same = await plan(studioStub({ costUsd: 1, demo: false, modelId: "kling-motion-control", providers: ["fal"] }, { fal: { configured: true } }));
    expect(same.jobs[0].skip).toBeUndefined();
  });

  it("measures a studio route that doesn't say where its steps run (an older Fuobe)", async () => {
    const older = { costUsd: 1, demo: false, modelId: "kling-motion-control" };
    expect((await plan(studioStub(older, { fal: { configured: true } }))).jobs[0].skip).toBeUndefined();
  });

  it("prices a saved skill's case (pnpm eval:from-skill) by its estimate's total, and skips one that can't run", async () => {
    const fromSkill = (await import("../scripts/eval/from-skill.mjs")) as { caseFromSkill: (view: object, server: string) => { suite: string } };
    const view = { name: "promo", title: "Promo", recipe: { params: [{ id: "topic", type: "text", label: "Topic", example: "a desk lamp" }], steps: [{ kind: "generate", request: { modelId: "z-image-turbo-cloud" } }], checks: {} } };
    const file = path.join(dir, "skill-promo.json");
    fs.writeFileSync(file, JSON.stringify(fromSkill.caseFromSkill(view, "http://stub.local")));
    const skillStub = (estimate: Record<string, unknown>) => ({
      url: "http://stub.local",
      async request(method: string, p: string) {
        if (p === "/api/status") return { engineMode: "both", demoMode: "auto", cloudProvider: "auto", providers: { fal: { configured: true } } };
        if (p === "/api/models") return { items: [{ id: "z-image-turbo-cloud" }] };
        if (p === "/api/assist/skills/promo/estimate") return estimate;
        throw new Error(`stub: no ${method} ${p}`);
      },
    });
    const dry = (client: object) => runner.runEval({ suite: cases.loadSuite(file), engine: "cloud", dryRun: true, root: path.join(dir, "skill") }, { client }) as Promise<{ estimateUsd: number; jobs: { skip?: string }[] }>;
    const priced = await dry(skillStub({ engine: "cloud", total: 0.12, demo: false, runnable: true, errors: [], jobs: [], runs: [{ line: 1, jobs: [], total: 0.12, errors: [] }] }));
    expect(priced.jobs[0].skip).toBeUndefined();
    expect(priced.estimateUsd).toBeCloseTo(0.12, 6);
    const stopped = await dry(skillStub({ engine: "cloud", total: null, demo: false, runnable: false, errors: [], jobs: [], runs: [{ line: 1, jobs: [], total: null, errors: ["Step 1's model is switched off"] }] }));
    expect(stopped.jobs[0].skip).toBe("the server refused it: Step 1's model is switched off");
  });
});
