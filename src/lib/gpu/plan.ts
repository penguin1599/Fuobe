import { commandsFor, type CommandStep } from "./commands";
import type { LoraNeed } from "./readiness";
import type { FixPlan, FixStep, GpuInventory, Need, Readiness, RequirementIndex, StepKind, ToolReadiness, ToolRef, WhyCode } from "./types";

/**
 * A tool's fix plan (SPEC §8): its steps in run order, each with why it can't be one click and the commands
 * that do it by hand. P1 never installs anything: every step is manual, and `why` says what the one-click
 * path (P2, through ComfyUI-Manager) would hit. Only the server builds plans, from the index (R2).
 */

const ORDER: Record<StepKind, number> = {
  "manager-enable": 0,
  "manager-config": 1,
  "comfy-update": 2,
  "core-missing": 2,
  "pack-install": 3,
  "pack-update": 3,
  "pack-repair": 3,
  restart: 4,
  "hf-licence": 5,
  "civitai-key": 5,
  model: 6,
  "model-replace": 6,
  lora: 6,
  "isolated-worker": 7,
};

/** Minutes for `bytes` at 100 MB/s and at 25 MB/s, rounded up. */
export function etaRange(bytes: number): [number, number] {
  if (!bytes) return [0, 0];
  return [Math.max(1, Math.ceil(bytes / 100e6 / 60)), Math.max(1, Math.ceil(bytes / 25e6 / 60))];
}

/** What would stop this step being one click (SPEC §8.2); P1 does every step by hand. */
export function whyOf(n: Need, inv: GpuInventory | null, idx: RequirementIndex, lora?: LoraNeed): WhyCode {
  const api = inv?.manager.api ?? "unknown";
  const noManager = api === "none";
  switch (n.kind) {
    case "comfy-update":
      return "core-update";
    case "core-missing":
      return "core-missing";
    case "isolated-worker":
      return "isolated";
    case "hf-licence":
      return "gated";
    case "civitai-key":
      return "civitai-key";
    case "pack-install": {
      const p = n.pack ? idx.packs[n.pack] : undefined;
      if (noManager) return "no-manager";
      if (p?.subdir || p?.file) return "subfolder-pack";
      if (!p?.registry?.version) return "no-validated-version";
      return "manual-only";
    }
    case "model-replace":
      return "no-delete-api";
    case "model":
    case "lora": {
      if (lora?.download === "civitai-token") return "civitai-key";
      if (lora?.download === "hf-gated") return "gated";
      const f = n.file ? idx.files[n.file] : undefined;
      if (f?.gated) return "gated";
      if (noManager) return "no-manager";
      if (api === "v3") return "manager-v3-model-list";
      if (api === "v4" && inv?.comfy && !inv.comfy.flags.loopbackOnly) return "listen-all";
      return "manual-only";
    }
    default:
      return noManager ? "no-manager" : "manual-only";
  }
}

/** The page behind a Hugging Face resolve URL ("https://huggingface.co/<repo>"). */
export function hfPage(url: string | undefined): string | undefined {
  const m = url ? /^https:\/\/huggingface\.co\/((?:datasets\/)?[\w.-]+\/[\w.-]+)\//.exec(url) : null;
  return m ? `https://huggingface.co/${m[1]}` : undefined;
}

export interface PlanOptions {
  /** sha256 hex of a string (the server's). */
  hash: (s: string) => string;
  /** The target's address hash: a new address makes a new plan. */
  urlHash: string;
  /** An account: no "Use cloud" (it can't run on the owner's keys). */
  account: boolean;
  loras?: LoraNeed[];
  fits?: { ref: ToolRef; name: string; state: Readiness }[];
  gpu?: string;
}

export function fixPlan(t: ToolReadiness, inv: GpuInventory | null, idx: RequirementIndex, o: PlanOptions): FixPlan {
  const loras = new Map((o.loras ?? []).map((l) => [l.file, l]));
  const needs = [...t.needs].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  // A civitai LoRA needs the viewer's own key first.
  const civitai = needs.some((n) => n.lora && loras.get(n.lora)?.download === "civitai-token");
  if (civitai) needs.splice(needs.findIndex((n) => ORDER[n.kind] >= ORDER["civitai-key"]), 0, { key: "civitai-key", kind: "civitai-key", label: "Add your civitai API key", detail: "Some style files download from civitai, which needs a free account and its API key." });
  const steps: FixStep[] = needs.map((n, i) => {
    const lora = n.lora ? loras.get(n.lora) : undefined;
    const f = n.file ? idx.files[n.file] : undefined;
    const link = n.kind === "hf-licence" ? (lora?.page ?? hfPage(f?.url ?? n.detail)) : lora?.page;
    return { ...n, id: `s${i + 1}`, via: "manual", why: whyOf(n, inv, idx, lora), commands: { bash: "", powershell: "" }, ...(link && { link }) };
  });
  const cmdSteps: CommandStep[] = steps.map((s) => {
    const lora = s.lora ? loras.get(s.lora) : undefined;
    return { kind: s.kind, pack: s.pack, file: s.file, link: s.link, ...(lora && { lora: { file: lora.file, url: lora.url, download: lora.download, page: lora.page } }) };
  });
  const cmds = commandsFor(cmdSteps, { inv, idx });
  steps.forEach((s, i) => (s.commands = cmds.each[i]));
  // The hash covers what the steps would install, where from and at which version (R2: the fix route rebuilds and compares it).
  const parts = steps
    .map((s) => {
      const f = s.file ? idx.files[s.file] : undefined;
      const p = s.pack ? idx.packs[s.pack] : undefined;
      const l = s.lora ? loras.get(s.lora) : undefined;
      return [s.key, s.kind, f?.pinnedUrl, f?.sizeBytes, p?.commit, p?.registry?.version, l?.url].map((x) => x ?? "").join("|");
    })
    .sort();
  return {
    ref: t.ref,
    name: t.name,
    state: t.state,
    steps,
    have: t.have,
    downloadBytes: t.downloadBytes,
    etaMin: etaRange(t.downloadBytes),
    restart: steps.some((s) => s.kind === "restart"),
    oneClick: "none",
    why: inv?.manager.api === "none" ? "no-manager" : "manual-only",
    planHash: o.hash([o.urlHash, idx.hash, ...parts].join("\n")),
    commands: { bash: cmds.bash, powershell: cmds.powershell },
    vram: t.vram,
    firstRun: t.firstRun,
    unobservable: t.unobservable,
    alternatives: { ...(t.cloud && !o.account && { cloud: t.cloud }), ...(o.fits?.length && { fits: o.fits }) },
    ...(o.gpu && { gpu: o.gpu }),
    ...(t.state === "unsupported" && t.reason && { reason: t.reason }),
    ...(t.gpuNeed && { gpuNeed: t.gpuNeed }),
    ...(inv?.comfy?.os && { os: inv.comfy.os }),
  };
}
