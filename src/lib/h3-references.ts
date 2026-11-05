import type { ModelDef } from "@/lib/catalog/types";
import type { ComfyWorkflow } from "@/lib/comfy";

/**
 * MiniMax H3 with references on your GPU (Pika H3 Flex Ref2VA, the minimax-h3-flex-ref2va graph): the limits Pika publishes,
 * the order the prompt cites them in, and the graph's reference loaders for one run. Pure, so the studio (checks before
 * anything is uploaded), the server and the tests share it.
 */

/** Pika's accepted input limits for Ref2VA (the model card, 3ff16644). */
export const H3_REFERENCE_LIMITS = {
  images: 9,
  videos: 3,
  audios: 3,
  /** Reference files in all (a clip's own sound is not a file of its own). */
  total: 12,
  /** Each clip or audio clip, in seconds. */
  minSec: 2,
  maxSec: 15,
  /** The clips together, and the audio clips together, in seconds. */
  groupSec: 15,
} as const;

/**
 * The References mode a model has on your GPU (MiniMax H3: Pika H3 Flex Ref2VA): how many images, clips and voice or music
 * clips it takes, or null. A cloud model's references go through its own field map instead.
 */
export function openReferenceMode(model: ModelDef | undefined): { images: number; videos: number; audios: number } | null {
  if (!model || model.engine !== "open") return null;
  if (!model.routes.some((r) => r.op === "ref2v" && r.provider === "comfyui")) return null;
  const o = model.options;
  if (!o.maxVideos && !o.maxAudios) return null;
  return { images: o.maxImages ?? 1, videos: o.maxVideos ?? 0, audios: o.maxAudios ?? 0 };
}

export interface H3References {
  images: number;
  /** Each clip's length in seconds (undefined: not known yet). */
  videos: (number | undefined)[];
  /** Each audio clip's length in seconds (undefined: not known yet). */
  audios: (number | undefined)[];
}

const fmt = (s: number) => `${Math.round(s * 10) / 10} s`;

/** What is wrong with a set of references, in words for the person, or null when Pika's limits hold. */
export function h3ReferenceProblem(r: H3References): string | null {
  const L = H3_REFERENCE_LIMITS;
  if (r.images === 0 && r.videos.length === 0) return "Add at least one image or clip as a reference";
  if (r.images > L.images) return `Use up to ${L.images} reference images`;
  if (r.videos.length > L.videos) return `Use up to ${L.videos} reference clips`;
  if (r.audios.length > L.audios) return `Use up to ${L.audios} voice or music clips`;
  if (r.images + r.videos.length + r.audios.length > L.total) return `Use up to ${L.total} references in all`;
  const groups = [
    { list: r.videos, one: "Clip", all: "The clips" },
    { list: r.audios, one: "Voice", all: "The voice and music clips" },
  ];
  for (const g of groups) {
    for (const [i, s] of g.list.entries()) {
      if (s === undefined) continue;
      if (s < L.minSec) return `${g.one} ${i + 1} is ${fmt(s)}: references need at least ${L.minSec} s`;
      if (s > L.maxSec + 0.05) return `${g.one} ${i + 1} is ${fmt(s)}: trim it to ${L.maxSec} s or less`;
    }
    const sum = g.list.reduce<number>((a, s) => a + (s ?? 0), 0);
    if (sum > L.groupSec + 0.05) return `${g.all} add up to ${fmt(sum)}: keep them to ${L.groupSec} s together`;
  }
  return null;
}

/** The names the studio shows and the prompt can cite, in order: Image 1, Image 2, Clip 1, Voice 1. */
export function h3ReferenceLabels(r: { images: number; videos: number; audios: number }): string[] {
  const out: string[] = [];
  for (let i = 1; i <= r.images; i++) out.push(`Image ${i}`);
  for (let i = 1; i <= r.videos; i++) out.push(`Clip ${i}`);
  for (let i = 1; i <= r.audios; i++) out.push(`Voice ${i}`);
  return out;
}

const TAG: Record<string, string> = { image: "Picture", picture: "Picture", photo: "Picture", clip: "Video", video: "Video", voice: "Audio", audio: "Audio", music: "Audio", sound: "Audio" };

/**
 * The studio's names as H3's reference tags: "Image 2" → <Picture 2>, "Clip 1" → <Video 1>, "Voice 1" / "Music 1" /
 * "Audio 1" → <Audio 1>. Tags already written (<Picture 1>) and words that aren't a name with a number stay as they are.
 */
export function h3ReferenceTags(words: string): string {
  return words.replace(/(<)?\b(image|picture|photo|clip|video|voice|audio|music|sound)\s+(\d{1,2})\b(>)?/gi, (m, open: string | undefined, kind: string, n: string, close: string | undefined) =>
    open || close ? m : `<${TAG[kind.toLowerCase()]} ${n}>`,
  );
}

/**
 * Talk from a voice clip (Lipsync & avatars, Fuobe Speak on H3): one image and one voice clip as references, and the words
 * about how they act. H3 makes a new clip with the voice as its sound; it is generation, not a re-sync of existing footage.
 */
export function h3TalkPrompt(words: string): string {
  const how = words.trim();
  return `The person in <Picture 1> talks to the camera, speaking exactly the words of <Audio 1> in that voice, lips in sync with it.${how ? ` ${h3ReferenceTags(how)}` : ""}`;
}

export interface H3ReferenceFiles {
  /** ComfyUI file names, in order. */
  images: string[];
  videos: string[];
  audios: string[];
  /** Whether each clip has its own sound (its header): only those feed ref_video_audios. Unknown counts as yes. */
  videoSound?: (boolean | undefined)[];
}

/** The graph's node that takes the references, and the loader of Image 1 it holds. */
const REF_NODE = "MiniMaxH3ReferenceToVideo";

/**
 * The Ref2VA graph with one loader per reference, in order: images on ref_images.ref_image_N (the graph's own loader is
 * Image 1, taken out when there is no image), clips at 24 fps up to 15 s (VideoHelperSuite) on ref_videos.ref_video_N with
 * their own sound on ref_video_audios.ref_video_audio_N, and audio clips on ref_audios.ref_audio_N.
 */
export function expandH3References(wf: ComfyWorkflow, files: H3ReferenceFiles): ComfyWorkflow {
  const out = JSON.parse(JSON.stringify(wf)) as ComfyWorkflow;
  const refId = Object.keys(out).find((k) => out[k].class_type === REF_NODE);
  if (!refId) throw new Error("This graph has no reference node");
  const ref = out[refId];
  const problem = h3ReferenceProblem({ images: files.images.length, videos: files.videos.map(() => undefined), audios: files.audios.map(() => undefined) });
  if (problem) throw new Error(problem);
  const first = ref.inputs["ref_images.ref_image_0"];
  const firstId = Array.isArray(first) ? String(first[0]) : undefined;
  for (const k of Object.keys(ref.inputs)) if (/^ref_(images|videos|video_audios|audios)\./.test(k)) delete ref.inputs[k];
  files.images.forEach((name, i) => {
    const id = i === 0 && firstId ? firstId : `ref_image_${i}`;
    out[id] = { class_type: "LoadImage", inputs: { image: name }, _meta: { title: `Image ${i + 1}` } };
    ref.inputs[`ref_images.ref_image_${i}`] = [id, 0];
  });
  if (!files.images.length && firstId) delete out[firstId];
  files.videos.forEach((name, i) => {
    const id = `ref_video_${i}`;
    out[id] = {
      class_type: "VHS_LoadVideo",
      inputs: { video: name, force_rate: 24, custom_width: 0, custom_height: 0, frame_load_cap: H3_REFERENCE_LIMITS.maxSec * 24, skip_first_frames: 0, select_every_nth: 1, format: "None" },
      _meta: { title: `Clip ${i + 1}` },
    };
    ref.inputs[`ref_videos.ref_video_${i}`] = [id, 0];
    if (files.videoSound?.[i] !== false) ref.inputs[`ref_video_audios.ref_video_audio_${i}`] = [id, 2];
  });
  files.audios.forEach((name, i) => {
    const id = `ref_audio_${i}`;
    out[id] = { class_type: "LoadAudio", inputs: { audio: name }, _meta: { title: `Voice ${i + 1}` } };
    ref.inputs[`ref_audios.ref_audio_${i}`] = [id, 0];
  });
  return out;
}
