/**
 * Connecting Fuobe to models, as pure logic shared by Settings, Home's first-run guide and the
 * connection test route: which settings each provider's test reads, what a well-formed key or
 * address looks like, when to offer the first-run guide, and each connection's one-line status.
 */
import { LLM_PROVIDERS } from "./catalog/llm-providers";
import { offered, type AccessSummary } from "./model-access";

export type TestProvider = "fal" | "replicate" | "comfyui" | "llm" | "civitai" | "huggingface" | "ai-toolkit";

/** The settings each provider's connection test reads; an unsaved value for one of them can be tested before it's saved. */
export const PROVIDER_SETTINGS = {
  fal: ["falKey"],
  replicate: ["replicateToken"],
  // comfyWhere "server": a server address tested while ComfyUI runs on the owner's computer is tested as a server.
  comfyui: ["comfyUrl", "comfyToken", "comfyIsolatedUrl", "comfyWhere", "worldcastUrl"],
  // Claude, and the local model servers of Settings → AI helper (Ollama, LM Studio, Unsloth Studio, any OpenAI-compatible one).
  llm: [
    "anthropicKey",
    "ollamaUrl",
    "ollamaModel",
    "enhanceProvider",
    "llmProvider",
    "lmstudioUrl",
    "lmstudioModel",
    "lmstudioToken",
    "unslothUrl",
    "unslothModel",
    "unslothKey",
    "llmUrl",
    "llmModel",
    "llmKey",
    "llmContext",
    // Assist's hosted providers: keys, regions and Qwen's workspace (src/lib/catalog/llm-providers.ts).
    "openaiKey",
    "openaiRegion",
    "googleKey",
    "xaiKey",
    "xaiRegion",
    "metaKey",
    "mistralKey",
    "cohereKey",
    "deepseekKey",
    "moonshotKey",
    "moonshotRegion",
    "zaiKey",
    "zaiRegion",
    "qwenKey",
    "qwenRegion",
    "qwenWorkspace",
    "minimaxKey",
    "minimaxRegion",
    "openrouterKey",
    "groqKey",
    "cerebrasKey",
    "togetherKey",
    "togetherRegion",
    "fireworksKey",
    "huggingfaceToken",
  ],
  // Not a model provider: the key that downloads a recipe's civitai LoRAs (Settings → LoRAs).
  civitai: ["civitaiKey"],
  // Nor this: the token that downloads gated Hugging Face LoRAs once their licence is accepted (Settings → LoRAs).
  huggingface: ["huggingfaceDownloadToken"],
  // Not a model provider either: the trainer Soul IDs and Fuobe looks train on, on your GPU (Settings → Training).
  "ai-toolkit": ["aiToolkitUrl", "aiToolkitToken", "aiToolkitDatasetDir"],
} as const satisfies Record<TestProvider, readonly string[]>;

export type ConnectionSetting = (typeof PROVIDER_SETTINGS)[TestProvider][number];

export const isTestProvider = (p: unknown): p is TestProvider => typeof p === "string" && Object.hasOwn(PROVIDER_SETTINGS, p);

/**
 * The unsaved values a test request carries, kept to the settings that provider's test reads:
 * `values` by setting name, or `value` for the provider's main one (its key, or ComfyUI's address).
 */
export function candidateValues(provider: TestProvider, values?: unknown, value?: unknown): Partial<Record<ConnectionSetting, string>> {
  const allowed: readonly ConnectionSetting[] = PROVIDER_SETTINGS[provider];
  const out: Partial<Record<ConnectionSetting, string>> = {};
  if (typeof value === "string") out[allowed[0]] = value.trim();
  if (values && typeof values === "object") {
    for (const [k, v] of Object.entries(values)) if (typeof v === "string" && allowed.includes(k as ConnectionSetting)) out[k as ConnectionSetting] = v.trim();
  }
  return out;
}

/** Where to get a civitai API key (Settings → LoRAs links to it). */
export const CIVITAI_KEYS_URL = "https://civitai.com/user/account";
/** Where to make a Hugging Face access token (a "Read" token is enough for gated downloads). */
export const HF_TOKENS_URL = "https://huggingface.co/settings/tokens";
/** Where to get a fal.ai key (the guide and Settings link to it). */
export const FAL_KEYS_URL = "https://fal.ai/dashboard/keys";
/** The ComfyUI address a local install listens on. */
export const DEFAULT_COMFY_URL = "http://127.0.0.1:8188";
/** Fuobe's source, for the install scripts and licences. */
export const FUOBE_REPO = "https://github.com/workingprototype/fuobe";
/** The credits and licence notices of the open models and code Fuobe runs (scripts/credits.mjs writes it). */
export const FUOBE_CREDITS = `${FUOBE_REPO}/blob/main/CREDITS.md`;
/** How to install ComfyUI with every node pack Fuobe's workflows use. */
export const COMFY_INSTALL_DOCS = `${FUOBE_REPO}/blob/main/scripts/comfy/README.md`;
export const COMFY_INSTALL_COMMAND = "bash scripts/comfy/install-comfyui.sh";
/** The address AI-Toolkit's UI (ostris/ai-toolkit) listens on, and where to get it. */
export const DEFAULT_AI_TOOLKIT_URL = "http://127.0.0.1:8675";
export const AI_TOOLKIT_REPO = "https://github.com/ostris/ai-toolkit";

/** key_id:key_secret, both halves present and no spaces. */
const KEY_PAIR = /^[^\s:]+:[^\s:]+$/;

function addressProblem(v: string, example: string): string | null {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? null : `Use an http:// or https:// address, like ${example}`;
  } catch {
    return /^[\w.-]+(:\d+)?(\/\S*)?$/.test(v) ? `Add http:// in front: http://${v}` : `That isn't a web address — try ${example}`;
  }
}

/**
 * What's wrong with a value typed into a connection field, said the way to fix it; null when it
 * looks right (or is empty, which clears it). A warning only: the test has the final word.
 */
export function settingProblem(name: string, raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  switch (name) {
    case "falKey":
      if (KEY_PAIR.test(v)) return null;
      return v.includes(":") ? "Both halves of key_id:key_secret are needed, without spaces — copy the key again" : "fal.ai keys look like key_id:key_secret — paste the whole key, with the part after the colon";
    case "replicateToken":
      return /^r8_\S+$/.test(v) ? null : "Replicate tokens start with r8_";
    case "anthropicKey":
      return /^sk-ant-\S+$/.test(v) ? null : "Anthropic keys start with sk-ant-";
    case "comfyUrl":
      return addressProblem(v, DEFAULT_COMFY_URL);
    case "comfyIsolatedUrl":
      return addressProblem(v, "http://127.0.0.1:8189");
    case "worldcastUrl":
      return addressProblem(v, "http://127.0.0.1:8190");
    case "ollamaUrl":
      return addressProblem(v, "http://127.0.0.1:11434");
    case "lmstudioUrl":
      return addressProblem(v, "http://127.0.0.1:1234");
    case "unslothUrl":
      return addressProblem(v, "http://127.0.0.1:8888");
    case "llmUrl":
      return addressProblem(v, "http://127.0.0.1:8080/v1");
    case "aiToolkitUrl":
      return addressProblem(v, DEFAULT_AI_TOOLKIT_URL);
    case "aiToolkitDatasetDir":
      return v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v) ? null : "Use a full path, like /mnt/shared/datasets";
    case "qwenWorkspace":
      return /^[a-z0-9-]{1,64}$/.test(v) ? null : "Use the workspace id from Model Studio's Workspace page (lowercase letters, digits and hyphens), not an address";
  }
  // An LLM provider's key: the format its docs give.
  const hint = LLM_PROVIDERS.find((p) => p.keySetting === name)?.keyHint;
  if (hint) return new RegExp(hint.pattern).test(v) ? null : hint.text;
  return null;
}

// ---------------------------------------------------------------------------
// What's connected

export type EngineModeName = "both" | "open" | "cloud";

export interface ConnectionState {
  providers: Record<string, { configured: boolean } | undefined>;
  engineMode: EngineModeName;
  /** The first-run guide was put away, or something this engine mode uses was connected once (Settings → `onboarded`). */
  onboarded?: boolean;
  /** Settings → "Show placeholder results (for a tour)": "on" makes every run a placeholder; "off" (the default) never. */
  demoMode?: string;
  /** The owner's ComfyUI runs on the owner's computer: what its Fuobe tab last said (GET /api/status). */
  ownerGpu?: OwnerGpuView;
}

/** The owner's computer, as its Fuobe tab last said (the same view as an account's "this computer"). */
export interface OwnerGpuView {
  mode: "computer";
  online: boolean;
  comfy?: "down" | "no-setting";
  guard?: boolean;
  device?: string;
  vramBytes?: number;
  version?: string;
  port?: number;
  cors?: "exact" | "any" | "other";
}

/** "Online", "ComfyUI not running", "Needs a setting" or "Offline": a computer's ComfyUI in a few words. */
export function computerWords(g: { online?: boolean; comfy?: "down" | "no-setting" }): string {
  return g.online ? "Online" : g.comfy === "down" ? "ComfyUI not running" : g.comfy === "no-setting" ? "Needs a setting" : "Offline";
}

const CLOUD_PROVIDERS = ["fal", "replicate"] as const;

/** Whether a paid API and ComfyUI are connected. */
export function connectedEngines(s: ConnectionState): { cloud: boolean; open: boolean } {
  return { cloud: CLOUD_PROVIDERS.some((p) => s.providers[p]?.configured), open: !!s.providers.comfyui?.configured };
}

/**
 * The open engine can run here for whoever is looking: the owner's install runs open models (Engine mode open or both),
 * and ComfyUI is connected (on a server or the owner's computer) or placeholder results are on. A guest or an account
 * (`viewer`) gets no 3D yet, so actions that need the owner's open engine (Make it 3D) stay off for them. Unknown: off.
 */
export function openEngineReady(s: (ConnectionState & { viewer?: unknown }) | undefined): boolean {
  if (!s || s.viewer || s.engineMode === "cloud") return false;
  return s.demoMode === "on" || !!s.providers.comfyui?.configured || !!s.ownerGpu;
}

/**
 * Whether Idol 3D can run here for the viewer: the open engine can run for the owner (openEngineReady) and Idol 3D is
 * switched on for it in Settings → Models & licences. (A picture's Make it 3D opens Photo to 3D on every engine.)
 */
export function make3dOffered(s: (ConnectionState & { viewer?: unknown; access?: AccessSummary }) | undefined): boolean {
  return openEngineReady(s) && offered(s?.access, "oss-idol", "open");
}

/** Nothing this install's engine mode uses is connected, so a run asks to connect one (or makes a placeholder, for a tour). */
export function nothingConnected(s: ConnectionState): boolean {
  const c = connectedEngines(s);
  return s.engineMode === "open" ? !c.open : s.engineMode === "cloud" ? !c.cloud : !c.cloud && !c.open;
}

/** The first-run guide shows until something is connected or it was put away. Unknown status: not yet. */
export function showFirstRun(s: ConnectionState | undefined): boolean {
  return !!s && !s.onboarded && nothingConnected(s);
}

/** What Home's Start runs in a mode: the studio's default model on each engine, the providers that host it, and one run's price on the paid one. */
export interface StartQuote {
  cloud: { name: string; price: string; providers: string[] } | null;
  open: { name: string; providers: string[] } | null;
}

const PROVIDER_LABEL: Record<string, string> = { fal: "fal.ai", replicate: "Replicate", comfyui: "ComfyUI" };

/**
 * The line under Home's composer, before Start is pressed: the model it runs and its price, or why
 * why it can't run yet (no key for a provider that hosts that model, the same rule the composer's
 * label follows), plus the other engine when that one would run it for real. Null when
 * nothing is connected: Home's notice says so instead.
 */
export function startLine(s: ConnectionState, quote: StartQuote | undefined, engine: "cloud" | "open", mode: "image" | "video" | "edit"): { text: string; other?: "cloud" | "open" } | null {
  if (!quote || nothingConnected(s)) return null;
  if (s.demoMode === "on") return { text: "Placeholder results are on (Settings), so Start makes a stand-in" };
  const hosted = (q: { providers: string[] } | null) => !!q && q.providers.some((p) => s.providers[p]?.configured);
  const otherEngine = engine === "open" ? "cloud" : "open";
  const other = s.engineMode === "both" && hosted(quote[otherEngine]) ? otherEngine : undefined;
  const then = mode === "edit" ? " after you add the photo" : "";
  if (engine === "open" && quote.open && hosted(quote.open)) return { text: `Start runs ${quote.open.name} on your GPU${then} · Free` };
  if (engine === "cloud" && quote.cloud && hosted(quote.cloud)) return { text: `Start runs ${quote.cloud.name}${then} · ${quote.cloud.price}` };
  const q = quote[engine];
  const connected = connectedEngines(s)[engine];
  const hosts = q ? q.providers.map((p) => PROVIDER_LABEL[p] ?? p).join(" or ") : "";
  let why: string;
  if (!connected) why = engine === "open" ? "ComfyUI isn't connected" : "No paid API is connected";
  else why = q ? `${q.name} needs ${engine === "open" ? hosts : `a ${hosts} key`}` : "No model is set for this";
  return { text: `${why}, so Start can't run it yet`, ...(other && { other }) };
}

/**
 * This browser's last answer to showFirstRun ("1" or "0"). Home paints the guide in its static
 * shell, before the status is known, so it doesn't push the page down when it arrives; the
 * pre-paint script hides it there when this browser already knows it isn't wanted.
 */
export const FIRST_RUN_KEY = "fuobe:first-run";

/**
 * Runs while Home's HTML is parsed: `<html data-first-run="1">` when the guide showed here last time (the shell shows it
 * then), "0" when it was put away.
 */
export const FIRST_RUN_SCRIPT = `(function(){try{var v=localStorage.getItem("${FIRST_RUN_KEY}");if(v==="0"||v==="1")document.documentElement.setAttribute("data-first-run",v)}catch(e){}})()`;

export const ENGINE_MODE_LABEL: Record<EngineModeName, string> = { both: "Open source + paid", open: "Open source only", cloud: "Paid APIs only" };

export interface ConnectionItem {
  id: "fal" | "replicate" | "comfyui" | "llm";
  label: string;
  ok: boolean;
  /** "Key set", "Online", "Off"… */
  text: string;
  /** The Settings section to jump to. */
  href: string;
  /** The engine mode doesn't use it. */
  unused: boolean;
}

/**
 * One line per connection for Settings' status strip, in the order the page lists them. ComfyUI on the owner's
 * computer reads as "Your GPU · Your computer · Online" (or what's wrong); on a hosted studio with nothing connected,
 * "Your GPU · Connect" (`place`: where the page is, lib/page-place.ts).
 */
export function connectionSummary(s: ConnectionState, place?: "here" | "network" | "hosted" | null): ConnectionItem[] {
  const key = (id: "fal" | "replicate", label: string): ConnectionItem => {
    const ok = !!s.providers[id]?.configured;
    return { id, label, ok, text: ok ? "Key set" : "Not set", href: `#${id}`, unused: s.engineMode === "open" };
  };
  const comfy = !!s.providers.comfyui?.configured;
  const llm = !!s.providers.llm?.configured;
  const unused = s.engineMode === "cloud";
  const gpu: ConnectionItem = s.ownerGpu
    ? { id: "comfyui", label: "Your GPU", ok: s.ownerGpu.online, text: `Your computer · ${computerWords(s.ownerGpu)}`, href: "#comfyui", unused }
    : !comfy && place === "hosted"
      ? { id: "comfyui", label: "Your GPU", ok: false, text: "Connect", href: "#comfyui", unused }
      : { id: "comfyui", label: "ComfyUI", ok: comfy, text: comfy ? "Online" : "Offline", href: "#comfyui", unused };
  return [
    key("fal", "fal.ai"),
    key("replicate", "Replicate"),
    gpu,
    { id: "llm", label: "AI helper", ok: llm, text: llm ? "On" : "Off", href: "#text-ai", unused: false },
  ];
}
