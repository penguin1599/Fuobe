"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { AudioToolPreview } from "@/lib/av/audio-tools";
import type { Engine, Generation } from "@/lib/catalog/types";
import type { SpeechEffect } from "@/lib/speech-edit";
import { COMPUTER_KICK_EVENT } from "@/lib/api";
import { responseError } from "@/lib/refusals";

export type AudioToolBody =
  | { tool: "loop"; engine: Engine; audio: string; name?: string; duration: number; sourceDuration?: number; crossfade?: number; curve?: "equal-power" | "linear" }
  | { tool: "join"; engine: Engine; clips: { url: string; name?: string; duration?: number }[]; crossfade?: number; curve?: "equal-power" | "linear" }
  | { tool: "split"; engine: Engine; media: string; kind: "audio" | "video"; name?: string; quality?: "fast" | "best"; stereo?: boolean; channels?: number; sourceDuration?: number }
  | { tool: "remux"; engine: Engine; video: string; audio: string; name?: string }
  | {
      tool: "remove-dialogue";
      engine: Engine;
      video: string;
      name?: string;
      outcome?: "no-dialogue" | "dialogue-only" | "lower-music";
      musicDb?: number;
      quality?: "fast" | "best";
      channels?: number;
      sourceDuration?: number;
    }
  | {
      tool: "clean-dialogue";
      engine: Engine;
      media: string;
      kind: "audio" | "video";
      name?: string;
      bed?: "off" | number;
      quality?: "fast" | "best";
      stereo?: boolean;
      cleaner?: "veed" | "deepfilternet" | "isolation";
      strength?: number;
      remux?: boolean;
      channels?: number;
      sourceDuration?: number;
    }
  | {
      tool: "speech-edit";
      engine: Engine;
      media: string;
      kind: "audio" | "video";
      name?: string;
      cues: { start: number; end: number; text: string }[];
      edited?: string[];
      range?: { start: number; end: number };
      effect?: SpeechEffect;
      quality?: "fast" | "best";
      sourceDuration?: number;
    }
  | {
      tool: "clean";
      engine: Engine;
      media: string;
      kind: "audio" | "video";
      name?: string;
      model?: "voice" | "laughter";
      quality?: "auto" | "full" | "fast";
      strength?: "full" | "natural" | "light";
      background?: "remove" | "keep";
      level?: "match" | "voice";
      remux?: boolean;
      stereo?: boolean;
      channels?: number;
      sourceDuration?: number;
    };

async function post<T>(url: string, body: AudioToolBody): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw responseError(res, j.error ?? "Something went wrong. Please try again.");
  return j;
}

/** The value once it has stopped changing for `ms` (sliders and typing don't price every step). */
export function useSettled<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** What the settings would do and cost (null: nothing to price yet). */
export function useAudioToolPreview(body: AudioToolBody | null) {
  return useQuery({
    queryKey: ["audio-tool-preview", body],
    enabled: !!body,
    queryFn: () => post<AudioToolPreview>("/api/audio-tools?preview=1", body!),
    retry: false,
    staleTime: 30_000,
  });
}

export function useAudioToolRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AudioToolBody) => post<{ batchId: string; result: Generation; items: Generation[] }>("/api/audio-tools", body),
    onSuccess: () => {
      // The tab that runs this person's jobs on the ComfyUI on this computer (an account's "Your GPU") asks at once.
      window.dispatchEvent(new Event(COMPUTER_KICK_EVENT));
      void qc.invalidateQueries({ queryKey: ["generations"] });
    },
  });
}
