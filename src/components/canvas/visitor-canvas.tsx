"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Cloud, Loader2, LogIn, Monitor, UserPlus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { NotFoundState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useIsMobile } from "@/hooks/use-mobile";
import { signInHref, useEngine, useHydrated, useViewer } from "@/lib/api";
import type { Canvas } from "@/lib/catalog/canvas";
import type { CanvasPage } from "@/lib/catalog/canvas-board";
import type { Generation } from "@/lib/catalog/types";
import { deleteDraft, draftName, getDraft, newDraftId, putDraft, type CanvasDraft } from "@/lib/canvas-drafts";
import { toastError } from "@/lib/refusals";
import { BoardEditor, EditorSkeleton, type BoardHost, type BoardNow } from "./canvas-editor";
import { EXAMPLE_FEATURE } from "./canvas-context";
import { accountCanvasApi, useAccountCanvas, useCanvasActions, type CanvasView } from "./use-canvas";

/**
 * A visitor's canvas (public sign-up): the owner's editor on a board a guest or an account builds. A ready board or a
 * blank one opens at /canvas/try/<id>; the first change keeps it in this browser (/canvas/draft/<id>); an account
 * saves it to its account (/canvas/saved/<id>), where every change saves. Run never runs here: it says what running
 * a board needs (an account's own GPU doesn't run a canvas yet, and a guest never runs on the studio's), with the
 * Video effect that makes the same in one step where the board has one.
 */

/** A ready board as the server builds it for a visitor (src/server/visitor-board.ts), sent with its page. */
export interface VisitorBoardData {
  id: string;
  name: string;
  templateId: string | null;
  pages: CanvasPage[];
  example?: { nodeId: string; kind: "image" | "video"; url: string; poster: string };
  oneStep?: { href: string; label: string };
}

type Who = "guest" | "account" | "owner";

/** Who is looking, once known (null before hydration and the viewer's answer). */
function useWho(): Who | null {
  const hydrated = useHydrated();
  const v = useViewer().data;
  if (!hydrated || !v) return null;
  return v.owner ? "owner" : v.signedIn ? "account" : "guest";
}

/** The board's example result (the template's own published film or picture), shown on its last step until it runs. */
function exampleView(c: Canvas, example: VisitorBoardData["example"]): CanvasView {
  if (!example) return { canvas: c, generations: [] };
  const id = `example-${c.templateId ?? c.id}`;
  const g = {
    id,
    batchId: null,
    feature: EXAMPLE_FEATURE,
    presetId: null,
    modelId: "",
    engine: "open",
    provider: "comfyui",
    op: example.kind === "video" ? "image-to-video" : "text-to-image",
    kind: example.kind,
    status: "succeeded",
    progress: null,
    message: null,
    prompt: null,
    request: {},
    outputs: [{ url: example.url, kind: example.kind, ...(example.kind === "video" && { meta: { poster: example.poster } }) }],
    error: null,
    costUsd: null,
    favorite: false,
    createdAt: 0,
    updatedAt: 0,
    completedAt: 0,
  } as unknown as Generation;
  return { canvas: { ...c, runs: { [example.nodeId]: { sig: "example", ids: [id], at: 0 } } }, generations: [g] };
}

const asCanvas = (b: { id: string; name: string; templateId: string | null; pages: CanvasPage[] }): Canvas => ({
  id: b.id,
  name: b.name,
  pages: b.pages,
  runs: {},
  templateId: b.templateId,
  createdAt: 0,
  updatedAt: 0,
  editedAt: null,
});

// ---------------------------------------------------------------------------
// What running needs, and saving to an account

function RunNeeds({ open, onOpenChange, who, oneStep }: { open: boolean; onOpenChange: (o: boolean) => void; who: Who; oneStep?: VisitorBoardData["oneStep"] }) {
  const here = usePathname();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Running a board isn&apos;t available here</DialogTitle>
          <DialogDescription>
            You can build, change and keep boards here.{" "}
            {oneStep ? "To make this result now, use the same effect in the Video studio: it runs every step at once." : "To make something now, use the Image, Video or Audio studio, or an app, effect or camera motion."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-start">
          <Button asChild className="rounded-full">
            <Link href={oneStep?.href ?? "/video"}>
              {oneStep?.label ?? "Open the Video studio"} <ArrowRight />
            </Link>
          </Button>
          {who === "guest" && (
            <Button asChild variant="secondary" className="rounded-full">
              <Link href={signInHref("signup", here)}>
                <UserPlus /> Sign up to save boards
              </Link>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A guest's Save: the board is kept in this browser; an account keeps it everywhere. */
function SignUpToSave({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const here = usePathname();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keep this board in an account</DialogTitle>
          <DialogDescription>Your board is kept in this browser for now. Create a free account to save your canvases and open them anywhere.</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-start">
          <Button asChild className="rounded-full">
            <Link href={signInHref("signup", here)}>
              <UserPlus /> Sign up
            </Link>
          </Button>
          <Button asChild variant="secondary" className="rounded-full">
            <Link href={signInHref("login", here)}>
              <LogIn /> Log in
            </Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The phone's line under the header: wiring new steps takes a larger screen; the board is kept. */
function PhoneNote({ kept }: { kept: string }) {
  return (
    <p className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-4 py-2 text-[12px] text-muted-foreground" data-phone-note>
      <Monitor className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">Change any step in Nodes. To add and wire new steps, open this board on a larger screen. {kept}</span>
    </p>
  );
}

/**
 * The editor with a visitor's host: `keep` saves the pages and name where this board lives; `onSaveToAccount` (an
 * account's board kept in this browser) moves it to the account.
 */
function VisitorEditor({
  board,
  who,
  savedLabel,
  keep,
  rename,
  saveToAccount,
  example,
  oneStep,
}: {
  board: Canvas;
  who: Who;
  savedLabel: string;
  keep: (pages: CanvasPage[], keepalive: boolean) => Promise<void>;
  rename: (name: string) => Promise<void>;
  /** An account's board not saved to it yet: Save moves it there (`saved` runs once the account has it). */
  saveToAccount?: (now: BoardNow, saved: () => void) => Promise<void>;
  example?: VisitorBoardData["example"];
  oneStep?: VisitorBoardData["oneStep"];
}) {
  const [runOpen, setRunOpen] = useState(false);
  const [signUpOpen, setSignUpOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const isMobile = useIsMobile();
  // Saved to the account: this browser stops keeping the board (the editor's last flush as it closes would make it
  // again, as a second board, and move the address back to it).
  const moved = useRef(false);
  const keepRef = useRef({ keep, rename, saveToAccount });
  useEffect(() => {
    keepRef.current = { keep, rename, saveToAccount };
  });
  const view = useMemo(() => exampleView(board, example), [board, example]);
  const action = useCallback(
    (now: () => BoardNow) => {
      if (who === "guest")
        return (
          <Button size="sm" className="h-8 rounded-full px-3" onClick={() => setSignUpOpen(true)} data-visitor-save>
            <Cloud /> Save
          </Button>
        );
      if (!keepRef.current.saveToAccount) return null;
      return (
        <Button
          size="sm"
          className="h-8 rounded-full px-3"
          disabled={saving}
          data-visitor-save
          onClick={() => {
            setSaving(true);
            void keepRef.current.saveToAccount!(now(), () => (moved.current = true)).catch((e) => {
              toastError(e);
              setSaving(false);
            });
          }}
        >
          {saving ? <Loader2 className="animate-spin" /> : <Cloud />} <span className="sm:hidden">Save</span>
          <span className="max-sm:hidden">Save to account</span>
        </Button>
      );
    },
    [who, saving],
  );
  const host = useMemo<BoardHost>(
    () => ({
      save: async (pages, keepalive) => void (moved.current || (await keepRef.current.keep(pages, keepalive))),
      rename: async (name) => void (moved.current || (await keepRef.current.rename(name))),
      visitor: {
        savedLabel,
        run: () => setRunOpen(true),
        action,
        note: isMobile ? <PhoneNote kept={savedLabel === "Saved" ? "Your changes save to your account." : "Your board is kept in this browser."} /> : undefined,
      },
    }),
    [savedLabel, action, isMobile],
  );
  return (
    <>
      <BoardEditor id={board.id} initial={board} view={view} host={host} />
      <RunNeeds open={runOpen} onOpenChange={setRunOpen} who={who} oneStep={oneStep} />
      <SignUpToSave open={signUpOpen} onOpenChange={setSignUpOpen} />
    </>
  );
}

/** An account's board kept in this browser goes to the account: the draft is removed once it is saved there. */
function useSaveToAccount(draftId: () => string | null) {
  const router = useRouter();
  const qc = useQueryClient();
  return useCallback(
    async (now: BoardNow, templateId: string | null, saved: () => void) => {
      const c = await accountCanvasApi.create({ name: now.name, templateId, pages: now.pages });
      saved();
      const d = draftId();
      if (d) deleteDraft(d);
      void qc.invalidateQueries({ queryKey: ["account-canvases"], exact: true });
      toast.success("Saved to your account", { duration: 1800 });
      router.replace(`/canvas/saved/${c.id}`);
    },
    [router, qc, draftId],
  );
}

/** Keeps a board in this browser under `id`, made on its first change. */
function draftKeeper(id: string, base: { name: string; templateId: string | null; pages: CanvasPage[] }, createdAt: number) {
  let name = base.name;
  let pages = base.pages;
  const put = () => putDraft({ id, name, templateId: base.templateId, pages, createdAt, updatedAt: Date.now() } satisfies CanvasDraft);
  return {
    keep: async (p: CanvasPage[]) => {
      pages = p;
      // A rename from the Canvas list while this board was open stays.
      name = draftName(id) ?? name;
      put();
    },
    rename: async (n: string) => {
      name = n;
      put();
    },
  };
}

// ---------------------------------------------------------------------------
// The three pages

/** /canvas/try/<id>: a ready board (or a blank one). The owner gets a board of their own in the studio at once. */
export function TryBoard({ board }: { board: VisitorBoardData }) {
  const who = useWho();
  const router = useRouter();
  const { create } = useCanvasActions();
  const [engine] = useEngine();
  const started = useRef(false);
  // The owner's boards are the studio's: make one from the template, as "Use template" does.
  useEffect(() => {
    if (who !== "owner" || started.current) return;
    started.current = true;
    create(board.templateId ? { templateId: board.templateId, engine } : {}).then(
      (c) => router.replace(`/canvas/${c.id}`),
      (e) => toastError(e),
    );
  }, [who, board.templateId, engine, create, router]);
  // The draft this board becomes on its first change (its address changes to it, without reloading).
  const draft = useRef<string | null>(null);
  const keeper = useRef<ReturnType<typeof draftKeeper> | null>(null);
  const keepFirst = useCallback(() => {
    if (!keeper.current) {
      draft.current = newDraftId();
      keeper.current = draftKeeper(draft.current, board, Date.now());
    }
    return keeper.current;
  }, [board]);
  const moved = useRef(false);
  const afterFirst = useCallback(() => {
    if (moved.current || !draft.current) return;
    moved.current = true;
    window.history.replaceState(null, "", `/canvas/draft/${draft.current}`);
  }, []);
  const saveToAccount = useSaveToAccount(useCallback(() => draft.current, []));
  const canvas = useMemo(() => asCanvas(board), [board]);
  if (!who || who === "owner") return <EditorSkeleton />;
  return (
    <VisitorEditor
      board={canvas}
      who={who}
      savedLabel="Kept in this browser"
      keep={async (pages) => {
        await keepFirst().keep(pages);
        afterFirst();
      }}
      rename={async (name) => {
        await keepFirst().rename(name);
        afterFirst();
      }}
      saveToAccount={who === "account" ? (now, saved) => saveToAccount(now, board.templateId, saved) : undefined}
      example={board.example}
      oneStep={board.oneStep}
    />
  );
}

/** /canvas/draft/<id>: a board kept in this browser. */
export function DraftBoard({ id, boards }: { id: string; boards: Record<string, Pick<VisitorBoardData, "example" | "oneStep">> }) {
  const who = useWho();
  const hydrated = useHydrated();
  // Read as this page opens, so it is the board as last kept (the server can't see this browser's storage, and the
  // page shows a skeleton until hydrated, so what the server drew and the first render match).
  const [draft] = useState(() => getDraft(id));
  const saveToAccount = useSaveToAccount(useCallback(() => id, [id]));
  const keeper = useMemo(() => (draft ? draftKeeper(id, draft, draft.createdAt) : null), [id, draft]);
  const canvas = useMemo(() => (draft ? asCanvas(draft) : null), [draft]);
  if (!hydrated || !who) return <EditorSkeleton />;
  if (!draft || !keeper || !canvas)
    return (
      <NotFoundState title="This board isn’t in this browser">
        A board you haven&apos;t saved to an account stays in the browser you made it in. Start a new one from Canvas.
      </NotFoundState>
    );
  const extra = draft.templateId ? boards[draft.templateId] : undefined;
  return (
    <VisitorEditor
      board={canvas}
      who={who === "owner" ? "account" : who}
      savedLabel="Kept in this browser"
      keep={async (pages) => keeper.keep(pages)}
      rename={async (name) => keeper.rename(name)}
      saveToAccount={who === "account" ? (now, saved) => saveToAccount(now, draft.templateId, saved) : undefined}
      example={extra?.example}
      oneStep={extra?.oneStep}
    />
  );
}

/** /canvas/saved/<id>: an account's own board; every change saves to the account. */
export function SavedBoard({ id, boards }: { id: string; boards: Record<string, Pick<VisitorBoardData, "example" | "oneStep">> }) {
  const who = useWho();
  const here = usePathname();
  const q = useAccountCanvas(id, { enabled: who === "account" });
  const canvas = useMemo(() => (q.data ? asCanvas(q.data) : null), [q.data]);
  if (!who || (who === "account" && q.isPending)) return <EditorSkeleton />;
  if (who === "guest")
    return (
      <NotFoundState title="Log in to open this canvas">
        <span className="block">Your saved canvases open when you&apos;re logged in.</span>
        <Link href={signInHref("login", here)} className="mt-2 inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4">
          <LogIn className="size-3.5" /> Log in
        </Link>
      </NotFoundState>
    );
  if (!canvas) return <NotFoundState title="This canvas isn’t here">It may have been deleted.</NotFoundState>;
  const extra = canvas.templateId ? boards[canvas.templateId] : undefined;
  return (
    <VisitorEditor
      board={canvas}
      who="account"
      savedLabel="Saved"
      keep={async (pages, keepalive) => void (await accountCanvasApi.save(id, { pages }, keepalive))}
      rename={async (name) => void (await accountCanvasApi.save(id, { name }))}
      example={extra?.example}
      oneStep={extra?.oneStep}
    />
  );
}

