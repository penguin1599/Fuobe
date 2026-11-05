"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TabFacts } from "@/lib/ai-setup/facts";
import type { NextStep } from "@/lib/ai-setup/next-step";
import type { Os, Way } from "@/lib/ai-setup/ways";

/**
 * The setup code of "Set it up with my AI" in the account's tab: made when the panel opens (the same code again while it
 * is active), its way and computer kept up to date, the tab's facts reported when they change and after each wait (a
 * heartbeat), the long wait for its AI's reads (a poke asks for a fresh look), and the code brought back after a
 * restart of the server (its sealed resume token, kept in this tab's sessionStorage). The checklist never depends on
 * it: everything here may fail, and the panel goes on checking.
 */

const KEY = "fuobe.ai-setup";

interface Kept {
  code: string;
  resume: string | null;
}

function kept(): Kept | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as Kept | null;
    return v && typeof v.code === "string" ? v : null;
  } catch {
    return null;
  }
}

function keep(v: Kept | null): void {
  try {
    if (v) sessionStorage.setItem(KEY, JSON.stringify(v));
    else sessionStorage.removeItem(KEY);
  } catch {}
}

/** This tab's id with the setup (a routing label: the setup follows one tab at a time). */
function tabIdOf(): string {
  try {
    const id = sessionStorage.getItem(`${KEY}.tab`);
    if (id && /^[A-Za-z0-9_-]{8,40}$/.test(id)) return id;
    const made = `tab-${crypto.getRandomValues(new Uint32Array(2)).join("").slice(0, 16)}`;
    sessionStorage.setItem(`${KEY}.tab`, made);
    return made;
  } catch {
    return `tab-${Math.random().toString(36).slice(2, 12)}`;
  }
}

export interface SetupSession {
  code: string | null;
  site: string | null;
  guideUrl: string | null;
  /** The code couldn't be made ("Fuobe can't make a code right now"). */
  failed: string | null;
  /** The person ended the code: their AI can't see the checks now. */
  ended: boolean;
  /** The server forgot the code and made a new one (after a restart). */
  renewed: boolean;
  /** When the AI last read the status (ms), from the last report. */
  aiReadAt: number | null;
  /** This tab leads the setup (another tab or device may). */
  mine: boolean;
  /** The next step as the AI reads it (for "Stuck?"). */
  next: NextStep | null;
  /** Reports keep failing: the footer says so. */
  offline: boolean;
}

const BACKOFF = [2000, 4000, 8000, 30_000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useSetupSession(o: { way: Way; os: Os; phone: boolean; facts: Omit<TabFacts, "tabId"> | null; onPoke: () => void }) {
  const [s, setS] = useState<SetupSession>({ code: null, site: null, guideUrl: null, failed: null, ended: false, renewed: false, aiReadAt: null, mine: true, next: null, offline: false });
  const tabId = useRef<string>("");
  const code = useRef<string | null>(null);
  const resume = useRef<string | null>(null);
  const facts = useRef(o.facts);
  const onPoke = useRef(o.onPoke);
  const failures = useRef(0);
  const claim = useRef(false);
  useEffect(() => {
    facts.current = o.facts;
    onPoke.current = o.onPoke;
  });

  const make = useCallback(async (way: Way, os: Os, phone: boolean, opts: { fresh?: boolean } = {}) => {
    const before = kept();
    const res = await fetch("/api/setup/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ way, os, phone, ...(opts.fresh && { fresh: true }), ...(!opts.fresh && !code.current && before?.resume && { resume: before.resume }) }),
    }).catch(() => null);
    const j = res ? ((await res.json().catch(() => ({}))) as { code?: string; site?: string; guideUrl?: string; resume?: string | null; replaced?: boolean; error?: string }) : {};
    if (!res?.ok || !j.code) {
      setS((x) => ({ ...x, failed: j.error ?? "Fuobe can't make a code right now. Try again in a minute." }));
      return false;
    }
    const renewed = !!j.replaced || (!!code.current && code.current !== j.code && !opts.fresh);
    code.current = j.code;
    resume.current = j.resume ?? null;
    keep({ code: j.code, resume: j.resume ?? null });
    setS((x) => ({ ...x, code: j.code!, site: j.site ?? null, guideUrl: j.guideUrl ?? null, failed: null, ended: false, renewed, ...(opts.fresh && { renewed: false, aiReadAt: null }) }));
    return true;
  }, []);

  const osRef = useRef(o.os);
  const phoneRef = useRef(o.phone);
  useEffect(() => {
    osRef.current = o.os;
    phoneRef.current = o.phone;
  }, [o.os, o.phone]);

  // Made (or found again) when the panel opens, and kept up to date when the way or the computer changes.
  const { way, os, phone } = o;
  useEffect(() => {
    if (!tabId.current) tabId.current = tabIdOf();
    if (s.ended) return;
    void make(way, os, phone);
  }, [way, os, phone, make, s.ended]);

  /** Report now: the tab's facts (also a heartbeat). Brings the code back once when the server forgot it. */
  const report = useCallback(async (): Promise<void> => {
    const c = code.current;
    const f = facts.current;
    if (!c || !f) return;
    const body = { ...f, tabId: tabId.current, ...(claim.current && { claim: true }) };
    claim.current = false;
    const res = await fetch(`/api/setup/session/${c}/report`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    if (res?.status === 404) {
      // A restart forgot it (or it ended after a long time): the same code back with the resume token, or a new one.
      code.current = null;
      // The new code's own report follows (it changes the code the reports go to).
      await make(f.way, osRef.current, phoneRef.current);
      return;
    }
    if (!res?.ok) {
      failures.current++;
      if (failures.current >= 3) setS((x) => ({ ...x, offline: true }));
      return;
    }
    failures.current = 0;
    const j = (await res.json().catch(() => null)) as { aiReadAt?: number | null; mine?: boolean; next?: NextStep; resume?: string | null } | null;
    if (j?.resume) {
      resume.current = j.resume;
      keep({ code: c, resume: j.resume });
    }
    setS((x) => ({ ...x, offline: false, aiReadAt: j?.aiReadAt ?? x.aiReadAt, mine: j?.mine ?? true, next: j?.next ?? x.next }));
  }, [make]);
  // A report when what the tab sees changes (a moment after, so a burst of changes is one report).
  // Keyed on the facts' text, never on the object: the panel makes a new one on every render, and each report's answer
  // renders the panel again.
  const factsKey = o.facts ? JSON.stringify(o.facts) : "";
  useEffect(() => {
    if (!s.code || s.ended || !factsKey) return;
    const t = setTimeout(() => void report(), 300);
    return () => clearTimeout(t);
  }, [factsKey, s.code, s.ended, report]);

  // The wait for the AI's reads: a loop on network answers, not timers, so it goes on in a hidden tab (whose timers the
  // browser slows down). A poke asks for a fresh look first; every answer ends with a report (the heartbeat).
  useEffect(() => {
    if (!s.code || s.ended) return;
    let alive = true;
    const ctrl = new AbortController();
    void (async () => {
      let attempt = 0;
      while (alive) {
        const c = code.current;
        if (!c) {
          await sleep(1000);
          continue;
        }
        const res = await fetch(`/api/setup/session/${c}/wait`, { signal: ctrl.signal, cache: "no-store" }).catch(() => null);
        if (!alive) return;
        const j = res?.ok ? ((await res.json().catch(() => null)) as { poke?: boolean; slow?: boolean } | null) : null;
        if (!j) {
          await report();
          await sleep(BACKOFF[Math.min(attempt++, BACKOFF.length - 1)]);
          continue;
        }
        attempt = 0;
        if (j.poke) {
          onPoke.current();
          // The look is quick; its facts go in this report.
          await sleep(600);
        }
        await report();
        if (j.slow) await sleep(10_000);
      }
    })();
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [s.code, s.ended, report]);

  // Back in view: a report at once.
  useEffect(() => {
    const on = () => document.visibilityState === "visible" && void report();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, [report]);

  /** End this code: the AI can't read it any more. */
  const end = useCallback(async () => {
    const c = code.current;
    if (!c) return;
    await fetch(`/api/setup/session/${c}`, { method: "DELETE" }).catch(() => null);
    code.current = null;
    keep(null);
    setS((x) => ({ ...x, code: null, ended: true, aiReadAt: null }));
  }, []);

  /** A new code (Share again, New code). */
  const fresh = useCallback(async () => {
    code.current = null;
    keep(null);
    await make(way, os, phone, { fresh: true });
  }, [make, way, os, phone]);

  /** This tab takes the setup over from another one (Continue here). */
  const takeOver = useCallback(() => {
    claim.current = true;
    void report();
  }, [report]);

  const retry = useCallback(() => void make(way, os, phone), [make, way, os, phone]);

  return { ...s, end, fresh, takeOver, retry, report };
}
