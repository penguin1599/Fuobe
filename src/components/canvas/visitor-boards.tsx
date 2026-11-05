"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Cloud, HardDrive, MoreHorizontal, Pencil, Plus, Trash2, Workflow } from "lucide-react";
import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { CanvasSummary } from "@/lib/catalog/canvas";
import { deleteDraft, DRAFT_EVENT, getDraft, listDrafts, putDraft, type DraftSummary } from "@/lib/canvas-drafts";
import { timeAgo } from "@/lib/format";
import { toastError } from "@/lib/refusals";
import { Schematic } from "./template-card";
import { accountCanvasApi, useAccountCanvases } from "./use-canvas";

/** A visitor's board in the list: saved to its account, or kept in this browser. */
type Board = { where: "account"; c: CanvasSummary } | { where: "browser"; d: DraftSummary };

const idOf = (b: Board) => (b.where === "account" ? b.c.id : b.d.id);
const nameOf = (b: Board) => (b.where === "account" ? b.c.name : b.d.name);

function subscribe(onChange: () => void) {
  window.addEventListener(DRAFT_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(DRAFT_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
let cached: { key: string; list: DraftSummary[] } = { key: "[]", list: [] };
/** This browser's drafts, the same array while nothing changed (useSyncExternalStore). */
function draftsSnapshot(): DraftSummary[] {
  const list = listDrafts();
  const key = JSON.stringify(list);
  if (key !== cached.key) cached = { key, list };
  return cached.list;
}
const NONE: DraftSummary[] = [];

function BoardCard({ b, onRename, onDelete }: { b: Board; onRename: () => void; onDelete: () => void }) {
  const href = b.where === "account" ? `/canvas/saved/${b.c.id}` : `/canvas/draft/${b.d.id}`;
  const nodes = b.where === "account" ? b.c.nodeCount : b.d.nodeCount;
  const when = b.where === "account" ? b.c.updatedAt : b.d.updatedAt;
  return (
    <article className="group/card relative min-w-0" data-visitor-board={b.where}>
      <Link href={href} className="block rounded-xl outline-none focus-visible:ring-4 focus-visible:ring-brand-faint">
        <div className="aspect-[16/10] overflow-hidden rounded-xl border bg-muted/50 transition-shadow group-hover/card:shadow-normal">
          {b.where === "account" ? (
            <Schematic outline={b.c.outline} className="p-3" />
          ) : (
            <div className="grid size-full place-items-center text-subtle-foreground">
              <Workflow className="size-8" />
            </div>
          )}
        </div>
        <h3 className="mt-2 truncate pr-9 text-[14px] font-medium">{nameOf(b)}</h3>
        <p className="flex items-center gap-1 text-[12px] text-muted-foreground">
          {b.where === "account" ? <Cloud className="size-3" aria-hidden /> : <HardDrive className="size-3" aria-hidden />}
          {b.where === "account" ? "Saved" : "In this browser"} · Edited {timeAgo(when)} · {nodes} node{nodes === 1 ? "" : "s"}
        </p>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="absolute right-0 bottom-5 grid size-8 place-items-center rounded-md text-muted-foreground opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 sm:opacity-0 sm:group-hover/card:opacity-100 data-[state=open]:opacity-100"
            aria-label={`Actions for ${nameOf(b)}`}
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={onRename}>
            <Pencil /> Rename
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

/**
 * "Your canvases" for a guest or an account: the boards it saved to its account and the ones kept in this browser,
 * each opening in the editor, with Rename and Delete; and "Start blank". Nothing shows while it has none.
 */
export function VisitorBoards({ account }: { account: boolean }) {
  const qc = useQueryClient();
  const drafts = useSyncExternalStore(subscribe, draftsSnapshot, () => NONE);
  const saved = useAccountCanvases({ enabled: account });
  const [renaming, setRenaming] = useState<Board | null>(null);
  const [draft, setDraft] = useState("");
  const [deleting, setDeleting] = useState<Board | null>(null);
  const boards: Board[] = [...(saved.data ?? []).map((c) => ({ where: "account" as const, c })), ...drafts.map((d) => ({ where: "browser" as const, d }))];
  const refresh = () => void qc.invalidateQueries({ queryKey: ["account-canvases"], exact: true });

  const rename = async (b: Board, name: string) => {
    if (b.where === "account") {
      await accountCanvasApi.save(b.c.id, { name });
      refresh();
    } else {
      const d = getDraft(b.d.id);
      if (d) putDraft({ ...d, name, updatedAt: Date.now() });
    }
  };
  const remove = async (b: Board) => {
    if (b.where === "account") {
      qc.setQueryData<CanvasSummary[]>(["account-canvases"], (old) => old?.filter((c) => c.id !== b.c.id));
      await accountCanvasApi.remove(b.c.id);
      qc.removeQueries({ queryKey: ["account-canvases", b.c.id] });
      refresh();
    } else deleteDraft(b.d.id);
  };

  if (account && saved.isPending && !drafts.length)
    return (
      <div className="mt-6 grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 2 }, (_, i) => (
          <Skeleton key={i} className="aspect-[16/10] rounded-xl" />
        ))}
      </div>
    );
  if (!boards.length) return null;
  return (
    <section aria-labelledby="your-canvases" className="mt-6">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="your-canvases" className="font-heading text-[22px] leading-tight">
          Your canvases
        </h2>
        {!account && <p className="text-[13px] text-muted-foreground">Kept in this browser. Create a free account to keep them anywhere.</p>}
      </div>
      <div className="mt-4 grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {boards.map((b) => (
          <BoardCard
            key={`${b.where}-${idOf(b)}`}
            b={b}
            onRename={() => {
              setDraft(nameOf(b));
              setRenaming(b);
            }}
            onDelete={() => setDeleting(b)}
          />
        ))}
        <Link
          href="/canvas/try/blank"
          className="flex aspect-[16/10] flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-[14px] font-medium text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
        >
          <Plus className="size-5" /> Start blank
        </Link>
      </div>

      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename canvas</DialogTitle>
            <DialogDescription className="sr-only">Give this canvas a new name</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const b = renaming!;
              const name = draft.trim();
              setRenaming(null);
              if (name && name !== nameOf(b)) void rename(b, name).then(() => toast.success("Renamed", { duration: 1500 }), (err) => toastError(err));
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
            <AlertDialogTitle>Delete “{deleting ? nameOf(deleting) : ""}”?</AlertDialogTitle>
            <AlertDialogDescription>The board is removed for good.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const b = deleting!;
                setDeleting(null);
                void remove(b).then(() => toast("Deleted", { duration: 1500 }), (e) => toastError(e));
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
