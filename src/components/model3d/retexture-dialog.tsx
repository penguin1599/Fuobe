"use client";

import { ImagePlus, Loader2, Paintbrush, X } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { OwnSetupNote } from "@/components/own-setup";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { uploadFile } from "@/lib/api";
import { MODEL3D_KEY, RETEXTURE_MODELS, RETEXTURE_PROMPT_MAX, RETEXTURE_SIZES, retextureRequest, type RetextureModel } from "@/lib/av/model3d";
import { toastError } from "@/lib/refusals";
import { priceLine, useCreate3d, useRunPreview } from "./hooks";

const SIZE_LABEL: Record<(typeof RETEXTURE_SIZES)[number], string> = { "2k": "2K textures", "4k": "4K textures", "8k": "8K textures" };

/**
 * Retexture a finished model: Meshy paints new textures on the same mesh from words or a style picture (the picture wins when
 * both are given). Cloud only (fal.ai): no open retexturer runs in ComfyUI here.
 */
export function RetextureDialog({
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
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState<{ url: string; preview: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [model, setModel] = useState<RetextureModel>(RETEXTURE_MODELS[0].id);
  const [size, setSize] = useState<(typeof RETEXTURE_SIZES)[number]>("2k");
  const file = useRef<HTMLInputElement>(null);
  const ready = cloudAllowed && !uploading && (!!prompt.trim() || !!style);
  const req = ready ? retextureRequest({ glb, prompt, style: style?.url, model, size }) : null;
  const preview = useRunPreview(open ? req : null);
  const price = priceLine(preview.data);
  const pickStyle = async (f: File | undefined) => {
    if (!f) return;
    setUploading(true);
    try {
      const asset = await uploadFile(f);
      setStyle({ url: asset.url, preview: URL.createObjectURL(f) });
    } catch (e) {
      toastError(e);
    } finally {
      setUploading(false);
    }
  };
  const go = () => {
    if (!req) return;
    create.mutate(req, {
      onSuccess: () => {
        toast.success("Retexturing your model");
        onOpenChange(false);
      },
      onError: (e) => toastError(e),
    });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Retexture</DialogTitle>
          <DialogDescription>The same model with new textures: describe the look, or add a picture of the style. Realistic surface detail — shine, roughness and bumps — is included.</DialogDescription>
        </DialogHeader>
        {!cloudAllowed ? (
          keyInstead ? (
            <OwnSetupNote setup={MODEL3D_KEY} onOpen={() => onOpenChange(false)}>
              Retexturing runs on Meshy, a cloud model, with your own fal.ai key. You pay fal.ai directly.
            </OwnSetupNote>
          ) : (
            <p className="rounded-xl bg-muted p-3 text-[13px] text-muted-foreground" role="note">
              Retexturing runs on Meshy, a cloud model: turn on paid models in Settings → Engine mode.
            </p>
          )
        ) : (
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="retexture-prompt">The new look</Label>
              <Textarea
                id="retexture-prompt"
                value={prompt}
                maxLength={RETEXTURE_PROMPT_MAX}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="e.g. weathered bronze with green patina"
                className="min-h-20 rounded-xl"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {style ? (
                <span className="relative size-14 overflow-hidden rounded-xl border bg-muted">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={style.preview} alt="Style picture" className="size-full object-cover" />
                  <button
                    type="button"
                    onClick={() => setStyle(null)}
                    aria-label="Remove the style picture"
                    className="absolute top-0.5 right-0.5 grid size-5 place-items-center rounded-full bg-foreground/80 text-background"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ) : (
                <Button variant="outline" size="sm" className="rounded-full" onClick={() => file.current?.click()} disabled={uploading}>
                  {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <ImagePlus className="size-3.5" />} Style picture
                </Button>
              )}
              <input ref={file} type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => void pickStyle(e.target.files?.[0])} />
              <Select value={model} onValueChange={(v) => setModel(v as RetextureModel)}>
                <SelectTrigger size="sm" className="rounded-full" aria-label="Model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RETEXTURE_MODELS.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={size} onValueChange={(v) => setSize(v as (typeof RETEXTURE_SIZES)[number])}>
                <SelectTrigger size="sm" className="rounded-full" aria-label="Texture size">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RETEXTURE_SIZES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {SIZE_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-[12px] text-muted-foreground" aria-live="polite">
              {!prompt.trim() && !style
                ? "Describe the look or add a style picture"
                : preview.isError
                  ? (preview.error as Error).message
                  : (price ?? "Working out the price…")}{" "}
              · Runs on Meshy in the cloud, on either engine.
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" className="rounded-full" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="rounded-full" onClick={go} disabled={!req || create.isPending}>
            {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Paintbrush className="size-4" />} Retexture
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
