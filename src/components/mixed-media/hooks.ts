"use client";

import type { OriginalSound } from "@/lib/av/original-sound";
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue } from "react";
import type { MixedMode, MixedResolution, MixedValues } from "@/lib/catalog/mixed-media";
import type { Engine, Generation } from "@/lib/catalog/types";
import { COMPUTER_KICK_EVENT, useGenerationEvents } from "@/lib/api";
import { send } from "@/components/shorts/hooks";

/** React Query hooks for /api/mixed-media/** (renders, preview frames, estimates). */

export interface MixedBody {
  engine: Engine;
  presetId: string;
  values: MixedValues;
  source: { url: string; name?: string; duration?: number; fps?: number; width?: number; height?: number };
  range: { start: number; end: number };
  fps: number;
  resolution: MixedResolution;
  modelId?: string;
  /** Frame by frame (default), Smooth or (cloud) Fast. */
  mode?: MixedMode;
  anchor?: string;
  frameUrl?: string;
  /** What of the clip's sound goes back (src/lib/av/original-sound.ts). */
  originalSound?: OriginalSound;
  /** Client nonce: a repeat of it gets the first answer (see useSubmitGuard). */
  requestId?: string;
}

export interface MixedEstimate {
  costUsd: number | null;
  previewUsd: number | null;
  demo: boolean;
  frames: number;
  /** The rate frames are taken at (cloud Per frame: the clip's own over a whole number). */
  fps: number;
  mode?: MixedMode;
  /** Cloud Per frame: what one redrawn frame costs. */
  perFrameUsd?: number | null;
  notes: string[];
}

export interface FramesProgress {
  total: number;
  done: number;
  running: number;
  failed?: { label: string; error: string };
}

/**
 * A per-frame render's frame edits (counts and the first failure), by its finished video's id: polled while "live"
 * (the frames are being redrawn), read once when "once" (a render that failed: its counts no longer change), not at all when null.
 */
export function useFramesProgress(finalId: string | null | undefined, mode: "live" | "once" | null) {
  return useQuery({
    // The mode is in the key: a render that just failed is read once more, after its last poll.
    queryKey: ["mixed-media", "frames", finalId, mode],
    queryFn: async () => send<FramesProgress>(`/api/mixed-media/progress?id=${encodeURIComponent(finalId!)}`, "GET"),
    enabled: !!finalId && !!mode,
    refetchInterval: mode === "live" ? 2000 : false,
    staleTime: mode === "once" ? Infinity : 0,
  });
}

export function useMixedEstimate(body: MixedBody | null) {
  const key = useDeferredValue(body ? JSON.stringify(body) : null);
  return useQuery({
    queryKey: ["mixed-media", "estimate", key],
    queryFn: async () => send<MixedEstimate>("/api/mixed-media/estimate", "POST", JSON.parse(key!)),
    enabled: !!key,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 30_000,
  });
}

const active = (g?: Generation | null) => !!g && (g.status === "queued" || g.status === "running");

/** Follow one generation (a preview frame, the latest render) until it settles. */
export function useWatchedGeneration(id: string | null) {
  const qc = useQueryClient();
  const connected = useGenerationEvents((ev) => {
    if (!id) return;
    if (ev.type === "generation" && ev.generation.id === id) qc.setQueryData(["mixed-media", "generation", id], ev.generation);
  });
  return useQuery({
    queryKey: ["mixed-media", "generation", id],
    queryFn: async () => send<Generation>(`/api/generations/${id}`, "GET"),
    enabled: !!id,
    refetchInterval: (q) => (active(q.state.data) ? (connected ? 5000 : 1200) : false),
  });
}

/** Follow every step of a render (cut → restyle → sound), so a failed step shows its own error. */
export function useWatchedChain(ids: string[]): (Generation | undefined)[] {
  const qc = useQueryClient();
  const connected = useGenerationEvents((ev) => {
    if (ev.type === "generation" && ids.includes(ev.generation.id)) qc.setQueryData(["mixed-media", "generation", ev.generation.id], ev.generation);
  });
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: ["mixed-media", "generation", id],
      queryFn: async () => send<Generation>(`/api/generations/${id}`, "GET"),
      refetchInterval: (q: { state: { data?: Generation } }) => (active(q.state.data) ? (connected ? 5000 : 1200) : false),
    })),
  }).map((q) => q.data);
}

/** What a step of a render is doing (a per-frame render's assembly waits while the frames are redrawn). */
function stepLabel(g: Generation): string {
  switch (g.op) {
    case "trim":
      return "Cutting the clip";
    case "mux":
      return "Putting the sound back";
    case "extract-frames":
      return "Taking the frames";
    case "images-to-video":
      return g.status === "queued" && !g.progress ? "Redrawing the frames" : "Putting the frames together";
    case "concat":
      return "Joining the clips";
    // Smooth: each piece's first frame, drawn in the look, then carried through by Wan 2.2 Fun VACE.
    case "frame":
      return "Taking the first frame";
    case "edit":
      return "Drawing the first frame in the look";
    default:
      return "Restyling";
  }
}

/** What each step of a render is doing, for chainState(). */
export function renderSteps(chain: (Generation | undefined)[]): { g?: Generation; label: string }[] {
  return chain.map((g) => ({ g, label: g ? stepLabel(g) : "A step" }));
}

/** A per-frame render (its frames go back together in an images-to-video step; a retry may keep the extraction from before). */
export const isFrameRender = (chain: (Generation | undefined)[]) => chain.some((g) => g?.op === "extract-frames" || g?.op === "images-to-video");

/**
 * A run started: the tab that runs this person's jobs on the ComfyUI on this computer (an account's "Your GPU") asks for
 * them at once, as after a studio run.
 */
const kick = () => window.dispatchEvent(new Event(COMPUTER_KICK_EVENT));

export function useMixedActions() {
  const qc = useQueryClient();
  const seed = (g: Generation) => qc.setQueryData(["mixed-media", "generation", g.id], g);
  return {
    render: useMutation({
      mutationFn: (b: MixedBody) => send<{ final: Generation; items: Generation[]; frames?: number }>("/api/mixed-media", "POST", b),
      onSuccess: (r) => {
        kick();
        r.items.forEach(seed);
        void qc.invalidateQueries({ queryKey: ["generations"] });
      },
    }),
    preview: useMutation({
      mutationFn: (b: MixedBody) => send<Generation>("/api/mixed-media/preview", "POST", b),
      onSuccess: (g) => {
        kick();
        seed(g);
      },
    }),
    /** Run a finished-or-failed render again with the same settings (History's "Try again"). */
    retry: useMutation({
      mutationFn: (v: { id: string; requestId?: string }) => send<{ final: Generation; items: Generation[]; frames?: number }>("/api/mixed-media/retry", "POST", v),
      onSuccess: (r) => {
        kick();
        r.items.forEach(seed);
        void qc.invalidateQueries({ queryKey: ["generations"] });
      },
    }),
  };
}
