"use client";

import { Bot, ChevronLeft, Clapperboard, Copy, FileText, Folder, FolderOpen, FolderTree, Heart, Library, MoreHorizontal, Pin, PinOff, Settings2, Share2, Upload } from "lucide-react";
import { nanoid } from "nanoid";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { ErrorState, NotFoundState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PhoneNavButton } from "@/components/nav/phone-nav-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EngineSwitch } from "@/components/studio/engine-switch";
import type { PromptInputHandle } from "@/components/studio/prompt-input";
import { useElements, useEngine, useIsOwner, useSaveElement } from "@/lib/api";
import { rigError, type CinemaFolder, type DirectorSettings, type DirectorShot } from "@/lib/catalog/cinema";
import type { StudioElement } from "@/lib/catalog/elements";
import type { OutputFile } from "@/lib/catalog/types";
import { cn } from "@/lib/utils";
import { copyWithToast } from "@/lib/clipboard";
import { toastError } from "@/lib/refusals";
import { CinemaFeed, type FeedHandlers } from "./cinema-feed";
import { initialDraft, type CinemaDraft } from "./draft";
import { ElementsPanel } from "./elements-panel";
import { FolderSidebar, subtree, viewKey, type CinemaView } from "./folder-sidebar";
import { mediaDuration } from "./media";
import { formatUsd } from "./money";
import { foreign, useAutosave, useCinemaGenerate, useCinemaItems, useCinemaProject, useDirectorChat, useItemActions, useStudioGenerations, useUpdateProject, type CinemaGeneration, type ProjectView } from "./hooks";
import { cutGrid } from "./media";
import { ProjectDialog } from "./project-settings";
import { useShare } from "@/components/share/share-provider";
import { PromptBar, useAddRefs } from "./prompt-bar";
import { SceneCreateDialog, askSceneConfirmAgain, sceneTake, skipSceneConfirm, usePlanPrice, useScenePlan, type SceneTake } from "./scene-actions";
import { SidePanel } from "./side-panel";
import { SoulCastDialog, SoulLocationDialog } from "./soul-builders";
import { BlockoutPanel, initialBlockout, withBuilt, type BlockoutDraft } from "./blockout-panel";
import { WorldPanel } from "./world-panel";
import type { BlockoutScene } from "@/lib/blockout";

/** What a browser that can only write WebM is told: Seedance 2.5 takes MP4 or MOV reference clips. */
const WEBM_BLOCKOUT = "This browser saved the blockout as WebM, which Seedance 2.5 doesn't take: render it in Chrome or Edge, upload an MP4 from your 3D app, or film it on your GPU.";

/** The blockout builder (three.js) loads when it opens. */
const BlockoutBuilder = dynamic(() => import("./blockout-builder"), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#161617] text-[14px] text-white" role="status">
      Opening the blockout builder…
    </div>
  ),
});

/** The 3D viewer (and three.js inside it) loads when a scene is opened. */
const SceneViewer = dynamic(() => import("./scene-viewer"), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#0b0b0c] text-[14px] text-white" role="status">
      Opening the 3D scene…
    </div>
  ),
});

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Grid contact sheets are cut into tiles in the browser once, then saved with the take. */
const cutting = new Set<string>();
function useGridTiles(projectId: string, items: CinemaGeneration[]) {
  const actions = useItemActions(projectId);
  useEffect(() => {
    for (const g of items) {
      const sheet = g.outputs[0];
      if (g.feature !== "cinema-grid" || g.status !== "succeeded" || g.tiles?.length || g.outputs.length !== 1 || sheet?.kind !== "image" || cutting.has(g.id)) continue;
      cutting.add(g.id);
      const m = /(\d)×(\d) grid/.exec(g.prompt ?? "");
      const size = g.take?.grid?.size ?? (m ? `${m[1]}x${m[2]}` : "2x2");
      const n = Number(size[0]) || 2;
      void cutGrid(sheet.url, n, n)
        .then((tiles) => actions.saveTiles(g.id, tiles))
        .catch(() => toast.error("Couldn't cut the grid into tiles — open the sheet to use it whole"));
    }
  }, [items, actions]);
}

/** A name to start from when a still is saved as an element ("Rainy Rooftop Bar"). */
function nameFrom(prompt: string | undefined, fallback: string): string {
  const words = (prompt ?? "").replace(/@\S+/g, "").replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !/^(the|and|with|from|who|shot|wide|close|establishing|film|location)$/i.test(w));
  return words.slice(0, 3).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ") || fallback;
}

/** Any still prices "Create 3D scene" the same: the menu shows it before one is picked. */
const ANY_STILL = "/api/files/placeholder.png";

const DRAFT_KEY = (id: string) => `fuobe.cinema.draft.${id}`;
const KEPT = ["mode", "imageTool", "prompt", "moves", "models", "duration", "resolution", "aspect", "batch", "audio", "multiShot", "grid"] as const;

function restoreDraft(id: string): CinemaDraft {
  const base = initialDraft();
  try {
    const raw = localStorage.getItem(DRAFT_KEY(id));
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<CinemaDraft>;
    const kept = Object.fromEntries(KEPT.filter((k) => saved[k] !== undefined).map((k) => [k, saved[k]]));
    return { ...base, ...kept };
  } catch {
    return base;
  }
}

function saveDraft(id: string, d: CinemaDraft) {
  try {
    localStorage.setItem(DRAFT_KEY(id), JSON.stringify(Object.fromEntries(KEPT.map((k) => [k, d[k]]))));
  } catch {}
}

function folderPath(folders: CinemaFolder[], id: string): CinemaFolder[] {
  const out: CinemaFolder[] = [];
  let cur = folders.find((f) => f.id === id);
  while (cur && out.length < 12) {
    out.unshift(cur);
    cur = cur.parentId ? folders.find((f) => f.id === cur!.parentId) : undefined;
  }
  return out;
}

function Empty({ icon: Icon, title, text }: { icon: typeof Clapperboard; title: string; text: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center py-[10vh] text-center">
      <div className="grid size-12 place-items-center rounded-2xl bg-brand-faint text-brand-text">
        <Icon className="size-5" />
      </div>
      <p className="mt-4 font-heading text-[22px] leading-tight">{title}</p>
      <p className="mt-1 text-[13.5px] text-muted-foreground">{text}</p>
    </div>
  );
}

export function CinemaWorkspace({ id }: { id: string }) {
  const project = useCinemaProject(id);
  const items = useCinemaItems(id);
  if (project.isLoading)
    return (
      <div className="flex h-content flex-col">
        <div className="flex h-14 items-center gap-3 border-b px-4">
          <Skeleton className="h-6 w-48" />
        </div>
        <div className="flex flex-1">
          <div className="hidden w-60 space-y-2 border-r p-3 lg:block">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-7" />
            ))}
          </div>
          <div className="grid flex-1 grid-cols-2 content-start gap-3 p-6 sm:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="aspect-square rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    );
  if (!project.data) {
    // A project that isn't there gets the shared 404 state; a request that failed otherwise can be retried.
    if (project.error && !/not found/i.test(project.error.message)) return <ErrorState error={project.error} retry={() => void project.refetch()} />;
    return <NotFoundState title="This project doesn’t exist">It may have been deleted. Its takes are still in your library.</NotFoundState>;
  }
  return <Workspace data={project.data} items={items.data ?? []} loading={items.isLoading} />;
}

/**
 * /cinema/<id>?shot=<n> (a project made from a starter): the AI Director's proposed shot n goes into the prompt bar once
 * the chat is in (`onLoad` gets it and how many shots there are), and the address drops that parameter (keeping any
 * other), so a reload keeps what the person changed since.
 */
function LoadProposedShot({ projectId, n, onLoad }: { projectId: string; n: number; onLoad: (s: DirectorShot, of: number) => void }) {
  const router = useRouter();
  const params = useSearchParams();
  const { messages, loading } = useDirectorChat(projectId);
  const done = useRef(false);
  useEffect(() => {
    if (done.current || loading) return;
    done.current = true;
    const shots = messages.findLast((m) => m.role === "assistant" && m.shots?.length)?.shots ?? [];
    if (shots[n - 1]) onLoad(shots[n - 1], shots.length);
    const rest = new URLSearchParams(params.toString());
    rest.delete("shot");
    const q = rest.toString();
    router.replace(`/cinema/${projectId}${q ? `?${q}` : ""}`, { scroll: false });
  }, [loading, messages, n, onLoad, params, projectId, router]);
  return null;
}

/** The empty project's line once a starter's shot 1 is in the prompt bar: where the other shots are. */
function proposedLine(of: number) {
  const rest = of === 2 ? "Shot 2 is" : of === 3 ? "Shots 2 and 3 are" : `Shots 2 to ${of} are`;
  return `Shot 1 of ${of} is ready below. ${rest} in the AI Director.`;
}

function Workspace({ data, items, loading }: { data: ProjectView; items: CinemaGeneration[]; loading: boolean }) {
  const { project, folders, spentUsd, context } = data;
  const id = project.id;
  const router = useRouter();
  // Sharing a project and saving elements keep to the studio's library: the owner's only. A signed-in account's project
  // is its own, with everything else here.
  const owner = useIsOwner();
  const shareApi = useShare();
  const share = owner ? shareApi : null;
  const [engine, setEngine, engineMode] = useEngine();
  const [view, setView] = useState<CinemaView>({ kind: "home" });
  const [nested, setNested] = useState(true);
  const [draft, setDraftState] = useState<CinemaDraft>(() => restoreDraft(id));
  // The unsent prompt and its settings survive a reload (this browser only).
  useEffect(() => {
    const t = setTimeout(() => saveDraft(id, draft), 400);
    return () => clearTimeout(t);
  }, [id, draft]);
  const setDraft = (patch: Partial<CinemaDraft> | ((d: CinemaDraft) => Partial<CinemaDraft>)) => setDraftState((d) => ({ ...d, ...(typeof patch === "function" ? patch(d) : patch) }));
  const [settings, setSettings] = useState<DirectorSettings>(project.director);
  const update = useUpdateProject(id);
  // Director settings save per project a moment after the last change, and at once when the
  // workspace goes away (another page, a closed tab): the last pick is never dropped.
  const settingsSaver = useAutosave<DirectorSettings>(
    (director, { keepalive }) => update.mutate({ director, keepalive }, { onError: (e) => toastError(e) }),
    500,
  );
  // The last lighting the server would accept: a custom rig being edited into an invalid state isn't saved.
  const savedLighting = useRef(project.director.lighting ?? null);
  const onSettings = (patch: Partial<DirectorSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    const lighting = next.lighting ?? null;
    const invalid = lighting?.kind === "custom" && !!rigError(lighting.lights);
    if (!invalid) savedLighting.current = lighting;
    settingsSaver.schedule(invalid ? { ...next, lighting: savedLighting.current } : next);
  };
  const elements = useElements().data ?? [];
  const xl = useMedia("(min-width: 1280px)");
  const [panel, setPanel] = useState<"director" | "brief" | null>(null);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [castOpen, setCastOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Blockout to film: the composer's panel (its draft kept while the project is open) and the builder.
  // /cinema/<id>?blockout=1 (a link to Blockout to film) opens it.
  const search = useSearchParams();
  // A starter's film: how many shots the AI Director proposed, once shot 1 is in the prompt bar.
  const [starterShots, setStarterShots] = useState(0);
  const [blockoutOpen, setBlockoutOpen] = useState(() => search.get("blockout") === "1");
  // World mode: /cinema/<id>?world=1 (the GPU board's World mode row) opens it. Hidden when the engine mode is "Paid APIs
  // only": Hy-Nomas runs on your GPU alone.
  const [worldOpen, setWorldOpen] = useState(() => search.get("world") === "1");
  const [blockout, setBlockout] = useState<BlockoutDraft>(initialBlockout);
  const [builder, setBuilder] = useState<BlockoutScene | null>(null);
  const [dropping, setDropping] = useState(false);
  const promptRef = useRef<PromptInputHandle>(null);
  const studio = useStudioGenerations(id, view.kind === "studio");
  const actions = useItemActions(id);
  const saveElement = useSaveElement();
  const addRefs = useAddRefs((fn) => setDraft(fn));
  useGridTiles(id, items);

  // 3D scenes: "Create 3D scene" on a still (priced, asks first), the viewer, and a toast when one is built.
  const generate = useCinemaGenerate(id);
  const [sceneFrom, setSceneFrom] = useState<{ g: CinemaGeneration; url: string } | null>(null);
  const [openScene, setOpenScene] = useState<SceneTake | null>(null);
  const sceneCtx = useMemo(() => ({ engine, settings, context, brief: project.brief.body }), [engine, settings, context, project.brief.body]);
  const scenePrice = usePlanPrice(useScenePlan(ANY_STILL, undefined, sceneCtx)).label;
  const scenePlan = useScenePlan(sceneFrom?.url ?? null, sceneFrom?.g.request.params?.aspectRatio, sceneCtx);
  const building = useRef(new Set<string>());
  /** `asked` = false when "Don't ask again" skipped the dialog: the toast then names the price and can undo that. */
  const createScene = (g: CinemaGeneration, url: string, asked = true) => {
    setSceneFrom(null);
    generate.mutate(
      {
        input: { engine, mode: "image", action: "scene", prompt: "", settings, source: { url, kind: "image" }, aspectRatio: g.request.params?.aspectRatio },
        folderId: foreign(g, id) ? null : g.folderId,
      },
      {
        onSuccess: (r) => {
          r.items.forEach((x) => building.current.add(x.id));
          toast(engine === "open" ? "Building the 3D scene on your ComfyUI…" : "Building the 3D scene…", {
            description: `${asked ? "" : `${scenePrice} · `}It appears next to the still; you'll get a note when it's ready.`,
            duration: asked ? 3000 : 6000,
            ...(asked ? {} : { action: { label: "Ask first", onClick: askSceneConfirmAgain } }),
          });
        },
        onError: (e) => toastError(e),
      },
    );
  };
  useEffect(() => {
    for (const gid of [...building.current]) {
      const g = items.find((x) => x.id === gid);
      if (!g || g.status === "queued" || g.status === "running") continue;
      building.current.delete(gid);
      const t = sceneTake(g);
      if (t) toast.success("Your 3D scene is ready", { action: { label: "Open", onClick: () => setOpenScene(t) }, duration: 8000 });
      else toast.error(`The 3D scene couldn't be built${g.error ? `: ${g.error}` : ""}`);
    }
  }, [items]);

  const currentView: CinemaView = useMemo(() => (view.kind === "folder" && !folders.some((f) => f.id === view.id) ? { kind: "home" } : view), [view, folders]);
  const folderId = currentView.kind === "folder" ? currentView.id : null;
  const shown = useMemo(() => {
    switch (currentView.kind) {
      case "favorites":
        return items.filter((g) => g.favorite);
      case "studio":
        return studio.data ?? [];
      case "folder": {
        const set = nested ? subtree(folders, currentView.id) : new Set([currentView.id]);
        return items.filter((g) => g.folderId && set.has(g.folderId));
      }
      default:
        return items;
    }
  }, [currentView, items, studio.data, folders, nested]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of items) if (g.folderId) m.set(g.folderId, (m.get(g.folderId) ?? 0) + 1);
    return { home: items.length, favorites: items.filter((g) => g.favorite).length, folders: m };
  }, [items]);

  const focusPrompt = () => requestAnimationFrame(() => promptRef.current?.focus());
  const handlers: FeedHandlers = {
    onLoad: (g) => {
      const t = g.take;
      setDraft((d) => ({
        mode: t?.mode ?? (g.kind === "image" ? "image" : "video"),
        imageTool: t?.action === "grid" ? "grid" : "still",
        prompt: t?.prompt ?? g.request.prompt ?? "",
        moves: t?.moves ?? [],
        grid: t?.grid ?? d.grid,
        source: null,
        action: "generate",
      }));
      toast("Loaded into the prompt bar", { duration: 1500 });
      focusPrompt();
    },
    onUseTake: (g, o: OutputFile) => {
      const p = g.request.params;
      setDraft({
        mode: "video",
        source: {
          generationId: g.id,
          url: o.url,
          kind: "video",
          label: g.take?.prompt || g.request.prompt || "Take",
          // What an edit needs to know: the take's model (a partner take goes to a partner editor), its scene, size and length.
          modelId: g.modelId,
          prompt: g.take?.prompt || g.request.prompt || undefined,
          resolution: p?.resolution,
          aspectRatio: p?.aspectRatio,
        },
        action: "extend-forward",
      });
      // Its length, read from the file's header (a 20 s take plus its extend is one file).
      void mediaDuration(o.url, "video").then((seconds) => {
        if (Number.isFinite(seconds) && seconds > 0) setDraft((d) => (d.source?.url === o.url ? { source: { ...d.source, seconds } } : {}));
      });
      focusPrompt();
    },
    onAnimate: (url) => {
      setDraft((d) => ({ mode: "video", source: null, action: "generate", refs: [{ id: nanoid(6), ref: url, preview: url, kind: "image" }, ...d.refs.filter((r) => r.ref !== url)] }));
      toast("Start frame set", { duration: 1500 });
      focusPrompt();
    },
    onReference: (url, kind) => {
      setDraft((d) => (d.refs.some((r) => r.ref === url) ? {} : { refs: [...d.refs, { id: nanoid(6), ref: url, preview: url, kind }] }));
      toast("Added to references", { duration: 1500 });
    },
    onSaveElement: !owner
      ? undefined
      : (g, url, kind) =>
      saveElement.mutate(
        { name: nameFrom(g.take?.prompt ?? g.request.prompt, kind === "character" ? "New character" : "New location"), kind, references: [url] },
        {
          onSuccess: (el) => toast.success(`Saved as @${el.handle}`, { action: { label: "Open", onClick: () => router.push(`/elements/${el.id}`) } }),
          onError: (e) => toastError(e),
        },
      ),
    onCreateScene: (g, url) => (skipSceneConfirm(scenePrice) ? createScene(g, url, false) : setSceneFrom({ g, url })),
    onOpenScene: (g) => {
      const t = sceneTake(g);
      if (t) setOpenScene(t);
      else toast("This 3D scene isn't ready yet");
    },
    scenePrice,
  };
  const onLoadShot = (shot: DirectorShot) => {
    setDraft({ mode: "video", prompt: shot.prompt, moves: shot.moves, exact: null, duration: shot.duration, source: null, action: "generate", multiShot: { mode: "off", shots: [] } });
    if (Object.keys(shot.settings).length) onSettings(shot.settings);
    toast("Shot loaded — review it, then press Generate", { duration: 2500 });
    if (!xl) setPanel(null);
    focusPrompt();
  };
  const mention = (el: StudioElement) => {
    setDraft((d) => ({ prompt: `${d.prompt.trim()}${d.prompt.trim() ? " " : ""}@${el.handle} ` }));
    focusPrompt();
  };

  const path = currentView.kind === "folder" ? folderPath(folders, currentView.id) : [];
  const title = (
    <div className="flex min-w-0 items-baseline gap-2">
      <h2 className="flex min-w-0 items-center gap-1.5 truncate font-heading text-[24px] leading-none">
        {currentView.kind === "folder" ? (
          path.map((f, i) => (
            <span key={f.id} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && <span className="text-muted-foreground">/</span>}
              {i === path.length - 1 && <span className="size-2.5 shrink-0 rounded-full border" style={f.color ? { background: f.color, borderColor: f.color } : undefined} />}
              <button type="button" onClick={() => setView({ kind: "folder", id: f.id })} className={cn("truncate", i < path.length - 1 && "text-muted-foreground hover:text-foreground")}>
                {f.name}
              </button>
            </span>
          ))
        ) : currentView.kind === "studio" ? (
          "My Generations"
        ) : currentView.kind === "favorites" ? (
          "My Favorites"
        ) : (
          "Home"
        )}
      </h2>
      <span className="shrink-0 font-mono text-[12px] text-muted-foreground">{shown.length}</span>
    </div>
  );
  const empty =
    currentView.kind === "favorites" ? (
      <Empty icon={Heart} title="No favorites yet" text="Like your generations and they will appear here." />
    ) : currentView.kind === "studio" ? (
      <Empty icon={Library} title="No generations yet" text="Everything you make in Cinema Studio, in any project, shows up here." />
    ) : currentView.kind === "folder" ? (
      <Empty icon={FolderOpen} title="An empty scene" text="Describe a scene below and hit Generate — new takes land in this folder." />
    ) : starterShots > 1 ? (
      <Empty icon={Clapperboard} title="Your first shot" text={proposedLine(starterShots)} />
    ) : (
      <Empty icon={Clapperboard} title="Your first shot" text="Start by describing a scene and pressing “Generate”. Set the genre, camera, palette and light in the Director's Panel." />
    );

  const sidebar = (
    <FolderSidebar
      projectId={id}
      folders={folders}
      view={currentView}
      setView={(v) => {
        setView(v);
        setFoldersOpen(false);
      }}
      counts={counts}
      onDropItems={(ids, f) => void actions.move(ids, f).then(() => toast(`Moved ${ids.length} take${ids.length > 1 ? "s" : ""}`, { duration: 1500 }))}
      elements={owner}
      className="h-full"
    />
  );
  const sidePanel = panel && (
    <SidePanel project={project} tab={panel} setTab={setPanel} onClose={() => setPanel(null)} onLoadShot={onLoadShot} promptText={draft.prompt} />
  );
  const builderProps = { projectId: id, folderId, engine, settings, context, brief: project.brief.body, canSave: owner };
  const proposedShot = Number(search.get("shot")) || 0;

  return (
    <div className="flex h-content min-w-0 flex-col">
      {proposedShot > 0 && (
        <LoadProposedShot
          projectId={id}
          n={proposedShot}
          onLoad={(s, of) => {
            onLoadShot(s);
            setStarterShots(of);
            // On a wide screen the AI Director shows the other shots beside the work.
            if (xl) setPanel("director");
          }}
        />
      )}
      <header className="flex h-14 shrink-0 items-center gap-1.5 border-b px-2 sm:gap-2 sm:px-4">
        <Tooltip>
          <TooltipTrigger asChild>
            <Link href="/cinema" className="hidden size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground sm:grid" aria-label="All projects">
              <ChevronLeft className="size-4" />
            </Link>
          </TooltipTrigger>
          <TooltipContent>All projects</TooltipContent>
        </Tooltip>
        {/* Scenes (folders) open as a sheet below lg: a folder icon, unlike the app sidebar's panel icon next to it. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setFoldersOpen(true)}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground lg:hidden"
              aria-label="Scenes and folders"
            >
              <FolderTree className="size-4" /> <span className="hidden sm:inline">Scenes</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>Scenes, favorites and elements</TooltipContent>
        </Tooltip>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-heading text-[20px] leading-tight sm:text-[22px]">{project.name}</h1>
          <p className="hidden truncate text-[11.5px] text-muted-foreground sm:block">
            Cinema Studio
            {project.description ? ` · ${project.description}` : ""}
            {spentUsd > 0 || project.costCapUsd != null ? ` · ≈ ${formatUsd(spentUsd)} spent` : ""}
            {project.costCapUsd != null ? ` of ${formatUsd(project.costCapUsd)}` : ""}
          </p>
        </div>
        {/* Icons only on phones (labels from sm up), so the project name keeps its room. */}
        <EngineSwitch value={engine} onChange={setEngine} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={panel === "director" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setPanel((p) => (p === "director" ? null : "director"))}
              aria-pressed={panel === "director"}
              aria-label="AI Director"
              className="shrink-0 max-sm:size-8 max-sm:px-0"
            >
              <Bot /> <span className="hidden sm:inline">AI Director</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Break a script into shots, pick the camera, write prompts</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant={panel === "brief" ? "secondary" : "ghost"} size="icon-sm" onClick={() => setPanel((p) => (p === "brief" ? null : "brief"))} aria-pressed={panel === "brief"} aria-label="Project brief" className="shrink-0 max-sm:hidden">
              <FileText />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Project brief — prepended to every prompt</TooltipContent>
        </Tooltip>
        {share && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={() => share.share({ kind: "cinema", id, title: project.name })} aria-label="Share a read-only link" className="shrink-0 max-sm:hidden">
                <Share2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Share a read-only link to the project&apos;s takes</TooltipContent>
          </Tooltip>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Project menu" className="shrink-0">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setSettingsOpen(true)}>
              <Settings2 /> Project settings
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setPanel("brief")}>
              <FileText /> Project brief
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => update.mutate({ pinned: !project.pinned })}>
              {project.pinned ? <PinOff /> : <Pin />} {project.pinned ? "Unpin project" : "Pin project"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => void copyWithToast(window.location.href, "Link copied")}
            >
              <Copy /> Copy link
            </DropdownMenuItem>
            {share && (
              <DropdownMenuItem onClick={() => share.share({ kind: "cinema", id, title: project.name })}>
                <Share2 /> Share read-only link…
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/cinema">
                <Folder /> All projects
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <PhoneNavButton />
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-60 shrink-0 border-r bg-sidebar/40 lg:block">{sidebar}</aside>
        <div
          className="relative flex min-w-0 flex-1 flex-col"
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDropping(true);
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setDropping(false);
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            setDropping(false);
            addRefs(e.dataTransfer.files);
          }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-6 sm:px-6">
            {currentView.kind === "elements" ? (
              <ElementsPanel onMention={mention} onCast={() => setCastOpen(true)} onLocation={() => setLocationOpen(true)} />
            ) : loading ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {Array.from({ length: 8 }, (_, i) => (
                  <Skeleton key={i} className="aspect-square rounded-xl" />
                ))}
              </div>
            ) : (
              <CinemaFeed
                key={viewKey(currentView)}
                projectId={id}
                items={shown}
                folders={folders}
                title={title}
                empty={empty}
                handlers={handlers}
                nested={nested}
                onNested={currentView.kind === "folder" ? setNested : undefined}
              />
            )}
          </div>
          <div className="shrink-0 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-4">
            <div className="mx-auto max-w-[940px]">
              <PromptBar
                projectId={id}
                folderId={folderId}
                engine={engine}
                draft={draft}
                setDraft={setDraft}
                settings={settings}
                onSettings={onSettings}
                palettes={project.palettes}
                onPalettes={(palettes) => update.mutate({ palettes })}
                context={context}
                brief={project.brief.body}
                spentUsd={spentUsd}
                costCapUsd={project.costCapUsd}
                elements={elements}
                promptRef={promptRef}
                onCast={() => setCastOpen(true)}
                onLocation={() => setLocationOpen(true)}
                onBlockout={() => setBlockoutOpen(true)}
                onWorld={engineMode === "cloud" ? undefined : () => setWorldOpen(true)}
              />
            </div>
          </div>
          {dropping && (
            <div className="pointer-events-none absolute inset-2 z-30 grid place-items-center rounded-2xl border-2 border-dashed border-primary bg-brand-faint/80 backdrop-blur-sm">
              <p className="flex items-center gap-2 text-[15px] font-medium text-brand-text">
                <Upload className="size-5" /> Drop files here to add them as references
              </p>
            </div>
          )}
        </div>
        {xl && panel && <aside className="w-[380px] shrink-0 border-l bg-sidebar/40">{sidePanel}</aside>}
      </div>

      <Sheet open={foldersOpen} onOpenChange={setFoldersOpen}>
        <SheetContent side="left" className="w-[min(86vw,320px)] gap-0 p-0">
          <SheetHeader className="border-b px-4 py-3">
            <SheetTitle className="font-heading text-[20px] font-normal">{project.name}</SheetTitle>
            <SheetDescription className="sr-only">Folders and sections of this project</SheetDescription>
          </SheetHeader>
          {sidebar}
        </SheetContent>
      </Sheet>
      <Sheet open={!xl && !!panel} onOpenChange={(o) => !o && setPanel(null)}>
        <SheetContent side="right" className="w-[min(100vw,420px)] gap-0 p-0 sm:max-w-[420px] [&>button]:hidden">
          <SheetTitle className="sr-only">{panel === "brief" ? "Project brief" : "AI Director"}</SheetTitle>
          <SheetDescription className="sr-only">Side panel</SheetDescription>
          {sidePanel}
        </SheetContent>
      </Sheet>

      <SceneCreateDialog
        still={sceneFrom?.url ?? null}
        aspect={sceneFrom?.g.request.params?.aspectRatio}
        plan={scenePlan}
        onOpenChange={(o) => !o && setSceneFrom(null)}
        onConfirm={() => sceneFrom && createScene(sceneFrom.g, sceneFrom.url)}
      />
      {openScene && (
        <SceneViewer
          key={openScene.generation.id}
          take={openScene}
          projectId={id}
          engine={engine}
          onEngine={setEngine}
          settings={settings}
          context={context}
          brief={project.brief.body}
          onClose={() => setOpenScene(null)}
          onUseAsBlockout={(b) => {
            setBlockout((d) => ({
              ...d,
              source: { video: b.video, seconds: b.seconds, aspect: b.aspect, from: "scene", ...(!b.type.includes("mp4") && { webm: true }) },
              scene: null,
              beats: d.source?.from === "scene" && d.beats.length ? d.beats.filter((x) => x.start < b.seconds) : [{ id: "start", start: 0, label: "Opening", words: "" }],
              refs: d.refs.some((r) => r.url === b.still) ? d.refs : [{ id: "scene-still", url: b.still, role: "location" as const }, ...d.refs].slice(0, 8),
              prompt: null,
            }));
            setOpenScene(null);
            setBlockoutOpen(true);
            if (!b.type.includes("mp4") && engine === "cloud") toast(WEBM_BLOCKOUT);
          }}
        />
      )}
      <BlockoutPanel
        open={blockoutOpen && !builder}
        onOpenChange={setBlockoutOpen}
        projectId={id}
        folderId={folderId}
        engine={engine}
        settings={settings}
        brief={project.brief.body}
        context={context}
        draft={blockout}
        setDraft={setBlockout}
        onBuild={(scene) => setBuilder(scene)}
      />
      {builder && (
        <BlockoutBuilder
          initial={builder}
          onClose={(scene) => {
            setBlockout((d) => ({ ...d, scene }));
            setBuilder(null);
          }}
          onDone={(built, scene) => {
            setBlockout((d) => withBuilt(d, built, scene));
            setBuilder(null);
            setBlockoutOpen(true);
            if (!built.type.includes("mp4") && engine === "cloud") toast(WEBM_BLOCKOUT);
          }}
        />
      )}
      <WorldPanel
        open={worldOpen && engineMode !== "cloud"}
        onOpenChange={setWorldOpen}
        projectId={id}
        folderId={folderId}
        engine={engine}
        onEngine={setEngine}
        openAllowed={engineMode !== "cloud"}
        settings={settings}
        brief={project.brief.body}
        context={context}
        takes={items}
      />
      <SoulCastDialog open={castOpen} onOpenChange={setCastOpen} {...builderProps} />
      <SoulLocationDialog open={locationOpen} onOpenChange={setLocationOpen} {...builderProps} />
      <ProjectDialog open={settingsOpen} onOpenChange={setSettingsOpen} project={project} spentUsd={spentUsd} onDone={() => setSettingsOpen(false)} onDeleted={() => router.push("/cinema")} />
    </div>
  );
}
