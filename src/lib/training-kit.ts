/**
 * The training kit for Fuobe's own LoRAs and the motion library (build plan O12; research §6 and §7). Pure logic, no
 * I/O: scripts/train/kit.mjs reads the files and calls these.
 *
 * - A job spec (scripts/train/specs/<id>.json) says what one of Fuobe's own LoRAs learns from (dataset size, caption
 *   rules), how it trains (steps, rank, learning rate, trigger) on both routes (AI-Toolkit on a GPU, or a fal trainer
 *   whose request fields come from the research: trainers.generated.ts) and where the file goes (its library entry).
 * - A data-licence log (scripts/train/data-logs/<id>.json) lists every image or clip of the dataset: where it comes
 *   from, its licence or proof of ownership, and consent where people appear. A job does not start while its log is
 *   incomplete or does not match the dataset. Only four sources count (own shoot, licensed with AI-training rights, CC0,
 *   public domain): another service's generated outputs or preview media are never one of them (research §2).
 * - The motion library (src/lib/catalog/motion-library.json) lists short CC0 or own-shot driving clips for the sports
 *   moves that are better as motion transfer than as a LoRA. A move picks a clip up only once one passes the check;
 *   until then it keeps its current route.
 * - Publishing (scripts/train/kit.mjs publish) uploads a trained file with the public half of its log to Fuobe's
 *   Hugging Face org and writes the research entry's `trained` block, which `pnpm gen:catalog` turns into a library
 *   entry (scripts/gen-lora-library.py).
 */
import { PLANNED_LORAS, LORA_LIBRARY } from "./catalog/lora-library.generated";
import type { PlannedLora } from "./catalog/loras";
import { aiToolkitJob, getTrainer, trainerCost, type HostedTrainer } from "./catalog/training";
import motionLibrary from "./catalog/motion-library.json" with { type: "json" };

// ── Job specs ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The AI-Toolkit models the kit trains on (arch names from ostris/ai-toolkit's built-in models, main at e9c72b7, 2026-10-31). */
export type AitkArch = "zimage:turbo" | "zimage" | "wan22_14b_i2v";

export interface TrainingSpec {
  /** fuobe-… id: the planned library entry it becomes. */
  id: string;
  name: string;
  kind: "style" | "concept" | "motion";
  /** The base the file is for (the library entry's base). */
  base: "z-image-turbo" | "wan2.2-i2v-a14b";
  media: "image" | "video";
  /** The presets it is meant for (generic words). */
  presets: string[];
  /** A word the model doesn't know, written into every caption. */
  trigger: string;
  dataset: {
    min: number;
    max: number;
    /** What the data is, in words. */
    what: string;
    /** The caption rules every caption follows. */
    captions: string[];
    /** Clips: their length in seconds and frame rate. */
    clipSeconds?: [number, number];
    fps?: number;
  };
  train: { steps: number; rank: number; learningRate: number };
  routes: {
    fal: { trainer: string; extra?: Record<string, string | number | boolean> };
    aiToolkit: { arch: AitkArch };
  };
  target: {
    file: string;
    strength: number;
    /** Wan 2.2: which expert(s) the LoRA loads on. */
    loraTarget?: "high" | "low" | "both";
    /** The Hugging Face repo it is published to (FUOBE_HF_ORG/<id>). */
    hfRepo: string;
  };
  notes?: string;
}

const ID = /^fuobe-[a-z0-9-]+$/;
const TRIGGER = /^[a-z][a-z0-9_]{3,31}$/;
const BASE_OF: Record<AitkArch, TrainingSpec["base"][]> = { "zimage:turbo": ["z-image-turbo"], zimage: ["z-image-turbo"], wan22_14b_i2v: ["wan2.2-i2v-a14b"] };

/** The planned entry a spec trains (or the library entry once its file is published). */
export const plannedLora = (id: string): PlannedLora | undefined => PLANNED_LORAS.find((p) => p.key === id);

/** The steps field of a trainer's request ("steps" on the image trainers, "number_of_steps" on Wan 2.2). */
const stepsField = (tr: HostedTrainer) => (tr.fields.steps ? "steps" : tr.fields.number_of_steps ? "number_of_steps" : undefined);

/** What is wrong with a spec (empty when it is ready to run once its data-licence log is complete). */
export function specProblems(spec: TrainingSpec, planned: readonly PlannedLora[] = PLANNED_LORAS): string[] {
  const out: string[] = [];
  if (!ID.test(spec.id)) out.push(`id ${spec.id} is not a fuobe-… id`);
  const entry = planned.find((p) => p.key === spec.id);
  const published = LORA_LIBRARY.find((e) => e.key === spec.id);
  if (!entry && !published) out.push(`${spec.id} is neither a planned LoRA nor in the library (add it to the research's fuobeTrainedLoras)`);
  const base = entry?.base ?? published?.base;
  if (base && base !== spec.base) out.push(`base ${spec.base} is not the library entry's ${base}`);
  if (spec.target.file !== `${spec.id}.safetensors`) out.push(`target file must be ${spec.id}.safetensors`);
  if (spec.target.hfRepo.split("/")[1] !== spec.id) out.push(`hfRepo ${spec.target.hfRepo} must be <org>/${spec.id}`);
  if (!TRIGGER.test(spec.trigger)) out.push(`trigger ${spec.trigger} must be one lower-case word (4-32 letters, digits or _)`);
  if (!(spec.target.strength > 0 && spec.target.strength <= 2)) out.push(`strength ${spec.target.strength} out of range`);
  if (!spec.presets.length) out.push("no presets");
  const d = spec.dataset;
  if (!(Number.isInteger(d.min) && d.min > 0 && d.max >= d.min)) out.push(`dataset size ${d.min}-${d.max} is not a range`);
  if (!d.captions.length || !d.captions.some((c) => c.includes(spec.trigger))) out.push(`caption rules must say where the trigger ${spec.trigger} goes`);
  if (spec.media === "video" && !(d.clipSeconds && d.fps)) out.push("a motion LoRA's dataset needs clip lengths and a frame rate");
  const t = spec.train;
  if (!(Number.isInteger(t.rank) && t.rank >= 4 && t.rank <= 128)) out.push(`rank ${t.rank} out of range`);
  if (!(t.learningRate > 0 && t.learningRate < 0.01)) out.push(`learning rate ${t.learningRate} out of range`);
  const tr = getTrainer(spec.routes.fal.trainer);
  if (!tr) out.push(`no hosted trainer ${spec.routes.fal.trainer} in the research (trainers.generated.ts)`);
  else {
    if (tr.media !== spec.media) out.push(`${tr.id} learns from ${tr.media}, the spec from ${spec.media}`);
    if (tr.status !== "active") out.push(`${tr.id} is ${tr.status}`);
    const sf = stepsField(tr);
    const f = sf ? tr.fields[sf] : undefined;
    if (!f) out.push(`${tr.id} takes no step count`);
    else if ((f.min !== undefined && t.steps < f.min) || (f.max !== undefined && t.steps > f.max)) out.push(`${t.steps} steps is outside ${tr.id}'s ${f.min}-${f.max}`);
    for (const [k, v] of Object.entries(spec.routes.fal.extra ?? {})) {
      const field = tr.fields[k];
      if (!field) out.push(`${tr.id} has no field ${k}`);
      else if (field.enum && !field.enum.includes(v as string | number)) out.push(`${tr.id}'s ${k} takes ${field.enum.join(" | ")}, not ${v}`);
    }
  }
  if (!BASE_OF[spec.routes.aiToolkit.arch]?.includes(spec.base)) out.push(`AI-Toolkit's ${spec.routes.aiToolkit.arch} does not train for ${spec.base}`);
  if (spec.base.startsWith("wan2.2") && !spec.target.loraTarget) out.push("a Wan 2.2 LoRA says which expert it loads on (loraTarget)");
  return out;
}

/** What fal bills for the spec's run, in US dollars (the trainer's per-step price above its minimum). */
export const specCostUsd = (spec: TrainingSpec): number | null => trainerCost(getTrainer(spec.routes.fal.trainer), spec.train.steps);

/**
 * The hosted trainer's request: the dataset zip in its data field and only the fields its schema has (steps, the
 * learning rate, the trigger or a default caption, and the spec's extra fields such as training_type).
 */
export function falTrainingPayload(spec: TrainingSpec, zipUrl: string): Record<string, unknown> {
  const tr = getTrainer(spec.routes.fal.trainer);
  if (!tr) throw new Error(`${spec.id}: no hosted trainer ${spec.routes.fal.trainer}`);
  const f = tr.fields;
  const body: Record<string, unknown> = { [tr.dataField]: zipUrl };
  const sf = stepsField(tr);
  if (sf) body[sf] = spec.train.steps;
  if (f.learning_rate) body.learning_rate = spec.train.learningRate;
  if (f.trigger_phrase) body.trigger_phrase = spec.trigger;
  // Every file has its own caption (with the trigger); the default caption only fills in a missing one.
  if (f.default_caption) body.default_caption = spec.kind === "style" ? `${spec.trigger} style` : spec.trigger;
  for (const [k, v] of Object.entries(spec.routes.fal.extra ?? {})) if (f[k]) body[k] = v;
  return body;
}

/** Sample prompts for the AI-Toolkit run: new scenes in the look, or a still the move animates. */
function samples(spec: TrainingSpec): string[] {
  if (spec.media === "video") return [`${spec.trigger}, a woman in a red coat on a city rooftop at dusk`, `${spec.trigger}, a mountain lake at sunrise`];
  return [`a city street at night, ${spec.trigger} style`, `a bowl of fruit on a wooden table, ${spec.trigger} style`, `a portrait of a man in a garden, ${spec.trigger} style`];
}

/**
 * The AI-Toolkit job for the user's GPU. Z-Image Turbo uses the Soul ID config (ostris's training adapter v2) with the
 * spec's rank, steps and learning rate; Z-Image base and Wan 2.2 I2V 14B take AI-Toolkit's own defaults for those
 * models (its UI's model list: Tongyi-MAI/Z-Image; ai-toolkit/Wan2.2-I2V-A14B-Diffusers-bf16 at 4 bit with its
 * accuracy recovery adapter, both experts, 41 frames at 16 fps, linear timesteps).
 */
export function aiToolkitConfig(spec: TrainingSpec, datasetFolder: string, outputFolder: string) {
  const job = aiToolkitJob({ name: spec.id, trigger: spec.trigger, datasetFolder, outputFolder, steps: spec.train.steps, kind: "style", family: "z-image-turbo" });
  const proc = job.config.process[0] as Record<string, unknown> & { train: Record<string, unknown>; datasets: Record<string, unknown>[]; sample: Record<string, unknown> };
  proc.network = { type: "lora", linear: spec.train.rank, linear_alpha: spec.train.rank };
  proc.train.lr = spec.train.learningRate;
  proc.sample.prompts = samples(spec);
  const arch = spec.routes.aiToolkit.arch;
  if (arch === "zimage") {
    proc.model = { name_or_path: "Tongyi-MAI/Z-Image", arch: "zimage", quantize: true, qtype: "qfloat8", quantize_te: true, qtype_te: "qfloat8", low_vram: true };
    proc.sample.sample_steps = 30;
    proc.sample.guidance_scale = 4;
  } else if (arch === "wan22_14b_i2v") {
    proc.model = {
      name_or_path: "ai-toolkit/Wan2.2-I2V-A14B-Diffusers-bf16",
      arch: "wan22_14b_i2v",
      quantize: true,
      qtype: "uint4|ostris/accuracy_recovery_adapters/wan22_14b_i2v_torchao_uint4.safetensors",
      quantize_te: true,
      qtype_te: "qfloat8",
      low_vram: true,
      model_kwargs: { train_high_noise: true, train_low_noise: true },
    };
    proc.train.timestep_type = "linear";
    proc.train.switch_boundary_every = 10;
    proc.datasets = proc.datasets.map((d) => ({ ...d, resolution: [512], num_frames: 41, fps: spec.dataset.fps ?? 16 }));
    Object.assign(proc.sample, { num_frames: 41, fps: 16, width: 832, height: 480, guidance_scale: 3.5, sample_steps: 25, sample_every: 250 });
  }
  return job;
}

// ── Data-licence logs ────────────────────────────────────────────────────────────────────────────────────────────

/** Where a file comes from: shot by Fuobe, licensed with AI-training rights, CC0 or public domain. */
export type DataSource = "own-shoot" | "licensed" | "cc0" | "public-domain";
export const DATA_SOURCES: DataSource[] = ["own-shoot", "licensed", "cc0", "public-domain"];

export interface DataLogItem {
  /** The file's name in the dataset folder (001.jpg, clip-04.mp4). */
  file: string;
  sha256: string;
  source: DataSource;
  /** The licence as written ("CC0-1.0", "Fuobe's own", the stock licence's name). */
  licence: string;
  /** Where the proof is: the original's URL, the receipt or contract, the shoot's folder or call sheet. */
  proof: string;
  /** Who made it. */
  author: string;
  /** When it was made or licensed (YYYY-MM-DD). */
  date: string;
  /** A licensed file: its licence allows training AI models (said in the licence, not assumed). */
  aiTraining?: boolean;
  /** Recognisable people appear in it. */
  people: boolean;
  /** Each person's signed release covering AI training (the form's reference, kept off the public log). */
  consent?: { form: string; date: string; scope: string[]; adults: boolean };
}

export interface DataLog {
  lora: string;
  version: 1;
  items: DataLogItem[];
  /** Who checked the log against the files, and when. */
  reviewedBy?: string;
  reviewedAt?: string;
}

const SHA = /^[0-9a-f]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MEDIA: Record<TrainingSpec["media"], RegExp> = { image: /\.(jpe?g|png|webp)$/i, video: /\.(mp4|mov|webm)$/i };

/** A file in the dataset folder, as the kit read it. */
export interface DatasetFile {
  name: string;
  sha256: string;
}

/**
 * The dataset folder as the kit read it: every file in it other than a caption (whatever its extension, since a
 * trainer reads more kinds than the spec's media), each caption's text by name, and anything else in it (a folder, a
 * link), which the check refuses.
 */
export interface DatasetFolder {
  files: DatasetFile[];
  captions: Record<string, string>;
  other?: string[];
}

/** What is wrong with one item of a log (empty when it is complete). */
export function itemProblems(item: DataLogItem, media?: TrainingSpec["media"]): string[] {
  const out: string[] = [];
  const at = item.file || "(no file)";
  if (!item.file || item.file.includes("/")) out.push(`${at}: a plain file name`);
  else if (media && !MEDIA[media].test(item.file)) out.push(`${at}: not ${media === "image" ? "an image" : "a clip"}`);
  if (!SHA.test(item.sha256 ?? "")) out.push(`${at}: no SHA256`);
  if (!DATA_SOURCES.includes(item.source)) out.push(`${at}: source must be ${DATA_SOURCES.join(", ")}`);
  if (!item.licence?.trim()) out.push(`${at}: no licence`);
  if (!item.proof?.trim()) out.push(`${at}: no licence or ownership proof`);
  if (!item.author?.trim()) out.push(`${at}: no author`);
  if (!DAY.test(item.date ?? "")) out.push(`${at}: no date`);
  if (item.source === "licensed" && item.aiTraining !== true) out.push(`${at}: a licensed file needs a licence that allows AI training (aiTraining: true)`);
  if (typeof item.people !== "boolean") out.push(`${at}: say whether people appear (people: true or false)`);
  if (item.people) {
    const c = item.consent;
    if (!c?.form?.trim() || !DAY.test(c.date ?? "")) out.push(`${at}: people appear, so it needs each person's signed release`);
    else {
      if (!c.scope?.includes("ai-training")) out.push(`${at}: the release must cover AI training (scope ai-training)`);
      if (c.adults !== true) out.push(`${at}: only adults who signed a release`);
    }
  }
  return out;
}

/**
 * What stops a job from starting: the log's own gaps, its size against the spec, and, given the dataset folder, any
 * file missing from the log, logged but not there, or changed since it was logged, anything in the folder that is not
 * logged media or a caption, and any file whose caption is missing, empty or without the trigger.
 */
export function dataLogProblems(log: DataLog, spec: Pick<TrainingSpec, "id" | "media" | "dataset"> & { trigger?: string }, folder?: DatasetFolder): string[] {
  const out: string[] = [];
  if (log.lora !== spec.id) out.push(`the log is for ${log.lora}, not ${spec.id}`);
  const n = log.items?.length ?? 0;
  if (n < spec.dataset.min) out.push(`${n} logged ${spec.media === "image" ? "images" : "clips"}; the spec needs ${spec.dataset.min}-${spec.dataset.max}`);
  if (n > spec.dataset.max) out.push(`${n} logged files; the spec takes at most ${spec.dataset.max}`);
  for (const item of log.items ?? []) out.push(...itemProblems(item, spec.media));
  const names = (log.items ?? []).map((i) => i.file);
  const dup = [...new Set(names.filter((x, i) => names.indexOf(x) !== i))];
  if (dup.length) out.push(`logged twice: ${dup.join(", ")}`);
  if (!log.reviewedBy?.trim() || !DAY.test(log.reviewedAt ?? "")) out.push("nobody has reviewed the log (reviewedBy, reviewedAt)");
  if (folder) {
    const logged = new Map((log.items ?? []).map((i) => [i.file, i]));
    const present = new Map(folder.files.map((f) => [f.name, f]));
    const kind = spec.media === "image" ? "an image" : "a clip";
    for (const name of folder.other ?? []) out.push(`${name} is a folder or a link: the dataset folder holds only logged files and their captions`);
    for (const f of folder.files) {
      const item = logged.get(f.name);
      if (!MEDIA[spec.media].test(f.name)) {
        // A trainer reads more than the spec's media (AI-Toolkit takes .mkv clips, and a still as a one-frame clip).
        out.push(`${f.name} is not ${kind} the spec trains on: the dataset folder holds only logged files and their captions`);
        continue;
      }
      if (!item) out.push(`${f.name} is in the dataset but not in the log`);
      else if (item.sha256 !== f.sha256) out.push(`${f.name} changed since it was logged (SHA256 differs)`);
      const caption = `${f.name.replace(/\.[^.]+$/, "")}.txt`;
      const text = folder.captions[caption];
      if (text === undefined) out.push(`${f.name} has no caption (${caption})`);
      else if (!text.trim()) out.push(`${caption} is empty`);
      else if (spec.trigger && !new RegExp(`\\b${spec.trigger}\\b`).test(text)) out.push(`${caption} does not have the trigger ${spec.trigger}`);
    }
    for (const name of logged.keys()) if (!present.has(name)) out.push(`${name} is logged but not in the dataset`);
  }
  return out;
}

/**
 * The files a trainer is given: the logged media and their captions, by name. The kit zips exactly these for the
 * hosted trainer, so the fal route trains on what the check passed.
 */
export function datasetZipNames(log: DataLog): string[] {
  return (log.items ?? []).flatMap((i) => [i.file, `${i.file.replace(/\.[^.]+$/, "")}.txt`]).sort();
}

/**
 * The half of a log that is published next to the file. Each item keeps its file, hash, source, licence, date and
 * whether people appear (and that a release is on file). Proof and author stay private (receipts, contracts, call
 * sheets, people's names), except for a CC0 or public-domain original, whose public page and author are credited.
 */
export function publicLog(log: DataLog) {
  return {
    lora: log.lora,
    version: log.version,
    reviewedAt: log.reviewedAt,
    items: log.items.map((i) => {
      const open = (i.source === "cc0" || i.source === "public-domain") && /^https:\/\//.test(i.proof ?? "");
      return {
        file: i.file,
        sha256: i.sha256,
        source: i.source,
        licence: i.licence,
        date: i.date,
        ...(i.source === "licensed" && { aiTraining: i.aiTraining === true }),
        ...(open ? { original: i.proof, author: i.author } : { proof: "on file" }),
        people: i.people,
        ...(i.people && { consent: i.consent ? "signed release covering AI training, on file" : "missing" }),
      };
    }),
  };
}

// ── Publishing ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The route a trained file came from. */
export type TrainingRoute = "fal" | "ai-toolkit";

/**
 * The Hugging Face repo each trainer trains on (read on the Hub 2026-11-02: all three Apache-2.0). fal's z-image-trainer
 * and AI-Toolkit's zimage arch train on Z-Image base, the Turbo trainer and zimage:turbo on Z-Image Turbo.
 */
const TRAINED_ON: Record<string, string> = {
  "fal-ai/z-image-trainer": "Tongyi-MAI/Z-Image",
  "fal-ai/z-image-turbo-trainer-v2": "Tongyi-MAI/Z-Image-Turbo",
  "fal-ai/wan-22-trainer/i2v-a14b": "Wan-AI/Wan2.2-I2V-A14B",
  zimage: "Tongyi-MAI/Z-Image",
  "zimage:turbo": "Tongyi-MAI/Z-Image-Turbo",
  wan22_14b_i2v: "Wan-AI/Wan2.2-I2V-A14B",
};

/** The model card's base_model: the Hub id of the model the route trained on (not the library's base name). */
export function hfBaseModel(spec: TrainingSpec, route: TrainingRoute): string {
  const key = route === "fal" ? spec.routes.fal.trainer : spec.routes.aiToolkit.arch;
  const id = TRAINED_ON[key];
  if (!id) throw new Error(`${spec.id}: no Hugging Face base model known for ${key}`);
  return id;
}

/** What the operator says about the trained file's licence (kit.mjs publish --licence, --commercial, --hosted-ok). */
export interface LicenceChoice {
  /** An SPDX id in lower case, as the Hub takes it (apache-2.0), or a name for a licence of its own. */
  licence?: string;
  commercial?: boolean;
  hostedOk?: boolean;
}

/** The trained file's licence snapshot (what Settings → Models & licences shows) and the model card's licence. */
export interface TrainedLicence {
  licence: string;
  commercial: boolean;
  hostedOk: boolean;
  /** The card's `license` (an SPDX id, or "other" with licenseName). */
  card: { license: string; licenseName?: string };
}

const HUB_LICENCES = new Set(["apache-2.0", "mit", "cc0-1.0", "cc-by-4.0", "cc-by-sa-4.0", "cc-by-nc-4.0", "cc-by-nc-sa-4.0", "openrail++"]);

/**
 * The trained file's licence, from its data-licence log. Data that is all Fuobe's own, CC0 or public domain defaults to
 * Apache-2.0 (the base models' own licence), commercial and hostable; the operator may say otherwise. A dataset with
 * licensed items has no default: the stock licence can limit what the trained file may do, so the operator states the
 * licence, commercial use and hosting. The snapshot names the data's licences either way.
 */
export function trainedLicence(log: DataLog, choice: LicenceChoice = {}): { snapshot?: TrainedLicence; problems: string[] } {
  const items = log.items ?? [];
  const licensed = items.filter((i) => i.source === "licensed");
  const data = [...new Set(items.map((i) => i.licence.trim()))].sort();
  const sources = [...new Set(items.map((i) => i.source))].sort();
  const problems: string[] = [];
  if (licensed.length) {
    const what = `${licensed.length} licensed file(s) (${[...new Set(licensed.map((i) => i.licence.trim()))].join("; ")})`;
    if (!choice.licence) problems.push(`${what}: say the trained file's licence (--licence)`);
    if (choice.commercial === undefined) problems.push(`${what}: say whether outputs may be sold (--commercial yes|no)`);
    if (choice.hostedOk === undefined) problems.push(`${what}: say whether hosts may run it (--hosted-ok yes|no)`);
  }
  if (problems.length) return { problems };
  const spdx = (choice.licence ?? "apache-2.0").trim();
  const known = HUB_LICENCES.has(spdx.toLowerCase());
  const name = spdx.toLowerCase() === "apache-2.0" ? "Apache-2.0" : spdx;
  return {
    problems,
    snapshot: {
      licence: `${name} (Fuobe-trained; data: ${sources.join(", ")}; ${data.join("; ")}; data-licence log)`,
      commercial: choice.commercial ?? true,
      hostedOk: choice.hostedOk ?? true,
      card: known ? { license: spdx.toLowerCase() } : { license: "other", licenseName: spdx.toLowerCase().replace(/[^a-z0-9.-]+/g, "-") },
    },
  };
}

// ── The motion library ──────────────────────────────────────────────────────────────────────────────────────────

/** A driving clip: a short CC0 or own-shot performance of the move. */
export interface MotionClip {
  /** Pinned download (Fuobe's Hugging Face org, or another https file). */
  url: string;
  sha256: string;
  seconds: number;
  fps: number;
  width: number;
  height: number;
  source: "own-shoot" | "cc0" | "public-domain";
  licence: string;
  proof: string;
  author: string;
  date: string;
  people: boolean;
  consent?: DataLogItem["consent"];
}

export interface MotionMove {
  /** The preset's name (generic words, research §7: status motion-library). */
  preset: string;
  /** Its id in the DoP catalog. */
  presetId: string;
  clips: MotionClip[];
}

export interface MotionLibrary {
  asOf: string;
  /** What runs a move once a clip is present (both engines: Fuobe Genjutsu motion transfer). */
  maker: string;
  moves: MotionMove[];
}

/** Driving clips run as one part on every maker that takes them (SCAIL-2 takes 10 s at most). */
export const MOTION_CLIP_SECONDS = { min: 2, max: 10 } as const;

export function clipProblems(clip: MotionClip, at: string): string[] {
  const asItem: DataLogItem = { file: "clip.mp4", sha256: clip.sha256, source: clip.source, licence: clip.licence, proof: clip.proof, author: clip.author, date: clip.date, people: clip.people, consent: clip.consent };
  const out = itemProblems(asItem, "video").map((p) => p.replace(/^clip\.mp4/, at));
  if (!["own-shoot", "cc0", "public-domain"].includes(clip.source)) out.push(`${at}: driving clips are CC0, public domain or shot by Fuobe`);
  if (!/^https:\/\//.test(clip.url ?? "")) out.push(`${at}: no https download`);
  if (!(clip.seconds >= MOTION_CLIP_SECONDS.min && clip.seconds <= MOTION_CLIP_SECONDS.max)) out.push(`${at}: ${clip.seconds} s; a driving clip runs ${MOTION_CLIP_SECONDS.min}-${MOTION_CLIP_SECONDS.max} s`);
  if (!(clip.fps >= 12 && clip.fps <= 60)) out.push(`${at}: frame rate ${clip.fps}`);
  if (!(clip.width >= 480 && clip.height >= 480)) out.push(`${at}: smaller than 480 px`);
  return out;
}

/** What is wrong with the library: every motion-library move once, each clip complete. */
export function motionLibraryProblems(lib: MotionLibrary, moves: readonly string[]): string[] {
  const out: string[] = [];
  const names = lib.moves.map((m) => m.preset);
  for (const m of moves) if (!names.includes(m)) out.push(`${m} is missing`);
  for (const n of names) if (!moves.includes(n)) out.push(`${n} is not a motion-library move`);
  if (new Set(names).size !== names.length) out.push("a move is listed twice");
  for (const m of lib.moves) {
    if (!/^motion-[a-z0-9-]+$/.test(m.presetId)) out.push(`${m.preset}: preset id ${m.presetId}`);
    m.clips.forEach((c, i) => out.push(...clipProblems(c, `${m.preset} clip ${i + 1}`)));
  }
  return out;
}

export const MOTION_LIBRARY = motionLibrary as MotionLibrary;

/**
 * The driving clip a move runs from, once the library has one that passes the check (the first). Until then
 * undefined, and the move keeps its current route (Fuobe DoP on the move's words).
 */
export function motionLibraryClip(presetIdOrName: string, lib: MotionLibrary = MOTION_LIBRARY): MotionClip | undefined {
  const move = lib.moves.find((m) => m.presetId === presetIdOrName || m.preset === presetIdOrName);
  return move?.clips.find((c) => clipProblems(c, move.preset).length === 0);
}
