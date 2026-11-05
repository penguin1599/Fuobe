"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { COMPUTER_KICK_EVENT, useGenerationEvents } from "@/lib/api";
import type {
  ChangePart,
  ChangePreview,
  ChannelSettings,
  EpisodeCard,
  EpisodeSettings,
  EpisodeView,
  EstimateResult,
  ExplainerSource,
  FacelessChannel,
  FacelessEpisode,
  FacelessGenre,
  ScriptBlock,
  TopicIdea,
} from "@/lib/catalog/faceless";
import type { Engine, Generation } from "@/lib/catalog/types";
import { responseError } from "@/lib/refusals";

/** React Query hooks for /api/faceless/** and /api/explainer/** (kept next to the views that use them). */

async function json<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw responseError(res, body.error ?? "Something went wrong. Please try again.");
  return body;
}

/** POSTs that only ask (a price, topic ideas, a page read): nothing runs. */
const ASKS = /\/(estimate|topics|link)$/;

const send = async <T,>(url: string, method: string, body?: unknown) => {
  const out = await json<T>(await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  // A run may have started (a render, a reading, a picture): the tab that runs this person's jobs on the ComfyUI on this
  // computer (an account's "Your GPU") asks for them at once, as after a studio run.
  if (method === "POST" && !ASKS.test(url) && !(url.endsWith("/change") && !(body as { apply?: boolean } | undefined)?.apply)) window.dispatchEvent(new Event(COMPUTER_KICK_EVENT));
  return out;
};

const inFlight = (s: string) => s === "writing" || s === "rendering";

// ---------------------------------------------------------------------------
// Channels

export function useChannels() {
  return useQuery({
    queryKey: ["faceless", "channels"],
    queryFn: async () => (await json<{ items: FacelessChannel[] }>(await fetch("/api/faceless/channels"))).items,
    refetchInterval: (q) => (q.state.data?.length ? 15_000 : false),
  });
}

export function useChannel(id: string) {
  return useQuery({
    queryKey: ["faceless", "channel", id],
    queryFn: async () => json<{ channel: FacelessChannel; episodes: EpisodeCard[] }>(await fetch(`/api/faceless/channels/${id}`)),
    retry: (n, e) => !/not found/i.test((e as Error).message) && n < 1,
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return false;
      // An avatar being drawn, or a new channel's name on its way from the LLM.
      if (d.channel.avatarJob || Date.now() - d.channel.createdAt < 20_000) return 2500;
      return d.episodes.some((e) => inFlight(e.status)) ? 3000 : false;
    },
  });
}

export function useCreateChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { idea: string; genre: FacelessGenre; engine: Engine; reference?: string }) => send<FacelessChannel>("/api/faceless/channels", "POST", b),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["faceless", "channels"] }),
  });
}

export function useUpdateChannel(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { name?: string; idea?: string; genre?: FacelessGenre; avatarUrl?: string | null; reference?: string | null; settings?: Partial<ChannelSettings> }) =>
      send<FacelessChannel>(`/api/faceless/channels/${id}`, "PATCH", b),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["faceless"] }),
  });
}

export function useDeleteChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => send<void>(`/api/faceless/channels/${id}`, "DELETE"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["faceless", "channels"] }),
  });
}

export const makeAvatar = (id: string) => send<Generation>(`/api/faceless/channels/${id}/avatar`, "POST");

export const suggestTopics = (b: { channelId?: string; idea?: string; genre?: FacelessGenre; engine: Engine; avoid?: string[]; round?: number }) =>
  send<{ topics: TopicIdea[]; offline: boolean }>("/api/faceless/topics", "POST", b);

// ---------------------------------------------------------------------------
// Episodes

export function useCreateEpisode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { channelId: string; topic: string; script?: string; settings: EpisodeSettings; saveLook?: boolean }) => send<FacelessEpisode>("/api/faceless/episodes", "POST", b),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["faceless"] }),
  });
}

/**
 * One episode with its steps. It follows the shared live stream (a step's generation changing refetches
 * the view) and polls slowly as a safety net while something is writing or rendering.
 */
export function useEpisode(id: string) {
  const qc = useQueryClient();
  const ids = useRef<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connected = useGenerationEvents((ev) => {
    if (!ids.current.has(ev.type === "deleted" ? ev.id : ev.generation.id)) return;
    // Several steps change at once: refetch once per burst.
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void qc.invalidateQueries({ queryKey: ["faceless", "episode", id] });
    }, 400);
  });
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const q = useQuery({
    queryKey: ["faceless", "episode", id],
    queryFn: async () => json<EpisodeView>(await fetch(`/api/faceless/episodes/${id}`)),
    retry: (n, e) => !/not found/i.test((e as Error).message) && n < 1,
    refetchInterval: (q) => {
      const s = q.state.data?.episode.status;
      const up = q.state.data?.upscaled?.status;
      const regen = q.state.data?.regenerated?.status;
      if (up === "queued" || up === "running" || regen === "queued" || regen === "running") return connected ? 8000 : 2000;
      if (!s || !inFlight(s)) return false;
      return s === "writing" ? 1500 : connected ? 8000 : 2000;
    },
  });
  useEffect(() => {
    const plan = q.data?.episode.plan;
    ids.current = new Set([...Object.values(plan?.ids ?? {}), ...(plan?.upscaled ? [plan.upscaled] : []), ...Object.values(plan?.regenerated?.ids ?? {})]);
  }, [q.data]);
  return q;
}

function useEpisodeMutation<B>(id: string, run: (b: B) => Promise<EpisodeView>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (v) => {
      qc.setQueryData(["faceless", "episode", id], v);
      void qc.invalidateQueries({ queryKey: ["faceless", "channel"] });
      void qc.invalidateQueries({ queryKey: ["faceless", "explainers"] });
    },
  });
}

export function useUpdateEpisode(id: string) {
  return useEpisodeMutation(id, (b: { title?: string; favorite?: boolean; blocks?: Partial<ScriptBlock>[]; settings?: Partial<EpisodeSettings> }) =>
    send<EpisodeView>(`/api/faceless/episodes/${id}`, "PATCH", b),
  );
}

export function useEpisodeAction(id: string) {
  return useEpisodeMutation(id, (action: "render" | "retry" | "rewrite" | "undo" | "upscale" | "regenerate") => send<EpisodeView>(`/api/faceless/episodes/${id}/${action}`, "POST"));
}

export interface ChangeDraft {
  blocks: string[];
  part: ChangePart;
  instruction?: string;
  narration?: string[];
}

export function useApplyChange(id: string) {
  return useEpisodeMutation(id, (c: ChangeDraft) => send<EpisodeView>(`/api/faceless/episodes/${id}/change`, "POST", { ...c, apply: true }));
}

export function useDeleteEpisode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => send<void>(`/api/faceless/episodes/${id}`, "DELETE"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["faceless"] }),
  });
}

/** What a change would re-run and cost, recomputed (debounced) as the draft changes. */
export function useChangePreview(id: string, draft: ChangeDraft | null) {
  const key = draft && JSON.stringify(draft);
  const debounced = useDebounced(key, 450);
  return useQuery({
    queryKey: ["faceless", "change", id, debounced],
    enabled: !!debounced,
    queryFn: async () => send<ChangePreview>(`/api/faceless/episodes/${id}/change`, "POST", JSON.parse(debounced!)),
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Estimates, voices, Explainer

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useEstimate(input: { kind: "faceless" | "explainer"; settings: EpisodeSettings; blocks?: ScriptBlock[]; genre?: FacelessGenre } | null) {
  const key = input && JSON.stringify(input);
  const debounced = useDebounced(key, 350);
  const q = useQuery({
    queryKey: ["faceless", "estimate", debounced],
    enabled: !!debounced,
    queryFn: async () => send<EstimateResult>("/api/faceless/estimate", "POST", JSON.parse(debounced!)),
    placeholderData: keepPreviousData,
    staleTime: 20_000,
    retry: false,
  });
  // Still showing the last settings' estimate: the new one is on its way.
  return { data: q.data, isFetching: q.isFetching || key !== debounced };
}

export const voicePreview = (id: string) => send<Generation>("/api/faceless/voices/preview", "POST", { id });
export const readGeneration = async (id: string) => json<Generation>(await fetch(`/api/generations/${id}`));

/** Follow one generation until it finishes (voice previews, avatars). */
export async function waitFor(id: string, signal?: AbortSignal): Promise<Generation> {
  for (;;) {
    const g = await readGeneration(id);
    if (g.status === "succeeded" || g.status === "failed" || g.status === "canceled") return g;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await new Promise((r) => setTimeout(r, 900));
  }
}

export function useExplainers(o: { q: string; liked: boolean }) {
  const q = useDebounced(o.q, 250);
  return useQuery({
    queryKey: ["faceless", "explainers", q, o.liked],
    queryFn: async () => (await json<{ items: EpisodeCard[] }>(await fetch(`/api/explainer?${new URLSearchParams({ ...(q && { q }), ...(o.liked && { liked: "1" }) })}`))).items,
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (query.state.data?.some((e) => inFlight(e.status)) ? 3000 : false),
  });
}

export function useCreateExplainer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { prompt: string; sources: ExplainerSource[]; settings: EpisodeSettings; review?: boolean }) => send<FacelessEpisode>("/api/explainer", "POST", b),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["faceless", "explainers"] }),
  });
}

export const readLink = (url: string, engine: Engine) => send<Extract<ExplainerSource, { kind: "link" }>>("/api/explainer/link", "POST", { url, engine });

/** A PDF or Word source: read (and, when long, summarised) on the server; the file itself isn't kept. */
export async function readDocument(file: File, engine: Engine) {
  const form = new FormData();
  form.append("file", file);
  form.append("engine", engine);
  return json<{ source: Extract<ExplainerSource, { kind: "text" }>; pages?: number; readPages?: number; summarized: boolean }>(await fetch("/api/explainer/document", { method: "POST", body: form }));
}

export function useLikeEpisode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { id: string; favorite: boolean }) => send<EpisodeView>(`/api/faceless/episodes/${b.id}`, "PATCH", { favorite: b.favorite }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["faceless"] }),
  });
}
