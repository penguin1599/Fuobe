import { offerOn, readCard, cardFits, type GpuNeed } from "@/lib/gpu/rtx";

/**
 * NVIDIA RTX Video on your GPU (docs/research/new-models-10.md §6, package nm10-rtx-video): Comfy-Org's ComfyUI Nvidia VFX
 * Nodes on NVIDIA's RTX Video SDK. Three open models: a fast upscale (Upscale → Video's "Quick · RTX"), frame generation
 * (FPS Boost, RTX 40 series or later) and SDR to HDR. They run only on an NVIDIA RTX card, so nobody hosts them: GPU-only,
 * never a cloud route, and never picked automatically on a card that isn't one (or one the name doesn't tell).
 */
export const RTX_UPSCALE_MODEL = "oss-rtx-video-upscale";
export const RTX_FRAMEGEN_MODEL = "oss-rtx-frame-generation";
export const RTX_HDR_MODEL = "oss-rtx-video-hdr";

export { RTX_UPSCALE_WORKFLOW } from "@/lib/av/video-finish";
export const RTX_FRAMEGEN_WORKFLOW = "fps-rtx-framegen";
export const RTX_HDR_WORKFLOW = "sdr-to-hdr-rtx";

/** The pack's node classes (ComfyUI_Nvidia_VFX_Nodes), as the GPU check lists them. */
export const RTX_CLASSES = ["RTXVideoSuperResolution", "RTXVideoFrameGeneration", "RTXTrueHDR"] as const;

/** The card each model needs. */
export const RTX_CARD: Record<string, GpuNeed> = {
  [RTX_UPSCALE_MODEL]: "nvidia-rtx",
  [RTX_FRAMEGEN_MODEL]: "nvidia-rtx-40",
  [RTX_HDR_MODEL]: "nvidia-rtx",
};

/** The card a model needs, or undefined for any other model. */
export const rtxCardOf = (modelId: string | undefined): GpuNeed | undefined => (modelId ? RTX_CARD[modelId] : undefined);

/** Visitor-facing words (plain product copy). */
export const RTX_COPY = {
  quick: "Quick · RTX",
  quickHint: "Fast and sharp on your NVIDIA RTX card. Adds no new detail.",
  /** Under the choice when the card can't run it. */
  needsCard: "Needs an NVIDIA RTX card",
  needsCard40: "Needs an NVIDIA RTX 40 series card or newer",
  /** Under the choice when Fuobe can't tell what the card is. */
  onRtx: "Runs on NVIDIA RTX cards",
  /** The line under a picked RTX model. */
  picked: "Free on your GPU · runs on NVIDIA's RTX video engine, so only on NVIDIA RTX cards.",
  picked40: "Free on your GPU · runs on NVIDIA's RTX video engine, so only on RTX 40 series cards and newer.",
};

/** When ComfyUI lacks the nodes: the owner's line names the install switch; a visitor's stays plain. */
export const RTX_MISSING = {
  owner: "Your ComfyUI is missing the NVIDIA RTX Video nodes: on a machine with an NVIDIA RTX card, run scripts/comfy/install-comfyui.sh (or RTX_VIDEO=1), then restart ComfyUI.",
  visitor: "Your ComfyUI doesn't have NVIDIA RTX Video yet. It needs an NVIDIA RTX card; add it with Fuobe's ComfyUI setup, then run this again.",
};

/** Words for a model's card need. */
export const needText = (need: GpuNeed): string => (need === "nvidia-rtx-40" ? RTX_COPY.needsCard40 : RTX_COPY.needsCard);

/**
 * How a choice that needs `need` stands on the viewer's card: "fits" (offer it first), "no" (show it switched off, saying
 * why) or "unknown" (no card read, or a name that doesn't tell: offer it last; it is never picked for anyone). `gpuName` is
 * the short name the GPU check reports; `blocked` is the model's own check (its chip says the card can't run it: a CPU, an
 * Apple, AMD or Intel device, or an older NVIDIA card).
 */
export function rtxStanding(need: GpuNeed, gpuName: string | undefined, blocked = false): "fits" | "no" | "unknown" {
  if (blocked) return "no";
  if (offerOn(need, gpuName)) return "fits";
  if (!gpuName) return "unknown";
  return cardFits(need, readCard(gpuName)) === false ? "no" : "unknown";
}
