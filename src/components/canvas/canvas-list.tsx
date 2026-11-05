"use client";

import { ArrowRight, Play, Copy, Loader2, MoreHorizontal, Pencil, Plus, Search, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EngineSwitch } from "@/components/studio/engine-switch";
import { PageShell } from "@/components/page-shell";
import { CoverArt, CoverImg, useCoverPlayback } from "@/components/template-cover";
import { useEngine, useHydrated, useIsAccount, useIsOwner, useLikelyVisitor, useModelAccess } from "@/lib/api";
// Types only: the catalog (models, templates) stays on the server; the page passes slim template cards.
import type { CanvasSummary } from "@/lib/catalog/canvas";
import { firstTemplates, moreTemplates, templateSections, type CanvasIntro, type TemplateCardData, type Viewing } from "@/lib/canvas-sections";
import { timeAgo } from "@/lib/format";
import { templateCover } from "@/lib/template-covers";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/refusals";
import { SkillCanvases } from "./skill-canvases";
import { Schematic, TemplateCard } from "./template-card";
import { useCanvasActions, useCanvases } from "./use-canvas";
import { VisitorBoards } from "./visitor-boards";

export type { TemplateCardData } from "@/lib/canvas-sections";

function CanvasCard({ c, onRename, onDelete }: { c: CanvasSummary; onRename: () => void; onDelete: () => void }) {
  const router = useRouter();
  const { duplicate } = useCanvasActions();
  return (
    <article className="group/card relative min-w-0">
      <Link href={`/canvas/${c.id}`} className="block rounded-xl outline-none focus-visible:ring-4 focus-visible:ring-brand-faint">
        <div className="aspect-[16/10] overflow-hidden rounded-xl border bg-muted/50 transition-shadow group-hover/card:shadow-normal">
          {c.preview ? (
            c.preview.kind === "video" ? (
              <video src={`${c.preview.url}#t=0.1`} poster={c.preview.poster} muted playsInline preload="metadata" className="size-full object-cover" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={c.preview.url} alt="" loading="lazy" className="size-full object-cover" />
            )
          ) : (
            <Schematic outline={c.outline} className="p-3" />
          )}
        </div>
        <h3 className="mt-2 truncate pr-9 text-[14px] font-medium">{c.name}</h3>
        <p className="text-[12px] text-muted-foreground">
          {c.editedAt ? `Edited ${timeAgo(c.editedAt)}` : "Never edited"} · {c.nodeCount} node{c.nodeCount === 1 ? "" : "s"}
          {c.pageCount > 1 && ` · ${c.pageCount} pages`}
        </p>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="absolute right-0 bottom-5 grid size-8 place-items-center rounded-md text-muted-foreground opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 sm:opacity-0 sm:group-hover/card:opacity-100 data-[state=open]:opacity-100"
            aria-label={`Actions for ${c.name}`}
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={onRename}>
            <Pencil /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              void duplicate(c.id).then(
                (copy) => toast.success("Duplicated", { action: { label: "Open", onClick: () => router.push(`/canvas/${copy.id}`) } }),
                (e) => toastError(e),
              )
            }
          >
            <Copy /> Duplicate
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2 /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </article>
  );
}

/** "What's a canvas?": two plain sentences, then one real effect film as three tiles, the photo, the scene, the shot. */
function WhatsACanvas({ intro }: { intro?: CanvasIntro }) {
  const { ref, playing, asked, handlers } = useCoverPlayback<HTMLLIElement>("canvas-intro", intro?.film);
  const tile = "relative aspect-[4/3] overflow-hidden rounded-lg border bg-muted";
  const caption = "mt-1 text-center text-[12px] font-medium text-muted-foreground sm:text-[13px]";
  const arrow = <ArrowRight className="mt-[calc(12%-8px)] size-4 shrink-0 self-start text-subtle-foreground" aria-hidden />;
  const sizes = "(max-width: 1024px) 30vw, 240px";
  return (
    <section aria-labelledby="whats-a-canvas" className="mt-4 grid gap-3 rounded-2xl border bg-card p-4 sm:p-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-center lg:gap-8">
      <div>
        <h2 id="whats-a-canvas" className="font-heading text-[22px] leading-tight">
          What&apos;s a canvas?
        </h2>
        <p className="mt-1 text-[15px] text-pretty text-muted-foreground">
          A board of connected steps: a photo goes in, an edit sets the scene, and the last step turns it into a moving shot. Change any step and run it again.
        </p>
      </div>
      {intro && (
        <ol className="flex items-start gap-1.5 sm:gap-3" aria-label="One canvas, step by step">
          <li className="min-w-0 flex-1">
            <div className={tile}>
              <CoverImg frame={intro.photo} sizes={sizes} />
            </div>
            <p className={caption}>Your photo</p>
          </li>
          {arrow}
          <li className="min-w-0 flex-1">
            <div className={tile}>
              <CoverImg frame={intro.film.frames[0]} sizes={sizes} />
            </div>
            <p className={caption}>A new scene</p>
          </li>
          {arrow}
          <li ref={ref} {...handlers} className="min-w-0 flex-1">
            <div className={tile}>
              <CoverArt cover={intro.film} sizes={sizes} playing={playing} asked={asked} />
              <Play className="pointer-events-none absolute right-1.5 bottom-1.5 size-5 rounded-full bg-background/85 p-1 text-foreground shadow-soft" aria-hidden />
            </div>
            <p className={caption}>A moving shot</p>
          </li>
        </ol>
      )}
    </section>
  );
}

/** The owner's boards while they load. */
function MineSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("mt-6 grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4", className)}>
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i}>
          <Skeleton className="aspect-[16/10] rounded-xl" />
          <Skeleton className="mt-2 h-4 w-2/3" />
        </div>
      ))}
    </div>
  );
}

/** A grid of template cards; `row`: one short row, a snap scroller on a phone. */
function CardGrid({ items, row, card }: { items: TemplateCardData[]; row?: boolean; card: (t: TemplateCardData) => React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3",
        row && "-mx-4 flex snap-x snap-mandatory overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:overflow-visible sm:px-0 sm:pb-0 [&>*]:w-[78%] [&>*]:shrink-0 [&>*]:snap-start sm:[&>*]:w-auto",
      )}
    >
      {items.map(card)}
    </div>
  );
}

function ListInner({ templates, intro }: { templates: TemplateCardData[]; intro?: CanvasIntro }) {
  const router = useRouter();
  const params = useSearchParams();
  const askedTemplates = params.get("tab") === "templates";
  const askedSkills = params.get("tab") === "skills";
  // The owner's canvases are the studio's. A guest or an account opens ready boards (and blank ones) in the same editor:
  // a guest keeps them in this browser, an account saves them to its account (visitor-canvas.tsx).
  // Until the viewer is known to be the owner, the page is a visitor's: only ready boards with their real cover show.
  const owner = useIsOwner();
  const account = useIsAccount();
  // In a browser the owner used last, their boards are on the way: a skeleton until they come, not the visitor's page.
  const likelyOwner = !useLikelyVisitor();
  const hydrated = useHydrated();
  const canvases = useCanvases({ enabled: owner });
  const { create, rename, remove } = useCanvasActions();
  const [engine, setEngine] = useEngine();
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<CanvasSummary | null>(null);
  const [draft, setDraft] = useState("");
  const [deleting, setDeleting] = useState<CanvasSummary | null>(null);
  const [seeAll, setSeeAll] = useState(false);
  const allTemplates = seeAll || askedTemplates;
  const gallery = useRef<HTMLElement>(null);
  const skillsRef = useRef<HTMLElement>(null);
  const access = useModelAccess();
  const viewing: Viewing = { visitor: !owner, hasCover: (id) => !!templateCover("canvas", id) };

  const mine = owner ? (canvases.data ?? []) : [];
  const loadingMine = likelyOwner && (!owner || canvases.isPending);
  const hasBoards = mine.length > 0;
  const items = mine.filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()));

  // ?tab=templates (a board's "Browse templates"): the full gallery, scrolled to.
  useEffect(() => {
    if (!askedTemplates) return;
    gallery.current?.scrollIntoView({ block: "start" });
  }, [askedTemplates, hasBoards]);

  // ?tab=skills: the skills that run by themselves, scrolled to.
  useEffect(() => {
    if (askedSkills && owner && !loadingMine) skillsRef.current?.scrollIntoView({ block: "start" });
  }, [askedSkills, owner, loadingMine]);

  const start = async (key: string, body: Parameters<typeof create>[0]) => {
    setCreating(key);
    try {
      const c = await create(body);
      router.push(`/canvas/${c.id}`);
    } catch (e) {
      toastError(e);
      setCreating(null);
    }
  };

  const card = (t: TemplateCardData) => (
    <TemplateCard key={t.id} t={t} engine={engine} access={access} owner={owner} busy={creating === t.id} onUse={owner ? () => void start(t.id, { templateId: t.id, engine }) : undefined} tryHref={owner ? undefined : `/canvas/try/${t.id}`} />
  );
  const sections = templateSections(templates, viewing);
  const more = moreTemplates(templates, viewing);

  const fullGallery = (
    <div className="space-y-10">
      {sections.map((s) => (
        <section key={s.key || "films"} aria-labelledby={`tpl-${s.key || "films"}`}>
          <div className="mb-3">
            <h3 id={`tpl-${s.key || "films"}`} className="font-heading text-[20px] leading-tight">
              {s.title}
            </h3>
            <p className="mt-0.5 text-[13px] text-muted-foreground">{s.note}</p>
          </div>
          <CardGrid items={s.items} card={card} />
        </section>
      ))}
      {owner && (
        <section aria-labelledby="tpl-more">
          <div className="mb-3">
            <h3 id="tpl-more" className="font-heading text-[20px] leading-tight">
              More templates
            </h3>
            <p className="mt-0.5 text-[13px] text-muted-foreground">Boards to build on, and a blank one.</p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {more.map(card)}
            <button
              onClick={() => void start("new", {})}
              disabled={!!creating}
              className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-[14px] font-medium text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
            >
              {creating === "new" ? <Loader2 className="size-5 animate-spin" /> : <Plus className="size-5" />} Start blank
            </button>
          </div>
        </section>
      )}
    </div>
  );

  const galleryHeading = (title: string, note?: string) => (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <div className="min-w-0 flex-1">
        <h2 id="templates-title" className="font-heading text-[26px] leading-tight">
          {title}
        </h2>
        {note && <p className="mt-0.5 text-[14px] text-muted-foreground">{note}</p>}
      </div>
      {owner && <EngineSwitch value={engine} onChange={setEngine} size="sm" />}
    </div>
  );

  return (
    <PageShell wide>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <h1 className="font-heading text-[34px] leading-tight">Canvas</h1>
          {hasBoards && <p className="mt-1 max-w-xl text-[15px] text-muted-foreground">Make images, videos and ideas in one place: wire prompts, files and models together, then run them in order or side by side.</p>}
        </div>
        {owner ? (
          <Button className="w-fit rounded-full" onClick={() => void start("new", {})} disabled={!!creating}>
            {creating === "new" ? <Loader2 className="animate-spin" /> : <Plus />} New canvas
          </Button>
        ) : (
          <Button asChild className="w-fit rounded-full">
            <Link href="/canvas/try/blank">
              <Plus /> New canvas
            </Link>
          </Button>
        )}
      </div>

      {loadingMine ? (
        <MineSkeleton />
      ) : hasBoards ? (
        <>
          <section aria-labelledby="mine-title" className="mt-6">
            <div className="flex flex-wrap items-center gap-3">
              <h2 id="mine-title" className="font-heading text-[22px] leading-tight">
                Your canvases
              </h2>
              <div className="relative ml-auto w-full sm:w-64">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search canvases" aria-label="Search canvases" className="h-9 rounded-full pl-9" />
              </div>
            </div>
            {items.length ? (
              <div className="mt-4 grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {items.map((c) => (
                  <CanvasCard
                    key={c.id}
                    c={c}
                    onRename={() => {
                      setDraft(c.name);
                      setRenaming(c);
                    }}
                    onDelete={() => setDeleting(c)}
                  />
                ))}
              </div>
            ) : (
              <p className="py-16 text-center text-[15px] text-muted-foreground">No canvas called “{q}”.</p>
            )}
          </section>
          <section id="templates" ref={gallery} aria-labelledby="templates-title" className="mt-12 scroll-mt-20">
            {galleryHeading("Start from a template")}
            {allTemplates ? (
              fullGallery
            ) : (
              <>
                <CardGrid items={firstTemplates(templates, viewing)} row card={card} />
                <Button variant="secondary" className="mt-4 rounded-full" onClick={() => setSeeAll(true)}>
                  See all templates
                </Button>
              </>
            )}
          </section>
        </>
      ) : (
        <>
          {/* Before hydration, a browser the owner used last shows the skeleton (html[data-viewer]), not the visitor's page. */}
          {!hydrated && <MineSkeleton className="hidden [html[data-viewer='owner']_&]:grid" />}
          <div className={cn(!hydrated && "[html[data-viewer='owner']_&]:hidden")}>
            {hydrated && !owner && <VisitorBoards account={account} />}
            <WhatsACanvas intro={intro} />
            <section id="templates" ref={gallery} aria-labelledby="templates-title" className="mt-8 scroll-mt-20">
              {galleryHeading(
                "Start from a ready board",
                owner ? "Every step, word and file is already in place. Press Run all, or change anything first." : "Every step, word and photo is already in place. Open one in the editor and change anything.",
              )}
              {fullGallery}
            </section>
          </div>
        </>
      )}

      {/* The studio's skills are its owner's: each one that runs by itself opens as a canvas to change visually. */}
      {owner && !loadingMine && (
        <section id="skills" ref={skillsRef} aria-labelledby="skills-title" className="mt-12 scroll-mt-20">
          <h2 id="skills-title" className="font-heading text-[22px] leading-tight">
            Skills as canvases
          </h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">Open a skill that runs by itself as a canvas, change a model or a link, then save it back as a skill.</p>
          <SkillCanvases visitor={false} />
        </section>
      )}

      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename canvas</DialogTitle>
            <DialogDescription className="sr-only">Give this canvas a new name</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const c = renaming!;
              const name = draft.trim();
              setRenaming(null);
              if (name && name !== c.name) void rename(c.id, name).then(() => toast.success("Renamed", { duration: 1500 }), (err) => toastError(err));
            }}
          >
            <Input autoFocus value={draft} maxLength={80} onChange={(e) => setDraft(e.target.value)} aria-label="Name" />
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
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>The board is removed for good. Everything it made stays in your library.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const c = deleting!;
                setDeleting(null);
                void remove(c.id).then(() => toast("Deleted", { duration: 1500 }), (e) => toastError(e));
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  );
}

export function CanvasList({ templates, intro }: { templates: TemplateCardData[]; intro?: CanvasIntro }) {
  return (
    <Suspense fallback={null}>
      <ListInner templates={templates} intro={intro} />
    </Suspense>
  );
}
