import "server-only";
import { z } from "zod";
import { asViewer, bodyTooBig, guestRun, onceForAccount, priceAsRun, runAccountTool, toolViewer } from "./account-tool-run";
import { projectRefused, projectSavesLimited } from "./account-projects";
import { refusedRun } from "./connect-refusal";
import type { PlannedStep } from "./photodump";

/**
 * The photo apps' runs over HTTP: Photodump, Fashion Factory, Character Sheet, AI Influencer and a photo's retry. The
 * owner's run as always; an account's on its own GPU or its own fal.ai or Replicate key, with its own files, after the
 * checks a studio run gets (src/server/account-tool-run.ts); a guest signs up first. A price check (`?preview=1`) is
 * priced as the asker's run would go (priceAsRun), for everyone.
 */

/** A client's id for one press of Generate: a repeat gets the run the first one started (an account's own only). */
export const RequestId = z.string().trim().min(8).max(64).optional();

const isPreview = (request: Request) => !!new URL(request.url).searchParams.get("preview");

/**
 * Before the body is read: a guest's run gets the sign-up card, and an account's body over what a run may weigh a 413.
 * Null: read the body and go on.
 */
export function photoRunGate(request: Request): Response | null {
  if (isPreview(request)) return null;
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  return viewer.kind === "account" ? bodyTooBig(request) : null;
}

export interface PhotoRun<T> {
  /** The tool, for an account's repeat key and its run limit ("photodump"). */
  tool: string;
  /** Every file the body names: only the account's own (its uploads and results). */
  files: (string | null | undefined)[];
  /** The price check's answer. */
  preview: () => unknown;
  /** The steps it will create, planned only (called as the account). */
  steps: () => PlannedStep[];
  /** Creates the run: createGenerations / createPipeline. */
  start: () => T;
}

/** The run (or its price) as the asker's: see the header. */
export async function photoRun<T extends object>(request: Request, requestId: string | undefined, run: PhotoRun<T>): Promise<Response> {
  if (isPreview(request)) return priceAsRun(request, () => Response.json(run.preview()));
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "owner") {
    try {
      return Response.json(run.start(), { status: 201 });
    } catch (e) {
      return refusedRun(e, request);
    }
  }
  return onceForAccount(
    viewer.account,
    run.tool,
    requestId,
    () => runAccountTool(request, viewer.account, { tool: run.tool, files: run.files, plan: run.steps, start: run.start }),
    ({ value, gpuWarning }) => Response.json({ ...value, ...(gpuWarning && { gpuWarning }) }, { status: 201 }),
  );
}

/**
 * A change to an account's own packs or characters: a guest signs up first, an account within its saves a minute, as
 * its own work (asViewer). `fn` throws an AccountProjectError (its status) or an Error (400) to refuse.
 */
export function photoProjectChange(request: Request, fn: () => Response): Response {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const limited = projectSavesLimited(viewer.account.id);
    if (limited) return limited;
  }
  try {
    return asViewer(viewer, fn);
  } catch (e) {
    if (e instanceof Error && e.constructor === Error) return Response.json({ error: e.message }, { status: 400 });
    return projectRefused(e);
  }
}
