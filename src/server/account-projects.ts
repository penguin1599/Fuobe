import "server-only";
import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { accountInputProblem, type InputProblem } from "./account-inputs";
import { generationAccount } from "./account-library";
import { db } from "./db";
import { hit } from "./rate";

/**
 * An account's own projects (public sign-up), for the tools that keep a project of their own: a Shorts session, a
 * storyboard, a Cinema project, a Character Swap project… One table for every kind, never the owner's tables: every
 * read and change names the account and the kind, so one account never reaches another's project, and the owner's
 * projects are never in reach (an id that is another's reads as "not here", the same as one that doesn't exist).
 *
 * The same pattern as an account's canvases (account-canvas.ts): a project holds its own data as JSON, with a small
 * summary its list reads. A project names only the account's own files and runs (projectRefsProblem); its runs are
 * ordinary generations, started through account-tool-run.ts. Everything goes when the account is deleted
 * (account-sweep.ts purgeAccount).
 */

export const ACCOUNT_PROJECT_LIMITS = {
  /** Projects an account keeps, per kind. */
  projects: 50,
  /** One project's data as JSON (characters). */
  bytes: 1_000_000,
  /** Its list's summary as JSON (characters). */
  summaryBytes: 4_000,
  /** Saves a minute per account, every kind together (an editor's autosave is debounced, so far above what it sends). */
  savesPerMinute: 120,
} as const;

/** A kind: lower case letters, digits and dashes ("shorts", "storyboard", "cinema", "swap"). */
const KIND = /^[a-z][a-z0-9-]{0,31}$/;

const TABLE = `CREATE TABLE IF NOT EXISTS account_projects (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    data_json TEXT NOT NULL,
    summary_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS account_projects_account ON account_projects(account_id, kind, updated_at DESC);`;

declare global {
  var __fuobeAccountProjects: WeakSet<Database.Database> | undefined;
}

/** The database, with the table made the first time (not a numbered migration: no branch's migrations clash over it). */
function store(): Database.Database {
  const d = db();
  const made = (globalThis.__fuobeAccountProjects ??= new WeakSet());
  if (!made.has(d)) {
    d.exec(TABLE);
    made.add(d);
  }
  return d;
}

interface Row {
  id: string;
  account_id: string;
  kind: string;
  name: string;
  data_json: string;
  summary_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface AccountProject<D = unknown, S = unknown> {
  id: string;
  kind: string;
  name: string;
  data: D;
  summary: S | null;
  createdAt: number;
  updatedAt: number;
}

/** A project's line in its list: never its data. */
export type AccountProjectSummary<S = unknown> = Omit<AccountProject<never, S>, "data">;

/** What a save answers: small (an autosave sends often). */
export interface AccountProjectSaved {
  id: string;
  name: string;
  updatedAt: number;
}

/** Why a change was refused, with the status the route answers. */
export class AccountProjectError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function kindOf(kind: string): string {
  if (!KIND.test(kind)) throw new Error(`Not a project kind: ${kind}`);
  return kind;
}

const cleanName = (name: string | undefined, fallback: string) => (name?.replace(/\s+/g, " ").trim() || fallback).slice(0, 80);

function dataJson(data: unknown): string {
  const json = JSON.stringify(data ?? null);
  if (json.length > ACCOUNT_PROJECT_LIMITS.bytes) throw new AccountProjectError("This project is too big to save. Remove a few parts of it, then try again.", 413);
  return json;
}

function summaryJson(summary: unknown): string | null {
  if (summary === undefined || summary === null) return null;
  const json = JSON.stringify(summary);
  if (json.length > ACCOUNT_PROJECT_LIMITS.summaryBytes) throw new AccountProjectError("This project's summary is too big to save.", 413);
  return json;
}

const toProject = <D, S>(r: Row): AccountProject<D, S> => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  data: JSON.parse(r.data_json) as D,
  summary: r.summary_json ? (JSON.parse(r.summary_json) as S) : null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** The account's projects of one kind, newest first: each one's summary, never its data. */
export function listAccountProjects<S = unknown>(accountId: string, kind: string): AccountProjectSummary<S>[] {
  const rows = store()
    .prepare("SELECT id, kind, name, summary_json, created_at, updated_at FROM account_projects WHERE account_id = ? AND kind = ? ORDER BY updated_at DESC LIMIT ?")
    .all(accountId, kindOf(kind), ACCOUNT_PROJECT_LIMITS.projects) as Omit<Row, "account_id" | "data_json">[];
  return rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name, summary: r.summary_json ? (JSON.parse(r.summary_json) as S) : null, createdAt: r.created_at, updatedAt: r.updated_at }));
}

/** One of the account's projects of that kind, or null (another account's, another kind's or none read the same). */
export function getAccountProject<D = unknown, S = unknown>(accountId: string, kind: string, id: string): AccountProject<D, S> | null {
  const r = store().prepare("SELECT * FROM account_projects WHERE id = ? AND account_id = ? AND kind = ?").get(id, accountId, kindOf(kind)) as Row | undefined;
  return r ? toProject<D, S>(r) : null;
}

export function createAccountProject<D, S = unknown>(accountId: string, kind: string, input: { name?: string; data: D; summary?: S }): AccountProject<D, S> {
  const k = kindOf(kind);
  const count = (store().prepare("SELECT COUNT(*) AS n FROM account_projects WHERE account_id = ? AND kind = ?").get(accountId, k) as { n: number }).n;
  if (count >= ACCOUNT_PROJECT_LIMITS.projects) throw new AccountProjectError(`You can keep up to ${ACCOUNT_PROJECT_LIMITS.projects} of these. Delete one to make another.`, 409);
  const now = Date.now();
  const row: Row = {
    id: nanoid(12),
    account_id: accountId,
    kind: k,
    name: cleanName(input.name, "Untitled"),
    data_json: dataJson(input.data),
    summary_json: summaryJson(input.summary),
    created_at: now,
    updated_at: now,
  };
  store()
    .prepare(`INSERT INTO account_projects (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map((c) => `@${c}`).join(", ")})`)
    .run(row);
  return toProject<D, S>(row);
}

/** A new name, data and/or summary for one of the account's projects; null when it has no such project of that kind. */
export function updateAccountProject(accountId: string, kind: string, id: string, patch: { name?: string; data?: unknown; summary?: unknown }): AccountProjectSaved | null {
  const name = patch.name?.trim() ? cleanName(patch.name, "") : null;
  const data = patch.data === undefined ? null : dataJson(patch.data);
  const summary = patch.summary === undefined ? null : summaryJson(patch.summary);
  const now = Date.now();
  const done = store()
    .prepare(
      "UPDATE account_projects SET name = COALESCE(?, name), data_json = COALESCE(?, data_json), summary_json = COALESCE(?, summary_json), updated_at = ? WHERE id = ? AND account_id = ? AND kind = ?",
    )
    .run(name, data, summary, now, id, accountId, kindOf(kind));
  if (!done.changes) return null;
  const r = store().prepare("SELECT name FROM account_projects WHERE id = ?").get(id) as Pick<Row, "name">;
  return { id, name: r.name, updatedAt: now };
}

export function deleteAccountProject(accountId: string, kind: string, id: string): boolean {
  return store().prepare("DELETE FROM account_projects WHERE id = ? AND account_id = ? AND kind = ?").run(id, accountId, kindOf(kind)).changes > 0;
}

/**
 * Every account's projects of a kind whose summary has `field` above 0, for that tool's background work (Character Swap
 * Studio's takes waiting to start): each one's id and account, never its data. The tool reads each one as its account.
 */
export function accountProjectsWith(kind: string, field: string): { id: string; accountId: string }[] {
  if (!/^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(field)) throw new Error(`Not a summary field: ${field}`);
  return store()
    .prepare(`SELECT id, account_id AS accountId FROM account_projects WHERE kind = ? AND json_extract(summary_json, '$.${field}') > 0`)
    .all(kindOf(kind)) as { id: string; accountId: string }[];
}

/**
 * Which account keeps a project of that kind with this id, or null (nobody's: the owner's row, or none). For a tool whose
 * rows live in its own tables under the project's id (Faceless channels, Content Factory series…), so a row that is an
 * account's is never read as the owner's.
 */
export function accountProjectOwner(kind: string, id: string): string | null {
  const r = store().prepare("SELECT account_id FROM account_projects WHERE id = ? AND kind = ?").get(id, kindOf(kind)) as { account_id: string } | undefined;
  return r?.account_id ?? null;
}

/**
 * The ids of one account's projects of a kind (or, with no account, of every account's), as a subquery for
 * `column IN (…)`: an account's list reads its own rows only, and the owner's leaves every account's out.
 */
export function accountProjectIds(kind: string, accountId?: string): { sql: string; args: string[] } {
  store();
  const k = kindOf(kind);
  return accountId
    ? { sql: "SELECT id FROM account_projects WHERE kind = ? AND account_id = ?", args: [k, accountId] }
    : { sql: "SELECT id FROM account_projects WHERE kind = ?", args: [k] };
}

/** Every project of an account, when the account is deleted. */
export function deleteAccountProjects(accountId: string): number {
  return store().prepare("DELETE FROM account_projects WHERE account_id = ?").run(accountId).changes;
}

/**
 * The first problem with what a project names, or null: every file must be the account's own upload or result (or one
 * of Fuobe's published example files), and every run its own. Another's run reads as not found, as a gone one.
 */
export function projectRefsProblem(accountId: string, refs: { files?: string[]; runs?: string[] }): InputProblem | null {
  const files = (refs.files ?? []).filter(Boolean);
  const problem = files.length ? accountInputProblem({ inputs: { images: files } }, accountId) : null;
  if (problem) return problem;
  for (const run of refs.runs ?? []) {
    if (generationAccount(run) !== accountId) return { status: 404, code: "input-gone", error: "We can't find that run." };
  }
  return null;
}

/** Saves a minute per account (every kind together): a runaway tab can't fill the database. 429 past it. */
export function projectSavesLimited(accountId: string): Response | null {
  const rate = hit(`account-project:${accountId}`, ACCOUNT_PROJECT_LIMITS.savesPerMinute, 60_000);
  return rate.ok ? null : Response.json({ error: "Saving too often. Wait a moment, then try again." }, { status: 429, headers: { "Retry-After": String(rate.retryAfterS) } });
}

/** The route's answer to a refused change (AccountProjectError); anything else is thrown on. */
export function projectRefused(e: unknown): Response {
  if (e instanceof AccountProjectError) return Response.json({ error: e.message }, { status: e.status });
  throw e;
}
