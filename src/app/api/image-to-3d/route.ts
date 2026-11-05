import { POST as runGeneration } from "@/app/api/generations/route";
import { getModel } from "@/lib/catalog";
import type { GenerationRequest } from "@/lib/catalog/types";
import { ACCOUNT_LIMITS, ACCOUNT_MESSAGES } from "@/server/account-files";
import { accountInputProblem } from "@/server/account-inputs";
import { accountEngineMode } from "@/server/account-keys";
import { bodyTooBig, guestRun, onceForAccount, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { createGenerations } from "@/server/generations";
import { GenerationRequestSchema } from "@/server/request-schema";

/**
 * Image to 3D's runs: a model from a photo, several photos, words or an object in a photo, a splat, and a finished
 * model's rig or retexture. The body is a generation request, as POST /api/generations takes it (plus an optional
 * `requestId`, and `gpuCheck: "skip"`).
 *
 * The owner's run goes through POST /api/generations, as always. An account's runs on its own GPU or its own fal.ai or
 * Replicate key, with only its own files, after the checks every tool run gets (src/server/account-tool-run.ts), and its
 * model is finished on this server under its own limits (src/server/model3d-finish.ts). A guest signs up first.
 */
export async function POST(request: Request) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "owner") return runGeneration(request);
  const account = viewer.account;
  const big = bodyTooBig(request);
  if (big) return big;
  const text = await request.text().catch(() => "");
  if (Buffer.byteLength(text) > ACCOUNT_LIMITS.runBodyBytes) return refuse(413, ACCOUNT_MESSAGES.bodyTooBig);
  let raw: unknown = null;
  try {
    raw = JSON.parse(text);
  } catch {}
  const parsed = GenerationRequestSchema.safeParse(raw);
  if (!parsed.success) return refuse(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const extra = (raw ?? {}) as { requestId?: unknown; gpuCheck?: unknown };
  const requestId = typeof extra.requestId === "string" && extra.requestId.length <= 100 ? extra.requestId : undefined;
  let req = parsed.data as GenerationRequest;
  // This route makes 3D models only; everything else runs in the studios (POST /api/generations).
  if (getModel(req.modelId)?.kind !== "model3d") return refuse(422, "Pick a 3D model.");
  // As in the studios: without a key of its own the account stays on the open engine, and a run makes up to 4 models.
  req = { ...req, engine: accountEngineMode(account.id) === "open" ? "open" : req.engine };
  const notes: string[] = [];
  if ((req.params?.numOutputs ?? 1) > ACCOUNT_LIMITS.outputsPerRun) {
    req = { ...req, params: { ...req.params, numOutputs: ACCOUNT_LIMITS.outputsPerRun } };
    notes.push(ACCOUNT_MESSAGES.outputsCapped);
  }
  // Every file it names (its photos, the model it rigs, a file in its settings): only its own uploads and results.
  const problem = accountInputProblem(req, account.id);
  if (problem) return refuse(problem.status, problem.error, { code: problem.code });
  const files = Object.values(req.inputs ?? {}).flatMap((v) => (Array.isArray(v) ? v : [v]));
  const run = req;
  return onceForAccount(
    account,
    "image-to-3d",
    requestId,
    () =>
      runAccountTool(request, account, {
        tool: "image-to-3d",
        files,
        plan: () => [{ request: run }],
        start: () => createGenerations(run),
        skipGpuCheck: extra.gpuCheck === "skip",
      }),
    ({ value, gpuWarning }) => {
      const all = [...new Set([...notes, ...value.flatMap((g) => g.notes ?? [])])];
      return Response.json({ items: value, ...(all.length && { notes: all }), ...(gpuWarning && { gpuWarning }) }, { status: 201, headers: { "Cache-Control": "no-store" } });
    },
  );
}

const refuse = (status: number, error: string, more: Record<string, unknown> = {}) => Response.json({ error, ...more }, { status, headers: { "Cache-Control": "no-store" } });
