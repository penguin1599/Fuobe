import { MIX_FEATURE, MIX_MODEL } from "@/lib/av/split";
import { ACCOUNT_LIMITS, ACCOUNT_MESSAGES, accountTotalBytes, accountUsage, diskHasRoom, filesFullMessage } from "@/server/account-files";
import { requestViewer, type Account } from "@/server/auth";
import { gateAsProxy, readBodyWithin } from "@/server/direct-gate";
import { getGeneration, recordLocalGeneration } from "@/server/generations";
import { moderateRun } from "@/server/hosted-run";
import { dropMix, keepMix, MixExportError, PART_MAX, receiveMixPart, type FinishedMix, type MixAccount } from "@/server/mix-export";
import { holdForCheck } from "@/server/output-checks";
import { hit, unhit } from "@/server/rate";
import { runAsTenant } from "@/server/tenant";

/**
 * Split soundtrack's Export mix, in parts: POST the WAV's bytes as the body, `?offset=` where they start, `&id=` from
 * the first part's answer, `&last=1&name=` on the last part, which answers (201) with the Library asset for the owner,
 * or, for an account, with the run it keeps the mix as (its own files and its own runs, never the owner's Library).
 */
export async function POST(request: Request) {
  // The proxy doesn't run on this route (a part is bigger than the 4 MB of a body it holds): its checks run here.
  const denied = gateAsProxy(request);
  if (denied) return denied;
  const viewer = requestViewer(request);
  const account = viewer.kind === "account" ? viewer.account : null;
  const q = new URL(request.url).searchParams;
  const offset = Number(q.get("offset") ?? "0");
  if (!Number.isSafeInteger(offset) || offset < 0) return Response.json({ error: "Say where the part starts (offset)" }, { status: 400 });
  if (account && !diskHasRoom()) return Response.json({ error: ACCOUNT_MESSAGES.diskLow }, { status: 503 });
  // Never more than a part, with or without a Content-Length (a chunked body has none).
  const data = await readBodyWithin(request, PART_MAX);
  if (data === "too-big") return Response.json({ error: "That part is too large" }, { status: 413 });
  if (data === null) return Response.json({ error: "That part didn't arrive whole — export the mix again" }, { status: 400 });
  try {
    const r = receiveMixPart({ id: q.get("id"), offset, data, last: q.get("last") === "1", name: q.get("name"), account: account && mixAccount(account) });
    if (!("file" in r)) return Response.json(r);
    return account ? await keepAsRun(account, r) : Response.json(keepMix(r), { status: 201 });
  } catch (e) {
    if (e instanceof MixExportError) return Response.json({ error: e.message }, { status: e.status });
    console.error("[audio-tools/export]", e);
    return Response.json({ error: (e as Error).message || "Couldn't save the mix" }, { status: 500 });
  }
}

/** The room an account's files have left for a mix: its uploads' share and its whole space. */
function mixAccount(account: Account): MixAccount {
  const usage = accountUsage(account.id);
  const uploads = ACCOUNT_LIMITS.uploadsBytes - usage.uploads;
  const total = accountTotalBytes(account.id) - usage.total;
  return { id: account.id, room: uploads <= total ? { bytes: uploads, message: ACCOUNT_MESSAGES.uploadsFull } : { bytes: total, message: filesFullMessage(account.id) } };
}

/**
 * An account's finished mix, kept as one of its runs: within its hourly run budget and through the studio's checks (a
 * result the checks want to see waits for them), stored in its own files. Nothing is kept when it is refused.
 */
async function keepAsRun(account: Account, done: FinishedMix): Promise<Response> {
  const bucket = `run:${account.id}`;
  const rate = hit(bucket, ACCOUNT_LIMITS.runsPerHour, 60 * 60_000);
  if (!rate.ok) {
    dropMix(done.id);
    return Response.json({ error: ACCOUNT_MESSAGES.runRate }, { status: 429, headers: { "Retry-After": String(rate.retryAfterS), "Cache-Control": "no-store" } });
  }
  const title = done.name.replace(/\.wav$/i, "");
  const place = account.gpu ? ("own-gpu" as const) : account.keys?.fal || account.keys?.replicate ? ("own-key" as const) : ("pool" as const);
  const checked = await moderateRun(account, { feature: MIX_FEATURE, modelId: MIX_MODEL, op: "mix", prompt: title, inputs: {} }, null, "own", { kind: "audio", place });
  if (!checked.ok) {
    unhit(bucket);
    dropMix(done.id);
    return Response.json({ error: checked.refusal.body.error, code: checked.refusal.body.code }, { status: 422, headers: { "Cache-Control": "no-store" } });
  }
  const asset = keepMix(done, account.id);
  const output = { url: asset.url, kind: "audio" as const, contentType: "audio/wav" };
  const g = runAsTenant({ kind: "account", id: account.id }, () => recordLocalGeneration({ feature: MIX_FEATURE, modelId: MIX_MODEL, op: "mix", prompt: title, title, inputs: {}, output }));
  if (!checked.checkOutputs) return Response.json(g, { status: 201, headers: { "Cache-Control": "no-store" } });
  // Held until the output check answers, as any account run's files are.
  holdForCheck(g.id, [{ ...output, assetId: asset.id }]);
  return Response.json(getGeneration(g.id) ?? g, { status: 201, headers: { "Cache-Control": "no-store" } });
}
