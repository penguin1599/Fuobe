import "server-only";
import type { EpisodeSettings, ExplainerSource } from "@/lib/catalog/faceless";
import { AccountProjectError, projectRefsProblem } from "./account-projects";
import { FacelessError } from "./faceless";
import { hit } from "./rate";
import { ShortsError } from "./shorts";

/**
 * The account side of the routes of Faceless Studio, the Explainer and Content Factory (public sign-up). A signed-in
 * account's channels, episodes, explainers and series are its own (src/server/faceless.ts, content-factory.ts), and
 * every render, reading or picture of its runs on its own GPU or key after the checks a studio run gets
 * (src/server/account-tool-run.ts runAccountTool). These are the small pieces its routes share.
 */

/** A plan's refusal keeps its status through runAccountTool (it keeps a ShortsError's, and answers 422 for the rest). */
export async function planned<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof FacelessError || e instanceof AccountProjectError) throw new ShortsError(e.message, e.status);
    throw e;
  }
}

/** The files an episode's (or a channel's) settings name: its style pictures, its narrator's sample, its music clip. */
export function settingsFiles(s?: Partial<Pick<EpisodeSettings, "styleRefs" | "voice" | "bedClip" | "sourceImages">> | null): string[] {
  if (!s) return [];
  return [...(s.styleRefs ?? []), ...(s.voice?.kind === "sample" ? [s.voice.url] : []), ...(s.bedClip ? [s.bedClip.url] : []), ...(s.sourceImages ?? [])];
}

/** The pictures an explainer's sources name. */
export const sourceFiles = (sources?: ExplainerSource[]): string[] => (sources ?? []).flatMap((s) => (s.kind === "image" ? [s.url] : []));

/** An account's request that names a file that isn't its own (or one of Fuobe's published examples): its answer, or null. */
export function filesRefused(accountId: string, files: (string | null | undefined)[]): Response | null {
  const problem = projectRefsProblem(accountId, { files: files.filter((f): f is string => !!f) });
  return problem ? Response.json({ error: problem.error, code: problem.code }, { status: problem.status, headers: { "Cache-Control": "no-store" } }) : null;
}

/** Documents an account has read for it in an hour (an explainer's PDF or Word source). */
export const READS_PER_HOUR = 30;

/** An account's document read past its hour: 429, or null. */
export function readsLimited(accountId: string): Response | null {
  const rate = hit(`faceless-read:${accountId}`, READS_PER_HOUR, 60 * 60_000);
  return rate.ok ? null : Response.json({ error: "You've added a lot of files this hour. Try again later." }, { status: 429, headers: { "Retry-After": String(rate.retryAfterS) } });
}
