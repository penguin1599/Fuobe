/*
 * The licence of every open model Fuobe can run (CREDITS.md, scripts/credits.mjs), from the ComfyUI
 * manifest's `license` field and the catalog's open models, with the catches a person should
 * know before using the results commercially (non-commercial, countries excluded, conditions)
 * and the notices some licences ask the app to show ("Built with DINOv3").
 *
 * Licence texts follow the manifest's convention: NON-COMMERCIAL in capitals when the weights
 * (or a node pack's code) may not be used commercially, "territory EXCLUDES …" for countries a
 * licence leaves out, and `show "…"` for a notice the app must display. A lower-case mention
 * ("Base/Large are CC-BY-NC, keep the small one") describes a variant Fuobe does not use.
 */

export type LicenceFlag = "non-commercial" | "territory" | "conditions";

/** The parts of a catalog model the list needs (the page passes ModelDefs). */
export interface LicenceModelInput {
  id: string;
  name: string;
  vendor: string;
  kind: string;
  hidden?: boolean;
  routes: { provider: string; endpoint: string }[];
}

/** The parts of a manifest workflow the list needs. */
export interface LicenceWorkflowInput {
  id: string;
  title: string;
  capability: string;
  license?: string;
  /** Its model downloads: a licence with no page of its own links to their Hugging Face page (licenceInfo). */
  models?: { url?: string; sizeGb?: number }[];
}

export interface LicenceRow {
  /** The model id, or the workflow id for a workflow no model uses yet. */
  id: string;
  name: string;
  /** The vendor, or "Workflow library" for a workflow no studio uses yet. */
  by: string;
  kind: string;
  workflows: string[];
  /** Distinct licence texts of its workflows. */
  licences: string[];
  /** Where to read each of `licences` (same order; null when nothing is recorded), as Models & licences links it. */
  links: (string | null)[];
  flags: LicenceFlag[];
  /** Who a territory-restricted licence leaves out ("the EU, UK and South Korea"). */
  excludes?: string;
  notices: string[];
  /** True when a studio, app or helper step runs it; false for a workflow only in the library. */
  inCatalog: boolean;
}

export interface LicenceList {
  rows: LicenceRow[];
  /** Catalog tools that run on ComfyUI's own nodes, with no model weights. */
  noWeights: string[];
  /** Library workflows with no model weights that no studio uses yet. */
  noWeightsLibrary: number;
  /** Each notice and the models that need it. */
  notices: { text: string; models: string[] }[];
  counts: { all: number; clear: number } & Record<LicenceFlag, number>;
}

/**
 * Licences of the workflows whose manifest entries predate the `license` field (rounds 1–2),
 * from docs/research/comfyui-oss.md and the model cards. First match wins.
 */
export const EARLIER_LICENCES: [RegExp, string][] = [
  [/^flux1-schnell/, "Apache-2.0 (FLUX.1 [schnell])"],
  [
    /^flux1-(dev|krea|kontext|fill)/,
    "FLUX.1 [dev] Non-Commercial License: NON-COMMERCIAL (outputs may be used commercially per BFL's terms; running the model in production needs a BFL commercial licence)",
  ],
  [/^flux2-dev/, "FLUX [dev] Non-Commercial License (FLUX.2 [dev]): NON-COMMERCIAL"],
  [/^qwen-image/, "Apache-2.0 (Qwen-Image 2512 / Qwen-Image-Edit, Lightning LoRAs, Qwen2.5-VL text encoder)"],
  [/^z-image/, "Apache-2.0 (Z-Image Turbo)"],
  [/^hidream-i1/, 'MIT (HiDream-I1); its Llama 3.1 8B text encoder is under the Llama 3.1 Community License (show "Built with Llama")'],
  [/^sdxl/, "CreativeML OpenRAIL++-M (commercial use allowed, with use-based restrictions)"],
  [/esrgan/, "BSD-3-Clause (Real-ESRGAN x4plus)"],
  [/seedvr2/, "Apache-2.0 (SeedVR2)"],
  [/^bg-remove-birefnet/, "MIT (BiRefNet)"],
  [/^bg-remove-rmbg/, "BEN2 weights MIT (the pack's default); RMBG-2.0 in the same pack is CC-BY-NC-4.0 (non-commercial), keep BEN2; ComfyUI-RMBG code GPL-3.0"],
  [/^face-swap-reactor/, "inswapper_128 weights (InsightFace): NON-COMMERCIAL, research use only; ReActor node MIT; GFPGAN Apache-2.0"],
  [/^wan22-i2v-14b-lora/, "Apache-2.0 (Wan 2.2); a LoRA you add carries its own licence"],
  [/^wan-animate/, "Apache-2.0 (Wan Animate 2, lightx2v)"],
  [/^wan22-/, "Apache-2.0 (Wan 2.2, umT5, lightx2v)"],
  [/^hunyuan15/, "Tencent Hunyuan Community License (territory EXCLUDES the EU, UK and South Korea)"],
  [/^ltx2/, "LTX-2.x Community License (free, commercial use included, below US$10M annual revenue; a paid licence above); Gemma 3 text encoder under the Gemma Terms of Use"],
  [/^infinitetalk/, "Apache-2.0 (InfiniteTalk, Wan 2.1, lightx2v)"],
  [/^interpolate-film/, "Apache-2.0 (FILM)"],
  [/^interpolate-rife/, "MIT (RIFE)"],
  [/^music-ace-step/, "Apache-2.0 (ACE-Step 1.5)"],
  [/^v2a-mmaudio/, "CC-BY-NC-4.0 (MMAudio weights: NON-COMMERCIAL)"],
  [/^selftest-/, "n/a (no model; ComfyUI core nodes)"],
];

export const UNKNOWN_LICENCE = "Not recorded: check the model card before using it commercially";

/** A workflow's licence: the manifest's, else the earlier table's, else unknown. */
export function workflowLicence(wf: Pick<LicenceWorkflowInput, "id" | "license">): string {
  return wf.license?.trim() || EARLIER_LICENCES.find(([re]) => re.test(wf.id))?.[1] || UNKNOWN_LICENCE;
}

/** OpenMDW-1.1 (NVIDIA's RE-USE) asks for its text and the notices of origin with every copy of the weights (not of what they make). */
export const OPENMDW_NOTICE = "Keep the licence text and NVIDIA's notices when you share the weights";

/** What a licence text means for using the results: its flags, the countries it leaves out, its notices. */
export function licenceTerms(text: string): { flags: LicenceFlag[]; excludes?: string; notices: string[]; noWeights: boolean } {
  const noWeights = /^(n\/a|no model)\b/i.test(text.trim());
  const nonCommercial = /NON-COMMERCIAL/.test(text) || /^CC-BY-NC/.test(text.trim());
  const excludes = /\bEXCLUDES\s+([^);]+)/.exec(text)?.[1].trim();
  const conditional = /Community License|Kommunity License|OpenRAIL|Model Use License|CogVideoX License|SAM License|DINOv3 License|Hi3D Open License|Corridor Key Licence|Terms of Use|NVIDIA Software License|free below|below US\$/i.test(text);
  const flags: LicenceFlag[] = [];
  if (nonCommercial) flags.push("non-commercial");
  if (excludes) flags.push("territory");
  if (conditional && !nonCommercial && !excludes) flags.push("conditions");
  const notices = [...text.matchAll(/show (?:a |the )?"([^"]+)"/g)].map((m) => m[1]);
  if (/OpenMDW-1\.1/.test(text)) notices.push(OPENMDW_NOTICE);
  return { flags, excludes, notices, noWeights };
}

/** Workflow ids an endpoint names: one id, or a family (`video-concat-{n}`). */
function endpointIds(endpoint: string, workflows: LicenceWorkflowInput[]): string[] {
  if (!endpoint.includes("{")) return [endpoint];
  const re = new RegExp(`^${endpoint.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "\\d+")}$`);
  return workflows.filter((w) => re.test(w.id)).map((w) => w.id);
}

/** Where to read a licence its workflows state: its own page, else the largest download's model card (as licenceInfo). */
function licenceLink(text: string, workflows: LicenceWorkflowInput[]): string | null {
  const cards = workflows
    .filter((w) => workflowLicence(w) === text)
    .flatMap((w) => w.models ?? [])
    .sort((a, b) => (b.sizeGb ?? 0) - (a.sizeGb ?? 0))
    .flatMap((m) => (m.url ? [m.url] : []));
  return licenceInfo(text, cards).url ?? null;
}

function rowFor(base: Omit<LicenceRow, "licences" | "links" | "flags" | "excludes" | "notices">, licences: string[], workflows: LicenceWorkflowInput[]): LicenceRow & { noWeights: boolean } {
  const terms = licences.map(licenceTerms);
  const flags = (["non-commercial", "territory", "conditions"] as const).filter((f) => terms.some((t) => t.flags.includes(f)));
  return {
    ...base,
    licences,
    links: licences.map((l) => licenceLink(l, workflows)),
    // A row with a stricter catch doesn't also say "conditions".
    flags: flags.includes("conditions") && flags.length > 1 ? flags.filter((f) => f !== "conditions") : flags,
    excludes: terms.find((t) => t.excludes)?.excludes,
    notices: [...new Set(terms.flatMap((t) => t.notices))],
    noWeights: terms.every((t) => t.noWeights),
  };
}

/**
 * Every open model and its licence: one row per catalog model that runs on ComfyUI (in catalog
 * order), then the library's workflows no model uses yet. Tools with no weights are listed by
 * name only; ComfyUI's self-tests are left out.
 */
export function buildLicenceList(models: LicenceModelInput[], workflows: LicenceWorkflowInput[]): LicenceList {
  const byId = new Map(workflows.map((w) => [w.id, w]));
  const used = new Set<string>();
  const rows: LicenceRow[] = [];
  const noWeights: string[] = [];
  let noWeightsLibrary = 0;
  const add = (r: LicenceRow & { noWeights: boolean }) => {
    const { noWeights: none, ...row } = r;
    if (!none) rows.push(row);
    else if (row.inCatalog) noWeights.push(row.name);
    else noWeightsLibrary++;
  };

  for (const m of models) {
    const ids = [...new Set(m.routes.filter((r) => r.provider === "comfyui").flatMap((r) => endpointIds(r.endpoint, workflows)))];
    if (!ids.length || ids.every((id) => id.startsWith("selftest-"))) continue;
    ids.forEach((id) => used.add(id));
    const wfs = ids.map((id) => byId.get(id) ?? { id, title: id, capability: m.kind });
    const licences = [...new Set(wfs.map(workflowLicence))];
    add(rowFor({ id: m.id, name: m.name, by: m.vendor, kind: m.kind, workflows: ids, inCatalog: true }, licences, wfs));
  }
  for (const w of workflows) {
    if (used.has(w.id) || w.id.startsWith("selftest-")) continue;
    add(rowFor({ id: w.id, name: w.title, by: "Workflow library", kind: w.capability, workflows: [w.id], inCatalog: false }, [workflowLicence(w)], [w]));
  }

  const notices = new Map<string, string[]>();
  for (const r of rows) for (const n of r.notices) notices.set(n, [...(notices.get(n) ?? []), r.name]);
  const count = (f: LicenceFlag) => rows.filter((r) => r.flags.includes(f)).length;
  return {
    rows,
    noWeights: [...new Set(noWeights)],
    noWeightsLibrary,
    notices: [...notices].map(([text, names]) => ({ text, models: names })),
    counts: { all: rows.length, clear: rows.filter((r) => !r.flags.length).length, "non-commercial": count("non-commercial"), territory: count("territory"), conditions: count("conditions") },
  };
}

const KIND_LABEL: Record<string, string> = { image: "Image", video: "Video", audio: "Audio", text: "Text", model3d: "3D" };

/** A model's media kind, or a library workflow's capability, in words. */
export function kindLabel(kind: string): string {
  return (
    KIND_LABEL[kind] ??
    kind
      .replace(/-/g, " ")
      .replace(/\b(vfx|ocr|tts|sfx|v2a|v2v|t2v|i2v|t2i|flf2v|3d)\b/g, (a) => a.toUpperCase())
      .replace(/^\w/, (c) => c.toUpperCase())
  );
}

export const FLAG_LABEL: Record<LicenceFlag, string> = {
  "non-commercial": "Non-commercial",
  territory: "Not everywhere",
  conditions: "Conditions apply",
};

// ---------------------------------------------------------------------------
// Licence classes (Settings → Models & licences). The owner's decision of 2026-10-27: licences are
// information, never a gate. Every model, LoRA and node pack carries its licence as data, sorted into a
// class an admin can switch off; everything is on by default.

export type LicenceClass = "commercial" | "conditions" | "regions" | "non-commercial" | "research" | "paid-api" | "unknown";

/** In the order Settings lists them: the freest first, then the cloud's, then what isn't recorded. */
export const LICENCE_CLASSES: LicenceClass[] = ["commercial", "conditions", "regions", "non-commercial", "research", "paid-api", "unknown"];

export const CLASS_LABEL: Record<LicenceClass, string> = {
  commercial: "Commercial use allowed",
  conditions: "Commercial use with conditions",
  regions: "Restricted regions",
  "non-commercial": "Non-commercial",
  research: "Research only",
  "paid-api": "Proprietary paid API",
  unknown: "Licence unknown",
};

/** What a class means, in one line (the section headers in Settings). */
export const CLASS_HINT: Record<LicenceClass, string> = {
  commercial: "Open licences that let you sell what you make (Apache-2.0, MIT, BSD) and tools with no model weights.",
  conditions: "Commercial use is allowed within limits: a revenue ceiling, registration, attribution or use rules.",
  regions: "Not available in every country or region.",
  "non-commercial": "The weights or code may not be used commercially without another licence.",
  research: "Released for research only.",
  "paid-api": "Closed or hosted models you pay for per run, under the provider's and the vendor's terms.",
  unknown: "No licence is recorded for these. Check the model card first.",
};

/** A model's, LoRA's or node pack's licence, as information. */
export interface LicenceInfo {
  /** The licence's name ("Apache-2.0", "FLUX.1 [dev] Non-Commercial License", "fal.ai · paid API"). */
  name: string;
  /** Where to read it: the licence text, or the model card / repository that states it. */
  url?: string;
  class: LicenceClass;
  /** Restricted regions: who it leaves out ("the EU, UK and South Korea"). */
  excludes?: string;
  /** One line: the licence as recorded (what it covers, its catches). */
  note: string;
  /** Notices the app must show ("Built with DINOv3"). */
  notices?: string[];
}

/** How strict a class is, for a model whose parts carry several licences (the strictest one counts). */
const STRICTNESS: Record<LicenceClass, number> = { commercial: 0, "paid-api": 1, conditions: 2, unknown: 3, regions: 4, "non-commercial": 5, research: 6 };

export const stricter = (a: LicenceClass, b: LicenceClass): LicenceClass => (STRICTNESS[b] > STRICTNESS[a] ? b : a);

const SPDX = (id: string) => `https://spdx.org/licenses/${id}.html`;

/**
 * Licences by name, with the class each one puts a model in and where to read it. Order matters: a text
 * names a model's licence by the first entry of its class it mentions (a text with Apache-2.0 weights and
 * the CogVideoX base is the CogVideoX License's).
 */
const KNOWN: { re: RegExp; name: string; class: LicenceClass; url?: string }[] = [
  { re: /FLUX\.1 \[dev\] Non-Commercial License|FLUX\.1 \[dev\] base is NON-COMMERCIAL/, name: "FLUX.1 [dev] Non-Commercial License", class: "non-commercial", url: "https://huggingface.co/black-forest-labs/FLUX.1-dev" },
  { re: /FLUX \[dev\] Non-Commercial License/, name: "FLUX [dev] Non-Commercial License", class: "non-commercial", url: "https://huggingface.co/black-forest-labs/FLUX.2-dev" },
  { re: /Ideogram Non-Commercial Model Agreement/, name: "Ideogram Non-Commercial Model Agreement", class: "non-commercial", url: "https://huggingface.co/ideogram-ai/ideogram-4-fp8/blob/main/LICENSE.md" },
  { re: /inswapper/, name: "InsightFace inswapper (research only)", class: "research", url: "https://github.com/deepinsight/insightface" },
  // Corridor's CC BY-NC-SA 4.0 variant that allows commercial projects (no paid API, no resale): before the CC entries.
  { re: /Corridor Key Licence 2\.0/, name: "Corridor Key Licence 2.0", class: "conditions", url: "https://github.com/nikopueringer/CorridorKey2.0/blob/485f5e9ab759ead6138cc990776184b59d6ea971/LICENSE" },
  { re: /CC[- ]BY[- ]NC[- ]SA[- ]4\.0/, name: "CC BY-NC-SA 4.0", class: "non-commercial", url: SPDX("CC-BY-NC-SA-4.0") },
  { re: /CC[- ]BY[- ]NC(?![- ]SA)(?:[- ]4\.0)?\b/, name: "CC BY-NC 4.0", class: "non-commercial", url: SPDX("CC-BY-NC-4.0") },
  // Before the general entry: AuK's encoder (Edit speech) has its own copy of the licence.
  { re: /Qwen2\.5-Omni-3B encoder Qwen Research License/, name: "Qwen Research License", class: "non-commercial", url: "https://huggingface.co/Qwen/Qwen2.5-Omni-3B/blob/main/LICENSE" },
  { re: /Qwen Research License/, name: "Qwen Research License", class: "non-commercial", url: "https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE" },
  { re: /Tencent Hunyuan 3D 2\.1 Community License/, name: "Tencent Hunyuan 3D 2.1 Community License", class: "regions" },
  { re: /Tencent Hunyuan Community License/, name: "Tencent Hunyuan Community License", class: "regions" },
  { re: /CogVideoX License/, name: "CogVideoX License", class: "conditions" },
  { re: /LTX-2(?:\.x)? Community License/, name: "LTX-2 Community License", class: "conditions" },
  { re: /Stability AI Community License|Stability Community License/, name: "Stability AI Community License", class: "conditions", url: "https://stability.ai/community-license-agreement" },
  { re: /Krea 2 Community License/, name: "Krea 2 Community License", class: "conditions" },
  // FLUX 3 Image Klein (nm10-flux3-klein): non-commercial, with commercial outputs for Qualifying Users below US$5M revenue.
  { re: /FLUX Kommunity License/, name: "FLUX Kommunity License v1.0", class: "conditions", url: "https://huggingface.co/black-forest-labs/flux-3-image-klein" },
  { re: /IndexTTS-2 Model Use License/, name: "bilibili IndexTTS-2 Model Use License", class: "conditions" },
  { re: /Llama 3\.1 Community License/, name: "Llama 3.1 Community License", class: "conditions", url: "https://www.llama.com/llama3_1/license/" },
  { re: /DINOv3 License/, name: "DINOv3 License", class: "conditions" },
  // Hi3D 1.0 (hi3d-refine): commercial use; above 200,000 monthly users or US$1M monthly revenue a separate licence, and
  // "Powered by Hi3D 1.0" shown with its results.
  { re: /Hi3D Open License/, name: "Hi3D Open License Agreement 1.0", class: "conditions", url: "https://huggingface.co/hi3d-official/Hi3Dv1.0/blob/d502e938cbedc6e87aba8884614c5ca6d177a4b6/LICENSE" },
  // Before SAM's: the H3 workflows' text names both, and the territory catch is the one that counts.
  { re: /MiniMax-Music3 Community License/, name: "MiniMax-Music3 Community License", class: "conditions", url: "https://huggingface.co/MiniMaxAI/MiniMax-Music3/blob/1b525ccb685ae809f33027c51c351eeb5833cf72/LICENSE" },
  { re: /MiniMax H3 Community License/, name: "MiniMax H3 Community License", class: "regions", url: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/42ed227ee7df40d41602854ae760620d6eb651fe/LICENSE" },
  { re: /SAM License/, name: "Meta SAM License", class: "conditions" },
  { re: /OpenRAIL\+\+-M/, name: "CreativeML OpenRAIL++-M", class: "conditions" },
  { re: /OpenRAIL-M/, name: "CreativeML OpenRAIL-M", class: "conditions", url: SPDX("CreativeML-OpenRAIL-M") },
  { re: /Gemma Terms of Use/, name: "Gemma Terms of Use", class: "conditions", url: "https://ai.google.dev/gemma/terms" },
  // NVIDIA's open model licence (RE-USE): commercial use; the licence and NVIDIA's notices go with any copy of the weights.
  { re: /OpenMDW-1\.1/, name: "OpenMDW-1.1", class: "commercial", url: "https://huggingface.co/nvidia/NVIDIA-NemotronLabs-RE-USE/blob/31f82f2efad1095034492f236e8dac9239ba713b/LICENSE" },
  // NVIDIA's RTX Video SDK (nvidia-vfx): free and proprietary, only on NVIDIA GPUs; no redistributing or published benchmarks.
  { re: /NVIDIA Software License Agreement/, name: "NVIDIA Software License Agreement", class: "conditions", url: "https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-software-license-agreement/" },
  { re: /Apache[- ]2\.0/, name: "Apache-2.0", class: "commercial", url: SPDX("Apache-2.0") },
  { re: /\bMIT\b/, name: "MIT", class: "commercial", url: SPDX("MIT") },
  { re: /BSD-3-Clause/, name: "BSD-3-Clause", class: "commercial", url: SPDX("BSD-3-Clause") },
];

/** ComfyUI's own licence: the tools with no model weights run on its nodes. */
const COMFYUI_REPO = "https://github.com/comfyanonymous/ComfyUI";

/** A Hugging Face download's repository page, where its licence is stated. */
export function modelCardOf(url: string | undefined): string | undefined {
  const m = url && /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/(?:resolve|blob)\//.exec(url);
  return m ? `https://huggingface.co/${m[1]}` : undefined;
}

/**
 * What a recorded licence text means as information: its class, a short name, where to read it. `cards` are
 * the model downloads it covers (the largest first): their Hugging Face page is the link when the licence
 * has no page of its own.
 */
/** A text that records its weights' licence as not stated anywhere: "<model> weights: unknown (…)". */
const UNSTATED = /^[^:;(]+\bweights: unknown\b/i;

export function licenceInfo(text: string, cards: string[] = []): LicenceInfo {
  const terms = licenceTerms(text);
  const card = cards.map(modelCardOf).find(Boolean);
  if (text === UNKNOWN_LICENCE) return { name: "Not recorded", class: "unknown", note: text, ...(card && { url: card }) };
  if (terms.noWeights) return { name: "No model weights", class: "commercial", url: COMFYUI_REPO, note: `${text.replace(/^n\/a \((.*)\)$/, "$1")}: ComfyUI's own nodes (GPL-3.0) or FFmpeg` };
  // Weights whose licence the research found nowhere ("FeyNoBg weights: unknown (no card, no tag, no LICENSE)").
  const unstated = UNSTATED.test(text);
  const cls: LicenceClass = terms.flags.includes("non-commercial")
    ? /research (?:use )?only/i.test(text)
      ? "research"
      : "non-commercial"
    : terms.flags.includes("territory")
      ? "regions"
      : unstated
        ? "unknown"
        : terms.flags.includes("conditions")
          ? "conditions"
          : "commercial";
  if (cls === "unknown") return { name: "Not recorded", class: cls, note: text, ...(card && { url: card }) };
  const found = KNOWN.filter((k) => k.re.test(text));
  const named = found.find((k) => k.class === cls) ?? found[0];
  const name = named?.name ?? text.split(/[(;:]/)[0].trim();
  // The licence's own text when it has a page, else the model card that states it.
  const url = named?.url ?? card;
  return { name, class: cls, note: text, ...(url && { url }), ...(terms.excludes && { excludes: terms.excludes }), ...(terms.notices.length && { notices: terms.notices }) };
}

/** Several licences as one (a model running several workflows, a chain): the strictest class names it. */
export function mergeLicences(infos: LicenceInfo[]): LicenceInfo {
  if (infos.length <= 1) return infos[0] ?? { name: "Not recorded", class: "unknown", note: UNKNOWN_LICENCE };
  const lead = infos.reduce((a, b) => (STRICTNESS[b.class] > STRICTNESS[a.class] ? b : a));
  const notes = [...new Set(infos.map((i) => i.note))];
  const notices = [...new Set(infos.flatMap((i) => i.notices ?? []))];
  return { ...lead, note: notes.join(" · "), ...(notices.length && { notices }) };
}

/** Where a provider shows a hosted model (its page states the model's licence and the provider's terms). */
export function providerPage(provider: string, endpoint: string): string | undefined {
  if (provider === "fal") return `https://fal.ai/models/${endpoint}`;
  if (provider === "replicate") return `https://replicate.com/${endpoint.split(":")[0]}`;
  if (provider === "llm") return "https://www.anthropic.com/legal/commercial-terms";
  return undefined;
}

export const PROVIDER_NAME: Record<string, string> = {
  fal: "fal.ai",
  replicate: "Replicate",
  comfyui: "ComfyUI (your GPU)",
  llm: "Claude or a local model",
  local: "Your browser",
  openai: "OpenAI",
  google: "Google",
};

/** A model on a paid API: the provider's and the vendor's terms (a closed model, or open weights the provider hosts). */
export function paidApiLicence(vendor: string, routes: { provider: string; endpoint: string }[]): LicenceInfo {
  const providers = [...new Set(routes.map((r) => r.provider))];
  const names = providers.map((p) => PROVIDER_NAME[p] ?? p);
  const first = routes[0];
  const url = first && providerPage(first.provider, first.endpoint);
  return {
    name: `Paid API · ${names.join(", ")}`,
    class: "paid-api",
    note: `Runs on ${names.join(" or ")} with your key. You pay per run, and their terms apply.`,
    ...(url && { url }),
  };
}

/**
 * Text steps: Claude through the Anthropic key, else the local model; on the open engine, the local model only.
 * `model` is the one the local server in use runs ("" when it picks one later), `server` names that server.
 */
export function llmLicence(endpoint: string, model = "qwen3:8b", server = "Ollama"): LicenceInfo {
  if (endpoint !== "ollama") {
    return {
      name: "Paid API · Anthropic (or a local model)",
      class: "paid-api",
      url: "https://www.anthropic.com/legal/commercial-terms",
      note: "Claude through your Anthropic key, under Anthropic's commercial terms; with no key, the local model on your machine (Ollama, LM Studio or Unsloth Studio)",
    };
  }
  const known: [RegExp, string, LicenceClass, string?][] = [
    [/^qwen/i, "Apache-2.0", "commercial", SPDX("Apache-2.0")],
    [/^(mistral|mixtral)/i, "Apache-2.0", "commercial", SPDX("Apache-2.0")],
    [/^(phi|deepseek)/i, "MIT", "commercial", SPDX("MIT")],
    [/^gemma/i, "Gemma Terms of Use", "conditions", "https://ai.google.dev/gemma/terms"],
    [/^llama/i, "Llama Community License", "conditions", "https://www.llama.com/"],
  ];
  // LM Studio and Unsloth name a model by publisher ("google/gemma-3-12b", "unsloth/Qwen3-8B-GGUF"): the last part names the family.
  const family = model.split("/").pop() ?? "";
  const hit = family ? known.find(([re]) => re.test(family)) : undefined;
  const note = model
    ? `The model this install's text steps use on ${server} (${model}); another model carries its own licence (its model card, or ollama show <model> --license)`
    : `${server} hasn't said which model it runs yet; that model carries its own licence (its model card)`;
  return hit ? { name: hit[1], class: hit[2], note, ...(hit[3] && { url: hit[3] }) } : { name: "Not recorded", class: "unknown", note };
}

/** Tools that run in the browser (colour grade, ad compositing): Fuobe's own code. */
export const BROWSER_LICENCE: LicenceInfo = { name: "Fuobe (open source)", class: "commercial", note: "Runs in your browser with Fuobe's own code: no model weights, nothing sent anywhere" };

// ---------------------------------------------------------------------------
// ComfyUI node packs: the code a workflow loads beside ComfyUI (scripts/comfy/install-comfyui.sh and
// install-isolated-worker.sh), from the research (docs/research/comfyui-oss*.json) and the manifest's licence
// notes. A pack whose repository has no LICENSE file is recorded as unknown.

export interface NodePack {
  name: string;
  repo: string;
  licence: LicenceInfo;
  /** Installed on the isolated worker (install-isolated-worker.sh), not the main ComfyUI. */
  worker?: "isolated";
}

const pack = (name: string, repo: string, licence: Omit<LicenceInfo, "url"> & { url?: string }, worker?: "isolated"): NodePack => ({
  name,
  repo,
  licence: { url: repo, ...licence },
  ...(worker && { worker }),
});
const GPL: Omit<LicenceInfo, "note"> = { name: "GPL-3.0", class: "commercial", url: SPDX("GPL-3.0-only") };
const NO_FILE = (extra = "") => ({ name: "Not recorded", class: "unknown" as const, note: `The repository has no LICENSE file${extra}` });

export const NODE_PACKS: NodePack[] = [
  pack("ComfyUI-WanVideoWrapper", "https://github.com/kijai/ComfyUI-WanVideoWrapper", { name: "Apache-2.0", class: "commercial", url: SPDX("Apache-2.0"), note: "Code Apache-2.0; the Wan weights it loads are Apache-2.0" }),
  pack("ComfyUI-VideoHelperSuite", "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite", { ...GPL, note: "Video loading and saving; GPL-3.0 code, like ComfyUI" }),
  pack("ComfyUI-KJNodes", "https://github.com/kijai/ComfyUI-KJNodes", { ...GPL, note: "Utility nodes (GrowMaskWithBlur, resizing); GPL-3.0 code, like ComfyUI" }),
  pack("ComfyUI-Frame-Interpolation", "https://github.com/Fannovel16/ComfyUI-Frame-Interpolation", { name: "MIT", class: "commercial", url: SPDX("MIT"), note: "RIFE and FILM frame interpolation; MIT code" }),
  pack("ComfyUI-RMBG", "https://github.com/1038lab/ComfyUI-RMBG", { ...GPL, note: "Background removal; GPL-3.0 code. Fuobe uses BEN2 (MIT); RMBG-2.0 in the same pack is CC BY-NC 4.0. Its Bria VRMBG 3.0 node loads Bria's gated weights (non-commercial unless Bria agrees otherwise); FeyNoBg's weights state no licence" }),
  pack("ComfyUI-ReActor", "https://github.com/Gourieff/ComfyUI-ReActor", { name: "See its repository", class: "commercial", note: "Face swap node; the inswapper_128 weights it loads are for non-commercial research only" }),
  pack("ComfyUI-MMAudio", "https://github.com/kijai/ComfyUI-MMAudio", { name: "Not recorded", class: "unknown", note: "Code licence not recorded; the MMAudio weights it loads are CC BY-NC 4.0 (non-commercial)" }),
  pack("ComfyUI_Fill-ChatterBox", "https://github.com/filliptm/ComfyUI_Fill-ChatterBox", NO_FILE("; the Chatterbox weights are MIT")),
  pack("ComfyUI-IndexTTS2", "https://github.com/snicolast/ComfyUI-IndexTTS2", NO_FILE("; the IndexTTS-2 weights have their own Model Use License")),
  pack("ComfyUI-Video-Depth-Anything", "https://github.com/yuvraj108c/ComfyUI-Video-Depth-Anything", { name: "Not recorded", class: "unknown", note: "Code licence not recorded; Fuobe loads the Apache-2.0 Small model (Base and Large are CC BY-NC 4.0)" }),
  pack("ComfyUI-MelBandRoFormer", "https://github.com/kijai/ComfyUI-MelBandRoFormer", { name: "Not recorded", class: "unknown", note: "Code licence not recorded; the MelBand RoFormer weights are MIT" }),
  pack("ComfyUI-QwenASR", "https://github.com/1038lab/ComfyUI-QwenASR", { ...GPL, note: "Qwen3-ASR transcription; GPL-3.0 code, Apache-2.0 weights" }),
  pack("ComfyUI-HunyuanVideo-Foley", "https://github.com/phazei/ComfyUI-HunyuanVideo-Foley", { name: "Not recorded", class: "unknown", note: "Code licence not recorded; the HunyuanVideo-Foley weights leave out the EU, UK and South Korea" }),
  pack("ComfyUI-ToSVG", "https://github.com/Yanick112/ComfyUI-ToSVG", { name: "MIT", class: "commercial", url: SPDX("MIT"), note: "VTracer vectorising; MIT. The pack also imports PyMuPDF (AGPL-3.0) for a node Fuobe doesn't use" }),
  pack("ComfyUI-Whisper", "https://github.com/yuvraj108c/ComfyUI-Whisper", { name: "CC BY-NC-SA 4.0", class: "non-commercial", url: SPDX("CC-BY-NC-SA-4.0"), note: "Word-timed captions in one job; non-commercial code (the author asks to be contacted for commercial use). The Whisper weights are MIT" }),
  pack("ComfyUI-LatentSyncWrapper", "https://github.com/ShmuelRonen/ComfyUI-LatentSyncWrapper", NO_FILE("; the LatentSync 1.6 weights are CreativeML OpenRAIL++-M"), "isolated"),
  pack("ComfyUI-ThinkSound_Wrapper", "https://github.com/ShmuelRonen/ComfyUI-ThinkSound_Wrapper", NO_FILE("; the ThinkSound weights are Apache-2.0"), "isolated"),
  pack("fuobe-live", "https://github.com/workingprototype/Fuobe", { name: "MIT", class: "commercial", url: SPDX("MIT"), note: "Fuobe's own live edit nodes (fuobe_live.py, shipped with Fuobe): a loader, a cached reference encode, a crop, a paste-back and a socket save. The Qwen-Image 2.1 weights and the DMD2 LoRA they run are non-commercial" }),
  pack("ausboss-nodes", "https://github.com/ausboss/ComfyUI-AusBoss", { name: "MIT", class: "commercial", url: SPDX("MIT"), note: "Crop For Inpaint, Stitch Inpaint and Crop + Rotate + Pad for Qwen-Image 2.1's inpaint and expand; MIT code. The Qwen-Image 2.1 weights they run are non-commercial" }),
  // Qwen-Image 2.1 on a 16 GB card: recoilme's Zen Image Edit nodes, LICENSE Apache-2.0 at the pinned commit.
  pack("zen-image-edit-comfyui", "https://github.com/recoilme/zen-image-edit-comfyui/tree/7a29e58c973b84798df926e3251727884fdacc2d", {
    name: "Apache-2.0",
    class: "commercial",
    url: SPDX("Apache-2.0"),
    note: "Zen Image Edit's adapter loader and text encode: Qwen-Image 2.1 on the Qwen3.5-0.8B encoder (Apache-2.0) and a fusion adapter. The adapter and the Qwen-Image 2.1 weights are non-commercial (Qwen Research License)",
  }),
  // Design a voice, pinned in workflows/comfyui/packs.json: LICENSE files read at the pinned commits.
  pack("ComfyUI-QwenTTS", "https://github.com/1038lab/ComfyUI-QwenTTS/tree/d8122a8ba835b65fd65c113d2b273b1ad1579293", {
    ...GPL,
    note: "Qwen3-TTS voice design and voice clone nodes; GPL-3.0 code. The Qwen3-TTS 1.7B weights it downloads are Apache-2.0",
  }),
  pack("ComfyUI-VoxCPM2", "https://github.com/Saganaki22/ComfyUI-VoxCPM2/tree/0e52a6cd006769e030d0e1ae907ffebbbfac4f5f", {
    name: "Apache-2.0",
    class: "commercial",
    url: SPDX("Apache-2.0"),
    note: "VoxCPM2 text to speech (voice design) and voice clone nodes; Apache-2.0 code. The VoxCPM2 weights it downloads are Apache-2.0",
  }),
  // Green screen, pinned in workflows/comfyui/packs.json: its LICENSE is Corridor's own, word for word.
  pack("ComfyUI-CorridorKey2", "https://github.com/hashu786/ComfyUI-CorridorKey2/tree/d1228b68796786acee92b6497f72a60d70d1a844", {
    name: "Corridor Key Licence 2.0",
    class: "conditions",
    note: "CorridorKey 2.0 nodes, with Corridor's CorridorKey 2.0 code inside unmodified; the code and the weights it downloads are under the Corridor Key Licence 2.0: free for any project, commercial ones included, but never resold or offered as a paid API or inference service. The frozen models it downloads keep their own licences (NVIDIA Open Model License, MIT, CC-BY 4.0)",
  }),
  // Edit speech, pinned in workflows/comfyui/packs.json: the LICENSE file read at the pinned commit.
  pack("ComfyUI-AuK", "https://github.com/Tencent-Hunyuan/AuK/tree/0d40366b1039e37c6cad008ab4713f6ad6d954b7/comfyui/ComfyUI-AuK", {
    name: "MIT",
    class: "commercial",
    url: SPDX("MIT"),
    note: "Tencent AuK's own nodes (speech editing and text to speech); MIT code and weights. The Qwen2.5-Omni-3B encoder AuK loads is under the Qwen Research License (non-commercial)",
  }),
  // Kandinsky 6.0, pinned in workflows/comfyui/packs.json: Kandinsky Lab's packs, the comfyui/ folder of each
  // repository, LICENSE files read at the pinned commits.
  pack("kandinsky6", "https://github.com/kandinskylab/kandinsky-6/tree/7ceeefad7fb625011f7db602c43893a989f19c15/comfyui", {
    name: "MIT",
    class: "commercial",
    url: SPDX("MIT"),
    note: "Kandinsky 6.0 text and image to video with sound; MIT code, its vendored Kandinsky video code Apache-2.0. The Kandinsky weights are MIT; the MMAudio audio VAE file it loads (v1-44.pth) is CC BY-NC 4.0",
  }),
  pack("kandinsky6-sr", "https://github.com/kandinskylab/kandinsky-6-sr/tree/b15e2aac526519c51f59dfec2b848355bb8902de/comfyui", {
    name: "Apache-2.0",
    class: "commercial",
    url: SPDX("Apache-2.0"),
    note: "Kandinsky VSR video upscaling (2x, 2.25x, 4x); Apache-2.0 code. The Kandinsky VSR weights are MIT",
  }),
  // Watermark Remover (image-watermark-*): overflowofedge's Qwen watermark nodes, pinned in install-comfyui.sh.
  pack("ComfyUI-Qwen-Watermark", "https://github.com/overflowofedge/ComfyUI-Qwen-Watermark/tree/eef829d34d6e9d0d2ae0c1386fab7371a864cf34", {
    name: "MIT",
    class: "commercial",
    url: SPDX("MIT"),
    note: "The Watermark Remover's nodes: find the marks (Qwen3-VL 8B, Apache-2.0), outline stickers (SAM ViT-B, Apache-2.0), repair and check the result; MIT code. The Qwen-Image 2.1 weights the repair runs are non-commercial",
  }),
  // Genjutsu's Character swap (docs/research/openjutsu-6.md §7): Akatz Labs' packs, pinned in install-comfyui.sh.
  pack("h3_character_swap", "https://github.com/akatz-labs/h3-character-swap-tool/tree/0670e4fdf95adf2262caa4b81afed2a9c4ae4b7b/worker_nodes/h3_character_swap", {
    ...GPL,
    note: "MiniMax H3 character swap nodes (Akatz Labs); GPL-3.0 code, a modified NVIDIA INT8 kernel inside is Apache-2.0. The MiniMax H3 weights it runs leave out the US, the EU, the UK and South Korea",
  }),
  pack("h3-relay", "https://github.com/akatz-ai/h3-relay/tree/e2a7665b6eb8ea37a88c0de2c9c6b69a8f7c9220", {
    ...GPL,
    note: "H3 Relay 2.0 (Sendy Software LLC and contributors); GPL-3.0 code, vendored Context Loop and Spectrum GPL-3.0. Opt-in: it registers HTTP routes when it loads",
  }),
  // Genjutsu's Openjutsu modes (Group swap, Scene edit, From picture, Fix faces, Fix colours): pinned in packs.json and
  // install-comfyui.sh (OPENJUTSU_MODES=1). LICENSE files read at the pinned commits.
  pack("ComfyUI-MiniMaxH3-Context-Loop", "https://github.com/ethanfel/ComfyUI-MiniMaxH3-Context-Loop/tree/43afeffcc570beb5f7382593e79e4b211c7e02f6", {
    ...GPL,
    note: "MiniMax H3 Context Loop (NikoDemon80, Ethanfel): long H3 edits clip by clip, each continuing from the last; GPL-3.0 code. It registers local HTTP routes when it loads",
  }),
  pack("ComfyUI-Fantastic-MiniMaxH3-PromptBuilder", "https://github.com/Adudeguyman/ComfyUI-Fantastic-MiniMaxH3-PromptBuilder/tree/22e719fe89336c628383363182a4da3cb58d4f9b", {
    name: "MIT",
    class: "commercial",
    url: SPDX("MIT"),
    note: "The masked edit latent the H3 edits start from (source, mask and sound); MIT code",
  }),
  pack("comfyui-h3-oneclick-swap", "https://github.com/D3voz/comfyui-h3-oneclick-swap/tree/e44a56e92920000e675d14be484aea0d7498d63e", {
    name: "MIT",
    class: "commercial",
    url: SPDX("MIT"),
    note: "D3voz's swap, scene edit and face section nodes (plans, role masks, grey mannequins); MIT code. Fuobe applies a patch that words its H3 prompts positively",
  }),
  pack("comfyui-image-detail-contrast", "https://github.com/D3voz/comfyui-image-detail-contrast/tree/485a5e246424ce012b998862b45f06d21e8d63b2", {
    name: "MIT",
    class: "commercial",
    url: SPDX("MIT"),
    note: "Softens fine detail contrast for Fix colours; MIT code, no model",
  }),
  pack("Orion4D_FXMax", "https://github.com/orion4d/Orion4D_FXMax/tree/7048e8423ad7d1a6a52119d0d4870c2b7fc2885f", {
    name: "MIT",
    class: "commercial",
    url: SPDX("MIT"),
    note: "Philippe Joye's DCTL tone mapper (Fix colours' film finish); MIT code, no model",
  }),
  pack("SolarRenderer", "https://github.com/Enderfga/SolarRenderer/tree/0ca4f5e45b062cc9e9aee506de46aabdc22e4c3d", {
    name: "Apache-2.0",
    class: "commercial",
    url: SPDX("Apache-2.0"),
    note: "From picture's renderer; Apache-2.0 code (cloned only, never pip-installed), with Openjutsu's long-clip patch. Its LoRAs are under the MiniMax H3 Community License",
  }),
  pack("ComfyUI-H3-FaceRefine", "https://github.com/Carasibana/ComfyUI-H3-FaceRefine", {
    name: "See its repository",
    class: "unknown",
    note: "Face tracking, masks and paste-back for Fix faces (registry 1.1.1). The InsightFace buffalo_l models it uses are for non-commercial research only; the YOLO face and person weights are AGPL-3.0",
  }),
  pack("ComfyUI-Impact-Pack", "https://github.com/ltdrdata/ComfyUI-Impact-Pack", { ...GPL, note: "Its SAM loader (Fix faces' face masks; SAM ViT-B is Apache-2.0); GPL-3.0 code" }),
  pack("comfyui_controlnet_aux", "https://github.com/Fannovel16/comfyui_controlnet_aux/tree/a587a4c1594524c1d2de5cd1a86cd868ff448e1c", {
    name: "Apache-2.0",
    class: "commercial",
    url: SPDX("Apache-2.0"),
    note: "Metric3D normals that carry the clip's motion into From picture; Apache-2.0 code, the Metric3D model is BSD-2-Clause",
  }),
  // Restore & colourise (package archive-restore): Lightricks' LTX nodes (IC-LoRA loader and guide, tiled fusion sampler).
  pack("ComfyUI-LTXVideo", "https://github.com/Lightricks/ComfyUI-LTXVideo/tree/220e1d45aa0469f518e982102fca4dca92a61862", {
    name: "LTX-2 Community License",
    class: "conditions",
    note: "Lightricks' LTX nodes (IC-LoRA loader and guide, per-step tiled latent fusion); the repository's LICENSE is the LTX-2 Community License: free, commercial use included, below US$10M annual revenue",
  }),
  // DBS soundtrack separation (docs/research/dbs-separation-7.md §3.2), pinned in install-comfyui.sh.
  pack("ComfyUI-DBS", "https://github.com/hiroki-abe-58/ComfyUI-DBS/tree/f656e53434b5485c148a2866fbd6ddc6b6152ed6", {
    name: "MIT",
    class: "commercial",
    url: SPDX("MIT"),
    note: "Dialogue, music and effects separation; MIT code, bundled DBS code Apache-2.0 with MIT notices. The DBS weights are Apache-2.0, trained on DnR v2 (CC BY 4.0), some of whose clips carry their own licences",
  }),
  // Idol 3D's clean splats (idol-2, docs/research/idol-9.md §5.1-5.2), pinned in install-comfyui.sh.
  pack("ComfyUI-Idol", "https://github.com/Nynxz/ComfyUI-Idol/tree/4d3a4f671028f0e062d9f004cda1a2dd73360d35", {
    name: "Apache-2.0",
    class: "commercial",
    url: SPDX("Apache-2.0"),
    note: "Idol's crop modes, predicted camera and splat pruning; Apache-2.0 code, no model code; ports idol-sdk's preprocess and camera code (Apache-2.0)",
  }),
  // World mode (nm10-hy-nomas-world), pinned in workflows/comfyui/packs.json: the LICENSE and NOTICE files read at the pinned commit.
  pack("ComfyUI-HyNomas", "https://github.com/Nynxz/ComfyUI-HyNomas/tree/a89e0515619924da71093aa3fe52dbb7104cb06e", {
    name: "Apache-2.0",
    class: "commercial",
    url: SPDX("Apache-2.0"),
    note: "Hy-Nomas world generation on ComfyUI's own loaders; Apache-2.0 code reimplementing Tencent's Apache-2.0 model code. The Hy-Nomas DiT is Apache-2.0; the PixelUMM decoder it loads is under the NVIDIA One-Way Noncommercial License",
  }),
  // Krea 2's edits (the owner's SOTA image families, 2026-10-31).
  pack("comfyui-krea2edit", "https://github.com/lbouaraba/comfyui-krea2edit", {
    name: "Apache-2.0",
    class: "commercial",
    url: SPDX("Apache-2.0"),
    note: "Krea 2 Identity Edit's nodes (Krea 2 Edit and Identity Edit); Apache-2.0 code. The V2 edit LoRAs they run are non-commercial without a licence from their author",
  }),
  pack("ComfyUI-Krea2-Ostris-Edit", "https://github.com/ostris/ComfyUI-Krea2-Ostris-Edit", {
    name: "MIT",
    class: "commercial",
    url: SPDX("MIT"),
    note: "Ostris' Krea 2 edit nodes (Krea 2 Inpaint); MIT code. The inpaint LoRA it runs is under the Krea 2 Community License",
  }),
  // MiniMax H3 video (minimax-h3-t2v / i2v / flf2v), pinned in install-comfyui.sh.
  pack("ComfyUI-MiniMax-H3-Turbo", "https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo/tree/77bfa67575b14e3be6214f1747732e540c68b5dd", {
    name: "Apache-2.0",
    class: "commercial",
    url: SPDX("Apache-2.0"),
    note: "larryvrh's turbo LoRA loader and sampler for MiniMax H3 (8 steps); Apache-2.0 code, and the turbo v4 LoRA is Apache-2.0. The MiniMax H3 weights it runs leave out the US, the EU, the UK and South Korea",
  }),
  pack("plaguekind-nodes", "https://github.com/PlagueKind/ComfyUI-PlagueKind-Nodes/tree/d58d006a4ea32c25c06499f2ff104f0852a045a6", {
    name: "MIT",
    class: "commercial",
    url: SPDX("MIT"),
    note: "PlagueKind's H3 SLA attention (needs Triton) and AdaLN LoRA fix for MiniMax H3; MIT code",
  }),
  // Open-H3 Regenerate 2K (Upscale → Video's Regenerate · creative), opt-in in install-comfyui.sh (OPEN_H3_REGEN=1).
  pack("ComfyUI-Open-H3-Regenerate", "https://github.com/rdh9616/ComfyUI-Open-H3-Regenerate/tree/9b686c5ffd380e9d1351f9b8beef6d20d703ca3e", {
    name: "Apache-2.0",
    class: "commercial",
    url: SPDX("Apache-2.0"),
    note: "rdh9616's Open-H3 Regenerate nodes (NVIDIA's refine recipe, with NVIDIA's fast H3 VAE decoder vendored); Apache-2.0 code with a NOTICE file. The MiniMax H3 weights and the refiner LoRA it runs leave out the US, the EU, the UK and South Korea",
  }),
  pack("Comfyui_Minimax_h3_latent_Upscaler", "https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler/tree/40316cf008b2fd8663263270669eb4da23f89d2c", {
    name: "MIT",
    class: "commercial",
    url: SPDX("MIT"),
    note: "LBH-123-AI's H3 latent upscaler nodes (the Open-H3 Regenerate nodes call them by name); MIT code, copyright (c) 2026 LBH-123-AI. Its upscaler weights are Apache-2.0",
  }),
  // Hi3D 1.0 mesh refinement (hi3d-refine), opt-in in install-comfyui.sh (HI3D=1).
  pack("Comfyui-Hi3d-T8", "https://github.com/T8mars/Comfyui-Hi3d-T8/tree/73848490976e6a9b0c735ce02984c03866a495e7", {
    name: "MIT",
    class: "conditions",
    url: SPDX("MIT"),
    note: "T8star's Hi3D nodes (model loader, mesh loader, refine); MIT code. The Hi3D code it vendors and the Hi3D weights are under the Hi3D Open License Agreement 1.0: commercial use, a separate licence above 200,000 monthly users or US$1M monthly revenue, and \"Powered by Hi3D 1.0\" shown with its results",
  }),
  // Clean up voice: Fuobe's own pack, in this repository at its pinned commit (comfy-nodes/ComfyUI-RE-USE).
  pack("ComfyUI-RE-USE", "https://github.com/workingprototype/Fuobe/tree/8cc0417b5cb8a603f06502d97d5c6d8c6035ea0d/comfy-nodes/ComfyUI-RE-USE", {
    name: "MIT",
    class: "commercial",
    url: SPDX("MIT"),
    note: "Fuobe's own pack. The network code is adapted from NVIDIA's RE-USE repository (OpenMDW-1.1, notices kept), and the Mamba layer is a plain-PyTorch rewrite (no mamba-ssm). It matches the reference maths numerically, but it is not NVIDIA's code path",
  }),
  // NVIDIA RTX Video (Quick · RTX, RTX Frame Generation, RTX Video HDR): an NVIDIA RTX card only; installed on RTX hosts.
  pack("ComfyUI_Nvidia_VFX_Nodes", "https://github.com/Comfy-Org/ComfyUI_Nvidia_VFX_Nodes/tree/38d790ded00650681fa3645362efe28c8560cf40", {
    name: "Apache-2.0",
    class: "commercial",
    url: SPDX("Apache-2.0"),
    note: "Comfy-Org's NVIDIA VFX nodes 0.2.1; Apache-2.0 code. The nvidia-vfx runtime they load (the RTX Video SDK and its models) is NVIDIA's own, under the NVIDIA Software License Agreement: free, runs only on NVIDIA GPUs, no redistributing it",
  }),
  // Relight: Viggle's node file (speed-LoRA loader and step schedule), in the model repo at the pinned revision.
  pack("viggle_turbo", "https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo/tree/009a44a895ef85f7e643c80fdca9543795248867/comfyui", {
    name: "Qwen Research License",
    class: "non-commercial",
    url: "https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE",
    note: "Viggle's ComfyUI nodes for its Qwen-Image 2.1 turbo LoRA (the loader that reads the LoRA's strength from its metadata, and the 6-step schedule); they ship in the model repo, a Qwen-Image 2.1 derivative under the same research licence",
  }),
];

export const nodePack = (name: string): NodePack | undefined => NODE_PACKS.find((p) => p.name === name);

/**
 * Credits CREDITS.md lists: attributions a licence asks for (CC BY) and the notices that ship with code Fuobe
 * installs (the MIT notices kept in DBS's THIRD_PARTY.md). Information, like everything here.
 */
export interface Attribution {
  /** What it is for, as the list names it. */
  for: string;
  /** The credit, as it should read. */
  text: string;
  licence: string;
  url?: string;
  /** What the admin should also know (an open licence question), shown under the credit. */
  note?: string;
}

export const ATTRIBUTIONS: Attribution[] = [
  {
    for: "Dialogue, music and effects separation",
    text: "Trained on the Divide and Remaster (DnR) v2 dataset by Darius Petermann, Gordon Wichern, Zhong-Qiu Wang and Jonathan Le Roux",
    licence: "CC BY 4.0",
    url: "https://zenodo.org/records/6949108",
    note: "Some of its clips carry their own licences.",
  },
  { for: "Dialogue, music and effects separation", text: "BS-RoFormer, copyright (c) 2023 Phil Wang", licence: "MIT", url: "https://github.com/lucidrains/BS-RoFormer" },
  { for: "Dialogue, music and effects separation", text: "Music-Source-Separation-Training, copyright (c) 2024 Roman Solovyev (ZFTurbo)", licence: "MIT", url: "https://github.com/ZFTurbo/Music-Source-Separation-Training" },
  { for: "Dialogue, music and effects separation", text: "TIGER / Look2Hear, copyright (c) 2026 Kai Li", licence: "MIT", url: "https://github.com/JusperLee/TIGER" },
  {
    for: "Clean up voice",
    text: "RE-USE speech enhancement model, copyright (c) 2026 NVIDIA Corporation",
    licence: "OpenMDW-1.1",
    url: "https://huggingface.co/nvidia/NVIDIA-NemotronLabs-RE-USE",
    note: "Trained in part on WSJ (LDC) and an internal NVIDIA set (model card). The older nvidia/RE-USE repository is non-commercial (NSCLv1); Fuobe uses only the NemotronLabs repositories.",
  },
  {
    for: "Genjutsu: Group swap, Scene edit, From picture, Fix faces and Fix colours",
    text: "Openjutsu, copyright (c) 2026 D3voz: the graphs Fuobe sends to your GPU, the settings code Fuobe ported from it, the SolarRenderer long-clip patch and the 17 light looks' wording",
    licence: "MIT",
    url: "https://github.com/D3voz/openjutsu",
  },
  {
    for: "The Layout Poster skill and Plan layout",
    text: "Adapted from MOSS-Image's prompt-enhancer skill and its layout reference (commit 2b46b1e), copyright OpenMOSS",
    licence: "Apache-2.0",
    url: "https://github.com/OpenMOSS/MOSS-Image",
  },
  {
    for: "the Pika H3 Flex modes of MiniMax H3 on your GPU (Fast · Pika Flex, References, Talk from a voice clip)",
    text: "Pika H3 Flex FL2VA and Ref2VA adapters, copyright © 2026 Mellis, Inc.",
    licence: "MiniMax H3 Community License",
    url: "https://huggingface.co/Pika-Labs/Pika-H3-Flex",
    note: "Model Derivatives of MiniMax H3 (copyright © 2026 MiniMax). Pika's NOTICE and LICENSE stay with the files; Pika's example code is Apache-2.0.",
  },
];

/** The parts of a LoRA's licence snapshot the class needs (src/lib/catalog/types.ts LoraLicence). */
interface LoraLicenceLike {
  commercial: boolean;
  hostedOk: boolean;
  snapshotDate?: string;
  name?: string;
}

/**
 * A LoRA's licence as information: commercial and hostable, commercial on your GPU only (civitai lists no
 * "Rent": a condition), non-commercial, or not recorded. `page` is its model card.
 */
export function loraLicenceInfo(l: LoraLicenceLike | undefined, page?: string, extra?: string): LicenceInfo {
  if (!l) return { name: "Your own", class: "commercial", note: "A LoRA you trained or added yourself", ...(page && { url: page }) };
  const recorded = l.name?.trim();
  const unknown = !recorded || /unspecified|no licen[cs]e|check (?:the )?card/i.test(recorded);
  const cls: LicenceClass = unknown && !l.commercial ? "unknown" : !l.commercial ? "non-commercial" : !l.hostedOk ? "conditions" : "commercial";
  const what = !l.commercial ? "Outputs may not be sold" : l.hostedOk ? "Commercial use, on your GPU and in the cloud" : "Commercial use on your GPU; the licence doesn't allow running it on another hosted service";
  const note = [what, recorded && `licence as read: ${recorded}`, l.snapshotDate && `read ${l.snapshotDate}`, extra].filter(Boolean).join(" · ");
  return { name: unknown ? "Not recorded" : (KNOWN.find((k) => k.re.test(recorded!))?.name ?? recorded!), class: cls, note, ...(page && { url: page }) };
}
