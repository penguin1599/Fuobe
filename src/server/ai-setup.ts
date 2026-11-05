import "server-only";
import crypto from "node:crypto";
import net from "node:net";
import { SAFE_ORIGIN } from "@/lib/comfy-install";
import { newSetupCode } from "@/lib/ai-setup/code";
import type { ServerFacts, SetupView, TabFacts } from "@/lib/ai-setup/facts";
import { TAB_QUIET_MS } from "@/lib/ai-setup/next-step";
import { isDone } from "@/lib/ai-setup/steps";
import { isOs, isWay, type Os, type Way } from "@/lib/ai-setup/ways";
import { cachedGpuState, computerView } from "./account-gpu";
import { accountById, accountGpu, LoginGuard } from "./auth";
import { open, seal } from "./secret-box";

/**
 * "Set it up with my AI": an account's setup codes, in this server's memory (like src/server/rate.ts). A code is read-only
 * status for one account's one setup: what its open Fuobe tab reports (fixed values), what the server knows itself (the
 * account's saved GPU, a link's cached check), and the next step. Reading it never calls the GPU or changes a setting:
 * at most it asks the account's open tab to look at its own ComfyUI sooner (a poke), once every 3 s.
 *
 * A code ends 30 minutes after its tab was last heard from (2 hours at most), 10 minutes after the setup is done, when
 * the account makes a new one or presses End this code, and when the account is deleted or switched off. A restart of
 * the server forgets every code; the account's tab brings its own back with a sealed resume token (secret-box.ts).
 */

/** A code lives this long after its tab was last heard from. */
export const SETUP_LIFE_MS = 30 * 60_000;
/** And this long at most. */
export const SETUP_MAX_MS = 2 * 60 * 60_000;
/** After the setup is done. */
export const DONE_LIFE_MS = 10 * 60_000;
export const MAX_SETUPS = 5000;
/** Tabs waiting for a poke at once (long polls), across the server. Past it a tab beats every 10 s instead. */
export const MAX_WAITERS = 500;
/** A wait answers after this long with no poke. */
export const WAIT_MS = 25_000;
/** An outside read pokes the tab at most this often, and only when its last report is older. */
export const POKE_GAP_MS = 3000;
/** How long an outside read waits for the poked tab's report. */
export const POKE_WAIT_MS = 4000;

export interface Setup {
  code: string;
  accountId: string;
  site: string;
  way: Way;
  os: Os;
  phone: boolean;
  createdAt: number;
  expiresAt: number;
  /** Never later than this. */
  endsBy: number;
  doneAt?: number;
  tab: TabFacts | null;
  tabAt: number;
  tabId?: string;
  /** The last read of its status from outside (the person's AI). */
  aiReadAt?: number;
  pokedAt: number;
  waiter?: (poke: boolean) => void;
  fresh: (() => void)[];
}

interface Store {
  byCode: Map<string, Setup>;
  byAccount: Map<string, string>;
  /** Codes that ended, until they would have ended anyway: a resume token never brings one back. */
  ended: Map<string, number>;
  waiting: number;
}

declare global {
  var __fuobeSetups: Store | undefined;
}

const store = (): Store => (globalThis.__fuobeSetups ??= { byCode: new Map(), byAccount: new Map(), ended: new Map(), waiting: 0 });

/** Tests: forget every code. */
export function resetSetups(): void {
  const s = store();
  for (const x of s.byCode.values()) x.waiter?.(false);
  s.byCode.clear();
  s.byAccount.clear();
  s.ended.clear();
  s.waiting = 0;
}

function end(s: Setup): void {
  const st = store();
  st.byCode.delete(s.code);
  st.ended.set(s.code, s.endsBy);
  while (st.ended.size > 4 * MAX_SETUPS) st.ended.delete(st.ended.keys().next().value!);
  if (st.byAccount.get(s.accountId) === s.code) st.byAccount.delete(s.accountId);
  s.waiter?.(false);
  for (const f of s.fresh.splice(0)) f();
}

function sweep(now: number): void {
  const st = store();
  for (const s of st.byCode.values()) if (s.expiresAt <= now) end(s);
  for (const [code, until] of st.ended) if (until <= now) st.ended.delete(code);
  // Still too many: the oldest go first.
  while (st.byCode.size > MAX_SETUPS) end(st.byCode.values().next().value!);
}

// ---------------------------------------------------------------------------
// The studio's own address

const FUOBE_COM = new Set(["fuobe.com", "www.fuobe.com"]);
const LOCAL_SUFFIXES = [".localhost", ".local", ".lan", ".home.arpa", ".internal"];

function nameOf(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]") >>> 0);
  const colon = h.indexOf(":");
  return (colon >= 0 && colon === h.lastIndexOf(":") ? h.slice(0, colon) : h).replace(/\.$/, "");
}

/**
 * The studio's own address for this request, from a fixed list: fuobe.com, the addresses in FUOBE_ALLOWED_ORIGINS, or
 * an address on this computer or its network. Null for any other host: the steps name this address in ComfyUI's
 * setting, so a made-up Host never gets into them.
 */
export function siteOf(headers: Headers, url: string): string | null {
  let own: URL;
  try {
    own = new URL(url);
  } catch {
    return null;
  }
  const host = (headers.get("x-forwarded-host")?.split(",")[0] ?? headers.get("host") ?? own.host).trim().toLowerCase();
  const name = nameOf(host);
  const fwd = headers.get("x-forwarded-proto")?.split(",")[0].trim().toLowerCase();
  const proto = fwd === "https" || fwd === "http" ? fwd : own.protocol.replace(":", "");
  const ok = (site: string) => (SAFE_ORIGIN.test(site) ? site : null);
  if (FUOBE_COM.has(name)) return `https://${name}`;
  for (const raw of (process.env.FUOBE_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim().toLowerCase())) {
    if (!raw || raw === "*") continue;
    if (raw.includes("://")) {
      try {
        const u = new URL(raw);
        if (u.host === host) return ok(u.origin);
      } catch {}
    } else if (raw === host || raw === name) return ok(`${proto}://${host}`);
  }
  if (net.isIP(name) || name === "localhost" || !name.includes(".") || LOCAL_SUFFIXES.some((s) => name.endsWith(s))) return ok(`${proto}://${host}`);
  return null;
}

// ---------------------------------------------------------------------------
// What the server knows itself

/** The account's saved GPU (a database read) and whether it answers: a link's cached check, or the computer's tab. Never a call to the GPU. */
export function serverFacts(accountId: string): ServerFacts {
  const gpu = accountGpu(accountId);
  if (!gpu) return { gpu: "none", online: false };
  if (gpu.mode === "computer") return { gpu: "computer", online: computerView(`acct:${accountId}`).online };
  return { gpu: "link", online: cachedGpuState(accountId, gpu.url)?.online ?? null };
}

export const viewOf = (s: Setup): SetupView => ({ site: s.site, way: s.way, os: s.os, phone: s.phone, tab: s.tab, tabAt: s.tabAt, server: serverFacts(s.accountId) });

// ---------------------------------------------------------------------------
// Making, finding and ending codes

const resumeContext = (accountId: string) => `fuobe:ai-setup:v1:${accountId}`;

/** A token the account's tab keeps, to bring the same code back after a restart (null when this studio can't seal). */
export function resumeToken(s: Setup): string | null {
  try {
    return seal(JSON.stringify({ c: s.code, e: s.expiresAt, b: s.endsBy, w: s.way, o: s.os }), resumeContext(s.accountId));
  } catch {
    return null;
  }
}

function fromToken(token: string, accountId: string): { code: string; expiresAt: number; endsBy: number; way: Way; os: Os } | null {
  const plain = open(token, resumeContext(accountId));
  if (!plain) return null;
  try {
    const r = JSON.parse(plain) as { c?: unknown; e?: unknown; b?: unknown; w?: unknown; o?: unknown };
    if (typeof r.c !== "string" || typeof r.e !== "number" || typeof r.b !== "number" || !isWay(r.w) || !isOs(r.o)) return null;
    return { code: r.c, expiresAt: r.e, endsBy: r.b, way: r.w, os: r.o };
  } catch {
    return null;
  }
}

export interface CreateInput {
  accountId: string;
  site: string;
  way: Way;
  os: Os;
  phone?: boolean;
  /** A new code even when one is active (the old one ends). */
  fresh?: boolean;
  /** The account's resume token, after a restart. */
  resume?: string;
}

/**
 * The account's active code (its way and computer updated), or a new one. `created`: a new code was made (the caller
 * counts it against the limits first, through `willCreate`). `replaced`: a resume token was given but couldn't bring
 * its code back (the panel says "Fuobe made a new code").
 */
export function willCreate(i: Pick<CreateInput, "accountId" | "fresh" | "resume">, now = Date.now()): boolean {
  sweep(now);
  const st = store();
  const active = st.byAccount.get(i.accountId);
  if (active && st.byCode.has(active) && !i.fresh) return false;
  if (i.resume && !i.fresh) {
    const t = fromToken(i.resume, i.accountId);
    if (t && t.expiresAt > now && !st.byCode.has(t.code) && !st.ended.has(t.code)) return false;
  }
  return true;
}

export function createSetup(i: CreateInput, now = Date.now()): { setup: Setup; created: boolean; replaced: boolean } {
  sweep(now);
  const st = store();
  const activeCode = st.byAccount.get(i.accountId);
  const active = activeCode ? st.byCode.get(activeCode) : undefined;
  if (active && !i.fresh) {
    active.way = i.way;
    active.os = i.os;
    active.phone = !!i.phone;
    return { setup: active, created: false, replaced: false };
  }
  if (active) end(active);
  const base = { accountId: i.accountId, site: i.site, way: i.way, os: i.os, phone: !!i.phone, tab: null, tabAt: 0, pokedAt: 0, fresh: [] };
  if (i.resume && !i.fresh) {
    const t = fromToken(i.resume, i.accountId);
    if (t && t.expiresAt > now && !st.byCode.has(t.code) && !st.ended.has(t.code)) {
      const setup: Setup = { ...base, code: t.code, createdAt: now, expiresAt: Math.min(t.expiresAt, t.endsBy), endsBy: t.endsBy };
      st.byCode.set(setup.code, setup);
      st.byAccount.set(i.accountId, setup.code);
      return { setup, created: false, replaced: false };
    }
  }
  let code = newSetupCode(crypto.randomInt);
  while (st.byCode.has(code) || st.ended.has(code)) code = newSetupCode(crypto.randomInt);
  const setup: Setup = { ...base, code, createdAt: now, expiresAt: now + SETUP_LIFE_MS, endsBy: now + SETUP_MAX_MS };
  st.byCode.set(code, setup);
  st.byAccount.set(i.accountId, code);
  sweep(now);
  return { setup, created: true, replaced: !!i.resume };
}

/** An active code, or null: unknown, ended, or its account is gone or switched off (then it ends). */
export function setupOf(code: string, now = Date.now()): Setup | null {
  const s = store().byCode.get(code);
  if (!s) return null;
  if (s.expiresAt <= now) {
    end(s);
    return null;
  }
  const a = accountById(s.accountId);
  if (!a || a.disabled) {
    end(s);
    return null;
  }
  return s;
}

/** The account's own active code, or null (another account's code is the same as none). */
export function ownSetup(code: string, accountId: string, now = Date.now()): Setup | null {
  const s = setupOf(code, now);
  return s && s.accountId === accountId ? s : null;
}

/** End this code now (End this code). */
export const endSetup = (s: Setup) => end(s);

// ---------------------------------------------------------------------------
// The tab's reports, its waits, and an outside read

/**
 * The tab's facts. One tab leads a setup at a time: another tab takes over when the leading one went quiet or out of
 * view while this one is in view, or when its person pressed Continue here (`claim`). `mine`: this tab leads.
 */
export function reportSetup(s: Setup, facts: TabFacts, o: { claim?: boolean } = {}, now = Date.now()): { mine: boolean } {
  const quiet = !s.tab || now - s.tabAt > TAB_QUIET_MS;
  const lead = !s.tabId || s.tabId === facts.tabId || quiet || (!!s.tab && !s.tab.visible && facts.visible) || !!o.claim;
  if (!lead) return { mine: false };
  s.tabId = facts.tabId;
  s.tab = facts;
  s.tabAt = now;
  s.way = facts.way;
  if (!s.doneAt && isDone(viewOf(s))) {
    s.doneAt = now;
    s.expiresAt = Math.min(s.expiresAt, now + DONE_LIFE_MS);
  } else if (!s.doneAt) s.expiresAt = Math.min(s.endsBy, Math.max(s.expiresAt, now + SETUP_LIFE_MS));
  for (const f of s.fresh.splice(0)) f();
  return { mine: true };
}

/** The tab waits for a poke (a long poll): `poke` when an outside read asks for a fresh look; `slow` when the server is full. */
export function waitSetup(s: Setup, signal?: AbortSignal, ms = WAIT_MS): Promise<{ poke: boolean; slow?: true }> {
  const st = store();
  if (st.waiting >= MAX_WAITERS) return Promise.resolve({ poke: false, slow: true });
  s.waiter?.(false);
  return new Promise((resolve) => {
    let done = false;
    const finish = (poke: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      st.waiting--;
      if (s.waiter === finish) s.waiter = undefined;
      resolve({ poke });
    };
    const timer = setTimeout(() => finish(false), ms);
    st.waiting++;
    s.waiter = finish;
    signal?.addEventListener("abort", () => finish(false), { once: true });
  });
}

/**
 * An outside read: noted (the panel says "Your AI checked in"), and when the tab's last report is older than 3 s and
 * the tab waits, it is poked and its next report waited for (4 s at most). Reaches nothing but this memory.
 */
export async function readSetup(s: Setup, now = Date.now()): Promise<void> {
  s.aiReadAt = now;
  if (!s.waiter || now - s.tabAt <= POKE_GAP_MS || now - s.pokedAt <= POKE_GAP_MS || s.fresh.length >= 20) return;
  s.pokedAt = now;
  const poke = s.waiter;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, POKE_WAIT_MS);
    s.fresh.push(() => {
      clearTimeout(timer);
      resolve();
    });
    poke(true);
  });
}

/** A few random characters for the status's check_again_url. */
export const freshPart = () => crypto.randomBytes(4).toString("hex");

/**
 * A visitor's key for the limits on guessing (unknown codes): its address behind a trusted proxy, else null. Without
 * one every visitor would share a key, and those limits would be one limit for the whole site: only the shared budget
 * applies then.
 */
export function visitorKey(headers: Headers): string | null {
  const k = LoginGuard.clientKey(headers);
  return k === LoginGuard.DIRECT ? null : k;
}
