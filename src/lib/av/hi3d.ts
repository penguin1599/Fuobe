import type { Engine, Generation, GenerationRequest } from "@/lib/catalog/types";
import { MODEL3D_FEATURE } from "./model3d";

/**
 * Hi3D 1.0 (Sparc3D's refinement stage, released open; docs/research/hi3d-refine.json): it refines a coarse mesh into
 * high-resolution geometry, guided by a photo of the same object. Geometry only (no colour or texture), recentred and
 * scaled to a unit radius, so a print needs its real size set again. Nobody hosts the open model, so it runs on the
 * open engine only (the user's ComfyUI with T8's Hi3D pack): the cloud engine says so, and "Paid APIs only" hides it.
 */
export const HI3D_MODEL = "oss-hi3d-refine";
export const HI3D_OP = "refine-3d";
/** The graph's setting for the resolution (params.extra), and the Image to 3D request's ask for a refine step after the model. */
export const HI3D_PARAM = "meshResolution";
export const HI3D_CHAIN_PARAM = "hi3dRefine";

export type Hi3dResolution = 512 | 1024 | 1536;
export const HI3D_RESOLUTIONS: { value: Hi3dResolution; label: string; hint: string }[] = [
  { value: 512, label: "512", hint: "Quickest: one pass" },
  { value: 1024, label: "1024", hint: "Sharper detail: two passes" },
  { value: 1536, label: "1536", hint: "Finest detail: three passes, needs the most GPU memory" },
];
export const HI3D_DEFAULT: Hi3dResolution = 1024;

/** The licence asks for this, linking to Hi3D's site, wherever its results are shown (Hi3D Open License 1.0, Section 7). */
export const HI3D_NOTICE = "Powered by Hi3D 1.0";
export const HI3D_URL = "http://hi3d.ai/";

export const HI3D_LABEL = "Refine detail · Hi3D 1.0";
export const HI3D_GEOMETRY_NOTE = "Geometry only: the refined model has no colour or texture, and comes out centred at a standard size.";
/** What it needs (README: compute capability 8.0+, CUDA 12, flash-attn or the pack's SDPA path; no CPU inference). */
export const HI3D_HARDWARE = "Runs on your GPU: an NVIDIA card from the RTX 30 series (Ampere) or newer with CUDA 12. There is no CPU mode. About 11 GB of model files.";
export const HI3D_CLOUD_NOTE = "Refine detail runs on your GPU only: no cloud service offers it.";

/** A resolution Hi3D takes, else the default. */
export function hi3dResolution(v: unknown): Hi3dResolution {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return HI3D_RESOLUTIONS.some((r) => r.value === n) ? (n as Hi3dResolution) : HI3D_DEFAULT;
}

/** A value the graph can take as it is (null: not one of 512, 1024, 1536). */
export function strictHi3dResolution(v: unknown): Hi3dResolution | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return HI3D_RESOLUTIONS.some((r) => r.value === n) ? (n as Hi3dResolution) : null;
}

/** "Refine this mesh": a finished model's GLB and the photo it was made from, refined at a resolution. */
export function refineRequest(o: { glb: string; photo: string; resolution?: unknown; seed?: number; feature?: string }): GenerationRequest {
  return {
    feature: o.feature ?? MODEL3D_FEATURE,
    modelId: HI3D_MODEL,
    op: HI3D_OP,
    engine: "open",
    inputs: { model3d: o.glb, images: [o.photo] },
    params: { extra: { [HI3D_PARAM]: hi3dResolution(o.resolution) }, ...(o.seed !== undefined && { seed: o.seed }) },
  };
}

/** The refine step Image to 3D asked for after its model (params.extra.hi3dRefine), else null. */
export function chainedRefine(r: Pick<GenerationRequest, "params">): Hi3dResolution | null {
  const v = r.params?.extra?.[HI3D_CHAIN_PARAM];
  return v === undefined || v === null || v === false || v === "off" ? null : hi3dResolution(v);
}

/** Image to 3D's request with the refine step asked for (open engine only; the cloud never gets it). */
export function withRefine(req: GenerationRequest, engine: Engine, resolution: Hi3dResolution | null): GenerationRequest {
  if (engine !== "open" || resolution === null || req.op === "splat") return req;
  return { ...req, params: { ...req.params, extra: { ...req.params?.extra, [HI3D_CHAIN_PARAM]: resolution } } };
}

/** A Hi3D result (its card says it is geometry only and carries the notice). */
export const isRefined = (g: Pick<Generation, "modelId">) => g.modelId === HI3D_MODEL;

/** Whether a finished model can be refined here: a mesh (not a splat or a rig), with the photo it came from, on an install that runs open models. */
export function canRefine(o: { glb?: string; photo?: string; splat?: unknown; rigged?: boolean; refined?: boolean; openAllowed: boolean }): boolean {
  return !!o.glb && !!o.photo && !o.splat && !o.rigged && !o.refined && o.openAllowed;
}
