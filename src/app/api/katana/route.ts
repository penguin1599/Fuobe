import { connection } from "next/server";
import { bodyTooBig, guestRun, onceForAccount, priceAsRun, runAccountTool, toolViewer } from "@/server/account-tool-run";
import { asAccount } from "@/server/generations";
import { createKatana, KatanaBody, katanaRoom, katanaRunSteps, listKatana, planKatanaRun, previewKatana, startKatana, type KatanaRun } from "@/server/katana";
import { connectRefusal } from "@/server/connect-refusal";

/**
 * Recent Katana runs with the state of every step: the owner's, or a signed-in account's own (its jobs are its own
 * projects, src/server/katana.ts). A guest's list is empty (the proxy answers it).
 */
export async function GET(request: Request) {
  await connection();
  const viewer = toolViewer(request);
  if (viewer.kind === "guest") return Response.json({ items: [] });
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? 20);
  const list = () => listKatana(Number.isFinite(limit) ? limit : 20);
  return Response.json({ items: viewer.kind === "account" ? asAccount(viewer.account.id, list) : list() }, { headers: { "Cache-Control": "no-store" } });
}

const badBody = (path: string) =>
  Response.json(
    { error: path === "reference" ? "Add the reference edit" : path === "photos" ? "Add 1–5 photos of your subject" : path === "instructions" ? "Keep the instructions under 2,000 characters" : "Check the Katana settings" },
    { status: 400 },
  );

/**
 * Start a run; `?preview=1` only plans and prices it (segments, steps, cost). The owner's run as always; an account's on
 * its own GPU or its own fal.ai or Replicate key, with its own files, after the checks every tool run gets
 * (src/server/account-tool-run.ts), kept as its own job; a guest signs up first.
 */
export async function POST(request: Request) {
  const preview = new URL(request.url).searchParams.get("preview") === "1";
  const viewer = toolViewer(request);
  if (preview) return priceAsRun(request, () => post(request, true));
  if (viewer.kind === "guest") return guestRun();
  if (viewer.kind === "owner") return post(request, false);
  const big = bodyTooBig(request);
  if (big) return big;
  const parsed = KatanaBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badBody(String(parsed.error.issues[0]?.path[0] ?? ""));
  const input = parsed.data;
  const account = viewer.account;
  let run: KatanaRun | null = null;
  return onceForAccount(
    account,
    "katana",
    request.headers.get("x-request-id") ?? undefined,
    () =>
      runAccountTool(request, account, {
        tool: "katana",
        files: [input.reference, ...input.photos],
        plan: () => {
          katanaRoom(account.id);
          return katanaRunSteps((run = planKatanaRun(input)));
        },
        start: () => startKatana(run!),
      }),
    ({ value }) => Response.json(value, { status: 201 }),
  );
}

async function post(request: Request, preview: boolean) {
  const parsed = KatanaBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badBody(String(parsed.error.issues[0]?.path[0] ?? ""));
  try {
    if (preview) return Response.json(previewKatana(parsed.data));
    return Response.json(createKatana(parsed.data), { status: 201 });
  } catch (e) {
    // Nothing connected runs it: the connect card in the owner's browser (never on a price check).
    return connectRefusal(e, request, preview) ?? Response.json({ error: (e as Error).message }, { status: 422 });
  }
}
