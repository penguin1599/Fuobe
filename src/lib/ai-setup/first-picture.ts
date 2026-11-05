/**
 * "Make your first picture": the end of "Set it up with my AI". A small, fast picture model made on the person's own
 * GPU, from a prompt that holds only what the picture shows. Pure (the catalog is data).
 */
import { getModel } from "@/lib/catalog";
import type { GenerationRequest } from "@/lib/catalog/types";
import type { Badge } from "@/lib/gpu/types";

/** Small, fast text-to-image models, best first. None of them needs a licence click or a token to download. */
export const FIRST_PICTURE_MODELS = ["oss-z-image-turbo", "oss-krea2-turbo", "oss-sdxl", "oss-flux1-schnell"] as const;
export type FirstModel = (typeof FIRST_PICTURE_MODELS)[number];

export const isFirstModel = (v: unknown): v is FirstModel => typeof v === "string" && (FIRST_PICTURE_MODELS as readonly string[]).includes(v);

/** Their names, as the panel and the status say them (a fixed table: nothing from the person's ComfyUI). */
export const FIRST_MODEL_NAME: Record<FirstModel, string> = {
  "oss-z-image-turbo": "Z-Image Turbo",
  "oss-krea2-turbo": "Krea 2 Turbo",
  "oss-sdxl": "SDXL",
  "oss-flux1-schnell": "FLUX.1 schnell",
};

/** Its workflow in workflows/comfyui (the files the guide lists for the download). */
export const FIRST_MODEL_WORKFLOW: Record<FirstModel, string> = {
  "oss-z-image-turbo": "z-image-turbo-t2i",
  "oss-krea2-turbo": "krea2-turbo-t2i",
  "oss-sdxl": "sdxl-t2i",
  "oss-flux1-schnell": "flux1-schnell-t2i",
};

/** The graphics memory each needs, as the guide says it. */
export const FIRST_MODEL_FITS: Record<FirstModel, string> = {
  "oss-z-image-turbo": "for a GPU with 12 GB or more",
  "oss-krea2-turbo": "for a GPU with 20 GB or more",
  "oss-sdxl": "for a GPU with 8 GB or more",
  "oss-flux1-schnell": "for a GPU with 16 GB or more",
};

export const FIRST_PICTURE_PROMPT =
  "Editorial fashion portrait of a model in a sculpted ivory wool coat, soft window light, warm stone studio backdrop, 85mm lens, crisp fabric detail, calm confident expression";

/** The order to suggest a download in: a GPU with less than 14 GB gets SDXL first (it fits in 8 GB). */
export function modelOrder(vramGb?: number): FirstModel[] {
  const all = [...FIRST_PICTURE_MODELS];
  if (vramGb !== undefined && vramGb < 14) return ["oss-sdxl", ...all.filter((m) => m !== "oss-sdxl")];
  return all;
}

/** What the person's ComfyUI has for a first picture, from the readiness badges (useGpuBadges). */
export type FirstModelState =
  | { state: "checking" }
  | { state: "ready"; model: FirstModel }
  /** One download makes it ready: `gbTenths` its size in tenths of a GB. */
  | { state: "download"; model: FirstModel; gbTenths: number }
  /** None of them can run on this GPU. */
  | { state: "none" };

export function firstModelOf(badges: { connected: boolean; models: Record<string, Badge>; vramGb?: number } | undefined): FirstModelState {
  if (!badges?.connected || !Object.keys(badges.models).length) return { state: "checking" };
  const badge = (m: FirstModel) => badges.models[`${m}#t2i`];
  const ready = FIRST_PICTURE_MODELS.find((m) => badge(m)?.[0] === "r");
  if (ready) return { state: "ready", model: ready };
  const order = modelOrder(badges.vramGb);
  const near = order.find((m) => badge(m)?.[0] === "a");
  if (near) return { state: "download", model: near, gbTenths: badge(near)![2] };
  return { state: "none" };
}

/** The finish's frame: a portrait, when the model makes one. */
export const FIRST_PICTURE_ASPECT = "4:5";

/** The run: one portrait picture at the model's smallest size, its own defaults, on the person's GPU. */
export function firstPictureRequest(modelId: FirstModel): GenerationRequest {
  const model = getModel(modelId);
  const smallest = model?.options?.resolutions?.[0];
  const portrait = model?.options?.aspectRatios?.includes(FIRST_PICTURE_ASPECT);
  return {
    feature: "image",
    modelId,
    op: "t2i",
    prompt: FIRST_PICTURE_PROMPT,
    engine: "open",
    params: { ...(model?.defaults ?? {}), numOutputs: 1, ...(portrait && { aspectRatio: FIRST_PICTURE_ASPECT }), ...(smallest && { resolution: smallest }) },
  };
}

/** Where "Keep creating" goes: the Image studio, with the same model and words. */
export const keepCreatingHref = (modelId: FirstModel) => `/image?model=${encodeURIComponent(modelId)}&prompt=${encodeURIComponent(FIRST_PICTURE_PROMPT)}`;
