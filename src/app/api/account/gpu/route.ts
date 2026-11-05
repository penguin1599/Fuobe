import { connection } from "next/server";
import { z } from "zod";
import { checkGpuAddress, computerView, GpuError, noteGpuState, testGpu, type AddressFix } from "@/server/account-gpu";
import { addressFixNote, canSaveAnyway, checksTooFast } from "@/lib/diagnose";
import { accountGpu, gpuLink, requestAccount, setAccountGpu } from "@/server/auth";
import { ACCOUNT_LIMITS, ACCOUNT_MESSAGES } from "@/server/account-files";
import { clearAccountLoras } from "@/server/account-loras";
import { forgetComputer } from "@/server/computer/tasks";
import { dropSnapshots } from "@/server/gpu/snapshots";
import { hit } from "@/server/rate";

/**
 * "Your GPU" (public sign-up): the account's own ComfyUI, where its runs go. Either the ComfyUI on the person's own
 * computer, which their Fuobe tab runs ({ mode: "computer" }), or one at a public address (a link). GET says what is
 * connected (never the token; for a computer, what its tab last said about it); PUT connects: a computer at once, a
 * link after checking the address and asking the ComfyUI for /system_stats (`?test=1`: check only; `saved: true`: the
 * saved address again; `anyway: true`: saved while its GPU is off). A check that fails answers 422 with plain words and
 * what helps (`trouble`, src/lib/diagnose.ts); DELETE disconnects (a computer's runs still waiting stop). Accounts only:
 * the owner's ComfyUI is in Settings.
 */
const account = async (request: Request) => requestAccount(request);

const notAccount = () => Response.json({ error: "Log in to connect your GPU." }, { status: 400 });

/** What a computer's tab last said: its GPU, memory, ComfyUI version and port, and whether it is open now. */
const accountComputer = (id: string) => computerView(`acct:${id}`);

export async function GET(request: Request) {
  await connection();
  const a = await account(request);
  if (!a) return notAccount();
  const gpu = accountGpu(a.id);
  if (gpu?.mode === "computer") return Response.json({ gpu: accountComputer(a.id) });
  const link = gpuLink(gpu);
  return Response.json({ gpu: link ? { mode: "link", url: link.url, hasToken: !!link.token } : null });
}

/**
 * A link: `url` (and `token`), or `saved: true` to check the saved address again (Check my GPU). `anyway: true` saves an
 * address whose GPU is off right now (a stopped pod, a GPU starting up): runs wait for it.
 */
const Body = z.union([
  z.object({ mode: z.literal("computer") }).strict(),
  z
    .object({ mode: z.literal("link").optional(), url: z.string().min(1).max(500).optional(), token: z.string().max(500).optional(), saved: z.literal(true).optional(), anyway: z.literal(true).optional() })
    .refine((b) => !!b.url || !!b.saved),
]);

/** A failed check, in plain words with what helps (diagnose.ts); `url`: the address as the check made it whole. */
const troubled = (e: GpuError, url?: string) => Response.json({ error: e.message, trouble: e.trouble, ...(url && { url }) }, { status: 422 });

export async function PUT(request: Request) {
  const a = await account(request);
  if (!a) return notAccount();
  // Each check makes the server call the address: a few a minute. The answer says when the next one goes.
  const rate = hit(`gpu:${a.id}`, ACCOUNT_LIMITS.gpuChecksPerMinute, 60_000);
  if (!rate.ok) return Response.json({ error: ACCOUNT_MESSAGES.gpuChecks, trouble: checksTooFast(rate.retryAfterS) }, { status: 429, headers: { "Retry-After": String(rate.retryAfterS) } });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Enter your ComfyUI's address" }, { status: 400 });
  const before = accountGpu(a.id);
  // The ComfyUI on this computer: nothing for the server to reach, so nothing to check here (the tab found it).
  if ("mode" in parsed.data && parsed.data.mode === "computer") {
    if (before?.mode !== "computer") {
      setAccountGpu(a.id, { mode: "computer" });
      clearAccountLoras(a.id);
      dropSnapshots(`acct:${a.id}`);
    }
    return Response.json({ gpu: accountComputer(a.id) });
  }
  const body = parsed.data as { url?: string; token?: string; saved?: true; anyway?: true };
  const saved = gpuLink(before);
  // Check my GPU: the saved address and token, asked again now. What it says is what the status strip shows next.
  if (body.saved) {
    if (!saved) return Response.json({ error: "Connect your GPU first." }, { status: 400 });
    try {
      const { url: _moved, ...info } = await testGpu(saved);
      void _moved;
      noteGpuState(a.id, saved.url, true, { info });
      return Response.json({ gpu: { mode: "link", url: saved.url, hasToken: !!saved.token }, info });
    } catch (e) {
      if (!(e instanceof GpuError)) throw e;
      noteGpuState(a.id, saved.url, false, { trouble: e.trouble });
      return troubled(e);
    }
  }
  const test = new URL(request.url).searchParams.get("test") === "1";
  let url: string;
  const fixed: AddressFix[] = [];
  try {
    url = await checkGpuAddress(body.url ?? "", { fixed });
  } catch (e) {
    if (e instanceof GpuError) return troubled(e);
    throw e;
  }
  // A token left empty keeps the saved one when the address is the same.
  const token = body.token?.trim() || (saved?.url === url ? saved.token : undefined);
  const connect = (at: string) => {
    setAccountGpu(a.id, { url: at, token });
    clearAccountLoras(a.id);
    // Runs on the computer stop (saying why): they go to the link from now on.
    if (before?.mode === "computer") forgetComputer(`acct:${a.id}`, "switched");
  };
  // What the check made whole by itself (https:// added, a "?…" left out), said under the field.
  const note = addressFixNote(fixed);
  try {
    const { url: moved, ...info } = await testGpu({ url, token });
    // An http:// address that sends to its own https://: the https one is kept.
    const at = moved ?? url;
    if (!test) {
      connect(at);
      noteGpuState(a.id, at, true, { info });
    }
    return Response.json({ gpu: { mode: "link", url: at, hasToken: !!token }, info, ...(note && { note }), ...((note || moved) && { url: at }) });
  } catch (e) {
    if (!(e instanceof GpuError)) throw e;
    // Saved anyway: a GPU that is off right now (a stopped pod, one starting up). Its runs wait for it.
    if (!test && body.anyway && canSaveAnyway(e.trouble.cause)) {
      connect(url);
      noteGpuState(a.id, url, false, { trouble: e.trouble });
      return Response.json({ gpu: { mode: "link", url, hasToken: !!token }, offline: true, error: e.message, trouble: e.trouble, ...(note && { note, url }) });
    }
    return troubled(e, note ? url : undefined);
  }
}

export async function DELETE(request: Request) {
  const a = await account(request);
  if (!a) return notAccount();
  setAccountGpu(a.id, null);
  clearAccountLoras(a.id);
  forgetComputer(`acct:${a.id}`);
  return Response.json({ gpu: null });
}
