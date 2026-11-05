"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { rememberedComfy } from "@/components/gpu/computer-runtime";
import { GPU_SETUP_EVENT } from "@/lib/api";
import { checkThisComputer, sendCheck } from "@/lib/gpu/browser-check";
import { BADGE_STATE } from "@/lib/gpu/readiness";
import { GPU_NEED_TEXT } from "@/lib/gpu/rtx";
import type { Badge, BadgeMap, CheckLine, FixPlan, GpuProblem, ReadinessReport, Readiness } from "@/lib/gpu/types";
import { responseError } from "@/lib/refusals";

/**
 * The GPU pre-flight in the browser: the readiness board, the badge map and a tool's fix plan (react-query keys
 * ["gpu", …], 60 s stale, refetched on focus), the live check (an NDJSON stream), and the "fuobe:gpu-setup" event
 * that opens the guided fix wherever the user is stuck.
 */

export interface ReadinessView {
  connected: boolean;
  /** Whose ComfyUI: the studio's own, a link, or the one on the person's computer (checked from this browser). */
  target?: "install" | "account" | "computer";
  reason?: "guest" | "no-gpu" | "token" | "refused" | "off";
  checkedAt?: number | null;
  stale?: boolean;
  wait?: number;
  problem?: GpuProblem;
  problemText?: string;
  problemDetail?: string;
  report?: ReadinessReport;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw Object.assign(new Error(body.error ?? "Something went wrong. Please try again."), { status: res.status });
  return body;
}

export function useGpuReadiness(enabled = true) {
  return useQuery({ queryKey: ["gpu", "readiness"], queryFn: () => getJson<ReadinessView>("/api/gpu/readiness"), staleTime: 60_000, refetchOnWindowFocus: true, enabled });
}

const NO_BADGES: BadgeMap = { connected: false, models: {}, presets: {} };

export function useGpuBadges() {
  return useQuery({
    queryKey: ["gpu", "badges"],
    queryFn: () => getJson<BadgeMap>("/api/gpu/badges").catch(() => NO_BADGES),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useGpuPlan(ref: string | null) {
  return useQuery({
    queryKey: ["gpu", "plan", ref],
    queryFn: () => getJson<FixPlan>(`/api/gpu/plan?ref=${encodeURIComponent(ref!)}`),
    enabled: !!ref,
    staleTime: 15_000,
    retry: false,
  });
}

/** A chip's state, from a badge. */
export const badgeState = (b: Badge | undefined | null): Readiness | null => (b ? BADGE_STATE[b[0]] : null);

/** The badge for a model's operation (or any of its operations), or a preset's. */
export function badgeFor(map: BadgeMap | undefined, o: { modelId?: string; op?: string; presetId?: string }): Badge | null {
  if (!map?.connected) return null;
  if (o.presetId && map.presets[o.presetId]) return map.presets[o.presetId];
  if (!o.modelId) return null;
  if (o.op && map.models[`${o.modelId}#${o.op}`]) return map.models[`${o.modelId}#${o.op}`];
  const any = Object.entries(map.models).find(([k]) => k.startsWith(`${o.modelId}#`));
  return any?.[1] ?? null;
}

/** "1 step · 12.3 GB" for a chip's tooltip and the composer's line. */
export function badgeText(b: Badge, gpu?: string): { short: string; long: string } {
  const [s, steps, tenths, flags] = b;
  const gb = tenths ? `${tenths / 10} GB` : "";
  if (s === "r") return flags & 4 ? { short: "Ready", long: "Runs on any computer" } : { short: "Ready", long: `Ready on your ${gpu ?? "GPU"}${flags & 1 ? " (slow: it borrows memory)" : ""}` };
  if (s === "g") return { short: "Bigger GPU", long: `Needs more graphics memory than your ${gpu ?? "GPU"} has` };
  // Flags 8 / 16: the card isn't the NVIDIA RTX one it needs (readiness badgeOf).
  if (s === "u" && flags & 16) return { short: "RTX 40+", long: GPU_NEED_TEXT["nvidia-rtx-40"] };
  if (s === "u" && flags & 8) return { short: "RTX only", long: GPU_NEED_TEXT["nvidia-rtx"] };
  if (s === "u") return { short: "Not here", long: "Needs its own ComfyUI, so it can't run next to your other add-ons" };
  const downloadOnly = gb && steps === 1;
  return {
    short: steps === 1 ? "1 step" : `${steps} steps`,
    long: downloadOnly ? `Needs a one-time download (${gb})` : `${steps === 1 ? "One thing" : `${steps} things`} to set up${gb ? ` (${gb})` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// The guided fix: opened by an event, from anywhere

export { GPU_SETUP_EVENT };

export interface GpuSetupDetail {
  ref: string;
  name?: string;
  plan?: FixPlan;
}

/** What "Try again" and "Run anyway" do for the request that was stopped (the composer that sent it sets them). */
let pendingRetry: { at: number; retry: () => void; skip: () => void; kind?: string } | null = null;

/** `kind`: what the run makes (image, video, audio), for the words of the card that starts it. */
export function setGpuRetry(retry: () => void, skip: () => void, kind?: string): void {
  pendingRetry = { at: Date.now(), retry, skip, ...(kind && { kind }) };
}

/** The run went through: its retry is no longer anyone's to start. */
export function dropGpuRetry(): void {
  pendingRetry = null;
}

/** The composer's retry, when it asked within the last few seconds (another page's stale one never applies). */
export function takeGpuRetry(): { retry: () => void; skip: () => void; kind?: string } | null {
  const p = pendingRetry;
  pendingRetry = null;
  return p && Date.now() - p.at < 15_000 ? p : null;
}

export function openGpuSetup(detail: GpuSetupDetail): void {
  window.dispatchEvent(new CustomEvent<GpuSetupDetail>(GPU_SETUP_EVENT, { detail }));
}

// ---------------------------------------------------------------------------
// The live check

export type CheckEvent = ({ type: "line" } & CheckLine) | ({ type: "report" } & ReadinessView) | { type: "error"; error: string };

/**
 * POST /api/gpu/check, reading its lines as they come. Resolves with the board (or throws the refusal). A ComfyUI on
 * the person's own computer is checked from this tab instead, and what it found is sent to the server.
 */
export async function runGpuCheck(onLine: (l: CheckLine) => void): Promise<ReadinessView> {
  const res = await fetch("/api/gpu/check", { method: "POST" });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; wait?: number; code?: string };
    if (res.status === 409 && body.code === "browser") {
      const where = rememberedComfy() ?? { port: 8188, host: "127.0.0.1" };
      return sendCheck<ReadinessView>(await checkThisComputer(where.port, { host: where.host, onLine }));
    }
    throw Object.assign(responseError(res, body.error ?? `The check didn't start (${res.status})`), { status: res.status, wait: body.wait });
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let report: ReadinessView | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev: CheckEvent;
      try {
        ev = JSON.parse(line) as CheckEvent;
      } catch {
        continue;
      }
      if (ev.type === "line") onLine(ev);
      else if (ev.type === "report") {
        const { type: _type, ...view } = ev;
        void _type;
        report = view;
      } else if (ev.type === "error") throw new Error(ev.error);
    }
    if (done) break;
  }
  if (!report) throw new Error("The check stopped before it finished.");
  return report;
}

/** The live checklist: run a check, keep its lines (each replaces the last line of its step), and refresh the board and chips. */
export function useGpuCheck() {
  const qc = useQueryClient();
  const [lines, setLines] = useState<CheckLine[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const start = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setRunning(true);
    setError(null);
    setLines([]);
    try {
      const view = await runGpuCheck((l) =>
        setLines((prev) => {
          const i = prev.findIndex((p) => p.step === l.step);
          if (i < 0) return [...prev, l];
          const next = [...prev];
          next[i] = l;
          return next;
        }),
      );
      qc.setQueryData(["gpu", "readiness"], view);
      void qc.invalidateQueries({ queryKey: ["gpu", "badges"] });
      void qc.invalidateQueries({ queryKey: ["gpu", "plan"] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      busy.current = false;
      setRunning(false);
    }
  }, [qc]);
  return { lines, running, error, start };
}
