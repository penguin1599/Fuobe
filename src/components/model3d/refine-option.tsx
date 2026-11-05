"use client";

import { Loader2, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { OwnSetupChip } from "@/components/own-setup";
import {
  HI3D_CLOUD_NOTE,
  HI3D_DEFAULT,
  HI3D_GEOMETRY_NOTE,
  HI3D_HARDWARE,
  HI3D_LABEL,
  HI3D_NOTICE,
  HI3D_RESOLUTIONS,
  HI3D_URL,
  refineRequest,
  type Hi3dResolution,
} from "@/lib/av/hi3d";
import type { Engine } from "@/lib/catalog/types";
import { toastError } from "@/lib/refusals";
import { priceLine, useCreate3d, useRunPreview } from "./hooks";
import { useModel3dSetup } from "./own-setups";

/** "Powered by Hi3D 1.0", linked to Hi3D's site as its licence asks, wherever its results or its switch show. */
export function PoweredByHi3d({ className }: { className?: string }) {
  return (
    <a href={HI3D_URL} target="_blank" rel="noreferrer" className={className ?? "text-[11px] text-muted-foreground underline-offset-2 hover:underline"}>
      {HI3D_NOTICE}
    </a>
  );
}

function Resolutions({ value, onChange, id }: { value: Hi3dResolution; onChange: (v: Hi3dResolution) => void; id: string }) {
  return (
    <div className="grid gap-1">
      <span id={id} className="text-[12px] font-medium">
        Detail
      </span>
      <ToggleGroup type="single" variant="outline" size="sm" value={String(value)} onValueChange={(v) => v && onChange(Number(v) as Hi3dResolution)} aria-labelledby={id} className="w-full">
        {HI3D_RESOLUTIONS.map((r) => (
          <ToggleGroupItem key={r.value} value={String(r.value)} className="flex-1" aria-label={`${r.label}: ${r.hint}`}>
            {r.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <p className="text-[12px] text-muted-foreground">{HI3D_RESOLUTIONS.find((r) => r.value === value)?.hint}</p>
    </div>
  );
}

/**
 * Image to 3D's "Refine detail · Hi3D 1.0": after the model is built, Hi3D sharpens its geometry from the same photo.
 * On your GPU only; the cloud engine says so (and offers the switch back when the install runs open models), and an
 * install on paid APIs only doesn't show it.
 */
export function RefineOption({
  engine,
  value,
  onChange,
  openAllowed,
  onUseGpu,
}: {
  engine: Engine;
  value: Hi3dResolution | null;
  onChange: (v: Hi3dResolution | null) => void;
  openAllowed: boolean;
  onUseGpu: () => void;
}) {
  const [last, setLast] = useState<Hi3dResolution>(value ?? HI3D_DEFAULT);
  // A visitor's refine runs on its own GPU: what that needs, until Hi3D's graph is validated on this studio's GPU.
  const setup = useModel3dSetup("refine");
  if (!openAllowed) return null;
  if (engine !== "open") {
    return (
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed p-2.5 text-[12px] text-muted-foreground">
        <span>{HI3D_CLOUD_NOTE}</span>
        <Button size="sm" variant="ghost" className="h-7 rounded-full px-2.5 text-[12px]" onClick={onUseGpu}>
          Use your GPU
        </Button>
      </div>
    );
  }
  const on = value !== null;
  return (
    <div className="mt-3 rounded-xl border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <Label htmlFor="m3d-refine" className="text-[13px]">
            {HI3D_LABEL}
          </Label>
          <OwnSetupChip setup={setup} />
        </span>
        <Switch id="m3d-refine" checked={on} onCheckedChange={(v) => onChange(v ? last : null)} aria-describedby="m3d-refine-hint" />
      </div>
      <p id="m3d-refine-hint" className="mt-1 text-[12px] text-muted-foreground">
        Sharper edges, engravings and fine relief. {HI3D_GEOMETRY_NOTE} You keep both models.
      </p>
      {on && (
        <div className="mt-2 grid gap-2">
          <Resolutions
            id="m3d-refine-res"
            value={value}
            onChange={(v) => {
              setLast(v);
              onChange(v);
            }}
          />
          <p className="text-[11px] text-muted-foreground">{HI3D_HARDWARE}</p>
          <PoweredByHi3d />
        </div>
      )}
    </div>
  );
}

/** "Refine this mesh" on a finished model: Hi3D refines its geometry from the photo it was made from. */
export function RefineDialog({ glb, photo, open, onOpenChange, feature }: { glb: string; photo: string; open: boolean; onOpenChange: (v: boolean) => void; feature?: string }) {
  // The owner's as a studio run; an account's on its own GPU (POST /api/image-to-3d).
  const create = useCreate3d();
  const [resolution, setResolution] = useState<Hi3dResolution>(HI3D_DEFAULT);
  const req = refineRequest({ glb, photo, resolution, feature });
  const preview = useRunPreview(open ? req : null);
  const go = () =>
    create.mutate(req, {
      onSuccess: () => {
        toast.success("Refining the detail on your GPU");
        onOpenChange(false);
      },
      onError: (e) => toastError(e),
    });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Refine this mesh</DialogTitle>
          <DialogDescription>Hi3D 1.0 sharpens the model&apos;s geometry, guided by the photo it was made from. {HI3D_GEOMETRY_NOTE}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Resolutions id="refine-res" value={resolution} onChange={setResolution} />
          <p className="text-[12px] text-muted-foreground" aria-live="polite">
            {preview.isError ? (preview.error as Error).message : (priceLine(preview.data) ?? "Working out the price…")} · {HI3D_HARDWARE}
          </p>
          <PoweredByHi3d />
        </div>
        <DialogFooter>
          <Button variant="ghost" className="rounded-full" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="rounded-full" onClick={go} disabled={create.isPending}>
            {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Refine
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
