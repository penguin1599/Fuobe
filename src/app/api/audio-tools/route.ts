import { bodyTooBig, guestRun, onceForAccount, priceAsRun, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { AudioToolBody, AudioToolError, audioToolFiles, audioToolSteps, planAudioTool, previewAudioTool, runAudioTool, startAudioTool, type AudioToolPlan } from "@/server/audio-tools";
import { connectRefusal } from "@/server/connect-refusal";
import { ConnectComfyError } from "@/server/generations";

/** What a field that doesn't check out means, in words the page shows. */
const MESSAGES: Record<string, string> = {
  media: "Add the audio or video to split",
  video: "Add the video to put the mix on",
  audio: "Add the audio to loop",
  duration: "Pick a length up to 10 minutes",
  crossfade: "Keep the crossfade between 0 and 10 seconds",
  musicDb: "Lower the music by 0 to 30 dB",
};

/**
 * Audio → Loop / extend, Join, Split soundtrack (and its Clean up dialogue) and Clean up voice (and a split's mix put back on its video), and Video
 * tools → Remove dialogue, and Audio → Edit speech: start a run; `?preview=1` only plans and prices it.
 */
async function post(request: Request, preview: boolean) {
  const viewer = toolViewer(request);
  if (!preview && viewer.kind === "guest") return guestRun();
  const raw: unknown = await request.json().catch(() => null);
  const parsed = AudioToolBody.safeParse(raw);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join(".") ?? "";
    const tool = (raw as { tool?: unknown } | null)?.tool;
    const msg = path.startsWith("clips")
      ? "Add 2 to 10 audio clips to join"
      : tool === "remux" && path === "audio"
        ? "Export the mix first"
        : tool === "remove-dialogue" && path === "video"
          ? "Add the video to take the dialogue out of"
          : (tool === "clean" || tool === "clean-dialogue") && path === "media"
            ? "Add the audio or video to clean"
            : tool === "speech-edit"
              ? path === "media"
                ? "Add the recording to edit"
                : path.startsWith("cues") || path.startsWith("edited")
                  ? "Transcribe the recording first, then edit its lines"
                  : "Pick one of the offered settings for the effect"
              : (MESSAGES[path] ?? "Check the settings");
    return Response.json({ error: msg }, { status: 400 });
  }
  if (!preview && viewer.kind === "account") {
    // An account's run: on its own GPU or key, with its own files, after the checks a studio run gets.
    const body = parsed.data;
    let planned: AudioToolPlan | null = null;
    return onceForAccount(
      viewer.account,
      "audio-tools",
      undefined,
      () =>
        runAccountTool(request, viewer.account, {
          tool: `audio-${body.tool}`,
          files: audioToolFiles(body),
          plan: () => audioToolSteps((planned = planAudioTool(body))),
          start: () => startAudioTool(planned!),
        }),
      ({ value, gpuWarning }) => Response.json({ ...value, ...(gpuWarning && { gpuWarning }) }, { status: 201, headers: { "Cache-Control": "no-store" } }),
    );
  }
  try {
    if (preview) return Response.json(await previewAudioTool(parsed.data));
    return Response.json(await runAudioTool(parsed.data), { status: 201 });
  } catch (e) {
    if (e instanceof AudioToolError) return Response.json({ error: e.message }, { status: 422 });
    // Nothing connected runs it: the connect card in the owner's browser (a price check just says so).
    if (e instanceof ConnectComfyError) return connectRefusal(e, request, preview) ?? Response.json({ error: e.message }, { status: 422 });
    console.error("[audio-tools]", e);
    return Response.json({ error: (e as Error).message || "Something went wrong" }, { status: 500 });
  }
}

/**
 * The owner runs as always. A signed-in account runs on its own GPU or its own fal.ai or Replicate key, and its price
 * check is its own run's (src/server/account-tool-run.ts priceAsRun); a guest's price check is the open engine's, and
 * its run gets the sign-up card.
 */
export async function POST(request: Request) {
  const preview = new URL(request.url).searchParams.get("preview") === "1";
  if (toolViewer(request).kind === "account") {
    const big = bodyTooBig(request);
    if (big) return big;
  }
  return preview ? priceAsRun(request, () => post(request, true)) : post(request, false);
}
