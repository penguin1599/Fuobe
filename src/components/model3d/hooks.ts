"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { COMPUTER_KICK_EVENT, useCreateGeneration, useIsOwner } from "@/lib/api";
import type { Generation, GenerationRequest } from "@/lib/catalog/types";
import { responseError } from "@/lib/refusals";

/**
 * An account's Image to 3D run (a model, a splat, a rig, a retexture): POST /api/image-to-3d, which runs it on the
 * account's own GPU or key and finishes the model under its limits. Its cards show when the lists load again.
 */
function useAccountRun3d() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (req: GenerationRequest): Promise<Generation[]> => {
      const res = await fetch("/api/image-to-3d", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) });
      const body = (await res.json().catch(() => ({}))) as { items?: Generation[]; notes?: string[]; gpuWarning?: string; error?: string; code?: unknown };
      // Stopped by the GPU pre-flight: the guided fix opens (watchGuestRefusals), so no error toast on top of it.
      if (res.status === 409 && res.headers.get("x-fuobe-gpu-setup") === "1") throw Object.assign(new Error(body.error ?? "This tool needs setting up on your GPU"), { gpuSetup: true });
      if (!res.ok) {
        const code = typeof body.code === "string" ? body.code : undefined;
        throw responseError(res, Object.assign(new Error(body.error ?? "Something went wrong. Please try again."), { status: res.status }, code && { code }));
      }
      if (body.notes?.length) toast.warning(body.notes.length > 1 ? "This run changes a few things" : "This run changes one thing", { description: body.notes.join(". ") });
      if (body.gpuWarning) toast.warning(body.gpuWarning);
      return body.items ?? [];
    },
    onSuccess: () => {
      // A run on the ComfyUI on this computer: the tab that runs it asks for it at once.
      window.dispatchEvent(new Event(COMPUTER_KICK_EVENT));
      void qc.invalidateQueries({ queryKey: ["generations"] });
      void qc.invalidateQueries({ queryKey: ["library-facets"] });
    },
  });
}

/**
 * Start an Image to 3D run: the owner's as a studio run (POST /api/generations); anyone else's through
 * POST /api/image-to-3d (a guest gets the sign-up card there).
 */
export function useCreate3d() {
  const owner = useIsOwner();
  const studio = useCreateGeneration();
  const account = useAccountRun3d();
  return owner ? studio : account;
}

/** What /api/generations?preview=1 says a request would run as (the parts the page shows). */
export interface RunPreview {
  costUsd: number | null;
  demo: boolean;
  providerId: string;
  modelName: string;
  engine: "cloud" | "open";
  notes?: string[];
}

/** The value once it has stopped changing for `ms` (typing doesn't price every key). */
function useSettled<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** The price and route of a request before it runs (null: nothing to price yet). */
export function useRunPreview(req: GenerationRequest | null) {
  const body = useSettled(req ? JSON.stringify(req) : null);
  return useQuery({
    queryKey: ["model3d-preview", body],
    enabled: !!body,
    retry: false,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await fetch("/api/generations?preview=1", { method: "POST", headers: { "Content-Type": "application/json" }, body: body! });
      const j = (await res.json().catch(() => ({}))) as RunPreview & { error?: string };
      if (!res.ok) throw responseError(res, j.error ?? "Something went wrong. Please try again.");
      return j;
    },
  });
}

/** "≈ $0.38", "Free on your GPU", "Placeholder · nothing is charged" (null: not known yet). */
export function priceLine(p: RunPreview | undefined): string | null {
  if (!p) return null;
  if (p.demo) return "Placeholder · nothing is charged";
  if (p.engine === "open" || p.costUsd === 0) return "Free";
  if (p.costUsd === null) return "Billed by your provider";
  const usd = p.costUsd < 0.01 ? "<$0.01" : `$${p.costUsd < 1 ? p.costUsd.toFixed(3).replace(/0$/, "") : p.costUsd.toFixed(2)}`;
  return `≈ ${usd}, paid to ${p.providerId === "replicate" ? "Replicate" : "fal.ai"}`;
}
