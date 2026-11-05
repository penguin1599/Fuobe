#!/usr/bin/env node
// The evaluation harness's command line: pnpm eval:<command> (or fuobe eval <command>). See
// scripts/eval/README.md. Every command takes --json for scripts, and --url / --token for the
// Fuobe to measure (else FUOBE_URL / FUOBE_TOKEN, else what `fuobe login` saved).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadSuite, suiteFiles, validateAll } from "./lib/cases.mjs";
import { compareRuns, compareText, promote, promoteText, researchRecords } from "./lib/compare.mjs";
import { coversFromMasters, makeCovers, versionCovers } from "./lib/covers.mjs";
import { templateCoversFromMasters, versionTemplateCovers } from "./lib/template-covers.mjs";
import { scoreRun } from "./lib/metrics.mjs";
import { METRICS_DIR, REPO_DIR, resultsDir } from "./lib/paths.mjs";
import { RECIPES_FILE } from "./lib/recipes.mjs";
import { writeReport } from "./lib/report.mjs";
import { serveReview, writeReview } from "./lib/review.mjs";
import { DEFAULT_CLOUD_CAP, money, runEval } from "./lib/run.mjs";
import { connect } from "./lib/server.mjs";
import { listRuns, readJson, readJsonl, resolveRun } from "./lib/store.mjs";

const list = (v) => (v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : undefined);
const num = (v, name) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Usage(`--${name} takes a number, not “${v}”`);
  return n;
};

class Usage extends Error {}

const COMMON = { url: { type: "string" }, token: { type: "string" }, out: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } };
const SCORE = { "no-metrics": { type: "boolean" }, metrics: { type: "string" }, device: { type: "string" }, "clip-model": { type: "string" }, "style-model": { type: "string" }, "identity-model": { type: "string" }, "face-detector": { type: "string" }, "accept-noncommercial": { type: "boolean" }, "commercial-only": { type: "boolean" }, force: { type: "boolean" } };

const HELP = {
  run: `pnpm eval:run --suite <name> --engine demo|open|cloud [options]

  --suite <name|file>    soul, soul-cinema, soul-hex, soul-id, dop, dop-mix, genjutsu, evolution, popcorn, marketing, mixed-media, shorts, speak, cinema, selftest (or a path)
  --engine <e>           demo (free self-test), open (your ComfyUI) or cloud (hosted open models)
  --looks <a,b>          Soul looks by slug, name or id (v1-general, "Flash editorial")
  --cases <ids>          case ids or prefixes with * (dop/motion-*)
  --tags <t>             cases with any of these tags (v1, civitai, train-own…)
  --variants <a,b>       recipe variants to run (default: the suite's default); all = every variant
  --model <id>           one model id for every job instead of the suite's targets
  --limit <n>            at most n cases · --prompts <n> at most n prompts per case · --seeds 1,2
  --dry-run              list the jobs and the estimated spend; uploads and starts nothing
  --max-usd <n>          the cloud spend cap (default $${DEFAULT_CLOUD_CAP}): jobs, training and an earlier attempt's spend count;
                         the run refuses to start over it and starts no job that would go over it
  --allow-unpriced       also run cloud jobs (and training) the server can't price; they count once their cost is known
  --concurrency <n>      jobs at a time (open 1, others 4)
  --resume <runId>       run the failed and missing jobs of an earlier run again
  --allow-fixtures       use the synthetic fixtures where your own inputs are missing
  --comfy-url <url>      ComfyUI's address, for memory and its own timings (open engine; default COMFYUI_URL)
  --label <text>         a note for this run
  --no-metrics           don't score afterwards · --no-report: don't write the report either`,
  report: "pnpm eval:report <runId|latest> [--no-metrics] [--metrics clip,style] [--device cpu|cuda|auto] [--style-model clip|dinov2] [--face-detector yunet|scrfd] [--force]",
  review: "pnpm eval:review <runId|latest> [--against variants|references|<otherRunId>] [--port 4173] [--no-serve] [--limit n]",
  compare: "pnpm eval:compare <runA[:variant]> <runB[:variant]> [--fail-on clip,aesthetic] [--threshold 1|5%] [--per-case]",
  promote: `pnpm eval:promote <runId> [--candidate recipe] [--against prompt-only,half-strength,plain] [--record [--apply-strengths] [--research file]] [--licence-hold]

  --licence-hold       a non-commercial LoRA (or one licensed for the GPU only, on a cloud run) holds the recipe;
                       without it the licence is a note on the verdict

  --record             writes each case's verdict into the research JSON entry it measured
  --apply-strengths    with --record: where half strength won, lowers that entry's LoRA strengths to the ones it ran
                       (review the diff, then pnpm gen:catalog and run both engines again)`,
  covers: `pnpm eval:covers <runId> [--variant <name>] [--dry-run] [--public-dir public] [--manifest src/lib/preset-previews.generated.ts] [--commercial-only]

  The best render of each promoted case becomes its preset's cover: encoded small into public/previews/<suite>/
  and listed in src/lib/preset-previews.generated.ts, which the gallery cards show. --variant takes that
  variant's renders for every case instead (catalog: what ships today). Demo runs never make covers.

pnpm eval:covers --from-masters <dir> --run <name> [--engine comfyui] [--model <id>] [--video-model <id>] [--variant <name>]
                 [--suite presets] [--only id,id] [--force] [--replace] [--dry-run] [--public-dir public] [--manifest …]

  Rendered masters outside a run, one folder per preset id: its clip.mp4 becomes a clip cover, else its
  start.png a still cover, in public/previews/<suite>/ (presets by default). Each records --run, --engine,
  --model (--video-model for clips) and --variant; a folder's meta.json can name its own model and variant.
  The manifest is merged: other entries stay, and an id whose cover another run made elsewhere (a measured
  cover) is skipped (--replace takes it over). Run again, it encodes only new or changed masters (--force: all).
  Clips loop without a jump: their last frames are crossfaded into their first ones.

pnpm eval:covers --templates <dir> [--only group/id,group/id] [--force] [--dry-run] [--public-dir public]

  Covers for the studios' template and style tiles, from rendered masters: one folder per tile,
  <dir>/<group>/<tile id>/ (groups: marketing, fashion, photodump, shorts, mixed-media, canvas, content-factory,
  explainer, soul, influencer, examples), holding clip.mp4 or still.png, then frame-2.png… for a tile with more
  frames (up to frame-6), and a
  meta.json that can say { "rest": "end" } (a reveal: its last frame is the poster) or { "same": "<preset id>" }
  (the tile shows that preset's cover). Encoded like the preset covers into public/previews/templates/<group>/ and
  merged into src/lib/template-covers.generated.ts. Run again, it encodes only new or changed masters (--force: all).

pnpm eval:covers --versions [--dry-run] [--public-dir public] [--manifest …]

  Every URL in the manifests (the presets', and the template tiles') ends in its file's content version (?v=, 8 hex
  digits of its sha256; a still's also covers its small copy in thumbs/), so a cover made again gets a new URL. The
  commands above write them; this one versions both manifests from the files as they are (with --manifest, only
  that presets' manifest). It encodes only a still's small copy that's missing or older than its still (one copied
  in by hand), first; --dry-run lists those and fails until they're made.`,
  history: "pnpm eval:history [--suite soul] [--case soul/v1-general] [--limit 20]",
  validate: "pnpm eval:validate [suite files…]   checks every case file and that the generated suites match the research",
  trash: "pnpm eval:trash <runId> [--dry-run]   moves the run's generations to that Fuobe's Trash (its results here stay)",
  setup: "pnpm eval:setup [--identity] [--asr] [--download [--dinov2] [--scrfd]] [--torch-backend cpu|auto|cu128…]   the metrics venv (needs uv); --asr adds Whisper for the separation suite's word error rate",
};

function usage() {
  return [
    "Fuobe evaluation harness. Commands:",
    ...Object.values(HELP).map((h) => `  ${h.split("\n")[0]}`),
    "",
    "Results go to scripts/eval/results/<runId>/ (git-ignored; --out or FUOBE_EVAL_RESULTS to move them).",
    "More: scripts/eval/README.md",
  ].join("\n");
}

/**
 * @param {string[]} argv the arguments after the command name's position (command first)
 * @param {{ stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream, env?: Record<string, string | undefined>, home?: string, fetch?: typeof fetch, signal?: AbortSignal }} [io]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, io = {}) {
  const out = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  const print = (s) => out.write(`${s}\n`);
  const note = (s) => err.write(`${s}\n`);
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    print(rest[0] && HELP[rest[0]] ? HELP[rest[0]] : usage());
    return 0;
  }
  const commands = { run, report, review, compare, promote: promoteCmd, history, validate, setup, trash, covers };
  if (!commands[command]) {
    note(`Unknown command “${command}”.\n${usage()}`);
    return 2;
  }
  try {
    return (await commands[command](rest, { print, note, env, io })) ?? 0;
  } catch (e) {
    if (e instanceof Usage) {
      note(`${e.message}\n\n${HELP[command] ?? usage()}`);
      return 2;
    }
    if (env.FUOBE_DEBUG) note(e.stack);
    note(e.message);
    return 1;
  }
}

function parse(args, options, { positionals = false } = {}) {
  try {
    return parseArgs({ args, options: { ...COMMON, ...options }, allowPositionals: positionals, strict: true });
  } catch (e) {
    throw new Usage(e.message.replace(/^TypeError \[[A-Z_]+\]: /, ""));
  }
}

const root = (values, env) => resultsDir(env, values.out);

async function score(dir, v, ctx) {
  if (v["no-metrics"]) return null;
  ctx.note("Scoring the outputs…");
  // The suite's own style embedder (defaults.styleModel, kept in run.json) unless --style-model names one.
  const styleModel = v["style-model"] ?? readJson(path.join(dir, "run.json"))?.styleModel;
  const r = await scoreRun(dir, { metrics: v.metrics, device: v.device, clipModel: v["clip-model"], styleModel, identityModel: v["identity-model"], faceDetector: v["face-detector"], commercialOnly: v["commercial-only"], force: v.force, log: ctx.note, env: ctx.env });
  if (!r.ok) ctx.note(`Not scored: ${r.reason}. Timing and cost are in the report; pnpm eval:report ${path.basename(dir)} scores it later.`);
  return r;
}

function reportAll(dir, rootDir, ctx) {
  const summary = writeReport(dir, rootDir);
  const loaded = { dir, runId: summary.runId, rows: readJsonl(path.join(dir, "jobs.jsonl")) };
  // The latest row per job (a resumed run appends retries).
  loaded.rows = [...new Map(loaded.rows.map((r) => [r.id, r])).values()];
  const rv = writeReview(loaded);
  ctx.note(`Report: ${path.join(dir, "report.html")}`);
  ctx.note(`Review: ${rv.pairs} blind pair${rv.pairs === 1 ? "" : "s"} · pnpm eval:review ${summary.runId}`);
  return summary;
}

function printSummary(summary, ctx) {
  const free = summary.engine !== "cloud";
  ctx.print(`${summary.title} · ${summary.engine} · ${summary.counts.succeeded}/${summary.counts.jobs} done${summary.counts.failed ? ` · ${summary.counts.failed} failed` : ""}${summary.counts.skipped ? ` · ${summary.counts.skipped} skipped` : ""} · ${free ? "Free" : money(summary.costUsd.spent)}`);
  for (const [v, s] of Object.entries(summary.variants)) {
    const means = Object.entries(s.mean)
      .map(([k, x]) => `${k} ${k === "costUsd" ? money(x) : Number(x).toFixed(k === "clip" || k === "seconds" ? 1 : 3)}`)
      .join(" · ");
    ctx.print(`  ${v}: ${s.succeeded}/${s.jobs}${means ? ` · ${means}` : ""}`);
  }
  for (const s of summary.skips.slice(0, 5)) ctx.print(`  skipped ${s.count}: ${s.reason}`);
  for (const f of summary.failures.slice(0, 5)) ctx.print(`  failed ${f.id}: ${f.error}`);
}

async function run(args, ctx) {
  const { values: v } = parse(args, {
    suite: { type: "string" },
    engine: { type: "string" },
    looks: { type: "string" },
    cases: { type: "string" },
    tags: { type: "string" },
    variants: { type: "string" },
    model: { type: "string" },
    limit: { type: "string" },
    prompts: { type: "string" },
    seeds: { type: "string" },
    "dry-run": { type: "boolean" },
    list: { type: "boolean" },
    "max-usd": { type: "string" },
    "allow-unpriced": { type: "boolean" },
    concurrency: { type: "string" },
    resume: { type: "string" },
    "allow-fixtures": { type: "boolean" },
    "comfy-url": { type: "string" },
    label: { type: "string" },
    "no-report": { type: "boolean" },
    ...SCORE,
  });
  if (v.help) return ctx.print(HELP.run), 0;
  const rootDir = root(v, ctx.env);
  // A resumed run keeps its own suite and engine.
  const resumeRun = v.resume ? resolveRun(rootDir, v.resume) : null;
  const before = resumeRun ? JSON.parse(fs.readFileSync(path.join(resumeRun.dir, "run.json"), "utf8")) : null;
  const suiteName = v.suite ?? before?.harness?.suiteFile ?? before?.suite;
  if (!suiteName) throw new Usage("Name a suite with --suite (soul, dop, selftest…)");
  const suite = loadSuite(before?.harness?.suiteFile && !v.suite ? path.join(REPO_DIR, before.harness.suiteFile) : suiteName);
  const engine = v.engine ?? before?.engine;
  if (!["demo", "open", "cloud"].includes(engine)) throw new Usage("Pick --engine demo, open or cloud");
  const variants = v.variants === "all" ? Object.keys(suite.variants ?? { default: {} }) : list(v.variants);
  const { client, target } = connect({ url: v.url, token: v.token }, { env: ctx.env, home: ctx.io.home, fetch: ctx.io.fetch });
  const ac = new AbortController();
  const signal = ctx.io.signal ?? ac.signal;
  const onInt = () => {
    if (ac.signal.aborted) process.exit(130);
    ctx.note("Stopping: no new jobs start; the ones running keep going on the server. Ctrl+C again to quit now.");
    ac.abort();
  };
  if (!ctx.io.signal) process.on("SIGINT", onInt);
  try {
    const result = await runEval(
      {
        suite,
        engine,
        variants,
        cases: list(v.cases),
        looks: list(v.looks),
        tags: list(v.tags),
        limit: num(v.limit, "limit"),
        prompts: num(v.prompts, "prompts"),
        seeds: list(v.seeds)?.map((s) => num(s, "seeds")),
        model: v.model,
        dryRun: v["dry-run"],
        maxUsd: num(v["max-usd"], "max-usd"),
        allowUnpriced: v["allow-unpriced"],
        concurrency: num(v.concurrency, "concurrency"),
        root: rootDir,
        resume: resumeRun?.runId,
        allowFixtures: v["allow-fixtures"],
        comfyUrl: v["comfy-url"] ?? (engine === "open" ? (ctx.env.COMFYUI_URL ?? "http://127.0.0.1:8188") : undefined),
        label: v.label,
      },
      { client, target, log: ctx.note, signal, fetch: ctx.io.fetch },
    );
    if (result.dryRun) {
      if (v.json) return ctx.print(JSON.stringify(result, null, 2)), 0;
      const free = engine !== "cloud";
      ctx.print(`${suite.title} on ${engine} (${result.server})`);
      ctx.print(`${result.total} jobs · ${result.runnable} can run · ${result.skipped} skipped · ${result.cases} cases · estimated ${free ? "Free" : money(result.estimateUsd)}${result.unknownCost ? ` (+${result.unknownCost} without a price)` : ""}${engine === "cloud" ? ` · cap ${money(result.maxUsd)}` : ""}`);
      if (result.models.length) ctx.print(`Models: ${result.models.join(", ")} · variants: ${result.variants.join(", ")}`);
      for (const [why, n] of Object.entries(result.skipReasons).sort((a, b) => b[1] - a[1]).slice(0, 8)) ctx.print(`  ${n} skipped: ${why}`);
      if (result.missingLoras?.length) ctx.print(`LoRAs ComfyUI doesn't have yet (${result.missingLoras.length}): ${result.missingLoras.map((l) => `${l.file} (${l.jobs} job${l.jobs === 1 ? "" : "s"})`).join(", ")}`);
      if (v.list) for (const j of result.jobs) ctx.print(`  ${j.skip ? "·" : "▸"} ${j.case} · ${j.variant} · ${j.prompt} · s${j.seed} · ${j.model}${j.skip ? "" : ` · ${j.costUsd == null ? "price unknown" : free ? "Free" : money(j.costUsd)}`}${j.loras?.applied ? ` · ${j.loras.applied.join(" + ") || "no LoRAs"}` : ""}${j.skip ? ` — ${j.skip}` : ""}`);
      return 0;
    }
    if (v["no-report"]) {
      ctx.note(`Results: ${result.dir}`);
      return result.run.results.failed ? 1 : 0;
    }
    await score(result.dir, v, ctx);
    const summary = reportAll(result.dir, rootDir, ctx);
    if (v.json) ctx.print(JSON.stringify(summary, null, 2));
    else printSummary(summary, ctx);
    return summary.counts.failed || result.run.interrupted ? 1 : 0;
  } finally {
    if (!ctx.io.signal) process.off("SIGINT", onInt);
  }
}

async function report(args, ctx) {
  const { values: v, positionals } = parse(args, SCORE, { positionals: true });
  if (v.help) return ctx.print(HELP.report), 0;
  const rootDir = root(v, ctx.env);
  const { dir } = resolveRun(rootDir, positionals[0] ?? "latest");
  await score(dir, v, ctx);
  const summary = reportAll(dir, rootDir, ctx);
  if (v.json) ctx.print(JSON.stringify(summary, null, 2));
  else printSummary(summary, ctx);
  return 0;
}

async function review(args, ctx) {
  const { values: v, positionals } = parse(args, { against: { type: "string" }, port: { type: "string" }, "no-serve": { type: "boolean" }, limit: { type: "string" } }, { positionals: true });
  if (v.help) return ctx.print(HELP.review), 0;
  const rootDir = root(v, ctx.env);
  const { dir, runId } = resolveRun(rootDir, positionals[0] ?? "latest");
  let against = v.against;
  if (against && !["variants", "references"].includes(against)) {
    const other = resolveRun(rootDir, against);
    against = { dir: other.dir, runId: other.runId, rows: [...new Map(readJsonl(path.join(other.dir, "jobs.jsonl")).map((r) => [r.id, r])).values()] };
  }
  const rows = [...new Map(readJsonl(path.join(dir, "jobs.jsonl")).map((r) => [r.id, r])).values()];
  const r = writeReview({ dir, runId, rows }, { against, limit: num(v.limit, "limit") });
  if (!r.pairs) ctx.note("Nothing to compare yet: the run needs two variants of a case, your own references (scripts/eval/local/references/…), or --against another run.");
  if (v["no-serve"]) {
    ctx.print(r.file);
    return 0;
  }
  const { server, url } = await serveReview(dir, { port: num(v.port, "port") ?? 4173 });
  ctx.print(`Blind review of ${r.pairs} pair${r.pairs === 1 ? "" : "s"}: ${url}`);
  ctx.note("Ratings are saved to review/ratings.json as you go. Ctrl+C stops the server; pnpm eval:report then adds them to the summary.");
  await new Promise((resolve) => {
    const stop = () => server.close(resolve);
    process.once("SIGINT", stop);
    ctx.io.signal?.addEventListener("abort", stop, { once: true });
  });
  return 0;
}

async function compare(args, ctx) {
  const { values: v, positionals } = parse(args, { "fail-on": { type: "string" }, metric: { type: "string" }, threshold: { type: "string" }, "per-case": { type: "boolean" } }, { positionals: true });
  if (v.help) return ctx.print(HELP.compare), 0;
  if (positionals.length !== 2) throw new Usage("Give two runs: pnpm eval:compare <runA> <runB> (latest~1 latest compares the last two)");
  const rootDir = root(v, ctx.env);
  const a = resolveRun(rootDir, positionals[0]);
  const b = resolveRun(rootDir, positionals[1]);
  const c = compareRuns(a, b, { failOn: list(v["fail-on"] ?? v.metric), threshold: v.threshold, perCase: v["per-case"] });
  ctx.print(v.json ? JSON.stringify(c, null, 2) : compareText(c));
  return c.failed ? 1 : 0;
}

async function promoteCmd(args, ctx) {
  const { values: v, positionals } = parse(args, { candidate: { type: "string" }, against: { type: "string" }, record: { type: "boolean" }, "apply-strengths": { type: "boolean" }, research: { type: "string" }, "licence-hold": { type: "boolean" } }, { positionals: true });
  if (v.help) return ctx.print(HELP.promote), 0;
  const { dir } = resolveRun(root(v, ctx.env), positionals[0] ?? "latest");
  const doc = promote(dir, { candidate: v.candidate, alternatives: list(v.against), ...(v["licence-hold"] && { rule: { licenceHold: true } }) });
  ctx.print(v.json ? JSON.stringify(doc, null, 2) : promoteText(doc));
  if (v["apply-strengths"] && !v.record) throw new Usage("--apply-strengths goes with --record");
  if (!v.record) return 0;
  // --record: the verdicts go into the research JSON for a person to review (git diff), never a default.
  if (doc.engine === "demo") throw new Error("A demo run measures the harness, not models: there is nothing to record in the research.");
  const records = researchRecords(doc, { applyStrengths: v["apply-strengths"] });
  if (!records.length) return ctx.note("No look or motion in this run to record."), 0;
  const file = path.resolve(v.research ?? path.join(REPO_DIR, RECIPES_FILE));
  const recordsFile = path.join(dir, "research-records.json");
  fs.writeFileSync(recordsFile, `${JSON.stringify(records, null, 2)}\n`);
  const py = ctx.env.FUOBE_EVAL_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const r = spawnSync(py, ["-I", path.join(METRICS_DIR, "fuobe_metrics", "research.py"), recordsFile, file], { encoding: "utf8", env: ctx.env });
  if (r.error) throw new Error(`--record needs Python 3 (${py} isn't there; set FUOBE_EVAL_PYTHON)`);
  if (r.status !== 0) throw new Error(`Recording failed: ${(r.stderr || r.stdout).trim().split("\n").at(-1)}`);
  const res = JSON.parse(r.stdout);
  ctx.note(`Recorded ${res.recorded} result${res.recorded === 1 ? "" : "s"} in ${path.relative(REPO_DIR, file) || file} (each entry's "eval" list). Review the diff; recipes and defaults change only by hand.`);
  if (res.lowered?.length) {
    ctx.note(`Lowered the strengths of ${res.lowered.length} LoRA${res.lowered.length === 1 ? "" : "s"} where half strength won:`);
    for (const l of res.lowered) ctx.note(`  ${l.entry}: ${l.file} ${l.from} → ${l.to}`);
    ctx.note("Review the diff, run pnpm gen:catalog, and measure both engines again before committing.");
  }
  for (const m of res.missing) ctx.note(`  not in the research: ${JSON.stringify(m)}`);
  return 0;
}

async function history(args, ctx) {
  const { values: v } = parse(args, { suite: { type: "string" }, case: { type: "string" }, limit: { type: "string" } });
  if (v.help) return ctx.print(HELP.history), 0;
  const rootDir = root(v, ctx.env);
  const runs = listRuns(rootDir).filter((r) => !v.suite || r.run.suite === v.suite);
  const rows = readJsonl(path.join(rootDir, "history.jsonl")).filter((r) => (!v.suite || r.suite === v.suite) && (!v.case || r.caseId === v.case));
  if (v.json) return ctx.print(JSON.stringify({ runs: runs.map((r) => ({ runId: r.runId, ...r.run.results, engine: r.run.engine, suite: r.run.suite, startedAt: r.run.startedAt, label: r.run.label })), history: rows }, null, 2)), 0;
  if (!runs.length) return ctx.print(`No runs in ${rootDir} yet. Start with: pnpm eval:run --suite selftest --engine demo`), 0;
  for (const r of runs.slice(0, num(v.limit, "limit") ?? 20)) {
    const res = r.run.results ?? {};
    ctx.print(`${r.runId}  ${r.run.engine}  ${res.succeeded ?? 0} done${res.failed ? ` · ${res.failed} failed` : ""}${res.skipped ? ` · ${res.skipped} skipped` : ""}${r.run.engine === "cloud" && r.run.spentUsd != null ? ` · ${money(r.run.spentUsd)}` : ""}${r.run.label ? `  ${r.run.label}` : ""}`);
  }
  if (v.case) for (const h of rows) ctx.print(`  ${h.runId} ${h.variant}: ${Object.entries(h.scores).map(([k, x]) => `${k} ${Number(x).toFixed(3)}`).join(" · ")}`);
  return 0;
}

async function validate(args, ctx) {
  const { values: v, positionals } = parse(args, {}, { positionals: true });
  if (v.help) return ctx.print(HELP.validate), 0;
  const results = validateAll(positionals.length ? positionals.map((p) => path.resolve(p)) : suiteFiles());
  let bad = results.filter((r) => !r.ok).length;
  const { generated } = await import("./gen-cases.mjs");
  const gen = generated();
  const stale = ["soul.json", "dop.json", "dop-mix.json", "dop-mixed-media.json", "case.schema.json"].filter((name) => {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "cases", name);
    const want = `${JSON.stringify(gen[name], null, 2)}\n`;
    // A Windows checkout may have CRLF line endings: the same content.
    return !fs.existsSync(file) || fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n") !== want;
  });
  if (v.json) return ctx.print(JSON.stringify({ suites: results, stale }, null, 2)), bad || stale.length ? 1 : 0;
  for (const r of results) {
    ctx.print(`${r.ok ? "✓" : "✗"} ${path.relative(REPO_DIR, r.file)}${r.ok ? ` · ${r.cases} cases` : ""}${r.runFirst === "paid-keys" ? " · run it first once you have paid keys" : ""}`);
    for (const l of r.lines) ctx.print(`    ${l}`);
  }
  for (const s of stale) ctx.print(`✗ cases/${s} is out of date with the research: node scripts/eval/gen-cases.mjs`);
  bad += stale.length;
  return bad ? 1 : 0;
}

/**
 * A run's generations to the Trash of the Fuobe it ran on: the harness's renders stay out of the Library
 * anyway (feature "eval" is a helper), but a studio route's steps carry the studio's own feature. The run's
 * folder here keeps its outputs and scores. The token rides only to that server, as with every command.
 */
async function trash(args, ctx) {
  const { values: v, positionals } = parse(args, { "dry-run": { type: "boolean" } }, { positionals: true });
  if (v.help) return ctx.print(HELP.trash), 0;
  const { dir, runId } = resolveRun(root(v, ctx.env), positionals[0] ?? "latest");
  const run = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
  if (!run.server?.url && !v.url) throw new Error(`${runId} doesn't say which Fuobe it ran on: name it with --url`);
  // Every attempt's generations, and a studio route's steps.
  const ids = [...new Set(readJsonl(path.join(dir, "jobs.jsonl")).flatMap((r) => [...(r.generations ?? []), ...(r.steps ?? [])]))];
  const { client, target } = connect({ url: v.url ?? run.server?.url, token: v.token }, { env: ctx.env, home: ctx.io.home, fetch: ctx.io.fetch });
  if (v["dry-run"]) return ctx.print(`${ids.length} generation${ids.length === 1 ? "" : "s"} of ${runId} would go to the Trash on ${target.url}`), 0;
  let moved = 0;
  let gone = 0;
  for (const id of ids) {
    try {
      await client.request("DELETE", `/api/generations/${encodeURIComponent(id)}`);
      moved++;
    } catch (e) {
      if (e.status === 404) gone++;
      else throw e;
    }
  }
  if (v.json) return ctx.print(JSON.stringify({ runId, server: target.url, moved, gone }, null, 2)), 0;
  ctx.print(`Moved ${moved} generation${moved === 1 ? "" : "s"} of ${runId} to the Trash on ${target.url}${gone ? ` (${gone} were gone already)` : ""}. The run's results here stay; empty the Trash in Fuobe to delete them for good.`);
  return 0;
}

async function covers(args, ctx) {
  const { values: v, positionals } = parse(
    args,
    {
      variant: { type: "string" },
      "dry-run": { type: "boolean" },
      "public-dir": { type: "string" },
      manifest: { type: "string" },
      "commercial-only": { type: "boolean" },
      "from-masters": { type: "string" },
      run: { type: "string" },
      engine: { type: "string" },
      model: { type: "string" },
      "video-model": { type: "string" },
      suite: { type: "string" },
      only: { type: "string" },
      force: { type: "boolean" },
      replace: { type: "boolean" },
      versions: { type: "boolean" },
      templates: { type: "string" },
    },
    { positionals: true },
  );
  if (v.help) return ctx.print(HELP.covers), 0;
  if (v["from-masters"]) return coversFromMastersCmd(v, ctx);
  if (v.templates) return templateCoversCmd(v, ctx);
  if (v.versions) return versionsCmd(v, ctx);
  const { dir } = resolveRun(root(v, ctx.env), positionals[0] ?? "latest");
  const r = makeCovers(dir, { variant: v.variant, dryRun: v["dry-run"], publicDir: v["public-dir"] && path.resolve(v["public-dir"]), manifest: v.manifest && path.resolve(v.manifest), commercialOnly: v["commercial-only"] });
  if (v.json) return ctx.print(JSON.stringify(r, null, 2)), 0;
  ctx.print(`${r.covers.length} cover${r.covers.length === 1 ? "" : "s"} from ${r.runId} (${r.engine}, ${r.variant})${v["dry-run"] ? " would be made" : ""}`);
  for (const c of r.covers) ctx.print(`  ${c.key} ← ${c.job}${c.metric ? ` (best ${c.metric}${c.score != null ? ` ${Number(c.score).toFixed(3)}` : ""})` : ""}`);
  for (const sk of r.skipped.slice(0, 10)) ctx.print(`  · ${sk.caseId}: ${sk.why}`);
  if (r.skipped.length > 10) ctx.print(`  · and ${r.skipped.length - 10} more`);
  if (r.covers.length && !v["dry-run"]) ctx.note(`Look at the media in ${path.relative(REPO_DIR, r.folder) || r.folder} and the diff of ${path.relative(REPO_DIR, r.manifest) || r.manifest} before committing them.`);
  return 0;
}

/**
 * pnpm eval:covers --versions: the manifest's URLs versioned from the files as they are, encoding only the posters'
 * missing or outdated small copies. Fails (1) when a URL is left without a version (its file is missing), or on a dry
 * run when a small copy is due: until it's made, the versions don't match what the site would serve.
 */
function versionsCmd(v, ctx) {
  const dry = v["dry-run"];
  const publicDir = v["public-dir"] && path.resolve(v["public-dir"]);
  const presets = versionCovers({ dryRun: dry, publicDir, manifest: v.manifest && path.resolve(v.manifest) });
  // The template tiles' manifest is versioned with it (its own file: --manifest names the presets' alone).
  const templates = v.manifest ? null : versionTemplateCovers({ dryRun: dry, publicDir });
  const both = [presets, templates].filter(Boolean);
  const status = both.some((r) => r.unversioned.length || (dry && r.thumbs.length)) ? 1 : 0;
  if (v.json) return ctx.print(JSON.stringify(templates ? { ...presets, templates } : presets, null, 2)), status;
  for (const r of both) versionsReport(r, r === templates ? "template tile " : "", dry, ctx);
  return status;
}

function versionsReport(r, what, dry, ctx) {
  ctx.print(`${r.changed} of ${r.urls} ${what}cover URLs in ${r.entries} entries ${dry ? "would get" : "got"} a new version`);
  const list = (items, why) => {
    for (const u of items.slice(0, 10)) ctx.print(`  · ${u}: ${why}`);
    if (items.length > 10) ctx.print(`  · and ${items.length - 10} more`);
  };
  list(r.thumbs, dry ? "small copy missing or older than its poster: would be made first" : "small copy made (it was missing or older than its poster)");
  list(r.unversioned, "no file, so no version");
  if ((r.changed || r.thumbs.length) && !dry) ctx.note(`Look at the diff of ${path.relative(REPO_DIR, r.manifest) || r.manifest}${r.thumbs.length ? " and the small copies it made" : ""} before committing them.`);
}

/** pnpm eval:covers --templates <dir>: the template tiles' covers from rendered masters, merged into their manifest. */
function templateCoversCmd(v, ctx) {
  const r = templateCoversFromMasters(path.resolve(v.templates), {
    only: v.only?.split(",").map((s) => s.trim()).filter(Boolean),
    force: v.force,
    dryRun: v["dry-run"],
    publicDir: v["public-dir"] && path.resolve(v["public-dir"]),
  });
  if (v.json) return ctx.print(JSON.stringify(r, null, 2)), 0;
  const n = (k, word) => `${k} ${word}${k === 1 ? "" : "s"}`;
  const clips = r.covers.filter((c) => c.video).length;
  const kept = r.covers.filter((c) => c.kept).length;
  const same = r.covers.filter((c) => c.same).length;
  const tail = v["dry-run"] ? " would be made" : kept ? `, ${kept} already up to date` : "";
  ctx.print(`${n(r.covers.length, "template tile cover")} (${n(clips, "clip")}, ${n(r.covers.length - clips, "still")}, ${same} showing a preset's cover)${tail}`);
  for (const c of r.covers.slice(0, 20)) ctx.print(`  ${c.key} ← ${c.same ?? path.basename(c.from)}${c.frames ? ` + ${n(c.frames, "frame")}` : ""}${c.kept ? " · up to date" : ""}`);
  if (r.covers.length > 20) ctx.print(`  and ${r.covers.length - 20} more`);
  for (const sk of r.skipped.slice(0, 10)) ctx.print(`  · ${sk.key}: ${sk.why}`);
  if (r.skipped.length > 10) ctx.print(`  · and ${r.skipped.length - 10} more`);
  if (r.covers.length && !v["dry-run"]) ctx.note(`Look at the media in ${path.relative(REPO_DIR, r.folder) || r.folder} and the diff of ${path.relative(REPO_DIR, r.manifest) || r.manifest} before committing them.`);
  return 0;
}

/** pnpm eval:covers --from-masters <dir>: covers from rendered masters, merged into the manifest. */
function coversFromMastersCmd(v, ctx) {
  if (!v.run) throw new Usage("--from-masters needs --run <name>: the provenance every cover it makes records");
  const r = coversFromMasters(path.resolve(v["from-masters"]), {
    run: v.run,
    engine: v.engine,
    model: v.model,
    videoModel: v["video-model"],
    variant: v.variant,
    suite: v.suite,
    only: v.only?.split(",").map((s) => s.trim()).filter(Boolean),
    force: v.force,
    replace: v.replace,
    dryRun: v["dry-run"],
    publicDir: v["public-dir"] && path.resolve(v["public-dir"]),
    manifest: v.manifest && path.resolve(v.manifest),
  });
  if (v.json) return ctx.print(JSON.stringify(r, null, 2)), 0;
  const n = (k, word) => `${k} ${word}${k === 1 ? "" : "s"}`;
  const clips = r.covers.filter((c) => c.video).length;
  const kept = r.covers.filter((c) => c.kept).length;
  const tail = v["dry-run"] ? " would be made" : kept ? `, ${kept} already up to date` : "";
  ctx.print(`${n(r.covers.length, "cover")} from masters (${n(clips, "clip")}, ${n(r.covers.length - clips, "still")}) as ${r.run} (${r.engine})${tail}`);
  for (const c of r.covers.slice(0, 20)) ctx.print(`  ${c.key} ← ${path.basename(c.from)}${c.model ? ` (${c.model})` : ""}${c.kept ? " · up to date" : ""}`);
  if (r.covers.length > 20) ctx.print(`  and ${r.covers.length - 20} more`);
  for (const sk of r.skipped.slice(0, 10)) ctx.print(`  · ${sk.id}: ${sk.why}`);
  if (r.skipped.length > 10) ctx.print(`  · and ${r.skipped.length - 10} more`);
  if (r.covers.length && !v["dry-run"]) ctx.note(`Look at the media in ${path.relative(REPO_DIR, r.folder) || r.folder} and the diff of ${path.relative(REPO_DIR, r.manifest) || r.manifest} before committing them.`);
  return 0;
}

async function setup(args, ctx) {
  const { values: v } = parse(args, { identity: { type: "boolean" }, asr: { type: "boolean" }, dinov2: { type: "boolean" }, scrfd: { type: "boolean" }, download: { type: "boolean" }, "torch-backend": { type: "string" } });
  if (v.help) return ctx.print(HELP.setup), 0;
  const step = (cmd, a, opts = {}) => {
    ctx.note(`$ ${cmd} ${a.join(" ")}`);
    const r = spawnSync(cmd, a, { cwd: METRICS_DIR, stdio: "inherit", env: ctx.env, ...opts });
    if (r.error) throw new Error(`${cmd} isn't installed: get uv from https://docs.astral.sh/uv/ (one command), then run pnpm eval:setup again`);
    if (r.status !== 0) throw new Error(`${cmd} ${a[0]} failed (exit ${r.status})`);
  };
  const py = process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python";
  if (!fs.existsSync(path.join(METRICS_DIR, py))) step("uv", ["venv", ".venv", "--python", ">=3.11"]);
  step("uv", ["pip", "install", "--python", py, "-r", "requirements.txt", "--torch-backend", v["torch-backend"] ?? "cpu"]);
  if (v.identity) step("uv", ["pip", "install", "--python", py, "-r", "requirements-identity.txt"]);
  if (v.asr) step("uv", ["pip", "install", "--python", py, "-r", "requirements-asr.txt", "--torch-backend", v["torch-backend"] ?? "cpu"]);
  if (v.download) step(py, ["-m", "fuobe_metrics.download", ...(v.identity ? ["--identity"] : []), ...(v.asr ? ["--asr"] : []), ...(v.dinov2 ? ["--dinov2"] : []), ...(v.scrfd ? ["--scrfd"] : [])]);
  ctx.print(`Metrics ready in ${path.join(METRICS_DIR, ".venv")}${v.download ? "" : " (weights download on first use, or run pnpm eval:setup --download)"}.`);
  return 0;
}

// Run directly (not imported by the tests). Compared as URLs, so a Windows script path matches too.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
