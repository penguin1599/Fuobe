/**
 * Upscale targets as plain math: a resolution tier names the result's shorter edge (1080p = 1080 px,
 * 4K = 2160 px, whatever the shape), and APIs that take a factor get target ÷ the clip's shorter edge.
 */

/** The shorter edge a tier asks for: "720p" 720, "1080p" 1080, "1440p" / "2K" 1440, "2160p" / "4K" 2160, "8K" 4320. */
export function targetShortEdge(resolution: string | undefined): number | undefined {
  const v = resolution?.trim().toLowerCase();
  if (!v) return undefined;
  const p = /^(\d{3,4})p$/.exec(v);
  if (p) return Number(p[1]);
  const k = /^(\d+(?:\.\d+)?)k$/.exec(v);
  if (!k) return undefined;
  // Marketing "K" tiers: 1K = 1080p, 2K = 1440p, 4K = 2160p, 6K = 3240p, 8K = 4320p.
  const n = Number(k[1]);
  return n === 1 ? 1080 : n === 2 ? 1440 : Math.round(n * 540);
}

/** A factor tier ("2x", "2.25x", "4x": Kandinsky VSR picks a factor, not a size) as its number. */
export function factorTier(resolution: string | undefined): number | undefined {
  const m = /^(\d+(?:\.\d+)?)x$/i.exec(resolution?.trim() ?? "");
  return m ? Number(m[1]) : undefined;
}

/**
 * A model that upscales by factors only (Kandinsky VSR's 2x, 2.25x and 4x, on both engines) and a resolution that isn't one of
 * them (an API call, a chain, Reuse from another upscaler): refused before the run, in the words the server answers with.
 */
export function factorTierProblem(name: string, offered: string[] | undefined, resolution: string | undefined): string | null {
  if (!offered?.length || resolution === undefined || offered.includes(resolution)) return null;
  if (!offered.every((r) => factorTier(r) !== undefined)) return null;
  return `${name} upscales by ${offered.slice(0, -1).join(", ")} or ${offered.at(-1)}: pick one of those`;
}

/**
 * A clip whose sides a factor can't take (ModelOptions.sideMultiple: fal's Kandinsky VSR needs widths and heights in
 * multiples of 16 at 2x and 4x), with the factor that can, in the words the composer shows and the server refuses with.
 */
export function sideMultipleProblem(
  name: string,
  rule: { of: number; factors: string[] } | undefined,
  offered: string[] | undefined,
  resolution: string | undefined,
  source: { width: number; height: number } | undefined,
): string | null {
  if (!rule || !resolution || !rule.factors.includes(resolution) || !source?.width || !source.height) return null;
  if (source.width % rule.of === 0 && source.height % rule.of === 0) return null;
  const other = (offered ?? []).find((r) => !rule.factors.includes(r));
  return `${name} at ${resolution} needs a clip whose width and height are multiples of ${rule.of} (this one is ${source.width}×${source.height})${other ? `: pick ${other}, or resize the clip first` : ": resize the clip first"}`;
}

/**
 * The factor an upscaler that takes one needs to reach `resolution` from a clip of `source` size: target ÷
 * shorter edge, kept within the API's min–max and rounded to 3 decimals (1080p → 1440p is 1.333, which lands on
 * 2560×1440; 1.33 would make 2554×1436). "Original" is 1 (enhance only).
 * Undefined when the size or the tier is unknown.
 */
export function upscaleFactorFor(resolution: string | undefined, source: { width: number; height: number } | undefined, min = 1, max = 4): number | undefined {
  const lo = Math.min(min, max);
  if (resolution?.trim().toLowerCase() === "original") return Math.max(lo, 1);
  const factor = factorTier(resolution);
  if (factor !== undefined) return Math.max(lo, Math.min(Math.max(min, max), factor));
  const target = targetShortEdge(resolution);
  const short = source ? Math.min(source.width, source.height) : 0;
  if (!target || !(short > 0)) return undefined;
  return Math.round(Math.max(lo, Math.min(max, target / short)) * 1000) / 1000;
}

/** The size a clip comes out at for `resolution` (its shape kept, even numbers), or undefined when unknown. */
export function upscaledSize(source: { width: number; height: number } | undefined, resolution: string | undefined, factor?: number): { width: number; height: number } | undefined {
  if (!source?.width || !source.height) return undefined;
  const k = factor ?? factorTier(resolution) ?? (resolution?.trim().toLowerCase() === "original" ? 1 : (targetShortEdge(resolution) ?? 0) / Math.min(source.width, source.height));
  if (!(k > 0)) return undefined;
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(source.width * k), height: even(source.height * k) };
}

/**
 * Why an upscale to `resolution` would not enlarge a clip whose shorter edge is `short` px (null when it does,
 * or when the tier is "Original" / unknown): the same words the composer shows and the server refuses with.
 */
export function upscaleProblem(resolution: string | undefined, offered: string[] | undefined, short: number): string | null {
  const target = targetShortEdge(resolution);
  if (!target || !(short > 0) || target > short) return null;
  const higher = (offered ?? []).some((r) => (targetShortEdge(r) ?? 0) > short);
  const original = (offered ?? []).some((r) => r.toLowerCase() === "original");
  const shrink = target < short ? `: ${resolution} would make it smaller` : "";
  const next = higher ? " — pick a higher resolution" : " — this model upscales no further";
  return `This clip is already ${short}p${shrink}${next}${original ? ", or Original to only clean it up" : ""}`;
}

/**
 * The tier an upscale runs at for a clip of `source` size: the one asked for when it enlarges the clip. A
 * tier the model only defaulted to (`picked` false) moves up to the smallest offered tier that does, else to
 * "Original" (clean-up only) when the model offers it; a tier the caller picked that doesn't is refused.
 */
export function upscaleTier(
  resolution: string | undefined,
  offered: string[] | undefined,
  source: { width: number; height: number } | undefined,
  picked: boolean,
): { resolution: string | undefined } | { error: string } {
  const short = source ? Math.min(source.width, source.height) : 0;
  const problem = upscaleProblem(resolution, offered, short);
  if (!problem) return { resolution };
  if (picked) return { error: problem };
  const up = (offered ?? [])
    .map((r) => ({ r, edge: targetShortEdge(r) ?? 0 }))
    .filter((t) => t.edge > short)
    .sort((a, b) => a.edge - b.edge)[0]?.r;
  const original = (offered ?? []).find((r) => r.toLowerCase() === "original");
  return up || original ? { resolution: up ?? original } : { error: problem };
}
