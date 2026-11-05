"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Intensity } from "@/lib/catalog/evolution";
import type { Engine, Generation } from "@/lib/catalog/types";
import { useDebounced } from "@/components/faceless/hooks";
import { send } from "@/components/shorts/hooks";
import { COMPUTER_KICK_EVENT } from "@/lib/api";

/** React Query hooks for /api/evolution/** (the Evolution tab of Video tools). */

export interface EvolutionBody {
  engine: Engine;
  intensity: Intensity;
  direction?: string;
  idea?: string;
  references: string[];
  source: { url: string; name?: string; duration?: number; fps?: number; width?: number; height?: number; hasAudio?: boolean };
  range?: { start: number; end: number };
  resolution?: string;
  /** Client nonce: a repeat of it gets the first answer (see useSubmitGuard). */
  requestId?: string;
}

export interface EvolutionEstimate {
  costUsd: number | null;
  demo: boolean;
  modelName: string;
  engine: Engine;
  resolution: string;
  pieces: number;
  seconds: number;
  steps: number;
  notes: string[];
}

export interface DirectionAnswer {
  direction: string;
  by: "claude" | "ollama" | "offline";
  why?: string;
}

/** The price and shape of a run for the current settings, asked for once typing pauses (300 ms). */
export function useEvolutionEstimate(body: EvolutionBody | null) {
  // The words don't change the price: they stay out of the key, so typing doesn't ask again.
  const key = useDebounced(body ? JSON.stringify({ ...body, direction: undefined, idea: undefined }) : null, 300);
  return useQuery({
    queryKey: ["evolution", "estimate", key],
    queryFn: async () => send<EvolutionEstimate>("/api/evolution/estimate", "POST", JSON.parse(key!)),
    enabled: !!key,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 30_000,
  });
}

export function useEvolutionActions() {
  const qc = useQueryClient();
  return {
    run: useMutation({
      mutationFn: (b: EvolutionBody) => send<{ final: Generation; items: Generation[]; direction: string; by: DirectionAnswer["by"] | "you" }>("/api/evolution", "POST", b),
      onSuccess: (r) => {
        // The tab that runs this person's jobs on the ComfyUI on this computer asks for them at once.
        window.dispatchEvent(new Event(COMPUTER_KICK_EVENT));
        r.items.forEach((g) => qc.setQueryData(["generation", g.id], g));
        void qc.invalidateQueries({ queryKey: ["generations"] });
      },
    }),
    direction: useMutation({
      mutationFn: (b: { engine: Engine; intensity: Intensity; idea?: string; references: string[]; frame?: string; seconds?: number }) => send<DirectionAnswer>("/api/evolution/direction", "POST", b),
    }),
  };
}
