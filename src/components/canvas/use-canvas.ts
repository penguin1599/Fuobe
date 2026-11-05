"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useGenerationStream } from "@/lib/api";
import type { Canvas, CanvasGraph, CanvasPlan, CanvasSummary } from "@/lib/catalog/canvas";
import type { CanvasPage } from "@/lib/catalog/canvas-board";
import type { Engine, Generation } from "@/lib/catalog/types";
import type { TemplateModels } from "@/lib/canvas-sections";
import { responseError } from "@/lib/refusals";

/** Client hooks for /api/canvases (kept next to the canvas UI; the shapes live in src/lib/catalog/canvas.ts). */

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw Object.assign(responseError(res, body.error ?? "Something went wrong. Please try again."), { body, status: res.status });
  return body;
}

const send = (url: string, method: string, body?: unknown, init?: RequestInit) =>
  fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), ...init });

export interface CanvasView {
  canvas: Canvas;
  generations: Generation[];
}

const active = (g: Generation) => g.status === "queued" || g.status === "running";

/**
 * The model names of every Canvas template, per engine: the owner's only (the route answers no one else), asked for
 * once by the owner's model lines (ModelLine) and kept for the visit.
 */
export function useTemplateModels() {
  return useQuery({
    queryKey: ["canvas-template-models"],
    staleTime: Infinity,
    queryFn: async () => json<Record<string, TemplateModels>>(await fetch("/api/canvases/template-models")),
  });
}

/** The owner's canvases; `enabled: false` (a visitor, who has none) asks for nothing. */
export function useCanvases({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["canvases"],
    enabled,
    queryFn: async () => (await json<{ items: CanvasSummary[] }>(await fetch("/api/canvases"))).items,
  });
}

/**
 * One canvas with its nodes' generations. The app's shared live stream (src/lib/api.ts) patches
 * the generations as jobs move, are trashed or restored; polling is the fallback while something
 * renders (a slow safety net when the stream is connected).
 */
export function useCanvasView(id: string) {
  const live = useGenerationStream();
  return useQuery({
    queryKey: ["canvases", id],
    queryFn: async () => json<CanvasView>(await fetch(`/api/canvases/${id}`)),
    refetchInterval: (q) => (q.state.data?.generations.some(active) ? (live ? 6000 : 1500) : false),
    // The editor owns the graph once loaded; refetches only bring runs and generations.
    refetchOnWindowFocus: false,
  });
}

export function useCanvasActions() {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["canvases"], exact: true });
  return {
    create: async (body: { name?: string; templateId?: string; engine?: Engine; graph?: CanvasGraph }) => {
      const c = await json<Canvas>(await send("/api/canvases", "POST", body));
      refresh();
      return c;
    },
    rename: async (id: string, name: string) => {
      qc.setQueryData<CanvasSummary[]>(["canvases"], (old) => old?.map((c) => (c.id === id ? { ...c, name } : c)));
      await json<Canvas>(await send(`/api/canvases/${id}`, "PATCH", { name }));
      refresh();
    },
    duplicate: async (id: string) => {
      const c = await json<Canvas>(await send(`/api/canvases/${id}/duplicate`, "POST"));
      refresh();
      return c;
    },
    remove: async (id: string) => {
      qc.setQueryData<CanvasSummary[]>(["canvases"], (old) => old?.filter((c) => c.id !== id));
      const res = await fetch(`/api/canvases/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw responseError(res, "Couldn't delete it. Please try again.");
      qc.removeQueries({ queryKey: ["canvases", id] });
      refresh();
    },
  };
}

/** Save the pages (autosave) or the name. `keepalive` lets a save started while leaving the page finish. */
export async function saveCanvas(id: string, patch: { name?: string; pages?: CanvasPage[] }, keepalive = false): Promise<Canvas> {
  return json<Canvas>(await send(`/api/canvases/${id}`, "PATCH", patch, { keepalive }));
}

export interface RunResponse {
  canvas: Canvas;
  items: Generation[];
  ran: string[];
  reused: CanvasPlan["reused"];
  errors: CanvasPlan["errors"];
  costUsd: number;
}

export function useRunCanvas(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { page: string; targets?: string[]; group?: string; force?: boolean; pages: CanvasPage[] }) => {
      const res = await send(`/api/canvases/${id}/run`, "POST", body);
      const data = (await res.json().catch(() => ({}))) as Partial<RunResponse> & { error?: string };
      if (!res.ok && !data.errors) throw responseError(res, data.error ?? "Something went wrong. Please try again.");
      return { ...data, ok: res.ok } as RunResponse & { ok: boolean; error?: string };
    },
    onSuccess: (r) => {
      if (!r.canvas) return;
      qc.setQueryData<CanvasView>(["canvases", id], (old) => {
        const known = new Map((old?.generations ?? []).map((g) => [g.id, g]));
        for (const g of r.items ?? []) known.set(g.id, g);
        return { canvas: { ...(old?.canvas ?? r.canvas), runs: r.canvas.runs, updatedAt: r.canvas.updatedAt }, generations: [...known.values()] };
      });
      // New results appear in the library and feeds too.
      void qc.invalidateQueries({ queryKey: ["generations"] });
      void qc.invalidateQueries({ queryKey: ["canvases"], exact: true });
    },
  });
}

// ---------------------------------------------------------------------------
// An account's own canvases (/api/account/canvases): boards it keeps, never the owner's.

/** An account's board as the editor opens it. */
export interface AccountCanvas {
  id: string;
  name: string;
  pages: CanvasPage[];
  templateId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** The account's own canvases; `enabled: false` (a guest, or the owner) asks for nothing. */
export function useAccountCanvases({ enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: ["account-canvases"],
    enabled,
    queryFn: async () => (await json<{ items: CanvasSummary[] }>(await fetch("/api/account/canvases"))).items,
  });
}

export function useAccountCanvas(id: string, { enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: ["account-canvases", id],
    enabled,
    retry: false,
    // The editor owns the board once loaded.
    refetchOnWindowFocus: false,
    staleTime: Infinity,
    queryFn: async () => json<AccountCanvas>(await fetch(`/api/account/canvases/${encodeURIComponent(id)}`)),
  });
}

export const accountCanvasApi = {
  create: async (body: { name: string; templateId: string | null; pages: CanvasPage[] }) => json<AccountCanvas>(await send("/api/account/canvases", "POST", body)),
  save: async (id: string, patch: { name?: string; pages?: CanvasPage[] }, keepalive = false) =>
    json<{ id: string; name: string; updatedAt: number }>(await send(`/api/account/canvases/${encodeURIComponent(id)}`, "PATCH", patch, { keepalive })),
  remove: async (id: string) => {
    const res = await fetch(`/api/account/canvases/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw responseError(res, "Couldn't delete it. Please try again.");
  },
};
