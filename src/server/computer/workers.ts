import "server-only";
import crypto from "node:crypto";
import { nanoid } from "nanoid";
import type { ComputerFacts } from "@/lib/relay";
import { accountById } from "../auth";
import { db } from "../db";
import type { Principal } from "./tasks";

/**
 * Workers: programs that run ComfyUI jobs for this studio from another machine, over HTTPS, with a token of their own
 * (`Authorization: Bearer fuobe_wkr_…`). They use the same routes as the browser's "Use the ComfyUI on this computer"
 * (src/app/api/gpu/computer), and they never open a port.
 *
 * Two kinds:
 * - **personal**: one person's own ComfyUI, paired to their account (or to the owner) with a short code they approve
 *   while signed in. Its token acts only as that person's computer: it takes only that person's jobs, exactly as their
 *   own Fuobe tab would. Nobody else's job ever reaches it.
 * - **pool**: the owner's shared GPUs (docs/gpu-workers.md), added in Settings → Workers.
 *
 * Only the SHA-256 of a token is kept. A token is read on every call (no cache), so a revoked one stops at once.
 */

export const WORKER_TOKEN_PREFIX = "fuobe_wkr_";
const WORKER_TOKEN = /^fuobe_wkr_[A-Za-z0-9_-]{43}$/;
const BEARER_WORKER = /^Bearer\s+(fuobe_wkr_\S+)$/i;

export type WorkerKind = "personal" | "pool";

export interface WorkerRow {
  id: string;
  name: string;
  kind: WorkerKind;
  principal: string | null;
  pool: string;
  token_hash: string;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
  last_country: string | null;
  device: string | null;
  protocol: number | null;
  version: string | null;
  facts_json: string | null;
  inventory_json: string | null;
  inventory_hash: string | null;
  lanes_json: string | null;
  bench_json: string | null;
  warm_lane: string | null;
  paused_server: number;
  paused_local: number;
  local_why: string | null;
  local_until: number | null;
  drain: number;
  stop_now: number;
  /** The automatic resume after a busy GPU: 1 on, 0 off, NULL as the worker's own worker.json says. */
  auto_resume: number | null;
  hours_json: string | null;
  allow_json: string | null;
  claim_after_ms: number;
  switch_after_ms: number;
  state: string;
  seen_at: number | null;
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** A new worker token: the prefix and 32 random bytes. */
export const newWorkerToken = () => `${WORKER_TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;

/** Does this Authorization header carry a worker token (valid or not)? */
export const isWorkerAuth = (header: string | null | undefined): boolean => !!header && BEARER_WORKER.test(header.trim());

const touched = new Map<string, number>();

/**
 * The worker behind an Authorization header, read now: null when the token is unknown, revoked or expired. Records
 * when it was last used (at most every 30 s) and Cloudflare's country header.
 */
export function workerFromAuth(header: string | null | undefined, country?: string | null, now = Date.now()): WorkerRow | null {
  const m = BEARER_WORKER.exec((header ?? "").trim());
  if (!m || !WORKER_TOKEN.test(m[1])) return null;
  const row = db().prepare("SELECT * FROM relay_workers WHERE token_hash = ?").get(sha(m[1])) as WorkerRow | undefined;
  if (!row || row.revoked_at || (row.expires_at && row.expires_at <= now)) return null;
  if (now - (touched.get(row.id) ?? 0) > 30_000) {
    touched.set(row.id, now);
    const c = country && /^[A-Z]{2}$/.test(country) ? country : null;
    db().prepare("UPDATE relay_workers SET last_used_at = ?, last_country = COALESCE(?, last_country) WHERE id = ?").run(now, c, row.id);
  }
  return row;
}

export function getWorker(id: string): WorkerRow | null {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{8,32}$/.test(id)) return null;
  return (db().prepare("SELECT * FROM relay_workers WHERE id = ?").get(id) as WorkerRow | undefined) ?? null;
}

const cleanName = (name: unknown) =>
  (typeof name === "string" ? name : "")
    .replace(/[^\p{L}\p{N} ._()-]/gu, "")
    .trim()
    .slice(0, 48) || "ComfyUI";

/** A new worker and its token (the only time the token exists in the clear). */
export function createWorker(w: { name: string; kind: WorkerKind; principal?: Principal; pool?: string; facts?: ComputerFacts; expiresAt?: number }, now = Date.now()): { id: string; token: string } {
  const id = nanoid(12).replace(/[^A-Za-z0-9_-]/g, "_");
  const token = newWorkerToken();
  db()
    .prepare(
      `INSERT INTO relay_workers (id, name, kind, principal, pool, token_hash, created_at, expires_at, facts_json, paused_server, paused_local, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      cleanName(w.name),
      w.kind,
      w.kind === "personal" ? w.principal ?? null : null,
      w.pool ?? "pool",
      sha(token),
      now,
      w.expiresAt ?? null,
      w.facts ? JSON.stringify(w.facts) : null,
      // A personal worker is that person's computer: it follows their own runs, as their tab does. A pool worker starts
      // paused in both places.
      w.kind === "personal" ? 0 : 1,
      w.kind === "personal" ? 0 : 1,
      "new",
    );
  return { id, token };
}

/** Revoke a worker: its next call gets 401. */
export function revokeWorker(id: string, now = Date.now()): boolean {
  return db().prepare("UPDATE relay_workers SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id).changes > 0;
}

/** A new token for a worker; the old one stops at once. */
export function rotateWorker(id: string): string | null {
  const token = newWorkerToken();
  const ok = db().prepare("UPDATE relay_workers SET token_hash = ? WHERE id = ? AND revoked_at IS NULL").run(sha(token), id).changes > 0;
  return ok ? token : null;
}

/** What a person sees of their paired ComfyUIs. */
export interface PairedView {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  facts: ComputerFacts;
}

const json = <T,>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export function pairedOf(principal: Principal): PairedView[] {
  const rows = db().prepare("SELECT * FROM relay_workers WHERE kind = 'personal' AND principal = ? AND revoked_at IS NULL ORDER BY created_at").all(principal) as WorkerRow[];
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at, facts: json<ComputerFacts>(r.facts_json, {}) }));
}

/** Revoke one of a person's paired ComfyUIs (another person's is no worker at all). */
export function unpair(principal: Principal, id: string): boolean {
  const w = getWorker(id);
  if (!w || w.kind !== "personal" || w.principal !== principal) return false;
  return revokeWorker(id);
}

/** Every paired ComfyUI of a principal stops at once, and a pairing it was in the middle of is dropped (signed out everywhere). How many were revoked. */
export function revokeWorkersOf(principal: Principal, now = Date.now()): number {
  const n = db().prepare("UPDATE relay_workers SET revoked_at = ? WHERE kind = 'personal' AND principal = ? AND revoked_at IS NULL").run(now, principal).changes;
  db().prepare("DELETE FROM relay_pairings WHERE principal = ?").run(principal);
  return n;
}

/** Every paired ComfyUI of a principal goes (its account was deleted). */
export function forgetWorkersOf(principal: Principal): void {
  db().prepare("DELETE FROM relay_workers WHERE kind = 'personal' AND principal = ?").run(principal);
  db().prepare("DELETE FROM relay_pairings WHERE principal = ?").run(principal);
}

/** Keep a personal worker's facts (from its beat), for the person's list. */
export function noteWorkerFacts(id: string, facts: ComputerFacts): void {
  db().prepare("UPDATE relay_workers SET facts_json = ? WHERE id = ?").run(JSON.stringify(facts), id);
}

// ---------------------------------------------------------------------------
// Pairing: a ComfyUI shows a short code; the signed-in person approves it on this site; the ComfyUI then gets a token
// for that person only.

/** How long a code waits for the person. */
export const PAIR_MS = 10 * 60_000;
/** Letters and digits that can't be mixed up (no 0/O, 1/I/L). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIR_CODE = /^[A-HJKMNP-Z2-9]{4}-?[A-HJKMNP-Z2-9]{4}$/;

interface PairingRow {
  id: string;
  code: string;
  secret_hash: string;
  name: string;
  facts_json: string | null;
  created_at: number;
  expires_at: number;
  state: "waiting" | "approved" | "denied";
  principal: string | null;
  worker_id: string | null;
}

function newCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** "abcd efgh", "ABCDEFGH" → "ABCD-EFGH", or null. */
export function normaliseCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.toUpperCase().replace(/[\s-]/g, "");
  if (!/^[A-HJKMNP-Z2-9]{8}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function sweepPairings(now: number) {
  db().prepare("DELETE FROM relay_pairings WHERE expires_at < ?").run(now - PAIR_MS);
  // Approved, but the ComfyUI never came back for its token.
  db().prepare("DELETE FROM relay_workers WHERE kind = 'personal' AND token_hash LIKE 'pending:%' AND created_at < ?").run(now - 2 * PAIR_MS);
}

/** A ComfyUI asks to be paired: a code for the person, and a secret only it knows (it polls with it). */
export function startPairing(o: { name: string; facts?: ComputerFacts }, now = Date.now()): { id: string; secret: string; code: string; expiresAt: number } {
  sweepPairings(now);
  const id = nanoid(16).replace(/[^A-Za-z0-9_-]/g, "_");
  const secret = crypto.randomBytes(32).toString("hex");
  for (let i = 0; ; i++) {
    const code = newCode();
    try {
      db()
        .prepare("INSERT INTO relay_pairings (id, code, secret_hash, name, facts_json, created_at, expires_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting')")
        .run(id, code, sha(secret), cleanName(o.name), o.facts ? JSON.stringify(o.facts) : null, now, now + PAIR_MS);
      return { id, secret, code, expiresAt: now + PAIR_MS };
    } catch (e) {
      if (i >= 5) throw e;
    }
  }
}

/** What the person sees before they approve a code: the computer's name and GPU. Null: no such code waiting. */
export function pairingByCode(code: string, now = Date.now()): { name: string; facts: ComputerFacts; expiresAt: number } | null {
  const c = normaliseCode(code);
  if (!c) return null;
  const row = db().prepare("SELECT * FROM relay_pairings WHERE code = ?").get(c) as PairingRow | undefined;
  if (!row || row.state !== "waiting" || row.expires_at < now) return null;
  return { name: row.name, facts: json<ComputerFacts>(row.facts_json, {}), expiresAt: row.expires_at };
}

/**
 * The signed-in person approves a code: a personal worker for them is made now; the ComfyUI gets its token at its next
 * poll. Null: no such code waiting.
 */
export function approvePairing(code: string, principal: Principal, now = Date.now()): { workerId: string; name: string } | null {
  const c = normaliseCode(code);
  if (!c) return null;
  const d = db();
  return d.transaction(() => {
    const row = d.prepare("SELECT * FROM relay_pairings WHERE code = ?").get(c) as PairingRow | undefined;
    if (!row || row.state !== "waiting" || row.expires_at < now) return null;
    // The worker exists from now on, with a placeholder hash no token can have; its token is made at the poll.
    const id = nanoid(12).replace(/[^A-Za-z0-9_-]/g, "_");
    d.prepare(
      `INSERT INTO relay_workers (id, name, kind, principal, pool, token_hash, created_at, facts_json, paused_server, paused_local, state)
       VALUES (?, ?, 'personal', ?, 'pool', ?, ?, ?, 0, 0, 'new')`,
    ).run(id, row.name, principal, `pending:${row.id}`, now, row.facts_json);
    d.prepare("UPDATE relay_pairings SET state = 'approved', principal = ?, worker_id = ? WHERE id = ?").run(principal, id, row.id);
    return { workerId: id, name: row.name };
  })();
}

/** "That's not my computer": the code stops. */
export function denyPairing(code: string): boolean {
  const c = normaliseCode(code);
  return !!c && db().prepare("UPDATE relay_pairings SET state = 'denied' WHERE code = ? AND state = 'waiting'").run(c).changes > 0;
}

export type PollAnswer = { state: "waiting"; expiresAt: number } | { state: "approved"; token: string; workerId: string; name: string; account: string } | { state: "gone" };

/**
 * Who approved a pairing, for the ComfyUI's own window ("Approved by a•••@example.com"): the account's email with most
 * of its name hidden, or the studio's owner.
 */
export function approverLabel(principal: string | null): string {
  if (principal === "owner") return "the studio's owner";
  const account = principal?.startsWith("acct:") ? accountById(principal.slice(5)) : undefined;
  if (!account) return "an account";
  const [name, domain] = account.email.split("@");
  return `${name.slice(0, name.length > 4 ? 2 : 1)}•••@${domain ?? ""}`;
}

/**
 * The ComfyUI asks whether its code was approved (with its secret). Approved: its token, once (made now; only its hash
 * is kept), and the pairing is gone. Denied, expired, unknown or already delivered: gone.
 */
export function pollPairing(id: unknown, secret: unknown, now = Date.now()): PollAnswer {
  if (typeof id !== "string" || typeof secret !== "string" || !/^[0-9a-f]{64}$/.test(secret)) return { state: "gone" };
  const d = db();
  return d.transaction((): PollAnswer => {
    const row = d.prepare("SELECT * FROM relay_pairings WHERE id = ?").get(id) as PairingRow | undefined;
    if (!row || !crypto.timingSafeEqual(Buffer.from(sha(secret)), Buffer.from(row.secret_hash))) return { state: "gone" };
    if (row.state === "waiting") return row.expires_at >= now ? { state: "waiting", expiresAt: row.expires_at } : { state: "gone" };
    d.prepare("DELETE FROM relay_pairings WHERE id = ?").run(row.id);
    if (row.state !== "approved" || !row.worker_id) return { state: "gone" };
    const token = newWorkerToken();
    const ok = d.prepare("UPDATE relay_workers SET token_hash = ? WHERE id = ? AND token_hash = ? AND revoked_at IS NULL").run(sha(token), row.worker_id, `pending:${row.id}`).changes > 0;
    return ok ? { state: "approved", token, workerId: row.worker_id, name: row.name, account: approverLabel(row.principal) } : { state: "gone" };
  })();
}
