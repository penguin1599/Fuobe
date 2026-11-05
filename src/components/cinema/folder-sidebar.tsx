"use client";

import { ArrowDown, ArrowDownAZ, ArrowUp, AtSign, ChevronRight, Clock, Folder, FolderInput, FolderPlus, Heart, Home, Library, ListOrdered, MoreHorizontal, Pencil, Pin, PinOff, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EMOTION_FAMILIES, type CinemaFolder } from "@/lib/catalog/cinema";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/refusals";
import { useFolderActions } from "./hooks";

/** Which feed the workspace shows. */
export type CinemaView = { kind: "home" } | { kind: "studio" } | { kind: "elements" } | { kind: "favorites" } | { kind: "folder"; id: string };

export const viewKey = (v: CinemaView) => (v.kind === "folder" ? `folder:${v.id}` : v.kind);

/** Folder swatches: the Emotion Wheel's mid tones, plus none. */
export const FOLDER_COLORS = EMOTION_FAMILIES.map((f) => f.colors[1]);

export type FolderSort = "manual" | "name" | "recent";
type Sort = FolderSort;

export interface FolderNode extends CinemaFolder {
  children: FolderNode[];
  depth: number;
}

export function folderTree(folders: CinemaFolder[], sort: Sort = "manual"): FolderNode[] {
  const by = new Map<string | null, CinemaFolder[]>();
  for (const f of folders) {
    const parent = f.parentId && folders.some((x) => x.id === f.parentId) ? f.parentId : null;
    by.set(parent, [...(by.get(parent) ?? []), f]);
  }
  const order = (xs: CinemaFolder[]) =>
    [...xs].sort((a, b) => Number(b.pinned) - Number(a.pinned) || (sort === "name" ? a.name.localeCompare(b.name) : sort === "recent" ? b.updatedAt - a.updatedAt : a.position - b.position));
  const build = (parent: string | null, depth: number): FolderNode[] => order(by.get(parent) ?? []).map((f) => ({ ...f, depth, children: build(f.id, depth + 1) }));
  return build(null, 0);
}

/**
 * Positions after moving `id` one step up (-1) or down (+1) among its siblings with the same pin
 * state (pinned folders always sort first). Only the folders whose position changes are returned;
 * tied positions (older folders) are spread out so the new order sticks.
 */
export function reorderFolders(siblings: Pick<CinemaFolder, "id" | "pinned" | "position">[], id: string, dir: -1 | 1): { id: string; position: number }[] {
  const me = siblings.find((s) => s.id === id);
  if (!me) return [];
  const group = siblings.filter((s) => s.pinned === me.pinned);
  const i = group.findIndex((s) => s.id === id);
  const j = i + dir;
  if (j < 0 || j >= group.length) return [];
  const order = group.map((s) => s.id);
  [order[i], order[j]] = [order[j], order[i]];
  const base = Math.min(...group.map((s) => s.position));
  return order.map((x, k) => ({ id: x, position: base + k })).filter((c) => group.find((s) => s.id === c.id)!.position !== c.position);
}

export function flattenTree(nodes: FolderNode[]): FolderNode[] {
  return nodes.flatMap((n) => [n, ...flattenTree(n.children)]);
}

/** A folder's id and every folder nested in it. */
export function subtree(folders: CinemaFolder[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parentId && out.has(f.parentId) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

/** "Move to" submenu content: project root + every folder (indented). */
export function MoveToItems({ folders, onMove, exclude }: { folders: CinemaFolder[]; onMove: (folderId: string | null) => void; exclude?: Set<string> }) {
  const flat = flattenTree(folderTree(folders));
  return (
    <>
      <DropdownMenuItem onClick={() => onMove(null)}>
        <Home /> Project root
      </DropdownMenuItem>
      {flat
        .filter((f) => !exclude?.has(f.id))
        .map((f) => (
          <DropdownMenuItem key={f.id} onClick={() => onMove(f.id)} style={{ paddingLeft: 8 + f.depth * 14 }}>
            <Folder style={f.color ? { color: f.color } : undefined} /> {f.name}
          </DropdownMenuItem>
        ))}
    </>
  );
}

function FolderRow({
  node,
  siblings,
  sort,
  folders,
  view,
  setView,
  open,
  toggle,
  counts,
  projectId,
  onDropItems,
}: {
  node: FolderNode;
  /** The folders next to this one, in the order shown (Move up / Move down). */
  siblings: FolderNode[];
  sort: Sort;
  folders: CinemaFolder[];
  view: CinemaView;
  setView: (v: CinemaView) => void;
  open: Set<string>;
  toggle: (id: string) => void;
  counts: Map<string, number>;
  projectId: string;
  onDropItems: (ids: string[], folderId: string) => void;
}) {
  const actions = useFolderActions(projectId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(node.name);
  const [over, setOver] = useState(false);
  const active = view.kind === "folder" && view.id === node.id;
  const expanded = open.has(node.id);
  const group = siblings.filter((s) => s.pinned === node.pinned);
  const at = group.findIndex((s) => s.id === node.id);
  const reorder = (dir: -1 | 1) =>
    void Promise.all(reorderFolders(siblings, node.id, dir).map((c) => actions.update(c.id, { position: c.position }))).catch((e) => toastError(e));
  const parent = node.parentId ? folders.find((f) => f.id === node.parentId) : undefined;
  const commit = () => {
    setRenaming(false);
    if (name.trim() && name.trim() !== node.name) void actions.update(node.id, { name: name.trim() }).catch((e) => toastError(e));
    else setName(node.name);
  };
  return (
    <li>
      <div
        className={cn(
          "group/row flex h-8 items-center gap-1 rounded-lg pr-1 text-[13px] transition-colors",
          active ? "bg-sidebar-accent font-medium" : "hover:bg-accent",
          over && "bg-brand-faint ring-1 ring-primary",
        )}
        style={{ paddingLeft: 4 + node.depth * 14 }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("application/x-cinema-takes")) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          setOver(false);
          const ids = e.dataTransfer.getData("application/x-cinema-takes");
          if (ids) onDropItems(JSON.parse(ids) as string[], node.id);
        }}
      >
        <button
          type="button"
          onClick={() => toggle(node.id)}
          className={cn("grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground", !node.children.length && "invisible")}
          aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
          aria-expanded={expanded}
        >
          <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
        </button>
        {renaming ? (
          <Input
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value.slice(0, 60))}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setName(node.name);
                setRenaming(false);
              }
            }}
            className="h-7 flex-1 px-1.5 text-[13px]"
            aria-label="Folder name"
          />
        ) : (
          <button type="button" onClick={() => setView({ kind: "folder", id: node.id })} onDoubleClick={() => setRenaming(true)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            <span className="size-2.5 shrink-0 rounded-full border" style={node.color ? { background: node.color, borderColor: node.color } : undefined} />
            <span className="truncate">{node.name}</span>
            {node.pinned && <Pin className="size-3 shrink-0 text-muted-foreground" />}
          </button>
        )}
        {!renaming && <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground group-hover/row:hidden">{counts.get(node.id) || ""}</span>}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="hidden size-6 shrink-0 place-items-center rounded-md text-muted-foreground group-focus-within/row:grid group-hover/row:grid hover:bg-accent hover:text-foreground data-[state=open]:grid max-lg:grid"
              aria-label={`${node.name} actions`}
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuItem onClick={() => setRenaming(true)}>
              <Pencil /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void actions.create({ name: "New scene", parentId: node.id }).then(() => !expanded && toggle(node.id))}>
              <FolderPlus /> New subfolder
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void actions.update(node.id, { pinned: !node.pinned })}>
              {node.pinned ? <PinOff /> : <Pin />} {node.pinned ? "Unpin" : "Pin"}
            </DropdownMenuItem>
            {sort === "manual" && group.length > 1 && (
              <>
                <DropdownMenuItem disabled={at <= 0} onClick={() => reorder(-1)}>
                  <ArrowUp /> Move up
                </DropdownMenuItem>
                <DropdownMenuItem disabled={at < 0 || at >= group.length - 1} onClick={() => reorder(1)}>
                  <ArrowDown /> Move down
                </DropdownMenuItem>
              </>
            )}
            <div className="flex flex-wrap gap-1 px-2 py-1.5" role="radiogroup" aria-label="Folder colour">
              <button type="button" onClick={() => void actions.update(node.id, { color: null })} className={cn("size-5 rounded-full border", !node.color && "ring-2 ring-primary ring-offset-1 ring-offset-popover")} aria-label="No colour" />
              {FOLDER_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => void actions.update(node.id, { color: c })}
                  className={cn("size-5 rounded-full", node.color === c && "ring-2 ring-primary ring-offset-1 ring-offset-popover")}
                  style={{ background: c }}
                  aria-label={`Colour ${c}`}
                />
              ))}
            </div>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <FolderInput /> Move to
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
                <MoveToItems folders={folders} exclude={subtree(folders, node.id)} onMove={(parentId) => void actions.update(node.id, { parentId }).catch((e) => toastError(e))} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 /> Delete folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{node.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Its takes{node.children.length ? " and subfolders" : ""} move up to {parent ? `“${parent.name}”` : "Home"}. No take is deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                void actions
                  .remove(node.id)
                  .then(() => {
                    if (active) setView(parent ? { kind: "folder", id: parent.id } : { kind: "home" });
                    toast(`Folder deleted — its takes moved to ${parent ? parent.name : "Home"}`);
                  })
                  .catch((e) => toastError(e))
              }
            >
              Delete folder
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {expanded && node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <FolderRow key={c.id} node={c} siblings={node.children} sort={sort} folders={folders} view={view} setView={setView} open={open} toggle={toggle} counts={counts} projectId={projectId} onDropItems={onDropItems} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function FolderSidebar({
  projectId,
  folders,
  view,
  setView,
  counts,
  onDropItems,
  elements = true,
  className,
}: {
  projectId: string;
  folders: CinemaFolder[];
  view: CinemaView;
  setView: (v: CinemaView) => void;
  counts: { home: number; favorites: number; folders: Map<string, number> };
  onDropItems: (ids: string[], folderId: string) => void;
  /** "My Elements": the studio's saved elements (the owner's library), so the owner's only. */
  elements?: boolean;
  className?: string;
}) {
  const actions = useFolderActions(projectId);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("manual");
  const [open, setOpen] = useState<Set<string>>(() => new Set(folders.map((f) => f.id)));
  const tree = useMemo(() => folderTree(folders, sort), [folders, sort]);
  const matches = useMemo(() => (q ? flattenTree(tree).filter((f) => f.name.toLowerCase().includes(q.toLowerCase())).map((f) => ({ ...f, depth: 0, children: [] })) : tree), [tree, q]);
  const toggle = (id: string) => setOpen((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const sections: { view: CinemaView; label: string; icon: typeof Home; count?: number }[] = [
    { view: { kind: "home" }, label: "Home", icon: Home, count: counts.home },
    { view: { kind: "studio" }, label: "My Generations", icon: Library },
    ...(elements ? [{ view: { kind: "elements" } as CinemaView, label: "My Elements", icon: AtSign }] : []),
    { view: { kind: "favorites" }, label: "My Favorites", icon: Heart, count: counts.favorites },
  ];
  const newFolder = async () => {
    try {
      const f = await actions.create({ name: `Scene ${folders.filter((x) => !x.parentId).length + 1}` });
      setOpen((s) => new Set([...s, f.id]));
      setView({ kind: "folder", id: f.id });
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <nav className={cn("flex min-h-0 flex-col gap-3 p-2", className)} aria-label="Project">
      <ul className="space-y-0.5">
        {sections.map((s) => {
          const active = viewKey(s.view) === viewKey(view);
          return (
            <li key={s.label}>
              <button
                type="button"
                onClick={() => setView(s.view)}
                className={cn("flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[13px] transition-colors", active ? "bg-sidebar-accent font-medium" : "hover:bg-accent")}
                aria-current={active ? "page" : undefined}
              >
                <s.icon className="size-4 text-muted-foreground" />
                <span className="flex-1 text-left">{s.label}</span>
                {s.count ? <span className="font-mono text-[10.5px] text-muted-foreground">{s.count}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
        <div className="flex items-center gap-1 px-1">
          <span className="flex-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Scenes</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={() => setSort((s) => (s === "manual" ? "name" : s === "name" ? "recent" : "manual"))} className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Sort folders">
                {sort === "manual" ? <ListOrdered className="size-3.5" /> : sort === "name" ? <ArrowDownAZ className="size-3.5" /> : <Clock className="size-3.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent>Sort: {sort === "manual" ? "Manual" : sort === "name" ? "Name (A–Z)" : "Recently changed"}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={() => void newFolder()} className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="New folder">
                <FolderPlus className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>New folder (scene)</TooltipContent>
          </Tooltip>
        </div>
        {folders.length > 4 && (
          <div className="relative px-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find folder.." className="h-7 pl-7 text-[12.5px]" aria-label="Find folder" />
          </div>
        )}
        {folders.length ? (
          <ul className="space-y-0.5">
            {matches.map((n) => (
              <FolderRow
                key={n.id}
                node={n}
                siblings={q ? [] : matches}
                sort={sort}
                folders={folders}
                view={view}
                setView={setView}
                open={q ? new Set() : open}
                toggle={toggle}
                counts={counts.folders}
                projectId={projectId}
                onDropItems={onDropItems}
              />
            ))}

            {q && !matches.length && <li className="px-2 py-2 text-[12px] text-muted-foreground">No folder with that name</li>}
          </ul>
        ) : (
          <button type="button" onClick={() => void newFolder()} className="mx-1 flex w-[calc(100%-0.5rem)] flex-col items-start gap-0.5 rounded-lg border border-dashed px-2.5 py-2 text-left text-[12px] text-muted-foreground hover:border-primary hover:bg-brand-faint hover:text-brand-text">
            <span className="flex items-center gap-1.5 font-medium">
              <FolderPlus className="size-3.5" /> New folder
            </span>
            Scenes, versions, deliverables — nest them as deep as you like.
          </button>
        )}
      </div>
    </nav>
  );
}
