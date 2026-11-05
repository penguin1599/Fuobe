"use client";

import { ArrowRight, Drama, Film, Layers, Loader2, Scissors, Sparkles, Trash2, UserRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Panel, ToolHero, ToolShell } from "@/components/av/tool-shell";
import { EngineSwitch } from "@/components/studio/engine-switch";
import { ExampleRow } from "@/components/studio/example-row";
import { useEngine } from "@/lib/api";
import { SWAP_STUDIO, type SwapProjectCard } from "@/lib/catalog/swap-studio";
import { toastError } from "@/lib/refusals";
import type { ExampleRowData } from "@/lib/examples/types";
import { useCreateSwapProject, useDeleteSwapProject, useSwapProjects } from "./hooks";

const STEPS = [
  { icon: Film, title: "Clips and your character", text: "Add whole clips (MP4, MOV, MKV, WebM or AVI, up to 2½ minutes) and a picture of who comes in." },
  { icon: Scissors, title: "Shots and words", text: "Find the edits, keep or replace each shot, transcribe who says what and build the prompts." },
  { icon: UserRound, title: "Who and the scene", text: "Click who to swap, then check how they look in the scene." },
  { icon: Layers, title: "Segments and takes", text: "Render each shot, compare takes, keep the best and put it together." },
];

const ago = (t: number) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};

/** examples: "More to try" (exampleRow(), from the page), while there are no projects of one's own. */
export function SwapStudioHome({ examples }: { examples?: ExampleRowData | null }) {
  const router = useRouter();
  const [engine, setEngine] = useEngine();
  const projects = useSwapProjects();
  const create = useCreateSwapProject();
  const del = useDeleteSwapProject();
  const [name, setName] = useState("");
  const [confirm, setConfirm] = useState<SwapProjectCard | null>(null);
  const nameId = useId();

  const start = () =>
    create.mutate(
      { name: name.trim() || undefined, engine },
      {
        onSuccess: (p) => router.push(`/character-swap/${p.id}`),
        onError: (e) => toastError(e),
      },
    );

  return (
    <ToolShell title="Character Swap Studio" engineSwitch={false} header={<EngineSwitch value={engine} onChange={setEngine} />} wide>
      <ToolHero
        title="Swap a character through whole clips"
        subtitle="Put your character into whole clips, shot by shot: pick who to swap, check each shot, keep the best take."
      >
        <form
          className="mt-6 flex w-full max-w-lg flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            start();
          }}
        >
          <label htmlFor={nameId} className="sr-only">
            Project name
          </label>
          <input
            id={nameId}
            value={name}
            maxLength={SWAP_STUDIO.maxNameChars}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project name, e.g. Rain scene"
            className="h-10 min-w-0 shrink-0 rounded-full border bg-background px-4 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:flex-1"
          />
          <Button type="submit" className="h-10 rounded-full px-5" disabled={create.isPending}>
            {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Drama className="size-4" />}
            {`New project · ${engine === "open" ? "your GPU" : "cloud"}`}
          </Button>
        </form>
      </ToolHero>

      {examples && projects.isSuccess && !projects.data.length && <ExampleRow row={examples} className="mt-10" />}

      <ol className="mx-auto mt-8 grid max-w-[1040px] gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="How it works">
        {STEPS.map((s, i) => (
          <li key={s.title} className="rounded-2xl border bg-background p-3 shadow-soft">
            <span className="flex items-center gap-2 text-[13px] font-semibold">
              <span className="grid size-7 place-items-center rounded-full bg-brand-faint text-brand-text">
                <s.icon className="size-4" aria-hidden />
              </span>
              {i + 1}. {s.title}
            </span>
            <p className="mt-1.5 text-[12px] leading-snug text-pretty text-muted-foreground">{s.text}</p>
          </li>
        ))}
      </ol>

      {/* The owner's projects, or a signed-in account's own (a guest has none yet: New project offers a free account). */}
      <section className="mt-8" aria-labelledby="swap-projects">
        <h2 id="swap-projects" className="mb-3 text-[15px] font-semibold">
          Projects
        </h2>
        {projects.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-28 rounded-2xl" />
            ))}
          </div>
        ) : !projects.data?.length ? (
          <p className="rounded-2xl border border-dashed px-4 py-8 text-center text-[13px] text-muted-foreground">No projects yet — name one above to start.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.data.map((p) => (
              <li key={p.id} className="group relative flex min-w-0 gap-3 rounded-2xl border bg-background p-3 shadow-soft transition-colors hover:border-border-strong">
                <div className="grid size-20 shrink-0 place-items-center overflow-hidden rounded-xl bg-muted">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {p.character ? <img src={p.character} alt="" className="size-full object-cover" /> : <Drama className="size-6 text-muted-foreground" aria-hidden />}
                </div>
                <div className="min-w-0 flex-1">
                  <Link href={`/character-swap/${p.id}`} className="block truncate text-[14px] font-semibold after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none">
                    {p.name}
                  </Link>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">
                    {p.engine === "open" ? "Your GPU" : "Cloud"} · {p.clips} clip{p.clips === 1 ? "" : "s"} · {p.swapped}/{p.shots} shots swapped
                  </p>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">
                    {p.assembled ? `${p.assembled} assembled · ` : ""}
                    {p.waiting ? `${p.waiting} waiting · ` : ""}
                    {ago(p.updatedAt)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setConfirm(p)}
                  aria-label={`Delete ${p.name}`}
                  className="relative z-10 grid size-8 shrink-0 place-items-center self-start rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Panel className="mt-8">
        <Link href="/genjutsu?mode=character" className="inline-flex items-center gap-1 text-[13px] font-medium text-brand-text hover:underline">
          <Sparkles className="size-3.5" /> One quick swap of one part instead? Genjutsu → Character swap <ArrowRight className="size-3.5" />
        </Link>
      </Panel>

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{confirm?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>Its clips, shots, masks, anchors and takes go; what it still makes is stopped. Assembled clips stay in the Library.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                confirm &&
                del.mutate(confirm.id, {
                  onSuccess: () => toast("Project deleted"),
                  onError: (e) => toastError(e),
                })
              }
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ToolShell>
  );
}
