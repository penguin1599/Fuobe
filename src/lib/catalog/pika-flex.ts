import { H3_FLEX_GRAPH } from "@/lib/comfy-variants";
import { MINIMAX_H3_LICENCE, type CharacterLicence } from "./character-swap";
import type { LoraRef } from "./types";

/**
 * Pika H3 Flex on your GPU (Pika-Labs/Pika-H3-Flex at 3ff16644, open on 2026-10-29): Pika's post-trained MiniMax H3 as two
 * Comfy-format adapters on the pruned int8 H3 base, 6 steps. FL2VA for words and first / last frames (MiniMax H3's Quality →
 * Fast · Pika Flex), Ref2VA for references (images, clips, voice or music clips) and Talk from a voice clip. The graphs load
 * the adapter themselves; a run downloads the pinned file when ComfyUI lacks it. No cloud service hosts Pika H3 Flex: fal's
 * MiniMax H3 LoRA routes take adapters but run their own step count, not Pika's 6-step schedule (docs/research/new-models-10.md).
 */

const REVISION = "3ff166447d5edb1406107ab8370c42000ce173e4";
const BASE = `https://huggingface.co/Pika-Labs/Pika-H3-Flex/resolve/${REVISION}/comfy/loras`;

/** Pika's NOTICE, kept with the adapters (the MiniMax H3 Community License asks for it). */
export const PIKA_FLEX_NOTICE =
  "MiniMax H3 is licensed under the MiniMax H3 Community License Agreement, Copyright © 2026 MiniMax. All Rights Reserved. " +
  "FL2VA and Ref2VA adapters Copyright © 2026 Mellis, Inc. These adapters are Model Derivatives of MiniMax H3 and are distributed under the " +
  "MiniMax H3 Community License Agreement. Files modified from MiniMax H3 carry notices stating that they have been modified.";

const licence = { commercial: true, hostedOk: true, snapshotDate: "2026-11-02", name: "MiniMax H3 Community License" } as const;

export const PIKA_FLEX_FL2VA: LoraRef = { file: "pika_h3_flex_fl2va_comfy_bf16.safetensors", url: `${BASE}/pika_h3_flex_fl2va_comfy_bf16.safetensors`, version: REVISION, licence };
export const PIKA_FLEX_REF2VA: LoraRef = { file: "pika_h3_flex_ref2va_comfy_bf16.safetensors", url: `${BASE}/pika_h3_flex_ref2va_comfy_bf16.safetensors`, version: REVISION, licence };

/** The references graph (Ref2VA: References and Talk from a voice clip). */
export const PIKA_FLEX_REF_WORKFLOW = "minimax-h3-flex-ref2va";

/** The adapter a route's graph loads itself for this run (the route's endpoint, before Quality picks the Flex graph). */
export function pikaFlexGraphLoras(endpoint: string, extra: Record<string, unknown> | undefined): LoraRef[] {
  if (endpoint === PIKA_FLEX_REF_WORKFLOW) return [PIKA_FLEX_REF2VA];
  if (Object.values(H3_FLEX_GRAPH).includes(endpoint)) return [PIKA_FLEX_FL2VA];
  if (H3_FLEX_GRAPH[endpoint] && extra?.quality === "flex" && extra.orbit !== true) return [PIKA_FLEX_FL2VA];
  return [];
}

/** Pika's adapters and their terms, as Settings → Models & licences lists them (on by default, like everything). */
export const PIKA_FLEX_LICENCE: CharacterLicence = {
  ...MINIMAX_H3_LICENCE,
  item: "Pika H3 Flex FL2VA and Ref2VA adapters (Mellis, Inc.)",
  notices: [...(MINIMAX_H3_LICENCE.notices ?? []), PIKA_FLEX_NOTICE],
  note: `Model Derivatives of MiniMax H3 under the MiniMax H3 Community License (keep Pika's NOTICE and LICENSE with the files). ${MINIMAX_H3_LICENCE.note}. Pika's example code is Apache-2.0`,
};

export const PIKA_FLEX_LORAS: { file: string; name: string; url: string; licence: CharacterLicence }[] = [
  { file: PIKA_FLEX_FL2VA.file, name: "Pika H3 Flex FL2VA (6 steps; words, first and last frames)", url: PIKA_FLEX_FL2VA.url!, licence: PIKA_FLEX_LICENCE },
  { file: PIKA_FLEX_REF2VA.file, name: "Pika H3 Flex Ref2VA (6 steps; images, clips and voice references)", url: PIKA_FLEX_REF2VA.url!, licence: PIKA_FLEX_LICENCE },
];
