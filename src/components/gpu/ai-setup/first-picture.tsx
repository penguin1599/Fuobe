"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { firstPictureRequest, keepCreatingHref, type FirstModel } from "@/lib/ai-setup/first-picture";
import { useCreateGeneration } from "@/lib/api";
import type { Generation } from "@/lib/catalog/types";
import { isOutOfMemoryText } from "@/lib/diagnose";

/**
 * "Make your first picture": one small picture on the person's own GPU, followed every second until it is there, and
 * the finish that shows it. The run is an ordinary Image studio run of the account's (its limits, its Library).
 */

export interface FirstPicture {
  state: "none" | "running" | "ok" | "failed" | "no-model";
  model?: FirstModel;
  secs?: number;
  url?: string;
  cause?: "out-of-memory" | "unknown";
  error?: string;
}

const DONE = new Set(["succeeded", "failed", "canceled"]);
const MAX_WAIT_MS = 20 * 60_000;

export function useFirstPicture() {
  const create = useCreateGeneration();
  const [p, setP] = useState<FirstPicture>({ state: "none" });
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const start = useCallback(
    async (model: FirstModel) => {
      setP({ state: "running", model });
      const t0 = Date.now();
      try {
        const [first] = await create.mutateAsync(firstPictureRequest(model));
        if (!first) throw new Error("The run didn't start. Try again.");
        let g: Generation = first;
        while (alive.current && !DONE.has(g.status) && Date.now() - t0 < MAX_WAIT_MS) {
          await new Promise((r) => setTimeout(r, 1000));
          const res = await fetch(`/api/generations/${encodeURIComponent(first.id)}`, { cache: "no-store" }).catch(() => null);
          if (res?.ok) g = (await res.json()) as Generation;
        }
        if (!alive.current) return;
        const secs = Math.max(1, Math.round(((g.completedAt ?? Date.now()) - (g.createdAt || t0)) / 1000));
        if (g.status === "succeeded" && g.outputs[0]?.url) setP({ state: "ok", model, secs, url: g.outputs[0].url });
        else setP({ state: "failed", model, cause: g.error && isOutOfMemoryText(g.error) ? "out-of-memory" : "unknown", error: g.error ?? "The picture didn't finish." });
      } catch (e) {
        if (!alive.current) return;
        // Stopped by the GPU check: a model or a node is missing (the guided fix opens by itself).
        if ((e as { gpuSetup?: boolean }).gpuSetup) setP({ state: "no-model", model });
        else setP({ state: "failed", model, cause: "unknown", error: (e as Error).message });
      }
    },
    [create],
  );
  return { ...p, start };
}

/**
 * The finish: the picture made on the person's own GPU, in a frame whose shape is set before it loads, and the way on.
 * It replaces the checklist in the same place (the container keeps its height).
 */
export function FinishCard({ picture, gpu, cpu, onClose }: { picture: FirstPicture; gpu?: string; cpu?: boolean; onClose: () => void }) {
  const router = useRouter();
  const heading = useRef<HTMLHeadingElement>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => heading.current?.focus(), []);
  const on = cpu ? "your computer's processor" : gpu ? `your ${gpu}` : "your GPU";
  return (
    <div className="grid items-center gap-5 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
      <div className="mx-auto aspect-[4/5] w-full max-w-[13rem] overflow-hidden rounded-xl bg-muted max-sm:max-h-[50svh] max-sm:max-w-none">
        {picture.url && (
          // eslint-disable-next-line @next/next/no-img-element -- the run's own file, any size
          <img
            src={picture.url}
            alt="Your first picture: a model in an ivory wool coat, in soft window light"
            onLoad={() => setLoaded(true)}
            className={`size-full object-cover transition-opacity duration-500 motion-reduce:transition-none ${loaded ? "opacity-100" : "opacity-0"}`}
          />
        )}
      </div>
      <div className="space-y-3">
        <div className="grid size-10 animate-in place-items-center rounded-full bg-primary text-primary-foreground duration-300 zoom-in-50 fade-in-0 motion-reduce:animate-none">
          <Check className="size-5" />
        </div>
        <div className="space-y-1">
          <h3 ref={heading} tabIndex={-1} className="text-[17px] font-semibold outline-none">
            {cpu ? "Your ComfyUI is ready" : "Your GPU is ready"}
          </h3>
          <p className="text-[13px] text-muted-foreground">
            Made on {on} in {picture.secs} s. Every studio can use it now.
            {cpu ? " Pictures take minutes on a processor. A graphics card, or your own fal.ai or Replicate key, makes them in seconds." : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {picture.model && (
            <Button className="h-11 sm:h-9" onClick={() => router.push(keepCreatingHref(picture.model!))}>
              Keep creating
            </Button>
          )}
          <Button variant="ghost" className="h-11 sm:h-9" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
