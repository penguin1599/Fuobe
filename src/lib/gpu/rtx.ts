/**
 * NVIDIA RTX cards, read from the name ComfyUI reports ("cuda:0 NVIDIA GeForce RTX 4070 : cudaMallocAsync", or the short
 * "RTX 4070" the badges carry). The NVIDIA RTX Video nodes (Comfy-Org's ComfyUI Nvidia VFX Nodes) run only on an NVIDIA RTX
 * card, and their frame generation only on the RTX 40 series or later. Pure: the server's readiness and the browser's
 * choosers use the same reading.
 */

/** What a graph's nodes need of the card (manifest / requirements.json `gpu`). */
export type GpuNeed = "nvidia-rtx" | "nvidia-rtx-40";

export interface CardReading {
  /** true: an NVIDIA RTX card; false: certainly not one (a CPU, Apple, AMD, Intel or a GTX card); undefined: can't tell. */
  rtx: boolean | undefined;
  /** The RTX generation as a series number (20, 30, 40, 50), when the name says. */
  series?: number;
}

/**
 * Read a card's name. Data-centre cards with no "RTX" in their name (A100, L40S, H100…) can't be told apart by name, so
 * they read as unknown: they are never blocked and never picked automatically.
 */
export function readCard(name: string | undefined, type?: string): CardReading {
  const n = (name ?? "").replace(/^(cuda|xpu|mps|cpu)(:\d+)?\s+/i, "").trim();
  if (type && type !== "cuda") return { rtx: false };
  if (!n) return { rtx: type === undefined ? undefined : false };
  // ROCm reports its cards as "cuda" devices; Intel and Apple have their own device types.
  if (/\b(AMD|Radeon|Instinct|Intel|Arc|Apple|M\d( Pro| Max| Ultra)?)\b/i.test(n) || /^cpu$/i.test(n)) return { rtx: false };
  // NVIDIA's DGX Spark (GB10, Blackwell, Linux arm64): the pack's README lists it, but NVIDIA's nvidia-vfx runtime has no
  // arm64 Linux wheel yet, so it reads as unknown: never blocked, never put first.
  if (/\bGB10\b/i.test(n)) return { rtx: undefined };
  if (/\bRTX\b/i.test(n)) return { rtx: true, ...seriesOf(n) };
  // GeForce GTX / older Quadro and Tesla cards have no RTX Video support.
  if (/\b(GTX|GT \d|Quadro (?!RTX)|Tesla [KMP]\d|TITAN (X|V|Xp))\b/i.test(n)) return { rtx: false };
  return { rtx: undefined };
}

function seriesOf(n: string): { series?: number } {
  // Professional cards by architecture: RTX A-series (Ampere), "Ada Generation", "Blackwell"; Quadro RTX / TITAN RTX (Turing).
  if (/Blackwell/i.test(n)) return { series: 50 };
  if (/\bAda\b/i.test(n)) return { series: 40 };
  if (/\bRTX\s*A\d{3,4}\b/i.test(n)) return { series: 30 };
  if (/Quadro RTX|TITAN RTX/i.test(n)) return { series: 20 };
  // GeForce RTX 2060 … 5090 (and laptop parts): the first two digits.
  const m = /\bRTX\s*(\d{2})\d{2}\b/i.exec(n);
  if (m) return { series: Number(m[1]) };
  return {};
}

/** Whether a card can run nodes that need `need`: true / false, or undefined when its name doesn't say. */
export function cardFits(need: GpuNeed, card: CardReading): boolean | undefined {
  if (card.rtx !== true) return card.rtx;
  if (need === "nvidia-rtx-40") return card.series === undefined ? undefined : card.series >= 40;
  return true;
}

/** The plain line a pre-flight row, a chip and a chooser show. */
export const GPU_NEED_TEXT: Record<GpuNeed, string> = {
  "nvidia-rtx": "Needs an NVIDIA RTX card",
  "nvidia-rtx-40": "Needs an NVIDIA RTX 40 series card or newer",
};

/** Whether to offer (and put first) a choice that needs `need` on this card: only a card known to fit, never a guess. */
export function offerOn(need: GpuNeed, gpuName: string | undefined): boolean {
  return !!gpuName && cardFits(need, readCard(gpuName)) === true;
}
