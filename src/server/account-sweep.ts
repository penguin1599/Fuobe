import "server-only";
import fs from "node:fs";
import path from "node:path";
import { RETENTION_MS, runAccountDeletedHooks } from "./account-files";
import { deleteAccountCanvases } from "./account-canvas";
import { deleteAccountProjects } from "./account-projects";
import { deleteAccountCinema } from "./cinema";
import { deleteAccountSeries } from "./content-factory";
import { deleteAccountFaceless } from "./faceless";
import { clearAccountLoras } from "./account-loras";
import { accountById, deleteAccount, readAccountIds, setAccountDisabled } from "./auth";
import { strayAccountIds } from "./auth-store";
import { accountEvent, accountFacts } from "./billing";
import { db } from "./db";
import { handOversDone } from "./generations";
import { deleteForever } from "./library";
import { deleteAsset, scratchDir } from "./storage";

/**
 * Public sign-up: what an account keeps on this server goes in time. Its uploads after 14 days (even when a run still
 * names them: a file can't be kept alive for ever), its runs and their files after 30, and everything at once when the
 * account is deleted. Runs at boot, then daily (src/instrumentation.ts).
 */

const DAY = 24 * 60 * 60_000;
/** An upload's temp file left behind (the server stopped mid-upload). */
const STALE_UPLOAD_MS = 60 * 60_000;
/** Any other scratch file left behind: a result's download, a frames zip. */
const STALE_SCRATCH_MS = 6 * 60 * 60_000;

/** Every account that owns a run or a file here. */
function owners(): string[] {
  const runs = db()
    .prepare("SELECT DISTINCT json_extract(request_json, '$.account') AS id FROM generations WHERE json_extract(request_json, '$.account') IS NOT NULL")
    .all() as { id: string }[];
  const files = db().prepare("SELECT DISTINCT account_id AS id FROM assets WHERE account_id IS NOT NULL").all() as { id: string }[];
  return [...new Set([...runs, ...files].map((r) => r.id).filter(Boolean))];
}

/**
 * Remove a deleted account's runs (running ones are cancelled first) and files, then run the cleanups other features
 * registered (account-files.ts onAccountDeleted).
 */
export async function purgeAccount(id: string): Promise<{ runs: number; files: number }> {
  const runIds = (db().prepare("SELECT id FROM generations WHERE json_extract(request_json, '$.account') = ?").all(id) as { id: string }[]).map((r) => r.id);
  let runs = 0;
  for (let i = 0; i < runIds.length; i += 200) runs += await deleteForever(runIds.slice(i, i + 200));
  const files = (db().prepare("SELECT id FROM assets WHERE account_id = ?").all(id) as { id: string }[]).map((r) => r.id);
  for (const f of files) deleteAsset(f);
  clearAccountLoras(id);
  deleteAccountCanvases(id);
  // A tool's own rows under its projects go before the projects themselves.
  deleteAccountCinema(id);
  deleteAccountSeries(id);
  deleteAccountFaceless(id);
  deleteAccountProjects(id);
  await runAccountDeletedHooks(id);
  return { runs, files: files.length };
}

/**
 * Delete an account (by itself, or by the owner). In this order: it is switched off (signed out, no new runs); its jobs
 * still going are stopped, those on its own fal.ai or Replicate key with that key, which is why the record is still
 * there; its runs and files go; a job still being handed over is stopped when its submit lands, with that key too, so
 * the record waits for it; then its record, with its GPU and its keys. If stopping fails it stays switched off and
 * listed, and can be deleted again.
 */
export async function removeAccount(id: string): Promise<void> {
  setAccountDisabled(id, true);
  const going = db()
    .prepare("SELECT id FROM generations WHERE status IN ('queued', 'running') AND json_extract(request_json, '$.account') = ?")
    .pluck()
    .all(id) as string[];
  await purgeAccount(id);
  if (!(await handOversDone(going))) console.warn("[fuobe] account deletion: a run was still being handed to its provider after a minute; the account goes anyway");
  const gone = accountById(id);
  deleteAccount(id);
  // An optional billing service hears of it (none set: nothing is sent).
  if (gone) accountEvent("deleted", accountFacts(gone));
}

/** One sweep (see the header). `now` for tests. */
export async function sweepAccountFiles(now = Date.now()): Promise<{ uploads: number; runs: number; files: number; accounts: number }> {
  // Uploads past their time.
  const uploads = db()
    .prepare("SELECT id FROM assets WHERE account_id IS NOT NULL AND source = 'upload' AND created_at < ?")
    .all(now - RETENTION_MS.upload) as { id: string }[];
  for (const u of uploads) deleteAsset(u.id);
  // Runs past their time (not one still going), with their files.
  const old = (
    db()
      .prepare("SELECT id FROM generations WHERE json_extract(request_json, '$.account') IS NOT NULL AND created_at < ? AND status NOT IN ('queued', 'running')")
      .all(now - RETENTION_MS.run) as { id: string }[]
  ).map((r) => r.id);
  let runs = 0;
  for (let i = 0; i < old.length; i += 200) runs += await deleteForever(old.slice(i, i + 200));
  // Results kept for a run another one named, once both are gone.
  const orphans = db()
    .prepare(
      "SELECT id FROM assets WHERE account_id IS NOT NULL AND source != 'upload' AND created_at < ? AND (generation_id IS NULL OR generation_id NOT IN (SELECT id FROM generations))",
    )
    .all(now - RETENTION_MS.run) as { id: string }[];
  for (const o of orphans) deleteAsset(o.id);
  // Accounts that are gone (deleting one purges it at once: this only catches what that missed). Only when the sign-in
  // data was read whole, and not when it lists no account at all while accounts own files: data that failed to read,
  // or a database put back from before the sign-ups, must never wipe everyone's work.
  let gone: string[] = [];
  const owning = owners();
  // No account owns anything here (a new install has no accounts yet): nothing to check.
  if (owning.length) {
    try {
      const live = readAccountIds();
      // Accounts only an auth.json set aside unread lists (an older build may have signed them up): kept while it is there.
      const waiting = strayAccountIds();
      if (live.size) gone = owning.filter((id) => !live.has(id) && !waiting.has(id));
      else console.warn(`[fuobe] account sweep: the sign-in data lists no accounts, but ${owning.length} own files here; nothing removed`);
    } catch (e) {
      console.warn(`[fuobe] account sweep: skipped removing deleted accounts' files (${(e as Error).message})`);
    }
  }
  for (const id of gone) await purgeAccount(id);
  // Temp files the server left behind (it stopped mid-upload, mid-download or mid-zip): an upload's after an hour,
  // anything else in the scratch folder after six hours untouched (a download or zip in progress writes to it all along).
  try {
    const dir = scratchDir();
    for (const f of fs.readdirSync(dir)) {
      const file = path.join(dir, f);
      try {
        const st = fs.statSync(file);
        if (st.isFile() && now - st.mtimeMs > (f.startsWith("up-") ? STALE_UPLOAD_MS : STALE_SCRATCH_MS)) fs.rmSync(file, { force: true });
      } catch {}
    }
  } catch {}
  return { uploads: uploads.length, runs, files: orphans.length, accounts: gone.length };
}

declare global {
  var __fuobeAccountSweep: { timer: NodeJS.Timeout } | undefined;
}

/** Sweep now, then every day (once per process). */
export function ensureAccountSweep(): void {
  if (globalThis.__fuobeAccountSweep) return;
  const run = () => void sweepAccountFiles().catch((e) => console.warn(`[fuobe] account sweep failed: ${(e as Error).message}`));
  const timer = setInterval(run, DAY);
  timer.unref?.();
  globalThis.__fuobeAccountSweep = { timer };
  run();
}
