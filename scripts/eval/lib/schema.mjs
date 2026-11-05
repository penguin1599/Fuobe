// The case-file format (scripts/eval/cases/*.json): one suite per Fuobe Original, its targets per
// engine, the recipe variants to compare, and the cases (prompt sets with pinned seeds, inputs,
// references, training runs, shot lists). `pnpm eval:validate` and tests/eval-harness.test.ts check
// every file against it; `schemaJson()` writes cases/case.schema.json for editors.
import { z } from "zod";

export const ENGINES = /** @type {const} */ (["demo", "open", "cloud"]);
export const METRICS = /** @type {const} */ (["clip", "aesthetic", "style", "identity", "temporal", "lipsync", "continuity", "palette", "background", "separation", "wer", "splat"]);

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lower-case letters, digits and dashes");
const CaseId = z.string().max(120).regex(/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/, "lower-case words joined by - . _ and /");
/** A file: local/… (yours, git-ignored), fixtures/…, samples/… (public/samples), absolute, relative to the case file, or a link. */
const FileRef = z.string().min(1).max(500);
const Json = z.record(z.string(), z.unknown());

/** GenerationRequest.params as the API takes it (checked again by the server). */
const Params = z
  .object({
    aspectRatio: z.string().optional(),
    resolution: z.string().optional(),
    duration: z.number().positive().optional(),
    numOutputs: z.number().int().min(1).max(8).optional(),
    generateAudio: z.boolean().optional(),
    fps: z.number().positive().optional(),
    palette: z.array(z.string()).optional(),
    styleId: z.string().optional(),
    voice: z.string().optional(),
    targetLanguage: z.string().optional(),
    startTime: z.number().min(0).optional(),
    endTime: z.number().min(0).optional(),
    shots: z.array(z.object({ prompt: z.string(), duration: z.number().positive() })).optional(),
    matteOutput: z.enum(["cutout", "matte"]).optional(),
  })
  .catchall(z.unknown());

const Inputs = z
  .object({
    images: z.array(FileRef).max(14).optional(),
    endImage: FileRef.optional(),
    mask: FileRef.optional(),
    video: FileRef.optional(),
    videos: z.array(FileRef).max(24).optional(),
    audio: FileRef.optional(),
    audio2: FileRef.optional(),
    audios: z.array(FileRef).max(10).optional(),
    voiceAudio: FileRef.optional(),
  })
  .strict();

const LoraSpec = z
  .object({
    file: z.string().min(1).max(200),
    url: z.string().regex(/^https:\/\//).optional(),
    strength: z.number().min(-4).max(4).optional(),
    trigger: z.string().max(200).optional(),
    target: z.enum(["high", "low", "both"]).optional(),
    commercial: z.boolean().optional(),
    hostedOk: z.boolean().optional(),
    licence: z.string().optional(),
    name: z.string().max(200).optional(),
    /** The base it was trained for (a model that can't load it leaves it out). */
    base: z.string().max(60).optional(),
    /** "civitai-token": its link needs the user's civitai key, so the cloud leaves it out unless it has a hostedUrl. */
    download: z.enum(["direct", "civitai-token"]).optional(),
    hostedUrl: z.string().regex(/^https:\/\//).optional(),
  })
  .strict();

const Prompt = z.union([
  z.string().min(1).max(4000),
  z
    .object({
      id: Slug.optional(),
      text: z.string().min(1).max(4000),
      seed: z.number().int().min(0).max(2 ** 31 - 1).optional(),
      negative: z.string().max(2000).optional(),
    })
    .strict(),
]);

const Shot = z
  .object({
    id: Slug.optional(),
    prompt: z.string().min(1).max(4000),
    duration: z.number().positive().max(60).optional(),
    presetId: z.string().optional(),
    seed: z.number().int().min(0).optional(),
  })
  .strict();

const PerEngine = (inner) => z.object({ demo: inner.optional(), open: inner.optional(), cloud: inner.optional() }).strict();

const Target = z
  .object({
    /** Model ids in order of preference: the first one this Fuobe has is used (an Original first, then today's base). */
    models: z.array(z.string().min(1)).min(1),
    op: z.string().optional(),
    params: Params.optional(),
    /** params.extra for this engine: workflow inputs on ComfyUI (steps, shift…), payload fields on fal. */
    extra: Json.optional(),
  })
  .strict();

const Submit = z
  .object({
    /** A studio route that builds a pipeline (POST), e.g. /api/mixed-media. */
    route: z.string().regex(/^\/api\/[\w/-]+$/),
    /**
     * The body. Filled in: {{inputs.video}}, {{inputs.images.0}}… (uploaded URLs), {{source:inputs.video}} (the clip as
     * studios take it: url, name, duration, fps, width, height, hasAudio), {{prompt}}, {{seed}}, {{engine}} (open or
     * cloud; demo runs send open), {{requestId}} and {{request}} (the job's own /api/generations request, e.g. for
     * POST /api/palettes/lock; {{request.params.palette}} is its palette).
     */
    body: Json,
    /** Which generations of the answer are the result: the final step (default), the last listed, or all. */
    result: z.enum(["final", "last", "all"]).default("final"),
    /** Where the same body is priced (default: the route + /estimate; false when the route has none). */
    estimate: z.union([z.string().regex(/^\/api\/[\w/-]+$/), z.literal(false)]).optional(),
  })
  .strict();

const Variant = z
  .object({
    description: z.string().optional(),
    /** Soul looks: put the look's template and LoRA triggers around the prompt (default true). False also drops `words`. */
    template: z.boolean().optional(),
    /** Fixed words after the prompt ("{prompt}. {words}"): a one-look Original's tail (Soul Cinema). */
    words: z.string().max(2000).optional(),
    /** The recipe's LoRAs from the research ("recipe"), none, or your own list. */
    loras: z.union([z.literal("recipe"), z.literal("none"), z.array(LoraSpec).max(8)]).optional(),
    /** Multiplies every recipe LoRA's strength. */
    loraScale: z.number().min(0).max(4).optional(),
    /** Send the case's presetId (default true when the case has one). */
    preset: z.boolean().optional(),
    /** Motions / effects: 0 runs the preset's prompt without its catalog LoRAs. */
    presetStrength: z.number().min(0).max(1).optional(),
    /** Send the case's Mix (default true when the case has one); false runs its first preset alone. */
    mix: z.boolean().optional(),
    /** The server's own Original applies the look: send the look's Fuobe id ("v1-general") as presetId and no client recipe. */
    lookParam: z.literal("presetId").optional(),
    /** Other models for this variant (A/B a model against the recipe). A case can name its own (variantModels). */
    models: PerEngine(z.array(z.string().min(1)).min(1)).optional(),
    /** The engines this variant runs on (a partner model is a cloud model: on the others it would repeat another variant). */
    engines: z.array(z.enum(ENGINES)).min(1).optional(),
    /** The op this variant's models run (a cleaner beside the splitters: enhance-voice), over the case's and the target's. */
    op: z.string().optional(),
    /** The cases this variant runs on: those with one of these tags (the splat suite's photo crop runs on photos only). The others skip it. */
    tags: z.array(Slug).min(1).optional(),
    params: Params.optional(),
    extra: Json.optional(),
    /** Send this variant through a studio route instead of /api/generations (the case's own submit wins). */
    submit: Submit.optional(),
  })
  .strict();

const Train = z
  .object({
    /** A folder of the person's photos (local/characters/<name>/): never committed. */
    photos: FileRef,
    /** Training target ids per engine (GET /api/elements/<id>/trainings lists them). */
    targets: PerEngine(z.string().min(1)),
    name: z.string().min(1).max(60).optional(),
    /** A person (a Soul ID, trained as a subject, consent first) or a look (a moodboard's style, trained as a style). */
    kind: z.enum(["character", "style"]).default("character"),
    minPhotos: z.number().int().min(1).default(5),
    /** The people in the photos agreed to being trained on. A character's training refuses to start without it. */
    consent: z.boolean().default(false),
    /** An element that is already trained (its id): the run uses it instead of training again. */
    element: z.string().min(1).max(64).optional(),
  })
  .strict();


export const CaseSchema = z
  .object({
    id: CaseId,
    title: z.string().min(1).max(200),
    /** A Soul look id (docs/research/higgsfield-image-studios.json soulPresets[].id): the recipe comes from the research. */
    look: z.string().optional(),
    /** A motion or effect name in the research's motionsEffects map (fuobe-originals-recipes-5.json). */
    motion: z.string().optional(),
    presetId: z.string().optional(),
    /** Fuobe DoP's Mix: a second motion or effect on the same run, at its strength (0–1). */
    mix: z.object({ presetId: z.string().min(1), strength: z.number().min(0).max(1) }).strict().optional(),
    /** The case's fixed words after the prompt and the variant's words (a HEX palette's sentence); a variant with template: false leaves them out. */
    words: z.string().max(2000).optional(),
    /** Models for this case instead of the suite's targets (a look on another base, a mode with its own model). */
    models: PerEngine(z.array(z.string().min(1)).min(1)).optional(),
    /** A variant's models for this case, over the variant's own (each mode of a studio has its own partner model). */
    variantModels: z.record(Slug, PerEngine(z.array(z.string().min(1)).min(1))).optional(),
    op: z.string().optional(),
    prompts: z.array(Prompt).min(1).optional(),
    shots: z.array(Shot).min(1).max(24).optional(),
    inputs: Inputs.optional(),
    /** Used on --engine demo (and when `inputs` name local files that aren't there and --allow-fixtures is set). */
    demoInputs: Inputs.optional(),
    params: Params.optional(),
    extra: Json.optional(),
    /** Reference images or clips: a look's style set, a person's photos, a clip to A/B against (a folder or files). */
    references: z.union([FileRef, z.array(FileRef).min(1)]).optional(),
    metrics: z.array(z.enum(METRICS)).optional(),
    train: Train.optional(),
    submit: Submit.optional(),
    engines: z.array(z.enum(ENGINES)).min(1).optional(),
    tags: z.array(Slug).optional(),
    note: z.string().optional(),
  })
  .strict();

export const SuiteSchema = z
  .object({
    $schema: z.string().optional(),
    suite: Slug,
    title: z.string().min(1),
    description: z.string().min(1),
    /** The Fuobe Original(s) this suite measures (fuobe-soul, fuobe-dop…). */
    original: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    kind: z.enum(["image", "video", "audio"]),
    /** Where a case's recipe comes from: a Soul look, a motion / effect, or nothing beyond the case itself. */
    recipe: z.enum(["soul-look", "motion", "none"]).default("none"),
    /** "paid-keys": the first suite to run once the install has paid cloud keys (DoP Mixed Media). */
    runFirst: z.enum(["paid-keys"]).optional(),
    /** The default a run of this suite decides, and the rule it is decided by (a person makes the change, reviewed). */
    decides: z.string().min(1).optional(),
    targets: PerEngine(Target).refine((t) => t.open || t.cloud || t.demo, "name a target for at least one engine"),
    defaults: z
      .object({
        seeds: z.array(z.number().int().min(0).max(2 ** 31 - 1)).min(1).default([1001]),
        prompts: z.array(Prompt).min(1).optional(),
        params: Params.optional(),
        extra: Json.optional(),
        metrics: z.array(z.enum(METRICS)).default(["clip"]),
        variant: Slug.optional(),
        /** The variant the promote rule judges and the blind review pairs with the others (default: recipe, else the first). */
        candidate: Slug.optional(),
        /** The style metric's embedder for this suite's runs (pnpm eval:run / report --style-model overrides it): dinov2 compares pictures without words. */
        styleModel: z.enum(["clip", "dinov2"]).optional(),
        timeoutSeconds: z.number().positive().default(1800),
      })
      .strict()
      .default({ seeds: [1001], metrics: ["clip"], timeoutSeconds: 1800 }),
    variants: z.record(Slug, Variant).optional(),
    cases: z.array(CaseSchema).min(1),
  })
  .strict()
  .superRefine((s, ctx) => {
    const seen = new Set();
    s.cases.forEach((c, i) => {
      if (seen.has(c.id)) ctx.addIssue({ code: "custom", path: ["cases", i, "id"], message: `duplicate case id ${c.id}` });
      seen.add(c.id);
      if (!c.prompts && !c.shots && !s.defaults.prompts && !c.submit && !c.inputs && !c.demoInputs) {
        ctx.addIssue({ code: "custom", path: ["cases", i], message: "give the case prompts, shots, inputs or a submit body" });
      }
      const ids = (c.prompts ?? []).flatMap((p) => (typeof p === "object" && p.id ? [p.id] : []));
      if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["cases", i, "prompts"], message: "prompt ids repeat" });
      if (c.look && s.recipe !== "soul-look") ctx.addIssue({ code: "custom", path: ["cases", i, "look"], message: 'a look needs "recipe": "soul-look"' });
      if (c.motion && s.recipe !== "motion") ctx.addIssue({ code: "custom", path: ["cases", i, "motion"], message: 'a motion needs "recipe": "motion"' });
      for (const v of Object.keys(c.variantModels ?? {})) {
        if (!s.variants?.[v]) ctx.addIssue({ code: "custom", path: ["cases", i, "variantModels", v], message: `no variant ${v} in this suite` });
      }
      // Every input a route body names is in the case's inputs and its demo inputs (fillTemplate refuses a missing one).
      for (const t of bodyTokens(c.submit?.body)) {
        const m = /^(?:source:)?inputs\.(\w+)(?:\.(\d+))?$/.exec(t);
        if (!m) continue;
        for (const key of ["inputs", "demoInputs"]) {
          if (!c[key]) continue;
          const v = c[key][m[1]];
          const has = m[2] === undefined ? v !== undefined : Array.isArray(v) && v.length > Number(m[2]);
          if (!has) ctx.addIssue({ code: "custom", path: ["cases", i, key], message: `the route body names {{${t}}}, which ${key} doesn't have` });
        }
      }
    });
    const variants = Object.keys(s.variants ?? { default: {} });
    for (const k of ["variant", "candidate"]) {
      if (s.defaults[k] && !variants.includes(s.defaults[k])) ctx.addIssue({ code: "custom", path: ["defaults", k], message: `no variant ${s.defaults[k]} (have ${variants.join(", ")})` });
    }
    // A variant limited to tags must find at least one case with them.
    for (const [name, v] of Object.entries(s.variants ?? {})) {
      if (v.tags && !s.cases.some((c) => v.tags.some((t) => c.tags?.includes(t)))) ctx.addIssue({ code: "custom", path: ["variants", name, "tags"], message: `no case is tagged ${v.tags.join(" or ")}` });
    }
  });

/** The {{tokens}} a route body template names (scripts/eval/lib/media.mjs fillTemplate). */
function bodyTokens(v, out = []) {
  if (typeof v === "string") for (const m of v.matchAll(/\{\{\s*([\w.:-]+)\s*\}\}/g)) out.push(m[1]);
  else if (Array.isArray(v)) for (const x of v) bodyTokens(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) bodyTokens(x, out);
  return out;
}

/** Readable lines for a failed parse: `cases[3].prompts[0].seed: expected an integer`. */
export function issues(error) {
  return error.issues.map((i) => {
    const where = i.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("").replace(/^\./, "");
    return `${where || "(file)"}: ${i.message}`;
  });
}

/** JSON Schema of a suite file (cases/case.schema.json), for editors. */
export function schemaJson() {
  return z.toJSONSchema(SuiteSchema, { target: "draft-2020-12", unrepresentable: "any", io: "input" });
}
