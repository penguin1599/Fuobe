/**
 * The check before Run (public sign-up): an account whose own GPU at a web address didn't answer its last status check
 * (the status strip's, every 30 s; nothing here asks the GPU) sees what is wrong and its fixes above Generate, instead
 * of starting a run that can only wait. When one of its keys runs the tool's cloud version, "Run with your fal.ai key"
 * is offered too: an explicit click, because it spends the person's own credit. Pure, for the composer and its tests.
 */
import { dualEngine } from "./catalog/engines";
import type { Engine, GenerationRequest } from "./catalog/types";
import { withKeyAction, type Diagnosis, type TroubleAction } from "./diagnose";
import { cloudVersionKey, type CloudProvider } from "./your-keys";

type Routed = { id: string; engine: string; engines?: Engine[]; routes: { provider: string }[] };

export interface BeforeRunViewer {
  kind: "guest" | "account";
  gpu: { connected: boolean; mode?: "computer" | "link"; online?: boolean; trouble?: Pick<Diagnosis, "cause" | "words" | "actions" | "retryable" | "details"> };
  keys?: CloudProvider[];
  paidAllowed?: boolean;
}

/** What the composer shows before Run: the plain sentence, a details line, and the buttons (Retry never: no run yet). */
export interface BeforeRun {
  words: string;
  details?: string;
  actions: TroubleAction[];
}

/** The words when the status check gave no reason (an older answer). */
export const GPU_OFF_WORDS = "Your GPU isn't answering right now.";

/**
 * The check before Run, or null when there is nothing to say: not an account, the tool doesn't run on its own GPU (a
 * cloud model, the Cloud engine, this studio's GPUs), its GPU isn't a web address (this computer and a paired ComfyUI
 * have their own notes), or the GPU answered.
 */
export function gpuBeforeRun(o: {
  viewer: BeforeRunViewer | undefined;
  model: Routed | undefined;
  engine: Engine;
  /** The run goes to this studio's GPUs (hosted runs), not the account's own. */
  onPool?: boolean;
  preset?: Parameters<typeof cloudVersionKey>[0];
  has: (id: string) => boolean;
  getModel: (id: string) => Routed | undefined;
}): BeforeRun | null {
  const { viewer, model } = o;
  if (viewer?.kind !== "account" || !model || o.onPool) return null;
  // A Fuobe Original runs where the engine switch says; any other model on its own engine.
  const toOwnGpu = dualEngine(model) ? o.engine === "open" : model.engine === "open";
  const gpu = viewer.gpu;
  if (!toOwnGpu || !gpu.connected || gpu.mode !== "link" || gpu.online !== false) return null;
  const key = viewer.paidAllowed !== false ? cloudVersionKey(o.preset, model, viewer.keys ?? [], o.has, o.getModel) : null;
  const base: TroubleAction[] = gpu.trouble?.actions ?? [
    { kind: "check-gpu", label: "Check my GPU" },
    { kind: "gpu-settings", label: "Open Settings → Your GPU", target: "/settings#your-gpu" },
  ];
  return {
    words: gpu.trouble?.words ?? GPU_OFF_WORDS,
    ...(gpu.trouble?.details && { details: gpu.trouble.details }),
    actions: [...base.filter((a) => a.kind !== "retry" && a.kind !== "run-with-key"), ...(key ? [withKeyAction(key)] : [])],
  };
}

/**
 * A failed run's request again, on the cloud version its trouble names ("Run with your fal.ai key"): the same words and
 * inputs on the cloud engine. A preset's open-graph settings (`extra`) stay behind when the model changes.
 */
export function onCloudKey(request: GenerationRequest, a: Pick<TroubleAction, "modelId" | "op">): GenerationRequest {
  const modelId = a.modelId ?? request.modelId;
  if (modelId === request.modelId) return { ...request, engine: "cloud" };
  const { extra: _extra, ...params } = request.params ?? {};
  void _extra;
  return { ...request, engine: "cloud", modelId, params, ...(a.op && { op: a.op as GenerationRequest["op"] }) };
}
