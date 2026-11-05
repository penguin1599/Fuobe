/**
 * Every LoRA a run can load, with its licence as information: the library's, the preset LoRA map's files that aren't
 * library files (the round-1 Wan LoRAs camera motions and effects load), the Character swap's, Pika H3 Flex's, Open-H3
 * Regenerate's and MiniMax H3's 2K draft's.
 * Settings → Models & licences lists them with a switch each (src/server/model-access.ts) and Thanks & licences lists
 * them for everyone (src/lib/thanks.ts). Pure data, no I/O.
 */
import { getPreset } from "./catalog";
import { CHARACTER_LORAS, MINIMAX_H3_LICENCE } from "./catalog/character-swap";
import { LORA_LIBRARY, MOTION_EFFECT_LORAS } from "./catalog/lora-library.generated";
import { libraryEntry } from "./catalog/loras";
import { OSS_LORAS, type OssLora } from "./catalog/oss-loras.generated";
import { PIKA_FLEX_LORAS } from "./catalog/pika-flex";
import { H3_TURBO_4STEP_INFO, H3_TURBO_4STEP_LORA, REGEN_FILES, REGEN_LORA } from "./catalog/regenerate";
import { licenceInfo, loraLicenceInfo, modelCardOf, type LicenceInfo } from "./licences";
import type { LoraInfo } from "./model-access";

/** Open-H3 Regenerate's merged LoRA: MiniMax H3's terms (restricted regions), with what its merged parts carry. */
export function regenLoraLicence(): LicenceInfo {
  const { name, class: cls, url, excludes, notices } = MINIMAX_H3_LICENCE;
  return { name, class: cls, url: modelCardOf(REGEN_LORA.url) ?? url, note: REGEN_FILES[0].note, ...(excludes && { excludes }), ...(notices?.length && { notices }) };
}

/** lightx2v's Turbo 4-step v1.2 (MiniMax H3's 2K draft): Apache-2.0 in its card at the pinned revision. */
export function turbo4StepLicence(): LicenceInfo {
  return { ...licenceInfo("Apache-2.0"), url: H3_TURBO_4STEP_INFO.url, note: H3_TURBO_4STEP_INFO.note };
}

/** A Character swap LoRA's licence as the list shows it (its own recorded terms, its pinned model card). */
export function characterLoraLicence(l: Pick<(typeof CHARACTER_LORAS)[number], "licence" | "url">): LicenceInfo {
  const { name, class: cls, url, excludes, notices, note } = l.licence;
  return { name, class: cls, url: modelCardOf(l.url) ?? url, note, ...(excludes && { excludes }), ...(notices?.length && { notices }) };
}

/** The presets a map key names: a map v2 preset id, or a round-1 slug (the motion, effect or app it matches). */
const presetsOf = (key: string) => (getPreset(key) ? [getPreset(key)!] : ["motion", "effect", "app"].flatMap((k) => getPreset(`${k}-${key}`) ?? []));

/** A map LoRA's name as its download names it: the Hugging Face repo ("Remade-AI/Crane_up" → "Crane up"), else its file. */
function mapLoraName(l: OssLora): string {
  const repo = l.url && /^https:\/\/huggingface\.co\/[^/]+\/([^/]+)\//.exec(l.url)?.[1];
  return (repo || l.file.replace(/\.safetensors$/i, "")).replace(/[_-]+/g, " ").trim();
}

/** Every LoRA with its licence; `off` lists the files switched off in Settings (everything is on without it). */
export function loraLicenceRows(off: readonly string[] = []): LoraInfo[] {
  const on = (file: string) => !off.includes(file);
  const rows: LoraInfo[] = LORA_LIBRARY.map((e) => {
    const row = MOTION_EFFECT_LORAS.find((r) => r.loras.includes(e.key));
    const hold = row?.status === "licence-hold" ? "The research holds this licence: its Hugging Face and civitai pages disagree" : undefined;
    return { file: e.file, name: e.name, group: e.group, base: e.base, licence: loraLicenceInfo(e.licence, e.page, hold), on: on(e.file) };
  });
  const map = new Map<string, { ref: OssLora; keys: string[] }>();
  for (const [key, refs] of Object.entries(OSS_LORAS)) {
    for (const ref of refs) {
      if (libraryEntry(ref)) continue;
      const hit = map.get(ref.file);
      if (hit) hit.keys.push(key);
      else map.set(ref.file, { ref, keys: [key] });
    }
  }
  for (const [file, { ref, keys }] of map) {
    const presets = [...new Map(keys.flatMap(presetsOf).map((p) => [p.id, p])).values()];
    const motion = presets.length ? presets.every((p) => p.id.startsWith("motion-")) : keys.every((k) => k.startsWith("motion-"));
    const used = presets.length ? `In the preset LoRA map: ${presets.map((p) => p.name).join(", ")}` : "In the preset LoRA map";
    rows.push({ file, name: mapLoraName(ref), group: motion ? "motion" : "effect", base: ref.base, licence: loraLicenceInfo(ref.licence, modelCardOf(ref.url), used), on: on(file) });
  }
  // The LoRAs the Character swap's graphs load (and fal's route takes): Akatz Labs' swap LoRA and lightx2v's Turbo.
  for (const l of CHARACTER_LORAS) rows.push({ file: l.file, name: l.name, group: "adapter", base: "MiniMax H3", licence: characterLoraLicence(l), on: on(l.file) });
  // Pika H3 Flex's two adapters (MiniMax H3 on your GPU: Fast · Pika Flex, References, Talk from a voice clip).
  for (const l of PIKA_FLEX_LORAS) rows.push({ file: l.file, name: l.name, group: "adapter", base: "MiniMax H3", licence: characterLoraLicence(l), on: on(l.file) });
  // The refiner LoRA Open-H3 Regenerate's graph loads (and a run downloads).
  rows.push({ file: REGEN_LORA.file, name: REGEN_FILES[0].item, group: "adapter", base: "MiniMax H3", licence: regenLoraLicence(), on: on(REGEN_LORA.file) });
  // The Turbo 4-step LoRA MiniMax H3's 2K draft loads (off: the draft runs on H3's own graph and the finish redraws its clip).
  rows.push({ file: H3_TURBO_4STEP_LORA.file, name: H3_TURBO_4STEP_INFO.name, group: "adapter", base: "MiniMax H3", licence: turbo4StepLicence(), on: on(H3_TURBO_4STEP_LORA.file) });
  return rows;
}
