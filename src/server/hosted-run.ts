import "server-only";
import crypto from "node:crypto";
import { nanoid } from "nanoid";
import type { GenerationRequest } from "@/lib/catalog/types";
import { OWN_GPU_TOOL_MESSAGE } from "@/lib/guest-access";
import { RTX_CLASSES, rtxCardOf } from "@/lib/catalog/rtx-video";
import { gpuFits } from "@/lib/gpu/readiness";
import { gpuState } from "./account-gpu";
import { accountGpu, type Account } from "./auth";
import {
  accountFacts,
  BILLING_HEADER,
  BILLING_PAUSED,
  billingConfigured,
  forgetBalance,
  policy as billingPolicy,
  quote as billingQuote,
  refusalStatus,
  reserve,
  type Policy,
  type Quote,
  type RefuseCode,
  type RunFacts,
} from "./billing";
import { outputKind, previewGeneration } from "./generations";
import { HOSTED_WORDS, inputCounts, poolAllowsRun, poolReady, queueFacts, runFacts, runOnPool } from "./hosted";
import { hostedRunsOn } from "./hosted-switch";
import { checkRun, moderationConfigured } from "./moderation";
import type { RunStamp } from "./run-stamp";
import { readRef } from "./storage";
import { readSnapshot } from "./gpu/snapshots";
import { ACCOUNT_LIMITS } from "./account-files";
import { runAsTenant } from "./tenant";

/**
 * The generations route's side of hosted runs (hosted.ts), the billing hook (billing.ts) and the moderation hook
 * (moderation.ts). With nothing set (no FUOBE_HOSTED_RUNS, no service addresses) none of it changes a run.
 */

/** What the client asked for: its own GPU, or this install's (a preference the server checks). */
export type PlaceWish = "own" | "pool" | undefined;

/** The client's preference and the price it showed, read from the body beside the request (never part of it). */
export function readWishes(body: unknown): { wish: PlaceWish; shown: { amount: number; priceVersion: string } | null } {
  const b = (body ?? {}) as { place?: unknown; shown?: unknown };
  const wish = b.place === "own" || b.place === "pool" ? b.place : undefined;
  const s = b.shown as { amount?: unknown; priceVersion?: unknown } | null | undefined;
  const shown =
    s && typeof s === "object" && Number.isFinite(s.amount) && Number(s.amount) >= 0 && typeof s.priceVersion === "string" && s.priceVersion.length <= 200
      ? { amount: Math.floor(Number(s.amount)), priceVersion: s.priceVersion }
      : null;
  return { wish, shown };
}

/** A refusal the route sends as it is. */
export interface Refusal {
  status: number;
  body: Record<string, unknown> & { error: string };
  headers: Record<string, string>;
}

const billingRefusal = (code: RefuseCode | "price-changed", text: string, extra: Record<string, unknown> = {}): Refusal => ({
  status: refusalStatus(code),
  body: { error: text, code, ...extra },
  headers: { [BILLING_HEADER]: code },
});

type Planned = ReturnType<typeof previewGeneration>;

/** The decision for an account's run: its own GPU or key as today, this install's GPUs, or a refusal. */
export type PlaceDecision = { kind: "own" } | { kind: "pool"; planned: Planned; policy: Policy } | { kind: "refuse"; refusal: Refusal };

/** Is the account's own GPU there to run now? */
async function ownGpuOnline(accountId: string): Promise<boolean> {
  const gpu = accountGpu(accountId);
  if (!gpu) return false;
  try {
    return (await gpuState(accountId, gpu)).online;
  } catch {
    return false;
  }
}

/**
 * A model that needs an NVIDIA RTX card (src/lib/catalog/rtx-video.ts) on this install's GPUs: refused when the install's
 * last GPU check says its card can't run it (a CPU, an Apple, AMD or Intel device, an older NVIDIA card) or its ComfyUI
 * lacks the RTX Video nodes. A card the name doesn't tell, or no check yet, never refuses (the run says what it finds).
 */
export function poolCardRefuses(modelId: string): boolean {
  const need = rtxCardOf(modelId);
  if (!need) return false;
  const inv = readSnapshot({ kind: "install", key: "install", via: "server" })?.inventory;
  if (!inv?.reachable) return false;
  return gpuFits(need, inv) === false || RTX_CLASSES.some((c) => inv.nodes.missing.includes(c));
}

/**
 * Where an account's run goes (hosted.ts has the order). Only with hosted runs on; otherwise always "own" (today).
 */
export async function decidePlace(account: Account, req: GenerationRequest, wish: PlaceWish): Promise<PlaceDecision> {
  if (!hostedRunsOn() || wish === "own" || !poolReady()) return { kind: "own" };
  let planned: Planned;
  try {
    planned = runOnPool(account.id, () => previewGeneration(req));
  } catch {
    // A paid model, a model switched off, a request with something wrong: today's path says what.
    return { kind: "own" };
  }
  if (planned.route.provider !== "comfyui") return { kind: "own" };
  const hasGpu = !!accountGpu(account.id);
  if (hasGpu && wish !== "pool" && (await ownGpuOnline(account.id))) return { kind: "own" };
  const p = await billingPolicy(account.id);
  if (!p) return { kind: "refuse", refusal: billingRefusal("paused", BILLING_PAUSED) };
  if (!p.hosted) return { kind: "own" };
  // From here on the run would be this install's: what it can't take there goes to the account's own GPU when it has one.
  const notHere = (error: string): PlaceDecision => (hasGpu && wish !== "pool" ? { kind: "own" } : { kind: "refuse", refusal: { status: 403, body: { error, code: "not-offered" }, headers: { [BILLING_HEADER]: "not-offered" } } });
  if (outputKind(planned.op, planned.model) === "model3d") return hasGpu && wish !== "pool" ? { kind: "own" } : { kind: "refuse", refusal: { status: 403, body: { error: OWN_GPU_TOOL_MESSAGE, code: "own-gpu-tool" }, headers: {} } };
  if (!poolAllowsRun(p, planned, req.presetId)) return notHere(HOSTED_WORDS.notOffered);
  if (poolCardRefuses(planned.model.id)) return notHere(HOSTED_WORDS.rtxCard);
  if (req.loras?.length) return notHere(HOSTED_WORDS.loras);
  const inputs = inputCounts(req);
  if ((inputs.image && !p.uploads.image) || (inputs.video && !p.uploads.video) || (inputs.audio && !p.uploads.audio)) return notHere(HOSTED_WORDS.inputs);
  return { kind: "pool", planned, policy: p };
}

/** The input files of a request, for the moderation service: their kind and sha256 (pictures' previews: not sent yet). */
async function inputFacts(accountId: string, req: GenerationRequest): Promise<{ n: number; kind: "image" | "video" | "audio"; sha256: string; preview: null }[]> {
  const i = req.inputs ?? {};
  const refs: [string | undefined, "image" | "video" | "audio"][] = [
    ...(i.images ?? []).map((r) => [r, "image"] as [string, "image"]),
    [i.endImage, "image"],
    [i.mask, "image"],
    [i.sketch, "image"],
    [i.video, "video"],
    ...(i.videos ?? []).map((r) => [r, "video"] as [string, "video"]),
    [i.audio, "audio"],
    [i.audio2, "audio"],
    [i.voiceAudio, "audio"],
    [i.voiceAudio2, "audio"],
    ...(i.audios ?? []).map((r) => [r, "audio"] as [string, "audio"]),
  ];
  const out: { n: number; kind: "image" | "video" | "audio"; sha256: string; preview: null }[] = [];
  for (const [ref, kind] of refs) {
    if (!ref) continue;
    try {
      const f = await runAsTenant({ kind: "account", id: accountId }, () => readRef(ref));
      out.push({ n: out.length, kind, sha256: crypto.createHash("sha256").update(f.data).digest("hex"), preview: null });
    } catch {
      // A file it can't read: the run says so when it is created.
    }
  }
  return out;
}

/**
 * The moderation service's check of an account's run (no service: allowed, nothing to stamp). A refusal costs nothing:
 * it comes before any hold.
 */
export async function moderateRun(
  account: Account,
  req: GenerationRequest,
  planned: Planned | null,
  place: "pool" | "own",
  /** A result made in the browser (no plan): what it is and where the account works. */
  browser?: { kind: RunFacts["kind"]; place: RunFacts["place"] },
): Promise<{ ok: true; checkOutputs: boolean } | { ok: false; refusal: Refusal }> {
  if (!moderationConfigured()) return { ok: true, checkOutputs: false };
  const kind = planned ? outputKind(planned.op, planned.model) : (browser?.kind ?? "image");
  const run = planned
    ? { ...runFacts(req, planned, kind), place: place === "pool" ? ("pool" as const) : planned.route.provider === "comfyui" ? ("own-gpu" as const) : ("own-key" as const) }
    : null;
  const a = await checkRun({
    requestId: nanoid(16),
    account: { id: account.id },
    run: run ?? { ...runFacts(req, { model: { id: req.modelId, kind, engine: "open" }, op: req.op ?? "", jobs: 1, outputs: 1, providerId: browser ? "local" : "", costUsd: null, loras: { applied: [] } }, kind), place: browser?.place ?? "own-gpu" },
    prompt: req.prompt ?? "",
    negative: req.negativePrompt ?? null,
    inputs: await inputFacts(account.id, req),
    consent: null,
  });
  if (a.allowed) return { ok: true, checkOutputs: a.checkOutputs !== false };
  const status = a.code === "paused" ? 503 : 403;
  return { ok: false, refusal: { status, body: { error: a.text, code: a.code }, headers: {} } };
}

/**
 * Set the run's price aside (no billing service: nothing to set aside; the run is free). Returns the stamp the run's
 * rows carry, or the refusal (402, 409 with the new price, 429, 503, 403; docs/billing-hook.md).
 */
export async function reservePool(account: Account, req: GenerationRequest, planned: Planned, shown: { amount: number; priceVersion: string } | null, checkOutputs: boolean): Promise<{ ok: true; stamp: RunStamp } | { ok: false; refusal: Refusal }> {
  const base: RunStamp = { place: "pool", ...(checkOutputs && { checkOutputs: true }) };
  if (!billingConfigured()) return { ok: true, stamp: base };
  const kind = outputKind(planned.op, planned.model);
  const a = await reserve({
    requestId: nanoid(16),
    account: accountFacts(account),
    run: runFacts(req, planned, kind),
    queue: queueFacts(account.id),
    shown: shown ?? { amount: 0, priceVersion: "" },
  });
  if (!a) return { ok: true, stamp: base };
  if (!a.ok) {
    return { ok: false, refusal: billingRefusal(a.code, a.text, { ...(a.quote && { quote: a.quote }), ...(a.action && { action: a.action }), ...(a.offer && { offer: a.offer }) }) };
  }
  forgetBalance(account.id);
  return { ok: true, stamp: { ...base, hold: a.holdId, ...(a.text && { charge: a.text }), ...(a.maxWaitMs > 0 && { waitMs: a.maxWaitMs }) } };
}

/**
 * A price check on this install's GPUs (hosted runs on): the plan there and the billing service's quote (no service:
 * free, and Run keeps its own words). Null when the run wouldn't go there (its own GPU, its own key, today's answer).
 */
export async function poolQuote(account: Account | null, asked: GenerationRequest, wish: PlaceWish): Promise<{ planned: Planned; quote: Quote } | null> {
  if (!hostedRunsOn() || wish === "own" || !poolReady()) return null;
  const p = account ? await billingPolicy(account.id) : null;
  // Priced for the outputs it would make: the studio's cap per run, and the billing service's when lower.
  const cap = Math.min(ACCOUNT_LIMITS.outputsPerRun, ...(billingConfigured() && p && p.limits.outputsPerRun > 0 ? [p.limits.outputsPerRun] : []));
  const req = (asked.params?.numOutputs ?? 1) > cap ? { ...asked, params: { ...asked.params, numOutputs: cap } } : asked;
  let planned: Planned;
  try {
    planned = runOnPool(account?.id ?? null, () => previewGeneration(req));
  } catch {
    return null;
  }
  if (planned.route.provider !== "comfyui") return null;
  if (account && wish !== "pool" && accountGpu(account.id) && (await ownGpuOnline(account.id))) return null;
  if (p && (!p.hosted || !poolAllowsRun(p, planned, req.presetId))) return null;
  if (poolCardRefuses(planned.model.id)) return null;
  const kind = outputKind(planned.op, planned.model);
  const q = await billingQuote(account ? accountFacts(account) : null, runFacts(req, planned, kind), queueFacts(account?.id ?? null));
  return { planned, quote: q };
}
