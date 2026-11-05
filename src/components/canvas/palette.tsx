"use client";

import { PanelLeftClose, Plus, Search } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { OwnSetupChip } from "@/components/own-setup";
import type { NodeGroup, PaletteItem } from "@/lib/catalog/canvas";
import { NodeIcon } from "./canvas-context";

export const DRAG_TYPE = "application/x-fuobe-canvas-node";

const GROUPS: NodeGroup[] = ["Inputs", "Generate", "Utilities", "Output"];

const matches = (p: PaletteItem, q: string) => !q || `${p.label} ${p.description} ${p.keywords ?? ""}`.toLowerCase().includes(q.toLowerCase());

/** The left-hand node palette (desktop): search, drag onto the board or click to add in the middle. */
export const Palette = memo(function Palette({ items, onAdd, onClose }: { items: PaletteItem[]; onAdd: (p: PaletteItem) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => items.filter((p) => matches(p, q)), [items, q]);
  return (
    <aside className="flex max-h-full w-60 flex-col overflow-hidden rounded-xl border bg-popover/95 shadow-normal backdrop-blur" aria-label="Add nodes">
      <div className="flex items-center gap-1 border-b p-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search nodes"
            aria-label="Search nodes"
            className="h-8 w-full rounded-md bg-muted pr-2 pl-8 text-[13px] outline-none placeholder:text-subtle-foreground focus:ring-2 focus:ring-brand-faint"
          />
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={onClose} className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Hide the node palette">
              <PanelLeftClose className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Hide palette</TooltipContent>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2">
        {GROUPS.map((group) => {
          const list = shown.filter((p) => p.group === group);
          if (!list.length) return null;
          return (
            <div key={group}>
              <p className="px-1.5 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{group}</p>
              {list.map((p) => {
                // An entry with no model on the only engine this install allows: shown, with why, but not addable.
                if (p.disabled) {
                  return (
                    <div key={p.id} className="flex w-full cursor-not-allowed items-start gap-2.5 rounded-lg px-1.5 py-1.5 text-left opacity-60" title={p.disabled} aria-disabled="true">
                      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                        <NodeIcon name={p.icon} className="size-3.5" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium">{p.label}</span>
                        <OwnSetupChip setup={p.data?.modelId} className="mb-0.5" />
                        <span className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">{p.disabled}</span>
                      </span>
                    </div>
                  );
                }
                return (
                  <button
                    key={p.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DRAG_TYPE, p.id);
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    onClick={() => onAdd(p)}
                    className="flex w-full cursor-grab items-start gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-accent active:cursor-grabbing"
                    title={`${p.description}. Drag onto the board, or click to add.`}
                  >
                    <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                      <NodeIcon name={p.icon} className="size-3.5" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium">{p.label}</span>
                      {/* A node that needs a bigger GPU than most (Regenerate): what it runs on, in the label's own words. */}
                      <OwnSetupChip setup={p.data?.modelId} className="mb-0.5" />
                      <span className="line-clamp-1 text-[11px] leading-snug text-muted-foreground">{p.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
        {!shown.length && <p className="px-2 py-6 text-center text-[12px] text-muted-foreground">No node called “{q}”.</p>}
      </div>
    </aside>
  );
});

export function PaletteToggle({ onOpen }: { onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="inline-flex h-9 items-center gap-1.5 rounded-full border bg-popover px-3.5 text-[13px] font-medium shadow-normal hover:bg-accent" aria-label="Add a node">
      <Plus className="size-4" /> Add node
    </button>
  );
}

/**
 * The floating Add-node menu (right-click or double-click on the board, or a connection dropped on
 * empty space). Positioned in the board's own coordinates; Escape or a click outside closes it.
 */
export function AddMenu({ x, y, items, title, onPick, onClose }: { x: number; y: number; items: PaletteItem[]; title?: string; onPick: (p: PaletteItem) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="absolute z-30 w-64 animate-pop-in overflow-hidden rounded-xl border bg-popover shadow-strong"
      style={{ left: x, top: y }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        e.stopPropagation();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Plain substring matching: fuzzy matching finds "Audio" for "upsc". */}
      <Command className="rounded-none!" filter={(value, search) => (value.toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0)}>
        {title && <p className="px-2.5 pt-2 text-[11px] font-medium text-muted-foreground">{title}</p>}
        <CommandInput autoFocus placeholder="Add a node…" />
        <CommandList className="max-h-80">
          <CommandEmpty>Nothing matches.</CommandEmpty>
          {GROUPS.map((group) => {
            const list = items.filter((p) => p.group === group);
            if (!list.length) return null;
            return (
              <CommandGroup key={group} heading={group}>
                {list.map((p) => {
                  return (
                    <CommandItem key={p.id} value={`${p.label} ${p.keywords ?? ""}`} onSelect={() => onPick(p)} disabled={!!p.disabled} title={p.disabled} className="gap-2">
                      <NodeIcon name={p.icon} className="size-4 text-muted-foreground" />
                      <span className="truncate text-[13px]">{p.label}</span>
                      <OwnSetupChip setup={p.data?.modelId} />
                      {p.disabled && <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">not on this engine</span>}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            );
          })}
        </CommandList>
      </Command>
    </div>
  );
}
