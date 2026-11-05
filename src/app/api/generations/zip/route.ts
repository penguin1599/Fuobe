import { connection } from "next/server";
import { GUEST_HEADER, GUEST_LIBRARY_MESSAGE } from "@/lib/guest-access";
import { ACCOUNT_LIMITS, ACCOUNT_MESSAGES } from "@/server/account-files";
import { accountZipBusy, accountZipStream } from "@/server/account-zip";
import { requestViewer } from "@/server/auth";
import { ZIP_MAX_BYTES, zipEntries } from "@/server/library";
import { zipSize, zipStream, type ZipEntry } from "@/server/zip";

const NOTHING = "Nothing finished to download yet";

const zipResponse = (entries: ZipEntry[], size: number, body: ReadableStream<Uint8Array>) =>
  new Response(body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(size),
      "Content-Disposition": `attachment; filename="fuobe-${new Date().toISOString().slice(0, 10)}-${entries.length}-files.zip"`,
      "Cache-Control": "no-store",
    },
  });

/**
 * Download the finished outputs of several generations as one zip: GET ?ids=a,b,c (up to 500).
 *
 * A signed-in account (public sign-up) zips its own runs only: an id that isn't its own is left out, exactly as one
 * that doesn't exist, so the answer never says whether someone else's run is there (none of its own: 404). It zips up
 * to ACCOUNT_LIMITS.zipRuns runs and zipBytes bytes, one zip at a time (429 while one is going). `?check=1` (anyone
 * signed in) answers {files, size} (or the refusal) without the zip, so the page can say why first
 * (src/lib/zip-download.ts). A guest gets the sign-up card.
 */
export async function GET(request: Request) {
  await connection();
  const viewer = requestViewer(request);
  if (viewer.kind === "guest") return Response.json({ error: GUEST_LIBRARY_MESSAGE }, { status: 401, headers: { [GUEST_HEADER]: "1", "Cache-Control": "no-store" } });
  const sp = new URL(request.url).searchParams;
  const ids = (sp.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return Response.json({ error: "Pick something to download" }, { status: 400 });

  if (viewer.kind === "account") {
    const account = viewer.account.id;
    if (new Set(ids).size > ACCOUNT_LIMITS.zipRuns) return Response.json({ error: ACCOUNT_MESSAGES.zipTooMany }, { status: 413 });
    if (accountZipBusy(account)) return Response.json({ error: ACCOUNT_MESSAGES.zipBusy }, { status: 429, headers: { "Retry-After": "30" } });
    const entries = zipEntries(ids, { account });
    if (!entries.length) return Response.json({ error: NOTHING }, { status: 404 });
    const size = zipSize(entries);
    if (size > ACCOUNT_LIMITS.zipBytes) return Response.json({ error: ACCOUNT_MESSAGES.zipTooBig }, { status: 413 });
    if (sp.get("check") === "1") return Response.json({ files: entries.length, size });
    const body = accountZipStream(account, zipStream(entries));
    if (!body) return Response.json({ error: ACCOUNT_MESSAGES.zipBusy }, { status: 429, headers: { "Retry-After": "30" } });
    return zipResponse(entries, size, body);
  }

  const entries = zipEntries(ids);
  if (!entries.length) return Response.json({ error: NOTHING }, { status: 404 });
  const size = zipSize(entries);
  if (size > ZIP_MAX_BYTES) return Response.json({ error: "That's over 4 GB. Download fewer items at a time." }, { status: 413 });
  if (sp.get("check") === "1") return Response.json({ files: entries.length, size });
  return zipResponse(entries, size, zipStream(entries));
}
