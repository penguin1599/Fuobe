"use client";

import type { OriginalSound } from "@/lib/av/original-sound";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { nanoid } from "nanoid";
import { useCallback, useDeferredValue, useRef } from "react";
import type { ShortsCustomPreset, ShortsRange, ShortsRatio, ShortsSession } from "@/lib/catalog/shorts";
import type { Engine, Generation } from "@/lib/catalog/types";
import { COMPUTER_KICK_EVENT, useGenerationEvents } from "@/lib/api";
import { responseError } from "@/lib/refusals";

/** React Query hooks for /api/shorts/** (kept next to the studio that uses them). */

/**
 * A run started: the tab that runs this person's jobs on the ComfyUI on this computer (an account's "Your GPU") asks for
 * them at once, as after a studio run.
 */
const kick = () => window.dispatchEvent(new Event(COMPUTER_KICK_EVENT));

async function json<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw responseError(res, body.error ?? "Something went wrong. Please try again.");
  return body;
}

export const send = async <T>(url: string, method: string, body?: unknown) =>
  json<T>(await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));

export interface ShortsBody {
  engine: Engine;
  presetId: string;
  /** fps: the clip's own rate (Fuobe Shorts in the cloud cuts and bills on frames). */
  source: { url: string; name?: string; duration?: number; width?: number; height?: number; fps?: number };
  range: ShortsRange;
  aspectRatio: ShortsRatio;
  language: string;
  modelId?: string;
  /** What of the clip's sound goes back (src/lib/av/original-sound.ts). */
  originalSound?: OriginalSound;
  /** Client nonce: a repeat of it gets the first answer (see useSubmitGuard). */
  requestId?: string;
}

export interface ShortsEstimate {
  costUsd: number | null;
  perSegmentUsd: number | null;
  demo: boolean;
  segments: number;
  seconds: number;
  refsSent: number;
  notes: string[];
}

export interface ShortsSessionView extends ShortsSession {
  generations: Record<string, Generation>;
  regenerateUsd: number | null;
}

export interface ShortsSessionCard {
  id: string;
  title: string;
  engine: Engine;
  lookName: string;
  segments: number;
  seconds: number;
  createdAt: number;
  updatedAt: number;
  cover: Generation | null;
  status: "rendering" | "ready" | "failed";
}

const active = (g?: Generation) => !!g && (g.status === "queued" || g.status === "running");

/**
 * One paid submit at a time. A second click while the first is on its way does nothing, and the
 * request carries a nonce that stays the same for the same `key` until a submit succeeds, so the
 * server answers a repeat (a lost response, a retry) with the first result instead of a second run.
 * `hold` keeps it busy after success (the page is navigating away).
 */
export function useSubmitGuard() {
  const busy = useRef(false);
  const last = useRef<{ key: string; id: string } | null>(null);
  return useCallback(async <T>(key: string, fn: (requestId: string) => Promise<T>, opts: { hold?: boolean } = {}): Promise<T | undefined> => {
    if (busy.current) return undefined;
    busy.current = true;
    const id = last.current?.key === key ? last.current.id : nanoid(16);
    last.current = { key, id };
    let ok = false;
    try {
      const out = await fn(id);
      ok = true;
      last.current = null;
      return out;
    } finally {
      if (!ok || !opts.hold) busy.current = false;
    }
  }, []);
}

/** Price and shape of a session before it starts (debounced by React's deferred value). */
export function useShortsEstimate(body: ShortsBody | null) {
  const key = useDeferredValue(body ? JSON.stringify(body) : null);
  return useQuery({
    queryKey: ["shorts", "estimate", key],
    queryFn: async () => send<ShortsEstimate>("/api/shorts/estimate", "POST", JSON.parse(key!)),
    enabled: !!key,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 30_000,
  });
}

export function useShortsSessions() {
  const qc = useQueryClient();
  const connected = useGenerationEvents((ev) => {
    if (ev.type === "generation" && ev.generation.feature.startsWith("shorts")) void qc.invalidateQueries({ queryKey: ["shorts", "sessions"] });
  });
  return useQuery({
    queryKey: ["shorts", "sessions"],
    queryFn: async () => (await json<{ items: ShortsSessionCard[] }>(await fetch("/api/shorts/sessions"))).items,
    refetchInterval: (q) => (q.state.data?.some((s) => s.status === "rendering") ? (connected ? 10_000 : 2500) : false),
  });
}

export function useShortsSession(id: string) {
  const qc = useQueryClient();
  const connected = useGenerationEvents((ev) => {
    const data = qc.getQueryData<ShortsSessionView>(["shorts", "session", id]);
    const gid = ev.type === "generation" ? ev.generation.id : ev.id;
    if (!data) return;
    if (ev.type === "generation" && data.generations[gid]) {
      // Patch the row in place (progress, status, outputs); a new id refetches the session.
      qc.setQueryData<ShortsSessionView>(["shorts", "session", id], { ...data, generations: { ...data.generations, [gid]: ev.generation } });
    } else if (ev.type === "deleted" && data.generations[gid]) void qc.invalidateQueries({ queryKey: ["shorts", "session", id] });
  });
  return useQuery({
    queryKey: ["shorts", "session", id],
    queryFn: async () => json<ShortsSessionView>(await fetch(`/api/shorts/sessions/${id}`)),
    retry: (n, e) => n < 1 && !/no longer exists/.test((e as Error).message),
    refetchInterval: (q) => (Object.values(q.state.data?.generations ?? {}).some(active) ? (connected ? 8000 : 1500) : false),
  });
}

export function useShortsPresets() {
  return useQuery({
    queryKey: ["shorts", "presets"],
    queryFn: async () => (await json<{ items: ShortsCustomPreset[] }>(await fetch("/api/shorts/presets"))).items,
    staleTime: 30_000,
  });
}

export function useShortsActions(id?: string) {
  const qc = useQueryClient();
  const put = (s: ShortsSessionView) => {
    qc.setQueryData(["shorts", "session", s.id], (old: ShortsSessionView | undefined) => ({ ...s, regenerateUsd: old?.regenerateUsd ?? null }));
    void qc.invalidateQueries({ queryKey: ["shorts", "sessions"] });
  };
  return {
    create: useMutation({
      mutationFn: (body: ShortsBody) => send<ShortsSession>("/api/shorts/sessions", "POST", body),
      onSuccess: () => {
        kick();
        void qc.invalidateQueries({ queryKey: ["shorts", "sessions"] });
      },
    }),
    regenerate: useMutation({
      mutationFn: (v: { index: number; requestId?: string }) => send<ShortsSessionView>(`/api/shorts/sessions/${id}/segments/${v.index}`, "POST", { requestId: v.requestId }),
      onSuccess: (s: ShortsSessionView) => {
        kick();
        put(s);
      },
    }),
    enhance: useMutation({
      mutationFn: (v: { index: number; requestId?: string }) => send<ShortsSessionView>(`/api/shorts/sessions/${id}/segments/${v.index}/enhance`, "POST", { requestId: v.requestId }),
      onSuccess: put,
    }),
    primary: useMutation({
      mutationFn: (v: { index: number; generationId: string }) => send<ShortsSessionView>(`/api/shorts/sessions/${id}/segments/${v.index}/primary`, "POST", { generationId: v.generationId }),
      onSuccess: put,
    }),
    stitch: useMutation({
      mutationFn: (v: { requestId?: string } = {}) => send<ShortsSessionView>(`/api/shorts/sessions/${id}/stitch`, "POST", { requestId: v.requestId }),
      onSuccess: (s: ShortsSessionView) => {
        kick();
        put(s);
      },
    }),
    rename: useMutation({
      mutationFn: (title: string) => send<ShortsSession>(`/api/shorts/sessions/${id}`, "PATCH", { title }),
      onSuccess: () => void qc.invalidateQueries({ queryKey: ["shorts"] }),
    }),
    remove: useMutation({
      mutationFn: (sid: string) => send<{ trashed: number }>(`/api/shorts/sessions/${sid}`, "DELETE"),
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: ["shorts", "sessions"] });
        void qc.invalidateQueries({ queryKey: ["generations"] });
        void qc.invalidateQueries({ queryKey: ["library"] });
      },
    }),
  };
}

export function usePresetActions() {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: ["shorts", "presets"] });
  return {
    create: useMutation({
      mutationFn: (b: { name?: string; description?: string; references: string[] }) => send<ShortsCustomPreset>("/api/shorts/presets", "POST", b),
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: (b: { id: string; name?: string; description?: string; references?: string[] }) => send<ShortsCustomPreset>(`/api/shorts/presets/${b.id}`, "PATCH", b),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (pid: string) => send<void>(`/api/shorts/presets/${pid}`, "DELETE"),
      onSuccess: done,
    }),
  };
}
