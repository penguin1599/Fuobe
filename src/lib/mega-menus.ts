/**
 * The bar's grouped menus (Studios, Apps, Motions & effects, Canvas) as one model the launcher draws: a header line
 * with the true count, columns of a lead card and rows (or cover tiles), and "See all". Client-safe (no catalog):
 * Studios is built here from the navigation model; the other three are built on the server from the catalog and the
 * covers (mega-menus.server.ts) and fetched as small static files (/nav-menus/<id>) the first time a menu warms.
 */
import type { CoverFraming } from "./cover-framing";
import { area } from "./nav-areas";
import type { StillSources } from "./preset-hd";
import { entriesFor, launcherColumns, studioCount, studioSubs, STUDIO_SUBS, subLabel, subParent, type NavEntry, type NavIconName, type ViewerKind } from "./nav-model";

export type MegaId = "studios" | "apps" | "motions" | "canvas";

/** The menus fetched from the server (Studios is in the bundle). */
export type FetchedMegaId = Exclude<MegaId, "studios">;
export const FETCHED_MENUS: readonly FetchedMegaId[] = ["apps", "motions", "canvas"];

/** Where a fetched menu's data is: a static file, made at build time. */
export const menuUrl = (id: FetchedMegaId) => `/nav-menus/${id}`;

/** A cover at its versioned URLs (never built here: presetCover() and templateCover() give them). */
export interface MegaCover {
  /** The full still, for a lead card. */
  poster: string;
  /** Its 320 px copy, for a lead card on a small screen and a 16:9 tile. */
  thumb: string;
  /** Its 96 px copy, for a row and a phone tile (a preset's own poster only). */
  mini?: string;
  /**
   * Its larger copies' srcsets (preset-hd.ts, template-hd.ts), so a box wider than the poster on a 2x or 3x screen
   * gets a copy at least as wide as it shows: the Canvas menu's tiles and lead. Made on the server, so no client chunk
   * carries the lists of copies.
   */
  hd?: StillSources;
  /** How it sits in a box of another shape (cover-framing.ts). */
  framing?: CoverFraming;
}

export interface MegaItem {
  id: string;
  href: string;
  label: string;
  /** One line (CSS cuts it to fit; the whole of it is the row's title). */
  line?: string;
  /** Its cover, inline (the fetched menus). */
  cover?: MegaCover;
  /** Its cover as a preset id the nav's covers resolve (Studios: useNavCover). */
  navCover?: string;
  /** Shown on the muted fill when there is no cover. */
  icon?: NavIconName;
  /** A phone tile's name (12 characters at most). */
  short?: string;
  /** ISO date: a "New" badge until then. */
  newUntil?: string;
  /** What it holds inside (a studio's tabs and modes): links under it (Studios). */
  subs?: MegaSub[];
  /** The window height its links need (800, 880 or 960 px): below it they hide, so the panel never scrolls. */
  subsFrom?: 800 | 880 | 960;
  /** Below `subsFrom`, its links show as one wrapped line of names (Genjutsu's modes) instead of hiding. */
  subsLine?: true;
  /**
   * The studio the desktop menu lists it under, as one of its links (Ads Studio under Marketing Studio): the menu leaves
   * out its own row; the phone's sheet keeps its tile (its All grid is tiles only).
   */
  under?: string;
}

/** A feature inside a studio, as a link under it: its tab's name, its line as the link's title. */
export interface MegaSub {
  id: string;
  href: string;
  label: string;
  line?: string;
  /** "See all N": the studio's page, where every one of its features is a tab. */
  more?: true;
  /** Its accessible name, when its label alone doesn't say where it goes ("See all 13 in Audio"). */
  name?: string;
  /** The window height this one link needs, when it is more than its studio's other links do (the owner's own). */
  from?: 880 | 960;
}

export interface MegaColumn {
  id: string;
  /** The column's name over it. */
  label: string;
  /** Its filter chip on a phone. */
  chip: string;
  /** The family it belongs to (Motions & effects). */
  family?: string;
  /** list: a lead card and rows (the default); tiles: cover cards of the same size, `span` across. */
  variant?: "list" | "tiles";
  /** How many of the grid's six tracks it takes (1 by default). */
  span?: number;
  lead?: MegaItem;
  rows: MegaItem[];
  /** A "See all" link at the end of its label row (tiles only). */
  more?: { href: string; label: string };
  /** For the owner, the browser draws this column its own way: "canvas-start" is New board and their recent boards. */
  owner?: "canvas-start";
}

export interface MegaFamily {
  id: string;
  label: string;
  count: number;
  href: string;
  /** How many grid tracks its columns take. */
  span: number;
}

export interface MegaModel {
  id: MegaId;
  /** The true count, as the header line says it. */
  count: number;
  /** "127 apps, grouped by what they change". */
  countLine: string;
  /** The area page: "See all" at the top. `name` is the link's accessible name. */
  seeAll: { href: string; name: string };
  families?: MegaFamily[];
  columns: MegaColumn[];
}

/** Each menu's bar item: its name, the page its name opens, and the names of its chevron and panel. */
export const MEGA_AREAS: Record<MegaId, { label: string; href: string; menu: string; panel: string }> = {
  studios: { label: "Studios", href: area("studios").href, menu: "Studios menu", panel: "All studios" },
  apps: { label: "Apps", href: area("apps").href, menu: "Apps menu", panel: "All apps" },
  motions: { label: "Motions & effects", href: area("motions").href, menu: "Motions & effects menu", panel: "All motions and effects" },
  canvas: { label: "Canvas", href: "/canvas", menu: "Canvas menu", panel: "Canvas ready boards" },
};

/** The panel's element id ("studios-launcher", "apps-launcher" …). */
export const megaPanelId = (id: MegaId) => `${id}-launcher`;

/**
 * Rows a list column shows under its lead by the window's height (the panel never scrolls inside): below 800 px, 800
 * to 959 px, and from 960 px. Seven at most, as Studios: "See all" carries the rest. The data holds at most `tall`.
 */
export const ROW_CAPS = { short: 6, mid: 7, tall: 7 } as const;

/** Tiles across a tiles column, and its rows: two (one below 900 px of height when it has two sections). */
export const TILE_COLS = 4;
export const TILE_ROWS = 2;

/**
 * Where an arrow key goes from `at` in columns of `lengths` links (row 0 is the lead card): up and down within the
 * column, stopping at its ends; left and right to the same row of the neighbouring column, or its last when shorter;
 * Home and End to the column's first and last. Null when the key goes nowhere (an edge, another key).
 */
export function megaMove(lengths: readonly number[], at: { col: number; row: number }, key: string): { col: number; row: number } | null {
  const { col, row } = at;
  const len = lengths[col] ?? 0;
  if (!len) return null;
  let next: { col: number; row: number } | null = null;
  if (key === "ArrowDown") next = row < len - 1 ? { col, row: row + 1 } : null;
  else if (key === "ArrowUp") next = row > 0 ? { col, row: row - 1 } : null;
  else if (key === "Home") next = { col, row: 0 };
  else if (key === "End") next = { col, row: len - 1 };
  else if (key === "ArrowLeft" || key === "ArrowRight") {
    let c = col + (key === "ArrowLeft" ? -1 : 1);
    while (c >= 0 && c < lengths.length && !lengths[c]) c += key === "ArrowLeft" ? -1 : 1;
    next = c >= 0 && c < lengths.length ? { col: c, row: Math.min(row, lengths[c] - 1) } : null;
  }
  return next && (next.col !== col || next.row !== row) ? next : null;
}

const studioItem = (e: NavEntry): MegaItem => ({
  id: e.id,
  href: e.href,
  label: e.label,
  line: e.what,
  ...(e.cover && { navCover: e.cover }),
  icon: e.icon,
  ...(e.short && { short: e.short }),
  ...(e.newUntil && { newUntil: e.newUntil }),
});

/** A studio's features as the menu links them under it (STUDIO_SUBS), then "See all N" when it lists only some. */
export function megaSubs(parent: NavEntry, kind: ViewerKind | undefined): MegaSub[] {
  const shown = studioSubs(parent.id, kind, "menu");
  if (!shown.length) return [];
  const ownerTall = STUDIO_SUBS[parent.id]?.ownerTall;
  const subs: MegaSub[] = shown.map((e) => ({
    id: e.id,
    href: e.href,
    label: subLabel(e),
    line: e.what,
    ...(ownerTall && e.visibility?.length === 1 && e.visibility[0] === "owner" && { from: ownerTall }),
  }));
  // Every tab the studio's page shows this viewer (Audio's rows in the Sound column count too).
  const all = Math.max(studioSubs(parent.id, kind, "list").length, entriesFor(kind).filter((e) => e.kind === "tool" && e.parent === parent.id).length);
  if (all > shown.length) subs.push({ id: `${parent.id}-all`, href: parent.href, label: `See all ${all}`, name: `See all ${all} in ${parent.label}`, line: `Every tool in ${parent.label}`, more: true });
  return subs;
}

const withSubs = (e: NavEntry, kind: ViewerKind | undefined): MegaItem => {
  const subs = megaSubs(e, kind);
  const spec = STUDIO_SUBS[e.id];
  const under = subParent(e.id);
  return {
    ...studioItem(e),
    ...(subs.length > 0 && { subs, ...(spec?.tall && { subsFrom: spec.tall, ...(spec.short === "line" && { subsLine: true as const }) }) }),
    ...(under && { under }),
  };
};

/** The Studios menu for each kind of viewer, built once: it only reads the navigation model. */
const studiosMenus = new Map<ViewerKind | undefined, MegaModel>();

/**
 * Studios as a menu: the launcher's columns (launcherColumns) for who is looking, each studio with what it holds inside
 * as links under it (megaSubs). A studio that is a tab of another's suite (Ads Studio, in Marketing Studio's) is one of
 * those links in the desktop menu instead of a row of its own (`under`); the phone's sheet keeps its tile.
 */
export function studiosMenu(kind: ViewerKind | undefined): MegaModel {
  const built = studiosMenus.get(kind);
  if (built) return built;
  const n = studioCount();
  const model: MegaModel = {
    id: "studios",
    count: n,
    countLine: `${n} studios, grouped by what you want to make`,
    seeAll: { href: MEGA_AREAS.studios.href, name: "See all studios" },
    columns: launcherColumns(kind).map((c) => ({
      id: c.group.id,
      label: c.group.label,
      chip: c.group.chip,
      lead: withSubs(c.lead, kind),
      rows: c.rest.map((e) => withSubs(e, kind)),
    })),
  };
  studiosMenus.set(kind, model);
  return model;
}

/** Every item of a menu, leads first in each column, in column order (a phone's "All", a test). */
export const megaItems = (m: MegaModel): MegaItem[] => m.columns.flatMap((c) => [...(c.lead ? [c.lead] : []), ...c.rows]);

/** A preset's page (as its gallery card links it). */
const presetPage = (id: string) => (id.startsWith("app-") ? `/apps/${id}` : `/video?preset=${id}`);

/** A preset's own poster and its copies, from its version: /previews/presets/<id>.jpg?v=<v> (thumbs/, mini/). */
function presetUrls(id: string, v: string): MegaCover {
  const poster = `/previews/presets/${id}.jpg?v=${v}`;
  return { poster, thumb: `/previews/presets/thumbs/${id}.jpg?v=${v}`, mini: `/previews/presets/mini/${id}.jpg?v=${v}` };
}

/** An item as the menu files carry it: a preset's cover by its version (`cv`) and its page left out when it is the usual one. */
type WireItem = Omit<MegaItem, "href" | "cover"> & { href?: string; cover?: MegaCover; cv?: string };

function packItem(e: MegaItem): WireItem {
  const { href, cover, ...rest } = e;
  const v = cover && /^\/previews\/presets\/([^/]+)\.jpg\?v=([0-9a-f]{8})$/.exec(cover.poster);
  const usual = v && v[1] === e.id && JSON.stringify({ ...presetUrls(e.id, v[2]) }) === JSON.stringify({ poster: cover!.poster, thumb: cover!.thumb, mini: cover!.mini });
  return {
    ...rest,
    ...(href !== presetPage(e.id) && { href }),
    ...(usual ? { cv: v![2], ...(cover!.framing && { cover: { framing: cover!.framing } as MegaCover }) } : cover && { cover }),
  };
}

function unpackItem(w: WireItem): MegaItem {
  const { cv, href, cover, ...rest } = w;
  return { ...rest, href: href ?? presetPage(w.id), ...(cv ? { cover: { ...presetUrls(w.id, cv), ...(cover?.framing && { framing: cover.framing }) } } : cover && { cover }) };
}

/** A menu as its file carries it (smaller: presets' covers by version): packMenu on the server, unpackMenu in the browser. */
export function packMenu(m: MegaModel): unknown {
  return { ...m, columns: m.columns.map(({ lead, rows, ...c }) => ({ ...c, ...(lead && { lead: packItem(lead) }), rows: rows.map(packItem) })) };
}

export function unpackMenu(w: unknown): MegaModel {
  const m = w as Omit<MegaModel, "columns"> & { columns: (Omit<MegaColumn, "lead" | "rows"> & { lead?: WireItem; rows: WireItem[] })[] };
  return { ...m, columns: m.columns.map(({ lead, rows, ...c }) => ({ ...c, ...(lead && { lead: unpackItem(lead) }), rows: rows.map(unpackItem) })) };
}
