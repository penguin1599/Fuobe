"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { COMPUTER_KICK_EVENT, useGenerationEvents } from "@/lib/api";
import type { DubPrice, DubSessionView, OneShotModel, VoiceSplit } from "@/lib/av/dub";
import type { Cue } from "@/lib/cues";
import type { Engine, Generation } from "@/lib/catalog/types";
import { responseError } from "@/lib/refusals";

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw responseError(res, body.error ?? "Something went wrong. Please try again.");
  return body;
}

/**
 * A dub's steps started: the tab that runs this person's jobs on the ComfyUI on this computer (an account's "Your GPU")
 * asks for them at once, as after a studio run.
 */
const kick = () => window.dispatchEvent(new Event(COMPUTER_KICK_EVENT));

const active = (gs: Generation[]) => gs.some((g) => g.status === "queued" || g.status === "running");

/** Recent dubs; refreshed when one of their steps changes on the live stream. */
export function useDubSessions() {
  const qc = useQueryClient();
  const connected = useGenerationEvents((ev) => {
    if (ev.type === "generation" && ev.generation.feature === "dub") void qc.invalidateQueries({ queryKey: ["dub"] });
  });
  return useQuery({
    queryKey: ["dub"],
    queryFn: async () => (await json<{ items: DubSessionView[] }>(await fetch("/api/dub"))).items,
    refetchInterval: (q) => (q.state.data?.some((s) => active(Object.values(s.generations))) ? (connected ? 8000 : 2000) : false),
  });
}

export interface NewDub {
  engine: Engine;
  mode: "oneshot" | "steps";
  video: string;
  title?: string;
  source?: string;
  targets: string[];
  model?: OneShotModel;
  /** The video's length as the browser measured it (seconds). */
  duration?: number;
  /** Open engine: the voice split (MelBand RoFormer or DBS). */
  voiceSplit?: VoiceSplit;
}

/** A value that settles `ms` after it last changed (so prices aren't asked for on every keystroke). */
function useSettled<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const post = async <T,>(url: string, body: unknown) => json<T>(await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

/** What starting this dub would cost (null body: nothing to price yet). */
export function useDubPrice(body: NewDub | null) {
  const key = useSettled(body ? JSON.stringify(body) : null);
  return useQuery({
    queryKey: ["dub-price", key],
    queryFn: () => post<DubPrice>("/api/dub?preview=1", JSON.parse(key!)),
    enabled: !!key,
    staleTime: 30_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

/** What voicing one language would cost with these lines. */
export function useVoicePrice(id: string, lang: string, lipsync: boolean, cues: Cue[], enabled: boolean) {
  const key = useSettled(enabled ? JSON.stringify({ lang, lipsync, cues }) : null, 800);
  return useQuery({
    queryKey: ["dub-voice-price", id, key],
    queryFn: () => post<DubPrice>(`/api/dub/${id}/voice?preview=1`, JSON.parse(key!)),
    enabled: !!key,
    staleTime: 30_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

export function useDubActions() {
  const qc = useQueryClient();
  const put = (s: DubSessionView) => qc.setQueryData<DubSessionView[]>(["dub"], (xs) => (xs ? [s, ...xs.filter((x) => x.id !== s.id)] : [s]));
  const create = useMutation({
    mutationFn: async (body: NewDub) => json<DubSessionView>(await fetch("/api/dub", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })),
    onSuccess: (s) => {
      kick();
      put(s);
      void qc.invalidateQueries({ queryKey: ["generations"] });
    },
  });
  const saveDraft = useMutation({
    mutationFn: async ({ id, lang, cues }: { id: string; lang: string; cues: Cue[] }) =>
      json<DubSessionView>(await fetch(`/api/dub/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lang, cues }) })),
    // The edit is in the cache at once: a review reopened before the server answers shows it (and doesn't save over it).
    onMutate: async ({ id, lang, cues }) => {
      await qc.cancelQueries({ queryKey: ["dub"] });
      qc.setQueryData<DubSessionView[]>(["dub"], (xs) => xs?.map((x) => (x.id === id ? { ...x, drafts: { ...x.drafts, [lang]: cues } } : x)));
    },
    onSuccess: put,
  });
  const voice = useMutation({
    mutationFn: async ({ id, lang, cues, lipsync }: { id: string; lang: string; cues?: Cue[]; lipsync?: boolean }) =>
      json<DubSessionView>(await fetch(`/api/dub/${id}/voice`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lang, cues, lipsync }) })),
    onSuccess: (s) => {
      kick();
      put(s);
      void qc.invalidateQueries({ queryKey: ["generations"] });
    },
  });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/dub/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw responseError(res, "Couldn't remove it");
      return id;
    },
    onSuccess: (id) => qc.setQueryData<DubSessionView[]>(["dub"], (xs) => xs?.filter((x) => x.id !== id)),
  });
  return { create, saveDraft, voice, remove };
}
