// The runner: a suite's jobs through a running Fuobe's REST API, on one engine. For each job it
// prices the request (POST /api/generations?preview=1, or a studio route's /estimate), uploads its
// inputs, submits it, waits, downloads the outputs and records what ran: model, route, final prompt,
// the LoRAs the route loaded (and those it left out), seed, time, cost, and on the open engine the
// memory ComfyUI used. Rows go to results/<runId>/jobs.jsonl as each job ends, so --resume picks up.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { comfyProbe } from "./comfy.mjs";
import { listMedia, REPO_DIR, safeName } from "./paths.mjs";
import { expandJobs, planSummary } from "./plan.mjs";
import { fillTemplate, probeClip, requestIdFor, uploader } from "./media.mjs";
import { RECIPES_FILE, LOOKS_FILE } from "./recipes.mjs";
import { engineProblem, serverFacts } from "./server.mjs";
import { appendJsonl, latestJobs, newRunId, readJson, readJsonl, runDir, writeJson } from "./store.mjs";

const TERMINAL = new Set(["succeeded", "failed", "canceled"]);
/** The cloud's spend cap when none is given (US$). The open engine and demo runs are free. */
export const DEFAULT_CLOUD_CAP = 5;
/** An element holds up to 80 photos, Soul ID's most (src/lib/catalog/training.ts SOUL_ID_PHOTOS.max). */
const MAX_ELEMENT_PHOTOS = 80;

const money = (n) => (n == null ? "unknown" : n === 0 ? "Free" : `$${n < 0.1 ? n.toFixed(4) : n.toFixed(2)}`);
const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);
const fileSha = (abs) => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
};
const gitCommit = () => {
  try {
    return execFileSync("git", ["-C", REPO_DIR, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

/**
 * What a job's row cost: the server's actual figure, else the estimate once anything was submitted
 * (a job that never reached the server cost nothing). Every attempt's row counts: a retry pays again.
 */
export const rowSpend = (r) => r.costUsd?.actual ?? (r.generations?.length || r.status === "succeeded" ? (r.costUsd?.estimate ?? 0) : 0);

/** What earlier attempts of a run already spent: every row in jobs.jsonl, and the training runs in elements.json. */
export function spentSoFar(dir) {
  const rows = readJsonl(path.join(dir, "jobs.jsonl"));
  const trainings = Object.values(readJson(path.join(dir, "elements.json"), {}));
  return sum(rows.map(rowSpend)) + sum(trainings.map((t) => (t.training ? (t.costUsd ?? t.estimateUsd ?? 0) : 0) + (t.earlierUsd ?? 0)));
}

/** A training target's price as the server words it ("≈ $0.85 (1,000 steps)", "Free"); null when it names no amount. */
export function trainingPrice(target) {
  if (!target) return null;
  if (/^\s*free\b/i.test(target.price ?? "")) return 0;
  const m = /\$\s*([\d,]+(?:\.\d+)?)/.exec(target.price ?? "");
  return m ? Number(m[1].replaceAll(",", "")) : null;
}

/** The LoRA files the jobs load that aren't in ComfyUI's list (null list: ComfyUI didn't answer, so nothing to say). */
export function lorasMissing(jobs, installed) {
  if (!installed) return null;
  const have = new Set(installed);
  const missing = new Map();
  for (const j of jobs) {
    for (const l of j.preview?.loras?.applied ?? j.request?.loras ?? []) {
      if (!l.file || have.has(l.file)) continue;
      const m = missing.get(l.file) ?? { file: l.file, ...(l.url && { url: l.url }), jobs: 0 };
      m.jobs++;
      missing.set(l.file, m);
    }
  }
  return [...missing.values()];
}

/** Run `fn` over `items` with at most `n` at a time, in order of start. */
async function pool(items, n, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/**
 * The generations a studio route's answer names: {final, items}, or a Shorts session (POST /api/shorts/sessions), whose
 * finished video is its latest stitch's final step and whose items are its segments' restyles.
 */
export const routeResult = (answer, how) => {
  const stitch = Array.isArray(answer?.stitches) ? answer.stitches.at(-1) : undefined;
  // A skill's run (POST /api/assist/skills/<name>/run, from pnpm eval:from-skill): every row's generations.
  const runs = Array.isArray(answer?.runs) ? answer.runs.flatMap((r) => (r.ids ?? []).map((id) => ({ id }))) : null;
  const items = answer?.items ?? runs ?? (stitch ? (answer.segments ?? []).flatMap((s) => (s.takes ?? []).map((t) => ({ id: t.look }))) : []);
  const final = answer?.final ?? (stitch?.final ? { id: stitch.final } : items.at(-1));
  if (how === "all") return items.length ? items : [final].filter(Boolean);
  if (how === "last") return [items.at(-1) ?? final].filter(Boolean);
  return [final].filter(Boolean);
};

/**
 * @typedef {object} RunOptions
 * @property {object} suite a parsed suite (loadSuite)
 * @property {"demo" | "open" | "cloud"} engine
 * @property {string[]} [variants] @property {string[]} [cases] @property {string[]} [looks] @property {string[]} [tags]
 * @property {number} [limit] @property {number} [prompts] @property {number[]} [seeds] @property {string} [model]
 * @property {boolean} [dryRun] price and list the jobs; nothing is uploaded or started
 * @property {number} [maxUsd] stop before the run's cost goes over this (cloud default DEFAULT_CLOUD_CAP)
 * @property {boolean} [allowUnpriced] run cloud jobs the server can't price (they count once their cost is known)
 * @property {number} [concurrency] jobs at a time (open 1, cloud 4, demo 4)
 * @property {string} root the results folder
 * @property {string} [resume] a run id to continue (failed and missing jobs run again)
 * @property {boolean} [allowFixtures] use the synthetic fixtures when your own inputs are missing
 * @property {string} [comfyUrl] ComfyUI's address, for memory and /history (open engine)
 * @property {string} [label] a note for this run (shown in reports)
 */

/**
 * @param {RunOptions} opts
 * @param {{ client: ReturnType<import("../../../bin/lib/client.mjs").createClient>, target?: object, log?: (s: string) => void, now?: () => number, sleep?: (ms: number) => Promise<void>, signal?: AbortSignal, pollMs?: number, fetch?: typeof fetch }} io
 */
export async function runEval(opts, io) {
  const log = io.log ?? (() => {});
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const { client } = io;
  const { suite, engine } = opts;

  const facts = await serverFacts(client);
  const problem = engineProblem(engine, facts);
  if (problem) throw new Error(problem);

  // Resume: the same run's settings, so the same jobs come out.
  let runId = opts.resume ?? null;
  let dir = runId ? runDir(opts.root, runId) : null;
  const previous = dir ? readJson(path.join(dir, "run.json")) : null;
  if (runId && !previous) throw new Error(`There's no run “${runId}” in ${opts.root} to resume`);
  const filters = previous?.filters ?? {
    variants: opts.variants,
    cases: opts.cases,
    looks: opts.looks,
    tags: opts.tags,
    limit: opts.limit,
    prompts: opts.prompts,
    seeds: opts.seeds,
    model: opts.model,
    allowFixtures: !!opts.allowFixtures,
  };

  const jobs = expandJobs(suite, { engine, ...filters, available: facts.available });
  const summary = planSummary(jobs);
  const maxUsd = opts.maxUsd ?? previous?.maxUsd ?? (engine === "cloud" ? DEFAULT_CLOUD_CAP : Infinity);
  const concurrency = opts.concurrency ?? (engine === "open" ? 1 : 4);

  if (!opts.dryRun && !dir) {
    runId = newRunId(suite.suite, engine, new Date(now()));
    dir = runDir(opts.root, runId);
  }
  const up = uploader(client, opts.dryRun ? null : dir, { dry: !!opts.dryRun, log });

  // Training cases: one element per case, trained (or, in demo runs, made from the fixtures) before its prompts run.
  const elements = new Map();
  const trainCases = [...new Map(jobs.filter((j) => j.train && !j.skip).map((j) => [j.caseId, j])).values()];
  for (const j of trainCases) {
    const why = trainingProblem(j, engine);
    if (why) for (const x of jobs.filter((y) => y.caseId === j.caseId && !y.skip)) x.skip = why;
  }
  // What each training would cost (cloud): the server's price for its target. One without a price can't sit under
  // the spend cap. On either real engine,
  // a training the server would run as a demo (no trainer or key connected) or can't start is skipped: its "trained"
  // results would measure an element that was never trained.
  const trainingUsd = new Map();
  const savedElements = dir ? readJson(path.join(dir, "elements.json"), {}) : {};
  // A training an earlier attempt started (and paid for) isn't priced again: the resume waits for it.
  const willTrain = trainCases.filter((j) => !j.skip && engine !== "demo" && !j.train.element && !["succeeded", "training"].includes(savedElements[j.caseId]?.status));
  if (willTrain.length) {
    const targets = (await client.request("GET", "/api/elements/eval-price/trainings").catch(() => null))?.targets ?? [];
    for (const j of willTrain) {
      const t = targets.find((x) => x.id === j.train.target);
      const usd = trainingPrice(t);
      let why = null;
      if (t?.demo) why = `training on ${j.train.target} would run as a demo on that Fuobe (${facts.demoMode === "on" ? "placeholder results are on" : `no ${t.provider === "fal" ? "fal.ai key" : "AI-Toolkit"} connected`}), so nothing would be trained`;
      else if (t?.blocker) why = `training on ${j.train.target} can't start there: ${t.blocker}`;
      else if (engine === "cloud" && usd == null && !opts.allowUnpriced) why = `training on ${j.train.target} has no price${t ? ` (the server says “${t.price}”)` : ""}, so the spend cap can't cover it: --allow-unpriced runs it anyway`;
      if (why) for (const x of jobs.filter((y) => y.caseId === j.caseId && !y.skip)) x.skip = why;
      else if (engine === "cloud") trainingUsd.set(j.caseId, usd ?? 0);
    }
  }

  // Price every runnable job with what the server says the route runs.
  let priced = [];
  for (const job of jobs) {
    if (job.skip) continue;
    try {
      // A training case's files are the element's photos, not inputs of each request.
      const inputs = job.train ? {} : await up.inputs(job.inputs);
      const p = await price(client, job, inputs, { engine, runId: runId ?? "dry-run" });
      job.preview = p;
      if (engine === "demo" && !p.demo) job.skip = `would run for real on ${p.providerId}: turn on Settings → Placeholder results for a free self-test`;
      else if (engine !== "demo" && p.demo) {
        job.skip =
          facts.demoMode === "on"
            ? "would run as a demo: placeholder results are on on that Fuobe (turn off Settings → Placeholder results to measure real models)"
            : `would run as a demo: ${p.modelName ?? job.model.id} has no ${engine === "open" ? "ComfyUI" : "cloud provider"} connected on that Fuobe`;
      }
      else if (engine !== "demo" && p.engine && p.engine !== engine) job.skip = `${p.modelName ?? job.model.id} is ${p.engine === "open" ? "an open-source" : "a cloud"} model, not ${engine}`;
      // The server picks another model when it can't run the one asked for (a studio's default maker): that wouldn't measure it.
      else if (p.modelId && p.modelId !== job.model.id) job.skip = `the server would run ${p.modelId} instead of ${job.model.id}, so this wouldn't measure ${job.model.id}`;
      else if (engine === "cloud" && p.costUsd == null && !opts.allowUnpriced) job.skip = "the server can't price it, so the spend cap can't cover it: --allow-unpriced runs it anyway (it counts once its cost is known)";
      else priced.push(job);
    } catch (e) {
      job.skip = `the server refused it: ${e.message}`;
    }
  }
  // Two variants of one case, prompt and seed that would send the server the same thing (a catalog preset with no
  // open LoRA is its own prompt-only run) run once: the later variant is skipped and names the one it repeats.
  const firstOf = new Map();
  for (const job of priced) {
    const sig = requestSignature(job);
    if (!sig) continue;
    const first = firstOf.get(`${job.key}|${sig}`);
    if (first) job.skip = `the same request as the ${first.variant} variant (same model, route, prompt, LoRAs and settings)`;
    else firstOf.set(`${job.key}|${sig}`, job);
  }
  priced = priced.filter((j) => !j.skip);
  const training = sum([...trainingUsd.entries()].filter(([caseId]) => jobs.some((x) => x.caseId === caseId && !x.skip)).map(([, usd]) => usd));
  const estimate = sum(priced.map((j) => j.preview.costUsd)) + training;
  const unknownCost = priced.filter((j) => j.preview.costUsd == null).length;

  // On the open engine: which of the LoRAs the jobs load ComfyUI doesn't have yet (they are never committed;
  // the server downloads pinned copies where it can, else they go in ComfyUI's models/loras by hand).
  const comfy = engine === "open" && opts.comfyUrl ? comfyProbe(opts.comfyUrl, { fetch: io.fetch }) : null;
  const missingLoras = comfy ? lorasMissing(priced, await comfy.loras()) : null;
  if (missingLoras?.length && !opts.dryRun) log(`ComfyUI doesn't have ${missingLoras.length} of the LoRAs these jobs load yet (${missingLoras.slice(0, 3).map((l) => l.file).join(", ")}${missingLoras.length > 3 ? "…" : ""}): jobs fail unless the server fetches them first or you put them in ComfyUI's models/loras.`);

  if (opts.dryRun) {
    const final = planSummary(jobs);
    const { jobs: total, ...counts } = final;
    return { dryRun: true, suite: suite.suite, engine, server: io.target?.url ?? client.url, total, ...counts, estimateUsd: estimate, ...(training && { trainingUsd: training }), unknownCost, maxUsd: Number.isFinite(maxUsd) ? maxUsd : null, ...(missingLoras && { missingLoras }), jobs: jobs.map(publicJob) };
  }
  // On a resume, what the earlier attempts spent counts against the same cap; jobs already done don't run again.
  const spentBefore = previous ? spentSoFar(dir) : 0;
  const doneBefore = new Set(previous ? latestJobs(dir).filter((r) => r.status === "succeeded").map((r) => r.id) : []);
  const toSpend = sum(priced.filter((j) => !doneBefore.has(j.id)).map((j) => j.preview.costUsd)) + training;
  if (engine === "cloud" && spentBefore + toSpend > maxUsd + 1e-9) {
    const already = spentBefore ? ` (${money(spentBefore)} already spent in this run, ${money(toSpend)} to go)` : "";
    throw new Error(`This run would cost about ${money(spentBefore + toSpend)}${already}, over the spend cap of ${money(maxUsd)}. Raise it with --max-usd ${Math.ceil(spentBefore + toSpend)} or run fewer jobs (--looks, --cases, --limit, --prompts).`);
  }

  // The run's record: what ran, where, with which research files, before anything starts.
  const comfyInfo = comfy ? await comfy.info() : null;
  const run = {
    runId,
    suite: suite.suite,
    title: suite.title,
    original: suite.original,
    kind: suite.kind,
    engine,
    label: opts.label ?? previous?.label ?? null,
    server: { url: io.target?.url ?? client.url, engineMode: facts.engineMode, demoMode: facts.demoMode, cloudProvider: facts.cloudProvider, providers: facts.providers },
    comfy: comfy ? { url: comfy.url, ...(comfyInfo ?? { unreachable: true }), ...(missingLoras?.length && { missingLoras }) } : null,
    filters,
    variants: summary.variants,
    ...(suite.defaults.candidate && { candidate: suite.defaults.candidate }),
    ...(suite.defaults.styleModel && { styleModel: suite.defaults.styleModel }),
    variantInfo: Object.fromEntries(summary.variants.map((v) => [v, suite.variants?.[v]?.description ?? ""])),
    maxUsd: Number.isFinite(maxUsd) ? maxUsd : null,
    estimateUsd: estimate,
    ...(training && { trainingUsd: training }),
    harness: { commit: gitCommit(), recipes: { file: RECIPES_FILE, sha: fileSha(path.join(REPO_DIR, RECIPES_FILE)) }, looks: { file: LOOKS_FILE, sha: fileSha(path.join(REPO_DIR, LOOKS_FILE)) }, suiteFile: path.relative(REPO_DIR, suite.file ?? "") },
    startedAt: previous?.startedAt ?? now(),
    resumedAt: previous ? now() : undefined,
    finishedAt: null,
    counts: summary,
  };
  writeJson(path.join(dir, "run.json"), run);
  log(`Run ${runId}: ${priced.length} job${priced.length === 1 ? "" : "s"} on ${engine}${summary.skipped ? `, ${jobs.length - priced.length} skipped` : ""} · estimated ${money(estimate)}${unknownCost ? ` (+${unknownCost} unpriced)` : ""}`);

  // Rows from an earlier attempt: succeeded jobs are kept, the rest run again; skipped ones are recorded once.
  const done = new Map(latestJobs(dir).map((r) => [r.id, r]));
  for (const job of jobs.filter((j) => j.skip)) {
    if (done.get(job.id)?.status === "succeeded") continue;
    appendJsonl(path.join(dir, "jobs.jsonl"), { ...recordBase(job), status: "skipped", skip: job.skip, at: now() });
  }

  let spent = spentBefore;
  for (const j of trainCases) {
    if (jobs.some((x) => x.caseId === j.caseId && !x.skip)) {
      try {
        const el = await prepareElement(client, j, { engine, runId, dir, up, log, sleep, now, signal: io.signal, estimateUsd: trainingUsd.get(j.caseId) });
        elements.set(j.caseId, el);
        // A training that ran now is paid for (its actual cost when the server knows it).
        if (!el.reused && el.training) spent += el.costUsd ?? el.estimateUsd ?? 0;
      } catch (e) {
        for (const x of priced.filter((y) => y.caseId === j.caseId)) x.skip = `training didn't finish: ${e.message}`;
        // A training that failed after starting may still have been billed: count its estimate.
        if (readJson(path.join(dir, "elements.json"), {})[j.caseId]?.training) spent += trainingUsd.get(j.caseId) ?? 0;
      }
    }
  }

  const queue = priced.filter((j) => !j.skip && done.get(j.id)?.status !== "succeeded");
  for (const j of priced.filter((x) => x.skip)) appendJsonl(path.join(dir, "jobs.jsonl"), { ...recordBase(j), status: "skipped", skip: j.skip, at: now() });
  const kept = priced.length - queue.length - priced.filter((x) => x.skip).length;
  if (kept) log(`${kept} job${kept === 1 ? "" : "s"} already done in this run; running the other ${queue.length}`);

  // The cap holds while jobs run side by side: each job reserves its price before it starts, and one the server
  // couldn't price (--allow-unpriced) reserves whatever is left of the cap, so nothing else starts beside it.
  // A job that doesn't fit waits for running ones to settle, and is skipped only when nothing running could free
  // money. What a job really cost replaces its reservation as it ends.
  let inFlight = 0;
  let waiting = [];
  const settle = () => {
    const w = waiting;
    waiting = [];
    for (const wake of w) wake();
  };
  const reserve = async (job) => {
    if (engine !== "cloud") return 0;
    for (;;) {
      const price = job.preview.costUsd;
      const need = price ?? Math.max(0, maxUsd - spent);
      if (price != null ? spent + need <= maxUsd + 1e-9 : spent < maxUsd - 1e-9) {
        spent += need;
        return need;
      }
      if (!inFlight) return null;
      await new Promise((wake) => waiting.push(wake));
    }
  };
  let finished = 0;
  await pool(queue, concurrency, async (job) => {
    if (io.signal?.aborted) return;
    const est = await reserve(job);
    if (est === null) {
      appendJsonl(path.join(dir, "jobs.jsonl"), { ...recordBase(job), status: "skipped", skip: `the spend cap (${money(maxUsd)}) was reached`, at: now() });
      return;
    }
    if (io.signal?.aborted) {
      spent -= est;
      return settle();
    }
    const attempt = (done.get(job.id)?.attempt ?? 0) + 1;
    inFlight++;
    let row;
    try {
      row = await runJob(client, job, { engine, runId, dir, up, comfy, element: elements.get(job.caseId), attempt, log, sleep, now, signal: io.signal, pollMs: io.pollMs ?? (engine === "demo" ? 500 : 2000) });
    } finally {
      inFlight--;
    }
    // What it really cost replaces the reservation: the server's figure, the estimate when it has none, nothing when it never started.
    spent += rowSpend(row) - est;
    settle();
    appendJsonl(path.join(dir, "jobs.jsonl"), row);
    finished++;
    const took = row.timing?.wallMs != null ? ` in ${(row.timing.wallMs / 1000).toFixed(1)} s` : "";
    log(`[${finished}/${queue.length}] ${row.status === "succeeded" ? "✓" : "✗"} ${job.key} · ${job.variant}${took}${row.error ? ` — ${row.error}` : ""}`);
  });

  const rows = latestJobs(dir);
  const count = (s) => rows.filter((r) => r.status === s).length;
  run.finishedAt = now();
  run.interrupted = !!io.signal?.aborted || undefined;
  run.spentUsd = Math.round(spentSoFar(dir) * 1e6) / 1e6;
  run.results = { succeeded: count("succeeded"), failed: count("failed") + count("timeout") + count("canceled"), skipped: count("skipped"), interrupted: count("interrupted") };
  writeJson(path.join(dir, "run.json"), run);
  return { runId, dir, run, rows };
}

/**
 * What the server would run for a generation job, as one string: model, operation, route, its final prompt,
 * the LoRAs it loads, the settings, the inputs. Null when the preview doesn't say (a studio route, an older Fuobe).
 */
function requestSignature(job) {
  const p = job.preview;
  if (job.submit || !p || typeof p.prompt !== "string" || !p.loras) return null;
  const loras = (p.loras.applied ?? []).map((l) => [l.file, l.strength ?? 1, l.target ?? "both"]);
  return JSON.stringify([p.modelId ?? job.model.id, p.op ?? null, p.route?.endpoint ?? null, p.prompt, loras, job.request.params ?? {}, job.request.negativePrompt ?? null, job.request.presetId ?? null, job.inputs]);
}

/** What a job is, for its row (also written for jobs that never ran). */
function recordBase(job) {
  return {
    id: job.id,
    key: job.key,
    suite: job.suite,
    caseId: job.caseId,
    caseTitle: job.caseTitle,
    variant: job.variant,
    promptId: job.promptId,
    prompt: job.prompt,
    seed: job.seed,
    engine: job.engine,
    kind: job.kind,
    model: { id: job.model.id, candidates: job.model.candidates },
    metrics: job.metrics,
    references: job.references,
    inputs: job.inputs,
    notes: job.notes,
    ...(job.shot && { shot: job.shot }),
    recipe: job.recipe ?? null,
  };
}

/** A job as the dry run lists it. */
function publicJob(job) {
  return {
    id: job.id,
    case: job.caseId,
    variant: job.variant,
    prompt: job.promptId,
    seed: job.seed,
    model: job.preview?.modelId ?? job.model.id,
    costUsd: job.preview?.costUsd ?? null,
    loras: job.preview?.loras ? { applied: job.preview.loras.applied.map((l) => `${l.file}@${l.strength ?? 1}`), dropped: job.preview.loras.dropped } : job.request.loras?.map((l) => `${l.file}@${l.strength ?? 1}`),
    ...(job.skip && { skip: job.skip }),
    ...(job.notes.length && { notes: job.notes }),
  };
}

/** Why a training case can't run here (or null). */
function trainingProblem(job, engine) {
  const t = job.train;
  if (engine === "demo" || t.element) return null;
  if (!t.target) return `no training target for ${engine} in this case`;
  if (t.kind !== "style" && !t.consent) return 'training a character needs "consent": true in the case (only when the person in the photos agreed)';
  const photos = listMedia(t.photos).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
  if (photos.length < t.minPhotos) return `add at least ${t.minPhotos} photos to ${path.relative(REPO_DIR, t.photos)} (there ${photos.length === 1 ? "is" : "are"} ${photos.length})`;
  return null;
}

/** The studio vars a route body can name. */
function routeVars(job, inputs, { engine, runId, attempt = 1 }) {
  const sources = {};
  for (const [slot, v] of Object.entries(job.inputs ?? {})) {
    if (typeof v !== "string" || !/\.(mp4|mov|m4v|webm)$/i.test(v)) continue;
    sources[`inputs.${slot}`] = { url: inputs[slot], name: path.basename(v), ...probeClip(v) };
  }
  return {
    inputs,
    sources,
    prompt: job.request.prompt ?? job.prompt,
    seed: job.seed,
    engine: engine === "demo" ? "open" : engine,
    modelId: job.model.id,
    requestId: requestIdFor(runId, job.id, attempt),
    // The job's own request, for a route that wraps one (POST /api/palettes/lock).
    request: { ...job.request, ...(Object.keys(inputs ?? {}).length && { inputs }) },
  };
}

/** The price and what the server would run, for one job. */
async function price(client, job, inputs, ctx) {
  if (job.submit) {
    const body = fillTemplate(job.submit.body, routeVars(job, inputs, ctx));
    const route = job.submit.estimate === false ? null : (job.submit.estimate ?? `${job.submit.route}/estimate`);
    if (!route) return { studio: true, costUsd: null, demo: ctx.engine === "demo", modelId: job.model.id };
    const e = await client.request("POST", route, { json: body });
    // A saved skill's estimate (RecipeEstimate, from pnpm eval:from-skill's cases): its total, or why it can't run.
    if (Array.isArray(e.runs) && e.runnable === false) throw new Error([...(e.errors ?? []), ...e.runs.flatMap((r) => r.errors ?? [])][0] ?? "it can't run");
    const skillTotal = Array.isArray(e.runs) ? e.total : undefined;
    return { studio: true, costUsd: e.costUsd ?? e.totalUsd ?? skillTotal ?? null, demo: e.demo ?? ctx.engine === "demo", modelId: e.modelId ?? job.model.id, ...(e.modelName && { modelName: e.modelName }), ...(Array.isArray(e.providers) && { providers: e.providers }), notes: e.notes };
  }
  const p = await client.request("POST", "/api/generations", { json: { ...job.request, inputs }, query: { preview: 1 } });
  return { ...p, ...(p.model?.id && { modelId: p.model.id, modelName: p.model.name }) };
}

/** Make (or reuse) the trained element a training case @mentions; returns {id, handle, training}. */
async function prepareElement(client, job, ctx) {
  const t = job.train;
  const file = path.join(ctx.dir, "elements.json");
  const saved = readJson(file, {});
  const prev = saved[job.caseId];
  // An element the case names, one this run already trained, or (demo) already made: use it as it is.
  const reuse = t.element ?? (prev?.id && (prev.status === "succeeded" || prev.status === "demo") ? prev.id : null);
  if (reuse) {
    const el = await client.request("GET", `/api/elements/${encodeURIComponent(reuse)}`);
    return { id: el.id, handle: el.handle, reused: true };
  }
  // A training this run started and didn't see finish (a resume): wait for it instead of paying for another.
  if (prev?.id && prev.training && prev.status === "training") {
    ctx.log(`Waiting for the training this run started (${prev.training})`);
    return waitForTraining(client, prev, { ...ctx, file, caseId: job.caseId, resumed: true });
  }
  // Demo runs don't train: the fixtures' drawn faces become the element's reference images.
  const photos = ctx.engine === "demo" ? Object.values(job.inputs).flat() : listMedia(t.photos).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
  const refs = [];
  for (const f of photos.slice(0, MAX_ELEMENT_PHOTOS)) refs.push(await ctx.up.url(f));
  const name = `${t.name ?? "Eval character"} ${ctx.runId.slice(-4)}`.slice(0, 60);
  const kind = t.kind ?? "character";
  const el = await client.request("POST", "/api/elements", { json: { name, kind, references: refs } });
  const record = { id: el.id, handle: el.handle, photos: refs.length, ...(photos.length > MAX_ELEMENT_PHOTOS && { note: `the first ${MAX_ELEMENT_PHOTOS} of ${photos.length} photos (an element holds ${MAX_ELEMENT_PHOTOS})` }) };
  if (ctx.engine === "demo") {
    writeJson(file, { ...saved, [job.caseId]: { ...record, status: "demo" } });
    return record;
  }
  ctx.log(`Training ${name} on ${t.target} with ${refs.length} photos`);
  // A character trains only with the person's consent (Soul ID's consent line): the case said so (trainingProblem checked).
  const tr = await client.request("POST", `/api/elements/${encodeURIComponent(el.id)}/trainings`, { json: { target: t.target, ...(kind === "character" && { consent: t.consent === true }) } });
  // The server trains for real or not at all: a demo training (its trainer or key went missing since the plan) would
  // make the "trained" results measure an untrained element.
  if (tr.provider === "demo") {
    writeJson(file, { ...saved, [job.caseId]: { ...record, demoTraining: tr.id, target: t.target, status: "failed", error: "ran as a demo (free: nothing was trained)" } });
    throw new Error(`the server ran the training on ${t.target} as a demo (no trainer or key connected), so nothing was trained`);
  }
  // An earlier training of this case that failed was paid for too: its cost stays in the run's spend.
  const earlierUsd = prev?.training ? (prev.costUsd ?? prev.estimateUsd ?? 0) + (prev.earlierUsd ?? 0) : prev?.earlierUsd;
  const started = { ...record, training: tr.id, target: t.target, status: "training", startedAt: ctx.now(), estimateUsd: ctx.estimateUsd ?? null, ...(earlierUsd && { earlierUsd }) };
  writeJson(file, { ...saved, [job.caseId]: started });
  return waitForTraining(client, started, { ...ctx, file, caseId: job.caseId });
}

/** Poll an element's training until it ends; the record in elements.json follows it. */
async function waitForTraining(client, record, ctx) {
  const save = (patch) => writeJson(ctx.file, { ...readJson(ctx.file, {}), [ctx.caseId]: { ...record, ...patch } });
  for (;;) {
    if (ctx.signal?.aborted) throw new Error("stopped");
    await ctx.sleep(15_000);
    const list = await client.request("GET", `/api/elements/${encodeURIComponent(record.id)}/trainings`);
    const now = (list.items ?? []).find((x) => x.id === record.training);
    if (now?.status === "succeeded") {
      const done = { ...record, status: "succeeded", costUsd: now.costUsd ?? null, finishedAt: ctx.now() };
      save(done);
      // A training seen through from an earlier attempt was counted in that attempt's spend already.
      return ctx.resumed ? { ...done, reused: true } : done;
    }
    if (now?.status === "failed" || now?.status === "canceled") {
      save({ status: "failed", error: now.error, costUsd: now.costUsd ?? null });
      throw new Error(now.error ?? "the training failed");
    }
    if (ctx.now() - record.startedAt > 4 * 3600_000) throw new Error("still training after 4 hours");
  }
}

/** One generation by id. */
const getGeneration = (client, id) => client.request("GET", `/api/generations/${encodeURIComponent(id)}`);

/** Submit, wait, download and record one job. */
async function runJob(client, job, ctx) {
  const base = recordBase(job);
  const t0 = ctx.now();
  const row = { ...base, attempt: ctx.attempt, at: t0, costUsd: { estimate: job.preview?.costUsd ?? null } };
  let watched = [];
  /** The generations as last seen: a download that breaks after they finished still keeps their cost and timing. */
  let final = [];
  ctx.comfy?.start();
  try {
    const inputs = job.train ? {} : await ctx.up.inputs(job.inputs);
    const mention = (s) => (ctx.element && typeof s === "string" ? s.replaceAll("{character}", `@${ctx.element.handle}`) : s);
    if (job.submit) {
      const vars = routeVars(job, inputs, ctx);
      vars.prompt = mention(vars.prompt);
      vars.request.prompt = mention(vars.request.prompt);
      const body = fillTemplate(job.submit.body, vars);
      row.request = { route: job.submit.route, body };
      const answer = await client.request("POST", job.submit.route, { json: body });
      watched = routeResult(answer, job.submit.result);
      row.steps = (answer.items ?? []).map((g) => g.id);
    } else {
      const request = { ...job.request, prompt: mention(job.request.prompt), inputs };
      row.request = request;
      // The preview again with the real prompt: it names the route and the LoRAs it loads.
      const p = ctx.element ? await client.request("POST", "/api/generations", { json: request, query: { preview: 1 } }) : job.preview;
      row.route = p.route ?? null;
      row.serverPrompt = p.prompt ?? null;
      if (job.recipe && p.loras) {
        row.recipe = { ...job.recipe, applied: p.loras.applied, dropped: p.loras.dropped, complete: !!job.recipe.sent?.complete && !p.loras.dropped.some((d) => job.recipe.sent.loras.some((l) => l.file === d.file)) };
      }
      const answer = await client.request("POST", "/api/generations", { json: request });
      watched = answer.items ?? [];
    }
    if (!watched.length) throw new Error("the server started nothing");
    row.generations = watched.map((g) => g.id);

    // Wait for every generation (a studio route's final step waits for the steps before it).
    const deadline = t0 + (job.timeoutSeconds ?? 1800) * 1000;
    final = watched;
    for (;;) {
      final = await Promise.all(watched.map((g) => (TERMINAL.has(g.status) ? g : getGeneration(client, g.id))));
      watched = final;
      if (final.every((g) => TERMINAL.has(g.status))) break;
      if (ctx.signal?.aborted) {
        row.status = "interrupted";
        row.error = "stopped before it finished (it keeps running on the server)";
        return finish(row, final, t0, ctx);
      }
      if (ctx.now() > deadline) {
        row.status = "timeout";
        row.error = `still running after ${job.timeoutSeconds} s`;
        return finish(row, final, t0, ctx);
      }
      await ctx.sleep(ctx.pollMs);
    }
    const bad = final.find((g) => g.status !== "succeeded");
    row.status = bad ? (bad.status === "canceled" ? "canceled" : "failed") : "succeeded";
    if (bad) row.error = bad.error ?? `the generation ${bad.status}`;
    await finish(row, final, t0, ctx);
    // A chain /api/generations starts itself (Fuobe DoP's relight effects: the relit still, then the clip): the
    // result is the generations of the suite's kind.
    const own = final.filter((g) => !job.kind || g.kind === job.kind);
    if (row.status === "succeeded") row.outputs = await download(client, own.length ? own : final, path.join(ctx.dir, "outputs", safeName(job.id)), ctx.dir);
    return row;
  } catch (e) {
    row.error = row.status === "succeeded" ? `the results didn't download: ${e.message}` : e.message;
    row.status = "failed";
    return finish(row, final, t0, ctx);
  } finally {
    ctx.comfy?.stop();
  }
}

/** Timing, cost and (open engine) memory and ComfyUI's own times. */
async function finish(row, gens, t0, ctx) {
  const t1 = ctx.now();
  const created = Math.min(...gens.map((g) => g.createdAt ?? Infinity));
  const completed = Math.max(...gens.map((g) => g.completedAt ?? -Infinity));
  row.timing = { submittedAt: t0, finishedAt: t1, wallMs: t1 - t0, ...(Number.isFinite(created) && Number.isFinite(completed) && { serverMs: completed - created }) };
  const actual = gens.map((g) => g.costUsd).filter((c) => c != null);
  row.costUsd = { estimate: row.costUsd?.estimate ?? null, actual: actual.length ? Math.round(sum(actual) * 1e6) / 1e6 : null };
  row.model = { ...row.model, ...(gens[0] && { id: gens[0].modelId, name: gens[0].modelName, provider: gens[0].provider, demo: gens[0].provider === "mock" }) };
  row.generationInfo = gens.map((g) => ({ id: g.id, status: g.status, provider: g.provider, modelId: g.modelId, costUsd: g.costUsd, createdAt: g.createdAt, completedAt: g.completedAt, ...(g.error && { error: g.error }) }));
  if (ctx.comfy && gens.length) {
    row.vram = ctx.comfy.peak(t0, t1);
    const hist = [];
    for (const g of gens) {
      const h = await ctx.comfy.history(g.id);
      if (h) hist.push(h);
    }
    if (hist.length) row.comfy = { promptIds: hist.flatMap((h) => h.promptIds), execMs: sum(hist.map((h) => h.execMs)) || null, cachedNodes: sum(hist.map((h) => h.cachedNodes)), passes: sum(hist.map((h) => h.passes)) };
  }
  return row;
}

/** Save every output of the finished generations; returns the files relative to the run folder. */
async function download(client, gens, folder, runFolder) {
  const files = [];
  let n = 0;
  for (const g of gens) {
    for (const o of g.outputs ?? []) {
      n++;
      const role = o.meta?.role ? `-${safeName(o.meta.role)}` : "";
      if (typeof o.text === "string" && !o.url) {
        const dest = path.join(folder, `${n}${role}.txt`);
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(dest, o.text);
        files.push({ file: path.relative(runFolder, dest), kind: "text", generationId: g.id, bytes: Buffer.byteLength(o.text), ...(o.meta?.role && { role: o.meta.role }) });
        continue;
      }
      const ext = /^\.[a-z\d]{1,10}$/i.exec(path.extname(new URL(o.url, "http://x").pathname))?.[0] ?? ".bin";
      const dest = path.join(folder, `${n}${role}${ext}`);
      const bytes = await client.download(o.url, dest);
      files.push({ file: path.relative(runFolder, dest), url: o.url, kind: o.kind, contentType: o.contentType ?? null, generationId: g.id, bytes, ...(o.meta?.role && { role: o.meta.role }), ...(o.meta?.stem && { stem: o.meta.stem }), ...(o.meta?.demo && { demo: true }) });
    }
  }
  return files;
}

export { money };
