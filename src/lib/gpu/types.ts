/**
 * GPU pre-flight: what each tool needs (the requirement index, built at build time from the workflow
 * library), what a viewer's ComfyUI has (the inventory a probe reads), and what can run there
 * (readiness, badges, fix plans). Shared by the server and the browser: no server-only imports.
 */

import type { GpuNeed } from "./rtx";

/** A model file as `folder/file` (the file's base name, never a subfolder). */
export type FileKey = `${string}/${string}`;

/**
 * How Fuobe can tell a file is there:
 * - "loader": the combo list of the node input that loads it (GET /object_info/{Class}), which is exactly
 *   what that ComfyUI can load (extra_model_paths, pack folders, any extension);
 * - "list": the folder listing (GET /experiment/models/{folder} or /models/{folder});
 * - "unobservable": neither shows it (a file a node pack reads by its own path). It never blocks a run.
 */
export type Presence = "loader" | "list" | "unobservable";

/** workflows/comfyui/requirements.json (scripts/comfy/build-requirements.mjs). */
export interface RequirementIndex {
  v: 1;
  /** sha256 of the content without this field: the ETag, and what a cached report was built with. */
  hash: string;
  comfyui: { min: string; testedCommit: string };
  /** Every models/<folder> a workflow needs. */
  folders: string[];
  /** The classes a full check reads one by one when GET /object_info is too big or too slow. */
  sentinels: string[];
  packs: Record<string, IndexPack>;
  files: Record<FileKey, IndexFile>;
  workflows: Record<string, IndexWorkflow>;
}

export interface IndexPack {
  repo: string;
  commit: string;
  /** A node file Fuobe ships itself (fuobe_live.py): Fuobe writes it into custom_nodes, nothing is cloned. */
  bundled?: string;
  /** Comfy Registry id; `version` is set only once the validator ran on that exact release (empty until then: manual). */
  registry?: { id: string; version: string };
  /** The node classes the library uses from it. */
  classes: string[];
  /** Model folders the pack registers when it loads (mmaudio, insightface…). */
  folders: string[];
  /** Runs on the isolated worker (a second ComfyUI). */
  isolated: boolean;
  /** A pack that lives in a subfolder of its repo (h3_character_swap). */
  subdir?: string;
  /**
   * A pack that is one node file in a Hugging Face model repo (Viggle's viggle_turbo.py, next to the LoRAs): downloaded
   * at the commit into custom_nodes/<name>/__init__.py, never cloned (the repo holds gigabytes of weights).
   */
  file?: string;
  requirementsTxt: boolean;
  /** Python packages installed by name, pinned (`segment-anything==1.0`), when its requirements.txt isn't safe to install. */
  pip?: string[];
  install: "registry" | "manual";
}

export interface IndexFile {
  folder: string;
  file: string;
  url: string;
  /** The URL pinned to the revision the index recorded (resolve/<sha>/…), or `url` when no pin is known yet. */
  pinnedUrl: string;
  sizeBytes: number;
  sha256?: string;
  /** A licence to accept on Hugging Face, and a token, before it downloads. */
  gated: boolean;
  /** The pack that registers this file's folder. */
  packFolder?: string;
  /** The name ComfyUI lists the folder under when its pack registers it as another (kandinsky6: audio_vae → kandinsky6_audio_vae). */
  listFolder?: string;
  presence: Presence;
  /** [class_type, input] of the loader nodes that pick this file (presence "loader"). */
  loaders?: [cls: string, input: string][];
}

export interface IndexWorkflow {
  /** Core node classes. */
  core: string[];
  /** Pack name → the pack's classes this workflow uses. */
  packs: Record<string, string[]>;
  /** Files the defaults need. */
  files: FileKey[];
  /** Alternatives a control can pick (not needed for the defaults). */
  optional: FileKey[];
  vramGb: number;
  isolated: boolean;
  /** Weights a pack downloads itself on the first run (free text from the manifest). */
  firstRun: string[];
  /** On a graph a real ComfyUI accepted. */
  validated?: true;
  /** The card its nodes need (the NVIDIA RTX Video nodes): checked against the GPU's name. */
  gpu?: GpuNeed;
}

// ---------------------------------------------------------------------------
// Inventory: what the viewer's ComfyUI has (only what the index asks about, R9)

export type GpuProblem = "unreachable" | "auth" | "not-comfy" | "timeout" | "cors-off" | "lna-blocked" | "redirect";

export interface ComfyFlags {
  listen: string | null;
  loopbackOnly: boolean;
  corsOrigin: string | null;
  enableManager: boolean;
  managerLegacyUi: boolean;
  lowvram: boolean;
  cpuOnly: boolean;
}

export interface GpuDevice {
  name: string;
  type: string;
  index: number;
  vramTotal: number;
  vramFree: number;
}

export type ManagerApi = "v4" | "v3" | "none" | "unknown";

export interface GpuInventory {
  v: 1;
  via: "server" | "browser";
  checkedAt: number;
  tookMs: number;
  reachable: boolean;
  problem?: GpuProblem;
  /** A short reason, in plain text (never shown as HTML). */
  problemDetail?: string;
  comfy?: {
    version: string;
    os: string;
    python?: string;
    torch?: string;
    embeddedPython: boolean;
    deployEnv: string;
    flags: ComfyFlags;
    /** folder → absolute paths (GET /experiment/models), for exact commands. */
    modelRoots?: Record<string, string[]>;
    apiPrefix?: "" | "/api";
  };
  devices: GpuDevice[];
  ram?: { total: number; free: number };
  manager: { api: ManagerApi; version?: string; legacyUi?: boolean; csrfPost?: boolean; busy?: boolean };
  /**
   * Index classes that are loaded, and those confirmed missing. A class in neither was not read (a per-class
   * check reads only some): it counts as there, so an unread class never blocks (R11).
   */
  nodes: { have: string[]; missing: string[]; total: number; readAt: number; how: "object_info" | "per-class" };
  /** "Class.input" → the index base names that loader lists (presence "loader"). */
  combos: Record<string, string[]>;
  /** Index pack name → what ComfyUI-Manager lists for it. */
  packs: Record<string, { dir: string; version?: string; enabled: boolean; importError?: string }>;
  /** folder → index base name → bytes (null: size unknown). */
  models: Record<string, { have: Record<string, number | null>; total: number; folderMissing?: boolean }>;
  /** Index LoRA base names that are present. */
  loras: Record<string, number | null>;
  /** sha256 of argv, devices, RAM and model roots (an owner-GPU heuristic, never a boundary). */
  fingerprint: string;
  /** Steps that failed: a partial inventory still counts. */
  errors: { step: string; message: string }[];
  /** The studio's own ComfyUI answered an anonymous request from the internet (install target only). */
  exposed?: boolean;
}

/** One line of the live checklist. */
export interface CheckLine {
  step: "found" | "gpu" | "models" | "addons" | "manager" | "match";
  state: "running" | "done" | "warn" | "fail";
  text: string;
  /** Plain-text detail shown under "Details". */
  detail?: string;
}

// ---------------------------------------------------------------------------
// Readiness: what can run

export type Readiness = "ready" | "almost" | "setup" | "gpu" | "unsupported" | "unknown";
export type VramFit = "any" | "fits" | "tight" | "no";

export type StepKind =
  | "manager-enable"
  | "manager-config"
  | "comfy-update"
  | "core-missing"
  | "pack-install"
  | "pack-update"
  | "pack-repair"
  | "restart"
  | "hf-licence"
  | "civitai-key"
  | "model"
  | "model-replace"
  | "lora"
  | "isolated-worker";

export interface Need {
  /** pack:<name> | file:<folder/file> | lora:<file> | core | restart | … (deduplicated across workflows). */
  key: string;
  kind: StepKind;
  label: string;
  /** Plain text: file names, folders, classes. */
  detail: string;
  sizeBytes?: number;
  pack?: string;
  file?: FileKey;
  lora?: string;
  /** The node classes it is about (missing core classes). */
  classes?: string[];
  /** Text read from the viewer's ComfyUI (a traceback): shown as plain text only. */
  remote?: string;
}

/** A tool: a model's operation, a preset, a studio's open default, one workflow. */
export type ToolRef = `model:${string}#${string}` | `preset:${string}` | `studio:${string}` | `workflow:${string}`;

export interface ToolReadiness {
  ref: ToolRef;
  name: string;
  state: Readiness;
  needs: Need[];
  have: Need[];
  downloadBytes: number;
  vram: { needGb: number; haveGb?: number; fit: VramFit; apple?: boolean };
  firstRun: string[];
  unvalidated: boolean;
  /** Files Fuobe can't see on this ComfyUI (they never block). */
  unobservable: string[];
  /** The same tool on the cloud engine (never offered to accounts). */
  cloud?: { modelId: string };
  /** Why it is unsupported (isolated workflows on an account's GPU, a card that isn't an NVIDIA RTX one). */
  reason?: string;
  /** Unsupported because the card isn't the one its nodes need (an NVIDIA RTX card). */
  gpuNeed?: GpuNeed;
}

export interface InventorySummary {
  gpu?: string;
  vramGb?: number;
  ramGb?: number;
  comfyVersion?: string;
  manager: string;
  packs: { have: number; of: number };
  files: { have: number; of: number; bytes: number };
}

export type StudioGroup = "Images" | "Video" | "Audio" | "Video tools";

export interface StudioRow {
  href: string;
  label: string;
  group: StudioGroup;
  tool: ToolReadiness;
  /** That studio's other open models that are ready or one step away. */
  others: { ref: ToolRef; name: string; state: Readiness }[];
  /** MiniMax H3's build on this card (FastH3 V2 or Trim, src/lib/gpu/h3-tier.ts), or why the full model is still needed. */
  gpuTier?: { label: string; note?: string };
}

export interface ReadinessReport {
  indexHash: string;
  checkedAt: number;
  summary: InventorySummary;
  studios: StudioRow[];
  /** Plain-text warnings for the board (the studio's own ComfyUI open to the internet…). */
  warnings: string[];
}

/** [state, steps, download size in tenths of a GB, flags]; flags: 1 tight, 2 first-run download, 4 runs on any computer. */
export type Badge = [state: "r" | "a" | "s" | "g" | "u", steps: number, gbTenths: number, flags: number];

export interface BadgeMap {
  connected: boolean;
  /** The pre-flight is switched off on this install (FUOBE_GPU_PREFLIGHT=0). */
  off?: boolean;
  checkedAt?: number;
  gpu?: string;
  vramGb?: number;
  /** MiniMax H3's smaller build this card runs on Auto ("fast" | "trim"; src/lib/gpu/h3-tier.ts), when the card is under 32 GB. */
  h3Tier?: "fast" | "trim";
  /** "<modelId>#<op>" → badge, for open models. A missing key means no chip. */
  models: Record<string, Badge>;
  presets: Record<string, Badge>;
}

// ---------------------------------------------------------------------------
// Fix plans (P1: manual commands only)

export type WhyCode =
  | "no-manager"
  | "manager-strict"
  | "listen-all"
  | "no-validated-version"
  | "subfolder-pack"
  | "gated"
  | "civitai-key"
  | "manager-v3-model-list"
  | "no-delete-api"
  | "core-update"
  | "core-missing"
  | "isolated"
  | "account-isolated"
  | "owner-gpu"
  | "installs-off"
  | "over-cap"
  | "manual-only";

export interface FixStep extends Need {
  id: string;
  via: "manager" | "helper" | "manual";
  why?: WhyCode;
  commands: { bash: string; powershell: string };
  /** A page to open first (a gated model's Hugging Face page, a LoRA's civitai page). */
  link?: string;
}

export interface FixPlan {
  ref: ToolRef;
  name: string;
  state: Readiness;
  steps: FixStep[];
  have: Need[];
  downloadBytes: number;
  etaMin: [number, number];
  restart: boolean;
  oneClick: "all" | "some" | "none";
  /** Why it can't be done in one click (P1: always manual). */
  why: WhyCode;
  planHash: string;
  commands: { bash: string; powershell: string };
  vram: ToolReadiness["vram"];
  firstRun: string[];
  unobservable: string[];
  alternatives: { cloud?: { modelId: string }; fits?: { ref: ToolRef; name: string; state: Readiness }[] };
  /** The viewer's GPU, for the copy ("Your RTX 4070 has 12 GB"). */
  gpu?: string;
  /** Why it can't run on this ComfyUI (state "unsupported"). */
  reason?: string;
  /** Unsupported because it needs an NVIDIA RTX card this one isn't. */
  gpuNeed?: GpuNeed;
  /** ComfyUI's OS ("nt", "posix"): which command tab comes first. */
  os?: string;
}
