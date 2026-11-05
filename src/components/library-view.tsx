"use client";

import { ArchiveRestore, BookmarkPlus, CheckCheck, CheckSquare, ChevronUp, CircleDot, Download, FolderInput, Globe, Heart, Loader2, MoreHorizontal, Pin, PinOff, Search, Trash2, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AssetCard, cardRatio, type CardApi } from "@/components/library/asset-card";
import { FilterBar, filterFields, filtersFor, hasFilters, NO_FILTERS, type Filters } from "@/components/library/filters";
import { SkillSuggestions } from "@/components/skills/skill-suggestions";
import { FolderDialog, FolderHeader, FolderStrip, MoveMenuItems } from "@/components/library/folders";
import { ReviewMenuItems } from "@/components/library/review";
import { UploadDeleteProvider } from "@/components/library/upload-delete";
import { askDeleteForGood } from "@/components/studio/delete-for-good";
import { useViewPrefs, ViewOptions, type ViewPrefs } from "@/components/library/view-options";
import { openAddKey } from "@/components/keys/your-keys";
import { PageShell } from "@/components/page-shell";
import { useShare } from "@/components/share/share-provider";
import { SharedLinks } from "@/components/share/shared-links";
import { useSkillBuilder } from "@/components/skills/skill-builder-provider";
import { ForeverConfirmProvider, useConfirmForever } from "@/components/studio/result-actions";
import { Viewer } from "@/components/studio/viewer";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { BULK_MAX, signInHref, useCreateGeneration, useFolders, useGenerationActions, useIsAccount, useIsGuest, useIsOwner, useIsVisitor, useLibrary, useLibraryFacets, useShares, useStatus, useUploads, type Asset, type FeedFilter } from "@/lib/api";
import type { Generation, MediaKind, ReviewStatus } from "@/lib/catalog/types";
import { keyCombo, useModKey } from "@/lib/keys";
import { buildEntries, folderAndDescendants, reviewInfo, splitByDate, toggleAll, TRASH_DAYS, type LibraryEntry } from "@/lib/library";
import { isLayered, shownOutputs } from "@/lib/output-actions";
import { isExpired } from "@/lib/share";
import { StarterSection, useStarters } from "@/components/starters/starter-section";
import { starterShown, type StarterCardData } from "@/lib/starters/types";
import { cn } from "@/lib/utils";
import { onAttr, TAB_PILL, TabRow, useSwapFade } from "@/components/ui/tab-row";
import { toastError } from "@/lib/refusals";
import { downloadZip } from "@/lib/zip-download";
import { ACCOUNT_ZIP_MAX_RUNS } from "@/lib/guest-access";

type TabId = "all" | "images" | "videos" | "audio" | "text" | "3d" | "favorites" | "uploads" | "shared" | "trash";

const TABS: { id: TabId; label: string; kinds?: MediaKind[] }[] = [
  { id: "all", label: "All" },
  { id: "images", label: "Images", kinds: ["image"] },
  { id: "videos", label: "Videos", kinds: ["video"] },
  { id: "audio", label: "Audio", kinds: ["audio"] },
  { id: "text", label: "Text", kinds: ["text"] },
  { id: "3d", label: "3D", kinds: ["model3d"] },
  { id: "favorites", label: "Favorites" },
  { id: "uploads", label: "Uploads" },
  { id: "shared", label: "Shared" },
  { id: "trash", label: "Trash" },
];

const singles = new WeakMap<Generation, LibraryEntry>();
/** A stack member as its own card entry (cached per object so memoized cards stay put). */
function singleEntry(g: Generation): LibraryEntry {
  let e = singles.get(g);
  if (!e) singles.set(g, (e = { type: "single", key: g.id, g }));
  return e;
}

const ids = (e: LibraryEntry) => (e.type === "single" ? [e.g.id] : e.items.map((g) => g.id));
const members = (e: LibraryEntry) => (e.type === "single" ? [e.g] : e.items);

/** Keep entry objects whose content didn't change, so memoized cards skip re-rendering on polls. */
function useStableEntries(next: LibraryEntry[]): LibraryEntry[] {
  // "Storing information from previous renders": recompute only when the list itself changes.
  const [state, setState] = useState<{ next: LibraryEntry[] | null; out: LibraryEntry[]; map: Map<string, LibraryEntry> }>({ next: null, out: [], map: new Map() });
  if (state.next === next) return state.out;
  const out = stabilize(state.map, next);
  setState({ next, out: out.list, map: out.map });
  return out.list;
}

function stabilize(prev: Map<string, LibraryEntry>, next: LibraryEntry[]): { list: LibraryEntry[]; map: Map<string, LibraryEntry> } {
  {
    const map = new Map<string, LibraryEntry>();
    const out = next.map((e) => {
      const p = prev.get(e.key);
      const same =
        p &&
        p.type === e.type &&
        (e.type === "single"
          ? (p as typeof e).g === e.g
          : (p as typeof e).title === e.title && (p as typeof e).label === e.label && (p as typeof e).items.length === e.items.length && (p as typeof e).items.every((g, i) => g === e.items[i]));
      const keep = same ? p : e;
      map.set(e.key, keep);
      return keep;
    });
    return { list: out, map };
  }
}

/** An upload, shaped like a finished generation so the cards and the viewer can show it. */
function uploadAsGeneration(a: Asset): Generation {
  return {
    id: a.id,
    batchId: null,
    feature: "upload",
    presetId: null,
    modelId: "upload",
    modelName: "Your upload",
    engine: "open",
    provider: "local",
    op: a.kind === "video" ? "v2v" : "edit",
    kind: a.kind,
    status: "succeeded",
    progress: 1,
    message: null,
    prompt: null,
    request: { feature: "upload", modelId: "upload", prompt: a.name ?? "Upload" },
    outputs: [{ url: a.url, kind: a.kind, contentType: a.contentType, assetId: a.id }],
    error: null,
    costUsd: null,
    favorite: false,
    createdAt: a.createdAt,
    updatedAt: a.createdAt,
    completedAt: a.createdAt,
  };
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-primary/10 bg-brand-faint px-6 py-12 text-center">
      <p className="font-heading text-[22px]">{title}</p>
      {children && <div className="mt-1 text-[14px] text-muted-foreground">{children}</div>}
    </div>
  );
}

const GAP = 8;

/**
 * Masonry that keeps reading order left to right: each card goes into the shortest column, by the
 * aspect ratios we already know (CSS columns would fill top to bottom, scattering the newest).
 */
function Masonry({ entries, size, render }: { entries: LibraryEntry[]; size: number; render: (e: LibraryEntry) => React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // Measured before the first paint: a guessed column count, corrected a frame later, moved every card (CLS 0.42 on a phone).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.round(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cols = width ? Math.max(width < 640 ? 2 : 1, Math.floor((width + GAP) / (size + GAP))) : 4;
  const columns = useMemo(() => {
    const heights = Array.from({ length: cols }, () => 0);
    const out = Array.from({ length: cols }, () => [] as LibraryEntry[]);
    for (const e of entries) {
      const k = heights.indexOf(Math.min(...heights));
      out[k].push(e);
      heights[k] += 1 / cardRatio(e, "masonry") + 0.04;
    }
    return out;
  }, [entries, cols]);
  return (
    <div ref={ref} className="flex items-start gap-2">
      {columns.map((c, i) => (
        <div key={i} className="flex min-w-0 flex-1 flex-col gap-2">
          {c.map(render)}
        </div>
      ))}
    </div>
  );
}

/** One section's cards in the chosen layout; an expanded stack opens as a full-width panel after its card. */
function Cards({ entries, prefs, expanded, render, panel }: { entries: LibraryEntry[]; prefs: ViewPrefs; expanded: Set<string>; render: (e: LibraryEntry) => React.ReactNode; panel: (e: LibraryEntry) => React.ReactNode }) {
  if (prefs.layout === "list") return <div className="flex flex-col gap-0.5">{entries.flatMap((e) => (expanded.has(e.key) ? [render(e), panel(e)] : [render(e)]))}</div>;
  if (prefs.layout === "square") {
    const style = { "--card": `min(${prefs.size}px, calc(50vw - 22px))` } as React.CSSProperties;
    return (
      <div style={style} className="grid grid-cols-[repeat(auto-fill,minmax(var(--card),1fr))] gap-2">
        {entries.flatMap((e) => (expanded.has(e.key) ? [render(e), panel(e)] : [render(e)]))}
      </div>
    );
  }
  // Masonry: split at expanded stacks so their panels span the full width.
  const runs: LibraryEntry[][] = [[]];
  const panels: LibraryEntry[] = [];
  for (const e of entries) {
    runs.at(-1)!.push(e);
    if (expanded.has(e.key)) {
      panels.push(e);
      runs.push([]);
    }
  }
  return (
    <div className="space-y-2">
      {runs.map((run, i) => (
        <div key={i} className="space-y-2">
          {run.length > 0 && <Masonry entries={run} size={prefs.size} render={render} />}
          {panels[i] && panel(panels[i])}
        </div>
      ))}
    </div>
  );
}

function Inner({ starters: given }: { starters: StarterCardData[] }) {
  const routed = useSearchParams();
  // The params just set by go(): the History API hands them to useSearchParams in a transition, a frame later; shown at
  // once until the router has them.
  const [set, setSet] = useState<{ from: string; to: URLSearchParams } | null>(null);
  if (set && set.from !== routed.toString()) setSet(null);
  const sp = set && set.from === routed.toString() ? set.to : routed;
  const pathname = usePathname();
  const tab = TABS.find((t) => t.id === sp.get("tab")) ?? TABS[0];
  const folderId = sp.get("folder") ?? undefined;
  const trash = tab.id === "trash";
  const uploadsTab = tab.id === "uploads";
  // A guest or an account sees its own runs only; an account with neither its own GPU nor its own key can't add files yet.
  const visitor = useIsVisitor();
  const account = useIsAccount();
  const guest = useIsGuest() && visitor;
  const seen = useStatus().data?.viewer;
  const cantUpload = seen?.kind === "account" && !seen.gpu.connected && !seen.keys?.length;
  // Library → Shared: the share links, not results (no search, selection or filters there).
  const sharedTab = tab.id === "shared";
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 250);
  const [chosen, setFilters] = useState<Filters>(NO_FILTERS);
  const [prefs, setPrefs] = useViewPrefs();
  const folders = useFolders();
  const allFolders = useMemo(() => folders.data ?? [], [folders.data]);
  const folder = folderId ? allFolders.find((f) => f.id === folderId) : undefined;
  // The filters chosen stay across tabs and folders; the ones this view hides (Pinned and Show steps
  // in the Trash, Subfolders in a folder without any, all of them in Uploads) are off here.
  const filters = useMemo(() => filtersFor(chosen, { trash, uploads: uploadsTab, subfolders: !!folder?.folders }), [chosen, trash, uploadsTab, folder?.folders]);
  const facets = useLibraryFacets({ steps: filters.steps });
  const actions = useGenerationActions();
  const create = useCreateGeneration();

  // "Subfolders" on: the folder and every folder inside it.
  const subtree = useMemo(() => (folderId && filters.subfolders && folders.data ? folderAndDescendants(folders.data, folderId) : null), [folderId, filters.subfolders, folders.data]);
  const filter = useMemo<FeedFilter>(
    () => ({
      ...(tab.kinds && { kinds: tab.kinds }),
      ...(tab.id === "favorites" && { favorites: true }),
      // The Trash shows everything in it, helper steps too: deleting a Shorts session trashes its steps, and they can come back.
      ...(trash && { trashed: true, steps: true }),
      ...(folderId && !trash && (subtree ? { folderIds: subtree } : { folderId })),
      ...(dq && { q: dq }),
      ...filterFields(filters),
    }),
    [tab, trash, folderId, subtree, dq, filters],
  );
  // Pinned results sit above the rest of the view (not in the Trash or Uploads); the Pinned filter shows only them.
  const split = !trash && !uploadsTab && !sharedTab && !filters.pinned;
  const pinnedLib = useLibrary(useMemo(() => ({ ...filter, pinned: true, limit: 200 }), [filter]), { enabled: split });
  const lib = useLibrary(useMemo(() => (trash || uploadsTab ? filter : { ...filter, pinned: filters.pinned }), [filter, trash, uploadsTab, filters.pinned]), { enabled: !sharedTab });
  const shares = useShares();
  // A guest or an account (public sign-up): likes, pins and reviews of its own results, but no folders, share links,
  // Trash or skills here (they're the studio owner's). Left out until /api/auth/me says it's the owner, so a visitor
  // never sees them flash in and out.
  const owner = useIsOwner();
  // "Make your first": the covered starters the page carries, every one for the owner.
  const { starters } = useStarters("library", given);
  const shareApi = useShare();
  const share = owner ? shareApi : null;
  const builder = useSkillBuilder();
  const skillBuilder = owner ? builder : null;
  const uploads = useUploads();
  const pinnedItems = useMemo(() => (split ? (pinnedLib.data?.pages.flat() ?? []) : []), [split, pinnedLib.data]);
  const mainItems = useMemo(() => {
    if (!uploadsTab) return lib.data?.pages.flat() ?? [];
    // Uploads search by file name.
    const all = (uploads.data?.pages.flat() ?? []).map(uploadAsGeneration);
    return dq ? all.filter((g) => g.request.prompt?.toLowerCase().includes(dq.toLowerCase())) : all;
  }, [uploadsTab, uploads.data, lib.data, dq]);
  const items = useMemo(() => (pinnedItems.length ? [...pinnedItems, ...mainItems] : mainItems), [pinnedItems, mainItems]);
  const stacks = prefs.stacks && !trash && !uploadsTab;
  const entries = useStableEntries(useMemo(() => buildEntries(mainItems, { stacks }), [mainItems, stacks]));
  // Its own stack keys: a batch with pinned and unpinned members has a stack in both sections, expanded and selected apart.
  const pinnedEntries = useStableEntries(useMemo(() => buildEntries(pinnedItems, { stacks, prefix: "pinned:" }), [pinnedItems, stacks]));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const sections = useMemo(() => {
    const when = (e: LibraryEntry) => Math.max(...members(e).map((g) => (trash ? (g.deletedAt ?? g.createdAt) : g.createdAt)));
    const rest = prefs.splitByDate ? splitByDate(entries, when) : [{ key: 0, label: pinnedEntries.length ? "Everything else" : "", items: entries }];
    return pinnedEntries.length ? [{ key: -1, label: "Pinned", items: pinnedEntries }, ...rest] : rest;
  }, [entries, pinnedEntries, prefs.splitByDate, trash]);

  // --- Selection ---------------------------------------------------------------------------
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const mod = useModKey();
  const order = useMemo(() => sections.flatMap((s) => s.items.flatMap((e) => [e, ...(e.type === "stack" && expanded.has(e.key) ? e.items.map((g) => ({ type: "single" as const, key: g.id, g })) : [])])), [sections, expanded]);
  const latest = useRef({ order, selected, items });
  useEffect(() => {
    latest.current = { order, selected, items };
  });
  const lastKey = useRef<string | null>(null);
  const clear = useCallback(() => {
    setSelected(new Set());
    setSelecting(false);
  }, []);
  // A new tab or folder starts a new selection.
  const scope = `${tab.id}/${folderId ?? ""}`;
  const [lastScope, setLastScope] = useState(scope);
  if (lastScope !== scope) {
    setLastScope(scope);
    setSelected(new Set());
    setSelecting(false);
  }

  const selectedGens = useMemo(() => items.filter((g) => selected.has(g.id)), [items, selected]);

  // --- Viewer --------------------------------------------------------------------------------
  const [open, setOpen] = useState<{ id: string; index: number } | null>(null);
  const flat = useMemo(
    () =>
      order
        .flatMap((e) => members(e))
        .filter((g, i, all) => g.status === "succeeded" && g.outputs.length && all.findIndex((x) => x.id === g.id) === i)
        .flatMap((g) => (isLayered(g) ? [{ g, i: 0 }] : shownOutputs(g).map((i) => ({ g, i })))),
    [order],
  );
  const pos = open ? flat.findIndex((f) => f.g.id === open.id && (f.i === open.index || isLayered(f.g))) : -1;

  const api = useMemo<CardApi>(
    () => ({
      open: (g, index) => setOpen({ id: g.id, index }),
      expand: (key) =>
        setExpanded((s) => {
          const n = new Set(s);
          if (n.has(key)) n.delete(key);
          else n.add(key);
          return n;
        }),
      toggle: (key, list, shift) => {
        setSelecting(true);
        const { order, selected } = latest.current;
        const next = new Set(selected);
        if (shift && lastKey.current) {
          const a = order.findIndex((e) => e.key === lastKey.current);
          const b = order.findIndex((e) => e.key === key);
          if (a >= 0 && b >= 0) {
            for (const e of order.slice(Math.min(a, b), Math.max(a, b) + 1)) ids(e).forEach((id) => next.add(id));
            lastKey.current = key;
            setSelected(next);
            return;
          }
        }
        const all = list.every((id) => next.has(id));
        list.forEach((id) => (all ? next.delete(id) : next.add(id)));
        lastKey.current = key;
        setSelected(next);
      },
      dragIds: (list) => {
        const { selected } = latest.current;
        return list.every((id) => selected.has(id)) ? [...selected] : list;
      },
      retry: (g) => create.mutate(g.request, { onError: (e) => toastError(e) }),
      runner: { onOpen: (g, index) => setOpen({ id: g.id, index }) },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,textarea,[contenteditable],[role=dialog],[role=menu]")) return;
      if (e.key === "Escape" && (selecting || latest.current.selected.size)) {
        e.preventDefault();
        clear();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && (selecting || latest.current.selected.size)) {
        // In selection mode ⌘/Ctrl+A takes every result loaded under the filters (elsewhere it selects text as usual).
        e.preventDefault();
        setSelected(new Set(latest.current.items.map((g) => g.id)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting, clear]);

  // --- Paging ---------------------------------------------------------------------------------
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = uploadsTab ? uploads : lib;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver((es) => es.some((x) => x.isIntersecting) && !isFetchingNextPage && void fetchNextPage(), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const go = (params: Record<string, string | undefined>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(params)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const s = next.toString();
    setSet({ from: routed.toString(), to: next });
    // The page reads no search params on the server: the native History API updates the address with no request (a
    // router.replace waited a round trip before the tab moved), and useSearchParams follows.
    window.history.replaceState(null, "", s ? `${pathname}?${s}` : pathname);
    window.scrollTo({ top: 0 });
  };

  const moveTo = async (list: string[], folderIdTo: string | null, name: string) => {
    const gens = list.map((id) => latest.current.items.find((g) => g.id === id)).filter((g): g is Generation => !!g);
    if (!gens.length) return;
    const n = await actions.move(gens, folderIdTo);
    if (n) toast.success(folderIdTo ? `Moved ${n} to “${name}”` : `Took ${n} out of the folder`);
    clear();
  };

  const [newFolderFor, setNewFolderFor] = useState<string[] | null>(null);
  const confirmForever = useConfirmForever();
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  // A folder link whose folder is gone (deleted, or a stale link); while folders load, we don't know yet.
  const foldersLoading = !!folderId && !folders.data;
  const missingFolder = !!folderId && !!folders.data && !folder && !trash;

  // The tab strip scrolls sideways on phones: fade the hidden edge and keep the active tab in view.
  const tabsRef = useRef<HTMLElement>(null);
  const activeTab = useRef<HTMLButtonElement>(null);
  const focusTab = useRef(false);
  // Again once the counts load: tabs for kinds you have (Text, 3D) appear and shift the rest.
  const tabsReady = !!facets.data;
  useEffect(() => {
    activeTab.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
    if (focusTab.current) activeTab.current?.focus();
    focusTab.current = false;
  }, [tab.id, tabsReady]);

  const loading = uploadsTab ? uploads.isLoading : lib.isLoading;
  const refreshing = !uploadsTab && lib.isPlaceholderData;
  // The results fade in when another section's (or folder's) arrive, not while the last ones still show.
  const resultsRef = useSwapFade<HTMLDivElement>(refreshing ? null : `${tab.id}:${folderId ?? ""}`);
  const count = (t: (typeof TABS)[number]) => {
    const f = facets.data;
    if (!f) return undefined;
    if (t.id === "trash") return f.trash || undefined;
    if (t.id === "shared") return shares.data?.items.filter((x) => !x.gone && !isExpired(x)).length || undefined;
    if (t.id === "favorites") return f.favorites || undefined;
    if (t.kinds) return f.kinds[t.kinds[0]] || undefined;
    return undefined;
  };
  const visibleTabs = TABS.filter(
    (t) => !(!owner && (t.id === "shared" || t.id === "trash") && tab.id !== t.id) && (!t.kinds || t.id === "images" || t.id === "videos" || t.id === "audio" || (facets.data?.kinds[t.kinds[0]] ?? 0) > 0 || tab.id === t.id),
  );
  const allFav = selectedGens.length > 0 && selectedGens.every((g) => g.favorite);
  const allPinned = selectedGens.length > 0 && selectedGens.every((g) => g.pinnedAt);
  // The bulk bar's review menu checks a status only when every selected result has it.
  const sameReview = selectedGens.length && selectedGens.every((g) => (g.review ?? null) === (selectedGens[0].review ?? null)) ? (selectedGens[0].review ?? null) : undefined;
  // The bar's Like, Pin and Review (as buttons, or in ⋯ on phones).
  const like = () => void actions.favoriteMany(selectedGens, !allFav);
  const pinAll = () => void actions.pin(selectedGens, !allPinned).then((n) => n && toast(allPinned ? `Unpinned ${n}` : `Pinned ${n} to the top`));
  const review = (r: ReviewStatus | null) => void actions.review(selectedGens, r).then((n) => n && toast(r ? `Marked ${n} as ${reviewInfo(r)?.label}` : `Cleared the review status of ${n}`));

  const empty = () => {
    if (dq) {
      return (
        <Empty title={`No matches for “${dq}”`}>
          Try another word.{" "}
          <button onClick={() => setQ("")} className="text-brand-text underline underline-offset-2">
            Clear search
          </button>
        </Empty>
      );
    }
    if (filters.pinned && !dq) {
      return (
        <Empty title="Nothing pinned here yet">
          Pin results from their ⋯ menu (or select some and choose Pin) to keep them at the top.{" "}
          <button onClick={() => setFilters({ ...filters, pinned: false })} className="text-brand-text underline underline-offset-2">
            Show everything
          </button>
        </Empty>
      );
    }
    if (hasFilters(filters)) {
      return (
        <Empty title="Nothing matches your filters">
          <button onClick={() => setFilters(NO_FILTERS)} className="text-brand-text underline underline-offset-2">
            Clear filters
          </button>
        </Empty>
      );
    }
    if (trash) return <Empty title="Trash is empty">Generations you delete stay here for {TRASH_DAYS} days, then go for good.</Empty>;
    if (folder?.folders) {
      return (
        <Empty title="Nothing here directly">
          What&apos;s in this folder is in the folders above.{" "}
          <button onClick={() => setFilters({ ...filters, subfolders: true })} className="text-brand-text underline underline-offset-2">
            Show their results here
          </button>
        </Empty>
      );
    }
    if (folder) return <Empty title="This folder is empty">Drag cards onto it, or select some and choose Move to folder.</Empty>;
    if (tab.id === "favorites") return <Empty title="Nothing liked yet">Mark the ones you like with the heart to keep them here.</Empty>;
    if (uploadsTab && guest)
      return (
        <Empty title="No uploads yet">
          <Link href={signInHref("signup", "/library?tab=uploads")} className="text-brand-text underline underline-offset-2">
            Sign up free
          </Link>{" "}
          to add your own files.
        </Empty>
      );
    if (uploadsTab && cantUpload)
      return (
        <Empty title="No uploads yet">
          <Link href="/connect" className="text-brand-text underline underline-offset-2">
            Connect your GPU
          </Link>
          {/* "Add your fal.ai key" opens here, over the Library; a studio of open-source models only takes no keys. */}
          {seen.paidAllowed !== false && (
            <>
              {" "}
              or{" "}
              <button type="button" onClick={() => openAddKey("fal")} className="text-brand-text underline underline-offset-2">
                add a key
              </button>
            </>
          )}{" "}
          to add your own files.
        </Empty>
      );
    if (uploadsTab) return <Empty title="No uploads yet">Files you add to a studio show up here.</Empty>;
    // Nothing made yet: "Make your first" leads on All (a visitor's cards only those with their cover), then one quiet line.
    if (tab.id === "all" && starters.some((s) => starterShown(s, !owner)))
      return (
        <>
          <StarterSection surface="library" starters={given} />
          <p className="mt-8 text-center text-[14px] text-muted-foreground">
            Everything you make lands here.{" "}
            <Link href="/image" className="text-brand-text underline underline-offset-2">
              Create an image
            </Link>
          </p>
        </>
      );
    return (
      <Empty title="Your creations will appear here">
        Generate something and it lands here.{" "}
        <Link href="/image" className="text-brand-text underline underline-offset-2">
          Create an image
        </Link>
      </Empty>
    );
  };

  return (
    <PageShell wide>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 pb-5">
        {folder ? (
          <FolderHeader folder={folder} all={allFolders} steps={filters.steps} onGo={(f) => go({ folder: f?.id })} onMoveItems={(list, to) => void moveTo(list, to?.id ?? null, to?.name ?? "Library")} />
        ) : foldersLoading ? (
          <div className="flex min-w-0 flex-col gap-1.5" aria-busy="true" aria-label="Loading folder">
            <Skeleton className="h-7 w-28 rounded-full" />
            <Skeleton className="h-8 w-48 rounded-lg" />
          </div>
        ) : (
          <div className="min-w-0">
            <h1 className="font-heading text-[34px] leading-tight">Library</h1>
            <p className="mt-1 max-w-2xl text-[15px] text-muted-foreground">
              {/* A guest can't make anything yet; a studio of open-source models only takes no keys. */}
              {!visitor ? (
                "Everything you make, across cloud and open-source runs."
              ) : guest ? (
                <>
                  <Link href={signInHref("signup", "/library")} className="text-brand-text underline underline-offset-2">
                    Sign up free
                  </Link>{" "}
                  to keep what you make here.
                </>
              ) : account && seen?.paidAllowed !== false ? (
                "Everything you make, in one place."
              ) : (
                "Everything you make, in one place."
              )}
            </p>
          </div>
        )}
        <div className={cn("flex w-full items-center gap-2 sm:w-auto", sharedTab && "hidden")}>
          <div className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQ("")}
              placeholder={uploadsTab ? "Search file names" : "Search prompts"}
              aria-label="Search prompts"
              className="h-8 w-full rounded-full border bg-background pr-8 pl-8 text-[13px] outline-none focus:border-primary focus:ring-4 focus:ring-brand-faint"
            />
            {refreshing || (q.trim() !== dq && q.trim()) ? (
              <Loader2 className="absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
            ) : q ? (
              <button onClick={() => setQ("")} aria-label="Clear search" className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground">
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
          {!uploadsTab && (
            <button
              onClick={() => (selecting ? clear() : setSelecting(true))}
              // Named for what a press does, and with the word it shows ("Done" while selecting).
              aria-label={selecting ? "Done selecting" : "Select"}
              title={selecting ? "Done selecting" : "Select several"}
              className={cn(
                "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors",
                selecting ? "bg-brand-faint text-brand-text hover:bg-brand-faint-hover" : "bg-secondary text-secondary-foreground hover:bg-accent",
              )}
            >
              <CheckSquare className="size-3.5" /> <span className="hidden sm:inline">{selecting ? "Done" : "Select"}</span>
            </button>
          )}
          <ViewOptions prefs={prefs} onChange={setPrefs} />
        </div>
      </div>

      {!folder && !foldersLoading && !missingFolder && (
        <TabRow
          ref={tabsRef}
          role="tablist"
          aria-label="Library sections"
          className="mb-4"
          onKeyDown={(e) => {
            // Arrow keys move between tabs (and open them), as in any tab strip.
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
            const at = visibleTabs.findIndex((t) => t.id === tab.id);
            const next = visibleTabs[(at + (e.key === "ArrowRight" ? 1 : -1) + visibleTabs.length) % visibleTabs.length];
            e.preventDefault();
            focusTab.current = true;
            go({ tab: next.id === "all" ? undefined : next.id, folder: undefined });
          }}
        >
          {visibleTabs.map((t) => {
            const n = count(t);
            const on = tab.id === t.id;
            return (
              <button
                key={t.id}
                ref={on ? activeTab : undefined}
                role="tab"
                aria-selected={on}
                tabIndex={on ? 0 : -1}
                onClick={() => go({ tab: t.id === "all" ? undefined : t.id, folder: undefined })}
                className={TAB_PILL}
                {...onAttr(on)}
              >
                {t.label}
                {n ? (
                  <span className="tab-count min-w-4" aria-label={`${n} items`}>
                    {n}
                  </span>
                ) : null}
              </button>
            );
          })}
        </TabRow>
      )}

      {/* The folder row has its place from the first paint: arriving later, it pushed the filters and the cards down. */}
      {owner && ((tab.id === "all" && !folderId) || (folder && !trash)) ? (
        <div className="mb-4">
          {folders.data ? (
            <FolderStrip all={allFolders} parent={folder ?? null} steps={filters.steps} onOpen={(f) => go({ folder: f.id })} onMove={(list, f) => void moveTo(list, f.id, f.name)} />
          ) : (
            <div className="-mx-1 flex gap-2 overflow-hidden px-1 py-1" aria-busy="true" aria-label="Loading folders">
              <div className="flex w-[min(44vw,160px)] shrink-0 items-center gap-2.5 rounded-xl border border-dashed p-2">
                <Skeleton className="size-11 shrink-0 rounded-lg" />
                <Skeleton className="h-3 w-16" />
              </div>
            </div>
          )}
        </div>
      ) : null}

      {!uploadsTab && !sharedTab && !missingFolder && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <FilterBar value={filters} onChange={setFilters} facets={facets.data} subfolders={!!folder?.folders} scoped={!!folderId || tab.id !== "all" || !!dq} trash={trash} />
          {/* A chain made again and again, offered as a skill (All only; the owner's own runs). */}
          {tab.id === "all" && !folderId && !dq && <SkillSuggestions />}
          {trash && (
            <div className="flex items-center gap-3 text-[13px] text-muted-foreground">
              <span>Items stay here for {TRASH_DAYS} days.</span>
              {items.length > 0 && (
                <button onClick={() => setConfirmEmpty(true)} className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 font-medium text-destructive hover:bg-accent">
                  <Trash2 className="size-3.5" /> Empty trash
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div ref={resultsRef}>
      {sharedTab ? (
        <SharedLinks />
      ) : missingFolder ? (
        <Empty title="This folder no longer exists">
          It may have been deleted; what was in it is back in your Library.{" "}
          <button onClick={() => go({ folder: undefined })} className="text-brand-text underline underline-offset-2">
            Back to Library
          </button>
        </Empty>
      ) : loading && !items.length ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(200px,calc(50vw-22px)),1fr))] gap-2">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="aspect-square rounded-xl" />
          ))}
        </div>
      ) : !items.length ? (
        empty()
      ) : (
        <div className={cn("space-y-7 transition-opacity", refreshing && "opacity-70")}>
          {sections.map((s) => (
            <section key={s.key} aria-label={s.label || "Results"} className="group/section">
              {s.label && (
                <div className="mb-2.5 flex items-center gap-3">
                  <h2 className="flex items-center gap-1.5 text-[13px] font-medium">
                    {s.key === -1 && <Pin className="size-3.5 text-muted-foreground" />}
                    {s.label} <span className="font-mono text-[11px] font-normal text-muted-foreground">{s.items.reduce((n, e) => n + members(e).length, 0)}</span>
                  </h2>
                  {/* Select a whole day (or the pinned ones) at once; again to unselect them. */}
                  {!uploadsTab && (
                    <SectionSelect
                      label={s.label}
                      ids={s.items.flatMap(ids)}
                      selected={selected}
                      quiet={!selecting}
                      onToggle={(list) => {
                        setSelecting(true);
                        setSelected((cur) => toggleAll(cur, list));
                      }}
                    />
                  )}
                </div>
              )}
              <Cards
                entries={s.items}
                prefs={prefs}
                expanded={expanded}
                render={(e) => (
                  <AssetCard key={e.key} entry={e} layout={prefs.layout} fit={prefs.fit} selecting={selecting} selected={ids(e).every((id) => selected.has(id))} expanded={expanded.has(e.key)} api={api} />
                )}
                panel={(e) =>
                  e.type === "stack" && (
                    <div key={`${e.key}:open`} className={cn("rounded-2xl border bg-card p-3", prefs.layout === "square" && "col-span-full", prefs.layout === "list" && "my-1")}>
                      <div className="mb-2.5 flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="font-heading text-[19px] leading-snug">{e.title}</p>
                          <p className="text-[12px] text-muted-foreground">{e.label}</p>
                        </div>
                        <button onClick={() => api.expand(e.key)} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground">
                          <ChevronUp className="size-4" /> Collapse
                        </button>
                      </div>
                      <div className={cn(prefs.layout === "list" ? "flex flex-col gap-0.5" : "grid grid-cols-[repeat(auto-fill,minmax(min(170px,calc(50vw-40px)),1fr))] gap-2")}>
                        {e.items.map((g) => (
                          <AssetCard
                            key={g.id}
                            entry={singleEntry(g)}
                            layout={prefs.layout === "list" ? "list" : "square"}
                            fit={prefs.fit}
                            selecting={selecting}
                            selected={selected.has(g.id)}
                            api={api}
                          />
                        ))}
                      </div>
                    </div>
                  )
                }
              />
            </section>
          ))}
          <div ref={sentinel} className="flex flex-col items-center gap-2 py-4">
            {hasNextPage ? (
              <button
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
                className="inline-flex h-9 items-center gap-2 rounded-full bg-secondary px-4 text-[13px] font-medium hover:bg-accent disabled:opacity-60"
              >
                {isFetchingNextPage && <Loader2 className="size-3.5 animate-spin" />} Load more
              </button>
            ) : (
              <p className="text-[12px] text-muted-foreground">{items.length > 12 ? "That's everything" : ""}</p>
            )}
          </div>
        </div>
      )}
      </div>

      {(selecting || selected.size > 0) && !uploadsTab && !sharedTab && (
        <div className="pointer-events-none fixed inset-x-0 bottom-chrome z-30 flex justify-center px-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div role="toolbar" aria-label="Selection" className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-full border bg-background p-1.5 shadow-strong">
            {/* Phones show just the count, so every action fits at 390 px. */}
            <span className="shrink-0 px-2.5 text-[13px] font-medium whitespace-nowrap">
              {selectedGens.length ? (
                <>
                  {selectedGens.length}
                  <span className="hidden sm:inline"> selected</span>
                </>
              ) : (
                <>
                  Select<span className="hidden sm:inline"> items</span>
                </>
              )}
            </span>
            {/* Shown while any result in view is unselected (a search or filter can hide some of the selection). */}
            {items.some((g) => !selected.has(g.id)) && (
              <button
                onClick={() => setSelected(new Set(items.map((g) => g.id)))}
                className={cn(BAR, "text-brand-text")}
                aria-label={`Select all ${items.length}`}
                title={`Select all ${items.length} shown here (${keyCombo("A", { mod })})`}
              >
                <CheckCheck className="size-4" /> <span className="hidden sm:inline">Select all</span> <span className="font-mono text-[11px] tabular-nums">{items.length}</span>
              </button>
            )}
            {trash ? (
              <>
                <BarButton icon={ArchiveRestore} label="Restore" disabled={!selectedGens.length} onClick={() => void actions.restore(selectedGens).then((n) => (n && toast(`Restored ${n}`), clear()))} />
                <BarButton icon={Trash2} label="Delete forever" destructive disabled={!selectedGens.length} onClick={() => confirmForever?.(selectedGens, clear)} />
              </>
            ) : (
              <>
                <BarButton
                  icon={Download}
                  label="Download"
                  disabled={!selectedGens.some((g) => g.status === "succeeded")}
                  onClick={async () => {
                    const done = selectedGens.filter((g) => g.status === "succeeded").map((g) => g.id);
                    // A signed-in account zips its own runs, fewer at a time, one zip at a time. It asks first, so a refusal is said, not a failed download.
                    const max = account && !owner ? ACCOUNT_ZIP_MAX_RUNS : BULK_MAX;
                    if (!(await downloadZip(`/api/generations/zip?ids=${done.slice(0, max).join(",")}`))) return;
                    if (done.length > max) toast(`The zip has the first ${max} of ${done.length}`, { description: "Select the rest and download them as a second zip." });
                  }}
                />
                {/* The steps behind the selected results as a skill (a whole stack when its batch is selected). Stays on phones. */}
                {skillBuilder && (
                  <BarButton
                    icon={BookmarkPlus}
                    label="Make a skill"
                    disabled={!selectedGens.some((g) => g.status === "succeeded")}
                    onClick={() => skillBuilder.open(selectedGens.filter((g) => g.status === "succeeded").map((g) => g.id))}
                  />
                )}
                {/* Like, Pin and Review fold into ⋯ on phones, so the bar fits 390 px with Publish. */}
                <BarButton icon={Heart} label={allFav ? "Unlike" : "Like"} disabled={!selectedGens.length} onClick={like} className="max-sm:hidden" />
                <BarButton icon={allPinned ? PinOff : Pin} label={allPinned ? "Unpin" : "Pin"} disabled={!selectedGens.length} onClick={pinAll} className="max-sm:hidden" />
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild disabled={!selectedGens.length}>
                    <button className={cn(BAR, "max-sm:hidden")} disabled={!selectedGens.length} aria-label="Review status" title="Review status">
                      <CircleDot className="size-4" /> <span className="hidden sm:inline">Review</span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="center" collisionPadding={12} className="min-w-44">
                    <ReviewMenuItems value={sameReview} onPick={review} />
                  </DropdownMenuContent>
                </DropdownMenu>
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild disabled={!selectedGens.length}>
                    <button className={cn(BAR, "sm:hidden")} disabled={!selectedGens.length} aria-label="Like, pin or review" title="Like, pin or review">
                      <MoreHorizontal className="size-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="center" collisionPadding={12} className="min-w-44">
                    <DropdownMenuItem onSelect={like}>
                      <Heart /> {allFav ? "Unlike" : "Like"}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={pinAll}>
                      {allPinned ? <PinOff /> : <Pin />} {allPinned ? "Unpin" : "Pin to the top"}
                    </DropdownMenuItem>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <CircleDot /> Review status
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="min-w-44">
                        <ReviewMenuItems value={sameReview} onPick={review} />
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  </DropdownMenuContent>
                </DropdownMenu>
                {share && (
                  <BarButton
                    icon={Globe}
                    label="Publish"
                    disabled={!selectedGens.some((g) => g.status === "succeeded")}
                    onClick={() => share.publish(selectedGens.filter((g) => g.status === "succeeded"))}
                  />
                )}
                {owner && (
                  <>
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild disabled={!selectedGens.length}>
                        <button className={BAR} disabled={!selectedGens.length} aria-label="Move to">
                          <FolderInput className="size-4" /> <span className="hidden sm:inline">Move to</span>
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent side="top" align="center" collisionPadding={12}>
                        <MoveMenuItems folders={folders.data ?? []} current={folderId} onMove={(fid, name) => void moveTo([...selected], fid, name)} onNew={() => setNewFolderFor([...selected])} />
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <BarButton
                      icon={Trash2}
                      label="Move to Trash"
                      destructive
                      disabled={!selectedGens.length}
                      onClick={() => {
                        void actions.trash(selectedGens);
                        clear();
                      }}
                    />
                  </>
                )}
                {/* An account has no Trash: what it deletes goes for good, so it says so and asks first. */}
                {account && !owner && !uploadsTab && (
                  <BarButton
                    icon={Trash2}
                    label="Delete for good…"
                    destructive
                    disabled={!selectedGens.some((g) => g.feature !== "upload")}
                    onClick={() => askDeleteForGood(selectedGens.filter((g) => g.feature !== "upload"), clear)}
                  />
                )}
              </>
            )}
            <span className="mx-1 h-5 w-px shrink-0 bg-border" />
            <button onClick={clear} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] whitespace-nowrap text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Unselect all, Esc" aria-keyshortcuts="Escape">
              <X className="size-3.5" /> <span className="hidden sm:inline">Unselect all</span> <Kbd className="hidden sm:inline-flex">Esc</Kbd>
            </button>
          </div>
        </div>
      )}

      {newFolderFor && (
        <FolderDialog
          parent={folder ?? null}
          open
          onOpenChange={(v) => !v && setNewFolderFor(null)}
          onSaved={(f) => {
            void moveTo(newFolderFor, f.id, f.name);
            setNewFolderFor(null);
          }}
        />
      )}

      <AlertDialog open={confirmEmpty} onOpenChange={setConfirmEmpty}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Empty the Trash?</AlertDialogTitle>
            <AlertDialogDescription>Everything in it, including what your filters hide, is deleted with its files and can&apos;t be recovered.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                void actions.emptyTrash().then(() => toast("Trash emptied"));
              }}
            >
              Empty trash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {open && pos >= 0 && (
        <Viewer
          generation={flat[pos].g}
          index={isLayered(flat[pos].g) ? open.index : flat[pos].i}
          onIndex={(index) => setOpen({ id: flat[pos].g.id, index })}
          onClose={() => setOpen(null)}
          onPrev={pos > 0 ? () => setOpen({ id: flat[pos - 1].g.id, index: flat[pos - 1].i }) : undefined}
          onNext={pos < flat.length - 1 ? () => setOpen({ id: flat[pos + 1].g.id, index: flat[pos + 1].i }) : undefined}
        />
      )}
    </PageShell>
  );
}

/** A date header's "Select" / "Unselect": shown on hover from a mouse, always while selecting or on touch. */
function SectionSelect({ label, ids, selected, quiet, onToggle }: { label: string; ids: string[]; selected: ReadonlySet<string>; quiet: boolean; onToggle: (ids: string[]) => void }) {
  const all = ids.length > 0 && ids.every((id) => selected.has(id));
  return (
    <button
      type="button"
      onClick={() => onToggle(ids)}
      aria-label={`${all ? "Unselect" : "Select"} ${label}, ${ids.length}`}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-full px-2 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        quiet && "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/section:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100",
      )}
    >
      {all ? "Unselect" : "Select"}
    </button>
  );
}

// Phones: a little narrower, so the bar keeps every action (and Select all) at 390 px.
const BAR = "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40 max-sm:px-2";

function BarButton({ icon: Icon, label, onClick, disabled, destructive, className }: { icon: typeof Download; label: string; onClick: () => void; disabled?: boolean; destructive?: boolean; className?: string }) {
  return (
    <button onClick={onClick} disabled={disabled} aria-label={label} title={label} className={cn(BAR, destructive && "text-destructive", className)}>
      <Icon className="size-4" /> <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

/** starters: "Make your first" under an empty Library (catalog cards, from the page). */
export function LibraryView({ starters = [] }: { starters?: StarterCardData[] }) {
  return (
    <Suspense fallback={null}>
      <ForeverConfirmProvider>
        <UploadDeleteProvider>
          <Inner starters={starters} />
        </UploadDeleteProvider>
      </ForeverConfirmProvider>
    </Suspense>
  );
}
