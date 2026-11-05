"use client";

import { ChevronLeft, ChevronRight, ExternalLink, ImagePlus, Layers, Library, Loader2, MonitorSmartphone, MoreHorizontal, Pencil, RotateCcw, Sun, Trash2, Type, Upload, Wand2, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { ExampleRow } from "@/components/studio/example-row";
import { LibraryGrid } from "@/components/studio/media-slot";
import { PageShell } from "@/components/page-shell";
import { SelfHostNote } from "@/components/self-host-note";
import { uploadFile, useHydrated, useIsOwner, useLikelyVisitor, useViewer } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import type { LayerProject } from "@/lib/layers";
import type { ExampleRowData } from "@/lib/examples/types";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/refusals";
import { loadImage, sizeOf } from "./render";
import { useLayerActions, useLayerProjects } from "./use-layers";

const CAPABILITIES = [
  { label: "Layer Decomposition", icon: Layers, text: "Split any flat image into clean, editable layers — subject, background and details." },
  { label: "Edit text", icon: Type, text: "Find the words on a poster and rewrite them in the original design." },
  { label: "Relight", icon: Sun, text: "Change the light on one layer or the whole picture." },
  { label: "Inpaint", icon: Wand2, text: "Draw a box, describe the change, and blend it back in." },
  { label: "Effects", icon: Sparkles, text: "Upscale, remove backgrounds, new angles and colour grades per layer." },
] as const;

const IMAGE_TYPES = "image/png,image/jpeg,image/webp";

/**
 * Upload or pick an image, read its size, create the project and open it. The page stays alive in
 * the background once you're in the editor (Next keeps recent pages in an <Activity>), so the
 * “Preparing your project” cover is lifted as the page hides: coming back finds it usable.
 */
function useOpenImage(onLeft?: () => void) {
  const router = useRouter();
  const { create } = useLayerActions();
  const [busy, setBusy] = useState<string | null>(null);
  // Set right before opening the editor; the page hiding then resets (not React's strict-mode re-mount).
  const leaving = useRef(false);
  const left = useRef(onLeft);
  useLayoutEffect(() => {
    left.current = onLeft;
  });
  useLayoutEffect(
    () => () => {
      if (!leaving.current) return;
      leaving.current = false;
      setBusy(null);
      left.current?.();
    },
    [],
  );
  const open = useCallback(
    async (source: string, opts: { name?: string; generationId?: string; label?: string } = {}) => {
      setBusy(opts.label ?? "Preparing your project");
      try {
        const img = await loadImage(source).catch(() => {
          throw new Error("This image cannot be decomposed — Layer decomposition needs a generated or uploaded image.");
        });
        const [width, height] = sizeOf(img);
        const v = await create({ source, width, height, name: opts.name, generationId: opts.generationId });
        leaving.current = true;
        router.replace(`/layers/${v.project.id}`);
      } catch (e) {
        toastError(e, "Couldn't open the editor for this image. Please try again.");
        setBusy(null);
      }
    },
    [create, router],
  );
  const openFile = useCallback(
    async (file: File) => {
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
        toast.error("Only images can be edited here. Pick an image or upload one.");
        return;
      }
      setBusy("Uploading…");
      try {
        const asset = await uploadFile(file);
        await open(asset.url, { name: file.name.replace(/\.[^.]+$/, "").slice(0, 80) });
      } catch (e) {
        toastError(e);
        setBusy(null);
      }
    },
    [open],
  );
  return { busy, open, openFile };
}

function ProjectCard({ p, onRename, onDelete }: { p: LayerProject; onRename: () => void; onDelete: () => void }) {
  return (
    <article className="group/card relative min-w-0">
      <Link href={`/layers/${p.id}`} aria-label={`Open project ${p.name}`} className="block rounded-xl outline-none focus-visible:ring-4 focus-visible:ring-brand-faint">
        <div className="checkerboard relative aspect-[4/3] overflow-hidden rounded-xl border transition-shadow group-hover/card:shadow-normal">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={p.coverUrl} alt="" loading="lazy" className="size-full object-contain" />
          {p.status !== "ready" && (
            <span
              className={cn(
                "absolute top-2 left-2 inline-flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium backdrop-blur",
                p.status === "processing" ? "bg-background/85 text-foreground" : p.status === "unopened" ? "bg-background/90 text-brand-text" : "bg-destructive/90 text-white",
              )}
            >
              {p.status === "processing" ? <Loader2 className="size-3 shrink-0 animate-spin" /> : p.status === "unopened" ? <Layers className="size-3 shrink-0" /> : null}
              <span className="truncate">{p.status === "processing" ? "Processing…" : p.status === "unopened" ? "Layers ready" : "Couldn't be processed"}</span>
            </span>
          )}
        </div>
        <h3 className="mt-2 truncate pr-9 text-[14px] font-medium">{p.name}</h3>
        <p className={cn("truncate pr-9 text-[12px]", p.status === "unopened" ? "text-brand-text" : "text-muted-foreground")}>
          {timeAgo(p.updatedAt)} · {p.status === "unopened" ? `${p.pendingLayers ? `${p.pendingLayers} layers` : "Layers"} ready — open to see them` : `${p.layers} layer${p.layers === 1 ? "" : "s"}`}
        </p>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="absolute right-0 bottom-5 grid size-8 place-items-center rounded-md text-muted-foreground opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100 sm:opacity-0 sm:group-hover/card:opacity-100"
            aria-label={`Actions for ${p.name}`}
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem asChild>
            <Link href={`/layers/${p.id}`}>
              <ExternalLink /> Open
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setTimeout(onRename)}>
            <Pencil /> Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setTimeout(onDelete)}>
            <Trash2 /> Delete project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </article>
  );
}

function Capabilities() {
  const [at, setAt] = useState(0);
  const c = CAPABILITIES[at];
  return (
    <div className="mt-6">
      <div className="flex items-center justify-center gap-1.5">
        <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Previous capability" onClick={() => setAt((at + CAPABILITIES.length - 1) % CAPABILITIES.length)}>
          <ChevronLeft />
        </Button>
        <div className="scrollbar-none flex min-w-0 gap-1.5 overflow-x-auto" role="group" aria-label="What Layers can do">
          {CAPABILITIES.map((x, i) => (
            <button
              key={x.label}
              type="button"
              aria-pressed={i === at}
              aria-controls="layers-capability"
              onClick={() => setAt(i)}
              className={cn(
                "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors",
                i === at ? "bg-brand-faint text-brand-text hover:bg-brand-faint-hover" : "bg-secondary text-secondary-foreground hover:bg-accent",
              )}
            >
              <x.icon className="size-3.5" /> {x.label}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Next capability" onClick={() => setAt((at + 1) % CAPABILITIES.length)}>
          <ChevronRight />
        </Button>
      </div>
      <p id="layers-capability" className="mt-2 text-center text-[13px] text-muted-foreground" aria-live="polite">
        {c.text}
      </p>
    </div>
  );
}

function ProjectsInner({ examples }: { examples?: ExampleRowData | null }) {
  const params = useSearchParams();
  const projects = useLayerProjects();
  const { rename, remove } = useLayerActions();
  const { bfcacheId } = useRouter();
  const started = useRef<string | null>(null);
  const { busy, open, openFile } = useOpenImage(() => {
    started.current = null;
  });
  const file = useRef<HTMLInputElement>(null);
  const hydrated = useHydrated();
  // A project is saved to the studio's library, which is its owner's: a guest or an account is told so up front, and
  // nothing is uploaded only to be refused, and no list of projects they can't make is shown. The empty list's Upload
  // shows once the owner is known (useIsOwner).
  const visitor = useLikelyVisitor();
  const isOwner = useIsOwner();
  const viewer = useViewer().data;
  const [picking, setPicking] = useState(false);
  const [renaming, setRenaming] = useState<LayerProject | null>(null);
  const [draft, setDraft] = useState("");
  const [deleting, setDeleting] = useState<LayerProject | null>(null);
  const [dragging, setDragging] = useState(false);

  // Deep link: /layers?image=<url>[&generation=<id>&name=…] opens that image as a project. Each
  // link opens once per visit (the guard holds the navigation and link it handled, and is
  // forgotten once the editor opens), so every “Open in Layers”, of the same image or another,
  // opens a new project, and React's strict-mode re-mount doesn't open a second one.
  const deep = params.get("image");
  const link = deep ? `${bfcacheId}|${params.toString()}` : null;
  useEffect(() => {
    // Once it's known who is looking: a guest's or an account's link opens nothing (the page says why).
    if (!deep || !link || started.current === link || !viewer) return;
    started.current = link;
    if (!viewer.owner) return;
    if (!deep.startsWith("/api/files/")) {
      toast.error("Only images from your library can be edited here. Pick an image or upload one.");
      return;
    }
    void open(deep, { generationId: params.get("generation") ?? undefined, name: params.get("name") ?? undefined });
  }, [deep, link, params, open, viewer]);

  const items = projects.data ?? [];

  return (
    <PageShell wide>
      <div
        className="relative"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            if (!visitor) setDragging(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (f && !visitor) void openFile(f);
        }}
      >
        <section className="mx-auto max-w-[820px] pt-[4vh] text-center">
          <span className="mx-auto grid size-11 place-items-center rounded-2xl bg-brand-faint text-brand-text">
            <Layers className="size-5" />
          </span>
          <h1 className="mt-4 font-heading text-display text-balance">
            Turn flat images
            <br className="hidden sm:block" /> into editable layers.
          </h1>
          <p className="mx-auto mt-2 max-w-[560px] text-body text-pretty text-muted-foreground">Separate, edit, and rebuild any image. Every element, now yours to edit.</p>
          <Capabilities />
          <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
            {/* Mounted after hydration: browsers may touch file inputs (caret colour) before React takes over. */}
            {hydrated && (
              <input
                ref={file}
                type="file"
                accept={IMAGE_TYPES}
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void openFile(f);
                }}
              />
            )}
            <Button size="lg" className="rounded-full px-5" onClick={() => file.current?.click()} disabled={!!busy || visitor}>
              {busy ? <Loader2 className="animate-spin" /> : <Upload />} Upload Media
            </Button>
            <Popover open={picking && !visitor} onOpenChange={setPicking}>
              <PopoverTrigger asChild>
                <Button size="lg" variant="secondary" className="rounded-full px-5" disabled={!!busy || visitor}>
                  <Library /> From your library
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[min(92vw,420px)] p-2" collisionPadding={12}>
                <p className="px-1 pb-2 text-[13px] font-medium">Pick an image you uploaded or generated</p>
                {picking && (
                  <LibraryGrid
                    kinds={["image"]}
                    onPick={(v) => {
                      setPicking(false);
                      void open(v.ref, { name: v.name });
                    }}
                  />
                )}
              </PopoverContent>
            </Popover>
          </div>
          {visitor ? (
            <SelfHostNote className="mx-auto mt-3 max-w-[560px]">Layers runs on your own Fuobe install.</SelfHostNote>
          ) : (
            <p className="mt-3 text-[12px] text-muted-foreground">Upload an image, or pick one you already generated. Images only — JPG, PNG or WebP.</p>
          )}
          <p className="mx-auto mt-4 flex max-w-md items-center justify-center gap-2 rounded-full bg-muted px-3 py-1.5 text-[12px] text-muted-foreground md:hidden">
            <MonitorSmartphone className="size-3.5 shrink-0" /> Layers works best on a larger screen — on a phone you can preview and download.
          </p>
        </section>

        {/* What it makes, while there are no projects of one's own to show (a guest or an account never has any). */}
        {examples && (visitor || (projects.isSuccess && !items.length)) && <ExampleRow row={examples} layout="column" maxWidth={820} className="mt-12" />}

        <section className={cn("mt-14", visitor && "hidden")} aria-labelledby="my-projects">
          <h2 id="my-projects" className="font-heading text-[24px]">
            My projects
          </h2>
          {projects.isLoading ? (
            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i}>
                  <Skeleton className="aspect-[4/3] rounded-xl" />
                  <Skeleton className="mt-2 h-4 w-2/3" />
                </div>
              ))}
            </div>
          ) : projects.isError ? (
            <Empty className="mt-4 border">
              <EmptyHeader>
                <EmptyTitle className="text-[22px]">We couldn&apos;t load your projects</EmptyTitle>
                <EmptyDescription>{(projects.error as Error).message}</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" className="rounded-full" onClick={() => void projects.refetch()}>
                  <RotateCcw /> Try loading projects again
                </Button>
              </EmptyContent>
            </Empty>
          ) : items.length ? (
            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {items.map((p) => (
                <ProjectCard
                  key={p.id}
                  p={p}
                  onRename={() => {
                    setDraft(p.name);
                    setRenaming(p);
                  }}
                  onDelete={() => setDeleting(p)}
                />
              ))}
            </div>
          ) : (
            <Empty className="mt-4 border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ImagePlus />
                </EmptyMedia>
                <EmptyTitle className="font-heading text-[22px]">Your edit projects will appear here</EmptyTitle>
                <EmptyDescription>Upload an image to separate it into editable layers — every project you start is saved here.</EmptyDescription>
              </EmptyHeader>
              {isOwner && (
                <EmptyContent>
                  <Button className="rounded-full" onClick={() => file.current?.click()} disabled={!!busy}>
                    <Upload /> Upload Media
                  </Button>
                </EmptyContent>
              )}
            </Empty>
          )}
        </section>

        {dragging && (
          <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-overlay/40 backdrop-blur-[2px]">
            <p className="rounded-2xl border bg-background px-6 py-4 text-[15px] font-medium shadow-heavy">Drop an image to open it in Layers</p>
          </div>
        )}
        {busy && (
          <div role="status" className="fixed inset-0 z-50 grid place-items-center bg-background/80 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-3 text-center">
              <Loader2 className="size-6 animate-spin text-brand-text" />
              <p className="font-heading text-[22px]">{busy}</p>
              <p className="text-[13px] text-muted-foreground">Your image opens as the first layer.</p>
            </div>
          </div>
        )}
      </div>

      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
            <DialogDescription className="sr-only">Give this project a new name</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const p = renaming!;
              const name = draft.trim();
              setRenaming(null);
              if (name && name !== p.name) void rename(p.id, name).then(() => toast.success("Renamed", { duration: 1500 }), (err) => toastError(err));
            }}
          >
            <Input autoFocus value={draft} maxLength={80} onChange={(e) => setDraft(e.target.value)} aria-label="Project name" onFocus={(e) => e.currentTarget.select()} />
            <DialogFooter className="mt-4">
              <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!draft.trim()}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this project?</AlertDialogTitle>
            <AlertDialogDescription>This project and all of its layers will be permanently deleted. This cannot be undone. The image it was opened on stays in your gallery.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const p = deleting!;
                setDeleting(null);
                void remove(p.id).then(() => toast("Project deleted", { duration: 1500 }), (e) => toastError(e));
              }}
            >
              Delete project
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  );
}

/** examples: "More to try" (exampleRow(), from the page). */
export function LayersProjects({ examples }: { examples?: ExampleRowData | null }) {
  return (
    <Suspense fallback={null}>
      <ProjectsInner examples={examples} />
    </Suspense>
  );
}
