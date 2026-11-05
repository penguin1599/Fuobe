"use client";

import { Loader2, Rotate3d } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { OwnSetupChip, useOwnSetupPress } from "@/components/own-setup";
import { useEngine, useGenerations, useModelAccess } from "@/lib/api";
import { IDOL_MODELS } from "@/lib/av/model3d";
import { forgetViewRun, IDOL_VIEWS_FEATURE, IDOL_VIEWS_NOTE, idolViewsOf, idolViewsRequest, rememberViewRun, viewRunFor } from "@/lib/av/idol-views";
import type { ViewSide } from "@/lib/av/model3d";
import { offered } from "@/lib/model-access";
import { toastError } from "@/lib/refusals";
import { cn } from "@/lib/utils";
import { priceLine, useCreate3d, useRunPreview } from "./hooks";
import { useModel3dSetup } from "./own-setups";

/**
 * Whether "Make the other sides" is offered here: Idol 3D's views run on your GPU only (Idol's cloud endpoint returns a
 * splat, not views), so not on an install that runs paid APIs only, and not with Idol 3D switched off in Settings →
 * Models & licences. A guest or an account sees it too: its run goes to its own GPU (OtherSides marks what it needs).
 */
export function useOtherSidesOffered(): boolean {
  const [, , engineMode] = useEngine();
  const access = useModelAccess();
  return engineMode !== "cloud" && offered(access, IDOL_MODELS.open, "open");
}

/**
 * The button that makes the other sides of the object in one picture (Idol 3D on your GPU: front, left, back, right) and
 * hands them over once they're ready. Said plainly beside it: they're renders of a 3D guess, so they can be soft.
 */
export function OtherSides({
  photo,
  asPhoto,
  label,
  onMade,
  onBusy,
  className,
}: {
  /** The picture of the front (an uploaded or library file). */
  photo: string;
  /** The picture is a photo (Idol's looser crop); a picture made here isn't. */
  asPhoto: boolean;
  label: string;
  onMade: (views: Partial<Record<ViewSide, string>>) => void;
  /** Told while a run is going (the page keeps the button there until its views are in). */
  onBusy?: (busy: boolean) => void;
  className?: string;
}) {
  // The owner's as a studio run; an account's on its own GPU (POST /api/image-to-3d). A guest gets the sign-up card and
  // an account without a GPU "Connect your GPU" first; the label shows until the views' graph is validated here.
  const create = useCreate3d();
  const setup = useModel3dSetup("sides");
  const press = useOwnSetupPress();
  // The run for this picture lives for the tab (viewRunFor), so it's picked up again if the button comes back mid-run,
  // and a different front never gets another picture's views.
  const [, setTick] = useState(0);
  const runId = viewRunFor(photo) ?? null;
  const list = useGenerations({ features: [IDOL_VIEWS_FEATURE], limit: 20 });
  const run = runId ? list.data?.find((g) => g.id === runId) : undefined;
  const preview = useRunPreview(idolViewsRequest(photo, { asPhoto }));
  const price = priceLine(preview.data);
  // Hand the views over once per run.
  const handed = useRef<string | null>(null);
  const made = useRef(onMade);
  useEffect(() => {
    made.current = onMade;
  }, [onMade]);
  useEffect(() => {
    if (!run || run.status !== "succeeded" || handed.current === run.id) return;
    handed.current = run.id;
    made.current(idolViewsOf(run.outputs));
    forgetViewRun(photo, run.id);
    setTick((t) => t + 1);
  }, [run, photo]);
  const failed = run && (run.status === "failed" || run.status === "canceled") ? run : undefined;
  const working = create.isPending || (!!runId && !failed);
  useEffect(() => onBusy?.(working), [onBusy, working]);
  useEffect(() => () => onBusy?.(false), [onBusy]);
  const start = () => void press(setup, make);
  const make = () =>
    create.mutate(idolViewsRequest(photo, { asPhoto }), {
      onSuccess: (items) => {
        if (items[0]?.id) rememberViewRun(photo, items[0].id);
        setTick((t) => t + 1);
      },
      onError: (e) => toastError(e),
    });
  return (
    <div className={cn("space-y-1.5", className)} data-testid="other-sides">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Button type="button" variant="outline" size="sm" className="h-auto min-h-8 rounded-full py-1.5 text-left whitespace-normal" onClick={start} disabled={working}>
          {working ? <Loader2 className="animate-spin" /> : <Rotate3d />}
          {working ? "Making the other sides…" : label}
        </Button>
        <OwnSetupChip setup={setup} />
      </div>
      <p className="text-[12px] text-muted-foreground" aria-live="polite">
        {failed ? (
          <span className="text-destructive">{failed.error ?? "The sides couldn't be made. Please try again."}</span>
        ) : (
          <>
            {price ? `${price} · ` : ""}
            {IDOL_VIEWS_NOTE}
          </>
        )}
      </p>
    </div>
  );
}
