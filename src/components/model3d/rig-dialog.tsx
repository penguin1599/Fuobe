"use client";

import { Loader2, PersonStanding } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { OwnSetupNote } from "@/components/own-setup";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ANIMATION_LIBRARY_URL, ANIMATION_MAX, ANIMATION_PRESETS, animationId, MODEL3D_KEY, rigRequest } from "@/lib/av/model3d";
import { toastError } from "@/lib/refusals";
import { priceLine, useCreate3d, useRunPreview } from "./hooks";

const NONE = "none";
const NUMBER = "number";

/**
 * Rig & animate a finished model: Meshy adds a skeleton and walk / run cycles; an animation preset makes the
 * animated GLB the card plays. Cloud only (fal.ai): UniRig, the open rigger, has no verified ComfyUI pack.
 */
export function RigDialog({
  glb,
  open,
  onOpenChange,
  cloudAllowed,
  keyInstead,
}: {
  glb: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  cloudAllowed: boolean;
  /** A visitor on open models only: it runs with its own fal.ai key, and says so (own-setup.ts). */
  keyInstead?: boolean;
}) {
  const create = useCreate3d();
  const [pick, setPick] = useState<string>("30");
  const [typed, setTyped] = useState("");
  const animation = pick === NONE ? null : pick === NUMBER ? animationId(typed) : Number(pick);
  const badNumber = pick === NUMBER && animation === null;
  const req = cloudAllowed && !badNumber ? rigRequest({ glb, animation }) : null;
  const preview = useRunPreview(open ? req : null);
  const price = priceLine(preview.data);
  const go = () => {
    if (!req) return;
    create.mutate(req, {
      onSuccess: () => {
        toast.success(animation === null ? "Rigging your character" : "Rigging and animating your character");
        onOpenChange(false);
      },
      onError: (e) => toastError(e),
    });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rig &amp; animate</DialogTitle>
          <DialogDescription>
            For characters standing upright with two arms and two legs. Meshy adds a skeleton and walk and run cycles ($0.20); pick an animation to make it move
            ($0.12 more).
          </DialogDescription>
        </DialogHeader>
        {!cloudAllowed ? (
          keyInstead ? (
            <OwnSetupNote setup={MODEL3D_KEY} onOpen={() => onOpenChange(false)}>
              Rigging runs on Meshy, a cloud model, with your own fal.ai key. You pay fal.ai directly.
            </OwnSetupNote>
          ) : (
            <p className="rounded-xl bg-muted p-3 text-[13px] text-muted-foreground" role="note">
              Rigging runs on Meshy, a cloud model: turn on paid models in Settings → Engine mode.
            </p>
          )
        ) : (
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="rig-animation">Animation</Label>
              <Select value={pick} onValueChange={setPick}>
                <SelectTrigger id="rig-animation" className="h-9 w-full rounded-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  <SelectItem value={NONE}>None — just the skeleton, walk and run</SelectItem>
                  {ANIMATION_PRESETS.map((g) => (
                    <SelectGroup key={g.group}>
                      <SelectSeparator />
                      <SelectLabel>{g.group}</SelectLabel>
                      {g.items.map((p) => (
                        <SelectItem key={p.id} value={String(p.id)}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                  <SelectSeparator />
                  <SelectItem value={NUMBER}>Another, by its number…</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {pick === NUMBER && (
              <div className="grid gap-1.5">
                <Label htmlFor="rig-number">Preset number (0–{ANIMATION_MAX})</Label>
                <Input
                  id="rig-number"
                  inputMode="numeric"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value.replace(/[^\d]/g, "").slice(0, 3))}
                  aria-invalid={!!typed && badNumber}
                  aria-describedby="rig-number-hint"
                  className="h-9 rounded-full"
                  placeholder="e.g. 92"
                />
                <p id="rig-number-hint" className="text-[12px] text-muted-foreground">
                  Find one in{" "}
                  <a href={ANIMATION_LIBRARY_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                    Meshy&apos;s animation library
                  </a>{" "}
                  (656 presets).
                </p>
              </div>
            )}
            <p className="text-[12px] text-muted-foreground" aria-live="polite">
              {preview.isError ? (preview.error as Error).message : (price ?? "Working out the price…")} · Runs on Meshy in the cloud, on either engine.
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" className="rounded-full" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="rounded-full" onClick={go} disabled={!req || create.isPending}>
            {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <PersonStanding className="size-4" />} {animation === null ? "Rig it" : "Rig and animate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
