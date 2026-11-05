import "server-only";
import crypto from "node:crypto";
import { getModel } from "@/lib/catalog";
import { controlSets } from "@/lib/catalog/plan";
import { COMPANION_GRAPHS, resolveWorkflowId } from "@/lib/comfy-variants";
import { PROMPT_HELPER_FILES, PROMPT_HELPER_PARAM } from "@/lib/comfy";
import { fixPlan } from "@/lib/gpu/plan";
import { CLEAN_VAE, DECODER_PARAM, GPU_PARAM } from "@/lib/qwen21-speed";
import { H3_TIER_PARAM, H3_UNET_PARAM, withTierFile } from "@/lib/gpu/h3-tier";
import { cardLabel, needTargets, toolReadiness } from "@/lib/gpu/readiness";
import { GPU_NEED_TEXT } from "@/lib/gpu/rtx";
import type { FileKey, FixPlan, ToolReadiness, ToolRef } from "@/lib/gpu/types";
import type { GenerationRequest, GenParams } from "@/lib/catalog/types";
import { authEnabled, crossSite, hostAllowed, validToken } from "../auth";
import { loadIndex, preflightOn } from "./index-file";
import { contextFor } from "./readiness-service";
import { probe, readSnapshot } from "./snapshots";
import { presetTool, modelTool } from "./tools";
import { urlHash, type GpuTarget } from "./target";

/**
 * The check before a run (SPEC §13.1, review 9c): a ComfyUI run that is sure to fail for something missing is
 * stopped before it is queued, with the plan that fixes it (409 "gpu-setup"). It never blocks when the check is
 * unknown or failed (R11), when only graphics memory is short (R7), or when the request says gpuCheck "skip".
 * It blocks only on what a live read just confirmed, and in P1 only for accounts: the owner gets a warning.
 */

export const GPU_SETUP_HEADER = "x-fuobe-gpu-setup";

export interface GateInput {
  request: GenerationRequest;
  route: { provider: string; endpoint: string };
  op: string;
  modelId: string;
  /** Qwen-Image 2.1's Options → GPU as the run's plan decided it (previewGeneration's gpu): the graph checked is the one it runs. */
  gpu?: string;
  /** MiniMax H3's tier and the card's file as the run's plan decided them (previewGeneration's h3): the graph and file checked are the ones it runs. */
  h3?: { gpuTier: string; unet?: string };
  skip?: boolean;
  actor: string;
}

export type GateResult = { ok: true; warning?: string } | { ok: false; ref: ToolRef; plan: FixPlan; message: string };

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Needs that stop a run (a licence comes with its download; VRAM is never a need). */
const blocks = (r: ToolReadiness) => r.state === "unsupported" || r.needs.some((n) => n.kind !== "hf-licence");

/** The decoder file a run's options pick (Options → Decoder through the model's own control sets), or one the request names. */
export function pickedDecoder(modelId: string, extra: Record<string, unknown>): unknown {
  const model = getModel(modelId);
  const decoded = model ? controlSets(model, { extra } as GenParams).extra : undefined;
  return decoded?.vae ?? (extra[DECODER_PARAM] === "clean" ? CLEAN_VAE : extra.vae);
}

export async function gateGeneration(t: GpuTarget, g: GateInput): Promise<GateResult> {
  if (!preflightOn() || g.skip || g.route.provider !== "comfyui" || t.kind === "none") return { ok: true };
  let idx = loadIndex();
  const req = g.request;
  const has = (id: string) => !!idx.workflows[id];
  const extra: Record<string, unknown> = {
    ...req.params?.extra,
    ...(g.gpu && { [GPU_PARAM]: g.gpu }),
    ...(g.h3 && { [H3_TIER_PARAM]: g.h3.gpuTier, ...(g.h3.unet && { [H3_UNET_PARAM]: g.h3.unet }) }),
  };
  const id = resolveWorkflowId(g.route.endpoint, {
    op: g.op,
    clips: req.inputs?.videos?.length ?? 0,
    images: req.inputs?.images?.length ?? 0,
    format: req.params?.format,
    audio2: !!req.inputs?.audio2 || !!req.params?.extra?.audio2,
    audio: !!req.inputs?.audio,
    mask: !!req.inputs?.mask,
    extra,
    has,
  });
  if (!has(id)) return { ok: true };
  // A decoder an option picks (Qwen-Image 2.1's "Clean" Texture-Fix VAE, MiniMax H3's Fast decode) is an optional file of the
  // graph: this run needs it. The request carries the option's value ({ decoder: "clean" }); the model's control turns it into
  // the file the run loads, as the plan does (controlSets), so the gate checks the same file.
  const picked = pickedDecoder(g.modelId, extra);
  const vae: FileKey | undefined = typeof picked === "string" ? `vae/${picked}` : undefined;
  if (vae && idx.files[vae] && idx.workflows[id].optional.includes(vae) && !idx.workflows[id].files.includes(vae)) {
    idx = { ...idx, workflows: { ...idx.workflows, [id]: { ...idx.workflows[id], files: [...idx.workflows[id].files, vae] } } };
  }
  // MiniMax H3's FastH3 graphs load the card's own file (NVFP4 on Blackwell, fp8 without CUDA 13): that file is needed instead.
  const unet = extra[H3_UNET_PARAM];
  idx = withTierFile(idx, id, typeof unet === "string" ? unet : undefined);
  // Other optional files of the graph this run picks are needed too: a file a control's setting names (Kandinsky 6.0's
  // Quality "pro" sets unet to the Pro transformer), and the file an opt-in Prompt helper loads when it is on.
  const runFiles = new Set<FileKey>();
  const model = getModel(g.modelId);
  const set = model ? (controlSets(model, { ...req.params, extra }).extra ?? {}) : extra;
  const named = new Set(Object.values(set).filter((v): v is string => typeof v === "string"));
  for (const k of idx.workflows[id].optional ?? []) if (idx.files[k] && named.has(idx.files[k].file)) runFiles.add(k);
  if (PROMPT_HELPER_FILES[id] && extra[PROMPT_HELPER_PARAM] === "on") runFiles.add(PROMPT_HELPER_FILES[id] as FileKey);
  const add = [...runFiles].filter((k) => idx.files[k] && !idx.workflows[id].files.includes(k));
  if (add.length) idx = { ...idx, workflows: { ...idx.workflows, [id]: { ...idx.workflows[id], files: [...idx.workflows[id].files, ...add] } } };
  // The graph that runs, and the ones its next step is sure to run (the Watermark Remover's scan checks its removal too).
  const ids = [id, ...(COMPANION_GRAPHS[id] ?? []).filter(has)];
  // The preset's route on the run's model (the one its preview was made with, or its own): its LoRAs are checked too.
  const preset = req.presetId ? presetTool(req.presetId, { modelId: g.modelId }) : null;
  const tool = modelTool(g.modelId, g.op);
  const ref: ToolRef = preset?.ref ?? tool?.ref ?? `workflow:${id}`;
  const name = preset?.name ?? tool?.name ?? id;
  const loras = preset?.loras ?? tool?.loras ?? [];
  const ctx = { ...contextFor(t), kind: tool?.kind };
  let snap = readSnapshot(t);
  if (!snap?.inventory.reachable) return { ok: true };
  let r = toolReadiness(ref, name, ids, loras, snap.inventory, idx, ctx, tool?.cloud);
  if (!blocks(r)) return { ok: true };
  // A ComfyUI on the person's computer is read by their tab, which checks the tool right before the run: only a check
  // from the last 10 s counts as confirmed (an older one never blocks; ComfyUI's own answer has the last word).
  if (t.via === "browser") {
    if (Date.now() - snap.checkedAt > 10_000) return { ok: true };
  } else if (Date.now() - snap.checkedAt > 10_000 && r.state !== "unsupported") {
    // Confirm with a live read of just these classes and folders, unless the snapshot is from the last 10 s.
    const fresh = await probe(t, { actor: g.actor, ...needTargets(r.needs, idx), loraNames: loras.map((l) => l.file) }).catch(() => null);
    if (!fresh?.reachable) return { ok: true };
    snap = readSnapshot(t);
    if (!snap?.inventory.reachable) return { ok: true };
    r = toolReadiness(ref, name, ids, loras, snap.inventory, idx, ctx, tool?.cloud);
    if (!blocks(r)) return { ok: true };
  }
  const dev = snap.inventory.devices[0];
  const plan = fixPlan(r, snap.inventory, idx, { hash: sha256, urlHash: urlHash(t), account: ctx.account, loras, gpu: cardLabel(dev) });
  const what =
    r.state === "unsupported"
      ? r.gpuNeed
        ? GPU_NEED_TEXT[r.gpuNeed].replace(/^Needs/, "needs")
        : "needs a second ComfyUI"
      : `needs ${r.needs.filter((n) => n.kind !== "hf-licence").length} more thing${r.needs.length > 1 ? "s" : ""} on your ComfyUI`;
  // A card that can't run it: no setup step helps, so the run stops even on the install's own ComfyUI.
  if (r.gpuNeed) return { ok: false, ref, plan, message: `${name} ${what}. Pick another choice for this tool.` };
  if (t.key === "install") return { ok: true, warning: `${name} ${what}. Open Connect your GPU to see them.` };
  return { ok: false, ref, plan, message: `${name} ${what} before it can run.` };
}

/**
 * The checks every pre-flight route that sends traffic makes (review 7): a person, in a browser, on this site.
 * Not an API token; not another website; the browser says the request comes from this site's own page.
 */
export function interactiveRefusal(request: Request): string | null {
  if (validToken(request.headers.get("authorization"))) return "API tokens can't start a GPU check. Open Fuobe in your browser.";
  const host = request.headers.get("host") ?? new URL(request.url).host;
  if (crossSite(request, host)) return "Blocked a request from another website.";
  const site = request.headers.get("sec-fetch-site");
  if (site ? site !== "same-origin" : !request.headers.get("origin")) return "Start the check from Fuobe's own page.";
  if (!authEnabled() && !hostAllowed(host)) return "Blocked a request for an address this studio isn't reached at.";
  return null;
}
