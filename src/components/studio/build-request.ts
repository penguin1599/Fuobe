/**
 * The run a composer's draft asks for (what Generate sends): its own module, so a test can build the run an example's
 * draft makes (tests/examples-catalog.test.ts) the way the composer does.
 */
import type { Engine, GenerationRequest, GenParams, MediaKind, Operation } from "@/lib/catalog/types";
import type { FrameSupport } from "@/lib/catalog/keyframes";
import { framesRequest, layoutRequest } from "@/lib/composer";
import type { InbetweenTiming } from "@/lib/inbetween";
import type { SlotValue } from "./media-slot";
import type { Draft } from "./studio-context";

/** Frames mode, as the request needs it: what the model does with frames, the clip's length, and whether it's the open chain. */
export interface FramesContext {
  support: FrameSupport;
  duration: number;
  chained: boolean;
  /** Keyframe animation (Fuobe Animation): each gap's timing, fitted to the frames and the engine. */
  animation?: { timing: InbetweenTiming };
}

/**
 * The draft's keyframe-animation settings (params.extra.inbetween, stillMouth) go only with an animation: after Animation
 * is turned off or another model is picked they stay in the draft (to come back to) but are not sent to that model.
 */
function withoutAnimation(params: GenParams, animating: boolean): GenParams {
  const extra = params.extra;
  if (animating || !extra || !("inbetween" in extra || "stillMouth" in extra)) return params;
  const { inbetween: _i, stillMouth: _s, ...rest } = extra;
  return { ...params, extra: Object.keys(rest).length ? rest : undefined };
}

export function buildRequest(
  feature: string,
  draft: Pick<Draft, "slots" | "refs" | "presetId" | "modelId" | "prompt" | "negativePrompt" | "params" | "presetOptions" | "presetStrength" | "mix" | "frames" | "layout" | "refClips" | "refAudios">,
  op: Operation | undefined,
  promptSuffix?: string,
  refKind: MediaKind = "image",
  frames?: FramesContext,
  /**
   * The model's needs: a Fuobe Original (runs on both engines) names the engine switched to; a model that takes
   * looks (Fuobe Soul) takes the look's strength with its default look too (no presetId); a model with a References mode on
   * your GPU (MiniMax H3: Pika H3 Flex) takes the reference clips and voice or music clips.
   */
  target: { engine?: Engine; looks?: boolean; refs?: boolean } = {},
): GenerationRequest {
  const s = draft.slots;
  const refs = draft.refs.filter((x) => !!x?.ref).map((x) => x.ref);
  let images = [s.image, s.image2, s.image3].filter((x): x is SlotValue => !!x?.ref).map((x) => x.ref).concat(refKind === "image" ? refs : []);
  const videos = refKind === "video" ? refs : target.refs && !draft.frames ? (draft.refClips ?? []).filter((x) => !!x?.ref).map((x) => x.ref) : [];
  const audios = target.refs && !draft.frames ? (draft.refAudios ?? []).filter((x) => !!x?.ref).map((x) => x.ref) : [];
  let endImage = s.endImage?.ref || undefined;
  let params = withoutAnimation(draft.params, !!(draft.frames && frames?.animation));
  let pinned = op;
  // Frames mode: the stills in order at their times (or the first and last as start and end frame), at the strip's length.
  if (draft.frames && frames) {
    const sent = framesRequest(draft.frames, frames);
    images = sent.images;
    endImage = sent.endImage;
    params = { ...params, ...sent.params, ...(frames.animation && { extra: { ...params.extra, inbetween: frames.animation.timing } }) };
    pinned = op ?? sent.op;
  }
  // Layout mode: the boxes ride as params.extra.layout, captioned with the prompt; the plan compiles them for the model.
  if (draft.layout) params = layoutRequest(draft.layout, draft.prompt, params).params;
  return {
    feature,
    presetId: draft.presetId,
    modelId: draft.modelId,
    op: pinned,
    prompt: promptSuffix && draft.prompt.trim() ? `${draft.prompt.trim().replace(/[.\s]+$/, "")}. ${promptSuffix}` : draft.prompt,
    negativePrompt: draft.negativePrompt || undefined,
    inputs: {
      images: images.length ? images : undefined,
      endImage,
      mask: s.mask?.ref || undefined,
      sketch: s.sketch?.ref || undefined,
      voiceAudio: s.voiceAudio?.ref || undefined,
      voiceAudio2: s.voiceAudio2?.ref || undefined,
      video: s.video?.ref || undefined,
      audio: s.audio?.ref || undefined,
      videos: videos.length && !draft.frames ? videos : undefined,
      audios: audios.length ? audios : undefined,
    },
    params,
    presetOptions: draft.presetOptions,
    ...((draft.presetId || target.looks) && draft.presetStrength !== undefined && draft.presetStrength < 1 && { presetStrength: draft.presetStrength }),
    ...(draft.presetId && draft.mix && { mix: draft.mix }),
    ...(target.engine && { engine: target.engine }),
  };
}

