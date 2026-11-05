"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { lazy, Suspense, useEffect, useState } from "react";
import { ArrowRight, CircleUserRound, House, Library, RotateCw, Search } from "lucide-react";
import { SUB_PILL } from "@/components/home/pill";
import { CoverThumb } from "@/components/nav/cover-thumb";
import { useNavUi, useViewerKind } from "@/components/nav/nav-ui";
import { IntentLink } from "@/components/intent-link";
import { onAttr, TAB_PILL, TabRow, useSwapFade } from "@/components/ui/tab-row";
import { MEGA_AREAS, type MegaId, type MegaItem, type MegaModel } from "@/lib/mega-menus";
import { isNew, studioSubs, subLabel, subParent, type ViewerKind } from "@/lib/nav-model";
import { cn } from "@/lib/utils";
import { megaCurrent } from "./mega-launcher";
import { useMegaMenu, warmMenu } from "./mega-data";

/** The families the sheet shows, in the bar's order. */
export const SHEET_FAMILIES: readonly MegaId[] = ["studios", "apps", "motions", "canvas"];

/** How many of each column a fetched menu's "All" shows (so the whole set fits a 390 x 844 phone). */
const ALL_PER_COLUMN = 4;

function Tile({ entry, current }: { entry: MegaItem; current: boolean }) {
  const fresh = isNew(entry);
  return (
    <li className="min-w-0">
      <IntentLink
        href={entry.href}
        aria-current={current ? "page" : undefined}
        className="nav-row nav-mark-under group/tile flex flex-col items-center gap-1 rounded-[16px] px-0.5 pt-0.5 pb-1 text-center"
      >
        <span className="relative">
          <CoverThumb id={entry.navCover} cover={entry.cover} icon={entry.icon} size="tile" eager className="size-12" />
          {fresh && (
            <span aria-hidden className="absolute -top-1 -right-1.5 rounded-full bg-highlight px-1 py-px text-[9px] leading-none font-semibold text-highlight-foreground">
              New
            </span>
          )}
        </span>
        <span aria-hidden className="line-clamp-3 min-h-[26px] text-[11px] leading-[13px] text-foreground/85 group-aria-[current=page]/tile:font-semibold group-aria-[current=page]/tile:text-foreground">
          {entry.short ?? entry.label}
        </span>
        <span className="sr-only">
          {entry.label}
          {fresh ? ", new" : ""}
        </span>
      </IntentLink>
    </li>
  );
}

/**
 * What the group's studios hold inside (their tabs and modes, every one a viewer may run): under the tiles, a small
 * heading per studio and its features as pills that wrap (/studios' own, 44 px to tap). Only for one group (All stays
 * one screen of tiles). A feature that is a tile here already (Ads Studio) isn't listed again.
 */
function SheetSubs({ items, kind, current }: { items: MegaItem[]; kind: ViewerKind | undefined; current?: string }) {
  const tiles = new Set(items.map((e) => e.id));
  const groups = items.map((e) => ({ e, subs: studioSubs(e.id, kind, "sheet").filter((s) => !tiles.has(s.id)) })).filter((g) => g.subs.length > 0);
  if (!groups.length) return null;
  return (
    <div data-sheet-subs className="flex flex-col gap-4 border-t pt-3 pb-3">
      {groups.map(({ e, subs }) => (
        <section key={e.id} aria-labelledby={`sheet-subs-${e.id}`}>
          <p id={`sheet-subs-${e.id}`} className="text-[11px] leading-4 font-semibold tracking-[.08em] text-brand-text uppercase">
            {e.label}
          </p>
          {/* 32 px pills whose touch area reaches 6 px past each edge (44 px): rows 12 px apart, so no two overlap. */}
          <ul aria-labelledby={`sheet-subs-${e.id}`} className="mt-2 flex flex-wrap gap-x-2 gap-y-3">
            {subs.map((s) => (
              <li key={s.id}>
                <IntentLink data-sub="" href={s.href} aria-current={current === s.id ? "page" : undefined} title={s.what} className={SUB_PILL}>
                  {subLabel(s)}
                </IntentLink>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** A grid's closing tile: the family's (or a part of it's) whole set. */
function SeeAllTile({ href, label, name }: { href: string; label: string; name: string }) {
  return (
    <li className="min-w-0">
      <IntentLink href={href} aria-label={name} className="nav-row group/tile flex flex-col items-center gap-1 rounded-[16px] px-0.5 pt-0.5 pb-1 text-center text-brand-text">
        <span aria-hidden className="grid size-12 place-items-center rounded-[14px] border border-dashed border-border-strong bg-brand-faint/40">
          <ArrowRight className="size-5" />
        </span>
        <span aria-hidden className="line-clamp-3 min-h-[26px] text-[11px] leading-[13px] font-medium">
          {label}
        </span>
      </IntentLink>
    </li>
  );
}

/**
 * A board card's picture width, for its srcset: half the sheet (it is the screen's width below md) less its 16 px sides,
 * the 8 px between the two cards and each card's own 4 px padding.
 */
const BOARD_SIZES = "calc((100vw - 56px) / 2)";

/** A ready board as a phone card: its finished scene (16:9) with its name under it. */
function BoardCard({ entry, current }: { entry: MegaItem; current: boolean }) {
  return (
    <li className="min-w-0">
      <IntentLink href={entry.href} aria-current={current ? "page" : undefined} className="nav-row nav-mark-under flex min-w-0 flex-col gap-1 rounded-[14px] p-1">
        <CoverThumb cover={entry.cover} icon={entry.icon} size="tile16" eager sizes={BOARD_SIZES} />
        <span className="truncate px-0.5 text-[12px] leading-4 font-medium">{entry.label}</span>
      </IntentLink>
    </li>
  );
}

const SHORTCUT =
  "nav-focus flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl bg-secondary px-2 text-[12.5px] font-medium text-secondary-foreground active:bg-[var(--nav-press)]";

/**
 * Where to go from a full-screen studio, which has no tab bar: Home, Library, You and Search, above the studios. Only
 * there (html[data-fullscreen-studio]); with the tab bar on screen these are its tabs.
 */
function Shortcuts({ onSearch }: { onSearch: () => void }) {
  const { setSheet } = useNavUi();
  return (
    <div className="hidden shrink-0 grid-cols-4 gap-2 px-4 [html[data-fullscreen-studio]_&]:grid">
      <IntentLink href="/" eager className={SHORTCUT}>
        <House className="size-4" aria-hidden /> Home
      </IntentLink>
      <IntentLink href="/library" eager className={SHORTCUT}>
        <Library className="size-4" aria-hidden /> Library
      </IntentLink>
      <button type="button" className={SHORTCUT} onClick={() => setSheet("you")}>
        <CircleUserRound className="size-4" aria-hidden /> You
      </button>
      <button type="button" className={SHORTCUT} onClick={onSearch}>
        <Search className="size-4" aria-hidden /> Search
      </button>
    </div>
  );
}

/** The sheet's family switch, in its title row: Studios · Apps · Motions & effects · Canvas. */
export function FamilySwitch({ family, onFamily }: { family: MegaId; onFamily: (f: MegaId) => void }) {
  return (
    <TabRow role="group" aria-label="What to show" follow className="min-w-0 flex-1 gap-0.5">
      {SHEET_FAMILIES.map((f) => (
        <button key={f} type="button" aria-pressed={family === f} {...onAttr(family === f)} onClick={() => onFamily(f)} className={cn(TAB_PILL, "px-[7px] text-[14px]")}>
          {MEGA_AREAS[f].label}
        </button>
      ))}
    </TabRow>
  );
}

/** The owner's New board button (the Canvas family), loaded only when the owner shows it. */
const NewBoardButton = lazy(() => import("./mega-canvas-owner").then((m) => ({ default: m.NewBoardButton })));

/** A chip's items: one column's lead and rows, or a few of each for All. */
function chipItems(model: MegaModel, chip: string | null): MegaItem[] {
  const cols = model.columns.filter((c) => !chip || c.id === chip);
  return cols.flatMap((c) => {
    const items = [...(c.lead ? [c.lead] : []), ...c.rows];
    return chip || model.id === "canvas" || model.id === "studios" ? items : items.slice(0, ALL_PER_COLUMN);
  });
}

/**
 * The Studios sheet's body (the phone's launcher): every studio, app, motion or effect, or ready board on one screen as
 * cover tiles, grouped as the bar's menus are, with chips that narrow it to one group. Studios, Apps and Motions &
 * effects fit a 390 x 844 phone without scrolling; anything taller scrolls inside the sheet, never the page. The frame,
 * its family switch and its close button are PhoneSheets'.
 */
export function StudiosSheet({ family = "studios", group: initial, onSearch }: { family?: MegaId; group?: string; onSearch: () => void }) {
  const kind = useViewerKind();
  const pathname = usePathname() ?? "";
  const [group, setGroup] = useState<string | null>(initial ?? null);
  const { model, failed, retry } = useMegaMenu(family, kind);
  useEffect(() => warmMenu(family), [family]);
  // The query too: moving from one preset to another (/video?preset=…) keeps the path.
  const current = megaCurrent(family, pathname, useSearchParams()?.toString() ?? "");
  const area = MEGA_AREAS[family];
  // Canvas: its "Start here" column is the desktop's; on a phone the boards are the grid.
  const columns = model?.columns.filter((c) => !(family === "canvas" && c.id === "start")) ?? [];
  const chips: { id: string | null; label: string }[] = [{ id: null, label: "All" }, ...columns.map((c) => ({ id: c.id, label: c.chip }))];
  // Canvas' "What's a canvas?" (a finished board's scene, which the sections leave out) opens its All grid.
  const intro = family === "canvas" && !group ? model?.columns.find((c) => c.id === "start")?.lead : undefined;
  const items = model ? [...(intro ? [intro] : []), ...chipItems({ ...model, columns }, group)] : [];
  // On a studio's feature (Genjutsu's Restyle), that studio's tile is the one marked; a feature with a tile of its own
  // (Ads Studio) marks that.
  const currentTile = family === "studios" && current && !items.some((e) => e.id === current) ? (subParent(current) ?? current) : current;
  const families = model?.families;
  const seeAll =
    group && families
      ? (() => {
          const f = families.find((x) => x.id === columns.find((c) => c.id === group)?.family);
          return f && { href: f.href, label: `All ${f.count}`, name: `See all ${f.label.toLowerCase()}` };
        })()
      : { href: area.href, label: model ? `See all ${model.count}` : "See all", name: model?.seeAll.name ?? `See all ${area.label.toLowerCase()}` };
  // A group tapped: its tiles fade in (they are there at once).
  const tilesRef = useSwapFade<HTMLDivElement>(model ? `${family}/${group ?? ""}` : null);
  return (
    <>
      <Shortcuts onSearch={onSearch} />
      <TabRow
        role="group"
        aria-label={family === "studios" ? "Show the studios for one goal" : `Show one group of ${area.label.toLowerCase()}`}
        follow
        className="m-0 shrink-0 px-4 py-1.5"
      >
        <button type="button" onClick={onSearch} aria-label="Search everything" className={cn(TAB_PILL, "px-2.5 text-brand-text [html[data-fullscreen-studio]_&]:hidden")}>
          <Search className="size-4" aria-hidden />
        </button>
        {model &&
          // A chip per group (Canvas: per section, even one, so its row is never a lone search button).
          chips.length > (family === "canvas" ? 1 : 2) &&
          chips.map((c) => (
            <button key={c.id ?? "all"} type="button" aria-pressed={group === c.id} className={TAB_PILL} {...onAttr(group === c.id)} onClick={() => setGroup(c.id)}>
              {c.label}
            </button>
          ))}
      </TabRow>
      <div ref={tilesRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4" data-sheet-family={family}>
        {failed ? (
          <p className="flex items-center gap-2 py-6 text-[14px] text-muted-foreground">
            Couldn&apos;t load this.
            <button type="button" onClick={retry} className="nav-row inline-flex h-11 items-center gap-1.5 rounded-full px-3 font-medium text-foreground">
              <RotateCw className="size-4" aria-hidden /> Try again
            </button>
          </p>
        ) : !model ? (
          <ul aria-hidden className="grid grid-cols-5 gap-x-1 pb-1">
            {Array.from({ length: 30 }, (_, i) => (
              <li key={i} className="flex flex-col items-center gap-1 px-0.5 pt-0.5 pb-1">
                <span className="size-12 rounded-[14px] bg-muted" />
                <span className="h-[26px] w-10 rounded bg-muted/60" />
              </li>
            ))}
          </ul>
        ) : family === "canvas" ? (
          <>
            {kind === "owner" && (
              <Suspense fallback={<div className="mb-2 h-11 rounded-full bg-muted" />}>
                <NewBoardButton />
              </Suspense>
            )}
            <ul aria-label={area.panel} className="grid grid-cols-2 gap-2 pb-1">
              {items.map((e) => (
                <BoardCard key={e.id} entry={e} current={e.id === current} />
              ))}
              <li className="min-w-0">
                <IntentLink href="/canvas?tab=templates" className="nav-row flex min-w-0 flex-col gap-1 rounded-[14px] p-1 text-brand-text">
                  <span aria-hidden className="grid aspect-video w-full place-items-center rounded-[10px] border border-dashed border-border-strong bg-brand-faint/40">
                    <ArrowRight className="size-5" />
                  </span>
                  <span className="truncate px-0.5 text-[12px] leading-4 font-medium">See all ready boards</span>
                </IntentLink>
              </li>
            </ul>
          </>
        ) : (
          <>
            <ul aria-label={group ? columns.find((c) => c.id === group)?.label : area.panel} className="grid grid-cols-5 gap-x-1 pb-1">
              {items.map((e) => (
                <Tile key={e.id} entry={e} current={e.id === currentTile} />
              ))}
              {seeAll && family !== "studios" && <SeeAllTile {...seeAll} />}
              {family === "studios" && <SeeAllTile href={area.href} label="See all" name="See all studios" />}
            </ul>
            {family === "studios" && group && <SheetSubs items={items} kind={kind} current={current} />}
          </>
        )}
      </div>
    </>
  );
}
