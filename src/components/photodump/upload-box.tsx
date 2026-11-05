"use client";

import { ImagePlus, Loader2, X } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { fileToSlot, type SlotValue } from "@/components/studio/media-slot";
import { useAskBeforeUpload } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * One big image drop zone (a selfie, an outfit): click, drop or paste; shows the photo once added
 * with a remove button. Files over `maxMb` are refused with a toast. A guest is asked to sign up first, and an account
 * with neither its own GPU nor its own key to connect one, before a file is chosen.
 */
export function UploadBox({
  value,
  onChange,
  title,
  hint,
  maxMb = 20,
  className,
}: {
  value: SlotValue | null;
  onChange: (v: SlotValue | null) => void;
  title: string;
  hint?: string;
  maxMb?: number;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const askFirst = useAskBeforeUpload();
  const take = (f: File | undefined) => {
    if (!f || askFirst()) return;
    if (!/^image\/(png|jpe?g|webp)$/.test(f.type)) return toast("PNG, JPG or WebP only");
    if (f.size > maxMb * 1024 * 1024) return toast(`That photo is over ${maxMb} MB — try a smaller one`);
    void fileToSlot(f, onChange, "image");
  };
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        take(e.dataTransfer.files[0]);
      }}
      onPaste={(e) => take([...e.clipboardData.files][0])}
      className={cn("relative overflow-hidden rounded-2xl border border-dashed bg-background transition-colors", over && "border-primary bg-brand-faint", className)}
    >
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => (take(e.target.files?.[0]), (e.target.value = ""))} />
      {value ? (
        <div className="relative size-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={value.preview} alt={title} className="size-full object-contain" />
          {value.uploading && (
            <span className="absolute inset-0 grid place-items-center bg-background/60" role="status" aria-label="Uploading">
              <Loader2 className="size-5 animate-spin" />
            </span>
          )}
          <button type="button" onClick={() => onChange(null)} aria-label={`Remove ${title.toLowerCase()}`} className="absolute top-2 right-2 grid size-7 place-items-center rounded-full bg-foreground/80 text-background">
            <X className="size-4" />
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => askFirst() || input.current?.click()} className="flex size-full flex-col items-center justify-center gap-2 p-6 text-center outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
          <span className="grid size-11 place-items-center rounded-2xl bg-brand-faint text-brand-text">
            <ImagePlus className="size-5" />
          </span>
          <span className="text-[14px] font-medium">{title}</span>
          {hint && <span className="max-w-xs text-[12.5px] text-muted-foreground">{hint}</span>}
          <span className="text-[11.5px] text-muted-foreground">PNG, JPG or paste · up to {maxMb} MB</span>
        </button>
      )}
    </div>
  );
}
