import { bodyTooBig, guestRun, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { startStep, transcribeClip, TranscribeSchema, transcribeRequest } from "@/server/genjutsu";
import { body, handle } from "@/server/shorts-schemas";

/**
 * The clip's words for Character swap's "What's said": one transcription the page picks the part's lines from. The
 * owner's, or an account's on its own GPU or key (src/server/account-tool-run.ts), "Clean the voice first" included: it
 * runs there before it has passed on this studio's GPU (src/lib/own-setup.ts).
 */
export async function POST(request: Request) {
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "account") {
    const big = bodyTooBig(request);
    if (big) return big;
  }
  return handle(async () => {
    const input = await body(request, TranscribeSchema, "Add a clip first");
    if (viewer.kind === "owner") return Response.json(transcribeClip(input), { status: 201 });
    const r = await runAccountTool(request, viewer.account, {
      tool: "genjutsu",
      files: [input.source.url],
      plan: () => [{ request: transcribeRequest(input) }],
      start: () => startStep(transcribeRequest(input)),
    });
    return r.ok ? Response.json(r.value, { status: 201 }) : r.response;
  }, request);
}
