// What each score means, which way is better, and how big a difference is noise. The Python side
// (metrics/fuobe_metrics/registry.py) writes the same keys; timing and cost come from the runner.

/** @type {Record<string, { label: string, better: "higher" | "lower" | "none", unit: string, tie: number, digits: number }>} */
export const METRIC_INFO = {
  clip: { label: "CLIP prompt adherence", better: "higher", unit: "CLIPScore 0–100", tie: 0.5, digits: 1 },
  aesthetic: { label: "Aesthetic (LAION v2)", better: "higher", unit: "1–10", tie: 0.05, digits: 2 },
  style: { label: "Style vs references", better: "higher", unit: "cosine", tie: 0.005, digits: 3 },
  styleNearest: { label: "Style, nearest reference", better: "higher", unit: "cosine", tie: 0.005, digits: 3 },
  identity: { label: "Identity vs references", better: "higher", unit: "cosine", tie: 0.01, digits: 3 },
  faceRate: { label: "Frames with a face", better: "higher", unit: "0–1", tie: 0.01, digits: 2 },
  drift: { label: "Frame-to-frame drift", better: "lower", unit: "1 − cosine", tie: 0.002, digits: 4 },
  driftMax: { label: "Worst frame jump", better: "lower", unit: "1 − cosine", tie: 0.005, digits: 4 },
  warp: { label: "Warp error (flicker)", better: "lower", unit: "0–1", tie: 0.001, digits: 4 },
  lipsync: { label: "Lip-sync proxy", better: "higher", unit: "Pearson r", tie: 0.02, digits: 3 },
  lipsyncOffset: { label: "A/V offset", better: "none", unit: "frames", tie: 0, digits: 0 },
  syncnet: { label: "SyncNet confidence", better: "higher", unit: "conf", tie: 0.1, digits: 2 },
  continuity: { label: "Shot continuity", better: "higher", unit: "cosine", tie: 0.005, digits: 3 },
  paletteFit: { label: "Palette distance", better: "lower", unit: "mean ΔE76", tie: 0.5, digits: 1 },
  paletteCover: { label: "Palette used", better: "higher", unit: "0–1", tie: 0.05, digits: 2 },
  voiceSiSdr: { label: "Dialogue SI-SDR", better: "higher", unit: "dB", tie: 0.3, digits: 1 },
  remixSiSdr: { label: "Clean dialogue SI-SDR", better: "higher", unit: "dB vs voice + bed at the level asked", tie: 0.3, digits: 1 },
  musicSiSdr: { label: "Music SI-SDR", better: "higher", unit: "dB", tie: 0.3, digits: 1 },
  effectsSiSdr: { label: "Effects SI-SDR", better: "higher", unit: "dB", tie: 0.3, digits: 1 },
  backgroundSiSdr: { label: "Music & effects SI-SDR", better: "higher", unit: "dB", tie: 0.3, digits: 1 },
  voiceSdr: { label: "Dialogue SDR", better: "higher", unit: "dB", tie: 0.3, digits: 1 },
  backgroundSdr: { label: "Music & effects SDR", better: "higher", unit: "dB", tie: 0.3, digits: 1 },
  mixError: { label: "Stems vs input", better: "lower", unit: "dB under the input", tie: 3, digits: 1 },
  bedLevel: { label: "Bed level vs reference", better: "none", unit: "dB", tie: 0, digits: 2 },
  bedPeak: { label: "Bed peak", better: "none", unit: "dBFS", tie: 0, digits: 2 },
  bedScale: { label: "Bed scaling", better: "none", unit: "dB vs input − voice (0 = as subtracted)", tie: 0, digits: 2 },
  stereoCorrGap: { label: "Bed stereo gap", better: "lower", unit: "|Δ L/R correlation|", tie: 0.02, digits: 3 },
  noiseInVoice: { label: "Noise left in the dialogue", better: "lower", unit: "share of the known noise", tie: 0.03, digits: 2 },
  speedX: { label: "Speed", better: "higher", unit: "x real time", tie: 0.02, digits: 2 },
  wer: { label: "WER, dialogue stem", better: "lower", unit: "0–1", tie: 0.02, digits: 3 },
  werInput: { label: "WER, input as is", better: "lower", unit: "0–1", tie: 0.02, digits: 3 },
  werTranscript: { label: "WER, the job's transcript", better: "lower", unit: "0–1", tie: 0.02, digits: 3 },
  bgDiff: { label: "Background change vs the source", better: "lower", unit: "0–1", tie: 0.002, digits: 4 },
  bgPsnr: { label: "Background PSNR vs the source", better: "higher", unit: "dB", tie: 0.3, digits: 1 },
  haze: { label: "Splat haze", better: "lower", unit: "share under opacity 0.05", tie: 0.01, digits: 3 },
  gaussians: { label: "Gaussians", better: "none", unit: "count", tie: 0, digits: 0 },
  seconds: { label: "Time", better: "lower", unit: "s (wall clock)", tie: 0.5, digits: 1 },
  costUsd: { label: "Cost", better: "lower", unit: "US$", tie: 0.0005, digits: 4 },
  vramGb: { label: "Peak memory", better: "lower", unit: "GB", tie: 0.1, digits: 2 },
};

/** Keys in the order reports show them. */
export const METRIC_ORDER = Object.keys(METRIC_INFO);

/** b against a: "win" when b is better by more than the metric's tie band, "loss" when worse, else "tie". */
export function verdict(metric, a, b) {
  const info = METRIC_INFO[metric];
  if (!info || info.better === "none" || a == null || b == null || Number.isNaN(a) || Number.isNaN(b)) return null;
  const gain = info.better === "higher" ? b - a : a - b;
  return gain > info.tie ? "win" : gain < -info.tie ? "loss" : "tie";
}

/** b − a, signed so that positive is better. */
export function gain(metric, a, b) {
  const info = METRIC_INFO[metric];
  if (!info || a == null || b == null) return null;
  return info.better === "lower" ? a - b : b - a;
}

export const fmt = (metric, v) => (v == null || Number.isNaN(v) ? "–" : Number(v).toFixed(METRIC_INFO[metric]?.digits ?? 3));
