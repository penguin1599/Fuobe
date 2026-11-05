// Turning a suite into jobs: case × prompt (or shot) × seed × variant, each with the API request
// it sends, the recipe it records, its inputs, references and metrics. Pure: what's on disk and on
// the server comes in through `opts` (exists, available model ids).
import fs from "node:fs";
import path from "node:path";
import { isRemote, listMedia, resolveInput, safeName } from "./paths.mjs";
import { composeLookPrompt, lorasFor, recipeFor, soulLook, triggersOf } from "./recipes.mjs";

const SLOTS = ["images", "endImage", "mask", "video", "videos", "audio", "audio2", "audios", "voiceAudio"];

/** The suite's target for an engine: demo falls back to the open target, then the cloud one. */
export const targetFor = (suite, engine) => suite.targets[engine] ?? (engine === "demo" ? (suite.targets.open ?? suite.targets.cloud) : undefined);

/** Prompts as objects with ids (p1, p2… unless named). */
export function promptsOf(suite, kase) {
  if (kase.shots) return kase.shots.map((s, i) => ({ id: s.id ?? `shot-${i + 1}`, text: s.prompt, seed: s.seed, shot: { index: i, of: kase.shots.length, duration: s.duration, presetId: s.presetId } }));
  const list = kase.prompts ?? suite.defaults.prompts ?? [""];
  return list.map((p, i) => (typeof p === "string" ? { id: `p${i + 1}`, text: p } : { id: p.id ?? `p${i + 1}`, ...p }));
}

/** Does a case match the filters (--cases ids or prefixes with *, --looks ids / slugs / names, --tags)? */
export function matches(kase, f = {}) {
  const like = (pattern, value) => {
    if (!value) return false;
    const p = pattern.toLowerCase();
    const v = value.toLowerCase();
    return p.includes("*") ? new RegExp(`^${p.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(v) : v === p || v.endsWith(`/${p}`);
  };
  if (f.cases?.length && !f.cases.some((c) => like(c, kase.id))) return false;
  if (f.looks?.length) {
    const look = kase.look ? soulLook(kase.look) : null;
    if (!look || !f.looks.some((l) => [look.id, look.slug, look.name].some((v) => like(l, v)) || like(l, kase.id))) return false;
  }
  if (f.tags?.length && !f.tags.some((t) => kase.tags?.includes(t))) return false;
  return true;
}

/** Inputs with absolute paths (links kept), and the local files among them that are missing. */
function resolveInputs(inputs, suiteDir, exists) {
  const out = {};
  const missing = [];
  for (const slot of SLOTS) {
    const v = inputs?.[slot];
    if (v === undefined) continue;
    const one = (ref) => {
      const abs = resolveInput(ref, suiteDir);
      if (!isRemote(abs) && !exists(abs)) missing.push(ref);
      return abs;
    };
    out[slot] = Array.isArray(v) ? v.map(one) : one(v);
  }
  return { inputs: out, missing };
}

const defaultExists = (p) => fs.existsSync(p);
/** A per-engine value; demo takes the open one, then the cloud one. */
const forEngine = (m, engine) => m?.[engine] ?? (engine === "demo" ? (m?.open ?? m?.cloud) : undefined);
const jobId = (caseId, promptId, seed, variant) => safeName(`${caseId.replaceAll("/", "__")}--${promptId}--s${seed}--${variant}`);

/**
 * Expand a suite into jobs.
 * @param {object} suite a parsed suite (SuiteSchema output) with `file` (its path)
 * @param {object} opts
 * @param {"demo" | "open" | "cloud"} opts.engine
 * @param {string[]} [opts.variants] variant names (default: the suite's default variant)
 * @param {string[]} [opts.cases] @param {string[]} [opts.looks] @param {string[]} [opts.tags] filters
 * @param {number} [opts.limit] at most this many cases
 * @param {number} [opts.prompts] at most this many prompts per case
 * @param {number[]} [opts.seeds] seeds instead of the suite's (pinned prompt seeds stay)
 * @param {string} [opts.model] one model id for every job
 * @param {Set<string> | null} [opts.available] model ids the server has (null: not checked)
 * @param {boolean} [opts.allowFixtures] use a case's demoInputs when its local inputs are missing
 * @param {(p: string) => boolean} [opts.exists]
 */
export function expandJobs(suite, opts) {
  const { engine } = opts;
  const exists = opts.exists ?? defaultExists;
  const suiteDir = suite.file ? path.dirname(suite.file) : process.cwd();
  const variantDefs = suite.variants ?? { default: {} };
  const variantNames = opts.variants?.length ? opts.variants : [suite.defaults.variant ?? Object.keys(variantDefs)[0]];
  for (const v of variantNames) if (!variantDefs[v]) throw new Error(`${suite.suite} has no variant “${v}” (it has ${Object.keys(variantDefs).join(", ")})`);
  const target = targetFor(suite, engine);
  const selected = suite.cases.filter((c) => matches(c, opts)).slice(0, opts.limit ?? Infinity);
  const jobs = [];
  for (const kase of selected) {
    const recipe = recipeFor(suite.recipe, kase);
    const prompts = promptsOf(suite, kase).slice(0, opts.prompts ?? Infinity);
    const demo = engine === "demo";
    let { inputs, missing } = resolveInputs(demo ? (kase.demoInputs ?? kase.inputs) : kase.inputs, suiteDir, exists);
    let usedFixtures = demo && !!kase.demoInputs;
    if (!demo && missing.length && opts.allowFixtures && kase.demoInputs) {
      ({ inputs, missing } = resolveInputs(kase.demoInputs, suiteDir, exists));
      usedFixtures = true;
    }
    const refList = kase.references ? (Array.isArray(kase.references) ? kase.references : [kase.references]) : [];
    const references = refList.flatMap((r) => (isRemote(r) ? [r] : listMedia(resolveInput(r, suiteDir))));
    const metrics = kase.metrics ?? suite.defaults.metrics;
    for (const variantName of variantNames) {
      const variant = variantDefs[variantName];
      // The models, most specific first: --model, this case's models for the variant, the variant's, the case's, the suite's.
      const candidates = opts.model ? [opts.model] : (forEngine(kase.variantModels?.[variantName], engine) ?? forEngine(variant.models, engine) ?? forEngine(kase.models, engine) ?? target?.models ?? []);
      const modelId = opts.available ? candidates.find((m) => opts.available.has(m)) : candidates[0];
      for (const p of prompts) {
        const seeds = p.seed !== undefined ? [p.seed] : (opts.seeds ?? suite.defaults.seeds);
        for (const seed of seeds) {
          const notes = [];
          /** @type {string | null} */
          let skip = null;
          if (kase.engines && !kase.engines.includes(engine)) skip = `runs on ${kase.engines.join(" / ")} only`;
          else if (variant.engines && !variant.engines.includes(engine)) skip = `the ${variantName} variant runs on ${variant.engines.join(" / ")} only`;
          else if (variant.tags && !variant.tags.some((t) => kase.tags?.includes(t))) skip = `the ${variantName} variant runs on cases tagged ${variant.tags.join(" or ")} only`;
          else if (!target && !variant.models && !kase.models && !kase.variantModels?.[variantName]) skip = `${suite.suite} has no ${engine} target`;
          else if (!modelId) skip = `none of ${candidates.join(", ")} is on this Fuobe`;
          else if (missing.length) skip = `missing local input${missing.length > 1 ? "s" : ""} ${missing.join(", ")} (see scripts/eval/README.md → Your own inputs)`;
          if (usedFixtures && !demo) notes.push("ran on the synthetic fixtures (--allow-fixtures), not your own inputs");

          // The request: the case's own words and settings, then the variant's recipe. Fixed words (a one-look
          // Original's tail, a HEX palette's sentence) follow the prompt as the server adds a signature's ("{prompt}. {words}").
          const fixed = variant.template === false ? "" : [variant.words, kase.words].filter(Boolean).join(" ");
          const text = p.text.trim().replace(/[.\s]+$/, "");
          let prompt = fixed ? (text ? `${text}. ${fixed}` : fixed) : p.text;
          let loras = [];
          let wanted = 0;
          const usesLook = recipe?.kind === "soul-look";
          const lookOnServer = usesLook && variant.lookParam;
          if (usesLook && !lookOnServer) {
            const picked = lorasFor(recipe, variant, engine, "recipe", modelId);
            loras = picked.loras;
            wanted = picked.wanted ?? 0;
            notes.push(...picked.notes);
            if (variant.template !== false) prompt = composeLookPrompt(recipe.template, p.text, triggersOf(loras));
          } else if (recipe && !lookOnServer) {
            const picked = lorasFor(recipe, variant, engine, "none", modelId);
            loras = picked.loras;
            wanted = picked.wanted ?? 0;
            notes.push(...picked.notes);
            // A variant that is about the recipe's LoRAs means nothing when none of them can run here.
            if (!skip && variant.loras === "recipe" && picked.wanted && !loras.length) skip = `none of the recipe's LoRAs can run on ${engine === "cloud" ? "the cloud" : modelId}: ${picked.notes.join("; ")}`;
            // Triggers lead, joined like a look's ("triggers, prompt": the research's template convention).
            const triggers = triggersOf(loras);
            if (triggers) prompt = `${triggers}, ${prompt}`.trim();
          } else if (variant.loras && variant.loras !== "recipe" && variant.loras !== "none") {
            const picked = lorasFor(null, variant, engine, "none", modelId);
            loras = picked.loras;
            wanted = picked.wanted ?? 0;
            notes.push(...picked.notes);
            const triggers = triggersOf(loras);
            if (triggers) prompt = `${triggers}, ${prompt}`.trim();
          }
          const presetId = variant.preset === false ? undefined : (p.shot?.presetId ?? kase.presetId);
          const params = {
            ...target?.params,
            ...suite.defaults.params,
            ...kase.params,
            ...variant.params,
            ...(p.shot?.duration && { duration: p.shot.duration }),
            seed,
          };
          const extra = { ...target?.extra, ...suite.defaults.extra, ...kase.extra, ...variant.extra };
          if (Object.keys(extra).length) params.extra = extra;
          const request = {
            feature: "eval",
            modelId: modelId ?? candidates[0] ?? "",
            // The engine it runs on: a Fuobe Original runs on both and takes this one (single-engine models ignore it).
            ...(engine !== "demo" && { engine }),
            ...((variant.op ?? kase.op ?? target?.op) && { op: variant.op ?? kase.op ?? target?.op }),
            // A training case's "{character}" becomes the trained element's @handle in the runner.
            ...(prompt && { prompt }),
            ...(p.negative && { negativePrompt: p.negative }),
            // The Original applies the look on the server, named by its Fuobe id ("v1-general"): a Higgsfield look id never leaves the harness.
            ...(lookOnServer ? { presetId: recipe.look.slug } : presetId ? { presetId } : {}),
            ...(variant.presetStrength !== undefined && presetId && { presetStrength: variant.presetStrength }),
            ...(kase.mix && variant.mix !== false && presetId && { mix: kase.mix }),
            ...(loras.length && { loras }),
            params,
            title: `Eval · ${kase.title}${p.shot ? ` · shot ${p.shot.index + 1}` : ""}`,
          };
          jobs.push({
            id: jobId(kase.id, p.id, seed, variantName),
            key: `${kase.id}/${p.id}/s${seed}`,
            suite: suite.suite,
            caseId: kase.id,
            caseTitle: kase.title,
            group: kase.id,
            variant: variantName,
            promptId: p.id,
            prompt: p.text,
            seed,
            engine,
            kind: suite.kind,
            model: { id: request.modelId, candidates },
            request,
            inputs,
            references,
            metrics,
            // complete: every LoRA the variant asked for is sent (the runner also checks what the server's route loads).
            recipe: recipe && { ...recipe, variant: variantName, sent: { loras, wanted, complete: loras.length === wanted, template: usesLook && !lookOnServer && variant.template !== false, lookOnServer: !!lookOnServer, presetStrength: variant.presetStrength ?? null } },
            ...(p.shot && { shot: p.shot }),
            ...(kase.train && { train: { ...kase.train, photos: resolveInput(kase.train.photos, suiteDir), target: kase.train.targets[engine] ?? null } }),
            ...((kase.submit ?? variant.submit) && { submit: kase.submit ?? variant.submit }),
            timeoutSeconds: suite.defaults.timeoutSeconds,
            notes,
            ...(skip && { skip }),
          });
        }
      }
    }
  }
  return jobs;
}

/** How many jobs run, how many are skipped and why (the dry run's summary). */
export function planSummary(jobs) {
  const runnable = jobs.filter((j) => !j.skip);
  const reasons = {};
  for (const j of jobs) if (j.skip) reasons[j.skip] = (reasons[j.skip] ?? 0) + 1;
  return {
    jobs: jobs.length,
    runnable: runnable.length,
    skipped: jobs.length - runnable.length,
    cases: new Set(jobs.map((j) => j.caseId)).size,
    models: [...new Set(runnable.map((j) => j.model.id))],
    variants: [...new Set(jobs.map((j) => j.variant))],
    skipReasons: reasons,
  };
}
