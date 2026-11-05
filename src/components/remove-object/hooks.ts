"use client";

import type { OriginalSound } from "@/lib/av/original-sound";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RemoveMode } from "@/lib/catalog/remove-object";
import type { Engine, Generation, PixelPoint } from "@/lib/catalog/types";
import { useDebounced } from "@/components/faceless/hooks";
import { send } from "@/components/shorts/hooks";
import { COMPUTER_KICK_EVENT } from "@/lib/api";

/** React Query hooks for /api/remove-object/** (the Remove object tab of Video tools). */

export interface RemovalBody {
  engine: Engine;
  mode: RemoveMode;
  modelId?: string;
  effects?: boolean;
  prompt?: string;
  points?: PixelPoint[];
  frame?: { width: number; height: number };
  mask?: string;
  source: { url: string; name?: string; duration?: number; fps?: number; width?: number; height?: number; hasAudio?: boolean };
  range?: { start: number; end: number };
  /** H3 Person Removal: the person's mask grown by this many pixels. */
  maskGrow?: number;
  /** What of the clip's sound goes back (src/lib/av/original-sound.ts). */
  originalSound?: OriginalSound;
  /** Client nonce: a repeat of it gets the first answer (see useSubmitGuard). */
  requestId?: string;
}

export interface RemovalEstimate {
  costUsd: number | null;
  demo: boolean;
  modelId: string;
  modelName: string;
  pieces: number;
  seconds: number;
  steps: number;
  notes: string[];
  previewUsd: number | null;
  /** The preview is the mask the eraser works from (false: SAM 3.1's reading of the words or clicks). */
  previewExact: boolean;
  /** The preview is H3 Person Removal's green mask. */
  previewGreen: boolean;
}

/** The price and shape of a removal for the current settings, asked for once typing pauses (300 ms). */
export function useRemovalEstimate(body: RemovalBody | null) {
  const key = useDebounced(body ? JSON.stringify(body) : null, 300);
  return useQuery({
    queryKey: ["remove-object", "estimate", key],
    queryFn: async () => send<RemovalEstimate>("/api/remove-object/estimate", "POST", JSON.parse(key!)),
    enabled: !!key,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 30_000,
  });
}

/**
 * A run started: the tab that runs this person's jobs on the ComfyUI on this computer (an account's "Your GPU") asks for
 * them at once, as after a studio run.
 */
const kick = () => window.dispatchEvent(new Event(COMPUTER_KICK_EVENT));

export function useRemovalActions() {
  const qc = useQueryClient();
  const seed = (g: Generation) => qc.setQueryData(["generation", g.id], g);
  return {
    run: useMutation({
      mutationFn: (b: RemovalBody) => send<{ final: Generation; items: Generation[] }>("/api/remove-object", "POST", b),
      onSuccess: (r) => {
        kick();
        r.items.forEach(seed);
        void qc.invalidateQueries({ queryKey: ["generations"] });
      },
    }),
    reroll: useMutation({
      mutationFn: (b: { id: string; window: number; seed?: number; requestId?: string }) => send<{ final: Generation; items: Generation[] }>("/api/remove-object/reroll", "POST", b),
      onSuccess: (r) => {
        kick();
        r.items.forEach(seed);
        void qc.invalidateQueries({ queryKey: ["generations"] });
      },
    }),
    preview: useMutation({
      mutationFn: (b: RemovalBody) => send<Generation>("/api/remove-object/preview", "POST", b),
      onSuccess: (g) => {
        kick();
        seed(g);
      },
    }),
  };
}
