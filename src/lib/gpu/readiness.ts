import { compareVersions, formatBytes, nameKey, splitKey, vramGb } from "./requirements";
import { cardFits, GPU_NEED_TEXT, readCard, type GpuNeed } from "./rtx";
import type { Badge, FileKey, GpuInventory, IndexFile, InventorySummary, Need, Readiness, RequirementIndex, ToolReadiness, ToolRef, VramFit } from "./types";

/**
 * What can run on a viewer's ComfyUI (SPEC §7, review items 9 and 15). Pure: the same code runs on the
 * server (tunnel mode) and in the browser. A fact the probe didn't read never counts as missing, so an
 * unread class or folder never blocks a run (R11); VRAM only warns (R7).
 */

/** Worst first. */
const RANK: Readiness[] = ["unknown", "unsupported", "gpu", "setup", "almost", "ready"];
export const worse = (a: Readiness, b: Readiness): Readiness => (RANK.indexOf(a) <= RANK.indexOf(b) ? a : b);
export const rankOf = (s: Readiness): number => RANK.indexOf(s);

/** ComfyUI's device names: "cuda:0 NVIDIA GeForce RTX 4070 : cudaMallocAsync" → "NVIDIA GeForce RTX 4070". */
export function deviceLabel(name: string | undefined): string {
  return (name ?? "")
    .replace(/^(cuda|xpu|mps|cpu)(:\d+)?\s+/i, "")
    .replace(/\s*:\s*(cudaMallocAsync|native|[a-z]+Alloc\w*)\s*$/i, "")
    .trim();
}

/**
 * A graphics card's name for words that say "your …" (a fix plan's gpu): only a CUDA or Intel card, never ComfyUI's bare
 * "cpu" or "mps" device names.
 */
export function cardLabel(d: { name: string; type: string } | undefined): string | undefined {
  if (!d || (d.type !== "cuda" && d.type !== "xpu")) return undefined;
  const n = deviceLabel(d.name);
  return n && !/^(cpu|mps|cuda|xpu)(:\d+)?$/i.test(n) ? n : undefined;
}

/** The short name people use: "NVIDIA GeForce RTX 4070" → "RTX 4070". */
export function shortGpu(name: string | undefined): string {
  return deviceLabel(name).replace(/^(NVIDIA\s+)?(GeForce\s+)?/i, "").trim() || "GPU";
}

/** Extensions ComfyUI's folder listings show (supported_pt_extensions). */
const LISTED = /\.(ckpt|pt|pt2|bin|pth|safetensors|pkl|sft)$/i;

export type FileState = "present" | "partial" | "missing" | "unknown" | "unobservable";

/** Is this index file on that ComfyUI: by its loader's combo list first, then the folder listing. */
export function filePresence(f: IndexFile, inv: GpuInventory): FileState {
  if (f.presence === "unobservable") return "unobservable";
  const listing = inv.models[f.listFolder ?? f.folder];
  const size = listing && !listing.folderMissing ? listing.have[f.file] : undefined;
  const short = typeof size === "number" && f.sizeBytes > 0 && size < 0.99 * f.sizeBytes;
  if (f.presence === "loader") {
    let said: boolean | undefined;
    for (const [cls, input] of f.loaders ?? []) {
      const combo = inv.combos[`${cls}.${input}`];
      if (combo) said = said || combo.includes(f.file);
    }
    if (said === true) return short ? "partial" : "present";
    if (said === false) return "missing";
  }
  // No loader read: the folder listing decides, for the files a listing can show.
  if (size !== undefined) return short ? "partial" : "present";
  if (!LISTED.test(f.file)) return "unknown";
  if (listing) return "missing";
  return "unknown";
}

const FOLDER_LABEL: Record<string, string> = {
  diffusion_models: "Main model",
  checkpoints: "Main model",
  unet: "Main model",
  text_encoders: "Text reader",
  clip: "Text reader",
  vae: "Decoder",
  loras: "Speed or style file (LoRA)",
  clip_vision: "Image reader",
  audio_encoders: "Audio reader",
  upscale_models: "Upscaler",
  latent_upscale_models: "Upscaler",
  model_patches: "Model patch",
  frame_interpolation: "Frame interpolator",
  background_removal: "Background remover",
  optical_flow: "Motion reader",
  geometry_estimation: "Depth reader",
};

export function fileLabel(folder: string, kind?: string): string {
  const base = FOLDER_LABEL[folder];
  if (base === "Main model" && kind) return `${kind[0].toUpperCase()}${kind.slice(1)} model`;
  return base ?? "Model file";
}

/** "ComfyUI-KJNodes" → "KJNodes". */
export const packLabel = (name: string) => (name === "fuobe-live" ? "Fuobe live nodes" : name.replace(/^ComfyUI[-_]/i, "").replace(/[-_]/g, " "));

export interface ReadinessContext {
  /** An account's own GPU (isolated workflows aren't supported there yet). */
  account: boolean;
  /** A ComfyUI on someone's own computer, which their Fuobe tab runs (it reaches no second ComfyUI yet). */
  computer?: boolean;
  /** The owner has an isolated worker set up. */
  isolatedUrl?: boolean;
  /** The tool's output kind, for labels ("Video model"). */
  kind?: string;
}

export interface WorkflowReadiness {
  state: Readiness;
  needs: Need[];
  have: Need[];
  vram: ToolReadiness["vram"];
  firstRun: string[];
  unvalidated: boolean;
  unobservable: string[];
  reason?: string;
  /** Unsupported because the card isn't the NVIDIA RTX one its nodes need. */
  gpuNeed?: GpuNeed;
}

/** Whether the ComfyUI runs on its CPU (no device, --cpu, or a device that isn't a graphics card): its "VRAM" is system RAM. */
const onCpu = (inv: GpuInventory) => {
  const d = inv.devices[0];
  return !d || !!inv.comfy?.flags.cpuOnly || !(d.type === "cuda" || d.type === "mps" || d.type === "xpu");
};

/**
 * Whether this ComfyUI's card runs nodes that need `need` (an NVIDIA RTX card): false on a CPU, an Apple, AMD or Intel
 * device or a card whose name says it isn't one; undefined when nothing was read or the name doesn't tell (never blocks).
 */
export function gpuFits(need: GpuNeed, inv: GpuInventory): boolean | undefined {
  const d = inv.devices[0];
  if (inv.comfy?.flags.cpuOnly) return false;
  if (!d) return undefined;
  return cardFits(need, readCard(d.name, d.type));
}

/** The graphics card's memory in GB as the check reads it (rounded: vramGb), undefined on a CPU or with no reading. */
export function gpuVramGb(inv: GpuInventory): number | undefined {
  return onCpu(inv) ? undefined : vramGb(inv.devices[0]?.vramTotal);
}

export function vramFit(needGb: number, inv: GpuInventory): ToolReadiness["vram"] {
  const d = inv.devices[0];
  const cpu = onCpu(inv);
  const haveGb = gpuVramGb(inv) ?? 0;
  const apple = !cpu && d?.type === "mps";
  let fit: VramFit;
  if (!needGb) fit = "any";
  else if (haveGb >= needGb) fit = "fits";
  else if (haveGb >= 0.66 * needGb) fit = "tight";
  else fit = "no";
  return { needGb, haveGb, fit, ...(apple && { apple: true }) };
}

function fileNeed(key: FileKey, f: IndexFile, kind: "model" | "model-replace", ctx: ReadinessContext): Need {
  return {
    key: `file:${key}`,
    kind,
    label: fileLabel(f.folder, ctx.kind),
    detail: `${f.file} → models/${f.folder}`,
    sizeBytes: f.sizeBytes,
    file: key,
  };
}

/** SPEC §7.1, one workflow. */
export function workflowReadiness(id: string, inv: GpuInventory, idx: RequirementIndex, ctx: ReadinessContext): WorkflowReadiness {
  const w = idx.workflows[id];
  const base: WorkflowReadiness = { state: "unknown", needs: [], have: [], vram: { needGb: 0, fit: "any" }, firstRun: [], unvalidated: false, unobservable: [] };
  if (!w || !inv.reachable) return base;
  const out: WorkflowReadiness = { ...base, state: "ready", firstRun: w.firstRun, unvalidated: !w.validated, vram: vramFit(w.vramGb, inv) };
  if (w.isolated && ctx.computer) return { ...out, state: "unsupported", reason: "This one needs its own ComfyUI, so it can't run next to your other add-ons." };
  if (w.isolated && ctx.account) return { ...out, state: "unsupported", reason: "This one needs its own ComfyUI, so it can't run next to your other add-ons." };
  // The NVIDIA RTX Video nodes: only on an NVIDIA RTX card (frame generation: RTX 40 or later). A card the check can't
  // tell (no name, a data-centre card) isn't blocked.
  if (w.gpu && gpuFits(w.gpu, inv) === false) return { ...out, state: "unsupported", reason: GPU_NEED_TEXT[w.gpu], gpuNeed: w.gpu };
  if (w.isolated && !ctx.isolatedUrl) {
    out.needs.push({ key: "isolated-worker", kind: "isolated-worker", label: "A second ComfyUI (the isolated worker)", detail: "Some add-ons change process-wide settings, so they run on a separate ComfyUI." });
  }
  const missing = new Set(inv.nodes.missing);
  // Core classes: an older ComfyUI, or built-in nodes that didn't load (review 15).
  const core = w.core.filter((c) => missing.has(c));
  if (core.length) {
    const old = !!inv.comfy?.version && compareVersions(inv.comfy.version, idx.comfyui.min) < 0;
    out.needs.push(
      old
        ? { key: "core", kind: "comfy-update", label: `Update ComfyUI to ${idx.comfyui.min} or newer`, detail: `Missing built-in nodes: ${core.join(", ")}`, classes: core }
        : {
            key: "core",
            kind: "core-missing",
            label: "Some of ComfyUI's built-in nodes didn't load",
            detail: `Missing: ${core.join(", ")}. Look for IMPORT FAILED in the ComfyUI window.`,
            classes: core,
          },
    );
  }
  // Add-ons.
  const packNeeds = new Set<string>();
  for (const [name, classes] of Object.entries(w.packs)) {
    const gone = classes.filter((c) => missing.has(c));
    const label = `Add-on: ${packLabel(name)}`;
    if (!gone.length) {
      out.have.push({ key: `pack:${name}`, kind: "pack-install", label, detail: name, pack: name });
      continue;
    }
    const listed = inv.packs[name];
    let need: Need;
    if (gone.length < classes.length) need = { key: `pack:${name}`, kind: "pack-update", label: `Update add-on: ${packLabel(name)}`, detail: `${name} is an older version. Missing: ${gone.join(", ")}`, pack: name };
    else if (listed?.importError) need = { key: `pack:${name}`, kind: "pack-repair", label: `Repair add-on: ${packLabel(name)}`, detail: `${name} is installed but didn't start.`, pack: name, remote: listed.importError };
    else if (listed && listed.enabled) need = { key: `restart:${name}`, kind: "restart", label: "Restart ComfyUI", detail: `${name} was installed since ComfyUI last started.`, pack: name };
    else if (idx.packs[name]?.bundled) need = { key: `pack:${name}`, kind: "pack-install", label, detail: `${idx.packs[name].bundled}, a file Fuobe ships: download it into ComfyUI's custom_nodes folder.`, pack: name };
    else need = { key: `pack:${name}`, kind: "pack-install", label, detail: `${name} (${idx.packs[name]?.repo ?? "custom node pack"})`, pack: name };
    out.needs.push(need);
    if (need.kind !== "restart") packNeeds.add(name);
  }
  if (packNeeds.size) out.needs.push({ key: "restart", kind: "restart", label: "Restart ComfyUI", detail: "ComfyUI loads new add-ons when it starts." });
  // Files.
  for (const key of w.files) {
    const f = idx.files[key];
    if (!f) continue;
    const s = filePresence(f, inv);
    if (s === "unobservable") out.unobservable.push(f.file);
    else if (s === "present") out.have.push(fileNeed(key, f, "model", ctx));
    else if (s === "partial") out.needs.push({ ...fileNeed(key, f, "model-replace", ctx), detail: `${f.file} in models/${f.folder} is only partly downloaded` });
    else if (s === "missing") {
      out.needs.push(fileNeed(key, f, "model", ctx));
      if (f.gated) out.needs.push({ key: `licence:${key}`, kind: "hf-licence", label: "Accept the model's licence on Hugging Face", detail: f.url, file: key });
    }
    // "unknown": not read, so not missing.
  }
  return { ...out, state: stateOf(out.needs, out.vram.fit) };
}

/** Steps a person takes (a restart or a licence that comes with another step doesn't count; one pack and its restart is one). */
export function stepCount(needs: Need[]): number {
  const real = needs.filter((n) => n.kind !== "restart" && n.kind !== "hf-licence");
  if (real.length) return real.length;
  return needs.some((n) => n.kind === "restart") ? 1 : 0;
}

function stateOf(needs: Need[], fit: VramFit): Readiness {
  if (fit === "no") return "gpu";
  const steps = stepCount(needs);
  return steps === 0 ? "ready" : steps === 1 ? "almost" : "setup";
}

/** A preset's or recipe's LoRA, as the plan needs it (from LORA_LIBRARY or the OSS LoRA tables). */
export interface LoraNeed {
  file: string;
  url?: string;
  sizeBytes?: number;
  sha256?: string;
  download: "direct" | "civitai-token" | "hf-gated";
  page?: string;
}

export type LoraState = "present" | "missing" | "unknown";

export function loraPresence(l: LoraNeed, inv: GpuInventory): LoraState {
  const key = nameKey(inv.comfy?.os);
  if (Object.keys(inv.loras).some((n) => key(n) === key(l.file))) return "present";
  const folder = inv.models.loras;
  return folder && !folder.folderMissing ? "missing" : "unknown";
}

/** SPEC §7.2: one tool = the union of its workflows (and prestep), plus its LoRAs. */
export function toolReadiness(
  ref: ToolRef,
  name: string,
  workflowIds: string[],
  loras: LoraNeed[],
  inv: GpuInventory,
  idx: RequirementIndex,
  ctx: ReadinessContext,
  cloud?: { modelId: string },
): ToolReadiness {
  const out: ToolReadiness = { ref, name, state: "unknown", needs: [], have: [], downloadBytes: 0, vram: { needGb: 0, fit: "any" }, firstRun: [], unvalidated: false, unobservable: [] };
  if (cloud && !ctx.account) out.cloud = cloud;
  if (!inv.reachable) return out;
  const parts = workflowIds.map((id) => workflowReadiness(id, inv, idx, ctx)).filter((r, i) => !!idx.workflows[workflowIds[i]]);
  if (!parts.length) return out;
  const needs = new Map<string, Need>();
  const have = new Map<string, Need>();
  let needGb = 0;
  for (const p of parts) {
    if (p.state === "unsupported") return { ...out, state: "unsupported", reason: p.reason, vram: p.vram, ...(p.gpuNeed && { gpuNeed: p.gpuNeed }) };
    for (const n of p.needs) if (!needs.has(n.key)) needs.set(n.key, n);
    for (const h of p.have) if (!have.has(h.key)) have.set(h.key, h);
    needGb = Math.max(needGb, p.vram.needGb);
    out.firstRun.push(...p.firstRun.filter((x) => !out.firstRun.includes(x)));
    out.unobservable.push(...p.unobservable.filter((x) => !out.unobservable.includes(x)));
    out.unvalidated ||= p.unvalidated;
  }
  // A pack that needs installing makes its own "installed since the last start" restart line redundant.
  for (const [k, n] of needs) if (n.kind === "restart" && k !== "restart" && needs.has("restart")) needs.delete(k);
  for (const l of loras) {
    const s = loraPresence(l, inv);
    const key = `lora:${l.file}`;
    const need: Need = { key, kind: "lora", label: "Style file (LoRA)", detail: `${l.file} → models/loras`, ...(l.sizeBytes && { sizeBytes: l.sizeBytes }), lora: l.file };
    if (s === "present") have.set(key, need);
    else if (s === "missing" && !needs.has(key)) {
      needs.set(key, need);
      if (l.download === "hf-gated") needs.set(`licence:${key}`, { key: `licence:${key}`, kind: "hf-licence", label: "Accept the LoRA's licence on Hugging Face", detail: l.page ?? l.url ?? l.file, lora: l.file });
    }
  }
  for (const k of have.keys()) if (needs.has(k)) have.delete(k);
  out.needs = [...needs.values()];
  out.have = [...have.values()];
  out.downloadBytes = out.needs.filter((n) => n.kind === "model" || n.kind === "model-replace" || n.kind === "lora").reduce((a, n) => a + (n.sizeBytes ?? 0), 0);
  out.vram = vramFit(needGb, inv);
  // A graph that needs an NVIDIA RTX card (no VRAM figure published) never reads "Runs on any computer".
  if (out.vram.fit === "any" && workflowIds.some((id) => idx.workflows[id]?.gpu)) out.vram = { ...out.vram, fit: "fits" };
  out.state = stateOf(out.needs, out.vram.fit);
  return out;
}

/** The chip a tool gets (null: no chip, for an unknown state). */
export function badgeOf(t: ToolReadiness): Badge | null {
  const code = ({ ready: "r", almost: "a", setup: "s", gpu: "g", unsupported: "u" } as const)[t.state as Exclude<Readiness, "unknown">];
  if (!code) return null;
  // 8: needs an NVIDIA RTX card, 16: an RTX 40 series card or newer (the chip says so instead of "a second ComfyUI").
  const card = t.state === "unsupported" && t.gpuNeed ? (t.gpuNeed === "nvidia-rtx-40" ? 16 : 8) : 0;
  const flags = (t.vram.fit === "tight" ? 1 : 0) | (t.firstRun.length ? 2 : 0) | (t.vram.fit === "any" ? 4 : 0) | card;
  return [code, stepCount(t.needs), Math.round(t.downloadBytes / 1e8), flags];
}

export const BADGE_STATE: Record<Badge[0], Readiness> = { r: "ready", a: "almost", s: "setup", g: "gpu", u: "unsupported" };

/** "What you have installed and downloaded". */
export function summaryOf(inv: GpuInventory, idx: RequirementIndex): InventorySummary {
  const d = inv.devices[0];
  const missing = new Set(inv.nodes.missing);
  const have = new Set(inv.nodes.have);
  const packs = Object.values(idx.packs).filter((p) => p.classes.length > 0);
  const packsHave = packs.filter((p) => p.classes.every((c) => !missing.has(c) && (inv.nodes.how === "per-class" || have.has(c)))).length;
  const files = Object.values(idx.files);
  const present = files.filter((f) => filePresence(f, inv) === "present");
  const gpuName = d && (d.type === "cuda" || d.type === "mps" || d.type === "xpu") ? deviceLabel(d.name) : undefined;
  return {
    ...(gpuName && { gpu: gpuName }),
    ...(gpuName && vramGb(d.vramTotal) && { vramGb: vramGb(d.vramTotal) }),
    ...(inv.ram && { ramGb: vramGb(inv.ram.total) }),
    ...(inv.comfy?.version && { comfyVersion: inv.comfy.version }),
    manager: inv.manager.api === "none" ? "Manager off" : inv.manager.api === "unknown" ? "Manager not checked" : `Manager ${(inv.manager.version ?? "").replace(/^V/i, "")}`.trim(),
    packs: { have: packsHave, of: packs.length },
    files: { have: present.length, of: files.length, bytes: present.reduce((a, f) => a + f.sizeBytes, 0) },
  };
}

/** The line under a chip or a board row: "1 download · 12.3 GB", "Needs 24 GB", "Ready". */
export function stateLine(t: Pick<ToolReadiness, "state" | "needs" | "downloadBytes" | "vram" | "gpuNeed">): string {
  if (t.state === "ready") return t.vram.fit === "any" ? "Runs on any computer" : t.vram.fit === "tight" ? "Ready · slow on your GPU" : "Ready";
  if (t.state === "gpu") return `Needs ${t.vram.needGb} GB`;
  if (t.state === "unsupported") return t.gpuNeed ? GPU_NEED_TEXT[t.gpuNeed] : "Needs a second ComfyUI";
  if (t.state === "unknown") return "Not checked";
  const steps = stepCount(t.needs);
  const downloads = t.needs.filter((n) => n.kind === "model" || n.kind === "lora" || n.kind === "model-replace").length;
  const packs = t.needs.filter((n) => n.kind.startsWith("pack-")).length;
  const restart = t.needs.some((n) => n.kind === "restart");
  if (downloads && !packs && steps === downloads) return `${downloads} download${downloads > 1 ? "s" : ""} · ${formatBytes(t.downloadBytes)}`;
  if (packs && !downloads && steps === packs) return `${packs} add-on${packs > 1 ? "s" : ""}${restart ? " + restart" : ""}`;
  return `${steps} step${steps > 1 ? "s" : ""}${t.downloadBytes ? ` · ${formatBytes(t.downloadBytes)}` : ""}`;
}

/** The file keys and pack classes a tool's needs name (what a targeted re-check reads). */
export function needTargets(needs: Need[], idx: RequirementIndex): { classes: string[]; folders: string[] } {
  const classes = new Set<string>();
  const folders = new Set<string>();
  for (const n of needs) {
    if (n.pack) for (const c of idx.packs[n.pack]?.classes ?? []) classes.add(c);
    for (const c of n.classes ?? []) classes.add(c);
    if (n.file) {
      const f = idx.files[n.file];
      const { folder } = splitKey(n.file);
      folders.add(f?.listFolder ?? folder);
      for (const [cls] of f?.loaders ?? []) classes.add(cls);
    }
    if (n.lora) folders.add("loras");
  }
  return { classes: [...classes], folders: [...folders] };
}
