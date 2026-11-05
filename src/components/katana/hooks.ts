"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { COMPUTER_KICK_EVENT, useGenerationEvents } from "@/lib/api";
import type { KatanaJobView, Segment } from "@/lib/av/katana";
import type { Engine } from "@/lib/catalog/types";
import { responseError } from "@/lib/refusals";

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw responseError(res, body.error ?? "Something went wrong. Please try again.");
  return body;
}

export interface KatanaBody {
  engine: Engine;
  reference: string;
  photos: string[];
  instructions?: string;
  segments?: Segment[];
  length?: number;
  duration?: number;
  motionModel?: string;
  aspectRatio?: "16:9" | "9:16" | "1:1";
  keepAudio?: boolean;
  title?: string;
}

export interface KatanaPreview {
  segments: Segment[];
  steps: number;
  costUsd: number | null;
  demo: boolean;
  model: string;
}

const post = async <T>(url: string, body: KatanaBody) => json<T>(await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

export function useKatanaJobs() {
  const qc = useQueryClient();
  const connected = useGenerationEvents((ev) => {
    if (ev.type === "generation" && ev.generation.feature === "katana") void qc.invalidateQueries({ queryKey: ["katana"] });
  });
  return useQuery({
    queryKey: ["katana"],
    queryFn: async () => (await json<{ items: KatanaJobView[] }>(await fetch("/api/katana"))).items,
    refetchInterval: (q) => (q.state.data?.some((j) => Object.values(j.generations).some((g) => g.status === "queued" || g.status === "running")) ? (connected ? 8000 : 2000) : false),
  });
}

/** The plan and price of the current settings (debounced by the caller through `body`). */
export function useKatanaPreview(body: KatanaBody | null) {
  return useQuery({
    queryKey: ["katana-preview", body],
    enabled: !!body,
    queryFn: () => post<KatanaPreview>("/api/katana?preview=1", body!),
    retry: false,
    staleTime: 30_000,
  });
}

/**
 * A run started: the tab that runs this person's jobs on the ComfyUI on this computer (an account's "Your GPU") asks for
 * them at once, as after a studio run.
 */
const kick = () => window.dispatchEvent(new Event(COMPUTER_KICK_EVENT));

export function useKatanaActions() {
  const qc = useQueryClient();
  const start = useMutation({
    mutationFn: (body: KatanaBody) => post<KatanaJobView>("/api/katana", body),
    onSuccess: (job) => {
      kick();
      qc.setQueryData<KatanaJobView[]>(["katana"], (xs) => [job, ...(xs ?? [])]);
      void qc.invalidateQueries({ queryKey: ["generations"] });
    },
  });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/katana/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw responseError(res, "Couldn't remove it");
      return id;
    },
    onSuccess: (id) => qc.setQueryData<KatanaJobView[]>(["katana"], (xs) => xs?.filter((j) => j.id !== id)),
  });
  /** Retry the failed steps (all: the whole run again, as a new run). */
  const retry = useMutation({
    mutationFn: async ({ id, all }: { id: string; all?: boolean }) => json<KatanaJobView>(await fetch(`/api/katana/${id}/retry${all ? "?all=1" : ""}`, { method: "POST" })),
    onSuccess: (job, { all }) => {
      kick();
      qc.setQueryData<KatanaJobView[]>(["katana"], (xs) => (all ? [job, ...(xs ?? [])] : (xs ?? []).map((j) => (j.id === job.id ? job : j))));
      void qc.invalidateQueries({ queryKey: ["generations"] });
    },
  });
  return { start, remove, retry };
}
