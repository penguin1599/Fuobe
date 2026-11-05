"use client";

import { Box, Clapperboard, Copy, ExternalLink, Globe, MoreHorizontal, Pin, PinOff, Plus, Settings2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { PageShell } from "@/components/page-shell";
import { PageHeader } from "@/components/page-shell";
import { HadItemsScript, useHadItems } from "@/components/use-had-items";
import { ExampleRow } from "@/components/studio/example-row";
import { StarterSection, useStarters } from "@/components/starters/starter-section";
import { askToSignUp, useIsGuest } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import type { CinemaProject } from "@/lib/catalog/cinema";
import { formatUsd } from "./money";
import { timeAgo } from "@/lib/format";
import type { ExampleRowData } from "@/lib/examples/types";
import { starterShown, type StarterCardData } from "@/lib/starters/types";
import { cn } from "@/lib/utils";
import { copyWithToast } from "@/lib/clipboard";
import { useCinemaProjects, useUpdateProject } from "./hooks";
import { ProjectDialog } from "./project-settings";

/** A calm gradient for projects without a cover, stable per project. */
export function projectHue(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function Cover({ project, className }: { project: CinemaProject; className?: string }) {
  const src = project.cover ?? project.stats?.cover;
  const hue = projectHue(project.id);
  if (src && /\.(mp4|webm|mov)(\?|$)/i.test(src))
    return <video src={`${src}#t=0.1`} muted playsInline preload="metadata" className={cn("size-full object-cover", className)} />;
  if (src)
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" loading="lazy" className={cn("size-full object-cover", className)} />;
  return (
    <div className={cn("grid size-full place-items-center", className)} style={{ background: `linear-gradient(135deg, oklch(0.42 0.06 ${hue}), oklch(0.26 0.04 ${(hue + 40) % 360}))` }}>
      <Clapperboard className="size-7 text-white/70" />
    </div>
  );
}

function ProjectCard({ project, onSettings, query = "" }: { project: CinemaProject; onSettings: () => void; query?: string }) {
  const update = useUpdateProject(project.id);
  const href = `/cinema/${project.id}${query}`;
  return (
    <div className="group/card relative animate-fade-up">
      <Link href={href} className="card-motion block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <div className="relative aspect-video overflow-hidden rounded-xl bg-muted">
          <Cover project={project} className="card-zoom" />
          {project.pinned && (
            <span className="absolute top-2 left-2 grid size-7 place-items-center rounded-full bg-black/45 text-white backdrop-blur">
              <Pin className="size-3.5" />
            </span>
          )}
        </div>
        <div className="mt-2.5 min-w-0 px-0.5">
          <h2 className="truncate text-[15px] font-medium">{project.name}</h2>
          {project.description && <p className="mt-0.5 line-clamp-2 text-[13px] text-muted-foreground">{project.description}</p>}
          <p className="mt-1 text-[12px] text-muted-foreground">
            Updated {timeAgo(project.updatedAt)}
            {project.stats ? ` · ${project.stats.items} take${project.stats.items === 1 ? "" : "s"}` : ""}
            {project.stats?.spentUsd || project.costCapUsd != null ? (
              <span className="font-mono">
                {" "}
                · ≈ {formatUsd(project.stats?.spentUsd)}
                {project.costCapUsd != null ? ` of ${formatUsd(project.costCapUsd)}` : ""}
              </span>
            ) : null}
          </p>
        </div>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="absolute top-2 right-2 grid size-8 place-items-center rounded-full bg-black/45 text-white opacity-100 backdrop-blur transition-opacity hover:bg-black/65 focus-visible:opacity-100 sm:opacity-0 sm:group-hover/card:opacity-100 data-[state=open]:opacity-100"
            aria-label={`${project.name} actions`}
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => update.mutate({ pinned: !project.pinned })}>
            {project.pinned ? <PinOff /> : <Pin />} {project.pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => window.open(href, "_blank")}>
            <ExternalLink /> Open in new tab
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => void copyWithToast(new URL(href, window.location.origin).toString(), "Link copied")}
          >
            <Copy /> Copy link
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onSettings}>
            <Settings2 /> Settings
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * /cinema?blockout=1 (the GPU board's Blockout to film row) or /cinema?world=1 (its World mode row): the list says to
 * pick the project, and a project opened or started from it opens Blockout to film or World. Read in its own Suspense
 * boundary, so the rest of the list prerenders.
 */
function OpenerQuery({ onOpener }: { onOpener: (o: "blockout" | "world") => void }) {
  const params = useSearchParams();
  const on = params.get("blockout") === "1" ? "blockout" : params.get("world") === "1" ? "world" : null;
  useEffect(() => {
    if (on) onOpener(on);
  }, [on, onOpener]);
  return null;
}

const GRID = "grid grid-cols-1 gap-x-5 gap-y-7 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";

/**
 * The first-production block, or (`loading`) a placeholder of exactly its size: a grid skeleton
 * swapped for this block moved the page (CLS 0.048 in the round-4 audit).
 */
function EmptyProjects({ loading, onCreate, className }: { loading?: boolean; onCreate: () => void; className?: string }) {
  return (
    <div className={cn("mx-auto flex max-w-md flex-col items-center pt-[8vh] text-center", className)} aria-busy={loading || undefined} aria-label={loading ? "Loading projects" : undefined}>
      {loading ? (
        <>
          <Skeleton className="size-14 rounded-2xl" />
          <span className="mt-5 flex h-[1lh] w-full items-center justify-center font-heading text-[26px] leading-tight">
            <Skeleton className="h-6 w-2/3" />
          </span>
          {/* Two lines of 15 px text, then the button's 36 px. */}
          <span className="mt-2 flex h-[2lh] w-full flex-col items-center justify-center gap-2 text-[15px]">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-1/2" />
          </span>
          <Skeleton className="mt-6 h-9 w-36 rounded-full" />
        </>
      ) : (
        <>
          <div className="grid size-14 place-items-center rounded-2xl bg-brand-faint text-brand-text">
            <Clapperboard className="size-6" />
          </div>
          <h2 className="mt-5 font-heading text-[26px] leading-tight">Start your first production</h2>
          <p className="mt-2 text-[15px] text-muted-foreground">Projects keep your generations, elements, and chats together – create one to start.</p>
          <Button className="mt-6" onClick={onCreate}>
            <Plus /> New project
          </Button>
        </>
      )}
    </div>
  );
}

/**
 * examples: "More to try" (exampleRow(), from the page), under a guest's or an account's empty list. starters: the ready
 * films (catalog cards), first while there are no projects, then in one row under them.
 */
export function CinemaProjects({ examples, starters: given = [] }: { examples?: ExampleRowData | null; starters?: StarterCardData[] }) {
  const { data, isLoading } = useCinemaProjects();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CinemaProject | null>(null);
  // The owner's projects, or a signed-in account's own; a guest is offered a free account first.
  const guest = useIsGuest();
  const onCreate = () => (guest ? askToSignUp("run") : setCreating(true));
  // The ready films this viewer sees: a visitor only those with their real cover (the page carries only those), the
  // owner every one.
  const { owner, starters } = useStarters("cinema", given);
  const hasStarters = starters.some((s) => starterShown(s, !owner));
  useHadItems("cinema-projects", data?.length);
  const [opener, setOpener] = useState<"blockout" | "world" | null>(null);
  const markOpener = useCallback((o: "blockout" | "world") => setOpener(o), []);
  const blockout = opener === "blockout";
  const query = opener ? `?${opener}=1` : "";
  return (
    <PageShell wide>
      <PageHeader title="Cinema Studio" description="Direct films shot by shot: genre, camera, lens, palette and light, with characters and locations that stay the same.">
        <Button onClick={onCreate}>
          <Plus /> New project
        </Button>
      </PageHeader>
      <Suspense fallback={null}>
        <OpenerQuery onOpener={markOpener} />
      </Suspense>
      {/* With no projects yet (a guest, a new account), New project opens the new one on Blockout. */}
      {blockout && !isLoading && (
        <p className="mb-5 flex items-center gap-2 rounded-xl bg-brand-faint px-3 py-2.5 text-[13px] text-brand-text">
          <Box className="size-4 shrink-0" />{" "}
          {data?.length ? "Blockout to film: pick the project to film it in, or start a new one." : "Blockout to film: start a new project to film it in."}
        </p>
      )}
      {opener === "world" && !!data?.length && (
        <p className="mb-5 flex items-center gap-2 rounded-xl bg-brand-faint px-3 py-2.5 text-[13px] text-brand-text">
          <Globe className="size-4 shrink-0" /> World: pick the project to film it in, or start a new one.
        </p>
      )}
      {isLoading ? (
        // Both shapes are in the server's shell; the one this browser saw last time shows from the first paint.
        <div key="loading">
          <HadItemsScript name="cinema-projects" />
          <div className={cn(GRID, "hidden [html[data-had-cinema-projects='1']_&]:grid")} aria-busy="true" aria-label="Loading projects">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i}>
                <Skeleton className="aspect-video rounded-xl" />
                <Skeleton className="mt-3 h-4 w-2/3" />
                <Skeleton className="mt-2 h-3 w-1/3" />
              </div>
            ))}
          </div>
          <EmptyProjects loading className="[html[data-had-cinema-projects='1']_&]:hidden" onCreate={onCreate} />
        </div>
      ) : !data?.length ? (
        <div key="empty">
          {hasStarters ? (
            <StarterSection surface="cinema" starters={given} />
          ) : (
            <EmptyProjects onCreate={onCreate} />
          )}
          {/* On the page's own width: its heading sits under the page's title. */}
          {examples && <ExampleRow row={examples} layout="column" className="mt-12" />}
        </div>
      ) : (
        <div key="cards" className={GRID}>
          {data.map((p) => (
            <ProjectCard key={p.id} project={p} onSettings={() => setEditing(p)} query={query} />
          ))}
          <button
            onClick={onCreate}
            className="flex aspect-video flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong text-[13px] font-medium text-muted-foreground transition-colors hover:border-primary hover:bg-brand-faint hover:text-brand-text"
          >
            <Plus className="size-5" /> New project
          </button>
          <StarterSection surface="cinema" starters={given} row className="col-span-full mt-6" />
        </div>
      )}
      <ProjectDialog
        open={creating}
        onOpenChange={setCreating}
        onDone={(p) => {
          setCreating(false);
          if (p) router.push(`/cinema/${p.id}${query}`);
        }}
      />
      <ProjectDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        project={editing ?? undefined}
        spentUsd={editing?.stats?.spentUsd}
        onDone={() => setEditing(null)}
        onDeleted={() => setEditing(null)}
      />
    </PageShell>
  );
}
