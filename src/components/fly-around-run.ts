"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CameraKey } from "@/lib/camera-path";
import type { ExactOrbit } from "@/lib/exact-orbit";
import type { Engine, Generation } from "@/lib/catalog/types";
import { COMPUTER_KICK_EVENT } from "@/lib/api";
import { formatCost } from "@/lib/format";
import { responseError, toastError } from "@/lib/refusals";

/** What /api/fly-around takes (src/server/fly-around.ts FlyAroundSchema). */
export interface FlyAroundBody {
  engine: Engine;
  image?: string;
  views?: string[];
  orbit?: ExactOrbit;
  preset?: string;
  keys?: CameraKey[];
  render?: string;
  prompt?: string;
  duration?: number;
  resolution?: string;
  feature?: string;
  title?: string;
}

/** What `?preview=1` answers (FlyAroundPreview). */
export interface FlyAroundPreview {
  engine: Engine;
  model: { id: string; name: string };
  label: string;
  duration: number;
  steps: number;
  notes: string[];
  blocker?: string;
  costUsd: number | null;
  demo: boolean;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const out = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw responseError(res, out.error ?? "Something went wrong. Please try again.");
  return out;
}

/** The price line: "Free · on your GPU" on the open engine, the list price in the cloud. */
export function flyPrice(p: FlyAroundPreview | undefined, compact = false): string {
  if (!p) return "";
  if (p.demo) return compact ? "Placeholder" : "Placeholder · free";
  if (p.engine === "open") return compact ? "Free" : "Free · on your GPU";
  return p.costUsd != null ? `≈ ${formatCost(p.costUsd)}` : "";
}

/** A fly-around's live price (enabled while `body` is set) and its run, which puts the new cards in the feeds. */
export function useFlyAround(body: FlyAroundBody | null) {
  const qc = useQueryClient();
  const preview = useQuery({
    queryKey: ["fly-around-preview", body],
    queryFn: () => post<FlyAroundPreview>("/api/fly-around?preview=1", body),
    enabled: !!body,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
  const run = useMutation({
    mutationFn: (b: FlyAroundBody) => post<{ items: Generation[]; final: Generation }>("/api/fly-around", b),
    onSuccess: () => {
      // The tab that runs this person's jobs on the ComfyUI on this computer (an account's "Your GPU") asks for them at once.
      window.dispatchEvent(new Event(COMPUTER_KICK_EVENT));
      void qc.invalidateQueries({ queryKey: ["generations"] });
      void qc.invalidateQueries({ queryKey: ["library-facets"] });
    },
    onError: (e) => toastError(e),
  });
  return { preview, run, price: flyPrice(preview.data), compactPrice: flyPrice(preview.data, true) };
}
