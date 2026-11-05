"use client";

import type { OriginalSound } from "@/lib/av/original-sound";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CharacterOptions } from "@/lib/catalog/character-swap";
import type { FinishOptions, GenjutsuLook, GenjutsuMode, GenjutsuTarget, GenjutsuTier, MakerSource, ObjectEdit, PictureOptions } from "@/lib/catalog/genjutsu";
import type { Engine, Generation, PixelPoint } from "@/lib/catalog/types";
import { useDebounced } from "@/components/faceless/hooks";
import { send } from "@/components/shorts/hooks";
import { COMPUTER_KICK_EVENT } from "@/lib/api";

/**
 * A run started: the tab that runs this person's jobs on the ComfyUI on this computer (an account's "Your GPU") asks for
 * them at once, as after a studio run.
 */
const kick = () => window.dispatchEvent(new Event(COMPUTER_KICK_EVENT));

/** React Query hooks for /api/genjutsu/**. */

export interface GenjutsuBody {
  engine: Engine;
  mode: GenjutsuMode;
  modelId?: string;
  tier?: GenjutsuTier;
  quality?: string;
  target?: GenjutsuTarget;
  subject?: string;
  prompt?: string;
  points?: PixelPoint[];
  frame?: { width: number; height: number };
  mask?: string;
  references?: string[];
  look?: GenjutsuLook;
  source: { url: string; name?: string; duration?: number; fps?: number; width?: number; height?: number; hasAudio?: boolean };
  range?: { start: number; end: number };
  seed?: number;
  /** Character swap's settings. */
  character?: CharacterOptions;
  /** Hard cuts the browser found in the clip (seconds): the server warns when the part has one. */
  cuts?: number[];
  /** Object swap on Scene edit, From picture, Finish. */
  object?: ObjectEdit;
  picture?: PictureOptions;
  finish?: FinishOptions;
  /** What of the clip's sound goes back where it is put back (src/lib/av/original-sound.ts). */
  originalSound?: OriginalSound;
  /** Client nonce: a repeat of it gets the first answer (see useSubmitGuard). */
  requestId?: string;
}

export interface GenjutsuEstimate {
  costUsd: number | null;
  demo: boolean;
  modelId: string;
  modelName: string;
  /** A Fuobe Original, other open weights, or a partner's model. */
  source: MakerSource;
  tier?: GenjutsuTier;
  quality?: string;
  pieces: number;
  seconds: number;
  steps: number;
  notes: string[];
  /** Character swap: first frames made, the limits, and the GPU the open route was tested on. */
  anchors?: number;
  limits?: string[];
  gpu?: { weightsGb: number; tested: string; advice: string; speed: string };
}

/** The price and shape of a run for the current settings, asked for once typing pauses (300 ms). */
export function useGenjutsuEstimate(body: GenjutsuBody | null) {
  const key = useDebounced(body ? JSON.stringify(body) : null, 300);
  return useQuery({
    queryKey: ["genjutsu", "estimate", key],
    queryFn: async () => send<GenjutsuEstimate>("/api/genjutsu/estimate", "POST", JSON.parse(key!)),
    enabled: !!key,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 30_000,
  });
}

export function useGenjutsuRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: GenjutsuBody) => send<{ final: Generation; items: Generation[] }>("/api/genjutsu", "POST", b),
    onSuccess: (r) => {
      kick();
      r.items.forEach((g) => qc.setQueryData(["generation", g.id], g));
      void qc.invalidateQueries({ queryKey: ["generations"] });
    },
  });
}

/**
 * "Describe my character": the site's AI helper answers with the description (the owner's cloud engine); otherwise the
 * GPU describer starts and the page reads the description from its run's text (describeFromRun).
 */
export function useDescribeCharacter() {
  return useMutation({
    mutationFn: (b: { engine: Engine; image: string; requestId?: string }) => send<{ description: string } | { id: string; modelId: string }>("/api/genjutsu/describe", "POST", b),
    onSuccess: (r) => {
      if ("id" in r) kick();
    },
  });
}

/** From picture's "What happens": the describer starts on the part (the page waits for its text). */
export function useDescribeScene() {
  return useMutation({
    mutationFn: (b: { engine: "open"; source: { url: string; duration?: number }; range: { start: number; end: number }; frame?: string; ownPerson?: boolean }) =>
      send<{ id: string; modelId: string }>("/api/genjutsu/scene", "POST", b),
    onSuccess: kick,
  });
}

/** The clip's words (one transcription; the page takes the part's lines from its cues). */
export function useTranscribeClip() {
  return useMutation({ mutationFn: (b: { engine: Engine; source: { url: string; duration?: number }; cleanVoiceFirst?: boolean }) => send<{ id: string; modelId: string }>("/api/genjutsu/transcribe", "POST", b), onSuccess: kick });
}

/** Waits for one generation to finish (polling; the page's helpers that fill a field from it). */
export async function waitForGeneration(id: string, o: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Generation> {
  const deadline = Date.now() + (o.timeoutMs ?? 15 * 60_000);
  while (Date.now() < deadline) {
    if (o.signal?.aborted) throw new Error("Stopped");
    const res = await fetch(`/api/generations/${id}`, { signal: o.signal });
    if (!res.ok) throw new Error(res.status === 404 ? "That job is gone" : "Something went wrong. Please try again.");
    const g = (await res.json()) as Generation;
    if (g.status === "succeeded") return g;
    if (g.status === "failed" || g.status === "canceled") throw new Error(g.error || "It didn't finish");
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("It is taking too long — try again later");
}
