import "server-only";
import { nanoid } from "nanoid";
import { z } from "zod";
import { getModel } from "@/lib/catalog";
import { LAYOUT_PARAM, readLayout } from "@/lib/layout-prompt";
import type { Engine, Generation, GenerationRequest, ModelDef } from "@/lib/catalog/types";
import {
  ANGLES,
  APPLIES_TO_DOC,
  clampLayers,
  CUTOUT_MODELS,
  defaultLayers,
  ENHANCE_DETAIL_SCALE,
  enhanceModels,
  enhancePrompt,
  initialDoc,
  inpaintPrompt,
  layersModelFor,
  MAX_NODES,
  RELIGHT_DIRECTIONS,
  RERENDER_MAX_LAYERS,
  RERENDER_MAX_TEXT,
  RELIGHT_LIGHTS,
  relightPrompt,
  textChanges,
  textEditPrompt,
  TOOL_LABELS,
  TOOL_MODELS,
  type Box,
  type LayerDoc,
  type LayerJob,
  type LayerJobInput,
  type LayerJobResult,
  type LayerProject,
  type LayerProjectView,
  type LayerTool,
  type LayerVersion,
} from "@/lib/layers";
import { createPipeline, type PipelineStep } from "./chains";
import { db } from "./db";
import { cancelGeneration, ConnectComfyError, getGeneration, previewGeneration } from "./generations";
import { firstOn } from "./model-access";
import { getAsset } from "./storage";

/**
 * Layers studio (Higgsfield Layers): projects, saved versions of their layer document, and the AI
 * jobs their tools start. A job is ordinary generations (so results survive restarts, show in the
 * Library and run on either engine); the editor applies a finished job to its document and saves a
 * version, which marks the job applied (src/lib/layers.ts has the document model).
 */

interface ProjectRow {
  id: string;
  name: string;
  source_url: string;
  cover_url: string | null;
  width: number;
  height: number;
  head_version_id: string | null;
  jobs_json: string;
  created_at: number;
  updated_at: number;
}

interface VersionRow {
  id: string;
  project_id: string;
  label: string;
  doc_json: string;
  created_at: number;
  updated_at: number;
}

/** A user-facing refusal with its HTTP status (the route returns `{ error }`). */
export class LayersError extends Error {
  constructor(
    message: string,
    public status = 422,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Validation of documents and job requests coming from the browser

/** Files the document may point at: stored assets only (no quotes or brackets: thumbnails put them in CSS url()). */
export const FileUrl = z
  .string()
  .max(2000)
  .regex(/^\/api\/files\/[^"'()\\\s<>]+$/);
const num = z.number().finite();
const BoxSchema = z.tuple([num, num, num, num]);
const clamped = (max: number) => z.string().transform((s) => s.slice(0, max));

const Revision = z.object({
  src: FileUrl,
  crop: BoxSchema.nullable().optional(),
  natural: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
  label: clamped(80),
  prompt: clamped(2000).optional(),
  at: z.number().int().nonnegative(),
});

const Node = z.object({
  id: z.string().min(1).max(40),
  name: clamped(80),
  z: z.number().int().min(0).max(1000),
  x: num.min(-100_000).max(100_000),
  y: num.min(-100_000).max(100_000),
  w: num.positive().max(100_000),
  h: num.positive().max(100_000),
  rotation: num.min(-3600).max(3600),
  src: FileUrl,
  crop: BoxSchema.nullable().optional(),
  natural: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
  hidden: z.boolean().optional(),
  opacity: num.min(0).max(1).optional(),
  maskSrc: FileUrl.optional(),
  feather: num.min(0).max(2000).optional(),
  prompt: clamped(2000).optional(),
  refSrc: FileUrl.optional(),
  revisions: z.array(Revision).max(60),
  revision: z.number().int().min(0),
  role: z.enum(["original", "new"]).optional(),
});

const DocSchema = z.object({
  v: z.literal(1),
  width: z.number().int().min(1).max(20_000),
  height: z.number().int().min(1).max(20_000),
  source: FileUrl,
  decomposed: z.boolean(),
  sourceBox: BoxSchema.optional(),
  nodes: z.array(Node).max(MAX_NODES),
});

/** A document the browser sent, cleaned (null when it can't be read). */
export function parseDoc(v: unknown): LayerDoc | null {
  const r = DocSchema.safeParse(v);
  if (!r.success) return null;
  const doc = r.data as LayerDoc;
  // Keep the revision index inside the list.
  doc.nodes = doc.nodes.map((n) => (n.revision < Math.max(1, n.revisions.length) ? n : { ...n, revision: Math.max(0, n.revisions.length - 1) }));
  return doc;
}

const TOOLS = ["decompose", "split", "regenerate", "generate-layer", "text-detect", "text-edit", "bg-remove", "regional", "upscale", "relight", "angles", "expand", "inpaint", "enhance", "rerender"] as const satisfies readonly LayerTool[];

export const JobInputSchema = z.object({
  tool: z.enum(TOOLS),
  engine: z.enum(["cloud", "open"]),
  modelId: z.string().max(80).optional(),
  image: FileUrl.optional(),
  refs: z.array(FileUrl).max(3).optional(),
  mask: FileUrl.optional(),
  sketch: FileUrl.optional(),
  prompt: clamped(2000).optional(),
  nodeId: z.string().max(40).optional(),
  frame: BoxSchema,
  label: clamped(120).optional(),
  settings: z
    .object({
      resolution: z.enum(["1K", "1.5K", "2K"]).optional(),
      mode: z.enum(["standard", "fast"]).optional(),
      layers: z.number().int().min(1).max(16).optional(),
      keepAlpha: z.boolean().optional(),
      light: z.string().max(40).optional(),
      direction: z.string().max(40).optional(),
      angle: z.string().max(40).optional(),
      rotate: num.min(0).max(360).optional(),
      tilt: num.min(-30).max(90).optional(),
      zoom: num.min(0).max(10).optional(),
      rows: z.array(z.object({ from: clamped(500), to: clamped(500) })).max(500).optional(),
      pads: z.object({ left: z.number().int().min(0).max(4096), top: z.number().int().min(0).max(4096), right: z.number().int().min(0).max(4096), bottom: z.number().int().min(0).max(4096) }).optional(),
      feather: num.min(0).max(500).optional(),
      aspect: z.string().regex(/^\d+(\.\d+)?:\d+(\.\d+)?$/).max(20).optional(),
      look: z.enum(["skin", "glow", "sharpen", "detail"]).optional(),
      // Re-render from layers: the arrangement as a layout draft (read and checked when the job is planned).
      layout: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Jobs → generation requests (no database, but for the switches a default model reads)

/** The tool's model on this engine: the one asked for (when the tool offers it) or its default. */
export function toolModel(tool: LayerTool, engine: Engine, modelId?: string, list: string[] = TOOL_MODELS[tool][engine]): ModelDef {
  if (!list.length) throw new LayersError(`${TOOL_LABELS[tool]} has no ${engine === "open" ? "open-source" : "cloud"} model yet`);
  if (modelId && !list.includes(modelId)) throw new LayersError("That model can't run this tool", 400);
  // Without one asked for: the tool's first model switched on in Settings → Models & licences.
  const m = getModel(modelId ?? firstOn(list, engine)!);
  if (!m) throw new LayersError("That model isn't in the catalog", 400);
  return m;
}

const RES_TIER = { "1K": "auto_1K", "1.5K": "auto_1.5K", "2K": "auto_2K" } as const;
/** Qwen-Image-Layered's longest side per tier (640 is the trained bucket; larger is slower). */
const OPEN_MAX_SIZE = { "1K": 640, "1.5K": 832, "2K": 1024 } as const;

/**
 * The words for a re-render: the layout's caption, which the browser builds from the person's words plus the backdrop
 * layers ("Behind everything: …"). Words sent beside a caption that doesn't already start with them go in front of it, so
 * neither the person's words nor the backdrop are lost.
 */
export function rerenderCaption(caption: string, prompt?: string): string {
  const said = caption.trim();
  const words = prompt?.trim().replace(/[.\s]+$/, "") ?? "";
  if (!words) return said;
  if (!said || said.toLowerCase().startsWith(words.toLowerCase())) return said || words;
  return `${words}. ${said}`;
}

/** The aspect ratio in `list` nearest to `aspect` ("1400:900"), compared on a log scale; `aspect` itself when there's no list. */
export function nearestAspect(aspect: string | undefined, list: readonly string[] | undefined): string | undefined {
  const value = (a: string) => {
    const [w, h] = a.split(":").map(Number);
    return w > 0 && h > 0 ? w / h : NaN;
  };
  if (!aspect || !Number.isFinite(value(aspect))) return list?.[0];
  if (!list?.length) return aspect;
  const v = Math.log(value(aspect));
  return [...list].filter((a) => Number.isFinite(value(a))).sort((a, b) => Math.abs(Math.log(value(a)) - v) - Math.abs(Math.log(value(b)) - v))[0];
}

const pick = (list: [string, string][], label: string | undefined) => list.find(([l]) => l === label)?.[1] ?? list[0][1];

/**
 * The generation steps for one tool run: the model step, then (for edits of a transparent layer and
 * new layers) a background cut-out that gives the result its alpha back.
 */
export function jobSteps(input: LayerJobInput, opts: { batchTitle?: string } = {}): PipelineStep[] {
  const { tool, engine } = input;
  const s = input.settings ?? {};
  const prompt = input.prompt?.trim() ?? "";
  const label = input.label?.trim() || TOOL_LABELS[tool];
  const needImage = () => {
    if (!input.image) throw new LayersError("Pick a layer or the image to work on", 400);
    return input.image;
  };
  const base = (model: ModelDef, request: Partial<GenerationRequest>, stepLabel = label): GenerationRequest => ({
    feature: "layers",
    modelId: model.id,
    ...request,
    ...(opts.batchTitle ? { batchTitle: opts.batchTitle } : {}),
    step: { label: `Layers · ${stepLabel}`, index: 0, of: 1 },
  });
  const steps: PipelineStep[] = [];
  const add = (key: string, request: GenerationRequest, after?: string) => steps.push(after ? { key, request, after, chain: [{ slot: "images" }] } : { key, request });
  const cutout = (after: string) => {
    const m = getModel(CUTOUT_MODELS[engine])!;
    add("cutout", base(m, { op: "bg-remove", params: aspectFor(m) }, `${label} · cut-out`), after);
  };
  /**
   * The input's shape, for models that take any ratio or list this one: the demo provider and
   * ratio-aware models then answer in the layer's shape. Never sent where the API would refuse it.
   */
  const aspectFor = (m: ModelDef): GenerationRequest["params"] => (s.aspect && (!m.options.aspectRatios || m.options.aspectRatios.includes(s.aspect)) ? { aspectRatio: s.aspect } : {});

  switch (tool) {
    case "decompose":
    case "split": {
      // Open: a named element goes to the prompt-guided Layered-Control model (the form says so).
      const model = toolModel(tool, engine, layersModelFor(tool, engine, input.modelId, prompt));
      const layers = clampLayers(model.id, s.layers ?? defaultLayers(tool, model.id));
      const res = s.resolution ?? "1K";
      const params: GenerationRequest["params"] = { ...aspectFor(model) };
      let p: string | undefined;
      if (model.id.startsWith("seedream")) {
        params.resolution = RES_TIER[res];
        if (model.id === "seedream-5-layers") params.extra = { enhance_prompt_mode: s.mode ?? "standard" };
        // Seedream picks how many layers it returns; the instruction steers it.
        p = prompt
          ? `Separate ${prompt} onto its own layer, and the rest into up to ${layers - 1} layers. Return name and description in English.`
          : `Separate the major elements into up to ${layers} layers. Return name and description in English.`;
      } else if (model.engine === "open") {
        params.numLayers = layers;
        params.extra = { steps: s.mode === "fast" ? 10 : 20, maxSize: OPEN_MAX_SIZE[res] };
        p = prompt || undefined;
      } else {
        params.numLayers = layers;
        p = prompt || undefined;
      }
      add("layers", base(model, { op: "layers", prompt: p, inputs: { images: [needImage()] }, params }));
      break;
    }
    case "regenerate": {
      if (!prompt) throw new LayersError("Describe the change in the layer edit prompt", 400);
      const model = toolModel(tool, engine, input.modelId);
      const refs = input.refs ?? [];
      const ask = refs.length ? `${prompt} Use image ${refs.length > 1 ? "2 and 3" : "2"} as the reference.` : prompt;
      add("edit", base(model, { op: "edit", prompt: s.keepAlpha ? `${ask} Keep the subject on a plain, even background.` : ask, inputs: { images: [needImage(), ...refs] }, params: aspectFor(model) }));
      if (s.keepAlpha) cutout("edit");
      break;
    }
    case "generate-layer": {
      if (!prompt) throw new LayersError("Describe the layer to generate", 400);
      const refs = input.refs ?? [];
      const ask = `${prompt}. A single element, isolated and centred on a plain white background, alone in the frame.`;
      if (refs.length) {
        const model = toolModel("regenerate", engine, undefined);
        add("make", base(model, { op: "edit", prompt: `${ask} Base it on image 1.`, inputs: { images: refs } }));
      } else {
        const model = toolModel(tool, engine, input.modelId);
        add("make", base(model, { op: "t2i", prompt: ask, params: { aspectRatio: "1:1", numOutputs: 1 } }));
      }
      cutout("make");
      break;
    }
    case "text-detect": {
      // OCR models (OvisOCR3, Florence-2) read the lines; Ideogram's text layers also lift them off the picture.
      const model = toolModel(tool, engine, input.modelId);
      const ocr = model.routes.some((r) => r.op === "ocr");
      add("detect", base(model, { op: ocr ? "ocr" : "text-layers", inputs: { images: [needImage()] }, ...(ocr ? {} : { params: aspectFor(model) }) }));
      break;
    }
    case "text-edit": {
      const rows = textChanges(s.rows ?? []);
      if (!rows.length) throw new LayersError("Change a line of text first", 400);
      const model = toolModel(tool, engine, input.modelId);
      add("edit", base(model, { op: "edit", prompt: textEditPrompt(rows), inputs: { images: [needImage()] }, params: aspectFor(model) }));
      if (s.keepAlpha) cutout("edit");
      break;
    }
    case "bg-remove": {
      const model = toolModel(tool, engine, input.modelId);
      // Bria's guided cut-out reads what to keep or drop ("keep the shadow"); the others take no words.
      add("cut", base(model, { op: "bg-remove", ...(model.options.guided && prompt ? { prompt } : {}), inputs: { images: [needImage()] }, params: aspectFor(model) }));
      break;
    }
    case "regional": {
      if (!prompt) throw new LayersError("Describe your changes for the selected area", 400);
      const model = toolModel(tool, engine, input.modelId);
      add("edit", base(model, { op: "edit", prompt: `${prompt}. Keep everything else in this crop the same, with the same framing, light and grain.`, inputs: { images: [needImage()] }, params: aspectFor(model) }));
      break;
    }
    case "upscale": {
      const model = toolModel(tool, engine, input.modelId);
      add("upscale", base(model, { op: "upscale-image", inputs: { images: [needImage()] }, params: aspectFor(model) }));
      break;
    }
    case "relight": {
      const model = toolModel(tool, engine, input.modelId);
      // The Relight LoRA graph gets the light alone; Qwen-Image 2.1 its own picture tags; other models a plain instruction.
      const p = relightPrompt(model.id, pick(RELIGHT_LIGHTS, s.light), pick(RELIGHT_DIRECTIONS, s.direction));
      add("relight", base(model, { op: "edit", prompt: prompt ? `${p} ${prompt}` : p, inputs: { images: [needImage()] }, params: aspectFor(model) }));
      if (s.keepAlpha) cutout("relight");
      break;
    }
    case "angles": {
      const model = toolModel(tool, engine, input.modelId);
      const keep = "Keep identity, outfit, props, lighting direction and colours consistent; reveal plausible unseen sides.";
      const request =
        model.id === "qwen-multiple-angles"
          ? base(model, {
              op: "edit",
              prompt: prompt || "The same subject from a new camera angle.",
              inputs: { images: [needImage()] },
              params: { ...aspectFor(model), numOutputs: 1, extra: { horizontal_angle: Math.round(s.rotate ?? 45), vertical_angle: Math.round(s.tilt ?? 0), zoom: Math.round(s.zoom ?? 5) } },
            })
          : // Edit models (Qwen-Image 2.1 at 25 steps on your GPU) turn the camera from plain words.
            base(model, { op: "edit", prompt: `Show the exact same subject from ${pick(ANGLES, s.angle)}, as if the camera physically moved. ${keep}${prompt ? ` ${prompt}` : ""}`, inputs: { images: [needImage()] }, params: aspectFor(model) });
      add("angle", request);
      if (s.keepAlpha) cutout("angle");
      break;
    }
    case "inpaint": {
      if (!input.mask) throw new LayersError("Paint over the area to change first", 400);
      if (!prompt) throw new LayersError("Say what should fill the painted area", 400);
      const model = toolModel(tool, engine, input.modelId);
      // Mask models take the mask; edit models are shown the painted area tinted red (applySketch picks).
      add("inpaint", base(model, { op: "inpaint", prompt: inpaintPrompt(prompt), inputs: { images: [needImage()], mask: input.mask, ...(input.sketch ? { sketch: input.sketch } : {}) }, params: aspectFor(model) }));
      if (s.keepAlpha) cutout("inpaint");
      break;
    }
    case "enhance": {
      const look = s.look ?? "skin";
      const ask = enhancePrompt(look, prompt);
      const model = toolModel(tool, engine, input.modelId, enhanceModels(look, engine));
      if (!ask) {
        // Detail: an upscaler rebuilds it at 2× (the layer keeps its place with more pixels, as Upscale does).
        const scale = ENHANCE_DETAIL_SCALE[model.id];
        add("enhance", base(model, { op: "upscale-image", inputs: { images: [needImage()] }, params: { ...aspectFor(model), ...(scale ? { extra: { scale } } : {}) } }));
        break;
      }
      add("enhance", base(model, { op: "edit", prompt: s.keepAlpha ? `${ask} Keep the subject on a plain, even background.` : ask, inputs: { images: [needImage()] }, params: aspectFor(model) }));
      if (s.keepAlpha) cutout("enhance");
      break;
    }
    case "rerender": {
      const layout = readLayout(s.layout);
      if (!layout?.items.length) throw new LayersError("Show at least one layer or line of text to re-render", 400);
      if (layout.items.length > RERENDER_MAX_LAYERS + RERENDER_MAX_TEXT) throw new LayersError("Too many boxes to re-render: hide some layers first", 400);
      const model = toolModel(tool, engine, input.modelId);
      // The picture's own shape, or the nearest one the model makes (the boxes are fractions, so they stay in place).
      const aspectRatio = nearestAspect(s.aspect, model.options.aspectRatios);
      // The plan compiles the layout for this model at the size it renders, and keeps prompt rewriting off.
      add("rerender", base(model, { op: "t2i", prompt: rerenderCaption(layout.summary.caption, prompt), params: { ...(aspectRatio && { aspectRatio }), numOutputs: 1, extra: { [LAYOUT_PARAM]: layout } } }));
      break;
    }
    case "expand": {
      const model = toolModel(tool, engine, input.modelId);
      const fill = "Continue the scene naturally beyond every edge with matching perspective, lighting, textures and grain.";
      if (model.engine === "open") {
        const pads = s.pads;
        if (!pads || pads.left + pads.top + pads.right + pads.bottom === 0) throw new LayersError("Drag an edge outward to make room to fill", 400);
        // The open graphs keep the picture as it is themselves, and read the words as what fills the margins: only that.
        add("expand", base(model, { op: "outpaint", prompt: prompt || fill, inputs: { images: [needImage()] }, params: { extra: { padLeft: pads.left, padTop: pads.top, padRight: pads.right, padBottom: pads.bottom } } }));
      } else {
        add("expand", base(model, { op: "edit", prompt: `Fill the empty grey margins around the picture. ${fill} Keep the original picture untouched, and fill the margins with more of the same surroundings.${prompt ? ` ${prompt}` : ""}`, inputs: { images: [needImage()] }, params: aspectFor(model) }));
      }
      break;
    }
  }
  const n = steps.length;
  return steps.map((st, i) => ({ ...st, request: { ...st.request, step: { ...st.request.step!, index: i, of: n } } }));
}

// ---------------------------------------------------------------------------
// Projects

const parseJobs = (s: string): LayerJob[] => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as LayerJob[]) : [];
  } catch {
    return [];
  }
};

/** The result generation of a job, trimmed to what the editor needs. */
function resultOf(job: LayerJob): LayerJobResult | null {
  const g: Generation | null = getGeneration(job.generationIds[job.generationIds.length - 1], { includeDeleted: true });
  if (!g) return null;
  return {
    status: g.status,
    progress: g.progress,
    message: g.message,
    error: g.error,
    provider: g.provider,
    outputs: g.outputs.map((o) => ({ url: o.url, kind: o.kind, ...(o.meta ? { meta: o.meta } : {}), ...(o.width ? { width: o.width } : {}), ...(o.height ? { height: o.height } : {}) })),
  };
}

const ACTIVE = new Set(["queued", "running"]);

/**
 * “An image can only be decomposed once” as a fact of the project, not of the open version (an
 * older version can be restored): a decomposition landed, or a split of the original picture did.
 * saveJobs keeps these jobs for good.
 */
const decomposes = (j: LayerJob, sourceUrl: string) => j.state === "applied" && (j.tool === "decompose" || (j.tool === "split" && j.settings?.image === sourceUrl));

function isDecomposed(row: ProjectRow, jobs: LayerJob[], doc: LayerDoc | null): boolean {
  return !!doc?.decomposed || jobs.some((j) => decomposes(j, row.source_url));
}

function statusOf(row: ProjectRow, doc: LayerDoc | null): Pick<LayerProject, "status" | "pendingLayers" | "decomposed"> {
  const jobs = parseJobs(row.jobs_json);
  const decomposed = isDecomposed(row, jobs, doc);
  const dec = jobs.filter((j) => j.tool === "decompose" && j.state !== "dismissed");
  const last = dec[dec.length - 1];
  if (!last || last.state === "applied") return { status: "ready", decomposed };
  const r = resultOf(last);
  if (r && ACTIVE.has(r.status)) return { status: "processing", decomposed };
  // Finished, waiting for the editor to lay the layers out.
  if (r?.status === "succeeded") return { status: "unopened", pendingLayers: r.outputs.filter((o) => o.kind === "image").length, decomposed };
  return { status: decomposed ? "ready" : "failed", decomposed };
}

function headDoc(row: ProjectRow): LayerDoc | null {
  if (!row.head_version_id) return null;
  const v = db().prepare("SELECT doc_json FROM layer_versions WHERE id = ?").get(row.head_version_id) as { doc_json: string } | undefined;
  return v ? (JSON.parse(v.doc_json) as LayerDoc) : null;
}

function toProject(row: ProjectRow, doc = headDoc(row)): LayerProject {
  return {
    id: row.id,
    name: row.name,
    sourceUrl: row.source_url,
    coverUrl: row.cover_url ?? row.source_url,
    width: doc?.width ?? row.width,
    height: doc?.height ?? row.height,
    layers: doc?.nodes.length ?? 1,
    ...statusOf(row, doc),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const getRow = (id: string) => db().prepare("SELECT * FROM layer_projects WHERE id = ?").get(id) as ProjectRow | undefined;

export function listProjects(): LayerProject[] {
  return (db().prepare("SELECT * FROM layer_projects ORDER BY updated_at DESC, id DESC").all() as ProjectRow[]).map((r) => toProject(r));
}

export function projectView(id: string): LayerProjectView | null {
  const row = getRow(id);
  if (!row) return null;
  const doc = headDoc(row);
  if (!doc || !row.head_version_id) return null;
  const versions = (db().prepare("SELECT id, label, created_at, updated_at FROM layer_versions WHERE project_id = ? ORDER BY created_at DESC, id DESC").all(id) as Omit<VersionRow, "project_id" | "doc_json">[]).map(
    (v): LayerVersion => ({ id: v.id, label: v.label, createdAt: v.created_at, updatedAt: v.updated_at }),
  );
  const jobs = parseJobs(row.jobs_json).map((j) => ({ ...j, result: resultOf(j) }));
  return { project: toProject(row, doc), versions, headVersionId: row.head_version_id, doc, jobs };
}

function insertVersion(projectId: string, label: string, doc: LayerDoc, now: number): string {
  const id = nanoid(10);
  db()
    .prepare("INSERT INTO layer_versions (id, project_id, label, doc_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, projectId, label.slice(0, 80), JSON.stringify(doc), now, now);
  return id;
}

/** A project's starting name: the result's title or prompt (first words), else the uploaded file's name. */
function nameFor(source: string): string | undefined {
  const assetId = /\/([A-Za-z0-9_-]{12})\.[a-z0-9]+$/i.exec(source)?.[1];
  const asset = assetId ? getAsset(assetId) : null;
  if (!asset) return undefined;
  const g = asset.generationId ? getGeneration(asset.generationId, { includeDeleted: true }) : null;
  const text = g?.request.title ?? g?.prompt ?? asset.name?.replace(/\.[^.]+$/, "");
  const words = text?.replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1, 80) : undefined;
}

/**
 * A new project on an image (an upload or a result): the image is its first layer. With
 * `generationId` (a finished layers result), its layers arrive like a decomposition that just finished.
 */
export function createProject(input: { source: string; width: number; height: number; name?: string; generationId?: string }): LayerProjectView {
  const width = Math.round(input.width);
  const height = Math.round(input.height);
  if (!(width > 0 && height > 0 && width <= 20_000 && height <= 20_000)) throw new LayersError("That image's size couldn't be read", 400);
  const jobs: LayerJob[] = [];
  const now = Date.now();
  if (input.generationId) {
    const g = getGeneration(input.generationId);
    if (!g || g.op !== "layers" || g.status !== "succeeded") throw new LayersError("That result isn't a finished set of layers", 400);
    jobs.push({ id: nanoid(8), tool: "decompose", label: "Layers from your result", frame: [0, 0, width, height], generationIds: [g.id], state: "pending", createdAt: now });
  }
  const id = nanoid(10);
  const name = input.name?.trim().slice(0, 80) || nameFor(input.source) || "Untitled project";
  db().transaction(() => {
    db()
      .prepare("INSERT INTO layer_projects (id, name, source_url, cover_url, width, height, head_version_id, jobs_json, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)")
      .run(id, name, input.source, width, height, JSON.stringify(jobs), now, now);
    const v = insertVersion(id, "Original", initialDoc(input.source, width, height, now), now);
    db().prepare("UPDATE layer_projects SET head_version_id = ? WHERE id = ?").run(v, id);
  })();
  return projectView(id)!;
}

/** Rename, and/or autosave the document into the head version (409 when another tab moved the head). */
/** The project card's cover: a small JPEG/WebP of the current composite, rendered by the editor (data URL). */
export const COVER_MAX = 300_000;
const isCover = (v: string) => /^data:image\/(jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length <= COVER_MAX;

export function updateProject(id: string, patch: { name?: string; doc?: LayerDoc; versionId?: string; cover?: string }): LayerProject | null {
  const row = getRow(id);
  if (!row) return null;
  const now = Date.now();
  if (patch.cover !== undefined && !isCover(patch.cover)) throw new LayersError("That cover isn't a small JPEG or WebP image", 400);
  db().transaction(() => {
    if (patch.name !== undefined) db().prepare("UPDATE layer_projects SET name = ?, updated_at = ? WHERE id = ?").run(patch.name.trim().slice(0, 80) || "Untitled project", now, id);
    if (patch.cover !== undefined) db().prepare("UPDATE layer_projects SET cover_url = ? WHERE id = ?").run(patch.cover, id);
    if (patch.doc) {
      if (patch.versionId && patch.versionId !== row.head_version_id) throw new LayersError("This project changed in another tab. Reload to see the latest version.", 409);
      if (patch.doc.source !== row.source_url) throw new LayersError("That document belongs to another image", 400);
      db().prepare("UPDATE layer_versions SET doc_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(patch.doc), now, row.head_version_id);
      db().prepare("UPDATE layer_projects SET updated_at = ? WHERE id = ?").run(now, id);
    }
  })();
  return toProject(getRow(id)!);
}

/** Delete the project and its versions; the images and the generations it made stay in the library. */
export function deleteProject(id: string): boolean {
  let gone = false;
  db().transaction(() => {
    gone = db().prepare("DELETE FROM layer_projects WHERE id = ?").run(id).changes > 0;
    db().prepare("DELETE FROM layer_versions WHERE project_id = ?").run(id);
  })();
  return gone;
}

/**
 * Save a version: a milestone (`doc` + `label`, e.g. after a tool's result landed, marking `jobId`
 * applied in the same step) or a restore of an older one (`from`). It becomes the head.
 */
export function createVersion(id: string, input: { doc?: LayerDoc; label?: string; jobId?: string; from?: string }): LayerProjectView {
  const row = getRow(id);
  if (!row) throw new LayersError("Not found", 404);
  const now = Date.now();
  db().transaction(() => {
    let doc = input.doc;
    let label = input.label?.trim() || "Edit";
    if (input.from) {
      const v = db().prepare("SELECT * FROM layer_versions WHERE id = ? AND project_id = ?").get(input.from, id) as VersionRow | undefined;
      if (!v) throw new LayersError("Layer project version is unavailable", 404);
      doc = JSON.parse(v.doc_json) as LayerDoc;
      label = `Restored “${v.label}”`;
    }
    if (!doc) throw new LayersError("Nothing to save", 400);
    if (doc.source !== row.source_url) throw new LayersError("That document belongs to another image", 400);
    let jobs = parseJobs(row.jobs_json);
    if (input.jobId) {
      const job = jobs.find((j) => j.id === input.jobId);
      if (!job) throw new LayersError("That job is gone", 404);
      if (job.state !== "pending") throw new LayersError("That result is already in your layers", 409);
      jobs = jobs.map((j) => (j.id === input.jobId ? { ...j, state: "applied" as const } : j));
    }
    const v = insertVersion(id, label, doc, now);
    db().prepare("UPDATE layer_projects SET head_version_id = ?, jobs_json = ?, updated_at = ? WHERE id = ?").run(v, JSON.stringify(jobs), now, id);
  })();
  return projectView(id)!;
}

/**
 * Jobs kept per project: every pending one, the one that decomposed the image (for good: it says
 * the image can't be decomposed again), plus the latest finished ones (the last text detection among them).
 */
const KEEP_JOBS = 40;

function saveJobs(id: string, jobs: LayerJob[], now = Date.now()) {
  const source = getRow(id)?.source_url ?? "";
  const pending = jobs.filter((j) => j.state === "pending");
  const first = jobs.find((j) => decomposes(j, source));
  const done = jobs.filter((j) => j.state !== "pending" && j !== first).slice(-Math.max(0, KEEP_JOBS - pending.length - (first ? 1 : 0)));
  const keep = jobs.filter((j) => pending.includes(j) || done.includes(j) || j === first).map((j) => {
    const { result: _drop, ...rest } = j;
    void _drop;
    return rest;
  });
  db().prepare("UPDATE layer_projects SET jobs_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(keep), now, id);
}

/** Start a tool: its generations run in the background; the editor applies the result when it lands. */
export function startJob(id: string, input: LayerJobInput): LayerJob {
  const row = getRow(id);
  if (!row) throw new LayersError("Not found", 404);
  const jobs = parseJobs(row.jobs_json);
  const running = (j: LayerJob) => {
    if (j.state !== "pending") return false;
    const r = resultOf(j);
    return !r || ACTIVE.has(r.status) || (r.status === "succeeded" && APPLIES_TO_DOC.has(j.tool));
  };
  if (input.tool === "decompose") {
    if (isDecomposed(row, jobs, headDoc(row))) throw new LayersError("An image can only be decomposed once. Pick a layer and use Separate layer to split it further.", 409);
    if (jobs.some((j) => j.tool === "decompose" && running(j))) throw new LayersError("This image is already being decomposed", 409);
  }
  if (input.nodeId && jobs.some((j) => j.nodeId === input.nodeId && j.tool !== "text-detect" && running(j))) {
    throw new LayersError("A generation is already running on this layer", 409);
  }
  const steps = jobSteps(input, { batchTitle: `Layers · ${row.name}` });
  // Seedream's layer-count instruction means nothing to the demo provider, which would print it on its sample text layer.
  if ((input.tool === "decompose" || input.tool === "split") && !input.prompt?.trim()) {
    for (const s of steps) {
      try {
        if (s.request.op === "layers" && s.request.prompt && previewGeneration(s.request).demo) s.request = { ...s.request, prompt: undefined };
      } catch {
        // createPipeline below reports what's wrong with the request.
      }
    }
  }
  let ids: string[];
  try {
    ids = createPipeline(steps, { batchId: `layers-${id}` }).items.map((g) => g.id);
  } catch (e) {
    if (e instanceof LayersError) throw e;
    if (e instanceof ConnectComfyError) throw e;
    throw new LayersError((e as Error).message || "Could not start the split");
  }
  // Starting the same tool again on the same target retires its failed or canceled run.
  const settled = jobs.map((j) => {
    if (j.state !== "pending" || j.tool !== input.tool || (j.nodeId ?? null) !== (input.nodeId ?? null)) return j;
    const r = resultOf(j);
    return r && (r.status === "failed" || r.status === "canceled") ? { ...j, state: "dismissed" as const } : j;
  });
  const job: LayerJob = {
    id: nanoid(8),
    tool: input.tool,
    label: input.label?.trim() || TOOL_LABELS[input.tool],
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    frame: input.frame as Box,
    // The input too: a regional edit lays its result over the region as it was (Original / New).
    settings: { ...(input.settings ?? {}), ...(input.prompt ? { prompt: input.prompt } : {}), ...(input.modelId ? { modelId: input.modelId } : {}), ...(input.image ? { image: input.image } : {}) },
    generationIds: ids,
    state: "pending",
    createdAt: Date.now(),
  };
  saveJobs(id, [...settled, job]);
  return { ...job, result: resultOf(job) };
}

/** Dismiss a job (a failure the user has seen, a detection that's been read) or cancel one still running. */
export async function endJob(id: string, jobId: string, opts: { cancel?: boolean; state?: "dismissed" | "applied" } = {}): Promise<LayerJob | null> {
  const row = getRow(id);
  if (!row) return null;
  const jobs = parseJobs(row.jobs_json);
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return null;
  if (opts.cancel) for (const g of job.generationIds) await cancelGeneration(g);
  const next = { ...job, state: opts.state ?? ("dismissed" as const) };
  saveJobs(
    id,
    jobs.map((j) => (j.id === jobId ? next : j)),
  );
  return { ...next, result: resultOf(next) };
}
