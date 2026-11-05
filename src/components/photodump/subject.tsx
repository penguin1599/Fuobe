"use client";

import { Check, Loader2, Plus, UserRound, X } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { fileToList, type SlotValue } from "@/components/studio/media-slot";
import { useAskFirst } from "./ask-first";
import type { StudioElement } from "@/lib/catalog/elements";
import { SOUL_ID_COPY, SOUL_ID_PHOTOS } from "@/lib/catalog/training";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/refusals";
import { usePhotoCharacters, useSaveCharacter } from "./hooks";

/** What a character brings: a trained Soul ID (Fuobe Soul), an old Higgsfield one to retrain, or just photos. */
export function identityLabel(el: StudioElement): string {
  if (el.loras.some((l) => !l.referenceId && !l.demo)) return "Soul ID";
  if (el.loras.some((l) => l.referenceId)) return "Retrain Soul ID";
  return `${el.references.length} photo${el.references.length === 1 ? "" : "s"}`;
}

/** The character-creation copy (src/lib/catalog/training.ts SOUL_ID_COPY, Higgsfield's rules): saving is the consent. */
const CREATE_COPY = {
  ...SOUL_ID_COPY,
  // The line starts with "I consent", which stays a capital I mid-sentence.
  consent: `By clicking Save character, ${SOUL_ID_COPY.consent}`,
} as const;

const MAX_PHOTOS = SOUL_ID_PHOTOS.max;

/** Create a character from photos of one person, without leaving the page. */
export function QuickCharacter({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (el: StudioElement) => void }) {
  const [name, setName] = useState("");
  const [photos, setPhotos] = useState<SlotValue[]>([]);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const save = useSaveCharacter();
  const busy = photos.some((p) => p.uploading);
  const addFiles = (files: Iterable<File>) => [...files].filter((f) => /^image\/(png|jpe?g|webp)$/.test(f.type)).slice(0, MAX_PHOTOS - photos.length).forEach((f) => fileToList(f, setPhotos, "image"));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[92svh] overflow-y-auto sm:max-w-md"
        onPaste={(e) => addFiles(e.clipboardData.files)}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <DialogHeader>
          <DialogTitle>New character</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{CREATE_COPY.moreTitle}</span> · {CREATE_COPY.more}: different angles, at least one full-body.
          </DialogDescription>
        </DialogHeader>
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-[12.5px]">
          <span className="font-medium">{CREATE_COPY.avoidTitle}</span> · {CREATE_COPY.avoid}
        </p>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. “Maya”" maxLength={60} aria-label="Character name" />
        <div className={cn("grid grid-cols-4 gap-1.5 rounded-lg transition-colors", over && "bg-brand-faint")}>
          {photos.map((p, i) => (
            <div key={p.id ?? i} className="relative aspect-square overflow-hidden rounded-md bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.preview} alt="" className="size-full object-cover" />
              {p.uploading && (
                <span className="absolute inset-0 grid place-items-center bg-background/60">
                  <Loader2 className="size-4 animate-spin" />
                </span>
              )}
              <button type="button" aria-label={`Remove photo ${i + 1}`} onClick={() => setPhotos((xs) => xs.filter((x) => x !== p))} className="absolute top-0.5 right-0.5 grid size-5 place-items-center rounded-full bg-foreground/80 text-background">
                <X className="size-3" />
              </button>
            </div>
          ))}
          {photos.length < MAX_PHOTOS && (
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              aria-label="Add photos"
              className="grid aspect-square place-items-center rounded-md border border-dashed text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus className="size-4" />
            </button>
          )}
        </div>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => (addFiles(e.target.files ?? []), (e.target.value = ""))} />
        <p className="text-[11.5px] text-muted-foreground tabular-nums">
          {photos.length}/{MAX_PHOTOS} photos · PNG, JPG, WebP or paste
        </p>
        <p className="text-[12px] text-muted-foreground">
          Or <Link href="/character-sheet" className="text-brand-text underline underline-offset-2">build one with Character Sheet</Link>, then pick it here.
        </p>
        <p className="text-[11.5px] leading-snug text-muted-foreground">{CREATE_COPY.consent}</p>
        <DialogFooter>
          <Button
            disabled={!name.trim() || !photos.length || busy || save.isPending}
            onClick={() =>
              save.save(
                { name: name.trim(), references: photos.map((p) => p.ref).filter(Boolean) },
                {
                  onSuccess: (el) => {
                    // The owner's character is an element (@handle); an account's is its own, by name.
                    toast.success(save.owner ? `Saved as @${el.handle}` : `Saved ${el.name}`);
                    onCreated(el);
                    setName("");
                    setPhotos([]);
                    onOpenChange(false);
                  },
                  onError: (e) => toastError(e),
                },
              )
            }
          >
            {(busy || save.isPending) && <Loader2 className="animate-spin" />} Save character
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Your characters as cards (photo, name, what identity they carry), plus "New character". */
export function CharacterPicker({ value, onChange }: { value?: string; onChange: (id: string) => void }) {
  // The owner's characters are its elements; an account's are its own (saved here or from a Character Sheet).
  const { data, isLoading } = usePhotoCharacters();
  const [creating, setCreating] = useState(false);
  // A guest is asked to sign up first, and an account with neither its own GPU nor its own key to connect one.
  const askFirst = useAskFirst();
  const characters = (data ?? []).filter((e) => e.kind === "character");
  return (
    <>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        <button
          type="button"
          onClick={() => askFirst(() => setCreating(true))}
          className="flex aspect-[3/4] flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-5" /> New character
        </button>
        {isLoading
          ? Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="aspect-[3/4] rounded-xl" />)
          : characters.map((el) => {
              const sel = value === el.id;
              return (
                <button
                  key={el.id}
                  type="button"
                  aria-pressed={sel}
                  onClick={() => onChange(el.id)}
                  className={cn("group relative min-w-0 overflow-hidden rounded-xl bg-muted text-left outline-none focus-visible:ring-2 focus-visible:ring-ring", sel && "ring-3 ring-primary")}
                >
                  <span className="block aspect-[3/4]">
                    {el.references[0] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={el.references[0]} alt="" loading="lazy" className="size-full object-cover" />
                    ) : (
                      <span className="grid size-full place-items-center text-muted-foreground">
                        <UserRound className="size-6" />
                      </span>
                    )}
                  </span>
                  <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 pt-6 pb-1.5 text-white">
                    <span className="block truncate text-[12.5px] font-medium">{el.name}</span>
                    <span className="text-[11px] opacity-85">{identityLabel(el)}</span>
                  </span>
                  {sel && (
                    <span className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-full bg-primary text-primary-foreground">
                      <Check className="size-3" />
                    </span>
                  )}
                </button>
              );
            })}
      </div>
      <QuickCharacter open={creating} onOpenChange={setCreating} onCreated={(el) => onChange(el.id)} />
    </>
  );
}
