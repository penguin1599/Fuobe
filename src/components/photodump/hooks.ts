"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { COMPUTER_KICK_EVENT, useElements, useSaveElement, useViewer } from "@/lib/api";
import type { StudioElement } from "@/lib/catalog/elements";
import type { Generation } from "@/lib/catalog/types";
import { responseError } from "@/lib/refusals";

/**
 * A run started: the tab that runs this person's jobs on the ComfyUI on this computer (an account's "Your GPU") asks for
 * them at once, as after a studio run.
 */
const kick = () => window.dispatchEvent(new Event(COMPUTER_KICK_EVENT));

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw responseError(res, body.error ?? "Something went wrong. Please try again.");
  return body;
}

const post = async <T,>(url: string, body: unknown) => json<T>(await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

export interface RunPreview {
  modelId?: string;
  modelName?: string;
  count?: number;
  costUsd?: number | null;
  demo?: boolean;
  /** The model keeps the input photo's shape (no aspect ratio setting: Qwen-Image-Edit, try-on). */
  fixedAspect?: boolean;
  notes: string[];
  error?: string;
}

export interface UserPack {
  id: string;
  name: string;
  refs: string[];
  createdAt: number;
}

/** What a run would make and cost, priced on the server (`body` null = nothing to price yet). */
export function useRunPreview(url: string, body: unknown | null) {
  return useQuery({
    queryKey: ["run-preview", url, body],
    queryFn: () => post<RunPreview>(`${url}?preview=1`, body),
    enabled: body !== null,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

/** Start a run; its generations appear in the feeds through the live stream. */
export function useRun<B>(url: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: B) => post<{ batchId?: string; items: Generation[]; notes?: string[] }>(url, body),
    onSuccess: () => {
      kick();
      void qc.invalidateQueries({ queryKey: ["generations"] });
      void qc.invalidateQueries({ queryKey: ["library"] });
    },
  });
}

/** Retry a failed photo inside its run (same batch); the failed one goes to the Trash. */
export function useRetryPhoto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post<{ items: Generation[] }>("/api/photodump/retry", { id }),
    onSuccess: () => {
      kick();
      void qc.invalidateQueries({ queryKey: ["generations"] });
      void qc.invalidateQueries({ queryKey: ["library"] });
    },
  });
}

export function useUserPacks() {
  return useQuery({ queryKey: ["photodump-packs"], queryFn: async () => (await json<{ packs: UserPack[] }>(await fetch("/api/photodump/packs"))).packs });
}

export function usePackActions() {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: ["photodump-packs"] });
  const create = useMutation({ mutationFn: (b: { name: string; refs: string[] }) => post<UserPack>("/api/photodump/packs", b), onSuccess: done });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/photodump/packs/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) await json(res);
    },
    onSuccess: done,
  });
  return { create, remove };
}

/** An account's own character (src/server/photodump.ts PhotoCharacter). */
interface PhotoCharacter {
  id: string;
  name: string;
  references: string[];
  createdAt: number;
}

/** An account's character in the shape the pickers read: no handle to @mention (that's the owner's elements), no Soul ID. */
const asElement = (c: PhotoCharacter): StudioElement => ({ id: c.id, name: c.name, handle: c.name, kind: "character", description: null, references: c.references, loras: [], status: "ready", createdAt: c.createdAt });

/** Whether characters here are the owner's elements (@mentions, Soul IDs) or the visitor's own photo characters. */
export function useOwnsElements(): boolean {
  return useViewer().data?.owner === true;
}

/**
 * The characters Photodump and Fashion Factory pick from: the owner's saved elements, or an account's own characters
 * (none for a guest).
 */
export function usePhotoCharacters(): { data?: StudioElement[]; isLoading: boolean } {
  const owner = useOwnsElements();
  const elements = useElements();
  const own = useQuery({
    queryKey: ["photo-characters"],
    queryFn: async () => (await json<{ items: PhotoCharacter[] }>(await fetch("/api/photodump/characters"))).items.map(asElement),
    enabled: !owner,
    staleTime: 10_000,
  });
  return owner ? { data: elements.data, isLoading: elements.isLoading } : { data: own.data, isLoading: own.isLoading };
}

/** Save a character: an element for the owner, the account's own character otherwise. */
export function useSaveCharacter() {
  const owner = useOwnsElements();
  const element = useSaveElement();
  const qc = useQueryClient();
  const own = useMutation({
    mutationFn: async (b: { name: string; references: string[] }) => asElement(await post<PhotoCharacter>("/api/photodump/characters", b)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["photo-characters"] }),
  });
  const save = (b: { name: string; references: string[] }, opts?: { onSuccess?: (el: StudioElement) => void; onError?: (e: Error) => void }) =>
    owner ? element.mutate({ ...b, kind: "character" }, opts) : own.mutate(b, opts);
  return { save, owner, isPending: element.isPending || own.isPending, data: owner ? element.data : own.data };
}
