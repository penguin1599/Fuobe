import type { Engine, Generation, GenerationRequest, OutputFile } from "@/lib/catalog/types";
import type { OwnSetup } from "@/lib/own-setup";
import { PATH_FRAMES, keyAt } from "@/lib/camera-path";
import { exactOrbitKeys, type ExactOrbit } from "@/lib/exact-orbit";

/**
 * Image to 3D / Product spin: the modes (from an image, from several images, from text, pick an object, a splat),
 * which model each runs on per engine, and what a finished job gives the viewer — the .glb (and its lighter web
 * GLB) or the splat, a turntable video (the server renders one for open 3D models when it can, TripoSplat renders
 * its own orbit; otherwise the page records one in the browser), a poster, the source photo — and where
 * "Animate the spin" and "Rig & animate" go next.
 */
export const MODEL3D_FEATURE = "image-to-3d";
/** The helper steps of a chain (the open text-to-3D still): kept out of the page's results and the Library. */
export const MODEL3D_STEP_FEATURE = "image-to-3d-step";
/** "Film it photoreal": the photoreal orbits, listed with the models they were filmed from. */
export const MODEL3D_FILM_FEATURE = "image-to-3d-film";

export type Model3dMode = "image" | "multi" | "text" | "objects" | "splat";

export const MODEL3D_MODES: { id: Model3dMode; label: string; hint: string }[] = [
  { id: "image", label: "From an image", hint: "One clear photo of one object" },
  { id: "multi", label: "From several images", hint: "2–4 photos of the same object from different sides" },
  { id: "text", label: "From text", hint: "Describe one object" },
  { id: "objects", label: "Pick an object", hint: "Name what to take out of a photo" },
  { id: "splat", label: "Splat", hint: "A soft, photoreal 3D capture" },
];

export interface Model3dChoice {
  id: string;
  note: string;
}

/** The models each mode offers, the default first. Pick an object has no open model (SAM 3D Objects is cloud only). */
export const MODELS_3D: Record<Model3dMode, Record<Engine, Model3dChoice[]>> = {
  image: {
    cloud: [
      { id: "hunyuan-3d-3-1-pro", note: "Textured, game-ready · ≈ $0.38" },
      { id: "hunyuan-3d-3-1-rapid", note: "Faster single view · ≈ $0.23" },
      { id: "trellis-2", note: "Detailed geometry · ≈ $0.30" },
      { id: "tripo-h3-1", note: "Clean topology, PBR · ≈ $0.30" },
      { id: "meshy-7-1", note: "Textured, optional rigging · ≈ $1.20" },
      { id: "tripo-p2", note: "Production tier, realistic textures · ≈ $1.10" },
    ],
    open: [
      { id: "oss-pixal3d", note: "Most faithful to your photo, with a turntable video" },
      { id: "oss-trellis2", note: "A dependable second choice, with a turntable video" },
      { id: "oss-idol-3d", note: "A quick model of a person or product, with an orbit clip" },
      { id: "oss-hunyuan3d-21", note: "The shape only, without colour" },
      { id: "oss-idol-mesh", note: "Rough mesh, vertex colours, no textures · 8 GB GPU" },
    ],
  },
  multi: {
    cloud: [{ id: "meshy-7-1-multi", note: "Textured, from 2–4 photos · ≈ $1.20" }],
    open: [{ id: "oss-trellis2-multi", note: "The front plus up to 3 sides, with a turntable video" }],
  },
  text: {
    cloud: [{ id: "tripo-h3-1-text", note: "A textured model from words · ≈ $0.20" }],
    open: [{ id: "oss-text-trellis2", note: "Draws the object, then builds it in 3D, with a turntable video" }],
  },
  objects: {
    cloud: [{ id: "sam-3d-objects", note: "Rebuilds what you name, as it stands in the photo · ≈ $0.02" }],
    open: [],
  },
  splat: {
    cloud: [
      { id: "triposplat", note: "A soft, photoreal 3D capture · ≈ $0.05" },
      { id: "idol-3d", note: "One object from one picture · ≈ $0.10" },
    ],
    // TripoSplat stays the default until Idol 3D is compared with it side by side.
    open: [
      { id: "oss-triposplat", note: "A soft, photoreal 3D capture, with an orbit video" },
      { id: "oss-idol", note: "One object from one picture, with an orbit video" },
    ],
  },
};

/**
 * Notices cloud models need beside their results. The rule is the open engine's: a model that encodes the photo
 * with DINOv3 carries "Built with DINOv3" wherever it runs, fal included. TripoSplat (its weights ship
 * dino_v3_vit_h) and TRELLIS.2 (a DINOv3 ViT-L encoder, dino_v3_L_naf in Comfy-Org's repackage) do; Hunyuan3D,
 * Tripo, Meshy and SAM 3D don't. Open models get theirs from their workflow's licence.
 */
export const CLOUD_NOTICES: Record<string, string[]> = { triposplat: ["Built with DINOv3"], "idol-3d": ["Built with DINOv3"], "trellis-2": ["Built with DINOv3"] };

/** Idol 3D on each engine: the open graph (image-to-splat-idol) and fal's speridlabs/idol. */
export const IDOL_MODELS = { open: "oss-idol", cloud: "idol-3d" } as const;
export const isIdol = (id: string | null | undefined) => id === IDOL_MODELS.open || id === IDOL_MODELS.cloud;
/** Idol 3D quick mesh (From an image, open engine only): Idol's splat graph, then core SplatToMesh into a vertex-coloured GLB. */
export const IDOL_MESH_MODEL = "oss-idol-mesh";
export const isIdolMesh = (id: string | null | undefined) => id === IDOL_MESH_MODEL;

/**
 * Draft then final (idol-6, docs/research/idol-9.md §8): an Idol 3D splat on your GPU is a quick look at the object's
 * sides; the textured final is TRELLIS.2 from the same picture, an ordinary Image to 3D run (not an Idol substitute).
 */
export const FINAL_3D = { model: "oss-trellis2", label: "Build the final with TRELLIS.2", note: "A textured, riggable .glb · 16 GB GPU" } as const;

/**
 * Image to 3D's extra steps that run on a visitor's own GPU, by the own-setup id each is labelled with
 * (src/lib/own-setup.ts): Refine detail (Hi3D), the TRELLIS.2 final, Idol 3D's other sides and its spike trim. The page
 * reads which still carry a label (ownSetupsNow) and the studio shows it next to each.
 */
export const MODEL3D_SETUPS = {
  refine: "image-to-3d:hi3d-refine",
  final: "image-to-3d:trellis-final",
  sides: "image-to-3d:idol-other-sides",
  clean: "image-to-3d:idol-clean",
} as const;
export type Model3dSetupKey = keyof typeof MODEL3D_SETUPS;

/** Image to 3D's cloud models (Meshy, Tripo, SAM 3D Objects, Idol 3D in the cloud) for a visitor: its own fal.ai key. */
export const MODEL3D_KEY: OwnSetup = { need: "key", provider: "fal" };

/**
 * Where "Build the final with TRELLIS.2" goes from a finished Idol 3D result on the open engine: Image to 3D with
 * TRELLIS.2 picked and the result's own picture filled in. null on any other result, without the picture, or when
 * TRELLIS.2 isn't offered here (`allowed`: switched on in Settings → Models & licences, open models run, not a visitor).
 */
export function finalBuildHref(g: Pick<Generation, "request">, view: Pick<Model3dView, "photo">, allowed: boolean): string | null {
  if (!allowed || g.request.modelId !== IDOL_MODELS.open || !view.photo) return null;
  return `/image-to-3d?${new URLSearchParams({ mode: "image", model: FINAL_3D.model, image: view.photo })}`;
}

export type IdolQuality = "best" | "quick";

/**
 * Idol 3D's two settings on the open engine (the graph's bindings, sent as params.extra). best is Idol's reference
 * (idol-sdk: 50 Euler steps, CFG weight 3 in its (1+w) form = ComfyUI cfg 4, 262,144 Gaussians); quick is the
 * ComfyUI-Idol README's "faster trade-off" (20 dpmpp_2m steps) and "fast preview" (65,536 Gaussians), quality
 * unmeasured (docs/research/idol-9.md §11). Labelled by steps and Gaussians, never by seconds.
 */
export const IDOL_PRESETS: Record<IdolQuality, { steps: number; sampler: string; cfg: number; numGaussians: number }> = {
  best: { steps: 50, sampler: "euler", cfg: 4, numGaussians: 262144 },
  quick: { steps: 20, sampler: "dpmpp_2m", cfg: 4, numGaussians: 65536 },
};

/** The two settings as the page offers them. */
export const IDOL_QUALITIES: { id: IdolQuality; label: string; hint: string }[] = [
  { id: "best", label: "Best", hint: "50 steps · 262,144 Gaussians" },
  { id: "quick", label: "Quick look", hint: "20 steps · 65,536 Gaussians" },
];

/**
 * Idol 3D's two open graphs: the core one (idol-1: TripoSplat's nodes, a core-node photo crop, the saved file not
 * pruned) and the clean one (idol-2: the ComfyUI-Idol pack's crop, pruning and input-view still), which the server
 * runs when its ComfyUI has the pack (GET /object_info/IdolPruneSplat).
 */
export const IDOL_WORKFLOWS = { core: "image-to-splat-idol", clean: "image-to-splat-idol-clean" } as const;
/** The node pack the clean graph needs (src/lib/licences.ts NODE_PACKS), and the class whose presence says a ComfyUI has it. */
export const IDOL_PACK = "ComfyUI-Idol";
export const IDOL_PACK_CLASS = "IdolPruneSplat";

/**
 * "Trim spikes": IdolPruneSplat's max_scale, the longest axis a Gaussian may have (object units, the object spans
 * about 1), which drops the needle-shaped ones at the silhouette. 0.05 is the pack's "reasonable start".
 */
export const IDOL_TRIM_SPIKES = 0.05;

/**
 * Idol 3D's settings for a request: on the open engine the graph's (photoCrop picks the looser crop; trimSpikes the
 * pack's max_scale, used where the pack is installed), on fal the endpoint's own fields. fal takes the steps, the
 * Gaussians and the kind of picture ("real" is Idol's photo crop), but no sampler, no CFG in ComfyUI's form and no
 * pruning, so its guidance stays fal's default (Idol's reference weight 3).
 */
export function idolExtra(engine: Engine, quality: IdolQuality = "best", photoCrop = false, trimSpikes = false): Record<string, unknown> {
  const p = IDOL_PRESETS[quality] ?? IDOL_PRESETS.best;
  if (engine === "open") return { ...p, photoCrop, ...(trimSpikes && { maxScale: IDOL_TRIM_SPIKES }) };
  return { num_inference_steps: p.steps, num_gaussians: p.numGaussians, image_type: photoCrop ? "real" : "synthetic" };
}

const unit = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined);

/**
 * An Idol run's crop and pruning in the words of the graph it runs on (`has`: the graph binds that key). The clean graph
 * takes cropMode ("It's a photo" is Idol's "real" crop, else "synthetic"), minOpacity and maxScale (0-1); the core
 * graph takes its photoCrop switch (a cropMode of "real" turns it on) and has no pruning. Keys a graph doesn't bind are
 * left out.
 */
export function idolGraphValues(extra: Record<string, unknown>, has: (key: string) => boolean): Record<string, unknown> {
  const mode = extra.cropMode === "real" || extra.cropMode === "synthetic" ? extra.cropMode : undefined;
  const photo = typeof extra.photoCrop === "boolean" ? extra.photoCrop : mode ? mode === "real" : undefined;
  const out: Record<string, unknown> = {};
  if (has("cropMode")) out.cropMode = mode ?? (photo ? "real" : "synthetic");
  else if (has("photoCrop") && photo !== undefined) out.photoCrop = photo;
  for (const k of ["minOpacity", "maxScale"] as const) {
    const v = unit(extra[k]);
    if (has(k) && v !== undefined) out[k] = v;
  }
  return out;
}

/** What a clean splat's count said (PreviewAny's text): the number of Gaussians the prune kept, else undefined. */
export function idolKept(text: string | undefined): number | undefined {
  const t = text?.trim();
  const n = Number(t);
  return t && Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** The result card's line about a splat file: how many Gaussians the clean graph kept, or that it wasn't cleaned. */
export function idolCleanLine(meta: Record<string, unknown> | undefined): { cleaned: boolean; text: string } | undefined {
  if (typeof meta?.kept === "number") return { cleaned: true, text: `Cleaned: ${meta.kept.toLocaleString("en-US")} Gaussians kept` };
  if (meta?.pruned === false) return { cleaned: false, text: "Not cleaned" };
  return undefined;
}

/**
 * Whether a new picture reads as a photo for Idol's crop: an upload (dropped here, or an earlier one picked from the
 * library) is; a result made here (a render or a generated image) isn't. undefined: the picture is the same one, or the
 * second report of an upload already counted, so the switch keeps what the person set.
 */
export function idolPhotoFor(
  next: { ref: string; uploading?: boolean; source?: "upload" | "generation" } | null,
  prev: { ref: string; uploading?: boolean } | null | undefined,
): boolean | undefined {
  if (!next || next.ref === prev?.ref) return undefined;
  if (next.uploading) return true;
  if (prev?.uploading) return undefined;
  return next.source === "upload";
}

/** Every model the page offers (⌘K's ?model= links land on its mode). */
export const ALL_MODELS_3D: Model3dChoice[] = Object.values(MODELS_3D).flatMap((m) => [...m.cloud, ...m.open]);

/** The mode and engine a model belongs to (a ?model= link). */
export function modeOf(id: string): { mode: Model3dMode; engine: Engine } | null {
  for (const mode of Object.keys(MODELS_3D) as Model3dMode[]) {
    for (const engine of ["cloud", "open"] as const) if (MODELS_3D[mode][engine].some((m) => m.id === id)) return { mode, engine };
  }
  return null;
}

/** The sides of an object, in the order the open multi-view graph takes them; the front is needed. */
export const VIEW_SIDES = ["front", "left", "back", "right"] as const;
export type ViewSide = (typeof VIEW_SIDES)[number];
export const SIDE_LABELS: Record<ViewSide, string> = { front: "Front", left: "Left side", back: "Back", right: "Right side" };
/**
 * Left and right are the object's own, as Pixal3D's rig takes them (the left view's camera is 90° round from the
 * front, on the side that is on your right as you face the front): said beside the slots.
 */
export const SIDES_HINT = "Left and right are the object's own: facing its front, walk round to your right for its left side.";

/** What the user filled in: the photo (or photos by side), the words. */
export interface Model3dInput {
  engine: Engine;
  mode?: Model3dMode;
  modelId?: string;
  /** From an image, Pick an object, Splat. */
  photo?: string;
  /** From several images: the photos by side. */
  views?: Partial<Record<ViewSide, string>>;
  /** From text: the object; Pick an object: what to take out. */
  prompt?: string;
  /** Splat with Idol 3D, or From an image with Idol 3D quick mesh: Best (its reference settings, the default) or Quick look. */
  quality?: IdolQuality;
  /** Splat with Idol 3D, or From an image with Idol 3D quick mesh: the picture is a photo, so the object gets Idol's looser crop. */
  photoCrop?: boolean;
  /** Splat with Idol 3D on your GPU: also drop the needle-shaped Gaussians (with the ComfyUI-Idol pack). */
  trimSpikes?: boolean;
}

/** The model for a mode and engine: the one picked when the mode offers it, else its default (null: none on that engine). */
export function model3dFor(mode: Model3dMode, engine: Engine, modelId?: string): string | null {
  const list = MODELS_3D[mode][engine];
  return (modelId && list.find((m) => m.id === modelId)?.id) || list[0]?.id || null;
}

export const MAX_3D_PROMPT = 600;
const NO_OPEN_OBJECTS = "Pick an object runs on SAM 3D Objects, a cloud model";

/** Why the request can't go yet, in the words the button shows (null: ready). */
export function model3dBlocker(i: Model3dInput): string | null {
  const mode = i.mode ?? "image";
  if (!model3dFor(mode, i.engine, i.modelId)) return NO_OPEN_OBJECTS;
  if (mode === "multi") {
    if (!i.views?.front) return "Add a photo of the front";
    return VIEW_SIDES.filter((s) => i.views?.[s]).length < 2 ? "Add at least one more side" : null;
  }
  if (mode === "text") return i.prompt?.trim() ? null : "Describe the object";
  if (!i.photo) return "Add a photo";
  if (mode === "objects" && !i.prompt?.trim()) return "Name the object to take out";
  return null;
}

/**
 * The generation request for a mode. Several images go in side order (front, left, back, right); the open
 * graph also gets their sides by name (params.extra.views), since a side may be missing. SAM 3D Objects
 * always gets the words (its API reads "car" when there are none).
 */
export function model3dRequest(i: Model3dInput): GenerationRequest {
  const mode = i.mode ?? "image";
  const modelId = model3dFor(mode, i.engine, i.modelId);
  if (!modelId) throw new Error(NO_OPEN_OBJECTS);
  const prompt = i.prompt?.trim().slice(0, MAX_3D_PROMPT) ?? "";
  const base = { feature: MODEL3D_FEATURE, modelId };
  const images = i.photo ? [i.photo] : [];
  switch (mode) {
    case "multi": {
      const sides = VIEW_SIDES.filter((s) => i.views?.[s]);
      return {
        ...base,
        op: "image-to-3d",
        inputs: { images: sides.map((s) => i.views![s]!) },
        ...(i.engine === "open" && { params: { extra: { views: [...sides] } } }),
      };
    }
    case "text":
      return { ...base, op: "text-to-3d", prompt };
    case "objects":
      return { ...base, op: "image-to-3d", prompt, inputs: { images } };
    case "splat":
      // Idol 3D gets its Best / Quick look settings and the photo crop; TripoSplat's request is unchanged.
      return { ...base, op: "splat", inputs: { images }, ...(isIdol(modelId) && { params: { extra: idolExtra(i.engine, i.quality, !!i.photoCrop, !!i.trimSpikes) } }) };
    default:
      // Idol 3D quick mesh runs Idol's graph first, so it takes the same Best / Quick look settings and photo crop.
      return { ...base, op: "image-to-3d", inputs: { images }, ...(isIdolMesh(modelId) && i.engine === "open" && { params: { extra: idolExtra("open", i.quality, !!i.photoCrop) } }) };
  }
}

/** The mode a job was made in (its card goes by it). */
export function modeOfRequest(r: Pick<GenerationRequest, "op" | "modelId" | "inputs">): Model3dMode {
  if (r.op === "splat") return "splat";
  if (r.op === "text-to-3d") return "text";
  return modeOf(r.modelId)?.mode ?? ((r.inputs?.images?.length ?? 0) > 1 ? "multi" : "image");
}

/**
 * The open text-to-3D still: one object, whole, centred on a plain background in soft light, which is
 * what TRELLIS.2's cut-out and reconstruction want.
 */
export function stillPromptFor3d(prompt: string): string {
  const words = prompt.trim().replace(/[.\s]+$/, "");
  return `${words}. The object alone, whole and centred, seen from the front at eye level, on a plain light grey background, soft even studio light`;
}

/**
 * The GLB a viewer should load: the web GLB the server made after the job (meshopt geometry, WebP
 * textures, pivot at the bottom; meta.web), else the original — results made before that keep working.
 */
export function viewerGlb(o: { url: string; meta?: Record<string, unknown> }): string {
  const web = o.meta?.web;
  return typeof web === "string" && web ? web : o.url;
}

export interface Model3dView {
  /** The original GLB (the download): a splat's is the mesh made from it, when there is one. */
  glb?: string;
  /** The GLB to show in a viewer: the web GLB when there is one, else `glb`. */
  web?: string;
  /** A Gaussian splat (.ply / .spz / .ksplat): the splat viewer draws it (src/components/model3d/splat-viewer.tsx), with its turntable or preview as the poster and fallback, and it downloads. */
  splat?: { url: string; format: string };
  /** Idol 3D on your GPU: the splat file cleaned of its haze (how many Gaussians were kept), or not (no ComfyUI-Idol). */
  clean?: { cleaned: boolean; text: string };
  /** A rendered turntable that came with the model (the server's render for open 3D models, TripoSplat's orbit on the open engine, demo). */
  turntable?: string;
  /** The server is still rendering the turntable (after the job finished): waiting its turn, or how far (0-1). */
  rendering?: { queued: boolean; progress: number };
  /** The material class the server's finish read from the textures (matte, metal, mixed, unknown). */
  material?: string;
  poster?: string;
  /** The product photo it was made from. */
  photo?: string;
  /** Other files the provider returned (OBJ, FBX, USDZ, the splat, the walk and run clips…), by name. */
  formats: Record<string, string>;
  /** A rigged character; `animated` when it plays an animation preset. */
  rigged?: boolean;
  animated?: boolean;
}

const SPLAT_FORMATS = new Set(["ply", "spz", "ksplat", "splat"]);

/**
 * A Gaussian splat's format (ply, spz, ksplat), which no glTF viewer loads, else undefined. A splat says so
 * (meta.format), or its file's extension does. A GLB marked as a splat (older demo results) stays a GLB; today's demo
 * splat is a real .spz or .ply (scripts/gen-demo-splat.mjs).
 */
export function splatFormatOf(o: Pick<OutputFile, "url" | "meta"> | undefined): string | undefined {
  if (!o) return undefined;
  const declared = typeof o.meta?.format === "string" && o.meta.format ? o.meta.format.toLowerCase() : undefined;
  const ext = o.url.split("?")[0].split(".").pop()?.toLowerCase();
  const format = declared ?? (ext && SPLAT_FORMATS.has(ext) ? ext : undefined);
  return format && SPLAT_FORMATS.has(format) ? format : undefined;
}

/** The still the open text-to-3D route drew and built the model from (the 3D step's chained image), once it ran. */
export function stillOf(g: Pick<Generation, "request">): string | undefined {
  const r = g.request;
  return r.chainFilled && r.op === "image-to-3d" && r.chain?.some((c) => c.slot === "images") ? r.inputs?.images?.[0] : undefined;
}

export function model3dView(g: Pick<Generation, "outputs" | "request">): Model3dView {
  // The model itself; a splat's GLB made from it (role "mesh") is what the viewer shows of a splat.
  const files = g.outputs.filter((o) => o.kind === "model3d");
  const mesh = files.find((o) => o.meta?.role !== "mesh") ?? files[0];
  const fromSplat = files.find((o) => o !== mesh && o.meta?.role === "mesh");
  // A GLB made from a splat in its own graph (Photo to 3D): the splat beside it (role "splat") is one of its downloads.
  const sideSplat = mesh && !splatFormatOf(mesh) ? files.find((o) => o !== mesh && o.meta?.role === "splat") : undefined;
  const meta = (mesh?.meta ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const videos = g.outputs.filter((o) => o.kind === "video");
  const finish = (meta.finish ?? {}) as { turntable?: unknown; turntableProgress?: unknown; material?: unknown };
  // Idol 3D quick mesh's graph brings the splat's orbit, which looks smoother than the mesh: its card shows a turntable
  // only once the server has rendered the mesh's own (which replaces the orbit), else the poster, and one can be recorded.
  const orbitOnly = isIdolMesh(g.request.modelId) && finish.turntable !== "done";
  const video = orbitOnly ? videos.find((o) => o.meta?.turntable === true) : (videos.find((o) => o.meta?.role === "turntable" || o.meta?.turntable) ?? videos[0]);
  const pending = finish.turntable === "queued" || finish.turntable === "rendering";
  const formats: Record<string, string> = {};
  const listed = meta.formats;
  if (listed && typeof listed === "object") for (const [k, v] of Object.entries(listed as Record<string, unknown>)) if (typeof v === "string") formats[k.toLowerCase()] = v;
  if (sideSplat) formats.splat = sideSplat.url;
  const format = splatFormatOf(mesh);
  const splat = mesh && format ? { url: mesh.url, format } : undefined;
  const clean = splat ? idolCleanLine(meta) : undefined;
  return {
    glb: splat ? fromSplat?.url : mesh?.url,
    web: mesh && !splat ? viewerGlb(mesh) : fromSplat?.url,
    splat,
    ...(clean && { clean }),
    turntable: str(meta.turntable) ?? str(meta.video) ?? video?.url,
    rendering: pending ? { queued: finish.turntable === "queued", progress: typeof finish.turntableProgress === "number" ? finish.turntableProgress : 0 } : undefined,
    material: str(finish.material),
    poster: str(meta.preview) ?? str(meta.poster) ?? g.outputs.find((o) => o.kind === "image")?.url,
    photo: g.request.inputs?.images?.[0],
    formats,
    rigged: meta.rigged === true || undefined,
    animated: meta.animated === true || undefined,
  };
}

const SPIN_PROMPT = "The product rotates slowly 360 degrees on a turntable in a clean studio, soft key light sweeping across it, the design and label stay exactly the same";

/** "Animate the spin": restyle the turntable into a finished shot (Edit video), or animate the photo (Video). */
export function animateSpinHref(v: Model3dView, turntable?: string): string | null {
  const clip = turntable ?? v.turntable;
  if (clip) return `/video-edit?${new URLSearchParams({ video: clip, prompt: "Turn this product turntable into a premium commercial shot: studio lighting, soft reflections, a clean seamless backdrop; keep the product and its rotation exactly" })}`;
  if (v.photo) return `/video?${new URLSearchParams({ image: v.photo, prompt: SPIN_PROMPT })}`;
  return null;
}

// ---------------------------------------------------------------------------
// Film it photoreal: a photoreal orbit whose geometry matches the 3D model

/** The orbit "Film it photoreal" films: one level turn round the model, counter-clockwise seen from above. */
export const PHOTOREAL_ORBIT: ExactOrbit = { degrees: 360, direction: "ccw", tilt: 0, pulse: 0 };

/**
 * The model's turntable angle (radians) for frame i of the path render: the camera moving round to the right is the
 * model turning the other way under a still camera. One constant to flip if a GPU run shows the film turning against
 * its render.
 */
export const PHOTOREAL_TURN_SIGN: 1 | -1 = -1;
export function photorealAngle(i: number, frames = PATH_FRAMES): number {
  const k = keyAt(exactOrbitKeys(PHOTOREAL_ORBIT), frames > 1 ? i / (frames - 1) : 0);
  return (PHOTOREAL_TURN_SIGN * k.azimuth * Math.PI) / 180 + 0;
}

/**
 * "Film it photoreal": the photo the model was made from, filmed going round it. Cloud: H3 Max camera-controls from the
 * photo along the orbit. Open: Wan 2.1 + Uni3C from the photo, guided by the model recorded along the same orbit
 * (`render`; the browser records the GLB, a splat hands its own orbit video). Null when there's no photo to start from.
 */
export function photorealBody(v: Pick<Model3dView, "photo" | "poster">, engine: Engine, render?: string, still?: string) {
  const image = v.photo ?? still;
  if (!image) return null;
  return { engine, image, orbit: PHOTOREAL_ORBIT, feature: MODEL3D_FILM_FEATURE, title: "Photoreal orbit", ...(engine === "open" && render && { render }) };
}

// ---------------------------------------------------------------------------
// Rig & animate (Meshy rigging on fal; cloud only — UniRig's ComfyUI pack isn't verified)

export const RIG_MODEL = "meshy-rigging";

/**
 * Animation presets from Meshy's library (https://docs.meshy.ai/en/api/animation-library: 656 presets numbered
 * 0–696, read 2026-10-25): a short list by kind; any other goes by its number.
 */
export const ANIMATION_PRESETS: { group: string; items: { id: number; name: string }[] }[] = [
  {
    group: "Everyday",
    items: [
      { id: 0, name: "Idle" },
      { id: 28, name: "Wave hello" },
      { id: 41, name: "Bow" },
      { id: 25, name: "Nod yes" },
      { id: 50, name: "Phone call" },
      { id: 56, name: "Stand and chat" },
      { id: 32, name: "Sit on a chair" },
    ],
  },
  {
    group: "Walk and run",
    items: [
      { id: 30, name: "Casual walk" },
      { id: 106, name: "Confident walk" },
      { id: 117, name: "Red carpet walk" },
      { id: 118, name: "Skip" },
      { id: 14, name: "Run" },
      { id: 16, name: "Sprint" },
      { id: 112, name: "Monster walk" },
    ],
  },
  {
    group: "Dance",
    items: [
      { id: 22, name: "Funny dance" },
      { id: 74, name: "Gangnam groove" },
      { id: 82, name: "Shake it off" },
      { id: 64, name: "All-night dance" },
    ],
  },
  {
    group: "Jump and cheer",
    items: [
      { id: 466, name: "Jump" },
      { id: 44, name: "Happy jump" },
      { id: 452, name: "Backflip" },
      { id: 59, name: "Victory cheer" },
      { id: 303, name: "Cheer with both hands" },
    ],
  },
  {
    group: "Fight",
    items: [
      { id: 89, name: "Combat stance" },
      { id: 87, name: "Boxing" },
      { id: 96, name: "Kung fu punch" },
      { id: 207, name: "Roundhouse kick" },
      { id: 198, name: "Punch combo" },
    ],
  },
  {
    group: "Workout",
    items: [
      { id: 329, name: "Push-ups" },
      { id: 319, name: "Squats" },
    ],
  },
];

export const ANIMATION_MAX = 696;
export const ANIMATION_LIBRARY_URL = "https://docs.meshy.ai/en/api/animation-library";

export function animationName(id: number): string {
  for (const g of ANIMATION_PRESETS) for (const p of g.items) if (p.id === id) return p.name;
  return `Preset ${id}`;
}

/** A preset number Meshy takes (a whole number 0–696), else null. */
export function animationId(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= ANIMATION_MAX ? n : null;
}

/**
 * Rig a finished model (a humanoid GLB): the skeleton plus Meshy's walk and run cycles, and with a preset the
 * animated GLB the viewer plays.
 */
export function rigRequest(o: { glb: string; animation?: number | null }): GenerationRequest {
  const animation = o.animation === undefined || o.animation === null ? null : animationId(o.animation);
  return { feature: MODEL3D_FEATURE, modelId: RIG_MODEL, op: "rig-3d", inputs: { model3d: o.glb }, ...(animation !== null && { params: { animation } }) };
}

// ---------------------------------------------------------------------------
// Retexture (Meshy 7 or 6 on fal; cloud only): new textures on a finished model, from words or a style picture.

/** The retexture models, the default first. */
export const RETEXTURE_MODELS = [
  { id: "meshy-7-retexture", label: "Meshy 7" },
  { id: "meshy-6-retexture", label: "Meshy 6" },
] as const;
export type RetextureModel = (typeof RETEXTURE_MODELS)[number]["id"];
/** Meshy's style prompt: "Maximum 600 characters". */
export const RETEXTURE_PROMPT_MAX = 600;
export const RETEXTURE_SIZES = ["2k", "4k", "8k"] as const;

/** Retexture a finished model: the words, or a style picture (which wins when both go), at a texture size. */
export function retextureRequest(o: { glb: string; prompt?: string; style?: string; model?: RetextureModel; size?: (typeof RETEXTURE_SIZES)[number] }): GenerationRequest {
  return {
    feature: MODEL3D_FEATURE,
    modelId: o.model ?? RETEXTURE_MODELS[0].id,
    op: "retexture-3d",
    prompt: (o.prompt ?? "").trim().slice(0, RETEXTURE_PROMPT_MAX),
    inputs: { model3d: o.glb, ...(o.style && { images: [o.style] }) },
    ...(o.size && o.size !== "2k" && { params: { extra: { texture_resolution: o.size } } }),
  };
}

/** What Make it 3D (quick) on an image result does: shown in the studio with the picture handed over (never "2 s"). */
export const MAKE_3D_HINT = "Turns this picture into a 3D splat on your GPU and renders a turning preview. Takes tens of seconds on a consumer GPU.";

export interface Model3dLink {
  model?: { mode: Model3dMode; engine: Engine; id: string };
  rig?: boolean;
  mode?: Model3dMode;
  quality?: IdolQuality;
  image?: string;
  photo?: boolean;
}

/**
 * The photo slot's value for a picture handed over in an Image to 3D link: a result made here (so Idol's photo crop
 * starts off), or an upload with ?photo=1 (crop on).
 */
export function linkedPicture(url: string, asPhoto: boolean): { id: string; ref: string; preview: string; kind: "image"; source: "upload" | "generation" } {
  return { id: "link", ref: url, preview: url, kind: "image", source: asPhoto ? "upload" : "generation" };
}

/** Idol 3D's look per `${mode}:${engine}` after a link's ?quality=: set only when the linked model is Idol 3D. */
export function linkedIdolQuality(prev: Record<string, IdolQuality>, mode: Model3dMode, engine: Engine, id: string, quality?: IdolQuality): Record<string, IdolQuality> {
  return quality && isIdol(id) ? { ...prev, [`${mode}:${engine}`]: quality } : prev;
}

/**
 * What an Image to 3D link asks for: ?model= (⌘K, Make it 3D) picks a model, its mode and its engine; ?model=meshy-rigging
 * says where Rig & animate is; else ?mode= picks a mode. ?quality= is Idol 3D's Best or Quick look, ?image= a picture for
 * the photo slot (a file Fuobe keeps, or an https link), and ?photo=1 says it is a photo (an upload), so Idol's looser
 * photo crop starts on; a picture handed over from a result starts with it off (idol-5).
 */
export function readModel3dLink(sp: Pick<URLSearchParams, "get">): Model3dLink {
  const id = sp.get("model");
  const mode = sp.get("mode");
  const found = id ? modeOf(id) : null;
  const out: Model3dLink = {};
  if (found && id) out.model = { ...found, id };
  else if (id === RIG_MODEL) out.rig = true;
  else if (MODEL3D_MODES.some((m) => m.id === mode)) out.mode = mode as Model3dMode;
  const quality = sp.get("quality");
  if (quality === "best" || quality === "quick") out.quality = quality;
  const image = sp.get("image");
  if (image && /^(\/api\/files\/|https:\/\/)/.test(image) && image.length <= 2048) {
    out.image = image;
    out.photo = sp.get("photo") === "1";
  }
  return out;
}

/**
 * Whether an Image to 3D link's picture sets Idol's "It's a photo": only Make it 3D's link (it names Idol 3D) says what
 * the picture is. Other links with ?image= (an Idol 3D result's "Build the final with TRELLIS.2") leave it as it is.
 */
export function linkedPhoto(link: Model3dLink): boolean | undefined {
  return link.image && link.model && isIdol(link.model.id) ? !!link.photo : undefined;
}

// Turn with taps: the views a 3D viewer's chips turn to

export type TurnView = "front" | "left" | "back" | "right" | "above";

/**
 * The chips under a 3D view, in order. Left and right are the subject's own (as SIDE_LABELS): facing its front, its
 * left side is on your right. theta is model-viewer's orbit angle round the model (0 = the camera on +Z, 90 = on +X),
 * phi the angle down from straight above.
 */
export const TURN_VIEWS: { id: TurnView; label: string; theta: number; phi: number }[] = [
  { id: "front", label: "Front", theta: 0, phi: 75 },
  { id: "left", label: "Left side", theta: 90, phi: 75 },
  { id: "back", label: "Back", theta: 180, phi: 75 },
  { id: "right", label: "Right side", theta: 270, phi: 75 },
  { id: "above", label: "From above", theta: 25, phi: 35 },
];

/**
 * The yaw (degrees) that turns a model's own front to model-viewer's front, by model: a GLB made from a splat faces
 * the way the model put the subject, which the GPU test measures. Models not listed face +Z already. Idol 3D quick
 * mesh (oss-idol-mesh) meshes the same Idol splat with the same SplatToMesh node as Photo to 3D's, so it faces the same way.
 */
export const FRONT_YAW: Record<string, number> = { "oss-idol-3d": 90, "oss-idol-mesh": 90 };

/** model-viewer's camera-orbit for a chip: its angle plus the model's front, at the distance the viewer frames it. */
export function turnOrbit(view: TurnView, frontYaw = 0): string {
  const v = TURN_VIEWS.find((t) => t.id === view) ?? TURN_VIEWS[0];
  const theta = (((v.theta + frontYaw) % 360) + 360) % 360;
  return `${theta}deg ${v.phi}deg 130%`;
}
