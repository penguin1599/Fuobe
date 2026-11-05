"use client";

import { Download, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { DEFAULT_HEIGHT_MM, MAX_HEIGHT_MM, MIN_HEIGHT_MM, PRINT_FORMATS, printExport, printHeight, type PrintFormat, type TriMesh, watertightCheck, watertightLine, weld } from "@/lib/print3d";
import { toastError } from "@/lib/refusals";
import { glbTriangles } from "./glb-triangles";

/**
 * Print-ready: the model as an STL or 3MF in millimetres, at the height the user sets (the model itself has no real
 * size: Hi3D's refine comes out at a standard size), with a watertight check before the download. All in the browser.
 */
export function PrintDialog({ glb, name, open, onOpenChange, refined }: { glb: string; name: string; open: boolean; onOpenChange: (v: boolean) => void; refined?: boolean }) {
  const [mesh, setMesh] = useState<{ url: string; tri: TriMesh; check: ReturnType<typeof watertightCheck> } | { url: string; error: string } | null>(null);
  const [height, setHeight] = useState(String(DEFAULT_HEIGHT_MM));
  const [format, setFormat] = useState<PrintFormat>("stl");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open || mesh?.url === glb) return;
    let live = true;
    glbTriangles(glb).then(
      (tri) => live && setMesh({ url: glb, tri, check: watertightCheck(weld(tri)) }),
      () => live && setMesh({ url: glb, error: "Couldn't read this model. Download the .glb and convert it in your slicer." }),
    );
    return () => {
      live = false;
    };
  }, [open, glb, mesh?.url]);
  const ready = mesh && mesh.url === glb && "tri" in mesh ? mesh : null;
  const failed = mesh && mesh.url === glb && "error" in mesh ? mesh.error : null;
  const typed = Number(height);
  const badHeight = !height.trim() || !Number.isFinite(typed) || typed < MIN_HEIGHT_MM || typed > MAX_HEIGHT_MM;
  const save = () => {
    if (!ready || badHeight) return;
    setBusy(true);
    try {
      const out = printExport(ready.tri, { heightMm: printHeight(typed), format, name });
      const url = URL.createObjectURL(new Blob([out.data.slice().buffer], { type: out.mime }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${name} ${Math.round(out.sizeMm[2])}mm.${out.ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      onOpenChange(false);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Print-ready</DialogTitle>
          <DialogDescription>
            {refined ? "The refined model comes out at a standard size, not its real one" : "A 3D model has no real size of its own"}: set how tall the print should be. It stands on the bed, Z up, in millimetres.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="print-height">Height (mm)</Label>
            <Input
              id="print-height"
              inputMode="decimal"
              value={height}
              onChange={(e) => setHeight(e.target.value.replace(/[^\d.]/g, "").slice(0, 7))}
              aria-invalid={badHeight}
              aria-describedby="print-height-hint"
              className="h-9 rounded-full"
            />
            <p id="print-height-hint" className="text-[12px] text-muted-foreground">
              {MIN_HEIGHT_MM} mm to {MAX_HEIGHT_MM / 1000} m; the width and depth follow the model&apos;s shape.
            </p>
          </div>
          <div className="grid gap-1.5">
            <span className="text-sm font-medium" id="print-format">
              Format
            </span>
            <ToggleGroup type="single" variant="outline" value={format} onValueChange={(v) => v && setFormat(v as PrintFormat)} aria-labelledby="print-format" className="w-full">
              {PRINT_FORMATS.map((f) => (
                <ToggleGroupItem key={f.id} value={f.id} className="flex-1" aria-label={`${f.label}: ${f.hint}`}>
                  {f.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <p className="text-[12px] text-muted-foreground">{PRINT_FORMATS.find((f) => f.id === format)?.hint}. Shape only: colours and textures stay in the .glb.</p>
          </div>
          <p className="rounded-xl bg-muted p-3 text-[13px]" role="status" aria-live="polite">
            {failed ?? (ready ? watertightLine(ready.check) : "Checking the model…")}
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" className="rounded-full" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="rounded-full" onClick={save} disabled={!ready || badHeight || busy}>
            {!ready && !failed ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} Download .{format}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
